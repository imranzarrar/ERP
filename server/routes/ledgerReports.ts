// General Ledger Step 1: ledger-based reports (account detail with running balance, Trial Balance from the journal, and the Ledger vs Documents
// comparison). Every figure is computed in Postgres for the one company in the request, with no row cap; a branch-restricted user only ever
// sees the entries of their own branches. These read the journal (journal_entries / journal_lines); the existing document-based reports are
// untouched and the comparison report shows exactly where the two agree and where manual journals / opening balances make them differ.
import express from 'express';
import * as XLSX from 'xlsx';
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { withTenantDb, tenantDb } from '../lib/tenantDb.js';
import { hasPermission } from '../lib/authz.js';
import { todayStr } from '../lib/clock.js';
import { isDebitNormal } from '../lib/chartOfAccounts.js';
import { resolvedLines, branchIdsFor, round2, uuidArray } from '../lib/ledgerQueries.js';
import { computeBalanceSheet, computeProfitLoss } from '../lib/financialReports.js';

const router = express.Router();
const fail = (res: any, status: number, error: string) => res.status(status).json({ error });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayBefore = (d: string) => new Date(new Date(d + 'T00:00:00.000Z').getTime() - 86400000).toISOString().slice(0, 10);

function range(req: any): { from: string; to: string; error?: string } {
  const to = req.query.to ? String(req.query.to) : todayStr();
  const from = req.query.from ? String(req.query.from) : `${to.slice(0, 4)}-01-01`;
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || isNaN(Date.parse(from)) || isNaN(Date.parse(to))) return { from, to, error: 'Enter valid dates.' };
  if (from > to) return { from, to, error: 'The From date cannot be after the To date.' };
  return { from, to };
}

// ---- General Ledger: one account (or a heading and everything beneath it), opening balance, every movement, running balance ----
async function generalLedger(req: any, opts: { paged: boolean }) {
  const tdb = tenantDb();
  const companyId = req.targetCompanyId;
  const { from, to, error } = range(req);
  if (error) throw Object.assign(new Error(error), { status: 400 });
  const accountId = String(req.query.accountId || '');
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) throw Object.assign(new Error('Choose an account.'), { status: 400 });
  const accounts = await tdb.select().from(schema.companyAccounts).where(eq(schema.companyAccounts.companyId, companyId));
  const account = accounts.find((a: any) => a.id === accountId);
  if (!account) throw Object.assign(new Error('Account not found.'), { status: 404 });
  // A heading shows everything beneath it.
  const ids: string[] = [];
  const walk = (id: string) => { ids.push(id); for (const c of accounts) if (c.parentId === id) walk(c.id); };
  walk(account.id);
  const branchIds = branchIdsFor(req);
  const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(Number(req.query.pageSize) || 50)));
  const sign = isDebitNormal(account.type) ? 1 : -1;

  const openRes: any = await tdb.execute(sql`SELECT COALESCE(SUM(rl.debit - rl.credit),0)::float8 AS net FROM ${resolvedLines(companyId, { to: dayBefore(from), branchIds })} WHERE rl.account_id = ANY(${uuidArray(ids)})`);
  const opening = round2(Number(openRes.rows[0].net));
  const period = resolvedLines(companyId, { from, to, branchIds });
  const totRes: any = await tdb.execute(sql`SELECT COALESCE(SUM(rl.debit),0)::float8 AS debit, COALESCE(SUM(rl.credit),0)::float8 AS credit, COUNT(*)::int AS n FROM ${period} WHERE rl.account_id = ANY(${uuidArray(ids)})`);
  const totals = { debit: round2(Number(totRes.rows[0].debit)), credit: round2(Number(totRes.rows[0].credit)), lines: Number(totRes.rows[0].n) };
  const lim = opts.paged ? sql`LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}` : sql`LIMIT 100000`;
  const rowsRes: any = await tdb.execute(sql`
    SELECT x.*, e.description, a.code AS "accountCode", a.name AS "accountName" FROM (
      SELECT rl.line_id, rl.journal_entry_id AS "entryId", rl.date, rl.reference_type AS "referenceType", rl.reference_id AS "referenceId", rl.account_id AS "accountId",
             rl.debit::float8 AS debit, rl.credit::float8 AS credit, rl.created_at,
             SUM(rl.debit - rl.credit) OVER (ORDER BY rl.date, rl.created_at, rl.line_id ROWS UNBOUNDED PRECEDING)::float8 AS cum
      FROM ${period} WHERE rl.account_id = ANY(${uuidArray(ids)})
    ) x
    JOIN journal_entries e ON e.id = x."entryId" AND e.company_id = ${companyId}::uuid
    LEFT JOIN company_accounts a ON a.id = x."accountId" AND a.company_id = ${companyId}::uuid
    ORDER BY x.date, x.created_at, x.line_id ${lim}`);
  // Names of the documents the entries came from.
  const byType = new Map<string, string[]>();
  for (const r of rowsRes.rows) { const l = byType.get(r.referenceType) || []; l.push(r.referenceId); byType.set(r.referenceType, l); }
  const docNo = new Map<string, string>();
  const grab = async (types: string[], table: any, idCol: any, numCol: any) => {
    const refs = types.flatMap(t => byType.get(t) || []);
    if (!refs.length) return;
    const rows = await tdb.select({ id: idCol, n: numCol }).from(table).where(and(eq(table.companyId, companyId), inArray(idCol, [...new Set(refs)])));
    for (const r of rows) docNo.set(r.id, r.n);
  };
  await grab(['Invoice', 'CreditNote'], schema.invoices, schema.invoices.id, schema.invoices.invoiceNumber);
  await grab(['Expense'], schema.expenses, schema.expenses.id, schema.expenses.expenseNumber);
  await grab(['PurchaseBill'], schema.purchaseBills, schema.purchaseBills.id, schema.purchaseBills.billNumber);
  await grab(['Manual'], schema.manualJournals, schema.manualJournals.id, schema.manualJournals.number);
  const rows = rowsRes.rows.map((r: any) => ({
    entryId: r.entryId, date: r.date, referenceType: r.referenceType, documentNumber: docNo.get(r.referenceId) || null, description: r.description,
    accountCode: r.accountCode || '', accountName: r.accountName || '', debit: round2(r.debit), credit: round2(r.credit),
    balance: round2(sign * (opening + Number(r.cum))),
  }));
  const closing = round2(sign * (opening + totals.debit - totals.credit));
  return {
    account: { id: account.id, code: account.code, name: account.name, nameAr: account.nameAr, type: account.type, isGroup: account.isGroup },
    from, to, opening: round2(sign * opening), totals, closing, rows, page, pageSize, branchRestricted: !!branchIds,
  };
}

router.get('/reports/general-ledger', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.generalLedger')) return fail(res, 403, 'Forbidden');
    res.json(await generalLedger(req, { paged: true }));
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});
router.get('/reports/general-ledger/export', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.generalLedger')) return fail(res, 403, 'Forbidden');
    const g = await generalLedger(req, { paged: false });
    const aoa: any[][] = [
      [`General Ledger: ${g.account.code} ${g.account.name}`], [`From ${g.from} to ${g.to}`], [],
      ['Date', 'Source', 'Document', 'Account', 'Description', 'Debit', 'Credit', 'Balance'],
      ['', '', '', '', 'Opening balance', '', '', g.opening],
      ...g.rows.map((r: any) => [r.date, r.referenceType, r.documentNumber || '', `${r.accountCode} ${r.accountName}`.trim(), r.description, r.debit || '', r.credit || '', r.balance]),
      ['', '', '', '', 'Closing balance', g.totals.debit, g.totals.credit, g.closing],
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 34 }, { wch: 50 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'General Ledger');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="general-ledger-${g.account.code}.xlsx"`);
    res.send(buf);
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// ---- Trial Balance from the journal: opening, movement, closing per account ----
async function trialBalance(req: any) {
  const tdb = tenantDb();
  const companyId = req.targetCompanyId;
  const { from, to, error } = range(req);
  if (error) throw Object.assign(new Error(error), { status: 400 });
  const includeZero = req.query.includeZero === '1';
  const branchIds = branchIdsFor(req);
  const accounts = await tdb.select().from(schema.companyAccounts).where(eq(schema.companyAccounts.companyId, companyId));
  const res: any = await tdb.execute(sql`
    SELECT rl.account_id AS "accountId",
           COALESCE(SUM(CASE WHEN rl.date < ${from} THEN rl.debit - rl.credit END),0)::float8 AS opening,
           COALESCE(SUM(CASE WHEN rl.date >= ${from} THEN rl.debit END),0)::float8 AS debit,
           COALESCE(SUM(CASE WHEN rl.date >= ${from} THEN rl.credit END),0)::float8 AS credit,
           COUNT(*)::int AS lines
    FROM ${resolvedLines(companyId, { to, branchIds })} GROUP BY rl.account_id`);
  const m = new Map<string | null, any>(res.rows.map((r: any) => [r.accountId, r]));
  const rows = accounts.map((a: any) => {
    const r = m.get(a.id);
    const opening = round2(Number(r?.opening || 0)), debit = round2(Number(r?.debit || 0)), credit = round2(Number(r?.credit || 0));
    return { id: a.id, code: a.code, name: a.name, nameAr: a.nameAr, type: a.type, parentId: a.parentId, isGroup: a.isGroup, isActive: a.isActive, lines: Number(r?.lines || 0), opening, debit, credit, closing: round2(opening + debit - credit) };
  });
  // A heading carries the total of the accounts beneath it (display only; the grand totals count the posting accounts once).
  const kids = new Map<string, any[]>();
  for (const r of rows) if (r.parentId) { const l = kids.get(r.parentId) || []; l.push(r); kids.set(r.parentId, l); }
  const roll = (r: any): any => {
    if (!r.isGroup) return r;
    const c = (kids.get(r.id) || []).map(roll);
    r.opening = round2(c.reduce((s: number, x: any) => s + x.opening, 0)); r.debit = round2(c.reduce((s: number, x: any) => s + x.debit, 0));
    r.credit = round2(c.reduce((s: number, x: any) => s + x.credit, 0)); r.closing = round2(c.reduce((s: number, x: any) => s + x.closing, 0));
    r.lines = c.reduce((s: number, x: any) => s + x.lines, 0);
    return r;
  };
  rows.forEach(r => { if (r.isGroup && !r.parentId) roll(r); });
  rows.forEach(r => { if (r.isGroup) roll(r); });
  const posting = rows.filter(r => !r.isGroup);
  const unmapped = m.get(null);
  const totals = {
    opening: round2(posting.reduce((s, r) => s + r.opening, 0) + Number(unmapped?.opening || 0)),
    debit: round2(posting.reduce((s, r) => s + r.debit, 0) + Number(unmapped?.debit || 0)),
    credit: round2(posting.reduce((s, r) => s + r.credit, 0) + Number(unmapped?.credit || 0)),
    closing: round2(posting.reduce((s, r) => s + r.closing, 0) + Number(unmapped?.opening || 0) + Number(unmapped?.debit || 0) - Number(unmapped?.credit || 0)),
  };
  const shown = rows.filter(r => includeZero || r.lines > 0 || Math.abs(r.opening) > 0.004 || Math.abs(r.closing) > 0.004)
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  return { from, to, rows: shown, totals, unmapped: unmapped ? { lines: Number(unmapped.lines), net: round2(Number(unmapped.opening) + Number(unmapped.debit) - Number(unmapped.credit)) } : null, balanced: Math.abs(totals.debit - totals.credit) < 0.011 && Math.abs(totals.closing) < 0.011, branchRestricted: !!branchIds };
}
router.get('/reports/trial-balance', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.trialBalanceLedger')) return fail(res, 403, 'Forbidden');
    res.json(await trialBalance(req));
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});
router.get('/reports/trial-balance/export', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.trialBalanceLedger')) return fail(res, 403, 'Forbidden');
    const t = await trialBalance(req);
    const side = (n: number) => ({ dr: n > 0 ? n : '', cr: n < 0 ? -n : '' });
    const aoa: any[][] = [[`Trial Balance (Ledger) ${t.from} to ${t.to}`], [],
      ['Code', 'Account', 'Type', 'Opening Dr', 'Opening Cr', 'Debit', 'Credit', 'Closing Dr', 'Closing Cr'],
      ...t.rows.map((r: any) => [r.code, r.name, r.type, side(r.opening).dr, side(r.opening).cr, r.debit || '', r.credit || '', side(r.closing).dr, side(r.closing).cr]),
      ['', 'Total', '', side(t.totals.opening).dr, side(t.totals.opening).cr, t.totals.debit, t.totals.credit, side(t.totals.closing).dr, side(t.totals.closing).cr]];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 10 }, { wch: 40 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Trial Balance');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="trial-balance-ledger.xlsx"');
    res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// ---- Ledger vs Documents: where the journal and the document-based statements agree, and what manual journals / opening balances add ----
router.get('/reports/ledger-vs-documents', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reports.ledgerReconciliation')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb();
    const companyId = req.targetCompanyId;
    const asOf = req.query.asOf ? String(req.query.asOf) : todayStr();
    if (!DATE_RE.test(asOf) || isNaN(Date.parse(asOf))) return fail(res, 400, 'Enter a valid date.');
    // Document-made entries carry their posting role (account_key); manual journals and opening entries name an account and carry no role.
    const roleRes: any = await tdb.execute(sql`SELECT l.account_key AS k, COALESCE(SUM(l.debit - l.credit),0)::float8 AS net
      FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id AND e.company_id = l.company_id
      WHERE l.company_id = ${companyId}::uuid AND e.date <= ${asOf} AND l.account_key IS NOT NULL GROUP BY l.account_key`);
    const net = (k: string) => round2(Number(roleRes.rows.find((r: any) => r.k === k)?.net || 0));
    const bs = await computeBalanceSheet(tdb, companyId, asOf);
    const pl = await computeProfitLoss(tdb, companyId, '1900-01-01', asOf, 'Accrual', { branchIds: null } as any);
    const pairs: [string, string, number, number][] = [
      ['BANK', 'Cash and bank', net('BANK'), bs.bankBalance], ['AR', 'Accounts receivable', net('AR'), bs.accountsReceivable], ['AP', 'Accounts payable', -net('AP'), bs.accountsPayable],
      ['INVENTORY', 'Inventory', net('INVENTORY'), bs.inventoryValue], ['FIXED_ASSETS', 'Fixed assets', net('FIXED_ASSETS'), bs.fixedAssets],
      ['VAT_INPUT', 'VAT input (recoverable)', net('VAT_INPUT'), bs.vatInputRecoverable], ['VAT_OUTPUT', 'VAT output (payable)', -net('VAT_OUTPUT'), bs.vatOutputPayable],
      ['GR_IR_CLEARING', 'Goods received not invoiced', -net('GR_IR_CLEARING'), bs.goodsReceivedNotBilled], ['VENDOR_CREDIT_RECEIVABLE', 'Vendor credit receivable', net('VENDOR_CREDIT_RECEIVABLE'), bs.vendorCreditReceivable],
      ['SALES_REVENUE', 'Sales revenue', -net('SALES_REVENUE'), pl.totalRevenue], ['COGS', 'Cost of goods sold', net('COGS'), pl.costOfGoodsSold],
    ];
    const rows = pairs.map(([key, label, ledger, documents]) => ({ key, label, ledger, documents: round2(documents), difference: round2(ledger - documents) }));
    const man: any = await tdb.execute(sql`SELECT e.reference_type AS t, COUNT(DISTINCT e.id)::int AS entries, COALESCE(SUM(l.debit),0)::float8 AS debit
      FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id = e.id AND l.company_id = e.company_id
      WHERE e.company_id = ${companyId}::uuid AND e.date <= ${asOf} AND e.reference_type IN ('Manual','Opening') GROUP BY e.reference_type`);
    const pending: any = await tdb.execute(sql`SELECT COUNT(*)::int AS n FROM manual_journals WHERE company_id = ${companyId}::uuid AND status = 'Pending'`);
    const unmapped: any = await tdb.execute(sql`SELECT COUNT(*)::int AS n FROM journal_lines WHERE company_id = ${companyId}::uuid AND account_id IS NULL`);
    res.json({
      asOf, rows, inAgreement: rows.every(r => Math.abs(r.difference) < 0.011),
      manual: man.rows.find((r: any) => r.t === 'Manual') || { t: 'Manual', entries: 0, debit: 0 },
      opening: man.rows.find((r: any) => r.t === 'Opening') || { t: 'Opening', entries: 0, debit: 0 },
      pendingManual: Number(pending.rows[0].n), unmappedLines: Number(unmapped.rows[0].n),
    });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

export default router;
