import React from 'react';
import { useTranslation, usePermissions } from '../hooks';
import { DatabaseState } from '../dbStore';
import { getMonthToDateRange } from '../dateUtils';
import { Printer, Filter } from 'lucide-react';

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
  // Everything in this module is warehouse-scoped, not directly branch-scoped, so
  // filtering companyWarehouses once here is enough — every downstream lookup already
  // goes through a warehouseId membership check against this same (now narrowed) list.
  const isBranchUnrestricted = db.currentUser?.isSuperAdmin === true || db.currentUser?.role === 'admin' || can('branches.viewAllBranches');
  const myBranchIds = new Set((db.userBranches || []).filter(ub => ub.userId === db.currentUser?.id).map(ub => ub.branchId));
  const companyBranches = (db.branches || []).filter(b => b.companyId === companyId && b.isActive !== false && (isBranchUnrestricted || myBranchIds.has(b.id)));
  const [selectedBranchId, setSelectedBranchId] = React.useState('ALL');
  const branchMatches = (branchId: string | null | undefined) => selectedBranchId === 'ALL' || branchId == null || branchId === selectedBranchId;

  const companyWarehouses = (db.warehouses || []).filter((w: any) => w.companyId === companyId && branchMatches(w.branchId));
  const companyWarehouseIds = new Set(companyWarehouses.map((w: any) => w.id));
  const companyProducts = (db.products || []).filter((p: any) => p.companyId === companyId);
  const companyStocks = (db.inventoryStocks || []).filter((s: any) => s.companyId === companyId && companyWarehouseIds.has(s.warehouseId)
    && (selectedWarehouseId === 'ALL' || s.warehouseId === selectedWarehouseId));

  // 1. Stock Valuation — on-hand quantity valued at each product's average cost,
  // aggregated per product per warehouse (averageCost is company-wide per product, not
  // per-warehouse — this app doesn't track cost separately by location).
  const getStockValuationData = () => {
    const rows = companyStocks
      .filter((s: any) => Number(s.quantity) > 0)
      .map((s: any) => {
        const product = companyProducts.find((p: any) => p.id === s.productId);
        const warehouse = companyWarehouses.find((w: any) => w.id === s.warehouseId);
        const cost = product ? Number(product.averageCost || 0) : 0;
        return { productName: product?.name || '', warehouseName: warehouse?.name || '', quantity: Number(s.quantity), unitCost: cost, value: Number(s.quantity) * cost };
      })
      .sort((a: any, b: any) => b.value - a.value);
    return { rows, totalValue: rows.reduce((sum: number, r: any) => sum + r.value, 0) };
  };

  // 2. Item Profitability — average sale price vs. average cost margin per product.
  // Only products that have actually sold at least once are meaningful here (a product
  // with totalQuantitySold === 0 has no real averageSalePrice to compare against yet).
  const getItemProfitabilityData = () => {
    const rows = companyProducts
      .filter((p: any) => Number(p.totalQuantitySold || 0) > 0)
      .map((p: any) => {
        const avgCost = Number(p.averageCost || 0);
        const avgSale = Number(p.averageSalePrice || 0);
        const marginAmount = avgSale - avgCost;
        const marginPct = avgSale > 0 ? (marginAmount / avgSale) * 100 : 0;
        return { productName: p.name, averageCost: avgCost, averageSalePrice: avgSale, marginAmount, marginPct, totalQuantitySold: Number(p.totalQuantitySold || 0) };
      })
      .sort((a: any, b: any) => b.marginAmount - a.marginAmount);
    return { rows };
  };

  // 3. Low Stock — on-hand quantity below the configured reorder minimum, per warehouse.
  const getLowStockData = () => {
    const links = (db.productWarehouses || []).filter((pw: any) => pw.companyId === companyId && companyWarehouseIds.has(pw.warehouseId)
      && (selectedWarehouseId === 'ALL' || pw.warehouseId === selectedWarehouseId) && Number(pw.minLevel || 0) > 0);
    const rows = links
      .map((pw: any) => {
        const stock = companyStocks.find((s: any) => s.productId === pw.productId && s.warehouseId === pw.warehouseId);
        const onHand = stock ? Number(stock.quantity) : 0;
        const product = companyProducts.find((p: any) => p.id === pw.productId);
        const warehouse = companyWarehouses.find((w: any) => w.id === pw.warehouseId);
        return { productName: product?.name || '', warehouseName: warehouse?.name || '', onHand, minLevel: Number(pw.minLevel), shortfall: Number(pw.minLevel) - onHand };
      })
      .filter((r: any) => r.shortfall > 0)
      .sort((a: any, b: any) => b.shortfall - a.shortfall);
    return { rows };
  };

  // 4. Stock Take Variance History — over/under counts from every completed physical
  // stock take in the period, not just the one live in-progress view Inventory shows.
  const getStockTakeVarianceHistoryData = () => {
    const takes = (db.physicalStockTakes || []).filter((st: any) => st.companyId === companyId && companyWarehouseIds.has(st.warehouseId) && st.status === 'Completed'
      && st.date >= startDate && st.date <= endDate && (selectedWarehouseId === 'ALL' || st.warehouseId === selectedWarehouseId));
    const rows: any[] = [];
    takes.forEach((st: any) => {
      const warehouse = companyWarehouses.find((w: any) => w.id === st.warehouseId);
      (st.items || []).forEach((item: any) => {
        if (Number(item.variance) === 0) return;
        const product = companyProducts.find((p: any) => p.id === item.productId);
        rows.push({ referenceNumber: st.referenceNumber, date: st.date, warehouseName: warehouse?.name || '', productName: product?.name || '', systemQuantity: Number(item.systemQuantity), physicalQuantity: Number(item.physicalQuantity), variance: Number(item.variance) });
      });
    });
    return { rows: rows.sort((a, b) => a.date.localeCompare(b.date)) };
  };

  // 5. Stock Movement Ledger — every posted in/out movement across GRN/Return/Sale/
  // Adjustment/StockTake for a product, in chronological order, with a running ending
  // quantity — the actual audit trail behind the on-hand figures the other three reports
  // summarize. Reads stockLedgerTransactions directly rather than deriving it, since each
  // row is already the authoritative record of what happened and when.
  const getStockMovementLedgerData = () => {
    const rows = (db.stockLedgerTransactions || [])
      .filter((slt: any) => slt.companyId === companyId && companyWarehouseIds.has(slt.warehouseId)
        && slt.date.slice(0, 10) >= startDate && slt.date.slice(0, 10) <= endDate
        && (selectedWarehouseId === 'ALL' || slt.warehouseId === selectedWarehouseId)
        && (selectedProductId === 'ALL' || slt.productId === selectedProductId))
      .map((slt: any) => {
        const product = companyProducts.find((p: any) => p.id === slt.productId);
        const warehouse = companyWarehouses.find((w: any) => w.id === slt.warehouseId);
        return {
          date: slt.date, productName: product?.name || '', warehouseName: warehouse?.name || '',
          transactionType: slt.transactionType, quantityChange: Number(slt.quantityChange),
          endingQuantity: Number(slt.endingQuantity), batchNumber: slt.batchNumber || '',
        };
      })
      .sort((a: any, b: any) => a.date.localeCompare(b.date));
    return { rows };
  };

  const [pendingOnly, setPendingOnly] = React.useState(false);

  // 6. Warehouse Transfer Reconciliation — one row per dispatched line, paired with its
  // receiving line (if any) via dispatchItemId. Reads the dispatches/receivings directly
  // rather than the stock ledger, since the ledger's signed deltas alone can't reconstruct
  // which dispatched line corresponds to which received line.
  const getWarehouseTransferReconciliationData = () => {
    const dispatches = (db.warehouseDispatches || []).filter((d: any) => d.companyId === companyId
      && d.date.slice(0, 10) >= startDate && d.date.slice(0, 10) <= endDate
      && (selectedWarehouseId === 'ALL' || d.fromWarehouseId === selectedWarehouseId || d.toWarehouseId === selectedWarehouseId)
      && (companyWarehouseIds.has(d.fromWarehouseId) || companyWarehouseIds.has(d.toWarehouseId)));
    const rows: any[] = [];
    dispatches.forEach((d: any) => {
      const fromWh = (db.warehouses || []).find((w: any) => w.id === d.fromWarehouseId);
      const toWh = (db.warehouses || []).find((w: any) => w.id === d.toWarehouseId);
      const receiving = (db.warehouseReceivings || []).find((r: any) => r.dispatchId === d.id);
      (d.items || []).forEach((item: any) => {
        const product = companyProducts.find((p: any) => p.id === item.productId);
        const receivingItem = receiving ? (receiving.items || []).find((ri: any) => ri.dispatchItemId === item.id) : undefined;
        const qtyDispatched = Number(item.quantityDispatched);
        const qtyReceived = receivingItem ? Number(receivingItem.quantityReceived) : null;
        const variance = qtyReceived !== null ? qtyReceived - qtyDispatched : null;
        let status: 'Pending' | 'Matched' | 'Short' | 'Over' | 'Cancelled';
        if (d.status === 'Cancelled') status = 'Cancelled';
        else if (qtyReceived === null) status = 'Pending';
        else if (variance === 0) status = 'Matched';
        else if ((variance as number) < 0) status = 'Short';
        else status = 'Over';
        if (pendingOnly && status !== 'Pending') return;
        const daysInTransit = status === 'Pending' ? Math.floor((Date.now() - new Date(d.date).getTime()) / (1000 * 60 * 60 * 24)) : null;
        rows.push({
          dispatchNumber: d.dispatchNumber, date: d.date.slice(0, 10), fromWarehouseName: fromWh?.name || '', toWarehouseName: toWh?.name || '',
          productName: product?.name || '', batchNumber: item.batchNumber || '', quantityDispatched: qtyDispatched,
          receivingNumber: receiving?.receivingNumber || '', quantityReceived: qtyReceived, variance, status, daysInTransit,
        });
      });
    });
    return { rows: rows.sort((a, b) => a.date.localeCompare(b.date)) };
  };

  const handlePrint = () => {
    if (!can(REPORT_PERMISSION_KEYS[reportType])) return;
    let reportData: any = {};
    if (reportType === 'StockValuation') reportData = getStockValuationData();
    else if (reportType === 'ItemProfitability') reportData = getItemProfitabilityData();
    else if (reportType === 'LowStock') reportData = getLowStockData();
    else if (reportType === 'StockTakeVarianceHistory') reportData = getStockTakeVarianceHistoryData();
    else if (reportType === 'StockMovementLedger') reportData = getStockMovementLedgerData();
    else if (reportType === 'WarehouseTransferReconciliation') reportData = getWarehouseTransferReconciliationData();
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
            </div>
          </div>

          <div className="bg-white border border-slate-200/60 rounded-[28px] shadow-[0_8px_30px_rgb(0,0,0,0.04)] overflow-hidden p-6">

            {reportType === 'StockValuation' && (() => {
              const data = getStockValuationData();
              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-start">
                    <thead><tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]"><th className="p-3">{t('Product')}</th><th className="p-3">{t('Warehouse')}</th><th className="p-3 text-end">{t('On Hand')}</th><th className="p-3 text-end">{t('Unit Cost')} ({currencySymbol})</th><th className="p-3 text-end">{t('Value')} ({currencySymbol})</th></tr></thead>
                    <tbody>{data.rows.map((r: any, i: number) => (<tr key={i} className="border-b border-slate-100 text-slate-700"><td className="p-3 font-semibold">{r.productName}</td><td className="p-3">{r.warehouseName}</td><td className="p-3 text-end font-mono">{r.quantity}</td><td className="p-3 text-end font-mono">{currencySymbol} {r.unitCost.toFixed(4)}</td><td className="p-3 text-end font-mono font-bold">{currencySymbol} {r.value.toFixed(2)}</td></tr>))}</tbody>
                    <tfoot><tr className="bg-slate-900 text-white font-bold text-xs"><td className="p-3.5" colSpan={4}>{t('Total Stock Value:')}</td><td className="p-3.5 text-end font-mono text-emerald-400">{currencySymbol} {data.totalValue.toFixed(2)}</td></tr></tfoot>
                  </table>
                </div>
              );
            })()}

            {reportType === 'ItemProfitability' && (() => {
              const data = getItemProfitabilityData();
              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-start">
                    <thead><tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]"><th className="p-3">{t('Product')}</th><th className="p-3 text-end">{t('Qty Sold')}</th><th className="p-3 text-end">{t('Avg Cost')} ({currencySymbol})</th><th className="p-3 text-end">{t('Avg Sale Price')} ({currencySymbol})</th><th className="p-3 text-end">{t('Margin')} ({currencySymbol})</th><th className="p-3 text-end">{t('Margin %')}</th></tr></thead>
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
              const data = getLowStockData();
              return data.rows.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-8">{t('Nothing is below its configured reorder level.')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-start">
                    <thead><tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]"><th className="p-3">{t('Product')}</th><th className="p-3">{t('Warehouse')}</th><th className="p-3 text-end">{t('On Hand')}</th><th className="p-3 text-end">{t('Min Level')}</th><th className="p-3 text-end">{t('Shortfall')}</th></tr></thead>
                    <tbody>{data.rows.map((r: any, i: number) => (<tr key={i} className="border-b border-slate-100 text-slate-700"><td className="p-3 font-semibold">{r.productName}</td><td className="p-3">{r.warehouseName}</td><td className="p-3 text-end font-mono">{r.onHand}</td><td className="p-3 text-end font-mono">{r.minLevel}</td><td className="p-3 text-end font-mono font-bold text-rose-600">{r.shortfall}</td></tr>))}</tbody>
                  </table>
                </div>
              );
            })()}

            {reportType === 'StockTakeVarianceHistory' && (() => {
              const data = getStockTakeVarianceHistoryData();
              return data.rows.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-8">{t('No variances in completed stock takes for this period.')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-start">
                    <thead><tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]"><th className="p-3">{t('Stock Take #')}</th><th className="p-3">{t('Date')}</th><th className="p-3">{t('Warehouse')}</th><th className="p-3">{t('Product')}</th><th className="p-3 text-end">{t('System Qty')}</th><th className="p-3 text-end">{t('Counted Qty')}</th><th className="p-3 text-end">{t('Variance')}</th></tr></thead>
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
              const data = getStockMovementLedgerData();
              return data.rows.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-8">{t('No stock movements in this period.')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-start">
                    <thead><tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]"><th className="p-3">{t('Date')}</th><th className="p-3">{t('Product')}</th><th className="p-3">{t('Warehouse')}</th><th className="p-3">{t('Type')}</th><th className="p-3">{t('Batch')}</th><th className="p-3 text-end">{t('Qty Change')}</th><th className="p-3 text-end">{t('Ending Qty')}</th></tr></thead>
                    <tbody>{data.rows.map((r: any, i: number) => (
                      <tr key={i} className="border-b border-slate-100 text-slate-700">
                        <td className="p-3">{r.date.slice(0, 10)}</td><td className="p-3 font-semibold">{r.productName}</td><td className="p-3">{r.warehouseName}</td>
                        <td className="p-3">{t(TRANSACTION_TYPE_LABELS[r.transactionType] || r.transactionType)}</td><td className="p-3">{r.batchNumber}</td>
                        <td className={`p-3 text-end font-mono font-bold ${r.quantityChange >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{r.quantityChange >= 0 ? '+' : ''}{r.quantityChange}</td>
                        <td className="p-3 text-end font-mono">{r.endingQuantity}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              );
            })()}

            {reportType === 'WarehouseTransferReconciliation' && (() => {
              const data = getWarehouseTransferReconciliationData();
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
                      <th className="p-3">{t('Dispatch #')}</th><th className="p-3">{t('Date')}</th><th className="p-3">{t('From')}</th><th className="p-3">{t('To')}</th>
                      <th className="p-3">{t('Product')}</th><th className="p-3">{t('Batch')}</th><th className="p-3 text-end">{t('Qty Dispatched')}</th>
                      <th className="p-3">{t('Receiving #')}</th><th className="p-3 text-end">{t('Qty Received')}</th><th className="p-3 text-end">{t('Variance')}</th>
                      <th className="p-3">{t('Status')}</th>
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

          </div>
        </>
      )}
    </div>
  );
}
