import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { provisionStarterResources } from '../server/lib/companyProvisioning.js';
import { purgeCompany } from './helpers/purgeCompany.js';
import { defaultDefinitionId, runReport, trialBalance } from './helpers/ledgerReports.js';

// General Ledger Step 1, groups C/D/E: manual journals with maker-checker approval, the journal listing and entry detail, the ledger reports and
// Opening Balances. Real HTTP against the running server and real Postgres, no mocks. A second company proves nothing crosses over.
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const PW = 'AutoTest_Pw_2026!';
const TODAY = new Date().toISOString().slice(0, 10);
const MONTH = TODAY.slice(0, 7);
const D = (day: string) => `${MONTH}-${day}`;

interface Co { id: string; adminId: string; admin: string; }
let A: Co, B: Co, C: Co;
let prep = '', appr = '', prepId = '', apprId = '';
const cleanup: string[] = [];

async function api(session: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers: { 'x-session-id': session, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) } });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json().catch(() => ({})) : await res.arrayBuffer() };
}
const get = (s: string, p: string) => api(s, p);
const post = (s: string, p: string, b: any = {}) => api(s, p, { method: 'POST', body: JSON.stringify(b) });
const put = (s: string, p: string, b: any) => api(s, p, { method: 'PUT', body: JSON.stringify(b) });
const del = (s: string, p: string, b: any = {}) => api(s, p, { method: 'DELETE', body: JSON.stringify(b) });

async function login(username: string) {
  const r = await (await fetch(`${BASE_URL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PW }) })).json();
  if (!r.sessionId) throw new Error('login failed ' + username);
  return r.sessionId as string;
}
async function mkCompany(name: string): Promise<Co> {
  const id = generateId();
  await db.insert(schema.companies).values({ id, name, address: 'x', phone: '0', email: `${id.slice(0, 8)}@example.com`, logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false } as any);
  await db.transaction(async (tx: any) => provisionStarterResources(tx, { companyId: id, companyName: name }));
  cleanup.push(id);
  const adminId = generateId();
  const username = `gj_${adminId.slice(-12)}`;
  await db.insert(schema.users).values({ id: adminId, username, password: await bcrypt.hash(PW, 10), role: 'admin', companyId: id, isSuperAdmin: false, uiLanguage: 'en' });
  return { id, adminId, admin: await login(username) };
}
async function mkUser(companyId: string, permissions: any) {
  const roleId = generateId(), userId = generateId(), username = `gju_${userId.slice(-12)}`;
  await db.insert(schema.roles).values({ id: roleId, companyId, name: `Role ${roleId.slice(-6)}`, permissions });
  await db.insert(schema.users).values({ id: userId, username, password: await bcrypt.hash(PW, 10), role: 'user', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  await db.insert(schema.userRoles).values({ userId, roleId });
  return { userId, session: await login(username) };
}
const on = (...keys: string[]) => Object.fromEntries(keys.map(k => [k, { enabled: true }]));

const accounts = async (s: string) => (await get(s, '/api/ledger/accounts')).body.accounts as any[];
const acct = (list: any[], code: string) => list.find(a => a.code === code);
let ids: Record<string, string> = {};
const journal = (over: any = {}) => ({
  docDate: D('05'), description: 'Accrue office supplies', reference: 'INV-77',
  lines: [{ accountId: ids.expense, debit: 100 }, { accountId: ids.income, credit: 100 }], ...over,
});
const newDraft = async (over: any = {}) => (await post(prep, '/api/ledger/manual-journals', journal(over))).body;
const posted = async (over: any = {}) => {
  const d = await newDraft(over);
  expect((await post(prep, `/api/ledger/manual-journals/${d.id}/submit`)).status).toBe(200);
  expect((await post(appr, `/api/ledger/manual-journals/${d.id}/approve`)).status).toBe(200);
  return d;
};

beforeAll(async () => {
  A = await mkCompany('GL Journals Test Co A');
  B = await mkCompany('GL Journals Test Co B');
  C = await mkCompany('GL Opening Test Co C');
  const p = await mkUser(A.id, { journals: on('create', 'read', 'update', 'delete') });
  prep = p.session; prepId = p.userId;
  const a = await mkUser(A.id, { journals: on('read', 'post', 'reverse'), reports: on('generalLedger', 'trialBalanceLedger', 'ledgerReconciliation') });
  appr = a.session; apprId = a.userId;
  const list = await accounts(A.admin);
  ids = { expense: acct(list, '6200').id, income: acct(list, '4100').id, ar: acct(list, '1100').id, heading: acct(list, '6000').id, bank: list.find((x: any) => x.bankId).id, sales: acct(list, '4010').id, capital: acct(list, '3010').id, cash: list.find((x: any) => x.bankId).id };
  await db.insert(schema.fiscalMonths).values({ id: '2025-01', name: 'January 2025', status: 'Closed', companyId: A.id }).onConflictDoNothing();
}, 180000);

afterAll(async () => { for (const id of cleanup) await purgeCompany(id); }, 180000);

describe('drafting a manual journal', () => {
  it('saves a draft with a number, and refuses control, bank, heading, inactive, foreign and malformed lines', async () => {
    const ok = await post(prep, '/api/ledger/manual-journals', journal());
    expect(ok.status).toBe(200);
    expect(ok.body.number).toMatch(/^MJ-/);
    expect((await post(prep, '/api/ledger/manual-journals', journal({ lines: [{ accountId: ids.ar, debit: 5 }, { accountId: ids.income, credit: 5 }] }))).status).toBe(400); // control
    expect((await post(prep, '/api/ledger/manual-journals', journal({ lines: [{ accountId: ids.bank, debit: 5 }, { accountId: ids.income, credit: 5 }] }))).status).toBe(400); // bank
    expect((await post(prep, '/api/ledger/manual-journals', journal({ lines: [{ accountId: ids.heading, debit: 5 }, { accountId: ids.income, credit: 5 }] }))).status).toBe(400); // heading
    const bAcct = acct(await accounts(B.admin), '6200').id;
    expect((await post(prep, '/api/ledger/manual-journals', journal({ lines: [{ accountId: bAcct, debit: 5 }, { accountId: ids.income, credit: 5 }] }))).status).toBe(400); // another company
    expect((await post(prep, '/api/ledger/manual-journals', journal({ lines: [{ accountId: ids.expense, debit: 5, credit: 5 }] }))).status).toBe(400); // both sides
    expect((await post(prep, '/api/ledger/manual-journals', journal({ lines: [{ accountId: ids.expense }] }))).status).toBe(400); // neither side
    expect((await post(prep, '/api/ledger/manual-journals', journal({ description: '  ' }))).status).toBe(400);
    expect((await post(prep, '/api/ledger/manual-journals', journal({ docDate: 'soon' }))).status).toBe(400);
    expect((await post(prep, '/api/ledger/manual-journals', journal({ branchId: generateId() }))).status).toBe(400);
    // an inactive account is refused too
    const tmp = await post(A.admin, '/api/ledger/accounts', { code: '6890', name: 'Temp', type: 'Expense' });
    await api(A.admin, `/api/ledger/accounts/${tmp.body.id}/toggle-active`, { method: 'PATCH' });
    expect((await post(prep, '/api/ledger/manual-journals', journal({ lines: [{ accountId: tmp.body.id, debit: 5 }, { accountId: ids.income, credit: 5 }] }))).status).toBe(400);
  });

  it('a user without journals.create cannot draft; the approver (no create key) cannot either', async () => {
    expect((await post(appr, '/api/ledger/manual-journals', journal())).status).toBe(403);
  });

  it('can edit a draft (lines are replaced) but a missing key stops an edit', async () => {
    const d = await newDraft();
    expect((await put(prep, `/api/ledger/manual-journals/${d.id}`, { description: 'Changed', lines: [{ accountId: ids.expense, debit: 40 }, { accountId: ids.income, credit: 40 }] })).status).toBe(200);
    const g = await get(prep, `/api/ledger/manual-journals/${d.id}`);
    expect(g.body.description).toBe('Changed');
    expect(g.body.totalDebit).toBe(40);
    expect(g.body.lines).toHaveLength(2);
    expect((await put(appr, `/api/ledger/manual-journals/${d.id}`, { description: 'x' })).status).toBe(403);
  });
});

describe('approval (maker-checker)', () => {
  it('refuses to submit an unbalanced journal or one dated in a closed month', async () => {
    const un = await newDraft({ lines: [{ accountId: ids.expense, debit: 100 }, { accountId: ids.income, credit: 60 }] });
    const r = await post(prep, `/api/ledger/manual-journals/${un.id}/submit`);
    expect(r.status).toBe(400); expect(r.body.error).toMatch(/balance/i);
    const closed = await newDraft({ docDate: '2025-01-15' });
    const r2 = await post(prep, `/api/ledger/manual-journals/${closed.id}/submit`);
    expect(r2.status).toBe(400); expect(r2.body.error).toMatch(/closed/i);
    const single = await newDraft({ lines: [{ accountId: ids.expense, debit: 0.01 }] });
    expect((await post(prep, `/api/ledger/manual-journals/${single.id}/submit`)).status).toBe(400);
  });

  it('submit -> pending (no longer editable) -> approved by someone else -> posted to the ledger once', async () => {
    const d = await newDraft();
    expect((await post(prep, `/api/ledger/manual-journals/${d.id}/submit`)).status).toBe(200);
    expect((await put(prep, `/api/ledger/manual-journals/${d.id}`, { description: 'sneaky' })).status).toBe(400);
    expect((await post(prep, `/api/ledger/manual-journals/${d.id}/approve`)).status).toBe(403); // preparer holds no post key
    const ok = await post(appr, `/api/ledger/manual-journals/${d.id}/approve`);
    expect(ok.status).toBe(200);
    expect((await post(appr, `/api/ledger/manual-journals/${d.id}/approve`)).status).toBe(400); // already posted
    const detail = (await get(appr, `/api/ledger/manual-journals/${d.id}`)).body;
    expect(detail.status).toBe('Posted');
    expect(detail.selfApproved).toBe(false);
    expect(detail.events.map((e: any) => e.action)).toEqual(['Prepared', 'Submitted', 'Approved', 'Posted']);
    const [entry] = await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.id, detail.journalEntryId));
    expect(entry.referenceType).toBe('Manual');
    const lines = await db.select().from(schema.journalLines).where(eq(schema.journalLines.journalEntryId, detail.journalEntryId));
    expect(lines).toHaveLength(2);
    expect(lines.every(l => !!l.accountId && l.accountKey === null)).toBe(true);
    expect(lines.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0)).toBeCloseTo(0, 2);
    // a posted journal can be neither edited nor discarded
    expect((await put(prep, `/api/ledger/manual-journals/${d.id}`, { description: 'x' })).status).toBe(400);
    expect((await del(prep, `/api/ledger/manual-journals/${d.id}`)).status).toBe(400);
  });

  it('rejection needs a reason, sends it back, and the preparer can fix and resubmit', async () => {
    const d = await newDraft();
    await post(prep, `/api/ledger/manual-journals/${d.id}/submit`);
    expect((await post(appr, `/api/ledger/manual-journals/${d.id}/reject`, {})).status).toBe(400);
    expect((await post(appr, `/api/ledger/manual-journals/${d.id}/reject`, { note: 'Wrong account' })).status).toBe(200);
    const g = (await get(prep, `/api/ledger/manual-journals/${d.id}`)).body;
    expect(g.status).toBe('Rejected'); expect(g.decisionNote).toBe('Wrong account');
    expect((await put(prep, `/api/ledger/manual-journals/${d.id}`, { description: 'Fixed' })).status).toBe(200);
    expect((await post(prep, `/api/ledger/manual-journals/${d.id}/submit`)).status).toBe(200);
    expect((await post(appr, `/api/ledger/manual-journals/${d.id}/approve`)).status).toBe(200);
  });

  it('the preparer cannot approve their own journal until the owner allows it, and only the owner / admin can allow it', async () => {
    const d = (await post(A.admin, '/api/ledger/manual-journals', journal())).body;
    await post(A.admin, `/api/ledger/manual-journals/${d.id}/submit`);
    const refused = await post(A.admin, `/api/ledger/manual-journals/${d.id}/approve`);
    expect(refused.status).toBe(403); expect(refused.body.error).toMatch(/someone else/i);
    expect((await put(appr, '/api/ledger/journal-settings', { selfApproval: true })).status).toBe(403);
    expect((await put(A.admin, '/api/ledger/journal-settings', { selfApproval: true })).status).toBe(200);
    expect((await post(A.admin, `/api/ledger/manual-journals/${d.id}/approve`)).status).toBe(200);
    const g = (await get(A.admin, `/api/ledger/manual-journals/${d.id}`)).body;
    expect(g.selfApproved).toBe(true);
    await put(A.admin, '/api/ledger/journal-settings', { selfApproval: false });
  });

  it('re-checks the period at approval: a month closed after submission blocks posting', async () => {
    const d = await newDraft({ docDate: D('06') });
    await post(prep, `/api/ledger/manual-journals/${d.id}/submit`);
    await db.update(schema.fiscalMonths).set({ status: 'Closed' }).where(and(eq(schema.fiscalMonths.id, MONTH), eq(schema.fiscalMonths.companyId, A.id)));
    try {
      const r = await post(appr, `/api/ledger/manual-journals/${d.id}/approve`);
      expect(r.status).toBe(400); expect(r.body.error).toMatch(/closed/i);
    } finally { await db.update(schema.fiscalMonths).set({ status: 'Open' }).where(and(eq(schema.fiscalMonths.id, MONTH), eq(schema.fiscalMonths.companyId, A.id))); }
  });
});

describe('discard', () => {
  it('discards a draft but keeps its number on record, and a posted one cannot be discarded', async () => {
    const d = await newDraft();
    expect((await del(appr, `/api/ledger/manual-journals/${d.id}`)).status).toBe(403);
    expect((await del(prep, `/api/ledger/manual-journals/${d.id}`)).status).toBe(200);
    const g = (await get(prep, `/api/ledger/manual-journals/${d.id}`)).body;
    expect(g.status).toBe('Discarded'); expect(g.number).toBe(d.number);
    expect((await put(prep, `/api/ledger/manual-journals/${d.id}`, { description: 'x' })).status).toBe(400);
  });
});

describe('reversal', () => {
  it('starts a reversing draft that itself needs approval, posts the mirror, and cannot be repeated', async () => {
    const orig = await posted({ description: 'To be reversed', lines: [{ accountId: ids.expense, debit: 33 }, { accountId: ids.income, credit: 33 }] });
    const rv = await post(appr, `/api/ledger/manual-journals/${orig.id}/reverse`, { reason: 'Posted by mistake', docDate: D('07') });
    expect(rv.status).toBe(200);
    expect((await post(appr, `/api/ledger/manual-journals/${orig.id}/reverse`, { reason: 'again' })).status).toBe(400); // already in progress
    expect((await post(prep, `/api/ledger/manual-journals/${orig.id}/reverse`, { reason: 'x' })).status).toBe(403); // no reverse key
    const draft = (await get(appr, `/api/ledger/manual-journals/${rv.body.id}`)).body;
    expect(draft.status).toBe('Draft');
    expect(draft.lines.find((l: any) => l.accountId === ids.expense).credit).toBe(33);
    expect((await put(prep, `/api/ledger/manual-journals/${rv.body.id}`, { description: 'tamper' })).status).toBe(400); // generated, not editable
    await post(prep, `/api/ledger/manual-journals/${rv.body.id}/submit`);
    expect((await post(appr, `/api/ledger/manual-journals/${rv.body.id}/approve`)).status).toBe(403); // the approver started this reversal, so someone else must approve it
    expect((await post(A.admin, `/api/ledger/manual-journals/${rv.body.id}/approve`)).status).toBe(200);
    const o = (await get(appr, `/api/ledger/manual-journals/${orig.id}`)).body;
    expect(o.reversedBy?.id).toBe(rv.body.id);
    expect((await post(appr, `/api/ledger/manual-journals/${orig.id}/reverse`, { reason: 'twice' })).status).toBe(400);
    expect((await post(appr, `/api/ledger/manual-journals/${rv.body.id}/reverse`, { reason: 'reverse a reversal' })).status).toBe(400);
    // the two ledger entries cancel exactly on the expense account
    const gl = await get(appr, `/api/ledger/reports/general-ledger?accountId=${ids.expense}&from=${D('07')}&to=${TODAY}`);
    expect(gl.status).toBe(200);
    expect(gl.body.rows.some((r: any) => r.credit === 33)).toBe(true);
  });

  it('a discarded reversal frees the original to be reversed again; a document-made entry has no journal to reverse here', async () => {
    const orig = await posted();
    const rv = await post(appr, `/api/ledger/manual-journals/${orig.id}/reverse`, { reason: 'try' });
    await del(prep, `/api/ledger/manual-journals/${rv.body.id}`);
    expect((await post(appr, `/api/ledger/manual-journals/${orig.id}/reverse`, { reason: 'second try' })).status).toBe(200);
    expect((await post(appr, `/api/ledger/manual-journals/${generateId()}/reverse`, { reason: 'none' })).status).toBe(404);
    expect((await post(appr, `/api/ledger/manual-journals/${orig.id}/reverse`, { reason: ' ' })).status).toBe(400);
  });
});

describe('journal listing and entry detail', () => {
  it('lists drafts, pending and posted journals together with filters and paging', async () => {
    const d = await newDraft({ description: 'Listing probe ZQX' });
    const all = await get(appr, '/api/ledger/journals?pageSize=5');
    expect(all.status).toBe(200);
    expect(all.body.rows.length).toBeLessThanOrEqual(5);
    expect(all.body.total).toBeGreaterThan(5);
    const q = await get(appr, '/api/ledger/journals?q=ZQX');
    expect(q.body.rows).toHaveLength(1);
    expect(q.body.rows[0]).toMatchObject({ kind: 'manual', id: d.id, status: 'Draft', amount: 100 });
    const pend = await get(appr, '/api/ledger/journals?status=Pending');
    expect(pend.body.rows.every((r: any) => r.status === 'Pending')).toBe(true);
    const acc = await get(appr, `/api/ledger/journals?accountId=${ids.income}&source=manual`);
    expect(acc.body.total).toBeGreaterThan(0);
    expect((await get(prep, '/api/ledger/journals')).status).toBe(200);
    expect((await get((await mkUser(A.id, {})).session, '/api/ledger/journals')).status).toBe(403);
  });

  it('shows a posted entry with its accounts, and hides it from another company', async () => {
    const d = await posted();
    const detail = (await get(appr, `/api/ledger/manual-journals/${d.id}`)).body;
    const e = await get(appr, `/api/ledger/journals/entries/${detail.journalEntryId}`);
    expect(e.status).toBe(200);
    expect(e.body.documentNumber).toBe(d.number);
    expect(e.body.totalDebit).toBe(e.body.totalCredit);
    expect(e.body.lines[0].accountCode).toBeTruthy();
    expect((await get(B.admin, `/api/ledger/journals/entries/${detail.journalEntryId}`)).status).toBe(404);
    // the Journal Voucher print: one shape for a manual journal and for the entry it posted, with the approval trail, and invisible to another company
    const pm = (await get(appr, `/api/ledger/manual-journals/${d.id}/print-data`)).body;
    expect(pm).toMatchObject({ kind: 'Manual', number: d.number, status: 'Posted', sourceLabel: 'Manual journal' });
    expect(pm.totalDebit).toBe(pm.totalCredit); expect(pm.lines.length).toBeGreaterThanOrEqual(2); expect(pm.preparedBy).toBeTruthy(); expect(pm.approvedBy).toBeTruthy();
    const pe = (await get(appr, `/api/ledger/journals/entries/${detail.journalEntryId}/print-data`)).body;
    expect(pe.number).toBe(pm.number); expect(pe.lines).toHaveLength(pm.lines.length);
    expect((await get(B.admin, `/api/ledger/journals/entries/${detail.journalEntryId}/print-data`)).status).toBe(404);
    expect((await get(B.admin, `/api/ledger/manual-journals/${d.id}/print-data`)).status).toBe(404);
    expect((await get(B.admin, `/api/ledger/manual-journals/${d.id}`)).status).toBe(404);
    expect((await post(B.admin, `/api/ledger/manual-journals/${d.id}/submit`)).status).toBe(404);
    expect((await post(B.admin, `/api/ledger/manual-journals/${d.id}/approve`)).status).toBe(404);
    expect((await post(B.admin, `/api/ledger/manual-journals/${d.id}/reverse`, { reason: 'x' })).status).toBe(404);
  });
});

describe('ledger reports', () => {
  it('General Ledger: opening, movements, running balance and closing add up', async () => {
    await posted({ docDate: D('08'), lines: [{ accountId: ids.expense, debit: 10 }, { accountId: ids.income, credit: 10 }] });
    const gl = (await get(appr, `/api/ledger/reports/general-ledger?accountId=${ids.expense}&from=${D('01')}&to=${TODAY}`)).body;
    const dr = gl.rows.reduce((s: number, r: any) => s + r.debit, 0), cr = gl.rows.reduce((s: number, r: any) => s + r.credit, 0);
    expect(gl.totals.debit).toBeCloseTo(dr, 2);
    expect(gl.closing).toBeCloseTo(gl.opening + gl.totals.debit - gl.totals.credit, 2);
    expect(gl.rows[gl.rows.length - 1].balance).toBeCloseTo(gl.closing, 2);
    // a heading shows everything beneath it
    const head = (await get(appr, `/api/ledger/reports/general-ledger?accountId=${ids.heading}&from=${D('01')}&to=${TODAY}`)).body;
    expect(head.totals.debit).toBeGreaterThanOrEqual(gl.totals.debit);
    // a later start moves postings into the opening balance
    const later = (await get(appr, `/api/ledger/reports/general-ledger?accountId=${ids.expense}&from=${TODAY}&to=${TODAY}`)).body;
    expect(later.opening + later.totals.debit - later.totals.credit).toBeCloseTo(gl.closing, 2);
    expect((await get(appr, '/api/ledger/reports/general-ledger?accountId=nope')).status).toBe(400);
    expect((await get(appr, `/api/ledger/reports/general-ledger?accountId=${acct(await accounts(B.admin), '6200').id}`)).status).toBe(404);
    expect((await get(prep, `/api/ledger/reports/general-ledger?accountId=${ids.expense}`)).status).toBe(403);
    const ex = await get(appr, `/api/ledger/reports/general-ledger/export?accountId=${ids.expense}&from=${D('01')}&to=${TODAY}`);
    expect(ex.status).toBe(200); expect((ex.body as ArrayBuffer).byteLength).toBeGreaterThan(1000);
  });

  it('Trial Balance (ledger) balances and ties to the General Ledger', async () => {
    const tb = await trialBalance(appr, D('01'), TODAY);
    expect(tb.balanced).toBe(true);
    expect(tb.totals.debit).toBeCloseTo(tb.totals.credit, 2);
    const exp = tb.rows.find((r: any) => r.code === '6200');
    const gl = (await get(appr, `/api/ledger/reports/general-ledger?accountId=${ids.expense}&from=${D('01')}&to=${TODAY}`)).body;
    expect(exp.debit).toBeCloseTo(gl.totals.debit, 2);
    expect(exp.closing).toBeCloseTo(gl.closing, 2);
    const head = tb.rows.find((r: any) => r.code === '6000');
    expect(head.debit).toBeGreaterThanOrEqual(exp.debit);
    expect((await trialBalance(B.admin, D('01'), TODAY)).totals.debit).toBe(0);
    const tbId = await defaultDefinitionId(appr, 'TrialBalance');
    expect((await runReport(appr, tbId, { from: TODAY, to: D('01') })).status).toBe(400);
    expect((await runReport(prep, tbId, { from: D('01'), to: TODAY })).status).toBe(403);
    expect((await get(appr, `/api/ledger/report-definitions/${tbId}/export?from=${D('01')}&to=${TODAY}`)).status).toBe(200);
  });

  it('Ledger vs Documents separates manual journals from document postings', async () => {
    const r = await get(appr, `/api/ledger/reports/ledger-vs-documents?asOf=${TODAY}`);
    expect(r.status).toBe(200);
    expect(r.body.inAgreement).toBe(true); // manual journals carry no posting role, so they cannot disturb the document comparison
    expect(r.body.manual.entries).toBeGreaterThan(0);
    expect(r.body.rows.length).toBeGreaterThan(5);
    expect((await get(prep, '/api/ledger/reports/ledger-vs-documents')).status).toBe(403);
  });

  it('the consistency check passes the journal-soundness rules (R7)', async () => {
    const r = await get(A.admin, '/api/reports/consistency-check');
    expect(r.status).toBe(200);
    const r7 = (r.body.checks as any[]).filter(c => c.id.startsWith('R7'));
    expect(r7).toHaveLength(3);
    expect(r7.every(c => c.ok)).toBe(true);
  });
});

describe('opening balances', () => {
  let cl: any[], cId: Record<string, string>;
  beforeAll(async () => {
    cl = await accounts(C.admin);
    cId = { bank: cl.find(a => a.bankId).id, capital: acct(cl, '3010').id, retained: acct(cl, '3100').id, ar: acct(cl, '1100').id, rev: acct(cl, '4010').id, fa: acct(cl, '1400').id, heading: acct(cl, '1000').id, ap: acct(cl, '2010').id };
  });
  const body = (over: any = {}) => ({ cutOffDate: D('01'), lines: [{ accountId: cId.bank, debit: 5000 }, { accountId: cId.fa, debit: 2000 }, { accountId: cId.capital, credit: 7000 }], ...over });

  it('lists eligible accounts without control accounts (banks allowed) and offers each bank\'s own opening figure', async () => {
    const r = await get(C.admin, '/api/ledger/opening-balances');
    expect(r.status).toBe(200);
    const codes = r.body.eligibleAccounts.map((a: any) => a.code);
    expect(codes).toContain('3010');
    expect(codes).not.toContain('1100'); expect(codes).not.toContain('4010'); expect(codes).not.toContain('1000');
    expect(r.body.eligibleAccounts.some((a: any) => a.bankId)).toBe(true);
  });

  it('previews without saving, and refuses control, profit-and-loss, heading and foreign accounts', async () => {
    const ok = await post(C.admin, '/api/ledger/opening-balances/preview', body());
    expect(ok.status).toBe(200);
    expect(ok.body.canPost).toBe(true);
    expect(ok.body.totalDebit).toBe(7000);
    expect((await db.select().from(schema.openingBalanceRuns).where(eq(schema.openingBalanceRuns.companyId, C.id)))).toHaveLength(0);
    for (const bad of [cId.ar, cId.rev, cId.heading, acct(await accounts(B.admin), '3010').id]) {
      expect((await post(C.admin, '/api/ledger/opening-balances/preview', body({ lines: [{ accountId: bad, debit: 5 }, { accountId: cId.capital, credit: 5 }] }))).status).toBe(400);
    }
    expect((await post(C.admin, '/api/ledger/opening-balances/preview', body({ lines: [{ accountId: cId.fa, debit: 5 }, { accountId: cId.fa, credit: 5 }] }))).status).toBe(400); // twice
  });

  it('an unbalanced sheet cannot be posted until the difference is put to an Equity account', async () => {
    const lines = [{ accountId: cId.bank, debit: 5000 }, { accountId: cId.capital, credit: 4000 }];
    const pv = await post(C.admin, '/api/ledger/opening-balances/preview', { cutOffDate: D('01'), lines });
    expect(pv.body.canPost).toBe(false);
    expect(pv.body.difference).toBe(1000);
    expect((await post(C.admin, '/api/ledger/opening-balances/post', { cutOffDate: D('01'), lines, confirm: true })).status).toBe(400);
    const pl = await post(C.admin, '/api/ledger/opening-balances/preview', { cutOffDate: D('01'), lines, plugAccountId: cId.retained });
    expect(pl.body.canPost).toBe(true);
    expect(pl.body.plug).toMatchObject({ credit: 1000 });
    expect((await post(C.admin, '/api/ledger/opening-balances/preview', { cutOffDate: D('01'), lines, plugAccountId: cId.capital })).status).toBe(400); // already used
    expect((await post(C.admin, '/api/ledger/opening-balances/preview', { cutOffDate: D('01'), lines, plugAccountId: cId.fa })).status).toBe(400); // not Equity
  });

  it('posts once, needs the post key and a confirmation, shows in the ledger, and a second live run is refused', async () => {
    const reader = await mkUser(C.id, { openingBalances: on('read', 'preview') });
    expect((await post(reader.session, '/api/ledger/opening-balances/preview', body())).status).toBe(200);
    expect((await post(reader.session, '/api/ledger/opening-balances/post', { ...body(), confirm: true })).status).toBe(403);
    expect((await post(C.admin, '/api/ledger/opening-balances/post', body())).status).toBe(400); // not confirmed
    const closedDate = await post(C.admin, '/api/ledger/opening-balances/post', { ...body({ cutOffDate: '2025-01-01' }), confirm: true });
    expect(closedDate.status).toBe(400);
    const done = await post(C.admin, '/api/ledger/opening-balances/post', { ...body(), confirm: true });
    expect(done.status).toBe(200);
    const [entry] = await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.id, done.body.journalEntryId));
    expect(entry.referenceType).toBe('Opening');
    expect((await post(C.admin, '/api/ledger/opening-balances/post', { ...body(), confirm: true })).status).toBe(400); // second live run
    const tb = await trialBalance(C.admin, D('01'), TODAY);
    expect(tb.balanced).toBe(true);
    expect(tb.rows.find((r: any) => r.code === '3010').closing).toBe(-7000);
    const list = (await get(C.admin, '/api/ledger/opening-balances')).body;
    expect(list.runs).toHaveLength(1); expect(list.runs[0].reversed).toBe(false);
    // opening entries are visible in the journal listing as their own source
    expect((await get(C.admin, '/api/ledger/journals?source=opening')).body.total).toBe(1);
  });

  it('reverses a wrong opening entry (with a reason) and then accepts a corrected one', async () => {
    const run = (await get(C.admin, '/api/ledger/opening-balances')).body.runs[0];
    expect((await post(C.admin, `/api/ledger/opening-balances/${run.id}/reverse`, {})).status).toBe(400); // reason needed
    expect((await post(B.admin, `/api/ledger/opening-balances/${run.id}/reverse`, { reason: 'x' })).status).toBe(404); // another company
    expect((await post(C.admin, `/api/ledger/opening-balances/${run.id}/reverse`, { reason: 'Wrong bank balance' })).status).toBe(200);
    expect((await post(C.admin, `/api/ledger/opening-balances/${run.id}/reverse`, { reason: 'again' })).status).toBe(400);
    const tb = await trialBalance(C.admin, D('01'), TODAY);
    expect(tb.rows.find((r: any) => r.code === '3010')?.closing || 0).toBe(0);
    const again = await post(C.admin, '/api/ledger/opening-balances/post', { ...body({ lines: [{ accountId: cId.bank, debit: 4000 }, { accountId: cId.capital, credit: 4000 }] }), confirm: true });
    expect(again.status).toBe(200);
  });
});

describe('expenses post to the account their category is mapped to', () => {
  it('a Govt Expenses expense lands on its mapped account, a re-mapping is not retroactive, and the cancel reversal hits the original account', async () => {
    const list = await accounts(A.admin);
    const govt = acct(list, '6400'); // default account for Govt Expenses
    const rent = (await post(A.admin, '/api/ledger/accounts', { code: '6410', name: 'Licences', type: 'Expense', parentId: ids.heading })).body;
    const [vendor] = await db.select().from(schema.vendors).where(eq(schema.vendors.companyId, A.id));
    const [slab] = await db.select().from(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, A.id));
    const [bank] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, A.id));
    const mk = async (n: string) => post(A.admin, '/api/expenses', { docDate: TODAY, vendorId: vendor.id, taxSlabId: slab.id, bankId: bank.id, description: n, billNumber: n, amount: 115, status: 'Active', type: 'Actual', paymentStatus: 'Unpaid', expenseType: 'Govt Expenses' });
    expect((await mk('B-1')).status).toBe(200);
    expect((await put(A.admin, '/api/ledger/mapping/category', { category: 'Govt Expenses', accountId: rent.id })).status).toBe(200);
    expect((await mk('B-2')).status).toBe(200);
    const rows = await db.select().from(schema.expenses).where(eq(schema.expenses.companyId, A.id));
    const lineFor = async (expenseId: string) => {
      const l = await db.select().from(schema.journalLines).innerJoin(schema.journalEntries, eq(schema.journalEntries.id, schema.journalLines.journalEntryId)).where(eq(schema.journalEntries.referenceId, expenseId));
      return l.map(x => x.journal_lines).filter(x => x.accountKey === 'DIRECT_OPEX' && Number(x.debit) > 0);
    };
    const e1 = rows.find(r => r.billNumber === 'B-1')!, e2 = rows.find(r => r.billNumber === 'B-2')!;
    expect((await lineFor(e1.id))[0].accountId).toBe(govt.id);
    expect((await lineFor(e2.id))[0].accountId).toBe(rent.id);
    // cancelling the first (before the mapping changed it) credits the very account it was debited to
    const c = await post(A.admin, `/api/expenses/${e1.id}/cancel`, {});
    expect(c.status).toBe(200);
    const all = await db.select().from(schema.journalLines).innerJoin(schema.journalEntries, eq(schema.journalEntries.id, schema.journalLines.journalEntryId)).where(eq(schema.journalEntries.referenceId, e1.id));
    const onGovt = all.map(x => x.journal_lines).filter(x => x.accountId === govt.id);
    expect(onGovt.reduce((sum, x) => sum + Number(x.debit) - Number(x.credit), 0)).toBeCloseTo(0, 2);
    // and the ledger reports see the split
    const tb = await trialBalance(appr, D('01'), TODAY);
    expect(tb.rows.find((r: any) => r.code === '6410').debit).toBeCloseTo(100, 2);
  });
});

describe('row-level security backs the company filter on the new journal tables', () => {
  it('the restricted tenant connection sees only its own company\'s manual journals, lines and events, with no WHERE clause', async () => {
    const pool = new pg.Pool({ host: process.env.SQL_HOST, user: process.env.TENANT_DB_USER, password: process.env.TENANT_DB_PASSWORD, database: process.env.SQL_DB_NAME });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.company_id', $1, true)`, [A.id]);
      for (const t of ['manual_journals', 'manual_journal_lines', 'manual_journal_events', 'opening_balance_runs', 'expense_category_accounts']) {
        const r = await c.query(`SELECT DISTINCT company_id FROM ${t}`);
        expect(r.rows.every(x => x.company_id === A.id)).toBe(true);
      }
      const n = await c.query('SELECT COUNT(*)::int AS n FROM manual_journals');
      expect(n.rows[0].n).toBeGreaterThan(5);
      // and it cannot write a row for another company
      await expect(c.query(`INSERT INTO manual_journal_events (id, journal_id, company_id, action, user_id, created_at) VALUES ($1,$2,$3,'Prepared',$4,now())`, [generateId(), generateId(), B.id, A.adminId])).rejects.toBeTruthy();
      await c.query('ROLLBACK');
    } finally { c.release(); await pool.end(); }
  });

  it('the database refuses a manual journal line pointing at another company\'s account (composite foreign key)', async () => {
    const d = await newDraft();
    const bAcct = acct(await accounts(B.admin), '6200').id;
    await expect(db.insert(schema.manualJournalLines).values({ id: generateId(), journalId: d.id, companyId: A.id, accountId: bAcct, debit: '5', credit: '0', sortOrder: 9 })).rejects.toBeTruthy();
  });
});
