import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server + real Postgres state,
// matching this project's established no-mocks testing practice. Covers BACKLOG.md's
// average-sale-price feature: a quantity-weighted rolling average folded into
// productsServices.averageSalePrice whenever an invoice line is linked back to the
// catalog via productId (ItemCatalogSearch) — a free-typed line without productId never
// contributes. Credit/Debit Notes deliberately do NOT unwind the average (forward-only,
// same philosophy as GRN reversal not unwinding averageCost).
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let monthId: string;
let taxSlabId: string;
let customerId: string;
let bankId: string;
let productId: string;
let warehouseId: string;
let adminSessionId: string;
let adminUserId: string;
const createdInvoiceIds: string[] = [];

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

async function createInvoice(unitCost: number, quantity: number, withProductId: boolean) {
  const { status, body } = await api(adminSessionId, '/api/transactions/invoices', {
    method: 'POST',
    body: JSON.stringify({
      invoiceData: {
        date: new Date().toISOString().split('T')[0],
        customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0,
        items: [{ id: generateId(), description: 'Test Widget', unitCost, quantity, discountAmount: 0, ...(withProductId ? { productId } : {}) }],
      },
    }),
  });
  if (status !== 200) throw new Error(`createInvoice failed: ${status} ${JSON.stringify(body)}`);
  createdInvoiceIds.push(body.invoiceId);
  return body.invoiceId as string;
}

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: 'AvgSalePrice Test Co', address: 'x', phone: '0',
    email: 'avgsaleprice@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
  });

  monthId = new Date().toISOString().slice(0, 7);
  await db.insert(schema.fiscalMonths).values({ id: monthId, name: monthId, status: 'Open', companyId }).onConflictDoNothing();

  taxSlabId = generateId();
  await db.insert(schema.taxSlabs).values({ id: taxSlabId, name: 'Standard 15%', percentage: '15', companyId });

  customerId = generateId();
  await db.insert(schema.customers).values({
    id: customerId, name: 'AvgSalePrice Test Customer', phone: '0', email: 'c@example.com', address: 'x', companyId, buyerType: 'B2B',
  });

  bankId = generateId();
  await db.insert(schema.bankAccounts).values({
    id: bankId, bankName: 'Test Bank', accountNumber: '000111', accountTitle: 'AvgSalePrice Test Co', openingBalance: '0', companyId,
  });

  productId = generateId();
  await db.insert(schema.productsServices).values({
    id: productId, name: 'Test Widget', description: 'x', unitPrice: '10.00', itemKind: 'item', companyId,
  });

  // A catalog-linked ('item' type) line now requires a resolvable sales warehouse
  // (server/lib/businessLogic.ts's resolveSaleWarehouse) — a company default is enough
  // since this file never exercises branch-specific routing, only the averageSalePrice
  // fold-in itself.
  warehouseId = generateId();
  await db.insert(schema.warehouses).values({
    id: warehouseId, name: 'Main Store', code: 'MAIN', isActive: true, companyId, type: 'sales', isCompanyDefault: true,
  });

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  adminUserId = generateId();
  const adminUsername = `avgsale_admin_${adminUserId}`;
  await db.insert(schema.users).values({
    id: adminUserId, username: adminUsername, password: passwordHash, role: 'admin', companyId, isSuperAdmin: false, uiLanguage: 'en',
  });
  adminSessionId = await login(adminUsername);
});

afterAll(async () => {
  // Belt-and-suspenders: delete every invoice_items row touching either this company's
  // invoices or this test's product directly (a Credit Note's copied line items carry the
  // same productId as the original, so a plain invoiceId-only sweep can miss rows if the
  // two queries race against fixture creation happening concurrently in other test files).
  await db.delete(schema.invoiceItems).where(eq(schema.invoiceItems.productId, productId));
  const invoices = await db.select({ id: schema.invoices.id }).from(schema.invoices).where(eq(schema.invoices.companyId, companyId));
  for (const inv of invoices) {
    await db.delete(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, inv.id));
  }
  await db.delete(schema.invoices).where(eq(schema.invoices.companyId, companyId));
  await db.delete(schema.stockLedgerTransactions).where(eq(schema.stockLedgerTransactions.companyId, companyId));
  await db.delete(schema.inventoryStocks).where(eq(schema.inventoryStocks.companyId, companyId));
  await db.delete(schema.warehouses).where(eq(schema.warehouses.companyId, companyId));
  await db.delete(schema.productsServices).where(eq(schema.productsServices.companyId, companyId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, companyId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyId));
  await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
  await db.delete(schema.users).where(eq(schema.users.id, adminUserId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
});

describe('productsServices.averageSalePrice (weighted rolling average from real sales)', () => {
  it('a catalog-linked invoice line folds into the average', async () => {
    await createInvoice(100, 2, true); // 2 units @ 100
    let [product] = await db.select().from(schema.productsServices).where(eq(schema.productsServices.id, productId));
    expect(Number(product.averageSalePrice)).toBe(100);
    expect(Number(product.totalQuantitySold)).toBe(2);

    await createInvoice(150, 2, true); // 2 units @ 150
    [product] = await db.select().from(schema.productsServices).where(eq(schema.productsServices.id, productId));
    expect(Number(product.averageSalePrice)).toBe(125); // (2*100 + 2*150) / 4
    expect(Number(product.totalQuantitySold)).toBe(4);
  });

  it('a free-typed line with no productId never contributes', async () => {
    const [before] = await db.select().from(schema.productsServices).where(eq(schema.productsServices.id, productId));
    await createInvoice(9999, 5, false);
    const [after] = await db.select().from(schema.productsServices).where(eq(schema.productsServices.id, productId));
    expect(after.averageSalePrice).toBe(before.averageSalePrice);
    expect(after.totalQuantitySold).toBe(before.totalQuantitySold);
  });

  it('a Credit Note does not unwind the average', async () => {
    const invId = await createInvoice(200, 1, true);
    const [before] = await db.select().from(schema.productsServices).where(eq(schema.productsServices.id, productId));

    const { status, body } = await api(adminSessionId, `/api/transactions/invoices/${invId}/note`, {
      method: 'POST',
      body: JSON.stringify({ type: 'CreditNote', reason: 'Test reversal' }),
    });
    expect(status).toBe(200);
    createdInvoiceIds.push(body.invoiceId);

    const [after] = await db.select().from(schema.productsServices).where(eq(schema.productsServices.id, productId));
    expect(after.averageSalePrice).toBe(before.averageSalePrice);
    expect(after.totalQuantitySold).toBe(before.totalQuantitySold);
  });
});
