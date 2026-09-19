import * as schema from '../../src/db/schema.js';
import { eq, and, gte, lte, lt, ne, inArray, asc, sql } from 'drizzle-orm';
import { round2, computeInvoiceServerTotals } from './businessLogic.js';

// Real, server-side financial-report calculations — one function per report, each scoped
// by companyId (+ a date range / customer / vendor / investor / shift id where relevant),
// querying with NO row cap, following the exact pattern server/lib/vatReturn.ts already
// established (already correct, already proven). See BACKLOG.md items 110+ and
// .claude/skills/server-side-report-aggregation/SKILL.md for the "why": every one of
// these was previously computed CLIENT-SIDE by summing /api/state's arrays, which
// src/db/apiState.ts caps to the most recent DEFAULT_LIST_LIMIT (500) rows — correct only
// as long as a tenant's own history in that table never grew past the cap.
//
// A Credit Note reverses an original sale — ported from src/dbStore.ts's getInvoiceSign
// as a plain function rather than importing that legacy client file from server code
// (same reasoning server/lib/vatReturn.ts already documents for its own copy).
function invoiceSign(inv: { documentType?: string | null }): number {
  return inv.documentType === 'CreditNote' ? -1 : 1;
}

interface InvoiceTotals { itemsSubtotal: number; headerDiscount: number; discountedSubtotal: number; taxAmount: number; grandTotal: number; }

// Shared by every function below that needs per-invoice totals — fetches items + tax
// slabs for a given set of invoices once, and returns a Map so callers never recompute
// the same invoice twice. NOTE: this correctly passes each invoice's own
// discountPercentage into computeInvoiceServerTotals — several of the client-side
// functions this module replaces (Dashboard.tsx's totalSales/pendingCollection,
// dbStore.ts's calculateMonthPnL) called calculateInvoiceTotals WITHOUT its
// discountPercentage argument, silently ignoring any header discount on the invoice.
// That's a real, separate bug (found while porting this), not a deliberate design this
// port needs to preserve — every consumer here gets the correct, discount-aware total.
async function computeInvoiceTotalsMap(executor: any, invoices: (typeof schema.invoices.$inferSelect)[]): Promise<Map<string, InvoiceTotals>> {
  const result = new Map<string, InvoiceTotals>();
  if (invoices.length === 0) return result;
  const invoiceIds = invoices.map(inv => inv.id);
  const items = await executor.select().from(schema.invoiceItems).where(inArray(schema.invoiceItems.invoiceId, invoiceIds));
  const itemsByInvoiceId = new Map<string, typeof items>();
  for (const item of items) {
    if (!itemsByInvoiceId.has(item.invoiceId)) itemsByInvoiceId.set(item.invoiceId, []);
    itemsByInvoiceId.get(item.invoiceId)!.push(item);
  }
  const taxSlabIds = Array.from(new Set([
    ...invoices.map(inv => inv.taxSlabId).filter(Boolean),
    ...items.map(it => it.taxSlabId).filter(Boolean),
  ])) as string[];
  const taxSlabRows: any[] = taxSlabIds.length > 0 ? await executor.select().from(schema.taxSlabs).where(inArray(schema.taxSlabs.id, taxSlabIds)) : [];
  const percentageById = new Map(taxSlabRows.map(s => [s.id, Number(s.percentage)]));

  for (const inv of invoices) {
    const invItems = itemsByInvoiceId.get(inv.id) || [];
    const headerPercentage = inv.taxSlabId && percentageById.has(inv.taxSlabId) ? percentageById.get(inv.taxSlabId)! : 0;
    result.set(inv.id, computeInvoiceServerTotals(invItems as any, headerPercentage, Number(inv.discountPercentage || 0), percentageById));
  }
  return result;
}

// --- Bank balances ---------------------------------------------------------

export interface BankBalance { bankId: string; bankName: string; balance: number; }

// Ports src/dbStore.ts's generateBankLedger's running-balance logic, scoped by companyId
// with no row cap, computing only the ending balance — every caller in this module only
// ever needs the final number, never the ledger rows themselves (ReportViewer.tsx's own
// Bank Ledger report view is untouched and keeps using the existing client-side function).
export async function computeAllBankBalances(executor: any, companyId: string): Promise<BankBalance[]> {
  const banks = await executor.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyId));
  if (banks.length === 0) return [];
  const bankIds = banks.map(b => b.id);
  const vouchers = await executor.select().from(schema.vouchers).where(
    and(eq(schema.vouchers.companyId, companyId), inArray(schema.vouchers.bankId, bankIds))
  );
  const vouchersByBankId = new Map<string, typeof vouchers>();
  for (const v of vouchers) {
    if (!vouchersByBankId.has(v.bankId)) vouchersByBankId.set(v.bankId, []);
    vouchersByBankId.get(v.bankId)!.push(v);
  }
  return banks.map(bank => {
    const bankVouchers = (vouchersByBankId.get(bank.id) || [])
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.toISOString().localeCompare(b.createdAt.toISOString()));
    let balance = Number(bank.openingBalance);
    for (const v of bankVouchers) {
      const amount = Number(v.amount);
      if (v.type === 'Receipt' || v.type === 'TransferIn') {
        balance += amount;
      } else if (v.type === 'Payment' || v.type === 'TransferOut') {
        balance -= amount;
      } else if (v.type === 'Reversal') {
        // Same convention as generateBankLedger: a Reversal against an Invoice reverses a
        // Receipt (cash out), a Reversal against anything else (Expense) reverses a
        // Payment (cash in).
        if (v.referenceType === 'Invoice') balance -= amount;
        else balance += amount;
      }
    }
    return { bankId: bank.id, bankName: bank.bankName, balance: round2(balance) };
  });
}

export async function computeBankBalance(executor: any, companyId: string, bankId: string): Promise<number> {
  const all = await computeAllBankBalances(executor, companyId);
  return all.find(b => b.bankId === bankId)?.balance || 0;
}

// --- Trial Balance -----------------------------------------------------------

export interface TrialBalanceLedgerLine { name: string; debit: number; credit: number; }
export interface TrialBalanceFigures {
  ledgers: TrialBalanceLedgerLine[];
  totalDebits: number;
  totalCredits: number;
  totalSalesRev: number;
  totalPurchaseExp: number;
}

// Ports ReportViewer.tsx's getTrialBalance (~145-221) — same account derivation (no
// formal chart-of-accounts in this app), same account lines, no row cap.
export async function computeTrialBalance(executor: any, companyId: string, startDate: string, endDate: string): Promise<TrialBalanceFigures> {
  const bankBalances = await computeAllBankBalances(executor, companyId);
  const bankDetails: TrialBalanceLedgerLine[] = bankBalances.map(b => ({
    name: `Cash/Bank - ${b.bankName}`,
    debit: b.balance >= 0 ? b.balance : 0,
    credit: b.balance < 0 ? Math.abs(b.balance) : 0,
  }));

  const invoicesInRange = await executor.select().from(schema.invoices).where(and(
    eq(schema.invoices.companyId, companyId),
    eq(schema.invoices.status, 'Active'),
    gte(schema.invoices.date, startDate),
    lte(schema.invoices.date, endDate),
  ));
  const totalsByInvoiceId = await computeInvoiceTotalsMap(executor, invoicesInRange);

  let totalSalesRev = 0;
  let totalVATCollected = 0;
  for (const inv of invoicesInRange) {
    const totals = totalsByInvoiceId.get(inv.id)!;
    const sign = invoiceSign(inv);
    totalSalesRev = round2(totalSalesRev + totals.itemsSubtotal * sign);
    totalVATCollected = round2(totalVATCollected + totals.taxAmount * sign);
  }

  const unpaidInvoicesInRange = invoicesInRange.filter(inv => inv.paymentStatus === 'Unpaid');
  let accountsReceivable = 0;
  for (const inv of unpaidInvoicesInRange) {
    const totals = totalsByInvoiceId.get(inv.id)!;
    accountsReceivable = round2(accountsReceivable + totals.grandTotal * invoiceSign(inv));
  }

  const expensesInRange = await executor.select().from(schema.expenses).where(and(
    eq(schema.expenses.companyId, companyId),
    eq(schema.expenses.status, 'Active'),
    gte(schema.expenses.date, startDate),
    lte(schema.expenses.date, endDate),
  ));
  let totalPurchaseExp = 0;
  let totalFixedAssets = 0;
  let accountsPayable = 0;
  for (const exp of expensesInRange) {
    const amount = Number(exp.amount);
    if (exp.classification === 'Asset') totalFixedAssets = round2(totalFixedAssets + amount);
    else totalPurchaseExp = round2(totalPurchaseExp + amount);
    if (exp.paymentStatus === 'Unpaid') accountsPayable = round2(accountsPayable + amount);
  }

  const capitalVouchers = await executor.select().from(schema.vouchers).where(and(
    eq(schema.vouchers.companyId, companyId),
    eq(schema.vouchers.referenceType, 'Equity'),
    gte(schema.vouchers.date, startDate),
    lte(schema.vouchers.date, endDate),
  ));
  const totalCapital = round2(capitalVouchers.reduce((sum, v) => sum + Number(v.amount), 0));

  const ledgers: TrialBalanceLedgerLine[] = [
    ...bankDetails,
    { name: 'Accounts Receivable', debit: accountsReceivable, credit: 0 },
    { name: 'Accounts Payable', debit: 0, credit: accountsPayable },
    { name: 'Sales Revenue', debit: 0, credit: totalSalesRev },
    { name: 'Capitalized Fixed Assets', debit: totalFixedAssets, credit: 0 },
    { name: 'Direct Operating Expenses', debit: totalPurchaseExp, credit: 0 },
    { name: 'VAT Collected (Output Tax)', debit: 0, credit: totalVATCollected },
    { name: "Shareholders' Paid-in Capital", debit: 0, credit: totalCapital },
  ];
  const totalDebits = round2(ledgers.reduce((sum, l) => sum + l.debit, 0));
  const totalCredits = round2(ledgers.reduce((sum, l) => sum + l.credit, 0));

  return { ledgers, totalDebits, totalCredits, totalSalesRev, totalPurchaseExp };
}

// --- Profit & Loss -----------------------------------------------------------

export interface InvestorShare { name: string; profitPercentage: number; shareAmount: number; }
export interface ProfitLossFigures {
  accountingBasis: 'Accrual' | 'Cash';
  totalRevenue: number;
  totalExpenses: number;
  netProfit: number;
  operatingInflows: number;
  operatingOutflows: number;
  investingOutflows: number;
  financingInflows: number;
  netCashFlow: number;
  investorShares: InvestorShare[];
}

// Ports ReportViewer.tsx's getProfitLossData (~494-592) — same Accrual/Cash basis
// branching and cash-flow breakdown, no row cap.
export async function computeProfitLoss(executor: any, companyId: string, startDate: string, endDate: string, basis: 'Accrual' | 'Cash'): Promise<ProfitLossFigures> {
  const periodVouchers = await executor.select().from(schema.vouchers).where(and(
    eq(schema.vouchers.companyId, companyId),
    gte(schema.vouchers.date, startDate),
    lte(schema.vouchers.date, endDate),
  ));

  let totalRevenue = 0;
  if (basis === 'Accrual') {
    const revenueInvoices = await executor.select().from(schema.invoices).where(and(
      eq(schema.invoices.companyId, companyId),
      eq(schema.invoices.status, 'Active'),
      gte(schema.invoices.date, startDate),
      lte(schema.invoices.date, endDate),
    ));
    const totalsByInvoiceId = await computeInvoiceTotalsMap(executor, revenueInvoices);
    for (const inv of revenueInvoices) {
      totalRevenue = round2(totalRevenue + totalsByInvoiceId.get(inv.id)!.grandTotal * invoiceSign(inv));
    }
  } else {
    totalRevenue = round2(periodVouchers
      .filter(v => v.referenceType === 'Invoice' && v.type === 'Receipt')
      .reduce((sum, v) => sum + Number(v.amount), 0));
  }

  // Expense rows needed either way: Accrual basis sums them directly; Cash basis needs
  // each expense's own classification to tell an OpEx payment from a CapEx one.
  const periodExpenses: any[] = await executor.select().from(schema.expenses).where(and(
    eq(schema.expenses.companyId, companyId),
    eq(schema.expenses.status, 'Active'),
  ));
  const expenseById = new Map(periodExpenses.map(e => [e.id, e]));

  let totalExpenses = 0;
  if (basis === 'Accrual') {
    const opExInRange = periodExpenses.filter(exp =>
      exp.classification !== 'Asset' &&
      exp.date >= startDate && exp.date <= endDate &&
      (exp.type === 'Accrual' || (exp.type === 'Actual' && !exp.originAccrualId))
    );
    totalExpenses = round2(opExInRange.reduce((sum, exp) => sum + Number(exp.amount), 0));
  } else {
    totalExpenses = round2(periodVouchers
      .filter(v => v.referenceType === 'Expense' && (v.type === 'Payment' || v.type === 'Reversal'))
      .reduce((sum, v) => {
        const exp = expenseById.get(v.referenceId);
        if (exp && exp.classification !== 'Asset') return sum + (v.type === 'Payment' ? Number(v.amount) : -Number(v.amount));
        return sum;
      }, 0));
  }

  const netProfit = round2(totalRevenue - totalExpenses);

  const operatingInflows = round2(periodVouchers
    .filter(v => v.referenceType === 'Invoice' && v.type === 'Receipt')
    .reduce((sum, v) => sum + Number(v.amount), 0));
  const operatingOutflows = round2(periodVouchers
    .filter(v => v.referenceType === 'Expense' && (v.type === 'Payment' || v.type === 'Reversal'))
    .reduce((sum, v) => {
      const exp = expenseById.get(v.referenceId);
      if (exp && exp.classification !== 'Asset') return sum + (v.type === 'Payment' ? Number(v.amount) : -Number(v.amount));
      return sum;
    }, 0));
  const investingOutflows = round2(periodVouchers
    .filter(v => v.referenceType === 'Expense' && (v.type === 'Payment' || v.type === 'Reversal'))
    .reduce((sum, v) => {
      const exp = expenseById.get(v.referenceId);
      if (exp && exp.classification === 'Asset') return sum + (v.type === 'Payment' ? Number(v.amount) : -Number(v.amount));
      return sum;
    }, 0));
  const financingInflows = round2(periodVouchers
    .filter(v => v.referenceType === 'Equity' && v.type === 'Receipt')
    .reduce((sum, v) => sum + Number(v.amount), 0));
  const netCashFlow = round2(operatingInflows - operatingOutflows - investingOutflows + financingInflows);

  const investors = await executor.select().from(schema.investors).where(and(
    eq(schema.investors.companyId, companyId),
    eq(schema.investors.isActive, true),
  ));
  const investorShares: InvestorShare[] = investors.map(inv => ({
    name: inv.name,
    profitPercentage: Number(inv.profitPercentage),
    shareAmount: netProfit > 0 ? round2((netProfit * Number(inv.profitPercentage)) / 100) : 0,
  }));

  return {
    accountingBasis: basis, totalRevenue, totalExpenses, netProfit,
    operatingInflows, operatingOutflows, investingOutflows, financingInflows, netCashFlow,
    investorShares,
  };
}

// --- Balance Sheet -----------------------------------------------------------

export interface BalanceSheetFigures {
  asOfDate: string;
  bankBalance: number;
  accountsReceivable: number;
  inventoryValue: number;
  totalAssets: number;
  accountsPayable: number;
  totalLiabilities: number;
  capitalContributed: number;
  retainedEarnings: number;
  totalEquity: number;
  balanceCheck: number;
}

// Ports ReportViewer.tsx's getBalanceSheetData (~603-653) — an as-of-date snapshot, no
// row cap. Retained earnings comes from fiscalMonths.closedPnL, which after the
// month-close fix below is itself always server-computed — no double-counting of the
// same discount/tax-blindness bug this module fixes elsewhere.
export async function computeBalanceSheet(executor: any, companyId: string, asOfDate: string): Promise<BalanceSheetFigures> {
  const bankBalances = await computeAllBankBalances(executor, companyId);
  const bankBalance = round2(bankBalances.reduce((sum, b) => sum + b.balance, 0));

  const unpaidInvoices = await executor.select().from(schema.invoices).where(and(
    eq(schema.invoices.companyId, companyId),
    eq(schema.invoices.status, 'Active'),
    lte(schema.invoices.date, asOfDate),
    inArray(schema.invoices.paymentStatus, ['Unpaid', 'Partially Paid']),
  ));
  const totalsByInvoiceId = await computeInvoiceTotalsMap(executor, unpaidInvoices);
  let accountsReceivable = 0;
  for (const inv of unpaidInvoices) {
    const total = totalsByInvoiceId.get(inv.id)!.grandTotal;
    accountsReceivable = round2(accountsReceivable + (total - Number(inv.amountPaid || 0)) * invoiceSign(inv));
  }

  const unpaidExpenses = await executor.select().from(schema.expenses).where(and(
    eq(schema.expenses.companyId, companyId),
    eq(schema.expenses.status, 'Active'),
    lte(schema.expenses.date, asOfDate),
    inArray(schema.expenses.paymentStatus, ['Unpaid', 'Partially Paid']),
  ));
  const accountsPayable = round2(unpaidExpenses.reduce((sum, exp) => sum + (Number(exp.amount) - Number(exp.amountPaid || 0)), 0));

  const inventoryStocks: any[] = await executor.select().from(schema.inventoryStocks).where(eq(schema.inventoryStocks.companyId, companyId));
  const productIds = Array.from(new Set(inventoryStocks.map(s => s.productId))) as string[];
  const products: any[] = productIds.length ? await executor.select().from(schema.productsServices).where(inArray(schema.productsServices.id, productIds)) : [];
  const productById = new Map(products.map(p => [p.id, p]));
  const inventoryValue = round2(inventoryStocks.reduce((sum, s) => {
    const cost = Number(productById.get(s.productId)?.averageCost || 0);
    return sum + Number(s.quantity || 0) * cost;
  }, 0));

  const totalAssets = round2(bankBalance + accountsReceivable + inventoryValue);
  const totalLiabilities = accountsPayable;

  const investors = await executor.select().from(schema.investors).where(eq(schema.investors.companyId, companyId));
  const capitalContributed = round2(investors.reduce((sum, inv) => sum + Number(inv.capitalContributed || 0), 0));

  const closedMonths = await executor.select().from(schema.fiscalMonths).where(and(
    eq(schema.fiscalMonths.companyId, companyId),
    eq(schema.fiscalMonths.status, 'Closed'),
  ));
  const retainedEarnings = round2(closedMonths
    .filter((m: any) => m.closedPnL && (!m.closedAt || m.closedAt <= `${asOfDate}T23:59:59`))
    .reduce((sum: number, m: any) => sum + Number(m.closedPnL?.netProfit || 0), 0));
  const totalEquity = round2(capitalContributed + retainedEarnings);

  return {
    asOfDate, bankBalance, accountsReceivable, inventoryValue, totalAssets,
    accountsPayable, totalLiabilities,
    capitalContributed, retainedEarnings, totalEquity,
    balanceCheck: round2(totalAssets - (totalLiabilities + totalEquity)),
  };
}

// --- Fiscal-month P&L (used by the month-close write and its preview) --------

export interface MonthPnL {
  paid: { revenue: number; expenses: number; net: number };
  includingPending: { revenue: number; expenses: number; net: number };
}

// Ports src/dbStore.ts's calculateMonthPnL (~968-1012) — used by POST /transactions/months
// to compute the AUTHORITATIVE closedPnL at close time (never trusting whatever the
// client sent). Also fixes a real, separate bug found while porting: the client version
// called calculateInvoiceTotals WITHOUT the invoice's own discountPercentage, silently
// ignoring header discounts in the closed month's revenue figure — this version doesn't.
export async function computeMonthPnL(executor: any, companyId: string, monthId: string): Promise<MonthPnL> {
  const monthInvoices = await executor.select().from(schema.invoices).where(and(
    eq(schema.invoices.companyId, companyId),
    eq(schema.invoices.status, 'Active'),
  ));
  const invoicesInMonth = monthInvoices.filter(inv => inv.date.startsWith(monthId));
  const totalsByInvoiceId = await computeInvoiceTotalsMap(executor, invoicesInMonth);

  let paidRevenue = 0;
  let totalRevenue = 0;
  for (const inv of invoicesInMonth) {
    const grandTotal = totalsByInvoiceId.get(inv.id)!.grandTotal;
    totalRevenue = round2(totalRevenue + grandTotal);
    if (inv.paymentStatus === 'Paid') paidRevenue = round2(paidRevenue + grandTotal);
  }

  const monthExpenses = await executor.select().from(schema.expenses).where(and(
    eq(schema.expenses.companyId, companyId),
    eq(schema.expenses.status, 'Active'),
  ));
  const expensesInMonth = monthExpenses.filter(exp => exp.date.startsWith(monthId));
  let paidExpenses = 0;
  let totalExpenses = 0;
  for (const exp of expensesInMonth) {
    const amount = Number(exp.amount);
    totalExpenses = round2(totalExpenses + amount);
    if (exp.paymentStatus === 'Paid') paidExpenses = round2(paidExpenses + amount);
  }

  return {
    paid: { revenue: paidRevenue, expenses: paidExpenses, net: round2(paidRevenue - paidExpenses) },
    includingPending: { revenue: totalRevenue, expenses: totalExpenses, net: round2(totalRevenue - totalExpenses) },
  };
}

// --- Dashboard summary --------------------------------------------------------

export interface PendingInvoiceRow { id: string; invoiceNumber: string; customerName: string; amount: number; date: string; daysOutstanding: number; }
export interface PendingExpenseRow { id: string; expenseNumber: string; vendorName: string; amount: number; date: string; }
export interface TopEntityRow { id: string; name: string; total: number; }
export interface InvestorReconciliation { id: string; name: string; contributed: number; hasImbalance: boolean; }
export interface DashboardSummary {
  totalSales: number;
  pendingCollection: number;
  receivedSales: number;
  totalExpenseActual: number;
  totalExpenseAccrual: number;
  totalAssetCapEx: number;
  netProfit: number;
  netProfitMargin: number;
  totalBankCapital: number;
  pendingInvoicesTotal: number;
  pendingInvoicesOnTime: number;
  pendingInvoicesAging: number;
  pendingInvoicesOverdue: number;
  pendingInvoiceRows: PendingInvoiceRow[];
  pendingExpensesTotal: number;
  pendingExpenseRows: PendingExpenseRow[];
  topCustomersBySales: TopEntityRow[];
  topVendorsByExpense: TopEntityRow[];
  investorTotalContributed: number;
  investorHasImbalance: boolean;
  investorReconciliation: InvestorReconciliation[];
  // One entry per id in opts.trailingMonthIds, same order — used for the sales-target
  // trailing average. Company-wide (not branch/user restricted), matching
  // Dashboard.tsx's own trailingMonthlySales, which reads unrestricted executor.invoices.
  trailingMonthlySales: number[];
}

// Ports Dashboard.tsx's core KPI set for one date range (a single month, "last 3 months",
// or "this year" — the caller resolves that into startDate/endDate the same way
// Dashboard.tsx's own periodMode/matchesPeriod logic already does; this function just
// needs the resolved range). branchIds === null means unrestricted (admin/super-admin/
// branches.viewAllBranches), matching server.ts's own branchOk convention exactly.
// restrictToUserId, when set, mirrors Dashboard.tsx's own "a non-admin without a broad
// invoice/expense permission only sees their own created documents" restriction.
// trailingMonthIds: up to 3 already-closed fiscal month ids (YYYY-MM) used only for the
// sales-target trailing average — resolved by the caller (Dashboard.tsx already knows
// which months are closed from its own /api/transactions/months fetch).
export async function computeDashboardSummary(
  executor: any,
  companyId: string,
  startDate: string,
  endDate: string,
  opts: { branchIds: string[] | null; restrictToUserId?: string | null; trailingMonthIds?: string[] } = { branchIds: null },
): Promise<DashboardSummary> {
  const branchOk = (branchId: string | null | undefined) => opts.branchIds === null || branchId == null || (opts.branchIds || []).includes(branchId);

  const allInvoicesInRange = await executor.select().from(schema.invoices).where(and(
    eq(schema.invoices.companyId, companyId),
    gte(schema.invoices.date, startDate),
    lte(schema.invoices.date, endDate),
  ));
  const monthInvoices = allInvoicesInRange.filter(inv =>
    branchOk(inv.branchId) && (!opts.restrictToUserId || inv.createdById === opts.restrictToUserId)
  );
  const activeMonthInvoices = monthInvoices.filter(inv => inv.status === 'Active');
  const totalsByInvoiceId = await computeInvoiceTotalsMap(executor, activeMonthInvoices);

  let totalSales = 0;
  for (const inv of activeMonthInvoices) {
    totalSales = round2(totalSales + totalsByInvoiceId.get(inv.id)!.grandTotal * invoiceSign(inv));
  }

  // Pending Collection is company-wide (not period-filtered) — same as Dashboard.tsx's
  // own pendingInvoicesTotal/pendingCollection, which deliberately look at every
  // still-unpaid invoice regardless of when it was raised, not just this period's.
  const allUnpaidInvoices = await executor.select().from(schema.invoices).where(and(
    eq(schema.invoices.companyId, companyId),
    eq(schema.invoices.status, 'Active'),
    ne(schema.invoices.documentType, 'CreditNote'),
  ));
  const unpaidInvoices = allUnpaidInvoices.filter(inv =>
    branchOk(inv.branchId) && (!opts.restrictToUserId || inv.createdById === opts.restrictToUserId)
  );
  const unpaidTotalsByInvoiceId = await computeInvoiceTotalsMap(executor, unpaidInvoices);
  let pendingCollection = 0;
  const today = new Date();
  const pendingInvoiceRows: PendingInvoiceRow[] = [];
  const customerIds = Array.from(new Set(unpaidInvoices.map(inv => inv.customerId).filter(Boolean))) as string[];
  const customers: any[] = customerIds.length ? await executor.select().from(schema.customers).where(inArray(schema.customers.id, customerIds)) : [];
  const customerNameById = new Map(customers.map(c => [c.id, c.name]));
  for (const inv of unpaidInvoices) {
    const totals = unpaidTotalsByInvoiceId.get(inv.id)!;
    const balance = (totals.grandTotal - Number(inv.amountPaid || 0)) * invoiceSign(inv);
    pendingCollection = round2(pendingCollection + balance);
    if (balance > 0) {
      const daysOutstanding = Math.floor((today.getTime() - new Date(inv.date).getTime()) / 86400000);
      pendingInvoiceRows.push({
        id: inv.id, invoiceNumber: inv.invoiceNumber,
        customerName: customerNameById.get(inv.customerId) || 'Walk-in Customer',
        amount: round2(balance), date: inv.date, daysOutstanding,
      });
    }
  }
  pendingInvoiceRows.sort((a, b) => b.daysOutstanding - a.daysOutstanding);
  const pendingInvoicesOnTime = pendingInvoiceRows.filter(r => r.daysOutstanding <= 30).length;
  const pendingInvoicesAging = pendingInvoiceRows.filter(r => r.daysOutstanding > 30 && r.daysOutstanding <= 90).length;
  const pendingInvoicesOverdue = pendingInvoiceRows.filter(r => r.daysOutstanding > 90).length;

  const periodVouchers = await executor.select().from(schema.vouchers).where(and(
    eq(schema.vouchers.companyId, companyId),
    gte(schema.vouchers.date, startDate),
    lte(schema.vouchers.date, endDate),
  ));
  const monthVouchers = periodVouchers.filter(v => branchOk(v.branchId));
  const receivedSales = round2(
    monthVouchers.filter(v => v.referenceType === 'Invoice' && v.type === 'Receipt').reduce((sum, v) => sum + Number(v.amount), 0) -
    monthVouchers.filter(v => v.referenceType === 'Invoice' && v.type === 'Reversal').reduce((sum, v) => sum + Number(v.amount), 0)
  );

  const allExpensesInRange = await executor.select().from(schema.expenses).where(and(
    eq(schema.expenses.companyId, companyId),
    gte(schema.expenses.date, startDate),
    lte(schema.expenses.date, endDate),
  ));
  const monthExpenses = allExpensesInRange.filter(exp =>
    branchOk(exp.branchId) && (!opts.restrictToUserId || exp.createdById === opts.restrictToUserId)
  );
  const totalExpenseActual = round2(monthExpenses
    .filter(exp => exp.status === 'Active' && exp.type === 'Actual' && exp.classification !== 'Asset')
    .reduce((sum, exp) => sum + Number(exp.amount), 0));
  const totalExpenseAccrual = round2(monthExpenses
    .filter(exp => exp.status === 'Active' && exp.type === 'Accrual' && exp.classification !== 'Asset')
    .reduce((sum, exp) => sum + Number(exp.amount), 0));
  const totalAssetCapEx = round2(monthExpenses
    .filter(exp => exp.status === 'Active' && exp.classification === 'Asset')
    .reduce((sum, exp) => sum + Number(exp.amount), 0));

  const netProfit = round2(totalSales - totalExpenseActual);
  const netProfitMargin = totalSales > 0 ? round2((netProfit / totalSales) * 100) : 0;

  const bankBalances = await computeAllBankBalances(executor, companyId);
  const activeBankIds = new Set((await executor.select({ id: schema.bankAccounts.id })
    .from(schema.bankAccounts)
    .where(and(eq(schema.bankAccounts.companyId, companyId), eq(schema.bankAccounts.isActive, true)))
  ).map(b => b.id));
  const totalBankCapital = round2(bankBalances.filter(b => activeBankIds.has(b.bankId)).reduce((sum, b) => sum + b.balance, 0));

  // Pending Expenses is also company-wide, same reasoning as Pending Collection above.
  const allUnpaidExpenses = await executor.select().from(schema.expenses).where(and(
    eq(schema.expenses.companyId, companyId),
    eq(schema.expenses.status, 'Active'),
    inArray(schema.expenses.paymentStatus, ['Unpaid', 'Partially Paid']),
  ));
  const unpaidExpensesFiltered = allUnpaidExpenses.filter(exp =>
    exp.type === 'Actual' && branchOk(exp.branchId) && (!opts.restrictToUserId || exp.createdById === opts.restrictToUserId)
  );
  const vendorIdsForPending = Array.from(new Set(unpaidExpensesFiltered.map(e => e.vendorId).filter(Boolean))) as string[];
  const pendingVendorRows: any[] = vendorIdsForPending.length ? await executor.select().from(schema.vendors).where(inArray(schema.vendors.id, vendorIdsForPending)) : [];
  const pendingVendorNameById = new Map(pendingVendorRows.map(v => [v.id, v.name]));
  const pendingExpenseRows: PendingExpenseRow[] = unpaidExpensesFiltered
    .map(exp => ({ exp, due: round2(Math.max(0, Number(exp.amount) - Number(exp.amountPaid || 0))) }))
    .filter(x => x.due > 0.01)
    .sort((a, b) => a.exp.date.localeCompare(b.exp.date))
    .map(x => ({
      id: x.exp.id, expenseNumber: x.exp.expenseNumber,
      vendorName: pendingVendorNameById.get(x.exp.vendorId) || 'Vendor',
      amount: x.due, date: x.exp.date,
    }));
  const pendingExpensesTotal = round2(pendingExpenseRows.reduce((sum, r) => sum + r.amount, 0));

  const salesByCustomer = new Map<string, number>();
  for (const inv of activeMonthInvoices) {
    if (!inv.customerId) continue;
    const total = totalsByInvoiceId.get(inv.id)!.grandTotal * invoiceSign(inv);
    salesByCustomer.set(inv.customerId, round2((salesByCustomer.get(inv.customerId) || 0) + total));
  }
  const topCustomerIds = Array.from(new Set([...customerIds, ...salesByCustomer.keys()]));
  const topCustomerRows: any[] = topCustomerIds.length ? await executor.select().from(schema.customers).where(inArray(schema.customers.id, topCustomerIds)) : [];
  const topCustomerNameById = new Map([...customerNameById, ...topCustomerRows.map(c => [c.id, c.name] as const)]);
  const topCustomersBySales: TopEntityRow[] = Array.from(salesByCustomer.entries())
    .map(([id, total]) => ({ id, name: topCustomerNameById.get(id) || 'Walk-in Customer', total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  const expensesByVendor = new Map<string, number>();
  for (const exp of monthExpenses.filter(e => e.status === 'Active')) {
    if (!exp.vendorId) continue;
    expensesByVendor.set(exp.vendorId, round2((expensesByVendor.get(exp.vendorId) || 0) + Number(exp.amount)));
  }
  const vendorIds = Array.from(expensesByVendor.keys());
  const vendorRows: any[] = vendorIds.length ? await executor.select().from(schema.vendors).where(inArray(schema.vendors.id, vendorIds)) : [];
  const vendorNameById = new Map(vendorRows.map(v => [v.id, v.name]));
  const topVendorsByExpense: TopEntityRow[] = Array.from(expensesByVendor.entries())
    .map(([id, total]) => ({ id, name: vendorNameById.get(id) || 'Vendor', total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  // Investor equity reconciliation — company-wide, no date-range scoping, same as the
  // Partners' Equity panel this ports (Dashboard.tsx ~275-292): sums every Equity voucher
  // ever posted for each investor against their target share of the total, not just this
  // period's vouchers.
  const companyInvestors = await executor.select().from(schema.investors).where(eq(schema.investors.companyId, companyId));
  let investorReconciliation: InvestorReconciliation[] = [];
  let investorTotalContributed = 0;
  let investorHasImbalance = false;
  if (companyInvestors.length > 0) {
    const investorIds = companyInvestors.map(i => i.id);
    const equityVouchers = await executor.select().from(schema.vouchers).where(and(
      eq(schema.vouchers.companyId, companyId),
      eq(schema.vouchers.referenceType, 'Equity'),
      inArray(schema.vouchers.referenceId, investorIds),
    ));
    const contributedByInvestorId = new Map<string, number>();
    for (const v of equityVouchers) {
      contributedByInvestorId.set(v.referenceId, round2((contributedByInvestorId.get(v.referenceId) || 0) + Number(v.amount)));
    }
    investorTotalContributed = round2(Array.from(contributedByInvestorId.values()).reduce((sum, v) => sum + v, 0));
    investorReconciliation = companyInvestors.map(inv => {
      const contributed = contributedByInvestorId.get(inv.id) || 0;
      const targetShare = (investorTotalContributed * Number(inv.equityPercentage || 0)) / 100;
      const hasImbalance = investorTotalContributed === 0 || Math.abs(targetShare - contributed) > 0.01;
      return { id: inv.id, name: inv.name, contributed, hasImbalance };
    });
    investorHasImbalance = investorTotalContributed === 0 || investorReconciliation.some(r => r.hasImbalance);
  }

  // Trailing monthly sales (for the sales-target average) — one real invoice query per
  // closed month id the caller passes in, same discount-aware totals as everything above.
  const trailingMonthlySales: number[] = [];
  for (const monthId of opts.trailingMonthIds || []) {
    const monthInvoicesAll = await executor.select().from(schema.invoices).where(and(
      eq(schema.invoices.companyId, companyId),
      eq(schema.invoices.status, 'Active'),
      gte(schema.invoices.date, `${monthId}-01`),
      lte(schema.invoices.date, `${monthId}-31`),
    ));
    const monthInvoicesFiltered = monthInvoicesAll.filter(inv => branchOk(inv.branchId));
    const monthTotalsByInvoiceId = await computeInvoiceTotalsMap(executor, monthInvoicesFiltered);
    let monthSales = 0;
    for (const inv of monthInvoicesFiltered) {
      monthSales = round2(monthSales + monthTotalsByInvoiceId.get(inv.id)!.grandTotal * invoiceSign(inv));
    }
    trailingMonthlySales.push(monthSales);
  }

  return {
    totalSales, pendingCollection, receivedSales,
    totalExpenseActual, totalExpenseAccrual, totalAssetCapEx,
    netProfit, netProfitMargin, totalBankCapital,
    pendingInvoicesTotal: round2(pendingInvoiceRows.reduce((s, r) => s + r.amount, 0)),
    pendingInvoicesOnTime, pendingInvoicesAging, pendingInvoicesOverdue, pendingInvoiceRows,
    pendingExpensesTotal, pendingExpenseRows, topCustomersBySales, topVendorsByExpense,
    investorTotalContributed, investorHasImbalance, investorReconciliation,
    trailingMonthlySales,
  };
}

// --- Sales reports (SalesReportsModule.tsx) -----------------------------------

interface ReportScopeOpts { branchIds: string[] | null }
function makeBranchOk(branchIds: string[] | null) {
  return (branchId: string | null | undefined) => branchIds === null || branchId == null || branchIds.includes(branchId);
}

export interface SalesRegisterRow { invoiceNumber: string; date: string; customerName: string; status: string; paymentStatus: string; zatcaStatus: string; grandTotal: number; }
// Ports SalesReportsModule.tsx's getSalesRegisterData (~77-105).
export async function computeSalesRegister(executor: any, companyId: string, startDate: string, endDate: string, customerId: string | 'ALL', opts: ReportScopeOpts): Promise<{ rows: SalesRegisterRow[]; totalSales: number }> {
  const branchOk = makeBranchOk(opts.branchIds);
  const invoicesInRange = await executor.select().from(schema.invoices).where(and(
    eq(schema.invoices.companyId, companyId), gte(schema.invoices.date, startDate), lte(schema.invoices.date, endDate),
  ));
  const filtered = invoicesInRange.filter(inv => branchOk(inv.branchId) && (customerId === 'ALL' || inv.customerId === customerId));
  const totalsByInvoiceId = await computeInvoiceTotalsMap(executor, filtered);
  const customerIds = Array.from(new Set(filtered.map(i => i.customerId).filter(Boolean))) as string[];
  const customers = customerIds.length ? await executor.select().from(schema.customers).where(inArray(schema.customers.id, customerIds)) : [];
  const customerNameById = new Map(customers.map(c => [c.id, c.name]));
  const rows: SalesRegisterRow[] = filtered.map(inv => ({
    invoiceNumber: inv.invoiceNumber, date: inv.date, customerName: customerNameById.get(inv.customerId) || 'Walk-In',
    status: inv.status, paymentStatus: inv.documentType === 'CreditNote' ? 'Not Applicable' : inv.paymentStatus,
    zatcaStatus: inv.zatcaStatus || 'NOT_SUBMITTED',
    grandTotal: totalsByInvoiceId.get(inv.id)!.grandTotal * invoiceSign(inv),
  })).sort((a, b) => a.date.localeCompare(b.date));
  const totalSales = round2(rows.filter(r => r.status === 'Active').reduce((s, r) => s + r.grandTotal, 0));
  return { rows, totalSales };
}

export interface ItemWiseSalesRow { productId: string; name: string; quantity: number; revenue: number; }
// Ports getItemWiseSalesData (~110-132).
export async function computeItemWiseSales(executor: any, companyId: string, startDate: string, endDate: string, opts: ReportScopeOpts): Promise<{ rows: ItemWiseSalesRow[]; totalQuantity: number; totalRevenue: number }> {
  const branchOk = makeBranchOk(opts.branchIds);
  const invoicesInRange = await executor.select().from(schema.invoices).where(and(
    eq(schema.invoices.companyId, companyId), eq(schema.invoices.status, 'Active'),
    gte(schema.invoices.date, startDate), lte(schema.invoices.date, endDate),
  ));
  const filtered = invoicesInRange.filter(inv => branchOk(inv.branchId));
  if (filtered.length === 0) return { rows: [], totalQuantity: 0, totalRevenue: 0 };
  const items = await executor.select().from(schema.invoiceItems).where(inArray(schema.invoiceItems.invoiceId, filtered.map(i => i.id)));
  const invoiceById = new Map(filtered.map(i => [i.id, i]));
  const productIds = Array.from(new Set(items.map(it => it.productId).filter(Boolean))) as string[];
  const products: any[] = productIds.length ? await executor.select().from(schema.productsServices).where(inArray(schema.productsServices.id, productIds)) : [];
  const productById = new Map(products.map(p => [p.id, p]));
  const byProduct = new Map<string, ItemWiseSalesRow>();
  for (const item of items) {
    if (!item.productId) continue;
    const inv = invoiceById.get(item.invoiceId)!;
    const sign = invoiceSign(inv);
    const existing = byProduct.get(item.productId) || { productId: item.productId, name: productById.get(item.productId)?.name || item.description, quantity: 0, revenue: 0 };
    const qty = Number(item.quantity) || 0;
    const netUnit = Math.max(0, Number(item.unitCost) - Number(item.discountAmount || 0));
    existing.quantity = round2(existing.quantity + qty * sign);
    existing.revenue = round2(existing.revenue + qty * netUnit * sign);
    byProduct.set(item.productId, existing);
  }
  const rows = Array.from(byProduct.values()).sort((a, b) => b.revenue - a.revenue);
  return { rows, totalQuantity: round2(rows.reduce((s, r) => s + r.quantity, 0)), totalRevenue: round2(rows.reduce((s, r) => s + r.revenue, 0)) };
}

export interface StatementEntry { date: string; type: string; docNumber: string; debit: number; credit: number; runningBalance: number; }
// Ports getCustomerStatementData (~136-166) — deliberately no date-range filter, same as
// the original: a customer's own full history, inherently bounded by "one customer's own
// documents," but still a real unbounded query rather than a client-side scan of a capped array.
export async function computeCustomerStatement(executor: any, companyId: string, customerId: string, opts: ReportScopeOpts): Promise<{ entries: StatementEntry[]; endingBalance: number; customerName: string }> {
  if (!customerId) return { entries: [], endingBalance: 0, customerName: '' };
  const branchOk = makeBranchOk(opts.branchIds);
  const [customer] = await executor.select().from(schema.customers).where(eq(schema.customers.id, customerId));
  const custInvoices = (await executor.select().from(schema.invoices).where(and(
    eq(schema.invoices.companyId, companyId), eq(schema.invoices.customerId, customerId), eq(schema.invoices.status, 'Active'),
  ))).filter(inv => branchOk(inv.branchId));
  const totalsByInvoiceId = await computeInvoiceTotalsMap(executor, custInvoices);
  const invoiceIds = custInvoices.map(i => i.id);
  const receipts = invoiceIds.length ? (await executor.select().from(schema.vouchers).where(and(
    eq(schema.vouchers.companyId, companyId), eq(schema.vouchers.type, 'Receipt'), eq(schema.vouchers.referenceType, 'Invoice'),
    inArray(schema.vouchers.referenceId, invoiceIds),
  ))).filter(v => branchOk(v.branchId)) : [];

  const entries: Omit<StatementEntry, 'runningBalance'>[] = [];
  for (const inv of custInvoices) {
    const total = totalsByInvoiceId.get(inv.id)!.grandTotal;
    if (inv.documentType === 'CreditNote') entries.push({ date: inv.date, type: 'Credit Note', docNumber: inv.invoiceNumber, debit: 0, credit: total });
    else entries.push({ date: inv.date, type: 'Invoice', docNumber: inv.invoiceNumber, debit: total, credit: 0 });
  }
  for (const v of receipts) entries.push({ date: v.date, type: 'Receipt', docNumber: v.voucherNumber, debit: 0, credit: Number(v.amount) });
  entries.sort((a, b) => a.date.localeCompare(b.date));

  let running = 0;
  const withBalance: StatementEntry[] = entries.map(e => {
    running = round2(running + e.debit - e.credit);
    return { ...e, runningBalance: running };
  });
  return { entries: withBalance, endingBalance: running, customerName: customer?.name || '' };
}

export interface QuotationConversionRow { quotationNumber: string; date: string; customerName: string; status: string; }
// Ports getQuotationConversionData (~169-181).
export async function computeQuotationConversion(executor: any, companyId: string, startDate: string, endDate: string, customerId: string | 'ALL', opts: ReportScopeOpts) {
  const branchOk = makeBranchOk(opts.branchIds);
  const quotationsInRange = await executor.select().from(schema.quotations).where(and(
    eq(schema.quotations.companyId, companyId), gte(schema.quotations.date, startDate), lte(schema.quotations.date, endDate),
  ));
  const filtered = quotationsInRange.filter(q => branchOk(q.branchId) && (customerId === 'ALL' || q.customerId === customerId));
  const converted = filtered.filter(q => q.status === 'Converted' && !q.isCancelled).length;
  const cancelled = filtered.filter(q => q.isCancelled).length;
  const pending = filtered.length - converted - cancelled;
  const conversionRate = filtered.length > 0 ? round2((converted / filtered.length) * 100) : 0;
  const customerIds = Array.from(new Set(filtered.map(q => q.customerId).filter(Boolean))) as string[];
  const customers = customerIds.length ? await executor.select().from(schema.customers).where(inArray(schema.customers.id, customerIds)) : [];
  const customerNameById = new Map(customers.map(c => [c.id, c.name]));
  const rows: QuotationConversionRow[] = filtered
    .map(q => ({ quotationNumber: q.quotationNumber, date: q.date, customerName: customerNameById.get(q.customerId) || '', status: q.isCancelled ? 'Cancelled' : q.status }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { rows, total: filtered.length, converted, cancelled, pending, conversionRate };
}

export interface SalesByStaffRow { userId: string; username: string; invoiceCount: number; revenue: number; }
// Ports getSalesByStaffData (~184-197).
export async function computeSalesByStaff(executor: any, companyId: string, startDate: string, endDate: string, opts: ReportScopeOpts): Promise<{ rows: SalesByStaffRow[]; totalRevenue: number }> {
  const branchOk = makeBranchOk(opts.branchIds);
  const invoicesInRange = await executor.select().from(schema.invoices).where(and(
    eq(schema.invoices.companyId, companyId), eq(schema.invoices.status, 'Active'),
    gte(schema.invoices.date, startDate), lte(schema.invoices.date, endDate),
  ));
  const filtered = invoicesInRange.filter(inv => branchOk(inv.branchId));
  const totalsByInvoiceId = await computeInvoiceTotalsMap(executor, filtered);
  const userIds = Array.from(new Set(filtered.map(i => i.createdById).filter(Boolean))) as string[];
  const users: any[] = userIds.length ? await executor.select({ id: schema.users.id, username: schema.users.username }).from(schema.users).where(inArray(schema.users.id, userIds)) : [];
  const usernameById = new Map(users.map(u => [u.id, u.username]));
  const byStaff = new Map<string, SalesByStaffRow>();
  for (const inv of filtered) {
    const key = inv.createdById || 'unknown';
    const existing = byStaff.get(key) || { userId: key, username: usernameById.get(key) || 'Unknown', invoiceCount: 0, revenue: 0 };
    existing.invoiceCount += 1;
    existing.revenue = round2(existing.revenue + totalsByInvoiceId.get(inv.id)!.grandTotal * invoiceSign(inv));
    byStaff.set(key, existing);
  }
  const rows = Array.from(byStaff.values()).sort((a, b) => b.revenue - a.revenue);
  return { rows, totalRevenue: round2(rows.reduce((s, r) => s + r.revenue, 0)) };
}

export interface PosShiftSummaryRow { id: string; date: string; cashier: string; status: string; startCash: number; endCash: number; expectedCash: number; variance: number; totalSales: number; saleCount: number; }
// Ports getPosShiftSummaryData (~200-215).
export async function computePosShiftSummary(executor: any, companyId: string, startDate: string, endDate: string, opts: ReportScopeOpts): Promise<{ rows: PosShiftSummaryRow[]; totalSales: number }> {
  const branchOk = makeBranchOk(opts.branchIds);
  const allShifts = await executor.select().from(schema.posShifts).where(eq(schema.posShifts.companyId, companyId));
  const shifts = allShifts.filter(s => {
    const d = s.startTime.toISOString().slice(0, 10);
    return d >= startDate && d <= endDate && branchOk(s.branchId);
  });
  if (shifts.length === 0) return { rows: [], totalSales: 0 };
  const shiftIds = shifts.map(s => s.id);
  const shiftInvoices = (await executor.select().from(schema.invoices).where(and(
    eq(schema.invoices.companyId, companyId), eq(schema.invoices.isPosSale, true), eq(schema.invoices.status, 'Active'),
    inArray(schema.invoices.shiftId, shiftIds),
  )));
  const totalsByInvoiceId = await computeInvoiceTotalsMap(executor, shiftInvoices);
  const invoicesByShiftId = new Map<string, typeof shiftInvoices>();
  for (const inv of shiftInvoices) {
    if (!inv.shiftId) continue;
    if (!invoicesByShiftId.has(inv.shiftId)) invoicesByShiftId.set(inv.shiftId, []);
    invoicesByShiftId.get(inv.shiftId)!.push(inv);
  }
  const userIds = Array.from(new Set(shifts.map(s => s.userId))) as string[];
  const users: any[] = userIds.length ? await executor.select({ id: schema.users.id, username: schema.users.username }).from(schema.users).where(inArray(schema.users.id, userIds)) : [];
  const usernameById = new Map(users.map(u => [u.id, u.username]));
  const rows: PosShiftSummaryRow[] = shifts.map(s => {
    const invs = invoicesByShiftId.get(s.id) || [];
    const totalSales = round2(invs.reduce((sum, inv) => sum + totalsByInvoiceId.get(inv.id)!.grandTotal, 0));
    return {
      id: s.id, date: s.startTime.toISOString().slice(0, 10), cashier: usernameById.get(s.userId) || 'Unknown',
      status: s.status, startCash: Number(s.startCash), endCash: Number(s.endCash || 0), expectedCash: Number(s.expectedCash || 0),
      variance: round2(Number(s.endCash || 0) - Number(s.expectedCash || 0)), totalSales, saleCount: invs.length,
    };
  }).sort((a, b) => a.date.localeCompare(b.date));
  return { rows, totalSales: round2(rows.reduce((s, r) => s + r.totalSales, 0)) };
}

// --- Purchase reports (PurchaseReportsModule.tsx) -----------------------------

export interface PurchaseRegisterRow { expenseNumber: string; date: string; vendorName: string; status: string; paymentStatus: string; totalAmount: number; }
// Ports PurchaseReportsModule.tsx's getPurchaseRegisterData.
export async function computePurchaseRegister(executor: any, companyId: string, startDate: string, endDate: string, vendorId: string | 'ALL', opts: ReportScopeOpts): Promise<{ rows: PurchaseRegisterRow[]; totalAmount: number }> {
  const branchOk = makeBranchOk(opts.branchIds);
  const expensesInRange = await executor.select().from(schema.expenses).where(and(
    eq(schema.expenses.companyId, companyId), gte(schema.expenses.date, startDate), lte(schema.expenses.date, endDate),
  ));
  const filtered = expensesInRange.filter(exp => branchOk(exp.branchId) && (vendorId === 'ALL' || exp.vendorId === vendorId));
  const vendorIds = Array.from(new Set(filtered.map(e => e.vendorId).filter(Boolean))) as string[];
  const vendors = vendorIds.length ? await executor.select().from(schema.vendors).where(inArray(schema.vendors.id, vendorIds)) : [];
  const vendorNameById = new Map(vendors.map(v => [v.id, v.name]));
  const rows: PurchaseRegisterRow[] = filtered
    .map(exp => ({ expenseNumber: exp.expenseNumber, date: exp.date, vendorName: vendorNameById.get(exp.vendorId) || 'Vendor', status: exp.status, paymentStatus: exp.paymentStatus, totalAmount: Number(exp.amount) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const totalAmount = round2(rows.filter(r => r.status === 'Active').reduce((s, r) => s + r.totalAmount, 0));
  return { rows, totalAmount };
}

// Ports PurchaseReportsModule.tsx's getVendorStatementData — combines both purchasing
// paths this app has (simple Expenses AND the full PR->PO->GRN->Purchase Bill flow's own
// bills), since a vendor's real obligation spans both; payment vouchers reference either
// 'Expense' or 'PurchaseBill'. purchaseBills is NOT one of the 5 capped tables (it was
// always unbounded in src/db/apiState.ts), but this still moves it server-side for the
// same no-artificial-limit consistency as everything else in this file.
export async function computeVendorStatement(executor: any, companyId: string, vendorId: string, opts: ReportScopeOpts): Promise<{ entries: StatementEntry[]; endingBalance: number; vendorName: string }> {
  if (!vendorId) return { entries: [], endingBalance: 0, vendorName: '' };
  const branchOk = makeBranchOk(opts.branchIds);
  const [vendor] = await executor.select().from(schema.vendors).where(eq(schema.vendors.id, vendorId));
  const vendExpenses = (await executor.select().from(schema.expenses).where(and(
    eq(schema.expenses.companyId, companyId), eq(schema.expenses.vendorId, vendorId), eq(schema.expenses.status, 'Active'),
  ))).filter(exp => branchOk(exp.branchId));
  const vendBills = (await executor.select().from(schema.purchaseBills).where(and(
    eq(schema.purchaseBills.companyId, companyId), eq(schema.purchaseBills.vendorId, vendorId), ne(schema.purchaseBills.status, 'Cancelled'),
  ))).filter(b => branchOk(b.branchId));
  const expenseIds = vendExpenses.map(e => e.id);
  const billIds = vendBills.map(b => b.id);
  const referenceIds = [...expenseIds, ...billIds];
  const payments = referenceIds.length ? (await executor.select().from(schema.vouchers).where(and(
    eq(schema.vouchers.companyId, companyId), eq(schema.vouchers.type, 'Payment'),
    inArray(schema.vouchers.referenceType, ['Expense', 'PurchaseBill']), inArray(schema.vouchers.referenceId, referenceIds),
  ))).filter(v => branchOk(v.branchId)) : [];

  // Expense/Bill = debit (increases what the company owes this vendor); Payment = credit
  // (reduces it) — the reverse of computeCustomerStatement's convention, matching the
  // original client code's own debit/credit assignment exactly (getVendorStatementData).
  const entries: Omit<StatementEntry, 'runningBalance'>[] = vendExpenses.map(exp => ({ date: exp.date, type: 'Expense', docNumber: exp.expenseNumber, debit: Number(exp.amount), credit: 0 }));
  for (const b of vendBills) entries.push({ date: b.date.toISOString().slice(0, 10), type: 'Purchase Bill', docNumber: b.billNumber, debit: Number(b.grandTotal), credit: 0 });
  for (const v of payments) entries.push({ date: v.date, type: 'Payment', docNumber: v.voucherNumber, debit: 0, credit: Number(v.amount) });
  entries.sort((a, b) => a.date.localeCompare(b.date));

  let running = 0;
  const withBalance: StatementEntry[] = entries.map(e => {
    running = round2(running + e.debit - e.credit);
    return { ...e, runningBalance: running };
  });
  return { entries: withBalance, endingBalance: running, vendorName: vendor?.name || '' };
}

// --- List-screen KPI cards (InvoiceModule.tsx / QuotationModule.tsx) ----------

// Ports InvoiceModule.tsx's kpiTotalInvoiced/kpiTotalCollected.
export interface InvoiceKpiFilters {
  startDate?: string; endDate?: string;
  status?: 'All' | 'Unpaid';
  zatcaStatus?: string; // 'All' | 'CLEARED_REPORTED' | 'PENDING' | 'REJECTED_ERROR' | 'NOT_SUBMITTED'
  docType?: 'All' | 'Invoice' | 'CreditNote' | 'DebitNote';
  origin?: 'All' | 'POS' | 'Manual'; // matches InvoiceModule.tsx's own filterOrigin
  restrictToUserId?: string | null; // set when the caller lacks invoice.read (own documents only)
}
// Ports InvoiceModule.tsx's kpiTotalInvoiced/kpiTotalCollected (~589-599) over the SAME
// filter surface as the list itself (filterStartDate/filterEndDate/filterStatus/
// filterZatcaStatus/filterDocType) — these KPI cards reflect "what you're currently
// viewing," not a fixed company-wide total, so the endpoint has to accept the same
// filters rather than always summing everything. Two real bugs fixed while porting,
// not preserved: (1) the original never applied invoiceSign, so a Credit Note (a
// reduction, but positive-valued on its own document — see CLAUDE.md's ZATCA section)
// silently INFLATED "Total Invoiced" instead of reducing it — the same bug class
// dbStore.ts's getInvoiceSign comment documents as already fixed in Dashboard/
// ReportViewer/SalesReportsModule, just missed here; (2) "Total Collected" only ever
// used it for a Paid invoice's own believed-full amount).
export async function computeInvoiceKpis(executor: any, companyId: string, filters: InvoiceKpiFilters, opts: ReportScopeOpts): Promise<{ totalInvoiced: number; totalCollected: number }> {
  const branchOk = makeBranchOk(opts.branchIds);
  const conditions = [eq(schema.invoices.companyId, companyId)];
  if (filters.startDate) conditions.push(gte(schema.invoices.date, filters.startDate));
  if (filters.endDate) conditions.push(lte(schema.invoices.date, filters.endDate));
  const candidates = (await executor.select().from(schema.invoices).where(and(...conditions))).filter(inv => {
    if (!branchOk(inv.branchId)) return false;
    if (filters.restrictToUserId && inv.createdById !== filters.restrictToUserId) return false;
    if (filters.status === 'Unpaid' && (inv.paymentStatus === 'Paid' || inv.status !== 'Active')) return false;
    if (filters.zatcaStatus && filters.zatcaStatus !== 'All') {
      const z = inv.zatcaStatus || 'NOT_SUBMITTED';
      if (filters.zatcaStatus === 'CLEARED_REPORTED' && z !== 'CLEARED' && z !== 'REPORTED') return false;
      if (filters.zatcaStatus === 'PENDING' && z !== 'PENDING') return false;
      if (filters.zatcaStatus === 'REJECTED_ERROR' && z !== 'REJECTED' && z !== 'ERROR') return false;
      if (filters.zatcaStatus === 'NOT_SUBMITTED' && z !== 'NOT_SUBMITTED') return false;
    }
    if (filters.docType && filters.docType !== 'All' && (inv.documentType || 'Invoice') !== filters.docType) return false;
    if (filters.origin === 'POS' && !inv.isPosSale) return false;
    if (filters.origin === 'Manual' && inv.isPosSale) return false;
    return true;
  });
  // KPI cards only ever count Active documents, same as activeInvoices in the original.
  const activeInvoices = candidates.filter(inv => inv.status === 'Active');
  const totalsByInvoiceId = await computeInvoiceTotalsMap(executor, activeInvoices);
  let totalInvoiced = 0;
  let totalCollected = 0;
  for (const inv of activeInvoices) {
    const sign = invoiceSign(inv);
    const grandTotal = totalsByInvoiceId.get(inv.id)!.grandTotal;
    totalInvoiced = round2(totalInvoiced + grandTotal * sign);
    const collectedForThisInvoice = inv.paymentStatus === 'Paid' ? grandTotal : Number(inv.amountPaid || 0);
    totalCollected = round2(totalCollected + collectedForThisInvoice * sign);
  }
  return { totalInvoiced, totalCollected };
}

// Ports QuotationModule.tsx's kpiTotalValue/kpiConvertedValue.
export async function computeQuotationKpis(executor: any, companyId: string, opts: ReportScopeOpts & { restrictToUserId?: string | null }): Promise<{ totalValue: number; convertedValue: number }> {
  const branchOk = makeBranchOk(opts.branchIds);
  const quotationsAll = (await executor.select().from(schema.quotations).where(eq(schema.quotations.companyId, companyId)))
    .filter(q => branchOk(q.branchId) && !q.isCancelled && (!opts.restrictToUserId || q.createdById === opts.restrictToUserId));
  if (quotationsAll.length === 0) return { totalValue: 0, convertedValue: 0 };
  const quotationIds = quotationsAll.map(q => q.id);
  const items = await executor.select().from(schema.quotationItems).where(inArray(schema.quotationItems.quotationId, quotationIds));
  const itemsByQuotationId = new Map<string, typeof items>();
  for (const item of items) {
    if (!itemsByQuotationId.has(item.quotationId)) itemsByQuotationId.set(item.quotationId, []);
    itemsByQuotationId.get(item.quotationId)!.push(item);
  }
  const taxSlabIds = Array.from(new Set(quotationsAll.map(q => q.taxSlabId).filter(Boolean))) as string[];
  const taxSlabRows: any[] = taxSlabIds.length ? await executor.select().from(schema.taxSlabs).where(inArray(schema.taxSlabs.id, taxSlabIds)) : [];
  const percentageById = new Map(taxSlabRows.map(s => [s.id, Number(s.percentage)]));
  let totalValue = 0;
  let convertedValue = 0;
  for (const q of quotationsAll) {
    const qItems = itemsByQuotationId.get(q.id) || [];
    const headerPercentage = q.taxSlabId && percentageById.has(q.taxSlabId) ? percentageById.get(q.taxSlabId)! : 0;
    const totals = computeInvoiceServerTotals(qItems as any, headerPercentage, Number(q.discountPercentage || 0), percentageById);
    totalValue = round2(totalValue + totals.grandTotal);
    if (q.status === 'Converted') convertedValue = round2(convertedValue + totals.grandTotal);
  }
  return { totalValue, convertedValue };
}

// Ports AdminSettings.tsx's Equity tab per-investor currentTotalContributed — batched
// (one query for every investor) rather than N+1 client-side calls per investor row.
export async function computeInvestorContributions(executor: any, companyId: string): Promise<Array<{ investorId: string; totalContributed: number }>> {
  const investors = await executor.select({ id: schema.investors.id }).from(schema.investors).where(eq(schema.investors.companyId, companyId));
  if (investors.length === 0) return [];
  const investorIds = investors.map(i => i.id);
  const vouchers = await executor.select().from(schema.vouchers).where(and(
    eq(schema.vouchers.companyId, companyId), eq(schema.vouchers.referenceType, 'Equity'), inArray(schema.vouchers.referenceId, investorIds),
  ));
  const totalByInvestorId = new Map<string, number>();
  for (const v of vouchers) totalByInvestorId.set(v.referenceId, round2((totalByInvestorId.get(v.referenceId) || 0) + Number(v.amount)));
  return investors.map(i => ({ investorId: i.id, totalContributed: totalByInvestorId.get(i.id) || 0 }));
}

// --- Inventory reports (InventoryReportsModule.tsx) ---------------------------
// Ported from InventoryReportsModule.tsx's own getXxxData functions, which computed all
// six of these entirely client-side from /api/state (db.inventoryStocks/
// stockLedgerTransactions/etc) — the exact violation this file's own top comment warns
// about, compounded here by /api/state's own row caps and by several Inventory write
// paths (see InventoryModule.tsx's handleCreateGrn) never refreshing client state after a
// write, so the report could silently disagree with the real ledger. All six queries below
// are company-scoped with no row cap, same convention as every other function in this file.
// Quantities throughout are always base-unit terms (inventoryStocks/stockLedgerTransactions
// never store anything else) — a negative on-hand quantity is a legitimate oversold/timing
// state (see businessLogic.ts's deductStockForSale) and is deliberately NOT filtered out
// here, only an exact-zero quantity is, since zero carries no information for a valuation
// or movement report.

export interface StockValuationRow { productName: string; warehouseName: string; quantity: number; unitCost: number; value: number; }
export async function computeStockValuation(executor: any, companyId: string, warehouseId: string | 'ALL', opts: ReportScopeOpts): Promise<{ rows: StockValuationRow[]; totalValue: number }> {
  const branchOk = makeBranchOk(opts.branchIds);
  const warehouseRows = await executor.select().from(schema.warehouses).where(eq(schema.warehouses.companyId, companyId));
  const warehouseById = new Map<string, any>(warehouseRows.map((w: any) => [w.id, w]));
  const stocks = (await executor.select().from(schema.inventoryStocks).where(eq(schema.inventoryStocks.companyId, companyId)))
    .filter(s => Number(s.quantity) !== 0 && warehouseById.has(s.warehouseId) && branchOk(warehouseById.get(s.warehouseId).branchId)
      && (warehouseId === 'ALL' || s.warehouseId === warehouseId));
  if (stocks.length === 0) return { rows: [], totalValue: 0 };
  const productIds = Array.from(new Set(stocks.map((s: any) => s.productId))) as string[];
  const productRows = await executor.select().from(schema.productsServices).where(inArray(schema.productsServices.id, productIds));
  const productById = new Map<string, any>(productRows.map((p: any) => [p.id, p]));
  const rows: StockValuationRow[] = stocks.map((s: any) => {
    const product = productById.get(s.productId);
    const warehouse = warehouseById.get(s.warehouseId);
    const cost = product ? Number(product.averageCost || 0) : 0;
    const quantity = Number(s.quantity);
    return { productName: product?.name || '', warehouseName: warehouse?.name || '', quantity, unitCost: cost, value: round2(quantity * cost) };
  }).sort((a, b) => b.value - a.value);
  return { rows, totalValue: round2(rows.reduce((sum, r) => sum + r.value, 0)) };
}

export interface ItemProfitabilityRow { productName: string; totalQuantitySold: number; averageCost: number; averageSalePrice: number; marginAmount: number; marginPct: number; }
export async function computeItemProfitability(executor: any, companyId: string): Promise<{ rows: ItemProfitabilityRow[] }> {
  // Company-wide only — averageCost/averageSalePrice are tracked per-product company-wide,
  // not per-warehouse/branch, same reasoning InventoryReportsModule.tsx's own comment gave
  // for hiding the branch filter on this one report.
  const products = (await executor.select().from(schema.productsServices).where(eq(schema.productsServices.companyId, companyId)))
    .filter((p: any) => Number(p.totalQuantitySold || 0) > 0);
  const rows: ItemProfitabilityRow[] = products.map((p: any) => {
    const avgCost = Number(p.averageCost || 0);
    const avgSale = Number(p.averageSalePrice || 0);
    const marginAmount = round2(avgSale - avgCost);
    const marginPct = avgSale > 0 ? round2((marginAmount / avgSale) * 100) : 0;
    return { productName: p.name, totalQuantitySold: Number(p.totalQuantitySold || 0), averageCost: avgCost, averageSalePrice: avgSale, marginAmount, marginPct };
  }).sort((a, b) => b.marginAmount - a.marginAmount);
  return { rows };
}

export interface LowStockRow { productName: string; warehouseName: string; onHand: number; minLevel: number; shortfall: number; }
export async function computeLowStock(executor: any, companyId: string, warehouseId: string | 'ALL', opts: ReportScopeOpts): Promise<{ rows: LowStockRow[] }> {
  const branchOk = makeBranchOk(opts.branchIds);
  const warehouseRows = await executor.select().from(schema.warehouses).where(eq(schema.warehouses.companyId, companyId));
  const warehouseById = new Map<string, any>(warehouseRows.map((w: any) => [w.id, w]));
  const links = (await executor.select().from(schema.productWarehouses).where(eq(schema.productWarehouses.companyId, companyId)))
    .filter((pw: any) => warehouseById.has(pw.warehouseId) && branchOk(warehouseById.get(pw.warehouseId).branchId)
      && (warehouseId === 'ALL' || pw.warehouseId === warehouseId) && Number(pw.minLevel || 0) > 0);
  if (links.length === 0) return { rows: [] };
  const productIds = Array.from(new Set(links.map((l: any) => l.productId))) as string[];
  const productRows = await executor.select().from(schema.productsServices).where(inArray(schema.productsServices.id, productIds));
  const productById = new Map<string, any>(productRows.map((p: any) => [p.id, p]));
  const stocks = await executor.select().from(schema.inventoryStocks).where(and(eq(schema.inventoryStocks.companyId, companyId), inArray(schema.inventoryStocks.productId, productIds)));
  const rows: LowStockRow[] = links.map((pw: any) => {
    const stock = stocks.find((s: any) => s.productId === pw.productId && s.warehouseId === pw.warehouseId);
    const onHand = stock ? Number(stock.quantity) : 0;
    const product = productById.get(pw.productId);
    const warehouse = warehouseById.get(pw.warehouseId);
    return { productName: product?.name || '', warehouseName: warehouse?.name || '', onHand, minLevel: Number(pw.minLevel), shortfall: round2(Number(pw.minLevel) - onHand) };
  }).filter(r => r.shortfall > 0).sort((a, b) => b.shortfall - a.shortfall);
  return { rows };
}

export interface StockTakeVarianceRow { referenceNumber: string; date: string; warehouseName: string; productName: string; systemQuantity: number; physicalQuantity: number; variance: number; }
export async function computeStockTakeVarianceHistory(executor: any, companyId: string, startDate: string, endDate: string, warehouseId: string | 'ALL', opts: ReportScopeOpts): Promise<{ rows: StockTakeVarianceRow[] }> {
  const branchOk = makeBranchOk(opts.branchIds);
  const warehouseRows = await executor.select().from(schema.warehouses).where(eq(schema.warehouses.companyId, companyId));
  const warehouseById = new Map<string, any>(warehouseRows.map((w: any) => [w.id, w]));
  const rangeStart = new Date(startDate + 'T00:00:00.000Z');
  const rangeEndExclusive = new Date(new Date(endDate + 'T00:00:00.000Z').getTime() + 86400000);
  const takes = (await executor.select().from(schema.physicalStockTakes).where(and(
    eq(schema.physicalStockTakes.companyId, companyId), eq(schema.physicalStockTakes.status, 'Completed'),
    gte(schema.physicalStockTakes.date, rangeStart), lt(schema.physicalStockTakes.date, rangeEndExclusive),
  ))).filter((st: any) => warehouseById.has(st.warehouseId) && branchOk(warehouseById.get(st.warehouseId).branchId)
    && (warehouseId === 'ALL' || st.warehouseId === warehouseId));
  if (takes.length === 0) return { rows: [] };
  const takeIds = takes.map((st: any) => st.id);
  const items = await executor.select().from(schema.physicalStockTakeItems).where(inArray(schema.physicalStockTakeItems.stockTakeId, takeIds));
  const productIds = Array.from(new Set(items.map((i: any) => i.productId))) as string[];
  const productRows = productIds.length ? await executor.select().from(schema.productsServices).where(inArray(schema.productsServices.id, productIds)) : [];
  const productById = new Map<string, any>(productRows.map((p: any) => [p.id, p]));
  const takeById = new Map<string, any>(takes.map((st: any) => [st.id, st]));
  const rows: StockTakeVarianceRow[] = [];
  for (const item of items) {
    if (Number(item.variance) === 0) continue;
    const take = takeById.get(item.stockTakeId);
    if (!take) continue;
    const warehouse = warehouseById.get(take.warehouseId);
    const product = productById.get(item.productId);
    rows.push({
      referenceNumber: take.referenceNumber, date: take.date.toISOString().slice(0, 10), warehouseName: warehouse?.name || '',
      productName: product?.name || '', systemQuantity: Number(item.systemQuantity), physicalQuantity: Number(item.physicalQuantity), variance: Number(item.variance),
    });
  }
  return { rows: rows.sort((a, b) => a.date.localeCompare(b.date)) };
}

export interface StockMovementLedgerRow { date: string; productName: string; warehouseName: string; transactionType: string; quantityChange: number; endingQuantity: number; batchNumber: string; referenceNumber: string; }
// referenceId is polymorphic (see stockLedgerTransactions' own schema comment) — which
// table it points into depends entirely on transactionType. 'Sale' covers both a real
// invoice/POS deduction AND a Credit-Note/cancellation reversal (see
// restockForSaleReversal's comment in businessLogic.ts) — both are rows in `invoices`, so
// one lookup covers both; the invoice's own documentType ('Invoice' vs 'CreditNote') is
// what actually distinguishes them for the reader, not a different referenceId table.
// 'Adjustment' has no backing document at all (stock-adjustments route never persists its
// own record, just this ledger row) — referenceNumber stays blank for it, not a bug.
async function resolveStockLedgerReferenceNumbers(executor: any, rows0: any[]): Promise<Map<string, string>> {
  const idsByType = new Map<string, Set<string>>();
  for (const r of rows0) {
    if (!idsByType.has(r.transactionType)) idsByType.set(r.transactionType, new Set());
    idsByType.get(r.transactionType)!.add(r.referenceId);
  }
  const numberById = new Map<string, string>();
  const salesIds = Array.from(idsByType.get('Sale') || []);
  if (salesIds.length) {
    const invs = await executor.select({ id: schema.invoices.id, invoiceNumber: schema.invoices.invoiceNumber }).from(schema.invoices).where(inArray(schema.invoices.id, salesIds));
    for (const inv of invs) numberById.set(inv.id, inv.invoiceNumber);
  }
  const grnIds = Array.from(idsByType.get('GRN') || []);
  if (grnIds.length) {
    const grns = await executor.select({ id: schema.goodsReceiptNotes.id, grnNumber: schema.goodsReceiptNotes.grnNumber }).from(schema.goodsReceiptNotes).where(inArray(schema.goodsReceiptNotes.id, grnIds));
    for (const g of grns) numberById.set(g.id, g.grnNumber);
  }
  const returnIds = Array.from(idsByType.get('Return') || []);
  if (returnIds.length) {
    const rets = await executor.select({ id: schema.purchaseReturns.id, returnNumber: schema.purchaseReturns.returnNumber }).from(schema.purchaseReturns).where(inArray(schema.purchaseReturns.id, returnIds));
    for (const r of rets) numberById.set(r.id, r.returnNumber);
  }
  const stockTakeIds = Array.from(idsByType.get('StockTake') || []);
  if (stockTakeIds.length) {
    const takes = await executor.select({ id: schema.physicalStockTakes.id, referenceNumber: schema.physicalStockTakes.referenceNumber }).from(schema.physicalStockTakes).where(inArray(schema.physicalStockTakes.id, stockTakeIds));
    for (const st of takes) numberById.set(st.id, st.referenceNumber);
  }
  const dispatchIds = Array.from(idsByType.get('TransferOut') || []);
  if (dispatchIds.length) {
    const dispatches = await executor.select({ id: schema.warehouseDispatches.id, dispatchNumber: schema.warehouseDispatches.dispatchNumber }).from(schema.warehouseDispatches).where(inArray(schema.warehouseDispatches.id, dispatchIds));
    for (const d of dispatches) numberById.set(d.id, d.dispatchNumber);
  }
  const receivingIds = Array.from(idsByType.get('TransferIn') || []);
  if (receivingIds.length) {
    const receivings = await executor.select({ id: schema.warehouseReceivings.id, receivingNumber: schema.warehouseReceivings.receivingNumber }).from(schema.warehouseReceivings).where(inArray(schema.warehouseReceivings.id, receivingIds));
    for (const rcv of receivings) numberById.set(rcv.id, rcv.receivingNumber);
  }
  return numberById;
}

// The one report that reads a raw, ever-growing table (every stock movement ever posted), so
// unlike the other reports it filters AND pages in SQL: only the requested page's rows are
// ever loaded. `page` omitted = every row (print/export), refused above maxRows so a single
// request can never try to materialise an unbounded ledger.
export async function computeStockMovementLedger(
  executor: any, companyId: string, startDate: string, endDate: string, warehouseId: string | 'ALL', productId: string | 'ALL', opts: ReportScopeOpts,
  page?: { page: number; pageSize: number }, maxRows = 50000,
): Promise<{ rows: StockMovementLedgerRow[]; pagination?: { page: number; pageSize: number; totalRows: number; totalPages: number } }> {
  const branchOk = makeBranchOk(opts.branchIds);
  const start = new Date(startDate + 'T00:00:00.000Z');
  const endExclusive = new Date(new Date(endDate + 'T00:00:00.000Z').getTime() + 86400000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(endExclusive.getTime())) {
    const err: any = new Error('startDate and endDate must be valid dates (YYYY-MM-DD).');
    err.status = 400;
    throw err;
  }
  const warehouseRows = await executor.select().from(schema.warehouses).where(eq(schema.warehouses.companyId, companyId));
  const warehouseById = new Map<string, any>(warehouseRows.map((w: any) => [w.id, w]));
  const allowedWarehouseIds = warehouseRows.filter((w: any) => branchOk(w.branchId)).map((w: any) => w.id) as string[];
  const scopedWarehouseIds = warehouseId === 'ALL' ? allowedWarehouseIds : allowedWarehouseIds.filter(id => id === warehouseId);
  if (scopedWarehouseIds.length === 0) return { rows: [], ...(page ? { pagination: { page: 1, pageSize: page.pageSize, totalRows: 0, totalPages: 1 } } : {}) };

  const conditions = [
    eq(schema.stockLedgerTransactions.companyId, companyId),
    inArray(schema.stockLedgerTransactions.warehouseId, scopedWarehouseIds),
    gte(schema.stockLedgerTransactions.date, start),
    lt(schema.stockLedgerTransactions.date, endExclusive),
    ...(productId !== 'ALL' ? [eq(schema.stockLedgerTransactions.productId, productId)] : []),
  ];
  const [{ count }] = await executor.select({ count: sql<number>`count(*)::int` }).from(schema.stockLedgerTransactions).where(and(...conditions));
  const totalRows = Number(count) || 0;
  if (!page && totalRows > maxRows) {
    const err: any = new Error(`This ledger has ${totalRows} movements — too many to print at once. Narrow the dates, warehouse or product and try again.`);
    err.status = 413;
    throw err;
  }
  const totalPages = page ? Math.max(1, Math.ceil(totalRows / page.pageSize)) : 1;
  const safePage = page ? Math.min(page.page, totalPages) : 1;
  let query = executor.select().from(schema.stockLedgerTransactions).where(and(...conditions))
    .orderBy(asc(schema.stockLedgerTransactions.date), asc(schema.stockLedgerTransactions.id));
  if (page) query = query.limit(page.pageSize).offset((safePage - 1) * page.pageSize);
  const rows0: any[] = await query;
  const pagination = page ? { page: safePage, pageSize: page.pageSize, totalRows, totalPages } : undefined;
  if (rows0.length === 0) return { rows: [], ...(pagination ? { pagination } : {}) };

  const productIds = Array.from(new Set(rows0.map((r: any) => r.productId))) as string[];
  const productRows = await executor.select().from(schema.productsServices).where(inArray(schema.productsServices.id, productIds));
  const productById = new Map<string, any>(productRows.map((p: any) => [p.id, p]));
  const referenceNumberById = await resolveStockLedgerReferenceNumbers(executor, rows0);
  const rows: StockMovementLedgerRow[] = rows0.map((slt: any) => {
    const product = productById.get(slt.productId);
    const warehouse = warehouseById.get(slt.warehouseId);
    return {
      date: slt.date.toISOString(), productName: product?.name || '', warehouseName: warehouse?.name || '',
      transactionType: slt.transactionType, quantityChange: Number(slt.quantityChange), endingQuantity: Number(slt.endingQuantity), batchNumber: slt.batchNumber || '',
      referenceNumber: referenceNumberById.get(slt.referenceId) || '',
    };
  });
  return { rows, ...(pagination ? { pagination } : {}) };
}

export interface WarehouseTransferReconciliationRow {
  dispatchNumber: string; date: string; fromWarehouseName: string; toWarehouseName: string; productName: string; batchNumber: string;
  quantityDispatched: number; receivingNumber: string | null; quantityReceived: number | null; variance: number | null;
  status: 'Pending' | 'Matched' | 'Short' | 'Over' | 'Cancelled'; daysInTransit: number | null;
}
export async function computeWarehouseTransferReconciliation(executor: any, companyId: string, startDate: string, endDate: string, warehouseId: string | 'ALL', pendingOnly: boolean, opts: ReportScopeOpts): Promise<{ rows: WarehouseTransferReconciliationRow[] }> {
  const branchOk = makeBranchOk(opts.branchIds);
  const allWarehouses = await executor.select().from(schema.warehouses).where(eq(schema.warehouses.companyId, companyId));
  const branchOkWarehouseIds = new Set(allWarehouses.filter((w: any) => branchOk(w.branchId)).map((w: any) => w.id));
  const warehouseById = new Map<string, any>(allWarehouses.map((w: any) => [w.id, w]));
  const dispatchRangeStart = new Date(startDate + 'T00:00:00.000Z');
  const dispatchRangeEndExclusive = new Date(new Date(endDate + 'T00:00:00.000Z').getTime() + 86400000);
  const dispatches = (await executor.select().from(schema.warehouseDispatches).where(and(
    eq(schema.warehouseDispatches.companyId, companyId),
    gte(schema.warehouseDispatches.date, dispatchRangeStart), lt(schema.warehouseDispatches.date, dispatchRangeEndExclusive),
  ))).filter((d: any) => (warehouseId === 'ALL' || d.fromWarehouseId === warehouseId || d.toWarehouseId === warehouseId)
    && (branchOkWarehouseIds.has(d.fromWarehouseId) || branchOkWarehouseIds.has(d.toWarehouseId)));
  if (dispatches.length === 0) return { rows: [] };
  const dispatchIds = dispatches.map((d: any) => d.id);
  const dispatchItems = await executor.select().from(schema.warehouseDispatchItems).where(inArray(schema.warehouseDispatchItems.dispatchId, dispatchIds));
  const receivings = await executor.select().from(schema.warehouseReceivings).where(inArray(schema.warehouseReceivings.dispatchId, dispatchIds));
  const receivingIds = receivings.map((r: any) => r.id);
  const receivingItems = receivingIds.length ? await executor.select().from(schema.warehouseReceivingItems).where(inArray(schema.warehouseReceivingItems.receivingId, receivingIds)) : [];
  const productIds = Array.from(new Set(dispatchItems.map((i: any) => i.productId))) as string[];
  const productRows = productIds.length ? await executor.select().from(schema.productsServices).where(inArray(schema.productsServices.id, productIds)) : [];
  const productById = new Map<string, any>(productRows.map((p: any) => [p.id, p]));
  const receivingByDispatchId = new Map<string, any>(receivings.map((r: any) => [r.dispatchId, r]));
  const rows: WarehouseTransferReconciliationRow[] = [];
  for (const d of dispatches) {
    const fromWh = warehouseById.get(d.fromWarehouseId);
    const toWh = warehouseById.get(d.toWarehouseId);
    const receiving = receivingByDispatchId.get(d.id);
    const itemsForDispatch = dispatchItems.filter((i: any) => i.dispatchId === d.id);
    for (const item of itemsForDispatch) {
      const product = productById.get(item.productId);
      const receivingItem = receiving ? receivingItems.find((ri: any) => ri.dispatchItemId === item.id) : undefined;
      const qtyDispatched = Number(item.quantityDispatched);
      const qtyReceived = receivingItem ? Number(receivingItem.quantityReceived) : null;
      const variance = qtyReceived !== null ? round2(qtyReceived - qtyDispatched) : null;
      let status: WarehouseTransferReconciliationRow['status'];
      if (d.status === 'Cancelled') status = 'Cancelled';
      else if (qtyReceived === null) status = 'Pending';
      else if (variance === 0) status = 'Matched';
      else if ((variance as number) < 0) status = 'Short';
      else status = 'Over';
      if (pendingOnly && status !== 'Pending') continue;
      const daysInTransit = status === 'Pending' ? Math.floor((Date.now() - new Date(d.date).getTime()) / (1000 * 60 * 60 * 24)) : null;
      rows.push({
        dispatchNumber: d.dispatchNumber, date: d.date.toISOString().slice(0, 10), fromWarehouseName: fromWh?.name || '', toWarehouseName: toWh?.name || '',
        productName: product?.name || '', batchNumber: item.batchNumber || '', quantityDispatched: qtyDispatched,
        receivingNumber: receiving?.receivingNumber || null, quantityReceived: qtyReceived, variance, status, daysInTransit,
      });
    }
  }
  return { rows: rows.sort((a, b) => a.date.localeCompare(b.date)) };
}

// --- Financial reports moved off the browser (ReportViewer.tsx) ---------------
// Sales VAT / Purchase VAT / Bank Ledger / Outstanding / VAT Return Summary / Investor
// Profit Share / Fiscal Month Closing History. All were computed client-side from
// /api/state's capped arrays; each is now company-scoped, uncapped, and branch-scoped via
// opts.branchIds. Row-listing ones return `rows` so the route can page them, with totals
// always over the FULL set.

export interface VatRegisterRow { documentNumber: string; date: string; partyName: string; vatNumber: string; subtotal: number; taxAmount: number; grandTotal: number; }
export interface VatRegisterResult { rows: VatRegisterRow[]; totals: { subtotal: number; taxAmount: number; grandTotal: number }; count: number; }

function sumVat(rows: VatRegisterRow[]) {
  let subtotal = 0, taxAmount = 0, grandTotal = 0;
  for (const r of rows) { subtotal = round2(subtotal + r.subtotal); taxAmount = round2(taxAmount + r.taxAmount); grandTotal = round2(grandTotal + r.grandTotal); }
  return { subtotal, taxAmount, grandTotal };
}

// A Credit Note is a signed (negative) line — a genuine reduction to output VAT.
export async function computeSalesVatRegister(executor: any, companyId: string, startDate: string, endDate: string, customerId: string | 'ALL', opts: ReportScopeOpts): Promise<VatRegisterResult> {
  const branchOk = makeBranchOk(opts.branchIds);
  const invs: any[] = await executor.select().from(schema.invoices).where(and(
    eq(schema.invoices.companyId, companyId), eq(schema.invoices.status, 'Active'),
    gte(schema.invoices.date, startDate), lte(schema.invoices.date, endDate),
  ));
  const filtered = invs.filter(inv => branchOk(inv.branchId) && (customerId === 'ALL' || inv.customerId === customerId));
  const totals = await computeInvoiceTotalsMap(executor, filtered);
  const custIds = Array.from(new Set(filtered.map(i => i.customerId).filter(Boolean))) as string[];
  const custs: any[] = custIds.length ? await executor.select().from(schema.customers).where(inArray(schema.customers.id, custIds)) : [];
  const custById = new Map<string, any>(custs.map(c => [c.id, c]));
  const rows: VatRegisterRow[] = filtered.map(inv => {
    const c = custById.get(inv.customerId); const t = totals.get(inv.id)!; const sign = invoiceSign(inv);
    return { documentNumber: inv.invoiceNumber, date: inv.date, partyName: c?.name || 'Walk-In', vatNumber: c?.vatNumber || 'N/A',
      subtotal: round2(t.discountedSubtotal * sign), taxAmount: round2(t.taxAmount * sign), grandTotal: round2(t.grandTotal * sign) };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.documentNumber.localeCompare(b.documentNumber));
  return { rows, totals: sumVat(rows), count: rows.length };
}

// Direct expenses don't carry a tax breakdown, so VAT is back-calculated from the slab.
export async function computePurchaseVatRegister(executor: any, companyId: string, startDate: string, endDate: string, vendorId: string | 'ALL', opts: ReportScopeOpts): Promise<VatRegisterResult> {
  const branchOk = makeBranchOk(opts.branchIds);
  const exps: any[] = await executor.select().from(schema.expenses).where(and(
    eq(schema.expenses.companyId, companyId), eq(schema.expenses.status, 'Active'),
    gte(schema.expenses.date, startDate), lte(schema.expenses.date, endDate),
  ));
  const filtered = exps.filter(e => branchOk(e.branchId) && (vendorId === 'ALL' || e.vendorId === vendorId));
  const slabs: any[] = await executor.select().from(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyId));
  const rateBySlab = new Map<string, number>(slabs.map(s => [s.id, Number(s.percentage)]));
  const vIds = Array.from(new Set(filtered.map(e => e.vendorId).filter(Boolean))) as string[];
  const vends: any[] = vIds.length ? await executor.select().from(schema.vendors).where(inArray(schema.vendors.id, vIds)) : [];
  const vendById = new Map<string, any>(vends.map(v => [v.id, v]));
  const rows: VatRegisterRow[] = filtered.map(e => {
    const rate = rateBySlab.get(e.taxSlabId) || 0; const amount = Number(e.amount);
    const subtotal = round2(amount / (1 + rate / 100)); const v = vendById.get(e.vendorId);
    return { documentNumber: e.expenseNumber, date: e.date, partyName: v?.name || 'Cash Vendor', vatNumber: v?.vatNumber || 'N/A',
      subtotal, taxAmount: round2(amount - subtotal), grandTotal: round2(amount) };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.documentNumber.localeCompare(b.documentNumber));
  return { rows, totals: sumVat(rows), count: rows.length };
}

export async function computeVatReturnSummary(executor: any, companyId: string, startDate: string, endDate: string, opts: ReportScopeOpts) {
  const sales = await computeSalesVatRegister(executor, companyId, startDate, endDate, 'ALL', opts);
  const purchases = await computePurchaseVatRegister(executor, companyId, startDate, endDate, 'ALL', opts);
  return { startDate, endDate, outputVat: sales.totals.taxAmount, inputVat: purchases.totals.taxAmount,
    netVatPayable: round2(sales.totals.taxAmount - purchases.totals.taxAmount), salesCount: sales.count, purchaseCount: purchases.count };
}

export interface BankLedgerRow { id: string; date: string; type: string; voucherNumber: string; description: string; debit: number; credit: number; runningBalance: number; bankId: string; bankName: string; sourceDoc: string; refType: 'Invoice' | 'Expense' | null; referenceId: string; }
function voucherEffect(v: { type: string; referenceType: string; amount: any }) {
  const amount = Number(v.amount);
  if (v.type === 'Receipt' || v.type === 'TransferIn') return { debit: amount, credit: 0 };
  if (v.type === 'Payment' || v.type === 'TransferOut') return { debit: 0, credit: amount };
  if (v.type === 'Reversal') return v.referenceType === 'Invoice' ? { debit: 0, credit: amount } : { debit: amount, credit: 0 };
  return { debit: 0, credit: 0 };
}
// Opening balance = bank opening balance + everything posted BEFORE startDate (the old
// in-browser version ignored earlier movements, so the running balance started wrong for
// any period after the first).
export async function computeBankLedger(executor: any, companyId: string, bankId: string | 'ALL', startDate: string, endDate: string, opts: ReportScopeOpts): Promise<{ rows: BankLedgerRow[]; bankName: string; openingBalance: number; endingBalance: number; totalDebit: number; totalCredit: number }> {
  const branchOk = makeBranchOk(opts.branchIds);
  const banks: any[] = await executor.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyId));
  const bankById = new Map<string, any>(banks.map(b => [b.id, b]));
  let bankName = 'All Banks Combined'; let opening = 0;
  if (bankId === 'ALL') opening = banks.reduce((s, b) => s + Number(b.openingBalance), 0);
  else {
    const b = bankById.get(bankId);
    if (!b) return { rows: [], bankName: '', openingBalance: 0, endingBalance: 0, totalDebit: 0, totalCredit: 0 };
    bankName = b.bankName; opening = Number(b.openingBalance);
  }
  const conds = [eq(schema.vouchers.companyId, companyId), lte(schema.vouchers.date, endDate)];
  if (bankId !== 'ALL') conds.push(eq(schema.vouchers.bankId, bankId));
  const vs: any[] = (await executor.select().from(schema.vouchers).where(and(...conds))).filter((v: any) => branchOk(v.branchId));
  vs.sort((a, b) => a.date.localeCompare(b.date) || new Date(a.createdAt).toISOString().localeCompare(new Date(b.createdAt).toISOString()));
  let running = opening;
  const inPeriod: any[] = [];
  for (const v of vs) {
    if (v.date < startDate) { const e = voucherEffect(v); running = round2(running + e.debit - e.credit); } else inPeriod.push(v);
  }
  const openingBalance = round2(running);
  const invIds = Array.from(new Set(inPeriod.filter(v => v.referenceType === 'Invoice').map(v => v.referenceId))) as string[];
  const expIds = Array.from(new Set(inPeriod.filter(v => v.referenceType === 'Expense').map(v => v.referenceId))) as string[];
  const invs: any[] = invIds.length ? await executor.select({ id: schema.invoices.id, n: schema.invoices.invoiceNumber }).from(schema.invoices).where(inArray(schema.invoices.id, invIds)) : [];
  const exps: any[] = expIds.length ? await executor.select({ id: schema.expenses.id, n: schema.expenses.expenseNumber }).from(schema.expenses).where(inArray(schema.expenses.id, expIds)) : [];
  const invNo = new Map<string, string>(invs.map(i => [i.id, i.n])); const expNo = new Map<string, string>(exps.map(e => [e.id, e.n]));
  let totalDebit = 0, totalCredit = 0;
  const rows: BankLedgerRow[] = inPeriod.map(v => {
    const e = voucherEffect(v); running = round2(running + e.debit - e.credit);
    totalDebit = round2(totalDebit + e.debit); totalCredit = round2(totalCredit + e.credit);
    let sourceDoc = '-'; let refType: 'Invoice' | 'Expense' | null = null;
    if (v.referenceType === 'Invoice' && invNo.has(v.referenceId)) { sourceDoc = invNo.get(v.referenceId)!; refType = 'Invoice'; }
    else if (v.referenceType === 'Expense' && expNo.has(v.referenceId)) { sourceDoc = expNo.get(v.referenceId)!; refType = 'Expense'; }
    return { id: v.id, date: v.date, type: v.type, voucherNumber: v.voucherNumber, description: v.description, debit: e.debit, credit: e.credit,
      runningBalance: running, bankId: v.bankId, bankName: bankById.get(v.bankId)?.bankName || 'Unknown', sourceDoc, refType, referenceId: v.referenceId };
  });
  return { rows, bankName, openingBalance, endingBalance: rows.length ? rows[rows.length - 1].runningBalance : openingBalance, totalDebit, totalCredit };
}

export interface OutstandingRow { id: string; type: 'Invoice' | 'Expense'; docNumber: string; date: string; contactName: string; total: number; paid: number; outstanding: number; paymentStatus: string; referenceId: string; }
// Credit Notes are never outstanding receivables, so excluded entirely.
export async function computeOutstanding(executor: any, companyId: string, startDate: string | null, endDate: string | null, customerId: string | 'ALL', vendorId: string | 'ALL', opts: ReportScopeOpts) {
  const branchOk = makeBranchOk(opts.branchIds);
  const inRange = (d: string) => (!startDate || d >= startDate) && (!endDate || d <= endDate);
  const invs: any[] = (await executor.select().from(schema.invoices).where(and(
    eq(schema.invoices.companyId, companyId), eq(schema.invoices.status, 'Active'), inArray(schema.invoices.paymentStatus, ['Unpaid', 'Partially Paid']),
  ))).filter((i: any) => i.documentType !== 'CreditNote' && branchOk(i.branchId) && inRange(i.date) && (customerId === 'ALL' || i.customerId === customerId));
  const totals = await computeInvoiceTotalsMap(executor, invs);
  const exps: any[] = (await executor.select().from(schema.expenses).where(and(
    eq(schema.expenses.companyId, companyId), eq(schema.expenses.status, 'Active'), inArray(schema.expenses.paymentStatus, ['Unpaid', 'Partially Paid']),
  ))).filter((e: any) => branchOk(e.branchId) && inRange(e.date) && (vendorId === 'ALL' || e.vendorId === vendorId));
  const cIds = Array.from(new Set(invs.map(i => i.customerId).filter(Boolean))) as string[];
  const vIds = Array.from(new Set(exps.map(e => e.vendorId).filter(Boolean))) as string[];
  const custs: any[] = cIds.length ? await executor.select().from(schema.customers).where(inArray(schema.customers.id, cIds)) : [];
  const vends: any[] = vIds.length ? await executor.select().from(schema.vendors).where(inArray(schema.vendors.id, vIds)) : [];
  const cName = new Map<string, string>(custs.map(c => [c.id, c.name])); const vName = new Map<string, string>(vends.map(v => [v.id, v.name]));
  const byDate = (a: OutstandingRow, b: OutstandingRow) => a.date.localeCompare(b.date) || a.docNumber.localeCompare(b.docNumber);
  const invRows: OutstandingRow[] = invs.map(i => {
    const total = totals.get(i.id)!.grandTotal; const paid = Number(i.amountPaid || 0);
    return { id: i.id, type: 'Invoice' as const, docNumber: i.invoiceNumber, date: i.date, contactName: cName.get(i.customerId) || 'Walk-In', total, paid, outstanding: round2(total - paid), paymentStatus: i.paymentStatus, referenceId: i.id };
  }).sort(byDate);
  const expRows: OutstandingRow[] = exps.map(e => {
    const total = Number(e.amount); const paid = Number(e.amountPaid || 0);
    return { id: e.id, type: 'Expense' as const, docNumber: e.expenseNumber, date: e.date, contactName: vName.get(e.vendorId) || 'Cash Vendor', total, paid, outstanding: round2(total - paid), paymentStatus: e.paymentStatus, referenceId: e.id };
  }).sort(byDate);
  const totalReceivable = round2(invRows.reduce((s, r) => s + r.outstanding, 0));
  const totalPayable = round2(expRows.reduce((s, r) => s + r.outstanding, 0));
  return { rows: [...invRows, ...expRows], invoiceCount: invRows.length, expenseCount: expRows.length, totalReceivable, totalPayable, netOutstanding: round2(totalReceivable - totalPayable) };
}

// Same per-investor split P&L computes inline, standalone.
export async function computeInvestorProfitShare(executor: any, companyId: string, startDate: string, endDate: string) {
  const pl = await computeProfitLoss(executor, companyId, startDate, endDate, 'Accrual');
  return { startDate, endDate, netProfit: pl.netProfit, investorShares: pl.investorShares };
}

export async function computeFiscalMonthClosingHistory(executor: any, companyId: string) {
  const ms: any[] = await executor.select().from(schema.fiscalMonths).where(and(eq(schema.fiscalMonths.companyId, companyId), eq(schema.fiscalMonths.status, 'Closed')));
  ms.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return { rows: ms.map(m => ({ id: m.id, name: m.name, closedAt: m.closedAt ? new Date(m.closedAt).toISOString() : null, closedPnL: m.closedPnL || null })) };
}
