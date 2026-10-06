// Shared GRN -> Purchase Bill -> Payment logic, used by both the standalone
// POST /purchase-bills / POST /purchase-bills/:id/pay routes AND the GRN "auto-post
// Bill, paid at delivery" checkbox (POST /goods-receipt-notes with autoPostBillPaid) —
// one shared path for every caller, per the explicit decision this was built to follow
// (see server/routes/inventory.ts's own comments on both call sites). Callers own their
// own permission checks and branch resolution; these functions take already-resolved
// values and are pure business logic, composable inside either route's own transaction.
import * as schema from '../../src/db/schema.js';
import { eq, and, inArray } from 'drizzle-orm';
import { round2 } from './businessLogic.js';
import { getAndIncrementDocumentNumber } from './documentNumbering.js';
import { generateId } from '../../src/id.js';
import { postJournalEntry, reverseAllEntriesFor } from './ledger.js';
import { nowDate } from './clock.js';

// Drizzle/node-postgres return decimal columns as strings and timestamp columns as Date
// objects — fine for server-side math (everything here already goes through Number(...)/
// round2 itself), but the client's PurchaseBill type (src/types.ts) expects subTotal/
// taxTotal/grandTotal/amountPaid as numbers and date/dueDate as strings, exactly like
// src/db/apiState.ts's own billsMapped conversion for GET /api/state. Every route that
// hands a bill row straight back to the client (create, pay, edit, cancel, and the GRN
// auto-post-bill flow) must run it through this first — found missing here: a
// freshly-created or just-paid bill's raw untyped fields reached the client, and
// InventoryModule.tsx's own `b.grandTotal.toFixed(2)` (a string has no .toFixed) crashed
// the whole page on creation, recovering only once a full page reload re-fetched the
// properly-converted state.
export function normalizePurchaseBillForClient(bill: typeof schema.purchaseBills.$inferSelect): any {
  return {
    ...bill,
    date: bill.date instanceof Date ? bill.date.toISOString() : bill.date,
    dueDate: bill.dueDate instanceof Date ? bill.dueDate.toISOString() : bill.dueDate,
    subTotal: Number(bill.subTotal),
    taxTotal: Number(bill.taxTotal),
    grandTotal: Number(bill.grandTotal),
    amountPaid: Number(bill.amountPaid),
  };
}

export interface CreatePurchaseBillInput {
  companyId: string;
  grnIds: string[];
  branchId: string | null;
  bankId?: string | null;
  dueDate?: string | null;
  vendorBillNumber?: string | null;
  // The bill's own date (the supplier invoice date), YYYY-MM-DD — mandatory, validated by the caller like every other dated document.
  date: string;
  userId: string;
}

// Row 9 of the posting-rules table: Dr GR/IR Clearing (tax-exclusive, reversing row 8's
// entry for each referenced GRN) / Dr VAT Input (tax amount, now claimable) / Cr AP
// (full tax-inclusive total).
export async function createPurchaseBillForGrns(tx: any, input: CreatePurchaseBillInput) {
  const { companyId, grnIds, branchId, bankId, dueDate, vendorBillNumber, userId, date } = input;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    const err: any = new Error('A bill date is required (YYYY-MM-DD).');
    err.status = 400;
    throw err;
  }
  if (!grnIds || grnIds.length === 0) {
    const err: any = new Error('At least one goods receipt note must be referenced.');
    err.status = 400;
    throw err;
  }

  const grns: any[] = [];
  let vendorId: string | null = null;
  for (const grnId of grnIds) {
    const [grn] = await tx.select().from(schema.goodsReceiptNotes)
      .where(and(eq(schema.goodsReceiptNotes.id, grnId), eq(schema.goodsReceiptNotes.companyId, companyId)))
      .for('update');
    if (!grn) {
      const err: any = new Error(`Goods receipt note ${grnId} not found.`);
      err.status = 404;
      throw err;
    }
    if (grn.isReversed) {
      const err: any = new Error(`Goods receipt note ${grn.grnNumber} has been reversed and cannot be billed.`);
      err.status = 400;
      throw err;
    }
    if (grn.isBilled) {
      const err: any = new Error(`Goods receipt note ${grn.grnNumber} has already been billed.`);
      err.status = 400;
      throw err;
    }
    if (vendorId === null) {
      vendorId = grn.vendorId;
    } else if (vendorId !== grn.vendorId) {
      const err: any = new Error('All referenced goods receipt notes must be from the same vendor.');
      err.status = 400;
      throw err;
    }
    grns.push(grn);
  }

  const grnItems = await tx.select().from(schema.goodsReceiptNoteItems)
    .where(inArray(schema.goodsReceiptNoteItems.grnId, grns.map((g: any) => g.id)));

  let subTotal = 0;
  let taxTotal = 0;
  for (const item of grnItems) {
    const lineSubtotal = round2(Number(item.quantityReceived) * Number(item.unitCost));
    const lineTax = round2(lineSubtotal * (Number(item.taxRate || 0) / 100));
    subTotal = round2(subTotal + lineSubtotal);
    taxTotal = round2(taxTotal + lineTax);
  }
  const grandTotal = round2(subTotal + taxTotal);

  const billDateStr = date;
  const billNumber = await getAndIncrementDocumentNumber(tx, companyId, 'bill', billDateStr, branchId);
  const billId = generateId();

  const [newBill] = await tx.insert(schema.purchaseBills).values({
    id: billId,
    billNumber,
    vendorBillNumber: vendorBillNumber || null,
    vendorId: vendorId!,
    // A bill entered today keeps its entry time; a back-dated one sits at noon UTC of its day.
    date: date === nowDate().toISOString().slice(0, 10) ? nowDate() : new Date(date + 'T12:00:00.000Z'),
    dueDate: dueDate ? new Date(dueDate) : null,
    grnIds: grns.map((g: any) => g.id).join(','),
    subTotal: String(subTotal),
    taxTotal: String(taxTotal),
    grandTotal: String(grandTotal),
    status: 'Unpaid',
    amountPaid: '0',
    bankId: bankId || null,
    companyId,
    branchId,
  }).returning();

  await tx.update(schema.goodsReceiptNotes)
    .set({ isBilled: true })
    .where(inArray(schema.goodsReceiptNotes.id, grns.map((g: any) => g.id)));

  if (subTotal > 0 || taxTotal > 0) {
    await postJournalEntry(tx, {
      companyId,
      branchId,
      date: billDateStr,
      referenceType: 'PurchaseBill',
      referenceId: billId,
      description: `Purchase Bill ${billNumber} raised`,
      createdById: userId,
      lines: [
        { accountKey: 'GR_IR_CLEARING', debit: subTotal },
        ...(taxTotal > 0 ? [{ accountKey: 'VAT_INPUT', debit: taxTotal }] : []),
        { accountKey: 'AP', credit: grandTotal },
      ],
    });
  }

  return normalizePurchaseBillForClient(newBill);
}

export interface PayPurchaseBillInput {
  companyId: string;
  billId: string;
  date: string;
  bankId?: string | null;
  // Undefined pays the full remaining balance — used by the GRN auto-post-bill flow,
  // which always pays in full.
  amount?: number;
  userId: string;
}

// Row 10: Dr AP / Cr Bank, for whatever installment is actually paid.
export async function payPurchaseBillInFull(tx: any, input: PayPurchaseBillInput) {
  const { companyId, billId, date, bankId, amount, userId } = input;
  const [bill] = await tx.select().from(schema.purchaseBills)
    .where(and(eq(schema.purchaseBills.id, billId), eq(schema.purchaseBills.companyId, companyId)))
    .for('update');
  if (!bill) {
    const err: any = new Error('Purchase bill not found.');
    err.status = 404;
    throw err;
  }
  if (bill.status === 'Cancelled') {
    const err: any = new Error('Cancelled bills cannot be paid.');
    err.status = 400;
    throw err;
  }
  if (bill.status === 'Paid') {
    const err: any = new Error('Bill is already fully paid.');
    err.status = 400;
    throw err;
  }

  const targetBankId = bankId || bill.bankId;
  if (!targetBankId) {
    const err: any = new Error('A bank account is required to record this payment.');
    err.status = 400;
    throw err;
  }

  const currentPaid = round2(Number(bill.amountPaid || 0));
  const totalAmount = round2(Number(bill.grandTotal));
  const remaining = round2(totalAmount - currentPaid);

  let amountToPost = remaining;
  if (amount !== undefined) {
    if (isNaN(amount) || amount <= 0) {
      const err: any = new Error('Payment amount must be greater than zero.');
      err.status = 400;
      throw err;
    }
    if (amount > remaining + 0.01) {
      const err: any = new Error(`Payment amount (${amount}) exceeds the remaining balance (${remaining}).`);
      err.status = 400;
      throw err;
    }
    amountToPost = Math.min(amount, remaining);
  }
  if (amountToPost <= 0) {
    const err: any = new Error('No remaining balance to pay.');
    err.status = 400;
    throw err;
  }

  const newPaidAmount = round2(currentPaid + amountToPost);
  const newStatus = newPaidAmount >= totalAmount - 0.01 ? 'Paid' : 'Partially Paid';

  const [newBill] = await tx.update(schema.purchaseBills).set({
    amountPaid: String(newPaidAmount),
    status: newStatus,
  }).where(eq(schema.purchaseBills.id, billId)).returning();

  const voucherNumber = await getAndIncrementDocumentNumber(tx, companyId, 'voucher', date, bill.branchId);
  const [voucher] = await tx.insert(schema.vouchers).values({
    id: generateId(),
    voucherNumber,
    type: 'Payment',
    date,
    bankId: targetBankId,
    amount: String(amountToPost),
    description: `Payment voucher for purchase bill ${bill.billNumber} (${amountToPost.toFixed(2)})`,
    referenceType: 'PurchaseBill',
    referenceId: billId,
    createdById: userId,
    createdAt: nowDate(),
    companyId,
    branchId: bill.branchId,
  }).returning();

  await postJournalEntry(tx, {
    companyId,
    branchId: bill.branchId,
    date,
    referenceType: 'PurchaseBill',
    referenceId: billId,
    description: `Payment for purchase bill ${bill.billNumber} (installment)`,
    createdById: userId,
    lines: [
      { accountKey: 'AP', debit: amountToPost },
      { accountKey: 'BANK', credit: amountToPost, bankId: targetBankId },
    ],
  });

  // Same reasoning as normalizePurchaseBillForClient above — InventoryModule.tsx passes
  // this straight into onPrintDoc('PaymentReceipt', ...) for the payment-receipt preview,
  // which formats `amount` with .toFixed(2); left as a raw decimal string it would crash
  // there exactly like the bill's own totals did.
  const normalizedVoucher = { ...voucher, amount: Number(voucher.amount), createdAt: voucher.createdAt instanceof Date ? voucher.createdAt.toISOString() : voucher.createdAt };

  return { bill: normalizePurchaseBillForClient(newBill), voucher: normalizedVoucher };
}
