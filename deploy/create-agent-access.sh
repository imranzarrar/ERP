#!/usr/bin/env bash
# ONE-TIME, run as ROOT on the VPS. Prepares everything the 2.0 DEMO needs and a restricted login the assistant can use to manage it.
# It never touches the live app, the live files, the live PM2 process, Nginx or the firewall. The ONLY change that reaches live is a
# read-only database login for taking the (scrubbed) demo copy: a new Postgres role `erp_readonly` that may connect to the live database
# and read it (predefined role pg_read_all_data, with row-level security bypassed, which a full dump needs) but not write, and nothing else.
#
#   scp deploy/create-agent-access.sh root@<VPS>:/root/            (from your own machine)
#   bash /root/create-agent-access.sh "<the PUBLIC key line>" "<your public IP address>"
#
# What it creates:
#   * OS user `warraq-demo` (no password, no sudo rights at all). Its own home, its own PM2 list, its own boot unit (pm2-warraq-demo).
#   * authorized_keys for it with ONE key, locked to your IP and stripped of forwarding/agent features (`restrict,pty`).
#   * Postgres: role `erp_demo` + empty database `erp_demo` (random password), the restricted tenant role granted on it only,
#     and the read-only role `erp_readonly` (random password) for reading live.
#   * /home/warraq-demo/app.secrets.staged : the demo's complete app.secrets (random secrets generated here, never printed;
#     the tenant role password is copied from live's file, never printed). The assistant moves it into the checkout.
#   * /home/warraq-demo/.live-readonly : the read-only login details, readable only by warraq-demo.
#   * a read-only GitHub deploy key for the demo checkout (its PUBLIC half is printed: add it in GitHub > repo > Settings > Deploy keys,
#     leave "Allow write access" OFF).
# Safe to run again: existing users/roles/databases are kept, nothing live is ever altered.
set -euo pipefail

DEMO_USER="warraq-demo"
DEMO_HOME="/home/$DEMO_USER"
LIVE_SECRETS="${LIVE_SECRETS:-/home/deploy/apps/erp/app.secrets}"
DEMO_DB="erp_demo"; DEMO_ROLE="erp_demo"; RO_ROLE="erp_readonly"
PUBKEY="${1:-}"; ALLOW_IP="${2:-}"

die() { echo "ERROR: $*" >&2; exit 1; }
say() { echo ""; echo "==> $*"; }
pg() { runuser -u postgres -- psql -v ON_ERROR_STOP=1 -At "$@"; }
rand() { openssl rand -hex 24; }
# (no `| grep -q` on pipelines: with pipefail a closed pipe can make a true answer look false)
has_role() { [ "$(pg -d postgres -c "select 1 from pg_roles where rolname='$1'")" = "1" ]; }
has_db() { [ "$(pg -d postgres -c "select 1 from pg_database where datname='$1'")" = "1" ]; }
secret_from() { # file key  (same parsing as the app: strips CR and quotes)
  local raw; raw="$(grep -E "^$2=" "$1" 2>/dev/null | head -n1 | cut -d= -f2- || true)"; raw="${raw%$'\r'}"
  if [[ "$raw" == \"*\" && "$raw" == *\" ]] || [[ "$raw" == \'*\' && "$raw" == *\' ]]; then raw="${raw:1:-1}"; fi
  printf '%s' "$raw"
}

[ "$(id -u)" = "0" ] || die "Run as root."
[ -f "$LIVE_SECRETS" ] || die "Live app.secrets not found at $LIVE_SECRETS (set LIVE_SECRETS=...)."
command -v psql >/dev/null && command -v openssl >/dev/null && command -v pm2 >/dev/null && command -v node >/dev/null || die "psql, openssl, node and pm2 must be installed (they are on this VPS)."
has_role erp_app_tenant || die "Role erp_app_tenant is missing (live row-level security not set up?)."
[ "$(pg -d postgres -c 'show server_version_num')" -ge 140000 ] || die "Postgres 14+ is needed for pg_read_all_data."
LIVE_DB="$(secret_from "$LIVE_SECRETS" SQL_DB_NAME)"; [ -n "$LIVE_DB" ] || die "Could not read SQL_DB_NAME from live app.secrets."
has_db "$LIVE_DB" || die "Live database $LIVE_DB not found."
[ "$LIVE_DB" != "$DEMO_DB" ] || die "Live and demo database names are the same."
[ -z "$(ss -ltn | awk '$4 ~ /:4000$/ {print "x"}')" ] || die "Port 4000 is already in use."
if [ -n "$PUBKEY" ]; then
  [[ "$PUBKEY" =~ ^ssh-ed25519\ AAAA[0-9A-Za-z+/=]+(\ .*)?$ ]] || die "The first argument must be an ssh-ed25519 PUBLIC key line."
  [[ "$ALLOW_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ || "$ALLOW_IP" == "any" ]] || die "Give your public IPv4 address (the key is locked to it) or the word any (no address restriction) as the second argument."
fi

say "OS user $DEMO_USER (no password, no sudo)"
if id "$DEMO_USER" >/dev/null 2>&1; then echo "exists — kept."; else adduser --disabled-password --gecos "Warraq 2.0 demo (managed by the assistant)" "$DEMO_USER" >/dev/null; fi
chmod 750 "$DEMO_HOME"
# adduser puts new users into the shared group `users` on this system; the demo user must not share a group with anyone.
gpasswd -d "$DEMO_USER" users >/dev/null 2>&1 || true
install -d -m 700 -o "$DEMO_USER" -g "$DEMO_USER" "$DEMO_HOME/.ssh" "$DEMO_HOME/apps"
for g in $(id -nG "$DEMO_USER"); do case "$g" in sudo|admin|root|deploy) die "$DEMO_USER is in the privileged group '$g' — remove it first." ;; esac; done

say "SSH access for the assistant"
AK="$DEMO_HOME/.ssh/authorized_keys"; touch "$AK"; chown "$DEMO_USER:$DEMO_USER" "$AK"; chmod 600 "$AK"
if [ -n "$PUBKEY" ]; then
  if [ "$ALLOW_IP" = "any" ]; then LINE="restrict,pty $PUBKEY"; else LINE="from=\"$ALLOW_IP\",restrict,pty $PUBKEY"; fi
  grep -qxF "$LINE" "$AK" || echo "$LINE" >> "$AK"
  if [ "$ALLOW_IP" = "any" ]; then echo "Key installed (no address restriction)."; else echo "Key installed, usable only from $ALLOW_IP."; fi
else
  echo "No key given — authorized_keys is empty. Re-run this script with the key line and your IP."
fi

say "GitHub read-only deploy key for the demo checkout"
GK="$DEMO_HOME/.ssh/github_deploy"
if [ ! -f "$GK" ]; then runuser -u "$DEMO_USER" -- ssh-keygen -q -t ed25519 -N "" -C "warraq-demo deploy key (read-only)" -f "$GK"; fi
SSHCFG="$DEMO_HOME/.ssh/config"
if ! grep -q "github.com" "$SSHCFG" 2>/dev/null; then
  printf 'Host github.com\n  IdentityFile ~/.ssh/github_deploy\n  IdentitiesOnly yes\n  StrictHostKeyChecking accept-new\n' > "$SSHCFG"
  chown "$DEMO_USER:$DEMO_USER" "$SSHCFG"; chmod 600 "$SSHCFG"
fi

say "Postgres: demo role + database, read-only role for live"
if ! has_role "$DEMO_ROLE"; then
  DEMO_PW="$(rand)"
  runuser -u postgres -- psql -v ON_ERROR_STOP=1 -v pw="$DEMO_PW" -d postgres <<SQL
SELECT format('CREATE ROLE $DEMO_ROLE LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L', :'pw') \gexec
SQL
  NEW_DEMO_ROLE=1
else
  NEW_DEMO_ROLE=0; echo "Role $DEMO_ROLE exists — its password is kept (the staged app.secrets is then NOT regenerated)."
fi
has_db "$DEMO_DB" || pg -d postgres -c "CREATE DATABASE $DEMO_DB OWNER $DEMO_ROLE"
pg -d postgres -c "GRANT CONNECT ON DATABASE $DEMO_DB TO erp_app_tenant"
pg -d "$DEMO_DB" -c "GRANT USAGE ON SCHEMA public TO erp_app_tenant" -c "GRANT erp_app_tenant TO $DEMO_ROLE" \
  -c "ALTER DEFAULT PRIVILEGES FOR ROLE $DEMO_ROLE IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO erp_app_tenant" \
  -c "ALTER DEFAULT PRIVILEGES FOR ROLE $DEMO_ROLE IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO erp_app_tenant"

RO="$DEMO_HOME/.live-readonly"
if ! has_role "$RO_ROLE"; then
  RO_PW="$(rand)"
  runuser -u postgres -- psql -v ON_ERROR_STOP=1 -v pw="$RO_PW" -d postgres <<SQL
SELECT format('CREATE ROLE $RO_ROLE LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE CONNECTION LIMIT 2 PASSWORD %L', :'pw') \gexec
SQL
  pg -d postgres -c "ALTER ROLE $RO_ROLE SET default_transaction_read_only = on" -c "ALTER ROLE $RO_ROLE SET statement_timeout = '10min'"
  ( umask 077; printf 'SRC_HOST=localhost\nSRC_PORT=5432\nSRC_USER=%s\nSRC_DB=%s\nSRC_PW=%s\n' "$RO_ROLE" "$LIVE_DB" "$RO_PW" > "$RO" )
  chown "$DEMO_USER:$DEMO_USER" "$RO"; chmod 600 "$RO"
fi
pg -d postgres -c "GRANT CONNECT ON DATABASE $LIVE_DB TO $RO_ROLE" -c "GRANT pg_read_all_data TO $RO_ROLE"
echo "$RO_ROLE can READ $LIVE_DB (every company: the dump needs row-level security bypassed). It cannot write: the role itself is read-only and every session defaults to read-only."

say "Demo app.secrets (staged, never printed)"
STAGED="$DEMO_HOME/app.secrets.staged"
if [ "$NEW_DEMO_ROLE" = "1" ] || [ ! -f "$STAGED" ]; then
  [ "$NEW_DEMO_ROLE" = "1" ] || die "Role $DEMO_ROLE already existed but no staged file exists: reset its password by hand, then re-run."
  TENANT_USER="$(secret_from "$LIVE_SECRETS" TENANT_DB_USER)"; TENANT_PW="$(secret_from "$LIVE_SECRETS" TENANT_DB_PASSWORD)"
  [ -n "$TENANT_PW" ] || die "TENANT_DB_PASSWORD not found in live app.secrets."
  CHROMIUM="$(secret_from "$LIVE_SECRETS" PLAYWRIGHT_CHROMIUM_PATH)"
  ( umask 077
    {
      echo "SQL_HOST=localhost"; echo "SQL_USER=$DEMO_ROLE"; echo "SQL_PASSWORD=$DEMO_PW"; echo "SQL_DB_NAME=$DEMO_DB"
      echo "TENANT_DB_USER=${TENANT_USER:-erp_app_tenant}"; echo "TENANT_DB_PASSWORD=$TENANT_PW"
      echo "SESSION_SECRET=$(rand)"; echo "ZATCA_KEY_ENCRYPTION_SECRET=$(rand)"
      echo "PORT=4000"; echo "HOST=127.0.0.1"; echo "SESSION_COOKIE_NAME=warraq2.sid"
      echo "APP_BASE_URL=http://localhost:4000"; echo "APP_ENV=demo"
      if [ -n "$CHROMIUM" ]; then echo "PLAYWRIGHT_CHROMIUM_PATH=$CHROMIUM"; fi
    } > "$STAGED" )
  chown "$DEMO_USER:$DEMO_USER" "$STAGED"; chmod 600 "$STAGED"
  echo "Written: $STAGED (no SMTP settings, no ZATCA live-call flag, new random secrets)."
else
  echo "Staged file already exists — kept."
  chown "$DEMO_USER:$DEMO_USER" "$STAGED"; chmod 600 "$STAGED"
fi
unset DEMO_PW RO_PW TENANT_PW 2>/dev/null || true

say "Boot-time start of the demo's own PM2 list (as $DEMO_USER, NOT root)"
env PATH="$PATH" "$(command -v pm2)" startup systemd -u "$DEMO_USER" --hp "$DEMO_HOME" >/dev/null
systemctl is-enabled "pm2-$DEMO_USER" >/dev/null && echo "pm2-$DEMO_USER is enabled."

say "Check: live is untouched"
echo "Live PM2 apps (as deploy):"; runuser -u deploy -- pm2 jlist 2>/dev/null | python3 -c "import sys,json; print(', '.join(f\"{a['name']}={a['pm2_env']['status']}\" for a in json.load(sys.stdin)))" 2>/dev/null || echo "(could not list — not an error)"
echo "Live health: HTTP $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health || true)"

say "Done. Next:"
echo "  1. Add this READ-ONLY deploy key in GitHub (repo > Settings > Deploy keys, write access OFF):"
cat "$GK.pub"
[ -n "$PUBKEY" ] || echo "  2. Re-run this script with the assistant's public key and your IP so it can log in."
echo "  3. Tell the assistant it is ready. It will connect as $DEMO_USER, clone branch v2 into ~/apps/erp-demo and set the demo up."
