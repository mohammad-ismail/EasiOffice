import os
import base64
import hmac
import hashlib
import binascii
import pyaes
from werkzeug.security import generate_password_hash, check_password_hash

# The 256-bit AES key for the credential vault. It is persisted on the mounted data
# volume (NOT inside the ephemeral container layer), so it survives rebuilds.
# Overridable via SECRET_KEY_PATH (set in docker-compose.yml).
#
# CRITICAL: back this file up together with the database. If it is lost or regenerated,
# every stored vault password becomes permanently undecryptable.
_ROOT = os.path.dirname(os.path.dirname(__file__))
KEY_FILE = os.environ.get("SECRET_KEY_PATH", os.path.join(_ROOT, "data", "secret.key"))

os.makedirs(os.path.dirname(KEY_FILE), exist_ok=True)

if not os.path.exists(KEY_FILE):
    with open(KEY_FILE, "wb") as f:
        f.write(os.urandom(32)) # 256-bit key

with open(KEY_FILE, "rb") as f:
    AES_KEY = f.read()

# Separate MAC key for the vault, derived from the master key so we don't reuse the
# same key for encryption and authentication. (Encrypt-then-MAC integrity protection.)
_VAULT_MAC_KEY = hmac.new(AES_KEY, b"easibusiness-vault-hmac-key-v1", hashlib.sha256).digest()
_VAULT_VERSION = b"\x01"  # marks the authenticated (v1) ciphertext format

# --- Flask session signing key -------------------------------------------------
# Separate from the vault key. Persisted so that signed session cookies remain
# valid across container restarts (otherwise every restart logs everyone out).
FLASK_SECRET_FILE = os.environ.get("FLASK_SECRET_PATH", os.path.join(_ROOT, "data", "flask_secret.key"))

if not os.path.exists(FLASK_SECRET_FILE):
    with open(FLASK_SECRET_FILE, "wb") as f:
        f.write(os.urandom(32))

with open(FLASK_SECRET_FILE, "rb") as f:
    FLASK_SECRET_KEY = f.read()


# --- User login password hashing (ONE-WAY) ------------------------------------
# User account passwords must NOT be reversible. These wrap Werkzeug's hashing
# (pbkdf2-sha256 by default), which ships with Flask — no extra dependency.
def hash_password(plain_text_password: str) -> str:
    """One-way hash for storing a user-account login password."""
    return generate_password_hash(plain_text_password)


def verify_password(stored_value: str, provided_password: str):
    """Verify a login password against the stored value.

    Returns (is_valid, needs_rehash). `needs_rehash` is True when the stored
    value is in the legacy reversible-AES format, so the caller can transparently
    upgrade it to a one-way hash on the next successful login.
    """
    if not stored_value:
        return False, False
    # New scheme: Werkzeug one-way hash (prefixed with the method name)
    if stored_value.startswith(("pbkdf2:", "scrypt:", "argon2")):
        try:
            return check_password_hash(stored_value, provided_password), False
        except Exception:
            return False, False
    # Legacy scheme: reversible AES blob -> verify, then flag for re-hashing
    try:
        if decrypt_password(stored_value) == provided_password:
            return True, True
    except Exception:
        pass
    return False, False


def _ctr_crypt(iv: bytes, data: bytes) -> bytes:
    """AES-256-CTR transform (symmetric: same call encrypts and decrypts)."""
    counter = pyaes.Counter(int(binascii.hexlify(iv), 16))
    aes = pyaes.AESModeOfOperationCTR(AES_KEY, counter=counter)
    return aes.encrypt(data)


def encrypt_password(plain_text_password: str) -> str:
    """Encrypt a vault password with AES-256-CTR, then authenticate with HMAC-SHA256.

    Output (base64): version(1) || iv(16) || ciphertext || hmac(32)
    The HMAC lets decryption detect any tampering with the stored ciphertext.
    """
    iv = os.urandom(16)
    ct = _ctr_crypt(iv, plain_text_password.encode('utf-8'))
    body = _VAULT_VERSION + iv + ct
    tag = hmac.new(_VAULT_MAC_KEY, body, hashlib.sha256).digest()
    return base64.b64encode(body + tag).decode('utf-8')


def decrypt_password(encrypted_data: str) -> str:
    """Decrypt a vault password.

    Verifies the HMAC for the authenticated (v1) format and refuses tampered data.
    Falls back to the legacy unauthenticated AES-CTR format for older entries.
    """
    try:
        raw = base64.b64decode(encrypted_data)
    except Exception:
        return "ERROR_DECRYPTING"

    # Authenticated v1 format: version || iv(16) || ct || hmac(32)
    if len(raw) >= 1 + 16 + 32 and raw[:1] == _VAULT_VERSION:
        body, tag = raw[:-32], raw[-32:]
        expected = hmac.new(_VAULT_MAC_KEY, body, hashlib.sha256).digest()
        if hmac.compare_digest(tag, expected):
            try:
                iv, ct = body[1:17], body[17:]
                return _ctr_crypt(iv, ct).decode('utf-8')
            except Exception:
                return "ERROR_DECRYPTING"
        # version byte matched but HMAC failed -> tampered, or actually legacy data
        # whose first byte happened to be 0x01; fall through to the legacy path.

    # Legacy unauthenticated format: iv(16) || ct
    try:
        iv, ct = raw[:16], raw[16:]
        return _ctr_crypt(iv, ct).decode('utf-8')
    except Exception:
        return "ERROR_DECRYPTING"
