import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { and, eq, like } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { provisionStarterResources } from '../server/lib/companyProvisioning.js';
import { ensureBankAccount } from '../server/lib/chartOfAccounts.js';
import { purgeCompany } from './helpers/purgeCompany.js';

// Posting control (docs/posting-control.md): the lock date, the back-date window, the reason rule and the two permissions that go past them, enforced for every
// document and journal through one guard. Real HTTP + real Postgres, no mocks.
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const PW = 'AutoTest_Pw_2026!';
const iso = (d: Date) => d.toISOString().slice(0, 10);
const NOW = new Date();
const TODAY = iso(NOW);
const FIRST_OF_MONTH = `${TODAY.slice(0, 8)}01`;
const PREV_LAST = iso(new Date(Date.parse(FIRST_OF_MONTH + 'T00:00:00.000Z') - 86400000)); // last day of the previous month
const PREV_MONTH = PREV_LAST.slice(0, 7);

interface Co { id: string; admin: string; bankId: string; taxSlabId: string; customerId: string }
let A: Co; let clerk = ''; let updater = ''; let backDater = ''; let lockOverrider = '';
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
async function mkUser(companyId: string, permissions: any) {
  const roleId = generateId(), userId = generateId(), username = `pc_${userId.slice(-12)}`;
  await db.insert(schema.roles).values({ id: roleId, companyId, name: `Role ${roleId.slice(-6)}`, permissions });
  await db.insert(schema.users).values({ id: userId, username, password: await bcrypt.hash(PW, 10), role: 'user', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  await db.insert(schema.userRoles).values({ userId, roleId });
  return login(username);
}
async function mkCompany(name: string): Promise<Co> {
  const id = generateId();
  await db.insert(schema.companies).values({ id, name, address: 'x', phone: '0', email: `${id.slice(0, 8)}@example.com`, logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false } as any);
  await db.transaction(async (tx: any) => provisionStarterResources(tx, { companyId: id, companyName: name }));
  cleanup.push(id);
  for (const monthId of [TODAY.slice(0, 7), PREV_MONTH]) await db.insert(schema.fiscalMonths).values({ id: monthId, name: monthId, status: 'Open', companyId: id }).onConflictDoNothing();
  const taxSlabId = generateId();
  await db.insert(schema.taxSlabs).values({ id: taxSlabId, name: 'Standard 15%', percentage: '15', companyId: id } as any);
  const bankId = generateId();
  await db.insert(schema.bankAccounts).values({ id: bankId, bankName: 'Main Bank', accountNumber: '1', accountTitle: name, openingBalance: '0', companyId: id } as any);
  await db.transaction(async (tx: any) => ensureBankAccount(tx, id, { id: bankId, bankName: 'Main Bank', accountTitle: name }));
  const customerId = generateId();
  await db.insert(schema.customers).values({ id: customerId, name: 'Customer', phone: '0', email: 'c@example.com', address: 'x', companyId: id, buyerType: 'B2C' } as any);
  const adminId = generateId(); const username = `pca_${adminId.slice(-12)}`;
  await db.insert(schema.users).values({ id: adminId, username, password: await bcrypt.hash(PW, 10), role: 'admin', companyId: id, isSuperAdmin: false, uiLanguage: 'en' });
  return { id, admin: await login(username), bankId, taxSlabId, customerId };
}
const invoice = (session: string, docDate: string, extra: any = {}) => post(session, '/api/transactions/invoices', {
  ...extra, invoiceData: { docDate, customerId: A.customerId, taxSlabId: A.taxSlabId, bankId: A.bankId, notes: '', status: 'Active', amountPaid: 0, items: [{ id: generateId(), description: 'Item', unitCost: 100, quantity: 1, discountAmount: 0 }] },
});
const setPolicy = (p: any) => put(updater, '/api/ledger/posting-policy', p);
const auditRows = async (action: string) => db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.companyId, A.id), eq(schema.auditLogs.action, action)));

beforeAll(async () => {
  A = await mkCompany('Posting Control Test Co');
  const docs = { invoice: on('create', 'read', 'update', 'delete'), expense: on('create', 'read'), journals: on('create', 'read', 'update', 'post'), customers: on('read') };
  clerk = await mkUser(A.id, docs);
  updater = await mkUser(A.id, { postingControl: on('read', 'update') });
  backDater = await mkUser(A.id, { ...docs, postingControl: on('backDate') });
  lockOverrider = await mkUser(A.id, { ...docs, postingControl: on('overrideLock') });
}, 180000);
afterAll(async () => { for (const id of cleanup) await purgeCompany(id); }, 180000);

describe('the policy', () => {
  it('starts empty, is readable by everyone, and only changed with its own permission and valid values', async () => {
    const p = (await get(clerk, '/api/ledger/posting-policy')).body;
    expect(p).toMatchObject({ lockDate: null, maxBackDays: null, reasonAfterDays: null, canBackDate: false, canOverrideLock: false });
    expect((await put(clerk, '/api/ledger/posting-policy', { maxBackDays: 5 })).status).toBe(403);
    expect((await setPolicy({ lockDate: '2999-01-01' })).status).toBe(400);   // not in the future
    expect((await setPolicy({ maxBackDays: -1 })).status).toBe(400);
    expect((await setPolicy({ reasonAfterDays: 1.5 })).status).toBe(400);
    expect((await setPolicy({ lockDate: 'soon' })).status).toBe(400);
    expect((await setPolicy({ maxBackDays: 5, reasonAfterDays: 2 })).status).toBe(200);
    expect((await get(backDater, '/api/ledger/posting-policy')).body).toMatchObject({ maxBackDays: 5, reasonAfterDays: 2, canBackDate: true });
    expect((await get(lockOverrider, '/api/ledger/posting-policy')).body.canOverrideLock).toBe(true);
    expect((await setPolicy({})).status).toBe(200); // cleared again
    expect((await get(clerk, '/api/ledger/posting-policy')).body).toMatchObject({ lockDate: null, maxBackDays: null, reasonAfterDays: null });
    expect((await auditRows('UPDATE_POSTING_POLICY')).length).toBeGreaterThanOrEqual(2);
  });
});

describe('with no policy nothing changes', () => {
  it('an invoice may be dated in any open month, today or earlier', async () => {
    expect((await invoice(clerk, TODAY)).status).toBe(200);
    expect((await invoice(clerk, PREV_LAST)).status).toBe(200);
  });
});

describe('the back-date window', () => {
  it('refuses a date further back than the window, lets today through, and lets a holder of the back-date right go past it, with an audit entry', async () => {
    expect((await setPolicy({ maxBackDays: 0 })).status).toBe(200);
    const refused = await invoice(clerk, PREV_LAST);
    expect(refused.status).toBe(400); expect(refused.body.error).toMatch(/days back/i);
    expect((await invoice(clerk, TODAY)).status).toBe(200);
    const before = (await auditRows('BACKDATED_POSTING')).length;
    const allowed = await invoice(backDater, PREV_LAST);
    expect(allowed.status).toBe(200);
    const rows = await auditRows('BACKDATED_POSTING');
    expect(rows.length).toBe(before + 1);
    expect(String(rows[rows.length - 1].details)).toContain(PREV_LAST);
    expect(String(rows[rows.length - 1].details)).toContain('window');
    // the administrator holds every right
    expect((await invoice(A.admin, PREV_LAST)).status).toBe(200);
  });

  it('a window of N days admits dates inside it', async () => {
    expect((await setPolicy({ maxBackDays: 400 })).status).toBe(200);
    expect((await invoice(clerk, PREV_LAST)).status).toBe(200);
  });

  it('applies to every dated posting, not only invoices: expenses, payments and journals', async () => {
    expect((await setPolicy({ maxBackDays: 0 })).status).toBe(200);
    const exp = (docDate: string, s = clerk) => post(s, '/api/expenses', { docDate, vendorId: undefined, taxSlabId: A.taxSlabId, bankId: A.bankId, description: 'x', billNumber: 'B-' + generateId().slice(-4), amount: 10, status: 'Active', type: 'Actual', paymentStatus: 'Unpaid' });
    const vendorId = generateId();
    await db.insert(schema.vendors).values({ id: vendorId, name: 'V', phone: '0', email: 'v@example.com', address: 'x', companyId: A.id, buyerType: 'B2C' } as any);
    const e = (docDate: string, s = clerk) => post(s, '/api/expenses', { docDate, vendorId, taxSlabId: A.taxSlabId, bankId: A.bankId, description: 'x', billNumber: 'B-' + generateId().slice(-4), amount: 10, status: 'Active', type: 'Actual', paymentStatus: 'Unpaid' });
    void exp;
    expect((await e(PREV_LAST)).status).toBe(400);
    expect((await e(TODAY)).status).toBe(200);
    expect((await e(PREV_LAST, backDater)).status).toBe(200);
    // a manual journal: saved as a draft whatever the date, refused when submitted
    const accts = (await get(A.admin, '/api/ledger/accounts')).body.accounts as any[];
    const exp1 = accts.find(a => a.code === '6200').id, acc = accts.find(a => a.code === '2200').id;
    const draft = await post(clerk, '/api/ledger/manual-journals', { docDate: PREV_LAST, description: 'late', lines: [{ accountId: exp1, debit: 5 }, { accountId: acc, credit: 5 }] });
    expect(draft.status).toBe(200);
    const sub = await post(clerk, `/api/ledger/manual-journals/${draft.body.id}/submit`, {});
    expect(sub.status).toBe(400); expect(sub.body.error).toMatch(/days back/i);
    // the same journal dated today goes through
    const ok = await post(clerk, '/api/ledger/manual-journals', { docDate: TODAY, description: 'today', lines: [{ accountId: exp1, debit: 5 }, { accountId: acc, credit: 5 }] });
    expect((await post(clerk, `/api/ledger/manual-journals/${ok.body.id}/submit`, {})).status).toBe(200);
  });
});

describe('the lock date', () => {
  it('refuses every posting dated on or before it, for documents and for the cancellation of an old document', async () => {
    const old = await invoice(clerk, PREV_LAST);
    // (the policy is still the 0-day window of the previous test; clear it, then post the invoice that will be cancelled later)
    expect((await setPolicy({})).status).toBe(200);
    const target = await invoice(clerk, PREV_LAST);
    expect(target.status).toBe(200); void old;
    expect((await setPolicy({ lockDate: PREV_LAST })).status).toBe(200);
    const refused = await invoice(clerk, PREV_LAST);
    expect(refused.status).toBe(400); expect(refused.body.error).toMatch(/locked/i);
    expect((await invoice(clerk, TODAY)).status).toBe(200);          // after the lock date
    const cancel = await post(clerk, `/api/transactions/invoices/${target.body.invoiceId}/cancel`, {});
    expect(cancel.status).toBe(400); expect(cancel.body.error).toMatch(/locked/i);   // it would post a reversal into the locked period
    // someone holding the override right, and the administrator, can still post there; the audit log records it
    const before = (await auditRows('BACKDATED_POSTING')).length;
    expect((await invoice(lockOverrider, PREV_LAST)).status).toBe(200);
    expect((await auditRows('BACKDATED_POSTING')).length).toBe(before + 1);
    expect((await post(A.admin, `/api/transactions/invoices/${target.body.invoiceId}/cancel`, {})).status).toBe(200);
  });
});

describe('the reason rule', () => {
  it('asks for a reason once an entry is older than the threshold, and keeps it in the audit log and on a journal', async () => {
    expect((await setPolicy({ reasonAfterDays: 0 })).status).toBe(200);
    expect((await invoice(clerk, TODAY)).status).toBe(200);          // today needs none
    const no = await invoice(clerk, PREV_LAST);
    expect(no.status).toBe(400); expect(no.body.error).toMatch(/reason/i);
    const yes = await invoice(clerk, PREV_LAST, { backDateReason: 'Supplier statement received late' });
    expect(yes.status).toBe(200);
    const rows = await auditRows('BACKDATED_POSTING');
    expect(rows.some(r => String(r.details).includes('Supplier statement received late'))).toBe(true);
    // a journal carries its reason from the draft to the approval, where the approver does not retype it
    const accts = (await get(A.admin, '/api/ledger/accounts')).body.accounts as any[];
    const exp1 = accts.find(a => a.code === '6200').id, acc = accts.find(a => a.code === '2200').id;
    const lines = [{ accountId: exp1, debit: 7 }, { accountId: acc, credit: 7 }];
    const bare = await post(clerk, '/api/ledger/manual-journals', { docDate: PREV_LAST, description: 'no reason', lines });
    expect((await post(clerk, `/api/ledger/manual-journals/${bare.body.id}/submit`, {})).status).toBe(400);
    const withReason = await post(clerk, '/api/ledger/manual-journals', { docDate: PREV_LAST, description: 'with reason', backDateReason: 'Year-end accrual found by the auditor', lines });
    expect((await post(clerk, `/api/ledger/manual-journals/${withReason.body.id}/submit`, {})).status).toBe(200);
    const detail = (await get(A.admin, `/api/ledger/manual-journals/${withReason.body.id}`)).body;
    expect(detail.backDateReason).toBe('Year-end accrual found by the auditor');
    const approver = await mkUser(A.id, { journals: on('read', 'post') });
    expect((await post(approver, `/api/ledger/manual-journals/${withReason.body.id}/approve`, {})).status).toBe(200);
  });

  it('a posting date separate from the document date is what the rules judge', async () => {
    expect((await setPolicy({ lockDate: PREV_LAST })).status).toBe(200);
    const accts = (await get(A.admin, '/api/ledger/accounts')).body.accounts as any[];
    const exp1 = accts.find(a => a.code === '6200').id, acc = accts.find(a => a.code === '2200').id;
    const lines = [{ accountId: exp1, debit: 3 }, { accountId: acc, credit: 3 }];
    // document dated in the locked period but posted today: allowed (the ledger date is after the lock)
    const split = await post(clerk, '/api/ledger/manual-journals', { docDate: PREV_LAST, postingDate: TODAY, description: 'posted today', lines });
    expect(split.status).toBe(200);
    expect((await post(clerk, `/api/ledger/manual-journals/${split.body.id}/submit`, {})).status).toBe(200);
    // and the other way round: dated today, posted into the locked period: refused
    const back = await post(clerk, '/api/ledger/manual-journals', { docDate: TODAY, postingDate: PREV_LAST, description: 'posted back', lines });
    expect((await post(clerk, `/api/ledger/manual-journals/${back.body.id}/submit`, {})).status).toBe(400);
    expect((await setPolicy({})).status).toBe(200);
  });
});
