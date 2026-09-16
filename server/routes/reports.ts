import express from 'express';
import { hasPermission } from '../lib/authz.js';
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
  return isBranchUnrestricted ? null : (req.allowedBranchIds || []);
}

router.get('/reports/dashboard-summary', async (req: any, res) => {
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
    const summary = await computeDashboardSummary(companyId, String(startDate), String(endDate), { branchIds, restrictToUserId, trailingMonthIds });
    res.json(summary);
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/trial-balance', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.trialBalance')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required.' });
    res.json(await computeTrialBalance(companyId, String(startDate), String(endDate)));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/profit-loss', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.profitLoss')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { startDate, endDate, basis } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required.' });
    const resolvedBasis = basis === 'Cash' ? 'Cash' : 'Accrual';
    res.json(await computeProfitLoss(companyId, String(startDate), String(endDate), resolvedBasis));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/balance-sheet', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.balanceSheet')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { asOfDate } = req.query;
    if (!asOfDate) return res.status(400).json({ error: 'asOfDate is required.' });
    res.json(await computeBalanceSheet(companyId, String(asOfDate)));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/sales-register', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.salesRegister')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { startDate, endDate, customerId } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required.' });
    res.json(await computeSalesRegister(companyId, String(startDate), String(endDate), (customerId ? String(customerId) : 'ALL') as any, { branchIds: resolveBranchIds(req) }));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/item-wise-sales', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.itemWiseSales')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required.' });
    res.json(await computeItemWiseSales(companyId, String(startDate), String(endDate), { branchIds: resolveBranchIds(req) }));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/customer-statement', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.customerStatement')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { customerId } = req.query;
    if (!customerId) return res.status(400).json({ error: 'customerId is required.' });
    res.json(await computeCustomerStatement(companyId, String(customerId), { branchIds: resolveBranchIds(req) }));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/quotation-conversion', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.quotationConversion')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { startDate, endDate, customerId } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required.' });
    res.json(await computeQuotationConversion(companyId, String(startDate), String(endDate), (customerId ? String(customerId) : 'ALL') as any, { branchIds: resolveBranchIds(req) }));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/sales-by-staff', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.salesByStaff')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required.' });
    res.json(await computeSalesByStaff(companyId, String(startDate), String(endDate), { branchIds: resolveBranchIds(req) }));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/pos-shift-summary', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.posShiftSummary')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required.' });
    res.json(await computePosShiftSummary(companyId, String(startDate), String(endDate), { branchIds: resolveBranchIds(req) }));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/purchase-register', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.purchaseRegister')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { startDate, endDate, vendorId } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required.' });
    res.json(await computePurchaseRegister(companyId, String(startDate), String(endDate), (vendorId ? String(vendorId) : 'ALL') as any, { branchIds: resolveBranchIds(req) }));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/vendor-statement', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.vendorStatement')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { vendorId } = req.query;
    if (!vendorId) return res.status(400).json({ error: 'vendorId is required.' });
    res.json(await computeVendorStatement(companyId, String(vendorId), { branchIds: resolveBranchIds(req) }));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/invoice-kpis', async (req: any, res) => {
  try {
    // Not gated by invoice.read — the Invoice list itself isn't either: a user without it
    // still sees their OWN invoices there (InvoiceModule.tsx's filteredInvoices), so the
    // KPI cards over that same list must stay visible too, just restricted the same way.
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const { startDate, endDate, status, zatcaStatus, docType, origin } = req.query;
    const restrictToUserId = hasPermission(req.user, 'invoice.read') ? null : req.user?.id;
    res.json(await computeInvoiceKpis(companyId, {
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

router.get('/reports/quotation-kpis', async (req: any, res) => {
  try {
    // Same reasoning as invoice-kpis above — not gated by quotation.read.
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    const restrictToUserId = hasPermission(req.user, 'quotation.read') ? null : req.user?.id;
    res.json(await computeQuotationKpis(companyId, { branchIds: resolveBranchIds(req), restrictToUserId }));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/reports/investor-contributions', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'investors.access')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });
    res.json(await computeInvestorContributions(companyId));
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

export default router;
