# Overnight report: clean books, rules, and what was verified

## Where things stand

* Everything is committed on `master` (nine commits ahead of `origin/master`, **not pushed**, last is `f46e111`).
* `npm run lint` clean, `npm run check:isolation` clean.
* Full suite: 679 of 680 passed. The one failure (`companyOnboarding`, a 5 s timeout) happens only when all 72 files run in parallel; it passes alone (25/25) and does not touch anything changed.
* The built-in consistency check (`GET /api/reports/consistency-check`, 18 rules, listed below) is clean after every step of every run described here.

## The rules the system now follows

1. **Closed month locks its documents; a generated or filed VAT quarter locks its tax documents.** Nothing a user can do (cancel, reverse, credit, return, pay, settle, delete) changes a closed month or a generated or filed quarter.
2. **Corrections of locked documents are new documents dated today** (current open month and quarter):
   * invoice: credit note dated the day it is issued (the original invoice date is stored on it as a reference);
   * expense in a closed month: a reversal document (negative expense) dated today, from the Reverse button; the plain Cancel is refused there;
   * purchase: vendor return dated today; vendor refund as a separate document.
3. **Cancel stays available only for unlocked documents** (invoice not reported to ZATCA, expense in an open month), and its reversal is dated the day of cancellation.
4. **Bill date is mandatory** and validated like every other dated document.
5. **Inventory rule:** stock = quantity (including goods in transit) x weighted-average cost, valued in whole cents per product. Every stock-moving flow posts the difference between the valuation before and after (revaluation). Selling before the receipt (cost 0) is not a report issue; stock is a Balance Sheet item.
6. **Vendor-credit rule:** a return reduces only the unpaid part of a bill; the paid part becomes Vendor Credit Receivable (an asset). An expense reversal follows the same rule.
7. **Accrual rule:** an accrual carries no input VAT and is owed at its net amount; settlement adds only the difference.
8. **Reports are always computed on the server**, from the company in the session, over every row (no 500-row window).

## What was fixed tonight, with the crux of each

| Symptom found | Rule that was being violated | Fix |
|---|---|---|
| Negative payable after returning goods on a part-paid bill | Return reduced the whole bill, including the part already paid | Paid part goes to Vendor Credit Receivable (`purchase_returns.bill_reduction`) |
| Inventory in the books differing from quantity x average cost after receipts at changing cost, restocks, or negative stock | Valuation changes were not all posted | One helper (`settleInventoryValuation`) called from every stock-moving flow; valuation in whole cents; goods in transit counted as stock |
| Past-date inventory wrong when costs varied | As-at view used today's average cost | Past-date inventory = current valuation minus ledger inventory lines after the date |
| Validation errors returned as 500 instead of 400 (transfer, duplicate posting) | Errors a user can cause must be 400 | Corrected |
| Close Month dialog showed figures that disagreed with what gets archived (revenue 345 instead of 0 after a credit note, expenses 230 instead of 200) | Numbers people act on must come from the server, not from a screen's own sum | Dialog now reads `GET /api/reports/month-pnl`, the very function that writes the archived P&L; the lock button waits until it has loaded |
| Paid-basis month P&L showed revenue -150 for an unpaid invoice that was credited | A credit note reverses its original; it can only take back revenue that original contributed | Credit note reduces the paid view only when its original was paid |

Test added for the last two: `tests/monthPnlPreview.test.ts`.

## How it was tested

* **Real screens (browser pane, no API for creating documents), company "UX Night Co" on the developer clock:** product, goods receipt, purchase bill (dated), bill payment, sales invoice, credit note against it (same period), expense (paid), **close October via the dialog**, open November, **Reverse the closed-month expense** (reversal dated 3 Nov, October untouched), **vendor return of a part-paid bill** (unpaid part reduced, payables 685 = bill balance), **generate and file the Q4 VAT return** (sales 0, purchases 1,900, input VAT 285, equals the Balance Sheet). After generating, creating an expense and cancelling the invoice were both refused with a clear message. Consistency check clean after every step; October's archived profit (-200) matches the server figure; Balance Sheet check 0.
* **Seeded day-by-day simulation** (`tests/periodFuzz.test.ts`): random but valid business every day (sales with several lines, discounts, typed and service lines, two stock items, POS and partial returns, quotations, collections, credit notes, cancels, expenses, capex, accruals, GRNs, bills, payments, vendor returns, stock adjustments, transfers, month closes, VAT generate and file), all 18 rules checked after every operation. **50 seeds x 112 days passed with no failures and no warnings**, plus the earlier 8 seeds x 84 days and 6 widened seeds.
* Hand-checked scenario test (`tests/periodStory.test.ts`) and the focused rule tests listed in the commits.

The 18 consistency rules: books balance (Balance Sheet, Trial Balance); bank, receivables, payables, customer and vendor statements agree with the balance sheet; inventory equals stock valuation; revenue and VAT equal their registers; profit agrees; stock register equals on-hand; closed months and filed returns unchanged; the balance sheet balances at every earlier month end; journal vs documents (warning).

## Not changed on purpose, for you to decide

1. **Bulk save and edit-by-id: removed.** `POST /api/migrate` and its three admin buttons are gone, and `POST /invoices` and `POST /expenses` now only create: any request naming an `id` is refused with a 400 (the server assigns ids, including line-item ids). `tests/noBulkSave.test.ts` proves a posted invoice or expense can't be overwritten or taken over through them. Checked on screen: invoice, cancel, credit note, expense and expense cancel all still work.
2. **Business day vs wall-clock time.** The server's business day is UTC. For a user in Saudi Arabia (UTC+3) between midnight and 03:00 local time, "today" on the wall clock is already the next day, but the server still treats the previous day as today and refuses the later date as being in the future. Nothing wrong is stored, but a user can be refused for a date that is correct on their clock. (In the on-screen run the form's default date also differed from the server date, but that was only because I held the server on a developer clock.) A decision on the business timezone is needed before this can be fixed properly.
3. **Vendor refund and apply-credit have no screen** (the routes exist and are tested). Vendor Credit Receivable shows on the Balance Sheet but can only be cleared by API today.
4. **Older ledger data** (documents created before the ledger existed) is not back-filled; the journal-vs-documents rule is a warning for that reason.
5. Bills can be dated any day inside the open month (not only today), by design.

## What you need to do

* Review and push: `git push` (nine commits).
* On production: deploy with `bash deploy/release.sh` and run `npm run db:push`. **Two new columns**, both additive and nullable/defaulted: `expenses.reversal_of_expense_id`, `purchase_returns.bill_reduction`. Read the printed plan before it applies; it may also list unrelated drift.
* The SharpSurv data from the earlier API-driven cycle is indicative only; re-verify it after the deploy.

## Re-running the checks yourself

```bash
npm run lint
npm run check:isolation
npx vitest run tests/periodFuzz.test.ts
npx vitest run tests/monthPnlPreview.test.ts
```

(The dev server must be running first; the fuzz and story tests need `ALLOW_DEV_CLOCK=1`, i.e. the `erp-dev-clock` launch configuration.)
