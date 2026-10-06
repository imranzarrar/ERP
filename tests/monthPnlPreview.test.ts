import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { provisionStarterResources } from '../server/lib/companyProvisioning.js';
import { purgeCompany } from './helpers/purgeCompany.js';

// The Close Month dialog shows the month's profit and loss that is about to be archived. That figure comes from the server
// (GET /api/reports/month-pnl, the same function that writes the permanent closedPnL), never from a sum the screen makes itself.
// The rules it must follow, on the paid basis and on the including-pending basis:
//   * revenue is tax-exclusive, expenses are net of recoverable VAT;
//   * a credit note takes revenue back out of the including-pending view always, and out of the paid view only when the invoice
//     it reverses was counted as paid there (a credit note against an unpaid invoice cancels a receivable never collected).
const BASE_URL = 'http://localhost:3000';
const PW = 'AutoTest_Pw_2026!';
const NAME = 'Month PnL Preview Test Co';
const today = new Date().toISOString().slice(0, 10);
const M = today.slice(0, 7);

let companyId = '', sessionId = '', bankId = '', customerId = '', taxSlabId = '', vendorId = '';
async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, ...(init.headers || {}) } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const post = (p: string, b: any) => api(p, { method: 'POST', body: JSON.stringify(b) });
const ok = (r: { status: number; body: any }, what: string) => { if (r.status !== 200) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const pnl = async () => ok(await api(`/api/reports/month-pnl?monthId=${M}`), 'month-pnl');
const invoice = async (price: number, paid: boolean) => ok(await post('/api/transactions/invoices', { invoiceData: {
  date: today, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: paid ? price * 1.15 : 0,
  items: [{ id: generateId(), description: 'Service', unitCost: price, quantity: 1, discountAmount: 0 }],
} }), 'invoice').invoiceId as string;
const creditNote = async (id: string) => ok(await post(`/api/transactions/invoices/${id}/note`, { type: 'CreditNote', reason: 'Test' }), 'credit note');

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: NAME, address: 'x', phone: '0', email: 'mp@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false,
  } as any);
  await db.transaction(async (tx: any) => provisionStarterResources(tx, { companyId, companyName: NAME }));
  const one = async (table: any, col: any) => (await db.select().from(table).where(eq(col, companyId)))[0] as any;
  bankId = (await one(schema.bankAccounts, schema.bankAccounts.companyId)).id;
  customerId = (await one(schema.customers, schema.customers.companyId)).id;
  vendorId = (await one(schema.vendors, schema.vendors.companyId)).id;
  taxSlabId = (await one(schema.taxSlabs, schema.taxSlabs.companyId)).id;
  const userId = generateId();
  const username = `mp_${userId.slice(-10)}`;
  await db.insert(schema.users).values({ id: userId, username, password: await bcrypt.hash(PW, 10), role: 'admin', companyId, isSuperAdmin: false });
  const login = await (await fetch(`${BASE_URL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PW }) })).json();
  sessionId = login.sessionId;
  if (!sessionId) throw new Error('login failed');
  ok(await post('/api/transactions/months', { id: M, name: `Month ${M}`, status: 'Open' }), 'open month');
}, 60000);

afterAll(async () => { await purgeCompany(companyId); }, 60000);

describe('month P&L shown when closing a month', () => {
  it('an unpaid invoice and its credit note cancel out on both bases (no phantom loss on the paid basis)', async () => {
    const id = await invoice(150, false);
    expect((await pnl()).includingPending.revenue).toBe(150);
    expect((await pnl()).paid.revenue).toBe(0);
    await creditNote(id);
    const p = await pnl();
    expect(p.includingPending.revenue).toBe(0);
    expect(p.paid.revenue).toBe(0);
  });

  it('a paid invoice and its credit note cancel out on both bases', async () => {
    const id = await invoice(200, true);
    expect((await pnl()).paid.revenue).toBe(200);
    await creditNote(id);
    const p = await pnl();
    expect(p.includingPending.revenue).toBe(0);
    expect(p.paid.revenue).toBe(0);
  });

  it('revenue excludes VAT, and expenses are net of VAT', async () => {
    await invoice(100, true);
    ok(await post('/api/expenses', { date: today, vendorId, taxSlabId, bankId, status: 'Active', type: 'Actual', billNumber: 'MP-1', description: 'Supplies', paymentStatus: 'Paid', amountPaid: 115, paymentDate: today, amount: 115 }), 'expense');
    const p = await pnl();
    expect(p.paid.revenue).toBe(100);                     // not 115
    expect(p.includingPending.revenue).toBe(100);
    expect(p.paid.expenses).toBe(100);                    // 115 including 15 recoverable VAT
    expect(p.includingPending.net).toBe(0);
  });

  it('is refused for a malformed month', async () => {
    const r = await api('/api/reports/month-pnl?monthId=bad');
    expect(r.status).toBe(400);
  });
});
