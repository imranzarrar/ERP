import * as schema from '../../src/db/schema.js';
import { eq, and, lte, inArray, sql } from 'drizzle-orm';
import { round2 } from './businessLogic.js';
import { todayStr } from './clock.js';
import { getQuarterDateRange, computeVatReturnFigures } from './vatReturn.js';
import { subledgerReconciliation } from './subledger.js';
import {
  computeBalanceSheet, computeTrialBalance, computeProfitLoss, computeAllBankBalances, computeBankLedger, computeCustomerStatement,
  computeVendorStatement, computeOutstanding, computeStockValuation, computeSalesVatRegister, computePurchaseVatRegister, computeMonthPnL,
  computeDashboardSummary,
} from './financialReports.js';

// The reporting rules, as code. Every check is one rule that must ALWAYS hold in a correctly working system; a failing check names the rule
// that was violated, so a mismatch is traced to its cause (a posting, a date, a missing guard), never "fixed" by adjusting one figure.
//
//   R1  the books balance                       (Balance Sheet check = 0, Trial Balance debits = credits)
//   R2  every balance ties to its register       (bank, receivables, payables, inventory, VAT, profit)
//   R3  stock is reconciled                      (stock register movements = quantities on hand)
//   R4  a locked period never moves              (closed months keep their stored profit, filed VAT returns keep their figures)
//   R5  the books balance at every month end     (as-at reports are right, not just today's)
//   R6  the ledger agrees with the documents     (informational: every account, document-based vs the journal)
//   R7  the journal is sound                     (every entry balances, every line sits on a chart account, every posted manual journal has its entry)
export interface ConsistencyCheck { id: string; rule: string; ok: boolean; severity: 'error' | 'warn'; detail: string; }
export interface ConsistencyReport { asOf: string; ok: boolean; errors: number; warnings: number; checks: ConsistencyCheck[]; }

const TOL = 0.011;
const near = (a: number, b: number) => Math.abs(a - b) < TOL;
const NO_SCOPE = { branchIds: null } as any;

export async function computeConsistencyCheck(executor: any, companyId: string, asOfDate?: string): Promise<ConsistencyReport> {
  const asOf = asOfDate || todayStr();
  // The outstanding, statement, stock-valuation and stock-register reports show the position NOW. Comparing them with an as-at figure is only
  // meaningful when the as-at date is today (or later); for an earlier date they legitimately include documents dated after it.
  const isCurrent = asOf >= todayStr();
  const checks: ConsistencyCheck[] = [];
  const add = (id: string, rule: string, ok: boolean, detail: string, severity: 'error' | 'warn' = 'error') => checks.push({ id, rule, ok, severity, detail: ok ? 'ok' : detail });
  const fmt = (...kv: [string, number][]) => kv.map(([k, v]) => `${k} ${round2(v)}`).join(' | ');

  const bs = await computeBalanceSheet(executor, companyId, asOf);
  const farBack = '1900-01-01';
  const tb = await computeTrialBalance(executor, companyId, farBack, asOf);
  const plAll = await computeProfitLoss(executor, companyId, farBack, asOf, 'Accrual', NO_SCOPE);

  // ---------------- R1: the books balance ----------------
  add('R1.1', 'Balance Sheet balances (assets = liabilities + equity)', near(bs.balanceCheck, 0), `out by ${bs.balanceCheck}`);
  add('R1.2', 'Trial Balance balances (debits = credits)', near(tb.totalDebits, tb.totalCredits), `debits ${tb.totalDebits} vs credits ${tb.totalCredits}`);

  // ---------------- R2: balances tie to their registers ----------------
  const banks = await computeAllBankBalances(executor, companyId, asOf);
  let ledgerBankTotal = 0;
  for (const b of banks) {
    const l = await computeBankLedger(executor, companyId, b.bankId, '1900-01-01', asOf, NO_SCOPE);
    ledgerBankTotal = round2(ledgerBankTotal + l.endingBalance);
  }
  add('R2.1', 'Cash: Balance Sheet bank = sum of every bank ledger', near(bs.bankBalance, ledgerBankTotal), fmt(['balance sheet', bs.bankBalance], ['bank ledgers', ledgerBankTotal]));

  const outstanding = await computeOutstanding(executor, companyId, null, null, 'ALL', 'ALL', NO_SCOPE);
  if (isCurrent) add('R2.2', 'Receivables: Balance Sheet = outstanding report', near(bs.accountsReceivable, outstanding.totalReceivable), fmt(['balance sheet', bs.accountsReceivable], ['outstanding', outstanding.totalReceivable]));
  if (isCurrent) add('R2.3', 'Payables: Balance Sheet = outstanding report', near(bs.accountsPayable, outstanding.totalPayable), fmt(['balance sheet', bs.accountsPayable], ['outstanding', outstanding.totalPayable]));

  const customers = await executor.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.companyId, companyId));
  let customerTotal = 0;
  for (const c of customers) customerTotal = round2(customerTotal + (await computeCustomerStatement(executor, companyId, c.id, NO_SCOPE)).endingBalance);
  if (isCurrent) add('R2.4', 'Receivables: sum of customer statements = Balance Sheet', near(customerTotal, bs.accountsReceivable), fmt(['customer statements', customerTotal], ['balance sheet', bs.accountsReceivable]), 'warn');

  const vendors = await executor.select({ id: schema.vendors.id }).from(schema.vendors).where(eq(schema.vendors.companyId, companyId));
  let vendorTotal = 0;
  for (const v of vendors) vendorTotal = round2(vendorTotal + (await computeVendorStatement(executor, companyId, v.id, NO_SCOPE)).endingBalance);
  if (isCurrent) add('R2.5', 'Payables: sum of vendor statements = payables less vendor credit', near(vendorTotal, bs.accountsPayable - bs.vendorCreditReceivable), fmt(['vendor statements', vendorTotal], ['payables - vendor credit', bs.accountsPayable - bs.vendorCreditReceivable]));

  const stock = await computeStockValuation(executor, companyId, 'ALL', NO_SCOPE);
  if (isCurrent) add('R2.6', 'Inventory: Balance Sheet = stock valuation report', near(bs.inventoryValue, stock.totalValue), fmt(['balance sheet', bs.inventoryValue], ['stock valuation', stock.totalValue]));

  const sales = await computeSalesVatRegister(executor, companyId, farBack, asOf, 'ALL', NO_SCOPE);
  const purchases = await computePurchaseVatRegister(executor, companyId, farBack, asOf, 'ALL', NO_SCOPE);
  add('R2.7', 'Revenue: profit & loss revenue = sales VAT register (net of credit notes)', near(plAll.totalRevenue, sales.totals.subtotal), fmt(['P&L revenue', plAll.totalRevenue], ['sales register', sales.totals.subtotal]));
  add('R2.8', 'Output VAT: Balance Sheet = sales VAT register', near(bs.vatOutputPayable, sales.totals.taxAmount), fmt(['balance sheet', bs.vatOutputPayable], ['sales register', sales.totals.taxAmount]));
  add('R2.9', 'Input VAT: Balance Sheet = purchase VAT register', near(bs.vatInputRecoverable, purchases.totals.taxAmount), fmt(['balance sheet', bs.vatInputRecoverable], ['purchase register', purchases.totals.taxAmount]));

  const dash = await computeDashboardSummary(executor, companyId, farBack, asOf, NO_SCOPE as any).catch(() => null);
  if (dash) add('R2.10', 'Profit: dashboard = profit & loss', near((dash as any).netProfit, plAll.netProfit), fmt(['dashboard', (dash as any).netProfit], ['P&L', plAll.netProfit]));
  add('R2.11', 'Profit: Balance Sheet equity = capital + profit & loss', near(bs.totalEquity, bs.capitalContributed + plAll.netProfit), fmt(['equity', bs.totalEquity], ['capital + P&L profit', bs.capitalContributed + plAll.netProfit]));

  // ---------------- R3: stock reconciles ----------------
  const onHand: any[] = await executor.select({ productId: schema.inventoryStocks.productId, quantity: schema.inventoryStocks.quantity }).from(schema.inventoryStocks).where(eq(schema.inventoryStocks.companyId, companyId));
  const moved: any[] = await executor.select({ productId: schema.stockLedgerTransactions.productId, change: schema.stockLedgerTransactions.quantityChange }).from(schema.stockLedgerTransactions).where(eq(schema.stockLedgerTransactions.companyId, companyId));
  const byProduct = new Map<string, { qty: number; mv: number }>();
  for (const r of onHand) { const e = byProduct.get(r.productId) || { qty: 0, mv: 0 }; e.qty = round2(e.qty + Number(r.quantity)); byProduct.set(r.productId, e); }
  for (const r of moved) { const e = byProduct.get(r.productId) || { qty: 0, mv: 0 }; e.mv = round2(e.mv + Number(r.change)); byProduct.set(r.productId, e); }
  const stockOff = [...byProduct.entries()].filter(([, v]) => !near(v.qty, v.mv));
  if (isCurrent) add('R3.1', 'Stock: movements in the stock register = quantity on hand, per product', stockOff.length === 0, `${stockOff.length} product(s) differ, e.g. on hand ${stockOff[0]?.[1].qty} vs movements ${stockOff[0]?.[1].mv}`);

  // ---------------- R4: locked periods never move ----------------
  const closed: any[] = await executor.select().from(schema.fiscalMonths).where(and(eq(schema.fiscalMonths.companyId, companyId), eq(schema.fiscalMonths.status, 'Closed')));
  const moved4: string[] = [];
  for (const m of closed) {
    if (!m.closedPnL) continue;
    const live = await computeMonthPnL(executor, companyId, m.id);
    const stored = Number(m.closedPnL.netProfit);
    if (!near(stored, live.includingPending.net) && !near(stored, live.paid.net)) moved4.push(`${m.id}: stored ${stored} vs now ${round2(live.includingPending.net)}`);
  }
  add('R4.1', 'Closed months keep the profit stored when they were closed', moved4.length === 0, moved4.join('; '));

  const filed: any[] = await executor.select().from(schema.taxReturns).where(and(eq(schema.taxReturns.companyId, companyId), eq(schema.taxReturns.status, 'Filed'), eq(schema.taxReturns.isDeleted, false)));
  const moved4b: string[] = [];
  for (const r of filed) {
    const snap = r.figuresSnapshot || {};
    const now = await computeVatReturnFigures(executor, companyId, r.year, r.quarter);
    if (!near(Number(snap.outputVat), now.outputVat) || !near(Number(snap.inputVat), now.inputVat)) moved4b.push(`${r.referenceNumber}: filed out ${snap.outputVat} in ${snap.inputVat} vs now out ${now.outputVat} in ${now.inputVat}`);
  }
  add('R4.2', 'Filed VAT returns keep the figures they were filed with', moved4b.length === 0, moved4b.join('; '));

  // ---------------- R5: the books balance at every month end ----------------
  const firstDoc: any[] = await executor.select({ d: schema.invoices.docDate }).from(schema.invoices).where(eq(schema.invoices.companyId, companyId));
  const firstExp: any[] = await executor.select({ d: schema.expenses.docDate }).from(schema.expenses).where(eq(schema.expenses.companyId, companyId));
  const firstMonth = [...firstDoc, ...firstExp].map(r => String(r.d).slice(0, 7)).sort()[0];
  const badMonthEnds: string[] = [];
  if (firstMonth) {
    let [y, m] = firstMonth.split('-').map(Number);
    const [ey, em] = asOf.slice(0, 7).split('-').map(Number);
    while (y < ey || (y === ey && m < em)) {
      const end = `${y}-${String(m).padStart(2, '0')}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
      const b = await computeBalanceSheet(executor, companyId, end);
      if (!near(b.balanceCheck, 0)) badMonthEnds.push(`${end} out by ${b.balanceCheck}`);
      m++; if (m > 12) { m = 1; y++; }
    }
  }
  add('R5.1', 'Balance Sheet balances at every earlier month end', badMonthEnds.length === 0, badMonthEnds.join('; '));

  // ---------------- R6: ledger vs documents (informational) ----------------
  const lines: any[] = await executor.select({ k: schema.journalLines.accountKey, dr: schema.journalLines.debit, cr: schema.journalLines.credit })
    .from(schema.journalLines).innerJoin(schema.journalEntries, eq(schema.journalLines.journalEntryId, schema.journalEntries.id))
    .where(and(eq(schema.journalLines.companyId, companyId), lte(schema.journalEntries.postingDate, asOf)));
  const net = (k: string) => round2(lines.filter(l => l.k === k).reduce((n, l) => n + Number(l.dr) - Number(l.cr), 0));
  if (lines.length > 0) {
    const pairs: [string, number, number][] = [
      ['BANK', net('BANK'), bs.bankBalance], ['AR', net('AR'), round2(bs.accountsReceivable - bs.customerAdvances)], ['AP', -net('AP'), round2(bs.accountsPayable - bs.vendorAdvances)],
      ['INVENTORY', net('INVENTORY'), bs.inventoryValue], ['FIXED_ASSETS', net('FIXED_ASSETS'), bs.fixedAssets],
      ['VAT_INPUT', net('VAT_INPUT'), bs.vatInputRecoverable], ['VAT_OUTPUT', -net('VAT_OUTPUT'), bs.vatOutputPayable],
      ['GR_IR_CLEARING', -net('GR_IR_CLEARING'), bs.goodsReceivedNotBilled], ['VENDOR_CREDIT', net('VENDOR_CREDIT_RECEIVABLE'), bs.vendorCreditReceivable],
      ['SALES_REVENUE', -net('SALES_REVENUE'), plAll.totalRevenue], ['COGS', net('COGS'), plAll.costOfGoodsSold],
    ];
    const diffs = pairs.filter(([, a, b]) => !near(a, b));
    add('R6.1', 'The journal agrees with the document-based reports, account by account', diffs.length === 0, diffs.map(([k, a, b]) => `${k} ledger ${a} vs reports ${b}`).join('; '), 'warn');
  }

  // ---------------- R7: the journal itself is sound ----------------
  const bad: any = await executor.execute(sql`SELECT COUNT(*)::int AS n FROM (
      SELECT l.journal_entry_id FROM journal_lines l WHERE l.company_id = ${companyId}::uuid GROUP BY l.journal_entry_id
      HAVING ABS(SUM(l.debit) - SUM(l.credit)) > 0.011) x`);
  add('R7.1', 'Every journal entry balances (debits = credits)', Number(bad.rows[0].n) === 0, `${bad.rows[0].n} entr(ies) out of balance`);
  const noAcct: any = await executor.execute(sql`SELECT COUNT(*)::int AS n FROM journal_lines WHERE company_id = ${companyId}::uuid AND account_id IS NULL`);
  add('R7.2', 'Every journal line sits on an account of the chart', Number(noAcct.rows[0].n) === 0, `${noAcct.rows[0].n} line(s) have no chart account (run the chart seeding / check Account Mapping)`, 'warn');
  const mj: any = await executor.execute(sql`SELECT COUNT(*)::int AS n FROM manual_journals mj WHERE mj.company_id = ${companyId}::uuid AND mj.status = 'Posted'
      AND (mj.journal_entry_id IS NULL OR (SELECT COALESCE(SUM(debit),0) FROM manual_journal_lines WHERE journal_id = mj.id) <> (SELECT COALESCE(SUM(debit),0) FROM journal_lines WHERE journal_entry_id = mj.journal_entry_id))`);
  add('R7.3', 'Every posted manual journal has a ledger entry of the same amount', Number(mj.rows[0].n) === 0, `${mj.rows[0].n} posted journal(s) do not match their ledger entry`);

  // ---------------- R8: the customer and vendor subledgers are the ledger ----------------
  const subledger: any = await executor.execute(sql`SELECT
      COUNT(*) FILTER (WHERE a.subledger_type = 'customer' AND l.customer_id IS NULL)::int AS cust_untagged,
      COUNT(*) FILTER (WHERE a.subledger_type = 'vendor' AND l.vendor_id IS NULL)::int AS vend_untagged,
      COUNT(*) FILTER (WHERE l.customer_id IS NOT NULL AND COALESCE(a.subledger_type, '') <> 'customer')::int AS cust_wrong,
      COUNT(*) FILTER (WHERE l.vendor_id IS NOT NULL AND COALESCE(a.subledger_type, '') <> 'vendor')::int AS vend_wrong
    FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
    JOIN company_accounts a ON a.company_id = l.company_id AND ((l.account_id IS NOT NULL AND a.id = l.account_id) OR (l.account_id IS NULL AND l.account_key IS NOT NULL AND a.system_key = l.account_key))
    WHERE l.company_id = ${companyId}::uuid AND e.posting_date <= ${asOf}`);
  const sl = subledger.rows[0];
  add('R8.1', 'Every receivable line carries its customer and every payable line its vendor', Number(sl.cust_untagged) + Number(sl.vend_untagged) === 0, `${sl.cust_untagged} receivable and ${sl.vend_untagged} payable line(s) have no party (run scripts/backfill-party-tags.ts)`);
  add('R8.2', 'A customer or vendor tag sits only on a control account of its own subledger', Number(sl.cust_wrong) + Number(sl.vend_wrong) === 0, `${sl.cust_wrong} customer and ${sl.vend_wrong} vendor tag(s) on a wrong account`);
  for (const kind of ['customer', 'vendor'] as const) {
    const rec = await subledgerReconciliation(executor, companyId, kind, asOf);
    add(kind === 'customer' ? 'R8.3' : 'R8.4', `The ${kind} aging adds up to the ${kind === 'customer' ? 'receivable' : 'payable'} control accounts`, near(rec.difference, 0), `control accounts ${rec.controlBalance} vs parties ${rec.agingTotal}`);
  }

  const errors = checks.filter(c => !c.ok && c.severity === 'error').length;
  const warnings = checks.filter(c => !c.ok && c.severity === 'warn').length;
  return { asOf, ok: errors === 0, errors, warnings, checks };
}
