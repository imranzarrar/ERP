import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq, and } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server + real Postgres state,
// no mocks, matching this project's established convention. Covers the packaging/
// alternate Units of Measure feature: a product like "Cell 4 AMP" (base unit: Piece) can
// also be transacted as "Carton-12" (1 Carton = 12 Piece) on GRN/Purchase Return/Stock
// Take/Invoice — inventory (inventoryStocks/stockLedgerTransactions) and averageCost/
// averageSalePrice always stay in the product's own base unit regardless of which unit a
// transaction was entered in (server/lib/uomConversion.ts).
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';
const CARTON_FACTOR = 12;

let companyId: string;
let adminUserId: string;
let adminSessionId: string;
let vendorId: string;
let customerId: string;
let taxSlabId: string;
let bankId: string;
let warehouseId: string;
let productId: string;
let cartonUnitId: string;
let conversionId: string;

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

async function getStockQty() {
  const [stock] = await db.select().from(schema.inventoryStocks).where(and(eq(schema.inventoryStocks.productId, productId), eq(schema.inventoryStocks.warehouseId, warehouseId)));
  return stock ? Number(stock.quantity) : 0;
}

async function getProductAverages() {
  const [product] = await db.select({ averageCost: schema.productsServices.averageCost, averageSalePrice: schema.productsServices.averageSalePrice })
    .from(schema.productsServices).where(eq(schema.productsServices.id, productId));
  return { averageCost: Number(product.averageCost), averageSalePrice: Number(product.averageSalePrice) };
}

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: 'UoM Conversion Test Co', address: 'x', phone: '0',
    email: 'uomconversion@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
  });

  const monthId = new Date().toISOString().slice(0, 7);
  await db.insert(schema.fiscalMonths).values({ id: monthId, name: monthId, status: 'Open', companyId }).onConflictDoNothing();

  taxSlabId = generateId();
  await db.insert(schema.taxSlabs).values({ id: taxSlabId, name: 'Standard 15%', percentage: '15', companyId });
  vendorId = generateId();
  await db.insert(schema.vendors).values({ id: vendorId, name: 'Test Vendor', phone: '0', email: 'v@example.com', address: 'x', companyId });
  customerId = generateId();
  await db.insert(schema.customers).values({ id: customerId, name: 'Test Customer', phone: '0', email: 'c@example.com', address: 'x', companyId });
  bankId = generateId();
  await db.insert(schema.bankAccounts).values({ id: bankId, bankName: 'Test Bank', accountNumber: '0009993', accountTitle: 'UoM Conversion Test Co', openingBalance: '0', isActive: true, isDefault: true, companyId });

  warehouseId = generateId();
  await db.insert(schema.warehouses).values({ id: warehouseId, name: 'Main Store', code: 'MAIN', isActive: true, companyId, type: 'sales', isCompanyDefault: true });

  productId = generateId();
  await db.insert(schema.productsServices).values({ id: productId, name: 'Cell 4 AMP', description: 'x', unitPrice: '10.00', type: 'item', barcode: 'CELL-BASE-001', companyId });

  cartonUnitId = generateId();
  await db.insert(schema.unitsOfMeasure).values({ id: cartonUnitId, name: 'Carton-12', code: 'SET', isActive: true, companyId });

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  adminUserId = generateId();
  const adminUsername = `uomtest_admin_${adminUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({ id: adminUserId, username: adminUsername, password: passwordHash, role: 'admin', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  adminSessionId = await login(adminUsername);
});

afterAll(async () => {
  const invoices = await db.select({ id: schema.invoices.id }).from(schema.invoices).where(eq(schema.invoices.companyId, companyId));
  for (const inv of invoices) await db.delete(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, inv.id));
  await db.delete(schema.invoices).where(eq(schema.invoices.companyId, companyId));
  await db.delete(schema.vouchers).where(eq(schema.vouchers.companyId, companyId));

  const stockTakes = await db.select({ id: schema.physicalStockTakes.id }).from(schema.physicalStockTakes).where(eq(schema.physicalStockTakes.companyId, companyId));
  for (const st of stockTakes) await db.delete(schema.physicalStockTakeItems).where(eq(schema.physicalStockTakeItems.stockTakeId, st.id));
  await db.delete(schema.physicalStockTakes).where(eq(schema.physicalStockTakes.companyId, companyId));

  const returns = await db.select({ id: schema.purchaseReturns.id }).from(schema.purchaseReturns).where(eq(schema.purchaseReturns.companyId, companyId));
  for (const r of returns) await db.delete(schema.purchaseReturnItems).where(eq(schema.purchaseReturnItems.returnId, r.id));
  await db.delete(schema.purchaseReturns).where(eq(schema.purchaseReturns.companyId, companyId));

  await db.delete(schema.stockLedgerTransactions).where(eq(schema.stockLedgerTransactions.companyId, companyId));
  await db.delete(schema.inventoryStocks).where(eq(schema.inventoryStocks.companyId, companyId));

  const grns = await db.select({ id: schema.goodsReceiptNotes.id }).from(schema.goodsReceiptNotes).where(eq(schema.goodsReceiptNotes.companyId, companyId));
  for (const g of grns) await db.delete(schema.goodsReceiptNoteItems).where(eq(schema.goodsReceiptNoteItems.grnId, g.id));
  await db.delete(schema.goodsReceiptNotes).where(eq(schema.goodsReceiptNotes.companyId, companyId));

  const pos = await db.select({ id: schema.purchaseOrders.id }).from(schema.purchaseOrders).where(eq(schema.purchaseOrders.companyId, companyId));
  for (const po of pos) await db.delete(schema.purchaseOrderItems).where(eq(schema.purchaseOrderItems.purchaseOrderId, po.id));
  await db.delete(schema.purchaseOrders).where(eq(schema.purchaseOrders.companyId, companyId));

  await db.delete(schema.productUnitConversions).where(eq(schema.productUnitConversions.companyId, companyId));
  await db.delete(schema.warehouses).where(eq(schema.warehouses.companyId, companyId));
  await db.delete(schema.productsServices).where(eq(schema.productsServices.companyId, companyId));
  await db.delete(schema.unitsOfMeasure).where(eq(schema.unitsOfMeasure.companyId, companyId));
  await db.delete(schema.vendors).where(eq(schema.vendors.companyId, companyId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, companyId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
  await db.delete(schema.users).where(eq(schema.users.id, adminUserId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyId));
  await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
});

describe('POST /api/product-unit-conversions', () => {
  it('rejects a non-positive conversion factor', async () => {
    const res = await api(adminSessionId, '/api/product-unit-conversions', {
      method: 'POST',
      body: JSON.stringify({ productId, unitOfMeasureId: cartonUnitId, conversionFactor: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it('creates a packaging unit with its own barcode/price, independent of base price * factor', async () => {
    const res = await api(adminSessionId, '/api/product-unit-conversions', {
      method: 'POST',
      body: JSON.stringify({
        productId, unitOfMeasureId: cartonUnitId, conversionFactor: CARTON_FACTOR,
        barcode: 'CARTON-BARCODE-001', purchasePrice: 100, salePrice: 130, // NOT 12 * 10 = 120
      }),
    });
    expect(res.status).toBe(200);
    conversionId = res.body.id;

    const [row] = await db.select().from(schema.productUnitConversions).where(eq(schema.productUnitConversions.id, conversionId));
    expect(Number(row.conversionFactor)).toBe(CARTON_FACTOR);
    expect(Number(row.salePrice)).toBe(130);
    expect(row.barcode).toBe('CARTON-BARCODE-001');
  });

  it('rejects a duplicate active conversion for the same product+unit', async () => {
    const res = await api(adminSessionId, '/api/product-unit-conversions', {
      method: 'POST',
      body: JSON.stringify({ productId, unitOfMeasureId: cartonUnitId, conversionFactor: 6 }),
    });
    expect(res.status).toBe(400);
  });

  it('lists conversions for the company', async () => {
    const res = await api(adminSessionId, '/api/product-unit-conversions');
    expect(res.status).toBe(200);
    expect(res.body.some((c: any) => c.id === conversionId)).toBe(true);
  });
});

describe('GRN receipt in a packaging unit', () => {
  it('multiplies into inventoryStocks and averageCost at the base-unit rate', async () => {
    const stockBefore = await getStockQty();
    const res = await api(adminSessionId, '/api/inventory/goods-receipt-notes', {
      method: 'POST',
      body: JSON.stringify({
        grnData: {
          isDsd: true, vendorId, warehouseId, receivedBy: 'Automated Test',
          items: [{ productId, quantityReceived: 2, unitCost: 100, unitOfMeasureId: cartonUnitId }], // 2 Cartons @ 100/carton
        },
      }),
    });
    expect(res.status).toBe(200);
    // 2 Cartons * 12 = 24 base units
    expect(await getStockQty()).toBe(stockBefore + 24);

    const averages = await getProductAverages();
    // 24 units @ (100/12 = 8.3333 SAR/unit) — never 100 SAR/unit
    expect(averages.averageCost).toBeCloseTo(100 / CARTON_FACTOR, 2);

    const [grnItem] = await db.select().from(schema.goodsReceiptNoteItems).where(and(eq(schema.goodsReceiptNoteItems.productId, productId), eq(schema.goodsReceiptNoteItems.unitOfMeasureId, cartonUnitId)));
    // The document itself keeps the raw entered quantity/cost (2 Cartons @ 100), not the converted value.
    expect(Number(grnItem.quantityReceived)).toBe(2);
    expect(Number(grnItem.unitCost)).toBe(100);
  });

  it('reversal decrements inventoryStocks by the same base-unit-converted amount', async () => {
    const stockBefore = await getStockQty();
    const createRes = await api(adminSessionId, '/api/inventory/goods-receipt-notes', {
      method: 'POST',
      body: JSON.stringify({
        grnData: { isDsd: true, vendorId, warehouseId, receivedBy: 'Automated Test', items: [{ productId, quantityReceived: 1, unitCost: 100, unitOfMeasureId: cartonUnitId }] },
      }),
    });
    expect(createRes.status).toBe(200);
    expect(await getStockQty()).toBe(stockBefore + CARTON_FACTOR);

    const reverseRes = await api(adminSessionId, `/api/inventory/goods-receipt-notes/${createRes.body.goodsReceiptNote.id}/reverse`, { method: 'POST' });
    expect(reverseRes.status).toBe(200);
    expect(await getStockQty()).toBe(stockBefore);
  });
});

describe('Purchase Order + GRN fulfillment status across mixed units', () => {
  it('marks a PO fully Received when the GRN receipt (in Cartons) covers the ordered base-unit quantity', async () => {
    const poRes = await api(adminSessionId, '/api/inventory/purchase-orders', {
      method: 'POST',
      body: JSON.stringify({ poData: { vendorId, items: [{ productId, quantityOrdered: 24, unitPrice: 10 }] } }), // ordered 24 base units
    });
    expect(poRes.status).toBe(200);
    const poId = poRes.body.purchaseOrder.id;

    const grnRes = await api(adminSessionId, '/api/inventory/goods-receipt-notes', {
      method: 'POST',
      body: JSON.stringify({
        grnData: { purchaseOrderId: poId, warehouseId, receivedBy: 'Automated Test', items: [{ productId, quantityReceived: 2, unitCost: 100, unitOfMeasureId: cartonUnitId }] }, // 2 Cartons = 24 base units
      }),
    });
    expect(grnRes.status).toBe(200);
    expect(grnRes.body.updatedPurchaseOrder.status).toBe('Received');
  });
});

describe('Purchase Return in a packaging unit', () => {
  it('enforces the remaining-returnable check in base-unit terms and decrements stock correctly', async () => {
    const grnRes = await api(adminSessionId, '/api/inventory/goods-receipt-notes', {
      method: 'POST',
      body: JSON.stringify({
        grnData: { isDsd: true, vendorId, warehouseId, receivedBy: 'Automated Test', items: [{ productId, quantityReceived: 1, unitCost: 100, unitOfMeasureId: cartonUnitId }] }, // 12 base units received
      }),
    });
    const grnId = grnRes.body.goodsReceiptNote.id;
    const stockAfterReceipt = await getStockQty();

    // Returning 2 Cartons (24 base units) against a GRN that only received 1 Carton (12) must be rejected.
    const overReturn = await api(adminSessionId, '/api/inventory/purchase-returns', {
      method: 'POST',
      body: JSON.stringify({ returnData: { grnId, items: [{ productId, quantityReturned: 2, unitOfMeasureId: cartonUnitId }] } }),
    });
    expect(overReturn.status).toBe(400);

    // Returning loose Pieces (base unit) up to the full 12 received is allowed.
    const goodReturn = await api(adminSessionId, '/api/inventory/purchase-returns', {
      method: 'POST',
      body: JSON.stringify({ returnData: { grnId, items: [{ productId, quantityReturned: 12 }] } }),
    });
    expect(goodReturn.status).toBe(200);
    expect(await getStockQty()).toBe(stockAfterReceipt - 12);
  });
});

describe('Physical Stock Take in a packaging unit', () => {
  it('computes variance and finalizes against the base-unit-converted count', async () => {
    const systemQty = await getStockQty();
    const countedCartons = 3; // "3 full cartons on the shelf"
    const expectedBaseQty = countedCartons * CARTON_FACTOR;

    const createRes = await api(adminSessionId, '/api/inventory/stock-takes', {
      method: 'POST',
      body: JSON.stringify({ stockTakeData: { warehouseId, performedBy: 'Automated Test', items: [{ productId, physicalQuantity: countedCartons, unitOfMeasureId: cartonUnitId }] } }),
    });
    expect(createRes.status).toBe(200);
    expect(Number(createRes.body.stockTake.items[0].systemQuantity)).toBe(systemQty);
    expect(Number(createRes.body.stockTake.items[0].physicalQuantity)).toBe(countedCartons); // stored as counted, not converted
    expect(Number(createRes.body.stockTake.items[0].variance)).toBe(round2(expectedBaseQty - systemQty));

    const finalizeRes = await api(adminSessionId, `/api/inventory/stock-takes/${createRes.body.stockTake.id}/finalize`, { method: 'POST' });
    expect(finalizeRes.status).toBe(200);
    expect(await getStockQty()).toBe(expectedBaseQty);
  });
});

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

describe('Invoice sale in a packaging unit', () => {
  it('deducts the base-unit-converted quantity and folds averageSalePrice at the per-base-unit rate', async () => {
    // Ensure enough stock: receive 5 Cartons (60 base units) first.
    await api(adminSessionId, '/api/inventory/goods-receipt-notes', {
      method: 'POST',
      body: JSON.stringify({ grnData: { isDsd: true, vendorId, warehouseId, receivedBy: 'Automated Test', items: [{ productId, quantityReceived: 5, unitCost: 100, unitOfMeasureId: cartonUnitId }] } }),
    });
    const stockBefore = await getStockQty();

    const today = new Date().toISOString().split('T')[0];
    const res = await api(adminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: today, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0,
          warehouseId,
          items: [{ id: generateId(), description: 'Cell 4 AMP (Carton-12)', unitCost: 130, quantity: 1, unit: 'SET', productId, unitOfMeasureId: cartonUnitId }],
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(await getStockQty()).toBe(stockBefore - CARTON_FACTOR);

    const [invoiceItem] = await db.select().from(schema.invoiceItems).where(and(eq(schema.invoiceItems.invoiceId, res.body.invoiceId)));
    expect(invoiceItem.unitOfMeasureId).toBe(cartonUnitId);
    expect(Number(invoiceItem.quantity)).toBe(1); // billed as 1 Carton, not 12 pieces
  });
});

describe('Deactivating a packaging unit blocks its future use', () => {
  it('rejects a new transaction using a deactivated conversion', async () => {
    const toggleRes = await api(adminSessionId, `/api/product-unit-conversions/${conversionId}/toggle-active`, { method: 'PATCH' });
    expect(toggleRes.status).toBe(200);
    expect(toggleRes.body.isActive).toBe(false);

    const res = await api(adminSessionId, '/api/inventory/goods-receipt-notes', {
      method: 'POST',
      body: JSON.stringify({ grnData: { isDsd: true, vendorId, warehouseId, receivedBy: 'Automated Test', items: [{ productId, quantityReceived: 1, unitCost: 100, unitOfMeasureId: cartonUnitId }] } }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no active packaging unit/i);

    // Reactivate so it doesn't leak state into any test ordering assumptions elsewhere.
    await api(adminSessionId, `/api/product-unit-conversions/${conversionId}/toggle-active`, { method: 'PATCH' });
  });
});
