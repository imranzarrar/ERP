import express from 'express';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { isSuperAdminUser } from '../lib/authz.js';
import { generateId } from '../../src/id.js';

const router = express.Router();

// Role Templates are cross-tenant (roleTemplates has no companyId at all, unlike roles) —
// gated to a true platform super-admin, not the broader isAdminUser tier roles.ts uses,
// since a company admin has no business curating a library shared across every tenant.

router.get('/', async (req: any, res) => {
  try {
    if (!isSuperAdminUser(req.user)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const templates = await db.select().from(schema.roleTemplates);
    res.json(templates);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req: any, res) => {
  try {
    if (!isSuperAdminUser(req.user)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const data = { ...req.body };
    if (!data.name || !String(data.name).trim()) {
      return res.status(400).json({ error: 'Template name is required.' });
    }
    data.name = String(data.name).trim();
    data.description = data.description ? String(data.description).trim() : null;
    data.permissions = data.permissions || {};
    if (!data.id) {
      data.id = generateId();
    }

    await db.insert(schema.roleTemplates).values(data).onConflictDoUpdate({
      target: schema.roleTemplates.id,
      set: data,
    });
    res.json({ success: true, id: data.id });
  } catch (error: any) {
    if (error.code === '23505' || error.cause?.code === '23505') {
      return res.status(409).json({ error: 'A role template with this name already exists.' });
    }
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', async (req: any, res) => {
  try {
    if (!isSuperAdminUser(req.user)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const [existing] = await db.select().from(schema.roleTemplates).where(eq(schema.roleTemplates.id, id));
    if (!existing) {
      return res.status(404).json({ error: 'Role template not found.' });
    }
    await db.delete(schema.roleTemplates).where(eq(schema.roleTemplates.id, id));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
