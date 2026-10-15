import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { provisionStarterResources } from '../server/lib/companyProvisioning.js';
import { ensureBankAccount } from '../server/lib/chartOfAccounts.js';
import { purgeCompany } from './helpers/purgeCompany.js';

// Bank reconciliation: sessions per bank and statement date, statement lines, matching, a bank fee posted from inside the session, completion that locks cleared lines, and audited reopening.
// Real HTTP + real Postgres, no mocks.
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
const del = (s: string, p: string) => api(s, p, { method: 'DELETE' });

let exp1 = '', rev1 = '', boss = '';
let sess = ''; let X = 0; let rec1: any; let pay1: any; let feeVoucher = '';
const bankGl = async () => Number(((await db.execute(sql`SELECT COALESCE(SUM(l.debit - l.credit),0)::float8 AS n FROM journal_lines l JOIN company_accounts a ON a.id = l.account_id OR (l.account_id IS NULL AND l.account_key = 'BANK' AND a.bank_id = l.bank_id) WHERE l.company_id = ${A}::uuid AND a.bank_id = ${bankId}::uuid`)) as any).rows[0].n);
const R = (p = '') => `/api/bank-reconciliations${p}`;
const detail = async (id = sess) => (await get(admin, R(`/${id}`))).body;
const sheet = async () => (await get(admin, `/api/reports/balance-sheet?asOfDate=${TODAY}`)).body;

beforeAll(async () => {
  const a = await mkCompany('Bank Rec Test Co A'); const b = await mkCompany('Bank Rec Test Co B');
  A = a.id; admin = a.session; bankId = a.bank; taxSlabId = a.slab;
  cust = await customer(A, 'Alpha');
  vend = generateId(); await db.insert(schema.vendors).values({ id: vend, name: 'Gamma', phone: '0', email: 'v@example.com', address: 'x', companyId: A, buyerType: 'B2C' } as any);
  const accts = await db.select().from(schema.companyAccounts).where(eq(schema.companyAccounts.companyId, A));
  exp1 = accts.find(x => x.type === 'Expense' && !x.isGroup && !x.isControl && x.isActive)!.id;
  rev1 = accts.find(x => x.type === 'Revenue' && !x.isGroup && !x.isControl && x.isActive && !x.systemKey)?.id || accts.find(x => x.type === 'Revenue' && !x.isGroup && !x.isControl && x.isActive)!.id;
  clerk = await mkUser(A, { bankReconciliation: on('read', 'match'), customerReceipts: on('create', 'read'), vendorPayments: on('create', 'read') });
  boss = await mkUser(A, { bankReconciliation: on('create', 'read', 'match', 'adjust', 'complete', 'reopen'), customerReceipts: on('create', 'read', 'delete'), vendorPayments: on('create', 'read', 'delete') });
  other = { id: b.id, admin: b.session, cust: '' };
}, 180000);
afterAll(async () => { for (const id of cleanup) await purgeCompany(id); }, 180000);

describe('building a reconciliation', () => {
  it('lists the bank lines up to the statement date, and refuses to complete while it does not balance', async () => {
    const i1 = await invoice(cust, 100);                                             // 115
    rec1 = await post(admin, '/api/settlements/receipts', { partyId: cust, bankId, docDate: TODAY, amount: 115, allocations: [{ documentType: 'Invoice', documentId: i1, amount: 115 }] });
    expect(rec1.status).toBe(200);
    const e1 = await expense(100, 'R1');
    const open = (await get(admin, `/api/settlements/open-items?kind=vendor&partyId=${vend}`)).body.items.find((x: any) => x.id === e1);
    X = open.outstanding;
    pay1 = await post(admin, '/api/settlements/payments', { partyId: vend, bankId, docDate: TODAY, amount: X, allocations: [{ documentType: 'Expense', documentId: e1, amount: X }] });
    expect(pay1.status).toBe(200);
    // the statement shows the deposit, the payment and a 10.00 bank fee the books do not have yet
    const c = await post(admin, R(), { bankId, statementDate: TODAY, statementEndingBalance: 115 - X - 10 });
    expect(c.status).toBe(200); sess = c.body.id;
    expect((await post(admin, R(), { bankId, statementDate: TODAY, statementEndingBalance: 0 })).status).toBe(400);   // one in progress per bank
    let d = await detail();
    expect(d.lines).toHaveLength(2);
    expect(d.summary).toMatchObject({ bookBalance: 115 - X, clearedBalance: 0, depositsInTransit: 115, paymentsOutstanding: X, canComplete: false });
    expect((await post(admin, R(`/${sess}/clear`), { lineIds: d.lines.map((l: any) => l.lineId) })).status).toBe(200);
    d = await detail();
    expect(d.summary).toMatchObject({ clearedBalance: 115 - X, difference: -10, canComplete: false });
    const c2 = await post(admin, R(`/${sess}/complete`));
    expect(c2.status).toBe(400); expect(c2.body.error).toMatch(/does not balance/i);
  });

  it('imports statement lines (a second import of the same file adds nothing), suggests matches, and checks amounts', async () => {
    const lines = [{ date: TODAY, description: 'CHQ DEPOSIT', amount: 115 }, { date: TODAY, description: 'TRANSFER OUT', amount: -X }, { date: TODAY, description: 'MONTHLY FEE', amount: -10 }];
    expect((await post(admin, R(`/${sess}/statement-lines`), { lines })).body).toMatchObject({ added: 3, skipped: 0 });
    expect((await post(admin, R(`/${sess}/statement-lines`), { lines })).body).toMatchObject({ added: 0, skipped: 3 });
    expect((await post(admin, R(`/${sess}/statement-lines`), { lines: [{ date: 'x', amount: 1 }] })).status).toBe(400);
    let d = await detail();
    // already ticked off, so the suggestions only cover lines nobody cleared yet: none. Matching a statement line to a ticked ledger line is still allowed.
    const dep = d.statementLines.find((x: any) => x.amount === 115), out = d.statementLines.find((x: any) => x.amount === -X), fee = d.statementLines.find((x: any) => x.amount === -10);
    const depLine = d.lines.find((l: any) => l.debit === 115), outLine = d.lines.find((l: any) => l.credit === X);
    expect((await post(admin, R(`/${sess}/match`), { statementLineId: fee.id, journalLineId: depLine.lineId })).status).toBe(400);   // amounts differ
    expect((await post(admin, R(`/${sess}/match`), { statementLineId: dep.id, journalLineId: depLine.lineId })).status).toBe(200);
    expect((await post(admin, R(`/${sess}/match`), { statementLineId: out.id, journalLineId: outLine.lineId })).status).toBe(200);
    expect((await post(admin, R(`/${sess}/match`), { statementLineId: out.id, journalLineId: outLine.lineId })).status).toBe(400);   // already matched
    expect((await post(admin, R(`/${sess}/clear`), { lineIds: [depLine.lineId], clear: false })).status).toBe(400);                 // matched: un-match first
    d = await detail();
    expect(d.summary).toMatchObject({ unmatchedStatementLines: 1, canComplete: false });
    const c = await post(admin, R(`/${sess}/complete`));
    expect(c.status).toBe(400); expect(c.body.error).toMatch(/not matched|does not balance/i);
  });

  it('suggests pairs by amount and date without applying them', async () => {
    // a second, throw-away line pair on the same session: un-clear nothing, just look at what would be suggested for a new statement line
    const d0 = await detail();
    const dep = d0.statementLines.find((x: any) => x.amount === 115);
    await post(admin, R(`/${sess}/unmatch`), { statementLineId: dep.id });
    await post(admin, R(`/${sess}/clear`), { lineIds: [d0.lines.find((l: any) => l.debit === 115).lineId], clear: false });
    const s = (await get(admin, R(`/${sess}/suggestions`))).body.rows;
    expect(s).toHaveLength(1); expect(s[0]).toMatchObject({ statementLineId: dep.id, journalLineId: d0.lines.find((l: any) => l.debit === 115).lineId });
    expect((await detail()).statementLines.find((x: any) => x.id === dep.id).isMatched).toBe(false);      // suggested, never applied
    expect((await post(admin, R(`/${sess}/match`), { statementLineId: s[0].statementLineId, journalLineId: s[0].journalLineId })).status).toBe(200);
  });
});

describe('a bank fee found on the statement', () => {
  it('is posted from inside the session, to an expense account only, and the books follow', async () => {
    const before = await sheet(); const glBefore = await bankGl();
    const d = await detail(); const fee = d.statementLines.find((x: any) => x.amount === -10);
    expect((await post(admin, R(`/${sess}/adjustment`), { statementLineId: fee.id, accountId: rev1 })).status).toBe(400);      // a charge goes to an expense account
    expect((await post(admin, R(`/${sess}/adjustment`), { statementLineId: fee.id, accountId: generateId() })).status).toBe(400);
    expect((await post(clerk, R(`/${sess}/adjustment`), { statementLineId: fee.id, accountId: exp1 })).status).toBe(403);
    const r = await post(admin, R(`/${sess}/adjustment`), { statementLineId: fee.id, accountId: exp1, description: 'Monthly account fee' });
    expect(r.status).toBe(200); expect(r.body.amount).toBe(-10); feeVoucher = r.body.voucherId;
    const v = (await db.select().from(schema.vouchers).where(eq(schema.vouchers.id, feeVoucher)))[0];
    expect(v).toMatchObject({ type: 'Payment', referenceType: 'BankCharge', amount: '10.00', bankId });
    expect(await bankGl()).toBe(glBefore - 10);
    const after = await sheet();
    expect(after.bankBalance).toBe(before.bankBalance - 10); expect(after.balanceCheck).toBe(0);                               // the document-based Balance Sheet still balances
    expect(after.currentPeriodEarnings).toBeCloseTo(before.currentPeriodEarnings - 10, 2);
    const tb = (await get(admin, `/api/reports/trial-balance?startDate=${TODAY.slice(0, 7)}-01&endDate=${TODAY}`)).body;
    expect(tb.totalDebits).toBe(tb.totalCredits);
    expect(tb.ledgers.find((l: any) => l.name === 'Bank Charges')).toMatchObject({ debit: 10 });
    const pl = (await get(admin, `/api/reports/profit-loss?startDate=${TODAY}&endDate=${TODAY}&basis=Accrual`)).body;
    expect(pl.bankCharges).toBe(10);
    const d2 = await detail();
    expect(d2.summary).toMatchObject({ difference: 0, unmatchedStatementLines: 0, canComplete: true });
  });
});

describe('completing, locking and reopening', () => {
  it('completes only with the permission, freezes the book balance, and refuses a second open session on the same bank date', async () => {
    expect((await post(clerk, R(`/${sess}/complete`))).status).toBe(403);
    const c = await post(admin, R(`/${sess}/complete`)); expect(c.status).toBe(200);
    const d = await detail();
    expect(d.session).toMatchObject({ status: 'Completed', glBalanceAtReconciliation: 115 - X - 10 });
    expect((await post(admin, R(`/${sess}/clear`), { lineIds: [d.lines[0].lineId], clear: false })).status).toBe(400);           // completed: nothing can be changed
    expect((await post(admin, R(), { bankId, statementDate: PREV_LAST, statementEndingBalance: 0 })).status).toBe(400);           // must be after the last completed one
    expect((await post(admin, R(`/${sess}/complete`))).status).toBe(400);
  });

  it('locks the documents behind cleared lines', async () => {
    const r = await post(admin, `/api/settlements/${rec1.body.voucherId}/cancel`, { reason: 'try' });
    expect(r.status).toBe(400); expect(r.body.error).toMatch(/reconciliation/i);
    expect((await post(admin, `/api/settlements/${pay1.body.voucherId}/cancel`, { reason: 'try' })).status).toBe(400);
    expect((await get(admin, `/api/settlements/${rec1.body.voucherId}`)).body.cancelled).toBe(false);                            // nothing was half-done
  });

  it('is reopened only by someone with the permission, with a reason, and that is audited', async () => {
    expect((await post(clerk, R(`/${sess}/reopen`), { reason: 'x' })).status).toBe(403);
    expect((await post(boss, R(`/${sess}/reopen`), {})).status).toBe(400);
    const r = await post(boss, R(`/${sess}/reopen`), { reason: 'Receipt posted to the wrong customer' });
    expect(r.status).toBe(200);
    const log = (await db.execute(sql`SELECT details FROM audit_logs WHERE company_id = ${A}::uuid AND action = 'BANK_RECONCILIATION_REOPEN' AND entity_id = ${sess}::uuid`)) as any;
    expect(log.rows).toHaveLength(1); expect(log.rows[0].details).toMatch(/wrong customer/);
    expect((await detail()).session).toMatchObject({ status: 'InProgress', reopenReason: 'Receipt posted to the wrong customer' });
    expect((await post(admin, R(), { bankId, statementDate: TODAY, statementEndingBalance: 0 })).status).toBe(400);               // one in progress per bank
  });

  it('after reopening, the fee entry can be taken back and a cleared document freed by un-clearing its line', async () => {
    const before = await sheet();
    const rv = await post(boss, R(`/${sess}/adjustments/${feeVoucher}/reverse`), { reason: 'entered twice' });
    expect(rv.status).toBe(200);
    expect((await post(boss, R(`/${sess}/adjustments/${feeVoucher}/reverse`), {})).status).toBe(400);                           // only once
    const after = await sheet();
    expect(after.bankBalance).toBe(before.bankBalance + 10); expect(after.balanceCheck).toBe(0);
    let d = await detail();
    // free the receipt: un-match its statement line, un-clear its bank line, and the receipt can be cancelled
    const dep = d.statementLines.find((x: any) => x.amount === 115); const depLine = d.lines.find((l: any) => l.debit === 115 && l.cleared);
    expect((await post(boss, R(`/${sess}/unmatch`), { statementLineId: dep.id })).status).toBe(200);
    expect((await post(boss, R(`/${sess}/clear`), { lineIds: [depLine.lineId], clear: false })).status).toBe(200);
    expect((await post(admin, `/api/settlements/${rec1.body.voucherId}/cancel`, { reason: 'wrong customer' })).status).toBe(200);
    d = await detail();
    expect(d.summary.canComplete).toBe(false);
  });
});

describe('interest, permissions and isolation', () => {
  it('bank interest goes to an income account and counts as profit', async () => {
    const before = (await get(admin, `/api/reports/profit-loss?startDate=${TODAY}&endDate=${TODAY}&basis=Accrual`)).body;
    await post(admin, R(`/${sess}/statement-lines`), { lines: [{ date: TODAY, description: 'PROFIT PAID', amount: 5 }] });
    const d = await detail(); const line = d.statementLines.find((x: any) => x.amount === 5);
    expect((await post(admin, R(`/${sess}/adjustment`), { statementLineId: line.id, accountId: exp1 })).status).toBe(400);
    const r = await post(admin, R(`/${sess}/adjustment`), { statementLineId: line.id, accountId: rev1 });
    expect(r.status).toBe(200);
    const v = (await db.select().from(schema.vouchers).where(eq(schema.vouchers.id, r.body.voucherId)))[0];
    expect(v).toMatchObject({ type: 'Receipt', referenceType: 'BankInterest', amount: '5.00' });
    const pl = (await get(admin, `/api/reports/profit-loss?startDate=${TODAY}&endDate=${TODAY}&basis=Accrual`)).body;
    expect(pl.bankInterest).toBe(before.bankInterest + 5); expect(pl.netProfit).toBe(before.netProfit + 5);
    expect((await sheet()).balanceCheck).toBe(0);
    // taking the interest back puts the bank out again (a reversal of a receipt is money out)
    const bs0 = await sheet();
    expect((await post(boss, R(`/${sess}/adjustments/${r.body.voucherId}/reverse`), {})).status).toBe(200);
    const bs1 = await sheet();
    expect(bs1.bankBalance).toBe(bs0.bankBalance - 5); expect(bs1.balanceCheck).toBe(0);
  });

  it('is invisible to another company and needs the right permission', async () => {
    expect((await get(other.admin, R(`/${sess}`))).status).toBe(404);
    expect((await post(other.admin, R(`/${sess}/clear`), { lineIds: [generateId()] })).status).toBe(404);
    expect((await get(other.admin, R())).body.rows).toHaveLength(0);
    const noPerm = await mkUser(A, { customerReceipts: on('read') });
    expect((await get(noPerm, R())).status).toBe(403);
    expect((await post(clerk, R(), { bankId, statementDate: TODAY, statementEndingBalance: 0 })).status).toBe(403);
  });

  it('a session can be discarded, which un-clears everything it had cleared', async () => {
    expect((await del(clerk, R(`/${sess}`))).status).toBe(403);
    const r = await del(boss, R(`/${sess}`)); expect(r.status).toBe(200);
    const left = (await db.execute(sql`SELECT COUNT(*)::int AS n FROM journal_lines WHERE company_id = ${A}::uuid AND bank_reconciliation_id IS NOT NULL`)) as any;
    expect(left.rows[0].n).toBe(0);
    expect((await get(admin, R(`/${sess}`))).status).toBe(404);
  });

  it('the books stay consistent after all of the above', async () => {
    const c = (await get(admin, `/api/reports/consistency-check?asOfDate=${TODAY}`)).body;
    const bad = (c.checks || []).filter((x: any) => !x.ok && x.severity === 'error');
    expect(bad.map((x: any) => `${x.id} ${x.detail}`)).toEqual([]);
    const rec = (await get(admin, `/api/ledger/reports/ledger-vs-documents?asOf=${TODAY}`)).body;
    expect((rec.rows || []).filter((r: any) => r.key === 'BANK').map((r: any) => r.difference)).toEqual([0]);
  });
});
