import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq, and } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server + real Postgres state,
// no mocks, matching this project's established convention. Covers the sales-warehouse
// routing feature: warehouses.type ('sales' | 'backend'), the two-tier default resolution
// (branch default -> company default), the mandatory-branch-for-new-warehouse rule, the
// "at least one default warehouse" auto-provisioning on a company's first warehouse, and
// the opt-in stock-availability enforcement (companies.inventorySettings.
// enforceStockAvailability). Two companies are used: `companyId` (pre-provisioned with
// branches/warehouses, for resolution/deduction/availability tests) and
// `noWarehouseCompanyId` (starts with zero branches/warehouses, for the "nothing
// configured yet" boundary cases), kept isolated so one company's warehouse setup can
// never influence the other's resolution.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let noWarehouseCompanyId: string;
let adminUserId: string;
let adminSessionId: string;
let noWhAdminUserId: string;
let noWhAdminSessionId: string;
let customerId: string;
let taxSlabId: string;
let bankId: string;
let stockProductId: string;
let serviceProductId: string;
let branchAId: string;
let warehouseCompanyDefaultId: string;
let warehouseBranchDefaultId: string;
let warehouseBackendId: string;
let noWhCustomerId: string;
let noWhTaxSlabId: string;
let noWhBankId: string;
let noWhServiceProductId: string;
let noWhStockProductId: string;

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

async function stockQty(productId: string, warehouseId: string) {
  const [row] = await db.select().from(schema.inventoryStocks).where(and(
    eq(schema.inventoryStocks.productId, productId),
    eq(schema.inventoryStocks.warehouseId, warehouseId),
  ));
  return row ? Number(row.quantity) : 0;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  const today = new Date().toISOString().split('T')[0];

  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: 'Sales Warehouse Test Co', address: 'x', phone: '0',
    email: 'saleswh@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
  });
  const monthId = today.slice(0, 7);
  await db.insert(schema.fiscalMonths).values({ id: monthId, name: monthId, status: 'Open', companyId }).onConflictDoNothing();

  taxSlabId = generateId();
  await db.insert(schema.taxSlabs).values({ id: taxSlabId, name: 'Standard 15%', percentage: '15', companyId });
  customerId = generateId();
  await db.insert(schema.customers).values({ id: customerId, name: 'Test Customer', phone: '0', email: 'c@example.com', address: 'x', companyId });
  bankId = generateId();
  await db.insert(schema.bankAccounts).values({ id: bankId, bankName: 'Test Bank', accountNumber: '0009991', accountTitle: 'Sales WH Test Co', openingBalance: '0', isActive: true, isDefault: true, companyId });

  stockProductId = generateId();
  await db.insert(schema.productsServices).values({ id: stockProductId, name: 'Stock Widget', description: 'x', unitPrice: '10.00', itemKind: 'item', companyId });
  serviceProductId = generateId();
  await db.insert(schema.productsServices).values({ id: serviceProductId, name: 'Consulting Hour', description: 'x', unitPrice: '50.00', itemKind: 'service', companyId });

  branchAId = generateId();
  await db.insert(schema.branches).values({ id: branchAId, companyId, name: 'Branch A', code: 'BRA', isActive: true, isDefault: true });

  warehouseCompanyDefaultId = generateId();
  await db.insert(schema.warehouses).values({
    id: warehouseCompanyDefaultId, name: 'Company Default WH', code: 'CODEF', isActive: true, companyId,
    type: 'sales', isCompanyDefault: true,
  });
  warehouseBranchDefaultId = generateId();
  await db.insert(schema.warehouses).values({
    id: warehouseBranchDefaultId, name: 'Branch A Default WH', code: 'BRADEF', isActive: true, companyId,
    type: 'sales', branchId: branchAId,
  });
  warehouseBackendId = generateId();
  await db.insert(schema.warehouses).values({
    id: warehouseBackendId, name: 'Backend DC', code: 'BACKDC', isActive: true, companyId, type: 'backend',
  });
  await db.update(schema.branches).set({ defaultWarehouseId: warehouseBranchDefaultId }).where(eq(schema.branches.id, branchAId));

  for (const whId of [warehouseCompanyDefaultId, warehouseBranchDefaultId]) {
    await db.insert(schema.inventoryStocks).values({
      id: generateId(), productId: stockProductId, warehouseId: whId, batchNumber: null, quantity: '100.000', companyId,
    });
  }

  adminUserId = generateId();
  const adminUsername = `saleswh_admin_${adminUserId}`;
  await db.insert(schema.users).values({ id: adminUserId, username: adminUsername, password: passwordHash, role: 'admin', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  adminSessionId = await login(adminUsername);

  // A second, fully isolated company that starts with zero branches and zero
  // warehouses — the "nothing configured yet" boundary.
  noWarehouseCompanyId = generateId();
  await db.insert(schema.companies).values({
    id: noWarehouseCompanyId, name: 'No Warehouse Test Co', address: 'x', phone: '0',
    email: 'nowh@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
  });
  await db.insert(schema.fiscalMonths).values({ id: monthId, name: monthId, status: 'Open', companyId: noWarehouseCompanyId }).onConflictDoNothing();
  noWhTaxSlabId = generateId();
  await db.insert(schema.taxSlabs).values({ id: noWhTaxSlabId, name: 'Standard 15%', percentage: '15', companyId: noWarehouseCompanyId });
  noWhCustomerId = generateId();
  await db.insert(schema.customers).values({ id: noWhCustomerId, name: 'Test Customer', phone: '0', email: 'c2@example.com', address: 'x', companyId: noWarehouseCompanyId });
  noWhBankId = generateId();
  await db.insert(schema.bankAccounts).values({ id: noWhBankId, bankName: 'Test Bank', accountNumber: '0009992', accountTitle: 'No WH Test Co', openingBalance: '0', isActive: true, isDefault: true, companyId: noWarehouseCompanyId });
  noWhServiceProductId = generateId();
  await db.insert(schema.productsServices).values({ id: noWhServiceProductId, name: 'Consulting Hour', description: 'x', unitPrice: '50.00', itemKind: 'service', companyId: noWarehouseCompanyId });
  noWhStockProductId = generateId();
  await db.insert(schema.productsServices).values({ id: noWhStockProductId, name: 'Stock Widget', description: 'x', unitPrice: '10.00', itemKind: 'item', companyId: noWarehouseCompanyId });

  noWhAdminUserId = generateId();
  const noWhAdminUsername = `nowh_admin_${noWhAdminUserId}`;
  await db.insert(schema.users).values({ id: noWhAdminUserId, username: noWhAdminUsername, password: passwordHash, role: 'admin', companyId: noWarehouseCompanyId, isSuperAdmin: false, uiLanguage: 'en' });
  noWhAdminSessionId = await login(noWhAdminUsername);
});

afterAll(async () => {
  for (const cid of [companyId, noWarehouseCompanyId]) {
    // Invoices (and their items) first — a converted invoice's originQuotationId FK
    // blocks deleting its source quotation while the invoice still exists.
    const invoices = await db.select().from(schema.invoices).where(eq(schema.invoices.companyId, cid));
    for (const inv of invoices) {
      await db.delete(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, inv.id));
    }
    await db.delete(schema.invoices).where(eq(schema.invoices.companyId, cid));
    const quotations = await db.select().from(schema.quotations).where(eq(schema.quotations.companyId, cid));
    for (const q of quotations) {
      await db.delete(schema.quotationItems).where(eq(schema.quotationItems.quotationId, q.id));
    }
    await db.delete(schema.quotations).where(eq(schema.quotations.companyId, cid));
    await db.delete(schema.vouchers).where(eq(schema.vouchers.companyId, cid));
    await db.delete(schema.stockLedgerTransactions).where(eq(schema.stockLedgerTransactions.companyId, cid));
    await db.delete(schema.inventoryStocks).where(eq(schema.inventoryStocks.companyId, cid));
    await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, cid));
  }
  await db.update(schema.branches).set({ defaultWarehouseId: null }).where(eq(schema.branches.companyId, companyId));
  await db.delete(schema.warehouses).where(eq(schema.warehouses.companyId, companyId));
  await db.delete(schema.warehouses).where(eq(schema.warehouses.companyId, noWarehouseCompanyId));
  await db.delete(schema.branches).where(eq(schema.branches.companyId, companyId));
  await db.delete(schema.productsServices).where(eq(schema.productsServices.companyId, companyId));
  await db.delete(schema.productsServices).where(eq(schema.productsServices.companyId, noWarehouseCompanyId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, companyId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, noWarehouseCompanyId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, noWarehouseCompanyId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, noWarehouseCompanyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, noWarehouseCompanyId));
  await db.delete(schema.users).where(eq(schema.users.id, adminUserId));
  await db.delete(schema.users).where(eq(schema.users.id, noWhAdminUserId));
  await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyId));
  await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, noWarehouseCompanyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, noWarehouseCompanyId));
});

describe('Sale warehouse resolution (branch default -> company default)', () => {
  it('resolves to the company default warehouse when no branch is given', async () => {
    const today = new Date().toISOString().split('T')[0];
    const before = await stockQty(stockProductId, warehouseCompanyDefaultId);
    const res = await api(adminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: today, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0,
          items: [{ id: generateId(), description: 'Widget sale', unitCost: 10, quantity: 2, unit: 'PCE', productId: stockProductId }],
        },
      }),
    });
    expect(res.status).toBe(200);
    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, res.body.invoiceId));
    expect(invoice.warehouseId).toBe(warehouseCompanyDefaultId);
    expect(await stockQty(stockProductId, warehouseCompanyDefaultId)).toBe(before - 2);
  });

  it('resolves to the branch\'s own default warehouse when a branch is given, overriding the company default', async () => {
    const today = new Date().toISOString().split('T')[0];
    const before = await stockQty(stockProductId, warehouseBranchDefaultId);
    const res = await api(adminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: today, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0, branchId: branchAId,
          items: [{ id: generateId(), description: 'Widget sale at Branch A', unitCost: 10, quantity: 3, unit: 'PCE', productId: stockProductId }],
        },
      }),
    });
    expect(res.status).toBe(200);
    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, res.body.invoiceId));
    expect(invoice.warehouseId).toBe(warehouseBranchDefaultId);
    expect(await stockQty(stockProductId, warehouseBranchDefaultId)).toBe(before - 3);
  });

  it('honors an explicit warehouseId over the resolved default', async () => {
    const today = new Date().toISOString().split('T')[0];
    const before = await stockQty(stockProductId, warehouseCompanyDefaultId);
    const res = await api(adminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: today, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0,
          branchId: branchAId, warehouseId: warehouseCompanyDefaultId,
          items: [{ id: generateId(), description: 'Explicit warehouse override', unitCost: 10, quantity: 1, unit: 'PCE', productId: stockProductId }],
        },
      }),
    });
    expect(res.status).toBe(200);
    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, res.body.invoiceId));
    expect(invoice.warehouseId).toBe(warehouseCompanyDefaultId);
    expect(await stockQty(stockProductId, warehouseCompanyDefaultId)).toBe(before - 1);
  });

  it('resolves to the product\'s own default warehouse, taking priority over the branch/company default', async () => {
    const today = new Date().toISOString().split('T')[0];
    const productWithDefaultWhId = generateId();
    await db.insert(schema.productsServices).values({
      id: productWithDefaultWhId, name: 'Widget With Own Default WH', description: 'x', unitPrice: '10.00',
      itemKind: 'item', companyId, defaultWarehouseId: warehouseBranchDefaultId,
    });
    await db.insert(schema.inventoryStocks).values({
      id: generateId(), productId: productWithDefaultWhId, warehouseId: warehouseBranchDefaultId, batchNumber: null, quantity: '50.000', companyId,
    });
    const before = await stockQty(productWithDefaultWhId, warehouseBranchDefaultId);

    // No branchId given — the branch/company tier would resolve to warehouseCompanyDefaultId,
    // but the product's own defaultWarehouseId (warehouseBranchDefaultId) must win instead.
    const res = await api(adminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: today, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0,
          items: [{ id: generateId(), description: 'Product-default-warehouse sale', unitCost: 10, quantity: 4, unit: 'PCE', productId: productWithDefaultWhId }],
        },
      }),
    });
    expect(res.status).toBe(200);
    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, res.body.invoiceId));
    expect(invoice.warehouseId).toBe(warehouseBranchDefaultId);
    expect(await stockQty(productWithDefaultWhId, warehouseBranchDefaultId)).toBe(before - 4);

    await db.delete(schema.inventoryStocks).where(eq(schema.inventoryStocks.productId, productWithDefaultWhId));
    await db.delete(schema.stockLedgerTransactions).where(eq(schema.stockLedgerTransactions.productId, productWithDefaultWhId));
    await db.delete(schema.invoiceItems).where(eq(schema.invoiceItems.productId, productWithDefaultWhId));
    await db.delete(schema.invoices).where(eq(schema.invoices.id, res.body.invoiceId));
    await db.delete(schema.productsServices).where(eq(schema.productsServices.id, productWithDefaultWhId));
  });

  it('rejects an explicit warehouseId pointing at a backend-type warehouse', async () => {
    const today = new Date().toISOString().split('T')[0];
    const res = await api(adminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: today, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0,
          warehouseId: warehouseBackendId,
          items: [{ id: generateId(), description: 'Should be blocked', unitCost: 10, quantity: 1, unit: 'PCE', productId: stockProductId }],
        },
      }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/backend warehouse/i);
  });

  it('a Credit Note inherits its original invoice\'s warehouseId', async () => {
    const today = new Date().toISOString().split('T')[0];
    const inv = await api(adminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: today, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0,
          items: [{ id: generateId(), description: 'To be credited', unitCost: 10, quantity: 1, unit: 'PCE', productId: stockProductId }],
        },
      }),
    });
    expect(inv.status).toBe(200);
    const cn = await api(adminSessionId, `/api/transactions/invoices/${inv.body.invoiceId}/note`, {
      method: 'POST',
      body: JSON.stringify({ type: 'CreditNote', reason: 'Test' }),
    });
    expect(cn.status).toBe(200);
    const [original] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, inv.body.invoiceId));
    const [note] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, cn.body.noteId));
    expect(note.warehouseId).toBe(original.warehouseId);
  });

  it('rejects a Credit Note against an already-cancelled invoice, and does not double-restock', async () => {
    const today = new Date().toISOString().split('T')[0];
    const before = await stockQty(stockProductId, warehouseCompanyDefaultId);
    const inv = await api(adminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: today, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0,
          items: [{ id: generateId(), description: 'To be cancelled then credited', unitCost: 10, quantity: 2, unit: 'PCE', productId: stockProductId }],
        },
      }),
    });
    expect(inv.status).toBe(200);
    expect(await stockQty(stockProductId, warehouseCompanyDefaultId)).toBe(before - 2);

    const cancelRes = await api(adminSessionId, `/api/transactions/invoices/${inv.body.invoiceId}/cancel`, { method: 'POST' });
    expect(cancelRes.status).toBe(200);
    // Cancelling restocks the 2 units back — confirms the baseline this test's real
    // assertion (no double-restock) depends on.
    expect(await stockQty(stockProductId, warehouseCompanyDefaultId)).toBe(before);

    const cn = await api(adminSessionId, `/api/transactions/invoices/${inv.body.invoiceId}/note`, {
      method: 'POST',
      body: JSON.stringify({ type: 'CreditNote', reason: 'Should be rejected — invoice is cancelled' }),
    });
    expect(cn.status).toBe(400);
    expect(cn.body.error).toMatch(/cancelled invoice/i);

    // The rejected Credit Note must never have restocked a second time.
    expect(await stockQty(stockProductId, warehouseCompanyDefaultId)).toBe(before);
    const [noCreditNote] = await db.select().from(schema.invoices).where(and(
      eq(schema.invoices.originalInvoiceId, inv.body.invoiceId),
      eq(schema.invoices.documentType, 'CreditNote')
    ));
    expect(noCreditNote).toBeUndefined();
  });

  it('quotation-to-invoice conversion resolves a warehouse and deducts stock when customItems carries productId through', async () => {
    // Regression test for a real bug found live during manual QA: QuotationModule.tsx's
    // handleInitiateConversion mapped only description/unitCost/quantity/discountAmount
    // into the customItems payload it sends to this route, silently dropping productId
    // (and unit/unitOfMeasureId/taxSlabId). The server correctly resolves a warehouse and
    // deducts stock from customItems.productId when present — but with it missing, every
    // quotation-converted invoice for a real stock item quietly became an "untracked
    // manual line": warehouseId stayed null and inventory_stocks was never touched, with
    // no error anywhere. This test pins the payload shape the client must send (productId
    // included) and proves the server-side half of the fix already works correctly.
    const today = new Date().toISOString().split('T')[0];
    const before = await stockQty(stockProductId, warehouseCompanyDefaultId);
    const marker = `conv-test-marker-${generateId()}`;
    const quote = await api(adminSessionId, '/api/transactions/quotations', {
      method: 'POST',
      body: JSON.stringify({
        quotationData: {
          date: today, customerId, taxSlabId, bankId, notes: marker, status: 'Accepted', createdById: adminUserId,
          items: [{ id: generateId(), description: 'QA Stock Widget', unitCost: 10, quantity: 2, unit: 'PCE', productId: stockProductId, discountAmount: 0 }],
        },
      }),
    });
    expect(quote.status).toBe(200);
    // Neither this route nor /convert below echoes back the id it created — both just
    // reply { success: true } — so the row is found the same way the rest of this suite
    // already resolves ids it wasn't handed directly.
    const [createdQuotation] = await db.select().from(schema.quotations).where(and(
      eq(schema.quotations.companyId, companyId), eq(schema.quotations.notes, marker)
    ));
    expect(createdQuotation).toBeTruthy();

    const conv = await api(adminSessionId, `/api/transactions/quotations/${createdQuotation.id}/convert`, {
      method: 'POST',
      body: JSON.stringify({
        invoiceDate: today, bankId, paymentStatus: 'Unpaid', customCustomerId: customerId, customTaxSlabId: taxSlabId,
        customItems: [{ id: generateId(), description: 'QA Stock Widget', unitCost: 10, quantity: 2, unit: 'PCE', productId: stockProductId, discountAmount: 0 }],
      }),
    });
    expect(conv.status).toBe(200);

    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.originQuotationId, createdQuotation.id));
    expect(invoice).toBeTruthy();
    expect(invoice.warehouseId).toBe(warehouseCompanyDefaultId);
    expect(await stockQty(stockProductId, warehouseCompanyDefaultId)).toBe(before - 2);
  });

  it('quotation-to-invoice conversion posts a Receipt voucher for Fully Paid, and none for Partially Paid until an actual partial payment is recorded', async () => {
    // The user explicitly asked to verify voucher creation for both full and partial
    // payment specifically through the conversion path (not just direct invoice
    // creation, already covered elsewhere) — conversion has its own separate paymentStatus
    // handling (computePaymentStatus + amountPaidNum in the /convert route) that a
    // regression in the direct-invoice path wouldn't catch.
    async function makeAcceptedQuotation(qty: number) {
      const marker = `conv-voucher-marker-${generateId()}`;
      const created = await api(adminSessionId, '/api/transactions/quotations', {
        method: 'POST',
        body: JSON.stringify({
          quotationData: {
            date: new Date().toISOString().split('T')[0], customerId, taxSlabId, bankId, notes: marker, status: 'Accepted', createdById: adminUserId,
            items: [{ id: generateId(), description: 'QA Stock Widget', unitCost: 10, quantity: qty, unit: 'PCE', productId: stockProductId, discountAmount: 0 }],
          },
        }),
      });
      expect(created.status).toBe(200);
      const [q] = await db.select().from(schema.quotations).where(and(eq(schema.quotations.companyId, companyId), eq(schema.quotations.notes, marker)));
      return q;
    }

    // Fully Paid → a Receipt voucher for the full grand total.
    const fullQ = await makeAcceptedQuotation(1);
    const fullConv = await api(adminSessionId, `/api/transactions/quotations/${fullQ.id}/convert`, {
      method: 'POST',
      body: JSON.stringify({
        invoiceDate: new Date().toISOString().split('T')[0], bankId, paymentStatus: 'Paid', customCustomerId: customerId, customTaxSlabId: taxSlabId,
        customItems: [{ id: generateId(), description: 'QA Stock Widget', unitCost: 10, quantity: 1, unit: 'PCE', productId: stockProductId, discountAmount: 0 }],
      }),
    });
    expect(fullConv.status).toBe(200);
    const [fullInvoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.originQuotationId, fullQ.id));
    expect(fullInvoice.paymentStatus).toBe('Paid');
    const fullVouchers = await db.select().from(schema.vouchers).where(and(eq(schema.vouchers.referenceType, 'Invoice'), eq(schema.vouchers.referenceId, fullInvoice.id)));
    expect(fullVouchers.length).toBe(1);
    expect(fullVouchers[0].type).toBe('Receipt');
    expect(Number(fullVouchers[0].amount)).toBeCloseTo(11.5, 2); // 1 unit @ 10 + 15% VAT

    // Partially Paid at conversion time (paymentStatus:'Unpaid' with amountPaid computed
    // as 0, per this route's own amountPaidNum logic — conversion has no separate partial-
    // amount input field) — no voucher yet, since nothing has actually been paid.
    const partQ = await makeAcceptedQuotation(2);
    const partConv = await api(adminSessionId, `/api/transactions/quotations/${partQ.id}/convert`, {
      method: 'POST',
      body: JSON.stringify({
        invoiceDate: new Date().toISOString().split('T')[0], bankId, paymentStatus: 'Unpaid', customCustomerId: customerId, customTaxSlabId: taxSlabId,
        customItems: [{ id: generateId(), description: 'QA Stock Widget', unitCost: 10, quantity: 2, unit: 'PCE', productId: stockProductId, discountAmount: 0 }],
      }),
    });
    expect(partConv.status).toBe(200);
    const [unpaidInvoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.originQuotationId, partQ.id));
    expect(unpaidInvoice.paymentStatus).toBe('Unpaid');
    const noVouchersYet = await db.select().from(schema.vouchers).where(and(eq(schema.vouchers.referenceType, 'Invoice'), eq(schema.vouchers.referenceId, unpaidInvoice.id)));
    expect(noVouchersYet.length).toBe(0);

    // Now record an actual partial payment against it via the same route direct invoices
    // use — this is where a real Receipt voucher for a Partially Paid document gets posted.
    const partialAmount = 10; // less than the 23 SAR grand total (2 @ 10 + 15% VAT)
    const payRes = await api(adminSessionId, `/api/transactions/invoices/${unpaidInvoice.id}/paid`, {
      method: 'POST',
      body: JSON.stringify({ amount: partialAmount, bankId }),
    });
    expect(payRes.status).toBe(200);
    const [partiallyPaidInvoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, unpaidInvoice.id));
    expect(partiallyPaidInvoice.paymentStatus).toBe('Partially Paid');
    const partialVouchers = await db.select().from(schema.vouchers).where(and(eq(schema.vouchers.referenceType, 'Invoice'), eq(schema.vouchers.referenceId, unpaidInvoice.id)));
    expect(partialVouchers.length).toBe(1);
    expect(partialVouchers[0].type).toBe('Receipt');
    expect(Number(partialVouchers[0].amount)).toBeCloseTo(partialAmount, 2);
  });
});

describe('No warehouses configured yet (services vs. stock items)', () => {
  it('allows a services-only invoice with no warehouse configured at all', async () => {
    const today = new Date().toISOString().split('T')[0];
    const res = await api(noWhAdminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: today, customerId: noWhCustomerId, taxSlabId: noWhTaxSlabId, bankId: noWhBankId, notes: '', status: 'Active', amountPaid: 0,
          items: [{ id: generateId(), description: 'Consulting', unitCost: 50, quantity: 1, unit: 'HUR', productId: noWhServiceProductId }],
        },
      }),
    });
    expect(res.status).toBe(200);
    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, res.body.invoiceId));
    expect(invoice.warehouseId).toBeNull();
  });

  it('rejects a stock-item invoice when no sales warehouse can be resolved', async () => {
    const today = new Date().toISOString().split('T')[0];
    const res = await api(noWhAdminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: today, customerId: noWhCustomerId, taxSlabId: noWhTaxSlabId, bankId: noWhBankId, notes: '', status: 'Active', amountPaid: 0,
          items: [{ id: generateId(), description: 'Widget', unitCost: 10, quantity: 1, unit: 'PCE', productId: noWhStockProductId }],
        },
      }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sales warehouse/i);
  });

  it('a company\'s very first warehouse auto-becomes its company default', async () => {
    const id = generateId();
    const res = await api(noWhAdminSessionId, '/api/warehouses', {
      method: 'POST',
      body: JSON.stringify({ id, name: 'First Warehouse', code: 'FIRST', isActive: true, companyId: noWarehouseCompanyId }),
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.warehouses).where(eq(schema.warehouses.id, id));
    expect(row.isCompanyDefault).toBe(true);
    expect(row.type).toBe('sales');
  });
});

describe('Mandatory branch for a new warehouse once the company has one', () => {
  it('rejects a new warehouse with no branchId once the company has an active branch', async () => {
    const id = generateId();
    const res = await api(adminSessionId, '/api/warehouses', {
      method: 'POST',
      body: JSON.stringify({ id, name: 'No Branch WH', code: 'NOBR', isActive: true, companyId }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/branch/i);
    const rows = await db.select().from(schema.warehouses).where(eq(schema.warehouses.id, id));
    expect(rows.length).toBe(0);
  });

  it('accepts a new warehouse once a branchId is supplied', async () => {
    const id = generateId();
    const res = await api(adminSessionId, '/api/warehouses', {
      method: 'POST',
      body: JSON.stringify({ id, name: 'Branch B WH', code: 'BRBWH', isActive: true, companyId, branchId: branchAId }),
    });
    expect(res.status).toBe(200);
    await db.delete(schema.warehouses).where(eq(schema.warehouses.id, id));
  });
});

describe('A "sales" default can never be a backend warehouse', () => {
  it('rejects isCompanyDefault:true on a backend-type warehouse', async () => {
    const res = await api(adminSessionId, '/api/warehouses', {
      method: 'POST',
      body: JSON.stringify({ id: warehouseBackendId, name: 'Backend DC', code: 'BACKDC', isActive: true, companyId, branchId: branchAId, type: 'backend', isCompanyDefault: true }),
    });
    expect(res.status).toBe(400);
    const [row] = await db.select().from(schema.warehouses).where(eq(schema.warehouses.id, warehouseBackendId));
    expect(row.isCompanyDefault).toBe(false);
  });

  it('rejects a branch\'s defaultWarehouseId pointing at a backend-type warehouse', async () => {
    const res = await api(adminSessionId, '/api/branches', {
      method: 'POST',
      body: JSON.stringify({ id: branchAId, name: 'Branch A', code: 'BRA', defaultWarehouseId: warehouseBackendId }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/backend warehouse/i);
  });
});

describe('Opt-in stock availability enforcement (inventorySettings.enforceStockAvailability)', () => {
  it('allows overselling by default (clamped at 0, not rejected)', async () => {
    const today = new Date().toISOString().split('T')[0];
    const res = await api(adminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: today, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0,
          warehouseId: warehouseCompanyDefaultId,
          items: [{ id: generateId(), description: 'Oversell allowed by default', unitCost: 10, quantity: 999999, unit: 'PCE', productId: stockProductId }],
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(await stockQty(stockProductId, warehouseCompanyDefaultId)).toBe(0);
  });

  it('rejects an oversell once enforceStockAvailability is turned on', async () => {
    await db.update(schema.companies).set({ inventorySettings: { prOptionality: 'OPTIONAL', isDsdAllowed: true, enforceStockAvailability: true } })
      .where(eq(schema.companies.id, companyId));

    const before = await stockQty(stockProductId, warehouseBranchDefaultId);
    const today = new Date().toISOString().split('T')[0];
    const res = await api(adminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: today, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0,
          warehouseId: warehouseBranchDefaultId,
          items: [{ id: generateId(), description: 'Oversell blocked', unitCost: 10, quantity: before + 5, unit: 'PCE', productId: stockProductId }],
        },
      }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/insufficient stock/i);
    expect(await stockQty(stockProductId, warehouseBranchDefaultId)).toBe(before); // unchanged — rejected before any deduction

    await db.update(schema.companies).set({ inventorySettings: { prOptionality: 'OPTIONAL', isDsdAllowed: true, enforceStockAvailability: false } })
      .where(eq(schema.companies.id, companyId));
  });
});

describe('POST /api/branches/backfill-unassigned', () => {
  let backfillCompanyId: string;
  let backfillAdminUserId: string;
  let backfillAdminSessionId: string;
  let backfillBranchId: string;
  let otherBranchId: string;
  let unassignedQuotationId: string;
  let unassignedWarehouseId: string;

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
    backfillCompanyId = generateId();
    await db.insert(schema.companies).values({
      id: backfillCompanyId, name: 'Backfill Test Co', address: 'x', phone: '0',
      email: 'backfill@example.com', logoUrl: '', customHeader: '', customFooter: '',
      currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
    });
    backfillAdminUserId = generateId();
    const backfillAdminUsername = `backfill_admin_${backfillAdminUserId}`;
    await db.insert(schema.users).values({ id: backfillAdminUserId, username: backfillAdminUsername, password: passwordHash, role: 'admin', companyId: backfillCompanyId, isSuperAdmin: false, uiLanguage: 'en' });
    backfillAdminSessionId = await login(backfillAdminUsername);

    backfillBranchId = generateId();
    await db.insert(schema.branches).values({ id: backfillBranchId, companyId: backfillCompanyId, name: 'Backfill Branch', code: 'BKF', isActive: true, isDefault: true });
    otherBranchId = generateId();
    await db.insert(schema.branches).values({ id: otherBranchId, companyId: backfillCompanyId, name: 'Other Branch', code: 'OTH', isActive: true });

    // One already-assigned quotation (must stay untouched) and one unassigned one.
    const customer2Id = generateId();
    await db.insert(schema.customers).values({ id: customer2Id, name: 'Backfill Customer', phone: '0', email: 'bc@example.com', address: 'x', companyId: backfillCompanyId });
    const backfillTaxSlabId = generateId();
    await db.insert(schema.taxSlabs).values({ id: backfillTaxSlabId, name: 'Standard 15%', percentage: '15', companyId: backfillCompanyId });
    const alreadyAssignedQuotationId = generateId();
    await db.insert(schema.quotations).values({
      id: alreadyAssignedQuotationId, quotationNumber: 'Q-BKF-1', date: '2026-01-01', customerId: customer2Id,
      taxSlabId: backfillTaxSlabId, notes: '', status: 'Draft', createdById: backfillAdminUserId, createdAt: new Date(),
      companyId: backfillCompanyId, branchId: otherBranchId,
    });
    unassignedQuotationId = generateId();
    await db.insert(schema.quotations).values({
      id: unassignedQuotationId, quotationNumber: 'Q-BKF-2', date: '2026-01-01', customerId: customer2Id,
      taxSlabId: backfillTaxSlabId, notes: '', status: 'Draft', createdById: backfillAdminUserId, createdAt: new Date(),
      companyId: backfillCompanyId, branchId: null,
    });

    unassignedWarehouseId = generateId();
    await db.insert(schema.warehouses).values({ id: unassignedWarehouseId, name: 'Unassigned WH', code: 'UNWH', isActive: true, companyId: backfillCompanyId, branchId: null });
  });

  afterAll(async () => {
    await db.delete(schema.quotations).where(eq(schema.quotations.companyId, backfillCompanyId));
    await db.delete(schema.warehouses).where(eq(schema.warehouses.companyId, backfillCompanyId));
    await db.delete(schema.branches).where(eq(schema.branches.companyId, backfillCompanyId));
    await db.delete(schema.customers).where(eq(schema.customers.companyId, backfillCompanyId));
    await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, backfillCompanyId));
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, backfillCompanyId));
    await db.delete(schema.users).where(eq(schema.users.id, backfillAdminUserId));
    await db.delete(schema.companies).where(eq(schema.companies.id, backfillCompanyId));
  });

  it('attributes only currently-unassigned rows to the chosen branch, leaving already-assigned rows untouched', async () => {
    const res = await api(backfillAdminSessionId, '/api/branches/backfill-unassigned', {
      method: 'POST',
      body: JSON.stringify({ branchId: backfillBranchId }),
    });
    expect(res.status).toBe(200);
    expect(res.body.counts.quotations).toBe(1);
    expect(res.body.counts.warehouses).toBe(1);

    const [backfilled] = await db.select().from(schema.quotations).where(eq(schema.quotations.id, unassignedQuotationId));
    expect(backfilled.branchId).toBe(backfillBranchId);
    const [warehouse] = await db.select().from(schema.warehouses).where(eq(schema.warehouses.id, unassignedWarehouseId));
    expect(warehouse.branchId).toBe(backfillBranchId);

    // The row that already had a branch is untouched, not overwritten.
    const [untouched] = await db.select({ branchId: schema.quotations.branchId }).from(schema.quotations).where(eq(schema.quotations.branchId, otherBranchId));
    expect(untouched.branchId).toBe(otherBranchId);
  });

  it('is idempotent — a second run finds nothing left to backfill', async () => {
    const res = await api(backfillAdminSessionId, '/api/branches/backfill-unassigned', {
      method: 'POST',
      body: JSON.stringify({ branchId: backfillBranchId }),
    });
    expect(res.status).toBe(200);
    expect(Object.values(res.body.counts).every((n: any) => n === 0)).toBe(true);
  });

  it('rejects a branchId belonging to another company', async () => {
    const res = await api(backfillAdminSessionId, '/api/branches/backfill-unassigned', {
      method: 'POST',
      body: JSON.stringify({ branchId: branchAId }), // belongs to the outer `companyId` fixture
    });
    expect(res.status).toBe(404);
  });
});

describe('Invoice line-item and net-total validation', () => {
  it('rejects an invoice with no line items', async () => {
    const today = new Date().toISOString().split('T')[0];
    const res = await api(adminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: { date: today, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0, items: [] },
      }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one line item/i);
  });

  it('rejects a line item with a zero sales price', async () => {
    const today = new Date().toISOString().split('T')[0];
    const res = await api(adminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: today, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0,
          items: [{ id: generateId(), description: 'Free item', unitCost: 0, quantity: 1, unit: 'PCE' }],
        },
      }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sales price must be greater than 0/i);
  });

  it('rejects a line item whose discount wipes out the sales price', async () => {
    const today = new Date().toISOString().split('T')[0];
    const res = await api(adminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: today, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0,
          items: [{ id: generateId(), description: 'Over-discounted item', unitCost: 10, discountAmount: 10, quantity: 1, unit: 'PCE' }],
        },
      }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/discount cannot reduce the sales price/i);
  });

  it('accepts a decimal discount amount that leaves a positive net price', async () => {
    const today = new Date().toISOString().split('T')[0];
    const res = await api(adminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: today, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0,
          items: [{ id: generateId(), description: 'Decimal discount item', unitCost: 10, discountAmount: 2.55, quantity: 1, unit: 'PCE' }],
        },
      }),
    });
    expect(res.status).toBe(200);
    const [item] = await db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, res.body.invoiceId));
    expect(Number(item.discountAmount)).toBe(2.55);
  });

  it('rejects an invoice whose net total is zero even when every line item is individually valid', async () => {
    const today = new Date().toISOString().split('T')[0];
    // Each line passes the per-line checks (a real positive sales price, no line-level
    // discount) but a 100% header-level discount still drives the invoice's actual net
    // total to zero — this must be caught too, not just the per-line cases.
    const res = await api(adminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: today, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0, discountPercentage: 100,
          items: [{ id: generateId(), description: 'Fully header-discounted item', unitCost: 10, quantity: 1, unit: 'PCE' }],
        },
      }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/net total must be greater than 0/i);
  });
});
