import React from 'react';
import { useTranslation, usePermissions } from '../hooks';
import { DatabaseState } from '../dbStore';
import { Printer, Filter } from 'lucide-react';

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

  const [startDate, setStartDate] = React.useState('2026-06-01');
  const [endDate, setEndDate] = React.useState('2026-06-30');
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
  const companyPOs = (db.purchaseOrders || []).filter((po: any) => po.companyId === companyId && branchMatches(po.branchId));
  const companyGRNs = (db.goodsReceiptNotes || []).filter((g: any) => g.companyId === companyId && branchMatchesViaWarehouse(g.warehouseId));

  // 1. Purchase Register — every expense in the period.
  const getPurchaseRegisterData = () => {
    const rows = companyExpenses
      .filter(e => e.date >= startDate && e.date <= endDate && (selectedVendorId === 'ALL' || e.vendorId === selectedVendorId))
      .map(e => {
        const vend = db.vendors.find(v => v.id === e.vendorId);
        return { expenseNumber: e.expenseNumber, date: e.date, vendorName: vend?.name || t('Cash Vendor'), classification: e.classification || e.type, paymentStatus: e.paymentStatus, amount: e.amount };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
    return { rows, totalAmount: rows.reduce((s, r) => s + r.amount, 0) };
  };

  // 2. Vendor Statement — combines both purchasing paths this app has: simple Expenses
  // AND the full PR->PO->GRN->Purchase Bill flow's own bills, since a vendor's real
  // obligation spans both. Payment vouchers reference either 'Expense' or 'PurchaseBill'.
  const getVendorStatementData = () => {
    if (!statementVendorId) return { entries: [], endingBalance: 0, vendorName: '' };
    const vendor = db.vendors.find(v => v.id === statementVendorId);
    const vendExpenses = companyExpenses.filter(e => e.vendorId === statementVendorId && e.status === 'Active');
    const vendBills = (db.purchaseBills || []).filter((b: any) => b.companyId === companyId && branchMatches(b.branchId) && b.vendorId === statementVendorId && b.status !== 'Cancelled');
    const expenseIds = new Set(vendExpenses.map(e => e.id));
    const billIds = new Set(vendBills.map((b: any) => b.id));
    const payments = db.vouchers.filter(v => v.companyId === companyId && branchMatches((v as any).branchId) && v.type === 'Payment'
      && ((v.referenceType === 'Expense' && expenseIds.has(v.referenceId)) || (v.referenceType === 'PurchaseBill' && billIds.has(v.referenceId))));

    const entries: { date: string; type: string; docNumber: string; debit: number; credit: number }[] = [];
    vendExpenses.forEach(e => entries.push({ date: e.date, type: 'Expense', docNumber: e.expenseNumber, debit: e.amount, credit: 0 }));
    vendBills.forEach((b: any) => entries.push({ date: String(b.date).slice(0, 10), type: 'Purchase Bill', docNumber: b.billNumber, debit: Number(b.grandTotal), credit: 0 }));
    payments.forEach(v => entries.push({ date: v.date, type: 'Payment', docNumber: v.voucherNumber, debit: 0, credit: v.amount }));
    entries.sort((a, b) => a.date.localeCompare(b.date));

    let running = 0;
    const withBalance = entries.map(e => { running += e.debit - e.credit; return { ...e, runningBalance: running }; });
    return { entries: withBalance, endingBalance: running, vendorName: vendor?.name || '' };
  };

  // 3. PO Status — every PO by fulfillment status, with aging for what's still open.
  const getPoStatusData = () => {
    const rows = companyPOs
      .filter((po: any) => po.date >= startDate && po.date <= endDate && (selectedVendorId === 'ALL' || po.vendorId === selectedVendorId))
      .map((po: any) => {
        const vend = db.vendors.find(v => v.id === po.vendorId);
        const isOpen = po.status === 'Sent' || po.status === 'Partially Received';
        return { poNumber: po.poNumber, date: po.date, vendorName: vend?.name || '', status: po.status, totalAmount: Number(po.totalAmount), ageDays: isOpen ? daysBetween(TODAY, po.date) : null };
      })
      .sort((a: any, b: any) => a.date.localeCompare(b.date));
    return { rows, totalAmount: rows.reduce((s: number, r: any) => s + r.totalAmount, 0) };
  };

  // 4. GRN vs. PO Variance — ordered vs. actually received quantity per PO line, summed
  // across every (non-reversed) GRN raised against that PO.
  const getGrnPoVarianceData = () => {
    const pos = companyPOs.filter((po: any) => po.date >= startDate && po.date <= endDate && (selectedVendorId === 'ALL' || po.vendorId === selectedVendorId));
    const rows: any[] = [];
    pos.forEach((po: any) => {
      const vend = db.vendors.find(v => v.id === po.vendorId);
      const relatedGrns = companyGRNs.filter((g: any) => g.purchaseOrderId === po.id && !g.isReversed);
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

  const handlePrint = () => {
    if (!can(REPORT_PERMISSION_KEYS[reportType])) return;
    let reportData: any = {};
    if (reportType === 'PurchaseRegister') reportData = getPurchaseRegisterData();
    else if (reportType === 'VendorStatement') reportData = getVendorStatementData();
    else if (reportType === 'PoStatus') reportData = getPoStatusData();
    else if (reportType === 'GrnPoVariance') reportData = getGrnPoVarianceData();
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
            </div>
          </div>

          <div className="bg-white border border-slate-200/60 rounded-[28px] shadow-[0_8px_30px_rgb(0,0,0,0.04)] overflow-hidden p-6">

            {reportType === 'PurchaseRegister' && (() => {
              const data = getPurchaseRegisterData();
              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-start">
                    <thead><tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]"><th className="p-3">{t('Expense #')}</th><th className="p-3">{t('Date')}</th><th className="p-3">{t('Vendor')}</th><th className="p-3">{t('Classification')}</th><th className="p-3">{t('Payment')}</th><th className="p-3 text-end">{t('Amount')} ({currencySymbol})</th></tr></thead>
                    <tbody>{data.rows.map((r, i) => (<tr key={i} className="border-b border-slate-100 text-slate-700"><td className="p-3 font-semibold">{r.expenseNumber}</td><td className="p-3">{r.date}</td><td className="p-3">{r.vendorName}</td><td className="p-3">{t(r.classification || '')}</td><td className="p-3">{t(r.paymentStatus)}</td><td className="p-3 text-end font-mono font-bold">{currencySymbol} {r.amount.toFixed(2)}</td></tr>))}</tbody>
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
                      <thead><tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]"><th className="p-3">{t('Date')}</th><th className="p-3">{t('Type')}</th><th className="p-3">{t('Document #')}</th><th className="p-3 text-end">{t('Billed')} ({currencySymbol})</th><th className="p-3 text-end">{t('Paid')} ({currencySymbol})</th><th className="p-3 text-end">{t('Balance')} ({currencySymbol})</th></tr></thead>
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
                    <thead><tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]"><th className="p-3">{t('PO #')}</th><th className="p-3">{t('Date')}</th><th className="p-3">{t('Vendor')}</th><th className="p-3">{t('Status')}</th><th className="p-3 text-end">{t('Age (days)')}</th><th className="p-3 text-end">{t('Total')} ({currencySymbol})</th></tr></thead>
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
                    <thead><tr className="bg-slate-50 border-b border-slate-200 font-bold text-slate-600 uppercase text-[10px]"><th className="p-3">{t('PO #')}</th><th className="p-3">{t('Vendor')}</th><th className="p-3">{t('Product')}</th><th className="p-3 text-end">{t('Ordered')}</th><th className="p-3 text-end">{t('Received')}</th><th className="p-3 text-end">{t('Variance')}</th></tr></thead>
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

          </div>
        </>
      )}
    </div>
  );
}
