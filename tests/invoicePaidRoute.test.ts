import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq, and } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server (npm run dev on
// localhost:3000) + real Postgres state, matching this project's established no-mocks
// testing practice (see tests/zatcaWorkflow.test.ts, tests/nonTransactionalSync.test.ts).
// Exercises POST /api/transactions/invoices/:id/paid — the route InvoiceModule's
// "Receive Payment" action was newly wired to (previously it never made a network
// request at all; it only mutated in-memory dbStore state).
//
// All fixtures live under one dedicated throwaway company, torn down in afterAll — this
// never touches the seeded demo companies (e.g. "CNC Woodcraft & Design") used for
// manual QA.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let otherCompanyId: string;
let monthId: string;
let taxSlabId: string;
let customerId: string;
let bankId: string;
let adminUserId: string;
let adminSessionId: string;
let staffUserId: string;
let staffSessionId: string;
// Second company's own fixtures, used only for the tenant-isolation test.
let otherMonthId: string;
let otherTaxSlabId: string;
let otherCustomerId: string;
let otherBankId: string;
let otherAdminUserId: string;
let otherAdminSessionId: string;
const createdInvoiceIds: string[] = [];
const createdOtherInvoiceIds: string[] = [];

async function api(sessionId: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    // The auth middleware accepts x-session-id as a documented non-cookie identity path
    // (server.ts's isAuthenticated) — a real Node fetch client has no cookie jar, so this
    // is the supported way to authenticate a server-side test client, not a workaround.
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

async function createInvoice(amountPaid = 0) {
  const { status, body } = await api(adminSessionId, '/api/transactions/invoices', {
    method: 'POST',
    body: JSON.stringify({
      invoiceData: {
        date: new Date().toISOString().split('T')[0],
        customerId,
        taxSlabId,
        bankId,
        notes: '',
        status: 'Active',
        amountPaid,
        items: [{ id: generateId(), description: 'Test Item', unitCost: 100, quantity: 1, discountAmount: 0 }],
      },
    }),
  });
  if (status !== 200) throw new Error(`createInvoice failed: ${status} ${JSON.stringify(body)}`);
  createdInvoiceIds.push(body.invoiceId);
  return body.invoiceId as string;
}

async function createOtherCompanyInvoice(amountPaid = 0) {
  const { status, body } = await api(otherAdminSessionId, '/api/transactions/invoices', {
    method: 'POST',
    body: JSON.stringify({
      invoiceData: {
        date: new Date().toISOString().split('T')[0],
        customerId: otherCustomerId,
        taxSlabId: otherTaxSlabId,
        bankId: otherBankId,
        notes: '',
        status: 'Active',
        amountPaid,
        items: [{ id: generateId(), description: 'Test Item', unitCost: 100, quantity: 1, discountAmount: 0 }],
      },
    }),
  });
  if (status !== 200) throw new Error(`createOtherCompanyInvoice failed: ${status} ${JSON.stringify(body)}`);
  createdOtherInvoiceIds.push(body.invoiceId);
  return body.invoiceId as string;
}

beforeAll(async () => {
  companyId = generateId();
  otherCompanyId = generateId();
  await db.insert(schema.companies).values([
    {
      id: companyId, name: 'Invoice Paid Test Co', address: 'Test Address', phone: '0000000000',
      email: 'invoicepaidtest@example.com', logoUrl: '', customHeader: '', customFooter: '',
      currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
    },
    {
      id: otherCompanyId, name: 'Invoice Paid Test Co B', address: 'Test Address', phone: '0000000000',
      email: 'invoicepaidtestb@example.com', logoUrl: '', customHeader: '', customFooter: '',
      currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
    },
  ]);

  monthId = new Date().toISOString().slice(0, 7);
  await db.insert(schema.fiscalMonths).values({
    id: monthId, name: monthId, status: 'Open', companyId,
  }).onConflictDoNothing();

  taxSlabId = generateId();
  await db.insert(schema.taxSlabs).values({
    id: taxSlabId, name: 'Standard 15%', percentage: '15', companyId,
  });

  customerId = generateId();
  await db.insert(schema.customers).values({
    id: customerId, name: 'Invoice Paid Test Customer', phone: '0000000000',
    email: 'customer@example.com', address: 'Test Address', companyId, buyerType: 'B2B',
  });

  bankId = generateId();
  await db.insert(schema.bankAccounts).values({
    id: bankId, bankName: 'Test Bank', accountNumber: '000111222',
    accountTitle: 'Invoice Paid Test Co', openingBalance: '0', companyId,
  });

  // Second company's own fixtures, entirely separate from `companyId` above — used only
  // to prove the /paid route's companyId-scoped lookup actually rejects a foreign id
  // rather than merely a nonexistent one.
  otherMonthId = new Date().toISOString().slice(0, 7);
  await db.insert(schema.fiscalMonths).values({
    id: otherMonthId, name: otherMonthId, status: 'Open', companyId: otherCompanyId,
  }).onConflictDoNothing();

  otherTaxSlabId = generateId();
  await db.insert(schema.taxSlabs).values({
    id: otherTaxSlabId, name: 'Standard 15%', percentage: '15', companyId: otherCompanyId,
  });

  otherCustomerId = generateId();
  await db.insert(schema.customers).values({
    id: otherCustomerId, name: 'Other Co Test Customer', phone: '0000000000',
    email: 'othercustomer@example.com', address: 'Test Address', companyId: otherCompanyId, buyerType: 'B2B',
  });

  otherBankId = generateId();
  await db.insert(schema.bankAccounts).values({
    id: otherBankId, bankName: 'Other Test Bank', accountNumber: '000333444',
    accountTitle: 'Invoice Paid Test Co B', openingBalance: '0', companyId: otherCompanyId,
  });

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

  adminUserId = generateId();
  const adminUsername = `paidtest_admin_${adminUserId}`;
  await db.insert(schema.users).values({
    id: adminUserId, username: adminUsername, password: passwordHash,
    role: 'admin', companyId, isSuperAdmin: false, uiLanguage: 'en',
  });

  // A non-admin user with no roles assigned — normalizePermissions denies
  // invoice.create for this shape (see src/types.ts), exercising the route's own
  // 403 gate independently of the admin bypass.
  staffUserId = generateId();
  const staffUsername = `paidtest_staff_${staffUserId}`;
  await db.insert(schema.users).values({
    id: staffUserId, username: staffUsername, password: passwordHash,
    role: 'staff', companyId, isSuperAdmin: false, uiLanguage: 'en',
  });

  otherAdminUserId = generateId();
  const otherAdminUsername = `paidtest_otheradmin_${otherAdminUserId}`;
  await db.insert(schema.users).values({
    id: otherAdminUserId, username: otherAdminUsername, password: passwordHash,
    role: 'admin', companyId: otherCompanyId, isSuperAdmin: false, uiLanguage: 'en',
  });

  adminSessionId = await login(adminUsername);
  staffSessionId = await login(staffUsername);
  otherAdminSessionId = await login(otherAdminUsername);
});

afterAll(async () => {
  for (const invId of createdInvoiceIds) {
    await db.delete(schema.vouchers).where(eq(schema.vouchers.referenceId, invId));
    await db.delete(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, invId));
  }
  for (const invId of createdOtherInvoiceIds) {
    await db.delete(schema.vouchers).where(eq(schema.vouchers.referenceId, invId));
    await db.delete(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, invId));
  }
  await db.delete(schema.invoices).where(eq(schema.invoices.companyId, companyId));
  await db.delete(schema.invoices).where(eq(schema.invoices.companyId, otherCompanyId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, otherCompanyId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, companyId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, otherCompanyId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, otherCompanyId));
  await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyId));
  await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, otherCompanyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, otherCompanyId));
  // Login itself writes an audit_logs row referencing the user, so that must go first.
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, adminUserId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, staffUserId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, otherAdminUserId));
  await db.delete(schema.users).where(eq(schema.users.id, adminUserId));
  await db.delete(schema.users).where(eq(schema.users.id, staffUserId));
  await db.delete(schema.users).where(eq(schema.users.id, otherAdminUserId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, otherCompanyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, otherCompanyId));
});

describe('POST /api/transactions/invoices (creation-time payment)', () => {
  // Regression test for a real bug found live against the "UX test company": creating a
  // new invoice already marked Paid (i.e. invoiceData.amountPaid + a real paymentDate
  // string, exactly what InvoiceModule.tsx's create form sends via
  // `paymentDate: formPaymentStatus === 'Paid' ? formDate : null`) failed with a raw
  // driver error "value.toISOString is not a function". Root cause: the invoices route's
  // `.onConflictDoUpdate({ set: invData })` reused the RAW request object — still holding
  // a string paymentDate — instead of the same Date-converted object passed to `.values()`.
  // Postgres parameter binding serializes every bound value for the whole statement up
  // front (it decides at execute time whether the INSERT or the ON CONFLICT...SET branch
  // applies, but the driver still has to serialize both branches' parameters before
  // sending the query), so the raw string reached the timestamp column's serializer
  // regardless of there being an actual id conflict. The prior test above only ever
  // creates invoices via `createInvoice(amountPaid)`, which never sends `paymentDate` at
  // all — that's exactly why this shipped undetected.
  it('creates a new invoice already marked Paid with a real paymentDate string, without throwing', async () => {
    const today = new Date().toISOString().split('T')[0];
    const { status, body } = await api(adminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: today,
          customerId,
          taxSlabId,
          bankId,
          notes: '',
          status: 'Active',
          amountPaid: 115, // matches the 100 + 15% VAT single line item below
          paymentDate: today,
          items: [{ id: generateId(), description: 'Test Item', unitCost: 100, quantity: 1, discountAmount: 0 }],
        },
      }),
    });

    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    createdInvoiceIds.push(body.invoiceId);

    const [row] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, body.invoiceId));
    expect(row.paymentStatus).toBe('Paid');
    expect(row.paymentDate).toBeTruthy();
  });
});

describe('POST /api/transactions/invoices/:id/paid', () => {
  it('marks an unpaid invoice Paid, sets amountPaid to the computed grand total, and posts a Receipt voucher', async () => {
    const invId = await createInvoice(0);

    const [before] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invId));
    expect(before.paymentStatus).toBe('Unpaid');

    const { status, body } = await api(adminSessionId, `/api/transactions/invoices/${invId}/paid`, {
      method: 'POST',
      body: JSON.stringify({ paymentDate: new Date().toISOString().split('T')[0], bankId, amount: 115 }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [after] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invId));
    expect(after.paymentStatus).toBe('Paid');
    // 100 unit cost * 1 qty = 100 subtotal, + 15% VAT = 115.00 grand total.
    expect(Number(after.amountPaid)).toBeCloseTo(115, 2);

    const [voucher] = await db.select().from(schema.vouchers).where(
      and(eq(schema.vouchers.referenceType, 'Invoice'), eq(schema.vouchers.referenceId, invId), eq(schema.vouchers.type, 'Receipt'))
    );
    expect(voucher).toBeTruthy();
    expect(Number(voucher.amount)).toBeCloseTo(115, 2);
  });

  it('rejects a user without invoice.create permission and leaves the invoice untouched', async () => {
    const invId = await createInvoice(0);

    const { status, body } = await api(staffSessionId, `/api/transactions/invoices/${invId}/paid`, {
      method: 'POST',
      body: JSON.stringify({ paymentDate: new Date().toISOString().split('T')[0], bankId, amount: 115 }),
    });
    expect(status).toBe(403);
    expect(body.error).toBeTruthy();

    const [row] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invId));
    expect(row.paymentStatus).toBe('Unpaid');
  });

  it('returns an error for an invoice belonging to a different company (tenant isolation)', async () => {
    // A real invoice, created in `otherCompanyId` — company A's session must not be able
    // to mark it paid, proving the route's lookup is actually scoped by
    // req.targetCompanyId and not just matching on invoice id.
    const foreignInvoiceId = await createOtherCompanyInvoice(0);

    const { status, body } = await api(adminSessionId, `/api/transactions/invoices/${foreignInvoiceId}/paid`, {
      method: 'POST',
      body: JSON.stringify({ paymentDate: new Date().toISOString().split('T')[0], bankId, amount: 115 }),
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(body.error).toMatch(/not found/i);

    const [row] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, foreignInvoiceId));
    expect(row.paymentStatus).toBe('Unpaid');
  });
});

describe('POST /api/transactions/invoices/:id/paid — partial payments', () => {
  // Regression coverage for BACKLOG item 57: this route previously always settled the
  // full remaining balance and ignored `amount`, which is why InvoiceModule.tsx's
  // "Receive Payment" modal couldn't be wired to it. These tests exercise the extended
  // behavior that modal now actually depends on.
  it('a partial payment leaves the invoice Partially Paid with the correct remaining balance', async () => {
    const invId = await createInvoice(0);

    const { status, body } = await api(adminSessionId, `/api/transactions/invoices/${invId}/paid`, {
      method: 'POST',
      body: JSON.stringify({ paymentDate: new Date().toISOString().split('T')[0], bankId, amount: 50 }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [row] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invId));
    expect(row.paymentStatus).toBe('Partially Paid');
    expect(Number(row.amountPaid)).toBeCloseTo(50, 2);

    const [voucher] = await db.select().from(schema.vouchers).where(
      and(eq(schema.vouchers.referenceType, 'Invoice'), eq(schema.vouchers.referenceId, invId), eq(schema.vouchers.type, 'Receipt'))
    );
    expect(Number(voucher.amount)).toBeCloseTo(50, 2);
  });

  it('a second partial payment posts a second, separate voucher instead of overwriting the first', async () => {
    const invId = await createInvoice(0);

    await api(adminSessionId, `/api/transactions/invoices/${invId}/paid`, {
      method: 'POST',
      body: JSON.stringify({ paymentDate: new Date().toISOString().split('T')[0], bankId, amount: 50 }),
    });
    const { status, body } = await api(adminSessionId, `/api/transactions/invoices/${invId}/paid`, {
      method: 'POST',
      // Grand total is 115 (100 + 15% VAT); 50 already paid, 65 remaining — this second
      // payment exactly completes it.
      body: JSON.stringify({ paymentDate: new Date().toISOString().split('T')[0], bankId, amount: 65 }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [row] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invId));
    expect(row.paymentStatus).toBe('Paid');
    expect(Number(row.amountPaid)).toBeCloseTo(115, 2);

    const vouchers = await db.select().from(schema.vouchers).where(
      and(eq(schema.vouchers.referenceType, 'Invoice'), eq(schema.vouchers.referenceId, invId), eq(schema.vouchers.type, 'Receipt'))
    );
    // The whole point of not reusing syncVoucherForInvoice: two settlements, two vouchers.
    expect(vouchers.length).toBe(2);
    const amounts = vouchers.map(v => Number(v.amount)).sort((a, b) => a - b);
    expect(amounts[0]).toBeCloseTo(50, 2);
    expect(amounts[1]).toBeCloseTo(65, 2);
  });

  it('rejects a payment amount that exceeds the remaining balance', async () => {
    const invId = await createInvoice(0);

    const { status, body } = await api(adminSessionId, `/api/transactions/invoices/${invId}/paid`, {
      method: 'POST',
      body: JSON.stringify({ paymentDate: new Date().toISOString().split('T')[0], bankId, amount: 500 }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/exceeds the remaining balance/i);

    const [row] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invId));
    expect(row.paymentStatus).toBe('Unpaid');
  });

  it('rejects a zero or negative payment amount', async () => {
    const invId = await createInvoice(0);

    const { status, body } = await api(adminSessionId, `/api/transactions/invoices/${invId}/paid`, {
      method: 'POST',
      body: JSON.stringify({ paymentDate: new Date().toISOString().split('T')[0], bankId, amount: 0 }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/greater than zero/i);
  });

  it('rejects paying an invoice that is already fully paid', async () => {
    const invId = await createInvoice(0);
    await api(adminSessionId, `/api/transactions/invoices/${invId}/paid`, {
      method: 'POST',
      body: JSON.stringify({ paymentDate: new Date().toISOString().split('T')[0], bankId, amount: 115 }),
    });

    const { status, body } = await api(adminSessionId, `/api/transactions/invoices/${invId}/paid`, {
      method: 'POST',
      body: JSON.stringify({ paymentDate: new Date().toISOString().split('T')[0], bankId, amount: 10 }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/already fully paid/i);
  });

  it('rejects paying a cancelled invoice', async () => {
    const invId = await createInvoice(0);
    await api(adminSessionId, `/api/transactions/invoices/${invId}/cancel`, { method: 'POST' });

    const { status, body } = await api(adminSessionId, `/api/transactions/invoices/${invId}/paid`, {
      method: 'POST',
      body: JSON.stringify({ paymentDate: new Date().toISOString().split('T')[0], bankId, amount: 50 }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/cancelled/i);
  });

  // Regression test: cancelling a paid invoice used to hard-delete its Receipt voucher
  // outright whenever the voucher's own month was still open (treating the correction as
  // "never happened"), only posting a Reversal voucher once that month was closed. This
  // silently erased the ledger trail for the single most common real-world case (cancel
  // something the same day/month it was paid). Fixed to always post a Reversal, never
  // delete — see businessLogic.ts's syncVoucherForInvoice.
  it('posts a Reversal voucher (never deletes the Receipt) when cancelling a paid invoice in the still-open current month', async () => {
    const invId = await createInvoice(115);
    const [receiptBefore] = await db.select().from(schema.vouchers).where(and(
      eq(schema.vouchers.referenceId, invId),
      eq(schema.vouchers.type, 'Receipt')
    ));
    expect(receiptBefore).toBeTruthy();
    expect(receiptBefore.date.slice(0, 7)).toBe(monthId);

    const { status } = await api(adminSessionId, `/api/transactions/invoices/${invId}/cancel`, { method: 'POST' });
    expect(status).toBe(200);

    // The original Receipt must still exist — never hard-deleted.
    const [receiptAfter] = await db.select().from(schema.vouchers).where(eq(schema.vouchers.id, receiptBefore.id));
    expect(receiptAfter).toBeTruthy();

    // A genuine, equal-and-opposite Reversal voucher must have been posted alongside it.
    const [reversal] = await db.select().from(schema.vouchers).where(and(
      eq(schema.vouchers.referenceId, invId),
      eq(schema.vouchers.type, 'Reversal')
    ));
    expect(reversal).toBeTruthy();
    expect(Number(reversal.amount)).toBe(Number(receiptBefore.amount));
  });

  // Regression test: a Credit Note (created via POST /invoices/:id/note, same `invoices`
  // table, documentType: 'CreditNote') was reachable through this exact route with no
  // documentType check at all — it reduces the original invoice's balance, it is not a
  // receivable of its own, so "paying" it is meaningless. Found live against a real CN.
  it('rejects paying a Credit Note', async () => {
    const invId = await createInvoice(0);
    const { status: noteStatus, body: noteBody } = await api(adminSessionId, `/api/transactions/invoices/${invId}/note`, {
      method: 'POST',
      body: JSON.stringify({ type: 'CreditNote', reason: 'Test credit note for payment-guard regression' }),
    });
    expect(noteStatus).toBe(200);
    const creditNoteId = noteBody.noteId as string;
    createdInvoiceIds.push(creditNoteId);

    const { status, body } = await api(adminSessionId, `/api/transactions/invoices/${creditNoteId}/paid`, {
      method: 'POST',
      body: JSON.stringify({ paymentDate: new Date().toISOString().split('T')[0], bankId, amount: 50 }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/credit note/i);

    const [row] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, creditNoteId));
    expect(row.paymentStatus).toBe('Unpaid');
  });
});
