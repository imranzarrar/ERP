# Platform architecture: how the whole system works

This chapter describes what is common to every module, older and new: how a request is scoped to a company, how permissions and row-level security work, how documents are written and reported, how e-invoicing fits in, and how changes are made safely. The list of modules, with their endpoints, tables, screens and tests, is the [module catalogue](annex-h-module-catalogue.md) (annex H). The finance core (General Ledger, Receivables, Payables, Bank) is specified in the requirements and design chapters; everything below applies to it as well.

## 1. Shape of the system

* **One application, two halves.** A Node/Express server (`server.ts`, routes in `server/routes/*.ts`, shared logic in `server/lib/`) and a React client (`src/`) bundled by Vite and served by the same process (port 3000 in development; 3001 for the 2.0 checkout).
* **One database.** PostgreSQL through the Drizzle ORM. `src/db/schema.ts` is the single source of truth for tables; changes are applied with `npm run db:push` (there are no migration files). Two things `db:push` does not carry, and which have their own scripts: check constraints and row-level-security predicates.
* **Two tracks.** Live (1.0, branch `master`) takes fixes only; the Demo (2.0, branch `v2`) takes all new development, including the finance core. See the Environments chapter.

## 2. Multi-tenancy: every request belongs to one company

* Every business table carries a `companyId`. The company of a request, `req.targetCompanyId`, is resolved once per request in the authentication middleware (`isAuthenticated` in `server.ts`) from the signed-in user's own company; only a super-administrator may override it explicitly.
* A route reads the company **only** from `req.targetCompanyId`, never from a query string or body. A reference to another record (a customer id on an invoice) is checked to belong to the caller's company before it is used.
* **Row-level security is the second wall.** Every table has a Postgres policy, and request handlers run on a restricted database role (`erp_app_tenant`) whose connection is told the company (`app.company_id`) at the start of the request (`withTenantDb`, `tenantDb()` in `server/lib/tenantDb.ts`). A route that forgets a company filter then still cannot see another company's rows. A few platform-administration routes (companies, role templates, onboarding, sessions, ZATCA configuration) deliberately use the unrestricted connection because they act across companies; each says why in a comment.
* `npm run check:isolation` is a static check that fails when a route uses a client-supplied foreign key without checking ownership. It is run after every change to a route file.

## 3. Authentication and sessions

Sign-in creates a server-side session (`express-session`, stored in Postgres). Automated tests use the documented alternative of an `x-session-id` header. Passwords are hashed; password reset and company onboarding use emailed links. A super-administrator can list and end sessions.

## 4. Permissions

* A user holds roles; the user's permissions are the union of every role, per permission. There is no per-user override on top of roles.
* Permissions are defined once, in `src/permissionSchema.ts`, as modules with create / read / update / delete leaves (and a few action leaves such as approving, closing a month or transferring between banks). The same registry builds the role editor and the server checks, through `normalizePermissions`. Administrators bypass the granular checks.
* **Two separate layers.** The permission says whether the person may attempt the action at all; the state of the record says whether it can be touched now (a cancelled record cannot be edited; a cleared e-invoice cannot be edited or cancelled; a converted quotation is final). A route needs both.
* There is no hard delete of a financial record: documents are cancelled (or reversed), master data is made inactive.

## 5. How data is read and written

* **Writes go through real routes.** Each document type has its own endpoint that applies the business rules (numbering, totals, VAT, period rules) inside one database transaction. There is no bulk "save everything" endpoint, deliberately: it once overwrote posted documents with no period check.
* **The state endpoint is for browsing only.** `GET /api/state` returns the recent rows (capped) so list screens load quickly. **Figures are never added up from it.**
* **Every report, dashboard figure and list total is computed on the server**, for the active company, with no row cap (`server/lib/financialReports.ts`, `server/routes/reports.ts`, the ledger report engine). A client never sends a company id for a report. This rule exists because a capped list once silently dropped a tenant's older documents from its own totals.
* **Periods.** A document can be created, cancelled or reversed only while its fiscal month is open and its VAT quarter is not filed; the posting guard (`assertPostingAllowed`) adds the optional lock date and back-date window. The exact rules are in the Accounting rules, Period rule and Posting control chapters.

## 6. The ledger

Documents (invoices, credit notes, expenses, goods receipts, purchase bills, returns, receipts, vendor payments, manual journals) post to a double-entry ledger through one function, `postJournalEntry`, which resolves accounts through the company's account mapping and tags lines with customer, vendor and dimensions. What each document posts is in the Posting rules annex; how it works is in the Solution and Technical design chapters. The older document-based reports and the ledger reports are kept consistent by a shared set of facts, and a consistency check compares them.

## 7. E-invoicing (ZATCA)

* Every invoice, credit note and debit note goes through `processInvoiceZatca()`, started **after** the document's own transaction commits, never awaited by the create request. Credit and debit notes are rows in the invoices table with a document type and a reference to the original; they share the company's hash chain.
* In order: check the company's e-invoicing switch; record a `SUBMITTING` status first (so a concurrent cancel cannot see a stale status); reserve the next hash-chain position under a lock held only while building and signing; call the ZATCA clearance or reporting API; store the final status (`CLEARED`, `REPORTED`, `REJECTED`, `ERROR`).
* The signed XML is stored compressed and read back only through helper functions. Sandbox, simulation and production are separate identities per company.
* A cleared or reported invoice cannot be cancelled; a credit note is the only compliant reversal.
* Changes under `server/lib/zatca/` are verified against both the real ZATCA sandbox and ZATCA's own SDK validator (the dual-gate protocol in the ZATCA QA test plan).

## 8. Screens, language and print

* Screens are React components (one per module, listed in the catalogue). Every user-visible string goes through a translation function with English, Arabic and Urdu text held in one translation table; the interface mirrors for right-to-left languages.
* Printed documents (invoices, quotations, vouchers, statements) are drawn by one document renderer from per-company templates, with Arabic and Urdu support.

## 9. Making a change safely

1. Check which track the change belongs to; never release Live from the 2.0 checkout or the reverse.
2. Schema change: edit `schema.ts`, read what `db:push` prints before accepting it, then run the check-constraint and row-level-security scripts.
3. Route change: use the company from the request, check every foreign key, add the permission check, run `npm run check:isolation`.
4. Numbers someone will act on come from a server-side computation.
5. Tests are real HTTP requests against a running server plus direct database checks, with no mocks, and they build their own throw-away company. Run `npm run lint` and the affected tests; before a release run the whole suite.
6. New screen text is translated into Arabic and Urdu.
7. Update the documentation (the skill `update-docs-after-development`) before saying the work is done.
