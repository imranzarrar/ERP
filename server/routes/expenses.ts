import express from 'express';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import { validateTransactionDate, syncVoucherForExpense, round2, computePaymentStatus, assertQuarterNotFiled } from '../lib/businessLogic.js';
import { getAndIncrementDocumentNumber } from '../lib/documentNumbering.js';
import { normalizePermissions } from '../../src/types.js';
import { parseLimitOffset } from '../lib/pagination.js';
import { generateId } from '../../src/id.js';
import { assertOwnsRow, resolveDocumentBranchId, branchAccessOk } from '../lib/authz.js';

const router = express.Router();

router.get('/', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.expense.read.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const companyId = req.targetCompanyId;
    const { limit, offset } = parseLimitOffset(req);
    const conditions = [eq(schema.expenses.companyId, companyId)];
    // Branch-restricted callers (req.allowedBranchIds is a real array, not null — see
    // isAuthenticated in server.ts) must only see their own branch's expenses, same rule
    // GET /api/state already applies to this table via its own branchOk closure — this
    // standalone REST endpoint had no equivalent check at all until now.
    if (Array.isArray(req.allowedBranchIds)) {
      conditions.push(req.allowedBranchIds.length > 0 ? inArray(schema.expenses.branchId, req.allowedBranchIds) : sql`false`);
    }
    const expenses = await db.select().from(schema.expenses).where(and(...conditions))
      .orderBy(desc(schema.expenses.createdAt)).limit(limit).offset(offset);
    res.json(expenses);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    const data = { ...req.body };

    // This route upserts: an `id` naming an existing row is an edit, not a creation, and
    // must be gated by expense.update, not expense.create - the two are separately
    // grantable now. A cancelled expense is also terminal for edits regardless of
    // permission, same as every other "U blocked once cancelled" rule in this app.
    let existing: typeof schema.expenses.$inferSelect | undefined;
    if (data.id) {
      [existing] = await db.select().from(schema.expenses).where(eq(schema.expenses.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this expense belongs to another company' });
      }
      if (existing && !branchAccessOk(req, existing.branchId)) {
        return res.status(403).json({ error: 'Forbidden: you are not assigned to this branch.' });
      }
    }
    if (existing) {
      if (!permissions.expense.update.enabled) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      if (existing.status === 'Cancelled') {
        return res.status(400).json({ error: 'Cancelled expenses cannot be edited.' });
      }
    } else if (!permissions.expense.create.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // expenseNumber/createdById/createdAt are server-assigned facts, never client
    // input — stripped here so a crafted request body can't inject/overwrite them.
    // Restored below from either a fresh counter (create) or the pre-existing row
    // (update) rather than left absent: expense_number/created_by_id/created_at are
    // all NOT NULL with no column default, and Postgres validates the full candidate
    // row for an `INSERT ... ON CONFLICT DO UPDATE` even when the UPDATE branch is what
    // actually runs (confirmed live — leaving them merely deleted 500'd on update, not
    // just on create). Only the isNew branch (re)assigns them for a genuinely new row.
    // Confirmed live before this fix: every new-expense creation from ExpenseModule.tsx
    // 500'd outright, since the real UI never sends expenseNumber — this route had no
    // counter logic at all, unlike every other document-creation route (invoices/
    // quotations) in transactions.ts, which already does this correctly.
    delete data.expenseNumber;
    delete data.createdById;
    delete data.createdAt;

    // Bill # is mandatory on the create form (ExpenseModule.tsx) — enforced here too so a
    // request bypassing that form (a direct API call, a future integration) can't create
    // an expense with no vendor bill reference at all.
    if (!existing && !String(data.billNumber || '').trim()) {
      return res.status(400).json({ error: 'Bill # is required.' });
    }

    data.companyId = req.targetCompanyId;
    // Branch is immutable after creation, same choke-point pattern as Quotation/Invoice
    // (server/routes/transactions.ts) — resolved/validated before the transaction opens.
    try {
      data.branchId = existing ? existing.branchId : await resolveDocumentBranchId(req, data.branchId);
    } catch (branchErr: any) {
      return res.status(branchErr.status || 400).json({ error: branchErr.error || 'Invalid branch.' });
    }
    // paymentStatus is a derived fact of amountPaid vs. amount, not a client-asserted
    // string — recomputing it here closes the door on an arbitrary/typo'd status value.
    const totalAmount = round2(Number(data.amount || 0));
    const paidAmount = round2(Number(data.amountPaid || 0));
    data.amount = String(totalAmount);
    data.amountPaid = String(paidAmount);
    data.paymentStatus = computePaymentStatus(paidAmount, totalAmount);

    await db.transaction(async (tx) => {
      await validateTransactionDate(data.date, data.companyId);
      await assertQuarterNotFiled(data.date, data.companyId);
      const isNew = !data.id;
      const expenseId = data.id || generateId();

      if (isNew) {
        data.expenseNumber = await getAndIncrementDocumentNumber(tx, data.companyId, 'expense', data.date, data.branchId);
        data.createdById = req.user.id;
        data.createdAt = new Date();
      } else if (existing) {
        data.expenseNumber = existing.expenseNumber;
        data.createdById = existing.createdById;
        data.createdAt = existing.createdAt;
      }

      await tx.insert(schema.expenses).values({
        ...data,
        id: expenseId,
        date: data.date,
        paymentDate: data.paymentDate ? new Date(data.paymentDate) : null,
      }).onConflictDoUpdate({
        target: schema.expenses.id,
        set: {
          ...data,
          date: data.date,
          paymentDate: data.paymentDate ? new Date(data.paymentDate) : null,
        }
      });

      await syncVoucherForExpense(tx, expenseId, data.companyId, data, req.user.id);
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Mark an existing (subsequently) pending expense as paid — ports src/dbStore.ts's
// markExpensePaid exactly: open-month check, partial-payment support, and a fresh
// Payment voucher per settlement (not synced/overwritten like syncVoucherForExpense).
router.post('/:id/pay', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.expense.update.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const { date, bankId, amount } = req.body;
    const companyId = req.targetCompanyId;

    let createdVoucher: any;
    await db.transaction(async (tx) => {
      // FOR UPDATE — without this, two payments landing close together both read the same
      // currentPaid/remaining and the second write silently clobbers the first's
      // amountPaid, even though both Payment vouchers were correctly inserted. Purchase
      // Bills' own /pay route already locks this way; this mirrors it.
      const [expense] = await tx.select().from(schema.expenses)
        .where(and(eq(schema.expenses.id, id), eq(schema.expenses.companyId, companyId))).for('update');
      if (!expense) throw new Error('Expense not found.');
      if (!branchAccessOk(req, expense.branchId)) { const err: any = new Error('Forbidden: you are not assigned to this branch.'); err.status = 403; throw err; }
      if (expense.status === 'Cancelled') throw new Error('Cancelled expenses cannot be paid.');
      if (expense.paymentStatus === 'Paid') throw new Error('Expense is already paid.');

      await validateTransactionDate(date, companyId);

      const targetBankId = bankId || expense.bankId;
      // A client-supplied bankId must actually belong to this company — otherwise a
      // malformed/malicious request could post a disbursement against another tenant's
      // bank account.
      if (bankId) {
        const [bank] = await tx.select({ id: schema.bankAccounts.id }).from(schema.bankAccounts)
          .where(and(eq(schema.bankAccounts.id, targetBankId), eq(schema.bankAccounts.companyId, companyId)));
        if (!bank) {
          const err: any = new Error('Selected bank account was not found for this company.');
          err.status = 400;
          throw err;
        }
      }
      const currentPaid = round2(Number(expense.amountPaid || 0));
      const totalAmount = round2(Number(expense.amount));
      const remaining = round2(totalAmount - currentPaid);

      const paymentAmount = amount !== undefined ? Number(amount) : undefined;
      let amountToPost = remaining;
      if (paymentAmount !== undefined) {
        if (isNaN(paymentAmount) || paymentAmount <= 0) {
          const err: any = new Error('Payment amount must be greater than zero.');
          err.status = 400;
          throw err;
        }
        if (paymentAmount > remaining + 0.01) {
          const err: any = new Error(`Payment amount (${paymentAmount}) exceeds the remaining balance (${remaining}).`);
          err.status = 400;
          throw err;
        }
        amountToPost = Math.min(paymentAmount, remaining);
      }
      if (amountToPost <= 0) {
        const err: any = new Error('No remaining balance to pay.');
        err.status = 400;
        throw err;
      }

      const newPaidAmount = round2(currentPaid + amountToPost);
      const newPaymentStatus = newPaidAmount >= totalAmount - 0.01 ? 'Paid' : 'Partially Paid';

      // The expense's own bankId is left as originally assigned — each installment's real
      // disbursing bank is recorded on its own Payment voucher below instead, the same
      // way the invoice payment route now works.
      await tx.update(schema.expenses).set({
        amountPaid: String(newPaidAmount),
        paymentStatus: newPaymentStatus,
        paymentDate: new Date(date),
      }).where(eq(schema.expenses.id, id));

      // Payment voucher (only if Actual type; accrual settlement handles its own voucher
      // when actual is posted) — matches dbStore.markExpensePaid exactly.
      if (expense.type === 'Actual') {
        const voucherNumber = await getAndIncrementDocumentNumber(tx, companyId, 'voucher', date, expense.branchId);
        const [voucher] = await tx.insert(schema.vouchers).values({
          id: generateId(),
          voucherNumber,
          type: 'Payment',
          date,
          bankId: targetBankId,
          amount: String(amountToPost),
          description: `Payment voucher generated for expense ${expense.expenseNumber} paid subsequently (${amountToPost.toFixed(2)})`,
          referenceType: 'Expense',
          referenceId: id,
          createdById: req.user.id,
          createdAt: new Date(),
          companyId,
          // Always the expense's own branch, never independently picked.
          branchId: expense.branchId,
        }).returning();
        createdVoucher = voucher;
      }
    });

    // Returned so the client can immediately open a printable payment receipt — see
    // DocumentRenderer.tsx's renderVoucher. Undefined for an Accrual settlement (no
    // voucher is created on this path), which the client treats as "nothing to print."
    res.json({ success: true, voucher: createdVoucher });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Cancel an expense — ports src/dbStore.ts's cancelExpense exactly: requires an open
// fiscal month, breaks the accrual<->actual settlement link either direction, and posts
// a Reversal voucher (dated per the open-month-aware fallback below) if a Payment
// voucher was active.
router.post('/:id/cancel', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.expense.delete.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const companyId = req.targetCompanyId;

    await db.transaction(async (tx) => {
      const [expense] = await tx.select().from(schema.expenses)
        .where(and(eq(schema.expenses.id, id), eq(schema.expenses.companyId, companyId)));
      if (!expense) throw new Error('Expense not found.');
      if (!branchAccessOk(req, expense.branchId)) { const err: any = new Error('Forbidden: you are not assigned to this branch.'); err.status = 403; throw err; }
      if (expense.status === 'Cancelled') throw new Error('Expense is already cancelled.');

      const openMonths = await tx.select().from(schema.fiscalMonths)
        .where(and(eq(schema.fiscalMonths.companyId, companyId), eq(schema.fiscalMonths.status, 'Open')));
      const openMonth = openMonths.sort((a, b) => a.id.localeCompare(b.id))[0];
      if (!openMonth) {
        const err: any = new Error('There is no open fiscal month.');
        err.status = 400;
        throw err;
      }

      const todayStr = new Date().toISOString().split('T')[0];
      const finalReversalDate = todayStr.startsWith(openMonth.id)
        ? todayStr
        : (expense.date.startsWith(openMonth.id) ? expense.date : openMonth.id + '-01');

      await tx.update(schema.expenses).set({ status: 'Cancelled' }).where(eq(schema.expenses.id, id));

      if (expense.type === 'Accrual' && expense.settledExpenseId) {
        await tx.update(schema.expenses).set({ originAccrualId: null }).where(eq(schema.expenses.id, expense.settledExpenseId));
      }
      if (expense.type === 'Actual' && expense.originAccrualId) {
        await tx.update(schema.expenses).set({ accrualSettled: false, settledExpenseId: null }).where(eq(schema.expenses.id, expense.originAccrualId));
      }

      const [activePayment] = await tx.select().from(schema.vouchers)
        .where(and(eq(schema.vouchers.referenceId, id), eq(schema.vouchers.referenceType, 'Expense'), eq(schema.vouchers.type, 'Payment')));
      if (activePayment) {
        const voucherNumber = await getAndIncrementDocumentNumber(tx, companyId, 'voucher', finalReversalDate, activePayment.branchId || expense.branchId);
        await tx.insert(schema.vouchers).values({
          id: generateId(),
          voucherNumber,
          type: 'Reversal',
          date: finalReversalDate,
          bankId: activePayment.bankId,
          amount: activePayment.amount,
          description: `Reversal voucher for cancelled expense ${expense.expenseNumber} (Original: ${activePayment.voucherNumber})`,
          referenceType: 'Expense',
          referenceId: id,
          createdById: req.user.id,
          createdAt: new Date(),
          companyId,
          branchId: activePayment.branchId || expense.branchId || null,
        });
      }
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

export default router;
