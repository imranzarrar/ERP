# Annex F — Operations runbook (ledger core)

## Tracks
Live: branch `master`, folder `E:\ERP`, production warraq.compbrain.io, fixes only. Demo / 2.0: branch `v2`, folder `E:\ERP-2.0`, local port 3001 / database `erp_v2`, VPS `~/apps/erp-demo` port 4000 (127.0.0.1 only; reach it through an SSH tunnel). See `docs/operations/environments.md`.

## Demo release (VPS, as the demo OS user)
```bash
cd ~/apps/erp-demo
bash deploy/release-demo.sh
```
Steps: pull `v2` and build → date migration (idempotent) → unique-key prerequisites → **db:push: read the plan, never accept a TRUNCATE prompt, decline drops/renames/retypes** → row-level-security predicates → check constraints → system accounts / seed → party-tag back-fill → translations → reload and health check. It needs an interactive terminal. After changing the script itself, run it twice (the first run executes the old copy while pulling).

## Verify after a release
Health endpoint returns 200; sign in; open Posting Control, Receipts, Bank Reconciliation; run the consistency check for a test company; `apply-rls-policies.mjs` reports all predicates verified.

## Rollback
`deploy/rollback.sh` returns the code to the previous tag and reloads PM2; it never touches the database. Schema additions are additive, so older code keeps working.

## Back-fills and one-off scripts (all idempotent, dry-run by default)
`scripts/backfill-party-tags.ts`, `scripts/seed-company-charts.ts`, `scripts/apply-gl-translations.ts`, `scripts/migrate-date-fields.mjs`, `scripts/pre-push-keys.mjs`, `scripts/apply-check-constraints.mjs`, `scripts/apply-rls-policies.mjs`.

## Promotion to Live (Sprint 20)
Clone-and-scrub production to a copy, run the full release there, verify with the consistency check and the user-manual walk-through, then run `deploy/release.sh` on Live after adding the party-tag back-fill step. Never from the 2.0 checkout.

## Support checks
* "A figure disagrees": run Ledger-vs-Documents, then the consistency check; find the violated rule.
* "Cannot cancel a document": a settlement or a completed bank reconciliation holds it; the message names the way out.
* "Cannot post a date": posting guard message names the rule (month, VAT quarter, lock date, window, reason).
