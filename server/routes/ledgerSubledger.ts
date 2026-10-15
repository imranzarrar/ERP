// Customer and vendor subledger reports computed from the ledger (server/lib/subledger.ts): balances, a party's ledger, aging, and the reconciliation of the control
// accounts to the parties. Every route runs on the tenant connection; the company is always req.targetCompanyId.
import express from 'express';
import ExcelJS from 'exceljs';
import { withTenantDb, tenantDb } from '../lib/tenantDb.js';
import { hasPermission } from '../lib/authz.js';
import { branchIdsFor } from '../lib/ledgerQueries.js';
import { nowDate } from '../lib/clock.js';
import { AGING_BUCKETS, partyAging, partyBalances, partyLedger, subledgerReconciliation, type SubledgerKind } from '../lib/subledger.js';

const router = express.Router();
const fail = (res: any, status: number, error: string) => res.status(status).json({ error });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => nowDate().toISOString().slice(0, 10);

const PERM: Record<SubledgerKind, { ledger: string; aging: string }> = {
  customer: { ledger: 'reports.customerLedger', aging: 'reports.receivablesAging' },
  vendor: { ledger: 'reports.vendorLedger', aging: 'reports.payablesAging' },
};
const kindOf = (req: any): SubledgerKind | null => (req.params.kind === 'customer' || req.params.kind === 'vendor' ? req.params.kind : null);
const dateParam = (v: any, fallback: string) => (DATE_RE.test(String(v || '')) ? String(v) : fallback);

// parties with their balance (also feeds the party picker of the ledger screen)
router.get('/subledger/:kind/balances', withTenantDb, async (req: any, res) => {
  try {
    const kind = kindOf(req); if (!kind) return fail(res, 400, 'Choose customer or vendor.');
    if (!hasPermission(req.user, PERM[kind].ledger) && !hasPermission(req.user, PERM[kind].aging)) return fail(res, 403, 'Forbidden');
    const rows = await partyBalances(tenantDb(), req.targetCompanyId, kind, { asOf: dateParam(req.query.asOf, today()), branchIds: branchIdsFor(req) });
    res.json({ rows, branchRestricted: !!branchIdsFor(req) });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

router.get('/subledger/:kind/ledger', withTenantDb, async (req: any, res) => {
  try {
    const kind = kindOf(req); if (!kind) return fail(res, 400, 'Choose customer or vendor.');
    if (!hasPermission(req.user, PERM[kind].ledger)) return fail(res, 403, 'Forbidden');
    const partyId = req.query.partyId && req.query.partyId !== 'none' ? String(req.query.partyId) : null;
    if (partyId && !/^[0-9a-f-]{36}$/i.test(partyId)) return fail(res, 400, 'Invalid party.');
    const to = dateParam(req.query.to, today()); const from = dateParam(req.query.from, `${to.slice(0, 4)}-01-01`);
    if (from > to) return fail(res, 400, 'The From date cannot be after the To date.');
    res.json({ from, to, ...(await partyLedger(tenantDb(), req.targetCompanyId, kind, partyId, { from, to, branchIds: branchIdsFor(req) })), branchRestricted: !!branchIdsFor(req) });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

router.get('/subledger/:kind/aging', withTenantDb, async (req: any, res) => {
  try {
    const kind = kindOf(req); if (!kind) return fail(res, 400, 'Choose customer or vendor.');
    if (!hasPermission(req.user, PERM[kind].aging)) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb(); const asOf = dateParam(req.query.asOf, today()); const branchIds = branchIdsFor(req);
    const aging = await partyAging(tdb, req.targetCompanyId, kind, { asOf, branchIds });
    // the reconciliation covers the whole company, so it is shown only to someone not limited to some branches
    const reconciliation = branchIds ? null : await subledgerReconciliation(tdb, req.targetCompanyId, kind, asOf);
    res.json({ ...aging, reconciliation, branchRestricted: !!branchIds });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

const sheet = (title: string, header: string[], rows: any[][]) => {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet(title.replace(/[\/?*[\]:]/g, '-').slice(0, 30)); // a sheet name may not hold : \ / ? * [ ]
  ws.addRow([title]).font = { bold: true, size: 13 }; ws.addRow([]);
  ws.addRow(header).font = { bold: true };
  for (const r of rows) ws.addRow(r);
  ws.columns.forEach((c, i) => { c.width = i === 0 ? 34 : 16; });
  return wb;
};
const send = async (res: any, wb: ExcelJS.Workbook, name: string) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  await wb.xlsx.write(res); res.end();
};

router.get('/subledger/:kind/aging/export', withTenantDb, async (req: any, res) => {
  try {
    const kind = kindOf(req); if (!kind) return fail(res, 400, 'Choose customer or vendor.');
    if (!hasPermission(req.user, PERM[kind].aging)) return fail(res, 403, 'Forbidden');
    const asOf = dateParam(req.query.asOf, today());
    const a = await partyAging(tenantDb(), req.targetCompanyId, kind, { asOf, branchIds: branchIdsFor(req) });
    const wb = sheet(`${kind === 'customer' ? 'Receivables' : 'Payables'} aging as at ${asOf}`, [kind === 'customer' ? 'Customer' : 'Vendor', ...AGING_BUCKETS, 'On account', 'Total'],
      [...a.rows.map(r => [r.name, ...r.buckets, r.unapplied, r.total]), ['Total', ...a.totals.buckets, a.totals.unapplied, a.totals.total]]);
    await send(res, wb, `${kind}-aging-${asOf}.xlsx`);
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

router.get('/subledger/:kind/ledger/export', withTenantDb, async (req: any, res) => {
  try {
    const kind = kindOf(req); if (!kind) return fail(res, 400, 'Choose customer or vendor.');
    if (!hasPermission(req.user, PERM[kind].ledger)) return fail(res, 403, 'Forbidden');
    const partyId = req.query.partyId && req.query.partyId !== 'none' ? String(req.query.partyId) : null;
    const to = dateParam(req.query.to, today()); const from = dateParam(req.query.from, `${to.slice(0, 4)}-01-01`);
    const l = await partyLedger(tenantDb(), req.targetCompanyId, kind, partyId, { from, to, branchIds: branchIdsFor(req) });
    const wb = sheet(`${l.party.name}: ${from} to ${to}`, ['Date', 'Type', 'Document', 'Description', 'Debit', 'Credit', 'Balance'],
      [['Opening balance', '', '', '', '', '', l.opening], ...l.lines.map(x => [x.postingDate, x.referenceType, x.documentNumber || '', x.description, x.debit || '', x.credit || '', x.balance]), ['Closing balance', '', '', '', l.totals.debit, l.totals.credit, l.closing]]);
    await send(res, wb, `${kind}-ledger-${from}-${to}.xlsx`);
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

export default router;
