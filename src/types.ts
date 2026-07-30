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

export function normalizePermissions(p: any, role?: string, isSuperAdmin?: boolean): any {
  const isAdmin = role === 'admin' || isSuperAdmin === true || role === 'super-admin';

  const defaultPermissions = {
    quotation: { view: { enabled: true }, create: { enabled: true } },
    invoice: { view: { enabled: true }, create: { enabled: true } },
    expense: { view: { enabled: true }, create: { enabled: true } },
    pos: {
      access: { enabled: true },
      terminal: { enabled: true },
      shifts: { enabled: true },
      history: { enabled: true },
      return: { enabled: true },
      cancel: { enabled: true },
      discount: { enabled: true }
    },
    customers: {
      view: { enabled: true },
      edit: { enabled: isAdmin }
    },
    vendors: {
      view: { enabled: true },
      edit: { enabled: isAdmin }
    },
    products: {
      view: { enabled: true },
      edit: { enabled: isAdmin }
    },
    categories: {
      view: { enabled: true },
      edit: { enabled: isAdmin }
    },
    units: {
      view: { enabled: true },
      edit: { enabled: isAdmin }
    },
    warehouses: {
      view: { enabled: true },
      edit: { enabled: isAdmin }
    },
    inventory: {
      access: { enabled: true },
      pr: { enabled: true },
      po: { enabled: true },
      grn: { enabled: true },
      stock: { enabled: true }
    },
    cancel: { access: { enabled: isAdmin } },
    investors: { access: { enabled: isAdmin } },
    fiscalMonths: { access: { enabled: isAdmin } },
    banks: { view: { enabled: isAdmin }, edit: { enabled: isAdmin } },
    taxSlabs: { view: { enabled: isAdmin }, edit: { enabled: isAdmin } },
    reports: { access: { enabled: isAdmin } }
  };

  if (isAdmin) {
    return defaultPermissions;
  }

  if (!p || typeof p !== 'object') {
    return {
      ...defaultPermissions,
      // `defaultPermissions` above is the isAdmin=true shape (that's the only other
      // caller that uses it as-is) — every module must be explicitly overridden to
      // false here, not just the ones already using an `isAdmin` ternary internally.
      // quotation/invoice/expense/pos previously fell through as `true` from the
      // spread since they're bare literals above, meaning any non-admin user with no
      // permissions object at all (in particular: a role-based user with zero roles
      // assigned) got full default access to those four modules instead of none.
      quotation: { view: { enabled: false }, create: { enabled: false } },
      invoice: { view: { enabled: false }, create: { enabled: false } },
      expense: { view: { enabled: false }, create: { enabled: false } },
      pos: {
        access: { enabled: false },
        terminal: { enabled: false },
        shifts: { enabled: false },
        history: { enabled: false },
        return: { enabled: false },
        cancel: { enabled: false },
        discount: { enabled: false }
      },
      cancel: { access: { enabled: false } },
      customers: { view: { enabled: false }, edit: { enabled: false } },
      vendors: { view: { enabled: false }, edit: { enabled: false } },
      products: { view: { enabled: false }, edit: { enabled: false } },
      categories: { view: { enabled: false }, edit: { enabled: false } },
      units: { view: { enabled: false }, edit: { enabled: false } },
      warehouses: { view: { enabled: false }, edit: { enabled: false } },
      inventory: {
        access: { enabled: false },
        pr: { enabled: false },
        po: { enabled: false },
        grn: { enabled: false },
        stock: { enabled: false }
      },
      investors: { access: { enabled: false } },
      fiscalMonths: { access: { enabled: false } },
      banks: { view: { enabled: false }, edit: { enabled: false } },
      taxSlabs: { view: { enabled: false }, edit: { enabled: false } },
      reports: { access: { enabled: false } }
    };
  }

  const getValue = (path: string, def: boolean): boolean => getAtPath(p, path, def);

  // `p` is always either a Role's `permissions` JSON (written exclusively by the Roles
  // editor in AdminSettings.tsx, always in this exact `.view`/`.create` shape) or `null`
  // (no role assigned, handled by the `!p` branch above). No legacy-shape fallback is
  // needed here — earlier permission-model iterations required one (removed once roles
  // became the sole source of non-admin permissions; see BACKLOG.md).
  // Default `false` (fail closed) rather than `true`: the Roles editor's checkbox tree
  // shows an unmentioned module as unchecked, so resolution must agree — a module a role
  // never touches must not be silently granted, same as every other module here.
  const viewCreateFor = (modulePath: string) => ({
    view: { enabled: getValue(`${modulePath}.view.enabled`, false) },
    create: { enabled: getValue(`${modulePath}.create.enabled`, false) }
  });

  const productsViewResolved = getValue('products.view.enabled', false);
  const productsEditResolved = getValue('products.edit.enabled', false);

  const canonical = {
    quotation: viewCreateFor('quotation'),
    invoice: viewCreateFor('invoice'),
    expense: viewCreateFor('expense'),
    pos: {
      access: { enabled: getValue('pos.access.enabled', false) },
      terminal: { enabled: getValue('pos.terminal.enabled', false) },
      shifts: { enabled: getValue('pos.shifts.enabled', false) },
      history: { enabled: getValue('pos.history.enabled', false) },
      return: { enabled: getValue('pos.return.enabled', false) },
      cancel: { enabled: getValue('pos.cancel.enabled', false) },
      discount: { enabled: getValue('pos.discount.enabled', false) }
    },
    customers: {
      view: { enabled: getValue('customers.view.enabled', false) },
      edit: { enabled: getValue('customers.edit.enabled', false) }
    },
    vendors: {
      view: { enabled: getValue('vendors.view.enabled', false) },
      edit: { enabled: getValue('vendors.edit.enabled', false) }
    },
    products: {
      view: { enabled: productsViewResolved },
      edit: { enabled: productsEditResolved }
    },
    categories: {
      view: { enabled: getValue('categories.view.enabled', productsViewResolved) },
      edit: { enabled: getValue('categories.edit.enabled', productsEditResolved) }
    },
    units: {
      view: { enabled: getValue('units.view.enabled', productsViewResolved) },
      edit: { enabled: getValue('units.edit.enabled', productsEditResolved) }
    },
    warehouses: {
      view: { enabled: getValue('warehouses.view.enabled', productsViewResolved) },
      edit: { enabled: getValue('warehouses.edit.enabled', productsEditResolved) }
    },
    inventory: {
      access: { enabled: getValue('inventory.access.enabled', false) },
      pr: { enabled: getValue('inventory.pr.enabled', false) },
      po: { enabled: getValue('inventory.po.enabled', false) },
      grn: { enabled: getValue('inventory.grn.enabled', false) },
      stock: { enabled: getValue('inventory.stock.enabled', false) }
    },
    cancel: { access: { enabled: getValue('cancel.access.enabled', false) } },
    investors: { access: { enabled: getValue('investors.access.enabled', false) } },
    fiscalMonths: { access: { enabled: getValue('fiscalMonths.access.enabled', false) } },
    banks: {
      view: { enabled: getValue('banks.view.enabled', false) },
      edit: { enabled: getValue('banks.edit.enabled', false) }
    },
    taxSlabs: {
      view: { enabled: getValue('taxSlabs.view.enabled', false) },
      edit: { enabled: getValue('taxSlabs.edit.enabled', false) }
    },
    reports: { access: { enabled: getValue('reports.access.enabled', false) } }
  };

  return canonical;
}

export interface User {
  id: string;
  username: string;
  password?: string;
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
  themeId?: string; // Selected dynamic theme profile id
  currency?: string; // e.g. "SAR", "USD", "$"
  portalTitle?: string; // Left sidebar brand heading
  portalSubtitle?: string; // Left sidebar brand subtitle
  posSettings?: {
    autoPrint: boolean;
    maxImageSizeKB: number;
    maxImageDimensions?: number;
    defaultReceiptTemplate?: string;
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
}

export interface ProductService {
  id: string;
  name: string;
  description: string;
  unitPrice: number;
  // Confirmed via live data (2026-07-27): all four values are in real use, not a stale
  // convention — 'item'/'service' and 'Sales'/'Purchase' represent two different,
  // overlapping classification axes on the same field. Reconciling that overlap is a
  // product decision, not a types fix — tracked in BACKLOG.md. This union only removes
  // the meaningless `| string` catch-all that previously defeated type-checking entirely.
  type: 'Sales' | 'Purchase' | 'item' | 'service';
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
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  taxRegNumber?: string;
  isSystem?: boolean; // Walk-in Customer (undeletable)
  companyId?: string;
  isPosSale?: boolean;
  shiftId?: string;
  attachmentUrl?: string;
}

export interface Vendor {
  id: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  taxRegNumber?: string;
  isSystem?: boolean; // Cash Vendor (undeletable)
  companyId?: string;
  isPosSale?: boolean;
  shiftId?: string;
  attachmentUrl?: string;
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
}

export interface InvoiceItem {
  id: string;
  description: string;
  unitCost: number;
  quantity: number;
  discountAmount?: number; // Line-item flat discount amount to be reduced from unit cost
  taxSlabId?: string; // Optional line-item tax slab ID for per-item ZATCA VAT rates
  taxRate?: number; // Optional line-item tax rate override
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
  referenceType: 'Invoice' | 'Expense' | 'Transfer' | 'Equity';
  referenceId: string; // ID of Invoice, Expense, or other transfer Bank ID
  createdById: string;
  createdAt: string;
  companyId?: string;
  isPosSale?: boolean;
  shiftId?: string;
  attachmentUrl?: string;
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
  status: 'Draft' | 'Pending' | 'Approved' | 'Rejected' | 'Closed';
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
  companyId: string;
  items?: GoodsReceiptNoteItem[];
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

export interface ProductCategory {
  id: string;
  name: string;
  parentCategoryId?: string;
  purchaseGlGroup?: string;
  salesGlGroup?: string;
  cogsGlGroup?: string;
  companyId: string;
}

export interface UnitOfMeasure {
  id: string;
  name: string;
  code: string;
  companyId: string;
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
