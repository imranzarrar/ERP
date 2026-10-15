// Customer receipts and vendor payments that settle several documents at once, or are held on account (Blueprint FR-AR-01 / FR-AP-03). One receipt is ONE voucher, ONE journal
// entry (the party's control account against the bank, tagged with the party by the posting engine) and N allocation rows (payment_allocations) saying which documents it
// settles; whatever is not allocated stays on account with the party and can be applied later. The documents' own amount_paid / payment status are kept in step here, in the
// same transaction, so a document and its allocations cannot drift. Cancelling a receipt reverses the entry, the voucher and the allocations together.
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { generateId } from '../../src/id.js';
import { nowDate } from './clock.js';
import { round2, computePaymentStatus } from './businessLogic.js';
import { getAndIncrementDocumentNumber } from './documentNumbering.js';
import { documentDates } from './documentDates.js';
import { postJournalEntry, reverseAllEntriesFor } from './ledger.js';
import { postedEntriesOfReference } from './postingPrint.js';
import { computeInvoiceTotalsMap, computeOutstanding, liabilityAmount, taxPercentageBySlabId } from './financialReports.js';

export type SettlementKind = 'customer' | 'vendor';
export type DocType = 'Invoice' | 'Expense' | 'PurchaseBill';
const REF: Record<SettlementKind, string> = { customer: 'CustomerReceipt', vendor: 'VendorPayment' };
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const TYPES: Record<SettlementKind, DocType[]> = { customer: ['Invoice'], vendor: ['Expense', 'PurchaseBill'] };

export interface OpenItem { type: DocType; id: string; docNumber: string; date: string; total: number; paid: number; outstanding: number }

// What a party still owes / is owed, document by document (the same figures as the Outstanding report).
export async function openItems(tx: any, companyId: string, kind: SettlementKind, partyId: string, branchIds: string[] | null = null): Promise<OpenItem[]> {
  const r = await computeOutstanding(tx, companyId, null, null, kind === 'customer' ? partyId : 'ALL', kind === 'vendor' ? partyId : 'ALL', { branchIds });
  return r.rows.filter((x: any) => TYPES[kind].includes(x.type)).map((x: any) => ({ type: x.type, id: x.id, docNumber: x.docNumber, date: x.date, total: x.total, paid: x.paid, outstanding: x.outstanding }));
}

async function partyRow(tx: any, companyId: string, kind: SettlementKind, partyId: string) {
  const table: any = kind === 'customer' ? schema.customers : schema.vendors;
  const [p] = await tx.select().from(table).where(and(eq(table.id, partyId), eq(table.companyId, companyId)));
  if (!p) throw fail(400, kind === 'customer' ? 'Selected customer was not found for this company.' : 'Selected vendor was not found for this company.');
  return p;
}

// Moves a document's paid amount by `delta` (positive = more paid) and recomputes its payment status.
async function movePaid(tx: any, companyId: string, type: DocType, id: string, delta: number, docDate: string) {
  if (type === 'Invoice') {
    const [inv] = await tx.select().from(schema.invoices).where(and(eq(schema.invoices.id, id), eq(schema.invoices.companyId, companyId))).for('update');
    if (!inv) throw fail(400, 'An invoice was not found.');
    const total = (await computeInvoiceTotalsMap(tx, [inv])).get(inv.id)!.grandTotal;
    const paid = round2(Number(inv.amountPaid || 0) + delta);
    await tx.update(schema.invoices).set({ amountPaid: String(paid), paymentStatus: computePaymentStatus(paid, total), paymentDate: paid > 0 ? (delta > 0 ? new Date(docDate + 'T12:00:00.000Z') : inv.paymentDate) : null, updatedAt: nowDate() }).where(eq(schema.invoices.id, id));
  } else if (type === 'Expense') {
    const [exp] = await tx.select().from(schema.expenses).where(and(eq(schema.expenses.id, id), eq(schema.expenses.companyId, companyId))).for('update');
    if (!exp) throw fail(400, 'An expense was not found.');
    const total = liabilityAmount(exp, await taxPercentageBySlabId(tx, companyId));
    const paid = round2(Number(exp.amountPaid || 0) + delta);
    await tx.update(schema.expenses).set({ amountPaid: String(paid), paymentStatus: computePaymentStatus(paid, total), paymentDate: paid > 0 ? (delta > 0 ? new Date(docDate + 'T12:00:00.000Z') : exp.paymentDate) : null, updatedAt: nowDate() }).where(eq(schema.expenses.id, id));
  } else {
    const [bill] = await tx.select().from(schema.purchaseBills).where(and(eq(schema.purchaseBills.id, id), eq(schema.purchaseBills.companyId, companyId))).for('update');
    if (!bill) throw fail(400, 'A bill was not found.');
    const total = round2(Number(bill.grandTotal));
    const paid = round2(Number(bill.amountPaid || 0) + delta);
    await tx.update(schema.purchaseBills).set({ amountPaid: String(paid), status: paid <= 0 ? 'Unpaid' : paid >= total - 0.01 ? 'Paid' : 'Partially Paid' }).where(eq(schema.purchaseBills.id, id));
  }
}

interface AllocationInput { documentType: DocType; documentId: string; amount: number }

// Checks that every allocation names an open document of the party and does not exceed what is still owed on it.
async function checkAllocations(tx: any, companyId: string, kind: SettlementKind, partyId: string, allocations: AllocationInput[], available: number, branchIds: string[] | null) {
  if (!Array.isArray(allocations)) throw fail(400, 'Allocations must be a list.');
  const open = new Map((await openItems(tx, companyId, kind, partyId, branchIds)).map(i => [`${i.type}:${i.id}`, i]));
  const seen = new Set<string>(); let sum = 0;
  for (const a of allocations) {
    const amount = round2(Number(a.amount));
    if (!TYPES[kind].includes(a.documentType)) throw fail(400, `A ${kind === 'customer' ? 'receipt' : 'payment'} cannot settle a ${a.documentType}.`);
    if (!(amount > 0)) throw fail(400, 'Each allocated amount must be greater than zero.');
    const key = `${a.documentType}:${a.documentId}`;
    if (seen.has(key)) throw fail(400, 'A document is listed twice.');
    seen.add(key);
    const item = open.get(key);
    if (!item) throw fail(400, `That ${a.documentType.toLowerCase()} is not open for this ${kind}.`);
    if (amount > item.outstanding + 0.005) throw fail(400, `${item.docNumber}: ${amount.toFixed(2)} is more than the ${item.outstanding.toFixed(2)} still owed on it.`);
    sum = round2(sum + amount);
  }
  if (sum > round2(available) + 0.005) throw fail(400, `The allocations (${sum.toFixed(2)}) are more than the ${round2(available).toFixed(2)} available.`);
  return sum;
}

export async function recordSettlement(tx: any, req: any, input: { kind: SettlementKind; partyId: string; bankId: string; docDate: string; amount: number; reference?: string | null; notes?: string | null; allocations: AllocationInput[] }) {
  const companyId = req.targetCompanyId;
  const { kind, partyId, bankId, docDate } = input;
  const amount = round2(Number(input.amount));
  if (!(amount > 0)) throw fail(400, 'Enter an amount greater than zero.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(docDate || '')) throw fail(400, 'Enter a valid date.');
  const party = await partyRow(tx, companyId, kind, partyId);
  const [bank] = await tx.select().from(schema.bankAccounts).where(and(eq(schema.bankAccounts.id, bankId), eq(schema.bankAccounts.companyId, companyId)));
  if (!bank) throw fail(400, 'Choose a bank or cash account of this company.');
  if (bank.isActive === false) throw fail(400, 'That bank account is inactive.');
  const applied = await checkAllocations(tx, companyId, kind, partyId, input.allocations || [], amount, null);

  const voucherNumber = await getAndIncrementDocumentNumber(tx, companyId, 'voucher', docDate, null);
  const voucherId = generateId();
  const ref = [input.reference && `ref ${String(input.reference).trim().slice(0, 60)}`, input.notes && String(input.notes).trim().slice(0, 120)].filter(Boolean).join(' · ');
  const [voucher] = await tx.insert(schema.vouchers).values({
    id: voucherId, voucherNumber, type: kind === 'customer' ? 'Receipt' : 'Payment', ...documentDates(docDate), bankId, amount: String(amount),
    description: `${kind === 'customer' ? 'Receipt from' : 'Payment to'} ${party.name}${ref ? ` (${ref})` : ''}`,
    referenceType: REF[kind], referenceId: partyId, createdById: req.user.id, createdAt: nowDate(), companyId, branchId: null,
  }).returning();
  await postJournalEntry(tx, {
    companyId, branchId: null, postingDate: docDate, referenceType: REF[kind], referenceId: voucherId,
    description: `${voucherNumber}: ${kind === 'customer' ? 'receipt from' : 'payment to'} ${party.name}`, createdById: req.user.id,
    lines: kind === 'customer' ? [{ accountKey: 'BANK', debit: amount, bankId }, { accountKey: 'AR', credit: amount }] : [{ accountKey: 'AP', debit: amount }, { accountKey: 'BANK', credit: amount, bankId }],
  });
  for (const a of input.allocations || []) await allocate(tx, req, voucherId, a, docDate);
  return { voucherId, voucherNumber, amount, applied, unapplied: round2(amount - applied) };
}

async function allocate(tx: any, req: any, voucherId: string, a: AllocationInput, docDate: string) {
  const amount = round2(Number(a.amount));
  await tx.insert(schema.paymentAllocations).values({ id: generateId(), companyId: req.targetCompanyId, voucherId, documentType: a.documentType, documentId: a.documentId, amount: String(amount), appliedDate: docDate, createdAt: nowDate(), createdById: req.user.id });
  await movePaid(tx, req.targetCompanyId, a.documentType, a.documentId, amount, docDate);
}

async function loadSettlement(tx: any, companyId: string, voucherId: string, lock = false) {
  const q = tx.select().from(schema.vouchers).where(and(eq(schema.vouchers.id, voucherId), eq(schema.vouchers.companyId, companyId), inArray(schema.vouchers.referenceType, [REF.customer, REF.vendor]), inArray(schema.vouchers.type, ['Receipt', 'Payment'])));
  const [v] = lock ? await q.for('update') : await q;
  if (!v) throw fail(404, 'Receipt or payment not found.');
  const [rev] = await tx.select({ id: schema.vouchers.id }).from(schema.vouchers).where(and(eq(schema.vouchers.companyId, companyId), eq(schema.vouchers.reversalOfVoucherId, v.id)));
  const allocs: any[] = await tx.select().from(schema.paymentAllocations).where(and(eq(schema.paymentAllocations.companyId, companyId), eq(schema.paymentAllocations.voucherId, v.id)));
  const active = allocs.filter(a => !a.reversedAt);
  const kind: SettlementKind = v.referenceType === REF.customer ? 'customer' : 'vendor';
  const applied = round2(active.reduce((s, a) => s + Number(a.amount), 0));
  return { voucher: v, kind, cancelled: !!rev, allocations: allocs, active, applied, unapplied: round2(Number(v.amount) - applied) };
}

// Puts money that was held on account against open documents of the same party.
export async function applyOnAccount(tx: any, req: any, voucherId: string, allocations: AllocationInput[], docDate: string) {
  const companyId = req.targetCompanyId;
  const s = await loadSettlement(tx, companyId, voucherId, true);
  if (s.cancelled) throw fail(400, 'This receipt has been cancelled.');
  if (!(s.unapplied > 0.004)) throw fail(400, 'Nothing is held on account for this receipt.');
  if (!allocations?.length) throw fail(400, 'Choose at least one document.');
  await checkAllocations(tx, companyId, s.kind, s.voucher.referenceId, allocations, s.unapplied, null);
  for (const a of allocations) await allocate(tx, req, voucherId, a, docDate);
  return { applied: round2(allocations.reduce((n, a) => n + Number(a.amount), 0)), unapplied: round2(s.unapplied - allocations.reduce((n, a) => n + Number(a.amount), 0)) };
}

// Cancels a receipt / payment: the entry is reversed, a Reversal voucher is written, and every allocation goes back to its document.
export async function cancelSettlement(tx: any, req: any, voucherId: string, docDate: string, reason: string) {
  const companyId = req.targetCompanyId;
  const s = await loadSettlement(tx, companyId, voucherId, true);
  if (s.cancelled) throw fail(400, 'This receipt has already been cancelled.');
  for (const a of s.active) {
    await movePaid(tx, companyId, a.documentType, a.documentId, -Number(a.amount), docDate);
    await tx.update(schema.paymentAllocations).set({ reversedAt: nowDate(), reversedDate: docDate, reversedById: req.user.id }).where(eq(schema.paymentAllocations.id, a.id));
  }
  await reverseAllEntriesFor(tx, companyId, s.voucher.referenceType, s.voucher.id, docDate, `${s.voucher.voucherNumber} cancelled${reason ? `: ${reason}` : ''}`, req.user.id);
  const voucherNumber = await getAndIncrementDocumentNumber(tx, companyId, 'voucher', docDate, null);
  await tx.insert(schema.vouchers).values({
    id: generateId(), voucherNumber, type: 'Reversal', ...documentDates(docDate), bankId: s.voucher.bankId, amount: s.voucher.amount,
    description: `Reversal of ${s.voucher.voucherNumber}${reason ? `: ${reason}` : ''}`.slice(0, 250), referenceType: s.voucher.referenceType, referenceId: s.voucher.referenceId,
    createdById: req.user.id, createdAt: nowDate(), companyId, branchId: null, reversalOfVoucherId: s.voucher.id,
  });
  return { reversed: s.active.length };
}

// A document that has been settled through a receipt or payment cannot be cancelled until that is undone (its cash movement is on the receipt, not on the document).
export async function assertNoActiveAllocations(tx: any, companyId: string, type: DocType, id: string) {
  const [row] = await tx.select({ v: schema.vouchers.voucherNumber }).from(schema.paymentAllocations)
    .innerJoin(schema.vouchers, and(eq(schema.vouchers.id, schema.paymentAllocations.voucherId), eq(schema.vouchers.companyId, schema.paymentAllocations.companyId)))
    .where(and(eq(schema.paymentAllocations.companyId, companyId), eq(schema.paymentAllocations.documentType, type), eq(schema.paymentAllocations.documentId, id), isNull(schema.paymentAllocations.reversedAt))).limit(1);
  if (row) throw fail(400, `This document was settled through receipt / payment ${row.v}. Cancel that first.`);
}

// The settlements list: one row per receipt or payment with what it applied and what is still on account.
export async function listSettlements(tx: any, companyId: string, kind: SettlementKind, opts: { partyId?: string | null; limit?: number }) {
  const res: any = await tx.execute(sql`
    SELECT v.id, v.voucher_number AS "voucherNumber", v.doc_date AS "docDate", v.posting_date AS "postingDate", v.amount::float8 AS amount, v.description, v.bank_id AS "bankId", v.reference_id AS "partyId",
           (SELECT COALESCE(SUM(a.amount),0)::float8 FROM payment_allocations a WHERE a.company_id = v.company_id AND a.voucher_id = v.id AND a.reversed_at IS NULL) AS applied,
           EXISTS (SELECT 1 FROM vouchers r WHERE r.company_id = v.company_id AND r.reversal_of_voucher_id = v.id) AS cancelled
    FROM vouchers v WHERE v.company_id = ${companyId}::uuid AND v.reference_type = ${REF[kind]} AND v.type IN ('Receipt','Payment') ${opts.partyId ? sql`AND v.reference_id = ${opts.partyId}::uuid` : sql``}
    ORDER BY v.doc_date DESC, v.created_at DESC LIMIT ${opts.limit || 200}`);
  const table: any = kind === 'customer' ? schema.customers : schema.vendors;
  const ids = [...new Set(res.rows.map((r: any) => r.partyId))] as string[];
  const names = ids.length ? await tx.select({ id: table.id, name: table.name }).from(table).where(and(eq(table.companyId, companyId), inArray(table.id, ids))) : [];
  const nameOf = new Map<string, string>(names.map((n: any) => [n.id, n.name]));
  return res.rows.map((r: any) => ({ ...r, partyName: nameOf.get(r.partyId) || '', applied: round2(r.applied), unapplied: r.cancelled ? 0 : round2(r.amount - r.applied) }));
}

export async function settlementDetail(tx: any, companyId: string, voucherId: string) {
  const s = await loadSettlement(tx, companyId, voucherId);
  const table: any = s.kind === 'customer' ? schema.customers : schema.vendors;
  const [party] = await tx.select({ id: table.id, name: table.name, phone: table.phone, email: table.email, address: table.address }).from(table).where(and(eq(table.id, s.voucher.referenceId), eq(table.companyId, companyId)));
  const lines = await Promise.all(s.allocations.map(async (a: any) => {
    const t: any = a.documentType === 'Invoice' ? schema.invoices : a.documentType === 'Expense' ? schema.expenses : schema.purchaseBills;
    const numCol = a.documentType === 'Invoice' ? schema.invoices.invoiceNumber : a.documentType === 'Expense' ? schema.expenses.expenseNumber : schema.purchaseBills.billNumber;
    const [d] = await tx.select({ n: numCol }).from(t).where(and(eq(t.id, a.documentId), eq(t.companyId, companyId)));
    return { id: a.id, documentType: a.documentType, documentId: a.documentId, documentNumber: d?.n || '', amount: Number(a.amount), reversed: !!a.reversedAt };
  }));
  const [bank] = await tx.select({ name: schema.bankAccounts.bankName }).from(schema.bankAccounts).where(eq(schema.bankAccounts.id, s.voucher.bankId));
  // what it posted (and, once cancelled, the reversing entry) and who prepared it: the same payload prints the voucher
  const posting = await postedEntriesOfReference(tx, companyId, s.voucher.referenceType, s.voucher.id);
  const [by] = s.voucher.createdById ? await tx.select({ username: schema.users.username }).from(schema.users).where(eq(schema.users.id, s.voucher.createdById)) : [];
  return { voucher: { ...s.voucher, amount: Number(s.voucher.amount) }, kind: s.kind, party: party || null, bankName: bank?.name || '', cancelled: s.cancelled, allocations: lines, applied: s.applied, unapplied: s.cancelled ? 0 : s.unapplied, posting, preparedBy: by?.username || '' };
}
