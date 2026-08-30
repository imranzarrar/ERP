---
name: permission-crud-model
description: Use this skill whenever adding a new permission-gated backend route, adding a new module/page whose access should be role-configurable, editing an existing route's authorization check, or reviewing/auditing what a Role can and can't do in this ERP. Trigger proactively even if the request doesn't mention "permissions" explicitly (e.g. "add a warehouse transfer endpoint," "add a delete button to the vendor list," "why can this role still cancel invoices") — every new mutating route in this app needs a create/read/update/delete permission check wired to the shared registry, not a one-off. Also trigger when asked to add a new Role, change what a Role can do, or explain why a permission check does or doesn't work.
---

# Permission model: Create / Read / Update / Delete

This app's authorization is role-based (a user holds zero or more Roles; effective permissions are the union of all assigned roles — see `CLAUDE.md`). Every permission-gated module exposes up to four grants: **Create**, **Read**, **Update**, **Delete** — always this shape, never a bespoke one, for any module that manages records a user can list/add/edit/retire.

## Single source of truth: `src/permissionSchema.ts`

`PERMISSION_MODULES` in that file is the *only* place that defines what modules and leaves exist. Everything else derives from it:
- `normalizePermissions()` (`src/types.ts`) computes every user's effective permissions by looping over the registry — admins get `true` on every leaf, everyone else gets whatever their assigned roles' stored JSON says (default `false`, fail-closed).
- The Roles editor's checkbox tree (`AdminSettings.tsx`, via `buildPermissionTree()`) is generated from the same registry — a module you add there gets a checkbox automatically, grouped and rendered by the rules documented in that function's header comment.
- Server routes call `hasPermission(req.user, 'module.leaf')` or read `normalizePermissions(...).module.leaf.enabled` directly — **this part is not automatic**. Adding a registry entry makes a permission *grantable*; it does not enforce anything by itself. You still have to add the actual check in the route.

**To add a new permission-gated module:** add one entry to `PERMISSION_MODULES` (module id, group, leaves with labels). That alone gets you a working Roles-editor checkbox and a correctly-shaped `normalizePermissions()` output. Then add the `hasPermission()` check to the route(s) that should respect it. Two steps, not four — before this registry existed, a new module meant hand-editing three separate `normalizePermissions()` branches (admin defaults, non-admin defaults, no-role-assigned defaults) plus the Roles-editor tree by hand, and those *did* drift out of sync at least once in this codebase's history (see the comment above `normalizePermissions()` in `src/types.ts` — a module silently defaulted to full access for any user with zero roles assigned, because the "no permissions object" branch wasn't updated when the others were). The registry closes that gap structurally: there's only one branch now, so there's nothing left to drift.

## What C / R / U / D actually mean here

- **Create** — allowed to add a new record.
- **Read** — allowed to view/list records.
- **Update** — allowed to edit an *existing, still-editable* record. This permission does not override record-state rules (below) — a role with `update: true` still can't touch a cancelled, inactive, or (for invoices) ZATCA-cleared record. That's not a permission gap; it's a separate, non-negotiable rule enforced in the route regardless of who's asking.
- **Delete** — for documents (`quotation`, `invoice`, `expense`), this is **Cancel** — there is no hard delete of a financial record anywhere in this app. For master data (`customers`, `vendors`, `products`, and the hidden `categories`/`units`/`warehouses` modules that inherit from `products`), this is an **Active/Inactive toggle** (`PATCH /api/<resource>/:id/toggle-active`) — never a row deletion. Either way, "delete" retires a record; it never erases it. Cancelled/inactive records keep showing up in lists (clearly marked), because the data underneath is still real and still referenced by other rows (invoices against that customer, vouchers against that expense, etc.).

Not every module fits this shape, and that's fine — don't force it. `pos.*` is a feature-access flag set (can this actor use the POS terminal at all), not CRUD on one resource. `investors.access`, `reports.access` are single on/off gates. Forcing those into create/read/update/delete would be decoration, not a real distinction.

## Beyond CRUD: action-specific leaves for authority that isn't "edit"

Some actions are real, distinct authorities that don't map to Create/Read/Update/Delete at all — approving someone else's request, moving actual money, locking a whole accounting period. Bundling one of these into an existing CRUD leaf (usually `update`) understates what's actually being granted and removes the ability to delegate the two separately. When you find one, give it its own leaf on the relevant module instead:

- `inventory.approve` — separate from `inventory.pr` (submitting/viewing a Purchase Requisition). Real segregation-of-duties: the person who requests shouldn't automatically be the authority who approves. Was a hard `isAdminUser()` gate with no Role-based path at all before this leaf existed.
- `fiscalMonths.open` / `fiscalMonths.close` — separate from each other, not bundled under one `access` flag. Opening a month is low-risk and reversible; closing one locks the entire period and cascades into recurring-template settlement — materially bigger, harder to reverse, deserves its own grant. (Viewing the current month is universal and deliberately ungated — Dashboard/POS depend on it.)
- `banks.transfer` — separate from `banks.update`. Editing a bank account's name/number is metadata editing; moving real money between two accounts is a financial transaction. Different authority, same reasoning as the PR split above.

The test to apply before adding one of these: would granting this via the existing CRUD leaf let someone do something meaningfully riskier than what that leaf's name implies? If yes, split it out. If it's just "a slightly different way to edit the same record," it isn't one of these — use `update`.

## Delegating something that used to be admin-tier-only

Several things in this app are gated by role *tier* (`role === 'admin'` / `isSuperAdminUser()`) rather than the Role/permission system at all — company creation, Role definition, ZATCA configuration, Translations (a genuinely shared, cross-tenant table — a company-scoped Role editing it would affect every other tenant). Before making one of these delegable via a new permission leaf, check whether it's one of these on purpose:

- **Keep admin-tier-only**: anything that defines the boundaries other permissions operate within (Role definition), anything cross-tenant/shared (Translations), anything with real legal/compliance exposure regardless of who's asking (ZATCA credentials and submission config), and platform-level actions (creating a company).
- **Safe to delegate, with a guardrail**: `users.create`/`users.update` (staff enrollment) is the worked example — a non-admin-tier actor granted this permission is *forced* to `role: 'user'` server-side, regardless of what the request body asks for (see `server/routes/users.ts`'s `isFullAdminTier` branch). Without that guardrail, the permission would be a privilege-escalation path: someone with only "can add employees" could otherwise mint themselves a full company admin. The guardrail is what makes delegation safe here, not the permission checkbox alone — when delegating anything adjacent to account/role provisioning, ask what stops the delegated actor from granting themselves more than they were given, and enforce that in the route, not just the UI.
- **Cosmetic/reversible → straightforward to delegate**: `templates.*` (Canvas Designer / print layout) doesn't touch financial data or the ZATCA submission pipeline — a misconfigured template is a print-appearance problem, not a data or compliance one. No special guardrail needed beyond the permission check itself.

## Two layers, not one — don't conflate them

1. **Role/permission layer** — "can this actor attempt this action on this module at all." Configured per-role in the Roles editor, checked via `hasPermission(req.user, 'module.leaf')` in the route.
2. **Record-state layer** — "can this specific record be touched right now," independent of who's asking. Checked separately, in the same route, against the row itself:
   - A cancelled or deactivated (`isActive === false`) record rejects Update, full stop — not a smaller grant, a hard `400`.
   - A quotation with `status === 'Converted'` rejects both Update and Delete (Cancel) — it's already been fulfilled into an invoice.
   - An invoice with `zatcaStatus` in `SUBMITTING` / `CLEARED` / `REPORTED` rejects Update *and* Delete outright, regardless of role — this one is a regulatory rule, not a business preference. Even a super-admin with every permission checked can't edit or cancel a cleared invoice; the compliant path is a Credit Note (`POST /invoices/:id/note`), which creates a new document rather than mutating the original. See `CLAUDE.md`'s ZATCA section before touching anything invoice-status-related — that's the most compliance-sensitive code in this repo.

A route needs both checks. Permission alone is not enough (a role that can update invoices still can't update a cleared one). Record-state alone is not enough (a record being editable doesn't mean this particular actor is allowed to edit it). Missing either one is a bug, not a style choice.

## Cancellation is a dedicated flag, not an overloaded status value

Where a document has both a *phase* (`Draft` → `Sent` → `Accepted` → `Converted`, or similar) and can be *cancelled*, keep those orthogonal: a dedicated boolean (e.g. `quotations.isCancelled`) separate from the phase field. Don't write `status: 'Cancelled'` into a field that's otherwise tracking phase — that collides two different concepts into one column and makes "what phase was this in when it got cancelled" unanswerable. A cancelled document displays as "Cancelled" wherever it's shown, regardless of what phase value sits underneath, by checking the flag first.

This is a going-forward convention for anything new. `invoices`/`expenses`/`purchase_orders` already overload `status` with a `'Cancelled'` value from before this convention existed — that isn't being retrofitted as part of this pattern (it's stable, heavily exercised by the ZATCA pipeline, and a mechanical rename there is a separate, higher-risk piece of work — see `CLAUDE.md`'s ZATCA section again). Don't "fix" those in passing while working on something else.

## Upsert routes: branch the permission check on whether the row exists

Several routes in this app upsert (`INSERT ... ON CONFLICT DO UPDATE`) rather than having separate create/update endpoints. When that's the case, fetch the existing row *before* deciding which permission to require:

```ts
let existing;
if (data.id) {
  [existing] = await db.select().from(table).where(eq(table.id, data.id));
}
if (existing) {
  if (!permissions.module.update.enabled) return res.status(403)...;
  if (existing.isActive === false) return res.status(400)...; // record-state rule
} else if (!permissions.module.create.enabled) {
  return res.status(403)...;
}
```

Gating the whole upsert by a single permission (old pattern: just check `create`) means a role that's only supposed to add new records can also silently edit existing ones through the same endpoint. See `server/routes/masterEntities.ts`'s customers/vendors/products/categories/units/warehouses routes for the worked pattern, including the toggle-active routes for Delete.
