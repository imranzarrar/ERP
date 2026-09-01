import express from 'express';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { isAdminUser, isSuperAdminUser, assertOwnsRow } from '../lib/authz.js';
import { generateId } from '../../src/id.js';

const router = express.Router();

// Roles are managed by admins only — same tier as user management (users.ts), not a
// separate granular permission node (a user can't grant themselves broader access by
// editing the role that grants it).

router.get('/', async (req: any, res) => {
  try {
    if (!isAdminUser(req.user)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const roles = await db.select().from(schema.roles).where(eq(schema.roles.companyId, req.targetCompanyId));
    res.json(roles);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req: any, res) => {
  try {
    if (!isAdminUser(req.user)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const data = { ...req.body };

    if (data.id) {
      const [existing] = await db.select().from(schema.roles).where(eq(schema.roles.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this role belongs to another company' });
      }
    }

    if (!data.name || !String(data.name).trim()) {
      return res.status(400).json({ error: 'Role name is required.' });
    }

    // Scoping: mirrors users.ts — a company admin's role is always pinned to their own
    // company; a super-admin may explicitly target another company.
    data.companyId = isSuperAdminUser(req.user) ? (data.companyId || req.targetCompanyId) : req.targetCompanyId;
    data.name = String(data.name).trim();
    data.permissions = data.permissions || {};
    if (!data.id) {
      data.id = generateId();
    }

    await db.insert(schema.roles).values(data).onConflictDoUpdate({
      target: schema.roles.id,
      set: data
    });
    res.json({ success: true, id: data.id });
  } catch (error: any) {
    // Postgres unique_violation on (company_id, name) — a friendly 409 instead of a raw 500.
    // This project's drizzle-orm version wraps the real pg error under `.cause.code`, not
    // `.code` directly (confirmed empirically elsewhere in this codebase) — check both.
    if (error.code === '23505' || error.cause?.code === '23505') {
      return res.status(409).json({ error: 'A role with this name already exists for this company.' });
    }
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', async (req: any, res) => {
  try {
    if (!isAdminUser(req.user)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const [existing] = await db.select().from(schema.roles).where(eq(schema.roles.id, id));
    if (!existing) {
      return res.status(404).json({ error: 'Role not found.' });
    }
    if (!assertOwnsRow(existing, req)) {
      return res.status(403).json({ error: 'Forbidden: this role belongs to another company' });
    }

    const assignedUsers = await db.select().from(schema.userRoles).where(eq(schema.userRoles.roleId, id)).limit(1);
    if (assignedUsers.length > 0) {
      return res.status(400).json({ error: 'Cannot delete this role because it is still assigned to at least one user. Unassign it first.' });
    }

    await db.delete(schema.roles).where(and(eq(schema.roles.id, id), eq(schema.roles.companyId, existing.companyId)));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
