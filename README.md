# EasiOffice

Local-first office-management app for Indian CA firms: client directory, compliance
task board, service catalog, timesheets, an AES-encrypted credential vault, staff/role
management, and an activity audit log.

**Stack:** Flask + SQLite (backend) · Vue 3 + Tailwind + FontAwesome (frontend, vendored
locally — no CDN/internet needed at runtime) · Docker.

---

## Run locally (development)

```bash
cd backend && pip install -r requirements.txt          # Flask + pyaes
cd ..  && python -m backend.main                        # serves on http://127.0.0.1:8000
```

The database and encryption keys are created automatically under `./data/` on first run.

---

## Deploy on Synology (DS225+ / DSM 7.2, Container Manager)

The DS225+ is x86-64, so the `python:3.11-slim` (amd64) image runs natively. RAM/CPU use
is small (well within 2 GB).

1. **Copy the project** to the NAS, e.g. `/volume1/docker/ca-office/`.
2. **Set the initial admin password** in `docker-compose.yml` (`ADMIN_PASSWORD`).
3. **Container Manager → Project → Create**, point it at that folder (it uses
   `docker-compose.yml`). Build & run.
4. The app is now on `http://<nas-ip>:8000`. Data persists in
   `/volume1/docker/ca-office/data/` (created by the volume mount).

### Put it behind HTTPS (strongly recommended)

Vault passwords and logins should never travel in clear text, even on the LAN.

1. **Control Panel → Login Portal → Advanced → Reverse Proxy → Create**
   - Source: `https://office.<your-domain-or-nas>` (port 443)
   - Destination: `http://localhost:8000`
2. Use a DSM certificate (Let's Encrypt or self-signed) for the source hostname.
3. In `docker-compose.yml`, **uncomment**:
   ```yaml
   - TRUST_PROXY=true
   - SESSION_COOKIE_SECURE=true
   ```
   `TRUST_PROXY` makes the app see the real client IP (so the LAN-only filter keeps
   working behind the proxy) and the HTTPS scheme; `SESSION_COOKIE_SECURE` stops the
   session cookie from ever being sent over plain HTTP.
4. Recreate the container.

---

## Backups — read this

`./data/` contains **everything**: the database **and** the encryption keys.

- `easibusiness.db` — all client/task/timesheet/vault data
- `secret.key` — the AES key for the vault. **If this is lost, every stored vault
  password becomes permanently unrecoverable.**
- `flask_secret.key` — signs login sessions.

Back up the whole `data/` folder regularly (Synology **Hyper Backup** or a snapshot
schedule). Test a restore at least once.

---

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `DB_PATH` | `data/easibusiness.db` | SQLite database location |
| `SECRET_KEY_PATH` | `data/secret.key` | AES vault key location |
| `FLASK_SECRET_PATH` | `data/flask_secret.key` | session signing key location |
| `ADMIN_PASSWORD` | `admin123` (warns) | initial admin password (first seed only) |
| `TZ` | `Asia/Kolkata` | timezone for timestamps |
| `TRUST_PROXY` | `false` | honour `X-Forwarded-*` (set `true` behind the reverse proxy) |
| `SESSION_COOKIE_SECURE` | `false` | HTTPS-only session cookie (set `true` behind HTTPS) |

---

## Security status

**Implemented:** server-side signed-cookie sessions; server-enforced roles
(`@login_required` / `@admin_required`) on every endpoint; one-way password hashing
(scrypt) with auto-migration from the old scheme; persistent, backable keys; parameterized
SQL; locally-vendored frontend (no CDN).

**Still recommended:** authenticated encryption for the vault (Fernet/AES-GCM instead of
AES-CTR); server-side input validation; login rate-limiting; a production WSGI server
(waitress) instead of the Flask dev server.
