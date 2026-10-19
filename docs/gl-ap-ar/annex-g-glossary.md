# Annex G — Glossary

| Term | Meaning |
|---|---|
| Posting engine | `postJournalEntry`: the one function that writes ledger entries |
| Posting role | A named account purpose (AR, AP, BANK, SALES_REVENUE …) that documents use; the company maps each to an account |
| Control account | An account only its subledger may post to (customers, vendors, stock, tax, banks) |
| Subledger | The detail behind a control account: one balance per customer or vendor |
| Posting guard | `assertPostingAllowed`: period, lock date, back-date window, reason |
| Lock date | Nothing may be posted on or before it (override by permission) |
| doc_date / posting_date | Date of the document / date the ledger and period rules use |
| Dimension | An analytical tag (branch, department, project …) on a ledger line; never a second ledger |
| Combination | The deduplicated set of dimension tags of a line |
| Settlement | A receipt or vendor payment spread over documents |
| On account | Money received/paid not yet applied to a document |
| Allocation | One row saying how much of a settlement settles one document |
| GR/IR | Goods received, not invoiced: the clearing account between goods receipt and bill |
| Reconciliation session | One bank, one statement date, in progress or completed |
| Deposits in transit | Money booked as received, not yet on the bank statement |
| Payments outstanding | Money booked as paid, not yet on the bank statement |
| Maker-checker | The preparer cannot approve their own journal |
| RLS | PostgreSQL row-level security: the database refuses another company's rows |
| Blueprint | `docs/reference/Finance-Core-Blueprint.pdf`, the requirements baseline |
| BR / FR / S | Business requirement / system requirement / sprint ids used in this set |
| Approval rule | An amount band for one document type with the levels that must approve it |
| Approval request | A document waiting for approval: it holds the intent of the document and posts nothing |
| Approver level | One step of a rule: a role, a user, a permission or the manager of the submitter |
| Self-approved | Approved by its own submitter under the company switch; flagged and audited |
| Tax code | The treatment a line receives: components with effective-dated rates, recoverability, accounts, e-invoice category and return boxes (planned) |
| Tax component | One kind of tax on a line: VAT, import VAT, reverse-charge VAT, withholding, excise or customs duty (planned) |
| Supply nature | Standard, zero-rated, exempt or out of scope; zero-rated keeps the right to recover input tax, exempt does not (planned) |
| Tax profile | The tax facts of a customer, vendor, item or company from which the system determines the tax code (planned) |
| Determination rule | An ordered rule matching transaction type, party class, item class, place and date to a tax code (planned) |
| Recoverable input tax | Input tax that may be set off against output tax; the rest is part of the cost (planned) |
| Reverse charge | The buyer self-assesses the tax on an import of services and, where entitled, deducts it in the same return (planned) |
| Withholding tax | Tax kept from a payment to a non-resident and paid to the authority (planned) |
| Landed cost | Freight, duty, insurance and clearing costs added to the cost of imported stock (planned) |
| Customs entry | The record of an import clearance: customs value, duty and import VAT payable to the customs authority (planned) |
