import express from 'express';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and, isNull, inArray } from 'drizzle-orm';
import { round2, round4, writeStockLedgerEntry, assertQuarterNotFiled } from '../lib/businessLogic.js';
import { getAndIncrementDocumentNumber } from '../lib/documentNumbering.js';
import { hasPermission, resolveDocumentBranchId, branchAccessOk, branchAccessOkViaWarehouse } from '../lib/authz.js';
import { toBaseQuantity, toBaseUnitCost } from '../lib/uomConversion.js';
import { generateId } from '../../src/id.js';

const router = express.Router();

// Purchase Requisitions, Purchase Orders and Goods Receipt Notes previously had their
// "next number" derived client-side from `array.length + 1001` (see InventoryModule.tsx
// history) — reproducibly duplicated under concurrent creation, the same class of bug
// already fixed for invoice/quotation/expense/voucher numbering. These routes reuse the
// same `getAndIncrementDocumentNumber` (atomic upsert, company-wide, per-company-
// configurable) mechanism so PR/PO/GRN numbering is safe under real concurrency too.

// --- Purchase Requisitions ---
router.post('/purchase-requisitions', async (req: any, res) => {
  try {
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

    const created = await db.transaction(async (tx) => {
      const todayIso = new Date().toISOString().slice(0, 10);
      const prNumber = await getAndIncrementDocumentNumber(tx, companyId, 'pr', todayIso, branchId);
      const prId = generateId();

      const [newPr] = await tx.insert(schema.purchaseRequisitions).values({
        id: prId,
        prNumber,
        requestedBy: prData.requestedBy,
        date: new Date(),
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
      const insertedItems = await tx.insert(schema.purchaseRequisitionItems).values(itemRows).returning();

      return { ...newPr, items: insertedItems };
    });

    res.json({ success: true, purchaseRequisition: created });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Edit a Pending PR's items/notes — the submitter-tier action (inventory.pr), not gated by
// inventory.approve since editing your own not-yet-approved request isn't an approval
// action. Only a 'Pending' PR may be edited.
router.put('/purchase-requisitions/:id', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'inventory.pr')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const { prData } = req.body || {};
    if (!prData || !Array.isArray(prData.items) || prData.items.length === 0) {
      return res.status(400).json({ error: 'At least one requested item is required.' });
    }
    const companyId = req.targetCompanyId;

    const updated = await db.transaction(async (tx) => {
      const [pr] = await tx.select().from(schema.purchaseRequisitions)
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

      const [newPr] = await tx.update(schema.purchaseRequisitions)
        .set({ notes: prData.notes !== undefined ? prData.notes : pr.notes })
        .where(eq(schema.purchaseRequisitions.id, id))
        .returning();

      await tx.delete(schema.purchaseRequisitionItems).where(eq(schema.purchaseRequisitionItems.requisitionId, id));
      const itemRows = prData.items.map((item: any) => ({
        id: generateId(),
        requisitionId: id,
        productId: item.productId,
        quantity: String(item.quantity),
        purpose: item.purpose || null,
      }));
      const insertedItems = await tx.insert(schema.purchaseRequisitionItems).values(itemRows).returning();

      return { ...newPr, items: insertedItems };
    });

    res.json({ success: true, purchaseRequisition: updated });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Withdraw a Pending PR — the submitter's own action (inventory.pr), separate from
// approve/reject (inventory.approve): pulling back your own not-yet-actioned request isn't
// an approval authority. Only a 'Pending' PR may be withdrawn.
router.patch('/purchase-requisitions/:id/withdraw', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'inventory.pr')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const companyId = req.targetCompanyId;

    const updated = await db.transaction(async (tx) => {
      const [pr] = await tx.select().from(schema.purchaseRequisitions)
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
      const [newPr] = await tx.update(schema.purchaseRequisitions)
        .set({ status: 'Cancelled' })
        .where(eq(schema.purchaseRequisitions.id, id))
        .returning();
      return newPr;
    });

    res.json({ success: true, purchaseRequisition: updated });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// --- Purchase Orders ---
router.post('/purchase-orders', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'inventory.po')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { poData } = req.body || {};
    if (!poData || !poData.vendorId || !Array.isArray(poData.items) || poData.items.length === 0) {
      return res.status(400).json({ error: 'A vendor and at least one item are required.' });
    }
    const companyId = req.targetCompanyId;

    const [company] = await db.select({ inventorySettings: schema.companies.inventorySettings })
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
        const [linkedPr] = await db.select({ branchId: schema.purchaseRequisitions.branchId }).from(schema.purchaseRequisitions)
          .where(and(eq(schema.purchaseRequisitions.id, poData.requisitionId), eq(schema.purchaseRequisitions.companyId, companyId)));
        requestedBranchId = linkedPr?.branchId || undefined;
      }
      poBranchId = await resolveDocumentBranchId(req, requestedBranchId);
    } catch (branchErr: any) {
      return res.status(branchErr.status || 400).json({ error: branchErr.error || 'Invalid branch.' });
    }

    const created = await db.transaction(async (tx) => {
      // If a requisition is referenced (regardless of prOptionality — a stale/rejected/
      // already-closed PR is never a valid source, in any mode), row-lock and validate it
      // before using it, same pattern as the GRN route's purchase-order lock below.
      if (poData.requisitionId) {
        const [pr] = await tx.select().from(schema.purchaseRequisitions)
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

      const poNumber = await getAndIncrementDocumentNumber(tx, companyId, 'po', new Date().toISOString().slice(0, 10), poBranchId);
      const poId = generateId();

      const [newPo] = await tx.insert(schema.purchaseOrders).values({
        id: poId,
        poNumber,
        vendorId: poData.vendorId,
        date: new Date(),
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
      const insertedItems = await tx.insert(schema.purchaseOrderItems).values(itemRows).returning();

      // Close the source PR (if any) within the same transaction so a PR never stays
      // "Approved" after it's already been actioned into a PO.
      if (poData.requisitionId) {
        await tx.update(schema.purchaseRequisitions)
          .set({ status: 'Closed' })
          .where(and(
            eq(schema.purchaseRequisitions.id, poData.requisitionId),
            eq(schema.purchaseRequisitions.companyId, companyId)
          ));
      }

      return { ...newPo, items: insertedItems };
    });

    res.json({ success: true, purchaseOrder: created });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// --- Goods Receipt Notes ---
router.post('/goods-receipt-notes', async (req: any, res) => {
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
    const companyId = req.targetCompanyId;

    if (grnData.isDsd) {
      const [company] = await db.select({ inventorySettings: schema.companies.inventorySettings })
        .from(schema.companies).where(eq(schema.companies.id, companyId));
      const isDsdAllowed = (company?.inventorySettings as any)?.isDsdAllowed ?? true;
      if (!isDsdAllowed) {
        return res.status(400).json({ error: 'Direct Shop Delivery is disabled for this company. Enable it in Company Setup, or link this receipt to a purchase order instead.' });
      }
    }

    let updatedPurchaseOrder: { id: string; status: string } | null = null;

    const created = await db.transaction(async (tx) => {
      let vendorId = grnData.vendorId;
      let linkedPo: any = null;

      if (!grnData.isDsd && grnData.purchaseOrderId) {
        // Row-lock the PO for the duration of this transaction: two GRNs racing against
        // the same PO must never both read "Sent"/"Partially Received" and both compute
        // themselves as the one that completes it.
        const [po] = await tx.select().from(schema.purchaseOrders)
          .where(and(eq(schema.purchaseOrders.id, grnData.purchaseOrderId), eq(schema.purchaseOrders.companyId, companyId)))
          .for('update');
        if (!po) {
          const err: any = new Error('Linked purchase order not found.');
          err.status = 404;
          throw err;
        }
        linkedPo = po;
        vendorId = po.vendorId;
      }

      // goodsReceiptNotes has no branchId column of its own (schema.ts) — derived via
      // warehouseId purely so includeBranchCode can format correctly if ever configured,
      // same lookup pattern as server.ts's branchOkViaWarehouse read-path predicate. Also
      // the ONLY place grnData.warehouseId is ever checked at all — previously unscoped
      // by companyId entirely (a real cross-tenant gap: a crafted request could receive
      // stock into another company's warehouse, with the resulting inventoryStocks/
      // stockLedgerTransactions rows filed under THIS caller's companyId, corrupting both
      // tenants' inventory records) and never checked against req.allowedBranchIds either.
      const [grnWarehouse] = await tx.select({ branchId: schema.warehouses.branchId }).from(schema.warehouses)
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
      const grnNumber = await getAndIncrementDocumentNumber(tx, companyId, 'grn', new Date().toISOString().slice(0, 10), grnWarehouse?.branchId || null);
      const grnId = generateId();

      const [newGrn] = await tx.insert(schema.goodsReceiptNotes).values({
        id: grnId,
        grnNumber,
        purchaseOrderId: grnData.isDsd ? null : (grnData.purchaseOrderId || null),
        vendorId,
        warehouseId: grnData.warehouseId,
        date: new Date(),
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
      const insertedItems = await tx.insert(schema.goodsReceiptNoteItems).values(itemRows).returning();

      // Update stock levels — lock each matching stock row before incrementing so two
      // concurrent GRNs touching the same product/warehouse/batch never lose an update
      // (read-then-write without a lock would let both read the same starting quantity).
      // `quantityReceived`/`unitCost` on the item itself stay exactly as entered (whatever
      // unit the line used, for billing/display); every inventory-quantity and averaging
      // calculation below uses the base-unit-converted values instead.
      for (const item of grnData.items) {
        const baseQtyReceived = await toBaseQuantity(tx, item.productId, item.unitOfMeasureId, companyId, Number(item.quantityReceived));
        const baseUnitCost = await toBaseUnitCost(tx, item.productId, item.unitOfMeasureId, companyId, Number(item.unitCost));

        const batchCondition = item.batchNumber
          ? eq(schema.inventoryStocks.batchNumber, item.batchNumber)
          : isNull(schema.inventoryStocks.batchNumber);

        const [existingStock] = await tx.select().from(schema.inventoryStocks)
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
          await tx.update(schema.inventoryStocks)
            .set({ quantity: String(grnEndingQty) })
            .where(eq(schema.inventoryStocks.id, existingStock.id));
        } else {
          await tx.insert(schema.inventoryStocks).values({
            id: generateId(),
            productId: item.productId,
            warehouseId: grnData.warehouseId,
            batchNumber: item.batchNumber || null,
            expiryDate: item.expiryDate ? new Date(item.expiryDate) : null,
            quantity: String(baseQtyReceived),
            companyId,
          });
        }
        await writeStockLedgerEntry(tx, {
          productId: item.productId, warehouseId: grnData.warehouseId, companyId,
          transactionType: 'GRN', referenceId: grnId, date: newGrn.date as Date,
          quantityChange: baseQtyReceived, endingQuantity: grnEndingQty,
          batchNumber: item.batchNumber || null,
        });

        // Fold this receipt into the product's weighted-average cost. Uses
        // totalQuantityPurchased (not current on-hand quantity) as the weight so the
        // average is unaffected by sales/adjustments that have drawn stock down since
        // earlier receipts — a pure moving-average-cost calculation, forward-only.
        const [product] = await tx.select({
          averageCost: schema.productsServices.averageCost,
          totalQuantityPurchased: schema.productsServices.totalQuantityPurchased,
        }).from(schema.productsServices).where(eq(schema.productsServices.id, item.productId)).for('update');
        if (product) {
          const priorQty = Number(product.totalQuantityPurchased || 0);
          const priorAvg = Number(product.averageCost || 0);
          const newQty = priorQty + baseQtyReceived;
          const newAvg = newQty > 0 ? round4((priorQty * priorAvg + baseQtyReceived * baseUnitCost) / newQty) : priorAvg;
          await tx.update(schema.productsServices)
            .set({ averageCost: String(newAvg), totalQuantityPurchased: String(round2(newQty)) })
            .where(eq(schema.productsServices.id, item.productId));
        }
      }

      // Determine the linked PO's fulfillment status from actual received-vs-ordered
      // quantities (summed across every GRN ever raised against it, including the one
      // just inserted above, since we're still inside the same transaction) instead of
      // unconditionally flipping it to "Received" the moment any GRN references it.
      if (linkedPo) {
        const poItems = await tx.select().from(schema.purchaseOrderItems)
          .where(eq(schema.purchaseOrderItems.purchaseOrderId, linkedPo.id));

        const priorGrnItems = await tx.select({
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
          const baseQty = await toBaseQuantity(tx, row.productId, row.unitOfMeasureId, companyId, Number(row.quantityReceived));
          receivedByProduct.set(row.productId, (receivedByProduct.get(row.productId) || 0) + baseQty);
        }

        let fullyReceived = poItems.length > 0;
        let anyReceived = false;
        for (const poItem of poItems) {
          const received = receivedByProduct.get(poItem.productId) || 0;
          const orderedBaseQty = await toBaseQuantity(tx, poItem.productId, poItem.unitOfMeasureId, companyId, Number(poItem.quantityOrdered));
          if (received > 0) anyReceived = true;
          if (received < orderedBaseQty) fullyReceived = false;
        }

        const newStatus = fullyReceived ? 'Received' : (anyReceived ? 'Partially Received' : linkedPo.status);
        if (newStatus !== linkedPo.status) {
          await tx.update(schema.purchaseOrders).set({ status: newStatus }).where(eq(schema.purchaseOrders.id, linkedPo.id));
        }
        updatedPurchaseOrder = { id: linkedPo.id, status: newStatus };
      }

      return { ...newGrn, items: insertedItems };
    });

    res.json({ success: true, goodsReceiptNote: created, updatedPurchaseOrder });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Reverse a GRN — the correction path for a wrong-quantity/wrong-batch receipt. Reverts
// the stock movement (clamped at 0, matching the stock-adjustments route's own clamping —
// a receipt that's already been partly consumed by a sale can't be reversed below 0), and
// recomputes the linked PO's fulfillment status from the remaining (non-reversed) GRNs.
// Deliberately does NOT unwind the product's average cost: a moving weighted average is
// forward-only by design — precisely reversing it would require replaying full receipt
// history, which no real ERP does. A materially wrong average cost from a bad receipt
// self-corrects as further receipts get folded in, or can be corrected via a manual stock
// adjustment if urgent.
router.post('/goods-receipt-notes/:id/reverse', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'inventory.grn')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const companyId = req.targetCompanyId;

    const result = await db.transaction(async (tx) => {
      const [grn] = await tx.select().from(schema.goodsReceiptNotes)
        .where(and(eq(schema.goodsReceiptNotes.id, id), eq(schema.goodsReceiptNotes.companyId, companyId)))
        .for('update');
      if (!grn) {
        const err: any = new Error('Goods receipt note not found.');
        err.status = 404;
        throw err;
      }
      if (!(await branchAccessOkViaWarehouse(tx, req, grn.warehouseId))) {
        const err: any = new Error('Forbidden: you are not assigned to this branch.');
        err.status = 403;
        throw err;
      }
      if (grn.isReversed) {
        const err: any = new Error('This receipt has already been reversed.');
        err.status = 400;
        throw err;
      }

      const items = await tx.select().from(schema.goodsReceiptNoteItems).where(eq(schema.goodsReceiptNoteItems.grnId, id));

      for (const item of items) {
        const batchCondition = item.batchNumber
          ? eq(schema.inventoryStocks.batchNumber, item.batchNumber)
          : isNull(schema.inventoryStocks.batchNumber);
        const [existingStock] = await tx.select().from(schema.inventoryStocks)
          .where(and(
            eq(schema.inventoryStocks.productId, item.productId),
            eq(schema.inventoryStocks.warehouseId, grn.warehouseId),
            eq(schema.inventoryStocks.companyId, companyId),
            batchCondition
          ))
          .for('update');
        if (existingStock) {
          const baseQtyReceived = await toBaseQuantity(tx, item.productId, item.unitOfMeasureId, companyId, Number(item.quantityReceived));
          const priorQty = Number(existingStock.quantity);
          const newQty = Math.max(0, round2(priorQty - baseQtyReceived));
          await tx.update(schema.inventoryStocks).set({ quantity: String(newQty) }).where(eq(schema.inventoryStocks.id, existingStock.id));
          await writeStockLedgerEntry(tx, {
            productId: item.productId, warehouseId: grn.warehouseId, companyId,
            transactionType: 'GRN', referenceId: grn.id, date: new Date(),
            quantityChange: newQty - priorQty, endingQuantity: newQty,
            batchNumber: item.batchNumber || null,
          });
        }
      }

      const [reversedGrn] = await tx.update(schema.goodsReceiptNotes)
        .set({ isReversed: true })
        .where(eq(schema.goodsReceiptNotes.id, id))
        .returning();

      let updatedPurchaseOrder: { id: string; status: string } | null = null;
      if (grn.purchaseOrderId) {
        const [po] = await tx.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, grn.purchaseOrderId)).for('update');
        if (po) {
          const poItems = await tx.select().from(schema.purchaseOrderItems).where(eq(schema.purchaseOrderItems.purchaseOrderId, po.id));
          const remainingGrnItems = await tx.select({
            productId: schema.goodsReceiptNoteItems.productId,
            quantityReceived: schema.goodsReceiptNoteItems.quantityReceived,
            unitOfMeasureId: schema.goodsReceiptNoteItems.unitOfMeasureId,
          })
            .from(schema.goodsReceiptNoteItems)
            .innerJoin(schema.goodsReceiptNotes, eq(schema.goodsReceiptNoteItems.grnId, schema.goodsReceiptNotes.id))
            .where(and(eq(schema.goodsReceiptNotes.purchaseOrderId, po.id), eq(schema.goodsReceiptNotes.isReversed, false)));

          const receivedByProduct = new Map<string, number>();
          for (const row of remainingGrnItems) {
            const baseQty = await toBaseQuantity(tx, row.productId, row.unitOfMeasureId, companyId, Number(row.quantityReceived));
            receivedByProduct.set(row.productId, (receivedByProduct.get(row.productId) || 0) + baseQty);
          }
          let fullyReceived = poItems.length > 0;
          let anyReceived = false;
          for (const poItem of poItems) {
            const received = receivedByProduct.get(poItem.productId) || 0;
            const orderedBaseQty = await toBaseQuantity(tx, poItem.productId, poItem.unitOfMeasureId, companyId, Number(poItem.quantityOrdered));
            if (received > 0) anyReceived = true;
            if (received < orderedBaseQty) fullyReceived = false;
          }
          // Cancelled stays Cancelled regardless of receipt reversal — reversing a receipt
          // never resurrects a PO the company deliberately called off.
          const newStatus = po.status === 'Cancelled' ? 'Cancelled' : (fullyReceived ? 'Received' : (anyReceived ? 'Partially Received' : 'Sent'));
          if (newStatus !== po.status) {
            await tx.update(schema.purchaseOrders).set({ status: newStatus }).where(eq(schema.purchaseOrders.id, po.id));
          }
          updatedPurchaseOrder = { id: po.id, status: newStatus };
        }
      }

      return { goodsReceiptNote: reversedGrn, updatedPurchaseOrder };
    });

    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Approve / Reject a Purchase Requisition — gated by the dedicated `inventory.approve`
// permission, deliberately separate from `inventory.pr` (which only covers submitting/
// viewing requisitions) so approval authority can be delegated independently of who's
// allowed to merely create requests. Only a 'Pending' PR may be actioned.
router.patch('/purchase-requisitions/:id/status', async (req: any, res) => {
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

    const updated = await db.transaction(async (tx) => {
      const [pr] = await tx.select().from(schema.purchaseRequisitions)
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

      const [newPr] = await tx.update(schema.purchaseRequisitions)
        .set({ status })
        .where(eq(schema.purchaseRequisitions.id, id))
        .returning();
      return newPr;
    });

    res.json({ success: true, purchaseRequisition: updated });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Cancel a Purchase Order — only a 'Sent' PO may be cancelled (matches the UI's own gate;
// anything already Partially Received/Received/Cancelled has moved past the point a plain
// cancel makes sense).
router.patch('/purchase-orders/:id/cancel', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'inventory.po')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const companyId = req.targetCompanyId;

    const updated = await db.transaction(async (tx) => {
      const [po] = await tx.select().from(schema.purchaseOrders)
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

      const [newPo] = await tx.update(schema.purchaseOrders)
        .set({ status: 'Cancelled' })
        .where(eq(schema.purchaseOrders.id, id))
        .returning();
      return newPo;
    });

    res.json({ success: true, purchaseOrder: updated });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Manual stock adjustment (count discrepancy, damage, etc.) — reuses the exact
// lock-then-increment-or-insert pattern the GRN route above uses to update
// inventoryStocks, just with a signed delta instead of an always-positive received
// quantity. Clamped at 0 (matches the previous client-only behavior in
// InventoryModule.tsx's handleStockAdjustment) rather than allowing negative stock.
router.post('/stock-adjustments', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'inventory.stock')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { productId, warehouseId, quantity, batchNumber, reason } = req.body || {};
    if (!productId || !warehouseId || quantity === undefined || quantity === null || Number(quantity) === 0) {
      return res.status(400).json({ error: 'A product, warehouse, and non-zero quantity are required.' });
    }
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'A reason is required for stock adjustments.' });
    }
    const companyId = req.targetCompanyId;
    const delta = Number(quantity);

    const stock = await db.transaction(async (tx) => {
      // warehouseId was previously never checked against companyId or the caller's
      // allowedBranchIds at all — a crafted request could adjust stock in (or create a
      // new stock row for) another company's warehouse, filed under this caller's own
      // companyId. Same fix as POST /goods-receipt-notes above.
      const [warehouse] = await tx.select({ branchId: schema.warehouses.branchId }).from(schema.warehouses)
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

      const batchCondition = batchNumber
        ? eq(schema.inventoryStocks.batchNumber, batchNumber)
        : isNull(schema.inventoryStocks.batchNumber);

      const [existingStock] = await tx.select().from(schema.inventoryStocks)
        .where(and(
          eq(schema.inventoryStocks.productId, productId),
          eq(schema.inventoryStocks.warehouseId, warehouseId),
          eq(schema.inventoryStocks.companyId, companyId),
          batchCondition
        ))
        .for('update');

      const adjustmentId = generateId();

      if (existingStock) {
        const priorQty = Number(existingStock.quantity);
        const newQty = Math.max(0, round2(priorQty + delta));
        const [updatedStock] = await tx.update(schema.inventoryStocks)
          .set({ quantity: String(newQty) })
          .where(eq(schema.inventoryStocks.id, existingStock.id))
          .returning();
        await writeStockLedgerEntry(tx, {
          productId, warehouseId, companyId,
          transactionType: 'Adjustment', referenceId: adjustmentId, date: new Date(),
          quantityChange: newQty - priorQty, endingQuantity: newQty, batchNumber,
        });
        return updatedStock;
      }

      if (delta <= 0) {
        const err: any = new Error('No existing stock record to deduct from.');
        err.status = 400;
        throw err;
      }

      const [newStock] = await tx.insert(schema.inventoryStocks).values({
        id: generateId(),
        productId,
        warehouseId,
        batchNumber: batchNumber || null,
        quantity: String(round2(delta)),
        companyId,
      }).returning();
      await writeStockLedgerEntry(tx, {
        productId, warehouseId, companyId,
        transactionType: 'Adjustment', referenceId: adjustmentId, date: new Date(),
        quantityChange: round2(delta), endingQuantity: round2(delta), batchNumber,
      });
      return newStock;
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
router.post('/purchase-bills', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'purchaseBills.create')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { billData } = req.body || {};
    if (!billData || !Array.isArray(billData.grnIds) || billData.grnIds.length === 0) {
      return res.status(400).json({ error: 'At least one goods receipt note must be referenced.' });
    }
    const companyId = req.targetCompanyId;

    // If no branch was explicitly requested, inherit the first referenced GRN's own
    // branch (derived via its warehouse — GRNs have no branchId column of their own, see
    // schema.ts) — otherwise resolve/validate independently, same choke-point as every
    // other document-creation route.
    let billBranchId: string | null;
    try {
      let requestedBranchId = billData.branchId;
      if (!requestedBranchId) {
        const [firstGrn] = await db.select({ warehouseId: schema.goodsReceiptNotes.warehouseId }).from(schema.goodsReceiptNotes)
          .where(and(eq(schema.goodsReceiptNotes.id, billData.grnIds[0]), eq(schema.goodsReceiptNotes.companyId, companyId)));
        if (firstGrn?.warehouseId) {
          const [wh] = await db.select({ branchId: schema.warehouses.branchId }).from(schema.warehouses).where(and(eq(schema.warehouses.id, firstGrn.warehouseId), eq(schema.warehouses.companyId, companyId)));
          requestedBranchId = wh?.branchId || undefined;
        }
      }
      billBranchId = await resolveDocumentBranchId(req, requestedBranchId);
    } catch (branchErr: any) {
      return res.status(branchErr.status || 400).json({ error: branchErr.error || 'Invalid branch.' });
    }

    const created = await db.transaction(async (tx) => {
      // Purchase Bills always post as of today (date: new Date() below) — no client-
      // supplied bill date exists, so this is a same-day check only, never a backdating
      // scenario, unlike the invoice/expense sites which validate a client-chosen date.
      await assertQuarterNotFiled(new Date().toISOString().slice(0, 10), companyId);

      const grns: any[] = [];
      let vendorId: string | null = null;
      for (const grnId of billData.grnIds) {
        const [grn] = await tx.select().from(schema.goodsReceiptNotes)
          .where(and(eq(schema.goodsReceiptNotes.id, grnId), eq(schema.goodsReceiptNotes.companyId, companyId)))
          .for('update');
        if (!grn) {
          const err: any = new Error(`Goods receipt note ${grnId} not found.`);
          err.status = 404;
          throw err;
        }
        if (grn.isReversed) {
          const err: any = new Error(`Goods receipt note ${grn.grnNumber} has been reversed and cannot be billed.`);
          err.status = 400;
          throw err;
        }
        if (grn.isBilled) {
          const err: any = new Error(`Goods receipt note ${grn.grnNumber} has already been billed.`);
          err.status = 400;
          throw err;
        }
        if (vendorId === null) {
          vendorId = grn.vendorId;
        } else if (vendorId !== grn.vendorId) {
          const err: any = new Error('All referenced goods receipt notes must be from the same vendor.');
          err.status = 400;
          throw err;
        }
        grns.push(grn);
      }

      const grnItems = await tx.select().from(schema.goodsReceiptNoteItems)
        .where(inArray(schema.goodsReceiptNoteItems.grnId, grns.map(g => g.id)));

      let subTotal = 0;
      let taxTotal = 0;
      for (const item of grnItems) {
        const lineSubtotal = round2(Number(item.quantityReceived) * Number(item.unitCost));
        const lineTax = round2(lineSubtotal * (Number(item.taxRate || 0) / 100));
        subTotal = round2(subTotal + lineSubtotal);
        taxTotal = round2(taxTotal + lineTax);
      }
      const grandTotal = round2(subTotal + taxTotal);

      const billNumber = await getAndIncrementDocumentNumber(tx, companyId, 'bill', new Date().toISOString().slice(0, 10), billBranchId);
      const billId = generateId();

      const [newBill] = await tx.insert(schema.purchaseBills).values({
        id: billId,
        billNumber,
        vendorId: vendorId!,
        date: new Date(),
        dueDate: billData.dueDate ? new Date(billData.dueDate) : null,
        grnIds: grns.map(g => g.id).join(','),
        subTotal: String(subTotal),
        taxTotal: String(taxTotal),
        grandTotal: String(grandTotal),
        status: 'Unpaid',
        amountPaid: '0',
        bankId: billData.bankId || null,
        companyId,
        branchId: billBranchId,
      }).returning();

      await tx.update(schema.goodsReceiptNotes)
        .set({ isBilled: true })
        .where(inArray(schema.goodsReceiptNotes.id, grns.map(g => g.id)));

      return newBill;
    });

    res.json({ success: true, purchaseBill: created });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Edit a Bill's due date / bank — only while Unpaid (nothing else is safe to change once
// money may have moved against it, and the GRN linkage/totals are the 3-way-match record,
// not something an edit should be able to quietly rewrite).
router.put('/purchase-bills/:id', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'purchaseBills.update')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const { billData } = req.body || {};
    const companyId = req.targetCompanyId;

    const updated = await db.transaction(async (tx) => {
      const [bill] = await tx.select().from(schema.purchaseBills)
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
        const [bank] = await tx.select({ id: schema.bankAccounts.id }).from(schema.bankAccounts)
          .where(and(eq(schema.bankAccounts.id, billData.bankId), eq(schema.bankAccounts.companyId, companyId)));
        if (!bank) {
          const err: any = new Error('Selected bank account was not found for this company.');
          err.status = 400;
          throw err;
        }
      }
      const [newBill] = await tx.update(schema.purchaseBills)
        .set({
          dueDate: billData?.dueDate !== undefined ? (billData.dueDate ? new Date(billData.dueDate) : null) : bill.dueDate,
          bankId: billData?.bankId !== undefined ? billData.bankId : bill.bankId,
        })
        .where(eq(schema.purchaseBills.id, id))
        .returning();
      return newBill;
    });

    res.json({ success: true, purchaseBill: updated });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Pay a Bill (full or partial) — same partial-payment shape as the expense/invoice payment
// routes: caps at the remaining balance, generates a fresh Payment voucher per settlement.
router.post('/purchase-bills/:id/pay', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'purchaseBills.update')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const { date, bankId, amount } = req.body || {};
    const companyId = req.targetCompanyId;

    const updatedBill = await db.transaction(async (tx) => {
      const [bill] = await tx.select().from(schema.purchaseBills)
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
      if (bill.status === 'Cancelled') {
        const err: any = new Error('Cancelled bills cannot be paid.');
        err.status = 400;
        throw err;
      }
      if (bill.status === 'Paid') {
        const err: any = new Error('Bill is already fully paid.');
        err.status = 400;
        throw err;
      }

      const targetBankId = bankId || bill.bankId;
      if (!targetBankId) {
        const err: any = new Error('A bank account is required to record this payment.');
        err.status = 400;
        throw err;
      }
      // A client-supplied bankId must actually belong to this company — otherwise a
      // malformed/malicious request could post a disbursement against another tenant's
      // bank account.
      if (bankId) {
        const [targetBank] = await tx.select({ id: schema.bankAccounts.id }).from(schema.bankAccounts)
          .where(and(eq(schema.bankAccounts.id, targetBankId), eq(schema.bankAccounts.companyId, companyId)));
        if (!targetBank) {
          const err: any = new Error('Selected bank account was not found for this company.');
          err.status = 400;
          throw err;
        }
      }
      const currentPaid = round2(Number(bill.amountPaid || 0));
      const totalAmount = round2(Number(bill.grandTotal));
      const remaining = round2(totalAmount - currentPaid);

      const paymentAmount = amount !== undefined ? Number(amount) : undefined;
      let amountToPost = remaining;
      if (paymentAmount !== undefined) {
        if (isNaN(paymentAmount) || paymentAmount <= 0) {
          const err: any = new Error('Payment amount must be greater than zero.');
          err.status = 400;
          throw err;
        }
        if (paymentAmount > remaining + 0.01) {
          const err: any = new Error(`Payment amount (${paymentAmount}) exceeds the remaining balance (${remaining}).`);
          err.status = 400;
          throw err;
        }
        amountToPost = Math.min(paymentAmount, remaining);
      }
      if (amountToPost <= 0) {
        const err: any = new Error('No remaining balance to pay.');
        err.status = 400;
        throw err;
      }

      const newPaidAmount = round2(currentPaid + amountToPost);
      const newStatus = newPaidAmount >= totalAmount - 0.01 ? 'Paid' : 'Partially Paid';

      // The bill's own bankId is left as originally assigned — each installment's real
      // disbursing bank is recorded on its own Payment voucher below instead, the same
      // way the invoice/expense payment routes now work.
      const [newBill] = await tx.update(schema.purchaseBills).set({
        amountPaid: String(newPaidAmount),
        status: newStatus,
      }).where(eq(schema.purchaseBills.id, id)).returning();

      const voucherDate = date || new Date().toISOString().split('T')[0];
      const voucherNumber = await getAndIncrementDocumentNumber(tx, companyId, 'voucher', voucherDate, bill.branchId);
      const [voucher] = await tx.insert(schema.vouchers).values({
        id: generateId(),
        voucherNumber,
        type: 'Payment',
        date: voucherDate,
        bankId: targetBankId,
        amount: String(amountToPost),
        description: `Payment voucher for purchase bill ${bill.billNumber} (${amountToPost.toFixed(2)})`,
        referenceType: 'PurchaseBill',
        referenceId: id,
        createdById: req.user.id,
        createdAt: new Date(),
        companyId,
        // Always the bill's own branch, never independently picked.
        branchId: bill.branchId,
      }).returning();

      return { bill: newBill, voucher };
    });

    // Same shape as create/edit's own response (`purchaseBill: <row>`, raw from
    // .returning()) — the client mirrors the server's own computed amountPaid/status
    // instead of re-deriving that arithmetic itself. `voucher` lets the client
    // immediately open a printable payment receipt — see DocumentRenderer.tsx's
    // renderVoucher, the same one ReportViewer.tsx's voucher register already prints from.
    res.json({ success: true, purchaseBill: updatedBill.bill, voucher: updatedBill.voucher });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Cancel a Bill — only while Unpaid (once any payment has posted, a Cancel would leave a
// dangling Payment voucher with nothing to reconcile against; that's a correction, not a
// cancellation). Releases the referenced GRNs' isBilled flag so they can be re-billed.
router.patch('/purchase-bills/:id/cancel', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'purchaseBills.delete')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const companyId = req.targetCompanyId;

    const updated = await db.transaction(async (tx) => {
      const [bill] = await tx.select().from(schema.purchaseBills)
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
      const [newBill] = await tx.update(schema.purchaseBills)
        .set({ status: 'Cancelled' })
        .where(eq(schema.purchaseBills.id, id))
        .returning();

      const grnIds = bill.grnIds.split(',').filter(Boolean);
      if (grnIds.length > 0) {
        await tx.update(schema.goodsReceiptNotes)
          .set({ isBilled: false })
          .where(inArray(schema.goodsReceiptNotes.id, grnIds));
      }

      return newBill;
    });

    res.json({ success: true, purchaseBill: updated });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// --- Purchase Returns (Debit Notes) ---
// A return references a single GRN and can never return more of a product/batch than that
// GRN actually received minus whatever's already been returned against it — the same
// "can't exceed the source document" 3-way-match discipline as Purchase Bills, applied to
// the reverse flow. Decrements stock (clamped at 0, matching every other stock-mutating
// route in this file) but deliberately does NOT unwind averageCost, same forward-only
// philosophy as GRN reversal.
router.post('/purchase-returns', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'purchaseReturns.create')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { returnData } = req.body || {};
    if (!returnData || !returnData.grnId || !Array.isArray(returnData.items) || returnData.items.length === 0) {
      return res.status(400).json({ error: 'A goods receipt note and at least one returned item are required.' });
    }
    const companyId = req.targetCompanyId;

    const created = await db.transaction(async (tx) => {
      const [grn] = await tx.select().from(schema.goodsReceiptNotes)
        .where(and(eq(schema.goodsReceiptNotes.id, returnData.grnId), eq(schema.goodsReceiptNotes.companyId, companyId)))
        .for('update');
      if (!grn) {
        const err: any = new Error('Goods receipt note not found.');
        err.status = 404;
        throw err;
      }
      if (!(await branchAccessOkViaWarehouse(tx, req, grn.warehouseId))) {
        const err: any = new Error('Forbidden: you are not assigned to this branch.');
        err.status = 403;
        throw err;
      }
      if (grn.isReversed) {
        const err: any = new Error('This receipt has been reversed and cannot be returned against.');
        err.status = 400;
        throw err;
      }

      const grnItems = await tx.select().from(schema.goodsReceiptNoteItems).where(eq(schema.goodsReceiptNoteItems.grnId, grn.id));
      const priorReturns = await tx.select({
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
        const baseQty = await toBaseQuantity(tx, row.productId, row.unitOfMeasureId, companyId, Number(row.quantityReturned));
        priorReturnedByKey.set(key, (priorReturnedByKey.get(key) || 0) + baseQty);
      }

      for (const item of returnData.items) {
        const key = `${item.productId}|${item.batchNumber || ''}`;
        const receivedRow = grnItems.find((gi: any) => gi.productId === item.productId && (gi.batchNumber || '') === (item.batchNumber || ''));
        const receivedQty = receivedRow ? await toBaseQuantity(tx, item.productId, receivedRow.unitOfMeasureId, companyId, Number(receivedRow.quantityReceived)) : 0;
        const alreadyReturned = priorReturnedByKey.get(key) || 0;
        const availableToReturn = round2(receivedQty - alreadyReturned);
        const returnBaseQty = await toBaseQuantity(tx, item.productId, item.unitOfMeasureId, companyId, Number(item.quantityReturned));
        if (returnBaseQty > availableToReturn + 0.001) {
          const err: any = new Error(`Cannot return ${item.quantityReturned} units of this item — only ${availableToReturn} (base unit) remain returnable from this receipt.`);
          err.status = 400;
          throw err;
        }
      }

      // purchaseReturns has no branchId column of its own — derived via the GRN's
      // warehouseId, same as GRN numbering above.
      const [returnWarehouse] = await tx.select({ branchId: schema.warehouses.branchId }).from(schema.warehouses).where(eq(schema.warehouses.id, grn.warehouseId));
      const returnNumber = await getAndIncrementDocumentNumber(tx, companyId, 'return', new Date().toISOString().slice(0, 10), returnWarehouse?.branchId || null);
      const returnId = generateId();

      const [newReturn] = await tx.insert(schema.purchaseReturns).values({
        id: returnId,
        returnNumber,
        grnId: grn.id,
        vendorId: grn.vendorId,
        warehouseId: grn.warehouseId,
        date: new Date(),
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
      const insertedItems = await tx.insert(schema.purchaseReturnItems).values(itemRows).returning();

      for (const item of returnData.items) {
        const baseQtyReturned = await toBaseQuantity(tx, item.productId, item.unitOfMeasureId, companyId, Number(item.quantityReturned));
        const batchCondition = item.batchNumber
          ? eq(schema.inventoryStocks.batchNumber, item.batchNumber)
          : isNull(schema.inventoryStocks.batchNumber);
        const [existingStock] = await tx.select().from(schema.inventoryStocks)
          .where(and(
            eq(schema.inventoryStocks.productId, item.productId),
            eq(schema.inventoryStocks.warehouseId, grn.warehouseId),
            eq(schema.inventoryStocks.companyId, companyId),
            batchCondition
          ))
          .for('update');
        if (existingStock) {
          const priorQty = Number(existingStock.quantity);
          const newQty = Math.max(0, round2(priorQty - baseQtyReturned));
          await tx.update(schema.inventoryStocks).set({ quantity: String(newQty) }).where(eq(schema.inventoryStocks.id, existingStock.id));
          await writeStockLedgerEntry(tx, {
            productId: item.productId, warehouseId: grn.warehouseId, companyId,
            transactionType: 'Return', referenceId: returnId, date: newReturn.date as Date,
            quantityChange: newQty - priorQty, endingQuantity: newQty,
            batchNumber: item.batchNumber || null,
          });
        }
      }

      return { ...newReturn, items: insertedItems };
    });

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
router.patch('/purchase-returns/:id/cancel', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'purchaseReturns.delete')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const companyId = req.targetCompanyId;

    const updated = await db.transaction(async (tx) => {
      const [ret] = await tx.select().from(schema.purchaseReturns)
        .where(and(eq(schema.purchaseReturns.id, id), eq(schema.purchaseReturns.companyId, companyId)))
        .for('update');
      if (!ret) {
        const err: any = new Error('Purchase return not found.');
        err.status = 404;
        throw err;
      }
      if (!(await branchAccessOkViaWarehouse(tx, req, ret.warehouseId))) {
        const err: any = new Error('Forbidden: you are not assigned to this branch.');
        err.status = 403;
        throw err;
      }
      if (ret.status === 'Cancelled') {
        const err: any = new Error('This return has already been cancelled.');
        err.status = 400;
        throw err;
      }

      const items = await tx.select().from(schema.purchaseReturnItems).where(eq(schema.purchaseReturnItems.returnId, id));
      for (const item of items) {
        const baseQtyReturned = await toBaseQuantity(tx, item.productId, item.unitOfMeasureId, companyId, Number(item.quantityReturned));
        const batchCondition = item.batchNumber
          ? eq(schema.inventoryStocks.batchNumber, item.batchNumber)
          : isNull(schema.inventoryStocks.batchNumber);
        const [existingStock] = await tx.select().from(schema.inventoryStocks)
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
          await tx.update(schema.inventoryStocks)
            .set({ quantity: String(cancelEndingQty) })
            .where(eq(schema.inventoryStocks.id, existingStock.id));
        } else {
          await tx.insert(schema.inventoryStocks).values({
            id: generateId(),
            productId: item.productId,
            warehouseId: ret.warehouseId,
            batchNumber: item.batchNumber || null,
            quantity: String(baseQtyReturned),
            companyId,
          });
        }
        await writeStockLedgerEntry(tx, {
          productId: item.productId, warehouseId: ret.warehouseId, companyId,
          transactionType: 'Return', referenceId: ret.id, date: new Date(),
          quantityChange: baseQtyReturned, endingQuantity: cancelEndingQty,
          batchNumber: item.batchNumber || null,
        });
      }

      const [newReturn] = await tx.update(schema.purchaseReturns)
        .set({ status: 'Cancelled' })
        .where(eq(schema.purchaseReturns.id, id))
        .returning();
      return newReturn;
    });

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
router.post('/stock-takes', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'stockTakes.create')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { stockTakeData } = req.body || {};
    if (!stockTakeData || !stockTakeData.warehouseId || !Array.isArray(stockTakeData.items) || stockTakeData.items.length === 0) {
      return res.status(400).json({ error: 'A warehouse and at least one counted item are required.' });
    }
    const companyId = req.targetCompanyId;

    const created = await db.transaction(async (tx) => {
      // physicalStockTakes has no branchId column of its own — derived via warehouseId,
      // same pattern as GRN/Purchase Return numbering above. Also the only ownership check
      // on stockTakeData.warehouseId anywhere in this route — previously unscoped by
      // companyId entirely, same class of gap as GRN/stock-adjustments above.
      const [stWarehouse] = await tx.select({ branchId: schema.warehouses.branchId }).from(schema.warehouses)
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
      const referenceNumber = await getAndIncrementDocumentNumber(tx, companyId, 'stockTake', new Date().toISOString().slice(0, 10), stWarehouse?.branchId || null);
      const stockTakeId = generateId();

      const [newStockTake] = await tx.insert(schema.physicalStockTakes).values({
        id: stockTakeId,
        referenceNumber,
        warehouseId: stockTakeData.warehouseId,
        date: new Date(),
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
        const [existingStock] = await tx.select().from(schema.inventoryStocks)
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
        const basePhysicalQuantity = await toBaseQuantity(tx, item.productId, item.unitOfMeasureId, companyId, physicalQuantity);
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
      const insertedItems = await tx.insert(schema.physicalStockTakeItems).values(itemRows).returning();

      return { ...newStockTake, items: insertedItems };
    });

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
router.post('/stock-takes/:id/finalize', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'stockTakes.update')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const companyId = req.targetCompanyId;

    const result = await db.transaction(async (tx) => {
      const [stockTake] = await tx.select().from(schema.physicalStockTakes)
        .where(and(eq(schema.physicalStockTakes.id, id), eq(schema.physicalStockTakes.companyId, companyId)))
        .for('update');
      if (!stockTake) {
        const err: any = new Error('Stock take not found.');
        err.status = 404;
        throw err;
      }
      if (!(await branchAccessOkViaWarehouse(tx, req, stockTake.warehouseId))) {
        const err: any = new Error('Forbidden: you are not assigned to this branch.');
        err.status = 403;
        throw err;
      }
      if (stockTake.status !== 'Draft') {
        const err: any = new Error(`Cannot finalize a stock take that is not Draft (current status: ${stockTake.status}).`);
        err.status = 400;
        throw err;
      }

      const items = await tx.select().from(schema.physicalStockTakeItems).where(eq(schema.physicalStockTakeItems.stockTakeId, id));

      for (const item of items) {
        const batchCondition = item.batchNumber
          ? eq(schema.inventoryStocks.batchNumber, item.batchNumber)
          : isNull(schema.inventoryStocks.batchNumber);
        const [existingStock] = await tx.select().from(schema.inventoryStocks)
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
        const targetQty = await toBaseQuantity(tx, item.productId, item.unitOfMeasureId, companyId, Number(item.physicalQuantity));
        if (round2(targetQty - currentQty) === 0) continue;

        const finalizedQty = Math.max(0, round2(targetQty));
        if (existingStock) {
          await tx.update(schema.inventoryStocks)
            .set({ quantity: String(finalizedQty) })
            .where(eq(schema.inventoryStocks.id, existingStock.id));
        } else if (targetQty > 0) {
          await tx.insert(schema.inventoryStocks).values({
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
        await writeStockLedgerEntry(tx, {
          productId: item.productId, warehouseId: stockTake.warehouseId, companyId,
          transactionType: 'StockTake', referenceId: stockTake.id, date: new Date(),
          quantityChange: round2(finalizedQty - currentQty), endingQuantity: finalizedQty,
          batchNumber: item.batchNumber || null,
        });
      }

      const [updated] = await tx.update(schema.physicalStockTakes)
        .set({ status: 'Completed' })
        .where(eq(schema.physicalStockTakes.id, id))
        .returning();
      return updated;
    });

    res.json({ success: true, stockTake: result });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Cancel a Draft stock take — a Completed one can't be cancelled (its adjustments already
// posted; correcting that needs a fresh stock take or manual adjustment, same reasoning as
// Purchase Bills refusing to cancel once paid).
router.patch('/stock-takes/:id/cancel', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'stockTakes.delete')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const companyId = req.targetCompanyId;

    const updated = await db.transaction(async (tx) => {
      const [stockTake] = await tx.select().from(schema.physicalStockTakes)
        .where(and(eq(schema.physicalStockTakes.id, id), eq(schema.physicalStockTakes.companyId, companyId)))
        .for('update');
      if (!stockTake) {
        const err: any = new Error('Stock take not found.');
        err.status = 404;
        throw err;
      }
      if (!(await branchAccessOkViaWarehouse(tx, req, stockTake.warehouseId))) {
        const err: any = new Error('Forbidden: you are not assigned to this branch.');
        err.status = 403;
        throw err;
      }
      if (stockTake.status !== 'Draft') {
        const err: any = new Error(`Cannot cancel a stock take that is not Draft (current status: ${stockTake.status}).`);
        err.status = 400;
        throw err;
      }
      const [newStockTake] = await tx.update(schema.physicalStockTakes)
        .set({ status: 'Cancelled' })
        .where(eq(schema.physicalStockTakes.id, id))
        .returning();
      return newStockTake;
    });

    res.json({ success: true, stockTake: updated });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

export default router;
