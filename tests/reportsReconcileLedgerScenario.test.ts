import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { provisionStarterResources } from '../server/lib/companyProvisioning.js';
import { purgeCompany } from './helpers/purgeCompany.js';

// End-to-end reconciliation: drive a small but realistic book through the REAL routes (GRN -> bill ->
// bill payment -> paid invoice -> credit note with refund -> part-paid invoice -> cancelled invoice) and
// assert that every report agrees with the source documents AND with each other. This replays the exact
// shape of the first production company (credit note + cancellation + bill) and guards three defects that
// shipped in the reports: P&L revenue included VAT, Net Cash Flow ignored refunds and supplier payments,
// and the Balance Sheet did not balance (missing VAT/fixed-asset lines and unclosed-period earnings).
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';
const NAME = 'Reports Reconcile Test Co';

let companyId: string, userId: string, sessionId: string, productId: string;
let bankId: string, customerId: string, taxSlabId: string, vendorId: string, warehouseId: string;
const today = new Date().toISOString().slice(0, 10);

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init, headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, ...(init.headers || {}) },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const post = (path: string, body: any) => api(path, { method: 'POST', body: JSON.stringify(body) });
const near = (a: number, b: number) => Math.abs(a - b) < 0.011;

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: NAME, address: 'Test Address', phone: '0000000000', email: 'rr@example.com',
    logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false,
  });
  await db.transaction(async (tx: any) => provisionStarterResources(tx, { companyId, companyName: NAME }));
  const one = async (table: any, col: any) => (await db.select().from(table).where(eq(col, companyId)))[0] as any;
  bankId = (await one(schema.bankAccounts, schema.bankAccounts.companyId)).id;
  customerId = (await one(schema.customers, schema.customers.companyId)).id;
  taxSlabId = (await one(schema.taxSlabs, schema.taxSlabs.companyId)).id;
  vendorId = (await one(schema.vendors, schema.vendors.companyId)).id;
  warehouseId = (await one(schema.warehouses, schema.warehouses.companyId)).id;
  productId = generateId();
  await db.insert(schema.productsServices).values({
    id: productId, name: 'Reconcile Item', description: 'Reconcile Item', unitPrice: '50', costPrice: '20', itemKind: 'item', companyId, averageCost: '0', totalQuantityPurchased: '0',
  } as any);
  userId = generateId();
  const username = `rr_${userId.slice(-10)}`;
  await db.insert(schema.users).values({ id: userId, username, password: await bcrypt.hash(TEST_PASSWORD, 10), role: 'admin', companyId, isSuperAdmin: false });
  const login = await (await fetch(`${BASE_URL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: TEST_PASSWORD }) })).json();
  sessionId = login.sessionId;
  if (!sessionId) throw new Error('login failed: ' + JSON.stringify(login));
}, 60000);

afterAll(async () => {
  await purgeCompany(companyId);
}, 60000);

const inv = (qty: number, paid: number) => ({ invoiceData: {
  date: today, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: paid,
  items: [{ id: generateId(), description: 'Reconcile Item', unitCost: 50, quantity: qty, discountAmount: 0, productId }],
} });

describe('reports reconcile with source documents (GRN, bill, credit note, refund, cancellation)', () => {
  let invA: string, billId: string;

  it('builds the book through the real routes', async () => {
    const grn = await post('/api/inventory/goods-receipt-notes', { grnData: { isDsd: true, vendorId, warehouseId, receivedBy: 'Test', items: [{ productId, quantityReceived: 10, unitCost: 20, taxRate: 15 }] } });
    expect(grn.status).toBe(200);
    const bill = await post('/api/inventory/purchase-bills', { billData: { grnIds: [grn.body.goodsReceiptNote.id], bankId, vendorBillNumber: 'RR-1' } });
    expect(bill.status).toBe(200);
    billId = bill.body.purchaseBill.id;
    expect(Number(bill.body.purchaseBill.grandTotal)).toBe(230);
    expect((await post(`/api/inventory/purchase-bills/${billId}/pay`, { date: today, bankId, amount: 230 })).status).toBe(200);

    const a = await post('/api/transactions/invoices', inv(2, 115)); expect(a.status).toBe(200); invA = a.body.invoiceId;
    const b = await post('/api/transactions/invoices', inv(1, 20)); expect(b.status).toBe(200);
    const c = await post('/api/transactions/invoices', inv(1, 0)); expect(c.status).toBe(200);
    expect((await post(`/api/transactions/invoices/${c.body.invoiceId}/cancel`, {})).status).toBe(200);
    expect((await post(`/api/transactions/invoices/${invA}/note`, { type: 'CreditNote', reason: 'Reconcile test' })).status).toBe(200);
  }, 60000);

  it('P&L: revenue excludes VAT, credited and cancelled sales net out, COGS comes from the ledger', async () => {
    const { body } = await api(`/api/reports/profit-loss?startDate=${today}&endDate=${today}&basis=Accrual`);
    // Surviving sale = invoice B only: 1 x 50, VAT 7.50 excluded. A is fully credited, C cancelled.
    expect(body.totalRevenue).toBe(50);
    expect(body.costOfGoodsSold).toBe(20);
    expect(body.netProfit).toBe(30);
  });

  it('Cash flow: refunds and supplier payments are outflows; net equals the real bank movement', async () => {
    const pl = (await api(`/api/reports/profit-loss?startDate=${today}&endDate=${today}&basis=Accrual`)).body;
    expect(pl.operatingInflows).toBe(135);          // 115 (A) + 20 (B)
    expect(pl.operatingOutflows).toBe(345);         // 115 refund on A's credit note + 230 bill payment
    expect(pl.netCashFlow).toBe(-210);
    const bs = (await api(`/api/reports/balance-sheet?asOfDate=${today}`)).body;
    expect(bs.bankBalance).toBe(-210);              // cash really moved by exactly the reported net cash flow
  });

  it('Cash-basis P&L: receipts net of refunds, tax-exclusive', async () => {
    const { body } = await api(`/api/reports/profit-loss?startDate=${today}&endDate=${today}&basis=Cash`);
    // receipts 115 + 20, refund -115 => 20 gross collected; B's ex-VAT share of its 20 is 20/1.15
    expect(near(body.totalRevenue, 20 / 1.15)).toBe(true);
  });

  it('Balance Sheet balances and every new line reconciles to a source document', async () => {
    const { body: bs } = await api(`/api/reports/balance-sheet?asOfDate=${today}`);
    expect(bs.accountsReceivable).toBe(37.5);        // B: 57.50 - 20
    expect(bs.accountsPayable).toBe(0);              // bill paid
    expect(bs.inventoryValue).toBe(180);             // 10 bought - 1 sold net of A's return = 9 x 20
    expect(bs.vatInputRecoverable).toBe(30);         // VAT on the bill
    expect(bs.vatOutputPayable).toBe(7.5);           // B's VAT; A's reversed by its credit note, C cancelled
    expect(bs.currentPeriodEarnings).toBe(30);       // 50 revenue - 20 cost, month still open
    expect(bs.fixedAssets).toBe(0);
    expect(near(bs.balanceCheck, 0)).toBe(true);
  });

  it('Dashboard Net Profit is built from tax-exclusive sales (gross sales card unchanged)', async () => {
    const { body } = await api(`/api/reports/dashboard-summary?startDate=${today}&endDate=${today}`);
    expect(body.totalSales).toBe(57.5);              // "Gross Month Sales" stays VAT-inclusive
    expect(body.netProfit).toBe(30);
  });
});
