import React from 'react';
import { useTranslation, usePermissions } from '../hooks';
import { DatabaseState, calculateInvoiceTotals, getInvoiceSign } from '../dbStore';
import { Printer, Filter } from 'lucide-react';

type ReportType = 'SalesRegister' | 'ItemWiseSales' | 'CustomerStatement' | 'QuotationConversion' | 'SalesByStaff' | 'PosShiftSummary';

interface SalesReportsModuleProps {
  db: DatabaseState;
  defaultReportType: ReportType;
  onPrintDoc: (type: 'Quotation' | 'Invoice' | 'Expense' | 'Voucher' | 'Report', data: any) => void;
}

const REPORT_PERMISSION_KEYS: Record<ReportType, string> = {
  SalesRegister: 'reports.salesRegister',
  ItemWiseSales: 'reports.itemWiseSales',
  CustomerStatement: 'reports.customerStatement',
  QuotationConversion: 'reports.quotationConversion',
  SalesByStaff: 'reports.salesByStaff',
  PosShiftSummary: 'reports.posShiftSummary',
};

const REPORT_LABELS: Record<ReportType, string> = {
  SalesRegister: 'Sales Register',
  ItemWiseSales: 'Item-wise Sales Report',
  CustomerStatement: 'Customer Statement of Account',
  QuotationConversion: 'Quotation Conversion Report',
  SalesByStaff: 'Sales by Staff',
  PosShiftSummary: 'POS Shift Summary',
};

export default function SalesReportsModule({ db, defaultReportType, onPrintDoc }: SalesReportsModuleProps) {
  const { t } = useTranslation(db);
  const { can } = usePermissions(db.currentUser);
  const [reportType, setReportType] = React.useState<ReportType>(defaultReportType);
  React.useEffect(() => { setReportType(defaultReportType); }, [defaultReportType]);
  const hasAccessToCurrentReport = can(REPORT_PERMISSION_KEYS[reportType]);
  const currencySymbol = db.companySetup?.currency || 'SAR';
  const companyId = db.selectedCompanyId;

  const [startDate, setStartDate] = React.useState('2026-06-01');
  const [endDate, setEndDate] = React.useState('2026-06-30');
  const [selectedCustomerId, setSelectedCustomerId] = React.useState('ALL');
  // Required (no 'ALL' default) — a running-balance statement only makes sense for one
  // customer at a time, unlike every other report here.
  const [statementCustomerId, setStatementCustomerId] = React.useState('');
  React.useEffect(() => {
    if (!statementCustomerId) {
      const first = db.customers.find(c => c.companyId === companyId && !c.isSystem);
      if (first) setStatementCustomerId(first.id);
    }
  }, [db.customers, companyId]);

  // Branch focus — a convenience narrowing for a company-wide/viewAllBranches viewer to
  // slice these reports down to one location at a time. Not a security boundary (that's
  // already enforced server-side in /api/state — a branch-restricted user's db.invoices
  // etc. never contain another branch's rows to begin with, regardless of this control);
  // a document with no branchId at all (branch scoping not adopted, or predates it) always
  // matches, same "null is visible to everyone" rule the server-side filter uses.
  // Which branches this viewer can even pick from — an unrestricted viewer (admin/
  // super-admin/branches.viewAllBranches) gets every branch in the company; a restricted
  // viewer only gets their own assigned branches, so "All Branches" in the dropdown below
  // means "all of MY branches", never a false promise of company-wide data they can't
  // actually see (the server already never sends it, but offering it as a selectable
  // option would be confusing regardless).
  const isBranchUnrestricted = db.currentUser?.isSuperAdmin === true || db.currentUser?.role === 'admin' || can('branches.viewAllBranches');
  const myBranchIds = new Set((db.userBranches || []).filter(ub => ub.userId === db.currentUser?.id).map(ub => ub.branchId));
  const companyBranches = (db.branches || []).filter(b => b.companyId === companyId && b.isActive !== false && (isBranchUnrestricted || myBranchIds.has(b.id)));
  const [selectedBranchId, setSelectedBranchId] = React.useState('ALL');
  const branchMatches = (branchId: string | null | undefined) => selectedBranchId === 'ALL' || branchId == null || branchId === selectedBranchId;

  const companyCustomers = db.customers.filter(c => c.companyId === companyId);
  const companyInvoices = db.invoices.filter(inv => inv.companyId === companyId && branchMatches((inv as any).branchId));

  // 1. Sales Register — every invoice in the period, full status detail.
  const getSalesRegisterData = () => {
    const rows = companyInvoices
      .filter(inv => inv.date >= startDate && inv.date <= endDate
        && (selectedCustomerId === 'ALL' || inv.customerId === selectedCustomerId))
      .map(inv => {
        const cust = db.customers.find(c => c.id === inv.customerId);
        // Signed — a Credit Note shows as its own line with a negative grandTotal, a real,
        // auditable reduction rather than being silently excluded or double-counted as
        // more sales (see dbStore.ts's getInvoiceSign).
        const total = calculateInvoiceTotals(db, inv.items, inv.taxSlabId, inv.discountPercentage).grandTotal * getInvoiceSign(inv);
        return {
          invoiceNumber: inv.invoiceNumber, date: inv.date, customerName: cust?.name || 'Walk-In',
          status: inv.status,
          // A Credit Note's stored paymentStatus is always 'Unpaid' (vestigial — it's not
          // a receivable), so it's relabeled here rather than shown as if a customer still
          // owes on it.
          paymentStatus: inv.documentType === 'CreditNote' ? 'Not Applicable' : inv.paymentStatus,
          zatcaStatus: (inv as any).zatcaStatus || 'NOT_SUBMITTED',
          grandTotal: total,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
    const totalSales = rows.reduce((s, r) => s + r.grandTotal, 0);
    return { rows, totalSales };
  };

  // 2. Item-wise Sales — quantity and revenue per product, from invoice line items with a
  // real productId (free-typed lines with no catalog link don't contribute — matches how
  // averageSalePrice itself is folded, same reasoning: nothing to aggregate them against).
  const getItemWiseSalesData = () => {
    const inRangeInvoices = companyInvoices.filter(inv => inv.date >= startDate && inv.date <= endDate && inv.status === 'Active');
    const byProduct = new Map<string, { productId: string; name: string; quantity: number; revenue: number }>();
    inRangeInvoices.forEach(inv => {
      // A Credit Note's items are a positive-amount copy of the original invoice's items
      // (ZATCA convention — see dbStore.ts's getInvoiceSign) representing goods effectively
      // un-sold, so both quantity and revenue must subtract here, not add on top.
      const sign = getInvoiceSign(inv);
      (inv.items || []).forEach((item: any) => {
        if (!item.productId) return;
        const product = db.products.find(p => p.id === item.productId);
        const key = item.productId;
        const existing = byProduct.get(key) || { productId: key, name: product?.name || item.description, quantity: 0, revenue: 0 };
        const qty = Number(item.quantity) || 0;
        const netUnit = Math.max(0, Number(item.unitCost) - Number(item.discountAmount || 0));
        existing.quantity += qty * sign;
        existing.revenue += qty * netUnit * sign;
        byProduct.set(key, existing);
      });
    });
    const rows = Array.from(byProduct.values()).sort((a, b) => b.revenue - a.revenue);
    return { rows, totalQuantity: rows.reduce((s, r) => s + r.quantity, 0), totalRevenue: rows.reduce((s, r) => s + r.revenue, 0) };
  };

  // 3. Customer Statement — chronological invoices (debit) and receipt vouchers (credit)
  // for one customer, with a running balance. Same shape as ReportViewer's Bank Ledger.
  const getCustomerStatementData = () => {
    if (!statementCustomerId) return { entries: [], endingBalance: 0, customerName: '' };
    const customer = db.customers.find(c => c.id === statementCustomerId);
    const custInvoices = companyInvoices.filter(inv => inv.customerId === statementCustomerId && inv.status === 'Active');
    const invoiceIds = new Set(custInvoices.map(inv => inv.id));
    const receipts = db.vouchers.filter(v => v.companyId === companyId && branchMatches((v as any).branchId) && v.type === 'Receipt' && v.referenceType === 'Invoice' && invoiceIds.has(v.referenceId));

    const entries: { date: string; type: string; docNumber: string; debit: number; credit: number }[] = [];
    custInvoices.forEach(inv => {
      const total = calculateInvoiceTotals(db, inv.items, inv.taxSlabId, inv.discountPercentage).grandTotal;
      // A Credit Note reduces what the customer owes — it's a credit entry (like a
      // receipt), not another debit charge, or it would inflate their balance instead of
      // reducing it.
      if (inv.documentType === 'CreditNote') {
        entries.push({ date: inv.date, type: 'Credit Note', docNumber: inv.invoiceNumber, debit: 0, credit: total });
      } else {
        entries.push({ date: inv.date, type: 'Invoice', docNumber: inv.invoiceNumber, debit: total, credit: 0 });
      }
    });
    receipts.forEach(v => {
      entries.push({ date: v.date, type: 'Receipt', docNumber: v.voucherNumber, debit: 0, credit: v.amount });
    });
    entries.sort((a, b) => a.date.localeCompare(b.date));

    let running = 0;
    const withBalance = entries.map(e => {
      running += e.debit - e.credit;
      return { ...e, runningBalance: running };
    });
    return { entries: withBalance, endingBalance: running, customerName: customer?.name || '' };
  };

  // 4. Quotation Conversion — funnel view of quotation outcomes in the period.
  const getQuotationConversionData = () => {
    const quotations = db.quotations.filter(q => q.companyId === companyId && branchMatches((q as any).branchId) && q.date >= startDate && q.date <= endDate
      && (selectedCustomerId === 'ALL' || q.customerId === selectedCustomerId));
    const converted = quotations.filter(q => q.status === 'Converted' && !q.isCancelled).length;
    const cancelled = quotations.filter(q => q.isCancelled).length;
    const pending = quotations.length - converted - cancelled;
    const conversionRate = quotations.length > 0 ? (converted / quotations.length) * 100 : 0;
    const rows = quotations.map(q => {
      const cust = db.customers.find(c => c.id === q.customerId);
      return { quotationNumber: q.quotationNumber, date: q.date, customerName: cust?.name || '', status: q.isCancelled ? 'Cancelled' : q.status };
    }).sort((a, b) => a.date.localeCompare(b.date));
    return { rows, total: quotations.length, converted, cancelled, pending, conversionRate };
  };

  // 5. Sales by Staff — revenue grouped by who created the invoice.
  const getSalesByStaffData = () => {
    const inRange = companyInvoices.filter(inv => inv.date >= startDate && inv.date <= endDate && inv.status === 'Active');
    const byStaff = new Map<string, { userId: string; username: string; invoiceCount: number; revenue: number }>();
    inRange.forEach(inv => {
      const user = db.users?.find(u => u.id === inv.createdById);
      const key = inv.createdById || 'unknown';
      const existing = byStaff.get(key) || { userId: key, username: user?.username || t('Unknown'), invoiceCount: 0, revenue: 0 };
      existing.invoiceCount += 1;
      existing.revenue += calculateInvoiceTotals(db, inv.items, inv.taxSlabId, inv.discountPercentage).grandTotal * getInvoiceSign(inv);
      byStaff.set(key, existing);
    });
    const rows = Array.from(byStaff.values()).sort((a, b) => b.revenue - a.revenue);
    return { rows, totalRevenue: rows.reduce((s, r) => s + r.revenue, 0) };
  };

  // 6. POS Shift Summary — cash vs. bank sales and cash variance per shift.
  const getPosShiftSummaryData = () => {
    const shifts = (db.posShifts || []).filter((s: any) => s.companyId === companyId
      && s.startTime && String(s.startTime).slice(0, 10) >= startDate && String(s.startTime).slice(0, 10) <= endDate);
    const rows = shifts.map((s: any) => {
      const shiftInvoices = companyInvoices.filter(inv => (inv as any).isPosSale && (inv as any).shiftId === s.id && inv.status === 'Active');
      const totalSales = shiftInvoices.reduce((sum, inv) => sum + calculateInvoiceTotals(db, inv.items, inv.taxSlabId, inv.discountPercentage).grandTotal, 0);
      const user = db.users?.find(u => u.id === s.userId);
      const variance = (s.endCash || 0) - (s.expectedCash || 0);
      return {
        id: s.id, date: String(s.startTime).slice(0, 10), cashier: user?.username || t('Unknown'),
        status: s.status, startCash: s.startCash, endCash: s.endCash || 0, expectedCash: s.expectedCash || 0,
        variance, totalSales, saleCount: shiftInvoices.length,
      };
    }).sort((a: any, b: any) => a.date.localeCompare(b.date));
    return { rows, totalSales: rows.reduce((s: number, r: any) => s + r.totalSales, 0) };
  };

  const handlePrint = () => {
    if (!can(REPORT_PERMISSION_KEYS[reportType])) return;
    let reportData: any = {};
    if (reportType === 'SalesRegister') reportData = getSalesRegisterData();
    else if (reportType === 'ItemWiseSales') reportData = getItemWiseSalesData();
    else if (reportType === 'CustomerStatement') reportData = getCustomerStatementData();
    else if (reportType === 'QuotationConversion') reportData = getQuotationConversionData();
    else if (reportType === 'SalesByStaff') reportData = getSalesByStaffData();
    else if (reportType === 'PosShiftSummary') reportData = getPosShiftSummaryData();
    onPrintDoc('Report', { type: reportType, startDate, endDate, data: reportData });
  };

  return (
    <div className="space-y-6">
      {!hasAccessToCurrentReport ? (
        <div className="bg-white border border-rose-200 rounded-2xl p-6 text-center text-sm text-rose-600 font-semibold">
          {t('You no longer have access to this report.')}
        </div>
      ) : (
        <>
          {/* Report header + export — flex-col on mobile so the title and button stack
              instead of cramming into one row on a narrow screen. */}
          <div className="bg-white border border-slate-200/80 rounded-2xl p-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-sm">
            <h3 className="text-sm font-extrabold text-slate-900">{t(REPORT_LABELS[reportType])}</h3>
            <button
              onClick={handlePrint}
              className="bg-slate-900 hover:bg-slate-950 text-white font-extrabold rounded-xl px-4 py-2 text-xs transition-all duration-150 flex items-center justify-center gap-1.5 shadow-md shrink-0 hover:shadow-lg"
            >
              <Printer className="w-4 h-4 text-indigo-400" /> {t('Export Statement (Print)')}
            </button>
          </div>

          {/* Dynamic Filter Panel — 1 column on mobile, up to 4 on desktop (same
              responsive grid as ReportViewer.tsx's own filter panel). */}
          <div className="bg-white border border-slate-200/80 rounded-2xl p-5 text-xs text-slate-600 shadow-sm">
            <div className="flex items-center gap-2 mb-5 border-b border-slate-100 pb-3 font-extrabold text-slate-900 uppercase tracking-widest text-[10px]">
              <Filter className="w-3.5 h-3.5 text-indigo-600" />
              <span>{t('Statement Audit Controls & Filters')}</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
              {reportType !== 'CustomerStatement' && (
                <>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('From Date')}</label>
                    <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                      className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none transition-all duration-150" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('To Date')}</label>
                    <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
                      className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none transition-all duration-150" />
                  </div>
                </>
              )}
              {(reportType === 'SalesRegister' || reportType === 'QuotationConversion') && (
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Filter Customer')}</label>
                  <select value={selectedCustomerId} onChange={e => setSelectedCustomerId(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none">
                    <option value="ALL">{t('Show All Customers')}</option>
                    {companyCustomers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              )}
              {reportType === 'CustomerStatement' && (
                <div className="space-y-1 md:col-span-2">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Customer (required)')}</label>
                  <select value={statementCustomerId} onChange={e => setStatementCustomerId(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none">
                    {companyCustomers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              )}
              {/* posShifts has no branchId yet (POS branch-awareness is a separate,
                  larger effort — see BACKLOG item 82) — this filter is a no-op for that
                  report type, so it's hidden there rather than shown but ineffective. */}
              {companyBranches.length > 0 && reportType !== 'PosShiftSummary' && (
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Filter Branch')}</label>
                  <select value={selectedBranchId} onChange={e => setSelectedBranchId(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none">
                    <option value="ALL">{t('All Branches')}</option>
                    {companyBranches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
              )}
            </div>
          </div>

          {/* REPORT CONTENT VIEWPORTS */}
          <div className="bg-white border border-slate-200/60 rounded-[28px] shadow-[0_8px_30px_rgb(0,0,0,0.04)] overflow-hidden p-6">

            {reportType === 'SalesRegister' && (() => {
              const data = getSalesRegisterData();
              return (
                <div className="space-y-4">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs text-start">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]">
                          <th className="p-3">{t('Invoice #')}</th><th className="p-3">{t('Date')}</th><th className="p-3">{t('Customer')}</th>
                          <th className="p-3">{t('Status')}</th><th className="p-3">{t('Payment')}</th><th className="p-3">{t('ZATCA')}</th>
                          <th className="p-3 text-end">{t('Grand Total')} ({currencySymbol})</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.rows.map((r, i) => (
                          <tr key={i} className="border-b border-slate-100 text-slate-700">
                            <td className="p-3 font-semibold">{r.invoiceNumber}</td><td className="p-3">{r.date}</td><td className="p-3">{r.customerName}</td>
                            <td className="p-3">{t(r.status)}</td><td className="p-3">{t(r.paymentStatus)}</td><td className="p-3">{t(r.zatcaStatus)}</td>
                            <td className="p-3 text-end font-mono font-bold">{currencySymbol} {r.grandTotal.toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="bg-slate-900 text-white font-bold text-xs">
                          <td className="p-3.5" colSpan={6}>{t('Total Sales:')}</td>
                          <td className="p-3.5 text-end font-mono text-emerald-400">{currencySymbol} {data.totalSales.toFixed(2)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              );
            })()}

            {reportType === 'ItemWiseSales' && (() => {
              const data = getItemWiseSalesData();
              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-start">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]">
                        <th className="p-3">{t('Product')}</th><th className="p-3 text-end">{t('Quantity Sold')}</th><th className="p-3 text-end">{t('Revenue')} ({currencySymbol})</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map((r, i) => (
                        <tr key={i} className="border-b border-slate-100 text-slate-700">
                          <td className="p-3 font-semibold">{r.name}</td><td className="p-3 text-end font-mono">{r.quantity}</td><td className="p-3 text-end font-mono font-bold">{currencySymbol} {r.revenue.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-slate-900 text-white font-bold text-xs">
                        <td className="p-3.5">{t('Total:')}</td>
                        <td className="p-3.5 text-end font-mono">{data.totalQuantity}</td>
                        <td className="p-3.5 text-end font-mono text-emerald-400">{currencySymbol} {data.totalRevenue.toFixed(2)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              );
            })()}

            {reportType === 'CustomerStatement' && (() => {
              const data = getCustomerStatementData();
              return (
                <div className="space-y-4">
                  <h3 className="text-sm font-bold text-slate-900">{data.customerName}</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs text-start">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]">
                          <th className="p-3">{t('Date')}</th><th className="p-3">{t('Type')}</th><th className="p-3">{t('Document #')}</th>
                          <th className="p-3 text-end">{t('Invoiced')} ({currencySymbol})</th><th className="p-3 text-end">{t('Received')} ({currencySymbol})</th><th className="p-3 text-end">{t('Balance')} ({currencySymbol})</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.entries.map((e, i) => (
                          <tr key={i} className="border-b border-slate-100 text-slate-700">
                            <td className="p-3">{e.date}</td><td className="p-3">{t(e.type)}</td><td className="p-3 font-semibold">{e.docNumber}</td>
                            <td className="p-3 text-end font-mono">{e.debit > 0 ? `${currencySymbol} ${e.debit.toFixed(2)}` : '-'}</td>
                            <td className="p-3 text-end font-mono">{e.credit > 0 ? `${currencySymbol} ${e.credit.toFixed(2)}` : '-'}</td>
                            <td className="p-3 text-end font-mono font-bold">{currencySymbol} {(e as any).runningBalance.toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex justify-end">
                    <div className="bg-indigo-50 rounded-xl px-4 py-2 text-xs font-black text-indigo-900">{t('Ending Balance:')} {currencySymbol} {data.endingBalance.toFixed(2)}</div>
                  </div>
                </div>
              );
            })()}

            {reportType === 'QuotationConversion' && (() => {
              const data = getQuotationConversionData();
              return (
                <div className="space-y-6">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <div className="bg-slate-50 rounded-2xl p-4 text-center"><p className="text-[10px] font-bold text-slate-400 uppercase">{t('Total')}</p><p className="text-lg font-black text-slate-900">{data.total}</p></div>
                    <div className="bg-emerald-50 rounded-2xl p-4 text-center"><p className="text-[10px] font-bold text-emerald-600 uppercase">{t('Converted')}</p><p className="text-lg font-black text-emerald-700">{data.converted}</p></div>
                    <div className="bg-amber-50 rounded-2xl p-4 text-center"><p className="text-[10px] font-bold text-amber-600 uppercase">{t('Pending')}</p><p className="text-lg font-black text-amber-700">{data.pending}</p></div>
                    <div className="bg-indigo-600 rounded-2xl p-4 text-center"><p className="text-[10px] font-bold text-white/70 uppercase">{t('Conversion Rate')}</p><p className="text-lg font-black text-white">{data.conversionRate.toFixed(1)}%</p></div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs text-start">
                      <thead><tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]"><th className="p-3">{t('Quotation #')}</th><th className="p-3">{t('Date')}</th><th className="p-3">{t('Customer')}</th><th className="p-3">{t('Status')}</th></tr></thead>
                      <tbody>{data.rows.map((r, i) => (<tr key={i} className="border-b border-slate-100 text-slate-700"><td className="p-3 font-semibold">{r.quotationNumber}</td><td className="p-3">{r.date}</td><td className="p-3">{r.customerName}</td><td className="p-3">{t(r.status)}</td></tr>))}</tbody>
                    </table>
                  </div>
                </div>
              );
            })()}

            {reportType === 'SalesByStaff' && (() => {
              const data = getSalesByStaffData();
              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-start">
                    <thead><tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]"><th className="p-3">{t('Staff')}</th><th className="p-3 text-end">{t('Invoices')}</th><th className="p-3 text-end">{t('Revenue')} ({currencySymbol})</th></tr></thead>
                    <tbody>{data.rows.map((r, i) => (<tr key={i} className="border-b border-slate-100 text-slate-700"><td className="p-3 font-semibold">{r.username}</td><td className="p-3 text-end font-mono">{r.invoiceCount}</td><td className="p-3 text-end font-mono font-bold">{currencySymbol} {r.revenue.toFixed(2)}</td></tr>))}</tbody>
                    <tfoot><tr className="bg-slate-900 text-white font-bold text-xs"><td className="p-3.5" colSpan={2}>{t('Total:')}</td><td className="p-3.5 text-end font-mono text-emerald-400">{currencySymbol} {data.totalRevenue.toFixed(2)}</td></tr></tfoot>
                  </table>
                </div>
              );
            })()}

            {reportType === 'PosShiftSummary' && (() => {
              const data = getPosShiftSummaryData();
              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-start">
                    <thead><tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]"><th className="p-3">{t('Date')}</th><th className="p-3">{t('Cashier')}</th><th className="p-3">{t('Status')}</th><th className="p-3 text-end">{t('Sales')} ({currencySymbol})</th><th className="p-3 text-end">{t('Expected Cash')}</th><th className="p-3 text-end">{t('End Cash')}</th><th className="p-3 text-end">{t('Variance')}</th></tr></thead>
                    <tbody>{data.rows.map((r: any, i: number) => (
                      <tr key={i} className="border-b border-slate-100 text-slate-700">
                        <td className="p-3">{r.date}</td><td className="p-3 font-semibold">{r.cashier}</td><td className="p-3">{t(r.status)}</td>
                        <td className="p-3 text-end font-mono">{currencySymbol} {r.totalSales.toFixed(2)}</td>
                        <td className="p-3 text-end font-mono">{currencySymbol} {r.expectedCash.toFixed(2)}</td>
                        <td className="p-3 text-end font-mono">{currencySymbol} {r.endCash.toFixed(2)}</td>
                        <td className={`p-3 text-end font-mono font-bold ${Math.abs(r.variance) < 0.01 ? 'text-slate-500' : r.variance < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{currencySymbol} {r.variance.toFixed(2)}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              );
            })()}

          </div>
        </>
      )}
    </div>
  );
}
