import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq, and } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server (npm run dev on
// localhost:3000) + real Postgres state, matching this project's established no-mocks
// testing practice (see tests/zatcaWorkflow.test.ts). Covers the new recurring-expense
// template CRUD routes and accrual edit/delete routes added to
// server/routes/transactions.ts, which port src/components/RecurringExpenses.tsx's
// former pure client-side handlers onto real per-record REST routes. Dedicated
// throwaway company/user/bank/vendor/tax-slab fixture, torn down in afterAll — never
// touches the seeded demo companies used for manual QA.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let monthId: string;
let taxSlabId: string;
let vendorId: string;
let bankId: string;
let adminUserId: string;
let adminSessionId: string;
const createdTemplateIds: string[] = [];
const createdExpenseIds: string[] = [];

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-session-id': adminSessionId, ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: 'Recurring Templates Test Co', address: 'x', phone: '0',
    email: 'rectemplate@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false,
  });

  monthId = new Date().toISOString().slice(0, 7);
  await db.insert(schema.fiscalMonths).values({ id: monthId, name: monthId, status: 'Open', companyId }).onConflictDoNothing();

  taxSlabId = generateId();
  await db.insert(schema.taxSlabs).values({ id: taxSlabId, name: 'Standard 15%', percentage: '15', companyId });

  vendorId = generateId();
  await db.insert(schema.vendors).values({ id: vendorId, name: 'Test Vendor', phone: '0', email: 'vendor@example.com', address: 'x', isSystem: true, companyId });

  bankId = generateId();
  await db.insert(schema.bankAccounts).values({ id: bankId, bankName: 'Test Bank', accountNumber: '00099988', accountTitle: 'Rec Template Test Co', openingBalance: '0', isActive: true, isDefault: true, companyId });

  adminUserId = generateId();
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  const adminUsername = `rectemplate_admin_${adminUserId}`;
  await db.insert(schema.users).values({ id: adminUserId, username: adminUsername, password: passwordHash, role: 'admin', companyId, isSuperAdmin: false });

  const loginRes = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: adminUsername, password: TEST_PASSWORD }),
  });
  const loginBody = await loginRes.json().catch(() => null);
  if (!loginBody?.sessionId) throw new Error(`Test setup failed: login did not return a sessionId (status ${loginRes.status}, body ${JSON.stringify(loginBody)})`);
  adminSessionId = loginBody.sessionId;
});

afterAll(async () => {
  for (const expId of createdExpenseIds) {
    await db.delete(schema.recurringPostings).where(eq(schema.recurringPostings.expenseId, expId));
    await db.delete(schema.expenses).where(eq(schema.expenses.id, expId));
  }
  for (const tplId of createdTemplateIds) {
    await db.delete(schema.recurringPostings).where(eq(schema.recurringPostings.templateId, tplId));
    await db.delete(schema.recurringExpenseTemplates).where(eq(schema.recurringExpenseTemplates.id, tplId));
  }
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyId));
  await db.delete(schema.vendors).where(eq(schema.vendors.companyId, companyId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyId));
  await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, adminUserId));
  await db.delete(schema.users).where(eq(schema.users.id, adminUserId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
});

describe('Recurring expense template CRUD', () => {
  it('creates a new template', async () => {
    const { status, body } = await api('/api/transactions/recurring-templates', {
      method: 'POST',
      body: JSON.stringify({ description: 'Monthly Rent', defaultAmount: 2500, bankId, vendorId, taxSlabId, isActive: true }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.id).toBeTruthy();
    createdTemplateIds.push(body.id);

    const [row] = await db.select().from(schema.recurringExpenseTemplates).where(eq(schema.recurringExpenseTemplates.id, body.id));
    expect(row.description).toBe('Monthly Rent');
    expect(Number(row.defaultAmount)).toBe(2500);
    expect(row.isActive).toBe(true);
    expect(row.companyId).toBe(companyId);
  });

  it('rejects creating a template with an invalid amount', async () => {
    const { status, body } = await api('/api/transactions/recurring-templates', {
      method: 'POST',
      body: JSON.stringify({ description: 'Bad Template', defaultAmount: 0, bankId, vendorId, taxSlabId, isActive: true }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/valid amount/);
  });

  it('updates an existing template', async () => {
    const created = await api('/api/transactions/recurring-templates', {
      method: 'POST',
      body: JSON.stringify({ description: 'Software License', defaultAmount: 500, bankId, vendorId, taxSlabId, isActive: true }),
    });
    const tplId = created.body.id;
    createdTemplateIds.push(tplId);

    const { status, body } = await api(`/api/transactions/recurring-templates/${tplId}`, {
      method: 'PUT',
      body: JSON.stringify({ description: 'Software License (Updated)', defaultAmount: 750, bankId, vendorId, taxSlabId, isActive: false }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [row] = await db.select().from(schema.recurringExpenseTemplates).where(eq(schema.recurringExpenseTemplates.id, tplId));
    expect(row.description).toBe('Software License (Updated)');
    expect(Number(row.defaultAmount)).toBe(750);
    expect(row.isActive).toBe(false);
  });

  it('toggles a template active/inactive', async () => {
    const created = await api('/api/transactions/recurring-templates', {
      method: 'POST',
      body: JSON.stringify({ description: 'Internet Bill', defaultAmount: 300, bankId, vendorId, taxSlabId, isActive: true }),
    });
    const tplId = created.body.id;
    createdTemplateIds.push(tplId);

    const { status, body } = await api(`/api/transactions/recurring-templates/${tplId}/toggle`, { method: 'PATCH' });
    expect(status).toBe(200);
    expect(body.isActive).toBe(false);

    const [row] = await db.select().from(schema.recurringExpenseTemplates).where(eq(schema.recurringExpenseTemplates.id, tplId));
    expect(row.isActive).toBe(false);

    const second = await api(`/api/transactions/recurring-templates/${tplId}/toggle`, { method: 'PATCH' });
    expect(second.body.isActive).toBe(true);
  });

  it('"deletes" a template by deactivating it, not removing the row (soft-delete)', async () => {
    const created = await api('/api/transactions/recurring-templates', {
      method: 'POST',
      body: JSON.stringify({ description: 'Disposable Template', defaultAmount: 100, bankId, vendorId, taxSlabId, isActive: true }),
    });
    const tplId = created.body.id;
    createdTemplateIds.push(tplId);

    const { status, body } = await api(`/api/transactions/recurring-templates/${tplId}`, { method: 'DELETE' });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [row] = await db.select().from(schema.recurringExpenseTemplates).where(eq(schema.recurringExpenseTemplates.id, tplId));
    expect(row).toBeTruthy();
    expect(row.isActive).toBe(false);
  });

  it('404s updating a template that does not exist', async () => {
    const { status, body } = await api(`/api/transactions/recurring-templates/${generateId()}`, {
      method: 'PUT',
      body: JSON.stringify({ description: 'Ghost', defaultAmount: 100, bankId, vendorId, taxSlabId, isActive: true }),
    });
    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/);
  });
});

describe('Accrual entry edit/delete', () => {
  async function insertAccrual() {
    const id = generateId();
    const today = new Date().toISOString().split('T')[0];
    await db.insert(schema.expenses).values({
      id,
      expenseNumber: `EXP-ACC-${id}`,
      date: today,
      vendorId,
      taxSlabId,
      bankId,
      paymentStatus: 'Unpaid',
      paymentDate: null,
      description: 'Test accrual entry',
      amount: '800',
      amountPaid: '0',
      status: 'Active',
      type: 'Accrual',
      createdById: adminUserId,
      createdAt: new Date(),
      companyId,
    });
    createdExpenseIds.push(id);
    return id;
  }

  it('updates an accrual entry', async () => {
    const accId = await insertAccrual();
    const today = new Date().toISOString().split('T')[0];

    const { status, body } = await api(`/api/transactions/accruals/${accId}`, {
      method: 'PUT',
      body: JSON.stringify({ description: 'Updated accrual description', amount: 950, vendorId, bankId, date: today, taxSlabId }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [row] = await db.select().from(schema.expenses).where(eq(schema.expenses.id, accId));
    expect(row.description).toBe('Updated accrual description');
    expect(Number(row.amount)).toBe(950);
  });

  it('rejects updating an accrual with an invalid amount', async () => {
    const accId = await insertAccrual();
    const today = new Date().toISOString().split('T')[0];

    const { status, body } = await api(`/api/transactions/accruals/${accId}`, {
      method: 'PUT',
      body: JSON.stringify({ description: 'Bad amount', amount: -5, vendorId, bankId, date: today, taxSlabId }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/valid amount/);
  });

  it('"deletes" an accrual entry by cancelling it (soft-delete), while still removing its linked recurring posting', async () => {
    const accId = await insertAccrual();

    // Wire up a template + posting referencing this accrual, matching how
    // postRecurringExpense links an Accrual posting to its generated expense row.
    const tplId = generateId();
    await db.insert(schema.recurringExpenseTemplates).values({
      id: tplId, description: 'Linked Template', vendorId, defaultAmount: '800', taxSlabId, isActive: true, bankId, companyId,
    });
    createdTemplateIds.push(tplId);

    const postingId = generateId();
    await db.insert(schema.recurringPostings).values({
      id: postingId, templateId: tplId, monthId, status: 'Posted as Accrual', expenseId: accId, companyId,
    });

    const { status, body } = await api(`/api/transactions/accruals/${accId}`, { method: 'DELETE' });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    // The expense row itself stays — cancelled, not gone — same as every other
    // cancelled document in this app keeps its own content.
    const [expenseRow] = await db.select().from(schema.expenses).where(eq(schema.expenses.id, accId));
    expect(expenseRow).toBeTruthy();
    expect(expenseRow.status).toBe('Cancelled');

    // The join row to the recurring template is still removed — it's a workflow marker,
    // not a financial document, and removing it frees the template/month slot to post again.
    const postingRows = await db.select().from(schema.recurringPostings).where(eq(schema.recurringPostings.id, postingId));
    expect(postingRows.length).toBe(0);
  });

  it('404s deleting an accrual that does not exist', async () => {
    const { status, body } = await api(`/api/transactions/accruals/${generateId()}`, { method: 'DELETE' });
    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/);
  });
});
