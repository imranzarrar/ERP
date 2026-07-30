import express from 'express';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and, isNull } from 'drizzle-orm';
import { getAndIncrementCounter, round2 } from '../lib/businessLogic.js';
import { hasPermission } from '../lib/authz.js';
import { generateId } from '../../src/id.js';

const router = express.Router();

// Purchase Requisitions, Purchase Orders and Goods Receipt Notes previously had their
// "next number" derived client-side from `array.length + 1001` (see InventoryModule.tsx
// history) — reproducibly duplicated under concurrent creation, the same class of bug
// already fixed for invoice/quotation/expense/voucher numbering. These routes reuse the
// same `getAndIncrementCounter` (SELECT ... FOR UPDATE row lock scoped per-company)
// mechanism so PR/PO/GRN numbering is safe under real concurrency too.

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

    const created = await db.transaction(async (tx) => {
      const prCount = await getAndIncrementCounter(tx, companyId, 'pr');
      const prNumber = `PR-${prCount}`;
      const prId = generateId();

      const [newPr] = await tx.insert(schema.purchaseRequisitions).values({
        id: prId,
        prNumber,
        requestedBy: prData.requestedBy,
        date: new Date(),
        status: 'Pending',
        notes: prData.notes || null,
        companyId,
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

    const totalAmount = poData.items.reduce((sum: number, item: any) => {
      const lineTotal = Number(item.quantityOrdered) * Number(item.unitPrice);
      const tax = lineTotal * (Number(item.taxRate || 0) / 100);
      return sum + lineTotal + tax;
    }, 0);

    const created = await db.transaction(async (tx) => {
      const poCount = await getAndIncrementCounter(tx, companyId, 'po');
      const poNumber = `PO-${poCount}`;
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
      }).returning();

      const itemRows = poData.items.map((item: any) => ({
        id: generateId(),
        purchaseOrderId: poId,
        productId: item.productId,
        quantityOrdered: String(item.quantityOrdered),
        unitPrice: String(item.unitPrice),
        taxRate: String(item.taxRate || 0),
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

      const grnCount = await getAndIncrementCounter(tx, companyId, 'grn');
      const grnNumber = `GRN-${grnCount}`;
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
      }));
      const insertedItems = await tx.insert(schema.goodsReceiptNoteItems).values(itemRows).returning();

      // Update stock levels — lock each matching stock row before incrementing so two
      // concurrent GRNs touching the same product/warehouse/batch never lose an update
      // (read-then-write without a lock would let both read the same starting quantity).
      for (const item of grnData.items) {
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

        if (existingStock) {
          await tx.update(schema.inventoryStocks)
            .set({ quantity: String(round2(Number(existingStock.quantity) + Number(item.quantityReceived))) })
            .where(eq(schema.inventoryStocks.id, existingStock.id));
        } else {
          await tx.insert(schema.inventoryStocks).values({
            id: generateId(),
            productId: item.productId,
            warehouseId: grnData.warehouseId,
            batchNumber: item.batchNumber || null,
            expiryDate: item.expiryDate ? new Date(item.expiryDate) : null,
            quantity: String(item.quantityReceived),
            companyId,
          });
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
        })
          .from(schema.goodsReceiptNoteItems)
          .innerJoin(schema.goodsReceiptNotes, eq(schema.goodsReceiptNoteItems.grnId, schema.goodsReceiptNotes.id))
          .where(eq(schema.goodsReceiptNotes.purchaseOrderId, linkedPo.id));

        const receivedByProduct = new Map<string, number>();
        for (const row of priorGrnItems) {
          receivedByProduct.set(row.productId, (receivedByProduct.get(row.productId) || 0) + Number(row.quantityReceived));
        }

        let fullyReceived = poItems.length > 0;
        let anyReceived = false;
        for (const poItem of poItems) {
          const received = receivedByProduct.get(poItem.productId) || 0;
          if (received > 0) anyReceived = true;
          if (received < Number(poItem.quantityOrdered)) fullyReceived = false;
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

export default router;
