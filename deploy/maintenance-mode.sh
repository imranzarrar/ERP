#!/usr/bin/env bash
# Toggle the site-wide maintenance page on or off, by creating/removing a sentinel file that
# deploy/nginx-snippets/erp-maintenance.conf checks. Run ON THE VPS as the deploy user.
#
# This does NOT edit nginx.conf and does NOT touch PM2/Postgres — it only flips whether
# Nginx serves deploy/maintenance.html (HTTP 503) instead of proxying to the app. That keeps
# it always safe to run, but it also means the ONE-TIME wiring step in
# deploy/nginx-snippets/erp-maintenance.conf's header comment (adding one include line to
# your live site config) must already be done, or toggling this flag has no visible effect.
#
# Usage:
#   bash deploy/maintenance-mode.sh on       # show the maintenance page to everyone
#   bash deploy/maintenance-mode.sh off      # resume normal traffic
#   bash deploy/maintenance-mode.sh status   # just report which state it's in
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLAG="$REPO_DIR/deploy/MAINTENANCE_ON"
ACTION="${1:-status}"

case "$ACTION" in
  on)
    touch "$FLAG"
    echo "==> Maintenance flag created: $FLAG"
    ;;
  off)
    rm -f "$FLAG"
    echo "==> Maintenance flag removed"
    ;;
  status)
    if [ -f "$FLAG" ]; then echo "Maintenance mode: ON"; else echo "Maintenance mode: OFF"; fi
    exit 0
    ;;
  *)
    echo "Usage: bash deploy/maintenance-mode.sh on|off|status" >&2
    exit 1
    ;;
esac

sudo nginx -t
sudo systemctl reload nginx
echo "==> nginx reloaded"
