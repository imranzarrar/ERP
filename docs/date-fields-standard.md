# Date fields on documents: the standard (Demo / 2.0)

Decided with the user (2026-10-15): every document table has the same core dates, named the same way, with the tier-1 ERP meaning (SAP, Oracle, Dynamics).
This file is the rule every new table follows and the map of what each existing table has.

## Naming

* A **business date** (a calendar day, no time) is `<meaning>_date`, Postgres type `date`, in the code `<meaning>Date` as a `YYYY-MM-DD` string.
* A **system moment** (set by the program, never typed) is `<meaning>_at`, type `timestamp`. Who did it is `<meaning>_by_id`.
* One name, one meaning, on every table. Never `date`, `dt`, `issued`, `txn_date` and so on.

## The core set

| Field | Meaning | Who sets it | Used for |
|---|---|---|---|
| `doc_date` | The date of the document: the date printed on it (invoice date, bill date, order date). Every document table has it. | The user (defaults to today) | Document registers, sales / purchase reports, statements, numbering periods, aging basis |
| `posting_date` | The date the ledger and the period locks use. Only on documents that post to the ledger or the stock ledger. Defaults to `doc_date`. | The system (user only where a screen offers it, e.g. manual journals) | The general ledger, every financial statement, open / closed month, VAT quarter, back-date rules |
| `created_at`, `created_by_id` | When and who entered it. Never editable. | System | Audit: shows a document dated in the past was keyed later |
| `updated_at`, `updated_by_id` | When and who last changed it. | System | Audit |

Rule of use: **financial statements and period locks read `posting_date`; operational reports read `doc_date`.** Until a back-dating policy lets them differ, the two are equal.
ZATCA: an invoice's issue date IS `doc_date`; `posting_date` of an invoice always equals it.

## Other business dates (named once, reused everywhere)

`due_date` (payment due), `payment_date` (last payment received / made), `supply_date` (tax point / date of supply), `valid_until_date` (an offer's validity),
`required_by_date` (needed by), `delivery_date` (promised delivery), `expected_arrival_date`, `value_date` (bank value date), `cut_off_date` (opening balances), `received_date` (physical receipt).
A column with no screen and no rule behind it is not added yet: each is added with the feature that needs it, under this name.

## Per table (slice 1 = the sales documents and the ledger; the rest follow in slices 2 and 3)

| Table | `doc_date` | `posting_date` | Other dates |
|---|---|---|---|
| quotations | was `date` | - (posts nothing) | `valid_until_date`, `updated_at/by` |
| invoices (incl. credit notes) | was `date` | yes | `supply_date`, `due_date`, `payment_date` (existing), `updated_at/by` |
| expenses | was `date` | yes | `due_date`, `payment_date` (existing), `updated_at/by` |
| vouchers | was `date` | yes | `value_date` |
| journal_entries (the ledger header) | new, from the source document | was `date` | |
| manual_journals | was `date` | yes (user may set it) | |
| purchase_requisitions / purchase_orders | slice 2 | - | `required_by_date` / `delivery_date` |
| goods_receipt_notes / purchase_bills / purchase_returns | slice 2 | yes | `due_date` (bills) |
| warehouse_dispatches / warehouse_receivings / physical_stock_takes | slice 3 | yes | `expected_arrival_date` |
| stock_ledger_transactions | - | was `date` (a movement ledger) | `moved_at` keeps the time for ordering |

## Migration rule

The rename is done in place by `scripts/migrate-date-fields.mjs` (idempotent, run before `db:push` by both release scripts): `ALTER TABLE ... RENAME COLUMN` plus
`TYPE date USING`, then the new columns are added and back-filled (`posting_date = doc_date`), so no row is lost and drizzle-kit never sees a drop. Tables that had a
timestamp in `date` and no `created_at` get `created_at` back-filled from it, so ordering inside a day is not lost.
