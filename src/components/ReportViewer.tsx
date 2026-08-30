import React from 'react';
import { useTranslation, usePermissions } from '../hooks';
import { DatabaseState, calculateInvoiceTotals, getBankBalance, generateBankLedger, getInvoiceSign } from '../dbStore';
import {
 FileText,
 Calendar,
 Filter,
 TrendingUp,
 Printer,
 ChevronDown,
 ChevronUp,
 Percent,
 Layers,
 ArrowDownLeft,
 ArrowUpRight
} from 'lucide-react';

type ReportType = 'TrialBalance' | 'SalesVAT' | 'PurchaseVAT' | 'BankLedger' | 'Outstanding' | 'ProfitLoss'
  | 'BalanceSheet' | 'VatReturnSummary' | 'InvestorProfitShare' | 'FiscalMonthClosingHistory';

interface ReportViewerProps {
 db: DatabaseState;
 // Which report to show — set entirely by which of the six sidebar entries the user
 // clicked (App.tsx), same as InventoryModule's defaultTab prop for PR/PO/GRN/etc. There
 // is no in-page tab switcher anymore; navigation between reports happens in the sidebar.
 defaultReportType: ReportType;
 onPrintDoc: (type: 'Quotation' | 'Invoice' | 'Expense' | 'Voucher' | 'Report', data: any) => void;
}

// Each report is independently delegable (permissionSchema.ts's `reports` module) — a
// Sales Rep and an Accountant have genuinely different reasons to see different reports,
// which one shared 'reports.access' flag couldn't express. This is the one place that
// maps a report's UI id to its permission leaf; App.tsx's nav filtering and the
// print/render guard below both key off it, so they can never drift apart.
const REPORT_PERMISSION_KEYS: Record<ReportType, string> = {
  TrialBalance: 'reports.trialBalance',
  SalesVAT: 'reports.salesVat',
  PurchaseVAT: 'reports.purchaseVat',
  BankLedger: 'reports.bankLedger',
  ProfitLoss: 'reports.profitLoss',
  Outstanding: 'reports.outstanding',
  BalanceSheet: 'reports.balanceSheet',
  VatReturnSummary: 'reports.vatReturnSummary',
  InvestorProfitShare: 'reports.investorProfitShare',
  FiscalMonthClosingHistory: 'reports.fiscalMonthClosingHistory',
};

const REPORT_LABELS: Record<ReportType, string> = {
  TrialBalance: 'Trial Balance Ledger',
  SalesVAT: 'Sales VAT Register',
  PurchaseVAT: 'Purchase VAT Register',
  BankLedger: 'Bank Statement Ledger',
  ProfitLoss: 'Profit & Loss',
  Outstanding: 'Outstanding Aging & Balances',
  BalanceSheet: 'Balance Sheet',
  VatReturnSummary: 'VAT Return Summary',
  InvestorProfitShare: 'Investor Profit Share',
  FiscalMonthClosingHistory: 'Fiscal Month Closing History',
};

export default function ReportViewer({ db, defaultReportType, onPrintDoc }: ReportViewerProps) {
 const { t, isRTL, lang } = useTranslation(db);
 const { can } = usePermissions(db.currentUser);
 const [reportType, setReportType] = React.useState<ReportType>(defaultReportType);
 // Mirrors InventoryModule's "Automatically update activeSubTab if defaultTab changes"
 // effect — the sidebar is the only way to change which report is showing now.
 React.useEffect(() => {
   setReportType(defaultReportType);
 }, [defaultReportType]);
 const hasAccessToCurrentReport = can(REPORT_PERMISSION_KEYS[reportType]);
 const currencySymbol = db.companySetup?.currency || 'SAR';

 // The API caps invoices/expenses/vouchers/quotations at DEFAULT_LIST_LIMIT per list
 // (see server/lib/pagination.ts, currently 500). All reports below compute directly off
 // these arrays, so if any are sitting at the cap, totals may silently omit older records.
 const RECORD_LIST_CAP = 500;
 const isDataPossiblyTruncated = [db.invoices, db.expenses, db.vouchers, db.quotations]
 .some(list => Array.isArray(list) && list.length >= RECORD_LIST_CAP);

 // Universal Filter States
 const [startDate, setStartDate] = React.useState('2026-06-01');
 const [endDate, setEndDate] = React.useState('2026-06-30');
 const [accountingBasis, setAccountingBasis] = React.useState<'Accrual' | 'Cash'>('Accrual');
 const [selectedCustomerId, setSelectedCustomerId] = React.useState('ALL');
 const [selectedVendorId, setSelectedVendorId] = React.useState('ALL');
 const [selectedBankId, setSelectedBankId] = React.useState('');

 React.useEffect(() => {
 const activeBank = db.banks.find(b => b.companyId === db.selectedCompanyId && b.isActive) || db.banks.find(b => b.companyId === db.selectedCompanyId);
 if (activeBank) {
 setSelectedBankId(activeBank.id);
 } else if (db.banks[0]) {
 setSelectedBankId(db.banks[0].id);
 }
 }, [db.selectedCompanyId, db.banks]);

 // Column Sorting States
 const [sortField, setSortField] = React.useState<string>('date');
 const [sortOrder, setSortOrder] = React.useState<'asc' | 'desc'>('asc');

 const handleSort = (field: string) => {
 if (sortField === field) {
 setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
 } else {
 setSortField(field);
 setSortOrder('asc');
 }
 };

 const renderSortableHeader = (label: string, field: string, align: 'left' | 'center' | 'right' = 'left') => {
 const isCurrent = sortField === field;
 return (
 <th
 onClick={() => handleSort(field)}
 className={`p-3 cursor-pointer select-none hover:bg-slate-100 :bg-slate-800/50 transition-colors ${
 align === 'right' ? 'text-end' : align === 'center' ? 'text-center' : 'text-start'
 }`}
 >
 <div className={`flex items-center gap-1 ${
 align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start'
 }`}>
 <span>{label}</span>
 {isCurrent ? (
 sortOrder === 'asc' ? <ChevronUp className="w-3 h-3 text-indigo-600 inline" /> : <ChevronDown className="w-3 h-3 text-indigo-600 inline" />
 ) : (
 <ChevronDown className="w-3 h-3 text-slate-300 opacity-40 inline" />
 )}
 </div>
 </th>
 );
 };

 // Trial Balance calculation
 const getTrialBalance = () => {
 // 1. Bank Balances (Assets)
 const bankDetails = db.banks
 .filter(b => b.companyId === db.selectedCompanyId)
 .map(b => {
 const balance = getBankBalance(db, b.id);
 return {
 name: `Cash/Bank - ${b.bankName}`,
 debit: balance >= 0 ? balance : 0,
 credit: balance < 0 ? Math.abs(balance) : 0
 };
 });

 // 2. Sales Revenue (Credit)
 const totalSalesRev = db.invoices
 .filter(inv => inv.companyId === db.selectedCompanyId && inv.status === 'Active' && inv.date >= startDate && inv.date <= endDate)
 .reduce((sum, inv) => {
 const totals = calculateInvoiceTotals(db, inv.items, inv.taxSlabId, inv.discountPercentage);
 return sum + totals.subtotal * getInvoiceSign(inv); // revenue before tax
 }, 0);

 // 3. Purchase / Direct Expenses (Debit)
 const totalPurchaseExp = db.expenses
 .filter(exp => exp.companyId === db.selectedCompanyId && exp.status === 'Active' && exp.classification !== 'Asset' && exp.date >= startDate && exp.date <= endDate)
 .reduce((sum, exp) => sum + exp.amount, 0);

 // 3b. Capitalized Fixed Assets (Asset - Debit)
 const totalFixedAssets = db.expenses
 .filter(exp => exp.companyId === db.selectedCompanyId && exp.status === 'Active' && exp.classification === 'Asset' && exp.date >= startDate && exp.date <= endDate)
 .reduce((sum, exp) => sum + exp.amount, 0);

 // 4. Accounts Receivable (Asset - Debit) — a Credit Note's own paymentStatus is always
 // 'Unpaid' (it's not a receivable, that field is vestigial for this document type), so it
 // passes this same filter and must subtract here rather than add, or it inflates AR by
 // exactly what it's supposed to be reducing.
 const accountsReceivable = db.invoices
 .filter(inv => inv.companyId === db.selectedCompanyId && inv.status === 'Active' && inv.paymentStatus === 'Unpaid' && inv.date >= startDate && inv.date <= endDate)
 .reduce((sum, inv) => {
 const totals = calculateInvoiceTotals(db, inv.items, inv.taxSlabId, inv.discountPercentage);
 return sum + totals.grandTotal * getInvoiceSign(inv);
 }, 0);

 // 5. Accounts Payable (Liability - Credit)
 const accountsPayable = db.expenses
 .filter(exp => exp.companyId === db.selectedCompanyId && exp.status === 'Active' && exp.paymentStatus === 'Unpaid' && exp.date >= startDate && exp.date <= endDate)
 .reduce((sum, exp) => sum + exp.amount, 0);

 // 6. VAT Outputs Collected (Liability - Credit)
 const totalVATCollected = db.invoices
 .filter(inv => inv.companyId === db.selectedCompanyId && inv.status === 'Active' && inv.date >= startDate && inv.date <= endDate)
 .reduce((sum, inv) => {
 const totals = calculateInvoiceTotals(db, inv.items, inv.taxSlabId, inv.discountPercentage);
 return sum + totals.taxAmount * getInvoiceSign(inv);
 }, 0);

 // 7. Paid-in Capital (Equity - Credit)
 const totalCapital = db.vouchers
 .filter(v => v.companyId === db.selectedCompanyId && v.referenceType === 'Equity' && v.date >= startDate && v.date <= endDate)
 .reduce((sum, v) => sum + v.amount, 0);

 // Package trial balance ledger lines
 const ledgers = [
 ...bankDetails,
 { name: 'Accounts Receivable', debit: accountsReceivable, credit: 0 },
 { name: 'Accounts Payable', debit: 0, credit: accountsPayable },
 { name: 'Sales Revenue', debit: 0, credit: totalSalesRev },
 { name: 'Capitalized Fixed Assets', debit: totalFixedAssets, credit: 0 },
 { name: 'Direct Workshop Expenses', debit: totalPurchaseExp, credit: 0 },
 { name: 'VAT Collected (Output Tax)', debit: 0, credit: totalVATCollected },
 { name: "Shareholders' Paid-in Capital", debit: 0, credit: totalCapital }
 ];

 const totalDebits = ledgers.reduce((sum, l) => sum + l.debit, 0);
 const totalCredits = ledgers.reduce((sum, l) => sum + l.credit, 0);

 return { ledgers, totalDebits, totalCredits, totalSalesRev, totalPurchaseExp };
 };

 // Sales VAT Register Rows
 const getSalesVATData = () => {
 return db.invoices
 .filter(inv => {
 if (inv.companyId !== db.selectedCompanyId) return false;
 const matchesDate = inv.date >= startDate && inv.date <= endDate;
 const matchesCust = selectedCustomerId === 'ALL' || inv.customerId === selectedCustomerId;
 return matchesDate && matchesCust && inv.status === 'Active';
 })
 .map(inv => {
 const cust = db.customers.find(c => c.id === inv.customerId);
 const totals = calculateInvoiceTotals(db, inv.items, inv.taxSlabId, inv.discountPercentage);
 // A Credit Note shows as its own line here, signed negative — a genuine, auditable
 // reduction to output VAT, not just excluded (matches real VAT register convention).
 // Anything summing these rows (e.g. VAT Return Summary below) nets correctly for free.
 const sign = getInvoiceSign(inv);
 return {
 invoiceNumber: inv.invoiceNumber,
 date: inv.date,
 customerName: cust?.name || 'Walk-In',
 taxRegNumber: cust?.taxRegNumber || 'N/A',
 subtotal: totals.subtotal * sign,
 taxAmount: totals.taxAmount * sign,
 grandTotal: totals.grandTotal * sign
 };
 });
 };

 // Purchase VAT Register Rows
 const getPurchaseVATData = () => {
 return db.expenses
 .filter(exp => {
 if (exp.companyId !== db.selectedCompanyId) return false;
 const matchesDate = exp.date >= startDate && exp.date <= endDate;
 const matchesVend = selectedVendorId === 'ALL' || exp.vendorId === selectedVendorId;
 return matchesDate && matchesVend && exp.status === 'Active';
 })
 .map(exp => {
 const vend = db.vendors.find(v => v.id === exp.vendorId);
 // Direct expense doesn't support nested VAT calculation, we extract VAT percentage from tax slab
 const slab = db.taxSlabs.find(s => s.id === exp.taxSlabId);
 const rate = slab ? slab.percentage : 0;
 
 // Back-calculate taxable subtotal and tax paid
 const subtotal = exp.amount / (1 + rate / 100);
 const taxAmount = exp.amount - subtotal;

 return {
 expenseNumber: exp.expenseNumber,
 date: exp.date,
 vendorName: vend?.name || 'Cash Vendor',
 taxRegNumber: vend?.taxRegNumber || 'N/A',
 subtotal,
 taxAmount,
 grandTotal: exp.amount
 };
 });
 };

 // Outstanding Invoices & Expenses Rows
 const getOutstandingData = () => {
 // 1. Outstanding Invoices (Receivables) — a Credit Note is never itself an outstanding
 // receivable (its paymentStatus is always 'Unpaid' by default, but that field is
 // vestigial for this document type — see dbStore.ts's getInvoiceSign), so it's excluded
 // here entirely rather than netted; an "aging" report has no natural way to show a
 // negative days-overdue line, unlike a VAT register where a signed row is meaningful.
 const rawInvoices = db.invoices
 .filter(inv => {
 if (inv.companyId !== db.selectedCompanyId) return false;
 if (inv.documentType === 'CreditNote') return false;
 const matchesDate = !startDate || !endDate || (inv.date >= startDate && inv.date <= endDate);
 const matchesCust = selectedCustomerId === 'ALL' || inv.customerId === selectedCustomerId;
 const isOutstanding = inv.paymentStatus === 'Unpaid' || inv.paymentStatus === 'Partially Paid';
 return matchesDate && matchesCust && inv.status === 'Active' && isOutstanding;
 })
 .map(inv => {
 const cust = db.customers.find(c => c.id === inv.customerId);
 const totals = calculateInvoiceTotals(db, inv.items, inv.taxSlabId, inv.discountPercentage);
 const total = totals.grandTotal;
 const paid = inv.amountPaid || 0;
 const outstanding = total - paid;
 return {
 id: inv.id,
 type: 'Invoice',
 docNumber: inv.invoiceNumber,
 date: inv.date,
 contactName: cust?.name || 'Walk-In',
 total,
 paid,
 outstanding,
 paymentStatus: inv.paymentStatus,
 referenceId: inv.id,
 original: inv
 };
 });

 // 2. Outstanding Expenses (Payables)
 const rawExpenses = db.expenses
 .filter(exp => {
 if (exp.companyId !== db.selectedCompanyId) return false;
 const matchesDate = !startDate || !endDate || (exp.date >= startDate && exp.date <= endDate);
 const matchesVend = selectedVendorId === 'ALL' || exp.vendorId === selectedVendorId;
 const isOutstanding = exp.paymentStatus === 'Unpaid' || exp.paymentStatus === 'Partially Paid';
 return matchesDate && matchesVend && exp.status === 'Active' && isOutstanding;
 })
 .map(exp => {
 const vend = db.vendors.find(v => v.id === exp.vendorId);
 const total = exp.amount;
 const paid = exp.amountPaid || 0;
 const outstanding = total - paid;
 return {
 id: exp.id,
 type: 'Expense',
 docNumber: exp.expenseNumber,
 date: exp.date,
 contactName: vend?.name || 'Cash Vendor',
 total,
 paid,
 outstanding,
 paymentStatus: exp.paymentStatus,
 referenceId: exp.id,
 original: exp
 };
 });

 // Apply sorting
 const sortFn = (a: any, b: any) => {
 let f = sortField;
 if (f === 'voucherNumber' || f === 'sourceDoc') {
 f = 'docNumber';
 }
 let valA = a[f];
 let valB = b[f];

 if (valA === undefined || valA === null) valA = '';
 if (valB === undefined || valB === null) valB = '';

 if (typeof valA === 'string') {
 return sortOrder === 'asc' 
 ? valA.localeCompare(valB) 
 : valB.localeCompare(valA);
 } else {
 return sortOrder === 'asc' 
 ? valA - valB 
 : valB - valA;
 }
 };

 const sortedInvoices = [...rawInvoices].sort(sortFn);
 const sortedExpenses = [...rawExpenses].sort(sortFn);

 return { invoices: sortedInvoices, expenses: sortedExpenses };
 };

 // Bank Ledger Vouchers
 const getBankLedgerData = () => {
 let rawVouchers = [];
 let startBal = 0;
 let bankNameStr = '';

 if (selectedBankId === 'ALL') {
 rawVouchers = db.vouchers.filter(v => v.companyId === db.selectedCompanyId);
 startBal = db.banks.filter(b => b.companyId === db.selectedCompanyId).reduce((sum, b) => sum + b.openingBalance, 0);
 bankNameStr = t('All Banks Combined');
 } else {
 const selectedBank = db.banks.find(b => b.id === selectedBankId);
 if (!selectedBank || selectedBank.companyId !== db.selectedCompanyId) return { vouchers: [], endingBalance: 0, bankName: '' };
 rawVouchers = db.vouchers.filter(v => v.bankId === selectedBankId && v.companyId === db.selectedCompanyId);
 startBal = selectedBank.openingBalance;
 bankNameStr = selectedBank.bankName;
 }

 // Filter by dates
 if (startDate) {
 rawVouchers = rawVouchers.filter(v => v.date >= startDate);
 }
 if (endDate) {
 rawVouchers = rawVouchers.filter(v => v.date <= endDate);
 }

 // Always sort chronologically first to compute correct sequential running balances
 rawVouchers.sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));

 let runningBalance = startBal;

 const ledgerLines = rawVouchers.map(v => {
 let debit = 0;
 let credit = 0;

 if (v.type === 'Receipt' || v.type === 'TransferIn') {
 debit = v.amount;
 runningBalance += v.amount;
 } else if (v.type === 'Payment' || v.type === 'TransferOut') {
 credit = v.amount;
 runningBalance -= v.amount;
 } else if (v.type === 'Reversal') {
 if (v.referenceType === 'Invoice') {
 credit = v.amount;
 runningBalance -= v.amount;
 } else {
 debit = v.amount;
 runningBalance += v.amount;
 }
 }

 // Pre-calculate source document info for rendering and sorting
 let sourceDoc = '-';
 let refType: 'Invoice' | 'Expense' | null = null;
 if (v.referenceType === 'Invoice') {
 const inv = db.invoices.find(i => i.id === v.referenceId);
 if (inv) {
 sourceDoc = inv.invoiceNumber;
 refType = 'Invoice';
 }
 } else if (v.referenceType === 'Expense') {
 const exp = db.expenses.find(e => e.id === v.referenceId);
 if (exp) {
 sourceDoc = exp.expenseNumber;
 refType = 'Expense';
 }
 }

 const bank = db.banks.find(b => b.id === v.bankId);

 return {
 id: v.id,
 date: v.date,
 type: v.type,
 voucherNumber: v.voucherNumber,
 description: v.description,
 debit,
 credit,
 runningBalance: Number(runningBalance.toFixed(2)),
 bankId: v.bankId,
 bankName: bank ? bank.bankName : t('Unknown'),
 sourceDoc,
 refType,
 referenceId: v.referenceId
 };
 });

 const endingBalance = ledgerLines.length > 0 
 ? ledgerLines[ledgerLines.length - 1].runningBalance 
 : startBal;

 // Now apply user-selected sort order
 const sortedLines = [...ledgerLines].sort((a: any, b: any) => {
 let valA = a[sortField];
 let valB = b[sortField];

 if (valA === undefined || valA === null) valA = '';
 if (valB === undefined || valB === null) valB = '';

 if (typeof valA === 'string') {
 return sortOrder === 'asc' 
 ? valA.localeCompare(valB) 
 : valB.localeCompare(valA);
 } else {
 return sortOrder === 'asc' 
 ? valA - valB 
 : valB - valA;
 }
 });

 return { vouchers: sortedLines, endingBalance, bankName: bankNameStr };
 };

const getProfitLossData = () => {
 // 1. Filter base records
 const plInvoices = db.invoices.filter(inv => {
 if ((inv.companyId) !== db.selectedCompanyId) return false;
 if (inv.status !== 'Active') return false;
 return true;
 });

 const plExpenses = db.expenses.filter(exp => {
 if ((exp.companyId) !== db.selectedCompanyId) return false;
 if (exp.status !== 'Active') return false;
 return true;
 });

 // Cash Flow Analysis & Cash Basis PL pre-requisite
 const periodVouchers = db.vouchers.filter(v => 
 (v.companyId) === db.selectedCompanyId &&
 v.date >= startDate && v.date <= endDate
 );

 // Calculate Revenue
 let totalRevenue = 0;
 if (accountingBasis === 'Accrual') {
 const revenueInvoices = plInvoices.filter(inv => inv.date >= startDate && inv.date <= endDate);
 totalRevenue = revenueInvoices.reduce((sum, inv) => {
 const totals = calculateInvoiceTotals(db, inv.items, inv.taxSlabId, inv.discountPercentage);
 return sum + totals.grandTotal * getInvoiceSign(inv);
 }, 0);
 } else {
 // Cash Basis Revenue = Sum of all Invoice Receipts in the period
 totalRevenue = periodVouchers.filter(v => v.referenceType === 'Invoice' && v.type === 'Receipt').reduce((sum, v) => sum + v.amount, 0);
 }

 // Calculate Expenses
 let totalExpenses = 0;
 if (accountingBasis === 'Accrual') {
 const periodExpenses = plExpenses.filter(exp => 
 exp.classification !== 'Asset' && 
 exp.date >= startDate && exp.date <= endDate &&
 (exp.type === 'Accrual' || (exp.type === 'Actual' && !exp.originAccrualId))
 );
 totalExpenses = periodExpenses.reduce((sum, exp) => sum + exp.amount, 0);
 } else {
 // Cash Basis Expenses = Sum of all OpEx Expense Payments in the period
 totalExpenses = periodVouchers.filter(v => v.referenceType === 'Expense' && (v.type === 'Payment' || v.type === 'Reversal')).reduce((sum, v) => {
 const exp = db.expenses.find(e => e.id === v.referenceId);
 if (exp && exp.classification !== 'Asset') {
 return sum + (v.type === 'Payment' ? v.amount : -v.amount);
 }
 return sum;
 }, 0);
 }

 const netProfit = totalRevenue - totalExpenses;


 const operatingInflows = periodVouchers.filter(v => v.referenceType === 'Invoice' && v.type === 'Receipt').reduce((sum, v) => sum + v.amount, 0);
 
 const operatingOutflows = periodVouchers.filter(v => v.referenceType === 'Expense' && (v.type === 'Payment' || v.type === 'Reversal')).reduce((sum, v) => {
 const exp = db.expenses.find(e => e.id === v.referenceId);
 if (exp && exp.classification !== 'Asset') {
 return sum + (v.type === 'Payment' ? v.amount : -v.amount);
 }
 return sum;
 }, 0);

 const investingOutflows = periodVouchers.filter(v => v.referenceType === 'Expense' && (v.type === 'Payment' || v.type === 'Reversal')).reduce((sum, v) => {
 const exp = db.expenses.find(e => e.id === v.referenceId);
 if (exp && exp.classification === 'Asset') {
 return sum + (v.type === 'Payment' ? v.amount : -v.amount);
 }
 return sum;
 }, 0);

 const financingInflows = periodVouchers.filter(v => v.referenceType === 'Equity' && v.type === 'Receipt').reduce((sum, v) => sum + v.amount, 0);

 const netCashFlow = operatingInflows - operatingOutflows - investingOutflows + financingInflows;

 // Investor Profit Share
 const investors = (db.investors || []).filter(inv => (inv.companyId) === db.selectedCompanyId && inv.isActive);
 const investorShares = investors.map(inv => ({
 name: inv.name,
 profitPercentage: inv.profitPercentage,
 shareAmount: netProfit > 0 ? (netProfit * inv.profitPercentage) / 100 : 0
 }));

 return {
 accountingBasis,
 totalRevenue,
 totalExpenses,
 netProfit,
 operatingInflows,
 operatingOutflows,
 investingOutflows,
 financingInflows,
 netCashFlow,
 investorShares
 };
};

// Balance Sheet — an as-of-date snapshot (uses `endDate` as the as-of date, not a
// startDate..endDate range like every other report here), since Assets/Liabilities/
// Equity are a point-in-time position, not a period's activity. This app has no formal
// chart-of-accounts, so this reuses the same account-derivation Trial Balance already
// does (bank balances from vouchers) and extends it with inventory valuation and AR/AP,
// rather than inventing a second, differently-computed "outstanding" concept — an
// invoice/expense counts as AR/AP here if it was dated on or before the as-of date and
// is still unpaid *right now*, which is the correct snapshot semantics (unlike the
// Outstanding report's date-range filter, which is about activity within a period).
const getBalanceSheetData = () => {
  const asOfDate = endDate;
  const companyBanks = db.banks.filter(b => b.companyId === db.selectedCompanyId);
  const bankBalance = companyBanks.reduce((sum, b) => sum + getBankBalance(db, b.id), 0);

  const accountsReceivable = db.invoices
    .filter(inv => inv.companyId === db.selectedCompanyId && inv.status === 'Active' && inv.date <= asOfDate
      && (inv.paymentStatus === 'Unpaid' || inv.paymentStatus === 'Partially Paid'))
    .reduce((sum, inv) => {
      const total = calculateInvoiceTotals(db, inv.items, inv.taxSlabId, inv.discountPercentage).grandTotal;
      return sum + (total - (inv.amountPaid || 0)) * getInvoiceSign(inv);
    }, 0);

  const accountsPayable = db.expenses
    .filter(exp => exp.companyId === db.selectedCompanyId && exp.status === 'Active' && exp.date <= asOfDate
      && (exp.paymentStatus === 'Unpaid' || exp.paymentStatus === 'Partially Paid'))
    .reduce((sum, exp) => sum + (exp.amount - (exp.amountPaid || 0)), 0);

  const companyProducts = (db.products || []).filter((p: any) => p.companyId === db.selectedCompanyId);
  const inventoryValue = (db.inventoryStocks || [])
    .filter((s: any) => s.companyId === db.selectedCompanyId)
    .reduce((sum: number, s: any) => {
      const product = companyProducts.find((p: any) => p.id === s.productId);
      const cost = product ? Number(product.averageCost || 0) : 0;
      return sum + Number(s.quantity || 0) * cost;
    }, 0);

  const totalAssets = bankBalance + accountsReceivable + inventoryValue;
  const totalLiabilities = accountsPayable;

  const capitalContributed = (db.investors || [])
    .filter((inv: any) => inv.companyId === db.selectedCompanyId)
    .reduce((sum: number, inv: any) => sum + Number(inv.capitalContributed || 0), 0);
  // Retained earnings: cumulative net profit from every fiscal month closed on or before
  // the as-of date — this app's only durable record of historical profit (fiscalMonths
  // stores closedPnL at closing time; open months don't contribute until closed).
  const retainedEarnings = (db.months || [])
    .filter((m: any) => m.companyId === db.selectedCompanyId && m.status === 'Closed' && m.closedPnL
      && (!m.closedAt || m.closedAt <= `${asOfDate}T23:59:59`))
    .reduce((sum: number, m: any) => sum + Number(m.closedPnL?.netProfit || 0), 0);
  const totalEquity = capitalContributed + retainedEarnings;

  return {
    asOfDate, bankBalance, accountsReceivable, inventoryValue, totalAssets,
    accountsPayable, totalLiabilities,
    capitalContributed, retainedEarnings, totalEquity,
    // A real chart-of-accounts would balance exactly; this derived approximation is
    // shown for transparency, not hidden — a large gap is itself a useful audit signal.
    balanceCheck: totalAssets - (totalLiabilities + totalEquity),
  };
};

// VAT Return Summary — the one number a periodic VAT filing actually needs, aggregating
// the Sales VAT and Purchase VAT registers this app already computes rather than
// re-deriving anything new.
const getVatReturnSummaryData = () => {
  const sales = getSalesVATData();
  const purchases = getPurchaseVATData();
  const outputVat = sales.reduce((sum: number, r: any) => sum + r.taxAmount, 0);
  const inputVat = purchases.reduce((sum: number, r: any) => sum + r.taxAmount, 0);
  return {
    startDate, endDate,
    outputVat, inputVat,
    netVatPayable: outputVat - inputVat,
    salesCount: sales.length,
    purchaseCount: purchases.length,
  };
};

// Investor Profit Share — standalone view of the same per-investor split P&L already
// computes inline (getProfitLossData's investorShares), for when someone just wants the
// distribution table without the full income statement around it.
const getInvestorProfitShareData = () => {
  const { netProfit, investorShares } = getProfitLossData();
  return { startDate, endDate, netProfit, investorShares };
};

// Fiscal Month Closing History — every closed month's locked P&L snapshot, side by side.
// No date-range filter (a closed month's own id already carries its period); shows every
// closed month for this company so far.
const getFiscalMonthClosingHistoryData = () => {
  const closedMonths = (db.months || [])
    .filter((m: any) => m.companyId === db.selectedCompanyId && m.status === 'Closed')
    .sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)));
  return { months: closedMonths };
};

 const handlePrint = () => {
 // Defense in depth — the button that sets reportType is already permission-filtered
 // below, but guard the action itself too rather than trust that alone.
 if (!can(REPORT_PERMISSION_KEYS[reportType])) return;
 let reportData: any = {};
 if (reportType === 'TrialBalance') {
 reportData = getTrialBalance();
 } else if (reportType === 'SalesVAT') {
 reportData = getSalesVATData();
 } else if (reportType === 'PurchaseVAT') {
 reportData = getPurchaseVATData();
 } else if (reportType === 'BankLedger') {
 reportData = getBankLedgerData();
 } else if (reportType === 'Outstanding') {
 reportData = getOutstandingData();
 } else if (reportType === 'ProfitLoss') {
 reportData = getProfitLossData();
 } else if (reportType === 'BalanceSheet') {
 reportData = getBalanceSheetData();
 } else if (reportType === 'VatReturnSummary') {
 reportData = getVatReturnSummaryData();
 } else if (reportType === 'InvestorProfitShare') {
 reportData = getInvestorProfitShareData();
 } else if (reportType === 'FiscalMonthClosingHistory') {
 reportData = getFiscalMonthClosingHistoryData();
 }

 onPrintDoc('Report', {
 type: reportType,
 startDate,
 endDate,
 data: reportData
 });
 };

 return (
 <div className="space-y-6">

 {!hasAccessToCurrentReport ? (
 // Reachable only if a role's permissions changed while this exact report was
 // already open (App.tsx's nav already filters which sidebar entries — and so
 // which reports — appear at all). Not a normal path, but never silently render
 // a report this actor no longer has the leaf for.
 <div className="bg-white border border-rose-200 rounded-2xl p-6 text-center text-sm text-rose-600 font-semibold">
 {t('You no longer have access to this report.')}
 </div>
 ) : (
 <>
 {/* Report header + export action — which report is showing is set by the sidebar
 now, not an in-page tab switcher (see App.tsx's defaultReportType prop). */}
 <div className="bg-white border border-slate-200/80 rounded-2xl p-4.5 flex items-center justify-between gap-4 shadow-sm">
 <h3 className="text-sm font-extrabold text-slate-900">{t(REPORT_LABELS[reportType])}</h3>
 <button
 onClick={handlePrint}
 className="bg-slate-900 hover:bg-slate-950 text-white font-extrabold rounded-xl px-4 py-2 text-xs transition-all duration-150 flex items-center gap-1.5 shadow-md shrink-0 hover:shadow-lg"
 >
 <Printer className="w-4 h-4 text-indigo-400" /> {t('Export Statement (Print)')}
 </button>
 </div>

 {/* Disclosure: reports read from a capped, most-recent-N window per record type. This is
 a check on already-fetched in-memory data, no new query. */}
 {isDataPossiblyTruncated && (
 <div className="bg-slate-100 border border-slate-200 rounded-2xl p-3 flex items-center gap-2.5">
 <span className="text-sm shrink-0">ℹ️</span>
 <p className="text-[10.5px] text-slate-600">
 {t('Based on the most recent 500 records per type (invoices, expenses, vouchers, quotations) - totals in these reports may be incomplete for companies with more history.')}
 </p>
 </div>
 )}

 {/* Dynamic Filter Panel */}
 <div className="bg-white border border-slate-200/80 rounded-2xl p-5 text-xs text-slate-600 shadow-sm">
 <div className="flex items-center justify-between gap-2 mb-5 border-b border-slate-100 pb-3 flex-wrap">
 <div className="flex items-center gap-2 font-extrabold text-slate-900 uppercase tracking-widest text-[10px]">
 <Filter className="w-3.5 h-3.5 text-indigo-600 animate-pulse" />
 <span>{t('Statement Audit Controls & Filters')}</span>
 </div>
 <span className="text-[9px] font-bold text-indigo-600 bg-indigo-50 border border-indigo-100 px-1.5 py-0.5 rounded uppercase">
 🏢 {t('Scoped Company:')} {db.companySetup?.name}
 </span>
 </div>

 <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('From Date')}</label>
 <input
 type="date"
 value={startDate}
 onChange={(e) => setStartDate(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none transition-all duration-150"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('To Date')}</label>
 <input
 type="date"
 value={endDate}
 onChange={(e) => setEndDate(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none transition-all duration-150"
 />
 </div>

 {(reportType === 'SalesVAT' || reportType === 'Outstanding') && (
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Filter Customer')}</label>
 <select
 value={selectedCustomerId}
 onChange={(e) => setSelectedCustomerId(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none transition-all duration-150"
 >
 <option value="ALL">{t('Show All Customers')}</option>
 {db.customers.filter(c => c.companyId === db.selectedCompanyId || !c.companyId).map(c => (
 <option key={c.id} value={c.id}>{c.name}</option>
 ))}
 </select>
 </div>
 )}

 {(reportType === 'PurchaseVAT' || reportType === 'Outstanding') && (
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Filter Vendor')}</label>
 <select
 value={selectedVendorId}
 onChange={(e) => setSelectedVendorId(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none transition-all duration-150"
 >
 <option value="ALL">{t('Show All Vendors')}</option>
 {db.vendors.filter(v => v.companyId === db.selectedCompanyId || !v.companyId).map(v => (
 <option key={v.id} value={v.id}>{v.name}</option>
 ))}
 </select>
 </div>
 )}

 {reportType === 'BankLedger' && (
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Select Bank Ledger')}</label>
 <select
 value={selectedBankId}
 onChange={(e) => setSelectedBankId(e.target.value)}
 className="w-full bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none"
 >
 <option value="ALL">{t('All Banks Combined')}</option>
 {db.banks.filter(b => b.companyId === db.selectedCompanyId).map(b => (
 <option key={b.id} value={b.id}>{b.bankName} (Bal: {currencySymbol} {getBankBalance(db, b.id).toFixed(2)})</option>
 ))}
 </select>
 </div>
 )}
 </div>
 </div>

 {/* REPORT CONTENT VIEWPORTS */}
 <div className="bg-white border border-slate-200/60 rounded-[28px] shadow-[0_8px_30px_rgb(0,0,0,0.04)] backdrop-blur-xl overflow-hidden p-6">

 {/* 1. Trial Balance viewport */}
 {reportType === 'TrialBalance' && (() => {
 const { ledgers, totalDebits, totalCredits, totalSalesRev, totalPurchaseExp } = getTrialBalance();
 return (
 <div className="space-y-6">
 <div className="text-center">
 <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">{t("Dual-Ledger Trial Balance Sheet")}</h3>
 <p className="text-[10px] text-slate-400 mt-1">{t("Audit Period:")} {startDate} {t("to")} {endDate}</p>
 </div>

 <div className="overflow-x-auto">
 <table className="w-full text-xs text-start">
 <thead>
 <tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]">
 <th className="p-3">{t("Ledger Chart Account Head")}</th>
 <th className="p-3 text-end">{t("Debit")} ({currencySymbol})</th>
 <th className="p-3 text-end">{t("Credit")} ({currencySymbol})</th>
 </tr>
 </thead>
 <tbody>
 {ledgers.map((l, i) => (
 <tr key={i} className="border-b border-slate-100 hover:bg-slate-50/20 text-slate-700">
 <td className="p-3 font-semibold">{l.name}</td>
 <td className="p-3 text-end font-mono font-bold text-indigo-600">
 {l.debit > 0 ? `${currencySymbol} ${l.debit.toFixed(2)}` : '-'}
 </td>
 <td className="p-3 text-end font-mono font-bold text-amber-600">
 {l.credit > 0 ? `${currencySymbol} ${l.credit.toFixed(2)}` : '-'}
 </td>
 </tr>
 ))}
 <tr className="bg-slate-900 text-white font-bold text-xs border-t-2 border-slate-950">
 <td className="p-3.5">{t("Balanced Sum Total:")}</td>
 <td className="p-3.5 text-end font-mono text-emerald-400">{currencySymbol} {totalDebits.toFixed(2)}</td>
 <td className="p-3.5 text-end font-mono text-emerald-400">{currencySymbol} {totalCredits.toFixed(2)}</td>
 </tr>
 </tbody>
 </table>
 </div>

 {/* Shareholders' Equity & Profit Allocation Details */}
 {(() => {
 const reportInvestors = (db.investors || []).filter(inv => (inv.companyId) === (db.selectedCompanyId));
 if (reportInvestors.length === 0) return null;
 return (
 <div className="mt-8 bg-slate-50/80 rounded-2xl border border-slate-150 p-5 space-y-4">
 <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-200/55 pb-3">
 <div>
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
 <span className="inline-block w-2 h-2 rounded-full bg-emerald-500"></span>
 {t("Shareholders' Capital & Profit Split Allocation")}
 </h4>
 <p className="text-[10px] text-slate-400 mt-0.5">{t("Ratios are based on custom partner splits for the selected period.")}</p>
 </div>
 <div className="bg-white px-3 py-1.5 rounded-xl border border-slate-200/50 text-end">
 <span className="text-[9px] text-slate-400 font-bold block uppercase">{t("Net Profit of Selected Period")}</span>
 <span className={`font-mono font-bold text-xs ${(totalSalesRev - totalPurchaseExp) >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
 {currencySymbol} {(totalSalesRev - totalPurchaseExp).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
 </span>
 </div>
 </div>

 <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
 {reportInvestors.map((inv) => {
 // Total capital contributed by this investor *ever*
 const currentTotalContributed = db.vouchers
 .filter(v => v.referenceType === 'Equity' && v.referenceId === inv.id)
 .reduce((sum, v) => sum + v.amount, 0);

 const profitPercentage = inv.profitPercentage ?? inv.equityPercentage;
 const periodNetProfit = totalSalesRev - totalPurchaseExp;
 const allocatedProfit = (periodNetProfit * profitPercentage) / 100;

 return (
 <div key={inv.id} className="bg-white border border-slate-200/65 p-4 rounded-xl space-y-3">
 <div className="flex justify-between items-start">
 <div>
 <span className="font-extrabold text-slate-900 text-xs">{inv.name}</span>
 <div className="text-[9px] text-slate-400 font-bold uppercase mt-0.5">{t("Registered Partner")}</div>
 </div>
 <div className="flex flex-col items-end gap-1">
 <span className="bg-indigo-50 text-indigo-700 font-extrabold text-[9px] px-2 py-0.5 rounded-md">
 {inv.equityPercentage}% Equity
 </span>
 <span className="bg-emerald-50 text-emerald-700 font-extrabold text-[9px] px-2 py-0.5 rounded-md">
 {profitPercentage}% Profit Share
 </span>
 </div>
 </div>

 <div className="grid grid-cols-2 gap-2 pt-2.5 border-t border-slate-100 text-xs">
 <div>
 <span className="text-[9px] text-slate-400 font-bold uppercase block">{t("Total Contributed Capital")}</span>
 <span className="font-mono font-bold text-slate-800 ">
 {currencySymbol} {currentTotalContributed.toLocaleString('en-US', { minimumFractionDigits: 2 })}
 </span>
 </div>
 <div className="text-end">
 <span className="text-[9px] text-slate-400 font-bold uppercase block">{t("Allocated Period Profit")}</span>
 <span className={`font-mono font-bold ${allocatedProfit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
 {currencySymbol} {allocatedProfit.toLocaleString('en-US', { minimumFractionDigits: 2 })}
 </span>
 </div>
 </div>
 </div>
 );
 })}
 </div>

 {/* Capital Reconciliation / Owed Balances Analysis */}
 {(() => {
 const totalContributed = reportInvestors.reduce((sum, inv) => {
 const actual = db.vouchers
 .filter(v => v.referenceType === 'Equity' && v.referenceId === inv.id)
 .reduce((vSum, v) => vSum + v.amount, 0);
 return sum + actual;
 }, 0);

 if (totalContributed === 0) return null;

 const reconciliation = reportInvestors.map((inv) => {
 const actual = db.vouchers
 .filter(v => v.referenceType === 'Equity' && v.referenceId === inv.id)
 .reduce((vSum, v) => vSum + v.amount, 0);
 const targetShare = (totalContributed * inv.equityPercentage) / 100;
 const balance = targetShare - actual; // Positive = deficit (owes), Negative = surplus (owed/over-contributed)
 return {
 ...inv,
 actual,
 targetShare,
 balance
 };
 });

 const debtors = reconciliation.filter(p => p.balance > 0.01);
 const creditors = reconciliation.filter(p => p.balance < -0.01);

 return (
 <div className="pt-4 border-t border-slate-200/55 space-y-4">
 <div>
 <h5 className="text-[10px] font-black text-slate-400 uppercase tracking-wider">{t("Equity Matching & Outstanding Balances")}</h5>
 <p className="text-[10px] text-slate-500 mt-0.5">{t("Calculates whether partners have contributed capital matching their agreed")} <strong>{reconciliation.map(r => `${r.name}: ${r.equityPercentage}%`).join(' / ')}</strong> {t("equity ratios of the current total capital base of")} <strong>{currencySymbol} {totalContributed.toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong>.</p>
 </div>

 {debtors.length > 0 ? (
 <div className="bg-amber-50/55 border border-amber-100 rounded-xl p-4 text-xs space-y-3">
 <div className="flex items-start gap-2 text-amber-800 ">
 <span className="text-base">⚠️</span>
 <div className="space-y-1">
 <span className="font-extrabold block">{t("Imbalanced Capital Contributions Detected")}</span>
 <p className="text-[11px] text-amber-700/90 ">
 {t("Because capital is not contributed exactly in ratio to equity share, partners currently owe outstanding capital balances to maintain the partnership ratio:")}
 </p>
 </div>
 </div>

 <div className="space-y-2">
 {debtors.map((debtor) => {
 // Find who is over-contributed to display who they owe
 const owedText = creditors.map(cred => {
 // Share debtor's deficit with creditors proportionally (if multiple)
 const ratio = Math.abs(cred.balance) / creditors.reduce((sum, c) => sum + Math.abs(c.balance), 0);
 const share = debtor.balance * ratio;
 return `${t('owes')} ${currencySymbol} ${share.toLocaleString('en-US', { minimumFractionDigits: 2 })} ${t('to')} ${cred.name}`;
 }).join(', ');

 return (
 <div key={debtor.id} className="bg-white/80 p-2.5 rounded-lg border border-amber-100/50 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
 <div>
 <span className="font-bold text-slate-800 ">{debtor.name}</span>{' '}
 <span className="text-slate-500">({debtor.equityPercentage}% {t('Equity')}) {t('has paid')} {currencySymbol} {debtor.actual.toLocaleString('en-US', { minimumFractionDigits: 2 })} {t('but target was')} {currencySymbol} {debtor.targetShare.toLocaleString('en-US', { minimumFractionDigits: 2 })}.</span>
 </div>
 <div className="text-end whitespace-nowrap">
 <span className="bg-rose-50 text-rose-700 font-extrabold text-[10px] px-2 py-1 rounded-md block">
 {t('Owes')} {currencySymbol} {debtor.balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}
 </span>
 </div>
 </div>
 );
 })}
 </div>

 {/* Educational Accounting entry guide */}
 <div className="pt-3 border-t border-amber-100 space-y-2 text-[11px] text-slate-600 ">
 <div className="font-bold text-slate-800 ">💡 {t("How to handle and record this entry:")}</div>
 <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-1 text-[10.5px]">
 <div className="bg-amber-50/20 p-2.5 rounded-lg border border-slate-100 space-y-1">
 <span className="font-extrabold text-amber-800 block">{t("Option A: On-Books Cash Deposit (Recommended)")}</span>
 <p>{t("The owing partner deposits the outstanding cash into the company bank account to match the 50% split:")}</p>
 <div className="font-mono bg-slate-900 text-slate-200 p-2 rounded text-[9.5px] space-y-0.5 mt-1">
 <div className="text-emerald-400">{t("1. Click + Post Voucher in Bank statement")}</div>
 <div>{t("Type:")} <strong>{t("Receipt")}</strong> ({t("Inflow")})</div>
 <div>{t("Reference Type:")} <strong>{t("Equity")}</strong></div>
 <div>{t("Reference: Select")} <strong>{t("Owing Partner")}</strong></div>
 <div>{t("Amount:")} <strong>{currencySymbol} {debtors[0]?.balance.toFixed(2)}</strong></div>
 </div>
 <p className="text-[10px] text-slate-400 mt-1">{t("Impact: Bank cash increases, and both capital balances perfectly equalize.")}</p>
 </div>

 <div className="bg-amber-50/20 p-2.5 rounded-lg border border-slate-100 space-y-1">
 <span className="font-extrabold text-amber-800 block">{t("Option B: Off-Books Private Settlement")}</span>
 <p>{t("The owing partner pays the other partner directly outside of the business. Inside the system, you reallocate the capital accounts to reflect this buyout:")}</p>
 <div className="font-mono bg-slate-900 text-slate-200 p-2 rounded text-[9.5px] space-y-0.5 mt-1">
 <div className="text-emerald-400">{t("1. Create a General Transfer Journal")}</div>
 <div>{t("Decrease (Debit)")} <strong>{t("Paying Partner Capital")}</strong></div>
 <div>{t("Increase (Credit)")} <strong>{t("Receiving Partner Capital")}</strong></div>
 <div className="text-slate-400 mt-1">{t("Or simply keep this Trial Balance card as your proof of private debt settlement.")}</div>
 </div>
 <p className="text-[10px] text-slate-400 mt-1">{t("Impact: Bank balance is unchanged, but ownership capital is equalized.")}</p>
 </div>
 </div>
 </div>
 </div>
 ) : (
 <div className="bg-emerald-50/40 border border-emerald-100 rounded-xl p-3.5 text-xs text-emerald-800 flex items-center gap-2">
 <span>✅</span>
 <div>
 <span className="font-bold block">{t("Capital Accounts Perfectly Balanced")}</span>
 <span className="text-[11px] text-slate-500 mt-0.5">{t("All partners have contributed exactly in accordance with their agreed")} {reconciliation[0]?.equityPercentage}% / {reconciliation[1]?.equityPercentage}% {t("equity ratio.")}</span>
 </div>
 </div>
 )}
 </div>
 );
 })()}
 </div>
 );
 })()}
 </div>
 );
 })()}

 {/* 2. Sales VAT register viewport */}
 {reportType === 'SalesVAT' && (() => {
 const rows = getSalesVATData();
 const subtotalSum = rows.reduce((s, r) => s + r.subtotal, 0);
 const taxSum = rows.reduce((s, r) => s + r.taxAmount, 0);
 const grandSum = rows.reduce((s, r) => s + r.grandTotal, 0);

 return (
 <div className="space-y-6">
 <div className="text-center">
 <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">{t("Detailed Sales VAT Register (Output Tax)")}</h3>
 <p className="text-[10px] text-slate-400 mt-1">{t("Period:")} {startDate} {t("to")} {endDate}</p>
 </div>

 <div className="overflow-x-auto">
 <table className="w-full text-xs text-start">
 <thead>
 <tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]">
 <th className="p-3">{t("Invoice No")}</th>
 <th className="p-3">{t("Date")}</th>
 <th className="p-3">{t("Customer Entity")}</th>
 <th className="p-3">{t("Tax Reg No")}</th>
 <th className="p-3 text-end">{t("Net Taxable")} ({currencySymbol})</th>
 <th className="p-3 text-end">{t("VAT Collected")} ({currencySymbol})</th>
 <th className="p-3 text-end font-bold">{t("Grand Total")} ({currencySymbol})</th>
 </tr>
 </thead>
 <tbody>
 {rows.length === 0 ? (
 <tr>
 <td colSpan={7} className="p-8 text-center text-slate-400">
 {t("No sales VAT records found in the specified date filters.")}
 </td>
 </tr>
 ) : (
 rows.map((r, i) => (
 <tr key={i} className="border-b border-slate-100 hover:bg-slate-50/20 text-slate-700">
 <td className="p-3 font-bold text-slate-950">{r.invoiceNumber}</td>
 <td className="p-3">{r.date}</td>
 <td className="p-3 font-medium">{r.customerName}</td>
 <td className="p-3 font-mono">{r.taxRegNumber}</td>
 <td className="p-3 text-end font-mono">{currencySymbol} {r.subtotal.toFixed(2)}</td>
 <td className="p-3 text-end font-mono text-indigo-600">+{currencySymbol} {r.taxAmount.toFixed(2)}</td>
 <td className="p-3 text-end font-mono font-bold">{currencySymbol} {r.grandTotal.toFixed(2)}</td>
 </tr>
 ))
 )}
 <tr className="bg-slate-100 font-bold border-t border-slate-300">
 <td colSpan={4} className="p-3 text-slate-700">{t("Total Tax Register Summary:")}</td>
 <td className="p-3 text-end font-mono">{currencySymbol} {subtotalSum.toFixed(2)}</td>
 <td className="p-3 text-end font-mono text-indigo-600">{currencySymbol} {taxSum.toFixed(2)}</td>
 <td className="p-3 text-end font-mono text-slate-900">{currencySymbol} {grandSum.toFixed(2)}</td>
 </tr>
 </tbody>
 </table>
 </div>
 </div>
 );
 })()}

 {/* 3. Purchase VAT register viewport */}
 {reportType === 'PurchaseVAT' && (() => {
 const rows = getPurchaseVATData();
 const subtotalSum = rows.reduce((s, r) => s + r.subtotal, 0);
 const taxSum = rows.reduce((s, r) => s + r.taxAmount, 0);
 const grandSum = rows.reduce((s, r) => s + r.grandTotal, 0);

 return (
 <div className="space-y-6">
 <div className="text-center">
 <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">{t("Detailed Purchase VAT Register (Input Tax)")}</h3>
 <p className="text-[10px] text-slate-400 mt-1">{t("Period:")} {startDate} {t("to")} {endDate}</p>
 </div>

 <div className="overflow-x-auto">
 <table className="w-full text-xs text-start">
 <thead>
 <tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]">
 <th className="p-3">{t("Expense No")}</th>
 <th className="p-3">{t("Date")}</th>
 <th className="p-3">{t("Vendor / Supplier")}</th>
 <th className="p-3">{t("Tax Reg No")}</th>
 <th className="p-3 text-end">{t("Taxable Subtotal")} ({currencySymbol})</th>
 <th className="p-3 text-end">{t("VAT Paid")} ({currencySymbol})</th>
 <th className="p-3 text-end font-bold">{t("Total Disbursed")} ({currencySymbol})</th>
 </tr>
 </thead>
 <tbody>
 {rows.length === 0 ? (
 <tr>
 <td colSpan={7} className="p-8 text-center text-slate-400">
 {t("No procurement VAT records found in specified date filters.")}
 </td>
 </tr>
 ) : (
 rows.map((r, i) => (
 <tr key={i} className="border-b border-slate-100 hover:bg-slate-50/20 text-slate-700">
 <td className="p-3 font-bold text-slate-950">{r.expenseNumber}</td>
 <td className="p-3">{r.date}</td>
 <td className="p-3 font-medium">{r.vendorName}</td>
 <td className="p-3 font-mono">{r.taxRegNumber}</td>
 <td className="p-3 text-end font-mono">{currencySymbol} {r.subtotal.toFixed(2)}</td>
 <td className="p-3 text-end font-mono text-rose-600">-{currencySymbol} {r.taxAmount.toFixed(2)}</td>
 <td className="p-3 text-end font-mono font-bold">{currencySymbol} {r.grandTotal.toFixed(2)}</td>
 </tr>
 ))
 )}
 <tr className="bg-slate-100 font-bold border-t border-slate-300">
 <td colSpan={4} className="p-3 text-slate-700">{t("Total Input VAT Summary:")}</td>
 <td className="p-3 text-end font-mono">{currencySymbol} {subtotalSum.toFixed(2)}</td>
 <td className="p-3 text-end font-mono text-rose-600">{currencySymbol} {taxSum.toFixed(2)}</td>
 <td className="p-3 text-end font-mono text-slate-900">{currencySymbol} {grandSum.toFixed(2)}</td>
 </tr>
 </tbody>
 </table>
 </div>
 </div>
 );
 })()}

 {/* 4. Bank ledger viewport with running balances */}
 {reportType === 'BankLedger' && (() => {
 const { vouchers, endingBalance, bankName } = getBankLedgerData();
 const isAllBanks = selectedBankId === 'ALL';
 return (
 <div className="space-y-6">
 <div className="text-center">
 <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">{bankName} {t("statement card")}</h3>
 <p className="text-[10px] text-slate-400 mt-1">{t("Audit Ledger Statement:")} {startDate} {t("to")} {endDate}</p>
 </div>

 <div className="overflow-x-auto">
 <table className="w-full text-xs text-start">
 <thead>
 <tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]">
 {renderSortableHeader(t('Voucher No'), 'voucherNumber')}
 {renderSortableHeader(t('Voucher Date'), 'date')}
 {isAllBanks && renderSortableHeader(t('Bank Name'), 'bankName')}
 {renderSortableHeader(t('Type'), 'type')}
 {renderSortableHeader(t('Source Doc #'), 'sourceDoc')}
 {renderSortableHeader(t('Transaction notes'), 'description')}
 {renderSortableHeader(t('Debit / Inflow'), 'debit', 'right')}
 {renderSortableHeader(t('Credit / Outflow'), 'credit', 'right')}
 {renderSortableHeader(t('Running Balance'), 'runningBalance', 'right')}
 </tr>
 </thead>
 <tbody>
 {vouchers.length === 0 ? (
 <tr>
 <td colSpan={isAllBanks ? 9 : 8} className="p-8 text-center text-slate-400">
 {t("No voucher activities posted on this bank ledger account inside selected date range.")}
 </td>
 </tr>
 ) : (
 vouchers.map((v, i) => {
 const voucher = db.vouchers.find(item => item.voucherNumber === v.voucherNumber);
 return (
 <tr key={i} className="border-b border-slate-100 hover:bg-slate-50/20 text-slate-700">
 <td className="p-3 font-bold text-slate-950">
 <button
 type="button"
 onClick={() => {
 if (voucher) {
 const bank = db.banks.find(b => b.id === voucher.bankId);
 onPrintDoc('Voucher', { ...voucher, bankData: bank });
 }
 }}
 className="font-bold text-indigo-600 hover:text-indigo-800 hover:underline cursor-pointer"
 >
 {v.voucherNumber}
 </button>
 </td>
 <td className="p-3">{v.date}</td>
 {isAllBanks && (
 <td className="p-3 font-semibold text-slate-600">
 {v.bankName}
 </td>
 )}
 <td className="p-3 font-semibold">
 <span className={`px-1.5 py-0.5 rounded text-[9px] uppercase font-bold ${
 v.type === 'Receipt' ? 'bg-emerald-50 text-emerald-700' :
 v.type === 'Payment' ? 'bg-rose-50 text-rose-700' : 'bg-blue-50 text-blue-700'
 }`}>
 {v.type}
 </span>
 </td>
 <td className="p-3 font-semibold text-slate-600">
 {v.sourceDoc !== '-' && v.refType ? (
 <button
 type="button"
 onClick={() => {
 if (v.refType === 'Invoice') {
 const inv = db.invoices.find(i => i.id === v.referenceId);
 if (inv) {
 const cust = db.customers.find(c => c.id === inv.customerId);
 const bank = db.banks.find(b => b.id === inv.bankId);
 onPrintDoc('Invoice', { ...inv, customerData: cust, bankData: bank });
 }
 } else if (v.refType === 'Expense') {
 const exp = db.expenses.find(e => e.id === v.referenceId);
 if (exp) {
 const vend = db.vendors.find(v => v.id === exp.vendorId);
 const bank = db.banks.find(b => b.id === exp.bankId);
 onPrintDoc('Expense', { ...exp, vendorData: vend, bankData: bank });
 }
 }
 }}
 className="text-indigo-600 hover:text-indigo-800 hover:underline font-bold font-mono text-xs cursor-pointer"
 >
 {v.sourceDoc}
 </button>
 ) : (
 <span className="text-slate-400">-</span>
 )}
 </td>
 <td className="p-3 max-w-xs truncate">{v.description}</td>
 <td className="p-3 text-end text-emerald-600 font-mono font-bold">
 {v.debit > 0 ? `+${v.debit.toFixed(2)}` : '-'}
 </td>
 <td className="p-3 text-end text-rose-600 font-mono">
 {v.credit > 0 ? `-${v.credit.toFixed(2)}` : '-'}
 </td>
 <td className="p-3 text-end font-mono font-bold text-slate-900">{currencySymbol} {v.runningBalance.toFixed(2)}</td>
 </tr>
 );
 })
 )}
 <tr className="bg-slate-900 text-white font-bold border-t border-slate-950">
 <td colSpan={isAllBanks ? 8 : 7} className="p-3.5">{t("End-of-Period Verified Balance:")}</td>
 <td className="p-3.5 text-end font-mono text-emerald-400">{currencySymbol} {endingBalance.toFixed(2)}</td>
 </tr>
 </tbody>
 </table>
 </div>
 </div>
 );
 })()}

 {/* 5. Outstanding Aging & Balances viewport */}
 {reportType === 'Outstanding' && (() => {
 const { invoices, expenses } = getOutstandingData();
 
 const totalReceivable = invoices.reduce((sum, i) => sum + i.outstanding, 0);
 const totalPayable = expenses.reduce((sum, e) => sum + e.outstanding, 0);
 const netOutstanding = totalReceivable - totalPayable;

 return (
 <div className="space-y-8">
 <div className="text-center">
 <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">{t("Outstanding Accounts Aging & Balances")}</h3>
 <p className="text-[10px] text-slate-400 mt-1">{t("Status Report: Active Invoices & Expenses as of")} {endDate}</p>
 </div>

 {/* High-fidelity Stats Cards */}
 <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
 <div className="bg-slate-50 border border-slate-200/60 rounded-2xl p-4 flex items-center justify-between">
 <div>
 <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t("Outstanding Receivables (A/R)")}</span>
 <h4 className="text-xl font-black text-slate-900 font-mono mt-1">
 {currencySymbol} {totalReceivable.toFixed(2)}
 </h4>
 <p className="text-[10px] text-emerald-600 font-medium mt-0.5">{t("From")} {invoices.length} {invoices.length === 1 ? t('unpaid invoice') : t('unpaid invoices')}</p>
 </div>
 <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center text-emerald-600 shrink-0">
 <ArrowDownLeft className="w-5 h-5" />
 </div>
 </div>

 <div className="bg-slate-50 border border-slate-200/60 rounded-2xl p-4 flex items-center justify-between">
 <div>
 <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t("Outstanding Payables (A/P)")}</span>
 <h4 className="text-xl font-black text-slate-900 font-mono mt-1">
 {currencySymbol} {totalPayable.toFixed(2)}
 </h4>
 <p className="text-[10px] text-rose-600 font-medium mt-0.5">{t("To")} {expenses.length} {expenses.length === 1 ? t('unpaid expense') : t('unpaid expenses')}</p>
 </div>
 <div className="w-10 h-10 rounded-xl bg-rose-50 flex items-center justify-center text-rose-600 shrink-0">
 <ArrowUpRight className="w-5 h-5" />
 </div>
 </div>

 <div className="bg-slate-50 border border-slate-200/60 rounded-2xl p-4 flex items-center justify-between">
 <div>
 <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t("Net Outstanding Position")}</span>
 <h4 className={`text-xl font-black font-mono mt-1 ${netOutstanding >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
 {netOutstanding >= 0 ? '+' : ''}{currencySymbol} {netOutstanding.toFixed(2)}
 </h4>
 <p className="text-[10px] text-slate-500 font-medium mt-0.5">{t("Net cash projection")}</p>
 </div>
 <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
 netOutstanding >= 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'
 }`}>
 <TrendingUp className="w-5 h-5" />
 </div>
 </div>
 </div>

 {/* Twin Tables: Customer Receivables & Vendor Payables */}
 <div className="space-y-6">
 
 {/* 1. Customer Receivables Table */}
 <div className="border border-slate-200/80 rounded-xl overflow-hidden">
 <div className="bg-slate-50 px-4 py-3 border-b border-slate-200/80 flex items-center justify-between">
 <span className="text-xs font-extrabold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
 <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
 {t("Outstanding Customer Invoices (Receivables)")}
 </span>
 <span className="text-[10px] text-slate-400 font-mono">{t("Count:")} {invoices.length}</span>
 </div>

 <div className="overflow-x-auto">
 <table className="w-full text-xs text-start">
 <thead>
 <tr className="bg-slate-50/50 border-b border-slate-200 font-bold text-slate-500 uppercase text-[9px] tracking-wider">
 {renderSortableHeader(t('Invoice No'), 'docNumber')}
 {renderSortableHeader(t('Due Date'), 'date')}
 {renderSortableHeader(t('Customer Entity'), 'contactName')}
 {renderSortableHeader(t('Payment Status'), 'paymentStatus', 'center')}
 {renderSortableHeader(t('Total Bill'), 'total', 'right')}
 {renderSortableHeader(t('Amount Paid'), 'paid', 'right')}
 {renderSortableHeader(t('Balance Outstanding'), 'outstanding', 'right')}
 </tr>
 </thead>
 <tbody>
 {invoices.length === 0 ? (
 <tr>
 <td colSpan={7} className="p-8 text-center text-slate-400 bg-white">
 {t("No outstanding customer invoices found for selected criteria.")}
 </td>
 </tr>
 ) : (
 invoices.map((inv) => (
 <tr key={inv.id} className="border-b border-slate-100 hover:bg-slate-50/20 text-slate-700 bg-white">
 <td className="p-3">
 <button
 type="button"
 onClick={() => {
 const customer = db.customers.find(c => c.id === inv.original.customerId);
 const bank = db.banks.find(b => b.id === inv.original.bankId);
 onPrintDoc('Invoice', { ...inv.original, customerData: customer, bankData: bank });
 }}
 className="text-indigo-600 hover:text-indigo-800 hover:underline font-bold font-mono cursor-pointer"
 >
 {inv.docNumber}
 </button>
 </td>
 <td className="p-3">{inv.date}</td>
 <td className="p-3 font-semibold">{inv.contactName}</td>
 <td className="p-3 text-center">
 <span className={`px-2 py-0.5 rounded text-[9px] uppercase font-black ${
 inv.paymentStatus === 'Partially Paid' 
 ? 'bg-amber-50 text-amber-700 border border-amber-200' 
 : 'bg-rose-50 text-rose-700 border border-rose-200'
 }`}>
 {t(inv.paymentStatus)}
 </span>
 </td>
 <td className="p-3 text-end font-mono">{currencySymbol} {inv.total.toFixed(2)}</td>
 <td className="p-3 text-end font-mono text-slate-400">{currencySymbol} {inv.paid.toFixed(2)}</td>
 <td className="p-3 text-end font-mono font-bold text-rose-600 bg-rose-50/10">
 {currencySymbol} {inv.outstanding.toFixed(2)}
 </td>
 </tr>
 ))
 )}
 </tbody>
 </table>
 </div>
 </div>

 {/* 2. Vendor Payables Table */}
 <div className="border border-slate-200/80 rounded-xl overflow-hidden">
 <div className="bg-slate-50 px-4 py-3 border-b border-slate-200/80 flex items-center justify-between">
 <span className="text-xs font-extrabold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
 <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse"></span>
 {t("Outstanding Vendor Expenses (Payables)")}
 </span>
 <span className="text-[10px] text-slate-400 font-mono">{t("Count:")} {expenses.length}</span>
 </div>

 <div className="overflow-x-auto">
 <table className="w-full text-xs text-start">
 <thead>
 <tr className="bg-slate-50/50 border-b border-slate-200 font-bold text-slate-500 uppercase text-[9px] tracking-wider">
 {renderSortableHeader(t('Expense No'), 'docNumber')}
 {renderSortableHeader(t('Expense Date'), 'date')}
 {renderSortableHeader(t('Vendor / Supplier'), 'contactName')}
 {renderSortableHeader(t('Payment Status'), 'paymentStatus', 'center')}
 {renderSortableHeader(t('Total Bill'), 'total', 'right')}
 {renderSortableHeader(t('Amount Paid'), 'paid', 'right')}
 {renderSortableHeader(t('Outstanding Balance'), 'outstanding', 'right')}
 </tr>
 </thead>
 <tbody>
 {expenses.length === 0 ? (
 <tr>
 <td colSpan={7} className="p-8 text-center text-slate-400 bg-white">
 {t("No outstanding vendor expenses found for selected criteria.")}
 </td>
 </tr>
 ) : (
 expenses.map((exp) => (
 <tr key={exp.id} className="border-b border-slate-100 hover:bg-slate-50/20 text-slate-700 bg-white">
 <td className="p-3">
 <button
 type="button"
 onClick={() => {
 const vendor = db.vendors.find(v => v.id === exp.original.vendorId);
 const bank = db.banks.find(b => b.id === exp.original.bankId);
 onPrintDoc('Expense', { ...exp.original, vendorData: vendor, bankData: bank });
 }}
 className="text-indigo-600 hover:text-indigo-800 hover:underline font-bold font-mono cursor-pointer"
 >
 {exp.docNumber}
 </button>
 </td>
 <td className="p-3">{exp.date}</td>
 <td className="p-3 font-semibold">{exp.contactName}</td>
 <td className="p-3 text-center">
 <span className={`px-2 py-0.5 rounded text-[9px] uppercase font-black ${
 exp.paymentStatus === 'Partially Paid'
 ? 'bg-amber-50 text-amber-700 border border-amber-200'
 : 'bg-rose-50 text-rose-700 border border-rose-200'
 }`}>
 {t(exp.paymentStatus)}
 </span>
 </td>
 <td className="p-3 text-end font-mono">{currencySymbol} {exp.total.toFixed(2)}</td>
 <td className="p-3 text-end font-mono text-emerald-600">
 {currencySymbol} {exp.paid.toFixed(2)}
 </td>
 <td className="p-3 text-end font-mono font-bold text-rose-600 bg-rose-50/10">
 {currencySymbol} {exp.outstanding.toFixed(2)}
 </td>
 </tr>
 ))
 )}
 </tbody>
 </table>
 </div>
 </div>

 </div>
 </div>
 );
 })()}

 {reportType === 'ProfitLoss' && (() => {
 const data = getProfitLossData();
 return (
 <div className="space-y-6">
 {/* Header and Toggle */}
 <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
 <div>
 <h3 className="text-sm font-black text-slate-800 uppercase tracking-widest flex items-center gap-2">
 <TrendingUp className="w-5 h-5 text-indigo-600" />
 {t("Profit & Loss Statement")}
 </h3>
 <p className="text-xs text-slate-500 mt-1 font-medium">
 {t("Comprehensive financial performance and cash flow analysis.")}
 </p>
 </div>
 
 <div className="flex items-center gap-2 bg-slate-100 p-1 rounded-xl">
 <button
 onClick={() => setAccountingBasis('Accrual')}
 className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${
 accountingBasis === 'Accrual'
 ? 'bg-white text-indigo-600 shadow-sm'
 : 'text-slate-500 hover:text-slate-700'
 }`}
 >
 {t("Accrual Basis")}
 </button>
 <button
 onClick={() => setAccountingBasis('Cash')}
 className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${
 accountingBasis === 'Cash'
 ? 'bg-white text-indigo-600 shadow-sm'
 : 'text-slate-500 hover:text-slate-700'
 }`}
 >
 {t("Cash Basis")}
 </button>
 </div>
 </div>

 <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
 {/* Profit & Loss Block */}
 <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-sm">
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-3 mb-4 flex items-center gap-2">
 <span className="w-2 h-2 rounded-full bg-indigo-500"></span>
 {t("Income Statement")}
 </h4>
 
 <div className="space-y-3">
 <div className="flex justify-between items-center py-2 border-b border-slate-50 ">
 <span className="text-xs text-slate-500 font-medium">{t("Total Revenue")}</span>
 <span className="text-sm font-bold text-slate-800 ">{currencySymbol} {data.totalRevenue.toFixed(2)}</span>
 </div>
 <div className="flex justify-between items-center py-2 border-b border-slate-50 ">
 <span className="text-xs text-slate-500 font-medium">{t("Total Expenses")}</span>
 <span className="text-sm font-bold text-rose-600">{currencySymbol} {data.totalExpenses.toFixed(2)}</span>
 </div>
 <div className="flex justify-between items-center py-3 mt-2 bg-indigo-50/50 px-4 rounded-xl">
 <span className="text-xs font-black text-indigo-900 uppercase tracking-wider">{t("Net Profit")}</span>
 <span className={`text-base font-black ${data.netProfit >= 0 ? 'text-indigo-700 ' : 'text-rose-600'}`}>
 {currencySymbol} {data.netProfit.toFixed(2)}
 </span>
 </div>
 </div>
 
 {data.investorShares.length > 0 && (
 <div className="mt-6 pt-5 border-t border-slate-100 ">
 <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">{t("Investor Profit Share")}</h4>
 <div className="space-y-2">
 {data.investorShares.map((inv, idx) => (
 <div key={idx} className="flex justify-between items-center p-2 hover:bg-slate-50 :bg-slate-800/50 rounded-lg transition-colors">
 <div className="flex items-center gap-2">
 <span className="text-xs font-bold text-slate-700 ">{inv.name}</span>
 <span className="px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded text-[9px] font-black">{inv.profitPercentage}%</span>
 </div>
 <span className="text-xs font-bold text-indigo-600 ">{currencySymbol} {inv.shareAmount.toFixed(2)}</span>
 </div>
 ))}
 </div>
 </div>
 )}
 </div>

 {/* Cash Flow Block */}
 <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-sm">
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-3 mb-4 flex items-center gap-2">
 <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
 {t("Cash Flow Analysis")}
 </h4>
 
 <div className="space-y-3">
 <div className="flex justify-between items-center py-2 border-b border-slate-50 ">
 <span className="text-xs text-slate-500 font-medium">{t("Operating Inflows")}</span>
 <span className="text-sm font-bold text-emerald-600">+{currencySymbol} {data.operatingInflows.toFixed(2)}</span>
 </div>
 <div className="flex justify-between items-center py-2 border-b border-slate-50 ">
 <span className="text-xs text-slate-500 font-medium">{t("Operating Outflows")}</span>
 <span className="text-sm font-bold text-rose-600">-{currencySymbol} {data.operatingOutflows.toFixed(2)}</span>
 </div>
 <div className="flex justify-between items-center py-2 border-b border-slate-50 ">
 <span className="text-xs text-slate-500 font-medium">{t("Investing Outflows (CapEx)")}</span>
 <span className="text-sm font-bold text-rose-600">-{currencySymbol} {data.investingOutflows.toFixed(2)}</span>
 </div>
 <div className="flex justify-between items-center py-2 border-b border-slate-50 ">
 <span className="text-xs text-slate-500 font-medium">{t("Financing Inflows (Equity)")}</span>
 <span className="text-sm font-bold text-emerald-600">+{currencySymbol} {data.financingInflows.toFixed(2)}</span>
 </div>
 
 <div className="flex justify-between items-center py-3 mt-2 bg-emerald-50/50 px-4 rounded-xl">
 <span className="text-xs font-black text-emerald-900 uppercase tracking-wider">{t("Net Cash Flow")}</span>
 <span className={`text-base font-black ${data.netCashFlow >= 0 ? 'text-emerald-700 ' : 'text-rose-600'}`}>
 {currencySymbol} {data.netCashFlow.toFixed(2)}
 </span>
 </div>
 </div>
 </div>
 </div>
 </div>
 );
 })()}

 {/* Balance Sheet viewport */}
 {reportType === 'BalanceSheet' && (() => {
 const data = getBalanceSheetData();
 return (
 <div className="space-y-6">
 <div className="text-center">
 <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">{t('Balance Sheet')}</h3>
 <p className="text-[10px] text-slate-400 mt-1">{t('As of')} {data.asOfDate}</p>
 </div>
 <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
 <div className="bg-white border border-slate-200 rounded-3xl p-5 shadow-sm space-y-3">
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-2">{t('Assets')}</h4>
 <div className="flex justify-between text-xs"><span className="text-slate-500">{t('Bank Balances')}</span><span className="font-bold">{currencySymbol} {data.bankBalance.toFixed(2)}</span></div>
 <div className="flex justify-between text-xs"><span className="text-slate-500">{t('Accounts Receivable')}</span><span className="font-bold">{currencySymbol} {data.accountsReceivable.toFixed(2)}</span></div>
 <div className="flex justify-between text-xs"><span className="text-slate-500">{t('Inventory Value')}</span><span className="font-bold">{currencySymbol} {data.inventoryValue.toFixed(2)}</span></div>
 <div className="flex justify-between items-center py-2 mt-1 bg-indigo-50/60 px-3 rounded-xl"><span className="text-[10px] font-black text-indigo-900 uppercase">{t('Total Assets')}</span><span className="text-sm font-black text-indigo-700">{currencySymbol} {data.totalAssets.toFixed(2)}</span></div>
 </div>
 <div className="bg-white border border-slate-200 rounded-3xl p-5 shadow-sm space-y-3">
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-2">{t('Liabilities')}</h4>
 <div className="flex justify-between text-xs"><span className="text-slate-500">{t('Accounts Payable')}</span><span className="font-bold">{currencySymbol} {data.accountsPayable.toFixed(2)}</span></div>
 <div className="flex justify-between items-center py-2 mt-1 bg-rose-50/60 px-3 rounded-xl"><span className="text-[10px] font-black text-rose-900 uppercase">{t('Total Liabilities')}</span><span className="text-sm font-black text-rose-700">{currencySymbol} {data.totalLiabilities.toFixed(2)}</span></div>
 </div>
 <div className="bg-white border border-slate-200 rounded-3xl p-5 shadow-sm space-y-3">
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-2">{t('Equity')}</h4>
 <div className="flex justify-between text-xs"><span className="text-slate-500">{t('Capital Contributed')}</span><span className="font-bold">{currencySymbol} {data.capitalContributed.toFixed(2)}</span></div>
 <div className="flex justify-between text-xs"><span className="text-slate-500">{t('Retained Earnings')}</span><span className="font-bold">{currencySymbol} {data.retainedEarnings.toFixed(2)}</span></div>
 <div className="flex justify-between items-center py-2 mt-1 bg-emerald-50/60 px-3 rounded-xl"><span className="text-[10px] font-black text-emerald-900 uppercase">{t('Total Equity')}</span><span className="text-sm font-black text-emerald-700">{currencySymbol} {data.totalEquity.toFixed(2)}</span></div>
 </div>
 </div>
 <p className="text-[10px] text-slate-400 text-center">
 {t('Assets − (Liabilities + Equity) balance check:')} <span className={`font-bold ${Math.abs(data.balanceCheck) < 0.01 ? 'text-emerald-600' : 'text-amber-600'}`}>{currencySymbol} {data.balanceCheck.toFixed(2)}</span>
 </p>
 </div>
 );
 })()}

 {/* VAT Return Summary viewport */}
 {reportType === 'VatReturnSummary' && (() => {
 const data = getVatReturnSummaryData();
 return (
 <div className="space-y-6">
 <div className="text-center">
 <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">{t('VAT Return Summary')}</h3>
 <p className="text-[10px] text-slate-400 mt-1">{t('Filing Period:')} {data.startDate} {t('to')} {data.endDate}</p>
 </div>
 <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
 <div className="bg-white border border-slate-200 rounded-3xl p-5 shadow-sm">
 <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Output VAT (Sales)')}</p>
 <p className="text-lg font-black text-slate-900 mt-1">{currencySymbol} {data.outputVat.toFixed(2)}</p>
 <p className="text-[10px] text-slate-400 mt-1">{data.salesCount} {t('invoices')}</p>
 </div>
 <div className="bg-white border border-slate-200 rounded-3xl p-5 shadow-sm">
 <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Input VAT (Purchases)')}</p>
 <p className="text-lg font-black text-slate-900 mt-1">{currencySymbol} {data.inputVat.toFixed(2)}</p>
 <p className="text-[10px] text-slate-400 mt-1">{data.purchaseCount} {t('expenses')}</p>
 </div>
 <div className={`rounded-3xl p-5 shadow-sm ${data.netVatPayable >= 0 ? 'bg-indigo-600' : 'bg-emerald-600'}`}>
 <p className="text-[10px] font-bold text-white/70 uppercase tracking-wider">{data.netVatPayable >= 0 ? t('Net VAT Payable') : t('Net VAT Refundable')}</p>
 <p className="text-lg font-black text-white mt-1">{currencySymbol} {Math.abs(data.netVatPayable).toFixed(2)}</p>
 </div>
 </div>
 </div>
 );
 })()}

 {/* Investor Profit Share viewport */}
 {reportType === 'InvestorProfitShare' && (() => {
 const data = getInvestorProfitShareData();
 return (
 <div className="space-y-6">
 <div className="text-center">
 <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">{t('Investor Profit Share')}</h3>
 <p className="text-[10px] text-slate-400 mt-1">{t('Period:')} {data.startDate} {t('to')} {data.endDate} — {t('Net Profit:')} {currencySymbol} {data.netProfit.toFixed(2)}</p>
 </div>
 {data.investorShares.length === 0 ? (
 <p className="text-xs text-slate-400 text-center py-8">{t('No investors on file for this company.')}</p>
 ) : (
 <div className="overflow-x-auto">
 <table className="w-full text-xs text-start">
 <thead>
 <tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]">
 <th className="p-3">{t('Investor')}</th>
 <th className="p-3 text-end">{t('Profit %')}</th>
 <th className="p-3 text-end">{t('Share Amount')} ({currencySymbol})</th>
 </tr>
 </thead>
 <tbody>
 {data.investorShares.map((inv: any, i: number) => (
 <tr key={i} className="border-b border-slate-100 text-slate-700">
 <td className="p-3 font-semibold">{inv.name}</td>
 <td className="p-3 text-end font-mono">{inv.profitPercentage}%</td>
 <td className="p-3 text-end font-mono font-bold text-emerald-600">{currencySymbol} {inv.shareAmount.toFixed(2)}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 )}
 </div>
 );
 })()}

 {/* Fiscal Month Closing History viewport */}
 {reportType === 'FiscalMonthClosingHistory' && (() => {
 const data = getFiscalMonthClosingHistoryData();
 return (
 <div className="space-y-6">
 <div className="text-center">
 <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">{t('Fiscal Month Closing History')}</h3>
 </div>
 {data.months.length === 0 ? (
 <p className="text-xs text-slate-400 text-center py-8">{t('No fiscal months have been closed yet.')}</p>
 ) : (
 <div className="overflow-x-auto">
 <table className="w-full text-xs text-start">
 <thead>
 <tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]">
 <th className="p-3">{t('Month')}</th>
 <th className="p-3">{t('Closed At')}</th>
 <th className="p-3 text-end">{t('Revenue')} ({currencySymbol})</th>
 <th className="p-3 text-end">{t('Expenses')} ({currencySymbol})</th>
 <th className="p-3 text-end">{t('Net Profit')} ({currencySymbol})</th>
 </tr>
 </thead>
 <tbody>
 {data.months.map((m: any) => (
 <tr key={m.id} className="border-b border-slate-100 text-slate-700">
 <td className="p-3 font-semibold">{m.name}</td>
 <td className="p-3 text-slate-500">{m.closedAt ? String(m.closedAt).split('T')[0] : '-'}</td>
 <td className="p-3 text-end font-mono">{currencySymbol} {Number(m.closedPnL?.totalRevenue || 0).toFixed(2)}</td>
 <td className="p-3 text-end font-mono">{currencySymbol} {Number(m.closedPnL?.totalExpenses || 0).toFixed(2)}</td>
 <td className="p-3 text-end font-mono font-bold text-emerald-600">{currencySymbol} {Number(m.closedPnL?.netProfit || 0).toFixed(2)}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 )}
 </div>
 );
 })()}

 </div>
 </>
 )}
 </div>
 );
}
