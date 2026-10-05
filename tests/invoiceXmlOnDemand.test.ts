import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq, like } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { readInvoiceXml } from '../server/lib/zatca/xmlStorage.js';

// The signed ZATCA XML (~17 KB per invoice) no longer rides along on GET /api/state or the
// invoice list — rows carry a `hasXml` flag, and the document itself is fetched on demand
// from GET /api/transactions/invoices/:id/xml. Real HTTP + real Postgres, no mocks, one
// throwaway company (plus a second one for the cross-tenant check), torn down in afterAll.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

interface Tenant { companyId: string; userId: string; sessionId: string; customerId: string; taxSlabId: string; bankId: string }
const tenants: Tenant[] = [];

async function setupTenant(name: string): Promise<Tenant> {
  const companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name, address: 'Test Address', phone: '0000000000', email: 'autotest@example.com',
    logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false,
  });
  const monthId = new Date().toISOString().slice(0, 7);
  await db.insert(schema.fiscalMonths).values({ id: monthId, name: monthId, status: 'Open', companyId }).onConflictDoNothing();
  const taxSlabId = generateId();
  await db.insert(schema.taxSlabs).values({ id: taxSlabId, name: 'Standard 15%', percentage: '15', companyId });
  const customerId = generateId();
  await db.insert(schema.customers).values({ id: customerId, name: 'Test Customer', phone: '0000000000', email: 'c@example.com', address: 'Test Address', companyId, buyerType: 'B2B' });
  const bankId = generateId();
  await db.insert(schema.bankAccounts).values({ id: bankId, bankName: 'Test Bank', accountNumber: '000111222', accountTitle: name, openingBalance: '0', companyId });
  const userId = generateId();
  const username = `autotest_${userId}`;
  await db.insert(schema.users).values({ id: userId, username, password: await bcrypt.hash(TEST_PASSWORD, 10), role: 'admin', companyId, isSuperAdmin: false });
  const loginRes = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });
  const loginBody = await loginRes.json().catch(() => null);
  if (!loginBody?.sessionId) throw new Error(`login failed: ${loginRes.status} ${JSON.stringify(loginBody)}`);
  const t: Tenant = { companyId, userId, sessionId: loginBody.sessionId, customerId, taxSlabId, bankId };
  tenants.push(t);
  return t;
}

function api(t: Tenant, path: string, init: RequestInit = {}) {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-session-id': t.sessionId, ...(init.headers || {}) },
  });
}

async function createInvoice(t: Tenant): Promise<string> {
  const res = await api(t, '/api/transactions/invoices', {
    method: 'POST',
    body: JSON.stringify({
      invoiceData: {
        date: new Date().toISOString().split('T')[0], customerId: t.customerId, taxSlabId: t.taxSlabId, bankId: t.bankId,
        notes: '', status: 'Active', amountPaid: 0,
        items: [{ id: generateId(), description: 'Test Item', unitCost: 100, quantity: 1, discountAmount: 0 }],
      },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 200) throw new Error(`createInvoice failed: ${res.status} ${JSON.stringify(body)}`);
  // processInvoiceZatca runs fire-and-forget after the create response returns.
  await new Promise((r) => setTimeout(r, 600));
  return body.invoiceId as string;
}

let A: Tenant;
let B: Tenant;
let withXmlId: string;
let withoutXmlId: string;

beforeAll(async () => {
  A = await setupTenant('XML On-Demand Test Co A');
  B = await setupTenant('XML On-Demand Test Co B');
  withXmlId = await createInvoice(A);
  withoutXmlId = await createInvoice(A);
  await db.update(schema.invoices).set({ xmlContent: null, xmlContentZ: null }).where(eq(schema.invoices.id, withoutXmlId));
});

afterAll(async () => {
  // Sweep by name prefix as well as by this run's own tenants, so a previously interrupted run
  // can't leave orphans behind. Invoice posting writes ledger rows referencing the user, so
  // those go first.
  const swept = await db.select({ id: schema.companies.id }).from(schema.companies).where(like(schema.companies.name, 'XML On-Demand Test Co%'));
  for (const { id: companyId } of swept) {
    await db.delete(schema.journalLines).where(eq(schema.journalLines.companyId, companyId));
    await db.delete(schema.journalEntries).where(eq(schema.journalEntries.companyId, companyId));
    await db.delete(schema.vouchers).where(eq(schema.vouchers.companyId, companyId));
    const invs = await db.select({ id: schema.invoices.id }).from(schema.invoices).where(eq(schema.invoices.companyId, companyId));
    for (const { id } of invs) await db.delete(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, id));
    await db.delete(schema.invoices).where(eq(schema.invoices.companyId, companyId));
    await db.delete(schema.zatcaChainState).where(eq(schema.zatcaChainState.companyId, companyId));
    await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyId));
    await db.delete(schema.customers).where(eq(schema.customers.companyId, companyId));
    await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyId));
    await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyId));
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
    await db.delete(schema.users).where(eq(schema.users.companyId, companyId));
    await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyId));
    await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
  }
});

describe('Invoice XML is fetched on demand, not shipped in list payloads', () => {
  it('fixture sanity: the DB really holds XML for the first invoice and none for the second', async () => {
    const [a] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, withXmlId));
    expect(readInvoiceXml(a)).toBeTruthy();
    const [b] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, withoutXmlId));
    expect(readInvoiceXml(b)).toBeNull();
  });

  it('GET /api/state invoice rows carry hasXml but never xmlContent (qrCodeContent still present)', async () => {
    const res = await api(A, '/api/state');
    expect(res.status).toBe(200);
    const state = await res.json();
    const withXml = state.invoices.find((i: any) => i.id === withXmlId);
    const withoutXml = state.invoices.find((i: any) => i.id === withoutXmlId);
    expect(withXml).toBeTruthy();
    expect('xmlContent' in withXml).toBe(false);
    expect(withXml.hasXml).toBe(true);
    expect(withXml.qrCodeContent).toBeTruthy();
    expect(withoutXml.hasXml).toBe(false);
    expect(JSON.stringify(state.invoices)).not.toContain('<cbc:');
  });

  it('GET /invoices (plain and paginated) omits xmlContent and sets hasXml', async () => {
    const plain = await (await api(A, '/api/transactions/invoices')).json();
    const rowPlain = plain.find((i: any) => i.id === withXmlId);
    expect('xmlContent' in rowPlain).toBe(false);
    expect(rowPlain.hasXml).toBe(true);
    expect(JSON.stringify(plain)).not.toContain('<cbc:');

    const paged = await (await api(A, '/api/transactions/invoices?page=1&pageSize=50')).json();
    const rowPaged = paged.rows.find((i: any) => i.id === withXmlId);
    expect('xmlContent' in rowPaged).toBe(false);
    expect(rowPaged.hasXml).toBe(true);
    expect(paged.rows.find((i: any) => i.id === withoutXmlId).hasXml).toBe(false);
    // Other fields the list screens rely on are unchanged in shape.
    expect(Array.isArray(rowPaged.items)).toBe(true);
    expect(typeof rowPaged.items[0].unitCost).toBe('number');
  });

  it('GET /invoices/:id/xml returns the exact stored document as text/xml', async () => {
    const res = await api(A, `/api/transactions/invoices/${withXmlId}/xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/xml/);
    const text = await res.text();
    const [row] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, withXmlId));
    expect(text).toBe(readInvoiceXml(row));
  });

  it('returns 404 for an invoice with no XML, and for an unknown id', async () => {
    expect((await api(A, `/api/transactions/invoices/${withoutXmlId}/xml`)).status).toBe(404);
    expect((await api(A, `/api/transactions/invoices/${generateId()}/xml`)).status).toBe(404);
  });

  it("another tenant cannot read this company's XML (404, same as not found)", async () => {
    const res = await api(B, `/api/transactions/invoices/${withXmlId}/xml`);
    expect(res.status).toBe(404);
  });

  it('requires authentication', async () => {
    const res = await fetch(`${BASE_URL}/api/transactions/invoices/${withXmlId}/xml`);
    expect(res.status).toBe(401);
  });
});
