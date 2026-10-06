import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { provisionStarterResources } from '../server/lib/companyProvisioning.js';
import { getQuarterDateRange } from '../server/lib/vatReturn.js';
import { purgeCompany } from './helpers/purgeCompany.js';

// A Purchase Return that gives back input VAT must be recorded in the tax period of the RETURN, not rewrite
// the period of the original bill. Two cases, both with bills dated in the PREVIOUS quarter and returns made
// now: (a) the bill is still unpaid when the goods go back (its stored totals get reduced) and (b) the bill is
// already paid (its stored totals are NOT reduced — the VAT claim used to be left standing forever).
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';
const NAME = 'Return VAT Period Test Co';

const now = new Date();
const curYear = now.getUTCFullYear();
const curQuarter = Math.floor(now.getUTCMonth() / 3) + 1;
const prevQuarter = curQuarter === 1 ? 4 : curQuarter - 1;
const prevYear = curQuarter === 1 ? curYear - 1 : curYear;
const cur = getQuarterDateRange(curYear, curQuarter as 1 | 2 | 3 | 4);
const prev = getQuarterDateRange(prevYear, prevQuarter as 1 | 2 | 3 | 4);

let companyId: string, userId: string, sessionId: string, productId: string;
let bankId: string, vendorId: string, warehouseId: string;
let grn1: string, grn2: string, bill1: string, bill2: string, return1: string, curReturnId: string;

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, ...(init.headers || {}) } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const post = (path: string, body: any) => api(path, { method: 'POST', body: JSON.stringify(body) });
const summary = async (r: { startDate: string; endDate: string }) =>
  (await api(`/api/reports/vat-return-summary?startDate=${r.startDate}&endDate=${r.endDate}`)).body;

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: NAME, address: 'x', phone: '0', email: 'rv@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false,
  });
  await db.transaction(async (tx: any) => provisionStarterResources(tx, { companyId, companyName: NAME }));
  const one = async (table: any, col: any) => (await db.select().from(table).where(eq(col, companyId)))[0] as any;
  bankId = (await one(schema.bankAccounts, schema.bankAccounts.companyId)).id;
  vendorId = (await one(schema.vendors, schema.vendors.companyId)).id;
  warehouseId = (await one(schema.warehouses, schema.warehouses.companyId)).id;
  productId = generateId();
  await db.insert(schema.productsServices).values({
    id: productId, name: 'Return VAT Item', description: 'Return VAT Item', unitPrice: '50', costPrice: '20', itemKind: 'item', companyId, averageCost: '0', totalQuantityPurchased: '0',
  } as any);
  userId = generateId();
  const username = `rv_${userId.slice(-10)}`;
  await db.insert(schema.users).values({ id: userId, username, password: await bcrypt.hash(TEST_PASSWORD, 10), role: 'admin', companyId, isSuperAdmin: false });
  const login = await (await fetch(`${BASE_URL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: TEST_PASSWORD }) })).json();
  sessionId = login.sessionId;
  if (!sessionId) throw new Error('login failed');
}, 60000);

afterAll(async () => { await purgeCompany(companyId); }, 60000);

describe('Purchase return input VAT belongs to the return period', () => {
  it('builds two billed GRNs (one bill unpaid, one paid) dated in the previous quarter', async () => {
    const mk = async () => {
      const g = await post('/api/inventory/goods-receipt-notes', { grnData: { isDsd: true, vendorId, warehouseId, receivedBy: 'Test', items: [{ productId, quantityReceived: 10, unitCost: 20, taxRate: 15 }] } });
      expect(g.status).toBe(200);
      const b = await post('/api/inventory/purchase-bills', { billData: { date: new Date().toISOString().slice(0, 10), grnIds: [g.body.goodsReceiptNote.id], bankId, vendorBillNumber: 'RV-' + generateId().slice(-4) } });
      expect(b.status).toBe(200);
      return { grn: g.body.goodsReceiptNote.id as string, bill: b.body.purchaseBill.id as string };
    };
    ({ grn: grn1, bill: bill1 } = await mk());
    ({ grn: grn2, bill: bill2 } = await mk());
    expect((await post(`/api/inventory/purchase-bills/${bill2}/pay`, { date: now.toISOString().slice(0, 10), bankId, amount: 230 })).status).toBe(200);
    // Both supplier invoices belong to the PREVIOUS quarter.
    const prevDate = new Date(prev.startDate + 'T10:00:00.000Z');
    await db.update(schema.purchaseBills).set({ date: prevDate }).where(eq(schema.purchaseBills.id, bill1));
    await db.update(schema.purchaseBills).set({ date: prevDate }).where(eq(schema.purchaseBills.id, bill2));
    const before = await summary(prev);
    expect(before.inputVat).toBe(60);                // 30 + 30, untouched so far
  });

  it('returning goods now takes the VAT back in the CURRENT quarter and leaves the previous quarter alone', async () => {
    const r1 = await post('/api/inventory/purchase-returns', { returnData: { grnId: grn1, items: [{ productId, quantityReturned: 2 }] } });
    const r2 = await post('/api/inventory/purchase-returns', { returnData: { grnId: grn2, items: [{ productId, quantityReturned: 2 }] } });
    expect(r1.status).toBe(200); expect(r2.status).toBe(200);
    return1 = r1.body.purchaseReturn.id;

    // Previous quarter: still the ORIGINAL claim for both bills, whether or not the bill's own totals were reduced.
    expect((await summary(prev)).inputVat).toBe(60);
    // Current quarter: a negative adjustment of 2 x 20 x 15% = 6 for each return.
    const c = await summary(cur);
    expect(c.inputVat).toBe(-12);
    expect(c.netVatPayable).toBe(12);
    const reg = (await api(`/api/reports/purchase-vat?startDate=${cur.startDate}&endDate=${cur.endDate}`)).body;
    expect(reg.rows.filter((r: any) => r.taxAmount === -6)).toHaveLength(2);

    // The unpaid bill's own payable was reduced (and still is); the paid bill's was not — both are right for AP.
    const [b1] = await db.select().from(schema.purchaseBills).where(eq(schema.purchaseBills.id, bill1));
    const [b2] = await db.select().from(schema.purchaseBills).where(eq(schema.purchaseBills.id, bill2));
    expect(Number(b1.taxTotal)).toBe(24);
    expect(Number(b2.taxTotal)).toBe(30);

    // Balance Sheet carries the cumulative position: 60 claimed - 12 given back.
    const bs = (await api(`/api/reports/balance-sheet?asOfDate=${now.toISOString().slice(0, 10)}`)).body;
    expect(bs.vatInputRecoverable).toBe(48);
  });

  it('the generated filing figures agree, for both quarters', async () => {
    const g = await post('/api/tax-returns/generate', { year: curYear, quarter: curQuarter });
    expect(g.status).toBe(200);
    expect(g.body.taxReturn.figuresSnapshot.inputVat).toBe(-12);
    curReturnId = g.body.taxReturn.id;
    const gp = await post('/api/tax-returns/generate', { year: prevYear, quarter: prevQuarter });
    expect(gp.status).toBe(200);
    expect(gp.body.taxReturn.figuresSnapshot.inputVat).toBe(60);
  });

  it('cancelling a return restores the bill it had reduced and removes the quarter adjustment', async () => {
    // The current quarter's return is generated, so the quarter is frozen: the cancellation is refused until that draft is deleted.
    const frozen = await api(`/api/inventory/purchase-returns/${return1}/cancel`, { method: 'PATCH' });
    expect(frozen.status).toBe(400);
    expect(frozen.body.error).toMatch(/has been generated for this quarter/i);
    expect((await post(`/api/tax-returns/${curReturnId}/delete`, {})).status).toBe(200);
    const c = await api(`/api/inventory/purchase-returns/${return1}/cancel`, { method: 'PATCH' });
    expect(c.status).toBe(200);
    const [b1] = await db.select().from(schema.purchaseBills).where(eq(schema.purchaseBills.id, bill1));
    expect(Number(b1.taxTotal)).toBe(30);
    expect(Number(b1.subTotal)).toBe(200);
    expect(Number(b1.grandTotal)).toBe(230);
    expect((await summary(cur)).inputVat).toBe(-6);   // only the paid bill's return remains
    expect((await summary(prev)).inputVat).toBe(60);
  });
});
