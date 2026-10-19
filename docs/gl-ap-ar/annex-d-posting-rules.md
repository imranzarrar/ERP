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


## Planned tax postings (not built: Sprints 14 to 14e)

What each scenario will post once the tax engine exists. Accounts are those of the tax code; the operator selects none of them. See the design note *Taxation and tax profiles*, section 6.3.

| Scenario | Entry | Requirement |
|---|---|---|
| Domestic standard sale | Dr receivable (customer); Cr revenue; Cr VAT output (tagged with code and return box) | BR-TAX-05 |
| Zero-rated export | Dr receivable; Cr revenue; a tagged tax line of zero amount with the zero-rated nature and reason code | BR-TAX-11 |
| Exempt sale | As above with the exempt nature; its share excluded from input-tax recovery | BR-TAX-11, BR-TAX-12 |
| Retail sale, tax-inclusive price | Dr bank or receivable; Cr revenue; Cr VAT output (tax extracted per line) | BR-TAX-10 |
| Domestic purchase, recoverable | Dr stock or expense; Dr VAT input; Cr payable (vendor) | BR-TAX-05 |
| Purchase in a non-recoverable category, or the non-recoverable share | The tax is added to the debit of the cost line; no VAT input line for that part | BR-TAX-12 |
| Import of goods (customs entry) | Dr stock (duty and clearing costs by landed-cost allocation); Dr VAT input (recoverable import VAT); Cr customs authority payable; the supplier is a separate payable in the foreign currency | BR-IMP-02, BR-IMP-03, BR-IMP-04 |
| Import of services (reverse charge) | Dr expense; Cr vendor payable (net of withholding); Cr withholding payable; Dr VAT input and Cr VAT output for the self-assessed amount | BR-TAX-14, BR-TAX-15 |
| Credit note | Mirror of the original: same code, rate and accounts | BR-TAX-05 |
| Filing a quarter | Dr VAT output; Cr VAT input; the difference to VAT payable to the authority | BR-TAX-02 |
| Payment in a foreign currency at another rate | Exchange difference to its account | BR-IMP-01 |
