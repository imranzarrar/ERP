# Sprint log: General Ledger, Step 1.5 (dimensions, financial statements, posting profiles) — Demo / 2.0 only

Status: **built and tested locally; not yet on the Demo until the release script is run.** Branch `v2`. Nothing here touches Live (1.0).
Design record: `docs/gl-step1-5-decisions.md` (CFO and architect decisions, Blueprint reconciliation). Step 1 is in `docs/sprint-log-gl-step1.md`.

## What you can try

| Menu | What it does |
|---|---|
| **Dimensions → Dimensions** | Define as many dimensions as you need (Branch and Department / Cost centre come with every company). Custom dimensions have their own values, optionally in a hierarchy. |
| **Dimensions → Dimension Values / Cost Centres** | The values of each dimension; cost centres (optionally under a home branch, in a hierarchy). |
| **Dimensions → Account Dimension Rules** | A matrix of accounts × dimensions: Optional, Required or Not allowed, with a default value. **Bulk apply** by account type, heading, code range or a hand-picked list, with a dry run first. |
| **Journals → New Manual Journal** | Each line shows only the dimensions its account allows; Required ones are marked; the account's default is pre-filled. Checked at submit and again at approval. |
| **Ledger Reports → General Ledger / Journal Listing** | Filter by any dimension. A parent value includes everything under it. Drilling from a statement line opens the General Ledger for exactly those accounts. |
| **Ledger Reports → Trial Balance, Income Statement, Balance Sheet, Cash Flow Statement, Changes in Equity** | Ledger-based statements. Pick a layout, period, Summary or Detailed, a dimension filter. Click any figure to see the entries behind it. Print and styled Excel. Each statement checks itself (TB balanced; BS assets = liabilities + equity; cash flow agrees with the bank and cash accounts; closing equity agrees with the balance sheet). |
| **Ledger Reports → Report Designer** | Design any statement: rows (heading, group of accounts by one account / heading / code range / type / posting role / every bank and cash account, include and exclude, subtotal, formula over earlier rows, profit to date, text, blank), balance display (net, debits, credits, debit balances only, credit balances only, split), columns (period × measure, debit/credit pairs, variance and percent between columns, a dimension filter per column or row), formatting (bold, italic, underline, indent, borders, shading, alignment, negatives, decimals, show-if-not-zero). Live preview. Several layouts per statement with one default; "reset to standard". |
| **Chart of Accounts → edit account** | "Control account for": make an ordinary account the receivable account of some customers or the payable account of some vendors. |
| **Customers / Vendors / Banks forms → Posting profile** (needs the Account Mapping permission) | A customer's receivable account (or a vendor's payable account) and default dimensions; a bank's default dimensions. Every document for that party then posts to that account and starts from those tags, with no route choosing accounts itself. |

All screens are in English, Arabic (right-to-left) and Urdu.

## Rules the system now enforces

- **One engine for every statement.** Trial Balance, Income Statement, Balance Sheet, Cash Flow, Changes in Equity and your own reports are *definitions* (rows × columns) run by the same engine over the same ledger lines; figures are computed in Postgres for the one company of the request.
- **Nothing is silently left out.** Accounts with figures that no row of a layout covers are listed under "Not in this report" with a warning count, and are not in the totals.
- **An account is counted once per balance point** in a layout (so a row cannot double-count); an opening-balance row may repeat an account a movement row also has.
- **Dimensions are checked where it matters.** Manual journals: Required missing or Not-allowed present is an error. Documents: defaults fill gaps, Not-allowed tags are dropped, Required is not yet enforced (document forms do not collect dimensions yet — see Known limits).
- **Priority of tags on a ledger line**, highest first: the line's own, the document's, the party's default, the bank's default, the account's default.
- **Control accounts**: an account marked for customers or vendors takes only that subledger's documents; manual journals refuse it. A control account in use cannot stop being one or be deactivated; the mark can be set or removed only while the account has no postings. A customer or vendor can name only an active control account of the matching subledger (not the company's own AR / AP role account, which is what "company default" already means).
- **History never moves.** A reversal or cancellation reposts onto the exact accounts and tags the original used, whatever the profile says today.
- **Changing where a party posts, or what it is tagged with, is accounting setup**, not customer maintenance: it needs the Account Mapping permission. Saving a customer's other details never touches it.

## Permissions added (Roles screen)

`dimensions` (create, read, update, delete), `accountDimensionRules` (read, update), `reportDefinitions` (create, read, update, delete — designing), and the viewing permissions `reports.trialBalanceLedger`, `incomeStatementLedger`, `balanceSheetLedger`, `cashFlowLedger`, `equityChangesLedger`, `customLedgerReports`. Designing a layout does not give the right to view a statement, and the reverse.

## Schema impact (production safety)

All additive and nullable; nothing dropped, renamed or retyped.
- New tables (all with RLS and company-scoped composite keys): `cost_centers`, `dimension_types`, `dimension_values`, `dimension_combinations`, `dimension_combination_entries`, `account_dimension_rules`, `report_definitions`, `report_rows`, `report_row_selectors`, `report_columns`.
- New nullable columns: `journal_lines.dimension_combination_id`, `manual_journal_lines.dimension_combination_id`, `report_rows.value_basis`, `company_accounts.subledger_type`, `customers.control_account_id`, `customers.default_dimension_combination_id`, same two on `vendors`, `bank_accounts.default_dimension_combination_id`.
- New unique key `branches (company_id, id)` (target of a composite foreign key) — created by the release script before `db:push`.
- Widened CHECK constraints (`report_definitions_type_check`, `report_row_selectors_type_check` / `_shape_check`). **`drizzle-kit push` does not update a CHECK whose text changed**, so a new script, `scripts/apply-check-constraints.mjs`, compares every declared check with the database and replaces the ones that differ (idempotent; `--dry-run` available). Both release scripts run it after `db:push`.
- Backfill (idempotent, in `seed-company-charts.ts`): the five standard report definitions per company, Branch / Department dimensions, and subledger types on the chart's control accounts.

## Tests (real HTTP + real Postgres, no mocks)

`ledgerDimensions` (13), `ledgerReportEngine` (20: every row type, selector, balance display, column option, dimension filter, drill-down, designer permissions, Excel formatting, Cash Flow, Changes in Equity), `ledgerPostingProfile` (9), plus the Step 1 files (accounts, journals) and `companyDeletion` / `crossCompanyIsolation` / `rlsPolicyCoverage` extended for the new tables.

## Known limits (deliberate, listed so nothing is a surprise)

- Document forms (invoice, bill, expense) do not yet collect dimensions, so a Required rule is enforced only on manual journals; documents get defaults from the account, party and bank.
- The Balance Sheet's "profit to date" is cumulative until a Year-End Close exists; the Balance Sheet filtered by a dimension is partial (a notice says so).
- Cash flow and changes in equity are standard layouts built from the chart as it is today; a new account added later shows under "Not in this report" until you edit the layout or press "Reset to standard".
- Tax slab accounts (Output / Input VAT per slab) and per-product-category revenue / inventory / COGS accounts are **not** part of posting profiles yet; they come with AR/AP, where documents carry line-level tax and product context.
- The typed customer / vendor tag on every ledger line (so aging is a query over control-account lines) and a control-account-versus-subledger consistency rule arrive with AR/AP.
- Bank reconciliation and a Year-End Close are later steps.

## Before this goes to Live

Not a Live item. When promoted: run `deploy/release.sh` (it now runs the check-constraint step), `npx tsx scripts/seed-company-charts.ts --apply`, `npx tsx scripts/apply-gl-translations.ts --apply`; the schema changes are additive.
