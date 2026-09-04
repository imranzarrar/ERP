# Hostinger VPS Deployment Plan

**Status: VPS purchased, deploy scripts built, one-time server setup not yet run.** Load the `hostinger-deploy` skill before touching any of this. The `deploy/` scripts referenced below now exist in the repo — see "Files built" further down for what each one does. The one-time provisioning (Part 1) has not been run against the real VPS yet; that's the next step, and it's the user's own SSH session that runs it (see "VPS access model" below).

## Decisions already locked in (confirmed with the user)

- **Target**: Hostinger VPS, 2 vCPU / 8GB RAM, Ubuntu LTS.
- **Domain**: none yet — starting on the bare VPS IP (`http://<VPS_IP>:3000`, no Nginx/SSL). `deploy/nginx.erp.conf.template` is ready and documented for whenever a domain is added later.
- **VPS access model**: the user runs setup/deploy commands themselves in their own SSH session — Claude Code does not have direct SSH access to this VPS. Give exact commands/scripts; the user pastes them and reports output back.
- **Deploy trigger**: manual — the user runs one command when ready; no auto-deploy-on-push CI/CD (at least initially). GitHub Actions can be layered on later once the app has matured, without changing the underlying scripts.
- **Runtime**: PM2 + bare Node (no Docker). Matches how the app already runs locally (`tsx`/`node`), lighter on a 2 vCPU box, no container layer to debug.
- **Database**: Postgres installed directly on the same VPS (not a managed/external provider). Requires its own backup discipline since there's no managed-provider safety net — `deploy/backup-db.sh` covers this.
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

1. Provision Ubuntu 22.04/24.04 LTS on Hostinger. Note the root SSH IP/credentials. **Done** — VPS purchased.
2. ~~Point a domain (or subdomain) A record at the VPS IP.~~ **Deferred** — running on the bare IP for now (`http://<VPS_IP>:3000`); add this + step 9 later via `deploy/nginx.erp.conf.template`.
3. Harden: create a non-root sudo deploy user, disable root SSH login, `ufw` allowing only SSH/3000 (not 80/443 yet — no Nginx until a domain exists), install `fail2ban`. Do this by hand, before cloning the repo (`deploy/setup-server.sh` can't exist on the server yet at this point).
4. Install the stack: Node.js (match the version used in dev — v24.x locally as of this VPS's setup), PM2 (`npm i -g pm2`), Postgres. (Nginx/Certbot deferred with step 2.) — covered by `deploy/setup-server.sh`, run after step 6.
5. Create a dedicated production Postgres role + database (not reusing any default) matching what `app.secrets`' `SQL_HOST`/`SQL_USER`/`SQL_PASSWORD`/`SQL_DB_NAME` expect. — `deploy/setup-server.sh` prompts for this.
6. Clone the repo onto the VPS (e.g. `/home/deploy/apps/erp`) using a read-only GitHub deploy key — never the user's personal git credentials. Do this right after step 3, before running `setup-server.sh`.
7. Create `app.secrets` directly on the VPS by hand (never committed, never transferred through git) — fresh `SESSION_SECRET`/`ZATCA_KEY_ENCRYPTION_SECRET` via `openssl rand -base64 32`, plus the DB credentials from step 5. See `deploy/app.secrets.production.example` for the full list. `deploy/setup-server.sh` checks for this file and stops with instructions if it's missing.
8. First build + start: `npm ci`, `npm run build`, start under PM2 via `deploy/ecosystem.config.cjs` (cluster mode, 2 instances, auto-restart), then `pm2 save` + `pm2 startup` so it survives a reboot. — all covered by `deploy/setup-server.sh`.
9. ~~Nginx reverse proxy: SSL-terminating server block (via Certbot) proxying to `127.0.0.1:3000`.~~ **Deferred with step 2** — `deploy/nginx.erp.conf.template` is ready for when a domain exists.
10. First `npm run db:push` against the production DB — run manually, review drizzle-kit's printed plan before applying (same caution as CLAUDE.md already documents for local use — production is not exempt from reading the plan first). `deploy/setup-server.sh` prompts for this too, but it's fine to skip and run it separately.

## Part 2 — The repeatable "promote to live" loop (every deploy after that)

1. Develop locally as always — no change to the existing workflow.
2. Commit and push to the git remote as normal once satisfied.
3. In your own SSH session on the VPS: `cd ~/apps/erp && deploy/deploy.sh` — pulls the latest commit, installs deps, builds, and reloads PM2 with zero downtime (cluster reload — one instance restarts while the other keeps serving). It auto-tags the pre-deploy commit first, so a rollback always has somewhere to go back to.
4. If `deploy.sh` prints a schema-changed warning (it diffs `src/db/schema.ts` across the deployed commit range), run `npm run db:push` yourself as its own deliberate, reviewed step — it is never run automatically.
5. If something breaks: `deploy/rollback.sh` (no argument = most recent auto-tag, or pass a specific commit/tag) reverts the code and reloads PM2. It does not touch the database.

## Files built

- `deploy/ecosystem.config.cjs` — PM2 process definition (cluster mode, 2 instances, log paths, memory restart threshold).
- `deploy/setup-server.sh` — one-time provisioning script, run from inside the freshly-cloned repo on the VPS (installs Node/PM2/Postgres/ufw/fail2ban, creates the DB role, checks for `app.secrets`, builds, first PM2 start + `pm2 save`). Covers Part 1 steps 4–10 below (the pre-repo steps — deploy user, SSH hardening, cloning — happen first, by hand, since the script can't exist on the server before the repo is cloned).
- `deploy/deploy.sh` — the repeatable pull → build → reload script, run on the VPS. Tags the pre-deploy commit automatically for rollback and warns (without blocking) if the schema changed.
- `deploy/rollback.sh` — revert to the most recent auto-tagged rollback point (or an explicit commit/tag) and reload. Never touches the database.
- `deploy/backup-db.sh` — nightly `pg_dump` with 14-day rotation; the crontab line to schedule it is in a comment at the bottom of the file (not wired in automatically).
- `deploy/nginx.erp.conf.template` — the Nginx reverse-proxy + SSL server block template. Not active yet (no domain) — its own header comment has the exact activation steps for when one is added.
- `deploy/app.secrets.production.example` — a template (not real secrets) listing every env var this app actually reads today, required vs optional.
- `.claude/skills/hostinger-deploy/SKILL.md` — the guardrails for any future session acting on this: never auto-run `db:push`, never deploy without the user explicitly asking, secrets never touch git, confirm before anything destructive/hard-to-reverse on the live server, VPS access model.

## Guardrails to carry into execution (do not relax these later)

- Never deploy, restart the production process, or touch the production database without the user explicitly asking in that session.
- `db:push` against production is always a separate, manually reviewed step — never chained automatically after a code deploy.
- Secrets (`app.secrets`, DB passwords, session/ZATCA keys) are created directly on the VPS and never pass through git, chat, or any file in this repo.
- Before any destructive or hard-to-reverse action on the live server (DB changes, force-pushes to the deploy branch, PM2 process deletion), stop and confirm — the same standing rule this session already follows for local git operations applies with even higher stakes on a live server.
