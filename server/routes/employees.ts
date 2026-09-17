import express from 'express';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { normalizePermissions } from '../../src/types.js';
import { assertOwnsRow } from '../lib/authz.js';
import { generateId } from '../../src/id.js';
import { getAndIncrementEmployeeNumber } from '../lib/employeeNumbering.js';
import { withTenantDb, tenantDb } from '../lib/tenantDb.js';

const router = express.Router();

// --- Employees (HR) — see employees's schema comment for the full model: a real roster
// independent of `users` (ERP login accounts), so a future Timekeeping module can key
// clock-in/out records on employeeId without caring whether that employee ever logs in. ---
router.get('/employees', withTenantDb, async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.employees.read.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const companyId = req.targetCompanyId;
    const rows = await tenantDb().select().from(schema.employees).where(eq(schema.employees.companyId, companyId));
    // Deliberately NOT branchAccessOk's usual null-means-unrestricted-only rule: a
    // Head-Office employee (branchId null) must stay visible to every branch — that's the
    // whole point of the Head-Office pattern (see employees.branchId's schema comment and
    // InvoiceModule.tsx's eligibleSalesAssociates, which already relies on this). What was
    // actually missing was scoping OTHER branches' staff away from a restricted viewer —
    // PII (email/phone, hire/termination dates) a Branch Manager confined to their own
    // location shouldn't see for a different branch's roster.
    const filtered = Array.isArray(req.allowedBranchIds)
      ? rows.filter((e: any) => e.branchId === null || e.branchId === undefined || req.allowedBranchIds.includes(e.branchId))
      : rows;
    res.json(filtered);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/employees', withTenantDb, async (req: any, res) => {
  try {
    const tdb = tenantDb();
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    const data = { ...req.body };

    // Deliberately the superuser `db` — same hijack-detection reasoning as POST
    // /customers in masterEntities.ts.
    let existing: typeof schema.employees.$inferSelect | undefined;
    if (data.id) {
      [existing] = await db.select().from(schema.employees).where(eq(schema.employees.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this employee belongs to another company' });
      }
    }
    if (existing) {
      if (!permissions.employees.update.enabled) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      if (existing.isActive === false) {
        return res.status(400).json({ error: 'Cannot edit a deactivated employee. Reactivate them first.' });
      }
    } else if (!permissions.employees.create.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (!data.name || !String(data.name).trim()) {
      return res.status(400).json({ error: 'Employee name is required.' });
    }
    if (!data.jobTitleId) {
      return res.status(400).json({ error: 'A job title is required.' });
    }

    const companyId = req.targetCompanyId;
    const [jobTitle] = await tdb.select().from(schema.jobTitles)
      .where(and(eq(schema.jobTitles.id, data.jobTitleId), eq(schema.jobTitles.companyId, companyId)));
    if (!jobTitle) {
      return res.status(404).json({ error: 'Job title not found for this company.' });
    }
    if (jobTitle.isActive === false) {
      return res.status(400).json({ error: `Job title "${jobTitle.title}" is deactivated and cannot be assigned to a new employee.` });
    }

    // Nullable = Head Office / company-wide (the onboarding default) — only validated
    // (must belong to this company) when actually set, never required.
    if (data.branchId) {
      const [branch] = await tdb.select({ id: schema.branches.id }).from(schema.branches)
        .where(and(eq(schema.branches.id, data.branchId), eq(schema.branches.companyId, companyId)));
      if (!branch) {
        return res.status(404).json({ error: 'Branch not found for this company.' });
      }
    }

    data.companyId = companyId;
    data.name = String(data.name).trim();

    if (existing) {
      // Editing never touches employeeNumber/employeeId — immutable after creation,
      // same "assigned once, never re-derived" contract as an invoice number.
      const editable = { name: data.name, jobTitleId: data.jobTitleId, branchId: data.branchId || null, email: data.email || null, phone: data.phone || null, hireDate: data.hireDate || null };
      await tdb.update(schema.employees).set(editable).where(eq(schema.employees.id, existing.id));
      return res.json({ success: true, id: existing.id });
    }

    // No separate db.transaction() wrapper — withTenantDb already wraps the whole
    // request in one transaction. Minting the number and inserting the row still happen
    // sequentially within it — the atomic counter reservation (reserveNextCounterValue)
    // is only race-safe for the lifetime of an enclosing transaction, same requirement
    // document numbering has.
    const newId = generateId();
    const employeeNumber = await getAndIncrementEmployeeNumber(tdb, companyId);
    const [created] = await tdb.insert(schema.employees).values({
      id: newId,
      companyId,
      employeeNumber,
      name: data.name,
      jobTitleId: data.jobTitleId,
      branchId: data.branchId || null,
      email: data.email || null,
      phone: data.phone || null,
      hireDate: data.hireDate || null,
      isActive: true,
      createdAt: new Date(),
    }).returning();
    res.json({ success: true, id: created.id, employeeNumber: created.employeeNumber });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/employees/:id/toggle-active', withTenantDb, async (req: any, res) => {
  try {
    const tdb = tenantDb();
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.employees.delete.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const [existing] = await tdb.select().from(schema.employees)
      .where(and(eq(schema.employees.id, id), eq(schema.employees.companyId, req.targetCompanyId)));
    if (!existing) {
      return res.status(404).json({ error: 'Employee not found.' });
    }
    const nextActive = existing.isActive === false;
    // Deactivating an employee does NOT cascade-deactivate a linked User login, and
    // vice versa — two independent admin actions, a deliberate boundary, not a gap.
    await tdb.update(schema.employees).set({
      isActive: nextActive,
      terminationDate: nextActive ? null : new Date().toISOString().slice(0, 10),
    }).where(eq(schema.employees.id, id));
    res.json({ success: true, isActive: nextActive });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
