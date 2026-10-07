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

describe('create routes only create', () => {
  const invoiceBody = (extra: any = {}, itemId = generateId()) => ({ invoiceData: {
    date: today, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0, ...extra,
    items: [{ id: itemId, description: 'Service', unitCost: 100, quantity: 1, discountAmount: 0 }],
  } });
  const invoiceCount = async () => (await db.select().from(schema.invoices).where(eq(schema.invoices.companyId, companyId))).length;
  const expenseCount = async () => (await db.select().from(schema.expenses).where(eq(schema.expenses.companyId, companyId))).length;

  it('an invoice request naming any id (existing or new) is refused, and nothing is changed or created', async () => {
    const created = await post('/api/transactions/invoices', invoiceBody());
    expect(created.status).toBe(200);
    const id = created.body.invoiceId as string;
    const before = (await db.select().from(schema.invoices).where(eq(schema.invoices.id, id)))[0] as any;
    const n = await invoiceCount();

    const overwrite = await post('/api/transactions/invoices', invoiceBody({ id, date: '2020-01-15', notes: 'edited', amountPaid: 115 }));
    expect(overwrite.status).toBe(400);
    expect(overwrite.body.error).toMatch(/id cannot be supplied/i);
    const chosen = await post('/api/transactions/invoices', invoiceBody({ id: generateId() }));
    expect(chosen.status).toBe(400);

    const after = (await db.select().from(schema.invoices).where(eq(schema.invoices.id, id)))[0] as any;
    expect(after.date).toBe(before.date);
    expect(after.notes).toBe(before.notes);
    expect(after.amountPaid).toBe(before.amountPaid);
    expect(await invoiceCount()).toBe(n);
  });

  it('a new invoice cannot take over the line items of an existing one by reusing their ids', async () => {
    const a = await post('/api/transactions/invoices', invoiceBody());
    const aItems = await db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, a.body.invoiceId));
    expect(aItems.length).toBe(1);
    const b = await post('/api/transactions/invoices', invoiceBody({}, aItems[0].id));
    expect(b.status).toBe(200);
    const aAfter = await db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, a.body.invoiceId));
    expect(aAfter.length).toBe(1);
    expect(aAfter[0].id).toBe(aItems[0].id);
    const bItems = await db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, b.body.invoiceId));
    expect(bItems.length).toBe(1);
    expect(bItems[0].id).not.toBe(aItems[0].id);
  });

  it('an expense request naming any id is refused, and nothing is changed or created', async () => {
    const vendorId = (await db.select().from(schema.vendors).where(eq(schema.vendors.companyId, companyId)))[0].id;
    const body = (extra: any = {}) => ({ date: today, vendorId, taxSlabId, bankId, status: 'Active', type: 'Actual', billNumber: 'NB-1', description: 'Original', paymentStatus: 'Unpaid', amount: 115, ...extra });
    expect((await post('/api/expenses', body())).status).toBe(200);
    const row = (await db.select().from(schema.expenses).where(eq(schema.expenses.companyId, companyId))).find((e: any) => e.description === 'Original') as any;
    const n = await expenseCount();

    const overwrite = await post('/api/expenses', body({ id: row.id, description: 'Edited', amount: 999, date: '2020-01-15' }));
    expect(overwrite.status).toBe(400);
    expect(overwrite.body.error).toMatch(/id cannot be supplied/i);
    expect((await post('/api/expenses', body({ id: generateId() }))).status).toBe(400);

    const after = (await db.select().from(schema.expenses).where(eq(schema.expenses.id, row.id)))[0] as any;
    expect(after.description).toBe('Original');
    expect(Number(after.amount)).toBe(115);
    expect(after.date).toBe(row.date);
    expect(await expenseCount()).toBe(n);
  });
});
