import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, sql, desc } from 'drizzle-orm';
import { generateId } from '../../src/id.js';

// Single source of truth for "which document types exist and what's their out-of-the-box
// default prefix" — mirrors src/permissionSchema.ts's PERMISSION_MODULES pattern exactly.
// Add one entry here for a brand-new document type (a new voucher type, an HR/Payroll
// module's own documents, anything): the settings UI, the defaults fallback, and the
// preview endpoint all derive from this array automatically. No other file needs to change
// to *support* a new type existing in the system; only the new feature's own creation route
// needs the one extra line calling getAndIncrementDocumentNumber(tx, companyId, 'newKey', docDate, branchId).
export const DOCUMENT_TYPE_REGISTRY: { key: string; label: string; defaultPrefix: string }[] = [
  { key: 'quotation', label: 'Quotation', defaultPrefix: 'QT' },
  { key: 'invoice', label: 'Invoice', defaultPrefix: 'INV' },
  { key: 'creditNote', label: 'Credit Note', defaultPrefix: 'CN' },
  { key: 'debitNote', label: 'Debit Note', defaultPrefix: 'DN' },
  { key: 'expense', label: 'Expense', defaultPrefix: 'EXP' },
  { key: 'voucher', label: 'Voucher', defaultPrefix: 'VCH' },
  { key: 'pr', label: 'Purchase Requisition', defaultPrefix: 'PR' },
  { key: 'po', label: 'Purchase Order', defaultPrefix: 'PO' },
  { key: 'grn', label: 'Goods Receipt Note', defaultPrefix: 'GRN' },
  { key: 'bill', label: 'Purchase Bill', defaultPrefix: 'BILL' },
  { key: 'return', label: 'Purchase Return', defaultPrefix: 'DN' }, // collides with debitNote by default — true to today's existing behavior, surfaced (not silently changed) by the settings UI
  { key: 'stockTake', label: 'Physical Stock Take', defaultPrefix: 'ST' },
];

const DEFAULTS_BY_KEY = new Map(DOCUMENT_TYPE_REGISTRY.map(d => [d.key, d]));

export type DocType = string;
export type ResetFrequency = 'never' | 'yearly' | 'monthly';

export type NumberingRule = {
  prefix: string;
  separator: string;
  padWidth: number;
  includeBranchCode: boolean;
  resetFrequency: ResetFrequency;
};

function resolveRule(docType: DocType, policy: Record<string, Partial<NumberingRule>> | null | undefined): NumberingRule {
  const registryDefault = DEFAULTS_BY_KEY.get(docType);
  const override = policy?.[docType] || {};
  return {
    prefix: override.prefix ?? registryDefault?.defaultPrefix ?? docType.toUpperCase(),
    separator: override.separator ?? '-',
    padWidth: override.padWidth ?? 0,
    includeBranchCode: override.includeBranchCode ?? false,
    resetFrequency: override.resetFrequency ?? 'never',
  };
}

function computePeriodKey(resetFrequency: ResetFrequency, docDate: string): string {
  // docDate is the document's own date field (e.g. invoiceDate), never wall-clock time — a
  // late-entered/backdated document correctly still increments its own period's bucket,
  // matching the "derive from the document's own date, not request time" correction already
  // made for ZATCA's IssueTime (BACKLOG item 73).
  if (resetFrequency === 'yearly') return docDate.slice(0, 4);
  if (resetFrequency === 'monthly') return docDate.slice(0, 7);
  return 'NONE';
}

function formatNumber(rule: NumberingRule, value: number, branchCode: string | null | undefined): string {
  const padded = rule.padWidth > 0 ? String(value).padStart(rule.padWidth, '0') : String(value);
  const branchSegment = rule.includeBranchCode && branchCode ? `${branchCode}${rule.separator}` : '';
  return `${rule.prefix}${rule.separator}${branchSegment}${padded}`;
}

// Atomic upsert-increment against the shared documentCounters table — the one place
// every per-company sequence in this app (documents today, employee numbers via
// server/lib/employeeNumbering.ts) reserves its next value. Must be called with the
// transaction executor of an enclosing db.transaction(...) block — the row lock this
// implicitly takes via INSERT ... ON CONFLICT DO UPDATE is only meaningful for the
// lifetime of that transaction.
//
// INSERT ... ON CONFLICT DO UPDATE ... RETURNING is itself a single statement that
// row-locks for its own duration, so this needs no separate SELECT ... FOR UPDATE and has
// no read-then-write race window — including on the very first request for a brand-new
// (companyId, docType, periodKey) combination (a period rollover, or a fresh company/
// sequence's first-ever value), which a SELECT-then-conditionally-INSERT approach cannot
// safely handle since there is no row yet to lock. `seedValue` only matters the very first
// time this exact key combination is ever requested — every call after that just
// increments whatever's already there, per the "pre-increment, first issued = seed + 1"
// convention documented on documentCounters.currentValue itself.
export async function reserveNextCounterValue(
  tx: any, companyId: string, docType: DocType, periodKey: string, seedValue: number
): Promise<number> {
  const [row] = await tx.insert(schema.documentCounters).values({
    id: generateId(),
    companyId,
    docType,
    periodKey,
    currentValue: seedValue + 1,
  }).onConflictDoUpdate({
    target: [schema.documentCounters.companyId, schema.documentCounters.docType, schema.documentCounters.periodKey],
    set: { currentValue: sql`${schema.documentCounters.currentValue} + 1` },
  }).returning({ currentValue: schema.documentCounters.currentValue });
  return row.currentValue;
}

// Counting is always company-wide, never per-branch — branchId is used only to look up a
// branch's display code when includeBranchCode is on; it never enters the counter's lookup
// key. This is a deliberate, settled decision (see the plan): tier-1 ERPs keep sequential
// document numbering at the legal-entity level for tax-compliance reasons, and fragmenting
// it per branch would be an audit red flag, not a feature.
//
// This function only ever produces the human-readable display number. It is fully
// independent of processInvoiceZatca's ICV/PIH reservation (zatcaChainState) — that is the
// only mechanism ZATCA's sequential-integrity requirement actually depends on.
export async function getAndIncrementDocumentNumber(
  tx: any,
  companyId: string,
  docType: DocType,
  docDate: string,
  branchId?: string | null
): Promise<string> {
  const [company] = await tx.select({
    numberingPolicy: schema.companies.numberingPolicy,
    counters: schema.companies.counters,
  }).from(schema.companies).where(eq(schema.companies.id, companyId));
  if (!company) throw new Error('Company not found');

  const rule = resolveRule(docType, company.numberingPolicy as any);
  const periodKey = computePeriodKey(rule.resetFrequency, docDate);

  // Lazy seed-from-legacy: the first time this exact (companyId, docType, periodKey)
  // combination is ever requested, start from the existing companies.counters[docType]
  // value instead of the hard default of 1000, so cutover is a pure code deploy — every
  // existing company's first document after deploy continues exactly where it left off.
  // companies.counters stays in place afterward as a historical artifact, never written
  // again by this function.
  const legacyCount = (company.counters as any)?.[docType];
  const seedValue = typeof legacyCount === 'number' ? legacyCount : 1000;

  const newValue = await reserveNextCounterValue(tx, companyId, docType, periodKey, seedValue);

  let branchCode: string | null = null;
  if (rule.includeBranchCode && branchId) {
    const [branch] = await tx.select({ code: schema.branches.code }).from(schema.branches).where(eq(schema.branches.id, branchId));
    branchCode = branch?.code || null;
  }

  return formatNumber(rule, newValue, branchCode);
}

// Read-only, display-purposes-only preview of "what would the next number look like right
// now" per doc type — never increments anything. Mirrors hashChain.ts's own documented
// unlocked/display-only getNextHashChainState pattern.
export async function previewNextDocumentNumbers(companyId: string): Promise<Record<string, string>> {
  const [company] = await db.select({
    numberingPolicy: schema.companies.numberingPolicy,
    counters: schema.companies.counters,
  }).from(schema.companies).where(eq(schema.companies.id, companyId));
  if (!company) throw new Error('Company not found');

  const counters = await db.select().from(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyId));
  const latestByTypeAndPeriod = new Map(counters.map(c => [`${c.docType}::${c.periodKey}`, c.currentValue]));

  // No specific document is actually being created here, so there's no real branchId to
  // resolve — for a purely illustrative preview when includeBranchCode is on, show the
  // company's default branch's code (falling back to any active one) so the preview isn't
  // silently misleading about what the feature does; a real document's own branch decides
  // its actual code at creation time (getAndIncrementDocumentNumber above), never this.
  const [illustrativeBranch] = await db.select({ code: schema.branches.code })
    .from(schema.branches)
    .where(eq(schema.branches.companyId, companyId))
    .orderBy(desc(schema.branches.isDefault))
    .limit(1);

  const result: Record<string, string> = {};
  const todayIso = new Date().toISOString().slice(0, 10);
  for (const entry of DOCUMENT_TYPE_REGISTRY) {
    const rule = resolveRule(entry.key, company.numberingPolicy as any);
    const periodKey = computePeriodKey(rule.resetFrequency, todayIso);
    const legacyCount = (company.counters as any)?.[entry.key];
    const seedValue = typeof legacyCount === 'number' ? legacyCount : 1000;
    const current = latestByTypeAndPeriod.get(`${entry.key}::${periodKey}`) ?? seedValue;
    result[entry.key] = formatNumber(rule, current + 1, rule.includeBranchCode ? illustrativeBranch?.code : null);
  }
  return result;
}
