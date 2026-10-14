# Period rule for cancel, reversal, return and credit

1. A document can be cancelled, reversed or returned only while its own fiscal month is open and its VAT quarter is not filed. Otherwise the
   action is refused. While the period is open, treating the cancelled document as void in that period is correct, because nothing closed changes.
2. A closed month or a filed VAT quarter is never touched and never corrected afterwards.
3. A later correction is a NEW document dated today (credit note, purchase return, refund, supplier credit). It lands in the current open
   period and the current VAT quarter.
4. Cancelling an expense posts its reversal on the day of cancellation.
5. Every dated entry (bill, payment, refund, stock adjustment, cancel) must fall in an existing, open month and outside a filed quarter.

Guard: `tests/closedPeriodImmutability.test.ts` attempts every cancel, reversal, credit, return, payment, settlement and delete against a
closed, filed period; each must be refused or leave the period unchanged, and the books must stay balanced.

Considered and not adopted: a `cancelledAt` column, retroactive VAT correction of a closed quarter.

Ledger-based statements: the existing document-based reports stay the figures of record. Ledger-based statements (General Ledger Step 1.5, `docs/gl-step1-5-decisions.md`) run beside them and are cut over one at a time, as the Finance Core Blueprint's rollout step 4 prescribes, only after the two agree on every company.
