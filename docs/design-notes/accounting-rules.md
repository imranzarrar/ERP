# Accounting and reporting rules

These are the rules the system must obey. Every report is derived from the documents by these rules; `GET /api/reports/consistency-check`
(`server/lib/consistencyCheck.ts`) tests them for any company at any time. **When a figure ever disagrees with another, find which rule is
violated and fix the rule's enforcement — never adjust the one figure.**

## A. Dates

* A document that carries a user-chosen date (invoice, expense, purchase bill) must be dated in an existing, open fiscal month, not in the
  future, and outside any VAT quarter whose return is generated or filed.
* Everything else is dated the day it is entered: goods receipt, stock movement, credit note, vendor return, payment, refund, reversal,
  stock adjustment, cancellation. A payment cannot be dated before the document it pays.
* The stock register files each movement under the day it physically happened.

## B. Locking

* A **closed month** locks every document dated in it. A **generated or filed VAT quarter** locks every tax document dated in it (invoice,
  credit note, expense, bill, vendor return, and their cancellations).
* A locked document is never changed, cancelled or dropped from its period. Reports for a locked period never move
  (closed months keep their stored profit; filed returns keep their figures).
* A VAT return that is only *generated* freezes its quarter until it is deleted; a filed return is permanent.

## C. Corrections

* A document that is **not locked** may be cancelled (invoice not reported to ZATCA; expense; bill; return; GRN before billing). A cancelled
  expense posts its reversal on the day of cancellation.
* A **locked** document is corrected only by a **new document dated today**, landing in the current open period and quarter:
  * sales invoice → **credit note** (its own date = issue date; the original invoice date stays on the original);
  * goods receipt / purchase bill → **return to the vendor** (reduces stock; reduces what is owed, or becomes a **vendor credit receivable** if
    the bill was already paid; VAT adjusted in the quarter of the return);
  * expense → **reversal document** (negative expense, same treatment as above);
  * money back from a vendor → **vendor refund** (clears the vendor credit).
* A corrected-by-document original is never edited or removed; the correction is a separate dated event.

## D. What each figure means

* **Revenue / COGS / expenses** are by document date, tax-exclusive. Credit notes and reversals count negative in the period they are issued.
* **Stock** is a Balance Sheet item: quantity on hand × average cost from goods receipts. A stock item sold before it is received simply carries
  cost 0 until stock arrives; a typed (non-stock) line never has a cost.
* **Accruals** are estimates: owed at their net amount, no input VAT. The real invoice that settles one claims its own VAT, in its own period,
  and adds only the difference to cost.
* **VAT** follows tax-invoice dates: output VAT = sales register, input VAT = purchase register (bills and expenses at original amounts, minus
  returns/reversals in their own periods).
* **As-at reports** (Balance Sheet / Trial Balance for an earlier date) show what was owed and held on that date.

## E. The checks (see consistencyCheck.ts)

R1 the books balance · R2 every balance ties to its register (bank, receivables, payables, inventory, VAT, profit) · R3 stock register =
quantity on hand · R4 locked periods never move · R5 the books balance at every earlier month end · R6 the journal agrees with the documents.
