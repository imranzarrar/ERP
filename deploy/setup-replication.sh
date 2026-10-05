#!/usr/bin/env bash
# Sets up Postgres streaming (physical) replication between the current production VPS
# (the "primary") and a second, independent VPS (the "standby") — see
# docs/high-availability-plan.md for the reasoning. This is a Postgres server feature, not
# application code: the app never knows replication is happening, it just connects to
# whichever host app.secrets' SQL_HOST currently points to.
#
# Run ONCE on each side, in this order — as the deploy user (uses sudo), from inside the
# repo. NOT yet rehearsed against a real second box (written 2026-09-22, before the standby
# VPS existed) — do a full dry run before trusting it for the actual maintenance window,
# per the plan's own "rehearse it" step.
#
#   On the PRIMARY (this production VPS):
#     bash deploy/setup-replication.sh primary <standby_ip>
#
#   On the STANDBY (the new, independent VPS — already provisioned via setup-server.sh,
#   so Node/Postgres/etc. are already installed there, but with an EMPTY database — this
#   script clones the primary's data onto it):
#     bash deploy/setup-replication.sh standby <primary_ip>
#
# Replication is ASYNCHRONOUS by design (not synchronous): synchronous would make every
# write on the primary wait for the cross-provider standby to confirm it, reintroducing the
# exact network-latency problem this whole design avoids by keeping app+DB colocated.
# Async means the standby can lag by a few seconds; for a PLANNED failover (the actual
# trigger for this work) that's a non-issue because deploy/failover.sh waits for the lag to
# reach zero before promoting. It only matters for a sudden, unannounced primary failure,
# where the last few seconds of writes could be lost — an accepted, documented tradeoff.
set -euo pipefail

ROLE="${1:-}"
PEER_IP="${2:-}"
REPL_USER="erp_replicator"
[ "$ROLE" = "primary" ] || [ "$ROLE" = "standby" ] || { echo "Usage: bash deploy/setup-replication.sh primary|standby <peer_ip>"; exit 1; }
[ -n "$PEER_IP" ] || { echo "Usage: bash deploy/setup-replication.sh $ROLE <peer_ip>"; exit 1; }

PG_VERSION="$(psql -V | grep -oE '[0-9]+' | head -1)"
PG_CONF_DIR="/etc/postgresql/${PG_VERSION}/main"
PG_DATA_DIR="/var/lib/postgresql/${PG_VERSION}/main"
[ -d "$PG_CONF_DIR" ] || { echo "Could not find $PG_CONF_DIR — check the Postgres version/layout on this box."; exit 1; }

if [ "$ROLE" = "primary" ]; then
  echo "==> Configuring PRIMARY for streaming replication to $PEER_IP"

  read -r -s -p "Password for new replication role '$REPL_USER': " REPL_PW; echo
  read -r -s -p "Repeat: " REPL_PW2; echo
  [ "$REPL_PW" = "$REPL_PW2" ] && [ -n "$REPL_PW" ] || { echo "Passwords empty or different."; exit 1; }

  sudo -u postgres psql -v ON_ERROR_STOP=1 -v pw="$REPL_PW" <<'SQL'
SELECT format('CREATE ROLE erp_replicator WITH REPLICATION LOGIN PASSWORD %L', :'pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_replicator') \gexec
SELECT format('ALTER ROLE erp_replicator WITH REPLICATION LOGIN PASSWORD %L', :'pw') \gexec
SQL
  unset REPL_PW REPL_PW2

  CONF="$PG_CONF_DIR/postgresql.conf"
  sudo cp "$CONF" "$CONF.bak-$(date +%Y%m%d)"
  sudo sed -i -E "s/^#?wal_level.*/wal_level = replica/" "$CONF"
  sudo sed -i -E "s/^#?max_wal_senders.*/max_wal_senders = 10/" "$CONF"
  sudo sed -i -E "s/^#?wal_keep_size.*/wal_keep_size = 1024/" "$CONF"
  grep -q "^wal_level" "$CONF" || echo "wal_level = replica" | sudo tee -a "$CONF" >/dev/null
  grep -q "^max_wal_senders" "$CONF" || echo "max_wal_senders = 10" | sudo tee -a "$CONF" >/dev/null
  grep -q "^wal_keep_size" "$CONF" || echo "wal_keep_size = 1024" | sudo tee -a "$CONF" >/dev/null

  HBA="$PG_CONF_DIR/pg_hba.conf"
  sudo cp "$HBA" "$HBA.bak-$(date +%Y%m%d)"
  LINE="host replication $REPL_USER $PEER_IP/32 scram-sha-256"
  grep -qF "$LINE" "$HBA" || echo "$LINE" | sudo tee -a "$HBA" >/dev/null

  echo "==> Firewall: allow Postgres (5432) from the standby only"
  sudo ufw allow from "$PEER_IP" to any port 5432 proto tcp

  echo "==> Restarting Postgres"
  sudo systemctl restart postgresql

  echo ""
  echo "==> Primary is ready. Now run this SAME script with 'standby $THIS_HOST_IP' on the"
  echo "    standby box (it will connect back here to clone the database)."

elif [ "$ROLE" = "standby" ]; then
  echo "==> Configuring STANDBY — this will REPLACE this box's local Postgres data with a"
  echo "    clone of the primary's. Only run this on a fresh box with nothing worth keeping."
  read -r -p "Type 'yes' to continue: " CONFIRM
  [ "$CONFIRM" = "yes" ] || { echo "Aborted."; exit 1; }

  echo "==> Stopping Postgres and clearing the local (empty) data directory"
  sudo systemctl stop postgresql
  sudo rm -rf "${PG_DATA_DIR:?}"/*

  echo "==> Cloning the primary's database (pg_basebackup) — will prompt for the"
  echo "    erp_replicator password set on the primary"
  sudo -u postgres pg_basebackup -h "$PEER_IP" -U "$REPL_USER" -D "$PG_DATA_DIR" \
    -Fp -Xs -R -P --checkpoint=fast

  # -R writes standby.signal + primary_conninfo into postgresql.auto.conf automatically —
  # nothing else to hand-edit for the replication connection itself.
  sudo chown -R postgres:postgres "$PG_DATA_DIR"
  sudo chmod 700 "$PG_DATA_DIR"

  echo "==> Starting Postgres in standby (read-only, continuously replaying) mode"
  sudo systemctl start postgresql
  sleep 2
  sudo -u postgres psql -c "SELECT pg_is_in_recovery();"

  echo ""
  echo "==> Standby is now streaming from the primary. It will refuse writes until promoted"
  echo "    (deploy/failover.sh). Next: run deploy/setup-rls.sh here too — a promoted standby"
  echo "    needs the SAME erp_app_tenant role/policies, or it silently falls back to"
  echo "    superuser-only access. Then deploy the app code here (deploy.sh) so it's ready,"
  echo "    idle, for a failover. Check lag with: SELECT now() - pg_last_xact_replay_timestamp();"
fi
