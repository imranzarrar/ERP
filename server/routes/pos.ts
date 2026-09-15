import express from 'express';
import bcrypt from 'bcrypt';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and, gte, ne, inArray, sql } from 'drizzle-orm';
import { normalizePermissions } from '../../src/types.js';
import { branchAccessOk, resolveDocumentBranchId, hasPermission, resolveUserPermissions } from '../lib/authz.js';
import { generateId } from '../../src/id.js';
import { getAndIncrementDocumentNumber } from '../lib/documentNumbering.js';
import { restockForSaleReversal, validateTransactionDate, assertQuarterNotFiled, postCreditNoteReversalVoucher } from '../lib/businessLogic.js';
import { processInvoiceZatca } from '../lib/zatca/processInvoice.js';
import { recordAuditLog } from '../lib/audit.js';

const router = express.Router();

// Default when a company has never set one — 7 days is a common, conservative retail
// return-window default; overridable per company via POS Terminal Settings
// (posSettings.returnWindowDays, same unstructured-JSONB convention as autoPrint/
// maxImageSizeKB — see src/components/PosModule.tsx's own default object).
const DEFAULT_RETURN_WINDOW_DAYS = 7;

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

// --- POS Returns ---
// Deliberately NOT a parallel reversal system — a return is a Credit Note (same
// invoices/invoiceItems tables, same ZATCA hash-chain/XML pipeline, same
// postCreditNoteReversalVoucher refund mechanism as server/routes/transactions.ts's
// POST /invoices/:id/note), just entered through a fast, POS-native front door instead of
// the back-office Invoice screen, and — unlike that route — able to return only SOME of
// an invoice's lines/quantities rather than always mirroring the whole thing. A cashier
// never sees the words "credit note"; the underlying document and audit trail still is one.

function getReturnWindowDays(posSettings: any): number {
  const n = Number(posSettings?.returnWindowDays);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETURN_WINDOW_DAYS;
}

// Requires only baseline POS access — a cashier without pos.return can still SEE what's
// returnable (and how much of each line is left), so they know whether to call a manager
// over at all, before hitting the permission wall on the actual submit below.
router.get('/returnable-invoices', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.pos.access.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const companyId = req.targetCompanyId;
    const search = String(req.query.search || '').trim();

    const [company] = await db.select({ posSettings: schema.companies.posSettings })
      .from(schema.companies).where(eq(schema.companies.id, companyId));
    const windowDays = getReturnWindowDays(company?.posSettings);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - windowDays);
    const cutoffDateStr = cutoffDate.toISOString().slice(0, 10);

    const conditions = [
      eq(schema.invoices.companyId, companyId),
      eq(schema.invoices.isPosSale, true),
      eq(schema.invoices.documentType, 'Invoice'),
      ne(schema.invoices.status, 'Cancelled'),
      gte(schema.invoices.date, cutoffDateStr),
    ];
    if (Array.isArray(req.allowedBranchIds)) {
      if (req.allowedBranchIds.length === 0) return res.json([]);
      conditions.push(inArray(schema.invoices.branchId, req.allowedBranchIds));
    }
    if (search) {
      conditions.push(sql`${schema.invoices.invoiceNumber} ILIKE ${'%' + search + '%'}`);
    }

    const candidates = await db.select().from(schema.invoices).where(and(...conditions))
      .orderBy(sql`${schema.invoices.createdAt} desc`).limit(25);
    if (candidates.length === 0) return res.json([]);

    const invoiceIds = candidates.map(c => c.id);
    const items = await db.select().from(schema.invoiceItems).where(inArray(schema.invoiceItems.invoiceId, invoiceIds));

    // Cumulative already-returned quantity per original line — every CreditNote item
    // anywhere that points back at it via originalInvoiceItemId, regardless of which
    // credit note or when. This is what caps how much of THIS line can be returned again.
    const originalItemIds = items.map(i => i.id);
    const priorReturnItems = originalItemIds.length
      ? await db.select({ originalInvoiceItemId: schema.invoiceItems.originalInvoiceItemId, quantity: schema.invoiceItems.quantity })
          .from(schema.invoiceItems)
          .where(inArray(schema.invoiceItems.originalInvoiceItemId, originalItemIds))
      : [];
    const returnedByOriginalItemId = new Map<string, number>();
    for (const r of priorReturnItems) {
      if (!r.originalInvoiceItemId) continue;
      returnedByOriginalItemId.set(r.originalInvoiceItemId, (returnedByOriginalItemId.get(r.originalInvoiceItemId) || 0) + Number(r.quantity));
    }

    const customerIds = [...new Set(candidates.map(c => c.customerId).filter(Boolean))];
    const customers = customerIds.length
      ? await db.select({ id: schema.customers.id, name: schema.customers.name }).from(schema.customers).where(inArray(schema.customers.id, customerIds))
      : [];
    const customerNameById = new Map(customers.map(c => [c.id, c.name]));

    const result = candidates.map(inv => ({
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      date: inv.date,
      customerName: customerNameById.get(inv.customerId) || 'Walk-in Customer',
      amountPaid: inv.amountPaid,
      items: items.filter(i => i.invoiceId === inv.id).map(i => ({
        id: i.id,
        description: i.description,
        unitCost: i.unitCost,
        quantity: i.quantity,
        taxSlabId: i.taxSlabId,
        productId: i.productId,
        unitOfMeasureId: i.unitOfMeasureId,
        alreadyReturnedQuantity: returnedByOriginalItemId.get(i.id) || 0,
      })),
    }));
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/returns', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.pos.access.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { invoiceId, items: requestedItems, reason, overrideUsername, overridePassword } = req.body;
    if (!invoiceId || !Array.isArray(requestedItems) || requestedItems.length === 0) {
      return res.status(400).json({ error: 'invoiceId and at least one returned item are required.' });
    }

    // Manager override: the acting cashier stays logged in as themselves throughout —
    // this never switches session/identity, it just verifies a NAMED other user (a) is
    // real, (b) belongs to this same company (or is a super-admin), (c) knows their own
    // password, and (d) actually holds pos.return, then lets THIS request through under
    // that authorization. Both identities are recorded in the audit log below.
    let overrideBy: { id: string; username: string } | null = null;
    if (!hasPermission(req.user, 'pos.return')) {
      if (!overrideUsername || !overridePassword) {
        return res.status(403).json({ error: 'You do not have permission to process returns. Ask a manager to authorize this return.', requiresOverride: true });
      }
      const [overrideUser] = await db.select().from(schema.users)
        .where(sql`LOWER(${schema.users.username}) = ${String(overrideUsername).trim().toLowerCase()}`);
      const overrideUserOk = overrideUser
        && overrideUser.isDeleted !== 1
        && overrideUser.isActive !== false
        && (overrideUser.isSuperAdmin || overrideUser.companyId === req.targetCompanyId)
        && overrideUser.password
        && await bcrypt.compare(overridePassword, overrideUser.password);
      if (!overrideUserOk) {
        return res.status(401).json({ error: 'Invalid manager credentials.' });
      }
      const overridePermissions = await resolveUserPermissions(overrideUser.id);
      const normalizedOverride = normalizePermissions(overridePermissions, overrideUser.role, overrideUser.isSuperAdmin);
      if (!(normalizedOverride?.pos?.return?.enabled)) {
        return res.status(403).json({ error: 'That user does not have permission to authorize returns.' });
      }
      overrideBy = { id: overrideUser.id, username: overrideUser.username };
    }

    const companyId = req.targetCompanyId;
    const [original] = await db.select().from(schema.invoices)
      .where(and(eq(schema.invoices.id, invoiceId), eq(schema.invoices.companyId, companyId)));
    if (!original) return res.status(404).json({ error: 'Original invoice not found.' });
    if (!original.isPosSale || original.documentType !== 'Invoice') {
      return res.status(400).json({ error: 'Only POS-sold invoices can be returned through this screen.' });
    }
    if (original.status === 'Cancelled') {
      return res.status(400).json({ error: 'Cannot return a cancelled invoice.' });
    }
    if (!branchAccessOk(req, original.branchId)) {
      return res.status(403).json({ error: 'Forbidden: you are not assigned to this branch.' });
    }

    // Return-window re-check, server-side — never trust that the client only shows
    // invoices the search endpoint already filtered; the window (or the invoice's status)
    // could have changed between the cashier searching and confirming.
    const [company] = await db.select({ posSettings: schema.companies.posSettings })
      .from(schema.companies).where(eq(schema.companies.id, companyId));
    const windowDays = getReturnWindowDays(company?.posSettings);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - windowDays);
    if (original.date < cutoffDate.toISOString().slice(0, 10)) {
      return res.status(400).json({ error: `This sale is outside the ${windowDays}-day return window.` });
    }

    const originalItems = await db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, invoiceId));
    const originalItemById = new Map(originalItems.map(i => [i.id, i]));

    // Cumulative-quantity validation per line — this is what makes MULTIPLE partial
    // returns against the same invoice safe (return 1 today, another next week): checked
    // fresh against the DB every time, not an incrementally-maintained counter that could
    // race under concurrent returns.
    const requestedByItemId = new Map<string, number>();
    for (const reqItem of requestedItems) {
      const qty = Number(reqItem.quantity);
      if (!reqItem.invoiceItemId || !(qty > 0)) {
        return res.status(400).json({ error: 'Each returned item needs a valid invoiceItemId and a positive quantity.' });
      }
      requestedByItemId.set(reqItem.invoiceItemId, (requestedByItemId.get(reqItem.invoiceItemId) || 0) + qty);
    }
    const requestedItemIds = [...requestedByItemId.keys()];
    const priorReturnItems = await db.select({ originalInvoiceItemId: schema.invoiceItems.originalInvoiceItemId, quantity: schema.invoiceItems.quantity })
      .from(schema.invoiceItems).where(inArray(schema.invoiceItems.originalInvoiceItemId, requestedItemIds));
    const alreadyReturnedByItemId = new Map<string, number>();
    for (const r of priorReturnItems) {
      if (!r.originalInvoiceItemId) continue;
      alreadyReturnedByItemId.set(r.originalInvoiceItemId, (alreadyReturnedByItemId.get(r.originalInvoiceItemId) || 0) + Number(r.quantity));
    }

    for (const [itemId, qty] of requestedByItemId.entries()) {
      const originalItem = originalItemById.get(itemId);
      if (!originalItem) {
        return res.status(400).json({ error: 'One of the selected items does not belong to this invoice.' });
      }
      const alreadyReturned = alreadyReturnedByItemId.get(itemId) || 0;
      const remaining = Number(originalItem.quantity) - alreadyReturned;
      if (qty > remaining + 0.0001) {
        return res.status(400).json({ error: `Cannot return ${qty} of "${originalItem.description}" — only ${remaining} remain returnable.` });
      }
    }

    // Refund amount for the voucher: flat subtotal + this line's own tax-slab rate,
    // summed across only the returned lines — matches the same per-line tax model
    // src/dbStore.ts's calculateInvoiceTotals and the POS thermal receipt already use,
    // not a proportional slice of the original's single combined total.
    const taxSlabIds = [...new Set(originalItems.map(i => i.taxSlabId).filter(Boolean))] as string[];
    const taxSlabs = taxSlabIds.length
      ? await db.select().from(schema.taxSlabs).where(inArray(schema.taxSlabs.id, taxSlabIds))
      : [];
    const taxRateById = new Map(taxSlabs.map(t => [t.id, Number(t.percentage)]));
    const fallbackTaxRate = original.taxSlabId ? (taxRateById.get(original.taxSlabId) ?? 0) : 0;

    let refundAmount = 0;
    for (const [itemId, qty] of requestedByItemId.entries()) {
      const originalItem = originalItemById.get(itemId)!;
      const lineSubtotal = qty * Number(originalItem.unitCost);
      const rate = originalItem.taxSlabId ? (taxRateById.get(originalItem.taxSlabId) ?? fallbackTaxRate) : fallbackTaxRate;
      refundAmount += lineSubtotal * (1 + rate / 100);
    }
    refundAmount = Math.round(refundAmount * 100) / 100;

    // A POS return happens now — the return receipt/credit note is always dated with
    // today's system date, never backdated to the original sale's date (that's a
    // separate, correct design choice for the back-office /invoices/:id/note route,
    // which intentionally inherits the original invoice's date instead). If today isn't
    // in an open fiscal month, the whole return is refused here — never silently posted
    // into some other open month.
    const todayStr = new Date().toISOString().slice(0, 10);

    let savedNoteId = '';
    let savedNoteNumber = '';
    await db.transaction(async (tx) => {
      await validateTransactionDate(todayStr, companyId);
      await assertQuarterNotFiled(todayStr, companyId);

      const noteNumber = await getAndIncrementDocumentNumber(tx, companyId, 'creditNote', todayStr, original.branchId);
      savedNoteNumber = noteNumber;
      const noteId = generateId();

      await tx.insert(schema.invoices).values({
        id: noteId,
        invoiceNumber: noteNumber,
        date: todayStr,
        customerId: original.customerId,
        taxSlabId: original.taxSlabId,
        bankId: original.bankId,
        paymentStatus: 'Unpaid',
        notes: reason || 'POS Return',
        status: 'Active',
        createdById: req.user.id,
        createdAt: new Date(),
        amountPaid: '0',
        companyId,
        branchId: original.branchId,
        warehouseId: original.warehouseId,
        isPosSale: true,
        documentType: 'CreditNote',
        originalInvoiceId: invoiceId,
        creditNoteReason: reason || 'POS Return',
      });
      savedNoteId = noteId;

      for (const [itemId, qty] of requestedByItemId.entries()) {
        const originalItem = originalItemById.get(itemId)!;
        await tx.insert(schema.invoiceItems).values({
          id: generateId(),
          invoiceId: noteId,
          description: originalItem.description,
          unitCost: originalItem.unitCost,
          quantity: String(qty),
          discountAmount: null,
          taxSlabId: originalItem.taxSlabId,
          unit: originalItem.unit,
          productId: originalItem.productId,
          unitOfMeasureId: originalItem.unitOfMeasureId,
          originalInvoiceItemId: itemId,
        });

        if (originalItem.productId) {
          await restockForSaleReversal(tx, companyId, originalItem.productId, qty, noteId, new Date(), original.warehouseId, originalItem.unitOfMeasureId);
        }
      }

      if (Number(original.amountPaid) > 0 && refundAmount > 0) {
        await postCreditNoteReversalVoucher(tx, invoiceId, companyId, todayStr, req.user.id, {
          amount: refundAmount,
          creditNoteNumber: noteNumber,
        });
      }
    });

    if (savedNoteId) {
      processInvoiceZatca(savedNoteId).catch(err => {
        console.error('[Auto ZATCA Error - POS Return]:', err);
      });
    }

    recordAuditLog(req, 'CREATE_CREDIT_NOTE', 'invoice', savedNoteId, {
      invoiceNumber: savedNoteNumber,
      originalInvoiceId: invoiceId,
      originalInvoiceNumber: original.invoiceNumber,
      reason: reason || 'POS Return',
      posReturn: true,
      refundAmount,
      overrideBy: overrideBy ? { id: overrideBy.id, username: overrideBy.username } : undefined,
    });

    res.json({ success: true, noteId: savedNoteId, noteNumber: savedNoteNumber, refundAmount });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

export default router;
