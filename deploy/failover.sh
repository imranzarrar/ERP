#!/usr/bin/env bash
# Promotes THIS box (the standby) to primary and gets the app serving from here. Run ON THE
# STANDBY, as the deploy user, from inside the repo — after deploy/setup-replication.sh has
# been run on both sides and this box has had the app deployed at least once (deploy.sh) so
# it's ready to serve, not just holding a database.
#
# What this does NOT do: it does not touch DNS. DNS/registrar setup varies per provider and
# isn't safely scriptable here — see the printed checklist at the end. It also does not
# touch the old primary (it may be mid-maintenance, or dead) — that side is
# deploy/failback.sh's job, once it's healthy again.
#
# Guardrail, same as every other production script in this repo: confirms before the
# irreversible step (promoting). NOT yet rehearsed against a real second box.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "==> Checking this box is actually a standby (in recovery)..."
IN_RECOVERY="$(sudo -u postgres psql -tAc "SELECT pg_is_in_recovery();")"
[ "$IN_RECOVERY" = "t" ] || { echo "This box is NOT a Postgres standby — refusing to 'promote' a primary."; exit 1; }

echo "==> Current replication lag (want this at or near 0 before a PLANNED failover):"
sudo -u postgres psql -c "SELECT now() - pg_last_xact_replay_timestamp() AS lag;"
echo ""
echo "For a PLANNED maintenance failover: the primary should still be reachable and idle"
echo "right now (writes stopped there first) so lag above is genuinely zero — check it, and"
echo "re-run this script's lag check again if it isn't, rather than proceeding with a gap."
echo "For an UNPLANNED failure the primary is already gone, so some lag (a few seconds of"
echo "the most recent writes) is the accepted, documented tradeoff of async replication."
echo ""
read -r -p "Type 'promote' to continue: " CONFIRM
[ "$CONFIRM" = "promote" ] || { echo "Aborted."; exit 1; }

echo "==> Promoting this Postgres instance to primary (read-write)"
sudo -u postgres psql -c "SELECT pg_promote();"
sleep 2
sudo -u postgres psql -c "SELECT pg_is_in_recovery();"  # should now print 'f'

echo "==> Pointing app.secrets at THIS box's own database (colocated, so still local/fast)"
sed -i -E 's/^SQL_HOST=.*/SQL_HOST=localhost/' app.secrets
sed -i -E 's/^TENANT_DB_HOST=.*/TENANT_DB_HOST=localhost/' app.secrets 2>/dev/null || true
grep -q '^TENANT_DB_USER=' app.secrets || echo "!! TENANT_DB_USER/PASSWORD missing from app.secrets on this box — add them (same values as the primary) before starting the app, or every tenant-scoped request will fail."

echo "==> Building and starting the app here (if not already running)"
npm ci
npm run build
pm2 start deploy/ecosystem.config.cjs 2>/dev/null || pm2 reload deploy/ecosystem.config.cjs
pm2 status

echo ""
echo "==> Database and app are live on THIS box. Remaining manual steps:"
echo "    1. DNS: point warraq.compbrain.io's A record at this box's IP ($(curl -s ifconfig.me 2>/dev/null || echo '<check manually>'))."
echo "       Propagation depends on the record's TTL — this is why the TTL should be"
echo "       lowered well before a planned maintenance window (see the HA plan)."
echo "    2. Nginx/SSL: this box needs its own Nginx site + Certbot certificate for the"
echo "       domain (deploy/nginx.erp.conf.template + deploy/nginx-tuning.sh), set up ahead"
echo "       of time, not during the failover itself."
echo "    3. Verify: npx tsx scripts/verify-tenant-isolation.ts, then log in and check a"
echo "       report and an invoice save before considering this box fully live."
echo "    4. When the old primary is healthy again, DO NOT just point traffic back at it —"
echo "       its data is now stale. Run deploy/failback.sh to re-clone it as the new standby."
