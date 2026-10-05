#!/usr/bin/env bash
# One-command production release — run ON THE VPS as the deploy user, from the repo root, in a
# real terminal (not piped), after the commit has been pushed to the git remote:
#
#   bash deploy/release.sh              # run the whole release
#   bash deploy/release.sh --dry-run    # preflight only: show what would be deployed, change nothing
#   bash deploy/release.sh --from 4     # resume at step 4 after fixing a failure (see STEPS below)
#   bash deploy/release.sh --only 8     # run just one step (e.g. re-run the ledger checks after the smoke test)
#
# It chains the steps that used to be pasted by hand: backup -> maintenance page on -> pull/build/
# reload -> db:push -> RLS policies + checks -> chart-of-accounts seed -> XML compression backfill ->
# ledger sanity checks -> maintenance page off.
#
# Deliberate human gate (per docs/deployment-plan.md's guardrails): db:push against production is
# NEVER automatic. Step 4 shows drizzle-kit's own plan and waits for you to review it and answer
# "yes" afterwards. Everything else is automatic and stops at the first failure.
#
# Failure behaviour: the maintenance page is turned on early and is only turned off at the very
# end, after every check has passed. If anything fails, it STAYS ON — customers see the
# maintenance page, not a half-migrated app. Fix the cause, then re-run with --from <step>.
# Code rollback (does not touch the database; the schema changes in this release are additive):
#   bash deploy/rollback.sh
#
# STEPS: 1 backup  2 maintenance on  3 deploy code  4 db:push  5 RLS  6 seed accounts
#        7 compress XML  8 ledger checks  9 reload + maintenance off
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

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
    if [ "$MAINTENANCE_TOUCHED" = "1" ] || [ "$FROM" -gt 2 ]; then
      echo "!! Maintenance mode has been LEFT ON (customers see the maintenance page)."
    fi
    echo "!! Fix the cause above, then resume with:  bash deploy/release.sh --from <step>"
    echo "!! To undo the code change:  bash deploy/rollback.sh   (database changes here are additive)"
  fi
}
trap on_exit EXIT

die() { echo "ERROR: $*" >&2; exit 1; }
say() { echo ""; echo "==> $*"; }
confirm() {
  local answer
  read -r -p "$1 [type yes to continue]: " answer
  [ "$answer" = "yes" ] || die "Not confirmed — stopping. Nothing further was run."
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

# ---------- preflight (always runs) ----------
say "Preflight"
[ "$(id -un)" = "deploy" ] || die "Run as the deploy user (su - deploy) — PM2 keeps a separate process list per OS user."
[ -f app.secrets ] || die "app.secrets not found in $REPO_DIR"
[ -t 0 ] || die "Run in an interactive terminal (db:push needs to ask you to confirm its plan)."
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "Working tree on the server has local changes — resolve them first."
git fetch origin
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
AHEAD="$(git rev-list --count HEAD..@{upstream})"
echo "Branch: $BRANCH   Commits to deploy: $AHEAD"
git log --oneline HEAD..@{upstream} | head -20
if [ "$AHEAD" = "0" ] && [ "$ONLY" = "0" ] && [ "$FROM" -le 3 ]; then
  echo "(nothing new to pull — steps 4-9 can still be run with --from 4)"
fi
if git diff --name-only HEAD @{upstream} -- src/db/schema.ts | grep -q .; then
  echo "src/db/schema.ts changes in this release -> step 4 (db:push) will show a plan to review."
fi
if [ "$DRY_RUN" = "1" ]; then say "Dry run only — nothing changed."; FINISHED=1; exit 0; fi

if should_run 1; then
  say "[1/9] Database backup"
  bash deploy/backup-db.sh
fi

if should_run 2; then
  say "[2/9] Maintenance page ON"
  confirm "This will show the maintenance page to ALL users until the end of the release. Proceed?"
  bash deploy/maintenance-mode.sh on
  MAINTENANCE_TOUCHED=1
fi

if should_run 3; then
  say "[3/9] Pull, build, reload (deploy.sh tags a rollback point first)"
  bash deploy/deploy.sh
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
  say "[9/9] Reload app on the final schema, then maintenance OFF"
  pm2 reload deploy/ecosystem.config.cjs
  pm2 status
  confirm "pm2 shows the app online? Turn the maintenance page OFF and reopen the site?"
  bash deploy/maintenance-mode.sh off
fi

FINISHED=1
say "Release complete."
echo "Now smoke-test in a TEST company (not the live one): paid invoice, part-paid invoice, credit note,"
echo "cancellation, GRN. Then re-run the ledger checks:  bash deploy/release.sh --only 8"
echo "Rollback if needed:  bash deploy/rollback.sh"
