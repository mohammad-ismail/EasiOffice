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
        const currentUser = ref({ id: 0, username: '', role: 'Employee', full_name: '' });
        const loginForm = ref({ username: '', password: '' });
        const loginError = ref('');

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
            due_date: ''
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
            full_name: ''
        });

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
                'activity': 'Personnel Activity Log'
            };
            return titles[currentTab.value] || 'EasiOffice';
        });

        // Dashboard Stat Summary: dynamically calculates counts strictly for the logged-in staff's tasks (or all for Admin)
        const counts = computed(() => {
            let goingOn = 0, stuck = 0, completed = 0, unassigned = 0;
            const relevantTasks = tasks.value.filter(t => currentUser.value.role === 'Admin' || t.assigned_to === currentUser.value.id);
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

        // Computed Filters for Dashboard strictly reflecting active card selection
        const filteredDashboardTasks = computed(() => {
            let list = tasks.value;
            if (currentUser.value.role !== 'Admin') {
                list = tasks.value.filter(t => t.assigned_to === currentUser.value.id);
            }
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
            const isAdmin = currentUser.value.role === 'Admin';
            let list = tasks.value;
            if (!isAdmin) list = tasks.value.filter(t => t.assigned_to === currentUser.value.id);

            const cols = [];
            if (isAdmin) cols.push({ key: 'Unassigned', label: 'Unassigned', icon: 'fa-user-slash', accent: '#8E8E93' });
            cols.push({ key: 'Working', label: 'Working', icon: 'fa-bolt', accent: 'var(--color-goingon)' });
            cols.push({ key: 'Pending', label: 'Pending', icon: 'fa-clock', accent: 'var(--color-stuck)' });
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
            let list = tasks.value;
            if (currentUser.value.role !== 'Admin') {
                list = tasks.value.filter(t => t.assigned_to === currentUser.value.id);
            }
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
            if (currentUser.value.role !== 'Admin') {
                const assignedClientIds = new Set(tasks.value.filter(t => t.assigned_to === currentUser.value.id).map(t => t.client_id));
                // Visible if the employee has a task for the client OR the client is directly assigned to them
                list = clients.value.filter(c => assignedClientIds.has(c.id) || c.assigned_to === currentUser.value.id);
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
            if (currentUser.value.role === 'Admin') {
                return contactsList.value;
            } else {
                return contactsList.value.filter(c => c.designation.toLowerCase() === 'accountant');
            }
        });

        const filteredTimesheets = computed(() => {
            if (currentUser.value.role === 'Admin') {
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
            } catch (error) {
                console.error("Error loading firm data:", error);
            }
        };

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
                // Celebrate completion + prompt to file the final timesheet
                if (newStatus === 'Completed' && t) {
                    launchConfetti();
                    completionTask.value = t;
                    tsForm.value.task_id = t.id;
                    tsForm.value.log_date = new Date().toISOString().split('T')[0];
                    if (!tsForm.value.hours && !tsForm.value.minutes) {
                        tsForm.value.hours = 1;
                        tsForm.value.minutes = 0;
                    }
                    showCompletionModal.value = true;
                }
            } catch (error) {
                console.error("Error updating status:", error);
            }
        };

        // Edit pre-fill tasks modal
        const startEditTask = (taskObj) => {
            editingTaskId.value = taskObj.id;
            taskForm.value = {
                client_id: taskObj.client_id,
                service_id: taskObj.service_id,
                financial_year: taskObj.financial_year,
                period: taskObj.period,
                status: taskObj.status,
                assigned_to: taskObj.assigned_to || '',
                recurrence_type: 'one_time',
                due_date: taskObj.due_date || ''
            };
            showTaskModal.value = true;
        };

        const closeTaskModal = () => {
            editingTaskId.value = null;
            taskForm.value = { client_id: '', service_id: '', financial_year: '2025-26', period: '', status: 'Working', assigned_to: '', recurrence_type: 'one_time', due_date: '' };
            showTaskModal.value = false;
        };

        const submitTaskForm = async () => {
            try {
                const method = editingTaskId.value ? 'PUT' : 'POST';
                const url = editingTaskId.value ? `/api/tasks/${editingTaskId.value}` : '/api/tasks';
                const res = await apiFetch(url, {
                    method: method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(taskForm.value)
                });
                if (res.ok) {
                    closeTaskModal();
                    await fetchData();
                }
            } catch (error) {
                console.error("Error saving task details:", error);
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
        const startEditUser = (userObj) => {
            editingUserId.value = userObj.id;
            userForm.value = {
                username: userObj.username,
                password: '', // leave empty to not change password
                role: userObj.role,
                full_name: userObj.full_name
            };
            showUserModal.value = true;
        };

        const closeUserModal = () => {
            editingUserId.value = null;
            userForm.value = { username: '', password: '', role: 'Employee', full_name: '' };
            showUserModal.value = false;
        };

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

        const deleteUser = async (userObj) => {
            if (userObj.username === 'admin') {
                alert("Primary system administrator cannot be removed.");
                return;
            }
            if (!confirm(`Are you sure you want to delete staff account: "${userObj.full_name}"?`)) {
                return;
            }
            try {
                const res = await apiFetch(`/api/users/${userObj.id}`, { method: 'DELETE' });
                if (res.ok) {
                    await fetchData();
                }
            } catch (error) {
                console.error("Error deleting user:", error);
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
            if (currentUser.value.role !== 'Admin') uid = currentUser.value.id;
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

        // ===================== Client dual-view toggle =====================
        const clientView = ref('table');   // 'table' | 'grid'

        // ===================== Active Task Timer (single active) =====================
        const activeTimer = ref(null);     // { taskId, label, startMs }
        const timerNow = ref(Date.now());
        let timerInterval = null;

        const startTimer = (task) => {
            activeTimer.value = { taskId: task.id, label: `${task.client_name} - ${task.service_name}`, startMs: Date.now() };
            timerNow.value = Date.now();
            if (timerInterval) clearInterval(timerInterval);
            timerInterval = setInterval(() => { timerNow.value = Date.now(); }, 1000);
        };

        const elapsedDisplay = computed(() => {
            if (!activeTimer.value) return '00:00';
            const s = Math.max(0, Math.floor((timerNow.value - activeTimer.value.startMs) / 1000));
            return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
        });

        const stopTimer = () => {
            if (!activeTimer.value) return;
            const totalSec = Math.floor((Date.now() - activeTimer.value.startMs) / 1000);
            if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
            tsForm.value.task_id = activeTimer.value.taskId;
            tsForm.value.hours = Math.floor(totalSec / 3600);
            tsForm.value.minutes = Math.floor((totalSec % 3600) / 60);
            tsForm.value.log_date = new Date().toISOString().split('T')[0];
            activeTimer.value = null;
            currentTab.value = 'timesheet';   // redirect to file the timesheet
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

        const submitCompletionLog = async () => {
            await logTimesheet();
            showCompletionModal.value = false;
            completionTask.value = null;
        };

        const closeCompletionModal = () => {
            showCompletionModal.value = false;
            completionTask.value = null;
        };

        onMounted(async () => {
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
            // Kanban board + drag & drop
            boardColumns,
            columnKeyOf,
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
            startEditClient,
            closeClientModal,
            submitClientForm,
            assignClient,
            startEditUser,
            closeUserModal,
            submitUserForm,
            deleteUser,
            startEditService,
            closeServiceModal,
            submitServiceForm,
            parseChecklist,
            launchTaskFromService,
            logTimesheet,
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
            // Client view toggle
            clientView,
            // Active timer
            activeTimer,
            elapsedDisplay,
            startTimer,
            stopTimer,
            // Completion celebration
            showCompletionModal,
            completionTask,
            submitCompletionLog,
            closeCompletionModal
        };
    }
}).mount('#app');
