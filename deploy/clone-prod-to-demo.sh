#!/usr/bin/env bash
# Copies the LIVE database into the 2.0 demo (or local v2) database and scrubs it. It only ever READS the live database
# (pg_dump on a read-only connection); it never writes to it, never stops or restarts anything, and refuses to restore into any
# database that is not clearly a demo/v2 one.
#
# On the VPS, as the deploy user, from the DEMO checkout (~/apps/erp-demo):
#     bash deploy/clone-prod-to-demo.sh
#   The live credentials come from ~/.live-readonly (the read-only role made by create-agent-access.sh) or, for the deploy user, from
#   ~/apps/erp/app.secrets (read only); the target is this checkout's app.secrets.
#
# On your own machine (local 2.0 copy, E:\ERP-2.0), with the SSH tunnel open (bash deploy/db-tunnel.sh -> localhost:5433):
#     SRC_HOST=localhost SRC_PORT=5433 SRC_USER=<live db user> SRC_DB=<live db name> bash deploy/clone-prod-to-demo.sh
#   The live password is asked at a hidden prompt (never stored). The target is E:\ERP-2.0\app.secrets (SQL_DB_NAME must be erp_v2*).
#
# Steps: 1 dump live -> 2 show what is being copied -> 3 confirm -> 4 restore into the demo DB (its public schema is replaced)
#        -> 5 grants for the restricted tenant role -> 6 scrub (deploy/scrub-demo-data.sql) -> 7 proof counts.
# Afterwards run the 2.0 release/db:push so the demo database moves to the 2.0 schema (that is the rehearsal).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

die() { echo "ERROR: $*" >&2; exit 1; }
say() { echo ""; echo "==> $*"; }

read_secret_from() { # file key
  local raw
  raw="$(grep -E "^$2=" "$1" 2>/dev/null | head -n1 | cut -d= -f2- || true)"
  raw="${raw%$'\r'}"
  if [[ "$raw" == \"*\" && "$raw" == *\" ]] || [[ "$raw" == \'*\' && "$raw" == *\' ]]; then raw="${raw:1:-1}"; fi
  printf '%s' "$raw"
}

# ---- target (demo / v2): always this checkout's own app.secrets ----
[ -f app.secrets ] || die "app.secrets not found in $REPO_DIR — run this from the demo / v2 checkout."
DST_HOST="$(read_secret_from app.secrets SQL_HOST)"; DST_HOST="${DST_HOST:-localhost}"
DST_PORT="${DST_PORT:-5432}"
DST_USER="$(read_secret_from app.secrets SQL_USER)"
DST_PW="$(read_secret_from app.secrets SQL_PASSWORD)"
DST_DB="$(read_secret_from app.secrets SQL_DB_NAME)"
[ -n "$DST_USER" ] && [ -n "$DST_DB" ] || die "Could not read SQL_USER / SQL_DB_NAME from app.secrets."
case "$DST_DB" in erp_demo*|erp_v2*) ;; *) die "Target database '$DST_DB' is not a demo/v2 database (must start with erp_demo or erp_v2). Refusing to restore into it." ;; esac

# ---- source (live): read-only ----
LIVE_ENV="${SRC_ENV_FILE:-$HOME/apps/erp/app.secrets}"
RO_FILE="${SRC_CRED_FILE:-$HOME/.live-readonly}"
if [ -z "${SRC_USER:-}" ] && [ -f "$RO_FILE" ]; then
  # Read-only login created by deploy/create-agent-access.sh (role erp_readonly, can read live but never write).
  SRC_HOST="$(read_secret_from "$RO_FILE" SRC_HOST)"; SRC_PORT="$(read_secret_from "$RO_FILE" SRC_PORT)"
  SRC_USER="$(read_secret_from "$RO_FILE" SRC_USER)"; SRC_DB="$(read_secret_from "$RO_FILE" SRC_DB)"; SRC_PW="$(read_secret_from "$RO_FILE" SRC_PW)"
fi
if [ -z "${SRC_USER:-}" ] && [ -f "$LIVE_ENV" ]; then
  SRC_HOST="$(read_secret_from "$LIVE_ENV" SQL_HOST)"; SRC_HOST="${SRC_HOST:-localhost}"
  SRC_USER="$(read_secret_from "$LIVE_ENV" SQL_USER)"
  SRC_DB="$(read_secret_from "$LIVE_ENV" SQL_DB_NAME)"
  SRC_PW="$(read_secret_from "$LIVE_ENV" SQL_PASSWORD)"
fi
SRC_HOST="${SRC_HOST:-localhost}"; SRC_PORT="${SRC_PORT:-5432}"
[ -n "${SRC_USER:-}" ] && [ -n "${SRC_DB:-}" ] || die "Live connection unknown: set SRC_USER and SRC_DB (and SRC_HOST/SRC_PORT if needed), or run on the VPS where $LIVE_ENV exists."
if [ -z "${SRC_PW:-}" ]; then read -r -s -p "Password for live database user $SRC_USER: " SRC_PW; echo; fi
if [ "$SRC_HOST:$SRC_PORT:$SRC_DB" = "$DST_HOST:$DST_PORT:$DST_DB" ]; then die "Source and target are the same database."; fi

DUMP_DIR="$(mktemp -d)"; chmod 700 "$DUMP_DIR"
DUMP="$DUMP_DIR/live.dump"
cleanup() { rm -rf "$DUMP_DIR"; }
trap cleanup EXIT

dsrc() { PGPASSWORD="$SRC_PW" PGOPTIONS='-c default_transaction_read_only=on' "$@"; }
ddst() { PGPASSWORD="$DST_PW" "$@"; }

say "Live (read-only):   $SRC_USER@$SRC_HOST:$SRC_PORT/$SRC_DB"
say "Target (replaced):  $DST_USER@$DST_HOST:$DST_PORT/$DST_DB"
dsrc psql -h "$SRC_HOST" -p "$SRC_PORT" -U "$SRC_USER" -d "$SRC_DB" -At -c "select 'companies: '||count(*) from companies" \
  -c "select 'invoices: '||count(*) from invoices" -c "select 'journal entries: '||count(*) from journal_entries" \
  -c "select 'database size: '||pg_size_pretty(pg_database_size(current_database()))"
echo "After the copy, the target database will hold a SCRUBBED copy: ZATCA keys removed and ZATCA off, sessions cleared,"
echo "every password replaced by the demo password, emails and phones removed."
read -r -p "Replace everything in $DST_DB with this copy? [type yes to continue]: " ANSWER
[ "$ANSWER" = "yes" ] || die "Not confirmed — nothing changed."

# Demo password: reuse the stored hash (~/.demo-password-hash, written by set-demo-password.sh; only the bcrypt hash is ever stored),
# unless DEMO_PASSWORD is given or no hash is stored yet, in which case ask for one.
HASH_FILE="${DEMO_HASH_FILE:-$HOME/.demo-password-hash}"
if [ -z "${DEMO_PASSWORD:-}" ] && [ -s "$HASH_FILE" ]; then
  PWHASH="$(cat "$HASH_FILE")"
else
  if [ -z "${DEMO_PASSWORD:-}" ]; then
    read -r -s -p "Demo password every user will get (min 8 chars): " DEMO_PASSWORD; echo
  fi
  [ "${#DEMO_PASSWORD}" -ge 8 ] || die "Demo password too short."
  PWHASH="$(DEMO_PASSWORD="$DEMO_PASSWORD" node -e "process.stdout.write(require('bcrypt').hashSync(process.env.DEMO_PASSWORD, 10))")"
  unset DEMO_PASSWORD
fi
[ -n "$PWHASH" ] || die "Could not hash the demo password (run npm ci in this checkout first)."

say "[1/5] Dumping live (read-only connection)"
dsrc pg_dump -h "$SRC_HOST" -p "$SRC_PORT" -U "$SRC_USER" -d "$SRC_DB" --format=custom --no-owner --no-privileges -f "$DUMP"
echo "Dump size: $(du -h "$DUMP" | cut -f1)"

say "[2/5] Replacing the public schema in $DST_DB"
ddst psql -h "$DST_HOST" -p "$DST_PORT" -U "$DST_USER" -d "$DST_DB" -v ON_ERROR_STOP=1 -q \
  -c "DROP SCHEMA IF EXISTS public CASCADE" -c "CREATE SCHEMA public"
ddst pg_restore -h "$DST_HOST" -p "$DST_PORT" -U "$DST_USER" -d "$DST_DB" --no-owner --no-privileges --exit-on-error "$DUMP"

say "[3/5] Grants for the restricted tenant role (row-level security connects as erp_app_tenant)"
ddst psql -h "$DST_HOST" -p "$DST_PORT" -U "$DST_USER" -d "$DST_DB" -v ON_ERROR_STOP=1 -q \
  -c "GRANT USAGE ON SCHEMA public TO erp_app_tenant" \
  -c "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO erp_app_tenant" \
  -c "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO erp_app_tenant"   -c "ALTER DEFAULT PRIVILEGES FOR ROLE \"$DST_USER\" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO erp_app_tenant"   -c "ALTER DEFAULT PRIVILEGES FOR ROLE \"$DST_USER\" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO erp_app_tenant"

say "[4/5] Scrubbing"
ddst psql -h "$DST_HOST" -p "$DST_PORT" -U "$DST_USER" -d "$DST_DB" -v ON_ERROR_STOP=1 -v "pwhash=$PWHASH" -f deploy/scrub-demo-data.sql

say "[5/5] Done"
echo "The demo database is now a scrubbed copy of live as of right now. Its schema is still the 1.0 schema."
echo "Next: apply the 2.0 schema (db:push / release-demo.sh, read the plan) and run the consistency checks."
echo "Live was only read: nothing on it changed."
