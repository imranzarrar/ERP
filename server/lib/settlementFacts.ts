// What receipts and vendor payments (server/lib/settlements.ts) look like to the document-based reports. Those reports were written when every payment was one voucher
// against one document; a settlement is one voucher against a PARTY that is split over documents by payment_allocations rows. This file is the single place that turns
// the new shape back into the old one, so the reports keep one meaning of "paid" and nothing is counted from two directions:
//   * allocationEvents  - every allocation as the voucher it would have been had it been paid directly against its document (dated by the day it was applied; a
//                         cancelled one adds a Reversal on the day it was taken back). Used wherever a report asks "how much of THIS document was paid, and when".
//   * onAccountBalances - what is still held on account per party (a receipt not yet put against invoices is the customer's advance; a payment not yet put against
//                         bills is the company's advance to the vendor). Balance Sheet / Trial Balance carry it as its own line.
// The cash itself is never read from here: it is the settlement voucher (bank movement), counted once, on the day it happened.
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';

export type AllocatedDocType = 'Invoice' | 'Expense' | 'PurchaseBill';
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// Looks like a row of `vouchers` so the existing filters (`referenceType === 'Invoice' && type === 'Receipt'`) work on it unchanged.
export interface AllocationEvent {
  referenceType: AllocatedDocType; referenceId: string; type: 'Receipt' | 'Payment' | 'Reversal'; amount: number;
  postingDate: string; docDate: string; branchId: string | null; voucherNumber: string; voucherId: string; settlementAllocation: true;
}

export async function allocationEvents(executor: any, companyId: string, opts: { documentType?: AllocatedDocType; documentIds?: string[]; fromDate?: string; toDate?: string } = {}): Promise<AllocationEvent[]> {
  const conds = [eq(schema.paymentAllocations.companyId, companyId)];
  if (opts.documentType) conds.push(eq(schema.paymentAllocations.documentType, opts.documentType));
  if (opts.documentIds) { if (!opts.documentIds.length) return []; conds.push(inArray(schema.paymentAllocations.documentId, opts.documentIds)); }
  const rows: any[] = await executor.select({
    a: schema.paymentAllocations, voucherNumber: schema.vouchers.voucherNumber, vtype: schema.vouchers.type,
  }).from(schema.paymentAllocations)
    .innerJoin(schema.vouchers, and(eq(schema.vouchers.id, schema.paymentAllocations.voucherId), eq(schema.vouchers.companyId, schema.paymentAllocations.companyId)))
    .where(and(...conds));
  if (!rows.length) return [];
  // the branch of the document being paid, so branch-scoped reports see the event with its document
  const branchOf = new Map<string, string | null>();
  const idsOf = (t: AllocatedDocType) => [...new Set(rows.filter(r => r.a.documentType === t).map(r => r.a.documentId as string))];
  for (const [t, tbl] of [['Invoice', schema.invoices], ['Expense', schema.expenses], ['PurchaseBill', schema.purchaseBills]] as const) {
    const ids = idsOf(t); if (!ids.length) continue;
    for (const d of await executor.select({ id: (tbl as any).id, branchId: (tbl as any).branchId }).from(tbl as any).where(and(eq((tbl as any).companyId, companyId), inArray((tbl as any).id, ids)))) branchOf.set(`${t}:${d.id}`, d.branchId ?? null);
  }
  const out: AllocationEvent[] = [];
  const within = (d: string) => (!opts.fromDate || d >= opts.fromDate) && (!opts.toDate || d <= opts.toDate);
  for (const { a, voucherNumber, vtype } of rows) {
    const base = { referenceType: a.documentType as AllocatedDocType, referenceId: a.documentId as string, amount: Number(a.amount), branchId: branchOf.get(`${a.documentType}:${a.documentId}`) ?? null, voucherNumber: voucherNumber as string, voucherId: a.voucherId as string, settlementAllocation: true as const };
    const applied = String(a.appliedDate).slice(0, 10);
    if (within(applied)) out.push({ ...base, type: vtype === 'Receipt' ? 'Receipt' : 'Payment', postingDate: applied, docDate: applied });
    if (a.reversedDate) { const rev = String(a.reversedDate).slice(0, 10); if (within(rev)) out.push({ ...base, type: 'Reversal', postingDate: rev, docDate: rev }); }
  }
  return out;
}

// For "as at" reports: what was applied (or taken back) AFTER the date, per document - the same signed meaning as the later direct vouchers it sits next to.
export function laterAllocationTotals(events: AllocationEvent[], documentType: AllocatedDocType, asOfDate: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of events) {
    if (e.referenceType !== documentType || e.postingDate <= asOfDate) continue;
    out.set(e.referenceId, round2((out.get(e.referenceId) || 0) + (e.type === 'Reversal' ? -e.amount : e.amount)));
  }
  return out;
}

export interface OnAccountBalances { customerAdvances: number; vendorAdvances: number; byParty: { kind: 'customer' | 'vendor'; partyId: string; amount: number }[] }

// Money held on account as at a date: every settlement voucher up to then that was not cancelled by then, less what had been applied to documents by then.
export async function onAccountBalances(executor: any, companyId: string, asOfDate: string): Promise<OnAccountBalances> {
  const res: any = await executor.execute(sql`
    SELECT v.reference_type AS rt, v.reference_id AS party,
           (v.amount - COALESCE((SELECT SUM(a.amount) FROM payment_allocations a
                                  WHERE a.company_id = v.company_id AND a.voucher_id = v.id AND a.applied_date <= ${asOfDate}::date
                                    AND (a.reversed_date IS NULL OR a.reversed_date > ${asOfDate}::date)), 0))::float8 AS held
    FROM vouchers v
    WHERE v.company_id = ${companyId}::uuid AND v.reference_type IN ('CustomerReceipt','VendorPayment') AND v.type IN ('Receipt','Payment') AND v.posting_date <= ${asOfDate}::date
      AND NOT EXISTS (SELECT 1 FROM vouchers r WHERE r.company_id = v.company_id AND r.reversal_of_voucher_id = v.id AND r.posting_date <= ${asOfDate}::date)`);
  const by = new Map<string, { kind: 'customer' | 'vendor'; partyId: string; amount: number }>();
  let customerAdvances = 0, vendorAdvances = 0;
  for (const r of res.rows) {
    const held = round2(Number(r.held)); if (held === 0) continue;
    const kind = r.rt === 'CustomerReceipt' ? 'customer' : 'vendor';
    if (kind === 'customer') customerAdvances = round2(customerAdvances + held); else vendorAdvances = round2(vendorAdvances + held);
    const k = `${kind}:${r.party}`; const cur = by.get(k) || { kind, partyId: r.party, amount: 0 };
    cur.amount = round2(cur.amount + held); by.set(k, cur);
  }
  return { customerAdvances, vendorAdvances, byParty: [...by.values()] };
}
