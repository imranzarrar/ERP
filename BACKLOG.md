# ERP Stock & Inventory Separation Backlog

This backlog records the milestones, refactoring tasks, and unit tests completed to isolate PR, PO, GRN, and Warehouse modules inside the Inventory system under the woodcraft test company (`comp-woodcraft`).

## 1. Completed Refactoring (Jul 2026)

### UI Isolation & Layout Architecture
- **Tab Access Separator**: Removed the internal sub-tab navigation headers row from `InventoryModule.tsx` to force usage of the main sidebar workspace. Users can only access their specific authorised view (PR, PO, GRN, Stock, Warehouses) with clear separation of duties.
- **Dynamic Headers**: Context-aware title, icon, and actions update based on the currently active sidebar workspace.
- **Conversion to Inline Panels**:
  - Removed all modal overlays (`fixed inset-0 bg-gray-950/65 flex items-center justify-center z-50 p-4 animate-fade-in`) from detail/creation views.
  - Converted PR, PO, GRN, and Warehouse detail viewers and creation forms into beautiful full-width inline panels within the document layout.
  - Form search filters are hidden while a form or detail view is active (`isFormOrDetailOpen`), giving the user a highly focused workspace.
  - Added native "Back to List" navigation buttons to all forms and detail viewers to easily return to listing states.

### Permission Enforcements
- Verified granular RBAC parameters inside the `normalizePermissions` helper in `src/types.ts`:
  - `inventory.pr`: Purchase Requisitions
  - `inventory.po`: Purchase Orders
  - `inventory.grn`: Goods Receipt Notes
  - `inventory.stock`: Stock Registry & Warehouses

---

## 2. Completed Test Suite Records

Added robust, isolated unit tests to ensure stability under different configurations:
- **Test File**: `tests/inventory.test.ts`
- **Normalized Permissions tests**: Verified default fallback permissions for standard users vs. admins/superadmins.
- **Isolated Hook validations**: Verified that `can('inventory.pr')`, `can('inventory.po')`, etc. return exactly the configured values.
- **Translation integrity**: Verified fallback strings on custom/local dictionaries.

**Execution Summary:**
- **Status**: 100% Passed
- **Total Tests**: 31 Passed (including businessLogic, transactions, migrateData, and inventory)

---

## 4. User Assigned Company Persistence Fix (Jul 2026)

### Issue Diagnosis & Resolution
- **Root Cause**: In `/server/routes/users.ts`, the POST route forcefully overwritten `data.companyId = req.targetCompanyId` regardless of whether the requesting user was a Super Admin assigning a specific company. In addition, `setEditingUser` in `AdminSettings.tsx` lacked fallback to `u.defaultCompanyId`.
- **Fix Implementation**:
  - Updated `/server/routes/users.ts` to preserve `data.companyId` provided by Super Admins while enforcing `req.targetCompanyId` for non-super admins. Automatically synchronized `defaultCompanyId`.
  - Updated `AdminSettings.tsx` `handleAddUser` and `setEditingUser` handlers to correctly pass and persist `companyId` and `defaultCompanyId`.
  - Updated company resolution in `AdminSettings.tsx` user list to check `u.companyId || u.defaultCompanyId`.

---

---

## 6. Main Navigation Sidebar Upgrade & Restore Point (Jul 2026)

### Restore Point
- Created backup file `src/App.tsx.backup` for instant rollback capability if desired.

### Sidebar Upgrades Implemented
- **Desktop Collapse Mode**: Added toggle allowing side navigation to collapse into a sleek icon bar (`w-[76px]`) or expand (`w-[270px]`) with smooth CSS transitions.
- **Real-Time Menu Search**: Added filter input in the sidebar to search menu links and sub-items on the fly, auto-expanding parent groups when typing.
- **Enhanced Visual Polish**:
  - High-contrast active indicators with Indigo backgrounds and subtle glow accents.
  - Compact icon-mode tooltips and badges for fiscal status and user profile.
  - Seamless responsive mobile support preserved.

---

## 7. Workspace Graphic Layout & KPI Cards Upgrade (Jul 2026)

### Restore Point
- Created backup files `src/components/InvoiceModule.tsx.backup` and `src/components/QuotationModule.tsx.backup` for instant rollback capability.

### Workspace Upgrades Implemented
- **Analytical KPI Cards**: Integrated 4 glowing analytical KPI metric cards in Invoice and Quotation workspaces (Total Invoiced/Pipeline Value, Collected Revenue/Converted Sales, Outstanding Balance/Open Proposals, and Collection/Conversion Rates).
- **Modernized Workspace Headers**: Upgraded list view headers with workspace title tags, count badges, and styled action triggers.
- **Polished Graphic Styling**: High contrast typography, clean borders, responsive grid layout, and crisp status badges.

---

## 8. Form Label Translation String Cleanup (Jul 2026)

### Issue Corrected
- Resolved literal string syntax issue where `t('{t("...")}')` appeared verbatim on form labels in `InvoiceModule.tsx` and `QuotationModule.tsx`.

### Outcome
- All form field labels across Invoice and Quotation creation forms (including Payment Status radio options, Design Attachment, Notes / Memo, and Header Discount %) now evaluate cleanly and display readable label text.

---

## 9. Compact Tabular Line Item Entry Form Makeover (Jul 2026)

### Restore Point
- Created backup files `src/components/InvoiceModule.tsx.tablebackup`, `src/components/QuotationModule.tsx.tablebackup`, `src/components/ExpenseModule.tsx.tablebackup`, and `src/components/InventoryModule.tsx.tablebackup`.

### Problem Addressed
- Replaced scattered card containers and stacked form field layouts that wasted excessive vertical and horizontal screen space with repeated field labels for every single line item across entry forms.

### Upgrades Implemented
- **Dense Table Grid**: Transformed line item entry across **Invoice**, **Quotation**, and **Expense** forms into compact spreadsheet-style HTML tables with fixed column headers (`#`, `Item Description / Search`, `Unit Price`, `Quantity`, `Discount`, `Total`, and `Actions`).
- **Zero Space Wastage**: Removed duplicate row labels and reduced padding to compact 8px vertical heights, allowing users to view and edit multiple line items seamlessly without scrolling.
- **Interactive Autocomplete**: Preserved full catalog search dropdowns with exact z-index layering inside table cells.
- **Summary Bar**: Integrated bottom action bars displaying live line count indicators and inline row addition buttons.

---

## 11. Single-Field Searchable Grid Entry & Auto-Pricing (Jul 2026)

### Root Causes Identified & Fixed
1. **Grid-Style Data Entry Restored**: Eliminated double controls/extra select fields in line item table cells.
2. **Native HTML5 Searchable Datalist Integration**: Embedded `<datalist id={`*-catalog-${idx}`}>` directly inside the primary grid input in **Invoice**, **Quotation**, and **Expense** tables:
   - **Single Grid Input**: Standard compact text field in the item description column.
   - **Native Auto-Suggest Search**: Displays filtered matches from the sales/procurement catalog as the user types, handled natively by the browser without layout clipping or z-index issues.
   - **Instant Auto-Pricing**: Automatically detects catalog item matches upon typing or selecting, instantly populating the `Unit Price` column.
3. **Pre-Populated Row 1**: All creation forms initialize with Row 1 ready (`[{ description: '', unitCost: 0, quantity: 1 }]`) for immediate data entry.

### Verification
- `lint_applet` and `compile_applet` passed with zero errors. Grid data entry is fast, single-field, fully searchable, and automatically populates unit costs upon selection.

---

## 12. Quotation Save Validation & Blank Item Pruning (Jul 2026)

### Root Causes Identified & Fixed
1. **Empty Description Line Item Validation (`400 Bad Request`)**: When saving a quotation with an empty line item description or default unedited row, `saveQuotation` backend validation failed (`At least one item is required for quotation`).
2. **Frontend Validation & Error Extraction**: Updated `QuotationModule.tsx`, `InvoiceModule.tsx`, and `ExpenseModule.tsx` to:
   - Filter out blank/whitespace-only items (`item.description.trim() !== ""`).
   - Show user-friendly toast (`Please add at least one line item with a description.`) when no valid descriptions are provided, preventing unnecessary failed API calls.
   - Properly parse JSON error responses (`errData.error`) from server routes to present precise error messages to the user.

### Verification
- `lint_applet` and `compile_applet` passed with 0 errors. Saving quotations now succeeds smoothly with populated line items and provides clear validation feedback if empty rows are submitted.

---

## 13. Multi-Company Active Fiscal Month Date Synchronization & Form Isolation (Jul 2026)

### Issue Addressed
- When switching active organizations/companies, form dates and default selections (customers, vendors, banks, tax slabs) in open forms/modals retained values from the previous company. Submitting documents could result in dates falling outside the target company's open fiscal month.

### Resolution & Upgrades Implemented
1. **Dynamic Company Change Listener**: Added reactive state listeners across `QuotationModule`, `InvoiceModule`, `ExpenseModule`, `InventoryModule`, and `RecurringExpenses`.
2. **Fiscal Month Date Syncing**: When active company changes, open document creation forms automatically re-evaluate and set the document date to the target company's active open month (`YYYY-MM-01` or current date if today falls within that open month).
3. **Form Defaults Re-initialization**: Automatically resets default customer, vendor, bank, and tax slab dropdowns to match the newly selected active organization.
4. **Active Session Clean Reset**: Cleanly cancels active edit modes, settlement modals, and purchase request/order forms on company switch to guarantee zero cross-company state leaks.

### Verification
- `lint_applet` and `compile_applet` passed with 0 errors. Switch tests confirm forms re-sync to the target organization's open fiscal month date automatically.

---

## 14. PostgreSQL Single Source of Truth & Zero Overwrite Architecture (Jul 2026)

### Issue Addressed
- Risk of stale local client state overwriting live server data during concurrent user access, multi-session data entry, or transient network connection drops.

### Resolution & Architecture Enforced
1. **PostgreSQL as Sole Source of Truth**: Removed all local storage persistence fallbacks for business entities (`quotations`, `invoices`, `expenses`, `customers`, `vendors`, `products`, `banks`, `months`, etc.).
2. **Zero Overwrite Protection**: Prevented offline state mutations from overwriting PostgreSQL records. If database connectivity is interrupted, the application flags an explicit server sync status warning and halts un-synced writes until connectivity is restored.
3. **Reactive Network Error Diagnostics**: Added explicit error tracking and user notifications for `/api/state` and `/api/migrate` network requests, ensuring concurrent multi-user transactions never operate on dirty or unverified local snapshots.

### Verification
- `lint_applet` and `compile_applet` verified clean with 0 build or lint errors. All data reads and writes strictly bind to PostgreSQL backend endpoints.

---

## 16. Quotation Conversion, Totals Breakdown & Workspace Active Focus (Jul 2026)

### Issues Addressed
1. **Quotation Conversion Positioning & Auto-Scroll**: When clicking "Convert to Invoice" on a quotation or opening creation/edit forms, the form rendered lower on the page or modal stack, causing the active workspace to appear displaced or scroll away.
2. **Line Item Discount Totals Display**: Line item discounts entered during invoice or quotation creation/conversion applied correctly to calculated line totals, but were not broken out explicitly in the bottom summary totals box.
3. **Modal & Workspace Viewport Stacking**: "Receive Pay" in Invoices and conversion forms required auto-scroll and top z-index positioning on the active viewport to stay directly in focus above the workspace.

### Resolution & Architecture Enforced
1. **Direct Backend Conversion & Scroll Alignment**: Updated `handleInitiateCreate`, `handleInitiateEdit`, `handleInitiateConversion`, and `handleConvert` across `QuotationModule.tsx` and `InvoiceModule.tsx` to automatically scroll the window smoothly to top (`window.scrollTo({ top: 0, behavior: 'smooth' })`). `handleConvert` executes `convertQuotationToInvoice` directly against PostgreSQL db state without page reset or screen jumps.
2. **Comprehensive Totals Breakdown**: Updated `calculateInvoiceTotals` in `dbStore.ts` to return `grossSubtotal`, `totalLineDiscount`, and `totalDiscount`. Upgraded the summary totals cards in `QuotationModule.tsx` (create form & conversion form) and `InvoiceModule.tsx` to explicitly present:
   - Items Gross Subtotal
   - Line Item Discounts (when line discounts exist)
   - Net Subtotal
   - Header Discount (when percentage > 0)
   - Total Discount Applied
   - VAT Slab % and Tax Amount
   - Grand Total
3. **Active Workspace Modal Layering & Viewport Accessibility**: Upgraded modal overlay containers across `QuotationModule`, `InvoiceModule`, `ExpenseModule`, `AdminSettings`, and `RecurringExpenses` to use `fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex justify-center items-start overflow-y-auto p-4 md:p-6` with `my-auto` centering on inner modal cards. This guarantees modals remain perfectly aligned within the active viewport, prevents top clipping on tall contents or low-height screens, and preserves smooth scroll capability.

### Verification
- `lint_applet` and `compile_applet` passed with 0 errors. All conversion forms, receive payment settlement modals, confirmation overlays, and totals calculations function smoothly and stay centered on the active workspace.

---

## 17. Company Scoping for Open Fiscal Month Validation & Compact High-Density Header Layouts (Jul 2026)

### Issues Addressed
1. **Company Fiscal Month Validation Scope (`QuotationModule` / `InvoiceModule`)**: When saving quotations or invoices under a non-default company (e.g. `comp-woodcraft`), `openMonth` calculation defaulted without passing `db.selectedCompanyId`, causing document dates to be validated against default company open months and throwing "cannot save in closed month" errors.
2. **Form Header Space Efficiency**: The quotation and invoice creation/edit header forms occupied too much vertical height, pushing the line item grid below the middle of the screen.

### Resolutions & Upgrades Implemented
1. **Scoped `getActiveOpenMonth` & Save Calls**:
   - Updated `QuotationModule.tsx` and `InvoiceModule.tsx` to pass `db.selectedCompanyId` into `getActiveOpenMonth(db, db.selectedCompanyId)`.
   - Updated transaction POST request endpoints to explicitly attach `companyId` query parameters (e.g., `/api/transactions/quotations?companyId=...`), ensuring server-side multi-tenancy validation targets the active organization's open month.
2. **Compact High-Density Form Headers**:
   - Re-architected Quotation and Invoice header forms into a responsive 12-column grid (`grid-cols-1 sm:grid-cols-2 lg:grid-cols-12`).
   - Grouped Document Date, Customer, VAT Slab, Post Inflow Bank, Header Discount, Payment Status, Attachment, and Notes into 1-2 tight, elegant horizontal rows.
   - Reduced container padding and header heights, bringing the Line Items Grid directly up into the top half of the page for high efficiency.

### Verification
- `compile_applet` build succeeded with zero errors. All quotation and invoice saves validate against the correct company's fiscal open month, and form line item grids render in immediate viewport focus.

---

## 18. Multi-Tenant Backend Persistence for Quotation Status Changes & Conversions (Jul 2026)

### Issues Addressed
1. **Quotation Status Update Reversion (`QT-1002`)**: Clicking "Accept" (or changing quotation status to Sent/Draft/Declined) in non-default or active company scopes (e.g. `test-company`) updated state only in local memory without dispatching a `PUT /api/transactions/quotations/:id?companyId=...` request to the PostgreSQL backend. On subsequent automatic state re-fetches, the server returned the unmodified database record (`Draft`), immediately reverting the UI state.
2. **Backend Conversion Synchronization**: Converting an accepted quotation to a sales invoice in the UI did not persist the status change (`Converted`) or new invoice record on the backend API with company multi-tenancy context.

### Resolutions & Upgrades Implemented
1. **API Integration in `handleStatusChange`**:
   - Integrated `fetch('/api/transactions/quotations/:id?companyId=${db.selectedCompanyId}')` with `PUT` method in `QuotationModule.tsx`.
   - Ensured status updates (such as "Accepted" for `QT-1002`) are directly committed to PostgreSQL under the active company's multi-tenancy ID prior to refreshing local state.
2. **API Integration in `handleConvert`**:
   - Integrated `fetch('/api/transactions/quotations/:id/convert?companyId=${db.selectedCompanyId}')` with `POST` method.
   - Automatically synchronizes invoice generation, counter increments, and status transition (`Converted`) across both local memory and PostgreSQL database.

### Verification
- `compile_applet` build succeeded with zero errors. Status changes (including clicking "Accept" on `QT-1002`) now persist instantly to the PostgreSQL database and remain updated upon list refreshes.

---

## 19. Graceful Error Handling for Fiscal Months Fetch Operations (Jul 2026)

### Issues Addressed
1. **Uncaught HTML Error Response Parsing (`AdminSettings.tsx`)**: When fetching fiscal months (`GET /api/transactions/months?companyId=...`), network redirects or non-200 HTTP error responses (e.g., returning HTML error documents) triggered an unhandled client error: `Unexpected token '<', "<!doctype "... is not valid JSON`.

### Resolutions & Upgrades Implemented
1. **Defensive Response Checks in Client Components**:
   - Added `resp.ok` and `content-type` header validation across `AdminSettings.tsx`, `Dashboard.tsx`, and `PosModule.tsx` before executing `.json()` deserialization.
   - Guarded non-OK and non-JSON server responses with soft console warnings, preventing client UI crashes while keeping PostgreSQL as the authoritative backend database.
2. **Explicit Multi-Tenancy Parameter Propagation**:
   - Ensured POST requests for opening and closing fiscal months (`/api/transactions/months?companyId=...`) explicitly carry the active `selectedCompanyId` parameter to maintain proper server-side multi-tenant scoping.

### Verification
- `compile_applet` build succeeded with zero errors. `fiscalMonths` API requests fail gracefully without throwing JSON syntax errors when unexpected responses occur.

---

## 20. Translation API Model Alias Upgrade & Log Optimization (Jul 2026)

### Issues Addressed
1. **Deprecated Model Alias Reference in Translation Endpoint**: Server-side auto-translation background workers called deprecated model alias `gemini-2.5-flash`, causing model lookup errors and fallback warning logs.

### Resolutions & Upgrades Implemented
1. **Upgraded Model Identifier**:
   - Updated `@google/genai` model reference in `server.ts` to `gemini-3.6-flash`.
2. **Refined Log Messaging**:
   - Cleaned up console log outputs in translation handlers to present clean status updates during fallback dictionary resolution without emitting misleading error warnings.

### Verification
- `compile_applet` build succeeded with zero errors. Translation API endpoints utilize active model aliases and fall back cleanly to static dictionary items when needed.

---

## 21. Security Lockdown & Permission/RBAC Architecture (Jul 2026)

Full findings captured in a standalone review report delivered to the project owner; summary of what shipped below. From this point forward, this file is maintained as the project's living backlog — every bug/enhancement found in review gets tracked here with a clear done/deferred status, not just fixed silently.

### Critical security fixes
- **Auth bypass closed**: `isAuthenticated` middleware (`server.ts`) no longer trusts a client-supplied `x-user-id`/query/`Bearer` header as identity — only a verified session cookie or a DB-backed session-id lookup (with expiry check) is accepted. Reproduced and confirmed closed live (`curl -H "x-user-id: admin-1"` now returns 401).
- Removed the hardcoded `'your-secret-key'` session-secret fallback (fails fast at startup if `SESSION_SECRET` unset), the plaintext-password login fallback, the auto-granted `123456` default password for null-password accounts, and the `debug_auth.txt` plaintext auth logging.
- `GET /api/companies` now company-scoped and strips ZATCA private keys/secrets from every response. `POST /api/migrate` and `migrateDataToPostgres` hardened with per-table permission checks, cross-tenant ownership checks, and a privilege-escalation guard on the users branch. `POST /api/audit-logs/purge` now company-scoped for non-super-admins. `/api/state` no longer leaks `taxSlabs`/`warehouses`/`purchaseRequisitions`/`purchaseOrders`/`goodsReceiptNotes`/`inventoryStocks` cross-tenant.
- Entire ZATCA router (`server/routes/zatca.ts`) now requires admin + company ownership on every route (previously had zero auth/scoping checks).
- Fixed missing company-id filters in `transactions.ts` (recurring-postings template lookup, settle-accrual, interbank-transfer bank lookups) and `masterEntities.ts`/`users.ts` upsert-without-ownership-check pattern (companies, banks, tax-slabs, user records). Fixed the dead `'superadmin'` (no hyphen) role-check typo.

### Permission/RBAC architecture
- New `server/lib/authz.ts`: canonical `isSuperAdminUser`, `requirePermission`, `assertOwnsRow` helpers, replacing ~20 copy-pasted ad-hoc role checks.
- `UserRole` extended to include `'super-admin'`. Added real permission-tree nodes for investors, fiscal months, banks, tax slabs, and financial reports (previously hardcoded admin-only or ungated) — wired into the `AdminSettings.tsx` permission editor.
- `src/hooks.ts`'s `can()` now delegates to `normalizePermissions` (single source of truth) instead of a second hand-rolled implementation.
- `App.tsx` now gates actual page **rendering** (not just the sidebar link) using the same permission table the sidebar already trusted — closes the gap where a denied module still rendered in full once its tab was active by any means. Verified live: a restricted user has both the link hidden and the page blocked, matching the server's 403 for the same account.

### Verification performed
- Server restarted from a clean `.env`, exploit re-tested via `curl`, cross-tenant IDOR checks against real seeded data across 3 companies, full login flow tested in-browser (not just curl) for both an unrestricted admin and a permission-restricted user.

---

## 22. Architecture, Scalability & Consistency Pass (Jul 2026)

Follow-up to item 21's review — implements the remaining architecture/scalability/consistency findings. Decisions on scope were confirmed with the project owner (see "Deferred / Backlog" below for what was explicitly *not* done in this pass and why).

### Schema hardening
- `company_id` is now `NOT NULL` with a foreign key to `companies.id` on all 13 tenant-scoped tables that were previously nullable (`users`, `quotations`, `invoices`, `expenses`, `customers`, `vendors`, `products_services`, `vouchers`, `investors`, `document_templates`, `bank_accounts`, `recurring_expense_templates`, `recurring_postings`). `tax_slabs.company_id` stays nullable by design (legacy/shared default tax slabs visible to every company) but now has an FK for referential integrity on non-null values. Every other company-scoped table got an FK added where missing. Migration applied cleanly against live data (zero NULLs existed).

### Concurrency correctness
- Fixed the invoice/quotation/expense/voucher numbering race condition: `getAndIncrementCounter` (`server/lib/businessLogic.ts`) now always takes a transaction executor and uses `SELECT ... FOR UPDATE` to lock the company's counter row for the lifetime of the enclosing transaction, instead of a bare read-then-write that let concurrent requests produce duplicate numbers.

### Scalability safety limits
- Postgres pool now has `max` (default 20, env-configurable via `DB_POOL_MAX`) and `statement_timeout` (default 15s, via `DB_STATEMENT_TIMEOUT_MS`) — previously unbounded.
- `/api/state` and the heaviest list endpoints (`GET /quotations`, `/invoices`, `/expenses`) now default to the most recent 500 rows (env-configurable via `DEFAULT_LIST_LIMIT`, honors `?limit=`/`?offset=` when supplied) instead of an unbounded full-table scan on every request. Response shape unchanged (still a plain array) — no frontend changes needed. New shared helper: `server/lib/pagination.ts`.

### Consolidation
- Removed the duplicate, already-diverged expense-creation route in `transactions.ts` (`POST /transactions/expenses` — no transaction wrapper, no voucher sync, confirmed no frontend caller). `POST /api/expenses` (`expenses.ts`) is the single canonical path.

### ZATCA prototype flagging
- Added a persistent warning banner to the ZATCA onboarding UI stating the integration is sandbox/prototype-only, not validated for real government submission.
- `server/lib/zatca/apiClient.ts` no longer fabricates a fake `CLEARED`/`REPORTED`/`ISSUED` success response when a real (non-sandbox) API call fails — errors now propagate correctly into the existing `zatcaStatus: 'ERROR'` handling in `processInvoiceZatca`, instead of being silently recorded as success.

### Consistency fixes
- `CompanySetup` (types.ts) now includes every ZATCA field present in the `companies` schema — removed 9 `as any` casts in `ZatcaOnboardingWizard.tsx`.
- Urdu (`'Urdu'`) is now a selectable, fully-supported `DocumentTemplate.language` — `DocumentRenderer.tsx` renders RTL with a parallel Urdu translation dictionary (mirroring the existing Arabic one), selectable in `AdminSettings.tsx`'s template editor.
- Added a `round2()` money-rounding helper (`businessLogic.ts`), applied after every intermediate step in the quotation→invoice conversion math and invoice/quotation item storage, instead of a single `.toFixed(2)` at the end that let floating-point drift accumulate.
- **`paymentStatus` data quality fix**: live data showed 4 real values in use (`Unpaid`, `Paid`, `Partial`, `Partially Paid`) against a declared type of `'Paid' | 'Partially Paid' | 'Pending'` — worse than assumed (the type didn't match reality at all, and two spellings of the same partial-payment state existed simultaneously). Fixed: type corrected to `'Paid' | 'Partially Paid' | 'Unpaid'` (matching real usage) across `types.ts`, `dbStore.ts`, and every frontend component that referenced the stale `'Pending'` literal (`InvoiceModule.tsx`, `ExpenseModule.tsx`, `RecurringExpenses.tsx`, `QuotationModule.tsx`) — this also fixed a live bug in `ReportViewer.tsx` where Accounts Receivable/Payable calculations filtered on `paymentStatus === 'Pending'`, a value that never actually occurred in the data, meaning those figures were silently always zero. One-time data migration collapsed existing `'Partial'` rows into `'Partially Paid'`. Added `computePaymentStatus()` (derives status from `amountPaid` vs. total) and wired it into every route that writes `paymentStatus`, replacing blind trust in whatever string the client sent.
- `ProductService.type` tightened from `'Sales' | 'Purchase' | 'item' | 'service' | string` to the same 4 literals without the meaningless `| string` catch-all (confirmed via live data all 4 values are genuinely in use — reconciling the overlapping `item`/`service` vs `Sales`/`Purchase` classification axes is a product decision, not a types fix, and is listed below).

### Verification performed
- `npx tsc --noEmit` run clean after every sub-section. Schema migration applied and re-verified against live 3-company seed data via `/api/state`. Server restarted and spot-checked after each phase.

### Bugs caught during final verification (fixed same pass)
Live testing after the above landed caught two real regressions/leftovers before they shipped:
- **`GET /api/transactions/months` regression**: an earlier pass had added a `fiscalMonths.access` permission check to this *read* route. That broke fiscal-month visibility for any non-admin staff user (Dashboard/POS both depend on every authenticated user being able to see the current period). Fixed by removing the gate from the read path — only *closing/opening* a month (`POST /months`) is meant to be permission-gated, which was already correct.
- **Incomplete `sed` replacement**: the `paymentStatus`/`filterStatus` `'Pending'` → `'Unpaid'` cleanup (single-quoted) missed one double-quoted occurrence in `InvoiceModule.tsx`'s filter logic (`filterStatus === "Pending"`), which would have silently never matched the now-renamed `"Unpaid"` filter option. Fixed.
- Also explicitly verified (per request) that fiscal months are correctly scoped to "the caller's own company, or whatever company a super-admin has selected" — confirmed live: a regular user cannot override via `?companyId=`, a super-admin defaults to their `defaultCompanyId` and can explicitly select any other company.

---

## 23. List/Add Page Split, Invoice Flow Finalization & Critical Permission-Resolution Fix (Jul 2026) — IN PROGRESS

Implementing the approved plan to split every entry-form module into independently-permissioned List and Add/Edit pages, finalize the invoice creation UX, and (new scope added mid-plan) build Sales Returns/Credit Notes. Phases I-IV shipped and verified this pass; Phases V-VIII remain (tracked as in-progress/pending tasks, not yet reflected in a dated section of their own — will get one when they land).

### Phase I — Permission model: `.access` split into `.view`/`.create`
`quotation`, `invoice`, and `expense` permissions split from a single `.access` gate into independent `.view` (see the list) and `.create` (make a new one) permissions, mirroring the existing `customers.view`/`.edit` pattern. Applied consistently across `types.ts` (`normalizePermissions`), every server route (`transactions.ts`, `expenses.ts`), `migrateData.ts`, `hooks.ts`'s alias map, `AdminSettings.tsx`'s permission tree UI, and all direct permission checks in `QuotationModule.tsx`/`ExpenseModule.tsx`.

**Bug found and fixed in passing**: `InvoiceModule.tsx` had never been updated to use `normalizePermissions` at all — it read `currentUser.permissions?.invoiceAccess` and `?.cancelAccess`, flat camelCase fields that don't exist anywhere in the actual stored permission shape. Net effect: **every non-admin user was silently blocked from creating or cancelling invoices**, regardless of what their `invoice`/`cancel` permissions were actually set to. Fixed to use `normalizePermissions` like every other module.

### Phase II — List/Add page split (Quotations, Invoices, Expenses)
Each module now has two independently-permissioned pages/nav entries instead of one page that internally toggles between list and form: `quotations`/`quotations-add`, `invoices`/`invoices-add`, `expenses`/`expenses-add`. New shared cross-cutting state in `App.tsx`: `editTarget: {module, id} | null`, set by a List row's Edit action and consumed by the Add page to prefill instead of create. `handleNavigate` now takes a `preserveEditTarget` flag (defaults to clearing it) so a stale edit target from an abandoned edit can't leak into a later "New X" click via the sidebar.

### Phase III — Finalized invoice creation flow
Both creation paths (direct "New Invoice" and Quotation → "Convert to Invoice") now: save, navigate to the Invoices List, immediately open the print/preview overlay (`DocumentRenderer`, same mechanism every other Print button uses) with the new invoice, and submit to ZATCA in the background — non-blocking, no forced modal. Previously, direct invoice creation force-opened the ZATCA details modal over a form that never got cleared, and quotation conversion gave no feedback at all (the exact inconsistency flagged when this plan was scoped).

### Phase IV — List/Add page split (Customers, Vendors, Products, Categories, Units, Warehouses)
Same pattern applied to `MasterEntities.tsx`, which previously always rendered the form and list side-by-side on one page. Reuses the existing `.view`/`.edit` permissions per entity (no permission model changes needed here — Phase I's split doesn't apply to entities that already had view/edit). Added a "+ New X" action on each List page (previously implicit since the form was always visible).

### Critical fix: a third legacy permission shape was silently mis-resolving real users' access
While verifying Phase I's users still resolve correctly, checked `normalizePermissions` against every real seeded user's actual stored `permissions` JSON (not just the shape assumed during development) and found **a second, older legacy shape in active use that the existing backward-compatibility fallback didn't recognize**: `sales.quotation.enabled` / `sales.invoice.enabled` / `sales.cancel.enabled` / `expense.expense.enabled` (transactional permissions), and `inventory.viewCustomers`/`editCustomers`/`viewVendors`/`editVendors`/`viewProducts`/`editProducts` (master-data permissions) — as opposed to the `<module>.access.enabled` shape the existing fallback logic checked for.

Confirmed via direct resolution testing against live seeded users that this was a **real, active privilege bug**, not a cosmetic gap:
- `user-proc` had `sales.quotation.enabled: false` (explicitly revoked) but resolved to `quotation.view/create: true` — an **over-grant**.
- `user-sales` had `expense.expense.enabled: false` but resolved to `expense.view/create: true` — an **over-grant**.
- `user-cancel` ("Supervisor Sarah (with Cancel)", seeded specifically to test cancel rights) had `sales.cancel.enabled: true` but resolved to `cancel.access: false` — an **under-grant**.
- `user-all`/`user-sales`/`user-cancel` had `inventory.viewCustomers/editCustomers: true` but all resolved to `customers.view/edit: false` — an **under-grant**.

Fixed by extending `normalizePermissions`'s legacy-fallback chain to check this shape too (in priority: new `.view`/`.create` shape → `.access.enabled` shape → this oldest shape → safe default), for `quotation`, `invoice`, `expense`, `cancel`, `customers`, `vendors`, and `products`. Re-verified against all 10 real seeded users post-fix — every one now resolves to exactly what its stored data specifies. Admin-role users were unaffected throughout (they bypass via the `isAdmin` shortcut regardless of stored permission shape).

**Known remaining data-quality issue, not fixed (flagged for admin cleanup, not a code bug)**: `usr-test-proc` has `{"expenses": {"access": {"enabled": true}}}` — plural `"expenses"`, which doesn't match any recognized legacy shape (singular `"expense"` is correct everywhere else). Falls through to the safe default (same as a user with no permissions set) rather than silently granting or denying something specific — not dangerous, but the stored value doesn't do what it looks like it should. Should be corrected via the Admin Settings UI now that the permission tree is present.

### Verification performed
- `npx tsc --noEmit` clean after every phase.
- Permission-resolution correctness verified directly (not just by inspection) by running `normalizePermissions` against every real seeded user's actual stored `permissions` JSON pulled live from Postgres, comparing resolved output to stored intent.
- List/Add navigation state transitions (tab changes, `editTarget` set/clear) verified via direct React fiber-state inspection, since the browser preview pane was not compositing frames in this session (a tooling limitation, not an app bug) — a full manual click-through is still recommended before considering this shipped.

---

## 24. Role-Based Permissions — Company-Scoped, Multi-Role (Jul 2026)

Replaces the per-user permission model (item 23) with reusable, named **Roles**. Prompted directly by item 23's findings: assigning permissions one checkbox at a time per user had already produced four inconsistent legacy JSON shapes across ten real seeded accounts, with two of them silently ignoring an explicit `true`/`false` the admin had actually set. Roles fix the cause, not just the symptom: an admin defines a permission set once (e.g. "Sales Rep", "Cashier") and assigns it to as many users as needed — changing the role changes everyone holding it.

Explicit requirements from the project owner, both load-bearing on the design:
- **Roles are company-scoped** — a role belongs to exactly one company and can only be assigned to a user of that same company (enforced server-side, not just in the UI).
- **A user can hold multiple roles** — effective permissions are the **union** (OR, per leaf) of every assigned role, so a page granted by two roles just renders once, never doubled or conflicting.
- **No data-preservation constraint** (explicit project-owner decision) — existing users' ad-hoc `permissions` were not migrated; this was used to justify a clean cutover (dropping the legacy `users.permissions` column entirely) instead of carrying forward three legacy JSON shapes indefinitely.

### Data model
- New `roles` table (`src/db/schema.ts`): `id`, `companyId` (`NOT NULL` FK), `name`, `permissions` (jsonb), unique on `(companyId, name)`.
- New `userRoles` many-to-many junction table (`userId`, `roleId`, composite PK) — added after the project owner clarified mid-implementation that a single `users.roleId` column (the original plan) doesn't support multiple roles per user.
- `users.permissions` column **dropped**. Migration applied directly via `psql` rather than `drizzle-kit push`, which needs an interactive TTY to disambiguate a column add+drop as either a rename or two separate operations — not available in this environment.

### Server-side resolution (the design's key property)
Every existing call site of `normalizePermissions()`/`can()` across the whole codebase (~20 files, frontend and backend) reads a `user.permissions`-shaped object and needed **zero changes** — only the two places that populate that field changed to source it from the user's assigned roles instead of a stored column:
1. `server.ts`'s `isAuthenticated` middleware — resolves and attaches `req.user.permissions` (in-memory, not a DB column) right after loading the user row.
2. `server.ts`'s `/api/state` handler — resolves the same for every user in the returned array, using `roles`/`userRoles` already fetched by `getFullState()` (`src/db/apiState.ts`).

New pure helper `mergeRolePermissions()` (`src/types.ts`) does the leaf-level OR merge across a user's assigned roles' `permissions` JSON, generic over the tree shape (no hard-coded module list, so new permission nodes never need this function touched).

### CRUD
- New `server/routes/roles.ts`: `GET/POST/DELETE /api/roles`, admin-only, mirroring the existing banks/customers pattern in `masterEntities.ts` (`assertOwnsRow`, company-forced-unless-super-admin). Delete is blocked if the role is still assigned to any user.
- `server/routes/users.ts`'s `POST /` now accepts `roleIds: string[]` and syncs the `userRoles` junction table (full replace, not additive) — each requested roleId is validated against the target user's `companyId` before being accepted; a cross-company id is silently dropped rather than failing the whole save.
- `src/db/migrateData.ts`'s bulk users branch (`/api/migrate`) got the same `roleIds` handling for consistency, since it's a second, less-used path that can also write user records.

### Frontend (`AdminSettings.tsx`)
- Extracted the permission-tree UI (previously hardwired to the user-edit form's local state) into a standalone, reusable `PermissionTree` component — used exclusively by the new **Roles** tab now.
- New Roles tab (governance group): create/edit/delete, company-scoped, reuses the existing super-admin company-selector pattern already established for banks/tax-slabs.
- User form's inline permission tree replaced with a multi-select Role checklist; the old "must have at least one transaction permission" guard became "must have at least one Role" (non-admin accounts fail closed with zero roles, by design).
- The per-user "RBAC Scope" badge on each staff card now lists assigned role names instead of individually re-derived permission tags.

### Two critical bugs found and fixed during verification (not introduced by this feature, but made much more consequential by it)
Verification didn't stop at "does the new code work" — every resolution path was checked against real data and adversarial inputs (empty role, role missing a module) before considering this done:
- **Fail-open on zero permissions**: `normalizePermissions`'s `!p` fallback branch (used when a non-admin has no permissions object at all — now the default state for any user with no role assigned) spread `defaultPermissions` first, but only explicitly zeroed out *some* modules (customers, vendors, banks, etc.). `quotation`, `invoice`, `expense`, and every `pos.*` leaf were bare `true` literals in `defaultPermissions` with no override, so they leaked through unfixed. **Concretely: every user with zero roles assigned — the expected default state for a newly created staff account — had full quotation/invoice/expense/POS access**, the opposite of "fails closed by design." Fixed by explicitly zeroing all four in that branch.
- **Fail-open on partial roles**: separately, `quotation`/`invoice`/`expense`/`pos.*` resolution defaulted to `true` when a role's JSON didn't mention that specific module (a leftover from the old opt-out per-user model), while every other module already defaulted to `false`. A role explicitly built to grant *only* Quotation access (via the checkbox tree, which visually showed every other module unchecked) silently also granted full Invoice/Expense/POS access underneath. Verified directly (`normalizePermissions` invoked with a role granting only `quotation`, showing `invoice.view` resolve `true` before the fix) and fixed by changing the default to `false`, matching the checkbox UI's visual truth and every other module's behavior.

### Verification performed
- `npx tsc --noEmit` clean after every step.
- Live end-to-end via direct API calls (`curl`, using the `X-Session-ID` header path since the session cookie is `Secure`-flagged and unusable over plain `http://localhost` from curl): created two roles with conflicting `invoice.create` values, assigned both to a real user, confirmed the resolved permission was the OR/union of the two — not just at the unit level, through the live `/api/login` → `/api/roles` → `/api/users` → `/api/state` path.
- Cross-company rejection verified live: a role explicitly created in a different company was silently dropped when included in a role-assignment request for a user in another company, while a same-company role in the same request was accepted.
- Delete-guard verified live: deleting a role still assigned to a user is rejected; deleting an unassigned role succeeds.
- Both fail-open bugs above reproduced before the fix and re-verified closed after, via direct `normalizePermissions`/`mergeRolePermissions` invocation against constructed inputs (zero roles; a role missing a module) — not just inspection.
- Admin and super-admin bypass reconfirmed unaffected throughout (they never consult the resolved `permissions` field at all).
- Test data created during verification (test roles, test role assignments) was cleaned up via the same API afterward.

---

## 25. Schema ID Migration to UUID (Jul 2026)

Raised by the project owner while reviewing the ZATCA plan: every PK/FK across the schema was a `text` column holding a short random string (e.g. `'role-' + Math.random().toString(36).substring(2, 9)`) — a 36⁷ ≈ 78 billion keyspace whose birthday-paradox expected collision count reaches **~64,000 at 100 million rows**, a real risk given this project's standing SaaS-at-scale requirement (thousands of concurrent users). Random (non-time-ordered) IDs also scatter B-tree inserts instead of appending, hurting the most common ERP query pattern ("this month's records").

### Decision: UUIDv7, not auto-increment integers
Considered three options: (1) `bigint` auto-increment — rejected, breaks the codebase's pervasive client-generates-ID-before-insert pattern and leaks business volume via ID gaps; (2) **UUIDv7 as native `uuid`** — chosen: time-ordered (good B-tree locality), collision-proof, and the existing client-side-ID-generation pattern keeps working, only the generator changes; (3) `crypto.randomUUID()` (v4) — cheaper but keeps the random-scatter problem. Hand-rolled in `src/id.ts` (48-bit ms timestamp + version/variant bits + random tail, using `crypto.getRandomValues` — isomorphic, no new dependency), consistent with this codebase's existing style of small hand-written utilities over added packages.

### What changed
- `src/db/schema.ts`: every `id`/`xxxId` column across all 43 tables converted `text` → `uuid`, **except** `user_sessions.sid` (owned by `connect-pg-simple`, untouched) and `audit_logs.id` (append-only log table — converted to native `bigint generatedAlwaysAsIdentity()` instead, since it gets nothing from unguessable/client-generated IDs and everything from fast sequential appends).
- **Real FK constraints added where none existed before** — the project owner's underlying ask wasn't just "retype the columns," it was "make sure FKs actually exist." ~40 previously-unenforced references (`inventoryStocks.productId`, `purchaseOrders.vendorId`, `goodsReceiptNoteItems.grnId`, `quotations.createdById`, etc.) now have real `REFERENCES` constraints. Genuinely polymorphic columns (`vouchers.referenceId`, `auditLogs.entityId`, `glGroupMappings.entityId`, `stockLedgerTransactions.referenceId` — each points at a different table depending on a sibling type/enum column) intentionally stay plain `uuid` with no single-table FK.
- Migration applied via hand-written SQL (`TRUNCATE` + `ALTER COLUMN TYPE uuid USING col::uuid`, since existing values like `"role-9aum8zs"` aren't valid UUID literals and no data-preservation constraint applied) — `drizzle-kit push` cannot run in this environment (needs an interactive TTY for the ambiguous rename-vs-add/drop diff across 43 tables).
- All 38 client/server ID-generation call sites switched from the old prefixed-random-string scheme to `generateId()`; the `<prefix>-` convention is dropped (a native `uuid` column can't hold a prefixed string) — entity type is inferred from context/table, not encoded in the ID.
- `recurringPostings.id` was previously a synthetic composite string (`${templateId}_${monthId}`) used as its own uniqueness key — replaced with a real generated `uuid` plus an explicit unique index on `(templateId, monthId, companyId)`, with the upsert logic in `server/routes/transactions.ts` updated to match.
- `users.companyId` simplified to a single required field for every user, including super-admins (project-owner suggestion) — the previous two-field design (`companyId` nullable + `defaultCompanyId`) was redundant, since `isSuperAdmin` is what actually grants cross-tenant access, not the presence/absence of a company assignment. `defaultCompanyId` removed everywhere (schema, types, seed data, `App.tsx` login flow, `server.ts` request-scoping middleware, `users.ts`, `migrateData.ts`, `AdminSettings.tsx`).
- **Removed hardcoded fallback-company literals** (`'comp-woodcraft'`, and a `.find(...) || db.companies[0]` "first company" fallback pattern) from ~40 call sites across `AdminSettings.tsx`, `MasterEntities.tsx`, `ReportViewer.tsx`, `PosModule.tsx`, `QuotationModule.tsx`, `InventoryModule.tsx`, `RecurringExpenses.tsx`, and `ZatcaOnboardingWizard.tsx` — flagged directly by the project owner as a multi-tenant data-integrity risk: silently defaulting to an arbitrary company on a missing `selectedCompanyId` could read/write the wrong tenant's data. `selectedCompanyId` is reliably set at login for every user (via `companyId`) and is never expected to be legitimately unset for an authenticated session, so the safe failure mode is no match (empty state), not a guessed default.
- `src/dbStore.ts`'s ~300-entry seed dataset (companies, users, products, customers, vendors, banks, tax slabs, translations, etc.) had every human-readable id (`comp-woodcraft`, `user-all`, `t1`...`t254`, ...) replaced with a real generated UUID, preserving every cross-reference.

### Verification performed
- `npx tsc --noEmit` clean and `npx vite build` clean after every step.
- Migration applied live against the local Postgres instance; confirmed via `\d` that every retyped column is `uuid` (or `bigint identity` for `audit_logs.id`) with the expected FK constraints present.
- Full live chain via `curl` + `X-Session-ID`: login → `/api/state` (companies/users/customers/products all present, real UUIDs, no ZATCA secret fields on the company object) → created a real invoice through `/api/transactions/invoices` (server-computed totals, real customer/tax-slab FKs) → confirmed background ZATCA processing completed (`zatca_status: CLEARED`, correct `invoice_type_code`) → confirmed a sequential `audit_logs` row was written with its new auto-increment `id`.
- Scale smoke-test: batch-inserted 10,000 rows into `invoices` directly via SQL in 0.31s, no errors; cleaned up afterward.
- Auto-seed path (`INITIAL_DB` → Postgres) exercised end-to-end from an empty database twice (once catching the `users.companyId NOT NULL` regression below, once clean).

### Bugs caught during verification (fixed same pass)
- `users.companyId` was made `NOT NULL`, but the seed super-admin user only had `defaultCompanyId` set — caught by a real seeding failure, not inspection. Resolved by the `companyId`-unification design change above (see "What changed"), not a workaround.
- `server/lib/audit.ts` still generated its own client-side `id` for `audit_logs` inserts, conflicting with the column's new identity-column default — removed.
- Several server routes (`businessLogic.ts`'s auto-generated reversal/payment vouchers, `transactions.ts`'s recurring-posting voucher) previously wrote the sentinel string `'system'` into `vouchers.createdById`, now a strict `uuid` FK to `users.id` — fixed by threading the real acting user's id through `syncVoucherForExpense`/`syncVoucherForInvoice` instead of a fake value.

---

## 26. ZATCA Integration Review — Security, Per-Environment State, & Flow Correctness (Jul 2026)

Prompted by the project owner on viewing the ZATCA onboarding screen, asking for a full review of dev/simulation/production environment handling, the OTP flow, CSID lifecycle, and signing. Audited end-to-end against the actual code, ZATCA's official Developer Portal Manual (PDF, provided by the project owner), and the live Integration Sandbox API docs page before writing the fix plan. Landed directly on top of item 25's `uuid` convention (sequenced deliberately, per the project owner's explicit request, though the two ended up overlapping in practice once the project owner confirmed proceeding with both together was fine).

### Findings fixed
1. **CRITICAL — secret leak**: `/api/state` returned the entire `companies` row, including (previously) `zatcaEcdsaPrivateKey` and CSID secrets, to any authenticated session. Resolved structurally: those fields no longer live on `companies` at all (see #2) and are never selected into `getFullState()`.
2. **Shared-slot credentials**: sandbox/simulation/production previously shared one set of company-level columns, so onboarding one environment silently destroyed another's CSID. Fixed with a new `zatcaEnvironmentConfigs` table, one row per `(companyId, environment)`, unique-constrained — the three environments are now fully independent, verified live (onboarded sandbox to completion; simulation/production rows remain untouched/nonexistent).
3. **Hardcoded buyer/tax data in invoice XML**: buyer TIN was a literal fake value, VAT rate was hardcoded to 15% regardless of the invoice's actual tax slab, and invoice type (Standard/Simplified) only looked at POS-vs-not. Fixed in both `processInvoice.ts` and `zatca.ts`'s `generate-invoice-xml`: buyer fields now come from the real `customers` row, VAT rate from the invoice's actual `taxSlabs.percentage`, and invoice type from `customers.buyerType` (B2C → Simplified `0200000`, B2B → Standard `388`), not just the POS flag.
4. **Inconsistent mock-gating**: different `ZatcaApiClient` methods used different conditions for when to mock vs. call the real ZATCA gateway, so `simulation`/`production` behaved identically to `sandbox` in any non-production `NODE_ENV` run. Unified to one rule (`environment !== 'production' || !ZATCA_ALLOW_LIVE_CALLS`) across all five methods, with the live-call path gated behind an explicit env var as a safety interlock.
   **Correction (see item 27)**: this "unified" rule still meant `sandbox` was mocked (`environment !== 'production'` is true for sandbox), so every "live end-to-end sandbox" claim verified below was actually run against fabricated mock responses, not ZATCA's real gateway — caught when the project owner asked directly whether an invoice had genuinely been reported to ZATCA sandbox. Root-caused and fixed for real in item 27; sandbox is now never mocked, unconditionally.
5. **OTP persistence**: previously written to `companies.zatcaOtp` on every call with nothing ever reading it back. Now never persisted — used once, inline, with the CSR exchange. Wizard defaults it to ZATCA's documented `123456` sandbox placeholder only for `sandbox`; blank with real-portal guidance for `simulation`/`production`.
6. **Fabricated compliance results**: `run-compliance-suite` only ever submitted one real test invoice (Standard B2B) and hardcoded the other three claimed scenarios (Simplified B2C, Credit Note, Debit Note) as `CLEARED`. Now genuinely submits both a Standard and a Simplified sample; Credit/Debit Note honestly report `NOT_IMPLEMENTED` (this ERP doesn't generate those document types yet — tracked below) instead of a fabricated pass.
7. **No server-side compliance gate**: `request-production-csid` previously only checked that a `complianceRequestId` existed, not that the compliance suite had actually passed — verified live that Production CSID is now rejected until `run-compliance-suite` has genuinely cleared, then succeeds immediately after.
8. **Wizard UI**: rebuilt around per-environment state — each of sandbox/simulation/production shows its own independent onboarding progress and CSID status, with a separate explicit "set as active for live processing" control per environment, rather than one shared step-tracker.

### Verification performed
- `npx tsc --noEmit` and `npx vite build` clean.
- Live end-to-end sandbox onboarding via `curl`: keypair/CSR generation → compliance CSID issuance → compliance suite (confirmed 2/4 real scenarios cleared, 2/4 honestly `NOT_IMPLEMENTED`) → Production CSID correctly rejected before the suite ran, then correctly issued after.
- Confirmed via direct SQL that `zatca_environment_configs` has exactly one row (sandbox) after the above — simulation/production genuinely untouched.
- Confirmed via `curl` (`/api/state` as the seeded admin) that no ZATCA secret field appears anywhere in the company object.
- Confirmed a real invoice created through the normal transaction flow picks up the real customer's data and the active environment's signing key (via the same `processInvoiceZatca` path exercised in item 25's verification).

---

## 27. Real ZATCA Sandbox Verification — Structural CSR/Hash Fixes & Honest Reporting (Jul 2026)

Follow-up to item 26, prompted directly by the project owner asking "was this invoice reported to zatca sandbox, and there was no error?" — the honest answer was no: item 26's mock-gating "fix" (`environment !== 'production' || !ZATCA_ALLOW_LIVE_CALLS`) left `sandbox` mocked too, so every prior "live sandbox" claim was actually a fabricated response. This item documents making sandbox genuinely real, end to end, plus the real bugs that surfaced once it was.

### Sandbox is now unconditionally real
`ZatcaApiClient.isMocked`: `sandbox` → always `false` (never mocked, no env var needed — ZATCA's sandbox gateway is publicly testable with no business registration, so there's no safety reason to mock it). `simulation`/`production` stay behind the `ZATCA_ALLOW_LIVE_CALLS` interlock, untouched this pass — **no call was ever made to either**, per the project owner's explicit instruction ("dont try to submit on production or simulation, just complete it with sandbox... simulation and production will require real company data").

### Real CSR was structurally broken — found via byte-level ASN.1 diffing, not guessing
The hand-rolled PKCS#10 CSR in `crypto.ts`/`asn1.ts` was rejected outright by ZATCA's real endpoint (`HTTP 400`, generic "Invalid Request", no field-level detail). Root-caused by generating a known-good reference CSR with `openssl` from ZATCA's own documented config and diffing it byte-for-byte (`openssl asn1parse`) against the hand-rolled one. Four real structural bugs found and fixed:
1. Subject DN attribute order must be CN, OU, O, C (was C, O, OU, CN).
2. A required extension OID `1.3.6.1.4.1.311.20.2` ("certificate template name") with value `TSTZATCA-Code-Signing` (sandbox) / `ZATCA-Code-Signing` (production) was missing entirely.
3. The SAN block's "SN" (device serial) field must use OID `2.5.4.4` as UTF8String — was using OID `2.5.4.5` (`serialNumber`) as PrintableString, the wrong OID and wrong ASN.1 type.
4. The SAN `[4] directoryName` GeneralName needs an extra explicit inner `SEQUENCE` wrapping the RDN content that pure IMPLICIT tagging (the X.680 default) would omit.
Confirmed fixed by real, successful CSID issuance (`"dispositionMessage":"ISSUED"`) against ZATCA's live sandbox, both standalone and through the app.

### Real invoice-hash computation was also wrong — a second, independent bug under the first
Even after the CSR was fixed, real invoice submission was rejected with `"invalid-invoice-hash"`. Root cause: `computeInvoiceHash` was plain `SHA-256(raw XML string)`, which never matches ZATCA's real algorithm (canonical XML per its spec: strip `UBLExtensions`/`Signature`/the QR `AdditionalDocumentReference`, C14N-canonicalize, then hash). Fixed by adding real canonicalization (`xmldsigjs`'s `XmlCanonicalizer` + `@xmldom/xmldom`), and by fixing the hash to be computed *after* the `xmlns:ds` attribute was added to the signed XML (it was previously computed on a slightly different XML string than what actually got submitted).

### Other real bugs found only once sandbox calls were genuinely landing
- **UUID mismatch**: `checkCompliance`/`clearStandardInvoice`/`reportSimplifiedInvoice` each generated their own `crypto.randomUUID()` for the request body instead of using the UUID actually embedded in the XML — real ZATCA error `"UUID provided in the invoice doesn't match UUID in the provided Request"`. Fixed by threading one UUID (computed once per invoice) through XML generation, the API call, and the DB save.
- **Endpoint paths wrong against the real gateway**: clearance is `/invoices/clearance/single` (was missing `/single`), reporting is `/invoices/reporting/single` (same), Production CSID is `/production/csids` plural with a snake_case `compliance_request_id` body field (was singular + camelCase) — confirmed against a real, working MIT-licensed reference implementation (`github.com/wes4m/zatca-xml-js`) since ZATCA's own docs don't spell out the exact contract for the latter.
- **`requestComplianceCsid` silently dropped its own response**: ZATCA's real field is `requestID` (capital ID); the code read/stored `issuedRequestId`, which was always `undefined`, so `complianceRequestId` saved as an empty string and broke the downstream Production CSID gate check. Fixed by explicitly mapping the response.
- **XML business-rule violations** (found via ZATCA's own online XML validator): `ProfileID` must always be `reporting:1.0` regardless of invoice type; a second bare `TaxTotal` is required when `TaxCurrencyCode` is present; buyer `PostalAddress` needs `CitySubdivisionName` (district); a `Delivery`/`ActualDeliveryDate` element is required; `InvoiceTypeCode`'s text content is always the literal `388` — the KSA transaction subtype (`0100000` Standard / `0200000` Simplified) belongs on the `name` *attribute*, not the element text (this was backwards). All fixed in `xmlBuilder.ts`.
- **QR code was never embedded in the XML**, only returned as separate API metadata — ZATCA's `BR-KSA-27` rejects this. Fixed with a QR-holding `AdditionalDocumentReference` (`ID=QR`), populated via placeholder-then-substitute (the hash computation strips this element regardless of content, so the real QR can be generated after the hash and swapped in last).

### Confirmed live, against ZATCA's real sandbox gateway
- Real Compliance CSID issuance (`dispositionMessage: "ISSUED"`).
- Real Standard B2B compliance check: `"status":"PASS"`, `"clearanceStatus":"CLEARED"`, zero validation errors.
- Real Simplified B2C compliance check correctly rejects with a specific, honest reason (missing full XAdES-BES enveloped signature — BR-KSA-28/29/30/60) rather than a fabricated pass. Building genuine XAdES signing is a distinct, deeper piece of work matching the pre-existing deferred scope in item 22/"Real ZATCA cryptography" below; not attempted this pass.
- A Compliance CSID genuinely cannot authenticate against the live `/invoices/clearance/single` / `/invoices/reporting/single` endpoints (real `401`) — only a Production CSID can, and Production CSID is correctly gated behind the full compliance suite passing (blocked on the Simplified/B2C XAdES gap above).

### Graceful degradation for the Production-CSID gap
`processInvoiceZatca` previously let every real invoice attempt the doomed live clearance/reporting call once sandbox was un-mocked, surfacing as a raw `zatcaStatus: 'ERROR'` / "Unexpected end of JSON input". Since a Compliance-only CSID predictably 401s there, added an explicit early-exit: when `environment === 'sandbox'` and no Production CSID exists yet, the invoice's real XML/hash/QR are still generated and saved, and `zatcaStatus` is set to `'NOT_SUBMITTED'` with a clear explanatory message, instead of attempting (and failing) the call. Verified live: a fresh invoice now saves cleanly with `status: "NOT_SUBMITTED"`, a real QR code, and a real canonicalized hash — no error.

### What "success" means for sandbox (clarified directly by the project owner)
The project owner clarified the bar is a genuine, valid/OK response from ZATCA's real sandbox gateway — not necessarily full live clearance (which needs a Production CSID, itself gated behind Simplified/B2C support this project doesn't have yet). That bar is met: the Standard B2B Compliance Invoice API call above is a real request/response round-trip against ZATCA's production sandbox infrastructure returning a genuine pass, not a mock.

### How sandbox → simulation → production actually differ (requested by the project owner)
- **Sandbox** (`gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal`): public developer gateway, no real business registration required, documented `123456` OTP placeholder. Used above. Issues real Compliance CSIDs and runs real compliance checks, but a Compliance CSID can never call the live clearance/reporting endpoints (by ZATCA's own design) — sandbox is for developing/testing the XML+crypto pipeline, not for producing invoices with legal standing.
- **Simulation** (`gw-fatoora.zatca.gov.sa/e-invoicing/simulation`): requires a real onboarded taxpayer identity (actual VAT/CR numbers registered with ZATCA, a real OTP generated from the company's actual Fatoora/ERAD portal login) — same API shapes as sandbox/production, used by real businesses to rehearse before going live. Cannot be exercised with this app's current placeholder company data; needs the project owner's real registered business details.
- **Production** (`gw-fatoora.zatca.gov.sa/e-invoicing/core`): the live system — CSIDs issued here sign invoices with real legal effect. Requires the same real registered identity as Simulation, plus (per finding #4 above) `ZATCA_ALLOW_LIVE_CALLS=true` set explicitly as a deploy-time safety interlock, so a staging/dev deploy can never fire a real production call by accident.
- **Practical path once real company data is available**: (1) finish Simplified/B2C XAdES support so the full compliance suite genuinely passes in Sandbox, (2) obtain a Sandbox Production CSID and confirm full live clearance/reporting succeeds there, (3) repeat the same onboarding flow against Simulation with the company's real registered VAT/CR and a real OTP, (4) once Simulation clears consistently, repeat once more against Production with `ZATCA_ALLOW_LIVE_CALLS=true`. No code changes should be needed between these stages — `zatcaEnvironmentConfigs` already keeps the three environments' credentials fully independent (item 26), and `ZatcaApiClient` already targets the right base URL per environment.

### Verification performed
- Real network round-trips to `https://gw-fatoora.zatca.gov.sa` confirmed via direct `curl` (both raw and through the app), never mocked, never touching `simulation`/`production` URLs.
- CSR structure independently re-verified via `openssl req -text -noout` / `-verify -noout` after every fix, not just accepted on ZATCA's response alone.
- `npx tsc --noEmit` clean after every change; server restarted after every `zatca/*.ts` edit before re-testing (a stale-process bug bit this repeatedly early in the pass).
- Fresh invoice re-tested after the graceful-degradation fix: `status: "NOT_SUBMITTED"`, real QR/hash/XML present, no error.

---

## 28. Real XAdES-BES Signing — Simplified/B2C Now Genuinely Clears (Jul 2026)

Follow-up to item 27's honest finding that Simplified/B2C invoices correctly *rejected* at ZATCA's real sandbox for missing a full XAdES-BES enveloped digital signature (BR-KSA-28/29/30/60) — previously deliberately deferred as "requires dedicated ZATCA compliance expertise." The project owner asked for this to be closed out for real, with the same rigor as the CSR fix (no shortcuts, verified against the live sandbox, not assumed from the spec).

### The byte-level signature format could not be resolved from documentation alone
ZATCA's Developer Portal Manual states QR fields 7/8/9 (signature, public key, CA signature) use "IEEE P1363" encoding and a 64-byte public key BLOB. Following that literally (P1363-converting all three signature values, stripping the EC point's `0x04` prefix to 64 bytes) produced consistent, real rejections (`publicKey_QRCODE_INVALID`, `CERTIFICATE_SIGNATURE_QRCODE_INVALID`) against the live sandbox across every combination tried — several rounds of isolated, evidence-based testing (verifying the public key bytes against `openssl`, verifying the DER↔P1363 conversion via round-trip tests, testing both single- and double-hash signing) narrowed the fault to specifically the QR's binary fields, but couldn't resolve it from the manual's text, which turned out to not match ZATCA's own reference implementation's actual behavior.

### Resolution: decompiled ZATCA's own official Java SDK
Installed a JRE (Eclipse Temurin 21, via `winget`) and decompiled `zatca-einvoicing-sdk-238-R3.4.8.jar` with the CFR decompiler (both run entirely locally — nothing left this machine). The real signing code (`com.gazt.einvoicing.signing.service.impl.SigningServiceImpl`, `DigitalSignatureServiceImpl`, `QRCodeGeneratorServiceImpl`) directly contradicts the manual on both points that were blocking:
- **QR tag 8 (public key)**: the SDK passes `certificate.getPublicKey().getEncoded()` — Java's *full SubjectPublicKeyInfo DER bytes*, unmodified. Not a stripped 64-byte raw EC point as the manual's "64 bytes" language implied.
- **Signature encoding (tags 7 and 9, and `ds:SignatureValue`)**: the SDK calls `Signature.getInstance("SHA256withECDSA").sign()` and `X509Certificate.getSignature()` directly, with zero reformatting — Java's default ECDSA signature encoding is ASN.1 DER (matching Node's `crypto.sign()` default), not IEEE P1363 despite what the manual's text says.
- Confirmed as a bonus: QR tag 6 (hash) and tag 7 (signature) are UTF8-text-encoded (their base64 string form treated as text), and tag 9 (CA's signature over the cert) is only included for Simplified invoices, not Standard — both already matched what this codebase had settled on empirically.
- Also caught and fixed a minor QR timestamp format mismatch this way: the SDK formats `yyyy-MM-dd'T'HH:mm:ss` with no trailing `Z`, while the code here had one — a real (if minor) validation warning, now removed.

### What changed
- `server/lib/zatca/x509.ts`: `decodeZatcaCsidCertificate()` now returns the certificate's public key as the full, unmodified SPKI DER buffer (`publicKeySpkiDer`) and its own CA signature as the raw, unconverted DER bytes (`signatureDer`) — the `derSignatureToP1363` conversion function (added, then found unnecessary) was removed entirely.
- `server/lib/zatca/xades.ts`: the invoice's own digital signature reverted to Node's standard `crypto.createSign('SHA256')` DER output (matching Java's `SHA256withECDSA` exactly) — the brief detour through `@noble/curves` for raw-digest signing (to test an alternate, ultimately-wrong hypothesis) was removed, and the dependency uninstalled.
- `server/lib/zatca/xmlBuilder.ts`: QR tag 8 now carries the full SPKI DER buffer; tag 9 is only added for Simplified/B2C invoices (matching the SDK's own conditional); QR timestamp no longer has a trailing `Z`.
- The rest of item 27's XAdES-BES scaffolding (the `ext:UBLExtensions`/`cac:Signature` templates, the `SignedProperties` hash quirk, the indentation-fix hack) needed no changes — those were already correct.

### Confirmed live, against ZATCA's real sandbox gateway
- A real Simplified/B2C compliance-check sample: `"clearanceStatus": "CLEARED"`, zero errors.
- A genuine end-to-end invoice created through the app's own `saveInvoice` logic for a real, newly-created B2C customer (not a synthetic sample): `"clearanceStatus": "CLEARED"`, zero errors, only expected/harmless warnings (a 24-hour-submission-window notice from a backdated test invoice, and the same CRN-format note Standard invoices also get from the shared ZATCA test identity).
- Standard/B2B re-verified unaffected: still clears cleanly with the new signing code active.
- Independently re-confirmed by the project owner via ZATCA's own public XML validator, matching the live API result exactly.

### A second, deeper bug: ZATCA's compliance-check API doesn't validate the XAdES block at all
After the QR-field fixes above, the project owner independently re-verified the resulting XML against ZATCA's own public web validator (not the `/compliance/invoices` API this project had been testing against) and it came back genuinely invalid: `xadesSignedPropertiesDigestValue`, `X509IssuerName`, and `X509SerialNumber` all flagged wrong — despite the compliance API itself reporting `CLEARED` with zero errors for the exact same XML. This confirmed the compliance-check API only validates the QR's cryptographic stamp and the document XSD/business rules, not the embedded `ds:Signature`/XAdES block's own internal consistency — a real gap in this project's testing loop, not just in the XML. From this point on, verification shifted to running ZATCA's own official SDK locally (installing a JDK and its `-validate` CLI command) rather than continuing to trust an API response already shown not to catch this class of bug.

**Two false fixes before the real one, each one revealing the next layer**:
1. First hypothesis: the `xades:SigningTime` timestamp had a trailing `Z` (`...T13:45:12Z`) where ZATCA's SDK (`getCurrentTimestamp()`, decompiled) uses a bare local timestamp with no zone suffix. Fixing the format alone still failed the SDK's own `-validate` with the identical `xadesSignedPropertiesDigestValue` error.
2. Second hypothesis, based on decompiling the signing-side code (`SigningServiceImpl`, which serializes the populated `xades:SignedProperties` node via `dom4j`'s `Node.asXML()` and hashes that string directly): assumed the isolated node, once extracted, needed `xmlns:xades`/`xmlns:ds` declared locally so the fragment would be self-contained. This matched the CSID-signing code's *behavior* on an isolated fragment, but not what should actually be *embedded* in the final document — still rejected.

**The actual answer** came from two things the project owner pointed to directly: ZATCA's own official Java SDK (`zatca-einvoicing-sdk-Java-238-R3.4.8.jar`, decompiled with the CFR decompiler after installing a JDK via `winget`), and — critically — the SDK's own bundled sample invoices (`Data/Samples/Simplified/Invoice/Simplified_Invoice.xml` and its Credit/Debit-note siblings), which are genuinely valid, pre-signed reference files. Running the SDK's own `-validate` command against `Simplified_Invoice.xml` (after restoring the SDK's own dummy CSID cert/key, which had been overwritten mid-session) confirmed `[SIGNATURE] validation result: PASSED` — real, independently-verifiable ground truth, not another assumption.

Diffing that genuinely valid sample's `xades:SignedProperties` block against this project's generated XML revealed the real structure: the sample declares **no local `xmlns:xades`/`xmlns:ds` anywhere** in that subtree — it relies entirely on namespaces inherited from real ancestors further up the document. Decompiling the actual validator class this time (`com.zatca.sdk.service.validation.signature.SignatureValidator`, not the signing-side class assumed to be equivalent) confirmed why both prior attempts failed and what the real algorithm is: the validator re-parses the *submitted* document with `dom4j`, XPath-selects the `xades:SignedProperties` node from within that real document context, and calls `.asXML()` on it — and `dom4j` auto-hoists the inherited namespace declarations onto every element in that *isolated, re-serialized* copy. So there are genuinely two different strings: the bare form (no local namespaces) that gets **embedded**, and the namespace-hoisted form that gets **hashed** — conflating them either way (embedding the hoisted form, or hashing the bare form) produces a self-consistent but wrong digest, which is exactly what both earlier attempts did.

This was confirmed as unambiguously correct, not just plausible, by recomputing the genuine sample's own embedded digest from scratch: parsing the real `Simplified_Invoice.xml` with a small Java program using the SDK's own bundled `dom4j`, extracting `xades:SignedProperties` via the same XPath the validator uses, serializing with `.asXML()`, and hashing it — the result matched the sample's own embedded `DigestValue` byte-for-byte. Applying the identical two-string approach to this project's own XML generation and re-running the SDK's `-validate` command against a real, freshly-created invoice (`INV-1007`, made through the app's actual `saveInvoice` logic, not a synthetic sample) confirmed `[SIGNATURE] validation result: PASSED`.

### What changed (final, verified state)
- `server/lib/zatca/xades.ts`: `buildSignedProperties` split into two functions — `buildSignedPropertiesEmbedded` (no local namespace declarations, embedded as-is in the final XML) and `buildSignedPropertiesForHashing` (identical content and indentation, but with `xmlns:xades`/`xmlns:ds` re-declared on every element that uses them, matching `dom4j`'s real auto-hoisting behavior on isolated-node serialization). The digest is computed from the latter; the former is what actually appears in the signed invoice.
- The two earlier, incorrect approaches (a C14N-canonicalization attempt, and a single-string "everything self-contained" attempt) were removed in favor of this SDK-verified two-string approach.

### Verification performed
- `npx tsc --noEmit` clean after every change; server restarted after every `zatca/*.ts` edit before re-testing.
- Ground truth obtained by running ZATCA's own official SDK locally end-to-end: JDK installed via `winget` (kept in place per the project owner's request, for continued use through simulation/production onboarding), SDK jar decompiled with CFR, and the SDK's own `-validate` CLI run against both its bundled genuine sample invoices and this project's own generated invoices — with the SDK's dummy CSID cert/key swapped out for this project's real sandbox CSID and back again for each check, and both left in their original state afterward.
- The exact fix was proven correct two independent ways before being called done: (1) recomputing a genuinely valid official sample's own embedded digest from scratch and matching it byte-for-byte, and (2) running the SDK's own `-validate` command against a real invoice created through the app's actual save logic, confirming `[SIGNATURE] validation result: PASSED` (the only remaining failure, `[PIH]`, is an unrelated hardcoded placeholder value in the test invoice's previous-invoice-hash chain, not a signature issue).
- Standard/B2B re-confirmed unaffected throughout (still clears cleanly via the live compliance API with the new signing code active).
- Temporary decompilation tooling (CFR jar, extracted `.class`/decompiled `.java` files, template and sample files pulled from the jar) kept entirely in the session scratchpad, never committed; one-off test scripts and `.java`/`.class` files created in the repo root for each check were deleted immediately after use. The SDK's own certificate/private-key files were restored to their original dummy values after each swap.
- **Final confirmation, independent of all of the above**: the project owner uploaded a real, freshly-generated invoice to ZATCA's own public web validator directly (not the compliance API, not the local SDK) — `xadesSignedPropertiesDigestValue` did not reappear (confirming the digest fix itself), and after one more re-check the invoice validated fully clean. A control test along the way — uploading one of ZATCA's own unmodified SDK sample invoices to the same public validator — came back `Valid: true`, ruling out "the validator rejects sandbox-CA certificates" as an explanation for anything seen during this pass.

---

## 29. ZATCA Onboarding Interface Review & Simulation/Production Readiness (Jul 2026)

Follow-up architecture review requested after items 27/28 proved the sandbox cryptographic core genuinely correct. Goal: close every gap between "works for sandbox" and "seamless, error-free Simulation/Production onboarding" — switch environment, provide a real OTP (~1hr validity), done — plus enforce ZATCA-mandatory customer/vendor fields and give every ZATCA API failure a real diagnostic trail. Full plan reviewed and approved by the project owner before implementation; then implemented, verified against real ZATCA sandbox end-to-end (new company, full onboarding, real B2B + B2C invoices), and self-corrected using its own new logging when a real ZATCA rejection surfaced a bug.

### What changed
- **`apiClient.ts`**: `isMocked` now only true for `production` without `ZATCA_ALLOW_LIVE_CALLS` — Simulation was previously *always* mocked unconditionally (`environment !== 'production'` always true), meaning no code path could ever make a real Simulation call regardless of credentials. Also found and fixed two silent-success bugs while touching this file: `requestProductionCsid` and `clearStandardInvoice`/`reportSimplifiedInvoice` never checked `response.ok`, so a real HTTP rejection without the expected body field would fall through and report a fabricated success (`isOnboarded: true` with an undefined cert; `CLEARED`/`REPORTED` on a real error).
- **`processInvoice.ts`**: the honest `NOT_SUBMITTED` guard (added in item 26 for sandbox only) now applies to every environment — Simulation without a Production CSID no longer falls through to a mocked fake `CLEARED`.
- **Schema**: taxpayer identity (TIN/CR/address) moved from a single shared slot on `companies` into `zatcaEnvironmentConfigs`, per-environment — matching how credentials already worked. Sandbox, Simulation, and Production each need a genuinely different identity (ZATCA's own test identity vs. the company's real registration), and the old shared slot meant onboarding one environment's real data silently overwrote another's. Migrated via hand-written SQL (additive columns, backfill from `companies` into each company's currently-active environment row, then drop the old columns) — no data loss, small existing dataset (2 companies) verified before and after.
- **`ZatcaOnboardingWizard.tsx`**: Steps 3+4 (OTP entry, Compliance CSID issuance) collapsed into one — the target UX is "switch environment, provide OTP, done," and a fresh OTP is only valid ~1 hour, so the extra click was pure avoidable latency. Added client-side identity validation mirroring the server, a confirm-before-regenerating-keypair guard (silently invalidates an already-issued CSID otherwise), a guard against activating a non-onboarded environment, and corrected two stale UI claims (a false "encrypted in Cloud SQL" storage claim, and a "prototype, not compliant" banner that predated items 27/28's real verification work).
- **`server/lib/zatca/validators.ts`** (new): shared VAT/postal-code/mandatory-field validation, used by (a) company identity before CSR generation — catching a malformed value before an OTP attempt is spent on it — and (b) customer/vendor buyer records.
- **Customer/vendor mandatory ZATCA fields**: `customers`/`vendors` already had the right buyer columns (`vatNumber`, address fields, `buyerType`) but nothing enforced them, and — separately discovered while wiring this up — the UI's "VAT Registration Number" field saved into the generic `taxRegNumber` column, not the `vatNumber` column ZATCA XML generation actually reads, so no B2B invoice could ever have carried a real buyer VAT. Added the missing ZATCA fields (buyer type toggle, VAT, full address) to `MasterEntities.tsx`'s customer/vendor form, enforced server-side in `POST /customers`/`/vendors` and again as a final gate in `processInvoiceZatca` before any XML is built. B2B requires a full, verifiable identity; B2C only requires a name, per ZATCA's actual (and much more lenient) Simplified-invoice rules.
- **Structured ZATCA API error logging**: `apiClient.ts`'s thrown errors now carry the full ZATCA response body (previously only `data.message` reached the caller, discarding the `errors` array with the actual field-level detail). Both thrown errors and non-exceptional ZATCA rejections (`clearanceStatus: 'REJECTED'` on an ordinary HTTP 200 — checkCompliance/clearance/reporting can all return this without throwing) are now persisted to the existing `auditLogs` table (`action: 'zatca_api_error'` / `'zatca_invoice_rejected'`) via the project's existing `recordAuditLog` helper, not just a transient `console.error`.
- **`transactions.ts`** (unrelated pre-existing bug found and fixed during end-to-end testing): `POST /invoices` never set `created_by_id`, a `NOT NULL` column — every direct invoice creation through this route failed outright. Other insert paths in the same file (quotation conversion, POS, vouchers) already set it correctly; this one didn't.

### The new logging caught a real bug in this same pass
End-to-end testing (new company, full sandbox onboarding, real B2B + B2C invoices) hit a genuine ZATCA rejection on the first B2B invoice. The new structured logging surfaced ZATCA's actual error — `BR-KSA-44`: a buyer VAT number's first *and last* digit must both be `3`, not just the first, contradicting the commonly-quoted "15 digits starting with 3" rule this project's own validator had used. Fixed the regex (`^3\d{13}3$`) in all three copies (server validator, wizard client mirror, customer/vendor form client mirror) and re-verified live. This is exactly the diagnostic value the logging change was built to provide — a real Simulation/Production rejection is now traceable to ZATCA's own exact reason from `auditLogs`, not left as a generic "clearance failed."

### Verification performed
- `npx tsc --noEmit` clean after every change.
- Full live end-to-end test against real ZATCA sandbox, all done through the actual application code paths (real API routes, real invoice-creation route, real background ZATCA processing — not curl against isolated endpoints): created a brand-new company, bank, tax slab, fiscal month, one B2B customer and one B2C customer; ran the full onboarding sequence exactly as the wizard does (identity → keypair/CSR → OTP → Compliance CSID → compliance suite → Production CSID → set active environment) — Compliance CSID issued, both compliance-suite sample invoices genuinely `CLEARED`, Production CSID issued; created two B2B and two B2C real invoices — all four genuinely cleared/reported by ZATCA's real sandbox (`CLEARED` ×2, `REPORTED` ×2), each with a real signed XML, QR code, and UUID.
- Confirmed the mandatory-field gate live: a B2B customer missing VAT/address is rejected with the specific missing fields named; a B2C customer with just a name saves successfully.
- Confirmed the corrected VAT regex against a real ZATCA rejection and re-acceptance (not just unit-level regex testing).
- Dev server restarted after every server-side change before re-testing (no hot-reload in this project's `tsx server.ts` dev script). All scratch/debug scripts (`check_counts.ts`, `migrate_zatca_identity.ts`, `verify_schema.ts`, `debug_invoice_insert.ts`, `check_audit.ts`, `check_audit2.ts`) deleted after use; the test company/invoices created during verification were left in place as evidence rather than deleted.

---

## 30. ZATCA Key/Certificate Mismatch — Real Sandbox Defect Found, Guarded Against (Jul 2026)

Follow-up to item 29, triggered by the project owner asking for the exact signature failure on a specific invoice (INV-1004, "ZATCA Test Traders Co") to be diagnosed against the real SDK, not assumed fixed from item 28's earlier work.

### Investigation
The SDK's own local `-validate` command reported `[SIGNATURE] FAILED — wrong signature Value` on a real, already-`REPORTED`-by-sandbox invoice. Two hypotheses were tested and ruled out with hard evidence before the real cause was found:
1. **Suspected the main invoice-hash canonicalization** (`hashChain.ts`'s `computeInvoiceHash`, using `xmldsigjs`'s C14N 1.0 vs. the document's declared C14N 1.1) — decompiled the SDK's real `HashingGenerationServiceImpl` (from item 28's earlier CFR decompilation work), found its exact algorithm (an XSLT strip via Saxon, then genuine Apache Santuario C14N 1.1, then SHA-256), reproduced it independently in a standalone Java program using the SDK's own bundled dependencies, and diffed the resulting canonical XML string against this project's TypeScript output for the same document. **Byte-for-byte identical.** This hypothesis was wrong — the digest computation was never broken.
2. **Root cause, confirmed empirically**: the stored ECDSA private key for this company's sandbox environment did not correspond to the public key embedded in its Production CSID certificate — a genuine key/cert mismatch, verified directly via Node's `crypto.X509Certificate` API (`certPublicKeyDer.equals(derivedPublicKeyDer)` → `false`, and a real sign-then-verify round trip using the stored key+cert → `false`). The Compliance CSID certificate, by contrast, matched correctly.
3. **Isolated further**: generated a brand-new keypair, fresh CSR, fresh Compliance CSID (verified matching), fresh passing compliance suite — and requested a fresh Production CSID. **ZATCA's sandbox returned the exact same mismatched certificate again** (identical serial `1100003803C5F74023B3FC5C5F000100003803`, identical public key, subject `CN=TST-886431145-399999999900003, O=Maximum Speed Tech Supply LTD` — not this project's company at all). Reproduced a third time via the newly-added guard's audit log capture, byte-for-byte identical to the first occurrence.
4. **Conclusion**: ZATCA's sandbox `/production/csids` endpoint deterministically returns a fixed, canned certificate for the shared public sandbox test taxpayer identity (VAT `399999999900003` / CR `886431145`, ZATCA's own documented test values), independent of the CSR or key actually submitted. This is a sandbox-side behavior tied to the shared identity, not a defect in this project's cryptography, CSR construction, hashing, or signing code — all of which were independently re-verified as correct during this investigation. It should not recur for Simulation/Production, where each company submits its own real, unique VAT.

### What changed
- **`server/lib/zatca/x509.ts`**: new `certificateMatchesPrivateKey(binarySecurityToken, privateKeyPem)` — decodes a CSID response certificate and compares its SPKI public key against the one derivable from the stored private key.
- **`server/routes/zatca.ts`**: both `request-compliance-csid` and `request-production-csid` now call this check immediately after receiving ZATCA's response and *before* storing anything. A mismatch is a hard failure (HTTP 502, `zatcaStep` tagged `...:keyMismatch`) — the certificate is never stored, and `isOnboarded` is never set to `true` on a broken pairing. Both mismatch errors carry the actual rejected certificate on `err.zatcaResponseBody` so it lands in `auditLogs` (via the existing `logZatcaApiError` from item 29) for future diagnosis without needing to manually decode anything — a gap noticed and fixed mid-investigation, after the first version of this guard didn't preserve the certificate for its own audit log entry.
- Cleared "ZATCA Test Traders Co" sandbox's previously-stored mismatched Production CSID (`productionCsidCert`/`productionCsidSecret` → `null`, `isOnboarded` → `false`) — it had been accepted before this guard existed. The environment now honestly reports `NOT_SUBMITTED` for real invoices via the existing item-29 guard, instead of the false `CLEARED`/`REPORTED` it was silently producing before.

### Verification performed
- Independent Java reproduction of ZATCA's real hash algorithm, verified against both the SDK's own `-generateHash` CLI output and this project's TypeScript output — exact match, ruling out the canonicalization hypothesis with evidence rather than assumption.
- Key/certificate correspondence checked directly via Node's `crypto` module (public key DER comparison + a real sign/verify round trip), not inferred from `-validate` output alone.
- Mismatch reproduced three independent times (original onboarding, immediate retry, full fresh-keypair-and-CSID cycle) — all three returned byte-identical certificates, confirming determinism rather than flakiness.
- Confirmed the new guard rejects the mismatch live (HTTP 502, no DB write) rather than silently accepting it, on all three reproduction attempts.
- `npx tsc --noEmit` clean after every change; dev server restarted before each re-test.
- All scratch/debug scripts and Java artifacts (`HashRepro.java`/`.class`, `xslt-output.xml`, `canonical-output.xml`, `our-canonical-output.xml`, `check_keypair_match.ts`, `check_keypair_history.ts`, `check_cert_identity.ts`, `dump_our_canonical.ts`, `fix_bad_prod_csid.ts`) deleted after use; the SDK's `Data/Input/` folder restored to its original contents.

---

## 31. Comprehensive Sandbox QA Pass — Two Real Concurrency/Data Bugs Found & Fixed (Jul 2026)

Full QA plan at `docs/zatca/sandbox-qa-test-plan.html` (approved by the project owner before execution, results recorded in its §12). Covers the comprehensive B2B/B2C invoice matrix, multi-company onboarding regression (3 companies, one with a deliberately different CR number), and onboarding UX guard checks, run under the same dual-gate protocol (real ZATCA sandbox API + the SDK's independent local validator) established in items 27-30.

### Per-line tax slab was decorative — fixed
The invoice line-item tax-slab dropdown existed in the UI (`InvoiceModule.tsx`) and was collected client-side, but the server discarded it entirely and re-taxed every line at one shared header rate — confirmed live on a genuine mixed-rate invoice (2 lines at 15%, 1 exempt at 0%) before the fix, where the header-level `cac:TaxTotal` only ever reported the first line's rate. Fixed: added `invoice_items.tax_slab_id` (nullable, falls back to the invoice's header slab), per-line rate resolution server-side (`processInvoice.ts`, `transactions.ts`'s `POST /invoices`), and real multi-`TaxSubtotal` grouping in `xmlBuilder.ts` keyed by `(category code, rate)` instead of one hardcoded block. Verified live: two distinct `cac:TaxSubtotal` blocks now emitted correctly, ZATCA's real sandbox cleared it. Surfaced one new legitimate warning, `BR-KSA-23` (VAT exemption reason code) — tracked below, not blocking.

### ICV/PIH hash-chain race condition — a real concurrency bug, found and fixed
Discovered while testing a 20+ line-item invoice case: two invoices for the same company, created back-to-back, both landed on the identical `icv: 7` with an identical `previousInvoiceHash` — a genuine fork in ZATCA's mandatory sequential hash chain. Root cause: `getNextHashChainState` (`hashChain.ts`) had no row lock, and was called from `processInvoiceZatca`, a fire-and-forget background job invoked via `.catch()`, never `await`ed, from the invoice-creation route (`transactions.ts`). Two such jobs starting within milliseconds of each other could both read "the last invoice is X" before either had written its own result back.

**Not a hash-content problem** — worth stating explicitly since it was the first, reasonable hypothesis raised: the hash *values* were already unique per invoice; the bug was a sequencing race in *claiming the next chain position*, not a collision in what got hashed. Mixing additional data (e.g. company id) into the hash formula would not have fixed it.

Fixed by extending the exact row-lock pattern item 22 already proved for the invoice-number counter (`getAndIncrementCounter`'s `SELECT ... FOR UPDATE`) to the ICV/PIH reservation: `processInvoiceZatca` now opens a transaction, locks the company row, resolves the next ICV/PIH (`getNextHashChainState` extended to accept a transaction executor), builds and signs the XML, and durably persists `icv`/`previousInvoiceHash`/`currentInvoiceHash`/`xmlContent` — all before releasing the lock. The slow real ZATCA network call happens *after* the lock releases (deliberately outside it — signing is fast/CPU-only, the network round-trip is not, and holding a row lock across it would serialize every invoice for that company on ZATCA's response time for no reason). Re-verified live: two invoices fired at the exact same instant now get sequential ICVs with an exactly-chained hash (invoice 2's PIH byte-identical to invoice 1's current hash), both cleared by the real sandbox.

**SaaS-scale note (asked directly by the project owner)**: the lock is scoped to a single company's row, so it only ever serializes invoices *within the same company* created within milliseconds of each other — different tenants never contend, and thousands of companies can create invoices fully in parallel. Some serialization within one company is unavoidable: ZATCA's own hash-chain spec requires strict sequential ordering, a compliance constraint no implementation can parallelize away. The lock uses standard Postgres `SELECT ... FOR UPDATE` via the `pg` driver's real TCP connection pool — not tied to any specific host; it works identically on any real Postgres instance (Hostinger, Aiven, a VPS, etc.), the only thing that would break it is switching to an HTTP-only "driverless" Postgres client, which this project doesn't use.

### Corrupted genesis PIH constant — a second, independent real bug
While investigating an earlier, separate question about a `[PIH] FAILED` result from the SDK's `-validate` command, found that `INITIAL_PREVIOUS_INVOICE_HASH` (`hashChain.ts`) — the well-known constant every chain's first invoice must carry as its previous-hash — was itself wrong. It decoded to a truncated, garbled string (`5feceb66ffc86a38`48`) instead of the genuine `SHA256("0")` hex digest, independently verified two ways: Node's `crypto` module and `openssl dgst -sha256` both computed `5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9`. Every chain's genesis invoice was therefore carrying a wrong PIH — exactly why the SDK's `-validate` reported `[PIH] FAILED` even for a chain's very first invoice, where ZATCA's real sandbox API stayed silent because it doesn't audit the genesis link's exact value on submission. A second hardcoded copy of the identical bad literal was found in `zatca.ts`'s `run-compliance-suite` test-sample route and fixed too (now imports the corrected constant instead of duplicating the literal).

Also clarified, as a byproduct of this investigation: `[PIH] FAILED` on any *non-genesis* invoice (`icv > 1`) validated alone via `-validate` is a genuine, permanent tool limitation, not a defect — confirmed by checking `fatoora -help`, which has no flag to supply a referenced predecessor XML for cross-check, so the SDK cannot verify chain continuity for a single isolated file. This is expected and should continue to be ignored per the QA plan's triage rules (§09).

Fixed and verified two independent ways: (1) a standalone genesis invoice built with the corrected constant now gets `[PIH] PASSED` from the SDK, and its hash matches the SDK's own independent `-generateHash` output byte-for-byte; (2) Company 3, onboarded fully fresh through this pass, had its real first invoice (`icv: 1`) reach a clean `*** GLOBAL VALIDATION RESULT = PASSED` across every single SDK check.

### Multi-company onboarding regression — confirmed
Company 2 (partial prior onboarding, completed this pass) and Company 3 (fully fresh, deliberately different CR number `1010299999` vs. `886431145` used elsewhere) both reached full onboarding via the automatic sandbox sample-key adoption (item 30) with zero manual cryptographic steps, matching Company 1 exactly. This resolves item 30's open question about whether ZATCA's static sandbox certificate behavior is keyed on VAT alone or VAT+CR together: Company 3's different CR made no difference — the same known static certificate came back regardless, confirming it's keyed on the shared VAT alone.

### Onboarding UX guards — confirmed live
- **Environment-activation guard**: attempting to activate `production` for a company onboarded only in sandbox is correctly rejected (HTTP 400, specific message) — no path exists to activate a non-onboarded environment for live processing.
- **Invalid-VAT-blocks-CSR guard**: a malformed TIN can be saved as a draft, but CSR generation — the actual point of no return before an OTP gets spent — correctly blocks with a precise field error first.
- **Mandatory-field gate**, tested at both layers independently: `POST /customers` rejects a new incomplete B2B customer outright (HTTP 400), and `processInvoiceZatca`'s final gate independently catches a simulated legacy customer record (inserted directly, bypassing the save-time check) — `NOT_SUBMITTED`/`BUYER_INCOMPLETE`, zero ZATCA API calls made, confirming the gate holds even for data that predates the validation.

### Verification performed
- `npx tsc --noEmit` clean after every change.
- Full dual-gate protocol (real ZATCA sandbox API + SDK's independent `-validate`/`-generateHash`) run against every matrix case this pass — see the QA plan's §12 for the per-case table.
- Concurrency fix specifically verified by firing two real invoice-creation HTTP requests at the exact same instant (not sequentially) through the actual API, then confirming the persisted `icv`/`previousInvoiceHash`/`currentInvoiceHash` chain directly via SQL — done both before the fix (reproducing the fork) and after (confirming sequential, correctly-chained values).
- All scratch/debug scripts created during this pass deleted after use; the SDK's `Data/Input/` folder restored to empty after each validation batch.

### Known gap carried forward (not fixed this pass, tracked below)
The Browser pane did not composite frames during this session (`document.hidden` was `true` on the active tab throughout), which stalls Framer Motion's `AnimatePresence` exit transition and blocked visually opening the Sales Invoices list/print-preview UI. Every invoice's `zatcaStatus`/`invoiceTypeCode` was independently confirmed correct at the database level instead. This is an environment/tooling limitation encountered during this session, not a reproduced defect in the app — but the visual List UI path itself remains unverified and should be manually clicked through before full sign-off.

---

## Deferred / Backlog

Tracked here rather than fixed silently, per the product-manager process adopted in item 21. Each entry below is a real, identified gap — not forgotten, just explicitly out of scope for the review passes completed so far, with the reason why.

- **Postgres Row-Level Security (RLS)**: Deferred from item 22's schema hardening. Would add a fail-closed backstop so a missed `WHERE company_id = ?` in application code returns an empty result instead of leaking data. Requires a bigger architecture change first — wiring a session variable (`SET LOCAL app.current_company_id`) into every request's DB connection/transaction, which doesn't fit the current shared-pool pattern without rework. **Given this project's SaaS-at-scale requirement (thousands of concurrent users, many tenants), this should be revisited as a near-term priority, not indefinitely deferred.**
- **Full paginated API + frontend list-UI rewrite**: Deferred from item 22 in favor of a backend-only safety cap (shipped). Real limit/offset pagination with a `{items, total}` response envelope would require updating `dbStore.ts` and ~10 list-rendering components to fetch pages and render page/load-more controls. Planned to land alongside the upcoming List/Add page-split feature, which will already be touching these same components — doing both together avoids reworking the same files twice.
- **`dbStore.ts` retirement**: `src/dbStore.ts` (1785 lines) is a full parallel reimplementation of invoice/quotation/expense/voucher/month-close business logic, operating on an in-memory seed dataset, imported by 14 frontend files, with no structural link to the real server logic in `server/routes/`. Only the one already-diverged duplicate (expense creation) was consolidated in item 22. Fully retiring this in favor of the frontend calling server APIs directly is a large refactor of its own, also expected to land with the page-split work.
- ~~**Real ZATCA cryptography**~~ — resolved in item 28. The CSR is now a real, ZATCA-accepted PKCS#10 structure (item 27), and full XAdES-BES signing is now implemented and verified live for both Standard and Simplified invoices (item 28).
- **`ProductService.type` classification cleanup**: Live data confirmed `item`/`service` and `Sales`/`Purchase` are both genuinely in use on the same field, representing two different, overlapping classification concepts that were never reconciled. The type was tightened to match reality (item 22) but the underlying data model ambiguity is unresolved — needs a product decision on what this field should actually mean before any further schema/logic change.
- **List/Add page-split feature — Phases V-VIII remaining**: Phases I-IV shipped in item 23 (Quotations/Invoices/Expenses/Customers/Vendors/Products/Categories/Units/Warehouses all now have independent List/Add pages). Still pending: Phase V (relocate Banks/Tax Slabs out of Settings into their own List/Add pages), Phase VI (POS/Inventory sub-forms UI split — cosmetic only, no backend routes exist yet), Phase VII (Sales Return/Credit Note feature — new tables, new ZATCA Credit Note XML support), Phase VIII (final backlog writeup for the whole plan).
- **Section 1h leftovers from item 21's review** (lower priority, not yet actioned): `pos.discount`/`pos.cancel` permissions have no backend route to enforce against yet (POS sale/discount endpoints don't exist server-side); `inventory.pr`/`po`/`grn` permissions likewise have no backend CRUD routes to protect (schema tables exist, routes don't). ~~warehouse CRUD gated on `products.edit`~~ — resolved in item 23 (Categories/Units/Warehouses now have their own dedicated `.view`/`.edit` permission nodes, independent of Products).
- **`usr-test-proc`'s malformed `{"expenses": {...}}` permission entry (item 23)**: moot as of item 24 — `users.permissions` no longer exists as a column at all (superseded by role assignment), so this stale/typo'd data was dropped along with the column rather than needing a manual fix.
- **Per-role permission overrides**: explicitly deferred in item 24's design (project-owner decision) — a role-assigned user's access is exactly the union of their roles, no per-user exceptions on top. If a one-off need for "this specific user but not the rest of the role" ever comes up, the intended answer is a new (or cloned) role, not an override mechanism — revisit only if that stops being sufficient in practice.
- **`BR-KSA-23` VAT exemption reason code (BT-121)**: newly surfaced by item 31's per-line-tax-rate fix — a line marked `Exempt` (category `E`) needs a specific ZATCA-defined exemption reason code on the invoice, not just the `E` category flag. Currently absent. Tracked, not blocking (warning only, sandbox).
- **`BR-KSA-EN16931-11`**: line-net-amount reconciliation warning observed on discount-heavy invoices. Tracked, not yet root-caused.
- **B2C buyer address "Conditional" nuance**: ZATCA's own data dictionary marks Simplified-invoice buyer address as *Conditional*, not flatly Optional (item 31, §08 of the QA plan) — the condition that makes it required hasn't been identified yet. Current code treats it as always-optional; no live rejection has surfaced from this, but it's unconfirmed by evidence either way.
- **List UI visual verification gap (item 31)**: the Sales Invoices list/print-preview/QR-scan behavior was not visually re-verified this pass — the Browser pane didn't composite frames during the session (environment limitation, not a reproduced app bug). DB-level `zatcaStatus`/`invoiceTypeCode` correctness was confirmed for every invoice instead. A manual click-through of the list/print/QR path is recommended before treating item 31's QA pass as fully closed.




