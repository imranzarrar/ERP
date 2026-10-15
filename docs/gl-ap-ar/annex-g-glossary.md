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
| Blueprint | `docs/Finance-Core-Blueprint.pdf`, the requirements baseline |
| BR / FR / S | Business requirement / system requirement / sprint ids used in this set |
| Approval rule | An amount band for one document type with the levels that must approve it |
| Approval request | A document waiting for approval: it holds the intent of the document and posts nothing |
| Approver level | One step of a rule: a role, a user, a permission or the manager of the submitter |
| Self-approved | Approved by its own submitter under the company switch; flagged and audited |
