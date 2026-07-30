import express from 'express';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, inArray, and, desc } from 'drizzle-orm';
import { getAndIncrementCounter, validateTransactionDate, syncVoucherForExpense, syncVoucherForInvoice, round2, computePaymentStatus } from '../lib/businessLogic.js';
import { normalizePermissions } from '../../src/types.js';
import { processInvoiceZatca } from '../lib/zatca/processInvoice.js';
import { hasPermission, assertOwnsRow } from '../lib/authz.js';
import { parseLimitOffset } from '../lib/pagination.js';
import { generateId } from '../../src/id.js';

const router = express.Router();

router.get('/quotations', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.quotation.view.enabled) return res.status(403).json({ error: 'Forbidden' });

    const conditions = [eq(schema.quotations.companyId, req.targetCompanyId)];
    if (!(req.user.role === 'admin' || req.user.isSuperAdmin)) {
      conditions.push(eq(schema.quotations.createdById, req.user.id));
    }
    const { limit, offset } = parseLimitOffset(req);
    const quotations = await db.select().from(schema.quotations).where(and(...conditions))
      .orderBy(desc(schema.quotations.createdAt)).limit(limit).offset(offset);

    const quotIds = quotations.map(q => q.id);
    const items = quotIds.length > 0 ? await db.select().from(schema.quotationItems).where(inArray(schema.quotationItems.quotationId, quotIds)) : [];

    res.json(quotations.map(q => ({
      ...q,
      items: items.filter(i => i.quotationId === q.id)
    })));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Quotations ---
router.post('/quotations', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.quotation.create.enabled) return res.status(403).json({ error: 'Forbidden' });

    const { quotationData } = req.body;

    if (quotationData.id) {
      const [existing] = await db.select().from(schema.quotations).where(eq(schema.quotations.id, quotationData.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this quotation belongs to another company' });
      }
    }

    quotationData.companyId = req.targetCompanyId;
    const { items, ...qData } = quotationData;

    await db.transaction(async (tx) => {
      // 1. Business logic
      const companyId = req.targetCompanyId;
      await validateTransactionDate(qData.date, companyId);

      // 2. Increment Counter if new
      let qNumber = qData.quotationNumber;
      if (!qData.quotationNumber) {
        const qCount = await getAndIncrementCounter(tx, companyId, 'quotation');
        qNumber = `QT-${qCount}`;
      }
      
      // 3. Insert/Update Quotation
      const [newQuotation] = await tx.insert(schema.quotations).values({
        ...qData,
        id: qData.id || generateId(),
        quotationNumber: qNumber,
        createdAt: qData.createdAt ? new Date(qData.createdAt) : new Date(),
      }).onConflictDoUpdate({
        target: schema.quotations.id,
        set: {
          ...qData,
          quotationNumber: qNumber,
          createdAt: qData.createdAt ? new Date(qData.createdAt) : new Date(),
        }
      }).returning();
      
      // 4. Insert/Update Items
      if (items && items.length > 0) {
        await tx.delete(schema.quotationItems).where(eq(schema.quotationItems.quotationId, newQuotation.id));
        await tx.insert(schema.quotationItems).values(items.map((item: any) => ({
          ...item,
          quotationId: newQuotation.id,
          unitCost: String(round2(Number(item.unitCost))),
          quantity: String(item.quantity),
          discountAmount: item.discountAmount ? String(round2(Number(item.discountAmount))) : '0'
        })));
      }
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.put('/quotations/:id', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.quotation.create.enabled) return res.status(403).json({ error: 'Forbidden' });

    const { id } = req.params;
    const { quotationData } = req.body;
    const { items, ...qData } = quotationData;

    await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(schema.quotations).where(and(eq(schema.quotations.id, id), eq(schema.quotations.companyId, req.targetCompanyId)));
      if (!existing) throw new Error('Quotation not found.');
      if (existing.status === 'Converted') throw new Error('Converted quotations cannot be modified.');

      const companyId = req.targetCompanyId;
      qData.companyId = companyId;

      if (qData.date) {
        await validateTransactionDate(qData.date, companyId);
      }

      await tx.update(schema.quotations).set({
        ...qData,
        createdAt: qData.createdAt ? new Date(qData.createdAt) : existing.createdAt
      }).where(eq(schema.quotations.id, id));

      if (items) {
        await tx.delete(schema.quotationItems).where(eq(schema.quotationItems.quotationId, id));
        await tx.insert(schema.quotationItems).values(items.map((item: any) => ({
          ...item,
          quotationId: id,
          unitCost: String(round2(Number(item.unitCost))),
          quantity: String(item.quantity),
          discountAmount: item.discountAmount ? String(round2(Number(item.discountAmount))) : '0'
        })));
      }
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/quotations/:id/convert', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.invoice.create.enabled) return res.status(403).json({ error: 'Forbidden' });

    const { id } = req.params;
    const { invoiceDate, bankId, paymentStatus, customItems, customDiscountPercentage, customTaxSlabId, customCustomerId, customNotes, createdById } = req.body;

    await db.transaction(async (tx) => {
      // 1. Fetch quotation
      const [quotation] = await tx.select().from(schema.quotations).where(and(eq(schema.quotations.id, id), eq(schema.quotations.companyId, req.targetCompanyId)));
      if (!quotation) throw new Error('Quotation not found.');
      if (quotation.status !== 'Accepted') throw new Error(`Only accepted quotations can be converted. Current status: ${quotation.status}`);

      const companyId = req.targetCompanyId;
      await validateTransactionDate(invoiceDate, companyId);

      // 2. Fetch tax slab for calculations
      const targetTaxSlabId = customTaxSlabId || quotation.taxSlabId;
      const [taxSlab] = await tx.select().from(schema.taxSlabs).where(eq(schema.taxSlabs.id, targetTaxSlabId));
      const percentage = taxSlab ? Number(taxSlab.percentage) : 0;

      // 3. Increment Invoice Counter
      const invCount = await getAndIncrementCounter(tx, companyId, 'invoice');
      const invNumber = `INV-${invCount}`;
      const invoiceId = generateId();

      // 4. Fetch / calculate Items
      const itemsToInsert = customItems || await tx.select().from(schema.quotationItems).where(eq(schema.quotationItems.quotationId, id));

      const subtotal = round2(itemsToInsert.reduce((acc: number, item: any) => {
        const cost = round2(Math.max(0, round2(Number(item.unitCost)) - round2(Number(item.discountAmount || 0))));
        return acc + round2(cost * Number(item.quantity));
      }, 0));
      const discountPct = customDiscountPercentage !== undefined ? Number(customDiscountPercentage) : Number(quotation.discountPercentage || 0);
      const headerDiscount = round2(subtotal * (discountPct / 100));
      const discountedSubtotal = round2(Math.max(0, subtotal - headerDiscount));
      const taxAmount = round2(discountedSubtotal * (percentage / 100));
      const grandTotal = round2(discountedSubtotal + taxAmount);

      const discountPctStr = String(discountPct);
      const amountPaidNum = paymentStatus === 'Paid' ? grandTotal : 0;
      const amountPaidStr = String(amountPaidNum);
      // paymentStatus is a derived fact of amountPaid vs. the total, not a client-asserted
      // string — recomputing it here closes the door on an arbitrary/typo'd status value
      // being written (the DB column is unconstrained text).
      const computedPaymentStatus = computePaymentStatus(amountPaidNum, grandTotal);

      // 5. Insert Invoice with computed financial totals
      const [newInvoice] = await tx.insert(schema.invoices).values({
        id: invoiceId,
        invoiceNumber: invNumber,
        date: invoiceDate,
        companyId: companyId,
        customerId: customCustomerId || quotation.customerId,
        taxSlabId: targetTaxSlabId,
        notes: customNotes || quotation.notes,
        paymentStatus: computedPaymentStatus,
        paymentDate: computedPaymentStatus === 'Paid' ? new Date(invoiceDate) : null,
        bankId: bankId,
        createdById: createdById,
        originQuotationId: id,
        status: 'Active',
        createdAt: new Date(),
        discountPercentage: discountPctStr,
        amountPaid: amountPaidStr,
      }).returning();

      // 6. Insert Items
      await tx.insert(schema.invoiceItems).values(itemsToInsert.map((item: any) => ({
        id: generateId(),
        invoiceId: invoiceId,
        description: item.description,
        unitCost: String(round2(Number(item.unitCost))),
        quantity: String(item.quantity),
        discountAmount: item.discountAmount ? String(round2(Number(item.discountAmount))) : '0'
      })));

      // 7. Update Quotation Status
      await tx.update(schema.quotations).set({ status: 'Converted' }).where(eq(schema.quotations.id, id));

      // 8. Generate Receipt Voucher if status is Paid
      if (computedPaymentStatus === 'Paid') {
        await syncVoucherForInvoice(tx, invoiceId, companyId, {
          paymentStatus: 'Paid',
          status: 'Active',
          paymentDate: invoiceDate,
          date: invoiceDate,
          bankId: bankId,
          amountPaid: amountPaidStr,
          amount: String(grandTotal),
          invoiceNumber: invNumber,
        }, req.user.id);
      }
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// --- Invoices ---
router.get('/invoices', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.invoice.view.enabled) return res.status(403).json({ error: 'Forbidden' });

    const companyId = req.targetCompanyId;
    const conditions = [eq(schema.invoices.companyId, companyId)];
    if (req.user.role !== 'admin' && !req.user.isSuperAdmin) {
      conditions.push(eq(schema.invoices.createdById, req.user.id));
    }
    const { limit, offset } = parseLimitOffset(req);
    const invoices = await db.select().from(schema.invoices).where(and(...conditions))
      .orderBy(desc(schema.invoices.createdAt)).limit(limit).offset(offset);
    res.json(invoices);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/invoices', async (req: any, res) => {
  try {
    const user = req.user;
    const permissions = normalizePermissions(user.permissions, user.role, user.isSuperAdmin);
    if (!permissions.invoice.create.enabled) return res.status(403).json({ error: 'Forbidden' });

    const { invoiceData } = req.body;
    const { items, ...invData } = invoiceData;

    if (invData.id) {
      const [existing] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invData.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this invoice belongs to another company' });
      }
    }

    invData.companyId = req.targetCompanyId;
    // createdById is NOT NULL and, unlike the quotation-conversion/POS/voucher insert
    // paths in this same file, was never being set here — every direct invoice creation
    // failed with a raw Postgres constraint violation before this fix.
    if (!invData.createdById) invData.createdById = user.id;
    const isNewInvoice = !invData.id;
    invData.id = invData.id || generateId();

    let savedInvoiceId = '';
    await db.transaction(async (tx) => {
      // 1. Business logic
      const companyId = req.targetCompanyId;
      await validateTransactionDate(invData.date, companyId);

      // 2. Increment Counter if new
      if (isNewInvoice) {
        const invCount = await getAndIncrementCounter(tx, companyId, 'invoice');
        invData.invoiceNumber = `INV-${invCount}`;
      }

      // 2b. Compute grand total server-side from items + tax slab so paymentStatus can be
      // derived from amountPaid vs. an actual total, instead of trusting whatever string
      // the client sent for paymentStatus directly. Each line can carry its own
      // taxSlabId (falls back to the header slab when a line doesn't set one) — mirrors
      // dbStore.ts's calculateInvoiceTotals exactly, so the client-side preview a user
      // sees while building the invoice matches what the server actually persists.
      const [headerTaxSlab] = invData.taxSlabId ? await tx.select().from(schema.taxSlabs).where(eq(schema.taxSlabs.id, invData.taxSlabId)) : [undefined];
      const headerPercentage = headerTaxSlab ? Number(headerTaxSlab.percentage) : 0;
      const lineSlabIds = Array.from(new Set((items || []).map((it: any) => it.taxSlabId).filter(Boolean)));
      const lineSlabRows = lineSlabIds.length > 0 ? await tx.select().from(schema.taxSlabs).where(inArray(schema.taxSlabs.id, lineSlabIds as string[])) : [];
      const lineSlabPercentageById = new Map(lineSlabRows.map((s: any) => [s.id, Number(s.percentage)]));

      const itemsSubtotal = round2((items || []).reduce((acc: number, item: any) => {
        const cost = round2(Math.max(0, round2(Number(item.unitCost)) - round2(Number(item.discountAmount || 0))));
        return acc + round2(cost * Number(item.quantity));
      }, 0));
      const headerDiscount = round2(itemsSubtotal * (Number(invData.discountPercentage || 0) / 100));
      const shrinkFactor = itemsSubtotal > 0 ? (itemsSubtotal - headerDiscount) / itemsSubtotal : 1;
      const discountedSubtotal = round2(Math.max(0, itemsSubtotal - headerDiscount));
      const taxAmount = round2((items || []).reduce((acc: number, item: any) => {
        const cost = round2(Math.max(0, round2(Number(item.unitCost)) - round2(Number(item.discountAmount || 0))));
        const lineSubtotal = round2(round2(cost * Number(item.quantity)) * shrinkFactor);
        const rate = item.taxSlabId && lineSlabPercentageById.has(item.taxSlabId) ? lineSlabPercentageById.get(item.taxSlabId)! : headerPercentage;
        return acc + round2(lineSubtotal * (rate / 100));
      }, 0));
      const grandTotal = round2(discountedSubtotal + taxAmount);

      invData.paymentStatus = computePaymentStatus(Number(invData.amountPaid || 0), grandTotal);
      invData.amountPaid = String(round2(Number(invData.amountPaid || 0)));

      // 3. Insert/Update Invoice
      const [newInvoice] = await tx.insert(schema.invoices).values({
        ...invData,
        createdAt: invData.createdAt ? new Date(invData.createdAt) : new Date(),
        paymentDate: invData.paymentDate ? new Date(invData.paymentDate) : null,
      }).onConflictDoUpdate({
        target: schema.invoices.id,
        set: invData
      }).returning();
      
      savedInvoiceId = newInvoice.id;

      // 4. Insert/Update Items
      if (items && items.length > 0) {
        for (const item of items) {
          await tx.insert(schema.invoiceItems).values({
            ...item,
            invoiceId: newInvoice.id,
            unitCost: String(round2(Number(item.unitCost))),
            quantity: String(item.quantity),
            discountAmount: item.discountAmount ? String(round2(Number(item.discountAmount))) : '0'
          }).onConflictDoUpdate({
            target: schema.invoiceItems.id,
            set: item
          });
        }
      }

      // 5. Generate Receipt Voucher if status is Paid
      await syncVoucherForInvoice(tx, newInvoice.id, companyId, {
        ...invData,
        invoiceNumber: newInvoice.invoiceNumber,
      }, user.id);
    });

    // Auto-process ZATCA Phase 2 E-Invoicing clearance/reporting
    if (savedInvoiceId) {
      processInvoiceZatca(savedInvoiceId).catch(err => {
        console.error('[Auto ZATCA Error]:', err);
      });
    }

    res.json({ success: true, invoiceId: savedInvoiceId });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Credit/Debit Note — creates a new ZATCA document referencing an existing invoice,
// reusing the same invoices/invoiceItems tables, counter mechanism, and background
// ZATCA processing pipeline as a regular invoice (see schema.ts's documentType/
// originalInvoiceId/creditNoteReason columns and processInvoice.ts's handling of them).
// MVP scope: full-document reversal only (mirrors every line from the original invoice
// verbatim) — a partial/line-selectable credit note is a larger feature, tracked for
// later. No automatic refund/reversal voucher is generated here either; the accounting
// treatment of the credit is a separate, explicitly deferred piece of work.
router.post('/invoices/:id/note', async (req: any, res) => {
  try {
    const user = req.user;
    const permissions = normalizePermissions(user.permissions, user.role, user.isSuperAdmin);
    if (!permissions.invoice.create.enabled) return res.status(403).json({ error: 'Forbidden' });

    const { id: originalInvoiceId } = req.params;
    const { type, reason } = req.body;
    if (type !== 'CreditNote' && type !== 'DebitNote') {
      return res.status(400).json({ error: 'type must be "CreditNote" or "DebitNote"' });
    }

    const companyId = req.targetCompanyId;
    const [original] = await db.select().from(schema.invoices)
      .where(and(eq(schema.invoices.id, originalInvoiceId), eq(schema.invoices.companyId, companyId)));
    if (!original) return res.status(404).json({ error: 'Original invoice not found' });

    const originalItems = await db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, originalInvoiceId));
    if (originalItems.length === 0) {
      return res.status(400).json({ error: 'Original invoice has no line items to reference' });
    }

    let savedNoteId = '';
    await db.transaction(async (tx) => {
      await validateTransactionDate(original.date, companyId);

      const counterType = type === 'CreditNote' ? 'creditNote' : 'debitNote';
      const prefix = type === 'CreditNote' ? 'CN' : 'DN';
      const noteCount = await getAndIncrementCounter(tx, companyId, counterType);
      const noteId = generateId();

      const [newNote] = await tx.insert(schema.invoices).values({
        id: noteId,
        invoiceNumber: `${prefix}-${noteCount}`,
        date: original.date,
        customerId: original.customerId,
        taxSlabId: original.taxSlabId,
        bankId: original.bankId,
        paymentStatus: 'Unpaid',
        notes: reason || '',
        status: 'Active',
        createdById: user.id,
        createdAt: new Date(),
        discountPercentage: original.discountPercentage,
        amountPaid: '0',
        companyId,
        documentType: type,
        originalInvoiceId,
        creditNoteReason: reason || null,
      }).returning();

      savedNoteId = newNote.id;

      for (const item of originalItems) {
        await tx.insert(schema.invoiceItems).values({
          id: generateId(),
          invoiceId: newNote.id,
          description: item.description,
          unitCost: item.unitCost,
          quantity: item.quantity,
          discountAmount: item.discountAmount,
          taxSlabId: item.taxSlabId,
        });
      }

      // A Credit Note structurally reverses the original invoice — if any of it was
      // actually paid, reverse that receipt too. Reuses the same synthetic
      // `status: 'Cancelled'` override already used by the /cancel route above to route
      // into syncVoucherForInvoice's reversal branch (month-closed-aware: deletes the
      // open-month Receipt outright, or posts a dated Reversal voucher if the month's
      // closed) without ever touching the original invoice's own stored paymentStatus.
      // Debit Notes represent new unpaid charges, not a reversal, so they never reach here.
      if (type === 'CreditNote' && Number(original.amountPaid) > 0) {
        await syncVoucherForInvoice(tx, originalInvoiceId, companyId, {
          ...original,
          status: 'Cancelled',
        }, user.id);
      }
    });

    if (savedNoteId) {
      processInvoiceZatca(savedNoteId).catch(err => {
        console.error('[Auto ZATCA Error - Credit/Debit Note]:', err);
      });
    }

    res.json({ success: true, noteId: savedNoteId });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/invoices/:id/paid', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.invoice.create.enabled) return res.status(403).json({ error: 'Forbidden' });

    const { id } = req.params;
    await db.transaction(async (tx) => {
      const [invoice] = await tx.select().from(schema.invoices).where(and(eq(schema.invoices.id, id), eq(schema.invoices.companyId, req.targetCompanyId)));
      if (!invoice) throw new Error('Invoice not found');

      const invItems = await tx.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, id));
      const [taxSlab] = invoice.taxSlabId ? await tx.select().from(schema.taxSlabs).where(eq(schema.taxSlabs.id, invoice.taxSlabId)) : [undefined];
      const percentage = taxSlab ? Number(taxSlab.percentage) : 0;
      const itemsSubtotal = round2(invItems.reduce((acc, item) => {
        const cost = round2(Math.max(0, round2(Number(item.unitCost)) - round2(Number(item.discountAmount || 0))));
        return acc + round2(cost * Number(item.quantity));
      }, 0));
      const headerDiscount = round2(itemsSubtotal * (Number(invoice.discountPercentage || 0) / 100));
      const discountedSubtotal = round2(Math.max(0, itemsSubtotal - headerDiscount));
      const taxAmount = round2(discountedSubtotal * (percentage / 100));
      const grandTotal = round2(discountedSubtotal + taxAmount);
      const amountPaidStr = String(grandTotal);

      await tx.update(schema.invoices).set({ paymentStatus: 'Paid', amountPaid: amountPaidStr }).where(eq(schema.invoices.id, id));

      await syncVoucherForInvoice(tx, id, invoice.companyId, {
        ...invoice,
        paymentStatus: 'Paid',
        amountPaid: amountPaidStr,
        amount: amountPaidStr,
      }, req.user.id);
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/invoices/:id/cancel', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.cancel.access.enabled) return res.status(403).json({ error: 'Forbidden' });

    const { id } = req.params;
    await db.transaction(async (tx) => {
      const [invoice] = await tx.select().from(schema.invoices).where(and(eq(schema.invoices.id, id), eq(schema.invoices.companyId, req.targetCompanyId)));
      if (!invoice) throw new Error('Invoice not found');

      if (['SUBMITTING', 'CLEARED', 'REPORTED'].includes(invoice.zatcaStatus as string)) {
        const err: any = new Error('This invoice has already been submitted to ZATCA and cannot be cancelled. Issue a Credit Note instead.');
        err.status = 400;
        throw err;
      }

      await tx.update(schema.invoices).set({ status: 'Cancelled' }).where(eq(schema.invoices.id, id));

      await syncVoucherForInvoice(tx, id, invoice.companyId, {
        ...invoice,
        status: 'Cancelled',
      }, req.user.id);
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Expense creation lives exclusively in server/routes/expenses.ts (mounted at
// /api/expenses) — that version wraps the insert in a transaction and calls
// syncVoucherForExpense; this duplicate (mounted at /api/transactions/expenses) never
// did either and had already diverged. Confirmed no frontend caller references
// /api/transactions/expenses — removed rather than fixed in place.

// --- Investors ---
router.post('/investors', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'investors.access')) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const data = req.body;
    const iData = { ...data };
    
    iData.companyId = req.targetCompanyId;

    if (iData.createdAt) iData.createdAt = new Date(iData.createdAt);
    iData.equityPercentage = String(iData.equityPercentage);
    if (iData.profitPercentage !== undefined) iData.profitPercentage = String(iData.profitPercentage);
    iData.capitalContributed = String(iData.capitalContributed);

    await db.insert(schema.investors).values(iData).onConflictDoUpdate({
      target: schema.investors.id,
      set: iData
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Fiscal Months ---
router.get('/months', async (req: any, res) => {
  try {
    // Deliberately no permission gate here — every authenticated user in a company needs
    // to see the current fiscal period (Dashboard, POS, etc. all depend on this basic
    // read). Only *closing/opening* a month (POST below) is gated behind
    // fiscalMonths.access, matching the original design intent.
    const companyId = req.targetCompanyId;
    const months = await db.select().from(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyId));
    // Normalize status to Title Case ('Open' | 'Closed')
    const normalizedMonths = months.map(m => {
      let status = m.status;
      if (typeof status === 'string') {
        const lower = status.toLowerCase();
        if (lower === 'open') status = 'Open';
        else if (lower === 'closed') status = 'Closed';
      }
      return { ...m, status };
    });
    res.json(normalizedMonths);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/months', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'fiscalMonths.access')) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const data = req.body;
    const mData = { ...data };
    mData.companyId = req.targetCompanyId;

    // Normalize status to Title Case
    if (typeof mData.status === 'string') {
      const lower = mData.status.toLowerCase();
      if (lower === 'open') mData.status = 'Open';
      else if (lower === 'closed') mData.status = 'Closed';
    }

    if (mData.closedAt) mData.closedAt = new Date(mData.closedAt);

    if (mData.status === 'Closed') {
      // 1. Fetch active templates for the company
      const activeTemplates = await db.select()
        .from(schema.recurringExpenseTemplates)
        .where(
          and(
            eq(schema.recurringExpenseTemplates.companyId, mData.companyId),
            eq(schema.recurringExpenseTemplates.isActive, true)
          )
        );
      
      // 2. Fetch postings for this month
      const postings = await db.select()
        .from(schema.recurringPostings)
        .where(eq(schema.recurringPostings.monthId, mData.id));

      const unposted = activeTemplates.filter(t => {
        const post = postings.find(p => p.templateId === t.id);
        return !post || post.status === 'Unposted';
      });

      if (unposted.length > 0) {
        const list = unposted.map(t => t.description).join(', ');
        return res.status(400).json({
          error: `Cannot close month. Unposted active recurring expenses found: [${list}]. These must be posted as Actual or Accrual first.`
        });
      }
    }

    await db.insert(schema.fiscalMonths).values(mData).onConflictDoUpdate({
      target: [schema.fiscalMonths.id, schema.fiscalMonths.companyId],
      set: mData
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/recurring-postings', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.expense.create.enabled) return res.status(403).json({ error: 'Forbidden' });

    const { templateId, monthId, postType, amount, dateStr, paymentStatus, bankId } = req.body;
    const companyId = req.targetCompanyId;

    await db.transaction(async (tx) => {
      // 1. Validation
      await validateTransactionDate(dateStr, companyId);
      
      const [existingPosting] = await tx.select().from(schema.recurringPostings).where(and(eq(schema.recurringPostings.templateId, templateId), eq(schema.recurringPostings.monthId, monthId), eq(schema.recurringPostings.companyId, companyId)));
      if (existingPosting && existingPosting.status !== 'Unposted') {
        throw new Error('This recurring template is already posted for this month.');
      }

      // 2. Create Expense
      const [template] = await tx.select().from(schema.recurringExpenseTemplates).where(and(eq(schema.recurringExpenseTemplates.id, templateId), eq(schema.recurringExpenseTemplates.companyId, companyId)));
      if (!template) throw new Error('Recurring template not found');

      const expCount = await getAndIncrementCounter(tx, companyId, 'expense');
      const expNumber = `EXP-${expCount}`;
      const expenseId = generateId();

      await tx.insert(schema.expenses).values({
        id: expenseId,
        expenseNumber: expNumber,
        date: dateStr,
        vendorId: template.vendorId,
        taxSlabId: template.taxSlabId,
        bankId,
        paymentStatus: postType === 'Accrual' ? 'Unpaid' : paymentStatus,
        paymentDate: (postType === 'Actual' && paymentStatus === 'Paid') ? new Date(dateStr) : null,
        description: `Posted for ${monthId}`, // Simplified
        amount: String(amount),
        status: 'Active',
        type: postType,
        companyId,
        createdById: req.user.id,
        createdAt: new Date(),
      });

      // 3. Save Posting
      await tx.insert(schema.recurringPostings).values({
        id: existingPosting ? existingPosting.id : generateId(),
        templateId,
        monthId,
        status: postType === 'Actual' ? 'Posted as Actual' : 'Posted as Accrual',
        expenseId,
        companyId
      }).onConflictDoUpdate({
        target: [schema.recurringPostings.templateId, schema.recurringPostings.monthId, schema.recurringPostings.companyId],
        set: { status: postType === 'Actual' ? 'Posted as Actual' : 'Posted as Accrual', expenseId }
      });

      // 4. Generate Voucher if Actual & Paid
      if (postType === 'Actual' && paymentStatus === 'Paid') {
        const vchCount = await getAndIncrementCounter(tx, companyId, 'voucher');
        const voucherNumber = `VCH-${vchCount}`;
        await tx.insert(schema.vouchers).values({
          id: generateId(),
          voucherNumber,
          type: 'Payment',
          date: dateStr,
          bankId,
          amount: String(amount),
          description: `Payment voucher for ${expNumber}`,
          referenceType: 'Expense',
          referenceId: expenseId,
          companyId: companyId,
          createdById: req.user.id,
          createdAt: new Date(),
        });
      }
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/settle-accrual', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.expense.create.enabled) return res.status(403).json({ error: 'Forbidden' });

    const { accrualExpenseId, actualAmount, actualDate, paymentStatus, bankId } = req.body;
    const companyId = req.targetCompanyId;

    await db.transaction(async (tx) => {
      // 1. Fetch accrual expense
      const [accrualExpense] = await tx.select()
        .from(schema.expenses)
        .where(and(eq(schema.expenses.id, accrualExpenseId), eq(schema.expenses.type, 'Accrual'), eq(schema.expenses.companyId, companyId)));
      if (!accrualExpense) throw new Error('Accrual expense not found.');
      if (accrualExpense.accrualSettled) throw new Error('Accrual is already settled.');

      // 2. Validate transaction date
      await validateTransactionDate(actualDate, companyId);

      // 3. Increment expense counter
      const expCount = await getAndIncrementCounter(tx, companyId, 'expense');
      const expNumber = `EXP-${expCount}`;
      const actualExpenseId = generateId();

      // 4. Create standard Actual Expense
      await tx.insert(schema.expenses).values({
        id: actualExpenseId,
        expenseNumber: expNumber,
        date: actualDate,
        vendorId: accrualExpense.vendorId,
        taxSlabId: accrualExpense.taxSlabId,
        bankId,
        paymentStatus,
        paymentDate: paymentStatus === 'Paid' ? new Date(actualDate) : null,
        description: `Accrual Settlement: Actual payment for "${accrualExpense.description}"`,
        amount: String(actualAmount),
        status: 'Active',
        type: 'Actual',
        originAccrualId: accrualExpenseId,
        createdById: req.user.id,
        createdAt: new Date(),
        companyId,
      });

      // 5. Mark Accrual as Settled
      await tx.update(schema.expenses)
        .set({
          accrualSettled: true,
          settledExpenseId: actualExpenseId,
        })
        .where(eq(schema.expenses.id, accrualExpenseId));

      // 6. Update corresponding posting status to 'Accrual Settled'
      await tx.update(schema.recurringPostings)
        .set({ status: 'Accrual Settled' })
        .where(eq(schema.recurringPostings.expenseId, accrualExpenseId));

      // 7. Generate Voucher if Paid
      if (paymentStatus === 'Paid') {
        const vchCount = await getAndIncrementCounter(tx, companyId, 'voucher');
        const voucherNumber = `VCH-${vchCount}`;
        await tx.insert(schema.vouchers).values({
          id: generateId(),
          voucherNumber,
          type: 'Payment',
          date: actualDate,
          bankId,
          amount: String(actualAmount),
          description: `Payment voucher for actual settlement of accrual ${accrualExpense.expenseNumber}`,
          referenceType: 'Expense',
          referenceId: actualExpenseId,
          createdById: req.user.id,
          createdAt: new Date(),
          companyId,
        });
      }
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/interbank-transfer', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'banks.edit')) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { sourceBankId, destBankId, amount, description, dateStr } = req.body;
    const companyId = req.targetCompanyId;

    await db.transaction(async (tx) => {
      // 1. Fetch banks (scoped to the caller's company — a cross-tenant bank id must not resolve)
      const [sourceBank] = await tx.select().from(schema.bankAccounts).where(and(eq(schema.bankAccounts.id, sourceBankId), eq(schema.bankAccounts.isActive, true), eq(schema.bankAccounts.companyId, companyId)));
      const [destBank] = await tx.select().from(schema.bankAccounts).where(and(eq(schema.bankAccounts.id, destBankId), eq(schema.bankAccounts.isActive, true), eq(schema.bankAccounts.companyId, companyId)));

      if (!sourceBank) throw new Error('Active source bank account not found.');
      if (!destBank) throw new Error('Active destination bank account not found.');
      if (sourceBankId === destBankId) throw new Error('Source and destination bank accounts must be different.');
      if (amount <= 0) throw new Error('Transfer amount must be greater than zero.');

      // 2. Validate transaction date
      await validateTransactionDate(dateStr, companyId);

      const transferId = generateId();

      // 3. Create TransferOut Voucher
      const vchCountOut = await getAndIncrementCounter(tx, companyId, 'voucher');
      const voucherNumOut = `VCH-${vchCountOut}`;
      await tx.insert(schema.vouchers).values({
        id: generateId(),
        voucherNumber: voucherNumOut,
        type: 'TransferOut',
        date: dateStr,
        bankId: sourceBankId,
        amount: String(amount),
        description: `Inter-bank Transfer Out to ${destBank.bankName}: ${description || 'Inter-bank fund transfer'}`,
        referenceType: 'Transfer',
        referenceId: transferId,
        createdById: req.user.id,
        createdAt: new Date(),
        companyId,
      });

      // 4. Create TransferIn Voucher
      const vchCountIn = await getAndIncrementCounter(tx, companyId, 'voucher');
      const voucherNumIn = `VCH-${vchCountIn}`;
      await tx.insert(schema.vouchers).values({
        id: generateId(),
        voucherNumber: voucherNumIn,
        type: 'TransferIn',
        date: dateStr,
        bankId: destBankId,
        amount: String(amount),
        description: `Inter-bank Transfer In from ${sourceBank.bankName}: ${description || 'Inter-bank fund transfer'}`,
        referenceType: 'Transfer',
        referenceId: transferId,
        createdById: req.user.id,
        createdAt: new Date(),
        companyId,
      });
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

export default router;
