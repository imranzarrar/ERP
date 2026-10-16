// Approval engine (Blueprint FR-APR-01..06; design: docs/gl-ap-ar/s11-approval-rules-tier1-research.md). One engine for every document type:
//   submitForApproval  finds the active rule for (document type, amount); no rule = "post directly" (the caller goes on exactly as before); a rule = an approval REQUEST that holds the
//                      intent of the document, and NOTHING is posted (no voucher, no ledger entry, no bank movement);
//   decideRequest      one level at a time, by someone with that level's authority who is not the submitter (unless the company allows self-approval) and who has not already acted on
//                      the request; the last approval creates the document through its own executor inside the same transaction, after the posting guard has been run again.
// Executors are registered per document type; Sprint 11 registers VendorPayment, the next documents (bills, credit notes, journals) register theirs the same way.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { generateId } from '../../src/id.js';
import { nowDate } from './clock.js';
import { hasPermission, resolveUserPermissions } from './authz.js';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

export type ApprovalDocType = 'VendorPayment' | 'VendorBill' | 'CreditNote' | 'Journal';
export interface RuleLevel { level: number; approverType: 'Role' | 'User' | 'Permission' | 'Manager'; approverRef: string | null; managerSteps: number }
export interface ApprovalExecutor {
  // called by the last approval: creates the real document. `approverReq` carries the approver (for the posting guard), `submitterId` is recorded as the document's creator.
  execute(tx: any, approverReq: any, request: any): Promise<string | null>;
}
const executors = new Map<ApprovalDocType, ApprovalExecutor>();
export const registerApprovalExecutor = (t: ApprovalDocType, e: ApprovalExecutor) => { executors.set(t, e); };

export async function selfApprovalAllowed(tx: any, companyId: string): Promise<boolean> {
  const [c] = await tx.select({ v: schema.companies.journalSelfApproval }).from(schema.companies).where(eq(schema.companies.id, companyId));
  return !!c?.v;
}

// the first active rule whose band contains the amount (amount above min, up to and including max); lowest priority number first
export async function findRule(tx: any, companyId: string, documentType: ApprovalDocType, amount: number) {
  const rules: any[] = await tx.select().from(schema.approvalRules).where(and(eq(schema.approvalRules.companyId, companyId), eq(schema.approvalRules.documentType, documentType), eq(schema.approvalRules.isActive, true)))
    .orderBy(asc(schema.approvalRules.priority), asc(schema.approvalRules.createdAt));
  const hit = rules.find(r => amount > Number(r.minAmount) && (r.maxAmount == null || amount <= Number(r.maxAmount)));
  if (!hit) return null;
  const levels: any[] = await tx.select().from(schema.approvalRuleLevels).where(and(eq(schema.approvalRuleLevels.companyId, companyId), eq(schema.approvalRuleLevels.ruleId, hit.id))).orderBy(asc(schema.approvalRuleLevels.level));
  if (!levels.length) return null;
  return { rule: hit, levels: levels.map(l => ({ level: l.level, approverType: l.approverType, approverRef: l.approverRef, managerSteps: l.managerSteps })) as RuleLevel[] };
}

export async function submitForApproval(tx: any, req: any, input: { documentType: ApprovalDocType; amount: number; summary: string; payload: any }): Promise<{ pending: false } | { pending: true; requestId: string; levels: number }> {
  const amount = round2(input.amount);
  const hit = await findRule(tx, req.targetCompanyId, input.documentType, amount);
  if (!hit) return { pending: false };
  const id = generateId();
  await tx.insert(schema.approvalRequests).values({ id, companyId: req.targetCompanyId, documentType: input.documentType, amount: String(amount), summary: input.summary.slice(0, 200), payload: input.payload,
    ruleId: hit.rule.id, levels: hit.levels, currentLevel: 1, status: 'Pending', submittedById: req.user.id, submittedAt: nowDate() });
  return { pending: true, requestId: id, levels: hit.levels.length };
}

// The people above a user in the manager chain (1 = direct manager), stopping at a loop or a missing manager.
async function managerChain(tx: any, companyId: string, userId: string, steps: number): Promise<string[]> {
  const out: string[] = []; let cur = userId;
  for (let i = 0; i < steps; i++) {
    const [u] = await tx.select({ m: schema.users.managerId }).from(schema.users).where(and(eq(schema.users.id, cur), eq(schema.users.companyId, companyId)));
    if (!u?.m || out.includes(u.m) || u.m === userId) break; out.push(u.m); cur = u.m;
  }
  return out;
}

// Does this user hold the authority of this level for this request? Directly, or because the holder delegated it to them for a period that includes today.
async function holdsOwnAuthority(tx: any, companyId: string, user: any, level: RuleLevel, submitterId: string): Promise<boolean> {
  if (level.approverType === 'User') return level.approverRef === user.id;
  if (level.approverType === 'Permission') return !!level.approverRef && hasPermission(user, level.approverRef);
  if (level.approverType === 'Role') {
    if (!level.approverRef) return false;
    const rows: any[] = await tx.select({ r: schema.userRoles.roleId }).from(schema.userRoles).where(and(eq(schema.userRoles.userId, user.id), eq(schema.userRoles.roleId, level.approverRef)));
    return rows.length > 0;
  }
  return (await managerChain(tx, companyId, submitterId, Math.max(1, level.managerSteps))).includes(user.id);
}
export async function activeDelegators(tx: any, companyId: string, delegateId: string): Promise<string[]> {
  const today = nowDate().toISOString().slice(0, 10);
  const rows: any[] = await tx.select({ d: schema.approvalDelegations.delegatorId }).from(schema.approvalDelegations).where(and(eq(schema.approvalDelegations.companyId, companyId), eq(schema.approvalDelegations.delegateId, delegateId), eq(schema.approvalDelegations.isActive, true),
    sql`${schema.approvalDelegations.validFrom} <= ${today}::date AND ${schema.approvalDelegations.validTo} >= ${today}::date`));
  return rows.map(r => r.d);
}
async function delegatorUser(tx: any, companyId: string, id: string): Promise<any | null> {
  const [u]: any[] = await tx.select().from(schema.users).where(and(eq(schema.users.id, id), eq(schema.users.companyId, companyId)));
  if (!u || u.isDeleted || u.isActive === false) return null;
  return { id: u.id, role: u.role, isSuperAdmin: u.isSuperAdmin, permissions: await resolveUserPermissions(u.id) };
}
// returns null (no authority), 'self' or the id of the delegator the user acts for
export async function levelAuthority(tx: any, companyId: string, user: any, level: RuleLevel, submitterId: string): Promise<null | 'self' | string> {
  if (await holdsOwnAuthority(tx, companyId, user, level, submitterId)) return 'self';
  for (const d of await activeDelegators(tx, companyId, user.id)) {
    // a level that names a permission is judged against the delegator's own permissions, so the delegate acts exactly as they could
    const who = level.approverType === 'Permission' ? await delegatorUser(tx, companyId, d) : { id: d };
    if (who && await holdsOwnAuthority(tx, companyId, who, level, submitterId)) return d;
  }
  return null;
}
export async function holdsLevelAuthority(tx: any, companyId: string, user: any, level: RuleLevel, submitterId: string): Promise<boolean> {
  return (await levelAuthority(tx, companyId, user, level, submitterId)) !== null;
}

// requests this user may decide right now (current level authority, not already acted, and not their own unless allowed)
export async function worklist(tx: any, companyId: string, user: any) {
  const pending: any[] = await tx.select().from(schema.approvalRequests).where(and(eq(schema.approvalRequests.companyId, companyId), eq(schema.approvalRequests.status, 'Pending'))).orderBy(asc(schema.approvalRequests.submittedAt));
  const self = await selfApprovalAllowed(tx, companyId);
  const out: any[] = [];
  for (const r of pending) {
    const lv = (r.levels as RuleLevel[]).find(l => l.level === r.currentLevel); if (!lv) continue;
    if (r.submittedById === user.id && !self) continue;
    if (!(await holdsLevelAuthority(tx, companyId, user, lv, r.submittedById))) continue;
    const acted: any[] = await tx.select({ id: schema.approvalActions.id }).from(schema.approvalActions).where(and(eq(schema.approvalActions.companyId, companyId), eq(schema.approvalActions.requestId, r.id), eq(schema.approvalActions.actorId, user.id)));
    if (acted.length) continue;
    out.push(r);
  }
  return out;
}

export async function decideRequest(tx: any, req: any, requestId: string, action: 'Approved' | 'Rejected', remarks: string) {
  const companyId = req.targetCompanyId;
  const [r] = await tx.select().from(schema.approvalRequests).where(and(eq(schema.approvalRequests.id, requestId), eq(schema.approvalRequests.companyId, companyId))).for('update');
  if (!r) throw fail(404, 'Approval request not found.');
  if (r.status !== 'Pending') throw fail(400, `This request is already ${r.status.toLowerCase()}.`);
  const levels = r.levels as RuleLevel[]; const lv = levels.find(l => l.level === r.currentLevel);
  if (!lv) throw fail(500, 'The request has no current level.');
  const self = r.submittedById === req.user.id;
  const selfOk = self && await selfApprovalAllowed(tx, companyId);
  if (self && !selfOk) throw fail(403, 'You submitted this document, so someone else must decide it.');
  const authority = await levelAuthority(tx, companyId, req.user, lv, r.submittedById);
  if (authority === null && !selfOk) throw fail(403, 'You do not hold the authority of this approval level.');
  const onBehalf = authority && authority !== 'self' ? authority : null;
  if (onBehalf && onBehalf === r.submittedById && !(await selfApprovalAllowed(tx, companyId))) throw fail(403, 'The person you act for submitted this document, so someone else must decide it.');
  const earlier: any[] = await tx.select({ id: schema.approvalActions.id }).from(schema.approvalActions).where(and(eq(schema.approvalActions.companyId, companyId), eq(schema.approvalActions.requestId, r.id), eq(schema.approvalActions.actorId, req.user.id)));
  if (earlier.length && !selfOk) throw fail(403, 'You already acted on an earlier level of this request; a different person must decide this level.');
  const note = String(remarks || '').trim().slice(0, 300);
  if (action === 'Rejected' && !note) throw fail(400, 'Write the reason for rejecting.');
  await tx.insert(schema.approvalActions).values({ id: generateId(), companyId, requestId: r.id, level: r.currentLevel, actorId: req.user.id, onBehalfOfId: onBehalf, action, remarks: note || null, createdAt: nowDate() });
  if (action === 'Rejected') {
    await tx.update(schema.approvalRequests).set({ status: 'Rejected', decidedAt: nowDate() }).where(eq(schema.approvalRequests.id, r.id));
    return { status: 'Rejected' as const, documentId: null };
  }
  if (self) await tx.update(schema.approvalRequests).set({ selfApproved: true }).where(eq(schema.approvalRequests.id, r.id));
  if (r.currentLevel < Math.max(...levels.map(l => l.level))) {
    await tx.update(schema.approvalRequests).set({ currentLevel: r.currentLevel + 1 }).where(eq(schema.approvalRequests.id, r.id));
    return { status: 'Pending' as const, documentId: null, nextLevel: r.currentLevel + 1 };
  }
  const exec = executors.get(r.documentType);
  if (!exec) throw fail(500, `No executor is registered for ${r.documentType}.`);
  const documentId = await exec.execute(tx, req, r);   // posts (the posting guard runs again inside); any refusal rolls the whole decision back
  await tx.update(schema.approvalRequests).set({ status: 'Approved', decidedAt: nowDate(), resultDocumentId: documentId }).where(eq(schema.approvalRequests.id, r.id));
  return { status: 'Approved' as const, documentId };
}

// The submitter withdraws a request that is still pending (to correct and resubmit it). Nothing was posted, so nothing is undone; the history keeps the recall.
export async function recallRequest(tx: any, req: any, requestId: string, remarks: string) {
  const companyId = req.targetCompanyId;
  const [r] = await tx.select().from(schema.approvalRequests).where(and(eq(schema.approvalRequests.id, requestId), eq(schema.approvalRequests.companyId, companyId))).for('update');
  if (!r) throw fail(404, 'Approval request not found.');
  if (r.submittedById !== req.user.id) throw fail(403, 'Only the person who submitted it can recall it.');
  if (r.status !== 'Pending') throw fail(400, `This request is already ${r.status.toLowerCase()}.`);
  await tx.insert(schema.approvalActions).values({ id: generateId(), companyId, requestId: r.id, level: r.currentLevel, actorId: req.user.id, action: 'Recalled', remarks: String(remarks || '').trim().slice(0, 300) || null, createdAt: nowDate() });
  await tx.update(schema.approvalRequests).set({ status: 'Recalled', decidedAt: nowDate() }).where(eq(schema.approvalRequests.id, r.id));
}

export async function requestDetail(tx: any, companyId: string, id: string) {
  const [r] = await tx.select().from(schema.approvalRequests).where(and(eq(schema.approvalRequests.id, id), eq(schema.approvalRequests.companyId, companyId)));
  if (!r) throw fail(404, 'Approval request not found.');
  const actions: any[] = await tx.select().from(schema.approvalActions).where(and(eq(schema.approvalActions.companyId, companyId), eq(schema.approvalActions.requestId, id))).orderBy(asc(schema.approvalActions.createdAt));
  const ids = [...new Set([r.submittedById, ...actions.map(a => a.actorId), ...actions.map(a => a.onBehalfOfId).filter(Boolean)])] as string[];
  const users: any[] = await tx.select({ id: schema.users.id, username: schema.users.username }).from(schema.users).where(inArray(schema.users.id, ids));
  const name = new Map<string, string>(users.map(u => [u.id, u.username]));
  return { ...r, amount: Number(r.amount), submittedByName: name.get(r.submittedById) || '', actions: actions.map(a => ({ level: a.level, action: a.action, remarks: a.remarks, at: a.createdAt, by: name.get(a.actorId) || '', onBehalfOf: a.onBehalfOfId ? name.get(a.onBehalfOfId) || '' : '' })) };
}
void sql;
