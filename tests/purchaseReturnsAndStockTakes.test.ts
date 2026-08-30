import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server + real Postgres state,
// matching this project's established no-mocks testing practice. Covers Purchase Returns
// (Debit Notes) and Physical Stock Takes (BACKLOG.md) — both previously pure schema stubs
// with zero backend/frontend implementation anywhere.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let adminUserId: string;
let adminSessionId: string;
let staffUserId: string;
let staffSessionId: string;
let productId: string;
let vendorId: string;
let warehouseId: string;

async function api(sessionId: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function login(username: string) {
  const res = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });
  const body = await res.json().catch(() => null);
  if (!body?.sessionId) throw new Error(`Login failed for ${username}: status ${res.status}, body ${JSON.stringify(body)}`);
  return body.sessionId as string;
}

async function createGrn(quantityReceived: number, unitCost = 10) {
  const { status, body } = await api(adminSessionId, '/api/inventory/goods-receipt-notes', {
    method: 'POST',
    body: JSON.stringify({
      grnData: { isDsd: true, vendorId, warehouseId, receivedBy: 'Automated Test', items: [{ productId, quantityReceived, unitCost }] },
    }),
  });
  if (status !== 200) throw new Error(`createGrn failed: ${status} ${JSON.stringify(body)}`);
  return body.goodsReceiptNote.id as string;
}

async function getStockQty() {
  const [stock] = await db.select().from(schema.inventoryStocks).where(eq(schema.inventoryStocks.productId, productId));
  return stock ? Number(stock.quantity) : 0;
}

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: 'Returns StockTake Test Co', address: 'x', phone: '0',
    email: 'returnsstocktake@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
  });

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  adminUserId = generateId();
  const adminUsername = `retst_admin_${adminUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({
    id: adminUserId, username: adminUsername, password: passwordHash, role: 'admin', companyId, isSuperAdmin: false, uiLanguage: 'en',
  });
  staffUserId = generateId();
  const staffUsername = `retst_staff_${staffUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({
    id: staffUserId, username: staffUsername, password: passwordHash, role: 'user', companyId, isSuperAdmin: false, uiLanguage: 'en',
  });
  adminSessionId = await login(adminUsername);
  staffSessionId = await login(staffUsername);

  vendorId = generateId();
  await db.insert(schema.vendors).values({ id: vendorId, name: 'Test Vendor', phone: '0', email: 'v@example.com', address: 'x', companyId });

  productId = generateId();
  await db.insert(schema.productsServices).values({ id: productId, name: 'Return Test Widget', description: 'x', unitPrice: '10.00', type: 'item', companyId });

  warehouseId = generateId();
  await db.insert(schema.warehouses).values({ id: warehouseId, name: 'Main Store', code: 'MAIN', address: 'x', isActive: true, companyId });
});

afterAll(async () => {
  const stockTakes = await db.select({ id: schema.physicalStockTakes.id }).from(schema.physicalStockTakes).where(eq(schema.physicalStockTakes.companyId, companyId));
  for (const st of stockTakes) {
    await db.delete(schema.physicalStockTakeItems).where(eq(schema.physicalStockTakeItems.stockTakeId, st.id));
  }
  await db.delete(schema.physicalStockTakes).where(eq(schema.physicalStockTakes.companyId, companyId));
  const returns = await db.select({ id: schema.purchaseReturns.id }).from(schema.purchaseReturns).where(eq(schema.purchaseReturns.companyId, companyId));
  for (const r of returns) {
    await db.delete(schema.purchaseReturnItems).where(eq(schema.purchaseReturnItems.returnId, r.id));
  }
  await db.delete(schema.purchaseReturns).where(eq(schema.purchaseReturns.companyId, companyId));
  await db.delete(schema.inventoryStocks).where(eq(schema.inventoryStocks.companyId, companyId));
  const grns = await db.select({ id: schema.goodsReceiptNotes.id }).from(schema.goodsReceiptNotes).where(eq(schema.goodsReceiptNotes.companyId, companyId));
  for (const g of grns) {
    await db.delete(schema.goodsReceiptNoteItems).where(eq(schema.goodsReceiptNoteItems.grnId, g.id));
  }
  await db.delete(schema.goodsReceiptNotes).where(eq(schema.goodsReceiptNotes.companyId, companyId));
  await db.delete(schema.stockLedgerTransactions).where(eq(schema.stockLedgerTransactions.companyId, companyId));
  await db.delete(schema.warehouses).where(eq(schema.warehouses.companyId, companyId));
  await db.delete(schema.productsServices).where(eq(schema.productsServices.companyId, companyId));
  await db.delete(schema.vendors).where(eq(schema.vendors.companyId, companyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
  await db.delete(schema.users).where(eq(schema.users.id, adminUserId));
  await db.delete(schema.users).where(eq(schema.users.id, staffUserId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
});

describe('POST /api/inventory/purchase-returns', () => {
  it('decrements stock and rejects returning more than was received', async () => {
    const grnId = await createGrn(10);
    const stockBefore = await getStockQty();

    const overReturn = await api(adminSessionId, '/api/inventory/purchase-returns', {
      method: 'POST',
      body: JSON.stringify({ returnData: { grnId, items: [{ productId, quantityReturned: 999 }] } }),
    });
    expect(overReturn.status).toBe(400);
    expect(overReturn.body.error).toMatch(/only .* remain returnable/i);

    const goodReturn = await api(adminSessionId, '/api/inventory/purchase-returns', {
      method: 'POST',
      body: JSON.stringify({ returnData: { grnId, items: [{ productId, quantityReturned: 4 }] } }),
    });
    expect(goodReturn.status).toBe(200);
    expect(goodReturn.body.purchaseReturn.status).toBe('Active');
    expect(await getStockQty()).toBe(stockBefore - 4);
  });

  it('rejects returning more than remains after a prior partial return against the same GRN', async () => {
    const grnId = await createGrn(10);
    const first = await api(adminSessionId, '/api/inventory/purchase-returns', {
      method: 'POST',
      body: JSON.stringify({ returnData: { grnId, items: [{ productId, quantityReturned: 7 }] } }),
    });
    expect(first.status).toBe(200);

    const second = await api(adminSessionId, '/api/inventory/purchase-returns', {
      method: 'POST',
      body: JSON.stringify({ returnData: { grnId, items: [{ productId, quantityReturned: 4 }] } }), // only 3 remain
    });
    expect(second.status).toBe(400);
  });

  it('rejects returning against a reversed GRN', async () => {
    const grnId = await createGrn(5);
    await api(adminSessionId, `/api/inventory/goods-receipt-notes/${grnId}/reverse`, { method: 'POST' });
    const { status, body } = await api(adminSessionId, '/api/inventory/purchase-returns', {
      method: 'POST',
      body: JSON.stringify({ returnData: { grnId, items: [{ productId, quantityReturned: 1 }] } }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/reversed/i);
  });

  it('rejects a caller without purchaseReturns.create permission', async () => {
    const grnId = await createGrn(5);
    const { status } = await api(staffSessionId, '/api/inventory/purchase-returns', {
      method: 'POST',
      body: JSON.stringify({ returnData: { grnId, items: [{ productId, quantityReturned: 1 }] } }),
    });
    expect(status).toBe(403);
  });
});

describe('PATCH /api/inventory/purchase-returns/:id/cancel', () => {
  it('reverses the stock decrement', async () => {
    const grnId = await createGrn(10);
    const stockBefore = await getStockQty();
    const { body } = await api(adminSessionId, '/api/inventory/purchase-returns', {
      method: 'POST',
      body: JSON.stringify({ returnData: { grnId, items: [{ productId, quantityReturned: 3 }] } }),
    });
    expect(await getStockQty()).toBe(stockBefore - 3);

    const cancelRes = await api(adminSessionId, `/api/inventory/purchase-returns/${body.purchaseReturn.id}/cancel`, { method: 'PATCH' });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.purchaseReturn.status).toBe('Cancelled');
    expect(await getStockQty()).toBe(stockBefore);
  });

  it('rejects cancelling an already-cancelled return', async () => {
    const grnId = await createGrn(5);
    const { body } = await api(adminSessionId, '/api/inventory/purchase-returns', {
      method: 'POST',
      body: JSON.stringify({ returnData: { grnId, items: [{ productId, quantityReturned: 1 }] } }),
    });
    await api(adminSessionId, `/api/inventory/purchase-returns/${body.purchaseReturn.id}/cancel`, { method: 'PATCH' });
    const { status } = await api(adminSessionId, `/api/inventory/purchase-returns/${body.purchaseReturn.id}/cancel`, { method: 'PATCH' });
    expect(status).toBe(400);
  });
});

describe('POST /api/inventory/stock-takes + finalize', () => {
  it('snapshots systemQuantity server-side and computes variance', async () => {
    await createGrn(20); // ensure known stock level exists
    const stockNow = await getStockQty();

    const { status, body } = await api(adminSessionId, '/api/inventory/stock-takes', {
      method: 'POST',
      body: JSON.stringify({ stockTakeData: { warehouseId, performedBy: 'Automated Test', items: [{ productId, physicalQuantity: stockNow - 2 }] } }),
    });
    expect(status).toBe(200);
    expect(body.stockTake.status).toBe('Draft');
    expect(Number(body.stockTake.items[0].systemQuantity)).toBe(stockNow);
    expect(Number(body.stockTake.items[0].variance)).toBe(-2);
  });

  it('finalize posts the counted quantity as the new stock level', async () => {
    const stockNow = await getStockQty();
    const targetQty = Math.max(0, stockNow - 5);
    const { body: stBody } = await api(adminSessionId, '/api/inventory/stock-takes', {
      method: 'POST',
      body: JSON.stringify({ stockTakeData: { warehouseId, performedBy: 'Automated Test', items: [{ productId, physicalQuantity: targetQty }] } }),
    });

    const finalizeRes = await api(adminSessionId, `/api/inventory/stock-takes/${stBody.stockTake.id}/finalize`, { method: 'POST' });
    expect(finalizeRes.status).toBe(200);
    expect(finalizeRes.body.stockTake.status).toBe('Completed');
    expect(await getStockQty()).toBe(targetQty);
  });

  it('rejects finalizing the same stock take twice', async () => {
    const stockNow = await getStockQty();
    const { body: stBody } = await api(adminSessionId, '/api/inventory/stock-takes', {
      method: 'POST',
      body: JSON.stringify({ stockTakeData: { warehouseId, performedBy: 'Automated Test', items: [{ productId, physicalQuantity: stockNow }] } }),
    });
    const first = await api(adminSessionId, `/api/inventory/stock-takes/${stBody.stockTake.id}/finalize`, { method: 'POST' });
    expect(first.status).toBe(200);
    const second = await api(adminSessionId, `/api/inventory/stock-takes/${stBody.stockTake.id}/finalize`, { method: 'POST' });
    expect(second.status).toBe(400);
  });

  it('a Draft stock take can be cancelled without touching stock', async () => {
    const stockBefore = await getStockQty();
    const { body: stBody } = await api(adminSessionId, '/api/inventory/stock-takes', {
      method: 'POST',
      body: JSON.stringify({ stockTakeData: { warehouseId, performedBy: 'Automated Test', items: [{ productId, physicalQuantity: 0 }] } }),
    });
    const cancelRes = await api(adminSessionId, `/api/inventory/stock-takes/${stBody.stockTake.id}/cancel`, { method: 'PATCH' });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.stockTake.status).toBe('Cancelled');
    expect(await getStockQty()).toBe(stockBefore); // untouched — never finalized
  });

  it('a Completed stock take cannot be cancelled', async () => {
    const stockNow = await getStockQty();
    const { body: stBody } = await api(adminSessionId, '/api/inventory/stock-takes', {
      method: 'POST',
      body: JSON.stringify({ stockTakeData: { warehouseId, performedBy: 'Automated Test', items: [{ productId, physicalQuantity: stockNow }] } }),
    });
    await api(adminSessionId, `/api/inventory/stock-takes/${stBody.stockTake.id}/finalize`, { method: 'POST' });
    const { status } = await api(adminSessionId, `/api/inventory/stock-takes/${stBody.stockTake.id}/cancel`, { method: 'PATCH' });
    expect(status).toBe(400);
  });

  it('rejects a caller without stockTakes.create permission', async () => {
    const { status } = await api(staffSessionId, '/api/inventory/stock-takes', {
      method: 'POST',
      body: JSON.stringify({ stockTakeData: { warehouseId, performedBy: 'x', items: [{ productId, physicalQuantity: 0 }] } }),
    });
    expect(status).toBe(403);
  });
});
