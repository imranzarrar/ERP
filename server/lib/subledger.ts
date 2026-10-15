// The customer and vendor subledgers, computed from the ledger (Blueprint FR-AR-02 / FR-AP-01: "aging and statements are a live query over posted journal lines against
// the control account, never a separately maintained balance"). Every figure here comes from journal lines that post to a customer or vendor control account and
// carry the party (journal_lines.customer_id / vendor_id, set by the posting engine). The balance of a party, its ledger, its aging and the control-account
// reconciliation are four views of the same lines, so they agree by construction.
import { sql } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { and, eq, inArray } from 'drizzle-orm';
import { resolvedLines, round2 } from './ledgerQueries.js';

export type SubledgerKind = 'customer' | 'vendor';
const partyCol = (k: SubledgerKind) => (k === 'customer' ? sql.raw('rl.customer_id') : sql.raw('rl.vendor_id'));
// the sign that makes a party's position positive: a customer owes us (debit), we owe a vendor (credit)
const sign = (k: SubledgerKind) => (k === 'customer' ? 1 : -1);

export interface PartyBalance { partyId: string | null; code: string | null; name: string; debit: number; credit: number; balance: number; lines: number }

// Lines on the control accounts of one kind, up to a date. rl exposes the party columns.
function controlLines(companyId: string, kind: SubledgerKind, opts: { from?: string; to?: string; branchIds?: string[] | null }) {
  return sql`${resolvedLines(companyId, opts)} JOIN company_accounts ca ON ca.id = rl.account_id AND ca.company_id = ${companyId}::uuid AND ca.subledger_type = ${kind}`;
}

async function partyNames(tx: any, companyId: string, kind: SubledgerKind, ids: string[]) {
  const table: any = kind === 'customer' ? schema.customers : schema.vendors;
  const code = kind === 'customer' ? schema.customers.customerCode : schema.vendors.vendorCode;
  const rows: any[] = ids.length ? await tx.select({ id: table.id, name: table.name, code }).from(table).where(and(eq(table.companyId, companyId), inArray(table.id, ids))) : [];
  return new Map<string, { name: string; code: string | null }>(rows.map(r => [r.id, { name: r.name, code: r.code || null }]));
}

// Every party's debits, credits and balance on the control accounts as at a date (balance positive = the party owes us / we owe the party).
export async function partyBalances(tx: any, companyId: string, kind: SubledgerKind, opts: { asOf: string; branchIds?: string[] | null }): Promise<PartyBalance[]> {
  const res: any = await tx.execute(sql`SELECT ${partyCol(kind)} AS party_id, COALESCE(SUM(rl.debit),0)::float8 AS debit, COALESCE(SUM(rl.credit),0)::float8 AS credit, COUNT(*)::int AS lines
    FROM ${controlLines(companyId, kind, { to: opts.asOf, branchIds: opts.branchIds })} GROUP BY 1`);
  const names = await partyNames(tx, companyId, kind, res.rows.map((r: any) => r.party_id).filter(Boolean));
  return res.rows.map((r: any) => {
    const n = names.get(r.party_id);
    return { partyId: r.party_id, code: n?.code || null, name: r.party_id ? (n?.name || '(removed)') : '(not assigned to a party)', debit: round2(r.debit), credit: round2(r.credit), balance: round2(sign(kind) * (r.debit - r.credit)), lines: Number(r.lines) };
  }).sort((a: PartyBalance, b: PartyBalance) => b.balance - a.balance || a.name.localeCompare(b.name));
}

export interface LedgerLine { entryId: string; postingDate: string; docDate: string; referenceType: string; documentNumber: string | null; description: string; debit: number; credit: number; balance: number }

// The names of the documents entries came from (shared with the General Ledger report's idea of a document number).
export async function documentNumbers(tx: any, companyId: string, refs: { type: string; id: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const byType = new Map<string, string[]>();
  for (const r of refs) { const l = byType.get(r.type) || []; l.push(r.id); byType.set(r.type, l); }
  const grab = async (types: string[], table: any, idCol: any, numCol: any) => {
    const ids = [...new Set(types.flatMap(t => byType.get(t) || []))];
    if (!ids.length) return;
    const rows = await tx.select({ id: idCol, n: numCol }).from(table).where(and(eq(table.companyId, companyId), inArray(idCol, ids)));
    for (const r of rows) out.set(r.id, r.n);
  };
  await grab(['Invoice', 'CreditNote'], schema.invoices, schema.invoices.id, schema.invoices.invoiceNumber);
  await grab(['Expense'], schema.expenses, schema.expenses.id, schema.expenses.expenseNumber);
  await grab(['PurchaseBill'], schema.purchaseBills, schema.purchaseBills.id, schema.purchaseBills.billNumber);
  await grab(['Grn'], schema.goodsReceiptNotes, schema.goodsReceiptNotes.id, schema.goodsReceiptNotes.grnNumber);
  await grab(['PurchaseReturn'], schema.purchaseReturns, schema.purchaseReturns.id, schema.purchaseReturns.returnNumber);
  await grab(['Manual'], schema.manualJournals, schema.manualJournals.id, schema.manualJournals.number);
  await grab(['VendorRefund'], schema.vouchers, schema.vouchers.id, schema.vouchers.voucherNumber);
  return out;
}

// One party's ledger: the balance before the period, then every posting with its running balance.
export async function partyLedger(tx: any, companyId: string, kind: SubledgerKind, partyId: string | null, opts: { from: string; to: string; branchIds?: string[] | null }) {
  const col = partyCol(kind);
  const filter = partyId ? sql`${col} = ${partyId}::uuid` : sql`${col} IS NULL`;
  const open: any = await tx.execute(sql`SELECT COALESCE(SUM(rl.debit - rl.credit),0)::float8 AS net FROM ${controlLines(companyId, kind, { to: dayBefore(opts.from), branchIds: opts.branchIds })} WHERE ${filter}`);
  const opening = round2(sign(kind) * Number(open.rows[0].net));
  const rowsRes: any = await tx.execute(sql`
    SELECT rl.journal_entry_id AS "entryId", rl.posting_date AS "postingDate", e.doc_date AS "docDate", rl.reference_type AS "referenceType", rl.reference_id AS "referenceId", e.description,
           rl.debit::float8 AS debit, rl.credit::float8 AS credit
    FROM ${controlLines(companyId, kind, { from: opts.from, to: opts.to, branchIds: opts.branchIds })} JOIN journal_entries e ON e.id = rl.journal_entry_id AND e.company_id = ${companyId}::uuid
    WHERE ${filter} ORDER BY rl.posting_date, rl.created_at, rl.line_id LIMIT 20000`);
  const nums = await documentNumbers(tx, companyId, rowsRes.rows.map((r: any) => ({ type: r.referenceType, id: r.referenceId })));
  let running = opening;
  const lines: LedgerLine[] = rowsRes.rows.map((r: any) => {
    running = round2(running + sign(kind) * (r.debit - r.credit));
    return { entryId: r.entryId, postingDate: r.postingDate, docDate: r.docDate, referenceType: r.referenceType, documentNumber: nums.get(r.referenceId) || null, description: r.description, debit: round2(r.debit), credit: round2(r.credit), balance: running };
  });
  const names = partyId ? await partyNames(tx, companyId, kind, [partyId]) : new Map();
  return { party: { id: partyId, name: partyId ? names.get(partyId)?.name || '(removed)' : '(not assigned to a party)', code: partyId ? names.get(partyId)?.code || null : null }, opening, lines, closing: running,
    totals: { debit: round2(lines.reduce((s, l) => s + l.debit, 0)), credit: round2(lines.reduce((s, l) => s + l.credit, 0)) } };
}
const dayBefore = (d: string) => new Date(Date.parse(d + 'T00:00:00.000Z') - 86400000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00.000Z') - Date.parse(a + 'T00:00:00.000Z')) / 86400000);

export const AGING_BUCKETS = ['Not due', '1-30', '31-60', '61-90', 'Over 90'] as const;
export interface AgingRow { partyId: string | null; code: string | null; name: string; buckets: number[]; unapplied: number; total: number }

// Aging as at a date, the balance-forward way: everything the party paid or was credited is set against its oldest open charges first; what is left of each charge is aged
// from its due date (the document's due date when it has one, else its document date); a payment or credit beyond every open charge stays "on account" (unapplied).
export async function partyAging(tx: any, companyId: string, kind: SubledgerKind, opts: { asOf: string; branchIds?: string[] | null }) {
  const col = partyCol(kind);
  const res: any = await tx.execute(sql`
    SELECT ${col} AS party_id, rl.posting_date AS posting_date, e.doc_date AS doc_date, rl.reference_type AS ref_type, rl.reference_id AS ref_id, rl.debit::float8 AS debit, rl.credit::float8 AS credit,
           COALESCE(inv.due_date, exp.due_date, bill.due_date) AS due_date
    FROM ${controlLines(companyId, kind, { to: opts.asOf, branchIds: opts.branchIds })}
    JOIN journal_entries e ON e.id = rl.journal_entry_id AND e.company_id = ${companyId}::uuid
    LEFT JOIN invoices inv ON rl.reference_type IN ('Invoice','CreditNote') AND inv.id = rl.reference_id AND inv.company_id = ${companyId}::uuid
    LEFT JOIN expenses exp ON rl.reference_type = 'Expense' AND exp.id = rl.reference_id AND exp.company_id = ${companyId}::uuid
    LEFT JOIN purchase_bills bill ON rl.reference_type = 'PurchaseBill' AND bill.id = rl.reference_id AND bill.company_id = ${companyId}::uuid
    ORDER BY 1, rl.posting_date, rl.created_at, rl.line_id`);
  const byParty = new Map<string | null, { charges: { date: string; open: number }[]; credits: number }>();
  for (const r of res.rows) {
    const p = byParty.get(r.party_id) || { charges: [], credits: 0 };
    // a charge raises the position (customer: debit; vendor: credit), the opposite side settles it
    const charge = kind === 'customer' ? r.debit : r.credit;
    const settle = kind === 'customer' ? r.credit : r.debit;
    if (charge > 0) p.charges.push({ date: String(r.due_date || r.doc_date || r.posting_date), open: charge });
    p.credits += settle;
    byParty.set(r.party_id, p);
  }
  const names = await partyNames(tx, companyId, kind, [...byParty.keys()].filter(Boolean) as string[]);
  const rows: AgingRow[] = [];
  for (const [partyId, p] of byParty) {
    let credit = round2(p.credits);
    const buckets = [0, 0, 0, 0, 0];
    for (const c of p.charges) {   // oldest first (the rows arrive in posting order)
      const used = Math.min(credit, c.open); credit = round2(credit - used);
      const open = round2(c.open - used);
      if (open <= 0) continue;
      const age = daysBetween(c.date, opts.asOf);
      buckets[age <= 0 ? 0 : age <= 30 ? 1 : age <= 60 ? 2 : age <= 90 ? 3 : 4] = round2(buckets[age <= 0 ? 0 : age <= 30 ? 1 : age <= 60 ? 2 : age <= 90 ? 3 : 4] + open);
    }
    const total = round2(buckets.reduce((s, v) => s + v, 0) - credit);
    if (Math.abs(total) < 0.005 && buckets.every(b => b === 0) && credit === 0) continue;
    const n = partyId ? names.get(partyId) : null;
    rows.push({ partyId, code: n?.code || null, name: partyId ? (n?.name || '(removed)') : '(not assigned to a party)', buckets, unapplied: round2(credit), total });
  }
  rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const totals = { buckets: AGING_BUCKETS.map((_, i) => round2(rows.reduce((s, r) => s + r.buckets[i], 0))), unapplied: round2(rows.reduce((s, r) => s + r.unapplied, 0)), total: round2(rows.reduce((s, r) => s + r.total, 0)) };
  return { asOf: opts.asOf, kind, bucketLabels: [...AGING_BUCKETS], rows, totals };
}

// The control accounts against the sum of the parties: they must agree, and no receivable / payable line may be without a party.
export async function subledgerReconciliation(tx: any, companyId: string, kind: SubledgerKind, asOf: string) {
  const res: any = await tx.execute(sql`SELECT COALESCE(SUM(rl.debit - rl.credit),0)::float8 AS net, COALESCE(SUM(CASE WHEN ${partyCol(kind)} IS NULL THEN rl.debit - rl.credit ELSE 0 END),0)::float8 AS unassigned,
      COUNT(*) FILTER (WHERE ${partyCol(kind)} IS NULL)::int AS untagged FROM ${controlLines(companyId, kind, { to: asOf })}`);
  const controlBalance = round2(sign(kind) * Number(res.rows[0].net));
  const unassigned = round2(sign(kind) * Number(res.rows[0].unassigned));
  const aging = await partyAging(tx, companyId, kind, { asOf });
  // the parties' aging (which includes anything not assigned to a party) must add up to the control accounts' balance
  return { kind, asOf, controlBalance, partyTotal: round2(aging.totals.total - unassigned), unassigned, untaggedLines: Number(res.rows[0].untagged), agingTotal: aging.totals.total, difference: round2(controlBalance - aging.totals.total) };
}
