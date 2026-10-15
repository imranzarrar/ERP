// General Ledger Step 1: the journal listing, a posted entry's detail, and manual journals with maker-checker approval.
//
// A manual journal moves Draft -> Pending approval -> Posted (a rejection sends it back for correction, a draft can be discarded). Only an approval
// writes to the ledger, through the same postJournalEntry() every document uses. The preparer cannot approve their own journal unless the company
// owner has switched that on (companies.journal_self_approval, then flagged on the journal). Every step is written to the journal's own trail and the
// audit log. Nothing here ever edits or erases a posted entry: a mistake is corrected by a reversal, which is itself a journal that needs approval.
// Every route runs on the restricted tenant connection (withTenantDb), and every account / branch a client names is checked against this company.
import express from 'express';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { generateId } from '../../src/id.js';
import { withTenantDb, tenantDb } from '../lib/tenantDb.js';
import { hasPermission, isAdminUser, branchAccessOk } from '../lib/authz.js';
import { recordAuditLog } from '../lib/audit.js';
import { nowDate, todayStr } from '../lib/clock.js';
import { postJournalEntry } from '../lib/ledger.js';
import { getAndIncrementDocumentNumber } from '../lib/documentNumbering.js';
import { validateTransactionDate, assertQuarterNotFiled, assertQuarterNotFrozen } from '../lib/businessLogic.js';
import { branchIdsFor, dimFilterSql, round2, uuidArray } from '../lib/ledgerQueries.js';
import { applyRules, entitiesOfType, loadRules, loadTypes, parseDimFilters, resolveCombination, tagsOfCombinations, type Tags } from '../lib/dimensions.js';
import { documentDates } from '../lib/documentDates.js';
import { assertPostingAllowed } from '../lib/postingGuard.js';
import { postedEntry } from '../lib/postingPrint.js';

const router = express.Router();
const fail = (res: any, status: number, error: string) => res.status(status).json({ error });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LINES = 200;
const VAT_ROLES = ['VAT_INPUT', 'VAT_OUTPUT', 'VAT_PAYABLE'];

const canSee = (req: any) => hasPermission(req.user, 'journals.read') || hasPermission(req.user, 'journals.create') || hasPermission(req.user, 'journals.post');

interface LineIn { accountId: string; debit: number; credit: number; note: string | null; tags: Tags }

// Validates the lines a client sent: shape, one side per line, and that every account is this company's own, active, a posting account (not a
// heading) and not a control / bank account (those only move through the documents that own them).
async function checkLines(tdb: any, companyId: string, raw: any, requireBalanced: boolean, allowInactive = false): Promise<{ lines: LineIn[]; totalDebit: number; totalCredit: number; accounts: Map<string, any>; error?: string }> {
  const empty = { lines: [] as LineIn[], totalDebit: 0, totalCredit: 0, accounts: new Map<string, any>() };
  if (!Array.isArray(raw)) return { ...empty, error: 'Lines are required.' };
  if (raw.length > MAX_LINES) return { ...empty, error: `A journal can have at most ${MAX_LINES} lines.` };
  const lines: LineIn[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] || {};
    const debit = round2(Number(r.debit) || 0), credit = round2(Number(r.credit) || 0);
    if (!r.accountId || typeof r.accountId !== 'string') return { ...empty, error: `Line ${i + 1}: choose an account.` };
    if (debit < 0 || credit < 0) return { ...empty, error: `Line ${i + 1}: amounts cannot be negative.` };
    if ((debit > 0) === (credit > 0)) return { ...empty, error: `Line ${i + 1}: enter either a debit or a credit amount, not both and not neither.` };
    if (debit > 999999999999 || credit > 999999999999) return { ...empty, error: `Line ${i + 1}: amount is too large.` };
    const note = String(r.note ?? '').trim().slice(0, 300) || null;
    const tags: Tags = {};
    if (r.dimensions && typeof r.dimensions === 'object') for (const [k, v] of Object.entries(r.dimensions)) if (typeof v === 'string' && v) tags[k] = v;
    lines.push({ accountId: r.accountId, debit, credit, note, tags });
  }
  const ids = [...new Set(lines.map(l => l.accountId))];
  const accounts = new Map<string, any>();
  if (ids.length) {
    const rows = await tdb.select().from(schema.companyAccounts).where(and(eq(schema.companyAccounts.companyId, companyId), inArray(schema.companyAccounts.id, ids)));
    for (const a of rows) accounts.set(a.id, a);
  }
  for (let i = 0; i < lines.length; i++) {
    const a = accounts.get(lines[i].accountId);
    if (!a) return { ...empty, error: `Line ${i + 1}: that account does not exist in this company.` };
    if (!a.isActive && !allowInactive) return { ...empty, error: `Line ${i + 1}: account ${a.code} ${a.name} is inactive.` };
    if (a.isGroup) return { ...empty, error: `Line ${i + 1}: account ${a.code} ${a.name} is a heading; post to one of the accounts under it.` };
    if (a.bankId) return { ...empty, error: `Line ${i + 1}: ${a.code} ${a.name} is a bank / cash account; its movements come from receipts, payments and transfers.` };
    if (a.isControl) return { ...empty, error: `Line ${i + 1}: ${a.code} ${a.name} is a control account (customers, suppliers, stock, VAT); it is posted only by the documents that own it.` };
  }
  const totalDebit = round2(lines.reduce((s, l) => s + l.debit, 0));
  const totalCredit = round2(lines.reduce((s, l) => s + l.credit, 0));
  if (requireBalanced) {
    if (lines.length < 2) return { ...empty, error: 'A journal needs at least two lines.' };
    if (totalDebit <= 0) return { ...empty, error: 'The journal has no amounts.' };
    if (Math.abs(totalDebit - totalCredit) > 0.0001) return { ...empty, error: `The journal does not balance: debits ${totalDebit.toFixed(2)} vs credits ${totalCredit.toFixed(2)}.` };
  }
  return { lines, totalDebit, totalCredit, accounts };
}

// The period rules every posting date obeys: an open fiscal month, and (for a journal touching VAT) a VAT quarter that is not frozen.
async function checkPeriod(req: any, date: string, touchesVat: boolean, reason?: string | null) {
  await assertPostingAllowed(req, date, { vat: touchesVat ? 'frozen' : 'filed', reason: reason ?? '' });
}

// Resolves each line's dimension tags to a combination, through the account rules. A tag on a Not-allowed dimension is always an error; a Required tag that
// is missing is an error only when the journal is being submitted or approved (a draft may be saved incomplete). Defaults fill the gaps.
async function lineCombinations(tdb: any, req: any, companyId: string, lines: LineIn[], mode: 'draft' | 'strict'): Promise<(string | null)[]> {
  const rules = await loadRules(tdb, companyId, lines.map(l => l.accountId));
  const nameOf = new Map<string, string>((await loadTypes(tdb, companyId)).map((t: any) => [t.id, t.name]));
  const out: (string | null)[] = [];
  for (let i = 0; i < lines.length; i++) {
    const r = rules.get(lines[i].accountId);
    try {
      for (const [typeId, info] of r || []) if (info.rule === 'not_allowed' && lines[i].tags[typeId]) throw Object.assign(new Error(`${nameOf.get(typeId) || 'This dimension'} is not allowed on this account.`), { status: 400 });
      const tags = applyRules(r, lines[i].tags, mode === 'strict' ? 'strict' : 'defaults', { type: id => nameOf.get(id) || 'Dimension' });
      out.push(await resolveCombination(tdb, companyId, tags, { allowedBranchIds: req.allowedBranchIds }));
    } catch (e: any) { throw Object.assign(new Error(`Line ${i + 1}: ${e.message}`), { status: e.status || 400 }); }
  }
  return out;
}
// The stored lines of a journal, as rows carrying their tags (so the same rules can be re-applied at submit and at approval).
async function storedLines(tdb: any, companyId: string, rows: any[]) {
  const tags = await tagsOfCombinations(tdb, companyId, rows.map(l => l.dimensionCombinationId).filter(Boolean));
  return rows.map(l => ({ accountId: l.accountId, debit: Number(l.debit), credit: Number(l.credit), note: l.note, dimensions: l.dimensionCombinationId ? tags.get(l.dimensionCombinationId) || {} : {} }));
}

async function loadJournal(tdb: any, companyId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const [j] = await tdb.select().from(schema.manualJournals).where(and(eq(schema.manualJournals.id, id), eq(schema.manualJournals.companyId, companyId)));
  return j;
}
async function addEvent(tdb: any, req: any, journalId: string, action: string, note: string | null = null) {
  await tdb.insert(schema.manualJournalEvents).values({ id: generateId(), journalId, companyId: req.targetCompanyId, action, userId: req.user.id, note, createdAt: nowDate() });
}
async function selfApprovalOn(tdb: any, companyId: string) {
  const [c] = await tdb.select({ v: schema.companies.journalSelfApproval }).from(schema.companies).where(eq(schema.companies.id, companyId));
  return !!c?.v;
}
const branchVisible = (req: any, branchId: string | null) => branchAccessOk(req, branchId);

async function resolveBranch(tdb: any, req: any, requested: any): Promise<{ branchId: string | null; error?: string; status?: number }> {
  const branchId = requested || req.primaryBranchId || null;
  if (!branchId) return { branchId: null };
  const [b] = await tdb.select({ id: schema.branches.id }).from(schema.branches).where(and(eq(schema.branches.id, String(branchId)), eq(schema.branches.companyId, req.targetCompanyId)));
  if (!b) return { branchId: null, error: 'Invalid branch.', status: 400 };
  if (!branchAccessOk(req, b.id)) return { branchId: null, error: 'Forbidden: you are not assigned to this branch.', status: 403 };
  return { branchId: b.id };
}

// Everything the screens need to show one manual journal.
async function journalDetail(tdb: any, req: any, j: any) {
  const companyId = req.targetCompanyId;
  const lines = await tdb.select().from(schema.manualJournalLines).where(and(eq(schema.manualJournalLines.journalId, j.id), eq(schema.manualJournalLines.companyId, companyId))).orderBy(asc(schema.manualJournalLines.sortOrder));
  const accountIds = [...new Set(lines.map((l: any) => l.accountId))] as string[];
  const accts = accountIds.length ? await tdb.select().from(schema.companyAccounts).where(and(eq(schema.companyAccounts.companyId, companyId), inArray(schema.companyAccounts.id, accountIds))) : [];
  const aMap = new Map<string, any>(accts.map((a: any) => [a.id, a]));
  const events = await tdb.select().from(schema.manualJournalEvents).where(and(eq(schema.manualJournalEvents.journalId, j.id), eq(schema.manualJournalEvents.companyId, companyId))).orderBy(asc(schema.manualJournalEvents.createdAt));
  const userIds = [...new Set([j.preparedById, j.decidedById, ...events.map((e: any) => e.userId)].filter(Boolean))] as string[];
  const users = userIds.length ? await tdb.select({ id: schema.users.id, username: schema.users.username }).from(schema.users).where(inArray(schema.users.id, userIds)) : [];
  const uMap = new Map<string, string>(users.map((u: any) => [u.id, u.username]));
  const relIds = [j.reversalOfId, j.reversedById].filter(Boolean) as string[];
  const rel = relIds.length ? await tdb.select({ id: schema.manualJournals.id, number: schema.manualJournals.number, status: schema.manualJournals.status }).from(schema.manualJournals).where(and(eq(schema.manualJournals.companyId, companyId), inArray(schema.manualJournals.id, relIds))) : [];
  const rMap = new Map<string, any>(rel.map((r: any) => [r.id, r]));
  const comboTags = await tagsOfCombinations(tdb, companyId, lines.map((l: any) => l.dimensionCombinationId).filter(Boolean));
  const dimTypes = await loadTypes(tdb, companyId);
  const entityName = new Map<string, string>();
  for (const t of dimTypes) for (const e of await entitiesOfType(tdb, companyId, t)) entityName.set(e.id, e.name);
  const selfApproval = await selfApprovalOn(tdb, companyId);
  return {
    ...j,
    preparedByName: uMap.get(j.preparedById) || null,
    decidedByName: j.decidedById ? uMap.get(j.decidedById) || null : null,
    lines: lines.map((l: any) => { const a = aMap.get(l.accountId); return { id: l.id, accountId: l.accountId, accountCode: a?.code || '', accountName: a?.name || '', accountNameAr: a?.nameAr || null, debit: Number(l.debit), credit: Number(l.credit), note: l.note, dimensions: comboTags.get(l.dimensionCombinationId) || {}, dimensionLabels: Object.entries(comboTags.get(l.dimensionCombinationId) || {}).map(([typeId, entityId]) => ({ typeId, typeName: dimTypes.find((t: any) => t.id === typeId)?.name || '', entityId, name: entityName.get(entityId as string) || '' })) }; }),
    totalDebit: round2(lines.reduce((s: number, l: any) => s + Number(l.debit), 0)),
    totalCredit: round2(lines.reduce((s: number, l: any) => s + Number(l.credit), 0)),
    events: events.map((e: any) => ({ id: e.id, action: e.action, userName: uMap.get(e.userId) || '', note: e.note, createdAt: e.createdAt })),
    reversalOf: j.reversalOfId ? rMap.get(j.reversalOfId) || null : null,
    reversedBy: j.reversedById ? rMap.get(j.reversedById) || null : null,
    isOwn: j.preparedById === req.user.id,
    selfApprovalOn: selfApproval,
  };
}

// ---- company setting: may a preparer approve their own journals? (owner / admin only) ----
router.get('/journal-settings', withTenantDb, async (req: any, res) => {
  try {
    if (!canSee(req)) return fail(res, 403, 'Forbidden');
    res.json({ selfApproval: await selfApprovalOn(tenantDb(), req.targetCompanyId), canChange: isAdminUser(req.user) });
  } catch (e: any) { fail(res, 500, e.message); }
});
router.put('/journal-settings', withTenantDb, async (req: any, res) => {
  try {
    if (!isAdminUser(req.user)) return fail(res, 403, 'Only the company owner / administrator can change this setting.');
    const on = req.body?.selfApproval === true;
    await tenantDb().update(schema.companies).set({ journalSelfApproval: on }).where(eq(schema.companies.id, req.targetCompanyId));
    recordAuditLog(req, 'UPDATE_JOURNAL_SETTING', 'company', req.targetCompanyId, { selfApproval: on });
    res.json({ success: true, selfApproval: on });
  } catch (e: any) { fail(res, 500, e.message); }
});

// ---- listing: posted ledger entries and manual journals together, newest first ----
router.get('/journals', withTenantDb, async (req: any, res) => {
  try {
    if (!canSee(req)) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb();
    const companyId = req.targetCompanyId;
    const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(req.query.pageSize) || 25)));
    const q = String(req.query.q || '').trim().slice(0, 100);
    const status = String(req.query.status || 'all');
    const source = String(req.query.source || 'all');
    const from = DATE_RE.test(String(req.query.from || '')) ? String(req.query.from) : '';
    const to = DATE_RE.test(String(req.query.to || '')) ? String(req.query.to) : '';
    const accountId = /^[0-9a-f-]{36}$/i.test(String(req.query.accountId || '')) ? String(req.query.accountId) : '';
    const mineOnly = req.query.mine === '1';
    const branchIds = branchIdsFor(req);
    const dimFilters = await parseDimFilters(tdb, companyId, req.query.dims);
    const where: any[] = [sql`TRUE`];
    if (q) { const like = `%${q.replace(/[\\%_]/g, m => '\\' + m)}%`; where.push(sql`(i.number ILIKE ${like} OR i.description ILIKE ${like} OR i.source ILIKE ${like} OR COALESCE(i.reference,'') ILIKE ${like})`); }
    if (status !== 'all') where.push(sql`i.status = ${status}`);
    if (source === 'manual') where.push(sql`i.kind = 'manual'`);
    else if (source === 'opening') where.push(sql`i.source = 'Opening'`);
    else if (source === 'documents') where.push(sql`i.kind = 'entry' AND i.source <> 'Opening'`);
    if (from) where.push(sql`i.posting_date >= ${from}`);
    if (to) where.push(sql`i.posting_date <= ${to}`);
    if (mineOnly) where.push(sql`i.user_id = ${req.user.id}::uuid`);
    if (accountId) where.push(sql`(CASE WHEN i.kind = 'entry' THEN EXISTS (SELECT 1 FROM journal_lines l WHERE l.journal_entry_id = i.id::uuid AND l.company_id = ${companyId}::uuid AND l.account_id = ${accountId}::uuid)
      ELSE EXISTS (SELECT 1 FROM manual_journal_lines ml WHERE ml.journal_id = i.id::uuid AND ml.company_id = ${companyId}::uuid AND ml.account_id = ${accountId}::uuid) END)`);
    for (const f of dimFilters) {
      where.push(sql`(CASE WHEN i.kind = 'entry' THEN EXISTS (SELECT 1 FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id WHERE l.journal_entry_id = i.id::uuid AND l.company_id = ${companyId}::uuid${dimFilterSql(f, 'l', 'e.branch_id')})
        ELSE EXISTS (SELECT 1 FROM manual_journal_lines ml WHERE ml.journal_id = i.id::uuid AND ml.company_id = ${companyId}::uuid${dimFilterSql(f, 'ml', 'i.branch_id')}) END)`);
    }
    if (branchIds) where.push(sql`i.branch_id = ANY(${uuidArray(branchIds)})`);
    const items = sql`(
      WITH ranked AS (
        SELECT e.id, e.posting_date, e.doc_date, e.reference_type, e.description, e.branch_id, e.created_at, e.created_by_id,
               ROW_NUMBER() OVER (ORDER BY e.created_at, e.id) AS rn
        FROM journal_entries e WHERE e.company_id = ${companyId}::uuid AND e.reference_type <> 'Manual'
      )
      SELECT 'entry'::text AS kind, r.id::text AS id, 'JE-' || LPAD(r.rn::text, 5, '0') AS number, r.posting_date, r.doc_date, r.description, r.reference_type AS source,
             'Posted'::text AS status, r.branch_id, NULL::text AS reference,
             (SELECT COALESCE(SUM(l.debit),0) FROM journal_lines l WHERE l.journal_entry_id = r.id AND l.company_id = ${companyId}::uuid)::float8 AS amount,
             r.created_by_id AS user_id, r.created_at AS at
      FROM ranked r
      UNION ALL
      SELECT 'manual'::text, mj.id::text, mj.number, mj.posting_date, mj.doc_date, mj.description, 'Manual'::text, mj.status, mj.branch_id, mj.reference,
             (SELECT COALESCE(SUM(ml.debit),0) FROM manual_journal_lines ml WHERE ml.journal_id = mj.id AND ml.company_id = ${companyId}::uuid)::float8,
             mj.prepared_by_id, mj.prepared_at
      FROM manual_journals mj WHERE mj.company_id = ${companyId}::uuid
    ) i`;
    const whereSql = sql.join(where, sql` AND `);
    const total: any = await tdb.execute(sql`SELECT COUNT(*)::int AS n FROM ${items} WHERE ${whereSql}`);
    const rows: any = await tdb.execute(sql`
      SELECT i.kind, i.id, i.number, i.posting_date AS "postingDate", i.doc_date AS "docDate", i.description, i.source, i.status, i.branch_id AS "branchId", i.reference, i.amount, i.user_id AS "userId", u.username AS "userName", i.at
      FROM ${items} LEFT JOIN users u ON u.id = i.user_id
      WHERE ${whereSql}
      ORDER BY i.posting_date DESC, i.at DESC, i.id DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
    const counts: any = await tdb.execute(sql`SELECT status, COUNT(*)::int AS n FROM manual_journals WHERE company_id = ${companyId}::uuid${branchIds ? sql` AND branch_id = ANY(${uuidArray(branchIds)})` : sql``} GROUP BY status`);
    const byStatus: Record<string, number> = {};
    for (const c of counts.rows) byStatus[c.status] = Number(c.n);
    res.json({ rows: rows.rows, total: Number(total.rows[0].n), page, pageSize, manualCounts: byStatus });
  } catch (e: any) { fail(res, 500, e.message); }
});

// ---- a posted ledger entry (from a document, a manual journal or an opening balance) ----
router.get('/journals/entries/:id', withTenantDb, async (req: any, res) => {
  try {
    if (!canSee(req)) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb();
    const companyId = req.targetCompanyId;
    const id = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(id)) return fail(res, 404, 'Entry not found.');
    const [e] = await tdb.select().from(schema.journalEntries).where(and(eq(schema.journalEntries.id, id), eq(schema.journalEntries.companyId, companyId)));
    if (!e || !branchVisible(req, e.branchId)) return fail(res, 404, 'Entry not found.');
    const lines = await tdb.select().from(schema.journalLines).where(and(eq(schema.journalLines.journalEntryId, id), eq(schema.journalLines.companyId, companyId)));
    const accts = await tdb.select().from(schema.companyAccounts).where(eq(schema.companyAccounts.companyId, companyId));
    const byId = new Map<string, any>(accts.map((a: any) => [a.id, a]));
    const byKey = new Map<string, any>(accts.filter((a: any) => a.systemKey).map((a: any) => [a.systemKey, a]));
    const byBank = new Map<string, any>(accts.filter((a: any) => a.bankId).map((a: any) => [a.bankId, a]));
    const outLines = lines.map((l: any) => {
      const a = (l.accountId && byId.get(l.accountId)) || (l.accountKey === 'BANK' && l.bankId && byBank.get(l.bankId)) || (l.accountKey && byKey.get(l.accountKey)) || null;
      return { id: l.id, accountId: a?.id || null, accountCode: a?.code || '', accountName: a?.name || l.accountKey || '', accountNameAr: a?.nameAr || null, debit: Number(l.debit), credit: Number(l.credit) };
    });
    const [creator] = await tdb.select({ username: schema.users.username }).from(schema.users).where(eq(schema.users.id, e.createdById));
    // The business document this entry came from, when it is one we can name.
    let documentNumber: string | null = null;
    try {
      if (e.referenceType === 'Invoice' || e.referenceType === 'CreditNote') {
        const [d] = await tdb.select({ n: schema.invoices.invoiceNumber }).from(schema.invoices).where(and(eq(schema.invoices.id, e.referenceId), eq(schema.invoices.companyId, companyId)));
        documentNumber = d?.n || null;
      } else if (e.referenceType === 'Expense') {
        const [d] = await tdb.select({ n: schema.expenses.expenseNumber }).from(schema.expenses).where(and(eq(schema.expenses.id, e.referenceId), eq(schema.expenses.companyId, companyId)));
        documentNumber = d?.n || null;
      } else if (e.referenceType === 'PurchaseBill') {
        const [d] = await tdb.select({ n: schema.purchaseBills.billNumber }).from(schema.purchaseBills).where(and(eq(schema.purchaseBills.id, e.referenceId), eq(schema.purchaseBills.companyId, companyId)));
        documentNumber = d?.n || null;
      } else if (e.referenceType === 'Manual') {
        const [d] = await tdb.select({ n: schema.manualJournals.number }).from(schema.manualJournals).where(and(eq(schema.manualJournals.id, e.referenceId), eq(schema.manualJournals.companyId, companyId)));
        documentNumber = d?.n || null;
      }
    } catch { /* a document we cannot name is shown by its type only */ }
    const [reversedBy] = await tdb.select({ id: schema.journalEntries.id }).from(schema.journalEntries).where(and(eq(schema.journalEntries.companyId, companyId), eq(schema.journalEntries.reversalOfId, id)));
    res.json({
      id: e.id, docDate: e.docDate, postingDate: e.postingDate, description: e.description, referenceType: e.referenceType, referenceId: e.referenceId, documentNumber,
      branchId: e.branchId, createdByName: creator?.username || '', createdAt: e.createdAt, reversalOfId: e.reversalOfId, reversedById: reversedBy?.id || null,
      lines: outLines, totalDebit: round2(outLines.reduce((s: number, l: any) => s + l.debit, 0)), totalCredit: round2(outLines.reduce((s: number, l: any) => s + l.credit, 0)),
    });
  } catch (e: any) { fail(res, 500, e.message); }
});

// ---- one manual journal ----
router.get('/manual-journals/:id', withTenantDb, async (req: any, res) => {
  try {
    if (!canSee(req)) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb();
    const j = await loadJournal(tdb, req.targetCompanyId, String(req.params.id));
    if (!j || !branchVisible(req, j.branchId)) return fail(res, 404, 'Journal not found.');
    res.json(await journalDetail(tdb, req, j));
  } catch (e: any) { fail(res, 500, e.message); }
});

// ---- create a draft ----
router.post('/manual-journals', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'journals.create')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb();
    const companyId = req.targetCompanyId;
    const b = req.body || {};
    const docDate = String(b.docDate || '');
    const postingDate = String(b.postingDate || docDate);
    const description = String(b.description ?? '').trim();
    if (!DATE_RE.test(docDate) || isNaN(Date.parse(docDate))) return fail(res, 400, 'Enter a valid document date.');
    if (!DATE_RE.test(postingDate) || isNaN(Date.parse(postingDate))) return fail(res, 400, 'Enter a valid posting date.');
    if (!description) return fail(res, 400, 'A description (narration) is required.');
    if (description.length > 300) return fail(res, 400, 'The description can be up to 300 characters.');
    const br = await resolveBranch(tdb, req, b.branchId);
    if (br.error) return fail(res, br.status || 400, br.error);
    const checked = await checkLines(tdb, companyId, b.lines, false);
    if (checked.error) return fail(res, 400, checked.error);
    if (checked.lines.length === 0) return fail(res, 400, 'Add at least one line.');
    const id = generateId();
    const number = await getAndIncrementDocumentNumber(tdb, companyId, 'manualJournal', docDate, br.branchId);
    // isolation-ok: branchId was resolved by resolveBranch (this company's own branch the user may access) just above
    await tdb.insert(schema.manualJournals).values({
      id, companyId, number, ...documentDates(docDate, postingDate), backDateReason: String(b.backDateReason ?? '').trim().slice(0, 300) || null, description, reference: String(b.reference ?? '').trim().slice(0, 100) || null, preparerNote: String(b.preparerNote ?? '').trim().slice(0, 500) || null,
      branchId: br.branchId, status: 'Draft', preparedById: req.user.id, preparedAt: nowDate(),
    });
    // isolation-ok: every accountId was verified to be an active posting account of this company by checkLines above
    const combos = await lineCombinations(tdb, req, companyId, checked.lines, 'draft');
    await tdb.insert(schema.manualJournalLines).values(checked.lines.map((l, i) => ({ id: generateId(), journalId: id, companyId, accountId: l.accountId, debit: String(l.debit), credit: String(l.credit), note: l.note, sortOrder: i, dimensionCombinationId: combos[i] })));
    await addEvent(tdb, req, id, 'Prepared');
    recordAuditLog(req, 'CREATE_MANUAL_JOURNAL', 'manual_journal', id, { number, docDate, postingDate });
    res.json({ success: true, id, number });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// ---- edit a draft or a rejected journal ----
router.put('/manual-journals/:id', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'journals.update')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb();
    const companyId = req.targetCompanyId;
    const j = await loadJournal(tdb, companyId, String(req.params.id));
    if (!j || !branchVisible(req, j.branchId)) return fail(res, 404, 'Journal not found.');
    if (j.status !== 'Draft' && j.status !== 'Rejected') return fail(res, 400, `A ${j.status.toLowerCase()} journal cannot be edited.${j.status === 'Posted' ? ' Reverse it instead.' : ''}`);
    if (j.reversalOfId) return fail(res, 400, 'A reversal journal is generated from the original and cannot be edited; discard it and start a new one if it is wrong.');
    const b = req.body || {};
    const docDate = b.docDate === undefined ? j.docDate : String(b.docDate);
    // the posting date follows the document date unless it was set apart on purpose
    const postingDate = b.postingDate !== undefined ? String(b.postingDate || docDate) : (j.postingDate === j.docDate ? docDate : j.postingDate);
    const description = b.description === undefined ? j.description : String(b.description).trim();
    if (!DATE_RE.test(docDate) || isNaN(Date.parse(docDate))) return fail(res, 400, 'Enter a valid document date.');
    if (!DATE_RE.test(postingDate) || isNaN(Date.parse(postingDate))) return fail(res, 400, 'Enter a valid posting date.');
    if (!description) return fail(res, 400, 'A description (narration) is required.');
    if (description.length > 300) return fail(res, 400, 'The description can be up to 300 characters.');
    let branchId = j.branchId;
    if (b.branchId !== undefined) { const br = await resolveBranch(tdb, req, b.branchId); if (br.error) return fail(res, br.status || 400, br.error); branchId = br.branchId; }
    let checked: Awaited<ReturnType<typeof checkLines>> | null = null;
    if (b.lines !== undefined) {
      checked = await checkLines(tdb, companyId, b.lines, false);
      if (checked.error) return fail(res, 400, checked.error);
      if (checked.lines.length === 0) return fail(res, 400, 'Add at least one line.');
    }
    await tdb.update(schema.manualJournals).set({
      docDate, postingDate, description, branchId,
      backDateReason: b.backDateReason === undefined ? j.backDateReason : (String(b.backDateReason ?? '').trim().slice(0, 300) || null),
      reference: b.reference === undefined ? j.reference : (String(b.reference ?? '').trim().slice(0, 100) || null),
      preparerNote: b.preparerNote === undefined ? j.preparerNote : (String(b.preparerNote ?? '').trim().slice(0, 500) || null),
      status: 'Draft',
    }).where(and(eq(schema.manualJournals.id, j.id), eq(schema.manualJournals.companyId, companyId)));
    if (checked) {
      await tdb.delete(schema.manualJournalLines).where(and(eq(schema.manualJournalLines.journalId, j.id), eq(schema.manualJournalLines.companyId, companyId)));
      const combos = await lineCombinations(tdb, req, companyId, checked.lines, 'draft');
      await tdb.insert(schema.manualJournalLines).values(checked.lines.map((l, i) => ({ id: generateId(), journalId: j.id, companyId, accountId: l.accountId, debit: String(l.debit), credit: String(l.credit), note: l.note, sortOrder: i, dimensionCombinationId: combos[i] })));
    }
    await addEvent(tdb, req, j.id, 'Edited');
    recordAuditLog(req, 'UPDATE_MANUAL_JOURNAL', 'manual_journal', j.id, { number: j.number });
    res.json({ success: true });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// ---- submit for approval ----
router.post('/manual-journals/:id/submit', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'journals.create') && !hasPermission(req.user, 'journals.update')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb();
    const companyId = req.targetCompanyId;
    const j = await loadJournal(tdb, companyId, String(req.params.id));
    if (!j || !branchVisible(req, j.branchId)) return fail(res, 404, 'Journal not found.');
    if (j.status !== 'Draft' && j.status !== 'Rejected') return fail(res, 400, `Only a draft or rejected journal can be submitted (this one is ${j.status.toLowerCase()}).`);
    const rawLines = await tdb.select().from(schema.manualJournalLines).where(and(eq(schema.manualJournalLines.journalId, j.id), eq(schema.manualJournalLines.companyId, companyId)));
    const checked = await checkLines(tdb, companyId, await storedLines(tdb, companyId, rawLines), true, !!j.reversalOfId);
    if (checked.error) return fail(res, 400, checked.error);
    await lineCombinations(tdb, req, companyId, checked.lines, 'strict'); // Required dimensions must be present before it goes for approval
    const touchesVat = checked.lines.some(l => VAT_ROLES.includes(checked.accounts.get(l.accountId)?.systemKey));
    await checkPeriod(req, j.postingDate, touchesVat, j.backDateReason);
    await tdb.update(schema.manualJournals).set({ status: 'Pending', submittedAt: nowDate(), decisionNote: null }).where(and(eq(schema.manualJournals.id, j.id), eq(schema.manualJournals.companyId, companyId)));
    await addEvent(tdb, req, j.id, 'Submitted', String(req.body?.note ?? '').trim().slice(0, 300) || null);
    recordAuditLog(req, 'SUBMIT_MANUAL_JOURNAL', 'manual_journal', j.id, { number: j.number });
    res.json({ success: true });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// ---- approve (posts to the ledger) ----
router.post('/manual-journals/:id/approve', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'journals.post')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb();
    const companyId = req.targetCompanyId;
    const [lock] = await tdb.select().from(schema.manualJournals).where(and(eq(schema.manualJournals.id, String(req.params.id)), eq(schema.manualJournals.companyId, companyId))).for('update');
    if (!lock || !branchVisible(req, lock.branchId)) return fail(res, 404, 'Journal not found.');
    const j = lock;
    if (j.status !== 'Pending') return fail(res, 400, `Only a journal pending approval can be approved (this one is ${j.status.toLowerCase()}).`);
    const own = j.preparedById === req.user.id;
    const selfOk = await selfApprovalOn(tdb, companyId);
    if (own && !selfOk) return fail(res, 403, 'You prepared this journal, so someone else must approve it.');
    const rawLines = await tdb.select().from(schema.manualJournalLines).where(and(eq(schema.manualJournalLines.journalId, j.id), eq(schema.manualJournalLines.companyId, companyId))).orderBy(asc(schema.manualJournalLines.sortOrder));
    const checked = await checkLines(tdb, companyId, await storedLines(tdb, companyId, rawLines), true, !!j.reversalOfId);
    if (checked.error) return fail(res, 400, checked.error);
    const combos = await lineCombinations(tdb, req, companyId, checked.lines, j.reversalOfId ? 'draft' : 'strict'); // a reversal mirrors the original's tags as they were
    const touchesVat = checked.lines.some(l => VAT_ROLES.includes(checked.accounts.get(l.accountId)?.systemKey));
    await checkPeriod(req, j.postingDate, touchesVat, j.backDateReason);
    // A reversal is posted as the mirror of the entry it reverses, linked to it.
    let reversalOfEntryId: string | null = null;
    if (j.reversalOfId) {
      const orig = await loadJournal(tdb, companyId, j.reversalOfId);
      if (!orig || orig.status !== 'Posted' || !orig.journalEntryId) return fail(res, 400, 'The journal this reverses is not posted.');
      reversalOfEntryId = orig.journalEntryId;
    }
    const entryId = await postJournalEntry(tdb, {
      companyId, branchId: j.branchId, postingDate: j.postingDate, docDate: j.docDate, referenceType: 'Manual', referenceId: j.id,
      reversalOfId: reversalOfEntryId, description: `${j.number}: ${j.description}`, createdById: j.preparedById,
      lines: checked.lines.map((l, i) => ({ accountId: l.accountId, debit: l.debit || undefined, credit: l.credit || undefined, dimensionCombinationId: combos[i] })),
    });
    await tdb.update(schema.manualJournals).set({ status: 'Posted', journalEntryId: entryId, decidedById: req.user.id, decidedAt: nowDate(), selfApproved: own, decisionNote: String(req.body?.note ?? '').trim().slice(0, 300) || null })
      .where(and(eq(schema.manualJournals.id, j.id), eq(schema.manualJournals.companyId, companyId)));
    if (j.reversalOfId) await tdb.update(schema.manualJournals).set({ reversedById: j.id }).where(and(eq(schema.manualJournals.id, j.reversalOfId), eq(schema.manualJournals.companyId, companyId)));
    await addEvent(tdb, req, j.id, 'Approved', own ? 'Approved by its preparer (company setting allows it)' : (String(req.body?.note ?? '').trim().slice(0, 300) || null));
    await addEvent(tdb, req, j.id, 'Posted');
    recordAuditLog(req, 'APPROVE_MANUAL_JOURNAL', 'manual_journal', j.id, { number: j.number, entryId, selfApproved: own });
    res.json({ success: true, journalEntryId: entryId });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// ---- reject (back to the preparer, with a reason) ----
router.post('/manual-journals/:id/reject', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'journals.post')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb();
    const companyId = req.targetCompanyId;
    const j = await loadJournal(tdb, companyId, String(req.params.id));
    if (!j || !branchVisible(req, j.branchId)) return fail(res, 404, 'Journal not found.');
    if (j.status !== 'Pending') return fail(res, 400, `Only a journal pending approval can be rejected (this one is ${j.status.toLowerCase()}).`);
    const note = String(req.body?.note ?? '').trim().slice(0, 300);
    if (!note) return fail(res, 400, 'Write the reason for rejecting, so the preparer knows what to correct.');
    await tdb.update(schema.manualJournals).set({ status: 'Rejected', decidedById: req.user.id, decidedAt: nowDate(), decisionNote: note }).where(and(eq(schema.manualJournals.id, j.id), eq(schema.manualJournals.companyId, companyId)));
    await addEvent(tdb, req, j.id, 'Rejected', note);
    recordAuditLog(req, 'REJECT_MANUAL_JOURNAL', 'manual_journal', j.id, { number: j.number, reason: note });
    res.json({ success: true });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// ---- discard a draft / rejected journal (never a posted one; the number stays on record) ----
router.delete('/manual-journals/:id', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'journals.delete')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb();
    const companyId = req.targetCompanyId;
    const j = await loadJournal(tdb, companyId, String(req.params.id));
    if (!j || !branchVisible(req, j.branchId)) return fail(res, 404, 'Journal not found.');
    if (j.status !== 'Draft' && j.status !== 'Rejected') return fail(res, 400, j.status === 'Posted' ? 'A posted journal cannot be discarded; reverse it instead.' : `A ${j.status.toLowerCase()} journal cannot be discarded.`);
    // A discarded reversal gives up its link so the original can be reversed again with a fresh journal.
    await tdb.update(schema.manualJournals).set({ status: 'Discarded', reversalOfId: null }).where(and(eq(schema.manualJournals.id, j.id), eq(schema.manualJournals.companyId, companyId)));
    await addEvent(tdb, req, j.id, 'Discarded', String(req.body?.note ?? '').trim().slice(0, 300) || (j.reversalOfId ? 'Reversal draft discarded' : null));
    recordAuditLog(req, 'DISCARD_MANUAL_JOURNAL', 'manual_journal', j.id, { number: j.number });
    res.json({ success: true });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// ---- start a reversal of a posted manual journal (a new draft that itself needs approval) ----
router.post('/manual-journals/:id/reverse', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'journals.reverse')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb();
    const companyId = req.targetCompanyId;
    const orig = await loadJournal(tdb, companyId, String(req.params.id));
    if (!orig || !branchVisible(req, orig.branchId)) return fail(res, 404, 'Journal not found.');
    if (orig.status !== 'Posted') return fail(res, 400, 'Only a posted journal can be reversed.');
    if (orig.reversalOfId) return fail(res, 400, 'This journal is itself a reversal; it cannot be reversed again. Post a new journal instead.');
    if (orig.reversedById) return fail(res, 400, 'This journal has already been reversed.');
    const [pending] = await tdb.select({ id: schema.manualJournals.id, number: schema.manualJournals.number }).from(schema.manualJournals)
      .where(and(eq(schema.manualJournals.companyId, companyId), eq(schema.manualJournals.reversalOfId, orig.id)));
    if (pending) return fail(res, 400, `A reversal (${pending.number}) is already in progress for this journal.`);
    const date = req.body?.docDate ? String(req.body.docDate) : todayStr();
    if (!DATE_RE.test(date) || isNaN(Date.parse(date))) return fail(res, 400, 'Enter a valid date for the reversal.');
    if (date < orig.postingDate) return fail(res, 400, 'A reversal cannot be dated before the journal it reverses.');
    const reason = String(req.body?.reason ?? '').trim().slice(0, 300);
    if (!reason) return fail(res, 400, 'Write the reason for the reversal.');
    const lines = await tdb.select().from(schema.manualJournalLines).where(and(eq(schema.manualJournalLines.journalId, orig.id), eq(schema.manualJournalLines.companyId, companyId))).orderBy(asc(schema.manualJournalLines.sortOrder));
    const id = generateId();
    const number = await getAndIncrementDocumentNumber(tdb, companyId, 'manualJournal', date, orig.branchId);
    await tdb.insert(schema.manualJournals).values({
      id, companyId, number, ...documentDates(date), description: `Reversal of ${orig.number}: ${reason}`.slice(0, 300), reference: orig.number, preparerNote: reason,
      branchId: orig.branchId, status: 'Draft', preparedById: req.user.id, preparedAt: nowDate(), reversalOfId: orig.id,
    });
    await tdb.insert(schema.manualJournalLines).values(lines.map((l: any, i: number) => ({
      id: generateId(), journalId: id, companyId, accountId: l.accountId, debit: l.credit, credit: l.debit, note: l.note, sortOrder: i, dimensionCombinationId: l.dimensionCombinationId,
    })));
    await addEvent(tdb, req, id, 'Prepared', `Reversal of ${orig.number}`);
    await addEvent(tdb, req, orig.id, 'ReversalStarted', `${number}: ${reason}`);
    recordAuditLog(req, 'START_JOURNAL_REVERSAL', 'manual_journal', orig.id, { number: orig.number, reversalNumber: number });
    res.json({ success: true, id, number });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// ---- Journal Voucher print data: ONE shape for a manual journal (any status) and for any posted ledger entry, so one renderer prints both ----
const SOURCE_LABEL: Record<string, string> = {
  Invoice: 'Invoice', CreditNote: 'Credit Note', Expense: 'Expense', PurchaseBill: 'Purchase Bill', PurchaseReturn: 'Purchase Return', Grn: 'Goods Receipt', Manual: 'Manual journal', Opening: 'Opening balance',
  CustomerReceipt: 'Customer receipt', VendorPayment: 'Vendor payment', VendorRefund: 'Vendor refund', BankCharge: 'Bank charge', BankInterest: 'Bank interest', Transfer: 'Transfer', Voucher: 'Voucher',
};
async function sourceNumber(tdb: any, companyId: string, refType: string, refId: string): Promise<string | null> {
  const pick = async (table: any, col: any) => { const [d] = await tdb.select({ n: col }).from(table).where(and(eq(table.id, refId), eq(table.companyId, companyId))); return d?.n || null; };
  try {
    if (refType === 'Invoice' || refType === 'CreditNote') return await pick(schema.invoices, schema.invoices.invoiceNumber);
    if (refType === 'Expense') return await pick(schema.expenses, schema.expenses.expenseNumber);
    if (refType === 'PurchaseBill') return await pick(schema.purchaseBills, schema.purchaseBills.billNumber);
    if (['CustomerReceipt', 'VendorPayment', 'VendorRefund', 'BankCharge', 'BankInterest'].includes(refType)) return await pick(schema.vouchers, schema.vouchers.voucherNumber);
  } catch { /* a document we cannot name is shown by its type only */ }
  return null;
}
const manualVoucherData = (d: any) => ({
  kind: 'Manual', number: d.number, status: d.status, entryId: d.journalEntryId || null, docDate: d.docDate, postingDate: d.postingDate, description: d.description, reference: d.reference || '',
  sourceLabel: SOURCE_LABEL.Manual, sourceNumber: d.number, backDateReason: d.backDateReason || '', preparerNote: d.preparerNote || '',
  lines: d.lines.map((l: any) => ({ accountCode: l.accountCode, accountName: l.accountName, accountNameAr: l.accountNameAr, party: null, note: l.note || '', debit: l.debit, credit: l.credit,
    dimensions: (l.dimensionLabels || []).map((x: any) => `${x.typeName}: ${x.name}`) })),
  totalDebit: d.totalDebit, totalCredit: d.totalCredit, preparedBy: d.preparedByName || '', preparedAt: d.preparedAt, approvedBy: d.decidedByName || '', approvedAt: d.decidedAt || null,
  selfApproved: !!d.selfApproved, reversalOf: d.reversalOf?.number || null, reversedBy: d.reversedBy?.number || null,
});

router.get('/manual-journals/:id/print-data', withTenantDb, async (req: any, res) => {
  try {
    if (!canSee(req)) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb();
    const j = await loadJournal(tdb, req.targetCompanyId, String(req.params.id));
    if (!j || !branchVisible(req, j.branchId)) return fail(res, 404, 'Journal not found.');
    res.json(manualVoucherData(await journalDetail(tdb, req, j)));
  } catch (e: any) { fail(res, 500, e.message); }
});

router.get('/journals/entries/:id/print-data', withTenantDb, async (req: any, res) => {
  try {
    if (!canSee(req)) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb(); const companyId = req.targetCompanyId; const id = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(id)) return fail(res, 404, 'Entry not found.');
    const e = await postedEntry(tdb, companyId, id);
    const [row] = e ? await tdb.select({ branchId: schema.journalEntries.branchId }).from(schema.journalEntries).where(and(eq(schema.journalEntries.id, id), eq(schema.journalEntries.companyId, companyId))) : [];
    if (!e || !branchVisible(req, row?.branchId ?? null)) return fail(res, 404, 'Entry not found.');
    if (e.referenceType === 'Manual') {
      const [mj] = await tdb.select().from(schema.manualJournals).where(and(eq(schema.manualJournals.companyId, companyId), eq(schema.manualJournals.journalEntryId, id)));
      if (mj) return res.json(manualVoucherData(await journalDetail(tdb, req, mj)));
    }
    const num = await sourceNumber(tdb, companyId, e.referenceType, e.referenceId);
    const [rev] = await tdb.select({ id: schema.journalEntries.id }).from(schema.journalEntries).where(and(eq(schema.journalEntries.companyId, companyId), eq(schema.journalEntries.reversalOfId, id)));
    res.json({
      kind: e.reversalOfId ? 'Reversal' : 'Document', number: num || e.id.slice(0, 8).toUpperCase(), status: 'Posted', entryId: e.id, docDate: e.docDate, postingDate: e.postingDate, description: e.description, reference: '',
      sourceLabel: SOURCE_LABEL[e.referenceType] || e.referenceType, sourceNumber: num, backDateReason: '', preparerNote: '',
      lines: e.lines.map(l => ({ accountCode: l.accountCode, accountName: l.accountName, accountNameAr: l.accountNameAr, party: l.party, note: '', debit: l.debit, credit: l.credit, dimensions: l.dimensions })),
      totalDebit: e.totalDebit, totalCredit: e.totalCredit, preparedBy: e.createdByName, preparedAt: e.createdAt, approvedBy: '', approvedAt: null, selfApproved: false,
      reversalOf: e.reversalOfId ? e.reversalOfId.slice(0, 8).toUpperCase() : null, reversedBy: rev ? rev.id.slice(0, 8).toUpperCase() : null,
    });
  } catch (e: any) { fail(res, 500, e.message); }
});

export default router;
