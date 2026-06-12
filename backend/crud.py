from . import security
import json
import re
import time
from datetime import datetime

# --- Custom IDs (#CL:N / #SER:N) ---------------------------------------------
CLIENT_ID_PREFIX = 'CL'
SERVICE_ID_PREFIX = 'SER'
_CUSTOM_ID_RE = {
    'CL': re.compile(r'^#CL:(\d+)$'),
    'SER': re.compile(r'^#SER:(\d+)$'),
}

def normalize_custom_id(value, prefix):
    """Return canonical '#PREFIX:N' (digits only) or raise ValueError if malformed."""
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    # Accept loose forms: '12', 'CL:12', '#cl:12', etc.
    m = re.match(rf'^#?\s*{prefix}\s*[:#-]?\s*(\d+)$', s, re.IGNORECASE)
    if not m:
        m2 = re.match(r'^\d+$', s)
        if not m2:
            raise ValueError(f"Invalid ID '{value}'. Expected '#{prefix}:N' (N is a number).")
        return f"#{prefix}:{int(s)}"
    return f"#{prefix}:{int(m.group(1))}"

def _peak_num(custom_id, prefix):
    if not custom_id:
        return 0
    m = _CUSTOM_ID_RE[prefix].match(str(custom_id).strip())
    return int(m.group(1)) if m else 0

def next_custom_id(db, table, prefix):
    """Next-after-max '#PREFIX:N' for the given table (client_master / service_master)."""
    cur = db.cursor()
    cur.execute(f"SELECT custom_id FROM {table} WHERE custom_id IS NOT NULL AND custom_id != ''")
    biggest = 0
    for r in cur.fetchall():
        n = _peak_num(r['custom_id'], prefix)
        if n > biggest:
            biggest = n
    return f"#{prefix}:{biggest + 1}"

def custom_id_clash(db, table, custom_id, exclude_id=None):
    """True iff another row in `table` already uses this custom_id (case-insensitive)."""
    if not custom_id:
        return False
    cur = db.cursor()
    if exclude_id is None:
        cur.execute(f"SELECT 1 FROM {table} WHERE UPPER(custom_id) = UPPER(?)", (custom_id,))
    else:
        cur.execute(f"SELECT 1 FROM {table} WHERE UPPER(custom_id) = UPPER(?) AND id != ?",
                    (custom_id, exclude_id))
    return cur.fetchone() is not None

def log_user_action(db, username: str, action: str, details: str):
    try:
        cursor = db.cursor()
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        cursor.execute('''
            INSERT INTO activity_log (username, action, details, timestamp)
            VALUES (?, ?, ?, ?)
        ''', (username, action, details, timestamp))
        db.commit()
    except Exception as e:
        print(f"Error logging user action: {e}")

def get_activity_logs(db, username: str = None):
    cursor = db.cursor()
    if username:
        cursor.execute('SELECT id, username, action, details, timestamp FROM activity_log WHERE username = ? ORDER BY timestamp DESC', (username,))
    else:
        cursor.execute('SELECT id, username, action, details, timestamp FROM activity_log ORDER BY timestamp DESC')
    return [dict(row) for row in cursor.fetchall()]

def get_tasks_with_details(db):
    cursor = db.cursor()
    cursor.execute('''
        SELECT t.id, t.task_no, c.name as client_name, s.name as service_name, t.financial_year, t.period,
               t.status, t.assigned_to, u.full_name as assigned_to_name, t.client_id, t.due_date,
               t.delegated_to, d.full_name as delegated_to_name,
               t.billing_stage, t.billed_amount, t.gst_amount, t.total_amount,
               t.billed_date, t.received_date, t.estimated_minutes,
               t.created_by, t.locked
        FROM task_board t
        LEFT JOIN client_master c ON t.client_id = c.id
        LEFT JOIN service_master s ON t.service_id = s.id
        LEFT JOIN users u ON t.assigned_to = u.id
        LEFT JOIN users d ON t.delegated_to = d.id
    ''')
    return [dict(row) for row in cursor.fetchall()]


# --- Task lock ----------------------------------------------------------------
def set_task_locked(db, task_id: int, locked: bool):
    cursor = db.cursor()
    cursor.execute('UPDATE task_board SET locked = ? WHERE id = ?', (1 if locked else 0, task_id))
    db.commit()
    return cursor.rowcount > 0


# --- Notifications ------------------------------------------------------------
def add_notification(db, user_id: int, ntype: str, message: str, task_id=None):
    """Insert a single notification row for one recipient."""
    if not user_id:
        return None
    cur = db.cursor()
    cur.execute('''INSERT INTO notifications (user_id, type, message, task_id, created_at, read_at)
                   VALUES (?, ?, ?, ?, ?, NULL)''',
                (user_id, ntype, message, task_id, _now_str()))
    db.commit()
    return cur.lastrowid

def notify_managers(db, ntype: str, message: str, task_id=None, exclude_user_id=None):
    """Notify every Admin / Partner / Manager (except optionally `exclude_user_id`).
    Used when an Employee creates a task — the supervisors get pinged."""
    cur = db.cursor()
    cur.execute("SELECT id FROM users WHERE role IN ('Admin','Partner','Manager')")
    for r in cur.fetchall():
        if exclude_user_id and r['id'] == exclude_user_id:
            continue
        add_notification(db, r['id'], ntype, message, task_id)

def list_notifications(db, user_id: int, limit: int = 100):
    cur = db.cursor()
    cur.execute('''SELECT n.id, n.type, n.message, n.task_id, n.created_at, n.read_at
                   FROM notifications n
                   WHERE n.user_id = ?
                   ORDER BY n.id DESC LIMIT ?''', (user_id, limit))
    return [dict(r) for r in cur.fetchall()]

def mark_notification_read(db, notification_id: int, user_id: int):
    cur = db.cursor()
    cur.execute('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?',
                (_now_str(), notification_id, user_id))
    db.commit()
    return cur.rowcount > 0

def mark_all_notifications_read(db, user_id: int):
    cur = db.cursor()
    cur.execute('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL',
                (_now_str(), user_id))
    db.commit()
    return cur.rowcount


# --- Calendar events (per user) ---------------------------------------------
def list_calendar_events(db, user_id: int, from_date: str = None, to_date: str = None):
    cur = db.cursor()
    if from_date and to_date:
        cur.execute('''SELECT id, event_date, start_time, end_time, title, notes, color, created_at
                       FROM calendar_events
                       WHERE user_id = ? AND event_date BETWEEN ? AND ?
                       ORDER BY event_date, IFNULL(start_time, '99:99'), id''',
                    (user_id, from_date, to_date))
    else:
        cur.execute('''SELECT id, event_date, start_time, end_time, title, notes, color, created_at
                       FROM calendar_events
                       WHERE user_id = ?
                       ORDER BY event_date DESC, IFNULL(start_time, '99:99'), id''', (user_id,))
    return [dict(r) for r in cur.fetchall()]

def create_calendar_event(db, user_id: int, data: dict):
    cur = db.cursor()
    cur.execute('''INSERT INTO calendar_events (user_id, event_date, start_time, end_time, title, notes, color, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
                (user_id, data['event_date'], data.get('start_time') or None,
                 data.get('end_time') or None, data.get('title') or '',
                 data.get('notes') or '', data.get('color') or '#3B82F6', _now_str()))
    db.commit()
    return {"id": cur.lastrowid}

def update_calendar_event(db, event_id: int, user_id: int, data: dict):
    cur = db.cursor()
    cur.execute('SELECT id FROM calendar_events WHERE id = ? AND user_id = ?', (event_id, user_id))
    if not cur.fetchone():
        return False
    cur.execute('''UPDATE calendar_events
                   SET event_date = ?, start_time = ?, end_time = ?, title = ?, notes = ?, color = ?
                   WHERE id = ? AND user_id = ?''',
                (data['event_date'], data.get('start_time') or None, data.get('end_time') or None,
                 data.get('title') or '', data.get('notes') or '',
                 data.get('color') or '#3B82F6', event_id, user_id))
    db.commit()
    return cur.rowcount > 0

def delete_calendar_event(db, event_id: int, user_id: int):
    cur = db.cursor()
    cur.execute('DELETE FROM calendar_events WHERE id = ? AND user_id = ?', (event_id, user_id))
    db.commit()
    return cur.rowcount > 0

def next_task_no(db, financial_year):
    """Next per-financial-year task number (resets to 1 for a new FY)."""
    cursor = db.cursor()
    cursor.execute("SELECT MAX(task_no) AS m FROM task_board WHERE financial_year = ?", (financial_year,))
    row = cursor.fetchone()
    return (row['m'] or 0) + 1

def update_task_status(db, task_id: int, status: str):
    cursor = db.cursor()
    cursor.execute('UPDATE task_board SET status = ? WHERE id = ?', (status, task_id))
    db.commit()
    return cursor.rowcount > 0

def assign_task(db, task_id: int, user_id):
    """Assign (or, with user_id=None, unassign) a task to a staff user."""
    cursor = db.cursor()
    cursor.execute('UPDATE task_board SET assigned_to = ? WHERE id = ?', (user_id, task_id))
    db.commit()
    return cursor.rowcount > 0

def get_clients(db):
    cursor = db.cursor()
    cursor.execute('''
        SELECT c.id, c.custom_id, c.name, c.entity_type, c.pan, c.gstin, c.physical_folder_location, c.data_location,
               c.group_id, g.name as group_name,
               c.assigned_to, u.full_name as assigned_to_name
        FROM client_master c
        LEFT JOIN client_groups g ON c.group_id = g.id
        LEFT JOIN users u ON c.assigned_to = u.id
    ''')
    return [dict(row) for row in cursor.fetchall()]

def assign_client(db, client_id: int, user_id):
    """Assign (or, with user_id=None, unassign) a client to a staff user."""
    cursor = db.cursor()
    cursor.execute('UPDATE client_master SET assigned_to = ? WHERE id = ?', (user_id, client_id))
    db.commit()
    return cursor.rowcount > 0

def get_services(db):
    cursor = db.cursor()
    cursor.execute('SELECT id, custom_id, name, description, checklist_json, default_due_day FROM service_master')
    return [dict(row) for row in cursor.fetchall()]

# Financial-year month sequence (April start): (month_name, month_number)
_FY_MONTHS = [("April", 4), ("May", 5), ("June", 6), ("July", 7), ("August", 8),
              ("September", 9), ("October", 10), ("November", 11), ("December", 12),
              ("January", 1), ("February", 2), ("March", 3)]

def _recurrence_occurrences(frequency, financial_year):
    """Occurrences a recurring template generates: list of (period_label, year, month)."""
    try:
        start_year = int(financial_year.split('-')[0])
    except Exception:
        start_year = 2025
    yr = lambda mo: start_year if mo >= 4 else start_year + 1   # noqa: E731
    if frequency == 'monthly':
        return [(name, yr(mo), mo) for (name, mo) in _FY_MONTHS]
    if frequency == 'quarterly':
        return [("Q1 (Apr-Jun)", yr(4), 4), ("Q2 (Jul-Sep)", yr(7), 7),
                ("Q3 (Oct-Dec)", yr(10), 10), ("Q4 (Jan-Mar)", yr(1), 1)]
    if frequency == 'six_monthly':
        return [("H1 (Apr-Sep)", yr(4), 4), ("H2 (Oct-Mar)", yr(10), 10)]
    if frequency == 'annual':
        return [("Annual", yr(4), 4)]
    return []

def _generate_for_template(db, tpl):
    """Create any due-but-missing instances for one template (catch-up). Returns count."""
    from datetime import date as _date
    cursor = db.cursor()
    today = datetime.now().date()
    gen_day = tpl.get('gen_day') or 3
    due_day = tpl.get('due_day') or 10
    seq = None
    created = 0
    for (period, yr_, mo) in _recurrence_occurrences(tpl.get('frequency'), tpl.get('financial_year')):
        # Only generate once the gen day of that month has arrived.
        if today < _date(yr_, mo, min(gen_day, 28)):
            continue
        cursor.execute('SELECT 1 FROM task_board WHERE client_id=? AND service_id=? AND financial_year=? AND period=?',
                       (tpl['client_id'], tpl['service_id'], tpl['financial_year'], period))
        if cursor.fetchone():
            continue
        if seq is None:
            seq = next_task_no(db, tpl['financial_year'])
        due = _date(yr_, mo, min(due_day, 28)).isoformat()
        cursor.execute('''INSERT INTO task_board (client_id, service_id, financial_year, period, status, assigned_to, due_date, task_no, estimated_minutes)
                          VALUES (?, ?, ?, ?, 'Pending', ?, ?, ?, ?)''',
                       (tpl['client_id'], tpl['service_id'], tpl['financial_year'], period,
                        tpl.get('assigned_to'), due, seq, tpl.get('estimated_minutes')))
        seq += 1
        created += 1
    db.commit()
    return created

def generate_due_recurring(db):
    """Catch-up generator: create all due instances for every active template."""
    cursor = db.cursor()
    cursor.execute("SELECT * FROM recurring_templates WHERE active = 1")
    total = 0
    for r in cursor.fetchall():
        total += _generate_for_template(db, dict(r))
    return total

def create_recurring_template(db, data):
    """Create a recurring template and immediately generate its already-due instances."""
    cursor = db.cursor()
    cursor.execute('''INSERT INTO recurring_templates
        (client_id, service_id, financial_year, frequency, assigned_to, estimated_minutes, due_day, gen_day, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 10, 3, 1, ?)''',
        (data['client_id'], data['service_id'], data['financial_year'], data.get('recurrence_type'),
         data.get('assigned_to') or None, data.get('estimated_minutes') or None,
         datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
    tpl_id = cursor.lastrowid
    db.commit()
    cursor.execute("SELECT * FROM recurring_templates WHERE id = ?", (tpl_id,))
    created = _generate_for_template(db, dict(cursor.fetchone()))
    return {"template_id": tpl_id, "created_count": created}

def create_task(db, task_data: dict):
    """Create a one-time task, or (for recurring types) a recurring template that
    auto-generates its instances over time."""
    recurrence_type = task_data.get('recurrence_type', 'one_time')
    if recurrence_type in ('monthly', 'quarterly', 'six_monthly', 'annual'):
        return create_recurring_template(db, task_data)

    cursor = db.cursor()
    assigned = task_data.get('assigned_to') or None
    if assigned and str(assigned).strip() == "":
        assigned = None
    seq = next_task_no(db, task_data['financial_year'])
    est = task_data.get('estimated_minutes') or None
    created_by = task_data.get('created_by') or None
    cursor.execute('''INSERT INTO task_board (client_id, service_id, financial_year, period, status, assigned_to, due_date, task_no, estimated_minutes, created_by, locked)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)''',
                   (task_data['client_id'], task_data['service_id'], task_data['financial_year'], task_data['period'],
                    task_data.get('status', 'Pending'), assigned, task_data.get('due_date'), seq, est, created_by))
    last_id = cursor.lastrowid
    db.commit()
    return {"id": last_id, "created_count": 1}

# --- Recurring template management ---------------------------------------------
def get_recurring_templates(db):
    cursor = db.cursor()
    cursor.execute('''
        SELECT rt.id, rt.client_id, rt.service_id, rt.financial_year, rt.frequency,
               rt.assigned_to, rt.estimated_minutes, rt.due_day, rt.gen_day, rt.active,
               c.name as client_name, s.name as service_name, u.full_name as assigned_to_name
        FROM recurring_templates rt
        LEFT JOIN client_master c ON rt.client_id = c.id
        LEFT JOIN service_master s ON rt.service_id = s.id
        LEFT JOIN users u ON rt.assigned_to = u.id
        ORDER BY rt.active DESC, rt.id DESC
    ''')
    return [dict(row) for row in cursor.fetchall()]

def update_recurring_template(db, tpl_id, fields: dict):
    allowed = ('assigned_to', 'estimated_minutes', 'active')
    sets, vals = [], []
    for k in allowed:
        if k in fields:
            sets.append(f"{k} = ?")
            vals.append(fields[k])
    if not sets:
        return False
    vals.append(tpl_id)
    cursor = db.cursor()
    cursor.execute(f"UPDATE recurring_templates SET {', '.join(sets)} WHERE id = ?", vals)
    db.commit()
    return cursor.rowcount > 0

def get_client_groups(db):
    cursor = db.cursor()
    cursor.execute('SELECT id, name FROM client_groups')
    return [dict(row) for row in cursor.fetchall()]

def create_client(db, client_data: dict):
    cursor = db.cursor()
    group_id = client_data.get('group_id')
    new_group_name = client_data.get('new_group_name')

    if new_group_name:
        cursor.execute('INSERT INTO client_groups (name) VALUES (?)', (new_group_name,))
        group_id = cursor.lastrowid

    # Pick the requested custom_id (if supplied) or auto-assign the next one.
    requested = (client_data.get('custom_id') or '').strip() or None
    if requested:
        cid = normalize_custom_id(requested, CLIENT_ID_PREFIX)
        if custom_id_clash(db, 'client_master', cid):
            raise ValueError(f"Client ID '{cid}' is already in use by another client.")
    else:
        cid = next_custom_id(db, 'client_master', CLIENT_ID_PREFIX)

    assigned_to = client_data.get('assigned_to') or None
    cursor.execute('''
        INSERT INTO client_master (group_id, name, entity_type, pan, gstin, physical_folder_location, data_location, assigned_to, custom_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (group_id, client_data['name'], client_data['entity_type'], client_data['pan'], client_data.get('gstin', ''), client_data['physical_folder_location'], client_data.get('data_location', ''), assigned_to, cid))
    db.commit()
    return {"id": cursor.lastrowid, "custom_id": cid}

def import_clients(db, rows: list):
    """Bulk-insert pre-validated client rows (each a dict of canonical fields).

    Group names are resolved to ids case-insensitively, creating any group that
    doesn't yet exist. Rows without `custom_id` are auto-assigned the next
    '#CL:N' (continuing after the highest existing). Returns the number created.
    """
    cursor = db.cursor()
    cursor.execute('SELECT id, name FROM client_groups')
    groups = {(r['name'] or '').strip().lower(): r['id'] for r in cursor.fetchall()}
    # Seed the running counter from the current max so multi-row inserts stay unique.
    next_cid = next_custom_id(db, 'client_master', CLIENT_ID_PREFIX)
    next_num = _peak_num(next_cid, CLIENT_ID_PREFIX)
    created = 0
    for row in rows:
        group_id = None
        gname = (row.get('group') or '').strip()
        if gname:
            key = gname.lower()
            if key in groups:
                group_id = groups[key]
            else:
                cursor.execute('INSERT INTO client_groups (name) VALUES (?)', (gname,))
                group_id = cursor.lastrowid
                groups[key] = group_id
        cid = (row.get('custom_id') or '').strip() or None
        if not cid:
            cid = f"#{CLIENT_ID_PREFIX}:{next_num}"
            next_num += 1
        cursor.execute('''
            INSERT INTO client_master (group_id, name, entity_type, pan, gstin, physical_folder_location, data_location, assigned_to, custom_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (group_id, row.get('name', ''), row.get('entity_type', ''),
              row.get('pan', ''), row.get('gstin', ''),
              row.get('physical_folder_location', ''), row.get('data_location', ''), None, cid))
        created += 1
    db.commit()
    return created

def import_services(db, rows: list):
    """Bulk-insert pre-validated service rows. Returns count created."""
    cursor = db.cursor()
    next_cid = next_custom_id(db, 'service_master', SERVICE_ID_PREFIX)
    next_num = _peak_num(next_cid, SERVICE_ID_PREFIX)
    created = 0
    for row in rows:
        checklist_list = [item.strip() for item in str(row.get('checklist', '')).replace('\n', ',').split(',') if item.strip()]
        checklist_json = json.dumps(checklist_list)
        cid = (row.get('custom_id') or '').strip() or None
        if not cid:
            cid = f"#{SERVICE_ID_PREFIX}:{next_num}"
            next_num += 1
        cursor.execute('''
            INSERT INTO service_master (name, description, checklist_json, default_due_day, custom_id)
            VALUES (?, ?, ?, ?, ?)
        ''', (row.get('name', ''), row.get('description', ''), checklist_json, row.get('default_due_day', 15), cid))
        created += 1
    db.commit()
    return created

def import_users(db, rows: list):
    """Bulk-insert pre-validated staff rows. Passwords are hashed; role is always
    'Employee'. Returns count created."""
    cursor = db.cursor()
    created = 0
    for row in rows:
        hashed = security.hash_password(row['password'])
        cursor.execute('''
            INSERT INTO users (username, password, role, full_name)
            VALUES (?, ?, 'Employee', ?)
        ''', (row['username'], hashed, row.get('full_name', '')))
        created += 1
    db.commit()
    return created

def import_tasks(db, rows: list):
    """Bulk-insert pre-resolved task rows (client_id/service_id already looked up).
    Returns count created."""
    cursor = db.cursor()
    created = 0
    seqs = {}   # per-FY running task number
    for row in rows:
        fy = row['financial_year']
        if fy not in seqs:
            seqs[fy] = next_task_no(db, fy)
        cursor.execute('''
            INSERT INTO task_board (client_id, service_id, financial_year, period, status, assigned_to, due_date, task_no)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ''', (row['client_id'], row['service_id'], row['financial_year'], row['period'],
              row.get('status', 'Working'), row.get('assigned_to'), row.get('due_date'), seqs[fy]))
        seqs[fy] += 1
        created += 1
    db.commit()
    return created

def clear_activity_logs(db, from_date: str, to_date: str):
    """Delete activity-log rows whose date falls within [from_date, to_date]
    (inclusive, YYYY-MM-DD). Returns the number of rows deleted."""
    cursor = db.cursor()
    cursor.execute("DELETE FROM activity_log WHERE date(timestamp) BETWEEN ? AND ?", (from_date, to_date))
    db.commit()
    return cursor.rowcount

def create_bulk_tasks(db, bulk_data: dict):
    cursor = db.cursor()
    cursor.execute('SELECT id FROM client_master')
    clients = cursor.fetchall()
    
    created = 0
    seq = next_task_no(db, bulk_data['financial_year'])
    for client in clients:
        cursor.execute('''
            SELECT id FROM task_board 
            WHERE client_id = ? AND service_id = ? AND financial_year = ? AND period = ?
        ''', (client['id'], bulk_data['service_id'], bulk_data['financial_year'], bulk_data['period']))
        
        if not cursor.fetchone():
            cursor.execute('''
                INSERT INTO task_board (client_id, service_id, financial_year, period, status, task_no)
                VALUES (?, ?, ?, ?, 'Working', ?)
            ''', (client['id'], bulk_data['service_id'], bulk_data['financial_year'], bulk_data['period'], seq))
            seq += 1
            created += 1
            
    db.commit()
    return {"created": created}

def save_credential(db, cred_data: dict):
    encrypted_pw = security.encrypt_password(cred_data["password"])
    cursor = db.cursor()
    cursor.execute('''
        INSERT INTO credential_box (client_id, portal_name, encrypted_password)
        VALUES (?, ?, ?)
    ''', (cred_data['client_id'], cred_data['portal_name'], encrypted_pw))
    db.commit()
    return {"id": cursor.lastrowid, "portal_name": cred_data['portal_name']}

def get_decrypted_credential(db, cred_id: int):
    cursor = db.cursor()
    cursor.execute('SELECT encrypted_password FROM credential_box WHERE id = ?', (cred_id,))
    row = cursor.fetchone()
    if row:
        return security.decrypt_password(row['encrypted_password'])
    return None

def get_client_credentials(db, client_id: int):
    cursor = db.cursor()
    cursor.execute('SELECT id, portal_name FROM credential_box WHERE client_id = ?', (client_id,))
    return [dict(row) for row in cursor.fetchall()]

def get_users(db):
    cursor = db.cursor()
    cursor.execute('SELECT id, username, role, full_name, permissions FROM users')
    return [dict(row) for row in cursor.fetchall()]

def create_user(db, user_data: dict):
    hashed_pw = security.hash_password(user_data['password'])
    cursor = db.cursor()
    cursor.execute('''
        INSERT INTO users (username, password, role, full_name, permissions)
        VALUES (?, ?, ?, ?, ?)
    ''', (user_data['username'], hashed_pw, user_data.get('role', 'Employee'),
          user_data['full_name'], user_data.get('permissions')))
    db.commit()
    return {"id": cursor.lastrowid, "username": user_data['username']}

def delete_user(db, user_id: int):
    cursor = db.cursor()
    cursor.execute('DELETE FROM users WHERE id = ?', (user_id,))
    db.commit()
    return cursor.rowcount > 0

def get_timesheets(db):
    cursor = db.cursor()
    cursor.execute('''
        SELECT t.id, t.task_id, t.employee_name, t.hours, t.minutes, t.log_date, t.description,
               tb.financial_year, tb.period, c.name as client_name, s.name as service_name
        FROM timesheets t
        LEFT JOIN task_board tb ON t.task_id = tb.id
        LEFT JOIN client_master c ON tb.client_id = c.id
        LEFT JOIN service_master s ON tb.service_id = s.id
        ORDER BY t.log_date DESC, t.id DESC
    ''')
    return [dict(row) for row in cursor.fetchall()]

def create_timesheet(db, ts_data: dict):
    cursor = db.cursor()
    cursor.execute('''
        INSERT INTO timesheets (task_id, employee_name, hours, minutes, log_date, description)
        VALUES (?, ?, ?, ?, ?, ?)
    ''', (ts_data['task_id'], ts_data['employee_name'], ts_data['hours'], ts_data['minutes'], ts_data['log_date'], ts_data.get('description', '')))
    db.commit()
    return {"id": cursor.lastrowid}

def update_credential(db, cred_id: int, cred_data: dict):
    encrypted_pw = security.encrypt_password(cred_data["password"])
    cursor = db.cursor()
    cursor.execute('''
        UPDATE credential_box 
        SET encrypted_password = ? 
        WHERE id = ?
    ''', (encrypted_pw, cred_id))
    db.commit()
    return cursor.rowcount > 0

def delete_credential(db, cred_id: int):
    cursor = db.cursor()
    cursor.execute('DELETE FROM credential_box WHERE id = ?', (cred_id,))
    db.commit()
    return cursor.rowcount > 0

def get_client_contacts(db, client_id: int):
    cursor = db.cursor()
    cursor.execute('SELECT id, client_id, name, designation, email, mobile FROM client_contacts WHERE client_id = ?', (client_id,))
    return [dict(row) for row in cursor.fetchall()]

def create_client_contact(db, contact_data: dict):
    cursor = db.cursor()
    cursor.execute('''
        INSERT INTO client_contacts (client_id, name, designation, email, mobile)
        VALUES (?, ?, ?, ?, ?)
    ''', (contact_data['client_id'], contact_data['name'], contact_data['designation'], contact_data['email'], contact_data['mobile']))
    db.commit()
    return {"id": cursor.lastrowid}

def create_service(db, service_data: dict):
    cursor = db.cursor()
    checklist_list = [item.strip() for item in service_data.get('checklist_raw', '').split(',') if item.strip()]
    checklist_json = json.dumps(checklist_list)
    requested = (service_data.get('custom_id') or '').strip() or None
    if requested:
        cid = normalize_custom_id(requested, SERVICE_ID_PREFIX)
        if custom_id_clash(db, 'service_master', cid):
            raise ValueError(f"Service ID '{cid}' is already in use by another service.")
    else:
        cid = next_custom_id(db, 'service_master', SERVICE_ID_PREFIX)
    cursor.execute('''
        INSERT INTO service_master (name, description, checklist_json, default_due_day, custom_id)
        VALUES (?, ?, ?, ?, ?)
    ''', (service_data['name'], service_data['description'], checklist_json, service_data.get('default_due_day', 15), cid))
    db.commit()
    return {"id": cursor.lastrowid, "custom_id": cid}

def update_task(db, task_id: int, task_data: dict):
    cursor = db.cursor()
    assigned = task_data.get('assigned_to')
    if not assigned or str(assigned).strip() == "":
        assigned = None
        
    cursor.execute('''
        UPDATE task_board
        SET client_id = ?, service_id = ?, financial_year = ?, period = ?, status = ?, assigned_to = ?, due_date = ?, estimated_minutes = ?
        WHERE id = ?
    ''', (task_data['client_id'], task_data['service_id'], task_data['financial_year'], task_data['period'], task_data['status'], assigned, task_data.get('due_date'), (task_data.get('estimated_minutes') or None), task_id))
    db.commit()
    return cursor.rowcount > 0

def update_client(db, client_id: int, client_data: dict):
    cursor = db.cursor()
    group_id = client_data.get('group_id')
    new_group_name = client_data.get('new_group_name')

    if new_group_name:
        cursor.execute('INSERT INTO client_groups (name) VALUES (?)', (new_group_name,))
        group_id = cursor.lastrowid

    # custom_id: keep as-is if not supplied; normalise + clash-check if supplied.
    cursor.execute('SELECT custom_id FROM client_master WHERE id = ?', (client_id,))
    existing_row = cursor.fetchone()
    cid = existing_row['custom_id'] if existing_row else None
    if 'custom_id' in client_data:
        requested = (client_data.get('custom_id') or '').strip()
        if requested:
            cid = normalize_custom_id(requested, CLIENT_ID_PREFIX)
            if custom_id_clash(db, 'client_master', cid, exclude_id=client_id):
                raise ValueError(f"Client ID '{cid}' is already in use by another client.")

    assigned_to = client_data.get('assigned_to') or None
    cursor.execute('''
        UPDATE client_master
        SET group_id = ?, name = ?, entity_type = ?, pan = ?, gstin = ?, physical_folder_location = ?, data_location = ?, assigned_to = ?, custom_id = ?
        WHERE id = ?
    ''', (group_id, client_data['name'], client_data['entity_type'], client_data['pan'], client_data.get('gstin', ''), client_data['physical_folder_location'], client_data.get('data_location', ''), assigned_to, cid, client_id))
    db.commit()
    return cursor.rowcount > 0

def update_service(db, service_id: int, service_data: dict):
    cursor = db.cursor()
    checklist_list = [item.strip() for item in service_data.get('checklist_raw', '').split(',') if item.strip()]
    checklist_json = json.dumps(checklist_list)
    cursor.execute('SELECT custom_id FROM service_master WHERE id = ?', (service_id,))
    existing_row = cursor.fetchone()
    cid = existing_row['custom_id'] if existing_row else None
    if 'custom_id' in service_data:
        requested = (service_data.get('custom_id') or '').strip()
        if requested:
            cid = normalize_custom_id(requested, SERVICE_ID_PREFIX)
            if custom_id_clash(db, 'service_master', cid, exclude_id=service_id):
                raise ValueError(f"Service ID '{cid}' is already in use by another service.")
    cursor.execute('''
        UPDATE service_master
        SET name = ?, description = ?, checklist_json = ?, default_due_day = ?, custom_id = ?
        WHERE id = ?
    ''', (service_data['name'], service_data['description'], checklist_json, service_data.get('default_due_day', 15), cid, service_id))
    db.commit()
    return cursor.rowcount > 0

def update_user(db, user_id: int, user_data: dict):
    cursor = db.cursor()
    password = user_data.get('password')
    if password:
        hashed_pw = security.hash_password(password)
        cursor.execute('''
            UPDATE users
            SET username = ?, password = ?, role = ?, full_name = ?, permissions = ?
            WHERE id = ?
        ''', (user_data['username'], hashed_pw, user_data['role'], user_data['full_name'],
              user_data.get('permissions'), user_id))
    else:
        cursor.execute('''
            UPDATE users
            SET username = ?, role = ?, full_name = ?, permissions = ?
            WHERE id = ?
        ''', (user_data['username'], user_data['role'], user_data['full_name'],
              user_data.get('permissions'), user_id))

    db.commit()
    return cursor.rowcount > 0

# --- Delete / reassignment helpers (Phase A) ---------------------------------
def count_user_tasks(db, user_id: int):
    """How many tasks reference this user as assignee or delegate."""
    cursor = db.cursor()
    cursor.execute('SELECT COUNT(*) AS n FROM task_board WHERE assigned_to = ? OR delegated_to = ?',
                   (user_id, user_id))
    return cursor.fetchone()['n']

def reassign_user_tasks(db, from_user_id: int, to_user_id):
    """Move every task assigned/delegated to from_user_id over to to_user_id."""
    cursor = db.cursor()
    cursor.execute('UPDATE task_board SET assigned_to = ? WHERE assigned_to = ?', (to_user_id, from_user_id))
    cursor.execute('UPDATE task_board SET delegated_to = ? WHERE delegated_to = ?', (to_user_id, from_user_id))
    db.commit()

def delegate_task(db, task_id: int, user_id):
    """Set (or clear, with user_id=None) the delegate on a task."""
    cursor = db.cursor()
    cursor.execute('UPDATE task_board SET delegated_to = ? WHERE id = ?', (user_id, task_id))
    db.commit()
    return cursor.rowcount > 0

def delete_task(db, task_id: int):
    """Delete a task and any timesheets logged against it."""
    cursor = db.cursor()
    cursor.execute('DELETE FROM timesheets WHERE task_id = ?', (task_id,))
    cursor.execute('DELETE FROM task_board WHERE id = ?', (task_id,))
    db.commit()
    return cursor.rowcount > 0

def count_client_tasks(db, client_id: int):
    cursor = db.cursor()
    cursor.execute('SELECT COUNT(*) AS n FROM task_board WHERE client_id = ?', (client_id,))
    return cursor.fetchone()['n']

def count_service_tasks(db, service_id: int):
    cursor = db.cursor()
    cursor.execute('SELECT COUNT(*) AS n FROM task_board WHERE service_id = ?', (service_id,))
    return cursor.fetchone()['n']

def delete_service(db, service_id: int):
    """Delete a service template and any recurring template tied to it.
    Caller must ensure there are no task instances referencing the service."""
    cursor = db.cursor()
    cursor.execute('DELETE FROM recurring_templates WHERE service_id = ?', (service_id,))
    cursor.execute('DELETE FROM service_master WHERE id = ?', (service_id,))
    db.commit()
    return cursor.rowcount > 0

def delete_client(db, client_id: int):
    """Delete a client and its contacts + stored credentials. Caller must ensure
    the deletion is allowed (e.g. no open tasks)."""
    cursor = db.cursor()
    cursor.execute('DELETE FROM client_contacts WHERE client_id = ?', (client_id,))
    cursor.execute('DELETE FROM credential_box WHERE client_id = ?', (client_id,))
    cursor.execute('DELETE FROM client_master WHERE id = ?', (client_id,))
    db.commit()
    return cursor.rowcount > 0

def count_client_unreceived_tasks(db, client_id: int):
    """Client tasks whose fees are NOT yet received (anything except billing_stage='Received')."""
    cursor = db.cursor()
    cursor.execute('''SELECT COUNT(*) AS n FROM task_board
                      WHERE client_id = ? AND IFNULL(billing_stage, '') != 'Received' ''', (client_id,))
    return cursor.fetchone()['n']

# --- Billing pipeline (Completed -> Billed -> Received) -----------------------
def get_task_for_billing(db, task_id: int):
    cursor = db.cursor()
    cursor.execute('''
        SELECT t.id, t.status, t.billing_stage, t.billed_amount, t.gst_amount, t.total_amount,
               c.name as client_name, s.name as service_name, t.period
        FROM task_board t
        LEFT JOIN client_master c ON t.client_id = c.id
        LEFT JOIN service_master s ON t.service_id = s.id
        WHERE t.id = ?
    ''', (task_id,))
    row = cursor.fetchone()
    return dict(row) if row else None

def set_task_billing(db, task_id: int, fields: dict):
    """Update only the billing columns supplied in `fields`."""
    allowed = ('billing_stage', 'billed_amount', 'gst_amount', 'total_amount',
               'billed_date', 'received_date')
    sets, vals = [], []
    for k in allowed:
        if k in fields:
            sets.append(f"{k} = ?")
            vals.append(fields[k])
    if not sets:
        return False
    vals.append(task_id)
    cursor = db.cursor()
    cursor.execute(f"UPDATE task_board SET {', '.join(sets)} WHERE id = ?", vals)
    db.commit()
    return cursor.rowcount > 0

# --- Persistent task timers (one running per user) ---------------------------
def _close_open_intervals(cursor, user_id):
    """Close any still-open timer interval(s) for the user (records end timestamp)."""
    now = datetime.now()
    now_str = now.strftime("%Y-%m-%d %H:%M:%S")
    cursor.execute("SELECT id, started_at FROM timer_intervals WHERE user_id = ? AND ended_at IS NULL", (user_id,))
    for r in cursor.fetchall():
        try:
            start = datetime.strptime(r['started_at'], "%Y-%m-%d %H:%M:%S")
            secs = max(0, int((now - start).total_seconds()))
        except (ValueError, TypeError):
            secs = 0
        cursor.execute("UPDATE timer_intervals SET ended_at = ?, seconds = ? WHERE id = ?", (now_str, secs, r['id']))

def _bank_running_for_user(cursor, user_id, now):
    """Pause every running timer for this user, banking its elapsed seconds."""
    cursor.execute("SELECT id, accumulated_seconds, running_since FROM task_timers "
                   "WHERE user_id = ? AND running_since IS NOT NULL", (user_id,))
    for row in cursor.fetchall():
        elapsed = max(0, int(now - (row['running_since'] or now)))
        cursor.execute("UPDATE task_timers SET accumulated_seconds = ?, running_since = NULL WHERE id = ?",
                       ((row['accumulated_seconds'] or 0) + elapsed, row['id']))
    _close_open_intervals(cursor, user_id)

def get_user_timers(db, user_id):
    """Current elapsed seconds + running flag for each of the user's task timers."""
    now = time.time()
    cursor = db.cursor()
    cursor.execute("SELECT task_id, accumulated_seconds, running_since FROM task_timers WHERE user_id = ?", (user_id,))
    out = []
    for r in cursor.fetchall():
        running = r['running_since'] is not None
        seconds = (r['accumulated_seconds'] or 0) + (int(now - r['running_since']) if running else 0)
        out.append({"task_id": r['task_id'], "seconds": max(0, seconds), "running": running})
    return out

def timer_start(db, task_id, user_id):
    """Start/resume this task's timer for the user; pause any other running one and
    open a new run interval (records start timestamp)."""
    now = time.time()
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cursor = db.cursor()
    _bank_running_for_user(cursor, user_id, now)   # also closes any open interval
    cursor.execute("SELECT id FROM task_timers WHERE task_id = ? AND user_id = ?", (task_id, user_id))
    row = cursor.fetchone()
    if row:
        cursor.execute("UPDATE task_timers SET running_since = ? WHERE id = ?", (now, row['id']))
    else:
        cursor.execute("INSERT INTO task_timers (task_id, user_id, accumulated_seconds, running_since) "
                       "VALUES (?, ?, 0, ?)", (task_id, user_id, now))
    cursor.execute("INSERT INTO timer_intervals (task_id, user_id, started_at, ended_at, seconds) "
                   "VALUES (?, ?, ?, NULL, NULL)", (task_id, user_id, now_str))
    db.commit()

def timer_pause(db, task_id, user_id):
    """Pause this task's timer for the user, banking elapsed seconds and closing
    the open run interval (records end timestamp)."""
    now = time.time()
    cursor = db.cursor()
    cursor.execute("SELECT id, accumulated_seconds, running_since FROM task_timers "
                   "WHERE task_id = ? AND user_id = ?", (task_id, user_id))
    row = cursor.fetchone()
    if row and row['running_since'] is not None:
        elapsed = max(0, int(now - row['running_since']))
        cursor.execute("UPDATE task_timers SET accumulated_seconds = ?, running_since = NULL WHERE id = ?",
                       ((row['accumulated_seconds'] or 0) + elapsed, row['id']))
    _close_open_intervals(cursor, user_id)
    db.commit()
    return True

def timer_reset(db, task_id):
    """Reset (clear) this task's timer for every user."""
    cursor = db.cursor()
    cursor.execute("DELETE FROM task_timers WHERE task_id = ?", (task_id,))
    cursor.execute("DELETE FROM timer_intervals WHERE task_id = ?", (task_id,))
    db.commit()
    return True

# --- Login sessions & presence -----------------------------------------------
def _now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def start_session(db, user_id):
    """Open a fresh session, closing any still-open one for this user."""
    now = _now_str()
    cur = db.cursor()
    cur.execute("UPDATE user_sessions SET logout_at = last_seen WHERE user_id = ? AND logout_at IS NULL", (user_id,))
    cur.execute("INSERT INTO user_sessions (user_id, login_at, last_seen, logout_at) VALUES (?, ?, ?, NULL)",
                (user_id, now, now))
    db.commit()

def touch_session(db, user_id):
    """Heartbeat: refresh last_seen on the user's open session (or open one)."""
    now = _now_str()
    cur = db.cursor()
    cur.execute("SELECT id FROM user_sessions WHERE user_id = ? AND logout_at IS NULL ORDER BY id DESC LIMIT 1", (user_id,))
    row = cur.fetchone()
    if row:
        cur.execute("UPDATE user_sessions SET last_seen = ? WHERE id = ?", (now, row['id']))
    else:
        cur.execute("INSERT INTO user_sessions (user_id, login_at, last_seen, logout_at) VALUES (?, ?, ?, NULL)",
                    (user_id, now, now))
    db.commit()

def end_session(db, user_id):
    now = _now_str()
    cur = db.cursor()
    cur.execute("UPDATE user_sessions SET logout_at = ?, last_seen = ? WHERE user_id = ? AND logout_at IS NULL",
                (now, now, user_id))
    db.commit()

def get_presence(db, window_seconds=150):
    """Per user: online (open session + recent heartbeat) and working (running timer)."""
    cur = db.cursor()
    cur.execute('''
        SELECT u.id, u.full_name, u.role,
               (SELECT s.last_seen FROM user_sessions s WHERE s.user_id = u.id ORDER BY s.id DESC LIMIT 1) AS last_seen,
               (SELECT s.logout_at FROM user_sessions s WHERE s.user_id = u.id ORDER BY s.id DESC LIMIT 1) AS logout_at,
               (SELECT COUNT(*) FROM task_timers t WHERE t.user_id = u.id AND t.running_since IS NOT NULL) AS running
        FROM users u
        ORDER BY u.full_name
    ''')
    now = datetime.now()
    out = []
    for r in cur.fetchall():
        online = False
        if r['logout_at'] is None and r['last_seen']:
            try:
                online = (now - datetime.strptime(r['last_seen'], "%Y-%m-%d %H:%M:%S")).total_seconds() <= window_seconds
            except ValueError:
                online = False
        out.append({"user_id": r['id'], "full_name": r['full_name'], "role": r['role'],
                    "online": online, "working": bool(r['running']), "last_seen": r['last_seen']})
    return out

def daily_logged_in_seconds(db, user_id, date_str):
    """Seconds the user was logged in on date_str (sum of sessions), with first
    login + last logout times for display."""
    cur = db.cursor()
    cur.execute("SELECT login_at, last_seen, logout_at FROM user_sessions "
                "WHERE user_id = ? AND substr(login_at, 1, 10) = ? ORDER BY id", (user_id, date_str))
    total, first_login, last_out = 0, None, None
    for r in cur.fetchall():
        try:
            start = datetime.strptime(r['login_at'], "%Y-%m-%d %H:%M:%S")
        except (ValueError, TypeError):
            continue
        end_str = r['logout_at'] or r['last_seen'] or r['login_at']
        try:
            end = datetime.strptime(end_str, "%Y-%m-%d %H:%M:%S")
        except (ValueError, TypeError):
            end = start
        total += max(0, int((end - start).total_seconds()))
        if first_login is None:
            first_login = r['login_at']
        last_out = end_str
    return {"seconds": total, "first_login": first_login, "last_logout": last_out}

# --- Daily timesheets & report ------------------------------------------------
def upsert_daily_timesheet(db, user_id, log_date, description):
    """Create/replace the user's filed timesheet for a day; stamps submitted_at."""
    now = _now_str()
    cur = db.cursor()
    cur.execute("SELECT id FROM daily_timesheets WHERE user_id = ? AND log_date = ?", (user_id, log_date))
    row = cur.fetchone()
    if row:
        cur.execute("UPDATE daily_timesheets SET description = ?, submitted_at = ? WHERE id = ?",
                    (description, now, row['id']))
    else:
        cur.execute("INSERT INTO daily_timesheets (user_id, log_date, description, submitted_at) VALUES (?, ?, ?, ?)",
                    (user_id, log_date, description, now))
    db.commit()
    return True

def build_timesheet_report(db, user_ids, from_date, to_date):
    """Per (user, day) report: logged-in time + each task worked that day (time
    today from timer intervals, start/end timestamps, total since creation,
    status, dates) + the filed description and a late/early submission flag."""
    if not user_ids:
        return []
    cur = db.cursor()
    ph = ",".join("?" * len(user_ids))
    cur.execute("SELECT id, full_name FROM users")
    names = {r['id']: r['full_name'] for r in cur.fetchall()}

    day_keys = set()
    cur.execute(f"""SELECT DISTINCT user_id, substr(started_at,1,10) AS d FROM timer_intervals
                    WHERE user_id IN ({ph}) AND substr(started_at,1,10) BETWEEN ? AND ?""",
                (*user_ids, from_date, to_date))
    for r in cur.fetchall():
        day_keys.add((r['user_id'], r['d']))
    cur.execute(f"""SELECT user_id, log_date AS d FROM daily_timesheets
                    WHERE user_id IN ({ph}) AND log_date BETWEEN ? AND ?""",
                (*user_ids, from_date, to_date))
    for r in cur.fetchall():
        day_keys.add((r['user_id'], r['d']))

    report = []
    for (uid, d) in sorted(day_keys, key=lambda x: (x[1], names.get(x[0], '')), reverse=True):
        li = daily_logged_in_seconds(db, uid, d)
        cur.execute("SELECT description, submitted_at FROM daily_timesheets WHERE user_id = ? AND log_date = ?", (uid, d))
        dts = cur.fetchone()
        description = dts['description'] if dts else None
        submitted_at = dts['submitted_at'] if dts else None
        flag = 'ontime'
        if submitted_at:
            sub_date = submitted_at[:10]
            if sub_date > d:
                flag = 'late'
            elif sub_date < d:
                flag = 'early'

        cur.execute("""SELECT task_id,
                              SUM(CASE WHEN seconds IS NOT NULL THEN seconds ELSE 0 END) AS secs,
                              MIN(started_at) AS start_ts, MAX(ended_at) AS end_ts,
                              SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END) AS open_count
                       FROM timer_intervals
                       WHERE user_id = ? AND substr(started_at,1,10) = ?
                       GROUP BY task_id""", (uid, d))
        tasks = []
        for tr in cur.fetchall():
            tid = tr['task_id']
            cur.execute("""SELECT c.name AS client_name, s.name AS service_name, t.status, t.financial_year, t.period, t.task_no
                           FROM task_board t LEFT JOIN client_master c ON t.client_id = c.id
                           LEFT JOIN service_master s ON t.service_id = s.id WHERE t.id = ?""", (tid,))
            tb = cur.fetchone()
            cur.execute("SELECT accumulated_seconds FROM task_timers WHERE task_id = ? AND user_id = ?", (tid, uid))
            tt = cur.fetchone()
            total = (tt['accumulated_seconds'] or 0) if tt else 0
            cur.execute("SELECT MIN(substr(started_at,1,10)) AS sd FROM timer_intervals WHERE task_id = ?", (tid,))
            sd = cur.fetchone()['sd']
            tasks.append({
                "task_id": tid,
                "client_name": tb['client_name'] if tb else None,
                "service_name": tb['service_name'] if tb else None,
                "status": tb['status'] if tb else None,
                "financial_year": tb['financial_year'] if tb else None,
                "period": tb['period'] if tb else None,
                "task_no": tb['task_no'] if tb else None,
                "start_date": sd,
                "time_today_seconds": tr['secs'] or 0,
                "start_ts": tr['start_ts'],
                "end_ts": tr['end_ts'],
                "running": bool(tr['open_count']),
                "total_seconds": total,
            })
        report.append({
            "user_id": uid, "full_name": names.get(uid), "date": d,
            "logged_seconds": li['seconds'], "first_login": li['first_login'], "last_logout": li['last_logout'],
            "description": description, "submitted_at": submitted_at, "submission_flag": flag,
            "tasks": tasks,
        })
    return report

