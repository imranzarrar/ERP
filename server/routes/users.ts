import express from 'express';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { recordAuditLog } from '../lib/audit.js';
import { isSuperAdminUser, assertOwnsRow } from '../lib/authz.js';

const router = express.Router();

// --- Users ---
router.post('/', async (req: any, res) => {
  try {
    const isSuperAdmin = isSuperAdminUser(req.user);
    const isCompanyAdmin = req.user?.role === 'admin';
    if (!isSuperAdmin && !isCompanyAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const data = { ...req.body };
    if (data.password && !data.password.startsWith('$2b$') && !data.password.startsWith('$2a$')) {
      data.password = await bcrypt.hash(data.password, 10);
    }

    // Scoping: If not super admin, enforce target company. If super admin, respect provided companyId or default to targetCompanyId.
    if (!isSuperAdmin) {
      data.companyId = req.targetCompanyId;
    } else {
      data.companyId = data.companyId || req.targetCompanyId;
    }

    const existingUser = data.id ? await db.select().from(schema.users).where(eq(schema.users.id, data.id)).limit(1).then(r => r[0]) : null;
    const isUpdate = Boolean(existingUser);

    // A company admin may only ever create/update users that already belong to (or are
    // new to) their own company — prevents hijacking another tenant's user record by id.
    if (!isSuperAdmin && !assertOwnsRow(existingUser, req)) {
      return res.status(403).json({ error: 'Forbidden: this user belongs to another company' });
    }

    // Only a real super-admin may grant super-admin / role escalation. A company admin
    // posting isSuperAdmin:true or role:'super-admin' must not be able to mint one — but
    // an ignored escalation attempt on an existing user falls back to their current role,
    // not a hard reset to 'user' (which would itself be an unintended downgrade).
    const requestedRole = data.role || 'user';
    const fallbackRole = (existingUser?.role && existingUser.role !== 'super-admin') ? existingUser.role : 'user';
    const role = isSuperAdmin ? requestedRole : (requestedRole === 'super-admin' ? fallbackRole : requestedRole);
    const grantSuperAdmin = isSuperAdmin ? Boolean(data.isSuperAdmin) : false;

    // Sanitize user payload for schema.users table
    const userRecord: any = {
      id: data.id,
      username: data.username,
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
    // in the same company it belongs to — silently drop any requested roleId that fails
    // that check rather than failing the whole user save over it.
    if (Array.isArray(data.roleIds)) {
      const requestedRoleIds: string[] = data.roleIds.filter((id: any) => typeof id === 'string' && id);
      const validRoles = requestedRoleIds.length
        ? await db.select().from(schema.roles).where(eq(schema.roles.companyId, userRecord.companyId))
        : [];
      const validRoleIds = new Set(validRoles.filter(r => requestedRoleIds.includes(r.id)).map(r => r.id));

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
      { username: data.username, role: data.role }
    );

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', async (req: any, res) => {
  try {
    const isSuper = isSuperAdminUser(req.user) || req.user?.role === 'admin';
    if (!isSuper) {
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
