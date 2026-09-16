import { normalizePermissions, mergeRolePermissions } from '../../src/types.js';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, sql } from 'drizzle-orm';
import bcrypt from 'bcrypt';

// A user's effective permissions are the union (per-leaf OR) of every Role assigned to
// them — moved here from server.ts (which had its own unexported copy) so any route file
// can resolve a DIFFERENT user's permissions on demand, not just the caller's own
// req.user.permissions already resolved at login. First real caller: the POS Return
// manager-override check (server/routes/pos.ts), which must verify a NAMED OTHER user
// actually holds pos.return before honoring their override — that user was never part of
// req.user, so hasPermission(req.user, ...) can't answer it; this can.
export async function resolveUserPermissions(userId: string): Promise<any> {
  const assignedRoles = await db.select({ permissions: schema.roles.permissions })
    .from(schema.userRoles)
    .innerJoin(schema.roles, eq(schema.userRoles.roleId, schema.roles.id))
    .where(eq(schema.userRoles.userId, userId));
  if (!assignedRoles.length) return null;
  return mergeRolePermissions(assignedRoles.map((r: any) => r.permissions));
}

// pos.discount is the first permission leaf in this app that carries a numeric CAP
// alongside its boolean `enabled` — every other leaf normalizePermissions() produces is
// just `{enabled: boolean}` by design (see its own comment), which deliberately discards
// anything else stored on a leaf. A cap has to be read from the RAW, pre-normalized
// merged-role permissions instead (same object resolveUserPermissions already returns —
// mergeRolePermissions takes Math.max() across roles for a numeric leaf value, so this
// naturally resolves to "the most permissive cap across every role this user holds",
// matching the same union-of-roles philosophy the boolean leaves already use).
// Admin/super-admin bypass every granular check elsewhere in this app; a discount cap is
// no different — Infinity here means "no cap", not "cap of zero because nothing is set".
export async function resolveUserDiscountCap(userIdOrUser: string | { id: string; role?: string; isSuperAdmin?: boolean }): Promise<{ maxPercent: number; maxAmount: number }> {
  const user = typeof userIdOrUser === 'string' ? await db.select().from(schema.users).where(eq(schema.users.id, userIdOrUser)).then(r => r[0]) : userIdOrUser;
  if (!user) return { maxPercent: 0, maxAmount: 0 };
  if (isSuperAdminUser(user) || (user as any).role === 'admin') return { maxPercent: Infinity, maxAmount: Infinity };
  const raw = await resolveUserPermissions(user.id);
  const discount = raw?.pos?.discount;
  // A cap only counts when the leaf is actually enabled. The Roles editor's own
  // shallow-copy-down-the-path update (setNestedValue) never clears maxPercent/maxAmount
  // when the checkbox is unchecked — same behavior as every other leaf's own stored
  // fields surviving a re-check — so a previously-set cap can still be sitting in storage
  // on a role whose `enabled` was later flipped back to false. Without this check,
  // revoking the permission wouldn't actually revoke the cap.
  if (discount?.enabled !== true) return { maxPercent: 0, maxAmount: 0 };
  return {
    maxPercent: typeof discount?.maxPercent === 'number' ? discount.maxPercent : 0,
    maxAmount: typeof discount?.maxAmount === 'number' ? discount.maxAmount : 0,
  };
}

// Shared "manager override" credential check — a NAMED other user's own username+password,
// verified inline in the same request, without ever switching the acting user's own
// session/identity. First built inline in server/routes/pos.ts's POST /returns (kept
// there untouched, working code); extracted here so the POS header-discount override
// (server/routes/transactions.ts) can reuse the exact same verification instead of a
// second, potentially-drifting copy of security-sensitive logic. Returns the verified
// user row, or null if the username/password/active/company checks fail for any reason —
// deliberately one generic "Invalid manager credentials" outcome for every failure mode,
// same as the original, so a wrong username can't be distinguished from a wrong password.
export async function verifyOverrideCredentials(companyId: string, overrideUsername: string, overridePassword: string) {
  const [overrideUser] = await db.select().from(schema.users)
    .where(sql`LOWER(${schema.users.username}) = ${String(overrideUsername).trim().toLowerCase()}`);
  const ok = overrideUser
    && overrideUser.isDeleted !== 1
    && overrideUser.isActive !== false
    && (overrideUser.isSuperAdmin || overrideUser.companyId === companyId)
    && overrideUser.password
    && await bcrypt.compare(overridePassword, overrideUser.password);
  return ok ? overrideUser : null;
}

// Canonical super-admin check — replaces the ~20 ad-hoc variations of
// `role === 'super-admin' || role === 'superadmin' || isSuperAdmin === true`
// (and the buggy `'superadmin'`-without-hyphen typo) scattered across route files.
export function isSuperAdminUser(user: any): boolean {
  return user?.isSuperAdmin === true || user?.role === 'super-admin';
}

export function isCompanyAdmin(user: any): boolean {
  return user?.role === 'admin';
}

export function isAdminUser(user: any): boolean {
  return isSuperAdminUser(user) || isCompanyAdmin(user);
}

// Express middleware factory: requires the caller's normalized permissions to have
// `path` (dot-notation, e.g. 'invoice.view', 'customers.edit') enabled.
// Admins/super-admins always pass, via normalizePermissions' own isAdmin shortcut.
export function requirePermission(path: string) {
  return (req: any, res: any, next: any) => {
    const normalized = normalizePermissions(req.user?.permissions, req.user?.role, req.user?.isSuperAdmin);
    const parts = path.split('.');
    let current: any = normalized;
    for (const part of parts) {
      if (current === undefined || current === null) break;
      current = current[part];
    }
    const enabled = current === true || current?.enabled === true;
    if (!enabled) {
      return res.status(403).json({ error: `Forbidden: missing permission '${path}'` });
    }
    next();
  };
}

// Non-middleware variant for use inside handlers that need a boolean rather than a gate
// (e.g. the per-table checks inside migrateDataToPostgres).
export function hasPermission(user: any, path: string): boolean {
  const normalized = normalizePermissions(user?.permissions, user?.role, user?.isSuperAdmin);
  const parts = path.split('.');
  let current: any = normalized;
  for (const part of parts) {
    if (current === undefined || current === null) break;
    current = current[part];
  }
  return current === true || current?.enabled === true;
}

// Ownership check for upsert-by-id routes: an existing row may only be overwritten by
// a request scoped to the same company, unless the caller is a super-admin.
export function assertOwnsRow(existingRow: { companyId?: string | null } | undefined | null, req: any): boolean {
  if (isSuperAdminUser(req.user)) return true;
  if (!existingRow) return true; // no pre-existing row — nothing to hijack, normal create path
  return existingRow.companyId === req.targetCompanyId;
}

// Branch (physical-location) equivalent of assertOwnsRow's company check — for a specific
// row's own branchId, is this caller allowed to see/act on it? req.allowedBranchIds is null
// for an unrestricted caller (admin/super-admin/branches.viewAllBranches — see
// isAuthenticated in server.ts), otherwise the exact array of branches userBranches
// assigns them to. Mirrors server.ts's own `branchOk` closure (used for the GET /api/state
// read-path) byte-for-byte so read and write/action paths agree on the same rule —
// including its one deliberately-inherited asymmetry: a NULL branchId (a document that
// predates this company's branch adoption) is only visible/actionable to an UNRESTRICTED
// caller, never to a branch-restricted one, since `[...].includes(null)` is false. That
// matches server.ts's existing read-path behavior exactly rather than introducing a new
// rule — a branch-restricted user already can't see pre-adoption documents in their list,
// so they must not be able to act on one by id either.
export function branchAccessOk(req: any, branchId: string | null | undefined): boolean {
  if (req.allowedBranchIds === null || req.allowedBranchIds === undefined) return true;
  return Array.isArray(req.allowedBranchIds) && req.allowedBranchIds.includes(branchId);
}

// Async variant for rows that carry a warehouseId instead of their own branchId (GRN,
// Physical Stock Take, Purchase Return, Inventory Stock, Stock Ledger, Stock Adjustment) —
// resolves the warehouse's own branchId first, mirroring server.ts's `branchOkViaWarehouse`
// closure. A warehouse with no branchId (company-wide/HQ warehouse) behaves like any other
// null branchId above — visible/actionable only to an unrestricted caller.
export async function branchAccessOkViaWarehouse(dbOrTx: any, req: any, warehouseId: string | null | undefined): Promise<boolean> {
  if (req.allowedBranchIds === null || req.allowedBranchIds === undefined) return true;
  if (!warehouseId) return false;
  const [warehouse] = await dbOrTx.select({ branchId: schema.warehouses.branchId }).from(schema.warehouses).where(eq(schema.warehouses.id, warehouseId));
  return branchAccessOk(req, warehouse?.branchId);
}

// Resolves and validates a branchId for a document-creation request (Quotation/Invoice/
// voucher). The one place every such route calls into, rather than each re-implementing
// this slightly differently — three real risks this closes at once:
//   1. Cross-tenant leak: a client-supplied branchId belonging to a DIFFERENT company
//      must never be accepted, even from a super-admin acting on the wrong company.
//   2. Privilege escalation: a branch-restricted user (req.allowedBranchIds is a real
//      array, not null) must never be able to create a document under a branch they
//      aren't assigned to, no matter what the client sends.
//   3. Backward compatibility: a company that hasn't adopted branches yet (no branchId
//      supplied, no primary branch resolved) keeps working exactly as before — branchId
//      stays NULL, not an error.
// Returns the resolved branchId on success; throws {status, error} for the route to
// respond with directly on failure — deliberately never silently substitutes a different
// branch than what was actually requested/resolved.
export async function resolveDocumentBranchId(
  req: any, requestedBranchId: string | null | undefined
): Promise<string | null> {
  const branchId = requestedBranchId || req.primaryBranchId || null;
  if (!branchId) return null;

  const [branch] = await db.select().from(schema.branches).where(eq(schema.branches.id, branchId));
  if (!branch || branch.companyId !== req.targetCompanyId) {
    throw { status: 400, error: 'Invalid branch.' };
  }
  if (Array.isArray(req.allowedBranchIds) && !req.allowedBranchIds.includes(branchId)) {
    throw { status: 403, error: 'Forbidden: you are not assigned to this branch.' };
  }
  return branchId;
}
