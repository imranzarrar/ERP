# High Availability Plan (for review)

Status: **proposal, nothing built yet.** Written 2026-09-22 in response to Hostinger's notice
that VPS maintenance downtime is the customer's own responsibility — Hostinger is not
obligated to provide HA for a single VPS, and won't.

## 1. Where we actually stand today

One Hostinger VPS runs everything: Nginx, the Node app (PM2, 2 cluster instances), and
Postgres — all on the same box. That box is a **single point of failure end to end**: if it
goes down for maintenance, a kernel update, a hardware fault, or Hostinger's own network
issue, the app and the database are both unreachable at the same time, for however long that
takes. Nothing today survives that. Two things already work in our favor:

- **Sessions live in Postgres** (`connect-pg-simple`), not on local disk — nothing app-specific
  is pinned to "this one machine's" filesystem state.
- **The company logo now lives in the database**, not on local disk (this week's change) — so
  the only durable state that matters at all is the Postgres database itself. There is no other
  file-storage dependency to replicate.

That second point matters: it means "make Postgres survive an outage" is nearly the whole
problem, not one part of a bigger one.

## 2. What "high availability" actually requires, and its cost

There is no shortcut — real HA always means **the same data replicated somewhere else, and
something to redirect traffic there when the primary is unreachable.** The question is how
automatic, how fast, and how much it costs. Three honest tiers, from cheapest to strongest:

### Tier 0 — Planned-downtime discipline (what we effectively have now)
Accept the outage, but control it: a maintenance banner, a status page, doing it in your
lowest-traffic window, a fresh `backup-db.sh` run right before, and a tested rollback. This
costs nothing extra and needs no new infrastructure, but a Hostinger-initiated maintenance
window (not one you scheduled) can still hit you with no notice, and you have **zero recovery
path if the VPS simply doesn't come back** (hardware failure, not just maintenance) — you'd be
restoring from last night's backup onto a brand-new VPS.

### Tier 1 — Warm standby (recommended starting point)
A second, cheap VPS (can be Hostinger again or a different host — spreading providers is
itself a form of HA) running:
- **Postgres streaming replication** — a continuously-updated read-only copy of the database,
  seconds behind the primary.
- **The same app code, already deployed, idle** (or actually serving read traffic — see below).

When the primary goes down (planned or not): promote the standby's Postgres to primary,
point Nginx/DNS at the standby, done. With DNS TTL kept low, real downtime is **a few minutes
of manual work**, not the length of the maintenance window, and it also becomes your disaster
recovery plan for a VPS that never comes back. Cost: roughly one more small VPS
(~$5-15/month) plus the setup effort below. This is a well-understood, unglamorous pattern —
appropriate for where the product actually is today (one paying tenant in production).

### Tier 2 — True HA (automatic failover, no manual step)
A managed Postgres provider with built-in automatic failover (not self-hosted replication),
the app running on 2+ VPS instances behind a load balancer with health checks, and DNS/LB
routing that reacts to a failed node without a human. This is what "thousands of concurrent
users" (the long-term goal already on record) eventually needs, but it is real recurring cost
(commonly $50-200+/month depending on provider and DB size) and real engineering: health
checks, split-brain avoidance, replication-lag-aware reads, and — specific to this app — care
around the ZATCA hash-chain reservation (`getNextHashChainState`'s per-company row lock) so a
mid-failover moment can't produce a gap or a duplicate in a company's invoice chain. Worth
planning for, not worth building before Tier 1 is proven and the customer base justifies it.

## 3. Recommendation

**Build Tier 1 now** (it directly answers Hostinger's notice and gives real disaster
recovery, not just planned-maintenance cover), and **design Tier 1 so it grows into Tier 2**
later rather than being throwaway work — same replication concept, same deploy scripts,
just swapped for a managed DB and a load balancer once volume justifies the cost.

## 4. Tier 1 — concrete plan

1. **Provision the standby VPS.** Same OS/Node/Postgres versions as production (pin them —
   don't drift). Run `deploy/setup-server.sh` there so it's provisioned identically.
2. **Set up Postgres streaming replication** primary → standby (`postgresql.conf`/
   `pg_hba.conf`, a replication role, `pg_basebackup` to seed it). The standby stays
   **read-only** until promoted.
3. **Keep the standby's app deployed and current.** Either idle (simplest — deploy alongside
   every production deploy, `pm2 stop` until needed) or actually serving read-only traffic
   (reports, dashboards) pointed at the replica — a nice-to-have that also proves the standby
   actually works, but not required for v1.
4. **`erp_app_tenant` and RLS on the standby**: `setup-rls.sh` and `apply-rls-policies.mjs`
   must run there too — a promoted replica with the plain schema but no RLS policies would be
   a silent regression back to superuser-only access.
5. **Write `deploy/failover.sh`** (a guided, confirmed script, not a silent automatic one at
   this tier): stop writes on the primary if it's reachable, wait for replication to catch up,
   promote the standby (`pg_ctl promote` / `pg_promote()`), flip Nginx/DNS, `pm2 start`. Prints
   a clear checklist; asks for confirmation at each destructive step, same guardrail as every
   other production script in this repo.
6. **Write `deploy/failback.sh`** for the reverse once the original VPS is healthy again —
   re-seed it as the new standby, don't just flip back blindly (its data is now stale).
7. **DNS**: lower the A record TTL for `warraq.compbrain.io` well before the maintenance date
   so a flip actually propagates in minutes.
8. **Rehearse it** at least once against a scratch copy before relying on it for the real
   maintenance window — a failover script that has never actually been run is not a plan.
9. **Monitoring**: a simple external uptime check (a free service is enough at this stage)
   so a real unplanned outage is caught even if no one is watching Hostinger's status page.

## 5. What I need from you to schedule this

1. **When is the maintenance window**, and how much notice/downtime has Hostinger given? This
   sets how much of the above must be ready before that date versus can follow after.
2. **Budget for a second VPS** (Tier 1) — same host or a different provider (I'd lean
   different provider, for real independence from a single company's infrastructure).
3. **Acceptable downtime/data loss** if the primary vanished entirely right now, no warning —
   this is the number ("RTO/RPO") that actually decides whether Tier 1 is enough or you want
   to fund Tier 2 sooner.

I haven't provisioned anything or touched the production server for this — tell me which
tier to build and I'll start with the standby setup and the replication config.
