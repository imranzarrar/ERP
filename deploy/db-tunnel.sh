#!/usr/bin/env bash
# Opens a local SSH tunnel to production Postgres, so a client on YOUR OWN MACHINE (psql,
# DBeaver, pgAdmin) can reach it via localhost — without ever exposing Postgres itself on the
# VPS's public interface. Unlike every other script in this folder, this one runs on your
# local machine, never on the VPS.
#
# It rides the same SSH access already used for every other deploy/* command (the `deploy`
# user) and makes zero changes on the VPS side — Postgres there stays bound to 127.0.0.1
# exactly as it already is (confirmed via `sudo ss -tlnp | grep 5432` on the VPS). Never open
# port 5432 in ufw to make this "easier" — the tunnel is the whole point.
#
# Usage (from your own terminal, e.g. Git Bash on Windows):
#   bash deploy/db-tunnel.sh                # foreground — Ctrl+C closes the tunnel
#   bash deploy/db-tunnel.sh --background   # backgrounds after connecting (-f); survives
#                                            # closing this terminal — kill it later via the
#                                            # PID on the local port (Windows:
#                                            # `netstat -ano | findstr 5433`, then
#                                            # `taskkill /PID <pid> /F`; mac/Linux:
#                                            # `lsof -ti :5433 | xargs kill`)
#
# Override the host/ports with env vars if needed, e.g.:
#   VPS_HOST=deploy@1.2.3.4 LOCAL_PORT=5555 bash deploy/db-tunnel.sh
#
# Once the tunnel is up, connect in a SEPARATE terminal (get SQL_USER/SQL_DB_NAME from the
# VPS: `grep SQL_ /home/deploy/apps/erp/app.secrets` — never hardcode real values here):
#   psql -h localhost -p 5433 -U <SQL_USER> -d <SQL_DB_NAME>
set -euo pipefail

VPS_HOST="${VPS_HOST:-deploy@72.61.81.58}"
LOCAL_PORT="${LOCAL_PORT:-5433}"
REMOTE_PORT="${REMOTE_PORT:-5432}"

echo "==> Opening tunnel: localhost:${LOCAL_PORT} -> ${VPS_HOST} -> localhost:${REMOTE_PORT}"
echo "    Once connected, in ANOTHER terminal run:"
echo "    psql -h localhost -p ${LOCAL_PORT} -U <SQL_USER> -d <SQL_DB_NAME>"

if [ "${1:-}" = "--background" ]; then
  ssh -f -N -L "${LOCAL_PORT}:localhost:${REMOTE_PORT}" "$VPS_HOST"
  echo "==> Tunnel running in background."
else
  echo "    This terminal will look idle while the tunnel is active (that's normal, not a"
  echo "    hang) — leave it open. Ctrl+C here closes the tunnel."
  ssh -N -L "${LOCAL_PORT}:localhost:${REMOTE_PORT}" "$VPS_HOST"
fi
