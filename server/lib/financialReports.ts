import * as schema from '../../src/db/schema.js';
import { eq, and, gte, lte, ne, inArray } from 'drizzle-orm';
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
