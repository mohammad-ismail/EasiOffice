from flask import Flask, request, jsonify, send_from_directory, abort, session, send_file
from functools import wraps
from io import BytesIO
from datetime import datetime
import re
import ipaddress
import os
import time
import threading
from . import crud
from . import security
from . import validation
from . import exporter
from . import importer
from .validation import ValidationError
from .exporter import ExportError
from .importer import ImportFileError
from .database import get_db, init_db
from .seed import seed_data

# Create DB tables
init_db()

# Create Flask app
frontend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'frontend'))
app = Flask(__name__, static_folder=frontend_dir)

# Server-side session signing key (persisted on the data volume so logins survive restarts)
app.secret_key = security.FLASK_SECRET_KEY
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    # Set SESSION_COOKIE_SECURE=true once served over HTTPS (Synology reverse proxy)
    SESSION_COOKIE_SECURE=os.environ.get('SESSION_COOKIE_SECURE', 'false').lower() == 'true',
)

# When running behind the Synology reverse proxy, honour X-Forwarded-* headers so
# request.remote_addr is the real client IP (so the LAN IP filter works) and the
# HTTPS scheme is detected (so Secure cookies are sent). Enable with TRUST_PROXY=true.
if os.environ.get('TRUST_PROXY', 'false').lower() == 'true':
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)

# Seed data
db = get_db()
seed_data(db)
db.close()


# --- Authentication / Authorization -------------------------------------------
def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get('user_id'):
            abort(401, description="Authentication required.")
        return f(*args, **kwargs)
    return wrapper


def admin_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get('user_id'):
            abort(401, description="Authentication required.")
        if session.get('role') != 'Admin':
            abort(403, description="Administrator privileges required.")
        return f(*args, **kwargs)
    return wrapper


def current_username():
    return session.get('username', 'anonymous')


def get_body():
    """Parse the JSON request body without raising on empty/invalid input."""
    return request.get_json(silent=True) or {}


# Return JSON (not HTML) for common errors so the SPA can handle them uniformly
@app.errorhandler(400)
@app.errorhandler(401)
@app.errorhandler(403)
@app.errorhandler(404)
@app.errorhandler(429)
def _json_error(e):
    code = getattr(e, 'code', 500)
    return jsonify({"status": "error", "message": getattr(e, 'description', str(e))}), code


# Invalid user input -> 400 with a clear message
@app.errorhandler(ValidationError)
def _validation_error(e):
    return jsonify({"status": "error", "message": e.message}), 400


# Bad export spec / unreadable upload -> 400 with a clear message
@app.errorhandler(ExportError)
def _export_error(e):
    return jsonify({"status": "error", "message": e.message}), 400


@app.errorhandler(ImportFileError)
def _import_error(e):
    return jsonify({"status": "error", "message": e.message}), 400


# --- Login brute-force throttle (in-memory, per client IP) --------------------
_LOGIN_FAILS = {}
_LOGIN_LOCK = threading.Lock()
_LOGIN_MAX_FAILS = 5
_LOGIN_WINDOW = 300  # seconds


def _login_allowed(ip):
    now = time.time()
    with _LOGIN_LOCK:
        recent = [t for t in _LOGIN_FAILS.get(ip, []) if now - t < _LOGIN_WINDOW]
        _LOGIN_FAILS[ip] = recent
        return len(recent) < _LOGIN_MAX_FAILS


def _record_login_fail(ip):
    with _LOGIN_LOCK:
        _LOGIN_FAILS.setdefault(ip, []).append(time.time())


def _clear_login_fails(ip):
    with _LOGIN_LOCK:
        _LOGIN_FAILS.pop(ip, None)


# Network Limit Safeguard Middleware (defence-in-depth; NOT the primary auth control)
@app.before_request
def restrict_ips():
    client_ip = request.remote_addr

    # Allow localhost
    if client_ip in ("127.0.0.1", "::1"):
        return

    try:
        ip = ipaddress.ip_address(client_ip)
        if not ip.is_private:
            abort(403, description="Access forbidden. Not on the local network.")
    except ValueError:
        abort(403, description="Invalid IP.")


# Serve Frontend static files
@app.route('/static/<path:path>')
def send_static(path):
    return send_from_directory(frontend_dir, path)

@app.route('/')
def serve_dashboard():
    return send_from_directory(frontend_dir, 'index.html')


# --- Auth endpoints -----------------------------------------------------------
@app.route('/api/login', methods=['POST'])
def handle_login():
    ip = request.remote_addr
    # Throttle brute-force attempts per client IP
    if not _login_allowed(ip):
        abort(429, description="Too many failed login attempts. Please wait a few minutes and try again.")

    data = request.get_json(silent=True) or {}
    username = data.get('username')
    password = data.get('password')

    db = get_db()
    cursor = db.cursor()
    cursor.execute('SELECT id, username, password, role, full_name FROM users WHERE username = ?', (username,))
    user = cursor.fetchone()

    if user and password is not None:
        is_valid, needs_rehash = security.verify_password(user['password'], password)
        if is_valid:
            _clear_login_fails(ip)
            # Transparently upgrade legacy reversible-AES passwords to one-way hashes
            if needs_rehash:
                cursor.execute('UPDATE users SET password = ? WHERE id = ?',
                               (security.hash_password(password), user['id']))
                db.commit()

            session.clear()
            session['user_id'] = user['id']
            session['username'] = user['username']
            session['role'] = user['role']
            session['full_name'] = user['full_name']

            crud.log_user_action(db, user['username'], "User Login",
                                 f"Authenticated successfully: {user['full_name']} ({user['role']})")
            db.close()
            return jsonify({
                "status": "success",
                "user": {
                    "id": user['id'],
                    "username": user['username'],
                    "role": user['role'],
                    "full_name": user['full_name']
                }
            })

    db.close()
    _record_login_fail(ip)
    return jsonify({"status": "error", "message": "Invalid username or password"}), 401


@app.route('/api/logout', methods=['POST'])
def handle_logout():
    session.clear()
    return jsonify({"status": "success"})


@app.route('/api/me', methods=['GET'])
def whoami():
    if not session.get('user_id'):
        abort(401, description="Not authenticated.")
    return jsonify({"user": {
        "id": session.get('user_id'),
        "username": session.get('username'),
        "role": session.get('role'),
        "full_name": session.get('full_name'),
    }})


# --- API Routes ---------------------------------------------------------------
@app.route('/api/activity-logs', methods=['GET'])
@login_required
def read_activity_logs():
    role = session.get('role')
    username = session.get('username')
    db = get_db()
    if role == 'Admin':
        logs = crud.get_activity_logs(db)
    else:
        logs = crud.get_activity_logs(db, username)
    db.close()
    return jsonify(logs)

@app.route('/api/activity-logs/clear', methods=['POST'])
@admin_required
def clear_activity_logs():
    """Admin-only: permanently delete audit-log entries within a date range
    (inclusive, YYYY-MM-DD). The deletion itself is logged afterwards so there
    is always a record that a clear happened."""
    data = get_body()
    validation.require(data, 'from_date', 'to_date')
    from_date = str(data['from_date']).strip()
    to_date = str(data['to_date']).strip()
    if not re.match(r'^\d{4}-\d{2}-\d{2}$', from_date) or not re.match(r'^\d{4}-\d{2}-\d{2}$', to_date):
        abort(400, description="Dates must be in YYYY-MM-DD format.")
    if from_date > to_date:
        abort(400, description="'From' date cannot be after 'To' date.")
    db = get_db()
    deleted = crud.clear_activity_logs(db, from_date, to_date)
    crud.log_user_action(db, current_username(), "Activity Log Cleared",
                         f"Cleared {deleted} log entr{'y' if deleted == 1 else 'ies'} "
                         f"from {from_date} to {to_date}")
    db.close()
    return jsonify({"status": "success", "deleted": deleted})

@app.route('/api/tasks', methods=['GET'])
@login_required
def read_tasks():
    db = get_db()
    tasks = crud.get_tasks_with_details(db)
    db.close()
    return jsonify(tasks)

@app.route('/api/tasks/bulk', methods=['POST'])
@admin_required
def bulk_create_tasks():
    data = get_body()
    validation.require(data, 'service_id', 'financial_year', 'period')
    validation.validate_financial_year(data.get('financial_year'))
    username = current_username()
    db = get_db()

    cursor = db.cursor()
    cursor.execute('SELECT name FROM service_master WHERE id = ?', (data['service_id'],))
    srv = cursor.fetchone()
    srv_name = srv['name'] if srv else f"ID {data['service_id']}"

    result = crud.create_bulk_tasks(db, data)
    details = f"Generated {result.get('created', 0)} tasks in bulk for service '{srv_name}' ({data['period']}, FY: {data['financial_year']})"
    crud.log_user_action(db, username, "Bulk Tasks Created", details)
    db.close()
    return jsonify(result)

@app.route('/api/tasks/<int:task_id>/status', methods=['PUT'])
@login_required
def update_status(task_id):
    status = request.args.get('status')
    username = current_username()
    db = get_db()

    cursor = db.cursor()
    cursor.execute('''
        SELECT t.period, c.name as client_name, s.name as service_name
        FROM task_board t
        LEFT JOIN client_master c ON t.client_id = c.id
        LEFT JOIN service_master s ON t.service_id = s.id
        WHERE t.id = ?
    ''', (task_id,))
    task = cursor.fetchone()

    updated = crud.update_task_status(db, task_id, status)
    if updated and task:
        details = f"Updated task for client '{task['client_name']}', service '{task['service_name']}' ({task['period']}) to status '{status}'"
        crud.log_user_action(db, username, "Task Status Updated", details)
    db.close()
    if not updated:
        abort(404, description="Task not found")
    return jsonify({"message": "updated"})

@app.route('/api/tasks/<int:task_id>/assign', methods=['PUT'])
@admin_required
def assign_task_to_user(task_id):
    data = get_body()
    user_id = data.get('user_id') or None   # '' / null / 0 -> unassign
    db = get_db()
    cursor = db.cursor()
    cursor.execute('''
        SELECT c.name as client_name, s.name as service_name, t.period
        FROM task_board t
        LEFT JOIN client_master c ON t.client_id = c.id
        LEFT JOIN service_master s ON t.service_id = s.id
        WHERE t.id = ?
    ''', (task_id,))
    task = cursor.fetchone()
    if not task:
        db.close()
        abort(404, description="Task not found")
    assignee = 'Unassigned'
    if user_id is not None:
        cursor.execute('SELECT full_name FROM users WHERE id = ?', (user_id,))
        u = cursor.fetchone()
        if not u:
            db.close()
            abort(400, description="Invalid staff user.")
        assignee = u['full_name']
    crud.assign_task(db, task_id, user_id)
    crud.log_user_action(db, current_username(), "Task Assigned",
                         f"Assigned task '{task['client_name']} - {task['service_name']}' ({task['period']}) to {assignee}")
    db.close()
    return jsonify({"status": "success"})

@app.route('/api/clients', methods=['GET'])
@login_required
def read_clients():
    db = get_db()
    clients = crud.get_clients(db)
    db.close()
    return jsonify(clients)

@app.route('/api/services', methods=['GET'])
@login_required
def read_services():
    db = get_db()
    services = crud.get_services(db)
    db.close()
    return jsonify(services)


# --- Exports (Excel / PDF) ----------------------------------------------------
def _safe_filename(name, ext):
    slug = re.sub(r'[^A-Za-z0-9._-]+', '_', str(name or 'report')).strip('_') or 'report'
    stamp = datetime.now().strftime('%Y%m%d_%H%M')
    return f"{slug[:60]}_{stamp}.{ext}"


@app.route('/api/export', methods=['POST'])
@login_required
def export_report():
    """Render a client-supplied spec (sheets/columns/rows) to .xlsx or PDF.

    The caller already holds the data and decides which fields/rows to include;
    this endpoint only renders. Vault passwords are never part of a spec.
    """
    fmt = (request.args.get('format') or 'xlsx').lower()
    spec = get_body()
    content, mimetype, ext = exporter.render(spec, fmt)
    crud_db = get_db()
    title = spec.get('title') if isinstance(spec, dict) else 'Report'
    sheet_count = len(spec.get('sheets', [])) if isinstance(spec, dict) else 0
    crud.log_user_action(crud_db, current_username(), "Data Exported",
                         f"Exported '{title}' as {ext.upper()} ({sheet_count} section(s))")
    crud_db.close()
    return send_file(BytesIO(content), mimetype=mimetype, as_attachment=True,
                     download_name=_safe_filename(title, ext))


# --- Bulk import (CSV / Excel) for clients, services, users, tasks ------------
# Each validator returns (rows_ready_for_crud, errors[]). Validators get the db
# so they can resolve names to ids and check uniqueness.
def _validate_clients(db, parsed):
    valid, errors = [], []
    for rec in parsed:
        rn = rec.get('_row', '?')
        name = (rec.get('name') or '').strip()
        if not name:
            errors.append({"row": rn, "message": "Missing required field: Name"}); continue
        pan = (rec.get('pan') or '').strip().upper()
        gstin = (rec.get('gstin') or '').strip().upper()
        try:
            validation.validate_pan(pan)
            validation.validate_gstin(gstin)
        except ValidationError as ve:
            errors.append({"row": rn, "message": ve.message}); continue
        valid.append({
            "name": name, "entity_type": (rec.get('entity_type') or '').strip(),
            "pan": pan, "gstin": gstin, "group": (rec.get('group') or '').strip(),
            "physical_folder_location": (rec.get('physical_folder_location') or '').strip(),
            "data_location": (rec.get('data_location') or '').strip(),
        })
    return valid, errors


def _validate_services(db, parsed):
    valid, errors = [], []
    for rec in parsed:
        rn = rec.get('_row', '?')
        name = (rec.get('name') or '').strip()
        if not name:
            errors.append({"row": rn, "message": "Missing required field: Name"}); continue
        due_day = 15
        ddd = (rec.get('default_due_day') or '').strip()
        if ddd:
            try:
                due_day = validation.validate_int_range(ddd, 1, 31, 'Default Due Day')
            except ValidationError as ve:
                errors.append({"row": rn, "message": ve.message}); continue
        valid.append({
            "name": name, "description": (rec.get('description') or '').strip(),
            "checklist": (rec.get('checklist') or '').strip(), "default_due_day": due_day,
        })
    return valid, errors


def _validate_users(db, parsed):
    valid, errors = [], []
    cursor = db.cursor()
    cursor.execute('SELECT lower(username) AS u FROM users')
    existing = {r['u'] for r in cursor.fetchall()}
    seen = set()
    for rec in parsed:
        rn = rec.get('_row', '?')
        full_name = (rec.get('full_name') or '').strip()
        uname = (rec.get('username') or '').strip()
        pwd = (rec.get('password') or '').strip()
        miss = [lbl for lbl, v in (('Full Name', full_name), ('Username', uname), ('Password', pwd)) if not v]
        if miss:
            errors.append({"row": rn, "message": "Missing required field(s): " + ", ".join(miss)}); continue
        key = uname.lower()
        if key in existing or key in seen:
            errors.append({"row": rn, "message": f"Username '{uname}' already exists."}); continue
        seen.add(key)
        valid.append({"full_name": full_name, "username": uname, "password": pwd})
    return valid, errors


def _validate_tasks(db, parsed):
    valid, errors = [], []
    cursor = db.cursor()
    cursor.execute('SELECT id, lower(name) AS n FROM client_master')
    clients = {r['n']: r['id'] for r in cursor.fetchall()}
    cursor.execute('SELECT id, lower(name) AS n FROM service_master')
    services = {r['n']: r['id'] for r in cursor.fetchall()}
    cursor.execute('SELECT id, lower(full_name) AS n FROM users')
    staff = {r['n']: r['id'] for r in cursor.fetchall()}
    for rec in parsed:
        rn = rec.get('_row', '?')
        cname = (rec.get('client') or '').strip()
        sname = (rec.get('service') or '').strip()
        fy = (rec.get('financial_year') or '').strip()
        period = (rec.get('period') or '').strip()
        miss = [lbl for lbl, v in (('Client', cname), ('Service', sname),
                                   ('Financial Year', fy), ('Period', period)) if not v]
        if miss:
            errors.append({"row": rn, "message": "Missing required field(s): " + ", ".join(miss)}); continue
        cid = clients.get(cname.lower())
        if not cid:
            errors.append({"row": rn, "message": f"Client '{cname}' not found."}); continue
        sid = services.get(sname.lower())
        if not sid:
            errors.append({"row": rn, "message": f"Service '{sname}' not found."}); continue
        try:
            validation.validate_financial_year(fy)
        except ValidationError as ve:
            errors.append({"row": rn, "message": ve.message}); continue
        status = (rec.get('status') or 'Working').strip().title() or 'Working'
        if status not in ('Working', 'Pending', 'Completed'):
            errors.append({"row": rn, "message": f"Invalid status '{status}'. Use Working, Pending or Completed."}); continue
        assignee_id = None
        an = (rec.get('assigned_to') or '').strip()
        if an:
            assignee_id = staff.get(an.lower())
            if not assignee_id:
                errors.append({"row": rn, "message": f"Staff '{an}' not found."}); continue
        valid.append({
            "client_id": cid, "service_id": sid, "financial_year": fy, "period": period,
            "status": status, "assigned_to": assignee_id,
            "due_date": (rec.get('due_date') or '').strip() or None,
        })
    return valid, errors


_IMPORT_HANDLERS = {
    "clients":  (_validate_clients,  crud.import_clients,  "Clients Imported"),
    "services": (_validate_services, crud.import_services, "Services Imported"),
    "users":    (_validate_users,    crud.import_users,    "Users Imported"),
    "tasks":    (_validate_tasks,    crud.import_tasks,    "Tasks Imported"),
}


@app.route('/api/import/<entity>/template', methods=['GET'])
@admin_required
def import_template(entity):
    """Download a ready-to-fill upload template (CSV or Excel) for an entity."""
    if entity not in importer.ENTITY_CONFIGS:
        abort(404, description="Unknown import type.")
    cfg = importer.ENTITY_CONFIGS[entity]
    cols = cfg['template_columns']
    fmt = (request.args.get('format') or 'csv').lower()

    if fmt in ('xlsx', 'excel'):
        spec = {
            "title": f"{cfg['label']} Import Template",
            "sheets": [{
                "name": cfg['label'],
                "columns": [{"key": k, "label": f"{lbl}{' *' if req else ''}"} for k, lbl, req in cols],
                "rows": [cfg['sample']],
            }],
        }
        content, mimetype, _ext = exporter.render(spec, 'xlsx')
        return send_file(BytesIO(content), mimetype=mimetype, as_attachment=True,
                         download_name=f"{entity}_import_template.xlsx")

    import csv as _csv
    from io import StringIO
    sio = StringIO()
    writer = _csv.writer(sio)
    writer.writerow([f"{lbl}{' *' if req else ''}" for _k, lbl, req in cols])
    writer.writerow([cfg['sample'].get(k, '') for k, _l, _r in cols])
    return send_file(BytesIO(sio.getvalue().encode('utf-8-sig')), mimetype='text/csv',
                     as_attachment=True, download_name=f"{entity}_import_template.csv")


@app.route('/api/import/<entity>', methods=['POST'])
@admin_required
def import_entity(entity):
    """Validate and import an uploaded file. Returns a per-row error report.
    Valid rows are imported even if other rows fail."""
    if entity not in _IMPORT_HANDLERS:
        abort(404, description="Unknown import type.")
    if 'file' not in request.files:
        abort(400, description="No file uploaded.")
    upload = request.files['file']
    if not upload or not upload.filename:
        abort(400, description="No file selected.")
    data = upload.read()
    if not data:
        abort(400, description="The uploaded file is empty.")

    parsed = importer.parse_upload(upload.filename, data, entity)
    validate_fn, insert_fn, log_action = _IMPORT_HANDLERS[entity]
    db = get_db()
    try:
        valid, errors = validate_fn(db, parsed)
        created = insert_fn(db, valid) if valid else 0
        crud.log_user_action(db, current_username(), log_action,
                             f"Bulk {entity} import: {created} created, {len(errors)} skipped "
                             f"(from '{upload.filename}')")
    finally:
        db.close()
    return jsonify({
        "status": "success", "created": created, "skipped": len(errors),
        "total": len(parsed), "errors": errors[:200],
    })

@app.route('/api/credentials', methods=['POST'])
@login_required
def save_credential():
    data = get_body()
    validation.require(data, 'client_id', 'portal_name', 'password')
    username = current_username()
    db = get_db()
    cred = crud.save_credential(db, data)

    cursor = db.cursor()
    cursor.execute('SELECT name FROM client_master WHERE id = ?', (data['client_id'],))
    cl = cursor.fetchone()
    cl_name = cl['name'] if cl else f"ID {data['client_id']}"

    details = f"Stored secure portal credential: '{data['portal_name']}' for client '{cl_name}'"
    crud.log_user_action(db, username, "Credential Stored", details)
    db.close()
    return jsonify(cred)

@app.route('/api/clients/<int:client_id>/credentials', methods=['GET'])
@login_required
def get_credentials(client_id):
    db = get_db()
    creds = crud.get_client_credentials(db, client_id)
    db.close()
    return jsonify(creds)

@app.route('/api/credentials/<int:cred_id>/decrypt', methods=['GET'])
@login_required
def decrypt_credential(cred_id):
    username = current_username()
    db = get_db()
    pwd = crud.get_decrypted_credential(db, cred_id)
    if pwd:
        cursor = db.cursor()
        cursor.execute('''
            SELECT cb.portal_name, c.name as client_name
            FROM credential_box cb
            LEFT JOIN client_master c ON cb.client_id = c.id
            WHERE cb.id = ?
        ''', (cred_id,))
        cred = cursor.fetchone()
        cred_desc = f"for portal '{cred['portal_name']}' (Client: {cred['client_name']})" if cred else f"ID {cred_id}"

        details = f"Revealed portal credential password {cred_desc}"
        crud.log_user_action(db, username, "Vault Password Revealed", details)
    db.close()
    if not pwd:
        abort(404, description="Credential not found")
    return jsonify({"password": pwd})

@app.route('/api/tasks', methods=['POST'])
@admin_required
def create_single_task():
    data = get_body()
    # `period` is only user-supplied for one-time tasks. For recurring plans
    # (monthly/quarterly/six_monthly/annual) the period is generated per-instance
    # by crud.create_task, so the modal hides that field and it arrives empty.
    if data.get('recurrence_type', 'one_time') == 'one_time':
        validation.require(data, 'client_id', 'service_id', 'financial_year', 'period')
    else:
        validation.require(data, 'client_id', 'service_id', 'financial_year')
    validation.validate_financial_year(data.get('financial_year'))
    username = current_username()
    db = get_db()
    result = crud.create_task(db, data)

    cursor = db.cursor()
    cursor.execute('SELECT name FROM client_master WHERE id = ?', (data['client_id'],))
    cl = cursor.fetchone()
    cl_name = cl['name'] if cl else f"ID {data['client_id']}"
    cursor.execute('SELECT name FROM service_master WHERE id = ?', (data['service_id'],))
    srv = cursor.fetchone()
    srv_name = srv['name'] if srv else f"ID {data['service_id']}"

    details = f"Created task for client '{cl_name}', service '{srv_name}' (Recurrence: {data.get('recurrence_type', 'one_time')})"
    crud.log_user_action(db, username, "Task Created", details)
    db.close()
    return jsonify(result)

@app.route('/api/client-groups', methods=['GET'])
@login_required
def read_client_groups():
    db = get_db()
    groups = crud.get_client_groups(db)
    db.close()
    return jsonify(groups)

@app.route('/api/clients', methods=['POST'])
@admin_required
def create_single_client():
    data = get_body()
    validation.require(data, 'name', 'entity_type', 'pan', 'physical_folder_location')
    validation.validate_pan(data.get('pan'))
    validation.validate_gstin(data.get('gstin'))
    username = current_username()
    db = get_db()
    result = crud.create_client(db, data)
    details = f"Registered client master profile: '{data['name']}' (Entity: {data['entity_type']}, PAN: {data['pan']})"
    crud.log_user_action(db, username, "Client Created", details)
    db.close()
    return jsonify(result)

@app.route('/api/clients/<int:client_id>/assign', methods=['PUT'])
@admin_required
def assign_client_to_user(client_id):
    data = get_body()
    user_id = data.get('user_id') or None   # '' / null / 0 -> unassign
    db = get_db()
    cursor = db.cursor()
    cursor.execute('SELECT name FROM client_master WHERE id = ?', (client_id,))
    cl = cursor.fetchone()
    if not cl:
        db.close()
        abort(404, description="Client not found")
    assignee = 'Unassigned'
    if user_id is not None:
        cursor.execute('SELECT full_name FROM users WHERE id = ?', (user_id,))
        u = cursor.fetchone()
        if not u:
            db.close()
            abort(400, description="Invalid staff user.")
        assignee = u['full_name']
    crud.assign_client(db, client_id, user_id)
    crud.log_user_action(db, current_username(), "Client Assigned",
                         f"Assigned client '{cl['name']}' to {assignee}")
    db.close()
    return jsonify({"status": "success"})

@app.route('/api/users', methods=['GET'])
@login_required
def read_users():
    db = get_db()
    users = crud.get_users(db)
    db.close()
    return jsonify(users)

@app.route('/api/users', methods=['POST'])
@admin_required
def create_single_user():
    data = get_body()
    validation.require(data, 'username', 'password', 'full_name')
    # Staff created here are always Employees. New Admins cannot be created via
    # this endpoint (server-enforced, so it can't be bypassed from the client).
    data['role'] = 'Employee'
    username = current_username()
    db = get_db()
    result = crud.create_user(db, data)
    details = f"Added staff account: '{data['username']}' (Employee)"
    crud.log_user_action(db, username, "User Added", details)
    db.close()
    return jsonify(result)

@app.route('/api/users/<int:user_id>', methods=['DELETE'])
@admin_required
def delete_single_user(user_id):
    username = current_username()
    db = get_db()
    cursor = db.cursor()
    cursor.execute('SELECT username, full_name FROM users WHERE id = ?', (user_id,))
    usr = cursor.fetchone()
    usr_desc = f"'{usr['username']}' ({usr['full_name']})" if usr else f"ID {user_id}"

    deleted = crud.delete_user(db, user_id)
    if deleted:
        details = f"Deleted staff account {usr_desc}"
        crud.log_user_action(db, username, "User Deleted", details)
    db.close()
    if not deleted:
        abort(404, description="User not found")
    return jsonify({"message": "deleted"})

@app.route('/api/timesheets', methods=['GET'])
@login_required
def read_timesheets():
    db = get_db()
    timesheets = crud.get_timesheets(db)
    db.close()
    return jsonify(timesheets)

@app.route('/api/timesheets', methods=['POST'])
@login_required
def create_single_timesheet():
    data = get_body()
    validation.require(data, 'task_id', 'log_date')
    validation.validate_int_range(data.get('hours', 0), 0, 23, 'Hours')
    validation.validate_int_range(data.get('minutes', 0), 0, 59, 'Minutes')
    username = current_username()
    db = get_db()
    result = crud.create_timesheet(db, data)

    cursor = db.cursor()
    cursor.execute('''
        SELECT tb.period, c.name as client_name, s.name as service_name
        FROM task_board tb
        LEFT JOIN client_master c ON tb.client_id = c.id
        LEFT JOIN service_master s ON tb.service_id = s.id
        WHERE tb.id = ?
    ''', (data['task_id'],))
    task = cursor.fetchone()
    task_desc = f"for '{task['client_name']} - {task['service_name']}'" if task else ""

    details = f"Logged timesheet hours: {data['hours']}h {data['minutes']}m {task_desc}"
    crud.log_user_action(db, username, "Timesheet Entry Logged", details)
    db.close()
    return jsonify(result)

@app.route('/api/credentials/<int:cred_id>', methods=['PUT'])
@login_required
def update_portal_credential(cred_id):
    data = get_body()
    validation.require(data, 'password')
    username = current_username()
    db = get_db()

    cursor = db.cursor()
    cursor.execute('''
        SELECT cb.portal_name, c.name as client_name
        FROM credential_box cb
        LEFT JOIN client_master c ON cb.client_id = c.id
        WHERE cb.id = ?
    ''', (cred_id,))
    cred = cursor.fetchone()
    cred_desc = f"for portal '{cred['portal_name']}' (Client: {cred['client_name']})" if cred else f"ID {cred_id}"

    updated = crud.update_credential(db, cred_id, data)
    if updated:
        details = f"Updated secure portal credential password {cred_desc}"
        crud.log_user_action(db, username, "Credential Password Updated", details)
    db.close()
    if not updated:
        abort(404, description="Credential not found")
    return jsonify({"status": "success"})

@app.route('/api/credentials/<int:cred_id>', methods=['DELETE'])
@admin_required
def delete_portal_credential(cred_id):
    username = current_username()
    db = get_db()

    cursor = db.cursor()
    cursor.execute('''
        SELECT cb.portal_name, c.name as client_name
        FROM credential_box cb
        LEFT JOIN client_master c ON cb.client_id = c.id
        WHERE cb.id = ?
    ''', (cred_id,))
    cred = cursor.fetchone()
    cred_desc = f"for portal '{cred['portal_name']}' (Client: {cred['client_name']})" if cred else f"ID {cred_id}"

    deleted = crud.delete_credential(db, cred_id)
    if deleted:
        details = f"Deleted secure portal credential {cred_desc}"
        crud.log_user_action(db, username, "Credential Deleted", details)
    db.close()
    if not deleted:
        abort(404, description="Credential not found")
    return jsonify({"status": "success"})

@app.route('/api/clients/<int:client_id>/contacts', methods=['GET'])
@login_required
def read_client_contacts(client_id):
    db = get_db()
    contacts = crud.get_client_contacts(db, client_id)
    db.close()
    return jsonify(contacts)

@app.route('/api/contacts', methods=['POST'])
@login_required
def create_portal_contact():
    data = get_body()
    validation.require(data, 'client_id', 'name', 'designation')
    validation.validate_mobile(data.get('mobile'))
    validation.validate_email(data.get('email'))
    username = current_username()
    db = get_db()
    result = crud.create_client_contact(db, data)

    cursor = db.cursor()
    cursor.execute('SELECT name FROM client_master WHERE id = ?', (data['client_id'],))
    cl = cursor.fetchone()
    cl_name = cl['name'] if cl else f"ID {data['client_id']}"

    details = f"Added contact: '{data['name']}' ({data['designation']}) for client '{cl_name}'"
    crud.log_user_action(db, username, "Contact Added", details)
    db.close()
    return jsonify(result)

@app.route('/api/services', methods=['POST'])
@admin_required
def create_firm_service():
    data = get_body()
    validation.require(data, 'name', 'description')
    username = current_username()
    db = get_db()
    result = crud.create_service(db, data)
    details = f"Created catalog service template: '{data['name']}'"
    crud.log_user_action(db, username, "Service Created", details)
    db.close()
    return jsonify(result)

@app.route('/api/tasks/<int:task_id>', methods=['PUT'])
@admin_required
def update_task_details(task_id):
    data = get_body()
    validation.require(data, 'client_id', 'service_id', 'financial_year', 'period')
    validation.validate_financial_year(data.get('financial_year'))
    username = current_username()
    db = get_db()
    updated = crud.update_task(db, task_id, data)
    if updated:
        cursor = db.cursor()
        cursor.execute('SELECT name FROM client_master WHERE id = ?', (data['client_id'],))
        cl = cursor.fetchone()
        cl_name = cl['name'] if cl else f"ID {data['client_id']}"
        cursor.execute('SELECT name FROM service_master WHERE id = ?', (data['service_id'],))
        srv = cursor.fetchone()
        srv_name = srv['name'] if srv else f"ID {data['service_id']}"

        details = f"Modified task details (ID: {task_id}) for client '{cl_name}', service '{srv_name}' ({data['period']})"
        crud.log_user_action(db, username, "Task Details Updated", details)
    db.close()
    if not updated:
        abort(404, description="Task not found")
    return jsonify({"status": "success"})

@app.route('/api/clients/<int:client_id>', methods=['PUT'])
@admin_required
def update_client_details(client_id):
    data = get_body()
    validation.require(data, 'name', 'pan', 'physical_folder_location')
    validation.validate_pan(data.get('pan'))
    validation.validate_gstin(data.get('gstin'))
    username = current_username()
    db = get_db()
    updated = crud.update_client(db, client_id, data)
    if updated:
        details = f"Updated client master profile (ID: {client_id}): '{data['name']}'"
        crud.log_user_action(db, username, "Client Details Updated", details)
    db.close()
    if not updated:
        abort(404, description="Client not found")
    return jsonify({"status": "success"})

@app.route('/api/services/<int:service_id>', methods=['PUT'])
@admin_required
def update_service_details(service_id):
    data = get_body()
    validation.require(data, 'name', 'description')
    username = current_username()
    db = get_db()
    updated = crud.update_service(db, service_id, data)
    if updated:
        details = f"Updated catalog service template (ID: {service_id}): '{data['name']}'"
        crud.log_user_action(db, username, "Service Updated", details)
    db.close()
    if not updated:
        abort(404, description="Service not found")
    return jsonify({"status": "success"})

@app.route('/api/users/<int:user_id>', methods=['PUT'])
@admin_required
def update_user_details(user_id):
    data = get_body()
    validation.require(data, 'username', 'full_name')
    username = current_username()
    db = get_db()
    # Role is immutable through this endpoint: keep whatever the user already has.
    # This prevents promoting an Employee to Admin (and accidentally demoting the
    # primary admin) regardless of what the client sends.
    cursor = db.cursor()
    cursor.execute('SELECT role FROM users WHERE id = ?', (user_id,))
    existing = cursor.fetchone()
    if not existing:
        db.close()
        abort(404, description="User not found")
    data['role'] = existing['role']
    updated = crud.update_user(db, user_id, data)
    if updated:
        details = f"Updated staff account (ID: {user_id}): '{data['username']}'"
        crud.log_user_action(db, username, "User Details Updated", details)
    db.close()
    if not updated:
        abort(404, description="User not found")
    return jsonify({"status": "success"})


if __name__ == "__main__":
    import logging
    logging.getLogger('werkzeug').setLevel(logging.ERROR)

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))

    # Prefer the production-grade waitress WSGI server (pure-Python, light on RAM —
    # well suited to the NAS). Fall back to Flask's dev server if it isn't installed.
    try:
        from waitress import serve
        print(f"[server] waitress serving on {host}:{port}")
        serve(app, host=host, port=port, threads=int(os.environ.get("THREADS", "8")))
    except ImportError:
        print("[server] waitress not found; using Flask dev server (development only)")
        app.run(host=host, port=port)
