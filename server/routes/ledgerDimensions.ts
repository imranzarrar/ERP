// General Ledger Step 1.5: dynamic dimensions. Setup in the order a finance team follows it:
//   1. define dimension types (Branch and Department are seeded; add Profit Centre, Project ... as needed)  -> /dimensions
//   2. fill them: values of a custom type, cost centres for Department, branches for Branch                   -> /dimensions/:id/values, /cost-centers
//   3. assign them to the chart of accounts (Required / Optional / Not allowed, with a default)               -> /dimension-rules
//   4. tag postings (manual journals now, documents next) and 5. filter every ledger report by them           -> /dimension-options feeds the pickers
// Every route runs on the restricted tenant connection, every id a client names is verified to belong to this company, and every change is audit-logged.
import express from 'express';
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { generateId } from '../../src/id.js';
import { withTenantDb, tenantDb } from '../lib/tenantDb.js';
import { hasPermission, branchAccessOk } from '../lib/authz.js';
import { recordAuditLog } from '../lib/audit.js';
import { nowDate } from '../lib/clock.js';
import { entitiesOfType, loadTypes, seedCompanyDimensions } from '../lib/dimensions.js';

const router = express.Router();
const fail = (res: any, status: number, error: string) => res.status(status).json({ error });
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/;
const ID_RE = /^[0-9a-f-]{36}$/i;

const canSeeTypes = (req: any) => ['dimensions.read', 'accountDimensionRules.read', 'accountMapping.update', 'journals.create', 'journals.read', 'journals.post', 'reports.generalLedger', 'reports.trialBalanceLedger', 'reports.ledgerReconciliation']
  .some(k => hasPermission(req.user, k));

async function ensureSeeded(tdb: any, companyId: string) { await seedCompanyDimensions(tdb, companyId); }
async function loadType(tdb: any, companyId: string, id: string) {
  if (!ID_RE.test(id)) return undefined;
  const [t] = await tdb.select().from(schema.dimensionTypes).where(and(eq(schema.dimensionTypes.id, id), eq(schema.dimensionTypes.companyId, companyId)));
  return t;
}
// The typed column a default / tag of this type is stored in.
const entityColumns = (type: any, entityId: string | null) => ({
  defaultValueId: type.valueSource === 'Custom' ? entityId : null,
  defaultBranchId: type.linkedEntity === 'branches' ? entityId : null,
  defaultCostCenterId: type.linkedEntity === 'cost_centers' ? entityId : null,
});

// ---------------- types ----------------
router.get('/dimensions', withTenantDb, async (req: any, res) => {
  try {
    if (!canSeeTypes(req)) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb(); const companyId = req.targetCompanyId;
    await ensureSeeded(tdb, companyId);
    const types = await loadTypes(tdb, companyId);
    const out = [];
    for (const t of types) {
      const ents = await entitiesOfType(tdb, companyId, t);
      const rules: any = await tdb.execute(sql`SELECT rule, COUNT(*)::int AS n FROM account_dimension_rules WHERE company_id = ${companyId}::uuid AND dimension_type_id = ${t.id}::uuid GROUP BY rule`);
      const byRule: Record<string, number> = {}; for (const r of rules.rows) byRule[r.rule] = Number(r.n);
      out.push({ ...t, entityCount: ents.length, activeEntityCount: ents.filter(e => e.isActive).length, rules: byRule });
    }
    res.json({ types: out });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

router.post('/dimensions', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'dimensions.create')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb(); const companyId = req.targetCompanyId;
    const code = String(req.body?.code ?? '').trim().toUpperCase(); const name = String(req.body?.name ?? '').trim(); const nameAr = String(req.body?.nameAr ?? '').trim() || null;
    if (!CODE_RE.test(code)) return fail(res, 400, 'Code may use letters, digits, ".", "_" and "-", up to 20 characters.');
    if (!name || name.length > 80 || (nameAr && nameAr.length > 80)) return fail(res, 400, 'A name (up to 80 characters) is required.');
    const [dup] = await tdb.select({ id: schema.dimensionTypes.id }).from(schema.dimensionTypes).where(and(eq(schema.dimensionTypes.companyId, companyId), eq(schema.dimensionTypes.code, code)));
    if (dup) return fail(res, 400, `A dimension with code ${code} already exists.`);
    const all = await loadTypes(tdb, companyId);
    const id = generateId();
    await tdb.insert(schema.dimensionTypes).values({ id, companyId, code, name, nameAr, valueSource: 'Custom', linkedEntity: null, isHierarchical: req.body?.isHierarchical === true, isSystem: false, sortOrder: all.length + 1, isActive: true, createdAt: nowDate() });
    recordAuditLog(req, 'CREATE_DIMENSION', 'dimension_type', id, { code, name });
    res.json({ success: true, id });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

router.put('/dimensions/:id', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'dimensions.update')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb(); const companyId = req.targetCompanyId;
    const t = await loadType(tdb, companyId, String(req.params.id));
    if (!t) return fail(res, 404, 'Dimension not found.');
    const patch: any = {};
    if (req.body?.name !== undefined) { const n = String(req.body.name).trim(); if (!n || n.length > 80) return fail(res, 400, 'A name (up to 80 characters) is required.'); patch.name = n; }
    if (req.body?.nameAr !== undefined) { const n = String(req.body.nameAr || '').trim(); if (n.length > 80) return fail(res, 400, 'The Arabic name may be up to 80 characters.'); patch.nameAr = n || null; }
    if (req.body?.isHierarchical !== undefined && req.body.isHierarchical !== t.isHierarchical) {
      if (t.isSystem) return fail(res, 400, 'A seeded dimension keeps its structure.');
      if (req.body.isHierarchical === false) {
        const [child] = await tdb.select({ id: schema.dimensionValues.id }).from(schema.dimensionValues).where(and(eq(schema.dimensionValues.companyId, companyId), eq(schema.dimensionValues.dimensionTypeId, t.id), sql`${schema.dimensionValues.parentValueId} IS NOT NULL`));
        if (child) return fail(res, 400, 'Some values sit under others. Move them to the top level first.');
      }
      patch.isHierarchical = req.body.isHierarchical === true;
    }
    if (!Object.keys(patch).length) return res.json({ success: true, unchanged: true });
    await tdb.update(schema.dimensionTypes).set(patch).where(and(eq(schema.dimensionTypes.id, t.id), eq(schema.dimensionTypes.companyId, companyId)));
    recordAuditLog(req, 'UPDATE_DIMENSION', 'dimension_type', t.id, { code: t.code, change: patch });
    res.json({ success: true });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

router.patch('/dimensions/:id/toggle-active', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'dimensions.delete')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb(); const companyId = req.targetCompanyId;
    const t = await loadType(tdb, companyId, String(req.params.id));
    if (!t) return fail(res, 404, 'Dimension not found.');
    if (t.isActive) {
      if (t.isSystem) return fail(res, 400, 'A seeded dimension (Branch, Department) cannot be deactivated.');
      const [req1] = await tdb.select({ id: schema.accountDimensionRules.id }).from(schema.accountDimensionRules).where(and(eq(schema.accountDimensionRules.companyId, companyId), eq(schema.accountDimensionRules.dimensionTypeId, t.id), eq(schema.accountDimensionRules.rule, 'required')));
      if (req1) return fail(res, 400, 'Some accounts require this dimension. Change their rule first (Account Dimension Rules).');
    }
    await tdb.update(schema.dimensionTypes).set({ isActive: !t.isActive }).where(and(eq(schema.dimensionTypes.id, t.id), eq(schema.dimensionTypes.companyId, companyId)));
    recordAuditLog(req, t.isActive ? 'DEACTIVATE_DIMENSION' : 'REACTIVATE_DIMENSION', 'dimension_type', t.id, { code: t.code });
    res.json({ success: true, isActive: !t.isActive });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// ---------------- values of a type (custom values are edited here; branches and cost centres are listed read-only) ----------------
router.get('/dimensions/:id/values', withTenantDb, async (req: any, res) => {
  try {
    if (!canSeeTypes(req)) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb(); const companyId = req.targetCompanyId;
    const t = await loadType(tdb, companyId, String(req.params.id));
    if (!t) return fail(res, 404, 'Dimension not found.');
    const ents = (await entitiesOfType(tdb, companyId, t)).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
    res.json({ type: t, values: ents, editable: t.valueSource === 'Custom' });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

async function checkParentValue(tdb: any, companyId: string, type: any, parentId: any, selfId?: string): Promise<string | null> {
  if (!parentId) return null;
  if (!type.isHierarchical) return 'This dimension is not hierarchical.';
  const [p] = await tdb.select().from(schema.dimensionValues).where(and(eq(schema.dimensionValues.id, String(parentId)), eq(schema.dimensionValues.companyId, companyId), eq(schema.dimensionValues.dimensionTypeId, type.id)));
  if (!p) return 'Invalid parent value.';
  let cur: any = p; let guard = 0;
  while (cur && guard++ < 30) { if (selfId && cur.id === selfId) return 'That would make the values loop.'; cur = cur.parentValueId ? (await tdb.select().from(schema.dimensionValues).where(and(eq(schema.dimensionValues.id, cur.parentValueId), eq(schema.dimensionValues.companyId, companyId))))[0] : null; }
  return null;
}

router.post('/dimensions/:id/values', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'dimensions.create')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb(); const companyId = req.targetCompanyId;
    const t = await loadType(tdb, companyId, String(req.params.id));
    if (!t) return fail(res, 404, 'Dimension not found.');
    if (t.valueSource !== 'Custom') return fail(res, 400, t.linkedEntity === 'branches' ? 'Branch values are the company\'s branches (Settings > Branches).' : 'Department values are cost centres (Dimensions > Cost Centres).');
    const code = String(req.body?.code ?? '').trim(); const name = String(req.body?.name ?? '').trim(); const nameAr = String(req.body?.nameAr ?? '').trim() || null;
    if (!CODE_RE.test(code)) return fail(res, 400, 'Code may use letters, digits, ".", "_" and "-", up to 20 characters.');
    if (!name || name.length > 120 || (nameAr && nameAr.length > 120)) return fail(res, 400, 'A name (up to 120 characters) is required.');
    const [dup] = await tdb.select({ id: schema.dimensionValues.id }).from(schema.dimensionValues).where(and(eq(schema.dimensionValues.dimensionTypeId, t.id), eq(schema.dimensionValues.companyId, companyId), eq(schema.dimensionValues.code, code)));
    if (dup) return fail(res, 400, `Code ${code} is already used in ${t.name}.`);
    const perr = await checkParentValue(tdb, companyId, t, req.body?.parentValueId);
    if (perr) return fail(res, 400, perr);
    const id = generateId();
    await tdb.insert(schema.dimensionValues).values({ id, companyId, dimensionTypeId: t.id, code, name, nameAr, parentValueId: req.body?.parentValueId || null, isActive: true, createdAt: nowDate() });
    recordAuditLog(req, 'CREATE_DIMENSION_VALUE', 'dimension_value', id, { dimension: t.code, code, name });
    res.json({ success: true, id });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

router.put('/dimension-values/:id', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'dimensions.update')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb(); const companyId = req.targetCompanyId;
    if (!ID_RE.test(String(req.params.id))) return fail(res, 404, 'Value not found.');
    const [v] = await tdb.select().from(schema.dimensionValues).where(and(eq(schema.dimensionValues.id, String(req.params.id)), eq(schema.dimensionValues.companyId, companyId)));
    if (!v) return fail(res, 404, 'Value not found.');
    const t = await loadType(tdb, companyId, v.dimensionTypeId);
    const patch: any = {};
    if (req.body?.code !== undefined) {
      const code = String(req.body.code).trim();
      if (!CODE_RE.test(code)) return fail(res, 400, 'Code may use letters, digits, ".", "_" and "-", up to 20 characters.');
      if (code !== v.code) {
        const [dup] = await tdb.select({ id: schema.dimensionValues.id }).from(schema.dimensionValues).where(and(eq(schema.dimensionValues.dimensionTypeId, v.dimensionTypeId), eq(schema.dimensionValues.companyId, companyId), eq(schema.dimensionValues.code, code)));
        if (dup) return fail(res, 400, `Code ${code} is already used.`);
        patch.code = code;
      }
    }
    if (req.body?.name !== undefined) { const n = String(req.body.name).trim(); if (!n || n.length > 120) return fail(res, 400, 'A name is required.'); patch.name = n; }
    if (req.body?.nameAr !== undefined) { const n = String(req.body.nameAr || '').trim(); if (n.length > 120) return fail(res, 400, 'The Arabic name may be up to 120 characters.'); patch.nameAr = n || null; }
    if (req.body?.parentValueId !== undefined && (req.body.parentValueId || null) !== (v.parentValueId || null)) {
      const perr = await checkParentValue(tdb, companyId, t, req.body.parentValueId, v.id);
      if (perr) return fail(res, 400, perr);
      patch.parentValueId = req.body.parentValueId || null;
    }
    if (!Object.keys(patch).length) return res.json({ success: true, unchanged: true });
    await tdb.update(schema.dimensionValues).set(patch).where(and(eq(schema.dimensionValues.id, v.id), eq(schema.dimensionValues.companyId, companyId)));
    recordAuditLog(req, 'UPDATE_DIMENSION_VALUE', 'dimension_value', v.id, { code: v.code, change: patch });
    res.json({ success: true });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

router.patch('/dimension-values/:id/toggle-active', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'dimensions.delete')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb(); const companyId = req.targetCompanyId;
    if (!ID_RE.test(String(req.params.id))) return fail(res, 404, 'Value not found.');
    const [v] = await tdb.select().from(schema.dimensionValues).where(and(eq(schema.dimensionValues.id, String(req.params.id)), eq(schema.dimensionValues.companyId, companyId)));
    if (!v) return fail(res, 404, 'Value not found.');
    if (v.isActive) {
      const [def] = await tdb.select({ id: schema.accountDimensionRules.id }).from(schema.accountDimensionRules).where(and(eq(schema.accountDimensionRules.companyId, companyId), eq(schema.accountDimensionRules.defaultValueId, v.id)));
      if (def) return fail(res, 400, 'An account uses this value as its default. Change that rule first.');
    } else if (v.parentValueId) {
      const [p] = await tdb.select().from(schema.dimensionValues).where(and(eq(schema.dimensionValues.id, v.parentValueId), eq(schema.dimensionValues.companyId, companyId)));
      if (p && !p.isActive) return fail(res, 400, 'Reactivate the parent value first.');
    }
    await tdb.update(schema.dimensionValues).set({ isActive: !v.isActive }).where(and(eq(schema.dimensionValues.id, v.id), eq(schema.dimensionValues.companyId, companyId)));
    recordAuditLog(req, v.isActive ? 'DEACTIVATE_DIMENSION_VALUE' : 'REACTIVATE_DIMENSION_VALUE', 'dimension_value', v.id, { code: v.code });
    res.json({ success: true, isActive: !v.isActive });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// ---------------- cost centres (the values of the Department dimension) ----------------
async function checkCostCenterLinks(tdb: any, req: any, companyId: string, body: any, selfId?: string): Promise<{ error?: string; status?: number }> {
  if (body.homeBranchId) {
    const [b] = await tdb.select({ id: schema.branches.id }).from(schema.branches).where(and(eq(schema.branches.id, String(body.homeBranchId)), eq(schema.branches.companyId, companyId)));
    if (!b) return { error: 'Invalid home branch.', status: 400 };
    if (!branchAccessOk(req, b.id)) return { error: 'Forbidden: you are not assigned to that branch.', status: 403 };
  }
  if (body.parentId) {
    let cur: any = (await tdb.select().from(schema.costCenters).where(and(eq(schema.costCenters.id, String(body.parentId)), eq(schema.costCenters.companyId, companyId))))[0];
    if (!cur) return { error: 'Invalid parent cost centre.', status: 400 };
    let guard = 0;
    while (cur && guard++ < 30) { if (selfId && cur.id === selfId) return { error: 'That would make the cost centres loop.', status: 400 }; cur = cur.parentId ? (await tdb.select().from(schema.costCenters).where(and(eq(schema.costCenters.id, cur.parentId), eq(schema.costCenters.companyId, companyId))))[0] : null; }
  }
  return {};
}

router.get('/cost-centers', withTenantDb, async (req: any, res) => {
  try {
    if (!canSeeTypes(req)) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb(); const companyId = req.targetCompanyId;
    const rows = await tdb.select().from(schema.costCenters).where(eq(schema.costCenters.companyId, companyId));
    rows.sort((a: any, b: any) => a.code.localeCompare(b.code, undefined, { numeric: true }));
    res.json({ costCenters: rows });
  } catch (e: any) { fail(res, 500, e.message); }
});

router.post('/cost-centers', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'dimensions.create')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb(); const companyId = req.targetCompanyId; const b = req.body || {};
    const code = String(b.code ?? '').trim(); const name = String(b.name ?? '').trim(); const nameAr = String(b.nameAr ?? '').trim() || null;
    if (!CODE_RE.test(code)) return fail(res, 400, 'Code may use letters, digits, ".", "_" and "-", up to 20 characters.');
    if (!name || name.length > 120 || (nameAr && nameAr.length > 120)) return fail(res, 400, 'A name (up to 120 characters) is required.');
    const [dup] = await tdb.select({ id: schema.costCenters.id }).from(schema.costCenters).where(and(eq(schema.costCenters.companyId, companyId), eq(schema.costCenters.code, code)));
    if (dup) return fail(res, 400, `Code ${code} is already used by another cost centre.`);
    const chk = await checkCostCenterLinks(tdb, req, companyId, b);
    if (chk.error) return fail(res, chk.status || 400, chk.error);
    const id = generateId();
    // isolation-ok: homeBranchId and parentId were verified to be this company's own just above (checkCostCenterLinks)
    await tdb.insert(schema.costCenters).values({ id, companyId, code, name, nameAr, homeBranchId: b.homeBranchId || null, parentId: b.parentId || null, isActive: true, createdAt: nowDate() });
    recordAuditLog(req, 'CREATE_COST_CENTER', 'cost_center', id, { code, name });
    res.json({ success: true, id });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

router.put('/cost-centers/:id', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'dimensions.update')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb(); const companyId = req.targetCompanyId; const b = req.body || {};
    if (!ID_RE.test(String(req.params.id))) return fail(res, 404, 'Cost centre not found.');
    const [c] = await tdb.select().from(schema.costCenters).where(and(eq(schema.costCenters.id, String(req.params.id)), eq(schema.costCenters.companyId, companyId)));
    if (!c) return fail(res, 404, 'Cost centre not found.');
    const patch: any = {};
    if (b.code !== undefined) {
      const code = String(b.code).trim();
      if (!CODE_RE.test(code)) return fail(res, 400, 'Code may use letters, digits, ".", "_" and "-", up to 20 characters.');
      if (code !== c.code) { const [dup] = await tdb.select({ id: schema.costCenters.id }).from(schema.costCenters).where(and(eq(schema.costCenters.companyId, companyId), eq(schema.costCenters.code, code))); if (dup) return fail(res, 400, `Code ${code} is already used.`); patch.code = code; }
    }
    if (b.name !== undefined) { const n = String(b.name).trim(); if (!n || n.length > 120) return fail(res, 400, 'A name is required.'); patch.name = n; }
    if (b.nameAr !== undefined) { const n = String(b.nameAr || '').trim(); if (n.length > 120) return fail(res, 400, 'The Arabic name may be up to 120 characters.'); patch.nameAr = n || null; }
    if (b.homeBranchId !== undefined && (b.homeBranchId || null) !== (c.homeBranchId || null)) { const chk = await checkCostCenterLinks(tdb, req, companyId, { homeBranchId: b.homeBranchId }); if (chk.error) return fail(res, chk.status || 400, chk.error); patch.homeBranchId = b.homeBranchId || null; }
    if (b.parentId !== undefined && (b.parentId || null) !== (c.parentId || null)) { const chk = await checkCostCenterLinks(tdb, req, companyId, { parentId: b.parentId }, c.id); if (chk.error) return fail(res, chk.status || 400, chk.error); patch.parentId = b.parentId || null; }
    if (!Object.keys(patch).length) return res.json({ success: true, unchanged: true });
    await tdb.update(schema.costCenters).set(patch).where(and(eq(schema.costCenters.id, c.id), eq(schema.costCenters.companyId, companyId)));
    recordAuditLog(req, 'UPDATE_COST_CENTER', 'cost_center', c.id, { code: c.code, change: patch });
    res.json({ success: true });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

router.patch('/cost-centers/:id/toggle-active', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'dimensions.delete')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb(); const companyId = req.targetCompanyId;
    if (!ID_RE.test(String(req.params.id))) return fail(res, 404, 'Cost centre not found.');
    const [c] = await tdb.select().from(schema.costCenters).where(and(eq(schema.costCenters.id, String(req.params.id)), eq(schema.costCenters.companyId, companyId)));
    if (!c) return fail(res, 404, 'Cost centre not found.');
    if (c.isActive) {
      const [def] = await tdb.select({ id: schema.accountDimensionRules.id }).from(schema.accountDimensionRules).where(and(eq(schema.accountDimensionRules.companyId, companyId), eq(schema.accountDimensionRules.defaultCostCenterId, c.id)));
      if (def) return fail(res, 400, 'An account uses this cost centre as its default. Change that rule first.');
    } else if (c.parentId) {
      const [p] = await tdb.select().from(schema.costCenters).where(and(eq(schema.costCenters.id, c.parentId), eq(schema.costCenters.companyId, companyId)));
      if (p && !p.isActive) return fail(res, 400, 'Reactivate the parent cost centre first.');
    }
    await tdb.update(schema.costCenters).set({ isActive: !c.isActive }).where(and(eq(schema.costCenters.id, c.id), eq(schema.costCenters.companyId, companyId)));
    recordAuditLog(req, c.isActive ? 'DEACTIVATE_COST_CENTER' : 'REACTIVATE_COST_CENTER', 'cost_center', c.id, { code: c.code });
    res.json({ success: true, isActive: !c.isActive });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// ---------------- what the pickers and filters offer ----------------
// Active dimension types with their selectable entities (branches limited to the user's own), and the account rules, so a journal line knows which
// dimensions its account needs.
router.get('/dimension-options', withTenantDb, async (req: any, res) => {
  try {
    if (!canSeeTypes(req)) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb(); const companyId = req.targetCompanyId;
    await ensureSeeded(tdb, companyId);
    const types = (await loadTypes(tdb, companyId)).filter((t: any) => t.isActive);
    const out = [];
    for (const t of types) {
      let ents = (await entitiesOfType(tdb, companyId, t)).filter(e => e.isActive);
      if (t.linkedEntity === 'branches' && Array.isArray(req.allowedBranchIds)) ents = ents.filter(e => req.allowedBranchIds.includes(e.id));
      out.push({ id: t.id, code: t.code, name: t.name, nameAr: t.nameAr, valueSource: t.valueSource, linkedEntity: t.linkedEntity, isHierarchical: t.isHierarchical, entities: ents.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })) });
    }
    const rules = await tdb.select().from(schema.accountDimensionRules).where(eq(schema.accountDimensionRules.companyId, companyId));
    const map: Record<string, Record<string, { rule: string; defaultEntityId: string | null }>> = {};
    for (const r of rules) { (map[r.accountId] ||= {})[r.dimensionTypeId] = { rule: r.rule, defaultEntityId: r.defaultValueId || r.defaultBranchId || r.defaultCostCenterId || null }; }
    res.json({ types: out, rules: map });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// ---------------- account dimension rules (assigning dimensions to the chart of accounts) ----------------
router.get('/dimension-rules', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'accountDimensionRules.read') && !hasPermission(req.user, 'accountDimensionRules.update')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb(); const companyId = req.targetCompanyId;
    await ensureSeeded(tdb, companyId);
    const types = (await loadTypes(tdb, companyId)).filter((t: any) => t.isActive);
    const accounts = (await tdb.select().from(schema.companyAccounts).where(eq(schema.companyAccounts.companyId, companyId))).sort((a: any, b: any) => a.code.localeCompare(b.code, undefined, { numeric: true }));
    const rules = await tdb.select().from(schema.accountDimensionRules).where(eq(schema.accountDimensionRules.companyId, companyId));
    res.json({
      types: types.map((t: any) => ({ id: t.id, code: t.code, name: t.name, nameAr: t.nameAr, valueSource: t.valueSource, linkedEntity: t.linkedEntity })),
      accounts: accounts.map((a: any) => ({ id: a.id, code: a.code, name: a.name, nameAr: a.nameAr, type: a.type, parentId: a.parentId, isGroup: a.isGroup, isControl: a.isControl, isActive: a.isActive })),
      rules: rules.map((r: any) => ({ accountId: r.accountId, typeId: r.dimensionTypeId, rule: r.rule, defaultEntityId: r.defaultValueId || r.defaultBranchId || r.defaultCostCenterId || null })),
    });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// How many posted lines on these accounts do NOT carry a tag of the type (a new Required rule never rewrites them; this is shown so nobody is surprised).
async function untaggedLines(tdb: any, companyId: string, accountIds: string[], typeId: string): Promise<number> {
  if (!accountIds.length) return 0;
  const ids = sql.join(accountIds.map(i => sql`${i}::uuid`), sql`, `);
  const r: any = await tdb.execute(sql`SELECT COUNT(*)::int AS n FROM journal_lines l WHERE l.company_id = ${companyId}::uuid AND l.account_id IN (${ids})
    AND NOT EXISTS (SELECT 1 FROM dimension_combination_entries ce WHERE ce.combination_id = l.dimension_combination_id AND ce.dimension_type_id = ${typeId}::uuid)`);
  return Number(r.rows[0]?.n || 0);
}

async function setRule(tdb: any, companyId: string, account: any, type: any, rule: string | null, defaultEntityId: string | null) {
  const where = and(eq(schema.accountDimensionRules.companyId, companyId), eq(schema.accountDimensionRules.accountId, account.id), eq(schema.accountDimensionRules.dimensionTypeId, type.id));
  if (!rule) { await tdb.delete(schema.accountDimensionRules).where(where); return; }
  const cols = entityColumns(type, rule === 'not_allowed' ? null : defaultEntityId);
  const [existing] = await tdb.select({ id: schema.accountDimensionRules.id }).from(schema.accountDimensionRules).where(where);
  if (existing) await tdb.update(schema.accountDimensionRules).set({ rule, ...cols }).where(where);
  else await tdb.insert(schema.accountDimensionRules).values({ id: generateId(), companyId, accountId: account.id, dimensionTypeId: type.id, rule, ...cols });
}

async function checkRuleInput(tdb: any, companyId: string, body: any): Promise<{ type?: any; rule: string | null; defaultEntityId: string | null; error?: string }> {
  const rule = body?.rule === null || body?.rule === '' || body?.rule === undefined ? null : String(body.rule);
  if (rule !== null && !['optional', 'required', 'not_allowed'].includes(rule)) return { rule: null, defaultEntityId: null, error: 'Choose Optional, Required or Not allowed.' };
  const type = await loadType(tdb, companyId, String(body?.typeId || ''));
  if (!type) return { rule, defaultEntityId: null, error: 'Dimension not found.' };
  if (!type.isActive) return { type, rule, defaultEntityId: null, error: 'That dimension is inactive.' };
  const defaultEntityId = body?.defaultEntityId ? String(body.defaultEntityId) : null;
  if (defaultEntityId) {
    const ent = (await entitiesOfType(tdb, companyId, type)).find(e => e.id === defaultEntityId);
    if (!ent || !ent.isActive) return { type, rule, defaultEntityId, error: 'Choose an active value of this dimension as the default.' };
    if (rule === 'not_allowed') return { type, rule, defaultEntityId, error: 'A default makes no sense when the dimension is not allowed.' };
  }
  return { type, rule, defaultEntityId };
}

router.put('/dimension-rules', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'accountDimensionRules.update')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb(); const companyId = req.targetCompanyId;
    const input = await checkRuleInput(tdb, companyId, req.body);
    if (input.error) return fail(res, 400, input.error);
    const accountId = String(req.body?.accountId || '');
    const [account] = ID_RE.test(accountId) ? await tdb.select().from(schema.companyAccounts).where(and(eq(schema.companyAccounts.id, accountId), eq(schema.companyAccounts.companyId, companyId))) : [];
    if (!account) return fail(res, 404, 'Account not found.');
    if (account.isGroup) return fail(res, 400, 'A heading takes no postings; set the rule on the accounts under it (or use "apply to a group").');
    await setRule(tdb, companyId, account, input.type, input.rule, input.defaultEntityId);
    recordAuditLog(req, 'CHANGE_ACCOUNT_DIMENSION_RULE', 'company_account', account.id, { account: account.code, dimension: input.type.code, rule: input.rule, default: input.defaultEntityId });
    res.json({ success: true, untaggedPostedLines: input.rule === 'required' ? await untaggedLines(tdb, companyId, [account.id], input.type.id) : 0 });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// Apply one rule to many accounts at once: every account of a type, everything under a heading, a code range, or an explicit list.
router.post('/dimension-rules/bulk', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'accountDimensionRules.update')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb(); const companyId = req.targetCompanyId;
    const input = await checkRuleInput(tdb, companyId, req.body);
    if (input.error) return fail(res, 400, input.error);
    const sel = req.body?.selector || {};
    const accounts: any[] = await tdb.select().from(schema.companyAccounts).where(eq(schema.companyAccounts.companyId, companyId));
    let chosen: any[] = [];
    if (sel.kind === 'type') {
      if (!['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'].includes(String(sel.accountType))) return fail(res, 400, 'Choose an account type.');
      chosen = accounts.filter(a => a.type === sel.accountType);
    } else if (sel.kind === 'heading') {
      const root = accounts.find(a => a.id === String(sel.headingId));
      if (!root) return fail(res, 400, 'Choose a heading of your chart.');
      const set = new Set<string>(); const walk = (id: string) => { set.add(id); for (const a of accounts) if (a.parentId === id) walk(a.id); }; walk(root.id);
      chosen = accounts.filter(a => set.has(a.id));
    } else if (sel.kind === 'range') {
      const from = String(sel.from || ''), to = String(sel.to || '');
      if (!from || !to) return fail(res, 400, 'Enter both ends of the range.');
      const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
      chosen = accounts.filter(a => cmp(a.code, from) >= 0 && cmp(a.code, to) <= 0);
    } else if (sel.kind === 'accounts') {
      const ids = new Set<string>((Array.isArray(sel.accountIds) ? sel.accountIds : []).map(String));
      chosen = accounts.filter(a => ids.has(a.id));
      if (chosen.length !== ids.size) return fail(res, 400, 'One of the accounts does not exist in this company.');
    } else return fail(res, 400, 'Choose which accounts to apply this to.');
    chosen = chosen.filter(a => !a.isGroup);
    if (!chosen.length) return fail(res, 400, 'No postable accounts match.');
    const skipExisting = req.body?.skipExisting === true;
    const existing = await tdb.select().from(schema.accountDimensionRules).where(and(eq(schema.accountDimensionRules.companyId, companyId), eq(schema.accountDimensionRules.dimensionTypeId, input.type.id)));
    const have = new Set(existing.map((r: any) => r.accountId));
    const targets = skipExisting ? chosen.filter(a => !have.has(a.id)) : chosen;
    const untagged = input.rule === 'required' ? await untaggedLines(tdb, companyId, targets.map(a => a.id), input.type.id) : 0;
    if (req.body?.dryRun === true) return res.json({ success: true, dryRun: true, matched: chosen.length, wouldApply: targets.length, untaggedPostedLines: untagged });
    for (const a of targets) await setRule(tdb, companyId, a, input.type, input.rule, input.defaultEntityId);
    recordAuditLog(req, 'BULK_ACCOUNT_DIMENSION_RULE', 'dimension_type', input.type.id, { dimension: input.type.code, rule: input.rule, accounts: targets.length, selector: sel.kind });
    res.json({ success: true, applied: targets.length, skipped: chosen.length - targets.length, untaggedPostedLines: untagged });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

export default router;
