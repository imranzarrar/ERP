import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Regression test for the cross-company data hijack vulnerability found this session:
// POST /customers, /vendors, /products, /product-categories, /units-of-measure,
// /warehouses, /quotations, /invoices, and POST /api/expenses all called
// .onConflictDoUpdate keyed on a client-supplied `id` with no ownership check — a
// Company A user who knew/guessed a Company B record's real UUID could overwrite that
// row and re-parent it to Company A. Fixed by adding assertOwnsRow() (server/lib/authz.ts)
// before each upsert. This test proves the fix blocks the attack AND that legitimate
// same-company updates still work — both directions matter, not just the block.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyAId: string;
let companyBId: string;
let userAId: string;
let sessionId: string; // company A's non-super-admin session — the "attacker"

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
    id,
    name,
    address: 'Test Address',
    phone: '0000000000',
    email: `${id.slice(0, 8)}@example.com`,
    logoUrl: '',
    customHeader: '',
    customFooter: '',
    currency: 'SAR',
    counters: {},
    zatcaEnabled: false,
  });
  return id;
}

beforeAll(async () => {
  companyAId = await makeCompany('Cross-Isolation Test Co A');
  companyBId = await makeCompany('Cross-Isolation Test Co B');

  const monthId = new Date().toISOString().slice(0, 7);
  for (const cid of [companyAId, companyBId]) {
    await db.insert(schema.fiscalMonths).values({ id: monthId, name: monthId, status: 'Open', companyId: cid }).onConflictDoNothing();
  }

  // Company A's user is a regular company admin — NOT a super-admin. Super-admins are
  // deliberately allowed to cross company boundaries (assertOwnsRow's own design); this
  // test is about the non-super-admin case, which is where the real vulnerability was.
  userAId = generateId();
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  const username = `attacker_${userAId.slice(0, 8)}`;
  await db.insert(schema.users).values({
    id: userAId,
    username,
    password: passwordHash,
    role: 'admin',
    companyId: companyAId,
    isSuperAdmin: false,
  });

  const loginRes = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });
  const loginBody = await loginRes.json().catch(() => null);
  if (!loginBody?.sessionId) {
    throw new Error(`Test setup failed: login did not return a sessionId (status ${loginRes.status}, body ${JSON.stringify(loginBody)})`);
  }
  sessionId = loginBody.sessionId;
});

afterAll(async () => {
  // No invoiceItems rows exist for these fixtures (every invoice created here used an
  // empty items array), so no invoiceItems cleanup step is needed before deleting invoices.
  await db.delete(schema.invoices).where(eq(schema.invoices.companyId, companyAId));
  await db.delete(schema.invoices).where(eq(schema.invoices.companyId, companyBId));
  await db.delete(schema.quotations).where(eq(schema.quotations.companyId, companyAId));
  await db.delete(schema.quotations).where(eq(schema.quotations.companyId, companyBId));
  await db.delete(schema.expenses).where(eq(schema.expenses.companyId, companyAId));
  await db.delete(schema.expenses).where(eq(schema.expenses.companyId, companyBId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, companyAId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, companyBId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyAId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyBId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyAId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyBId));
  await db.delete(schema.vendors).where(eq(schema.vendors.companyId, companyAId));
  await db.delete(schema.vendors).where(eq(schema.vendors.companyId, companyBId));
  await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyAId));
  await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyBId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyAId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyBId));
  await db.delete(schema.users).where(eq(schema.users.companyId, companyAId));
  await db.delete(schema.users).where(eq(schema.users.companyId, companyBId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyAId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyBId));
});

describe('Cross-company hijack — customers (masterEntities.ts)', () => {
  it('blocks Company A from overwriting Company B\'s customer by id', async () => {
    const bCustomerId = generateId();
    await db.insert(schema.customers).values({
      id: bCustomerId, name: 'Company B Customer', phone: '111', email: 'b@example.com',
      address: 'B Address', companyId: companyBId, buyerType: 'B2C',
    });

    const { status, body } = await api('/api/customers', {
      method: 'POST',
      body: JSON.stringify({ id: bCustomerId, name: 'HIJACKED', phone: '999', email: 'hijack@example.com', address: 'A', buyerType: 'B2C' }),
    });
    expect(status).toBe(403);
    expect(body.error).toMatch(/another company/i);

    const [row] = await db.select().from(schema.customers).where(eq(schema.customers.id, bCustomerId));
    expect(row.companyId).toBe(companyBId);
    expect(row.name).toBe('Company B Customer');
  });

  it('still allows Company A to update its own customer', async () => {
    const aCustomerId = generateId();
    await db.insert(schema.customers).values({
      id: aCustomerId, name: 'Original Name', phone: '111', email: 'a@example.com',
      address: 'A Address', companyId: companyAId, buyerType: 'B2C',
    });

    const { status } = await api('/api/customers', {
      method: 'POST',
      body: JSON.stringify({ id: aCustomerId, name: 'Updated Name', phone: '222', email: 'a@example.com', address: 'A Address', buyerType: 'B2C' }),
    });
    expect(status).toBe(200);

    const [row] = await db.select().from(schema.customers).where(eq(schema.customers.id, aCustomerId));
    expect(row.name).toBe('Updated Name');
    expect(row.companyId).toBe(companyAId);
  });
});

describe('Cross-company hijack — invoices (transactions.ts)', () => {
  it('blocks Company A from overwriting Company B\'s invoice by id', async () => {
    const bCustomerId = generateId();
    await db.insert(schema.customers).values({
      id: bCustomerId, name: 'B Cust', phone: '1', email: 'b2@example.com', address: 'B', companyId: companyBId, buyerType: 'B2C',
    });
    const bTaxSlabId = generateId();
    await db.insert(schema.taxSlabs).values({ id: bTaxSlabId, name: 'B Slab', percentage: '15', companyId: companyBId });
    const bBankId = generateId();
    await db.insert(schema.bankAccounts).values({ id: bBankId, bankName: 'B Bank', accountNumber: '1', accountTitle: 'B', openingBalance: '0', companyId: companyBId });
    const bUserId = generateId();
    await db.insert(schema.users).values({ id: bUserId, username: `bowner_${bUserId.slice(0, 8)}`, password: 'x', role: 'admin', companyId: companyBId, isSuperAdmin: false });

    const bInvoiceId = generateId();
    await db.insert(schema.invoices).values({
      id: bInvoiceId, invoiceNumber: 'INV-B-1', date: new Date().toISOString().split('T')[0],
      customerId: bCustomerId, taxSlabId: bTaxSlabId, bankId: bBankId, paymentStatus: 'Unpaid',
      notes: '', status: 'Active', createdById: bUserId, createdAt: new Date(), amountPaid: '0', companyId: companyBId,
    });

    const { status, body } = await api('/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({ invoiceData: { id: bInvoiceId, date: new Date().toISOString().split('T')[0], customerId: bCustomerId, taxSlabId: bTaxSlabId, bankId: bBankId, notes: 'hijacked', status: 'Active', amountPaid: 0, items: [] } }),
    });
    expect(status).toBe(403);
    expect(body.error).toMatch(/another company/i);

    const [row] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, bInvoiceId));
    expect(row.companyId).toBe(companyBId);
    expect(row.notes).not.toBe('hijacked');
  });
});

describe('Cross-company hijack — quotations (transactions.ts)', () => {
  it('blocks Company A from overwriting Company B\'s quotation by id', async () => {
    const bCustomerId = generateId();
    await db.insert(schema.customers).values({
      id: bCustomerId, name: 'B Cust Q', phone: '1', email: 'b3@example.com', address: 'B', companyId: companyBId, buyerType: 'B2C',
    });
    const bTaxSlabId = generateId();
    await db.insert(schema.taxSlabs).values({ id: bTaxSlabId, name: 'B Slab Q', percentage: '15', companyId: companyBId });
    const bUserId = generateId();
    await db.insert(schema.users).values({ id: bUserId, username: `bowner2_${bUserId.slice(0, 8)}`, password: 'x', role: 'admin', companyId: companyBId, isSuperAdmin: false });

    const bQuotationId = generateId();
    await db.insert(schema.quotations).values({
      id: bQuotationId, quotationNumber: 'QT-B-1', date: new Date().toISOString().split('T')[0],
      customerId: bCustomerId, taxSlabId: bTaxSlabId, notes: 'original', status: 'Active',
      createdById: bUserId, createdAt: new Date(), companyId: companyBId,
    });

    const { status, body } = await api('/api/transactions/quotations', {
      method: 'POST',
      body: JSON.stringify({ quotationData: { id: bQuotationId, date: new Date().toISOString().split('T')[0], customerId: bCustomerId, taxSlabId: bTaxSlabId, notes: 'hijacked', status: 'Active', items: [] } }),
    });
    expect(status).toBe(403);
    expect(body.error).toMatch(/another company/i);

    const [row] = await db.select().from(schema.quotations).where(eq(schema.quotations.id, bQuotationId));
    expect(row.companyId).toBe(companyBId);
    expect(row.notes).toBe('original');
  });
});

describe('Cross-company hijack — expenses (expenses.ts)', () => {
  it('blocks Company A from overwriting Company B\'s expense by id', async () => {
    const bVendorId = generateId();
    await db.insert(schema.vendors).values({
      id: bVendorId, name: 'B Vendor', phone: '1', email: 'bv@example.com', address: 'B', companyId: companyBId, buyerType: 'B2C',
    });
    const bTaxSlabId = generateId();
    await db.insert(schema.taxSlabs).values({ id: bTaxSlabId, name: 'B Slab E', percentage: '15', companyId: companyBId });
    const bBankId = generateId();
    await db.insert(schema.bankAccounts).values({ id: bBankId, bankName: 'B Bank E', accountNumber: '2', accountTitle: 'B', openingBalance: '0', companyId: companyBId });
    const bUserId = generateId();
    await db.insert(schema.users).values({ id: bUserId, username: `bowner3_${bUserId.slice(0, 8)}`, password: 'x', role: 'admin', companyId: companyBId, isSuperAdmin: false });

    const bExpenseId = generateId();
    await db.insert(schema.expenses).values({
      id: bExpenseId, expenseNumber: 'EXP-B-1', date: new Date().toISOString().split('T')[0],
      vendorId: bVendorId, taxSlabId: bTaxSlabId, bankId: bBankId, paymentStatus: 'Unpaid',
      description: 'original', amount: '100', status: 'Active', type: 'Actual',
      createdById: bUserId, createdAt: new Date(), companyId: companyBId,
    });

    const { status, body } = await api('/api/expenses', {
      method: 'POST',
      body: JSON.stringify({ id: bExpenseId, date: new Date().toISOString().split('T')[0], vendorId: bVendorId, taxSlabId: bTaxSlabId, bankId: bBankId, description: 'hijacked', amount: 999, status: 'Active', type: 'Actual' }),
    });
    expect(status).toBe(403);
    expect(body.error).toMatch(/another company/i);

    const [row] = await db.select().from(schema.expenses).where(eq(schema.expenses.id, bExpenseId));
    expect(row.companyId).toBe(companyBId);
    expect(row.description).toBe('original');
  });
});
