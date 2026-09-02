import express from 'express';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and, ne, sql, or, isNull, inArray } from 'drizzle-orm';
import { normalizePermissions } from '../../src/types.js';
import { isSuperAdminUser, isAdminUser, hasPermission, assertOwnsRow, branchAccessOk } from '../lib/authz.js';
import { generateId } from '../../src/id.js';
import { validateBuyerFields } from '../lib/zatca/validators.js';
import { isValidZatcaUnitCode } from '../../src/zatcaUnitCodes.js';
import { previewNextDocumentNumbers, DOCUMENT_TYPE_REGISTRY } from '../lib/documentNumbering.js';
import { assertModifierGroupsOwnedByCompany } from '../lib/businessLogic.js';
import { imageSize } from 'image-size';

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
    const productIds = products.map(p => p.id);
    const links = productIds.length
      ? await db.select().from(schema.productModifierGroups).where(inArray(schema.productModifierGroups.productId, productIds))
      : [];
    const groupIdsByProduct = new Map<string, string[]>();
    for (const l of links.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))) {
      if (!groupIdsByProduct.has(l.productId)) groupIdsByProduct.set(l.productId, []);
      groupIdsByProduct.get(l.productId)!.push(l.modifierGroupId);
    }
    res.json(products.map(p => ({ ...p, modifierGroupIds: groupIdsByProduct.get(p.id) || [] })));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/products', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    const data = { ...req.body };
    // Not a column on products_services — pulled off before the insert/update below and
    // applied separately as productModifierGroups join rows, once the product row itself
    // is confirmed to belong to this company (see the assertModifierGroupsOwnedByCompany
    // call further down, which additionally confirms every id here belongs to this
    // company too). Optional/undefined leaves existing attachments untouched, matching
    // this route's general "don't re-validate what wasn't sent" convention.
    const modifierGroupIds: string[] | undefined = Array.isArray(data.modifierGroupIds) ? data.modifierGroupIds : undefined;
    delete data.modifierGroupIds;

    let existing: typeof schema.productsServices.$inferSelect | undefined;
    if (data.id) {
      [existing] = await db.select().from(schema.productsServices).where(eq(schema.productsServices.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this product belongs to another company' });
      }
    } else {
      data.id = generateId();
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

    // The client (MasterEntities.tsx) already enforces size/dimension limits before
    // upload, but that's a UI convenience only — a direct API call bypasses it entirely,
    // and base64Image has no length limit at the DB column level. Re-checked here against
    // the same per-company posSettings the client reads, so the limit is actually
    // enforced, not just suggested. Only runs when base64Image is being set/changed — an
    // update that doesn't touch the image (data.base64Image undefined) skips this
    // entirely, same "don't re-validate what wasn't sent" convention as other upsert
    // routes in this file.
    if (typeof data.base64Image === 'string' && data.base64Image) {
      const [company] = await db.select({ posSettings: schema.companies.posSettings }).from(schema.companies).where(eq(schema.companies.id, data.companyId));
      const posSettings = (company?.posSettings as any) || {};
      const maxSizeKB = posSettings.maxImageSizeKB || 150;
      const maxDim = posSettings.maxImageDimensions || 600;
      const minDim = posSettings.minImageDimensions ?? 150;

      const base64Data = data.base64Image.includes(',') ? data.base64Image.split(',')[1] : data.base64Image;
      const buffer = Buffer.from(base64Data, 'base64');
      if (buffer.length > maxSizeKB * 1024) {
        return res.status(400).json({ error: `Product image is too large (max ${maxSizeKB}KB).` });
      }
      try {
        const { width, height } = imageSize(buffer);
        if (width > maxDim || height > maxDim) {
          return res.status(400).json({ error: `Product image dimensions too large (max ${maxDim}x${maxDim}px).` });
        }
        if (minDim && (width < minDim || height < minDim)) {
          return res.status(400).json({ error: `Product image dimensions too small (min ${minDim}x${minDim}px).` });
        }
      } catch {
        return res.status(400).json({ error: 'Could not read product image — file may be corrupt or an unsupported format.' });
      }
    }

    if (modifierGroupIds !== undefined) {
      await assertModifierGroupsOwnedByCompany(db, data.companyId, modifierGroupIds);
    }

    await db.transaction(async (tx) => {
      await tx.insert(schema.productsServices).values(data).onConflictDoUpdate({
        target: schema.productsServices.id,
        set: data
      });
      if (modifierGroupIds !== undefined) {
        // Replace-the-whole-set on every save, same convention as quotation/invoice
        // items on edit — simpler and safer than diffing add/remove, and this list is
        // always small (a handful of modifier groups per product).
        await tx.delete(schema.productModifierGroups).where(eq(schema.productModifierGroups.productId, data.id));
        if (modifierGroupIds.length > 0) {
          // isolation-ok: every id in modifierGroupIds was already verified to belong to
          // this company by assertModifierGroupsOwnedByCompany, called earlier in this
          // same handler before the transaction started.
          await tx.insert(schema.productModifierGroups).values(
            modifierGroupIds.map((modifierGroupId, idx) => ({
              id: generateId(),
              productId: data.id,
              modifierGroupId,
              sortOrder: idx,
            }))
          );
        }
      }
    });
    res.json({ success: true, id: data.id });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
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
    // Document Numbering tab — its own permission leaf (documentNumbering.update), not
    // covered by companyProfile.update/isFullAdminTier above, mirroring the zatcaEnabled
    // guardrail below: a delegated profile-editor must not be able to smuggle a numbering
    // policy change through this same endpoint just because they can edit the company
    // profile. Never touches companies.counters (server/lib/documentNumbering.ts's lazy
    // seed reads that separately, once, and never writes it).
    if (body.numberingPolicy !== undefined) {
      if (!hasPermission(req.user, 'documentNumbering.update')) {
        return res.status(403).json({ error: 'Forbidden: editing document numbering requires the Document Numbering permission.' });
      }
      if (body.numberingPolicy !== null && typeof body.numberingPolicy !== 'object') {
        return res.status(400).json({ error: 'numberingPolicy must be an object.' });
      }
      update.numberingPolicy = body.numberingPolicy;
    }
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

// Read-only, display-only preview of "what would the next number look like right now" per
// document type — never increments anything (mirrors hashChain.ts's getNextHashChainState
// unlocked/display-only pattern). Gated on documentNumbering.read, separately from update.
router.get('/companies/:id/numbering-preview', async (req: any, res) => {
  try {
    const { id } = req.params;
    if (!isSuperAdminUser(req.user) && id !== req.targetCompanyId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!hasPermission(req.user, 'documentNumbering.read')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const preview = await previewNextDocumentNumbers(id);
    res.json({ registry: DOCUMENT_TYPE_REGISTRY, preview });
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

// --- Modifier Groups (POS-only, optional per product — see schema.ts's modifierGroups
// comment) --- Mirrors the Units-of-Measure CRUD shape immediately below: company-scoped
// list, create-or-update via data.id presence with assertOwnsRow on edits, companyId
// always forced server-side, toggle-active re-checking companyId in its own WHERE clause.
router.get('/modifier-groups', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'modifierGroups.read')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const companyId = req.targetCompanyId;
    const groups = await db.select().from(schema.modifierGroups).where(eq(schema.modifierGroups.companyId, companyId));
    const groupIds = groups.map(g => g.id);
    const choices = groupIds.length
      ? await db.select().from(schema.modifierChoices).where(inArray(schema.modifierChoices.modifierGroupId, groupIds))
      : [];
    const choicesByGroup = new Map<string, any[]>();
    for (const c of choices) {
      if (!choicesByGroup.has(c.modifierGroupId)) choicesByGroup.set(c.modifierGroupId, []);
      choicesByGroup.get(c.modifierGroupId)!.push(c);
    }
    res.json(groups.map(g => ({ ...g, choices: (choicesByGroup.get(g.id) || []).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)) })));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/modifier-groups', async (req: any, res) => {
  try {
    const data = { ...req.body };
    const choices: Array<{ id?: string; label: string; priceDelta: number }> = Array.isArray(data.choices) ? data.choices : [];
    delete data.choices;

    let existing: typeof schema.modifierGroups.$inferSelect | undefined;
    if (data.id) {
      [existing] = await db.select().from(schema.modifierGroups).where(eq(schema.modifierGroups.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this modifier group belongs to another company' });
      }
    } else {
      data.id = generateId();
    }
    if (!hasPermission(req.user, existing ? 'modifierGroups.update' : 'modifierGroups.create')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!data.name || !String(data.name).trim()) {
      return res.status(400).json({ error: 'Modifier group name is required.' });
    }

    data.companyId = req.targetCompanyId;
    await db.transaction(async (tx) => {
      await tx.insert(schema.modifierGroups).values(data).onConflictDoUpdate({
        target: schema.modifierGroups.id,
        set: data
      });
      // Replace the whole choice set on every save — same convention used for the
      // product's modifierGroupIds attachment above and for quotation/invoice items on
      // edit. This list is always small, so diffing add/remove buys nothing.
      await tx.delete(schema.modifierChoices).where(eq(schema.modifierChoices.modifierGroupId, data.id));
      if (choices.length > 0) {
        await tx.insert(schema.modifierChoices).values(
          choices.map((c, idx) => ({
            id: generateId(),
            modifierGroupId: data.id,
            label: c.label,
            priceDelta: String(c.priceDelta ?? 0),
            sortOrder: idx,
          }))
        );
      }
    });
    res.json({ success: true, id: data.id });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.patch('/modifier-groups/:id/toggle-active', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'modifierGroups.delete')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const [existing] = await db.select().from(schema.modifierGroups)
      .where(and(eq(schema.modifierGroups.id, id), eq(schema.modifierGroups.companyId, req.targetCompanyId)));
    if (!existing) {
      return res.status(404).json({ error: 'Modifier group not found.' });
    }
    const nextActive = existing.isActive === false;
    await db.update(schema.modifierGroups).set({ isActive: nextActive }).where(eq(schema.modifierGroups.id, id));
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
    } else {
      data.id = generateId();
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
    res.json({ success: true, id: data.id });
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

// --- Job Titles (HR) — e.g. "Sales Associate", "Cashier". Deliberately distinct from
// the `roles` table (RBAC permission bundles) — see jobTitles's schema comment. ---
router.get('/job-titles', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.jobTitles.read.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const companyId = req.targetCompanyId;
    const titles = await db.select().from(schema.jobTitles).where(eq(schema.jobTitles.companyId, companyId));
    res.json(titles);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/job-titles', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    const data = { ...req.body };
    if (!data.title || !String(data.title).trim()) {
      return res.status(400).json({ error: 'A job title is required.' });
    }

    let existing: typeof schema.jobTitles.$inferSelect | undefined;
    if (data.id) {
      [existing] = await db.select().from(schema.jobTitles).where(eq(schema.jobTitles.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this job title belongs to another company' });
      }
    } else {
      data.id = generateId();
    }
    if (existing) {
      if (!permissions.jobTitles.update.enabled) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      if (existing.isActive === false) {
        return res.status(400).json({ error: 'Cannot edit a deactivated job title. Reactivate it first.' });
      }
    } else if (!permissions.jobTitles.create.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    data.companyId = req.targetCompanyId;
    data.title = String(data.title).trim();
    data.description = data.description ? String(data.description).trim() || null : null;
    try {
      await db.insert(schema.jobTitles).values(data).onConflictDoUpdate({
        target: schema.jobTitles.id,
        set: data
      });
    } catch (dbError: any) {
      if (dbError.code === '23505' || dbError.cause?.code === '23505') {
        return res.status(400).json({ error: `"${data.title}" already exists as an active job title for this company.` });
      }
      throw dbError;
    }
    res.json({ success: true, id: data.id });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/job-titles/:id/toggle-active', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.jobTitles.delete.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const [existing] = await db.select().from(schema.jobTitles)
      .where(and(eq(schema.jobTitles.id, id), eq(schema.jobTitles.companyId, req.targetCompanyId)));
    if (!existing) {
      return res.status(404).json({ error: 'Job title not found.' });
    }
    const nextActive = existing.isActive === false;
    await db.update(schema.jobTitles).set({ isActive: nextActive }).where(eq(schema.jobTitles.id, id));
    res.json({ success: true, isActive: nextActive });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Product Unit Conversions (packaging/alternate units, e.g. "Carton-12") ---
// Gated on the existing products.create/.update leaves, not a new permission leaf — this
// is product-master data, the same authority as editing the product itself. See
// productUnitConversions's schema comment for the full model.
router.get('/product-unit-conversions', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.products.read.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const companyId = req.targetCompanyId;
    const conversions = await db.select().from(schema.productUnitConversions).where(eq(schema.productUnitConversions.companyId, companyId));
    res.json(conversions);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/product-unit-conversions', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    const data = { ...req.body };

    if (!data.productId || !data.unitOfMeasureId) {
      return res.status(400).json({ error: 'A product and a unit of measure are required.' });
    }
    const factor = Number(data.conversionFactor);
    if (!Number.isFinite(factor) || factor <= 0) {
      return res.status(400).json({ error: 'Conversion factor must be a positive number.' });
    }

    let existing: typeof schema.productUnitConversions.$inferSelect | undefined;
    if (data.id) {
      [existing] = await db.select().from(schema.productUnitConversions).where(eq(schema.productUnitConversions.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this packaging unit belongs to another company' });
      }
    } else {
      data.id = generateId();
    }
    if (existing) {
      if (!permissions.products.update.enabled) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    } else if (!permissions.products.create.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    data.companyId = req.targetCompanyId;
    // A product's own base unit can never also be one of its packaging/alternate units —
    // that would make "1 Carton = 1 Piece" a nonsensical second identity for the same unit.
    const [product] = await db.select({ unit: schema.productsServices.unit }).from(schema.productsServices)
      .where(and(eq(schema.productsServices.id, data.productId), eq(schema.productsServices.companyId, data.companyId)));
    if (!product) {
      return res.status(404).json({ error: 'Product not found for this company.' });
    }

    await db.insert(schema.productUnitConversions).values(data).onConflictDoUpdate({
      target: schema.productUnitConversions.id,
      set: data
    });
    res.json({ success: true, id: data.id });
  } catch (error: any) {
    // This drizzle-orm version wraps the real pg error under `.cause`, not `.code`
    // directly (confirmed against a live unique-violation) — checking both keeps this
    // correct regardless of drizzle version drift.
    if (error.code === '23505' || error.cause?.code === '23505') {
      return res.status(400).json({ error: 'This product already has an active packaging unit configured for that unit of measure.' });
    }
    res.status(500).json({ error: error.message });
  }
});

router.patch('/product-unit-conversions/:id/toggle-active', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.products.update.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    const [existing] = await db.select().from(schema.productUnitConversions)
      .where(and(eq(schema.productUnitConversions.id, id), eq(schema.productUnitConversions.companyId, req.targetCompanyId)));
    if (!existing) {
      return res.status(404).json({ error: 'Packaging unit not found.' });
    }
    const nextActive = existing.isActive === false;
    await db.update(schema.productUnitConversions).set({ isActive: nextActive }).where(eq(schema.productUnitConversions.id, id));
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
    const conditions = [eq(schema.warehouses.companyId, companyId)];
    if (Array.isArray(req.allowedBranchIds)) {
      if (req.allowedBranchIds.length === 0) return res.json([]);
      conditions.push(inArray(schema.warehouses.branchId, req.allowedBranchIds));
    }
    const warehousesList = await db.select().from(schema.warehouses).where(and(...conditions));
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
      if (existing && !branchAccessOk(req, existing.branchId)) {
        return res.status(403).json({ error: 'Forbidden: you are not assigned to this branch.' });
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

    // data.branchId was previously written verbatim with no ownership check at all — not
    // even that it belongs to this company, let alone the caller's own allowedBranchIds.
    // A branch-restricted user could otherwise create/reassign a warehouse under a branch
    // (or even, before the companyId check below, potentially a branch id copied from a
    // completely different company) they have no business touching.
    if (data.branchId) {
      const [targetBranch] = await db.select({ id: schema.branches.id }).from(schema.branches)
        .where(and(eq(schema.branches.id, data.branchId), eq(schema.branches.companyId, data.companyId)));
      if (!targetBranch) {
        return res.status(404).json({ error: 'Selected branch not found for this company.' });
      }
    }
    if (!branchAccessOk(req, data.branchId || null)) {
      return res.status(403).json({ error: 'Forbidden: you are not assigned to this branch.' });
    }

    // Once a company has adopted branches, a brand-new warehouse must belong to one —
    // otherwise it silently becomes permanently unscoped, exactly the gap the backfill
    // action below exists to fix for pre-existing data. Only enforced on genuinely new
    // warehouses (not edits to an existing, possibly still-unbackfilled one) and only
    // once the company actually has an active branch — a company that has never adopted
    // branches at all keeps today's exact behavior (branchId stays optional).
    if (!existing && !data.branchId) {
      const [anyBranch] = await db.select({ id: schema.branches.id }).from(schema.branches)
        .where(and(eq(schema.branches.companyId, data.companyId), eq(schema.branches.isActive, true)));
      if (anyBranch) {
        return res.status(400).json({ error: 'This company uses branches — select a branch for the new warehouse.' });
      }
    }

    const effectiveType = data.type || existing?.type || 'sales';

    // "Every company needs at least one default warehouse" (product decision) is enforced
    // pragmatically here, not by a NOT-NULL constraint the company can't satisfy at
    // creation time: a company's very first warehouse auto-becomes its default the same
    // way branches.ts auto-defaults a company's first branch, unless it's a 'backend'
    // warehouse (which can never be a default) or the caller already decided otherwise.
    // When the field isn't sent at all on an edit, preserve whatever this warehouse's
    // flag already was — omitting it must never silently un-default a warehouse.
    let becomingDefault: boolean;
    if (data.isCompanyDefault === true || data.isCompanyDefault === false) {
      becomingDefault = data.isCompanyDefault;
    } else if (existing) {
      becomingDefault = existing.isCompanyDefault === true;
    } else {
      becomingDefault = false;
      if (effectiveType === 'sales') {
        const [anyWarehouse] = await db.select({ id: schema.warehouses.id }).from(schema.warehouses)
          .where(eq(schema.warehouses.companyId, data.companyId));
        if (!anyWarehouse) becomingDefault = true;
      }
    }
    if (becomingDefault && effectiveType !== 'sales') {
      return res.status(400).json({ error: 'Only a sales warehouse can be set as the company default.' });
    }
    data.isCompanyDefault = becomingDefault;

    if (becomingDefault) {
      // Swap pattern — same as branches.ts's isDefault handling: atomically un-default
      // any other warehouse this company currently has flagged before setting this one,
      // so the partial unique index never sees two "true" rows at once.
      await db.transaction(async (tx) => {
        await tx.update(schema.warehouses).set({ isCompanyDefault: false })
          .where(and(eq(schema.warehouses.companyId, data.companyId), eq(schema.warehouses.isCompanyDefault, true)));
        await tx.insert(schema.warehouses).values(data).onConflictDoUpdate({
          target: schema.warehouses.id,
          set: data
        });
      });
    } else {
      await db.insert(schema.warehouses).values(data).onConflictDoUpdate({
        target: schema.warehouses.id,
        set: data
      });
    }
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
    let mappings = await db.select().from(schema.productWarehouses).where(eq(schema.productWarehouses.companyId, companyId));
    // productWarehouses has no branchId of its own — derived via warehouseId, same
    // pattern as GET /api/state's own branchOkViaWarehouse scoping for this exact table
    // (server.ts), which this standalone REST endpoint had no equivalent of until now.
    if (Array.isArray(req.allowedBranchIds)) {
      const allowedWarehouses = req.allowedBranchIds.length
        ? await db.select({ id: schema.warehouses.id }).from(schema.warehouses)
            .where(and(eq(schema.warehouses.companyId, companyId), inArray(schema.warehouses.branchId, req.allowedBranchIds)))
        : [];
      const allowedWarehouseIds = new Set(allowedWarehouses.map(w => w.id));
      mappings = mappings.filter(m => allowedWarehouseIds.has(m.warehouseId));
    }
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

    // productId/warehouseId were previously never checked against companyId at all —
    // same class of gap as GRN/stock-adjustments/stock-takes found and fixed elsewhere
    // in this pass. A crafted request could set stock policy (min/max, bin location) for
    // another company's warehouse, or reference another company's product.
    if (data.productId) {
      const [product] = await db.select({ id: schema.productsServices.id }).from(schema.productsServices)
        .where(and(eq(schema.productsServices.id, data.productId), eq(schema.productsServices.companyId, data.companyId)));
      if (!product) return res.status(404).json({ error: 'Selected product not found for this company.' });
    }
    if (data.warehouseId) {
      const [warehouse] = await db.select({ branchId: schema.warehouses.branchId }).from(schema.warehouses)
        .where(and(eq(schema.warehouses.id, data.warehouseId), eq(schema.warehouses.companyId, data.companyId)));
      if (!warehouse) return res.status(404).json({ error: 'Selected warehouse not found for this company.' });
      if (!branchAccessOk(req, warehouse.branchId)) {
        return res.status(403).json({ error: 'Forbidden: you are not assigned to this branch.' });
      }
    }

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
