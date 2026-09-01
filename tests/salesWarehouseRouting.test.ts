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
  await db.insert(schema.productsServices).values({ id: stockProductId, name: 'Stock Widget', description: 'x', unitPrice: '10.00', type: 'item', companyId });
  serviceProductId = generateId();
  await db.insert(schema.productsServices).values({ id: serviceProductId, name: 'Consulting Hour', description: 'x', unitPrice: '50.00', type: 'service', companyId });

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
  const adminUsername = `saleswh_admin_${adminUserId.slice(0, 8)}`;
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
  await db.insert(schema.productsServices).values({ id: noWhServiceProductId, name: 'Consulting Hour', description: 'x', unitPrice: '50.00', type: 'service', companyId: noWarehouseCompanyId });
  noWhStockProductId = generateId();
  await db.insert(schema.productsServices).values({ id: noWhStockProductId, name: 'Stock Widget', description: 'x', unitPrice: '10.00', type: 'item', companyId: noWarehouseCompanyId });

  noWhAdminUserId = generateId();
  const noWhAdminUsername = `nowh_admin_${noWhAdminUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({ id: noWhAdminUserId, username: noWhAdminUsername, password: passwordHash, role: 'admin', companyId: noWarehouseCompanyId, isSuperAdmin: false, uiLanguage: 'en' });
  noWhAdminSessionId = await login(noWhAdminUsername);
});

afterAll(async () => {
  for (const cid of [companyId, noWarehouseCompanyId]) {
    const invoices = await db.select().from(schema.invoices).where(eq(schema.invoices.companyId, cid));
    for (const inv of invoices) {
      await db.delete(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, inv.id));
    }
    await db.delete(schema.invoices).where(eq(schema.invoices.companyId, cid));
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
    const backfillAdminUsername = `backfill_admin_${backfillAdminUserId.slice(0, 8)}`;
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
