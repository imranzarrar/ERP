# Reporting rule for cancelled, reversed, returned and credited documents

Derived from the real documents (prod and test data) and the code paths that create them. Nothing here is implemented yet.

## 1. How a correction is stored today (the real data)

| Document | Original | Correction | Correction is a dated record? |
|---|---|---|---|
| Invoice | row, `date` | **Credit Note**: its own row (`documentType=CreditNote`, own `date`, `originalInvoiceId`) | **Yes** |
| POS return | row, `date` | Credit Note row (reason "POS Return") + refund voucher | **Yes** |
| Purchase return | GRN / bill | `purchase_returns` row, own `date`, `inputVatAdjustment` | **Yes** |
| Payment / collection / refund | voucher, `date` | Reversal voucher, own `date`, `reversalOfVoucherId` | **Yes** |
| Accrual -> real invoice | accrual expense | settling expense row (`originAccrualId`) | **Yes** |
| Vendor refund | Receipt voucher | Reversal voucher | **Yes** |
| **Cancel invoice** | row | `status = 'Cancelled'` on the SAME row | **No** (only a refund voucher, if it was paid) |
| **Cancel expense** | row | `status = 'Cancelled'` | **No** |
| **Cancel bill / reverse GRN / cancel return** | row | `status = 'Cancelled'` / `isReversed` | **No** |

(Checked on the data: cancelled invoices carry no cancellation date field of any kind; the only dated trace of a cancel is the ledger's reversal
entry, and a refund voucher when money was paid.)

## 2. The one inconsistency behind every "closed month changed" defect

Credit notes, returns, payments, refunds and settlements are **events**: the original stays in its own period and the correction lands in the period
it happened. A **cancel** is the opposite: reports remove the document from its own period by looking at its status, as if it had never existed.
So a cancel done today silently rewrites an earlier — possibly closed, possibly filed — period. Every patch so far (month guards, "reverse today",
as-at corrections) was working around this single fact.

## 3. The rule

**Every reported amount is the sum of dated events. A document contributes its original at its own date. A correction contributes a separate,
opposite event at the date it happened. A status flag is never used to remove a document from a period it already belonged to.**

Consequences, per report:

* **P&L / Trial Balance / Balance Sheet / month close**: original in its period, reversal in the period of the cancel/credit/return. A closed
  month never changes; its stored profit is the ledger profit of that month.
* **VAT registers / returns**: tax follows tax-invoice dates. A cancel/credit/return reduces VAT in the period it is issued, never in the original
  (possibly filed) quarter. A document of an unfiled quarter cancelled before that quarter is filed may simply drop out of it.
* **Outstanding / ageing / statements as at a date**: owed = original events up to the date minus correction and payment events up to the date.
* **Stock**: each movement at the day it physically happened (already the case).
* **Cash**: vouchers by date (already event-based).

Corrections may only be posted in the current open period; a document of a closed period can be corrected only by a new dated event (credit note,
return, supplier credit) — never by a status flip.

## 4. What the rule needs that does not exist yet

Only the **cancel event** lacks a date. Two ways to give it one (not exclusive):

1. **Read the ledger** for P&L / Trial Balance / Balance Sheet / month close. It already holds each original and each reversal with its date, and
   matched the document reports on every account at the end of the full lifecycle scenario.
2. **Record `cancelledAt` on the cancellable documents** (invoices, expenses, bills, returns, GRN reversal): one nullable date column, set when the
   cancel happens, back-filled for existing cancelled rows from their reversal entry. Needed so the (document-based, by law) VAT registers can place
   the correction in the right quarter.

## 5. Decision needed

Approve the rule in section 3, and approach 1 + 2. Then reports are changed once, to the rule, instead of per defect.
