# Annex D — Posting rules catalogue

What every source document posts (Dr = debit, Cr = credit). Roles are resolved by the posting engine to the company's account (customer/vendor control account, bank's own account, expense-category account when mapped). Every entry also carries the dimension tags and the customer/vendor tag its accounts require. A reversal (cancel, credit note, return, receipt cancel) mirrors the original lines, tags and parties on the reversal date.

| Source | Voucher | Entry (Dr / Cr) | Guard date |
|---|---|---|---|
| Sales invoice | — (payment at creation: Receipt) | Dr AR (customer) grand total; Cr SALES_REVENUE net of discount; Cr VAT_OUTPUT. Stock items also: Dr COGS / Cr INVENTORY at average cost | posting date |
| Credit note | Reversal if money refunded | Mirror of the invoice lines it reverses | issue date |
| Invoice payment (later) | Receipt | Dr BANK / Cr AR (customer) | payment date |
| POS sale / return | Receipt / Reversal | As invoice / credit note | sale date |
| Expense (actual) | — (payment: Payment) | Dr DIRECT_OPEX or the category's account, net; Dr VAT_INPUT; Cr AP (vendor). Asset class: Dr FIXED_ASSETS | posting date |
| Expense payment | Payment | Dr AP (vendor) / Cr BANK | payment date |
| Goods receipt | — | Dr INVENTORY / Cr GR_IR_CLEARING at cost, no VAT | receipt date |
| Purchase bill | — | Dr GR_IR_CLEARING (+ Dr VAT_INPUT) / Cr AP (vendor) | posting date |
| Bill payment | Payment | Dr AP / Cr BANK | payment date |
| Purchase return | Reversal / Receipt as applicable | Unbilled: Dr GR_IR_CLEARING / Cr INVENTORY. Billed unpaid: Dr AP / Cr INVENTORY, Cr VAT_INPUT. Billed paid: Dr VENDOR_CREDIT_RECEIVABLE / Cr INVENTORY, Cr VAT_INPUT | return date |
| Vendor refund | Receipt (`VendorRefund`) | Dr BANK / Cr VENDOR_CREDIT_RECEIVABLE | refund date |
| **Customer receipt** (Receive Payment) | Receipt (`CustomerReceipt`, reference = customer) | Dr BANK / Cr AR (customer tag); N `payment_allocations`; remainder held on account | doc date |
| **Vendor payment** (Pay Vendor) | Payment (`VendorPayment`, reference = vendor) | Dr AP (vendor tag) / Cr BANK; allocations; remainder on account | doc date |
| Cancel receipt / payment | Reversal | Mirror entry; allocations reversed | cancel date |
| **Bank charge** (reconciliation) | Payment (`BankCharge`) | Dr expense account / Cr BANK | statement line date |
| **Bank interest** (reconciliation) | Receipt (`BankInterest`) | Dr BANK / Cr income account | statement line date |
| Inter-bank transfer | TransferOut / TransferIn | Dr BANK (to) / Cr BANK (from) | transfer date |
| Investor contribution | Receipt (`Equity`) | Dr BANK / Cr paid-in capital | date |
| Manual journal | — | As entered (no control or bank accounts) | posting date, at submit and approval |
| Opening balances | — | As entered with optional equity plug | opening date |

## Reading the document-based reports

* **Customer advances** (liability) = receipts not yet applied; **Vendor advances** (asset) = payments not yet applied.
* **Bank charges / interest** are cash movements with their P&L side read from the ledger entry.
* A cancelled customer receipt is cash **out**; a cancelled vendor payment is cash **in** (`reversalIsCashOut`).
