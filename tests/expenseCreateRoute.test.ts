import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server (npm run dev on
// localhost:3000) + real Postgres state, no mocks. Covers a real live bug found while
// auditing a stale parallel-agent worktree before deleting it: POST /api/expenses had
// no expenseNumber/createdById/createdAt counter logic at all (unlike every other
// document-creation route — invoices/quotations in transactions.ts) — expense_number is
// a NOT NULL column with no default, and ExpenseModule.tsx's real create payload never
// sends expenseNumber, so every new-expense creation from the actual UI 500'd outright.
// Fixed by mirroring transactions.ts's isNew-counter pattern, plus stripping/restoring
// expenseNumber/createdById/createdAt so a crafted request body can't inject them either.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let monthId: string;
let taxSlabId: string;
let vendorId: string;
let bankId: string;
let adminUserId: string;
let adminSessionId: string;
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

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: 'Expense Create Route Test Co', address: 'x', phone: '0',
    email: 'expcreate@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false,
  });

  monthId = new Date().toISOString().slice(0, 7);
  await db.insert(schema.fiscalMonths).values({ id: monthId, name: monthId, status: 'Open', companyId }).onConflictDoNothing();

  taxSlabId = generateId();
  await db.insert(schema.taxSlabs).values({ id: taxSlabId, name: 'Standard 15%', percentage: '15', companyId });

  vendorId = generateId();
  await db.insert(schema.vendors).values({ id: vendorId, name: 'Test Vendor', phone: '0', email: 'vendor@example.com', address: 'x', isSystem: true, companyId, buyerType: 'B2C' });

  bankId = generateId();
  await db.insert(schema.bankAccounts).values({ id: bankId, bankName: 'Test Bank', accountNumber: '00099988', accountTitle: 'Expense Create Test Co', openingBalance: '0', isActive: true, isDefault: true, companyId });

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  adminUserId = generateId();
  const adminUsername = `expcreate_admin_${adminUserId}`;
  await db.insert(schema.users).values({ id: adminUserId, username: adminUsername, password: passwordHash, role: 'admin', companyId, isSuperAdmin: false });
  adminSessionId = await login(adminUsername);
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
  await db.delete(schema.users).where(eq(schema.users.id, adminUserId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
});

describe('POST /api/expenses (creation counter + injection guard)', () => {
  it('creates a new expense with a real server-assigned expenseNumber, exactly mirroring the payload ExpenseModule.tsx actually sends (no id, no expenseNumber)', async () => {
    const today = new Date().toISOString().split('T')[0];
    const { status, body } = await api(adminSessionId, '/api/expenses', {
      method: 'POST',
      body: JSON.stringify({
        date: today, vendorId, taxSlabId, bankId, description: 'Regression check expense', billNumber: 'BILL-1',
        amount: 100, status: 'Active', type: 'Actual', paymentStatus: 'Unpaid',
      }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [row] = await db.select().from(schema.expenses).where(eq(schema.expenses.companyId, companyId));
    expect(row).toBeTruthy();
    createdExpenseIds.push(row.id);
    expect(row.expenseNumber).toMatch(/^EXP-\d+$/);
    expect(row.createdById).toBe(adminUserId);
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('rejects a client attempt to inject/overwrite expenseNumber, createdById, and createdAt on update — those fields stay exactly as originally assigned', async () => {
    const today = new Date().toISOString().split('T')[0];
    const createRes = await api(adminSessionId, '/api/expenses', {
      method: 'POST',
      body: JSON.stringify({
        date: today, vendorId, taxSlabId, bankId, description: 'Original description', billNumber: 'BILL-2',
        amount: 200, status: 'Active', type: 'Actual', paymentStatus: 'Unpaid',
      }),
    });
    expect(createRes.status).toBe(200);
    const rows = await db.select().from(schema.expenses).where(eq(schema.expenses.companyId, companyId));
    const targetId = rows.find(e => e.description === 'Original description')!.id;
    createdExpenseIds.push(targetId);
    const [before] = await db.select().from(schema.expenses).where(eq(schema.expenses.id, targetId));

    const updateRes = await api(adminSessionId, '/api/expenses', {
      method: 'POST',
      body: JSON.stringify({
        id: targetId,
        expenseNumber: 'HACKED-999',
        createdById: '00000000-0000-0000-0000-000000000000',
        createdAt: '2000-01-01T00:00:00.000Z',
        date: today, vendorId, taxSlabId, bankId, description: 'Updated description',
        amount: 250, status: 'Active', type: 'Actual', paymentStatus: 'Unpaid',
      }),
    });
    expect(updateRes.status).toBe(200);

    const [after] = await db.select().from(schema.expenses).where(eq(schema.expenses.id, targetId));
    expect(after.description).toBe('Updated description'); // legitimate field DID update
    expect(Number(after.amount)).toBe(250);
    expect(after.expenseNumber).toBe(before.expenseNumber); // unchanged, not "HACKED-999"
    expect(after.createdById).toBe(before.createdById); // unchanged, not the fake id
    expect(new Date(after.createdAt).getTime()).toBe(new Date(before.createdAt).getTime()); // unchanged, not year 2000
  });
});
