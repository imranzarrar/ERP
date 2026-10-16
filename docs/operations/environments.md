# Environments: Live (1.0) and Demo / development (2.0)

Two words are used everywhere from now on:

| | **Live — Warraq ERP 1.0** | **Demo / development — Warraq ERP 2.0** |
|---|---|---|
| Purpose | the running business: fixes and small updates only | all new work (GL, AR, AP, HR, timekeeping, payroll) |
| Git branch | `master` (milestone tag `core-erp-v1.0`) | `v2` |
| Local folder | `E:\ERP` | `E:\ERP-2.0` (a `git worktree` of the same repo) |
| Local port / database | 3000 / `erp_review` | 3001 / `erp_v2` |
| Server folder (VPS) | `~/apps/erp` | `~/apps/erp-demo` |
| Server port / PM2 name | 3000 (behind Nginx, `warraq.compbrain.io`) / `erp` | 4000, bound to 127.0.0.1 only / `erp-demo` |
| Database on the VPS | `erp_production` (role `erp_app`) | `erp_demo` (role `erp_demo`), a scrubbed copy of live |
| Release command | `bash deploy/release.sh` | `bash deploy/release-demo.sh` |
| Session cookie | `connect.sid` | `warraq2.sid` |

## The rule
Nothing from 2.0 reaches Live until it has been verified on Demo. Live runs `master` only: its `git pull --ff-only` follows `master`,
so `v2` cannot reach it by accident. Live's scripts are unchanged and only ever touch the PM2 app `erp`.

## Fixing something on Live while 2.0 is being built
1. Work in `E:\ERP` (branch `master`). Make the fix, test it, commit.
2. Push, then on the VPS: `cd ~/apps/erp && git pull --ff-only && bash deploy/release.sh` (as the `deploy` user).
3. Bring the fix into 2.0 straight away: in `E:\ERP-2.0` run `git merge master`. Do this every time, so 2.0 never loses a fix.
4. A Live fix must never depend on a 2.0 table or column: Live's database is the 1.0 schema.

## Working on 2.0
1. Work in `E:\ERP-2.0` (branch `v2`). Its server runs on 3001 against `erp_v2`; run its tests with `TEST_BASE_URL=http://localhost:3001`.
2. Push `v2`, then on the VPS: `cd ~/apps/erp-demo && bash deploy/release-demo.sh` (as the `deploy` user). Schema changes show drizzle's plan first.
3. To rehearse an upgrade on real data: refresh the demo database from live (below), then release 2.0 onto it and compare.

## The demo's data
A scrubbed copy of the live database: `deploy/clone-prod-to-demo.sh` dumps live over a READ-ONLY connection, replaces the demo database,
then runs `deploy/scrub-demo-data.sql`, which removes every ZATCA key/certificate and switches ZATCA off, clears sessions and reset
tokens, gives every user one demo password, and removes emails and phone numbers. Names, documents and amounts are kept so figures can be
reconciled. The demo has no SMTP settings and never sets `ZATCA_ALLOW_LIVE_CALLS`, so it cannot email anyone or call ZATCA Production.
Live is only ever read.

## One-time VPS setup of the demo (the user runs these, as `deploy`)
```
git clone --branch v2 <same repo URL as live> ~/apps/erp-demo
cd ~/apps/erp-demo
bash deploy/setup-demo.sh                 # creates database erp_demo + role erp_demo; touches nothing of live
# create ~/apps/erp-demo/app.secrets BY HAND from deploy/app.secrets.demo.example (new secrets, PORT=4000, HOST=127.0.0.1, APP_ENV=demo)
npm ci && npm run build
bash deploy/clone-prod-to-demo.sh         # copy + scrub live data into erp_demo
bash deploy/release-demo.sh --force-schema   # apply the 2.0 schema (read the plan), start erp-demo on 127.0.0.1:4000
```
Open the demo from your own machine through an SSH tunnel (nothing is opened in the firewall or Nginx):
`ssh -L 4000:127.0.0.1:4000 deploy@<VPS>` then browse to `http://127.0.0.1:4000` (use `127.0.0.1`, not `localhost`, so its cookie never
collides with a local app on another port).

## Guardrails
* Both release scripts refuse to run unless folder, branch, database name and port all match their own environment.
* Secrets never pass through git or chat. The demo's `app.secrets` is written by hand on the VPS with values that differ from live. The one
  shared item is the restricted Postgres role `erp_app_tenant` (the row-level-security policies are written for that name); the demo only
  gets a GRANT on its own database and the role's password is never changed by the demo scripts.
* Do not run `deploy/setup-rls.sh` for the demo: it resets the role's password, which would break Live.
