import React from 'react';
import { useTranslation, usePermissions } from '../hooks';
import { DatabaseState } from '../dbStore';
import { getMonthToDateRange } from '../dateUtils';
import { Printer, Filter } from 'lucide-react';
import { useReportViewer, ViewReportButton, ReportPlaceholder, ReportStatusStrip, ReportPager } from './ReportViewControls';

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

  const [startDate, setStartDate] = React.useState(() => getMonthToDateRange().start);
  const [endDate, setEndDate] = React.useState(() => getMonthToDateRange().end);
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

  // Nothing here queries the server on open or on a filter change: the user sets filters and
  // clicks View Report (see ReportViewControls.tsx). Company scope is resolved server-side
  // from req.targetCompanyId — never sent by the client — and the branch filter, which can
  // only narrow what the user may already see, travels as ?branchId=.
  const viewer = useReportViewer<any>({ rows: [] });
  React.useEffect(() => { viewer.reset(); }, [reportType, companyId]);

  const buildReportUrl = (): string | null => {
    const params = new URLSearchParams();
    if (selectedBranchId !== 'ALL' && reportType !== 'PosShiftSummary') params.set('branchId', selectedBranchId);
    if (reportType === 'CustomerStatement') {
      if (!statementCustomerId) return null;
      params.set('customerId', statementCustomerId);
    } else {
      params.set('startDate', startDate);
      params.set('endDate', endDate);
      if ((reportType === 'SalesRegister' || reportType === 'QuotationConversion') && selectedCustomerId !== 'ALL') params.set('customerId', selectedCustomerId);
    }
    const path = {
      SalesRegister: 'sales-register', ItemWiseSales: 'item-wise-sales', CustomerStatement: 'customer-statement',
      QuotationConversion: 'quotation-conversion', SalesByStaff: 'sales-by-staff', PosShiftSummary: 'pos-shift-summary',
    }[reportType];
    return `/api/reports/${path}?${params}`;
  };
  const currentUrl = buildReportUrl();
  const isStale = viewer.hasViewed && viewer.appliedKey !== currentUrl;
  const handleView = () => { if (currentUrl) viewer.view(currentUrl, currentUrl); };
  const viewed = viewer.hasViewed;

  const getSalesRegisterData = () => viewer.data as { rows: any[]; totalSales: number };
  const getItemWiseSalesData = () => viewer.data as { rows: any[]; totalQuantity: number; totalRevenue: number };
  const getCustomerStatementData = () => viewer.data as { entries: any[]; endingBalance: number; customerName: string };
  const getQuotationConversionData = () => viewer.data as { rows: any[]; total: number; converted: number; cancelled: number; pending: number; conversionRate: number };
  const getSalesByStaffData = () => viewer.data as { rows: any[]; totalRevenue: number };
  const getPosShiftSummaryData = () => viewer.data as { rows: any[]; totalSales: number };

  const handlePrint = async () => {
    if (!can(REPORT_PERMISSION_KEYS[reportType]) || !viewed) return;
    try {
      // The screen only holds one page of a large report — print needs every row.
      const full = await viewer.fetchAll();
      onPrintDoc('Report', { type: reportType, startDate, endDate, data: full || viewer.data });
    } catch (e: any) {
      window.alert(e?.message || t('Failed to load report'));
    }
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
              <ViewReportButton onView={handleView} loading={viewer.loading} stale={isStale} disabled={!currentUrl} t={t} />
            </div>
          </div>

          {/* REPORT CONTENT VIEWPORTS */}
          <div className="bg-white border border-slate-200/60 rounded-[28px] shadow-[0_8px_30px_rgb(0,0,0,0.04)] overflow-hidden p-6">
            {!viewed || !viewer.loaded ? (
              <ReportPlaceholder loading={viewer.loading} error={viewer.error} t={t} />
            ) : (
            <>
            <ReportStatusStrip loading={viewer.loading} error={viewer.error} t={t} />

            {reportType === 'SalesRegister' && (() => {
              const data = getSalesRegisterData();
              return (
                <div className="space-y-4">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs text-start">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]">
                          <th className="p-3 text-start">{t('Invoice #')}</th><th className="p-3 text-start">{t('Date')}</th><th className="p-3 text-start">{t('Customer')}</th>
                          <th className="p-3 text-start">{t('Status')}</th><th className="p-3 text-start">{t('Payment')}</th><th className="p-3 text-start">{t('ZATCA')}</th>
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
                        <th className="p-3 text-start">{t('Product')}</th><th className="p-3 text-end">{t('Quantity Sold')}</th><th className="p-3 text-end">{t('Revenue')} ({currencySymbol})</th>
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
                          <th className="p-3 text-start">{t('Date')}</th><th className="p-3 text-start">{t('Type')}</th><th className="p-3 text-start">{t('Document #')}</th>
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
                      <thead><tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]"><th className="p-3 text-start">{t('Quotation #')}</th><th className="p-3 text-start">{t('Date')}</th><th className="p-3 text-start">{t('Customer')}</th><th className="p-3 text-start">{t('Status')}</th></tr></thead>
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
                    <thead><tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]"><th className="p-3 text-start">{t('Staff')}</th><th className="p-3 text-end">{t('Invoices')}</th><th className="p-3 text-end">{t('Revenue')} ({currencySymbol})</th></tr></thead>
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
                    <thead><tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]"><th className="p-3 text-start">{t('Date')}</th><th className="p-3 text-start">{t('Cashier')}</th><th className="p-3 text-start">{t('Status')}</th><th className="p-3 text-end">{t('Sales')} ({currencySymbol})</th><th className="p-3 text-end">{t('Expected Cash')}</th><th className="p-3 text-end">{t('End Cash')}</th><th className="p-3 text-end">{t('Variance')}</th></tr></thead>
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

            <ReportPager pagination={viewer.pagination} pageSize={viewer.pageSize} loading={viewer.loading} onPage={viewer.goToPage} onPageSize={viewer.changePageSize} t={t} />
            </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
