import { normalizePermissions } from '../../src/types.js';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';

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
