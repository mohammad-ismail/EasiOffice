import json
import os
from . import security

def seed_data(db):
    cursor = db.cursor()

    # 1. Seed default users if users table is empty
    cursor.execute("SELECT id FROM users LIMIT 1")
    if not cursor.fetchone():
        # Passwords are stored as one-way hashes. The initial admin password is
        # overridable via the ADMIN_PASSWORD env var; change it after first login.
        admin_initial = os.environ.get("ADMIN_PASSWORD", "admin123")
        if admin_initial == "admin123":
            print("[security] WARNING: seeding default admin password 'admin123'. "
                  "Set ADMIN_PASSWORD and change it after first login.")
        admin_pw = security.hash_password(admin_initial)
        rahul_pw = security.hash_password("rahul123")
        sneha_pw = security.hash_password("sneha123")
        
        cursor.execute("INSERT INTO users (username, password, role, full_name) VALUES (?, ?, ?, ?)", 
                       ("admin", admin_pw, "Admin", "Anil Shah"))
        cursor.execute("INSERT INTO users (username, password, role, full_name) VALUES (?, ?, ?, ?)", 
                       ("ca_rahul", rahul_pw, "Employee", "Rahul Mehta"))
        cursor.execute("INSERT INTO users (username, password, role, full_name) VALUES (?, ?, ?, ?)", 
                       ("audit_sneha", sneha_pw, "Employee", "Sneha Patel"))
    
    # Fetch seeded user IDs for assignment
    cursor.execute("SELECT id, username FROM users")
    users_dict = {row['username']: row['id'] for row in cursor.fetchall()}
    
    rahul_id = users_dict.get('ca_rahul', 2)
    sneha_id = users_dict.get('audit_sneha', 3)
    
    # 2. Seed main data if empty
    cursor.execute("SELECT id FROM client_groups LIMIT 1")
    if cursor.fetchone():
        # Even if already seeded, make sure existing seeded tasks have assignments
        cursor.execute("UPDATE task_board SET assigned_to = ? WHERE id = 1 AND assigned_to IS NULL", (sneha_id,))
        cursor.execute("UPDATE task_board SET assigned_to = ? WHERE id = 2 AND assigned_to IS NULL", (rahul_id,))
        
        # Retroactively set due dates and default due days
        cursor.execute("UPDATE task_board SET due_date = '2025-04-15' WHERE id = 1 AND due_date IS NULL")
        cursor.execute("UPDATE task_board SET due_date = '2025-07-25' WHERE id = 2 AND due_date IS NULL")
        cursor.execute("UPDATE service_master SET default_due_day = 15 WHERE id = 1 AND default_due_day IS NULL")
        cursor.execute("UPDATE service_master SET default_due_day = 25 WHERE id = 2 AND default_due_day IS NULL")
        
        # Retroactively seed contacts for already seeded databases if empty
        cursor.execute("SELECT id FROM client_contacts LIMIT 1")
        if not cursor.fetchone():
            cursor.execute("SELECT id FROM client_master")
            clients_list = cursor.fetchall()
            if len(clients_list) >= 2:
                client1_id = clients_list[0]['id']
                client2_id = clients_list[1]['id']
                cursor.execute("INSERT INTO client_contacts (client_id, name, designation, email, mobile) VALUES (?, ?, ?, ?, ?)",
                               (client1_id, "Rajesh Shah", "Proprietor", "rajesh@shahfamily.com", "9876543210"))
                cursor.execute("INSERT INTO client_contacts (client_id, name, designation, email, mobile) VALUES (?, ?, ?, ?, ?)",
                               (client1_id, "Vinay Mehta", "Accountant", "vinay.acct@gmail.com", "9811223344"))
                cursor.execute("INSERT INTO client_contacts (client_id, name, designation, email, mobile) VALUES (?, ?, ?, ?, ?)",
                               (client2_id, "Anil Shah", "Director", "anil@shahandsons.com", "9822334455"))
                cursor.execute("INSERT INTO client_contacts (client_id, name, designation, email, mobile) VALUES (?, ?, ?, ?, ?)",
                               (client2_id, "Sneha Patil", "Accountant", "sneha.acct@shahandsons.com", "9833445566"))
                cursor.execute("INSERT INTO client_contacts (client_id, name, designation, email, mobile) VALUES (?, ?, ?, ?, ?)",
                               (client2_id, "Rohan Dev", "Personal Assistant", "rohan.pa@shahandsons.com", "9844556677"))
        
        # Retroactively set data_location if empty
        cursor.execute("UPDATE client_master SET data_location = '\\\\SERVER-SHARE\\Clients\\RajeshShah' WHERE id = 1 AND data_location IS NULL")
        cursor.execute("UPDATE client_master SET data_location = 'D:\\Shared\\ShahAndSons' WHERE id = 2 AND data_location IS NULL")
        db.commit()
        return
        
    cursor.execute("INSERT INTO client_groups (name) VALUES (?)", ("Shah Family",))
    group_id = cursor.lastrowid
    
    cursor.execute('''
        INSERT INTO client_master (group_id, name, entity_type, pan, gstin, physical_folder_location, data_location)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ''', (group_id, "Rajesh Shah", "Proprietor", "ABCDE1234F", "27ABCDE1234F1Z5", "Cabinet A, Shelf 2", "\\\\SERVER-SHARE\\Clients\\RajeshShah"))
    client1_id = cursor.lastrowid
    
    cursor.execute('''
        INSERT INTO client_master (group_id, name, entity_type, pan, gstin, physical_folder_location, data_location)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ''', (group_id, "Shah & Sons Ltd", "Pvt Ltd", "ZYXWV9876Q", "27ZYXWV9876Q1Z9", "Cabinet B, Shelf 1", "D:\\Shared\\ShahAndSons"))
    client2_id = cursor.lastrowid
    
    cursor.execute('''
        INSERT INTO service_master (name, description, checklist_json, default_due_day)
        VALUES (?, ?, ?, ?)
    ''', ("GST 3B", "Monthly GST Return", json.dumps(["Collect Data", "Reconcile 2B", "File Return", "Send Challan"]), 15))
    service1_id = cursor.lastrowid
    
    cursor.execute('''
        INSERT INTO service_master (name, description, checklist_json, default_due_day)
        VALUES (?, ?, ?, ?)
    ''', ("Income Tax Return", "Annual ITR", json.dumps(["Form 16/16A", "Compute Tax", "File ITR"]), 25))
    service2_id = cursor.lastrowid
    
    cursor.execute('''
        INSERT INTO task_board (client_id, service_id, financial_year, period, status, assigned_to, due_date)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ''', (client1_id, service1_id, "2025-26", "April", "Working", sneha_id, "2025-04-15"))
    
    cursor.execute('''
        INSERT INTO task_board (client_id, service_id, financial_year, period, status, assigned_to, due_date)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ''', (client2_id, service2_id, "2025-26", "Annual", "Pending", rahul_id, "2025-07-25"))
    
    encrypted_pw = security.encrypt_password("dummy_password_123")
    cursor.execute('''
        INSERT INTO credential_box (client_id, portal_name, encrypted_password)
        VALUES (?, ?, ?)
    ''', (client1_id, "Income Tax Portal", encrypted_pw))
    
    # Seed client contacts
    cursor.execute("INSERT INTO client_contacts (client_id, name, designation, email, mobile) VALUES (?, ?, ?, ?, ?)",
                   (client1_id, "Rajesh Shah", "Proprietor", "rajesh@shahfamily.com", "9876543210"))
    cursor.execute("INSERT INTO client_contacts (client_id, name, designation, email, mobile) VALUES (?, ?, ?, ?, ?)",
                   (client1_id, "Vinay Mehta", "Accountant", "vinay.acct@gmail.com", "9811223344"))
    cursor.execute("INSERT INTO client_contacts (client_id, name, designation, email, mobile) VALUES (?, ?, ?, ?, ?)",
                   (client2_id, "Anil Shah", "Director", "anil@shahandsons.com", "9822334455"))
    cursor.execute("INSERT INTO client_contacts (client_id, name, designation, email, mobile) VALUES (?, ?, ?, ?, ?)",
                   (client2_id, "Sneha Patil", "Accountant", "sneha.acct@shahandsons.com", "9833445566"))
    cursor.execute("INSERT INTO client_contacts (client_id, name, designation, email, mobile) VALUES (?, ?, ?, ?, ?)",
                   (client2_id, "Rohan Dev", "Personal Assistant", "rohan.pa@shahandsons.com", "9844556677"))
    
    # 3. Seed initial timesheets if empty
    cursor.execute("SELECT id FROM timesheets LIMIT 1")
    if not cursor.fetchone():
        cursor.execute("SELECT id FROM task_board")
        tasks = cursor.fetchall()
        if tasks:
            cursor.execute('''
                INSERT INTO timesheets (task_id, employee_name, hours, minutes, log_date, description)
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (tasks[0]['id'], "Sneha Patel", 2, 30, "2026-05-20", "Completed monthly data entry and preliminary ITC reconciliation"))
        if len(tasks) > 1:
            cursor.execute('''
                INSERT INTO timesheets (task_id, employee_name, hours, minutes, log_date, description)
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (tasks[1]['id'], "Rahul Mehta", 4, 0, "2026-05-22", "Reviewed tax computation sheets and Form 26AS alignment"))
            
    db.commit()
