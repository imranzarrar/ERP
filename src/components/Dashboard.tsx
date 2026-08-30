import { motion } from 'motion/react';
import React from 'react';
import { useTranslation, translateMonthLabel } from '../hooks';
import { DatabaseState, getActiveOpenMonth, getOpenMonths, calculateInvoiceTotals, getBankBalance, getInvoiceSign } from '../dbStore';
import { AreaChart, Area, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import {
 TrendingUp,
 TrendingDown,
 DollarSign,
 Briefcase,
 Layers,
 FileCheck,
 CheckCircle,
 AlertTriangle,
 ArrowUpRight,
 ShieldAlert,
 ListCollapse,
 Activity,
 Plus,
 Compass
} from 'lucide-react';

// Categorical series colors for "top N entities" breakdown charts (Top Customers, Top
// Vendors) — reuses the app's existing semantic hues rather than introducing new brand
// colors, cycled per bar so entities are visually distinguishable instead of one flat tone.
const CHART_PALETTE = ['#4f46e5', '#059669', '#d97706', '#0891b2', '#e11d48'];

interface DashboardProps {
 db: DatabaseState;
 onNavigate: (tab: string) => void;
 lastSyncTimes?: { meta: string | null, invoices: string | null, quotations: string | null, expenses: string | null };
}

export default function Dashboard({ db, onNavigate, lastSyncTimes }: DashboardProps) {
 const { t, isRTL, lang } = useTranslation(db);
 const currentUser = db.currentUser || { id: '', username: 'User', role: 'user', isSuperAdmin: false, permissions: {} as any };
 const isAdmin = currentUser?.role === 'admin' || currentUser?.isSuperAdmin === true;
 const openMonth = getActiveOpenMonth(db);
 // Several fiscal months can be open concurrently now (cap of 3); openMonth is the oldest of
 // them (the only one currently eligible to close). Show a count when more than one is open
 // so "Active Session Month" doesn't read as if it's the only open period.
 const openMonthsCount = getOpenMonths(db).length;
 const currencySymbol = db.companySetup?.currency || 'SAR';
 const companyInvestors = (db.investors || []).filter(i => i.companyId === db.selectedCompanyId);

 // The API caps invoices/expenses/vouchers/quotations at DEFAULT_LIST_LIMIT per list
 // (see server/lib/pagination.ts, currently 500). If any of these arrays are sitting at
 // that cap, KPIs below may be silently missing older records - surface it instead of
 // implying completeness. This is a read of already-fetched in-memory data, no new query.
 const RECORD_LIST_CAP = 500;
 const isDataPossiblyTruncated = [db.invoices, db.expenses, db.vouchers, db.quotations]
 .some(list => Array.isArray(list) && list.length >= RECORD_LIST_CAP);

 // Available fiscal fiscalMonths list
const [fiscalMonths, setFiscalMonths] = React.useState<any[]>([]);
  const availableMonths = Array.isArray(fiscalMonths) ? fiscalMonths : [];
  const fetchMonths = async () => {
    if (!db.selectedCompanyId) return;
    try {
      const resp = await fetch(`/api/transactions/months?companyId=${db.selectedCompanyId}`);
      if (!resp.ok) {
        console.warn(`Failed to fetch fiscalMonths in Dashboard (status ${resp.status})`);
        return;
      }
      const contentType = resp.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        console.warn("Received non-JSON response for fiscalMonths in Dashboard");
        return;
      }
      const data = await resp.json();
      if (Array.isArray(data)) {
        setFiscalMonths(data);
      } else {
        console.warn("Received non-array data for fiscal months in Dashboard:", data);
        setFiscalMonths([]);
      }
    } catch (e) {
      console.error("Failed to fetch fiscalMonths in Dashboard:", e);
      setFiscalMonths([]);
    }
  };
  React.useEffect(() => { fetchMonths(); }, [db.selectedCompanyId]);

 // Month filter state (defaults to open month ID if open, otherwise 'all')
 const [selectedMonthFilter, setSelectedMonthFilter] = React.useState<string>(() => {
 return openMonth ? openMonth.id : 'all';
 });

 // Keep state in sync with company switch and active open month changes
 React.useEffect(() => {
 setSelectedMonthFilter(openMonth ? openMonth.id : 'all');
 }, [db.selectedCompanyId, openMonth?.id]);

 // Quick reporting-period presets, layered on top of the exact-month dropdown above
 // rather than replacing it — 'month' defers entirely to selectedMonthFilter (preserving
 // the original single-month/all-months behavior byte-for-byte), while 'last3'/'year' are
 // genuinely new ranges the dropdown alone can't express.
 type PeriodMode = 'month' | 'last3' | 'year';
 const [periodMode, setPeriodMode] = React.useState<PeriodMode>('month');
 const todayRealDate = new Date();
 const currentCalendarYear = String(todayRealDate.getFullYear());
 const last3MonthIds = React.useMemo(() => {
 const anchor = openMonth ? new Date(`${openMonth.id}-01T00:00:00`) : todayRealDate;
 const ids: string[] = [];
 for (let i = 0; i < 3; i++) {
 const d = new Date(anchor.getFullYear(), anchor.getMonth() - i, 1);
 ids.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
 }
 return ids;
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [openMonth?.id]);
 const matchesPeriod = (dateStr: string): boolean => {
 if (periodMode === 'last3') return last3MonthIds.some(id => dateStr.startsWith(id));
 if (periodMode === 'year') return dateStr.startsWith(currentCalendarYear);
 return selectedMonthFilter === 'all' ? true : dateStr.startsWith(selectedMonthFilter);
 };

 // Filter invoices and quotations
 const monthInvoices = db.invoices.filter(inv => {
 const invCompanyId = inv.companyId;
 if (invCompanyId !== db.selectedCompanyId) return false;

 if (!matchesPeriod(inv.date)) return false;

 if (isAdmin || currentUser?.permissions?.invoice) return true;
 return currentUser?.id ? inv.createdById === currentUser.id : false;
 });

 const monthExpenses = db.expenses.filter(exp => {
 const expCompanyId = exp.companyId;
 if (expCompanyId !== db.selectedCompanyId) return false;

 if (!matchesPeriod(exp.date)) return false;

 if (isAdmin || currentUser?.permissions?.expense) return true;
 return currentUser?.id ? exp.createdById === currentUser.id : false;
 });

 const monthQuotations = db.quotations.filter(q => {
 const qCompanyId = q.companyId;
 if (qCompanyId !== db.selectedCompanyId) return false;

 if (!matchesPeriod(q.date)) return false;

 if (isAdmin || currentUser?.permissions?.quotation) return true;
 return currentUser?.id ? q.createdById === currentUser.id : false;
 });

 // Calculations
  const monthVouchers = db.vouchers.filter(v => {
    const vCompId = v.companyId;
    if (vCompId !== db.selectedCompanyId) return false;
    return matchesPeriod(v.date);
  });

  const totalSales = monthInvoices
    .filter(inv => inv.status === 'Active')
    .reduce((sum, inv) => {
      const totals = calculateInvoiceTotals(db, inv.items, inv.taxSlabId);
      return sum + totals.grandTotal * getInvoiceSign(inv);
    }, 0);

  const pendingCollection = db.invoices
    .filter(inv => {
      const invCompanyId = inv.companyId;
      if (invCompanyId !== db.selectedCompanyId) return false;
      // A Credit Note is never itself a receivable — it always carries amountPaid: 0
      // (schema default, never meaningful, see the note in InvoiceModule.tsx), so
      // `grandTotal - amountPaid` is its full positive amount, then getInvoiceSign flips
      // that to a large NEGATIVE "pending collection" instead of correctly contributing
      // nothing. The actual reduction in what's owed already happened by not incrementing
      // amountPaid on any invoice this CN reverses; excluding CN rows here avoids
      // double-counting that reduction a second time as a negative KPI.
      return inv.status === 'Active' && inv.documentType !== 'CreditNote';
    })
    .reduce((sum, inv) => {
      const totals = calculateInvoiceTotals(db, inv.items, inv.taxSlabId);
      return sum + (totals.grandTotal - (inv.amountPaid || 0)) * getInvoiceSign(inv);
    }, 0);

  const receivedSales = monthVouchers
    .filter(v => v.referenceType === 'Invoice' && v.type === 'Receipt')
    .reduce((sum, v) => sum + v.amount, 0) -
    monthVouchers
    .filter(v => v.referenceType === 'Invoice' && v.type === 'Reversal')
    .reduce((sum, v) => sum + v.amount, 0);

  const totalExpenseActual = monthExpenses
    .filter(exp => exp.status === 'Active' && exp.type === 'Actual' && exp.classification !== 'Asset')
    .reduce((sum, exp) => sum + exp.amount, 0);

  const paidExpenseActual = monthVouchers
    .filter(v => v.referenceType === 'Expense' && v.type === 'Payment')
    .reduce((sum, v) => sum + v.amount, 0) -
    monthVouchers
    .filter(v => v.referenceType === 'Expense' && v.type === 'Reversal')
    .reduce((sum, v) => sum + v.amount, 0);

  const totalExpenseAccrual = monthExpenses
    .filter(exp => exp.status === 'Active' && exp.type === 'Accrual' && exp.classification !== 'Asset')
    .reduce((sum, exp) => sum + exp.amount, 0);

  const totalExpensesCombined = totalExpenseActual + totalExpenseAccrual;

 const totalAssetCapEx = monthExpenses
 .filter(exp => exp.status === 'Active' && exp.classification === 'Asset')
 .reduce((sum, exp) => sum + exp.amount, 0);

 // Simple Net Profit Margin
 const netProfit = totalSales - totalExpenseActual;
 const netProfitMargin = totalSales > 0 ? (netProfit / totalSales) * 100 : 0;

 // Active bank balances combined (Admin only)
 const totalBankCapital = db.banks
 .filter(b => b.companyId === db.selectedCompanyId && b.isActive)
 .reduce((sum, b) => sum + getBankBalance(db, b.id), 0);

 // Recharts Chart Data (e.g. daily sales of the current month)
 // Let's group monthInvoices by date to get a timeline
 const dailyDataMap: { [date: string]: { date: string; Sales: number; Expenses: number } } = {};
 
 // Seed last 10 days for nice visualization — only meaningful for a single-month view;
 // Last-3-Months/This-Year span multiple months, where a "Day 01/04/07..." x-axis would
 // misleadingly overlay unrelated months on the same tick.
 const getDaysArray = () => {
 const base = selectedMonthFilter !== 'all' ? selectedMonthFilter : (openMonth ? openMonth.id : '2026-06');
 for (let i = 1; i <= 28; i += 3) {
 const dateStr = `${base}-${i.toString().padStart(2, '0')}`;
 dailyDataMap[dateStr] = { date: dateStr.replace(`${base}-`, 'Day '), Sales: 0, Expenses: 0 };
 }
 };
 if (periodMode === 'month') getDaysArray();

 monthInvoices.filter(inv => inv.status === 'Active').forEach(inv => {
 const key = inv.date;
 const totals = calculateInvoiceTotals(db, inv.items, inv.taxSlabId);
 const signedTotal = totals.grandTotal * getInvoiceSign(inv);
 if (dailyDataMap[key]) {
 dailyDataMap[key].Sales += signedTotal;
 } else {
 dailyDataMap[key] = { date: key.slice(5), Sales: signedTotal, Expenses: 0 };
 }
 });

 monthExpenses.filter(exp => exp.status === 'Active').forEach(exp => {
 const key = exp.date;
 if (dailyDataMap[key]) {
 dailyDataMap[key].Expenses += exp.amount;
 } else {
 dailyDataMap[key] = { date: key.slice(5), Sales: 0, Expenses: exp.amount };
 }
 });

 const chartData = Object.values(dailyDataMap).sort((a, b) => a.date.localeCompare(b.date));

 // Real ZATCA compliance signal: count invoices in the current filtered period whose
 // e-invoicing submission actually failed, so this can never silently claim "all good".
 const zatcaEligibleInvoices = monthInvoices.filter(inv => inv.status === 'Active');
 const zatcaFailedInvoices = zatcaEligibleInvoices.filter(inv => inv.zatcaStatus === 'ERROR' || inv.zatcaStatus === 'REJECTED');
 const zatcaFailureCount = zatcaFailedInvoices.length;
 const zatcaOk = zatcaFailureCount === 0;

 // Real investor capital-reconciliation signal (same math as the Partners' Equity panel
 // above): flags a genuine mismatch rather than a hardcoded "active" claim.
 const investorTotalContributed = companyInvestors.reduce((sum, inv) => {
 const actual = db.vouchers
 .filter(v => v.referenceType === 'Equity' && v.referenceId === inv.id)
 .reduce((vSum, v) => vSum + v.amount, 0);
 return sum + actual;
 }, 0);
 const investorHasImbalance = companyInvestors.length > 0 && (
 investorTotalContributed === 0 ||
 companyInvestors.some(inv => {
 const actual = db.vouchers
 .filter(v => v.referenceType === 'Equity' && v.referenceId === inv.id)
 .reduce((vSum, v) => vSum + v.amount, 0);
 const targetShare = (investorTotalContributed * inv.equityPercentage) / 100;
 return Math.abs(targetShare - actual) > 0.01;
 })
 );

 // User Targets - derived from the trailing average of actual monthly closed sales so
 // every company sees a target grounded in its own history rather than an identical
 // hardcoded number. Falls back to a modest placeholder only when there's no history yet.
 const closedMonthIds = availableMonths
 .filter(m => m.status === 'Closed' && m.id !== openMonth?.id)
 .map(m => m.id)
 .sort()
 .slice(-3);
 const trailingMonthlySales = closedMonthIds.map(monthId =>
 db.invoices
 .filter(inv => inv.companyId === db.selectedCompanyId && inv.status === 'Active' && inv.date.startsWith(monthId))
 .reduce((sum, inv) => {
 const totals = calculateInvoiceTotals(db, inv.items, inv.taxSlabId);
 return sum + totals.grandTotal * getInvoiceSign(inv);
 }, 0)
 );
 const hasHistoricalTarget = trailingMonthlySales.length > 0;
 const salesTarget = hasHistoricalTarget
 ? trailingMonthlySales.reduce((sum, v) => sum + v, 0) / trailingMonthlySales.length
 : 2500;
 const trailingMonthlyQuotations = closedMonthIds.map(monthId =>
 db.quotations.filter(q => q.companyId === db.selectedCompanyId && q.date.startsWith(monthId)).length
 );
 const hasHistoricalQuotaTarget = trailingMonthlyQuotations.length > 0;
 const quotaTarget = hasHistoricalQuotaTarget
 ? Math.max(1, Math.round(trailingMonthlyQuotations.reduce((sum, v) => sum + v, 0) / trailingMonthlyQuotations.length))
 : 5;
 const quotaProgress = Math.min((monthQuotations.length / quotaTarget) * 100, 100);
 const salesProgress = salesTarget > 0 ? Math.min((totalSales / salesTarget) * 100, 100) : 0;

 // Pending Invoices / Pending Expenses — deliberately company-wide (not gated by the
 // reporting period filter above), same reasoning as `pendingCollection`: what's actually
 // owed right now doesn't reset just because the admin is looking at a different month.
 const todayMs = Date.now();
 const daysOutstanding = (dateStr: string) => Math.max(0, Math.floor((todayMs - new Date(`${dateStr}T00:00:00`).getTime()) / 86400000));

 const pendingInvoicesBase = db.invoices
 .filter(inv => inv.companyId === db.selectedCompanyId && inv.status === 'Active' && (inv.documentType === undefined || inv.documentType === 'Invoice'))
 .map(inv => {
 const totals = calculateInvoiceTotals(db, inv.items, inv.taxSlabId);
 const due = totals.grandTotal - (inv.amountPaid || 0);
 return { inv, due, grandTotal: totals.grandTotal };
 })
 .filter(x => x.due > 0.01);
 const pendingInvoicesList = [...pendingInvoicesBase]
 .sort((a, b) => a.inv.date.localeCompare(b.inv.date))
 .slice(0, 8);
 const pendingInvoicesTotal = pendingInvoicesBase.reduce((sum, x) => sum + x.due, 0);
 // Aging buckets for the pictogram strip — same day thresholds already used per-row below
 // (>30 overdue, >14 aging), just aggregated into counts instead of per-invoice text.
 const pendingInvoicesAging = pendingInvoicesBase.reduce((acc, x) => {
 const days = daysOutstanding(x.inv.date);
 if (days > 30) acc.overdue++;
 else if (days > 14) acc.aging++;
 else acc.onTime++;
 return acc;
 }, { onTime: 0, aging: 0, overdue: 0 });
 // Caps rendered icons per bucket so a company with hundreds of open invoices doesn't
 // blow out the card layout — overflow collapses to a "+N" label instead of more squares.
 const renderAgingPictogram = (count: number, colorClass: string, cap: number = 10) => {
 const shown = Math.min(count, cap);
 const overflow = count - shown;
 return (
 <span className="inline-flex items-center gap-0.5">
 {Array.from({ length: shown }).map((_, i) => (
 <span key={i} className={`w-2.5 h-2.5 rounded-[3px] ${colorClass}`} />
 ))}
 {overflow > 0 && <span className="text-[9px] font-bold text-slate-400 ms-0.5">+{overflow}</span>}
 </span>
 );
 };

 const pendingExpensesList = db.expenses
 .filter(exp => exp.companyId === db.selectedCompanyId && exp.status === 'Active' && exp.type === 'Actual')
 .map(exp => ({ exp, due: exp.amount - (exp.amountPaid || 0) }))
 .filter(x => x.due > 0.01)
 .sort((a, b) => a.exp.date.localeCompare(b.exp.date))
 .slice(0, 8);
 const pendingExpensesTotal = db.expenses
 .filter(exp => exp.companyId === db.selectedCompanyId && exp.status === 'Active' && exp.type === 'Actual')
 .reduce((sum, exp) => sum + Math.max(0, exp.amount - (exp.amountPaid || 0)), 0);
 const accrualsAwaitingSettlement = db.expenses.filter(exp =>
 exp.companyId === db.selectedCompanyId && exp.status === 'Active' && exp.type === 'Accrual' && !exp.accrualSettled
 ).length;

 // Top Customers by Sales / Top Vendors by Expense — respects the active reporting period,
 // unlike the pending lists above (this is a "who mattered this period" breakdown, not a
 // point-in-time balance).
 const topCustomersBySales = (() => {
 const byCustomer = new Map<string, number>();
 monthInvoices.filter(inv => inv.status === 'Active').forEach(inv => {
 const totals = calculateInvoiceTotals(db, inv.items, inv.taxSlabId);
 byCustomer.set(inv.customerId, (byCustomer.get(inv.customerId) || 0) + totals.grandTotal * getInvoiceSign(inv));
 });
 return Array.from(byCustomer.entries())
 .map(([customerId, amount]) => ({
 name: db.customers.find(c => c.id === customerId)?.name || t('Unknown Customer'),
 amount
 }))
 .sort((a, b) => b.amount - a.amount)
 .slice(0, 5);
 })();

 const topVendorsByExpense = (() => {
 const byVendor = new Map<string, number>();
 monthExpenses.filter(exp => exp.status === 'Active' && exp.type === 'Actual').forEach(exp => {
 byVendor.set(exp.vendorId, (byVendor.get(exp.vendorId) || 0) + exp.amount);
 });
 return Array.from(byVendor.entries())
 .map(([vendorId, amount]) => ({
 name: db.vendors.find(v => v.id === vendorId)?.name || t('Unknown Vendor'),
 amount
 }))
 .sort((a, b) => b.amount - a.amount)
 .slice(0, 5);
 })();

 return (
 <div className="space-y-6">

 {/* Header block with welcome */}
 <div className="bg-gradient-to-br from-indigo-950 to-indigo-800 text-white rounded-[32px] p-8 md:p-10 relative overflow-hidden shadow-2xl border border-indigo-500/20 ring-1 ring-white/10">
 <div className="absolute end-0 bottom-0 top-0 w-1/3 opacity-10 bg-radial-at-br from-indigo-500 to-transparent pointer-events-none"></div>
 <div className="relative z-10 flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
 <div>
 <span className="px-2.5 py-0.5 bg-indigo-500/20 border border-indigo-400/30 text-indigo-400 rounded-full text-[10px] font-bold uppercase tracking-wider">
 {currentUser.role === 'admin' ? t('Administrative Portal') : t('Staff Fabrication Workshop')}
 </span>
 <h2 className="text-xl md:text-2xl font-bold mt-2 font-sans tracking-tight">
 {t('Welcome back, ')}{currentUser.username}!
 </h2>
 <p className="text-xs text-slate-400 mt-1">
 {t('Active Session Month:')} <strong className="text-slate-200">{openMonth ? `${translateMonthLabel(openMonth.name, t)} (${openMonth.id})` : t('None Open')}</strong>
 {openMonthsCount > 1 && <span className="text-indigo-300"> (+{openMonthsCount - 1} more open)</span>}
 </p>
 </div>
 
 {/* Dynamic Month Reporting Dropdown Selector */}
 <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4 shrink-0">
 <div className="flex flex-col gap-1">
 <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider">{t('Command Reporting Filter')}</span>
 <div className="flex flex-wrap items-center gap-1.5">
 <select
 id="cmd-reporting-filter"
 value={selectedMonthFilter}
 onChange={(e) => { setSelectedMonthFilter(e.target.value); setPeriodMode('month'); }}
 className="bg-slate-800 border border-slate-700 text-slate-200 font-bold text-xs rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer min-w-[200px]"
 >
 <option value="all">📊 {t('All Months Combined')}</option>
 {availableMonths.map(m => (
 <option key={m.id} value={m.id}>
 📅 {translateMonthLabel(m.name, t)} ({m.status === 'Open' ? t('Open') : t('Closed')})
 </option>
 ))}
 </select>
 <button
 type="button"
 onClick={() => setPeriodMode('last3')}
 className={`px-3 py-2.5 rounded-xl text-xs font-bold transition cursor-pointer border ${periodMode === 'last3' ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-300 hover:text-white'}`}
 >
 {t('Last 3 Months')}
 </button>
 <button
 type="button"
 onClick={() => setPeriodMode('year')}
 className={`px-3 py-2.5 rounded-xl text-xs font-bold transition cursor-pointer border ${periodMode === 'year' ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-300 hover:text-white'}`}
 >
 {t('This Year')}
 </button>
 </div>
 </div>
 <div className="text-start sm:text-end hidden sm:block">
 <span className="text-[10px] font-bold text-slate-500 uppercase block">{t('Shop Standard System Time')}</span>
 <span className="text-sm font-mono font-bold text-slate-300">
 {new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC
 </span>
 </div>
 </div>
 </div>
 </div>
 {/* Warning if no Active Open Fiscal Month */}
 {!openMonth && (
 <div id="no-fiscal-month-warning" className="bg-amber-500/10 border border-amber-500/35 rounded-2xl p-4 flex items-start gap-3">
 <span className="text-lg shrink-0">⚠️</span>
 <div>
 <h4 className="text-xs font-bold text-amber-800 ">{t('No Active Fiscal Month Detected')}</h4>
 <p className="text-[11px] text-amber-700 mt-0.5">
 {t('No Active Fiscal Month Warning Text')}
 </p>
 {isAdmin && (
 <button
 onClick={() => onNavigate('settings-fiscalMonths')}
 className="mt-2 text-[10px] font-black uppercase text-amber-600 hover:underline"
 >
 {t('Open Fiscal Month Setting')} &rarr;
 </button>
 )}
 </div>
 </div>
 )}

 {/* Disclosure: KPIs below read from a capped, most-recent-N window per record type */}
 {isDataPossiblyTruncated && (
 <div id="truncated-data-warning" className="bg-slate-100 border border-slate-200 rounded-2xl p-3 flex items-center gap-2.5">
 <span className="text-sm shrink-0">ℹ️</span>
 <p className="text-[10.5px] text-slate-600">
 {t('Based on the most recent 500 records per type (invoices, expenses, vouchers, quotations) - totals and KPIs may be incomplete for companies with more history.')}
 </p>
 </div>
 )}

 {/* ADMIN INTERACTIVE COMMAND CENTER */}
 {isAdmin ? (
 <>
 {/* Key metric cards */}
 <div className="grid grid-cols-1 md:grid-cols-4 gap-4">

 <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="bg-white border border-slate-200/60 rounded-[28px] p-6 shadow-[0_8px_30px_rgb(0,0,0,0.04)] backdrop-blur-xl hover:shadow-xl transition-shadow duration-300 space-y-3">
 <div className="flex justify-between items-center">
 <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Gross Month Sales')}</span>
 <span className="p-2 bg-emerald-50 text-emerald-600 rounded-xl"><DollarSign className="w-4 h-4" /></span>
 </div>
 <div>
 <h3 className="text-2xl font-extrabold text-slate-900">{currencySymbol} {totalSales.toFixed(2)}</h3>
              <div className="text-[10px] text-emerald-600 font-bold mt-1 flex flex-col gap-1">
                <div className="flex items-center gap-0.5"><TrendingUp className="w-3.5 h-3.5" /> {t('Includes VAT Tax')}</div>
                <div className="bg-emerald-50 text-emerald-700 px-2 py-1 rounded-md mt-1 border border-emerald-100">
                  <span className="uppercase tracking-wide block mb-0.5 text-[8px] text-emerald-500">{t('Cash Received (Month)')}</span>
                  {currencySymbol} {receivedSales.toFixed(2)}
                </div>
              </div>
 </div>
 </motion.div>

 <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0.05 }} className="bg-white border border-slate-200/60 rounded-[28px] p-6 shadow-[0_8px_30px_rgb(0,0,0,0.04)] backdrop-blur-xl hover:shadow-xl transition-shadow duration-300 flex flex-col justify-between">
 <div>
 <div className="flex justify-between items-center">
 <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Cash Capital In Bank')}</span>
 <span className="p-2 bg-indigo-50 text-indigo-600 rounded-xl"><Briefcase className="w-4 h-4" /></span>
 </div>
 <div className="mt-3">
 <h3 className="text-2xl font-extrabold text-slate-900">{currencySymbol} {totalBankCapital.toFixed(2)}</h3>
 <p className="text-[10px] text-indigo-600 font-bold mt-1">
 {t('Across all active banks')}
 </p>
 </div>
 </div>
 <button
 onClick={() => onNavigate('settings-equity')}
 className="w-full text-center py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold text-[10px] rounded-lg transition mt-3 flex items-center justify-center gap-1 border border-indigo-100"
 >
 <Plus className="w-3 h-3" /> {t('Manage Capital & Equity')}
 </button>
 </motion.div>

 <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0.1 }} className="bg-white border border-slate-200/60 rounded-[28px] p-6 shadow-[0_8px_30px_rgb(0,0,0,0.04)] backdrop-blur-xl hover:shadow-xl transition-shadow duration-300 space-y-3">
 <div className="flex justify-between items-center">
 <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Pending Collections')}</span>
 <span className="p-2 bg-amber-50 text-amber-600 rounded-xl"><Layers className="w-4 h-4" /></span>
 </div>
 <div>
 <h3 className="text-2xl font-extrabold text-slate-900">{currencySymbol} {pendingCollection.toFixed(2)}</h3>
 <p className="text-[10px] text-amber-600 font-bold mt-1">
 {t('On account sales credit')}
 </p>
 </div>
 </motion.div>

 <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0.15 }} className="bg-white border border-slate-200/60 rounded-[28px] p-6 shadow-[0_8px_30px_rgb(0,0,0,0.04)] backdrop-blur-xl hover:shadow-xl transition-shadow duration-300 space-y-3">
 <div className="flex justify-between items-center">
 <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Actual cash outflow expenses')}</span>
 <span className="p-2 bg-rose-50 text-rose-600 rounded-xl"><TrendingDown className="w-4 h-4" /></span>
 </div>
 <div>
 <h3 className="text-2xl font-extrabold text-slate-900">{currencySymbol} {paidExpenseActual.toFixed(2)}</h3>
              <div className="text-[10px] text-rose-600 font-bold mt-1 flex flex-col gap-0.5">
                <div className="bg-rose-50 text-rose-700 px-2 py-1 rounded-md mb-1 border border-rose-100">
                  <span className="uppercase tracking-wide block mb-0.5 text-[8px] text-rose-500">{t('Incurred / Accruals (Month)')}</span>
                  {currencySymbol} {totalExpenseActual.toFixed(2)} / {currencySymbol} {totalExpenseAccrual.toFixed(2)}
                </div>
                {totalAssetCapEx > 0 && (
                  <div className="text-amber-600 font-extrabold uppercase mt-0.5">
                    {t('CapEx Assets:')} {currencySymbol} {totalAssetCapEx.toFixed(2)}
                  </div>
                )}
              </div>
 </div>
 </motion.div>

 </div>

 {/* Partners' Equity & Capital Ratios Section */}
 {companyInvestors && companyInvestors.length > 0 && (
 <div className="bg-slate-50 border border-slate-150 rounded-3xl p-6 space-y-4">
 <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
 <div>
 <h4 className="text-sm font-bold text-slate-800 tracking-tight flex items-center gap-2">
 <span className="w-2.5 h-2.5 rounded-full bg-indigo-600 animate-pulse"></span>
 {t("Partners' Equity & Capital Ratios")}
 </h4>
 <p className="text-xs text-slate-400 mt-0.5">
 {t("Real-time monitoring of registered partner contributions against agreed equity shares.")}
 </p>
 </div>
 <button
 onClick={() => onNavigate('settings-equity')}
 className="bg-indigo-600 hover:bg-indigo-700 text-white text-[10px] font-extrabold px-3 py-1.5 rounded-lg transition"
 >
 {t('Manage Capital & Contributions')}
 </button>
 </div>

 {/* Outstanding/Owing Warnings */}
 {(() => {
 const totalContributed = companyInvestors.reduce((sum, inv) => {
 const actual = db.vouchers
 .filter(v => v.referenceType === 'Equity' && v.referenceId === inv.id)
 .reduce((vSum, v) => vSum + v.amount, 0);
 return sum + actual;
 }, 0);

 if (totalContributed === 0) {
 return (
 <div className="bg-amber-50/65 border border-amber-100 rounded-2xl p-4 text-xs text-amber-800 flex items-center gap-2.5">
 <span className="text-lg">⚠️</span>
 <div>
 <span className="font-extrabold block">{t("No Capital Contributions Logged Yet")}</span>
 <p className="text-[11px] text-amber-700/95 mt-0.5">
 {t("Although partners are registered, no capital deposits have been registered. Go to Settings > Equity Tab to post capital contributions.")}
 </p>
 </div>
 </div>
 );
 }

 const reconciliation = companyInvestors.map((inv) => {
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
 <div className="space-y-4">
 {/* Imbalanced Capital Alerts */}
 {debtors.length > 0 && (
 <div className="bg-amber-50/50 border border-amber-100 rounded-2xl p-4 text-xs space-y-2">
 <div className="flex items-start gap-2.5 text-amber-800 ">
 <span className="text-base shrink-0">⚠️</span>
 <div>
 <span className="font-extrabold block">{t("Capital Contribution Mismatch Detected")}</span>
 <p className="text-[11px] text-amber-700/90 mt-0.5">
 {t("Partners have not paid capital matching their agreed")} <strong>{reconciliation.map(r => `${r.name}: ${r.equityPercentage}%`).join(' / ')}</strong> {t("equity ratios of the current total capital base of")} <strong>{currencySymbol} {totalContributed.toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong>.
 </p>
 </div>
 </div>

 <div className="space-y-2 mt-2">
 {debtors.map((debtor) => {
 // Find who is over-contributed to display who they owe
 const owedList = creditors.map(cred => {
 const ratio = Math.abs(cred.balance) / creditors.reduce((sum, c) => sum + Math.abs(c.balance), 0);
 const share = debtor.balance * ratio;
 return {
 name: cred.name,
 share: share
 };
 });

 return (
 <div key={debtor.id} className="bg-white p-3 rounded-xl border border-amber-100/50 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
 <div>
 <span className="font-extrabold text-slate-800 block text-xs">{debtor.name}</span>
 <p className="text-[10px] text-slate-400 mt-0.5">
 {t("Contributed")} <strong>{currencySymbol} {debtor.actual.toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong> {t("instead of required")} <strong>{currencySymbol} {debtor.targetShare.toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong>
 </p>
 </div>
 <div className="text-end">
 <span className="bg-rose-50 text-rose-700 font-black text-[10px] px-2.5 py-1 rounded-md block whitespace-nowrap">
 {t("Owes")} {currencySymbol} {debtor.balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}
 </span>
 <div className="text-[9px] text-amber-600 mt-1">
 {owedList.map(ol => `Owes ${currencySymbol} ${ol.share.toLocaleString('en-US', { minimumFractionDigits: 2 })} to ${ol.name}`).join(', ')}
 </div>
 </div>
 </div>
 );
 })}
 </div>
 </div>
 )}

 {/* Partner grid display */}
 <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
 {reconciliation.map((inv) => {
 const profitPct = inv.profitPercentage ?? inv.equityPercentage;
 return (
 <div key={inv.id} className="bg-white border border-slate-200/60 p-4 rounded-2xl flex flex-col justify-between space-y-3">
 <div className="flex justify-between items-start">
 <div>
 <span className="font-extrabold text-slate-900 text-xs block">{inv.name}</span>
 <span className="text-[9px] text-slate-400 font-bold uppercase tracking-wider block mt-0.5">{t("Partner Profile")}</span>
 </div>
 <div className="flex flex-col items-end gap-1">
 <span className="bg-indigo-50 text-indigo-700 font-bold text-[9px] px-2 py-0.5 rounded">
 {inv.equityPercentage}% Equity
 </span>
 <span className="bg-emerald-50 text-emerald-700 font-bold text-[9px] px-2 py-0.5 rounded">
 {profitPct}% Profit
 </span>
 </div>
 </div>

 <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-100 text-xs">
 <div>
 <span className="text-[9px] text-slate-400 font-bold uppercase block">{t("Paid Capital")}</span>
 <span className="font-mono font-extrabold text-slate-800 ">
 {currencySymbol} {inv.actual.toLocaleString('en-US', { minimumFractionDigits: 2 })}
 </span>
 </div>
 <div className="text-end">
 <span className="text-[9px] text-slate-400 font-bold uppercase block">{t("Target Capital")}</span>
 <span className="font-mono font-bold text-slate-500">
 {currencySymbol} {inv.targetShare.toLocaleString('en-US', { minimumFractionDigits: 2 })}
 </span>
 </div>
 </div>

 <div className="pt-1.5">
 {inv.balance > 0.01 ? (
 <span className="text-[10px] text-rose-600 font-bold flex items-center gap-1 bg-rose-50 px-2 py-1 rounded-md">
 <span>🔴</span> {t("Deficit: Owes")} {currencySymbol} {inv.balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}
 </span>
 ) : inv.balance < -0.01 ? (
 <span className="text-[10px] text-emerald-600 font-bold flex items-center gap-1 bg-emerald-50 px-2 py-1 rounded-md">
 <span>🟢</span> {t("Surplus: Overpaid")} {currencySymbol} {Math.abs(inv.balance).toLocaleString('en-US', { minimumFractionDigits: 2 })}
 </span>
 ) : (
 <span className="text-[10px] text-indigo-600 font-bold flex items-center gap-1 bg-indigo-50 px-2 py-1 rounded-md">
 <span>✅</span> {t("Ratio Balanced Perfectly")}
 </span>
 )}
 </div>
 </div>
 );
 })}
 </div>
 </div>
 );
 })()}
 </div>
 )}

 {/* Charts & Graphs Row */}
 <div className="grid grid-cols-1 md:grid-cols-12 gap-5">
 
 {/* Main Area Chart */}
 <div className="col-span-1 md:col-span-8 bg-white border border-slate-200/60 rounded-[28px] p-6 shadow-[0_8px_30px_rgb(0,0,0,0.04)] backdrop-blur-xl">
 <div className="flex justify-between items-center mb-6">
 <div>
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">{t("Workshop Activity Trends")}</h4>
 <p className="text-[10px] text-slate-400">{t("Comparing issued sales vs expenses throughout the period")}</p>
 </div>
 <div className="flex items-center gap-3 text-[10px] font-bold">
 <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-indigo-600 rounded-full"></span> {t("Sales")}</span>
 <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-rose-500 rounded-full"></span> {t("Expenses")}</span>
 </div>
 </div>

 <div className="h-64">
 <ResponsiveContainer width="100%" height="100%">
 <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
 <defs>
 <linearGradient id="colorSales" x1="0" y1="0" x2="0" y2="1">
 <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.2}/>
 <stop offset="95%" stopColor="#4f46e5" stopOpacity={0}/>
 </linearGradient>
 <linearGradient id="colorExpenses" x1="0" y1="0" x2="0" y2="1">
 <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.2}/>
 <stop offset="95%" stopColor="#f43f5e" stopOpacity={0}/>
 </linearGradient>
 </defs>
 <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
 <XAxis dataKey="date" stroke="#94a3b8" fontSize={10} tickLine={false} />
 <YAxis stroke="#94a3b8" fontSize={10} tickLine={false} />
 <Tooltip contentStyle={{ background: '#0f172a', border: 'none', borderRadius: '8px', color: '#fff', fontSize: '11px' }} />
 <Area type="monotone" dataKey="Sales" stroke="#4f46e5" strokeWidth={2} fillOpacity={1} fill="url(#colorSales)" />
 <Area type="monotone" dataKey="Expenses" stroke="#f43f5e" strokeWidth={2} fillOpacity={1} fill="url(#colorExpenses)" />
 </AreaChart>
 </ResponsiveContainer>
 </div>
 </div>

 {/* P&L Tracker Widget */}
 <div className="col-span-1 md:col-span-4 bg-white border border-slate-200/60 rounded-[28px] p-6 shadow-[0_8px_30px_rgb(0,0,0,0.04)] backdrop-blur-xl flex flex-col justify-between">
 <div>
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-4">{t("Monthly Profitability Calculator")}</h4>
 
 <div className="space-y-4">
 <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-100 ">
 <span className="text-[10px] text-slate-400 font-bold block">{t("Estimated EBITDA (Net Cash Profit)")}</span>
 <span className={`text-2xl font-extrabold block mt-1 ${netProfit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
 {currencySymbol} {netProfit.toFixed(2)}
 </span>
 </div>

 <div className="space-y-2 text-xs">
 <div className="flex justify-between text-slate-500">
 <span>{t("Profit Margin %")}</span>
 <span className="font-bold text-slate-800">{netProfitMargin.toFixed(1)}%</span>
 </div>
 <div className="w-full bg-slate-100 rounded-full h-2">
 <div 
 className={`h-2 rounded-full ${netProfit >= 0 ? 'bg-emerald-500' : 'bg-rose-500'}`}
 style={{ width: `${Math.min(Math.max(netProfitMargin, 0), 100)}%` }}
 ></div>
 </div>
 </div>
 </div>
 </div>

 <div className="border-t border-slate-100 pt-4 mt-6">
 <span className="text-[10px] text-slate-400 uppercase font-bold block mb-2">{t("Audit Compliance Logs")}</span>
 <div className="space-y-2">
 <div className="flex items-center gap-2 text-[10px] text-slate-500">
 <span className={`w-2 h-2 rounded-full shrink-0 ${zatcaOk ? 'bg-emerald-500' : 'bg-rose-500'}`}></span>
 <span>
 {zatcaOk
 ? t("VAT records fully synchronised on sales")
 : `${zatcaFailureCount} of ${zatcaEligibleInvoices.length} ${t("invoice(s) failed ZATCA e-invoicing submission (ERROR/REJECTED)")}`}
 </span>
 </div>
 {companyInvestors.length > 0 && (
 <div className="flex items-center justify-between text-[10px] text-slate-500 pt-1.5 border-t border-slate-50 ">
 <div className="flex items-center gap-2">
 <span className={`w-2 h-2 rounded-full shrink-0 ${investorHasImbalance ? 'bg-amber-500' : 'bg-emerald-500'}`}></span>
 <span>{investorHasImbalance ? t("Capital Investor Registry has unreconciled balances") : t("Capital Investor Registry fully reconciled")}</span>
 </div>
 <button onClick={() => onNavigate('settings-equity')} className="text-indigo-600 hover:underline font-extrabold cursor-pointer">{t("Open Registry")}</button>
 </div>
 )}
 </div>
 </div>

 </div>

 </div>

 {/* Pending Invoices / Pending Expenses — point-in-time outstanding balances, not
 gated by the reporting period filter (see calculation comment above). */}
 <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
 <motion.div
 initial={{ opacity: 0, y: 12 }}
 animate={{ opacity: 1, y: 0 }}
 transition={{ duration: 0.35 }}
 className="bg-white border border-slate-200/60 rounded-[28px] p-6 shadow-[0_8px_30px_rgb(0,0,0,0.04)] backdrop-blur-xl"
 >
 <div className="flex justify-between items-center mb-4">
 <div>
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
 <FileCheck className="w-3.5 h-3.5 text-amber-500" /> {t('Pending Invoices')}
 </h4>
 <p className="text-[10px] text-slate-400 mt-0.5">{t('Outstanding customer collections, oldest first')}</p>
 </div>
 <button
 onClick={() => onNavigate('invoices')}
 className="text-[10px] font-extrabold text-indigo-600 hover:text-indigo-800 flex items-center gap-0.5 shrink-0"
 >
 {t('View All')} <ArrowUpRight className="w-3 h-3" />
 </button>
 </div>
 {pendingInvoicesBase.length > 0 && (
 <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mb-4 pb-3 border-b border-slate-100 text-[9px] font-bold text-slate-400 uppercase tracking-wide">
 <span className="flex items-center gap-1.5">{t('On time')} {renderAgingPictogram(pendingInvoicesAging.onTime, 'bg-slate-300')} <span className="text-slate-500">{pendingInvoicesAging.onTime}</span></span>
 <span className="flex items-center gap-1.5">{t('Aging')} {renderAgingPictogram(pendingInvoicesAging.aging, 'bg-amber-400')} <span className="text-amber-600">{pendingInvoicesAging.aging}</span></span>
 <span className="flex items-center gap-1.5">{t('Overdue')} {renderAgingPictogram(pendingInvoicesAging.overdue, 'bg-rose-500')} <span className="text-rose-600">{pendingInvoicesAging.overdue}</span></span>
 </div>
 )}
 {pendingInvoicesList.length === 0 ? (
 <div className="py-8 text-center">
 <CheckCircle className="w-6 h-6 text-emerald-400 mx-auto mb-1.5" />
 <p className="text-[11px] text-slate-400 font-semibold">{t('No outstanding invoice collections.')}</p>
 </div>
 ) : (
 <div className="space-y-1.5">
 {pendingInvoicesList.map(({ inv, due }) => {
 const customerName = db.customers.find(c => c.id === inv.customerId)?.name || t('Unknown Customer');
 const days = daysOutstanding(inv.date);
 return (
 <button
 key={inv.id}
 onClick={() => onNavigate('invoices')}
 className="w-full flex items-center justify-between gap-3 p-2.5 rounded-xl hover:bg-slate-50 transition text-start"
 >
 <div className="min-w-0">
 <span className="text-xs font-bold text-slate-800 block truncate">{customerName}</span>
 <span className="text-[10px] text-slate-400 font-mono">{inv.invoiceNumber}</span>
 </div>
 <div className="text-end shrink-0">
 <span className="text-xs font-extrabold text-slate-900 block">{currencySymbol} {due.toFixed(2)}</span>
 <span className={`text-[9px] font-bold ${days > 30 ? 'text-rose-600' : days > 14 ? 'text-amber-600' : 'text-slate-400'}`}>
 {days} {t('days outstanding')}
 </span>
 </div>
 </button>
 );
 })}
 <div className="flex justify-between items-center pt-3 mt-1 border-t border-slate-100 text-xs">
 <span className="text-slate-400 font-bold uppercase text-[10px]">{t('Total Outstanding')}</span>
 <span className="font-extrabold text-amber-600">{currencySymbol} {pendingInvoicesTotal.toFixed(2)}</span>
 </div>
 </div>
 )}
 </motion.div>

 <motion.div
 initial={{ opacity: 0, y: 12 }}
 animate={{ opacity: 1, y: 0 }}
 transition={{ duration: 0.35, delay: 0.05 }}
 className="bg-white border border-slate-200/60 rounded-[28px] p-6 shadow-[0_8px_30px_rgb(0,0,0,0.04)] backdrop-blur-xl"
 >
 <div className="flex justify-between items-center mb-4">
 <div>
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
 <TrendingDown className="w-3.5 h-3.5 text-rose-500" /> {t('Pending Expenses')}
 </h4>
 <p className="text-[10px] text-slate-400 mt-0.5">{t('Unpaid vendor bills, oldest first')}</p>
 </div>
 <button
 onClick={() => onNavigate('expenses')}
 className="text-[10px] font-extrabold text-indigo-600 hover:text-indigo-800 flex items-center gap-0.5 shrink-0"
 >
 {t('View All')} <ArrowUpRight className="w-3 h-3" />
 </button>
 </div>
 {pendingExpensesList.length === 0 ? (
 <div className="py-8 text-center">
 <CheckCircle className="w-6 h-6 text-emerald-400 mx-auto mb-1.5" />
 <p className="text-[11px] text-slate-400 font-semibold">{t('No unpaid vendor bills.')}</p>
 </div>
 ) : (
 <div className="space-y-1.5">
 {pendingExpensesList.map(({ exp, due }) => {
 const vendorName = db.vendors.find(v => v.id === exp.vendorId)?.name || t('Unknown Vendor');
 const days = daysOutstanding(exp.date);
 return (
 <button
 key={exp.id}
 onClick={() => onNavigate('expenses')}
 className="w-full flex items-center justify-between gap-3 p-2.5 rounded-xl hover:bg-slate-50 transition text-start"
 >
 <div className="min-w-0">
 <span className="text-xs font-bold text-slate-800 block truncate">{vendorName}</span>
 <span className="text-[10px] text-slate-400 font-mono">{exp.expenseNumber}</span>
 </div>
 <div className="text-end shrink-0">
 <span className="text-xs font-extrabold text-slate-900 block">{currencySymbol} {due.toFixed(2)}</span>
 <span className={`text-[9px] font-bold ${days > 30 ? 'text-rose-600' : days > 14 ? 'text-amber-600' : 'text-slate-400'}`}>
 {days} {t('days outstanding')}
 </span>
 </div>
 </button>
 );
 })}
 <div className="flex justify-between items-center pt-3 mt-1 border-t border-slate-100 text-xs">
 <span className="text-slate-400 font-bold uppercase text-[10px]">{t('Total Outstanding')}</span>
 <span className="font-extrabold text-rose-600">{currencySymbol} {pendingExpensesTotal.toFixed(2)}</span>
 </div>
 {accrualsAwaitingSettlement > 0 && (
 <button
 onClick={() => onNavigate('recurring')}
 className="w-full flex items-center justify-between gap-2 mt-1 p-2 rounded-lg bg-amber-50 border border-amber-100 text-[10px]"
 >
 <span className="text-amber-700 font-bold">{accrualsAwaitingSettlement} {t('accrual(s) awaiting settlement')}</span>
 <ArrowUpRight className="w-3 h-3 text-amber-600" />
 </button>
 )}
 </div>
 )}
 </motion.div>
 </div>

 {/* Top Customers by Sales / Top Vendors by Expense — respects the active reporting period */}
 <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
 <motion.div
 initial={{ opacity: 0, y: 12 }}
 animate={{ opacity: 1, y: 0 }}
 transition={{ duration: 0.35, delay: 0.1 }}
 className="bg-white border border-slate-200/60 rounded-[28px] p-6 shadow-[0_8px_30px_rgb(0,0,0,0.04)] backdrop-blur-xl"
 >
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-4">{t('Top Customers by Sales')}</h4>
 {topCustomersBySales.length === 0 ? (
 <p className="text-[11px] text-slate-400 text-center py-8">{t('No sales recorded in this period.')}</p>
 ) : (
 <div className="h-56">
 <ResponsiveContainer width="100%" height="100%">
 <BarChart data={topCustomersBySales} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
 <defs>
 {CHART_PALETTE.map((color, i) => (
 <linearGradient key={i} id={`custGrad${i}`} x1="0" y1="0" x2="1" y2="0">
 <stop offset="0%" stopColor={color} stopOpacity={0.55} />
 <stop offset="100%" stopColor={color} stopOpacity={1} />
 </linearGradient>
 ))}
 </defs>
 <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
 <XAxis type="number" stroke="#94a3b8" fontSize={10} tickLine={false} />
 <YAxis type="category" dataKey="name" stroke="#94a3b8" fontSize={10} tickLine={false} width={110} />
 <Tooltip contentStyle={{ background: '#0f172a', border: 'none', borderRadius: '8px', color: '#fff', fontSize: '11px' }} formatter={(v: number) => [`${currencySymbol} ${v.toFixed(2)}`, t('Sales')]} />
 <Bar dataKey="amount" radius={[0, 6, 6, 0]}>
 {topCustomersBySales.map((_, i) => (
 <Cell key={i} fill={`url(#custGrad${i % CHART_PALETTE.length})`} />
 ))}
 </Bar>
 </BarChart>
 </ResponsiveContainer>
 </div>
 )}
 </motion.div>

 <motion.div
 initial={{ opacity: 0, y: 12 }}
 animate={{ opacity: 1, y: 0 }}
 transition={{ duration: 0.35, delay: 0.15 }}
 className="bg-white border border-slate-200/60 rounded-[28px] p-6 shadow-[0_8px_30px_rgb(0,0,0,0.04)] backdrop-blur-xl"
 >
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-4">{t('Top Vendors by Expense')}</h4>
 {topVendorsByExpense.length === 0 ? (
 <p className="text-[11px] text-slate-400 text-center py-8">{t('No expenses recorded in this period.')}</p>
 ) : (
 <div className="h-56">
 <ResponsiveContainer width="100%" height="100%">
 <BarChart data={topVendorsByExpense} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
 <defs>
 {CHART_PALETTE.map((color, i) => (
 <linearGradient key={i} id={`vendGrad${i}`} x1="0" y1="0" x2="1" y2="0">
 <stop offset="0%" stopColor={color} stopOpacity={0.55} />
 <stop offset="100%" stopColor={color} stopOpacity={1} />
 </linearGradient>
 ))}
 </defs>
 <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
 <XAxis type="number" stroke="#94a3b8" fontSize={10} tickLine={false} />
 <YAxis type="category" dataKey="name" stroke="#94a3b8" fontSize={10} tickLine={false} width={110} />
 <Tooltip contentStyle={{ background: '#0f172a', border: 'none', borderRadius: '8px', color: '#fff', fontSize: '11px' }} formatter={(v: number) => [`${currencySymbol} ${v.toFixed(2)}`, t('Expenses')]} />
 <Bar dataKey="amount" radius={[0, 6, 6, 0]}>
 {topVendorsByExpense.map((_, i) => (
 <Cell key={i} fill={`url(#vendGrad${i % CHART_PALETTE.length})`} />
 ))}
 </Bar>
 </BarChart>
 </ResponsiveContainer>
 </div>
 )}
 </motion.div>
 </div>
 </>
 ) : (
 /* USER (STAFF MEMBER) ISOLATED WORKPLACE */
 <>
 {/* Staff specific KPIs */}
 <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
 
 <div className="bg-white border border-slate-200/60 rounded-[28px] p-6 shadow-[0_8px_30px_rgb(0,0,0,0.04)] backdrop-blur-xl hover:shadow-xl transition-shadow duration-300 flex items-center justify-between">
 <div className="space-y-1">
 <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">{t("Your Open Quotations")}</span>
 <h3 className="text-2xl font-extrabold text-slate-900">{monthQuotations.length}</h3>
 <p className="text-[10px] text-indigo-600 font-bold">{t("Drafts and estimations in progress")}</p>
 </div>
 <span className="p-3 bg-indigo-50 text-indigo-600 rounded-2xl"><Compass className="w-5 h-5" /></span>
 </div>

 <div className="bg-white border border-slate-200/60 rounded-[28px] p-6 shadow-[0_8px_30px_rgb(0,0,0,0.04)] backdrop-blur-xl hover:shadow-xl transition-shadow duration-300 flex items-center justify-between">
 <div className="space-y-1">
 <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">{t("Your Sales Volume")}</span>
 <h3 className="text-2xl font-extrabold text-slate-900">{currencySymbol} {totalSales.toFixed(2)}</h3>
 <p className="text-[10px] text-emerald-600 font-bold">{t("Vouchers and invoices issued")}</p>
 </div>
 <span className="p-3 bg-emerald-50 text-emerald-600 rounded-2xl"><FileCheck className="w-5 h-5" /></span>
 </div>

 <div className="bg-white border border-slate-200/60 rounded-[28px] p-6 shadow-[0_8px_30px_rgb(0,0,0,0.04)] backdrop-blur-xl hover:shadow-xl transition-shadow duration-300 flex items-center justify-between">
 <div className="space-y-1">
 <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">{t("Logged Workshop Costs")}</span>
 <h3 className="text-2xl font-extrabold text-slate-900">{currencySymbol} {totalExpenseActual.toFixed(2)}</h3>
 <p className="text-[10px] text-rose-600 font-bold">{t("Procurement sheets registered")}</p>
 </div>
 <span className="p-3 bg-rose-50 text-rose-600 rounded-2xl"><TrendingDown className="w-5 h-5" /></span>
 </div>

 </div>

 {/* Targets and shortcuts row */}
 <div className="grid grid-cols-1 md:grid-cols-12 gap-5">
 
 {/* Progress Circular Targets */}
 <div className="md:col-span-8 bg-white border border-slate-200/60 rounded-[28px] p-6 shadow-[0_8px_30px_rgb(0,0,0,0.04)] backdrop-blur-xl">
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-1">{t("Your Month Targets & Performance Progress")}</h4>
 <p className="text-[9px] text-slate-400 mb-5">
 {hasHistoricalTarget || hasHistoricalQuotaTarget
 ? t("Targets are derived from your own trailing 3-month average — not a fixed goal.")
 : t("Illustrative example targets — not enough closed-month history yet to derive real ones.")}
 </p>

 <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
 
 {/* Quotation progress */}
 <div className="flex items-center gap-4 bg-slate-50 p-4 rounded-xl border border-slate-100 ">
 <div className="relative w-16 h-16 shrink-0">
 {/* SVG Progress Circle */}
 <svg className="w-full h-full transform -rotate-90" viewBox="0 0 36 36">
 <path
 className="text-slate-200"
 strokeWidth="3.5"
 stroke="currentColor"
 fill="none"
 d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
 />
 <path
 className="text-indigo-600"
 strokeDasharray={`${quotaProgress}, 100`}
 strokeWidth="3.5"
 strokeLinecap="round"
 stroke="currentColor"
 fill="none"
 d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
 />
 </svg>
 <div className="absolute inset-0 flex items-center justify-center text-xs font-extrabold text-slate-800">
 {monthQuotations.length}/{quotaTarget}
 </div>
 </div>
 <div>
 <span className="text-[11px] font-bold text-slate-800 block">{t("Draft Quotations Target")}</span>
 <span className="text-[10px] text-slate-400 block mt-0.5">{t("Secure new cutting estimates. Progress:")} {quotaProgress.toFixed(0)}%</span>
 </div>
 </div>

 {/* Sales target progress */}
 <div className="flex items-center gap-4 bg-slate-50 p-4 rounded-xl border border-slate-100 ">
 <div className="relative w-16 h-16 shrink-0">
 <svg className="w-full h-full transform -rotate-90" viewBox="0 0 36 36">
 <path
 className="text-slate-200"
 strokeWidth="3.5"
 stroke="currentColor"
 fill="none"
 d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
 />
 <path
 className="text-emerald-500"
 strokeDasharray={`${salesProgress}, 100`}
 strokeWidth="3.5"
 strokeLinecap="round"
 stroke="currentColor"
 fill="none"
 d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
 />
 </svg>
 <div className="absolute inset-0 flex items-center justify-center text-[10px] font-extrabold text-slate-800">
 {salesProgress.toFixed(0)}%
 </div>
 </div>
 <div>
 <span className="text-[11px] font-bold text-slate-800 block">{t("Open Month Sales Volume")}</span>
 <span className="text-[10px] text-slate-400 block mt-0.5">{t("Target:")} {currencySymbol} {salesTarget.toFixed(2)}. {t("Your Gross:")} {currencySymbol} {totalSales.toFixed(2)}</span>
 </div>
 </div>

 </div>
 </div>

 {/* Quick Actions Panel */}
 <div className="md:col-span-4 bg-white border border-slate-200/60 rounded-[28px] p-6 shadow-[0_8px_30px_rgb(0,0,0,0.04)] backdrop-blur-xl">
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-4">{t("Quick Workshop Actions")}</h4>
 <div className="space-y-2">
 <button
 onClick={() => onNavigate('quotations')}
 className="w-full p-3 bg-indigo-50 hover:bg-indigo-100 border border-indigo-100 text-indigo-900 rounded-xl text-xs font-bold transition text-start flex justify-between items-center"
 >
 <span>{t("Create Custom Cutting Estimate")}</span>
 <Plus className="w-4 h-4 text-indigo-600" />
 </button>
 <button
 onClick={() => onNavigate('invoices')}
 className="w-full p-3 bg-emerald-50 hover:bg-emerald-100 border border-emerald-100 text-emerald-900 rounded-xl text-xs font-bold transition text-start flex justify-between items-center"
 >
 <span>{t("Issue Standard Sales Invoice")}</span>
 <Plus className="w-4 h-4 text-emerald-600" />
 </button>
 <button
 onClick={() => onNavigate('expenses')}
 className="w-full p-3 bg-rose-50 hover:bg-rose-100 border border-rose-100 text-rose-900 rounded-xl text-xs font-bold transition text-start flex justify-between items-center"
 >
 <span>{t("Document Workshop Bit procurement")}</span>
 <Plus className="w-4 h-4 text-rose-600" />
 </button>
 </div>
 </div>

 </div>
 </>
 )}

 </div>
 );
}
