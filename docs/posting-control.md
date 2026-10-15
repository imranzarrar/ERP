# Posting control: the lock date and back-dating rules (Demo / 2.0)

Built 2026-10-15 after the question "what is the rule for back-dating, and what do tier-1 ERPs do". Tier-1 systems (SAP posting periods, Oracle GL calendar, Dynamics ledger calendar)
do not count "days back"; they control back-dating with **period status, authorisation and audit**. This is that, on top of what the system already had (open / closed fiscal
month, VAT quarter freeze, ZATCA no-edit rule).

## The rules, in the order they are checked (`server/lib/postingGuard.ts`, one function for every route)

1. **Fiscal month**: the posting date must be in an existing, open month, not a future month. (Unchanged.)
2. **VAT quarter**: a tax document may not be dated in a generated or filed quarter; any other posting may not be dated in a filed quarter. (Unchanged.)
3. **Lock date** (`posting_policies.lock_date`): nothing may be dated on or before it, except by someone holding **postingControl.overrideLock**.
4. **Back-date window** (`max_back_days`): nothing may be dated more than N days before today, except by someone holding **postingControl.backDate**. 0 = dated today or later.
5. **Reason** (`reason_after_days`): a posting older than N days must carry a reason (`backDateReason` in the request; a manual journal keeps it on the journal so the approver does not retype it).
6. A posting that used an override, or that carries a reason, is written to the audit log as **BACKDATED_POSTING** (route, posting date, days back, reason, which override).

With no policy row (a company that never opens the screen) only rules 1 and 2 apply, exactly as before. The administrator holds every right.

## What is covered

Every route that posts something dated, or reverses something at its own date, calls the guard: invoices (create, credit note, cancel, quotation conversion, payment), POS returns, expenses (create, pay, reverse,
cancel, recurring and accrual settlement), purchase bills (create, pay, cancel), purchase returns and cancellations, GRN reversal, vendor refunds (and their cancellation), stock adjustments and stock-take
finalisation, inter-bank transfers, investor contributions, opening balances (post and reverse), and manual journals (at submit **and again at approval**). A quotation posts nothing, so it keeps the open-month rule only.

The date the rules judge is the **posting date**. A manual journal may have a posting date apart from its document date: a journal dated in a locked period but posted today is allowed; the reverse is refused.

## Permissions (Roles screen, General Ledger group "Posting Control")

`read` (see the screen), `update` (change the policy), `backDate` (post beyond the window), `overrideLock` (post on or before the lock date). Everyone signed in can read the policy, so forms can ask for a reason.

## Not built yet (from the tier-1 comparison, the next step of period control)

* a **restricted** month status between Open and Closed that only named users can post into, and the **adjustment period** after year-end (`fiscal_months.is_adjustment_period`, Blueprint FR-YEC);
* per-module close (AR, AP, inventory, GL closing on their own dates);
* an approval route for a back-dated posting above an amount (Blueprint FR-APR).

## Tests

`tests/postingControl.test.ts` (8): policy permissions and validation, no policy = no change, the window and its override with audit, the same rule on expenses and journals, the lock date including the cancellation of an old invoice, the reason
rule from draft to approval, and a posting date apart from the document date.
