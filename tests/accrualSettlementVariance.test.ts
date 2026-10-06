import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { provisionStarterResources } from '../server/lib/companyProvisioning.js';
import { purgeCompany } from './helpers/purgeCompany.js';

// An accrual is an estimate; the supplier's real invoice that settles it can be for a different amount. The settlement is
// "only the payment" of the accrued cost, EXCEPT for the difference — that difference is a real cost (or saving) which has to
// reach the profit, otherwise the cash and the input VAT move while the P&L does not and the Balance Sheet is out by exactly
// that net amount. The dashboard's Net Profit must also agree with the P&L when accruals are unsettled.
const BASE_URL = 'http://localhost:3000';
const PW = 'AutoTest_Pw_2026!';
const NAME = 'Accrual Settlement Variance Test Co';
const now = new Date();
const today = now.toISOString().slice(0, 10);
const CUR = today.slice(0, 7);

let companyId = '', sessionId = '', bankId = '', vendorId = '', taxSlabId = '';

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, ...(init.headers || {}) } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const post = (p: string, b: any) => api(p, { method: 'POST', body: JSON.stringify(b) });
const ok = (r: { status: number; body: any }, what: string) => { if (r.status !== 200) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const rep = async (name: string, q: string) => (await api(`/api/reports/${name}?${q}`)).body;
const near = (a: number, b: number) => Math.abs(a - b) < 0.011;

async function accrue(description: string, amount: number): Promise<string> {
  const tpl = ok(await post('/api/transactions/recurring-templates', { description, defaultAmount: amount, bankId, vendorId, taxSlabId, isActive: true }), 'template');
  ok(await post('/api/transactions/recurring-postings', { templateId: tpl.id, monthId: CUR, postType: 'Accrual', amount, dateStr: today, paymentStatus: 'Unpaid', bankId }), 'accrue');
  const rows = await db.select().from(schema.expenses).where(eq(schema.expenses.companyId, companyId)) as any[];
  return rows.find(e => e.type === 'Accrual' && Number(e.amount) === amount && !e.accrualSettled)!.id;   // each accrual below has its own amount
}
const settle = async (accrualId: string, amount: number) =>
  ok(await post('/api/transactions/settle-accrual', { accrualExpenseId: accrualId, actualAmount: amount, actualDate: today, paymentStatus: 'Paid', bankId }), 'settle');

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: NAME, address: 'x', phone: '0', email: 'av@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false,
  } as any);
  await db.transaction(async (tx: any) => provisionStarterResources(tx, { companyId, companyName: NAME }));
  const one = async (table: any, col: any) => (await db.select().from(table).where(eq(col, companyId)))[0] as any;
  bankId = (await one(schema.bankAccounts, schema.bankAccounts.companyId)).id;
  vendorId = (await one(schema.vendors, schema.vendors.companyId)).id;
  taxSlabId = (await one(schema.taxSlabs, schema.taxSlabs.companyId)).id;
  const userId = generateId();
  const username = `av_${userId.slice(-10)}`;
  await db.insert(schema.users).values({ id: userId, username, password: await bcrypt.hash(PW, 10), role: 'admin', companyId, isSuperAdmin: false });
  const login = await (await fetch(`${BASE_URL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PW }) })).json();
  sessionId = login.sessionId;
  if (!sessionId) throw new Error('login failed');
}, 60000);

afterAll(async () => { await purgeCompany(companyId); }, 60000);

describe('settling an accrual for a different amount', () => {
  it('a settlement for MORE than accrued adds the difference, one for LESS takes it off, an unsettled accrual still counts', async () => {
    const a1 = await accrue('Utilities', 230);      // net 200
    const a2 = await accrue('Insurance', 345);      // net 300
    await accrue('Maintenance', 115);               // net 100, left unsettled
    await settle(a1, 345);                          // supplier charged 345 (net 300): +100 over the accrual
    await settle(a2, 230);                          // supplier charged 230 (net 200): -100 under the accrual

    // accrued 200 + 300 + 100, settlements add +100 and -100 => 600 net cost
    const pl = await rep('profit-loss', `startDate=${CUR}-01&endDate=${today}&basis=Accrual`);
    expect(pl.totalExpenses).toBe(600);
    expect(pl.netProfit).toBe(-600);

    // paid 345 + 230 = 575; owed 115 (the unsettled accrual)
    const bs = await rep('balance-sheet', `asOfDate=${today}`);
    expect(bs.bankBalance).toBe(-575);
    expect(bs.accountsPayable).toBe(115);
    expect(bs.currentPeriodEarnings).toBe(-600);
    expect(near(bs.balanceCheck, 0)).toBe(true);

    const tb = await rep('trial-balance', `startDate=${CUR}-01&endDate=${today}`);
    expect(near(tb.totalDebits, tb.totalCredits)).toBe(true);

    // the dashboard's Net Profit is the same figure as the P&L
    const dash = await rep('dashboard-summary', `startDate=${CUR}-01&endDate=${today}`);
    expect(dash.netProfit).toBe(-600);
  });
});
