import express from 'express';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and, asc, desc, inArray, sql, count, gte, lte, ne } from 'drizzle-orm';
import { validateTransactionDate, syncVoucherForExpense, round2, computePaymentStatus, assertQuarterNotFiled, assertQuarterNotFrozen, cancelExpense, splitExpenseTaxInclusiveAmount } from '../lib/businessLogic.js';
import { postJournalEntry } from '../lib/ledger.js';
import { getAndIncrementDocumentNumber } from '../lib/documentNumbering.js';
import { normalizePermissions } from '../../src/types.js';
import { parseLimitOffset, parsePageSort, wantsPaged } from '../lib/pagination.js';
import { generateId } from '../../src/id.js';
import { assertOwnsRow, resolveDocumentBranchId, branchAccessOk } from '../lib/authz.js';
import { recordAuditLog } from '../lib/audit.js';
import { withTenantDb, tenantDb } from '../lib/tenantDb.js';
import { nowDate } from '../lib/clock.js';

const router = express.Router();

const EXPENSES_SORTABLE = {
  expenseNumber: schema.expenses.expenseNumber,
  date: schema.expenses.date,
  createdAt: schema.expenses.createdAt,
  amount: schema.expenses.amount,
  status: schema.expenses.status,
  paymentStatus: schema.expenses.paymentStatus,
  description: schema.expenses.description,
  type: schema.expenses.type,
} as const;

router.get('/', withTenantDb, async (req: any, res) => {
  try {
    const tdb = tenantDb();
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.expense.read.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const companyId = req.targetCompanyId;
    const conditions = [eq(schema.expenses.companyId, companyId)];
    // Branch-restricted callers (req.allowedBranchIds is a real array, not null — see
    // isAuthenticated in server.ts) must only see their own branch's expenses, same rule
    // GET /api/state already applies to this table via its own branchOk closure — this
    // standalone REST endpoint had no equivalent check at all until now.
    if (Array.isArray(req.allowedBranchIds)) {
      conditions.push(req.allowedBranchIds.length > 0 ? inArray(schema.expenses.branchId, req.allowedBranchIds) : sql`false`);
    }
    const search = String(req.query?.search || '').trim();
    if (search) {
      conditions.push(sql`${schema.expenses.expenseNumber} ILIKE ${'%' + search + '%'}`);
    }
    // Server-side equivalents of ExpenseModule.tsx's own client-side filteredExpenses logic,
    // scoped by the whereClause's own companyId condition above — never client-supplied.
    const startDate = String(req.query?.startDate || '').trim();
    if (startDate) conditions.push(gte(schema.expenses.date, startDate));
    const endDate = String(req.query?.endDate || '').trim();
    if (endDate) conditions.push(lte(schema.expenses.date, endDate));
    if (req.query?.status === 'Unpaid') {
      conditions.push(ne(schema.expenses.paymentStatus, 'Paid'));
      conditions.push(eq(schema.expenses.status, 'Active'));
    }
    const whereClause = and(...conditions);
    const paged = wantsPaged(req);

    // Drizzle returns decimal columns as strings — convert to numbers here the same way
    // src/db/apiState.ts's expensesWithItems does for db.expenses.
    const numify = (e: typeof schema.expenses.$inferSelect) => ({
      ...e,
      amount: Number(e.amount),
      amountPaid: e.amountPaid ? Number(e.amountPaid) : undefined,
    });
    if (!paged) {
      const { limit, offset } = parseLimitOffset(req);
      const expenses = await tdb.select().from(schema.expenses).where(whereClause)
        .orderBy(desc(schema.expenses.createdAt)).limit(limit).offset(offset);
      return res.json(expenses.map(numify));
    }
    const { pageSize, offset, sortBy, sortDir, page } = parsePageSort(req, EXPENSES_SORTABLE, 'createdAt', 'desc');
    const orderFn = sortDir === 'asc' ? asc : desc;
    const [countResult, rawRows] = await Promise.all([
      tdb.select({ value: count() }).from(schema.expenses).where(whereClause),
      tdb.select().from(schema.expenses).where(whereClause).orderBy(orderFn(EXPENSES_SORTABLE[sortBy])).limit(pageSize).offset(offset),
    ]);
    res.json({ rows: rawRows.map(numify), total: countResult[0].value, page, pageSize });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', withTenantDb, async (req: any, res) => {
  try {
    const tdb = tenantDb();
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    const data = { ...req.body };

    // This route upserts: an `id` naming an existing row is an edit, not a creation, and
    // must be gated by expense.update, not expense.create - the two are separately
    // grantable now. A cancelled expense is also terminal for edits regardless of
    // permission, same as every other "U blocked once cancelled" rule in this app.
    //
    // Deliberately the superuser `db` — same hijack-detection reasoning as POST
    // /customers in masterEntities.ts.
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

    // No separate db.transaction() wrapper — withTenantDb already wraps the whole
    // request in one transaction.
    await validateTransactionDate(data.date, data.companyId);
    await assertQuarterNotFrozen(data.date, data.companyId);
    const isNew = !data.id;
    const expenseId = data.id || generateId();

    if (isNew) {
      data.expenseNumber = await getAndIncrementDocumentNumber(tdb, data.companyId, 'expense', data.date, data.branchId);
      data.createdById = req.user.id;
      data.createdAt = nowDate();
    } else if (existing) {
      data.expenseNumber = existing.expenseNumber;
      data.createdById = existing.createdById;
      data.createdAt = existing.createdAt;
    }

    await tdb.insert(schema.expenses).values({
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

    await syncVoucherForExpense(tdb, expenseId, data.companyId, data, req.user.id);

    // Phase 2 ledger posting (rows 5/5a) — gated to genuinely new expenses only, same
    // deliberate Phase 1 scope boundary as Invoice creation: an edit to an existing,
    // not-yet-cancelled expense does not re-sync the ledger in this phase.
    if (isNew) {
      const [taxSlab] = data.taxSlabId ? await tdb.select().from(schema.taxSlabs).where(eq(schema.taxSlabs.id, data.taxSlabId)) : [undefined];
      const taxPct = taxSlab ? Number(taxSlab.percentage) : 0;
      const { netAmount, taxAmount } = splitExpenseTaxInclusiveAmount(totalAmount, taxPct);
      const expenseAccountKey = data.classification === 'Asset' ? 'FIXED_ASSETS' : 'DIRECT_OPEX';
      await postJournalEntry(tdb, {
        companyId: data.companyId,
        branchId: data.branchId,
        date: data.date,
        referenceType: 'Expense',
        referenceId: expenseId,
        description: `Expense ${data.expenseNumber} raised`,
        createdById: req.user.id,
        lines: [
          { accountKey: expenseAccountKey, debit: netAmount },
          ...(taxAmount > 0 ? [{ accountKey: 'VAT_INPUT', debit: taxAmount }] : []),
          { accountKey: 'AP', credit: totalAmount },
        ],
      });
      if (paidAmount > 0) {
        await postJournalEntry(tdb, {
          companyId: data.companyId,
          branchId: data.branchId,
          date: data.date,
          referenceType: 'Expense',
          referenceId: expenseId,
          description: `Payment at creation for expense ${data.expenseNumber}`,
          createdById: req.user.id,
          lines: [
            { accountKey: 'AP', debit: paidAmount },
            { accountKey: 'BANK', credit: paidAmount, bankId: data.bankId },
          ],
        });
      }
    }

    recordAuditLog(req, isNew ? 'CREATE_EXPENSE' : 'UPDATE_EXPENSE', 'expense', expenseId, {
      expenseNumber: data.expenseNumber,
      billNumber: data.billNumber,
      vendorId: data.vendorId,
      amount: data.amount,
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Mark an existing (subsequently) pending expense as paid — ports src/dbStore.ts's
// markExpensePaid exactly: open-month check, partial-payment support, and a fresh
// Payment voucher per settlement (not synced/overwritten like syncVoucherForExpense).
router.post('/:id/pay', withTenantDb, async (req: any, res) => {
  try {
    const tdb = tenantDb();
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.expense.update.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const { date, bankId, amount } = req.body;
    const companyId = req.targetCompanyId;

    let createdVoucher: any;
    let paidExpenseNumber = '';
    // No separate db.transaction() wrapper — withTenantDb already wraps the whole
    // request in one transaction; the row lock below still applies within it.
    // FOR UPDATE — without this, two payments landing close together both read the same
    // currentPaid/remaining and the second write silently clobbers the first's
    // amountPaid, even though both Payment vouchers were correctly inserted. Purchase
    // Bills' own /pay route already locks this way; this mirrors it.
    const [expense] = await tdb.select().from(schema.expenses)
      .where(and(eq(schema.expenses.id, id), eq(schema.expenses.companyId, companyId))).for('update');
    if (!expense) throw new Error('Expense not found.');
    if (!branchAccessOk(req, expense.branchId)) { const err: any = new Error('Forbidden: you are not assigned to this branch.'); err.status = 403; throw err; }
    if (expense.status === 'Cancelled') throw new Error('Cancelled expenses cannot be paid.');
    if (expense.reversalOfExpenseId) throw new Error('A reversal document cannot be paid. If the vendor refunds money, record it under Vendor Refunds.');
    const [reversedBy] = await tdb.select({ n: schema.expenses.expenseNumber }).from(schema.expenses)
      .where(and(eq(schema.expenses.companyId, companyId), eq(schema.expenses.reversalOfExpenseId, expense.id), eq(schema.expenses.status, 'Active')));
    if (reversedBy) throw new Error(`This expense has been reversed (${reversedBy.n}) and can no longer be paid.`);
    if (expense.paymentStatus === 'Paid') throw new Error('Expense is already paid.');

    await validateTransactionDate(date, companyId);

    const targetBankId = bankId || expense.bankId;
    // A client-supplied bankId must actually belong to this company — otherwise a
    // malformed/malicious request could post a disbursement against another tenant's
    // bank account.
    if (bankId) {
      const [bank] = await tdb.select({ id: schema.bankAccounts.id }).from(schema.bankAccounts)
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
    await tdb.update(schema.expenses).set({
      amountPaid: String(newPaidAmount),
      paymentStatus: newPaymentStatus,
      paymentDate: new Date(date),
    }).where(eq(schema.expenses.id, id));

    // Payment voucher (only if Actual type; accrual settlement handles its own voucher
    // when actual is posted) — matches dbStore.markExpensePaid exactly.
    if (expense.type === 'Actual') {
      const voucherNumber = await getAndIncrementDocumentNumber(tdb, companyId, 'voucher', date, expense.branchId);
      const [voucher] = await tdb.insert(schema.vouchers).values({
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
        createdAt: nowDate(),
        companyId,
        // Always the expense's own branch, never independently picked.
        branchId: expense.branchId,
      }).returning();
      createdVoucher = voucher;

      // Phase 2 ledger posting (row 6) — only when a real Payment voucher was just
      // created above (Actual type only, matching that same gate exactly).
      await postJournalEntry(tdb, {
        companyId,
        branchId: expense.branchId,
        date,
        referenceType: 'Expense',
        referenceId: id,
        description: `Payment for expense ${expense.expenseNumber} (installment)`,
        createdById: req.user.id,
        lines: [
          { accountKey: 'AP', debit: amountToPost },
          { accountKey: 'BANK', credit: amountToPost, bankId: targetBankId },
        ],
      });
    }
    paidExpenseNumber = expense.expenseNumber;

    recordAuditLog(req, 'RECORD_EXPENSE_PAYMENT', 'expense', id, {
      expenseNumber: paidExpenseNumber,
      voucherNumber: createdVoucher?.voucherNumber,
      amount: createdVoucher?.amount,
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
// A closed month (or a quarter whose VAT return is generated/filed) locks the expenses dated in it: they cannot be cancelled. The correction is a
// new REVERSAL document dated TODAY, in the current open month and quarter: a negative expense that takes the cost and the input VAT back in
// this period and leaves the original untouched. What was still owed to the vendor is reduced; what had already been paid becomes a vendor
// credit receivable (refunded later through POST /api/inventory/vendor-refunds, exactly like a return against a paid bill).
router.post('/:id/reverse', withTenantDb, async (req: any, res) => {
  try {
    const tdb = tenantDb();
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.expense.delete.enabled) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    const { id } = req.params;
    const reason = String(req.body?.reason || '').trim();

    const [orig] = await tdb.select().from(schema.expenses)
      .where(and(eq(schema.expenses.id, id), eq(schema.expenses.companyId, companyId))).for('update');
    if (!orig) return res.status(404).json({ error: 'Expense not found.' });
    if (!branchAccessOk(req, orig.branchId)) return res.status(403).json({ error: 'Forbidden: you are not assigned to this branch.' });
    if (orig.status !== 'Active') return res.status(400).json({ error: 'Only an active expense can be reversed.' });
    if (orig.type !== 'Actual') return res.status(400).json({ error: 'An accrual is removed with its own Delete; only a real expense is reversed.' });
    if (orig.originAccrualId) return res.status(400).json({ error: 'This expense settles an accrual and cannot be reversed on its own.' });
    if (orig.reversalOfExpenseId) return res.status(400).json({ error: 'This is already a reversal document.' });
    const [already] = await tdb.select({ n: schema.expenses.expenseNumber }).from(schema.expenses)
      .where(and(eq(schema.expenses.companyId, companyId), eq(schema.expenses.reversalOfExpenseId, id), eq(schema.expenses.status, 'Active')));
    if (already) return res.status(400).json({ error: `This expense has already been reversed (${already.n}).` });

    // The reversal lands today, so today must be an open month outside any generated/filed VAT quarter.
    const today = nowDate().toISOString().slice(0, 10);
    await validateTransactionDate(today, companyId);
    await assertQuarterNotFrozen(today, companyId);

    const gross = round2(Number(orig.amount));
    const paid = Math.min(gross, round2(Number(orig.amountPaid || 0)));
    const unpaid = round2(gross - paid);
    const [slab] = orig.taxSlabId ? await tdb.select().from(schema.taxSlabs).where(eq(schema.taxSlabs.id, orig.taxSlabId)) : [undefined];
    const { netAmount, taxAmount } = splitExpenseTaxInclusiveAmount(gross, slab ? Number(slab.percentage) : 0);

    const expenseNumber = await getAndIncrementDocumentNumber(tdb, companyId, 'expense', today, orig.branchId);
    const reversalId = generateId();
    // amountPaid carries the part that is NOT payable any more: what had already been paid out becomes a credit owed back by the vendor,
    // what was still unpaid simply stops being owed. (Negative amounts: this document is the mirror image of the original.)
    await tdb.insert(schema.expenses).values({
      id: reversalId, expenseNumber, date: today, vendorId: orig.vendorId, taxSlabId: orig.taxSlabId, bankId: orig.bankId,
      paymentStatus: unpaid > 0.005 ? 'Unpaid' : 'Paid', amountPaid: String(-paid), paymentDate: null,
      description: `Reversal of ${orig.expenseNumber}${reason ? ': ' + reason : ''}`, amount: String(-gross), status: 'Active', type: 'Actual',
      classification: orig.classification, assetType: orig.assetType, expenseType: orig.expenseType,
      billNumber: orig.billNumber, reversalOfExpenseId: id, createdById: req.user.id, createdAt: nowDate(), companyId, branchId: orig.branchId,
    });

    await postJournalEntry(tdb, {
      companyId, branchId: orig.branchId, date: today, referenceType: 'Expense', referenceId: reversalId,
      description: `Reversal ${expenseNumber} of expense ${orig.expenseNumber}`, createdById: req.user.id,
      lines: [
        ...(unpaid > 0 ? [{ accountKey: 'AP', debit: unpaid }] : []),
        ...(paid > 0 ? [{ accountKey: 'VENDOR_CREDIT_RECEIVABLE', debit: paid }] : []),
        { accountKey: orig.classification === 'Asset' ? 'FIXED_ASSETS' : 'DIRECT_OPEX', credit: netAmount },
        ...(taxAmount > 0 ? [{ accountKey: 'VAT_INPUT', credit: taxAmount }] : []),
      ],
    });

    recordAuditLog(req, 'REVERSE_EXPENSE', 'expense', id, { expenseNumber: orig.expenseNumber, reversalNumber: expenseNumber, amount: gross });
    res.json({ success: true, reversalId, reversalNumber: expenseNumber });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/:id/cancel', withTenantDb, async (req: any, res) => {
  try {
    const tdb = tenantDb();
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.expense.delete.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const companyId = req.targetCompanyId;

    // No separate db.transaction() wrapper — withTenantDb already wraps the whole
    // request in one transaction.
    const cancelled = await cancelExpense(tdb, req, id, companyId);

    recordAuditLog(req, 'CANCEL_EXPENSE', 'expense', id, { expenseNumber: cancelled?.expenseNumber });
    res.json({ success: true });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

export default router;
