import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import pg from 'pg';
import * as XLSX from 'xlsx';
import { eq, and } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { provisionStarterResources } from '../server/lib/companyProvisioning.js';
import { postJournalEntry } from '../server/lib/ledger.js';
import { purgeCompany } from './helpers/purgeCompany.js';

// General Ledger Step 1, group A: the company chart of accounts, its rules, its permissions, Excel import, Account Mapping and the way every journal
// line is stamped with its account. Real HTTP against the running server and real Postgres, no mocks. Two companies prove nothing leaks across them.
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const PW = 'AutoTest_Pw_2026!';

interface Co { id: string; adminId: string; admin: string; }
let A: Co, B: Co;
let readerSession = '', readerRoleId = '', readerUserId = '';
const cleanup: string[] = [];

async function api(session: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers: { 'x-session-id': session, ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) } });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json().catch(() => ({})) : await res.arrayBuffer() };
}
const post = (s: string, p: string, b: any) => api(s, p, { method: 'POST', body: JSON.stringify(b) });
const put = (s: string, p: string, b: any) => api(s, p, { method: 'PUT', body: JSON.stringify(b) });

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
  const username = `gl_${adminId.slice(-12)}`;
  await db.insert(schema.users).values({ id: adminId, username, password: await bcrypt.hash(PW, 10), role: 'admin', companyId: id, isSuperAdmin: false, uiLanguage: 'en' });
  return { id, adminId, admin: await login(username) };
}

const accountsOf = async (s: string) => (await api(s, '/api/ledger/accounts')).body.accounts as any[];
const byCode = (list: any[], code: string) => list.find(a => a.code === code);

beforeAll(async () => {
  A = await mkCompany('GL Accounts Test Co A');
  B = await mkCompany('GL Accounts Test Co B');
  readerRoleId = generateId();
  await db.insert(schema.roles).values({ id: readerRoleId, companyId: A.id, name: 'Chart reader', permissions: { chartOfAccounts: { read: { enabled: true } } } });
  readerUserId = generateId();
  const username = `glr_${readerUserId.slice(-12)}`;
  await db.insert(schema.users).values({ id: readerUserId, username, password: await bcrypt.hash(PW, 10), role: 'user', companyId: A.id, isSuperAdmin: false, uiLanguage: 'en' });
  await db.insert(schema.userRoles).values({ userId: readerUserId, roleId: readerRoleId });
  readerSession = await login(username);
}, 120000);

afterAll(async () => { for (const id of cleanup) await purgeCompany(id); }, 120000);

describe('a new company gets the standard chart', () => {
  it('has the Saudi starter chart, every one of the 16 posting roles mapped once, and an account for its bank', async () => {
    const list = await accountsOf(A.admin);
    expect(list.length).toBeGreaterThanOrEqual(34);
    const roles = list.filter(a => a.systemKey).map(a => a.systemKey).sort();
    expect(roles).toHaveLength(16);
    expect(new Set(roles).size).toBe(16);
    const bank = list.find(a => a.bankId);
    expect(bank).toBeTruthy();
    expect(bank.isControl).toBe(true);
    expect(byCode(list, '1100').systemKey).toBe('AR');
    expect(byCode(list, '1100').isControl).toBe(true);
    expect(byCode(list, '6010').systemKey).toBe('DIRECT_OPEX');
  });

  it('does not show company A\'s accounts to company B', async () => {
    const a = await accountsOf(A.admin), b = await accountsOf(B.admin);
    const aIds = new Set(a.map(x => x.id));
    expect(b.every(x => !aIds.has(x.id))).toBe(true);
    const aChild = byCode(a, '6100');
    expect((await put(B.admin, `/api/ledger/accounts/${aChild.id}`, { name: 'Hijack' })).status).toBe(404);
    expect((await api(B.admin, `/api/ledger/accounts/${aChild.id}/toggle-active`, { method: 'PATCH' })).status).toBe(404);
    expect(byCode(await accountsOf(A.admin), '6100').name).toBe('Staff Salaries and Wages');
  });
});

describe('permissions', () => {
  it('a role with only chartOfAccounts.read can list but not create, edit, deactivate, import, export or map', async () => {
    expect((await api(readerSession, '/api/ledger/accounts')).status).toBe(200);
    expect((await post(readerSession, '/api/ledger/accounts', { code: '9000', name: 'X', type: 'Asset' })).status).toBe(403);
    const acct = byCode(await accountsOf(A.admin), '6200');
    expect((await put(readerSession, `/api/ledger/accounts/${acct.id}`, { name: 'X' })).status).toBe(403);
    expect((await api(readerSession, `/api/ledger/accounts/${acct.id}/toggle-active`, { method: 'PATCH' })).status).toBe(403);
    expect((await api(readerSession, '/api/ledger/accounts/export')).status).toBe(403);
    expect((await api(readerSession, '/api/ledger/accounts/import/template')).status).toBe(403);
    expect((await api(readerSession, '/api/ledger/mapping')).status).toBe(403);
    expect((await put(readerSession, '/api/ledger/mapping/category', { category: 'Admin Expenses', accountId: acct.id })).status).toBe(403);
  });
  it('a company in which the user has no ledger keys at all is refused the list', async () => {
    const id = generateId(); const un = `gln_${id.slice(-12)}`;
    await db.insert(schema.users).values({ id, username: un, password: await bcrypt.hash(PW, 10), role: 'user', companyId: A.id, isSuperAdmin: false, uiLanguage: 'en' });
    expect((await api(await login(un), '/api/ledger/accounts')).status).toBe(403);
  });
});

describe('create and edit', () => {
  it('creates an account under a heading and refuses duplicate codes, bad parents and type mismatches', async () => {
    const list = await accountsOf(A.admin);
    const opex = byCode(list, '6000');
    const ok = await post(A.admin, '/api/ledger/accounts', { code: '6800', name: 'Marketing', nameAr: 'التسويق', type: 'Expense', parentId: opex.id });
    expect(ok.status).toBe(200);
    expect((await post(A.admin, '/api/ledger/accounts', { code: '6800', name: 'Again', type: 'Expense' })).status).toBe(400);
    expect((await post(A.admin, '/api/ledger/accounts', { code: '6801', name: 'Wrong type under expense heading', type: 'Asset', parentId: opex.id })).status).toBe(400);
    expect((await post(A.admin, '/api/ledger/accounts', { code: '6802', name: 'Parent is not a heading', type: 'Expense', parentId: byCode(list, '6100').id })).status).toBe(400);
    expect((await post(A.admin, '/api/ledger/accounts', { code: 'bad code!', name: 'x', type: 'Asset' })).status).toBe(400);
    expect((await post(A.admin, '/api/ledger/accounts', { code: '6803', name: '', type: 'Expense' })).status).toBe(400);
    // a parent that belongs to ANOTHER company is not a valid parent
    const bHeading = byCode(await accountsOf(B.admin), '6000');
    expect((await post(A.admin, '/api/ledger/accounts', { code: '6804', name: 'Cross-company parent', type: 'Expense', parentId: bHeading.id })).status).toBe(400);
  });

  it('can rename a control account and recode an account, but not retype one that has postings, a role or a bank', async () => {
    let list = await accountsOf(A.admin);
    const ar = byCode(list, '1100');
    expect((await put(A.admin, `/api/ledger/accounts/${ar.id}`, { name: 'Trade Debtors', nameAr: 'المدينون' })).status).toBe(200);
    expect(byCode(await accountsOf(A.admin), '1100').name).toBe('Trade Debtors');
    expect((await put(A.admin, `/api/ledger/accounts/${ar.id}`, { type: 'Liability' })).status).toBe(400);
    const bank = (await accountsOf(A.admin)).find(a => a.bankId);
    expect((await put(A.admin, `/api/ledger/accounts/${bank.id}`, { type: 'Liability' })).status).toBe(400);
    // an unused account may be retyped; once it has a line it may not
    const mk = await post(A.admin, '/api/ledger/accounts', { code: '4900', name: 'Scratch', type: 'Revenue' });
    expect((await put(A.admin, `/api/ledger/accounts/${mk.body.id}`, { type: 'Expense' })).status).toBe(200);
    await postJournalEntry(db, { companyId: A.id, postingDate: '2026-10-01', referenceType: 'Test', referenceId: generateId(), description: 't', createdById: A.adminId, lines: [{ accountId: mk.body.id, debit: 10 }, { accountKey: 'SALES_REVENUE', credit: 10 }] });
    expect((await put(A.admin, `/api/ledger/accounts/${mk.body.id}`, { type: 'Revenue' })).status).toBe(400);
    // duplicate code on edit
    expect((await put(A.admin, `/api/ledger/accounts/${mk.body.id}`, { code: '1100' })).status).toBe(400);
  });
});

describe('deactivate', () => {
  it('refuses roles, control accounts, accounts with a balance and headings with active children; allows a zero-balance account and reactivation', async () => {
    const list = await accountsOf(A.admin);
    expect((await api(A.admin, `/api/ledger/accounts/${byCode(list, '4010').id}/toggle-active`, { method: 'PATCH' })).status).toBe(400); // posting role
    expect((await api(A.admin, `/api/ledger/accounts/${byCode(list, '6000').id}/toggle-active`, { method: 'PATCH' })).status).toBe(400); // active children
    const mk = await post(A.admin, '/api/ledger/accounts', { code: '6900', name: 'Temp', type: 'Expense' });
    await postJournalEntry(db, { companyId: A.id, postingDate: '2026-10-01', referenceType: 'Test', referenceId: generateId(), description: 't', createdById: A.adminId, lines: [{ accountId: mk.body.id, debit: 25 }, { accountKey: 'SALES_REVENUE', credit: 25 }] });
    expect((await api(A.admin, `/api/ledger/accounts/${mk.body.id}/toggle-active`, { method: 'PATCH' })).status).toBe(400); // balance 25
    await postJournalEntry(db, { companyId: A.id, postingDate: '2026-10-02', referenceType: 'Test', referenceId: generateId(), description: 't', createdById: A.adminId, lines: [{ accountId: mk.body.id, credit: 25 }, { accountKey: 'SALES_REVENUE', debit: 25 }] });
    const off = await api(A.admin, `/api/ledger/accounts/${mk.body.id}/toggle-active`, { method: 'PATCH' });
    expect(off.status).toBe(200); expect(off.body.isActive).toBe(false);
    expect((await api(A.admin, `/api/ledger/accounts/${mk.body.id}/toggle-active`, { method: 'PATCH' })).body.isActive).toBe(true);
  });
});

describe('every line is stamped with its account, and a mapping change is not retroactive', () => {
  it('keeps old lines on the old account after a role is pointed elsewhere', async () => {
    const before = await accountsOf(A.admin);
    const oldRev = byCode(before, '4010');
    const e1 = await postJournalEntry(db, { companyId: A.id, postingDate: '2026-10-03', referenceType: 'Test', referenceId: generateId(), description: 'before', createdById: A.adminId, lines: [{ accountKey: 'AR', debit: 100 }, { accountKey: 'SALES_REVENUE', credit: 100 }] });
    const stamped1 = await db.select().from(schema.journalLines).where(eq(schema.journalLines.journalEntryId, e1));
    expect(stamped1.every(l => !!l.accountId)).toBe(true);
    expect(stamped1.find(l => l.accountKey === 'SALES_REVENUE')!.accountId).toBe(oldRev.id);

    const newRev = await post(A.admin, '/api/ledger/accounts', { code: '4020', name: 'Service Revenue', type: 'Revenue', parentId: byCode(before, '4000').id });
    expect((await put(A.admin, '/api/ledger/mapping/role', { key: 'SALES_REVENUE', accountId: byCode(before, '1100').id })).status).toBe(400); // wrong type
    expect((await put(A.admin, '/api/ledger/mapping/role', { key: 'SALES_REVENUE', accountId: newRev.body.id })).status).toBe(200);
    const e2 = await postJournalEntry(db, { companyId: A.id, postingDate: '2026-10-04', referenceType: 'Test', referenceId: generateId(), description: 'after', createdById: A.adminId, lines: [{ accountKey: 'AR', debit: 50 }, { accountKey: 'SALES_REVENUE', credit: 50 }] });
    const stamped2 = await db.select().from(schema.journalLines).where(eq(schema.journalLines.journalEntryId, e2));
    expect(stamped2.find(l => l.accountKey === 'SALES_REVENUE')!.accountId).toBe(newRev.body.id);
    const again = await db.select().from(schema.journalLines).where(eq(schema.journalLines.journalEntryId, e1));
    expect(again.find(l => l.accountKey === 'SALES_REVENUE')!.accountId).toBe(oldRev.id); // history did not move
    const list = await accountsOf(A.admin);
    expect(byCode(list, '4020').systemKey).toBe('SALES_REVENUE');
    expect(byCode(list, '4010').systemKey).toBeNull();
  });

  it('a bank line posts to its own bank account', async () => {
    const list = await accountsOf(A.admin);
    const bankAcct = list.find(a => a.bankId);
    const [bank] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, bankAcct.bankId));
    const e = await postJournalEntry(db, { companyId: A.id, postingDate: '2026-10-05', referenceType: 'Test', referenceId: generateId(), description: 'bank', createdById: A.adminId, lines: [{ accountKey: 'BANK', bankId: bank.id, debit: 70 }, { accountKey: 'AR', credit: 70 }] });
    const lines = await db.select().from(schema.journalLines).where(eq(schema.journalLines.journalEntryId, e));
    expect(lines.find(l => l.accountKey === 'BANK')!.accountId).toBe(bankAcct.id);
  });

  it('the database refuses a line that points at another company\'s account (composite foreign key)', async () => {
    const bAcct = byCode(await accountsOf(B.admin), '4010');
    await expect(postJournalEntry(db, { companyId: A.id, postingDate: '2026-10-06', referenceType: 'Test', referenceId: generateId(), description: 'x', createdById: A.adminId, lines: [{ accountId: bAcct.id, debit: 5 }, { accountKey: 'AR', credit: 5 }] })).rejects.toBeTruthy();
  });
});

describe('Account Mapping for expense categories', () => {
  it('starts every category on its default account and lets a category be pointed at another Expense account only', async () => {
    const m = await api(A.admin, '/api/ledger/mapping');
    expect(m.status).toBe(200);
    expect(m.body.categories).toHaveLength(6);
    expect(m.body.categories.every((c: any) => !!c.accountId)).toBe(true);
    expect(m.body.roles).toHaveLength(16);
    const list = await accountsOf(A.admin);
    const rent = await post(A.admin, '/api/ledger/accounts', { code: '6810', name: 'Rent', type: 'Expense', parentId: byCode(list, '6000').id });
    expect((await put(A.admin, '/api/ledger/mapping/category', { category: 'Govt Expenses', accountId: rent.body.id })).status).toBe(200);
    expect((await put(A.admin, '/api/ledger/mapping/category', { category: 'Govt Expenses', accountId: byCode(list, '1100').id })).status).toBe(400); // not Expense
    expect((await put(A.admin, '/api/ledger/mapping/category', { category: 'Nope', accountId: rent.body.id })).status).toBe(400);
    const bAcct = byCode(await accountsOf(B.admin), '6100');
    expect((await put(A.admin, '/api/ledger/mapping/category', { category: 'Govt Expenses', accountId: bAcct.id })).status).toBe(400); // another company's account
    // an account a category posts to cannot be deactivated
    expect((await api(A.admin, `/api/ledger/accounts/${rent.body.id}/toggle-active`, { method: 'PATCH' })).status).toBe(400);
  });
});

describe('Excel import and export', () => {
  const book = (rows: any[][]) => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Chart');
    return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  };
  const upload = (session: string, path: string, buf: Buffer, extra: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.append('file', new Blob([buf]), 'chart.xlsx');
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    return api(session, path, { method: 'POST', body: fd });
  };
  const H = ['Code', 'Name (English)', 'Name (Arabic)', 'Type', 'Parent Code', 'Heading (Yes/No)'];

  it('previews, then saves only the chosen rows, and never changes a type', async () => {
    const buf = book([H,
      ['7100', 'Travel Group', 'السفر', 'Expense', '', 'Yes'],
      ['7110', 'Air Tickets', 'تذاكر', 'Expense', '7100', 'No'],
      ['1100', 'Receivables renamed', '', 'Liability', '', 'No'],
      ['7120', 'Parent missing', '', 'Expense', '9999', 'No'],
      ['7110', 'Duplicate in file', '', 'Expense', '', 'No'],
    ]);
    const v = await upload(A.admin, '/api/ledger/accounts/import/validate', buf);
    expect(v.status).toBe(200);
    expect(v.body.summary).toMatchObject({ totalRows: 5, toCreate: 2, errors: 3 });
    const c = await upload(A.admin, '/api/ledger/accounts/import/commit', buf, { include: JSON.stringify([2, 3]) });
    expect(c.status).toBe(200);
    expect(c.body.summary).toMatchObject({ created: 2, updated: 0 });
    const list = await accountsOf(A.admin);
    expect(byCode(list, '7110').parentCode).toBe('7100');
    expect(byCode(list, '1100').type).toBe('Asset');
    expect(byCode(list, '7120')).toBeUndefined();
    // an existing code is only renamed
    const rename = book([H, ['7110', 'Air Travel', 'السفر الجوي', 'Expense', '7100', 'No']]);
    const c2 = await upload(A.admin, '/api/ledger/accounts/import/commit', rename, { include: JSON.stringify([2]) });
    expect(c2.body.summary).toMatchObject({ created: 0, updated: 1 });
    expect(byCode(await accountsOf(A.admin), '7110').name).toBe('Air Travel');
  });

  it('refuses a file with the wrong columns, and a reader may neither import nor export', async () => {
    expect((await upload(A.admin, '/api/ledger/accounts/import/validate', book([['foo', 'bar'], ['1', '2']]))).status).toBe(400);
    expect((await upload(readerSession, '/api/ledger/accounts/import/validate', book([H, ['7200', 'x', '', 'Expense', '', 'No']]))).status).toBe(403);
    const ex = await api(A.admin, '/api/ledger/accounts/export');
    expect(ex.status).toBe(200);
    expect((ex.body as ArrayBuffer).byteLength).toBeGreaterThan(1000);
  });
});

describe('row-level security backs the company filter', () => {
  it('the restricted tenant connection sees only its own company\'s accounts, with no WHERE clause at all', async () => {
    const pool = new pg.Pool({ host: process.env.SQL_HOST, user: process.env.TENANT_DB_USER, password: process.env.TENANT_DB_PASSWORD, database: process.env.SQL_DB_NAME });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.company_id', $1, true)`, [A.id]);
      const r = await c.query('SELECT DISTINCT company_id FROM company_accounts');
      expect(r.rows.map(x => x.company_id)).toEqual([A.id]);
      const j = await c.query('SELECT DISTINCT company_id FROM manual_journals');
      expect(j.rows.every(x => x.company_id === A.id)).toBe(true);
      await c.query('ROLLBACK');
    } finally { c.release(); await pool.end(); }
  });
});
