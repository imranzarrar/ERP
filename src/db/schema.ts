import { relations, sql } from 'drizzle-orm';
import { integer, bigint, pgTable, serial, text, timestamp, date as pgDate, boolean, decimal, jsonb, uuid, primaryKey, uniqueIndex, unique, foreignKey, index, pgPolicy, check, customType } from 'drizzle-orm/pg-core';

// A business date: a calendar day without a time, read and written as a 'YYYY-MM-DD' string (docs/date-fields-standard.md). Named <meaning>_date.
const businessDate = (name: string) => pgDate(name, { mode: 'string' });

// Postgres bytea <-> Node Buffer (drizzle-orm/pg-core ships no bytea builder).
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

// Row-Level Security, introduced as a defense-in-depth SECOND layer on top of (never
// instead of) this app's existing req.targetCompanyId application-level checks — see
// server/lib/tenantDb.ts and .claude/skills (session-company-scoping/data-isolation-guard)
// for the existing app-level model this supplements. TENANT_DB_ROLE is the name of a real,
// separate, NON-superuser Postgres role (created once, see app.secrets' TENANT_DB_USER
// comment) that ONLY the new, opt-in tenantDb data-access path connects as — RLS has ZERO
// effect on a superuser/BYPASSRLS role, which is what this app's main `db` export (SQL_USER)
// still connects as and continues to use, completely unaffected by any of this. Policies
// below are being added table-by-table as each is migrated to tenantDb, not all at once —
// a table with a policy defined here but never queried via tenantDb behaves exactly as
// before for every existing route (which never binds `app.company_id`, so the main `db`
// connection - a bypassing superuser - is unaffected either way).
const TENANT_DB_ROLE = 'erp_app_tenant';

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
  // General Ledger: may the person who prepared a manual journal also approve it? Off by default (segregation of duties); only the owner switches it.
  journalSelfApproval: boolean('journal_self_approval').notNull().default(false),
  // 'Trial' | 'Registered' | 'Cancelled'. Defaults 'Registered' so every existing company
  // (created before this field existed, or created directly by a super-admin via the old
  // Companies Directory "Register New Organization" form) is unaffected — only the
  // onboarding-approval route (server/routes/onboarding.ts) ever inserts 'Trial' explicitly,
  // for a self-signup company awaiting real (outside-the-system, e.g. payment) confirmation.
  // 'Cancelled' blocks login for that company's users (see isAuthenticated in server.ts) and
  // is the only status that exposes the "Delete Company & All Data" purge in the admin UI.
  registrationStatus: text('registration_status').notNull().default('Registered'),
}, (table) => ({
  // Self-scoping: a tenant connection sees/acts on only its OWN company row, matched by
  // id (this table has no separate companyId column — it IS the tenant root every other
  // table's companyId points at). Cross-company browsing (company list, deletion) is a
  // deliberate exception that stays on the superuser `db` — see
  // .claude/skills/rls-tenant-isolation/SKILL.md.
  tenantIsolationPolicy: pgPolicy('companies_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.id} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.id} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
  tenantIsolationPolicy: pgPolicy('zatca_environment_configs_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
  tenantIsolationPolicy: pgPolicy('roles_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
  // Forces the change-password screen on next login instead of normal app entry — set
  // whenever an admin chooses/resets someone else's password (including the 123456
  // default on a brand-new account), cleared once that user sets their own password via
  // POST /api/auth/change-password. See server/routes/users.ts and server.ts's login route.
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  // Direct identity fields for a login account that has NO linked employee (a company
  // not using HR onboarding, or an admin/system account that was never meant to be one).
  // Deliberately NOT used at all once employeeId is set — server/routes/users.ts forces
  // both to null on save whenever an employee link exists, so the employees row (which
  // already has its own name/phone) stays the single source of truth instead of two
  // copies that can drift apart, same reasoning username=email replaced two separate
  // identifiers with one. phone is unstructured free text (international formats vary
  // too much for a single validation rule) — currently informational only; a future SMS-
  // based password-reset flow would read it from here (or from the linked employee).
  fullName: text('full_name'),
  phone: text('phone'),
}, (table) => ({
  companyIdIdx: index('users_company_id_idx').on(table.companyId),
  emailIdx: index('users_email_idx').on(table.email),
  // Case-insensitive uniqueness, DB-level backstop behind the app-layer check in
  // POST /api/users (server/routes/users.ts) — that route is the only place either was
  // ever actually enforced before this; a race between two concurrent creates, or any
  // future direct-insert path, still needs a real constraint to catch it. Nullable email
  // is fine here: Postgres treats each NULL as distinct under a unique index, so any
  // number of legacy no-email rows can coexist. Confirmed zero existing duplicates in
  // dev before adding this — a production db:push must re-run that same check first (see
  // hostinger-deploy skill's schema-change checklist) and resolve any it finds, or the
  // index creation itself will fail outright.
  // Partial on isDeleted=0 — a soft-deleted account (users.delete only ever sets
  // isDeleted, never actually removes the row) must not permanently block re-registering
  // its old username/email for a new account. Narrowing an existing unique index like
  // this can only ever reduce what it rejects, never violate current data, so no
  // conflict check is needed before this specific change (unlike widening one).
  usernameUniqueCi: uniqueIndex('users_username_unique_ci').on(sql`lower(${table.username})`).where(sql`is_deleted = 0`),
  emailUniqueCi: uniqueIndex('users_email_unique_ci').on(sql`lower(${table.email})`).where(sql`is_deleted = 0`),
  tenantIsolationPolicy: pgPolicy('users_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
  // Dual-parent junction (users + roles) — checked via the users side only, relying on
  // the existing app-level invariant that a userRoles row's user and role always belong
  // to the same company (enforced at write time, e.g. server/routes/users.ts/roles.ts).
  tenantIsolationPolicy: pgPolicy('user_roles_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`EXISTS (SELECT 1 FROM ${users} WHERE ${users.id} = ${table.userId} AND ${users.companyId} = current_setting('app.company_id', true)::uuid)`,
    withCheck: sql`EXISTS (SELECT 1 FROM ${users} WHERE ${users.id} = ${table.userId} AND ${users.companyId} = current_setting('app.company_id', true)::uuid)`,
  }),
})).enableRLS();

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
  companyIdIdx: index('document_templates_company_id_idx').on(table.companyId),
  tenantIsolationPolicy: pgPolicy('document_templates_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
  tenantIsolationPolicy: pgPolicy('tax_slabs_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
  companyIdIdx: index('product_categories_company_id_idx').on(table.companyId),
  tenantIsolationPolicy: pgPolicy('product_categories_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
  tenantIsolationPolicy: pgPolicy('warehouses_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
  // Target of the composite (company_id, id) foreign keys that keep dimension tags inside one company (declared (company_id, id): see company_accounts).
  idCompanyUnique: unique('branches_id_company_unique').on(table.companyId, table.id),
  unique_default_branch: uniqueIndex('unique_default_branch').on(table.companyId).where(sql`is_default = true`),
  tenantIsolationPolicy: pgPolicy('branches_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
  // Dual-parent junction (users + branches) — checked via the users side only, same
  // reasoning as userRoles' own policy comment above.
  tenantIsolationPolicy: pgPolicy('user_branches_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`EXISTS (SELECT 1 FROM ${users} WHERE ${users.id} = ${table.userId} AND ${users.companyId} = current_setting('app.company_id', true)::uuid)`,
    withCheck: sql`EXISTS (SELECT 1 FROM ${users} WHERE ${users.id} = ${table.userId} AND ${users.companyId} = current_setting('app.company_id', true)::uuid)`,
  }),
})).enableRLS();

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
  tenantIsolationPolicy: pgPolicy('job_titles_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
  tenantIsolationPolicy: pgPolicy('employees_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
  tenantIsolationPolicy: pgPolicy('document_counters_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

export const productsServices = pgTable('products_services', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  // The SELLING price — what a customer is charged on invoices/quotations/POS. Never
  // used to value stock or default a purchase cost.
  unitPrice: decimal('unit_price', { precision: 12, scale: 2 }).notNull(),
  // The purchasing/stock-valuation price — defaults GRN/PO line unit cost. Nullable
  // because older rows predate this split (before this field existed, unitPrice was
  // overloaded for both purposes); every cost-default read falls back to unitPrice when
  // this is null, so pre-existing products keep behaving exactly as before until an
  // admin sets a real cost price. Never itself used as a selling price.
  costPrice: decimal('cost_price', { precision: 12, scale: 2 }),
  // Real, persisted item-vs-service classification — actually wired to the Add Product
  // form's "Product Classification" control (previously a client-only, never-persisted
  // value). Drives every stock-mutating code path: sales deduction/restock
  // (businessLogic.ts), GRN/Purchase-Return/Warehouse-Transfer/Stock-Take/Adjustment
  // (server/routes/inventory.ts), and which products the item-pickers on those forms even
  // offer (InventoryModule.tsx). 'service' products never touch inventoryStocks.
  itemKind: text('item_kind').notNull().default('item'), // 'item' | 'service'
  // Which item-pickers this product shows up in: 0 = Sales & Purchase (Both, the default —
  // most retail items are bought and resold), 1 = Sales only, 2 = Purchase only. Replaces
  // the old `type` column's Sales/Purchase meaning; see salesProducts/purchaseProducts
  // filters in InvoiceModule.tsx/QuotationModule.tsx/ExpenseModule.tsx.
  salesPurchaseFlow: integer('sales_purchase_flow').notNull().default(0),
  // `unit` is kept as the plain ZATCA unit code (e.g. "PCE") that every existing reader of
  // this column already expects (invoice/quotation/expense line items, ZATCA XML, etc.) —
  // changing its meaning would ripple everywhere. This new column is the actual reference
  // to WHICH named units_of_measure row was picked, since two different named units can
  // share one ZATCA code (e.g. both "Piece" and a custom "Box of 12" coded "PCE"), which
  // `unit` alone can never disambiguate — see MasterEntities.tsx's prodUnitId comment for
  // the real incident this was built to fix. Nullable: `unit` stays the source of truth for
  // ZATCA reporting either way; this only powers the picker's own round-trip display.
  unitOfMeasureId: uuid('unit_of_measure_id').references((): any => unitsOfMeasure.id),
  unit: text('unit'),
  isPosItem: boolean('is_pos_item').default(false),
  category: text('category'),
  categoryId: uuid('category_id').references(() => productCategories.id),
  base64Image: text('base64_image'),
  barcode: text('barcode'),
  // Auto-generated on create (server/lib/documentNumbering.ts's 'sku' sequence) — no
  // longer a manually-typed field; see customers.customerCode's comment for the pattern.
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
  tenantIsolationPolicy: pgPolicy('products_services_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

export const customers = pgTable('customers', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  phone: text('phone').notNull(),
  email: text('email').notNull(),
  address: text('address').notNull(),
  // Deprecated — superseded by vatNumber below (the field ZATCA and printing actually use).
  // Left in place, unread and unwritten by the app, purely so pre-existing values aren't
  // silently destroyed; never surfaced in the UI. See vatNumber's own comment.
  taxRegNumber: text('tax_reg_number'),
  isSystem: boolean('is_system').default(false),
  isActive: boolean('is_active').default(true),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  // Auto-generated on create (server/lib/documentNumbering.ts's 'customerCode' sequence,
  // same per-company atomic counter that numbers invoices/quotations) — never
  // user-editable, never regenerated on edit. Nullable only because rows created before
  // this column existed have no value until the one-off backfill script assigns one.
  customerCode: text('customer_code'),
  // ZATCA Buyer Fields
  buyerType: text('buyer_type').default('B2B'),
  // The single VAT-number field for this customer, for both display and ZATCA. Strictly
  // validated (15 digits, starts/ends with '3') only when buyerType is 'B2B' — free-form
  // for B2C, where it's optional and ZATCA never checks it. Shown on the form regardless
  // of buyerType (see MasterEntities.tsx) - taxRegNumber above used to be the box shown for
  // B2C before this field was promoted to that role.
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
  // Posting profile: the receivable account this customer's invoices and receipts post to (a control account of subledger type 'customer'; null = the
  // company's Accounts Receivable), and the dimension tags every ledger line of a document for this customer starts from.
  controlAccountId: uuid('control_account_id'),
  defaultDimensionCombinationId: uuid('default_dimension_combination_id'),
}, (table) => ({
  companyIdIdx: index('customers_company_id_idx').on(table.companyId),
  // target of the composite (id, company_id) foreign keys of the ledger lines; declared (company_id, id) like every such key (drizzle-kit reads the columns back in that order)
  idCompanyUnique: unique('customers_id_company_unique').on(table.companyId, table.id),
  controlAccountFk: foreignKey({ name: 'customers_control_account_company_fk', columns: [table.controlAccountId, table.companyId], foreignColumns: [companyAccounts.id, companyAccounts.companyId] }),
  defaultDimensionFk: foreignKey({ name: 'customers_default_dimension_company_fk', columns: [table.defaultDimensionCombinationId, table.companyId], foreignColumns: [dimensionCombinations.id, dimensionCombinations.companyId] }),
  // Proof-of-concept table for the tenantDb RLS rollout (see the TENANT_DB_ROLE comment
  // above) — first table migrated, deliberately simple (no branch-scoping complexity) to
  // validate the whole pipeline (policy + tenantDb + ALS context + a real migrated route)
  // end-to-end before expanding to more tables.
  //
  // CONFIRMED drizzle-kit 0.31.10 LIMITATION: `db:push` creates this policy but silently
  // drops the using/withCheck predicate from the generated DDL (verified directly via
  // `SELECT pg_get_expr(polqual, polrelid) FROM pg_policy` showing NULL after a push) —
  // root cause not isolated (not a duplicate drizzle-orm install; only one is present).
  // The real predicate below was therefore applied ONCE, out-of-band, via a direct
  // `ALTER POLICY customers_tenant_isolation ON customers USING (...) WITH CHECK (...)`
  // SQL statement — NOT reproducible by re-running db:push. Empirically re-verified safe:
  // a subsequent real db:push run (with unrelated schema changes) left this policy's
  // predicate completely untouched, no CREATE/ALTER POLICY statement was even printed for
  // it, meaning drizzle-kit's push-mode diff isn't attempting to revert it either. Still,
  // after ANY future db:push that could plausibly touch this table, re-verify with the
  // same query before trusting this policy — don't assume the predicate survived.
  tenantIsolationPolicy: pgPolicy('customers_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

export const vendors = pgTable('vendors', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  phone: text('phone').notNull(),
  email: text('email').notNull(),
  address: text('address').notNull(),
  // Deprecated — see the matching field's comment on customers above; same "superseded by
  // vatNumber, never read/written, kept only so historical values aren't destroyed" story.
  taxRegNumber: text('tax_reg_number'),
  isSystem: boolean('is_system').default(false),
  apGlAccount: text('ap_gl_account'), // e.g., '2100 - Accounts Payable'
  isActive: boolean('is_active').default(true),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  // Auto-generated on create (server/lib/documentNumbering.ts's 'vendorCode' sequence) —
  // see customers.customerCode's comment; same story here.
  vendorCode: text('vendor_code'),
  // ZATCA Address Fields
  buyerType: text('buyer_type').default('B2B'),
  // See customers.vatNumber's comment — same single-VAT-field story applies to vendors.
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
  // Posting profile (see customers): the payable account for this vendor's bills and payments, and its default dimension tags.
  controlAccountId: uuid('control_account_id'),
  defaultDimensionCombinationId: uuid('default_dimension_combination_id'),
}, (table) => ({
  companyIdIdx: index('vendors_company_id_idx').on(table.companyId),
  idCompanyUnique: unique('vendors_id_company_unique').on(table.companyId, table.id),
  controlAccountFk: foreignKey({ name: 'vendors_control_account_company_fk', columns: [table.controlAccountId, table.companyId], foreignColumns: [companyAccounts.id, companyAccounts.companyId] }),
  defaultDimensionFk: foreignKey({ name: 'vendors_default_dimension_company_fk', columns: [table.defaultDimensionCombinationId, table.companyId], foreignColumns: [dimensionCombinations.id, dimensionCombinations.companyId] }),
  tenantIsolationPolicy: pgPolicy('vendors_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

export const bankAccounts = pgTable('bank_accounts', {
  id: uuid('id').primaryKey(),
  bankName: text('bank_name').notNull(),
  accountNumber: text('account_number').notNull(),
  accountTitle: text('account_title').notNull(),
  openingBalance: decimal('opening_balance', { precision: 14, scale: 2 }).notNull(),
  isActive: boolean('is_active').default(true),
  isDefault: boolean('is_default').default(false),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  // Dimension tags every ledger line on this bank account starts from (e.g. the Branch that holds the cash).
  defaultDimensionCombinationId: uuid('default_dimension_combination_id'),
}, (table) => ({
  defaultDimensionFk: foreignKey({ name: 'bank_accounts_default_dimension_company_fk', columns: [table.defaultDimensionCombinationId, table.companyId], foreignColumns: [dimensionCombinations.id, dimensionCombinations.companyId] }),
  unique_default_bank: uniqueIndex('unique_default_bank').on(table.companyId).where(sql`is_default = true`),
  companyIdIdx: index('bank_accounts_company_id_idx').on(table.companyId),
  tenantIsolationPolicy: pgPolicy('bank_accounts_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
  companyIdIdx: index('fiscal_months_company_id_idx').on(table.companyId),
  tenantIsolationPolicy: pgPolicy('fiscal_months_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
  tenantIsolationPolicy: pgPolicy('tax_returns_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

export const quotations = pgTable('quotations', {
  id: uuid('id').primaryKey(),
  quotationNumber: text('quotation_number').notNull(),
  docDate: businessDate('doc_date').notNull(), // the date of the quotation (docs/date-fields-standard.md)
  customerId: uuid('customer_id').references(() => customers.id).notNull(),
  taxSlabId: uuid('tax_slab_id').references(() => taxSlabs.id).notNull(),
  notes: text('notes').notNull(),
  status: text('status').notNull(),
  createdById: uuid('created_by_id').references(() => users.id).notNull(),
  createdAt: timestamp('created_at').notNull(),
  validUntilDate: businessDate('valid_until_date'), // the offer is open until
  updatedAt: timestamp('updated_at'),
  updatedById: uuid('updated_by_id').references(() => users.id),
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
  docDateIdx: index('quotations_company_doc_date_idx').on(table.companyId, table.docDate),
  companyIdIdx: index('quotations_company_id_idx').on(table.companyId),
  tenantIsolationPolicy: pgPolicy('quotations_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
}, (table) => ({
  quotationIdIdx: index('quotation_items_quotation_id_idx').on(table.quotationId),
  // Child table, no local companyId — scoped via its parent quotation's own companyId.
  tenantIsolationPolicy: pgPolicy('quotation_items_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`EXISTS (SELECT 1 FROM ${quotations} WHERE ${quotations.id} = ${table.quotationId} AND ${quotations.companyId} = current_setting('app.company_id', true)::uuid)`,
    withCheck: sql`EXISTS (SELECT 1 FROM ${quotations} WHERE ${quotations.id} = ${table.quotationId} AND ${quotations.companyId} = current_setting('app.company_id', true)::uuid)`,
  }),
})).enableRLS();

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
  tenantIsolationPolicy: pgPolicy('pos_shifts_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey(),
  invoiceNumber: text('invoice_number').notNull(),
  docDate: businessDate('doc_date').notNull(), // invoice date; the ZATCA issue date
  postingDate: businessDate('posting_date').notNull(), // the ledger / period date; always equals docDate for an invoice
  supplyDate: businessDate('supply_date'), // date of supply (tax point); empty = docDate
  dueDate: businessDate('due_date'), // payment due (set from the payment terms)
  customerId: uuid('customer_id').references(() => customers.id).notNull(),
  taxSlabId: uuid('tax_slab_id').references(() => taxSlabs.id).notNull(),
  bankId: uuid('bank_id').references(() => bankAccounts.id).notNull(),
  paymentStatus: text('payment_status').notNull(),
  paymentDate: timestamp('payment_date'),
  notes: text('notes').notNull(),
  status: text('status').notNull(),
  createdById: uuid('created_by_id').references(() => users.id).notNull(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at'),
  updatedById: uuid('updated_by_id').references(() => users.id),
  originQuotationId: uuid('origin_quotation_id').references(() => quotations.id),
  discountPercentage: decimal('discount_percentage', { precision: 5, scale: 2 }),
  // Header-level discount, display-only — distinct from invoiceItems.discountAmount
  // (a per-LINE discount, a completely different concept). Set only when the discount was
  // actually entered as a flat SAR amount (POS header-discount UI) rather than a percent;
  // discountPercentage above is always still the one true value every tax/total
  // calculation actually uses (calculateInvoiceTotals, the ZATCA XML builder) — a flat
  // amount is converted to its equivalent percentage of the pre-discount subtotal before
  // it's ever stored there, specifically so this reuses that already-correct,
  // ZATCA-verified proportional-distribution-across-tax-categories logic unchanged rather
  // than needing a second calculation path. This column exists purely so the receipt and
  // audit trail can honestly show "SAR 50 off" instead of a re-derived, less legible
  // percentage when that's genuinely what the cashier typed.
  discountAmount: decimal('discount_amount', { precision: 12, scale: 2 }),
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
  // Legacy plain-text copy of the signed UBL XML. New and re-signed invoices write xmlContentZ instead
  // and leave this NULL; rows from before the change are converted by
  // scripts/backfill-compress-invoice-xml.ts. Read through server/lib/zatca/xmlStorage.ts's
  // readInvoiceXml(), never directly. Safe to drop once every environment has been backfilled.
  xmlContent: text('xml_content'),
  // Brotli-compressed signed UBL XML with a 1-byte format tag (see xmlStorage.ts). The signed
  // document is the legal VAT record — lossless, round-trip-verified on every write.
  xmlContentZ: bytea('xml_content_z'),
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
  docDateIdx: index('invoices_company_doc_date_idx').on(table.companyId, table.docDate),
  companyIdIdx: index('invoices_company_id_idx').on(table.companyId),
  tenantIsolationPolicy: pgPolicy('invoices_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
  tenantIsolationPolicy: pgPolicy('zatca_chain_state_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
  // Set only on a CreditNote/DebitNote line — points at the exact original-invoice line
  // it's crediting/debiting. This is what makes a PARTIAL return possible without a
  // separate "returns" table: the cumulative quantity already credited against one
  // original line is SUM(invoiceItems.quantity) over every CreditNote whose line points
  // back at it (via this column), checked against that original line's own quantity
  // before a new return is allowed to proceed — a running counter on the original line
  // itself would race under concurrent partial returns; this aggregation approach can't,
  // since it's computed fresh (under the same row lock as the rest of the return
  // transaction) every time rather than incrementally maintained. Nullable: a normal
  // Invoice line, or a full-invoice-reversal CreditNote/DebitNote predating this column,
  // has none — POS Returns (server/routes/transactions.ts) is the only writer.
  originalInvoiceItemId: uuid('original_invoice_item_id').references((): any => invoiceItems.id),
}, (table) => ({
  invoiceIdIdx: index('invoice_items_invoice_id_idx').on(table.invoiceId),
  tenantIsolationPolicy: pgPolicy('invoice_items_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`EXISTS (SELECT 1 FROM ${invoices} WHERE ${invoices.id} = ${table.invoiceId} AND ${invoices.companyId} = current_setting('app.company_id', true)::uuid)`,
    withCheck: sql`EXISTS (SELECT 1 FROM ${invoices} WHERE ${invoices.id} = ${table.invoiceId} AND ${invoices.companyId} = current_setting('app.company_id', true)::uuid)`,
  }),
})).enableRLS();

export const expenses = pgTable('expenses', {
  id: uuid('id').primaryKey(),
  expenseNumber: text('expense_number').notNull(),
  docDate: businessDate('doc_date').notNull(), // the vendor bill's date
  postingDate: businessDate('posting_date').notNull(), // the ledger / period date
  dueDate: businessDate('due_date'), // payment due
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
  updatedAt: timestamp('updated_at'),
  updatedById: uuid('updated_by_id').references(() => users.id),
  classification: text('classification'),
  assetType: text('asset_type'),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  amountPaid: decimal('amount_paid', { precision: 14, scale: 2 }),
  isPosSale: boolean('is_pos_sale').default(false),
  shiftId: uuid('shift_id').references(() => posShifts.id),
  attachmentUrl: text('attachment_url'),
  // Nullable, additive — see quotations.branchId's comment.
  branchId: uuid('branch_id').references(() => branches.id),
  // The vendor's own bill/receipt reference number — nullable at the DB level (existing
  // rows predate this field), but the create form and POST /api/expenses both require it
  // for every NEW expense going forward. Free text, not unique: different vendors can
  // legitimately reuse the same bill number.
  billNumber: text('bill_number'),
  // Fixed pre-filled category for an ordinary (OpEx) expense — independent of
  // classification/assetType above, which only applies to a Fixed Asset (CapEx) purchase.
  // Nullable/additive like billNumber; enforced against a fixed option list at the
  // application layer (ExpenseModule.tsx), not a DB-level check constraint.
  expenseType: text('expense_type'),
  // Set only on a REVERSAL document: the expense of a closed month (or locked quarter) that cannot be cancelled is corrected by a new,
  // negative expense dated today in the current period, linked back to the original through this id. Nullable/additive.
  reversalOfExpenseId: uuid('reversal_of_expense_id'),
}, (table) => ({
  docDateIdx: index('expenses_company_doc_date_idx').on(table.companyId, table.docDate),
  companyIdIdx: index('expenses_company_id_idx').on(table.companyId),
  originAccrualFk: index('expenses_origin_accrual_idx').on(table.originAccrualId),
  tenantIsolationPolicy: pgPolicy('expenses_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

export const expenseItems = pgTable('expense_items', {
  id: uuid('id').primaryKey(),
  expenseId: uuid('expense_id').references(() => expenses.id).notNull(),
  description: text('description').notNull(),
  unitCost: decimal('unit_cost', { precision: 12, scale: 2 }).notNull(),
  quantity: decimal('quantity', { precision: 10, scale: 2 }).notNull(),
}, (table) => ({
  expenseIdIdx: index('expense_items_expense_id_idx').on(table.expenseId),
  tenantIsolationPolicy: pgPolicy('expense_items_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`EXISTS (SELECT 1 FROM ${expenses} WHERE ${expenses.id} = ${table.expenseId} AND ${expenses.companyId} = current_setting('app.company_id', true)::uuid)`,
    withCheck: sql`EXISTS (SELECT 1 FROM ${expenses} WHERE ${expenses.id} = ${table.expenseId} AND ${expenses.companyId} = current_setting('app.company_id', true)::uuid)`,
  }),
})).enableRLS();

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
  tenantIsolationPolicy: pgPolicy('recurring_expense_templates_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
  tenantIsolationPolicy: pgPolicy('recurring_postings_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

export const vouchers = pgTable('vouchers', {
  id: uuid('id').primaryKey(),
  voucherNumber: text('voucher_number').notNull(),
  type: text('type').notNull(),
  docDate: businessDate('doc_date').notNull(), // the receipt / payment date
  postingDate: businessDate('posting_date').notNull(), // the ledger / period date
  valueDate: businessDate('value_date'), // the bank's value date
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
  // Set only on a type='Reversal' row, pointing at the specific Receipt/Payment voucher
  // it reverses — mirrors journalEntries.reversalOfId's own comment/reasoning exactly.
  // Without this link, a Reversal could only be matched to "any voucher for this
  // referenceId" rather than one specific original, which is what let a second Receipt
  // voucher (e.g. a later installment posted via POST /invoices/:id/paid, alongside an
  // earlier one from creation) go permanently unreversed on cancel — see
  // syncVoucherForInvoice's own comment for the live incident this was found from.
  reversalOfVoucherId: uuid('reversal_of_voucher_id').references((): any => vouchers.id),
}, (table) => ({
  docDateIdx: index('vouchers_company_doc_date_idx').on(table.companyId, table.docDate),
  idCompanyUnique: unique('vouchers_id_company_unique').on(table.companyId, table.id), // target of the composite key of payment_allocations
  companyIdIdx: index('vouchers_company_id_idx').on(table.companyId),
  referenceIdIdx: index('vouchers_reference_id_idx').on(table.referenceId),
  reversalOfVoucherUniqueIdx: uniqueIndex('vouchers_reversal_of_voucher_unique_idx').on(table.reversalOfVoucherId).where(sql`${table.reversalOfVoucherId} IS NOT NULL`),
  tenantIsolationPolicy: pgPolicy('vouchers_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

// The fixed, canonical set of accounts every ledger posting refers to by key — see
// docs/procurement-ledger-review (Phase 1 design) for the full rationale. Genuinely
// cross-tenant by design (no companyId column, same convention as `translations` above):
// every company reads the same fixed account list today. When a real company-configurable
// chart of accounts ships, a separate `companyAccountMappings(companyId, systemAccountKey,
// realAccountCode, realAccountName)` table attaches to these same keys without a schema
// change here.
export const systemAccounts = pgTable('system_accounts', {
  key: text('key').primaryKey(), // 'AR' | 'AP' | 'COGS' | 'VAT_OUTPUT' | ... — see the seed list
  code: text('code').notNull(), // display code, e.g. '1100' — cosmetic only, not sorted/indexed on
  name: text('name').notNull(),
  type: text('type').notNull(), // 'Asset' | 'Liability' | 'Equity' | 'Revenue' | 'Expense'
  normalBalance: text('normal_balance').notNull(), // 'Debit' | 'Credit' — which side a positive balance displays as
}, (table) => ({
  tenantIsolationPolicy: pgPolicy('system_accounts_shared_access', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`true`,
    withCheck: sql`true`,
  }),
})).enableRLS();

// A company's own chart of accounts (General Ledger Step 1). Every company gets a standard Saudi starter chart (server/lib/chartOfAccounts.ts) that it
// may rename, recode and extend. `systemKey` ties an account to one of the fixed posting roles above (AR, AP, VAT output...): the document routes keep
// posting by systemKey, and this table is what makes that key mean "this company's account 1100" without changing a single existing journal line.
// Foreign keys that carry the company (parent, journal lines, manual journal lines) are COMPOSITE (id, company_id), so the database itself refuses a
// reference to another company's account, on top of the row-level-security policy and the route's own ownership checks.
export const companyAccounts = pgTable('company_accounts', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  nameAr: text('name_ar'),
  type: text('type').notNull(), // 'Asset' | 'Liability' | 'Equity' | 'Revenue' | 'Expense'
  parentId: uuid('parent_id'),
  isGroup: boolean('is_group').notNull().default(false), // a heading: takes no postings of its own
  systemKey: text('system_key').references(() => systemAccounts.key),
  isControl: boolean('is_control').notNull().default(false), // receivables, payables, inventory, GR/IR, VAT, vendor credit, banks: no manual lines
  // Which subledger owns the account: only that subledger's documents post to it. A company may have several per type (Trade receivables, Staff receivables);
  // a customer / vendor names its own control account. null = an ordinary account. Control accounts of the chart always have one.
  subledgerType: text('subledger_type'), // 'customer' | 'vendor' | 'inventory' | 'bank' | 'tax' | 'clearing' | 'other'
  bankId: uuid('bank_id').references(() => bankAccounts.id), // set on the account auto-made for a bank / cash account
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  companyIdIdx: index('company_accounts_company_id_idx').on(table.companyId),
  codeUnique: uniqueIndex('company_accounts_company_code_unique').on(table.companyId, table.code),
  // Target of the composite (id, company_id) foreign keys that keep every reference inside one company. Declared (company_id, id): drizzle-kit reads a
  // constraint's columns back in that order, and a different declared order makes every db:push try to drop and re-add it (which fails: foreign keys depend on it).
  idCompanyUnique: unique('company_accounts_id_company_unique').on(table.companyId, table.id),
  systemKeyUnique: uniqueIndex('company_accounts_company_system_key_unique').on(table.companyId, table.systemKey).where(sql`system_key IS NOT NULL`),
  bankUnique: uniqueIndex('company_accounts_company_bank_unique').on(table.companyId, table.bankId).where(sql`bank_id IS NOT NULL`),
  parentFk: foreignKey({ name: 'company_accounts_parent_company_fk', columns: [table.parentId, table.companyId], foreignColumns: [table.id, table.companyId] }),
  typeCheck: check('company_accounts_type_check', sql`${table.type} IN ('Asset','Liability','Equity','Revenue','Expense')`),
  subledgerCheck: check('company_accounts_subledger_check', sql`${table.subledgerType} IS NULL OR ${table.subledgerType} IN ('customer','vendor','inventory','bank','tax','clearing','other')`),
  tenantIsolationPolicy: pgPolicy('company_accounts_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

// Journal entry header — one row per posted transaction. Every report that needs a
// real, reconciling account balance (AR, AP, VAT, COGS, ...) reads from journalLines
// below, never straight from invoices/expenses/purchaseBills, the same way vouchers
// already exist for cash movement but nothing else. See the Phase 1 design doc for the
// full posting-rules table (currently 19 transaction types) this implements.
export const journalEntries = pgTable('journal_entries', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  // Nullable, inherited from the source document — same convention as vouchers.branchId.
  branchId: uuid('branch_id').references(() => branches.id),
  postingDate: businessDate('posting_date').notNull(), // the date the ledger and every period lock use
  docDate: businessDate('doc_date').notNull(), // the date of the source document (equals postingDate unless the document was posted into a later period)
  referenceType: text('reference_type').notNull(), // 'Invoice' | 'CreditNote' | 'Expense' | 'PurchaseBill' | 'PurchaseReturn' | 'GRN' | 'Voucher' | 'Transfer' | 'FiscalMonthClose' | 'VatReturn'
  referenceId: uuid('reference_id').notNull(), // polymorphic, same convention as vouchers.referenceId
  // Second, optional reference pair — used only by the rare cross-document transaction
  // (e.g. applying a Vendor Credit against a bill needs to record both which bill was
  // reduced and which credit was drawn down). Left null by every other transaction type.
  relatedReferenceType: text('related_reference_type'),
  relatedReferenceId: uuid('related_reference_id'),
  // Set when this entry reverses an earlier one — reversing a document means finding
  // every non-reversed journalEntries row for that referenceId and posting a mirrored
  // reversal for each, never assuming there is only one.
  reversalOfId: uuid('reversal_of_id').references((): any => journalEntries.id),
  description: text('description').notNull(),
  createdById: uuid('created_by_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  postingDateIdx: index('journal_entries_company_posting_date_idx').on(table.companyId, table.postingDate),
  companyIdIdx: index('journal_entries_company_id_idx').on(table.companyId),
  referenceIdIdx: index('journal_entries_reference_id_idx').on(table.referenceId),
  // An entry can only ever be reversed once — a retried request or a race condition
  // must not be able to double-reverse the same entry (the exact bug class Findings 7/8
  // in the review fixed, just running in the opposite direction).
  reversalOfUniqueIdx: uniqueIndex('journal_entries_reversal_of_unique_idx').on(table.reversalOfId).where(sql`${table.reversalOfId} IS NOT NULL`),
  tenantIsolationPolicy: pgPolicy('journal_entries_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

export const journalLines = pgTable('journal_lines', {
  id: uuid('id').primaryKey(),
  journalEntryId: uuid('journal_entry_id').notNull().references(() => journalEntries.id),
  // Denormalized directly onto the line, same precedent as stockLedgerTransactions.companyId —
  // this table is queried heavily ("sum every AP line for company X") and shouldn't need a
  // join back to the header just to scope by company.
  companyId: uuid('company_id').notNull().references(() => companies.id),
  // A line made by a document names its posting role (accountKey). A line made by a manual journal or an opening entry names a company account
  // directly (accountId) and has no key. At least one of the two is always set.
  accountKey: text('account_key').references(() => systemAccounts.key),
  accountId: uuid('account_id'),
  debit: decimal('debit', { precision: 14, scale: 2 }).notNull().default('0'),
  credit: decimal('credit', { precision: 14, scale: 2 }).notNull().default('0'),
  // Set only when accountKey = 'BANK' — Bank isn't one pooled account, it's N separate
  // ones, same as vouchers.bankId.
  bankId: uuid('bank_id').references(() => bankAccounts.id),
  // Branch / Department / any custom dimension tags of this line, resolved to one deduplicated combination (Finance Core Blueprint FR-DIM-01).
  dimensionCombinationId: uuid('dimension_combination_id'),
  // The party a receivable / payable line belongs to (Blueprint FR-APR-06: strongly typed, not part of the dimension bag). Set by the posting engine on every line that
  // posts to a customer or vendor control account, from the same party context that picked the account, so the subledger of a party is a query over these lines.
  customerId: uuid('customer_id'),
  vendorId: uuid('vendor_id'),
  // Bank reconciliation (Blueprint FR-BANK-02/05): a line of a bank account is 'cleared' by one reconciliation session; once that session is completed the line is locked
  // (the entry that carries it cannot be reversed until the session is reopened). Null = not cleared yet.
  bankReconciliationId: uuid('bank_reconciliation_id'),
  reconciledAt: timestamp('reconciled_at'),
}, (table) => ({
  companyIdIdx: index('journal_lines_company_id_idx').on(table.companyId),
  reconciliationIdx: index('journal_lines_reconciliation_idx').on(table.companyId, table.bankReconciliationId).where(sql`bank_reconciliation_id IS NOT NULL`),
  reconciliationFk: foreignKey({ name: 'journal_lines_reconciliation_company_fk', columns: [table.bankReconciliationId, table.companyId], foreignColumns: [bankReconciliations.id, bankReconciliations.companyId] }),
  customerIdx: index('journal_lines_customer_idx').on(table.companyId, table.customerId).where(sql`customer_id IS NOT NULL`),
  vendorIdx: index('journal_lines_vendor_idx').on(table.companyId, table.vendorId).where(sql`vendor_id IS NOT NULL`),
  customerFk: foreignKey({ name: 'journal_lines_customer_company_fk', columns: [table.customerId, table.companyId], foreignColumns: [customers.id, customers.companyId] }),
  vendorFk: foreignKey({ name: 'journal_lines_vendor_company_fk', columns: [table.vendorId, table.companyId], foreignColumns: [vendors.id, vendors.companyId] }),
  dimensionCombinationIdx: index('journal_lines_dimension_combination_idx').on(table.companyId, table.dimensionCombinationId),
  dimensionCombinationFk: foreignKey({ name: 'journal_lines_dimension_combination_company_fk', columns: [table.dimensionCombinationId, table.companyId], foreignColumns: [dimensionCombinations.id, dimensionCombinations.companyId] }),
  journalEntryIdIdx: index('journal_lines_journal_entry_id_idx').on(table.journalEntryId),
  accountKeyIdx: index('journal_lines_account_key_idx').on(table.accountKey),
  accountIdIdx: index('journal_lines_account_id_idx').on(table.accountId),
  accountCompanyFk: foreignKey({ name: 'journal_lines_account_company_fk', columns: [table.accountId, table.companyId], foreignColumns: [companyAccounts.id, companyAccounts.companyId] }),
  keyOrAccountCheck: check('journal_lines_key_or_account_check', sql`${table.accountKey} IS NOT NULL OR ${table.accountId} IS NOT NULL`),
  // Exactly one of debit/credit is non-zero per line — a real double-entry line is never
  // both or neither.
  exactlyOneSideCheck: check('journal_lines_exactly_one_side_check', sql`(${table.debit} > 0 AND ${table.credit} = 0) OR (${table.debit} = 0 AND ${table.credit} > 0)`),
  tenantIsolationPolicy: pgPolicy('journal_lines_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
  tenantIsolationPolicy: pgPolicy('investors_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

export const translations = pgTable('translations', {
  id: uuid('id').primaryKey(),
  key: text('key').notNull(),
  en: text('en').notNull(),
  ar: text('ar').notNull(),
  ur: text('ur').notNull(),
}, (table) => ({
  // Genuinely cross-tenant by design (no companyId column at all — see the table's own
  // header comment) — RLS is still enabled with an explicit allow-all policy rather than
  // left off entirely, so this is an auditable, deliberate choice, not an accidental gap.
  tenantIsolationPolicy: pgPolicy('translations_shared_access', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`true`,
    withCheck: sql`true`,
  }),
})).enableRLS();

// Cross-tenant by design — deliberately NOT company-scoped, unlike `roles` above (whose
// companyId is NOT NULL). A reusable, platform-curated permission-set library, same JSON
// shape as roles.permissions, that gets CLONED into a brand-new company's own `roles`
// table at company-onboarding-approval time (server/routes/onboarding.ts) — a just-created
// company has no roles of its own yet, so picking an existing one isn't possible.
export const roleTemplates = pgTable('role_templates', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  permissions: jsonb('permissions').notNull().default({}),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  nameUnique: uniqueIndex('role_templates_name_unique').on(table.name),
  // Cross-tenant by design — see the table's own header comment. Allow-all, same
  // reasoning as translations above.
  tenantIsolationPolicy: pgPolicy('role_templates_shared_access', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`true`,
    withCheck: sql`true`,
  }),
})).enableRLS();

// Cross-tenant by design, same reasoning as roleTemplates above — submitted by a
// prospective customer before any company or session exists. `createdCompanyId` is only
// ever set once a request is Approved; every other tenant-facing table this app has is
// scoped by a companyId that plainly doesn't exist yet at submission time.
export const companyOnboardingRequests = pgTable('company_onboarding_requests', {
  id: uuid('id').primaryKey(),
  companyName: text('company_name').notNull(),
  companyEmail: text('company_email').notNull(),
  companyPhone: text('company_phone'),
  companyAddress: text('company_address'),
  vatNumber: text('vat_number'),
  crNumber: text('cr_number'),
  currency: text('currency').default('SAR'),
  contactName: text('contact_name').notNull(),
  contactEmail: text('contact_email').notNull(),
  contactPhone: text('contact_phone'),
  notes: text('notes'),
  status: text('status').notNull().default('Pending'), // 'Pending' | 'Approved' | 'Rejected'
  reviewedById: uuid('reviewed_by_id').references(() => users.id),
  reviewedAt: timestamp('reviewed_at'),
  rejectionReason: text('rejection_reason'),
  createdCompanyId: uuid('created_company_id').references(() => companies.id),
  createdAt: timestamp('created_at').defaultNow(),
  // Proof the submitter actually controls contactEmail before a super-admin can approve
  // — set once, the moment the emailed confirmation link is clicked (see the public
  // POST /onboarding-requests/confirm-email route); null until then. Approve rejects
  // outright while this is null (server/routes/onboarding.ts), and the admin-notification
  // email itself doesn't fire until this is set — an unverified submission never even
  // reaches a super-admin's inbox. The token fields below are the SHA-256-hashed,
  // 1-hour-expiring, single-use credential for that link, mirroring passwordResetTokens'
  // own hash-not-plaintext convention exactly; cleared (nulled) once consumed. A super-
  // admin can regenerate a fresh pair via the "Resend Confirmation" action if the
  // original link expired unused — see the admin resend-confirmation route.
  emailVerifiedAt: timestamp('email_verified_at'),
  emailConfirmTokenHash: text('email_confirm_token_hash'),
  emailConfirmExpiresAt: timestamp('email_confirm_expires_at'),
}, (table) => ({
  // Cross-tenant by design — see the table's own header comment (submitted before any
  // company exists). Allow-all, same reasoning as translations/roleTemplates above.
  tenantIsolationPolicy: pgPolicy('company_onboarding_requests_shared_access', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`true`,
    withCheck: sql`true`,
  }),
})).enableRLS();

// Cross-tenant by design — a tombstone for the "Delete Company & All Data" purge
// (server/routes/companies.ts). Deliberately NOT a live FK to companies.id: by the time
// this row is read back, the company it describes no longer exists (that's the whole
// point of the purge), so companyId here is just a plain identifying value, not a
// reference. Survives on its own after everything else belonging to that company —
// including its own auditLogs — has been deleted, so "who purged what, when" is never lost.
export const deletedCompanyLog = pgTable('deleted_company_log', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull(),
  companyName: text('company_name').notNull(),
  deletedByUserId: uuid('deleted_by_user_id').notNull(),
  deletedByUsername: text('deleted_by_username').notNull(),
  deletedAt: timestamp('deleted_at').defaultNow(),
}, (table) => ({
  // Cross-tenant tombstone by design — see the table's own header comment (the company it
  // describes no longer exists by the time this is read). Allow-all, same reasoning as
  // translations/roleTemplates/companyOnboardingRequests above.
  tenantIsolationPolicy: pgPolicy('deleted_company_log_shared_access', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`true`,
    withCheck: sql`true`,
  }),
})).enableRLS();

// Platform-wide, single-row announcement banner (id is always the literal 'singleton') —
// not company-scoped at all, and only ever written/read via the superuser db from
// server/routes/systemBanner.ts, same as user_sessions/zatca.ts stay on superuser db by
// design. RLS still enabled with an explicit allow-all policy so that's an auditable
// choice, not an accidental gap — same convention as translations/companyOnboardingRequests.
export const systemBanner = pgTable('system_banner', {
  id: text('id').primaryKey().default('singleton'),
  enabled: boolean('enabled').notNull().default(false),
  message: text('message').notNull().default(''),
  updatedBy: uuid('updated_by').references(() => users.id),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  tenantIsolationPolicy: pgPolicy('system_banner_shared_access', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`true`,
    withCheck: sql`true`,
  }),
})).enableRLS();

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
  tenantIsolationPolicy: pgPolicy('pos_held_invoices_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
  // User-scoped, not company-scoped directly — via the owning user's own companyId.
  // Inert today (the forgot-password routes stay on the superuser db — this table has no
  // company context to bind at the pre-session point those routes run at), but covered
  // for schema-level completeness per this project's "every table" RLS rule.
  tenantIsolationPolicy: pgPolicy('password_reset_tokens_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`EXISTS (SELECT 1 FROM ${users} WHERE ${users.id} = ${table.userId} AND ${users.companyId} = current_setting('app.company_id', true)::uuid)`,
    withCheck: sql`EXISTS (SELECT 1 FROM ${users} WHERE ${users.id} = ${table.userId} AND ${users.companyId} = current_setting('app.company_id', true)::uuid)`,
  }),
})).enableRLS();

// Owned by the `connect-pg-simple` session-store library, not app-generated —
// intentionally excluded from the UUID migration. `sid`/`sess`/`expire` are the only
// columns that library's own queries ever read or write (its INSERT/UPDATE statements
// name columns explicitly), so the three columns below are safe app-level additions
// piggybacking on the same row — connect-pg-simple neither knows about nor touches them.
// Populated at login and refreshed on each authenticated request (see server.ts's
// isAuthenticated/login-route session-lifecycle comments); used by the admin "active
// sessions" list/revoke feature (server/routes/sessions.ts) to avoid parsing the opaque
// `sess` JSON blob for every row on every list request.
export const user_sessions = pgTable('user_sessions', {
  sid: text('sid').primaryKey(),
  sess: jsonb('sess').notNull(),
  expire: timestamp('expire', { precision: 6, mode: 'date' }).notNull(),
  // `onDelete: 'cascade'` deliberately — a session for a deleted user/company is
  // meaningless, and without this, deleting a user with any stale-but-unexpired session
  // row (a real login some test/admin action never explicitly logged out of) throws a FK
  // violation instead of succeeding. Confirmed live: without cascade, several existing
  // tests' own afterAll user-cleanup broke the moment these columns were added.
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),
  lastActivity: timestamp('last_activity', { mode: 'date' }),
}, (table) => ({
  // This table's real traffic (the connect-pg-simple session-store library's own reads/
  // writes, plus the admin session list/revoke routes which deliberately cross companies)
  // stays on the superuser db permanently — see .claude/skills/rls-tenant-isolation. This
  // policy exists for schema-level completeness, matching auditLogs' own nullable-companyId
  // treatment (a NULL-company row is invisible under a tenant-scoped connection).
  tenantIsolationPolicy: pgPolicy('user_sessions_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
  // companyId is nullable (system-level entries with no attributable company) — a NULL
  // row is simply invisible under a tenant-scoped connection, which is correct: a tenant
  // has no legitimate reason to see one. A true cross-company audit view stays on the
  // superuser db, matching how it already works today (server.ts falls back to a
  // never-matching filter when req.targetCompanyId is falsy).
  tenantIsolationPolicy: pgPolicy('audit_logs_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
  tenantIsolationPolicy: pgPolicy('inventory_stocks_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
}, (table) => ({
  companyIdIdx: index('units_of_measure_company_id_idx').on(table.companyId),
  tenantIsolationPolicy: pgPolicy('units_of_measure_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
  tenantIsolationPolicy: pgPolicy('modifier_groups_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

export const modifierChoices = pgTable('modifier_choices', {
  id: uuid('id').primaryKey(),
  modifierGroupId: uuid('modifier_group_id').references(() => modifierGroups.id).notNull(),
  label: text('label').notNull(), // e.g. "Medium", "Oat Milk"
  priceDelta: decimal('price_delta', { precision: 10, scale: 2 }).notNull().default('0'),
  sortOrder: integer('sort_order'),
}, (table) => ({
  groupIdIdx: index('modifier_choices_group_id_idx').on(table.modifierGroupId),
  tenantIsolationPolicy: pgPolicy('modifier_choices_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`EXISTS (SELECT 1 FROM ${modifierGroups} WHERE ${modifierGroups.id} = ${table.modifierGroupId} AND ${modifierGroups.companyId} = current_setting('app.company_id', true)::uuid)`,
    withCheck: sql`EXISTS (SELECT 1 FROM ${modifierGroups} WHERE ${modifierGroups.id} = ${table.modifierGroupId} AND ${modifierGroups.companyId} = current_setting('app.company_id', true)::uuid)`,
  }),
})).enableRLS();

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
  // Dual-parent junction (productsServices + modifierGroups) — checked via the
  // productsServices side only, relying on the existing app-level invariant that both
  // sides belong to the same company (assertModifierGroupsOwnedByCompany).
  tenantIsolationPolicy: pgPolicy('product_modifier_groups_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`EXISTS (SELECT 1 FROM ${productsServices} WHERE ${productsServices.id} = ${table.productId} AND ${productsServices.companyId} = current_setting('app.company_id', true)::uuid)`,
    withCheck: sql`EXISTS (SELECT 1 FROM ${productsServices} WHERE ${productsServices.id} = ${table.productId} AND ${productsServices.companyId} = current_setting('app.company_id', true)::uuid)`,
  }),
})).enableRLS();

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
  tenantIsolationPolicy: pgPolicy('product_unit_conversions_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
}, (table) => ({
  companyIdIdx: index('product_warehouses_company_id_idx').on(table.companyId),
  tenantIsolationPolicy: pgPolicy('product_warehouses_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
}, (table) => ({
  companyIdIdx: index('gl_group_mappings_company_id_idx').on(table.companyId),
  tenantIsolationPolicy: pgPolicy('gl_group_mappings_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

// 4. Purchase Requisitions (PR)
export const purchaseRequisitions = pgTable('purchase_requisitions', {
  id: uuid('id').primaryKey(),
  prNumber: text('pr_number').notNull(),
  requestedBy: text('requested_by').notNull(), // User ID or Name (loosely typed by design) — stays text
  docDate: businessDate('doc_date').notNull(), // the date of the document
  createdAt: timestamp('created_at').notNull(), // when it was entered (the system clock); keeps the order of documents within a day
  createdById: uuid('created_by_id').references(() => users.id), // who entered it (empty on documents that predate this field)
  status: text('status').default('Draft').notNull(), // 'Draft', 'Pending', 'Approved', 'Rejected', 'Closed'
  notes: text('notes'),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  // Direct branchId (unlike GRN/Returns/StockTakes, a PR has no warehouseId to derive
  // branch from) — nullable, additive, see quotations.branchId's comment.
  branchId: uuid('branch_id').references(() => branches.id),
}, (table) => ({
  docDateIdx: index('purchase_requisitions_company_doc_date_idx').on(table.companyId, table.docDate),
  companyIdIdx: index('purchase_requisitions_company_id_idx').on(table.companyId),
  tenantIsolationPolicy: pgPolicy('purchase_requisitions_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

export const purchaseRequisitionItems = pgTable('purchase_requisition_items', {
  id: uuid('id').primaryKey(),
  requisitionId: uuid('requisition_id').notNull().references(() => purchaseRequisitions.id),
  productId: uuid('product_id').notNull().references(() => productsServices.id),
  quantity: decimal('quantity', { precision: 12, scale: 3 }).notNull(),
  purpose: text('purpose'),
}, (table) => ({
  requisitionIdIdx: index('purchase_requisition_items_requisition_id_idx').on(table.requisitionId),
  tenantIsolationPolicy: pgPolicy('purchase_requisition_items_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`EXISTS (SELECT 1 FROM ${purchaseRequisitions} WHERE ${purchaseRequisitions.id} = ${table.requisitionId} AND ${purchaseRequisitions.companyId} = current_setting('app.company_id', true)::uuid)`,
    withCheck: sql`EXISTS (SELECT 1 FROM ${purchaseRequisitions} WHERE ${purchaseRequisitions.id} = ${table.requisitionId} AND ${purchaseRequisitions.companyId} = current_setting('app.company_id', true)::uuid)`,
  }),
})).enableRLS();

// 5. Purchase Orders (PO)
export const purchaseOrders = pgTable('purchase_orders', {
  id: uuid('id').primaryKey(),
  poNumber: text('po_number').notNull(),
  vendorId: uuid('vendor_id').notNull().references(() => vendors.id),
  docDate: businessDate('doc_date').notNull(), // the date of the document
  createdAt: timestamp('created_at').notNull(), // when it was entered (the system clock); keeps the order of documents within a day
  createdById: uuid('created_by_id').references(() => users.id), // who entered it (empty on documents that predate this field)
  status: text('status').default('Draft').notNull(), // 'Draft', 'Sent', 'Partially Received', 'Received', 'Cancelled'
  requisitionId: uuid('requisition_id').references(() => purchaseRequisitions.id), // Optional link to PR
  deliveryDate: businessDate('delivery_date'),
  totalAmount: decimal('total_amount', { precision: 12, scale: 2 }).notNull(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  branchId: uuid('branch_id').references(() => branches.id),
}, (table) => ({
  docDateIdx: index('purchase_orders_company_doc_date_idx').on(table.companyId, table.docDate),
  companyIdIdx: index('purchase_orders_company_id_idx').on(table.companyId),
  tenantIsolationPolicy: pgPolicy('purchase_orders_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
}, (table) => ({
  purchaseOrderIdIdx: index('purchase_order_items_purchase_order_id_idx').on(table.purchaseOrderId),
  tenantIsolationPolicy: pgPolicy('purchase_order_items_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`EXISTS (SELECT 1 FROM ${purchaseOrders} WHERE ${purchaseOrders.id} = ${table.purchaseOrderId} AND ${purchaseOrders.companyId} = current_setting('app.company_id', true)::uuid)`,
    withCheck: sql`EXISTS (SELECT 1 FROM ${purchaseOrders} WHERE ${purchaseOrders.id} = ${table.purchaseOrderId} AND ${purchaseOrders.companyId} = current_setting('app.company_id', true)::uuid)`,
  }),
})).enableRLS();

// 6. Goods Receipt Notes (GRN)
export const goodsReceiptNotes = pgTable('goods_receipt_notes', {
  id: uuid('id').primaryKey(),
  grnNumber: text('grn_number').notNull(),
  purchaseOrderId: uuid('purchase_order_id').references(() => purchaseOrders.id), // Nullable for DSD (Direct Shop Delivery)
  vendorId: uuid('vendor_id').notNull().references(() => vendors.id),
  warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
  docDate: businessDate('doc_date').notNull(), // the date of the document
  postingDate: businessDate('posting_date').notNull(), // the ledger / stock-ledger / period date
  createdAt: timestamp('created_at').notNull(), // when it was entered (the system clock); keeps the order of documents within a day
  createdById: uuid('created_by_id').references(() => users.id), // who entered it (empty on documents that predate this field)
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
}, (table) => ({
  docDateIdx: index('goods_receipt_notes_company_doc_date_idx').on(table.companyId, table.docDate),
  companyIdIdx: index('goods_receipt_notes_company_id_idx').on(table.companyId),
  tenantIsolationPolicy: pgPolicy('goods_receipt_notes_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
}, (table) => ({
  grnIdIdx: index('goods_receipt_note_items_grn_id_idx').on(table.grnId),
  tenantIsolationPolicy: pgPolicy('goods_receipt_note_items_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`EXISTS (SELECT 1 FROM ${goodsReceiptNotes} WHERE ${goodsReceiptNotes.id} = ${table.grnId} AND ${goodsReceiptNotes.companyId} = current_setting('app.company_id', true)::uuid)`,
    withCheck: sql`EXISTS (SELECT 1 FROM ${goodsReceiptNotes} WHERE ${goodsReceiptNotes.id} = ${table.grnId} AND ${goodsReceiptNotes.companyId} = current_setting('app.company_id', true)::uuid)`,
  }),
})).enableRLS();

// 7. Purchase Bills / Invoices
export const purchaseBills = pgTable('purchase_bills', {
  id: uuid('id').primaryKey(),
  billNumber: text('bill_number').notNull(),
  // The VENDOR's own bill/invoice reference number — distinct from billNumber above,
  // which is this system's own auto-generated sequence (PB-1001…). Nullable (never
  // .notNull() on an existing table with real production rows in other companies) but
  // enforced as required at the application layer for every new bill, same pattern as
  // expenses.billNumber — without it there was no paper trail linking a system Bill back
  // to the vendor's actual physical invoice.
  vendorBillNumber: text('vendor_bill_number'),
  vendorId: uuid('vendor_id').notNull().references(() => vendors.id),
  docDate: businessDate('doc_date').notNull(), // the date of the document
  postingDate: businessDate('posting_date').notNull(), // the ledger / stock-ledger / period date
  createdAt: timestamp('created_at').notNull(), // when it was entered (the system clock); keeps the order of documents within a day
  createdById: uuid('created_by_id').references(() => users.id), // who entered it (empty on documents that predate this field)
  dueDate: businessDate('due_date'),
  grnIds: text('grn_ids').notNull(), // Comma-separated or JSON list of referenced GRNs — multi-value, stays text
  subTotal: decimal('sub_total', { precision: 12, scale: 2 }).notNull(),
  taxTotal: decimal('tax_total', { precision: 12, scale: 2 }).notNull(),
  grandTotal: decimal('grand_total', { precision: 12, scale: 2 }).notNull(),
  status: text('status').default('Unpaid').notNull(), // 'Unpaid', 'Partially Paid', 'Paid', 'Cancelled'
  amountPaid: decimal('amount_paid', { precision: 12, scale: 2 }).default('0').notNull(),
  bankId: uuid('bank_id').references(() => bankAccounts.id),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  branchId: uuid('branch_id').references(() => branches.id),
}, (table) => ({
  docDateIdx: index('purchase_bills_company_doc_date_idx').on(table.companyId, table.docDate),
  companyIdIdx: index('purchase_bills_company_id_idx').on(table.companyId),
  tenantIsolationPolicy: pgPolicy('purchase_bills_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

// 8. Purchase Returns (Debit Notes)
export const purchaseReturns = pgTable('purchase_returns', {
  // How much of the return (gross) reduced the bill it came from. The rest of the return was ALREADY paid to the vendor and is a vendor
  // credit receivable, never a negative payable. Null on older rows: their bill was reduced by the whole return, or not at all (billTotalsReduced).
  billReduction: decimal('bill_reduction', { precision: 14, scale: 2 }),
  id: uuid('id').primaryKey(),
  returnNumber: text('return_number').notNull(),
  grnId: uuid('grn_id').notNull().references(() => goodsReceiptNotes.id), // Links back to receipt
  vendorId: uuid('vendor_id').notNull().references(() => vendors.id),
  warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
  docDate: businessDate('doc_date').notNull(), // the date of the document
  postingDate: businessDate('posting_date').notNull(), // the ledger / stock-ledger / period date
  createdAt: timestamp('created_at').notNull(), // when it was entered (the system clock); keeps the order of documents within a day
  createdById: uuid('created_by_id').references(() => users.id), // who entered it (empty on documents that predate this field)
  notes: text('notes'),
  status: text('status').default('Active').notNull(), // 'Active', 'Cancelled'
  // Input-VAT bookkeeping, set only when the GRN was already BILLED at return time (see
  // server/lib/inputVat.ts): the owning bill, the net value and VAT given back, and whether the bill's own
  // stored totals were reduced to match (only when the bill was not yet fully paid). The VAT return
  // records this adjustment in the RETURN's tax period, and cancelling the return restores the bill.
  billId: uuid('bill_id').references(() => purchaseBills.id),
  netAdjustment: decimal('net_adjustment', { precision: 14, scale: 2 }),
  inputVatAdjustment: decimal('input_vat_adjustment', { precision: 14, scale: 2 }),
  billTotalsReduced: boolean('bill_totals_reduced').default(false).notNull(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
}, (table) => ({
  docDateIdx: index('purchase_returns_company_doc_date_idx').on(table.companyId, table.docDate),
  companyIdIdx: index('purchase_returns_company_id_idx').on(table.companyId),
  tenantIsolationPolicy: pgPolicy('purchase_returns_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
}, (table) => ({
  returnIdIdx: index('purchase_return_items_return_id_idx').on(table.returnId),
  tenantIsolationPolicy: pgPolicy('purchase_return_items_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`EXISTS (SELECT 1 FROM ${purchaseReturns} WHERE ${purchaseReturns.id} = ${table.returnId} AND ${purchaseReturns.companyId} = current_setting('app.company_id', true)::uuid)`,
    withCheck: sql`EXISTS (SELECT 1 FROM ${purchaseReturns} WHERE ${purchaseReturns.id} = ${table.returnId} AND ${purchaseReturns.companyId} = current_setting('app.company_id', true)::uuid)`,
  }),
})).enableRLS();

// 9. Physical Stock Takes
export const physicalStockTakes = pgTable('physical_stock_takes', {
  id: uuid('id').primaryKey(),
  referenceNumber: text('reference_number').notNull(),
  warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
  docDate: businessDate('doc_date').notNull(), // the date of the document
  postingDate: businessDate('posting_date').notNull(), // the ledger / stock-ledger / period date
  createdAt: timestamp('created_at').notNull(), // when it was entered (the system clock); keeps the order of documents within a day
  createdById: uuid('created_by_id').references(() => users.id), // who entered it (empty on documents that predate this field)
  status: text('status').default('Draft').notNull(), // 'Draft', 'Completed' (Adjustments Posted), 'Cancelled'
  performedBy: text('performed_by').notNull(), // User ID or Name (loosely typed by design) — stays text
  notes: text('notes'),
  companyId: uuid('company_id').notNull().references(() => companies.id),
}, (table) => ({
  docDateIdx: index('physical_stock_takes_company_doc_date_idx').on(table.companyId, table.docDate),
  companyIdIdx: index('physical_stock_takes_company_id_idx').on(table.companyId),
  tenantIsolationPolicy: pgPolicy('physical_stock_takes_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

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
}, (table) => ({
  stockTakeIdIdx: index('physical_stock_take_items_stock_take_id_idx').on(table.stockTakeId),
  tenantIsolationPolicy: pgPolicy('physical_stock_take_items_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`EXISTS (SELECT 1 FROM ${physicalStockTakes} WHERE ${physicalStockTakes.id} = ${table.stockTakeId} AND ${physicalStockTakes.companyId} = current_setting('app.company_id', true)::uuid)`,
    withCheck: sql`EXISTS (SELECT 1 FROM ${physicalStockTakes} WHERE ${physicalStockTakes.id} = ${table.stockTakeId} AND ${physicalStockTakes.companyId} = current_setting('app.company_id', true)::uuid)`,
  }),
})).enableRLS();

// 10. Stock Ledger / Transaction Log (audit trail for all movements)
export const stockLedgerTransactions = pgTable('stock_ledger_transactions', {
  id: uuid('id').primaryKey(),
  productId: uuid('product_id').notNull().references(() => productsServices.id),
  warehouseId: uuid('warehouse_id').notNull().references(() => warehouses.id),
  transactionType: text('transaction_type').notNull(), // 'GRN', 'Return', 'Sale', 'Adjustment', 'StockTake', 'TransferOut', 'TransferIn'
  // Polymorphic (GRN/Sale/Adjustment/etc depending on transactionType) — no single-table FK.
  referenceId: uuid('reference_id').notNull(),
  postingDate: businessDate('posting_date').notNull(), // the date the movement counts in (docs/date-fields-standard.md)
  createdAt: timestamp('created_at').notNull(), // the moment of the movement; orders movements within a day (average cost depends on it)
  quantityChange: decimal('quantity_change', { precision: 12, scale: 3 }).notNull(), // positive or negative
  endingQuantity: decimal('ending_quantity', { precision: 12, scale: 3 }).notNull(),
  batchNumber: text('batch_number'),
  companyId: uuid('company_id').notNull().references(() => companies.id),
}, (table) => ({
  postingDateIdx: index('stock_ledger_transactions_company_posting_date_idx').on(table.companyId, table.postingDate),
  // High-volume append-only ledger table with no other index at all before this — adding
  // one alongside the RLS policy is necessary, not optional, or the policy's predicate
  // forces a sequential scan on every query.
  companyIdIdx: index('stock_ledger_transactions_company_id_idx').on(table.companyId),
  tenantIsolationPolicy: pgPolicy('stock_ledger_transactions_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

// 11. Warehouse Transfers (Dispatch -> Receiving)
// A transfer moves stock between two warehouses that may belong to two different branches
// (or the same branch, or one/both branchless) — unlike every other document in this
// schema, there is no single "this document's branch." branchId is therefore NOT a column
// on either table; it is derived independently per side via warehouseId -> warehouses.
// branchId, exactly like goodsReceiptNotes/purchaseReturns/physicalStockTakes already do,
// applied twice instead of once (see server/routes/inventory.ts's two independent
// branchAccessOk checks — source at dispatch-creation, destination at receiving-creation,
// deliberately allowed to be different callers).
//
// Stock timing (deliberate): dispatch deducts from fromWarehouseId immediately; receiving
// adds to toWarehouseId only when it's created, using the actual received quantity (which
// defaults to quantityDispatched but is editable per line). Stock is genuinely in transit
// — visible at neither warehouse — between the two events. This is not a bug; it mirrors
// real warehouse operations and is what makes the reconciliation report meaningful.
export const warehouseDispatches = pgTable('warehouse_dispatches', {
  id: uuid('id').primaryKey(),
  dispatchNumber: text('dispatch_number').notNull(),
  fromWarehouseId: uuid('from_warehouse_id').notNull().references(() => warehouses.id),
  toWarehouseId: uuid('to_warehouse_id').notNull().references(() => warehouses.id),
  docDate: businessDate('doc_date').notNull(), // the date of the document
  postingDate: businessDate('posting_date').notNull(), // the ledger / stock-ledger / period date
  createdAt: timestamp('created_at').notNull(), // when it was entered (the system clock); keeps the order of documents within a day
  createdById: uuid('created_by_id').references(() => users.id), // who entered it (empty on documents that predate this field)
  // Standard warehouse-dispatch-note fields. Unlike goodsReceiptNotes' vehicleNumber/
  // driverName (a pre-existing shortcut kept client-state-only, never persisted), these
  // are real columns here since dispatch/receiving are genuinely built around them.
  vehicleNumber: text('vehicle_number'),
  driverName: text('driver_name'),
  driverContact: text('driver_contact'),
  expectedArrivalDate: businessDate('expected_arrival_date'),
  dispatchedBy: text('dispatched_by').notNull(), // loosely-typed text, same convention as goodsReceiptNotes.receivedBy / physicalStockTakes.performedBy
  notes: text('notes'),
  // 'Dispatched' (in transit, awaiting receipt) | 'Received' (fulfilled — see
  // warehouseReceivings.dispatchId) | 'Cancelled' (voided before receipt, stock already
  // reversed back into fromWarehouseId). Plain text, not a real Postgres enum — matches
  // every other status column in this schema (purchaseOrders.status, purchaseBills.status,
  // physicalStockTakes.status, stockLedgerTransactions.transactionType itself).
  status: text('status').default('Dispatched').notNull(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
}, (table) => ({
  docDateIdx: index('warehouse_dispatches_company_doc_date_idx').on(table.companyId, table.docDate),
  companyIdIdx: index('warehouse_dispatches_company_id_idx').on(table.companyId),
  tenantIsolationPolicy: pgPolicy('warehouse_dispatches_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

export const warehouseDispatchItems = pgTable('warehouse_dispatch_items', {
  id: uuid('id').primaryKey(),
  dispatchId: uuid('dispatch_id').notNull().references(() => warehouseDispatches.id),
  productId: uuid('product_id').notNull().references(() => productsServices.id),
  quantityDispatched: decimal('quantity_dispatched', { precision: 12, scale: 3 }).notNull(),
  batchNumber: text('batch_number'),
  expiryDate: timestamp('expiry_date'),
  // Nullable: null means the product's own base unit — see purchaseOrderItems.
  // unitOfMeasureId's comment. quantityDispatched is expressed in THIS unit; converted to
  // base-unit terms before touching inventoryStocks/stockLedgerTransactions.
  unitOfMeasureId: uuid('unit_of_measure_id').references(() => unitsOfMeasure.id),
}, (table) => ({
  dispatchIdIdx: index('warehouse_dispatch_items_dispatch_id_idx').on(table.dispatchId),
  tenantIsolationPolicy: pgPolicy('warehouse_dispatch_items_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`EXISTS (SELECT 1 FROM ${warehouseDispatches} WHERE ${warehouseDispatches.id} = ${table.dispatchId} AND ${warehouseDispatches.companyId} = current_setting('app.company_id', true)::uuid)`,
    withCheck: sql`EXISTS (SELECT 1 FROM ${warehouseDispatches} WHERE ${warehouseDispatches.id} = ${table.dispatchId} AND ${warehouseDispatches.companyId} = current_setting('app.company_id', true)::uuid)`,
  }),
})).enableRLS();

export const warehouseReceivings = pgTable('warehouse_receivings', {
  id: uuid('id').primaryKey(),
  receivingNumber: text('receiving_number').notNull(),
  // One dispatch -> at most one receiving (v1 non-goal: multiple partial receipts against
  // one dispatch over time). Enforced at the application layer — a row-locked
  // check-then-set of warehouseDispatches.status inside the same transaction, mirroring
  // goodsReceiptNotes.isBilled's exact concurrency pattern — not a DB unique constraint,
  // matching this schema's convention of keeping such uniqueness at the route layer (see
  // inventoryStocks' own lack of a unique constraint for the same reasoning).
  dispatchId: uuid('dispatch_id').notNull().references(() => warehouseDispatches.id),
  docDate: businessDate('doc_date').notNull(), // the date of the document
  postingDate: businessDate('posting_date').notNull(), // the ledger / stock-ledger / period date
  createdAt: timestamp('created_at').notNull(), // when it was entered (the system clock); keeps the order of documents within a day
  createdById: uuid('created_by_id').references(() => users.id), // who entered it (empty on documents that predate this field)
  receivedBy: text('received_by').notNull(),
  condition: text('condition'), // free text (e.g. 'Good', 'Damaged', 'Partial') — not an enforced enum
  discrepancyNotes: text('discrepancy_notes'), // free-text explanation when received != dispatched on one or more lines
  notes: text('notes'),
  status: text('status').default('Active').notNull(), // 'Active' | 'Cancelled'
  companyId: uuid('company_id').notNull().references(() => companies.id),
}, (table) => ({
  docDateIdx: index('warehouse_receivings_company_doc_date_idx').on(table.companyId, table.docDate),
  companyIdIdx: index('warehouse_receivings_company_id_idx').on(table.companyId),
  dispatchIdIdx: index('warehouse_receivings_dispatch_id_idx').on(table.dispatchId),
  tenantIsolationPolicy: pgPolicy('warehouse_receivings_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

export const warehouseReceivingItems = pgTable('warehouse_receiving_items', {
  id: uuid('id').primaryKey(),
  receivingId: uuid('receiving_id').notNull().references(() => warehouseReceivings.id),
  // Links each receiving line back to its exact dispatch line, so variance is computed
  // per-line, not just per-document — also the anchor for the cross-dispatch-line
  // ownership check at receiving-creation time (see inventory.ts).
  dispatchItemId: uuid('dispatch_item_id').notNull().references(() => warehouseDispatchItems.id),
  productId: uuid('product_id').notNull().references(() => productsServices.id), // denormalized copy of dispatchItemId's own productId, same reasoning goodsReceiptNoteItems keeps productId directly
  quantityReceived: decimal('quantity_received', { precision: 12, scale: 3 }).notNull(),
  batchNumber: text('batch_number'),
  expiryDate: timestamp('expiry_date'),
  unitOfMeasureId: uuid('unit_of_measure_id').references(() => unitsOfMeasure.id),
}, (table) => ({
  receivingIdIdx: index('warehouse_receiving_items_receiving_id_idx').on(table.receivingId),
  tenantIsolationPolicy: pgPolicy('warehouse_receiving_items_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`EXISTS (SELECT 1 FROM ${warehouseReceivings} WHERE ${warehouseReceivings.id} = ${table.receivingId} AND ${warehouseReceivings.companyId} = current_setting('app.company_id', true)::uuid)`,
    withCheck: sql`EXISTS (SELECT 1 FROM ${warehouseReceivings} WHERE ${warehouseReceivings.id} = ${table.receivingId} AND ${warehouseReceivings.companyId} = current_setting('app.company_id', true)::uuid)`,
  }),
})).enableRLS();

// ---- General Ledger Step 1: manual journals with approval, category accounts, opening balances ----

// A manual journal lives here (Draft -> Pending -> Posted, or Rejected back to Draft) and only becomes a journal_entries row when it is approved and
// posted. That keeps "every row in journal_entries is posted" true for every report that reads it today.
export const manualJournals = pgTable('manual_journals', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  number: text('number').notNull(),
  docDate: businessDate('doc_date').notNull(), // the date of the journal voucher
  postingDate: businessDate('posting_date').notNull(), // the ledger / period date; defaults to docDate
  backDateReason: text('back_date_reason'), // why an entry dated before today was posted (required past the company's reason-after-days rule)
  description: text('description').notNull(),
  reference: text('reference'),
  preparerNote: text('preparer_note'),
  branchId: uuid('branch_id').references(() => branches.id),
  status: text('status').notNull(), // 'Draft' | 'Pending' | 'Rejected' | 'Posted' | 'Discarded' (a draft that was thrown away; its number stays visible, nothing is erased)
  preparedById: uuid('prepared_by_id').notNull().references(() => users.id),
  preparedAt: timestamp('prepared_at').notNull(),
  submittedAt: timestamp('submitted_at'),
  decidedById: uuid('decided_by_id').references(() => users.id), // approver or rejecter
  decidedAt: timestamp('decided_at'),
  decisionNote: text('decision_note'), // the written reason of a rejection
  selfApproved: boolean('self_approved').notNull().default(false),
  journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id), // set when posted
  reversalOfId: uuid('reversal_of_id'), // this journal reverses that posted manual journal
  reversedById: uuid('reversed_by_id'), // that posted journal has been reversed by this one
}, (table) => ({
  docDateIdx: index('manual_journals_company_doc_date_idx').on(table.companyId, table.docDate),
  companyIdIdx: index('manual_journals_company_id_idx').on(table.companyId),
  numberUnique: uniqueIndex('manual_journals_company_number_unique').on(table.companyId, table.number),
  idCompanyUnique: unique('manual_journals_id_company_unique').on(table.companyId, table.id),
  reversalFk: foreignKey({ name: 'manual_journals_reversal_company_fk', columns: [table.reversalOfId, table.companyId], foreignColumns: [table.id, table.companyId] }),
  reversedByFk: foreignKey({ name: 'manual_journals_reversed_by_company_fk', columns: [table.reversedById, table.companyId], foreignColumns: [table.id, table.companyId] }),
  oneReversalUnique: uniqueIndex('manual_journals_one_reversal_unique').on(table.reversalOfId).where(sql`reversal_of_id IS NOT NULL`),
  statusCheck: check('manual_journals_status_check', sql`${table.status} IN ('Draft','Pending','Rejected','Posted','Discarded')`),
  statusIdx: index('manual_journals_company_status_idx').on(table.companyId, table.status),
  tenantIsolationPolicy: pgPolicy('manual_journals_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

export const manualJournalLines = pgTable('manual_journal_lines', {
  id: uuid('id').primaryKey(),
  journalId: uuid('journal_id').notNull(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  accountId: uuid('account_id').notNull(),
  debit: decimal('debit', { precision: 14, scale: 2 }).notNull().default('0'),
  credit: decimal('credit', { precision: 14, scale: 2 }).notNull().default('0'),
  note: text('note'),
  sortOrder: integer('sort_order').notNull().default(0),
  dimensionCombinationId: uuid('dimension_combination_id'),
}, (table) => ({
  companyIdIdx: index('manual_journal_lines_company_id_idx').on(table.companyId),
  dimensionCombinationFk: foreignKey({ name: 'manual_journal_lines_dimension_combination_company_fk', columns: [table.dimensionCombinationId, table.companyId], foreignColumns: [dimensionCombinations.id, dimensionCombinations.companyId] }),
  journalIdx: index('manual_journal_lines_journal_id_idx').on(table.journalId),
  journalFk: foreignKey({ name: 'manual_journal_lines_journal_company_fk', columns: [table.journalId, table.companyId], foreignColumns: [manualJournals.id, manualJournals.companyId] }),
  accountFk: foreignKey({ name: 'manual_journal_lines_account_company_fk', columns: [table.accountId, table.companyId], foreignColumns: [companyAccounts.id, companyAccounts.companyId] }),
  oneSideCheck: check('manual_journal_lines_one_side_check', sql`(${table.debit} > 0 AND ${table.credit} = 0) OR (${table.debit} = 0 AND ${table.credit} > 0)`),
  tenantIsolationPolicy: pgPolicy('manual_journal_lines_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

// The approval trail: who prepared, submitted, approved, rejected, reversed, and when. Rows are only ever added.
export const manualJournalEvents = pgTable('manual_journal_events', {
  id: uuid('id').primaryKey(),
  journalId: uuid('journal_id').notNull(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  action: text('action').notNull(), // 'Prepared' | 'Edited' | 'Submitted' | 'Approved' | 'Rejected' | 'Posted' | 'Discarded' | 'ReversalStarted'
  userId: uuid('user_id').notNull().references(() => users.id),
  note: text('note'),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  companyIdIdx: index('manual_journal_events_company_id_idx').on(table.companyId),
  journalIdx: index('manual_journal_events_journal_id_idx').on(table.journalId),
  journalFk: foreignKey({ name: 'manual_journal_events_journal_company_fk', columns: [table.journalId, table.companyId], foreignColumns: [manualJournals.id, manualJournals.companyId] }),
  tenantIsolationPolicy: pgPolicy('manual_journal_events_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

// Account Mapping for expenses: which account each fixed expense category posts to. A category with no row posts to the default expense account.
export const expenseCategoryAccounts = pgTable('expense_category_accounts', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  category: text('category').notNull(), // one of the fixed expense categories ('Admin Expenses', 'Staff Salaries', ...)
  accountId: uuid('account_id').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  updatedById: uuid('updated_by_id').references(() => users.id),
}, (table) => ({
  companyIdIdx: index('expense_category_accounts_company_id_idx').on(table.companyId),
  categoryUnique: uniqueIndex('expense_category_accounts_company_category_unique').on(table.companyId, table.category),
  accountFk: foreignKey({ name: 'expense_category_accounts_account_company_fk', columns: [table.accountId, table.companyId], foreignColumns: [companyAccounts.id, companyAccounts.companyId] }),
  tenantIsolationPolicy: pgPolicy('expense_category_accounts_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

// One row per posted opening-balance entry (a company may post one per cut-off date; each is reversed, never edited).
export const openingBalanceRuns = pgTable('opening_balance_runs', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  cutOffDate: text('cut_off_date').notNull(),
  journalEntryId: uuid('journal_entry_id').notNull().references(() => journalEntries.id),
  summary: jsonb('summary').notNull(),
  postedById: uuid('posted_by_id').notNull().references(() => users.id),
  postedAt: timestamp('posted_at').notNull(),
}, (table) => ({
  companyIdIdx: index('opening_balance_runs_company_id_idx').on(table.companyId),
  // One live opening run per company; a reversed run (summary.reversedAt set) steps aside so a corrected one can be posted.
  oneLiveRunUnique: uniqueIndex('opening_balance_runs_one_live_unique').on(table.companyId).where(sql`(summary->>'reversedAt') IS NULL`),
  tenantIsolationPolicy: pgPolicy('opening_balance_runs_tenant_isolation', {
    for: 'all',
    to: TENANT_DB_ROLE,
    using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
    withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  }),
})).enableRLS();

// ---- General Ledger Step 1.5: dynamic dimensions (Finance Core Blueprint FR-DIM). See docs/gl-step1-5-decisions.md. ----
// A company defines as many dimension types as it needs (Profit Centre, Project, Department ...). Branch and Department are seeded. Values of a Custom type
// live in dimension_values; Branch and Department are linked to the branches / cost_centers masters. A ledger line carries ONE combination of tags.
const tenantPolicy = (name: string, table: any) => pgPolicy(name, {
  for: 'all',
  to: TENANT_DB_ROLE,
  using: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
  withCheck: sql`${table.companyId} = current_setting('app.company_id', true)::uuid`,
});

// Department / cost centre master: optional home branch (a centre with none is shared and eligible for allocation), hierarchical.
export const costCenters = pgTable('cost_centers', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  nameAr: text('name_ar'),
  homeBranchId: uuid('home_branch_id'),
  parentId: uuid('parent_id'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  companyIdIdx: index('cost_centers_company_id_idx').on(table.companyId),
  idCompanyUnique: unique('cost_centers_id_company_unique').on(table.companyId, table.id),
  codeUnique: uniqueIndex('cost_centers_company_code_unique').on(table.companyId, table.code),
  homeBranchFk: foreignKey({ name: 'cost_centers_home_branch_company_fk', columns: [table.homeBranchId, table.companyId], foreignColumns: [branches.id, branches.companyId] }),
  parentFk: foreignKey({ name: 'cost_centers_parent_company_fk', columns: [table.parentId, table.companyId], foreignColumns: [table.id, table.companyId] }),
  tenantIsolationPolicy: tenantPolicy('cost_centers_tenant_isolation', table),
})).enableRLS();

export const dimensionTypes = pgTable('dimension_types', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  nameAr: text('name_ar'),
  valueSource: text('value_source').notNull(), // 'Custom' (values in dimension_values) | 'LinkedEntity' (branches / cost_centers)
  linkedEntity: text('linked_entity'), // 'branches' | 'cost_centers' when LinkedEntity
  isHierarchical: boolean('is_hierarchical').notNull().default(false),
  isSystem: boolean('is_system').notNull().default(false), // the seeded Branch and Department types: renamable, never removed or re-sourced
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  companyIdIdx: index('dimension_types_company_id_idx').on(table.companyId),
  idCompanyUnique: unique('dimension_types_id_company_unique').on(table.companyId, table.id),
  codeUnique: uniqueIndex('dimension_types_company_code_unique').on(table.companyId, table.code),
  sourceCheck: check('dimension_types_source_check', sql`(${table.valueSource} = 'Custom' AND ${table.linkedEntity} IS NULL) OR (${table.valueSource} = 'LinkedEntity' AND ${table.linkedEntity} IN ('branches','cost_centers'))`),
  tenantIsolationPolicy: tenantPolicy('dimension_types_tenant_isolation', table),
})).enableRLS();

export const dimensionValues = pgTable('dimension_values', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  dimensionTypeId: uuid('dimension_type_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  nameAr: text('name_ar'),
  parentValueId: uuid('parent_value_id'), // a value can sit under another value of the same type; filtering on a parent includes its children
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  companyIdIdx: index('dimension_values_company_id_idx').on(table.companyId),
  typeIdx: index('dimension_values_type_idx').on(table.dimensionTypeId),
  idCompanyUnique: unique('dimension_values_id_company_unique').on(table.companyId, table.id),
  codeUnique: uniqueIndex('dimension_values_type_code_unique').on(table.dimensionTypeId, table.code),
  typeFk: foreignKey({ name: 'dimension_values_type_company_fk', columns: [table.dimensionTypeId, table.companyId], foreignColumns: [dimensionTypes.id, dimensionTypes.companyId] }),
  parentFk: foreignKey({ name: 'dimension_values_parent_company_fk', columns: [table.parentValueId, table.companyId], foreignColumns: [table.id, table.companyId] }),
  tenantIsolationPolicy: tenantPolicy('dimension_values_tenant_isolation', table),
})).enableRLS();

// A deduplicated set of tags: every line with the same tags points at the same row, so a dimension filter is one indexed lookup.
export const dimensionCombinations = pgTable('dimension_combinations', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  dedupKey: text('dedup_key').notNull(), // hash of the sorted "typeId=entityId" members
  label: text('label'), // cached display text, e.g. "Jeddah / Marketing"
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  companyIdIdx: index('dimension_combinations_company_id_idx').on(table.companyId),
  idCompanyUnique: unique('dimension_combinations_id_company_unique').on(table.companyId, table.id),
  dedupUnique: uniqueIndex('dimension_combinations_company_dedup_unique').on(table.companyId, table.dedupKey),
  tenantIsolationPolicy: tenantPolicy('dimension_combinations_tenant_isolation', table),
})).enableRLS();

// One tag of a combination. The entity is stored in a typed column with a real foreign key (never a bare polymorphic id); entityId repeats it for filtering.
export const dimensionCombinationEntries = pgTable('dimension_combination_entries', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  combinationId: uuid('combination_id').notNull(),
  dimensionTypeId: uuid('dimension_type_id').notNull(),
  entityId: uuid('entity_id').notNull(),
  valueId: uuid('value_id'),
  branchId: uuid('branch_id'),
  costCenterId: uuid('cost_center_id'),
}, (table) => ({
  companyIdIdx: index('dimension_combination_entries_company_id_idx').on(table.companyId),
  oneTagPerType: uniqueIndex('dimension_combination_entries_combo_type_unique').on(table.combinationId, table.dimensionTypeId),
  filterIdx: index('dimension_combination_entries_filter_idx').on(table.companyId, table.dimensionTypeId, table.entityId, table.combinationId),
  comboFk: foreignKey({ name: 'dimension_combination_entries_combo_company_fk', columns: [table.combinationId, table.companyId], foreignColumns: [dimensionCombinations.id, dimensionCombinations.companyId] }),
  typeFk: foreignKey({ name: 'dimension_combination_entries_type_company_fk', columns: [table.dimensionTypeId, table.companyId], foreignColumns: [dimensionTypes.id, dimensionTypes.companyId] }),
  valueFk: foreignKey({ name: 'dimension_combination_entries_value_company_fk', columns: [table.valueId, table.companyId], foreignColumns: [dimensionValues.id, dimensionValues.companyId] }),
  branchFk: foreignKey({ name: 'dimension_combination_entries_branch_company_fk', columns: [table.branchId, table.companyId], foreignColumns: [branches.id, branches.companyId] }),
  costCenterFk: foreignKey({ name: 'dimension_combination_entries_cost_center_company_fk', columns: [table.costCenterId, table.companyId], foreignColumns: [costCenters.id, costCenters.companyId] }),
  entityCheck: check('dimension_combination_entries_entity_check', sql`num_nonnulls(${table.valueId}, ${table.branchId}, ${table.costCenterId}) = 1 AND ${table.entityId} = COALESCE(${table.valueId}, ${table.branchId}, ${table.costCenterId})`),
  tenantIsolationPolicy: tenantPolicy('dimension_combination_entries_tenant_isolation', table),
})).enableRLS();

// The link between the chart of accounts and a dimension: must / may / must not carry a tag of this type, with an optional default tag.
export const accountDimensionRules = pgTable('account_dimension_rules', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  accountId: uuid('account_id').notNull(),
  dimensionTypeId: uuid('dimension_type_id').notNull(),
  rule: text('rule').notNull(), // 'optional' | 'required' | 'not_allowed'
  defaultValueId: uuid('default_value_id'),
  defaultBranchId: uuid('default_branch_id'),
  defaultCostCenterId: uuid('default_cost_center_id'),
}, (table) => ({
  companyIdIdx: index('account_dimension_rules_company_id_idx').on(table.companyId),
  pairUnique: uniqueIndex('account_dimension_rules_account_type_unique').on(table.accountId, table.dimensionTypeId),
  accountFk: foreignKey({ name: 'account_dimension_rules_account_company_fk', columns: [table.accountId, table.companyId], foreignColumns: [companyAccounts.id, companyAccounts.companyId] }),
  typeFk: foreignKey({ name: 'account_dimension_rules_type_company_fk', columns: [table.dimensionTypeId, table.companyId], foreignColumns: [dimensionTypes.id, dimensionTypes.companyId] }),
  valueFk: foreignKey({ name: 'account_dimension_rules_value_company_fk', columns: [table.defaultValueId, table.companyId], foreignColumns: [dimensionValues.id, dimensionValues.companyId] }),
  branchFk: foreignKey({ name: 'account_dimension_rules_branch_company_fk', columns: [table.defaultBranchId, table.companyId], foreignColumns: [branches.id, branches.companyId] }),
  costCenterFk: foreignKey({ name: 'account_dimension_rules_cost_center_company_fk', columns: [table.defaultCostCenterId, table.companyId], foreignColumns: [costCenters.id, costCenters.companyId] }),
  ruleCheck: check('account_dimension_rules_rule_check', sql`${table.rule} IN ('optional','required','not_allowed')`),
  oneDefaultCheck: check('account_dimension_rules_one_default_check', sql`num_nonnulls(${table.defaultValueId}, ${table.defaultBranchId}, ${table.defaultCostCenterId}) <= 1 AND (${table.rule} <> 'not_allowed' OR num_nonnulls(${table.defaultValueId}, ${table.defaultBranchId}, ${table.defaultCostCenterId}) = 0)`),
  tenantIsolationPolicy: tenantPolicy('account_dimension_rules_tenant_isolation', table),
})).enableRLS();

// ---- General Ledger Step 1.5: the Report Definition engine (Finance Core Blueprint FR-RPT-CFG). See docs/gl-step1-5-decisions.md. ----
// Trial Balance, Income Statement and Balance Sheet are seeded, editable and cloneable instances of ONE engine: a definition is rows x columns evaluated
// against journal lines. A row selects accounts (include / exclude selectors) or calculates from other rows; a column picks a period basis, a value basis and
// an optional dimension filter.
export const reportDefinitions = pgTable('report_definitions', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  name: text('name').notNull(),
  nameAr: text('name_ar'),
  reportType: text('report_type').notNull(), // 'TrialBalance' | 'PnL' | 'BalanceSheet' | 'CashFlow' | 'ChangesInEquity' | 'Custom'
  isSystemSeeded: boolean('is_system_seeded').notNull().default(false),
  isDefault: boolean('is_default').notNull().default(false),
  defaultDisplayMode: text('default_display_mode').notNull().default('Summary'), // 'Summary' | 'Detailed'
  isActive: boolean('is_active').notNull().default(true),
  createdById: uuid('created_by_id').references(() => users.id),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({
  companyIdIdx: index('report_definitions_company_id_idx').on(table.companyId),
  idCompanyUnique: unique('report_definitions_id_company_unique').on(table.companyId, table.id),
  nameUnique: uniqueIndex('report_definitions_company_name_unique').on(table.companyId, table.name),
  oneDefaultPerType: uniqueIndex('report_definitions_one_default_unique').on(table.companyId, table.reportType).where(sql`is_default = true`),
  typeCheck: check('report_definitions_type_check', sql`${table.reportType} IN ('TrialBalance','PnL','BalanceSheet','CashFlow','ChangesInEquity','Custom')`),
  modeCheck: check('report_definitions_mode_check', sql`${table.defaultDisplayMode} IN ('Summary','Detailed')`),
  tenantIsolationPolicy: tenantPolicy('report_definitions_tenant_isolation', table),
})).enableRLS();

export const reportRows = pgTable('report_rows', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  reportDefinitionId: uuid('report_definition_id').notNull(),
  rowNumber: integer('row_number').notNull(), // the number formulas refer to
  sortOrder: integer('sort_order').notNull(),
  rowType: text('row_type').notNull(), // 'Heading' | 'Accounts' | 'Subtotal' | 'Calculated' | 'ProfitToDate' | 'Text' | 'Spacer'
  label: text('label'),
  labelAr: text('label_ar'),
  balanceDisplay: text('balance_display').notNull().default('Net'), // 'Net' | 'Debit' | 'Credit' | 'DebitBalances' | 'CreditBalances' | 'Split'
  flipSign: boolean('flip_sign').notNull().default(false), // show the opposite sign (credit-natured rows show positive)
  valueBasis: text('value_basis'), // null = the column's own basis; 'OpeningBalance' | 'ClosingBalance' pins this row to the balance at the start / end of the column's period (cash at the beginning of a cash flow)
  calcFormula: jsonb('calc_formula'), // Calculated: [{ rowNumber, sign }] over EARLIER rows
  role: text('role'), // optional tag a rule or report relies on: total_assets, total_liabilities, total_equity, net_profit ...
  dimensionFilter: jsonb('dimension_filter'), // { dimensionTypeId: [entityId] } applied to this row only
  format: jsonb('format').notNull().default(sql`'{}'::jsonb`), // bold, italic, underline, indent, align, amountAlign, borderTop, borderBottom, shade, show, pageBreakAfter, negatives, decimals
}, (table) => ({
  companyIdIdx: index('report_rows_company_id_idx').on(table.companyId),
  definitionIdx: index('report_rows_definition_idx').on(table.reportDefinitionId),
  idCompanyUnique: unique('report_rows_id_company_unique').on(table.companyId, table.id),
  numberUnique: uniqueIndex('report_rows_definition_number_unique').on(table.reportDefinitionId, table.rowNumber),
  definitionFk: foreignKey({ name: 'report_rows_definition_company_fk', columns: [table.reportDefinitionId, table.companyId], foreignColumns: [reportDefinitions.id, reportDefinitions.companyId] }),
  typeCheck: check('report_rows_type_check', sql`${table.rowType} IN ('Heading','Accounts','Subtotal','Calculated','ProfitToDate','Text','Spacer')`),
  displayCheck: check('report_rows_display_check', sql`${table.balanceDisplay} IN ('Net','Debit','Credit','DebitBalances','CreditBalances','Split')`),
  basisCheck: check('report_rows_basis_check', sql`${table.valueBasis} IS NULL OR ${table.valueBasis} IN ('OpeningBalance','ClosingBalance')`),
  tenantIsolationPolicy: tenantPolicy('report_rows_tenant_isolation', table),
})).enableRLS();

// What an Accounts row contains. Includes are united, then Excludes are removed ("Operating expenses excluding Depreciation").
export const reportRowSelectors = pgTable('report_row_selectors', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  reportRowId: uuid('report_row_id').notNull(),
  mode: text('mode').notNull().default('Include'), // 'Include' | 'Exclude'
  selectorType: text('selector_type').notNull(), // 'Account' | 'ParentRollup' | 'Range' | 'Type' | 'Role' | 'Cash' (every bank and cash account)
  accountId: uuid('account_id'),
  rangeStart: text('range_start'),
  rangeEnd: text('range_end'),
  accountType: text('account_type'),
  systemKey: text('system_key'),
}, (table) => ({
  companyIdIdx: index('report_row_selectors_company_id_idx').on(table.companyId),
  rowIdx: index('report_row_selectors_row_idx').on(table.reportRowId),
  rowFk: foreignKey({ name: 'report_row_selectors_row_company_fk', columns: [table.reportRowId, table.companyId], foreignColumns: [reportRows.id, reportRows.companyId] }),
  accountFk: foreignKey({ name: 'report_row_selectors_account_company_fk', columns: [table.accountId, table.companyId], foreignColumns: [companyAccounts.id, companyAccounts.companyId] }),
  systemKeyFk: foreignKey({ name: 'report_row_selectors_system_key_fk', columns: [table.systemKey], foreignColumns: [systemAccounts.key] }),
  modeCheck: check('report_row_selectors_mode_check', sql`${table.mode} IN ('Include','Exclude')`),
  typeCheck: check('report_row_selectors_type_check', sql`${table.selectorType} IN ('Account','ParentRollup','Range','Type','Role','Cash')`),
  shapeCheck: check('report_row_selectors_shape_check', sql`
    (${table.selectorType} IN ('Account','ParentRollup') AND ${table.accountId} IS NOT NULL)
    OR ${table.selectorType} = 'Cash'
    OR (${table.selectorType} = 'Range' AND ${table.rangeStart} IS NOT NULL AND ${table.rangeEnd} IS NOT NULL)
    OR (${table.selectorType} = 'Type' AND ${table.accountType} IN ('Asset','Liability','Equity','Revenue','Expense'))
    OR (${table.selectorType} = 'Role' AND ${table.systemKey} IS NOT NULL)`),
  tenantIsolationPolicy: tenantPolicy('report_row_selectors_tenant_isolation', table),
})).enableRLS();

export const reportColumns = pgTable('report_columns', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  reportDefinitionId: uuid('report_definition_id').notNull(),
  columnNumber: integer('column_number').notNull(),
  label: text('label').notNull(),
  labelAr: text('label_ar'),
  columnKind: text('column_kind').notNull().default('Value'), // 'Value' | 'Variance' | 'Percent'
  periodBasis: text('period_basis').notNull().default('CurrentPeriod'), // CurrentPeriod | YearToDate | PriorPeriod | PriorYear | AsAtEnd | AsAtPriorYearEnd | AsAtPriorPeriodEnd | CustomRange
  customFrom: text('custom_from'),
  customTo: text('custom_to'),
  valueBasis: text('value_basis').notNull().default('Movement'), // 'Debit' | 'Credit' | 'Movement' | 'OpeningBalance' | 'ClosingBalance'
  presentation: text('presentation').notNull().default('Single'), // 'Single' | 'DrCr' (a debit and a credit sub-column)
  dimensionFilter: jsonb('dimension_filter'),
  refColumnA: integer('ref_column_a'), // Variance / Percent: column A minus column B (percent of B)
  refColumnB: integer('ref_column_b'),
  format: jsonb('format').notNull().default(sql`'{}'::jsonb`),
}, (table) => ({
  companyIdIdx: index('report_columns_company_id_idx').on(table.companyId),
  definitionIdx: index('report_columns_definition_idx').on(table.reportDefinitionId),
  numberUnique: uniqueIndex('report_columns_definition_number_unique').on(table.reportDefinitionId, table.columnNumber),
  definitionFk: foreignKey({ name: 'report_columns_definition_company_fk', columns: [table.reportDefinitionId, table.companyId], foreignColumns: [reportDefinitions.id, reportDefinitions.companyId] }),
  kindCheck: check('report_columns_kind_check', sql`${table.columnKind} IN ('Value','Variance','Percent')`),
  periodCheck: check('report_columns_period_check', sql`${table.periodBasis} IN ('CurrentPeriod','YearToDate','PriorPeriod','PriorYear','AsAtEnd','AsAtPriorYearEnd','AsAtPriorPeriodEnd','CustomRange')`),
  valueCheck: check('report_columns_value_check', sql`${table.valueBasis} IN ('Debit','Credit','Movement','OpeningBalance','ClosingBalance')`),
  presentationCheck: check('report_columns_presentation_check', sql`${table.presentation} IN ('Single','DrCr')`),
  tenantIsolationPolicy: tenantPolicy('report_columns_tenant_isolation', table),
})).enableRLS();

// Posting control (docs/posting-control.md): one row per company that wants rules on top of the open / closed fiscal month. A company with no row has none of
// them. lock_date: nothing may be dated on or before it (except for the right postingControl.overrideLock); max_back_days: nothing may be dated more than
// that many days before today (except for postingControl.backDate); reason_after_days: a posting older than that needs a written reason.
export const postingPolicies = pgTable('posting_policies', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  lockDate: businessDate('lock_date'),
  maxBackDays: integer('max_back_days'),
  reasonAfterDays: integer('reason_after_days'),
  updatedAt: timestamp('updated_at').notNull(),
  updatedById: uuid('updated_by_id').references(() => users.id),
}, (table) => ({
  companyUnique: uniqueIndex('posting_policies_company_unique').on(table.companyId),
  daysCheck: check('posting_policies_days_check', sql`(${table.maxBackDays} IS NULL OR ${table.maxBackDays} >= 0) AND (${table.reasonAfterDays} IS NULL OR ${table.reasonAfterDays} >= 0)`),
  tenantIsolationPolicy: tenantPolicy('posting_policies_tenant_isolation', table),
})).enableRLS();

// Payment allocation (Blueprint FR-AR-02 / FR-AP-04): which documents a receipt or payment settles, and for how much. A multi-document receipt (CustomerReceipt) or payment
// (VendorPayment) is one voucher + one journal entry (the party's control account against the bank) + these rows; what is not allocated stays on account with the party.
// An allocation is never edited: cancelling the receipt marks its rows reversed and gives the money back to the documents.
export const paymentAllocations = pgTable('payment_allocations', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  voucherId: uuid('voucher_id').notNull(),
  documentType: text('document_type').notNull(), // 'Invoice' | 'Expense' | 'PurchaseBill'
  documentId: uuid('document_id').notNull(),     // polymorphic, like vouchers.reference_id
  amount: decimal('amount', { precision: 14, scale: 2 }).notNull(),
  appliedDate: businessDate('applied_date').notNull(),   // the day the money was put against the document (reports "as at" read this, not created_at)
  createdAt: timestamp('created_at').notNull(),
  createdById: uuid('created_by_id').references(() => users.id),
  reversedDate: businessDate('reversed_date'),            // the day it was taken back off (cancelled receipt)
  reversedAt: timestamp('reversed_at'),
  reversedById: uuid('reversed_by_id').references(() => users.id),
}, (table) => ({
  companyIdIdx: index('payment_allocations_company_id_idx').on(table.companyId),
  voucherIdx: index('payment_allocations_voucher_idx').on(table.companyId, table.voucherId),
  documentIdx: index('payment_allocations_document_idx').on(table.companyId, table.documentType, table.documentId),
  voucherFk: foreignKey({ name: 'payment_allocations_voucher_company_fk', columns: [table.voucherId, table.companyId], foreignColumns: [vouchers.id, vouchers.companyId] }),
  typeCheck: check('payment_allocations_type_check', sql`${table.documentType} IN ('Invoice','Expense','PurchaseBill')`),
  amountCheck: check('payment_allocations_amount_check', sql`${table.amount} > 0`),
  tenantIsolationPolicy: tenantPolicy('payment_allocations_tenant_isolation', table),
})).enableRLS();

// Bank reconciliation (Blueprint FR-BANK-01..05). One session per bank account per statement period: the statement's ending balance and date are entered, every posted ledger line of
// the bank's account up to that date is listed, and each is marked cleared (matched to a statement line, or ticked). It can be completed only when the cleared balance equals the statement
// balance and every statement line is matched; a completed session locks its lines. A bank fee / interest / timing error is fixed by a journal entry posted from inside the session.
export const bankReconciliations = pgTable('bank_reconciliations', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  bankId: uuid('bank_id').notNull().references(() => bankAccounts.id),
  statementDate: businessDate('statement_date').notNull(),
  statementEndingBalance: decimal('statement_ending_balance', { precision: 14, scale: 2 }).notNull(),
  glBalanceAtReconciliation: decimal('gl_balance_at_reconciliation', { precision: 14, scale: 2 }), // the book balance on the statement date, frozen when the session is completed
  status: text('status').notNull().default('InProgress'), // 'InProgress' | 'Completed'
  notes: text('notes'),
  createdAt: timestamp('created_at').notNull(),
  createdById: uuid('created_by_id').references(() => users.id),
  completedAt: timestamp('completed_at'),
  completedById: uuid('completed_by_id').references(() => users.id),
  reopenedAt: timestamp('reopened_at'),
  reopenedById: uuid('reopened_by_id').references(() => users.id),
  reopenReason: text('reopen_reason'),
}, (table) => ({
  companyIdIdx: index('bank_reconciliations_company_id_idx').on(table.companyId),
  bankIdx: index('bank_reconciliations_bank_idx').on(table.companyId, table.bankId, table.statementDate),
  oneOpenPerBank: uniqueIndex('bank_reconciliations_one_open_idx').on(table.companyId, table.bankId).where(sql`status = 'InProgress'`),
  idCompanyUnique: unique('bank_reconciliations_id_company_unique').on(table.companyId, table.id), // target of the composite keys of journal_lines and bank_statement_lines
  statusCheck: check('bank_reconciliations_status_check', sql`${table.status} IN ('InProgress','Completed')`),
  tenantIsolationPolicy: tenantPolicy('bank_reconciliations_tenant_isolation', table),
})).enableRLS();

export const bankStatementLines = pgTable('bank_statement_lines', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  bankReconciliationId: uuid('bank_reconciliation_id').notNull(),
  statementDate: businessDate('statement_date').notNull(),   // the date printed on the bank statement for this line
  description: text('description').notNull().default(''),
  reference: text('reference'),
  amount: decimal('amount', { precision: 14, scale: 2 }).notNull(), // signed as the bank shows it: money in is positive, money out is negative
  matchedJournalLineId: uuid('matched_journal_line_id').references(() => journalLines.id),
  isMatched: boolean('is_matched').notNull().default(false),
  createdAt: timestamp('created_at').notNull(),
  createdById: uuid('created_by_id').references(() => users.id),
}, (table) => ({
  companyIdIdx: index('bank_statement_lines_company_id_idx').on(table.companyId),
  sessionIdx: index('bank_statement_lines_session_idx').on(table.companyId, table.bankReconciliationId),
  oneStatementLinePerLedgerLine: uniqueIndex('bank_statement_lines_matched_idx').on(table.companyId, table.matchedJournalLineId).where(sql`matched_journal_line_id IS NOT NULL`),
  sessionFk: foreignKey({ name: 'bank_statement_lines_session_company_fk', columns: [table.bankReconciliationId, table.companyId], foreignColumns: [bankReconciliations.id, bankReconciliations.companyId] }),
  amountCheck: check('bank_statement_lines_amount_check', sql`${table.amount} <> 0`),
  matchedCheck: check('bank_statement_lines_matched_check', sql`(${table.isMatched} = (${table.matchedJournalLineId} IS NOT NULL))`),
  tenantIsolationPolicy: tenantPolicy('bank_statement_lines_tenant_isolation', table),
})).enableRLS();
