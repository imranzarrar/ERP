import express from 'express';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { normalizePermissions } from '../../src/types.js';

const router = express.Router();

router.get('/shifts', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.pos.access.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const companyId = req.targetCompanyId;
    const shifts = await db.select().from(schema.posShifts).where(eq(schema.posShifts.companyId, companyId));
    res.json(shifts);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/shifts', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.pos.shifts.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const data = { ...req.body };
    data.companyId = req.targetCompanyId;

    await db.insert(schema.posShifts).values({
        ...data,
        startTime: new Date(data.startTime),
        endTime: data.endTime ? new Date(data.endTime) : null,
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/shifts/:id', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.pos.shifts.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const data = { ...req.body };

    await db.update(schema.posShifts).set({
        ...data,
        endTime: data.endTime ? new Date(data.endTime) : null,
    }).where(and(eq(schema.posShifts.id, id), eq(schema.posShifts.companyId, req.targetCompanyId)));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Held (pending) invoices — parked carts. Gated on pos.access, mirroring the "Pending
// (Held)" tab's own `can('pos.access')` check in PosModule.tsx.
router.get('/held-invoices', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.pos.access.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const companyId = req.targetCompanyId;
    const heldInvoices = await db.select().from(schema.posHeldInvoices).where(eq(schema.posHeldInvoices.companyId, companyId));
    res.json(heldInvoices);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/held-invoices', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.pos.access.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const data = { ...req.body };
    data.companyId = req.targetCompanyId;

    await db.insert(schema.posHeldInvoices).values({
        ...data,
        createdAt: data.createdAt ? new Date(data.createdAt) : new Date(),
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/held-invoices/:id', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.pos.access.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    await db.delete(schema.posHeldInvoices).where(and(eq(schema.posHeldInvoices.id, id), eq(schema.posHeldInvoices.companyId, req.targetCompanyId)));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
