# AR, AP and bank reconciliation: design against the Finance Core Blueprint (Demo / 2.0)

Written 2026-10-15 before building (architecture-first). Sources: `docs/Finance-Core-Blueprint.pdf` (FR-AR-01..03, FR-AP-01..04, FR-BANK-01..05, data model pages 21-28),
`docs/gl-step1-5-decisions.md` (posting profiles, control accounts), the code as it stands.

## What the code already has

* Invoices, credit notes, expenses and purchase bills post to the ledger through `postJournalEntry`, and since slice 1b the receivable / payable line lands on the party's control account.
* A payment is a **voucher** (Receipt / Payment / Reversal) plus a journal entry, created inline by about ten routes. A voucher points at ONE document (`reference_type`, `reference_id`).
  `invoices.amount_paid` / `payment_status` are kept by those routes.
* Customer / vendor statements, "Outstanding Aging & Balances", the customer / vendor balance on a screen: all computed from the DOCUMENTS (invoices, vouchers ...), not from the ledger.
* No bank reconciliation. No customer-tagged ledger line. No receipt applied across several invoices, no payment on account.

## What the Blueprint requires (and the gap)

| Requirement | Gap |
|---|---|
| FR-AR-01 a posted invoice / credit note posts to the AR control account **tagged with the customer** | the line is on the right account, but carries no customer: `journal_lines.customer_id / vendor_id` do not exist |
| FR-AR-03 aging and statements are **a live query over posted journal lines** on the control account, never a separate balance | they are document-based |
| FR-AR-02 / FR-AP-04 a receipt / payment applies across one or more open invoices / bills, or is held on account, through a **payment allocation record** | one voucher = one document; nothing on account |
| FR-AP-02 expenses and bills share one AP control account and vendor subledger | true for the account; the vendor tag is missing, so one vendor position cannot be read from the ledger |
| FR-BANK-01..05 reconciliation session per bank per statement period, uncleared lines, live formula, complete only when it balances, discrepancy by journal entry, completed lines locked, reopening needs permission and is audited | nothing |
| FR-JE-04 / FR-APR-01..05 approval rules per document type and amount | not built (journals have maker-checker only) |

## Decisions

1. **The subledger is the ledger.** `journal_lines` gain `customer_id` and `vendor_id` (typed, nullable, composite FK to the party within the company), set by the posting engine from the same party context that already picks the
   control account (`server/lib/postingContext.ts`): no route sets them. Existing lines are back-filled from their source document by an idempotent script. Whatever posts to a customer's receivable line carries that customer.
2. **Aging, ledger and statements are queries over those lines** (`server/lib/subledger.ts`): a party's open balance is the sum of its lines on the control account(s); aging buckets by document due date with payments and credit notes matched
   oldest-first (the balance-forward method) until the allocation record (decision 4) exists, then by explicit allocation. Both agree to the cent by construction; a consistency rule proves control account = sum of party balances + unallocated.
3. **A consistency rule per control account** joins the existing checks: the control account's ledger balance equals the sum of every party's balance, and no ledger line on a customer control account lacks a customer.
4. **Payment allocation (FR-AR-01, FR-AP-03)**: table `payment_allocations` (company, voucher, allocated-to type + id, amount, created at/by). A receipt or payment is still a voucher + journal entry; the allocation says which documents it settles.
   Every existing path that creates a Receipt / Payment voucher goes through one function (`recordPaymentAllocations`) so documents' `amount_paid` and the allocations cannot drift; a back-fill creates the allocations of history. New screens: **Receive Payment** (a customer, a bank,
   an amount, the open invoices to settle, the rest held on account) and **Pay Vendor** (the same for bills and expenses), plus **apply credit note / on-account credit** to an open invoice.
5. **Bank reconciliation exactly as FR-BANK-01..05**: `bank_reconciliations` (bank, statement date, ending balance, GL balance at reconciliation, status, completed by / at) and `bank_statement_lines` (date, description, amount, matched ledger line);
   `journal_lines` gain `bank_reconciliation_id` and `reconciled_at`. A session lists the bank account's posted, uncleared lines; statement lines are typed in or imported (CSV / Excel) and matched by amount and date (suggested, never silent);
   completion is blocked unless Book balance + outstanding deposits - outstanding payments = statement balance; a bank charge or interest is posted as a journal entry from inside the session; a completed session locks its cleared lines; reopening needs
   a permission and is audited.
6. **Voucher and posting print-outs**: the Receipt / Payment voucher print gains the posting (accounts debited and credited, with the party and the allocations); a new **Journal Voucher** print for a manual journal and for any posted ledger entry.
   Same print pipeline as every other document (templates, Arabic / RTL), no second renderer.
7. **Approval rules (FR-JE-04)** stay for a later step; the guard in `postingGuard.ts` is where an approval check would hook in.

## Build order (each step complete: schema, RLS and keys, engine, routes, permissions, screens, translations, tests, docs; deployed to the Demo)

A. party tags on ledger lines + back-fill + ledger-based customer / vendor ledger, aging and reconciliation rule (decisions 1-3)
B. payment allocation, Receive Payment / Pay Vendor, credit application (decision 4)
C. bank reconciliation (decision 5)
D. voucher and journal-voucher print-outs (decision 6)
E. the automation-ready test-case catalogue

## As built (2026-10-15): where the build differs from, or settles, the design above

* **Allocation dates.** `payment_allocations` also carries `applied_date` and `reversed_date` (business dates, not timestamps): "as at" reports must read the day the money was put against a document, not the day the row was typed. `server/lib/settlementFacts.ts` turns allocations back into the per-document vouchers the older reports expect, and is the single place that knows both shapes.
* **Money held on account** is a liability (Customer advances) or an asset (Vendor advances) in the document-based Balance Sheet and Trial Balance, and is netted into AR / AP when the ledger is compared with the documents (the ledger has one receivable and one payable account; the documents show the advance as its own line).
* **Reversal vouchers and cash direction.** One rule, `reversalIsCashOut(referenceType)` in `financialReports.ts`: a Reversal undoing a receipt (Invoice, VendorRefund, CustomerReceipt, BankInterest) is money out; undoing a payment is money in.
* **The reconciling formula** is built the standard way: statement balance + deposits in transit − payments outstanding = book balance, i.e. cleared balance = statement balance. (The Blueprint prints the two outstanding terms with the opposite signs; the arithmetic of a real bank reconciliation is the one used.)
* **Bank fee / interest** is not a free-form journal: money cannot leave a bank without a voucher in this application (every bank balance, the bank ledger and the Balance Sheet read vouchers), so the adjustment writes a voucher (`BankCharge` payment / `BankInterest` receipt) **and** the ledger entry, restricted to an expense account (charge) or an income account (interest). The bank-charge / interest figures are read from the ledger entry (as Cost of Goods Sold is) into the Profit & Loss, the month-close figure, the Trial Balance, the dashboard profit and the cash flow, so every document-based statement still balances.
* **Locking.** "A completed reconciliation locks its cleared lines" is enforced where reversal happens: `reverseAllEntriesFor` (ledger.ts) refuses to reverse an entry that has a bank line cleared by a reconciliation. The cancel of a receipt / payment / invoice payment therefore fails as a whole (its transaction rolls back), with a message naming the way out (un-clear, or reopen).
* **Print model.** Vouchers, journal vouchers and the reconciliation statement are printed from one server-resolved payload (`server/lib/postingPrint.ts`: entries with account, party and dimension labels), rendered by `DocumentRenderer` as three new internal document types that follow the viewer's language and direction.
* **Permissions** follow the Blueprint list (`bankReconciliation`: create, read, match, complete, reopen) plus one added leaf, `adjust`, because posting an entry is a different authority from ticking lines.
> Note: Blueprint ids in this document were corrected on 2026-10-15 (allocation = FR-AR-02 / FR-AP-04, aging = FR-AR-03, invoice posting = FR-AR-01). The traceable register is docs/gl-ap-ar.
