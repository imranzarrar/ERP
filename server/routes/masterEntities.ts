import express from 'express';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and, ne, sql, or, isNull } from 'drizzle-orm';
import { normalizePermissions } from '../../src/types.js';
import { isSuperAdminUser, isAdminUser, hasPermission, assertOwnsRow } from '../lib/authz.js';
import { generateId } from '../../src/id.js';
import { validateBuyerFields } from '../lib/zatca/validators.js';
import { isValidZatcaUnitCode } from '../../src/zatcaUnitCodes.js';

const router = express.Router();

// --- Customers ---
router.get('/customers', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.customers.read.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const companyId = req.targetCompanyId;
    const customers = await db.select().from(schema.customers).where(eq(schema.customers.companyId, companyId));
    res.json(customers);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/customers', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    const data = { ...req.body };

    // Upsert route: an `id` naming an existing row is an edit, gated by customers.update
    // (not customers.create) - the two are separately grantable now. A deactivated
    // customer is terminal for edits regardless of permission.
    let existing: typeof schema.customers.$inferSelect | undefined;
    if (data.id) {
      [existing] = await db.select().from(schema.customers).where(eq(schema.customers.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this customer belongs to another company' });
      }
    }
    if (existing) {
      if (!permissions.customers.update.enabled) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      if (existing.isActive === false) {
        return res.status(400).json({ error: 'Cannot edit a deactivated customer. Reactivate it first.' });
      }
    } else if (!permissions.customers.create.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    data.companyId = req.targetCompanyId;

    // Authoritative check — the client mirrors this, but a customer/vendor record
    // reachable via ZATCA invoicing must never be saved with fields that would
    // guarantee a real ZATCA rejection later (B2B needs full identity; B2C needs a name).
    const fieldErrors = validateBuyerFields(data.buyerType, data);
    if (fieldErrors.length > 0) {
      return res.status(400).json({ error: fieldErrors.map(e => e.message).join(' '), fieldErrors });
    }

    await db.insert(schema.customers).values(data).onConflictDoUpdate({
      target: schema.customers.id,
      set: data
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Delete (D) for master data is an Active/Inactive toggle, never a row deletion — a
// customer with existing quotations/invoices/POS history stays fully intact and
// referenceable, just hidden from pickers for new documents. Replaces the old hard
// DELETE route (which had to guard against exactly those references); toggling needs no
// such guard since nothing is actually removed.
router.patch('/customers/:id/toggle-active', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.customers.delete.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const [existing] = await db.select().from(schema.customers)
      .where(and(eq(schema.customers.id, id), eq(schema.customers.companyId, req.targetCompanyId)));
    if (!existing) {
      return res.status(404).json({ error: 'Customer not found.' });
    }
    const nextActive = existing.isActive === false;
    await db.update(schema.customers).set({ isActive: nextActive }).where(eq(schema.customers.id, id));
    res.json({ success: true, isActive: nextActive });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Vendors ---
router.get('/vendors', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.vendors.read.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const companyId = req.targetCompanyId;
    const vendors = await db.select().from(schema.vendors).where(eq(schema.vendors.companyId, companyId));
    res.json(vendors);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/vendors', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    const data = { ...req.body };

    let existing: typeof schema.vendors.$inferSelect | undefined;
    if (data.id) {
      [existing] = await db.select().from(schema.vendors).where(eq(schema.vendors.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this vendor belongs to another company' });
      }
    }
    if (existing) {
      if (!permissions.vendors.update.enabled) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      if (existing.isActive === false) {
        return res.status(400).json({ error: 'Cannot edit a deactivated vendor. Reactivate it first.' });
      }
    } else if (!permissions.vendors.create.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    data.companyId = req.targetCompanyId;

    const fieldErrors = validateBuyerFields(data.buyerType, data);
    if (fieldErrors.length > 0) {
      return res.status(400).json({ error: fieldErrors.map(e => e.message).join(' '), fieldErrors });
    }

    await db.insert(schema.vendors).values(data).onConflictDoUpdate({
      target: schema.vendors.id,
      set: data
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/vendors/:id/toggle-active', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.vendors.delete.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const [existing] = await db.select().from(schema.vendors)
      .where(and(eq(schema.vendors.id, id), eq(schema.vendors.companyId, req.targetCompanyId)));
    if (!existing) {
      return res.status(404).json({ error: 'Vendor not found.' });
    }
    const nextActive = existing.isActive === false;
    await db.update(schema.vendors).set({ isActive: nextActive }).where(eq(schema.vendors.id, id));
    res.json({ success: true, isActive: nextActive });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Products ---
router.get('/products', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.products.read.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const companyId = req.targetCompanyId;
    const products = await db.select().from(schema.productsServices).where(eq(schema.productsServices.companyId, companyId));
    res.json(products);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/products', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    const data = { ...req.body };

    let existing: typeof schema.productsServices.$inferSelect | undefined;
    if (data.id) {
      [existing] = await db.select().from(schema.productsServices).where(eq(schema.productsServices.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this product belongs to another company' });
      }
    }
    if (existing) {
      if (!permissions.products.update.enabled) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      if (existing.isActive === false) {
        return res.status(400).json({ error: 'Cannot edit a deactivated product. Reactivate it first.' });
      }
    } else if (!permissions.products.create.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    data.companyId = req.targetCompanyId;
    await db.insert(schema.productsServices).values(data).onConflictDoUpdate({
      target: schema.productsServices.id,
      set: data
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/products/:id/toggle-active', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.products.delete.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const [existing] = await db.select().from(schema.productsServices)
      .where(and(eq(schema.productsServices.id, id), eq(schema.productsServices.companyId, req.targetCompanyId)));
    if (!existing) {
      return res.status(404).json({ error: 'Product not found.' });
    }
    const nextActive = existing.isActive === false;
    await db.update(schema.productsServices).set({ isActive: nextActive }).where(eq(schema.productsServices.id, id));
    res.json({ success: true, isActive: nextActive });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Companies ---
// Creating/overwriting a company row is a platform-owner action, not a delegable
// business permission — true super-admin only (previously any company `admin` could
// pass an arbitrary company id here and overwrite another tenant's row entirely).
router.post('/companies', async (req: any, res) => {
  try {
    if (!isSuperAdminUser(req.user)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const data = req.body;
    await db.insert(schema.companies).values(data).onConflictDoUpdate({
      target: schema.companies.id,
      set: data
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Theme is a lightweight per-company display preference, not the sensitive full-company
// upsert above — any authenticated member of the company may change it (matching the
// existing UI, which shows the theme switcher to every user, not just admins), scoped to
// their own targetCompanyId. Deliberately a single-column update, not routed through the
// full-blob /api/migrate sync every other write in this app used to go through.
router.patch('/companies/:id/theme', async (req: any, res) => {
  try {
    const { id } = req.params;
    const { themeId } = req.body;
    if (!isSuperAdminUser(req.user) && id !== req.targetCompanyId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (typeof themeId !== 'string' || !themeId) {
      return res.status(400).json({ error: 'themeId is required' });
    }
    await db.update(schema.companies).set({ themeId }).where(eq(schema.companies.id, id));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Narrow, allowlisted update for the handful of company-level settings a company
// admin — or, now, a non-admin-tier actor delegated `companyProfile.update` — is allowed
// to change from AdminSettings: the company profile form, the Inventory module toggle,
// and the POS config toggle. Deliberately NOT the same route as POST /companies above —
// that one is a full-row super-admin-only upsert meant for company creation.
// Counters/posSettings(*)/zatcaEnvironment are intentionally excluded — they're owned by
// other flows. (*posSettings itself IS handled here; zatcaEnvironment config lives under
// server/routes/zatca.ts.)
router.patch('/companies/:id/settings', async (req: any, res) => {
  try {
    const { id } = req.params;
    const isFullAdminTier = isAdminUser(req.user);
    const hasDelegatedPermission = hasPermission(req.user, 'companyProfile.update');
    if (!isFullAdminTier && !hasDelegatedPermission) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!isSuperAdminUser(req.user) && id !== req.targetCompanyId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const body = req.body || {};
    const update: Record<string, any> = {};
    // Company Setup form (handleCompanySave)
    if (body.name !== undefined) update.name = body.name;
    if (body.address !== undefined) update.address = body.address;
    if (body.phone !== undefined) update.phone = body.phone;
    if (body.email !== undefined) update.email = body.email;
    if (body.logoUrl !== undefined) update.logoUrl = body.logoUrl;
    if (body.customHeader !== undefined) update.customHeader = body.customHeader;
    if (body.customFooter !== undefined) update.customFooter = body.customFooter;
    if (body.vatNumber !== undefined) update.vatNumber = body.vatNumber;
    if (body.crNumber !== undefined) update.crNumber = body.crNumber;
    if (body.themeId !== undefined) update.themeId = body.themeId;
    if (body.currency !== undefined) update.currency = body.currency;
    if (body.portalTitle !== undefined) update.portalTitle = body.portalTitle;
    if (body.portalSubtitle !== undefined) update.portalSubtitle = body.portalSubtitle;
    // Inventory module toggle (handleToggleCompanyInventory)
    if (body.isInventoryModuleEnabled !== undefined) update.isInventoryModuleEnabled = !!body.isInventoryModuleEnabled;
    if (body.inventorySettings !== undefined) update.inventorySettings = body.inventorySettings;
    // POS Configuration tab (handlePosSettingsChange)
    if (body.posSettings !== undefined) update.posSettings = body.posSettings;
    // ZATCA master switch (handleToggleZatcaEnabled) — deliberately NOT covered by
    // companyProfile.update. ZATCA has real legal/compliance exposure regardless of who's
    // asking (see CLAUDE.md's ZATCA section and the permission-crud-model skill's
    // "Keep admin-tier-only" guidance) — a delegated profile-editor must never be able to
    // flip this via the same endpoint, so it stays gated on real admin tier specifically,
    // mirroring the role-forcing guardrail already used in users.create/update.
    if (body.zatcaEnabled !== undefined) {
      if (!isFullAdminTier) {
        return res.status(403).json({ error: 'Forbidden: enabling/disabling ZATCA requires a company admin or super-admin, not just Company Profile access.' });
      }
      update.zatcaEnabled = !!body.zatcaEnabled;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }
    if (update.name !== undefined && !String(update.name).trim()) {
      return res.status(400).json({ error: 'Company name is required.' });
    }

    await db.update(schema.companies).set(update).where(eq(schema.companies.id, id));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Banks ---
router.get('/banks', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'banks.read')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const banks = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, req.targetCompanyId));
    res.json(banks);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/banks', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'banks.create')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const data = { ...req.body };

    if (data.id) {
      const [existing] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this bank account belongs to another company' });
      }
    }

    data.companyId = req.targetCompanyId;

    // At most one default bank per company (unique_default_bank partial index) — clear
    // any existing default for this company first, atomically with the insert, same
    // pattern as tax-slabs below. This route was previously unreachable from the UI (the
    // create-bank form went through the generic /api/migrate blob sync instead, which
    // could send the whole, already-corrected banks array in one payload); now that it's
    // wired up as a real single-row insert, it needs to enforce the invariant itself.
    if (data.isDefault === true) {
      await db.transaction(async (tx) => {
        await tx.update(schema.bankAccounts)
          .set({ isDefault: false })
          .where(eq(schema.bankAccounts.companyId, req.targetCompanyId));
        await tx.insert(schema.bankAccounts).values(data).onConflictDoUpdate({
          target: schema.bankAccounts.id,
          set: data
        });
      });
    } else {
      await db.insert(schema.bankAccounts).values(data).onConflictDoUpdate({
        target: schema.bankAccounts.id,
        set: data
      });
    }
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Edit branch of AdminSettings' bank form (as opposed to the create branch above, which
// goes through POST /banks). Only the fields the edit form actually exposes.
router.patch('/banks/:id', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'banks.update')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const [existing] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, id));
    if (!existing) return res.status(404).json({ error: 'Bank not found.' });
    if (!assertOwnsRow(existing, req)) {
      return res.status(403).json({ error: 'Forbidden: this bank account belongs to another company' });
    }

    const { bankName, accountTitle, accountNumber, openingBalance, isDefault } = req.body;
    const update: Record<string, any> = {};
    if (bankName !== undefined) update.bankName = bankName;
    if (accountTitle !== undefined) update.accountTitle = accountTitle;
    if (accountNumber !== undefined) update.accountNumber = accountNumber;
    if (openingBalance !== undefined) update.openingBalance = String(openingBalance);
    if (isDefault !== undefined) update.isDefault = !!isDefault;

    if (update.isDefault === true) {
      // Same "at most one default per company" invariant as tax slabs below — clear
      // every other default for this company atomically with the update itself.
      await db.transaction(async (tx) => {
        await tx.update(schema.bankAccounts)
          .set({ isDefault: false })
          .where(and(eq(schema.bankAccounts.companyId, existing.companyId), ne(schema.bankAccounts.id, id)));
        await tx.update(schema.bankAccounts).set(update).where(eq(schema.bankAccounts.id, id));
      });
    } else {
      await db.update(schema.bankAccounts).set(update).where(eq(schema.bankAccounts.id, id));
    }
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// handleSetDefaultBank — flips which single bank is default for the company, clearing
// any other default first (unique_default_bank allows only one at a time).
router.patch('/banks/:id/set-default', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'banks.update')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const [existing] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, id));
    if (!existing) return res.status(404).json({ error: 'Bank not found.' });
    if (!assertOwnsRow(existing, req)) {
      return res.status(403).json({ error: 'Forbidden: this bank account belongs to another company' });
    }

    await db.transaction(async (tx) => {
      await tx.update(schema.bankAccounts)
        .set({ isDefault: false })
        .where(and(eq(schema.bankAccounts.companyId, existing.companyId), ne(schema.bankAccounts.id, id)));
      await tx.update(schema.bankAccounts).set({ isDefault: true }).where(eq(schema.bankAccounts.id, id));
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// handleToggleBankActive — mirrors the client-side guard: the current default bank
// can't be deactivated (must set another default first), enforced here too since the
// client check alone is bypassable by any direct API call.
router.patch('/banks/:id/toggle-active', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'banks.delete')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const [existing] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, id));
    if (!existing) return res.status(404).json({ error: 'Bank not found.' });
    if (!assertOwnsRow(existing, req)) {
      return res.status(403).json({ error: 'Forbidden: this bank account belongs to another company' });
    }
    if (existing.isDefault && existing.isActive) {
      return res.status(400).json({ error: 'Cannot deactivate the Default Bank. Set another bank as default first.' });
    }

    await db.update(schema.bankAccounts).set({ isActive: !existing.isActive }).where(eq(schema.bankAccounts.id, id));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Tax Slabs ---
// Legacy rows with companyId = NULL are shared defaults visible to every company;
// new tax slabs created going forward are scoped to the creating company.
router.get('/tax-slabs', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'taxSlabs.read')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const slabs = await db.select().from(schema.taxSlabs).where(or(eq(schema.taxSlabs.companyId, req.targetCompanyId), isNull(schema.taxSlabs.companyId)));
    res.json(slabs);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/tax-slabs', async (req: any, res) => {
  try {
    const data = { ...req.body };

    // Upsert route: branch create-vs-update by whether the row exists, same pattern as
    // customers/vendors/products/etc. (see permission-crud-model skill) - this used to be
    // a single hasPermission('taxSlabs.update') check covering both, which made
    // taxSlabs.create a dead no-op leaf in the Roles editor (checking it granted nothing,
    // since this route never looked at it).
    let existing: typeof schema.taxSlabs.$inferSelect | undefined;
    if (data.id) {
      [existing] = await db.select().from(schema.taxSlabs).where(eq(schema.taxSlabs.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this tax slab belongs to another company' });
      }
    }
    if (existing) {
      if (!hasPermission(req.user, 'taxSlabs.update')) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    } else if (!hasPermission(req.user, 'taxSlabs.create')) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    data.companyId = req.targetCompanyId;

    // At most one default tax slab per company (enforced by a partial unique index —
    // see schema.ts) — clear any existing default for this company first so setting a
    // new one doesn't hit a raw constraint-violation error. Scoped inside a
    // transaction with the upsert so the two writes are atomic (never a window where
    // two rows are momentarily both true, or where an old default silently disappears
    // if the new insert then fails).
    if (data.isDefault === true) {
      await db.transaction(async (tx) => {
        await tx.update(schema.taxSlabs)
          .set({ isDefault: false })
          .where(and(eq(schema.taxSlabs.companyId, req.targetCompanyId), eq(schema.taxSlabs.isDefault, true)));
        await tx.insert(schema.taxSlabs).values(data).onConflictDoUpdate({
          target: schema.taxSlabs.id,
          set: data
        });
      });
    } else {
      await db.insert(schema.taxSlabs).values(data).onConflictDoUpdate({
        target: schema.taxSlabs.id,
        set: data
      });
    }
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// handleSetDefaultTaxSlab — if the target row already belongs to this company, just
// flip which one is default (clearing siblings first, same invariant as POST above).
// If it's a shared/legacy row (companyId null) not owned by this company, clone it into
// a real company-owned row instead of mutating isDefault directly on the shared row —
// otherwise it would become "the default" for every other company that also falls back
// to that same shared row. Mirrors the exact logic previously duplicated client-side in
// src/dbStore.ts.
router.patch('/tax-slabs/:id/set-default', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'taxSlabs.update')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const companyId = req.targetCompanyId;
    const [target] = await db.select().from(schema.taxSlabs).where(eq(schema.taxSlabs.id, id));
    if (!target) return res.status(404).json({ error: 'Tax slab not found.' });

    if (target.companyId && target.companyId !== companyId && !isSuperAdminUser(req.user)) {
      return res.status(403).json({ error: 'Forbidden: this tax slab belongs to another company' });
    }

    if (target.companyId === companyId) {
      await db.transaction(async (tx) => {
        await tx.update(schema.taxSlabs)
          .set({ isDefault: false })
          .where(and(eq(schema.taxSlabs.companyId, companyId), ne(schema.taxSlabs.id, id)));
        await tx.update(schema.taxSlabs).set({ isDefault: true }).where(eq(schema.taxSlabs.id, id));
      });
    } else {
      await db.transaction(async (tx) => {
        await tx.update(schema.taxSlabs)
          .set({ isDefault: false })
          .where(and(eq(schema.taxSlabs.companyId, companyId), eq(schema.taxSlabs.isDefault, true)));
        await tx.insert(schema.taxSlabs).values({
          id: generateId(),
          name: target.name,
          percentage: target.percentage,
          companyId,
          isDefault: true,
        });
      });
    }
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Product Categories ---
router.get('/product-categories', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.categories.read.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const companyId = req.targetCompanyId;
    const categories = await db.select().from(schema.productCategories).where(eq(schema.productCategories.companyId, companyId));
    res.json(categories);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/product-categories', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    const data = { ...req.body };

    let existing: typeof schema.productCategories.$inferSelect | undefined;
    if (data.id) {
      [existing] = await db.select().from(schema.productCategories).where(eq(schema.productCategories.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this category belongs to another company' });
      }
    }
    if (existing) {
      if (!permissions.categories.update.enabled) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      if (existing.isActive === false) {
        return res.status(400).json({ error: 'Cannot edit a deactivated category. Reactivate it first.' });
      }
    } else if (!permissions.categories.create.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    data.companyId = req.targetCompanyId;
    await db.insert(schema.productCategories).values(data).onConflictDoUpdate({
      target: schema.productCategories.id,
      set: data
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/product-categories/:id/toggle-active', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.categories.delete.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const [existing] = await db.select().from(schema.productCategories)
      .where(and(eq(schema.productCategories.id, id), eq(schema.productCategories.companyId, req.targetCompanyId)));
    if (!existing) {
      return res.status(404).json({ error: 'Category not found.' });
    }
    const nextActive = existing.isActive === false;
    await db.update(schema.productCategories).set({ isActive: nextActive }).where(eq(schema.productCategories.id, id));
    res.json({ success: true, isActive: nextActive });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Units of Measure ---
router.get('/units-of-measure', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.units.read.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const companyId = req.targetCompanyId;
    const units = await db.select().from(schema.unitsOfMeasure).where(eq(schema.unitsOfMeasure.companyId, companyId));
    res.json(units);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/units-of-measure', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    const data = { ...req.body };

    // The stored code is what ultimately reaches ZATCA's UBL XML as a line item's
    // unitCode (via normalizeZatcaUnitCode, server/lib/zatca/xmlBuilder.ts) — must be a
    // real UN/ECE Recommendation 20 code, not arbitrary free text, or every invoice using
    // this unit would submit an invalid unitCode.
    if (!isValidZatcaUnitCode(data.code)) {
      return res.status(400).json({ error: `'${data.code}' is not a recognized ZATCA unit code. Choose one from the allowed list.` });
    }

    let existing: typeof schema.unitsOfMeasure.$inferSelect | undefined;
    if (data.id) {
      [existing] = await db.select().from(schema.unitsOfMeasure).where(eq(schema.unitsOfMeasure.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this unit belongs to another company' });
      }
    }
    if (existing) {
      if (!permissions.units.update.enabled) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      if (existing.isActive === false) {
        return res.status(400).json({ error: 'Cannot edit a deactivated unit. Reactivate it first.' });
      }
    } else if (!permissions.units.create.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    data.companyId = req.targetCompanyId;
    await db.insert(schema.unitsOfMeasure).values(data).onConflictDoUpdate({
      target: schema.unitsOfMeasure.id,
      set: data
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/units-of-measure/:id/toggle-active', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.units.delete.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const [existing] = await db.select().from(schema.unitsOfMeasure)
      .where(and(eq(schema.unitsOfMeasure.id, id), eq(schema.unitsOfMeasure.companyId, req.targetCompanyId)));
    if (!existing) {
      return res.status(404).json({ error: 'Unit not found.' });
    }
    const nextActive = existing.isActive === false;
    await db.update(schema.unitsOfMeasure).set({ isActive: nextActive }).where(eq(schema.unitsOfMeasure.id, id));
    res.json({ success: true, isActive: nextActive });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Warehouses ---
router.get('/warehouses', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.warehouses.read.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const companyId = req.targetCompanyId;
    const warehousesList = await db.select().from(schema.warehouses).where(eq(schema.warehouses.companyId, companyId));
    res.json(warehousesList);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/warehouses', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    const data = { ...req.body };

    let existing: typeof schema.warehouses.$inferSelect | undefined;
    if (data.id) {
      [existing] = await db.select().from(schema.warehouses).where(eq(schema.warehouses.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this warehouse belongs to another company' });
      }
    } else {
      data.id = generateId();
    }
    if (existing) {
      if (!permissions.warehouses.update.enabled) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      if (existing.isActive === false) {
        return res.status(400).json({ error: 'Cannot edit a deactivated warehouse. Reactivate it first.' });
      }
    } else if (!permissions.warehouses.create.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    data.companyId = req.targetCompanyId;
    await db.insert(schema.warehouses).values(data).onConflictDoUpdate({
      target: schema.warehouses.id,
      set: data
    });
    res.json({ success: true, id: data.id });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Was a hard DELETE guarded against product-default/stock references — replaced with the
// toggle this table's own isActive column already existed for but was never wired to
// (an existing inconsistency: warehouses had the column, still hard-deleted anyway).
router.patch('/warehouses/:id/toggle-active', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.warehouses.delete.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const [existing] = await db.select().from(schema.warehouses)
      .where(and(eq(schema.warehouses.id, id), eq(schema.warehouses.companyId, req.targetCompanyId)));
    if (!existing) {
      return res.status(404).json({ error: 'Warehouse not found.' });
    }
    const nextActive = existing.isActive === false;
    await db.update(schema.warehouses).set({ isActive: nextActive }).where(eq(schema.warehouses.id, id));
    res.json({ success: true, isActive: nextActive });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Product Warehouses (Junction) ---
router.get('/product-warehouses', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.products.read.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const companyId = req.targetCompanyId;
    const mappings = await db.select().from(schema.productWarehouses).where(eq(schema.productWarehouses.companyId, companyId));
    res.json(mappings);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/product-warehouses', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.products.update.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const data = { ...req.body };

    if (data.id) {
      const [existing] = await db.select().from(schema.productWarehouses).where(eq(schema.productWarehouses.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this product-warehouse mapping belongs to another company' });
      }
    } else {
      data.id = generateId();
    }

    data.companyId = req.targetCompanyId;

    await db.insert(schema.productWarehouses).values(data).onConflictDoUpdate({
      target: schema.productWarehouses.id,
      set: data
    });
    res.json({ success: true, id: data.id });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/product-warehouses/:id', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.products.delete.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    await db.delete(schema.productWarehouses).where(and(eq(schema.productWarehouses.id, id), eq(schema.productWarehouses.companyId, req.targetCompanyId)));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
