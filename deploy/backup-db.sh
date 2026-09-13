#!/usr/bin/env bash
# Nightly production Postgres backup, with rotation. Run ON THE VPS via cron (see the
# crontab line at the bottom of this file's comments) — there is no managed-provider backup
# net here since Postgres runs directly on the same box as the app.
#
# Reads DB credentials from app.secrets (same file the app itself uses), so this always
# backs up whatever database the running app is actually pointed at.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_FILE="$REPO_DIR/app.secrets"
BACKUP_DIR="$REPO_DIR/db-backups"
KEEP_DAYS=14

if [ ! -f "$SECRETS_FILE" ]; then
  echo "app.secrets not found at $SECRETS_FILE" >&2
  exit 1
fi

# app.secrets is a plain KEY=VALUE file (dotenv format) — source only the vars we need.
# Node's `dotenv` package (what the app itself uses to read this same file) strips a
# trailing \r (Windows line ending) and one layer of surrounding '...'/"..." quotes from
# each value; a raw grep+cut does neither, so a value written with either would silently
# reach pg_dump with extra characters the app itself never sees — e.g. a quoted password
# failing auth here while the app connects fine. read_secret replicates dotenv's stripping
# so this script is reading the exact same effective value the app does.
read_secret() {
  local raw
  raw="$(grep -E "^$1=" "$SECRETS_FILE" | head -n1 | cut -d= -f2-)"
  raw="${raw%$'\r'}"
  if [[ "$raw" == \"*\" && "$raw" == *\" ]] || [[ "$raw" == \'*\' && "$raw" == *\' ]]; then
    raw="${raw:1:-1}"
  fi
  printf '%s' "$raw"
}

SQL_HOST="$(read_secret SQL_HOST)"
SQL_USER="$(read_secret SQL_USER)"
SQL_PASSWORD="$(read_secret SQL_PASSWORD)"
SQL_DB_NAME="$(read_secret SQL_DB_NAME)"

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_FILE="$BACKUP_DIR/erp_production-$STAMP.dump"

echo "==> Backing up $SQL_DB_NAME@$SQL_HOST to $OUT_FILE"
PGPASSWORD="$SQL_PASSWORD" pg_dump -h "$SQL_HOST" -U "$SQL_USER" -d "$SQL_DB_NAME" -F c -f "$OUT_FILE"

echo "==> Backup complete: $(du -h "$OUT_FILE" | cut -f1)"

echo "==> Rotating: deleting backups older than $KEEP_DAYS days"
find "$BACKUP_DIR" -name 'erp_production-*.dump' -mtime "+$KEEP_DAYS" -print -delete

# --- One-time cron setup (run as the deploy user, not root) ---
# crontab -e
# Add this line to run nightly at 2:30am server time:
#   30 2 * * * /home/deploy/apps/erp/deploy/backup-db.sh >> /home/deploy/apps/erp/deploy/logs/backup.log 2>&1
