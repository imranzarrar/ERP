// Bank reconciliation sessions (server/lib/bankReconciliation.ts, Blueprint FR-BANK-01..05). Every route runs inside the request's tenant transaction; the company is always
// req.targetCompanyId; every id a client names is checked to belong to it before it is used.
import express from 'express';
import { withTenantDb, tenantDb } from '../lib/tenantDb.js';
import { hasPermission } from '../lib/authz.js';
import { recordAuditLog } from '../lib/audit.js';
import { assertPostingAllowed } from '../lib/postingGuard.js';
import { and, eq } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { addStatementLines, clearLines, completeSession, createSession, deleteStatementLine, discardSession, listSessions, matchLine, postAdjustment, reopenSession, reverseAdjustment, sessionDetail, suggestions, unmatchLine, updateSession } from '../lib/bankReconciliation.js';

const router = express.Router();
const fail = (res: any, status: number, error: string) => res.status(status).json({ error });
const ID = /^[0-9a-f-]{36}$/i;
const can = (req: any, leaf: string) => hasPermission(req.user, `bankReconciliation.${leaf}`);
const guarded = (leaf: string, run: (req: any, res: any) => Promise<void>) => async (req: any, res: any) => {
  try {
    if (!can(req, leaf)) return fail(res, 403, 'Forbidden');
    await run(req, res);
  } catch (e: any) { fail(res, e.status || 500, e.message); }
};
const sid = (req: any) => { if (!ID.test(String(req.params.id))) throw Object.assign(new Error('Invalid id.'), { status: 400 }); return String(req.params.id); };

router.get('/', withTenantDb, guarded('read', async (req, res) => {
  const bankId = ID.test(String(req.query.bankId || '')) ? String(req.query.bankId) : null;
  res.json({ rows: await listSessions(tenantDb(), req.targetCompanyId, bankId) });
}));

// The accounts a bank fee / interest can be posted to: active, postable income and expense accounts (the picker of the "post as entry" dialog).
router.get('/adjustment-accounts', withTenantDb, guarded('adjust', async (req, res) => {
  const rows: any[] = await tenantDb().select({ id: schema.companyAccounts.id, code: schema.companyAccounts.code, name: schema.companyAccounts.name, nameAr: schema.companyAccounts.nameAr, type: schema.companyAccounts.type, isGroup: schema.companyAccounts.isGroup, isControl: schema.companyAccounts.isControl })
    .from(schema.companyAccounts).where(and(eq(schema.companyAccounts.companyId, req.targetCompanyId), eq(schema.companyAccounts.isActive, true)));
  res.json({ accounts: rows.filter(a => !a.isGroup && !a.isControl && (a.type === 'Expense' || a.type === 'Revenue')).sort((a, b) => a.code.localeCompare(b.code)).map(({ isGroup, isControl, ...a }) => a) });
}));

router.post('/', withTenantDb, guarded('create', async (req, res) => {
  const b = req.body || {};
  if (!ID.test(String(b.bankId || ''))) return fail(res, 400, 'Choose a bank or cash account.');
  const id = await createSession(tenantDb(), req, { bankId: String(b.bankId), statementDate: String(b.statementDate || ''), statementEndingBalance: Number(b.statementEndingBalance), notes: b.notes });
  recordAuditLog(req, 'BANK_RECONCILIATION_START', 'bank_reconciliation', id, { bankId: b.bankId, statementDate: b.statementDate, statementEndingBalance: Number(b.statementEndingBalance) });
  res.json({ success: true, id });
}));

router.get('/:id', withTenantDb, guarded('read', async (req, res) => { res.json(await sessionDetail(tenantDb(), req.targetCompanyId, sid(req))); }));

router.patch('/:id', withTenantDb, guarded('match', async (req, res) => {
  await updateSession(tenantDb(), req, sid(req), { statementDate: req.body?.statementDate, statementEndingBalance: req.body?.statementEndingBalance, notes: req.body?.notes });
  res.json({ success: true });
}));

router.post('/:id/clear', withTenantDb, guarded('match', async (req, res) => {
  const r = await clearLines(tenantDb(), req, sid(req), Array.isArray(req.body?.lineIds) ? req.body.lineIds : [], req.body?.clear !== false);
  res.json({ success: true, ...r });
}));

router.post('/:id/statement-lines', withTenantDb, guarded('match', async (req, res) => {
  const r = await addStatementLines(tenantDb(), req, sid(req), Array.isArray(req.body?.lines) ? req.body.lines : []);
  recordAuditLog(req, 'BANK_STATEMENT_LINES_ADDED', 'bank_reconciliation', sid(req), r);
  res.json({ success: true, ...r });
}));

router.delete('/:id/statement-lines/:lineId', withTenantDb, guarded('match', async (req, res) => {
  if (!ID.test(String(req.params.lineId))) return fail(res, 400, 'Invalid id.');
  await deleteStatementLine(tenantDb(), req, sid(req), String(req.params.lineId));
  res.json({ success: true });
}));

router.post('/:id/match', withTenantDb, guarded('match', async (req, res) => {
  const { statementLineId, journalLineId } = req.body || {};
  if (!ID.test(String(statementLineId || '')) || !ID.test(String(journalLineId || ''))) return fail(res, 400, 'Choose a statement line and a ledger line.');
  await matchLine(tenantDb(), req, sid(req), String(statementLineId), String(journalLineId));
  res.json({ success: true });
}));

router.post('/:id/unmatch', withTenantDb, guarded('match', async (req, res) => {
  if (!ID.test(String(req.body?.statementLineId || ''))) return fail(res, 400, 'Choose a statement line.');
  await unmatchLine(tenantDb(), req, sid(req), String(req.body.statementLineId));
  res.json({ success: true });
}));

router.get('/:id/suggestions', withTenantDb, guarded('match', async (req, res) => { res.json({ rows: await suggestions(tenantDb(), req.targetCompanyId, sid(req)) }); }));

// A bank fee / interest / correction: one entry against a chosen account, cleared in the session at once (and matched to its statement line when it came from one).
router.post('/:id/adjustment', withTenantDb, guarded('adjust', async (req, res) => {
  const b = req.body || {};
  if (!ID.test(String(b.accountId || ''))) return fail(res, 400, 'Choose the account the entry is posted against.');
  const d = await sessionDetail(tenantDb(), req.targetCompanyId, sid(req));
  let date = String(b.date || '').slice(0, 10);
  if (!date && ID.test(String(b.statementLineId || ''))) date = d.statementLines.find((x: any) => x.id === b.statementLineId)?.statementDate || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(res, 400, 'Enter the date of the entry.');
  await assertPostingAllowed(req, date, { vat: 'none' });
  const r = await postAdjustment(tenantDb(), req, sid(req), { statementLineId: ID.test(String(b.statementLineId || '')) ? String(b.statementLineId) : null, date, description: b.description, amount: Number(b.amount), accountId: String(b.accountId), dimensions: b.dimensions });
  recordAuditLog(req, 'BANK_RECONCILIATION_ADJUSTMENT', 'bank_reconciliation', sid(req), { ...r, date, accountId: b.accountId });
  res.json({ success: true, ...r });
}));

router.post('/:id/adjustments/:voucherId/reverse', withTenantDb, guarded('adjust', async (req, res) => {
  if (!ID.test(String(req.params.voucherId))) return fail(res, 400, 'Invalid id.');
  const d = await sessionDetail(tenantDb(), req.targetCompanyId, sid(req));
  await assertPostingAllowed(req, d.session.statementDate, { vat: 'none' });
  const reason = String(req.body?.reason ?? '').trim().slice(0, 200);
  const r = await reverseAdjustment(tenantDb(), req, sid(req), String(req.params.voucherId), reason);
  recordAuditLog(req, 'BANK_RECONCILIATION_ADJUSTMENT_REVERSED', 'bank_reconciliation', sid(req), { voucherId: req.params.voucherId, reason });
  res.json({ success: true, ...r });
}));

router.post('/:id/complete', withTenantDb, guarded('complete', async (req, res) => {
  const r = await completeSession(tenantDb(), req, sid(req));
  recordAuditLog(req, 'BANK_RECONCILIATION_COMPLETE', 'bank_reconciliation', sid(req), r);
  res.json({ success: true, ...r });
}));

// Reopening a completed reconciliation is the elevated action (FR-BANK-05): its own permission, a written reason, and an audit entry.
router.post('/:id/reopen', withTenantDb, guarded('reopen', async (req, res) => {
  const reason = String(req.body?.reason ?? '').trim();
  const r = await reopenSession(tenantDb(), req, sid(req), reason);
  recordAuditLog(req, 'BANK_RECONCILIATION_REOPEN', 'bank_reconciliation', sid(req), { reason: reason.slice(0, 300), ...r });
  res.json({ success: true });
}));

router.delete('/:id', withTenantDb, guarded('create', async (req, res) => {
  await discardSession(tenantDb(), req, sid(req));
  recordAuditLog(req, 'BANK_RECONCILIATION_DISCARD', 'bank_reconciliation', sid(req), {});
  res.json({ success: true });
}));

export default router;
