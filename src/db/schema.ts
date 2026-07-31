import { relations, sql } from 'drizzle-orm';
import { integer, bigint, pgTable, serial, text, timestamp, boolean, decimal, jsonb, uuid, primaryKey, uniqueIndex, index } from 'drizzle-orm/pg-core';

export const companies = pgTable('companies', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  address: text('address').notNull(),
  phone: text('phone').notNull(),
  email: text('email').notNull(),
  logoUrl: text('logo_url').notNull(),
  customHeader: text('custom_header').notNull(),
  customFooter: text('custom_footer').notNull(),
  vatNumber: text('vat_number'),
  themeId: text('theme_id'),
  currency: text('currency').default('SAR'),
  portalTitle: text('portal_title'),
  portalSubtitle: text('portal_subtitle'),
  counters: jsonb('counters'),
  posSettings: jsonb('pos_settings'),
  isInventoryModuleEnabled: boolean('is_inventory_module_enabled').default(false),
  inventorySettings: jsonb('inventory_settings'),
  // zatcaEnvironment selects which environment is currently active for live invoice
  // processing. Everything else ZATCA-related — including taxpayer registration facts
  // (TIN/CR/address) — lives per-environment in zatcaEnvironmentConfigs below, because
  // Sandbox, Simulation, and Production each require a DIFFERENT taxpayer identity
  // (Sandbox uses ZATCA's published test identity; Simulation/Production require the
  // company's real registration) as well as different credentials. A single shared slot
  // for identity would silently overwrite one environment's data when another was
  // onboarded — the exact bug already fixed once for credentials (ZATCA finding #2).
  zatcaEnvironment: text('zatca_environment').default('sandbox'),
  // Master on/off switch for whether this company's invoices attempt ZATCA submission
  // at all. Defaults false — a brand-new company must NOT silently fire real sandbox
  // submissions before it has completed onboarding (CSID/compliance) for its active
  // environment. Auto-flipped true when that environment's onboarding completes
  // (see server/routes/zatca.ts); can also be toggled manually by a Super Admin.
  zatcaEnabled: boolean('zatca_enabled').default(false),
});

// Per-(company, environment) ZATCA onboarding state — sandbox/simulation/production are
// fully independent identities AND credential sets that never overwrite one another.
// Previously credentials lived here but identity fields lived as a single shared slot on
// `companies`, which meant onboarding one environment with its real taxpayer data would
// silently destroy another's (BACKLOG.md, ZATCA findings #2/#3).
export const zatcaEnvironmentConfigs = pgTable('zatca_environment_configs', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  environment: text('environment').notNull(), // 'sandbox' | 'simulation' | 'production'
  // Taxpayer registration facts — must match what's actually registered with ZATCA for
  // this specific environment (ZATCA's own test identity for sandbox, the company's real
  // registration for simulation/production).
  tinNumber: text('tin_number'),
  crNumber: text('cr_number'),
  streetName: text('street_name'),
  buildingNumber: text('building_number'),
  district: text('district'),
  city: text('city'),
  postalCode: text('postal_code'),
  countryCode: text('country_code').default('SA'),
  businessCategory: text('business_category'),
  ecdsaPrivateKey: text('ecdsa_private_key'),
  complianceCsidCert: text('compliance_csid_cert'),
  complianceCsidSecret: text('compliance_csid_secret'),
  complianceRequestId: text('compliance_request_id'),
  complianceTestsPassedAt: timestamp('compliance_tests_passed_at'),
  productionCsidCert: text('production_csid_cert'),
  productionCsidSecret: text('production_csid_secret'),
  isOnboarded: boolean('is_onboarded').default(false),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  companyIdIdx: index('zatca_env_configs_company_id_idx').on(table.companyId),
  companyEnvUnique: uniqueIndex('zatca_env_configs_company_env_unique').on(table.companyId, table.environment),
}));

// Roles hold one reusable, company-scoped permission set each (e.g. "Sales Rep",
// "Cashier"). Users are assigned one or more roles instead of having permissions
// hand-typed per-account (see the userRoles junction table below) — a user's effective
// permissions are the union (OR, per leaf) of every assigned role's `permissions` JSON.
// See normalizePermissions() in src/types.ts and mergeRolePermissions() in server.ts.
export const roles = pgTable('roles', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  name: text('name').notNull(),
  permissions: jsonb('permissions').notNull().default({}),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  companyIdIdx: index('roles_company_id_idx').on(table.companyId),
  companyNameUnique: uniqueIndex('roles_company_name_unique').on(table.companyId, table.name),
}));

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  uid: text('uid'),
  username: text('username').notNull(),
  password: text('password'),
  role: text('role').notNull(),
  // Every user (including super-admins) is assigned one company — for a super-admin
  // this is just their initial/default selection; isSuperAdmin is what actually grants
  // them the ability to switch to other companies, not the presence of this field.
  companyId: uuid('company_id').notNull().references(() => companies.id),
  isSuperAdmin: boolean('is_super_admin').default(false),
  isActive: boolean('is_active').default(true),
  uiLanguage: text('ui_language').default('en'),
  isDeleted: integer('is_deleted').default(0),
}, (table) => ({
  companyIdIdx: index('users_company_id_idx').on(table.companyId),
}));

// Many-to-many: a user can hold multiple roles at once. Effective permissions are the
// per-leaf OR/union of every assigned role — a user can legitimately have the same page
// granted by more than one role; that just renders once (union, not duplicated).
export const userRoles = pgTable('user_roles', {
  userId: uuid('user_id').notNull().references(() => users.id),
  roleId: uuid('role_id').notNull().references(() => roles.id),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.roleId] }),
  userIdIdx: index('user_roles_user_id_idx').on(table.userId),
  roleIdIdx: index('user_roles_role_id_idx').on(table.roleId),
}));

// NOTE: the per-environment zatcaEnvironmentConfigs table (splitting sandbox/simulation/
// production into independent credential rows) is Phase VI-A scope — added when that
// phase starts, not here. Phase V is ID-type migration only.

export const documentTemplates = pgTable('document_templates', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  language: text('language').notNull(),
  pageSize: text('page_size').notNull(),
  isActive: boolean('is_active').default(true),
  printHeader: boolean('print_header').default(true),
  printFooter: boolean('print_footer').default(true),
  printLogo: boolean('print_logo').default(true),
  printQrCode: boolean('print_qr_code').default(true),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  layoutJson: text('layout_json'),
  // Previously editable in the Canvas Designer (AdminSettings.tsx) but never actually
  // had a column here — the UI showed the change optimistically, but src/db/migrateData.ts's
  // upsert only ever wrote a fixed whitelist of fields that didn't include these two, so
  // every "Global Row Gap"/"Global Font Family" choice silently reverted on the next reload.
  gridGapY: text('grid_gap_y'),
  globalFontFamily: text('global_font_family'),
}, (table) => ({
  unique_active_template: uniqueIndex('unique_active_template').on(table.companyId, table.language).where(sql`is_active = true`),
}));

export const taxSlabs = pgTable('tax_slabs', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  percentage: decimal('percentage', { precision: 5, scale: 2 }).notNull(),
  // Nullable: existing/legacy rows with companyId = NULL are treated as shared
  // defaults visible to every company; new tax slabs created going forward are
  // scoped to the creating company.
  companyId: uuid('company_id').references(() => companies.id),
}, (table) => ({
  companyIdIdx: index('tax_slabs_company_id_idx').on(table.companyId),
}));

export const productCategories = pgTable('product_categories', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  parentCategoryId: uuid('parent_category_id'), // hierarchical capability; no formal FK (self-reference), nullable
  purchaseGlGroup: text('purchase_gl_group'), // e.g. '1200 - Inventory Asset' (Asset/Clearing)
  salesGlGroup: text('sales_gl_group'),       // e.g. '4000 - Product Sales' (Revenue)
  cogsGlGroup: text('cogs_gl_group'),         // e.g. '5000 - Cost of Goods Sold' (Expense)
  companyId: uuid('company_id').notNull().references(() => companies.id),
}, (table) => ({
  parentCategoryFk: index('product_categories_parent_idx').on(table.parentCategoryId),
}));

export const warehouses = pgTable('warehouses', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  code: text('code').notNull(), // Unique warehouse code
  address: text('address'),
  isActive: boolean('is_active').default(true),
  companyId: uuid('company_id').notNull().references(() => companies.id),
}, (table) => ({
  companyIdx: index('warehouses_company_idx').on(table.companyId),
}));

export const productsServices = pgTable('products_services', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  unitPrice: decimal('unit_price', { precision: 12, scale: 2 }).notNull(),
  type: text('type').notNull(), // 'item' or 'service'
  unit: text('unit'),
  isPosItem: boolean('is_pos_item').default(false),
  category: text('category'),
  categoryId: uuid('category_id').references(() => productCategories.id),
  base64Image: text('base64_image'),
  barcode: text('barcode'),
  sku: text('sku'),
  defaultWarehouseId: uuid('default_warehouse_id').references(() => warehouses.id),
  binLocation: text('bin_location'),
  minLevel: decimal('min_level', { precision: 12, scale: 3 }),
  maxLevel: decimal('max_level', { precision: 12, scale: 3 }),
  reorderLeadTime: text('reorder_lead_time'),
  companyId: uuid('company_id').notNull().references(() => companies.id),
}, (table) => ({
  companyIdIdx: index('products_services_company_id_idx').on(table.companyId),
}));

export const customers = pgTable('customers', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  phone: text('phone').notNull(),
  email: text('email').notNull(),
  address: text('address').notNull(),
  taxRegNumber: text('tax_reg_number'),
  isSystem: boolean('is_system').default(false),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  // ZATCA Buyer Fields
  buyerType: text('buyer_type').default('B2B'),
  vatNumber: text('vat_number'),
  buildingNumber: text('building_number'),
  streetName: text('street_name'),
  district: text('district'),
  city: text('city'),
  postalCode: text('postal_code'),
  countryCode: text('country_code').default('SA'),
}, (table) => ({
  companyIdIdx: index('customers_company_id_idx').on(table.companyId),
}));

export const vendors = pgTable('vendors', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  phone: text('phone').notNull(),
  email: text('email').notNull(),
  address: text('address').notNull(),
  taxRegNumber: text('tax_reg_number'),
  isSystem: boolean('is_system').default(false),
  apGlAccount: text('ap_gl_account'), // e.g., '2100 - Accounts Payable'
  companyId: uuid('company_id').notNull().references(() => companies.id),
  // ZATCA Address Fields
  buyerType: text('buyer_type').default('B2B'),
  vatNumber: text('vat_number'),
  buildingNumber: text('building_number'),
  streetName: text('street_name'),
  district: text('district'),
  city: text('city'),
  postalCode: text('postal_code'),
  countryCode: text('country_code').default('SA'),
}, (table) => ({
  companyIdIdx: index('vendors_company_id_idx').on(table.companyId),
}));

export const bankAccounts = pgTable('bank_accounts', {
  id: uuid('id').primaryKey(),
  bankName: text('bank_name').notNull(),
  accountNumber: text('account_number').notNull(),
  accountTitle: text('account_title').notNull(),
  openingBalance: decimal('opening_balance', { precision: 14, scale: 2 }).notNull(),
  isActive: boolean('is_active').default(true),
  isDefault: boolean('is_default').default(false),
  companyId: uuid('company_id').notNull().references(() => companies.id),
}, (table) => ({
  unique_default_bank: uniqueIndex('unique_default_bank').on(table.companyId).where(sql`is_default = true`),
  companyIdIdx: index('bank_accounts_company_id_idx').on(table.companyId),
}));

// Fiscal months use a semantic "YYYY-MM" string as their id (e.g. "2026-07"), not a
// generated entity id — intentionally excluded from the UUID migration.
export const fiscalMonths = pgTable('fiscal_months', {
  id: text('id').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull(),
  closedAt: timestamp('closed_at'),
  closedOption: text('closed_option'),
  closedPnL: jsonb('closed_pnl'),
  companyId: uuid('company_id').notNull().references(() => companies.id),
}, (table) => ({
  pk: primaryKey({ columns: [table.id, table.companyId] }),
}));

export const quotations = pgTable('quotations', {
  id: uuid('id').primaryKey(),
  quotationNumber: text('quotation_number').notNull(),
  date: text('date').notNull(),
  customerId: uuid('customer_id').references(() => customers.id).notNull(),
  taxSlabId: uuid('tax_slab_id').references(() => taxSlabs.id).notNull(),
  notes: text('notes').notNull(),
  status: text('status').notNull(),
  createdById: uuid('created_by_id').references(() => users.id).notNull(),
  createdAt: timestamp('created_at').notNull(),
  discountPercentage: decimal('discount_percentage', { precision: 5, scale: 2 }),
  companyId: uuid('company_id').notNull().references(() => companies.id),
}, (table) => ({
  companyIdIdx: index('quotations_company_id_idx').on(table.companyId),
}));

export const quotationItems = pgTable('quotation_items', {
  id: uuid('id').primaryKey(),
  quotationId: uuid('quotation_id').references(() => quotations.id).notNull(),
  description: text('description').notNull(),
  unitCost: decimal('unit_cost', { precision: 12, scale: 2 }).notNull(),
  quantity: decimal('quantity', { precision: 10, scale: 2 }).notNull(),
  discountAmount: decimal('discount_amount', { precision: 12, scale: 2 }),
});

export const posShifts = pgTable('pos_shifts', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  startTime: timestamp('start_time').notNull(),
  endTime: timestamp('end_time'),
  startCash: decimal('start_cash', { precision: 14, scale: 2 }).notNull(),
  endCash: decimal('end_cash', { precision: 14, scale: 2 }),
  expectedCash: decimal('expected_cash', { precision: 14, scale: 2 }),
  status: text('status').notNull(), // 'open' | 'closed'
  notes: text('notes'),
  isPosSale: boolean('is_pos_sale').default(false),
  attachmentUrl: text('attachment_url'),
}, (table) => ({
  companyIdIdx: index('pos_shifts_company_id_idx').on(table.companyId),
}));

export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey(),
  invoiceNumber: text('invoice_number').notNull(),
  date: text('date').notNull(),
  customerId: uuid('customer_id').references(() => customers.id).notNull(),
  taxSlabId: uuid('tax_slab_id').references(() => taxSlabs.id).notNull(),
  bankId: uuid('bank_id').references(() => bankAccounts.id).notNull(),
  paymentStatus: text('payment_status').notNull(),
  paymentDate: timestamp('payment_date'),
  notes: text('notes').notNull(),
  status: text('status').notNull(),
  createdById: uuid('created_by_id').references(() => users.id).notNull(),
  createdAt: timestamp('created_at').notNull(),
  originQuotationId: uuid('origin_quotation_id').references(() => quotations.id),
  discountPercentage: decimal('discount_percentage', { precision: 5, scale: 2 }),
  amountPaid: decimal('amount_paid', { precision: 14, scale: 2 }),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  isPosSale: boolean('is_pos_sale').default(false),
  shiftId: uuid('shift_id').references(() => posShifts.id),
  attachmentUrl: text('attachment_url'),
  // ZATCA Fields
  invoiceTypeCode: text('invoice_type_code').default('388'), // '388' for Standard B2B, '0200000' for Simplified B2C
  uuid: text('uuid'),
  icv: integer('icv').default(0),
  previousInvoiceHash: text('previous_invoice_hash'),
  currentInvoiceHash: text('current_invoice_hash'),
  xmlContent: text('xml_content'),
  qrCodeContent: text('qr_code_content'),
  zatcaStatus: text('zatca_status').default('NOT_SUBMITTED'),
  zatcaValidationResults: jsonb('zatca_validation_results'),
  clearanceTimestamp: timestamp('clearance_timestamp'),
  // Credit/Debit Note support — reuses this same table/counter/hash-chain/print pipeline
  // rather than a parallel schema, since ZATCA's Credit/Debit Note documents are the
  // same UBL Invoice-2 XML shape (confirmed against the ZATCA SDK's own bundled sample
  // Credit/Debit Note XMLs) and must participate in the SAME per-company ICV/PIH chain
  // as regular invoices, not a separate one.
  documentType: text('document_type').notNull().default('Invoice'), // 'Invoice' | 'CreditNote' | 'DebitNote'
  originalInvoiceId: uuid('original_invoice_id').references((): any => invoices.id),
  creditNoteReason: text('credit_note_reason'),
}, (table) => ({
  companyIdIdx: index('invoices_company_id_idx').on(table.companyId),
}));

export const invoiceItems = pgTable('invoice_items', {
  id: uuid('id').primaryKey(),
  invoiceId: uuid('invoice_id').references(() => invoices.id).notNull(),
  description: text('description').notNull(),
  unitCost: decimal('unit_cost', { precision: 12, scale: 2 }).notNull(),
  quantity: decimal('quantity', { precision: 10, scale: 2 }).notNull(),
  discountAmount: decimal('discount_amount', { precision: 12, scale: 2 }),
  // Nullable: falls back to the invoice's header taxSlabId when not set, so every line
  // isn't forced onto one shared rate. The client (dbStore.ts's calculateInvoiceTotals)
  // already computed per-line tax this way; the server previously discarded it and
  // silently re-taxed every line at the header rate instead — this column is what makes
  // that fix real rather than cosmetic (per-line rate has somewhere to actually live).
  taxSlabId: uuid('tax_slab_id').references(() => taxSlabs.id),
});

export const expenses = pgTable('expenses', {
  id: uuid('id').primaryKey(),
  expenseNumber: text('expense_number').notNull(),
  date: text('date').notNull(),
  vendorId: uuid('vendor_id').references(() => vendors.id).notNull(),
  taxSlabId: uuid('tax_slab_id').references(() => taxSlabs.id).notNull(),
  bankId: uuid('bank_id').references(() => bankAccounts.id).notNull(),
  paymentStatus: text('payment_status').notNull(),
  paymentDate: timestamp('payment_date'),
  description: text('description').notNull(),
  amount: decimal('amount', { precision: 14, scale: 2 }).notNull(),
  status: text('status').notNull(),
  type: text('type').notNull(),
  originAccrualId: uuid('origin_accrual_id'),
  accrualSettled: boolean('accrual_settled'),
  settledExpenseId: uuid('settled_expense_id'),
  createdById: uuid('created_by_id').references(() => users.id).notNull(),
  createdAt: timestamp('created_at').notNull(),
  classification: text('classification'),
  assetType: text('asset_type'),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  amountPaid: decimal('amount_paid', { precision: 14, scale: 2 }),
  isPosSale: boolean('is_pos_sale').default(false),
  shiftId: uuid('shift_id').references(() => posShifts.id),
  attachmentUrl: text('attachment_url'),
}, (table) => ({
  companyIdIdx: index('expenses_company_id_idx').on(table.companyId),
  originAccrualFk: index('expenses_origin_accrual_idx').on(table.originAccrualId),
}));

export const expenseItems = pgTable('expense_items', {
  id: uuid('id').primaryKey(),
  expenseId: uuid('expense_id').references(() => expenses.id).notNull(),
  description: text('description').notNull(),
  unitCost: decimal('unit_cost', { precision: 12, scale: 2 }).notNull(),
  quantity: decimal('quantity', { precision: 10, scale: 2 }).notNull(),
});

export const recurringExpenseTemplates = pgTable('recurring_expense_templates', {
  id: uuid('id').primaryKey(),
  description: text('description').notNull(),
  vendorId: uuid('vendor_id').references(() => vendors.id).notNull(),
  defaultAmount: decimal('default_amount', { precision: 14, scale: 2 }).notNull(),
  taxSlabId: uuid('tax_slab_id').references(() => taxSlabs.id).notNull(),
  isActive: boolean('is_active').default(true),
  bankId: uuid('bank_id').references(() => bankAccounts.id).notNull(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
}, (table) => ({
  companyIdIdx: index('rec_exp_temp_company_id_idx').on(table.companyId),
}));

// monthId uses the same semantic "YYYY-MM" string as fiscalMonths.id — not a generated
// entity id, intentionally excluded from the UUID migration.
export const recurringPostings = pgTable('recurring_postings', {
  id: uuid('id').primaryKey(),
  templateId: uuid('template_id').notNull().references(() => recurringExpenseTemplates.id),
  monthId: text('month_id').notNull(),
  status: text('status').notNull(),
  expenseId: uuid('expense_id').references(() => expenses.id),
  companyId: uuid('company_id').notNull().references(() => companies.id),
}, (table) => ({
  companyIdIdx: index('rec_post_company_id_idx').on(table.companyId),
  templateMonthUnique: uniqueIndex('rec_post_template_month_unique').on(table.templateId, table.monthId, table.companyId),
}));

export const vouchers = pgTable('vouchers', {
  id: uuid('id').primaryKey(),
  voucherNumber: text('voucher_number').notNull(),
  type: text('type').notNull(),
  date: text('date').notNull(),
  bankId: uuid('bank_id').notNull().references(() => bankAccounts.id),
  amount: decimal('amount', { precision: 14, scale: 2 }).notNull(),
  description: text('description').notNull(),
  referenceType: text('reference_type').notNull(),
  // Polymorphic — points at a quotation/invoice/expense/etc row depending on
  // referenceType, so it can't carry a single-table FK constraint.
  referenceId: uuid('reference_id').notNull(),
  createdById: uuid('created_by_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at').notNull(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  isPosSale: boolean('is_pos_sale').default(false),
  shiftId: uuid('shift_id').references(() => posShifts.id),
  attachmentUrl: text('attachment_url'),
}, (table) => ({
  companyIdIdx: index('vouchers_company_id_idx').on(table.companyId),
  referenceIdIdx: index('vouchers_reference_id_idx').on(table.referenceId),
}));

export const investors = pgTable('investors', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  phone: text('phone').notNull(),
  equityPercentage: decimal('equity_percentage', { precision: 5, scale: 2 }).notNull(),
  profitPercentage: decimal('profit_percentage', { precision: 5, scale: 2 }),
  capitalContributed: decimal('capital_contributed', { precision: 14, scale: 2 }).notNull(),
  isActive: boolean('is_active').default(true),
  notes: text('notes'),
  createdAt: timestamp('created_at').notNull(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
}, (table) => ({
  companyIdIdx: index('investors_company_id_idx').on(table.companyId),
}));

export const translations = pgTable('translations', {
  id: uuid('id').primaryKey(),
  key: text('key').notNull(),
  en: text('en').notNull(),
  ar: text('ar').notNull(),
  ur: text('ur').notNull(),
});

export const posHeldInvoices = pgTable('pos_held_invoices', {
  id: uuid('id').primaryKey(),
  shiftId: uuid('shift_id').references(() => posShifts.id).notNull(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  customerId: uuid('customer_id').references(() => customers.id),
  items: jsonb('items').notNull(),
  createdAt: timestamp('created_at').notNull(),
  reference: text('reference').notNull(),
}, (table) => ({
  companyIdIdx: index('pos_held_inv_company_id_idx').on(table.companyId),
}));

// Owned by the `connect-pg-simple` session-store library, not app-generated —
// intentionally excluded from the UUID migration.
export const user_sessions = pgTable('user_sessions', {
  sid: text('sid').primaryKey(),
  sess: jsonb('sess').notNull(),
  expire: timestamp('expire', { precision: 6, mode: 'date' }).notNull(),
});

// Pure append-only log table — no benefit from unguessable/client-generated ids and
// everything to gain from fast sequential appends at high volume, so this uses a native
// auto-increment bigint instead of a UUID (the one deliberate exception to the rest of
// the schema's PK convention — see BACKLOG.md).
export const auditLogs = pgTable('audit_logs', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  companyId: uuid('company_id').references(() => companies.id),
  userId: uuid('user_id').references(() => users.id),
  username: text('username').notNull(),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  // Polymorphic — points at whatever row entityType names, so it can't carry a
  // single-table FK constraint.
  entityId: uuid('entity_id'),
  details: text('details'),
  ipAddress: text('ip_address'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  companyIdIdx: index('audit_logs_company_id_idx').on(table.companyId),
  userIdIdx: index('audit_logs_user_id_idx').on(table.userId),
  createdAtIdx: index('audit_logs_created_at_idx').on(table.createdAt),
}));

// 2. Inventory Stock State (Tracks current qty per warehouse, batch, lot)
export const inventoryStocks = pgTable('inventory_stocks', {
  id: uuid('id').primaryKey(),
  productId: uuid('product_id').notNull().references(() => productsServices.id),
  warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
  batchNumber: text('batch_number'),
  expiryDate: timestamp('expiry_date'),
  quantity: decimal('quantity', { precision: 12, scale: 3 }).default('0.000').notNull(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
}, (table) => ({
  prodWhIdx: index('inv_stock_prod_wh_idx').on(table.productId, table.warehouseId),
  companyIdx: index('inv_stock_company_idx').on(table.companyId),
}));

// 2c. Units of Measure Table
export const unitsOfMeasure = pgTable('units_of_measure', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(), // e.g., 'Piece', 'Box'
  code: text('code').notNull(), // e.g., 'Pcs', 'Box'
  companyId: uuid('company_id').notNull().references(() => companies.id),
});

// 2d. Product-Warehouse Junction Table
export const productWarehouses = pgTable('product_warehouses', {
  id: uuid('id').primaryKey(),
  productId: uuid('product_id').notNull().references(() => productsServices.id),
  warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
  binLocation: text('bin_location'),
  minLevel: decimal('min_level', { precision: 12, scale: 3 }).default('0.000'),
  maxLevel: decimal('max_level', { precision: 12, scale: 3 }).default('0.000'),
  reorderLeadTime: text('reorder_lead_time'), // e.g., "3 days"
  companyId: uuid('company_id').notNull().references(() => companies.id),
});

// 3. GL Group Mappings for Products/Categories
export const glGroupMappings = pgTable('gl_group_mappings', {
  id: uuid('id').primaryKey(),
  entityType: text('entity_type').notNull(), // 'product' or 'category'
  // Polymorphic (Product or Category depending on entityType) — no single-table FK.
  entityId: uuid('entity_id').notNull(),
  purchaseGlGroup: text('purchase_gl_group').notNull(), // e.g. '1200 - Inventory Asset'
  salesGlGroup: text('sales_gl_group').notNull(),       // e.g. '4000 - Product Sales'
  cogsGlGroup: text('cogs_gl_group').notNull(),         // e.g. '5000 - Cost of Goods Sold'
  companyId: uuid('company_id').notNull().references(() => companies.id),
});

// 4. Purchase Requisitions (PR)
export const purchaseRequisitions = pgTable('purchase_requisitions', {
  id: uuid('id').primaryKey(),
  prNumber: text('pr_number').notNull(),
  requestedBy: text('requested_by').notNull(), // User ID or Name (loosely typed by design) — stays text
  date: timestamp('date').notNull(),
  status: text('status').default('Draft').notNull(), // 'Draft', 'Pending', 'Approved', 'Rejected', 'Closed'
  notes: text('notes'),
  companyId: uuid('company_id').notNull().references(() => companies.id),
});

export const purchaseRequisitionItems = pgTable('purchase_requisition_items', {
  id: uuid('id').primaryKey(),
  requisitionId: uuid('requisition_id').notNull().references(() => purchaseRequisitions.id),
  productId: uuid('product_id').notNull().references(() => productsServices.id),
  quantity: decimal('quantity', { precision: 12, scale: 3 }).notNull(),
  purpose: text('purpose'),
});

// 5. Purchase Orders (PO)
export const purchaseOrders = pgTable('purchase_orders', {
  id: uuid('id').primaryKey(),
  poNumber: text('po_number').notNull(),
  vendorId: uuid('vendor_id').notNull().references(() => vendors.id),
  date: timestamp('date').notNull(),
  status: text('status').default('Draft').notNull(), // 'Draft', 'Sent', 'Partially Received', 'Received', 'Cancelled'
  requisitionId: uuid('requisition_id').references(() => purchaseRequisitions.id), // Optional link to PR
  deliveryDate: timestamp('delivery_date'),
  totalAmount: decimal('total_amount', { precision: 12, scale: 2 }).notNull(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
});

export const purchaseOrderItems = pgTable('purchase_order_items', {
  id: uuid('id').primaryKey(),
  purchaseOrderId: uuid('purchase_order_id').notNull().references(() => purchaseOrders.id),
  productId: uuid('product_id').notNull().references(() => productsServices.id),
  quantityOrdered: decimal('quantity_ordered', { precision: 12, scale: 3 }).notNull(),
  unitPrice: decimal('unit_price', { precision: 12, scale: 2 }).notNull(),
  taxRate: decimal('tax_rate', { precision: 5, scale: 2 }).default('0.00'),
});

// 6. Goods Receipt Notes (GRN)
export const goodsReceiptNotes = pgTable('goods_receipt_notes', {
  id: uuid('id').primaryKey(),
  grnNumber: text('grn_number').notNull(),
  purchaseOrderId: uuid('purchase_order_id').references(() => purchaseOrders.id), // Nullable for DSD (Direct Shop Delivery)
  vendorId: uuid('vendor_id').notNull().references(() => vendors.id),
  warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
  date: timestamp('date').notNull(),
  isDsd: boolean('is_dsd').default(false).notNull(), // Flag for Direct Shop Delivery
  receivedBy: text('received_by').notNull(), // User ID or Name (loosely typed by design) — stays text
  notes: text('notes'),
  companyId: uuid('company_id').notNull().references(() => companies.id),
});

export const goodsReceiptNoteItems = pgTable('goods_receipt_note_items', {
  id: uuid('id').primaryKey(),
  grnId: uuid('grn_id').notNull().references(() => goodsReceiptNotes.id),
  productId: uuid('product_id').notNull().references(() => productsServices.id),
  quantityReceived: decimal('quantity_received', { precision: 12, scale: 3 }).notNull(),
  unitCost: decimal('unit_cost', { precision: 12, scale: 2 }).notNull(),
  taxRate: decimal('tax_rate', { precision: 5, scale: 2 }).default('0.00'),
  batchNumber: text('batch_number'),
  expiryDate: timestamp('expiry_date'),
});

// 7. Purchase Bills / Invoices
export const purchaseBills = pgTable('purchase_bills', {
  id: uuid('id').primaryKey(),
  billNumber: text('bill_number').notNull(),
  vendorId: uuid('vendor_id').notNull().references(() => vendors.id),
  date: timestamp('date').notNull(),
  dueDate: timestamp('due_date'),
  grnIds: text('grn_ids').notNull(), // Comma-separated or JSON list of referenced GRNs — multi-value, stays text
  subTotal: decimal('sub_total', { precision: 12, scale: 2 }).notNull(),
  taxTotal: decimal('tax_total', { precision: 12, scale: 2 }).notNull(),
  grandTotal: decimal('grand_total', { precision: 12, scale: 2 }).notNull(),
  status: text('status').default('Unpaid').notNull(), // 'Unpaid', 'Partially Paid', 'Paid'
  companyId: uuid('company_id').notNull().references(() => companies.id),
});

// 8. Purchase Returns (Debit Notes)
export const purchaseReturns = pgTable('purchase_returns', {
  id: uuid('id').primaryKey(),
  returnNumber: text('return_number').notNull(),
  grnId: uuid('grn_id').notNull().references(() => goodsReceiptNotes.id), // Links back to receipt
  vendorId: uuid('vendor_id').notNull().references(() => vendors.id),
  warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
  date: timestamp('date').notNull(),
  notes: text('notes'),
  companyId: uuid('company_id').notNull().references(() => companies.id),
});

export const purchaseReturnItems = pgTable('purchase_return_items', {
  id: uuid('id').primaryKey(),
  returnId: uuid('return_id').notNull().references(() => purchaseReturns.id),
  productId: uuid('product_id').notNull().references(() => productsServices.id),
  quantityReturned: decimal('quantity_returned', { precision: 12, scale: 3 }).notNull(),
  batchNumber: text('batch_number'),
});

// 9. Physical Stock Takes
export const physicalStockTakes = pgTable('physical_stock_takes', {
  id: uuid('id').primaryKey(),
  referenceNumber: text('reference_number').notNull(),
  warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
  date: timestamp('date').notNull(),
  status: text('status').default('Draft').notNull(), // 'Draft', 'Completed' (Adjustments Posted)
  performedBy: text('performed_by').notNull(), // User ID or Name (loosely typed by design) — stays text
  notes: text('notes'),
  companyId: uuid('company_id').notNull().references(() => companies.id),
});

export const physicalStockTakeItems = pgTable('physical_stock_take_items', {
  id: uuid('id').primaryKey(),
  stockTakeId: uuid('stock_take_id').notNull().references(() => physicalStockTakes.id),
  productId: uuid('product_id').notNull().references(() => productsServices.id),
  batchNumber: text('batch_number'),
  systemQuantity: decimal('system_quantity', { precision: 12, scale: 3 }).notNull(),
  physicalQuantity: decimal('physical_quantity', { precision: 12, scale: 3 }).notNull(),
  variance: decimal('variance', { precision: 12, scale: 3 }).notNull(),
});

// 10. Stock Ledger / Transaction Log (audit trail for all movements)
export const stockLedgerTransactions = pgTable('stock_ledger_transactions', {
  id: uuid('id').primaryKey(),
  productId: uuid('product_id').notNull().references(() => productsServices.id),
  warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
  transactionType: text('transaction_type').notNull(), // 'GRN', 'Return', 'Sale', 'Adjustment', 'StockTake'
  // Polymorphic (GRN/Sale/Adjustment/etc depending on transactionType) — no single-table FK.
  referenceId: uuid('reference_id').notNull(),
  date: timestamp('date').notNull(),
  quantityChange: decimal('quantity_change', { precision: 12, scale: 3 }).notNull(), // positive or negative
  endingQuantity: decimal('ending_quantity', { precision: 12, scale: 3 }).notNull(),
  batchNumber: text('batch_number'),
  companyId: uuid('company_id').notNull().references(() => companies.id),
});
