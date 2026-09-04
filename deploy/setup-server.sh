#!/usr/bin/env bash
# One-time VPS provisioning — run this from INSIDE the cloned repo, as the deploy user
# (never as root), after: a deploy user with sudo exists, root SSH login is disabled, and
# this repo has already been git-cloned. See docs/deployment-plan.md for the full context
# and the exact commands for that earlier, pre-repo phase (creating the deploy user,
# generating a GitHub deploy key, cloning) — this script picks up from there.
#
# Safe to re-run: every step either checks for existing state first or is naturally
# idempotent (apt install of an already-installed package, pm2 save overwriting the same
# dump, etc.) — but it is NOT designed to be run unattended on a server that already has
# other things on it. Read it before running it.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "==> Working in $REPO_DIR"

if [ "$EUID" -eq 0 ]; then
  echo "Do not run this as root — run it as the deploy user (it uses sudo where needed)." >&2
  exit 1
fi

echo "==> Installing base packages (curl, build tools, ufw, fail2ban)"
sudo apt-get update -y
sudo apt-get install -y curl build-essential ufw fail2ban

echo "==> Firewall: allow SSH + app port (no domain/Nginx yet — see docs/deployment-plan.md)"
sudo ufw allow OpenSSH
sudo ufw allow 3000/tcp
sudo ufw --force enable
sudo ufw status verbose

echo "==> fail2ban: enable the default sshd jail"
sudo systemctl enable --now fail2ban

echo "==> Node.js (matching local dev's major version — check with 'node -v' locally first)"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v
npm -v

echo "==> PM2 (global)"
if ! command -v pm2 >/dev/null 2>&1; then
  sudo npm install -g pm2
fi
pm2 -v

echo "==> PostgreSQL"
if ! command -v psql >/dev/null 2>&1; then
  sudo apt-get install -y postgresql postgresql-contrib
fi
sudo systemctl enable --now postgresql

echo ""
echo "==> Database role + database"
echo "This will prompt you to set a password for a new Postgres role 'erp_app'."
echo "Skip (Ctrl+C then re-run later) if you've already created it."
read -p "Create Postgres role+database now? [y/N] " CREATE_DB
if [[ "$CREATE_DB" =~ ^[Yy]$ ]]; then
  sudo -u postgres createuser --pwprompt erp_app || echo "Role may already exist — continuing."
  sudo -u postgres createdb -O erp_app erp_production || echo "Database may already exist — continuing."
fi

echo ""
if [ ! -f "$REPO_DIR/app.secrets" ]; then
  cat <<'EOF'
==> app.secrets is missing.

Create it now by hand (never copy it from git or chat — it's gitignored on purpose):

  cat > app.secrets <<'SECRETS'
  SQL_HOST=localhost
  SQL_USER=erp_app
  SQL_PASSWORD=<the password you just set>
  SQL_DB_NAME=erp_production
  SESSION_SECRET=<openssl rand -base64 32>
  ZATCA_KEY_ENCRYPTION_SECRET=<openssl rand -base64 32>
  SECRETS

See deploy/app.secrets.production.example for the full list of variables this app reads.

Then re-run this script — it will pick up from here.
EOF
  exit 1
fi
echo "==> app.secrets found."

echo "==> Installing dependencies (npm ci — exact lockfile versions)"
npm ci

echo "==> Building for production (vite build + esbuild bundle)"
npm run build

echo ""
echo "==> Schema: review before applying"
echo "About to run 'npm run db:push' against the PRODUCTION database. It will print its"
echo "plan first — read it carefully (this is the same tool that surfaces drift locally)."
read -p "Continue with db:push now? [y/N] " DO_PUSH
if [[ "$DO_PUSH" =~ ^[Yy]$ ]]; then
  npm run db:push
else
  echo "Skipped — run 'npm run db:push' manually when ready."
fi

mkdir -p deploy/logs

echo "==> Starting under PM2 (cluster, 2 instances)"
pm2 start deploy/ecosystem.config.cjs
pm2 save

echo ""
echo "==> One more manual step: make PM2 survive a reboot."
echo "Run the command 'pm2 startup' prints below, exactly as shown (it needs sudo):"
pm2 startup || true

echo ""
echo "==> Done. The app should now be reachable at http://<VPS_IP>:3000"
echo "Check with: pm2 status   /   pm2 logs erp"
