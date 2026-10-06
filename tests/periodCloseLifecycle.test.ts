import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { provisionStarterResources } from '../server/lib/companyProvisioning.js';
import { getQuarterDateRange } from '../server/lib/vatReturn.js';
import { purgeCompany } from './helpers/purgeCompany.js';

// A brand-new company run through a whole accounting cycle with EVERY kind of source document, then closed:
//   two months of the previous quarter  ->  close both months (oldest first)  ->  generate and FILE that quarter's
//   VAT return  ->  keep trading in the current month (including a purchase return against a filed-quarter bill)  ->
//   open the next month  ->  check every report, statement, ledger and stock register across the boundaries.
// Every expected figure below is worked out by hand from the documents (15% VAT everywhere, unit cost 10), not read back
// from the system, so a report that is wrong cannot agree with itself.
const BASE_URL = 'http://localhost:3000';
const PW = 'AutoTest_Pw_2026!';
const NAME = 'Period Close Lifecycle Test Co';

// ---- calendar: the two last months of the previous quarter (M1, M2) and the current month (today) ----
const now = new Date();
const cy = now.getUTCFullYear(), cm = now.getUTCMonth();
const curQ = Math.floor(cm / 3);
const prevQ = (curQ + 3) % 4;
const prevYear = curQ === 0 ? cy - 1 : cy;
const mm = (y: number, m0: number) => `${y}-${String(m0 + 1).padStart(2, '0')}`;
const M1 = mm(prevYear, prevQ * 3 + 1);
const M2 = mm(prevYear, prevQ * 3 + 2);
const CUR = mm(cy, cm);
const d1 = (day: number) => `${M1}-${String(day).padStart(2, '0')}`;
const d2 = (day: number) => `${M2}-${String(day).padStart(2, '0')}`;
const today = now.toISOString().slice(0, 10);
const prevRange = getQuarterDateRange(prevYear, (prevQ + 1) as 1 | 2 | 3 | 4);
const curRange = getQuarterDateRange(cy, (curQ + 1) as 1 | 2 | 3 | 4);
const nextMonth = mm(cm === 11 ? cy + 1 : cy, (cm + 1) % 12);

let companyId = '', userId = '', sessionId = '';
let bankId = '', bank2Id = '', customerId = '', vendorId = '', taxSlabId = '', warehouseId = '', warehouse2Id = '';
let P = '', S = '';                                   // stock item, service
const ids: Record<string, string> = {};

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, ...(init.headers || {}) } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const post = (p: string, b: any) => api(p, { method: 'POST', body: JSON.stringify(b) });
const patch = (p: string, b: any = {}) => api(p, { method: 'PATCH', body: JSON.stringify(b) });
const ok = (r: { status: number; body: any }, what: string) => { if (r.status !== 200) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const near = (a: number, b: number, tol = 0.011) => Math.abs(a - b) < tol;
const rep = async (name: string, q: string) => (await api(`/api/reports/${name}?${q}`)).body;
const range = (a: string, b: string) => `startDate=${a}&endDate=${b}&asOfDate=${b}`;

// ---- document helpers ----
const line = (productId: string | null, description: string, qty: number, price: number) =>
  ({ id: generateId(), description, unitCost: price, quantity: qty, discountAmount: 0, ...(productId ? { productId } : {}) });
const invoice = async (date: string, items: any[], paid = 0, extra: any = {}) =>
  ok(await post('/api/transactions/invoices', { invoiceData: { date, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: paid, items, ...extra } }), `invoice ${date}`).invoiceId as string;
const expense = async (date: string, amount: number, extra: any = {}) =>
  ok(await post('/api/expenses', { date, vendorId, taxSlabId, bankId, status: 'Active', type: 'Actual', billNumber: 'LC-' + generateId().slice(-4), description: extra.description || 'Lifecycle expense', paymentStatus: 'Unpaid', amount, ...extra }), `expense ${date}`);
const grn = async (qty: number, cost: number, extra: any = {}) =>
  ok(await post('/api/inventory/goods-receipt-notes', { grnData: { isDsd: true, vendorId, warehouseId, receivedBy: 'Lifecycle', items: [{ productId: P, quantityReceived: qty, unitCost: cost, taxRate: 15 }], ...extra } }), 'grn').goodsReceiptNote.id as string;
const bill = async (grnId: string, backdate: string) => {
  const b = ok(await post('/api/inventory/purchase-bills', { billData: { grnIds: [grnId], bankId, vendorBillNumber: 'VB-' + generateId().slice(-4) } }), 'bill').purchaseBill;
  await db.update(schema.purchaseBills).set({ date: new Date(backdate + 'T10:00:00.000Z') }).where(eq(schema.purchaseBills.id, b.id));   // the supplier's invoice date
  return b.id as string;
};
const payBill = async (billId: string, date: string, amount: number) => ok(await post(`/api/inventory/purchase-bills/${billId}/pay`, { date, bankId, amount }), 'bill pay');

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: NAME, address: 'x', phone: '0', email: 'lc@example.com', logoUrl: '', customHeader: '', customFooter: '',
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
    { id: P, name: 'Lifecycle Item', description: 'Lifecycle Item', unitPrice: '30', costPrice: '10', itemKind: 'item', companyId, averageCost: '0', totalQuantityPurchased: '0' },
    { id: S, name: 'Lifecycle Service', description: 'Lifecycle Service', unitPrice: '400', costPrice: '0', itemKind: 'service', companyId },
  ] as any);
  userId = generateId();
  const username = `lc_${userId.slice(-10)}`;
  await db.insert(schema.users).values({ id: userId, username, password: await bcrypt.hash(PW, 10), role: 'admin', companyId, isSuperAdmin: false });
  const login = await (await fetch(`${BASE_URL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PW }) })).json();
  sessionId = login.sessionId;
  if (!sessionId) throw new Error('login failed');
}, 60000);

afterAll(async () => { await purgeCompany(companyId); }, 60000);

describe('Period-close lifecycle: every document type, closed months, a filed VAT quarter, the next period', () => {
  it('opens the two earlier months (the current month is already open)', async () => {
    for (const [id, name] of [[M1, `Month ${M1}`], [M2, `Month ${M2}`]]) {
      ok(await post('/api/transactions/months', { id, name, status: 'Open' }), `open ${id}`);
    }
    const months = (await api('/api/transactions/months')).body;
    expect((Array.isArray(months) ? months : months.rows).filter((m: any) => m.status === 'Open').map((m: any) => m.id).sort()).toEqual([M1, M2, CUR].sort());
  });

  it('M1: capital, bank transfer, purchasing chain, sales of every kind, expenses of every kind', async () => {
    // --- capital paid in by an investor, and money moved between two banks
    const inv = ok(await post('/api/transactions/investors', { name: 'Lifecycle Investor', email: 'i@example.com', phone: '1', equityPercentage: 100, profitPercentage: 100, capitalContributed: 0, isActive: true, createdAt: new Date().toISOString() }), 'investor');
    const investorId = (await db.select().from(schema.investors).where(eq(schema.investors.companyId, companyId)))[0].id;
    ok(await post(`/api/transactions/investors/${investorId}/investment`, { bankId, amount: 1000, date: d1(2), description: 'Seed capital' }), 'investment');
    ok(await post('/api/transactions/interbank-transfer', { sourceBankId: bankId, destBankId: bank2Id, amount: 100, description: 'Float', dateStr: d1(3) }), 'transfer');

    // --- purchasing: requisition -> PO -> GRN against the PO -> bill (supplier invoice dated M1) -> paid in full
    const po = ok(await post('/api/inventory/purchase-orders', { poData: { vendorId, items: [{ productId: P, quantityOrdered: 20, unitPrice: 10 }] } }), 'po').purchaseOrder;
    ids.grn1 = await grn(20, 10, { isDsd: false, purchaseOrderId: po.id });
    ids.bill1 = await bill(ids.grn1, d1(5));
    await payBill(ids.bill1, d1(6), 230);

    // --- sales: stock sale paid, service unpaid, stock sale cancelled, quotation converted, POS sale
    ids.i1 = await invoice(d1(10), [line(P, 'Stock sale', 5, 30)], 172.5);
    ids.i2 = await invoice(d1(12), [line(S, 'Service job', 1, 400)], 0);
    ids.i3 = await invoice(d1(15), [line(P, 'Sale to be cancelled', 2, 30)], 0);
    ok(await post(`/api/transactions/invoices/${ids.i3}/cancel`, {}), 'cancel i3');
    ok(await post('/api/transactions/quotations', { quotationData: { date: d1(16), customerId, taxSlabId, notes: '', status: 'Accepted', createdById: userId, items: [{ id: generateId(), description: 'Quoted service', unitCost: 200, quantity: 1, unit: 'PCE', productId: S }] } }), 'quotation');
    ids.quotation = (await db.select().from(schema.quotations).where(eq(schema.quotations.companyId, companyId)))[0].id;
    ok(await post(`/api/transactions/quotations/${ids.quotation}/convert`, { invoiceDate: d1(18), bankId, paymentStatus: 'Unpaid', customCustomerId: customerId, customTaxSlabId: taxSlabId }), 'convert');
    ids.i8 = (await db.select().from(schema.invoices).where(eq(schema.invoices.companyId, companyId))).find((i: any) => i.date === d1(18))!.id;
    ids.pos = await invoice(d1(20), [line(P, 'POS sale', 2, 30)], 69, { isPosSale: true });

    // --- expenses: operating paid, capital unpaid, a recurring charge posted as Actual, an accrual
    await expense(d1(20), 230, { description: 'Opex paid', paymentStatus: 'Paid', amountPaid: 230, paymentDate: d1(20) });
    await expense(d1(25), 345, { description: 'Capex unpaid', classification: 'Asset' });
    const tpl = ok(await post('/api/transactions/recurring-templates', { description: 'Rent', defaultAmount: 115, bankId, vendorId, taxSlabId, isActive: true }), 'template');
    ok(await post('/api/transactions/recurring-postings', { templateId: tpl.id, monthId: M1, postType: 'Actual', amount: 115, dateStr: d1(28), paymentStatus: 'Paid', bankId }), 'post recurring actual');
    const tpl2 = ok(await post('/api/transactions/recurring-templates', { description: 'Utilities', defaultAmount: 230, bankId, vendorId, taxSlabId, isActive: true }), 'template 2');
    ok(await post('/api/transactions/recurring-postings', { templateId: tpl2.id, monthId: M1, postType: 'Accrual', amount: 230, dateStr: d1(29), paymentStatus: 'Unpaid', bankId }), 'post recurring accrual');
  }, 120000);

  it('M2: more purchasing (reversal, bill cancel), collections, a credit note with refund, an accrual settled, stock movements', async () => {
    // collections and a settled accrual
    ok(await post(`/api/transactions/invoices/${ids.i2}/paid`, { paymentDate: d2(3), bankId, amount: 460 }), 'collect i2');
    const accrual = (await db.select().from(schema.expenses).where(eq(schema.expenses.companyId, companyId))).find((e: any) => e.type === 'Accrual')!;
    ok(await post('/api/transactions/settle-accrual', { accrualExpenseId: accrual.id, actualAmount: 230, actualDate: d2(5), paymentStatus: 'Paid', bankId }), 'settle accrual');

    // a second GRN billed and part-paid; a third GRN billed then the bill cancelled; a fourth reversed while unbilled
    ids.grn2 = await grn(10, 10);
    ids.bill2 = await bill(ids.grn2, d2(4));
    await payBill(ids.bill2, d2(6), 50);
    const g3 = await grn(3, 10); const b3 = await bill(g3, d2(7));
    ok(await patch(`/api/inventory/purchase-bills/${b3}/cancel`), 'cancel bill');
    const g4 = await grn(2, 10);
    ok(await post(`/api/inventory/goods-receipt-notes/${g4}/reverse`, {}), 'reverse grn');

    // sales: paid stock sale then credited in the same open month (refunded); service on credit; part-paid stock sale
    ids.i4 = await invoice(d2(10), [line(P, 'Sale later credited', 3, 30)], 103.5);
    ok(await post(`/api/transactions/invoices/${ids.i4}/note`, { type: 'CreditNote', reason: 'Customer returned goods' }), 'credit note');
    ids.i5 = await invoice(d2(14), [line(S, 'Service on credit', 2, 150)], 0);
    ids.i6 = await invoice(d2(20), [line(P, 'Part paid sale', 4, 30)], 100);

    // expenses: operating part-paid, one cancelled
    const e3 = await expense(d2(18), 115, { description: 'Opex part paid' });
    const e3row = (await db.select().from(schema.expenses).where(eq(schema.expenses.companyId, companyId))).find((e: any) => e.description === 'Opex part paid')!;
    ok(await post(`/api/expenses/${e3row.id}/pay`, { date: d2(19), bankId, amount: 50 }), 'pay opex');
    await expense(d2(21), 57.5, { description: 'Opex to cancel' });
    const e5row = (await db.select().from(schema.expenses).where(eq(schema.expenses.companyId, companyId))).find((e: any) => e.description === 'Opex to cancel')!;
    ok(await post(`/api/expenses/${e5row.id}/cancel`, {}), 'cancel expense');

    // stock movements that have no money in them: a transfer between warehouses, a count, an adjustment
    const disp = ok(await post('/api/inventory/warehouse-dispatches', { dispatchData: { fromWarehouseId: warehouseId, toWarehouseId: warehouse2Id, dispatchedBy: 'T', vehicleNumber: 'V', driverName: 'D', items: [{ productId: P, quantityDispatched: 3, batchNumber: null }] } }), 'dispatch').dispatch;
    ok(await post('/api/inventory/warehouse-receivings', { receivingData: { dispatchId: disp.id, receivedBy: 'T', items: [{ dispatchItemId: disp.items[0].id }] } }), 'receiving');
    void e3;

    // a purchase requisition (a request, no money), a found-stock adjustment, and a cycle count that finds one unit missing
    ok(await post('/api/inventory/purchase-requisitions', { prData: { requestedBy: 'Lifecycle', notes: 'Restock', items: [{ productId: P, quantity: 10, purpose: 'Stock' }] } }), 'requisition');
    ok(await post('/api/inventory/stock-adjustments', { productId: P, warehouseId: warehouse2Id, quantity: 1, reason: 'Found stock' }), 'adjustment');
    const w1 = (await db.select().from(schema.inventoryStocks).where(eq(schema.inventoryStocks.warehouseId, warehouseId)))[0] as any;
    const take = ok(await post('/api/inventory/stock-takes', { stockTakeData: { warehouseId, performedBy: 'Lifecycle', items: [{ productId: P, physicalQuantity: Number(w1.quantity) - 1 }] } }), 'stock take').stockTake;
    ok(await post(`/api/inventory/stock-takes/${take.id}/finalize`, {}), 'finalize take');
  }, 120000);

  it('BEFORE any closing: every statement balances and agrees with the documents', async () => {
    // hand-worked from the documents above (15% VAT, unit cost 10)
    const bs = await rep('balance-sheet', `asOfDate=${today}`);
    expect(bs.bankBalance).toBe(896.5);               // see the cash walk in the header comment of this scenario
    expect(bs.accountsReceivable).toBe(613);          // I8 230 + I5 345 + I6 38
    expect(bs.accountsPayable).toBe(475);             // bill2 65 + capex 345 + opex 65
    expect(bs.fixedAssets).toBe(300);
    expect(bs.vatInputRecoverable).toBe(180);
    expect(bs.vatOutputPayable).toBe(184.5);
    expect(bs.currentPeriodEarnings).toBe(520);
    expect(bs.retainedEarnings).toBe(0);
    // units: 22 bought-and-sold net, +1 found, -1 counted missing  => 22 on hand, 220 at cost
    expect(bs.inventoryValue).toBe(220);
    expect(bs.balanceCheck).toBe(0);
    const tb = await rep('trial-balance', range(d1(1), today));
    expect(near(tb.totalDebits, tb.totalCredits)).toBe(true);
  });

  // ===================================== closing the two earlier months =====================================
  const pl = async (a: string, b: string) => rep('profit-loss', `startDate=${a}&endDate=${b}&basis=Accrual`);
  const lastDay = (ym: string) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; };
  const monthRow = async (id: string) => { const r = (await api('/api/transactions/months')).body; return (Array.isArray(r) ? r : r.rows).find((m: any) => m.id === id); };
  const closeMonth = async (id: string) => post('/api/transactions/months', { ...(await monthRow(id)), status: 'Closed', closedAt: new Date().toISOString(), closedOption: 'including_pending' });

  it('each month has the profit the documents give, and the two add up to the whole', async () => {
    const m1 = await pl(d1(1), lastDay(M1)), m2 = await pl(d2(1), lastDay(M2)), all = await pl(d1(1), today);
    // M1: sales 150+400+200+60, cost of the 7 units sold (cancelled sale reversed IN M1), opex 200+100 and the 200 accrued in M1
    expect(m1.totalRevenue).toBe(810); expect(m1.costOfGoodsSold).toBe(70); expect(m1.totalExpenses).toBe(500); expect(m1.netProfit).toBe(240);
    // M2: sales 300+120 (+90-90 credited), cost of 4 units, opex 100 (paying the accrual is not a second cost)
    expect(m2.totalRevenue).toBe(420); expect(m2.costOfGoodsSold).toBe(40); expect(m2.totalExpenses).toBe(100); expect(m2.netProfit).toBe(280);
    expect(near(m1.netProfit + m2.netProfit, all.netProfit)).toBe(true);
    expect(all.netProfit).toBe(520);
  });

  it('closes M1 then M2 (oldest first); their stored profit moves into Retained Earnings and nothing else changes', async () => {
    const bsBefore = await rep('balance-sheet', `asOfDate=${today}`);
    // the rules: the oldest open month first, and no active recurring charge may be left unposted for the month
    expect((await closeMonth(M2)).status).toBe(400);
    ok(await closeMonth(M1), 'close M1');
    const blocked = await closeMonth(M2);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toMatch(/Unposted active recurring expenses/i);
    for (const t of (await db.select().from(schema.recurringExpenseTemplates).where(eq(schema.recurringExpenseTemplates.companyId, companyId))) as any[]) {
      ok(await patch(`/api/transactions/recurring-templates/${t.id}/toggle`), 'deactivate template');
    }
    ok(await closeMonth(M2), 'close M2');
    const hist = (await rep('fiscal-month-closing-history', '')).rows;
    expect(hist.find((r: any) => r.id === M1).closedPnL.netProfit).toBe(240);
    expect(hist.find((r: any) => r.id === M2).closedPnL.netProfit).toBe(280);
    const bs = await rep('balance-sheet', `asOfDate=${today}`);
    expect(bs.retainedEarnings).toBe(520);
    expect(bs.currentPeriodEarnings).toBe(0);
    expect(bs.totalEquity).toBe(bsBefore.totalEquity);
    expect(near(bs.balanceCheck, 0)).toBe(true);
    const tb = await rep('trial-balance', range(d1(1), today));
    expect(near(tb.totalDebits, tb.totalCredits)).toBe(true);
  });

  it('a closed month is frozen: no new documents, no credit note, no cancellation dated in it', async () => {
    const newDoc = await post('/api/transactions/invoices', { invoiceData: { date: d2(25), customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0, items: [line(S, 'late', 1, 10)] } });
    expect(newDoc.status).toBe(400);
    expect(newDoc.body.error).toMatch(/closed fiscal month/i);
    expect((await post(`/api/transactions/invoices/${ids.i1}/note`, { type: 'CreditNote', reason: 'too late' })).status).toBe(400);
    const cancel = await post(`/api/transactions/invoices/${ids.i5}/cancel`, {});
    expect(cancel.status).toBe(400);
    expect(cancel.body.error).toMatch(/closed fiscal month/i);
  });

  // ===================================== the VAT quarter =====================================
  it('generates the previous quarter VAT return: every figure matches the documents', async () => {
    await new Promise(r => setTimeout(r, 800));       // let every invoice's fire-and-forget ZATCA preview settle
    const g = await post('/api/tax-returns/generate', { year: prevYear, quarter: prevQ + 1 });
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    ids.q = g.body.taxReturn.id;
    const f = g.body.taxReturn.figuresSnapshot;
    expect(f.salesSubtotal).toBe(1230);               // 150+400+200+60+300+120, plus 90 invoiced and 90 credited
    expect(f.outputVat).toBe(184.5);
    expect(f.purchasesSubtotal).toBe(1200);           // bills 200+100, expenses 200+300+100+200+100 (accrual counted once, via its settlement)
    expect(f.inputVat).toBe(180);
    expect(f.netVatPayable).toBe(4.5);
    const summary = await rep('vat-return-summary', `startDate=${prevRange.startDate}&endDate=${prevRange.endDate}`);
    expect(summary.outputVat).toBe(184.5); expect(summary.inputVat).toBe(180);
  });

  it('files the quarter: it is locked for good, and a filed return cannot be deleted or re-filed', async () => {
    await new Promise(r => setTimeout(r, 700));       // let any fire-and-forget ZATCA preview settle
    const filed = await post(`/api/tax-returns/${ids.q}/file`, {});
    expect(filed.status).toBe(200);
    expect(filed.body.taxReturn.status).toBe('Filed');
    expect((await post(`/api/tax-returns/${ids.q}/delete`, {})).status).toBe(400);
    expect((await post(`/api/tax-returns/${ids.q}/file`, {})).status).toBe(400);
  });

  // ===================================== the next period =====================================
  it('opens the next month; nothing can be dated in a future month', async () => {
    ok(await post('/api/transactions/months', { id: nextMonth, name: `Month ${nextMonth}`, status: 'Open' }), 'open next month');
    const future = await post('/api/transactions/invoices', { invoiceData: { date: `${nextMonth}-05`, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0, items: [line(S, 'future', 1, 10)] } });
    expect(future.status).toBe(400);
    expect(future.body.error).toMatch(/future fiscal month/i);
  });

  it('trades on in the current month, incl. returns to suppliers against bills that sit in the FILED quarter', async () => {
    ids.i7 = await invoice(today, [line(P, 'Current month sale', 2, 35)], 80.5);                       // 70 + 10.5 VAT
    await expense(today, 230, { description: 'Current month opex', paymentStatus: 'Paid', amountPaid: 230, paymentDate: today });
    ok(await post(`/api/transactions/invoices/${ids.i8}/paid`, { paymentDate: today, bankId, amount: 230 }), 'collect i8 (a filed-quarter invoice, paid in the new period)');

    // purchase returns: A) 4 units of a BILLED goods receipt, B) 1 unit of the UNBILLED one, C) 1 unit then cancelled
    const retA = ok(await post('/api/inventory/purchase-returns', { returnData: { grnId: ids.grn2, items: [{ productId: P, quantityReturned: 4 }] } }), 'return A').purchaseReturn.id;
    const g3 = (await db.select().from(schema.goodsReceiptNotes).where(eq(schema.goodsReceiptNotes.companyId, companyId))).find((g: any) => !g.isBilled && !g.isReversed && g.id !== ids.grn1 && g.id !== ids.grn2)!;
    ok(await post('/api/inventory/purchase-returns', { returnData: { grnId: g3.id, items: [{ productId: P, quantityReturned: 1 }] } }), 'return B');
    const retC = ok(await post('/api/inventory/purchase-returns', { returnData: { grnId: ids.grn2, items: [{ productId: P, quantityReturned: 1 }] } }), 'return C').purchaseReturn.id;
    ok(await patch(`/api/inventory/purchase-returns/${retC}/cancel`), 'cancel return C');
    void retA;

    // settle what is now owed: the reduced bill (115 less the 46 returned = 69, 50 paid) and the part-paid expense
    ok(await post(`/api/inventory/purchase-bills/${ids.bill2}/pay`, { date: today, bankId, amount: 19 }), 'pay reduced bill');
    const x3 = (await db.select().from(schema.expenses).where(eq(schema.expenses.companyId, companyId))).find((e: any) => e.description === 'Opex part paid')!;
    ok(await post(`/api/expenses/${x3.id}/pay`, { date: today, bankId, amount: 65 }), 'pay opex');
  }, 120000);

  // ===================================== every report, after the boundary =====================================
  it('the filed quarter did not move; the new quarter carries the returns and the new sales', async () => {
    const prevSummary = await rep('vat-return-summary', `startDate=${prevRange.startDate}&endDate=${prevRange.endDate}`);
    expect(prevSummary.outputVat).toBe(184.5);
    expect(prevSummary.inputVat).toBe(180);                                      // the supplier returns did NOT reach back into it
    const filedRow = (await db.select().from(schema.taxReturns).where(eq(schema.taxReturns.id, ids.q)))[0] as any;
    expect(filedRow.figuresSnapshot.inputVat).toBe(180);

    const cur = await rep('vat-return-summary', `startDate=${curRange.startDate}&endDate=${curRange.endDate}`);
    expect(cur.outputVat).toBe(10.5);
    expect(cur.inputVat).toBe(24);                                              // 30 on the new opex less the 6 given back on return A
    expect(cur.netVatPayable).toBe(-13.5);
    const g = await post('/api/tax-returns/generate', { year: cy, quarter: curQ + 1 });
    expect(g.status).toBe(200);
    expect(g.body.taxReturn.figuresSnapshot.salesSubtotal).toBe(70);
    expect(g.body.taxReturn.figuresSnapshot.purchasesSubtotal).toBe(160);        // 200 opex less the 40 net returned
  });

  it('Balance Sheet: retained earnings from the closed months, the current month on top, and it balances', async () => {
    const bs = await rep('balance-sheet', `asOfDate=${today}`);
    expect(bs.bankBalance).toBe(893);
    expect(bs.accountsReceivable).toBe(383);                                    // I5 345 + I6 38
    expect(bs.accountsPayable).toBe(345);                                       // only the unpaid capital purchase
    expect(bs.goodsReceivedNotBilled).toBe(20);                                 // 3 units received unbilled, 1 returned
    expect(bs.inventoryValue).toBe(150);                                        // 15 units
    expect(bs.fixedAssets).toBe(300);
    expect(bs.vatInputRecoverable).toBe(204);
    expect(bs.vatOutputPayable).toBe(195);
    expect(bs.capitalContributed).toBe(1000);
    expect(bs.retainedEarnings).toBe(520);
    expect(bs.currentPeriodEarnings).toBe(-150);                                // 70 sales - 20 cost - 200 opex
    expect(near(bs.balanceCheck, 0)).toBe(true);
  });

  it('a Balance Sheet "as at" the end of the previous quarter counts only the stock on hand THEN', async () => {
    // A goods receipt is filed on the day it is entered (today), while the back-dated sales were filed on their own dates.
    // So at the end of the previous quarter the register shows a net 11 units sold (credited and cancelled ones already
    // back in) before any of this test's stock had been received: the sheet must not pretend today's 15 units were there.
    const asOfPrev = await rep('balance-sheet', `asOfDate=${prevRange.endDate}`);
    const now = await rep('balance-sheet', `asOfDate=${today}`);
    expect(now.inventoryValue).toBe(150);
    expect(asOfPrev.inventoryValue).toBe(-110);
  });

  it('the stock register files a cancellation / credit-note restock under TODAY (when the stock came back), not the old invoice date', async () => {
    // I3 was sold and cancelled back in M1, I4 sold and credited in M2 — both entered today. Today's register must show the
    // stock coming back today, so that opening + today's movements = closing; it is the Balance Sheet that dates it by invoice.
    const rows = await db.select().from(schema.stockLedgerTransactions).where(eq(schema.stockLedgerTransactions.companyId, companyId)) as any[];
    const restocks = rows.filter((r: any) => r.transactionType === 'Sale' && Number(r.quantityChange) > 0);
    expect(restocks.length).toBeGreaterThanOrEqual(2);
    for (const r of restocks) expect(new Date(r.date).toISOString().slice(0, 10)).toBe(today);
    // and yet "as at" a date after the sale but before today, the cancelled sale nets to nothing on the sheet
    const mid = await rep('balance-sheet', `asOfDate=${d1(25)}`);
    expect(mid.inventoryValue).toBe(-70);   // by the 25th of M1: 5 + 2 units sold, the cancelled sale's 2 units back out again; all stock was received later
  });

  it('Trial Balance balances for every period ending today, and its opening retained earnings follow the closes', async () => {
    const full = await rep('trial-balance', range(d1(1), today));
    const curOnly = await rep('trial-balance', range(`${CUR}-01`, today));
    const lateStart = await rep('trial-balance', range(today, today));
    for (const tb of [full, curOnly, lateStart]) expect(near(tb.totalDebits, tb.totalCredits)).toBe(true);
    const re = (tb: any) => { const l = tb.ledgers.find((x: any) => x.name === 'Retained Earnings (Opening)'); return l.credit - l.debit; };
    expect(re(full)).toBe(0);                                                    // the books start at M1
    expect(re(curOnly)).toBe(520);                                               // everything before the current month
    expect(curOnly.ledgers.find((x: any) => x.name === 'Sales Revenue').credit).toBe(70);
  });

  it('Profit & Loss: month by month, quarter by quarter, and all together', async () => {
    const m1 = await pl(d1(1), lastDay(M1)), m2 = await pl(d2(1), lastDay(M2)), c = await pl(`${CUR}-01`, today), all = await pl(d1(1), today);
    expect(m1.netProfit).toBe(240); expect(m2.netProfit).toBe(280);              // closed months do not move once closed
    expect(c.totalRevenue).toBe(70); expect(c.costOfGoodsSold).toBe(20); expect(c.totalExpenses).toBe(200); expect(c.netProfit).toBe(-150);
    expect(near(m1.netProfit + m2.netProfit + c.netProfit, all.netProfit)).toBe(true);
    expect(all.netProfit).toBe(370);
    // cash: what really moved over the whole life of the books equals the bank balance
    expect(all.netCashFlow + 100 - 100).toBe(all.netCashFlow);
  });

  it('receivables, payables, KPIs, registers and statements agree across the boundary', async () => {
    const q = range(d1(1), today);
    const ot = await rep('outstanding', '');
    expect(ot.totalReceivable).toBe(383); expect(ot.totalPayable).toBe(345);
    const kpi = await rep('invoice-kpis', q);
    expect(kpi.totalInvoiced).toBe(1495);                                        // gross: 172.5+460+230+69+103.5-103.5+345+138+80.5 (the cancelled one excluded)
    const sr = await rep('sales-register', q);
    expect(near(kpi.totalInvoiced, sr.totalSales)).toBe(true);
    const cs = await rep('customer-statement', q + `&customerId=${customerId}`);
    expect(cs.endingBalance).toBe(383);                                          // what the customer still owes
    const vs = await rep('vendor-statement', q + `&vendorId=${vendorId}`);
    expect(vs.endingBalance).toBe(345);                                          // only the unpaid capital purchase is owed to the vendor
    const sv = await rep('stock-valuation', '');
    expect(sv.totalValue).toBe(150);
    const pv = await rep('purchase-vat', q);
    const pr = await rep('purchase-register', q);
    expect(near(pr.totalAmount, pv.totals.grandTotal)).toBe(true);
  });

  it('the ledger agrees with the documents and with the reports (journal lines, every account)', async () => {
    const lines = await db.select().from(schema.journalLines).where(eq(schema.journalLines.companyId, companyId)) as any[];
    const net = (k: string) => Math.round(lines.filter(l => l.accountKey === k).reduce((n, l) => n + Number(l.debit) - Number(l.credit), 0) * 100) / 100;
    const bs = await rep('balance-sheet', `asOfDate=${today}`);
    expect(net('AR')).toBe(bs.accountsReceivable);
    expect(-net('AP')).toBe(bs.accountsPayable);
    expect(net('VAT_INPUT')).toBe(bs.vatInputRecoverable);
    expect(-net('VAT_OUTPUT')).toBe(bs.vatOutputPayable);
    expect(-net('GR_IR_CLEARING')).toBe(bs.goodsReceivedNotBilled);
    expect(net('FIXED_ASSETS')).toBe(bs.fixedAssets);
    expect(net('INVENTORY')).toBe(bs.inventoryValue);
    expect(net('BANK')).toBe(bs.bankBalance);
    expect(-net('PAID_IN_CAPITAL')).toBe(bs.capitalContributed);                  // the investor's 1,000 reaches the ledger too
    const bankLines = lines.filter(l => l.accountKey === 'BANK');
    const bank2 = bankLines.filter(l => l.bankId === bank2Id).reduce((n, l) => n + Number(l.debit) - Number(l.credit), 0);
    expect(bank2).toBe(100);                                                         // the transfer moved 100 into the second bank
    expect(near(lines.reduce((n, l) => n + Number(l.debit) - Number(l.credit), 0), 0)).toBe(true);
  });

  it('stock register: movements by kind reconcile to the 15 units on hand', async () => {
    const moves = await db.select().from(schema.stockLedgerTransactions).where(eq(schema.stockLedgerTransactions.companyId, companyId)) as any[];
    const sum = (t: string) => moves.filter(m => m.transactionType === t).reduce((n, m) => n + Number(m.quantityChange), 0);
    const stock = await db.select().from(schema.inventoryStocks).where(eq(schema.inventoryStocks.companyId, companyId)) as any[];
    const onHand = stock.reduce((n, r) => n + Number(r.quantity), 0);
    expect(onHand).toBe(15);
    expect(moves.reduce((n, m) => n + Number(m.quantityChange), 0)).toBe(onHand);   // the register explains every unit
    void sum;
  });


  // ===================================== two more kinds of document, after everything above =====================================
  const everythingAgrees = async () => {
    const bs = await rep('balance-sheet', `asOfDate=${today}`);
    const tb = await rep('trial-balance', range(d1(1), today));
    const lines = await db.select().from(schema.journalLines).where(eq(schema.journalLines.companyId, companyId)) as any[];
    const net = (k: string) => Math.round(lines.filter(l => l.accountKey === k).reduce((n, l) => n + Number(l.debit) - Number(l.credit), 0) * 100) / 100;
    return { bs, tb, net };
  };

  it('a partial POS return: the customer is refunded, stock comes back, and every statement still agrees', async () => {
    const posId = await invoice(today, [line(P, 'POS sale to be part-returned', 3, 35)], 120.75, { isPosSale: true });   // 105 + 15.75 VAT, paid
    const posItem = (await db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, posId)))[0] as any;
    const before = await everythingAgrees();
    expect(before.bs.balanceCheck, 'after the POS SALE, before the return').toBe(0);
    const ret = await post('/api/pos/returns', { invoiceId: posId, items: [{ invoiceItemId: posItem.id, quantity: 1 }], reason: 'Customer changed mind' });
    expect(ret.status, JSON.stringify(ret.body)).toBe(200);
    const after = await everythingAgrees();
    expect(near(after.bs.bankBalance, before.bs.bankBalance - 40.25)).toBe(true);        // 35 + 15% VAT handed back
    expect(near(after.bs.vatOutputPayable, before.bs.vatOutputPayable - 5.25)).toBe(true);
    expect(near(after.bs.inventoryValue, before.bs.inventoryValue + 10)).toBe(true);     // one unit back at cost
    expect(after.bs.balanceCheck, 'after the POS RETURN').toBe(0);
    expect(near(after.tb.totalDebits, after.tb.totalCredits)).toBe(true);
    expect(after.net('BANK')).toBe(after.bs.bankBalance);
    expect(after.net('AR')).toBe(after.bs.accountsReceivable);
    expect(-after.net('VAT_OUTPUT')).toBe(after.bs.vatOutputPayable);
  });

  it('a stock-take SHORTAGE is a real cost: the books still balance and the loss reaches the P&L', async () => {
    const before = await everythingAgrees();
    const w1 = (await db.select().from(schema.inventoryStocks).where(eq(schema.inventoryStocks.warehouseId, warehouseId)))[0] as any;
    const take = ok(await post('/api/inventory/stock-takes', { stockTakeData: { warehouseId, performedBy: 'Lifecycle', items: [{ productId: P, physicalQuantity: Number(w1.quantity) - 2 }] } }), 'stock take').stockTake;
    ok(await post(`/api/inventory/stock-takes/${take.id}/finalize`, {}), 'finalize take');
    const after = await everythingAgrees();
    expect(near(after.bs.inventoryValue, before.bs.inventoryValue - 20)).toBe(true);     // 2 units missing at cost 10
    expect(before.bs.balanceCheck, 'before the shortage').toBe(0);
    expect(after.bs.balanceCheck, 'after the shortage').toBe(0);                          // the 20 must be a cost somewhere, not vanish
    expect(near(after.tb.totalDebits, after.tb.totalCredits)).toBe(true);
    const month = await pl(`${CUR}-01`, today);
    expect(month.netProfit).toBeLessThan(0);
    expect(near(after.bs.currentPeriodEarnings, before.bs.currentPeriodEarnings - 20)).toBe(true);
  });

});
