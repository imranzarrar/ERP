// The standard report definitions every company starts with (Finance Core Blueprint: "Trial Balance and P&L ship as pre-built, editable Report
// Definitions"): Trial Balance, Income Statement and Balance Sheet, generated from the company's own chart so they follow its structure. Editable and
// cloneable afterwards; "reset to standard" regenerates one from the chart.
import { and, eq } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { createDefinition, saveDesign, type EngineColumn, type EngineRow, type ReportType } from './reportEngine.js';

type Acct = any;
interface Design { rows: EngineRow[]; columns: EngineColumn[] }

const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

class Builder {
  rows: EngineRow[] = [];
  private n = 0;
  private next() { this.n += 10; return this.n; }
  add(r: Partial<EngineRow> & { rowType: EngineRow['rowType'] }): number {
    const rowNumber = this.next();
    this.rows.push({ rowNumber, label: null, labelAr: null, balanceDisplay: 'Net', flipSign: false, valueBasis: null, calcFormula: null, role: null, dimensionFilter: null, format: {}, selectors: [], ...r });
    return rowNumber;
  }
  heading(label: string, labelAr: string) { return this.add({ rowType: 'Heading', label, labelAr, format: { bold: true } }); }
  spacer() { return this.add({ rowType: 'Spacer' }); }
  accounts(a: Acct, flip: boolean) {
    return this.add({ rowType: 'Accounts', label: a.name, labelAr: a.nameAr, flipSign: flip, format: { indent: 1 }, selectors: [{ mode: 'Include', selectorType: a.isGroup ? 'ParentRollup' : 'Account', accountId: a.id }] });
  }
  typeRow(label: string, labelAr: string, accountType: string, flip: boolean) {
    return this.add({ rowType: 'Accounts', label, labelAr, flipSign: flip, format: { indent: 1 }, selectors: [{ mode: 'Include', selectorType: 'Type', accountType }] });
  }
  subtotal(label: string, labelAr: string, role: string | null, extra: EngineRow['format'] = {}) {
    return this.add({ rowType: 'Subtotal', label, labelAr, role, format: { bold: true, borderTop: 'single', ...extra } });
  }
  calc(label: string, labelAr: string, parts: { rowNumber: number; sign: number }[], role: string | null, extra: EngineRow['format'] = {}) {
    return this.add({ rowType: 'Calculated', label, labelAr, role, calcFormula: parts, format: { bold: true, shade: true, ...extra } });
  }
}

const col = (n: number, label: string, labelAr: string, v: Partial<EngineColumn>): EngineColumn => ({
  columnNumber: n, label, labelAr, columnKind: 'Value', periodBasis: 'CurrentPeriod', customFrom: null, customTo: null, valueBasis: 'Movement', presentation: 'Single',
  dimensionFilter: null, refColumnA: null, refColumnB: null, format: {}, ...v,
});

// Roots of the chart (headings with no parent) of a type, and the postable accounts that sit at the top level on their own.
function rootsOf(chart: Acct[], type: string) { return chart.filter(a => a.type === type && !a.parentId && a.isActive).sort((a, b) => cmp(a.code, b.code)); }
function childrenOf(chart: Acct[], root: Acct) { return chart.filter(a => a.parentId === root.id && a.isActive).sort((a, b) => cmp(a.code, b.code)); }
function sectionRows(b: Builder, chart: Acct[], roots: Acct[], flip: boolean, fallbackLabel: string, fallbackAr: string, type: string) {
  let any = false;
  for (const root of roots) {
    const kids = root.isGroup ? childrenOf(chart, root) : [];
    if (!root.isGroup) { b.accounts(root, flip); any = true; continue; }
    if (kids.length === 0) continue;
    for (const k of kids) { b.accounts(k, flip); any = true; }
  }
  if (!any) b.typeRow(fallbackLabel, fallbackAr, type, flip);
}

export function standardTrialBalance(chart: Acct[]): Design {
  const b = new Builder();
  const roots = chart.filter(a => !a.parentId && a.isActive).sort((a, c) => cmp(a.code, c.code));
  for (const r of roots) {
    if (r.isGroup) { b.add({ rowType: 'Accounts', label: r.name, labelAr: r.nameAr, format: { bold: true }, selectors: [{ mode: 'Include', selectorType: 'ParentRollup', accountId: r.id }] }); }
    else b.add({ rowType: 'Accounts', label: r.name, labelAr: r.nameAr, selectors: [{ mode: 'Include', selectorType: 'Account', accountId: r.id }] });
  }
  b.subtotal('Total', 'الإجمالي', 'tb_total', { borderTop: 'double' });
  return { rows: b.rows, columns: [
    col(1, 'Opening', 'الافتتاحي', { valueBasis: 'OpeningBalance', presentation: 'DrCr' }),
    col(2, 'Movement', 'الحركة', { valueBasis: 'Movement', presentation: 'DrCr' }),
    col(3, 'Closing', 'الإقفال', { valueBasis: 'ClosingBalance', presentation: 'DrCr' }),
  ] };
}

export function standardIncomeStatement(chart: Acct[]): Design {
  const b = new Builder();
  const cogs = chart.find(a => a.systemKey === 'COGS');
  const costRoot = cogs ? (cogs.parentId ? chart.find(a => a.id === cogs.parentId) : cogs) : undefined;
  const revRoots = rootsOf(chart, 'Revenue');
  const expRoots = rootsOf(chart, 'Expense');
  const costRoots = costRoot ? expRoots.filter(r => r.id === (costRoot.parentId ? costRoot.parentId : costRoot.id) || r.id === costRoot.id) : [];
  const otherRoots = expRoots.filter(r => !costRoots.includes(r));
  b.heading('Revenue', 'الإيرادات');
  sectionRows(b, chart, revRoots, true, 'Revenue', 'الإيرادات', 'Revenue');
  const totalRev = b.subtotal('Total revenue', 'إجمالي الإيرادات', 'total_revenue');
  b.spacer();
  b.heading('Cost of sales', 'تكلفة المبيعات');
  if (costRoots.length) sectionRows(b, chart, costRoots, false, 'Cost of sales', 'تكلفة المبيعات', 'Expense'); else b.add({ rowType: 'Accounts', label: 'Cost of sales', labelAr: 'تكلفة المبيعات', format: { indent: 1 }, selectors: cogs ? [{ mode: 'Include', selectorType: 'Role', systemKey: 'COGS' }] : [] });
  const totalCost = b.subtotal('Total cost of sales', 'إجمالي تكلفة المبيعات', 'total_cost_of_sales');
  const gross = b.calc('Gross profit', 'مجمل الربح', [{ rowNumber: totalRev, sign: 1 }, { rowNumber: totalCost, sign: -1 }], 'gross_profit');
  b.spacer();
  b.heading('Operating expenses', 'المصروفات التشغيلية');
  if (otherRoots.length) sectionRows(b, chart, otherRoots, false, 'Expenses', 'المصروفات', 'Expense'); else b.typeRow('Expenses', 'المصروفات', 'Expense', false);
  const totalOpex = b.subtotal('Total operating expenses', 'إجمالي المصروفات التشغيلية', 'total_operating_expenses');
  b.calc('Net profit', 'صافي الربح', [{ rowNumber: gross, sign: 1 }, { rowNumber: totalOpex, sign: -1 }], 'net_profit', { underline: 'double' });
  // A cost-of-sales row defined by a role may select nothing on a custom chart; drop an empty Accounts row so the definition stays valid
  const rows = b.rows.filter(r => !(r.rowType === 'Accounts' && r.selectors.length === 0));
  return { rows, columns: [
    col(1, 'Current period', 'الفترة الحالية', { periodBasis: 'CurrentPeriod', valueBasis: 'Movement' }),
    col(2, 'Previous period', 'الفترة السابقة', { periodBasis: 'PriorPeriod', valueBasis: 'Movement' }),
    col(3, 'Change', 'التغيير', { columnKind: 'Variance', refColumnA: 1, refColumnB: 2 }),
    col(4, 'Change %', 'نسبة التغيير', { columnKind: 'Percent', refColumnA: 1, refColumnB: 2 }),
  ] };
}

export function standardBalanceSheet(chart: Acct[]): Design {
  const b = new Builder();
  b.heading('Assets', 'الأصول');
  sectionRows(b, chart, rootsOf(chart, 'Asset'), false, 'Assets', 'الأصول', 'Asset');
  const totalAssets = b.subtotal('Total assets', 'إجمالي الأصول', 'total_assets', { borderTop: 'double' });
  b.spacer();
  b.heading('Liabilities', 'الالتزامات');
  sectionRows(b, chart, rootsOf(chart, 'Liability'), true, 'Liabilities', 'الالتزامات', 'Liability');
  const totalLiab = b.subtotal('Total liabilities', 'إجمالي الالتزامات', 'total_liabilities');
  b.spacer();
  b.heading('Equity', 'حقوق الملكية');
  sectionRows(b, chart, rootsOf(chart, 'Equity'), true, 'Equity', 'حقوق الملكية', 'Equity');
  b.add({ rowType: 'ProfitToDate', label: 'Profit (loss) to date', labelAr: 'الربح (الخسارة) حتى تاريخه', format: { indent: 1, italic: true } });
  const totalEq = b.subtotal('Total equity', 'إجمالي حقوق الملكية', 'total_equity');
  b.calc('Total liabilities and equity', 'إجمالي الالتزامات وحقوق الملكية', [{ rowNumber: totalLiab, sign: 1 }, { rowNumber: totalEq, sign: 1 }], 'total_liabilities_equity', { underline: 'double' });
  void totalAssets;
  return { rows: b.rows, columns: [
    col(1, 'As at', 'كما في', { periodBasis: 'AsAtEnd', valueBasis: 'ClosingBalance' }),
    col(2, 'Prior year end', 'نهاية السنة السابقة', { periodBasis: 'AsAtPriorYearEnd', valueBasis: 'ClosingBalance' }),
    col(3, 'Change', 'التغيير', { columnKind: 'Variance', refColumnA: 1, refColumnB: 2 }),
  ] };
}

// Cash flow statement, indirect method, from the ledger: net profit, the non-cash and working-capital movements of the balance sheet, investing (fixed
// assets) and financing (equity), reconciled to the movement of every bank and cash account. Every balance sheet account is in exactly one block, so
// whatever the chart holds is explained; the engine checks the result against the cash accounts' real movement.
export function standardCashFlow(chart: Acct[]): Design {
  const b = new Builder();
  const accDep = chart.find(a => !a.isGroup && /accumulated depreciation/i.test(a.name));
  const sel = (mode: 'Include' | 'Exclude', selectorType: any, extra: any = {}) => ({ mode, selectorType, ...extra });
  b.heading('Operating activities', 'الأنشطة التشغيلية');
  b.add({ rowType: 'ProfitToDate', label: 'Net profit for the period', labelAr: 'صافي ربح الفترة', format: { indent: 1 } });
  if (accDep) b.add({ rowType: 'Accounts', label: 'Depreciation (non-cash)', labelAr: 'الإهلاك (غير نقدي)', flipSign: true, format: { indent: 1 }, selectors: [sel('Include', 'Account', { accountId: accDep.id })] });
  b.add({ rowType: 'Accounts', label: 'Change in receivables, inventory and other current assets', labelAr: 'التغير في الذمم المدينة والمخزون والأصول المتداولة الأخرى', flipSign: true, format: { indent: 1 },
    selectors: [sel('Include', 'Type', { accountType: 'Asset' }), sel('Exclude', 'Cash'), sel('Exclude', 'Role', { systemKey: 'FIXED_ASSETS' }), ...(accDep ? [sel('Exclude', 'Account', { accountId: accDep.id })] : [])] });
  b.add({ rowType: 'Accounts', label: 'Change in payables and other current liabilities', labelAr: 'التغير في الذمم الدائنة والالتزامات المتداولة الأخرى', flipSign: true, format: { indent: 1 }, selectors: [sel('Include', 'Type', { accountType: 'Liability' })] });
  const op = b.subtotal('Net cash from operating activities', 'صافي النقد من الأنشطة التشغيلية', 'cash_operating');
  b.spacer();
  b.heading('Investing activities', 'الأنشطة الاستثمارية');
  b.add({ rowType: 'Accounts', label: 'Purchase of fixed assets', labelAr: 'شراء أصول ثابتة', flipSign: true, format: { indent: 1 }, selectors: [sel('Include', 'Role', { systemKey: 'FIXED_ASSETS' })] });
  const inv = b.subtotal('Net cash used in investing activities', 'صافي النقد المستخدم في الأنشطة الاستثمارية', 'cash_investing');
  b.spacer();
  b.heading('Financing activities', 'الأنشطة التمويلية');
  b.add({ rowType: 'Accounts', label: 'Owner capital and current account', labelAr: 'رأس المال والحساب الجاري للمالك', flipSign: true, format: { indent: 1 }, selectors: [sel('Include', 'Type', { accountType: 'Equity' })] });
  const fin = b.subtotal('Net cash from financing activities', 'صافي النقد من الأنشطة التمويلية', 'cash_financing');
  b.spacer();
  const net = b.calc('Net change in cash', 'صافي التغير في النقد', [{ rowNumber: op, sign: 1 }, { rowNumber: inv, sign: 1 }, { rowNumber: fin, sign: 1 }], 'net_change_in_cash');
  const begin = b.add({ rowType: 'Accounts', label: 'Cash at the beginning of the period', labelAr: 'النقد في بداية الفترة', valueBasis: 'OpeningBalance', selectors: [sel('Include', 'Cash')] });
  b.calc('Cash at the end of the period', 'النقد في نهاية الفترة', [{ rowNumber: net, sign: 1 }, { rowNumber: begin, sign: 1 }], 'cash_at_end', { underline: 'double' });
  return { rows: b.rows, columns: [
    col(1, 'Current period', 'الفترة الحالية', { periodBasis: 'CurrentPeriod', valueBasis: 'Movement' }),
    col(2, 'Previous period', 'الفترة السابقة', { periodBasis: 'PriorPeriod', valueBasis: 'Movement' }),
  ] };
}

// Statement of changes in equity: equity at the start (each equity account and profit brought forward), what moved during the period (profit and every
// equity account's own movement), equity at the end. The engine checks the end figure against the balance sheet's equity.
export function standardChangesInEquity(chart: Acct[]): Design {
  const b = new Builder();
  const equity = chart.filter(a => a.type === 'Equity' && !a.isGroup && a.isActive).sort((x, y) => cmp(x.code, y.code));
  const one = (a: Acct, basis: 'OpeningBalance' | null) => b.add({ rowType: 'Accounts', label: a.name, labelAr: a.nameAr, flipSign: true, valueBasis: basis, format: basis ? { indent: 1 } : { indent: 1, show: 'nonzero' }, selectors: [{ mode: 'Include', selectorType: 'Account', accountId: a.id }] });
  b.heading('Opening position', 'الوضع الافتتاحي');
  for (const a of equity) one(a, 'OpeningBalance');
  b.add({ rowType: 'ProfitToDate', label: 'Profit (loss) brought forward', labelAr: 'الأرباح (الخسائر) المرحّلة', valueBasis: 'OpeningBalance', format: { indent: 1, italic: true } });
  const open = b.subtotal('Equity at the beginning of the period', 'حقوق الملكية في بداية الفترة', 'opening_equity');
  b.spacer();
  b.heading('Changes during the period', 'التغيرات خلال الفترة');
  b.add({ rowType: 'ProfitToDate', label: 'Profit (loss) for the period', labelAr: 'ربح (خسارة) الفترة', format: { indent: 1 } });
  for (const a of equity) one(a, null);
  const moves = b.subtotal('Total changes during the period', 'إجمالي التغيرات خلال الفترة', 'equity_changes');
  b.spacer();
  b.calc('Equity at the end of the period', 'حقوق الملكية في نهاية الفترة', [{ rowNumber: open, sign: 1 }, { rowNumber: moves, sign: 1 }], 'closing_equity', { underline: 'double' });
  return { rows: b.rows, columns: [
    col(1, 'Current period', 'الفترة الحالية', { periodBasis: 'CurrentPeriod', valueBasis: 'Movement' }),
    col(2, 'Previous period', 'الفترة السابقة', { periodBasis: 'PriorPeriod', valueBasis: 'Movement' }),
  ] };
}

const STANDARD: { type: ReportType; name: string; nameAr: string; mode: 'Summary' | 'Detailed'; build: (chart: Acct[]) => Design }[] = [
  { type: 'TrialBalance', name: 'Trial Balance', nameAr: 'ميزان المراجعة', mode: 'Detailed', build: standardTrialBalance },
  { type: 'PnL', name: 'Income Statement', nameAr: 'قائمة الدخل', mode: 'Summary', build: standardIncomeStatement },
  { type: 'BalanceSheet', name: 'Balance Sheet', nameAr: 'قائمة المركز المالي', mode: 'Summary', build: standardBalanceSheet },
  { type: 'CashFlow', name: 'Cash Flow Statement', nameAr: 'قائمة التدفقات النقدية', mode: 'Summary', build: standardCashFlow },
  { type: 'ChangesInEquity', name: 'Statement of Changes in Equity', nameAr: 'قائمة التغيرات في حقوق الملكية', mode: 'Summary', build: standardChangesInEquity },
];

// Creates the three standard definitions a company does not have yet. Idempotent.
export async function seedCompanyReportDefinitions(tx: any, companyId: string): Promise<number> {
  const existing: any[] = await tx.select().from(schema.reportDefinitions).where(and(eq(schema.reportDefinitions.companyId, companyId), eq(schema.reportDefinitions.isSystemSeeded, true)));
  const have = new Set(existing.map(e => e.reportType));
  const chart: Acct[] = await tx.select().from(schema.companyAccounts).where(eq(schema.companyAccounts.companyId, companyId));
  let created = 0;
  for (const s of STANDARD) {
    if (have.has(s.type)) continue;
    const [defaultExists] = await tx.select({ id: schema.reportDefinitions.id }).from(schema.reportDefinitions).where(and(eq(schema.reportDefinitions.companyId, companyId), eq(schema.reportDefinitions.reportType, s.type), eq(schema.reportDefinitions.isDefault, true)));
    const id = await createDefinition(tx, companyId, null, { name: s.name, nameAr: s.nameAr, reportType: s.type, isSystemSeeded: true, isDefault: !defaultExists, defaultDisplayMode: s.mode });
    await saveDesign(tx, companyId, id, s.build(chart));
    created++;
  }
  return created;
}

// Regenerates one standard definition from the chart as it is now ("reset to standard").
export async function resetStandardDefinition(tx: any, companyId: string, definitionId: string): Promise<void> {
  const [d] = await tx.select().from(schema.reportDefinitions).where(and(eq(schema.reportDefinitions.id, definitionId), eq(schema.reportDefinitions.companyId, companyId)));
  const s = STANDARD.find(x => x.type === d?.reportType);
  if (!d || !d.isSystemSeeded || !s) throw Object.assign(new Error('Only a standard report can be reset.'), { status: 400 });
  const chart: Acct[] = await tx.select().from(schema.companyAccounts).where(eq(schema.companyAccounts.companyId, companyId));
  await saveDesign(tx, companyId, definitionId, s.build(chart));
}
