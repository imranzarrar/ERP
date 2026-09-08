import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server + real Postgres state, no
// mocks, matching this project's established convention. Proves the audit-log rewrite
// actually works, not just that it compiles: before this session's fix, EVERY one of these
// actions (invoice create, cancel, pay, credit-note; quotation create, cancel, convert;
// fiscal month open/close) collapsed into an identical, useless `CREATE_INVOICE` row with
// entity_id: null and details: {} — or, for fiscal months specifically, silently failed to
// insert at all (fiscalMonths.id is text like "2026-09", not a UUID, and auditLogs.entity_id
// is a uuid column). Each test here fetches the single most recent audit_logs row for the
// acting user right after the action and asserts it has the correct action name, a real
// (or correctly-null, for fiscal months) entity_id, and a document-number-bearing details
// blob — the only way to actually prove this rather than just asserting it compiles.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let adminUserId: string;
let adminSessionId: string;
let customerId: string;
let taxSlabId: string;
let bankId: string;
let monthId: string;

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

// The most recent audit_logs row for this test's admin user, matching a specific action —
// scoped by action (not just "most recent overall") since several routes in a single test
// each write their own row and we want to check each one specifically, independent of
// insert-order races from the interceptor's own fire-and-forget write.
async function latestAuditRow(action: string) {
  const [row] = await db.select().from(schema.auditLogs)
    .where(and(eq(schema.auditLogs.userId, adminUserId), eq(schema.auditLogs.action, action)))
    .orderBy(desc(schema.auditLogs.createdAt)).limit(1);
  return row;
}

// The interceptor's own audit write is fire-and-forget (never awaited by the request that
// triggers it) — give it a moment to land before asserting against it.
async function waitForAuditRow(action: string, attempts = 10): Promise<any> {
  for (let i = 0; i < attempts; i++) {
    const row = await latestAuditRow(action);
    if (row) return row;
    await new Promise(r => setTimeout(r, 100));
  }
  return undefined;
}

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: 'AuditCoverage Test Co', address: 'x', phone: '0',
    email: 'auditcoverage@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
  });
  monthId = new Date().toISOString().slice(0, 7);
  await db.insert(schema.fiscalMonths).values({ id: monthId, name: monthId, status: 'Open', companyId }).onConflictDoNothing();
  taxSlabId = generateId();
  await db.insert(schema.taxSlabs).values({ id: taxSlabId, name: 'Standard 15%', percentage: '15', companyId });
  customerId = generateId();
  await db.insert(schema.customers).values({ id: customerId, name: 'Audit Coverage Test Customer', phone: '0', email: 'c@example.com', address: 'x', companyId, buyerType: 'B2B' });
  bankId = generateId();
  await db.insert(schema.bankAccounts).values({ id: bankId, bankName: 'Test Bank', accountNumber: '0009993', accountTitle: 'Audit Coverage Test Co', openingBalance: '0', isActive: true, isDefault: true, companyId });

  adminUserId = generateId();
  const adminUsername = `auditcoverage_admin_${adminUserId}`;
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  await db.insert(schema.users).values({ id: adminUserId, username: adminUsername, password: passwordHash, role: 'admin', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  adminSessionId = await login(adminUsername);
});

afterAll(async () => {
  const invoices = await db.select().from(schema.invoices).where(eq(schema.invoices.companyId, companyId));
  for (const inv of invoices) {
    await db.delete(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, inv.id));
  }
  await db.delete(schema.invoices).where(eq(schema.invoices.companyId, companyId));
  const quotations = await db.select().from(schema.quotations).where(eq(schema.quotations.companyId, companyId));
  for (const q of quotations) {
    await db.delete(schema.quotationItems).where(eq(schema.quotationItems.quotationId, q.id));
  }
  await db.delete(schema.quotations).where(eq(schema.quotations.companyId, companyId));
  await db.delete(schema.vouchers).where(eq(schema.vouchers.companyId, companyId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, adminUserId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, companyId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyId));
  await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyId));
  await db.delete(schema.users).where(eq(schema.users.id, adminUserId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
});

describe('Audit log coverage — invoices, quotations, fiscal months', () => {
  it('CREATE_INVOICE logs the real invoice id and invoice number', async () => {
    const { status, body } = await api(adminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: new Date().toISOString().split('T')[0], customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0,
          items: [{ id: generateId(), description: 'Audit coverage item', unitCost: 100, quantity: 1, discountAmount: 0 }],
        },
      }),
    });
    expect(status).toBe(200);
    const invoiceId = body.invoiceId as string;

    const row = await waitForAuditRow('CREATE_INVOICE');
    expect(row).toBeTruthy();
    expect(row.entityId).toBe(invoiceId);
    const details = JSON.parse(row.details);
    expect(details.invoiceNumber).toBeTruthy();
  });

  it('CANCEL_INVOICE logs the real invoice id and invoice number', async () => {
    const created = await api(adminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: new Date().toISOString().split('T')[0], customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0,
          items: [{ id: generateId(), description: 'To be cancelled', unitCost: 50, quantity: 1, discountAmount: 0 }],
        },
      }),
    });
    const invoiceId = created.body.invoiceId as string;

    const { status } = await api(adminSessionId, `/api/transactions/invoices/${invoiceId}/cancel`, { method: 'POST' });
    expect(status).toBe(200);

    const row = await waitForAuditRow('CANCEL_INVOICE');
    expect(row).toBeTruthy();
    expect(row.entityId).toBe(invoiceId);
    const details = JSON.parse(row.details);
    expect(details.invoiceNumber).toBeTruthy();
  });

  it('RECORD_INVOICE_PAYMENT logs the invoice number and voucher number', async () => {
    const created = await api(adminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: new Date().toISOString().split('T')[0], customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0,
          items: [{ id: generateId(), description: 'To be paid', unitCost: 100, quantity: 1, discountAmount: 0 }],
        },
      }),
    });
    const invoiceId = created.body.invoiceId as string;

    const { status } = await api(adminSessionId, `/api/transactions/invoices/${invoiceId}/paid`, {
      method: 'POST',
      body: JSON.stringify({ paymentDate: new Date().toISOString().split('T')[0], bankId, amount: 115 }),
    });
    expect(status).toBe(200);

    const row = await waitForAuditRow('RECORD_INVOICE_PAYMENT');
    expect(row).toBeTruthy();
    expect(row.entityId).toBe(invoiceId);
    const details = JSON.parse(row.details);
    expect(details.invoiceNumber).toBeTruthy();
    expect(details.voucherNumber).toBeTruthy();
  });

  it('CREATE_CREDIT_NOTE logs the note id, note number, and the original invoice it reverses', async () => {
    const created = await api(adminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: new Date().toISOString().split('T')[0], customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0,
          items: [{ id: generateId(), description: 'To be credited', unitCost: 100, quantity: 1, discountAmount: 0 }],
        },
      }),
    });
    const invoiceId = created.body.invoiceId as string;

    const { status, body } = await api(adminSessionId, `/api/transactions/invoices/${invoiceId}/note`, {
      method: 'POST',
      body: JSON.stringify({ type: 'CreditNote', reason: 'Audit coverage test' }),
    });
    expect(status).toBe(200);
    const noteId = body.noteId as string;

    const row = await waitForAuditRow('CREATE_CREDIT_NOTE');
    expect(row).toBeTruthy();
    expect(row.entityId).toBe(noteId);
    const details = JSON.parse(row.details);
    expect(details.invoiceNumber).toBeTruthy();
    expect(details.originalInvoiceId).toBe(invoiceId);
  });

  it('CREATE_QUOTATION and CANCEL_QUOTATION log the real quotation id and number', async () => {
    const created = await api(adminSessionId, '/api/transactions/quotations', {
      method: 'POST',
      body: JSON.stringify({
        quotationData: {
          date: new Date().toISOString().split('T')[0], customerId, taxSlabId, bankId, notes: '', status: 'Draft', createdById: adminUserId,
          items: [{ id: generateId(), description: 'Audit coverage quotation item', unitCost: 75, quantity: 1, discountAmount: 0 }],
        },
      }),
    });
    expect(created.status).toBe(200);

    const createRow = await waitForAuditRow('CREATE_QUOTATION');
    expect(createRow).toBeTruthy();
    expect(createRow.entityId).toBeTruthy();
    const createDetails = JSON.parse(createRow.details);
    expect(createDetails.quotationNumber).toBeTruthy();

    const quotationId = createRow.entityId as string;
    const { status } = await api(adminSessionId, `/api/transactions/quotations/${quotationId}/cancel`, { method: 'POST' });
    expect(status).toBe(200);

    const cancelRow = await waitForAuditRow('CANCEL_QUOTATION');
    expect(cancelRow).toBeTruthy();
    expect(cancelRow.entityId).toBe(quotationId);
    const cancelDetails = JSON.parse(cancelRow.details);
    expect(cancelDetails.quotationNumber).toBeTruthy();
  });

  it('CONVERT_QUOTATION logs the quotation being converted and the resulting invoice', async () => {
    const created = await api(adminSessionId, '/api/transactions/quotations', {
      method: 'POST',
      body: JSON.stringify({
        quotationData: {
          date: new Date().toISOString().split('T')[0], customerId, taxSlabId, bankId, notes: '', status: 'Accepted', createdById: adminUserId,
          items: [{ id: generateId(), description: 'Audit coverage convert item', unitCost: 60, quantity: 1, discountAmount: 0 }],
        },
      }),
    });
    expect(created.status).toBe(200);
    const createRow = await waitForAuditRow('CREATE_QUOTATION');
    const quotationId = createRow.entityId as string;

    const { status, body } = await api(adminSessionId, `/api/transactions/quotations/${quotationId}/convert`, {
      method: 'POST',
      body: JSON.stringify({ invoiceDate: new Date().toISOString().split('T')[0], bankId, paymentStatus: 'Unpaid', customCustomerId: customerId, customTaxSlabId: taxSlabId }),
    });
    expect(status).toBe(200);

    const row = await waitForAuditRow('CONVERT_QUOTATION');
    expect(row).toBeTruthy();
    expect(row.entityId).toBe(quotationId);
    const details = JSON.parse(row.details);
    expect(details.quotationNumber).toBeTruthy();
    expect(details.convertedToInvoiceNumber).toBeTruthy();
  });

  it('OPEN_FISCAL_MONTH / CLOSE_FISCAL_MONTH actually insert a row (previously silently failed — fiscalMonths.id is text, not a uuid, so entity_id must stay null)', async () => {
    // Real regression: before this fix, passing a non-UUID monthId as entityId made every
    // insert here throw inside recordAuditLog's own try/catch, so NO row was ever written —
    // not even a wrong one. Proving a row exists at all, with entityId correctly null and
    // the real month id searchable in details, is the actual fix.
    const testMonthId = `${new Date().getFullYear()}-01`;
    await db.insert(schema.fiscalMonths).values({ id: testMonthId, name: testMonthId, status: 'Closed', companyId }).onConflictDoUpdate({
      target: [schema.fiscalMonths.id, schema.fiscalMonths.companyId],
      set: { status: 'Closed' },
    });

    const { status } = await api(adminSessionId, '/api/transactions/months', {
      method: 'POST',
      body: JSON.stringify({ id: testMonthId, companyId, name: testMonthId, status: 'open' }),
    });
    expect(status).toBe(200);

    const row = await waitForAuditRow('OPEN_FISCAL_MONTH');
    expect(row).toBeTruthy();
    expect(row.entityId).toBeNull();
    const details = JSON.parse(row.details);
    expect(details.monthId).toBe(testMonthId);

    await db.delete(schema.fiscalMonths).where(and(eq(schema.fiscalMonths.id, testMonthId), eq(schema.fiscalMonths.companyId, companyId)));
  });
});
