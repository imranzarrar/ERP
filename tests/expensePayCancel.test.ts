import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq, and } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server (npm run dev on
// localhost:3000) + real Postgres state, matching this project's established no-mocks
// testing practice (see tests/zatcaWorkflow.test.ts). Covers the newly added
// POST /api/expenses/:id/pay and POST /api/expenses/:id/cancel routes, which port
// src/dbStore.ts's markExpensePaid/cancelExpense onto real per-record REST routes.
// Dedicated throwaway company/users/bank/vendor/tax-slab fixture, torn down in
// afterAll — never touches the seeded demo companies used for manual QA.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let otherCompanyId: string;
let monthId: string;
let taxSlabId: string;
let vendorId: string;
let bankId: string;
let adminUserId: string;
let staffUserId: string;
let otherCompanyUserId: string;
let adminSessionId: string;
let staffSessionId: string;
let otherCompanySessionId: string;
const createdExpenseIds: string[] = [];

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

async function insertExpense(overrides: Partial<typeof schema.expenses.$inferInsert> = {}) {
  const id = generateId();
  const today = new Date().toISOString().split('T')[0];
  await db.insert(schema.expenses).values({
    id,
    expenseNumber: `EXP-TEST-${id.slice(0, 8)}`,
    date: today,
    vendorId,
    taxSlabId,
    bankId,
    paymentStatus: 'Unpaid',
    paymentDate: null,
    description: 'Test expense for pay/cancel routes',
    amount: '1000',
    amountPaid: '0',
    status: 'Active',
    type: 'Actual',
    createdById: adminUserId,
    createdAt: new Date(),
    companyId,
    ...overrides,
  });
  createdExpenseIds.push(id);
  return id;
}

beforeAll(async () => {
  companyId = generateId();
  otherCompanyId = generateId();
  await db.insert(schema.companies).values([
    { id: companyId, name: 'Expense Pay/Cancel Test Co', address: 'x', phone: '0', email: 'expay@example.com', logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false },
    { id: otherCompanyId, name: 'Expense Pay/Cancel Test Co B', address: 'x', phone: '0', email: 'expayb@example.com', logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false },
  ]);

  monthId = new Date().toISOString().slice(0, 7);
  await db.insert(schema.fiscalMonths).values({ id: monthId, name: monthId, status: 'Open', companyId }).onConflictDoNothing();

  taxSlabId = generateId();
  await db.insert(schema.taxSlabs).values({ id: taxSlabId, name: 'Standard 15%', percentage: '15', companyId });

  vendorId = generateId();
  await db.insert(schema.vendors).values({ id: vendorId, name: 'Test Vendor', phone: '0', email: 'vendor@example.com', address: 'x', isSystem: true, companyId });

  bankId = generateId();
  await db.insert(schema.bankAccounts).values({ id: bankId, bankName: 'Test Bank', accountNumber: '00011122', accountTitle: 'Expense Test Co', openingBalance: '0', isActive: true, isDefault: true, companyId });

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

  adminUserId = generateId();
  const adminUsername = `exppay_admin_${adminUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({ id: adminUserId, username: adminUsername, password: passwordHash, role: 'admin', companyId, isSuperAdmin: false });

  staffUserId = generateId();
  const staffUsername = `exppay_staff_${staffUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({ id: staffUserId, username: staffUsername, password: passwordHash, role: 'staff', companyId, isSuperAdmin: false });

  otherCompanyUserId = generateId();
  const otherUsername = `exppay_other_${otherCompanyUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({ id: otherCompanyUserId, username: otherUsername, password: passwordHash, role: 'admin', companyId: otherCompanyId, isSuperAdmin: false });

  adminSessionId = await login(adminUsername);
  staffSessionId = await login(staffUsername);
  otherCompanySessionId = await login(otherUsername);
});

afterAll(async () => {
  for (const expId of createdExpenseIds) {
    await db.delete(schema.vouchers).where(eq(schema.vouchers.referenceId, expId));
  }
  await db.delete(schema.expenses).where(eq(schema.expenses.companyId, companyId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyId));
  await db.delete(schema.vendors).where(eq(schema.vendors.companyId, companyId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyId));
  await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, adminUserId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, staffUserId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, otherCompanyUserId));
  await db.delete(schema.users).where(eq(schema.users.id, adminUserId));
  await db.delete(schema.users).where(eq(schema.users.id, staffUserId));
  await db.delete(schema.users).where(eq(schema.users.id, otherCompanyUserId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, otherCompanyId));
});

describe('POST /api/expenses/:id/pay', () => {
  it('records a partial payment, updates status, and posts a Payment voucher', async () => {
    const expId = await insertExpense();
    const today = new Date().toISOString().split('T')[0];

    const { status, body } = await api(adminSessionId, `/api/expenses/${expId}/pay`, {
      method: 'POST',
      body: JSON.stringify({ date: today, bankId, amount: 400 }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [row] = await db.select().from(schema.expenses).where(eq(schema.expenses.id, expId));
    expect(row.paymentStatus).toBe('Partially Paid');
    expect(Number(row.amountPaid)).toBe(400);

    const vouchers = await db.select().from(schema.vouchers)
      .where(and(eq(schema.vouchers.referenceId, expId), eq(schema.vouchers.referenceType, 'Expense'), eq(schema.vouchers.type, 'Payment')));
    expect(vouchers.length).toBe(1);
    expect(Number(vouchers[0].amount)).toBe(400);
  });

  it('rejects a payment amount exceeding the remaining balance', async () => {
    const expId = await insertExpense();
    const today = new Date().toISOString().split('T')[0];

    await api(adminSessionId, `/api/expenses/${expId}/pay`, {
      method: 'POST',
      body: JSON.stringify({ date: today, bankId, amount: 400 }),
    });

    const { status, body } = await api(adminSessionId, `/api/expenses/${expId}/pay`, {
      method: 'POST',
      body: JSON.stringify({ date: today, bankId, amount: 700 }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/exceeds the remaining balance/);
  });

  it('settles the remaining balance to Paid and posts a second voucher for the remainder', async () => {
    const expId = await insertExpense();
    const today = new Date().toISOString().split('T')[0];

    await api(adminSessionId, `/api/expenses/${expId}/pay`, {
      method: 'POST',
      body: JSON.stringify({ date: today, bankId, amount: 400 }),
    });
    const { status, body } = await api(adminSessionId, `/api/expenses/${expId}/pay`, {
      method: 'POST',
      body: JSON.stringify({ date: today, bankId, amount: 600 }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [row] = await db.select().from(schema.expenses).where(eq(schema.expenses.id, expId));
    expect(row.paymentStatus).toBe('Paid');
    expect(Number(row.amountPaid)).toBe(1000);

    const vouchers = await db.select().from(schema.vouchers)
      .where(and(eq(schema.vouchers.referenceId, expId), eq(schema.vouchers.referenceType, 'Expense'), eq(schema.vouchers.type, 'Payment')));
    expect(vouchers.length).toBe(2);
  });

  it('rejects paying an already-Paid expense', async () => {
    const expId = await insertExpense({ paymentStatus: 'Paid', amountPaid: '1000' });
    const today = new Date().toISOString().split('T')[0];

    const { status, body } = await api(adminSessionId, `/api/expenses/${expId}/pay`, {
      method: 'POST',
      body: JSON.stringify({ date: today, bankId, amount: 100 }),
    });
    expect(status).toBe(500);
    expect(body.error).toMatch(/already paid/);
  });

  it('rejects paying a Cancelled expense', async () => {
    const expId = await insertExpense({ status: 'Cancelled' });
    const today = new Date().toISOString().split('T')[0];

    const { status, body } = await api(adminSessionId, `/api/expenses/${expId}/pay`, {
      method: 'POST',
      body: JSON.stringify({ date: today, bankId, amount: 100 }),
    });
    expect(status).toBe(500);
    expect(body.error).toMatch(/Cancelled expenses cannot be paid/);
  });

  it('does not resolve an expense belonging to another company', async () => {
    const expId = await insertExpense();
    const today = new Date().toISOString().split('T')[0];

    const { status, body } = await api(otherCompanySessionId, `/api/expenses/${expId}/pay`, {
      method: 'POST',
      body: JSON.stringify({ date: today, bankId, amount: 100 }),
    });
    expect(status).toBe(500);
    expect(body.error).toMatch(/not found/);
  });
});

describe('POST /api/expenses/:id/cancel', () => {
  it('cancels a paid expense and posts a Reversal voucher', async () => {
    const expId = await insertExpense();
    const today = new Date().toISOString().split('T')[0];

    await api(adminSessionId, `/api/expenses/${expId}/pay`, {
      method: 'POST',
      body: JSON.stringify({ date: today, bankId, amount: 1000 }),
    });

    const { status, body } = await api(adminSessionId, `/api/expenses/${expId}/cancel`, { method: 'POST' });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [row] = await db.select().from(schema.expenses).where(eq(schema.expenses.id, expId));
    expect(row.status).toBe('Cancelled');

    const reversals = await db.select().from(schema.vouchers)
      .where(and(eq(schema.vouchers.referenceId, expId), eq(schema.vouchers.referenceType, 'Expense'), eq(schema.vouchers.type, 'Reversal')));
    expect(reversals.length).toBe(1);
    expect(Number(reversals[0].amount)).toBe(1000);
  });

  it('rejects cancelling an already-cancelled expense', async () => {
    const expId = await insertExpense({ status: 'Cancelled' });

    const { status, body } = await api(adminSessionId, `/api/expenses/${expId}/cancel`, { method: 'POST' });
    expect(status).toBe(500);
    expect(body.error).toMatch(/already cancelled/);
  });

  it('rejects a staff user without cancel permission', async () => {
    const expId = await insertExpense();

    const { status } = await api(staffSessionId, `/api/expenses/${expId}/cancel`, { method: 'POST' });
    expect(status).toBe(403);

    const [row] = await db.select().from(schema.expenses).where(eq(schema.expenses.id, expId));
    expect(row.status).toBe('Active');
  });
});
