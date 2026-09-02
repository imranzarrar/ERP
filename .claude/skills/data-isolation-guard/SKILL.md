---
name: data-isolation-guard
description: Run this after any development task that adds or edits a route in server/routes/*.ts — a new endpoint, a new field on an existing write, a new document-creation flow, or any change touching db.insert/db.update. Also run it proactively whenever the user asks to verify, audit, or double-check tenant/company/branch/location data isolation, or asks "can we call isolation fully achieved." This app is multi-tenant (every business table carries a companyId) and multi-branch (documents optionally carry a branchId, restricted via req.allowedBranchIds) — three separate audit passes this session each found real cross-tenant or cross-branch bugs the previous pass missed, all sharing one shape: a foreign-key-looking field taken straight from the client and used in a write with no check that it belongs to the caller's own company/branch. This skill is the repeatable, automated version of that check — treat a clean run as one input to "isolation looks solid," never as a substitute for actually reviewing what a new route does with its foreign-key fields.
---

# Data Isolation Guard (this ERP)

This app's core invariant, stated in `CLAUDE.md`: every business table carries a `companyId`, resolved server-side per request as `req.targetCompanyId` — never trusted from the client. Layered on top of that, tables that support multi-branch (physical location) restriction carry a `branchId`, checked against `req.allowedBranchIds` via `branchAccessOk`/`branchAccessOkViaWarehouse` (`server/lib/authz.ts`).

Three independent isolation audits this session (BACKLOG.md items 95, 96, 97) each found real, exploitable bugs — and each pass found bugs the *previous* pass's audit had missed, despite covering the same files. Every single bug shared the same shape: **a foreign-key field (`customerId`, `vendorId`, `productId`, `warehouseId`, `bankId`, `branchId`, `createdById`, ...) read straight from `req.body` and used in a `db.insert`/`db.update` with no check that the row it points at belongs to the caller's own company (or branch).** The worst of them (`POST /investors`, item 97) was a complete cross-tenant row hijack — no ownership check at all, verified live by actually hijacking a test record from a different company's session.

## Run the check

```bash
node scripts/check-data-isolation.mjs
```

Exits non-zero with a list of findings if it traces any client-supplied foreign-key field into a write with no detected ownership check. Exits 0 with "No unchecked client-supplied foreign keys found" otherwise. Add `--json` for machine-readable output.

**Run this after touching any file in `server/routes/*.ts`** — a new route, a new field added to an existing insert/update, a new document-creation flow, or a refactor that moves a write around. It's cheap (a few hundred milliseconds, no server or DB needed) — there's no reason to skip it.

## What it actually checks, and what it deliberately doesn't

The script (`scripts/check-data-isolation.mjs`) parses every route handler in `server/routes/*.ts` via the TypeScript compiler API, traces which local variables are (transitively) bound to `req.body` with no database round-trip in between, and flags any `Id`-shaped write-payload field whose value traces back to the client with no evidence of an ownership check nearby (a call to one of this codebase's known helpers — `assertOwnsRow`, `assertDocumentRefsOwnedByCompany`, `assertProductsOwnedByCompany`, `branchAccessOk`, `branchAccessOkViaWarehouse`, `resolveDocumentBranchId` — or a direct `eq(schema.X.id, ...)` + `eq(schema.X.companyId, ...)` pair in the same area).

Read the comment block at the top of the script itself before trusting a clean run blindly — it documents the deliberate scope narrowing in detail. In short: this is **a tripwire for the exact bug pattern found three times this session, not a formal prover.** It will not catch:
- A value that passes through even one DB round-trip you haven't yet added a `companyId` filter to (e.g. `const [row] = await tx.select()...` with no `eq(companyId, ...)` in its own `where` — the script trusts any DB-fetched row's fields by design, since tracing whether *that* select was itself scoped is a different, harder analysis).
- A field buried in a bare object spread (`{ ...someObject }`) — the script can't see through it.
- Anything that isn't a foreign-key-shaped (`*Id`) field — e.g. a client-controlled amount, date, or status string bypassing business-rule validation is a different bug class entirely, out of scope here.
- Logic bugs where a check exists but checks the *wrong* thing.

A finding is a strong signal something needs a human/agent look — not automatically a real bug, and a clean run is not proof nothing is wrong, exactly as items 95-97 demonstrated for prior code-review-style audits. Every finding still deserves the judgment a person or an agent brings: read the route, decide if it's real.

## Reading and resolving a finding

```
server/routes/inventory.ts:342  [POST /goods-receipt-notes]  'vendorId: grnData.vendorId' — client-supplied, used in .values() with no detected ownership check
```

1. Open the file at that line. Confirm whether the field really is unchecked (the script's heuristics have false-positive edges — see above).
2. If it's a real gap: add the appropriate check before the write. For a company-scoped foreign key, follow the pattern already used everywhere in this codebase:
   ```ts
   const [row] = await tx.select({ id: schema.vendors.id }).from(schema.vendors)
     .where(and(eq(schema.vendors.id, vendorId), eq(schema.vendors.companyId, companyId)));
   if (!row) { const err: any = new Error('Selected vendor not found for this company.'); err.status = 400; throw err; }
   ```
   For several fields on the same document, prefer `assertDocumentRefsOwnedByCompany` (`server/routes/transactions.ts`) or add a new shared helper in `server/lib/businessLogic.ts`/`server/lib/authz.ts` the same way `assertProductsOwnedByCompany` was added — one helper, many call sites, not a one-off inline check duplicated everywhere. For a branch-scoped table, use `branchAccessOk`/`branchAccessOkViaWarehouse`, or `resolveDocumentBranchId` at write time.
3. If it's a false positive (the field genuinely is safe in a way the script can't trace): add a same-line comment naming the field, e.g.:
   ```ts
   // isolation-ok: vendorId inherited from an already company-checked PO above
   ```
   This silences the specific finding. Use it honestly — it's a claim a human verified the safety, not a way to make noise disappear. Never add one just to get a clean run without actually checking.
4. Re-run the script. It should be clean (or show only findings you've deliberately deferred).

## Improving the script itself

If you find a *real* bug this script's current heuristics don't catch, or a *false positive* pattern common enough to be worth teaching the script (not just suppressing with one comment), improve `scripts/check-data-isolation.mjs` itself rather than working around it — that's exactly how it went from a first draft flagging 60 mostly-noise findings down to a clean, trustworthy baseline this session (see its own extensive internal comments for the specific false-positive classes already handled: DB-round-trip taint breaking, `.id`-access safety, fallback/coalesce variable provenance tracing, bare-identifier `.values(itemRows)` resolution, `router.use()`-level shared gates, super-admin-only exemptions). When you change it, **re-run it against the current codebase and confirm the baseline is still clean (or that any new findings are genuinely new, real issues)** before trusting the new version — the same self-test discipline used to build it: deliberately reintroduce a known-bad pattern into a scratch copy of a route file, confirm the script catches it, then delete the scratch file.

## The honest limit of "isolation is achieved"

Don't report isolation as a permanently solved, checked-off state after running this script (or after any single audit). The real, calibrated claim is: *every specific gap found so far is fixed and verified two ways (live attack testing plus code review), and this script now catches the exact shape of bug that caused all of them.* That is meaningfully different from "no bugs exist" — a new route or a new field on an existing one can still introduce the same pattern tomorrow, which is exactly why this exists as a repeatable check to run after every change, not a one-time audit to close out.
