import express from 'express';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and, isNull } from 'drizzle-orm';
import { normalizePermissions } from '../../src/types.js';
import { isSuperAdminUser, assertOwnsRow, branchAccessOk } from '../lib/authz.js';
import { generateId } from '../../src/id.js';

const router = express.Router();

// --- Branches (physical locations) ---
router.get('/branches', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.branches.read.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const companyId = req.targetCompanyId;
    const branchesList = await db.select().from(schema.branches).where(eq(schema.branches.companyId, companyId));
    res.json(branchesList);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Upsert route. Creation is deliberately gated to super-admin only, not a permission
// leaf at all — mirrors POST /api/companies (masterEntities.ts:247) exactly. A company
// admin (or anyone with branches.update) can still edit an existing branch's details.
router.post('/branches', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    const data = { ...req.body };

    let existing: typeof schema.branches.$inferSelect | undefined;
    if (data.id) {
      [existing] = await db.select().from(schema.branches).where(eq(schema.branches.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this branch belongs to another company' });
      }
      // A branch-restricted user (e.g. a branch manager holding branches.update for their
      // own location's details) must not be able to edit a DIFFERENT branch just by
      // supplying its id — a branch's own id is the thing being checked here, same as
      // every other row's branchId elsewhere.
      if (existing && !branchAccessOk(req, existing.id)) {
        return res.status(403).json({ error: 'Forbidden: you are not assigned to this branch.' });
      }
    } else {
      if (!isSuperAdminUser(req.user)) {
        return res.status(403).json({ error: 'Forbidden: only a super-admin can create a new branch.' });
      }
      data.id = generateId();
    }
    if (existing) {
      if (!permissions.branches.update.enabled) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      if (existing.isActive === false) {
        return res.status(400).json({ error: 'Cannot edit a deactivated branch. Reactivate it first.' });
      }
    }

    data.companyId = req.targetCompanyId;

    // Validate the branch's own default sales warehouse (nullable — clearing it back to
    // "no default" is always allowed). Must be a real, active, 'sales'-type warehouse
    // belonging to this same company — see warehouses.type's comment for why 'backend'
    // is rejected here.
    if (data.defaultWarehouseId) {
      const [warehouse] = await db.select().from(schema.warehouses)
        .where(and(eq(schema.warehouses.id, data.defaultWarehouseId), eq(schema.warehouses.companyId, data.companyId)));
      if (!warehouse) {
        return res.status(404).json({ error: 'Selected default warehouse not found for this company.' });
      }
      if (warehouse.isActive === false) {
        return res.status(400).json({ error: `Warehouse "${warehouse.name}" is deactivated and cannot be set as a branch default.` });
      }
      if (warehouse.type !== 'sales') {
        return res.status(400).json({ error: `Warehouse "${warehouse.name}" is a backend warehouse and cannot be set as a branch's sales default.` });
      }
    }

    // Setting this branch as default atomically un-defaults any other — same pattern as
    // taxSlabs.isDefault (server/routes/masterEntities.ts's tax-slabs route) — a partial
    // unique index alone would otherwise just throw a constraint violation on the second
    // "set default" click instead of transparently swapping which branch holds it.
    if (data.isDefault === true) {
      await db.transaction(async (tx) => {
        await tx.update(schema.branches).set({ isDefault: false })
          .where(and(eq(schema.branches.companyId, req.targetCompanyId), eq(schema.branches.isDefault, true)));
        await tx.insert(schema.branches).values(data).onConflictDoUpdate({
          target: schema.branches.id,
          set: data
        });
      });
    } else {
      await db.insert(schema.branches).values(data).onConflictDoUpdate({
        target: schema.branches.id,
        set: data
      });
    }
    res.json({ success: true, id: data.id });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/branches/:id/toggle-active', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.branches.delete.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const [existing] = await db.select().from(schema.branches)
      .where(and(eq(schema.branches.id, id), eq(schema.branches.companyId, req.targetCompanyId)));
    if (!existing) {
      return res.status(404).json({ error: 'Branch not found.' });
    }
    if (!branchAccessOk(req, existing.id)) {
      return res.status(403).json({ error: 'Forbidden: you are not assigned to this branch.' });
    }
    const nextActive = existing.isActive === false;
    // A branch can't be un-defaulted by deactivation alone (the toggle only flips
    // isActive) — deliberately left as-is; an admin choosing to deactivate their default
    // branch is a real decision, not something to silently second-guess here.
    await db.update(schema.branches).set({ isActive: nextActive }).where(eq(schema.branches.id, id));
    res.json({ success: true, isActive: nextActive });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// One-time (per company) cleanup action for adopting branches after documents already
// exist: every business table with a nullable branchId (quotations.branchId's comment
// explains why it's nullable — pre-multi-branch rows stay NULL forever unless explicitly
// backfilled) gets any NULL row for this company attributed to one chosen branch.
// Warehouses are included deliberately, per explicit product decision — GRN/Purchase
// Returns/Physical Stock Takes/inventoryStocks/stockLedgerTransactions have no branchId
// column of their own and derive it via warehouseId (see warehouses.branchId's comment),
// so backfilling warehouses is what actually closes the gap for that whole derived chain.
// Idempotent by construction (`isNull(branchId)` — a second run touches nothing) and
// scoped to `req.targetCompanyId` throughout, so it can never affect another tenant.
// Gated on branches.update (the same leaf that governs editing a branch's own fields) —
// this action doesn't create/deactivate a branch, it reassigns documents to one that
// already exists, which is an edit-adjacent authority, not a separate leaf worth adding.
router.post('/branches/backfill-unassigned', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.branches.update.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    // This reassigns EVERY unassigned document company-wide onto one branch — a
    // company-wide bulk action, not an edit scoped to the caller's own branch(es). A
    // branch-restricted holder of the ordinary branches.update leaf must not be able to
    // annex every other branch's unassigned history onto their own; only someone with no
    // branch ceiling (admin/super-admin/viewAllBranches — req.allowedBranchIds === null)
    // may run this.
    if (req.allowedBranchIds !== null) {
      return res.status(403).json({ error: 'Forbidden: this action affects unassigned documents company-wide and requires unrestricted branch access.' });
    }
    const companyId = req.targetCompanyId;
    const branchId = req.body?.branchId;
    if (!branchId) {
      return res.status(400).json({ error: 'branchId is required.' });
    }
    const [targetBranch] = await db.select().from(schema.branches)
      .where(and(eq(schema.branches.id, branchId), eq(schema.branches.companyId, companyId)));
    if (!targetBranch) {
      return res.status(404).json({ error: 'Branch not found for this company.' });
    }
    if (targetBranch.isActive === false) {
      return res.status(400).json({ error: 'Cannot backfill onto a deactivated branch.' });
    }

    const counts = await db.transaction(async (tx) => {
      const tables = [
        { key: 'quotations', table: schema.quotations },
        { key: 'invoices', table: schema.invoices },
        { key: 'expenses', table: schema.expenses },
        { key: 'vouchers', table: schema.vouchers },
        { key: 'purchaseRequisitions', table: schema.purchaseRequisitions },
        { key: 'purchaseOrders', table: schema.purchaseOrders },
        { key: 'purchaseBills', table: schema.purchaseBills },
        { key: 'warehouses', table: schema.warehouses },
      ] as const;

      const result: Record<string, number> = {};
      for (const { key, table } of tables) {
        const updated = await tx.update(table).set({ branchId })
          .where(and(eq((table as any).companyId, companyId), isNull((table as any).branchId)))
          .returning({ id: (table as any).id });
        result[key] = updated.length;
      }
      return result;
    });

    res.json({ success: true, branchId, counts });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
