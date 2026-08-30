import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server + real Postgres state,
// matching this project's established no-mocks testing practice. Dedicated throwaway
// companies/users, torn down in afterAll — never touches the seeded demo companies.
//
// Covers a real production bug: /api/state used to return every company's data
// unfiltered whenever the caller was a super-admin, and the company a super-admin had
// switched to in the UI was never persisted anywhere the server would actually honor -
// isAuthenticated fell straight back to the user's own home company on every request
// that didn't explicitly repeat `?companyId=`, which was nearly all of them. A
// super-admin whose home company differs from the company they're actively viewing
// would see that company's own data (invoices, dashboard, etc.) as empty, even though
// it existed and was correctly saved. Fixed by: (1) always scoping /api/state's business
// data by req.targetCompanyId regardless of role, (2) resolving req.targetCompanyId from
// the persisted session (req.session.companyId) when no explicit override is passed,
// (3) a new POST /api/switch-company endpoint that persists the selection into the
// session when a super-admin switches companies in the UI.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyAId: string;
let companyBId: string;
let superAdminId: string;
let scopedAdminId: string; // a plain (non-super) admin, home company = A

let invoiceAId: string;
let invoiceBId: string;
let taxSlabAId: string;
let taxSlabBId: string;
let customerAId: string;
let customerBId: string;
let bankAId: string;
let bankBId: string;

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

// x-session-id, not a cookie jar — this repo's session cookie is `secure: true`, which
// real browsers accept for http://localhost (a documented browser-specific exception)
// but bare HTTP clients (curl, Node's fetch, and this test) do not: the server never
// even sends Set-Cookie over a non-TLS connection in that case. x-session-id against the
// user_sessions table is the documented non-cookie auth path every test in this repo
// uses for exactly this reason (see CLAUDE.md and server.ts's isAuthenticated).
async function apiSession(sessionId: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

beforeAll(async () => {
  companyAId = generateId();
  companyBId = generateId();
  await db.insert(schema.companies).values([
    {
      id: companyAId, name: 'CompanyScoping Test Co A', address: 'x', phone: '0',
      email: 'scopetest-a@example.com', logoUrl: '', customHeader: '', customFooter: '',
      currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
    },
    {
      id: companyBId, name: 'CompanyScoping Test Co B', address: 'x', phone: '0',
      email: 'scopetest-b@example.com', logoUrl: '', customHeader: '', customFooter: '',
      currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
    },
  ] as any);

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

  // Super-admin's own HOME company is A - the exact scenario in the real bug report:
  // logged-in user's own companyId differs from the company they actively switch to.
  superAdminId = generateId();
  const superAdminUsername = `scopetest_super_${superAdminId.slice(0, 8)}`;
  await db.insert(schema.users).values({
    id: superAdminId, username: superAdminUsername, password: passwordHash,
    role: 'admin', companyId: companyAId, isSuperAdmin: true, uiLanguage: 'en',
  });

  scopedAdminId = generateId();
  const scopedAdminUsername = `scopetest_admin_${scopedAdminId.slice(0, 8)}`;
  await db.insert(schema.users).values({
    id: scopedAdminId, username: scopedAdminUsername, password: passwordHash,
    role: 'admin', companyId: companyAId, isSuperAdmin: false, uiLanguage: 'en',
  });

  taxSlabAId = generateId();
  taxSlabBId = generateId();
  await db.insert(schema.taxSlabs).values([
    { id: taxSlabAId, name: 'ScopeTest 15% A', percentage: '15', companyId: companyAId, isDefault: false },
    { id: taxSlabBId, name: 'ScopeTest 15% B', percentage: '15', companyId: companyBId, isDefault: false },
  ]);

  customerAId = generateId();
  customerBId = generateId();
  await db.insert(schema.customers).values([
    { id: customerAId, name: 'ScopeTest Customer A', phone: '0500000001', email: 'ca@example.com', address: 'x', companyId: companyAId, buyerType: 'B2C' },
    { id: customerBId, name: 'ScopeTest Customer B', phone: '0500000002', email: 'cb@example.com', address: 'x', companyId: companyBId, buyerType: 'B2C' },
  ]);

  bankAId = generateId();
  bankBId = generateId();
  await db.insert(schema.bankAccounts).values([
    { id: bankAId, bankName: 'ScopeTest Bank A', accountNumber: '1111', accountTitle: 'A', openingBalance: '0', isActive: true, isDefault: true, companyId: companyAId },
    { id: bankBId, bankName: 'ScopeTest Bank B', accountNumber: '2222', accountTitle: 'B', openingBalance: '0', isActive: true, isDefault: true, companyId: companyBId },
  ]);

  invoiceAId = generateId();
  invoiceBId = generateId();
  await db.insert(schema.invoices).values([
    {
      id: invoiceAId, invoiceNumber: 'INV-SCOPE-A', date: '2026-08-01', customerId: customerAId,
      taxSlabId: taxSlabAId, bankId: bankAId, paymentStatus: 'Unpaid', notes: 'x', status: 'Active',
      createdById: scopedAdminId, createdAt: new Date(), companyId: companyAId,
    },
    {
      id: invoiceBId, invoiceNumber: 'INV-SCOPE-B', date: '2026-08-01', customerId: customerBId,
      taxSlabId: taxSlabBId, bankId: bankBId, paymentStatus: 'Unpaid', notes: 'x', status: 'Active',
      createdById: superAdminId, createdAt: new Date(), companyId: companyBId,
    },
  ] as any);
});

afterAll(async () => {
  await db.delete(schema.invoices).where(eq(schema.invoices.id, invoiceAId));
  await db.delete(schema.invoices).where(eq(schema.invoices.id, invoiceBId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, companyAId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, companyBId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyAId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyBId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyAId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyBId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyAId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyBId));
  await db.delete(schema.users).where(eq(schema.users.id, superAdminId));
  await db.delete(schema.users).where(eq(schema.users.id, scopedAdminId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyAId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyBId));
});

describe('The real bug: /api/state must honor the SELECTED company, not silently revert to the caller\'s own home company', () => {
  it('a super-admin whose home company is A sees A\'s data by default (session set at login)', async () => {
    const superAdminUsername = (await db.select().from(schema.users).where(eq(schema.users.id, superAdminId)))[0].username;
    const { sessionId } = await login(superAdminUsername);

    const res = await apiSession(sessionId, '/api/state');
    expect(res.status).toBe(200);
    const invoiceIds = res.body.invoices.map((i: any) => i.id);
    expect(invoiceIds).toContain(invoiceAId);
    expect(invoiceIds).not.toContain(invoiceBId);
  });

  it('switching to company B via POST /api/switch-company persists in the session, and /api/state (no query param) now returns B\'s data instead', async () => {
    const superAdminUsername = (await db.select().from(schema.users).where(eq(schema.users.id, superAdminId)))[0].username;
    const { sessionId } = await login(superAdminUsername);

    const switchRes = await apiSession(sessionId, '/api/switch-company', {
      method: 'POST',
      body: JSON.stringify({ companyId: companyBId }),
    });
    expect(switchRes.status).toBe(200);

    // Deliberately no ?companyId= on this call — the whole point is that the session
    // alone must be enough now, matching every real fetch('/api/state') call site in the
    // actual frontend that doesn't (and shouldn't have to) repeat the selection per-call.
    const res = await apiSession(sessionId, '/api/state');
    expect(res.status).toBe(200);
    const invoiceIds = res.body.invoices.map((i: any) => i.id);
    expect(invoiceIds).toContain(invoiceBId);
    expect(invoiceIds).not.toContain(invoiceAId);
  });

  it('a non-super-admin cannot switch companies', async () => {
    const scopedAdminUsername = (await db.select().from(schema.users).where(eq(schema.users.id, scopedAdminId)))[0].username;
    const { sessionId } = await login(scopedAdminUsername);

    const res = await apiSession(sessionId, '/api/switch-company', {
      method: 'POST',
      body: JSON.stringify({ companyId: companyBId }),
    });
    expect(res.status).toBe(403);
  });

  it('every business array in /api/state is scoped, not just invoices', async () => {
    const superAdminUsername = (await db.select().from(schema.users).where(eq(schema.users.id, superAdminId)))[0].username;
    const { sessionId } = await login(superAdminUsername);
    await apiSession(sessionId, '/api/switch-company', { method: 'POST', body: JSON.stringify({ companyId: companyAId }) });

    const res = await apiSession(sessionId, '/api/state');
    expect(res.status).toBe(200);
    expect(res.body.customers.map((c: any) => c.id)).toContain(customerAId);
    expect(res.body.customers.map((c: any) => c.id)).not.toContain(customerBId);
    expect(res.body.banks.map((b: any) => b.id)).toContain(bankAId);
    expect(res.body.banks.map((b: any) => b.id)).not.toContain(bankBId);
    // companies is the one deliberate exception - the full list is needed to populate
    // the switcher itself.
    expect(res.body.companies.map((c: any) => c.id)).toContain(companyAId);
    expect(res.body.companies.map((c: any) => c.id)).toContain(companyBId);
  });

  it('an explicit ?companyId= query param still overrides the session for a super-admin', async () => {
    const superAdminUsername = (await db.select().from(schema.users).where(eq(schema.users.id, superAdminId)))[0].username;
    const { sessionId } = await login(superAdminUsername);
    await apiSession(sessionId, '/api/switch-company', { method: 'POST', body: JSON.stringify({ companyId: companyAId }) });

    const res = await apiSession(sessionId, `/api/state?companyId=${companyBId}`);
    expect(res.status).toBe(200);
    const invoiceIds = res.body.invoices.map((i: any) => i.id);
    expect(invoiceIds).toContain(invoiceBId);
    expect(invoiceIds).not.toContain(invoiceAId);
  });
});
