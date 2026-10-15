// General Ledger Step 1: Opening Balances. The balances brought forward when a company starts keeping its books here are entered once, checked on a
// preview (nothing saved), and posted as ONE balanced ledger entry dated the opening date. Rules that keep it honest:
//  - balance-sheet accounts only (Asset / Liability / Equity): profit and loss start from nothing;
//  - customers, suppliers, stock, VAT and goods-received are control accounts: their opening comes from their own documents, never typed here
//    (a bank / cash account is allowed: its opening is exactly this entry);
//  - debits must equal credits (the difference can be put to one chosen Equity account, usually Retained Earnings, and is shown before posting);
//  - a company has at most ONE live opening entry; a wrong one is reversed (never edited) and a corrected one posted;
//  - the opening date must be in an open fiscal month, and nothing may already be posted before it unless the user explicitly accepts that.
import express from 'express';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { generateId } from '../../src/id.js';
import { withTenantDb, tenantDb } from '../lib/tenantDb.js';
import { hasPermission } from '../lib/authz.js';
import { recordAuditLog } from '../lib/audit.js';
import { nowDate, todayStr } from '../lib/clock.js';
import { postJournalEntry, reverseAllEntriesFor } from '../lib/ledger.js';
import { validateTransactionDate, assertQuarterNotFiled } from '../lib/businessLogic.js';
import { round2 } from '../lib/ledgerQueries.js';
import { assertPostingAllowed } from '../lib/postingGuard.js';

const router = express.Router();
const fail = (res: any, status: number, error: string) => res.status(status).json({ error });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BALANCE_SHEET_TYPES = ['Asset', 'Liability', 'Equity'];

interface PreviewResult { error?: string; lines: { accountId: string; code: string; name: string; type: string; debit: number; credit: number }[]; totalDebit: number; totalCredit: number; difference: number; plug: { accountId: string; code: string; name: string; debit: number; credit: number } | null; warnings: string[]; canPost: boolean }

async function build(tdb: any, companyId: string, body: any): Promise<PreviewResult> {
  const bad = (error: string): PreviewResult => ({ error, lines: [], totalDebit: 0, totalCredit: 0, difference: 0, plug: null, warnings: [], canPost: false });
  const date = String(body?.cutOffDate || '');
  if (!DATE_RE.test(date) || isNaN(Date.parse(date))) return bad('Enter a valid opening date.');
  if (!Array.isArray(body?.lines)) return bad('Enter the opening balances.');
  if (body.lines.length > 500) return bad('Too many lines.');
  const raw: { accountId: string; debit: number; credit: number }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < body.lines.length; i++) {
    const r = body.lines[i] || {};
    const debit = round2(Number(r.debit) || 0), credit = round2(Number(r.credit) || 0);
    if (debit === 0 && credit === 0) continue; // an empty row is simply ignored
    if (!r.accountId || typeof r.accountId !== 'string') return bad(`Line ${i + 1}: choose an account.`);
    if (debit < 0 || credit < 0) return bad(`Line ${i + 1}: amounts cannot be negative.`);
    if (debit > 0 && credit > 0) return bad(`Line ${i + 1}: enter either a debit or a credit, not both.`);
    if (seen.has(r.accountId)) return bad(`Line ${i + 1}: that account appears twice; enter one balance per account.`);
    seen.add(r.accountId);
    raw.push({ accountId: r.accountId, debit, credit });
  }
  if (raw.length === 0) return bad('Enter at least one opening balance.');
  const ids = raw.map(r => r.accountId);
  const accts: any[] = await tdb.select().from(schema.companyAccounts).where(and(eq(schema.companyAccounts.companyId, companyId), inArray(schema.companyAccounts.id, ids)));
  const aMap = new Map<string, any>(accts.map(a => [a.id, a]));
  const lines: PreviewResult['lines'] = [];
  for (const r of raw) {
    const a = aMap.get(r.accountId);
    if (!a) return bad('One of the accounts does not exist in this company.');
    if (!a.isActive) return bad(`${a.code} ${a.name} is inactive.`);
    if (a.isGroup) return bad(`${a.code} ${a.name} is a heading; enter the balance on an account under it.`);
    if (!BALANCE_SHEET_TYPES.includes(a.type)) return bad(`${a.code} ${a.name} is a ${a.type} account; opening balances are for assets, liabilities and equity only (profit and loss start from nothing).`);
    if (a.isControl && !a.bankId) return bad(`${a.code} ${a.name} is a control account (customers, suppliers, stock, VAT); its opening comes from its own documents, not from here.`);
    lines.push({ accountId: a.id, code: a.code, name: a.name, type: a.type, debit: r.debit, credit: r.credit });
  }
  let totalDebit = round2(lines.reduce((s, l) => s + l.debit, 0));
  let totalCredit = round2(lines.reduce((s, l) => s + l.credit, 0));
  const difference = round2(totalDebit - totalCredit);
  let plug: PreviewResult['plug'] = null;
  const warnings: string[] = [];
  if (Math.abs(difference) > 0.004) {
    if (body.plugAccountId) {
      const p = await tdb.select().from(schema.companyAccounts).where(and(eq(schema.companyAccounts.companyId, companyId), eq(schema.companyAccounts.id, String(body.plugAccountId))));
      const pa = p[0];
      if (!pa || pa.type !== 'Equity' || pa.isGroup || pa.isControl || !pa.isActive) return bad('The difference can only be put to an active Equity account.');
      if (aMap.has(pa.id)) return bad(`${pa.code} ${pa.name} already has a balance on this sheet; choose a different account for the difference.`);
      plug = { accountId: pa.id, code: pa.code, name: pa.name, debit: difference < 0 ? round2(-difference) : 0, credit: difference > 0 ? difference : 0 };
      totalDebit = round2(totalDebit + plug.debit); totalCredit = round2(totalCredit + plug.credit);
      warnings.push(`The sheet is out by ${Math.abs(difference).toFixed(2)}; this amount will be put to ${pa.code} ${pa.name}.`);
    } else {
      warnings.push(`The sheet does not balance: debits ${totalDebit.toFixed(2)} vs credits ${totalCredit.toFixed(2)} (out by ${Math.abs(difference).toFixed(2)}). Fix the figures or choose an Equity account to take the difference.`);
    }
  }
  const earlier: any = await tdb.execute(sql`SELECT COUNT(*)::int AS n FROM journal_entries WHERE company_id = ${companyId}::uuid AND posting_date < ${date} AND reference_type <> 'Opening'`);
  if (Number(earlier.rows[0].n) > 0) warnings.push(`${earlier.rows[0].n} ledger entr${Number(earlier.rows[0].n) === 1 ? 'y is' : 'ies are'} already posted before this opening date. Opening balances normally come first; these figures may be counted twice.`);
  const live: any = await tdb.execute(sql`SELECT cut_off_date AS d FROM opening_balance_runs WHERE company_id = ${companyId}::uuid AND (summary->>'reversedAt') IS NULL`);
  if (live.rows.length) warnings.push(`Opening balances were already posted (dated ${live.rows[0].d}). Reverse that entry first, then post the corrected one.`);
  const balanced = Math.abs(totalDebit - totalCredit) < 0.004;
  return { lines, totalDebit, totalCredit, difference, plug, warnings, canPost: balanced && live.rows.length === 0 };
}

// ---- the screen's data: past runs, accounts that may take an opening balance, and each bank's own opening figure ----
router.get('/opening-balances', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'openingBalances.read') && !hasPermission(req.user, 'openingBalances.post')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb();
    const companyId = req.targetCompanyId;
    const runs = await tdb.select().from(schema.openingBalanceRuns).where(eq(schema.openingBalanceRuns.companyId, companyId)).orderBy(desc(schema.openingBalanceRuns.postedAt));
    const uids = [...new Set(runs.map((r: any) => r.postedById))] as string[];
    const users = uids.length ? await tdb.select({ id: schema.users.id, username: schema.users.username }).from(schema.users).where(inArray(schema.users.id, uids)) : [];
    const uMap = new Map<string, string>(users.map((u: any) => [u.id, u.username]));
    const accts: any[] = await tdb.select().from(schema.companyAccounts).where(eq(schema.companyAccounts.companyId, companyId));
    const eligible = accts.filter(a => a.isActive && !a.isGroup && BALANCE_SHEET_TYPES.includes(a.type) && (!a.isControl || a.bankId))
      .map(a => ({ id: a.id, code: a.code, name: a.name, nameAr: a.nameAr, type: a.type, parentId: a.parentId, bankId: a.bankId }))
      .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
    const banks: any[] = await tdb.select({ id: schema.bankAccounts.id, name: schema.bankAccounts.bankName, openingBalance: schema.bankAccounts.openingBalance }).from(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyId));
    const bankSuggestions = banks.filter(b => Number(b.openingBalance) !== 0).map(b => ({ bankId: b.id, name: b.name, amount: Number(b.openingBalance), accountId: accts.find(a => a.bankId === b.id)?.id || null }));
    const first: any = await tdb.execute(sql`SELECT MIN(posting_date) AS d FROM journal_entries WHERE company_id = ${companyId}::uuid AND reference_type <> 'Opening'`);
    res.json({
      runs: runs.map((r: any) => ({ id: r.id, cutOffDate: r.cutOffDate, postedByName: uMap.get(r.postedById) || '', postedAt: r.postedAt, summary: r.summary, reversed: !!r.summary?.reversedAt })),
      eligibleAccounts: eligible, bankSuggestions, firstActivityDate: first.rows[0]?.d || null,
      equityAccounts: accts.filter(a => a.type === 'Equity' && !a.isGroup && !a.isControl && a.isActive).map(a => ({ id: a.id, code: a.code, name: a.name })),
      today: todayStr(),
    });
  } catch (e: any) { fail(res, 500, e.message); }
});

// ---- preview (dry run: nothing is saved) ----
router.post('/opening-balances/preview', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'openingBalances.preview') && !hasPermission(req.user, 'openingBalances.post')) return fail(res, 403, 'Forbidden');
    const r = await build(tenantDb(), req.targetCompanyId, req.body);
    if (r.error) return fail(res, 400, r.error);
    res.json(r);
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// ---- post ----
router.post('/opening-balances/post', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'openingBalances.post')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb();
    const companyId = req.targetCompanyId;
    if (req.body?.confirm !== true) return fail(res, 400, 'Confirm that you have reviewed the preview.');
    const r = await build(tdb, companyId, req.body);
    if (r.error) return fail(res, 400, r.error);
    if (!r.canPost) return fail(res, 400, r.warnings.find(w => /does not balance|already posted \(|Opening balances were already/.test(w)) || 'These opening balances cannot be posted yet.');
    const earlier = r.warnings.some(w => /already posted before this opening date/.test(w));
    if (earlier && req.body?.acceptEarlierActivity !== true) return fail(res, 400, 'Entries are already posted before this opening date. Tick "I understand" to post anyway, or pick an earlier opening date.');
    const date = String(req.body.cutOffDate);
    await assertPostingAllowed(req, date, { vat: 'filed' });
    const runId = generateId();
    const lines = [
      ...r.lines.map(l => ({ accountId: l.accountId, debit: l.debit || undefined, credit: l.credit || undefined })),
      ...(r.plug ? [{ accountId: r.plug.accountId, debit: r.plug.debit || undefined, credit: r.plug.credit || undefined }] : []),
    ];
    const entryId = await postJournalEntry(tdb, { companyId, postingDate: date, referenceType: 'Opening', referenceId: runId, description: `Opening balances as at ${date}`, createdById: req.user.id, lines });
    // isolation-ok: journalEntryId is the entry this very request just created through postJournalEntry
    await tdb.insert(schema.openingBalanceRuns).values({
      id: runId, companyId, cutOffDate: date, journalEntryId: entryId, postedById: req.user.id, postedAt: nowDate(),
      summary: { lines: r.lines.length, totalDebit: r.totalDebit, totalCredit: r.totalCredit, plug: r.plug, accounts: r.lines.map(l => ({ code: l.code, name: l.name, debit: l.debit, credit: l.credit })) },
    });
    recordAuditLog(req, 'POST_OPENING_BALANCES', 'opening_balance_run', runId, { date, lines: r.lines.length, totalDebit: r.totalDebit });
    res.json({ success: true, runId, journalEntryId: entryId });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// ---- reverse a posted opening entry (so a corrected one can be posted) ----
router.post('/opening-balances/:id/reverse', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'openingBalances.post')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb();
    const companyId = req.targetCompanyId;
    const id = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(id)) return fail(res, 404, 'Not found.');
    const [run] = await tdb.select().from(schema.openingBalanceRuns).where(and(eq(schema.openingBalanceRuns.id, id), eq(schema.openingBalanceRuns.companyId, companyId))).for('update');
    if (!run) return fail(res, 404, 'Opening balances not found.');
    const summary: any = run.summary || {};
    if (summary.reversedAt) return fail(res, 400, 'These opening balances were already reversed.');
    const reason = String(req.body?.reason ?? '').trim().slice(0, 300);
    if (!reason) return fail(res, 400, 'Write the reason for the reversal.');
    const date = req.body?.docDate ? String(req.body.docDate) : run.cutOffDate;
    if (!DATE_RE.test(date) || isNaN(Date.parse(date))) return fail(res, 400, 'Enter a valid date.');
    if (date < run.cutOffDate) return fail(res, 400, 'The reversal cannot be dated before the opening date.');
    await assertPostingAllowed(req, date, { vat: 'filed' });
    const ids = await reverseAllEntriesFor(tdb, companyId, 'Opening', id, date, `Reversal of opening balances as at ${run.cutOffDate}: ${reason}`, req.user.id);
    await tdb.update(schema.openingBalanceRuns).set({ summary: { ...summary, reversedAt: nowDate().toISOString(), reversedById: req.user.id, reversalReason: reason } })
      .where(and(eq(schema.openingBalanceRuns.id, id), eq(schema.openingBalanceRuns.companyId, companyId)));
    recordAuditLog(req, 'REVERSE_OPENING_BALANCES', 'opening_balance_run', id, { reason, entries: ids.length });
    res.json({ success: true });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

export default router;
