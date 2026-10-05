// Phase 1 of the real General Ledger (Invoice + Credit Note only — see the Procurement
// Ledger Review doc's Phase 1 design for the full posting-rules table, currently 19
// transaction types, and every decision behind this). Every report that needs a real,
// reconciling account balance (AR, Sales Revenue, VAT Output, COGS, Inventory) is meant
// to eventually read from journalLines, never straight from invoices/invoiceItems — the
// same way vouchers already exist for cash movement but nothing else did before this.
//
// This file is the ONLY place that ever inserts into journalEntries/journalLines —
// every document-creation route calls postJournalEntry() or reverseAllEntriesFor(),
// never the tables directly, so "can this ever get out of balance" has one, auditable
// answer.
import * as schema from '../../src/db/schema.js';
import { eq, and, inArray, gte, lte } from 'drizzle-orm';
import { generateId } from '../../src/id.js';
import { round2 } from './businessLogic.js';

// Anything larger than this is a real bug in the calling code, not rounding noise from
// splitting a tax-exclusive-subtotal-plus-tax across several independently-round2'd
// lines — it throws instead of silently absorbing a real imbalance.
const ROUNDING_MATERIALITY_CEILING = 0.05;

export interface JournalLineInput {
  accountKey: string;
  debit?: number;
  credit?: number;
  // Set only when accountKey === 'BANK' — Bank isn't one pooled account, it's N separate
  // ones, same as vouchers.bankId.
  bankId?: string | null;
}

export interface PostJournalEntryInput {
  companyId: string;
  branchId?: string | null;
  date: string;
  referenceType: string;
  referenceId: string;
  relatedReferenceType?: string | null;
  relatedReferenceId?: string | null;
  reversalOfId?: string | null;
  description: string;
  createdById: string;
  lines: JournalLineInput[];
}

// Posts one balanced journal entry. Throws before writing anything if the lines don't
// balance beyond the rounding-materiality ceiling above — a real bug in the caller, not
// something this function should ever silently paper over.
export async function postJournalEntry(tx: any, input: PostJournalEntryInput): Promise<string> {
  const totalDebit = round2(input.lines.reduce((s, l) => s + (l.debit || 0), 0));
  const totalCredit = round2(input.lines.reduce((s, l) => s + (l.credit || 0), 0));
  const diff = round2(totalDebit - totalCredit);

  const finalLines = [...input.lines];
  if (Math.abs(diff) > 0.001) {
    if (Math.abs(diff) > ROUNDING_MATERIALITY_CEILING) {
      const err: any = new Error(
        `Journal entry does not balance: debits ${totalDebit} vs credits ${totalCredit} (diff ${diff}) for ${input.referenceType} ${input.referenceId} — this exceeds the rounding-materiality ceiling and is a real bug, not rounding noise.`
      );
      err.status = 500;
      throw err;
    }
    // diff > 0 means debits exceed credits — add a credit line for the shortfall, and
    // vice versa. Posted to the dedicated Rounding Adjustment account so the discrepancy
    // stays visible and auditable rather than hidden.
    if (diff > 0) finalLines.push({ accountKey: 'ROUNDING_ADJUSTMENT', credit: diff });
    else finalLines.push({ accountKey: 'ROUNDING_ADJUSTMENT', debit: round2(-diff) });
  }

  // A zero-amount line is never valid (the exactly-one-side check constraint would
  // reject it anyway) — filter defensively rather than let a caller's rounding-to-zero
  // line reach the database as an error.
  const realLines = finalLines.filter(l => round2(l.debit || 0) > 0 || round2(l.credit || 0) > 0);
  if (realLines.length === 0) {
    const err: any = new Error(`Journal entry for ${input.referenceType} ${input.referenceId} has no non-zero lines — nothing to post.`);
    err.status = 500;
    throw err;
  }

  const entryId = generateId();
  await tx.insert(schema.journalEntries).values({
    id: entryId,
    companyId: input.companyId,
    branchId: input.branchId || null,
    date: input.date,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    relatedReferenceType: input.relatedReferenceType || null,
    relatedReferenceId: input.relatedReferenceId || null,
    reversalOfId: input.reversalOfId || null,
    description: input.description,
    createdById: input.createdById,
    createdAt: new Date(),
  });
  await tx.insert(schema.journalLines).values(realLines.map(l => ({
    id: generateId(),
    journalEntryId: entryId,
    companyId: input.companyId,
    accountKey: l.accountKey,
    debit: String(round2(l.debit || 0)),
    credit: String(round2(l.credit || 0)),
    bankId: l.bankId || null,
  })));
  return entryId;
}

// Reverses every NOT-YET-reversed journal entry for one source document, posting a
// mirrored, sign-flipped entry for each — structurally closes the "only reverses the
// first voucher found" bug class (Findings 7/8 in the review): there is no first-row
// destructure here, every matching entry gets its own reversal.
export async function reverseAllEntriesFor(
  tx: any,
  companyId: string,
  referenceType: string,
  referenceId: string,
  date: string,
  description: string,
  createdById: string
): Promise<string[]> {
  const entries = await tx.select().from(schema.journalEntries).where(and(
    eq(schema.journalEntries.companyId, companyId),
    eq(schema.journalEntries.referenceType, referenceType),
    eq(schema.journalEntries.referenceId, referenceId),
  ));
  if (entries.length === 0) return [];

  const entryIds = entries.map((e: any) => e.id);
  const reversalRows = await tx.select({ reversalOfId: schema.journalEntries.reversalOfId })
    .from(schema.journalEntries)
    .where(inArray(schema.journalEntries.reversalOfId, entryIds));
  const alreadyReversed = new Set(reversalRows.map((r: any) => r.reversalOfId));
  const toReverse = entries.filter((e: any) => !alreadyReversed.has(e.id));

  const newIds: string[] = [];
  for (const entry of toReverse) {
    const lines = await tx.select().from(schema.journalLines).where(eq(schema.journalLines.journalEntryId, entry.id));
    // Mirror image: what was a debit becomes a credit and vice versa, same amounts —
    // this is what makes a reversal use the ORIGINAL entry's own recorded amounts,
    // never recomputed from today's data (e.g. a product's averageCost may have
    // changed since the original sale).
    const reversedLines: JournalLineInput[] = lines.map((l: any) => ({
      accountKey: l.accountKey,
      debit: Number(l.credit) > 0 ? Number(l.credit) : undefined,
      credit: Number(l.debit) > 0 ? Number(l.debit) : undefined,
      bankId: l.bankId || undefined,
    }));
    const newId = await postJournalEntry(tx, {
      companyId,
      branchId: entry.branchId,
      date,
      referenceType: entry.referenceType,
      referenceId: entry.referenceId,
      reversalOfId: entry.id,
      description,
      createdById,
      lines: reversedLines,
    });
    newIds.push(newId);
  }
  return newIds;
}

// SUM(debit) - SUM(credit) for one account, scoped to a company (and optionally a date
// range and/or a set of branch ids, matching resolveBranchIds()' null-means-unrestricted
// convention used everywhere else in this app). Positive = a debit balance, negative = a
// credit balance — callers that need a specific sign convention (e.g. a Balance Sheet's
// Accounts Payable, a normal-credit account, wants this negated for display) do that
// themselves; this function stays a neutral, literal sum.
export async function sumAccountBalance(
  executor: any,
  companyId: string,
  accountKey: string,
  opts: { startDate?: string; endDate?: string; branchIds?: string[] | null } = {}
): Promise<number> {
  const needsBranchId = opts.branchIds !== undefined && opts.branchIds !== null;
  const needsJoin = !!opts.startDate || !!opts.endDate || needsBranchId;

  const baseConditions = [eq(schema.journalLines.companyId, companyId), eq(schema.journalLines.accountKey, accountKey)];
  if (!needsJoin) {
    const rows = await executor.select({ debit: schema.journalLines.debit, credit: schema.journalLines.credit })
      .from(schema.journalLines).where(and(...baseConditions));
    let total = 0;
    for (const r of rows as any[]) total = round2(total + Number(r.debit) - Number(r.credit));
    return total;
  }

  const joinConditions = [...baseConditions];
  if (opts.startDate) joinConditions.push(gte(schema.journalEntries.date, opts.startDate));
  if (opts.endDate) joinConditions.push(lte(schema.journalEntries.date, opts.endDate));
  const rows = await executor.select({
    debit: schema.journalLines.debit, credit: schema.journalLines.credit, branchId: schema.journalEntries.branchId,
  })
    .from(schema.journalLines)
    .innerJoin(schema.journalEntries, eq(schema.journalLines.journalEntryId, schema.journalEntries.id))
    .where(and(...joinConditions));

  const branchOk = (branchId: string | null | undefined) => !needsBranchId || branchId == null || opts.branchIds!.includes(branchId);
  let total = 0;
  for (const r of rows as any[]) {
    if (!branchOk(r.branchId)) continue;
    total = round2(total + Number(r.debit) - Number(r.credit));
  }
  return total;
}
