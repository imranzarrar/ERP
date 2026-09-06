import express from 'express';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, inArray } from 'drizzle-orm';
import { isSuperAdminUser } from '../lib/authz.js';
import { generateId } from '../../src/id.js';

const router = express.Router();

// Company creation itself still goes through the legacy client-driven `handleAddCompany`
// -> /api/migrate path (AdminSettings.tsx) — left untouched. This file only adds the two
// actions that path never needed: marking a self-signup company's registration outcome,
// and permanently purging an abandoned one.

router.patch('/:id/registration-status', async (req: any, res) => {
  try {
    if (!isSuperAdminUser(req.user)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const status = req.body?.status;
    if (!['Trial', 'Registered', 'Cancelled'].includes(status)) {
      return res.status(400).json({ error: "status must be one of 'Trial', 'Registered', 'Cancelled'." });
    }
    const [existing] = await db.select({ id: schema.companies.id }).from(schema.companies).where(eq(schema.companies.id, id));
    if (!existing) {
      return res.status(404).json({ error: 'Company not found.' });
    }
    await db.update(schema.companies).set({ registrationStatus: status }).where(eq(schema.companies.id, id));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Permanently deletes a company and every row belonging to it, across every company-scoped
// table in the schema. The single most destructive operation in this app — deliberately
// gated to super-admins only, and refused unless the company has already been marked
// 'Cancelled' (a separate, earlier, reversible step — see the PATCH route above), so a
// Registered or still-Trial company can never be purged by a slip of the mouse.
//
// No DB-level ON DELETE CASCADE exists on any of these companyId foreign keys (confirmed
// against the schema before writing this) — this is an explicit, ordered, application-level
// deletion inside one transaction, deepest children first, built from the real FK graph
// (not just each table's own companyId — e.g. invoiceItems -> invoices -> quotations, and
// users -> employees -> branches). Getting the order wrong fails loudly (an FK-violation
// error rolls back the whole transaction) rather than partially deleting anything.
router.delete('/:id', async (req: any, res) => {
  try {
    if (!isSuperAdminUser(req.user)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id: companyId } = req.params;
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));
    if (!company) {
      return res.status(404).json({ error: 'Company not found.' });
    }
    if (company.registrationStatus !== 'Cancelled') {
      return res.status(400).json({ error: 'Only a company whose registration is Cancelled can be deleted. Cancel its registration first.' });
    }

    await db.transaction(async (tx) => {
      const byCompany = (table: any) => eq(table.companyId, companyId);

      // Tombstone first — only persists if the whole purge below actually commits.
      await tx.insert(schema.deletedCompanyLog).values({
        id: generateId(),
        companyId,
        companyName: company.name,
        deletedByUserId: req.user.id,
        deletedByUsername: req.user.username,
      });

      // --- Tier 0: break the one real FK cycle (branches <-> warehouses), and detach the
      // global onboarding-request record (not company-scoped, and legitimately survives —
      // it's just left pointing at nothing, same as a request that was Rejected).
      const users_ = db.select({ id: schema.users.id }).from(schema.users).where(byCompany(schema.users));
      const quotations_ = db.select({ id: schema.quotations.id }).from(schema.quotations).where(byCompany(schema.quotations));
      const invoices_ = db.select({ id: schema.invoices.id }).from(schema.invoices).where(byCompany(schema.invoices));
      const expenses_ = db.select({ id: schema.expenses.id }).from(schema.expenses).where(byCompany(schema.expenses));
      const purchaseRequisitions_ = db.select({ id: schema.purchaseRequisitions.id }).from(schema.purchaseRequisitions).where(byCompany(schema.purchaseRequisitions));
      const purchaseOrders_ = db.select({ id: schema.purchaseOrders.id }).from(schema.purchaseOrders).where(byCompany(schema.purchaseOrders));
      const goodsReceiptNotes_ = db.select({ id: schema.goodsReceiptNotes.id }).from(schema.goodsReceiptNotes).where(byCompany(schema.goodsReceiptNotes));
      const purchaseReturns_ = db.select({ id: schema.purchaseReturns.id }).from(schema.purchaseReturns).where(byCompany(schema.purchaseReturns));
      const physicalStockTakes_ = db.select({ id: schema.physicalStockTakes.id }).from(schema.physicalStockTakes).where(byCompany(schema.physicalStockTakes));
      const warehouseDispatches_ = db.select({ id: schema.warehouseDispatches.id }).from(schema.warehouseDispatches).where(byCompany(schema.warehouseDispatches));
      const warehouseReceivings_ = db.select({ id: schema.warehouseReceivings.id }).from(schema.warehouseReceivings).where(byCompany(schema.warehouseReceivings));
      const modifierGroups_ = db.select({ id: schema.modifierGroups.id }).from(schema.modifierGroups).where(byCompany(schema.modifierGroups));
      const productsServices_ = db.select({ id: schema.productsServices.id }).from(schema.productsServices).where(byCompany(schema.productsServices));

      await tx.update(schema.warehouses).set({ branchId: null }).where(byCompany(schema.warehouses));
      await tx.update(schema.branches).set({ defaultWarehouseId: null }).where(byCompany(schema.branches));
      await tx.update(schema.companyOnboardingRequests).set({ createdCompanyId: null }).where(eq(schema.companyOnboardingRequests.createdCompanyId, companyId));
      // Defensive: companyOnboardingRequests.reviewedById -> users.id has no onDelete
      // behavior either. In practice a Trial company being purged has no super-admin users
      // of its own to have reviewed anything, but null it out rather than assume that.
      await tx.update(schema.companyOnboardingRequests).set({ reviewedById: null }).where(inArray(schema.companyOnboardingRequests.reviewedById, users_));

      // --- Tier 1: deepest children — line items, junction tables, and every table that is
      // itself company-scoped but nothing else references.
      await tx.delete(schema.userRoles).where(inArray(schema.userRoles.userId, users_));
      await tx.delete(schema.userBranches).where(inArray(schema.userBranches.userId, users_));
      await tx.delete(schema.passwordResetTokens).where(inArray(schema.passwordResetTokens.userId, users_));
      await tx.delete(schema.quotationItems).where(inArray(schema.quotationItems.quotationId, quotations_));
      await tx.delete(schema.invoiceItems).where(inArray(schema.invoiceItems.invoiceId, invoices_));
      await tx.delete(schema.expenseItems).where(inArray(schema.expenseItems.expenseId, expenses_));
      await tx.delete(schema.purchaseRequisitionItems).where(inArray(schema.purchaseRequisitionItems.requisitionId, purchaseRequisitions_));
      await tx.delete(schema.purchaseOrderItems).where(inArray(schema.purchaseOrderItems.purchaseOrderId, purchaseOrders_));
      await tx.delete(schema.goodsReceiptNoteItems).where(inArray(schema.goodsReceiptNoteItems.grnId, goodsReceiptNotes_));
      await tx.delete(schema.purchaseReturnItems).where(inArray(schema.purchaseReturnItems.returnId, purchaseReturns_));
      await tx.delete(schema.physicalStockTakeItems).where(inArray(schema.physicalStockTakeItems.stockTakeId, physicalStockTakes_));
      // warehouseReceivingItems also holds a FK to warehouseDispatchItems.id (dispatchItemId)
      // — must be deleted before warehouseDispatchItems, not just before warehouseReceivings.
      await tx.delete(schema.warehouseReceivingItems).where(inArray(schema.warehouseReceivingItems.receivingId, warehouseReceivings_));
      await tx.delete(schema.warehouseDispatchItems).where(inArray(schema.warehouseDispatchItems.dispatchId, warehouseDispatches_));
      await tx.delete(schema.modifierChoices).where(inArray(schema.modifierChoices.modifierGroupId, modifierGroups_));
      await tx.delete(schema.productModifierGroups).where(inArray(schema.productModifierGroups.productId, productsServices_));

      await tx.delete(schema.auditLogs).where(byCompany(schema.auditLogs));
      await tx.delete(schema.productUnitConversions).where(byCompany(schema.productUnitConversions));
      await tx.delete(schema.productWarehouses).where(byCompany(schema.productWarehouses));
      await tx.delete(schema.inventoryStocks).where(byCompany(schema.inventoryStocks));
      await tx.delete(schema.stockLedgerTransactions).where(byCompany(schema.stockLedgerTransactions));
      await tx.delete(schema.recurringPostings).where(byCompany(schema.recurringPostings));
      await tx.delete(schema.vouchers).where(byCompany(schema.vouchers));
      await tx.delete(schema.taxReturns).where(byCompany(schema.taxReturns));
      await tx.delete(schema.glGroupMappings).where(byCompany(schema.glGroupMappings));
      await tx.delete(schema.investors).where(byCompany(schema.investors));
      await tx.delete(schema.fiscalMonths).where(byCompany(schema.fiscalMonths));
      await tx.delete(schema.documentCounters).where(byCompany(schema.documentCounters));
      await tx.delete(schema.zatcaChainState).where(byCompany(schema.zatcaChainState));
      await tx.delete(schema.zatcaEnvironmentConfigs).where(byCompany(schema.zatcaEnvironmentConfigs));
      await tx.delete(schema.documentTemplates).where(byCompany(schema.documentTemplates));
      await tx.delete(schema.posHeldInvoices).where(byCompany(schema.posHeldInvoices));
      await tx.delete(schema.purchaseBills).where(byCompany(schema.purchaseBills));

      // --- Tier 2: documents whose own items/children are now gone.
      await tx.delete(schema.productsServices).where(byCompany(schema.productsServices));
      await tx.delete(schema.modifierGroups).where(byCompany(schema.modifierGroups));
      await tx.delete(schema.purchaseReturns).where(byCompany(schema.purchaseReturns));
      await tx.delete(schema.invoices).where(byCompany(schema.invoices));
      await tx.delete(schema.physicalStockTakes).where(byCompany(schema.physicalStockTakes));
      await tx.delete(schema.expenses).where(byCompany(schema.expenses));
      await tx.delete(schema.warehouseReceivings).where(byCompany(schema.warehouseReceivings));
      await tx.delete(schema.goodsReceiptNotes).where(byCompany(schema.goodsReceiptNotes)); // after purchaseReturns + its own items

      // --- Tier 3: parents of tier-2 documents. warehouseDispatches (fromWarehouseId/
      // toWarehouseId -> warehouses.id) must come before warehouses, in the same tier.
      await tx.delete(schema.productCategories).where(byCompany(schema.productCategories)); // after productsServices
      await tx.delete(schema.purchaseOrders).where(byCompany(schema.purchaseOrders)); // after its items + goodsReceiptNotes
      await tx.delete(schema.quotations).where(byCompany(schema.quotations)); // after invoices (originQuotationId)
      await tx.delete(schema.posShifts).where(byCompany(schema.posShifts)); // after invoices/expenses/vouchers/posHeldInvoices
      await tx.delete(schema.recurringExpenseTemplates).where(byCompany(schema.recurringExpenseTemplates)); // after recurringPostings
      await tx.delete(schema.warehouseDispatches).where(byCompany(schema.warehouseDispatches)); // after its items + warehouseReceivings
      await tx.delete(schema.warehouses).where(byCompany(schema.warehouses)); // after productsServices + every doc referencing warehouseId, incl. warehouseDispatches above

      // --- Tier 4.
      await tx.delete(schema.purchaseRequisitions).where(byCompany(schema.purchaseRequisitions)); // after its items + purchaseOrders

      // --- Tier 5: master data + users, now that every document referencing them is gone.
      await tx.delete(schema.unitsOfMeasure).where(byCompany(schema.unitsOfMeasure));
      await tx.delete(schema.customers).where(byCompany(schema.customers));
      await tx.delete(schema.vendors).where(byCompany(schema.vendors));
      await tx.delete(schema.bankAccounts).where(byCompany(schema.bankAccounts));
      await tx.delete(schema.taxSlabs).where(byCompany(schema.taxSlabs));
      await tx.delete(schema.roles).where(byCompany(schema.roles)); // after userRoles
      await tx.delete(schema.users).where(byCompany(schema.users)); // after userRoles/userBranches/passwordResetTokens + every createdById/reviewedById reference

      // --- Tier 6-7: employees hold a FK to users (users.employeeId -> employees.id means
      // USERS must go first, which just happened), then jobTitles/branches (employees holds
      // FKs to both).
      await tx.delete(schema.employees).where(byCompany(schema.employees));
      await tx.delete(schema.jobTitles).where(byCompany(schema.jobTitles));
      await tx.delete(schema.branches).where(byCompany(schema.branches));

      // --- The company row itself, last.
      await tx.delete(schema.companies).where(eq(schema.companies.id, companyId));
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
