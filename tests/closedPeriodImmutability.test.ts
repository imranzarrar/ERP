import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { provisionStarterResources } from '../server/lib/companyProvisioning.js';
import { getQuarterDateRange } from '../server/lib/vatReturn.js';
import { purgeCompany } from './helpers/purgeCompany.js';

// THE invariant behind every period rule: once a month is closed and its VAT quarter is filed, NOTHING a user can do afterwards
// may change those months' figures or that quarter's return. Every action below is aimed at a document that belongs to the closed
// period (cancel, reverse, credit, return, pay, settle, delete, edit); after each one the closed months' P&L, the filed quarter's
// VAT figures and registers, and the stored month profits must be exactly as they were — or the action must have been refused —
// and the books must still balance.
const BASE_URL = 'http://localhost:3000';
const PW = 'AutoTest_Pw_2026!';
const NAME = 'Closed Period Immutability Test Co';
const now = new Date();
const cy = now.getUTCFullYear(), cm = now.getUTCMonth();
const curQ = Math.floor(cm / 3);
const prevQ = (curQ + 3) % 4;
const prevYear = curQ === 0 ? cy - 1 : cy;
const mm = (y: number, m0: number) => `${y}-${String(m0 + 1).padStart(2, '0')}`;
const M1 = mm(prevYear, prevQ * 3 + 1);
const M2 = mm(prevYear, prevQ * 3 + 2);
const d1 = (d: number) => `${M1}-${String(d).padStart(2, '0')}`;
const d2 = (d: number) => `${M2}-${String(d).padStart(2, '0')}`;
const today = now.toISOString().slice(0, 10);
const lastDay = (ym: string) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; };
const prevRange = getQuarterDateRange(prevYear, (prevQ + 1) as 1 | 2 | 3 | 4);

let companyId = '', sessionId = '', bankId = '', bank2Id = '', customerId = '', vendorId = '', taxSlabId = '', warehouseId = '', P = '', S = '';
const ids: Record<string, string> = {};

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, ...(init.headers || {}) } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const post = (p: string, b: any) => api(p, { method: 'POST', body: JSON.stringify(b) });
const patch = (p: string, b: any = {}) => api(p, { method: 'PATCH', body: JSON.stringify(b) });
const del = (p: string) => api(p, { method: 'DELETE' });
const ok = (r: { status: number; body: any }, what: string) => { if (r.status !== 200) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const rep = async (name: string, q: string) => (await api(`/api/reports/${name}?${q}`)).body;
const line = (pid: string | null, desc: string, qty: number, price: number) => ({ id: generateId(), description: desc, unitCost: price, quantity: qty, discountAmount: 0, ...(pid ? { productId: pid } : {}) });
const invoice = async (date: string, items: any[], paid = 0, extra: any = {}) =>
  ok(await post('/api/transactions/invoices', { invoiceData: { date, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: paid, items, ...extra } }), `invoice ${date}`).invoiceId as string;
const expense = async (date: string, amount: number, extra: any = {}) => {
  ok(await post('/api/expenses', { date, vendorId, taxSlabId, bankId, status: 'Active', type: 'Actual', billNumber: 'CP-' + generateId().slice(-4), description: extra.description, paymentStatus: 'Unpaid', amount, ...extra }), `expense ${date}`);
  return ((await db.select().from(schema.expenses).where(eq(schema.expenses.companyId, companyId))) as any[]).find(e => e.description === extra.description).id as string;
};

// everything about the closed period that must never move
async function snapshot() {
  const out: Record<string, any> = {};
  for (const [k, a, b] of [['m1', d1(1), lastDay(M1)], ['m2', d2(1), lastDay(M2)]] as const) {
    const p = await rep('profit-loss', `startDate=${a}&endDate=${b}&basis=Accrual`);
    out[k] = { rev: p.totalRevenue, cogs: p.costOfGoodsSold, exp: p.totalExpenses, profit: p.netProfit };
  }
  const v = await rep('vat-return-summary', `startDate=${prevRange.startDate}&endDate=${prevRange.endDate}`);
  const sv = await rep('sales-vat', `startDate=${prevRange.startDate}&endDate=${prevRange.endDate}`);
  const pv = await rep('purchase-vat', `startDate=${prevRange.startDate}&endDate=${prevRange.endDate}`);
  out.vat = { out: v.outputVat, in: v.inputVat, sales: sv.totals, purchases: pv.totals, nSales: sv.count, nPurch: pv.count };
  out.history = (await rep('fiscal-month-closing-history', '')).rows.map((r: any) => [r.id, r.closedPnL.netProfit, r.closedPnL.totalRevenue, r.closedPnL.totalExpenses]);
  out.filed = ((await api('/api/tax-returns')).body as any[]).map(t => [t.referenceNumber, t.status, JSON.stringify(t.figuresSnapshot)]);
  return out;
}
const booksBalance = async () => {
  const bs = await rep('balance-sheet', `asOfDate=${today}`);
  const tb = await rep('trial-balance', `startDate=${d1(1)}&endDate=${today}`);
  return { check: bs.balanceCheck, tb: Math.round((tb.totalDebits - tb.totalCredits) * 100) / 100 };
};

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: NAME, address: 'x', phone: '0', email: 'cp@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false, inventorySettings: { prOptionality: 'OPTIONAL', isDsdAllowed: true },
  } as any);
  await db.transaction(async (tx: any) => provisionStarterResources(tx, { companyId, companyName: NAME }));
  const one = async (table: any, col: any) => (await db.select().from(table).where(eq(col, companyId)))[0] as any;
  bankId = (await one(schema.bankAccounts, schema.bankAccounts.companyId)).id;
  customerId = (await one(schema.customers, schema.customers.companyId)).id;
  vendorId = (await one(schema.vendors, schema.vendors.companyId)).id;
  taxSlabId = (await one(schema.taxSlabs, schema.taxSlabs.companyId)).id;
  warehouseId = (await one(schema.warehouses, schema.warehouses.companyId)).id;
  bank2Id = generateId();
  await db.insert(schema.bankAccounts).values({ id: bank2Id, bankName: 'Second Bank', accountNumber: '222', accountTitle: 'Second', openingBalance: '0', companyId, isActive: true } as any);
  P = generateId(); S = generateId();
  await db.insert(schema.productsServices).values([
    { id: P, name: 'Period Item', description: 'Period Item', unitPrice: '30', costPrice: '10', itemKind: 'item', companyId, averageCost: '0', totalQuantityPurchased: '0' },
    { id: S, name: 'Period Service', description: 'Period Service', unitPrice: '100', costPrice: '0', itemKind: 'service', companyId },
  ] as any);
  const userId = generateId();
  const username = `cp_${userId.slice(-10)}`;
  await db.insert(schema.users).values({ id: userId, username, password: await bcrypt.hash(PW, 10), role: 'admin', companyId, isSuperAdmin: false });
  const login = await (await fetch(`${BASE_URL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PW }) })).json();
  sessionId = login.sessionId;
  if (!sessionId) throw new Error('login failed');
}, 60000);

afterAll(async () => { await purgeCompany(companyId); }, 60000);

let before: Record<string, any>;

describe('closed periods cannot be reached by any later action', () => {
  it('builds two months with every kind of document, closes them and files the VAT quarter', async () => {
    for (const id of [M1, M2]) ok(await post('/api/transactions/months', { id, name: `Month ${id}`, status: 'Open' }), `open ${id}`);
    // stock to sell and to buy against (goods receipts are entered today; bills carry their own supplier-invoice date)
    const grn = async (qty: number) => ok(await post('/api/inventory/goods-receipt-notes', { grnData: { isDsd: true, vendorId, warehouseId, receivedBy: 'T', items: [{ productId: P, quantityReceived: qty, unitCost: 10, taxRate: 15 }] } }), 'grn').goodsReceiptNote.id as string;
    ids.grnPaid = await grn(10); ids.grnOpen = await grn(10); ids.grnUnbilled = await grn(4);
    ids.billPaid = ok(await post('/api/inventory/purchase-bills', { billData: { grnIds: [ids.grnPaid], bankId, date: d1(5), vendorBillNumber: 'CP-B1' } }), 'bill').purchaseBill.id;
    ok(await post(`/api/inventory/purchase-bills/${ids.billPaid}/pay`, { date: d1(6), bankId, amount: 115 }), 'pay bill');
    ids.billOpen = ok(await post('/api/inventory/purchase-bills', { billData: { grnIds: [ids.grnOpen], bankId, date: d2(5), vendorBillNumber: 'CP-B2' } }), 'bill 2').purchaseBill.id;

    ids.invA = await invoice(d1(10), [line(S, 'Service A', 2, 100)], 0);                 // unpaid service
    ids.invB = await invoice(d1(12), [line(S, 'Service B', 1, 100)], 115);               // paid service
    ids.invStock = await invoice(d1(15), [line(P, 'Stock sale', 3, 30)], 50);            // part-paid stock sale
    ids.pos = await invoice(d2(10), [line(P, 'POS sale', 2, 30)], 69, { isPosSale: true });
    ids.invC = await invoice(d2(14), [line(S, 'Service C', 1, 100)], 0);

    ids.expOpen = await expense(d1(8), 230, { description: 'Closed opex unpaid' });
    ids.expPaid = await expense(d2(8), 115, { description: 'Closed opex paid', paymentStatus: 'Paid', amountPaid: 115, paymentDate: d2(8) });
    ids.expCapex = await expense(d1(9), 345, { description: 'Closed capex', classification: 'Asset' });
    const tpl = ok(await post('/api/transactions/recurring-templates', { description: 'Rent', defaultAmount: 230, bankId, vendorId, taxSlabId, isActive: true }), 'template');
    ids.tpl = tpl.id;
    ok(await post('/api/transactions/recurring-postings', { templateId: tpl.id, monthId: M1, postType: 'Accrual', amount: 230, dateStr: d1(20), paymentStatus: 'Unpaid', bankId }), 'accrual');
    ids.accrual = ((await db.select().from(schema.expenses).where(eq(schema.expenses.companyId, companyId))) as any[]).find(e => e.type === 'Accrual').id;

    const inv = ok(await post('/api/transactions/investors', { name: 'CP Investor', email: 'i@example.com', phone: '1', equityPercentage: 100, profitPercentage: 100, capitalContributed: 0, isActive: true, createdAt: new Date().toISOString() }), 'investor');
    void inv;
    ids.investor = ((await db.select().from(schema.investors).where(eq(schema.investors.companyId, companyId))) as any[])[0].id;
    ok(await post(`/api/transactions/investors/${ids.investor}/investment`, { bankId, amount: 1000, date: d1(3), description: 'Capital' }), 'investment');
    ok(await post('/api/transactions/interbank-transfer', { sourceBankId: bankId, destBankId: bank2Id, amount: 100, description: 'Float', dateStr: d2(3) }), 'transfer');

    // close both months (oldest first; the recurring template must be posted or switched off)
    const monthRow = async (id: string) => { const r = (await api('/api/transactions/months')).body; return (Array.isArray(r) ? r : r.rows).find((m: any) => m.id === id); };
    const close = async (id: string) => post('/api/transactions/months', { ...(await monthRow(id)), status: 'Closed', closedAt: new Date().toISOString(), closedOption: 'including_pending' });
    ok(await close(M1), 'close M1');
    ok(await patch(`/api/transactions/recurring-templates/${ids.tpl}/toggle`), 'template off');
    ok(await close(M2), 'close M2');
    await new Promise(r => setTimeout(r, 800));
    const gen = ok(await post('/api/tax-returns/generate', { year: prevYear, quarter: prevQ + 1 }), 'generate');
    ok(await post(`/api/tax-returns/${gen.taxReturn.id}/file`, {}), 'file');
    before = await snapshot();
    expect(before.m1.rev).toBeGreaterThan(0);
    expect(before.history.length).toBe(2);
    expect((await booksBalance()).check).toBe(0);
  }, 180000);

  // Each action targets something that belongs to the closed period. It must either be REFUSED or leave the closed period intact.
  const attempt = async (name: string, run: () => Promise<{ status: number; body: any }>) => {
    const r = await run();
    const after = await snapshot();
    expect(after, `${name}: the closed period moved (action status ${r.status} ${JSON.stringify(r.body).slice(0, 120)})`).toEqual(before);
    const b = await booksBalance();
    expect(Math.abs(b.check), `${name}: Balance Sheet out of balance by ${b.check}`).toBeLessThan(0.011);
    expect(Math.abs(b.tb), `${name}: Trial Balance out of balance by ${b.tb}`).toBeLessThan(0.011);
    return r;
  };
  const items = async (invoiceId: string) => await db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, invoiceId)) as any[];

  it('cancelling any closed-period document is refused', async () => {
    expect((await attempt('cancel invoice', () => post(`/api/transactions/invoices/${ids.invA}/cancel`, {}))).status).toBe(400);
    expect((await attempt('cancel expense', () => post(`/api/expenses/${ids.expOpen}/cancel`, {}))).status).toBe(400);
    expect((await attempt('cancel capex', () => post(`/api/expenses/${ids.expCapex}/cancel`, {}))).status).toBe(400);
    expect((await attempt('delete accrual', () => del(`/api/transactions/accruals/${ids.accrual}`))).status).toBe(400);
    expect((await attempt('cancel bill', () => patch(`/api/inventory/purchase-bills/${ids.billOpen}/cancel`))).status).toBe(400);
  });

  it('a credit note against a closed-period invoice cannot reach back into it', async () => {
    const r = await attempt('credit note', () => post(`/api/transactions/invoices/${ids.invA}/note`, { type: 'CreditNote', reason: 'late' }));
    expect(r.status).toBe(400);
  });

  it('payments, collections, settlements and returns made TODAY leave the closed period alone', async () => {
    await attempt('collect on a closed-period invoice', () => post(`/api/transactions/invoices/${ids.invA}/paid`, { paymentDate: today, bankId, amount: 100 }));
    await attempt('pay a closed-period expense', () => post(`/api/expenses/${ids.expOpen}/pay`, { date: today, bankId, amount: 100 }));
    await attempt('pay a closed-period bill', () => post(`/api/inventory/purchase-bills/${ids.billOpen}/pay`, { date: today, bankId, amount: 50 }));
    await attempt('settle a closed-period accrual', () => post('/api/transactions/settle-accrual', { accrualExpenseId: ids.accrual, actualAmount: 300, actualDate: today, paymentStatus: 'Paid', bankId }));
    const ret = await attempt('purchase return against a closed-period bill', () => post('/api/inventory/purchase-returns', { returnData: { grnId: ids.grnOpen, items: [{ productId: P, quantityReturned: 2 }] } }));
    expect(ret.status, JSON.stringify(ret.body)).toBe(200);
    await attempt('cancel that return', () => patch(`/api/inventory/purchase-returns/${ret.body.purchaseReturn.id}/cancel`));
    const paidRet = await attempt('purchase return against a PAID closed-period bill', () => post('/api/inventory/purchase-returns', { returnData: { grnId: ids.grnPaid, items: [{ productId: P, quantityReturned: 1 }] } }));
    expect(paidRet.status, JSON.stringify(paidRet.body)).toBe(200);
    const posItem = (await items(ids.pos))[0];
    await attempt('POS return of a closed-period sale', () => post('/api/pos/returns', { invoiceId: ids.pos, items: [{ invoiceItemId: posItem.id, quantity: 1 }], reason: 'changed mind' }));
    await attempt('vendor refund', () => post('/api/inventory/vendor-refunds', { vendorId, bankId, amount: 10, date: today }));
    await attempt('unbilled GRN reversal', () => post(`/api/inventory/goods-receipt-notes/${ids.grnUnbilled}/reverse`, {}));
    await attempt('stock adjustment today', () => post('/api/inventory/stock-adjustments', { productId: P, warehouseId, quantity: -1, reason: 'damaged' }));
  }, 120000);
});
