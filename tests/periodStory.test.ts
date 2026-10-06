import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { provisionStarterResources } from '../server/lib/companyProvisioning.js';
import { purgeCompany } from './helpers/purgeCompany.js';

// REGRESSION STORY (API-driven; the real-screen runs are done separately). One quarter, month by month, every document dated on the day it
// really happens thanks to the developer clock (server started with ALLOW_DEV_CLOCK=1; skipped when it is not): buy -> pay -> sell ->
// collect -> credit -> return -> refund -> expense -> reverse -> accrue -> settle -> close month -> file VAT -> next quarter.
// After every phase the whole rule set is checked through the consistency-check endpoint; the few hard figures are worked out by hand.
const BASE_URL = 'http://localhost:3000';
const PW = 'AutoTest_Pw_2026!';
const NAME = 'Period Story Test Co';
const now = new Date();
const q0 = Math.floor(now.getUTCMonth() / 3) * 3;
const ym = (y: number, m0: number) => `${y + Math.floor(m0 / 12)}-${String((m0 % 12) + 1).padStart(2, '0')}`;
const Y = now.getUTCFullYear();
const M1 = ym(Y, q0), M2 = ym(Y, q0 + 1), M3 = ym(Y, q0 + 2), N1 = ym(Y, q0 + 3);
const quarter = q0 / 3 + 1;
const day = (m: string, d: number) => `${m}-${String(d).padStart(2, '0')}`;

let warehouse2Id = '', companyId = '', sessionId = '', bankId = '', bank2Id = '', customerId = '', vendorId = '', taxSlabId = '', warehouseId = '', P = '', S = '', userId = '';
let clock = '';
let clockEnabled = true;
const ids: Record<string, string> = {};

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, ...(clock ? { 'x-dev-date': clock } : {}), ...(init.headers || {}) } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const post = (p: string, b: any = {}) => api(p, { method: 'POST', body: JSON.stringify(b) });
const patch = (p: string, b: any = {}) => api(p, { method: 'PATCH', body: JSON.stringify(b) });
const ok = (r: { status: number; body: any }, what: string) => { if (r.status !== 200) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const rep = async (name: string, q: string) => (await api(`/api/reports/${name}?${q}`)).body;
const line = (pid: string | null, desc: string, qty: number, price: number) => ({ id: generateId(), description: desc, unitCost: price, quantity: qty, discountAmount: 0, ...(pid ? { productId: pid } : {}) });
const near = (a: number, b: number) => Math.abs(a - b) < 0.011;

// ---- documents, each created on the simulated day `clock` ----
const invoice = async (items: any[], paid = 0, extra: any = {}) =>
  ok(await post('/api/transactions/invoices', { invoiceData: { date: clock, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: paid, items, ...extra } }), `invoice ${clock}`).invoiceId as string;
const expense = async (desc: string, amount: number, extra: any = {}) => {
  ok(await post('/api/expenses', { date: clock, vendorId, taxSlabId, bankId, status: 'Active', type: 'Actual', billNumber: 'ST-' + generateId().slice(-4), description: desc, paymentStatus: 'Unpaid', amount, ...extra }), `expense ${desc}`);
  return ((await db.select().from(schema.expenses).where(eq(schema.expenses.companyId, companyId))) as any[]).find(e => e.description === desc).id as string;
};
const grn = async (qty: number, extra: any = {}) =>
  ok(await post('/api/inventory/goods-receipt-notes', { grnData: { isDsd: true, vendorId, warehouseId, receivedBy: 'Story', items: [{ productId: P, quantityReceived: qty, unitCost: 100, taxRate: 15 }], ...extra } }), 'grn').goodsReceiptNote.id as string;
const bill = async (grnId: string) => ok(await post('/api/inventory/purchase-bills', { billData: { grnIds: [grnId], bankId, date: clock, vendorBillNumber: 'VB-' + generateId().slice(-4) } }), 'bill').purchaseBill.id as string;
const payBill = async (billId: string, amount: number) => ok(await post(`/api/inventory/purchase-bills/${billId}/pay`, { date: clock, bankId, amount }), 'pay bill');
const creditNote = async (invoiceId: string) => post(`/api/transactions/invoices/${invoiceId}/note`, { type: 'CreditNote', reason: 'Story credit' });
const closeMonth = async (m: string) => {
  const r = (await api('/api/transactions/months')).body; const row = (Array.isArray(r) ? r : r.rows).find((x: any) => x.id === m);
  return post('/api/transactions/months', { ...row, status: 'Closed', closedAt: new Date(`${clock}T12:00:00Z`).toISOString(), closedOption: 'including_pending' });
};

// the rule set must hold after every phase
const checkAll = async (label: string) => {
  const r = await rep('consistency-check', `asOfDate=${clock || now.toISOString().slice(0, 10)}`);
  expect(Array.isArray(r.checks) && r.checks.length > 10, `${label}: the consistency check did not run (${JSON.stringify(r).slice(0, 120)})`).toBe(true);
  const bad = (r.checks || []).filter((c: any) => !c.ok && c.severity === 'error');
  if (process.env.STORY_VERBOSE) console.log(`STORY ${label}: ${r.checks.length} rules, errors ${r.errors}, warnings ${r.warnings} ${r.checks.filter((c: any) => !c.ok).map((c: any) => `[${c.id}] ${c.detail}`).join(' || ')}`);
  expect(bad, `${label}: ${bad.map((c: any) => `[${c.id}] ${c.rule} -> ${c.detail}`).join(' || ')}`).toEqual([]);
};

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: NAME, address: 'x', phone: '0', email: 'ps@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false, inventorySettings: { prOptionality: 'OPTIONAL', isDsdAllowed: true },
  } as any);
  await db.transaction(async (tx: any) => provisionStarterResources(tx, { companyId, companyName: NAME }));
  const one = async (table: any, col: any) => (await db.select().from(table).where(eq(col, companyId)))[0] as any;
  bankId = (await one(schema.bankAccounts, schema.bankAccounts.companyId)).id;
  customerId = (await one(schema.customers, schema.customers.companyId)).id;
  vendorId = (await one(schema.vendors, schema.vendors.companyId)).id;
  taxSlabId = (await one(schema.taxSlabs, schema.taxSlabs.companyId)).id;
  warehouseId = (await one(schema.warehouses, schema.warehouses.companyId)).id;
  warehouse2Id = generateId();
  await db.insert(schema.warehouses).values({ id: warehouse2Id, name: 'Second Warehouse', code: 'WH2', isActive: true, companyId, type: 'sales', isCompanyDefault: false } as any);
  bank2Id = generateId();
  await db.insert(schema.bankAccounts).values({ id: bank2Id, bankName: 'Second Bank', accountNumber: '222', accountTitle: 'Second', openingBalance: '0', companyId, isActive: true } as any);
  P = generateId(); S = generateId();
  await db.insert(schema.productsServices).values([
    { id: P, name: 'Story Item', description: 'Story Item', unitPrice: '150', costPrice: '100', itemKind: 'item', companyId, averageCost: '0', totalQuantityPurchased: '0' },
    { id: S, name: 'Story Service', description: 'Story Service', unitPrice: '400', costPrice: '0', itemKind: 'service', companyId },
  ] as any);
  userId = generateId();
  const username = `ps_${userId.slice(-10)}`;
  await db.insert(schema.users).values({ id: userId, username, password: await bcrypt.hash(PW, 10), role: 'admin', companyId, isSuperAdmin: false });
  const login = await (await fetch(`${BASE_URL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PW }) })).json();
  sessionId = login.sessionId;
  if (!sessionId) throw new Error('login failed');
  // is the developer clock on? (the server only honours x-dev-date when started with ALLOW_DEV_CLOCK=1)
  clock = day(M1, 2);
  const probe = await post('/api/transactions/months', { id: M1, name: `Month ${M1}`, status: 'Open' });
  void probe;
  const gr = await post('/api/inventory/goods-receipt-notes', { grnData: { isDsd: true, vendorId, warehouseId, receivedBy: 'probe', items: [{ productId: P, quantityReceived: 1, unitCost: 100, taxRate: 15 }] } });
  const date = gr.body?.goodsReceiptNote?.date ? String(gr.body.goodsReceiptNote.date).slice(0, 10) : '';
  clockEnabled = date === clock;
  if (clockEnabled) {   // undo the probe receipt so the story starts from an empty stock room
    await post(`/api/inventory/goods-receipt-notes/${gr.body.goodsReceiptNote.id}/reverse`, {});
  }
}, 90000);

afterAll(async () => { await purgeCompany(companyId); }, 90000);

describe('a quarter, day by day', () => {
  it('first month: capital, purchase, sales, expenses, credit note, vendor return and refund, cancel, close', async () => {
    // The story needs the developer clock; failing loudly (not skipping) keeps it from ever passing without running.
    expect(clockEnabled, 'start the dev server with ALLOW_DEV_CLOCK=1 (launch config erp-dev-clock)').toBe(true);
    for (const m of [M2, M3]) if (m !== M1) ok(await post('/api/transactions/months', { id: m, name: `Month ${m}`, status: 'Open' }), `open ${m}`);
    // capital and a transfer
    clock = day(M1, 2);
    ok(await post('/api/transactions/investors', { name: 'Story Investor', email: 'i@example.com', phone: '1', equityPercentage: 100, profitPercentage: 100, capitalContributed: 0, isActive: true, createdAt: new Date().toISOString() }), 'investor');
    const investorId = ((await db.select().from(schema.investors).where(eq(schema.investors.companyId, companyId))) as any[])[0].id;
    ok(await post(`/api/transactions/investors/${investorId}/investment`, { bankId, amount: 20000, date: clock, description: 'Capital' }), 'capital');
    clock = day(M1, 3);
    ok(await post('/api/transactions/interbank-transfer', { sourceBankId: bankId, destBankId: bank2Id, amount: 2000, description: 'Float', dateStr: clock }), 'transfer');
    await checkAll('after capital and transfer');

    // buy 20 at 100, bill the same day, pay the next
    clock = day(M1, 4);
    const po = ok(await post('/api/inventory/purchase-orders', { poData: { vendorId, items: [{ productId: P, quantityOrdered: 20, unitPrice: 100 }] } }), 'po').purchaseOrder;
    ids.grn1 = await grn(20, { isDsd: false, purchaseOrderId: po.id });
    ids.bill1 = await bill(ids.grn1);
    clock = day(M1, 5);
    await payBill(ids.bill1, 2300);
    await checkAll('after purchase, bill and payment');

    // sell
    clock = day(M1, 6);
    ids.invA = await invoice([line(P, 'Stock sale A', 6, 150)], 1035);          // 900 + 135 VAT, paid
    ids.invB = await invoice([line(S, 'Service B', 1, 400)], 0);                // 400 + 60 VAT, unpaid
    clock = day(M1, 7);
    ids.pos = await invoice([line(P, 'POS sale', 2, 150)], 345, { isPosSale: true });
    await checkAll('after the first sales');

    // expenses and an accrual
    clock = day(M1, 8);
    ids.e1 = await expense('Story opex paid', 230, { paymentStatus: 'Paid', amountPaid: 230, paymentDate: clock });
    ids.e2 = await expense('Story opex unpaid', 345);
    ids.e3 = await expense('Story capex paid', 575, { classification: 'Asset', paymentStatus: 'Paid', amountPaid: 575, paymentDate: clock });
    clock = day(M1, 9);
    const tpl = ok(await post('/api/transactions/recurring-templates', { description: 'Rent', defaultAmount: 230, bankId, vendorId, taxSlabId, isActive: true }), 'template');
    ids.tpl = tpl.id;
    ok(await post('/api/transactions/recurring-postings', { templateId: tpl.id, monthId: M1, postType: 'Accrual', amount: 230, dateStr: clock, paymentStatus: 'Unpaid', bankId }), 'accrual');
    ids.accrual = ((await db.select().from(schema.expenses).where(eq(schema.expenses.companyId, companyId))) as any[]).find(e => e.type === 'Accrual').id;
    await checkAll('after expenses and the accrual');

    // same-month corrections: credit note, cancel, vendor return + refund
    clock = day(M1, 12);
    ok(await creditNote(ids.invA), 'credit note A');
    clock = day(M1, 13);
    ok(await post(`/api/transactions/invoices/${ids.invB}/cancel`), 'cancel invoice B');
    clock = day(M1, 14);
    ok(await post('/api/inventory/purchase-returns', { returnData: { grnId: ids.grn1, items: [{ productId: P, quantityReturned: 2 }] } }), 'vendor return');
    clock = day(M1, 16);
    ok(await post('/api/inventory/vendor-refunds', { vendorId, bankId, amount: 230, date: clock }), 'vendor refund');
    clock = day(M1, 18);
    ok(await post('/api/inventory/stock-adjustments', { productId: P, warehouseId, quantity: -1, reason: 'Damaged' }), 'adjustment');
    clock = day(M1, 20);
    ok(await post(`/api/expenses/${ids.e2}/pay`, { date: clock, bankId, amount: 200 }), 'part-pay expense');
    clock = day(M1, 25);
    ids.invC = await invoice([line(P, 'Stock sale C', 4, 150)], 0);              // 600 + 90 VAT
    clock = day(M1, 27);
    ok(await post(`/api/transactions/invoices/${ids.invC}/paid`, { paymentDate: clock, bankId, amount: 400 }), 'collect C');
    clock = day(M1, 28);
    await checkAll('end of the first month');

    // hand-worked: revenue 300 (POS) + 600 (C) = 900; cost 200 + 400 + 100 (adjustment) = 700; expenses 200 + 300 + 200 (accrual) = 700
    const pl = await rep('profit-loss', `startDate=${day(M1, 1)}&endDate=${day(M1, 28)}&basis=Accrual`);
    expect([pl.totalRevenue, pl.costOfGoodsSold, pl.totalExpenses, pl.netProfit]).toEqual([900, 700, 700, -500]);
    ok(await closeMonth(M1), 'close first month');
    await checkAll('first month closed');
    const afterClose = await rep('profit-loss', `startDate=${day(M1, 1)}&endDate=${day(M1, 28)}&basis=Accrual`);
    expect(afterClose.netProfit).toBe(-500);
  }, 180000);

  it('second month: corrections of the CLOSED month land today; locked documents refuse cancellation', async () => {
    expect(clockEnabled).toBe(true);
    clock = day(M2, 2);
    ok(await patch(`/api/transactions/recurring-templates/${ids.tpl}/toggle`), 'rent template off');
    // credit note against an invoice of the closed month: allowed, dated today, in this month
    const cn = await creditNote(ids.invC);
    expect(cn.status, JSON.stringify(cn.body)).toBe(200);
    const note = ((await db.select().from(schema.invoices).where(eq(schema.invoices.originalInvoiceId, ids.invC))) as any[])[0];
    expect(note.date).toBe(day(M2, 2));
    await checkAll('credit note against a closed-month invoice');

    // an expense of the closed month cannot be cancelled; it is reversed by a document dated today
    clock = day(M2, 3);
    const cancel = await post(`/api/expenses/${ids.e1}/cancel`);
    expect(cancel.status).toBe(400);
    expect(cancel.body.error).toMatch(/closed fiscal month/i);
    const rev = await post(`/api/expenses/${ids.e1}/reverse`);
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    const twice = await post(`/api/expenses/${ids.e1}/reverse`);
    expect(twice.status).toBe(400);
    await checkAll('reversal of a closed-month expense');
    clock = day(M2, 4);
    ok(await post('/api/inventory/vendor-refunds', { vendorId, bankId, amount: 230, date: clock }), 'refund of the reversed paid expense');

    // settle the accrual with the real, larger invoice
    clock = day(M2, 5);
    ok(await post('/api/transactions/settle-accrual', { accrualExpenseId: ids.accrual, actualAmount: 276, actualDate: clock, paymentStatus: 'Paid', bankId }), 'settle accrual');
    await checkAll('accrual settled');

    // return of a unit from the (paid) bill of the closed month, refund, new purchase and sale
    clock = day(M2, 6);
    ok(await post('/api/inventory/purchase-returns', { returnData: { grnId: ids.grn1, items: [{ productId: P, quantityReturned: 1 }] } }), 'second vendor return');
    clock = day(M2, 7);
    ok(await post('/api/inventory/vendor-refunds', { vendorId, bankId, amount: 115, date: clock }), 'second refund');
    clock = day(M2, 8);
    ids.grn2 = await grn(10);
    ids.bill2 = await bill(ids.grn2);
    clock = day(M2, 10);
    ids.invD = await invoice([line(P, 'Stock sale D', 5, 150)], 0);
    clock = day(M2, 12);
    ok(await post(`/api/transactions/invoices/${ids.invD}/paid`, { paymentDate: clock, bankId, amount: 862.5 }), 'collect D');
    clock = day(M2, 15);
    ids.invE = await invoice([line(S, 'Service E', 1, 400)], 0);
    clock = day(M2, 16);
    ok(await post(`/api/transactions/invoices/${ids.invE}/cancel`), 'cancel E in its own month');
    clock = day(M2, 20);
    await payBill(ids.bill2, 1150);
    await checkAll('end of the second month');
    clock = day(M2, 28);
    ok(await closeMonth(M2), 'close second month');
    await checkAll('second month closed');
  }, 180000);

  it('third month: every document type, and every attempt to reach back into the closed months is refused', async () => {
    expect(clockEnabled).toBe(true);
    // ---- the closed months (first and second) are locked: nothing can cancel, reverse or drop their documents ----
    clock = day(M3, 3);
    const snap = async () => {
      const a = await rep('profit-loss', `startDate=${day(M1, 1)}&endDate=${day(M1, 28)}&basis=Accrual`);
      const b = await rep('profit-loss', `startDate=${day(M2, 1)}&endDate=${day(M2, 28)}&basis=Accrual`);
      const v = await rep('vat-return-summary', `startDate=${day(M1, 1)}&endDate=${day(M2, 28)}`);
      return JSON.stringify([a.totalRevenue, a.costOfGoodsSold, a.totalExpenses, b.totalRevenue, b.costOfGoodsSold, b.totalExpenses, v.outputVat, v.inputVat]);
    };
    const before = await snap();
    const locked = async (label: string, run: () => Promise<{ status: number; body: any }>) => {
      const r = await run();
      expect(r.status, `${label}: ${JSON.stringify(r.body).slice(0, 160)}`).toBe(400);
      expect(await snap(), `${label} changed a closed month`).toBe(before);
    };
    await locked('cancel an invoice of a closed month', () => post(`/api/transactions/invoices/${ids.invD}/cancel`));
    await locked('cancel an expense of a closed month', () => post(`/api/expenses/${ids.e2}/cancel`));
    await locked('cancel a bill of a closed month', () => patch(`/api/inventory/purchase-bills/${ids.bill2}/cancel`));
    await locked('reverse a receipt of a closed month', () => post(`/api/inventory/goods-receipt-notes/${ids.grn2}/reverse`));
    await locked('delete an accrual of a closed month', () => api(`/api/transactions/accruals/${ids.accrual}`, { method: 'DELETE' }));
    // late MONEY and returns are new events dated today: allowed, and the closed months stay exactly as they were
    const allowed = async (label: string, run: () => Promise<{ status: number; body: any }>) => {
      const r = await run();
      expect(r.status, `${label}: ${JSON.stringify(r.body).slice(0, 160)}`).toBe(200);
      expect(await snap(), `${label} changed a closed month`).toBe(before);
    };
    await allowed('pay what is still owed on an expense of a closed month', () => post(`/api/expenses/${ids.e2}/pay`, { date: clock, bankId, amount: 145 }));
    await allowed('return a unit to the vendor from a bill of a closed month', () => post('/api/inventory/purchase-returns', { returnData: { grnId: ids.grn2, items: [{ productId: P, quantityReturned: 1 }] } }));
    await checkAll('after every attempt on the closed months');

    // ---- the remaining document types, all in this open month ----
    clock = day(M3, 5);
    ids.invF = await invoice([line(P, 'Stock sale F', 3, 150)], 517.5);
    ids.e4 = await expense('Story opex M3', 460, { paymentStatus: 'Paid', amountPaid: 460, paymentDate: clock });
    // quotation -> invoice
    clock = day(M3, 6);
    ok(await post('/api/transactions/quotations', { quotationData: { date: clock, customerId, taxSlabId, notes: 'Story quote', status: 'Accepted', createdById: userId, items: [{ id: generateId(), description: 'Quoted service', unitCost: 200, quantity: 1, unit: 'PCE', productId: S }] } }), 'quotation');
    const quotationId = ((await db.select().from(schema.quotations).where(eq(schema.quotations.companyId, companyId))) as any[])[0].id;
    clock = day(M3, 7);
    ok(await post(`/api/transactions/quotations/${quotationId}/convert`, { invoiceDate: clock, bankId, paymentStatus: 'Unpaid', customCustomerId: customerId, customTaxSlabId: taxSlabId }), 'convert quotation');
    await checkAll('quotation converted');
    // a receipt reversed while unbilled; a bill cancelled; a vendor return cancelled
    clock = day(M3, 8);
    const grnX = await grn(4);
    clock = day(M3, 9);
    ok(await post(`/api/inventory/goods-receipt-notes/${grnX}/reverse`), 'reverse an unbilled receipt');
    clock = day(M3, 10);
    const grnY = await grn(5);
    const billY = await bill(grnY);
    clock = day(M3, 11);
    ok(await patch(`/api/inventory/purchase-bills/${billY}/cancel`), 'cancel a bill in its own month');
    clock = day(M3, 12);
    const ret = ok(await post('/api/inventory/purchase-returns', { returnData: { grnId: grnY, items: [{ productId: P, quantityReturned: 1 }] } }), 'return of an unbilled receipt').purchaseReturn;
    clock = day(M3, 13);
    ok(await patch(`/api/inventory/purchase-returns/${ret.id}/cancel`), 'cancel that return');
    await checkAll('reversal, bill cancel and return cancel');
    // POS sale then a partial POS return
    clock = day(M3, 14);
    const posId = await invoice([line(P, 'POS to part-return', 3, 150)], 517.5, { isPosSale: true });
    const posItem = ((await db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, posId))) as any[])[0];
    clock = day(M3, 15);
    ok(await post('/api/pos/returns', { invoiceId: posId, items: [{ invoiceItemId: posItem.id, quantity: 1 }], reason: 'Changed mind' }), 'partial POS return');
    await checkAll('partial POS return');
    // stock between warehouses, a requisition, a count that finds one missing, an expense cancelled in its own month
    clock = day(M3, 16);
    const disp = ok(await post('/api/inventory/warehouse-dispatches', { dispatchData: { fromWarehouseId: warehouseId, toWarehouseId: warehouse2Id, dispatchedBy: 'T', vehicleNumber: 'V', driverName: 'D', items: [{ productId: P, quantityDispatched: 3, batchNumber: null }] } }), 'dispatch').dispatch;
    ok(await post('/api/inventory/warehouse-receivings', { receivingData: { dispatchId: disp.id, receivedBy: 'T', items: [{ dispatchItemId: disp.items[0].id }] } }), 'receiving');
    const disp2 = ok(await post('/api/inventory/warehouse-dispatches', { dispatchData: { fromWarehouseId: warehouseId, toWarehouseId: warehouse2Id, dispatchedBy: 'T', vehicleNumber: 'V2', driverName: 'D', items: [{ productId: P, quantityDispatched: 2, batchNumber: null }] } }), 'dispatch 2').dispatch;
    ok(await post(`/api/inventory/warehouse-dispatches/${disp2.id}/cancel`), 'cancel a dispatch');
    clock = day(M3, 17);
    ok(await post('/api/inventory/purchase-requisitions', { prData: { requestedBy: 'Story', notes: 'Restock', items: [{ productId: P, quantity: 10, purpose: 'Stock' }] } }), 'requisition');
    const w1 = ((await db.select().from(schema.inventoryStocks).where(eq(schema.inventoryStocks.warehouseId, warehouseId))) as any[])[0];
    const take = ok(await post('/api/inventory/stock-takes', { stockTakeData: { warehouseId, performedBy: 'Story', items: [{ productId: P, physicalQuantity: Number(w1.quantity) - 1 }] } }), 'stock take').stockTake;
    ok(await post(`/api/inventory/stock-takes/${take.id}/finalize`), 'finalize the count');
    clock = day(M3, 18);
    const eX = await expense('Story expense to cancel', 115, { paymentStatus: 'Paid', amountPaid: 115, paymentDate: clock });
    clock = day(M3, 19);
    ok(await post(`/api/expenses/${eX}/cancel`), 'cancel an expense in its own month');
    ok(await post('/api/inventory/stock-adjustments', { productId: P, warehouseId, quantity: 2, reason: 'Found stock' }), 'found stock');
    clock = day(M3, 20);
    ids.invG = await invoice([line(S, 'Service G', 2, 400)], 0);
    await checkAll('end of the third month');
  }, 180000);

  it('the quarter is closed, its VAT return generated and filed, and the next quarter starts', async () => {
    expect(clockEnabled).toBe(true);
    clock = day(M3, 28);
    ok(await closeMonth(M3), 'close third month');
    await checkAll('quarter closed');

    // the VAT return of the quarter: generated, then it freezes the quarter, then filed
    clock = day(N1, 3);
    const gen = await post('/api/tax-returns/generate', { year: Number(M1.slice(0, 4)), quarter });
    expect(gen.status, JSON.stringify(gen.body)).toBe(200);
    const sales = await rep('sales-vat', `startDate=${day(M1, 1)}&endDate=${day(M3, 31)}`);
    const purchases = await rep('purchase-vat', `startDate=${day(M1, 1)}&endDate=${day(M3, 31)}`);
    expect(near(gen.body.taxReturn.figuresSnapshot.outputVat, sales.totals.taxAmount)).toBe(true);
    expect(near(gen.body.taxReturn.figuresSnapshot.inputVat, purchases.totals.taxAmount)).toBe(true);
    ok(await post(`/api/tax-returns/${gen.body.taxReturn.id}/file`), 'file the return');
    await checkAll('quarter filed');

    // next quarter: its first month is opened; a credit note for a filed-quarter invoice is dated today, in the new quarter
    ok(await post('/api/transactions/months', { id: N1, name: `Month ${N1}`, status: 'Open' }), 'open next quarter');
    const lateNote = await creditNote(ids.invF);
    expect(lateNote.status, JSON.stringify(lateNote.body)).toBe(200);
    const stuck = await post('/api/expenses', { date: day(M3, 15), vendorId, taxSlabId, bankId, status: 'Active', type: 'Actual', billNumber: 'LATE', description: 'late', paymentStatus: 'Unpaid', amount: 115 });
    expect(stuck.status).toBe(400);
    await checkAll('next quarter, after a credit note for a filed-quarter invoice');
    const filedNow = await rep('vat-return-summary', `startDate=${day(M1, 1)}&endDate=${day(M3, 31)}`);
    expect(near(filedNow.outputVat, gen.body.taxReturn.figuresSnapshot.outputVat)).toBe(true);   // the filed quarter did not move
  }, 180000);
});
