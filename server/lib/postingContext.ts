// Posting profiles: what a document's party (customer / vendor) and bank bring to the ledger without the document choosing accounts or tags itself
// (docs/gl-step1-5-decisions.md, "Control accounts and posting profiles"). Every posting goes through postJournalEntry, which asks this file two things:
//   1. which control account does this party's receivable / payable line post to (the customer's or vendor's own, else the company's AR / AP role account)
//   2. which dimension tags do the lines start from (the bank's, then the party's; the document's own and the line's own tags still win)
// The party is read from the SOURCE DOCUMENT of the entry (an invoice's customer, a bill's vendor ...), so no route has to remember to pass it and no
// document type can post to the wrong subledger by omission. A new document type adds one line to PARTY_OF_DOCUMENT.
import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { entitiesOfType, loadTypes, tagsOfCombinations, type Tags } from './dimensions.js';

export interface PostingContext { customerId?: string | null; vendorId?: string | null }

// Which table holds the party of each kind of source document.
const PARTY_OF_DOCUMENT: Record<string, { table: any; idCol: any; customerCol?: any; vendorCol?: any }> = {
  Invoice: { table: schema.invoices, idCol: schema.invoices.id, customerCol: schema.invoices.customerId },
  CreditNote: { table: schema.invoices, idCol: schema.invoices.id, customerCol: schema.invoices.customerId },
  Expense: { table: schema.expenses, idCol: schema.expenses.id, vendorCol: schema.expenses.vendorId },
  PurchaseBill: { table: schema.purchaseBills, idCol: schema.purchaseBills.id, vendorCol: schema.purchaseBills.vendorId },
  Grn: { table: schema.goodsReceiptNotes, idCol: schema.goodsReceiptNotes.id, vendorCol: schema.goodsReceiptNotes.vendorId },
  PurchaseReturn: { table: schema.purchaseReturns, idCol: schema.purchaseReturns.id, vendorCol: schema.purchaseReturns.vendorId },
};

export async function partyOfDocument(tx: any, companyId: string, referenceType: string, referenceId: string): Promise<PostingContext> {
  const src = PARTY_OF_DOCUMENT[referenceType];
  if (!src || !/^[0-9a-f-]{36}$/i.test(referenceId)) return {};
  const cols: any = {}; if (src.customerCol) cols.customerId = src.customerCol; if (src.vendorCol) cols.vendorId = src.vendorCol;
  const [row] = await tx.select(cols).from(src.table).where(and(eq(src.idCol, referenceId), eq(src.table.companyId, companyId)));
  return { customerId: row?.customerId || null, vendorId: row?.vendorId || null };
}

export interface PostingProfile {
  // the account a role line posts to instead of the company's role account (AR for the customer, AP for the vendor)
  controlAccountOf: (accountKey: string | null | undefined) => string | null;
  partyTags: Tags;
  bankTags: (bankId: string | null | undefined) => Tags;
}
const NONE: PostingProfile = { controlAccountOf: () => null, partyTags: {}, bankTags: () => ({}) };

// Tags of a default combination that can still be used: an inactive dimension or value is dropped (a default must never block a posting).
async function usableTags(tx: any, companyId: string, combinationIds: string[]): Promise<Map<string, Tags>> {
  const raw = await tagsOfCombinations(tx, companyId, combinationIds);
  if (raw.size === 0) return raw;
  const types = (await loadTypes(tx, companyId)).filter((t: any) => t.isActive);
  const live = new Map<string, Set<string>>();
  for (const t of types) live.set(t.id, new Set((await entitiesOfType(tx, companyId, t)).filter(e => e.isActive).map(e => e.id)));
  const out = new Map<string, Tags>();
  for (const [id, tags] of raw) {
    const keep: Tags = {};
    for (const [typeId, entityId] of Object.entries(tags)) if (live.get(typeId)?.has(entityId)) keep[typeId] = entityId;
    out.set(id, keep);
  }
  return out;
}

export async function loadPostingProfile(tx: any, companyId: string, party: PostingContext, bankIds: string[]): Promise<PostingProfile> {
  if (!party.customerId && !party.vendorId && bankIds.length === 0) return NONE;
  let customerControl: string | null = null, vendorControl: string | null = null;
  const comboOfParty: string[] = []; const comboOfBank = new Map<string, string>();
  if (party.customerId) {
    const [c] = await tx.select({ control: schema.customers.controlAccountId, combo: schema.customers.defaultDimensionCombinationId }).from(schema.customers).where(and(eq(schema.customers.id, party.customerId), eq(schema.customers.companyId, companyId)));
    customerControl = c?.control || null; if (c?.combo) comboOfParty.push(c.combo);
  }
  if (party.vendorId) {
    const [v] = await tx.select({ control: schema.vendors.controlAccountId, combo: schema.vendors.defaultDimensionCombinationId }).from(schema.vendors).where(and(eq(schema.vendors.id, party.vendorId), eq(schema.vendors.companyId, companyId)));
    vendorControl = v?.control || null; if (v?.combo) comboOfParty.push(v.combo);
  }
  if (bankIds.length) {
    const banks: any[] = await tx.select({ id: schema.bankAccounts.id, combo: schema.bankAccounts.defaultDimensionCombinationId }).from(schema.bankAccounts).where(and(eq(schema.bankAccounts.companyId, companyId), inArray(schema.bankAccounts.id, bankIds)));
    for (const b of banks) if (b.combo) comboOfBank.set(b.id, b.combo);
  }
  const tagsById = await usableTags(tx, companyId, [...comboOfParty, ...comboOfBank.values()]);
  const partyTags: Tags = {}; for (const id of comboOfParty) Object.assign(partyTags, tagsById.get(id) || {});
  return {
    controlAccountOf: key => key === 'AR' ? customerControl : key === 'AP' ? vendorControl : null,
    partyTags,
    bankTags: bankId => (bankId && comboOfBank.has(bankId) ? tagsById.get(comboOfBank.get(bankId)!) : undefined) || {},
  };
}
