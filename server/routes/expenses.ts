import express from 'express';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { getAndIncrementCounter, validateTransactionDate, syncVoucherForExpense, round2, computePaymentStatus } from '../lib/businessLogic.js';
import { normalizePermissions } from '../../src/types.js';
import { parseLimitOffset } from '../lib/pagination.js';
import { generateId } from '../../src/id.js';
import { assertOwnsRow } from '../lib/authz.js';

const router = express.Router();

router.get('/', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.expense.view.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const companyId = req.targetCompanyId;
    const { limit, offset } = parseLimitOffset(req);
    const expenses = await db.select().from(schema.expenses).where(eq(schema.expenses.companyId, companyId))
      .orderBy(desc(schema.expenses.createdAt)).limit(limit).offset(offset);
    res.json(expenses);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.expense.create.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const data = { ...req.body };

    if (data.id) {
      const [existing] = await db.select().from(schema.expenses).where(eq(schema.expenses.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this expense belongs to another company' });
      }
    }

    data.companyId = req.targetCompanyId;
    // paymentStatus is a derived fact of amountPaid vs. amount, not a client-asserted
    // string — recomputing it here closes the door on an arbitrary/typo'd status value.
    const totalAmount = round2(Number(data.amount || 0));
    const paidAmount = round2(Number(data.amountPaid || 0));
    data.amount = String(totalAmount);
    data.amountPaid = String(paidAmount);
    data.paymentStatus = computePaymentStatus(paidAmount, totalAmount);

    await db.transaction(async (tx) => {
      await validateTransactionDate(data.date, data.companyId);
      const expenseId = data.id || generateId();
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

export default router;
