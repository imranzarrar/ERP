import React from 'react';
import { useTranslation, usePermissions } from '../hooks';
import { DatabaseState } from '../dbStore';
import { getMonthToDateRange } from '../dateUtils';
import { Printer, Filter } from 'lucide-react';
import { useReportViewer, ViewReportButton, ReportPlaceholder, ReportStatusStrip, ReportPager } from './ReportViewControls';

type ReportType = 'PurchaseRegister' | 'VendorStatement' | 'PoStatus' | 'GrnPoVariance';

interface PurchaseReportsModuleProps {
  db: DatabaseState;
  defaultReportType: ReportType;
  onPrintDoc: (type: 'Quotation' | 'Invoice' | 'Expense' | 'Voucher' | 'Report', data: any) => void;
}

const REPORT_PERMISSION_KEYS: Record<ReportType, string> = {
  PurchaseRegister: 'reports.purchaseRegister',
  VendorStatement: 'reports.vendorStatement',
  PoStatus: 'reports.poStatus',
  GrnPoVariance: 'reports.grnPoVariance',
};

const REPORT_LABELS: Record<ReportType, string> = {
  PurchaseRegister: 'Purchase Register',
  VendorStatement: 'Vendor Statement of Account',
  PoStatus: 'Purchase Order Status Report',
  GrnPoVariance: 'GRN vs. PO Variance',
};

// Today's date snapshot for aging calculations — matches the fixed "today" convention
// already used elsewhere in this codebase's seeded/demo data (2026-08).
const TODAY = '2026-08-08';
function daysBetween(a: string, b: string): number {
  return Math.round((new Date(a).getTime() - new Date(b).getTime()) / (1000 * 60 * 60 * 24));
}

export default function PurchaseReportsModule({ db, defaultReportType, onPrintDoc }: PurchaseReportsModuleProps) {
  const { t } = useTranslation(db);
  const { can } = usePermissions(db.currentUser);
  const [reportType, setReportType] = React.useState<ReportType>(defaultReportType);
  React.useEffect(() => { setReportType(defaultReportType); }, [defaultReportType]);
  const hasAccessToCurrentReport = can(REPORT_PERMISSION_KEYS[reportType]);
  const currencySymbol = db.companySetup?.currency || 'SAR';
  const companyId = db.selectedCompanyId;

  const [startDate, setStartDate] = React.useState(() => getMonthToDateRange().start);
  const [endDate, setEndDate] = React.useState(() => getMonthToDateRange().end);
  const [selectedVendorId, setSelectedVendorId] = React.useState('ALL');
  const [statementVendorId, setStatementVendorId] = React.useState('');
  const companyVendors = db.vendors.filter(v => v.companyId === companyId);
  React.useEffect(() => {
    if (!statementVendorId) {
      const first = companyVendors.find(v => !v.isSystem);
      if (first) setStatementVendorId(first.id);
    }
  }, [db.vendors, companyId]);

  // Branch focus — see SalesReportsModule.tsx's matching comment for the full reasoning
  // (a convenience narrowing on top of the already-secure server-side filter, never the
  // security boundary itself). GRNs have no branchId of their own — derived via warehouse.
  const isBranchUnrestricted = db.currentUser?.isSuperAdmin === true || db.currentUser?.role === 'admin' || can('branches.viewAllBranches');
  const myBranchIds = new Set((db.userBranches || []).filter(ub => ub.userId === db.currentUser?.id).map(ub => ub.branchId));
  const companyBranches = (db.branches || []).filter(b => b.companyId === companyId && b.isActive !== false && (isBranchUnrestricted || myBranchIds.has(b.id)));
  const [selectedBranchId, setSelectedBranchId] = React.useState('ALL');
  const branchMatches = (branchId: string | null | undefined) => selectedBranchId === 'ALL' || branchId == null || branchId === selectedBranchId;
  const branchIdByWarehouseId = new Map((db.warehouses || []).map((w: any) => [w.id, w.branchId]));
  const branchMatchesViaWarehouse = (warehouseId: string | null | undefined) => branchMatches(warehouseId ? branchIdByWarehouseId.get(warehouseId) : undefined);

  const companyExpenses = db.expenses.filter(e => e.companyId === companyId && branchMatches((e as any).branchId));
  const companyPOs = (db.purchaseOrders || []).filter((po: any) => po.companyId === companyId);
  const companyGRNs = (db.goodsReceiptNotes || []).filter((g: any) => g.companyId === companyId);

  // Purchase Register / Vendor Statement come from GET /api/reports/purchase-register and
  // /vendor-statement (server/lib/financialReports.ts) — see
  // .claude/skills/server-side-report-aggregation/SKILL.md. PO Status and GRN vs. PO Variance
  // are still worked out in the browser from purchaseOrders/goodsReceiptNotes (never among the
  // capped tables in src/db/apiState.ts). None of the four runs on open or on a filter change:
  // the user sets filters and clicks View Report, which fetches (or, for the two in-browser
  // reports, snapshots the filters those calculations then use).
  const viewer = useReportViewer<any>({ rows: [] });
  React.useEffect(() => { viewer.reset(); }, [reportType, companyId]);
  const isServerReport = reportType === 'PurchaseRegister' || reportType === 'VendorStatement';
  const draftFilters = { startDate, endDate, vendorId: selectedVendorId, branchId: selectedBranchId };
  // In-browser reports read the filters as they were when View Report was clicked, never the
  // draft inputs the user may have edited since.
  const appliedFilters = (viewer.snapshot || draftFilters) as typeof draftFilters;
  const appliedBranchMatches = (branchId: string | null | undefined) => appliedFilters.branchId === 'ALL' || branchId == null || branchId === appliedFilters.branchId;

  const buildReportUrl = (): string | null => {
    if (!isServerReport) return null;
    const params = new URLSearchParams();
    if (selectedBranchId !== 'ALL') params.set('branchId', selectedBranchId);
    if (reportType === 'VendorStatement') {
      if (!statementVendorId) return null;
      params.set('vendorId', statementVendorId);
      return `/api/reports/vendor-statement?${params}`;
    }
    params.set('startDate', startDate);
    params.set('endDate', endDate);
    if (selectedVendorId !== 'ALL') params.set('vendorId', selectedVendorId);
    return `/api/reports/purchase-register?${params}`;
  };
  const currentUrl = buildReportUrl();
  const currentKey = isServerReport ? currentUrl : `local:${reportType}:${JSON.stringify(draftFilters)}`;
  const isStale = viewer.hasViewed && viewer.appliedKey !== currentKey;
  const canView = isServerReport ? !!currentUrl : true;
  const handleView = () => {
    if (isServerReport) { if (currentUrl) viewer.view(currentUrl, currentUrl); }
    else viewer.view(currentKey!, null, draftFilters);
  };
  const viewed = viewer.hasViewed;

  const getPurchaseRegisterData = () => viewer.data as { rows: any[]; totalAmount: number };
  const getVendorStatementData = () => viewer.data as { entries: any[]; endingBalance: number; vendorName: string };

  // 3. PO Status — every PO by fulfillment status, with aging for what's still open.
  const getPoStatusData = () => {
    const rows = companyPOs
      .filter((po: any) => appliedBranchMatches(po.branchId) && po.date >= appliedFilters.startDate && po.date <= appliedFilters.endDate && (appliedFilters.vendorId === 'ALL' || po.vendorId === appliedFilters.vendorId))
      .map((po: any) => {
        const vend = db.vendors.find(v => v.id === po.vendorId);
        const isOpen = po.status === 'Sent' || po.status === 'Partially Received';
        return { poNumber: po.poNumber, date: po.date, vendorName: vend?.name || '', status: po.status, totalAmount: Number(po.totalAmount), ageDays: isOpen ? daysBetween(TODAY, po.date) : null };
      })
      .sort((a: any, b: any) => a.date.localeCompare(b.date));
    // Cancelled POs stay visible (status column already shows them) but never count
    // toward the printed total.
    return { rows, totalAmount: rows.filter((r: any) => r.status !== 'Cancelled').reduce((s: number, r: any) => s + r.totalAmount, 0) };
  };

  // 4. GRN vs. PO Variance — ordered vs. actually received quantity per PO line, summed
  // across every (non-reversed) GRN raised against that PO.
  const getGrnPoVarianceData = () => {
    const pos = companyPOs.filter((po: any) => appliedBranchMatches(po.branchId) && po.date >= appliedFilters.startDate && po.date <= appliedFilters.endDate && (appliedFilters.vendorId === 'ALL' || po.vendorId === appliedFilters.vendorId));
    const rows: any[] = [];
    pos.forEach((po: any) => {
      const vend = db.vendors.find(v => v.id === po.vendorId);
      const relatedGrns = companyGRNs.filter((g: any) => g.purchaseOrderId === po.id && !g.isReversed && appliedBranchMatches(branchIdByWarehouseId.get(g.warehouseId)));
      (po.items || []).forEach((item: any) => {
        const received = relatedGrns.reduce((sum: number, g: any) => {
          const grnItem = (g.items || []).find((gi: any) => gi.productId === item.productId);
          return sum + (grnItem ? Number(grnItem.quantityReceived) : 0);
        }, 0);
        const product = db.products.find(p => p.id === item.productId);
        rows.push({
          poNumber: po.poNumber, vendorName: vend?.name || '', productName: product?.name || item.productName || '',
          ordered: Number(item.quantityOrdered), received, variance: Number(item.quantityOrdered) - received,
        });
      });
    });
    return { rows };
  };

  const handlePrint = async () => {
    if (!can(REPORT_PERMISSION_KEYS[reportType]) || !viewed) return;
    try {
      let reportData: any;
      if (isServerReport) reportData = (await viewer.fetchAll()) || viewer.data; // every row, not just the on-screen page
      else if (reportType === 'PoStatus') reportData = getPoStatusData();
      else reportData = getGrnPoVarianceData();
      onPrintDoc('Report', { type: reportType, startDate: appliedFilters.startDate, endDate: appliedFilters.endDate, data: reportData });
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
          <div className="bg-white border border-slate-200/80 rounded-2xl p-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-sm">
            <h3 className="text-sm font-extrabold text-slate-900">{t(REPORT_LABELS[reportType])}</h3>
            <button onClick={handlePrint} className="bg-slate-900 hover:bg-slate-950 text-white font-extrabold rounded-xl px-4 py-2 text-xs transition-all duration-150 flex items-center justify-center gap-1.5 shadow-md shrink-0 hover:shadow-lg">
              <Printer className="w-4 h-4 text-indigo-400" /> {t('Export Statement (Print)')}
            </button>
          </div>

          <div className="bg-white border border-slate-200/80 rounded-2xl p-5 text-xs text-slate-600 shadow-sm">
            <div className="flex items-center gap-2 mb-5 border-b border-slate-100 pb-3 font-extrabold text-slate-900 uppercase tracking-widest text-[10px]">
              <Filter className="w-3.5 h-3.5 text-indigo-600" /><span>{t('Statement Audit Controls & Filters')}</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
              {reportType !== 'VendorStatement' && (
                <>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('From Date')}</label>
                    <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="w-full bg-white border border-slate-200 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('To Date')}</label>
                    <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="w-full bg-white border border-slate-200 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Filter Vendor')}</label>
                    <select value={selectedVendorId} onChange={e => setSelectedVendorId(e.target.value)} className="w-full bg-white border border-slate-200 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none">
                      <option value="ALL">{t('Show All Vendors')}</option>
                      {companyVendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                    </select>
                  </div>
                </>
              )}
              {reportType === 'VendorStatement' && (
                <div className="space-y-1 md:col-span-2">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Vendor (required)')}</label>
                  <select value={statementVendorId} onChange={e => setStatementVendorId(e.target.value)} className="w-full bg-white border border-slate-200 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none">
                    {companyVendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </div>
              )}
              {companyBranches.length > 0 && (
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Filter Branch')}</label>
                  <select value={selectedBranchId} onChange={e => setSelectedBranchId(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none">
                    <option value="ALL">{t('All Branches')}</option>
                    {companyBranches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
              )}
              <ViewReportButton onView={handleView} loading={viewer.loading} stale={isStale} disabled={!canView} t={t} />
            </div>
          </div>

          <div className="bg-white border border-slate-200/60 rounded-[28px] shadow-[0_8px_30px_rgb(0,0,0,0.04)] overflow-hidden p-6">
            {!viewed || !viewer.loaded ? (
              <ReportPlaceholder loading={viewer.loading} error={viewer.error} t={t} />
            ) : (
            <>
            <ReportStatusStrip loading={viewer.loading} error={viewer.error} t={t} />

            {reportType === 'PurchaseRegister' && (() => {
              const data = getPurchaseRegisterData();
              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-start">
                    <thead><tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]"><th className="p-3 text-start">{t('Expense #')}</th><th className="p-3 text-start">{t('Date')}</th><th className="p-3 text-start">{t('Vendor')}</th><th className="p-3 text-start">{t('Status')}</th><th className="p-3 text-start">{t('Payment')}</th><th className="p-3 text-end">{t('Amount')} ({currencySymbol})</th></tr></thead>
                    <tbody>{data.rows.map((r, i) => (<tr key={i} className="border-b border-slate-100 text-slate-700"><td className="p-3 font-semibold">{r.expenseNumber}</td><td className="p-3">{r.date}</td><td className="p-3">{r.vendorName}</td><td className="p-3">{t(r.status)}</td><td className="p-3">{t(r.paymentStatus)}</td><td className="p-3 text-end font-mono font-bold">{currencySymbol} {r.totalAmount.toFixed(2)}</td></tr>))}</tbody>
                    <tfoot><tr className="bg-slate-900 text-white font-bold text-xs"><td className="p-3.5" colSpan={5}>{t('Total:')}</td><td className="p-3.5 text-end font-mono text-emerald-400">{currencySymbol} {data.totalAmount.toFixed(2)}</td></tr></tfoot>
                  </table>
                </div>
              );
            })()}

            {reportType === 'VendorStatement' && (() => {
              const data = getVendorStatementData();
              return (
                <div className="space-y-4">
                  <h3 className="text-sm font-bold text-slate-900">{data.vendorName}</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs text-start">
                      <thead><tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]"><th className="p-3 text-start">{t('Date')}</th><th className="p-3 text-start">{t('Type')}</th><th className="p-3 text-start">{t('Document #')}</th><th className="p-3 text-end">{t('Billed')} ({currencySymbol})</th><th className="p-3 text-end">{t('Paid')} ({currencySymbol})</th><th className="p-3 text-end">{t('Balance')} ({currencySymbol})</th></tr></thead>
                      <tbody>{data.entries.map((e, i) => (<tr key={i} className="border-b border-slate-100 text-slate-700"><td className="p-3">{e.date}</td><td className="p-3">{t(e.type)}</td><td className="p-3 font-semibold">{e.docNumber}</td><td className="p-3 text-end font-mono">{e.debit > 0 ? `${currencySymbol} ${e.debit.toFixed(2)}` : '-'}</td><td className="p-3 text-end font-mono">{e.credit > 0 ? `${currencySymbol} ${e.credit.toFixed(2)}` : '-'}</td><td className="p-3 text-end font-mono font-bold">{currencySymbol} {(e as any).runningBalance.toFixed(2)}</td></tr>))}</tbody>
                    </table>
                  </div>
                  <div className="flex justify-end"><div className="bg-indigo-50 rounded-xl px-4 py-2 text-xs font-black text-indigo-900">{t('Ending Balance:')} {currencySymbol} {data.endingBalance.toFixed(2)}</div></div>
                </div>
              );
            })()}

            {reportType === 'PoStatus' && (() => {
              const data = getPoStatusData();
              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-start">
                    <thead><tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]"><th className="p-3 text-start">{t('PO #')}</th><th className="p-3 text-start">{t('Date')}</th><th className="p-3 text-start">{t('Vendor')}</th><th className="p-3 text-start">{t('Status')}</th><th className="p-3 text-end">{t('Age (days)')}</th><th className="p-3 text-end">{t('Total')} ({currencySymbol})</th></tr></thead>
                    <tbody>{data.rows.map((r: any, i: number) => (<tr key={i} className="border-b border-slate-100 text-slate-700"><td className="p-3 font-semibold">{r.poNumber}</td><td className="p-3">{r.date}</td><td className="p-3">{r.vendorName}</td><td className="p-3">{t(r.status)}</td><td className="p-3 text-end font-mono">{r.ageDays !== null ? r.ageDays : '-'}</td><td className="p-3 text-end font-mono font-bold">{currencySymbol} {r.totalAmount.toFixed(2)}</td></tr>))}</tbody>
                    <tfoot><tr className="bg-slate-900 text-white font-bold text-xs"><td className="p-3.5" colSpan={5}>{t('Total:')}</td><td className="p-3.5 text-end font-mono text-emerald-400">{currencySymbol} {data.totalAmount.toFixed(2)}</td></tr></tfoot>
                  </table>
                </div>
              );
            })()}

            {reportType === 'GrnPoVariance' && (() => {
              const data = getGrnPoVarianceData();
              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-start">
                    <thead><tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]"><th className="p-3 text-start">{t('PO #')}</th><th className="p-3 text-start">{t('Vendor')}</th><th className="p-3 text-start">{t('Product')}</th><th className="p-3 text-end">{t('Ordered')}</th><th className="p-3 text-end">{t('Received')}</th><th className="p-3 text-end">{t('Variance')}</th></tr></thead>
                    <tbody>{data.rows.map((r: any, i: number) => (
                      <tr key={i} className="border-b border-slate-100 text-slate-700">
                        <td className="p-3 font-semibold">{r.poNumber}</td><td className="p-3">{r.vendorName}</td><td className="p-3">{r.productName}</td>
                        <td className="p-3 text-end font-mono">{r.ordered}</td><td className="p-3 text-end font-mono">{r.received}</td>
                        <td className={`p-3 text-end font-mono font-bold ${r.variance === 0 ? 'text-slate-500' : r.variance > 0 ? 'text-amber-600' : 'text-rose-600'}`}>{r.variance}</td>
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
