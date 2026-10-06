import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { provisionStarterResources } from '../server/lib/companyProvisioning.js';
import { purgeCompany } from './helpers/purgeCompany.js';

// Goods returned AFTER the bill was paid in full: the bill stays as paid history (its totals are not reduced), the stock and the
// input VAT go back, and the SUPPLIER NOW OWES THE COMPANY that money. That refund due is a receivable — it must appear as its
// own asset (not be netted into Accounts Payable: IAS 1.32 / IAS 32.42), otherwise the Balance Sheet and Trial Balance are out
// by exactly the returned amount. A return against a bill that is NOT yet paid reduces what is owed instead (no receivable).
const BASE_URL = 'http://localhost:3000';
const PW = 'AutoTest_Pw_2026!';
const NAME = 'Vendor Credit Receivable Test Co';
const today = new Date().toISOString().slice(0, 10);

let companyId = '', sessionId = '', bankId = '', vendorId = '', warehouseId = '', productId = '';

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, ...(init.headers || {}) } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const post = (p: string, b: any) => api(p, { method: 'POST', body: JSON.stringify(b) });
const ok = (r: { status: number; body: any }, what: string) => { if (r.status !== 200) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const rep = async (name: string, q: string) => (await api(`/api/reports/${name}?${q}`)).body;
const near = (a: number, b: number) => Math.abs(a - b) < 0.011;

async function billedGrn(qty: number): Promise<{ grn: string; bill: string }> {
  const g = ok(await post('/api/inventory/goods-receipt-notes', { grnData: { isDsd: true, vendorId, warehouseId, receivedBy: 'T', items: [{ productId, quantityReceived: qty, unitCost: 100, taxRate: 15 }] } }), 'grn').goodsReceiptNote.id;
  const b = ok(await post('/api/inventory/purchase-bills', { billData: { grnIds: [g], bankId, vendorBillNumber: 'VC-' + generateId().slice(-4) } }), 'bill').purchaseBill;
  return { grn: g, bill: b.id };
}

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: NAME, address: 'x', phone: '0', email: 'vc@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false,
  } as any);
  await db.transaction(async (tx: any) => provisionStarterResources(tx, { companyId, companyName: NAME }));
  const one = async (table: any, col: any) => (await db.select().from(table).where(eq(col, companyId)))[0] as any;
  bankId = (await one(schema.bankAccounts, schema.bankAccounts.companyId)).id;
  vendorId = (await one(schema.vendors, schema.vendors.companyId)).id;
  warehouseId = (await one(schema.warehouses, schema.warehouses.companyId)).id;
  productId = generateId();
  await db.insert(schema.productsServices).values({
    id: productId, name: 'Credit Item', description: 'Credit Item', unitPrice: '150', costPrice: '100', itemKind: 'item', companyId, averageCost: '0', totalQuantityPurchased: '0',
  } as any);
  const userId = generateId();
  const username = `vc_${userId.slice(-10)}`;
  await db.insert(schema.users).values({ id: userId, username, password: await bcrypt.hash(PW, 10), role: 'admin', companyId, isSuperAdmin: false });
  const login = await (await fetch(`${BASE_URL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PW }) })).json();
  sessionId = login.sessionId;
  if (!sessionId) throw new Error('login failed');
}, 60000);

afterAll(async () => { await purgeCompany(companyId); }, 60000);

describe('a purchase return after the bill was paid in full', () => {
  it('shows the refund due as a vendor credit receivable and the sheet balances', async () => {
    const a = await billedGrn(10);                       // 1000 + 150 VAT = 1150
    ok(await post(`/api/inventory/purchase-bills/${a.bill}/pay`, { date: today, bankId, amount: 1150 }), 'pay');
    ok(await post('/api/inventory/purchase-returns', { returnData: { grnId: a.grn, items: [{ productId, quantityReturned: 3 }] } }), 'return');   // 300 + 45 VAT

    const bs = await rep('balance-sheet', `asOfDate=${today}`);
    expect(bs.bankBalance).toBe(-1150);
    expect(bs.inventoryValue).toBe(700);                  // 7 units left at 100
    expect(bs.vatInputRecoverable).toBe(105);             // 150 claimed, 45 given back in the return's own period
    expect(bs.vendorCreditReceivable).toBe(345);          // what the supplier owes back
    expect(bs.accountsPayable).toBe(0);                   // not netted into payables
    expect(near(bs.balanceCheck, 0)).toBe(true);

    const tb = await rep('trial-balance', `startDate=${today}&endDate=${today}`);
    expect(tb.ledgers.find((l: any) => l.name === 'Vendor Credit Receivable').debit).toBe(345);
    expect(near(tb.totalDebits, tb.totalCredits)).toBe(true);

    // the supplier's own statement ends 345 in the company's favour
    const vs = await rep('vendor-statement', `vendorId=${vendorId}&startDate=2020-01-01&endDate=${today}`);
    expect(vs.endingBalance).toBe(-345);
    // and the VAT return gives back the 45 in the period of the return
    const vat = await rep('vat-return-summary', `startDate=${today.slice(0, 7)}-01&endDate=${today}`);
    expect(vat.inputVat).toBe(105);
  });

  it('a return against a bill NOT yet paid lowers what is owed instead, with no receivable', async () => {
    const before = await rep('balance-sheet', `asOfDate=${today}`);
    const b = await billedGrn(4);                         // 400 + 60 VAT = 460, unpaid
    ok(await post('/api/inventory/purchase-returns', { returnData: { grnId: b.grn, items: [{ productId, quantityReturned: 1 }] } }), 'return');   // 100 + 15
    const bs = await rep('balance-sheet', `asOfDate=${today}`);
    expect(bs.vendorCreditReceivable).toBe(before.vendorCreditReceivable);        // unchanged
    expect(bs.accountsPayable).toBe(345);                 // 460 - 115
    expect(near(bs.balanceCheck, 0)).toBe(true);
  });
});

describe('receiving the refund from the supplier', () => {
  let r1 = '', r2 = '';
  const refund = (amount: number, extra: any = {}) => post('/api/inventory/vendor-refunds', { vendorId, bankId, amount, date: today, ...extra });

  it('cannot exceed the credit the supplier owes', async () => {
    const bs = await rep('balance-sheet', `asOfDate=${today}`);
    const tooMuch = await refund(bs.vendorCreditReceivable + 1);
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error).toMatch(/exceeds the credit/i);
    expect((await refund(0)).status).toBe(400);
  });

  it('clears the receivable, brings the cash in, and leaves profit and VAT alone', async () => {
    const before = await rep('balance-sheet', `asOfDate=${today}`);
    const plBefore = await rep('profit-loss', `startDate=${today.slice(0, 7)}-01&endDate=${today}&basis=Accrual`);
    const vatBefore = await rep('vat-return-summary', `startDate=${today.slice(0, 7)}-01&endDate=${today}`);
    r1 = ok(await refund(200), 'refund').voucher.id;

    const bs = await rep('balance-sheet', `asOfDate=${today}`);
    expect(bs.vendorCreditReceivable).toBe(before.vendorCreditReceivable - 200);
    expect(near(bs.bankBalance, before.bankBalance + 200)).toBe(true);
    expect(near(bs.balanceCheck, 0)).toBe(true);
    expect(bs.totalEquity).toBe(before.totalEquity);
    const pl = await rep('profit-loss', `startDate=${today.slice(0, 7)}-01&endDate=${today}&basis=Accrual`);
    expect(pl.netProfit).toBe(plBefore.netProfit);
    expect(pl.totalExpenses).toBe(plBefore.totalExpenses);
    expect((await rep('vat-return-summary', `startDate=${today.slice(0, 7)}-01&endDate=${today}`)).inputVat).toBe(vatBefore.inputVat);

    const ledger = await rep('bank-ledger', `bankId=${bankId}&startDate=2020-01-01&endDate=${today}`);
    expect(near(ledger.endingBalance, bs.bankBalance)).toBe(true);
    const vs = await rep('vendor-statement', `vendorId=${vendorId}&startDate=2020-01-01&endDate=${today}`);
    expect(vs.endingBalance).toBe(vs.entries.reduce((a: number, e: any) => a + e.debit - e.credit, 0));
    const tb = await rep('trial-balance', `startDate=${today}&endDate=${today}`);
    expect(near(tb.totalDebits, tb.totalCredits)).toBe(true);
    const list = (await api('/api/inventory/vendor-refunds')).body;
    expect(list.refunds.find((r: any) => r.id === r1).cancelled).toBe(false);
    expect(list.creditBalance).toBe(bs.vendorCreditReceivable);
  });

  it('cancelling it puts the receivable and the cash back, exactly once', async () => {
    const before = await rep('balance-sheet', `asOfDate=${today}`);
    ok(await post(`/api/inventory/vendor-refunds/${r1}/cancel`, {}), 'cancel refund');
    const bs = await rep('balance-sheet', `asOfDate=${today}`);
    expect(bs.vendorCreditReceivable).toBe(before.vendorCreditReceivable + 200);
    expect(near(bs.bankBalance, before.bankBalance - 200)).toBe(true);
    expect(near(bs.balanceCheck, 0)).toBe(true);
    const ledger = await rep('bank-ledger', `bankId=${bankId}&startDate=2020-01-01&endDate=${today}`);
    expect(near(ledger.endingBalance, bs.bankBalance)).toBe(true);
    const again = await post(`/api/inventory/vendor-refunds/${r1}/cancel`, {});
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/already been cancelled/i);
  });

  it('a refund in a FILED quarter, or its cancellation, is refused; so is one in a CLOSED month', async () => {
    r2 = ok(await refund(100), 'second refund').voucher.id;
    const month = today.slice(0, 7);
    const year = Number(today.slice(0, 4)), quarter = Math.ceil(Number(today.slice(5, 7)) / 3);

    // the quarter is filed with ZATCA: nothing dated in it may be added or undone
    const gen = await post('/api/tax-returns/generate', { year, quarter });
    expect(gen.status, JSON.stringify(gen.body)).toBe(200);
    const filed = await post(`/api/tax-returns/${gen.body.taxReturn.id}/file`, {});
    expect(filed.status, JSON.stringify(filed.body)).toBe(200);
    const newRefund = await refund(50);
    expect(newRefund.status).toBe(400);
    expect(newRefund.body.error).toMatch(/filed with ZATCA/i);
    const cancel = await post(`/api/inventory/vendor-refunds/${r2}/cancel`, {});
    expect(cancel.status).toBe(400);
    expect(cancel.body.error).toMatch(/filed with ZATCA/i);

    // and nothing moved
    const bs = await rep('balance-sheet', `asOfDate=${today}`);
    expect((await api('/api/inventory/vendor-refunds')).body.creditBalance).toBe(bs.vendorCreditReceivable);
    expect(near(bs.balanceCheck, 0)).toBe(true);

    // a CLOSED month refuses both too (checked on a date inside it; the credit was created later, but the date check comes first)
    const row = (await api('/api/transactions/months')).body;
    const cur = (Array.isArray(row) ? row : row.rows).find((m: any) => m.id === month);
    const closed = await post('/api/transactions/months', { ...cur, status: 'Closed', closedAt: new Date().toISOString(), closedOption: 'including_pending' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const inClosed = await refund(10);
    expect(inClosed.status).toBe(400);
    const cancelClosed = await post(`/api/inventory/vendor-refunds/${r2}/cancel`, {});
    expect(cancelClosed.status).toBe(400);
  });

  it('paying a purchase bill is held to the same rule: nothing may be dated in the closed month or the filed quarter', async () => {
    const bills = (await api('/api/state')).body.purchaseBills.filter((b: any) => b.status !== 'Paid' && b.status !== 'Cancelled');
    expect(bills.length).toBeGreaterThan(0);
    const pay = await post(`/api/inventory/purchase-bills/${bills[0].id}/pay`, { date: today, bankId, amount: 10 });
    expect(pay.status, JSON.stringify(pay.body)).toBe(400);
  });
});
