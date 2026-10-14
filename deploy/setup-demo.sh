#!/usr/bin/env bash
# ALTERNATIVE to deploy/create-agent-access.sh (which does all of this as root and also prepares a restricted demo user).
# One-time setup of the 2.0 DEMO database and role on the VPS, next to live. Run as the deploy user, from the DEMO checkout:
#
#     git clone --branch v2 <same repo URL live uses> ~/apps/erp-demo      # a separate folder; ~/apps/erp (live) is never touched
#     cd ~/apps/erp-demo && bash deploy/setup-demo.sh
#
# What it does (and ONLY this):
#   1. checks port 4000 is free and the folder really is the demo one
#   2. creates the Postgres role erp_demo and the database erp_demo (new, empty, owned by erp_demo)
#   3. lets the existing restricted role erp_app_tenant connect to erp_demo (a GRANT; the role's password is NOT changed)
# It does not touch the live database, the live role passwords, Nginx, the firewall, or any live process.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"
die() { echo "ERROR: $*" >&2; exit 1; }
say() { echo ""; echo "==> $*"; }

[ "$(id -un)" = "deploy" ] || die "Run as the deploy user (su - deploy)."
case "$REPO_DIR" in *erp-demo*) ;; *) die "This folder ($REPO_DIR) is not the demo checkout (its path must contain 'erp-demo'). Refusing, so live is never touched." ;; esac
[ "$(git rev-parse --abbrev-ref HEAD)" = "v2" ] || die "The demo checkout must be on branch v2."

if ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ':4000$'; then die "Port 4000 is already in use."; fi
say "Port 4000 is free"

PSQL="sudo -u postgres psql -v ON_ERROR_STOP=1 -At"
$PSQL -d postgres -c "select 1 from pg_roles where rolname='erp_app_tenant'" | grep -q 1 || die "Role erp_app_tenant does not exist (live RLS setup missing?)."
if $PSQL -d postgres -c "select 1 from pg_database where datname='erp_demo'" | grep -q 1; then die "Database erp_demo already exists. Nothing changed. (To refill it use deploy/clone-prod-to-demo.sh.)"; fi

read -r -s -p "New password for the Postgres role erp_demo (letters and digits, 20+ chars; goes into app.secrets as SQL_PASSWORD): " DEMO_PW; echo
read -r -s -p "Repeat: " DEMO_PW2; echo
[ -n "$DEMO_PW" ] && [ "$DEMO_PW" = "$DEMO_PW2" ] || die "Passwords empty or different."
[[ "$DEMO_PW" =~ ^[A-Za-z0-9]{20,}$ ]] || die "Use letters and digits only, at least 20 characters."

say "Creating role erp_demo and database erp_demo"
sudo -u postgres psql -v ON_ERROR_STOP=1 -v pw="$DEMO_PW" -d postgres <<'SQL'
SELECT format('CREATE ROLE erp_demo LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L', :'pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_demo') \gexec
SQL
unset DEMO_PW DEMO_PW2
$PSQL -d postgres -c "CREATE DATABASE erp_demo OWNER erp_demo"

say "Letting the restricted role connect to erp_demo (no password change, live database untouched)"
$PSQL -d postgres -c "GRANT CONNECT ON DATABASE erp_demo TO erp_app_tenant"
$PSQL -d erp_demo -c "GRANT USAGE ON SCHEMA public TO erp_app_tenant" \
  -c "GRANT erp_app_tenant TO erp_demo" \
  -c "ALTER DEFAULT PRIVILEGES FOR ROLE erp_demo IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO erp_app_tenant" \
  -c "ALTER DEFAULT PRIVILEGES FOR ROLE erp_demo IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO erp_app_tenant"

say "Done. Next, by hand:"
echo "  1. Create ~/apps/erp-demo/app.secrets from deploy/app.secrets.demo.example (new secrets; SQL_PASSWORD = the password you just typed)."
echo "  2. npm ci && npm run build"
echo "  3. bash deploy/clone-prod-to-demo.sh        (copies + scrubs live data into erp_demo; live is only read)"
echo "  4. bash deploy/release-demo.sh --force-schema   (applies the 2.0 schema: READ the plan; starts the app on port 4000)"
echo "  5. From your own machine:  ssh -L 4000:127.0.0.1:4000 deploy@<VPS>   then open http://127.0.0.1:4000"
