---
name: rls-tenant-isolation
description: Use this skill whenever adding a new table to src/db/schema.ts, adding a new route in server/routes/*.ts, or reviewing/debugging anything related to Postgres Row-Level Security (RLS), tenantDb()/withTenantDb, or "why does this query see/not see another company's row." Every table in this app now carries a real RLS policy as a database-level backstop beneath the existing app-level companyId filtering — this is not optional infrastructure to skip for a new table, it is part of what "creating a table" means in this codebase from now on. Trigger proactively even if the request doesn't mention RLS/security/isolation explicitly (e.g. "add a new table for X", "add a route that writes to Y") — a table or route built without this skill's checklist is incomplete, not just unhardened.
---

# Postgres Row-Level Security (this ERP)

This app is multi-tenant — every business table carries a `companyId`, and until this rollout the *only* thing enforcing tenant isolation was application code remembering to filter every query by `req.targetCompanyId` (see `session-company-scoping` for how that value itself is resolved). That's a single point of failure: one route that forgets one `WHERE companyId = ...` is a cross-tenant data leak, and this codebase has hit that exact bug shape for real more than once (see `data-isolation-guard`'s own history of three separate audits each finding bugs the previous one missed).

**Every table in `src/db/schema.ts` now has RLS enabled, with a real policy — no exceptions.** RLS is a second, database-level layer that holds even when a route's own app-level filtering is wrong or missing. It does not replace `data-isolation-guard`'s ownership checks or `session-company-scoping`'s `req.targetCompanyId` resolution — it backstops both.

## How it actually works

RLS only takes effect on a Postgres connection that is **not** a superuser and does **not** have `BYPASSRLS`. This app's original connection (`db`, from `src/db/index.ts`, using `SQL_USER=postgres`) is a superuser and bypasses RLS entirely — always has, always will, and that's deliberate (it's what genuinely cross-tenant admin operations need, see Exemptions below). A second, restricted role (`erp_app_tenant`, `TENANT_DB_ROLE` in schema.ts) is what RLS policies actually apply to.

`server/lib/tenantDb.ts` provides the real per-request mechanism:
- **`withTenantDb`** — Express middleware. Opens one Postgres transaction for the entire request on the `erp_app_tenant` role's connection, runs `SELECT set_config('app.company_id', $1, true)` scoped to `req.targetCompanyId` (transaction-local via `is_local = true`, so it can never leak across a pooled connection to a different request), and stores `{ db, afterCommitCallbacks }` in `AsyncLocalStorage` for the request's lifetime.
- **`tenantDb()`** — returns that request's transaction-scoped drizzle instance from inside the handler. Every `select`/`insert`/`update`/`delete` you run through it is subject to RLS.
- **Commit timing is response-timing, not middleware-timing**: the transaction only commits (or rolls back) when `res.end()` is called, by overriding `res.end` itself — never from a `res.on('finish', ...)` listener, which fires *after* the client has already received the response and could race ahead with a follow-up read on a different connection. This was a real bug found and fixed in this rollout; don't reintroduce a `finish`-based commit if you ever touch this file.
- **`runAfterTenantCommit(callback)`** — registers a callback that fires only after a successful commit, immediately before the response bytes are flushed. Exists for the handful of routes that fire a side effect (like ZATCA submission) immediately after their own write commits, on the assumption the row is already durably visible to a separate connection — see the ZATCA note below.

A route opts in with `router.method('/path', withTenantDb, async (req, res) => { const tdb = tenantDb(); ... })`. **Never wrap a `tenantDb()`-backed handler's body in its own `db.transaction(async (tx) => {...})`** — `withTenantDb` already wraps the whole request in one transaction; a nested one is redundant at best and at worst a second, separately-committing transaction that breaks the "commits exactly when the response is sent" guarantee. Unwrap any old `db.transaction` into plain sequential `tdb.` calls; `.for('update')` row locks carry over unchanged and still work correctly inside the outer transaction.

## Every table gets a policy — the four shapes

Match the table's actual shape; don't guess or default to the first one that compiles.

**A — direct `companyId` column** (the common case: `vendors`, `invoices`, `expenses`, most of the schema):
```ts
tenantIsolationPolicy: pgPolicy('vendors_tenant_isolation', {
  for: 'all', to: TENANT_DB_ROLE,
  using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
}),
```
Add this alongside `.enableRLS()` on the table, and add an `index(...)` on `companyId` if one doesn't already exist — RLS's predicate is evaluated on every row scanned, so an unindexed `companyId` on a high-volume table (this rollout found `stockLedgerTransactions` with *zero* indexes at all) turns every query into a sequential scan.

**A-special — self-scoping / nullable-companyId tables**: `companies` scopes via its own `id`, not a `companyId` column (`${table.id} = current_setting(...)`). `auditLogs` and `user_sessions` have a *nullable* `companyId` — the policy is the same equality check, which means a NULL-company row (a system-level entry with no attributable tenant) is simply invisible under any tenant-scoped connection. That's correct, not a gap: there's no legitimate reason a tenant connection needs to see system-level rows, and the routes that manage those tables stay on the superuser `db` anyway (see Exemptions).

**B — child table, no own `companyId`, scoped via a parent FK**:
```ts
tenantIsolationPolicy: pgPolicy('invoice_items_tenant_isolation', {
  for: 'all', to: TENANT_DB_ROLE,
  using: sql`EXISTS (SELECT 1 FROM ${schema.invoices} WHERE ${schema.invoices.id} = ${table.invoiceId} AND ${schema.invoices.companyId} = current_setting('app.company_id', true)::uuid)`,
  withCheck: sql`EXISTS (SELECT 1 FROM ${schema.invoices} WHERE ${schema.invoices.id} = ${table.invoiceId} AND ${schema.invoices.companyId} = current_setting('app.company_id', true)::uuid)`,
}),
```
Add an index on the parent-FK column (`invoiceId` above) if one doesn't exist — same reasoning as the companyId index above, this time for the `EXISTS` subquery's own lookup.

**B-dual-parent — a junction with two parent FKs** (`userRoles`, `userBranches`, `productModifierGroups`): check ONE side only (whichever parent the app already treats as authoritative), documented inline as relying on an existing app-level invariant that both sides always belong to the same company. Before writing one of these, run a query confirming zero existing rows currently violate that invariant.

**C — genuinely cross-tenant, not company-scoped at all** (`translations`, `roleTemplates`, `companyOnboardingRequests`, `deletedCompanyLog`): still gets `.enableRLS()` and a policy — just an explicit allow-all one:
```ts
tenantIsolationPolicy: pgPolicy('translations_shared_access', {
  for: 'all', to: TENANT_DB_ROLE, using: sql`true`, withCheck: sql`true`,
}),
```
This is meaningfully different from skipping RLS on the table: it's now an auditable, deliberate declaration ("this is shared by design") instead of an accidental gap someone has to rediscover later. Every route touching one of these tables is still a documented permanent exemption (see below) — the allow-all policy doesn't make tenantDb migration pointless so much as unnecessary; these routes are already super-admin-gated and don't benefit from a company-scoped connection they'd never use.

**D — user-scoped, not company-scoped** (`passwordResetTokens`): policy via `EXISTS` against `users` (same shape as category B, joining through `userId` → `users.id` → `users.companyId`). Covered for schema-level completeness even though the routes that touch it stay on the superuser `db` (auth/password-reset is pre-session, no `req.targetCompanyId` exists yet).

## The drizzle-kit predicate-dropping bug — and the one command that fixes it

**Confirmed bug in drizzle-kit 0.31.10**: `npm run db:push` silently drops every `pgPolicy()`'s `using`/`withCheck` predicate from the generated DDL — verified via `SELECT pg_get_expr(polqual, polrelid) FROM pg_policy` showing `NULL` after a push that should have created a real predicate. The policy row exists; its actual condition doesn't.

**The fix, and the step you must run after every `db:push` that touches any table with a policy:**
```bash
npx tsx scripts/apply-rls-policies.mjs
```
This introspects `schema.ts`'s live table objects at runtime (`getTableConfig(table)` from `drizzle-orm/pg-core`), extracts each table's declared `PgPolicy` objects with their real `using`/`withCheck` `SQL` objects, converts each to raw SQL via `new PgDialect().sqlToQuery(...)`, applies it directly via `ALTER POLICY ... USING (...) WITH CHECK (...)`, then re-verifies via `pg_policy` that every predicate is non-null (except the deliberate `true` ones from Category C). It exits non-zero on any failure or unverified policy — treat a non-zero exit as "the database does not actually have the isolation your schema.ts claims," not a warning to shrug off.

This makes `schema.ts` the single source of truth for policies (matching this codebase's own stated principle) instead of a hand-maintained duplicate list — add a new table's policy to `schema.ts` and the script picks it up automatically, no separate registration step. It is idempotent: re-running it against a database that already has correct predicates is a no-op (verified empirically — a second run prints no `ALTER POLICY` statements at all).

**`tests/rlsPolicyCoverage.test.ts`** asserts every table in the live schema has `relrowsecurity = true` and a real, non-null policy predicate — run it (part of the normal suite) any time you're unsure whether a table's policy actually survived a schema change.

## Exemptions — when a route does NOT move to tenantDb()

Every table gets a policy regardless of whether any route ever queries it through `tenantDb()` — but not every route can safely use `tenantDb()`, because a `tenantDb()` connection is scoped to exactly one company (`req.targetCompanyId`) for the whole request. Two genuinely different shapes below; don't conflate them.

**1. Hijack-detection lookups — keep ONLY the lookup on `db`, the write can still move to `tenantDb()`.** A route that intentionally fetches a row by `id` ALONE (no `companyId` filter) specifically to catch and reject a cross-company reference via `assertOwnsRow` must keep that ONE lookup on the superuser `db`. Querying it via `tenantDb()` would make a cross-company row invisible under RLS instead of visibly rejected — turning a clean 403 into a confusing 404 or insert-conflict error (this was actually caught live by a test during this rollout). Once the check has run and passed, the actual insert/update/delete that follows is normally safe to run on `tenantDb()` — see `masterEntities.ts`'s customers/vendors/bank-accounts routes for the established pattern. This is also a *net safety improvement* for the rare case where a super-admin's `assertOwnsRow` bypass (see below) lets a check pass for a row outside their own active company: under `db`, the write would silently succeed against that other company's row; under `tenantDb()`, RLS makes it a safe no-op instead.

**2. Full-route exemptions — the write itself targets a DIFFERENT company than `req.targetCompanyId`, genuinely and by design.** `assertOwnsRow` returns `true` unconditionally for a super-admin, *regardless of whether the row's actual company matches `req.targetCompanyId`* (see `server/lib/authz.ts`). For most routes this bypass is defensive and never really exercised (a super-admin's UI only ever hands back rows from whichever company they've switched into). But a few routes have a **documented, intentional** cross-company write as their entire reason for existing — `POST /users` respecting an explicitly-super-admin-supplied `companyId` in the body is the canonical example (the exact feature this rollout's own test suite proves: a super-admin creating a user for a company other than their own must save it under the *selected* company). For a route like that, `tenantDb()` cannot serve it at all: an insert/update with a `companyId` different from `req.targetCompanyId` would either violate RLS's `WITH CHECK` outright (a hard failure) or, for a delete/toggle of an existing row in a different company, silently affect zero rows (RLS makes that row invisible) while still returning `{success:true}` — the exact silent-failure shape `users.ts`'s own `DELETE /:id` comment documents having already been found and fixed once for real, before this rollout even started. **The whole route stays on `db`, not just a lookup, whenever it has this shape** — check the actual write's target companyId, not just whether `assertOwnsRow` is present, before deciding a route is safe to migrate.

**Permanent, cross-tenant-by-nature (companies.ts, roleTemplates.ts, onboarding.ts, sessions.ts, users.ts's admin surface, zatca.ts pending its own dedicated pass, and the four Category C tables' routes)**: every one of these is documented inline, at the route, with a comment explaining *why* — not just a bare "exempt." When you exempt a route, write that comment; a future reader (including future-you) needs to be able to tell "deliberately exempt" from "just hasn't been migrated yet."

## ZATCA-adjacent routes need extra care, not automatic deferral

`processInvoiceZatca()` is fired **fire-and-forget** immediately after a write's own transaction commits (see `CLAUDE.md`'s ZATCA section) — it assumes the row is already durably committed and visible to a separate connection the moment it's called. Under `tenantDb()`'s commit-at-response-time model, calling this synchronously mid-handler (before `res.json()`) would fire it *before* the real commit. Use `runAfterTenantCommit(callback)` instead of calling it inline — it only runs after a genuinely successful commit, right before the response is flushed. This is now wired into all four fire-and-forget call sites (`transactions.ts`'s `POST /invoices` and `POST /invoices/:id/note`, `pos.ts`'s `POST /returns`) plus `transactions.ts`'s `POST /invoices/:id/cancel` (its hash-chain-tip rollback migrated the same way as any other `db.transaction`-wrapped route — no fire-and-forget call of its own). `processInvoiceZatca()` itself is never touched and stays on the superuser `db` permanently — it's an independent background job with its own connection lifecycle, not a request-scoped one, so it cannot use `tenantDb()` regardless of RLS status. A route that merely *reads* ZATCA-adjacent state (e.g. checking `invoices.zatcaStatus` before allowing a VAT return to file) is not in this category and migrates normally — don't defer a route just because it mentions ZATCA in a comment; check whether it actually fires the submission pipeline itself.

**`server/routes/zatca.ts` (ZATCA's own configuration/onboarding surface) stays a permanent exemption in full** — not the fire-and-forget concern above, a different and structural one: its own `router.use()` gate unconditionally lets a super-admin through with no company-match check at all, so every config/onboarding route there (and `GET /company-status/:companyId`) can legitimately act on a company other than the super-admin's own active one. A `tenantDb()` connection is scoped to exactly one company for the whole request and cannot serve that. `POST /submit-invoice/:invoiceId` is a narrower case: its own ownership-check read stays on `db` for the usual hijack-detection reason, and it has no write of its own to migrate — it just awaits `processInvoiceZatca()` synchronously (not fire-and-forget, so no commit-ordering concern either).

**Verified live against ZATCA's real (non-mocked) sandbox API** after wiring the four fire-and-forget call sites: a fresh invoice, a Credit Note against it, and a cancel-after-submission attempt against a third invoice all completed correctly — `zatcaStatus` reached `REPORTED` with ZATCA's own `XSD_ZATCA_VALID` pass on every submission, ICV advanced correctly and sequentially across all three (proving the hash-chain lock still works correctly through `tenantDb`), and the cancel route correctly rejected cancellation once ZATCA had already reported the invoice. `fatoora -validate` against the stored XML passed `[XSD]`/`[EN]`/`[KSA]`/`[QR]`; its `[SIGNATURE]`/`[PIH]` checks failed on this run due to a local JDK 21 vs. the SDK's expected JDK 11 environment gap (`secp256k1` unsupported by JDK 21's default crypto provider, confirmed via the exact same failure on both a fresh invoice and its Credit Note) — a pre-existing local tooling gap unrelated to this change (zero lines of `processInvoice.ts`/`xmlBuilder.ts`/`hashChain.ts`/`crypto.ts` were touched), not a regression; ZATCA's own server-side signature verification (the authoritative check) already passed, since a real `REPORTED` status is only returned for a cryptographically valid submission. Re-run `fatoora -validate` under a real JDK 11 before trusting the SDK's own SIGNATURE/PIH verdict specifically.

## Checklist: every new table, from now on

1. Add the `companyId` column (or parent FK, for a child table) as you would have anyway.
2. Add `.enableRLS()` and the matching `pgPolicy(...)` for whichever category above actually fits — don't default to Category A out of habit if the table is genuinely a child table or genuinely cross-tenant.
3. Add the index the policy needs (`companyId`, or the parent-FK column) if the table doesn't already have one serving that lookup.
4. Run `npm run db:push`, then `npx tsx scripts/apply-rls-policies.mjs` — every time, not just the first time. Confirm it reports the new policy verified.
5. Build the table's route(s) on `tenantDb()`/`withTenantDb` from day one — there is no reason for a brand-new table to start on the superuser `db` and migrate later, unless it falls into one of the two Exemption shapes above from the start (a genuinely cross-tenant admin table, or a route whose write deliberately targets another company).
6. Run `npm run check:isolation` (see `data-isolation-guard`) regardless — RLS is a backstop for when app-level filtering is wrong, not a replacement for having it right in the first place.
7. Write or extend an isolation test proving the raw-connection, no-`WHERE`-clause guarantee for the new table — see any `tests/tenantDbPhase*Rls.test.ts` file for the established shape (open a second connection as `erp_app_tenant`, `set_config('app.company_id', ...)`, query with no `WHERE`, assert the other company's row is absent).

## Related skills

`session-company-scoping` — how `req.targetCompanyId` itself gets resolved; RLS trusts that value completely, so a bug in its resolution is a scoping bug, not an RLS bug. `data-isolation-guard` — the app-level ownership-check tripwire this supplements, never replaces; a table with a perfect RLS policy still needs its routes to pass `check:isolation`, because RLS only ever prevents *cross-company* leakage, not a same-company authorization mistake (e.g. a non-admin editing a record they shouldn't).
