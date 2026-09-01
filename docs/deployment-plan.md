# Hostinger VPS Deployment Plan (Not Yet Executed)

**Status: planning only — no VPS purchased yet, nothing built.** This document is the agreed design to execute once the user is ready to go live. Do not start building any of this without an explicit go-ahead in a future session — re-read this file first, confirm it's still accurate (specs, decisions), then proceed.

## Decisions already locked in (confirmed with the user)

- **Target**: Hostinger VPS, 2 vCPU / 8GB RAM, Ubuntu LTS.
- **Deploy trigger**: manual — the user runs one command when ready; no auto-deploy-on-push CI/CD (at least initially). GitHub Actions can be layered on later once the app has matured, without changing the underlying scripts.
- **Runtime**: PM2 + bare Node (no Docker). Matches how the app already runs locally (`tsx`/`node`), lighter on a 2 vCPU box, no container layer to debug.
- **Database**: Postgres installed directly on the same VPS (not a managed/external provider). Requires its own backup discipline since there's no managed-provider safety net.
- **Local dev stays fully separate**: local Postgres, local `npm run dev`, local tests — none of this ever talks to the VPS. The VPS only changes when a deploy is deliberately run.

## Architecture

```
[Local dev machine]                        [Hostinger VPS — 2 vCPU / 8GB]
  npm run dev → localhost:3000               Nginx (80/443, Let's Encrypt SSL)
  local Postgres (dev/test)                        │
                                                    ▼
  git push ────────────────────────────►    PM2 (2 cluster instances)
                                              → Node app (dist/server.cjs)
                                                    │
                                              Postgres (production DB, same box)
```

## Part 1 — One-time VPS setup (do once, when the VPS is purchased)

1. Provision Ubuntu 22.04/24.04 LTS on Hostinger. Note the root SSH IP/credentials.
2. Point a domain (or subdomain) A record at the VPS IP. Can defer and run on the bare IP first if no domain yet — SSL needs it eventually.
3. Harden: create a non-root sudo deploy user, disable root SSH login, `ufw` allowing only SSH/80/443, install `fail2ban`.
4. Install the stack: Node.js (match the version used in dev), PM2 (`npm i -g pm2`), Postgres, Nginx, Certbot.
5. Create a dedicated production Postgres role + database (not reusing any default) matching what `app.secrets`' `SQL_HOST`/`SQL_USER`/`SQL_PASSWORD`/`SQL_DB_NAME` expect.
6. Clone the repo onto the VPS (e.g. `/home/deploy/apps/erp`) using a read-only GitHub deploy key — never the user's personal git credentials.
7. Create `app.secrets` directly on the VPS by hand (never committed, never transferred through git) — fresh `SESSION_SECRET`/`ZATCA_KEY_ENCRYPTION_SECRET` via `openssl rand -base64 32`, plus the DB credentials from step 5.
8. First build + start: `npm ci`, `npm run build`, start under PM2 via `ecosystem.config.cjs` (cluster mode, 2 instances, auto-restart), then `pm2 save` + `pm2 startup` so it survives a reboot.
9. Nginx reverse proxy: SSL-terminating server block (via Certbot) proxying to `127.0.0.1:3000`, where PM2's cluster listens.
10. First `npm run db:push` against the production DB — run manually, review drizzle-kit's printed plan before applying (same caution as CLAUDE.md already documents for local use — production is not exempt from reading the plan first).

## Part 2 — The repeatable "promote to live" loop (every deploy after that)

1. Develop locally as always — no change to the existing workflow.
2. Commit and push to the git remote as normal once satisfied.
3. Run one deploy command that: SSHes into the VPS, pulls the latest commit, installs deps, builds, and reloads PM2 with zero downtime (cluster reload — one instance restarts while the other keeps serving).
4. If the schema changed, run `db:push` against production as its own deliberate, reviewed step — never bundled automatically into the deploy script.
5. If something breaks, a rollback script checks out the previous known-good commit/tag and reloads again.

## Files to build when we proceed

- `deploy/ecosystem.config.cjs` — PM2 process definition (cluster mode, 2 instances, log paths, memory restart threshold).
- `deploy/setup-server.sh` — one-time provisioning script covering Part 1, steps 3–9.
- `deploy/deploy.sh` — the repeatable pull → build → reload script, run on the VPS, triggered over SSH by the user.
- `deploy/rollback.sh` — revert to the previous deploy tag and reload.
- `deploy/backup-db.sh` — nightly `pg_dump` with rotation (cron), since Postgres has no managed-provider backup net here.
- `deploy/nginx.erp.conf.template` — the Nginx reverse-proxy + SSL server block template.
- `deploy/app.secrets.production.example` — a template (not real secrets) listing exactly which vars production needs.
- A Claude Code skill (`.claude/skills/hostinger-deploy/`) documenting the guardrails for any future session acting on this: never auto-run `db:push`, never deploy without the user explicitly asking, secrets never touch git, confirm before anything destructive/hard-to-reverse on the live server.

## Guardrails to carry into execution (do not relax these later)

- Never deploy, restart the production process, or touch the production database without the user explicitly asking in that session.
- `db:push` against production is always a separate, manually reviewed step — never chained automatically after a code deploy.
- Secrets (`app.secrets`, DB passwords, session/ZATCA keys) are created directly on the VPS and never pass through git, chat, or any file in this repo.
- Before any destructive or hard-to-reverse action on the live server (DB changes, force-pushes to the deploy branch, PM2 process deletion), stop and confirm — the same standing rule this session already follows for local git operations applies with even higher stakes on a live server.
