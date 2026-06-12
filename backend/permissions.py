"""Role-based capabilities with optional per-user overrides (hybrid model).

Every user has a role (Admin / Partner / Manager / Employee). Each role has a set
of DEFAULT capabilities. Admin or Partner may then flip individual capabilities on
or off for a specific user; those overrides are stored as JSON on the user row.

    effective = role defaults, with the user's overrides applied on top.

Admin is always all-True (cannot be locked out). Visibility ("what a user can SEE")
is derived from role via scope(), separate from these action capabilities.
"""
import json

# All toggleable action capabilities.
CAPABILITIES = [
    "create_task", "assign_task", "assign_self", "delegate_task",
    "delete_task", "delete_client", "delete_service", "delete_user", "manage_users",
    "manage_clients", "manage_services", "manage_billing", "reset_timer",
]

# Human-friendly labels for the permission-toggle UI.
CAPABILITY_LABELS = {
    "create_task": "Create tasks",
    "assign_task": "Assign tasks to others",
    "assign_self": "Assign tasks to themselves",
    "delegate_task": "Delegate tasks to others",
    "delete_task": "Delete tasks",
    "delete_client": "Delete clients",
    "delete_service": "Delete services",
    "delete_user": "Delete staff accounts",
    "manage_users": "Add / edit staff accounts",
    "manage_clients": "Create / edit clients",
    "manage_services": "Create / edit services",
    "manage_billing": "Manage billing (Billed / Received)",
    "reset_timer": "Reset task timers",
}

VALID_ROLES = ("Admin", "Partner", "Manager", "Employee")


def _all(value):
    return {c: value for c in CAPABILITIES}


# Default capability set per role.
ROLE_DEFAULTS = {
    "Admin": _all(True),
    "Partner": _all(True),
    # Manager/Reviewer: can create + assign + delegate (to employees), nothing destructive.
    "Manager": {**_all(False), "create_task": True, "assign_task": True, "delegate_task": True},
    "Employee": _all(False),
}


def effective(role, overrides_json=None):
    """Return the effective capability dict for a role + per-user overrides."""
    base = dict(ROLE_DEFAULTS.get(role, ROLE_DEFAULTS["Employee"]))
    if role == "Admin":
        return _all(True)  # Admin is never restricted.
    if overrides_json:
        try:
            ov = json.loads(overrides_json) if isinstance(overrides_json, str) else dict(overrides_json)
            for k, v in ov.items():
                if k in base:
                    base[k] = bool(v)
        except (ValueError, TypeError):
            pass
    return base


def scope(role):
    """What a role can SEE: 'all' (Admin/Partner), 'team' (Manager), 'own' (Employee)."""
    if role in ("Admin", "Partner"):
        return "all"
    if role == "Manager":
        return "team"
    return "own"


def sanitize_overrides(overrides):
    """Keep only known capability keys, coerced to bool. Returns a JSON string or None."""
    if not isinstance(overrides, dict):
        return None
    clean = {k: bool(v) for k, v in overrides.items() if k in CAPABILITIES}
    return json.dumps(clean) if clean else None
