import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server (npm run dev on
// localhost:3000) — real HTTP requests and real DB state, no mocks, matching the pattern
// in tests/zatcaWorkflow.test.ts. All fixtures live under one dedicated throwaway company,
// torn down in afterAll; this never touches the seeded demo companies used for manual QA.
//
// Covers the relaxed fiscal-month rule: multiple months may be open concurrently per
// company (cap of 3), but only the chronologically oldest currently-open month may be
// closed at any time. Both rules are enforced ONLY in POST /api/transactions/months
// (server/routes/transactions.ts) — this test hits that route directly, not the
// client-side src/dbStore.ts helpers (which deliberately do not re-implement the rule;
// see the comments on closeMonth/openNewMonth there and BACKLOG.md item 35).
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let userId: string;
let customerId: string;
let taxSlabId: string;
let bankId: string;
let sessionId: string;
const createdInvoiceIds: string[] = [];

// Deliberately past months so they can never collide with "today" or be rejected by the
// future-dated-transaction guard in server/lib/businessLogic.ts's validateTransactionDate.
const MONTH_1 = '2020-01';
const MONTH_2 = '2020-02';
const MONTH_3 = '2020-03';
const MONTH_4 = '2020-04';
const MONTH_NAMES: Record<string, string> = {
  [MONTH_1]: 'January 2020',
  [MONTH_2]: 'February 2020',
  [MONTH_3]: 'March 2020',
  [MONTH_4]: 'April 2020',
};

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    // x-session-id is the documented non-cookie auth path (server.ts's isAuthenticated),
    // used here because a plain Node fetch client has no cookie jar.
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function openMonth(monthId: string) {
  return api('/api/transactions/months', {
    method: 'POST',
    body: JSON.stringify({ id: monthId, name: MONTH_NAMES[monthId], status: 'Open' }),
  });
}

async function closeMonth(monthId: string) {
  return api('/api/transactions/months', {
    method: 'POST',
    body: JSON.stringify({ id: monthId, name: MONTH_NAMES[monthId], status: 'Closed', closedOption: 'paid_only' }),
  });
}

// A transaction dated within an open fiscal month, exercising the same
// validateTransactionDate() call server/routes/transactions.ts uses for every
// invoice/quotation/expense — using the invoice route here (mirrors tests/zatcaWorkflow.test.ts's
// createInvoice helper, which is proven to work end-to-end including invoiceNumber/createdById
// generation, unlike a hand-built expense payload which would need those supplied manually).
async function createInvoice(dateStr: string) {
  const { status, body } = await api('/api/transactions/invoices', {
    method: 'POST',
    body: JSON.stringify({
      invoiceData: {
        date: dateStr,
        customerId,
        taxSlabId,
        bankId,
        notes: '',
        status: 'Active',
        amountPaid: 0,
        items: [{ id: generateId(), description: 'Test Item', unitCost: 100, quantity: 1, discountAmount: 0 }],
      },
    }),
  });
  if (status === 200 && body.invoiceId) createdInvoiceIds.push(body.invoiceId);
  return { status, body };
}

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId,
    name: 'Multi-Month Test Co',
    address: 'Test Address',
    phone: '0000000000',
    email: 'multimonth-autotest@example.com',
    logoUrl: '',
    customHeader: '',
    customFooter: '',
    currency: 'SAR',
    counters: {},
    zatcaEnabled: false,
  });

  taxSlabId = generateId();
  await db.insert(schema.taxSlabs).values({
    id: taxSlabId,
    name: 'Standard 15%',
    percentage: '15',
    companyId,
  });

  customerId = generateId();
  await db.insert(schema.customers).values({
    id: customerId,
    name: 'Multi-Month Test Customer',
    phone: '0000000000',
    email: 'customer@example.com',
    address: 'Test Address',
    companyId,
    buyerType: 'B2B',
  });

  bankId = generateId();
  await db.insert(schema.bankAccounts).values({
    id: bankId,
    bankName: 'Test Bank',
    accountNumber: '000111222',
    accountTitle: 'Multi-Month Test Co',
    openingBalance: '0',
    companyId,
  });

  userId = generateId();
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  const username = `mmtest_${userId.slice(0, 8)}`;
  await db.insert(schema.users).values({
    id: userId,
    username,
    password: passwordHash,
    role: 'admin',
    companyId,
    isSuperAdmin: true,
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
  for (const invId of createdInvoiceIds) {
    await db.delete(schema.vouchers).where(eq(schema.vouchers.referenceId, invId));
    await db.delete(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, invId));
  }
  await db.delete(schema.invoices).where(eq(schema.invoices.companyId, companyId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, companyId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyId));
  await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
  await db.delete(schema.users).where(eq(schema.users.id, userId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
});

describe('Multiple concurrently-open fiscal months (cap of 3, close oldest-first)', () => {
  it('allows opening a 1st, 2nd, and 3rd month concurrently', async () => {
    const r1 = await openMonth(MONTH_1);
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);

    const r2 = await openMonth(MONTH_2);
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);

    const r3 = await openMonth(MONTH_3);
    expect(r3.status, JSON.stringify(r3.body)).toBe(200);

    const rows = await db.select().from(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyId));
    const openIds = rows.filter(m => m.status === 'Open').map(m => m.id).sort();
    expect(openIds).toEqual([MONTH_1, MONTH_2, MONTH_3]);
  });

  it('rejects opening a 4th month while 3 are already open (cap of 3)', async () => {
    const r4 = await openMonth(MONTH_4);
    expect(r4.status).toBe(400);
    expect(r4.body.error).toMatch(/maximum of 3/i);

    // fiscalMonths' primary key is composite (id, companyId) — the same literal month id
    // can legitimately exist for other companies, so this must filter on both, not just id.
    const [row] = await db.select().from(schema.fiscalMonths).where(and(eq(schema.fiscalMonths.id, MONTH_4), eq(schema.fiscalMonths.companyId, companyId)));
    expect(row).toBeUndefined();
  });

  it('rejects closing a newer open month while an older one in the same company is still open', async () => {
    const rClose2 = await closeMonth(MONTH_2);
    expect(rClose2.status).toBe(400);
    expect(rClose2.body.error).toMatch(/oldest open month/i);
    expect(rClose2.body.error).toMatch(new RegExp(MONTH_1));

    const rClose3 = await closeMonth(MONTH_3);
    expect(rClose3.status).toBe(400);
    expect(rClose3.body.error).toMatch(/oldest open month/i);

    const [m2] = await db.select().from(schema.fiscalMonths).where(and(eq(schema.fiscalMonths.id, MONTH_2), eq(schema.fiscalMonths.companyId, companyId)));
    const [m3] = await db.select().from(schema.fiscalMonths).where(and(eq(schema.fiscalMonths.id, MONTH_3), eq(schema.fiscalMonths.companyId, companyId)));
    expect(m2.status).toBe('Open');
    expect(m3.status).toBe('Open');
  });

  it('a transaction dated in either of two simultaneously-open months is accepted', async () => {
    // MONTH_2 and MONTH_3 are both still open at this point.
    const invInMonth2 = await createInvoice(`${MONTH_2}-10`);
    expect(invInMonth2.status, JSON.stringify(invInMonth2.body)).toBe(200);

    const invInMonth3 = await createInvoice(`${MONTH_3}-10`);
    expect(invInMonth3.status, JSON.stringify(invInMonth3.body)).toBe(200);
  });

  it('rejects a transaction dated in a month that is not open at all', async () => {
    const invOutside = await createInvoice('2019-05-10');
    expect(invOutside.status).toBe(400);
    expect(invOutside.body.error).toMatch(/does not fall within any defined fiscal month/i);
  });

  it('allows closing the oldest open month', async () => {
    const rClose1 = await closeMonth(MONTH_1);
    expect(rClose1.status, JSON.stringify(rClose1.body)).toBe(200);

    const [m1] = await db.select().from(schema.fiscalMonths).where(and(eq(schema.fiscalMonths.id, MONTH_1), eq(schema.fiscalMonths.companyId, companyId)));
    expect(m1.status).toBe('Closed');
  });

  it('after closing the old oldest, the next-oldest still-open month becomes the only closable one', async () => {
    // MONTH_1 is now closed; MONTH_2 is the new oldest open month, MONTH_3 is newer.
    const rClose3 = await closeMonth(MONTH_3);
    expect(rClose3.status).toBe(400);
    expect(rClose3.body.error).toMatch(new RegExp(MONTH_2));

    const rClose2 = await closeMonth(MONTH_2);
    expect(rClose2.status, JSON.stringify(rClose2.body)).toBe(200);

    // Now only MONTH_3 remains open — with the cap freed up, a new month can be opened again.
    const rOpen4 = await openMonth(MONTH_4);
    expect(rOpen4.status, JSON.stringify(rOpen4.body)).toBe(200);
  });
});
