// General Ledger Step 1.5: report definitions (Trial Balance, Income Statement, Balance Sheet, custom reports), their designer, their evaluation and export.
// One engine (server/lib/reportEngine.ts) serves all of it. Viewing a report needs the report's own permission; designing needs reportDefinitions.*.
import express from 'express';
import ExcelJS from 'exceljs';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { withTenantDb, tenantDb } from '../lib/tenantDb.js';
import { hasPermission } from '../lib/authz.js';
import { recordAuditLog } from '../lib/audit.js';
import { nowDate, todayStr } from '../lib/clock.js';
import { branchIdsFor } from '../lib/ledgerQueries.js';
import { parseDimFilters } from '../lib/dimensions.js';
import { createDefinition, loadDefinition, runDefinition, saveDesign, validateDesign, type EngineDefinition, type ReportType } from '../lib/reportEngine.js';
import { resetStandardDefinition, seedCompanyReportDefinitions } from '../lib/reportDefinitions.js';
import type { ReportFormat } from '../../src/reportFormat.js';

const router = express.Router();
const fail = (res: any, status: number, error: string) => res.status(status).json({ error });
const VIEW_PERMISSION: Record<string, string> = { TrialBalance: 'reports.trialBalanceLedger', PnL: 'reports.incomeStatementLedger', BalanceSheet: 'reports.balanceSheetLedger', Custom: 'reports.customLedgerReports' };
const canDesign = (req: any) => hasPermission(req.user, 'reportDefinitions.update') || hasPermission(req.user, 'reportDefinitions.create');
const canListType = (req: any, type: string) => hasPermission(req.user, VIEW_PERMISSION[type]) || hasPermission(req.user, 'reportDefinitions.read');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function runParams(req: any, src: any) {
  const to = DATE_RE.test(String(src.to || src.asOf || '')) ? String(src.to || src.asOf) : todayStr();
  const from = DATE_RE.test(String(src.from || '')) ? String(src.from) : `${to.slice(0, 4)}-01-01`;
  return { from, to, mode: src.mode === 'Detailed' ? 'Detailed' as const : src.mode === 'Summary' ? 'Summary' as const : undefined, branchIds: branchIdsFor(req) };
}

async function evaluate(tdb: any, req: any, def: EngineDefinition, src: any) {
  const base = runParams(req, src);
  const dims = await parseDimFilters(tdb, req.targetCompanyId, src.dims);
  const result = await runDefinition(tdb, req.targetCompanyId, def, { from: base.from, to: base.to, mode: base.mode || def.defaultDisplayMode, dims, branchIds: base.branchIds });
  result.branchRestricted = !!base.branchIds;
  return result;
}

// ---- list ----
router.get('/report-definitions', withTenantDb, async (req: any, res) => {
  try {
    const tdb = tenantDb(); const companyId = req.targetCompanyId;
    const type = req.query.type ? String(req.query.type) : '';
    if (type && !VIEW_PERMISSION[type]) return fail(res, 400, 'Unknown report type.');
    const allowed = type ? canListType(req, type) : (Object.keys(VIEW_PERMISSION).some(t => canListType(req, t)));
    if (!allowed) return fail(res, 403, 'Forbidden');
    await seedCompanyReportDefinitions(tdb, companyId);
    const rows: any[] = await tdb.select().from(schema.reportDefinitions).where(eq(schema.reportDefinitions.companyId, companyId));
    const counts: any = await tdb.execute(sql`SELECT d.id, (SELECT COUNT(*)::int FROM report_rows r WHERE r.report_definition_id = d.id) AS rows, (SELECT COUNT(*)::int FROM report_columns c WHERE c.report_definition_id = d.id) AS cols FROM report_definitions d WHERE d.company_id = ${companyId}::uuid`);
    const cmap = new Map<string, any>(counts.rows.map((r: any) => [r.id, r]));
    const list = rows.filter(r => (!type || r.reportType === type) && canListType(req, r.reportType))
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
      .map(r => ({ id: r.id, name: r.name, nameAr: r.nameAr, reportType: r.reportType, isSystemSeeded: r.isSystemSeeded, isDefault: r.isDefault, isActive: r.isActive, defaultDisplayMode: r.defaultDisplayMode, rowCount: cmap.get(r.id)?.rows || 0, columnCount: cmap.get(r.id)?.cols || 0, updatedAt: r.updatedAt }));
    res.json({ definitions: list });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// ---- one definition, whole design (the designer's data) ----
router.get('/report-definitions/:id', withTenantDb, async (req: any, res) => {
  try {
    const def = await loadDefinition(tenantDb(), req.targetCompanyId, String(req.params.id));
    if (!def) return fail(res, 404, 'Report not found.');
    if (!canListType(req, def.reportType)) return fail(res, 403, 'Forbidden');
    res.json(def);
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// ---- create (blank, or a copy of an existing one) ----
router.post('/report-definitions', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reportDefinitions.create')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb(); const companyId = req.targetCompanyId; const b = req.body || {};
    const name = String(b.name ?? '').trim().slice(0, 120);
    if (!name) return fail(res, 400, 'A name is required.');
    const [dup] = await tdb.select({ id: schema.reportDefinitions.id }).from(schema.reportDefinitions).where(and(eq(schema.reportDefinitions.companyId, companyId), eq(schema.reportDefinitions.name, name)));
    if (dup) return fail(res, 400, `A report named "${name}" already exists.`);
    let type: ReportType = b.reportType; let design: any = null; let mode: 'Summary' | 'Detailed' = 'Summary';
    if (b.cloneFromId) {
      const src = await loadDefinition(tdb, companyId, String(b.cloneFromId));
      if (!src) return fail(res, 404, 'The report to copy does not exist.');
      type = src.reportType; design = { rows: src.rows, columns: src.columns }; mode = src.defaultDisplayMode;
    }
    if (!['TrialBalance', 'PnL', 'BalanceSheet', 'Custom'].includes(type)) return fail(res, 400, 'Choose a report type.');
    if (!canListType(req, type)) return fail(res, 403, 'Forbidden');
    const id = await createDefinition(tdb, companyId, req.user.id, { name, nameAr: String(b.nameAr ?? '').trim().slice(0, 120) || null, reportType: type, defaultDisplayMode: mode });
    if (design) await saveDesign(tdb, companyId, id, design);
    recordAuditLog(req, 'CREATE_REPORT_DEFINITION', 'report_definition', id, { name, type, clonedFrom: b.cloneFromId || null });
    res.json({ success: true, id });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// ---- save the design ----
router.put('/report-definitions/:id', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reportDefinitions.update')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb(); const companyId = req.targetCompanyId; const b = req.body || {};
    const def = await loadDefinition(tdb, companyId, String(req.params.id));
    if (!def) return fail(res, 404, 'Report not found.');
    const patch: any = { updatedAt: nowDate() };
    if (b.name !== undefined) {
      const name = String(b.name).trim().slice(0, 120); if (!name) return fail(res, 400, 'A name is required.');
      if (name !== def.name) { const [dup] = await tdb.select({ id: schema.reportDefinitions.id }).from(schema.reportDefinitions).where(and(eq(schema.reportDefinitions.companyId, companyId), eq(schema.reportDefinitions.name, name))); if (dup) return fail(res, 400, `A report named "${name}" already exists.`); patch.name = name; }
    }
    if (b.nameAr !== undefined) patch.nameAr = String(b.nameAr ?? '').trim().slice(0, 120) || null;
    if (b.defaultDisplayMode !== undefined) { if (!['Summary', 'Detailed'].includes(b.defaultDisplayMode)) return fail(res, 400, 'Choose Summary or Detailed.'); patch.defaultDisplayMode = b.defaultDisplayMode; }
    if (b.rows !== undefined || b.columns !== undefined) {
      const checked = await validateDesign(tdb, companyId, def.reportType, { rows: b.rows ?? def.rows, columns: b.columns ?? def.columns });
      await saveDesign(tdb, companyId, def.id!, checked);
    }
    await tdb.update(schema.reportDefinitions).set(patch).where(and(eq(schema.reportDefinitions.id, def.id!), eq(schema.reportDefinitions.companyId, companyId)));
    recordAuditLog(req, 'UPDATE_REPORT_DEFINITION', 'report_definition', def.id!, { name: patch.name || def.name, designChanged: b.rows !== undefined || b.columns !== undefined });
    res.json({ success: true });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

router.post('/report-definitions/:id/reset', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reportDefinitions.update')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb();
    await resetStandardDefinition(tdb, req.targetCompanyId, String(req.params.id));
    recordAuditLog(req, 'RESET_REPORT_DEFINITION', 'report_definition', String(req.params.id), {});
    res.json({ success: true });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

router.patch('/report-definitions/:id/set-default', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reportDefinitions.update')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb(); const companyId = req.targetCompanyId;
    const def = await loadDefinition(tdb, companyId, String(req.params.id));
    if (!def) return fail(res, 404, 'Report not found.');
    if (!def.isActive) return fail(res, 400, 'An inactive report cannot be the default.');
    await tdb.update(schema.reportDefinitions).set({ isDefault: false }).where(and(eq(schema.reportDefinitions.companyId, companyId), eq(schema.reportDefinitions.reportType, def.reportType)));
    await tdb.update(schema.reportDefinitions).set({ isDefault: true }).where(and(eq(schema.reportDefinitions.id, def.id!), eq(schema.reportDefinitions.companyId, companyId)));
    recordAuditLog(req, 'SET_DEFAULT_REPORT_DEFINITION', 'report_definition', def.id!, { name: def.name });
    res.json({ success: true });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

router.patch('/report-definitions/:id/toggle-active', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'reportDefinitions.delete')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb(); const companyId = req.targetCompanyId;
    const def = await loadDefinition(tdb, companyId, String(req.params.id));
    if (!def) return fail(res, 404, 'Report not found.');
    if (def.isActive && def.isDefault && def.reportType !== 'Custom') return fail(res, 400, 'This is the default report of its type. Make another one the default first.');
    await tdb.update(schema.reportDefinitions).set({ isActive: !def.isActive, updatedAt: nowDate() }).where(and(eq(schema.reportDefinitions.id, def.id!), eq(schema.reportDefinitions.companyId, companyId)));
    recordAuditLog(req, def.isActive ? 'DEACTIVATE_REPORT_DEFINITION' : 'REACTIVATE_REPORT_DEFINITION', 'report_definition', def.id!, { name: def.name });
    res.json({ success: true, isActive: !def.isActive });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// ---- preview an unsaved design (the designer) ----
router.post('/report-definitions/preview', withTenantDb, async (req: any, res) => {
  try {
    if (!canDesign(req)) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb(); const companyId = req.targetCompanyId; const b = req.body || {};
    const type: ReportType = b.reportType;
    if (!['TrialBalance', 'PnL', 'BalanceSheet', 'Custom'].includes(type)) return fail(res, 400, 'Choose a report type.');
    const checked = await validateDesign(tdb, companyId, type, { rows: b.rows, columns: b.columns });
    const def: EngineDefinition = { name: String(b.name || 'Preview'), reportType: type, defaultDisplayMode: b.mode === 'Detailed' ? 'Detailed' : 'Summary', rows: checked.rows, columns: checked.columns };
    res.json(await evaluate(tdb, req, def, b));
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// ---- run a saved report ----
async function loadForRun(req: any, res: any) {
  const def = await loadDefinition(tenantDb(), req.targetCompanyId, String(req.params.id));
  if (!def) { fail(res, 404, 'Report not found.'); return null; }
  if (!hasPermission(req.user, VIEW_PERMISSION[def.reportType])) { fail(res, 403, 'Forbidden'); return null; }
  return def;
}
router.get('/report-definitions/:id/run', withTenantDb, async (req: any, res) => {
  try {
    const def = await loadForRun(req, res); if (!def) return;
    res.json(await evaluate(tenantDb(), req, def, req.query));
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// ---- Excel export, carrying the formatting ----
const border = (b?: string) => (b === 'double' ? { style: 'double' as const } : b === 'single' ? { style: 'thin' as const } : undefined);
router.get('/report-definitions/:id/export', withTenantDb, async (req: any, res) => {
  try {
    const def = await loadForRun(req, res); if (!def) return;
    const r = await evaluate(tenantDb(), req, def, req.query);
    const [company] = await tenantDb().select({ name: schema.companies.name }).from(schema.companies).where(eq(schema.companies.id, req.targetCompanyId));
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet(def.name.slice(0, 31));
    const cols: { label: string; sub?: 'dr' | 'cr' | 'v'; fmt: ReportFormat }[] = [];
    for (const c of r.columns) {
      if (c.presentation === 'DrCr') { cols.push({ label: `${c.label} Dr`, sub: 'dr', fmt: c.format }); cols.push({ label: `${c.label} Cr`, sub: 'cr', fmt: c.format }); } else cols.push({ label: c.kind === 'Percent' ? `${c.label}` : c.label, sub: 'v', fmt: c.format });
    }
    ws.addRow([company?.name || '']).font = { bold: true, size: 13 };
    ws.addRow([def.name]).font = { bold: true, size: 12 };
    ws.addRow([def.reportType === 'BalanceSheet' ? `As at ${r.params.to}` : `${r.params.from} to ${r.params.to}`]);
    ws.addRow([]);
    const head = ws.addRow(['', ...cols.map(c => c.label)]); head.font = { bold: true }; head.eachCell(c => { c.border = { bottom: { style: 'thin' } }; c.alignment = { horizontal: 'center' }; });
    const widths = [48, ...cols.map(() => 16)];
    const numFmt = (f: ReportFormat, pct: boolean) => { const d = f.decimals === 0 ? '#,##0' : '#,##0.00'; return pct ? '0.0"%"' : f.negatives === 'minus' ? `${d};-${d}` : `${d};(${d})`; };
    const addDataRow = (label: string, cells: any[], f: ReportFormat, extraIndent: number, rowType: string) => {
      const values: (number | null)[] = [];
      r.columns.forEach((c: any, i: number) => {
        const cell = cells[i] || { v: null };
        if (c.presentation === 'DrCr') { values.push(cell.dr ? cell.dr : null); values.push(cell.cr ? cell.cr : null); } else values.push(cell.v === undefined ? null : cell.v);
      });
      const row = ws.addRow([label, ...values]);
      const lab = row.getCell(1);
      lab.font = { bold: f.bold, italic: f.italic, underline: f.underline === 'double' ? 'double' : f.underline === 'single' ? true : undefined };
      lab.alignment = { horizontal: f.align === 'center' ? 'center' : f.align === 'end' ? 'right' : 'left', indent: (f.indent || 0) + extraIndent };
      let ci = 2;
      r.columns.forEach((c: any) => {
        const n = c.presentation === 'DrCr' ? 2 : 1;
        for (let k = 0; k < n; k++) {
          const cell = row.getCell(ci++);
          cell.numFmt = numFmt(f, c.kind === 'Percent');
          cell.font = { bold: f.bold, italic: f.italic, underline: f.underline === 'double' ? 'double' : f.underline === 'single' ? true : undefined };
          cell.alignment = { horizontal: f.amountAlign === 'start' ? 'left' : f.amountAlign === 'center' ? 'center' : 'right' };
        }
      });
      row.eachCell({ includeEmpty: true }, (c) => {
        const bt = border(f.borderTop), bb = border(f.borderBottom);
        if (bt || bb) c.border = { top: bt, bottom: bb };
        if (f.shade) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F2F8' } };
      });
    };
    for (const row of r.rows) {
      if (row.rowType === 'Spacer') { ws.addRow([]); continue; }
      const label = row.label || '';
      if (row.rowType === 'Heading' || row.rowType === 'Text') { const x = ws.addRow([label]); x.font = { bold: row.format.bold, italic: row.format.italic }; x.getCell(1).alignment = { indent: row.format.indent || 0 }; continue; }
      addDataRow(label, row.cells, row.format, 0, row.rowType);
      for (const d of row.detail || []) addDataRow(`${d.code} ${d.name}`, d.cells, { ...row.format, bold: d.isGroup, indent: (row.format.indent || 0) + 1 + d.depth }, 0, 'Detail');
    }
    if (r.notInDefinition.length) {
      ws.addRow([]); const h = ws.addRow(['Not in this report (excluded from the totals above)']); h.font = { bold: true, color: { argb: 'FF9A5B00' } };
      for (const n of r.notInDefinition) addDataRow(`${n.code} ${n.name}`, n.cells, { indent: 1 }, 0, 'NotIn');
    }
    ws.columns.forEach((c, i) => { c.width = widths[i] || 16; });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${def.name.replace(/[^A-Za-z0-9._-]+/g, '-')}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e: any) { if (!res.headersSent) fail(res, e.status || 500, e.message); }
});

export default router;
