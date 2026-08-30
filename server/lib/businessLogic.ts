
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and, isNull } from 'drizzle-orm';
import { generateId } from '../../src/id.js';

// Round-half-up to 2 decimals. Applied after every intermediate step in a money
// calculation chain (not just once at the end via .toFixed(2)) so the value written to
// a `decimal(_, 2)` column matches what was actually computed, instead of accumulated
// floating-point drift showing up only when Postgres does its own final rounding.
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Extra precision for weighted-average cost/sale-price calculations (productsServices.
// averageCost/averageSalePrice) — 2 decimals is too coarse for a moving average recomputed
// on every transaction; small rounding error compounds visibly over many receipts/sales.
export function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

// Records one row in the stock ledger for an inventoryStocks mutation that has already
// been applied within the same transaction — this is a read-only audit trail of what
// happened, never a second place that decides quantities itself. `referenceId` is
// polymorphic (GRN/Return/Sale/Adjustment/StockTake id depending on transactionType, same
// as the column comment in schema.ts) — no single-table FK.
export async function writeStockLedgerEntry(tx: any, params: {
  productId: string;
  warehouseId: string;
  companyId: string;
  transactionType: 'GRN' | 'Return' | 'Sale' | 'Adjustment' | 'StockTake';
  referenceId: string;
  date: Date;
  quantityChange: number;
  endingQuantity: number;
  batchNumber?: string | null;
}) {
  await tx.insert(schema.stockLedgerTransactions).values({
    id: generateId(),
    productId: params.productId,
    warehouseId: params.warehouseId,
    transactionType: params.transactionType,
    referenceId: params.referenceId,
    date: params.date,
    quantityChange: String(round2(params.quantityChange)),
    endingQuantity: String(round2(params.endingQuantity)),
    batchNumber: params.batchNumber || null,
    companyId: params.companyId,
  });
}

// Deducts a sold quantity from inventoryStocks for one invoice/POS line and records the
// movement in the stock ledger. Only applies to catalog-linked lines on true "item" type
// products — a free-typed line (no productId) has nothing to deduct, and a "service" line
// (productId set but type === 'service') has no physical stock at all, so both are no-ops
// here rather than errors. Also no-ops when the product has no defaultWarehouseId
// configured — there is nowhere to deduct from, and a sale must never be blocked by
// incomplete inventory setup on a product. Clamped at 0 rather than allowed to go
// negative, matching every other stock-mutating route in this app (GRN reversal, Purchase
// Return, Stock Adjustment).
export async function deductStockForSale(tx: any, companyId: string, productId: string, quantitySold: number, referenceId: string, date: Date) {
  const [product] = await tx.select({
    type: schema.productsServices.type,
    defaultWarehouseId: schema.productsServices.defaultWarehouseId,
  }).from(schema.productsServices).where(eq(schema.productsServices.id, productId)).for('update');
  if (!product || product.type !== 'item' || !product.defaultWarehouseId) return;

  const warehouseId = product.defaultWarehouseId;
  const [existingStock] = await tx.select().from(schema.inventoryStocks)
    .where(and(
      eq(schema.inventoryStocks.productId, productId),
      eq(schema.inventoryStocks.warehouseId, warehouseId),
      eq(schema.inventoryStocks.companyId, companyId),
      isNull(schema.inventoryStocks.batchNumber)
    ))
    .for('update');

  const priorQty = existingStock ? Number(existingStock.quantity) : 0;
  const newQty = Math.max(0, round2(priorQty - quantitySold));

  if (existingStock) {
    await tx.update(schema.inventoryStocks).set({ quantity: String(newQty) }).where(eq(schema.inventoryStocks.id, existingStock.id));
  } else {
    await tx.insert(schema.inventoryStocks).values({
      id: generateId(), productId, warehouseId, batchNumber: null, quantity: String(newQty), companyId,
    });
  }

  await writeStockLedgerEntry(tx, {
    productId, warehouseId, companyId,
    transactionType: 'Sale', referenceId, date,
    quantityChange: newQty - priorQty,
    endingQuantity: newQty, batchNumber: null,
  });
}

// Payment status is a derived fact of amountPaid vs. the total, not something the
// client should get to assert directly — previously every route trusted
// req.body.paymentStatus verbatim, which produced inconsistent/duplicate values in
// live data ('Partial' and 'Partially Paid' both meaning the same thing).
export function computePaymentStatus(amountPaid: number, total: number): 'Paid' | 'Partially Paid' | 'Unpaid' {
  const paid = round2(amountPaid || 0);
  const grand = round2(total || 0);
  if (paid <= 0) return 'Unpaid';
  if (paid >= grand) return 'Paid';
  return 'Partially Paid';
}

// Must always be called with the transaction executor of an enclosing `db.transaction(...)`
// block — the `SELECT ... FOR UPDATE` row lock this takes is only meaningful for the
// lifetime of that transaction. Calling it with the bare `db` object (as this function
// used to allow) provides no protection: the lock is released the instant the SELECT
// statement completes, since there's no surrounding transaction to hold it open, and two
// concurrent requests for the same company can both read the same counter value and both
// commit N+1, producing duplicate invoice/quotation/expense/voucher numbers.
export async function getAndIncrementCounter(tx: any, companyId: string, type: 'quotation' | 'invoice' | 'expense' | 'voucher' | 'pr' | 'po' | 'grn' | 'creditNote' | 'debitNote' | 'bill' | 'return' | 'stockTake') {
  const [company] = await tx.select().from(schema.companies).where(eq(schema.companies.id, companyId)).for('update');
  if (!company) throw new Error('Company not found');

  const counters = (company.counters as any) || { quotation: 1001, invoice: 1001, expense: 1001, voucher: 1001, pr: 1001, po: 1001, grn: 1001, creditNote: 1001, debitNote: 1001 };
  const currentCount = counters[type] || 1001;

  counters[type] = currentCount + 1;

  await tx.update(schema.companies).set({ counters }).where(eq(schema.companies.id, companyId));

  return currentCount;
}

export async function validateTransactionDate(date: string, companyId: string) {
  if (!date || !companyId) {
    const err = new Error('Transaction date and company ID are required for validation');
    (err as any).status = 400;
    throw err;
  }
  
  const monthId = date.substring(0, 7); // e.g. "2026-07"
  const [month] = await db.select()
    .from(schema.fiscalMonths)
    .where(
      and(
        eq(schema.fiscalMonths.id, monthId),
        eq(schema.fiscalMonths.companyId, companyId)
      )
    );
    
  if (!month) {
    const err = new Error(`Transaction date ${date} does not fall within any defined fiscal month.`);
    (err as any).status = 400;
    throw err;
  }
  
  if (month.status?.toLowerCase() !== 'open') {
    const err = new Error(`Transaction date ${date} falls in a closed fiscal month (${month.name}).`);
    (err as any).status = 400;
    throw err;
  }
  
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = String(now.getMonth() + 1).padStart(2, '0');
  const currentYearMonth = `${currentYear}-${currentMonth}`;
  
  if (monthId > currentYearMonth) {
    const err = new Error(`Transaction date ${date} falls in a future fiscal month (${month.name}).`);
    (err as any).status = 400;
    throw err;
  }
  
  return { valid: true, month };
}

export async function syncVoucherForExpense(tx: any, expenseId: string, companyId: string, data: any, userId: string) {
  const [existingVoucher] = await tx.select()
    .from(schema.vouchers)
    .where(
      and(
        eq(schema.vouchers.referenceType, 'Expense'),
        eq(schema.vouchers.referenceId, expenseId),
        eq(schema.vouchers.type, 'Payment')
      )
    );

  if (data.paymentStatus === 'Paid' && data.status !== 'Cancelled') {
    if (existingVoucher) {
      // Check if voucher's month is closed
      const voucherMonthId = existingVoucher.date.substring(0, 7);
      const [voucherMonth] = await tx.select()
        .from(schema.fiscalMonths)
        .where(
          and(
            eq(schema.fiscalMonths.id, voucherMonthId),
            eq(schema.fiscalMonths.companyId, companyId)
          )
        );
      const isVoucherMonthClosed = !voucherMonth || voucherMonth.status?.toLowerCase() !== 'open';

      if (!isVoucherMonthClosed) {
        await tx.update(schema.vouchers)
          .set({
            date: data.date,
            bankId: data.bankId,
            amount: data.amount,
            description: `Payment voucher for ${data.description || 'Expense'}`,
            companyId: companyId,
          })
          .where(eq(schema.vouchers.id, existingVoucher.id));
      }
    } else {
      const vchCount = await getAndIncrementCounter(tx, companyId, 'voucher');
      const voucherNumber = `VCH-${vchCount}`;
      await tx.insert(schema.vouchers).values({
        id: generateId(),
        voucherNumber,
        type: 'Payment',
        date: data.date,
        bankId: data.bankId,
        amount: data.amount,
        description: `Payment voucher for ${data.description || 'Expense'}`,
        referenceType: 'Expense',
        referenceId: expenseId,
        companyId: companyId,
        createdById: userId,
        createdAt: new Date(),
      });
    }
  } else {
    if (existingVoucher) {
      // Check if voucher's month is closed
      const voucherMonthId = existingVoucher.date.substring(0, 7);
      const [voucherMonth] = await tx.select()
        .from(schema.fiscalMonths)
        .where(
          and(
            eq(schema.fiscalMonths.id, voucherMonthId),
            eq(schema.fiscalMonths.companyId, companyId)
          )
        );
      const isVoucherMonthClosed = !voucherMonth || voucherMonth.status?.toLowerCase() !== 'open';

      if (isVoucherMonthClosed) {
        // Find existing reversal
        const [existingReversal] = await tx.select()
          .from(schema.vouchers)
          .where(
            and(
              eq(schema.vouchers.referenceType, 'Expense'),
              eq(schema.vouchers.referenceId, expenseId),
              eq(schema.vouchers.type, 'Reversal')
            )
          );

        if (!existingReversal) {
          const [openMonth] = await tx.select()
            .from(schema.fiscalMonths)
            .where(
              and(
                eq(schema.fiscalMonths.status, 'Open'),
                eq(schema.fiscalMonths.companyId, companyId)
              )
            )
            .limit(1);

          const todayStr = new Date().toISOString().split('T')[0];
          let finalReversalDate = todayStr;
          if (openMonth) {
            finalReversalDate = todayStr.startsWith(openMonth.id) 
              ? todayStr 
              : (data.date && data.date.startsWith(openMonth.id) ? data.date : openMonth.id + "-01");
          }

          const vchCount = await getAndIncrementCounter(tx, companyId, 'voucher');
          const voucherNumber = `VCH-${vchCount}`;
          await tx.insert(schema.vouchers).values({
            id: generateId(),
            voucherNumber,
            type: 'Reversal',
            date: finalReversalDate,
            bankId: existingVoucher.bankId,
            amount: existingVoucher.amount,
            description: `Reversal voucher for cancelled expense ${data.expenseNumber || ''} (Original: ${existingVoucher.voucherNumber})`,
            referenceType: 'Expense',
            referenceId: expenseId,
            companyId: companyId,
            createdById: userId,
            createdAt: new Date(),
          });
        }
      } else {
        await tx.delete(schema.vouchers).where(eq(schema.vouchers.id, existingVoucher.id));
      }
    }
  }
}

export async function syncVoucherForInvoice(tx: any, invoiceId: string, companyId: string, data: any, userId: string) {
  const [existingVoucher] = await tx.select()
    .from(schema.vouchers)
    .where(
      and(
        eq(schema.vouchers.referenceType, 'Invoice'),
        eq(schema.vouchers.referenceId, invoiceId),
        eq(schema.vouchers.type, 'Receipt')
      )
    );

  if (data.paymentStatus === 'Paid' && data.status !== 'Cancelled') {
    if (existingVoucher) {
      // Check if voucher's month is closed
      const voucherMonthId = existingVoucher.date.substring(0, 7);
      const [voucherMonth] = await tx.select()
        .from(schema.fiscalMonths)
        .where(
          and(
            eq(schema.fiscalMonths.id, voucherMonthId),
            eq(schema.fiscalMonths.companyId, companyId)
          )
        );
      const isVoucherMonthClosed = !voucherMonth || voucherMonth.status?.toLowerCase() !== 'open';

      if (!isVoucherMonthClosed) {
        await tx.update(schema.vouchers)
          .set({
            date: String(data.paymentDate || data.date),
            bankId: data.bankId,
            amount: data.amountPaid || data.amount,
            description: `Receipt voucher generated automatically for paid invoice ${data.invoiceNumber}`,
            companyId: companyId,
          })
          .where(eq(schema.vouchers.id, existingVoucher.id));
      }
    } else {
      const vchCount = await getAndIncrementCounter(tx, companyId, 'voucher');
      const voucherNumber = `VCH-${vchCount}`;
      await tx.insert(schema.vouchers).values({
        id: generateId(),
        voucherNumber,
        type: 'Receipt',
        date: String(data.paymentDate || data.date),
        bankId: data.bankId,
        amount: data.amountPaid || data.amount,
        description: `Receipt voucher generated automatically for paid invoice ${data.invoiceNumber}`,
        referenceType: 'Invoice',
        referenceId: invoiceId,
        companyId: companyId,
        createdById: userId,
        createdAt: new Date(),
      });
    }
  } else {
    if (existingVoucher) {
      // Check if voucher's month is closed
      const voucherMonthId = existingVoucher.date.substring(0, 7);
      const [voucherMonth] = await tx.select()
        .from(schema.fiscalMonths)
        .where(
          and(
            eq(schema.fiscalMonths.id, voucherMonthId),
            eq(schema.fiscalMonths.companyId, companyId)
          )
        );
      const isVoucherMonthClosed = !voucherMonth || voucherMonth.status?.toLowerCase() !== 'open';

      if (isVoucherMonthClosed) {
        // Find existing reversal
        const [existingReversal] = await tx.select()
          .from(schema.vouchers)
          .where(
            and(
              eq(schema.vouchers.referenceType, 'Invoice'),
              eq(schema.vouchers.referenceId, invoiceId),
              eq(schema.vouchers.type, 'Reversal')
            )
          );

        if (!existingReversal) {
          const [openMonth] = await tx.select()
            .from(schema.fiscalMonths)
            .where(
              and(
                eq(schema.fiscalMonths.status, 'Open'),
                eq(schema.fiscalMonths.companyId, companyId)
              )
            )
            .limit(1);

          const todayStr = new Date().toISOString().split('T')[0];
          let finalReversalDate = todayStr;
          if (openMonth) {
            finalReversalDate = todayStr.startsWith(openMonth.id) 
              ? todayStr 
              : (data.date && data.date.startsWith(openMonth.id) ? data.date : openMonth.id + "-01");
          }

          const vchCount = await getAndIncrementCounter(tx, companyId, 'voucher');
          const voucherNumber = `VCH-${vchCount}`;
          await tx.insert(schema.vouchers).values({
            id: generateId(),
            voucherNumber,
            type: 'Reversal',
            date: finalReversalDate,
            bankId: existingVoucher.bankId,
            amount: existingVoucher.amount,
            description: `Reversal voucher for cancelled invoice ${data.invoiceNumber || ''} (Original: ${existingVoucher.voucherNumber})`,
            referenceType: 'Invoice',
            referenceId: invoiceId,
            companyId: companyId,
            createdById: userId,
            createdAt: new Date(),
          });
        }
      } else {
        await tx.delete(schema.vouchers).where(eq(schema.vouchers.id, existingVoucher.id));
      }
    }
  }
}

// A Credit Note reverses money actually received on the original invoice — unlike
// Cancel (which flips the original invoice's own status and, within an open month, can
// legitimately wipe its Receipt as if the sale never happened), a Credit Note leaves the
// original invoice's own status/paymentStatus/amountPaid untouched by design (it really
// did happen — see CLAUDE.md's ZATCA section and the /invoices/:id/note route). Deleting
// the original Receipt voucher (as syncVoucherForInvoice's open-month branch does for
// Cancel) would therefore leave the invoice showing "Paid" with no corresponding bank
// entry anywhere — the exact inconsistency reported against the Bank Statement Ledger.
// So this always posts a genuine Reversal voucher and never touches the original Receipt,
// regardless of whether the original's fiscal month is open or closed.
export async function postCreditNoteReversalVoucher(tx: any, originalInvoiceId: string, companyId: string, creditNoteDate: string, userId: string) {
  const [existingVoucher] = await tx.select()
    .from(schema.vouchers)
    .where(
      and(
        eq(schema.vouchers.referenceType, 'Invoice'),
        eq(schema.vouchers.referenceId, originalInvoiceId),
        eq(schema.vouchers.type, 'Receipt')
      )
    );
  if (!existingVoucher) return;

  const [existingReversal] = await tx.select()
    .from(schema.vouchers)
    .where(
      and(
        eq(schema.vouchers.referenceType, 'Invoice'),
        eq(schema.vouchers.referenceId, originalInvoiceId),
        eq(schema.vouchers.type, 'Reversal')
      )
    );
  if (existingReversal) return;

  // The reversal is happening now, not on the original invoice's date — but a posting
  // still can't land in a closed fiscal month (same invariant syncVoucherForInvoice's own
  // reversal branch enforces above). Prefer today; if today isn't in the open month, clamp
  // into it the same way — the credit note's own date if that falls inside the open month,
  // else the 1st of the open month.
  const [openMonth] = await tx.select()
    .from(schema.fiscalMonths)
    .where(
      and(
        eq(schema.fiscalMonths.status, 'Open'),
        eq(schema.fiscalMonths.companyId, companyId)
      )
    )
    .limit(1);

  const todayStr = new Date().toISOString().split('T')[0];
  let finalReversalDate = todayStr;
  if (openMonth) {
    finalReversalDate = todayStr.startsWith(openMonth.id)
      ? todayStr
      : (creditNoteDate && creditNoteDate.startsWith(openMonth.id) ? creditNoteDate : openMonth.id + "-01");
  }

  const vchCount = await getAndIncrementCounter(tx, companyId, 'voucher');
  const voucherNumber = `VCH-${vchCount}`;
  await tx.insert(schema.vouchers).values({
    id: generateId(),
    voucherNumber,
    type: 'Reversal',
    date: finalReversalDate,
    bankId: existingVoucher.bankId,
    amount: existingVoucher.amount,
    description: `Reversal voucher for credited invoice (Original: ${existingVoucher.voucherNumber})`,
    referenceType: 'Invoice',
    referenceId: originalInvoiceId,
    companyId: companyId,
    createdById: userId,
    createdAt: new Date(),
  });
}
