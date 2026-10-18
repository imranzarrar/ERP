# Test-case catalogue (generated)

**420 cases** across 30 modules, written so a tool can run them. Generated from `catalogue-source.mjs` by `node scripts/build-test-catalogue.mjs`; edit the source, never these files.

| Files | Use |
|---|---|
| `test-case-catalogue.csv` | Excel, TestRail, Jira Xray / Zephyr, Azure Test Plans (UTF-8 with BOM; one row per case, Given / When / Then in separate columns) |
| `test-case-catalogue.json` | scripts, dashboards, custom runners |
| `features/*.feature` | Gherkin, one Feature per module: Cucumber, Playwright-BDD, Behave, SpecFlow. Tags carry priority, type, layer and automation status (`@P1 @Negative @API @automated`) |

## Coverage today

| Module | Name | Cases | P1 | Already automated | Candidate | Manual |
|---|---|---|---|---|---|---|
| PC | Posting control and period locks | 19 | 15 | 13 | 4 | 2 |
| DT | Document date standard | 10 | 5 | 2 | 8 | 0 |
| COA | Chart of accounts and account mapping | 22 | 12 | 19 | 2 | 1 |
| JV | Manual journals and approval | 24 | 15 | 20 | 3 | 1 |
| OPN | Opening balances | 6 | 4 | 5 | 1 | 0 |
| DIM | Dimensions (branch, department, custom) | 14 | 8 | 13 | 1 | 0 |
| RPT | Ledger reports and the report designer | 23 | 13 | 21 | 2 | 0 |
| APR | Approval rules (Sprint 11) | 18 | 14 | 18 | 0 | 0 |
| AR | Receivables: invoices and credit notes | 16 | 14 | 10 | 5 | 1 |
| RCP | Customer receipts (Receive Payment) | 27 | 17 | 20 | 3 | 4 |
| AP | Payables: expenses, bills and returns | 15 | 10 | 12 | 3 | 0 |
| PAY | Vendor payments (Pay Vendor) | 11 | 8 | 8 | 1 | 2 |
| SUB | Customer and vendor subledgers | 11 | 7 | 9 | 2 | 0 |
| BNK | Bank reconciliation | 31 | 19 | 23 | 7 | 1 |
| PRT | Voucher and posting print-outs | 13 | 7 | 2 | 2 | 9 |
| XR | Document reports and statements (legacy, document-based) | 9 | 7 | 6 | 3 | 0 |
| SEC | Security, permissions and tenant isolation | 14 | 12 | 8 | 5 | 1 |
| I18N | Arabic / Urdu and right-to-left | 7 | 2 | 0 | 2 | 5 |
| NFR | Performance, concurrency and resilience | 9 | 5 | 2 | 6 | 1 |
| REL | Release and data migration | 9 | 7 | 2 | 0 | 7 |
| SAL | Sales documents (quotations, invoices, credit notes) | 12 | 9 | 12 | 0 | 0 |
| EXP | Expenses and recurring postings | 9 | 6 | 9 | 0 | 0 |
| PUR | Procurement and inventory | 18 | 17 | 18 | 0 | 0 |
| POS | Point of sale | 6 | 5 | 6 | 0 | 0 |
| ZAT | ZATCA e-invoicing | 15 | 14 | 15 | 0 | 0 |
| VAT | VAT returns and period locks | 10 | 8 | 10 | 0 | 0 |
| MST | Master data, numbering and imports | 12 | 7 | 12 | 0 | 0 |
| ORG | Tenancy, users and company administration | 18 | 12 | 18 | 0 | 0 |
| REP | Reports and dashboard (documents) | 9 | 9 | 9 | 0 | 0 |
| CFG | Document templates and translations | 3 | 0 | 3 | 0 | 0 |
| | **Total** | **420** | **288** | **325** | **60** | **35** |

* **Automated**: mapped to the existing vitest file in `tests/` that exercises it, against a real server and real Postgres (no mocks). `--check` fails if the named file does not exist. The mapping is by area, so read it as "covered by that file", not "every Then clause is asserted": when you tighten a case or automate a Candidate, put its ID in the `it(...)` title so a run traces back to the catalogue.
* **Candidate**: can be automated exactly as written, as an API test (same style as `tests/settlements.test.ts`) or a DB assertion.
* **Manual**: needs eyes (print layout, right-to-left look, drag-and-drop feel) or a human decision. Browser automation (Playwright) can cover most of them once a stable test company exists.

## How to automate with a tool

1. **API and DB scenarios (the large majority)**: they already run under vitest. To add a Candidate, copy the nearest existing test file, give the case ID in the `it('...')` title (`it('RCP-021 ...')`) and flip its `automation` field in the source to the file path.
2. **UI scenarios**: use Playwright. Log in through the UI with a throw-away company created by the same fixture helpers the vitest files use (`mkCompany`), drive the real screens, and assert on the same figures the API tests assert. The `.feature` files map one-to-one to Playwright-BDD scenarios.
3. **Load scenarios (module NFR)**: k6 or Artillery against `/api/login`, dashboard, invoice and receipt creation with the thresholds written in the case.
4. **Importing to a test-management tool**: import the CSV; the columns map to Title, Priority, Preconditions, Steps, Expected result, Automation status.

## Ground rules the cases assume

* Every scenario runs in its own throw-away company (fixture + purge in `afterAll`), never in a seeded demo company.
* Real HTTP against a running server plus direct Postgres assertions. No mocks.
* Test through the real screens or routes a user can reach; API-only data that no user could create is not a valid fixture.
