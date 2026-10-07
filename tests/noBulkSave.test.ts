import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { provisionStarterResources } from '../server/lib/companyProvisioning.js';
import { purgeCompany } from './helpers/purgeCompany.js';

// There is no bulk-save endpoint. The old POST /api/migrate overwrote posted documents row by row with whatever the caller held, with no
// closed-month or VAT-quarter rule, so a stale copy or an old backup could change a locked period. A posted document can only change through
// its own route, which applies those rules.
const BASE_URL = 'http://localhost:3000';
const PW = 'AutoTest_Pw_2026!';
const NAME = 'No Bulk Save Test Co';
const today = new Date().toISOString().slice(0, 10);

let companyId = '', sessionId = '', bankId = '', customerId = '', taxSlabId = '';
async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, ...(init.headers || {}) } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const post = (p: string, b: any) => api(p, { method: 'POST', body: JSON.stringify(b) });

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: NAME, address: 'x', phone: '0', email: 'nb@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false,
  } as any);
  await db.transaction(async (tx: any) => provisionStarterResources(tx, { companyId, companyName: NAME }));
  const one = async (table: any, col: any) => (await db.select().from(table).where(eq(col, companyId)))[0] as any;
  bankId = (await one(schema.bankAccounts, schema.bankAccounts.companyId)).id;
  customerId = (await one(schema.customers, schema.customers.companyId)).id;
  taxSlabId = (await one(schema.taxSlabs, schema.taxSlabs.companyId)).id;
  const userId = generateId();
  const username = `nb_${userId.slice(-10)}`;
  await db.insert(schema.users).values({ id: userId, username, password: await bcrypt.hash(PW, 10), role: 'admin', companyId, isSuperAdmin: false });
  const login = await (await fetch(`${BASE_URL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PW }) })).json();
  sessionId = login.sessionId;
  if (!sessionId) throw new Error('login failed');
  const created = await post('/api/transactions/months', { id: today.slice(0, 7), name: `Month ${today.slice(0, 7)}`, status: 'Open' });
  if (created.status !== 200) throw new Error('open month failed: ' + JSON.stringify(created.body));
}, 60000);

afterAll(async () => { await purgeCompany(companyId); }, 60000);

describe('no bulk save', () => {
  it('POST /api/migrate is not served, and a posted invoice sent through it stays exactly as it was', async () => {
    const created = await post('/api/transactions/invoices', { invoiceData: {
      date: today, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0,
      items: [{ id: generateId(), description: 'Service', unitCost: 100, quantity: 1, discountAmount: 0 }],
    } });
    expect(created.status).toBe(200);
    const id = created.body.invoiceId as string;
    const before = (await db.select().from(schema.invoices).where(eq(schema.invoices.id, id)))[0] as any;

    const res = await post('/api/migrate', { invoices: [{ ...before, amountPaid: '115', paymentStatus: 'Paid', date: '2020-01-15', status: 'Active', createdAt: new Date().toISOString(), items: [] }] });
    expect(res.status).not.toBe(200);

    const after = (await db.select().from(schema.invoices).where(eq(schema.invoices.id, id)))[0] as any;
    expect(after.date).toBe(before.date);
    expect(after.paymentStatus).toBe(before.paymentStatus);
    expect(after.amountPaid).toBe(before.amountPaid);
  });
});
