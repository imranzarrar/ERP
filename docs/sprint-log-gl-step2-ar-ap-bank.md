# Sprint log — Step 2 (Demo / 2.0): date standard, posting control, receivables / payables, bank reconciliation, print-outs

Written 2026-10-15. Design: `docs/ar-ap-bank-design.md` (read its "As built" section for the decisions made while building). Follows `docs/sprint-log-gl-step1-5.md`.

## What was built, in the order it landed

1. **One date standard on every document** (`docs/date-fields-standard.md`, skill `consistent-column-names`): `doc_date` (the document's own date, for operational reports), `posting_date` (the ledger / period date, for statements and every lock), `<meaning>_date` as Postgres `date`, `created_at/by`, `updated_at/by`. ~18 tables renamed in place by the idempotent `scripts/migrate-date-fields.mjs` (run before `db:push`); the API, UI and tests follow.
2. **Posting control** (`docs/posting-control.md`): one guard (`server/lib/postingGuard.ts`) for every dated posting — open fiscal month, VAT quarter, **lock date**, **back-date window** (days), **reason** after N days — with override by permission (`postingControl.backDate`, `postingControl.overrideLock`) and an audit entry. Screen: General Ledger › Posting Control.
3. **Receivables and payables as ledger subledgers**: every receivable / payable ledger line carries its customer / vendor (`journal_lines.customer_id / vendor_id`, set by the posting engine, history back-filled by `scripts/backfill-party-tags.ts`). Aging, party ledger and the control-account reconciliation are queries over those lines (`server/lib/subledger.ts`); consistency rules R8.x prove them.
4. **Receive Payment / Pay Vendor** (`server/lib/settlements.ts`, `server/routes/settlements.ts`): one voucher + one ledger entry + N `payment_allocations` rows; a remainder is **held on account** and applied later; cancelling reverses the entry, writes a Reversal voucher and gives every allocation back. A document settled through a receipt cannot be cancelled until the receipt is.
5. **The document-based reports understand it** (`server/lib/settlementFacts.ts`): allocations are read back as the vouchers they would have been had they been paid directly (dated by `applied_date` / `reversed_date`), money held on account is a liability (Customer advances) or an asset (Vendor advances) on the Balance Sheet and Trial Balance, the Ledger-vs-Documents comparison nets it, customer / vendor statements and the cash flow count the receipt itself. A cancelled customer receipt now takes the cash out of the bank balance (one rule, `reversalIsCashOut`).
6. **Bank reconciliation** (`server/lib/bankReconciliation.ts`, Blueprint FR-BANK-01..05): a session per bank and statement date; statement lines typed or imported from CSV; matching (with suggestions, never silent); live formula; completion only at zero difference with every statement line matched; **bank fee / interest posted from inside the session** as a voucher + ledger entry to an expense / income account; completion locks the cleared lines (the posting engine refuses to reverse an entry with a reconciled bank line); reopening needs its own permission, a reason, only the latest completed session of the bank, and is audited.
7. **Print-outs** (one server-resolved posting query `server/lib/postingPrint.ts`, one renderer `DocumentRenderer.tsx`): Receipt / Payment Voucher (party, amount in words, settled documents, held on account, accounting entry, signatures), Journal Voucher (any manual journal in any status, any posted entry), Bank Reconciliation Statement. Arabic / Urdu print right-to-left.
8. **Test-case catalogue** (`docs/test-cases/`): 290 cases as CSV / JSON / Gherkin, generated from one source file.

## Permissions added (Roles screen)

`postingControl` (read, update, backDate, overrideLock), `customerReceipts` and `vendorPayments` (create, read, update, delete), `bankReconciliation` (create, read, match, adjust, complete, reopen), plus the report keys of the subledger reports (`reports.receivablesAging`, `payablesAging`, `customerLedger`, `vendorLedger`).

## Schema impact (production safety)

Additive, except the in-place date renames (which `migrate-date-fields.mjs` does before `db:push`; **read the db:push plan and decline anything that drops, renames or retypes**).
- New tables (all with RLS and company-scoped composite keys): `posting_policies`, `payment_allocations`, `bank_reconciliations`, `bank_statement_lines`.
- New columns: `journal_lines.customer_id / vendor_id / bank_reconciliation_id / reconciled_at`, `manual_journals.back_date_reason`, `company_accounts.subledger_type`, the customer / vendor posting-profile columns, and the date renames of the first item.
- New unique keys created before `db:push` by `scripts/pre-push-keys.mjs`: `branches`, `customers`, `vendors`, `vouchers` on `(company_id, id)`.
- `drizzle-kit push` never updates a changed CHECK; `scripts/apply-check-constraints.mjs` does. RLS predicates are applied by `scripts/apply-rls-policies.mjs` after every push.
- New voucher reference types: `CustomerReceipt`, `VendorPayment`, `BankCharge`, `BankInterest` (free text column, no constraint to change).

## Tests (real HTTP + real Postgres, no mocks)

`postingControl` (8), `ledgerSubledger` (8), `settlements` (11), `bankReconciliation` (12) and the print-data assertions in `ledgerJournals`; the whole suite: 808 pass, the only failures are the 9 that need a real SMTP server (`companyOnboarding`, `passwordReset`). **Run the suite against the 3001 dev server with `TEST_BASE_URL=http://localhost:3001`** (the default is 3000, which is the Live checkout's dev port).

## Known limits (deliberate, listed so nothing is a surprise)

- Receipts and payments are single-currency (company currency) and are not yet routed through approval rules (Blueprint FR-APR is not built).
- A bank adjustment is limited to a bank fee (expense account) and bank interest (income account). A timing error or a wrong amount is put right on the document itself, which the reconciliation then clears. Dimension tags for the adjustment account come from the account's defaults (the dialog has no dimension picker yet).
- Statement import is CSV (Excel: save as CSV). Date columns are read day-first unless written year-first.
- A vendor payment on account is treated as operating cash out in the cash-flow statement (the CapEx / OpEx split of what it later settles is not known at payment time).
- "Amount in words" on prints is English.
- Restricted month status and adjustment periods, per-module close, approval rules, Year-End Close are not built.

## Before this goes to Live

Not a Live item. When promoted: `deploy/release.sh` already runs the date migration, `pre-push-keys.mjs` and the check-constraint step; it still needs the `backfill-party-tags.ts --apply` step that `release-demo.sh` has, then `seed-company-charts.ts --apply` and `apply-gl-translations.ts --apply`.
