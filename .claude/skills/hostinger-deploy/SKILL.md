---
name: hostinger-deploy
description: Load this before any action that touches the production Hostinger VPS — provisioning, deploying, rolling back, restarting the production process, or changing the production database. Also load it when the user asks about deploy status, "is it live," server access, or production secrets. This app has exactly one production deployment target (a single Hostinger VPS, PM2 + bare Node, Postgres on the same box, no CI/CD) and the guardrails here exist because a live server and a live database are much less forgiving of a wrong command than local dev.
---

# Hostinger VPS Deployment (this ERP)

Read `docs/deployment-plan.md` first — it's the actual agreed design (architecture diagram, locked-in decisions, the one-time setup steps, the repeatable deploy loop) and takes precedence over anything below if they ever disagree. This skill exists to carry the *guardrails* forward into every session that touches deployment, since the stakes on a live server are categorically higher than local dev.

## The non-negotiable guardrails

- **Never deploy, restart the production process, or touch the production database without the user explicitly asking in that session.** A prior deploy being approved does not pre-approve the next one.
- **`db:push` against production is always its own separate, manually reviewed step** — never chained automatically after a code deploy. `deploy/deploy.sh` and `deploy/setup-server.sh` both deliberately stop and ask rather than running it for you; do not "helpfully" wire it into an automated path.
- **Secrets never pass through git, chat, or this repo.** `app.secrets` on the VPS is created by hand, directly on the server, every time — including the first time. If you ever find yourself about to paste a real secret value into a chat message, a commit, or a file under this repo, stop.
- **Before anything destructive or hard-to-reverse on the live server** (DB schema changes, force-pushes to the deploy branch, `pm2 delete`, restoring from a backup, rolling back), stop and confirm with the user first — the same standing rule this project already follows for local git operations, with higher stakes here.
- **The user runs VPS-side commands themselves by default.** This project's chosen access model (confirmed with the user) is: you write/maintain the scripts and give exact commands, the user pastes them into their own SSH session and reports back the output. Don't assume you have direct SSH access to the VPS unless the user has explicitly set that up and told you so in the current session.
- **Every VPS-side command you hand the user must specify which OS user it runs as** (`deploy`, never `root`) — PM2 keeps a completely separate process list per OS user, so a command run as the wrong one silently does nothing useful (see the reboot incident below). If you're not certain which user a step needs, say so explicitly rather than leaving it ambiguous.

## Schema-change checklist — evaluate BEFORE committing, not after

The user has explicitly asked for this to be a standing habit, not a one-off: **every time `src/db/schema.ts` changes, evaluate its production impact before committing**, not after. Do this as part of the same turn that makes the schema edit:

1. **Diff it**: `git diff src/db/schema.ts` (or review your own edit) and classify every change:
   - **Safe, no action needed**: a new table; a new nullable column; a new index (unless it's `UNIQUE` and existing data could violate it — check that specifically).
   - **Needs a safe rollout plan, not a single-shot change**: a new `NOT NULL` column on a table that will have existing rows in production — add it nullable first, ship, backfill real values via a one-off script, only make it `NOT NULL` in a later change once production data is confirmed backfilled. Don't hand the user a migration that would fail or silently force a bad default onto every existing row.
   - **Stop and flag explicitly to the user before writing the migration at all**: dropping a column/table, changing a column's type, or renaming anything (drizzle-kit can't always tell a rename from a drop+add and will interactively ask — get this right before it ever reaches production, since a wrong answer there deletes that column's data).
2. **State the classification plainly** when you present the change (in your summary, the commit message, or both) — e.g. "this adds `expenses.approvedBy`, nullable, safe to push directly" vs. "this needs a two-step rollout because production already has expense rows."
3. **When it's time to actually deploy it**: run `deploy/backup-db.sh` on the VPS first (cheap insurance beyond the interactive prompt `db:push` already gives you), then run `npm run db:push` against production and actually read the printed plan for the risky patterns above before confirming — never assume it's "just like local."

## What already exists (as of this VPS going live)

- Target: Hostinger VPS (72.61.81.58), 2 vCPU / 8GB RAM, Ubuntu LTS, PM2 (2 cluster instances) + bare Node, Postgres on the same box, no CI/CD (manual deploy trigger only).
- **Live at `https://warraq.compbrain.io`** — Nginx + Let's Encrypt SSL are set up and active (not dormant anymore); port 3000 is closed to the public internet, Nginx (80/443) is the only entry point. `APP_BASE_URL=https://warraq.compbrain.io` is set in production `app.secrets`.
- GitHub remote: `https://github.com/imranzarrar/ERP` (private). The VPS's `deploy` user has a read-only deploy key registered for it — never give it write access.
- Real incident worth remembering: **`pm2 startup` must be run AS the `deploy` user, not root.** PM2 keeps a fully separate process list per OS user; running `pm2 startup` as root registers a systemd unit that restores *root's* (empty) PM2 list on boot, silently leaving the real app (saved under `deploy`) never restarted. This caused a real post-reboot 502 outage on this VPS — always confirm with `whoami` before running PM2 lifecycle commands, and always re-run `pm2 save` + `pm2 startup` as `deploy` after any PM2-related troubleshooting that happened as root.
- `deploy/ecosystem.config.cjs` — PM2 process definition. Edit here, not by hand on the server (it's version-controlled and pulled by every deploy).
- `deploy/setup-server.sh` — one-time provisioning, run once from inside the freshly-cloned repo on the VPS (installs Node/PM2/Postgres/ufw/fail2ban, creates the DB role, checks for `app.secrets`, builds, first PM2 start). Safe to re-run (idempotent-ish checks), but read it before re-running on a server that already has other things on it.
- `deploy/deploy.sh` — the repeatable pull → build → reload loop. Tags the pre-deploy commit automatically (`pre-deploy-<timestamp>`) before moving, so `rollback.sh` always has something to fall back to. Warns (does not block) if `src/db/schema.ts` changed in the deployed range.
- `deploy/rollback.sh` — reverts to the most recent `pre-deploy-*` tag (or an explicit commit/tag argument) and reloads PM2. Never touches the database.
- `deploy/backup-db.sh` — nightly `pg_dump` with 14-day rotation, reading credentials straight from `app.secrets`. Wire it into cron per the comment at the bottom of that file — it is not scheduled automatically by anything.
- `deploy/app.secrets.production.example` — the real list of every env var this app reads (kept in sync with `server.ts`/`src/db/index.ts`/`server/lib/*` — re-check those if you add a new one), with which are required vs optional. Template only, never real values.
- `deploy/nginx.erp.conf.template` — **not wired in yet**, since there's no domain. Written for when one is added later; see the comment at its top for the exact activation steps (Certbot rewrites it in place for SSL).

## Adding another domain/subdomain later (e.g. a second app on this same VPS)

Same recipe as `warraq.compbrain.io` already used: point the A record, copy `deploy/nginx.erp.conf.template` into `/etc/nginx/sites-available/<name>` with the domain substituted, symlink it into `sites-enabled`, `nginx -t` before reloading, then `certbot --nginx -d <domain>`. Certbot rewrites the site's config in place to add SSL. Remember: Certbot's HTTP-01 challenge needs port 80 open in `ufw` *before* it runs — `ufw allow 'Nginx Full'` first, or it fails with a connection timeout that looks like a DNS problem but isn't.

## Before touching any deploy file

Re-read the specific script you're about to change in full — they're short (each one screen or so) and this is a case where a subtle bash mistake (a missing `set -e`, an unquoted variable, a wrong working directory) executes for real on a live server, not in a sandbox.
