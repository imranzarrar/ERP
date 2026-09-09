import { PERMISSION_MODULES } from './permissionSchema';

export type UserRole = 'admin' | 'user' | 'super-admin';

export interface UseCasePermission {
  enabled: boolean;
  canCancel?: boolean;
  seeOwnOnly?: boolean;
}

export interface UserPermissions {
  [moduleName: string]: {
    [useCaseName: string]: UseCasePermission;
  };
}

// A reusable, company-scoped permission set. Users are assigned zero or more roles
// (see UserRoleAssignment) instead of having permissions hand-typed per account.
export interface Role {
  id: string;
  companyId: string;
  name: string;
  permissions: UserPermissions;
  createdAt?: string;
}

// Cross-tenant by design, unlike Role above (whose companyId is required) — a reusable,
// platform-curated permission set NOT tied to any single company. Cloned into a brand-new
// company's own Role at company-onboarding-approval time (server/routes/onboarding.ts),
// since a just-created company has no Roles of its own to pick from yet.
export interface RoleTemplate {
  id: string;
  name: string;
  description?: string | null;
  permissions: UserPermissions;
  createdAt?: string;
}

// A prospective customer's public self-signup submission (src/components/
// CompanyOnboardingScreen.tsx posts to POST /api/onboarding-requests, no session). Cross-
// tenant by design — submitted before any company/user exists — visible only to a
// super-admin (server.ts's GET /api/state hard-empties this for anyone else).
export interface CompanyOnboardingRequest {
  id: string;
  companyName: string;
  companyEmail: string;
  companyPhone?: string | null;
  companyAddress?: string | null;
  vatNumber?: string | null;
  crNumber?: string | null;
  currency?: string;
  contactName: string;
  contactEmail: string;
  contactPhone?: string | null;
  notes?: string | null;
  status: 'Pending' | 'Approved' | 'Rejected';
  reviewedById?: string | null;
  reviewedAt?: string | null;
  rejectionReason?: string | null;
  createdCompanyId?: string | null;
  createdAt?: string;
  // Set once the contact clicks the emailed confirmation link (server/routes/
  // onboarding.ts) — null means Approve is refused server-side regardless of what the
  // UI shows. emailConfirmTokenHash/emailConfirmExpiresAt are server-only (hashed
  // credential), deliberately never sent to the client.
  emailVerifiedAt?: string | null;
}

// A tombstone for the "Delete Company & All Data" purge (server/routes/companies.ts) —
// companyId is NOT a live reference (the company it names no longer exists by the time
// this is read back), just an identifying value. Cross-tenant, super-admin-only, same
// visibility rule as CompanyOnboardingRequest above.
export interface DeletedCompanyLogEntry {
  id: string;
  companyId: string;
  companyName: string;
  deletedByUserId: string;
  deletedByUsername: string;
  deletedAt?: string;
}

// Row of the userRoles many-to-many junction table.
export interface UserRoleAssignment {
  userId: string;
  roleId: string;
}

// Canonical super-admin check, shared by frontend permission logic (server has its own
// copy in server/lib/authz.ts since it can't import from src/ at runtime in all contexts).
export function isSuperAdminUserClient(user?: { role?: string; isSuperAdmin?: boolean } | null): boolean {
  return user?.isSuperAdmin === true || user?.role === 'super-admin';
}

// Dotted-path lookup against a permissions-shaped object. Accepts either a raw boolean
// leaf (`{quotation: true}`) or an `{enabled: boolean}` leaf (`{quotation: {access: {enabled: true}}}`).
// Exported so both `normalizePermissions` and the frontend `can()` helper (src/hooks.ts)
// share one implementation instead of two independently-maintained walkers.
export function getAtPath(obj: any, path: string, def: boolean): boolean {
  const parts = path.split('.');
  if (obj && typeof obj === 'object' && typeof obj[parts[0]] === 'boolean') {
    return obj[parts[0]];
  }
  let current: any = obj;
  for (const part of parts) {
    if (current === undefined || current === null || typeof current !== 'object') {
      return def;
    }
    current = current[part];
  }
  if (typeof current === 'boolean') return current;
  if (current && typeof current.enabled === 'boolean') return current.enabled;
  return def;
}

// A user can hold multiple roles at once (see the `userRoles` junction table in
// src/db/schema.ts) — their effective permissions are the union of every assigned role's
// `permissions` JSON, merged leaf-by-leaf with OR (if ANY role grants a permission, the
// user has it; a page granted by two roles simply isn't double-counted, it renders once).
// Deliberately generic over the tree shape (deep-merges plain objects, ORs booleans at
// the leaves) rather than hard-coding the current set of module/use-case names, so new
// permission nodes added later don't need this function touched.
export function mergeRolePermissions(rolePermissionsList: any[]): any {
  const mergeInto = (target: any, source: any): any => {
    if (typeof source !== 'object' || source === null) return target;
    const result: any = (target && typeof target === 'object') ? { ...target } : {};
    for (const key of Object.keys(source)) {
      const sourceVal = source[key];
      const targetVal = result[key];
      if (typeof sourceVal === 'boolean') {
        result[key] = Boolean(targetVal) || sourceVal;
      } else if (sourceVal && typeof sourceVal === 'object') {
        result[key] = mergeInto(targetVal, sourceVal);
      } else {
        result[key] = targetVal !== undefined ? targetVal : sourceVal;
      }
    }
    return result;
  };
  return rolePermissionsList.reduce((acc, rp) => mergeInto(acc, rp || {}), {});
}

// Registry-driven: every module/leaf comes from PERMISSION_MODULES (src/permissionSchema.ts)
// instead of three independently hand-maintained object literals (admin defaults,
// non-admin defaults, no-role-assigned defaults). That triplication is exactly what let a
// module silently default to full access once already — an admin-only leaf's `true`
// literal got copied into the "no permissions object" fallback by mistake, so any
// role-based user with zero roles assigned got full access to quotation/invoice/expense/
// POS instead of none. A single loop over one registry can't drift the same way: the
// "no role assigned" case isn't a fourth hand-written branch here, it's just this same
// loop fed an empty object, which resolves every leaf (including fallback-inherited ones)
// to false through the exact same code path admins and role-holders go through.
export function normalizePermissions(p: any, role?: string, isSuperAdmin?: boolean): any {
  const isAdmin = role === 'admin' || isSuperAdmin === true || role === 'super-admin';
  const safeP = (p && typeof p === 'object') ? p : {};
  const resolved: Record<string, boolean> = {};
  const result: any = {};

  for (const mod of PERMISSION_MODULES) {
    result[mod.id] = {};
    for (const leaf of mod.leaves) {
      const path = `${mod.id}.${leaf.key}.enabled`;
      let value: boolean;
      if (isAdmin) {
        value = true;
      } else {
        const fallback = leaf.fallbackFrom ? (resolved[leaf.fallbackFrom] ?? false) : false;
        value = getAtPath(safeP, path, fallback);
      }
      resolved[`${mod.id}.${leaf.key}`] = value;
      result[mod.id][leaf.key] = { enabled: value };
    }
  }

  return result;
}

export interface User {
  id: string;
  username: string;
  password?: string;
  email?: string;
  role: UserRole;
  // The DB no longer stores a raw permissions blob per user — the server resolves this
  // field from every Role assigned to the user (see the `userRoles` junction table in
  // src/db/schema.ts, mergeRolePermissions() below, and the role-resolution step in
  // server.ts) at request time, so it still arrives on every User object exactly as
  // before for every existing `can()`/`normalizePermissions()` call site to keep working
  // unchanged. Which roles are actually assigned lives in `DatabaseState.userRoles`
  // (a separate `{userId, roleId}[]` array), not on the User object itself, since a user
  // can hold more than one role.
  permissions: UserPermissions;
  companyId?: string;
  isPosSale?: boolean;
  shiftId?: string;
  attachmentUrl?: string;
  isSuperAdmin?: boolean;
  isActive?: boolean;
  uiLanguage?: "en" | "ar" | "ur";
  isDeleted?: number;
  // Nullable: null for every account that predates HR onboarding. See Employee's own
  // comment — this is the only direction the link goes (Employees never reference
  // Users). Mandatory for a genuinely new account only once the company has onboarded
  // at least one active employee (server/routes/users.ts).
  employeeId?: string | null;
}

export interface CompanySetup {
  id?: string; // Unique company ID (UUID)
  name: string;
  address: string;
  phone: string;
  email: string;
  logoUrl: string; // Base64 or local image
  customHeader: string;
  customFooter: string;
  vatNumber?: string; // Saudi VAT Registration Number
  crNumber?: string; // Commercial Registration number — print-facing, distinct from the per-environment ZATCA config value
  themeId?: string; // Selected dynamic theme profile id
  currency?: string; // e.g. "SAR", "USD", "$"
  portalTitle?: string; // Left sidebar brand heading
  portalSubtitle?: string; // Left sidebar brand subtitle
  posSettings?: {
    autoPrint: boolean;
    maxImageSizeKB: number;
    maxImageDimensions?: number;
    // Rejects images that are too SMALL (blurry/low-quality when scaled up for print or
    // POS display) — the counterpart to maxImageDimensions above, which only ever guarded
    // against too-large. Optional/undefined means "no minimum," preserving old behavior
    // for any company that hasn't set one.
    minImageDimensions?: number;
    defaultReceiptTemplate?: string;
    // POS Terminal grid density — how many priority tiles show at once on the Terminal
    // tab before a cashier needs to switch category or search. Undefined means "use the
    // Standard preset" (5x4=20), preserving today's fixed-breakpoint look for any company
    // that hasn't configured this yet.
    gridColumns?: number;
    gridRows?: number;
    gridDensityPreset?: 'compact' | 'standard' | 'dense' | 'custom';
  };
  counters?: {
    quotation: number;
    invoice: number;
    expense: number;
    voucher: number;
  };
  isInventoryModuleEnabled?: boolean;
  inventorySettings?: {
    prOptionality: 'MANDATORY' | 'OPTIONAL' | 'BYPASSED';
    isDsdAllowed: boolean;
    // When true, a sale (Invoice/POS/Credit Note line) referencing a stock ('item' type)
    // product is rejected if its resolved sales warehouse doesn't have enough quantity on
    // hand — see assertStockAvailable in server/lib/businessLogic.ts. Defaults to false
    // (off) so every existing company keeps today's behavior of allowing a sale to clamp
    // stock at 0 rather than being blocked by it.
    enforceStockAvailability?: boolean;
  };
  // zatcaEnvironment selects which environment is active for live invoice processing.
  // Taxpayer identity (TIN/CR/address) and all onboarding credentials/state live
  // per-environment in zatcaEnvironmentConfigs (src/db/schema.ts) — never on this
  // company-level type, since Sandbox/Simulation/Production each need their own.
  zatcaEnvironment?: 'sandbox' | 'simulation' | 'production';
  // Master on/off switch — when false, invoices never attempt ZATCA submission
  // regardless of environment. Defaults false for new companies; auto-enabled when
  // the active environment finishes onboarding, or toggled manually by a Super Admin.
  zatcaEnabled?: boolean;
  // 'Trial' (self-signup, awaiting real confirmation e.g. payment — set only by
  // onboarding-approval, server/routes/onboarding.ts) | 'Registered' (default, for every
  // pre-existing/admin-created company) | 'Cancelled' (blocks login for this company's
  // users, and is the only status that exposes "Delete Company & All Data" in the admin
  // UI). See server/routes/companies.ts.
  registrationStatus?: 'Trial' | 'Registered' | 'Cancelled';
  // Per-document-type number formatting override, keyed by DOCUMENT_TYPE_REGISTRY's `key`
  // (server/lib/documentNumbering.ts). Absent key or absent field = use that type's
  // registry default — every existing company has this unset, which is the entire
  // backward-compatibility guarantee for today's exact hardcoded number format.
  numberingPolicy?: Record<string, {
    prefix?: string;
    separator?: string;
    padWidth?: number;
    includeBranchCode?: boolean;
    resetFrequency?: 'never' | 'yearly' | 'monthly';
  }>;
}

export interface DocumentTemplate {
  id: string;
  name: string;
  language: 'Arabic' | 'English' | 'Urdu';
  pageSize: string; // e.g. "8in x 11in", "4in x 6in" or custom
  isActive: boolean;
  printHeader?: boolean;
  printFooter?: boolean;
  printLogo?: boolean;
  printQrCode?: boolean;
  companyId?: string;
  isPosSale?: boolean;
  shiftId?: string;
  attachmentUrl?: string;
  amountPaid?: number;
  layoutJson?: string;
  gridGapY?: string;
  globalFontFamily?: string;
}

export interface TaxSlab {
  id: string;
  name: string;
  percentage: number;
  companyId?: string | null;
  // Per-company default — pre-fills the header and every new line item's tax slab on
  // every document (Quotation/Invoice/Expense/POS), but never restricts changing it.
  // At most one per company (server-enforced), see src/db/schema.ts.
  isDefault?: boolean;
  // ZATCA VATEX-SA-xx code + human-readable reason, only meaningful for an Exempt ('E')
  // or Zero-rated ('Z') slab — see src/db/schema.ts for why this can't be defaulted.
  exemptionReasonCode?: string | null;
  exemptionReason?: string | null;
}

export interface ProductService {
  id: string;
  name: string;
  description: string;
  // Selling price (invoices/quotations/POS). Purchase/stock-valuation defaults come from
  // costPrice instead — see costPrice's own comment.
  unitPrice: number;
  // Purchasing/stock-valuation price — defaults GRN/PO line unit cost. Undefined on
  // products created before this field existed; every cost-default read falls back to
  // unitPrice in that case (see e.g. InventoryModule.tsx's resolveProductByCode).
  costPrice?: number;
  // Split from the old overloaded `type` column (confirmed via live data 2026-07-27 that
  // 'item'/'service' and 'Sales'/'Purchase' were two different, overlapping classification
  // axes silently sharing one field — 'item' was also, separately, what server-side stock
  // logic checked for, but the form never actually wrote it, making stock deduction dead
  // code for every real product). Now two real fields:
  // itemKind drives every stock-mutating code path (businessLogic.ts, inventory.ts routes)
  // and which products the stock-document item-pickers even offer (InventoryModule.tsx).
  itemKind: 'item' | 'service';
  // Which item-pickers this product shows up in: 0 = Sales & Purchase (Both, the default),
  // 1 = Sales only, 2 = Purchase only. See salesProducts/purchaseProducts filters in
  // InvoiceModule.tsx/QuotationModule.tsx/ExpenseModule.tsx.
  salesPurchaseFlow: 0 | 1 | 2;
  unit?: string;
  isPosItem?: boolean;
  category?: string;
  categoryId?: string;
  base64Image?: string;
  barcode?: string;
  sku?: string;
  defaultWarehouseId?: string;
  binLocation?: string;
  minLevel?: number;
  maxLevel?: number;
  reorderLeadTime?: string;
  companyId?: string;
  isPosSale?: boolean;
  shiftId?: string;
  attachmentUrl?: string;
  amountPaid?: number;
  isActive?: boolean;
  // Weighted rolling averages — updated server-side on every GRN receipt (averageCost)
  // and every invoice/POS sale line (averageSalePrice). See schema.ts's own comment on
  // productsServices for why these are true running averages, not recomputed from
  // history. Optional because rows created before this column existed may not carry it.
  averageCost?: number;
  averageSalePrice?: number;
  totalQuantityPurchased?: number;
  totalQuantitySold?: number;
  // POS grid priority — null/undefined means "not on the priority grid," see
  // schema.ts's productsServices.posGridPosition comment.
  posGridPosition?: number | null;
  // IDs of ModifierGroup rows attached to this product (via productModifierGroups),
  // in display order. Empty/undefined means this product has no modifiers — the
  // default state, unrelated to isPosItem.
  modifierGroupIds?: string[];
}

export interface ModifierChoice {
  id: string;
  label: string;
  priceDelta: number;
  sortOrder?: number | null;
}

export interface ModifierGroup {
  id: string;
  companyId?: string;
  name: string;
  isRequired: boolean;
  isActive?: boolean;
  sortOrder?: number | null;
  choices: ModifierChoice[];
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  taxRegNumber?: string;
  isSystem?: boolean; // Walk-in Customer (undeletable)
  isActive?: boolean;
  companyId?: string;
  isPosSale?: boolean;
  shiftId?: string;
  attachmentUrl?: string;
  // ZATCA Buyer Fields — see customers table in src/db/schema.ts
  buyerType?: 'B2B' | 'B2C';
  vatNumber?: string;
  buildingNumber?: string;
  streetName?: string;
  district?: string;
  city?: string;
  postalCode?: string;
  countryCode?: string;
  // General print-facing Commercial Registration number — not a ZATCA field.
  crNumber?: string;
}

export interface Vendor {
  id: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  taxRegNumber?: string;
  isSystem?: boolean; // Cash Vendor (undeletable)
  isActive?: boolean;
  companyId?: string;
  isPosSale?: boolean;
  shiftId?: string;
  attachmentUrl?: string;
  // ZATCA Address Fields — see vendors table in src/db/schema.ts
  buyerType?: 'B2B' | 'B2C';
  vatNumber?: string;
  buildingNumber?: string;
  streetName?: string;
  district?: string;
  city?: string;
  postalCode?: string;
  countryCode?: string;
  // General print-facing Commercial Registration number — not a ZATCA field.
  crNumber?: string;
}

export interface BankAccount {
  id: string;
  bankName: string;
  accountNumber: string;
  accountTitle: string;
  openingBalance: number;
  isActive: boolean;
  isDefault: boolean;
  companyId?: string;
  isPosSale?: boolean;
  shiftId?: string;
  attachmentUrl?: string;
}

export interface FiscalMonth {
  id: string; // e.g. "2026-06"
  name: string; // e.g. "June 2026"
  status: 'Open' | 'Closed';
  closedAt?: string | null;
  closedOption?: 'paid_only' | 'including_pending' | null;
  closedPnL?: {
    totalRevenue: number;
    totalExpenses: number;
    netProfit: number;
  } | null;
  companyId?: string;
  isPosSale?: boolean;
  shiftId?: string;
  attachmentUrl?: string;
}

export interface QuotationItem {
  id: string;
  description: string;
  unitCost: number;
  quantity: number;
  discountAmount?: number; // Line-item flat discount amount to be reduced from unit cost
  taxSlabId?: string; // Optional line-item tax slab ID
  taxRate?: number; // Optional line-item tax rate override
  unit?: string; // ZATCA UN/ECE Rec 20 unit code (see src/zatcaUnitCodes.ts), inherited from the matched product
  productId?: string; // Set only when this line was selected via ItemCatalogSearch, not free-typed
  // Nullable: null/undefined means the product's own base unit. See
  // ProductUnitConversion's comment for the full packaging-unit model. Carried through
  // (not converted) into the invoice this quotation converts to — quotations never touch
  // inventory themselves.
  unitOfMeasureId?: string | null;
  conversionFactor?: number; // client-side display convenience only, see PosCartItem's comment
}

export interface Quotation {
  id: string; // UUID or key
  quotationNumber: string; // e.g. "QT-0001"
  date: string; // YYYY-MM-DD
  customerId: string;
  taxSlabId: string;
  notes: string;
  status: 'Draft' | 'Sent' | 'Accepted' | 'Converted' | 'Cancelled';
  createdById: string;
  createdAt: string;
  items: QuotationItem[];
  discountPercentage?: number; // Header level percentage discount (e.g., 5 for 5%)
  companyId?: string;
  isPosSale?: boolean;
  shiftId?: string;
  attachmentUrl?: string;
  // Dedicated cancel flag, separate from `status` (the phase field: Draft/Sent/Accepted/
  // Converted). A quotation displays as "Cancelled" whenever this is true, regardless of
  // what phase it was in when cancelled — see POST /quotations/:id/cancel.
  isCancelled?: boolean;
  branchId?: string | null;
}

export interface InvoiceItem {
  id: string;
  description: string;
  unitCost: number;
  quantity: number;
  discountAmount?: number; // Line-item flat discount amount to be reduced from unit cost
  taxSlabId?: string; // Optional line-item tax slab ID for per-item ZATCA VAT rates
  taxRate?: number; // Optional line-item tax rate override
  unit?: string; // ZATCA UN/ECE Rec 20 unit code (see src/zatcaUnitCodes.ts), inherited from the matched product
  productId?: string; // Set only when this line was selected via ItemCatalogSearch, not free-typed
  // Nullable: null/undefined means the product's own base unit. See
  // ProductUnitConversion's comment for the full packaging-unit model. `quantity`/
  // `unitCost` above are always expressed in THIS unit; the server converts to base-unit
  // terms before touching inventory/averages.
  unitOfMeasureId?: string | null;
  conversionFactor?: number; // client-side display convenience only, see PosCartItem's comment
}

export interface Invoice {
  id: string;
  invoiceNumber: string; // e.g. "INV-0001"
  date: string; // YYYY-MM-DD
  customerId: string;
  taxSlabId: string;
  bankId: string;
  paymentStatus: 'Paid' | 'Partially Paid' | 'Unpaid';
  paymentDate: string | null;
  notes: string;
  status: 'Active' | 'Cancelled';
  createdById: string;
  createdAt: string;
  originQuotationId: string | null;
  items: InvoiceItem[];
  discountPercentage?: number; // Header level percentage discount
  amountPaid?: number; // Paid amount tracking
  companyId?: string;
  isPosSale?: boolean;
  shiftId?: string;
  attachmentUrl?: string;
  zatcaStatus?: 'NOT_SUBMITTED' | 'PENDING' | 'SUBMITTING' | 'DISABLED' | 'CLEARED' | 'REPORTED' | 'REJECTED' | 'ERROR';
  uuid?: string;
  icv?: number;
  currentInvoiceHash?: string;
  previousInvoiceHash?: string;
  qrCodeContent?: string;
  xmlContent?: string;
  clearanceTimestamp?: string;
  zatcaValidationResults?: any[];
  // Credit/Debit Note support — same table as regular invoices (see schema.ts and
  // server/routes/transactions.ts's POST /invoices/:id/note).
  documentType?: 'Invoice' | 'CreditNote' | 'DebitNote';
  originalInvoiceId?: string | null;
  creditNoteReason?: string | null;
  branchId?: string | null;
  warehouseId?: string | null;
  // Nullable, optional forever — which employee gets credit for this sale (e.g. for a
  // sales-bonus calculation elsewhere). Never affects totals/tax/ZATCA XML. See
  // JobTitle.isSalesRole's comment for how eligible employees are determined.
  salesAssociateId?: string | null;
}

export interface ExpenseItem {
  id: string;
  description: string;
  unitCost: number;
  quantity: number;
}

export interface Expense {
  id: string;
  expenseNumber: string; // e.g. "EXP-0001"
  date: string; // YYYY-MM-DD
  vendorId: string;
  taxSlabId: string;
  bankId: string;
  paymentStatus: 'Paid' | 'Partially Paid' | 'Unpaid';
  paymentDate: string | null;
  description: string;
  amount: number;
  status: 'Active' | 'Cancelled';
  type: 'Actual' | 'Accrual';
  originAccrualId?: string | null; // linked accrual expense ID for Actual
  accrualSettled?: boolean; // true for Accrual when an Actual has settled it
  settledExpenseId?: string | null; // linked actual expense ID for Accrual
  createdById: string;
  createdAt: string;
  items: ExpenseItem[];
  classification?: 'Expense' | 'Asset'; // Whether this purchase is standard OpEx or CapEx Asset
  assetType?: 'Equipment' | 'Machinery' | 'Tools' | 'Computers' | 'Vehicles' | 'Furniture' | 'Other'; // Asset category
  companyId?: string;
  isPosSale?: boolean;
  shiftId?: string;
  attachmentUrl?: string;
  amountPaid?: number;
  // The vendor's own bill/receipt reference number — required on the create form for
  // every new expense (not enforced at the DB level; see schema.ts's comment).
  billNumber?: string;
  // Fixed pre-filled category for an ordinary (OpEx) expense — see schema.ts's comment.
  expenseType?: 'Admin Expenses' | 'Staff Salaries' | 'Office Purchases' | 'Repair and Maintenance' | 'Govt Expenses' | 'Other Expenses';
}

export interface RecurringExpenseTemplate {
  id: string;
  description: string;
  vendorId: string;
  defaultAmount: number;
  taxSlabId: string;
  isActive: boolean;
  bankId: string;
  companyId?: string;
  isPosSale?: boolean;
  shiftId?: string;
  attachmentUrl?: string;
}

export interface RecurringPosting {
  id: string; // templateId_monthId
  templateId: string;
  monthId: string;
  status: 'Unposted' | 'Posted as Actual' | 'Posted as Accrual' | 'Accrual Settled';
  expenseId: string | null;
  companyId?: string;
  isPosSale?: boolean;
  shiftId?: string;
  attachmentUrl?: string;
}

export interface Voucher {
  id: string;
  voucherNumber: string; // e.g. "VCH-0001"
  type: 'Receipt' | 'Payment' | 'Reversal' | 'TransferOut' | 'TransferIn';
  date: string; // YYYY-MM-DD
  bankId: string;
  amount: number;
  description: string;
  // 'PurchaseBill' added alongside the other three — POST /api/inventory/purchase-bills/
  // :id/pay (server/routes/inventory.ts) already writes this value on every bill payment
  // voucher; the type was never updated to match when that route was built.
  referenceType: 'Invoice' | 'Expense' | 'Transfer' | 'Equity' | 'PurchaseBill';
  referenceId: string; // ID of Invoice, Expense, or other transfer Bank ID
  createdById: string;
  createdAt: string;
  companyId?: string;
  isPosSale?: boolean;
  shiftId?: string;
  attachmentUrl?: string;
  branchId?: string | null;
}

export interface Investor {
  id: string;
  name: string;
  email: string;
  phone: string;
  equityPercentage: number; // e.g., 20%
  profitPercentage?: number; // e.g., 30% for different profit split
  capitalContributed: number; // calculated total or stored
  isActive: boolean;
  notes?: string;
  createdAt: string;
  companyId?: string;
  isPosSale?: boolean;
  shiftId?: string;
  attachmentUrl?: string;
}

export interface BankLedgerEntry {
  id: string;
  date: string;
  type: string;
  voucherNumber: string;
  description: string;
  debit: number; // Receipt/Inflow
  credit: number; // Payment/Outflow
  runningBalance: number;
}

export interface TranslationItem {
  id: string; // usually the english key or a unique id
  key: string;
  en: string;
  ar: string;
  ur: string;
}

export interface PosShift {
  id: string;
  companyId: string;
  userId: string;
  startTime: string;
  endTime?: string;
  startCash: number;
  endCash?: number;
  expectedCash?: number;
  status: 'open' | 'closed';
  notes?: string;
}

export interface PosCartItem {
  productId: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  taxAmount?: number;
  total?: number;
  productName?: string;
  // Nullable: null/undefined means the product's own base unit. See
  // ProductUnitConversion's comment for the full packaging-unit model.
  unitOfMeasureId?: string | null;
  // Client-side convenience only (never sent to the server as-is) — lets the cart display
  // "this line = N base units" without a round-trip; the server always re-resolves the
  // factor independently server/lib/uomConversion.ts.
  conversionFactor?: number;
  // Set only when this line was added via the POS modifier modal (see PosModifierModal
  // in PosModule.tsx). unitPrice above already has every chosen priceDelta folded in —
  // this is display/receipt detail only, and is what productName's "(...)" suffix is
  // built from. Never sent as its own field to the server: by the time this line becomes
  // an invoice_items row, it's already just productName (as description) + unitPrice,
  // exactly like a free-typed line — see CLAUDE.md/the modifier-groups plan for why.
  selectedModifiers?: Array<{ groupName: string; choiceLabel: string; priceDelta: number }>;
}

export interface PosHeldInvoice {
  id: string;
  shiftId: string;
  companyId: string;
  customerId?: string;
  items: PosCartItem[];
  createdAt: string;
  reference: string;
}

export interface Warehouse {
  id: string;
  name: string;
  code: string;
  address?: string;
  isActive?: boolean;
  companyId: string;
  branchId?: string | null;
  type?: 'sales' | 'backend';
  isCompanyDefault?: boolean;
}

export interface Branch {
  id: string;
  companyId: string;
  name: string;
  code: string;
  streetName?: string | null;
  buildingNumber?: string | null;
  district?: string | null;
  city?: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
  phone?: string | null;
  isActive?: boolean;
  isDefault?: boolean;
  defaultWarehouseId?: string | null;
}

export interface UserBranchAssignment {
  userId: string;
  branchId: string;
  isPrimary?: boolean;
}

export interface PurchaseRequisitionItem {
  id: string;
  requisitionId: string;
  productId: string;
  quantity: number;
  purpose?: string;
  productName?: string;
}

export interface PurchaseRequisition {
  id: string;
  prNumber: string;
  requestedBy: string;
  date: string;
  status: 'Draft' | 'Pending' | 'Approved' | 'Rejected' | 'Closed' | 'Cancelled';
  notes?: string;
  companyId: string;
  items?: PurchaseRequisitionItem[];
}

export interface PurchaseOrderItem {
  id: string;
  purchaseOrderId: string;
  productId: string;
  quantityOrdered: number;
  unitPrice: number;
  taxRate?: number;
  productName?: string;
  unitOfMeasureId?: string | null; // null/undefined = the product's own base unit
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  vendorId: string;
  date: string;
  status: 'Draft' | 'Sent' | 'Partially Received' | 'Received' | 'Cancelled';
  requisitionId?: string;
  deliveryDate?: string;
  totalAmount: number;
  companyId: string;
  items?: PurchaseOrderItem[];
}

export interface GoodsReceiptNoteItem {
  id: string;
  grnId: string;
  productId: string;
  quantityReceived: number;
  unitCost: number;
  taxRate?: number;
  batchNumber?: string;
  expiryDate?: string;
  productName?: string;
  unitOfMeasureId?: string | null; // null/undefined = the product's own base unit
}

export interface GoodsReceiptNote {
  id: string;
  grnNumber: string;
  purchaseOrderId?: string;
  vendorId: string;
  warehouseId: string;
  date: string;
  isDsd: boolean;
  receivedBy: string;
  notes?: string;
  vehicleNumber?: string;
  driverName?: string;
  isReversed?: boolean;
  isBilled?: boolean;
  companyId: string;
  items?: GoodsReceiptNoteItem[];
}

export interface PurchaseBill {
  id: string;
  billNumber: string;
  vendorId: string;
  date: string;
  dueDate?: string;
  grnIds: string; // comma-separated
  subTotal: number;
  taxTotal: number;
  grandTotal: number;
  status: 'Unpaid' | 'Partially Paid' | 'Paid' | 'Cancelled';
  amountPaid: number;
  bankId?: string;
  companyId: string;
}

export interface WarehouseDispatchItem {
  id: string;
  dispatchId: string;
  productId: string;
  quantityDispatched: number;
  batchNumber?: string | null;
  expiryDate?: string | null;
  unitOfMeasureId?: string | null; // null/undefined = the product's own base unit
}

export interface WarehouseDispatch {
  id: string;
  dispatchNumber: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  date: string;
  vehicleNumber?: string | null;
  driverName?: string | null;
  driverContact?: string | null;
  expectedArrivalDate?: string | null;
  dispatchedBy: string;
  notes?: string | null;
  status: 'Dispatched' | 'Received' | 'Cancelled';
  companyId: string;
  items?: WarehouseDispatchItem[];
}

export interface WarehouseReceivingItem {
  id: string;
  receivingId: string;
  dispatchItemId: string;
  productId: string;
  quantityReceived: number;
  batchNumber?: string | null;
  expiryDate?: string | null;
  unitOfMeasureId?: string | null;
}

export interface WarehouseReceiving {
  id: string;
  receivingNumber: string;
  dispatchId: string;
  date: string;
  receivedBy: string;
  condition?: string | null;
  discrepancyNotes?: string | null;
  notes?: string | null;
  status: 'Active' | 'Cancelled';
  companyId: string;
  items?: WarehouseReceivingItem[];
}

export interface PurchaseReturnItem {
  id: string;
  returnId: string;
  productId: string;
  quantityReturned: number;
  batchNumber?: string;
  unitOfMeasureId?: string | null; // null/undefined = the product's own base unit
}

export interface PurchaseReturn {
  id: string;
  returnNumber: string;
  grnId: string;
  vendorId: string;
  warehouseId: string;
  date: string;
  notes?: string;
  status: 'Active' | 'Cancelled';
  companyId: string;
  items?: PurchaseReturnItem[];
}

export interface PhysicalStockTakeItem {
  id: string;
  stockTakeId: string;
  productId: string;
  batchNumber?: string;
  systemQuantity: number;
  physicalQuantity: number; // stored exactly as counted, in whatever unit this line used
  variance: number; // computed against the base-unit-converted physicalQuantity
  unitOfMeasureId?: string | null; // null/undefined = the product's own base unit
}

export interface PhysicalStockTake {
  id: string;
  referenceNumber: string;
  warehouseId: string;
  date: string;
  status: 'Draft' | 'Completed' | 'Cancelled';
  performedBy: string;
  notes?: string;
  companyId: string;
  items?: PhysicalStockTakeItem[];
}

export interface InventoryStock {
  id: string;
  productId: string;
  warehouseId: string;
  batchNumber?: string;
  expiryDate?: string;
  quantity: number;
  companyId: string;
}

export interface StockLedgerTransaction {
  id: string;
  productId: string;
  warehouseId: string;
  transactionType: 'GRN' | 'Return' | 'Sale' | 'Adjustment' | 'StockTake' | 'TransferOut' | 'TransferIn';
  referenceId: string;
  date: string;
  quantityChange: number;
  endingQuantity: number;
  batchNumber?: string;
  companyId: string;
}

export interface ProductCategory {
  id: string;
  name: string;
  parentCategoryId?: string;
  purchaseGlGroup?: string;
  salesGlGroup?: string;
  cogsGlGroup?: string;
  isActive?: boolean;
  companyId: string;
  // POS presentation only — see schema.ts's productCategories comment. None of these
  // affect the GL mapping fields above.
  posTabColor?: string | null;
  posTabOrder?: number | null;
  showOnPosTabs?: boolean;
}

export interface UnitOfMeasure {
  id: string;
  name: string;
  code: string;
  isActive?: boolean;
  companyId: string;
}

// A product's packaging/alternate unit — e.g. "Cell 4 AMP" (base unit: Piece) also sold/
// bought as "Carton-12" (1 Carton = 12 Piece), with its own barcode/SKU/price. Inventory
// is always kept in the product's own base unit (productsServices.unit) regardless of
// which unit a transaction was entered in — see server/lib/uomConversion.ts.
export interface ProductUnitConversion {
  id: string;
  productId: string;
  unitOfMeasureId: string;
  conversionFactor: number; // 1 of this unit = N base units
  barcode?: string | null;
  sku?: string | null;
  purchasePrice?: number | null; // independent of productsServices.unitPrice * conversionFactor
  salePrice?: number | null;
  isActive?: boolean;
  companyId: string;
}

// "Job Title" (Sales Associate, Cashier, ...) — deliberately distinct from `Role` (RBAC
// permission bundles for ERP login accounts, see UserRole/Role elsewhere in this file).
// A job title is who someone IS for HR/business purposes; a Role is what an ERP account
// is allowed to click. Never conflate the two.
export interface JobTitle {
  id: string;
  companyId: string;
  title: string;
  description?: string | null;
  // Controls whether employees holding this title are offered on the Invoice's Sales
  // Associate picker — a flag on the title, not a hardcoded string match, so a company
  // phrasing it differently ("Sales Rep", "Account Manager") can still mark it eligible.
  isSalesRole?: boolean;
  isActive?: boolean;
}

// The HR foundation: a real employee roster, independent of `User` (ERP login accounts).
// Not every employee needs ERP access; not every login is tied to a real employee today.
// `User.employeeId` is the only direction this relationship goes.
export interface Employee {
  id: string;
  companyId: string;
  // System-generated at onboarding, digits-only, immutable after creation (e.g. "0042").
  employeeNumber: string;
  name: string;
  jobTitleId: string;
  // Nullable = Head Office / company-wide (the onboarding default) — see
  // schema.ts's employees.branchId comment.
  branchId?: string | null;
  email?: string | null;
  phone?: string | null;
  hireDate?: string | null; // YYYY-MM-DD
  isActive?: boolean;
  terminationDate?: string | null;
  createdAt?: string;
}

export interface ProductWarehouse {
  id: string;
  productId: string;
  warehouseId: string;
  binLocation?: string;
  minLevel?: number;
  maxLevel?: number;
  reorderLeadTime?: string;
  companyId: string;
}
