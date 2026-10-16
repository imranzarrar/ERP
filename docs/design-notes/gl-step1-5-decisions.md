# GL Step 1.5: dimensions and configurable statements. CFO and architect decisions

Status: decided 2026-10-14, before any of this is built. Sources: `docs/reference/Finance-Core-Blueprint.pdf` (FR-DIM, FR-RPT-CFG, FR-RPT-GL, ERD, posting contract, rollout),
`docs/design-notes/accounting-rules.md`, `docs/design-notes/reporting-rules.md`, `docs/archive/gl-step1-plan.md`, `docs/archive/sprint-log-gl-step1.md`, the project memory, and what the code does today.
The earlier "statement layout designer" mock is superseded where it differs from the Blueprint (names and column model); its formatting, selector and safety ideas are kept.

## What the documents already decided (and I must follow)

| Requirement | Blueprint decision | Code today | Gap |
|---|---|---|---|
| Dimensions | FR-DIM-01: company-configurable dimension types, Branch and Department seeded, any number, each independently combinable on any line; one surrogate `dimension_combination_id` per line, find-or-create by dedup key | Only `journal_entries.branch_id`; nothing else | Whole framework |
| Cost centre | `cost_centers` master, optional home branch, hierarchical; a Department dimension is linked to it | none | New |
| Reports | FR-RPT-CFG: Trial Balance and P&L are two seeded, editable, cloneable instances of ONE Report Definition engine (`report_definitions` / `report_rows` / `report_columns`); rows select accounts by range, parent rollup or explicit list with include and exclude lists on top; balance display Debit/Credit/Net; indent; subtotal sums rows above; calculated rows by formula; columns = period basis x value basis x optional dimension filter; Summary or Detailed | Two hardcoded ledger reports (account tree TB; GL) | Engine, definitions, designer |
| Drill-down | FR-RPT-GL-04: every figure clickable to General Ledger Detail (account set, period, dimension filter) | GL takes one account | Multi-account + dimension filter |
| Branch / comparative | "Branch P&L Comparison, Comparative P&L: existing, via configurable columns" | none | Falls out of the column model |
| Posting | `postJournalEntry` resolves each line's dimension tags to a combination, never writes lines elsewhere | Stamps `account_id` only | Add dimension tags |
| Cash flow, equity changes | FR-RPT-STMT-01/02: derived statements | none | Fixed format (user: "ok until requirements appear") |
| Year-end close | FR-CLOSE: fiscal years, one closing entry into Retained Earnings | none | Later step; Balance Sheet "profit to date" is cumulative until then |
| Not now | Bank reconciliation, cost distribution (allocation) runs, fixed assets, landed cost, approval rules by amount | none | Later; this design must not block them |

## CFO decisions (what the books must guarantee)

1. **One ledger, one engine.** Every statement is a query over posted journal lines. The new engine produces the Trial Balance, Income Statement and Balance Sheet; no second calculation is added next to it.
2. **Existing document-based reports are not changed** and keep being the figures of record until a cut-over is decided. Blueprint rollout step 4 (cut reports over one at a time, old and new side by side) is followed: Ledger vs Documents stays and gains the new statements' totals. (This supersedes the line "ledger-based reports considered and not adopted" in reporting-rules.md; it is updated.)
3. **Integrity shown on the page:** a Balance Sheet says in words whether Assets = Liabilities + Equity; a Trial Balance says whether debits = credits; any account with a balance that no row covers is listed as "Not in this definition" with a warning, so money can never go missing silently.
4. **No double counting:** one account may be selected by only one Accounts row of a definition (after include/exclude), refused on save.
5. **Dimensions are analytical, not a second ledger:** they never change an account balance. P&L accounts normally carry them; a balance sheet filtered by a dimension is shown with a notice that it is partial.
6. **Profit to date:** until Year-End Close exists, "Profit (loss) to date" on the Balance Sheet is the cumulative result of Revenue and Expense accounts. Year-End Close is the next GL step (Blueprint FR-CLOSE) and will take over this row.
7. **Controls:** layout design, dimension setup and viewing are separate permissions; every change to a definition, dimension or rule is audit-logged; posted figures never change because a definition changed (definitions only change presentation).
8. **Dimension requirement policy:** an account can mark a dimension Required, Optional or Not allowed (default value optional). Manual journals enforce Required strictly. Documents (invoice, expense, bill...) apply defaults but do not enforce Required until their forms collect dimensions (next slice); otherwise turning a rule on would stop invoices being issued.

## Architect decisions

1. **Names follow the Blueprint:** `dimension_types`, `dimension_values`, `dimension_combinations`, `dimension_combination_entries`, `cost_centers`, `report_definitions`, `report_rows`, `report_columns` (plus `report_row_selectors`, and `account_dimension_rules`). The unpushed `statement_*` tables are removed.
2. **Dimension storage:** `journal_lines.dimension_combination_id` (and the same on `manual_journal_lines`) with composite `(company_id, id)` foreign keys. A combination is deduplicated by a hash of its sorted `type=entity` members, so a filter is one indexed lookup, not a per-line join.
3. **No polymorphic ids without foreign keys.** An entry stores its entity in a typed column that has a real foreign key (`value_id` to `dimension_values`, `branch_id` to `branches`, `cost_center_id` to `cost_centers`), plus a denormalised `entity_id` for fast filtering, with a check that they agree. `branches` gains a `(company_id, id)` unique key so the link cannot cross companies.
4. **Branch has one meaning:** `journal_entries.branch_id` stays (branch visibility and existing reports use it). The Branch dimension of a line is its combination's branch if it has one (allocation entries, later), otherwise the entry's branch. No backfill is needed.
5. **One shared query layer:** `resolvedLines` (already the single definition of "which account does a line belong to") gains the dimension filter; General Ledger, journal listing, Trial Balance and every report use it. Descendants of a hierarchical value are expanded once, in one helper.
6. **One engine** (`server/lib/reportEngine.ts`): rows x columns evaluated from per-account debit/credit totals fetched once per column; the existing `/reports/trial-balance` route becomes an adapter over the seeded Trial Balance definition (same response shape, so the screen and tests keep working); `/reports/income-statement`, `/reports/balance-sheet` and custom definitions use the same `run` function.
7. **Columns:** `periodBasis` (CurrentPeriod, YearToDate, PriorPeriod, PriorYear, AsAtEnd, CustomRange) x `valueBasis` (Debit, Credit, Net, Movement, OpeningBalance, ClosingBalance), presentation single or Dr/Cr pair, optional dimension filter, plus variance and percent columns that refer to other columns.
8. **Rows:** Heading, Accounts (selectors: account, parent rollup, range, type, posting role; each include or exclude), Subtotal (sum of rows above since the previous subtotal), Calculated (formula over row numbers), Text, Spacer, ProfitToDate. Value rule per Accounts row: Net, Debit, Credit, Debit balances only, Credit balances only, Split (no netting across accounts); optional opposite sign; show always / only when not zero / hidden. Formatting (bold, italic, underline, indent, alignment of label and amount, borders, shading, negatives style, page break) lives in one `format` object validated by one shared module used by the server and the screens.
9. **Drill-down contract:** every evaluated cell returns `{ accountIds, from, to, dims, basis }`, and General Ledger Detail accepts exactly that.
10. **Excel export carries the formatting** (a styled-workbook library replaces the style-less one for these exports); the printed page renders the same table.
11. **Permissions:** `dimensions` (create, read, update, delete=deactivate), `reportDefinitions` (create, read, update, delete=deactivate), and report leaves `incomeStatementLedger`, `balanceSheetLedger`, `cashFlowLedger`, `equityChangesLedger`, `customLedgerReports` next to the existing `trialBalanceLedger` and `generalLedger`.
12. **Everything an addition must touch** (deletion routine, test teardown, RLS and grants, seed script for existing companies, consistency rules, EN/AR/UR text, release script, docs) is part of each slice, not a follow-up.

## Build order (each slice complete: schema, RLS and keys, engine, routes, permissions, screens, translations, tests, docs)

1. **Dimension framework:** types, values, cost centres, combinations, account rules, posting-engine tagging, manual journal pickers, dimension filters in General Ledger / journal listing / reports, setup screens.
2. **Report definition engine:** tables, engine, seeded Trial Balance / Income Statement / Balance Sheet, adapters, designer, statement screens with comparative and dimension columns, drill-down, print and styled Excel.
3. **Cash Flow and Changes in Equity** (fixed format).
4. Demo release, sprint log, then **AR and AP** (new analysis against the Blueprint first), then the automation-ready test-case catalogue.

## Known deviations from the Blueprint (deliberate)

* Approval is the simple maker-checker already built; amount-bracket approval rules stay a later step.
* Dimension rules per account (`account_dimension_rules`) are an addition that implements FR-JE-03 "lines carry the dimensions relevant to their account".
* Row dimension filters are stored in the row (like column filters in the Blueprint) rather than in a child table; dimension values are only ever deactivated, so a stored filter cannot dangle.

## Control accounts and posting profiles (decided after the user asked: "select a party or item in any transaction and the rules apply automatically")

What the documents say: control accounts are accounts only a subledger may post to (FR-COA-02, glossary); a line carries the customer / vendor / tax tag as a strongly typed field (FR-JE-03, ERD); `bank_accounts` gain a linked GL account, `tax_slabs` gain Output/Input VAT account links, product categories replace the free-text `glGroupMappings` with real account keys (ERD "Modified" list); default dimensions flow from the context to the line (Dynamics model the user chose).
What the code does: a document names a posting ROLE (AR, AP, INVENTORY, SALES_REVENUE, COGS ...) and `postJournalEntry` stamps the company's current account for that role; banks and expense categories already resolve to their own account; customers, vendors, products and tax slabs have no account or dimension defaults.

Decision: **one resolution step, inside the posting engine, driven by a posting context.** A document does not pick accounts; it passes WHO and WHAT it concerns, and the engine resolves accounts and dimension tags.
1. `company_accounts` gains `subledger_type` (customer, vendor, inventory, bank, tax, asset, none). A control account is an account with a subledger type; only that subledger's documents post to it (manual journals keep refusing them). Several control accounts per type are allowed (Trade receivables, Staff receivables); the role account (AR, AP ...) remains the company default.
2. Master records may point at their control account (`customers.control_account_id`, `vendors.control_account_id`; only a control account of the matching subledger type is accepted), and at default dimensions (`default_dimension_combination_id`, a combination exactly as on a ledger line) on customers, vendors, products/categories, banks. Tax slabs get their Output/Input VAT accounts; product categories get inventory / sales / COGS accounts (replacing the free-text GL groups).
3. `postJournalEntry` takes an entry-level `context` ({ customerId, vendorId, branchId, bankId, productCategoryId, taxSlabId }). Role lines resolve first through the context (customer's control account, bank's own account, category account, slab account), then through Account Mapping (today's behaviour); dimension tags merge in this priority: line-specific, product/category, customer/vendor, bank, branch, account default; then the account rules decide what is allowed or required.
4. Because every document already calls `postJournalEntry`, existing routes only gain a `context` argument; no route re-implements account selection.
5. The strongly typed `customer_id` / `vendor_id` tags on `journal_lines` arrive with AR/AP (so aging becomes a query over control-account lines), and a consistency rule checks every control account against the sum of its subledger.
6. Order: dimension framework core (in progress) -> posting context and master defaults (slice 1b) -> report engine -> AR -> AP. Product-category revenue/COGS splitting needs line-level product context and is part of slice 1b only for accounts the documents already know (customer, vendor, bank, branch, tax slab); per-category revenue lines follow with AR.
