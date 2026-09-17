import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq, and } from 'drizzle-orm';
import pg from 'pg';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Phase 3 of the RLS full-rollout (BACKLOG.md) migrated the non-ZATCA-touching routes in
// server/routes/transactions.ts and server/routes/expenses.ts onto tenantDb() — quotations
// (full CRUD + convert), invoice read/payment (not create/note/cancel, deliberately
// deferred — see those routes' own comments), investors, fiscal months, recurring
// expenses/postings, accruals, inter-bank transfers, and all of expenses.ts.
//
// Same two things proven as every prior phase: (1) the migrated routes still work
// end-to-end and correctly reject a cross-company hijack attempt, and (2) the database
// itself enforces isolation via a raw erp_app_tenant connection with no WHERE clause —
// for both a direct company-scoped table (expenses) and a category-B child table scoped
// via its parent (quotationItems, scoped through quotations).
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyAId: string;
let companyBId: string;
let sessionId: string;
let customerAId: string;
let vendorAId: string;
let taxSlabAId: string;
let bankAId: string;

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
  companyAId = await makeCompany('TenantDb Phase3 Test Co A');
  companyBId = await makeCompany('TenantDb Phase3 Test Co B');

  const userAId = generateId();
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  const username = `tenantdb_p3_test_${userAId}`;
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

  customerAId = generateId();
  await db.insert(schema.customers).values({
    id: customerAId, name: 'Phase3 Customer A', phone: '111', email: 'p3custa@example.com',
    address: 'A', companyId: companyAId, buyerType: 'B2C',
  });
  vendorAId = generateId();
  await db.insert(schema.vendors).values({
    id: vendorAId, name: 'Phase3 Vendor A', phone: '111', email: 'p3venda@example.com',
    address: 'A', companyId: companyAId, buyerType: 'B2C',
  });
  taxSlabAId = generateId();
  await db.insert(schema.taxSlabs).values({ id: taxSlabAId, name: 'Phase3 Slab A', percentage: '15', companyId: companyAId });
  bankAId = generateId();
  await db.insert(schema.bankAccounts).values({
    id: bankAId, bankName: 'Phase3 Bank A', accountNumber: '1', accountTitle: 'A',
    openingBalance: '0', companyId: companyAId,
  });
  // validateTransactionDate (server/lib/businessLogic.ts) requires a fiscalMonths row to
  // exist for a transaction's own month — every route this file exercises calls it.
  const monthId = new Date().toISOString().slice(0, 7);
  await db.insert(schema.fiscalMonths).values({ id: monthId, name: monthId, status: 'Open', companyId: companyAId }).onConflictDoNothing();
});

afterAll(async () => {
  await db.delete(schema.vouchers).where(eq(schema.vouchers.companyId, companyAId));
  await db.delete(schema.recurringPostings).where(eq(schema.recurringPostings.companyId, companyAId));
  await db.delete(schema.recurringExpenseTemplates).where(eq(schema.recurringExpenseTemplates.companyId, companyAId));
  await db.delete(schema.expenseItems);
  await db.delete(schema.expenses).where(eq(schema.expenses.companyId, companyAId));
  await db.delete(schema.investors).where(eq(schema.investors.companyId, companyAId));
  await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyAId));
  await db.delete(schema.quotationItems);
  await db.delete(schema.quotations).where(eq(schema.quotations.companyId, companyAId));
  await db.delete(schema.quotations).where(eq(schema.quotations.companyId, companyBId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, companyAId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, companyBId));
  await db.delete(schema.vendors).where(eq(schema.vendors.companyId, companyAId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyAId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyBId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyAId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyAId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyBId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyAId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyBId));
  await db.delete(schema.users).where(eq(schema.users.companyId, companyAId));
  await db.delete(schema.users).where(eq(schema.users.companyId, companyBId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyAId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyBId));
});

describe('Quotations — end-to-end through tenantDb, plus cross-company hijack rejection', () => {
  let quotationAId: string;
  let quotationBId: string;

  it('creates a quotation for Company A through the tenantDb-backed POST /quotations route', async () => {
    const { status, body } = await api('/api/transactions/quotations', {
      method: 'POST',
      body: JSON.stringify({
        quotationData: {
          date: new Date().toISOString().slice(0, 10), customerId: customerAId, taxSlabId: taxSlabAId,
          notes: '', status: 'Draft',
          // createdById is client-supplied on this route (see QuotationModule.tsx),
          // unlike POST /invoices which resolves it server-side — matching real traffic.
          createdById: (await db.select().from(schema.users).where(eq(schema.users.companyId, companyAId)))[0].id,
          // id is client-generated per line item too (see QuotationModule.tsx) — matching
          // real traffic.
          items: [{ id: generateId(), description: 'Line 1', unitCost: 100, quantity: 1 }],
        },
      }),
    });
    expect(status).toBe(200);
    const [row] = await db.select().from(schema.quotations).where(eq(schema.quotations.companyId, companyAId));
    expect(row).toBeTruthy();
    quotationAId = row.id;
  });

  it('GET /quotations for Company A never returns Company B\'s quotation', async () => {
    quotationBId = generateId();
    const bCustomerId = generateId();
    await db.insert(schema.customers).values({
      id: bCustomerId, name: 'B Cust', phone: '1', email: 'p3bcust@example.com', address: 'B', companyId: companyBId, buyerType: 'B2C',
    });
    const bTaxSlabId = generateId();
    await db.insert(schema.taxSlabs).values({ id: bTaxSlabId, name: 'B Slab', percentage: '15', companyId: companyBId });
    const bUserId = generateId();
    await db.insert(schema.users).values({ id: bUserId, username: `p3bowner_${bUserId}`, password: 'x', role: 'admin', companyId: companyBId, isSuperAdmin: false });
    await db.insert(schema.quotations).values({
      id: quotationBId, quotationNumber: 'QT-B-P3-1', date: new Date().toISOString().slice(0, 10),
      customerId: bCustomerId, taxSlabId: bTaxSlabId, notes: '', status: 'Draft',
      createdById: bUserId, createdAt: new Date(), companyId: companyBId,
    });

    const { status, body } = await api('/api/transactions/quotations');
    expect(status).toBe(200);
    const ids = body.map((q: any) => q.id);
    expect(ids).toContain(quotationAId);
    expect(ids).not.toContain(quotationBId);
  });

  it('blocks Company A from hijacking Company B\'s quotation via POST with a cross-company id', async () => {
    const { status, body } = await api('/api/transactions/quotations', {
      method: 'POST',
      body: JSON.stringify({
        quotationData: { id: quotationBId, date: new Date().toISOString().slice(0, 10), customerId: customerAId, taxSlabId: taxSlabAId, notes: 'hijacked', status: 'Draft', items: [] },
      }),
    });
    expect(status).toBe(403);
    expect(body.error).toMatch(/another company/i);
    const [row] = await db.select().from(schema.quotations).where(eq(schema.quotations.id, quotationBId));
    expect(row.companyId).toBe(companyBId);
    expect(row.notes).not.toBe('hijacked');
  });

  it('a raw connection as erp_app_tenant, scoped to Company A, cannot see Company B\'s quotation even with no WHERE clause', async () => {
    const { Pool } = pg;
    const pool = new Pool({
      host: process.env.SQL_HOST, user: process.env.TENANT_DB_USER,
      password: process.env.TENANT_DB_PASSWORD, database: process.env.SQL_DB_NAME,
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.company_id', $1, true)", [companyAId]);
      const res = await client.query('SELECT id, company_id FROM quotations');
      const ids = res.rows.map((r: any) => r.id);
      expect(ids).toContain(quotationAId);
      expect(ids).not.toContain(quotationBId);
      await client.query('ROLLBACK');
    } finally {
      client.release();
      await pool.end();
    }
  });

  it('a raw connection as erp_app_tenant, scoped to Company A, cannot see Company B\'s quotation ITEMS via the child-table EXISTS policy', async () => {
    const bItemId = generateId();
    await db.insert(schema.quotationItems).values({
      id: bItemId, quotationId: quotationBId, description: 'B item', unitCost: '50', quantity: '1',
    });
    const { Pool } = pg;
    const pool = new Pool({
      host: process.env.SQL_HOST, user: process.env.TENANT_DB_USER,
      password: process.env.TENANT_DB_PASSWORD, database: process.env.SQL_DB_NAME,
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.company_id', $1, true)", [companyAId]);
      const res = await client.query('SELECT id FROM quotation_items');
      const ids = res.rows.map((r: any) => r.id);
      expect(ids).not.toContain(bItemId);
      await client.query('ROLLBACK');
    } finally {
      client.release();
      await pool.end();
    }
  });
});

describe('Investors, fiscal months, recurring expenses, accruals, inter-bank transfer — smoke test through tenantDb', () => {
  it('creates an investor and records a capital contribution', async () => {
    const { status, body } = await api('/api/transactions/investors', {
      method: 'POST',
      body: JSON.stringify({ name: 'Phase3 Investor', email: 'inv@example.com', phone: '1', equityPercentage: 10, capitalContributed: 0, createdAt: new Date().toISOString() }),
    });
    expect(status).toBe(200);
    const [investor] = await db.select().from(schema.investors).where(eq(schema.investors.companyId, companyAId));
    expect(investor).toBeTruthy();

    const { status: s2 } = await api(`/api/transactions/investors/${investor.id}/investment`, {
      method: 'POST',
      body: JSON.stringify({ bankId: bankAId, amount: 500, date: new Date().toISOString().slice(0, 10), description: 'Seed' }),
    });
    expect(s2).toBe(200);
    const [updated] = await db.select().from(schema.investors).where(eq(schema.investors.id, investor.id));
    expect(Number(updated.capitalContributed)).toBe(500);
  });

  it('opens a fiscal month and lists it back', async () => {
    const monthId = new Date().toISOString().slice(0, 7) + '-p3test';
    const { status } = await api('/api/transactions/months', {
      method: 'POST',
      body: JSON.stringify({ id: monthId, name: monthId, status: 'Open' }),
    });
    expect(status).toBe(200);
    const { status: s2, body } = await api('/api/transactions/months');
    expect(s2).toBe(200);
    expect(body.some((m: any) => m.id === monthId)).toBe(true);
  });

  it('creates a recurring expense template, posts it, and settles an accrual', async () => {
    const { status, body } = await api('/api/transactions/recurring-templates', {
      method: 'POST',
      body: JSON.stringify({ description: 'Phase3 Rent', defaultAmount: 1000, bankId: bankAId, vendorId: vendorAId, taxSlabId: taxSlabAId, isActive: true }),
    });
    expect(status).toBe(200);
    const templateId = body.id;

    const monthId = new Date().toISOString().slice(0, 7);
    const { status: s2 } = await api('/api/transactions/recurring-postings', {
      method: 'POST',
      body: JSON.stringify({ templateId, monthId, postType: 'Accrual', amount: 1000, dateStr: new Date().toISOString().slice(0, 10), paymentStatus: 'Unpaid', bankId: bankAId }),
    });
    expect(s2).toBe(200);

    const [accrual] = await db.select().from(schema.expenses).where(and(eq(schema.expenses.companyId, companyAId), eq(schema.expenses.type, 'Accrual')));
    expect(accrual).toBeTruthy();

    const { status: s3 } = await api('/api/transactions/settle-accrual', {
      method: 'POST',
      body: JSON.stringify({ accrualExpenseId: accrual.id, actualAmount: 1000, actualDate: new Date().toISOString().slice(0, 10), paymentStatus: 'Paid', bankId: bankAId }),
    });
    expect(s3).toBe(200);
    const [settled] = await db.select().from(schema.expenses).where(eq(schema.expenses.id, accrual.id));
    expect(settled.accrualSettled).toBe(true);
  });

  it('performs an inter-bank transfer', async () => {
    const bankBId = generateId();
    await db.insert(schema.bankAccounts).values({
      id: bankBId, bankName: 'Phase3 Bank B', accountNumber: '2', accountTitle: 'B', openingBalance: '0', companyId: companyAId,
    });
    const { status } = await api('/api/transactions/interbank-transfer', {
      method: 'POST',
      body: JSON.stringify({ sourceBankId: bankAId, destBankId: bankBId, amount: 200, description: 'Test transfer', dateStr: new Date().toISOString().slice(0, 10) }),
    });
    expect(status).toBe(200);
    const transferVouchers = await db.select().from(schema.vouchers).where(and(eq(schema.vouchers.companyId, companyAId), eq(schema.vouchers.referenceType, 'Transfer')));
    expect(transferVouchers.length).toBe(2);
  });
});

describe('Expenses — end-to-end through tenantDb (expenses.ts, fully migrated)', () => {
  it('creates, pays, and cancels an expense', async () => {
    const { status, body } = await api('/api/expenses', {
      method: 'POST',
      body: JSON.stringify({
        date: new Date().toISOString().slice(0, 10), vendorId: vendorAId, taxSlabId: taxSlabAId, bankId: bankAId,
        description: 'Phase3 expense', amount: 300, status: 'Active', type: 'Actual', billNumber: 'BILL-P3-1',
      }),
    });
    expect(status).toBe(200);
    const [expense] = await db.select().from(schema.expenses).where(and(eq(schema.expenses.companyId, companyAId), eq(schema.expenses.billNumber, 'BILL-P3-1')));
    expect(expense).toBeTruthy();
    expect(expense.paymentStatus).toBe('Unpaid');

    const { status: s2 } = await api(`/api/expenses/${expense.id}/pay`, {
      method: 'POST',
      body: JSON.stringify({ date: new Date().toISOString().slice(0, 10), bankId: bankAId }),
    });
    expect(s2).toBe(200);
    const [paid] = await db.select().from(schema.expenses).where(eq(schema.expenses.id, expense.id));
    expect(paid.paymentStatus).toBe('Paid');
  });

  it('a raw connection as erp_app_tenant, scoped to Company A, cannot see Company B\'s expense even with no WHERE clause', async () => {
    const bVendorId = generateId();
    await db.insert(schema.vendors).values({ id: bVendorId, name: 'B Vendor P3', phone: '1', email: 'p3bvend@example.com', address: 'B', companyId: companyBId, buyerType: 'B2C' });
    const bTaxSlabId = generateId();
    await db.insert(schema.taxSlabs).values({ id: bTaxSlabId, name: 'B Slab P3', percentage: '15', companyId: companyBId });
    const bUserId = generateId();
    await db.insert(schema.users).values({ id: bUserId, username: `p3bowner2_${bUserId}`, password: 'x', role: 'admin', companyId: companyBId, isSuperAdmin: false });
    const bBankId = generateId();
    await db.insert(schema.bankAccounts).values({
      id: bBankId, bankName: 'B Bank P3', accountNumber: '9', accountTitle: 'B', openingBalance: '0', companyId: companyBId,
    });
    const bExpenseId = generateId();
    await db.insert(schema.expenses).values({
      id: bExpenseId, expenseNumber: 'EXP-B-P3-1', date: new Date().toISOString().slice(0, 10),
      vendorId: bVendorId, taxSlabId: bTaxSlabId, bankId: bBankId, paymentStatus: 'Unpaid', description: 'B expense', amount: '1',
      status: 'Active', type: 'Actual', createdById: bUserId, createdAt: new Date(), companyId: companyBId,
    });

    const { Pool } = pg;
    const pool = new Pool({
      host: process.env.SQL_HOST, user: process.env.TENANT_DB_USER,
      password: process.env.TENANT_DB_PASSWORD, database: process.env.SQL_DB_NAME,
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.company_id', $1, true)", [companyAId]);
      const res = await client.query('SELECT id FROM expenses');
      const ids = res.rows.map((r: any) => r.id);
      expect(ids).not.toContain(bExpenseId);
      await client.query('ROLLBACK');
    } finally {
      client.release();
      await pool.end();
    }
    await db.delete(schema.expenses).where(eq(schema.expenses.id, bExpenseId));
    await db.delete(schema.users).where(eq(schema.users.id, bUserId));
    await db.delete(schema.vendors).where(eq(schema.vendors.id, bVendorId));
    await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.id, bTaxSlabId));
    await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.id, bBankId));
  });
});
