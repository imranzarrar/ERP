// The Report Definition engine (Finance Core Blueprint FR-RPT-CFG, docs/gl-step1-5-decisions.md). Every ledger statement (Trial Balance, Income Statement,
// Balance Sheet, custom reports) is a definition of ROWS x COLUMNS evaluated against journal lines:
//   row    = a heading, a group of accounts (include / exclude selectors, a balance display rule), a subtotal, a formula over other rows, profit to date, text
//   column = a period basis x a value basis x an optional dimension filter, shown as one figure or as a debit / credit pair, or a variance / percent of columns
// Figures are computed in Postgres for the one company of the request (through resolvedLines, the single definition of "which account does a line belong
// to"); every figure carries the account set, period and filters behind it so the screen can drill into the General Ledger.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { generateId } from '../../src/id.js';
import { nowDate } from './clock.js';
import { normalizeFormat, type ReportFormat } from '../../src/reportFormat.js';
import { resolvedLines, round2 } from './ledgerQueries.js';
import { parseDimFilters, type DimFilter } from './dimensions.js';

export type ReportType = 'TrialBalance' | 'PnL' | 'BalanceSheet' | 'CashFlow' | 'ChangesInEquity' | 'Custom';
export interface Selector { mode: 'Include' | 'Exclude'; selectorType: 'Account' | 'ParentRollup' | 'Range' | 'Type' | 'Role' | 'Cash'; accountId?: string | null; rangeStart?: string | null; rangeEnd?: string | null; accountType?: string | null; systemKey?: string | null }
export interface EngineRow {
  rowNumber: number; rowType: 'Heading' | 'Accounts' | 'Subtotal' | 'Calculated' | 'ProfitToDate' | 'Text' | 'Spacer'; label: string | null; labelAr: string | null;
  balanceDisplay: 'Net' | 'Debit' | 'Credit' | 'DebitBalances' | 'CreditBalances' | 'Split'; flipSign: boolean; valueBasis: 'OpeningBalance' | 'ClosingBalance' | null; calcFormula: { rowNumber: number; sign: number }[] | null;
  role: string | null; dimensionFilter: Record<string, string[]> | null; format: ReportFormat; selectors: Selector[];
}
export interface EngineColumn {
  columnNumber: number; label: string; labelAr: string | null; columnKind: 'Value' | 'Variance' | 'Percent';
  periodBasis: 'CurrentPeriod' | 'YearToDate' | 'PriorPeriod' | 'PriorYear' | 'AsAtEnd' | 'AsAtPriorYearEnd' | 'AsAtPriorPeriodEnd' | 'CustomRange';
  customFrom: string | null; customTo: string | null; valueBasis: 'Debit' | 'Credit' | 'Movement' | 'OpeningBalance' | 'ClosingBalance'; presentation: 'Single' | 'DrCr';
  dimensionFilter: Record<string, string[]> | null; refColumnA: number | null; refColumnB: number | null; format: ReportFormat;
}
export interface EngineDefinition { id?: string; name: string; nameAr?: string | null; reportType: ReportType; defaultDisplayMode: 'Summary' | 'Detailed'; rows: EngineRow[]; columns: EngineColumn[] }

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const cmpCode = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00.000Z') + n * 86400000).toISOString().slice(0, 10);
const shiftYear = (d: string, years: number) => { const [y, m, day] = d.split('-').map(Number); const last = new Date(Date.UTC(y + years, m, 0)).getUTCDate(); return `${y + years}-${String(m).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`; };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;

// ---------------- loading and saving a definition ----------------
export async function loadDefinition(tx: any, companyId: string, id: string): Promise<(EngineDefinition & { id: string; isSystemSeeded: boolean; isDefault: boolean; isActive: boolean }) | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [d] = await tx.select().from(schema.reportDefinitions).where(and(eq(schema.reportDefinitions.id, id), eq(schema.reportDefinitions.companyId, companyId)));
  if (!d) return null;
  const rows: any[] = await tx.select().from(schema.reportRows).where(and(eq(schema.reportRows.reportDefinitionId, id), eq(schema.reportRows.companyId, companyId))).orderBy(asc(schema.reportRows.sortOrder));
  const sels: any[] = rows.length ? await tx.select().from(schema.reportRowSelectors).where(and(eq(schema.reportRowSelectors.companyId, companyId), inArray(schema.reportRowSelectors.reportRowId, rows.map(r => r.id)))) : [];
  const cols: any[] = await tx.select().from(schema.reportColumns).where(and(eq(schema.reportColumns.reportDefinitionId, id), eq(schema.reportColumns.companyId, companyId))).orderBy(asc(schema.reportColumns.columnNumber));
  return {
    id: d.id, name: d.name, nameAr: d.nameAr, reportType: d.reportType, defaultDisplayMode: d.defaultDisplayMode, isSystemSeeded: d.isSystemSeeded, isDefault: d.isDefault, isActive: d.isActive,
    rows: rows.map(r => ({
      rowNumber: r.rowNumber, rowType: r.rowType, label: r.label, labelAr: r.labelAr, balanceDisplay: r.balanceDisplay, flipSign: r.flipSign, valueBasis: r.valueBasis || null, calcFormula: r.calcFormula, role: r.role,
      dimensionFilter: r.dimensionFilter, format: r.format || {},
      selectors: sels.filter(s => s.reportRowId === r.id).map(s => ({ mode: s.mode, selectorType: s.selectorType, accountId: s.accountId, rangeStart: s.rangeStart, rangeEnd: s.rangeEnd, accountType: s.accountType, systemKey: s.systemKey })),
    })),
    columns: cols.map(c => ({ columnNumber: c.columnNumber, label: c.label, labelAr: c.labelAr, columnKind: c.columnKind, periodBasis: c.periodBasis, customFrom: c.customFrom, customTo: c.customTo, valueBasis: c.valueBasis, presentation: c.presentation, dimensionFilter: c.dimensionFilter, refColumnA: c.refColumnA, refColumnB: c.refColumnB, format: c.format || {} })),
  };
}

// Replaces the rows, selectors and columns of a definition (the designer sends the whole design). The design is validated first; nothing is written if it is not valid.
export async function saveDesign(tx: any, companyId: string, definitionId: string, design: { rows: EngineRow[]; columns: EngineColumn[] }): Promise<void> {
  const oldRows: any[] = await tx.select({ id: schema.reportRows.id }).from(schema.reportRows).where(and(eq(schema.reportRows.reportDefinitionId, definitionId), eq(schema.reportRows.companyId, companyId)));
  if (oldRows.length) await tx.delete(schema.reportRowSelectors).where(and(eq(schema.reportRowSelectors.companyId, companyId), inArray(schema.reportRowSelectors.reportRowId, oldRows.map(r => r.id))));
  await tx.delete(schema.reportRows).where(and(eq(schema.reportRows.reportDefinitionId, definitionId), eq(schema.reportRows.companyId, companyId)));
  await tx.delete(schema.reportColumns).where(and(eq(schema.reportColumns.reportDefinitionId, definitionId), eq(schema.reportColumns.companyId, companyId)));
  let order = 0;
  for (const r of design.rows) {
    const rowId = generateId();
    await tx.insert(schema.reportRows).values({
      id: rowId, companyId, reportDefinitionId: definitionId, rowNumber: r.rowNumber, sortOrder: order++, rowType: r.rowType, label: r.label || null, labelAr: r.labelAr || null,
      balanceDisplay: r.balanceDisplay, flipSign: r.flipSign, valueBasis: r.valueBasis || null, calcFormula: r.calcFormula && r.calcFormula.length ? r.calcFormula : null, role: r.role || null,
      dimensionFilter: r.dimensionFilter && Object.keys(r.dimensionFilter).length ? r.dimensionFilter : null, format: r.format || {},
    });
    for (const s of r.selectors) {
      // isolation-ok: every accountId in a selector was verified to be this company's own account by validateDesign before saveDesign runs
      await tx.insert(schema.reportRowSelectors).values({ id: generateId(), companyId, reportRowId: rowId, mode: s.mode, selectorType: s.selectorType, accountId: s.accountId || null, rangeStart: s.rangeStart || null, rangeEnd: s.rangeEnd || null, accountType: s.accountType || null, systemKey: s.systemKey || null });
    }
  }
  for (const c of design.columns) {
    await tx.insert(schema.reportColumns).values({
      id: generateId(), companyId, reportDefinitionId: definitionId, columnNumber: c.columnNumber, label: c.label, labelAr: c.labelAr || null, columnKind: c.columnKind, periodBasis: c.periodBasis,
      customFrom: c.customFrom || null, customTo: c.customTo || null, valueBasis: c.valueBasis, presentation: c.presentation,
      dimensionFilter: c.dimensionFilter && Object.keys(c.dimensionFilter).length ? c.dimensionFilter : null, refColumnA: c.refColumnA ?? null, refColumnB: c.refColumnB ?? null, format: c.format || {},
    });
  }
}

// ---------------- chart helpers ----------------
async function loadChart(tx: any, companyId: string): Promise<any[]> {
  const rows: any[] = await tx.select().from(schema.companyAccounts).where(eq(schema.companyAccounts.companyId, companyId));
  return rows.sort((a, b) => cmpCode(a.code, b.code));
}
function descendantsOf(chart: any[], id: string): Set<string> {
  const out = new Set<string>(); const walk = (x: string, d: number) => { if (out.has(x) || d > 20) return; out.add(x); for (const a of chart) if (a.parentId === x) walk(a.id, d + 1); }; walk(id, 0); return out;
}
// The postable accounts an Accounts row stands for: includes united, excludes removed.
export function accountSetOf(chart: any[], selectors: Selector[]): string[] {
  const pick = (s: Selector): Set<string> => {
    const out = new Set<string>();
    if (s.selectorType === 'Account' || s.selectorType === 'ParentRollup') { if (s.accountId) descendantsOf(chart, s.accountId).forEach(i => out.add(i)); }
    else if (s.selectorType === 'Range') { for (const a of chart) if (cmpCode(a.code, s.rangeStart || '') >= 0 && cmpCode(a.code, s.rangeEnd || '') <= 0) out.add(a.id); }
    else if (s.selectorType === 'Type') { for (const a of chart) if (a.type === s.accountType) out.add(a.id); }
    else if (s.selectorType === 'Role') { for (const a of chart) if (a.systemKey && a.systemKey === s.systemKey) out.add(a.id); }
    else if (s.selectorType === 'Cash') { for (const a of chart) if (a.systemKey === 'BANK' || a.bankId) out.add(a.id); }
    return out;
  };
  const inc = new Set<string>(); const exc = new Set<string>();
  for (const s of selectors) { const set = pick(s); set.forEach(i => (s.mode === 'Exclude' ? exc : inc).add(i)); }
  const byId = new Map<string, any>(chart.map(a => [a.id, a]));
  return [...inc].filter(i => !exc.has(i) && byId.get(i) && !byId.get(i).isGroup);
}

// ---------------- design validation ----------------
export async function validateDesign(tx: any, companyId: string, reportType: ReportType, design: { rows: any[]; columns: any[] }): Promise<{ rows: EngineRow[]; columns: EngineColumn[] }> {
  if (!Array.isArray(design.rows) || !Array.isArray(design.columns)) throw fail(400, 'A design needs rows and columns.');
  if (design.rows.length === 0) throw fail(400, 'Add at least one row.');
  if (design.rows.length > 400) throw fail(400, 'A report can have at most 400 rows.');
  if (design.columns.length === 0) throw fail(400, 'Add at least one column.');
  if (design.columns.length > 12) throw fail(400, 'A report can have at most 12 columns.');
  const chart = await loadChart(tx, companyId);
  const byId = new Map<string, any>(chart.map(a => [a.id, a]));
  const sysKeys = new Set<string>((await tx.select({ key: schema.systemAccounts.key }).from(schema.systemAccounts)).map((r: any) => r.key));
  const rows: EngineRow[] = []; const seenRows = new Set<number>(); const earlier = new Set<number>();
  const covered = new Map<string, number>(); // account -> rowNumber of the Accounts row that has it
  const ROW_TYPES = ['Heading', 'Accounts', 'Subtotal', 'Calculated', 'ProfitToDate', 'Text', 'Spacer'];
  const DISPLAYS = ['Net', 'Debit', 'Credit', 'DebitBalances', 'CreditBalances', 'Split'];
  for (let i = 0; i < design.rows.length; i++) {
    const r = design.rows[i] || {};
    const where = `Row ${i + 1}`;
    const rowNumber = Number(r.rowNumber);
    if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > 99999) throw fail(400, `${where}: the row number must be a whole number from 1.`);
    if (seenRows.has(rowNumber)) throw fail(400, `${where}: row number ${rowNumber} is used twice.`);
    seenRows.add(rowNumber);
    if (!ROW_TYPES.includes(r.rowType)) throw fail(400, `${where}: unknown row type.`);
    const display = r.balanceDisplay || 'Net';
    if (!DISPLAYS.includes(display)) throw fail(400, `${where}: unknown balance display.`);
    const fmt = normalizeFormat(r.format); if (fmt.error) throw fail(400, `${where}: ${fmt.error}`);
    const label = String(r.label ?? '').trim().slice(0, 160) || null;
    if (['Heading', 'Accounts', 'Subtotal', 'Calculated', 'ProfitToDate', 'Text'].includes(r.rowType) && !label) throw fail(400, `${where}: a label is required.`);
    const selectors: Selector[] = [];
    if (r.rowType === 'Accounts') {
      if (!Array.isArray(r.selectors) || !r.selectors.some((s: any) => (s.mode || 'Include') === 'Include')) throw fail(400, `${where}: choose the accounts of this row.`);
      if (r.selectors.length > 60) throw fail(400, `${where}: too many selectors.`);
      for (const s of r.selectors) {
        const mode = s.mode === 'Exclude' ? 'Exclude' : 'Include';
        const t = s.selectorType;
        if (t === 'Account' || t === 'ParentRollup') { if (!s.accountId || !byId.get(String(s.accountId))) throw fail(400, `${where}: an account of a selector does not exist in this company.`); selectors.push({ mode, selectorType: t, accountId: String(s.accountId) }); }
        else if (t === 'Range') { const a = String(s.rangeStart || '').trim(), b = String(s.rangeEnd || '').trim(); if (!a || !b) throw fail(400, `${where}: a range needs both codes.`); if (cmpCode(a, b) > 0) throw fail(400, `${where}: the range starts after it ends.`); selectors.push({ mode, selectorType: t, rangeStart: a, rangeEnd: b }); }
        else if (t === 'Type') { if (!['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'].includes(s.accountType)) throw fail(400, `${where}: unknown account type.`); selectors.push({ mode, selectorType: t, accountType: s.accountType }); }
        else if (t === 'Role') { if (!sysKeys.has(String(s.systemKey))) throw fail(400, `${where}: unknown posting role.`); selectors.push({ mode, selectorType: t, systemKey: String(s.systemKey) }); }
        else if (t === 'Cash') selectors.push({ mode, selectorType: t });
        else throw fail(400, `${where}: unknown selector.`);
      }
      const set = accountSetOf(chart, selectors);
      // an account is counted once per balance point: a row pinned to the opening balance may repeat an account that a movement row also has
      for (const id of set) { const key = `${id}|${r.valueBasis || ''}`; const prev = covered.get(key); if (prev !== undefined) throw fail(400, `${where}: account ${byId.get(id).code} is already counted in row ${prev}. An account can be in only one Accounts row.`); covered.set(key, rowNumber); }
    }
    if (r.valueBasis != null && !['OpeningBalance', 'ClosingBalance'].includes(r.valueBasis)) throw fail(400, `${where}: unknown balance point.`);
    let calc: { rowNumber: number; sign: number }[] | null = null;
    if (r.rowType === 'Calculated') {
      if (!Array.isArray(r.calcFormula) || r.calcFormula.length === 0) throw fail(400, `${where}: a formula row needs at least one referenced row.`);
      calc = r.calcFormula.map((p: any) => ({ rowNumber: Number(p.rowNumber), sign: Number(p.sign) === -1 ? -1 : 1 }));
      for (const p of calc) if (!earlier.has(p.rowNumber)) throw fail(400, `${where}: the formula uses row ${p.rowNumber}, which is not an earlier row.`);
    }
    let dimFilter: Record<string, string[]> | null = null;
    if (r.dimensionFilter && typeof r.dimensionFilter === 'object' && Object.keys(r.dimensionFilter).length) { await parseDimFilters(tx, companyId, r.dimensionFilter); dimFilter = r.dimensionFilter; }
    rows.push({ rowNumber, rowType: r.rowType, label, labelAr: String(r.labelAr ?? '').trim().slice(0, 160) || null, balanceDisplay: display, flipSign: r.flipSign === true, valueBasis: r.valueBasis || null, calcFormula: calc, role: String(r.role ?? '').trim().slice(0, 40) || null, dimensionFilter: dimFilter, format: fmt.format, selectors });
    earlier.add(rowNumber);
  }
  const columns: EngineColumn[] = []; const seenCols = new Set<number>();
  const PERIODS = ['CurrentPeriod', 'YearToDate', 'PriorPeriod', 'PriorYear', 'AsAtEnd', 'AsAtPriorYearEnd', 'AsAtPriorPeriodEnd', 'CustomRange'];
  const BASES = ['Debit', 'Credit', 'Movement', 'OpeningBalance', 'ClosingBalance'];
  for (let i = 0; i < design.columns.length; i++) {
    const c = design.columns[i] || {};
    const where = `Column ${i + 1}`;
    const n = Number(c.columnNumber);
    if (!Number.isInteger(n) || n < 1) throw fail(400, `${where}: the column number must be a whole number from 1.`);
    if (seenCols.has(n)) throw fail(400, `${where}: column number ${n} is used twice.`);
    const kind = c.columnKind || 'Value';
    if (!['Value', 'Variance', 'Percent'].includes(kind)) throw fail(400, `${where}: unknown column kind.`);
    const label = String(c.label ?? '').trim().slice(0, 80); if (!label) throw fail(400, `${where}: a heading is required.`);
    const fmt = normalizeFormat(c.format); if (fmt.error) throw fail(400, `${where}: ${fmt.error}`);
    const col: EngineColumn = { columnNumber: n, label, labelAr: String(c.labelAr ?? '').trim().slice(0, 80) || null, columnKind: kind, periodBasis: c.periodBasis || 'CurrentPeriod', customFrom: null, customTo: null, valueBasis: c.valueBasis || 'Movement', presentation: c.presentation === 'DrCr' ? 'DrCr' : 'Single', dimensionFilter: null, refColumnA: null, refColumnB: null, format: fmt.format };
    if (kind === 'Value') {
      if (!PERIODS.includes(col.periodBasis)) throw fail(400, `${where}: unknown period.`);
      if (!BASES.includes(col.valueBasis)) throw fail(400, `${where}: unknown value basis.`);
      if (col.periodBasis === 'CustomRange') { if (!DATE_RE.test(String(c.customFrom)) || !DATE_RE.test(String(c.customTo)) || c.customFrom > c.customTo) throw fail(400, `${where}: enter a valid custom date range.`); col.customFrom = c.customFrom; col.customTo = c.customTo; }
      if (c.dimensionFilter && typeof c.dimensionFilter === 'object' && Object.keys(c.dimensionFilter).length) { await parseDimFilters(tx, companyId, c.dimensionFilter); col.dimensionFilter = c.dimensionFilter; }
    } else {
      col.refColumnA = Number(c.refColumnA); col.refColumnB = Number(c.refColumnB);
      const a = columns.find(x => x.columnNumber === col.refColumnA), b = columns.find(x => x.columnNumber === col.refColumnB);
      if (!a || !b || a.columnKind !== 'Value' || b.columnKind !== 'Value') throw fail(400, `${where}: a variance or percent column compares two earlier value columns.`);
      if (a.presentation !== 'Single' || b.presentation !== 'Single') throw fail(400, `${where}: only single-figure columns can be compared.`);
      col.presentation = 'Single';
    }
    seenCols.add(n); columns.push(col);
  }
  if (!columns.some(c => c.columnKind === 'Value')) throw fail(400, 'At least one column must show values.');
  const drCols = columns.filter(c => c.presentation === 'DrCr' && c.columnKind === 'Value').length;
  if (drCols && columns.some(c => c.columnKind === 'Value' && c.presentation === 'Single') && reportType === 'TrialBalance') throw fail(400, 'A Trial Balance uses debit / credit columns throughout.');
  return { rows, columns };
}

// ---------------- running a definition ----------------
export interface RunParams { from: string; to: string; mode: 'Summary' | 'Detailed'; dims?: DimFilter[]; branchIds?: string[] | null }
interface Window { from: string; to: string }
interface Buckets { openDr: number; openCr: number; movDr: number; movCr: number }
export interface Cell { v: number | null; dr?: number; cr?: number; drill?: { accountIds: string[]; from: string; to: string; basis: string } }

function windowOf(c: EngineColumn, p: RunParams): Window {
  switch (c.periodBasis) {
    case 'CurrentPeriod': return { from: p.from, to: p.to };
    case 'AsAtEnd': return { from: `${p.to.slice(0, 4)}-01-01`, to: p.to };
    case 'YearToDate': return { from: `${p.to.slice(0, 4)}-01-01`, to: p.to };
    case 'PriorPeriod': { const days = daysBetween(p.from, p.to); const to = addDays(p.from, -1); return { from: addDays(to, -(days - 1)), to }; }
    case 'PriorYear': return { from: shiftYear(p.from, -1), to: shiftYear(p.to, -1) };
    case 'AsAtPriorYearEnd': { const to = shiftYear(p.to, -1); return { from: `${to.slice(0, 4)}-01-01`, to }; }
    case 'AsAtPriorPeriodEnd': { const to = addDays(p.from, -1); return { from: `${to.slice(0, 4)}-01-01`, to }; }
    case 'CustomRange': return { from: c.customFrom as string, to: c.customTo as string };
  }
}

async function fetchBuckets(tx: any, companyId: string, w: Window, dims: DimFilter[], branchIds: string[] | null | undefined): Promise<{ byAccount: Map<string, Buckets>; unmappedLines: number }> {
  const res: any = await tx.execute(sql`
    SELECT rl.account_id AS "accountId",
      COALESCE(SUM(CASE WHEN rl.date < ${w.from} THEN rl.debit END),0)::float8 AS "openDr", COALESCE(SUM(CASE WHEN rl.date < ${w.from} THEN rl.credit END),0)::float8 AS "openCr",
      COALESCE(SUM(CASE WHEN rl.date >= ${w.from} THEN rl.debit END),0)::float8 AS "movDr", COALESCE(SUM(CASE WHEN rl.date >= ${w.from} THEN rl.credit END),0)::float8 AS "movCr",
      COUNT(*)::int AS lines
    FROM ${resolvedLines(companyId, { to: w.to, branchIds, dims })} GROUP BY rl.account_id`);
  const byAccount = new Map<string, Buckets>(); let unmapped = 0;
  for (const r of res.rows) { if (!r.accountId) { unmapped += Number(r.lines); continue; } byAccount.set(r.accountId, { openDr: Number(r.openDr), openCr: Number(r.openCr), movDr: Number(r.movDr), movCr: Number(r.movCr) }); }
  return { byAccount, unmappedLines: unmapped };
}

// The debit and credit amounts of one account for a column's value basis.
function quantity(b: Buckets | undefined, basis: EngineColumn['valueBasis']): { dr: number; cr: number } {
  const x = b || { openDr: 0, openCr: 0, movDr: 0, movCr: 0 };
  switch (basis) {
    case 'Debit': return { dr: x.movDr, cr: 0 };
    case 'Credit': return { dr: 0, cr: x.movCr };
    case 'Movement': return { dr: x.movDr, cr: x.movCr };
    case 'OpeningBalance': return { dr: x.openDr, cr: x.openCr };
    case 'ClosingBalance': return { dr: x.openDr + x.movDr, cr: x.openCr + x.movCr };
  }
}

// The figure of a set of accounts under a row's balance display and a column's presentation.
function figure(accountIds: string[], data: Map<string, Buckets>, row: Pick<EngineRow, 'balanceDisplay' | 'flipSign'>, col: EngineColumn): { v: number; dr: number; cr: number } {
  let sumDr = 0, sumCr = 0, posNet = 0, negNet = 0;
  for (const id of accountIds) {
    const q = quantity(data.get(id), col.valueBasis);
    sumDr += q.dr; sumCr += q.cr;
    const net = q.dr - q.cr; if (net > 0) posNet += net; else negNet += -net;
  }
  const net = sumDr - sumCr;
  const grossBasis = col.valueBasis === 'Movement' || col.valueBasis === 'Debit' || col.valueBasis === 'Credit';
  if (col.presentation === 'DrCr') {
    let dr: number, cr: number;
    if (col.valueBasis === 'Debit') { dr = sumDr; cr = 0; }
    else if (col.valueBasis === 'Credit') { dr = 0; cr = sumCr; }
    else if (col.valueBasis === 'Movement') { dr = sumDr; cr = sumCr; }
    else if (row.balanceDisplay === 'Split') { dr = posNet; cr = negNet; }
    else if (row.balanceDisplay === 'DebitBalances') { dr = posNet; cr = 0; }
    else if (row.balanceDisplay === 'CreditBalances') { dr = 0; cr = negNet; }
    else if (row.balanceDisplay === 'Debit') { dr = sumDr; cr = 0; }
    else if (row.balanceDisplay === 'Credit') { dr = 0; cr = sumCr; }
    else { dr = Math.max(net, 0); cr = Math.max(-net, 0); }
    return { v: round2(dr - cr), dr: round2(dr), cr: round2(cr) };
  }
  let v: number;
  if (col.valueBasis === 'Debit') v = sumDr; else if (col.valueBasis === 'Credit') v = sumCr;
  else if (row.balanceDisplay === 'Debit') v = sumDr; else if (row.balanceDisplay === 'Credit') v = sumCr;
  else if (row.balanceDisplay === 'DebitBalances') v = posNet; else if (row.balanceDisplay === 'CreditBalances') v = negNet;
  else v = net;
  void grossBasis;
  if (row.flipSign) v = -v;
  return { v: round2(v), dr: 0, cr: 0 };
}

const nonzero = (c: Cell | undefined) => !!c && (Math.abs(c.v || 0) > 0.004 || Math.abs(c.dr || 0) > 0.004 || Math.abs(c.cr || 0) > 0.004);
const addCells = (a: Cell, b: Cell, sign = 1): Cell => ({ v: round2((a.v || 0) + sign * (b.v || 0)), dr: round2((a.dr || 0) + sign * (b.dr || 0)), cr: round2((a.cr || 0) + sign * (b.cr || 0)) });

export async function runDefinition(tx: any, companyId: string, def: EngineDefinition, p: RunParams): Promise<any> {
  if (!DATE_RE.test(p.from) || !DATE_RE.test(p.to) || p.from > p.to) throw fail(400, 'Enter a valid period.');
  const chart = await loadChart(tx, companyId);
  const byId = new Map<string, any>(chart.map(a => [a.id, a]));
  const valueCols = def.columns.filter(c => c.columnKind === 'Value');
  const runDims = p.dims || [];

  // data per (window, filters), fetched once
  const dataCache = new Map<string, Promise<{ byAccount: Map<string, Buckets>; unmappedLines: number }>>();
  const filterDims = async (raw: Record<string, string[]> | null) => (raw && Object.keys(raw).length ? await parseDimFilters(tx, companyId, raw) : []);
  const dataFor = async (w: Window, colFilter: Record<string, string[]> | null, rowFilter: Record<string, string[]> | null) => {
    const key = JSON.stringify([w, colFilter, rowFilter]);
    if (!dataCache.has(key)) dataCache.set(key, (async () => fetchBuckets(tx, companyId, w, [...runDims, ...(await filterDims(colFilter)), ...(await filterDims(rowFilter))], p.branchIds))());
    return dataCache.get(key)!;
  };

  const windows = new Map<number, Window>(valueCols.map(c => [c.columnNumber, windowOf(c, p)]));
  const rowSets = new Map<number, string[]>();
  for (const r of def.rows) if (r.rowType === 'Accounts') rowSets.set(r.rowNumber, accountSetOf(chart, r.selectors));
  const plAccounts = chart.filter(a => !a.isGroup && (a.type === 'Revenue' || a.type === 'Expense')).map(a => a.id);

  type Out = { row: EngineRow; cells: Cell[]; detail?: any[] };
  const results: Out[] = [];
  const valueByRow = new Map<number, Cell[]>(); // by rowNumber, per value column index
  let sinceSubtotal: number[] = [];
  let unmappedLines = 0;

  for (const r of def.rows) {
    const cells: Cell[] = [];
    if (r.rowType === 'Accounts' || r.rowType === 'ProfitToDate') {
      const ids = r.rowType === 'Accounts' ? rowSets.get(r.rowNumber) || [] : plAccounts;
      for (const col of valueCols) {
        const c: EngineColumn = r.valueBasis ? { ...col, valueBasis: r.valueBasis } : col; // a row can pin itself to the balance at the start or end of the period
        const w = windows.get(c.columnNumber)!;
        const d = await dataFor(w, c.dimensionFilter, r.dimensionFilter);
        unmappedLines = Math.max(unmappedLines, d.unmappedLines);
        let cell: Cell;
        if (r.rowType === 'ProfitToDate') {
          // profit = credits less debits of Revenue and Expense accounts; shown positive for a profit
          const f = figure(ids, d.byAccount, { balanceDisplay: 'Net', flipSign: true }, { ...c, presentation: 'Single' });
          cell = c.presentation === 'DrCr' ? { v: f.v, dr: f.v < 0 ? -f.v : 0, cr: f.v > 0 ? f.v : 0 } : { v: r.flipSign ? -f.v : f.v };
        } else {
          const f = figure(ids, d.byAccount, r, c);
          cell = c.presentation === 'DrCr' ? { v: f.v, dr: f.dr, cr: f.cr } : { v: f.v };
        }
        cell.drill = { accountIds: ids, from: w.from, to: w.to, basis: c.valueBasis };
        cells.push(cell);
      }
      sinceSubtotal.push(r.rowNumber);
    } else if (r.rowType === 'Subtotal') {
      for (let i = 0; i < valueCols.length; i++) {
        let acc: Cell = { v: 0, dr: 0, cr: 0 };
        for (const n of sinceSubtotal) acc = addCells(acc, (valueByRow.get(n) || [])[i] || { v: 0 });
        cells.push({ ...acc, drill: undefined });
      }
      // the accounts behind a subtotal are the accounts of the rows it adds up
      const ids = sinceSubtotal.flatMap(n => rowSets.get(n) || []);
      cells.forEach((cell, i) => { const w = windows.get(valueCols[i].columnNumber)!; cell.drill = { accountIds: ids, from: w.from, to: w.to, basis: valueCols[i].valueBasis }; });
      sinceSubtotal = [];
    } else if (r.rowType === 'Calculated') {
      for (let i = 0; i < valueCols.length; i++) {
        let acc: Cell = { v: 0, dr: 0, cr: 0 };
        for (const part of r.calcFormula || []) acc = addCells(acc, (valueByRow.get(part.rowNumber) || [])[i] || { v: 0 }, part.sign);
        cells.push(acc);
      }
    }
    if (cells.length) valueByRow.set(r.rowNumber, cells);
    results.push({ row: r, cells });
  }

  // Detailed mode: an Accounts row lists its accounts (and the sub-headings between) with their own figures.
  if (p.mode === 'Detailed') {
    for (const out of results) {
      const r = out.row;
      if (r.rowType !== 'Accounts') continue;
      const ids = new Set(rowSets.get(r.rowNumber) || []);
      const roots = r.selectors.filter(s => s.mode === 'Include' && (s.selectorType === 'ParentRollup' || s.selectorType === 'Account') && s.accountId).map(s => s.accountId as string);
      const rollupRoots = new Set<string>(); for (const id of roots) descendantsOf(chart, id).forEach(x => rollupRoots.add(x));
      const nodeIds = new Set<string>(ids);
      for (const id of ids) { let cur = byId.get(id); while (cur?.parentId && rollupRoots.has(cur.parentId)) { nodeIds.add(cur.parentId); cur = byId.get(cur.parentId); } }
      const depthOf = (a: any) => { let d = 0; let cur = a; while (cur.parentId && nodeIds.has(cur.parentId)) { d++; cur = byId.get(cur.parentId); } return d; };
      const detail: any[] = [];
      for (const a of chart.filter(x => nodeIds.has(x.id))) {
        const under = [...descendantsOf(chart, a.id)].filter(x => ids.has(x));
        const dcells: Cell[] = [];
        for (const col of valueCols) {
          const c: EngineColumn = r.valueBasis ? { ...col, valueBasis: r.valueBasis } : col;
          const w = windows.get(c.columnNumber)!;
          const d = await dataFor(w, c.dimensionFilter, r.dimensionFilter);
          const f = figure(under, d.byAccount, r, c);
          dcells.push({ ...(c.presentation === 'DrCr' ? { v: f.v, dr: f.dr, cr: f.cr } : { v: f.v }), drill: { accountIds: under, from: w.from, to: w.to, basis: c.valueBasis } });
        }
        detail.push({ accountId: a.id, code: a.code, name: a.name, nameAr: a.nameAr, isGroup: a.isGroup, depth: depthOf(a), cells: dcells });
      }
      out.detail = detail;
    }
  }

  // Variance and percent columns, from the value columns they compare
  const colIndexOf = (n: number | null) => valueCols.findIndex(c => c.columnNumber === n);
  const finalCells = new Map<EngineRow, Cell[]>(); // cells in def.columns order
  for (const out of results) {
    const arr: Cell[] = [];
    let vi = 0;
    for (const c of def.columns) {
      if (c.columnKind === 'Value') { arr.push(out.cells[vi++] || { v: null }); continue; }
      if (!out.cells.length) { arr.push({ v: null }); continue; }
      const a = out.cells[colIndexOf(c.refColumnA)], b = out.cells[colIndexOf(c.refColumnB)];
      if (!a || !b) { arr.push({ v: null }); continue; }
      if (c.columnKind === 'Variance') arr.push({ v: round2((a.v || 0) - (b.v || 0)) });
      else arr.push({ v: Math.abs(b.v || 0) < 0.005 ? null : round2(((a.v || 0) - (b.v || 0)) / Math.abs(b.v || 0) * 100) });
    }
    finalCells.set(out.row, arr);
  }

  // Accounts with figures that no Accounts row covers
  const covered = new Set<string>(); for (const ids of rowSets.values()) ids.forEach(i => covered.add(i));
  const hasProfitRow = def.rows.some(r => r.rowType === 'ProfitToDate');
  const scope = def.reportType === 'PnL' ? ['Revenue', 'Expense'] : def.reportType === 'BalanceSheet' ? ['Asset', 'Liability', 'Equity'].concat(hasProfitRow ? [] : ['Revenue', 'Expense']) : def.reportType === 'TrialBalance' ? ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'] : [];
  const notIn: any[] = [];
  const uncovered = chart.filter(a => !a.isGroup && scope.includes(a.type) && !covered.has(a.id));
  const notInTotals: Cell[] = valueCols.map(() => ({ v: 0, dr: 0, cr: 0 }));
  for (const a of uncovered) {
    const cells: Cell[] = []; let any = false;
    for (let i = 0; i < valueCols.length; i++) {
      const c = valueCols[i]; const w = windows.get(c.columnNumber)!;
      const d = await dataFor(w, c.dimensionFilter, null);
      const f = figure([a.id], d.byAccount, { balanceDisplay: 'Split', flipSign: false }, c);
      const cell: Cell = c.presentation === 'DrCr' ? { v: f.v, dr: f.dr, cr: f.cr } : { v: f.v };
      cell.drill = { accountIds: [a.id], from: w.from, to: w.to, basis: c.valueBasis };
      if (nonzero(cell)) any = true;
      cells.push(cell); notInTotals[i] = addCells(notInTotals[i], cell);
    }
    if (any) notIn.push({ accountId: a.id, code: a.code, name: a.name, nameAr: a.nameAr, cells });
  }

  // Integrity checks
  const checks: any = {};
  const colTotals = valueCols.map((c, i) => {
    let dr = 0, cr = 0;
    for (const out of results) if (out.row.rowType === 'Accounts' || out.row.rowType === 'ProfitToDate') { const cell = out.cells[i]; dr += cell.dr || 0; cr += cell.cr || 0; }
    return { columnNumber: c.columnNumber, dr: round2(dr + (notInTotals[i].dr || 0)), cr: round2(cr + (notInTotals[i].cr || 0)) };
  });
  if (def.reportType === 'TrialBalance') {
    checks.totals = colTotals.filter((_, i) => valueCols[i].presentation === 'DrCr');
    checks.balanced = checks.totals.length > 0 && checks.totals.every((t: any) => Math.abs(t.dr - t.cr) < 0.011);
  }
  if (def.reportType === 'BalanceSheet') {
    const roleVal = (role: string) => { const out = results.find(o => o.row.role === role); return out ? (out.cells[0]?.v ?? 0) : null; };
    const ta = roleVal('total_assets'), tl = roleVal('total_liabilities'), te = roleVal('total_equity');
    if (ta !== null && tl !== null && te !== null) { checks.difference = round2(ta - tl - te); checks.balanced = Math.abs(checks.difference) < 0.011; }
  }
  // The statements below are checked against the ledger itself (not against their own rows), so a definition that misses something shows a difference.
  const roleOut = (role: string) => results.find(o => o.row.role === role);
  if (def.reportType === 'CashFlow' && roleOut('net_change_in_cash') && valueCols.length) {
    // the net change in cash must equal what the bank and cash accounts actually moved by
    const c0 = valueCols[0]; const d = await dataFor(windows.get(c0.columnNumber)!, c0.dimensionFilter, null);
    let actual = 0; for (const id of accountSetOf(chart, [{ mode: 'Include', selectorType: 'Cash' }])) { const b = d.byAccount.get(id); if (b) actual += b.movDr - b.movCr; }
    checks.difference = round2((roleOut('net_change_in_cash')!.cells[0]?.v ?? 0) - actual); checks.balanced = Math.abs(checks.difference) < 0.011;
  }
  if (def.reportType === 'ChangesInEquity' && roleOut('closing_equity') && valueCols.length) {
    // closing equity must equal the equity of the balance sheet at the end of the period (equity accounts plus profit to date)
    const c0 = valueCols[0]; const d = await dataFor(windows.get(c0.columnNumber)!, c0.dimensionFilter, null);
    let eq = 0; for (const a of chart) { if (a.isGroup || !['Equity', 'Revenue', 'Expense'].includes(a.type)) continue; const b = d.byAccount.get(a.id); if (b) eq += (b.openCr + b.movCr) - (b.openDr + b.movDr); }
    checks.difference = round2((roleOut('closing_equity')!.cells[0]?.v ?? 0) - eq); checks.balanced = Math.abs(checks.difference) < 0.011;
  }
  checks.uncovered = notIn.length;

  const outRows = results.filter(o => o.row.format.show !== 'hidden' && !(o.row.format.show === 'nonzero' && o.cells.length && !o.cells.some(nonzero))).map(o => ({
    rowNumber: o.row.rowNumber, rowType: o.row.rowType, label: o.row.label, labelAr: o.row.labelAr, role: o.row.role, format: o.row.format, cells: finalCells.get(o.row) || [], detail: o.detail,
  }));
  return {
    definition: { id: def.id, name: def.name, nameAr: def.nameAr || null, reportType: def.reportType },
    params: { from: p.from, to: p.to, mode: p.mode },
    columns: def.columns.map(c => ({ columnNumber: c.columnNumber, label: c.label, labelAr: c.labelAr, kind: c.columnKind, presentation: c.presentation, valueBasis: c.valueBasis, window: windows.get(c.columnNumber) || null, format: c.format })),
    rows: outRows, notInDefinition: notIn, checks, unmappedLines,
  };
}

export async function createDefinition(tx: any, companyId: string, userId: string | null, v: { name: string; nameAr?: string | null; reportType: ReportType; isSystemSeeded?: boolean; isDefault?: boolean; defaultDisplayMode?: 'Summary' | 'Detailed' }): Promise<string> {
  const id = generateId();
  await tx.insert(schema.reportDefinitions).values({ id, companyId, name: v.name, nameAr: v.nameAr || null, reportType: v.reportType, isSystemSeeded: v.isSystemSeeded === true, isDefault: v.isDefault === true, defaultDisplayMode: v.defaultDisplayMode || 'Summary', isActive: true, createdById: userId, createdAt: nowDate(), updatedAt: nowDate() });
  return id;
}
