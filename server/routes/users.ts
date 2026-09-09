import express from 'express';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and, inArray, sql } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { recordAuditLog } from '../lib/audit.js';
import { isSuperAdminUser, assertOwnsRow, hasPermission } from '../lib/authz.js';

const router = express.Router();

// --- Users ---

// The Staff Accounts directory (AdminSettings.tsx) needs to browse a company OTHER than
// whichever one is currently active in the top-nav selector — but GET /api/state (the
// normal bundled-state path) always scopes db.users to exactly req.targetCompanyId, so a
// super-admin's "Filter Directory" dropdown had nothing to actually fetch when it picked a
// different company. This route exists specifically to serve that on-demand lookup.
// A super-admin may pass ?companyId=<id> for one company, or ?companyId=all for every
// company; anyone else is always hard-locked to their own req.targetCompanyId regardless
// of what's in the query string, same as every other route in this file.
router.get('/', async (req: any, res) => {
  try {
    const isSuperAdmin = isSuperAdminUser(req.user);
    const requestedCompanyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;

    let rows;
    if (isSuperAdmin && requestedCompanyId === 'all') {
      rows = await db.select().from(schema.users).where(eq(schema.users.isDeleted, 0));
    } else {
      const companyId = isSuperAdmin && requestedCompanyId ? requestedCompanyId : req.targetCompanyId;
      rows = await db.select().from(schema.users)
        .where(and(eq(schema.users.companyId, companyId), eq(schema.users.isDeleted, 0)));
    }

    // Attach each user's role/branch assignments directly on the row — the client's
    // edit-user prefill otherwise cross-references the bundled db.userRoles/db.userBranches
    // from GET /api/state, which (like db.users itself) only ever covers the currently
    // active company. A row fetched here for a DIFFERENT company (including via the
    // "All Organizations" filter) would prefill as "no roles/branches assigned" even when
    // real assignments exist, silently wiping them on save. Bounded by inArray(userIds) —
    // exactly as many rows as users actually returned above, not a cross-company scan.
    const userIds = rows.map(u => u.id);
    let roleRows: any[] = [];
    let branchRows: any[] = [];
    if (userIds.length) {
      roleRows = await db.select().from(schema.userRoles).where(inArray(schema.userRoles.userId, userIds));
      branchRows = await db.select().from(schema.userBranches).where(inArray(schema.userBranches.userId, userIds));
    }

    res.json(rows.map(({ password, ...safe }) => ({
      ...safe,
      roleIds: roleRows.filter(r => r.userId === safe.id).map(r => r.roleId),
      branchIds: branchRows.filter(b => b.userId === safe.id).map(b => b.branchId),
      primaryBranchId: branchRows.find(b => b.userId === safe.id && b.isPrimary)?.branchId || '',
    })));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req: any, res) => {
  try {
    const isSuperAdmin = isSuperAdminUser(req.user);
    const isCompanyAdmin = req.user?.role === 'admin';
    const isFullAdminTier = isSuperAdmin || isCompanyAdmin;

    const data = { ...req.body };
    if (data.password && !data.password.startsWith('$2b$') && !data.password.startsWith('$2a$')) {
      // Mirrors the client-side check in AdminSettings.tsx's handleAddUser — enforced here
      // too since the client check alone is bypassable by a direct API call.
      if (data.password.length < 6 || !/[a-zA-Z]/.test(data.password) || !/[0-9]/.test(data.password)) {
        return res.status(400).json({ error: 'Password must be at least 6 characters and contain at least one letter and one digit.' });
      }
      data.password = await bcrypt.hash(data.password, 10);
    }

    // Mandatory going forward for every account created/edited through this real route —
    // it's what the forgot-password flow keys off (see server.ts's
    // POST /api/auth/forgot-password). Deliberately NOT a DB-level NOT NULL constraint:
    // that would also break every test fixture that inserts a user row directly and any
    // account that predates this field, neither of which goes through this route.
    const cleanEmail = String(data.email || '').trim();
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }

    // Scoping: If not super admin, enforce target company. If super admin, respect provided companyId or default to targetCompanyId.
    if (!isSuperAdmin) {
      data.companyId = req.targetCompanyId;
    } else {
      data.companyId = data.companyId || req.targetCompanyId;
    }

    const existingUser = data.id ? await db.select().from(schema.users).where(eq(schema.users.id, data.id)).limit(1).then(r => r[0]) : null;
    const isUpdate = Boolean(existingUser);

    // Full admin tier (company admin / super-admin) always passes, same as before. A
    // non-admin actor may only proceed via the delegated `users.create`/`users.update`
    // permission — see the role-forcing guardrail below for why this is safe to grant.
    const hasDelegatedPermission = isUpdate
      ? hasPermission(req.user, 'users.update')
      : hasPermission(req.user, 'users.create');
    if (!isFullAdminTier && !hasDelegatedPermission) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // A company admin may only ever create/update users that already belong to (or are
    // new to) their own company — prevents hijacking another tenant's user record by id.
    if (!isSuperAdmin && !assertOwnsRow(existingUser, req)) {
      return res.status(403).json({ error: 'Forbidden: this user belongs to another company' });
    }

    // Only a real super-admin may grant super-admin / role escalation. A company admin
    // posting isSuperAdmin:true or role:'super-admin' must not be able to mint one — but
    // an ignored escalation attempt on an existing user falls back to their current role,
    // not a hard reset to 'user' (which would itself be an unintended downgrade).
    // An actor here only via the delegated permission (not actual admin tier) is forced to
    // 'user' unconditionally, regardless of what was requested — without this, granting
    // `users.create` to a non-admin role would be a privilege-escalation path (mint
    // yourself, or anyone, a company admin). Assigning an *existing* Role below is still
    // allowed for a delegated actor; Roles are themselves admin-defined, so this only
    // blocks minting a new admin-tier *account*, not using what's already been granted.
    const requestedRole = data.role || 'user';
    const fallbackRole = (existingUser?.role && existingUser.role !== 'super-admin') ? existingUser.role : 'user';
    const role = isFullAdminTier
      ? (isSuperAdmin ? requestedRole : (requestedRole === 'super-admin' ? fallbackRole : requestedRole))
      : 'user';
    const grantSuperAdmin = isSuperAdmin ? Boolean(data.isSuperAdmin) : false;

    // Employee link — see users.employeeId's schema comment. Validated whenever
    // provided (must belong to this company, must be active); mandatory for a
    // genuinely NEW account only once the company has onboarded at least one active
    // employee — mirrors the exact "mandatory once the company has adopted X" pattern
    // already used for warehouses requiring a branch once one exists. A company with
    // zero employees onboarded yet keeps today's exact behavior (fully optional).
    if (data.employeeId) {
      const [employee] = await db.select().from(schema.employees)
        .where(and(eq(schema.employees.id, data.employeeId), eq(schema.employees.companyId, data.companyId)));
      if (!employee) {
        return res.status(404).json({ error: 'Employee not found for this company.' });
      }
      if (employee.isActive === false) {
        return res.status(400).json({ error: `Employee "${employee.name}" (#${employee.employeeNumber}) is deactivated and cannot be linked to a new account.` });
      }
    } else if (!isUpdate) {
      const [anyActiveEmployee] = await db.select({ id: schema.employees.id }).from(schema.employees)
        .where(and(eq(schema.employees.companyId, data.companyId), eq(schema.employees.isActive, true)));
      if (anyActiveEmployee) {
        return res.status(400).json({ error: 'This company uses HR employee onboarding — select the employee this account belongs to.' });
      }
    }

    // Username = email for every brand-new account — same convention the self-signup
    // onboarding-approval flow already uses (onboarding.ts's baseUsername), applied here
    // too so there's only ever one identifier to keep unique, not two that can drift out
    // of sync. An edit never renames an existing account's own (possibly pre-existing,
    // non-email-shaped) username just because its email changed.
    if (!isUpdate) {
      data.username = cleanEmail;
    }
    const cleanUsername = String(data.username || '').trim();
    if (!cleanUsername) {
      return res.status(400).json({ error: 'Username is required.' });
    }

    // Uniqueness, case-insensitive — there is no DB-level unique constraint on either
    // column (see their own schema comments: existing rows/test fixtures predate this),
    // so this route is the only place either is actually enforced. Excludes this row's
    // own id so an edit that doesn't change the value isn't rejected against itself.
    const [usernameConflict] = await db.select({ id: schema.users.id }).from(schema.users)
      .where(sql`lower(${schema.users.username}) = lower(${cleanUsername})`);
    if (usernameConflict && usernameConflict.id !== data.id) {
      return res.status(400).json({ error: `An account with the username "${cleanUsername}" already exists.` });
    }
    const [emailConflict] = await db.select({ id: schema.users.id }).from(schema.users)
      .where(sql`lower(${schema.users.email}) = lower(${cleanEmail})`);
    if (emailConflict && emailConflict.id !== data.id) {
      return res.status(400).json({ error: `An account with the email "${cleanEmail}" already exists.` });
    }

    // Sanitize user payload for schema.users table
    const userRecord: any = {
      id: data.id,
      username: data.username,
      email: cleanEmail,
      role,
      companyId: data.companyId,
      isSuperAdmin: grantSuperAdmin,
      isActive: data.isActive !== undefined ? Boolean(data.isActive) : true,
      uiLanguage: data.uiLanguage || 'en',
      isDeleted: data.isDeleted ? 1 : 0,
      // Preserve the existing link on an edit that doesn't mention employeeId at all —
      // omitting the field must never silently unlink an account from its employee,
      // same reasoning as warehouses.isCompanyDefault's own "preserve unless explicitly
      // sent" handling.
      employeeId: data.employeeId !== undefined ? (data.employeeId || null) : (existingUser?.employeeId ?? null),
    };
    // fullName/phone are only ever this account's own data when it has NO linked
    // employee — once employeeId is set, the employees row (which already carries its
    // own name/phone) is the single source of truth, so these are forced to null here
    // rather than kept as a second, driftable copy. The client pre-fills its form fields
    // from the employee record purely as a UX convenience; this is what actually enforces
    // it against a direct API call. Mirrors the same "don't duplicate what's on employees"
    // reasoning applied to username/email above.
    userRecord.fullName = userRecord.employeeId ? null : (data.fullName ? String(data.fullName).trim() : null);
    userRecord.phone = userRecord.employeeId ? null : (data.phone ? String(data.phone).trim() : null);
    if (data.uid) userRecord.uid = data.uid;
    // An admin choosing/resetting someone else's password (or a brand-new account
    // defaulting to 123456) forces a change on that account's next login by default — see
    // POST /api/auth/change-password and the login response's mustChangePassword flag.
    // Never forced when the actor is setting their own password through this same route
    // (they just set it themselves, they already know it), regardless of what's sent.
    // The admin's own "Require password change on next login" checkbox (AdminSettings.tsx)
    // can override the default in either direction when explicitly supplied; an older/
    // direct API caller that omits it keeps today's exact default behavior.
    const isSelfEdit = existingUser?.id === req.user?.id;
    const requestedMustChange = data.mustChangePassword !== undefined ? Boolean(data.mustChangePassword) : undefined;
    if (data.password) {
      userRecord.password = data.password;
      userRecord.mustChangePassword = isSelfEdit ? false : (requestedMustChange !== undefined ? requestedMustChange : true);
    } else if (existingUser && existingUser.password) {
      userRecord.password = existingUser.password;
      userRecord.mustChangePassword = isSelfEdit ? false : (requestedMustChange !== undefined ? requestedMustChange : (existingUser.mustChangePassword ?? false));
    } else {
      userRecord.password = await bcrypt.hash('123456', 10);
      userRecord.mustChangePassword = requestedMustChange !== undefined ? requestedMustChange : true;
    }

    await db.insert(schema.users).values(userRecord).onConflictDoUpdate({
      target: schema.users.id,
      set: userRecord
    });

    // Sync role assignments (many-to-many): a role can only ever be assigned to a user
    // in the same company it belongs to — drop any requested roleId that fails that check
    // rather than failing the whole user save over it, but report exactly which ones were
    // dropped and why (see droppedRoles below) rather than swallowing it — a super-admin
    // managing multiple companies can easily submit a role from the wrong company (e.g.
    // their own active-company selector didn't match the company they were editing users
    // for) and get back an unqualified {success:true} with the user left holding zero
    // permissions, with nothing in the response to explain why. Found live: a real user
    // ended up with an empty nav because of exactly this, silently, with no error anywhere.
    let droppedRoles: Array<{ roleId: string; reason: string }> = [];
    if (Array.isArray(data.roleIds)) {
      const requestedRoleIds: string[] = data.roleIds.filter((id: any) => typeof id === 'string' && id);
      const validRoles = requestedRoleIds.length
        ? await db.select().from(schema.roles).where(eq(schema.roles.companyId, userRecord.companyId))
        : [];
      const validRoleIds = new Set(validRoles.filter(r => requestedRoleIds.includes(r.id)).map(r => r.id));
      const droppedRoleIds = requestedRoleIds.filter(id => !validRoleIds.has(id));
      if (droppedRoleIds.length) {
        // Look these up unscoped (no companyId filter) purely to produce a clearer message
        // (the role's own name) — never used to decide validity, that's already settled above.
        const droppedRoleRows = await db.select().from(schema.roles).where(inArray(schema.roles.id, droppedRoleIds));
        droppedRoles = droppedRoleIds.map(roleId => {
          const found = droppedRoleRows.find((r: any) => r.id === roleId);
          return {
            roleId,
            reason: found
              ? `Role "${found.name}" belongs to a different company and cannot be assigned to this user.`
              : `Role ${roleId} no longer exists.`,
          };
        });
      }

      await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, userRecord.id));
      if (validRoleIds.size) {
        await db.insert(schema.userRoles).values(
          Array.from(validRoleIds).map(roleId => ({ userId: userRecord.id, roleId }))
        );
      }
    }

    // Sync branch assignments (many-to-many) — same reasoning and same
    // drop-with-explanation pattern as roleIds just above: a branch can only ever be
    // assigned to a user in the same company it belongs to. Zero rows (an empty/omitted
    // branchIds array) means company-wide — that's the `branches.viewAllBranches`
    // permission's job, not row presence here, so an explicit `[]` legitimately clears
    // any prior branch restriction rather than being treated as "no change."
    let droppedBranches: Array<{ branchId: string; reason: string }> = [];
    if (Array.isArray(data.branchIds)) {
      const requestedBranchIds: string[] = data.branchIds.filter((id: any) => typeof id === 'string' && id);
      const validBranchRows = requestedBranchIds.length
        ? await db.select().from(schema.branches).where(eq(schema.branches.companyId, userRecord.companyId))
        : [];
      let validBranchIds = new Set(validBranchRows.filter(b => requestedBranchIds.includes(b.id)).map(b => b.id));
      const droppedBranchIds = requestedBranchIds.filter(id => !validBranchIds.has(id));
      if (droppedBranchIds.length) {
        const droppedBranchRows = await db.select().from(schema.branches).where(inArray(schema.branches.id, droppedBranchIds));
        droppedBranches = droppedBranchIds.map(branchId => {
          const found = droppedBranchRows.find((b: any) => b.id === branchId);
          return {
            branchId,
            reason: found
              ? `Branch "${found.name}" belongs to a different company and cannot be assigned to this user.`
              : `Branch ${branchId} no longer exists.`,
          };
        });
      }

      // A branch-restricted caller (req.allowedBranchIds is a real array, not null — see
      // isAuthenticated in server.ts) must never be able to assign a branch outside their
      // own set, on ANYONE's account — including, most dangerously, their own: without
      // this, a user holding only the delegated users.update permission could edit their
      // own record and add themselves to every branch in the company, self-escalating
      // req.allowedBranchIds on their very next request. Silently dropped, same pattern
      // (and same reported-back shape) as the cross-company drop just above, rather than
      // failing the whole save over it.
      if (Array.isArray(req.allowedBranchIds)) {
        const outOfScopeIds = Array.from(validBranchIds).filter(id => !req.allowedBranchIds.includes(id));
        if (outOfScopeIds.length) {
          const outOfScopeRows = await db.select().from(schema.branches).where(inArray(schema.branches.id, outOfScopeIds));
          droppedBranches = droppedBranches.concat(outOfScopeIds.map(branchId => ({
            branchId,
            reason: `You are not assigned to branch "${outOfScopeRows.find((b: any) => b.id === branchId)?.name || branchId}" and cannot assign it to this user.`,
          })));
          validBranchIds = new Set(Array.from(validBranchIds).filter(id => req.allowedBranchIds.includes(id)));
        }
      }

      // primaryBranchId must itself be one of the (valid) requested branches — a stray
      // value pointing outside the set being assigned would otherwise mark isPrimary on
      // a row that's never inserted, silently leaving the user with no primary at all.
      const requestedPrimary = typeof data.primaryBranchId === 'string' ? data.primaryBranchId : null;
      const primaryBranchId = requestedPrimary && validBranchIds.has(requestedPrimary)
        ? requestedPrimary
        : (validBranchIds.size ? Array.from(validBranchIds)[0] : null);

      await db.delete(schema.userBranches).where(eq(schema.userBranches.userId, userRecord.id));
      if (validBranchIds.size) {
        await db.insert(schema.userBranches).values(
          Array.from(validBranchIds).map(branchId => ({ userId: userRecord.id, branchId, isPrimary: branchId === primaryBranchId }))
        );
      }
    }

    // Log the user creation/update
    await recordAuditLog(
      req,
      isUpdate ? 'UPDATE_USER' : 'CREATE_USER',
      'user',
      data.id,
      { username: data.username, role: data.role, droppedRoles: droppedRoles.length ? droppedRoles : undefined, droppedBranches: droppedBranches.length ? droppedBranches : undefined }
    );

    res.json({ success: true, droppedRoles: droppedRoles.length ? droppedRoles : undefined, droppedBranches: droppedBranches.length ? droppedBranches : undefined });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// A user's own UI language preference — single-column update on the caller's own row,
// no permission check beyond being authenticated (you can always change your own display
// language). Deliberately not routed through the full-blob /api/migrate sync.
router.patch('/me/language', async (req: any, res) => {
  try {
    const { uiLanguage } = req.body;
    if (!['en', 'ar', 'ur'].includes(uiLanguage)) {
      return res.status(400).json({ error: 'Invalid language' });
    }
    await db.update(schema.users).set({ uiLanguage }).where(eq(schema.users.id, req.user.id));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Toggle a user's isActive flag — company admin (own company only) or super-admin.
router.patch('/:id/active', async (req: any, res) => {
  try {
    const isSuper = isSuperAdminUser(req.user);
    const isCompanyAdmin = req.user?.role === 'admin';
    if (!isSuper && !isCompanyAdmin && !hasPermission(req.user, 'users.delete')) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { id } = req.params;
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be a boolean' });
    }

    const targetUser = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1).then(r => r[0]);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    if (!assertOwnsRow(targetUser, req)) {
      return res.status(403).json({ error: 'Forbidden: this user belongs to another company' });
    }

    if (id === req.user.id) {
      return res.status(400).json({ error: 'You cannot deactivate your own active session!' });
    }
    if (targetUser.isSuperAdmin) {
      return res.status(400).json({ error: 'Super Admin accounts cannot be deactivated!' });
    }

    await db.update(schema.users).set({ isActive }).where(eq(schema.users.id, id));

    await recordAuditLog(req, 'UPDATE_USER', 'user', id, { isActive });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', async (req: any, res) => {
  try {
    const isSuper = isSuperAdminUser(req.user) || req.user?.role === 'admin';
    if (!isSuper && !hasPermission(req.user, 'users.delete')) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { id } = req.params;
    // Don't allow a user to delete themselves
    if (id === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete own account' });
    }

    const targetUser = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1).then(r => r[0]);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    // Was previously scoped to req.targetCompanyId (the CALLER's own active company),
    // not the target row's actual company — a super-admin deleting a user from a
    // different company than whichever one happened to be active for them silently
    // matched zero rows and reported success anyway. assertOwnsRow is the correct check
    // here (true for super-admin regardless of company, same as the sibling
    // PATCH /:id/active route above), and it needs no companyId condition on the update
    // itself once ownership's already been verified against the real row.
    if (!assertOwnsRow(targetUser, req)) {
      return res.status(403).json({ error: 'Forbidden: this user belongs to another company' });
    }

    await db.update(schema.users)
      .set({ isDeleted: 1 })
      .where(eq(schema.users.id, id));

    if (targetUser) {
      await recordAuditLog(req, 'DELETE_USER', 'user', id, { username: targetUser.username });
    }

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
