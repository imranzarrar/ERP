import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq, and } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against real Postgres state, no mocks, matching this project's
// established testing convention. Covers the HR foundation: Job Titles, Employee
// onboarding + numbering (padWidth/employeeNumberStart), the mandatory-employeeId-once-
// adopted rule on POST /users, and the optional salesAssociateId attribution field on
// invoices — see the approved plan (jobTitles/employees tables, users.employeeId,
// invoices.salesAssociateId).
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let adminUserId: string;
let adminSessionId: string;
let taxSlabId: string;
let customerId: string;
let productId: string;
let branchAId: string;
let branchBId: string;
let bankId: string;

let emptyCompanyId: string; // never onboards an employee — proves the "optional until adopted" side
let emptyAdminUserId: string;
let emptyAdminSessionId: string;

let seededCompanyId: string; // fresh company using employeeNumberStart to continue an HRIS sequence
let seededAdminUserId: string;
let seededAdminSessionId: string;

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

async function makeCompany(name: string, hrSettings: any = null) {
  const id = generateId();
  await db.insert(schema.companies).values({
    id, name, address: 'x', phone: '0', email: `${id}@example.com`,
    logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {},
    zatcaEnabled: false, themeId: 'classic-executive', hrSettings,
  });
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  const userId = generateId();
  // Full id, not a slice — usernames have no DB-level uniqueness constraint, and a
  // UUIDv7's leading hex chars are time-based, so companies created back-to-back within
  // the same millisecond (exactly what beforeAll does) can produce identical 8-char
  // slices, silently aliasing every session onto whichever row login() happens to match.
  const username = `hr_admin_${userId}`;
  await db.insert(schema.users).values({ id: userId, username, password: passwordHash, role: 'admin', companyId: id, isSuperAdmin: false, uiLanguage: 'en' });
  const sessionId = await login(username);
  return { id, userId, sessionId };
}

beforeAll(async () => {
  const main = await makeCompany('HR Test Co');
  companyId = main.id; adminUserId = main.userId; adminSessionId = main.sessionId;

  const empty = await makeCompany('HR Test Co (No Employees)');
  emptyCompanyId = empty.id; emptyAdminUserId = empty.userId; emptyAdminSessionId = empty.sessionId;

  const seeded = await makeCompany('HR Test Co (Seeded Numbering)', { employeeNumberStart: 500 });
  seededCompanyId = seeded.id; seededAdminUserId = seeded.userId; seededAdminSessionId = seeded.sessionId;

  taxSlabId = generateId();
  await db.insert(schema.taxSlabs).values({ id: taxSlabId, name: 'Standard 15%', percentage: '15', companyId });
  customerId = generateId();
  await db.insert(schema.customers).values({ id: customerId, name: 'Test Customer', phone: '0', email: 'c@example.com', address: 'x', companyId });
  // 'service' (not 'item') — a stock item would require a resolvable sales warehouse,
  // which is unrelated to what this file tests (salesAssociateId attribution only).
  productId = generateId();
  await db.insert(schema.productsServices).values({ id: productId, name: 'Test Widget', description: 'x', unitPrice: '10.00', type: 'service', companyId });
  bankId = generateId();
  await db.insert(schema.bankAccounts).values({ id: bankId, bankName: 'Test Bank', accountNumber: '000', accountTitle: 'Test Account', openingBalance: '0', companyId });

  branchAId = generateId();
  branchBId = generateId();
  await db.insert(schema.branches).values([
    { id: branchAId, companyId, name: 'Branch A', code: 'BRA' },
    { id: branchBId, companyId, name: 'Branch B', code: 'BRB' },
  ]);

  const monthId = new Date().toISOString().slice(0, 7);
  await db.insert(schema.fiscalMonths).values({ id: monthId, name: monthId, status: 'Open', companyId }).onConflictDoNothing();
});

afterAll(async () => {
  for (const cid of [companyId, emptyCompanyId, seededCompanyId]) {
    const invoices = await db.select({ id: schema.invoices.id }).from(schema.invoices).where(eq(schema.invoices.companyId, cid));
    for (const inv of invoices) {
      await db.delete(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, inv.id));
    }
    await db.delete(schema.invoices).where(eq(schema.invoices.companyId, cid));
    await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, cid));
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, cid));
    // Users must go before employees — users.employeeId FKs into employees, so deleting
    // employees first (as this loop originally did) throws a foreign-key violation and
    // aborts cleanup for every company still left in the loop.
    await db.delete(schema.users).where(eq(schema.users.companyId, cid));
    await db.delete(schema.employees).where(eq(schema.employees.companyId, cid));
    await db.delete(schema.jobTitles).where(eq(schema.jobTitles.companyId, cid));
  }
  await db.delete(schema.branches).where(eq(schema.branches.companyId, companyId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyId));
  await db.delete(schema.productsServices).where(eq(schema.productsServices.companyId, companyId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, companyId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyId));
  await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, emptyCompanyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, seededCompanyId));
});

describe('Job Titles CRUD', () => {
  let salesRoleId: string;
  let cashierRoleId: string;

  it('creates a sales-role job title and a non-sales job title', async () => {
    const salesRes = await api(adminSessionId, '/api/job-titles', { method: 'POST', body: JSON.stringify({ title: 'Sales Associate', isSalesRole: true }) });
    expect(salesRes.status).toBe(200);
    salesRoleId = salesRes.body.id;

    const cashierRes = await api(adminSessionId, '/api/job-titles', { method: 'POST', body: JSON.stringify({ title: 'Cashier', isSalesRole: false }) });
    expect(cashierRes.status).toBe(200);
    cashierRoleId = cashierRes.body.id;

    const { status, body } = await api(adminSessionId, '/api/job-titles');
    expect(status).toBe(200);
    expect(body.find((jt: any) => jt.id === salesRoleId)?.isSalesRole).toBe(true);
    expect(body.find((jt: any) => jt.id === cashierRoleId)?.isSalesRole).toBe(false);
  });

  it('rejects a duplicate active title for the same company', async () => {
    const { status, body } = await api(adminSessionId, '/api/job-titles', { method: 'POST', body: JSON.stringify({ title: 'Sales Associate', isSalesRole: true }) });
    expect(status).toBe(400);
    expect(body.error).toMatch(/already exists/i);
  });

  it('toggles a job title inactive and back active', async () => {
    const off = await api(adminSessionId, `/api/job-titles/${cashierRoleId}/toggle-active`, { method: 'PATCH' });
    expect(off.status).toBe(200);
    expect(off.body.isActive).toBe(false);

    const on = await api(adminSessionId, `/api/job-titles/${cashierRoleId}/toggle-active`, { method: 'PATCH' });
    expect(on.status).toBe(200);
    expect(on.body.isActive).toBe(true);
  });

  it('stashes the sales-role id for later employee/invoice tests', () => {
    (globalThis as any).__salesRoleId = salesRoleId;
    (globalThis as any).__cashierRoleId = cashierRoleId;
    expect(salesRoleId).toBeTruthy();
  });
});

describe('Employee onboarding + numbering', () => {
  let firstEmployeeId: string;
  let secondEmployeeId: string;

  it('mints a zero-padded 4-digit employee number by default, starting at 0001', async () => {
    const salesRoleId = (globalThis as any).__salesRoleId as string;
    const { status, body } = await api(adminSessionId, '/api/employees', {
      method: 'POST',
      body: JSON.stringify({ name: 'Alice Sales', jobTitleId: salesRoleId, branchId: branchAId }),
    });
    expect(status).toBe(200);
    expect(body.employeeNumber).toBe('0001');
    firstEmployeeId = body.id;
    (globalThis as any).__employeeAId = firstEmployeeId;
  });

  it('continues the same sequence but reformats to 5 digits once padWidth changes', async () => {
    await db.update(schema.companies).set({ hrSettings: { employeeNumberPadWidth: 5 } }).where(eq(schema.companies.id, companyId));
    const salesRoleId = (globalThis as any).__salesRoleId as string;
    const { status, body } = await api(adminSessionId, '/api/employees', {
      method: 'POST',
      body: JSON.stringify({ name: 'Bilal Sales', jobTitleId: salesRoleId, branchId: branchBId }),
    });
    expect(status).toBe(200);
    expect(body.employeeNumber).toBe('00002'); // same running counter (2nd), just re-padded to 5 digits
    secondEmployeeId = body.id;
    (globalThis as any).__employeeBId = secondEmployeeId;
    await db.update(schema.companies).set({ hrSettings: {} }).where(eq(schema.companies.id, companyId));
  });

  it('seeds a fresh company\'s sequence from employeeNumberStart', async () => {
    const roleRes = await api(seededAdminSessionId, '/api/job-titles', { method: 'POST', body: JSON.stringify({ title: 'Sales Associate', isSalesRole: true }) });
    expect(roleRes.status).toBe(200);
    const { status, body } = await api(seededAdminSessionId, '/api/employees', {
      method: 'POST',
      body: JSON.stringify({ name: 'Seeded Employee', jobTitleId: roleRes.body.id }),
    });
    expect(status).toBe(200);
    expect(body.employeeNumber).toBe('0500');
  });

  it('rejects a duplicate employeeNumber at the database level (unique index enforced)', async () => {
    const salesRoleId = (globalThis as any).__salesRoleId as string;
    await expect(db.insert(schema.employees).values({
      id: generateId(), companyId, employeeNumber: '0001', name: 'Duplicate Number', jobTitleId: salesRoleId, isActive: true, createdAt: new Date(),
    })).rejects.toThrow();
  });

  it('onboards an employee to Head Office (branchId null) when no branch is given', async () => {
    const cashierRoleId = (globalThis as any).__cashierRoleId as string;
    const { status, body } = await api(adminSessionId, '/api/employees', {
      method: 'POST',
      body: JSON.stringify({ name: 'HO Cashier', jobTitleId: cashierRoleId }),
    });
    expect(status).toBe(200);
    const [row] = await db.select().from(schema.employees).where(eq(schema.employees.id, body.id));
    expect(row.branchId).toBeNull();
  });

  it('rejects onboarding against a deactivated job title', async () => {
    const cashierRoleId = (globalThis as any).__cashierRoleId as string;
    await api(adminSessionId, `/api/job-titles/${cashierRoleId}/toggle-active`, { method: 'PATCH' }); // deactivate
    const { status, body } = await api(adminSessionId, '/api/employees', {
      method: 'POST',
      body: JSON.stringify({ name: 'Should Fail', jobTitleId: cashierRoleId }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/deactivated/i);
    await api(adminSessionId, `/api/job-titles/${cashierRoleId}/toggle-active`, { method: 'PATCH' }); // reactivate for later tests
  });
});

describe('POST /users — employeeId mandatory once the company has adopted HR onboarding', () => {
  it('allows a new account with no employeeId when the company has zero employees', async () => {
    const { status, body } = await api(emptyAdminSessionId, '/api/users', {
      method: 'POST',
      body: JSON.stringify({ id: generateId(), username: `nohr_${generateId()}`, email: 'nohr@example.com', password: 'x', role: 'admin', companyId: emptyCompanyId }),
    });
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
  });

  it('rejects a new account with no employeeId once the company has an active employee', async () => {
    const { status, body } = await api(adminSessionId, '/api/users', {
      method: 'POST',
      body: JSON.stringify({ id: generateId(), username: `needshr_${generateId()}`, email: 'needshr@example.com', password: 'x', role: 'admin', companyId }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/HR employee onboarding/i);
  });

  it('rejects linking a deactivated employee to a new account', async () => {
    const cashierRoleId = (globalThis as any).__cashierRoleId as string;
    const deactivatedRes = await api(adminSessionId, '/api/employees', { method: 'POST', body: JSON.stringify({ name: 'To Deactivate', jobTitleId: cashierRoleId }) });
    await api(adminSessionId, `/api/employees/${deactivatedRes.body.id}/toggle-active`, { method: 'PATCH' });

    const { status, body } = await api(adminSessionId, '/api/users', {
      method: 'POST',
      body: JSON.stringify({ id: generateId(), username: `deactemp_${generateId()}`, email: 'deactemp@example.com', password: 'x', role: 'admin', companyId, employeeId: deactivatedRes.body.id }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/deactivated/i);
  });

  it('accepts a new account linked to a valid active employee', async () => {
    const employeeAId = (globalThis as any).__employeeAId as string;
    const newUserId = generateId();
    const { status, body } = await api(adminSessionId, '/api/users', {
      method: 'POST',
      body: JSON.stringify({ id: newUserId, username: `withhr_${generateId()}`, email: 'withhr@example.com', password: 'x', role: 'admin', companyId, employeeId: employeeAId }),
    });
    expect(status).toBe(200);
    const [linked] = await db.select().from(schema.users).where(eq(schema.users.id, newUserId));
    expect(linked.employeeId).toBe(employeeAId);
  });
});

describe('Invoice salesAssociateId attribution field', () => {
  it('persists a valid, active, same-company sales associate on a new invoice', async () => {
    const employeeAId = (globalThis as any).__employeeAId as string;
    const { status, body } = await api(adminSessionId, `/api/transactions/invoices?companyId=${companyId}`, {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: new Date().toISOString().slice(0, 10), customerId, taxSlabId, bankId, notes: '', status: 'Active',
          items: [{ id: generateId(), description: 'Widget', unitCost: 10, quantity: 1, unit: 'PCE', productId }],
          salesAssociateId: employeeAId,
        },
      }),
    });
    expect(status).toBe(200);
    const match = await db.select().from(schema.invoices).where(and(eq(schema.invoices.companyId, companyId), eq(schema.invoices.salesAssociateId, employeeAId)));
    expect(match.length).toBeGreaterThan(0);
  });

  it('rejects a sales associate belonging to another company', async () => {
    const otherRoleRes = await api(emptyAdminSessionId, '/api/job-titles', { method: 'POST', body: JSON.stringify({ title: 'Sales Associate', isSalesRole: true }) });
    const otherEmpRes = await api(emptyAdminSessionId, '/api/employees', { method: 'POST', body: JSON.stringify({ name: 'Other Co Employee', jobTitleId: otherRoleRes.body.id }) });

    const { status, body } = await api(adminSessionId, `/api/transactions/invoices?companyId=${companyId}`, {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: new Date().toISOString().slice(0, 10), customerId, taxSlabId, bankId, notes: '', status: 'Active',
          items: [{ id: generateId(), description: 'Widget', unitCost: 10, quantity: 1, unit: 'PCE', productId }],
          salesAssociateId: otherEmpRes.body.id,
        },
      }),
    });
    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/i);
  });

  it('rejects a deactivated sales associate', async () => {
    const employeeBId = (globalThis as any).__employeeBId as string;
    await db.update(schema.employees).set({ isActive: false }).where(eq(schema.employees.id, employeeBId));

    const { status, body } = await api(adminSessionId, `/api/transactions/invoices?companyId=${companyId}`, {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: new Date().toISOString().slice(0, 10), customerId, taxSlabId, bankId, notes: '', status: 'Active',
          items: [{ id: generateId(), description: 'Widget', unitCost: 10, quantity: 1, unit: 'PCE', productId }],
          salesAssociateId: employeeBId,
        },
      }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/deactivated/i);

    await db.update(schema.employees).set({ isActive: true }).where(eq(schema.employees.id, employeeBId));
  });

  it('allows an invoice with no sales associate at all', async () => {
    const { status } = await api(adminSessionId, `/api/transactions/invoices?companyId=${companyId}`, {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: new Date().toISOString().slice(0, 10), customerId, taxSlabId, bankId, notes: '', status: 'Active',
          items: [{ id: generateId(), description: 'Widget', unitCost: 10, quantity: 1, unit: 'PCE', productId }],
        },
      }),
    });
    expect(status).toBe(200);
  });
});
