# GL Step 1 — Company chart of accounts, ledger screens, manual journals (plan for review, no code yet)

Status: DRAFT for review. Nothing here is built. Source: `docs/Finance-Core-Blueprint.pdf` (v0.1), reconciled with what the code does today.

## Where the remaining ERP work stands

Done and verified on production: invoicing, sales, POS, purchasing, inventory, expenses, VAT returns, ZATCA (Sandbox), period close and locks.
Remaining, in this order: **1 GL → 2 AR → 3 AP → 4 HR → 5 Timekeeping → 6 Payroll**. GL comes first because AR/AP aging, payroll and branch/department
costing are all queries over, or postings into, the same journal.

## What exists today (verified in the code)

* `journal_entries` / `journal_lines` with RLS; every document posts to them (invoice, credit note, expense, GRN, bill, return, POS, vouchers).
  `server/lib/ledger.ts` `postJournalEntry` enforces balance; entries are never edited, only reversed (`reversalOfId`, unique).
* `system_accounts`: **16 fixed accounts shared by every company** (Bank, AR, Inventory, GR/IR, VAT input/output/payable, Vendor Credit Receivable,
  Fixed Assets, AP, Paid-in Capital, Retained Earnings, Sales Revenue, COGS, **one** Direct Opex, Rounding). Bank lines carry `bankId`.
* No per-company chart, no expense accounts by category (all expenses land in one DIRECT_OPEX), no manual journals, no ledger screens.
* Reports (Trial Balance, P&L, Balance Sheet, aging, statements) are computed from documents by design (`docs/reporting-rules.md`); the journal is
  checked against them by consistency rule R6. This step does **not** change any existing report.

## Goal of Step 1

An accountant can see and use the ledger: the books by account, drill-down to the documents behind every figure, manual adjustments, and a chart
of accounts that belongs to the company. Existing reports and period rules stay exactly as they are.

## Design

### 1a. Company chart of accounts (additive)
* New table `company_accounts`: `id`, `companyId`, `code`, `name`, `nameAr`, `type` (Asset/Liability/Equity/Revenue/Expense), `parentId` (nullable,
  one level of grouping), `systemKey` (nullable, FK to `system_accounts.key`), `isControl` (AR, AP, Inventory, VAT, GR/IR, Vendor Credit), `isActive`.
  Unique `(companyId, code)`. RLS tenant policy like every other table.
* Seeding: new companies get a standard Saudi starter chart at provisioning (`companyProvisioning.ts`); existing companies get the same through a
  one-off, idempotent backfill script (dry run by default, like `reset-company-transactions.ts`). Each of the 16 system keys maps to exactly one
  company account, so every existing journal line resolves to a company account with **no change to existing rows**.
* A company may rename/recode accounts and add accounts. A system-mapped account cannot be deleted; an account with posted lines can only be
  deactivated; type and system mapping of a used account cannot change.

### 1b. Finer accounts where the business needs them (small, opt-in)
* Expenses: today one Direct Opex line. Add an optional `accountId` on the expense category (the existing `expenseType`/classification lists) so
  rent, utilities, salaries, etc. post to their own expense accounts. Unmapped categories keep posting to Direct Opex, so nothing changes until a
  company maps them.
* Journal lines gain a nullable `accountId`; reports read `coalesce(accountId, account mapped from accountKey)`. Existing lines stay valid.
* Revenue by product category and per-bank accounts are NOT in this step (bank already has `bankId`).

### 1c. Ledger screens (read-only, new menu "General Ledger")
* **General Ledger detail**: one account (or range), date range, branch filter, running balance, each line linking to its source document.
* **Journal listing**: every entry in a period, filter by source type, drill to lines; reversal pairs shown together (audit trail).
* **Trial Balance (ledger)**: shown beside the existing document-based Trial Balance with a difference column that must read 0.00.
* All figures computed server-side, scoped by `req.targetCompanyId`, no row cap (per the server-side-report-aggregation rule).

### 1d. Manual journal entries + opening balances
* Create manual entry: date in an open month and outside a filed VAT quarter (same period rules as documents), balanced, description required,
  optional branch. Lines to **control accounts are refused** (only their subledger documents may post there). Reversal creates a mirrored entry
  dated today; posted entries are never edited or deleted.
* Opening balances for companies whose older documents predate the ledger (e.g. Dalal's legacy difference): a dated opening entry per company,
  dry run first, explicit sign-off before a real run.
* Permissions: new `ledger` module (view, create manual entry, reverse), Role-based like every other module. Audit-log every manual entry.

## Verification (nothing ships without this)
* Consistency rule R6 stays clean on every live company; new rule R7: ledger Trial Balance = document Trial Balance.
* Tests: chart rules (cannot delete/retype used account, control-account guard), manual entry balance and period rules, reversal uniqueness,
  cross-company isolation for every new route, translation of every new string (EN/AR/UR).
* Real screens on local, then SharpSurv on production, before any live company sees it. Release is code + `db:push` (new table, one new nullable
  column, no data change); the backfill is a separate, dry-run-first script you run.

## Order inside Step 1 (each is shippable and reversible on its own)
1a chart + backfill → 1c screens → 1d manual journals + opening balances → 1b category accounts (only when a company asks for it).

## Decisions I assumed (change any of these before I start)
1. Starter chart is a standard Saudi chart that companies can rename, recode and extend (not a blank chart).
2. Existing reports are not cut over to the ledger in this step; cut-over is a later, separate decision after R6/R7 stay clean for a few weeks.
3. Payroll is out of Step 1 and stays last (Step 6), but the dimensions it needs (branch now, department later) are not blocked by this design.

## Open questions for you
1. Do accountants need to define their own account structure from day one, or is a renameable standard chart enough for the first release?
2. Are expenses by category (rent, utilities, salaries) needed in the ledger now (1b), or later?
3. Which live company is the first to use the ledger screens (so I verify against its real data first)?
