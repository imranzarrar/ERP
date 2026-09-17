import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq, and } from 'drizzle-orm';
import pg from 'pg';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Phase 5 of the RLS full-rollout (BACKLOG.md) migrated all 21 routes in
// server/routes/inventory.ts onto tenantDb() — Purchase Requisitions, Purchase Orders,
// Goods Receipt Notes (+ reverse), PR approve/reject, PO cancel, Warehouse Dispatches/
// Receivings (+ cancel), Stock Adjustments, Purchase Bills (+ pay/cancel), Purchase
// Returns (+ cancel), and Physical Stock Takes (+ finalize/cancel). No routes deferred —
// this file has zero ZATCA fire-and-forget patterns and zero hijack-detection
// (assertOwnsRow-style) lookups, unlike transactions.ts/pos.ts.
//
// Same two things proven as every prior phase: (1) the full PR -> PO -> GRN chain still
// works end-to-end through tenantDb (creating rows, updating stock, folding average cost),
// and (2) the database itself enforces isolation via a raw erp_app_tenant connection with
// no WHERE clause — for direct company-scoped tables (purchase_requisitions,
// inventory_stocks, stock_ledger_transactions — the latter specifically called out during
// planning as a high-volume table that had zero indexes at all before this rollout) and a
// category-B child table scoped via its parent (goods_receipt_note_items).
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyAId: string;
let companyBId: string;
let sessionId: string;
let warehouseAId: string;
let vendorAId: string;
let productAId: string;

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function makeCompany(name: string) {
  const id = generateId();
  await db.insert(schema.companies).values({
    id, name, address: 'Test Address', phone: '0000000000', email: `${id}@example.com`,
    logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false,
  });
  return id;
}

beforeAll(async () => {
  companyAId = await makeCompany('TenantDb Phase5 Test Co A');
  companyBId = await makeCompany('TenantDb Phase5 Test Co B');

  const userAId = generateId();
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  const username = `tenantdb_p5_test_${userAId}`;
  await db.insert(schema.users).values({
    id: userAId, username, password: passwordHash, role: 'admin', companyId: companyAId, isSuperAdmin: false,
  });

  const loginRes = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });
  const loginBody = await loginRes.json().catch(() => null);
  if (!loginBody?.sessionId) {
    throw new Error(`Test setup failed: login did not return a sessionId (status ${loginRes.status}, body ${JSON.stringify(loginBody)})`);
  }
  sessionId = loginBody.sessionId;

  warehouseAId = generateId();
  await db.insert(schema.warehouses).values({
    id: warehouseAId, name: 'Phase5 Warehouse A', code: 'P5WHA', companyId: companyAId, type: 'sales',
  });
  vendorAId = generateId();
  await db.insert(schema.vendors).values({
    id: vendorAId, name: 'Phase5 Vendor A', phone: '111', email: 'p5venda@example.com', address: 'A', companyId: companyAId, buyerType: 'B2C',
  });
  productAId = generateId();
  await db.insert(schema.productsServices).values({
    id: productAId, name: 'Phase5 Product A', description: 'A test item', unitPrice: '50', itemKind: 'item', companyId: companyAId,
  });
});

afterAll(async () => {
  await db.delete(schema.stockLedgerTransactions).where(eq(schema.stockLedgerTransactions.companyId, companyAId));
  await db.delete(schema.stockLedgerTransactions).where(eq(schema.stockLedgerTransactions.companyId, companyBId));
  await db.delete(schema.inventoryStocks).where(eq(schema.inventoryStocks.companyId, companyAId));
  await db.delete(schema.inventoryStocks).where(eq(schema.inventoryStocks.companyId, companyBId));
  await db.delete(schema.goodsReceiptNoteItems);
  await db.delete(schema.goodsReceiptNotes).where(eq(schema.goodsReceiptNotes.companyId, companyAId));
  await db.delete(schema.goodsReceiptNotes).where(eq(schema.goodsReceiptNotes.companyId, companyBId));
  await db.delete(schema.purchaseOrderItems);
  await db.delete(schema.purchaseOrders).where(eq(schema.purchaseOrders.companyId, companyAId));
  await db.delete(schema.purchaseOrders).where(eq(schema.purchaseOrders.companyId, companyBId));
  await db.delete(schema.purchaseRequisitionItems);
  await db.delete(schema.purchaseRequisitions).where(eq(schema.purchaseRequisitions.companyId, companyAId));
  await db.delete(schema.purchaseRequisitions).where(eq(schema.purchaseRequisitions.companyId, companyBId));
  await db.delete(schema.productsServices).where(eq(schema.productsServices.companyId, companyAId));
  await db.delete(schema.productsServices).where(eq(schema.productsServices.companyId, companyBId));
  await db.delete(schema.vendors).where(eq(schema.vendors.companyId, companyAId));
  await db.delete(schema.vendors).where(eq(schema.vendors.companyId, companyBId));
  await db.delete(schema.warehouses).where(eq(schema.warehouses.companyId, companyAId));
  await db.delete(schema.warehouses).where(eq(schema.warehouses.companyId, companyBId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyAId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyAId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyBId));
  await db.delete(schema.users).where(eq(schema.users.companyId, companyAId));
  await db.delete(schema.users).where(eq(schema.users.companyId, companyBId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyAId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyBId));
});

describe('Purchase Requisition -> Purchase Order -> Goods Receipt Note, end-to-end through tenantDb', () => {
  let prId: string;
  let poId: string;
  let grnId: string;

  it('creates a Purchase Requisition for Company A', async () => {
    const { status, body } = await api('/api/inventory/purchase-requisitions', {
      method: 'POST',
      body: JSON.stringify({
        prData: { requestedBy: 'Tester', items: [{ productId: productAId, quantity: 10, purpose: 'Restock' }] },
      }),
    });
    expect(status).toBe(200);
    expect(body.purchaseRequisition.status).toBe('Pending');
    prId = body.purchaseRequisition.id;
    const [row] = await db.select().from(schema.purchaseRequisitions).where(eq(schema.purchaseRequisitions.id, prId));
    expect(row.companyId).toBe(companyAId);
  });

  it('approves the Purchase Requisition', async () => {
    const { status, body } = await api(`/api/inventory/purchase-requisitions/${prId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'Approved' }),
    });
    expect(status).toBe(200);
    expect(body.purchaseRequisition.status).toBe('Approved');
  });

  it('raises a Purchase Order from the approved requisition', async () => {
    const { status, body } = await api('/api/inventory/purchase-orders', {
      method: 'POST',
      body: JSON.stringify({
        poData: {
          requisitionId: prId, vendorId: vendorAId,
          items: [{ productId: productAId, quantityOrdered: 10, unitPrice: 20, taxRate: 0 }],
        },
      }),
    });
    expect(status).toBe(200);
    expect(body.purchaseOrder.status).toBe('Sent');
    poId = body.purchaseOrder.id;

    const [closedPr] = await db.select().from(schema.purchaseRequisitions).where(eq(schema.purchaseRequisitions.id, prId));
    expect(closedPr.status).toBe('Closed');
  });

  it('receives the Purchase Order via a Goods Receipt Note, updating stock and average cost', async () => {
    const { status, body } = await api('/api/inventory/goods-receipt-notes', {
      method: 'POST',
      body: JSON.stringify({
        grnData: {
          purchaseOrderId: poId, warehouseId: warehouseAId, receivedBy: 'Tester',
          items: [{ productId: productAId, quantityReceived: 10, unitCost: 20 }],
        },
      }),
    });
    expect(status).toBe(200);
    grnId = body.goodsReceiptNote.id;
    expect(body.updatedPurchaseOrder.status).toBe('Received');

    const [stock] = await db.select().from(schema.inventoryStocks)
      .where(and(eq(schema.inventoryStocks.productId, productAId), eq(schema.inventoryStocks.warehouseId, warehouseAId)));
    expect(Number(stock.quantity)).toBe(10);

    const [product] = await db.select().from(schema.productsServices).where(eq(schema.productsServices.id, productAId));
    expect(Number(product.averageCost)).toBe(20);

    const [ledgerEntry] = await db.select().from(schema.stockLedgerTransactions)
      .where(and(eq(schema.stockLedgerTransactions.referenceId, grnId), eq(schema.stockLedgerTransactions.transactionType, 'GRN')));
    expect(ledgerEntry).toBeTruthy();
    expect(Number(ledgerEntry.quantityChange)).toBe(10);
  });

  it('reverses the Goods Receipt Note, restoring stock back to zero', async () => {
    const { status, body } = await api(`/api/inventory/goods-receipt-notes/${grnId}/reverse`, { method: 'POST' });
    expect(status).toBe(200);
    expect(body.goodsReceiptNote.isReversed).toBe(true);

    const [stock] = await db.select().from(schema.inventoryStocks)
      .where(and(eq(schema.inventoryStocks.productId, productAId), eq(schema.inventoryStocks.warehouseId, warehouseAId)));
    expect(Number(stock.quantity)).toBe(0);
  });
});

describe('Postgres RLS itself blocks cross-company access to inventory tables (raw connection, no WHERE clause)', () => {
  let prBId: string;
  let poBId: string;
  let grnBId: string;
  let grnItemBId: string;
  let stockBId: string;
  let ledgerBId: string;
  let warehouseBId: string;
  let vendorBId: string;
  let productBId: string;

  beforeAll(async () => {
    warehouseBId = generateId();
    await db.insert(schema.warehouses).values({ id: warehouseBId, name: 'Phase5 Warehouse B', code: 'P5WHB', companyId: companyBId, type: 'sales' });
    vendorBId = generateId();
    await db.insert(schema.vendors).values({ id: vendorBId, name: 'Phase5 Vendor B', phone: '1', email: 'p5vendb@example.com', address: 'B', companyId: companyBId, buyerType: 'B2C' });
    productBId = generateId();
    await db.insert(schema.productsServices).values({ id: productBId, name: 'Phase5 Product B', description: 'B item', unitPrice: '1', itemKind: 'item', companyId: companyBId });

    prBId = generateId();
    await db.insert(schema.purchaseRequisitions).values({
      id: prBId, prNumber: 'PR-B-P5-1', requestedBy: 'B Tester', date: new Date(), status: 'Pending', companyId: companyBId,
    });
    poBId = generateId();
    await db.insert(schema.purchaseOrders).values({
      id: poBId, poNumber: 'PO-B-P5-1', vendorId: vendorBId, date: new Date(), status: 'Sent', totalAmount: '100', companyId: companyBId,
    });
    grnBId = generateId();
    await db.insert(schema.goodsReceiptNotes).values({
      id: grnBId, grnNumber: 'GRN-B-P5-1', purchaseOrderId: poBId, vendorId: vendorBId, warehouseId: warehouseBId,
      date: new Date(), receivedBy: 'B Tester', companyId: companyBId,
    });
    grnItemBId = generateId();
    await db.insert(schema.goodsReceiptNoteItems).values({
      id: grnItemBId, grnId: grnBId, productId: productBId, quantityReceived: '5', unitCost: '10',
    });
    stockBId = generateId();
    await db.insert(schema.inventoryStocks).values({
      id: stockBId, productId: productBId, warehouseId: warehouseBId, quantity: '5', companyId: companyBId,
    });
    ledgerBId = generateId();
    await db.insert(schema.stockLedgerTransactions).values({
      id: ledgerBId, productId: productBId, warehouseId: warehouseBId, transactionType: 'GRN', referenceId: grnBId,
      date: new Date(), quantityChange: '5', endingQuantity: '5', companyId: companyBId,
    });
  });

  async function withTenantConnection(run: (client: pg.PoolClient) => Promise<void>) {
    const { Pool } = pg;
    const pool = new Pool({
      host: process.env.SQL_HOST, user: process.env.TENANT_DB_USER,
      password: process.env.TENANT_DB_PASSWORD, database: process.env.SQL_DB_NAME,
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.company_id', $1, true)", [companyAId]);
      await run(client);
      await client.query('ROLLBACK');
    } finally {
      client.release();
      await pool.end();
    }
  }

  it('cannot see Company B\'s purchase_requisitions row', async () => {
    await withTenantConnection(async (client) => {
      const res = await client.query('SELECT id FROM purchase_requisitions');
      expect(res.rows.map((r: any) => r.id)).not.toContain(prBId);
    });
  });

  it('cannot see Company B\'s purchase_orders row', async () => {
    await withTenantConnection(async (client) => {
      const res = await client.query('SELECT id FROM purchase_orders');
      expect(res.rows.map((r: any) => r.id)).not.toContain(poBId);
    });
  });

  it('cannot see Company B\'s goods_receipt_notes row, nor its child goods_receipt_note_items row via the EXISTS policy', async () => {
    await withTenantConnection(async (client) => {
      const grnRes = await client.query('SELECT id FROM goods_receipt_notes');
      expect(grnRes.rows.map((r: any) => r.id)).not.toContain(grnBId);
      const itemRes = await client.query('SELECT id FROM goods_receipt_note_items');
      expect(itemRes.rows.map((r: any) => r.id)).not.toContain(grnItemBId);
    });
  });

  it('cannot see Company B\'s inventory_stocks row', async () => {
    await withTenantConnection(async (client) => {
      const res = await client.query('SELECT id FROM inventory_stocks');
      expect(res.rows.map((r: any) => r.id)).not.toContain(stockBId);
    });
  });

  it('cannot see Company B\'s stock_ledger_transactions row', async () => {
    await withTenantConnection(async (client) => {
      const res = await client.query('SELECT id FROM stock_ledger_transactions');
      expect(res.rows.map((r: any) => r.id)).not.toContain(ledgerBId);
    });
  });
});
