# Hostinger VPS Deployment Plan

**Status: LIVE.** The app is running in production at `https://warraq.compbrain.io` (Nginx + Let's Encrypt SSL, PM2 2-instance cluster, Postgres on the same box). Load the `hostinger-deploy` skill before touching any of this — it has the full guardrails plus a real incident (PM2 startup registered under the wrong OS user) worth reading before touching PM2 lifecycle commands.

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

- `deploy/setup-rls.sh`, `deploy/verify-rls.sh` — create the restricted `erp_app_tenant` Postgres role + grants, and check RLS afterwards (see Part 3).
- `deploy/nginx-tuning.sh` + `deploy/nginx-snippets/` — HTTP/2, gzip, and long-lived `/assets/` caching for Nginx (see Part 3). Idempotent.
- `scripts/verify-tenant-isolation.ts` — proves company isolation using the real restricted role inside a transaction that is always rolled back (safe on production).

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

## Part 3 — Everything learned from the RLS / inventory release (2026-09-19). Read before moving hosts.

### 3a. Row-Level Security needs its own one-time setup (a fresh server, or the first deploy that contains RLS)
Order matters; each step needs the previous one:
1. `bash deploy/setup-rls.sh` — creates role `erp_app_tenant` (LOGIN, NOSUPERUSER, NOBYPASSRLS) and grants it DML on all tables (+ default privileges for future tables). It prompts for a password.
2. Put `TENANT_DB_USER=erp_app_tenant` and `TENANT_DB_PASSWORD=<same password>` in `app.secrets` **by hand**. Use a password of letters and digits only (e.g. `openssl rand -hex 20`): `dotenv` treats `#`, `$` and quotes specially, and a mismatched password makes every tenant-scoped request fail with "password authentication failed for user erp_app_tenant". (That is exactly what happened on the first deploy: pages loaded forever, see the log line in `pm2 logs --err`.)
3. Deploy the code (`deploy.sh`), then `npm run db:push` (read the plan: only policies/indexes expected).
4. `npx tsx scripts/apply-rls-policies.mjs` — **mandatory after every db:push**: drizzle-kit creates policies but drops their USING/WITH CHECK conditions.
5. `bash deploy/verify-rls.sh` (must print `RLS OK`) and `npx tsx scripts/verify-tenant-isolation.ts` (must print `ALL ISOLATION CHECKS PASSED`; it creates two temporary companies inside a transaction that is rolled back — nothing is left behind).
Also: Postgres `max_connections` must cover, per PM2 instance, the normal pool plus the tenant pool (`TENANT_DB_POOL_MAX`, default 10).

### 3b. Nginx performance setup (not optional)
`bash deploy/nginx-tuning.sh <domain>` after Certbot. It (1) adds HTTP/2 to the 443 listeners, (2) turns on gzip for JS/CSS/JSON — Ubuntu's stock `nginx.conf` only compresses HTML because `gzip_types` is commented out, and (3) caches the content-hashed `/assets/` files for a year (`immutable`) while leaving `index.html` uncached so deploys show up immediately. Verify:
`curl -sI -H 'Accept-Encoding: gzip' https://<domain>/assets/<index-hash>.js` → `HTTP/2 200`, `content-encoding: gzip`, `cache-control: public, max-age=31536000, immutable`.
Why each matters (measured): over HTTP/1.1 a burst of ~110 requests queued for ~6 s behind the browser's 6-connection limit; the bundle was 2.1 MB raw with `max-age=0`.

### 3c. Client delivery, so the app stays fast as data grows
- The JS bundle is split: first load ≈ 0.5 MB (152 KB gzip); each screen is fetched on first use (`React.lazy` in `src/App.tsx`); react/charts/motion are separate stable chunks (`vite.config.ts`).
- The UI dictionary is **not** in `/api/state` any more: `GET /api/translation-bundle?lang=` (user's language only; all three for super-admins) with a content-digest ETag → repeat loads are a 304.
- Browsers no longer auto-register missing translation keys in production (`ALLOW_TRANSLATION_AUTOREGISTER=true` re-enables it, off by default); new keys ship through reviewed changes. In dev it still works, batched (`POST /api/register-missing-keys`).

### 3d. Diagnosing "the site is slow" — check the network first
Two separate times a slowdown blamed on the release was the user's own connection (packet loss, 2-4 s TLS handshakes) while the VPS sat idle. Before touching code: (1) `top` + `pg_stat_activity` on the VPS (idle = not the server); (2) from the affected machine, `curl -w "connect=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer}"` against the site and against a well-connected site for comparison, plus `ping` for loss; (3) browser Network tab → the slow request's Timing → "Waiting for server response". Locally, saving an invoice takes ~20-65 ms with RLS on, so multi-second saves point at the path or at an external call, not the database.

### 3e. Gotchas
- **Never `source app.secrets` in bash**: a value with an unquoted space makes bash try to run its second word as a command (`Compbrain: command not found`). Read single keys with `grep`/`cut` instead.
- `deploy.sh` exits early ("Already up to date") if the code was already pulled by hand — then the build/reload never ran. If unsure, run `npm run build && pm2 reload deploy/ecosystem.config.cjs`.
- New shell scripts checked in from Windows lose their executable bit; run them with `bash deploy/<script>.sh` (or `git update-index --chmod=+x`).
- After a deploy, users with a stale cached page may see a blank screen once; a hard refresh (Ctrl+Shift+R) or "Clear site data" fixes it.
