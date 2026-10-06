import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { provisionStarterResources } from '../server/lib/companyProvisioning.js';
import { purgeCompany } from './helpers/purgeCompany.js';

// A Balance Sheet "as at" an earlier date has to show what was still OWED then. Receivables and payables used to be built from
// each document's CURRENT paid status, so anything collected, paid or settled AFTER the as-of date vanished from it, and the
// sheet stopped balancing for every past date as soon as the next period had any payments in it.
//   previous month P:  a service invoice (230, unpaid), an expense (115, unpaid), an accrual (230 estimate, owed at its net 200)
//   this month (today): the invoice is collected, the expense is paid, the accrual is settled by its real invoice (230, paid)
const BASE_URL = 'http://localhost:3000';
const PW = 'AutoTest_Pw_2026!';
const NAME = 'Balance Sheet As-At Test Co';
const now = new Date();
const today = now.toISOString().slice(0, 10);
const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
const P = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
const pDay = (d: number) => `${P}-${String(d).padStart(2, '0')}`;
const pEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10);

let companyId = '', sessionId = '', bankId = '', vendorId = '', customerId = '', taxSlabId = '', serviceId = '';
async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, ...(init.headers || {}) } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const post = (p: string, b: any) => api(p, { method: 'POST', body: JSON.stringify(b) });
const ok = (r: { status: number; body: any }, what: string) => { if (r.status !== 200) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const bsAt = async (d: string) => (await api(`/api/reports/balance-sheet?asOfDate=${d}`)).body;
const tbAt = async (d: string) => (await api(`/api/reports/trial-balance?startDate=${P}-01&endDate=${d}`)).body;
const near = (a: number, b: number) => Math.abs(a - b) < 0.011;

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: NAME, address: 'x', phone: '0', email: 'as@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false,
  } as any);
  await db.transaction(async (tx: any) => provisionStarterResources(tx, { companyId, companyName: NAME }));
  const one = async (table: any, col: any) => (await db.select().from(table).where(eq(col, companyId)))[0] as any;
  bankId = (await one(schema.bankAccounts, schema.bankAccounts.companyId)).id;
  vendorId = (await one(schema.vendors, schema.vendors.companyId)).id;
  customerId = (await one(schema.customers, schema.customers.companyId)).id;
  taxSlabId = (await one(schema.taxSlabs, schema.taxSlabs.companyId)).id;
  serviceId = generateId();
  await db.insert(schema.productsServices).values({ id: serviceId, name: 'AsAt Service', description: 'AsAt Service', unitPrice: '200', costPrice: '0', itemKind: 'service', companyId } as any);
  const userId = generateId();
  const username = `as_${userId.slice(-10)}`;
  await db.insert(schema.users).values({ id: userId, username, password: await bcrypt.hash(PW, 10), role: 'admin', companyId, isSuperAdmin: false });
  const login = await (await fetch(`${BASE_URL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PW }) })).json();
  sessionId = login.sessionId;
  if (!sessionId) throw new Error('login failed');
  ok(await post('/api/transactions/months', { id: P, name: `Month ${P}`, status: 'Open' }), 'open previous month');
}, 60000);

afterAll(async () => { await purgeCompany(companyId); }, 60000);

describe('Balance Sheet / Trial Balance as at a past date', () => {
  it('documents of the previous month, then their payments in this month', async () => {
    const invoiceId = ok(await post('/api/transactions/invoices', { invoiceData: {
      date: pDay(10), customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0,
      items: [{ id: generateId(), description: 'Service', unitCost: 200, quantity: 1, discountAmount: 0, productId: serviceId }],
    } }), 'invoice').invoiceId;
    ok(await post('/api/expenses', { date: pDay(12), vendorId, taxSlabId, bankId, status: 'Active', type: 'Actual', billNumber: 'AS-1', description: 'Prev month opex', paymentStatus: 'Unpaid', amount: 115 }), 'expense');
    const tpl = ok(await post('/api/transactions/recurring-templates', { description: 'Utilities', defaultAmount: 230, bankId, vendorId, taxSlabId, isActive: true }), 'template');
    ok(await post('/api/transactions/recurring-postings', { templateId: tpl.id, monthId: P, postType: 'Accrual', amount: 230, dateStr: pDay(20), paymentStatus: 'Unpaid', bankId }), 'accrual');

    // ---- this month: everything gets settled
    ok(await post(`/api/transactions/invoices/${invoiceId}/paid`, { paymentDate: today, bankId, amount: 230 }), 'collect');
    const rows = await db.select().from(schema.expenses).where(eq(schema.expenses.companyId, companyId)) as any[];
    const opex = rows.find(e => e.description === 'Prev month opex');
    ok(await post(`/api/expenses/${opex.id}/pay`, { date: today, bankId, amount: 115 }), 'pay expense');
    const accrual = rows.find(e => e.type === 'Accrual');
    ok(await post('/api/transactions/settle-accrual', { accrualExpenseId: accrual.id, actualAmount: 230, actualDate: today, paymentStatus: 'Paid', bankId }), 'settle');
  });

  it('as at the end of the previous month: still owed 230 by the customer, 315 to suppliers (115 + the accrual at its net 200)', async () => {
    const bs = await bsAt(pEnd);
    expect(bs.accountsReceivable).toBe(230);
    expect(bs.accountsPayable).toBe(315);
    expect(bs.vatInputRecoverable).toBe(15);        // only the real expense invoice, never the accrual
    expect(bs.vatOutputPayable).toBe(30);
    expect(bs.bankBalance).toBe(0);                  // nothing had been paid or collected yet
    expect(near(bs.balanceCheck, 0)).toBe(true);
    const tb = await tbAt(pEnd);
    expect(near(tb.totalDebits, tb.totalCredits)).toBe(true);
  });

  it('as at today: everything collected, paid and settled, and it still balances', async () => {
    const bs = await bsAt(today);
    expect(bs.accountsReceivable).toBe(0);
    expect(bs.accountsPayable).toBe(0);
    expect(bs.vatInputRecoverable).toBe(45);        // 15 + the settling invoice's 30
    expect(bs.bankBalance).toBe(-115);               // +230 collected -115 -230 paid
    expect(near(bs.balanceCheck, 0)).toBe(true);
    const tb = await tbAt(today);
    expect(near(tb.totalDebits, tb.totalCredits)).toBe(true);
  });
});
