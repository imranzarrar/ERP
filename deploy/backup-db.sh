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
SQL_HOST="$(grep -E '^SQL_HOST=' "$SECRETS_FILE" | cut -d= -f2-)"
SQL_USER="$(grep -E '^SQL_USER=' "$SECRETS_FILE" | cut -d= -f2-)"
SQL_PASSWORD="$(grep -E '^SQL_PASSWORD=' "$SECRETS_FILE" | cut -d= -f2-)"
SQL_DB_NAME="$(grep -E '^SQL_DB_NAME=' "$SECRETS_FILE" | cut -d= -f2-)"

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
