import express from 'express';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and, inArray } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { recordAuditLog } from '../lib/audit.js';
import { isSuperAdminUser, assertOwnsRow, hasPermission } from '../lib/authz.js';

const router = express.Router();

// --- Users ---
router.post('/', async (req: any, res) => {
  try {
    const isSuperAdmin = isSuperAdminUser(req.user);
    const isCompanyAdmin = req.user?.role === 'admin';
    const isFullAdminTier = isSuperAdmin || isCompanyAdmin;

    const data = { ...req.body };
    if (data.password && !data.password.startsWith('$2b$') && !data.password.startsWith('$2a$')) {
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
    };
    if (data.uid) userRecord.uid = data.uid;
    if (data.password) {
      userRecord.password = data.password;
    } else if (existingUser && existingUser.password) {
      userRecord.password = existingUser.password;
    } else {
      userRecord.password = await bcrypt.hash('123456', 10);
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

    // Log the user creation/update
    await recordAuditLog(
      req,
      isUpdate ? 'UPDATE_USER' : 'CREATE_USER',
      'user',
      data.id,
      { username: data.username, role: data.role, droppedRoles: droppedRoles.length ? droppedRoles : undefined }
    );

    res.json({ success: true, droppedRoles: droppedRoles.length ? droppedRoles : undefined });
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

    await db.update(schema.users)
      .set({ isDeleted: 1 })
      .where(and(eq(schema.users.id, id), eq(schema.users.companyId, req.targetCompanyId)));

    if (targetUser) {
      await recordAuditLog(req, 'DELETE_USER', 'user', id, { username: targetUser.username });
    }

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
