# Ledger-based reporting — design and evaluation

Status: **proposal, nothing implemented.** Written 2026-10-06 after a full-cycle test on a clean company (156 documents, closed months,
filed VAT quarter, next period) kept turning up one report defect per scenario.

## 1. What is wrong today (root cause, not symptoms)

Every financial report (P&L, Balance Sheet, Trial Balance, AR/AP, outstanding, statements, VAT) is computed from the **current state of the
document tables**, and each report re-implements its own recognition rules. A document row only knows its *latest* status
(`paymentStatus`, `amountPaid`, `accrualSettled`, `billTotalsReduced`, `Cancelled`, current stock quantity ...), not its history. So:

* "as at an earlier date" needs the history back, and every missing piece is a patch (payments after the date, settlements after the date,
  returns after the date, capital after the date, stock movements after the date ...). Five of those patches were needed in one day.
* every new rule (accrual VAT, settlement variance, vendor credit) has to be mirrored in 6-10 places; one miss = a report that disagrees.
* corrections are posted on inconsistent dates (see 3.2), so even a correct report shows a wrong period.

The business-event record that *does* have full history already exists: the **journal** (`journal_entries` / `journal_lines`): every posting
is dated, balanced, and reversals are separate dated entries. Reports simply do not use it (only COGS is read from it).

## 2. Evaluation: ledger vs document-based reports (lifecycle scenario, 20 document types)

Prototype comparison on the `periodCloseLifecycle` scenario (invoices incl. cancel/credit/POS return, quotations, expenses, recurring,
accrual+settlement, GRN/bill/pay/cancel/reverse, purchase returns, transfers, dispatch/receiving, adjustments, stock take, capital):

| as at | accounts equal | accounts differing |
|---|---|---|
| today (end of scenario) | **13 of 13** (bank, AR, AP, inventory, fixed assets, VAT in/out, GR/IR, vendor credit, capital, revenue, COGS, opex) | none |
| 30 Sep (end of 2nd month) | 9 of 13 | bank, AP, VAT input (all caused by bills/GRN dated *today* while their payments were back-dated in the test) |
| 28 Aug / 17 Aug | 10 of 13 | AP, VAT input, **opex (ledger wrong, see 3.2)** |

Conclusions:
1. The posting logic is **complete and consistent**: at the end state the ledger equals the documents on every account. The ledger is not
   the weak link; the document-based as-of logic is.
2. The remaining past-date differences are all *posting-date* problems (3.1, 3.2), which a ledger-based report would expose and which must be
   fixed once, at the source, instead of in every report.

## 3. Defects found by the evaluation (posting-date policy)

3.1 **GRN, purchase bill and their payments cannot be dated.** A bill is always dated "today"; its payment accepts any date. A supplier
invoice dated in an earlier open month cannot be recorded in that month (VAT period, AP ageing and the ledger all land in the wrong period).
Needs a supplier-invoice date on the bill (nullable column, schema change) validated like every other document date.

3.2 **Cancel-expense reversal is dated in the "oldest open month".** `cancelExpense()` dates the reversal on today, else the expense's date if it
is in the oldest open month, else the *first day of the oldest open month*. In the scenario a 21 Sep expense cancelled later was reversed on
**1 Aug** — before it existed. Document reports hide it (a cancelled expense is excluded); a ledger report would show -50 opex in August
and +50 in September.

3.3 **Two correction policies in one product.** Invoice cancel / back-office credit note are *dated at the original invoice date* and refused if
that month is closed or that VAT quarter filed (so a Q3 invoice can never be credited in Q4). Expense cancel posts to the oldest open month.
POS return is dated today. Under ZATCA a credit note is dated when it is *issued* and adjusts VAT in that period.

## 4. Proposed design

### 4.1 Single source of truth
Reports become pure queries over the journal:
* Trial Balance = sum(debit-credit) by account for entries dated <= date (period accounts for the range). Balance Sheet / P&L = groupings of the
  same figures. Always balanced by construction; as-at is free; a closed month is immutable because nothing can be posted into it.
* AR / AP / vendor credit by document = lines grouped by (account, referenceId); ageing and outstanding as-at come from the same data.
* Inventory = INVENTORY account (cost as posted), reconciled to the stock register (qty x average cost) by a visible reconciliation line.
* Stored `closedPnL` stays as an audit snapshot (equal to the ledger P&L for the month, asserted in tests).

### 4.2 What stays document-based (on purpose)
* **VAT registers and returns**: VAT follows tax-invoice dates, not postings. They stay document-based (already date-based, locked by the
  filed-quarter guard) but gain a **reconciliation check** against the ledger VAT accounts per quarter before filing.
* **Customer / vendor statements**: document listings with running balance — unchanged.
* **ZATCA pipeline** (`server/lib/zatca/*`): not touched.

### 4.3 One period policy (needs your decision, see section 6)
* A document may be *voided* (status Cancelled, original date) only while its month is open and its VAT quarter unfiled.
* Anything later is a *correction dated today* (credit note, supplier credit, expense reversal), posted in the current open period, adjusting
  VAT in the period of issue. No document ever changes a past period; no reversal is ever dated before its original.

### 4.4 Backfill
Companies with documents from before the ledger existed (the live company: a handful of invoices/expenses/GRN) get entries generated from their
documents by an idempotent script (dry run prints per-account diff against today's reports; must be zero before it is applied).

## 5. Rollout (each step independently verifiable; nothing is cut over blind)

0. **Evaluation harness** (done as a prototype above): promote it to a permanent test that compares ledger vs documents on every scenario test
   at several dates, plus a read-only admin endpoint that returns the per-account differences for any company (usable on prod).
1. **Fix posting dates at the source** (3.1 supplier-invoice date, 3.2 expense-cancel date, 3.3 policy) with scenario tests. Document reports keep
   running unchanged.
2. **Build the ledger report engine** next to the existing one (new module, no route changes), unit-tested against the harness.
3. **Backfill** prod companies (dry run -> review -> apply), then run both engines in shadow and diff for a period.
4. **Cut over per company behind a flag** (`reportsFromLedger`), SharpSurv first, live company last.
5. **Delete the document-based aggregation** from the reports once shadow diffs have been zero for the agreed period; keep it in the test suite as
   an independent oracle.

Risks / things not to break: closed-month snapshots and filed VAT returns (never recomputed), ZATCA submission, RLS (journal tables already
tenant-isolated), report performance (add (company, account, date) index; monthly balance snapshots if a tenant grows large).

## 6. Decisions needed

1. **Period policy**: adopt 4.3 (void only in an open, unfiled period; otherwise a correction dated today) for invoices, expenses, bills,
   returns? (Recommended; it matches ZATCA credit-note timing and standard practice. It changes today's behaviour: credit notes will be dated
   at issue, not at the original invoice date.)
2. **Supplier-invoice date on purchase bills** (one nullable column, `db:push`): yes/no.
3. **Negative stock**: keep "allowed" (a sale before any purchase is costed at 0 and corrected on receipt by a visible true-up entry) or block it?
4. **Backfill of the live company**: approve a dry run first?
5. **Rollout flag per company**: agreed order SharpSurv -> test companies -> live company?
