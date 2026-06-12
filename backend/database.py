import sqlite3
import os

# The database lives on a persistent data directory that is mounted as a Docker
# volume, so it survives container rebuilds/updates. The path is overridable via
# the DB_PATH env var (set in docker-compose.yml). Default: <project>/data/easibusiness.db
_ROOT = os.path.dirname(os.path.dirname(__file__))
DB_PATH = os.environ.get("DB_PATH", os.path.join(_ROOT, "data", "easibusiness.db"))

# Make sure the parent directory exists (e.g. on first run before the volume is populated)
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    # WAL improves concurrent read/write behaviour for multiple staff on the NAS;
    # foreign_keys=ON enforces the relational constraints declared in the schema.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def init_db():
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS client_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT
    )
    ''')
    
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS client_master (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER,
        name TEXT,
        entity_type TEXT,
        pan TEXT,
        gstin TEXT,
        physical_folder_location TEXT,
        FOREIGN KEY (group_id) REFERENCES client_groups (id)
    )
    ''')
    
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS service_master (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        description TEXT,
        checklist_json TEXT,
        default_due_day INTEGER DEFAULT 15
    )
    ''')
    
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS task_board (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER,
        service_id INTEGER,
        financial_year TEXT,
        period TEXT,
        status TEXT DEFAULT 'Working',
        assigned_to INTEGER,
        due_date TEXT,
        FOREIGN KEY (client_id) REFERENCES client_master (id),
        FOREIGN KEY (service_id) REFERENCES service_master (id)
    )
    ''')
    
    # Auto-migration safety check: Add assigned_to to task_board if not present
    cursor.execute("PRAGMA table_info(task_board)")
    tb_columns = [row[1] for row in cursor.fetchall()]
    if 'assigned_to' not in tb_columns:
        cursor.execute("ALTER TABLE task_board ADD COLUMN assigned_to INTEGER")

    
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS timesheets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        employee_name TEXT,
        hours INTEGER,
        minutes INTEGER,
        log_date TEXT,
        FOREIGN KEY (task_id) REFERENCES task_board (id)
    )
    ''')
    
    # Auto-migration safety check: Add description to timesheets if not present
    cursor.execute("PRAGMA table_info(timesheets)")
    columns = [row[1] for row in cursor.fetchall()] # SQLite PRAGMA returns (cid, name, type, notnull, dflt_value, pk)
    if 'description' not in columns:
        cursor.execute("ALTER TABLE timesheets ADD COLUMN description TEXT")
    
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS credential_box (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER,
        portal_name TEXT,
        encrypted_password TEXT,
        FOREIGN KEY (client_id) REFERENCES client_master (id)
    )
    ''')
    
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT,
        full_name TEXT
    )
    ''')
    
    # Auto-migration safety check: Add data_location to client_master if not present
    cursor.execute("PRAGMA table_info(client_master)")
    cm_columns = [row[1] for row in cursor.fetchall()]
    if 'data_location' not in cm_columns:
        cursor.execute("ALTER TABLE client_master ADD COLUMN data_location TEXT")

    # Auto-migration: Add assigned_to (direct client -> staff assignment) to client_master
    cursor.execute("PRAGMA table_info(client_master)")
    cm_columns = [row[1] for row in cursor.fetchall()]
    if 'assigned_to' not in cm_columns:
        cursor.execute("ALTER TABLE client_master ADD COLUMN assigned_to INTEGER")
        
    # Auto-migration: Create client_contacts table
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS client_contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER,
        name TEXT,
        designation TEXT,
        email TEXT,
        mobile TEXT,
        FOREIGN KEY (client_id) REFERENCES client_master (id)
    )
    ''')
    
    # Auto-migration safety check: Rename Going On -> Working, Stuck -> Pending
    cursor.execute("UPDATE task_board SET status = 'Working' WHERE status = 'Going On'")
    cursor.execute("UPDATE task_board SET status = 'Pending' WHERE status = 'Stuck'")
    
    # Auto-migration safety check: Add default_due_day to service_master if not present
    cursor.execute("PRAGMA table_info(service_master)")
    sm_cols = [row[1] for row in cursor.fetchall()]
    if 'default_due_day' not in sm_cols:
        cursor.execute("ALTER TABLE service_master ADD COLUMN default_due_day INTEGER DEFAULT 15")
        
    # Auto-migration safety check: Add due_date to task_board if not present
    cursor.execute("PRAGMA table_info(task_board)")
    tb_cols = [row[1] for row in cursor.fetchall()]
    if 'due_date' not in tb_cols:
        cursor.execute("ALTER TABLE task_board ADD COLUMN due_date TEXT")
        
    # Auto-migration: Create activity_log table
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        action TEXT,
        details TEXT,
        timestamp TEXT
    )
    ''')

    # Auto-migration: per-user permission overrides (JSON) on top of role defaults
    cursor.execute("PRAGMA table_info(users)")
    user_cols = [row[1] for row in cursor.fetchall()]
    if 'permissions' not in user_cols:
        cursor.execute("ALTER TABLE users ADD COLUMN permissions TEXT")

    # Auto-migration: delegation target on tasks (Manager delegates to an Employee)
    cursor.execute("PRAGMA table_info(task_board)")
    tb_cols3 = [row[1] for row in cursor.fetchall()]
    if 'delegated_to' not in tb_cols3:
        cursor.execute("ALTER TABLE task_board ADD COLUMN delegated_to INTEGER")

    # Auto-migration: billing pipeline (Completed -> Billed -> Received Fees)
    cursor.execute("PRAGMA table_info(task_board)")
    tb_cols4 = [row[1] for row in cursor.fetchall()]
    billing_cols = {
        'billing_stage': "ALTER TABLE task_board ADD COLUMN billing_stage TEXT",   # '', 'Billed', 'Received'
        'billed_amount': "ALTER TABLE task_board ADD COLUMN billed_amount REAL",
        'gst_amount': "ALTER TABLE task_board ADD COLUMN gst_amount REAL",
        'total_amount': "ALTER TABLE task_board ADD COLUMN total_amount REAL",
        'billed_date': "ALTER TABLE task_board ADD COLUMN billed_date TEXT",
        'received_date': "ALTER TABLE task_board ADD COLUMN received_date TEXT",
    }
    for col, ddl in billing_cols.items():
        if col not in tb_cols4:
            cursor.execute(ddl)

    # Auto-migration: per-financial-year task number (resets to 1 each FY).
    # The global `id` stays the internal key; `task_no` is the user-facing ID.
    cursor.execute("PRAGMA table_info(task_board)")
    tb_cols5 = [row[1] for row in cursor.fetchall()]
    if 'task_no' not in tb_cols5:
        cursor.execute("ALTER TABLE task_board ADD COLUMN task_no INTEGER")
        # Backfill: number existing tasks 1..N within each financial year, ordered by id.
        cursor.execute("SELECT id, financial_year FROM task_board ORDER BY financial_year, id")
        counters = {}
        for row in cursor.fetchall():
            fy = row[1] or ''
            counters[fy] = counters.get(fy, 0) + 1
            cursor.execute("UPDATE task_board SET task_no = ? WHERE id = ?", (counters[fy], row[0]))

    # Auto-migration: estimated time budget (minutes) per task
    cursor.execute("PRAGMA table_info(task_board)")
    tb_cols6 = [row[1] for row in cursor.fetchall()]
    if 'estimated_minutes' not in tb_cols6:
        cursor.execute("ALTER TABLE task_board ADD COLUMN estimated_minutes INTEGER")

    # Auto-migration: persistent per-(task,user) timers. Only one row per user may
    # be 'running' (running_since not NULL) at a time; pausing banks the elapsed
    # seconds into accumulated_seconds so it resumes from where it left off.
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS task_timers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        accumulated_seconds INTEGER DEFAULT 0,
        running_since REAL,
        UNIQUE(task_id, user_id),
        FOREIGN KEY (task_id) REFERENCES task_board (id)
    )
    ''')

    # Auto-migration: recurring task templates. A template auto-generates its task
    # instances over time (catch-up): on/after the gen_day (3rd) of each due month,
    # with due_date on the due_day (10th), keeping the same assignee.
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS recurring_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER,
        service_id INTEGER,
        financial_year TEXT,
        frequency TEXT,
        assigned_to INTEGER,
        estimated_minutes INTEGER,
        due_day INTEGER DEFAULT 10,
        gen_day INTEGER DEFAULT 3,
        active INTEGER DEFAULT 1,
        created_at TEXT,
        FOREIGN KEY (client_id) REFERENCES client_master (id),
        FOREIGN KEY (service_id) REFERENCES service_master (id)
    )
    ''')

    # Auto-migration: login sessions (who's online + daily logged-in time).
    # A heartbeat keeps last_seen fresh; a stale last_seen means the user closed
    # the app without logging out.
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS user_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        login_at TEXT,
        last_seen TEXT,
        logout_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users (id)
    )
    ''')

    # Auto-migration: individual timer run intervals (start/end timestamps per task
    # per user) — powers the per-task "time spent today" breakdown on the timesheet.
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS timer_intervals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        user_id INTEGER,
        started_at TEXT,
        ended_at TEXT,
        seconds INTEGER,
        FOREIGN KEY (task_id) REFERENCES task_board (id)
    )
    ''')

    # Auto-migration: who created a task (so we can tell when an assignee is the
    # creator -> "self-assigned"), and a lock flag that prevents the creator from
    # further edits while Admin/Partner/Manager can still change it any time.
    cursor.execute("PRAGMA table_info(task_board)")
    tb_cols_l = [row[1] for row in cursor.fetchall()]
    if 'created_by' not in tb_cols_l:
        cursor.execute("ALTER TABLE task_board ADD COLUMN created_by INTEGER")
    if 'locked' not in tb_cols_l:
        cursor.execute("ALTER TABLE task_board ADD COLUMN locked INTEGER DEFAULT 0")

    # Auto-migration: personal calendar events. Each row is private to its
    # owner — no sharing across users at this phase.
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS calendar_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        event_date TEXT,        -- YYYY-MM-DD
        start_time TEXT,        -- HH:MM (optional)
        end_time TEXT,          -- HH:MM (optional)
        title TEXT,
        notes TEXT,
        color TEXT,
        created_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users (id)
    )
    ''')

    # Auto-migration: in-app notifications (one row per recipient). type names
    # are free-form strings used for icon/text routing in the frontend.
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        type TEXT,
        message TEXT,
        task_id INTEGER,
        created_at TEXT,
        read_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users (id)
    )
    ''')

    # Auto-migration: user-facing display IDs for clients (#CL:N) and services
    # (#SER:N). The numeric PK stays the FK target; custom_id is just a label
    # that gets auto-assigned (next-after-max) on create and is editable later.
    cursor.execute("PRAGMA table_info(client_master)")
    cm_cols = [row[1] for row in cursor.fetchall()]
    if 'custom_id' not in cm_cols:
        cursor.execute("ALTER TABLE client_master ADD COLUMN custom_id TEXT")
        cursor.execute("SELECT id FROM client_master ORDER BY id")
        for i, r in enumerate(cursor.fetchall(), start=1):
            cursor.execute("UPDATE client_master SET custom_id = ? WHERE id = ?", (f'#CL:{i}', r[0]))

    cursor.execute("PRAGMA table_info(service_master)")
    sm_cols2 = [row[1] for row in cursor.fetchall()]
    if 'custom_id' not in sm_cols2:
        cursor.execute("ALTER TABLE service_master ADD COLUMN custom_id TEXT")
        cursor.execute("SELECT id FROM service_master ORDER BY id")
        for i, r in enumerate(cursor.fetchall(), start=1):
            cursor.execute("UPDATE service_master SET custom_id = ? WHERE id = ?", (f'#SER:{i}', r[0]))

    # Auto-migration: the user's filed timesheet for a day (date + optional notes).
    # submitted_at records WHEN it was filed, so late/early submissions can be flagged.
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS daily_timesheets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        log_date TEXT,
        description TEXT,
        submitted_at TEXT,
        UNIQUE(user_id, log_date),
        FOREIGN KEY (user_id) REFERENCES users (id)
    )
    ''')

    conn.commit()
    conn.close()

