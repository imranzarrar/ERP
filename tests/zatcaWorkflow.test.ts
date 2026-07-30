import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq, desc } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { INITIAL_PREVIOUS_INVOICE_HASH } from '../server/lib/zatca/hashChain.js';

// Real integration tests against the already-running dev server (npm run dev on
// localhost:3000), matching how every ZATCA fix this session was actually verified —
// real HTTP requests and real DB state, not mocks. All fixtures are created under one
// dedicated throwaway company and torn down in afterAll, so this never touches the
// seeded demo companies (CNC Woodcraft & Design, etc.) used for manual QA.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let userId: string;
let customerId: string;
let taxSlabId: string;
let bankId: string;
let sessionId: string;
const createdInvoiceIds: string[] = [];

async function api(path: string, init: RequestInit = {}) {
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

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId,
    name: 'Automated Test Co',
    address: 'Test Address',
    phone: '0000000000',
    email: 'autotest@example.com',
    logoUrl: '',
    customHeader: '',
    customFooter: '',
    currency: 'SAR',
    counters: {},
    zatcaEnabled: false,
  });

  const monthId = new Date().toISOString().slice(0, 7);
  await db.insert(schema.fiscalMonths).values({
    id: monthId,
    name: monthId,
    status: 'Open',
    companyId,
  }).onConflictDoNothing();

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
    name: 'Automated Test Customer',
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
    accountTitle: 'Automated Test Co',
    openingBalance: '0',
    companyId,
  });

  userId = generateId();
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  const username = `autotest_${userId.slice(0, 8)}`;
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
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
});

async function createInvoice(amountPaid = 0) {
  const { status, body } = await api('/api/transactions/invoices', {
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

describe('ZATCA enable/disable flag', () => {
  it('a company with zatcaEnabled=false never attempts real ZATCA submission — invoice lands as DISABLED', async () => {
    const invId = await createInvoice();
    // processInvoiceZatca runs fire-and-forget after the create response returns.
    await new Promise((r) => setTimeout(r, 500));
    const { status, body } = await api(`/api/zatca/submit-invoice/${invId}`, { method: 'POST' });
    if (status !== 200) throw new Error(`submit-invoice failed: ${status} ${JSON.stringify(body)}`);
    expect(body.status).toBe('DISABLED');

    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invId));
    expect(invoice.zatcaStatus).toBe('DISABLED');
  });

  it('enabling zatcaEnabled lets the same invoice proceed past the DISABLED gate', async () => {
    await db.update(schema.companies).set({ zatcaEnabled: true }).where(eq(schema.companies.id, companyId));
    const invId = await createInvoice();
    await new Promise((r) => setTimeout(r, 500));

    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invId));
    // No CSID is configured for this throwaway company, so it correctly stops at
    // NOT_SUBMITTED (onboarding incomplete) rather than DISABLED — proving the gate is
    // specifically the zatcaEnabled flag, not just "nothing ever gets past NOT_SUBMITTED".
    expect(invoice.zatcaStatus).not.toBe('DISABLED');

    await db.update(schema.companies).set({ zatcaEnabled: false }).where(eq(schema.companies.id, companyId));
  });
});

describe('Cancel Invoice — only if not submitted to ZATCA', () => {
  it('blocks cancellation once zatcaStatus is CLEARED', async () => {
    const invId = await createInvoice();
    // The invoice's own fire-and-forget processInvoiceZatca job (company has
    // zatcaEnabled=false here) settles to DISABLED shortly after creation — wait for it
    // to finish before overriding, or it would race and clobber our manual override.
    await new Promise((r) => setTimeout(r, 500));
    await db.update(schema.invoices).set({ zatcaStatus: 'CLEARED' }).where(eq(schema.invoices.id, invId));

    const { status, body } = await api(`/api/transactions/invoices/${invId}/cancel`, { method: 'POST' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/Credit Note/i);

    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invId));
    expect(invoice.status).not.toBe('Cancelled');
  });

  it('blocks cancellation while SUBMITTING (mid-flight)', async () => {
    const invId = await createInvoice();
    await new Promise((r) => setTimeout(r, 500));
    await db.update(schema.invoices).set({ zatcaStatus: 'SUBMITTING' }).where(eq(schema.invoices.id, invId));

    const { status } = await api(`/api/transactions/invoices/${invId}/cancel`, { method: 'POST' });
    expect(status).toBe(400);
  });

  it('allows cancellation when ZATCA never accepted the invoice (NOT_SUBMITTED)', async () => {
    const invId = await createInvoice();
    await new Promise((r) => setTimeout(r, 500));
    await db.update(schema.invoices).set({ zatcaStatus: 'NOT_SUBMITTED' }).where(eq(schema.invoices.id, invId));

    const { status, body } = await api(`/api/transactions/invoices/${invId}/cancel`, { method: 'POST' });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invId));
    expect(invoice.status).toBe('Cancelled');
  });
});

describe('Credit Note reversal voucher', () => {
  it('reverses the Receipt voucher when the original invoice was paid and the note is a Credit Note', async () => {
    const invId = await createInvoice();
    const payRes = await api(`/api/transactions/invoices/${invId}/paid`, { method: 'POST' });
    expect(payRes.status).toBe(200);

    const receiptsBefore = await db.select().from(schema.vouchers)
      .where(eq(schema.vouchers.referenceId, invId));
    expect(receiptsBefore.some((v) => v.type === 'Receipt')).toBe(true);

    const { status, body } = await api(`/api/transactions/invoices/${invId}/note`, {
      method: 'POST',
      body: JSON.stringify({ type: 'CreditNote', reason: 'Automated test reversal' }),
    });
    if (status !== 200) throw new Error(`note creation failed: ${status} ${JSON.stringify(body)}`);
    createdInvoiceIds.push(body.noteId);

    // Fiscal month is open in this test fixture, so syncVoucherForInvoice's reversal
    // branch deletes the original Receipt outright rather than posting a dated Reversal
    // voucher (that branch is exercised manually via the existing invoice-cancellation
    // dual-gate QA process, which already covers the closed-month path).
    const vouchersAfter = await db.select().from(schema.vouchers)
      .where(eq(schema.vouchers.referenceId, invId));
    expect(vouchersAfter.some((v) => v.type === 'Receipt')).toBe(false);
  });

  it('does not touch vouchers for an unpaid original invoice', async () => {
    const invId = await createInvoice(0);
    const { status, body } = await api(`/api/transactions/invoices/${invId}/note`, {
      method: 'POST',
      body: JSON.stringify({ type: 'CreditNote', reason: 'Automated test, no payment' }),
    });
    expect(status).toBe(200);
    createdInvoiceIds.push(body.noteId);

    const vouchers = await db.select().from(schema.vouchers).where(eq(schema.vouchers.referenceId, invId));
    expect(vouchers.length).toBe(0);
  });
});

describe('QR code generated even when ZATCA is disabled (Phase 1 compliance preview)', () => {
  it('a DISABLED-company invoice gets a real non-null Phase-1 QR immediately, without touching the real hash chain; enabling + resubmitting then reserves a genuine chain position', async () => {
    // Uses a dedicated, ZATCA-complete B2B customer (not the shared `customerId`
    // fixture, which deliberately has no VAT/address on file and would fail
    // validateBuyerFields on the real resubmission below before ever reaching the
    // hash-chain reservation code this test needs to exercise).
    const completeCustomerId = generateId();
    await db.insert(schema.customers).values({
      id: completeCustomerId,
      name: 'ZATCA-Complete B2B Customer',
      phone: '0000000000',
      email: 'complete-buyer@example.com',
      address: 'Test Address',
      companyId,
      buyerType: 'B2B',
      vatNumber: '399999999900003',
      streetName: 'King Abdulaziz Rd',
      buildingNumber: '7890',
      district: 'Al Olaya',
      city: 'Riyadh',
      postalCode: '11564',
    });

    const { status: createStatus, body: createBody } = await api('/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: new Date().toISOString().split('T')[0],
          customerId: completeCustomerId,
          taxSlabId,
          bankId,
          notes: '',
          status: 'Active',
          amountPaid: 0,
          items: [{ id: generateId(), description: 'Test Item', unitCost: 100, quantity: 1, discountAmount: 0 }],
        },
      }),
    });
    if (createStatus !== 200) throw new Error(`createInvoice failed: ${createStatus} ${JSON.stringify(createBody)}`);
    const invId = createBody.invoiceId as string;
    createdInvoiceIds.push(invId);
    // processInvoiceZatca runs fire-and-forget after the create response returns.
    await new Promise((r) => setTimeout(r, 500));

    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invId));
    expect(invoice.zatcaStatus).toBe('DISABLED');
    expect(invoice.qrCodeContent).toBeTruthy();
    expect(typeof invoice.qrCodeContent).toBe('string');
    expect(invoice.qrCodeContent!.length).toBeGreaterThan(0);
    expect(invoice.xmlContent).toBeTruthy();

    // Critical constraint: the DISABLED-path preview must NEVER reserve/persist a
    // real hash-chain position — icv/previousInvoiceHash must stay unset (null/0) so
    // a later real resubmission (once the company enables ZATCA) reserves a genuine
    // chain position instead of wrongly believing one was already claimed and
    // reusing a bogus placeholder, which would corrupt the real genesis-linked chain
    // for every invoice after it.
    expect(invoice.icv).toBeFalsy();
    expect(invoice.previousInvoiceHash).toBeFalsy();

    // Decode the base64 TLV QR and walk tags 1-5 — seller name, VAT/TIN, timestamp,
    // grand total, VAT total — the mandatory ZATCA Phase 1 QR fields, required on
    // every KSA VAT invoice regardless of e-invoicing/Phase 2 enrollment.
    const decoded = Buffer.from(invoice.qrCodeContent!, 'base64');
    const tlvTags: Record<number, string> = {};
    let offset = 0;
    while (offset < decoded.length) {
      const tag = decoded[offset];
      const len = decoded[offset + 1];
      tlvTags[tag] = decoded.subarray(offset + 2, offset + 2 + len).toString('utf8');
      offset += 2 + len;
    }
    expect(tlvTags[1]).toBe('Automated Test Co'); // seller name
    expect(tlvTags[2]).toBeTruthy(); // seller VAT/TIN
    expect(tlvTags[3]).toBeTruthy(); // ISO timestamp
    expect(Number(tlvTags[4])).toBeCloseTo(115, 1); // grand total: 100 + 15% VAT
    expect(Number(tlvTags[5])).toBeCloseTo(15, 1); // VAT total

    // Snapshot the real per-company hash-chain state BEFORE enabling — mirrors
    // getNextHashChainState's own "last invoice by icv desc" query exactly, so this
    // assertion holds regardless of how many other invoices earlier tests in this
    // file already pushed through the real chain.
    const [priorLast] = await db.select({
      icv: schema.invoices.icv,
      currentInvoiceHash: schema.invoices.currentInvoiceHash,
    }).from(schema.invoices)
      .where(eq(schema.invoices.companyId, companyId))
      .orderBy(desc(schema.invoices.icv))
      .limit(1);
    const expectedIcv = (priorLast?.icv || 0) + 1;
    const expectedPih = (priorLast?.icv && priorLast.icv > 0)
      ? priorLast.currentInvoiceHash
      : INITIAL_PREVIOUS_INVOICE_HASH;

    // Enable ZATCA and resubmit the SAME invoice — it must go through the REAL
    // getNextHashChainState reservation path, not reuse anything from the
    // DISABLED-path preview above.
    await db.update(schema.companies).set({ zatcaEnabled: true }).where(eq(schema.companies.id, companyId));
    const { status, body } = await api(`/api/zatca/submit-invoice/${invId}`, { method: 'POST' });
    if (status !== 200) throw new Error(`submit-invoice failed: ${status} ${JSON.stringify(body)}`);
    expect(body.status).not.toBe('DISABLED');

    const [resubmitted] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invId));
    expect(resubmitted.icv).toBe(expectedIcv);
    expect(resubmitted.previousInvoiceHash).toBe(expectedPih);
    expect(resubmitted.currentInvoiceHash).toBeTruthy();
    expect(resubmitted.qrCodeContent).toBeTruthy();

    await db.update(schema.companies).set({ zatcaEnabled: false }).where(eq(schema.companies.id, companyId));
  });
});
