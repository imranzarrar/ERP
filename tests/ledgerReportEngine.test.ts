import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import ExcelJS from 'exceljs';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { provisionStarterResources } from '../server/lib/companyProvisioning.js';
import { postJournalEntry } from '../server/lib/ledger.js';
import { purgeCompany } from './helpers/purgeCompany.js';
import { defaultDefinitionId, runReport } from './helpers/ledgerReports.js';

// General Ledger Step 1.5, slice 2: the Report Definition engine. Seeded Trial Balance / Income Statement / Balance Sheet, custom definitions with every
// row and column option, safety checks, dimension columns, drill-down, permissions and the styled Excel export. Real HTTP + real Postgres, no mocks.
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const PW = 'AutoTest_Pw_2026!';
const TODAY = new Date().toISOString().slice(0, 10);
const FROM = `${TODAY.slice(0, 8)}01`;
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00.000Z') + n * 86400000).toISOString().slice(0, 10);
const PRIOR = addDays(FROM, -5);

interface Co { id: string; adminId: string; admin: string }
let A: Co, B: Co;
let viewer = '', designer = '', nobody = '';
let branchA = '', branchB2 = '';
let ids: Record<string, string> = {};
const cleanup: string[] = [];

async function api(session: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers: { 'x-session-id': session, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) } });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json().catch(() => ({})) : await res.arrayBuffer() };
}
const get = (s: string, p: string) => api(s, p);
const post = (s: string, p: string, b: any = {}) => api(s, p, { method: 'POST', body: JSON.stringify(b) });
const put = (s: string, p: string, b: any) => api(s, p, { method: 'PUT', body: JSON.stringify(b) });
const patch = (s: string, p: string) => api(s, p, { method: 'PATCH' });
async function login(username: string) {
  const r = await (await fetch(`${BASE_URL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PW }) })).json();
  if (!r.sessionId) throw new Error('login failed');
  return r.sessionId as string;
}
async function mkCompany(name: string): Promise<Co> {
  const id = generateId();
  await db.insert(schema.companies).values({ id, name, address: 'x', phone: '0', email: `${id.slice(0, 8)}@example.com`, logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false } as any);
  await db.transaction(async (tx: any) => provisionStarterResources(tx, { companyId: id, companyName: name }));
  cleanup.push(id);
  const adminId = generateId(); const username = `re_${adminId.slice(-12)}`;
  await db.insert(schema.users).values({ id: adminId, username, password: await bcrypt.hash(PW, 10), role: 'admin', companyId: id, isSuperAdmin: false, uiLanguage: 'en' });
  return { id, adminId, admin: await login(username) };
}
async function mkUser(companyId: string, permissions: any) {
  const roleId = generateId(), userId = generateId(), username = `reu_${userId.slice(-12)}`;
  await db.insert(schema.roles).values({ id: roleId, companyId, name: `Role ${roleId.slice(-6)}`, permissions });
  await db.insert(schema.users).values({ id: userId, username, password: await bcrypt.hash(PW, 10), role: 'user', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  await db.insert(schema.userRoles).values({ userId, roleId });
  return login(username);
}
const on = (...keys: string[]) => Object.fromEntries(keys.map(k => [k, { enabled: true }]));
const acct = (list: any[], code: string) => list.find(a => a.code === code);
const rowOf = (rep: any, label: string) => rep.rows.find((r: any) => r.label === label);
const cell = (rep: any, label: string, col = 0) => rowOf(rep, label)?.cells[col];
const run = async (s: string, id: string, extra: Record<string, string> = {}) => (await runReport(s, id, { from: FROM, to: TODAY, ...extra }));

beforeAll(async () => {
  A = await mkCompany('GL Report Engine Test Co A');
  B = await mkCompany('GL Report Engine Test Co B');
  viewer = await mkUser(A.id, { reports: on('trialBalanceLedger', 'incomeStatementLedger', 'balanceSheetLedger', 'generalLedger'), branches: on('viewAllBranches') });
  designer = await mkUser(A.id, { reportDefinitions: on('create', 'read', 'update', 'delete'), reports: on('incomeStatementLedger', 'customLedgerReports'), branches: on('viewAllBranches') });
  nobody = await mkUser(A.id, {});
  const list = (await get(A.admin, '/api/ledger/accounts')).body.accounts as any[];
  ids = { exp: acct(list, '6200').id, dep: acct(list, '6700').id, accDep: acct(list, '1450').id, accrued: acct(list, '2200').id, opex: acct(list, '6000').id, other: acct(list, '4100').id };
  const [bA] = (await db.insert(schema.branches).values({ id: generateId(), companyId: A.id, name: 'Jeddah', code: 'JED' } as any).returning()) as any[];
  const [bB] = (await db.insert(schema.branches).values({ id: generateId(), companyId: A.id, name: 'Riyadh', code: 'RUH' } as any).returning()) as any[];
  branchA = bA.id; branchB2 = bB.id;
  const post1 = (date: string, branchId: string | null, lines: any[], description = 'engine test') => postJournalEntry(db, { companyId: A.id, branchId, postingDate: date, referenceType: 'Test', referenceId: generateId(), description, createdById: A.adminId, lines });
  await post1(PRIOR, branchA, [{ accountKey: 'AR', debit: 500 }, { accountKey: 'SALES_REVENUE', credit: 500 }]);
  await post1(TODAY, branchA, [{ accountKey: 'AR', debit: 1150 }, { accountKey: 'SALES_REVENUE', credit: 1000 }, { accountKey: 'VAT_OUTPUT', credit: 150 }]);
  await post1(TODAY, branchB2, [{ accountKey: 'COGS', debit: 400 }, { accountKey: 'INVENTORY', credit: 400 }]);
  await post1(TODAY, branchA, [{ accountId: ids.exp, debit: 120 }, { accountId: ids.accrued, credit: 120 }]);
  await post1(TODAY, branchA, [{ accountId: ids.dep, debit: 50 }, { accountId: ids.accDep, credit: 50 }]);
  await post1(TODAY, null, [{ accountKey: 'BANK', debit: 5000 }, { accountKey: 'PAID_IN_CAPITAL', credit: 5000 }]);
}, 180000);
afterAll(async () => { for (const id of cleanup) await purgeCompany(id); }, 180000);

describe('the standard definitions', () => {
  it('every company has Trial Balance, Income Statement, Balance Sheet, Cash Flow and Changes in Equity as editable defaults, and another company sees none of them', async () => {
    const a = (await get(A.admin, '/api/ledger/report-definitions')).body.definitions;
    expect(a.map((d: any) => d.reportType).sort()).toEqual(['BalanceSheet', 'CashFlow', 'ChangesInEquity', 'PnL', 'TrialBalance']);
    expect(a.every((d: any) => d.isSystemSeeded && d.isDefault && d.isActive && d.rowCount > 3 && d.columnCount >= 2)).toBe(true);
    const b = (await get(B.admin, '/api/ledger/report-definitions')).body.definitions;
    expect(b).toHaveLength(5);
    expect(new Set([...a, ...b].map((d: any) => d.id)).size).toBe(10);
    expect((await get(B.admin, `/api/ledger/report-definitions/${a[0].id}`)).status).toBe(404);
    expect((await runReport(B.admin, a[0].id, { from: FROM, to: TODAY })).status).toBe(404);
  });

  it('Income Statement: revenue shows positive, subtotals and formulas follow, the previous period and the variance columns tie', async () => {
    const id = await defaultDefinitionId(A.admin, 'PnL');
    const r = (await run(A.admin, id)).body;
    expect(r.columns.map((c: any) => c.kind)).toEqual(['Value', 'Value', 'Variance', 'Percent']);
    expect(cell(r, 'Total revenue').v).toBe(1000);
    expect(cell(r, 'Total cost of sales').v).toBe(400);
    expect(cell(r, 'Gross profit').v).toBe(600);
    expect(cell(r, 'Total operating expenses').v).toBe(170);
    expect(cell(r, 'Net profit').v).toBe(430);
    expect(cell(r, 'Total revenue', 1).v).toBe(500); // the previous period holds the 500 sale
    expect(cell(r, 'Total revenue', 2).v).toBe(500); // variance
    expect(cell(r, 'Total revenue', 3).v).toBe(100); // percent of the previous period
    expect(r.checks.uncovered).toBe(0);
    expect(r.columns[1].window.to).toBe(addDays(FROM, -1));
  });

  it('Balance Sheet balances, carries profit to date inside equity, and compares with the prior year end', async () => {
    const id = await defaultDefinitionId(A.admin, 'BalanceSheet');
    const r = (await run(A.admin, id)).body;
    expect(cell(r, 'Total assets').v).toBe(6200);
    expect(cell(r, 'Total liabilities').v).toBe(270);
    expect(cell(r, 'Profit (loss) to date').v).toBe(930);
    expect(cell(r, 'Total equity').v).toBe(5930);
    expect(cell(r, 'Total liabilities and equity').v).toBe(6200);
    expect(r.checks.balanced).toBe(true); expect(r.checks.difference).toBe(0);
    expect(cell(r, 'Total assets', 1).v).toBe(0); // nothing existed at the end of last year
  });

  it('Trial Balance balances in opening, movement and closing, in Summary and in Detailed mode', async () => {
    const id = await defaultDefinitionId(A.admin, 'TrialBalance');
    const s = (await run(A.admin, id, { mode: 'Summary' })).body;
    const d = (await run(A.admin, id, { mode: 'Detailed' })).body;
    expect(s.checks.balanced).toBe(true); expect(d.checks.balanced).toBe(true);
    expect(s.checks.totals).toHaveLength(3);
    expect(s.rows.every((r: any) => !r.detail)).toBe(true);
    const detail = d.rows.flatMap((r: any) => r.detail || []);
    const bank = detail.find((x: any) => x.name.toLowerCase().includes('bank') && x.cells[2].dr === 5000);
    expect(bank).toBeTruthy();
    expect(detail.find((x: any) => x.code === '6200').cells[1].dr).toBe(120);
  });

  it('a viewer needs the report\'s own permission, and the designer permissions do not give it', async () => {
    const pl = await defaultDefinitionId(A.admin, 'PnL');
    expect((await run(viewer, pl)).status).toBe(200);
    expect((await run(nobody, pl)).status).toBe(403);
    expect((await run(designer, pl)).status).toBe(200); // designer also holds incomeStatementLedger
    const bs = await defaultDefinitionId(A.admin, 'BalanceSheet');
    expect((await run(designer, bs)).status).toBe(403);
    expect((await get(nobody, '/api/ledger/report-definitions')).status).toBe(403);
    expect((await get(viewer, '/api/ledger/report-definitions?type=PnL')).body.definitions).toHaveLength(1);
  });
});

describe('cash flow and changes in equity', () => {
  it('Cash Flow (indirect) explains the change in cash and agrees with the bank and cash accounts', async () => {
    const id = await defaultDefinitionId(A.admin, 'CashFlow');
    const r = (await run(A.admin, id)).body;
    expect(cell(r, 'Net profit for the period').v).toBe(430);
    expect(cell(r, 'Depreciation (non-cash)').v).toBe(50);
    expect(cell(r, 'Change in receivables, inventory and other current assets').v).toBe(-750); // receivables +1150, inventory -400
    expect(cell(r, 'Change in payables and other current liabilities').v).toBe(270); // VAT output and accrued expenses
    expect(cell(r, 'Net cash from operating activities').v).toBe(0);
    expect(cell(r, 'Net cash used in investing activities').v).toBe(0);
    expect(cell(r, 'Net cash from financing activities').v).toBe(5000);
    expect(cell(r, 'Net change in cash').v).toBe(5000);
    expect(cell(r, 'Cash at the beginning of the period').v).toBe(0);
    expect(cell(r, 'Cash at the end of the period').v).toBe(5000);
    expect(r.checks.balanced).toBe(true); expect(r.checks.difference).toBe(0);
    // the previous period only holds the 500 credit sale: profit 500 offset by receivables -500
    expect(cell(r, 'Net profit for the period', 1).v).toBe(500);
    expect(cell(r, 'Net change in cash', 1).v).toBe(0);
    // the opening cash of a later period is the closing cash of the earlier one
    const later = (await runReport(A.admin, id, { from: addDays(TODAY, 1), to: addDays(TODAY, 30) })).body;
    expect(cell(later, 'Cash at the beginning of the period').v).toBe(5000);
    expect(cell(later, 'Net change in cash').v).toBe(0);
    expect(later.checks.balanced).toBe(true);
  });

  it('Changes in Equity: opening equity plus profit and equity movements equals the balance sheet equity', async () => {
    const id = await defaultDefinitionId(A.admin, 'ChangesInEquity');
    const r = (await run(A.admin, id)).body;
    expect(cell(r, 'Profit (loss) brought forward').v).toBe(500); // the prior sale, before the period began
    expect(rowOf(r, 'Equity at the beginning of the period').cells[0].v).toBe(500);
    expect(cell(r, 'Profit (loss) for the period').v).toBe(430);
    expect(r.rows.filter((x: any) => x.label === 'Owner Capital').map((x: any) => x.cells[0].v)).toEqual([0, 5000]); // at the start, then the movement
    expect(cell(r, 'Total changes during the period').v).toBe(5430);
    expect(cell(r, 'Equity at the end of the period').v).toBe(5930);
    expect(r.checks.balanced).toBe(true); expect(r.checks.difference).toBe(0);
    const bs = (await run(A.admin, await defaultDefinitionId(A.admin, 'BalanceSheet'))).body;
    expect(cell(bs, 'Total equity').v).toBe(cell(r, 'Equity at the end of the period').v);
  });

  it('a row can pin itself to the opening balance, the Cash selector finds every bank account, and a pinned row may repeat an account a movement row has', async () => {
    const rd = (await post(A.admin, '/api/ledger/report-definitions', { name: 'Cash position', reportType: 'Custom' })).body.id;
    const design = {
      rows: [
        { rowNumber: 10, rowType: 'Accounts', label: 'Cash at start', valueBasis: 'OpeningBalance', selectors: [{ mode: 'Include', selectorType: 'Cash' }] },
        { rowNumber: 20, rowType: 'Accounts', label: 'Cash moved', selectors: [{ mode: 'Include', selectorType: 'Cash' }] },
        { rowNumber: 30, rowType: 'Calculated', label: 'Cash at end', calcFormula: [{ rowNumber: 10, sign: 1 }, { rowNumber: 20, sign: 1 }] },
      ],
      columns: [{ columnNumber: 1, label: 'Period', columnKind: 'Value', periodBasis: 'CurrentPeriod', valueBasis: 'Movement', presentation: 'Single' }],
    };
    expect((await put(A.admin, `/api/ledger/report-definitions/${rd}`, design)).status).toBe(200);
    const rep = (await run(A.admin, rd)).body;
    expect(cell(rep, 'Cash at start').v).toBe(0); expect(cell(rep, 'Cash moved').v).toBe(5000); expect(cell(rep, 'Cash at end').v).toBe(5000);
    // the same account twice at the same balance point is still refused
    const twice = { ...design, rows: [design.rows[1], { ...design.rows[1], rowNumber: 21, label: 'Again' }] };
    const res = await put(A.admin, `/api/ledger/report-definitions/${rd}`, twice);
    expect(res.status).toBe(400); expect(res.body.error).toMatch(/already counted/i);
    expect((await put(A.admin, `/api/ledger/report-definitions/${rd}`, { ...design, rows: [{ ...design.rows[0], valueBasis: 'Bogus' }] })).status).toBe(400);
  });

  it('each statement needs its own view permission', async () => {
    const cf = await defaultDefinitionId(A.admin, 'CashFlow'), eq2 = await defaultDefinitionId(A.admin, 'ChangesInEquity');
    expect((await run(viewer, cf)).status).toBe(403); expect((await run(viewer, eq2)).status).toBe(403);
    const reader = await mkUser(A.id, { reports: on('cashFlowLedger', 'equityChangesLedger'), branches: on('viewAllBranches') });
    expect((await run(reader, cf)).status).toBe(200); expect((await run(reader, eq2)).status).toBe(200);
    expect((await run(reader, await defaultDefinitionId(A.admin, 'PnL'))).status).toBe(403);
  });
});

describe('designing a custom report', () => {
  let custom = '';
  const design = (rows: any[], columns?: any[]) => ({ rows, columns: columns || [{ columnNumber: 1, label: 'Period', columnKind: 'Value', periodBasis: 'CurrentPeriod', valueBasis: 'Movement', presentation: 'Single' }] });

  it('copies a standard report, edits it, and only a user who may design can', async () => {
    const pl = await defaultDefinitionId(A.admin, 'PnL');
    expect((await post(viewer, '/api/ledger/report-definitions', { name: 'Mine', cloneFromId: pl })).status).toBe(403);
    const c = await post(designer, '/api/ledger/report-definitions', { name: 'Management P&L', cloneFromId: pl });
    expect(c.status).toBe(200); custom = c.body.id;
    expect((await post(designer, '/api/ledger/report-definitions', { name: 'Management P&L', cloneFromId: pl })).status).toBe(400); // name taken
    const full = (await get(designer, `/api/ledger/report-definitions/${custom}`)).body;
    expect(full.rows.length).toBeGreaterThan(5); expect(full.reportType).toBe('PnL'); expect(full.isSystemSeeded).toBe(false);
    expect((await put(viewer, `/api/ledger/report-definitions/${custom}`, { name: 'x' })).status).toBe(403);
    expect((await put(B.admin, `/api/ledger/report-definitions/${custom}`, { name: 'x' })).status).toBe(404);
  });

  it('selects accounts by range, rollup, type and role, with include and exclude, and refuses an account counted twice', async () => {
    const r = design([
      { rowNumber: 10, rowType: 'Accounts', label: 'Opex excluding depreciation', selectors: [{ mode: 'Include', selectorType: 'ParentRollup', accountId: ids.opex }, { mode: 'Exclude', selectorType: 'Account', accountId: ids.dep }] },
      { rowNumber: 20, rowType: 'Accounts', label: 'Depreciation only', selectors: [{ mode: 'Include', selectorType: 'Account', accountId: ids.dep }] },
      { rowNumber: 30, rowType: 'Accounts', label: 'Revenue by range', flipSign: true, selectors: [{ mode: 'Include', selectorType: 'Range', rangeStart: '4000', rangeEnd: '4999' }] },
      { rowNumber: 40, rowType: 'Accounts', label: 'COGS by role', selectors: [{ mode: 'Include', selectorType: 'Role', systemKey: 'COGS' }] },
    ]);
    expect((await put(designer, `/api/ledger/report-definitions/${custom}`, r)).status).toBe(200);
    const rep = (await run(designer, custom)).body;
    expect(cell(rep, 'Opex excluding depreciation').v).toBe(120);
    expect(cell(rep, 'Depreciation only').v).toBe(50);
    expect(cell(rep, 'Revenue by range').v).toBe(1000);
    expect(cell(rep, 'COGS by role').v).toBe(400);
    // an account in two Accounts rows is refused
    const dup = design([
      { rowNumber: 10, rowType: 'Accounts', label: 'A', selectors: [{ mode: 'Include', selectorType: 'ParentRollup', accountId: ids.opex }] },
      { rowNumber: 20, rowType: 'Accounts', label: 'B', selectors: [{ mode: 'Include', selectorType: 'Account', accountId: ids.dep }] },
    ]);
    const res = await put(designer, `/api/ledger/report-definitions/${custom}`, dup);
    expect(res.status).toBe(400); expect(res.body.error).toMatch(/already counted/i);
    // the other company's account is not selectable
    const foreign = (await get(B.admin, '/api/ledger/accounts')).body.accounts.find((a: any) => a.code === '6200').id;
    expect((await put(designer, `/api/ledger/report-definitions/${custom}`, design([{ rowNumber: 10, rowType: 'Accounts', label: 'X', selectors: [{ mode: 'Include', selectorType: 'Account', accountId: foreign }] }]))).status).toBe(400);
    // an unknown role, a backwards range, an unknown type
    for (const sel of [{ mode: 'Include', selectorType: 'Role', systemKey: 'NOPE' }, { mode: 'Include', selectorType: 'Range', rangeStart: '9', rangeEnd: '1' }, { mode: 'Include', selectorType: 'Type', accountType: 'Bogus' }]) {
      expect((await put(designer, `/api/ledger/report-definitions/${custom}`, design([{ rowNumber: 10, rowType: 'Accounts', label: 'X', selectors: [sel] }]))).status).toBe(400);
    }
  });

  it('every balance display rule, subtotals since the last subtotal, formulas, hidden and non-zero rows', async () => {
    // build with a single Type row per display to keep accounts disjoint
    const rows = [
      { rowNumber: 10, rowType: 'Accounts', label: 'Expenses', selectors: [{ mode: 'Include', selectorType: 'Type', accountType: 'Expense' }] },
      { rowNumber: 20, rowType: 'Accounts', label: 'Liabilities credit balances', balanceDisplay: 'CreditBalances', selectors: [{ mode: 'Include', selectorType: 'Type', accountType: 'Liability' }] },
      { rowNumber: 30, rowType: 'Accounts', label: 'Assets debit balances', balanceDisplay: 'DebitBalances', selectors: [{ mode: 'Include', selectorType: 'Type', accountType: 'Asset' }] },
      { rowNumber: 40, rowType: 'Subtotal', label: 'Sub since start' },
      { rowNumber: 50, rowType: 'Accounts', label: 'Equity', flipSign: true, selectors: [{ mode: 'Include', selectorType: 'Type', accountType: 'Equity' }] },
      { rowNumber: 60, rowType: 'Subtotal', label: 'Sub after first' },
      { rowNumber: 70, rowType: 'Calculated', label: 'Formula', calcFormula: [{ rowNumber: 40, sign: 1 }, { rowNumber: 60, sign: -1 }] },
      { rowNumber: 80, rowType: 'Accounts', label: 'Revenue helper', flipSign: true, format: { show: 'hidden' }, selectors: [{ mode: 'Include', selectorType: 'Type', accountType: 'Revenue' }] },
      { rowNumber: 90, rowType: 'Text', label: 'A note', format: { italic: true } },
      { rowNumber: 100, rowType: 'Spacer' },
    ];
    expect((await put(designer, `/api/ledger/report-definitions/${custom}`, design(rows))).status).toBe(200);
    const rep = (await run(designer, custom)).body;
    expect(cell(rep, 'Expenses').v).toBe(570); // 400 + 120 + 50
    expect(cell(rep, 'Liabilities credit balances').v).toBe(270);
    expect(cell(rep, 'Assets debit balances').v).toBe(5000 + 1150); // this period's movement; only accounts with a debit movement count (inventory and accumulated depreciation moved the other way)
    expect(cell(rep, 'Sub since start').v).toBe(570 + 270 + 6150);
    expect(cell(rep, 'Equity').v).toBe(5000);
    expect(cell(rep, 'Sub after first').v).toBe(5000); // only the rows since the previous subtotal
    expect(cell(rep, 'Formula').v).toBe(570 + 270 + 6150 - 5000);
    expect(rowOf(rep, 'Revenue helper')).toBeUndefined(); // hidden rows are calculated but not shown
    expect(rowOf(rep, 'A note').format.italic).toBe(true);
    // a formula may only use earlier rows
    const bad = [{ rowNumber: 10, rowType: 'Calculated', label: 'Bad', calcFormula: [{ rowNumber: 20, sign: 1 }] }, { rowNumber: 20, rowType: 'Accounts', label: 'X', selectors: [{ mode: 'Include', selectorType: 'Type', accountType: 'Asset' }] }];
    expect((await put(designer, `/api/ledger/report-definitions/${custom}`, design(bad))).status).toBe(400);
    expect((await put(designer, `/api/ledger/report-definitions/${custom}`, design([{ rowNumber: 10, rowType: 'Accounts', label: 'Dup', selectors: [{ mode: 'Include', selectorType: 'Type', accountType: 'Asset' }] }, { rowNumber: 10, rowType: 'Text', label: 'same number' }]))).status).toBe(400);
  });

  it('every column option: debit / credit / opening / closing bases, Dr / Cr pairs, custom ranges, and variance columns that compare value columns', async () => {
    const rows = [{ rowNumber: 10, rowType: 'Accounts', label: 'Expenses', selectors: [{ mode: 'Include', selectorType: 'Type', accountType: 'Expense' }] }];
    const columns = [
      { columnNumber: 1, label: 'Debits', columnKind: 'Value', periodBasis: 'CurrentPeriod', valueBasis: 'Debit' },
      { columnNumber: 2, label: 'Credits', columnKind: 'Value', periodBasis: 'CurrentPeriod', valueBasis: 'Credit' },
      { columnNumber: 3, label: 'Opening', columnKind: 'Value', periodBasis: 'CurrentPeriod', valueBasis: 'OpeningBalance' },
      { columnNumber: 4, label: 'Closing', columnKind: 'Value', periodBasis: 'CurrentPeriod', valueBasis: 'ClosingBalance' },
      { columnNumber: 5, label: 'Dr/Cr', columnKind: 'Value', periodBasis: 'CurrentPeriod', valueBasis: 'Movement', presentation: 'DrCr' },
      { columnNumber: 6, label: 'Whole year', columnKind: 'Value', periodBasis: 'YearToDate', valueBasis: 'Movement' },
      { columnNumber: 7, label: 'Custom', columnKind: 'Value', periodBasis: 'CustomRange', customFrom: TODAY, customTo: TODAY, valueBasis: 'Movement' },
      { columnNumber: 8, label: 'Change', columnKind: 'Variance', refColumnA: 4, refColumnB: 3 },
    ];
    expect((await put(designer, `/api/ledger/report-definitions/${custom}`, { rows, columns })).status).toBe(200);
    const rep = (await run(designer, custom)).body;
    const c = rowOf(rep, 'Expenses').cells;
    expect(c[0].v).toBe(570); expect(c[1].v).toBe(0); expect(c[2].v).toBe(0); expect(c[3].v).toBe(570);
    expect(c[4]).toMatchObject({ dr: 570, cr: 0 });
    expect(c[5].v).toBe(570); expect(c[6].v).toBe(570); expect(c[7].v).toBe(570);
    // a variance column needs two earlier single-figure value columns
    const badCols = [columns[4], { columnNumber: 2, label: 'Bad', columnKind: 'Variance', refColumnA: 1, refColumnB: 5 }];
    expect((await put(designer, `/api/ledger/report-definitions/${custom}`, { rows, columns: badCols })).status).toBe(400);
    expect((await put(designer, `/api/ledger/report-definitions/${custom}`, { rows, columns: [{ columnNumber: 1, label: 'x', periodBasis: 'CustomRange', customFrom: TODAY, customTo: FROM, valueBasis: 'Movement' }] })).status).toBe(400);
    expect((await put(designer, `/api/ledger/report-definitions/${custom}`, { rows, columns: [] })).status).toBe(400);
  });

  it('dimension filters on columns give a branch comparison, and on the run narrow the whole report', async () => {
    const opts = (await get(A.admin, '/api/ledger/dimension-options')).body;
    const branchType = opts.types.find((t: any) => t.code === 'BRANCH').id;
    const rows = [{ rowNumber: 10, rowType: 'Accounts', label: 'COGS', selectors: [{ mode: 'Include', selectorType: 'Role', systemKey: 'COGS' }] }, { rowNumber: 20, rowType: 'Accounts', label: 'Revenue', flipSign: true, selectors: [{ mode: 'Include', selectorType: 'Role', systemKey: 'SALES_REVENUE' }] }];
    const columns = [
      { columnNumber: 1, label: 'All branches', columnKind: 'Value', periodBasis: 'CurrentPeriod', valueBasis: 'Movement' },
      { columnNumber: 2, label: 'Jeddah', columnKind: 'Value', periodBasis: 'CurrentPeriod', valueBasis: 'Movement', dimensionFilter: { [branchType]: [branchA] } },
      { columnNumber: 3, label: 'Riyadh', columnKind: 'Value', periodBasis: 'CurrentPeriod', valueBasis: 'Movement', dimensionFilter: { [branchType]: [branchB2] } },
    ];
    expect((await put(designer, `/api/ledger/report-definitions/${custom}`, { rows, columns })).status).toBe(200);
    const rep = (await run(designer, custom)).body;
    expect(cell(rep, 'Revenue', 0).v).toBe(1000); expect(cell(rep, 'Revenue', 1).v).toBe(1000); expect(cell(rep, 'Revenue', 2).v).toBe(0);
    expect(cell(rep, 'COGS', 0).v).toBe(400); expect(cell(rep, 'COGS', 1).v).toBe(0); expect(cell(rep, 'COGS', 2).v).toBe(400);
    const narrowed = (await run(designer, custom, { dims: JSON.stringify({ [branchType]: [branchB2] }) })).body;
    expect(cell(narrowed, 'COGS', 0).v).toBe(400); expect(cell(narrowed, 'Revenue', 0).v).toBe(0);
    // a row-level filter, and a filter naming another company's value
    const rowFiltered = rows.map(r => r.rowNumber === 20 ? { ...r, dimensionFilter: { [branchType]: [branchB2] } } : r);
    expect((await put(designer, `/api/ledger/report-definitions/${custom}`, { rows: rowFiltered, columns: [columns[0]] })).status).toBe(200);
    expect(cell((await run(designer, custom)).body, 'Revenue').v).toBe(0);
    expect((await put(designer, `/api/ledger/report-definitions/${custom}`, { rows: rows.map(r => ({ ...r, dimensionFilter: { [branchType]: [generateId()] } })), columns: [columns[0]] })).status).toBe(400);
  });

  it('lists accounts that no row covers, with a warning count, so money is never silently left out', async () => {
    const rows = [{ rowNumber: 10, rowType: 'Accounts', label: 'Only revenue', flipSign: true, selectors: [{ mode: 'Include', selectorType: 'Type', accountType: 'Revenue' }] }];
    await put(designer, `/api/ledger/report-definitions/${custom}`, { rows, columns: [{ columnNumber: 1, label: 'P', columnKind: 'Value', periodBasis: 'CurrentPeriod', valueBasis: 'Movement' }] });
    const rep = (await run(designer, custom)).body;
    // this custom report is type PnL: expenses have figures and no row covers them
    expect(rep.checks.uncovered).toBeGreaterThanOrEqual(3);
    expect(rep.notInDefinition.map((n: any) => n.code)).toContain('6200');
  });

  it('refuses malformed formatting, sets the default, deactivates, and resets a standard report', async () => {
    const rowsBad = [{ rowNumber: 10, rowType: 'Text', label: 'x', format: { indent: 9 } }];
    expect((await put(designer, `/api/ledger/report-definitions/${custom}`, { rows: rowsBad, columns: [{ columnNumber: 1, label: 'P', columnKind: 'Value', valueBasis: 'Movement' }] })).status).toBe(400);
    expect((await put(designer, `/api/ledger/report-definitions/${custom}`, { rows: [{ rowNumber: 10, rowType: 'Text', label: 'x', format: { underline: 'wavy' } }], columns: [{ columnNumber: 1, label: 'P', columnKind: 'Value', valueBasis: 'Movement' }] })).status).toBe(400);
    expect((await patch(designer, `/api/ledger/report-definitions/${custom}/set-default`)).status).toBe(200);
    const pl = (await get(A.admin, '/api/ledger/report-definitions?type=PnL')).body.definitions;
    expect(pl.filter((d: any) => d.isDefault)).toHaveLength(1);
    expect(pl.find((d: any) => d.isDefault).id).toBe(custom);
    const std = pl.find((d: any) => d.isSystemSeeded);
    expect((await patch(designer, `/api/ledger/report-definitions/${custom}/toggle-active`)).status).toBe(400); // the default cannot be switched off
    expect((await patch(designer, `/api/ledger/report-definitions/${std.id}/set-default`)).status).toBe(200);
    expect((await patch(designer, `/api/ledger/report-definitions/${custom}/toggle-active`)).status).toBe(200);
    expect((await patch(viewer, `/api/ledger/report-definitions/${custom}/toggle-active`)).status).toBe(403);
    // reset: edit the standard Income Statement down to one row, then restore it from the chart
    await put(designer, `/api/ledger/report-definitions/${std.id}`, { rows: [{ rowNumber: 10, rowType: 'Text', label: 'emptied' }], columns: [{ columnNumber: 1, label: 'P', columnKind: 'Value', valueBasis: 'Movement' }] });
    expect((await post(designer, `/api/ledger/report-definitions/${std.id}/reset`)).status).toBe(200);
    expect(cell((await run(A.admin, std.id)).body, 'Net profit').v).toBe(430);
    expect((await post(designer, `/api/ledger/report-definitions/${custom}/reset`)).status).toBe(400); // not a standard report
  });
});

describe('drill-down, preview and Excel export', () => {
  it('every figure names the accounts, period and basis behind it, and the General Ledger reproduces it', async () => {
    const id = await defaultDefinitionId(A.admin, 'PnL');
    const r = (await run(A.admin, id)).body;
    const total = cell(r, 'Total operating expenses', 0);
    expect(total.drill.accountIds.length).toBeGreaterThan(1);
    const gl = (await get(A.admin, `/api/ledger/reports/general-ledger?accountIds=${total.drill.accountIds.join(',')}&from=${total.drill.from}&to=${total.drill.to}`)).body;
    expect(gl.totals.debit - gl.totals.credit).toBe(total.v);
    expect((await get(A.admin, `/api/ledger/reports/general-ledger?accountIds=${generateId()}&from=${FROM}&to=${TODAY}`)).status).toBe(404);
  });

  it('previews an unsaved design without saving it', async () => {
    const before = (await get(A.admin, '/api/ledger/report-definitions')).body.definitions.length;
    const p = await post(designer, '/api/ledger/report-definitions/preview', { reportType: 'Custom', from: FROM, to: TODAY, rows: [{ rowNumber: 10, rowType: 'Accounts', label: 'Cash and bank', selectors: [{ mode: 'Include', selectorType: 'Role', systemKey: 'BANK' }] }], columns: [{ columnNumber: 1, label: 'Closing', columnKind: 'Value', periodBasis: 'AsAtEnd', valueBasis: 'ClosingBalance' }] });
    expect(p.status).toBe(200); expect(cell(p.body, 'Cash and bank').v).toBe(5000);
    expect((await get(A.admin, '/api/ledger/report-definitions')).body.definitions.length).toBe(before);
    expect((await post(viewer, '/api/ledger/report-definitions/preview', { reportType: 'Custom', rows: [], columns: [] })).status).toBe(403);
    expect((await post(designer, '/api/ledger/report-definitions/preview', { reportType: 'Custom', rows: [], columns: [] })).status).toBe(400);
  });

  it('exports an Excel workbook that carries the formatting (bold, double underline, shading, number formats)', async () => {
    const id = await defaultDefinitionId(A.admin, 'PnL');
    const res = await fetch(`${BASE_URL}/api/ledger/report-definitions/${id}/export?from=${FROM}&to=${TODAY}`, { headers: { 'x-session-id': A.admin } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    const ws = wb.worksheets[0];
    let net: ExcelJS.Row | undefined; let heading: ExcelJS.Row | undefined;
    ws.eachRow(row => { const v = String(row.getCell(1).value ?? ''); if (v === 'Net profit') net = row; if (v === 'Revenue') heading = row; });
    expect(net).toBeTruthy(); expect(heading).toBeTruthy();
    expect(net!.getCell(1).font?.bold).toBe(true);
    expect(net!.getCell(1).font?.underline).toBe('double');
    expect(Number(net!.getCell(2).value)).toBe(430);
    expect(net!.getCell(2).numFmt).toContain('#,##0.00');
    expect((net!.getCell(2).fill as any)?.fgColor?.argb).toBe('FFF1F2F8');
    expect(heading!.font?.bold).toBe(true);
    expect((await fetch(`${BASE_URL}/api/ledger/report-definitions/${id}/export`, { headers: { 'x-session-id': nobody } })).status).toBe(403);
  });
});

describe('integrity', () => {
  it('the report tables carry the company and refuse a selector pointing at another company\'s account (composite foreign key)', async () => {
    const [d] = await db.select().from(schema.reportDefinitions).where(eq(schema.reportDefinitions.companyId, A.id));
    const [row] = await db.select().from(schema.reportRows).where(eq(schema.reportRows.reportDefinitionId, d.id));
    const bAcct = (await get(B.admin, '/api/ledger/accounts')).body.accounts[0].id;
    await expect(db.insert(schema.reportRowSelectors).values({ id: generateId(), companyId: A.id, reportRowId: row.id, mode: 'Include', selectorType: 'Account', accountId: bAcct } as any)).rejects.toBeTruthy();
    await expect(db.insert(schema.reportRows).values({ id: generateId(), companyId: B.id, reportDefinitionId: d.id, rowNumber: 99999, sortOrder: 99999, rowType: 'Spacer' } as any)).rejects.toBeTruthy();
  });
});
