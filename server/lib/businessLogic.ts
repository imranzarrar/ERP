
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { generateId } from '../../src/id.js';

// Round-half-up to 2 decimals. Applied after every intermediate step in a money
// calculation chain (not just once at the end via .toFixed(2)) so the value written to
// a `decimal(_, 2)` column matches what was actually computed, instead of accumulated
// floating-point drift showing up only when Postgres does its own final rounding.
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
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
export async function getAndIncrementCounter(tx: any, companyId: string, type: 'quotation' | 'invoice' | 'expense' | 'voucher') {
  const [company] = await tx.select().from(schema.companies).where(eq(schema.companies.id, companyId)).for('update');
  if (!company) throw new Error('Company not found');

  const counters = (company.counters as any) || { quotation: 1001, invoice: 1001, expense: 1001, voucher: 1001 };
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
