import { normalizePermissions } from '../../src/types.js';

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
