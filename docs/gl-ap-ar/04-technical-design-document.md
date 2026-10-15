# Technical Design Document — General Ledger, Receivables, Payables 2.0

Version 1.0 / 2026-10-15. Audience: developers. Companion to the Solution Design (03); data model in annex A, routes in annex B, permissions in annex C. Paths are relative to the repository root.

## 1. Technology

React 19 + Vite client, Node/Express API (`tsx server.ts` in development, esbuild bundle in production), PostgreSQL + drizzle-orm, vitest (real HTTP + real Postgres), ExcelJS (exports), Playwright (PDF), PM2 + Nginx on the VPS. Schema is pushed with `npm run db:push` (no migration files) — see section 14.

## 2. Module map

| Concern | File(s) |
|---|---|
| Posting engine | `server/lib/ledger.ts` (`postJournalEntry`, `reverseAllEntriesFor`, `assertNoReconciledLines`) |
| Posting context and profiles | `server/lib/postingContext.ts`, `server/lib/partyProfile.ts` |
| Posting guard | `server/lib/postingGuard.ts`, route `ledgerPostingPolicy.ts` |
| Document dates | `server/lib/documentDates.ts`, `server/lib/pickFields.ts` |
| Chart, mapping | `server/lib/chartOfAccounts.ts`, `server/routes/ledgerAccounts.ts` |
| Manual journals, opening | `server/routes/ledgerJournals.ts`, `ledgerOpening.ts` |
| Dimensions | `server/lib/dimensions.ts`, `server/routes/ledgerDimensions.ts` |
| Ledger reads | `server/lib/ledgerQueries.ts` (`resolvedLines`, `accountTotals`, `branchIdsFor`) |
| Report engine | `server/lib/reportEngine.ts`, `server/routes/ledgerReports.ts` |
| Subledgers | `server/lib/subledger.ts`, `server/routes/ledgerSubledger.ts` |
| Settlements | `server/lib/settlements.ts`, `settlementFacts.ts`, `server/routes/settlements.ts` |
| Bank reconciliation | `server/lib/bankReconciliation.ts`, `server/routes/bankReconciliation.ts` |
| Document-based reports | `server/lib/financialReports.ts`, `server/routes/reports.ts` |
| Consistency | `server/lib/consistencyCheck.ts` |
| Print data | `server/lib/postingPrint.ts`; renderer `src/components/DocumentRenderer.tsx` |
| Screens | `src/components/LedgerModule.tsx`, `src/components/ledger/*`, menu in `src/App.tsx` |
| Translations | `src/glTranslations.ts`, `scripts/apply-gl-translations.ts` |

## 3. Request lifecycle

`isAuthenticated` (session or `x-session-id`) → sets `req.user`, `req.targetCompanyId` → route `withTenantDb` (one transaction on role `erp_app_tenant`, `set_config('app.company_id', …, true)`; commit/rollback on `res.end`) → permission check (`hasPermission(req.user, 'module.leaf')`) → ownership checks of every client-supplied id → `assertPostingAllowed` (dated postings) → domain service via `tenantDb()` → `recordAuditLog` → response. Never wrap a handler body in another `db.transaction`. `runAfterTenantCommit` defers side effects (ZATCA) until commit.

## 4. Posting engine

`postJournalEntry(tx, { companyId, branchId, postingDate, docDate?, referenceType, referenceId, description, createdById, lines[], dimensions?, dimensionMode?, context? })`.

1. Sum debits/credits; refuse imbalance beyond the rounding ceiling (a sub-cent difference goes to the ROUNDING role).
2. `loadPostingProfile` from the posting **context** (document party read from the source row by `partyOfDocument`, or passed explicitly): control account per customer/vendor, bank account per `bankId`, expense-category account, default dimension combinations.
3. Each line resolves to an account: explicit `accountId` → bank account (for role BANK with `bankId`) → party control account → role mapping (`company_accounts.system_key`).
4. Dimension tags merge by priority: line → entry → party → bank → account default; `applyRules` then drops not-allowed tags and (mode `strict`, manual journals) refuses missing required ones; `resolveCombination` find-or-creates one deduplicated combination.
5. `resolvePartyTags` sets `customer_id` / `vendor_id` on every line whose account has `subledger_type` customer/vendor.
6. Insert entry and lines; return the entry id.

`reverseAllEntriesFor(tx, companyId, referenceType, referenceId, date, description, userId)` finds every unreversed entry of the document, **first** calls `assertNoReconciledLines` (a bank line cleared by a reconciliation blocks the whole reversal), then posts each mirror with the original accounts, bank, tags and parties. `journal_entries.reversal_of_id` is unique, so an entry reverses once.

## 5. Posting guard (`assertPostingAllowed(req, postingDate, { vat, reason })`)

Order: (1) open existing fiscal month, not future; (2) VAT quarter (`vat`: `'none'` | `'filed'` | `'frozen'`); (3) `posting_policies.lock_date` unless `postingControl.overrideLock`; (4) `max_back_days` unless `postingControl.backDate`; (5) reason when older than `reason_after_days`; (6) audit `BACKDATED_POSTING` when an override or a reason was used. No policy row = rules 1–2 only. Every route listed in `docs/posting-control.md` calls it; manual journals call it at submit and approval; settlements and bank adjustments call it from the route.

## 6. Document dates

`doc_date` (document), `posting_date` (ledger; defaults to doc_date via `documentDates()`), `<meaning>_date` as Postgres `date` via the `businessDate` custom type (string `YYYY-MM-DD`; raw `tx.execute` also returns strings). Renames were done in place by `scripts/migrate-date-fields.mjs` before `db:push`. Naming rules: `docs/date-fields-standard.md` and skill `consistent-column-names`.

## 7. Settlements (`server/lib/settlements.ts`)

* `openItems(kind, partyId)` reuses `computeOutstanding` (one definition of "owed").
* `recordSettlement`: validate amount, bank, party, allocations (`checkAllocations`: type allowed for the kind, amount > 0, document open for that party, ≤ outstanding, no duplicates, total ≤ amount) → voucher (`CustomerReceipt` Receipt / `VendorPayment` Payment, `reference_id` = party id) → entry (bank Dr / `AR` Cr, or `AP` Dr / bank Cr; the engine tags the party) → `payment_allocations` rows (`applied_date`) → `movePaid` updates the document (`amount_paid`, status; bills use `status`).
* `applyOnAccount` locks the voucher row and allocates up to `amount − Σ active allocations`.
* `cancelSettlement` requires a reason: moves paid amounts back, sets `reversed_at/reversed_date`, `reverseAllEntriesFor`, writes a Reversal voucher with `reversal_of_voucher_id`.
* `assertNoActiveAllocations` is called by invoice cancel and `cancelExpense`.

## 8. Allocations in the document-based reports (`settlementFacts.ts`)

`allocationEvents` turns each allocation into the voucher it would have been had it been paid directly (type Receipt/Payment dated `applied_date`; a Reversal dated `reversed_date`). Used for: later-payment adjustment of as-at balance sheets (`laterVoucherTotals`), cash-basis revenue/expense recognition, outstanding figures. `onAccountBalances(asOf)` = settlement vouchers up to the date not cancelled by then, minus allocations applied and not reversed by then → Customer advances (liability) / Vendor advances (asset) in `computeBalanceSheet` and `computeTrialBalance`; Ledger-vs-Documents compares AR/AP net of them. Statements and cash flow read the settlement voucher itself (full amount, own date). Reversal direction is one rule: `reversalIsCashOut(referenceType)`.

## 9. Subledger (`server/lib/subledger.ts`)

Balance per party = Σ(debit − credit) of lines tagged with the party on the control accounts. Aging = balance-forward: charges aged from their document date, credits (payments, credit notes, receipts on account) set against the oldest charge first; an unapplied credit shows in an *On account* column; buckets Not due / 1–30 / 31–60 / 61–90 / Over 90 (labels from the report). `reconciliation` returns control-account balance, aging total, difference and untagged lines. Consistency rules R8.1–R8.4 prove: no untagged control line, parties sum to control accounts, aging equals balance.

## 10. Bank reconciliation (`server/lib/bankReconciliation.ts`)

* Bank ledger account = `company_accounts.bank_id`; its lines are `resolvedLines` with that account id.
* Lines shown for a session: outstanding at its date (`bank_reconciliation_id IS NULL` or cleared by a later session) plus those it cleared.
* Summary: `book` = Σ lines ≤ date; `cleared` = Σ lines cleared by this session or an earlier **Completed** one; `difference = statement − cleared`; deposits in transit / payments outstanding = uncleared debits / credits. Identity: statement + deposits in transit − payments outstanding = book when `difference = 0`.
* Completion: `difference = 0` and no unmatched statement line; stores `gl_balance_at_reconciliation`.
* Adjustment: voucher (`BankCharge` Payment or `BankInterest` Receipt) + entry (bank against an active, postable **Expense** (charge) or **Revenue** (interest) account), line cleared and matched. Reversal: `reverseAdjustment` un-matches, un-clears, reverses entry, writes Reversal voucher.
* Legacy statements read the charge/interest figures from the ledger entry: `bankAdjustmentRows/Totals` in `financialReports.ts` feed P&L, trial balance, balance sheet (open months), month P&L, dashboard and cash flow.
* Reopen: latest completed session of the bank only; no other session in progress; audit `BANK_RECONCILIATION_REOPEN`.

## 11. Report engine (`server/lib/reportEngine.ts`)

Definition = rows × columns. Rows: Heading, Accounts (selectors: account, parent rollup, range, type, role; include/exclude; value rule Net/Debit/Credit/Debit-only/Credit-only/Split; show rule), Subtotal, Calculated (formula over row numbers), Text, Spacer, ProfitToDate. Columns: `periodBasis` × `valueBasis` × presentation × optional dimension filter, plus variance columns. Per column the engine fetches per-account debit/credit totals once through `resolvedLines`. Every cell returns `{ accountIds, from, to, dims, basis }` for drill-down. Formatting is validated by one shared module. The legacy `/reports/trial-balance` is an adapter over the seeded definition.

## 11a. Approvals (`server/lib/approvals.ts`, `server/routes/approvals.ts`)

* Tables: `approval_rules` (document type, amount band: above `min_amount` up to and including `max_amount`, priority), `approval_rule_levels` (1..5; approver type Role / User / Permission / Manager with `manager_steps`), `approval_requests` (intent `payload`, rule **snapshot** `levels`, current level, status, submitter, `self_approved`, `result_document_id`), `approval_actions` (append-only). `users.manager_id` feeds the Manager approver; the users route (`server/routes/users.ts`) validates it (same company, not self, no loop up to 20 hops) and the user form in Settings sets it.
* `submitForApproval(tx, req, {documentType, amount, summary, payload})`: lowest-priority active rule whose band contains the amount; none = `{pending:false}` and the caller continues exactly as before.
* `decideRequest`: row-locks the request; refuses the submitter unless `companies.journal_self_approval` is on; checks the level authority (`holdsLevelAuthority`), that the actor has not acted before, requires remarks to reject; on the last approval calls the registered **executor**, which runs `assertPostingAllowed` for the approver and creates the document as the submitter. Any refusal rolls back the whole decision (no action row is kept).
* Recall: `recallRequest` (submitter only, pending only; action row `Recalled`, status `Recalled`). Delegation: `approval_delegations` (delegator = signed-in user, `valid_from`..`valid_to`, active flag, delegator <> delegate); `levelAuthority` returns the person's own authority or the delegator they act for (role, user and manager levels only), the decision records `on_behalf_of_id`.
* Credit notes: the credit/debit note route was split into `loadNoteOriginal` (existence, branch, not cancelled, not credited twice, has lines; throws with a status) and `issueInvoiceNote` (document, lines, restock, money reversal, ledger reversal, ZATCA after commit), used by the route and by the `CreditNote` executor, so the approved note is exactly the one the route would have issued; the amount judged is the original invoice total.
* Executors: `VendorPayment` (settlements route, `recordSettlement`), `VendorBill` (inventory route, `createPurchaseBillForGrns`). A bill's amount comes from `purchaseBillTotals` (the same function the bill is built from). The goods-receipt "paid at delivery" shortcut calls `findRule` and is refused when a rule would hold the bill or its payment.
* Add a document type: register an executor, add the type to `SUPPORTED` in the routes and to the table check, route its create endpoint through `submitForApproval`, add tests, update the BRD/SRS/manual.

## 12. Consistency checks (`GET /api/reports/consistency-check`)

R1.1 balance sheet balances · R1.2 trial balance balances · R2.x balances tie to registers · R3 stock register = quantity · R4 locked periods never move · R5.1 balance sheet balances at every earlier month end · R6.1 ledger agrees with documents per account (AR/AP net of money on account) · R7 journal soundness · R8.1–R8.4 party tags and subledger ties. Error-severity failures fail the test suites that call it.

## 13. Print

`DocumentRenderer` document types `SettlementVoucher`, `JournalVoucher`, `BankReconciliation` take server-resolved data (`GET /settlements/:id`, `…/manual-journals/:id/print-data`, `…/journals/entries/:id/print-data`, `GET /bank-reconciliations/:id`). Accounting documents follow the viewer's language and direction (`isAccountingDoc`). The overlay uses `z-[60]` so it sits above drawers.

## 14. Schema, RLS and release mechanics

* `src/db/schema.ts` is the single source. `npm run db:push` diffs the **live** database; read the printed plan. Never accept a TRUNCATE prompt.
* Prerequisite unique keys for composite foreign keys on populated tables are created by `scripts/pre-push-keys.mjs` (branches, customers, vendors, vouchers).
* drizzle-kit drops RLS predicates and does not update changed CHECKs: always run `npx tsx scripts/apply-rls-policies.mjs` and `npx tsx scripts/apply-check-constraints.mjs` after a push.
* Back-fill of party tags: `scripts/backfill-party-tags.ts --apply` (idempotent).
* Translations: add rows to `src/glTranslations.ts`, then `npx tsx scripts/apply-gl-translations.ts --apply` (inserts missing, fills blanks, never overwrites edits).

## 15. Known traps (learned the hard way)

* Dev server on 3001 has no watch: restart after backend edits. Tests: `TEST_BASE_URL=http://localhost:3001`.
* Raw `tx.execute` returns DATE as string; drizzle select overrides parsers.
* `recordAuditLog` sets `req._auditLogged`; use a stand-in req when calling outside a request.
* A first release after changing `release-demo.sh` runs the **old** copy mid-pull: rerun.
* Blueprint requirement ids in older code comments (`FR-AR-01 / FR-AP-03` for allocation) are off by one; the correct ones are FR-AR-02 and FR-AP-04 (see BRD section 9).
