import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration test against the already-running dev server + real Postgres, matching
// this project's no-mocks practice. Covers a real production bug in src/db/apiState.ts's
// getFullState(): invoices/quotations/expenses/vouchers/stockLedgerTransactions were each
// capped to the most recent DEFAULT_LIST_LIMIT (500) rows PLATFORM-WIDE, ordered by
// createdAt/date, BEFORE server.ts's /api/state handler filtered the result down to the
// caller's own company. Once combined volume across every tenant on the platform exceeded
// 500 rows in one of these tables, a smaller/older tenant's own rows could silently fall
// out of that global top-N window before their own company filter ever ran — their
// invoices/expenses/vouchers/quotations would vanish from their own dashboard and reports
// with no error. Fixed by scoping each of these 5 queries by companyId before the cap, so
// the "most recent 500" is always 500 per company, never a shared cross-tenant window.
//
// This test exercises the REAL default (DEFAULT_LIST_LIMIT=500), not an artificially
// lowered one — deliberately, so it proves actual production behavior rather than a
// value only ever set for testing. It bulk-inserts enough rows for a "noisy" company to
// exceed 500, all more recently created than a "small" company's own rows, and asserts
// the small company's own /api/state still returns its own data intact.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';
const NOISY_COMPANY_INVOICE_COUNT = 520;

let companySmallId: string;
let companyNoisyId: string;
let smallAdminId: string;
let noisyAdminId: string;

let smallCustomerId: string;
let noisyCustomerId: string;
let smallBankId: string;
let noisyBankId: string;
let smallTaxSlabId: string;
let noisyTaxSlabId: string;

let smallInvoiceId1: string;
let smallInvoiceId2: string;
let noisyInvoiceIds: string[] = [];

async function login(username: string): Promise<{ sessionId: string }> {
  const res = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });
  const body = await res.json().catch(() => null);
  if (!body?.sessionId) throw new Error(`Login failed for ${username}: status ${res.status}, body ${JSON.stringify(body)}`);
  return { sessionId: body.sessionId };
}

async function apiSession(sessionId: string, path: string) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

beforeAll(async () => {
  companySmallId = generateId();
  companyNoisyId = generateId();
  await db.insert(schema.companies).values([
    {
      id: companySmallId, name: 'CapIsolation Test Co Small', address: 'x', phone: '0',
      email: 'capiso-small@example.com', logoUrl: '', customHeader: '', customFooter: '',
      currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
    },
    {
      id: companyNoisyId, name: 'CapIsolation Test Co Noisy', address: 'x', phone: '0',
      email: 'capiso-noisy@example.com', logoUrl: '', customHeader: '', customFooter: '',
      currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
    },
  ] as any);

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

  smallAdminId = generateId();
  await db.insert(schema.users).values({
    id: smallAdminId, username: `capiso_small_${smallAdminId}`, password: passwordHash,
    role: 'admin', companyId: companySmallId, isSuperAdmin: false, uiLanguage: 'en',
  });

  noisyAdminId = generateId();
  await db.insert(schema.users).values({
    id: noisyAdminId, username: `capiso_noisy_${noisyAdminId}`, password: passwordHash,
    role: 'admin', companyId: companyNoisyId, isSuperAdmin: false, uiLanguage: 'en',
  });

  smallTaxSlabId = generateId();
  noisyTaxSlabId = generateId();
  await db.insert(schema.taxSlabs).values([
    { id: smallTaxSlabId, name: 'CapIso 15% Small', percentage: '15', companyId: companySmallId, isDefault: false },
    { id: noisyTaxSlabId, name: 'CapIso 15% Noisy', percentage: '15', companyId: companyNoisyId, isDefault: false },
  ]);

  smallCustomerId = generateId();
  noisyCustomerId = generateId();
  await db.insert(schema.customers).values([
    { id: smallCustomerId, name: 'CapIso Customer Small', phone: '0500000003', email: 'ccs@example.com', address: 'x', companyId: companySmallId, buyerType: 'B2C' },
    { id: noisyCustomerId, name: 'CapIso Customer Noisy', phone: '0500000004', email: 'ccn@example.com', address: 'x', companyId: companyNoisyId, buyerType: 'B2C' },
  ]);

  smallBankId = generateId();
  noisyBankId = generateId();
  await db.insert(schema.bankAccounts).values([
    { id: smallBankId, bankName: 'CapIso Bank Small', accountNumber: '3333', accountTitle: 'S', openingBalance: '0', isActive: true, isDefault: true, companyId: companySmallId },
    { id: noisyBankId, bankName: 'CapIso Bank Noisy', accountNumber: '4444', accountTitle: 'N', openingBalance: '0', isActive: true, isDefault: true, companyId: companyNoisyId },
  ]);

  // The small tenant's own 2 invoices, created well BEFORE the noisy tenant's flood below —
  // exactly the scenario the old global-cap-then-filter code got wrong.
  const olderCreatedAt = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
  smallInvoiceId1 = generateId();
  smallInvoiceId2 = generateId();
  await db.insert(schema.invoices).values([
    {
      id: smallInvoiceId1, invoiceNumber: 'INV-CAPISO-SMALL-1', date: '2026-08-01', customerId: smallCustomerId,
      taxSlabId: smallTaxSlabId, bankId: smallBankId, paymentStatus: 'Unpaid', notes: 'x', status: 'Active',
      createdById: smallAdminId, createdAt: olderCreatedAt, companyId: companySmallId,
    },
    {
      id: smallInvoiceId2, invoiceNumber: 'INV-CAPISO-SMALL-2', date: '2026-08-01', customerId: smallCustomerId,
      taxSlabId: smallTaxSlabId, bankId: smallBankId, paymentStatus: 'Unpaid', notes: 'x', status: 'Active',
      createdById: smallAdminId, createdAt: olderCreatedAt, companyId: companySmallId,
    },
  ] as any);

  // The noisy tenant's flood: more rows than DEFAULT_LIST_LIMIT (500), all created AFTER
  // the small tenant's rows above, so under the old (buggy) code every one of these would
  // rank ahead of the small tenant's 2 invoices in a single global "most recent 500" scan.
  noisyInvoiceIds = Array.from({ length: NOISY_COMPANY_INVOICE_COUNT }, () => generateId());
  const now = new Date();
  await db.insert(schema.invoices).values(
    noisyInvoiceIds.map((id, i) => ({
      id, invoiceNumber: `INV-CAPISO-NOISY-${i}`, date: '2026-08-02', customerId: noisyCustomerId,
      taxSlabId: noisyTaxSlabId, bankId: noisyBankId, paymentStatus: 'Unpaid', notes: 'x', status: 'Active',
      createdById: noisyAdminId, createdAt: now, companyId: companyNoisyId,
    })) as any
  );
}, 60000);

afterAll(async () => {
  await db.delete(schema.invoices).where(eq(schema.invoices.companyId, companySmallId));
  await db.delete(schema.invoices).where(eq(schema.invoices.companyId, companyNoisyId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, companySmallId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, companyNoisyId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companySmallId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyNoisyId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companySmallId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyNoisyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companySmallId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyNoisyId));
  await db.delete(schema.users).where(eq(schema.users.id, smallAdminId));
  await db.delete(schema.users).where(eq(schema.users.id, noisyAdminId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companySmallId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyNoisyId));
}, 60000);

describe('The real bug: /api/state must scope the 500-row cap per company, not across the whole platform', () => {
  it(`a small tenant's own invoices survive even though another tenant has ${NOISY_COMPANY_INVOICE_COUNT} more-recent invoices`, async () => {
    const smallUsername = (await db.select().from(schema.users).where(eq(schema.users.id, smallAdminId)))[0].username;
    const { sessionId } = await login(smallUsername);

    const res = await apiSession(sessionId, '/api/state');
    expect(res.status).toBe(200);
    const invoiceIds = res.body.invoices.map((i: any) => i.id);
    expect(invoiceIds).toContain(smallInvoiceId1);
    expect(invoiceIds).toContain(smallInvoiceId2);
    // Under the pre-fix global-cap-then-filter code, this array would be empty — every
    // one of the noisy tenant's more-recent rows would occupy the shared top-500 window.
    expect(invoiceIds.length).toBe(2);
  });

  it("the noisy tenant's own request never leaks the small tenant's invoices, and stays within its own per-company cap", async () => {
    const noisyUsername = (await db.select().from(schema.users).where(eq(schema.users.id, noisyAdminId)))[0].username;
    const { sessionId } = await login(noisyUsername);

    const res = await apiSession(sessionId, '/api/state');
    expect(res.status).toBe(200);
    const invoiceIds = res.body.invoices.map((i: any) => i.id);
    expect(invoiceIds).not.toContain(smallInvoiceId1);
    expect(invoiceIds).not.toContain(smallInvoiceId2);
    // The noisy tenant itself exceeds 500 rows, so it should be capped to its own most
    // recent 500 — never zero, never more than the global DEFAULT_LIST_LIMIT.
    expect(invoiceIds.length).toBeGreaterThan(0);
    expect(invoiceIds.length).toBeLessThanOrEqual(500);
  });
});
