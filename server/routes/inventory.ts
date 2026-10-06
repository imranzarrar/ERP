import express from 'express';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and, isNull, inArray, ne } from 'drizzle-orm';
import { round2, round4, writeStockLedgerEntry, assertQuarterNotFiled, assertQuarterNotFrozen, assertProductsOwnedByCompany, validateTransactionDate } from '../lib/businessLogic.js';
import { postJournalEntry, reverseAllEntriesFor, postInventoryAdjustment, postInventoryRevaluation, totalOnHand, snapshotInventory, settleInventoryValuation } from '../lib/ledger.js';
import { createPurchaseBillForGrns, payPurchaseBillInFull, normalizePurchaseBillForClient } from '../lib/purchasing.js';
import { getAndIncrementDocumentNumber } from '../lib/documentNumbering.js';
import { computeVendorCreditBalance } from '../lib/financialReports.js';
import { hasPermission, resolveDocumentBranchId, branchAccessOk, branchAccessOkViaWarehouse } from '../lib/authz.js';
import { toBaseQuantity, toBaseUnitCost } from '../lib/uomConversion.js';
import { generateId } from '../../src/id.js';
import { withTenantDb, tenantDb } from '../lib/tenantDb.js';
import { nowDate } from '../lib/clock.js';

const router = express.Router();

// Purchase Requisitions, Purchase Orders and Goods Receipt Notes previously had their
// "next number" derived client-side from `array.length + 1001` (see InventoryModule.tsx
// history) — reproducibly duplicated under concurrent creation, the same class of bug
// already fixed for invoice/quotation/expense/voucher numbering. These routes reuse the
// same `getAndIncrementDocumentNumber` (atomic upsert, company-wide, per-company-
// configurable) mechanism so PR/PO/GRN numbering is safe under real concurrency too.

// --- Purchase Requisitions ---
router.post('/purchase-requisitions', withTenantDb, async (req: any, res) => {
  try {
    const tdb = tenantDb();
    if (!hasPermission(req.user, 'inventory.pr')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { prData } = req.body || {};
    if (!prData || !Array.isArray(prData.items) || prData.items.length === 0) {
      return res.status(400).json({ error: 'At least one requested item is required.' });
    }
    const companyId = req.targetCompanyId;
    let branchId: string | null;
    try {
      branchId = await resolveDocumentBranchId(req, prData.branchId);
    } catch (branchErr: any) {
      return res.status(branchErr.status || 400).json({ error: branchErr.error || 'Invalid branch.' });
    }

    // No separate db.transaction() wrapper — withTenantDb already wraps the whole
    // request in one transaction.
    await assertProductsOwnedByCompany(tdb, companyId, prData.items.map((it: any) => it.productId));
    const todayIso = nowDate().toISOString().slice(0, 10);
    const prNumber = await getAndIncrementDocumentNumber(tdb, companyId, 'pr', todayIso, branchId);
    const prId = generateId();

    const [newPr] = await tdb.insert(schema.purchaseRequisitions).values({
      id: prId,
      prNumber,
      requestedBy: prData.requestedBy,
      date: nowDate(),
      status: 'Pending',
      notes: prData.notes || null,
      companyId,
      branchId,
    }).returning();

    const itemRows = prData.items.map((item: any) => ({
      id: generateId(),
      requisitionId: prId,
      productId: item.productId,
      quantity: String(item.quantity),
      purpose: item.purpose || null,
    }));
    const insertedItems = await tdb.insert(schema.purchaseRequisitionItems).values(itemRows).returning();

    const created = { ...newPr, items: insertedItems };

    res.json({ success: true, purchaseRequisition: created });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Edit a Pending PR's items/notes — the submitter-tier action (inventory.pr), not gated by
// inventory.approve since editing your own not-yet-approved request isn't an approval
// action. Only a 'Pending' PR may be edited.
router.put('/purchase-requisitions/:id', withTenantDb, async (req: any, res) => {
  try {
    const tdb = tenantDb();
    if (!hasPermission(req.user, 'inventory.pr')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const { prData } = req.body || {};
    if (!prData || !Array.isArray(prData.items) || prData.items.length === 0) {
      return res.status(400).json({ error: 'At least one requested item is required.' });
    }
    const companyId = req.targetCompanyId;

    // No separate db.transaction() wrapper — withTenantDb already wraps the whole
    // request in one transaction; the row lock below still applies within it.
    const [pr] = await tdb.select().from(schema.purchaseRequisitions)
      .where(and(eq(schema.purchaseRequisitions.id, id), eq(schema.purchaseRequisitions.companyId, companyId)))
      .for('update');
    if (!pr) {
      const err: any = new Error('Purchase requisition not found.');
      err.status = 404;
      throw err;
    }
    if (!branchAccessOk(req, pr.branchId)) {
      const err: any = new Error('Forbidden: you are not assigned to this branch.');
      err.status = 403;
      throw err;
    }
    if (pr.status !== 'Pending') {
      const err: any = new Error(`Cannot edit a requisition that is not Pending (current status: ${pr.status}).`);
      err.status = 400;
      throw err;
    }
    await assertProductsOwnedByCompany(tdb, companyId, prData.items.map((it: any) => it.productId));

    const [newPr] = await tdb.update(schema.purchaseRequisitions)
      .set({ notes: prData.notes !== undefined ? prData.notes : pr.notes })
      .where(eq(schema.purchaseRequisitions.id, id))
      .returning();

    await tdb.delete(schema.purchaseRequisitionItems).where(eq(schema.purchaseRequisitionItems.requisitionId, id));
    const itemRows = prData.items.map((item: any) => ({
      id: generateId(),
      requisitionId: id,
      productId: item.productId,
      quantity: String(item.quantity),
      purpose: item.purpose || null,
    }));
    const insertedItems = await tdb.insert(schema.purchaseRequisitionItems).values(itemRows).returning();

    const updated = { ...newPr, items: insertedItems };

    res.json({ success: true, purchaseRequisition: updated });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Withdraw a Pending PR — the submitter's own action (inventory.pr), separate from
// approve/reject (inventory.approve): pulling back your own not-yet-actioned request isn't
// an approval authority. Only a 'Pending' PR may be withdrawn.
router.patch('/purchase-requisitions/:id/withdraw', withTenantDb, async (req: any, res) => {
  try {
    const tdb = tenantDb();
    if (!hasPermission(req.user, 'inventory.pr')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const companyId = req.targetCompanyId;

    // No separate db.transaction() wrapper — withTenantDb already wraps the whole
    // request in one transaction; the row lock below still applies within it.
    const [pr] = await tdb.select().from(schema.purchaseRequisitions)
      .where(and(eq(schema.purchaseRequisitions.id, id), eq(schema.purchaseRequisitions.companyId, companyId)))
      .for('update');
    if (!pr) {
      const err: any = new Error('Purchase requisition not found.');
      err.status = 404;
      throw err;
    }
    if (!branchAccessOk(req, pr.branchId)) {
      const err: any = new Error('Forbidden: you are not assigned to this branch.');
      err.status = 403;
      throw err;
    }
    if (pr.status !== 'Pending') {
      const err: any = new Error(`Cannot withdraw a requisition that is not Pending (current status: ${pr.status}).`);
      err.status = 400;
      throw err;
    }
    const [updated] = await tdb.update(schema.purchaseRequisitions)
      .set({ status: 'Cancelled' })
      .where(eq(schema.purchaseRequisitions.id, id))
      .returning();

    res.json({ success: true, purchaseRequisition: updated });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// --- Purchase Orders ---
router.post('/purchase-orders', withTenantDb, async (req: any, res) => {
  try {
    const tdb = tenantDb();
    if (!hasPermission(req.user, 'inventory.po')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { poData } = req.body || {};
    if (!poData || !poData.vendorId || !Array.isArray(poData.items) || poData.items.length === 0) {
      return res.status(400).json({ error: 'A vendor and at least one item are required.' });
    }
    const companyId = req.targetCompanyId;

    const [company] = await tdb.select({ inventorySettings: schema.companies.inventorySettings })
      .from(schema.companies).where(eq(schema.companies.id, companyId));
    const prOptionality = (company?.inventorySettings as any)?.prOptionality || 'OPTIONAL';
    if (prOptionality === 'MANDATORY' && !poData.requisitionId) {
      return res.status(400).json({ error: 'This company requires an approved purchase requisition before a purchase order can be raised.' });
    }

    const totalAmount = poData.items.reduce((sum: number, item: any) => {
      const lineTotal = Number(item.quantityOrdered) * Number(item.unitPrice);
      const tax = lineTotal * (Number(item.taxRate || 0) / 100);
      return sum + lineTotal + tax;
    }, 0);

    // If this PO is raised from a PR and no branch was explicitly requested, inherit the
    // PR's own branch (same reasoning a Credit Note inherits its original invoice's) —
    // otherwise resolve/validate independently, same choke-point as every other route.
    let poBranchId: string | null;
    try {
      let requestedBranchId = poData.branchId;
      if (!requestedBranchId && poData.requisitionId) {
        const [linkedPr] = await tdb.select({ branchId: schema.purchaseRequisitions.branchId }).from(schema.purchaseRequisitions)
          .where(and(eq(schema.purchaseRequisitions.id, poData.requisitionId), eq(schema.purchaseRequisitions.companyId, companyId)));
        requestedBranchId = linkedPr?.branchId || undefined;
      }
      poBranchId = await resolveDocumentBranchId(req, requestedBranchId);
    } catch (branchErr: any) {
      return res.status(branchErr.status || 400).json({ error: branchErr.error || 'Invalid branch.' });
    }

    // No separate db.transaction() wrapper — withTenantDb already wraps the whole
    // request in one transaction; the row lock below still applies within it.
    // If a requisition is referenced (regardless of prOptionality — a stale/rejected/
    // already-closed PR is never a valid source, in any mode), row-lock and validate it
    // before using it, same pattern as the GRN route's purchase-order lock below.
    if (poData.requisitionId) {
      const [pr] = await tdb.select().from(schema.purchaseRequisitions)
        .where(and(eq(schema.purchaseRequisitions.id, poData.requisitionId), eq(schema.purchaseRequisitions.companyId, companyId)))
        .for('update');
      if (!pr) {
        const err: any = new Error('Linked purchase requisition not found.');
        err.status = 404;
        throw err;
      }
      if (pr.status !== 'Approved') {
        const err: any = new Error(`Cannot raise a purchase order from a requisition that is not Approved (current status: ${pr.status}).`);
        err.status = 400;
        throw err;
      }
    }

    // vendorId/productId were previously only checked for truthiness, never that they
    // belong to this company — same class of gap found and fixed across every other
    // creation route in this pass.
    const [vendor] = await tdb.select({ id: schema.vendors.id }).from(schema.vendors)
      .where(and(eq(schema.vendors.id, poData.vendorId), eq(schema.vendors.companyId, companyId)));
    if (!vendor) {
      const err: any = new Error('Selected vendor not found for this company.');
      err.status = 400;
      throw err;
    }
    await assertProductsOwnedByCompany(tdb, companyId, poData.items.map((it: any) => it.productId));

    const poNumber = await getAndIncrementDocumentNumber(tdb, companyId, 'po', nowDate().toISOString().slice(0, 10), poBranchId);
    const poId = generateId();

    const [newPo] = await tdb.insert(schema.purchaseOrders).values({
      id: poId,
      poNumber,
      vendorId: poData.vendorId,
      date: nowDate(),
      status: 'Sent',
      requisitionId: poData.requisitionId || null,
      deliveryDate: poData.deliveryDate ? new Date(poData.deliveryDate) : null,
      totalAmount: String(round2(totalAmount)),
      companyId,
      branchId: poBranchId,
    }).returning();

    const itemRows = poData.items.map((item: any) => ({
      id: generateId(),
      purchaseOrderId: poId,
      productId: item.productId,
      quantityOrdered: String(item.quantityOrdered),
      unitPrice: String(item.unitPrice),
      taxRate: String(item.taxRate || 0),
      unitOfMeasureId: item.unitOfMeasureId || null,
    }));
    const insertedItems = await tdb.insert(schema.purchaseOrderItems).values(itemRows).returning();

    // Close the source PR (if any) within the same transaction so a PR never stays
    // "Approved" after it's already been actioned into a PO.
    if (poData.requisitionId) {
      await tdb.update(schema.purchaseRequisitions)
        .set({ status: 'Closed' })
        .where(and(
          eq(schema.purchaseRequisitions.id, poData.requisitionId),
          eq(schema.purchaseRequisitions.companyId, companyId)
        ));
    }

    const created = { ...newPo, items: insertedItems };

    res.json({ success: true, purchaseOrder: created });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// --- Goods Receipt Notes ---
router.post('/goods-receipt-notes', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'inventory.grn')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { grnData } = req.body || {};
    if (!grnData || !grnData.warehouseId || !Array.isArray(grnData.items) || grnData.items.length === 0) {
      return res.status(400).json({ error: 'A warehouse and at least one received item are required.' });
    }
    if (!grnData.isDsd && !grnData.purchaseOrderId) {
      return res.status(400).json({ error: 'A purchase order must be selected for a PO-linked receipt.' });
    }
    if (grnData.isDsd && !grnData.vendorId) {
      return res.status(400).json({ error: 'A vendor must be selected for a direct shop delivery.' });
    }
    // "Vendor paid in full at delivery" — the common SME case where a small vendor hands
    // over their bill and is paid cash on the spot. Both fields are mandatory only for
    // this path (a manually-created Bill can add its own Vendor Bill # later, and never
    // has to be paid immediately at all) — enforced here, before any DB work, same as
    // every other up-front validation in this route.
    if (grnData.autoPostBillPaid) {
      if (!hasPermission(req.user, 'purchaseBills.create')) {
        return res.status(403).json({ error: 'Forbidden: you do not have permission to create purchase bills.' });
      }
      if (!String(grnData.vendorBillNumber || '').trim()) {
        return res.status(400).json({ error: 'Vendor Bill # is required to auto-post a paid bill.' });
      }
      if (!grnData.billBankId) {
        return res.status(400).json({ error: 'A bank/cash account is required to auto-post a paid bill.' });
      }
    }
    const companyId = req.targetCompanyId;
    const tdb = tenantDb();

    if (grnData.isDsd) {
      const [company] = await tdb.select({ inventorySettings: schema.companies.inventorySettings })
        .from(schema.companies).where(eq(schema.companies.id, companyId));
      const isDsdAllowed = (company?.inventorySettings as any)?.isDsdAllowed ?? true;
      if (!isDsdAllowed) {
        return res.status(400).json({ error: 'Direct Shop Delivery is disabled for this company. Enable it in Company Setup, or link this receipt to a purchase order instead.' });
      }
    }

    let updatedPurchaseOrder: { id: string; status: string } | null = null;
    // Accumulated inside the items loop below, for item.itemKind==='item' lines only —
    // Row 8's ledger posting (Dr Inventory / Cr GR/IR Clearing), the same tax-exclusive
    // qty × unitCost value the averageCost fold already uses, so the ledger and the
    // product's own weighted-average agree on what this receipt was actually worth.
    let grnInventoryValue = 0;
    const grnRevaluations: Array<{ productId: string; before: { qty: number; avg: number }; after: { qty: number; avg: number }; posted: number }> = [];

    // No separate db.transaction() wrapper — withTenantDb already wraps the whole
    // request in one transaction; every row lock below still applies within it.
    let vendorId = grnData.vendorId;
    let linkedPo: any = null;

    if (!grnData.isDsd && grnData.purchaseOrderId) {
      // Row-lock the PO for the duration of this transaction: two GRNs racing against
      // the same PO must never both read "Sent"/"Partially Received" and both compute
      // themselves as the one that completes it.
      const [po] = await tdb.select().from(schema.purchaseOrders)
        .where(and(eq(schema.purchaseOrders.id, grnData.purchaseOrderId), eq(schema.purchaseOrders.companyId, companyId)))
        .for('update');
      if (!po) {
        const err: any = new Error('Linked purchase order not found.');
        err.status = 404;
        throw err;
      }
      linkedPo = po;
      vendorId = po.vendorId;
    } else if (grnData.isDsd) {
      // Non-DSD path inherits vendorId from an already company-checked PO above — DSD
      // takes it straight from the client and it was never validated at all.
      const [vendor] = await tdb.select({ id: schema.vendors.id }).from(schema.vendors)
        .where(and(eq(schema.vendors.id, vendorId), eq(schema.vendors.companyId, companyId)));
      if (!vendor) {
        const err: any = new Error('Selected vendor not found for this company.');
        err.status = 400;
        throw err;
      }
    }
    await assertProductsOwnedByCompany(tdb, companyId, grnData.items.map((it: any) => it.productId));

    // goodsReceiptNotes has no branchId column of its own (schema.ts) — derived via
    // warehouseId purely so includeBranchCode can format correctly if ever configured,
    // same lookup pattern as server.ts's branchOkViaWarehouse read-path predicate. Also
    // the ONLY place grnData.warehouseId is ever checked at all — previously unscoped
    // by companyId entirely (a real cross-tenant gap: a crafted request could receive
    // stock into another company's warehouse, with the resulting inventoryStocks/
    // stockLedgerTransactions rows filed under THIS caller's companyId, corrupting both
    // tenants' inventory records) and never checked against req.allowedBranchIds either.
    const [grnWarehouse] = await tdb.select({ branchId: schema.warehouses.branchId }).from(schema.warehouses)
      .where(and(eq(schema.warehouses.id, grnData.warehouseId), eq(schema.warehouses.companyId, companyId)));
    if (!grnWarehouse) {
      const err: any = new Error('Selected warehouse not found for this company.');
      err.status = 400;
      throw err;
    }
    if (!branchAccessOk(req, grnWarehouse.branchId)) {
      const err: any = new Error('Forbidden: you are not assigned to this branch.');
      err.status = 403;
      throw err;
    }
    const grnNumber = await getAndIncrementDocumentNumber(tdb, companyId, 'grn', nowDate().toISOString().slice(0, 10), grnWarehouse?.branchId || null);
    const grnId = generateId();

    const [newGrn] = await tdb.insert(schema.goodsReceiptNotes).values({
      id: grnId,
      grnNumber,
      purchaseOrderId: grnData.isDsd ? null : (grnData.purchaseOrderId || null),
      vendorId,
      warehouseId: grnData.warehouseId,
      date: nowDate(),
      isDsd: !!grnData.isDsd,
      receivedBy: grnData.receivedBy,
      notes: grnData.notes || null,
      companyId,
    }).returning();

    const itemRows = grnData.items.map((item: any) => ({
      id: generateId(),
      grnId,
      productId: item.productId,
      quantityReceived: String(item.quantityReceived),
      unitCost: String(item.unitCost),
      taxRate: item.taxRate !== undefined ? String(item.taxRate) : '0.00',
      batchNumber: item.batchNumber || null,
      expiryDate: item.expiryDate ? new Date(item.expiryDate) : null,
      unitOfMeasureId: item.unitOfMeasureId || null,
    }));
    const insertedItems = await tdb.insert(schema.goodsReceiptNoteItems).values(itemRows).returning();

    // Update stock levels — lock each matching stock row before incrementing so two
    // concurrent GRNs touching the same product/warehouse/batch never lose an update
    // (read-then-write without a lock would let both read the same starting quantity).
    // `quantityReceived`/`unitCost` on the item itself stay exactly as entered (whatever
    // unit the line used, for billing/display); every inventory-quantity and averaging
    // calculation below uses the base-unit-converted values instead.
    for (const item of grnData.items) {
      // Item-picker filtering (client) already restricts GRN lines to itemKind==='item'
      // — this is defense-in-depth against a direct API call. A service line skips both
      // the inventoryStocks write and the average-cost fold below entirely (a service
      // has no physical stock or purchase-cost-averaging concept), same no-op-not-error
      // convention as deductStockForSale.
      const [product] = await tdb.select({
        itemKind: schema.productsServices.itemKind,
        averageCost: schema.productsServices.averageCost,
        totalQuantityPurchased: schema.productsServices.totalQuantityPurchased,
      }).from(schema.productsServices).where(eq(schema.productsServices.id, item.productId)).for('update');
      if (!product || product.itemKind !== 'item') continue;

      const baseQtyReceived = await toBaseQuantity(tdb, item.productId, item.unitOfMeasureId, companyId, Number(item.quantityReceived));
      const baseUnitCost = await toBaseUnitCost(tdb, item.productId, item.unitOfMeasureId, companyId, Number(item.unitCost));
      const qtyOnHandBefore = await totalOnHand(tdb, companyId, item.productId);

      const batchCondition = item.batchNumber
        ? eq(schema.inventoryStocks.batchNumber, item.batchNumber)
        : isNull(schema.inventoryStocks.batchNumber);

      const [existingStock] = await tdb.select().from(schema.inventoryStocks)
        .where(and(
          eq(schema.inventoryStocks.productId, item.productId),
          eq(schema.inventoryStocks.warehouseId, grnData.warehouseId),
          eq(schema.inventoryStocks.companyId, companyId),
          batchCondition
        ))
        .for('update');

      const grnEndingQty = existingStock
        ? round2(Number(existingStock.quantity) + baseQtyReceived)
        : round2(baseQtyReceived);

      if (existingStock) {
        await tdb.update(schema.inventoryStocks)
          .set({ quantity: String(grnEndingQty) })
          .where(eq(schema.inventoryStocks.id, existingStock.id));
      } else {
        await tdb.insert(schema.inventoryStocks).values({
          id: generateId(),
          productId: item.productId,
          warehouseId: grnData.warehouseId,
          batchNumber: item.batchNumber || null,
          expiryDate: item.expiryDate ? new Date(item.expiryDate) : null,
          quantity: String(baseQtyReceived),
          companyId,
        });
      }
      await writeStockLedgerEntry(tdb, {
        productId: item.productId, warehouseId: grnData.warehouseId, companyId,
        transactionType: 'GRN', referenceId: grnId, date: newGrn.date as Date,
        quantityChange: baseQtyReceived, endingQuantity: grnEndingQty,
        batchNumber: item.batchNumber || null,
      });

      // Fold this receipt into the product's weighted-average cost. Uses
      // totalQuantityPurchased (not current on-hand quantity) as the weight so the
      // average is unaffected by sales/adjustments that have drawn stock down since
      // earlier receipts — a pure moving-average-cost calculation, forward-only.
      const priorQty = Number(product.totalQuantityPurchased || 0);
      const priorAvg = Number(product.averageCost || 0);
      const newQty = priorQty + baseQtyReceived;
      const newAvg = newQty > 0 ? round4((priorQty * priorAvg + baseQtyReceived * baseUnitCost) / newQty) : priorAvg;
      await tdb.update(schema.productsServices)
        .set({ averageCost: String(newAvg), totalQuantityPurchased: String(round2(newQty)) })
        .where(eq(schema.productsServices.id, item.productId));

      grnInventoryValue = round2(grnInventoryValue + round2(baseQtyReceived * baseUnitCost));
      grnRevaluations.push({
        productId: item.productId,
        before: { qty: qtyOnHandBefore, avg: priorAvg },
        after: { qty: round2(qtyOnHandBefore + baseQtyReceived), avg: newAvg },
        posted: round2(baseQtyReceived * baseUnitCost),
      });
    }

    // Determine the linked PO's fulfillment status from actual received-vs-ordered
    // quantities (summed across every GRN ever raised against it, including the one
    // just inserted above, since we're still inside the same transaction) instead of
    // unconditionally flipping it to "Received" the moment any GRN references it.
    if (linkedPo) {
      const poItems = await tdb.select().from(schema.purchaseOrderItems)
        .where(eq(schema.purchaseOrderItems.purchaseOrderId, linkedPo.id));

      const priorGrnItems = await tdb.select({
        productId: schema.goodsReceiptNoteItems.productId,
        quantityReceived: schema.goodsReceiptNoteItems.quantityReceived,
        unitOfMeasureId: schema.goodsReceiptNoteItems.unitOfMeasureId,
      })
        .from(schema.goodsReceiptNoteItems)
        .innerJoin(schema.goodsReceiptNotes, eq(schema.goodsReceiptNoteItems.grnId, schema.goodsReceiptNotes.id))
        .where(and(eq(schema.goodsReceiptNotes.purchaseOrderId, linkedPo.id), eq(schema.goodsReceiptNotes.isReversed, false)));

      // Ordered vs. received is compared in base-unit terms throughout — a PO line and
      // its fulfilling GRN line(s) need not share the same unit (e.g. ordered in
      // Cartons, received partly loose), so both sides are converted before comparing.
      const receivedByProduct = new Map<string, number>();
      for (const row of priorGrnItems) {
        const baseQty = await toBaseQuantity(tdb, row.productId, row.unitOfMeasureId, companyId, Number(row.quantityReceived));
        receivedByProduct.set(row.productId, (receivedByProduct.get(row.productId) || 0) + baseQty);
      }

      let fullyReceived = poItems.length > 0;
      let anyReceived = false;
      for (const poItem of poItems) {
        const received = receivedByProduct.get(poItem.productId) || 0;
        const orderedBaseQty = await toBaseQuantity(tdb, poItem.productId, poItem.unitOfMeasureId, companyId, Number(poItem.quantityOrdered));
        if (received > 0) anyReceived = true;
        if (received < orderedBaseQty) fullyReceived = false;
      }

      const newStatus = fullyReceived ? 'Received' : (anyReceived ? 'Partially Received' : linkedPo.status);
      if (newStatus !== linkedPo.status) {
        await tdb.update(schema.purchaseOrders).set({ status: newStatus }).where(eq(schema.purchaseOrders.id, linkedPo.id));
      }
      updatedPurchaseOrder = { id: linkedPo.id, status: newStatus };
    }

    // Phase 3 ledger posting (row 8) — Dr Inventory / Cr GR/IR Clearing, tax-exclusive.
    // Skipped entirely when every line was a service (grnInventoryValue stays 0) — a
    // service line never touches inventoryStocks either, same no-op convention.
    if (grnInventoryValue > 0) {
      await postJournalEntry(tdb, {
        companyId,
        branchId: grnWarehouse?.branchId || null,
        date: (newGrn.date as Date).toISOString().slice(0, 10),
        referenceType: 'Grn',
        referenceId: grnId,
        description: `Goods receipt ${grnNumber} received`,
        createdById: req.user.id,
        lines: [
          { accountKey: 'INVENTORY', debit: grnInventoryValue },
          { accountKey: 'GR_IR_CLEARING', credit: grnInventoryValue },
        ],
      });
      // Units sold before they were received carried cost 0; stock arriving at a new average cost revalues what was already on hand.
      // Whatever the receipt itself did not post is booked here, so Inventory = quantity x average cost (see postInventoryRevaluation).
      for (const rv of grnRevaluations) {
        await postInventoryRevaluation(tdb, {
          companyId, branchId: grnWarehouse?.branchId || null, date: nowDate().toISOString().slice(0, 10), productId: rv.productId,
          before: rv.before, after: rv.after, postedChange: rv.posted,
          referenceType: 'Grn', referenceId: grnId, description: `Inventory revaluation on receipt ${grnNumber}`, createdById: req.user.id,
        });
      }
    }

    // GRN "auto-post Bill, paid at delivery" — same shared functions the standalone
    // POST /purchase-bills and POST /purchase-bills/:id/pay routes use (createPurchaseBillForGrns
    // / payPurchaseBillInFull), so there is exactly one place rows 9 and 10 are ever
    // posted from. Runs inside this same transaction: if either step fails, the GRN
    // itself (and its row-8 posting above) rolls back too, rather than leaving a
    // received-but-half-billed receipt behind.
    let autoPostedBill: any = null;
    if (grnData.autoPostBillPaid) {
      const bill = await createPurchaseBillForGrns(tdb, {
        companyId,
        grnIds: [grnId],
        branchId: grnWarehouse?.branchId || null,
        bankId: grnData.billBankId,
        dueDate: null,
        vendorBillNumber: grnData.vendorBillNumber,
        date: nowDate().toISOString().slice(0, 10),
        userId: req.user.id,
      });
      const { bill: paidBill } = await payPurchaseBillInFull(tdb, {
        companyId,
        billId: bill.id,
        date: nowDate().toISOString().slice(0, 10),
        bankId: grnData.billBankId,
        userId: req.user.id,
      });
      autoPostedBill = paidBill;
    }

    const created = { ...newGrn, items: insertedItems };

    res.json({ success: true, goodsReceiptNote: created, updatedPurchaseOrder, purchaseBill: autoPostedBill });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Reverse a GRN — the correction path for a wrong-quantity/wrong-batch receipt. Reverts
// the stock movement (allowed to go negative — a receipt that's already been partly
// consumed by a sale legitimately reverses below 0 rather than silently losing the real
// deficit, same reasoning as deductStockForSale in businessLogic.ts), and recomputes the
// linked PO's fulfillment status from the remaining (non-reversed) GRNs.
// Deliberately does NOT unwind the product's average cost: a moving weighted average is
// forward-only by design — precisely reversing it would require replaying full receipt
// history, which no real ERP does. A materially wrong average cost from a bad receipt
// self-corrects as further receipts get folded in, or can be corrected via a manual stock
// adjustment if urgent.
router.post('/goods-receipt-notes/:id/reverse', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'inventory.grn')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const companyId = req.targetCompanyId;
    const tdb = tenantDb();

    // No separate db.transaction() wrapper — withTenantDb already wraps the whole
    // request in one transaction; every row lock below still applies within it.
    const [grn] = await tdb.select().from(schema.goodsReceiptNotes)
      .where(and(eq(schema.goodsReceiptNotes.id, id), eq(schema.goodsReceiptNotes.companyId, companyId)))
      .for('update');
    if (!grn) {
      const err: any = new Error('Goods receipt note not found.');
      err.status = 404;
      throw err;
    }
    if (!(await branchAccessOkViaWarehouse(tdb, req, grn.warehouseId))) {
      const err: any = new Error('Forbidden: you are not assigned to this branch.');
      err.status = 403;
      throw err;
    }
    if (grn.isReversed) {
      const err: any = new Error('This receipt has already been reversed.');
      err.status = 400;
      throw err;
    }
    // A receipt of a closed month (or of a quarter whose VAT return is generated/filed) is locked with that period: reversing it would
    // drop it from that month's received-not-billed and stock figures. It is corrected the other way, with a return to the vendor dated today.
    const grnDay = new Date(grn.date).toISOString().slice(0, 10);
    await validateTransactionDate(grnDay, companyId);
    await assertQuarterNotFrozen(grnDay, companyId);
    // Closes a known guard gap (row 12 of the posting-rules design): once a GRN has been
    // billed, its GR/IR Clearing entry has already been cleared into AP/VAT Input by the
    // Bill (row 9) — reversing the GRN's own entry underneath that would leave GR/IR
    // Clearing permanently unbalanced. Purchase Return (row 13) is the correct path for
    // a billed receipt; a reversal is only ever the right tool while still unbilled,
    // same reasoning Bill cancellation already applies (Unpaid-only).
    if (grn.isBilled) {
      const err: any = new Error('This receipt has already been billed and cannot be reversed — issue a Purchase Return instead.');
      err.status = 400;
      throw err;
    }

    const items = await tdb.select().from(schema.goodsReceiptNoteItems).where(eq(schema.goodsReceiptNoteItems.grnId, id));
    const valuationBefore = await snapshotInventory(tdb, companyId, items.map((i: any) => i.productId));

    for (const item of items) {
      const [product] = await tdb.select({
        itemKind: schema.productsServices.itemKind,
        averageCost: schema.productsServices.averageCost,
        totalQuantityPurchased: schema.productsServices.totalQuantityPurchased,
      }).from(schema.productsServices).where(eq(schema.productsServices.id, item.productId)).for('update');
      if (!product || product.itemKind !== 'item') continue;

      const baseQtyReceived = await toBaseQuantity(tdb, item.productId, item.unitOfMeasureId, companyId, Number(item.quantityReceived));

      const batchCondition = item.batchNumber
        ? eq(schema.inventoryStocks.batchNumber, item.batchNumber)
        : isNull(schema.inventoryStocks.batchNumber);
      const [existingStock] = await tdb.select().from(schema.inventoryStocks)
        .where(and(
          eq(schema.inventoryStocks.productId, item.productId),
          eq(schema.inventoryStocks.warehouseId, grn.warehouseId),
          eq(schema.inventoryStocks.companyId, companyId),
          batchCondition
        ))
        .for('update');
      if (existingStock) {
        const priorQty = Number(existingStock.quantity);
        const newQty = round2(priorQty - baseQtyReceived);
        await tdb.update(schema.inventoryStocks).set({ quantity: String(newQty) }).where(eq(schema.inventoryStocks.id, existingStock.id));
        await writeStockLedgerEntry(tdb, {
          productId: item.productId, warehouseId: grn.warehouseId, companyId,
          transactionType: 'GRN', referenceId: grn.id, date: nowDate(),
          quantityChange: newQty - priorQty, endingQuantity: newQty,
          batchNumber: item.batchNumber || null,
        });
      }

      // Unwind this line's own contribution from the weighted-average cost — same
      // exact-mirror-of-the-fold approach as the Purchase Return route above, valued at
      // THIS GRN item's own unitCost (this reversal is only ever reachable while
      // unbilled, so no Purchase Return can have already unwound part of this same line).
      const baseUnitCost = await toBaseUnitCost(tdb, item.productId, item.unitOfMeasureId, companyId, Number(item.unitCost));
      const priorTotalQty = Number(product.totalQuantityPurchased || 0);
      const priorAvg = Number(product.averageCost || 0);
      const newTotalQty = round2(priorTotalQty - baseQtyReceived);
      const newAvg = newTotalQty > 0 ? round4((priorTotalQty * priorAvg - baseQtyReceived * baseUnitCost) / newTotalQty) : priorAvg;
      await tdb.update(schema.productsServices)
        .set({ averageCost: String(newAvg), totalQuantityPurchased: String(Math.max(0, newTotalQty)) })
        .where(eq(schema.productsServices.id, item.productId));
    }

    const [reversedGrn] = await tdb.update(schema.goodsReceiptNotes)
      .set({ isReversed: true })
      .where(eq(schema.goodsReceiptNotes.id, id))
      .returning();

    // Phase 3 ledger posting (row 12) — reverses row 8's entry in full (this route is
    // now unreachable once billed, so there is always exactly one un-reversed entry to
    // find here).
    const grnReversalDate = nowDate().toISOString().slice(0, 10);
    const grnReversalEntries = await reverseAllEntriesFor(tdb, companyId, 'Grn', id, grnReversalDate, `Goods receipt ${grn.grnNumber} reversed`, req.user.id);
    await settleInventoryValuation(tdb, { companyId, date: grnReversalDate, before: valuationBefore, entryIds: grnReversalEntries, referenceType: 'Grn', referenceId: id, description: `Inventory revaluation on reversing receipt ${grn.grnNumber}`, createdById: req.user.id });

    let updatedPurchaseOrder: { id: string; status: string } | null = null;
    if (grn.purchaseOrderId) {
      const [po] = await tdb.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, grn.purchaseOrderId)).for('update');
      if (po) {
        const poItems = await tdb.select().from(schema.purchaseOrderItems).where(eq(schema.purchaseOrderItems.purchaseOrderId, po.id));
        const remainingGrnItems = await tdb.select({
          productId: schema.goodsReceiptNoteItems.productId,
          quantityReceived: schema.goodsReceiptNoteItems.quantityReceived,
          unitOfMeasureId: schema.goodsReceiptNoteItems.unitOfMeasureId,
        })
          .from(schema.goodsReceiptNoteItems)
          .innerJoin(schema.goodsReceiptNotes, eq(schema.goodsReceiptNoteItems.grnId, schema.goodsReceiptNotes.id))
          .where(and(eq(schema.goodsReceiptNotes.purchaseOrderId, po.id), eq(schema.goodsReceiptNotes.isReversed, false)));

        const receivedByProduct = new Map<string, number>();
        for (const row of remainingGrnItems) {
          const baseQty = await toBaseQuantity(tdb, row.productId, row.unitOfMeasureId, companyId, Number(row.quantityReceived));
          receivedByProduct.set(row.productId, (receivedByProduct.get(row.productId) || 0) + baseQty);
        }
        let fullyReceived = poItems.length > 0;
        let anyReceived = false;
        for (const poItem of poItems) {
          const received = receivedByProduct.get(poItem.productId) || 0;
          const orderedBaseQty = await toBaseQuantity(tdb, poItem.productId, poItem.unitOfMeasureId, companyId, Number(poItem.quantityOrdered));
          if (received > 0) anyReceived = true;
          if (received < orderedBaseQty) fullyReceived = false;
        }
        // Cancelled stays Cancelled regardless of receipt reversal — reversing a receipt
        // never resurrects a PO the company deliberately called off.
        const newStatus = po.status === 'Cancelled' ? 'Cancelled' : (fullyReceived ? 'Received' : (anyReceived ? 'Partially Received' : 'Sent'));
        if (newStatus !== po.status) {
          await tdb.update(schema.purchaseOrders).set({ status: newStatus }).where(eq(schema.purchaseOrders.id, po.id));
        }
        updatedPurchaseOrder = { id: po.id, status: newStatus };
      }
    }

    const result = { goodsReceiptNote: reversedGrn, updatedPurchaseOrder };

    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Approve / Reject a Purchase Requisition — gated by the dedicated `inventory.approve`
// permission, deliberately separate from `inventory.pr` (which only covers submitting/
// viewing requisitions) so approval authority can be delegated independently of who's
// allowed to merely create requests. Only a 'Pending' PR may be actioned.
router.patch('/purchase-requisitions/:id/status', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'inventory.approve')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const { status } = req.body || {};
    if (status !== 'Approved' && status !== 'Rejected') {
      return res.status(400).json({ error: "status must be 'Approved' or 'Rejected'." });
    }
    const companyId = req.targetCompanyId;
    const tdb = tenantDb();

    const [pr] = await tdb.select().from(schema.purchaseRequisitions)
      .where(and(eq(schema.purchaseRequisitions.id, id), eq(schema.purchaseRequisitions.companyId, companyId)))
      .for('update');
    if (!pr) {
      const err: any = new Error('Purchase requisition not found.');
      err.status = 404;
      throw err;
    }
    if (!branchAccessOk(req, pr.branchId)) {
      const err: any = new Error('Forbidden: you are not assigned to this branch.');
      err.status = 403;
      throw err;
    }
    if (pr.status !== 'Pending') {
      const err: any = new Error(`Cannot ${status.toLowerCase()} a requisition that is not Pending (current status: ${pr.status}).`);
      err.status = 400;
      throw err;
    }

    const [updated] = await tdb.update(schema.purchaseRequisitions)
      .set({ status })
      .where(eq(schema.purchaseRequisitions.id, id))
      .returning();

    res.json({ success: true, purchaseRequisition: updated });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Cancel a Purchase Order — only a 'Sent' PO may be cancelled (matches the UI's own gate;
// anything already Partially Received/Received/Cancelled has moved past the point a plain
// cancel makes sense).
router.patch('/purchase-orders/:id/cancel', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'inventory.po')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const companyId = req.targetCompanyId;
    const tdb = tenantDb();

    const [po] = await tdb.select().from(schema.purchaseOrders)
      .where(and(eq(schema.purchaseOrders.id, id), eq(schema.purchaseOrders.companyId, companyId)))
      .for('update');
    if (!po) {
      const err: any = new Error('Purchase order not found.');
      err.status = 404;
      throw err;
    }
    if (!branchAccessOk(req, po.branchId)) {
      const err: any = new Error('Forbidden: you are not assigned to this branch.');
      err.status = 403;
      throw err;
    }
    if (po.status !== 'Sent') {
      const err: any = new Error(`Cannot cancel a purchase order that is not Sent (current status: ${po.status}).`);
      err.status = 400;
      throw err;
    }

    const [updated] = await tdb.update(schema.purchaseOrders)
      .set({ status: 'Cancelled' })
      .where(eq(schema.purchaseOrders.id, id))
      .returning();

    res.json({ success: true, purchaseOrder: updated });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// --- Warehouse Transfers (Dispatch -> Receiving) ---
//
// Moves stock between two warehouses of the same company, which may belong to two
// DIFFERENT branches (or the same branch, or one/both branchless) — the one document
// type in this file that genuinely touches two branches' inventory in a single write.
// See schema.ts's warehouseDispatches comment for the full design rationale (1:1
// dispatch->receiving, stock deducted at dispatch and only added at receiving using the
// actual received quantity, no assertSalesWarehouse — warehouse `type` is irrelevant to a
// pure transfer just like it already is for GRN/Stock Adjustment).
//
// Create a dispatch: deducts stock from fromWarehouseId immediately. Both warehouses are
// resolved and branch-checked INDEPENDENTLY and explicitly scoped to companyId here (never
// via branchAccessOkViaWarehouse, which does NOT check companyId on its own — safe only
// for acting on a warehouseId that was already company-verified elsewhere, which a fresh
// client-supplied id here has not been).
router.post('/warehouse-dispatches', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'warehouseDispatches.create')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { dispatchData } = req.body || {};
    if (!dispatchData || !dispatchData.fromWarehouseId || !dispatchData.toWarehouseId || !Array.isArray(dispatchData.items) || dispatchData.items.length === 0) {
      return res.status(400).json({ error: 'A source warehouse, destination warehouse, and at least one dispatched item are required.' });
    }
    if (dispatchData.fromWarehouseId === dispatchData.toWarehouseId) {
      return res.status(400).json({ error: 'Source and destination warehouse must be different.' });
    }
    if (!dispatchData.dispatchedBy) {
      return res.status(400).json({ error: 'Dispatched By is required.' });
    }
    const companyId = req.targetCompanyId;
    const tdb = tenantDb();

    // No separate db.transaction() wrapper — withTenantDb already wraps the whole
    // request in one transaction; every row lock below still applies within it.
    await assertProductsOwnedByCompany(tdb, companyId, dispatchData.items.map((it: any) => it.productId));

    const [fromWarehouse] = await tdb.select({ branchId: schema.warehouses.branchId, isActive: schema.warehouses.isActive })
      .from(schema.warehouses)
      .where(and(eq(schema.warehouses.id, dispatchData.fromWarehouseId), eq(schema.warehouses.companyId, companyId)));
    if (!fromWarehouse) {
      const err: any = new Error('Source warehouse not found for this company.');
      err.status = 404;
      throw err;
    }
    if (fromWarehouse.isActive === false) {
      const err: any = new Error('Source warehouse is deactivated and cannot dispatch stock.');
      err.status = 400;
      throw err;
    }
    if (!branchAccessOk(req, fromWarehouse.branchId)) {
      const err: any = new Error('Forbidden: you are not assigned to the source warehouse\'s branch.');
      err.status = 403;
      throw err;
    }

    const [toWarehouse] = await tdb.select({ branchId: schema.warehouses.branchId, isActive: schema.warehouses.isActive })
      .from(schema.warehouses)
      .where(and(eq(schema.warehouses.id, dispatchData.toWarehouseId), eq(schema.warehouses.companyId, companyId)));
    if (!toWarehouse) {
      const err: any = new Error('Destination warehouse not found for this company.');
      err.status = 404;
      throw err;
    }
    if (toWarehouse.isActive === false) {
      const err: any = new Error('Destination warehouse is deactivated and cannot receive stock.');
      err.status = 400;
      throw err;
    }
    // A dispatch-creating user must be authorized for the branch they're removing stock
    // FROM and the branch they're sending it TO — stricter than GRN, which only ever
    // checks one side, because this write genuinely touches two branches' inventory.
    if (!branchAccessOk(req, toWarehouse.branchId)) {
      const err: any = new Error('Forbidden: you are not assigned to the destination warehouse\'s branch.');
      err.status = 403;
      throw err;
    }

    const dispatchNumber = await getAndIncrementDocumentNumber(tdb, companyId, 'dispatch', nowDate().toISOString().slice(0, 10), fromWarehouse.branchId);
    const dispatchId = generateId();
    const dispatchDate = nowDate();

    const [newDispatch] = await tdb.insert(schema.warehouseDispatches).values({
      id: dispatchId,
      dispatchNumber,
      fromWarehouseId: dispatchData.fromWarehouseId,
      toWarehouseId: dispatchData.toWarehouseId,
      date: dispatchDate,
      vehicleNumber: dispatchData.vehicleNumber || null,
      driverName: dispatchData.driverName || null,
      driverContact: dispatchData.driverContact || null,
      expectedArrivalDate: dispatchData.expectedArrivalDate ? new Date(dispatchData.expectedArrivalDate) : null,
      dispatchedBy: dispatchData.dispatchedBy,
      notes: dispatchData.notes || null,
      status: 'Dispatched',
      companyId,
    }).returning();

    const itemRows = dispatchData.items.map((item: any) => ({
      id: generateId(),
      dispatchId,
      productId: item.productId,
      quantityDispatched: String(item.quantityDispatched),
      batchNumber: item.batchNumber || null,
      expiryDate: item.expiryDate ? new Date(item.expiryDate) : null,
      unitOfMeasureId: item.unitOfMeasureId || null,
    }));
    const insertedItems = await tdb.insert(schema.warehouseDispatchItems).values(itemRows).returning();

    // Deduct from the source warehouse — lock each matching stock row first (same
    // concurrency reasoning as GRN's own increment loop), and hard-reject (never clamp)
    // when there isn't enough: unlike a Stock Adjustment, which is itself the correction
    // for a wrong count, a dispatch claiming to move stock that doesn't exist is a plain
    // data-entry error and should never silently succeed at a lower quantity.
    for (const item of dispatchData.items) {
      const [product] = await tdb.select({ itemKind: schema.productsServices.itemKind })
        .from(schema.productsServices).where(eq(schema.productsServices.id, item.productId));
      if (!product || product.itemKind !== 'item') continue;

      const baseQtyDispatched = await toBaseQuantity(tdb, item.productId, item.unitOfMeasureId, companyId, Number(item.quantityDispatched));

      const batchCondition = item.batchNumber
        ? eq(schema.inventoryStocks.batchNumber, item.batchNumber)
        : isNull(schema.inventoryStocks.batchNumber);

      const [existingStock] = await tdb.select().from(schema.inventoryStocks)
        .where(and(
          eq(schema.inventoryStocks.productId, item.productId),
          eq(schema.inventoryStocks.warehouseId, dispatchData.fromWarehouseId),
          eq(schema.inventoryStocks.companyId, companyId),
          batchCondition
        ))
        .for('update');

      const priorQty = existingStock ? Number(existingStock.quantity) : 0;
      if (priorQty < baseQtyDispatched) {
        const err: any = new Error(`Insufficient stock for the selected product at the source warehouse (have ${priorQty}, dispatching ${baseQtyDispatched}).`);
        err.status = 400;
        throw err;
      }
      const newQty = round2(priorQty - baseQtyDispatched);
      await tdb.update(schema.inventoryStocks).set({ quantity: String(newQty) }).where(eq(schema.inventoryStocks.id, existingStock.id));
      await writeStockLedgerEntry(tdb, {
        productId: item.productId, warehouseId: dispatchData.fromWarehouseId, companyId,
        transactionType: 'TransferOut', referenceId: dispatchId, date: dispatchDate,
        quantityChange: -baseQtyDispatched, endingQuantity: newQty,
        batchNumber: item.batchNumber || null,
      });
    }

    const created = { ...newDispatch, items: insertedItems };

    res.json({ success: true, dispatch: created });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Receive against a dispatch — the 1:1 fulfillment step. Received quantity per line
// defaults to what was dispatched but is independently editable/short/over; a mismatch is
// expected and recorded via discrepancyNotes, not blocked. Adds stock to the destination
// warehouse only now, using the RECEIVED (not dispatched) quantity.
router.post('/warehouse-receivings', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'warehouseReceivings.create')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { receivingData } = req.body || {};
    if (!receivingData || !receivingData.dispatchId || !Array.isArray(receivingData.items) || receivingData.items.length === 0) {
      return res.status(400).json({ error: 'A dispatch and at least one received item are required.' });
    }
    if (!receivingData.receivedBy) {
      return res.status(400).json({ error: 'Received By is required.' });
    }
    const companyId = req.targetCompanyId;
    const tdb = tenantDb();

    // No separate db.transaction() wrapper — withTenantDb already wraps the whole
    // request in one transaction; the row lock below still applies within it.
    // Row-lock the dispatch for the duration of this transaction — the exact same
    // check-then-set concurrency pattern goodsReceiptNotes.isBilled uses for Purchase
    // Bill's 3-way match, so two concurrent receiving requests against the same dispatch
    // can never both succeed.
    const [dispatch] = await tdb.select().from(schema.warehouseDispatches)
      .where(and(eq(schema.warehouseDispatches.id, receivingData.dispatchId), eq(schema.warehouseDispatches.companyId, companyId)))
      .for('update');
    if (!dispatch) {
      const err: any = new Error('Dispatch not found for this company.');
      err.status = 404;
      throw err;
    }
    if (dispatch.status === 'Cancelled') {
      const err: any = new Error('This dispatch has been cancelled and cannot be received.');
      err.status = 400;
      throw err;
    }
    if (dispatch.status === 'Received') {
      const err: any = new Error('This dispatch has already been received.');
      err.status = 400;
      throw err;
    }
    // Goods in transit are stock; if fewer arrive than left, the difference is lost stock and a cost — taken from the valuation change below.
    const dispatchedProducts = await tdb.select({ productId: schema.warehouseDispatchItems.productId }).from(schema.warehouseDispatchItems).where(eq(schema.warehouseDispatchItems.dispatchId, receivingData.dispatchId));
    const receivingBefore = await snapshotInventory(tdb, companyId, dispatchedProducts.map((r: any) => r.productId));

    // toWarehouseId is DERIVED from the already company-scoped dispatch row above, never
    // from the client — the destination was fixed at dispatch time. branchAccessOkViaWarehouse
    // is safe here specifically because `dispatch` was just fetched with a companyId
    // filter (unlike dispatch-creation's fresh, not-yet-verified client input).
    // Deliberately does NOT also check the source branch — the receiving user may have
    // no access to or knowledge of it; dispatch and receiving are legitimately done by
    // different branch-scoped users.
    if (!(await branchAccessOkViaWarehouse(tdb, req, dispatch.toWarehouseId))) {
      const err: any = new Error('Forbidden: you are not assigned to the destination warehouse\'s branch.');
      err.status = 403;
      throw err;
    }
    const [toWarehouseForNumbering] = await tdb.select({ branchId: schema.warehouses.branchId })
      .from(schema.warehouses).where(eq(schema.warehouses.id, dispatch.toWarehouseId));

    const dispatchItems = await tdb.select().from(schema.warehouseDispatchItems)
      .where(eq(schema.warehouseDispatchItems.dispatchId, receivingData.dispatchId));
    const dispatchItemById = new Map(dispatchItems.map((di: any) => [di.id, di]));

    // Every submitted dispatchItemId must actually belong to THIS dispatch — without
    // this, a crafted request could receive against another dispatch's line while
    // writing stock under the current dispatch's number, corrupting quantities silently.
    // isolation-checked: dispatchItemId membership verified against the already
    // company-scoped `dispatchItems` set fetched above, not a recognized OWNERSHIP_HELPERS
    // call but equivalent in effect.
    for (const item of receivingData.items) {
      if (!dispatchItemById.has(item.dispatchItemId)) {
        const err: any = new Error('One or more received lines do not belong to the selected dispatch.');
        err.status = 400;
        throw err;
      }
    }

    const receivingNumber = await getAndIncrementDocumentNumber(tdb, companyId, 'receiving', nowDate().toISOString().slice(0, 10), toWarehouseForNumbering?.branchId || null);
    const receivingId = generateId();
    const receivingDate = nowDate();

    const [newReceiving] = await tdb.insert(schema.warehouseReceivings).values({
      id: receivingId,
      receivingNumber,
      dispatchId: receivingData.dispatchId,
      date: receivingDate,
      receivedBy: receivingData.receivedBy,
      condition: receivingData.condition || null,
      discrepancyNotes: receivingData.discrepancyNotes || null,
      notes: receivingData.notes || null,
      status: 'Active',
      companyId,
    }).returning();

    const itemRows = receivingData.items.map((item: any) => {
      const dispatchItem: any = dispatchItemById.get(item.dispatchItemId);
      const quantityReceived = item.quantityReceived !== undefined && item.quantityReceived !== null && item.quantityReceived !== ''
        ? item.quantityReceived
        : dispatchItem.quantityDispatched;
      return {
        id: generateId(),
        receivingId,
        dispatchItemId: item.dispatchItemId,
        productId: dispatchItem.productId,
        quantityReceived: String(quantityReceived),
        batchNumber: item.batchNumber ?? dispatchItem.batchNumber ?? null,
        expiryDate: item.expiryDate ? new Date(item.expiryDate) : (dispatchItem.expiryDate || null),
        unitOfMeasureId: item.unitOfMeasureId ?? dispatchItem.unitOfMeasureId ?? null,
      };
    });
    const insertedItems = await tdb.insert(schema.warehouseReceivingItems).values(itemRows).returning();

    // Add to the destination warehouse using the ACTUAL received quantity (may be less
    // or more than dispatched — that's exactly what discrepancyNotes is for).
    for (const row of itemRows) {
      const [product] = await tdb.select({ itemKind: schema.productsServices.itemKind })
        .from(schema.productsServices).where(eq(schema.productsServices.id, row.productId));
      if (!product || product.itemKind !== 'item') continue;

      const baseQtyReceived = await toBaseQuantity(tdb, row.productId, row.unitOfMeasureId, companyId, Number(row.quantityReceived));

      const batchCondition = row.batchNumber
        ? eq(schema.inventoryStocks.batchNumber, row.batchNumber)
        : isNull(schema.inventoryStocks.batchNumber);

      const [existingStock] = await tdb.select().from(schema.inventoryStocks)
        .where(and(
          eq(schema.inventoryStocks.productId, row.productId),
          eq(schema.inventoryStocks.warehouseId, dispatch.toWarehouseId),
          eq(schema.inventoryStocks.companyId, companyId),
          batchCondition
        ))
        .for('update');

      const newQty = existingStock
        ? round2(Number(existingStock.quantity) + baseQtyReceived)
        : round2(baseQtyReceived);

      if (existingStock) {
        await tdb.update(schema.inventoryStocks).set({ quantity: String(newQty) }).where(eq(schema.inventoryStocks.id, existingStock.id));
      } else {
        await tdb.insert(schema.inventoryStocks).values({
          id: generateId(),
          productId: row.productId,
          warehouseId: dispatch.toWarehouseId,
          batchNumber: row.batchNumber || null,
          expiryDate: row.expiryDate || null,
          quantity: String(baseQtyReceived),
          companyId,
        });
      }
      await writeStockLedgerEntry(tdb, {
        productId: row.productId, warehouseId: dispatch.toWarehouseId, companyId,
        transactionType: 'TransferIn', referenceId: receivingId, date: receivingDate,
        quantityChange: baseQtyReceived, endingQuantity: newQty,
        batchNumber: row.batchNumber || null,
      });
    }

    // The atomic "set" half of the check-then-set — same locked row from the top of this
    // transaction, so no concurrent request can have slipped through between the check
    // and here.
    await tdb.update(schema.warehouseDispatches).set({ status: 'Received' }).where(eq(schema.warehouseDispatches.id, receivingData.dispatchId));
    await settleInventoryValuation(tdb, {
      companyId, branchId: null, date: nowDate().toISOString().slice(0, 10), before: receivingBefore, entryIds: [],
      referenceType: 'Receiving', referenceId: receivingId, description: `Transfer receipt variance for dispatch ${dispatch.dispatchNumber}`, createdById: req.user.id,
    });

    const created = { ...newReceiving, items: insertedItems };

    res.json({ success: true, receiving: created });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Cancel a dispatch — only legal while still 'Dispatched' (never once 'Received': correct
// an already-received transfer with a new opposite transfer, not a retroactive cancel).
// Restores the previously-deducted quantity to the source warehouse and writes a reversing
// TransferOut ledger entry (same transactionType, positive quantityChange, so the
// reconciliation report's per-dispatch net-out math still nets to zero rather than needing
// a third transaction type).
router.post('/warehouse-dispatches/:id/cancel', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'warehouseDispatches.delete')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const companyId = req.targetCompanyId;
    const tdb = tenantDb();

    // No separate db.transaction() wrapper — withTenantDb already wraps the whole
    // request in one transaction; the row lock below still applies within it.
    const [dispatch] = await tdb.select().from(schema.warehouseDispatches)
      .where(and(eq(schema.warehouseDispatches.id, id), eq(schema.warehouseDispatches.companyId, companyId)))
      .for('update');
    if (!dispatch) {
      const err: any = new Error('Dispatch not found.');
      err.status = 404;
      throw err;
    }
    if (!(await branchAccessOkViaWarehouse(tdb, req, dispatch.fromWarehouseId))) {
      const err: any = new Error('Forbidden: you are not assigned to the source warehouse\'s branch.');
      err.status = 403;
      throw err;
    }
    if (dispatch.status === 'Cancelled') {
      const err: any = new Error('This dispatch has already been cancelled.');
      err.status = 400;
      throw err;
    }
    if (dispatch.status === 'Received') {
      const err: any = new Error('This dispatch has already been received and cannot be cancelled — issue a new transfer in the opposite direction to correct it.');
      err.status = 400;
      throw err;
    }

    const items = await tdb.select().from(schema.warehouseDispatchItems).where(eq(schema.warehouseDispatchItems.dispatchId, id));
    const cancelDate = nowDate();

    for (const item of items) {
      const [product] = await tdb.select({ itemKind: schema.productsServices.itemKind })
        .from(schema.productsServices).where(eq(schema.productsServices.id, item.productId));
      if (!product || product.itemKind !== 'item') continue;

      const baseQtyDispatched = await toBaseQuantity(tdb, item.productId, item.unitOfMeasureId, companyId, Number(item.quantityDispatched));
      const batchCondition = item.batchNumber
        ? eq(schema.inventoryStocks.batchNumber, item.batchNumber)
        : isNull(schema.inventoryStocks.batchNumber);
      const [existingStock] = await tdb.select().from(schema.inventoryStocks)
        .where(and(
          eq(schema.inventoryStocks.productId, item.productId),
          eq(schema.inventoryStocks.warehouseId, dispatch.fromWarehouseId),
          eq(schema.inventoryStocks.companyId, companyId),
          batchCondition
        ))
        .for('update');
      const priorQty = existingStock ? Number(existingStock.quantity) : 0;
      const newQty = round2(priorQty + baseQtyDispatched);
      if (existingStock) {
        await tdb.update(schema.inventoryStocks).set({ quantity: String(newQty) }).where(eq(schema.inventoryStocks.id, existingStock.id));
      } else {
        await tdb.insert(schema.inventoryStocks).values({
          id: generateId(), productId: item.productId, warehouseId: dispatch.fromWarehouseId,
          batchNumber: item.batchNumber || null, expiryDate: item.expiryDate || null,
          quantity: String(newQty), companyId,
        });
      }
      await writeStockLedgerEntry(tdb, {
        productId: item.productId, warehouseId: dispatch.fromWarehouseId, companyId,
        transactionType: 'TransferOut', referenceId: dispatch.id, date: cancelDate,
        quantityChange: baseQtyDispatched, endingQuantity: newQty,
        batchNumber: item.batchNumber || null,
      });
    }

    const [cancelled] = await tdb.update(schema.warehouseDispatches)
      .set({ status: 'Cancelled' })
      .where(eq(schema.warehouseDispatches.id, id))
      .returning();
    const result = cancelled;

    res.json({ success: true, dispatch: result });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Manual stock adjustment (count discrepancy, damage, etc.) — reuses the exact
// lock-then-increment-or-insert pattern the GRN route above uses to update
// inventoryStocks, just with a signed delta instead of an always-positive received
// quantity. Allowed to go negative (see deductStockForSale's comment in businessLogic.ts
// for the full reasoning) rather than clamped at 0. `quantity` is entered in whatever unit
// was selected (`unitOfMeasureId`, null = base) and converted to base-unit terms here —
// same convention as every other stock-mutating route — so a packaging-unit adjustment
// (e.g. "-1 Outer") doesn't require the caller to hand-compute the base-unit delta first.
router.post('/stock-adjustments', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'inventory.stock')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { productId, warehouseId, quantity, batchNumber, reason, unitOfMeasureId } = req.body || {};
    if (!productId || !warehouseId || quantity === undefined || quantity === null || Number(quantity) === 0) {
      return res.status(400).json({ error: 'A product, warehouse, and non-zero quantity are required.' });
    }
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'A reason is required for stock adjustments.' });
    }
    const companyId = req.targetCompanyId;
    const tdb = tenantDb();
    // Posts cost to the P&L dated today, so it must not land in a closed month or a quarter already filed with ZATCA.
    const guardDate = nowDate().toISOString().slice(0, 10);
    await validateTransactionDate(guardDate, companyId);
    await assertQuarterNotFiled(guardDate, companyId);
    const delta = await toBaseQuantity(tdb, productId, unitOfMeasureId, companyId, Number(quantity));
    const adjustmentBefore = await snapshotInventory(tdb, companyId, [productId]);

    // No separate db.transaction() wrapper — withTenantDb already wraps the whole
    // request in one transaction; the row lock below still applies within it.
    // warehouseId was previously never checked against companyId or the caller's
    // allowedBranchIds at all — a crafted request could adjust stock in (or create a
    // new stock row for) another company's warehouse, filed under this caller's own
    // companyId. Same fix as POST /goods-receipt-notes above.
    const [warehouse] = await tdb.select({ branchId: schema.warehouses.branchId }).from(schema.warehouses)
      .where(and(eq(schema.warehouses.id, warehouseId), eq(schema.warehouses.companyId, companyId)));
    if (!warehouse) {
      const err: any = new Error('Selected warehouse not found for this company.');
      err.status = 400;
      throw err;
    }
    if (!branchAccessOk(req, warehouse.branchId)) {
      const err: any = new Error('Forbidden: you are not assigned to this branch.');
      err.status = 403;
      throw err;
    }
    await assertProductsOwnedByCompany(tdb, companyId, [productId]);

    const [product] = await tdb.select({ itemKind: schema.productsServices.itemKind })
      .from(schema.productsServices).where(eq(schema.productsServices.id, productId));
    if (!product || product.itemKind !== 'item') {
      const err: any = new Error('Stock adjustments only apply to physical-item products, not services.');
      err.status = 400;
      throw err;
    }

    const batchCondition = batchNumber
      ? eq(schema.inventoryStocks.batchNumber, batchNumber)
      : isNull(schema.inventoryStocks.batchNumber);

    const [existingStock] = await tdb.select().from(schema.inventoryStocks)
      .where(and(
        eq(schema.inventoryStocks.productId, productId),
        eq(schema.inventoryStocks.warehouseId, warehouseId),
        eq(schema.inventoryStocks.companyId, companyId),
        batchCondition
      ))
      .for('update');

    const adjustmentId = generateId();

    let stock;
    let adjustedBy = 0;
    if (existingStock) {
      const priorQty = Number(existingStock.quantity);
      const newQty = round2(priorQty + delta);
      const [updatedStock] = await tdb.update(schema.inventoryStocks)
        .set({ quantity: String(newQty) })
        .where(eq(schema.inventoryStocks.id, existingStock.id))
        .returning();
      await writeStockLedgerEntry(tdb, {
        productId, warehouseId, companyId,
        transactionType: 'Adjustment', referenceId: adjustmentId, date: nowDate(),
        quantityChange: newQty - priorQty, endingQuantity: newQty, batchNumber,
      });
      adjustedBy = round2(newQty - priorQty);
      stock = updatedStock;
    } else {
      const [newStock] = await tdb.insert(schema.inventoryStocks).values({
        id: generateId(),
        productId,
        warehouseId,
        batchNumber: batchNumber || null,
        quantity: String(round2(delta)),
        companyId,
      }).returning();
      await writeStockLedgerEntry(tdb, {
        productId, warehouseId, companyId,
        transactionType: 'Adjustment', referenceId: adjustmentId, date: nowDate(),
        quantityChange: round2(delta), endingQuantity: round2(delta), batchNumber,
      });
      adjustedBy = round2(delta);
      stock = newStock;
    }

    // Stock found or lost is a gain or a cost: the change in the product's valuation (whole cents) goes to cost of goods sold.
    await settleInventoryValuation(tdb, {
      companyId, branchId: warehouse.branchId, date: nowDate().toISOString().slice(0, 10), before: adjustmentBefore, entryIds: [],
      referenceType: 'StockAdjustment', referenceId: adjustmentId, description: `Stock adjustment: ${String(reason).trim()}`, createdById: req.user.id,
    });

    res.json({ success: true, inventoryStock: stock });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// --- Purchase Bills (Vendor Invoices) ---
// Tier-1 "3-way match" control (PO -> GRN -> Bill): a bill references one or more
// already-received GRNs and its totals are computed server-side directly from those GRNs'
// own item rows — never re-entered or trusted from the client — so a bill can never
// silently diverge from what was actually ordered and actually received. Each GRN can
// only be billed once (goodsReceiptNotes.isBilled), preventing the same delivery from
// being billed twice; all referenced GRNs must share one vendor, matching how a real
// vendor invoice consolidates deliveries.
router.post('/purchase-bills', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'purchaseBills.create')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { billData } = req.body || {};
    if (!billData || !Array.isArray(billData.grnIds) || billData.grnIds.length === 0) {
      return res.status(400).json({ error: 'At least one goods receipt note must be referenced.' });
    }
    const companyId = req.targetCompanyId;
    const tdb = tenantDb();

    // If no branch was explicitly requested, inherit the first referenced GRN's own
    // branch (derived via its warehouse — GRNs have no branchId column of their own, see
    // schema.ts) — otherwise resolve/validate independently, same choke-point as every
    // other document-creation route.
    let billBranchId: string | null;
    try {
      let requestedBranchId = billData.branchId;
      if (!requestedBranchId) {
        const [firstGrn] = await tdb.select({ warehouseId: schema.goodsReceiptNotes.warehouseId }).from(schema.goodsReceiptNotes)
          .where(and(eq(schema.goodsReceiptNotes.id, billData.grnIds[0]), eq(schema.goodsReceiptNotes.companyId, companyId)));
        if (firstGrn?.warehouseId) {
          const [wh] = await tdb.select({ branchId: schema.warehouses.branchId }).from(schema.warehouses).where(and(eq(schema.warehouses.id, firstGrn.warehouseId), eq(schema.warehouses.companyId, companyId)));
          requestedBranchId = wh?.branchId || undefined;
        }
      }
      billBranchId = await resolveDocumentBranchId(req, requestedBranchId);
    } catch (branchErr: any) {
      return res.status(branchErr.status || 400).json({ error: branchErr.error || 'Invalid branch.' });
    }

    // No separate db.transaction() wrapper — withTenantDb already wraps the whole
    // request in one transaction; every row lock below still applies within it.
    // The bill date is mandatory (the supplier's invoice date) and validated like every other dated document:
    // an existing, open fiscal month, not in the future, not inside a VAT quarter already filed with ZATCA.
    const billDate = String(billData.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(billDate)) {
      return res.status(400).json({ error: 'A bill date is required.' });
    }
    await validateTransactionDate(billDate, companyId);
    await assertQuarterNotFrozen(billDate, companyId);

    // Vendor Bill # is optional here (can be added later via PUT /purchase-bills/:id
    // while still Unpaid) — only the GRN auto-post-bill flow requires it upfront, since
    // that's the moment the vendor's paper bill is actually in hand.
    const newBill = await createPurchaseBillForGrns(tdb, {
      companyId,
      grnIds: billData.grnIds,
      branchId: billBranchId,
      bankId: billData.bankId,
      dueDate: billData.dueDate,
      vendorBillNumber: billData.vendorBillNumber,
      date: billDate,
      userId: req.user.id,
    });

    res.json({ success: true, purchaseBill: newBill });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Edit a Bill's due date / bank / vendor bill # — only while Unpaid (nothing else is
// safe to change once money may have moved against it, and the GRN linkage/totals are
// the 3-way-match record, not something an edit should be able to quietly rewrite).
// vendorBillNumber is the one field this route exists to let arrive late: it's optional
// at creation time (POST /purchase-bills) but can be filled in here once the vendor's
// paper bill is actually in hand.
router.put('/purchase-bills/:id', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'purchaseBills.update')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const { billData } = req.body || {};
    const companyId = req.targetCompanyId;
    const tdb = tenantDb();

    // No separate db.transaction() wrapper — withTenantDb already wraps the whole
    // request in one transaction; the row lock below still applies within it.
    const [bill] = await tdb.select().from(schema.purchaseBills)
      .where(and(eq(schema.purchaseBills.id, id), eq(schema.purchaseBills.companyId, companyId)))
      .for('update');
    if (!bill) {
      const err: any = new Error('Purchase bill not found.');
      err.status = 404;
      throw err;
    }
    if (!branchAccessOk(req, bill.branchId)) {
      const err: any = new Error('Forbidden: you are not assigned to this branch.');
      err.status = 403;
      throw err;
    }
    if (bill.status !== 'Unpaid') {
      const err: any = new Error(`Cannot edit a bill that is not Unpaid (current status: ${bill.status}).`);
      err.status = 400;
      throw err;
    }
    // A client-supplied bankId must actually belong to this company — same reasoning
    // already applied elsewhere in this app (see transactions.ts's
    // assertDocumentRefsOwnedByCompany) but never wired into this specific route.
    if (billData?.bankId) {
      const [bank] = await tdb.select({ id: schema.bankAccounts.id }).from(schema.bankAccounts)
        .where(and(eq(schema.bankAccounts.id, billData.bankId), eq(schema.bankAccounts.companyId, companyId)));
      if (!bank) {
        const err: any = new Error('Selected bank account was not found for this company.');
        err.status = 400;
        throw err;
      }
    }
    const [newBill] = await tdb.update(schema.purchaseBills)
      .set({
        dueDate: billData?.dueDate !== undefined ? (billData.dueDate ? new Date(billData.dueDate) : null) : bill.dueDate,
        bankId: billData?.bankId !== undefined ? billData.bankId : bill.bankId,
        vendorBillNumber: billData?.vendorBillNumber !== undefined ? billData.vendorBillNumber : bill.vendorBillNumber,
      })
      .where(eq(schema.purchaseBills.id, id))
      .returning();
    const updated = newBill;

    res.json({ success: true, purchaseBill: normalizePurchaseBillForClient(updated) });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Pay a Bill (full or partial) — same partial-payment shape as the expense/invoice payment
// routes: caps at the remaining balance, generates a fresh Payment voucher per settlement.
// --- Vendor refunds: the supplier paying back money for goods returned AFTER the bill was paid in full -------------------
// The credit itself is created by POST /purchase-returns (Dr VENDOR_CREDIT_RECEIVABLE). Receiving the money clears it:
// Dr Bank / Cr Vendor Credit Receivable. It is a cash-and-receivable movement ONLY — it never touches the P&L, the VAT
// registers or any filed return (the VAT was corrected in the period of the return). Because it is still a dated money entry,
// it must not be dated in a closed fiscal month or inside a VAT quarter already filed with ZATCA, and cancelling it is held to
// the same rule (the reversal carries the original's date), so no closed period can ever be altered by a refund or its cancel.
router.post('/vendor-refunds', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'purchaseBills.update')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    const tdb = tenantDb();
    const { vendorId, bankId, amount, date, description } = req.body || {};
    const refundDate = String(date || nowDate().toISOString().slice(0, 10)).slice(0, 10);
    const amt = round2(Number(amount));
    if (!vendorId || !bankId) return res.status(400).json({ error: 'A vendor and a bank account are required.' });
    if (!(amt > 0)) return res.status(400).json({ error: 'Refund amount must be greater than zero.' });

    const [vendor] = await tdb.select({ id: schema.vendors.id }).from(schema.vendors).where(and(eq(schema.vendors.id, vendorId), eq(schema.vendors.companyId, companyId)));
    if (!vendor) return res.status(400).json({ error: 'Vendor not found for this company.' });
    const [bank] = await tdb.select({ id: schema.bankAccounts.id }).from(schema.bankAccounts).where(and(eq(schema.bankAccounts.id, bankId), eq(schema.bankAccounts.companyId, companyId)));
    if (!bank) return res.status(400).json({ error: 'Selected bank account was not found for this company.' });

    await validateTransactionDate(refundDate, companyId);       // existing, open, not in the future
    await assertQuarterNotFiled(refundDate, companyId);          // not inside a quarter already filed with ZATCA

    const available = await computeVendorCreditBalance(tdb, companyId, refundDate, vendorId);
    if (amt > available + 0.01) {
      return res.status(400).json({ error: `Refund (${amt.toFixed(2)}) exceeds the credit this vendor owes the company as of ${refundDate} (${Math.max(0, available).toFixed(2)}).` });
    }

    const voucherNumber = await getAndIncrementDocumentNumber(tdb, companyId, 'voucher', refundDate, null);
    const voucherId = generateId();
    const [voucher] = await tdb.insert(schema.vouchers).values({
      id: voucherId, voucherNumber, type: 'Receipt', date: refundDate, bankId, amount: String(amt),
      description: description || `Refund received from vendor for returned goods (${amt.toFixed(2)})`,
      referenceType: 'VendorRefund', referenceId: vendorId, createdById: req.user.id, createdAt: nowDate(), companyId, branchId: null,
    }).returning();
    await postJournalEntry(tdb, {
      companyId, branchId: null, date: refundDate, referenceType: 'VendorRefund', referenceId: voucherId,
      description: `Vendor refund ${voucherNumber}`, createdById: req.user.id,
      lines: [{ accountKey: 'BANK', debit: amt, bankId }, { accountKey: 'VENDOR_CREDIT_RECEIVABLE', credit: amt }],
    });
    res.json({ success: true, voucher: { ...voucher, amount: Number(voucher.amount), createdAt: voucher.createdAt instanceof Date ? voucher.createdAt.toISOString() : voucher.createdAt } });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/vendor-refunds', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'purchaseBills.read') && !hasPermission(req.user, 'purchaseBills.update')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    const tdb = tenantDb();
    const rows = await tdb.select().from(schema.vouchers).where(and(eq(schema.vouchers.companyId, companyId), eq(schema.vouchers.referenceType, 'VendorRefund')));
    const reversed = new Set(rows.filter((v: any) => v.type === 'Reversal').map((v: any) => v.reversalOfVoucherId));
    const vendorId = typeof req.query.vendorId === 'string' ? req.query.vendorId : null;
    const refunds = rows.filter((v: any) => v.type === 'Receipt' && (!vendorId || v.referenceId === vendorId))
      .map((v: any) => ({ id: v.id, voucherNumber: v.voucherNumber, date: v.date, vendorId: v.referenceId, bankId: v.bankId, amount: Number(v.amount), cancelled: reversed.has(v.id) }))
      .sort((a: any, b: any) => b.date.localeCompare(a.date));
    const balance = await computeVendorCreditBalance(tdb, companyId, '9999-12-31', vendorId || 'ALL');
    res.json({ refunds, creditBalance: balance });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/vendor-refunds/:id/cancel', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'purchaseBills.update')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    const tdb = tenantDb();
    const [original] = await tdb.select().from(schema.vouchers).where(and(
      eq(schema.vouchers.id, req.params.id), eq(schema.vouchers.companyId, companyId),
      eq(schema.vouchers.referenceType, 'VendorRefund'), eq(schema.vouchers.type, 'Receipt'),
    ));
    if (!original) return res.status(404).json({ error: 'Vendor refund not found.' });
    const [already] = await tdb.select({ id: schema.vouchers.id }).from(schema.vouchers).where(and(
      eq(schema.vouchers.companyId, companyId), eq(schema.vouchers.reversalOfVoucherId, original.id),
    ));
    if (already) return res.status(400).json({ error: 'This refund has already been cancelled.' });

    // The reversal carries the ORIGINAL's date, so cancelling a refund received in a month that has since closed (or in a
    // filed quarter) is refused — exactly like the original could not have been entered there.
    await validateTransactionDate(original.date, companyId);
    await assertQuarterNotFiled(original.date, companyId);

    const voucherNumber = await getAndIncrementDocumentNumber(tdb, companyId, 'voucher', original.date, null);
    await tdb.insert(schema.vouchers).values({
      id: generateId(), voucherNumber, type: 'Reversal', date: original.date, bankId: original.bankId, amount: original.amount,
      description: `Reversal of vendor refund ${original.voucherNumber}`,
      referenceType: 'VendorRefund', referenceId: original.referenceId, createdById: req.user.id, createdAt: nowDate(), companyId,
      branchId: null, reversalOfVoucherId: original.id,
    });
    await reverseAllEntriesFor(tdb, companyId, 'VendorRefund', original.id, original.date, `Vendor refund ${original.voucherNumber} cancelled`, req.user.id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/purchase-bills/:id/pay', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'purchaseBills.update')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const { date, bankId, amount } = req.body || {};
    const companyId = req.targetCompanyId;
    const tdb = tenantDb();

    // No separate db.transaction() wrapper — withTenantDb already wraps the whole
    // request in one transaction; payPurchaseBillInFull takes its own row lock within it.
    const [bill] = await tdb.select().from(schema.purchaseBills)
      .where(and(eq(schema.purchaseBills.id, id), eq(schema.purchaseBills.companyId, companyId)));
    if (!bill) {
      const err: any = new Error('Purchase bill not found.');
      err.status = 404;
      throw err;
    }
    if (!branchAccessOk(req, bill.branchId)) {
      const err: any = new Error('Forbidden: you are not assigned to this branch.');
      err.status = 403;
      throw err;
    }
    // A client-supplied bankId must actually belong to this company — otherwise a
    // malformed/malicious request could post a disbursement against another tenant's
    // bank account.
    if (bankId) {
      const [targetBank] = await tdb.select({ id: schema.bankAccounts.id }).from(schema.bankAccounts)
        .where(and(eq(schema.bankAccounts.id, bankId), eq(schema.bankAccounts.companyId, companyId)));
      if (!targetBank) {
        const err: any = new Error('Selected bank account was not found for this company.');
        err.status = 400;
        throw err;
      }
    }

    const voucherDate = date || nowDate().toISOString().split('T')[0];
    if (voucherDate < new Date(bill.date).toISOString().slice(0, 10)) {
      return res.status(400).json({ error: `A payment cannot be dated before the bill itself (${new Date(bill.date).toISOString().slice(0, 10)}).` });
    }
    // A payment is a dated cash entry: never into a closed fiscal month, never inside a quarter already filed with ZATCA.
    await validateTransactionDate(voucherDate, companyId);
    await assertQuarterNotFiled(voucherDate, companyId);
    const { bill: newBill, voucher } = await payPurchaseBillInFull(tdb, {
      companyId,
      billId: id,
      date: voucherDate,
      bankId,
      amount: amount !== undefined ? Number(amount) : undefined,
      userId: req.user.id,
    });

    // Same shape as create/edit's own response (`purchaseBill: <row>`, raw from
    // .returning()) — the client mirrors the server's own computed amountPaid/status
    // instead of re-deriving that arithmetic itself. `voucher` lets the client
    // immediately open a printable payment receipt — see DocumentRenderer.tsx's
    // renderVoucher, the same one ReportViewer.tsx's voucher register already prints from.
    res.json({ success: true, purchaseBill: newBill, voucher });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Cancel a Bill — only while Unpaid (once any payment has posted, a Cancel would leave a
// dangling Payment voucher with nothing to reconcile against; that's a correction, not a
// cancellation). Releases the referenced GRNs' isBilled flag so they can be re-billed.
router.patch('/purchase-bills/:id/cancel', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'purchaseBills.delete')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const companyId = req.targetCompanyId;
    const tdb = tenantDb();

    // No separate db.transaction() wrapper — withTenantDb already wraps the whole
    // request in one transaction; the row lock below still applies within it.
    const [bill] = await tdb.select().from(schema.purchaseBills)
      .where(and(eq(schema.purchaseBills.id, id), eq(schema.purchaseBills.companyId, companyId)))
      .for('update');
    if (!bill) {
      const err: any = new Error('Purchase bill not found.');
      err.status = 404;
      throw err;
    }
    if (!branchAccessOk(req, bill.branchId)) {
      const err: any = new Error('Forbidden: you are not assigned to this branch.');
      err.status = 403;
      throw err;
    }
    if (bill.status !== 'Unpaid') {
      const err: any = new Error(`Cannot cancel a bill that is not Unpaid (current status: ${bill.status}).`);
      err.status = 400;
      throw err;
    }
    // A Bill that already had a Purchase Return posted against one of its GRNs cannot be
    // cancelled outright: cancellation reverses entry 9's ORIGINAL full amount (the
    // return already reduced both the ledger's AP balance and this bill's own stored
    // total independently), and reversing the original on top of that would leave a
    // dangling AP balance with no bill left to net against — live-confirmed while
    // verifying this exact sequence. A Purchase Return is itself the correction
    // mechanism; cancelling on top of one is not a supported combination.
    const billGrnIds = bill.grnIds.split(',').filter(Boolean);
    if (billGrnIds.length > 0) {
      const [existingReturn] = await tdb.select({ id: schema.purchaseReturns.id }).from(schema.purchaseReturns)
        .where(and(inArray(schema.purchaseReturns.grnId, billGrnIds), eq(schema.purchaseReturns.status, 'Active')));
      if (existingReturn) {
        const err: any = new Error('This bill already has a Purchase Return recorded against it and cannot be cancelled. The return is the correct way to reduce what is owed.');
        err.status = 400;
        throw err;
      }
    }
    // Cancelling is an edit to this bill, same as its creation already blocks once its
    // quarter has been filed with ZATCA (a filed return's reported input VAT would
    // otherwise silently go stale).
    await validateTransactionDate(bill.date.toISOString().slice(0, 10), companyId);   // not a closed month either
    await assertQuarterNotFrozen(bill.date.toISOString().slice(0, 10), companyId);
    const [newBill] = await tdb.update(schema.purchaseBills)
      .set({ status: 'Cancelled' })
      .where(eq(schema.purchaseBills.id, id))
      .returning();

    const grnIds = bill.grnIds.split(',').filter(Boolean);
    if (grnIds.length > 0) {
      await tdb.update(schema.goodsReceiptNotes)
        .set({ isBilled: false })
        .where(inArray(schema.goodsReceiptNotes.id, grnIds));
    }

    // Phase 3 ledger posting (row 11) — reverses entry 9's three lines in full (Unpaid
    // only, already enforced above, so there is never a payment entry to worry about here).
    await reverseAllEntriesFor(tdb, companyId, 'PurchaseBill', id, nowDate().toISOString().slice(0, 10), `Purchase Bill ${bill.billNumber} cancelled`, req.user.id);

    const updated = newBill;

    res.json({ success: true, purchaseBill: normalizePurchaseBillForClient(updated) });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// --- Purchase Returns (Debit Notes) ---
// A return references a single GRN and can never return more of a product/batch than that
// GRN actually received minus whatever's already been returned against it — the same
// "can't exceed the source document" 3-way-match discipline as Purchase Bills, applied to
// the reverse flow. Decrements stock and is allowed to go negative — the return is validated
// against the GRN's own remaining-returnable quantity above, not against current on-hand
// (some of the original receipt may have already been sold elsewhere), so clamping the
// resulting on-hand at 0 would silently lose that real deficit, same reasoning as
// deductStockForSale in businessLogic.ts. DOES unwind averageCost (and GRN reversal,
// below, does too) — found missing during this session's report reconciliation: without
// it, the Balance Sheet's qty*averageCost inventory figure silently drifted away from
// the ledger's own (specific-cost) INVENTORY account on every return.
router.post('/purchase-returns', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'purchaseReturns.create')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { returnData } = req.body || {};
    if (!returnData || !returnData.grnId || !Array.isArray(returnData.items) || returnData.items.length === 0) {
      return res.status(400).json({ error: 'A goods receipt note and at least one returned item are required.' });
    }
    const companyId = req.targetCompanyId;
    const tdb = tenantDb();

    // No separate db.transaction() wrapper — withTenantDb already wraps the whole
    // request in one transaction; the row lock below still applies within it.
    const [grn] = await tdb.select().from(schema.goodsReceiptNotes)
      .where(and(eq(schema.goodsReceiptNotes.id, returnData.grnId), eq(schema.goodsReceiptNotes.companyId, companyId)))
      .for('update');
    if (!grn) {
      const err: any = new Error('Goods receipt note not found.');
      err.status = 404;
      throw err;
    }
    if (!(await branchAccessOkViaWarehouse(tdb, req, grn.warehouseId))) {
      const err: any = new Error('Forbidden: you are not assigned to this branch.');
      err.status = 403;
      throw err;
    }
    if (grn.isReversed) {
      const err: any = new Error('This receipt has been reversed and cannot be returned against.');
      err.status = 400;
      throw err;
    }
    // Purchase Returns always post as of today (date: nowDate() below), same as
    // Purchase Bills — no client-supplied backdating, so this is a same-day check only.
    // This route previously had neither the open-month nor the filed-quarter check at
    // all, unlike every sibling financial-document route.
    await validateTransactionDate(nowDate().toISOString().slice(0, 10), companyId);
    await assertQuarterNotFrozen(nowDate().toISOString().slice(0, 10), companyId);
    // Belt-and-suspenders alongside the received-quantity check below (lines ~1244-1256
    // already reject returning more than was actually received against this GRN, which
    // in practice also rejects any productId that was never received at all — but that's
    // an indirect consequence of the quantity math, not an explicit ownership check, and
    // doesn't cover a zero-quantity line). Found by a static isolation check.
    await assertProductsOwnedByCompany(tdb, companyId, returnData.items.map((it: any) => it.productId));

    const grnItems = await tdb.select().from(schema.goodsReceiptNoteItems).where(eq(schema.goodsReceiptNoteItems.grnId, grn.id));
    const priorReturns = await tdb.select({
      productId: schema.purchaseReturnItems.productId,
      batchNumber: schema.purchaseReturnItems.batchNumber,
      quantityReturned: schema.purchaseReturnItems.quantityReturned,
      unitOfMeasureId: schema.purchaseReturnItems.unitOfMeasureId,
    })
      .from(schema.purchaseReturnItems)
      .innerJoin(schema.purchaseReturns, eq(schema.purchaseReturnItems.returnId, schema.purchaseReturns.id))
      .where(and(eq(schema.purchaseReturns.grnId, grn.id), eq(schema.purchaseReturns.status, 'Active')));

    // "Remaining returnable" is computed entirely in base-unit terms — the original GRN
    // receipt, any prior returns against it, and this new return line can each use a
    // different unit (e.g. received in Cartons, returned loose).
    const priorReturnedByKey = new Map<string, number>();
    for (const row of priorReturns) {
      const key = `${row.productId}|${row.batchNumber || ''}`;
      const baseQty = await toBaseQuantity(tdb, row.productId, row.unitOfMeasureId, companyId, Number(row.quantityReturned));
      priorReturnedByKey.set(key, (priorReturnedByKey.get(key) || 0) + baseQty);
    }

    for (const item of returnData.items) {
      const key = `${item.productId}|${item.batchNumber || ''}`;
      const receivedRow = grnItems.find((gi: any) => gi.productId === item.productId && (gi.batchNumber || '') === (item.batchNumber || ''));
      const receivedQty = receivedRow ? await toBaseQuantity(tdb, item.productId, receivedRow.unitOfMeasureId, companyId, Number(receivedRow.quantityReceived)) : 0;
      const alreadyReturned = priorReturnedByKey.get(key) || 0;
      const availableToReturn = round2(receivedQty - alreadyReturned);
      const returnBaseQty = await toBaseQuantity(tdb, item.productId, item.unitOfMeasureId, companyId, Number(item.quantityReturned));
      if (returnBaseQty > availableToReturn + 0.001) {
        const err: any = new Error(`Cannot return ${item.quantityReturned} units of this item — only ${availableToReturn} (base unit) remain returnable from this receipt.`);
        err.status = 400;
        throw err;
      }
    }

    // purchaseReturns has no branchId column of its own — derived via the GRN's
    // warehouseId, same as GRN numbering above.
    const [returnWarehouse] = await tdb.select({ branchId: schema.warehouses.branchId }).from(schema.warehouses).where(eq(schema.warehouses.id, grn.warehouseId));
    const returnNumber = await getAndIncrementDocumentNumber(tdb, companyId, 'return', nowDate().toISOString().slice(0, 10), returnWarehouse?.branchId || null);
    const returnId = generateId();

    const [newReturn] = await tdb.insert(schema.purchaseReturns).values({
      id: returnId,
      returnNumber,
      grnId: grn.id,
      vendorId: grn.vendorId,
      warehouseId: grn.warehouseId,
      date: nowDate(),
      notes: returnData.notes || null,
      status: 'Active',
      companyId,
    }).returning();

    const itemRows = returnData.items.map((item: any) => ({
      id: generateId(),
      returnId,
      productId: item.productId,
      quantityReturned: String(item.quantityReturned),
      batchNumber: item.batchNumber || null,
      unitOfMeasureId: item.unitOfMeasureId || null,
    }));
    const insertedItems = await tdb.insert(schema.purchaseReturnItems).values(itemRows).returning();

    // Accumulated for row 13's ledger posting below — purchaseReturnItems carries no
    // cost of its own (only quantity/batch/unit), so each returned line's value is
    // looked up from the ORIGINAL GRN item it corresponds to (same productId+batch),
    // converted to base-unit terms exactly like the GRN receipt itself was.
    const valuationBefore = await snapshotInventory(tdb, companyId, (returnData.items || []).map((i: any) => i.productId));
    let returnValue = 0;
    let returnTax = 0;

    for (const item of returnData.items) {
      const [product] = await tdb.select({
        itemKind: schema.productsServices.itemKind,
        averageCost: schema.productsServices.averageCost,
        totalQuantityPurchased: schema.productsServices.totalQuantityPurchased,
      }).from(schema.productsServices).where(eq(schema.productsServices.id, item.productId)).for('update');
      if (!product || product.itemKind !== 'item') continue;

      const baseQtyReturned = await toBaseQuantity(tdb, item.productId, item.unitOfMeasureId, companyId, Number(item.quantityReturned));

      const grnItem = grnItems.find((gi: any) => gi.productId === item.productId && (gi.batchNumber || '') === (item.batchNumber || ''));
      if (grnItem) {
        const baseUnitCost = await toBaseUnitCost(tdb, item.productId, grnItem.unitOfMeasureId, companyId, Number(grnItem.unitCost));
        const lineValue = round2(baseQtyReturned * baseUnitCost);
        returnValue = round2(returnValue + lineValue);
        returnTax = round2(returnTax + round2(lineValue * (Number(grnItem.taxRate || 0) / 100)));

        // Unwind this return's exact contribution from the weighted-average cost — the
        // mirror image of the GRN receipt's own fold (this file, ~line 495-505). Same
        // totalQuantityPurchased-as-weight convention, run backwards, valued at THIS
        // return's own originating GRN line's unit cost (never today's average) — the
        // same specific-cost basis the ledger's own INVENTORY account already uses for
        // this line (Row 13, below). Without this, averageCost only ever goes up
        // (documented forward-only behavior), so the Balance Sheet's qty*averageCost
        // inventory figure would silently drift away from the ledger's own INVENTORY
        // balance on every return — found during this session's report reconciliation.
        const priorQty = Number(product.totalQuantityPurchased || 0);
        const priorAvg = Number(product.averageCost || 0);
        const newQty = round2(priorQty - baseQtyReturned);
        const newAvg = newQty > 0 ? round4((priorQty * priorAvg - baseQtyReturned * baseUnitCost) / newQty) : priorAvg;
        await tdb.update(schema.productsServices)
          .set({ averageCost: String(newAvg), totalQuantityPurchased: String(Math.max(0, newQty)) })
          .where(eq(schema.productsServices.id, item.productId));
      }

      const batchCondition = item.batchNumber
        ? eq(schema.inventoryStocks.batchNumber, item.batchNumber)
        : isNull(schema.inventoryStocks.batchNumber);
      const [existingStock] = await tdb.select().from(schema.inventoryStocks)
        .where(and(
          eq(schema.inventoryStocks.productId, item.productId),
          eq(schema.inventoryStocks.warehouseId, grn.warehouseId),
          eq(schema.inventoryStocks.companyId, companyId),
          batchCondition
        ))
        .for('update');
      if (existingStock) {
        const priorQty = Number(existingStock.quantity);
        const newQty = round2(priorQty - baseQtyReturned);
        await tdb.update(schema.inventoryStocks).set({ quantity: String(newQty) }).where(eq(schema.inventoryStocks.id, existingStock.id));
        await writeStockLedgerEntry(tdb, {
          productId: item.productId, warehouseId: grn.warehouseId, companyId,
          transactionType: 'Return', referenceId: returnId, date: newReturn.date as Date,
          quantityChange: newQty - priorQty, endingQuantity: newQty,
          batchNumber: item.batchNumber || null,
        });
      }
    }

    // Phase 3 ledger posting (row 13) — branches on the GRN's billing state at return
    // time. Unbilled: no VAT was ever claimed, so only Inventory/GR-IR Clearing move.
    // Billed: the input-VAT claim on goods no longer held must be given back too, and
    // the debit side depends on whether the vendor still owes it (AP, if the bill isn't
    // fully paid yet) or whether the company is now owed a refund/credit instead
    // (Vendor Credit Receivable, once the bill was already paid in full).
    if (returnValue > 0) {
      let debitAccountKey = 'GR_IR_CLEARING';
      let debitAmount = returnValue;
      let includeVat = false;
      let billReduction = 0;
      let vendorCreditPart = 0;
      if (grn.isBilled) {
        includeVat = true;
        const vendorBills = await tdb.select().from(schema.purchaseBills)
          .where(and(eq(schema.purchaseBills.companyId, companyId), eq(schema.purchaseBills.vendorId, grn.vendorId), ne(schema.purchaseBills.status, 'Cancelled')));
        const owningBill = vendorBills.find((b: any) => (b.grnIds || '').split(',').includes(grn.id));
        debitAmount = round2(returnValue + returnTax);
        // THE RULE: only what is still unpaid on the bill can reduce it. Whatever part of the return had ALREADY been paid to the vendor is
        // money the vendor now owes back — a vendor credit receivable, never a negative payable. (A fully paid bill: all of it is credit.)
        const unpaidOnBill = owningBill ? Math.max(0, round2(Number(owningBill.grandTotal) - Number(owningBill.amountPaid || 0))) : 0;
        billReduction = owningBill ? round2(Math.min(debitAmount, unpaidOnBill)) : 0;
        vendorCreditPart = round2(debitAmount - billReduction);

        // Reduce the owning Bill's own stored totals to match what AP was just reduced
        // by — without this, the Bill still shows its full original grandTotal as owed
        // even though this return already reduced the real liability, and
        // payPurchaseBillInFull's "remaining" math would let the company overpay the
        // vendor by the returned amount. Only when the vendor still owes it (not the
        // Vendor-Credit-Receivable case, where the original bill genuinely was paid in
        // full and stays as paid history).
        if (owningBill && billReduction > 0.004) {
          const taxCut = debitAmount > 0 ? round2(billReduction * returnTax / debitAmount) : 0;
          await tdb.update(schema.purchaseBills).set({
            subTotal: String(round2(Math.max(0, Number(owningBill.subTotal) - (billReduction - taxCut)))),
            taxTotal: String(round2(Math.max(0, Number(owningBill.taxTotal) - taxCut))),
            grandTotal: String(round2(Math.max(0, Number(owningBill.grandTotal) - billReduction))),
          }).where(eq(schema.purchaseBills.id, owningBill.id));
        }
        // Record the input-VAT adjustment on the return itself, so the VAT return books it in THIS return's
        // period whether or not the bill's own totals were reduced above (they are not when it was paid).
        if (owningBill) {
          await tdb.update(schema.purchaseReturns).set({
            billId: owningBill.id,
            netAdjustment: String(returnValue),
            inputVatAdjustment: String(returnTax),
            billTotalsReduced: billReduction > 0.004,
            billReduction: String(billReduction),
          }).where(eq(schema.purchaseReturns.id, returnId));
        }
      }
      const returnEntryId = await postJournalEntry(tdb, {
        companyId,
        branchId: returnWarehouse?.branchId || null,
        date: (newReturn.date as Date).toISOString().slice(0, 10),
        referenceType: 'PurchaseReturn',
        referenceId: returnId,
        description: `Purchase Return ${returnNumber} against GRN ${grn.grnNumber}`,
        createdById: req.user.id,
        lines: grn.isBilled
          ? [
              ...(billReduction > 0 ? [{ accountKey: 'AP', debit: billReduction }] : []),
              ...(vendorCreditPart > 0 ? [{ accountKey: 'VENDOR_CREDIT_RECEIVABLE', debit: vendorCreditPart }] : []),
              { accountKey: 'INVENTORY', credit: returnValue },
              ...(returnTax > 0 ? [{ accountKey: 'VAT_INPUT', credit: returnTax }] : []),
            ]
          : [
              { accountKey: debitAccountKey, debit: debitAmount },
              { accountKey: 'INVENTORY', credit: returnValue },
            ],
      });
      await settleInventoryValuation(tdb, { companyId, branchId: returnWarehouse?.branchId || null, date: (newReturn.date as Date).toISOString().slice(0, 10), before: valuationBefore, entryIds: [returnEntryId], referenceType: 'PurchaseReturn', referenceId: returnId, description: `Inventory revaluation on return ${returnNumber}`, createdById: req.user.id });
    }

    const created = { ...newReturn, items: insertedItems };

    res.json({ success: true, purchaseReturn: created });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Cancel (the 'delete' leaf) a return — reverses the stock decrement it posted. No separate
// edit route: like a GRN, a posted return is a point-in-time stock movement record: the
// correction path is cancel-and-repost, not silently rewriting history. purchaseReturns.
// update stays defined in the permission registry for shape-consistency with every other
// CRUD module even though no route currently checks it.
router.patch('/purchase-returns/:id/cancel', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'purchaseReturns.delete')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const companyId = req.targetCompanyId;
    const tdb = tenantDb();

    // No separate db.transaction() wrapper — withTenantDb already wraps the whole
    // request in one transaction; the row lock below still applies within it.
    const [ret] = await tdb.select().from(schema.purchaseReturns)
      .where(and(eq(schema.purchaseReturns.id, id), eq(schema.purchaseReturns.companyId, companyId)))
      .for('update');
    if (!ret) {
      const err: any = new Error('Purchase return not found.');
      err.status = 404;
      throw err;
    }
    if (!(await branchAccessOkViaWarehouse(tdb, req, ret.warehouseId))) {
      const err: any = new Error('Forbidden: you are not assigned to this branch.');
      err.status = 403;
      throw err;
    }
    if (ret.status === 'Cancelled') {
      const err: any = new Error('This return has already been cancelled.');
      err.status = 400;
      throw err;
    }
    // Cancelling is an edit to this return, same as its creation now blocks once its
    // quarter has been filed with ZATCA.
    await validateTransactionDate(ret.date.toISOString().slice(0, 10), companyId);   // not a closed month either
    await assertQuarterNotFrozen(ret.date.toISOString().slice(0, 10), companyId);
    // The part of this return that had already been paid is a vendor credit. If the vendor has refunded it (or it has been used), cancelling the
    // return would leave a refund with nothing to back it: reverse the refund first.
    {
      const retGross = round2(Number(ret.netAdjustment || 0) + Number(ret.inputVatAdjustment || 0));
      const retReduction = ret.billReduction != null ? Number(ret.billReduction) : (ret.billTotalsReduced ? retGross : 0);
      const creditPart = round2(retGross - retReduction);
      if (creditPart > 0.004) {
        const available = await computeVendorCreditBalance(tdb, companyId, '9999-12-31', ret.vendorId);
        if (available + 0.004 < creditPart) {
          const err: any = new Error('The refund for this return has already been received from the vendor. Cancel that vendor refund first, then cancel the return.');
          err.status = 400;
          throw err;
        }
      }
    }

    const items = await tdb.select().from(schema.purchaseReturnItems).where(eq(schema.purchaseReturnItems.returnId, id));
    const valuationBefore = await snapshotInventory(tdb, companyId, items.map((i: any) => i.productId));
    for (const item of items) {
      const [product] = await tdb.select({ itemKind: schema.productsServices.itemKind })
        .from(schema.productsServices).where(eq(schema.productsServices.id, item.productId));
      if (!product || product.itemKind !== 'item') continue;

      const baseQtyReturned = await toBaseQuantity(tdb, item.productId, item.unitOfMeasureId, companyId, Number(item.quantityReturned));
      const batchCondition = item.batchNumber
        ? eq(schema.inventoryStocks.batchNumber, item.batchNumber)
        : isNull(schema.inventoryStocks.batchNumber);
      const [existingStock] = await tdb.select().from(schema.inventoryStocks)
        .where(and(
          eq(schema.inventoryStocks.productId, item.productId),
          eq(schema.inventoryStocks.warehouseId, ret.warehouseId),
          eq(schema.inventoryStocks.companyId, companyId),
          batchCondition
        ))
        .for('update');
      const cancelEndingQty = existingStock
        ? round2(Number(existingStock.quantity) + baseQtyReturned)
        : round2(baseQtyReturned);

      if (existingStock) {
        await tdb.update(schema.inventoryStocks)
          .set({ quantity: String(cancelEndingQty) })
          .where(eq(schema.inventoryStocks.id, existingStock.id));
      } else {
        await tdb.insert(schema.inventoryStocks).values({
          id: generateId(),
          productId: item.productId,
          warehouseId: ret.warehouseId,
          batchNumber: item.batchNumber || null,
          quantity: String(baseQtyReturned),
          companyId,
        });
      }
      await writeStockLedgerEntry(tdb, {
        productId: item.productId, warehouseId: ret.warehouseId, companyId,
        transactionType: 'Return', referenceId: ret.id, date: nowDate(),
        quantityChange: baseQtyReturned, endingQuantity: cancelEndingQty,
        batchNumber: item.batchNumber || null,
      });
    }

    const [newReturn] = await tdb.update(schema.purchaseReturns)
      .set({ status: 'Cancelled' })
      .where(eq(schema.purchaseReturns.id, id))
      .returning();
    const updated = newReturn;

    // Cancelling gives the goods back to the vendor's bill: if this return had reduced the owning bill's
    // stored totals, restore them (stock and the ledger were already being rolled back; the bill was left
    // understated, so its payable disagreed with the ledger's AP).
    if (ret.billTotalsReduced && ret.billId) {
      const [bill] = await tdb.select().from(schema.purchaseBills).where(eq(schema.purchaseBills.id, ret.billId)).for('update');
      if (bill) {
        const net = Number(ret.netAdjustment || 0), vat = Number(ret.inputVatAdjustment || 0);
        const reduction = ret.billReduction != null ? Number(ret.billReduction) : round2(net + vat);   // older rows: the whole return
        const taxPart = net + vat > 0 ? round2(reduction * vat / (net + vat)) : 0;
        await tdb.update(schema.purchaseBills).set({
          subTotal: String(round2(Number(bill.subTotal) + (reduction - taxPart))),
          taxTotal: String(round2(Number(bill.taxTotal) + taxPart)),
          grandTotal: String(round2(Number(bill.grandTotal) + reduction)),
        }).where(eq(schema.purchaseBills.id, bill.id));
      }
    }

    // Ledger posting: reverses row 13's entry in full — a cancelled return already rolls
    // the physical stock back above, so the ledger must follow it or Inventory/GR-IR/AP/
    // Vendor Credit would be left permanently out of step with what's actually on hand.
    const returnCancelDate = nowDate().toISOString().slice(0, 10);
    const returnCancelEntries = await reverseAllEntriesFor(tdb, companyId, 'PurchaseReturn', id, returnCancelDate, `Purchase Return ${ret.returnNumber} cancelled`, req.user.id);
    await settleInventoryValuation(tdb, { companyId, date: returnCancelDate, before: valuationBefore, entryIds: returnCancelEntries, referenceType: 'PurchaseReturn', referenceId: id, description: `Inventory revaluation on cancelling return ${ret.returnNumber}`, createdById: req.user.id });

    res.json({ success: true, purchaseReturn: updated });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// --- Physical Stock Takes (Cycle Counts) ---
// A stock take is a two-step Draft -> Completed lifecycle, matching real cycle-count
// practice: the count itself (systemQuantity snapshotted server-side at creation, never
// trusted from the client) doesn't touch stock at all — only finalizing does, posting one
// variance adjustment per line through the exact same clamped increment/insert path
// stock-adjustments already uses, so a stock take is never a second, diverging way to
// move stock.
router.post('/stock-takes', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'stockTakes.create')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { stockTakeData } = req.body || {};
    if (!stockTakeData || !stockTakeData.warehouseId || !Array.isArray(stockTakeData.items) || stockTakeData.items.length === 0) {
      return res.status(400).json({ error: 'A warehouse and at least one counted item are required.' });
    }
    const companyId = req.targetCompanyId;
    const tdb = tenantDb();

    // No separate db.transaction() wrapper — withTenantDb already wraps the whole
    // request in one transaction.
    // physicalStockTakes has no branchId column of its own — derived via warehouseId,
    // same pattern as GRN/Purchase Return numbering above. Also the only ownership check
    // on stockTakeData.warehouseId anywhere in this route — previously unscoped by
    // companyId entirely, same class of gap as GRN/stock-adjustments above.
    const [stWarehouse] = await tdb.select({ branchId: schema.warehouses.branchId }).from(schema.warehouses)
      .where(and(eq(schema.warehouses.id, stockTakeData.warehouseId), eq(schema.warehouses.companyId, companyId)));
    if (!stWarehouse) {
      const err: any = new Error('Selected warehouse not found for this company.');
      err.status = 400;
      throw err;
    }
    if (!branchAccessOk(req, stWarehouse.branchId)) {
      const err: any = new Error('Forbidden: you are not assigned to this branch.');
      err.status = 403;
      throw err;
    }
    await assertProductsOwnedByCompany(tdb, companyId, stockTakeData.items.map((it: any) => it.productId));
    const referenceNumber = await getAndIncrementDocumentNumber(tdb, companyId, 'stockTake', nowDate().toISOString().slice(0, 10), stWarehouse?.branchId || null);
    const stockTakeId = generateId();

    const [newStockTake] = await tdb.insert(schema.physicalStockTakes).values({
      id: stockTakeId,
      referenceNumber,
      warehouseId: stockTakeData.warehouseId,
      date: nowDate(),
      status: 'Draft',
      performedBy: stockTakeData.performedBy,
      notes: stockTakeData.notes || null,
      companyId,
    }).returning();

    const itemRows = [];
    for (const item of stockTakeData.items) {
      const batchCondition = item.batchNumber
        ? eq(schema.inventoryStocks.batchNumber, item.batchNumber)
        : isNull(schema.inventoryStocks.batchNumber);
      const [existingStock] = await tdb.select().from(schema.inventoryStocks)
        .where(and(
          eq(schema.inventoryStocks.productId, item.productId),
          eq(schema.inventoryStocks.warehouseId, stockTakeData.warehouseId),
          eq(schema.inventoryStocks.companyId, companyId),
          batchCondition
        ));
      const systemQuantity = existingStock ? Number(existingStock.quantity) : 0;
      const physicalQuantity = Number(item.physicalQuantity);
      // `physicalQuantity` is stored exactly as counted (e.g. "3" when counting 3
      // cartons, for display) — `variance` is computed against the base-unit-converted
      // count, since `systemQuantity` above is always in base-unit terms.
      const basePhysicalQuantity = await toBaseQuantity(tdb, item.productId, item.unitOfMeasureId, companyId, physicalQuantity);
      itemRows.push({
        id: generateId(),
        stockTakeId,
        productId: item.productId,
        batchNumber: item.batchNumber || null,
        systemQuantity: String(systemQuantity),
        physicalQuantity: String(physicalQuantity),
        variance: String(round2(basePhysicalQuantity - systemQuantity)),
        unitOfMeasureId: item.unitOfMeasureId || null,
      });
    }
    const insertedItems = await tdb.insert(schema.physicalStockTakeItems).values(itemRows).returning();

    const created = { ...newStockTake, items: insertedItems };

    res.json({ success: true, stockTake: created });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Finalize a Draft stock take — posts one stock adjustment per line (only for lines with a
// non-zero variance) and locks the count as Completed. Recomputes each line's variance
// against the CURRENT stock quantity at finalize time (not the quantity snapshotted at
// count time) and posts that as the adjustment, so a GRN/sale/another stock take that
// happened between counting and finalizing is respected rather than silently overwritten.
router.post('/stock-takes/:id/finalize', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'stockTakes.update')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const companyId = req.targetCompanyId;
    const tdb = tenantDb();
    // Posts cost to the P&L dated today, so it must not land in a closed month or a quarter already filed with ZATCA.
    const guardDate = nowDate().toISOString().slice(0, 10);
    await validateTransactionDate(guardDate, companyId);
    await assertQuarterNotFiled(guardDate, companyId);

    // No separate db.transaction() wrapper — withTenantDb already wraps the whole
    // request in one transaction; the row lock below still applies within it.
    const [stockTake] = await tdb.select().from(schema.physicalStockTakes)
      .where(and(eq(schema.physicalStockTakes.id, id), eq(schema.physicalStockTakes.companyId, companyId)))
      .for('update');
    if (!stockTake) {
      const err: any = new Error('Stock take not found.');
      err.status = 404;
      throw err;
    }
    if (!(await branchAccessOkViaWarehouse(tdb, req, stockTake.warehouseId))) {
      const err: any = new Error('Forbidden: you are not assigned to this branch.');
      err.status = 403;
      throw err;
    }
    if (stockTake.status !== 'Draft') {
      const err: any = new Error(`Cannot finalize a stock take that is not Draft (current status: ${stockTake.status}).`);
      err.status = 400;
      throw err;
    }

    const items = await tdb.select().from(schema.physicalStockTakeItems).where(eq(schema.physicalStockTakeItems.stockTakeId, id));
    const takeBefore = await snapshotInventory(tdb, companyId, items.map((i: any) => i.productId));
    const [takeWarehouse] = await tdb.select({ branchId: schema.warehouses.branchId }).from(schema.warehouses).where(eq(schema.warehouses.id, stockTake.warehouseId));

    for (const item of items) {
      const [product] = await tdb.select({ itemKind: schema.productsServices.itemKind })
        .from(schema.productsServices).where(eq(schema.productsServices.id, item.productId));
      if (!product || product.itemKind !== 'item') continue;

      const batchCondition = item.batchNumber
        ? eq(schema.inventoryStocks.batchNumber, item.batchNumber)
        : isNull(schema.inventoryStocks.batchNumber);
      const [existingStock] = await tdb.select().from(schema.inventoryStocks)
        .where(and(
          eq(schema.inventoryStocks.productId, item.productId),
          eq(schema.inventoryStocks.warehouseId, stockTake.warehouseId),
          eq(schema.inventoryStocks.companyId, companyId),
          batchCondition
        ))
        .for('update');
      const currentQty = existingStock ? Number(existingStock.quantity) : 0;
      // `physicalQuantity` is stored exactly as counted (whatever unit the line used);
      // converted to base-unit terms here since that's the only quantity
      // inventoryStocks ever holds.
      const targetQty = await toBaseQuantity(tdb, item.productId, item.unitOfMeasureId, companyId, Number(item.physicalQuantity));
      if (round2(targetQty - currentQty) === 0) continue;

      const finalizedQty = Math.max(0, round2(targetQty));
      if (existingStock) {
        await tdb.update(schema.inventoryStocks)
          .set({ quantity: String(finalizedQty) })
          .where(eq(schema.inventoryStocks.id, existingStock.id));
      } else if (targetQty > 0) {
        await tdb.insert(schema.inventoryStocks).values({
          id: generateId(),
          productId: item.productId,
          warehouseId: stockTake.warehouseId,
          batchNumber: item.batchNumber || null,
          quantity: String(round2(targetQty)),
          companyId,
        });
      } else {
        continue;
      }
      await writeStockLedgerEntry(tdb, {
        productId: item.productId, warehouseId: stockTake.warehouseId, companyId,
        transactionType: 'StockTake', referenceId: stockTake.id, date: nowDate(),
        quantityChange: round2(finalizedQty - currentQty), endingQuantity: finalizedQty,
        batchNumber: item.batchNumber || null,
      });
    }
    // The count's variances (shortages are a cost, overages a gain) = the change in valuation of the products counted, in whole cents.
    await settleInventoryValuation(tdb, {
      companyId, branchId: takeWarehouse?.branchId ?? null, date: nowDate().toISOString().slice(0, 10), before: takeBefore, entryIds: [],
      referenceType: 'StockTake', referenceId: stockTake.id, description: `Stock take variance (${stockTake.id.slice(0, 8)})`, createdById: req.user.id,
    });

    const [updatedStockTake] = await tdb.update(schema.physicalStockTakes)
      .set({ status: 'Completed' })
      .where(eq(schema.physicalStockTakes.id, id))
      .returning();
    const result = updatedStockTake;

    res.json({ success: true, stockTake: result });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Cancel a Draft stock take — a Completed one can't be cancelled (its adjustments already
// posted; correcting that needs a fresh stock take or manual adjustment, same reasoning as
// Purchase Bills refusing to cancel once paid).
router.patch('/stock-takes/:id/cancel', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'stockTakes.delete')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const companyId = req.targetCompanyId;
    const tdb = tenantDb();

    // No separate db.transaction() wrapper — withTenantDb already wraps the whole
    // request in one transaction; the row lock below still applies within it.
    const [stockTake] = await tdb.select().from(schema.physicalStockTakes)
      .where(and(eq(schema.physicalStockTakes.id, id), eq(schema.physicalStockTakes.companyId, companyId)))
      .for('update');
    if (!stockTake) {
      const err: any = new Error('Stock take not found.');
      err.status = 404;
      throw err;
    }
    if (!(await branchAccessOkViaWarehouse(tdb, req, stockTake.warehouseId))) {
      const err: any = new Error('Forbidden: you are not assigned to this branch.');
      err.status = 403;
      throw err;
    }
    if (stockTake.status !== 'Draft') {
      const err: any = new Error(`Cannot cancel a stock take that is not Draft (current status: ${stockTake.status}).`);
      err.status = 400;
      throw err;
    }
    const [newStockTake] = await tdb.update(schema.physicalStockTakes)
      .set({ status: 'Cancelled' })
      .where(eq(schema.physicalStockTakes.id, id))
      .returning();
    const updated = newStockTake;

    res.json({ success: true, stockTake: updated });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

export default router;
