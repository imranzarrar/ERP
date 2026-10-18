# Annex H: Module catalogue (every module, older and new)

Generated 2026-10-18 by `node scripts/build-module-catalogue.mjs` from the code: endpoints and permissions from `server/routes`, tables from `src/db/schema.ts`, tests from `tests/`. The one-line description of each module and the manual link are written in that script. This is the index of **what the system contains**; the rules that apply to all of it are in the Platform architecture chapter, and the finance core is specified in the requirements and design chapters.

| Module | Mount | Endpoints | Tables touched | Tests |
|---|---|---|---|---|
| [Master data](#module-masterEntities) | `/api` | 42 | 16 | 19 |
| [Product import](#module-masterImport) | `/api` | 3 | 0 | 1 |
| [Branches](#module-branches) | `/api` | 4 | 9 | 4 |
| [Employees and job titles](#module-employees) | `/api` | 3 | 3 | 2 |
| [Sales documents, fiscal months, recurring postings](#module-transactions) | `/api/transactions` | 25 | 17 | 40 |
| [Expenses](#module-expenses) | `/api/expenses` | 5 | 6 | 20 |
| [Procurement and inventory](#module-inventory) | `/api/inventory` | 24 | 22 | 17 |
| [Point of sale](#module-pos) | `/api/pos` | 8 | 8 | 4 |
| [Reports and dashboard](#module-reports) | `/api` | 23 | 0 | 10 |
| [VAT returns](#module-taxReturns) | `/api` | 4 | 1 | 6 |
| [ZATCA e-invoicing](#module-zatca) | `/api/zatca` | 8 | 3 | 1 |
| [Users](#module-users) | `/api/users` | 5 | 6 | 9 |
| [Roles and permissions](#module-roles) | `/api/roles` | 3 | 2 | 1 |
| [Role templates](#module-roleTemplates) | `/api/role-templates` | 3 | 1 | 0 |
| [Active sessions](#module-sessions) | `/api` | 2 | 3 | 1 |
| [Companies](#module-companies) | `/api/companies` | 2 | 80 | 8 |
| [Company onboarding](#module-onboarding) | `/api` | 0 | 7 | 0 |
| [Document templates and translations](#module-settingsResources) | `/api` | 9 | 3 | 4 |
| [System banner](#module-systemBanner) | `/api` | 0 | 1 | 0 |
| [Approval rules (2.0)](#module-approvals) | `/api/approvals` | 11 | 6 | 1 |
| [General ledger: accounts (2.0)](#module-ledgerAccounts) | `/api/ledger` | 13 | 6 | 7 |
| [General ledger: journals (2.0)](#module-ledgerJournals) | `/api/ledger` | 14 | 14 | 6 |
| [General ledger: reports (2.0)](#module-ledgerReports) | `/api/ledger` | 3 | 5 | 4 |
| [General ledger: report designer (2.0)](#module-ledgerReportDefs) | `/api/ledger` | 10 | 2 | 2 |
| [General ledger: dimensions (2.0)](#module-ledgerDimensions) | `/api/ledger` | 16 | 6 | 3 |
| [General ledger: opening balances (2.0)](#module-ledgerOpening) | `/api/ledger` | 4 | 4 | 1 |
| [General ledger: posting control (2.0)](#module-ledgerPostingPolicy) | `/api/ledger` | 2 | 1 | 3 |
| [Receivables and payables ledgers (2.0)](#module-ledgerSubledger) | `/api/ledger` | 5 | 0 | 2 |
| [Receipts and vendor payments (2.0)](#module-settlements) | `/api` | 7 | 0 | 3 |
| [Bank reconciliation (2.0)](#module-bankReconciliation) | `/api/bank-reconciliations` | 16 | 1 | 1 |

## Master data

<a id="module-masterEntities"></a>Customers, vendors, products, product categories, modifier groups, units of measure and their conversions, banks, tax slabs, job titles, and company profile, theme and numbering settings. Every document picks from these; none is ever hard-deleted, only made inactive.

* **Route file:** `server/routes/masterEntities.ts`, mounted at `/api`
* **Screens:** `MasterEntities.tsx`, `ModifierGroupsModule.tsx`, `QuickAddPartyButton.tsx`, `QuickAddProductModal.tsx`
* **User manual:** [partners](../user-manual/warraq-erp-user-manual.html#partners), [catalog](../user-manual/warraq-erp-user-manual.html#catalog), [config-org](../user-manual/warraq-erp-user-manual.html#config-org)
* **Tables touched directly:** `bank_accounts`, `branches`, `companies`, `customers`, `job_titles`, `modifier_choices`, `modifier_groups`, `product_categories`, `product_modifier_groups`, `product_unit_conversions`, `product_warehouses`, `products_services`, `tax_slabs`, `units_of_measure`, `vendors`, `warehouses`
* **Tests that call it:** `accountSecurityAndCompanySetup`, `adminSettingsRoutes`, `companyDeletion`, `companyLogoDelivery`, `crossCompanyIsolation`, `documentNumbering`, `employees`, `inventoryModuleRoutes`, `ledgerPostingProfile`, `ledgerSubledger`, `modifierGroups`, `newCompanyStarterResources`, `nonTransactionalSync`, `permissionCrudModel`, `salesWarehouseRouting`, `tenantDbPhase2Rls`, `tenantDbRls`, `uomConversion`, `zatcaUnitCodes`

| Method | Path | Permission |
|---|---|---|
| GET | `/api/customers` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/customers` | not detected: signed-in user, or checked inside the handler (see route file) |
| PATCH | `/api/customers/:id/toggle-active` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/vendors` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/vendors` | not detected: signed-in user, or checked inside the handler (see route file) |
| PATCH | `/api/vendors/:id/toggle-active` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/products` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/products` | not detected: signed-in user, or checked inside the handler (see route file) |
| PATCH | `/api/products/:id/toggle-active` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/companies` | not detected: signed-in user, or checked inside the handler (see route file) |
| PATCH | `/api/companies/:id/theme` | not detected: signed-in user, or checked inside the handler (see route file) |
| PATCH | `/api/companies/:id/settings` | `companyProfile.update` |
| GET | `/api/companies/:id/numbering-preview` | `documentNumbering.read` |
| GET | `/api/banks` | `banks.read` |
| POST | `/api/banks` | `banks.create` |
| PATCH | `/api/banks/:id` | `banks.update` |
| PATCH | `/api/banks/:id/set-default` | `banks.update` |
| PATCH | `/api/banks/:id/toggle-active` | `banks.delete` |
| GET | `/api/tax-slabs` | `taxSlabs.read` |
| POST | `/api/tax-slabs` | not detected: signed-in user, or checked inside the handler (see route file) |
| PATCH | `/api/tax-slabs/:id/set-default` | `taxSlabs.update` |
| GET | `/api/product-categories` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/product-categories` | not detected: signed-in user, or checked inside the handler (see route file) |
| PATCH | `/api/product-categories/:id/toggle-active` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/modifier-groups` | `modifierGroups.read` |
| POST | `/api/modifier-groups` | not detected: signed-in user, or checked inside the handler (see route file) |
| PATCH | `/api/modifier-groups/:id/toggle-active` | `modifierGroups.delete` |
| GET | `/api/units-of-measure` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/units-of-measure` | not detected: signed-in user, or checked inside the handler (see route file) |
| PATCH | `/api/units-of-measure/:id/toggle-active` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/job-titles` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/job-titles` | not detected: signed-in user, or checked inside the handler (see route file) |
| PATCH | `/api/job-titles/:id/toggle-active` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/product-unit-conversions` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/product-unit-conversions` | not detected: signed-in user, or checked inside the handler (see route file) |
| PATCH | `/api/product-unit-conversions/:id/toggle-active` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/warehouses` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/warehouses` | not detected: signed-in user, or checked inside the handler (see route file) |
| PATCH | `/api/warehouses/:id/toggle-active` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/product-warehouses` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/product-warehouses` | not detected: signed-in user, or checked inside the handler (see route file) |
| DELETE | `/api/product-warehouses/:id` | not detected: signed-in user, or checked inside the handler (see route file) |

## Product import

<a id="module-masterImport"></a>Bulk product load from a spreadsheet: download a template, validate the file, then commit.

* **Route file:** `server/routes/masterImport.ts`, mounted at `/api`
* **Screens:** `ProductImportModal.tsx`, `PartyImportModal.tsx`
* **User manual:** [catalog](../user-manual/warraq-erp-user-manual.html#catalog)
* **Tables touched directly:** none
* **Tests that call it:** `productImport`

| Method | Path | Permission |
|---|---|---|
| GET | `/api/master-import/products/template` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/master-import/products/validate` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/master-import/products/commit` | not detected: signed-in user, or checked inside the handler (see route file) |

## Branches

<a id="module-branches"></a>Physical locations inside a company. Documents optionally belong to a branch; users can be restricted to branches.

* **Route file:** `server/routes/branches.ts`, mounted at `/api`
* **Screens:** `AdminSettings.tsx`
* **User manual:** [config-org](../user-manual/warraq-erp-user-manual.html#config-org)
* **Tables touched directly:** `branches`, `expenses`, `invoices`, `purchase_bills`, `purchase_orders`, `purchase_requisitions`, `quotations`, `vouchers`, `warehouses`
* **Tests that call it:** `branchAutoWarehouse`, `salesWarehouseRouting`, `sessionLifecycle`, `tenantDbPhase2Rls`

| Method | Path | Permission |
|---|---|---|
| GET | `/api/branches` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/branches` | not detected: signed-in user, or checked inside the handler (see route file) |
| PATCH | `/api/branches/:id/toggle-active` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/branches/backfill-unassigned` | not detected: signed-in user, or checked inside the handler (see route file) |

## Employees and job titles

<a id="module-employees"></a>Employee records and their job titles (a person is separate from a login user).

* **Route file:** `server/routes/employees.ts`, mounted at `/api`
* **Screens:** `EmployeesModule.tsx`
* **User manual:** [hr](../user-manual/warraq-erp-user-manual.html#hr)
* **Tables touched directly:** `branches`, `employees`, `job_titles`
* **Tests that call it:** `employees`, `tenantDbPhase2Rls`

| Method | Path | Permission |
|---|---|---|
| GET | `/api/employees` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/employees` | not detected: signed-in user, or checked inside the handler (see route file) |
| PATCH | `/api/employees/:id/toggle-active` | not detected: signed-in user, or checked inside the handler (see route file) |

## Sales documents, fiscal months, recurring postings

<a id="module-transactions"></a>Quotations (convertible to invoices), tax invoices, credit notes, later payments and cancellation; fiscal month open/close; recurring expense templates, postings and accruals; interbank transfers; investor contributions. Invoices, credit notes and debit notes are submitted to ZATCA after commit. A cleared invoice can only be reversed by a credit note.

* **Route file:** `server/routes/transactions.ts`, mounted at `/api/transactions`
* **Screens:** `QuotationModule.tsx`, `InvoiceModule.tsx`, `InvoiceViewScreen.tsx`, `RecurringExpenses.tsx`, `AdminSettings.tsx`
* **User manual:** [sales](../user-manual/warraq-erp-user-manual.html#sales), [expenses](../user-manual/warraq-erp-user-manual.html#expenses), [config-fiscal](../user-manual/warraq-erp-user-manual.html#config-fiscal)
* **Tables touched directly:** `bank_accounts`, `companies`, `customers`, `employees`, `expenses`, `fiscal_months`, `investors`, `invoice_items`, `invoices`, `products_services`, `quotation_items`, `quotations`, `recurring_expense_templates`, `recurring_postings`, `tax_slabs`, `vendors`, `vouchers`
* **Tests that call it:** `accrualSettlementVariance`, `adminSettingsRoutes`, `approvals`, `auditLogCoverage`, `averageSalePrice`, `balanceSheetAsAtPastDate`, `bankReconciliation`, `cancelAndBillDateRules`, `createRouteFieldAllowList`, `crossCompanyIsolation`, `documentNumbering`, `employees`, `invoicePaidRoute`, `invoiceXmlOnDemand`, `itemKindStockGating`, `ledgerPostingProfile`, `ledgerSubledger`, `modifierGroups`, `monthPnlPreview`, `multiMonthOpen`, `newCompanyStarterResources`, `noBulkSave`, `periodFuzz`, `periodStory`, `permissionCrudModel`, `posCancelPermission`, `posSaleZatcaPipeline`, `postingControl`, `recurringTemplates`, `reportsReconcileLedgerScenario`, `salesAverageUnwind`, `salesWarehouseRouting`, `settlements`, `taxReturns`, `tenantDbPhase3Rls`, `uomConversion`, `usersAdminActions`, `vendorCreditReceivable`, `zatcaUnitCodes`, `zatcaWorkflow`

| Method | Path | Permission |
|---|---|---|
| GET | `/api/transactions/quotations` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/transactions/quotations` | not detected: signed-in user, or checked inside the handler (see route file) |
| PUT | `/api/transactions/quotations/:id` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/transactions/quotations/:id/cancel` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/transactions/quotations/:id/convert` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/transactions/invoices` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/transactions/invoices/:id/xml` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/transactions/invoices/:id/pdf` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/transactions/invoices` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/transactions/invoices/:id/note` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/transactions/invoices/:id/paid` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/transactions/invoices/:id/cancel` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/transactions/investors` | `investors.access` |
| POST | `/api/transactions/investors/:id/investment` | `investors.access` |
| GET | `/api/transactions/months` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/transactions/months` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/transactions/recurring-postings` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/transactions/settle-accrual` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/transactions/recurring-templates` | not detected: signed-in user, or checked inside the handler (see route file) |
| PUT | `/api/transactions/recurring-templates/:id` | not detected: signed-in user, or checked inside the handler (see route file) |
| PATCH | `/api/transactions/recurring-templates/:id/toggle` | not detected: signed-in user, or checked inside the handler (see route file) |
| DELETE | `/api/transactions/recurring-templates/:id` | not detected: signed-in user, or checked inside the handler (see route file) |
| PUT | `/api/transactions/accruals/:id` | not detected: signed-in user, or checked inside the handler (see route file) |
| DELETE | `/api/transactions/accruals/:id` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/transactions/interbank-transfer` | `banks.transfer` |

## Expenses

<a id="module-expenses"></a>Vendor expenses with VAT, payment at entry or later, reversal and cancellation. Posts to the ledger and creates the payment voucher through one shared path.

* **Route file:** `server/routes/expenses.ts`, mounted at `/api/expenses`
* **Screens:** `ExpenseModule.tsx`
* **User manual:** [expenses](../user-manual/warraq-erp-user-manual.html#expenses)
* **Tables touched directly:** `bank_accounts`, `expenses`, `journal_entries`, `journal_lines`, `tax_slabs`, `vouchers`
* **Tests that call it:** `approvals`, `balanceSheetAsAtPastDate`, `bankReconciliation`, `cancelAndBillDateRules`, `createRouteFieldAllowList`, `crossCompanyIsolation`, `expenseCreateRoute`, `expensePayCancel`, `ledgerJournals`, `ledgerPostingProfile`, `ledgerSubledger`, `monthPnlPreview`, `noBulkSave`, `periodFuzz`, `periodStory`, `postingControl`, `reportsReconcileLedgerScenario`, `settlements`, `taxReturns`, `tenantDbPhase3Rls`

| Method | Path | Permission |
|---|---|---|
| GET | `/api/expenses` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/expenses` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/expenses/:id/pay` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/expenses/:id/reverse` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/expenses/:id/cancel` | not detected: signed-in user, or checked inside the handler (see route file) |

## Procurement and inventory

<a id="module-inventory"></a>Purchase requisitions, purchase orders, goods receipt notes, purchase bills (with payment), purchase returns, vendor refunds, warehouse dispatches and receivings, stock adjustments and stock takes. Stock is kept in a ledger of movements.

* **Route file:** `server/routes/inventory.ts`, mounted at `/api/inventory`
* **Screens:** `InventoryModule.tsx`
* **User manual:** [purchasing](../user-manual/warraq-erp-user-manual.html#purchasing), [warehouses](../user-manual/warraq-erp-user-manual.html#warehouses)
* **Tables touched directly:** `bank_accounts`, `companies`, `goods_receipt_note_items`, `goods_receipt_notes`, `inventory_stocks`, `physical_stock_take_items`, `physical_stock_takes`, `products_services`, `purchase_bills`, `purchase_order_items`, `purchase_orders`, `purchase_requisition_items`, `purchase_requisitions`, `purchase_return_items`, `purchase_returns`, `vendors`, `vouchers`, `warehouse_dispatch_items`, `warehouse_dispatches`, `warehouse_receiving_items`, `warehouse_receivings`, `warehouses`
* **Tests that call it:** `approvals`, `cancelAndBillDateRules`, `documentNumbering`, `inventoryModuleRoutes`, `itemKindStockGating`, `periodFuzz`, `periodStory`, `permissionCrudModel`, `purchaseBillsRoutes`, `purchaseReturnVatPeriod`, `purchaseReturnsAndStockTakes`, `reportsReconcileLedgerScenario`, `taxReturns`, `tenantDbPhase5Rls`, `uomConversion`, `vendorCreditReceivable`, `warehouseTransfer`

| Method | Path | Permission |
|---|---|---|
| POST | `/api/inventory/purchase-requisitions` | `inventory.pr` |
| PUT | `/api/inventory/purchase-requisitions/:id` | `inventory.pr` |
| PATCH | `/api/inventory/purchase-requisitions/:id/withdraw` | `inventory.pr` |
| POST | `/api/inventory/purchase-orders` | `inventory.po` |
| POST | `/api/inventory/goods-receipt-notes` | `inventory.grn` |
| POST | `/api/inventory/goods-receipt-notes/:id/reverse` | `inventory.grn` |
| PATCH | `/api/inventory/purchase-requisitions/:id/status` | `inventory.approve` |
| PATCH | `/api/inventory/purchase-orders/:id/cancel` | `inventory.po` |
| POST | `/api/inventory/warehouse-dispatches` | `warehouseDispatches.create` |
| POST | `/api/inventory/warehouse-receivings` | `warehouseReceivings.create` |
| POST | `/api/inventory/warehouse-dispatches/:id/cancel` | `warehouseDispatches.delete` |
| POST | `/api/inventory/stock-adjustments` | `inventory.stock` |
| POST | `/api/inventory/purchase-bills` | `purchaseBills.create` |
| PUT | `/api/inventory/purchase-bills/:id` | `purchaseBills.update` |
| POST | `/api/inventory/vendor-refunds` | `purchaseBills.update` |
| GET | `/api/inventory/vendor-refunds` | `purchaseBills.read, purchaseBills.update` |
| POST | `/api/inventory/vendor-refunds/:id/cancel` | `purchaseBills.update` |
| POST | `/api/inventory/purchase-bills/:id/pay` | `purchaseBills.update` |
| PATCH | `/api/inventory/purchase-bills/:id/cancel` | `purchaseBills.delete` |
| POST | `/api/inventory/purchase-returns` | `purchaseReturns.create` |
| PATCH | `/api/inventory/purchase-returns/:id/cancel` | `purchaseReturns.delete` |
| POST | `/api/inventory/stock-takes` | `stockTakes.create` |
| POST | `/api/inventory/stock-takes/:id/finalize` | `stockTakes.update` |
| PATCH | `/api/inventory/stock-takes/:id/cancel` | `stockTakes.delete` |

## Point of sale

<a id="module-pos"></a>Cashier shifts, held (parked) sales and returns against earlier sales; sales themselves are invoices.

* **Route file:** `server/routes/pos.ts`, mounted at `/api/pos`
* **Screens:** `PosModule.tsx`
* **User manual:** [pos](../user-manual/warraq-erp-user-manual.html#pos)
* **Tables touched directly:** `companies`, `customers`, `invoice_items`, `invoices`, `pos_held_invoices`, `pos_shifts`, `tax_slabs`, `users`
* **Tests that call it:** `periodFuzz`, `periodStory`, `posShiftsAndHeldInvoices`, `tenantDbPhase4Rls`

| Method | Path | Permission |
|---|---|---|
| GET | `/api/pos/shifts` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/pos/shifts` | not detected: signed-in user, or checked inside the handler (see route file) |
| PUT | `/api/pos/shifts/:id` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/pos/held-invoices` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/pos/held-invoices` | not detected: signed-in user, or checked inside the handler (see route file) |
| DELETE | `/api/pos/held-invoices/:id` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/pos/returnable-invoices` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/pos/returns` | not detected: signed-in user, or checked inside the handler (see route file) |

## Reports and dashboard

<a id="module-reports"></a>Every report, dashboard figure and list total is computed on the server for the active company, with no row cap: sales, purchase, stock, statements, profit and loss, trial balance, balance sheet, the consistency check. Document-based reports share one set of facts with the ledger reports.

* **Route file:** `server/routes/reports.ts`, mounted at `/api`
* **Screens:** `Dashboard.tsx`, `ReportViewer.tsx`, `SalesReportsModule.tsx`, `PurchaseReportsModule.tsx`, `InventoryReportsModule.tsx`, `ReportViewControls.tsx`
* **User manual:** [fin-reports](../user-manual/warraq-erp-user-manual.html#fin-reports), [ops-reports](../user-manual/warraq-erp-user-manual.html#ops-reports)
* **Tables touched directly:** none
* **Tests that call it:** `balanceSheetAsAtPastDate`, `bankReconciliation`, `ledgerJournals`, `ledgerSubledger`, `monthPnlPreview`, `periodFuzz`, `purchaseReturnVatPeriod`, `reportsReconcileLedgerScenario`, `salesAverageUnwind`, `settlements`

| Method | Path | Permission |
|---|---|---|
| GET | `/api/reports/consistency-check` | `reports.balanceSheet` |
| GET | `/api/reports/month-pnl` | `reports.balanceSheet` |
| GET | `/api/reports/dashboard-summary` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/reports/trial-balance` | `reports.trialBalance` |
| GET | `/api/reports/profit-loss` | `reports.profitLoss` |
| GET | `/api/reports/balance-sheet` | `reports.balanceSheet` |
| GET | `/api/reports/sales-register` | `reports.salesRegister` |
| GET | `/api/reports/item-wise-sales` | `reports.itemWiseSales` |
| GET | `/api/reports/customer-statement` | `reports.customerStatement` |
| GET | `/api/reports/quotation-conversion` | `reports.quotationConversion` |
| GET | `/api/reports/sales-by-staff` | `reports.salesByStaff` |
| GET | `/api/reports/pos-shift-summary` | `reports.posShiftSummary` |
| GET | `/api/reports/purchase-register` | `reports.purchaseRegister` |
| GET | `/api/reports/vendor-statement` | `reports.vendorStatement` |
| GET | `/api/reports/stock-valuation` | `reports.stockValuation` |
| GET | `/api/reports/item-profitability` | `reports.itemProfitability, reports.lowStock` |
| GET | `/api/reports/low-stock` | `reports.lowStock` |
| GET | `/api/reports/stock-take-variance-history` | `reports.stockTakeVarianceHistory` |
| GET | `/api/reports/stock-movement-ledger` | `reports.stockMovementLedger` |
| GET | `/api/reports/warehouse-transfer-reconciliation` | `reports.warehouseTransferReconciliation` |
| GET | `/api/reports/invoice-kpis` | `invoice.read` |
| GET | `/api/reports/quotation-kpis` | `quotation.read` |
| GET | `/api/reports/investor-contributions` | `investors.access` |

## VAT returns

<a id="module-taxReturns"></a>Quarterly VAT return generation and filing; a filed quarter locks the documents in it.

* **Route file:** `server/routes/taxReturns.ts`, mounted at `/api`
* **Screens:** `VatReturnsPanel.tsx`
* **User manual:** [config-fiscal](../user-manual/warraq-erp-user-manual.html#config-fiscal)
* **Tables touched directly:** `tax_returns`
* **Tests that call it:** `periodFuzz`, `periodStory`, `purchaseReturnVatPeriod`, `taxReturns`, `tenantDbPhase6Rls`, `vendorCreditReceivable`

| Method | Path | Permission |
|---|---|---|
| GET | `/api/tax-returns` | `taxReturns.read` |
| POST | `/api/tax-returns/generate` | `taxReturns.create` |
| POST | `/api/tax-returns/:id/delete` | `taxReturns.delete` |
| POST | `/api/tax-returns/:id/file` | `taxReturns.file` |

## ZATCA e-invoicing

<a id="module-zatca"></a>Per-company, per-environment (sandbox, simulation, production) onboarding: key pair and CSR, compliance and production CSIDs, and invoice submission. The signing and hash-chain pipeline lives in server/lib/zatca and is the most sensitive code in the system.

* **Route file:** `server/routes/zatca.ts`, mounted at `/api/zatca`
* **Screens:** `ZatcaOnboardingWizard.tsx`
* **User manual:** [config-zatca](../user-manual/warraq-erp-user-manual.html#config-zatca)
* **Tables touched directly:** `companies`, `invoices`, `zatca_environment_configs`
* **Tests that call it:** `zatcaWorkflow`

| Method | Path | Permission |
|---|---|---|
| POST | `/api/zatca/submit-invoice/:invoiceId` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/zatca/company-status/:companyId` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/zatca/company-config` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/zatca/set-active-environment` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/zatca/generate-keypair-csr` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/zatca/request-compliance-csid` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/zatca/run-compliance-suite` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/zatca/request-production-csid` | not detected: signed-in user, or checked inside the handler (see route file) |

## Users

<a id="module-users"></a>Login accounts and their roles, branch access and manager (used by approval rules). A delegated user can only create ordinary staff, never an administrator.

* **Route file:** `server/routes/users.ts`, mounted at `/api/users`
* **Screens:** `AdminSettings.tsx`, `ChangePasswordScreen.tsx`
* **User manual:** [config-roles](../user-manual/warraq-erp-user-manual.html#config-roles)
* **Tables touched directly:** `branches`, `employees`, `roles`, `user_branches`, `user_roles`, `users`
* **Tests that call it:** `accountSecurityAndCompanySetup`, `approvals`, `employees`, `nonTransactionalSync`, `passwordReset`, `permissionCrudModel`, `staffDirectoryScoping`, `tenantDbPhase6Rls`, `usersAdminActions`

| Method | Path | Permission |
|---|---|---|
| GET | `/api/users` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/users` | not detected: signed-in user, or checked inside the handler (see route file) |
| PATCH | `/api/users/me/language` | not detected: signed-in user, or checked inside the handler (see route file) |
| PATCH | `/api/users/:id/active` | `users.delete` |
| DELETE | `/api/users/:id` | `users.delete` |

## Roles and permissions

<a id="module-roles"></a>Roles hold create / read / update / delete (and a few action) permissions per module; a user holds the union of their roles.

* **Route file:** `server/routes/roles.ts`, mounted at `/api/roles`
* **Screens:** `AdminSettings.tsx`
* **User manual:** [config-roles](../user-manual/warraq-erp-user-manual.html#config-roles)
* **Tables touched directly:** `roles`, `user_roles`
* **Tests that call it:** `tenantDbPhase6Rls`

| Method | Path | Permission |
|---|---|---|
| GET | `/api/roles` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/roles` | not detected: signed-in user, or checked inside the handler (see route file) |
| DELETE | `/api/roles/:id` | not detected: signed-in user, or checked inside the handler (see route file) |

## Role templates

<a id="module-roleTemplates"></a>Platform-wide starting roles a company can copy.

* **Route file:** `server/routes/roleTemplates.ts`, mounted at `/api/role-templates`
* **Screens:** `AdminSettings.tsx`
* **User manual:** [config-roles](../user-manual/warraq-erp-user-manual.html#config-roles)
* **Tables touched directly:** `role_templates`
* **Tests that call it:** none by path (covered through related tests or by lib code)

| Method | Path | Permission |
|---|---|---|
| GET | `/api/role-templates` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/role-templates` | not detected: signed-in user, or checked inside the handler (see route file) |
| DELETE | `/api/role-templates/:id` | not detected: signed-in user, or checked inside the handler (see route file) |

## Active sessions

<a id="module-sessions"></a>List and end signed-in sessions (super-admin).

* **Route file:** `server/routes/sessions.ts`, mounted at `/api`
* **Screens:** `AdminSettings.tsx`
* **User manual:** [config-roles](../user-manual/warraq-erp-user-manual.html#config-roles)
* **Tables touched directly:** `companies`, `user_sessions`, `users`
* **Tests that call it:** `sessionLifecycle`

| Method | Path | Permission |
|---|---|---|
| GET | `/api/admin/sessions` | not detected: signed-in user, or checked inside the handler (see route file) |
| DELETE | `/api/admin/sessions/:sid` | not detected: signed-in user, or checked inside the handler (see route file) |

## Companies

<a id="module-companies"></a>Company registration status and removal (platform administration).

* **Route file:** `server/routes/companies.ts`, mounted at `/api/companies`
* **Screens:** `AdminSettings.tsx`
* **User manual:** [config-org](../user-manual/warraq-erp-user-manual.html#config-org)
* **Tables touched directly:** `account_dimension_rules`, `audit_logs`, `bank_accounts`, `branches`, `companies`, `company_accounts`, `company_onboarding_requests`, `cost_centers`, `customers`, `deleted_company_log`, `dimension_combination_entries`, `dimension_combinations`, `dimension_types`, `dimension_values`, `document_counters`, `document_templates`, `employees`, `expense_category_accounts`, `expense_items`, `expenses`, `fiscal_months`, `gl_group_mappings`, `goods_receipt_note_items`, `goods_receipt_notes`, `inventory_stocks`, `investors`, `invoice_items`, `invoices`, `job_titles`, `journal_entries`, `journal_lines`, `manual_journal_events`, `manual_journal_lines`, `manual_journals`, `modifier_choices`, `modifier_groups`, `opening_balance_runs`, `password_reset_tokens`, `physical_stock_take_items`, `physical_stock_takes`, `pos_held_invoices`, `pos_shifts`, `posting_policies`, `product_categories`, `product_modifier_groups`, `product_unit_conversions`, `product_warehouses`, `products_services`, `purchase_bills`, `purchase_order_items`, `purchase_orders`, `purchase_requisition_items`, `purchase_requisitions`, `purchase_return_items`, `purchase_returns`, `quotation_items`, `quotations`, `recurring_expense_templates`, `recurring_postings`, `report_columns`, `report_definitions`, `report_row_selectors`, `report_rows`, `roles`, `stock_ledger_transactions`, `tax_returns`, `tax_slabs`, `units_of_measure`, `user_branches`, `user_roles`, `users`, `vendors`, `vouchers`, `warehouse_dispatch_items`, `warehouse_dispatches`, `warehouse_receiving_items`, `warehouse_receivings`, `warehouses`, `zatca_chain_state`, `zatca_environment_configs`
* **Tests that call it:** `accountSecurityAndCompanySetup`, `adminSettingsRoutes`, `companyDeletion`, `companyLogoDelivery`, `documentNumbering`, `newCompanyStarterResources`, `nonTransactionalSync`, `permissionCrudModel`

| Method | Path | Permission |
|---|---|---|
| PATCH | `/api/companies/:id/registration-status` | not detected: signed-in user, or checked inside the handler (see route file) |
| DELETE | `/api/companies/:id` | not detected: signed-in user, or checked inside the handler (see route file) |

## Company onboarding

<a id="module-onboarding"></a>Self-service company sign-up with email confirmation and administrator approval.

* **Route file:** `server/routes/onboarding.ts`, mounted at `/api`
* **Screens:** `CompanyOnboardingScreen.tsx`, `ConfirmOnboardingEmailScreen.tsx`
* **User manual:** [config-org](../user-manual/warraq-erp-user-manual.html#config-org)
* **Tables touched directly:** `companies`, `company_onboarding_requests`, `password_reset_tokens`, `role_templates`, `roles`, `user_roles`, `users`
* **Tests that call it:** none by path (covered through related tests or by lib code)

Endpoints are declared in a non-standard way; see the route file.

## Document templates and translations

<a id="module-settingsResources"></a>Print layouts for every document and the English / Arabic / Urdu translation table.

* **Route file:** `server/routes/settingsResources.ts`, mounted at `/api`
* **Screens:** `AdminSettings.tsx`, `DocumentRenderer.tsx`
* **User manual:** [config-ops](../user-manual/warraq-erp-user-manual.html#config-ops)
* **Tables touched directly:** `companies`, `document_templates`, `translations`
* **Tests that call it:** `newCompanyStarterResources`, `permissionCrudModel`, `settingsResources`, `tenantDbPhase6Rls`

| Method | Path | Permission |
|---|---|---|
| GET | `/api/templates` | `templates.read` |
| POST | `/api/templates` | not detected: signed-in user, or checked inside the handler (see route file) |
| PATCH | `/api/templates/:id` | `templates.update` |
| POST | `/api/templates/:id/copy` | not detected: signed-in user, or checked inside the handler (see route file) |
| DELETE | `/api/templates/:id` | `templates.delete` |
| GET | `/api/translations` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/translations` | not detected: signed-in user, or checked inside the handler (see route file) |
| PATCH | `/api/translations/:id` | not detected: signed-in user, or checked inside the handler (see route file) |
| DELETE | `/api/translations/:id` | not detected: signed-in user, or checked inside the handler (see route file) |

## System banner

<a id="module-systemBanner"></a>A platform notice shown to all users.

* **Route file:** `server/routes/systemBanner.ts`, mounted at `/api`
* **Screens:** `SystemBanner.tsx`
* **User manual:** not covered
* **Tables touched directly:** `system_banner`
* **Tests that call it:** none by path (covered through related tests or by lib code)

Endpoints are declared in a non-standard way; see the route file.

## Approval rules (2.0)

<a id="module-approvals"></a>Amount-threshold, multi-level approval for vendor payments, vendor bills, credit notes and manual journals, with delegation. Detailed in the finance-core chapters.

* **Route file:** `server/routes/approvals.ts`, mounted at `/api/approvals` (finance core: also in the API reference and permissions annexes)
* **Screens:** `ledger/ApprovalScreens.tsx`
* **User manual:** [fc-intro](../user-manual/warraq-erp-user-manual.html#fc-intro)
* **Tables touched directly:** `approval_delegations`, `approval_requests`, `approval_rule_levels`, `approval_rules`, `roles`, `users`
* **Tests that call it:** `approvals`

| Method | Path | Permission |
|---|---|---|
| GET | `/api/approvals/rules` | `approvalRules.read, approvalRules.create` |
| POST | `/api/approvals/rules` | `approvalRules.create, approvalRules.update` |
| PUT | `/api/approvals/rules/:id` | `approvalRules.update` |
| PATCH | `/api/approvals/rules/:id/toggle-active` | `approvalRules.delete` |
| GET | `/api/approvals/my` | `approvals.read` |
| GET | `/api/approvals/requests/:id` | `approvals.read` |
| POST | `/api/approvals/requests/:id/decide` | `approvals.read` |
| POST | `/api/approvals/requests/:id/recall` | `approvals.read` |
| GET | `/api/approvals/delegations` | `approvals.read` |
| POST | `/api/approvals/delegations` | `approvals.read` |
| PATCH | `/api/approvals/delegations/:id/end` | `approvals.read` |

## General ledger: accounts (2.0)

<a id="module-ledgerAccounts"></a>Company chart of accounts and account mapping.

* **Route file:** `server/routes/ledgerAccounts.ts`, mounted at `/api/ledger` (finance core: also in the API reference and permissions annexes)
* **Screens:** `ledger/`
* **User manual:** [fc-2](../user-manual/warraq-erp-user-manual.html#fc-2)
* **Tables touched directly:** `bank_accounts`, `company_accounts`, `customers`, `expense_category_accounts`, `system_accounts`, `vendors`
* **Tests that call it:** `ledgerAccounts`, `ledgerDimensions`, `ledgerJournals`, `ledgerPostingProfile`, `ledgerReportEngine`, `ledgerSubledger`, `postingControl`

| Method | Path | Permission |
|---|---|---|
| GET | `/api/ledger/accounts` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/ledger/accounts` | `chartOfAccounts.create` |
| PUT | `/api/ledger/accounts/:id` | `chartOfAccounts.update` |
| GET | `/api/ledger/control-accounts` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/ledger/party-profile` | not detected: signed-in user, or checked inside the handler (see route file) |
| PATCH | `/api/ledger/accounts/:id/toggle-active` | `chartOfAccounts.delete` |
| GET | `/api/ledger/accounts/export` | `chartOfAccounts.export` |
| GET | `/api/ledger/accounts/import/template` | `chartOfAccounts.import` |
| POST | `/api/ledger/accounts/import/validate` | `chartOfAccounts.import` |
| POST | `/api/ledger/accounts/import/commit` | `chartOfAccounts.import` |
| GET | `/api/ledger/mapping` | `accountMapping.read` |
| PUT | `/api/ledger/mapping/role` | `accountMapping.update` |
| PUT | `/api/ledger/mapping/category` | `accountMapping.update` |

## General ledger: journals (2.0)

<a id="module-ledgerJournals"></a>Manual journals with approval and reversal; the posting engine.

* **Route file:** `server/routes/ledgerJournals.ts`, mounted at `/api/ledger` (finance core: also in the API reference and permissions annexes)
* **Screens:** `ledger/`
* **User manual:** [fc-6](../user-manual/warraq-erp-user-manual.html#fc-6)
* **Tables touched directly:** `approval_requests`, `branches`, `companies`, `company_accounts`, `expenses`, `invoices`, `journal_entries`, `journal_lines`, `manual_journal_events`, `manual_journal_lines`, `manual_journals`, `purchase_bills`, `users`, `vouchers`
* **Tests that call it:** `approvals`, `ledgerDimensions`, `ledgerJournals`, `ledgerPostingProfile`, `postingControl`, `settlements`

| Method | Path | Permission |
|---|---|---|
| GET | `/api/ledger/journal-settings` | not detected: signed-in user, or checked inside the handler (see route file) |
| PUT | `/api/ledger/journal-settings` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/ledger/journals` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/ledger/journals/entries/:id` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/ledger/manual-journals/:id` | `journals.create` |
| POST | `/api/ledger/manual-journals` | `journals.create` |
| PUT | `/api/ledger/manual-journals/:id` | `journals.update` |
| POST | `/api/ledger/manual-journals/:id/submit` | `journals.create, journals.update` |
| POST | `/api/ledger/manual-journals/:id/approve` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/ledger/manual-journals/:id/reject` | `journals.post` |
| DELETE | `/api/ledger/manual-journals/:id` | `journals.delete` |
| POST | `/api/ledger/manual-journals/:id/reverse` | `journals.reverse` |
| GET | `/api/ledger/manual-journals/:id/print-data` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/ledger/journals/entries/:id/print-data` | not detected: signed-in user, or checked inside the handler (see route file) |

## General ledger: reports (2.0)

<a id="module-ledgerReports"></a>Trial balance, income statement, balance sheet, cash flow, ledger-versus-documents.

* **Route file:** `server/routes/ledgerReports.ts`, mounted at `/api/ledger` (finance core: also in the API reference and permissions annexes)
* **Screens:** `ledger/`
* **User manual:** [fc-7](../user-manual/warraq-erp-user-manual.html#fc-7)
* **Tables touched directly:** `company_accounts`, `expenses`, `invoices`, `manual_journals`, `purchase_bills`
* **Tests that call it:** `bankReconciliation`, `ledgerDimensions`, `ledgerJournals`, `ledgerReportEngine`

| Method | Path | Permission |
|---|---|---|
| GET | `/api/ledger/reports/general-ledger` | `reports.generalLedger` |
| GET | `/api/ledger/reports/general-ledger/export` | `reports.generalLedger` |
| GET | `/api/ledger/reports/ledger-vs-documents` | `reports.ledgerReconciliation` |

## General ledger: report designer (2.0)

<a id="module-ledgerReportDefs"></a>Configurable statement definitions.

* **Route file:** `server/routes/ledgerReportDefs.ts`, mounted at `/api/ledger` (finance core: also in the API reference and permissions annexes)
* **Screens:** `ledger/`
* **User manual:** [fc-7](../user-manual/warraq-erp-user-manual.html#fc-7)
* **Tables touched directly:** `companies`, `report_definitions`
* **Tests that call it:** `ledgerJournals`, `ledgerReportEngine`

| Method | Path | Permission |
|---|---|---|
| GET | `/api/ledger/report-definitions` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/ledger/report-definitions/:id` | `reportDefinitions.create` |
| POST | `/api/ledger/report-definitions` | `reportDefinitions.create` |
| PUT | `/api/ledger/report-definitions/:id` | `reportDefinitions.update` |
| POST | `/api/ledger/report-definitions/:id/reset` | `reportDefinitions.update` |
| PATCH | `/api/ledger/report-definitions/:id/set-default` | `reportDefinitions.update` |
| PATCH | `/api/ledger/report-definitions/:id/toggle-active` | `reportDefinitions.delete` |
| POST | `/api/ledger/report-definitions/preview` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/ledger/report-definitions/:id/run` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/ledger/report-definitions/:id/export` | not detected: signed-in user, or checked inside the handler (see route file) |

## General ledger: dimensions (2.0)

<a id="module-ledgerDimensions"></a>Analytical dimensions (branch, department, custom) on ledger lines.

* **Route file:** `server/routes/ledgerDimensions.ts`, mounted at `/api/ledger` (finance core: also in the API reference and permissions annexes)
* **Screens:** `ledger/`
* **User manual:** [fc-2](../user-manual/warraq-erp-user-manual.html#fc-2)
* **Tables touched directly:** `account_dimension_rules`, `branches`, `company_accounts`, `cost_centers`, `dimension_types`, `dimension_values`
* **Tests that call it:** `ledgerDimensions`, `ledgerPostingProfile`, `ledgerReportEngine`

| Method | Path | Permission |
|---|---|---|
| GET | `/api/ledger/dimensions` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/ledger/dimensions` | `dimensions.create` |
| PUT | `/api/ledger/dimensions/:id` | `dimensions.update` |
| PATCH | `/api/ledger/dimensions/:id/toggle-active` | `dimensions.delete` |
| GET | `/api/ledger/dimensions/:id/values` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/ledger/dimensions/:id/values` | `dimensions.create` |
| PUT | `/api/ledger/dimension-values/:id` | `dimensions.update` |
| PATCH | `/api/ledger/dimension-values/:id/toggle-active` | `dimensions.delete` |
| GET | `/api/ledger/cost-centers` | `dimensions.create` |
| POST | `/api/ledger/cost-centers` | `dimensions.create` |
| PUT | `/api/ledger/cost-centers/:id` | `dimensions.update` |
| PATCH | `/api/ledger/cost-centers/:id/toggle-active` | `dimensions.delete` |
| GET | `/api/ledger/dimension-options` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/ledger/dimension-rules` | `accountDimensionRules.read, accountDimensionRules.update` |
| PUT | `/api/ledger/dimension-rules` | `accountDimensionRules.update` |
| POST | `/api/ledger/dimension-rules/bulk` | `accountDimensionRules.update` |

## General ledger: opening balances (2.0)

<a id="module-ledgerOpening"></a>Opening balance entry.

* **Route file:** `server/routes/ledgerOpening.ts`, mounted at `/api/ledger` (finance core: also in the API reference and permissions annexes)
* **Screens:** `ledger/`
* **User manual:** [fc-2](../user-manual/warraq-erp-user-manual.html#fc-2)
* **Tables touched directly:** `bank_accounts`, `company_accounts`, `opening_balance_runs`, `users`
* **Tests that call it:** `ledgerJournals`

| Method | Path | Permission |
|---|---|---|
| GET | `/api/ledger/opening-balances` | `openingBalances.read, openingBalances.post` |
| POST | `/api/ledger/opening-balances/preview` | `openingBalances.preview, openingBalances.post` |
| POST | `/api/ledger/opening-balances/post` | `openingBalances.post` |
| POST | `/api/ledger/opening-balances/:id/reverse` | `openingBalances.post` |

## General ledger: posting control (2.0)

<a id="module-ledgerPostingPolicy"></a>Lock date and back-date window.

* **Route file:** `server/routes/ledgerPostingPolicy.ts`, mounted at `/api/ledger` (finance core: also in the API reference and permissions annexes)
* **Screens:** `ledger/`
* **User manual:** [fc-2](../user-manual/warraq-erp-user-manual.html#fc-2)
* **Tables touched directly:** `posting_policies`
* **Tests that call it:** `approvals`, `postingControl`, `settlements`

| Method | Path | Permission |
|---|---|---|
| GET | `/api/ledger/posting-policy` | `postingControl.backDate, postingControl.overrideLock` |
| PUT | `/api/ledger/posting-policy` | `postingControl.update` |

## Receivables and payables ledgers (2.0)

<a id="module-ledgerSubledger"></a>Aging and party ledgers from party-tagged ledger lines.

* **Route file:** `server/routes/ledgerSubledger.ts`, mounted at `/api/ledger` (finance core: also in the API reference and permissions annexes)
* **Screens:** `ledger/`
* **User manual:** [fc-5](../user-manual/warraq-erp-user-manual.html#fc-5)
* **Tables touched directly:** none
* **Tests that call it:** `ledgerSubledger`, `settlements`

| Method | Path | Permission |
|---|---|---|
| GET | `/api/ledger/subledger/:kind/balances` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/ledger/subledger/:kind/ledger` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/ledger/subledger/:kind/aging` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/ledger/subledger/:kind/aging/export` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/ledger/subledger/:kind/ledger/export` | not detected: signed-in user, or checked inside the handler (see route file) |

## Receipts and vendor payments (2.0)

<a id="module-settlements"></a>Receive Payment and Pay Vendor across documents, on account, cancel.

* **Route file:** `server/routes/settlements.ts`, mounted at `/api` (finance core: also in the API reference and permissions annexes)
* **Screens:** `ledger/`
* **User manual:** [fc-3](../user-manual/warraq-erp-user-manual.html#fc-3), [fc-4](../user-manual/warraq-erp-user-manual.html#fc-4)
* **Tables touched directly:** none
* **Tests that call it:** `approvals`, `bankReconciliation`, `settlements`

| Method | Path | Permission |
|---|---|---|
| GET | `/api/settlements/open-items` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/settlements` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/settlements/:id` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/settlements/receipts` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/settlements/payments` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/settlements/:id/apply` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/settlements/:id/cancel` | not detected: signed-in user, or checked inside the handler (see route file) |

## Bank reconciliation (2.0)

<a id="module-bankReconciliation"></a>Reconciliation sessions per bank.

* **Route file:** `server/routes/bankReconciliation.ts`, mounted at `/api/bank-reconciliations` (finance core: also in the API reference and permissions annexes)
* **Screens:** `ledger/`
* **User manual:** [fc-8](../user-manual/warraq-erp-user-manual.html#fc-8)
* **Tables touched directly:** `company_accounts`
* **Tests that call it:** `bankReconciliation`

| Method | Path | Permission |
|---|---|---|
| GET | `/api/bank-reconciliations` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/bank-reconciliations/adjustment-accounts` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/bank-reconciliations` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/bank-reconciliations/:id` | not detected: signed-in user, or checked inside the handler (see route file) |
| PATCH | `/api/bank-reconciliations/:id` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/bank-reconciliations/:id/clear` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/bank-reconciliations/:id/statement-lines` | not detected: signed-in user, or checked inside the handler (see route file) |
| DELETE | `/api/bank-reconciliations/:id/statement-lines/:lineId` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/bank-reconciliations/:id/match` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/bank-reconciliations/:id/unmatch` | not detected: signed-in user, or checked inside the handler (see route file) |
| GET | `/api/bank-reconciliations/:id/suggestions` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/bank-reconciliations/:id/adjustment` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/bank-reconciliations/:id/adjustments/:voucherId/reverse` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/bank-reconciliations/:id/complete` | not detected: signed-in user, or checked inside the handler (see route file) |
| POST | `/api/bank-reconciliations/:id/reopen` | not detected: signed-in user, or checked inside the handler (see route file) |
| DELETE | `/api/bank-reconciliations/:id` | not detected: signed-in user, or checked inside the handler (see route file) |
