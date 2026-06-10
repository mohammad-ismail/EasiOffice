from . import security
import json
from datetime import datetime

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
        SELECT t.id, c.name as client_name, s.name as service_name, t.financial_year, t.period, t.status, t.assigned_to, u.full_name as assigned_to_name, t.client_id, t.due_date
        FROM task_board t
        LEFT JOIN client_master c ON t.client_id = c.id
        LEFT JOIN service_master s ON t.service_id = s.id
        LEFT JOIN users u ON t.assigned_to = u.id
    ''')
    return [dict(row) for row in cursor.fetchall()]

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
        SELECT c.id, c.name, c.entity_type, c.pan, c.gstin, c.physical_folder_location, c.data_location,
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
    cursor.execute('SELECT id, name, description, checklist_json, default_due_day FROM service_master')
    return [dict(row) for row in cursor.fetchall()]

def create_task(db, task_data: dict):
    cursor = db.cursor()
    
    # Retrieve default due day for the service
    cursor.execute('SELECT default_due_day FROM service_master WHERE id = ?', (task_data['service_id'],))
    srv_row = cursor.fetchone()
    default_due_day = srv_row['default_due_day'] if (srv_row and srv_row['default_due_day'] is not None) else 15
    
    recurrence_type = task_data.get('recurrence_type', 'one_time')
    
    def get_due_date_for_month(fy: str, month_name: str, day: int):
        try:
            parts = fy.split('-')
            start_year = int(parts[0])
        except Exception:
            start_year = 2025
            
        months_map = {
            "April": (start_year, "04"),
            "May": (start_year, "05"),
            "June": (start_year, "06"),
            "July": (start_year, "07"),
            "August": (start_year, "08"),
            "September": (start_year, "09"),
            "October": (start_year, "10"),
            "November": (start_year, "11"),
            "December": (start_year, "12"),
            "January": (start_year + 1, "01"),
            "February": (start_year + 1, "02"),
            "March": (start_year + 1, "03")
        }
        yr, mo = months_map.get(month_name, (start_year, "05"))
        return f"{yr}-{mo}-{day:02d}"

    tasks_to_create = []
    
    if recurrence_type == 'monthly':
        months = ["April", "May", "June", "July", "August", "September", "October", "November", "December", "January", "February", "March"]
        for m in months:
            due = get_due_date_for_month(task_data['financial_year'], m, default_due_day)
            tasks_to_create.append({
                "period": m,
                "due_date": due,
                "assigned_to": None
            })
    elif recurrence_type == 'quarterly':
        quarters = [
            ("Q1 (Apr-Jun)", "June"),
            ("Q2 (Jul-Sep)", "September"),
            ("Q3 (Oct-Dec)", "December"),
            ("Q4 (Jan-Mar)", "March")
        ]
        for q, m in quarters:
            due = get_due_date_for_month(task_data['financial_year'], m, default_due_day)
            tasks_to_create.append({
                "period": q,
                "due_date": due,
                "assigned_to": None
            })
    elif recurrence_type == 'six_monthly':
        halves = [
            ("H1 (Apr-Sep)", "September"),
            ("H2 (Oct-Mar)", "March")
        ]
        for h, m in halves:
            due = get_due_date_for_month(task_data['financial_year'], m, default_due_day)
            tasks_to_create.append({
                "period": h,
                "due_date": due,
                "assigned_to": None
            })
    elif recurrence_type == 'annual':
        due = get_due_date_for_month(task_data['financial_year'], "March", default_due_day)
        tasks_to_create.append({
            "period": "Annual",
            "due_date": due,
            "assigned_to": None
        })
    else: # one_time
        assigned = task_data.get('assigned_to')
        if not assigned or str(assigned).strip() == "":
            assigned = None
        
        due = task_data.get('due_date')
        if not due:
            due = get_due_date_for_month(task_data['financial_year'], "May", default_due_day)
            
        tasks_to_create.append({
            "period": task_data['period'],
            "due_date": due,
            "assigned_to": assigned
        })
        
    last_id = None
    for t in tasks_to_create:
        cursor.execute('''
            INSERT INTO task_board (client_id, service_id, financial_year, period, status, assigned_to, due_date)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (task_data['client_id'], task_data['service_id'], task_data['financial_year'], t['period'], task_data.get('status', 'Working'), t['assigned_to'], t['due_date']))
        last_id = cursor.lastrowid
        
    db.commit()
    return {"id": last_id, "created_count": len(tasks_to_create)}

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
        
    assigned_to = client_data.get('assigned_to') or None
    cursor.execute('''
        INSERT INTO client_master (group_id, name, entity_type, pan, gstin, physical_folder_location, data_location, assigned_to)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ''', (group_id, client_data['name'], client_data['entity_type'], client_data['pan'], client_data.get('gstin', ''), client_data['physical_folder_location'], client_data.get('data_location', ''), assigned_to))
    db.commit()
    return {"id": cursor.lastrowid}

def import_clients(db, rows: list):
    """Bulk-insert pre-validated client rows (each a dict of canonical fields).

    Group names are resolved to ids case-insensitively, creating any group that
    doesn't yet exist. Returns the number of clients created.
    """
    cursor = db.cursor()
    cursor.execute('SELECT id, name FROM client_groups')
    groups = {(r['name'] or '').strip().lower(): r['id'] for r in cursor.fetchall()}
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
        cursor.execute('''
            INSERT INTO client_master (group_id, name, entity_type, pan, gstin, physical_folder_location, data_location, assigned_to)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ''', (group_id, row.get('name', ''), row.get('entity_type', ''),
              row.get('pan', ''), row.get('gstin', ''),
              row.get('physical_folder_location', ''), row.get('data_location', ''), None))
        created += 1
    db.commit()
    return created

def import_services(db, rows: list):
    """Bulk-insert pre-validated service rows. Returns count created."""
    cursor = db.cursor()
    created = 0
    for row in rows:
        checklist_list = [item.strip() for item in str(row.get('checklist', '')).replace('\n', ',').split(',') if item.strip()]
        checklist_json = json.dumps(checklist_list)
        cursor.execute('''
            INSERT INTO service_master (name, description, checklist_json, default_due_day)
            VALUES (?, ?, ?, ?)
        ''', (row.get('name', ''), row.get('description', ''), checklist_json, row.get('default_due_day', 15)))
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
    for row in rows:
        cursor.execute('''
            INSERT INTO task_board (client_id, service_id, financial_year, period, status, assigned_to, due_date)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (row['client_id'], row['service_id'], row['financial_year'], row['period'],
              row.get('status', 'Working'), row.get('assigned_to'), row.get('due_date')))
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
    for client in clients:
        cursor.execute('''
            SELECT id FROM task_board 
            WHERE client_id = ? AND service_id = ? AND financial_year = ? AND period = ?
        ''', (client['id'], bulk_data['service_id'], bulk_data['financial_year'], bulk_data['period']))
        
        if not cursor.fetchone():
            cursor.execute('''
                INSERT INTO task_board (client_id, service_id, financial_year, period, status)
                VALUES (?, ?, ?, ?, 'Working')
            ''', (client['id'], bulk_data['service_id'], bulk_data['financial_year'], bulk_data['period']))
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
    cursor.execute('SELECT id, username, role, full_name FROM users')
    return [dict(row) for row in cursor.fetchall()]

def create_user(db, user_data: dict):
    hashed_pw = security.hash_password(user_data['password'])
    cursor = db.cursor()
    cursor.execute('''
        INSERT INTO users (username, password, role, full_name)
        VALUES (?, ?, ?, ?)
    ''', (user_data['username'], hashed_pw, user_data['role'], user_data['full_name']))
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
    cursor.execute('''
        INSERT INTO service_master (name, description, checklist_json, default_due_day)
        VALUES (?, ?, ?, ?)
    ''', (service_data['name'], service_data['description'], checklist_json, service_data.get('default_due_day', 15)))
    db.commit()
    return {"id": cursor.lastrowid}

def update_task(db, task_id: int, task_data: dict):
    cursor = db.cursor()
    assigned = task_data.get('assigned_to')
    if not assigned or str(assigned).strip() == "":
        assigned = None
        
    cursor.execute('''
        UPDATE task_board 
        SET client_id = ?, service_id = ?, financial_year = ?, period = ?, status = ?, assigned_to = ?, due_date = ?
        WHERE id = ?
    ''', (task_data['client_id'], task_data['service_id'], task_data['financial_year'], task_data['period'], task_data['status'], assigned, task_data.get('due_date'), task_id))
    db.commit()
    return cursor.rowcount > 0

def update_client(db, client_id: int, client_data: dict):
    cursor = db.cursor()
    group_id = client_data.get('group_id')
    new_group_name = client_data.get('new_group_name')
    
    if new_group_name:
        cursor.execute('INSERT INTO client_groups (name) VALUES (?)', (new_group_name,))
        group_id = cursor.lastrowid
        
    assigned_to = client_data.get('assigned_to') or None
    cursor.execute('''
        UPDATE client_master
        SET group_id = ?, name = ?, entity_type = ?, pan = ?, gstin = ?, physical_folder_location = ?, data_location = ?, assigned_to = ?
        WHERE id = ?
    ''', (group_id, client_data['name'], client_data['entity_type'], client_data['pan'], client_data.get('gstin', ''), client_data['physical_folder_location'], client_data.get('data_location', ''), assigned_to, client_id))
    db.commit()
    return cursor.rowcount > 0

def update_service(db, service_id: int, service_data: dict):
    cursor = db.cursor()
    checklist_list = [item.strip() for item in service_data.get('checklist_raw', '').split(',') if item.strip()]
    checklist_json = json.dumps(checklist_list)
    cursor.execute('''
        UPDATE service_master 
        SET name = ?, description = ?, checklist_json = ?, default_due_day = ?
        WHERE id = ?
    ''', (service_data['name'], service_data['description'], checklist_json, service_data.get('default_due_day', 15), service_id))
    db.commit()
    return cursor.rowcount > 0

def update_user(db, user_id: int, user_data: dict):
    cursor = db.cursor()
    password = user_data.get('password')
    if password:
        hashed_pw = security.hash_password(password)
        cursor.execute('''
            UPDATE users
            SET username = ?, password = ?, role = ?, full_name = ?
            WHERE id = ?
        ''', (user_data['username'], hashed_pw, user_data['role'], user_data['full_name'], user_id))
    else:
        cursor.execute('''
            UPDATE users 
            SET username = ?, role = ?, full_name = ?
            WHERE id = ?
        ''', (user_data['username'], user_data['role'], user_data['full_name'], user_id))
        
    db.commit()
    return cursor.rowcount > 0

