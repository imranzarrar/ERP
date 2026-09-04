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

## What already exists (as of this VPS's initial setup)

- Target: Hostinger VPS, 2 vCPU / 8GB RAM, Ubuntu LTS, **no domain yet — running on the bare IP**, PM2 (2 cluster instances) + bare Node, Postgres on the same box, no CI/CD (manual deploy trigger only).
- `deploy/ecosystem.config.cjs` — PM2 process definition. Edit here, not by hand on the server (it's version-controlled and pulled by every deploy).
- `deploy/setup-server.sh` — one-time provisioning, run once from inside the freshly-cloned repo on the VPS (installs Node/PM2/Postgres/ufw/fail2ban, creates the DB role, checks for `app.secrets`, builds, first PM2 start). Safe to re-run (idempotent-ish checks), but read it before re-running on a server that already has other things on it.
- `deploy/deploy.sh` — the repeatable pull → build → reload loop. Tags the pre-deploy commit automatically (`pre-deploy-<timestamp>`) before moving, so `rollback.sh` always has something to fall back to. Warns (does not block) if `src/db/schema.ts` changed in the deployed range.
- `deploy/rollback.sh` — reverts to the most recent `pre-deploy-*` tag (or an explicit commit/tag argument) and reloads PM2. Never touches the database.
- `deploy/backup-db.sh` — nightly `pg_dump` with 14-day rotation, reading credentials straight from `app.secrets`. Wire it into cron per the comment at the bottom of that file — it is not scheduled automatically by anything.
- `deploy/app.secrets.production.example` — the real list of every env var this app reads (kept in sync with `server.ts`/`src/db/index.ts`/`server/lib/*` — re-check those if you add a new one), with which are required vs optional. Template only, never real values.
- `deploy/nginx.erp.conf.template` — **not wired in yet**, since there's no domain. Written for when one is added later; see the comment at its top for the exact activation steps (Certbot rewrites it in place for SSL).

## When the user adds a domain later

Don't re-architect anything — follow `deploy/nginx.erp.conf.template`'s own header comment: point the A record, copy the template into `/etc/nginx/sites-available`, enable it, run Certbot, then close the direct `:3000` port in ufw so Nginx is the only public entry point. Update `deploy/setup-server.sh`'s firewall step and `APP_BASE_URL` in `app.secrets` to match once this happens, so a future re-provision reflects reality.

## Before touching any deploy file

Re-read the specific script you're about to change in full — they're short (each one screen or so) and this is a case where a subtle bash mistake (a missing `set -e`, an unquoted variable, a wrong working directory) executes for real on a live server, not in a sandbox.
