// Approval rules and the approval worklist (server/lib/approvals.ts). Every route runs in the request's tenant transaction; the company is always req.targetCompanyId.
import express from 'express';
import { and, asc, desc, eq } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { generateId } from '../../src/id.js';
import { withTenantDb, tenantDb } from '../lib/tenantDb.js';
import { hasPermission } from '../lib/authz.js';
import { recordAuditLog } from '../lib/audit.js';
import { nowDate } from '../lib/clock.js';
import { decideRequest, requestDetail, worklist, type ApprovalDocType } from '../lib/approvals.js';

const router = express.Router();
const fail = (res: any, status: number, error: string) => res.status(status).json({ error });
const bad = (message: string) => Object.assign(new Error(message), { status: 400 });
const ID = /^[0-9a-f-]{36}$/i;
const SUPPORTED: ApprovalDocType[] = ['VendorPayment', 'VendorBill']; // grows as executors are registered (bills, credit notes, journals)
const LEVEL_TYPES = ['Role', 'User', 'Permission', 'Manager'];

async function readRule(tx: any, companyId: string, r: any) {
  const levels: any[] = await tx.select().from(schema.approvalRuleLevels).where(and(eq(schema.approvalRuleLevels.companyId, companyId), eq(schema.approvalRuleLevels.ruleId, r.id))).orderBy(asc(schema.approvalRuleLevels.level));
  return { id: r.id, name: r.name, documentType: r.documentType, minAmount: Number(r.minAmount), maxAmount: r.maxAmount == null ? null : Number(r.maxAmount), priority: r.priority, isActive: r.isActive,
    levels: levels.map(l => ({ level: l.level, approverType: l.approverType, approverRef: l.approverRef, managerSteps: l.managerSteps })) };
}

// checks the body of a rule, and that every id it names belongs to this company
async function cleanRule(tx: any, companyId: string, b: any) {
  const name = String(b?.name || '').trim().slice(0, 120); if (!name) throw bad('Give the rule a name.');
  if (!SUPPORTED.includes(b.documentType)) throw bad('Approval rules are available for vendor payments and vendor bills at present.');
  const min = Number(b.minAmount ?? 0); const max = b.maxAmount === null || b.maxAmount === '' || b.maxAmount === undefined ? null : Number(b.maxAmount);
  if (!(min >= 0) || (max !== null && !(max > min))) throw bad('The amount band is not valid: the ceiling must be above the floor.');
  const levels = Array.isArray(b.levels) ? b.levels : []; if (!levels.length || levels.length > 5) throw bad('A rule needs one to five approval levels.');
  const out = levels.map((l: any, i: number) => ({ level: i + 1, approverType: String(l.approverType), approverRef: l.approverRef ? String(l.approverRef) : null, managerSteps: Math.min(5, Math.max(1, Number(l.managerSteps) || 1)) }));
  for (const l of out) {
    if (!LEVEL_TYPES.includes(l.approverType)) throw bad(`Level ${l.level}: choose who approves.`);
    if (l.approverType !== 'Manager' && !l.approverRef) throw bad(`Level ${l.level}: choose the role, user or permission.`);
    if (l.approverType === 'Role') { const [x] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(and(eq(schema.roles.id, l.approverRef as string), eq(schema.roles.companyId, companyId))); if (!x) throw bad(`Level ${l.level}: that role is not in this company.`); }
    if (l.approverType === 'User') { const [x] = await tx.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.id, l.approverRef as string), eq(schema.users.companyId, companyId))); if (!x) throw bad(`Level ${l.level}: that user is not in this company.`); }
    if (l.approverType === 'Manager') l.approverRef = null;
  }
  return { name, documentType: b.documentType as ApprovalDocType, min, max, priority: Math.min(9999, Math.max(1, Number(b.priority) || 100)), levels: out };
}

router.get('/rules', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'approvalRules.read')) return fail(res, 403, 'Forbidden');
    const tx = tenantDb(); const rules: any[] = await tx.select().from(schema.approvalRules).where(eq(schema.approvalRules.companyId, req.targetCompanyId)).orderBy(asc(schema.approvalRules.documentType), asc(schema.approvalRules.priority));
    res.json({ rules: await Promise.all(rules.map(r => readRule(tx, req.targetCompanyId, r))), supported: SUPPORTED });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

router.post('/rules', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'approvalRules.create')) return fail(res, 403, 'Forbidden');
    const tx = tenantDb(); const c = await cleanRule(tx, req.targetCompanyId, req.body); const id = generateId();
    await tx.insert(schema.approvalRules).values({ id, companyId: req.targetCompanyId, name: c.name, documentType: c.documentType, minAmount: String(c.min), maxAmount: c.max === null ? null : String(c.max), priority: c.priority, isActive: true, createdAt: nowDate(), createdById: req.user.id });
    await tx.insert(schema.approvalRuleLevels).values(c.levels.map((l: any) => ({ id: generateId(), companyId: req.targetCompanyId, ruleId: id, ...l })));
    recordAuditLog(req, 'CREATE_APPROVAL_RULE', 'approval_rule', id, { name: c.name, documentType: c.documentType, min: c.min, max: c.max, levels: c.levels.length });
    res.json({ success: true, id });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

router.put('/rules/:id', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'approvalRules.update')) return fail(res, 403, 'Forbidden');
    if (!ID.test(req.params.id)) return fail(res, 400, 'Invalid id.');
    const tx = tenantDb(); const [r] = await tx.select().from(schema.approvalRules).where(and(eq(schema.approvalRules.id, req.params.id), eq(schema.approvalRules.companyId, req.targetCompanyId)));
    if (!r) return fail(res, 404, 'Rule not found.');
    const c = await cleanRule(tx, req.targetCompanyId, { ...req.body, documentType: r.documentType });
    await tx.update(schema.approvalRules).set({ name: c.name, minAmount: String(c.min), maxAmount: c.max === null ? null : String(c.max), priority: c.priority }).where(eq(schema.approvalRules.id, r.id));
    await tx.delete(schema.approvalRuleLevels).where(and(eq(schema.approvalRuleLevels.companyId, req.targetCompanyId), eq(schema.approvalRuleLevels.ruleId, r.id)));
    await tx.insert(schema.approvalRuleLevels).values(c.levels.map((l: any) => ({ id: generateId(), companyId: req.targetCompanyId, ruleId: r.id, ...l })));
    recordAuditLog(req, 'UPDATE_APPROVAL_RULE', 'approval_rule', r.id, { name: c.name, min: c.min, max: c.max, levels: c.levels.length });
    res.json({ success: true });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// A rule is retired, never deleted (requests keep the snapshot they were submitted under).
router.patch('/rules/:id/toggle-active', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'approvalRules.delete')) return fail(res, 403, 'Forbidden');
    if (!ID.test(req.params.id)) return fail(res, 400, 'Invalid id.');
    const tx = tenantDb(); const [r] = await tx.select().from(schema.approvalRules).where(and(eq(schema.approvalRules.id, req.params.id), eq(schema.approvalRules.companyId, req.targetCompanyId)));
    if (!r) return fail(res, 404, 'Rule not found.');
    await tx.update(schema.approvalRules).set({ isActive: !r.isActive }).where(eq(schema.approvalRules.id, r.id));
    recordAuditLog(req, r.isActive ? 'DEACTIVATE_APPROVAL_RULE' : 'ACTIVATE_APPROVAL_RULE', 'approval_rule', r.id, {});
    res.json({ success: true, isActive: !r.isActive });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// What waits for the signed-in user, and what they submitted themselves.
router.get('/my', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'approvals.read')) return fail(res, 403, 'Forbidden');
    const tx = tenantDb(); const waiting = await worklist(tx, req.targetCompanyId, req.user);
    const mine: any[] = await tx.select().from(schema.approvalRequests).where(and(eq(schema.approvalRequests.companyId, req.targetCompanyId), eq(schema.approvalRequests.submittedById, req.user.id))).orderBy(desc(schema.approvalRequests.submittedAt)).limit(50);
    const shape = (r: any) => ({ id: r.id, documentType: r.documentType, amount: Number(r.amount), summary: r.summary, status: r.status, currentLevel: r.currentLevel, levels: (r.levels as any[]).length, submittedAt: r.submittedAt, selfApproved: r.selfApproved });
    res.json({ waiting: waiting.map(shape), count: waiting.length, mine: mine.map(shape) });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

router.get('/requests/:id', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'approvals.read')) return fail(res, 403, 'Forbidden');
    if (!ID.test(req.params.id)) return fail(res, 400, 'Invalid id.');
    res.json(await requestDetail(tenantDb(), req.targetCompanyId, req.params.id));
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

router.post('/requests/:id/decide', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'approvals.read')) return fail(res, 403, 'Forbidden');
    if (!ID.test(req.params.id)) return fail(res, 400, 'Invalid id.');
    const action = req.body?.action === 'Rejected' ? 'Rejected' : req.body?.action === 'Approved' ? 'Approved' : null; if (!action) return fail(res, 400, 'Choose approve or reject.');
    const r = await decideRequest(tenantDb(), req, req.params.id, action, req.body?.remarks);
    recordAuditLog(req, action === 'Approved' ? 'APPROVAL_APPROVED' : 'APPROVAL_REJECTED', 'approval_request', req.params.id, { remarks: String(req.body?.remarks || '').slice(0, 200), result: r.status });
    res.json({ success: true, ...r });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

export default router;
