const { createApp, ref, computed, onMounted, watch } = Vue;

createApp({
    setup() {
        const currentTab = ref('dashboard');
        
        // Workspace Collapsing State
        const isSidebarCollapsed = ref(false);

        // Theme Palette Configurations
        const currentPalette = ref('default');
        const showPaletteDropdown = ref(false);

        const palettes = {
            default: {
                name: "Monochrome (Default)",
                primary: "#1C1C1C",
                primaryHover: "#000000",
                primaryLight: "#EDEDED",
                accent: "#1C1C1C",
                accentHover: "#000000",
                accentLight: "#ECECEC",
                goingon: "#1C1C1C",
                completed: "#A8A8A8",
                stuck: "#707070"
            },
            corporate: {
                name: "Corporate Trust (ICAI)",
                primary: "#145886",
                primaryHover: "#0E3E60",
                primaryLight: "#F0F6FA",
                accent: "#F37920",
                accentHover: "#D96414",
                accentLight: "#FEF2E6",
                goingon: "#145886",
                completed: "#55B848",
                stuck: "#F37920"
            },
            modern: {
                name: "Modern Financial",
                primary: "#0F2C59",
                primaryHover: "#081B38",
                primaryLight: "#F0F3F7",
                accent: "#4F709C",
                accentHover: "#3E5C84",
                accentLight: "#F0F4F8",
                goingon: "#4F709C",
                completed: "#10B981",
                stuck: "#F5E98C"
            },
            premium: {
                name: "Premium Boutique",
                primary: "#212A3E",
                primaryHover: "#141B29",
                primaryLight: "#F5F6F8",
                accent: "#B89737",
                accentHover: "#9C7E2A",
                accentLight: "#FAF6EC",
                goingon: "#212A3E",
                completed: "#B89737",
                stuck: "#EF4444"
            }
        };

        const applyPalette = (key) => {
            const pal = palettes[key] || palettes.default;
            const root = document.documentElement;
            root.style.setProperty('--color-primary', pal.primary);
            root.style.setProperty('--color-primary-hover', pal.primaryHover);
            root.style.setProperty('--color-primary-light', pal.primaryLight);
            root.style.setProperty('--color-accent', pal.accent);
            root.style.setProperty('--color-accent-hover', pal.accentHover);
            root.style.setProperty('--color-accent-light', pal.accentLight);
            root.style.setProperty('--color-goingon', pal.goingon);
            root.style.setProperty('--color-completed', pal.completed);
            root.style.setProperty('--color-stuck', pal.stuck);
            currentPalette.value = key;
            localStorage.setItem('ca_palette', key);
        };

        const changePalette = (key) => {
            applyPalette(key);
            showPaletteDropdown.value = false;
        };

        // Single-tap light/dark mode toggle (persisted)
        const isDark = ref(false);
        const applyDark = (on) => {
            isDark.value = on;
            document.documentElement.classList.toggle('dark', on);
            localStorage.setItem('ca_dark', on ? '1' : '0');
        };
        const toggleDark = () => applyDark(!isDark.value);

        // Dynamic Access Control State
        const isLoggedIn = ref(false);
        const currentUser = ref({ id: 0, username: '', role: 'Employee', full_name: '', permissions: {} });
        const loginForm = ref({ username: '', password: '' });
        const loginError = ref('');

        // ===================== Roles & permissions (Phase A) =====================
        // Default capabilities per role — mirrors backend/permissions.py so the
        // permission-toggle UI can show effective values. The server is always the
        // source of truth and re-checks every action.
        const CAPABILITIES = [
            'create_task', 'assign_task', 'assign_self', 'delegate_task',
            'delete_task', 'delete_client', 'delete_user', 'manage_users',
            'manage_clients', 'manage_services', 'manage_billing', 'reset_timer'
        ];
        const CAPABILITY_LABELS = {
            create_task: 'Create tasks', assign_task: 'Assign tasks to others',
            assign_self: 'Assign tasks to themselves', delegate_task: 'Delegate tasks to others',
            delete_task: 'Delete tasks', delete_client: 'Delete clients',
            delete_user: 'Delete staff accounts', manage_users: 'Add / edit staff accounts',
            manage_clients: 'Create / edit clients', manage_services: 'Create / edit services',
            manage_billing: 'Manage billing (Billed / Received)', reset_timer: 'Reset task timers'
        };
        const allCaps = (v) => Object.fromEntries(CAPABILITIES.map(c => [c, v]));
        const ROLE_DEFAULTS = {
            Admin: allCaps(true),
            Partner: allCaps(true),
            Manager: { ...allCaps(false), create_task: true, assign_task: true, delegate_task: true },
            Employee: allCaps(false)
        };
        const effectivePermsFor = (role, overrides) => {
            if (role === 'Admin') return allCaps(true);
            const base = { ...(ROLE_DEFAULTS[role] || ROLE_DEFAULTS.Employee) };
            if (overrides && typeof overrides === 'object') {
                for (const k of CAPABILITIES) if (k in overrides) base[k] = !!overrides[k];
            }
            return base;
        };

        // What the logged-in user can DO
        const can = (cap) => !!(currentUser.value.permissions && currentUser.value.permissions[cap]);
        const isAdminOrPartner = computed(() => ['Admin', 'Partner'].includes(currentUser.value.role));
        const canSeeAll = computed(() => isAdminOrPartner.value);

        // What the logged-in user can SEE (scoped by role)
        const taskVisible = (t) => {
            if (canSeeAll.value) return true;
            const me = currentUser.value.id;
            if (currentUser.value.role === 'Manager') {
                if (t.assigned_to === me || t.delegated_to === me) return true;
                if (!t.assigned_to) return true; // unassigned: managers can pick up / assign
                const assignee = usersList.value.find(u => u.id === t.assigned_to);
                return assignee && assignee.role === 'Employee';
            }
            return t.assigned_to === me || t.delegated_to === me; // Employee
        };
        const visibleTasks = computed(() => tasks.value.filter(taskVisible));

        // User-facing task serial: "FY25-26: 1" (per-financial-year number, resets each FY).
        const taskSerial = (task) => {
            if (!task || !task.task_no) return '';
            const fy = task.financial_year ? task.financial_year.slice(2) : '';
            return fy ? `FY${fy}#${task.task_no}` : `#${task.task_no}`;
        };

        // Billing pipeline: a task with a billing_stage has left the active board
        // and lives in the Billed / Received Fees sections instead.
        const isBilling = (t) => t.billing_stage === 'Billed' || t.billing_stage === 'Received';
        const activeTasks = computed(() => visibleTasks.value.filter(t => !isBilling(t)));
        const billedTasks = computed(() => tasks.value.filter(t => t.billing_stage === 'Billed'));
        const receivedTasks = computed(() => tasks.value.filter(t => t.billing_stage === 'Received'));

        // Reactive Data Store
        const tasks = ref([]);
        const clients = ref([]);
        const services = ref([]);
        const usersList = ref([]);
        const clientGroups = ref([]);
        const timesheets = ref([]);

        // Search & Filters
        const taskSearch = ref('');
        const taskStatusFilter = ref('All');
        const clientSearch = ref('');

        // Client List Pagination
        const clientPage = ref(1);
        const clientsPerPage = ref(5);

        // Modals & Panels Visibility
        const showTaskModal = ref(false);
        const showClientModal = ref(false);
        const showUserModal = ref(false);
        const showServiceModal = ref(false);
        const showBulkEngine = ref(false);
        const vaultClientObj = ref(null); // Embedded vault for a specific client
        const contactClientObj = ref(null); // Embedded contacts drawer

        // Global Editing IDs
        const editingTaskId = ref(null);
        const editingClientId = ref(null);
        const editingUserId = ref(null);
        const editingServiceId = ref(null);

        // Inline Password Vault Editing & Reveal States
        const decryptedPasswords = ref({}); // Maps credId -> decrypted plain password
        const editingCredId = ref(null);
        const editingPassword = ref('');

        // Client Contacts List
        const contactsList = ref([]);
        const contactForm = ref({
            name: '',
            designation: 'Accountant',
            email: '',
            mobile: ''
        });

        const activeDashboardFilter = ref('All');

        const setDashboardFilter = (filterVal) => {
            if (activeDashboardFilter.value === filterVal) {
                activeDashboardFilter.value = 'All';
            } else {
                activeDashboardFilter.value = filterVal;
            }
        };

        // Form Templates (Default status: 'Working')
        const taskForm = ref({
            client_id: '',
            service_id: '',
            financial_year: '2025-26',
            period: '',
            status: 'Working',
            assigned_to: '',
            recurrence_type: 'one_time',
            due_date: '',
            est_hours: 0,
            est_minutes: 0
        });

        const clientForm = ref({
            name: '',
            group_id: '',
            new_group_name: '',
            entity_type: 'Proprietor',
            pan: '',
            gstin: '',
            physical_folder_location: '',
            data_location: '',
            assigned_to: ''
        });

        const userForm = ref({
            username: '',
            password: '',
            role: 'Employee',
            full_name: '',
            permissions: { ...ROLE_DEFAULTS.Employee }
        });

        // Roles the current user is allowed to assign to others (no new Admins).
        const assignableRoles = computed(() => {
            if (currentUser.value.role === 'Admin') return ['Partner', 'Manager', 'Employee'];
            if (currentUser.value.role === 'Partner') return ['Manager', 'Employee'];
            return ['Employee'];
        });
        // When the role changes in the form, reset toggles to that role's defaults.
        const onUserRoleChange = () => {
            userForm.value.permissions = { ...(ROLE_DEFAULTS[userForm.value.role] || ROLE_DEFAULTS.Employee) };
        };

        const serviceForm = ref({
            name: '',
            description: '',
            checklist_raw: '',
            default_due_day: 15
        });

        const today = new Date().toISOString().split('T')[0];
        const tsForm = ref({
            task_id: '',
            employee_name: '',
            hours: 0,
            minutes: 0,
            log_date: today,
            description: ''
        });

        const bulkForm = ref({
            service_id: '',
            financial_year: '2025-26',
            period: ''
        });
        const bulkMessage = ref('');

        const credForm = ref({
            portal_name: '',
            password: ''
        });
        const vaultCredentials = ref([]);

        // Watch clientSearch to reset pagination page to 1
        watch(clientSearch, () => {
            clientPage.value = 1;
        });

        // Watch taskForm.value.service_id to auto-populate default due date
        watch(() => taskForm.value.service_id, (newServiceId) => {
            if (newServiceId && !editingTaskId.value) {
                const srv = services.value.find(s => s.id === newServiceId);
                const defaultDueDay = srv ? (srv.default_due_day || 15) : 15;
                const now = new Date();
                const year = now.getFullYear();
                const month = String(now.getMonth() + 1).padStart(2, '0');
                const day = String(defaultDueDay).padStart(2, '0');
                taskForm.value.due_date = `${year}-${month}-${day}`;
            }
        });

        // Tab Title Dynamic Computation
        const tabTitle = computed(() => {
            const titles = {
                'dashboard': 'Office Dashboard',
                'tasks': 'Task Management Board',
                'clients': 'Client Master Directory',
                'services': 'Compliance Services Catalog',
                'users': 'Staff Personnel Directory',
                'timesheet': 'Operational Time Logs',
                'reports': 'EasiBusiness Performance Reports',
                'activity': 'Personnel Activity Log',
                'billed': 'Billed',
                'received': 'Received Fees'
            };
            return titles[currentTab.value] || 'EasiOffice';
        });

        // Dashboard Stat Summary: dynamically calculates counts strictly for the logged-in staff's tasks (or all for Admin)
        const counts = computed(() => {
            let goingOn = 0, stuck = 0, completed = 0, unassigned = 0;
            const relevantTasks = activeTasks.value;
            relevantTasks.forEach(t => {
                if (!t.assigned_to || String(t.assigned_to).trim() === "") {
                    unassigned++;
                } else {
                    if (t.status === 'Working') goingOn++;
                    if (t.status === 'Pending') stuck++;
                    if (t.status === 'Completed') completed++;
                }
            });
            return { goingOn, stuck, completed, unassigned };
        });

        // ===================== New Dashboard: summary cards -> tasks by user =====================
        const dashCard = ref(null);   // null | 'Unassigned' | 'Pending' | 'Working' | 'Completed'
        const setDashCard = (key) => { dashCard.value = dashCard.value === key ? null : key; };
        const dashTasksByUser = computed(() => {
            if (!dashCard.value) return [];
            let list;
            if (dashCard.value === 'Unassigned') list = activeTasks.value.filter(t => !t.assigned_to);
            else list = activeTasks.value.filter(t => t.assigned_to && t.status === dashCard.value);
            const map = {};
            list.forEach(t => {
                const name = t.assigned_to_name || 'Unassigned';
                (map[name] = map[name] || []).push(t);
            });
            return Object.entries(map).map(([name, tasks]) => ({ name, tasks })).sort((a, b) => b.tasks.length - a.tasks.length);
        });

        // Computed Filters for Dashboard strictly reflecting active card selection
        const filteredDashboardTasks = computed(() => {
            let list = activeTasks.value;
            if (activeDashboardFilter.value === 'Unassigned') {
                list = list.filter(t => !t.assigned_to || String(t.assigned_to).trim() === "");
            } else if (activeDashboardFilter.value === 'Working') {
                list = list.filter(t => t.assigned_to && t.status === 'Working');
            } else if (activeDashboardFilter.value === 'Pending') {
                list = list.filter(t => t.assigned_to && t.status === 'Pending');
            } else if (activeDashboardFilter.value === 'Completed') {
                list = list.filter(t => t.assigned_to && t.status === 'Completed');
            }
            return list;
        });

        // ===================== Dashboard Kanban Board =====================
        // A task's column is its assignment state first (Unassigned wins), then status.
        const columnKeyOf = (t) => {
            if (!t.assigned_to || String(t.assigned_to).trim() === '') return 'Unassigned';
            return t.status; // 'Working' | 'Pending' | 'Completed'
        };

        const boardColumns = computed(() => {
            const showUnassigned = canSeeAll.value || can('assign_task');
            const q = taskSearch.value.trim().toLowerCase();
            let list = activeTasks.value;
            if (q) list = list.filter(t => (t.client_name || '').toLowerCase().includes(q) || (t.service_name || '').toLowerCase().includes(q));

            const cols = [];
            if (showUnassigned) cols.push({ key: 'Unassigned', label: 'Unassigned', icon: 'fa-user-slash', accent: '#8E8E93' });
            cols.push({ key: 'Pending', label: 'Pending', icon: 'fa-clock', accent: 'var(--color-stuck)' });
            cols.push({ key: 'Working', label: 'Working', icon: 'fa-bolt', accent: 'var(--color-goingon)' });
            cols.push({ key: 'Completed', label: 'Completed', icon: 'fa-circle-check', accent: 'var(--color-completed)' });
            cols.forEach(c => c.tasks = []);

            const byKey = Object.fromEntries(cols.map(c => [c.key, c]));
            list.forEach(t => {
                const target = byKey[columnKeyOf(t)] || byKey['Working'];
                if (target) target.tasks.push(t);
            });
            return cols;
        });

        // Native HTML5 drag & drop state
        const draggedTaskId = ref(null);
        const dragOverColumn = ref(null);

        const onTaskDragStart = (task, ev) => {
            draggedTaskId.value = task.id;
            if (ev && ev.dataTransfer) {
                ev.dataTransfer.effectAllowed = 'move';
                try { ev.dataTransfer.setData('text/plain', String(task.id)); } catch (e) {}
            }
        };
        const onTaskDragEnd = () => { draggedTaskId.value = null; dragOverColumn.value = null; };
        const onColumnDragOver = (colKey) => { dragOverColumn.value = colKey; };
        const onColumnDragLeave = (colKey) => { if (dragOverColumn.value === colKey) dragOverColumn.value = null; };

        const onColumnDrop = async (colKey) => {
            const id = draggedTaskId.value;
            dragOverColumn.value = null;
            draggedTaskId.value = null;
            if (id == null) return;
            const task = tasks.value.find(t => t.id === id);
            if (!task) return;
            if (columnKeyOf(task) === colKey) return;

            if (colKey === 'Unassigned') {
                await assignTask(task, null);
                return;
            }
            // Dropping into a status column
            if (!task.assigned_to || String(task.assigned_to).trim() === '') {
                openAssignModal(task, colKey);   // must pick an assignee first
            } else {
                await updateTaskStatus(task.id, colKey);
            }
        };

        // Assignment modal (used by drag-from-Unassigned and explicit assign)
        const showAssignModal = ref(false);
        const assignTargetTask = ref(null);
        const assignTargetStatus = ref(null);
        const assignSelectedUser = ref('');

        const openAssignModal = (task, status = null) => {
            assignTargetTask.value = task;
            assignTargetStatus.value = status;
            assignSelectedUser.value = task.assigned_to || '';
            showAssignModal.value = true;
        };
        const closeAssignModal = () => {
            showAssignModal.value = false;
            assignTargetTask.value = null;
            assignTargetStatus.value = null;
            assignSelectedUser.value = '';
        };
        const confirmAssignModal = async () => {
            if (!assignTargetTask.value || !assignSelectedUser.value) return;
            await assignTask(assignTargetTask.value, assignSelectedUser.value, assignTargetStatus.value);
            closeAssignModal();
        };

        // Assign (or unassign with userId=null) a task; optionally also set a new status.
        const assignTask = async (task, userId, newStatus = null) => {
            const uid = userId || null;
            try {
                const res = await apiFetch(`/api/tasks/${task.id}/assign`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user_id: uid })
                });
                if (res.ok) {
                    task.assigned_to = uid;
                    const u = usersList.value.find(x => x.id === uid);
                    task.assigned_to_name = u ? u.full_name : null;
                    if (newStatus && task.status !== newStatus) {
                        await updateTaskStatus(task.id, newStatus);
                    }
                }
            } catch (e) {
                console.error('Error assigning task:', e);
            }
        };

        // Computed Filters for Lists: enforces access control visibility rules
        const filteredTasks = computed(() => {
            let list = activeTasks.value;
            return list.filter(t => {
                const search = taskSearch.value.toLowerCase();
                const matchSearch = !taskSearch.value || 
                    t.client_name.toLowerCase().includes(search) || 
                    t.service_name.toLowerCase().includes(search);
                const matchStatus = taskStatusFilter.value === 'All' || t.status === taskStatusFilter.value;
                return matchSearch && matchStatus;
            });
        });

        const filteredClients = computed(() => {
            let list = clients.value;
            if (!canSeeAll.value) {
                // Visible if the user can see a task for the client, or the client is assigned to them
                const visibleClientIds = new Set(visibleTasks.value.map(t => t.client_id));
                list = clients.value.filter(c => visibleClientIds.has(c.id) || c.assigned_to === currentUser.value.id);
            }
            if (!clientSearch.value) return list;
            const search = clientSearch.value.toLowerCase();
            return list.filter(c => {
                return c.name.toLowerCase().includes(search) || 
                       (c.group_name && c.group_name.toLowerCase().includes(search)) || 
                       c.pan.toLowerCase().includes(search) || 
                       (c.gstin && c.gstin.toLowerCase().includes(search));
            });
        });

        // Client pagination slices
        const paginatedClients = computed(() => {
            const start = (clientPage.value - 1) * clientsPerPage.value;
            const end = start + clientsPerPage.value;
            return filteredClients.value.slice(start, end);
        });

        const totalClientPages = computed(() => {
            return Math.ceil(filteredClients.value.length / clientsPerPage.value) || 1;
        });

        // Contact Directory Filters: Accountant-Only visibility filters for Employees
        const filteredContactsList = computed(() => {
            if (canSeeAll.value) {
                return contactsList.value;
            } else {
                return contactsList.value.filter(c => c.designation.toLowerCase() === 'accountant');
            }
        });

        const filteredTimesheets = computed(() => {
            if (canSeeAll.value) {
                return timesheets.value;
            } else {
                return timesheets.value.filter(ts => ts.employee_name === currentUser.value.full_name);
            }
        });

        // Authenticated fetch wrapper. Identity now comes from the server-side
        // session cookie (sent automatically for same-origin requests) — NOT from
        // client-supplied headers, which could be spoofed.
        const apiFetch = async (url, options = {}) => {
            const res = await fetch(url, { credentials: 'same-origin', ...options });
            // Session expired or invalid: fall back to the login screen.
            if (res.status === 401 && isLoggedIn.value) {
                forceLogoutLocal();
            }
            return res;
        };

        // Clears client-side auth state without calling the server (used when the
        // server has already rejected the session).
        const forceLogoutLocal = () => {
            isLoggedIn.value = false;
            currentUser.value = { id: 0, username: '', role: 'Employee', full_name: '' };
            tasks.value = [];
            clients.value = [];
            currentTab.value = 'dashboard';
        };

        const activityLogs = ref([]);
        const logSearch = ref('');

        const filteredLogs = computed(() => {
            if (!logSearch.value) return activityLogs.value;
            const search = logSearch.value.toLowerCase();
            return activityLogs.value.filter(log => {
                return (log.username && log.username.toLowerCase().includes(search)) ||
                       (log.action && log.action.toLowerCase().includes(search)) ||
                       (log.details && log.details.toLowerCase().includes(search)) ||
                       (log.timestamp && log.timestamp.toLowerCase().includes(search));
            });
        });

        // Core API Fetch
        const fetchData = async () => {
            try {
                const [tasksRes, clientsRes, servicesRes, usersRes, groupsRes, timesheetsRes, logsRes] = await Promise.all([
                    apiFetch('/api/tasks'),
                    apiFetch('/api/clients'),
                    apiFetch('/api/services'),
                    apiFetch('/api/users'),
                    apiFetch('/api/client-groups'),
                    apiFetch('/api/timesheets'),
                    apiFetch('/api/activity-logs')
                ]);
                
                tasks.value = await tasksRes.json();
                clients.value = await clientsRes.json();
                services.value = await servicesRes.json();
                usersList.value = await usersRes.json();
                clientGroups.value = await groupsRes.json();
                timesheets.value = await timesheetsRes.json();
                activityLogs.value = await logsRes.json();
                await fetchTimers();
                await fetchPresence();
            } catch (error) {
                console.error("Error loading firm data:", error);
            }
        };

        // ===================== Presence (who's online / working) =====================
        const presence = ref([]);
        const fetchPresence = async () => {
            try {
                const res = await apiFetch('/api/presence');
                if (res.ok) presence.value = await res.json();
            } catch (e) { /* ignore */ }
        };
        const sendHeartbeat = async () => {
            if (!isLoggedIn.value) return;
            try { await apiFetch('/api/heartbeat', { method: 'POST' }); } catch (e) { /* ignore */ }
        };
        const onlineUsers = computed(() => presence.value.filter(p => p.online));

        // Authentication Handlers
        const handleLogin = async () => {
            loginError.value = '';
            try {
                const res = await apiFetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(loginForm.value)
                });
                
                if (res.ok) {
                    const data = await res.json();
                    currentUser.value = data.user;
                    isLoggedIn.value = true;
                    loginForm.value = { username: '', password: '' };
                    await fetchData();
                    currentTab.value = 'dashboard';
                } else {
                    const data = await res.json();
                    loginError.value = data.message || "Failed to authenticate.";
                }
            } catch (error) {
                console.error("Login error:", error);
                loginError.value = "Server authentication offline.";
            }
        };

        const handleLogout = async () => {
            try {
                await apiFetch('/api/logout', { method: 'POST' });
            } catch (e) {
                // ignore network errors on logout
            }
            forceLogoutLocal();
            loginError.value = '';
        };

        // Tasks API Actions (Working & Pending Status updates)
        const updateTaskStatus = async (taskId, newStatus) => {
            try {
                await apiFetch(`/api/tasks/${taskId}/status?status=${encodeURIComponent(newStatus)}`, {
                    method: 'PUT'
                });
                const t = tasks.value.find(x => x.id === taskId);
                if (t) t.status = newStatus;
                // On completion: bank the timer, then auto-fill time + date from it.
                // The user only adds an optional description before logging.
                if (newStatus === 'Completed' && t) {
                    if (isTaskRunning(t.id)) { await pauseTaskTimer(t); }
                    launchConfetti();
                    prefillCompletionLog(t);
                    showCompletionModal.value = true;
                }
            } catch (error) {
                console.error("Error updating status:", error);
            }
        };

        // Edit pre-fill tasks modal
        const startEditTask = (taskObj) => {
            editingTaskId.value = taskObj.id;
            const est = taskObj.estimated_minutes || 0;
            taskForm.value = {
                client_id: taskObj.client_id,
                service_id: taskObj.service_id,
                financial_year: taskObj.financial_year,
                period: taskObj.period,
                status: taskObj.status,
                assigned_to: taskObj.assigned_to || '',
                recurrence_type: 'one_time',
                due_date: taskObj.due_date || '',
                est_hours: Math.floor(est / 60),
                est_minutes: est % 60
            };
            showTaskModal.value = true;
        };

        const closeTaskModal = () => {
            editingTaskId.value = null;
            taskForm.value = { client_id: '', service_id: '', financial_year: '2025-26', period: '', status: 'Working', assigned_to: '', recurrence_type: 'one_time', due_date: '', est_hours: 0, est_minutes: 0 };
            showTaskModal.value = false;
        };

        const submitTaskForm = async () => {
            try {
                const method = editingTaskId.value ? 'PUT' : 'POST';
                const url = editingTaskId.value ? `/api/tasks/${editingTaskId.value}` : '/api/tasks';
                const estimated_minutes = (Number(taskForm.value.est_hours) || 0) * 60 + (Number(taskForm.value.est_minutes) || 0);
                const payload = { ...taskForm.value, estimated_minutes };
                const res = await apiFetch(url, {
                    method: method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (res.ok) {
                    closeTaskModal();
                    await fetchData();
                } else {
                    const err = await res.json().catch(() => ({}));
                    alert(err.message || "Could not save the task. Please check the fields and try again.");
                }
            } catch (error) {
                console.error("Error saving task details:", error);
                alert("Could not save the task. Please try again.");
            }
        };

        const generateBulkTasks = async () => {
            try {
                const res = await apiFetch('/api/tasks/bulk', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(bulkForm.value)
                });
                const data = await res.json();
                bulkMessage.value = `Successfully created ${data.created} compliance tasks!`;
                await fetchData();
                
                setTimeout(() => {
                    bulkMessage.value = '';
                    bulkForm.value = { service_id: '', financial_year: '2025-26', period: '' };
                }, 3000);
            } catch (error) {
                console.error("Error bulk generating:", error);
                bulkMessage.value = "Error generating compliance tasks.";
            }
        };

        // ===================== Recurring templates =====================
        const showRecurringModal = ref(false);
        const recurringTemplates = ref([]);
        const fetchRecurringTemplates = async () => {
            try {
                const res = await apiFetch('/api/recurring');
                if (res.ok) recurringTemplates.value = await res.json();
            } catch (e) { console.error('fetch recurring', e); }
        };
        const openRecurringModal = async () => { await fetchRecurringTemplates(); showRecurringModal.value = true; };
        const closeRecurringModal = () => { showRecurringModal.value = false; };
        const updateRecurringTpl = async (tpl, fields) => {
            try {
                const res = await apiFetch(`/api/recurring/${tpl.id}`, {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields)
                });
                if (res.ok) { await fetchRecurringTemplates(); await fetchData(); }
                else { const e = await res.json().catch(() => ({})); alert(e.message || 'Could not update template.'); }
            } catch (e) { console.error('update recurring', e); }
        };
        const freqLabel = (f) => ({ monthly: 'Monthly', quarterly: 'Quarterly', six_monthly: 'Six-monthly', annual: 'Annual' }[f] || f);

        // Delegate a task (Manager -> Employee). assigned_to stays the Manager.
        const delegateTask = async (task, userId) => {
            try {
                const res = await apiFetch(`/api/tasks/${task.id}/delegate`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user_id: userId || null })
                });
                if (res.ok) {
                    await fetchData();
                } else {
                    const err = await res.json().catch(() => ({}));
                    alert(err.message || 'Could not delegate task.');
                }
            } catch (e) { console.error('Delegate error', e); }
        };

        // Delete a task (admin/partner / delete_task permission).
        const deleteTask = async (task) => {
            if (!confirm(`Delete the task "${task.client_name} · ${task.service_name}" (${task.period})? This cannot be undone.`)) return;
            try {
                const res = await apiFetch(`/api/tasks/${task.id}`, { method: 'DELETE' });
                if (res.ok) {
                    await fetchData();
                } else {
                    const err = await res.json().catch(() => ({}));
                    alert(err.message || 'Could not delete task.');
                }
            } catch (e) { console.error('Delete task error', e); }
        };

        // Delete a client (admin/partner / delete_client permission). Backend enforces
        // the "no open tasks" rule and returns a clear message if not allowed.
        const deleteClient = async (client) => {
            if (!confirm(`Delete client "${client.name}"? This also removes its contacts and stored credentials. This cannot be undone.`)) return;
            try {
                const res = await apiFetch(`/api/clients/${client.id}`, { method: 'DELETE' });
                const data = await res.json().catch(() => ({}));
                if (res.ok) {
                    await fetchData();
                } else {
                    alert(data.message || 'Could not delete client.');
                }
            } catch (e) { console.error('Delete client error', e); }
        };

        // ===================== Billing pipeline =====================
        const fmtMoney = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const showBillingModal = ref(false);
        const billingTask = ref(null);
        const billingDecision = ref('');     // '' | 'Yes' | 'No'
        const billedAmount = ref('');
        const gstAmount = ref('');
        const billingBusy = ref(false);
        const billingError = ref('');
        const billingTotal = computed(() => (parseFloat(billedAmount.value) || 0) + (parseFloat(gstAmount.value) || 0));
        const billingReady = computed(() => billingDecision.value === 'Yes' && parseFloat(billedAmount.value) > 0);

        const openBillingModal = (task) => {
            billingTask.value = task;
            billingDecision.value = '';
            billedAmount.value = '';
            gstAmount.value = '';
            billingError.value = '';
            showBillingModal.value = true;
        };
        const closeBillingModal = () => { showBillingModal.value = false; billingTask.value = null; };

        const confirmBilling = async () => {
            if (!billingReady.value) return;
            billingBusy.value = true; billingError.value = '';
            try {
                const res = await apiFetch(`/api/tasks/${billingTask.value.id}/billing`, {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'bill', billed_amount: parseFloat(billedAmount.value), gst_amount: parseFloat(gstAmount.value) || 0 })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) { billingError.value = data.message || 'Could not bill this task.'; return; }
                showBillingModal.value = false; billingTask.value = null;
                await fetchData();
            } catch (e) {
                console.error('Billing error', e);
                billingError.value = 'Could not bill this task. Please try again.';
            } finally { billingBusy.value = false; }
        };

        const billingAction = async (task, action) => {
            try {
                const res = await apiFetch(`/api/tasks/${task.id}/billing`, {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action })
                });
                if (res.ok) { await fetchData(); }
                else { const err = await res.json().catch(() => ({})); alert(err.message || 'Action failed.'); }
            } catch (e) { console.error('Billing action error', e); }
        };
        const markReceived = (task) => billingAction(task, 'receive');
        const moveBackToBilled = (task) => billingAction(task, 'unreceive');
        const moveBackToCompleted = (task) => { if (confirm('Move this task back to Completed (remove it from Billed)?')) billingAction(task, 'unbill'); };

        const sumBilling = (list) => {
            let billed = 0, gst = 0, total = 0;
            list.forEach(t => { billed += t.billed_amount || 0; gst += t.gst_amount || 0; total += t.total_amount || 0; });
            return { billed, gst, total, count: list.length };
        };
        const billedTotals = computed(() => sumBilling(billedTasks.value));
        const receivedTotals = computed(() => sumBilling(receivedTasks.value));

        // Clients API Actions (with edits support)
        const startEditClient = (clientObj) => {
            editingClientId.value = clientObj.id;
            clientForm.value = {
                name: clientObj.name,
                group_id: clientObj.group_id || '',
                new_group_name: '',
                entity_type: clientObj.entity_type,
                pan: clientObj.pan,
                gstin: clientObj.gstin || '',
                physical_folder_location: clientObj.physical_folder_location,
                data_location: clientObj.data_location || '',
                assigned_to: clientObj.assigned_to || ''
            };
            showClientModal.value = true;
        };

        const closeClientModal = () => {
            editingClientId.value = null;
            clientForm.value = { name: '', group_id: '', new_group_name: '', entity_type: 'Proprietor', pan: '', gstin: '', physical_folder_location: '', data_location: '', assigned_to: '' };
            showClientModal.value = false;
        };

        const submitClientForm = async () => {
            try {
                const method = editingClientId.value ? 'PUT' : 'POST';
                const url = editingClientId.value ? `/api/clients/${editingClientId.value}` : '/api/clients';
                const res = await apiFetch(url, {
                    method: method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(clientForm.value)
                });
                if (res.ok) {
                    closeClientModal();
                    await fetchData();
                }
            } catch (error) {
                console.error("Error saving client master:", error);
            }
        };

        // Admin: assign / reassign a client to a staff user (inline dropdown)
        const assignClient = async (client) => {
            try {
                const res = await apiFetch(`/api/clients/${client.id}/assign`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user_id: client.assigned_to || null })
                });
                if (res.ok) {
                    const u = usersList.value.find(x => x.id === client.assigned_to);
                    client.assigned_to_name = u ? u.full_name : null;
                }
            } catch (error) {
                console.error("Error assigning client:", error);
            }
        };

        // Users API Actions (with edits support)
        const openUserModal = () => {
            editingUserId.value = null;
            const defaultRole = assignableRoles.value.includes('Employee') ? 'Employee' : assignableRoles.value[0];
            userForm.value = { username: '', password: '', role: defaultRole, full_name: '',
                               permissions: { ...(ROLE_DEFAULTS[defaultRole] || ROLE_DEFAULTS.Employee) } };
            showUserModal.value = true;
        };

        const startEditUser = (userObj) => {
            editingUserId.value = userObj.id;
            let overrides = {};
            try { overrides = userObj.permissions ? JSON.parse(userObj.permissions) : {}; } catch (e) { overrides = {}; }
            userForm.value = {
                username: userObj.username,
                password: '', // leave empty to not change password
                role: userObj.role,
                full_name: userObj.full_name,
                permissions: effectivePermsFor(userObj.role, overrides)
            };
            showUserModal.value = true;
        };

        const closeUserModal = () => {
            editingUserId.value = null;
            userForm.value = { username: '', password: '', role: 'Employee', full_name: '', permissions: { ...ROLE_DEFAULTS.Employee } };
            showUserModal.value = false;
        };

        // Whether the editing form may change role/permissions (Admin/Partner only,
        // and never for the seeded primary admin account).
        const editingPrimaryAdmin = computed(() =>
            editingUserId.value && (usersList.value.find(u => u.id === editingUserId.value) || {}).username === 'admin');
        const canEditRolePerms = computed(() => isAdminOrPartner.value && !editingPrimaryAdmin.value);

        const submitUserForm = async () => {
            try {
                const method = editingUserId.value ? 'PUT' : 'POST';
                const url = editingUserId.value ? `/api/users/${editingUserId.value}` : '/api/users';
                const res = await apiFetch(url, {
                    method: method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(userForm.value)
                });
                if (res.ok) {
                    closeUserModal();
                    await fetchData();
                }
            } catch (error) {
                console.error("Error saving user details:", error);
            }
        };

        // Delete a user — but first require every task assigned/delegated to them
        // to be reassigned to someone else.
        const showDeleteUserModal = ref(false);
        const deleteUserTarget = ref(null);
        const deleteReassignTo = ref('');
        const deleteUserBusy = ref(false);
        const deleteUserError = ref('');

        const deleteUserTaskCount = computed(() => {
            if (!deleteUserTarget.value) return 0;
            const id = deleteUserTarget.value.id;
            return tasks.value.filter(t => t.assigned_to === id || t.delegated_to === id).length;
        });
        const reassignCandidates = computed(() => {
            const id = deleteUserTarget.value ? deleteUserTarget.value.id : null;
            return usersList.value.filter(u => u.id !== id);
        });

        const openDeleteUser = (userObj) => {
            if (userObj.username === 'admin') { alert('The primary administrator cannot be deleted.'); return; }
            if (userObj.id === currentUser.value.id) { alert('You cannot delete your own account.'); return; }
            deleteUserTarget.value = userObj;
            deleteReassignTo.value = '';
            deleteUserError.value = '';
            showDeleteUserModal.value = true;
        };
        const closeDeleteUser = () => { showDeleteUserModal.value = false; deleteUserTarget.value = null; };

        const confirmDeleteUser = async () => {
            if (deleteUserTaskCount.value > 0 && !deleteReassignTo.value) {
                deleteUserError.value = 'Pick someone to reassign this person’s tasks to first.';
                return;
            }
            deleteUserBusy.value = true; deleteUserError.value = '';
            try {
                const body = deleteReassignTo.value ? { reassign_to: Number(deleteReassignTo.value) } : {};
                const res = await apiFetch(`/api/users/${deleteUserTarget.value.id}`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) { deleteUserError.value = data.message || 'Could not delete user.'; return; }
                showDeleteUserModal.value = false;
                deleteUserTarget.value = null;
                await fetchData();
            } catch (error) {
                console.error('Error deleting user:', error);
                deleteUserError.value = 'Could not delete user. Please try again.';
            } finally {
                deleteUserBusy.value = false;
            }
        };

        // Services Catalog API Actions (with edits support)
        const startEditService = (serviceObj) => {
            editingServiceId.value = serviceObj.id;
            const steps = parseChecklist(serviceObj.checklist_json);
            serviceForm.value = {
                name: serviceObj.name,
                description: serviceObj.description,
                checklist_raw: steps.join(', '),
                default_due_day: serviceObj.default_due_day || 15
            };
            showServiceModal.value = true;
        };

        const closeServiceModal = () => {
            editingServiceId.value = null;
            serviceForm.value = { name: '', description: '', checklist_raw: '', default_due_day: 15 };
            showServiceModal.value = false;
        };

        const submitServiceForm = async () => {
            try {
                const method = editingServiceId.value ? 'PUT' : 'POST';
                const url = editingServiceId.value ? `/api/services/${editingServiceId.value}` : '/api/services';
                const res = await apiFetch(url, {
                    method: method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(serviceForm.value)
                });
                if (res.ok) {
                    closeServiceModal();
                    await fetchData();
                }
            } catch (error) {
                console.error("Error saving service catalog template:", error);
            }
        };

        const parseChecklist = (jsonStr) => {
            try {
                return JSON.parse(jsonStr) || [];
            } catch (e) {
                return [];
            }
        };

        // ===================== Timesheet: file + daily report =====================
        const tsFileDate = ref(today);
        const tsFileDesc = ref('');
        const tsFiling = ref(false);
        const tsFileMsg = ref('');
        const fileTimesheet2 = async () => {
            if (!tsFileDate.value) return;
            tsFiling.value = true; tsFileMsg.value = '';
            try {
                const res = await apiFetch('/api/daily-timesheet', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ log_date: tsFileDate.value, description: tsFileDesc.value })
                });
                if (res.ok) { tsFileMsg.value = 'Timesheet filed.'; tsFileDesc.value = ''; await fetchTsReport(); setTimeout(() => tsFileMsg.value = '', 3000); }
                else { const e = await res.json().catch(() => ({})); tsFileMsg.value = e.message || 'Could not file timesheet.'; }
            } catch (e) { tsFileMsg.value = 'Could not file timesheet.'; }
            finally { tsFiling.value = false; }
        };

        // Report controls
        const tsPeriod = ref('range');   // range | weekly | monthly | quarterly | halfyearly | yearly
        const tsFrom = ref(today);
        const tsTo = ref(today);
        const tsWeekDate = ref(today);
        const tsMonth = ref(today.slice(0, 7));
        const tsMonthCount = ref(1);
        const tsYear = ref(String(new Date().getFullYear()));
        const tsYearCount = ref(1);
        const tsQuarter = ref('Q' + (Math.floor(new Date().getMonth() / 3) + 1));
        const tsHalf = ref(new Date().getMonth() < 6 ? 'H1' : 'H2');
        const tsReportUser = ref('all');
        const tsReport = ref([]);
        const canPickUser = computed(() => isAdminOrPartner.value || currentUser.value.role === 'Manager');

        const _pad = (n) => String(n).padStart(2, '0');
        const _iso = (y, m, d) => `${y}-${_pad(m)}-${_pad(d)}`;
        const _lastDay = (y, m) => new Date(y, m, 0).getDate();
        const tsRange = computed(() => {
            const p = tsPeriod.value;
            if (p === 'weekly') {
                const a = new Date(tsWeekDate.value + 'T00:00:00');
                const dow = (a.getDay() + 6) % 7;
                const mon = new Date(a); mon.setDate(a.getDate() - dow);
                const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
                const f = (d) => _iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
                return { from: f(mon), to: f(sun) };
            }
            if (p === 'monthly') {
                const [y, m] = tsMonth.value.split('-').map(Number);
                const count = Math.max(1, Number(tsMonthCount.value) || 1);
                let sy = y, sm = m - (count - 1); while (sm < 1) { sm += 12; sy--; }
                return { from: _iso(sy, sm, 1), to: _iso(y, m, _lastDay(y, m)) };
            }
            if (p === 'quarterly') {
                const y = Number(tsYear.value); const q = Number(tsQuarter.value.slice(1));
                const sm = (q - 1) * 3 + 1; const em = sm + 2;
                return { from: _iso(y, sm, 1), to: _iso(y, em, _lastDay(y, em)) };
            }
            if (p === 'halfyearly') {
                const y = Number(tsYear.value); const h = Number(tsHalf.value.slice(1));
                const sm = h === 1 ? 1 : 7; const em = h === 1 ? 6 : 12;
                return { from: _iso(y, sm, 1), to: _iso(y, em, _lastDay(y, em)) };
            }
            if (p === 'yearly') {
                const y = Number(tsYear.value); const count = Math.max(1, Number(tsYearCount.value) || 1);
                return { from: _iso(y - (count - 1), 1, 1), to: _iso(y, 12, 31) };
            }
            return { from: tsFrom.value, to: tsTo.value };
        });

        const fetchTsReport = async () => {
            const { from, to } = tsRange.value;
            if (!from || !to) return;
            let url = `/api/timesheet-report?from=${from}&to=${to}`;
            if (canPickUser.value) url += `&user_id=${tsReportUser.value || 'all'}`;
            try {
                const res = await apiFetch(url);
                if (res.ok) tsReport.value = await res.json();
            } catch (e) { console.error('timesheet report', e); }
        };

        const fmtSecs = (s) => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h > 0 ? `${h}h ${m}m` : `${m}m`; };
        const tsTime = (ts) => ts ? ts.slice(11, 16) : '—';
        const flagInfo = (f) => ({
            ontime: { label: 'On time', cls: 'bg-emerald-50 text-emerald-700 border border-emerald-200' },
            late: { label: 'Filed late', cls: 'bg-red-50 text-red-700 border border-red-200' },
            early: { label: 'Filed early', cls: 'bg-amber-50 text-amber-700 border border-amber-200' }
        }[f] || { label: '', cls: '' });

        const exportTsReport = () => {
            const rows = [];
            tsReport.value.forEach(day => {
                const base = { date: day.date, user: day.full_name, logged: fmtSecs(day.logged_seconds),
                               login: day.first_login || '', logout: day.last_logout || '',
                               flag: flagInfo(day.submission_flag).label || 'On time', description: day.description || '' };
                if (!day.tasks.length) { rows.push({ ...base, task: '—', client: '', service: '', status: '', start_date: '', start_ts: '', end_ts: '', today: '', total: '' }); return; }
                day.tasks.forEach(t => rows.push({ ...base,
                    task: t.task_no ? ('#' + t.task_no) : '', client: t.client_name, service: t.service_name, status: t.status,
                    start_date: t.start_date || '', start_ts: tsTime(t.start_ts), end_ts: t.running ? 'running' : tsTime(t.end_ts),
                    today: fmtSecs(t.time_today_seconds), total: fmtSecs(t.total_seconds) }));
            });
            const cols = [
                { key: 'date', label: 'Date' }, { key: 'user', label: 'User' }, { key: 'logged', label: 'Logged-in' },
                { key: 'login', label: 'Login' }, { key: 'logout', label: 'Logout' },
                { key: 'task', label: 'Task ID' }, { key: 'client', label: 'Client' }, { key: 'service', label: 'Service' },
                { key: 'status', label: 'Status' }, { key: 'start_date', label: 'Start Date' },
                { key: 'start_ts', label: 'Start' }, { key: 'end_ts', label: 'End' },
                { key: 'today', label: 'Time Today' }, { key: 'total', label: 'Total' },
                { key: 'flag', label: 'Submission' }, { key: 'description', label: 'Description' }
            ];
            downloadExport({ title: 'Timesheet Report', sheets: [{ name: 'Timesheet', columns: cols, rows }] }, exportFormat.value === 'pdf' ? 'pdf' : 'xlsx');
        };

        watch([tsRange, tsReportUser, () => currentTab.value], () => {
            if (currentTab.value === 'timesheet') fetchTsReport();
        });

        const launchTaskFromService = (srvObj) => {
            taskForm.value.client_id = '';
            taskForm.value.service_id = srvObj.id;
            taskForm.value.financial_year = '2025-26';
            taskForm.value.period = '';
            taskForm.value.status = 'Working';
            taskForm.value.assigned_to = '';
            editingTaskId.value = null;
            showTaskModal.value = true;
        };

        // Timesheets API Actions
        const logTimesheet = async () => {
            try {
                tsForm.value.employee_name = currentUser.value.full_name;
                const res = await apiFetch('/api/timesheets', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(tsForm.value)
                });
                if (res.ok) {
                    tsForm.value.task_id = '';
                    tsForm.value.hours = 0;
                    tsForm.value.minutes = 0;
                    tsForm.value.description = '';
                    await fetchData();
                }
            } catch (error) {
                console.error("Error logging timesheet entry:", error);
            }
        };

        // Embedded Secure Vault Integration (Reveals, Edits, Deletes inline)
        const openVaultForClient = async (clientObj) => {
            vaultClientObj.value = clientObj;
            decryptedPasswords.value = {}; // Reset decryption cache
            editingCredId.value = null;
            await fetchVaultCredentials(clientObj.id);
        };

        const closeVault = () => {
            vaultClientObj.value = null;
            vaultCredentials.value = [];
            credForm.value = { portal_name: '', password: '' };
            decryptedPasswords.value = {};
            editingCredId.value = null;
        };

        const fetchVaultCredentials = async (clientId) => {
            try {
                const res = await apiFetch(`/api/clients/${clientId}/credentials`);
                vaultCredentials.value = await res.json();
            } catch (error) {
                console.error("Error fetching client passwords:", error);
            }
        };

        const saveVaultCredential = async () => {
            try {
                const payload = {
                    client_id: vaultClientObj.value.id,
                    portal_name: credForm.value.portal_name,
                    password: credForm.value.password
                };
                const res = await apiFetch('/api/credentials', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (res.ok) {
                    credForm.value = { portal_name: '', password: '' };
                    await fetchVaultCredentials(vaultClientObj.value.id);
                }
            } catch (error) {
                console.error("Error encrypting portal password:", error);
            }
        };

        const toggleRevealPassword = async (credId) => {
            if (decryptedPasswords.value[credId]) {
                delete decryptedPasswords.value[credId];
                return;
            }
            try {
                const res = await apiFetch(`/api/credentials/${credId}/decrypt`);
                const data = await res.json();
                if (data.password) {
                    decryptedPasswords.value[credId] = data.password;
                }
            } catch (error) {
                console.error("Error decrypting secret:", error);
            }
        };

        const startEditCredential = async (credId, currentDecryptedVal) => {
            editingCredId.value = credId;
            if (currentDecryptedVal) {
                editingPassword.value = currentDecryptedVal;
            } else {
                try {
                    const res = await apiFetch(`/api/credentials/${credId}/decrypt`);
                    const data = await res.json();
                    editingPassword.value = data.password || '';
                } catch (e) {
                    editingPassword.value = '';
                }
            }
        };

        const cancelEditCredential = () => {
            editingCredId.value = null;
            editingPassword.value = '';
        };

        const savePasswordEdit = async (credId) => {
            if (!editingPassword.value) {
                alert("Password cannot be blank.");
                return;
            }
            try {
                const res = await apiFetch(`/api/credentials/${credId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: editingPassword.value })
                });
                if (res.ok) {
                    decryptedPasswords.value[credId] = editingPassword.value;
                    editingCredId.value = null;
                    editingPassword.value = '';
                    await fetchVaultCredentials(vaultClientObj.value.id);
                }
            } catch (error) {
                console.error("Error updating credential password:", error);
            }
        };

        const deleteCredential = async (credId) => {
            if (!confirm("Are you sure you want to permanently delete this portal credential?")) {
                return;
            }
            try {
                const res = await apiFetch(`/api/credentials/${credId}`, { method: 'DELETE' });
                if (res.ok) {
                    delete decryptedPasswords.value[credId];
                    await fetchVaultCredentials(vaultClientObj.value.id);
                }
            } catch (error) {
                console.error("Error deleting credential:", error);
            }
        };

        // Client Contacts Panel API Actions
        const openContactsForClient = async (clientObj) => {
            contactClientObj.value = clientObj;
            contactsList.value = [];
            contactForm.value = {
                name: '',
                designation: 'Accountant',
                email: '',
                mobile: ''
            };
            await fetchContacts(clientObj.id);
        };

        const closeContacts = () => {
            contactClientObj.value = null;
            contactsList.value = [];
        };

        const fetchContacts = async (clientId) => {
            try {
                const res = await apiFetch(`/api/clients/${clientId}/contacts`);
                contactsList.value = await res.json();
            } catch (error) {
                console.error("Error loading contacts directory:", error);
            }
        };

        const saveVaultContact = async () => {
            try {
                const payload = {
                    client_id: contactClientObj.value.id,
                    name: contactForm.value.name,
                    designation: contactForm.value.designation,
                    email: contactForm.value.email,
                    mobile: contactForm.value.mobile
                };
                const res = await apiFetch('/api/contacts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (res.ok) {
                    contactForm.value = {
                        name: '',
                        designation: 'Accountant',
                        email: '',
                        mobile: ''
                    };
                    await fetchContacts(contactClientObj.value.id);
                }
            } catch (error) {
                console.error("Error saving contact card:", error);
            }
        };

        // ===================== Reports Tab =====================
        const reportGroupBy = ref('client');   // 'client' | 'service' | 'user'
        const reportRange = ref('monthly');     // 'daily' | 'monthly' | 'yearly' | 'custom'
        const reportDay = ref(today);
        const reportMonth = ref(today.slice(0, 7));   // YYYY-MM
        const reportYear = ref(String(new Date().getFullYear()));
        const reportStart = ref(today);
        const reportEnd = ref(today);

        const reportTimesheets = computed(() => {
            const inRange = (d) => {
                if (!d) return false;
                if (reportRange.value === 'daily') return d === reportDay.value;
                if (reportRange.value === 'monthly') return d.startsWith(reportMonth.value);
                if (reportRange.value === 'yearly') return d.startsWith(reportYear.value);
                if (reportRange.value === 'custom') return d >= reportStart.value && d <= reportEnd.value;
                return true;
            };
            return filteredTimesheets.value.filter(ts => inRange(ts.log_date));
        });

        const buildReportRows = (dim) => {
            const map = {};
            reportTimesheets.value.forEach(ts => {
                let key;
                if (dim === 'client') key = ts.client_name || 'Unspecified';
                else if (dim === 'service') key = ts.service_name || 'Unspecified';
                else key = ts.employee_name || 'Unspecified';
                if (!map[key]) map[key] = { name: key, totalMinutes: 0, count: 0 };
                map[key].totalMinutes += (ts.hours || 0) * 60 + (ts.minutes || 0);
                map[key].count += 1;
            });
            return Object.values(map)
                .map(r => ({ ...r, hours: Math.floor(r.totalMinutes / 60), minutes: r.totalMinutes % 60 }))
                .sort((a, b) => b.totalMinutes - a.totalMinutes);
        };

        // Three side-by-side aggregations shown together in the Reports tab
        const reportClientRows = computed(() => buildReportRows('client'));
        const reportUserRows = computed(() => buildReportRows('user'));
        const reportServiceRows = computed(() => buildReportRows('service'));

        // Legacy single-dimension rows (kept for any remaining references)
        const reportRows = computed(() => buildReportRows(reportGroupBy.value));

        // Staff performance drill-down: pick a user, see task counts + time logged
        const selectedReportUser = ref('');
        const userStats = computed(() => {
            let uid = selectedReportUser.value;
            if (!isAdminOrPartner.value) uid = currentUser.value.id;
            uid = uid === '' ? '' : Number(uid);
            if (!uid) return null;
            const u = usersList.value.find(x => x.id === uid);
            if (!u) return null;
            const userTasks = tasks.value.filter(t => t.assigned_to === uid);
            const working = userTasks.filter(t => t.status === 'Working').length;
            const pending = userTasks.filter(t => t.status === 'Pending').length;
            const completed = userTasks.filter(t => t.status === 'Completed').length;
            const logs = reportTimesheets.value.filter(ts => ts.employee_name === u.full_name);
            let mins = 0;
            logs.forEach(ts => { mins += (ts.hours || 0) * 60 + (ts.minutes || 0); });
            return {
                name: u.full_name,
                role: u.role,
                working, pending, completed, total: userTasks.length,
                logCount: logs.length,
                timeLogged: `${Math.floor(mins / 60)}h ${mins % 60}m`,
                logs: logs.slice(0, 50)
            };
        });

        const reportSummary = computed(() => {
            const todayStr = new Date().toISOString().split('T')[0];
            const monthStr = todayStr.slice(0, 7);
            let todayMin = 0, monthMin = 0, filteredMin = 0;
            filteredTimesheets.value.forEach(ts => {
                const m = (ts.hours || 0) * 60 + (ts.minutes || 0);
                if (ts.log_date === todayStr) todayMin += m;
                if (ts.log_date && ts.log_date.startsWith(monthStr)) monthMin += m;
            });
            reportTimesheets.value.forEach(ts => { filteredMin += (ts.hours || 0) * 60 + (ts.minutes || 0); });
            const fmt = (mn) => `${Math.floor(mn / 60)}h ${mn % 60}m`;
            return { today: fmt(todayMin), month: fmt(monthMin), filtered: fmt(filteredMin), entries: reportTimesheets.value.length };
        });

        // ===================== Reports: flexible drill-down =====================
        // Pick any order of the three dimensions (User / Client / Task) and a period
        // granularity (Weekly / Monthly / Quarterly / Yearly). Built entirely from the
        // timesheets already loaded; drill in to individual log entries at the leaf.
        const DRILL_DIMS = [
            { key: 'user', label: 'User' },
            { key: 'client', label: 'Client' },
            { key: 'task', label: 'Task' }
        ];
        const drillOrder = ref(['user', 'client', 'task']);
        const drillPeriod = ref('monthly');             // weekly | monthly | quarterly | yearly
        const _nowD = new Date();
        const drillWeek = ref(today);                   // any date within the week
        const drillMonth = ref(today.slice(0, 7));      // YYYY-MM
        const drillYear = ref(String(_nowD.getFullYear()));
        const drillQuarter = ref('Q' + (Math.floor(_nowD.getMonth() / 3) + 1));
        const expandedNodes = ref({});

        const drillDimLabel = (key) => (DRILL_DIMS.find(d => d.key === key) || {}).label || key;

        // Keep the three slots distinct: choosing a value swaps it with whoever held it.
        const setDrillDim = (slot, val) => {
            const order = [...drillOrder.value];
            const existing = order.indexOf(val);
            if (existing !== -1 && existing !== slot) order[existing] = order[slot];
            order[slot] = val;
            drillOrder.value = order;
        };

        const dimValue = (ts, dim) => {
            if (dim === 'user') return { key: ts.employee_name || 'Unassigned', label: ts.employee_name || 'Unassigned' };
            if (dim === 'client') return { key: ts.client_name || 'Unspecified', label: ts.client_name || 'Unspecified' };
            return { key: 't' + (ts.task_id || (ts.service_name + ts.period)), label: `${ts.service_name || '—'} · ${ts.period || ''}` };
        };

        const _quarterMonths = { Q1: [0, 1, 2], Q2: [3, 4, 5], Q3: [6, 7, 8], Q4: [9, 10, 11] };
        const drillInPeriod = (d) => {
            if (!d) return false;
            if (drillPeriod.value === 'monthly') return d.startsWith(drillMonth.value);
            if (drillPeriod.value === 'yearly') return d.startsWith(drillYear.value);
            if (drillPeriod.value === 'quarterly') {
                if (!d.startsWith(drillYear.value)) return false;
                const mo = parseInt(d.slice(5, 7), 10) - 1;
                return (_quarterMonths[drillQuarter.value] || []).includes(mo);
            }
            if (drillPeriod.value === 'weekly') {
                const anchor = new Date(drillWeek.value + 'T00:00:00');
                const dow = (anchor.getDay() + 6) % 7;     // Monday = 0
                const monday = new Date(anchor); monday.setDate(anchor.getDate() - dow);
                const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
                const ds = new Date(d + 'T00:00:00');
                return ds >= monday && ds <= sunday;
            }
            return true;
        };

        const tsMinutes = (ts) => (ts.hours || 0) * 60 + (ts.minutes || 0);
        const drillSource = computed(() => filteredTimesheets.value.filter(ts => drillInPeriod(ts.log_date)));
        const drillTotal = computed(() => { let m = 0; drillSource.value.forEach(ts => m += tsMinutes(ts)); return fmtDur(Math.floor(m / 60), m % 60); });

        // Build nested groups by the chosen order, flattened to rows that respect expand state.
        const drillRows = computed(() => {
            const dims = drillOrder.value;
            const rows = [];
            const build = (items, depth, path) => {
                if (depth >= dims.length) {
                    items.slice().sort((a, b) => (a.log_date < b.log_date ? 1 : -1)).forEach((ts, i) => {
                        rows.push({ id: path + '|log' + i, depth, type: 'log',
                            label: `${ts.log_date} — ${ts.description || 'No description'}`,
                            sub: `${ts.client_name} · ${ts.service_name} · ${ts.employee_name}`,
                            minutes: tsMinutes(ts), count: 1, hasChildren: false });
                    });
                    return;
                }
                const dim = dims[depth];
                const map = new Map();
                items.forEach(ts => {
                    const dv = dimValue(ts, dim);
                    if (!map.has(dv.key)) map.set(dv.key, { label: dv.label, items: [] });
                    map.get(dv.key).items.push(ts);
                });
                const groups = [...map.values()].map(g => {
                    let mins = 0; g.items.forEach(ts => mins += tsMinutes(ts));
                    return { label: g.label, items: g.items, minutes: mins, count: g.items.length };
                }).sort((a, b) => b.minutes - a.minutes);
                groups.forEach((g, gi) => {
                    const nodePath = path + '|' + depth + ':' + gi;
                    rows.push({ id: nodePath, depth, type: 'group', dim,
                        label: g.label, minutes: g.minutes, count: g.count, hasChildren: true,
                        expanded: !!expandedNodes.value[nodePath] });
                    if (expandedNodes.value[nodePath]) build(g.items, depth + 1, nodePath);
                });
            };
            build(drillSource.value, 0, 'root');
            return rows;
        });

        const toggleDrillNode = (id) => { expandedNodes.value = { ...expandedNodes.value, [id]: !expandedNodes.value[id] }; };

        // Export the drill-down as a pivot: one row per full (dim0,dim1,dim2) combo.
        const exportDrilldown = () => {
            const dims = drillOrder.value;
            const map = new Map();
            drillSource.value.forEach(ts => {
                const vals = dims.map(d => dimValue(ts, d).label);
                const key = vals.join(' ||| ');
                if (!map.has(key)) map.set(key, { vals, minutes: 0, count: 0 });
                const g = map.get(key); g.minutes += tsMinutes(ts); g.count++;
            });
            const rows = [...map.values()].sort((a, b) => b.minutes - a.minutes).map(g => {
                const row = {};
                dims.forEach((d, i) => { row[drillDimLabel(d)] = g.vals[i]; });
                row['Time Logged'] = fmtDur(Math.floor(g.minutes / 60), g.minutes % 60);
                row['Logs'] = g.count;
                return row;
            });
            const cols = dims.map(d => ({ key: drillDimLabel(d), label: drillDimLabel(d) }))
                .concat([{ key: 'Time Logged', label: 'Time Logged' }, { key: 'Logs', label: 'Logs' }]);
            downloadExport({ title: 'Drill-down Report', sheets: [{ name: 'Report', columns: cols, rows }] }, 'xlsx');
        };
        const drillMinFmt = (m) => fmtDur(Math.floor(m / 60), m % 60);

        // ===================== Client dual-view toggle =====================
        const clientView = ref('table');   // 'table' | 'grid'

        // ===================== Persistent task timers =====================
        // One timer runs per user; starting another pauses (banks) the previous one,
        // and resuming continues from the banked time. State lives server-side, so it
        // survives reloads and is correct across the whole session.
        const timers = ref({});                 // task_id -> { seconds, running }
        const timersFetchedAt = ref(Date.now());
        const tick = ref(0);                    // bumped every second to refresh live displays
        let timerInterval = null;

        const fetchTimers = async () => {
            try {
                const res = await apiFetch('/api/timers');
                if (!res.ok) return;
                const list = await res.json();
                const map = {};
                list.forEach(t => { map[t.task_id] = { seconds: t.seconds, running: t.running }; });
                timers.value = map;
                timersFetchedAt.value = Date.now();
            } catch (e) { /* offline / ignore */ }
        };

        const taskElapsedSeconds = (taskId) => {
            const t = timers.value[taskId];
            if (!t) return 0;
            let s = t.seconds || 0;
            if (t.running) { void tick.value; s += Math.max(0, Math.floor((Date.now() - timersFetchedAt.value) / 1000)); }
            return s;
        };
        const fmtHMS = (s) => {
            s = Math.max(0, Math.floor(s));
            const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
            return h > 0
                ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
                : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
        };
        const taskTimerDisplay = (taskId) => fmtHMS(taskElapsedSeconds(taskId));
        const isTaskRunning = (taskId) => !!(timers.value[taskId] && timers.value[taskId].running);
        const taskHasTime = (taskId) => !!(timers.value[taskId] && (timers.value[taskId].seconds > 0 || timers.value[taskId].running));

        const runningTaskId = computed(() => {
            void tick.value;
            const id = Object.keys(timers.value).find(k => timers.value[k] && timers.value[k].running);
            return id ? Number(id) : null;
        });
        const activeTimerTask = computed(() => runningTaskId.value
            ? (tasks.value.find(t => t.id === runningTaskId.value) || null) : null);
        const activeTimerDisplay = computed(() => runningTaskId.value ? taskTimerDisplay(runningTaskId.value) : '0:00');

        const startTaskTimer = async (task) => {
            try {
                await apiFetch(`/api/tasks/${task.id}/timer/start`, { method: 'POST' });
                // Starting work on a Pending task moves it to Working (stays there until Completed).
                if (task.status === 'Pending') { await updateTaskStatus(task.id, 'Working'); task.status = 'Working'; }
                await fetchTimers();
            } catch (e) { console.error('start timer', e); }
        };
        const pauseTaskTimer = async (task) => {
            try { await apiFetch(`/api/tasks/${task.id}/timer/pause`, { method: 'POST' }); await fetchTimers(); }
            catch (e) { console.error('pause timer', e); }
        };
        const resetTaskTimer = async (task) => {
            if (!confirm(`Reset the timer for "${task.client_name} · ${task.service_name}"? The tracked time will be cleared.`)) return;
            try {
                const res = await apiFetch(`/api/tasks/${task.id}/timer/reset`, { method: 'POST' });
                if (!res.ok) { const e = await res.json().catch(() => ({})); alert(e.message || 'Could not reset timer.'); return; }
                await fetchTimers();
            } catch (e) { console.error('reset timer', e); }
        };
        const logTimerToTimesheet = (task) => {
            const s = taskElapsedSeconds(task.id);
            tsForm.value.task_id = task.id;
            tsForm.value.hours = Math.floor(s / 3600);
            tsForm.value.minutes = Math.floor((s % 3600) / 60);
            tsForm.value.log_date = new Date().toISOString().split('T')[0];
            currentTab.value = 'timesheet';
        };
        const estDisplay = (mins) => {
            if (!mins) return '';
            const h = Math.floor(mins / 60), m = mins % 60;
            return h > 0 ? `${h}h ${m}m` : `${m}m`;
        };

        // ===================== Completion celebration =====================
        const showCompletionModal = ref(false);
        const completionTask = ref(null);

        const launchConfetti = () => {
            const colors = ['#8B5CF6', '#6366F1', '#10B981', '#F59E0B', '#EF4444', '#3B82F6'];
            for (let i = 0; i < 60; i++) {
                const el = document.createElement('div');
                el.className = 'confetti-piece';
                el.style.left = Math.random() * 100 + 'vw';
                el.style.background = colors[Math.floor(Math.random() * colors.length)];
                el.style.animationDelay = (Math.random() * 0.3) + 's';
                el.style.animationDuration = (2 + Math.random() * 1.5) + 's';
                document.body.appendChild(el);
                setTimeout(() => el.remove(), 4200);
            }
        };

        // Fill the timesheet form from a task's tracked timer time + today's date.
        const prefillCompletionLog = (task) => {
            const secs = taskElapsedSeconds(task.id);
            completionTask.value = task;
            tsForm.value.task_id = task.id;
            tsForm.value.hours = Math.min(23, Math.floor(secs / 3600));
            tsForm.value.minutes = Math.floor((secs % 3600) / 60);
            tsForm.value.log_date = new Date().toISOString().split('T')[0];
            tsForm.value.description = '';
        };

        // "Add to time log" on a Completed task (no celebration).
        const openLogModal = (task) => {
            prefillCompletionLog(task);
            showCompletionModal.value = true;
        };

        const submitCompletionLog = async () => {
            await logTimesheet();
            showCompletionModal.value = false;
            completionTask.value = null;
        };

        const closeCompletionModal = () => {
            showCompletionModal.value = false;
            completionTask.value = null;
        };

        // ===================== Exports (Excel / PDF) =====================
        // The frontend already holds every row and all filter state, so it builds a
        // spec (sheets -> columns -> rows) and posts it to /api/export, which renders
        // a real .xlsx workbook or a paginated PDF. Vault passwords are never included.
        const showExportModal = ref(false);
        const exportBusy = ref(false);
        const exportFormat = ref('xlsx');        // 'xlsx' | 'pdf'
        const exportTitle = ref('');
        const exportMode = ref('section');       // 'section' | 'report'
        const exportColumns = ref([]);           // [{key,label}]  (section mode)
        const exportFieldSel = ref({});          // key -> bool     (section mode)
        const exportFilters = ref([]);           // [{key,label,options,match,value}]
        const exportSheets = ref([]);            // [{name,columns,rowsFn,selected}] (report mode)
        let exportRowsFn = null;                 // () => rows (section mode; kept non-reactive)

        // Export period filter (applied to a section's date column when it has one).
        const expDateField = ref(null);          // e.g. 'due_date' / 'timestamp' / null
        const exportPeriod = ref('all');         // all|range|weekly|monthly|quarterly|halfyearly|yearly
        const expFrom = ref(today);
        const expTo = ref(today);
        const expWeekDate = ref(today);
        const expMonth = ref(today.slice(0, 7));
        const expMonthCount = ref(1);
        const expYear = ref(String(new Date().getFullYear()));
        const expYearCount = ref(1);
        const expQuarter = ref('Q' + (Math.floor(new Date().getMonth() / 3) + 1));
        const expHalf = ref(new Date().getMonth() < 6 ? 'H1' : 'H2');
        const exportRange = computed(() => {
            const p = exportPeriod.value;
            if (p === 'weekly') {
                const a = new Date(expWeekDate.value + 'T00:00:00');
                const dow = (a.getDay() + 6) % 7;
                const mon = new Date(a); mon.setDate(a.getDate() - dow);
                const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
                const f = (d) => _iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
                return { from: f(mon), to: f(sun) };
            }
            if (p === 'monthly') {
                const [y, m] = expMonth.value.split('-').map(Number);
                const count = Math.max(1, Number(expMonthCount.value) || 1);
                let sy = y, sm = m - (count - 1); while (sm < 1) { sm += 12; sy--; }
                return { from: _iso(sy, sm, 1), to: _iso(y, m, _lastDay(y, m)) };
            }
            if (p === 'quarterly') {
                const y = Number(expYear.value); const q = Number(expQuarter.value.slice(1));
                const sm = (q - 1) * 3 + 1; const em = sm + 2;
                return { from: _iso(y, sm, 1), to: _iso(y, em, _lastDay(y, em)) };
            }
            if (p === 'halfyearly') {
                const y = Number(expYear.value); const h = Number(expHalf.value.slice(1));
                const sm = h === 1 ? 1 : 7; const em = h === 1 ? 6 : 12;
                return { from: _iso(y, sm, 1), to: _iso(y, em, _lastDay(y, em)) };
            }
            if (p === 'yearly') {
                const y = Number(expYear.value); const count = Math.max(1, Number(expYearCount.value) || 1);
                return { from: _iso(y - (count - 1), 1, 1), to: _iso(y, 12, 31) };
            }
            if (p === 'range') return { from: expFrom.value, to: expTo.value };
            return null;   // 'all' → no filter
        });
        const applyExportPeriod = (rows) => {
            if (!expDateField.value || exportPeriod.value === 'all') return rows;
            const r = exportRange.value;
            if (!r || !r.from || !r.to) return rows;
            return rows.filter(row => {
                const v = row[expDateField.value];
                if (!v) return false;
                const d = String(v).slice(0, 10);
                return d >= r.from && d <= r.to;
            });
        };

        const triggerDownload = (blob, filename) => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = filename;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1500);
        };

        const filenameFromResponse = (res, fallback) => {
            const cd = res.headers.get('Content-Disposition') || '';
            const m = cd.match(/filename="?([^"]+)"?/);
            return m ? m[1] : fallback;
        };

        const downloadExport = async (spec, format) => {
            exportBusy.value = true;
            try {
                const res = await apiFetch(`/api/export?format=${format}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(spec)
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    alert(err.message || 'Export failed.');
                    return false;
                }
                const blob = await res.blob();
                triggerDownload(blob, filenameFromResponse(res, `export.${format === 'pdf' ? 'pdf' : 'xlsx'}`));
                return true;
            } catch (e) {
                console.error('Export error', e);
                alert('Export failed. Please try again.');
                return false;
            } finally {
                exportBusy.value = false;
            }
        };

        const fmtDur = (h, m) => `${h || 0}h ${m || 0}m`;
        const ALL = '__all__';

        // Reusable column sets
        const TASK_COLS = [
            { key: 'task_serial', label: 'Task ID' },
            { key: 'client_name', label: 'Client' },
            { key: 'service_name', label: 'Service' },
            { key: 'financial_year', label: 'Financial Year' },
            { key: 'period', label: 'Period' },
            { key: 'status', label: 'Status' },
            { key: 'assigned_to_name', label: 'Assigned To' },
            { key: 'due_date', label: 'Due Date' }
        ];
        const CLIENT_COLS = [
            { key: 'id', label: 'Client ID' },
            { key: 'name', label: 'Name' },
            { key: 'entity_type', label: 'Entity Type' },
            { key: 'pan', label: 'PAN' },
            { key: 'gstin', label: 'GSTIN' },
            { key: 'group_name', label: 'Group' },
            { key: 'assigned_to_name', label: 'Assigned Staff' },
            { key: 'physical_folder_location', label: 'Folder Location' },
            { key: 'data_location', label: 'Data Location' }
        ];
        const TS_COLS = [
            { key: 'id', label: 'Timesheet ID' },
            { key: 'log_date', label: 'Date' },
            { key: 'employee_name', label: 'Employee' },
            { key: 'client_name', label: 'Client' },
            { key: 'service_name', label: 'Service' },
            { key: 'period', label: 'Period' },
            { key: 'duration', label: 'Duration' },
            { key: 'description', label: 'Description' }
        ];

        const taskRow = (t) => ({ ...t, task_serial: taskSerial(t), assigned_to_name: t.assigned_to_name || 'Unassigned' });
        const clientRow = (c) => ({ ...c, group_name: c.group_name || 'Individual', assigned_to_name: c.assigned_to_name || 'Unassigned' });
        const tsRow = (ts) => ({ ...ts, duration: fmtDur(ts.hours, ts.minutes) });

        const distinctOptions = (arr, key, allLabel) => {
            const seen = [];
            arr.forEach(o => { const v = o[key]; if (v && !seen.includes(v)) seen.push(v); });
            return [{ value: ALL, label: allLabel }, ...seen.map(v => ({ value: v, label: v }))];
        };

        const getSectionConfig = (key) => {
            switch (key) {
                case 'tasks':
                    return {
                        title: 'Tasks', mode: 'section', columns: TASK_COLS, dateField: 'due_date',
                        rowsFn: () => filteredTasks.value.map(taskRow),
                        filters: [{
                            key: 'status', label: 'Status',
                            options: [{ value: ALL, label: 'All statuses' }, { value: 'Working', label: 'Working' },
                                      { value: 'Pending', label: 'Pending' }, { value: 'Completed', label: 'Completed' },
                                      { value: 'Unassigned', label: 'Unassigned' }],
                            match: (r, v) => v === 'Unassigned' ? !r.assigned_to : r.status === v
                        }]
                    };
                case 'clients':
                    return {
                        title: 'Clients', mode: 'section', columns: CLIENT_COLS,
                        rowsFn: () => filteredClients.value.map(clientRow),
                        filters: [
                            { key: 'entity_type', label: 'Entity type', options: distinctOptions(clients.value, 'entity_type', 'All entities'),
                              match: (r, v) => r.entity_type === v },
                            { key: 'group_name', label: 'Group', options: distinctOptions(clients.value.map(clientRow), 'group_name', 'All groups'),
                              match: (r, v) => r.group_name === v }
                        ]
                    };
                case 'services':
                    return {
                        title: 'Services', mode: 'section',
                        columns: [{ key: 'id', label: 'Service ID' }, { key: 'name', label: 'Service' },
                                  { key: 'description', label: 'Description' }, { key: 'default_due_day', label: 'Default Due Day' },
                                  { key: 'checklist', label: 'Checklist' }],
                        rowsFn: () => services.value.map(s => ({ ...s, checklist: parseChecklist(s.checklist_json).join(', ') })),
                        filters: []
                    };
                case 'users':
                    return {
                        title: 'Staff', mode: 'section',
                        columns: [{ key: 'id', label: 'User ID' }, { key: 'full_name', label: 'Full Name' },
                                  { key: 'username', label: 'Username' }, { key: 'role', label: 'Role' }],
                        rowsFn: () => usersList.value.slice(),
                        filters: [{ key: 'role', label: 'Role',
                                    options: [{ value: ALL, label: 'All roles' }, { value: 'Admin', label: 'Admin' }, { value: 'Employee', label: 'Employee' }],
                                    match: (r, v) => r.role === v }]
                    };
                case 'timesheet':
                    return {
                        title: 'Timesheets', mode: 'section', columns: TS_COLS,
                        rowsFn: () => filteredTimesheets.value.map(tsRow), filters: []
                    };
                case 'activity':
                    return {
                        title: 'Activity Log', mode: 'section', dateField: 'timestamp',
                        columns: [{ key: 'id', label: 'Log ID' }, { key: 'timestamp', label: 'Timestamp' },
                                  { key: 'username', label: 'User' }, { key: 'action', label: 'Action' },
                                  { key: 'details', label: 'Details' }],
                        rowsFn: () => filteredLogs.value.slice(), filters: []
                    };
                case 'reports': {
                    const aggCols = [{ key: 'name', label: 'Name' }, { key: 'duration', label: 'Time Logged' }, { key: 'count', label: 'Logs' }];
                    const aggRows = (rows) => rows.map(r => ({ name: r.name, duration: fmtDur(r.hours, r.minutes), count: r.count }));
                    return {
                        title: 'Work Report', mode: 'report',
                        sheets: [
                            { name: 'Client-wise', columns: aggCols, rowsFn: () => aggRows(reportClientRows.value) },
                            { name: 'User-wise', columns: aggCols, rowsFn: () => aggRows(reportUserRows.value) },
                            { name: 'Service-wise', columns: aggCols, rowsFn: () => aggRows(reportServiceRows.value) }
                        ]
                    };
                }
                case 'dashboard': {
                    const byStatus = (st) => tasks.value.filter(t => t.status === st).map(taskRow);
                    const unassigned = () => tasks.value.filter(t => !t.assigned_to).map(taskRow);
                    const staffRows = () => usersList.value.map(u => {
                        const ut = tasks.value.filter(t => t.assigned_to === u.id);
                        let mins = 0;
                        timesheets.value.forEach(ts => { if (ts.employee_name === u.full_name) mins += (ts.hours || 0) * 60 + (ts.minutes || 0); });
                        return {
                            name: u.full_name, role: u.role,
                            working: ut.filter(t => t.status === 'Working').length,
                            pending: ut.filter(t => t.status === 'Pending').length,
                            completed: ut.filter(t => t.status === 'Completed').length,
                            total: ut.length, time_logged: fmtDur(Math.floor(mins / 60), mins % 60)
                        };
                    });
                    const summaryRows = () => {
                        let mins = 0;
                        timesheets.value.forEach(ts => { mins += (ts.hours || 0) * 60 + (ts.minutes || 0); });
                        return [
                            { metric: 'Total Clients', value: clients.value.length },
                            { metric: 'Total Tasks', value: tasks.value.length },
                            { metric: 'Working', value: tasks.value.filter(t => t.status === 'Working').length },
                            { metric: 'Pending', value: tasks.value.filter(t => t.status === 'Pending').length },
                            { metric: 'Completed', value: tasks.value.filter(t => t.status === 'Completed').length },
                            { metric: 'Unassigned Tasks', value: tasks.value.filter(t => !t.assigned_to).length },
                            { metric: 'Total Staff', value: usersList.value.length },
                            { metric: 'Total Time Logged', value: fmtDur(Math.floor(mins / 60), mins % 60) }
                        ];
                    };
                    const staffCols = [{ key: 'name', label: 'Staff' }, { key: 'role', label: 'Role' },
                                       { key: 'working', label: 'Working' }, { key: 'pending', label: 'Pending' },
                                       { key: 'completed', label: 'Completed' }, { key: 'total', label: 'Total' },
                                       { key: 'time_logged', label: 'Time Logged' }];
                    return {
                        title: 'Office Full Report', mode: 'report',
                        sheets: [
                            { name: 'Summary', columns: [{ key: 'metric', label: 'Metric' }, { key: 'value', label: 'Value' }], rowsFn: summaryRows },
                            { name: 'Tasks - Working', columns: TASK_COLS, rowsFn: () => byStatus('Working') },
                            { name: 'Tasks - Pending', columns: TASK_COLS, rowsFn: () => byStatus('Pending') },
                            { name: 'Tasks - Completed', columns: TASK_COLS, rowsFn: () => byStatus('Completed') },
                            { name: 'Tasks - Unassigned', columns: TASK_COLS, rowsFn: unassigned },
                            { name: 'Clients', columns: CLIENT_COLS, rowsFn: () => clients.value.map(clientRow) },
                            { name: 'Staff Workload', columns: staffCols, rowsFn: staffRows },
                            { name: 'Timesheets', columns: TS_COLS, rowsFn: () => timesheets.value.map(tsRow) }
                        ]
                    };
                }
                case 'billed':
                case 'received': {
                    const isRec = key === 'received';
                    const cols = [
                        { key: 'task_serial', label: 'Task ID' },
                        { key: 'client_name', label: 'Client' },
                        { key: 'service_name', label: 'Service' },
                        { key: 'financial_year', label: 'Financial Year' },
                        { key: 'period', label: 'Period' },
                        { key: 'billed_amount', label: 'Billed Amount' },
                        { key: 'gst_amount', label: 'GST Amount' },
                        { key: 'total_amount', label: 'Total Amount' },
                        { key: 'billed_date', label: 'Billed Date' }
                    ];
                    if (isRec) cols.push({ key: 'received_date', label: 'Received Date' });
                    const src = isRec ? receivedTasks : billedTasks;
                    return {
                        title: isRec ? 'Received Fees' : 'Billed', mode: 'section', columns: cols,
                        dateField: isRec ? 'received_date' : 'billed_date',
                        rowsFn: () => src.value.map(t => ({ ...t, task_serial: taskSerial(t) })), filters: []
                    };
                }
                default:
                    return { title: 'Export', mode: 'section', columns: [], rowsFn: () => [], filters: [] };
            }
        };

        const openExportModal = (sectionKey) => {
            const cfg = getSectionConfig(sectionKey);
            exportTitle.value = cfg.title;
            exportFormat.value = 'xlsx';
            exportMode.value = cfg.mode;
            expDateField.value = cfg.dateField || null;
            exportPeriod.value = 'all';
            if (cfg.mode === 'report') {
                exportSheets.value = cfg.sheets.map(s => ({ name: s.name, columns: s.columns, rowsFn: s.rowsFn, selected: true }));
                exportColumns.value = [];
                exportFilters.value = [];
                exportRowsFn = null;
            } else {
                exportColumns.value = cfg.columns;
                const sel = {};
                cfg.columns.forEach(c => { sel[c.key] = true; });
                exportFieldSel.value = sel;
                exportRowsFn = cfg.rowsFn;
                exportFilters.value = (cfg.filters || []).map(f => ({ ...f, value: f.options[0].value }));
            }
            showExportModal.value = true;
        };

        const closeExportModal = () => { showExportModal.value = false; };

        const confirmExport = async () => {
            let spec;
            if (exportMode.value === 'report') {
                const sheets = exportSheets.value.filter(s => s.selected)
                    .map(s => ({ name: s.name, columns: s.columns, rows: s.rowsFn() }));
                if (!sheets.length) { alert('Select at least one section to export.'); return; }
                spec = { title: exportTitle.value, sheets };
            } else {
                const cols = exportColumns.value.filter(c => exportFieldSel.value[c.key]);
                if (!cols.length) { alert('Select at least one field to export.'); return; }
                let rows = exportRowsFn ? exportRowsFn() : [];
                exportFilters.value.forEach(f => {
                    if (f.value !== ALL) rows = rows.filter(r => f.match(r, f.value));
                });
                rows = applyExportPeriod(rows);
                spec = { title: exportTitle.value, sheets: [{ name: exportTitle.value, columns: cols, rows }] };
            }
            const ok = await downloadExport(spec, exportFormat.value);
            if (ok) showExportModal.value = false;
        };

        // ===================== Bulk import (CSV / Excel) =====================
        // One reusable modal drives clients / services / users / tasks uploads.
        const IMPORT_CONFIGS = {
            clients: {
                title: 'Clients',
                required: ['Name'],
                optional: ['Entity Type', 'PAN', 'GSTIN', 'Group', 'Folder Location', 'Data Location'],
                note: 'PAN & GSTIN are format-checked when present. New groups are created automatically.'
            },
            services: {
                title: 'Services',
                required: ['Name'],
                optional: ['Description', 'Checklist', 'Default Due Day'],
                note: 'Checklist items: separate with commas. Default Due Day is a day of the month (1–31); blank defaults to 15.'
            },
            users: {
                title: 'Staff Users',
                required: ['Full Name', 'Username', 'Password'],
                optional: [],
                note: 'All imported staff are created with the Employee role. Usernames must be unique. Tell staff to change their password after first login.'
            },
            tasks: {
                title: 'Tasks',
                required: ['Client', 'Service', 'Financial Year', 'Period'],
                optional: ['Status', 'Assigned To', 'Due Date'],
                note: 'Client & Service must exactly match names that already exist. Assigned To must match a staff full name. Status defaults to Working.'
            }
        };

        const showImportModal = ref(false);
        const importBusy = ref(false);
        const importError = ref('');
        const importFileName = ref('');
        const importResult = ref(null);
        const importEntity = ref('clients');
        const importConfig = ref(IMPORT_CONFIGS.clients);
        let importFileObj = null;   // plain File (kept out of Vue reactivity for FormData)

        const openImportModal = (entity = 'clients') => {
            importEntity.value = entity;
            importConfig.value = IMPORT_CONFIGS[entity] || IMPORT_CONFIGS.clients;
            importError.value = ''; importResult.value = null;
            importFileName.value = ''; importFileObj = null;
            showImportModal.value = true;
        };
        const closeImportModal = () => { showImportModal.value = false; };

        const onImportFileChange = (ev) => {
            const f = ev.target.files && ev.target.files[0];
            importFileObj = f || null;
            importFileName.value = f ? f.name : '';
            importError.value = ''; importResult.value = null;
        };

        const downloadImportTemplate = async (format) => {
            try {
                const res = await apiFetch(`/api/import/${importEntity.value}/template?format=${format}`);
                if (!res.ok) { alert('Could not download template.'); return; }
                const blob = await res.blob();
                triggerDownload(blob, filenameFromResponse(res, `${importEntity.value}_import_template.${format === 'xlsx' ? 'xlsx' : 'csv'}`));
            } catch (e) { alert('Could not download template.'); }
        };

        const submitImport = async () => {
            if (!importFileObj) { importError.value = 'Please choose a .csv or .xlsx file first.'; return; }
            importBusy.value = true; importError.value = ''; importResult.value = null;
            try {
                const fd = new FormData();
                fd.append('file', importFileObj);
                const res = await apiFetch(`/api/import/${importEntity.value}`, { method: 'POST', body: fd });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) { importError.value = data.message || 'Import failed.'; return; }
                importResult.value = data;
                await fetchData();
            } catch (e) {
                console.error('Import error', e);
                importError.value = 'Import failed. Please try again.';
            } finally {
                importBusy.value = false;
            }
        };

        // ===================== Clear activity log (admin) =====================
        const showClearLogModal = ref(false);
        const clearLogBusy = ref(false);
        const clearLogError = ref('');
        const clearFrom = ref(today);
        const clearTo = ref(today);

        const openClearLogModal = () => {
            clearFrom.value = today; clearTo.value = today;
            clearLogError.value = '';
            showClearLogModal.value = true;
        };
        const closeClearLogModal = () => { showClearLogModal.value = false; };

        const confirmClearLog = async () => {
            if (!clearFrom.value || !clearTo.value) { clearLogError.value = 'Please choose both dates.'; return; }
            if (clearFrom.value > clearTo.value) { clearLogError.value = 'The "From" date cannot be after the "To" date.'; return; }
            if (!confirm(`Permanently delete activity-log entries from ${clearFrom.value} to ${clearTo.value}? This cannot be undone.`)) return;
            clearLogBusy.value = true; clearLogError.value = '';
            try {
                const res = await apiFetch('/api/activity-logs/clear', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ from_date: clearFrom.value, to_date: clearTo.value })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) { clearLogError.value = data.message || 'Could not clear logs.'; return; }
                showClearLogModal.value = false;
                await fetchData();
                alert(`Cleared ${data.deleted} log entr${data.deleted === 1 ? 'y' : 'ies'}.`);
            } catch (e) {
                console.error('Clear log error', e);
                clearLogError.value = 'Could not clear logs. Please try again.';
            } finally {
                clearLogBusy.value = false;
            }
        };

        onMounted(async () => {
            // Live-tick running timers every second
            timerInterval = setInterval(() => { tick.value++; }, 1000);
            // Presence: heartbeat keeps "online" fresh; poll presence for the dashboard.
            setInterval(sendHeartbeat, 45000);
            setInterval(() => { if (isLoggedIn.value) fetchPresence(); }, 30000);

            const savedPalette = localStorage.getItem('ca_palette');
            if (savedPalette && palettes[savedPalette]) {
                applyPalette(savedPalette);
            } else {
                applyPalette('default');
            }

            // Restore light/dark preference
            applyDark(localStorage.getItem('ca_dark') === '1');

            // Restore the session from the server-side cookie (source of truth).
            try {
                const meRes = await apiFetch('/api/me');
                if (meRes.ok) {
                    const data = await meRes.json();
                    currentUser.value = data.user;
                    isLoggedIn.value = true;
                    await fetchData();
                }
            } catch (e) {
                // Not authenticated -> the login screen is shown by default.
            }
        });

        return {
            currentTab,
            isSidebarCollapsed,
            isLoggedIn,
            currentUser,
            loginForm,
            loginError,
            tasks,
            clients,
            services,
            usersList,
            clientGroups,
            timesheets,
            taskSearch,
            taskStatusFilter,
            clientSearch,
            clientPage,
            clientsPerPage,
            showTaskModal,
            showClientModal,
            showUserModal,
            showServiceModal,
            showBulkEngine,
            vaultClientObj,
            contactClientObj,
            editingTaskId,
            editingClientId,
            editingUserId,
            editingServiceId,
            decryptedPasswords,
            editingCredId,
            editingPassword,
            contactsList,
            contactForm,
            taskForm,
            clientForm,
            userForm,
            serviceForm,
            tsForm,
            bulkForm,
            bulkMessage,
            credForm,
            vaultCredentials,
            tabTitle,
            counts,
            activeDashboardFilter,
            setDashboardFilter,
            filteredDashboardTasks,
            dashCard,
            setDashCard,
            dashTasksByUser,
            presence,
            onlineUsers,
            // Kanban board + drag & drop
            boardColumns,
            columnKeyOf,
            taskSerial,
            draggedTaskId,
            dragOverColumn,
            onTaskDragStart,
            onTaskDragEnd,
            onColumnDragOver,
            onColumnDragLeave,
            onColumnDrop,
            // Task assignment
            assignTask,
            showAssignModal,
            assignTargetTask,
            assignTargetStatus,
            assignSelectedUser,
            openAssignModal,
            closeAssignModal,
            confirmAssignModal,
            filteredTasks,
            filteredClients,
            paginatedClients,
            totalClientPages,
            filteredContactsList,
            filteredTimesheets,
            activityLogs,
            logSearch,
            filteredLogs,
            handleLogin,
            handleLogout,
            updateTaskStatus,
            startEditTask,
            closeTaskModal,
            submitTaskForm,
            generateBulkTasks,
            showRecurringModal,
            recurringTemplates,
            openRecurringModal,
            closeRecurringModal,
            updateRecurringTpl,
            freqLabel,
            startEditClient,
            closeClientModal,
            submitClientForm,
            assignClient,
            openUserModal,
            startEditUser,
            closeUserModal,
            submitUserForm,
            // Roles & permissions
            can,
            isAdminOrPartner,
            canSeeAll,
            CAPABILITIES,
            CAPABILITY_LABELS,
            assignableRoles,
            onUserRoleChange,
            canEditRolePerms,
            // Delegation + deletes
            delegateTask,
            deleteTask,
            deleteClient,
            // Billing pipeline
            billedTasks,
            receivedTasks,
            billedTotals,
            receivedTotals,
            fmtMoney,
            showBillingModal,
            billingTask,
            billingDecision,
            billedAmount,
            gstAmount,
            billingBusy,
            billingError,
            billingTotal,
            billingReady,
            openBillingModal,
            closeBillingModal,
            confirmBilling,
            markReceived,
            moveBackToBilled,
            moveBackToCompleted,
            // Delete-user-with-reassignment
            showDeleteUserModal,
            deleteUserTarget,
            deleteReassignTo,
            deleteUserBusy,
            deleteUserError,
            deleteUserTaskCount,
            reassignCandidates,
            openDeleteUser,
            closeDeleteUser,
            confirmDeleteUser,
            startEditService,
            closeServiceModal,
            submitServiceForm,
            parseChecklist,
            launchTaskFromService,
            logTimesheet,
            // Timesheet: file + daily report
            tsFileDate,
            tsFileDesc,
            tsFiling,
            tsFileMsg,
            fileTimesheet2,
            tsPeriod,
            tsFrom,
            tsTo,
            tsWeekDate,
            tsMonth,
            tsMonthCount,
            tsYear,
            tsYearCount,
            tsQuarter,
            tsHalf,
            tsReportUser,
            tsReport,
            canPickUser,
            tsRange,
            fetchTsReport,
            fmtSecs,
            tsTime,
            flagInfo,
            exportTsReport,
            openVaultForClient,
            closeVault,
            saveVaultCredential,
            toggleRevealPassword,
            startEditCredential,
            cancelEditCredential,
            savePasswordEdit,
            deleteCredential,
            openContactsForClient,
            closeContacts,
            saveVaultContact,
            palettes,
            currentPalette,
            showPaletteDropdown,
            changePalette,
            isDark,
            toggleDark,
            // Reports
            reportGroupBy,
            reportRange,
            reportDay,
            reportMonth,
            reportYear,
            reportStart,
            reportEnd,
            reportRows,
            reportClientRows,
            reportUserRows,
            reportServiceRows,
            selectedReportUser,
            userStats,
            reportSummary,
            // Reports drill-down
            DRILL_DIMS,
            drillOrder,
            drillPeriod,
            drillWeek,
            drillMonth,
            drillYear,
            drillQuarter,
            setDrillDim,
            drillDimLabel,
            drillRows,
            drillSource,
            drillTotal,
            toggleDrillNode,
            exportDrilldown,
            drillMinFmt,
            // Client view toggle
            clientView,
            // Persistent task timers
            timers,
            taskTimerDisplay,
            isTaskRunning,
            taskHasTime,
            activeTimerTask,
            activeTimerDisplay,
            startTaskTimer,
            pauseTaskTimer,
            resetTaskTimer,
            logTimerToTimesheet,
            estDisplay,
            // Completion celebration
            showCompletionModal,
            completionTask,
            submitCompletionLog,
            closeCompletionModal,
            openLogModal,
            // Exports (Excel / PDF)
            showExportModal,
            exportBusy,
            exportFormat,
            exportTitle,
            exportMode,
            exportColumns,
            exportFieldSel,
            exportFilters,
            exportSheets,
            expDateField,
            exportPeriod,
            expFrom,
            expTo,
            expWeekDate,
            expMonth,
            expMonthCount,
            expYear,
            expYearCount,
            expQuarter,
            expHalf,
            openExportModal,
            closeExportModal,
            confirmExport,
            // Bulk import (clients / services / users / tasks)
            showImportModal,
            importBusy,
            importError,
            importFileName,
            importResult,
            importEntity,
            importConfig,
            openImportModal,
            closeImportModal,
            onImportFileChange,
            downloadImportTemplate,
            submitImport,
            // Clear activity log
            showClearLogModal,
            clearLogBusy,
            clearLogError,
            clearFrom,
            clearTo,
            openClearLogModal,
            closeClearLogModal,
            confirmClearLog
        };
    }
}).mount('#app');
