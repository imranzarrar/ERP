import express from 'express';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, inArray, and, desc, or, isNull } from 'drizzle-orm';
import { validateTransactionDate, syncVoucherForExpense, syncVoucherForInvoice, postCreditNoteReversalVoucher, round2, round4, computePaymentStatus, computeInvoiceServerTotals, deductStockForSale, restockForSaleReversal, assertQuarterNotFiled, resolveSaleWarehouse, assertStockAvailable, assertProductsOwnedByCompany, cancelExpense } from '../lib/businessLogic.js';
import { toBaseQuantity, toBaseUnitCost, loadZatcaCodesByUnitId } from '../lib/uomConversion.js';
import { getAndIncrementDocumentNumber } from '../lib/documentNumbering.js';
import { isStillChainTip, setHashChainState, ZatcaEnvironment } from '../lib/zatca/hashChain.js';
import { normalizePermissions } from '../../src/types.js';
import { processInvoiceZatca } from '../lib/zatca/processInvoice.js';
import { hasPermission, assertOwnsRow, resolveDocumentBranchId, branchAccessOk } from '../lib/authz.js';
import { parseLimitOffset } from '../lib/pagination.js';
import { generateId } from '../../src/id.js';
import { normalizeZatcaUnitCode } from '../../src/zatcaUnitCodes.js';
import { recordAuditLog } from '../lib/audit.js';

const router = express.Router();

// A client-supplied customerId/vendorId/bankId/taxSlabId must actually belong to the
// caller's own company (taxSlabId also allows the global company-agnostic defaults, same
// convention as GET /api/state's own taxSlabs filter) — otherwise a malformed/malicious
// request could attribute a sale to another tenant's customer, post a bill against another
// tenant's vendor, move cash against another tenant's bank account, or embed a foreign
// tax-rate FK into a persisted document. Every document-creation route below was validating
// this for some fields (e.g. salesAssociateId, branchId) but not these — this is the one
// place that check now lives, so every call site gets the same treatment. Pass a Drizzle
// transaction handle when called from inside one so the check sees uncommitted rows too;
// a plain SELECT is fine everywhere else.
async function assertDocumentRefsOwnedByCompany(dbOrTx: any, companyId: string, refs: {
  customerId?: string | null;
  vendorId?: string | null;
  bankId?: string | null;
  taxSlabIds?: (string | null | undefined)[];
}): Promise<string | null> {
  if (refs.customerId) {
    const [row] = await dbOrTx.select({ id: schema.customers.id }).from(schema.customers)
      .where(and(eq(schema.customers.id, refs.customerId), eq(schema.customers.companyId, companyId)));
    if (!row) return 'Selected customer was not found for this company.';
  }
  if (refs.vendorId) {
    const [row] = await dbOrTx.select({ id: schema.vendors.id }).from(schema.vendors)
      .where(and(eq(schema.vendors.id, refs.vendorId), eq(schema.vendors.companyId, companyId)));
    if (!row) return 'Selected vendor was not found for this company.';
  }
  if (refs.bankId) {
    const [row] = await dbOrTx.select({ id: schema.bankAccounts.id }).from(schema.bankAccounts)
      .where(and(eq(schema.bankAccounts.id, refs.bankId), eq(schema.bankAccounts.companyId, companyId)));
    if (!row) return 'Selected bank account was not found for this company.';
  }
  const taxSlabIds = Array.from(new Set((refs.taxSlabIds || []).filter(Boolean))) as string[];
  if (taxSlabIds.length > 0) {
    const rows = await dbOrTx.select({ id: schema.taxSlabs.id }).from(schema.taxSlabs)
      .where(and(inArray(schema.taxSlabs.id, taxSlabIds), or(eq(schema.taxSlabs.companyId, companyId), isNull(schema.taxSlabs.companyId))));
    const foundIds = new Set(rows.map((r: any) => r.id));
    if (taxSlabIds.some(id => !foundIds.has(id))) return 'One or more selected tax slabs were not found for this company.';
  }
  return null;
}

router.get('/quotations', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.quotation.read.enabled) return res.status(403).json({ error: 'Forbidden' });

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
    const { quotationData } = req.body;

    // Upsert route: an `id` naming an existing row is an edit, gated by quotation.update
    // (not quotation.create) — the two are separately grantable, same as every other
    // upsert route in this app (expenses/products/units/customers/vendors). A converted
    // or cancelled quotation is terminal for edits regardless of permission, matching the
    // dedicated PUT /quotations/:id route's own rule.
    let existing: typeof schema.quotations.$inferSelect | undefined;
    if (quotationData.id) {
      [existing] = await db.select().from(schema.quotations).where(eq(schema.quotations.id, quotationData.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this quotation belongs to another company' });
      }
      // This is the main upsert route (also used for edits) — the dedicated PUT/cancel/
      // convert routes for the same table all check branch ownership, this one didn't.
      if (existing && !branchAccessOk(req, existing.branchId)) {
        return res.status(403).json({ error: 'Forbidden: you are not assigned to this branch.' });
      }
    }
    if (existing) {
      if (!permissions.quotation.update.enabled) return res.status(403).json({ error: 'Forbidden' });
      if (existing.status === 'Converted') return res.status(400).json({ error: 'Converted quotations cannot be modified.' });
      if (existing.isCancelled) return res.status(400).json({ error: 'Cancelled quotations cannot be modified.' });
    } else if (!permissions.quotation.create.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    quotationData.companyId = req.targetCompanyId;

    // Branch is immutable after creation — an edit never changes which branch a document
    // was created under (same reasoning bankId already follows). Resolved/validated once
    // here, outside the transaction, so a bad branchId 400/403s before any counter gets
    // reserved.
    let resolvedBranchId: string | null;
    try {
      resolvedBranchId = existing ? existing.branchId : await resolveDocumentBranchId(req, quotationData.branchId);
    } catch (branchErr: any) {
      return res.status(branchErr.status || 400).json({ error: branchErr.error || 'Invalid branch.' });
    }
    quotationData.branchId = resolvedBranchId;

    const { items, ...qData } = quotationData;

    const refError = await assertDocumentRefsOwnedByCompany(db, req.targetCompanyId, {
      customerId: qData.customerId,
      bankId: qData.bankId,
      taxSlabIds: [qData.taxSlabId, ...(items || []).map((it: any) => it.taxSlabId)],
    });
    if (refError) return res.status(400).json({ error: refError });

    let savedQuotationId = '';
    let savedQuotationNumber = '';
    await db.transaction(async (tx) => {
      // 1. Business logic
      const companyId = req.targetCompanyId;
      await validateTransactionDate(qData.date, companyId);
      await assertProductsOwnedByCompany(tx, companyId, (items || []).map((it: any) => it.productId));

      // 2. Increment Counter if new
      let qNumber = qData.quotationNumber;
      if (!qData.quotationNumber) {
        qNumber = await getAndIncrementDocumentNumber(tx, companyId, 'quotation', qData.date, resolvedBranchId);
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
      savedQuotationId = newQuotation.id;
      savedQuotationNumber = newQuotation.quotationNumber;

      // 4. Insert/Update Items
      if (items && items.length > 0) {
        await tx.delete(schema.quotationItems).where(eq(schema.quotationItems.quotationId, newQuotation.id));
        await tx.insert(schema.quotationItems).values(items.map((item: any) => ({
          ...item,
          quotationId: newQuotation.id,
          unitCost: String(round2(Number(item.unitCost))),
          quantity: String(item.quantity),
          discountAmount: item.discountAmount ? String(round2(Number(item.discountAmount))) : '0',
          unit: normalizeZatcaUnitCode(item.unit),
        })));
      }
    });

    recordAuditLog(req, existing ? 'UPDATE_QUOTATION' : 'CREATE_QUOTATION', 'quotation', savedQuotationId, {
      quotationNumber: savedQuotationNumber,
      customerId: qData.customerId,
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.put('/quotations/:id', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.quotation.update.enabled) return res.status(403).json({ error: 'Forbidden' });

    const { id } = req.params;
    const { quotationData } = req.body;
    const { items, ...qData } = quotationData;

    await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(schema.quotations).where(and(eq(schema.quotations.id, id), eq(schema.quotations.companyId, req.targetCompanyId)));
      if (!existing) throw new Error('Quotation not found.');
      if (!branchAccessOk(req, existing.branchId)) { const err: any = new Error('Forbidden: you are not assigned to this branch.'); err.status = 403; throw err; }
      if (existing.status === 'Converted') throw new Error('Converted quotations cannot be modified.');
      if (existing.isCancelled) throw new Error('Cancelled quotations cannot be modified.');

      const companyId = req.targetCompanyId;
      qData.companyId = companyId;
      // Branch is immutable after creation everywhere else in this file (see POST
      // /quotations' own comment) — this dedicated PUT route spreads the client's qData
      // straight into the update set, so pin it back to the existing value rather than
      // letting an edit silently move a quotation to a different branch.
      qData.branchId = existing.branchId;

      if (qData.date) {
        await validateTransactionDate(qData.date, companyId);
      }

      await assertProductsOwnedByCompany(tx, companyId, (items || []).map((it: any) => it.productId));

      const refError = await assertDocumentRefsOwnedByCompany(tx, companyId, {
        customerId: qData.customerId,
        bankId: qData.bankId,
        taxSlabIds: [qData.taxSlabId, ...(items || []).map((it: any) => it.taxSlabId)],
      });
      if (refError) { const err: any = new Error(refError); err.status = 400; throw err; }

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
          discountAmount: item.discountAmount ? String(round2(Number(item.discountAmount))) : '0',
          unit: normalizeZatcaUnitCode(item.unit),
        })));
      }
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Cancel a quotation — sets the dedicated isCancelled flag rather than overloading
// `status` (which stays a pure Draft/Sent/Accepted/Converted phase record). A quotation
// displays as "Cancelled" whenever isCancelled is true, regardless of what phase it was
// in when cancelled. Converted quotations are terminal in the other direction (already
// fulfilled into an invoice) and can't be cancelled from here.
router.post('/quotations/:id/cancel', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.quotation.delete.enabled) return res.status(403).json({ error: 'Forbidden' });

    const { id } = req.params;
    const [existing] = await db.select().from(schema.quotations)
      .where(and(eq(schema.quotations.id, id), eq(schema.quotations.companyId, req.targetCompanyId)));
    if (!existing) return res.status(404).json({ error: 'Quotation not found.' });
    if (!branchAccessOk(req, existing.branchId)) return res.status(403).json({ error: 'Forbidden: you are not assigned to this branch.' });
    if (existing.status === 'Converted') {
      return res.status(400).json({ error: 'Converted quotations cannot be cancelled.' });
    }
    if (existing.isCancelled) {
      return res.status(400).json({ error: 'Quotation is already cancelled.' });
    }

    await db.update(schema.quotations).set({ isCancelled: true }).where(eq(schema.quotations.id, id));
    recordAuditLog(req, 'CANCEL_QUOTATION', 'quotation', id, { quotationNumber: existing.quotationNumber });
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
    // createdById is never taken from the client — every other document-creation route in
    // this file uses req.user.id for exactly this reason (a client-supplied value here
    // would let a caller misattribute the resulting invoice's authorship to an arbitrary
    // user id, including one from a different company). Found by a static isolation check
    // (scripts/check-data-isolation.mjs) after this route had been trusting req.body's own
    // createdById for an unknown amount of time.
    const { invoiceDate, bankId, paymentStatus, customItems, customDiscountPercentage, customTaxSlabId, customCustomerId, customNotes } = req.body;
    const createdById = req.user.id;

    let convertedInvoiceId = '';
    let convertedInvoiceNumber = '';
    let convertedQuotationNumber = '';
    await db.transaction(async (tx) => {
      // 1. Fetch quotation
      const [quotation] = await tx.select().from(schema.quotations).where(and(eq(schema.quotations.id, id), eq(schema.quotations.companyId, req.targetCompanyId)));
      if (!quotation) throw new Error('Quotation not found.');
      if (!branchAccessOk(req, quotation.branchId)) { const err: any = new Error('Forbidden: you are not assigned to this branch.'); err.status = 403; throw err; }
      if (quotation.isCancelled) throw new Error('Cancelled quotations cannot be converted.');
      if (quotation.status !== 'Accepted') throw new Error(`Only accepted quotations can be converted. Current status: ${quotation.status}`);

      const companyId = req.targetCompanyId;
      await validateTransactionDate(invoiceDate, companyId);
      // This creates a brand-new invoice, same as POST /invoices — must be blocked the
      // same way if invoiceDate falls in an already-filed quarter. This route reimplements
      // invoice creation as its own parallel path and had never picked up this check.
      await assertQuarterNotFiled(invoiceDate, companyId);

      const refError = await assertDocumentRefsOwnedByCompany(tx, companyId, {
        customerId: customCustomerId,
        bankId: bankId,
        taxSlabIds: [customTaxSlabId],
      });
      if (refError) { const err: any = new Error(refError); err.status = 400; throw err; }

      // 2. Fetch tax slab for calculations
      const targetTaxSlabId = customTaxSlabId || quotation.taxSlabId;
      const [taxSlab] = await tx.select().from(schema.taxSlabs).where(eq(schema.taxSlabs.id, targetTaxSlabId));
      const percentage = taxSlab ? Number(taxSlab.percentage) : 0;

      // 3. Increment Invoice Counter
      const invNumber = await getAndIncrementDocumentNumber(tx, companyId, 'invoice', invoiceDate, quotation.branchId);
      const invoiceId = generateId();

      // 4. Fetch / calculate Items
      const itemsToInsert = customItems || await tx.select().from(schema.quotationItems).where(eq(schema.quotationItems.quotationId, id));
      // Only customItems needs checking — the fallback (the quotation's own persisted
      // items) was already validated when the quotation itself was created/edited.
      if (customItems) {
        await assertProductsOwnedByCompany(tx, companyId, customItems.map((it: any) => it.productId));
      }

      // Resolve the sales warehouse this new invoice's stock lines will deduct from —
      // required only if the quotation actually carries a stock item, same rule as the
      // direct /invoices route below.
      const resolvedWarehouseId = await resolveSaleWarehouse(tx, companyId, quotation.branchId, itemsToInsert, undefined, req.allowedBranchIds);
      await assertStockAvailable(tx, companyId, resolvedWarehouseId, itemsToInsert.map((it: any) => ({ productId: it.productId, quantity: Number(it.quantity), unitOfMeasureId: it.unitOfMeasureId })));

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
        // Inherited from the source quotation — a converted invoice belongs to whichever
        // branch its quotation was created under, same as every other document type's
        // branch is immutable-from-creation. Pre-existing gap fixed alongside this feature:
        // previously this insert carried no branchId at all.
        branchId: quotation.branchId,
        warehouseId: resolvedWarehouseId,
      }).returning();

      // 6. Insert Items
      const convertZatcaCodeById = await loadZatcaCodesByUnitId(tx, itemsToInsert);
      await tx.insert(schema.invoiceItems).values(itemsToInsert.map((item: any) => ({
        id: generateId(),
        invoiceId: invoiceId,
        description: item.description,
        unitCost: String(round2(Number(item.unitCost))),
        quantity: String(item.quantity),
        discountAmount: item.discountAmount ? String(round2(Number(item.discountAmount))) : '0',
        unit: normalizeZatcaUnitCode(item.unitOfMeasureId ? convertZatcaCodeById.get(item.unitOfMeasureId) : item.unit),
        productId: item.productId || null,
        unitOfMeasureId: item.unitOfMeasureId || null,
      })));

      // Fold each catalog-linked line into the product's weighted-average sale price —
      // this conversion always represents a genuinely new sale (a fresh invoice row, never
      // an edit), so unlike the main /invoices route there's no isNewInvoice branch needed.
      for (const item of itemsToInsert) {
        if (!item.productId) continue;
        const [product] = await tx.select({
          averageSalePrice: schema.productsServices.averageSalePrice,
          totalQuantitySold: schema.productsServices.totalQuantitySold,
        }).from(schema.productsServices).where(eq(schema.productsServices.id, item.productId)).for('update');
        if (product) {
          const priorQty = Number(product.totalQuantitySold || 0);
          const priorAvg = Number(product.averageSalePrice || 0);
          // Converted to base-unit quantity/cost before folding — a carton sold at 120
          // SAR must fold into averageSalePrice at 10 SAR/piece, not 120 SAR/piece.
          const soldQty = await toBaseQuantity(tx, item.productId, item.unitOfMeasureId, companyId, Number(item.quantity));
          const baseUnitCost = await toBaseUnitCost(tx, item.productId, item.unitOfMeasureId, companyId, Number(item.unitCost));
          const newQty = priorQty + soldQty;
          const newAvg = newQty > 0 ? round4((priorQty * priorAvg + soldQty * baseUnitCost) / newQty) : priorAvg;
          await tx.update(schema.productsServices)
            .set({ averageSalePrice: String(newAvg), totalQuantitySold: String(round2(newQty)) })
            .where(eq(schema.productsServices.id, item.productId));
        }
        await deductStockForSale(tx, companyId, item.productId, Number(item.quantity), invoiceId, newInvoice.createdAt as Date, resolvedWarehouseId, item.unitOfMeasureId);
      }

      // 7. Update Quotation Status
      await tx.update(schema.quotations).set({ status: 'Converted' }).where(eq(schema.quotations.id, id));
      convertedInvoiceId = invoiceId;
      convertedInvoiceNumber = invNumber;
      convertedQuotationNumber = quotation.quotationNumber;

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
          branchId: quotation.branchId,
        }, req.user.id);
      }
    });

    recordAuditLog(req, 'CONVERT_QUOTATION', 'quotation', id, {
      quotationNumber: convertedQuotationNumber,
      convertedToInvoiceId: convertedInvoiceId,
      convertedToInvoiceNumber: convertedInvoiceNumber,
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
    if (!permissions.invoice.read.enabled) return res.status(403).json({ error: 'Forbidden' });

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

// Real server-side PDF (see server/lib/pdfGenerator.ts for the "why") — replaces the
// previous client-side html2canvas rasterization. Same read permission/company-scoping
// as GET /invoices above; the actual rendering happens via a headless browser hitting
// this same server's own /print/invoice/:id route, authenticated by reusing this
// request's own already-valid session id (req.sessionID), not a new token mechanism.
router.get('/invoices/:id/pdf', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.invoice.read.enabled) return res.status(403).json({ error: 'Forbidden' });

    const { id } = req.params;
    const [invoice] = await db.select({ id: schema.invoices.id, invoiceNumber: schema.invoices.invoiceNumber })
      .from(schema.invoices).where(and(eq(schema.invoices.id, id), eq(schema.invoices.companyId, req.targetCompanyId)));
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const { renderInvoicePdf } = await import('../lib/pdfGenerator.js');
    const pdfBuffer = await renderInvoicePdf(id, req.activeSessionId);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${invoice.invoiceNumber}.pdf"`);
    res.send(pdfBuffer);
  } catch (error: any) {
    console.error('[PDF Export] Failed:', error);
    res.status(500).json({ error: error.message || 'Failed to generate PDF.' });
  }
});

router.post('/invoices', async (req: any, res) => {
  try {
    const user = req.user;
    const permissions = normalizePermissions(user.permissions, user.role, user.isSuperAdmin);

    const { invoiceData } = req.body;
    const { items, ...invData } = invoiceData;

    let existingInvoice: typeof schema.invoices.$inferSelect | undefined;
    if (invData.id) {
      [existingInvoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invData.id));
      if (!assertOwnsRow(existingInvoice, req)) {
        return res.status(403).json({ error: 'Forbidden: this invoice belongs to another company' });
      }
      // This is the main upsert route (also used for edits) — the dedicated /note, /paid,
      // and /cancel routes for the same table all check branch ownership, this one didn't.
      if (existingInvoice && !branchAccessOk(req, existingInvoice.branchId)) {
        return res.status(403).json({ error: 'Forbidden: you are not assigned to this branch.' });
      }
      // Regulatory rule, not a permission check: once ZATCA has a submission in flight
      // or cleared/reported an invoice, its content is immutable — no role or permission
      // can override this. Applies regardless of `invoice.create`/`invoice.update` above.
      if (existingInvoice && ['SUBMITTING', 'CLEARED', 'REPORTED'].includes(existingInvoice.zatcaStatus as string)) {
        return res.status(400).json({ error: 'This invoice has already been submitted to ZATCA and can no longer be edited. Issue a Credit Note instead.' });
      }
    }
    // Upsert route: an existing row is an edit, gated by invoice.update (not
    // invoice.create) — same split every other upsert route in this app already applies
    // (quotations just above, expenses). This route previously gated the whole thing on
    // invoice.create alone, so a create-only role (create:true, update:false) could edit
    // any existing invoice through this same endpoint.
    if (existingInvoice) {
      if (!permissions.invoice.update.enabled) return res.status(403).json({ error: 'Forbidden' });
    } else if (!permissions.invoice.create.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    invData.companyId = req.targetCompanyId;

    // Mirrors the client-side checks in InvoiceModule.tsx's handleSaveInvoice — enforced
    // here too since the client check alone is bypassable by a direct API call. An
    // invoice needs at least one real line item, and a line's sales price (unitCost)
    // must be a real, positive charge that survives its own discount — a discount that
    // wipes out (or exceeds) the sales price makes the line a giveaway, not a sale.
    // Deliberately placed AFTER the ownership/branch/ZATCA-immutability checks above —
    // a forbidden cross-company request must always 403 regardless of what nonsense
    // payload accompanies it, never 400 first (confirmed live: this exact ordering bug
    // broke tests/crossCompanyIsolation.test.ts's hijack-attempt test, which intentionally
    // sends an empty items array).
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'An invoice must have at least one line item.' });
    }
    for (const item of items) {
      const unitCost = Number(item.unitCost) || 0;
      const discountAmount = Number(item.discountAmount) || 0;
      if (unitCost <= 0) {
        return res.status(400).json({ error: `"${item.description}": Sales price must be greater than 0.` });
      }
      if (unitCost - discountAmount <= 0) {
        return res.status(400).json({ error: `"${item.description}": Discount cannot reduce the sales price to zero or below.` });
      }
    }

    // Branch is immutable after creation, same reasoning/pattern as the Quotation route
    // just above — resolved/validated before the transaction so an invalid branch 400/
    // 403s before the ICV/counter reservation.
    try {
      invData.branchId = existingInvoice ? existingInvoice.branchId : await resolveDocumentBranchId(req, invData.branchId);
    } catch (branchErr: any) {
      return res.status(branchErr.status || 400).json({ error: branchErr.error || 'Invalid branch.' });
    }

    // Sales Associate — purely an attribution field (e.g. for a sales-bonus calculation
    // elsewhere), optional forever, immutable after creation same as branchId above. Only
    // validated (belongs to this company, active) when actually set — never required.
    if (existingInvoice) {
      invData.salesAssociateId = existingInvoice.salesAssociateId;
    } else if (invData.salesAssociateId) {
      const [employee] = await db.select().from(schema.employees)
        .where(and(eq(schema.employees.id, invData.salesAssociateId), eq(schema.employees.companyId, invData.companyId)));
      if (!employee) {
        return res.status(404).json({ error: 'Selected sales associate not found for this company.' });
      }
      if (employee.isActive === false) {
        return res.status(400).json({ error: `Employee "${employee.name}" (#${employee.employeeNumber}) is deactivated and cannot be selected as sales associate.` });
      }
    }

    const refError = await assertDocumentRefsOwnedByCompany(db, invData.companyId, {
      customerId: invData.customerId,
      bankId: invData.bankId,
      taxSlabIds: [invData.taxSlabId, ...(items || []).map((it: any) => it.taxSlabId)],
    });
    if (refError) return res.status(400).json({ error: refError });
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
      await assertQuarterNotFiled(invData.date, companyId);
      await assertProductsOwnedByCompany(tx, companyId, (items || []).map((it: any) => it.productId));

      // 2. Increment Counter if new
      if (isNewInvoice) {
        invData.invoiceNumber = await getAndIncrementDocumentNumber(tx, companyId, 'invoice', invData.date, invData.branchId);
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

      const { grandTotal } = computeInvoiceServerTotals(items || [], headerPercentage, Number(invData.discountPercentage || 0), lineSlabPercentageById);
      if (grandTotal <= 0) {
        const err: any = new Error('The invoice net total must be greater than 0.');
        err.status = 400;
        throw err;
      }

      invData.paymentStatus = computePaymentStatus(Number(invData.amountPaid || 0), grandTotal);
      invData.amountPaid = String(round2(Number(invData.amountPaid || 0)));

      // Warehouse is resolved/validated once at creation and then immutable, same pattern
      // as branchId above — an edit keeps whatever warehouse the original sale deducted
      // stock from (deduction itself is only ever applied on true new-invoice creation,
      // see the isNewInvoice branch below, so there is nothing to re-resolve on an edit).
      invData.warehouseId = existingInvoice
        ? existingInvoice.warehouseId
        : await resolveSaleWarehouse(tx, companyId, invData.branchId, items || [], invData.warehouseId, req.allowedBranchIds);
      if (isNewInvoice) {
        await assertStockAvailable(tx, companyId, invData.warehouseId, (items || []).map((it: any) => ({ productId: it.productId, quantity: Number(it.quantity), unitOfMeasureId: it.unitOfMeasureId })));
      }

      // 3. Insert/Update Invoice
      // createdAt/paymentDate are `timestamp` (Date-mode) columns — the driver serializes
      // every bound parameter for the whole statement up front (Postgres, not drizzle,
      // decides at execute time whether the INSERT or the ON CONFLICT...SET branch actually
      // applies), so the SET clause's values need the same Date conversion as VALUES, not
      // the raw invData (which still has string dates straight from the request body).
      // Passing the raw string there broke every invoice creation carrying a paymentDate
      // (e.g. any invoice saved as Paid) with a raw driver error: "value.toISOString is
      // not a function" — reproduced live against the "UX test company" invoice-create flow.
      const invoiceValues = {
        ...invData,
        createdAt: invData.createdAt ? new Date(invData.createdAt) : new Date(),
        paymentDate: invData.paymentDate ? new Date(invData.paymentDate) : null,
      };
      const [newInvoice] = await tx.insert(schema.invoices).values(invoiceValues).onConflictDoUpdate({
        target: schema.invoices.id,
        set: invoiceValues
      }).returning();
      
      savedInvoiceId = newInvoice.id;

      // 4. Insert/Update Items
      if (items && items.length > 0) {
        const invoiceZatcaCodeById = await loadZatcaCodesByUnitId(tx, items);
        for (const item of items) {
          // Same object used for both branches (values and set) — see invoiceValues
          // above for why: Postgres serializes both branches' parameters up front
          // regardless of which one actually executes, so a raw/unvalidated value in
          // either one reaches the driver either way.
          const itemValues = {
            ...item,
            invoiceId: newInvoice.id,
            unitCost: String(round2(Number(item.unitCost))),
            quantity: String(item.quantity),
            discountAmount: item.discountAmount ? String(round2(Number(item.discountAmount))) : '0',
            unit: normalizeZatcaUnitCode(item.unitOfMeasureId ? invoiceZatcaCodeById.get(item.unitOfMeasureId) : item.unit),
            unitOfMeasureId: item.unitOfMeasureId || null,
          };
          await tx.insert(schema.invoiceItems).values(itemValues).onConflictDoUpdate({
            target: schema.invoiceItems.id,
            set: itemValues
          });

          // Fold into the product's weighted-average sale price — only on true new-invoice
          // creation (not an edit of an existing one, and not a Credit/Debit Note, which
          // goes through the separate /invoices/:id/note route below and deliberately
          // doesn't touch this average — same forward-only philosophy as GRN reversal not
          // unwinding averageCost). Only lines actually picked from the catalog carry a
          // productId; a free-typed line simply doesn't contribute.
          if (isNewInvoice && item.productId) {
            const [product] = await tx.select({
              averageSalePrice: schema.productsServices.averageSalePrice,
              totalQuantitySold: schema.productsServices.totalQuantitySold,
            }).from(schema.productsServices).where(eq(schema.productsServices.id, item.productId)).for('update');
            if (product) {
              const priorQty = Number(product.totalQuantitySold || 0);
              const priorAvg = Number(product.averageSalePrice || 0);
              const soldQty = await toBaseQuantity(tx, item.productId, item.unitOfMeasureId, companyId, Number(item.quantity));
              const baseUnitCost = await toBaseUnitCost(tx, item.productId, item.unitOfMeasureId, companyId, Number(item.unitCost));
              const newQty = priorQty + soldQty;
              const newAvg = newQty > 0 ? round4((priorQty * priorAvg + soldQty * baseUnitCost) / newQty) : priorAvg;
              await tx.update(schema.productsServices)
                .set({ averageSalePrice: String(newAvg), totalQuantitySold: String(round2(newQty)) })
                .where(eq(schema.productsServices.id, item.productId));
            }
            await deductStockForSale(tx, companyId, item.productId, Number(item.quantity), newInvoice.id, invoiceValues.createdAt as Date, invData.warehouseId, item.unitOfMeasureId);
          }
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

    recordAuditLog(req, isNewInvoice ? 'CREATE_INVOICE' : 'UPDATE_INVOICE', 'invoice', savedInvoiceId, {
      invoiceNumber: invData.invoiceNumber,
      documentType: invData.documentType,
      customerId: invData.customerId,
    });
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
    if (!branchAccessOk(req, original.branchId)) return res.status(403).json({ error: 'Forbidden: you are not assigned to this branch.' });

    // A cancelled invoice never charged the customer (or, if it had already reached
    // ZATCA, cancellation itself would have been refused above the /cancel route's own
    // zatcaStatus guard) — there is nothing left to reverse. Without this check, a
    // Credit Note against an already-cancelled invoice double-restocks inventory: the
    // /cancel route's own restockForSaleReversal call already returned these units to
    // stock, and this route's identical call below would return them a second time.
    if (original.status === 'Cancelled') {
      return res.status(400).json({ error: 'Cannot issue a Credit Note against a cancelled invoice.' });
    }

    // A Credit Note here is a full-document reversal (MVP scope, see the file comment
    // above) — a second one against the same original would credit the customer twice for
    // one sale. Debit Notes are deliberately not blocked here: they represent genuine new
    // additional charges, not a reversal, so more than one against the same invoice isn't
    // inherently wrong the way a duplicate Credit Note is.
    if (type === 'CreditNote') {
      const [existingCreditNote] = await db.select().from(schema.invoices)
        .where(and(
          eq(schema.invoices.originalInvoiceId, originalInvoiceId),
          eq(schema.invoices.documentType, 'CreditNote'),
          eq(schema.invoices.companyId, companyId)
        ));
      if (existingCreditNote) {
        return res.status(400).json({ error: `A Credit Note (${existingCreditNote.invoiceNumber}) has already been issued for this invoice.` });
      }
    }

    const originalItems = await db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, originalInvoiceId));
    if (originalItems.length === 0) {
      return res.status(400).json({ error: 'Original invoice has no line items to reference' });
    }

    let savedNoteId = '';
    let savedNoteNumber = '';
    await db.transaction(async (tx) => {
      await validateTransactionDate(original.date, companyId);
      await assertQuarterNotFiled(original.date, companyId);

      const counterType = type === 'CreditNote' ? 'creditNote' : 'debitNote';
      const noteNumber = await getAndIncrementDocumentNumber(tx, companyId, counterType, original.date, original.branchId);
      savedNoteNumber = noteNumber;
      const noteId = generateId();

      const [newNote] = await tx.insert(schema.invoices).values({
        id: noteId,
        invoiceNumber: noteNumber,
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
        // Always inherited from the original, never independently picked — a reversal's
        // ZATCA seller address must match the document it's reversing, and the branch
        // itself is not something a Credit/Debit Note has its own concept of.
        branchId: original.branchId,
        // Same inheritance reasoning as branchId — for display/reporting only today,
        // since a Credit/Debit Note doesn't restock inventory at all (a pre-existing,
        // separate gap: deductStockForSale is never called from this route).
        warehouseId: original.warehouseId,
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
          // A Credit/Debit Note must reverse the original invoice's units exactly — a
          // line originally sold in KGM being reversed as PCE would misrepresent what's
          // actually being credited/debited.
          unit: item.unit,
          // Carried through for display/reporting only — deliberately does NOT fold back
          // into averageSalePrice. Same forward-only philosophy as GRN reversal not
          // unwinding averageCost: a moving weighted average can't be precisely reversed
          // without replaying full history, so credits/debits are excluded from the
          // average rather than approximated.
          productId: item.productId,
          unitOfMeasureId: item.unitOfMeasureId,
        });

        // Restock — a Credit Note structurally reverses the original sale, so any stock
        // deducted at the time should come back. Debit Notes represent new, additional
        // unpaid charges rather than a reversal (see the comment on the voucher-reversal
        // call below), so they deliberately never restock. Uses the original invoice's own
        // warehouseId (already inherited onto the note itself, see `warehouseId` above) —
        // the same warehouse the stock was actually deducted from at sale time, not the
        // note's own (nonexistent) concept of a warehouse.
        if (type === 'CreditNote' && item.productId) {
          await restockForSaleReversal(tx, companyId, item.productId, Number(item.quantity), newNote.id, new Date(), original.warehouseId, item.unitOfMeasureId);
        }
      }

      // A Credit Note structurally reverses the original invoice — if any of it was
      // actually paid, reverse that receipt too. Unlike Cancel, the original invoice's own
      // status/paymentStatus is deliberately left untouched (see the note above this
      // route), so the money-out side must be recorded as a genuine Reversal voucher
      // rather than deleted — see postCreditNoteReversalVoucher's own comment for why
      // reusing syncVoucherForInvoice's Cancel-branch here silently erased the Bank
      // Statement Ledger's record of the original receipt. Debit Notes represent new
      // unpaid charges, not a reversal, so they never reach here.
      if (type === 'CreditNote' && Number(original.amountPaid) > 0) {
        await postCreditNoteReversalVoucher(tx, originalInvoiceId, companyId, original.date, user.id);
      }
    });

    if (savedNoteId) {
      processInvoiceZatca(savedNoteId).catch(err => {
        console.error('[Auto ZATCA Error - Credit/Debit Note]:', err);
      });
    }

    recordAuditLog(req, type === 'CreditNote' ? 'CREATE_CREDIT_NOTE' : 'CREATE_DEBIT_NOTE', 'invoice', savedNoteId, {
      invoiceNumber: savedNoteNumber,
      originalInvoiceId,
      originalInvoiceNumber: original.invoiceNumber,
      reason: reason || '',
    });
    res.json({ success: true, noteId: savedNoteId });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Accepts an optional partial `amount` in the body. Omitting it (or any caller that
// predates this — every existing test call included, since none of them relied on this
// being ignored, only on the end result of "fully paid") keeps behaving exactly as
// before: settle the full remaining balance. Passing `amount` settles only that much,
// leaving the invoice 'Partially Paid' if a balance remains.
//
// Deliberately NOT built on syncVoucherForInvoice — that helper upserts exactly one
// Receipt voucher per invoice (by referenceType+referenceId+type), which is correct for
// "this invoice's payment status changed" everywhere else it's used (cancellation
// reversal, credit notes) but wrong here: a second partial payment must post a *second*,
// separate voucher, not silently overwrite the amount on the first one. Every partial
// settlement gets its own real voucher row, matching src/dbStore.ts's markInvoicePaid
// (the legacy path this route replaces) so migrating InvoiceModule.tsx's "Receive
// Payment" modal onto this route doesn't change what a customer's payment history shows.
router.post('/invoices/:id/paid', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.invoice.update.enabled) return res.status(403).json({ error: 'Forbidden' });

    const { id } = req.params;
    const requestedAmount = req.body?.amount !== undefined ? Number(req.body.amount) : undefined;
    if (requestedAmount !== undefined && (!Number.isFinite(requestedAmount) || requestedAmount <= 0)) {
      return res.status(400).json({ error: 'Payment amount must be greater than zero.' });
    }

    let createdVoucher: any;
    let paidInvoiceNumber = '';
    await db.transaction(async (tx) => {
      // FOR UPDATE — without this, two payments landing close together (e.g. cash recorded
      // by a cashier immediately followed by a bank transfer entered by an accountant) both
      // read the same currentPaid/remaining and the second write silently clobbers the
      // first's amountPaid, even though both Receipt vouchers were correctly inserted —
      // the invoice's own denormalized amountPaid/paymentStatus would then understate what
      // was actually collected. Purchase Bills' own /pay route already locks this way.
      const [invoice] = await tx.select().from(schema.invoices).where(and(eq(schema.invoices.id, id), eq(schema.invoices.companyId, req.targetCompanyId))).for('update');
      if (!invoice) throw new Error('Invoice not found');
      if (!branchAccessOk(req, invoice.branchId)) { const err: any = new Error('Forbidden: you are not assigned to this branch.'); err.status = 403; throw err; }
      if (invoice.status === 'Cancelled') {
        const err: any = new Error('Cancelled invoices cannot be paid.');
        err.status = 400;
        throw err;
      }
      if (invoice.paymentStatus === 'Paid') {
        const err: any = new Error('Invoice is already fully paid.');
        err.status = 400;
        throw err;
      }
      // A Credit Note reduces what the customer owes on the original invoice — it is not
      // itself a receivable, so it can never be "paid". (A Debit Note, by contrast,
      // represents genuine additional charges and is legitimately payable — this check is
      // deliberately scoped to CreditNote only.)
      if (invoice.documentType === 'CreditNote') {
        const err: any = new Error('A Credit Note cannot be paid — it reduces the original invoice\'s balance, it does not create one of its own.');
        err.status = 400;
        throw err;
      }

      const paymentDate = req.body?.paymentDate ? String(req.body.paymentDate) : new Date().toISOString().split('T')[0];
      // Throws (with .status set) rather than returning a validity object — propagates
      // straight up through this transaction callback to the outer catch below.
      await validateTransactionDate(paymentDate, invoice.companyId);

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

      const currentPaid = round2(Number(invoice.amountPaid || 0));
      const remaining = round2(grandTotal - currentPaid);
      if (remaining <= 0) {
        const err: any = new Error('No remaining balance to pay.');
        err.status = 400;
        throw err;
      }

      let amountToPost = remaining;
      if (requestedAmount !== undefined) {
        if (requestedAmount > remaining + 0.01) {
          const err: any = new Error(`Payment amount (${requestedAmount}) exceeds the remaining balance (${remaining}).`);
          err.status = 400;
          throw err;
        }
        amountToPost = Math.min(requestedAmount, remaining);
      }

      const newPaidAmount = round2(currentPaid + amountToPost);
      const newPaymentStatus = computePaymentStatus(newPaidAmount, grandTotal);
      const targetBankId = req.body?.bankId || invoice.bankId;
      // A client-supplied bankId must actually belong to this company — otherwise a
      // malformed/malicious request could post a receipt (and misattribute real cash)
      // against another tenant's bank account.
      if (req.body?.bankId) {
        const [bank] = await tx.select({ id: schema.bankAccounts.id }).from(schema.bankAccounts)
          .where(and(eq(schema.bankAccounts.id, targetBankId), eq(schema.bankAccounts.companyId, invoice.companyId)));
        if (!bank) {
          const err: any = new Error('Selected bank account was not found for this company.');
          err.status = 400;
          throw err;
        }
      }

      // The invoice's own bankId is the bank it was issued expecting payment to (shown on
      // the printed document) — it must stay stable across however many separate,
      // possibly different-bank installments actually settle it. Each installment's real
      // bank is recorded on its own Receipt voucher below, not on the invoice row.
      await tx.update(schema.invoices)
        .set({
          paymentStatus: newPaymentStatus,
          amountPaid: String(newPaidAmount),
          paymentDate: new Date(paymentDate),
        })
        .where(eq(schema.invoices.id, id));

      const voucherNumber = await getAndIncrementDocumentNumber(tx, invoice.companyId, 'voucher', paymentDate, invoice.branchId);
      const [voucher] = await tx.insert(schema.vouchers).values({
        id: generateId(),
        voucherNumber,
        type: 'Receipt',
        date: paymentDate,
        bankId: targetBankId,
        amount: String(amountToPost),
        description: `Receipt voucher generated for invoice ${invoice.invoiceNumber} payment of ${amountToPost}`,
        referenceType: 'Invoice',
        referenceId: id,
        companyId: invoice.companyId,
        // Always the invoice's own branch, never independently picked — see
        // schema.ts's vouchers.branchId comment.
        branchId: invoice.branchId,
        createdById: req.user.id,
        createdAt: new Date(),
      }).returning();
      createdVoucher = voucher;
      paidInvoiceNumber = invoice.invoiceNumber;
    });

    recordAuditLog(req, 'RECORD_INVOICE_PAYMENT', 'invoice', id, {
      invoiceNumber: paidInvoiceNumber,
      voucherNumber: createdVoucher?.voucherNumber,
      amount: createdVoucher?.amount,
    });
    // Returned so the client can immediately open a printable payment receipt — see
    // DocumentRenderer.tsx's renderVoucher, the same one ReportViewer.tsx's voucher
    // register already prints from.
    res.json({ success: true, voucher: createdVoucher });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/invoices/:id/cancel', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.invoice.delete.enabled) return res.status(403).json({ error: 'Forbidden' });

    const { id } = req.params;
    let cancelledInvoiceNumber = '';
    let cancelledDocType = '';
    await db.transaction(async (tx) => {
      // FOR UPDATE — processInvoiceZatca's fire-and-forget SUBMITTING transition (see
      // processInvoice.ts) runs as a plain UPDATE, which itself takes an implicit
      // Postgres row lock for its duration; locking the row here too means this read
      // genuinely waits out any in-flight submission instead of racing a stale copy of
      // zatcaStatus, whichever of the two happens to reach the row first.
      const [invoice] = await tx.select().from(schema.invoices).where(and(eq(schema.invoices.id, id), eq(schema.invoices.companyId, req.targetCompanyId))).for('update');
      if (!invoice) throw new Error('Invoice not found');
      if (!branchAccessOk(req, invoice.branchId)) { const err: any = new Error('Forbidden: you are not assigned to this branch.'); err.status = 403; throw err; }

      // A cancel is an edit to this invoice's status — it must be blocked exactly like a
      // real edit once the invoice's own quarter has been filed with ZATCA, or a filed
      // return's reported sales/VAT figures could silently go stale (cancelling drops it
      // out of every report's totals — see SalesReportsModule.tsx). POST /invoices and
      // /invoices/:id/note already enforce this; this route never did.
      await assertQuarterNotFiled(invoice.date, req.targetCompanyId);

      if (['SUBMITTING', 'CLEARED', 'REPORTED'].includes(invoice.zatcaStatus as string)) {
        const err: any = new Error('This invoice has already been submitted to ZATCA and cannot be cancelled. Issue a Credit Note instead.');
        err.status = 400;
        throw err;
      }

      await tx.update(schema.invoices).set({ status: 'Cancelled' }).where(eq(schema.invoices.id, id));

      // Restock — a pre-existing gap: this route never touched inventoryStocks at all, so
      // cancelling a sale never gave the stock back. Scoped to plain Invoices only — a
      // Credit Note already restocks at its own creation (see the CreditNote branch
      // above), so cancelling a Credit Note through this same generic route is a separate,
      // not-yet-handled edge case (would need to re-deduct, the opposite direction) rather
      // than something this fix should guess at; a Debit Note was never a stock reversal
      // to begin with.
      if (invoice.documentType !== 'CreditNote' && invoice.documentType !== 'DebitNote') {
        const cancelledItems = await tx.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, id));
        for (const item of cancelledItems) {
          if (!item.productId) continue;
          await restockForSaleReversal(tx, invoice.companyId, item.productId, Number(item.quantity), id, new Date(), invoice.warehouseId, item.unitOfMeasureId);
        }
      }

      // This invoice may already have reserved a real ZATCA chain position (icv/
      // previousInvoiceHash) even though it's being cancelled here — processInvoiceZatca
      // runs fire-and-forget immediately at creation, well before a user has a realistic
      // window to cancel. The guard above already guarantees zatcaStatus can only be
      // NOT_SUBMITTED/ERROR/REJECTED/DISABLED at this point (never SUBMITTING/CLEARED/
      // REPORTED), so only the never-reached-ZATCA case is even reachable here — but it
      // still needs isStillChainTip to be true, or something else has already chained off
      // this invoice's hash and the position is permanently structural regardless of
      // cancellation (same conservative rule as processInvoiceZatca's resubmission logic;
      // see hashChain.ts). When both hold, roll the chain tip back to what it was before
      // this invoice claimed it, so the next real invoice legitimately gets this ICV back
      // instead of it being wasted forever.
      if (invoice.icv) {
        const neverReachedZatca = invoice.zatcaStatus === 'NOT_SUBMITTED'
          && Array.isArray(invoice.zatcaValidationResults)
          && (invoice.zatcaValidationResults as any[]).some((r: any) => r?.code === 'ONBOARDING_INCOMPLETE');

        if (neverReachedZatca) {
          // Same company-row lock processInvoiceZatca holds for the duration of any
          // zatcaChainState read/write — without it, this rollback could race a concurrent
          // reservation for a different invoice of the same company.
          const [company] = await tx.select({ zatcaEnvironment: schema.companies.zatcaEnvironment })
            .from(schema.companies).where(eq(schema.companies.id, invoice.companyId)).for('update');
          const environment = (company?.zatcaEnvironment as ZatcaEnvironment) || 'sandbox';

          if (await isStillChainTip(invoice.companyId, environment, invoice.icv, tx)) {
            await setHashChainState(invoice.companyId, environment, invoice.icv - 1, invoice.previousInvoiceHash, tx);
          }
        }
      }

      await syncVoucherForInvoice(tx, id, invoice.companyId, {
        ...invoice,
        status: 'Cancelled',
      }, req.user.id);

      cancelledInvoiceNumber = invoice.invoiceNumber;
      cancelledDocType = invoice.documentType;
    });

    recordAuditLog(req, 'CANCEL_INVOICE', 'invoice', id, {
      invoiceNumber: cancelledInvoiceNumber,
      documentType: cancelledDocType,
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

    // Unlike every other upsert route in this app, this one had no ownership check at
    // all before the update branch of onConflictDoUpdate could fire — investors.id is a
    // client-supplied primary key with no server-side default, so a Company B caller
    // could target Company A's real investor id and have its name/equity/capital fields
    // (and companyId itself) silently overwritten. Same assertOwnsRow + generateId
    // pattern as every other upsert route in this file.
    let existing: typeof schema.investors.$inferSelect | undefined;
    if (iData.id) {
      [existing] = await db.select().from(schema.investors).where(eq(schema.investors.id, iData.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this investor belongs to another company' });
      }
    } else {
      iData.id = generateId();
    }

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

// Records a capital contribution against an existing investor — ports saveCapitalInvestment
// from src/dbStore.ts faithfully (same validation order, same voucher shape). Creates a
// Receipt voucher (referenceType 'Equity') and bumps the investor's running
// capitalContributed total.
router.post('/investors/:id/investment', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'investors.access')) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { id: investorId } = req.params;
    const { bankId, amount, date, description } = req.body;
    const companyId = req.targetCompanyId;
    const amountNum = Number(amount);

    await db.transaction(async (tx) => {
      const [investor] = await tx.select().from(schema.investors)
        .where(and(eq(schema.investors.id, investorId), eq(schema.investors.companyId, companyId)));
      if (!investor) throw new Error('Selected investor not found.');

      await validateTransactionDate(date, companyId);

      if (!(amountNum > 0)) {
        const err: any = new Error('Investment amount must be greater than zero.');
        err.status = 400;
        throw err;
      }

      const [bank] = await tx.select().from(schema.bankAccounts)
        .where(and(eq(schema.bankAccounts.id, bankId), eq(schema.bankAccounts.isActive, true), eq(schema.bankAccounts.companyId, companyId)));
      if (!bank) throw new Error('Active bank account not found.');

      const voucherNumber = await getAndIncrementDocumentNumber(tx, companyId, 'voucher', date, null);

      await tx.insert(schema.vouchers).values({
        id: generateId(),
        voucherNumber,
        type: 'Receipt',
        date,
        bankId,
        amount: String(amountNum),
        description: `Equity Capital contribution from investor ${investor.name}: ${description}`,
        referenceType: 'Equity',
        referenceId: investorId,
        createdById: req.user.id,
        createdAt: new Date(),
        companyId,
      });

      await tx.update(schema.investors)
        .set({ capitalContributed: String(round2(Number(investor.capitalContributed || 0) + amountNum)) })
        .where(eq(schema.investors.id, investorId));
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
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

// Multiple fiscal months may be open concurrently per company, but:
//   1. At most MAX_OPEN_FISCAL_MONTHS may be open at once.
//   2. Only the chronologically oldest currently-open month may be closed at any time.
// This is the real enforcement boundary — client-side checks in src/dbStore.ts exist only for
// fast UX feedback and are bypassable by any direct API call (see BACKLOG.md items 21 and 35).
const MAX_OPEN_FISCAL_MONTHS = 3;

router.post('/months', async (req: any, res) => {
  try {
    const data = req.body;
    const mData = { ...data };
    mData.companyId = req.targetCompanyId;

    // Normalize status to Title Case
    if (typeof mData.status === 'string') {
      const lower = mData.status.toLowerCase();
      if (lower === 'open') mData.status = 'Open';
      else if (lower === 'closed') mData.status = 'Closed';
    }

    // Open and Close are separately-grantable authorities (see permissionSchema.ts) -
    // check the one that matches what's actually being requested, not a shared flag.
    const requiredLeaf = mData.status === 'Closed' ? 'fiscalMonths.close' : 'fiscalMonths.open';
    if (!hasPermission(req.user, requiredLeaf)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (mData.closedAt) mData.closedAt = new Date(mData.closedAt);

    // Fetch all fiscal months for this company to evaluate the cap / close-ordering rules
    // against the actual persisted state, not whatever the client's in-memory copy claims.
    const existingMonthsForCompany = await db.select()
      .from(schema.fiscalMonths)
      .where(eq(schema.fiscalMonths.companyId, mData.companyId));
    const existingRow = existingMonthsForCompany.find(m => m.id === mData.id);
    const currentlyOpen = existingMonthsForCompany
      .filter(m => m.status?.toLowerCase() === 'open')
      .sort((a, b) => a.id.localeCompare(b.id));

    if (mData.status === 'Open') {
      // Opening a month that isn't already open (a fresh insert, or re-opening — the app
      // doesn't normally do the latter, but guard the cap regardless of how we got here).
      const alreadyOpen = existingRow?.status?.toLowerCase() === 'open';
      if (!alreadyOpen) {
        const openExcludingThis = currentlyOpen.filter(m => m.id !== mData.id);
        if (openExcludingThis.length >= MAX_OPEN_FISCAL_MONTHS) {
          const openList = openExcludingThis.map(m => `${m.name} (${m.id})`).join(', ');
          return res.status(400).json({
            error: `Cannot open a new fiscal month — the maximum of ${MAX_OPEN_FISCAL_MONTHS} concurrently open months has been reached (${openList}). Close the oldest open month first.`
          });
        }
      }
    }

    if (mData.status === 'Closed') {
      // Can only close a month that is actually currently open.
      if (!existingRow || existingRow.status?.toLowerCase() !== 'open') {
        return res.status(400).json({
          error: `Cannot close fiscal month ${mData.id} — it is not currently open.`
        });
      }

      // Oldest-first: this must be the chronologically oldest currently-open month.
      const oldestOpen = currentlyOpen[0];
      if (oldestOpen && oldestOpen.id !== mData.id) {
        return res.status(400).json({
          error: `Cannot close ${existingRow.name} (${existingRow.id}) yet — the oldest open month, ${oldestOpen.name} (${oldestOpen.id}), must be closed first.`
        });
      }

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

    // entityId stays null deliberately — fiscalMonths.id is a text value like "2026-09",
    // not a UUID, and auditLogs.entity_id is a uuid column; passing it through silently
    // failed every insert here for as long as this route has existed. The real month id
    // goes in details instead, where it's still fully searchable.
    recordAuditLog(req, mData.status === 'Closed' ? 'CLOSE_FISCAL_MONTH' : 'OPEN_FISCAL_MONTH', 'fiscal_month', null, {
      monthId: mData.id,
      monthName: mData.name,
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

    const refError = await assertDocumentRefsOwnedByCompany(db, companyId, { bankId });
    if (refError) return res.status(400).json({ error: refError });

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

      const expNumber = await getAndIncrementDocumentNumber(tx, companyId, 'expense', dateStr, null);
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
        const voucherNumber = await getAndIncrementDocumentNumber(tx, companyId, 'voucher', dateStr, null);
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

    const refError = await assertDocumentRefsOwnedByCompany(db, companyId, { bankId });
    if (refError) return res.status(400).json({ error: refError });

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
      const expNumber = await getAndIncrementDocumentNumber(tx, companyId, 'expense', actualDate, null);
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
        const voucherNumber = await getAndIncrementDocumentNumber(tx, companyId, 'voucher', actualDate, null);
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

// --- Recurring Expense Templates (CRUD) — ports src/dbStore.ts's in-memory template
// management from RecurringExpenses.tsx onto real per-record routes, sibling to the
// recurring-postings/settle-accrual routes above which already own this domain. ---
router.post('/recurring-templates', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.expense.create.enabled) return res.status(403).json({ error: 'Forbidden' });

    const { description, defaultAmount, bankId, vendorId, taxSlabId, isActive } = req.body;
    const amountNum = Number(defaultAmount);
    if (!description || isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: 'Please enter a valid amount.' });
    }
    const companyId = req.targetCompanyId;

    const refError = await assertDocumentRefsOwnedByCompany(db, companyId, { bankId, vendorId, taxSlabIds: [taxSlabId] });
    if (refError) return res.status(400).json({ error: refError });

    const id = generateId();

    await db.insert(schema.recurringExpenseTemplates).values({
      id,
      description,
      defaultAmount: String(round2(amountNum)),
      bankId,
      vendorId,
      taxSlabId,
      isActive: isActive !== false,
      companyId,
    });

    recordAuditLog(req, 'CREATE_RECURRING_TEMPLATE', 'recurring_expense_template', id, { description, defaultAmount: String(round2(amountNum)) });
    res.json({ success: true, id });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.put('/recurring-templates/:id', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.expense.update.enabled) return res.status(403).json({ error: 'Forbidden' });

    const { id } = req.params;
    const { description, defaultAmount, bankId, vendorId, taxSlabId, isActive } = req.body;
    const amountNum = Number(defaultAmount);
    if (!description || isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: 'Please enter a valid amount.' });
    }
    const companyId = req.targetCompanyId;

    const [existing] = await db.select().from(schema.recurringExpenseTemplates)
      .where(and(eq(schema.recurringExpenseTemplates.id, id), eq(schema.recurringExpenseTemplates.companyId, companyId)));
    if (!existing) return res.status(404).json({ error: 'Recurring template not found.' });

    const refError = await assertDocumentRefsOwnedByCompany(db, companyId, { bankId, vendorId, taxSlabIds: [taxSlabId] });
    if (refError) return res.status(400).json({ error: refError });

    await db.update(schema.recurringExpenseTemplates).set({
      description,
      defaultAmount: String(round2(amountNum)),
      bankId,
      vendorId,
      taxSlabId,
      isActive: isActive !== false,
    }).where(eq(schema.recurringExpenseTemplates.id, id));

    recordAuditLog(req, 'UPDATE_RECURRING_TEMPLATE', 'recurring_expense_template', id, { description, defaultAmount: String(round2(amountNum)) });
    res.json({ success: true });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.patch('/recurring-templates/:id/toggle', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.expense.delete.enabled) return res.status(403).json({ error: 'Forbidden' });

    const { id } = req.params;
    const companyId = req.targetCompanyId;

    const [existing] = await db.select().from(schema.recurringExpenseTemplates)
      .where(and(eq(schema.recurringExpenseTemplates.id, id), eq(schema.recurringExpenseTemplates.companyId, companyId)));
    if (!existing) return res.status(404).json({ error: 'Recurring template not found.' });

    const newActive = !existing.isActive;
    await db.update(schema.recurringExpenseTemplates).set({ isActive: newActive }).where(eq(schema.recurringExpenseTemplates.id, id));

    recordAuditLog(req, newActive ? 'ACTIVATE_RECURRING_TEMPLATE' : 'DEACTIVATE_RECURRING_TEMPLATE', 'recurring_expense_template', id, { description: existing.description });
    res.json({ success: true, isActive: newActive });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.delete('/recurring-templates/:id', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.expense.delete.enabled) return res.status(403).json({ error: 'Forbidden' });

    const { id } = req.params;
    const companyId = req.targetCompanyId;

    const [existing] = await db.select().from(schema.recurringExpenseTemplates)
      .where(and(eq(schema.recurringExpenseTemplates.id, id), eq(schema.recurringExpenseTemplates.companyId, companyId)));
    if (!existing) return res.status(404).json({ error: 'Recurring template not found.' });

    // Soft-delete only — same mechanism as the sibling /toggle route just above, forced to
    // false rather than flipped (a delete-intent should deactivate, never reactivate).
    // Previously this hard-deleted the row, which both destroyed the template's own
    // history and hit recurringPostings.templateId's FK constraint the moment any posting
    // had ever been generated from it; deactivating instead has neither problem and keeps
    // every past posting's reference intact.
    await db.update(schema.recurringExpenseTemplates).set({ isActive: false }).where(eq(schema.recurringExpenseTemplates.id, id));

    recordAuditLog(req, 'DEACTIVATE_RECURRING_TEMPLATE', 'recurring_expense_template', id, { description: existing.description });
    res.json({ success: true });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// --- Accrual entry management (edit / delete) — ports src/dbStore.ts's in-memory
// handleSaveAccrual/handleDeleteAccrual from RecurringExpenses.tsx. ---
router.put('/accruals/:id', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.expense.update.enabled) return res.status(403).json({ error: 'Forbidden' });

    const { id } = req.params;
    const { description, amount, vendorId, bankId, date, taxSlabId } = req.body;
    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) return res.status(400).json({ error: 'Please enter a valid amount.' });

    const companyId = req.targetCompanyId;
    const [existing] = await db.select().from(schema.expenses)
      .where(and(eq(schema.expenses.id, id), eq(schema.expenses.companyId, companyId)));
    if (!existing) return res.status(404).json({ error: 'Accrual entry not found.' });

    const refError = await assertDocumentRefsOwnedByCompany(db, companyId, { bankId, vendorId, taxSlabIds: [taxSlabId] });
    if (refError) return res.status(400).json({ error: refError });

    await db.update(schema.expenses).set({
      description,
      amount: String(round2(amountNum)),
      vendorId,
      bankId,
      date,
      taxSlabId,
    }).where(eq(schema.expenses.id, id));

    recordAuditLog(req, 'UPDATE_ACCRUAL', 'expense', id, { expenseNumber: existing.expenseNumber, amount: String(round2(amountNum)) });
    res.json({ success: true });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.delete('/accruals/:id', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.expense.delete.enabled) return res.status(403).json({ error: 'Forbidden' });

    const { id } = req.params;
    const companyId = req.targetCompanyId;

    let cancelledAccrualNumber = '';
    await db.transaction(async (tx) => {
      // Soft-cancel, not a real delete — reuses the exact same logic POST
      // /expenses/:id/cancel already applies to every other expense (status:'Cancelled',
      // requires an open fiscal month, unlinks the accrual<->settlement pointers, posts a
      // Reversal voucher if one was ever paid). The expense row and its line items are
      // left in place, same as every other cancelled document in this app keeps its own
      // content. Only the linked recurringPostings join row is still removed — it's a
      // workflow marker, not a financial document, and removing it frees that template's
      // month slot to be posted again (recurringPostings has a unique
      // (templateId, monthId, companyId) constraint).
      await tx.delete(schema.recurringPostings).where(eq(schema.recurringPostings.expenseId, id));
      cancelledAccrualNumber = (await cancelExpense(tx, req, id, companyId)).expenseNumber;
    });

    recordAuditLog(req, 'CANCEL_ACCRUAL', 'expense', id, { expenseNumber: cancelledAccrualNumber });
    res.json({ success: true });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/interbank-transfer', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'banks.transfer')) {
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
      const voucherNumOut = await getAndIncrementDocumentNumber(tx, companyId, 'voucher', dateStr, null);
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
      const voucherNumIn = await getAndIncrementDocumentNumber(tx, companyId, 'voucher', dateStr, null);
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
