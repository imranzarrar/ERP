import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq, and } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server + real Postgres state, no
// mocks, matching this project's established convention. Covers the productsServices
// type-column split this session implemented: itemKind ('item'|'service') now drives every
// stock-mutating code path, replacing a column that was overloaded for two unrelated
// concepts (the previous `type` held 'Sales'/'Purchase', while server-side stock logic
// checked the same column for the literal 'item' — a value the form never actually wrote,
// silently making stock deduction dead code for every real product). Also covers the two
// newly-added restock paths (Invoice cancel, Credit Note) that previously never touched
// inventoryStocks at all.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let adminUserId: string;
let adminSessionId: string;
let customerId: string;
let vendorId: string;
let taxSlabId: string;
let bankId: string;
let warehouseId: string;
let itemProductId: string;
let serviceProductId: string;

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
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });
  const body = await res.json().catch(() => null);
  if (!body?.sessionId) throw new Error(`Login failed for ${username}: status ${res.status}, body ${JSON.stringify(body)}`);
  return body.sessionId as string;
}

async function stockQty(productId: string) {
  const [row] = await db.select().from(schema.inventoryStocks).where(and(
    eq(schema.inventoryStocks.productId, productId),
    eq(schema.inventoryStocks.warehouseId, warehouseId),
  ));
  return row ? Number(row.quantity) : 0;
}

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: 'ItemKind Gating Test Co', address: 'x', phone: '0',
    email: 'itemkindtest@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
  });
  const today = new Date().toISOString().split('T')[0];
  await db.insert(schema.fiscalMonths).values({ id: today.slice(0, 7), name: today.slice(0, 7), status: 'Open', companyId }).onConflictDoNothing();

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  adminUserId = generateId();
  const adminUsername = `ikgate_admin_${adminUserId}`;
  await db.insert(schema.users).values({ id: adminUserId, username: adminUsername, password: passwordHash, role: 'admin', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  adminSessionId = await login(adminUsername);

  customerId = generateId();
  await db.insert(schema.customers).values({ id: customerId, name: 'Test Customer', phone: '0', email: 'c@example.com', address: 'x', companyId });
  vendorId = generateId();
  await db.insert(schema.vendors).values({ id: vendorId, name: 'Test Vendor', phone: '0', email: 'v@example.com', address: 'x', companyId });
  taxSlabId = generateId();
  await db.insert(schema.taxSlabs).values({ id: taxSlabId, name: 'Standard 15%', percentage: '15', companyId });
  bankId = generateId();
  await db.insert(schema.bankAccounts).values({ id: bankId, bankName: 'Test Bank', accountNumber: '000', accountTitle: 'Test Account', openingBalance: '0', companyId });
  warehouseId = generateId();
  await db.insert(schema.warehouses).values({ id: warehouseId, name: 'Main Store', code: 'MAIN', address: 'x', isActive: true, companyId });

  itemProductId = generateId();
  await db.insert(schema.productsServices).values({ id: itemProductId, name: 'Physical Widget', description: 'x', unitPrice: '10.00', itemKind: 'item', companyId });
  serviceProductId = generateId();
  await db.insert(schema.productsServices).values({ id: serviceProductId, name: 'Consulting Hour', description: 'x', unitPrice: '50.00', itemKind: 'service', companyId });
});

afterAll(async () => {
  const invoices = await db.select({ id: schema.invoices.id }).from(schema.invoices).where(eq(schema.invoices.companyId, companyId));
  for (const inv of invoices) {
    await db.delete(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, inv.id));
  }
  await db.delete(schema.invoices).where(eq(schema.invoices.companyId, companyId));
  const grns = await db.select({ id: schema.goodsReceiptNotes.id }).from(schema.goodsReceiptNotes).where(eq(schema.goodsReceiptNotes.companyId, companyId));
  for (const g of grns) {
    await db.delete(schema.goodsReceiptNoteItems).where(eq(schema.goodsReceiptNoteItems.grnId, g.id));
  }
  await db.delete(schema.goodsReceiptNotes).where(eq(schema.goodsReceiptNotes.companyId, companyId));
  const dispatches = await db.select({ id: schema.warehouseDispatches.id }).from(schema.warehouseDispatches).where(eq(schema.warehouseDispatches.companyId, companyId));
  for (const d of dispatches) {
    await db.delete(schema.warehouseDispatchItems).where(eq(schema.warehouseDispatchItems.dispatchId, d.id));
  }
  const receivings = await db.select({ id: schema.warehouseReceivings.id }).from(schema.warehouseReceivings).where(eq(schema.warehouseReceivings.companyId, companyId));
  for (const r of receivings) {
    await db.delete(schema.warehouseReceivingItems).where(eq(schema.warehouseReceivingItems.receivingId, r.id));
  }
  await db.delete(schema.warehouseReceivings).where(eq(schema.warehouseReceivings.companyId, companyId));
  await db.delete(schema.warehouseDispatches).where(eq(schema.warehouseDispatches.companyId, companyId));
  const stockTakes = await db.select({ id: schema.physicalStockTakes.id }).from(schema.physicalStockTakes).where(eq(schema.physicalStockTakes.companyId, companyId));
  for (const st of stockTakes) {
    await db.delete(schema.physicalStockTakeItems).where(eq(schema.physicalStockTakeItems.stockTakeId, st.id));
  }
  await db.delete(schema.physicalStockTakes).where(eq(schema.physicalStockTakes.companyId, companyId));
  await db.delete(schema.stockLedgerTransactions).where(eq(schema.stockLedgerTransactions.companyId, companyId));
  await db.delete(schema.inventoryStocks).where(eq(schema.inventoryStocks.companyId, companyId));
  await db.delete(schema.warehouses).where(eq(schema.warehouses.companyId, companyId));
  await db.delete(schema.productsServices).where(eq(schema.productsServices.companyId, companyId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, companyId));
  await db.delete(schema.vendors).where(eq(schema.vendors.companyId, companyId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
  await db.delete(schema.users).where(eq(schema.users.id, adminUserId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyId));
  await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
});

describe('GRN receive — itemKind gating', () => {
  it('increases stock for an item-kind product', async () => {
    const before = await stockQty(itemProductId);
    const { status } = await api(adminSessionId, '/api/inventory/goods-receipt-notes', {
      method: 'POST',
      body: JSON.stringify({ grnData: { isDsd: true, vendorId, warehouseId, receivedBy: 'Test', items: [{ productId: itemProductId, quantityReceived: 10, unitCost: 5 }] } }),
    });
    expect(status).toBe(200);
    expect(await stockQty(itemProductId)).toBe(before + 10);
  });

  it('does not create a stock row for a service-kind product (GRN still succeeds)', async () => {
    const { status } = await api(adminSessionId, '/api/inventory/goods-receipt-notes', {
      method: 'POST',
      body: JSON.stringify({ grnData: { isDsd: true, vendorId, warehouseId, receivedBy: 'Test', items: [{ productId: serviceProductId, quantityReceived: 10, unitCost: 5 }] } }),
    });
    expect(status).toBe(200);
    expect(await stockQty(serviceProductId)).toBe(0);
  });
});

describe('Stock Adjustment — itemKind gating', () => {
  it('applies to an item-kind product', async () => {
    const { status, body } = await api(adminSessionId, '/api/inventory/stock-adjustments', {
      method: 'POST',
      body: JSON.stringify({ productId: itemProductId, warehouseId, quantity: 3, reason: 'Recount' }),
    });
    expect(status).toBe(200);
    expect(Number(body.inventoryStock.quantity)).toBeGreaterThan(0);
  });

  it('rejects a service-kind product with a clear message, not a silent no-op', async () => {
    const { status, body } = await api(adminSessionId, '/api/inventory/stock-adjustments', {
      method: 'POST',
      body: JSON.stringify({ productId: serviceProductId, warehouseId, quantity: 5, reason: 'Recount' }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/physical-item products, not services/i);
  });
});

describe('Stock Take finalize — itemKind gating', () => {
  it('skips a service-kind line entirely, applies an item-kind line', async () => {
    const beforeItem = await stockQty(itemProductId);
    const { body: stBody } = await api(adminSessionId, '/api/inventory/stock-takes', {
      method: 'POST',
      body: JSON.stringify({
        stockTakeData: {
          warehouseId, performedBy: 'Test',
          items: [
            { productId: itemProductId, physicalQuantity: beforeItem + 7 },
            { productId: serviceProductId, physicalQuantity: 999 },
          ],
        },
      }),
    });
    const finalizeRes = await api(adminSessionId, `/api/inventory/stock-takes/${stBody.stockTake.id}/finalize`, { method: 'POST' });
    expect(finalizeRes.status).toBe(200);
    expect(await stockQty(itemProductId)).toBe(beforeItem + 7);
    expect(await stockQty(serviceProductId)).toBe(0); // never touched, despite the 999 count submitted
  });
});

describe('Warehouse Dispatch — itemKind gating', () => {
  it('a service-kind line is skipped, not treated as insufficient stock', async () => {
    // No stock exists anywhere for serviceProductId — if the itemKind guard didn't skip
    // this line before the insufficient-stock check, this would 400 instead of 200.
    const otherWarehouseId = generateId();
    await db.insert(schema.warehouses).values({ id: otherWarehouseId, name: 'Second Store', code: 'SEC', address: 'x', isActive: true, companyId });
    const { status } = await api(adminSessionId, '/api/inventory/warehouse-dispatches', {
      method: 'POST',
      body: JSON.stringify({
        dispatchData: {
          fromWarehouseId: warehouseId, toWarehouseId: otherWarehouseId, dispatchedBy: 'Test',
          items: [{ productId: serviceProductId, quantityDispatched: 1, batchNumber: null }],
        },
      }),
    });
    expect(status).toBe(200);
  });
});

describe('Sales-side deduction + restock (Invoice cancel, Credit Note) — the original bug this session fixed', () => {
  async function createInvoice(quantity: number) {
    const today = new Date().toISOString().split('T')[0];
    const { status, body } = await api(adminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: today, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0, warehouseId,
          items: [{ id: generateId(), description: 'Physical Widget sale', unitCost: 10, quantity, unit: 'PCE', productId: itemProductId }],
        },
      }),
    });
    if (status !== 200) throw new Error(`createInvoice failed: ${status} ${JSON.stringify(body)}`);
    return body.invoiceId as string;
  }

  it('deducts stock on sale — previously dead code (type check never matched, itemKind now does)', async () => {
    // Give it real stock to sell against first.
    await api(adminSessionId, '/api/inventory/stock-adjustments', {
      method: 'POST',
      body: JSON.stringify({ productId: itemProductId, warehouseId, quantity: 100, reason: 'Seed for sale test' }),
    });
    const before = await stockQty(itemProductId);
    await createInvoice(6);
    expect(await stockQty(itemProductId)).toBe(before - 6);
  });

  it('cancelling the invoice restores the deducted stock — previously never happened at all', async () => {
    const before = await stockQty(itemProductId);
    const invoiceId = await createInvoice(4);
    expect(await stockQty(itemProductId)).toBe(before - 4);

    const cancelRes = await api(adminSessionId, `/api/transactions/invoices/${invoiceId}/cancel`, { method: 'POST' });
    expect(cancelRes.status).toBe(200);
    expect(await stockQty(itemProductId)).toBe(before);
  });

  it('issuing a Credit Note restores the deducted stock — a pre-existing, explicitly-flagged gap', async () => {
    const before = await stockQty(itemProductId);
    const invoiceId = await createInvoice(3);
    expect(await stockQty(itemProductId)).toBe(before - 3);

    const noteRes = await api(adminSessionId, `/api/transactions/invoices/${invoiceId}/note`, {
      method: 'POST',
      body: JSON.stringify({ type: 'CreditNote', reason: 'Test credit note restock' }),
    });
    expect(noteRes.status).toBe(200);
    expect(await stockQty(itemProductId)).toBe(before);
  });
});
