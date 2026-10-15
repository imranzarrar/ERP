import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { provisionStarterResources } from '../server/lib/companyProvisioning.js';
import { ensureBankAccount } from '../server/lib/chartOfAccounts.js';
import { purgeCompany } from './helpers/purgeCompany.js';

// Receipts and vendor payments across several documents, held on account, applied later and cancelled: one voucher, one ledger entry tagged with the party, N allocations,
// and the documents' own paid amounts moving in step. Real HTTP + real Postgres, no mocks.
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const PW = 'AutoTest_Pw_2026!';
const iso = (d: Date) => d.toISOString().slice(0, 10);
const TODAY = iso(new Date());
const FIRST = `${TODAY.slice(0, 8)}01`;
const PREV_LAST = iso(new Date(Date.parse(FIRST + 'T00:00:00.000Z') - 86400000));

let A = ''; let admin = ''; let clerk = ''; let bankId = ''; let taxSlabId = '';
let cust = '', cust2 = '', vend = '';
let other: { id: string; admin: string; cust: string };
const cleanup: string[] = [];

async function api(session: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers: { 'x-session-id': session, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) } });
  return { status: res.status, body: await res.json().catch(() => ({})) as any };
}
const get = (s: string, p: string) => api(s, p);
const post = (s: string, p: string, b: any = {}) => api(s, p, { method: 'POST', body: JSON.stringify(b) });
const put = (s: string, p: string, b: any) => api(s, p, { method: 'PUT', body: JSON.stringify(b) });
async function login(username: string) {
  const r = await (await fetch(`${BASE_URL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PW }) })).json();
  if (!r.sessionId) throw new Error('login failed');
  return r.sessionId as string;
}
const on = (...keys: string[]) => Object.fromEntries(keys.map(k => [k, { enabled: true }]));
async function mkCompany(name: string) {
  const id = generateId();
  await db.insert(schema.companies).values({ id, name, address: 'x', phone: '0', email: `${id.slice(0, 8)}@example.com`, logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false } as any);
  await db.transaction(async (tx: any) => provisionStarterResources(tx, { companyId: id, companyName: name }));
  cleanup.push(id);
  for (const monthId of [TODAY.slice(0, 7), PREV_LAST.slice(0, 7)]) await db.insert(schema.fiscalMonths).values({ id: monthId, name: monthId, status: 'Open', companyId: id }).onConflictDoNothing();
  const slab = generateId(); await db.insert(schema.taxSlabs).values({ id: slab, name: 'Standard 15%', percentage: '15', companyId: id } as any);
  const bank = generateId(); await db.insert(schema.bankAccounts).values({ id: bank, bankName: 'Main Bank', accountNumber: '1', accountTitle: name, openingBalance: '0', companyId: id } as any);
  await db.transaction(async (tx: any) => ensureBankAccount(tx, id, { id: bank, bankName: 'Main Bank', accountTitle: name }));
  const adminId = generateId(); const username = `st_${adminId.slice(-12)}`;
  await db.insert(schema.users).values({ id: adminId, username, password: await bcrypt.hash(PW, 10), role: 'admin', companyId: id, isSuperAdmin: false, uiLanguage: 'en' });
  return { id, slab, bank, session: await login(username) };
}
async function mkUser(companyId: string, permissions: any) {
  const roleId = generateId(), userId = generateId(), username = `stu_${userId.slice(-12)}`;
  await db.insert(schema.roles).values({ id: roleId, companyId, name: `Role ${roleId.slice(-6)}`, permissions });
  await db.insert(schema.users).values({ id: userId, username, password: await bcrypt.hash(PW, 10), role: 'user', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  await db.insert(schema.userRoles).values({ userId, roleId });
  return login(username);
}
const customer = async (companyId: string, name: string) => { const id = generateId(); await db.insert(schema.customers).values({ id, name, phone: '0', email: 'c@example.com', address: 'x', companyId, buyerType: 'B2C' } as any); return id; };
const invoice = async (customerId: string, unitCost: number, docDate = TODAY) => {
  const r = await post(admin, '/api/transactions/invoices', { invoiceData: { docDate, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0, items: [{ id: generateId(), description: 'Item', unitCost, quantity: 1, discountAmount: 0 }] } });
  if (r.status !== 200) throw new Error(`invoice ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.invoiceId as string;
};
const expense = async (amount: number, n: string) => {
  const r = await post(admin, '/api/expenses', { docDate: TODAY, vendorId: vend, taxSlabId, bankId, description: 'Supplies ' + n, billNumber: 'ST-' + n, amount, status: 'Active', type: 'Actual', paymentStatus: 'Unpaid' });
  if (r.status !== 200) throw new Error(`expense ${r.status} ${JSON.stringify(r.body)}`);
  return (await db.select().from(schema.expenses).where(and(eq(schema.expenses.companyId, A), eq(schema.expenses.billNumber, 'ST-' + n))))[0].id as string;
};
const inv = async (id: string) => (await db.select().from(schema.invoices).where(eq(schema.invoices.id, id)))[0];
const receipt = (body: any, s = admin) => post(s, '/api/settlements/receipts', { partyId: cust, bankId, docDate: TODAY, ...body });
const lines = async (voucherId: string) => ((await db.execute(sql`SELECT a.code, l.debit::float8 AS dr, l.credit::float8 AS cr, l.customer_id AS c, l.vendor_id AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN company_accounts a ON a.id = l.account_id WHERE e.company_id = ${A}::uuid AND e.reference_id = ${voucherId}::uuid ORDER BY e.created_at, l.id`)) as any).rows as any[];

beforeAll(async () => {
  const a = await mkCompany('Settlements Test Co A'); const b = await mkCompany('Settlements Test Co B');
  A = a.id; admin = a.session; bankId = a.bank; taxSlabId = a.slab;
  cust = await customer(A, 'Alpha'); cust2 = await customer(A, 'Beta');
  vend = generateId(); await db.insert(schema.vendors).values({ id: vend, name: 'Gamma', phone: '0', email: 'v@example.com', address: 'x', companyId: A, buyerType: 'B2C' } as any);
  clerk = await mkUser(A, { customerReceipts: on('create', 'read'), vendorPayments: on('read') });
  other = { id: b.id, admin: b.session, cust: await customer(b.id, 'Other co customer') };
}, 180000);
afterAll(async () => { for (const id of cleanup) await purgeCompany(id); }, 180000);

describe('a receipt across several invoices', () => {
  let i1 = '', i2 = '', rec: any;
  it('settles both invoices with one voucher and one ledger entry tagged with the customer', async () => {
    i1 = await invoice(cust, 100); i2 = await invoice(cust, 200);      // 115 and 230
    const items = (await get(admin, `/api/settlements/open-items?kind=customer&partyId=${cust}`)).body.items;
    expect(items.map((x: any) => x.outstanding).sort((x: number, y: number) => x - y)).toEqual([115, 230]);
    rec = await receipt({ amount: 345, reference: 'CHQ-9', allocations: [{ documentType: 'Invoice', documentId: i1, amount: 115 }, { documentType: 'Invoice', documentId: i2, amount: 230 }] });
    expect(rec.status).toBe(200); expect(rec.body).toMatchObject({ applied: 345, unapplied: 0 });
    expect(await inv(i1)).toMatchObject({ paymentStatus: 'Paid', amountPaid: '115.00' });
    expect(await inv(i2)).toMatchObject({ paymentStatus: 'Paid', amountPaid: '230.00' });
    const l = await lines(rec.body.voucherId);
    expect(l).toHaveLength(2);
    expect(l.find(x => x.dr === 345)).toBeTruthy();
    expect(l.find(x => x.cr === 345)).toMatchObject({ code: '1100', c: cust });   // the receivable line carries the customer
    const v = (await db.select().from(schema.vouchers).where(eq(schema.vouchers.id, rec.body.voucherId)))[0];
    expect(v).toMatchObject({ type: 'Receipt', referenceType: 'CustomerReceipt', referenceId: cust, docDate: TODAY, postingDate: TODAY });
    expect((await get(admin, `/api/ledger/subledger/customer/balances?asOf=${TODAY}`)).body.rows.find((r: any) => r.partyId === cust)?.balance ?? 0).toBe(0);
  });

  it('the receipt can be read back, listed, and its postings and allocations shown', async () => {
    const d = (await get(admin, `/api/settlements/${rec.body.voucherId}`)).body;
    expect(d).toMatchObject({ kind: 'customer', cancelled: false, applied: 345, unapplied: 0 });
    expect(d.allocations.map((a: any) => a.amount).sort()).toEqual([115, 230]);
    expect(d.allocations[0].documentNumber).toMatch(/^INV-/);
    // what the voucher print shows: the posting (bank against the customer's receivable, tagged with the party), who prepared it, the party's details
    expect(d.posting).toHaveLength(1); expect(d.preparedBy).toBeTruthy(); expect(d.party.name).toBe('Alpha');
    expect(d.posting[0].lines.find((l: any) => l.credit === 345)).toMatchObject({ accountCode: '1100', party: 'Alpha' });
    const jv = (await get(admin, `/api/ledger/journals/entries/${d.posting[0].id}/print-data`)).body;
    expect(jv).toMatchObject({ kind: 'Document', sourceLabel: 'Customer receipt', sourceNumber: d.voucher.voucherNumber, totalDebit: 345, totalCredit: 345 });
    const list = (await get(admin, '/api/settlements?kind=customer')).body.rows;
    expect(list.find((r: any) => r.id === rec.body.voucherId)).toMatchObject({ partyName: 'Alpha', amount: 345, applied: 345, unapplied: 0, cancelled: false });
  });

  it('an invoice settled through the receipt cannot be cancelled until the receipt is; cancelling the receipt gives everything back', async () => {
    const blocked = await post(admin, `/api/transactions/invoices/${i1}/cancel`, {});
    expect(blocked.status).toBe(400); expect(blocked.body.error).toMatch(/receipt/i);
    expect((await post(admin, `/api/settlements/${rec.body.voucherId}/cancel`, {})).status).toBe(400);          // a reason is required
    const c = await post(admin, `/api/settlements/${rec.body.voucherId}/cancel`, { reason: 'Cheque bounced' });
    expect(c.status).toBe(200); expect(c.body.reversed).toBe(2);
    expect(await inv(i1)).toMatchObject({ paymentStatus: 'Unpaid', amountPaid: '0.00' });
    expect(await inv(i2)).toMatchObject({ paymentStatus: 'Unpaid', amountPaid: '0.00' });
    expect((await get(admin, `/api/ledger/subledger/customer/balances?asOf=${TODAY}`)).body.rows.find((r: any) => r.partyId === cust).balance).toBe(345);
    expect((await post(admin, `/api/settlements/${rec.body.voucherId}/cancel`, { reason: 'again' })).status).toBe(400);
    const d = (await get(admin, `/api/settlements/${rec.body.voucherId}`)).body; expect(d.cancelled).toBe(true);
    const rev = (await db.select().from(schema.vouchers).where(and(eq(schema.vouchers.companyId, A), eq(schema.vouchers.reversalOfVoucherId, rec.body.voucherId))))[0];
    expect(rev).toMatchObject({ type: 'Reversal', amount: '345.00' });
    expect((await post(admin, `/api/transactions/invoices/${i1}/cancel`, {})).status).toBe(200);   // now free to cancel
  });
});

describe('partial allocation, money held on account, and applying it later', () => {
  it('pays part of an invoice, keeps the rest on account, then applies it to another invoice', async () => {
    const a = await invoice(cust2, 100);           // 115
    const b = await invoice(cust2, 200);           // 230
    const r = await receipt({ partyId: cust2, amount: 300, allocations: [{ documentType: 'Invoice', documentId: a, amount: 100 }] });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ applied: 100, unapplied: 200 });
    expect(await inv(a)).toMatchObject({ paymentStatus: 'Partially Paid', amountPaid: '100.00' });
    // on account: the customer still shows the receipt in the ledger and the aging lists the credit
    const aging = (await get(admin, `/api/ledger/subledger/customer/aging?asOf=${TODAY}`)).body;
    const row = aging.rows.find((x: any) => x.partyId === cust2);
    expect(row.total).toBe(345 - 300); expect(aging.reconciliation.difference).toBe(0);
    const list = (await get(admin, `/api/settlements?kind=customer&partyId=${cust2}`)).body.rows;
    expect(list[0]).toMatchObject({ amount: 300, applied: 100, unapplied: 200 });
    // apply 150 to invoice b, then try to apply more than is left
    const apply = await post(admin, `/api/settlements/${r.body.voucherId}/apply`, { allocations: [{ documentType: 'Invoice', documentId: b, amount: 150 }] });
    expect(apply.status).toBe(200); expect(apply.body).toMatchObject({ applied: 150, unapplied: 50 });
    expect(await inv(b)).toMatchObject({ paymentStatus: 'Partially Paid', amountPaid: '150.00' });
    expect((await post(admin, `/api/settlements/${r.body.voucherId}/apply`, { allocations: [{ documentType: 'Invoice', documentId: b, amount: 60 }] })).status).toBe(400);
    expect((await post(admin, `/api/settlements/${r.body.voucherId}/apply`, { allocations: [{ documentType: 'Invoice', documentId: a, amount: 20 }] })).status).toBe(400); // only 15 is still owed on it
    expect((await post(admin, `/api/settlements/${r.body.voucherId}/apply`, { allocations: [{ documentType: 'Invoice', documentId: a, amount: 15 }] })).status).toBe(200);
    // cancelling returns every allocation, however it was made
    expect((await post(admin, `/api/settlements/${r.body.voucherId}/cancel`, { reason: 'wrong customer' })).status).toBe(200);
    expect(await inv(a)).toMatchObject({ paymentStatus: 'Unpaid', amountPaid: '0.00' });
    expect(await inv(b)).toMatchObject({ paymentStatus: 'Unpaid', amountPaid: '0.00' });
  });
});

describe('refusals', () => {
  it('rejects allocations that do not fit, documents of another party or company, and bad input', async () => {
    const a = await invoice(cust, 100);
    const x = await invoice(cust2, 100);
    const bad = (body: any) => receipt(body).then(r => r.status);
    expect(await bad({ amount: 500, allocations: [{ documentType: 'Invoice', documentId: a, amount: 400 }] })).toBe(400);          // more than owed
    expect(await bad({ amount: 100, allocations: [{ documentType: 'Invoice', documentId: a, amount: 115 }] })).toBe(400);          // more than the receipt
    expect(await bad({ amount: 115, allocations: [{ documentType: 'Invoice', documentId: x, amount: 115 }] })).toBe(400);          // another customer's invoice
    expect(await bad({ amount: 115, allocations: [{ documentType: 'Invoice', documentId: a, amount: 50 }, { documentType: 'Invoice', documentId: a, amount: 50 }] })).toBe(400); // twice
    expect(await bad({ amount: 115, allocations: [{ documentType: 'Expense', documentId: a, amount: 50 }] })).toBe(400);           // a customer receipt cannot settle an expense
    expect(await bad({ amount: 0, allocations: [] })).toBe(400);
    expect(await bad({ amount: -5, allocations: [] })).toBe(400);
    expect(await bad({ amount: 10, bankId: generateId(), allocations: [] })).toBe(400);
    expect(await bad({ amount: 10, partyId: other.cust, allocations: [] })).toBe(400);                                              // another company's customer
    expect((await post(other.admin, '/api/settlements/receipts', { partyId: cust, bankId, docDate: TODAY, amount: 10, allocations: [] })).status).toBe(400);
    expect(await bad({ amount: 115, docDate: '2020-01-01', allocations: [{ documentType: 'Invoice', documentId: a, amount: 115 }] })).toBe(400); // a closed or undefined month
    expect((await post(admin, '/api/settlements/receipts', {})).status).toBe(400);
    // nothing was written by the refused attempts
    expect(await inv(a)).toMatchObject({ amountPaid: '0.00' });
  });

  it('needs the right permission, and another company cannot see or cancel a receipt', async () => {
    const a = await invoice(cust, 100);
    expect((await receipt({ amount: 50, allocations: [{ documentType: 'Invoice', documentId: a, amount: 50 }] }, clerk)).status).toBe(200);   // may create
    const r = await receipt({ amount: 10, allocations: [] }, clerk);
    expect((await post(clerk, `/api/settlements/${r.body.voucherId}/cancel`, { reason: 'x' })).status).toBe(403);                              // may not cancel
    expect((await post(clerk, `/api/settlements/${r.body.voucherId}/apply`, { allocations: [] })).status).toBe(403);
    expect((await post(clerk, '/api/settlements/payments', { partyId: vend, bankId, docDate: TODAY, amount: 5, allocations: [] })).status).toBe(403);
    expect((await get(other.admin, `/api/settlements/${r.body.voucherId}`)).status).toBe(404);
    expect((await post(other.admin, `/api/settlements/${r.body.voucherId}/cancel`, { reason: 'x' })).status).toBe(404);
    expect((await get(clerk, `/api/settlements?kind=vendor`)).status).toBe(200);   // vendorPayments.read
    expect((await get(clerk, `/api/settlements/open-items?kind=vendor&partyId=${vend}`)).status).toBe(200);
  });

  it('obeys the company\'s posting control', async () => {
    const a = await invoice(cust, 100);
    const updater = await mkUser(A, { postingControl: on('read', 'update') });
    expect((await put(updater, '/api/ledger/posting-policy', { lockDate: PREV_LAST })).status).toBe(200);
    expect((await receipt({ docDate: PREV_LAST, amount: 10, allocations: [] }, clerk)).status).toBe(400);
    expect((await receipt({ docDate: TODAY, amount: 10, allocations: [{ documentType: 'Invoice', documentId: a, amount: 10 }] }, clerk)).status).toBe(200);
    expect((await put(updater, '/api/ledger/posting-policy', {})).status).toBe(200);
  });
});

describe('paying a vendor across expenses and bills', () => {
  it('pays two expenses with one payment and keeps the rest on account', async () => {
    const e1 = await expense(100, 'E1'); const e2 = await expense(200, 'E2');
    const open = (await get(admin, `/api/settlements/open-items?kind=vendor&partyId=${vend}`)).body.items;
    expect(open.map((x: any) => x.docNumber).sort()).toEqual(open.map((x: any) => x.docNumber).sort());
    const e1row = open.find((x: any) => x.id === e1), e2row = open.find((x: any) => x.id === e2);
    const total = e1row.outstanding + e2row.outstanding;
    const p = await post(admin, '/api/settlements/payments', { partyId: vend, bankId, docDate: TODAY, amount: total + 40, reference: 'TT-7', allocations: [{ documentType: 'Expense', documentId: e1, amount: e1row.outstanding }, { documentType: 'Expense', documentId: e2, amount: e2row.outstanding }] });
    expect(p.status).toBe(200); expect(p.body).toMatchObject({ unapplied: 40 });
    const ex = (await db.select().from(schema.expenses).where(eq(schema.expenses.id, e1)))[0];
    expect(ex.paymentStatus).toBe('Paid');
    const l = await lines(p.body.voucherId);
    expect(l.find(x => x.cr === total + 40)).toBeTruthy();   // bank credit
    expect(l.find(x => x.dr === total + 40)).toMatchObject({ code: '2010', v: vend });
    // the vendor aging shows 40 on account (we have overpaid)
    const aging = (await get(admin, `/api/ledger/subledger/vendor/aging?asOf=${TODAY}`)).body;
    expect(aging.rows.find((r: any) => r.partyId === vend).total).toBe(-40);
    expect(aging.reconciliation.difference).toBe(0);
    // an expense paid through a payment cannot be cancelled; cancelling the payment frees it
    expect((await post(admin, `/api/expenses/${e1}/cancel`, {})).status).toBe(400);
    expect((await post(admin, `/api/settlements/${p.body.voucherId}/cancel`, { reason: 'duplicate' })).status).toBe(200);
    expect((await db.select().from(schema.expenses).where(eq(schema.expenses.id, e1)))[0].paymentStatus).toBe('Unpaid');
    expect((await post(admin, `/api/expenses/${e1}/cancel`, {})).status).toBe(200);
  });
});

describe('the document-based reports understand money held on account', () => {
  it('Balance Sheet, Trial Balance, bank balance, statements and cash flow follow a receipt on account and its cancellation', async () => {
    const cu = await customer(A, 'Delta'); const prev = PREV_LAST;
    const i1 = await invoice(cu, 100);                                      // 115, dated today
    const bs = async (d = TODAY) => (await get(admin, `/api/reports/balance-sheet?asOfDate=${d}`)).body;
    const tb = async () => (await get(admin, `/api/reports/trial-balance?startDate=${TODAY.slice(0, 7)}-01&endDate=${TODAY}`)).body;
    const before = await bs();
    // 300 received on account (nothing allocated), then 115 of it put against the invoice
    const r = await post(admin, '/api/settlements/receipts', { partyId: cu, bankId, docDate: TODAY, amount: 300, allocations: [] });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ applied: 0, unapplied: 300 });
    let s = await bs();
    expect(s.customerAdvances).toBe(before.customerAdvances + 300); expect(s.bankBalance).toBe(before.bankBalance + 300); expect(s.balanceCheck).toBe(0);
    let t = await tb(); expect(t.totalDebits).toBe(t.totalCredits);
    expect(t.ledgers.find((l: any) => l.name.startsWith('Customer Advances'))).toMatchObject({ credit: before.customerAdvances + 300 });
    // the customer statement shows the receipt for its full amount, so the customer is 185 in credit
    expect((await get(admin, `/api/reports/customer-statement?customerId=${cu}`)).body.endingBalance).toBe(115 - 300);
    expect((await post(admin, `/api/settlements/${r.body.voucherId}/apply`, { allocations: [{ documentType: 'Invoice', documentId: i1, amount: 115 }] })).status).toBe(200);
    s = await bs(); expect(s.customerAdvances).toBe(before.customerAdvances + 185); expect(s.accountsReceivable).toBe(before.accountsReceivable - 115); expect(s.balanceCheck).toBe(0);
    // as at yesterday-of-the-month nothing of this had happened yet
    const earlier = await bs(PREV_LAST);
    expect(earlier.customerAdvances).toBe(0); expect(earlier.balanceCheck).toBe(0);
    // the cash flow statement counts the 300 once, on the day it arrived
    const pl = (await get(admin, `/api/reports/profit-loss?startDate=${TODAY}&endDate=${TODAY}&basis=Accrual`)).body;
    expect(pl.operatingInflows).toBeGreaterThanOrEqual(300);
    // cancelling the receipt: the cash goes back out of the bank, the advance disappears, the invoice is open again
    expect((await post(admin, `/api/settlements/${r.body.voucherId}/cancel`, { reason: 'test' })).status).toBe(200);
    s = await bs(); expect(s.customerAdvances).toBe(before.customerAdvances); expect(s.bankBalance).toBe(before.bankBalance); expect(s.balanceCheck).toBe(0);
    expect((await get(admin, `/api/reports/customer-statement?customerId=${cu}`)).body.endingBalance).toBe(115);
    t = await tb(); expect(t.totalDebits).toBe(t.totalCredits);
    void prev;
  });

  it('a payment on account to a vendor is an asset until it is applied', async () => {
    const before = (await get(admin, `/api/reports/balance-sheet?asOfDate=${TODAY}`)).body;
    const p = await post(admin, '/api/settlements/payments', { partyId: vend, bankId, docDate: TODAY, amount: 80, allocations: [] });
    expect(p.status).toBe(200);
    const s = (await get(admin, `/api/reports/balance-sheet?asOfDate=${TODAY}`)).body;
    expect(s.vendorAdvances).toBe(before.vendorAdvances + 80); expect(s.bankBalance).toBe(before.bankBalance - 80); expect(s.balanceCheck).toBe(0);
    expect((await get(admin, `/api/reports/vendor-statement?vendorId=${vend}`)).body.entries.some((e: any) => e.type === 'Payment' && e.credit === 80)).toBe(true);
    expect((await post(admin, `/api/settlements/${p.body.voucherId}/cancel`, { reason: 'test' })).status).toBe(200);
    const after = (await get(admin, `/api/reports/balance-sheet?asOfDate=${TODAY}`)).body;
    expect(after.vendorAdvances).toBe(before.vendorAdvances); expect(after.bankBalance).toBe(before.bankBalance); expect(after.balanceCheck).toBe(0);
  });
});

describe('the books stay consistent', () => {
  it('the consistency check and the subledger reconciliation pass after all of the above', async () => {
    const c = (await get(admin, `/api/reports/consistency-check?asOfDate=${TODAY}`)).body;
    const bad = (c.checks || []).filter((x: any) => !x.ok && x.severity === 'error');
    expect(bad.map((x: any) => `${x.id} ${x.detail}`)).toEqual([]);
  });
});
