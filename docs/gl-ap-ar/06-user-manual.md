# User Manual — General Ledger, Receivables, Payables and Bank (Warraq ERP 2.0)

Version 1.0 / 2026-10-15. Screens are captured from the running application with a demonstration company, *Al-Noor Trading Co* (`npx tsx scripts/capture-manual-screens.ts` regenerates them). Chapters follow the order in which an accountant works: set up once, post daily, check, reconcile, close. Requirement references (BR-…) are in the BRD (01).

**Who does what.** *Accountant* prepares and posts; *Approver / Finance manager* approves journals, reopens reconciliations, overrides locks; *Clerk* receives and pays; *Administrator* sets roles. A person's rights come from their roles (chapter 10).

---

## 1. Signing in and finding your way

![Sign in](user-manual/screens/01-sign-in.png)

Sign in with your user name and password. The first time, you may be asked to change the password.

![Dashboard](user-manual/screens/02-dashboard.png)

The left menu is the whole system. Work in this manual lives in three menu sections that follow the order of the work: **General Ledger Setup** (Chart of Accounts, Dimensions, Opening Balances, Posting Control, Approval Rules), **Accounting Operations** (My Approvals, Journals, Receivables, Payables, Bank Reconciliation) and **General Ledger Reports**. Your menu shows only what your roles allow. The top of the menu shows your company and the open fiscal month. Use **Filter menu…** to find a screen by name.

---

## 2. Setting up the books (once)

### 2.1 Chart of accounts (BR-COA-01…08)

![Chart of accounts](user-manual/screens/03-chart-of-accounts.png)

**General Ledger Setup › Chart of Accounts › Accounts.** Every company starts with a standard Saudi chart. Headings (bold) group accounts and show totals; only accounts take postings. You can:
* **New Account** (menu *New Account*): code, name, Arabic name, type, parent heading.
* Rename or recode an account. You cannot change the **type** of an account that has postings, a role or a bank.
* **Deactivate** an account only when its balance is zero; accounts that documents depend on (roles, banks, control accounts) cannot be deactivated.
* **Import / Export** to Excel: the import shows a preview and saves only the rows you tick.

*Control accounts* (receivables, payables, stock, VAT, banks) can be posted only by their documents; manual journals refuse them.

### 2.2 Account mapping (BR-COA-06)

![Account mapping](user-manual/screens/04-account-mapping.png)

**Chart of Accounts › Account Mapping.** Choose which account each posting role uses (for example *Sales revenue*, *Accounts receivable*) and which account each **expense category** posts to (rent, utilities …). A change applies to **new** postings only; history stays where it was posted.

To give one customer or vendor its own receivable/payable account or default dimensions, open the customer or vendor in **Trading Partners** and set the *Posting profile* (needs the Account Mapping permission).

### 2.3 Dimensions (BR-DIM-01…05)

![Dimension types](user-manual/screens/05-dimension-types.png)

**Dimensions** are analysis tags on ledger lines. *Branch* and *Department* exist for every company; add your own (for example *Project*). Menu order: **1 Dimension Types → 2 Dimension Values / Cost Centres → 3 Account Dimension Rules**. A rule says, per account, whether a dimension is **required**, **optional** or **not allowed**, with an optional default; apply a rule to many accounts at once after a preview. Manual journals enforce *required*; documents apply defaults.

### 2.4 Posting control (BR-PER-03…06)

![Posting control](user-manual/screens/06-posting-control.png)

**Posting Control** decides how far back anyone may post:
* **Lock date** — nothing may be dated on or before it.
* **Back-date window (days)** — nothing may be dated more than this many days before today.
* **Reason after (days)** — older entries must carry a reason.

Anyone can read the rules; changing them needs *Posting Control › update*. People holding *back-date* or *override lock* rights can go past the window or the lock, and every use is written to the audit log. The fiscal month must also be open and, for tax documents, the VAT quarter not yet filed.

### 2.5 Opening balances (BR-JNL-09)

**Opening Balances.** If you start part-way through a year, enter the opening figure of each account, **Preview** (nothing is saved), put any difference to an equity account, then **Post** once with confirmation. A wrong opening entry can be reversed with a reason and a corrected one posted.

---

## 3. Receivables: invoices and receipts

### 3.1 Invoices

Invoices and credit notes are created in **Sales & Receivables** (unchanged). Each posts to the receivable control account tagged with the customer (BR-AR-01).

### 3.2 Receive Payment (BR-AR-03, 04)

![Receive payment](user-manual/screens/07-receive-payment-blank.png)

**Receivables › Receive Payment.** Choose the **customer**, the bank to **deposit to**, the **date**, the **amount** and an optional reference (cheque or transfer number).

![Receive payment, allocated](user-manual/screens/08-receive-payment-allocated.png)

The customer's open invoices appear. Type how much goes to each, or press **Allocate oldest first**. The bar below shows *Amount*, *Applied to documents* and *Held on account*. Anything not applied stays **on account** with the customer. **Save Receipt** creates one voucher and one ledger entry. A receipt dated in a locked period, with an inactive bank, or with allocations above the amount or above what an invoice still owes, is refused with a message.

### 3.3 Receipts: list, detail, print, apply, cancel

![Receipts list](user-manual/screens/09-receipts-list.png)

**Receivables › Receipts** lists every receipt with *Amount*, *Applied to documents*, *Held on account* and status (On account / Settled / Cancelled). Filter by customer.

![Receipt detail](user-manual/screens/10-receipt-detail.png)

Click a row for the detail: party, bank, allocations. From here:
* **Print voucher** — the Receipt Voucher with settled documents and the accounting entry (below).
* **Apply to documents** — put money held on account against invoices later.
* **Cancel** — needs a reason; the entry is reversed, a reversal voucher is written and the invoices become open again. An invoice paid through a receipt cannot be cancelled until that receipt is.

![Receipt voucher print](user-manual/screens/11-receipt-voucher-print.png)

The **Receipt Voucher** shows who paid, the amount in words, where it was deposited, which invoices it settled, what is held on account, the accounting entry (bank debited, receivable credited, customer named) and signature boxes. Press **Print** in the preview.

---

## 4. Payables: expenses, bills and payments

Expenses, goods receipts and purchase bills are entered in **Procurements** (unchanged). Each posts to the payable control account tagged with the vendor (BR-AP-01…03).

![Pay vendor](user-manual/screens/12-pay-vendor-allocated.png)

**Payables › Pay Vendor** works exactly like Receive Payment, for the vendor's open **bills and expenses** together (BR-AP-05). **Payables › Vendor Payments** lists payments; a payment can be applied later or cancelled with a reason.

![Vendor payments](user-manual/screens/13-vendor-payments-list.png)

A payment kept on account is an **advance to the vendor**: it appears as an asset until it is applied.

### 4.1 Approval of large payments and bills (BR-JNL-10)

![Approval rules](user-manual/screens/33-approval-rules.png)

**General Ledger Setup › Approval Rules** (setup, once). A rule says: *vendor payments (or vendor bills) above this amount (up to an optional ceiling) need these approvers, level by level*. Each level names a **role**, a **named user**, **anyone holding a permission**, or the **manager of the submitter** (set each person's **Manager** on their user record in Settings › Users: it must be someone in the same company and cannot loop back). Lower priority numbers are checked first. A payment or bill that matches no rule posts directly, as before. A **manual journal** whose total falls inside a *Manual journal* rule is submitted as before but needs the rule's levels instead of the single approval step: each level holder approves from the journal's own screen or from My Approvals (they need not hold the journal posting right), the last approval posts it, and rejecting returns it to the preparer. A journal with no matching rule keeps the single approval step. A credit note that matches a rule (rule type *Credit note*, judged on the invoice total) waits in the same way: nothing is issued and the invoice is untouched until the last approval, and the credit note is created in the name of the person who requested it. A vendor bill that matches a rule waits in the same way (nothing is created and the goods receipt stays unbilled until the last approval). The goods-receipt option *paid at delivery* is refused when a rule would hold the bill or its payment: receive the goods, then bill and pay through the normal screens. The switch at the top decides whether the person who submits a payment may approve it themselves: **off** (recommended) means someone else must always approve; only the company owner / administrator can change it, and every use of it is marked and audited.

![Rule editor](user-manual/screens/34-approval-rule-editor.png)

*New rule* opens the editor: name, what it applies to (vendor payment, vendor bill, credit note or manual journal), the amount band, the priority, and the levels in order (a role, a named user, anyone holding a permission, or the manager of the submitter, with **Add a level**).

![Manager field on the user form](user-manual/screens/37-user-manager-field.png)

The **Manager** field sits on the user form (**Settings & Companies › Governance & Staff › Staff Permissions**, below the account email). It is what a *manager of the submitter* level looks up: pick someone from the same company, never the person themselves and never a loop.

![My approvals](user-manual/screens/35-my-approvals.png)

When a payment falls inside a rule, **Save Payment** sends it for approval and **nothing is posted**: no voucher, no ledger entry, no bank movement. **Accounting Operations › My Approvals** lists what waits for you and what you submitted.

![Approval request](user-manual/screens/36-approval-request.png)

Open a request to see who submitted it, the date, the reference, the level and the history. **Approve** moves it to the next level; the last approval creates the payment (the posting-control rules are checked again at that moment). **Reject** needs a reason and nothing is posted. The person who submitted a request can **Recall** it while it is pending (nothing was posted, so nothing is undone); to correct a payment or bill, recall it and submit a new one.

**Delegating while you are away.** At the top of My Approvals, *Delegate my approvals while I am away*: choose who takes over and the dates. For those dates they can decide whatever you could decide (role, named-user, permission and manager levels alike), and the history shows *for <your name>*. **End now** stops it early. A person cannot approve a level for a payment they submitted (unless the company switch is on) or act twice on the same request.

---

## 5. Who owes what: aging and party ledgers (BR-AR-06, 07; BR-AP-06)

![Receivables aging](user-manual/screens/14-receivables-aging.png)

**Ledger Reports › Receivables Aging** shows each customer's open charges by age (payments are set against the oldest charge first), money held **On account** in its own column, and a green line proving the customers add up to the receivable control account. Click a name to open the customer's ledger. **Export** to Excel.

![Customer ledger](user-manual/screens/15-customer-ledger.png)

**Customer Ledger** lists every posting of one customer with opening balance, running balance and the document number; click a line to open the entry.

![Payables aging](user-manual/screens/16-payables-aging.png)

**Payables Aging** and **Vendor Ledger** are the same for vendors.

---

## 6. Journals

### 6.1 Journal listing and detail (BR-JNL-08)

![Journal listing](user-manual/screens/17-journal-listing.png)

**Journals › Journal Listing** shows every posting of the company — documents and manual journals — with filters for status, period, source and text.

![Journal detail](user-manual/screens/18-journal-detail.png)

Click a row to see accounts, totals and the **approval trail**, and to **Print voucher**, **Reject** or **Approve and post** (if you may).

![Journal voucher](user-manual/screens/19-journal-voucher-print.png)

The **Journal Voucher** prints any entry: accounts, parties, dimensions, totals in words, prepared-by and approved-by. A journal that is not yet posted prints with a *NOT POSTED* banner.

### 6.2 New manual journal (BR-JNL-01…07)

![New manual journal](user-manual/screens/20-new-manual-journal.png)

**Journals › New Manual Journal.** Enter the date, description, reference and at least two lines (an account and a debit **or** a credit). Control, bank and heading accounts are not offered — they are posted by their documents. Save as a **draft**, then **submit for approval**. Dates must satisfy Posting Control; a date older than the reason threshold needs a reason.

### 6.3 Approval (maker-checker)

![Pending approval](user-manual/screens/21-pending-approval.png)

**Journals › Pending Approval** lists journals waiting for someone **other than the preparer** with the *post* right. Approving posts the journal (the date rules are checked again). Rejecting needs a written reason and returns it to draft. The company owner may allow self-approval; such journals are marked.

**Reversing** a posted journal creates a reversing draft that goes through the same approval; the original stays posted until then.

---

## 7. Financial statements (BR-RPT-01…10)

All statements are computed from the ledger on the server for your company only. Each has **Run**, **Design**, **Print**, **Excel**, optional **Dimensions** filters and comparative columns.

![Trial balance](user-manual/screens/22-trial-balance.png)

**Trial Balance (Ledger)** — opening, movement and closing for every account. A green line states that debits equal credits. Click any figure to open the **General Ledger** for exactly the accounts, period and filters behind it.

![Income statement](user-manual/screens/23-income-statement.png)

**Income Statement** — revenue, cost of sales, expenses and profit, with comparative and variance columns.

![Balance sheet](user-manual/screens/24-balance-sheet.png)

**Balance Sheet (Ledger)** — assets, liabilities and equity as at a date, with profit to date inside equity and a statement of whether assets equal liabilities plus equity.

![Cash flow](user-manual/screens/25-cash-flow.png)

**Cash Flow Statement** — indirect method, reconciled to the bank and cash accounts. **Changes in Equity** completes the set.

![Ledger vs documents](user-manual/screens/26-ledger-vs-documents.png)

**Ledger vs Documents** compares the ledger with the document-based reports account by account (money held on account is netted). Differences must read 0.00; a difference means a rule is broken and should be reported, never "adjusted".

![Report designer](user-manual/screens/27-report-designer.png)

**Report Designer** (for authorised users) copies a standard statement or builds your own: choose rows (accounts by account, parent, range, type or role; subtotals; formulas; text) and columns (period, value, dimension filter, variance), then format. Accounts that no row covers are listed with a warning so nothing is silently left out. **Reset to standard** restores a built-in one.

---

## 8. Bank reconciliation (BR-BNK-01…08)

![Bank reconciliation list](user-manual/screens/28-bank-reconciliation-list.png)

**Bank Reconciliation** lists sessions. **Start reconciliation**: choose the bank, the **statement date** and the **ending balance** printed on the statement. Only one session per bank can be in progress, and each statement date must be after the last completed one.

![Session](user-manual/screens/29-bank-reconciliation-session.png)

The session shows, left, every posted line of that bank's ledger account up to the statement date, and, right, the **statement lines**. At the top, the **formula** updates live: *statement balance + deposits in transit − payments outstanding* must equal the *book balance*, and the **Difference** must be zero.
1. Add statement lines by typing them, or **Import CSV** (columns Date, Description and Amount — or Debit and Credit; day-first dates are understood; a preview is shown; importing the same file twice adds nothing).
2. **Tick** ledger lines that appear on the statement, or **Suggest matches** (equal amount within 10 days — you accept them) and **Match to…**.

![Matched](user-manual/screens/30-bank-reconciliation-matched.png)

3. A bank **fee** or **interest** that the books do not have yet: on that statement line press **Post as bank charge** (expense account) or **Post as interest** (income account). One entry is posted, cleared and matched in one step. A mistaken one can be **Reversed** while the session is open. A session is **never** forced to balance.

![Completed](user-manual/screens/31-bank-reconciliation-completed.png)

4. **Complete** is enabled only when the difference is zero and every statement line is matched. A completed session is **locked**: a payment or receipt behind a cleared line cannot be cancelled. **Reopen** (own permission, a reason, latest completed session only) is audited.

![Reconciliation statement](user-manual/screens/32-bank-reconciliation-statement-print.png)

**Print report** produces the Bank Reconciliation Statement: balance per bank, deposits in transit, payments outstanding, adjusted balance, balance per books, difference and the outstanding lists.

---

## 9. Period routine and corrections

**Daily:** post documents; receive and pay; check *Pending Approval*.
**Weekly:** Receivables / Payables Aging; chase overdue items.
**Month end:** (1) reconcile every bank; (2) clear *Pending Approval*; (3) run Trial Balance and Balance Sheet — both must show the balanced line; (4) run *Ledger vs Documents* — all differences 0.00; (5) file VAT if due; (6) close the fiscal month in the existing period screen.

| I need to… | Do this |
|---|---|
| Undo a receipt or payment | Receipts / Vendor Payments › open it › **Cancel** with a reason |
| Correct a posted manual journal | Open it › **Reverse**; approve the reversal; post the right one |
| Correct a sales invoice already sent to ZATCA | Raise a **credit note**; invoices cleared by ZATCA cannot be cancelled |
| Correct a bank fee posted by mistake | In the open reconciliation, **Reverse** that line |
| Post into a locked period | Ask a user holding *override lock*; the use is audited |

**If the system says…**

| Message | Meaning and action |
|---|---|
| "…locked" / "…back-date window" / "…reason" | Posting Control rule: choose a later date, give a reason, or ask an authorised user |
| "…month is closed" / "…VAT quarter…" | The fiscal month or VAT quarter is closed or filed; date it in the open period |
| "…settled through receipt / payment …" | Cancel that receipt/payment first |
| "…the approval rule … applies to it" | The receipt's *paid at delivery* option would bypass an approval rule: save the receipt without it, then bill and pay normally |
| "…cleared in a bank reconciliation…" | Open the reconciliation, un-clear the line (or have it reopened), then cancel |
| "The reconciliation does not balance" | Post an entry for what is missing (fee/interest) or fix the document; never force it |
| "…control account…" | Post through the customer/vendor document, not a manual journal |

---

## 10. Roles and permissions

Set in **Settings › Roles**. Suggested bundles (each leaf is *module.leaf*; see annex C):

| Role | Typical rights |
|---|---|
| Accountant | `chartOfAccounts` read/create/update, `journals` create/read/update, `openingBalances` read/preview, reports read, `bankReconciliation` create/read/match/adjust/complete, `customerReceipts` & `vendorPayments` create/read |
| Finance manager | Accountant + `journals.post`, `journals.reverse`, `accountMapping`, `postingControl.update`, `bankReconciliation.reopen`, `customerReceipts/vendorPayments.delete` |
| Controller | Finance manager + `postingControl.backDate`, `postingControl.overrideLock`, `openingBalances.post` |
| AR / AP clerk | `customerReceipts` / `vendorPayments` create, read; aging reports |
| Approver (any level) | `approvals.read`, plus whatever the rule names (a role, a named user, a permission, or being the submitter's manager) |
| Auditor | All `read` leaves and reports; no create/update |

A person's rights are the union of their roles. Administrators hold every right. Branch-restricted users see their branches' figures only, and the screens say so.

## 11. Arabic and Urdu

Choose the language at sign-in or in your profile. Screens mirror right-to-left; vouchers, journal vouchers and reconciliation statements print right-to-left, with Arabic account names where the chart has them. Amount in words is currently printed in English.

## 12. Screen index

| Screen | Menu path | BRD |
|---|---|---|
| Chart of Accounts / New Account / Import–Export | General Ledger › Chart of Accounts | COA |
| Account Mapping | Chart of Accounts › Account Mapping | COA-06 |
| Dimension Types / Values / Cost Centres / Rules | Dimensions | DIM |
| Posting Control | General Ledger Setup › Posting Control | PER |
| Approval Rules | General Ledger Setup › Approval Rules | JNL-10 |
| My Approvals | Accounting Operations › My Approvals | JNL-10 |
| Receive Payment / Receipts | Receivables | AR-03…05 |
| Pay Vendor / Vendor Payments | Payables | AP-05 |
| Receivables Aging / Customer Ledger / Payables Aging / Vendor Ledger | Ledger Reports | AR-06, 07; AP-06 |
| Journal Listing / New Manual Journal / Pending Approval | Journals | JNL |
| General Ledger, Trial Balance, Income Statement, Balance Sheet, Cash Flow, Changes in Equity, Custom Reports, Report Designer, Ledger vs Documents | Ledger Reports | RPT |
| Bank Reconciliation | Accounting Operations › Bank Reconciliation | BNK |
| Opening Balances | General Ledger Setup › Opening Balances | JNL-09 |
