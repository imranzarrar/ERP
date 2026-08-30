import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { processInvoiceZatca } from '../server/lib/zatca/processInvoice.js';

// Regression test for the race between POST /invoices/:id/cancel and the fire-and-forget
// processInvoiceZatca() job (see processInvoice.ts and transactions.ts's cancel route).
// Before the fix, processInvoiceZatca fetched the invoice with a plain (unlocked) SELECT
// and then unconditionally wrote zatcaStatus='SUBMITTING' moments later — if a concurrent
// cancel committed in that gap, the SUBMITTING write (and everything after it: hash-chain
// reservation, a real ZATCA submission) proceeded anyway on an invoice that was already
// Cancelled. The fix makes the SUBMITTING transition itself conditional on the row's
// *current* status (`WHERE status != 'Cancelled'`), checked via Postgres atomically at the
// moment the UPDATE runs — not against a stale in-memory copy.
//
// This test doesn't need to win an actual timing race to prove the fix: setting the
// invoice's status to 'Cancelled' before calling processInvoiceZatca() reproduces exactly
// the DB state a "cancel wins the race" interleaving would have produced. zatcaEnabled is
// true so the guarded code path is actually exercised, but the guard aborts before any
// hash-chain reservation, XML signing, or real network call — no ZATCA sandbox
// credentials are needed for this test to be meaningful.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let userId: string;
let customerId: string;
let taxSlabId: string;
let bankId: string;

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: 'Invoice Cancel Race Test Co', address: 'x', phone: '0',
    email: 'race@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: true, themeId: 'classic-executive',
  });

  const monthId = new Date().toISOString().slice(0, 7);
  await db.insert(schema.fiscalMonths).values({
    id: monthId, name: monthId, status: 'Open', companyId,
  }).onConflictDoNothing();

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  userId = generateId();
  await db.insert(schema.users).values({
    id: userId, username: `race_test_${userId.slice(0, 8)}`, password: passwordHash,
    role: 'admin', companyId, isSuperAdmin: false, uiLanguage: 'en',
  });

  customerId = generateId();
  await db.insert(schema.customers).values({
    id: customerId, name: 'Race Test Customer', phone: '0000000000', email: 'racecustomer@example.com', address: 'x', companyId,
  } as any);

  taxSlabId = generateId();
  await db.insert(schema.taxSlabs).values({
    id: taxSlabId, name: 'Standard 15%', percentage: '15', isDefault: true, companyId,
  } as any);

  bankId = generateId();
  await db.insert(schema.bankAccounts).values({
    id: bankId, bankName: 'Race Test Bank', accountNumber: '000', accountTitle: 'Race Test Co',
    openingBalance: '0', isActive: true, companyId,
  });
});

afterAll(async () => {
  await db.delete(schema.invoices).where(eq(schema.invoices.companyId, companyId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.id, bankId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.id, taxSlabId));
  await db.delete(schema.customers).where(eq(schema.customers.id, customerId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, userId));
  await db.delete(schema.users).where(eq(schema.users.id, userId));
  await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
});

describe('processInvoiceZatca — cancel/submit race guard', () => {
  it('refuses to reserve a hash-chain position or move to SUBMITTING once the invoice is Cancelled', async () => {
    const invoiceId = generateId();
    await db.insert(schema.invoices).values({
      id: invoiceId, invoiceNumber: `INV-RACE-${invoiceId.slice(0, 6)}`,
      date: new Date().toISOString().split('T')[0],
      customerId, taxSlabId, bankId, paymentStatus: 'Unpaid', notes: '',
      // Simulates the exact DB state a concurrent cancel-wins-the-race interleaving
      // would produce: status flipped to Cancelled before the SUBMITTING write runs.
      status: 'Cancelled',
      createdById: userId, createdAt: new Date(), amountPaid: '0', companyId,
      zatcaStatus: 'NOT_SUBMITTED',
    });

    const result = await processInvoiceZatca(invoiceId);

    // Message now also covers a second, related guard (a concurrent SUBMITTING already in
    // flight) added in the same clause — both share this one combined message.
    expect(result.error).toMatch(/cancelled.*submission in flight/i);

    const [row] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
    // The guard must fire before the SUBMITTING write — status stays exactly what it
    // was, never transiently flips to SUBMITTING, and no hash-chain position is claimed.
    expect(row.zatcaStatus).toBe('NOT_SUBMITTED');
    expect(row.icv).toBe(0);
    expect(row.previousInvoiceHash).toBeNull();
  });

  it('a non-cancelled invoice is not blocked by the new guard', async () => {
    const invoiceId = generateId();
    await db.insert(schema.invoices).values({
      id: invoiceId, invoiceNumber: `INV-RACE-${invoiceId.slice(0, 6)}`,
      date: new Date().toISOString().split('T')[0],
      customerId, taxSlabId, bankId, paymentStatus: 'Unpaid', notes: '',
      status: 'Active',
      createdById: userId, createdAt: new Date(), amountPaid: '0', companyId,
      zatcaStatus: 'NOT_SUBMITTED',
    });

    // This throwaway company has no real ZATCA/CSID credentials or complete buyer
    // identity fields configured, so this is expected to be stopped by some *other*,
    // unrelated downstream gate (e.g. incomplete buyer fields, missing signing cert) —
    // the only thing this test asserts is that it is not this change's new guard doing
    // the blocking, proven by the error not being the cancellation-race message.
    const result = await processInvoiceZatca(invoiceId);
    expect(result.error).not.toMatch(/cancelled before ZATCA submission/i);
  });
});
