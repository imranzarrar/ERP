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
