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
  let invA: string, billId: string, invD: string;

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
    // D: raised UNPAID and then credited in full — it must leave no receivable behind anywhere (the credit
    // note reverses it, so nothing is owed), and everything else below must be unaffected by it.
    // Expenses are stored VAT-inclusive (15% slab): X = 115 gross (100 net + 15 VAT), paid in full;
    // Y = a 230 gross CAPITAL purchase (200 net + 30 VAT), left unpaid.
    const expense = (amount: number, extra: any) => post('/api/expenses', { date: today, vendorId, taxSlabId, bankId, status: 'Active', type: 'Actual', billNumber: 'RR-E', ...extra, amount });
    expect((await expense(115, { description: 'Reconcile opex', paymentStatus: 'Paid', amountPaid: 115, paymentDate: today })).status).toBe(200);
    expect((await expense(230, { description: 'Reconcile capex', paymentStatus: 'Unpaid', classification: 'Asset' })).status).toBe(200);
    const d = await post('/api/transactions/invoices', inv(1, 0)); expect(d.status).toBe(200); invD = d.body.invoiceId;
    expect((await post(`/api/transactions/invoices/${d.body.invoiceId}/note`, { type: 'CreditNote', reason: 'Credited while unpaid' })).status).toBe(200);
  }, 60000);

  it('P&L: revenue excludes VAT, credited and cancelled sales net out, COGS comes from the ledger', async () => {
    const { body } = await api(`/api/reports/profit-loss?startDate=${today}&endDate=${today}&basis=Accrual`);
    // Surviving sale = invoice B only: 1 x 50, VAT 7.50 excluded. A is fully credited, C cancelled.
    expect(body.totalRevenue).toBe(50);
    expect(body.costOfGoodsSold).toBe(20);
    // Expense X counts at its NET 100 (the 15 VAT is recoverable, not a cost); the capex is not an expense.
    expect(body.totalExpenses).toBe(100);
    expect(body.netProfit).toBe(-70);
  });

  it('Cash flow: refunds and supplier payments are outflows; net equals the real bank movement', async () => {
    const pl = (await api(`/api/reports/profit-loss?startDate=${today}&endDate=${today}&basis=Accrual`)).body;
    expect(pl.operatingInflows).toBe(135);          // 115 (A) + 20 (B)
    expect(pl.operatingOutflows).toBe(460);         // 115 refund on A's credit note + 230 bill payment + 115 expense X (gross cash)
    expect(pl.netCashFlow).toBe(-325);
    const bs = (await api(`/api/reports/balance-sheet?asOfDate=${today}`)).body;
    expect(bs.bankBalance).toBe(-325);              // cash really moved by exactly the reported net cash flow
  });

  it('Cash-basis P&L: receipts net of refunds, tax-exclusive', async () => {
    const { body } = await api(`/api/reports/profit-loss?startDate=${today}&endDate=${today}&basis=Cash`);
    // receipts 115 + 20, refund -115 => 20 gross collected; B's ex-VAT share of its 20 is 20/1.15
    expect(near(body.totalRevenue, 20 / 1.15)).toBe(true);
    expect(near(body.totalExpenses, 100)).toBe(true);   // the 115 paid is 100 net + 15 recoverable VAT
  });

  it('Balance Sheet balances and every new line reconciles to a source document', async () => {
    const { body: bs } = await api(`/api/reports/balance-sheet?asOfDate=${today}`);
    expect(bs.accountsReceivable).toBe(37.5);        // B: 57.50 - 20
    expect(bs.accountsPayable).toBe(230);            // bill paid; the unpaid capex (230 gross) is owed
    expect(bs.inventoryValue).toBe(180);             // 10 bought - 1 sold net of A's return = 9 x 20
    expect(bs.vatInputRecoverable).toBe(75);         // 30 on the bill + 15 on expense X + 30 on the capex
    expect(bs.vatOutputPayable).toBe(7.5);           // B's VAT; A's reversed by its credit note, C cancelled
    expect(bs.currentPeriodEarnings).toBe(-70);      // 50 revenue - 20 cost - 100 net opex, month still open
    expect(bs.fixedAssets).toBe(200);                // capex at NET, its VAT is in VAT Input
    expect(near(bs.balanceCheck, 0)).toBe(true);
  });

  it('Invoice KPI cards: refunded money is not "collected", credited invoices are not pending (the 773% bug)', async () => {
    const { body } = await api(`/api/reports/invoice-kpis?startDate=${today}&endDate=${today}`);
    // Invoiced: A 115 - CN 115 + B 57.50 + D 57.50 - CN 57.50 = 57.50 (cancelled C excluded)
    expect(body.totalInvoiced).toBe(57.5);
    // Collected: A 115 - 115 refunded + B 20 = 20  (it used to report 135, ie. 235% of invoiced)
    expect(body.totalCollected).toBe(20);
    // Only B is genuinely outstanding; D (credited while unpaid) is not.
    expect(body.pendingBalance).toBe(37.5);
    expect(body.pendingCount).toBe(1);
  });

  it('Outstanding report and dashboard show only the genuinely unpaid invoice', async () => {
    const out = (await api(`/api/reports/outstanding?startDate=${today}&endDate=${today}`)).body;
    expect(out.totalReceivable).toBe(37.5);
    const dash = (await api(`/api/reports/dashboard-summary?startDate=${today}&endDate=${today}`)).body;
    expect(dash.pendingCollection).toBe(37.5);
  });

  it('Dashboard Net Profit is built from tax-exclusive sales (gross sales card unchanged)', async () => {
    const { body } = await api(`/api/reports/dashboard-summary?startDate=${today}&endDate=${today}`);
    expect(body.totalSales).toBe(57.5);              // "Gross Month Sales" stays VAT-inclusive
    expect(body.netProfit).toBe(-70);
  });
  it('VAT return summary includes purchase bills, equals the Balance Sheet VAT lines and the filed-return computation', async () => {
    const { body: v } = await api(`/api/reports/vat-return-summary?startDate=${today}&endDate=${today}`);
    // Input VAT = 30 (bill) + 15 (expense X) + 30 (capex Y) = 75 — the bill used to be missing from this report.
    expect(v.inputVat).toBe(75);
    expect(v.outputVat).toBe(7.5);
    expect(v.netVatPayable).toBe(-67.5);             // 7.50 collected - 75 recoverable
    expect(v.purchaseCount).toBe(3);                 // expense X, capex Y and the bill
    const bs = (await api(`/api/reports/balance-sheet?asOfDate=${today}`)).body;
    expect(v.inputVat).toBe(bs.vatInputRecoverable);
    expect(v.outputVat).toBe(bs.vatOutputPayable);
    const reg = (await api(`/api/reports/purchase-vat?startDate=${today}&endDate=${today}`)).body;
    expect(reg.rows.some((r: any) => String(r.documentNumber).startsWith('BILL-'))).toBe(true);
  });

  it('Trial Balance balances (debits = credits) for the whole period AND for a period starting later', async () => {
    const tbFull = (await api(`/api/reports/trial-balance?startDate=${today}&endDate=${today}`)).body;
    expect(near(tbFull.totalDebits, tbFull.totalCredits)).toBe(true);
    const line = (tb: any, name: string) => tb.ledgers.find((l: any) => l.name === name);
    expect(line(tbFull, 'Inventory').debit).toBe(180);
    expect(line(tbFull, 'Cost of Goods Sold').debit).toBe(20);
    expect(line(tbFull, 'Direct Operating Expenses').debit).toBe(100);
    expect(line(tbFull, 'Capitalized Fixed Assets').debit).toBe(200);
    expect(line(tbFull, 'VAT Input (Recoverable)').debit).toBe(75);
    expect(line(tbFull, 'VAT Collected (Output Tax)').credit).toBe(7.5);
    expect(line(tbFull, 'Sales Revenue').credit).toBe(50);
    expect(line(tbFull, 'Retained Earnings (Opening)').debit + line(tbFull, 'Retained Earnings (Opening)').credit).toBe(0);

    // A period that starts AFTER everything happened: no P&L in the period, all of the profit is opening
    // retained earnings (here a loss of 70, so it sits on the debit side) and the statement still balances.
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const tbLater = (await api(`/api/reports/trial-balance?startDate=${tomorrow}&endDate=${tomorrow}`)).body;
    expect(near(tbLater.totalDebits, tbLater.totalCredits)).toBe(true);
    expect(line(tbLater, 'Sales Revenue').credit).toBe(0);
    expect(line(tbLater, 'Retained Earnings (Opening)').debit).toBe(70);
  });

  it('every financial report route answers (all 28), none errors on a real book', async () => {
    const q = `startDate=${today}&endDate=${today}`;
    const paths = ['sales-vat', 'purchase-vat', 'vat-return-summary', 'bank-ledger', 'outstanding', 'investor-profit-share',
      'fiscal-month-closing-history', 'dashboard-summary', 'trial-balance', 'profit-loss', 'balance-sheet', 'sales-register',
      'item-wise-sales', 'customer-statement', 'quotation-conversion', 'sales-by-staff', 'pos-shift-summary', 'purchase-register',
      'vendor-statement', 'stock-valuation', 'item-profitability', 'low-stock', 'stock-take-variance-history',
      'stock-movement-ledger', 'warehouse-transfer-reconciliation', 'invoice-kpis', 'quotation-kpis', 'investor-contributions'];
    for (const name of paths) {
      const extra = name === 'customer-statement' ? `&customerId=${customerId}` : name === 'vendor-statement' ? `&vendorId=${vendorId}` : '';
      const r = await api(`/api/reports/${name}?${q}&asOfDate=${today}${extra}`);
      expect(r.status, `${name} should answer 200`).toBe(200);
    }
  });

  it('every register, statement and ledger agrees with the documents and with the statements above', async () => {
    const q = `startDate=${today}&endDate=${today}`;
    const g = async (name: string, extra = '') => (await api(`/api/reports/${name}?${q}&asOfDate=${today}${extra}`)).body;

    // Customer statement: B still owes 37.50. A was paid, credited and REFUNDED (nets to zero); D was credited unpaid.
    const cs = await g('customer-statement', `&customerId=${customerId}`);
    expect(cs.endingBalance).toBe(37.5);
    expect(cs.entries.some((e: any) => e.type === 'Refund' && e.debit === 115)).toBe(true);

    // Vendor statement: only the unpaid capex (230) is owed; the bill and expense X are settled.
    expect((await g('vendor-statement', `&vendorId=${vendorId}`)).endingBalance).toBe(230);

    // Bank ledger: opening 0, receipts 135 in, 460 out (refund 115 + bill 230 + expense 115), ending -325.
    const bl = await g('bank-ledger');
    expect(bl.openingBalance).toBe(0);
    expect(bl.totalDebit).toBe(135);
    expect(bl.totalCredit).toBe(460);
    expect(bl.endingBalance).toBe(-325);

    // Registers.
    expect((await g('sales-register')).totalSales).toBe(57.5);
    const sv = await g('sales-vat');
    expect(sv.totals.subtotal).toBe(50);
    expect(sv.totals.taxAmount).toBe(7.5);
    const pv = await g('purchase-vat');
    expect(pv.totals.subtotal).toBe(500);            // bill 200 + expense X 100 + capex 200
    expect(pv.totals.taxAmount).toBe(75);
    const pr = await g('purchase-register');
    expect(pr.totalAmount).toBe(575);                // 345 of expenses + the 230 bill that used to be missing
    expect(pr.rows.some((r: any) => String(r.expenseNumber).startsWith('BILL-'))).toBe(true);
    expect(pr.totalAmount).toBe(pv.totals.grandTotal);   // the two purchase views now agree

    // Outstanding, dashboard.
    const ot = await g('outstanding');
    expect(ot.totalReceivable).toBe(37.5);
    expect(ot.totalPayable).toBe(230);
    expect(ot.netOutstanding).toBe(-192.5);
    const ds = await g('dashboard-summary');
    expect(ds.netProfit).toBe(-70);
    expect(ds.netProfitMargin).toBe(-140);           // -70 on TAX-EXCLUSIVE sales of 50 (not -121.74 on the VAT-inclusive 57.50)

    // Sales by staff / item-wise sales net credit notes out.
    expect((await g('sales-by-staff')).totalRevenue).toBe(57.5);
    expect((await g('item-wise-sales')).totalRevenue).toBe(50);
    expect((await g('stock-valuation')).totalValue).toBe(180);
    // Item Profitability: A and D were credited and C cancelled, so only B's single unit still stands (it used to say 5).
    const ip = (await g('item-profitability')).rows.find((r: any) => r.productName === 'Reconcile Item');
    expect(ip.totalQuantitySold).toBe(1);
    expect(ip.averageSalePrice).toBe(50);
  });

  it('The LEDGER itself (journal lines) agrees with the documents and with every report', async () => {
    const lines = await db.select().from(schema.journalLines).where(eq(schema.journalLines.companyId, companyId)) as any[];
    const net = (key: string) => Math.round(lines.filter(l => l.accountKey === key).reduce((n, l) => n + Number(l.debit) - Number(l.credit), 0) * 100) / 100;
    const entries = await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.companyId, companyId)) as any[];

    // Every entry balances, and so does the book as a whole.
    for (const e of entries) {
      const own = lines.filter(l => l.journalEntryId === e.id);
      expect(near(own.reduce((n, l) => n + Number(l.debit) - Number(l.credit), 0), 0)).toBe(true);
    }
    expect(near(lines.reduce((n, l) => n + Number(l.debit) - Number(l.credit), 0), 0)).toBe(true);

    // Account balances equal what the documents say...
    expect(net('AR')).toBe(37.5);
    expect(net('SALES_REVENUE')).toBe(-50);       // credit
    expect(net('VAT_OUTPUT')).toBe(-7.5);         // credit
    expect(net('COGS')).toBe(20);
    expect(net('INVENTORY')).toBe(180);
    expect(net('GR_IR_CLEARING')).toBe(0);        // goods received were all billed
    expect(net('AP')).toBe(-230);                 // the unpaid capex; bill and expense X fully settled
    expect(net('VAT_INPUT')).toBe(75);
    expect(net('DIRECT_OPEX')).toBe(100);
    expect(net('FIXED_ASSETS')).toBe(200);
    expect(net('BANK')).toBe(-325);

    // ...and equal the (document-computed) reports, so the two independent methods cross-check each other.
    const bs = (await api(`/api/reports/balance-sheet?asOfDate=${today}`)).body;
    expect(net('AR')).toBe(bs.accountsReceivable);
    expect(net('INVENTORY')).toBe(bs.inventoryValue);
    expect(-net('AP')).toBe(bs.accountsPayable);
    expect(net('VAT_INPUT')).toBe(bs.vatInputRecoverable);
    expect(-net('VAT_OUTPUT')).toBe(bs.vatOutputPayable);
    expect(net('FIXED_ASSETS')).toBe(bs.fixedAssets);
    expect(net('BANK')).toBe(bs.bankBalance);
    expect(near(net('ROUNDING_ADJUSTMENT'), 0)).toBe(true);
  });

  it('Stock register: every movement matches the documents and the on-hand quantity', async () => {
    const moves = await db.select().from(schema.stockLedgerTransactions).where(eq(schema.stockLedgerTransactions.companyId, companyId)) as any[];
    const qty = (type: string) => moves.filter(m => m.transactionType === type).reduce((n, m) => n + Number(m.quantityChange), 0);
    expect(qty('GRN')).toBe(10);
    // Sold: A 2, B 1, C 1, D 1 = 5; put back: C's cancellation 1, A's credit note 2, D's credit note 1 = 4.
    expect(qty('Sale')).toBe(-1);
    const stock = (await db.select().from(schema.inventoryStocks).where(eq(schema.inventoryStocks.companyId, companyId))) as any[];
    const onHand = stock.reduce((n, r) => n + Number(r.quantity), 0);
    expect(onHand).toBe(9);                        // 10 received - 1 net sold (invoice B)
    expect(near(onHand * 20, (await api(`/api/reports/stock-valuation`)).body.totalValue)).toBe(true);
  });

  it('A credit note never pays out more than the customer actually paid', async () => {
    const vouchersFor = async (invoiceId: string) =>
      (await db.select().from(schema.vouchers).where(eq(schema.vouchers.referenceId, invoiceId))) as any[];
    const bankBefore = (await api(`/api/reports/balance-sheet?asOfDate=${today}`)).body.bankBalance;

    // D was credited while UNPAID: nothing was received, so there is no refund voucher at all.
    expect(await vouchersFor(invD)).toHaveLength(0);

    // E: part-paid (20 of 57.50) and then credited — the refund is exactly the 20 received, not 57.50.
    const e = await post('/api/transactions/invoices', inv(1, 20)); expect(e.status).toBe(200);
    expect((await post(`/api/transactions/invoices/${e.body.invoiceId}/note`, { type: 'CreditNote', reason: 'Credited while part-paid' })).status).toBe(200);
    const ev = await vouchersFor(e.body.invoiceId);
    expect(ev.filter(v => v.type === 'Receipt').reduce((n, v) => n + Number(v.amount), 0)).toBe(20);
    expect(ev.filter(v => v.type === 'Reversal').reduce((n, v) => n + Number(v.amount), 0)).toBe(20);

    // Net effect on the bank of receiving and refunding E is exactly zero.
    const bankAfter = (await api(`/api/reports/balance-sheet?asOfDate=${today}`)).body.bankBalance;
    expect(bankAfter).toBe(bankBefore);
  });

  it('Month-end close: the month profit moves into Retained Earnings and every statement still agrees', async () => {
    const monthId = today.slice(0, 7);
    const pnlBefore = (await api(`/api/reports/profit-loss?startDate=${today}&endDate=${today}&basis=Accrual`)).body;
    const bsBefore = (await api(`/api/reports/balance-sheet?asOfDate=${today}`)).body;
    expect(bsBefore.retainedEarnings).toBe(0);
    expect(bsBefore.currentPeriodEarnings).toBe(pnlBefore.netProfit);

    const months = await api('/api/transactions/months');
    const row = (Array.isArray(months.body) ? months.body : months.body.rows).find((m: any) => m.id === monthId);
    const close = await post('/api/transactions/months', { ...row, status: 'Closed', closedAt: new Date().toISOString(), closedOption: 'including_pending' });
    expect(close.status).toBe(200);

    // The stored profit equals the P&L (capital purchase excluded, VAT excluded, COGS from the ledger)...
    const hist = (await api('/api/reports/fiscal-month-closing-history')).body.rows.find((r: any) => r.id === monthId);
    expect(hist.closedPnL.netProfit).toBe(pnlBefore.netProfit);

    // ...and now sits in Retained Earnings, with nothing left in the current period; the sheet still balances.
    const bsAfter = (await api(`/api/reports/balance-sheet?asOfDate=${today}`)).body;
    expect(bsAfter.retainedEarnings).toBe(pnlBefore.netProfit);
    expect(bsAfter.currentPeriodEarnings).toBe(0);
    expect(bsAfter.totalEquity).toBe(bsBefore.totalEquity);
    expect(near(bsAfter.balanceCheck, 0)).toBe(true);

    // The P&L for the month is unchanged by closing it, and the Trial Balance still balances.
    const pnlAfter = (await api(`/api/reports/profit-loss?startDate=${today}&endDate=${today}&basis=Accrual`)).body;
    expect(pnlAfter.netProfit).toBe(pnlBefore.netProfit);
    const tb = (await api(`/api/reports/trial-balance?startDate=${today}&endDate=${today}`)).body;
    expect(near(tb.totalDebits, tb.totalCredits)).toBe(true);
  });
});
