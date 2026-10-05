#!/usr/bin/env bash
# Re-establishes the OLD primary as the new standby, after it's healthy again post-maintenance
# (or after being rebuilt, if it failed outright). Run ON THE OLD PRIMARY, as the deploy user.
#
# Its data is stale the moment failover.sh promotes the other box — this does NOT try to
# reconcile or merge anything, it wipes this box's database and re-clones from whichever box
# is currently primary. That is the correct, safe behavior for physical replication; it is
# also why this script asks for confirmation before doing it.
set -euo pipefail
NEW_PRIMARY_IP="${1:-}"
[ -n "$NEW_PRIMARY_IP" ] || { echo "Usage: bash deploy/failback.sh <new_primary_ip>"; exit 1; }

echo "==> This will WIPE this box's local Postgres data and re-clone it from $NEW_PRIMARY_IP."
echo "    Only run this once you've confirmed $NEW_PRIMARY_IP is the box actually serving"
echo "    production traffic right now."
read -r -p "Type 'yes' to continue: " CONFIRM
[ "$CONFIRM" = "yes" ] || { echo "Aborted."; exit 1; }

echo "==> Stopping the app on this box (it must not serve stale data)"
pm2 stop deploy/ecosystem.config.cjs 2>/dev/null || true

bash "$(dirname "${BASH_SOURCE[0]}")/setup-replication.sh" standby "$NEW_PRIMARY_IP"

echo ""
echo "==> This box is now the standby again, streaming from $NEW_PRIMARY_IP. It is NOT"
echo "    serving traffic (app is stopped) — leave it that way until the next failover."
