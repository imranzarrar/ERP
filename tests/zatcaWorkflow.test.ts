import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq, desc, and } from 'drizzle-orm';
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
  await db.delete(schema.zatcaChainState).where(eq(schema.zatcaChainState.companyId, companyId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, companyId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyId));
  await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
  await db.delete(schema.users).where(eq(schema.users.id, userId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyId));
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

    // Unlike Cancel (which flips the original invoice's own status and can legitimately
    // wipe an open-month Receipt), a Credit Note leaves the original invoice's own
    // status/paymentStatus/amountPaid untouched — it really was paid. So the original
    // Receipt must stay on the books, with a genuine Reversal voucher posted alongside it
    // (see postCreditNoteReversalVoucher in businessLogic.ts) — otherwise the invoice would
    // still show "Paid" with no corresponding entry anywhere on the Bank Statement Ledger.
    const vouchersAfter = await db.select().from(schema.vouchers)
      .where(eq(schema.vouchers.referenceId, invId));
    expect(vouchersAfter.some((v) => v.type === 'Receipt')).toBe(true);
    expect(vouchersAfter.some((v) => v.type === 'Reversal')).toBe(true);
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

  it('rejects a second Credit Note against the same invoice', async () => {
    const invId = await createInvoice(0);

    const first = await api(`/api/transactions/invoices/${invId}/note`, {
      method: 'POST',
      body: JSON.stringify({ type: 'CreditNote', reason: 'First credit' }),
    });
    expect(first.status).toBe(200);
    createdInvoiceIds.push(first.body.noteId);

    const second = await api(`/api/transactions/invoices/${invId}/note`, {
      method: 'POST',
      body: JSON.stringify({ type: 'CreditNote', reason: 'Second credit, should be rejected' }),
    });
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/already been issued/i);
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

    // Snapshot the real per-company, per-environment hash-chain state BEFORE enabling —
    // mirrors getNextHashChainState's own zatcaChainState lookup exactly (the source of
    // truth for chain position, not a scan of `invoices`), so this assertion holds
    // regardless of how many other invoices earlier tests in this file already pushed
    // through the real chain, or whether any of them were later cancelled-and-rolled-back.
    const [priorState] = await db.select({
      currentIcv: schema.zatcaChainState.currentIcv,
      currentHash: schema.zatcaChainState.currentHash,
    }).from(schema.zatcaChainState)
      .where(and(eq(schema.zatcaChainState.companyId, companyId), eq(schema.zatcaChainState.environment, 'sandbox')));
    const expectedIcv = (priorState?.currentIcv || 0) + 1;
    const expectedPih = (priorState?.currentIcv && priorState.currentIcv > 0)
      ? priorState.currentHash
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

describe('Resubmission identity: fresh mint vs safe reuse of ICV/UUID/PIH', () => {
  // This throwaway test company never has a Production CSID configured, so every real
  // (non-DISABLED) invoice deterministically lands at NOT_SUBMITTED/ONBOARDING_INCOMPLETE
  // — exactly the "definitively never reached ZATCA's network" condition the resubmission
  // logic checks for, with no network mocking needed to exercise it.
  let completeCustomerId: string;

  beforeAll(async () => {
    completeCustomerId = generateId();
    await db.insert(schema.customers).values({
      id: completeCustomerId,
      name: 'Resubmission Test B2B Customer',
      phone: '0000000000',
      email: 'resubmit-buyer@example.com',
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
    await db.update(schema.companies).set({ zatcaEnabled: true }).where(eq(schema.companies.id, companyId));
  });

  afterAll(async () => {
    await db.update(schema.companies).set({ zatcaEnabled: false }).where(eq(schema.companies.id, companyId));
  });

  async function createCompleteInvoice() {
    const { status, body } = await api('/api/transactions/invoices', {
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
    if (status !== 200) throw new Error(`createCompleteInvoice failed: ${status} ${JSON.stringify(body)}`);
    createdInvoiceIds.push(body.invoiceId);
    await new Promise((r) => setTimeout(r, 500));
    return body.invoiceId as string;
  }

  it('locked IssueTime survives a resubmit even though the document is fully rebuilt', async () => {
    const invId = await createCompleteInvoice();
    const [before] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invId));
    expect(before.zatcaStatus).toBe('NOT_SUBMITTED');
    const issueTimeBefore = before.xmlContent!.match(/<cbc:IssueTime>([^<]+)<\/cbc:IssueTime>/)?.[1];
    expect(issueTimeBefore).toBeTruthy();

    const { status } = await api(`/api/zatca/submit-invoice/${invId}`, { method: 'POST' });
    expect(status).toBe(200);
    const [after] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invId));
    const issueTimeAfter = after.xmlContent!.match(/<cbc:IssueTime>([^<]+)<\/cbc:IssueTime>/)?.[1];
    expect(issueTimeAfter).toBe(issueTimeBefore);
  });

  it('safe reuse: resubmitting a still-chain-tip, never-reached-ZATCA invoice keeps the same icv/uuid/hash', async () => {
    const invId = await createCompleteInvoice();
    const [before] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invId));

    const { status } = await api(`/api/zatca/submit-invoice/${invId}`, { method: 'POST' });
    expect(status).toBe(200);
    const [after] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invId));
    expect(after.icv).toBe(before.icv);
    expect(after.uuid).toBe(before.uuid);
    expect(after.previousInvoiceHash).toBe(before.previousInvoiceHash);
    expect(after.currentInvoiceHash).toBe(before.currentInvoiceHash);
  });

  it('superseded chain tip: resubmitting an earlier invoice after a later one has claimed the tip mints a fresh icv/uuid/pih, and leaves the later invoice untouched', async () => {
    const invA = await createCompleteInvoice();
    const [aBefore] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invA));
    expect(aBefore.zatcaStatus).toBe('NOT_SUBMITTED');

    const invB = await createCompleteInvoice(); // claims the next position, chaining off A's original hash
    const [bRow] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invB));
    expect(bRow.icv).toBe(aBefore.icv! + 1);
    expect(bRow.previousInvoiceHash).toBe(aBefore.currentInvoiceHash);

    // A is no longer the chain tip (B is) — resubmitting it must mint a fresh identity.
    const { status } = await api(`/api/zatca/submit-invoice/${invA}`, { method: 'POST' });
    expect(status).toBe(200);
    const [aAfter] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invA));

    expect(aAfter.icv).toBe(bRow.icv! + 1); // chains after B now, not reusing its original position
    expect(aAfter.previousInvoiceHash).toBe(bRow.currentInvoiceHash);
    expect(aAfter.uuid).not.toBe(aBefore.uuid);
    expect(aAfter.currentInvoiceHash).not.toBe(aBefore.currentInvoiceHash);

    // B's own row must be completely untouched by A's later resubmission — a document's
    // PDH only has to have been correct at its own generation time (Detailed Technical
    // Guidelines FAQ), not kept in sync with a predecessor that's since been superseded.
    const [bAfter] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invB));
    expect(bAfter.icv).toBe(bRow.icv);
    expect(bAfter.previousInvoiceHash).toBe(bRow.previousInvoiceHash);
    expect(bAfter.currentInvoiceHash).toBe(bRow.currentInvoiceHash);

    // The superseded original identity must be captured in the audit log before it's
    // overwritten.
    const [auditRow] = await db.select().from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.entityId, invA), eq(schema.auditLogs.action, 'zatca_chain_identity_superseded')))
      .orderBy(desc(schema.auditLogs.id))
      .limit(1);
    expect(auditRow).toBeTruthy();
    const details = JSON.parse(auditRow!.details!);
    expect(details.oldIcv).toBe(aBefore.icv);
    expect(details.oldUuid).toBe(aBefore.uuid);
  });

  it('resubmitting an already-CLEARED invoice is rejected, no fields change', async () => {
    const invId = await createCompleteInvoice();
    await db.update(schema.invoices).set({ zatcaStatus: 'CLEARED' }).where(eq(schema.invoices.id, invId));
    const [before] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invId));

    const { status, body } = await api(`/api/zatca/submit-invoice/${invId}`, { method: 'POST' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/cleared|Credit Note/i);

    const [after] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invId));
    expect(after.icv).toBe(before.icv);
    expect(after.currentInvoiceHash).toBe(before.currentInvoiceHash);
    expect(after.zatcaStatus).toBe('CLEARED');
  });

  it('cancelling a still-chain-tip, never-reached-ZATCA invoice rolls back the chain position for reuse', async () => {
    const invId = await createCompleteInvoice();
    const [before] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invId));
    expect(before.icv).toBeTruthy();

    const [stateBefore] = await db.select().from(schema.zatcaChainState)
      .where(and(eq(schema.zatcaChainState.companyId, companyId), eq(schema.zatcaChainState.environment, 'sandbox')));
    expect(stateBefore.currentIcv).toBe(before.icv);

    const { status } = await api(`/api/transactions/invoices/${invId}/cancel`, { method: 'POST' });
    expect(status).toBe(200);

    const [stateAfter] = await db.select().from(schema.zatcaChainState)
      .where(and(eq(schema.zatcaChainState.companyId, companyId), eq(schema.zatcaChainState.environment, 'sandbox')));
    expect(stateAfter.currentIcv).toBe(before.icv! - 1);
    expect(stateAfter.currentHash).toBe(before.previousInvoiceHash);

    // The next real invoice legitimately gets the same ICV number back, not wasted.
    const invNext = await createCompleteInvoice();
    const [nextRow] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invNext));
    expect(nextRow.icv).toBe(before.icv);
    expect(nextRow.previousInvoiceHash).toBe(before.previousInvoiceHash);
  });

  it('cancelling a superseded (no-longer-tip) invoice does NOT roll back the chain', async () => {
    const invA = await createCompleteInvoice();
    await createCompleteInvoice(); // supersedes A as the tip

    const [stateBefore] = await db.select().from(schema.zatcaChainState)
      .where(and(eq(schema.zatcaChainState.companyId, companyId), eq(schema.zatcaChainState.environment, 'sandbox')));

    const { status } = await api(`/api/transactions/invoices/${invA}/cancel`, { method: 'POST' });
    expect(status).toBe(200);

    const [stateAfter] = await db.select().from(schema.zatcaChainState)
      .where(and(eq(schema.zatcaChainState.companyId, companyId), eq(schema.zatcaChainState.environment, 'sandbox')));
    expect(stateAfter.currentIcv).toBe(stateBefore.currentIcv);
    expect(stateAfter.currentHash).toBe(stateBefore.currentHash);
  });
});

describe('Per-environment chain isolation', () => {
  it('a brand-new (companyId, environment) pair starts at genesis, independent of an existing Sandbox chain', async () => {
    const { getNextHashChainState, isStillChainTip } = await import('../server/lib/zatca/hashChain.js');

    const sandboxState = await getNextHashChainState(companyId, 'sandbox');
    expect(sandboxState.icv).toBeGreaterThan(1); // this company already has real sandbox history by this point

    const simulationState = await getNextHashChainState(companyId, 'simulation');
    expect(simulationState.icv).toBe(1);
    expect(simulationState.previousInvoiceHash).toBe(INITIAL_PREVIOUS_INVOICE_HASH);
    expect(await isStillChainTip(companyId, 'simulation', 0)).toBe(false);
  });
});

describe('AccountingCustomerParty is always present in the built XML (XSD minOccurs=1)', () => {
  it('emits an empty-but-present element when no buyer is supplied', async () => {
    // Direct unit-level check of the XML builder itself — customerId is NOT NULL on the
    // invoices schema, so an undefined buyer can't actually be produced through the real
    // HTTP invoice-creation route today, but generateZatcaUblXml must still be XSD-valid
    // for any caller (e.g. the compliance test suite) that doesn't supply one.
    const { generateZatcaUblXml } = await import('../server/lib/zatca/xmlBuilder.js');
    const doc = generateZatcaUblXml({
      invoiceNumber: 'TEST-001',
      uuid: generateId(),
      issueDate: '2026-01-01',
      issueTime: '12:00:00',
      invoiceTypeCode: '0200000',
      currency: 'SAR',
      icv: 1,
      previousInvoiceHash: INITIAL_PREVIOUS_INVOICE_HASH,
      seller: { name: 'Test Seller', tin: '399999999900003', street: 'Test St', buildingNumber: '1234', district: 'Test', city: 'Riyadh', postalCode: '12345' },
      items: [{ name: 'Item', quantity: 1, unitPrice: 100, subtotal: 100, vatRate: 15, vatAmount: 15, totalAmount: 115 }],
      subtotal: 100,
      totalVat: 15,
      grandTotal: 115,
      // No `buyer` — this is the exact case being tested.
    });
    expect(doc.xmlContent).toMatch(/<cac:AccountingCustomerParty>\s*<\/cac:AccountingCustomerParty>/);
  });
});
