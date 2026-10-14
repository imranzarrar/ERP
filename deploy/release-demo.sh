#!/usr/bin/env bash
# Release the 2.0 DEMO app (branch v2) on the VPS, on port 4000, next to live. Run as the deploy user from ~/apps/erp-demo:
#
#     cd ~/apps/erp-demo && bash deploy/release-demo.sh
#
#   bash deploy/release-demo.sh --dry-run        # show what would be deployed, change nothing
#   bash deploy/release-demo.sh --force-schema   # run db:push even if schema.ts did not change (first run, or after clone-prod-to-demo.sh)
#
# This script can only ever touch the demo: it refuses to run unless the folder, the branch, the database name and the port all say
# "demo", it never touches Nginx, the maintenance page, the live PM2 app (named "erp"; this one is "erp-demo"), or the live database.
# Steps: 1 pull v2 + build  2 db:push (YOU read the plan)  3 row-level-security policies + grants  4 chart of accounts
#        5 start/reload erp-demo on 127.0.0.1:4000 and health-check it.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"
DRY_RUN=0; FORCE_SCHEMA=0
for a in "$@"; do case "$a" in --dry-run) DRY_RUN=1 ;; --force-schema) FORCE_SCHEMA=1 ;; *) echo "Unknown argument: $a" >&2; exit 1 ;; esac; done

die() { echo "ERROR: $*" >&2; exit 1; }
say() { echo ""; echo "==> $*"; }
read_secret() {
  local raw
  raw="$(grep -E "^$1=" app.secrets | head -n1 | cut -d= -f2- || true)"
  raw="${raw%$'\r'}"
  if [[ "$raw" == \"*\" && "$raw" == *\" ]] || [[ "$raw" == \'*\' && "$raw" == *\' ]]; then raw="${raw:1:-1}"; fi
  printf '%s' "$raw"
}

say "Preflight (demo-only guards)"
case "$(id -un)" in deploy|warraq-demo) ;; *) die "Run as the demo user (warraq-demo) or deploy." ;; esac
case "$REPO_DIR" in *erp-demo*) ;; *) die "This folder is not the demo checkout (path must contain 'erp-demo')." ;; esac
[ -f app.secrets ] || die "app.secrets not found."
[ "$(read_secret APP_ENV)" = "demo" ] || die "app.secrets does not say APP_ENV=demo."
case "$(read_secret SQL_DB_NAME)" in erp_demo*) ;; *) die "SQL_DB_NAME is not a demo database (must start with erp_demo)." ;; esac
[ "$(read_secret PORT)" = "4000" ] || die "app.secrets must say PORT=4000."
[ "$(read_secret HOST)" = "127.0.0.1" ] || die "app.secrets must say HOST=127.0.0.1 (the demo is never bound to a public address)."
[ -z "$(read_secret SMTP_HOST)" ] || die "SMTP_HOST is set in the demo's app.secrets: the demo must never send email."
[ -z "$(read_secret ZATCA_ALLOW_LIVE_CALLS)" ] || die "ZATCA_ALLOW_LIVE_CALLS is set in the demo's app.secrets: remove it."
[ -t 0 ] || die "Run in an interactive terminal (db:push asks you to confirm its plan)."
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "Working tree has local changes — resolve them first."
git fetch origin
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "v2" ] || die "The demo deploys branch v2 only (this checkout is on '$BRANCH')."
AHEAD="$(git rev-list --count HEAD..@{upstream})"
echo "Branch: $BRANCH   Commits to deploy: $AHEAD   (HEAD now: $(git rev-parse --short HEAD))"
git log --oneline HEAD..@{upstream} | head -20
[ "$DRY_RUN" = "1" ] && { say "Dry run only — nothing changed."; exit 0; }

say "[1/5] Pull v2 and build"
git merge --ff-only "@{upstream}"
npm ci
npm run build

say "[2/5] Database schema (db:push) on the DEMO database erp_demo — READ THE PLAN"
SCHEMA_CHANGED=1
if git rev-parse -q --verify refs/tags/last-release-demo >/dev/null && git diff --quiet last-release-demo HEAD -- src/db/schema.ts; then SCHEMA_CHANGED=0; fi
[ "$FORCE_SCHEMA" = "1" ] && SCHEMA_CHANGED=1
if [ "$SCHEMA_CHANGED" = "1" ]; then
  npm run db:push
  read -r -p "Did db:push apply what you expected, with no errors? [type yes to continue]: " ANSWER
  [ "$ANSWER" = "yes" ] || die "Not confirmed — stopping."
else
  echo "schema.ts unchanged since the last demo release — db:push skipped."
fi

say "[3/5] Row-level security policies + grants"
npx tsx scripts/apply-rls-policies.mjs
PGPASSWORD="$(read_secret SQL_PASSWORD)" psql -h "$(read_secret SQL_HOST)" -U "$(read_secret SQL_USER)" -d "$(read_secret SQL_DB_NAME)" -v ON_ERROR_STOP=1 -q \
  -c "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO erp_app_tenant" \
  -c "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO erp_app_tenant"
npx tsx scripts/verify-tenant-isolation.ts

say "[4/5] Chart of accounts (idempotent)"
npx tsx scripts/seed-system-accounts.ts --apply

say "[5/5] Start / reload erp-demo and health-check it"
pm2 startOrReload deploy/ecosystem.demo.config.cjs
sleep 5
pm2 status
HEALTH="000"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  HEALTH="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4000/api/health || true)"
  [ "$HEALTH" = "200" ] && break
  sleep 3
done
echo "Demo health check: HTTP $HEALTH (want 200)"
[ "$HEALTH" = "200" ] || die "The demo app is not answering healthy (live is unaffected). Look at: pm2 logs erp-demo"
git tag -f last-release-demo HEAD >/dev/null
pm2 save

say "Demo release complete. Open it through an SSH tunnel from your own machine:"
echo "  ssh -L 4000:127.0.0.1:4000 deploy@<VPS>      then browse to http://127.0.0.1:4000"
echo "Live (port 3000, process 'erp') was not touched."
