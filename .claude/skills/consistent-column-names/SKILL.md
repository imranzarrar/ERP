---
name: consistent-column-names
description: Use whenever you add or change a database table or column (src/db/schema.ts), a JSON field a route returns or accepts, or a TypeScript property for stored data. One concept, one name, on every table, in the database, the API and the code. Covers dates (doc_date, posting_date, due_date, created_at ...), audit fields, party / account / branch references, amounts and flags. Read docs/date-fields-standard.md first for dates.
---

# Consistent column names (this ERP)

The user's standing rule (2026-10-15): **the same thing is called the same name on every table.** A reader, a report author or a test tool must be able to guess a column without opening the schema. Before adding any column, find out whether the concept already exists under a name, and reuse that name exactly. If a better name is needed, rename it everywhere in one coordinated change; never run two names for one concept.

## The rules

1. **Database**: lowercase `snake_case`, letters, digits and underscores only. No spaces, no camelCase, no abbreviations a stranger could not read. **Code and JSON**: the same name in `camelCase` (`posting_date` / `postingDate`). The pair never differs in meaning or spelling beyond the case convention.
2. **Dates** (full rule and table map: `docs/date-fields-standard.md`):
   * a calendar day is `<meaning>_date`, Postgres `date`, a `'YYYY-MM-DD'` string in code (`businessDate()` in schema.ts);
   * a system moment is `<meaning>_at`, `timestamp`; who did it is `<meaning>_by_id`;
   * every document table has **`doc_date`** (the date of the document; operational reports read it); a document that posts to the ledger or the stock ledger also has **`posting_date`** (financial statements and every period / back-date lock read it, default = `doc_date`); every table has `created_at` / `created_by_id`, editable ones `updated_at` / `updated_by_id`;
   * other dates keep one name each: `due_date`, `payment_date`, `supply_date`, `valid_until_date`, `required_by_date`, `delivery_date`, `expected_arrival_date`, `value_date`, `cut_off_date`, `received_date`. Never `date`, `dt`, `txn_date`, `issued_on` ...
3. **References** end in `_id` and use the referenced concept's name: `company_id`, `branch_id`, `customer_id`, `vendor_id`, `account_id`, `bank_id`, `warehouse_id`, `product_id`, `user_id`-style roles as `<role>_by_id` (`created_by_id`, `approved_by_id`). The same referenced thing is never `cust_id` on one table and `customer_id` on another.
4. **Numbers**: a document's own number is `<doc>_number` (`invoice_number`, `expense_number`), a party's external reference `<what>_number`. Amounts are `amount` (a single total) or `<meaning>_amount` (`tax_amount`, `paid_amount`); percentages `<meaning>_percentage`; quantities `quantity` / `<meaning>_quantity`. State columns are `status`; yes/no columns read as a statement: `is_active`, `is_default`, `is_cancelled`.
5. **Same meaning, same type, everywhere**: a business date is never `text` on one table and `timestamp` on another; money is always the same `decimal`; ids always `uuid`.
6. **Do not rename a working column casually.** A rename is a migration: `ALTER TABLE ... RENAME COLUMN` in an idempotent pre-step script run before `db:push` (so drizzle-kit never drops the column), the schema file, every query, route, screen and test, in one change that `tsc` and the test suite then verify. Use the pattern of `scripts/migrate-date-fields.mjs`.
7. **Raw SQL** uses the database names; Drizzle code uses the camelCase property. After a rename, grep raw SQL strings too (`tsc` cannot see inside them): `\be\.date\b`, `"date"`, `ORDER BY ... date`.

## Checklist before you finish a schema change

* Did I search `src/db/schema.ts` for the concept first (a name for it may already exist)?
* Names: snake_case in the database, the same word in camelCase in code; suffixes `_id`, `_date`, `_at`, `_number`, `_amount`, `_percentage` used correctly?
* New document table: `doc_date`, `created_at`, `created_by_id` (+ `posting_date` if it posts, `updated_at` / `updated_by_id` if editable) present, and an index on `(company_id, doc_date)`?
* Added to the table map in `docs/date-fields-standard.md` if it is a date?
* Any API field that mirrors the column uses the same name (no `date` for `doc_date` in a payload a screen reads)?
