// Bank reconciliation (Blueprint FR-BANK-01..05). A session is one bank account at one statement date: the statement's ending balance is entered, every posted line of the bank's ledger
// account up to that date is listed, and each is marked cleared - matched to a statement line the bank printed, or ticked off. The session can be completed only when the cleared balance equals
// the statement balance and no statement line is left unmatched; a bank fee, interest or a timing error is put right by a journal entry posted from inside the session, never by forcing
// the session through. A completed session locks its cleared lines (the entry that carries one cannot be reversed - see assertNoReconciledLines in ledger.ts, called by the posting engine's reversal);
// reopening it needs its own permission, must be the latest completed session of that bank, and is audited by the route.
//
// The reconciling formula, in the standard direction: Statement balance + deposits in transit - payments outstanding = Book balance (the ledger balance of the bank's account at the statement
// date). Equivalent, and what the screen keeps live: cleared balance = statement balance. (The Blueprint prints the signs the other way round; the arithmetic of a real bank
// reconciliation is this one.)
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { generateId } from '../../src/id.js';
import { nowDate } from './clock.js';
import { postJournalEntry, reverseAllEntriesFor } from './ledger.js';
import { getAndIncrementDocumentNumber } from './documentNumbering.js';
import { documentDates } from './documentDates.js';
import { resolvedLines } from './ledgerQueries.js';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ids = (xs: string[]) => sql.join(xs.map(x => sql`${x}::uuid`), sql`, `);

// The company account that carries a bank's movements.
export async function bankLedgerAccount(tx: any, companyId: string, bankId: string) {
  const [bank] = await tx.select().from(schema.bankAccounts).where(and(eq(schema.bankAccounts.id, bankId), eq(schema.bankAccounts.companyId, companyId)));
  if (!bank) throw fail(400, 'Choose a bank or cash account of this company.');
  const [acct] = await tx.select().from(schema.companyAccounts).where(and(eq(schema.companyAccounts.companyId, companyId), eq(schema.companyAccounts.bankId, bankId)));
  if (!acct) throw fail(400, 'This bank has no ledger account yet.');
  return { bank, account: acct };
}

async function loadSession(tx: any, companyId: string, id: string, lock = false) {
  const q = tx.select().from(schema.bankReconciliations).where(and(eq(schema.bankReconciliations.id, id), eq(schema.bankReconciliations.companyId, companyId)));
  const [s] = lock ? await q.for('update') : await q;
  if (!s) throw fail(404, 'Reconciliation not found.');
  return s;
}
function assertOpen(s: any) { if (s.status !== 'InProgress') throw fail(400, 'This reconciliation is completed. Reopen it to change it.'); }

// The ledger lines of the bank's account that matter to a session: those still outstanding at its statement date, and those it cleared itself.
async function sessionLines(tx: any, companyId: string, s: any, glAccountId: string) {
  const res: any = await tx.execute(sql`
    SELECT rl.line_id AS "lineId", rl.journal_entry_id AS "entryId", rl.posting_date AS "postingDate", rl.reference_type AS "referenceType", rl.reference_id AS "referenceId",
           e.description, rl.debit::float8 AS debit, rl.credit::float8 AS credit, l.bank_reconciliation_id AS "reconciliationId", l.reconciled_at AS "reconciledAt",
           sl.id AS "statementLineId"
    FROM ${resolvedLines(companyId, { to: s.statementDate })}
    JOIN journal_lines l ON l.id = rl.line_id
    JOIN journal_entries e ON e.id = rl.journal_entry_id
    LEFT JOIN bank_reconciliations rr ON rr.id = l.bank_reconciliation_id AND rr.company_id = l.company_id
    LEFT JOIN bank_statement_lines sl ON sl.matched_journal_line_id = l.id AND sl.company_id = l.company_id
    WHERE rl.account_id = ${glAccountId}::uuid
      AND (l.bank_reconciliation_id IS NULL OR l.bank_reconciliation_id = ${s.id}::uuid OR rr.statement_date > ${s.statementDate}::date)
    ORDER BY rl.posting_date, rl.created_at, rl.line_id`);
  return res.rows.map((r: any) => ({
    lineId: r.lineId, entryId: r.entryId, postingDate: String(r.postingDate).slice(0, 10), referenceType: r.referenceType, referenceId: r.referenceId, description: r.description,
    debit: round2(Number(r.debit)), credit: round2(Number(r.credit)), cleared: r.reconciliationId === s.id, reconciledAt: r.reconciledAt, statementLineId: r.statementLineId || null,
  }));
}

async function sessionTotals(tx: any, companyId: string, s: any, glAccountId: string) {
  const res: any = await tx.execute(sql`
    SELECT COALESCE(SUM(rl.debit - rl.credit), 0)::float8 AS book,
           COALESCE(SUM(rl.debit - rl.credit) FILTER (WHERE l.bank_reconciliation_id = ${s.id}::uuid OR (rr.status = 'Completed' AND rr.statement_date < ${s.statementDate}::date)), 0)::float8 AS cleared
    FROM ${resolvedLines(companyId, { to: s.statementDate })}
    JOIN journal_lines l ON l.id = rl.line_id
    LEFT JOIN bank_reconciliations rr ON rr.id = l.bank_reconciliation_id AND rr.company_id = l.company_id
    WHERE rl.account_id = ${glAccountId}::uuid`);
  return { book: round2(Number(res.rows[0].book)), cleared: round2(Number(res.rows[0].cleared)) };
}

export async function sessionDetail(tx: any, companyId: string, id: string) {
  const s = await loadSession(tx, companyId, id);
  const { bank, account } = await bankLedgerAccount(tx, companyId, s.bankId);
  const lines = await sessionLines(tx, companyId, s, account.id);
  const stmt: any[] = await tx.select().from(schema.bankStatementLines).where(and(eq(schema.bankStatementLines.companyId, companyId), eq(schema.bankStatementLines.bankReconciliationId, id)))
    .orderBy(schema.bankStatementLines.statementDate, schema.bankStatementLines.createdAt);
  const totals = await sessionTotals(tx, companyId, s, account.id);
  const outstanding = lines.filter((l: any) => !l.cleared);
  const depositsInTransit = round2(outstanding.reduce((n: number, l: any) => n + l.debit, 0));
  const paymentsOutstanding = round2(outstanding.reduce((n: number, l: any) => n + l.credit, 0));
  const people = new Map<string, string>();
  const who = [s.createdById, s.completedById, s.reopenedById].filter(Boolean) as string[];
  if (who.length) for (const u of await tx.select({ id: schema.users.id, username: schema.users.username }).from(schema.users).where(inArray(schema.users.id, who))) people.set(u.id, u.username);
  const statementBalance = round2(Number(s.statementEndingBalance));
  const difference = round2(statementBalance - totals.cleared);
  const unmatched = stmt.filter(x => !x.isMatched).length;
  return {
    session: { id: s.id, bankId: s.bankId, statementDate: String(s.statementDate).slice(0, 10), statementEndingBalance: statementBalance, glBalanceAtReconciliation: s.glBalanceAtReconciliation == null ? null : Number(s.glBalanceAtReconciliation),
      status: s.status, notes: s.notes, createdAt: s.createdAt, completedAt: s.completedAt, reopenedAt: s.reopenedAt, reopenReason: s.reopenReason,
      createdByName: people.get(s.createdById) || '', completedByName: s.completedById ? people.get(s.completedById) || '' : '', reopenedByName: s.reopenedById ? people.get(s.reopenedById) || '' : '' },
    bank: { id: bank.id, name: bank.bankName, accountTitle: bank.accountTitle }, ledgerAccount: { id: account.id, code: account.code, name: account.name },
    lines,
    statementLines: stmt.map(x => ({ id: x.id, statementDate: String(x.statementDate).slice(0, 10), description: x.description, reference: x.reference, amount: Number(x.amount), matchedJournalLineId: x.matchedJournalLineId, isMatched: x.isMatched })),
    summary: {
      bookBalance: totals.book, clearedBalance: totals.cleared, statementBalance, depositsInTransit, paymentsOutstanding,
      adjustedStatementBalance: round2(statementBalance + depositsInTransit - paymentsOutstanding), difference, unmatchedStatementLines: unmatched,
      canComplete: s.status === 'InProgress' && Math.abs(difference) < 0.005 && unmatched === 0,
    },
  };
}

export async function listSessions(tx: any, companyId: string, bankId?: string | null) {
  const res: any = await tx.execute(sql`
    SELECT r.id, r.bank_id AS "bankId", b.bank_name AS "bankName", r.statement_date AS "statementDate", r.statement_ending_balance::float8 AS "statementEndingBalance", r.status,
           r.gl_balance_at_reconciliation::float8 AS "glBalanceAtReconciliation", r.completed_at AS "completedAt", r.created_at AS "createdAt",
           (SELECT COUNT(*)::int FROM journal_lines l WHERE l.company_id = r.company_id AND l.bank_reconciliation_id = r.id) AS "clearedLines"
    FROM bank_reconciliations r JOIN bank_accounts b ON b.id = r.bank_id
    WHERE r.company_id = ${companyId}::uuid ${bankId ? sql`AND r.bank_id = ${bankId}::uuid` : sql``}
    ORDER BY r.statement_date DESC, r.created_at DESC LIMIT 300`);
  return res.rows.map((r: any) => ({ ...r, statementDate: String(r.statementDate).slice(0, 10) }));
}

export async function createSession(tx: any, req: any, input: { bankId: string; statementDate: string; statementEndingBalance: number; notes?: string | null }) {
  const companyId = req.targetCompanyId;
  await bankLedgerAccount(tx, companyId, input.bankId);
  if (!DATE.test(input.statementDate || '')) throw fail(400, 'Enter the statement date.');
  const balance = Number(input.statementEndingBalance);
  if (!Number.isFinite(balance) || Math.abs(balance) > 999999999999) throw fail(400, 'Enter the statement ending balance.');
  const today = nowDate().toISOString().slice(0, 10);
  if (input.statementDate > today) throw fail(400, 'The statement date cannot be in the future.');
  const open: any[] = await tx.select({ id: schema.bankReconciliations.id }).from(schema.bankReconciliations).where(and(eq(schema.bankReconciliations.companyId, companyId), eq(schema.bankReconciliations.bankId, input.bankId), eq(schema.bankReconciliations.status, 'InProgress')));
  if (open.length) throw fail(400, 'This bank already has a reconciliation in progress. Complete or discard it first.');
  const last = await lastCompleted(tx, companyId, input.bankId);
  if (last && input.statementDate <= String(last.statementDate).slice(0, 10)) throw fail(400, `The statement date must be after ${String(last.statementDate).slice(0, 10)}, the date of the last completed reconciliation of this bank.`);
  const id = generateId();
  await tx.insert(schema.bankReconciliations).values({ id, companyId, bankId: input.bankId, statementDate: input.statementDate, statementEndingBalance: String(round2(balance)), status: 'InProgress',
    notes: input.notes ? String(input.notes).slice(0, 500) : null, createdAt: nowDate(), createdById: req.user.id });
  return id;
}

async function lastCompleted(tx: any, companyId: string, bankId: string) {
  const rows: any[] = await tx.select().from(schema.bankReconciliations).where(and(eq(schema.bankReconciliations.companyId, companyId), eq(schema.bankReconciliations.bankId, bankId), eq(schema.bankReconciliations.status, 'Completed')))
    .orderBy(sql`statement_date DESC, completed_at DESC`).limit(1);
  return rows[0] || null;
}

export async function updateSession(tx: any, req: any, id: string, input: { statementDate?: string; statementEndingBalance?: number; notes?: string | null }) {
  const companyId = req.targetCompanyId;
  const s = await loadSession(tx, companyId, id, true); assertOpen(s);
  const set: any = {};
  if (input.statementDate !== undefined) {
    if (!DATE.test(input.statementDate)) throw fail(400, 'Enter the statement date.');
    if (input.statementDate > nowDate().toISOString().slice(0, 10)) throw fail(400, 'The statement date cannot be in the future.');
    const last = await lastCompleted(tx, companyId, s.bankId);
    if (last && input.statementDate <= String(last.statementDate).slice(0, 10)) throw fail(400, `The statement date must be after ${String(last.statementDate).slice(0, 10)}.`);
    const { account } = await bankLedgerAccount(tx, companyId, s.bankId);
    const late: any = await tx.execute(sql`SELECT COUNT(*)::int AS n FROM ${resolvedLines(companyId, { from: input.statementDate })} JOIN journal_lines l ON l.id = rl.line_id
      WHERE rl.account_id = ${account.id}::uuid AND rl.posting_date > ${input.statementDate}::date AND l.bank_reconciliation_id = ${id}::uuid`);
    if (Number(late.rows[0].n) > 0) throw fail(400, 'Some lines already cleared in this reconciliation are dated after that statement date. Un-clear them first.');
    set.statementDate = input.statementDate;
  }
  if (input.statementEndingBalance !== undefined) {
    const b = Number(input.statementEndingBalance); if (!Number.isFinite(b) || Math.abs(b) > 999999999999) throw fail(400, 'Enter the statement ending balance.');
    set.statementEndingBalance = String(round2(b));
  }
  if (input.notes !== undefined) set.notes = input.notes ? String(input.notes).slice(0, 500) : null;
  if (Object.keys(set).length) await tx.update(schema.bankReconciliations).set(set).where(eq(schema.bankReconciliations.id, id));
}

// Ledger lines of the session's bank account that may be cleared in it: dated on or before the statement date and not cleared by another session.
async function eligibleLines(tx: any, companyId: string, s: any, glAccountId: string, lineIds: string[]) {
  if (!lineIds.length) return [];
  const res: any = await tx.execute(sql`
    SELECT rl.line_id AS "lineId", rl.debit::float8 AS debit, rl.credit::float8 AS credit, rl.posting_date AS "postingDate", l.bank_reconciliation_id AS "reconciliationId"
    FROM ${resolvedLines(companyId, { to: s.statementDate })} JOIN journal_lines l ON l.id = rl.line_id
    WHERE rl.account_id = ${glAccountId}::uuid AND rl.line_id IN (${ids(lineIds)})`);
  return res.rows.map((r: any) => ({ lineId: r.lineId as string, amount: round2(Number(r.debit) - Number(r.credit)), reconciliationId: r.reconciliationId as string | null }));
}

export async function clearLines(tx: any, req: any, id: string, lineIds: string[], clear: boolean) {
  const companyId = req.targetCompanyId;
  const s = await loadSession(tx, companyId, id, true); assertOpen(s);
  const { account } = await bankLedgerAccount(tx, companyId, s.bankId);
  const wanted = [...new Set((lineIds || []).filter((x: any) => typeof x === 'string'))];
  if (!wanted.length) throw fail(400, 'Choose at least one line.');
  const found = await eligibleLines(tx, companyId, s, account.id, wanted);
  if (found.length !== wanted.length) throw fail(400, 'A line does not belong to this bank account or is dated after the statement date.');
  if (clear) {
    if (found.some(f => f.reconciliationId && f.reconciliationId !== id)) throw fail(400, 'A line was already cleared in another reconciliation.');
    await tx.update(schema.journalLines).set({ bankReconciliationId: id, reconciledAt: nowDate() }).where(and(eq(schema.journalLines.companyId, companyId), inArray(schema.journalLines.id, wanted)));
  } else {
    if (found.some(f => f.reconciliationId !== id)) throw fail(400, 'Only lines cleared in this reconciliation can be un-cleared.');
    const matched: any[] = await tx.select({ id: schema.bankStatementLines.id }).from(schema.bankStatementLines).where(and(eq(schema.bankStatementLines.companyId, companyId), inArray(schema.bankStatementLines.matchedJournalLineId, wanted)));
    if (matched.length) throw fail(400, 'A line is matched to a statement line. Un-match it first.');
    await tx.update(schema.journalLines).set({ bankReconciliationId: null, reconciledAt: null }).where(and(eq(schema.journalLines.companyId, companyId), inArray(schema.journalLines.id, wanted)));
  }
  return { changed: wanted.length };
}

export async function addStatementLines(tx: any, req: any, id: string, raw: any[]) {
  const companyId = req.targetCompanyId;
  const s = await loadSession(tx, companyId, id, true); assertOpen(s);
  if (!Array.isArray(raw) || !raw.length) throw fail(400, 'There are no statement lines to add.');
  if (raw.length > 2000) throw fail(400, 'At most 2000 statement lines can be added at once.');
  const existing: any[] = await tx.select().from(schema.bankStatementLines).where(and(eq(schema.bankStatementLines.companyId, companyId), eq(schema.bankStatementLines.bankReconciliationId, id)));
  const key = (d: string, a: number, desc: string, ref: string) => `${d}|${a.toFixed(2)}|${desc}|${ref}`;
  const seen = new Map<string, number>();
  for (const x of existing) { const k = key(String(x.statementDate).slice(0, 10), Number(x.amount), x.description || '', x.reference || ''); seen.set(k, (seen.get(k) || 0) + 1); }
  let added = 0, skipped = 0; const rows: any[] = [];
  const batch = new Map<string, number>();
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] || {};
    const date = String(r.statementDate ?? r.date ?? '').slice(0, 10); const amount = round2(Number(r.amount)); const description = String(r.description ?? '').trim().slice(0, 200); const reference = String(r.reference ?? '').trim().slice(0, 80);
    if (!DATE.test(date)) throw fail(400, `Line ${i + 1}: enter a valid date (YYYY-MM-DD).`);
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 999999999999) throw fail(400, `Line ${i + 1}: enter an amount that is not zero.`);
    const k = key(date, amount, description, reference);
    // an identical line already in the session (a file imported twice) is skipped; identical lines inside one file are real (two equal fees on a day) and are kept
    batch.set(k, (batch.get(k) || 0) + 1);
    if ((seen.get(k) || 0) >= (batch.get(k) || 0)) { skipped++; continue; }
    rows.push({ id: generateId(), companyId, bankReconciliationId: id, statementDate: date, description, reference: reference || null, amount: String(amount), isMatched: false, createdAt: nowDate(), createdById: req.user.id });
    added++;
  }
  if (rows.length) await tx.insert(schema.bankStatementLines).values(rows);
  return { added, skipped };
}

export async function deleteStatementLine(tx: any, req: any, id: string, lineId: string) {
  const companyId = req.targetCompanyId;
  const s = await loadSession(tx, companyId, id, true); assertOpen(s);
  const [l] = await tx.select().from(schema.bankStatementLines).where(and(eq(schema.bankStatementLines.id, lineId), eq(schema.bankStatementLines.companyId, companyId), eq(schema.bankStatementLines.bankReconciliationId, id)));
  if (!l) throw fail(404, 'Statement line not found.');
  if (l.isMatched) throw fail(400, 'Un-match the statement line first.');
  await tx.delete(schema.bankStatementLines).where(eq(schema.bankStatementLines.id, lineId));
}

export async function matchLine(tx: any, req: any, id: string, statementLineId: string, journalLineId: string) {
  const companyId = req.targetCompanyId;
  const s = await loadSession(tx, companyId, id, true); assertOpen(s);
  const { account } = await bankLedgerAccount(tx, companyId, s.bankId);
  const [sl] = await tx.select().from(schema.bankStatementLines).where(and(eq(schema.bankStatementLines.id, statementLineId), eq(schema.bankStatementLines.companyId, companyId), eq(schema.bankStatementLines.bankReconciliationId, id))).for('update');
  if (!sl) throw fail(404, 'Statement line not found.');
  if (sl.isMatched) throw fail(400, 'That statement line is already matched.');
  const [line] = await eligibleLines(tx, companyId, s, account.id, [journalLineId]);
  if (!line) throw fail(400, 'That ledger line does not belong to this bank account or is dated after the statement date.');
  if (line.reconciliationId && line.reconciliationId !== id) throw fail(400, 'That ledger line was already cleared in another reconciliation.');
  if (Math.abs(line.amount - Number(sl.amount)) > 0.005) throw fail(400, `The amounts differ: the statement shows ${Number(sl.amount).toFixed(2)}, the ledger line ${line.amount.toFixed(2)}.`);
  const taken: any[] = await tx.select({ id: schema.bankStatementLines.id }).from(schema.bankStatementLines).where(and(eq(schema.bankStatementLines.companyId, companyId), eq(schema.bankStatementLines.matchedJournalLineId, journalLineId)));
  if (taken.length) throw fail(400, 'That ledger line is already matched to another statement line.');
  await tx.update(schema.bankStatementLines).set({ matchedJournalLineId: journalLineId, isMatched: true }).where(eq(schema.bankStatementLines.id, statementLineId));
  if (!line.reconciliationId) await tx.update(schema.journalLines).set({ bankReconciliationId: id, reconciledAt: nowDate() }).where(and(eq(schema.journalLines.id, journalLineId), eq(schema.journalLines.companyId, companyId)));
}

export async function unmatchLine(tx: any, req: any, id: string, statementLineId: string) {
  const companyId = req.targetCompanyId;
  const s = await loadSession(tx, companyId, id, true); assertOpen(s);
  const [sl] = await tx.select().from(schema.bankStatementLines).where(and(eq(schema.bankStatementLines.id, statementLineId), eq(schema.bankStatementLines.companyId, companyId), eq(schema.bankStatementLines.bankReconciliationId, id)));
  if (!sl) throw fail(404, 'Statement line not found.');
  if (!sl.isMatched) throw fail(400, 'That statement line is not matched.');
  await tx.update(schema.bankStatementLines).set({ matchedJournalLineId: null, isMatched: false }).where(eq(schema.bankStatementLines.id, statementLineId));
}

// Suggested pairs (never applied silently): an unmatched statement line and an uncleared ledger line of the same signed amount, within `windowDays` of each other, closest first.
export async function suggestions(tx: any, companyId: string, id: string, windowDays = 10) {
  const d = await sessionDetail(tx, companyId, id);
  const free = d.lines.filter((l: any) => !l.statementLineId && !l.cleared);
  const taken = new Set<string>(); const out: { statementLineId: string; journalLineId: string; dayDiff: number }[] = [];
  const day = (x: string) => Math.round(new Date(x + 'T00:00:00Z').getTime() / 86400000);
  const cands = d.statementLines.filter((x: any) => !x.isMatched).map((x: any) => {
    const m = free.filter((l: any) => Math.abs((l.debit - l.credit) - x.amount) < 0.005).map((l: any) => ({ l, diff: Math.abs(day(l.postingDate) - day(x.statementDate)) })).filter((c: any) => c.diff <= windowDays);
    return { x, m: m.sort((a: any, b: any) => a.diff - b.diff) };
  }).sort((a: any, b: any) => (a.m[0]?.diff ?? 999) - (b.m[0]?.diff ?? 999));
  for (const c of cands) {
    const pick = c.m.find((m: any) => !taken.has(m.l.lineId));
    if (pick) { taken.add(pick.l.lineId); out.push({ statementLineId: c.x.id, journalLineId: pick.l.lineId, dayDiff: pick.diff }); }
  }
  return out;
}

// A bank fee or bank interest found while reconciling (Blueprint FR-BANK-04): a voucher (every cash movement in this app is one, so each bank balance and the bank ledger carry it) and one
// ledger entry - the bank against a chosen income / expense account - cleared in the session at once and matched to the statement line it came from. Money out of the bank is a
// BankCharge (a cost), money in is BankInterest (income); only income and expense accounts are accepted, because those are the two things a bank can do to a company's books without a
// document behind it. A timing error or a wrong amount is put right on the document itself (cancel and re-enter), which the reconciliation then simply clears.
export async function postAdjustment(tx: any, req: any, id: string, input: { statementLineId?: string | null; date?: string; description?: string; amount?: number; accountId: string; dimensions?: any }) {
  const companyId = req.targetCompanyId;
  const s = await loadSession(tx, companyId, id, true); assertOpen(s);
  const { bank } = await bankLedgerAccount(tx, companyId, s.bankId);
  let sl: any = null;
  if (input.statementLineId) {
    [sl] = await tx.select().from(schema.bankStatementLines).where(and(eq(schema.bankStatementLines.id, input.statementLineId), eq(schema.bankStatementLines.companyId, companyId), eq(schema.bankStatementLines.bankReconciliationId, id))).for('update');
    if (!sl) throw fail(404, 'Statement line not found.');
    if (sl.isMatched) throw fail(400, 'That statement line is already matched.');
  }
  const amount = round2(sl ? Number(sl.amount) : Number(input.amount));
  if (!Number.isFinite(amount) || amount === 0) throw fail(400, 'Enter the amount of the entry (negative when money leaves the bank).');
  const date = String(input.date || (sl ? String(sl.statementDate).slice(0, 10) : '')).slice(0, 10);
  if (!DATE.test(date)) throw fail(400, 'Enter the date of the entry.');
  if (date > String(s.statementDate).slice(0, 10)) throw fail(400, 'The entry cannot be dated after the statement date.');
  const description = String(input.description || sl?.description || '').trim().slice(0, 200) || 'Bank reconciliation adjustment';
  const [counter] = await tx.select().from(schema.companyAccounts).where(and(eq(schema.companyAccounts.id, input.accountId), eq(schema.companyAccounts.companyId, companyId)));
  if (!counter) throw fail(400, 'Choose the account the entry is posted against.');
  if (!counter.isActive) throw fail(400, `Account ${counter.code} ${counter.name} is inactive.`);
  if (counter.isGroup) throw fail(400, `Account ${counter.code} ${counter.name} is a heading; choose an account under it.`);
  if (counter.type !== 'Expense' && counter.type !== 'Revenue') throw fail(400, 'A bank fee is posted to an expense account and bank interest to an income account. For anything else, correct the document it belongs to.');
  if (amount < 0 && counter.type !== 'Expense') throw fail(400, 'Money leaving the bank is a bank charge: choose an expense account.');
  if (amount > 0 && counter.type !== 'Revenue') throw fail(400, 'Money coming into the bank is interest or income: choose an income account.');
  const abs = Math.abs(amount);
  const refType = amount < 0 ? 'BankCharge' : 'BankInterest';
  const voucherId = generateId();
  const voucherNumber = await getAndIncrementDocumentNumber(tx, companyId, 'voucher', date, null);
  await tx.insert(schema.vouchers).values({
    id: voucherId, voucherNumber, type: amount < 0 ? 'Payment' : 'Receipt', ...documentDates(date), bankId: bank.id, amount: String(abs),
    description: `${description} (bank reconciliation)`.slice(0, 250), referenceType: refType, referenceId: voucherId, createdById: req.user.id, createdAt: nowDate(), companyId, branchId: null,
  });
  const entryId = await postJournalEntry(tx, {
    companyId, branchId: null, postingDate: date, referenceType: refType, referenceId: voucherId, description: `${voucherNumber}: ${description}`, createdById: req.user.id,
    dimensions: input.dimensions && typeof input.dimensions === 'object' ? input.dimensions : undefined, dimensionMode: 'defaults',
    lines: amount > 0 ? [{ accountKey: 'BANK', bankId: bank.id, debit: abs }, { accountId: counter.id, credit: abs }] : [{ accountId: counter.id, debit: abs }, { accountKey: 'BANK', bankId: bank.id, credit: abs }],
  });
  const [bl] = await tx.select({ id: schema.journalLines.id }).from(schema.journalLines).where(and(eq(schema.journalLines.journalEntryId, entryId), eq(schema.journalLines.companyId, companyId), eq(schema.journalLines.bankId, bank.id)));
  if (!bl) throw fail(500, 'The entry was posted but its bank line could not be found.');
  await tx.update(schema.journalLines).set({ bankReconciliationId: id, reconciledAt: nowDate() }).where(eq(schema.journalLines.id, bl.id));
  if (sl) await tx.update(schema.bankStatementLines).set({ matchedJournalLineId: bl.id, isMatched: true }).where(eq(schema.bankStatementLines.id, sl.id));
  return { voucherId, voucherNumber, entryId, lineId: bl.id, amount };
}

// Takes a bank fee / interest entry back while its reconciliation is still open: the line is un-matched and un-cleared, then the entry is reversed (a Reversal voucher and a mirror
// entry), which leaves two lines that cancel out and stay uncleared.
export async function reverseAdjustment(tx: any, req: any, id: string, voucherId: string, reason: string) {
  const companyId = req.targetCompanyId;
  const s = await loadSession(tx, companyId, id, true); assertOpen(s);
  const [v] = await tx.select().from(schema.vouchers).where(and(eq(schema.vouchers.id, voucherId), eq(schema.vouchers.companyId, companyId), inArray(schema.vouchers.referenceType, ['BankCharge', 'BankInterest'])));
  if (!v || v.type === 'Reversal') throw fail(404, 'Bank charge or interest not found.');
  const [done] = await tx.select({ id: schema.vouchers.id }).from(schema.vouchers).where(and(eq(schema.vouchers.companyId, companyId), eq(schema.vouchers.reversalOfVoucherId, v.id)));
  if (done) throw fail(400, 'That entry has already been reversed.');
  const lines: any[] = await tx.select({ id: schema.journalLines.id, rec: schema.journalLines.bankReconciliationId }).from(schema.journalLines)
    .innerJoin(schema.journalEntries, and(eq(schema.journalEntries.id, schema.journalLines.journalEntryId), eq(schema.journalEntries.companyId, schema.journalLines.companyId)))
    .where(and(eq(schema.journalLines.companyId, companyId), eq(schema.journalEntries.referenceType, v.referenceType), eq(schema.journalEntries.referenceId, v.id), eq(schema.journalLines.bankId, v.bankId)));
  if (lines.some(l => l.rec && l.rec !== id)) throw fail(400, 'That entry was cleared in another reconciliation.');
  const lineIds = lines.map(l => l.id);
  if (lineIds.length) {
    await tx.update(schema.bankStatementLines).set({ matchedJournalLineId: null, isMatched: false }).where(and(eq(schema.bankStatementLines.companyId, companyId), inArray(schema.bankStatementLines.matchedJournalLineId, lineIds)));
    await tx.update(schema.journalLines).set({ bankReconciliationId: null, reconciledAt: null }).where(and(eq(schema.journalLines.companyId, companyId), inArray(schema.journalLines.id, lineIds)));
  }
  const date = String(s.statementDate).slice(0, 10) < String(v.postingDate).slice(0, 10) ? String(v.postingDate).slice(0, 10) : String(s.statementDate).slice(0, 10);
  await reverseAllEntriesFor(tx, companyId, v.referenceType, v.id, date, `${v.voucherNumber} reversed${reason ? `: ${reason}` : ''}`.slice(0, 250), req.user.id);
  const voucherNumber = await getAndIncrementDocumentNumber(tx, companyId, 'voucher', date, null);
  await tx.insert(schema.vouchers).values({
    id: generateId(), voucherNumber, type: 'Reversal', ...documentDates(date), bankId: v.bankId, amount: v.amount, description: `Reversal of ${v.voucherNumber}${reason ? `: ${reason}` : ''}`.slice(0, 250),
    referenceType: v.referenceType, referenceId: v.id, createdById: req.user.id, createdAt: nowDate(), companyId, branchId: null, reversalOfVoucherId: v.id,
  });
  return { voucherNumber };
}

export async function completeSession(tx: any, req: any, id: string) {
  const companyId = req.targetCompanyId;
  const s = await loadSession(tx, companyId, id, true); assertOpen(s);
  const d = await sessionDetail(tx, companyId, id);
  if (d.summary.unmatchedStatementLines > 0) throw fail(400, `${d.summary.unmatchedStatementLines} statement line(s) are not matched yet.`);
  if (Math.abs(d.summary.difference) >= 0.005) throw fail(400, `The reconciliation does not balance: the statement shows ${d.summary.statementBalance.toFixed(2)}, the cleared lines add up to ${d.summary.clearedBalance.toFixed(2)} (difference ${d.summary.difference.toFixed(2)}). Post an entry for what is missing; do not force it.`);
  await tx.update(schema.bankReconciliations).set({ status: 'Completed', glBalanceAtReconciliation: String(d.summary.bookBalance), completedAt: nowDate(), completedById: req.user.id }).where(eq(schema.bankReconciliations.id, id));
  return { bookBalance: d.summary.bookBalance, clearedLines: d.lines.filter((l: any) => l.cleared).length };
}

export async function reopenSession(tx: any, req: any, id: string, reason: string) {
  const companyId = req.targetCompanyId;
  const s = await loadSession(tx, companyId, id, true);
  if (s.status !== 'Completed') throw fail(400, 'This reconciliation is not completed.');
  const r = String(reason || '').trim().slice(0, 300);
  if (!r) throw fail(400, 'Write the reason for reopening.');
  const last = await lastCompleted(tx, companyId, s.bankId);
  if (last && last.id !== id) throw fail(400, `Only the latest completed reconciliation of a bank can be reopened (the one dated ${String(last.statementDate).slice(0, 10)}).`);
  const open: any[] = await tx.select({ id: schema.bankReconciliations.id }).from(schema.bankReconciliations).where(and(eq(schema.bankReconciliations.companyId, companyId), eq(schema.bankReconciliations.bankId, s.bankId), eq(schema.bankReconciliations.status, 'InProgress')));
  if (open.length) throw fail(400, 'This bank has another reconciliation in progress. Complete or discard it first.');
  await tx.update(schema.bankReconciliations).set({ status: 'InProgress', reopenedAt: nowDate(), reopenedById: req.user.id, reopenReason: r, completedAt: null, completedById: null, glBalanceAtReconciliation: null }).where(eq(schema.bankReconciliations.id, id));
  return { bankId: s.bankId, statementDate: String(s.statementDate).slice(0, 10) };
}

export async function discardSession(tx: any, req: any, id: string) {
  const companyId = req.targetCompanyId;
  const s = await loadSession(tx, companyId, id, true); assertOpen(s);
  await tx.update(schema.journalLines).set({ bankReconciliationId: null, reconciledAt: null }).where(and(eq(schema.journalLines.companyId, companyId), eq(schema.journalLines.bankReconciliationId, id)));
  await tx.delete(schema.bankStatementLines).where(and(eq(schema.bankStatementLines.companyId, companyId), eq(schema.bankStatementLines.bankReconciliationId, id)));
  await tx.delete(schema.bankReconciliations).where(eq(schema.bankReconciliations.id, id));
}
