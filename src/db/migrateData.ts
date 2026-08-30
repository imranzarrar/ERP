import { db } from './index.js';
import * as schema from './schema.js';
import bcrypt from 'bcrypt';
import { eq, and, inArray, ne } from 'drizzle-orm';
import { isSuperAdminUser, hasPermission } from '../../server/lib/authz.js';

export interface MigrateContext {
  user?: any;
  targetCompanyId?: string;
}

// Applied to every tenant-scoped table before its records are upserted. For a
// non-super-admin caller: (1) if `requiredPermission` is set and the caller lacks it,
// the entire set of records for this table is dropped (not a hard failure of the whole
// request — other tables in the same sync still proceed); (2) `companyId` is forced to
// the caller's own company on every record; (3) any record whose `id` already exists in
// the DB under a *different* company is dropped, so a caller can't reach across tenants
// via a guessed/leaked id and overwrite or relocate another company's row.
async function scopeAndAuthorizeRecords(
  table: any,
  records: any[] | undefined,
  opts: { ctx: MigrateContext; requiredPermission?: string; tableName: string; skipped: Record<string, string> }
): Promise<any[]> {
  const { ctx, requiredPermission, tableName, skipped } = opts;
  if (!records || !records.length) return records || [];

  // No user context (e.g. startup auto-seed calling this internally) is trusted as-is.
  if (!ctx.user) return records;

  if (isSuperAdminUser(ctx.user)) return records;

  if (requiredPermission && !hasPermission(ctx.user, requiredPermission)) {
    skipped[tableName] = `missing permission '${requiredPermission}'`;
    return [];
  }

  const targetCompanyId = ctx.targetCompanyId;
  const out: any[] = [];
  for (const rec of records) {
    if (rec.id) {
      const [existing] = await db.select().from(table).where(eq(table.id, rec.id));
      if (existing && existing.companyId && existing.companyId !== targetCompanyId) {
        continue; // belongs to another company — not ours to touch via this bulk path
      }
      // A row that already exists with companyId === null (e.g. tax_slabs' documented
      // shared/legacy defaults, "visible to every company") must never be silently
      // claimed by whichever company's client happens to sync it — every company's
      // local state legitimately holds a cached copy of these for display, and this
      // generic bulk path can't tell "I'm just carrying a read-only copy of shared
      // data" apart from "I actually want to modify this." Confirmed live: an ordinary
      // admin save on an unrelated screen silently rewrote 3 shared tax slabs'
      // companyId to whatever company they had selected, corrupting them for every
      // other company that relied on the same shared defaults. Skip existing shared
      // rows entirely via this path — only a genuinely NEW record (no existing row)
      // gets scoped to the caller's own company below.
      if (existing && existing.companyId === null) {
        continue;
      }
    }
    out.push({ ...rec, companyId: targetCompanyId });
  }
  return out;
}

export async function migrateDataToPostgres(data: any, ctx: MigrateContext = {}) {
  const skipped: Record<string, string> = {};
  try {
    // Helper function for batch upsert
    async function upsert(table: any, records: any[], idField: string | string[] = 'id') {
      if (!records || !records.length) return;
      for (const record of records) {
        const target = Array.isArray(idField)
          ? idField.map(f => table[f])
          : table[idField];
        await db.insert(table).values(record).onConflictDoUpdate({
          target,
          set: record
        });
      }
    }

    const isCallerAdmin = !ctx.user || isSuperAdminUser(ctx.user) || ctx.user.role === 'admin';
    const isCallerSuperAdmin = !ctx.user || isSuperAdminUser(ctx.user);

    // 1. Companies — platform-owner action, no delegable permission. For non-super-admin
    // callers, only the record matching their own company may pass through (silently
    // dropped otherwise — a resync from a correctly-scoped frontend only ever contains
    // the caller's own company row).
    if (data.companies?.length) {
      let companiesInput = data.companies;
      if (ctx.user && !isCallerSuperAdmin) {
        companiesInput = companiesInput.filter((c: any) => c.id === ctx.targetCompanyId);
        if (companiesInput.length < data.companies.length) skipped.companies = 'non-owned company rows dropped';
      }

      // UPDATE-ONLY via this generic path — never INSERT a new company here. This whole
      // sync call always carries the caller's ENTIRE in-memory client state (every table,
      // not just what they meant to change), because that's how this legacy blob-sync
      // endpoint works everywhere in the app, including from a genuinely explicit "Save"
      // button click, not just some background trigger. If a browser tab has been open
      // since before a company was deleted, its next save of literally anything still
      // carries that company in its stale `data.companies` array — upserting it back
      // silently RECREATES a company that was deliberately deleted (confirmed live: this
      // happened twice from an ordinary settings save in an already-open tab). Real
      // company creation belongs exclusively to the dedicated, super-admin-gated
      // POST /api/masterEntities/companies route; this path may only ever update a
      // company that still genuinely exists.
      const existingIds = new Set(
        (await db.select({ id: schema.companies.id }).from(schema.companies)).map(r => r.id)
      );
      const preFilterCount = companiesInput.length;
      companiesInput = companiesInput.filter((c: any) => c.id && existingIds.has(c.id));
      if (companiesInput.length < preFilterCount) {
        skipped.companies = (skipped.companies ? skipped.companies + '; ' : '') + 'rows with no existing match dropped (this path never creates new companies)';
      }

      const records = companiesInput.map((c: any) => ({
        id: c.id,
        name: c.name || '',
        address: c.address || '',
        phone: c.phone || '',
        email: c.email || '',
        logoUrl: c.logoUrl || '',
        customHeader: c.customHeader || '',
        customFooter: c.customFooter || '',
        vatNumber: c.vatNumber,
        themeId: c.themeId,
        currency: c.currency || 'SAR',
        portalTitle: c.portalTitle,
        portalSubtitle: c.portalSubtitle,
        // counters intentionally omitted: it is exclusively owned by the row-locked
        // getAndIncrementCounter() path (server/lib/businessLogic.ts). Including a
        // client's in-memory snapshot here lets a stale tab's next unrelated save
        // silently roll the shared document-number counter backward, causing a later
        // real invoice/quotation/etc. to be issued with a number already in use
        // (confirmed root cause of duplicate invoiceNumber rows for a live company).
        posSettings: c.posSettings,
        isInventoryModuleEnabled: c.isInventoryModuleEnabled ?? false,
        zatcaEnabled: c.zatcaEnabled ?? false,
        inventorySettings: c.inventorySettings || null,
      }));
      await upsert(schema.companies, records);
    }

    // 2. Users — user writes belong exclusively to the dedicated, permission-checked
    // POST /api/users route. Via this bulk path: a non-admin caller's users are dropped
    // entirely; an admin/super-admin caller may proceed, but a non-super-admin caller
    // can never grant isSuperAdmin/role:'super-admin', and any record whose id already
    // belongs to a different company aborts the whole request (privilege-escalation /
    // account-takeover risk warrants a hard failure here, not a silent drop).
    if (data.users?.length) {
      if (!isCallerAdmin) {
        skipped.users = 'caller is not admin/super-admin';
      } else {
        // Looked up for EVERY caller (not just non-super-admin) — GET /api/state never
        // returns password hashes to the client (a deliberate security exclusion), so
        // u.password is always empty on a plain resync. Without this lookup, the password
        // fallback below would silently overwrite every real user's password with a hash
        // of '123456' on every single full-state sync (this app fires those automatically,
        // unprompted, on nearly every save) — confirmed live against real production users;
        // this is the actual cause of the earlier "admin password mysteriously reset"
        // incident, not an isolated one-off.
        const existingById = new Map<string, any>();
        for (const u of data.users) {
          if (u.id) {
            const [existing] = await db.select().from(schema.users).where(eq(schema.users.id, u.id));
            if (existing && ctx.user && !isCallerSuperAdmin && existing.companyId && existing.companyId !== ctx.targetCompanyId) {
              throw Object.assign(new Error(`Cannot modify user '${u.id}': belongs to another company.`), { status: 403 });
            }
            if (existing) existingById.set(u.id, existing);
          }
        }

        const records = [];
        for (const u of data.users) {
          const existing = existingById.get(u.id);
          // Only ever hash/replace a password when the caller actually supplied a new one.
          // A missing/empty u.password means "unchanged" — keep the existing stored hash
          // (or fall back to a default only for a genuinely brand-new user with no row yet).
          let password = existing?.password || '123456';
          if (u.password) {
            password = u.password.startsWith('$2b$') || u.password.startsWith('$2a$')
              ? u.password
              : await bcrypt.hash(u.password, 10);
          }
          const requestedRole = u.role || 'user';
          // An ignored escalation attempt on an existing user falls back to their current
          // role, not a hard reset to 'user' (which would itself be an unintended downgrade).
          const fallbackRole = (existing?.role && existing.role !== 'super-admin') ? existing.role : 'user';
          const role = isCallerSuperAdmin ? requestedRole : (requestedRole === 'super-admin' ? fallbackRole : requestedRole);
          const grantSuperAdmin = isCallerSuperAdmin ? Boolean(u.isSuperAdmin) : false;
          const targetCompanyId = (ctx.user && !isCallerSuperAdmin) ? ctx.targetCompanyId : (u.companyId || null);

          records.push({
            id: u.id,
            uid: u.uid || null,
            username: u.username,
            password: password,
            role,
            companyId: targetCompanyId,
            isSuperAdmin: grantSuperAdmin,
            isActive: u.isActive !== undefined ? Boolean(u.isActive) : true,
            uiLanguage: u.uiLanguage || 'en',
            isDeleted: u.isDeleted ? 1 : 0,
            _roleIds: Array.isArray(u.roleIds) ? u.roleIds : [],
            _targetCompanyId: targetCompanyId,
          });
        }
        const userRecords = records.map(({ _roleIds, _targetCompanyId, ...rest }) => rest);
        await upsert(schema.users, userRecords);

        // Sync each user's role assignments (many-to-many) — a role can only ever be
        // assigned to a user in the same company it belongs to; mismatches are dropped
        // silently rather than failing the whole record.
        for (const rec of records) {
          if (!rec._roleIds.length) continue;
          const validRoles = await db.select().from(schema.roles).where(
            and(inArray(schema.roles.id, rec._roleIds), eq(schema.roles.companyId, rec._targetCompanyId))
          );
          await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, rec.id));
          if (validRoles.length) {
            await db.insert(schema.userRoles).values(validRoles.map(r => ({ userId: rec.id, roleId: r.id })));
          }
        }
      }
    }

    // 3. Document Templates — admin-only (no dedicated permission node; matches the
    // existing UI, which only exposes template management to admins).
    if (data.templates?.length) {
      const templatesInput = isCallerAdmin ? data.templates : (skipped.templates = 'caller is not admin', []);
      const scoped = await scopeAndAuthorizeRecords(schema.documentTemplates, templatesInput, { ctx, tableName: 'templates', skipped });
      const records = scoped.map((t: any) => ({
        id: t.id,
        name: t.name || '',
        language: t.language || 'English',
        pageSize: t.pageSize || 'A4',
        isActive: t.isActive,
        printHeader: t.printHeader,
        printFooter: t.printFooter,
        printLogo: t.printLogo,
        printQrCode: t.printQrCode,
        companyId: t.companyId,
        layoutJson: t.layoutJson,
        // Previously missing — the Canvas Designer's Global Row Gap / Global Font Family
        // selects updated local state and appeared to save, but with no column here to
        // land in, the choice was silently lost on the very next reload.
        gridGapY: t.gridGapY,
        globalFontFamily: t.globalFontFamily,
      }));
      await upsert(schema.documentTemplates, records);
    }

    // 4. Tax Slabs
    if (data.taxSlabs?.length) {
      const scoped = await scopeAndAuthorizeRecords(schema.taxSlabs, data.taxSlabs, { ctx, requiredPermission: 'taxSlabs.edit', tableName: 'taxSlabs', skipped });
      // companyId is a NOT NULL uuid column — a record carrying an empty/missing companyId
      // (e.g. a browser tab's stale in-memory copy of a row from before it was properly
      // scoped to a company) would otherwise throw a raw Postgres error and abort this
      // entire blob sync, including every other unrelated, legitimate change bundled in
      // the same request. Drop just that record instead — confirmed live: this exact
      // shape (a shared/legacy tax slab cached with companyId '') kept failing every full
      // sync from an already-open tab even though the row itself was already fixed in DB.
      const validScoped = scoped.filter((t: any) => !!t.companyId);
      if (validScoped.length < scoped.length) {
        skipped.taxSlabs = (skipped.taxSlabs ? skipped.taxSlabs + '; ' : '') + `${scoped.length - validScoped.length} row(s) dropped: missing/invalid companyId (stale cached record — reload to pick up the corrected copy)`;
      }
      const records = validScoped.map((t: any) => ({
        id: t.id,
        name: t.name || '',
        percentage: String(t.percentage || 0),
        companyId: t.companyId,
        isDefault: !!t.isDefault,
      }));
      // Authoritatively clear any OTHER existing default for a company before setting a
      // new one — relying on the client to have included every sibling row (with
      // isDefault reset to false) in the same payload is fragile: if the client's local
      // state is even slightly stale (doesn't have the row the DB currently has marked
      // default — e.g. from an action taken in a different tab/session), the "reset
      // others" step silently misses it, and this insert then collides with
      // unique_default_tax_slab (one default per company) instead of correctly
      // replacing it. Confirmed live. The server doesn't need the client's cooperation
      // to enforce "at most one default per company" — it can just do it directly.
      for (const rec of records) {
        if (rec.isDefault && rec.companyId) {
          await db.update(schema.taxSlabs)
            .set({ isDefault: false })
            .where(and(eq(schema.taxSlabs.companyId, rec.companyId), ne(schema.taxSlabs.id, rec.id)));
        }
      }
      await upsert(schema.taxSlabs, records);
    }

    // 5. Products/Services
    if (data.products?.length) {
      const scoped = await scopeAndAuthorizeRecords(schema.productsServices, data.products, { ctx, requiredPermission: 'products.edit', tableName: 'products', skipped });
      const records = scoped.map((p: any) => ({
        id: p.id,
        name: p.name || '',
        description: p.description || '',
        unitPrice: String(p.unitPrice || 0),
        type: p.type || 'Sales',
        unit: p.unit || '',
        companyId: p.companyId,
        attachmentUrl: p.attachmentUrl,
        amountPaid: p.amountPaid != null ? String(p.amountPaid) : undefined,
        categoryId: p.categoryId || null,
        barcode: p.barcode || null,
        sku: p.sku || null,
        defaultWarehouseId: p.defaultWarehouseId || null,
        binLocation: p.binLocation || null,
        minLevel: p.minLevel != null ? String(p.minLevel) : null,
        maxLevel: p.maxLevel != null ? String(p.maxLevel) : null,
        reorderLeadTime: p.reorderLeadTime || null,
      }));
      await upsert(schema.productsServices, records);
    }

    // 6. Customers
    if (data.customers?.length) {
      const scoped = await scopeAndAuthorizeRecords(schema.customers, data.customers, { ctx, requiredPermission: 'customers.edit', tableName: 'customers', skipped });
      const records = scoped.map((c: any) => ({
        id: c.id,
        name: c.name || '',
        phone: c.phone || '',
        email: c.email || '',
        address: c.address || '',
        taxRegNumber: c.taxRegNumber,
        isSystem: c.isSystem,
        companyId: c.companyId,
        attachmentUrl: c.attachmentUrl,
      }));
      await upsert(schema.customers, records);
    }

    // 7. Vendors
    if (data.vendors?.length) {
      const scoped = await scopeAndAuthorizeRecords(schema.vendors, data.vendors, { ctx, requiredPermission: 'vendors.edit', tableName: 'vendors', skipped });
      const records = scoped.map((v: any) => ({
        id: v.id,
        name: v.name || '',
        phone: v.phone || '',
        email: v.email || '',
        address: v.address || '',
        taxRegNumber: v.taxRegNumber,
        isSystem: v.isSystem,
        apGlAccount: v.apGlAccount || null,
        companyId: v.companyId,
        attachmentUrl: v.attachmentUrl,
      }));
      await upsert(schema.vendors, records);
    }

    // 8. Bank Accounts
    if (data.banks?.length) {
      const scoped = await scopeAndAuthorizeRecords(schema.bankAccounts, data.banks, { ctx, requiredPermission: 'banks.edit', tableName: 'banks', skipped });
      const records = scoped.map((b: any) => ({
        id: b.id,
        bankName: b.bankName,
        accountNumber: b.accountNumber,
        accountTitle: b.accountTitle,
        openingBalance: String(b.openingBalance),
        isActive: b.isActive,
        isDefault: b.isDefault,
        companyId: b.companyId,
        attachmentUrl: b.attachmentUrl,
      }));
      await upsert(schema.bankAccounts, records);
    }

    // 9. Fiscal Months — deliberately NOT synced through this generic blob path. Opening
    // and closing a month are two separately-permissioned, higher-stakes operations
    // (fiscalMonths.open / fiscalMonths.close — see permissionSchema.ts) that the real
    // dedicated route (POST /api/transactions/months) already enforces correctly and
    // exclusively; AdminSettings.tsx's handleOpenMonth/handleConfirmClose already call
    // that route directly and only use this generic sync path to reflect the result into
    // local state afterward. A coarse blob-sync gate here couldn't distinguish open from
    // close per-record anyway. If a payload somehow still includes `data.months`, it's
    // silently ignored rather than given a permissive fallback check.
    if (data.months?.length) {
      skipped.months = 'fiscal month changes must go through POST /api/transactions/months, not the generic sync';
    }

    // 10. Quotations & Items
    if (data.quotations?.length) {
      const scopedQuotations = await scopeAndAuthorizeRecords(schema.quotations, data.quotations, { ctx, requiredPermission: 'quotation.create', tableName: 'quotations', skipped });
      const qRecords = [];
      const itemRecords = [];
      for (const q of scopedQuotations) {
        qRecords.push({
          id: q.id,
          quotationNumber: q.quotationNumber,
          date: q.date,
          customerId: q.customerId,
          taxSlabId: q.taxSlabId,
          notes: q.notes || '',
          status: q.status,
          createdById: q.createdById,
          createdAt: new Date(q.createdAt),
          discountPercentage: q.discountPercentage != null ? String(q.discountPercentage) : undefined,
          companyId: q.companyId,
          attachmentUrl: q.attachmentUrl,
        });
        if (q.items?.length) {
          for (const item of q.items) {
            itemRecords.push({
              id: item.id,
              quotationId: q.id,
              description: item.description,
              unitCost: String(item.unitCost),
              quantity: String(item.quantity),
              discountAmount: item.discountAmount != null ? String(item.discountAmount) : undefined,
            });
          }
        }
      }
      await upsert(schema.quotations, qRecords);
      await upsert(schema.quotationItems, itemRecords);
    }

    // 11. Invoices & Items
    if (data.invoices?.length) {
      const scopedInvoices = await scopeAndAuthorizeRecords(schema.invoices, data.invoices, { ctx, requiredPermission: 'invoice.create', tableName: 'invoices', skipped });
      const invRecords = [];
      const itemRecords = [];
      for (const inv of scopedInvoices) {
        const rec: any = {
          id: inv.id,
          invoiceNumber: inv.invoiceNumber,
          date: inv.date,
          customerId: inv.customerId,
          taxSlabId: inv.taxSlabId,
          bankId: inv.bankId,
          paymentStatus: inv.paymentStatus,
          paymentDate: inv.paymentDate ? new Date(inv.paymentDate) : null,
          notes: inv.notes || '',
          status: inv.status,
          createdById: inv.createdById,
          createdAt: new Date(inv.createdAt),
          originQuotationId: inv.originQuotationId,
          discountPercentage: inv.discountPercentage != null ? String(inv.discountPercentage) : undefined,
          amountPaid: inv.amountPaid != null ? String(inv.amountPaid) : undefined,
          companyId: inv.companyId,
          isPosSale: inv.isPosSale || false,
          shiftId: inv.shiftId || null,
          attachmentUrl: inv.attachmentUrl,
        };
        if (inv.zatcaStatus) rec.zatcaStatus = inv.zatcaStatus;
        if (inv.uuid) rec.uuid = inv.uuid;
        if (inv.icv != null) rec.icv = inv.icv;
        if (inv.previousInvoiceHash) rec.previousInvoiceHash = inv.previousInvoiceHash;
        if (inv.currentInvoiceHash) rec.currentInvoiceHash = inv.currentInvoiceHash;
        if (inv.xmlContent) rec.xmlContent = inv.xmlContent;
        if (inv.qrCodeContent) rec.qrCodeContent = inv.qrCodeContent;
        if (inv.clearanceTimestamp) rec.clearanceTimestamp = new Date(inv.clearanceTimestamp);
        if (inv.zatcaValidationResults) rec.zatcaValidationResults = inv.zatcaValidationResults;
        invRecords.push(rec);
        if (inv.items?.length) {
          for (const item of inv.items) {
            itemRecords.push({
              id: item.id,
              invoiceId: inv.id,
              description: item.description,
              unitCost: String(item.unitCost),
              quantity: String(item.quantity),
              discountAmount: item.discountAmount != null ? String(item.discountAmount) : undefined,
            });
          }
        }
      }
      await upsert(schema.invoices, invRecords);
      await upsert(schema.invoiceItems, itemRecords);

      // Auto-trigger ZATCA Phase 2 clearance for unsubmitted/pending invoices
      try {
        const { processInvoiceZatca } = await import('../../server/lib/zatca/processInvoice.js');
        for (const inv of scopedInvoices) {
          if (!inv.zatcaStatus || inv.zatcaStatus === 'NOT_SUBMITTED') {
            processInvoiceZatca(inv.id).catch(e => console.error(`[ZATCA Auto Process Error] ${inv.id}:`, e));
          }
        }
      } catch (e) {
        console.error('[ZATCA Import Error]:', e);
      }
    }

    // 12. Expenses & Items
    if (data.expenses?.length) {
      const scopedExpenses = await scopeAndAuthorizeRecords(schema.expenses, data.expenses, { ctx, requiredPermission: 'expense.create', tableName: 'expenses', skipped });
      const expRecords = [];
      const itemRecords = [];
      for (const exp of scopedExpenses) {
        expRecords.push({
          id: exp.id,
          expenseNumber: exp.expenseNumber,
          date: exp.date,
          vendorId: exp.vendorId,
          taxSlabId: exp.taxSlabId,
          bankId: exp.bankId,
          paymentStatus: exp.paymentStatus,
          paymentDate: exp.paymentDate ? new Date(exp.paymentDate) : null,
          description: exp.description || '',
          amount: String(exp.amount),
          status: exp.status,
          type: exp.type,
          originAccrualId: exp.originAccrualId,
          accrualSettled: exp.accrualSettled,
          settledExpenseId: exp.settledExpenseId,
          createdById: exp.createdById,
          createdAt: new Date(exp.createdAt),
          classification: exp.classification,
          assetType: exp.assetType,
          companyId: exp.companyId,
          isPosSale: exp.isPosSale || false,
          shiftId: exp.shiftId || null,
          attachmentUrl: exp.attachmentUrl,
          amountPaid: exp.amountPaid != null ? String(exp.amountPaid) : undefined,
        });
        if (exp.items?.length) {
          for (const item of exp.items) {
            itemRecords.push({
              id: item.id,
              expenseId: exp.id,
              description: item.description,
              unitCost: String(item.unitCost),
              quantity: String(item.quantity),
            });
          }
        }
      }
      await upsert(schema.expenses, expRecords);
      await upsert(schema.expenseItems, itemRecords);
    }

    // 13. Recurring Expense Templates
    if (data.recurringTemplates?.length) {
      const scoped = await scopeAndAuthorizeRecords(schema.recurringExpenseTemplates, data.recurringTemplates, { ctx, requiredPermission: 'expense.create', tableName: 'recurringTemplates', skipped });
      const records = scoped.map((rec: any) => ({
        id: rec.id,
        description: rec.description,
        vendorId: rec.vendorId,
        defaultAmount: String(rec.defaultAmount),
        taxSlabId: rec.taxSlabId,
        isActive: rec.isActive,
        bankId: rec.bankId,
        companyId: rec.companyId,
        attachmentUrl: rec.attachmentUrl,
      }));
      await upsert(schema.recurringExpenseTemplates, records);
    }

    // 14. Recurring Postings
    if (data.recurringPostings?.length) {
      const scoped = await scopeAndAuthorizeRecords(schema.recurringPostings, data.recurringPostings, { ctx, requiredPermission: 'expense.create', tableName: 'recurringPostings', skipped });
      const records = scoped.map((post: any) => ({
        id: post.id,
        templateId: post.templateId,
        monthId: post.monthId,
        status: post.status,
        expenseId: post.expenseId,
        companyId: post.companyId,
        attachmentUrl: post.attachmentUrl,
      }));
      await upsert(schema.recurringPostings, records);
    }

    // 15. Vouchers
    if (data.vouchers?.length) {
      const scoped = await scopeAndAuthorizeRecords(schema.vouchers, data.vouchers, { ctx, requiredPermission: 'expense.create', tableName: 'vouchers', skipped });
      const records = scoped.map((vch: any) => ({
        id: vch.id,
        voucherNumber: vch.voucherNumber,
        type: vch.type,
        date: vch.date,
        bankId: vch.bankId,
        amount: String(vch.amount),
        description: vch.description,
        referenceType: vch.referenceType,
        referenceId: vch.referenceId,
        createdById: vch.createdById,
        createdAt: new Date(vch.createdAt),
        companyId: vch.companyId,
        isPosSale: vch.isPosSale || false,
        shiftId: vch.shiftId || null,
        attachmentUrl: vch.attachmentUrl,
      }));
      await upsert(schema.vouchers, records);
    }

    // 16. Investors
    if (data.investors?.length) {
      const scoped = await scopeAndAuthorizeRecords(schema.investors, data.investors, { ctx, requiredPermission: 'investors.access', tableName: 'investors', skipped });
      const records = scoped.map((inv: any) => ({
        id: inv.id,
        name: inv.name || '',
        email: inv.email || '',
        phone: inv.phone || '',
        equityPercentage: String(inv.equityPercentage || 0),
        profitPercentage: inv.profitPercentage != null ? String(inv.profitPercentage) : undefined,
        capitalContributed: String(inv.capitalContributed || 0),
        isActive: inv.isActive,
        notes: inv.notes,
        createdAt: new Date(inv.createdAt),
        companyId: inv.companyId,
        attachmentUrl: inv.attachmentUrl,
      }));
      await upsert(schema.investors, records);
    }

    // 16b. POS Shifts
    if (data.posShifts?.length) {
      const scoped = await scopeAndAuthorizeRecords(schema.posShifts, data.posShifts, { ctx, requiredPermission: 'pos.access', tableName: 'posShifts', skipped });
      const records = scoped.map((ps: any) => ({
        id: ps.id,
        companyId: ps.companyId,
        userId: ps.userId,
        startTime: new Date(ps.startTime),
        endTime: ps.endTime ? new Date(ps.endTime) : null,
        startCash: String(ps.startCash),
        endCash: ps.endCash != null ? String(ps.endCash) : null,
        expectedCash: ps.expectedCash != null ? String(ps.expectedCash) : null,
        status: ps.status,
        notes: ps.notes || null,
        isPosSale: ps.isPosSale ?? false,
        shiftId: ps.shiftId || null,
        attachmentUrl: ps.attachmentUrl || null,
      }));
      await upsert(schema.posShifts, records);
    }

    // 16c. POS Held Invoices
    if (data.posHeldInvoices?.length) {
      const scoped = await scopeAndAuthorizeRecords(schema.posHeldInvoices, data.posHeldInvoices, { ctx, requiredPermission: 'pos.access', tableName: 'posHeldInvoices', skipped });
      const records = scoped.map((ph: any) => ({
        id: ph.id,
        shiftId: ph.shiftId,
        companyId: ph.companyId,
        customerId: ph.customerId || null,
        items: ph.items,
        createdAt: new Date(ph.createdAt),
        reference: ph.reference,
      }));
      await upsert(schema.posHeldInvoices, records);
    }

    // 17. Translations — global (no companyId column), admin-only.
    if (data.translations?.length) {
      if (!isCallerAdmin) {
        skipped.translations = 'caller is not admin';
      } else {
        const records = data.translations.map((t: any) => ({
          id: t.id || t.key,
          key: t.key,
          en: t.en,
          ar: t.ar,
          ur: t.ur,
        }));
        await upsert(schema.translations, records);
      }
    }

    // 18. Warehouses
    if (data.warehouses?.length) {
      const scoped = await scopeAndAuthorizeRecords(schema.warehouses, data.warehouses, { ctx, requiredPermission: 'warehouses.edit', tableName: 'warehouses', skipped });
      const records = scoped.map((w: any) => ({
        id: w.id,
        name: w.name,
        code: w.code,
        address: w.address,
        isActive: w.isActive,
        companyId: w.companyId,
      }));
      await upsert(schema.warehouses, records);
    }

    // 19. Purchase Requisitions & Items
    if (data.purchaseRequisitions?.length) {
      const scoped = await scopeAndAuthorizeRecords(schema.purchaseRequisitions, data.purchaseRequisitions, { ctx, requiredPermission: 'inventory.access', tableName: 'purchaseRequisitions', skipped });
      const prRecords = [];
      const itemRecords = [];
      for (const pr of scoped) {
        prRecords.push({
          id: pr.id,
          prNumber: pr.prNumber,
          requestedBy: pr.requestedBy,
          date: new Date(pr.date),
          status: pr.status,
          notes: pr.notes,
          companyId: pr.companyId,
        });
        if (pr.items?.length) {
          for (const item of pr.items) {
            itemRecords.push({
              id: item.id,
              requisitionId: pr.id,
              productId: item.productId,
              quantity: String(item.quantity),
              purpose: item.purpose,
            });
          }
        }
      }
      await upsert(schema.purchaseRequisitions, prRecords);
      await upsert(schema.purchaseRequisitionItems, itemRecords);
    }

    // 20. Purchase Orders & Items
    if (data.purchaseOrders?.length) {
      const scoped = await scopeAndAuthorizeRecords(schema.purchaseOrders, data.purchaseOrders, { ctx, requiredPermission: 'inventory.access', tableName: 'purchaseOrders', skipped });
      const poRecords = [];
      const itemRecords = [];
      for (const po of scoped) {
        poRecords.push({
          id: po.id,
          poNumber: po.poNumber,
          vendorId: po.vendorId,
          date: new Date(po.date),
          status: po.status,
          requisitionId: po.requisitionId || null,
          deliveryDate: po.deliveryDate ? new Date(po.deliveryDate) : null,
          totalAmount: String(po.totalAmount),
          companyId: po.companyId,
        });
        if (po.items?.length) {
          for (const item of po.items) {
            itemRecords.push({
              id: item.id,
              purchaseOrderId: po.id,
              productId: item.productId,
              quantityOrdered: String(item.quantityOrdered),
              unitPrice: String(item.unitPrice),
              taxRate: String(item.taxRate || 0),
            });
          }
        }
      }
      await upsert(schema.purchaseOrders, poRecords);
      await upsert(schema.purchaseOrderItems, itemRecords);
    }

    // 21. Goods Receipt Notes & Items
    if (data.goodsReceiptNotes?.length) {
      const scoped = await scopeAndAuthorizeRecords(schema.goodsReceiptNotes, data.goodsReceiptNotes, { ctx, requiredPermission: 'inventory.access', tableName: 'goodsReceiptNotes', skipped });
      const grnRecords = [];
      const itemRecords = [];
      for (const grn of scoped) {
        grnRecords.push({
          id: grn.id,
          grnNumber: grn.grnNumber,
          purchaseOrderId: grn.purchaseOrderId || null,
          vendorId: grn.vendorId,
          warehouseId: grn.warehouseId,
          date: new Date(grn.date),
          isDsd: grn.isDsd ?? false,
          receivedBy: grn.receivedBy,
          notes: grn.notes,
          companyId: grn.companyId,
        });
        if (grn.items?.length) {
          for (const item of grn.items) {
            itemRecords.push({
              id: item.id,
              grnId: grn.id,
              productId: item.productId,
              quantityReceived: String(item.quantityReceived),
              unitCost: String(item.unitCost),
              taxRate: item.taxRate !== undefined ? String(item.taxRate) : '0.00',
              batchNumber: item.batchNumber,
              expiryDate: item.expiryDate ? new Date(item.expiryDate) : null,
            });
          }
        }
      }
      await upsert(schema.goodsReceiptNotes, grnRecords);
      await upsert(schema.goodsReceiptNoteItems, itemRecords);
    }

    // 22. Inventory Stocks
    if (data.inventoryStocks?.length) {
      const scoped = await scopeAndAuthorizeRecords(schema.inventoryStocks, data.inventoryStocks, { ctx, requiredPermission: 'inventory.stock', tableName: 'inventoryStocks', skipped });
      const records = scoped.map((s: any) => ({
        id: s.id,
        productId: s.productId,
        warehouseId: s.warehouseId,
        batchNumber: s.batchNumber,
        expiryDate: s.expiryDate ? new Date(s.expiryDate) : null,
        quantity: String(s.quantity),
        companyId: s.companyId,
      }));
      await upsert(schema.inventoryStocks, records);
    }

    // 23. Product Categories
    if (data.productCategories?.length) {
      const scoped = await scopeAndAuthorizeRecords(schema.productCategories, data.productCategories, { ctx, requiredPermission: 'categories.edit', tableName: 'productCategories', skipped });
      const records = scoped.map((c: any) => ({
        id: c.id,
        name: c.name,
        parentCategoryId: c.parentCategoryId || null,
        purchaseGlGroup: c.purchaseGlGroup || null,
        salesGlGroup: c.salesGlGroup || null,
        cogsGlGroup: c.cogsGlGroup || null,
        companyId: c.companyId,
      }));
      await upsert(schema.productCategories, records);
    }

    // 24. Units of Measure
    if (data.unitsOfMeasure?.length) {
      const scoped = await scopeAndAuthorizeRecords(schema.unitsOfMeasure, data.unitsOfMeasure, { ctx, requiredPermission: 'units.edit', tableName: 'unitsOfMeasure', skipped });
      const records = scoped.map((u: any) => ({
        id: u.id,
        name: u.name,
        code: u.code,
        companyId: u.companyId,
      }));
      await upsert(schema.unitsOfMeasure, records);
    }

    // 25. Product Warehouses
    if (data.productWarehouses?.length) {
      const scoped = await scopeAndAuthorizeRecords(schema.productWarehouses, data.productWarehouses, { ctx, requiredPermission: 'products.edit', tableName: 'productWarehouses', skipped });
      const records = scoped.map((pw: any) => ({
        id: pw.id,
        productId: pw.productId,
        warehouseId: pw.warehouseId,
        binLocation: pw.binLocation || null,
        minLevel: pw.minLevel != null ? String(pw.minLevel) : null,
        maxLevel: pw.maxLevel != null ? String(pw.maxLevel) : null,
        reorderLeadTime: pw.reorderLeadTime || null,
        companyId: pw.companyId,
      }));
      await upsert(schema.productWarehouses, records);
    }

    return {
      success: true,
      message: "Full database synchronization to PostgreSQL completed successfully.",
      ...(Object.keys(skipped).length ? { skipped } : {}),
    };
  } catch (error: any) {
    console.error("Migration error:", error);
    const err = new Error(`Migration failed: ${error.message}`);
    (err as any).status = error.status;
    throw err;
  }
}
