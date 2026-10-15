// What a printed voucher shows of the ledger (Blueprint "print out for vouchers - posting"): the posted entries of a document, each with its lines resolved to account, party and
// dimension labels, so a Receipt / Payment voucher, a Journal Voucher and a bank reconciliation report all print the SAME posting from ONE query, never a second hand-built version.
// The server resolves everything (the browser's /api/state is capped and holds no ledger), the screen only renders.
import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { entitiesOfType, loadTypes, tagsOfCombinations } from './dimensions.js';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface PostedLine { lineId: string; accountId: string | null; accountCode: string; accountName: string; accountNameAr: string | null; debit: number; credit: number; party: string | null; dimensions: string[] }
export interface PostedEntry {
  id: string; postingDate: string; docDate: string; description: string; referenceType: string; referenceId: string; reversalOfId: string | null;
  createdByName: string; createdAt: Date | string; lines: PostedLine[]; totalDebit: number; totalCredit: number;
}

async function resolveEntries(tx: any, companyId: string, entries: any[]): Promise<PostedEntry[]> {
  if (!entries.length) return [];
  const entryIds = entries.map(e => e.id);
  const lines: any[] = await tx.select().from(schema.journalLines).where(and(eq(schema.journalLines.companyId, companyId), inArray(schema.journalLines.journalEntryId, entryIds)));
  const accts: any[] = await tx.select().from(schema.companyAccounts).where(eq(schema.companyAccounts.companyId, companyId));
  const byId = new Map<string, any>(accts.map(a => [a.id, a]));
  const byKey = new Map<string, any>(accts.filter(a => a.systemKey).map(a => [a.systemKey, a]));
  const byBank = new Map<string, any>(accts.filter(a => a.bankId).map(a => [a.bankId, a]));
  const custIds = [...new Set(lines.map(l => l.customerId).filter(Boolean))] as string[];
  const vendIds = [...new Set(lines.map(l => l.vendorId).filter(Boolean))] as string[];
  const custName = new Map<string, string>(); const vendName = new Map<string, string>();
  if (custIds.length) for (const c of await tx.select({ id: schema.customers.id, name: schema.customers.name }).from(schema.customers).where(and(eq(schema.customers.companyId, companyId), inArray(schema.customers.id, custIds)))) custName.set(c.id, c.name);
  if (vendIds.length) for (const v of await tx.select({ id: schema.vendors.id, name: schema.vendors.name }).from(schema.vendors).where(and(eq(schema.vendors.companyId, companyId), inArray(schema.vendors.id, vendIds)))) vendName.set(v.id, v.name);
  // dimension labels: "Branch: Main", "Department: Sales"
  const combos = [...new Set(lines.map(l => l.dimensionCombinationId).filter(Boolean))] as string[];
  const tagsOf = combos.length ? await tagsOfCombinations(tx, companyId, combos) : new Map();
  const labelOf = new Map<string, string>(); // typeId:entityId -> "Type: name"
  if (tagsOf.size) {
    for (const type of await loadTypes(tx, companyId)) for (const e of await entitiesOfType(tx, companyId, type)) labelOf.set(`${type.id}:${e.id}`, `${type.name}: ${e.name}`);
  }
  const users: any[] = await tx.select({ id: schema.users.id, username: schema.users.username }).from(schema.users).where(inArray(schema.users.id, [...new Set(entries.map(e => e.createdById))]));
  const userName = new Map<string, string>(users.map(u => [u.id, u.username]));
  return entries.map(e => {
    const ls: PostedLine[] = lines.filter(l => l.journalEntryId === e.id).map(l => {
      const a = (l.accountId && byId.get(l.accountId)) || (l.accountKey === 'BANK' && l.bankId && byBank.get(l.bankId)) || (l.accountKey && byKey.get(l.accountKey)) || null;
      const tags: Record<string, string> = l.dimensionCombinationId ? (tagsOf.get(l.dimensionCombinationId) || {}) : {};
      return {
        lineId: l.id, accountId: a?.id || null, accountCode: a?.code || '', accountName: a?.name || l.accountKey || '', accountNameAr: a?.nameAr || null, debit: Number(l.debit), credit: Number(l.credit),
        party: (l.customerId && custName.get(l.customerId)) || (l.vendorId && vendName.get(l.vendorId)) || null,
        dimensions: Object.entries(tags).map(([typeId, entityId]) => labelOf.get(`${typeId}:${entityId}`)).filter(Boolean) as string[],
      };
    });
    return {
      id: e.id, postingDate: String(e.postingDate).slice(0, 10), docDate: String(e.docDate).slice(0, 10), description: e.description, referenceType: e.referenceType, referenceId: e.referenceId, reversalOfId: e.reversalOfId || null,
      createdByName: userName.get(e.createdById) || '', createdAt: e.createdAt, lines: ls, totalDebit: round2(ls.reduce((n, l) => n + l.debit, 0)), totalCredit: round2(ls.reduce((n, l) => n + l.credit, 0)),
    };
  });
}

// Every entry a document has posted, oldest first: the original and, when it was cancelled, the reversing one.
export async function postedEntriesOfReference(tx: any, companyId: string, referenceType: string, referenceId: string): Promise<PostedEntry[]> {
  const entries: any[] = await tx.select().from(schema.journalEntries).where(and(eq(schema.journalEntries.companyId, companyId), eq(schema.journalEntries.referenceType, referenceType), eq(schema.journalEntries.referenceId, referenceId)));
  entries.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return resolveEntries(tx, companyId, entries);
}

export async function postedEntry(tx: any, companyId: string, entryId: string): Promise<PostedEntry | null> {
  const [e] = await tx.select().from(schema.journalEntries).where(and(eq(schema.journalEntries.companyId, companyId), eq(schema.journalEntries.id, entryId)));
  return e ? (await resolveEntries(tx, companyId, [e]))[0] : null;
}
