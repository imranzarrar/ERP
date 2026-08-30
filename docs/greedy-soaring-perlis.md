# Multi-Branch Support: Entity, ZATCA Address, and Branch-Level Access Control

## Context

The portal currently models a `company` as one legal entity with one VAT/CR number, one address, and one shared ZATCA identity per environment. There is no `branchId` anywhere in the schema. The user operates 6 physical locations under one company (Riyadh, Jeddah, 2x Dammam, +2 more) and needs two distinct things:

1. **A `branches` entity**, so invoices/POS sales can be tagged with the issuing outlet, and the ZATCA XML shows that outlet's real address — while still using **one shared CSID and one continuous ICV/PIH hash chain for the whole company** (confirmed as the target compliance model; `hashChain.ts`'s lock is `(companyId, environment)` only and must stay that way).
2. **Branch-level data access control**, full operational scope: a user assigned to one branch sees only that branch's invoices, POS sales, quotations, expenses, vouchers, and inventory/stock by default. A company-level user (no branch assigned, or explicitly granted a "view all branches" permission) sees everything, exactly like today.

This mirrors a scoping pattern this codebase already has for `companyId` (see the `session-company-scoping` skill and `server.ts`'s `isAuthenticated`) — and that pattern has a documented history of subtle, compounding bugs (BACKLOG item 64) when done ad hoc. The plan below deliberately reuses that already-fixed shape rather than inventing a new one.

## Part A — Schema (`src/db/schema.ts`)

- **New `branches` table**: `id`, `companyId` FK, `name`, `code`, `streetName`, `buildingNumber`, `district`, `city`, `postalCode`, `countryCode` (default `'SA'`), `phone`, `isActive`, `isDefault`. Same partial-unique-index pattern as `taxSlabs.isDefault` (schema.ts:181): `unique_default_branch` on `(companyId) WHERE is_default = true`. Index on `companyId`.
- **`invoices.branchId`** — nullable FK to `branches`, indexed. Covers POS too (POS sales are just `invoices` rows with `isPosSale = true`, same table, same route — confirmed no separate POS invoice path exists).
- **`quotations.branchId`** — nullable FK, indexed.
- **`expenses.branchId`** — nullable FK, indexed.
- **`vouchers.branchId`** — nullable FK. Not user-set: vouchers are system-generated side effects (invoice/expense payment, transfers, investor postings — inserted from `businessLogic.ts`, `transactions.ts`, `expenses.ts`, `inventory.ts:913`), so this is always inherited from the source transaction's `branchId` at insert time, never picked in a form.
- **`warehouses.branchId`** — nullable FK. This is the hook for branch-scoped stock visibility. Deliberately **not** adding `branchId` to `inventoryStocks`, `goodsReceiptNotes`, `purchaseReturns`, `physicalStockTakes`, or `stockLedgerTransactions` — all five already carry `warehouseId`, and a stock movement's branch is always its warehouse's branch. Storing it twice would create a second source of truth that can drift; scope those five via a join/subquery on `warehouses.branchId` instead.
- **`users.branchId`** — nullable FK. `null` = company-level user (sees all branches). Non-null = home branch, and the default scope ceiling for that user.

All FKs nullable, so `db:push` never blocks on existing data — old rows simply have no branch until backfilled, and fall back to today's company-level behavior everywhere (unscoped for existing users, company address for existing invoices' ZATCA XML).

## Part B — Branch-level access control (mirrors `req.targetCompanyId`)

**Permission leaves** — add a new `branches` permission module in `src/permissionSchema.ts` (visible module, modeled on `taxSlabs`, not `hidden` like `warehouses`) with **`read`/`update`/`delete`/`viewAllBranches`** leaves only — deliberately **no delegable `create` leaf**. Creating a new branch is a licensing-gated action (each branch likely counts against the company's subscription tier) and must stay **super-admin only**, hard-coded, mirroring `POST /api/companies`'s existing `isSuperAdminUser(req.user)` gate (masterEntities.ts:249) rather than going through the normal permission system at all — granting `branches.create` to a company admin would be meaningless since they still couldn't use it. Editing an existing branch's details, deactivating one, and viewing the list stay normal delegable permissions. `viewAllBranches` resolved through the existing union-of-roles model (`mergeRolePermissions`) — no new mechanism needed.

**`canViewAllBranches(user)` helper** — add next to `isSuperAdminUser`/`isAdminUser` in `server/lib/authz.ts` (authz.ts:6-16 for the exact pattern to follow): `isSuperAdminUser(user) || isAdminUser(user) || hasPermission(user, 'branches.viewAllBranches') || !user.branchId`.

**`req.targetBranchId` resolution** — in `server.ts`'s `isAuthenticated`, immediately after the existing `req.targetCompanyId` block (server.ts:257-271), add the analogous resolution — but with the security boundary inverted from the company version:

```ts
const canViewAll = canViewAllBranches(user);
const branchOverride = req.query.branchId || req.body.branchId || req.headers['x-branch-id'];
if (!canViewAll) {
  req.targetBranchId = user.branchId; // hard ceiling — never trust client input here
} else if (branchOverride) {
  req.targetBranchId = branchOverride; // explicit focus, e.g. a report filter
} else if (req.session?.branchId) {
  req.targetBranchId = req.session.branchId; // persisted "focused branch" selection
} else {
  req.targetBranchId = null; // no filter — see all branches
}
```
The critical difference from the company pattern (server.ts:257-271): for company, an explicit override is only *redirected* to the user's own value on mismatch (a non-super-admin can still technically request their own company). For branch, a restricted user's `req.targetBranchId` must be forced to `user.branchId` **unconditionally** — an override attempt from a restricted user is never honored, full stop.

**`POST /api/switch-branch`** — new route mirroring `POST /api/switch-company` (server.ts:512-553) exactly, including the `req.activeSessionId` raw-row-update against `user_sessions` (server.ts:534-541) rather than relying on `req.session.save()` alone — that dual-write is required specifically because of the `x-session-id` test/API path, per the skill. Gate it on `canViewAllBranches(user)` — a restricted user has nothing to switch to.

**Frontend branch switcher** — add alongside the existing company switcher in `App.tsx` (949-966 / 1226-1240 pattern), for `canViewAllBranches` users only. Reuse `triggerDbRefresh`'s already-proven-correct design (App.tsx:195-268): it deliberately does **not** pass the just-set value as a query param, because the `setDb()` in the same handler hasn't applied to that render's closure yet (this exact bug was BACKLOG item 64's third bug) — it relies on the server session (just updated by `switch-branch`) as source of truth instead. The new branch switcher must follow the same shape, not reintroduce the stale-closure pattern.

## Part C — Wiring the filter into every read path

This app has **two parallel read paths** for these tables (per `CLAUDE.md`), and both need the branch filter or restricted users will still see everything through the other one:

**1. Dedicated SQL routes** (`server/routes/transactions.ts`, `expenses.ts`):
- Invoices GET/POST (`transactions.ts:319-336`) and Quotations GET (`transactions.ts:16-39`) already build a `conditions` array and conditionally push a `createdById` predicate for non-admins — add a `req.targetBranchId` predicate the same way.
- Expenses GET (`expenses.ts:13-27`) currently a single `eq(companyId)` — extend to `and(eq(companyId), branchId ? eq(branchId) : undefined)`.
- Warehouses GET (`masterEntities.ts:765-777`) — same treatment, using `warehouses.branchId`.
- On create (POST), set `branchId` on the new row from the request body (validated to belong to `req.targetCompanyId`) for invoices/quotations/expenses; for a restricted user, force it to `req.targetBranchId` server-side regardless of what the client sent (mirrors the read-side boundary).

**2. `/api/state` bootstrap** (`server.ts:941-1035`) — filters in JS after an unscoped `getFullState()` call, not SQL. Add the same branch filter as a `.filter()` step alongside the existing `companyId` filters: `quotations` (line 976), `expenses` (978), `vouchers` (981), `warehouses` (989), `inventoryStocks` (993) — vouchers in particular have **no dedicated route at all**, so this is the only enforcement point for them. For `inventoryStocks`/GRN/purchaseReturns/physicalStockTakes/stockLedgerTransactions, filter via "does this row's `warehouseId` belong to a warehouse whose `branchId` is in the allowed set" rather than a direct column.

## Part D — New-company & ZATCA integration (unchanged from earlier design)

- **Starter resources** (`AdminSettings.tsx:955-996`, the existing `createResource` sequence for bank/customer/vendor/template/fiscal-month on company creation) — add a `newBranch` (`name: 'Main Branch'`, `isDefault: true`) the same way.
- **ZATCA seller address** (`server/lib/zatca/processInvoice.ts`, `seller` object built at lines 255-265 and 380-390) — when `invoice.branchId` is set, override `street/buildingNumber/district/city/postalCode` per-field from the branch (falling back to `zatcaEnvironmentConfigs` per-field, not all-or-nothing, so a partially-filled branch doesn't blank a working address). No changes to `xmlBuilder.ts` or `hashChain.ts`.

## Part E — Frontend forms & permissions surfacing

- New `branches` sub-tab in `MasterEntities.tsx`, copying the `warehouses` sub-tab structure (list/create/edit/toggle-active, `usePermissions('branches.*')` gating).
- Branch field on Invoice/Quotation/Expense/POS creation forms: for a restricted user, auto-set to their own branch (no picker shown); for a `viewAllBranches` user, a dropdown defaulting to the company's `isDefault` branch.
- Users management screen: add a nullable "Home Branch" dropdown per user (empty = company-wide). **Deliberately not gated by a new permission** — `server/routes/users.ts` user create/update is already admin-tier-gated (`isSuperAdminUser(req.user) || req.user?.role === 'admin'`, users.ts:214-216); `branchId` is just one more field on that already-protected route/form, so only a company admin or super-admin can move a user between branches or grant company-wide visibility by clearing it. Three distinct gates now exist and must not be conflated: **creating** a branch record is super-admin-only (licensing), **editing/deactivating/viewing** a branch is a normal delegable permission (`branches.update`/`delete`/`read`), and **assigning a user to** a branch is admin-tier (company admin or super-admin) via the existing users route.
- `buildPermissionTree()` (permissionSchema.ts) picks up the new `branches` module and its `viewAllBranches` leaf automatically in the Roles editor — no separate wiring needed.
- Translations: one `SEED_TRANSLATIONS` entry per new label in `dbStore.ts` (en/ar/ur), following the existing `'Physical Warehouses'` convention (dbStore.ts:513).

## Explicitly out of scope

- Per-branch ZATCA CSID or independent hash chains (confirmed shared-identity model).
- Branch scoping on master/config data that isn't transactional (tax slabs, product categories, templates, roles) — these stay company-wide for everyone, matching how `companyId` scoping already treats config vs. business data.

## Verification

1. `npm run lint` after schema/route/type changes.
2. `npm run db:push` — review the printed plan before confirming (it diffs live DB and can surface unrelated drift).
3. Restart the dev server before any check (backend doesn't hot-reload).
4. Manual pass: create two branches, assign a test user to one with no `viewAllBranches` permission, log in as them, confirm they see only their branch's invoices/quotations/expenses/vouchers/stock via both the normal UI (`/api/state`-backed) and any direct-fetch screens (`transactions.ts`-backed) — this dual-path check is the part most likely to have a gap.
5. Confirm a `viewAllBranches` user (or admin/super-admin) still sees everything with no branch filter applied, and that `/api/switch-branch` correctly focuses their view without leaking the stale-closure bug class from BACKLOG item 64 — test by switching branch, then immediately triggering a refresh, and confirming the *server session's* value wins, not a client-held stale one.
6. ZATCA dual-gate check on the address change specifically (per `docs/zatca/sandbox-qa-test-plan.html`): one invoice with a branch set, one without; confirm sandbox clearance and `fatoora -validate` both show the branch invoice's `PostalAddress` reflecting the branch, and the no-branch invoice unchanged from current behavior.
7. Extend `tests/zatcaWorkflow.test.ts` (real HTTP + Postgres, no mocks, per this repo's convention) to cover: a restricted branch user cannot see another branch's invoice via either `GET /invoices` or `/api/state`; a branch-tagged invoice's XML contains the branch's address.
