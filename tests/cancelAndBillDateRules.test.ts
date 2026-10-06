import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { provisionStarterResources } from '../server/lib/companyProvisioning.js';
import { purgeCompany } from './helpers/purgeCompany.js';

// Two period rules, so that nothing a user does today can change a closed month:
//   * cancelling an expense posts its reversal on the day it is cancelled (never back into an earlier period), and an expense
//     whose own month is already closed cannot be cancelled at all (it would drop out of that month's figures);
//   * a purchase bill carries a mandatory date (the supplier's invoice date), validated like every other dated document, and a
//     payment cannot predate the bill.
const BASE_URL = 'http://localhost:3000';
const PW = 'AutoTest_Pw_2026!';
const NAME = 'Cancel And Bill Date Test Co';
const now = new Date();
const today = now.toISOString().slice(0, 10);
const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
const P = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
const pDay = (d: number) => `${P}-${String(d).padStart(2, '0')}`;

let companyId = '', sessionId = '', bankId = '', vendorId = '', taxSlabId = '', warehouseId = '', productId = '';
async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, ...(init.headers || {}) } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const post = (p: string, b: any) => api(p, { method: 'POST', body: JSON.stringify(b) });
const ok = (r: { status: number; body: any }, what: string) => { if (r.status !== 200) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const rep = async (name: string, q: string) => (await api(`/api/reports/${name}?${q}`)).body;
const entries = async () => await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.companyId, companyId)) as any[];

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: NAME, address: 'x', phone: '0', email: 'cb@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false,
  } as any);
  await db.transaction(async (tx: any) => provisionStarterResources(tx, { companyId, companyName: NAME }));
  const one = async (table: any, col: any) => (await db.select().from(table).where(eq(col, companyId)))[0] as any;
  bankId = (await one(schema.bankAccounts, schema.bankAccounts.companyId)).id;
  vendorId = (await one(schema.vendors, schema.vendors.companyId)).id;
  taxSlabId = (await one(schema.taxSlabs, schema.taxSlabs.companyId)).id;
  warehouseId = (await one(schema.warehouses, schema.warehouses.companyId)).id;
  productId = generateId();
  await db.insert(schema.productsServices).values({ id: productId, name: 'Rule Item', description: 'Rule Item', unitPrice: '50', costPrice: '20', itemKind: 'item', companyId, averageCost: '0', totalQuantityPurchased: '0' } as any);
  const userId = generateId();
  const username = `cb_${userId.slice(-10)}`;
  await db.insert(schema.users).values({ id: userId, username, password: await bcrypt.hash(PW, 10), role: 'admin', companyId, isSuperAdmin: false });
  const login = await (await fetch(`${BASE_URL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PW }) })).json();
  sessionId = login.sessionId;
  if (!sessionId) throw new Error('login failed');
  ok(await post('/api/transactions/months', { id: P, name: `Month ${P}`, status: 'Open' }), 'open previous month');
}, 60000);

afterAll(async () => { await purgeCompany(companyId); }, 60000);

const expense = async (desc: string, date: string) => {
  ok(await post('/api/expenses', { date, vendorId, taxSlabId, bankId, status: 'Active', type: 'Actual', billNumber: 'CB-' + generateId().slice(-4), description: desc, paymentStatus: 'Paid', amountPaid: 115, paymentDate: date, amount: 115 }), 'expense');
  return ((await db.select().from(schema.expenses).where(eq(schema.expenses.companyId, companyId))) as any[]).find(e => e.description === desc).id as string;
};

describe('expense cancellation', () => {
  it('posts its reversal today, and the books still balance', async () => {
    const a = await expense('Cancelled in open month', pDay(10));
    ok(await post(`/api/expenses/${a}/cancel`, {}), 'cancel');
    const ents = await entries();
    const reversals = ents.filter(e => e.referenceType === 'Expense' && e.reversalOfId);
    expect(reversals.length).toBeGreaterThan(0);
    for (const r of reversals) expect(r.date).toBe(today);                       // never back in the expense's own, earlier month
    const originals = ents.filter(e => e.referenceType === 'Expense' && !e.reversalOfId);
    for (const o of originals) expect(o.date).toBe(pDay(10));
    const bs = await rep('balance-sheet', `asOfDate=${today}`);
    expect(Math.abs(bs.balanceCheck)).toBeLessThan(0.011);
  });

  it('is refused once the expense\'s own month is closed, and nothing changes', async () => {
    const b = await expense('Month then closed', pDay(12));
    const row = (await api('/api/transactions/months')).body;
    const month = (Array.isArray(row) ? row : row.rows).find((m: any) => m.id === P);
    ok(await post('/api/transactions/months', { ...month, status: 'Closed', closedAt: new Date().toISOString(), closedOption: 'including_pending' }), 'close');
    const before = await rep('profit-loss', `startDate=${P}-01&endDate=${P}-28&basis=Accrual`);
    const bsBefore = await rep('balance-sheet', `asOfDate=${today}`);
    const cancel = await post(`/api/expenses/${b}/cancel`, {});
    expect(cancel.status).toBe(400);
    expect(cancel.body.error).toMatch(/closed fiscal month/i);
    const after = await rep('profit-loss', `startDate=${P}-01&endDate=${P}-28&basis=Accrual`);
    expect(after.totalExpenses).toBe(before.totalExpenses);
    const bsAfter = await rep('balance-sheet', `asOfDate=${today}`);
    expect(bsAfter.bankBalance).toBe(bsBefore.bankBalance);
    expect(Math.abs(bsAfter.balanceCheck)).toBeLessThan(0.011);
  });
});

describe('purchase bill date', () => {
  let grn = '';
  it('is mandatory', async () => {
    grn = ok(await post('/api/inventory/goods-receipt-notes', { grnData: { isDsd: true, vendorId, warehouseId, receivedBy: 'T', items: [{ productId, quantityReceived: 5, unitCost: 20, taxRate: 15 }] } }), 'grn').goodsReceiptNote.id;
    const noDate = await post('/api/inventory/purchase-bills', { billData: { grnIds: [grn], bankId, vendorBillNumber: 'X1' } });
    expect(noDate.status).toBe(400);
    expect(noDate.body.error).toMatch(/bill date is required/i);
  });

  it('is validated: not in a closed month, not in the future', async () => {
    const closed = await post('/api/inventory/purchase-bills', { billData: { grnIds: [grn], bankId, date: pDay(15), vendorBillNumber: 'X2' } });
    expect(closed.status).toBe(400);
    expect(closed.body.error).toMatch(/closed fiscal month/i);
    const future = await post('/api/inventory/purchase-bills', { billData: { grnIds: [grn], bankId, date: `${now.getUTCFullYear() + 1}-01-15`, vendorBillNumber: 'X3' } });
    expect(future.status).toBe(400);
  });

  it('is kept on the bill, and a payment cannot be dated before it', async () => {
    const bill = ok(await post('/api/inventory/purchase-bills', { billData: { grnIds: [grn], bankId, date: today, vendorBillNumber: 'X4' } }), 'bill').purchaseBill;
    expect(new Date(bill.date).toISOString().slice(0, 10)).toBe(today);
    const early = await post(`/api/inventory/purchase-bills/${bill.id}/pay`, { date: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`, bankId, amount: 10 });
    if (today.slice(8, 10) !== '01') {
      expect(early.status).toBe(400);
      expect(early.body.error).toMatch(/cannot be dated before the bill/i);
    }
    expect((await post(`/api/inventory/purchase-bills/${bill.id}/pay`, { date: today, bankId, amount: 10 })).status).toBe(200);
  });
});
