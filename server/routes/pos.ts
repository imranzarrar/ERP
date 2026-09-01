import express from 'express';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and, inArray } from 'drizzle-orm';
import { normalizePermissions } from '../../src/types.js';
import { branchAccessOk, resolveDocumentBranchId } from '../lib/authz.js';

const router = express.Router();

router.get('/shifts', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.pos.access.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const companyId = req.targetCompanyId;
    const conditions = [eq(schema.posShifts.companyId, companyId)];
    // Branch-restricted callers only see their own branch's shifts — mirrors GET
    // /api/state's own branchOk scoping for every other transactional table; this
    // standalone REST endpoint had no branch check at all until now (posShifts also had
    // no branchId column to check against until this same fix added one).
    if (Array.isArray(req.allowedBranchIds)) {
      if (req.allowedBranchIds.length === 0) return res.json([]);
      conditions.push(inArray(schema.posShifts.branchId, req.allowedBranchIds));
    }
    const shifts = await db.select().from(schema.posShifts).where(and(...conditions));
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

    try {
      data.branchId = await resolveDocumentBranchId(req, data.branchId);
    } catch (branchErr: any) {
      return res.status(branchErr.status || 400).json({ error: branchErr.error || 'Invalid branch.' });
    }

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

    const [existing] = await db.select().from(schema.posShifts)
      .where(and(eq(schema.posShifts.id, id), eq(schema.posShifts.companyId, req.targetCompanyId)));
    if (!existing) return res.status(404).json({ error: 'Shift not found.' });
    // A branch-restricted cashier must not be able to close/edit (cash figures, notes,
    // attachment) another branch's shift by id — see this file's other findings from the
    // same audit pass.
    if (!branchAccessOk(req, existing.branchId)) {
      return res.status(403).json({ error: 'Forbidden: you are not assigned to this branch.' });
    }
    // Branch is immutable after the shift opens, same as every other document's branchId
    // — never let this update move a shift to a different branch.
    data.branchId = existing.branchId;

    await db.update(schema.posShifts).set({
        ...data,
        endTime: data.endTime ? new Date(data.endTime) : null,
    }).where(eq(schema.posShifts.id, id));
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
    const conditions = [eq(schema.posHeldInvoices.companyId, companyId)];
    if (Array.isArray(req.allowedBranchIds)) {
      if (req.allowedBranchIds.length === 0) return res.json([]);
      conditions.push(inArray(schema.posHeldInvoices.branchId, req.allowedBranchIds));
    }
    const heldInvoices = await db.select().from(schema.posHeldInvoices).where(and(...conditions));
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

    // branchId is never trusted from the client — always inherited from the owning
    // shift's own (already-validated-at-open-time) branchId, same "denormalized from a
    // real parent" convention as every other carry-your-own-branchId table.
    const [shift] = await db.select({ id: schema.posShifts.id, branchId: schema.posShifts.branchId })
      .from(schema.posShifts).where(and(eq(schema.posShifts.id, data.shiftId), eq(schema.posShifts.companyId, data.companyId)));
    if (!shift) return res.status(404).json({ error: 'Shift not found for this company.' });
    if (!branchAccessOk(req, shift.branchId)) {
      return res.status(403).json({ error: 'Forbidden: you are not assigned to this branch.' });
    }
    data.branchId = shift.branchId;

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
    const [existing] = await db.select().from(schema.posHeldInvoices)
      .where(and(eq(schema.posHeldInvoices.id, id), eq(schema.posHeldInvoices.companyId, req.targetCompanyId)));
    if (!existing) return res.status(404).json({ error: 'Held invoice not found.' });
    // A branch-restricted cashier must not be able to delete/resume another branch's
    // parked sale by id.
    if (!branchAccessOk(req, existing.branchId)) {
      return res.status(403).json({ error: 'Forbidden: you are not assigned to this branch.' });
    }
    await db.delete(schema.posHeldInvoices).where(eq(schema.posHeldInvoices.id, id));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
