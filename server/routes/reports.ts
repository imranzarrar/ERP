import express from 'express';
import { hasPermission } from '../lib/authz.js';
import { withTenantDb, tenantDb } from '../lib/tenantDb.js';
import {
  computeDashboardSummary,
  computeTrialBalance,
  computeProfitLoss,
  computeBalanceSheet,
  computeSalesRegister,
  computeItemWiseSales,
  computeCustomerStatement,
  computeQuotationConversion,
  computeSalesByStaff,
  computePosShiftSummary,
  computePurchaseRegister,
  computeVendorStatement,
  computeInvoiceKpis,
  computeQuotationKpis,
  computeInvestorContributions,
  computeStockValuation,
  computeItemProfitability,
  computeLowStock,
  computeStockTakeVarianceHistory,
  computeStockMovementLedger,
  computeWarehouseTransferReconciliation,
  computeSalesVatRegister,
  computePurchaseVatRegister,
  computeVatReturnSummary,
  computeBankLedger,
  computeOutstanding,
  computeInvestorProfitShare,
  computeFiscalMonthClosingHistory,
} from '../lib/financialReports.js';

const router = express.Router();

// Every handler below derives company scope EXCLUSIVELY from req.targetCompanyId
// (resolved once, server.ts's isAuthenticated middleware, ultimately backed by the
// persisted session — see .claude/skills/session-company-scoping/SKILL.md) — never
// req.query.companyId/req.body.companyId. See
// .claude/skills/server-side-report-aggregation/SKILL.md for the full pattern this
// file follows; date range / basis / month id are the only query params that matter here.

// Shared by every handler below — same branch-restriction convention as
// server.ts's own branchOk / computeDashboardSummary's opts.branchIds.
function resolveBranchIds(req: any): string[] | null {
  const isAdmin = req.user?.role === 'admin' || req.user?.isSuperAdmin === true;
  const isBranchUnrestricted = isAdmin || hasPermission(req.user, 'branches.viewAllBranches');
  const allowed: string[] | null = isBranchUnrestricted ? null : (req.allowedBranchIds || []);
  // Optional `?branchId=` narrowing — the report screens' "Filter Branch" dropdown. It can
  // only ever NARROW what the caller is already allowed to see: an unrestricted user may
  // pick any branch, a restricted user only one of their own (anything else yields an empty
  // scope, never a wider one). Previously the dropdown was accepted client-side but never
  // sent, so choosing a branch silently changed nothing on these server-computed reports.
  const requested = typeof req.query?.branchId === 'string' && req.query.branchId && req.query.branchId !== 'ALL' ? req.query.branchId : null;
  if (!requested) return allowed;
  if (allowed === null) return [requested];
  return allowed.includes(requested) ? [requested] : [];
}

// Row-listing reports return every matching row from their compute function (totals are
// always computed over the FULL set), then this trims what is sent over the wire to one
// page — the browser never has to receive or render tens of thousands of rows at once.
// `all=true` (print/export) bypasses paging but is capped so one request can't try to
// serialise an unbounded result.
const MAX_EXPORT_ROWS = 50000;
const PAGE_SIZE_OPTIONS = { min: 10, max: 500, default: 100 };
function readPaging(req: any): { all: boolean; page: number; pageSize: number } {
  const all = req.query?.all === 'true';
  const page = Math.max(1, parseInt(String(req.query?.page ?? '1'), 10) || 1);
  const pageSize = Math.min(PAGE_SIZE_OPTIONS.max, Math.max(PAGE_SIZE_OPTIONS.min, parseInt(String(req.query?.pageSize ?? PAGE_SIZE_OPTIONS.default), 10) || PAGE_SIZE_OPTIONS.default));
  return { all, page, pageSize };
}
function sendReport(req: any, res: any, result: any) {
  const key = Array.isArray(result?.rows) ? 'rows' : Array.isArray(result?.entries) ? 'entries' : null;
  if (!key || result.pagination) return res.json(result);
  const { all, page, pageSize } = readPaging(req);
  const total = result[key].length;
  if (all) {
    if (total > MAX_EXPORT_ROWS) return res.status(413).json({ error: `This report has ${total} rows — too many to print at once. Narrow the filters (dates, customer, warehouse) and try again.` });
    return res.json(result);
  }
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  return res.json({
    ...result,
    [key]: result[key].slice((safePage - 1) * pageSize, safePage * pageSize),
    pagination: { page: safePage, pageSize, totalRows: total, totalPages },
  });
}

// --- Financial reports formerly computed in the browser (ReportViewer.tsx) ---
function financialRoute(path: string, permission: string, needsDates: boolean, run: (req: any, companyId: string, q: any) => Promise<any>) {
  router.get(path, withTenantDb, async (req: any, res) => {
    try {
      if (!hasPermission(req.user, permission)) return res.status(403).json({ error: 'Forbidden' });
      const companyId = req.targetCompanyId;
      if (!companyId) return res.status(400).json({ error: 'No company selected.' });
      const q = req.query;
      if (needsDates && (!q.startDate || !q.endDate)) return res.status(400).json({ error: 'startDate and endDate are required.' });
      sendReport(req, res, await run(req, companyId, q));
    } catch (error: any) {
      res.status(error.status || 500).json({ error: error.message });
    }
  });
}
const str = (v: any, d = 'ALL') => (typeof v === 'string' && v ? v : d);
financialRoute('/reports/sales-vat', 'reports.salesVat', true, (req, c, q) => computeSalesVatRegister(tenantDb(), c, String(q.startDate), String(q.endDate), str(q.customerId), { branchIds: resolveBranchIds(req) }));
financialRoute('/reports/purchase-vat', 'reports.purchaseVat', true, (req, c, q) => computePurchaseVatRegister(tenantDb(), c, String(q.startDate), String(q.endDate), str(q.vendorId), { branchIds: resolveBranchIds(req) }));
financialRoute('/reports/vat-return-summary', 'reports.vatReturnSummary', true, (req, c, q) => computeVatReturnSummary(tenantDb(), c, String(q.startDate), String(q.endDate), { branchIds: resolveBranchIds(req) }));
financialRoute('/reports/bank-ledger', 'reports.bankLedger', true, (req, c, q) => computeBankLedger(tenantDb(), c, str(q.bankId), String(q.startDate), String(q.endDate), { branchIds: resolveBranchIds(req) }));
financialRoute('/reports/outstanding', 'reports.outstanding', false, (req, c, q) => computeOutstanding(tenantDb(), c, q.startDate ? String(q.startDate) : null, q.endDate ? String(q.endDate) : null, str(q.customerId), str(q.vendorId), { branchIds: resolveBranchIds(req) }));
financialRoute('/reports/investor-profit-share', 'reports.investorProfitShare', true, (req, c, q) => computeInvestorProfitShare(tenantDb(), c, String(q.startDate), String(q.endDate)));
financialRoute('/reports/fiscal-month-closing-history', 'reports.fiscalMonthClosingHistory', false, (req, c) => computeFiscalMonthClosingHistory(tenantDb(), c));

router.get('/reports/dashboard-summary', withTenantDb, async (req: any, res) => {
  try {
    // Ungated — Dashboard has no permission leaf of its own today (permissionSchema.ts
    // has no 'dashboard' module), matching that existing, deliberate access model.
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required.' });

    const isAdmin = req.user?.role === 'admin' || req.user?.isSuperAdmin === true;
    const branchIds = resolveBranchIds(req);
    // A non-admin without a broad invoice/expense permission only sees their own created
    // documents in these totals — same restriction Dashboard.tsx's own monthInvoices/
    // monthExpenses filters already apply client-side.
    const hasBroadInvoiceAccess = isAdmin || !!req.user?.permissions?.invoice;
    const hasBroadExpenseAccess = isAdmin || !!req.user?.permissions?.expense;
    const restrictToUserId = (hasBroadInvoiceAccess && hasBroadExpenseAccess) ? null : req.user?.id;

    const trailingMonthIdsRaw = req.query.trailingMonthIds;
    const trailingMonthIds = typeof trailingMonthIdsRaw === 'string' && trailingMonthIdsRaw.length > 0
      ? trailingMonthIdsRaw.split(',').filter(Boolean)
      : [];
    const summary = await computeDashboardSummary(tenantDb(), companyId, String(startDate), String(endDate), { branchIds, restrictToUserId, trailingMonthIds });
    res.json(summary);
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/trial-balance', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.trialBalance')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required.' });
    res.json(await computeTrialBalance(tenantDb(), companyId, String(startDate), String(endDate)));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/profit-loss', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.profitLoss')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { startDate, endDate, basis } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required.' });
    const resolvedBasis = basis === 'Cash' ? 'Cash' : 'Accrual';
    res.json(await computeProfitLoss(tenantDb(), companyId, String(startDate), String(endDate), resolvedBasis));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/balance-sheet', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.balanceSheet')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { asOfDate } = req.query;
    if (!asOfDate) return res.status(400).json({ error: 'asOfDate is required.' });
    res.json(await computeBalanceSheet(tenantDb(), companyId, String(asOfDate)));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/sales-register', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.salesRegister')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { startDate, endDate, customerId } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required.' });
    sendReport(req, res, await computeSalesRegister(tenantDb(), companyId, String(startDate), String(endDate), (customerId ? String(customerId) : 'ALL') as any, { branchIds: resolveBranchIds(req) }));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/item-wise-sales', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.itemWiseSales')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required.' });
    sendReport(req, res, await computeItemWiseSales(tenantDb(), companyId, String(startDate), String(endDate), { branchIds: resolveBranchIds(req) }));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/customer-statement', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.customerStatement')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { customerId } = req.query;
    if (!customerId) return res.status(400).json({ error: 'customerId is required.' });
    sendReport(req, res, await computeCustomerStatement(tenantDb(), companyId, String(customerId), { branchIds: resolveBranchIds(req) }));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/quotation-conversion', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.quotationConversion')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { startDate, endDate, customerId } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required.' });
    sendReport(req, res, await computeQuotationConversion(tenantDb(), companyId, String(startDate), String(endDate), (customerId ? String(customerId) : 'ALL') as any, { branchIds: resolveBranchIds(req) }));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/sales-by-staff', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.salesByStaff')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required.' });
    sendReport(req, res, await computeSalesByStaff(tenantDb(), companyId, String(startDate), String(endDate), { branchIds: resolveBranchIds(req) }));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/pos-shift-summary', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.posShiftSummary')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required.' });
    sendReport(req, res, await computePosShiftSummary(tenantDb(), companyId, String(startDate), String(endDate), { branchIds: resolveBranchIds(req) }));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/purchase-register', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.purchaseRegister')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { startDate, endDate, vendorId } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required.' });
    sendReport(req, res, await computePurchaseRegister(tenantDb(), companyId, String(startDate), String(endDate), (vendorId ? String(vendorId) : 'ALL') as any, { branchIds: resolveBranchIds(req) }));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/vendor-statement', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.vendorStatement')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { vendorId } = req.query;
    if (!vendorId) return res.status(400).json({ error: 'vendorId is required.' });
    sendReport(req, res, await computeVendorStatement(tenantDb(), companyId, String(vendorId), { branchIds: resolveBranchIds(req) }));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/stock-valuation', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.stockValuation')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { warehouseId } = req.query;
    sendReport(req, res, await computeStockValuation(tenantDb(), companyId, (warehouseId ? String(warehouseId) : 'ALL') as any, { branchIds: resolveBranchIds(req) }));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/item-profitability', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.itemProfitability')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    sendReport(req, res, await computeItemProfitability(tenantDb(), companyId));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/low-stock', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.lowStock')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { warehouseId } = req.query;
    sendReport(req, res, await computeLowStock(tenantDb(), companyId, (warehouseId ? String(warehouseId) : 'ALL') as any, { branchIds: resolveBranchIds(req) }));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/stock-take-variance-history', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.stockTakeVarianceHistory')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { startDate, endDate, warehouseId } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required.' });
    sendReport(req, res, await computeStockTakeVarianceHistory(tenantDb(), companyId, String(startDate), String(endDate), (warehouseId ? String(warehouseId) : 'ALL') as any, { branchIds: resolveBranchIds(req) }));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/stock-movement-ledger', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.stockMovementLedger')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { startDate, endDate, warehouseId, productId } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required.' });
    const paging = readPaging(req);
    res.json(await computeStockMovementLedger(tenantDb(), companyId, String(startDate), String(endDate), (warehouseId ? String(warehouseId) : 'ALL') as any, (productId ? String(productId) : 'ALL') as any, { branchIds: resolveBranchIds(req) }, paging.all ? undefined : { page: paging.page, pageSize: paging.pageSize }, MAX_EXPORT_ROWS));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/warehouse-transfer-reconciliation', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.warehouseTransferReconciliation')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { startDate, endDate, warehouseId, pendingOnly } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required.' });
    sendReport(req, res, await computeWarehouseTransferReconciliation(tenantDb(), companyId, String(startDate), String(endDate), (warehouseId ? String(warehouseId) : 'ALL') as any, pendingOnly === 'true', { branchIds: resolveBranchIds(req) }));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/invoice-kpis', withTenantDb, async (req: any, res) => {
  try {
    // Not gated by invoice.read — the Invoice list itself isn't either: a user without it
    // still sees their OWN invoices there (InvoiceModule.tsx's filteredInvoices), so the
    // KPI cards over that same list must stay visible too, just restricted the same way.
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { startDate, endDate, status, zatcaStatus, docType, origin } = req.query;
    const restrictToUserId = hasPermission(req.user, 'invoice.read') ? null : req.user?.id;
    res.json(await computeInvoiceKpis(tenantDb(), companyId, {
      startDate: startDate ? String(startDate) : undefined,
      endDate: endDate ? String(endDate) : undefined,
      status: status === 'Unpaid' ? 'Unpaid' : 'All',
      zatcaStatus: zatcaStatus ? String(zatcaStatus) : 'All',
      docType: (docType ? String(docType) : 'All') as any,
      origin: (origin ? String(origin) : 'All') as any,
      restrictToUserId,
    }, { branchIds: resolveBranchIds(req) }));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/quotation-kpis', withTenantDb, async (req: any, res) => {
  try {
    // Same reasoning as invoice-kpis above — not gated by quotation.read.
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const restrictToUserId = hasPermission(req.user, 'quotation.read') ? null : req.user?.id;
    res.json(await computeQuotationKpis(tenantDb(), companyId, { branchIds: resolveBranchIds(req), restrictToUserId }));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/investor-contributions', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'investors.access')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    res.json(await computeInvestorContributions(tenantDb(), companyId));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

export default router;
