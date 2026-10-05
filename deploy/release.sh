#!/usr/bin/env bash
# One-command production release — run ON THE VPS as the deploy user, in a real terminal, after the
# commit has been pushed to the git remote:
#
#   cd ~/apps/erp && git pull --ff-only && bash deploy/release.sh
#
# (the pull is only needed to fetch this script itself the first time; it is harmless afterwards)
#
#   bash deploy/release.sh --dry-run    # preflight only: show what would be deployed, change nothing
#   bash deploy/release.sh --from 4     # resume at step 4 after fixing a failure
#   bash deploy/release.sh --only 8     # run just one step (e.g. re-run the ledger checks later)
#
# STEPS: 1 backup   2 pull + build (site stays up)   3 maintenance wiring + ON (self-verified)
#        4 db:push (YOU review)   5 RLS   6 seed accounts   7 compress XML   8 ledger checks
#        9 reload app + health check + maintenance OFF
#
# The ONLY question it asks is step 4: db:push against production is never automatic (see
# docs/deployment-plan.md's guardrails) — it prints drizzle's plan and waits for you to read it and
# type "yes". Everything else runs by itself and stops at the first failure.
#
# Failure behaviour: the maintenance page goes on at step 3 and only comes off at the very end, after
# every check has passed. If anything fails it STAYS ON — customers see the maintenance page, not a
# half-migrated app. Fix the cause, then resume with --from <step>.
# Code rollback (never touches the database; this release's schema changes are additive):
#   bash deploy/rollback.sh <commit>    # <commit> = what was live before; 998feb4 for the first ledger release
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

SITE_FILE="${ERP_NGINX_SITE:-/etc/nginx/sites-enabled/warraq}"
SITE_DOMAIN="${ERP_DOMAIN:-warraq.compbrain.io}"

FROM=1
ONLY=0
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --from) shift; FROM="${1:?--from needs a step number 1-9}" ;;
    --only) shift; ONLY="${1:?--only needs a step number 1-9}" ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
  shift
done

should_run() { if [ "$ONLY" != "0" ]; then [ "$ONLY" = "$1" ]; else [ "$FROM" -le "$1" ]; fi; }

FINISHED=0
MAINTENANCE_TOUCHED=0
on_exit() {
  if [ "$FINISHED" != "1" ] && [ "$DRY_RUN" != "1" ]; then
    echo ""
    echo "!! Release did NOT finish."
    if [ "$MAINTENANCE_TOUCHED" = "1" ] || [ "$FROM" -gt 3 ]; then
      echo "!! Maintenance mode has been LEFT ON (customers see the maintenance page)."
    fi
    echo "!! Fix the cause above, then resume with:  bash deploy/release.sh --from <step>"
    echo "!! To undo the code change:  bash deploy/rollback.sh <previous-commit>   (database changes here are additive)"
  fi
}
trap on_exit EXIT

die() { echo "ERROR: $*" >&2; exit 1; }
say() { echo ""; echo "==> $*"; }
confirm() {
  local answer
  read -r -p "$1 [type yes to continue]: " answer
  [ "$answer" = "yes" ] || die "Not confirmed — stopping."
}

read_secret() {
  local raw
  raw="$(grep -E "^$1=" app.secrets | head -n1 | cut -d= -f2-)"
  raw="${raw%$'\r'}"
  if [[ "$raw" == \"*\" && "$raw" == *\" ]] || [[ "$raw" == \'*\' && "$raw" == *\' ]]; then raw="${raw:1:-1}"; fi
  printf '%s' "$raw"
}
q() { # read-only SQL, single value
  PGPASSWORD="$(read_secret SQL_PASSWORD)" psql -h "$(read_secret SQL_HOST)" -U "$(read_secret SQL_USER)" -d "$(read_secret SQL_DB_NAME)" -At -c "$1"
}

# Line number of the `server_name <domain>;` that belongs to the HTTPS (listen 443) server block.
# Prints nothing if it can't be found unambiguously.
https_server_name_line() {
  local file="$1" domain="$2" l443 start line
  l443="$(grep -n 'listen[[:space:]].*443' "$file" | head -n1 | cut -d: -f1)"
  [ -n "$l443" ] || return 0
  start="$(awk -v n="$l443" '/^[[:space:]]*server[[:space:]]*\{/ && NR<n {s=NR} END{print s}' "$file")"
  [ -n "$start" ] || return 0
  line="$(awk -v s="$start" -v n="$l443" -v d="$domain" 'NR>s && NR<n && $0 ~ "server_name[[:space:]]+" d ";" {print NR; exit}' "$file")"
  printf '%s' "$line"
}

# Makes sure Nginx actually serves the maintenance page when the flag is on (a one-time wiring that
# was missing: without it, "maintenance ON" silently does nothing). Idempotent.
ensure_maintenance_wired() {
  sudo mkdir -p /etc/nginx/snippets
  sudo install -m 644 deploy/nginx-snippets/erp-maintenance.conf /etc/nginx/snippets/erp-maintenance.conf
  if sudo grep -qs "erp-maintenance" "$SITE_FILE"; then
    echo "Nginx already includes the maintenance snippet."
  else
    [ -f "$SITE_FILE" ] || die "Nginx site file not found: $SITE_FILE (set ERP_NGINX_SITE to override)."
    local line backup
    line="$(https_server_name_line "$SITE_FILE" "$SITE_DOMAIN")"
    [ -n "$line" ] || die "Could not find the HTTPS server_name line for $SITE_DOMAIN in $SITE_FILE."
    backup="$HOME/nginx-site-backup-$(date +%Y%m%d-%H%M%S)"
    sudo cp "$SITE_FILE" "$backup"
    echo "Backed up $SITE_FILE -> $backup; adding the include after line $line"
    sudo sed -i "${line}a\\    include snippets/erp-maintenance.conf;" "$SITE_FILE"
    if ! sudo nginx -t; then
      sudo cp "$backup" "$SITE_FILE"
      die "nginx -t failed — original config restored from $backup."
    fi
    sudo systemctl reload nginx
  fi
  sudo -u www-data test -r "$REPO_DIR/deploy/maintenance.html" \
    || die "Nginx (www-data) cannot read $REPO_DIR/deploy/maintenance.html — the home-directory permissions block it."
}

# ---------- preflight (always runs) ----------
say "Preflight"
[ "$(id -un)" = "deploy" ] || die "Run as the deploy user (su - deploy) — PM2 keeps a separate process list per OS user."
[ -f app.secrets ] || die "app.secrets not found in $REPO_DIR"
[ -t 0 ] || die "Run in an interactive terminal (db:push needs to ask you to confirm its plan)."
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "Working tree on the server has local changes — resolve them first."
git fetch origin
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
AHEAD="$(git rev-list --count HEAD..@{upstream})"
echo "Branch: $BRANCH   Commits to deploy: $AHEAD   (HEAD now: $(git rev-parse --short HEAD))"
git log --oneline HEAD..@{upstream} | head -20
[ "$AHEAD" != "0" ] || echo "(already at the latest commit — the build in step 2 still runs, so this is fine)"
if [ "$DRY_RUN" = "1" ]; then
  if [ -f "$SITE_FILE" ]; then
    if sudo grep -qs "erp-maintenance" "$SITE_FILE"; then echo "Maintenance wiring: already in place."; else echo "Maintenance wiring: MISSING — step 3 will add it (after backing up the Nginx config)."; fi
  fi
  say "Dry run only — nothing changed."; FINISHED=1; exit 0
fi

if should_run 1; then
  say "[1/9] Database backup"
  bash deploy/backup-db.sh
fi

if should_run 2; then
  say "[2/9] Pull and build (site stays up; always builds, even if you already pulled)"
  BEFORE_COMMIT="$(git rev-parse HEAD)"
  git tag -f "pre-deploy-$(date +%Y%m%d-%H%M%S)" "$BEFORE_COMMIT" >/dev/null
  git merge --ff-only "@{upstream}"
  echo "Now at: $(git rev-parse HEAD)"
  npm ci
  npm run build
  # The app itself is reloaded in step 9, AFTER the schema is updated, so the new code never runs
  # against the old schema.
fi

if should_run 3; then
  say "[3/9] Maintenance page: make sure Nginx serves it, switch it ON, and prove it works"
  ensure_maintenance_wired
  bash deploy/maintenance-mode.sh on
  MAINTENANCE_TOUCHED=1
  CODE="$(curl -sk -o /dev/null -w '%{http_code}' --resolve "$SITE_DOMAIN:443:127.0.0.1" "https://$SITE_DOMAIN/" || true)"
  echo "Public site now answers HTTP $CODE (want 503)"
  [ "$CODE" = "503" ] || die "The maintenance page is not being served (got HTTP $CODE) — stopping BEFORE touching the database."
fi

if should_run 4; then
  say "[4/9] Database schema (db:push) — REVIEW THE PLAN BELOW"
  echo "Expected for this release: ONLY additions — new tables system_accounts, journal_entries,"
  echo "journal_lines; new nullable columns vouchers.reversal_of_voucher_id,"
  echo "purchase_bills.vendor_bill_number, invoices.xml_content_z. Decline anything that"
  echo "drops, renames or retypes."
  npm run db:push
  confirm "Did db:push finish applying ONLY additions, with no errors?"
fi

if should_run 5; then
  say "[5/9] Row-level security policies + checks"
  npx tsx scripts/apply-rls-policies.mjs
  bash deploy/verify-rls.sh
  npx tsx scripts/verify-tenant-isolation.ts
fi

if should_run 6; then
  say "[6/9] Chart of accounts (idempotent)"
  npx tsx scripts/seed-system-accounts.ts --apply
fi

if should_run 7; then
  say "[7/9] Compress existing invoice XML (lossless, verified per row)"
  npx tsx scripts/backfill-compress-invoice-xml.ts
  npx tsx scripts/backfill-compress-invoice-xml.ts --apply
fi

if should_run 8; then
  say "[8/9] Ledger sanity checks"
  ACCOUNTS="$(q "select count(*) from system_accounts")"
  UNBALANCED="$(q "select count(*) from (select journal_entry_id from journal_lines group by 1 having abs(sum(debit)-sum(credit))>0.05) x")"
  DEBITS="$(q "select coalesce(sum(debit),0) from journal_lines")"
  CREDITS="$(q "select coalesce(sum(credit),0) from journal_lines")"
  PLAIN_LEFT="$(q "select count(*) from invoices where xml_content is not null")"
  echo "system_accounts rows ........ $ACCOUNTS (want 16)"
  echo "unbalanced journal entries .. $UNBALANCED (want 0)"
  echo "total debits / credits ...... $DEBITS / $CREDITS (want equal)"
  echo "invoices with uncompressed XML $PLAIN_LEFT (want 0)"
  [ "$ACCOUNTS" = "16" ] || die "Chart of accounts incomplete."
  [ "$UNBALANCED" = "0" ] || die "There are unbalanced journal entries."
  [ "$DEBITS" = "$CREDITS" ] || die "Total debits differ from total credits."
  [ "$PLAIN_LEFT" = "0" ] || die "Some invoices still hold uncompressed XML."
  echo "All ledger checks passed."
fi

if should_run 9; then
  say "[9/9] Reload the app on the final schema, health-check it, then maintenance OFF"
  pm2 reload deploy/ecosystem.config.cjs
  sleep 5
  pm2 status
  HEALTH="000"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    HEALTH="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health || true)"
    [ "$HEALTH" = "200" ] && break
    sleep 3
  done
  echo "App health check: HTTP $HEALTH (want 200)"
  [ "$HEALTH" = "200" ] || die "The app is not answering healthy after reload — maintenance page left ON."
  bash deploy/maintenance-mode.sh off
  git tag -f last-release HEAD >/dev/null
fi

FINISHED=1
say "Release complete."
echo "Next: log in to a TEST company and try a paid invoice, a part-paid invoice, a credit note,"
echo "a cancellation and a GRN; then re-run the ledger checks any time with:  bash deploy/release.sh --only 8"
