import React from 'react';
import { useTranslation, usePermissions } from '../hooks';
import { DatabaseState } from '../dbStore';
import { getMonthToDateRange } from '../dateUtils';
import { Printer, Filter } from 'lucide-react';
import { useReportViewer, ViewReportButton, ReportPlaceholder, ReportStatusStrip, ReportPager } from './ReportViewControls';

type ReportType = 'StockValuation' | 'ItemProfitability' | 'LowStock' | 'StockTakeVarianceHistory' | 'StockMovementLedger' | 'WarehouseTransferReconciliation';

interface InventoryReportsModuleProps {
  db: DatabaseState;
  defaultReportType: ReportType;
  onPrintDoc: (type: 'Quotation' | 'Invoice' | 'Expense' | 'Voucher' | 'Report', data: any) => void;
}

const REPORT_PERMISSION_KEYS: Record<ReportType, string> = {
  StockValuation: 'reports.stockValuation',
  ItemProfitability: 'reports.itemProfitability',
  LowStock: 'reports.lowStock',
  StockTakeVarianceHistory: 'reports.stockTakeVarianceHistory',
  StockMovementLedger: 'reports.stockMovementLedger',
  WarehouseTransferReconciliation: 'reports.warehouseTransferReconciliation',
};

const REPORT_LABELS: Record<ReportType, string> = {
  StockValuation: 'Stock Valuation Report',
  ItemProfitability: 'Item Profitability Report',
  LowStock: 'Low Stock / Reorder Report',
  StockTakeVarianceHistory: 'Stock Take Variance History',
  StockMovementLedger: 'Stock Movement Ledger',
  WarehouseTransferReconciliation: 'Warehouse Transfer Reconciliation',
};

const TRANSACTION_TYPE_LABELS: Record<string, string> = {
  GRN: 'Goods Receipt',
  Return: 'Purchase Return',
  Sale: 'Sale',
  Adjustment: 'Stock Adjustment',
  StockTake: 'Stock Take',
  TransferOut: 'Transfer Out',
  TransferIn: 'Transfer In',
};

export default function InventoryReportsModule({ db, defaultReportType, onPrintDoc }: InventoryReportsModuleProps) {
  const { t } = useTranslation(db);
  const { can } = usePermissions(db.currentUser);
  const [reportType, setReportType] = React.useState<ReportType>(defaultReportType);
  React.useEffect(() => { setReportType(defaultReportType); }, [defaultReportType]);
  const hasAccessToCurrentReport = can(REPORT_PERMISSION_KEYS[reportType]);
  const currencySymbol = db.companySetup?.currency || 'SAR';
  const companyId = db.selectedCompanyId;

  const [startDate, setStartDate] = React.useState(() => getMonthToDateRange().start);
  const [endDate, setEndDate] = React.useState(() => getMonthToDateRange().end);
  const [selectedWarehouseId, setSelectedWarehouseId] = React.useState('ALL');
  const [selectedProductId, setSelectedProductId] = React.useState('ALL');

  // Branch focus — see SalesReportsModule.tsx's matching comment for the full reasoning.
  // Purely a client-side convenience narrowing for the warehouse dropdown below; the
  // actual branch security boundary is enforced server-side in every /api/reports/* call
  // via req.allowedBranchIds, never here.
  const isBranchUnrestricted = db.currentUser?.isSuperAdmin === true || db.currentUser?.role === 'admin' || can('branches.viewAllBranches');
  const myBranchIds = new Set((db.userBranches || []).filter(ub => ub.userId === db.currentUser?.id).map(ub => ub.branchId));
  const companyBranches = (db.branches || []).filter(b => b.companyId === companyId && b.isActive !== false && (isBranchUnrestricted || myBranchIds.has(b.id)));
  const [selectedBranchId, setSelectedBranchId] = React.useState('ALL');
  const branchMatches = (branchId: string | null | undefined) => selectedBranchId === 'ALL' || branchId == null || branchId === selectedBranchId;

  const companyWarehouses = (db.warehouses || []).filter((w: any) => w.companyId === companyId && branchMatches(w.branchId));
  const companyProducts = (db.products || []).filter((p: any) => p.companyId === companyId);

  // All 6 reports below are fetched from GET /api/reports/* (server/lib/financialReports.ts)
  // instead of computed client-side from db.inventoryStocks/stockLedgerTransactions/etc —
  // see .claude/skills/server-side-report-aggregation/SKILL.md. This module previously
  // computed every one of these from /api/state, which both row-caps stockLedgerTransactions
  // and goes stale after several Inventory write paths that don't refresh client state
  // (e.g. InventoryModule.tsx's handleCreateGrn) — confirmed producing a report that
  // disagreed with the real ledger during QA. Company/branch scope is resolved
  // server-side from req.targetCompanyId/req.allowedBranchIds — never sent by the client.
  // Quantities throughout are always base-unit terms (see each table's own note below).

  const [pendingOnly, setPendingOnly] = React.useState(false);

  // One viewer for whichever report is on screen. Nothing is fetched on open or when a
  // filter changes — only when the user clicks View Report — and switching to a different
  // report clears the previous one rather than leaving its rows on screen.
  const viewer = useReportViewer<any>({ rows: [] });
  React.useEffect(() => { viewer.reset(); }, [reportType, companyId]);

  const buildReportUrl = (): string => {
    const params = new URLSearchParams();
    if (selectedBranchId !== 'ALL' && reportType !== 'ItemProfitability') params.set('branchId', selectedBranchId);
    const usesWarehouse = reportType !== 'ItemProfitability';
    if (usesWarehouse && selectedWarehouseId !== 'ALL') params.set('warehouseId', selectedWarehouseId);
    const usesDates = reportType === 'StockTakeVarianceHistory' || reportType === 'StockMovementLedger' || reportType === 'WarehouseTransferReconciliation';
    if (usesDates) { params.set('startDate', startDate); params.set('endDate', endDate); }
    if (reportType === 'StockMovementLedger' && selectedProductId !== 'ALL') params.set('productId', selectedProductId);
    if (reportType === 'WarehouseTransferReconciliation' && pendingOnly) params.set('pendingOnly', 'true');
    const path = {
      StockValuation: 'stock-valuation', ItemProfitability: 'item-profitability', LowStock: 'low-stock',
      StockTakeVarianceHistory: 'stock-take-variance-history', StockMovementLedger: 'stock-movement-ledger',
      WarehouseTransferReconciliation: 'warehouse-transfer-reconciliation',
    }[reportType];
    return `/api/reports/${path}?${params}`;
  };
  const currentUrl = buildReportUrl();
  const isStale = viewer.hasViewed && viewer.appliedKey !== currentUrl;
  const handleView = () => viewer.view(currentUrl, currentUrl);

  const viewed = viewer.hasViewed;
  const stockValuationData = viewer.data as any;
  const itemProfitabilityData = viewer.data as any;
  const lowStockData = viewer.data as any;
  const stockTakeVarianceHistoryData = viewer.data as any;
  const stockMovementLedgerData = viewer.data as any;
  const warehouseTransferReconciliationData = viewer.data as any;

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
              {/* ItemProfitability has no warehouse/branch granularity at all — averageCost
                  etc. are tracked per-product company-wide, not per-location — so this
                  filter is hidden there rather than shown but ineffective. */}
              {companyBranches.length > 0 && reportType !== 'ItemProfitability' && (
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Filter Branch')}</label>
                  <select value={selectedBranchId} onChange={e => { setSelectedBranchId(e.target.value); setSelectedWarehouseId('ALL'); }}
                    className="w-full bg-white border border-slate-200 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none">
                    <option value="ALL">{t('All Branches')}</option>
                    {companyBranches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
              )}
              {(reportType === 'StockValuation' || reportType === 'LowStock' || reportType === 'StockTakeVarianceHistory' || reportType === 'StockMovementLedger' || reportType === 'WarehouseTransferReconciliation') && (
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Filter Warehouse')}</label>
                  <select value={selectedWarehouseId} onChange={e => setSelectedWarehouseId(e.target.value)} className="w-full bg-white border border-slate-200 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none">
                    <option value="ALL">{t('All Warehouses')}</option>
                    {companyWarehouses.map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </div>
              )}
              {reportType === 'StockMovementLedger' && (
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Filter Product')}</label>
                  <select value={selectedProductId} onChange={e => setSelectedProductId(e.target.value)} className="w-full bg-white border border-slate-200 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none">
                    <option value="ALL">{t('All Products')}</option>
                    {companyProducts.filter((p: any) => p.itemKind === 'item').map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              )}
              {(reportType === 'StockTakeVarianceHistory' || reportType === 'StockMovementLedger' || reportType === 'WarehouseTransferReconciliation') && (
                <>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('From Date')}</label>
                    <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="w-full bg-white border border-slate-200 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('To Date')}</label>
                    <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="w-full bg-white border border-slate-200 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none" />
                  </div>
                </>
              )}
              {reportType === 'WarehouseTransferReconciliation' && (
                <div className="space-y-1 flex flex-col justify-end">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Pending Only')}</label>
                  <label className="flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 cursor-pointer">
                    <input type="checkbox" checked={pendingOnly} onChange={e => setPendingOnly(e.target.checked)} className="rounded border-slate-300 text-indigo-600" />
                    {t('Show only pending (not yet received) lines')}
                  </label>
                </div>
              )}
              <ViewReportButton onView={handleView} loading={viewer.loading} stale={isStale} t={t} />
            </div>
          </div>

          <div className="bg-white border border-slate-200/60 rounded-[28px] shadow-[0_8px_30px_rgb(0,0,0,0.04)] overflow-hidden p-6">
            {!viewed || !viewer.loaded ? (
              <ReportPlaceholder loading={viewer.loading} error={viewer.error} t={t} />
            ) : (
            <>
            <ReportStatusStrip loading={viewer.loading} error={viewer.error} t={t} />

            {reportType === 'StockValuation' && (() => {
              const data = stockValuationData;
              return (
                <div className="overflow-x-auto">
                  <p className="text-[10px] text-slate-400 mb-2">{t('On Hand is always shown in each product\'s base unit — a negative figure means more was sold/returned than has physically arrived yet.')}</p>
                  <table className="w-full text-xs text-start">
                    <thead><tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]"><th className="p-3 text-start">{t('Product')}</th><th className="p-3 text-start">{t('Warehouse')}</th><th className="p-3 text-end">{t('On Hand (Base)')}</th><th className="p-3 text-end">{t('Unit Cost')} ({currencySymbol})</th><th className="p-3 text-end">{t('Value')} ({currencySymbol})</th></tr></thead>
                    <tbody>{data.rows.map((r: any, i: number) => (<tr key={i} className="border-b border-slate-100 text-slate-700"><td className="p-3 font-semibold">{r.productName}</td><td className="p-3">{r.warehouseName}</td><td className={`p-3 text-end font-mono ${r.quantity < 0 ? 'text-rose-600 font-bold' : ''}`}>{r.quantity}</td><td className="p-3 text-end font-mono">{currencySymbol} {r.unitCost.toFixed(4)}</td><td className="p-3 text-end font-mono font-bold">{currencySymbol} {r.value.toFixed(2)}</td></tr>))}</tbody>
                    <tfoot><tr className="bg-slate-900 text-white font-bold text-xs"><td className="p-3.5" colSpan={4}>{t('Total Stock Value:')}</td><td className="p-3.5 text-end font-mono text-emerald-400">{currencySymbol} {data.totalValue.toFixed(2)}</td></tr></tfoot>
                  </table>
                </div>
              );
            })()}

            {reportType === 'ItemProfitability' && (() => {
              const data = itemProfitabilityData;
              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-start">
                    <thead><tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]"><th className="p-3 text-start">{t('Product')}</th><th className="p-3 text-end">{t('Qty Sold')}</th><th className="p-3 text-end">{t('Avg Cost')} ({currencySymbol})</th><th className="p-3 text-end">{t('Avg Sale Price')} ({currencySymbol})</th><th className="p-3 text-end">{t('Margin')} ({currencySymbol})</th><th className="p-3 text-end">{t('Margin %')}</th></tr></thead>
                    <tbody>{data.rows.map((r: any, i: number) => (
                      <tr key={i} className="border-b border-slate-100 text-slate-700">
                        <td className="p-3 font-semibold">{r.productName}</td><td className="p-3 text-end font-mono">{r.totalQuantitySold}</td>
                        <td className="p-3 text-end font-mono">{currencySymbol} {r.averageCost.toFixed(4)}</td><td className="p-3 text-end font-mono">{currencySymbol} {r.averageSalePrice.toFixed(4)}</td>
                        <td className={`p-3 text-end font-mono font-bold ${r.marginAmount >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{currencySymbol} {r.marginAmount.toFixed(2)}</td>
                        <td className={`p-3 text-end font-mono font-bold ${r.marginPct >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{r.marginPct.toFixed(1)}%</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              );
            })()}

            {reportType === 'LowStock' && (() => {
              const data = lowStockData;
              return data.rows.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-8">{t('Nothing is below its configured reorder level.')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-start">
                    <thead><tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]"><th className="p-3 text-start">{t('Product')}</th><th className="p-3 text-start">{t('Warehouse')}</th><th className="p-3 text-end">{t('On Hand (Base)')}</th><th className="p-3 text-end">{t('Min Level')}</th><th className="p-3 text-end">{t('Shortfall')}</th></tr></thead>
                    <tbody>{data.rows.map((r: any, i: number) => (<tr key={i} className="border-b border-slate-100 text-slate-700"><td className="p-3 font-semibold">{r.productName}</td><td className="p-3">{r.warehouseName}</td><td className="p-3 text-end font-mono">{r.onHand}</td><td className="p-3 text-end font-mono">{r.minLevel}</td><td className="p-3 text-end font-mono font-bold text-rose-600">{r.shortfall}</td></tr>))}</tbody>
                  </table>
                </div>
              );
            })()}

            {reportType === 'StockTakeVarianceHistory' && (() => {
              const data = stockTakeVarianceHistoryData;
              return data.rows.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-8">{t('No variances in completed stock takes for this period.')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-start">
                    <thead><tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]"><th className="p-3 text-start">{t('Stock Take #')}</th><th className="p-3 text-start">{t('Date')}</th><th className="p-3 text-start">{t('Warehouse')}</th><th className="p-3 text-start">{t('Product')}</th><th className="p-3 text-end">{t('System Qty (Base)')}</th><th className="p-3 text-end">{t('Counted Qty')}</th><th className="p-3 text-end">{t('Variance (Base)')}</th></tr></thead>
                    <tbody>{data.rows.map((r: any, i: number) => (
                      <tr key={i} className="border-b border-slate-100 text-slate-700">
                        <td className="p-3 font-semibold">{r.referenceNumber}</td><td className="p-3">{r.date}</td><td className="p-3">{r.warehouseName}</td><td className="p-3">{r.productName}</td>
                        <td className="p-3 text-end font-mono">{r.systemQuantity}</td><td className="p-3 text-end font-mono">{r.physicalQuantity}</td>
                        <td className={`p-3 text-end font-mono font-bold ${r.variance > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{r.variance > 0 ? '+' : ''}{r.variance}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              );
            })()}

            {reportType === 'StockMovementLedger' && (() => {
              const data = stockMovementLedgerData;
              return data.rows.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-8">{t('No stock movements in this period.')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <p className="text-[10px] text-slate-400 mb-2">{t('Every quantity below is in the product\'s base unit, regardless of what unit the original transaction was entered in.')}</p>
                  <table className="w-full text-xs text-start">
                    <thead><tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]"><th className="p-3 text-start">{t('Date')}</th><th className="p-3 text-start">{t('Product')}</th><th className="p-3 text-start">{t('Warehouse')}</th><th className="p-3 text-start">{t('Type')}</th><th className="p-3 text-start">{t('Reference #')}</th><th className="p-3 text-start">{t('Batch')}</th><th className="p-3 text-end">{t('Qty Change (Base)')}</th><th className="p-3 text-end">{t('Ending Qty (Base)')}</th></tr></thead>
                    <tbody>{data.rows.map((r: any, i: number) => {
                      // 'Sale' covers both directions — deductStockForSale (a real sale,
                      // always negative) and restockForSaleReversal (a Credit Note or
                      // cancelled invoice giving stock back, always positive) both log under
                      // the identical transactionType so the original deduction and its
                      // later reversal share one audit trail — see businessLogic.ts. Without
                      // this, a positive-quantityChange "Sale" row reads as though selling
                      // something added stock, which it never does. Reference # (the actual
                      // invoice/GRN/return/stock-take number, resolved server-side from the
                      // ledger's polymorphic referenceId) settles it beyond doubt — e.g.
                      // "INV-2" vs "CN-1001" makes clear which document this row came from,
                      // not just the direction of the change.
                      const typeLabel = r.transactionType === 'Sale' && r.quantityChange > 0
                        ? t('Sale Reversal (Credit Note / Cancellation)')
                        : t(TRANSACTION_TYPE_LABELS[r.transactionType] || r.transactionType);
                      return (
                      <tr key={i} className="border-b border-slate-100 text-slate-700">
                        <td className="p-3">{r.date.slice(0, 10)}</td><td className="p-3 font-semibold">{r.productName}</td><td className="p-3">{r.warehouseName}</td>
                        <td className="p-3">{typeLabel}</td><td className="p-3 font-mono">{r.referenceNumber || '-'}</td><td className="p-3">{r.batchNumber}</td>
                        <td className={`p-3 text-end font-mono font-bold ${r.quantityChange >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{r.quantityChange >= 0 ? '+' : ''}{r.quantityChange}</td>
                        <td className={`p-3 text-end font-mono ${r.endingQuantity < 0 ? 'text-rose-600 font-bold' : ''}`}>{r.endingQuantity}</td>
                      </tr>
                      );
                    })}</tbody>
                  </table>
                </div>
              );
            })()}

            {reportType === 'WarehouseTransferReconciliation' && (() => {
              const data = warehouseTransferReconciliationData;
              const statusClass = (status: string) => status === 'Matched' ? 'bg-emerald-50 text-emerald-700' :
                status === 'Pending' ? 'bg-amber-50 text-amber-700' :
                status === 'Cancelled' ? 'bg-gray-100 text-gray-500' :
                'bg-rose-50 text-rose-700';
              return data.rows.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-8">{t('No warehouse transfer lines in this period.')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-start">
                    <thead><tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]">
                      <th className="p-3 text-start">{t('Dispatch #')}</th><th className="p-3 text-start">{t('Date')}</th><th className="p-3 text-start">{t('From')}</th><th className="p-3 text-start">{t('To')}</th>
                      <th className="p-3 text-start">{t('Product')}</th><th className="p-3 text-start">{t('Batch')}</th><th className="p-3 text-end">{t('Qty Dispatched')}</th>
                      <th className="p-3 text-start">{t('Receiving #')}</th><th className="p-3 text-end">{t('Qty Received')}</th><th className="p-3 text-end">{t('Variance')}</th>
                      <th className="p-3 text-start">{t('Status')}</th>
                    </tr></thead>
                    <tbody>{data.rows.map((r: any, i: number) => (
                      <tr key={i} className="border-b border-slate-100 text-slate-700">
                        <td className="p-3 font-semibold font-mono">{r.dispatchNumber}</td><td className="p-3">{r.date}</td>
                        <td className="p-3">{r.fromWarehouseName}</td><td className="p-3">{r.toWarehouseName}</td>
                        <td className="p-3 font-semibold">{r.productName}</td><td className="p-3 font-mono">{r.batchNumber}</td>
                        <td className="p-3 text-end font-mono">{r.quantityDispatched}</td>
                        <td className="p-3 font-mono">{r.receivingNumber || '-'}</td>
                        <td className="p-3 text-end font-mono">{r.quantityReceived ?? '-'}</td>
                        <td className={`p-3 text-end font-mono font-bold ${r.variance == null ? 'text-slate-400' : r.variance === 0 ? 'text-emerald-600' : r.variance < 0 ? 'text-rose-600' : 'text-amber-600'}`}>
                          {r.variance == null ? '-' : (r.variance > 0 ? `+${r.variance}` : r.variance)}
                        </td>
                        <td className="p-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold ${statusClass(r.status)}`}>
                            {t(r.status)}{r.status === 'Pending' && r.daysInTransit != null ? ` (${r.daysInTransit} ${t('days')})` : ''}
                          </span>
                        </td>
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
