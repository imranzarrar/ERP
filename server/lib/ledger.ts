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
import { eq, and, inArray, gte, lte, isNotNull } from 'drizzle-orm';
import { generateId } from '../../src/id.js';
import { round2 } from './businessLogic.js';
import { toBaseQuantity } from './uomConversion.js';
import { nowDate } from './clock.js';
import { applyRules, loadRules, loadTypes, resolveCombination, type Tags } from './dimensions.js';
import { loadPostingProfile, partyOfDocument, type PostingContext, type PostingProfile } from './postingContext.js';

// Anything larger than this is a real bug in the calling code, not rounding noise from
// splitting a tax-exclusive-subtotal-plus-tax across several independently-round2'd
// lines — it throws instead of silently absorbing a real imbalance.
const ROUNDING_MATERIALITY_CEILING = 0.05;

export interface JournalLineInput {
  // A document names its posting role (accountKey); a manual journal or an opening entry names a company account directly (accountId) and has no key.
  accountKey?: string | null;
  // Optional override for a keyed line: a finer account than the role's default (e.g. an expense category's own account).
  accountId?: string | null;
  debit?: number;
  credit?: number;
  // Set only when accountKey === 'BANK' — Bank isn't one pooled account, it's N separate
  // ones, same as vouchers.bankId.
  bankId?: string | null;
  // Dimension tags of this line (dimensionTypeId -> entityId), merged over the entry's own tags. A manual journal passes the combination it already
  // resolved and validated instead.
  dimensions?: Tags;
  dimensionCombinationId?: string | null;
  // The party of a receivable / payable line. Normally left out: the engine sets it on every line that posts to a customer or vendor control account, from the party of the
  // source document. A reversal passes the original line's party.
  customerId?: string | null;
  vendorId?: string | null;
}

export interface PostJournalEntryInput {
  companyId: string;
  branchId?: string | null;
  // The date the ledger and every period lock use (posting_date). docDate is the date of the source document; it defaults to the posting date.
  postingDate: string;
  docDate?: string | null;
  referenceType: string;
  referenceId: string;
  relatedReferenceType?: string | null;
  relatedReferenceId?: string | null;
  reversalOfId?: string | null;
  description: string;
  createdById: string;
  lines: JournalLineInput[];
  // Tags every line of the entry starts from (e.g. the document's own Department / Project).
  dimensions?: Tags;
  // 'strict' (manual journals): a Required tag that is missing, or a Not-allowed tag that is present, is an error. 'defaults' (documents, until their
  // forms collect dimensions): defaults fill gaps, Not-allowed tags are dropped, Required is not enforced.
  dimensionMode?: 'strict' | 'defaults';
  // Whose document this is. Normally left out: the customer or vendor is read from the source document (referenceType / referenceId), so the receivable
  // or payable line lands on that party's control account and the party's default dimensions apply. Pass it only for a document with no table of its own.
  context?: PostingContext;
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

  // Stamp every line with the company account it posts to AT THIS MOMENT (the role's current account, the bank's own account, or the explicit
  // account). A later change of Account Mapping therefore only affects postings made after it; entries already posted keep their account.
  const party = input.context ?? await partyOfDocument(tx, input.companyId, input.referenceType, input.referenceId);
  const profile = await loadPostingProfile(tx, input.companyId, party, [...new Set(realLines.map(l => l.bankId).filter(Boolean) as string[])]);
  const accountIds = await resolveLineAccountIds(tx, input.companyId, realLines, profile);
  const combinationIds = await resolveLineCombinations(tx, input, realLines, accountIds, profile);
  const partyTags = await resolvePartyTags(tx, input.companyId, realLines, accountIds, party);

  const entryId = generateId();
  await tx.insert(schema.journalEntries).values({
    id: entryId,
    companyId: input.companyId,
    branchId: input.branchId || null,
    postingDate: input.postingDate, docDate: input.docDate || input.postingDate,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    relatedReferenceType: input.relatedReferenceType || null,
    relatedReferenceId: input.relatedReferenceId || null,
    reversalOfId: input.reversalOfId || null,
    description: input.description,
    createdById: input.createdById,
    createdAt: nowDate(),
  });
  await tx.insert(schema.journalLines).values(realLines.map((l, i) => ({
    id: generateId(),
    journalEntryId: entryId,
    companyId: input.companyId,
    accountKey: l.accountKey || null,
    accountId: accountIds[i],
    debit: String(round2(l.debit || 0)),
    credit: String(round2(l.credit || 0)),
    bankId: l.bankId || null,
    dimensionCombinationId: combinationIds[i],
    customerId: partyTags[i].customerId,
    vendorId: partyTags[i].vendorId,
  })));
  return entryId;
}

// The customer / vendor of each line: a line on a customer control account belongs to the document's customer, on a vendor control account to its vendor (Blueprint
// FR-APR-06). A reversal carries the original line's party. Lines on any other account carry none.
async function resolvePartyTags(tx: any, companyId: string, lines: JournalLineInput[], accountIds: (string | null)[], party: PostingContext): Promise<{ customerId: string | null; vendorId: string | null }[]> {
  const ids = [...new Set(accountIds.filter(Boolean) as string[])];
  const kind = new Map<string, string | null>();
  if (ids.length && (party.customerId || party.vendorId || lines.some(l => l.customerId || l.vendorId))) {
    const rows = await tx.select({ id: schema.companyAccounts.id, t: schema.companyAccounts.subledgerType }).from(schema.companyAccounts).where(and(eq(schema.companyAccounts.companyId, companyId), inArray(schema.companyAccounts.id, ids)));
    for (const r of rows) kind.set(r.id, r.t);
  }
  return lines.map((l, i) => {
    const t = accountIds[i] ? kind.get(accountIds[i] as string) : null;
    return {
      customerId: l.customerId ?? (t === 'customer' ? party.customerId || null : null),
      vendorId: l.vendorId ?? (t === 'vendor' ? party.vendorId || null : null),
    };
  });
}

// Each line's dimension combination: explicit tags over the entry's tags, then the account rules (defaults, Not allowed, Required). Lines without any tag
// and without a rule that adds one get null, and a company that uses no dimensions pays for one small query only.
async function resolveLineCombinations(tx: any, input: PostJournalEntryInput, lines: JournalLineInput[], accountIds: (string | null)[], profile: PostingProfile): Promise<(string | null)[]> {
  const entryTags = input.dimensions || {};
  const anyTags = Object.keys(entryTags).length > 0 || Object.keys(profile.partyTags).length > 0 || lines.some(l => l.dimensionCombinationId || (l.dimensions && Object.keys(l.dimensions).length > 0) || Object.keys(profile.bankTags(l.bankId)).length > 0);
  const rules = await loadRules(tx, input.companyId, accountIds.filter(Boolean) as string[]);
  if (!anyTags && rules.size === 0) return lines.map(() => null);
  const types = await loadTypes(tx, input.companyId);
  const nameOf = new Map<string, string>(types.map((t: any) => [t.id, t.name]));
  const mode = input.dimensionMode || 'defaults';
  const cache = new Map<string, string | null>();
  const out: (string | null)[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.dimensionCombinationId) { out.push(l.dimensionCombinationId); continue; }
    const accountRules = accountIds[i] ? rules.get(accountIds[i] as string) : undefined;
    // priority, highest first: the line's own tags, the document's, the party's, the bank's, then the account's own default (applyRules)
    const tags = applyRules(accountRules, { ...profile.bankTags(l.accountKey === 'BANK' ? l.bankId : null), ...profile.partyTags, ...entryTags, ...(l.dimensions || {}) }, mode, { type: id => nameOf.get(id) || 'Dimension' });
    const key = JSON.stringify(Object.keys(tags).sort().map(k => [k, tags[k]]));
    if (!cache.has(key)) cache.set(key, await resolveCombination(tx, input.companyId, tags));
    out.push(cache.get(key) ?? null);
  }
  return out;
}

// Which company account each line posts to now. null when the company has no chart yet (reports then fall back to resolving by role).
export async function resolveLineAccountIds(tx: any, companyId: string, lines: JournalLineInput[], profile?: PostingProfile): Promise<(string | null)[]> {
  const keys = [...new Set(lines.map(l => l.accountKey).filter(Boolean) as string[])];
  const bankIds = [...new Set(lines.map(l => l.bankId).filter(Boolean) as string[])];
  const byKey = new Map<string, string>();
  const byBank = new Map<string, string>();
  if (keys.length > 0 || bankIds.length > 0) {
    const rows = await tx.select({ id: schema.companyAccounts.id, systemKey: schema.companyAccounts.systemKey, bankId: schema.companyAccounts.bankId })
      .from(schema.companyAccounts).where(eq(schema.companyAccounts.companyId, companyId));
    for (const r of rows) {
      if (r.systemKey && keys.includes(r.systemKey)) byKey.set(r.systemKey, r.id);
      if (r.bankId && bankIds.includes(r.bankId)) byBank.set(r.bankId, r.id);
    }
  }
  return lines.map(l => {
    if (l.accountId) return l.accountId;
    const own = profile?.controlAccountOf(l.accountKey);
    if (own) return own; // the customer's or vendor's own control account
    if (l.accountKey === 'BANK' && l.bankId && byBank.has(l.bankId)) return byBank.get(l.bankId)!;
    return l.accountKey ? (byKey.get(l.accountKey) || null) : null;
  });
}

// Reverses every NOT-YET-reversed journal entry for one source document, posting a
// mirrored, sign-flipped entry for each — structurally closes the "only reverses the
// first voucher found" bug class (Findings 7/8 in the review): there is no first-row
// destructure here, every matching entry gets its own reversal.
// An entry with a line that a bank reconciliation has cleared cannot be reversed: the bank has already confirmed that movement (Blueprint FR-BANK-05). Un-clear the line, or reopen the
// reconciliation (needs its own permission), then cancel the document.
export async function assertNoReconciledLines(tx: any, companyId: string, entryIds: string[]) {
  if (!entryIds.length) return;
  const rows: any[] = await tx.select({ id: schema.journalLines.id }).from(schema.journalLines)
    .where(and(eq(schema.journalLines.companyId, companyId), inArray(schema.journalLines.journalEntryId, entryIds), isNotNull(schema.journalLines.bankReconciliationId))).limit(1);
  if (rows.length) throw Object.assign(new Error('A bank line of this document was cleared in a bank reconciliation, so it cannot be cancelled. Open that reconciliation, un-clear the line (or ask someone with permission to reopen it), then cancel.'), { status: 400 });
}

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
  await assertNoReconciledLines(tx, companyId, toReverse.map((e: any) => e.id));

  const newIds: string[] = [];
  for (const entry of toReverse) {
    const lines = await tx.select().from(schema.journalLines).where(eq(schema.journalLines.journalEntryId, entry.id));
    // Mirror image: what was a debit becomes a credit and vice versa, same amounts —
    // this is what makes a reversal use the ORIGINAL entry's own recorded amounts,
    // never recomputed from today's data (e.g. a product's averageCost may have
    // changed since the original sale).
    const reversedLines: JournalLineInput[] = lines.map((l: any) => ({
      accountKey: l.accountKey,
      accountId: l.accountId || undefined,
      debit: Number(l.credit) > 0 ? Number(l.credit) : undefined,
      credit: Number(l.debit) > 0 ? Number(l.debit) : undefined,
      bankId: l.bankId || undefined,
      dimensionCombinationId: l.dimensionCombinationId || undefined,
      customerId: l.customerId || undefined,
      vendorId: l.vendorId || undefined,
    }));
    const newId = await postJournalEntry(tx, {
      companyId,
      branchId: entry.branchId,
      postingDate: date,
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

// Stock that is lost or found without any money changing hands — a stock-take shortage, a manual adjustment — still changes
// what the inventory is worth, so it must reach the profit and loss. Without this the units left inventory (or appeared in it)
// and the Balance Sheet stopped balancing by exactly their cost. Valued at the product's average cost, booked to cost of goods
// sold like every other inventory release: a shortage debits cost and credits inventory, a gain does the reverse.
// `quantityChange` is in BASE units: negative = lost, positive = found.
export async function postInventoryAdjustment(tx: any, input: {
  companyId: string; branchId?: string | null; date: string; productId: string; quantityChange: number;
  referenceType: string; referenceId: string; description: string; createdById: string;
}): Promise<void> {
  if (!input.quantityChange) return;
  const [product] = await tx.select({ averageCost: schema.productsServices.averageCost })
    .from(schema.productsServices).where(eq(schema.productsServices.id, input.productId));
  const cost = round2(Math.abs(input.quantityChange) * Number(product?.averageCost || 0));
  if (cost <= 0) return;
  await postJournalEntry(tx, {
    companyId: input.companyId, branchId: input.branchId ?? null, postingDate: input.date,
    referenceType: input.referenceType, referenceId: input.referenceId,
    description: input.description, createdById: input.createdById,
    lines: input.quantityChange < 0
      ? [{ accountKey: 'COGS', debit: cost }, { accountKey: 'INVENTORY', credit: cost }]
      : [{ accountKey: 'INVENTORY', debit: cost }, { accountKey: 'COGS', credit: cost }],
  });
}

// Goods dispatched between warehouses and not yet received are still the company's stock: they have left the sending warehouse and are not in
// the receiving one yet, so they are counted here (base units) wherever stock is valued.
export async function inTransitQuantity(tx: any, companyId: string, productId: string): Promise<number> {
  const rows: any[] = await tx.select({ q: schema.warehouseDispatchItems.quantityDispatched, uom: schema.warehouseDispatchItems.unitOfMeasureId })
    .from(schema.warehouseDispatchItems)
    .innerJoin(schema.warehouseDispatches, eq(schema.warehouseDispatchItems.dispatchId, schema.warehouseDispatches.id))
    .where(and(
      eq(schema.warehouseDispatches.companyId, companyId), eq(schema.warehouseDispatches.status, 'Dispatched'),
      eq(schema.warehouseDispatchItems.productId, productId),
    ));
  let total = 0;
  for (const r of rows) total += await toBaseQuantity(tx, productId, r.uom, companyId, Number(r.q || 0));
  return round2(total);
}

// Quantity of one product the company owns: on hand across every warehouse and batch, plus goods in transit.
export async function totalOnHand(tx: any, companyId: string, productId: string): Promise<number> {
  const rows: any[] = await tx.select({ q: schema.inventoryStocks.quantity }).from(schema.inventoryStocks).where(and(
    eq(schema.inventoryStocks.companyId, companyId), eq(schema.inventoryStocks.productId, productId),
  ));
  return round2(rows.reduce((s, r) => s + Number(r.q || 0), 0) + await inTransitQuantity(tx, companyId, productId));
}

// Quantity on hand and average cost of several products, for settleInventoryValuation (taken before a stock-moving flow, compared after).
export async function snapshotInventory(tx: any, companyId: string, productIds: string[]): Promise<Map<string, { qty: number; avg: number; val: number }>> {
  const out = new Map<string, { qty: number; avg: number; val: number }>();
  for (const productId of Array.from(new Set(productIds.filter(Boolean)))) {
    const [p] = await tx.select({ avg: schema.productsServices.averageCost, kind: schema.productsServices.itemKind }).from(schema.productsServices).where(eq(schema.productsServices.id, productId));
    if (!p || p.kind !== 'item') continue;
    const qty = await totalOnHand(tx, companyId, productId);
    out.set(productId, { qty, avg: Number(p.avg || 0), val: round2(qty * Number(p.avg || 0)) });   // a product's stock is valued in WHOLE CENTS, so movements telescope exactly
  }
  return out;
}
async function inventoryNetOfEntries(tx: any, entryIds: string[]): Promise<number> {
  if (!entryIds.length) return 0;
  const rows: any[] = await tx.select({ dr: schema.journalLines.debit, cr: schema.journalLines.credit }).from(schema.journalLines)
    .where(and(inArray(schema.journalLines.journalEntryId, entryIds), eq(schema.journalLines.accountKey, 'INVENTORY')));
  return round2(rows.reduce((s, r) => s + Number(r.dr) - Number(r.cr), 0));
}

// The same rule for any flow that moves stock or changes an average cost (receipt reversal, vendor return and its cancel, credit note, cancel,
// POS return ...): the valuation of the products touched, after the flow, less before, minus what the flow itself posted to INVENTORY (the
// entries it created: `entryIds`) is booked to cost of goods sold, so Inventory = quantity x average cost holds after every movement.
export async function settleInventoryValuation(tx: any, input: {
  companyId: string; branchId?: string | null; date: string; before: Map<string, { qty: number; avg: number; val: number }>; entryIds: string[];
  referenceType: string; referenceId: string; description: string; createdById: string;
}): Promise<number> {
  const after = await snapshotInventory(tx, input.companyId, Array.from(input.before.keys()));
  let docChange = 0;
  for (const [productId, b] of input.before) {
    const a = after.get(productId) || b;
    docChange += a.val - b.val;
  }
  const revalue = round2(docChange - await inventoryNetOfEntries(tx, input.entryIds));
  if (Math.abs(revalue) <= 0.004) return 0;
  await postJournalEntry(tx, {
    companyId: input.companyId, branchId: input.branchId ?? null, postingDate: input.date,
    referenceType: input.referenceType, referenceId: input.referenceId, description: input.description, createdById: input.createdById,
    lines: revalue < 0
      ? [{ accountKey: 'COGS', debit: -revalue }, { accountKey: 'INVENTORY', credit: -revalue }]
      : [{ accountKey: 'INVENTORY', debit: revalue }, { accountKey: 'COGS', credit: revalue }],
  });
  return revalue;
}

// THE INVENTORY RULE: stock is carried at quantity x weighted-average cost. A receipt (or an unwinding return) normally moves the books by exactly
// what the route posts, but it can also change the average cost or land on a negative balance (units sold before they were ever received carry
// cost 0 at the sale). The difference between how the stock is valued afterwards and before, less what the route itself posted, is a
// revaluation: it goes to cost of goods sold, so the ledger's Inventory always equals quantity x average cost and the books balance.
//   postedChange = what the route already posted to INVENTORY for this product (+ receipt value, - returned value).
export async function postInventoryRevaluation(tx: any, input: {
  companyId: string; branchId?: string | null; date: string; productId: string;
  before: { qty: number; avg: number }; after: { qty: number; avg: number }; postedChange: number;
  referenceType: string; referenceId: string; description: string; createdById: string;
}): Promise<number> {
  const revalue = round2(round2(input.after.qty * input.after.avg) - round2(input.before.qty * input.before.avg) - input.postedChange);
  if (Math.abs(revalue) <= 0.004) return 0;
  await postJournalEntry(tx, {
    companyId: input.companyId, branchId: input.branchId ?? null, postingDate: input.date,
    referenceType: input.referenceType, referenceId: input.referenceId, description: input.description, createdById: input.createdById,
    lines: revalue < 0
      ? [{ accountKey: 'COGS', debit: -revalue }, { accountKey: 'INVENTORY', credit: -revalue }]
      : [{ accountKey: 'INVENTORY', debit: revalue }, { accountKey: 'COGS', credit: revalue }],
  });
  return revalue;
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
  if (opts.startDate) joinConditions.push(gte(schema.journalEntries.postingDate, opts.startDate));
  if (opts.endDate) joinConditions.push(lte(schema.journalEntries.postingDate, opts.endDate));
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
