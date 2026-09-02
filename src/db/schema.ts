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
  // General, print-facing Commercial Registration number — deliberately separate from
  // zatcaEnvironmentConfigs.crNumber (per-environment, technical, and for Sandbox can hold
  // ZATCA's own shared fake test CR — see the sandbox sample-key adoption in
  // server/routes/zatca.ts). Same reasoning this table already applies to vatNumber above.
  crNumber: text('cr_number'),
  themeId: text('theme_id'),
  currency: text('currency').default('SAR'),
  portalTitle: text('portal_title'),
  portalSubtitle: text('portal_subtitle'),
  counters: jsonb('counters'),
  // Per-company, per-document-type number formatting (prefix/separator/padding/branch-code
  // display/reset frequency). Unstructured JSONB, keyed by DOCUMENT_TYPE_REGISTRY's `key`
  // (server/lib/documentNumbering.ts) — absent key or absent field means "use that type's
  // registry default," which is what makes every existing company (numberingPolicy: null)
  // produce byte-identical output to the old hardcoded template. Purely a display/formatting
  // concern — the actual sequential count lives in documentCounters below, and this column
  // has no relationship to ZATCA's ICV/PIH chain (zatcaChainState), which is the only
  // mechanism ZATCA's sequential-integrity requirement actually depends on.
  numberingPolicy: jsonb('numbering_policy'),
  posSettings: jsonb('pos_settings'),
  isInventoryModuleEnabled: boolean('is_inventory_module_enabled').default(false),
  inventorySettings: jsonb('inventory_settings'),
  // { employeeNumberPadWidth?: 4 | 5, employeeNumberStart?: number } — see
  // server/lib/employeeNumbering.ts. padWidth defaults to 4 when absent; start only
  // matters the first time this company's employee counter is ever created (lets a
  // company migrating from another HRIS continue an existing numbering sequence instead
  // of restarting at 1). Same unstructured-JSONB-settings convention as posSettings/
  // inventorySettings above.
  hrSettings: jsonb('hr_settings'),
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
  // Nullable at the DB level so existing accounts and every test fixture that inserts a
  // user row directly (bypassing the real create-user route) keep working unchanged —
  // "mandatory" is enforced at the application layer instead: POST/PATCH /api/users (the
  // real account-creation path) requires it. See BACKLOG.md for the forgot-password
  // feature this exists for — a reset link only ever gets sent when this is set.
  email: text('email'),
  role: text('role').notNull(),
  // Every user (including super-admins) is assigned one company — for a super-admin
  // this is just their initial/default selection; isSuperAdmin is what actually grants
  // them the ability to switch to other companies, not the presence of this field.
  companyId: uuid('company_id').notNull().references(() => companies.id),
  isSuperAdmin: boolean('is_super_admin').default(false),
  isActive: boolean('is_active').default(true),
  uiLanguage: text('ui_language').default('en'),
  isDeleted: integer('is_deleted').default(0),
  // Nullable at the DB level for the same reason `email` above is — every account that
  // predates this feature has none, and test fixtures inserting directly must keep
  // working. "Mandatory" is an application-layer rule instead: POST /api/users requires
  // this for a genuinely NEW account once the company has onboarded at least one active
  // employee (server/routes/users.ts) — mirrors the exact "mandatory once the company has
  // adopted X" pattern already used for warehouses requiring a branch once one exists.
  // See employees table's own comment for why this FK only ever points one direction.
  employeeId: uuid('employee_id').references(() => employees.id),
}, (table) => ({
  companyIdIdx: index('users_company_id_idx').on(table.companyId),
  emailIdx: index('users_email_idx').on(table.email),
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
  // Every tax slab belongs to exactly one company — there is no shared/global concept
  // (deliberately removed: a nullable companyId here previously meant "shared defaults
  // visible to every company," but the generic bulk-sync path couldn't distinguish a
  // client merely holding a read-only cached copy of those shared rows from a genuine
  // intent to modify them, and silently reassigned shared rows' ownership to whichever
  // company happened to sync next — confirmed live, corrupting the shared VAT/Exempt
  // slabs at least twice). Every company now owns its own complete set.
  companyId: uuid('company_id').notNull().references(() => companies.id),
  // Per-company default — different companies genuinely need different defaults
  // (e.g. a company dealing mostly in zero-rated exports vs. one on standard 15%
  // domestic VAT). Previously every document form (Quotation/Invoice/Expense/POS)
  // each guessed a default independently via its own ad-hoc heuristic (find a 0%
  // slab, or hardcode-search for "the 15% one"), which silently produced the wrong
  // default per company and drifted out of sync across forms. Same partial-unique-
  // index pattern as bankAccounts.isDefault: at most one default per company.
  isDefault: boolean('is_default').default(false),
  // ZATCA requires a TaxExemptionReasonCode/TaxExemptionReason on any Exempt ('E') or
  // Zero-rated ('Z') tax category (BR-KSA-23 and related) — the specific VATEX-SA-xx code
  // is a real legal classification (financial services, real estate, exports, etc. each
  // have a different one under Saudi VAT law) that genuinely varies per company and can't
  // be safely guessed here; both nullable so an unconfigured slab keeps today's behavior
  // (the existing BR-KSA-23 warning, not a fabricated/incorrect code) until an admin sets
  // the real reason for their specific exempt/zero-rated items.
  exemptionReasonCode: text('exemption_reason_code'),
  exemptionReason: text('exemption_reason'),
}, (table) => ({
  companyIdIdx: index('tax_slabs_company_id_idx').on(table.companyId),
  unique_default_tax_slab: uniqueIndex('unique_default_tax_slab').on(table.companyId).where(sql`is_default = true`),
}));

export const productCategories = pgTable('product_categories', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  parentCategoryId: uuid('parent_category_id'), // hierarchical capability; no formal FK (self-reference), nullable
  purchaseGlGroup: text('purchase_gl_group'), // e.g. '1200 - Inventory Asset' (Asset/Clearing)
  salesGlGroup: text('sales_gl_group'),       // e.g. '4000 - Product Sales' (Revenue)
  cogsGlGroup: text('cogs_gl_group'),         // e.g. '5000 - Cost of Goods Sold' (Expense)
  isActive: boolean('is_active').default(true),
  // POS presentation only — deliberately reusing this same accounting category rather
  // than a second "POS category" concept, since in practice they're almost always the
  // same groupings (e.g. "Coffee", "Bakery"). None of these three affect GL mapping.
  posTabColor: text('pos_tab_color'), // nullable hex; null falls back to the brand accent
  posTabOrder: integer('pos_tab_order'), // nullable; lower shows first, null sorts last (alphabetically)
  showOnPosTabs: boolean('show_on_pos_tabs').default(true), // lets an internal/accounting-only category opt out of the cashier's tab strip
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
  // Nullable — GRN/Purchase Returns/Physical Stock Takes already carry a warehouseId,
  // so their branch is DERIVED via this join rather than storing a second, independently-
  // driftable branchId directly on each of those tables (see BACKLOG item 77's plan).
  branchId: uuid('branch_id').references(() => branches.id),
  // 'sales': a front-of-house/location warehouse a sale can be attributed to and deducted
  // from. 'backend': a distribution/storage warehouse (e.g. a central DC feeding several
  // branches) that receives stock but is never itself a sale's source — enforced server-side
  // (assertSalesWarehouse in businessLogic.ts), not just a UI convention. Defaults to
  // 'sales' so every pre-existing warehouse keeps behaving exactly as it did before this
  // column existed (any warehouse could be sold from).
  type: text('type').notNull().default('sales'), // 'sales' | 'backend'
  // The one warehouse a sale falls back to when its branch has no defaultWarehouseId of
  // its own (or the invoice has no branch at all) — see branches.defaultWarehouseId's
  // comment for the two-tier resolution order. Must be a 'sales'-type warehouse; enforced
  // in the warehouse upsert route, not just here.
  isCompanyDefault: boolean('is_company_default').default(false),
}, (table) => ({
  companyIdx: index('warehouses_company_idx').on(table.companyId),
  uniqueCompanyDefault: uniqueIndex('warehouses_company_default_unique').on(table.companyId).where(sql`is_company_default = true`),
}));

// A physical location under one company (Riyadh, Jeddah, ...) — company-wide config
// (tax slabs, product catalog, templates, roles) stays shared across all of a company's
// branches; only transactional documents and the ZATCA seller address get scoped/
// overridden per branch. Branch *creation* is deliberately not permission-gated at all
// (see server/routes/branches.ts) — it's a licensing decision, hardcoded to super-admin
// only, mirroring how POST /api/companies itself is gated. The address fields here are
// used to override the seller's PostalAddress on this branch's invoices' ZATCA XML,
// falling back per-field to the company's zatcaEnvironmentConfigs address when a branch
// hasn't set its own (see processInvoiceZatca in server/lib/zatca/processInvoice.ts).
export const branches = pgTable('branches', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  name: text('name').notNull(),
  // Short code embedded in a future branch-scoped document-numbering scheme (e.g. the
  // 'JED' in INV-JED-1042) — not yet wired into numbering itself, which stays the
  // existing company-wide sequence until that phase lands; kept here now so the column
  // exists once a branch is created rather than needing a later migration.
  code: text('code').notNull(),
  streetName: text('street_name'),
  buildingNumber: text('building_number'),
  district: text('district'),
  city: text('city'),
  postalCode: text('postal_code'),
  countryCode: text('country_code').default('SA'),
  phone: text('phone'),
  isActive: boolean('is_active').default(true),
  isDefault: boolean('is_default').default(false),
  // The sales warehouse a document at this branch should default to (auto-filled, still
  // editable) — first tier of the resolution order in businessLogic.ts's
  // resolveSaleWarehouseId; falls back to the company's own default warehouse when this
  // is unset. Nullable/additive like everything else on this table's rollout — a branch
  // with no warehouses configured yet simply has no default. Must reference a 'sales'-type
  // warehouse, enforced in the branch upsert route, not by a DB-level check (the type
  // lives on a different table).
  defaultWarehouseId: uuid('default_warehouse_id').references(() => warehouses.id),
}, (table) => ({
  companyIdIdx: index('branches_company_id_idx').on(table.companyId),
  unique_default_branch: uniqueIndex('unique_default_branch').on(table.companyId).where(sql`is_default = true`),
}));

// Many-to-many: a staff member can legitimately be assigned to more than one branch (not
// just one "home" branch) — some roles genuinely work across locations. Zero rows for a
// user means company-wide (sees/can act on every branch, same as an admin), gated by the
// `branches.viewAllBranches` permission leaf, not by row presence here. `isPrimary` gives
// a multi-branch user a deterministic default focus at login instead of relying on
// query-result ordering — mirrors userRoles' shape exactly.
export const userBranches = pgTable('user_branches', {
  userId: uuid('user_id').notNull().references(() => users.id),
  branchId: uuid('branch_id').notNull().references(() => branches.id),
  isPrimary: boolean('is_primary').default(false),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.branchId] }),
  userIdIdx: index('user_branches_user_id_idx').on(table.userId),
  branchIdIdx: index('user_branches_branch_id_idx').on(table.branchId),
  unique_primary_branch: uniqueIndex('unique_primary_user_branch').on(table.userId).where(sql`is_primary = true`),
}));

// A company-scoped job title/position (Sales Associate, Cashier, Warehouse Supervisor)
// — deliberately named "Job Title", not "Role", to stay unambiguous against the
// unrelated `roles` table above (RBAC permission bundles for ERP login accounts). A job
// title is who someone IS for HR/business purposes; a Role is what an ERP account is
// allowed to click. The two must never be confused in code or naming.
export const jobTitles = pgTable('job_titles', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  title: text('title').notNull(), // e.g. "Sales Associate", "Cashier", "Warehouse Supervisor"
  // Optional free-text explanation of what the role covers — companies rename/redefine
  // job titles over time (the title text itself is editable, see the route's upsert), so
  // this is just supporting context, never matched/validated against anything.
  description: text('description'),
  // Controls whether employees holding this title are offered on the Invoice's Sales
  // Associate picker — a flag on the TITLE, not a hardcoded string match against "Sales
  // Associate", so a company phrasing it differently ("Sales Rep", "Account Manager")
  // can still mark it eligible. The column just means "counts as sales staff for
  // attribution/bonus purposes," not "exclusively for invoices," in case another
  // document type wants the same picker later.
  isSalesRole: boolean('is_sales_role').default(false),
  isActive: boolean('is_active').default(true),
}, (table) => ({
  companyIdx: index('job_titles_company_idx').on(table.companyId),
  uniqueTitle: uniqueIndex('job_titles_unique').on(table.companyId, table.title).where(sql`is_active = true`),
}));

// The HR foundation this app has never had: a real employee roster, independent of
// `users` (ERP login accounts). Not every employee needs ERP access (a shop-floor worker
// onboarded for payroll/attendance purposes may never log in); not every login is tied
// to a real employee today (every account predates this feature). `users.employeeId`
// below is the ONLY direction this relationship goes — employees never reference users —
// so a future Timekeeping module can key every clock-in/out record on `employeeId`
// without caring whether that employee ever had a login.
export const employees = pgTable('employees', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  // System-generated at onboarding (server/lib/employeeNumbering.ts), never free-typed —
  // always digits-only by construction, stored as text to preserve leading zeros
  // ("0042"). A permanent identifier: never reused, never reassigned, immutable after
  // creation, survives termination — the same "assigned once, never re-derived" contract
  // as an invoice number.
  employeeNumber: text('employee_number').notNull(),
  name: text('name').notNull(),
  jobTitleId: uuid('job_title_id').notNull().references(() => jobTitles.id),
  // Nullable = "Head Office / company-wide" (the onboarding default), same nullable/
  // additive convention as every other branch-scoped column this app already has
  // (quotations.branchId etc.) — an employee can be onboarded before any branch
  // assignment is decided, then moved to a specific branch later via a plain edit.
  branchId: uuid('branch_id').references(() => branches.id),
  email: text('email'),
  phone: text('phone'),
  hireDate: text('hire_date'), // YYYY-MM-DD, same text-date convention as invoices.date
  isActive: boolean('is_active').default(true),
  terminationDate: text('termination_date'),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  companyIdx: index('employees_company_idx').on(table.companyId),
  uniqueEmployeeNumber: uniqueIndex('employees_number_unique').on(table.companyId, table.employeeNumber),
}));

// The hot, concurrently-incremented state behind every document's human-readable number
// (INV-1042, QT-1001, ...) — see companies.numberingPolicy above and
// server/lib/documentNumbering.ts for the formatting/registry side. Deliberately company-
// wide only: no branchId column at all. Tier-1 ERPs (SAP/Oracle/Dynamics) keep this count
// at the legal-entity level for every document type because tax authorities treat any
// per-location fragmentation of a sequence as an audit red flag — a branch code can still
// appear as a cosmetic, printed element (numberingPolicy.includeBranchCode), but it never
// creates a second, independent count. Moved off companies.counters specifically so this
// table's own row lock (acquired implicitly by the INSERT ... ON CONFLICT upsert in
// getAndIncrementDocumentNumber) is entirely disjoint from processInvoiceZatca's ICV/PIH
// reservation, which locks the companies row itself (server/lib/zatca/processInvoice.ts) —
// these two systems must never contend for the same lock.
export const documentCounters = pgTable('document_counters', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  docType: text('doc_type').notNull(), // any key from DOCUMENT_TYPE_REGISTRY (server/lib/documentNumbering.ts) — plain text, not an enum, so a future new document type is a registry-array addition, never a migration
  // 'NONE' ('never' resets) | 'YYYY' (yearly) | 'YYYY-MM' (monthly) — derived from the
  // document's own date, never wall-clock time. A non-null sentinel ('NONE') instead of an
  // actual NULL deliberately, so (companyId, docType, periodKey) can be a plain unique index
  // target for `onConflictDoUpdate` — Postgres treats NULL <> NULL in a unique index, which
  // would let two "never resets" rows for the same (companyId, docType) coexist instead of
  // colliding, reopening the exact race this table exists to close.
  periodKey: text('period_key').notNull().default('NONE'),
  currentValue: integer('current_value').notNull().default(1000), // pre-increment; first issued number is currentValue + 1
}, (table) => ({
  lookupIdx: uniqueIndex('document_counters_lookup_idx').on(table.companyId, table.docType, table.periodKey),
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
  isActive: boolean('is_active').default(true),
  // Weighted rolling averages for on-hand stock valuation. averageCost updates on every
  // GRN receipt (PO-linked or DSD); averageSalePrice updates on every invoice/POS sale
  // line. Both are true quantity-weighted averages, not a rebuilt-from-history figure —
  // each update folds the new transaction into the running total using the paired
  // total-quantity counters below, so no historical replay is ever needed.
  averageCost: decimal('average_cost', { precision: 12, scale: 4 }).default('0'),
  averageSalePrice: decimal('average_sale_price', { precision: 12, scale: 4 }).default('0'),
  totalQuantityPurchased: decimal('total_quantity_purchased', { precision: 14, scale: 3 }).default('0'),
  totalQuantitySold: decimal('total_quantity_sold', { precision: 14, scale: 3 }).default('0'),
  // Nullable — null means this item is not shown on the POS Terminal's priority grid
  // (still reachable there via its category tab or search). A pure POS-presentation
  // ordering hint, unrelated to isPosItem (which controls whether the item is sellable
  // via POS at all) — set from the "Arrange POS Grid" panel in POS Terminal Settings,
  // never affects invoices/quotations/reports.
  posGridPosition: integer('pos_grid_position'),
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
  isActive: boolean('is_active').default(true),
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
  // General print-facing Commercial Registration number — not a ZATCA buyer-identification
  // field (that's only mandatory when a B2B buyer lacks a VAT number, a separate, deferred
  // gap — see BACKLOG.md), just what shows on the printed invoice/quotation alongside VAT.
  crNumber: text('cr_number'),
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
  isActive: boolean('is_active').default(true),
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
  // General print-facing Commercial Registration number — see the matching field on
  // customers; this form is shared between the two, so both need it.
  crNumber: text('cr_number'),
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

// A quarterly VAT filing record (server/routes/taxReturns.ts) — a governance/compliance
// document, not a report: 'Generated' captures a frozen server-computed snapshot,
// 'Filed' is a manual attestation (there is no live ZATCA API for VAT return submission,
// only for e-invoicing) that permanently locks the row AND blocks new/edited Invoices,
// Credit/Debit Notes, Expenses, and Purchase Bills from landing in that quarter
// (server/lib/businessLogic.ts's assertQuarterNotFiled). Unlike fiscalMonths, each
// Generate inserts a NEW row rather than upserting in place — a Generated-but-unfiled
// return can be soft-deleted and the quarter regenerated, so multiple historical
// (soft-deleted) attempts for one quarter can coexist; only a Filed row is truly final.
export const taxReturns = pgTable('tax_returns', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  year: integer('year').notNull(),
  quarter: integer('quarter').notNull(), // 1-4, calendar quarter (KSA fiscal year = Jan-Dec)
  referenceNumber: text('reference_number').notNull(), // `Q${quarter}-${year}`, computed at insert — deliberately NOT routed through documentNumbering.ts's counter (see that file's own registry comment); this format is fixed/calendar-derived, not a configurable per-company policy.
  startDate: text('start_date').notNull(), // YYYY-MM-DD — persisted rather than re-derived, so a snapshot always records exactly what it was computed against
  endDate: text('end_date').notNull(),
  status: text('status').notNull().default('Generated'), // 'Generated' | 'Filed' only — isDeleted below is orthogonal, same convention as quotations.isCancelled being separate from status
  isDeleted: boolean('is_deleted').default(false).notNull(),
  // Frozen computed numbers — mirrors fiscalMonths.closedPnL exactly, no duplicate flat
  // decimal columns. Shape: { salesSubtotal, outputVat, purchasesSubtotal, inputVat,
  // netVatPayable, breakdown: { salesCount, expenseCount, billCount } }.
  figuresSnapshot: jsonb('figures_snapshot').notNull(),
  generatedAt: timestamp('generated_at').notNull(),
  generatedById: uuid('generated_by_id').notNull().references(() => users.id),
  filedAt: timestamp('filed_at'),
  filedById: uuid('filed_by_id').references(() => users.id),
}, (table) => ({
  companyIdIdx: index('tax_returns_company_id_idx').on(table.companyId),
  // A Filed row's isDeleted can never become true (the delete route rejects Filed rows
  // outright — see taxReturns.ts), so this alone protects a Filed row from ever being
  // superseded; no need for an additional `OR status = 'Filed'` clause.
  uniqueActivePerQuarter: uniqueIndex('tax_returns_company_quarter_unique').on(table.companyId, table.year, table.quarter).where(sql`is_deleted = false`),
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
  // Dedicated cancel flag, deliberately separate from `status` (which tracks the
  // document's phase: Draft/Sent/Accepted/Converted). Cancellation is orthogonal to
  // phase - a quotation shows as "Cancelled" whenever this is true, regardless of what
  // phase it was in when cancelled, instead of overloading `status` with a value that
  // collides with the phase flow.
  isCancelled: boolean('is_cancelled').default(false),
  // Nullable: pre-multi-branch rows, and companies that never create a branch, stay NULL
  // forever — branch scoping is additive, never required. Set at creation time from the
  // creating user's resolved branch focus (server/routes/transactions.ts), never edited
  // afterward.
  branchId: uuid('branch_id').references(() => branches.id),
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
  // Carried through to the invoice's own unit column on quotation->invoice conversion —
  // see invoiceItems.unit's comment for why this exists.
  unit: text('unit'),
  // Nullable: a line is only linked back to the catalog when it was actually selected via
  // ItemCatalogSearch, not free-typed. See invoiceItems.productId's comment for why this
  // exists and how it's used (average sale price).
  productId: uuid('product_id').references(() => productsServices.id),
  // Nullable: null means the product's own base unit. `unit` above stays the ZATCA XML
  // code string exactly as before this column existed — when this is set, `unit` is
  // derived from THIS unitOfMeasure's own zatcaCode instead of the base product's, but the
  // two remain independent columns so no existing ZATCA logic changes shape. Quotations
  // never touch inventory, so this is carried purely for display/carry-through into the
  // invoice this quotation converts to.
  unitOfMeasureId: uuid('unit_of_measure_id').references(() => unitsOfMeasure.id),
});

export const posShifts = pgTable('pos_shifts', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  // Nullable, additive — same convention as every other branchId column (see
  // quotations.branchId's comment): a shift opened before this company adopted branches,
  // or by a company that never has, simply has no branch. Resolved/validated at shift-open
  // time the same way every other document-creation route resolves one (see
  // resolveDocumentBranchId in server/routes/pos.ts's POST /shifts), then immutable for
  // the shift's lifetime — added specifically because a branch-restricted cashier's own
  // shift (cash drawer, sales history) must not be visible/actionable by another branch's
  // staff, which had no column to enforce that against at all until now.
  branchId: uuid('branch_id').references(() => branches.id),
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
  // Nullable, additive — see quotations.branchId's comment. A Credit/Debit Note always
  // inherits its original invoice's branchId (server/routes/transactions.ts), never
  // picked independently, so a reversal's ZATCA seller address always matches the
  // document it's reversing. Used by processInvoiceZatca to override the seller's
  // PostalAddress per-field with this branch's own address when set.
  branchId: uuid('branch_id').references(() => branches.id),
  // The single sales warehouse this whole invoice's stock-item lines are deducted from —
  // one warehouse per document (mirrors goodsReceiptNotes.warehouseId), not per line; a
  // sale split across two physical warehouses isn't a real scenario this app models.
  // Resolved server-side at creation (resolveSaleWarehouseId in businessLogic.ts: the
  // invoice's branch's own default, else the company's default) unless the client
  // explicitly picks one, and required whenever the invoice has at least one true stock
  // ('item' type) line — a services-only invoice never needs one. Nullable because a
  // services-only invoice, or a legacy pre-this-feature invoice, has nothing to deduct.
  // Credit/Debit Notes inherit it from their original invoice, same as branchId.
  warehouseId: uuid('warehouse_id').references(() => warehouses.id),
  // Nullable, additive, optional forever (not "required once X exists" like branchId/
  // warehouseId above) — see quotations.branchId's comment for the general pattern.
  // Purely an attribution field (which employee gets credit for this sale, e.g. for a
  // sales-bonus calculation elsewhere) — never validated beyond "belongs to this company
  // and is active," never affects totals/tax/ZATCA XML. Only offered on the invoice form
  // when the company has at least one active employee whose job title is flagged
  // isSalesRole — see jobTitles.isSalesRole's comment.
  salesAssociateId: uuid('sales_associate_id').references(() => employees.id),
}, (table) => ({
  companyIdIdx: index('invoices_company_id_idx').on(table.companyId),
}));

// Tracks the tip of each company's ZATCA ICV/PIH chain, independently per environment
// (sandbox/simulation/production are entirely separate ZATCA backends — see CLAUDE.md's
// ZATCA section and BACKLOG.md — with zero shared submission history between them).
// Deliberately its own small table rather than an `environment` column scanned/sorted on
// `invoices` for every reservation: a point lookup on `(companyId, environment)` stays
// O(1) regardless of how large a tenant's invoice history grows, which matters for this
// app's stated SaaS-scale, thousands-of-concurrent-tenants priority. No `documentType`
// dimension — Invoice/CreditNote/DebitNote for one company share a single continuous ICV
// sequence, exactly as ZATCA's chain-integrity model requires (see processInvoiceZatca's
// own comment on this).
export const zatcaChainState = pgTable('zatca_chain_state', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  environment: text('environment').notNull(), // 'sandbox' | 'simulation' | 'production'
  currentIcv: integer('current_icv').notNull().default(0),
  currentHash: text('current_hash'),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({
  companyEnvIdx: uniqueIndex('zatca_chain_state_company_env_idx').on(table.companyId, table.environment),
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
  // ZATCA UBL unit-of-measure code (UN/ECE Recommendation 20, e.g. 'PCE'/'KGM'/'MTR') for
  // this specific line — previously nonexistent, so the XML builder hardcoded 'PCE' for
  // every invoice regardless of what was actually sold. Nullable: normalizeZatcaUnitCode()
  // (src/zatcaUnitCodes.ts) falls back to 'PCE' for legacy rows created before this column
  // existed, so it's safe to add without a backfill.
  unit: text('unit'),
  // Nullable: only set when this line was actually selected via ItemCatalogSearch, not
  // free-typed (this app's invoice/quotation lines are description-first by design, no
  // hard product link — see BACKLOG.md's "ProductService.type classification cleanup"
  // history for other places this same free-typed-vs-catalog tension shows up). When
  // present, the invoice-creation routes fold this line's unitCost into the product's
  // averageSalePrice (a quantity-weighted rolling average, same mechanism as GRN receipts
  // fold into averageCost — see that column's comment). A free-typed line with no
  // productId simply never contributes to the average; it doesn't error or block the sale.
  productId: uuid('product_id').references(() => productsServices.id),
  // Nullable: null means the product's own base unit. `unit` above stays the ZATCA XML
  // code string, independently populated (from THIS unitOfMeasure's own zatcaCode when
  // set) — the two columns are deliberately kept separate so existing ZATCA XML logic is
  // untouched. `quantity`/`unitCost` above are always expressed in THIS unit for billing/
  // display; server/lib/uomConversion.ts converts to base-unit terms before
  // deductStockForSale or the averageSalePrice fold ever run.
  unitOfMeasureId: uuid('unit_of_measure_id').references(() => unitsOfMeasure.id),
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
  // Nullable, additive — see quotations.branchId's comment.
  branchId: uuid('branch_id').references(() => branches.id),
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
  // Nullable, always system-inherited from the source document (Invoice/Expense/
  // PurchaseBill) a voucher is posted against — never picked independently, since a
  // voucher/payment receipt should always attribute to the same branch as what it
  // settles. See quotations.branchId's comment for the general nullable/additive pattern.
  branchId: uuid('branch_id').references(() => branches.id),
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
  // Denormalized from the owning shift's own branchId at creation time (never trusted
  // from the client) — same "carry your own branchId rather than forcing every reader to
  // join back to a parent" convention every other transactional table in this app already
  // follows (invoices, quotations, expenses, vouchers all carry their own branchId too).
  branchId: uuid('branch_id').references(() => branches.id),
  customerId: uuid('customer_id').references(() => customers.id),
  items: jsonb('items').notNull(),
  createdAt: timestamp('created_at').notNull(),
  reference: text('reference').notNull(),
}, (table) => ({
  companyIdIdx: index('pos_held_inv_company_id_idx').on(table.companyId),
}));

// Forgot-password reset links. Only the SHA-256 hash of the raw token is ever stored —
// the raw token exists only in the emailed URL and briefly in memory server-side while
// issuing/verifying it, so a DB read alone can never be used to forge a working reset
// link. Single-use (usedAt) and short-lived (expiresAt) by design.
export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
  usedAt: timestamp('used_at', { mode: 'date' }),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow(),
}, (table) => ({
  tokenHashIdx: index('password_reset_tokens_hash_idx').on(table.tokenHash),
  userIdIdx: index('password_reset_tokens_user_id_idx').on(table.userId),
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
  // A real UN/ECE Rec 20 code (server/routes/masterEntities.ts's POST /units-of-measure
  // enforces this via isValidZatcaUnitCode, src/zatcaUnitCodes.ts) — NOT an arbitrary
  // business label. This is already what invoiceItems/quotationItems.unit is populated
  // from, so a packaging unit (e.g. "Carton") just picks whichever existing code is the
  // closest fit (e.g. 'SET' or 'C62') like any other unit does — no separate ZATCA-mapping
  // column needed.
  code: text('code').notNull(),
  isActive: boolean('is_active').default(true),
  companyId: uuid('company_id').notNull().references(() => companies.id),
});

// POS-only, optional per product (e.g. "Size", "Milk") — a product with zero rows in
// productModifierGroups below has no modifiers, the default/untouched state for every
// existing product. Selections made from these are resolved to plain description text +
// a final unitCost on the POS cart line BEFORE it ever becomes an invoice_items row, so
// invoices/quotations/reports/ZATCA never need to know this concept exists — see
// PosModule.tsx's handleAddToCart.
export const modifierGroups = pgTable('modifier_groups', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  name: text('name').notNull(), // e.g. "Size", "Milk", "Extra Shot"
  isRequired: boolean('is_required').notNull().default(false),
  isActive: boolean('is_active').default(true),
  sortOrder: integer('sort_order'),
}, (table) => ({
  companyIdIdx: index('modifier_groups_company_id_idx').on(table.companyId),
}));

export const modifierChoices = pgTable('modifier_choices', {
  id: uuid('id').primaryKey(),
  modifierGroupId: uuid('modifier_group_id').references(() => modifierGroups.id).notNull(),
  label: text('label').notNull(), // e.g. "Medium", "Oat Milk"
  priceDelta: decimal('price_delta', { precision: 10, scale: 2 }).notNull().default('0'),
  sortOrder: integer('sort_order'),
}, (table) => ({
  groupIdIdx: index('modifier_choices_group_id_idx').on(table.modifierGroupId),
}));

// Which modifier groups attach to which product, and their display order in the POS
// modal. No companyId of its own (same convention as invoiceItems/quotationItems) —
// isolation is enforced at write time by checking both productId and modifierGroupId
// belong to the caller's own company (assertModifierGroupsOwnedByCompany + the existing
// assertProductsOwnedByCompany), not by a column on this join table.
export const productModifierGroups = pgTable('product_modifier_groups', {
  id: uuid('id').primaryKey(),
  productId: uuid('product_id').references(() => productsServices.id).notNull(),
  modifierGroupId: uuid('modifier_group_id').references(() => modifierGroups.id).notNull(),
  sortOrder: integer('sort_order'),
}, (table) => ({
  productIdIdx: index('product_modifier_groups_product_id_idx').on(table.productId),
  uniquePair: uniqueIndex('product_modifier_groups_unique').on(table.productId, table.modifierGroupId),
}));

// A product's packaging/alternate units — e.g. "Cell 4 AMP" (base unit: Piece) also sold/
// bought as "Carton-12" (1 Carton = 12 Piece). Inventory (inventoryStocks/
// stockLedgerTransactions) and averageCost/averageSalePrice are always kept in the
// product's own base unit (productsServices.unit) regardless of which unit a transaction
// was entered in — see server/lib/uomConversion.ts, the one place every stock-mutating
// route converts through before touching quantity/cost. Deliberately NOT a second product/
// catalog row (a "kit" model) — this is one physical item just packaged differently, not a
// bundle of distinct products, so one product master with alternate units is the right
// shape (matches how SAP/Odoo/NetSuite model case-pack conversions).
export const productUnitConversions = pgTable('product_unit_conversions', {
  id: uuid('id').primaryKey(),
  productId: uuid('product_id').notNull().references(() => productsServices.id),
  unitOfMeasureId: uuid('unit_of_measure_id').notNull().references(() => unitsOfMeasure.id),
  conversionFactor: decimal('conversion_factor', { precision: 12, scale: 4 }).notNull(),
  // This packaging level's own scannable barcode/SKU — a carton is a real, independently
  // identifiable retail/warehouse unit, not just a quantity multiplier on the base item.
  barcode: text('barcode'),
  sku: text('sku'),
  // Deliberately independent of productsServices.unitPrice * conversionFactor — bulk
  // pricing is a real business decision (a case discount, or a premium for split units),
  // never auto-derived. Nullable: a packaging unit not meant to be bought/sold on its own
  // (only used for counting) simply has no price configured for that side.
  purchasePrice: decimal('purchase_price', { precision: 12, scale: 2 }),
  salePrice: decimal('sale_price', { precision: 12, scale: 2 }),
  isActive: boolean('is_active').default(true),
  companyId: uuid('company_id').notNull().references(() => companies.id),
}, (table) => ({
  companyIdx: index('product_unit_conversions_company_idx').on(table.companyId),
  productIdx: index('product_unit_conversions_product_idx').on(table.productId),
  barcodeIdx: index('product_unit_conversions_barcode_idx').on(table.barcode),
  uniqueProductUnit: uniqueIndex('product_unit_conversions_unique').on(table.productId, table.unitOfMeasureId).where(sql`is_active = true`),
}));

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
  // Direct branchId (unlike GRN/Returns/StockTakes, a PR has no warehouseId to derive
  // branch from) — nullable, additive, see quotations.branchId's comment.
  branchId: uuid('branch_id').references(() => branches.id),
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
  branchId: uuid('branch_id').references(() => branches.id),
});

export const purchaseOrderItems = pgTable('purchase_order_items', {
  id: uuid('id').primaryKey(),
  purchaseOrderId: uuid('purchase_order_id').notNull().references(() => purchaseOrders.id),
  productId: uuid('product_id').notNull().references(() => productsServices.id),
  quantityOrdered: decimal('quantity_ordered', { precision: 12, scale: 3 }).notNull(),
  unitPrice: decimal('unit_price', { precision: 12, scale: 2 }).notNull(),
  taxRate: decimal('tax_rate', { precision: 5, scale: 2 }).default('0.00'),
  // Nullable: null means the product's own base unit (productsServices.unit), matching the
  // nullable/additive convention used throughout this schema. When set, `quantityOrdered`
  // is expressed in THIS unit — server/lib/uomConversion.ts converts to base-unit terms
  // wherever this line is compared against a GRN's own (possibly different-unit) receipt.
  unitOfMeasureId: uuid('unit_of_measure_id').references(() => unitsOfMeasure.id),
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
  isReversed: boolean('is_reversed').default(false).notNull(), // Correction path for a wrong-quantity/wrong-batch receipt
  // Set once this GRN is referenced by a real (non-cancelled) Purchase Bill — the 3-way
  // match control (PO -> GRN -> Bill): a receipt can only be billed once, and a bill's
  // totals are computed server-side directly from the GRN it references rather than
  // re-entered by hand, so PO/GRN/Bill can never independently drift from each other.
  isBilled: boolean('is_billed').default(false).notNull(),
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
  // Nullable: null means the product's own base unit — see purchaseOrderItems.
  // unitOfMeasureId's comment. `quantityReceived`/`unitCost` above are always expressed in
  // THIS unit; server/lib/uomConversion.ts converts to base-unit quantity/cost before this
  // receipt ever touches inventoryStocks/stockLedgerTransactions/averageCost.
  unitOfMeasureId: uuid('unit_of_measure_id').references(() => unitsOfMeasure.id),
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
  status: text('status').default('Unpaid').notNull(), // 'Unpaid', 'Partially Paid', 'Paid', 'Cancelled'
  amountPaid: decimal('amount_paid', { precision: 12, scale: 2 }).default('0').notNull(),
  bankId: uuid('bank_id').references(() => bankAccounts.id),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  branchId: uuid('branch_id').references(() => branches.id),
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
  status: text('status').default('Active').notNull(), // 'Active', 'Cancelled'
  companyId: uuid('company_id').notNull().references(() => companies.id),
});

export const purchaseReturnItems = pgTable('purchase_return_items', {
  id: uuid('id').primaryKey(),
  returnId: uuid('return_id').notNull().references(() => purchaseReturns.id),
  productId: uuid('product_id').notNull().references(() => productsServices.id),
  quantityReturned: decimal('quantity_returned', { precision: 12, scale: 3 }).notNull(),
  batchNumber: text('batch_number'),
  // Nullable: null means the product's own base unit — see purchaseOrderItems.
  // unitOfMeasureId's comment. `quantityReturned` is always expressed in THIS unit;
  // converted to base-unit terms before touching inventoryStocks, and when checked against
  // the source GRN's own remaining-returnable quantity (which may itself be a different unit).
  unitOfMeasureId: uuid('unit_of_measure_id').references(() => unitsOfMeasure.id),
});

// 9. Physical Stock Takes
export const physicalStockTakes = pgTable('physical_stock_takes', {
  id: uuid('id').primaryKey(),
  referenceNumber: text('reference_number').notNull(),
  warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
  date: timestamp('date').notNull(),
  status: text('status').default('Draft').notNull(), // 'Draft', 'Completed' (Adjustments Posted), 'Cancelled'
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
  // Nullable: null means the product's own base unit — see purchaseOrderItems.
  // unitOfMeasureId's comment. `physicalQuantity` (the counted amount, e.g. "3 full
  // cartons") is expressed in THIS unit; `systemQuantity`/`variance` stay in base-unit
  // terms exactly as today, and the finalize route converts physicalQuantity to base-unit
  // before writing it as the new inventoryStocks quantity.
  unitOfMeasureId: uuid('unit_of_measure_id').references(() => unitsOfMeasure.id),
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
