// Single source of truth for the permission model: what modules exist, what leaves each
// one has, and how the Roles editor should present them. `normalizePermissions()`
// (src/types.ts) and the Roles editor's checkbox tree (AdminSettings.tsx) both derive
// from this file instead of hand-maintaining their own copies - that duplication is what
// let a module silently default to full access once already (see the historical-bug
// comment this file's introduction replaced in src/types.ts). To add a new
// permission-gated module: add one entry to PERMISSION_MODULES. Everything else -
// normalizePermissions defaults, the Roles tree UI - follows automatically. You still have
// to add the actual server-side `hasPermission()`/`permissions.x.y.enabled` check in the
// route yourself; the registry defines what's grantable, not where it's enforced.
//
// CRUD semantics for modules whose leaves are create/read/update/delete:
//   - create: allowed to add new records.
//   - read:   allowed to view/list records.
//   - update: allowed to edit an existing record - but only while it's still editable.
//             Cancelled, inactive, or (for invoices) ZATCA-cleared/reported records
//             reject updates regardless of this permission - that's a record-state rule
//             enforced in the route, not something this permission grants around.
//   - delete: for documents (quotation/invoice/expense), this is Cancel - there is no
//             hard delete of a financial record in this app. For master data
//             (customers/vendors/products/...), this is an Active/Inactive toggle, not a
//             row deletion. Either way, "delete" means "retire this record," never "erase
//             it," which is why cancelled/deactivated records still show up (marked as
//             such) rather than disappearing.
// Not every module fits this shape. POS and Inventory are feature-access flags (can this
// actor use the POS terminal at all, can they touch Purchase Orders at all), not CRUD on
// a single resource - forcing them into create/read/update/delete would be artificial, so
// they keep their existing flat leaf lists. Same for the single-flag modules (investors,
// fiscalMonths, reports): "access" is the only meaningful grant there.

export interface PermissionLeafDef {
  key: string;
  label: string;
  // Dotted 'module.leaf' reference to another leaf whose *resolved* value becomes this
  // leaf's default when the role's stored permissions JSON doesn't mention it. Used by
  // categories/units/warehouses to inherit from products, since there's no dedicated UI
  // control for them (see PermissionModuleDef.hidden below) - the referenced module must
  // appear earlier in PERMISSION_MODULES so its value is already resolved.
  fallbackFrom?: string;
}

export interface PermissionModuleDef {
  id: string;
  groupId: string;
  label: string;
  leaves: PermissionLeafDef[];
  // Not shown in the Roles editor tree - exists purely so normalizePermissions() produces
  // a value for routes that check it (e.g. warehouses.view/edit), inherited from the
  // `fallbackFrom` module since there's no standalone checkbox to set it independently.
  hidden?: boolean;
}

export interface PermissionGroupDef {
  id: string;
  label: string;
}

export const PERMISSION_GROUPS: PermissionGroupDef[] = [
  { id: 'pos', label: 'POS' },
  { id: 'sales', label: 'Sales & Receivable' },
  { id: 'procurements', label: 'Procurements' },
  { id: 'inventory', label: 'Inventory & Procurement' },
  { id: 'master_registries', label: 'Master Registries' },
  { id: 'reports', label: 'Financial Reports' },
  { id: 'financial_config', label: 'Financial Configuration' },
  { id: 'governance', label: 'Governance & Staff' },
  { id: 'operations', label: 'Operations & Config' },
];

// Order matters: products must precede categories/units/warehouses so their resolved
// create/read/update/delete values exist for the later modules' `fallbackFrom` lookups.
export const PERMISSION_MODULES: PermissionModuleDef[] = [
  {
    id: 'pos', groupId: 'pos', label: 'POS', leaves: [
      { key: 'access', label: 'Main POS Access' },
      { key: 'terminal', label: 'Terminal Counter Access' },
      { key: 'shifts', label: 'Shifts & Z-Reports Management' },
      { key: 'history', label: 'POS Sales History Access' },
      { key: 'return', label: 'Allow POS Refunds & Returns' },
      { key: 'cancel', label: 'Allow POS Order Cancellations' },
      { key: 'discount', label: 'Allow POS Custom Discounts' },
    ]
  },
  {
    id: 'quotation', groupId: 'sales', label: 'Quotation Book Access', leaves: [
      { key: 'create', label: 'Create Quotations' },
      { key: 'read', label: 'View Quotation Book' },
      { key: 'update', label: 'Edit Quotations' },
      { key: 'delete', label: 'Cancel Quotations' },
    ]
  },
  {
    id: 'invoice', groupId: 'sales', label: 'Sales Invoices Access', leaves: [
      { key: 'create', label: 'Create Sales Invoices' },
      { key: 'read', label: 'View Sales Invoices' },
      { key: 'update', label: 'Update Sales Invoices (Notes & Payments)' },
      { key: 'delete', label: 'Cancel Sales Invoices' },
    ]
  },
  {
    id: 'expense', groupId: 'procurements', label: 'Expense & Vouchers Module', leaves: [
      { key: 'create', label: 'Create Expenses' },
      { key: 'read', label: 'View Expenses' },
      { key: 'update', label: 'Record Expense Payments' },
      { key: 'delete', label: 'Cancel Expenses' },
    ]
  },
  {
    id: 'inventory', groupId: 'inventory', label: 'Inventory & Procurement', leaves: [
      { key: 'access', label: 'Inventory Module Access' },
      { key: 'pr', label: 'Purchase Requisitions (PR) Access' },
      { key: 'po', label: 'Purchase Orders (PO) Access' },
      { key: 'grn', label: 'Goods Received Notes (GRN) Access' },
      { key: 'stock', label: 'Stock Registry & Adjustments Access' },
      // Deliberately separate from `pr` above: submitting a requisition and approving one
      // are different authorities in any real internal-controls model (segregation of
      // duties) — a "can submit PRs" role shouldn't automatically also be "can approve
      // spend." Was previously a hard isAdminUser() gate with no Role-based path at all.
      { key: 'approve', label: 'Approve/Reject Purchase Requisitions' },
    ]
  },
  {
    // Full CRUD shape (unlike the flat pr/po/grn/stock leaves above, which predate this
    // convention) — 'delete' here means Cancel, matching every other financial-document
    // module in this app (there is no hard delete of a posted Purchase Bill).
    id: 'purchaseBills', groupId: 'inventory', label: 'Purchase Bills', leaves: [
      { key: 'create', label: 'Create Purchase Bills' },
      { key: 'read', label: 'View Purchase Bills' },
      { key: 'update', label: 'Edit Purchase Bills' },
      { key: 'delete', label: 'Cancel Purchase Bills' },
    ]
  },
  {
    id: 'purchaseReturns', groupId: 'inventory', label: 'Purchase Returns (Debit Notes)', leaves: [
      { key: 'create', label: 'Create Purchase Returns' },
      { key: 'read', label: 'View Purchase Returns' },
      { key: 'update', label: 'Edit Purchase Returns' },
      { key: 'delete', label: 'Cancel Purchase Returns' },
    ]
  },
  {
    id: 'stockTakes', groupId: 'inventory', label: 'Physical Stock Takes', leaves: [
      { key: 'create', label: 'Start Stock Takes' },
      { key: 'read', label: 'View Stock Takes' },
      { key: 'update', label: 'Edit / Finalize Stock Takes' },
      { key: 'delete', label: 'Cancel Draft Stock Takes' },
    ]
  },
  {
    id: 'customers', groupId: 'master_registries', label: 'Customer Directory Access', leaves: [
      { key: 'create', label: 'Create Customers' },
      { key: 'read', label: 'View Customers CRM' },
      { key: 'update', label: 'Edit Customers CRM' },
      { key: 'delete', label: 'Deactivate Customers' },
    ]
  },
  {
    id: 'vendors', groupId: 'master_registries', label: 'Vendor Directory Access', leaves: [
      { key: 'create', label: 'Create Vendors' },
      { key: 'read', label: 'View Vendors Directory' },
      { key: 'update', label: 'Edit Vendors Directory' },
      { key: 'delete', label: 'Deactivate Vendors' },
    ]
  },
  {
    id: 'products', groupId: 'master_registries', label: 'Products & Inventory Access', leaves: [
      { key: 'create', label: 'Create Products' },
      { key: 'read', label: 'View Products & Pricing' },
      { key: 'update', label: 'Edit Products & Stock' },
      { key: 'delete', label: 'Deactivate Products' },
    ]
  },
  {
    id: 'categories', groupId: 'master_registries', label: 'Product Categories', hidden: true, leaves: [
      { key: 'create', label: 'Create Product Categories', fallbackFrom: 'products.create' },
      { key: 'read', label: 'View Product Categories', fallbackFrom: 'products.read' },
      { key: 'update', label: 'Edit Product Categories', fallbackFrom: 'products.update' },
      { key: 'delete', label: 'Deactivate Product Categories', fallbackFrom: 'products.delete' },
    ]
  },
  {
    id: 'units', groupId: 'master_registries', label: 'Units of Measure', hidden: true, leaves: [
      { key: 'create', label: 'Create Units of Measure', fallbackFrom: 'products.create' },
      { key: 'read', label: 'View Units of Measure', fallbackFrom: 'products.read' },
      { key: 'update', label: 'Edit Units of Measure', fallbackFrom: 'products.update' },
      { key: 'delete', label: 'Deactivate Units of Measure', fallbackFrom: 'products.delete' },
    ]
  },
  {
    id: 'modifierGroups', groupId: 'master_registries', label: 'Modifier Groups', hidden: true, leaves: [
      { key: 'create', label: 'Create Modifier Groups', fallbackFrom: 'products.create' },
      { key: 'read', label: 'View Modifier Groups', fallbackFrom: 'products.read' },
      { key: 'update', label: 'Edit Modifier Groups', fallbackFrom: 'products.update' },
      { key: 'delete', label: 'Deactivate Modifier Groups', fallbackFrom: 'products.delete' },
    ]
  },
  {
    id: 'warehouses', groupId: 'master_registries', label: 'Warehouses', hidden: true, leaves: [
      { key: 'create', label: 'Create Warehouses', fallbackFrom: 'products.create' },
      { key: 'read', label: 'View Warehouses', fallbackFrom: 'products.read' },
      { key: 'update', label: 'Edit Warehouses', fallbackFrom: 'products.update' },
      { key: 'delete', label: 'Deactivate Warehouses', fallbackFrom: 'products.delete' },
    ]
  },
  {
    // One flag per real report (ReportViewer.tsx's actual report-type buttons), not a
    // single blanket 'access' gate — a Sales Rep and an Accountant have genuinely
    // different business reasons to see different reports (VAT/P&L are financial-
    // controller territory; a sales-facing role may only need Outstanding/Sales VAT), and
    // the old single flag couldn't express that distinction at all.
    id: 'reports', groupId: 'reports', label: 'Financial Reports', leaves: [
      // Financial & Statutory
      { key: 'trialBalance', label: 'Trial Balance Ledger' },
      { key: 'salesVat', label: 'Sales VAT Register' },
      { key: 'purchaseVat', label: 'Purchase VAT Register' },
      { key: 'bankLedger', label: 'Bank Statement Ledger' },
      { key: 'profitLoss', label: 'Profit & Loss' },
      { key: 'outstanding', label: 'Outstanding Aging & Balances' },
      { key: 'balanceSheet', label: 'Balance Sheet' },
      { key: 'vatReturnSummary', label: 'VAT Return Summary' },
      { key: 'investorProfitShare', label: 'Investor Profit Share' },
      { key: 'fiscalMonthClosingHistory', label: 'Fiscal Month Closing History' },
      // Sales
      { key: 'salesRegister', label: 'Sales Register' },
      { key: 'itemWiseSales', label: 'Item-wise Sales Report' },
      { key: 'customerStatement', label: 'Customer Statement of Account' },
      { key: 'quotationConversion', label: 'Quotation Conversion Report' },
      { key: 'salesByStaff', label: 'Sales by Staff' },
      { key: 'posShiftSummary', label: 'POS Shift Summary' },
      // Purchase
      { key: 'purchaseRegister', label: 'Purchase Register' },
      { key: 'vendorStatement', label: 'Vendor Statement of Account' },
      { key: 'poStatus', label: 'Purchase Order Status Report' },
      { key: 'grnPoVariance', label: 'GRN vs. PO Variance' },
      // Inventory
      { key: 'stockValuation', label: 'Stock Valuation Report' },
      { key: 'itemProfitability', label: 'Item Profitability Report' },
      { key: 'lowStock', label: 'Low Stock / Reorder Report' },
      { key: 'stockTakeVarianceHistory', label: 'Stock Take Variance History' },
      { key: 'stockMovementLedger', label: 'Stock Movement Ledger' },
    ]
  },
  {
    id: 'investors', groupId: 'financial_config', label: 'Investors & Capital', leaves: [
      { key: 'access', label: 'Investors & Capital Access' },
    ]
  },
  {
    // Viewing the current fiscal month is universal (Dashboard/POS depend on it) and
    // deliberately ungated — only *opening* and *closing* a month are real authorities,
    // and they're kept separate on purpose: opening a new month is low-risk and
    // reversible, closing one locks the whole period and cascades into recurring-template
    // settlement — a materially bigger, harder-to-reverse action that deserves its own
    // grant rather than riding along with "can open months."
    id: 'fiscalMonths', groupId: 'financial_config', label: 'Fiscal Months', leaves: [
      { key: 'open', label: 'Open Fiscal Months' },
      { key: 'close', label: 'Close Fiscal Months' },
    ]
  },
  {
    // A quarterly VAT filing record, not generic CRUD — no `update` leaf exists because
    // there is no in-place edit path at all (Generate/Delete/File only). `file` is its
    // own leaf, deliberately separate from `create`/`delete`, for the same reason
    // fiscalMonths.close is separate from .open: filing is the materially bigger,
    // permanently irreversible action and deserves its own grant.
    id: 'taxReturns', groupId: 'financial_config', label: 'VAT Returns (ZATCA Filing)', leaves: [
      { key: 'create', label: 'Generate VAT Returns' },
      { key: 'read', label: 'View VAT Returns' },
      { key: 'delete', label: 'Delete Generated/Unfiled VAT Returns' },
      { key: 'file', label: 'Mark VAT Returns as ZATCA Filed (Permanent)' },
    ]
  },
  {
    id: 'banks', groupId: 'financial_config', label: 'Bank Accounts Access', leaves: [
      { key: 'create', label: 'Add Bank Accounts' },
      { key: 'read', label: 'View Bank Accounts' },
      { key: 'update', label: 'Edit Bank Accounts' },
      { key: 'delete', label: 'Deactivate Bank Accounts' },
      // Separate from `update`: moving real money between accounts is a financial
      // transaction, not account-metadata editing — different authority, same reasoning
      // as splitting PR submission from PR approval.
      { key: 'transfer', label: 'Perform Interbank Transfers' },
    ]
  },
  {
    // Company profile fields (name/address/contact/logo/currency/theme/portal branding) —
    // deliberately excludes zatcaEnabled, which stays admin-tier-only regardless of this
    // permission (see the guardrail in server/routes/masterEntities.ts's PATCH
    // /companies/:id/settings — same reasoning as the users.create escalation guardrail:
    // this leaf grants editing the company's own profile, not its ZATCA compliance state).
    id: 'companyProfile', groupId: 'financial_config', label: 'Company Profile', leaves: [
      { key: 'read', label: 'View Company Profile' },
      { key: 'update', label: 'Edit Company Profile' },
    ]
  },
  {
    id: 'taxSlabs', groupId: 'financial_config', label: 'Tax Slabs Access', leaves: [
      { key: 'create', label: 'Add Tax Slabs' },
      { key: 'read', label: 'View Tax Slabs' },
      { key: 'update', label: 'Edit Tax Slabs' },
      // No delete leaf: there's no mechanism to remove/deactivate a tax slab today (only
      // set-default exists). Add one here, alongside the actual route, if that changes.
    ]
  },
  {
    // Per-company document-numbering policy (prefix/separator/padding/branch-code display/
    // reset frequency for every document type — server/lib/documentNumbering.ts). Its own
    // leaf rather than folding into companyProfile.update: a company might want to delegate
    // "who can change how invoice numbers look" independently of "who can edit our address/
    // logo/branding," the same reasoning branches got its own module for.
    id: 'documentNumbering', groupId: 'financial_config', label: 'Document Numbering', leaves: [
      { key: 'read', label: 'View Document Numbering Settings' },
      { key: 'update', label: 'Edit Document Numbering Settings' },
    ]
  },
  {
    // Branch (physical location) management. Deliberately no `create` leaf at all —
    // creating a branch is a licensing decision, hardcoded to isSuperAdminUser() in
    // server/routes/branches.ts, mirroring how POST /api/companies itself is gated; a
    // company admin can edit/deactivate/view branches but never mint a new one.
    // `viewAllBranches` is a standalone flag (not CRUD): holding it means a user's
    // reads/writes are not narrowed to their assigned branch(es) at all — same
    // union-of-roles resolution as every other leaf, so a user with ANY role granting
    // this sees every branch regardless of what userBranches rows exist for them.
    id: 'branches', groupId: 'governance', label: 'Branches (Locations)', leaves: [
      { key: 'read', label: 'View Branches' },
      { key: 'update', label: 'Edit Branches' },
      { key: 'delete', label: 'Deactivate Branches' },
      { key: 'viewAllBranches', label: 'View & Act Across All Branches (not just assigned ones)' },
    ]
  },
  {
    // "Job Title" (Sales Associate, Cashier, ...) — deliberately a separate module/
    // concept from the `roles` module above (RBAC permission bundles for ERP login
    // accounts). A job title is who someone IS for HR/business purposes; a Role is what
    // an ERP account is allowed to click. Never conflate the two.
    id: 'jobTitles', groupId: 'governance', label: 'Job Titles', leaves: [
      { key: 'create', label: 'Create Job Titles' },
      { key: 'read', label: 'View Job Titles' },
      { key: 'update', label: 'Edit Job Titles' },
      { key: 'delete', label: 'Deactivate Job Titles' },
    ]
  },
  {
    id: 'employees', groupId: 'governance', label: 'Employees (HR)', leaves: [
      { key: 'create', label: 'Onboard Employees' },
      { key: 'read', label: 'View Employees' },
      { key: 'update', label: 'Edit Employees' },
      { key: 'delete', label: 'Deactivate Employees' },
    ]
  },
  {
    // Employee/staff account management. Deliberately does NOT let a non-admin holder of
    // `users.create`/`users.update` promote anyone (including themselves) to `role:
    // 'admin'` or `isSuperAdmin` — the route forces `role: 'user'` on any account
    // created/edited by an actor who only has this via a Role, not admin tier. Without
    // that guardrail this permission would be a privilege-escalation path; with it, it's
    // safe to hand to e.g. an HR/office-manager role. Assigning an *existing* Role to a
    // new hire is fine (Roles themselves are still admin-defined) — this only stops
    // minting a new admin account.
    id: 'users', groupId: 'governance', label: 'Staff Accounts Access', leaves: [
      { key: 'create', label: 'Enroll New Staff' },
      { key: 'read', label: 'View Staff Directory' },
      { key: 'update', label: 'Edit Staff Accounts' },
      { key: 'delete', label: 'Deactivate Staff Accounts' },
    ]
  },
  {
    // Document print layout (Canvas Designer) — cosmetic/reversible, doesn't touch
    // financial data or the ZATCA submission pipeline (a template only renders data that
    // already exists; misconfiguring one is a print-appearance problem, not a data or
    // compliance one). Good fit for e.g. an IT/design-focused role.
    id: 'templates', groupId: 'operations', label: 'Document Templates Access', leaves: [
      { key: 'create', label: 'Create Document Templates' },
      { key: 'read', label: 'View Document Templates' },
      { key: 'update', label: 'Edit Document Templates' },
      { key: 'delete', label: 'Delete Document Templates' },
    ]
  },
];

export interface PermissionNode {
  id: string;
  label: string;
  permissionPath?: string;
  children?: PermissionNode[];
}

const leafNode = (mod: PermissionModuleDef, leaf: PermissionLeafDef): PermissionNode => ({
  id: `leaf.${mod.id}.${leaf.key}`,
  label: leaf.label,
  permissionPath: `${mod.id}.${leaf.key}.enabled`,
});

// Builds the Roles editor's checkbox tree from the registry above. Rendering rule (chosen
// to exactly reproduce the hand-built tree this replaced):
//   - a group with exactly one visible module whose module has more than one leaf renders
//     that module's leaves directly under the group (no redundant module-label wrapper) -
//     this is POS and Inventory & Procurement.
//   - a module with exactly one leaf renders that single leaf directly under its parent,
//     no wrapper - this is Reports, Investors, Fiscal Months.
//   - everything else (a module with >1 leaf, sharing its group with other modules) gets
//     its own expand/collapse wrapper node - Quotation/Invoice/Expense/Customers/Vendors/
//     Products/Banks/Tax Slabs.
export function buildPermissionTree(): PermissionNode[] {
  const groups = PERMISSION_GROUPS.map(group => {
    const modules = PERMISSION_MODULES.filter(m => m.groupId === group.id && !m.hidden);
    let children: PermissionNode[];
    if (modules.length === 1 && modules[0].leaves.length > 1) {
      children = modules[0].leaves.map(leaf => leafNode(modules[0], leaf));
    } else {
      children = modules.map(mod => {
        if (mod.leaves.length === 1) {
          return leafNode(mod, mod.leaves[0]);
        }
        return {
          id: `module.${group.id}.${mod.id}`,
          label: mod.label,
          children: mod.leaves.map(leaf => leafNode(mod, leaf)),
        };
      });
    }
    return { id: `group.${group.id}`, label: group.label, children };
  }).filter(g => g.children.length > 0);

  return [{ id: 'all', label: 'All Permissions', children: groups }];
}

// Every node id in a freshly-built tree, for "Expand All".
export function allPermissionNodeIds(nodes: PermissionNode[]): string[] {
  const ids: string[] = [];
  const walk = (list: PermissionNode[]) => {
    for (const n of list) {
      ids.push(n.id);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return ids;
}
