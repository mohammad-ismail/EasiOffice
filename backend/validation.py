"""Lightweight server-side input validation (stdlib only).

These checks run on the backend so they cannot be bypassed by calling the API
directly (the HTML `pattern` attributes only protect the browser form). They mirror
the formats defined in the Technical Blueprint.
"""
import re

PAN_RE = re.compile(r'^[A-Z]{5}[0-9]{4}[A-Z]$')
GSTIN_RE = re.compile(r'^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$')
MOBILE_RE = re.compile(r'^[6-9][0-9]{9}$')
FY_RE = re.compile(r'^20[0-9]{2}-[0-9]{2}$')           # e.g. 2025-26
EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')


class ValidationError(Exception):
    """Raised on invalid input. main.py maps this to an HTTP 400 JSON response."""
    def __init__(self, message):
        self.message = message
        super().__init__(message)


def require(data, *fields):
    """Ensure `data` is a dict and the named fields are present and non-empty."""
    if not isinstance(data, dict):
        raise ValidationError("Request body must be a JSON object.")
    missing = [f for f in fields if data.get(f) in (None, "")]
    if missing:
        raise ValidationError("Missing required field(s): " + ", ".join(missing))


def validate_pan(value):
    if value and not PAN_RE.match(str(value).upper()):
        raise ValidationError(f"Invalid PAN '{value}'. Expected format AAAAA9999A.")


def validate_gstin(value):
    # GSTIN is optional; only validate when provided
    if value and not GSTIN_RE.match(str(value).upper()):
        raise ValidationError(f"Invalid GSTIN '{value}'. Expected 15-character GST number.")


def validate_mobile(value):
    if value and not MOBILE_RE.match(str(value)):
        raise ValidationError(f"Invalid mobile '{value}'. Expected 10 digits starting 6-9.")


def validate_email(value):
    if value and not EMAIL_RE.match(str(value)):
        raise ValidationError(f"Invalid email '{value}'.")


def validate_financial_year(value):
    if value and not FY_RE.match(str(value)):
        raise ValidationError(f"Invalid financial year '{value}'. Expected e.g. 2025-26.")


def validate_role(value):
    if value not in ("Admin", "Partner", "Manager", "Employee"):
        raise ValidationError(f"Invalid role '{value}'. Must be Admin, Partner, Manager or Employee.")


def validate_int_range(value, low, high, name):
    try:
        ivalue = int(value)
    except (TypeError, ValueError):
        raise ValidationError(f"{name} must be a whole number.")
    if ivalue < low or ivalue > high:
        raise ValidationError(f"{name} must be between {low} and {high}.")
    return ivalue
