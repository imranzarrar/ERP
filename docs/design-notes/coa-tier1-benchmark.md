# Chart of accounts: benchmark against tier-1 ERPs and fit to retail, trading, manufacturing, profit-centre, budgeting and project costing

Written 2026-10-19 at the owner's request, after the owner observed that the finance core looked like "simple forms making entries". This is an analysis with a gap register and a target architecture for decision. Nothing is built or registered in the requirement set yet (section 9 proposes the entries).

**Correction on 2026-10-19 (owner):** an earlier version of this note proposed separate profit centre and project objects. That contradicted the agreed design, in which dimensions are unlimited and flexible and serve budgeting, costing, control and profit and loss. Sections 4, 6, 7.3, 7.4 and 9 were rewritten so that every management-accounting need is met by **capabilities of the dimension framework**, not by new hard-coded modules.

**Confidence.** Our side (sections 2 and 5) was read from the code and the requirement register today. The tier-1 side is general product knowledge of SAP S/4HANA, Oracle Fusion General Ledger, Microsoft Dynamics 365 Finance and NetSuite, plus the documentation pages already checked for the tax analysis; account-attribute lists were **not** re-verified against current vendor documentation in this session and should be confirmed per vendor before a feature is copied from them.

## 1. What a chart of accounts is for, in a tier-1 system

A tier-1 chart is not a list of ledger accounts. It is the **classification and control backbone** of the whole finance system:

1. **It classifies** every amount for statutory statements, management reporting, cash flow and tax (account type and sub-type, statement line, cash-flow class, nature versus function of expense).
2. **It controls posting**: which documents may post to an account, whether it needs a currency, a tax category, a cost centre or a project, whether it is blocked, whether it is a reconciliation (control) account, whether line items are open items.
3. **It is the natural-account segment of a larger structure**: with cost centres, profit centres, projects and other dimensions it forms the accounting combination that the ledger stores, and the system validates which combinations are allowed.
4. **It supports several views**: operational chart, group (consolidation) chart, country or statutory chart, each mapped to the other.
5. **It is governed**: changes are controlled, effective-dated, audited and cannot break history.
6. **It is the anchor of automation**: account determination (documents find their own accounts) and templates per industry.

## 2. Our chart today (from the code)

| Aspect | What exists |
|---|---|
| Account record | Code, English and Arabic name, **one of five types** (asset, liability, equity, revenue, expense), parent, heading flag, active flag, system role key, control flag, subledger type (customer, vendor, inventory, bank, tax, clearing, other), linked bank |
| Hierarchy | Parent and child, headings that total, up to four levels, no loops, parent of the same type |
| Numbering | Free text code, unique per company |
| Roles | 16 system roles (receivable, payable, inventory, goods-received-not-invoiced, VAT input and output, VAT payable, vendor credit, revenue, cost of sales, direct operating expense, fixed assets, paid-in capital, retained earnings, cash rounding, bank) each mapped once per company |
| Control accounts | Receivable, payable, inventory, banks, tax and clearing accounts are postable only by their own documents; a customer or vendor may name its own control account |
| Expense categories | Each expense category maps to an account |
| Dimensions | Configurable dimension types (branch and department seeded; any custom type), hierarchical values, **rules per account** (required, optional, not allowed, with default), default tags from document, party, bank and account, filters in all ledger reports |
| Starter chart | One generic chart of about 35 accounts for every company; it includes accumulated depreciation, depreciation expense and zakat payable although there is no fixed-asset or zakat module |
| Governance | Duplicate codes refused; type cannot change once postings exist; deactivation blocked with balance, role, control or children; Excel import with preview; no approval of chart changes; no effective dating |
| Statements | A report designer builds statements from account selectors; the five types are the only built-in classification |

## 3. How the tier-1 systems structure it

| Concept | SAP S/4HANA | Oracle Fusion GL | Dynamics 365 Finance | NetSuite |
|---|---|---|---|---|
| Structure of the account | Chart of accounts (operational, group, country) + G/L account with account group and company-code data; profit centre, segment, functional area, cost centre and project are **standard fields** of the universal journal | **Chart of accounts structure** of segments (balancing, natural account, cost centre, intercompany, others), each with a value set and hierarchies | **Main account** + **financial dimensions**, joined by **account structures** with rules for valid combinations | Account + **segments** (department, class, location, custom) per subsidiary |
| Classification | Account type (balance sheet, P&L; primary and secondary costs), **financial statement version** items, functional area, cash-flow relevance | Account type per natural-account value (asset, liability, equity, revenue, expense); **account hierarchies** (trees) for reporting; cash-flow assignment | Main account type and category (system categories drive reporting), posting type, **financial reporting** row definitions | Account type list (bank, receivable, other current asset, fixed asset, payable, current liability, long-term liability, equity, income, cost of goods sold, expense, other) plus cash-flow rate type |
| Posting control | **Account group** sets mandatory and hidden fields (**field status**); reconciliation account flag; open-item management; line-item display; tax category; **blocked for posting** | Allow posting, allow budgeting, reconciliation flag at value level; **cross-validation rules** for combinations | Debit or credit required, open items, account currency, default dimensions, dimension rules, blocked | Restrict by department, class, location; subsidiary restriction; revenue and inventory options |
| Several views | Operational, group and country charts with **mapping**; parallel ledgers (IFRS, local GAAP, tax) | Several ledgers with **ledger sets**, secondary ledgers and reporting currencies | Several ledgers and a **consolidation account** mapping | Subsidiaries with elimination accounts |
| Profit centre accounting | Profit centre and segment on every line; **profit centre balance sheet**; inter-profit-centre clearing | **Balancing segment** gives balanced books per profit unit; intercompany balancing | Financial dimension with **balancing** option and default dimensions | Class or department as the profit unit |
| Cost objects | Cost centres, internal orders, **WBS elements**, production orders | Cost centre segment, project accounting (PPM) | Project management and accounting with cost and revenue recognition | Projects and jobs |
| Budget | Budget and commitment (funds management, in public sector and enterprise), plan versions in controlling | **Budgetary control** with funds checks, budget by segment combination and period | **Budget control** (accounting-based), budget registers, cycles, plans | Budgets by account, dimension and period |
| Currency | Account currency, only-balances-in-local flag, revaluation key | Account type of currency, revaluation and translation | Account currency, revaluation, exchange-rate type | Rate types per account |
| Templates | Industry solutions and best-practice charts | Seeded charts per localisation | Localised charts | SuiteSuccess industry charts |
| Governance | Change documents, restricted fields once used, mass maintenance | Value set security, effectivity dates on values | Account structures with effective dates, inquiry of changes | Role permissions, no deletion once used |

The patterns that matter for us: **classification attributes on the account**, **posting controls on the account**, **a dimension model with validation of combinations**, **several views of the same ledger**, **first-class profit centre, cost object and budget**, **effective-dated governance**.

## 4. Benchmark: capability by capability

Status key: **Built**, **Partial**, **Absent**. "Retrofit cost" estimates how hard it is to add later without rewriting history (L low, M medium, H high).

| # | Capability | Tier-1 standard | Ours | Status | Retrofit |
|---|---|---|---|---|---|
| 1 | Type granularity | Sub-types (current, non-current, cash, receivable ...), statement line, cash-flow class, nature versus function of expense | Five types only; statements rely on selectors in the designer | **Partial** | L |
| 2 | Hierarchy | Several hierarchies (statutory, management) over the same accounts | One parent-child tree, four levels | **Partial** | M |
| 3 | Numbering and groups | Account groups with number ranges and defaults | Free code, no groups | **Absent** | L |
| 4 | Posting controls on the account | Required fields, blocked, auto-post only, tax category, currency, open items | Control flag and dimension rules; no block-for-posting distinct from inactive; no tax category; no currency | **Partial** | M |
| 5 | Reconciliation (control) accounts | Per subledger, automatic | Built, with per-party control accounts | **Built** | |
| 6 | Account currency and revaluation | Per account | Absent (no multi-currency) | **Absent** | H |
| 7 | Several charts or books | Operational, group, statutory with mapping; parallel ledgers | One chart per company, one ledger | **Absent** | H |
| 8 | Dimension model | Segments or dimensions with valid-combination rules | Dimensions with rules **per account**; no cross-validation between dimensions; no balancing dimension | **Partial** | M |
| 9 | Profit centre accounting | Profit centre on every line, balanced books and balance sheet per profit centre, inter-unit clearing | The **dimension framework** gives tags, hierarchy, rules per account and filters in every report. Missing in the framework: a balancing role, inter-unit clearing, break-down by value, per-value balance sheet | **Partial** | M |
| 10 | Cost objects | Cost centres, internal orders, projects with WBS, production orders | Any dimension type can serve as a cost object (cost centre is the department type). Missing in the framework: value attributes, lifecycle (status, validity dates), valid-combination rules; the allocation engine is planned for branch and cost centre only | **Partial** | M |
| 11 | Statistical accounts and units | Quantity and statistical postings | Absent | **Absent** | M |
| 12 | Budgeting | Budget versions by account × dimensions × period; checks at posting or at commitment; variance reporting | Absent; the Blueprint does not mention it. The framework fits it: budget lines can key on the existing dimension combination, and the report engine already has variance columns | **Absent** | M |
| 13 | Project accounting | Project master, tasks or WBS, cost collection, billing, WIP, revenue recognition, retention | A project can be a dimension type today (tag only). Missing: value attributes and lifecycle (framework), billing, work in progress, recognition and retention processes | **Partial** | H |
| 14 | Industry templates | Charts for retail, trading, manufacturing, services, construction | One generic chart of about 35 accounts | **Absent** | L |
| 15 | Manufacturing accounts | Raw material, WIP, finished goods, variances, absorbed overhead | One inventory control account; work in progress specified in the Blueprint, not built | **Absent** | H |
| 16 | Retail accounts | Sales by channel, discounts and returns as contra-revenue, cash over and short, shrinkage, payment-provider clearing, gift card and loyalty liabilities | Single sales revenue role; returns post through credit notes; no clearing or liability accounts for cards, vouchers, loyalty | **Partial** | M |
| 17 | Prepaid, accrued and deferred | Prepaid expense, deferred revenue, accrued income, contract assets and liabilities, with release schedules | Accrued expenses account and recurring accruals only | **Partial** | M |
| 18 | Provisions and write-offs | Bad-debt provision, inventory obsolescence, write-off reasons | Absent | **Absent** | M |
| 19 | Intercompany and elimination | Intercompany accounts and elimination | Absent | **Absent** | H |
| 20 | Year-end accounts | Closing and carry-forward through retained earnings, with controls | Opening balances built; year-end close planned (Sprint 13) | **Partial** | L |
| 21 | Statements | Statement versions with comparatives, drill-down | Report designer built | **Built** | |
| 22 | Localisation | Standard Saudi chart aligned with the statutory format, bilingual | Arabic names; chart is generic, not aligned with a standard format | **Partial** | L |
| 23 | Governance | Effective dating, change approval, usage lock, change history | Usage locks and audit; no effective dating or approval of chart changes | **Partial** | L |
| 24 | Import and mass maintenance | Import with validation, mass change | Excel import with preview | **Built** | |

**Reading the result.** The mechanics (control accounts, tags, rules per account, unlimited dimensions, designer) are sound. The gaps that are expensive later are **currency (6), several books (7), manufacturing accounts (15), intercompany (19)**, and the missing management-accounting capabilities of the dimension framework (9, 10, 12, 13). The cheap ones (classification, groups, templates, localisation, governance) should be done together as one enrichment of the account master.

## 5. Fit to business models

For each model: what the chart and dimensions must provide, what we provide, and the gap.

### 5.1 Retail

| Need | What a tier-1 retail setup has | Ours |
|---|---|---|
| Revenue by channel and category | Revenue accounts or dimensions per channel (store, online), category and brand | One sales role; branch dimension; category not a dimension |
| Discounts, returns, allowances | **Contra-revenue** accounts, so gross sales, discounts and returns show separately | Discounts reduce the invoice; returns by credit note; no contra accounts |
| Payment tenders | Cash, card, wallet and voucher **clearing accounts** reconciled to the provider settlement; provider fees | Bank per tender through the bank account; no card-clearing and fee flow |
| Cash handling | **Cash over and short** account, shift reconciliation, till float | Shift close records variance; no posting account for it |
| Stock | Inventory per warehouse and store, **shrinkage**, stock-take variance, transfer-in-transit | Inventory control account; stock moves between warehouses and stock-take variances are recorded, but none of the 16 posting roles is an in-transit or shrinkage account |
| Liabilities | Gift cards, vouchers, loyalty points, customer deposits | None |
| Store profit | Profit and loss per store, store balance sheet where used | Branch tag on lines; branch profit and loss report; no per-store balance sheet |

### 5.2 Trading (buy, import, sell)

| Need | Tier-1 setup | Ours |
|---|---|---|
| Purchasing | Goods-received-not-invoiced, price and quantity variances, purchase discounts, advances to suppliers | Goods-received-not-invoiced built; no variance, discount or advance accounts |
| Imports | Landed cost, customs, import VAT, foreign currency, exchange differences | Absent (see the tax analysis) |
| Receivables risk | Bad-debt provision, write-off, credit limits | Absent |
| Margin | Revenue and cost of sales by customer, product and branch | Revenue and cost of sales by branch and department dimensions |

### 5.3 Manufacturing

| Need | Tier-1 setup | Ours |
|---|---|---|
| Inventory classes | Raw material, work in progress, finished goods, each reconcilable | One inventory account |
| Production accounting | Production orders collect material, labour and overhead; variances (price, usage, efficiency, overhead) | Absent (no production module) |
| Overhead | Absorbed or applied overhead account, cost centre allocation | Allocation planned (Sprint 15), absorption absent |
| Standard versus actual costing | Costing method per item class | Average only |
| Scrap, by-products, subcontracting | Dedicated accounts and flows | Absent |

### 5.4 Profit-centre accounting

Tier-1 pattern: every line carries a profit centre (and, in SAP, a segment); balance sheet and profit and loss can be produced per profit centre; transfers between profit centres clear through **inter-profit-centre accounts**; shared costs are allocated by rule. Ours: a profit centre is simply a dimension type (branch or any custom type) with tags, hierarchy and report filters, and an allocation run is planned. **Missing in the dimension framework** (section 7.3): a balancing role, inter-unit clearing, value attributes (manager, status), break-down reports per value, allocation over any type.

### 5.5 Budgeting

Tier-1 pattern: budget versions (original, revised, forecast) by account (or account group) × dimensions × period; control at posting or at purchase commitment (warn or stop); commitments from requisitions and orders; variance reports (actual versus budget versus prior year). Ours: nothing built, but the dimension combination and the report engine's variance columns are the right base: a budget line keys on an account (or group) and a dimension combination, and budget becomes a value basis of the designer (section 7.4). Account classification (items 1 and 3) and a commitment concept are the missing prerequisites.

### 5.6 Project-level costing

Tier-1 pattern: a project master (customer, dates, manager, status, contract value, budget) with tasks or WBS; costs collected from purchases, expenses, timesheets, inventory issues; billing (fixed price, milestone, time and material); work in progress and revenue recognition (percentage of completion, completed contract); retention; project profitability. Ours: a custom dimension type can tag lines with a project, which is the right key. **Missing:** value attributes and lifecycle on dimension values, dimensions on documents (Sprint 16), and the processes (billing, work in progress, recognition, retention), which are documents and runs keyed by the project value, not a separate ledger.

## 6. Findings

**Structurally sound (keep):** company-owned chart with hierarchy; control accounts and per-party control accounts; typed subledger tags; dimensions with rules per account and default tags; the report designer; usage locks.

**Thin, in order of how much future development they block:**

1. **Account master has too few attributes.** With five types and a control flag only, nothing can be classified for cash flow, statutory lines, current versus non-current, nature versus function, tax category, currency or blocked status. Every later feature (tax, currency, cash-flow statement, budgeting by account group) will want these. *Low retrofit cost now, high if each feature adds its own.*
2. **The dimension framework lacks the capabilities that make a dimension useful for management accounting.** Dimensions are already unlimited and flexible (any number of types, hierarchical values, rules per account, filters in reports). What a type cannot yet do: carry attributes and a lifecycle, be a balancing unit, validate combinations with other types, break a report down by its values, be a basis of allocation beyond branch and cost centre, or key a budget. These are additions to the framework, not new modules (section 7.3).
3. **One chart, one ledger, one currency.** Foreign currency and several books are structural and must be decided before more documents are built on single-currency assumptions.
4. **No account groups and no industry templates.** Every company starts from the same generic chart; a retailer, a trader and a manufacturer need different starting structures and different automatic accounts.
5. **Role-based account lookup is flat.** One account per role per company. Tier-1 systems determine accounts by role **and** by item or product class, party class, branch and transaction type (SAP account determination, Oracle subledger accounting rules). This is the same point as the tax analysis: the document should name what and who, and rules find the accounts.
6. **Governance.** No effective dating or approval of chart changes; acceptable for small companies, not for audited ones.

## 7. Target architecture (one design, for decision)

### 7.1 Enrich the account master (one slice, low cost, unblocks everything)

| Attribute | Purpose |
|---|---|
| Account class and sub-class | Cash, bank, receivable, other current asset, non-current asset, current or non-current liability, equity, revenue (operating, other), cost of sales, operating expense, finance cost, tax, zakat; drives statutory and management statements |
| Expense nature or function | By-nature and by-function presentations of the same expense |
| Cash-flow class | Operating, investing, financing, or non-cash, for the cash flow statement |
| Statement mapping key | Link to statutory statement lines (per chart view) |
| Posting control | Blocked for posting (distinct from inactive), automatic posting only, manual journal allowed, requires dimension (already), requires currency, statistical |
| Tax category | The tax treatment of postings to the account (for example outside VAT scope), for the tax engine |
| Account group | Defaults and number ranges; chosen at creation |
| Currency | Functional only, or fixed foreign currency, or any (when currency exists) |
| Effective from and to | Lifecycle without deleting history |

### 7.2 Chart views and templates

* **Chart templates** per industry (retail, trading, manufacturing, services and projects) with their automatic accounts and dimension rules, reviewed by an accountant; a company picks one at creation and can adopt a template later by merge.
* **Chart views**: statutory (local standard and IFRS), management, group. A view is a mapping from accounts to the view's lines, so one ledger serves several statements; true parallel ledgers are a later decision (7.5).

### 7.3 Management accounting through the dimension framework (no separate modules)

**Principle, as agreed and confirmed against the code:** dimensions are unlimited and configurable. A company can define any number of dimension types; a ledger line carries one tag per type through a dimension combination; values form hierarchies; rules per account make a type required, optional or not allowed; every report row and column can filter by any type. Profit centre, cost centre, project, product line, region and channel are all **dimension types**, not special modules. Nothing in section 7 may add a hard-coded "profit centre module" or "project module" ledger.

The benchmark gap is therefore narrower and more precise than "no profit centre object": today a dimension type has **tags, hierarchy and rules, and nothing else**. The capabilities below are added to the framework itself, so that any type can use them.

| # | Capability added to the dimension framework | What it gives | Typical use |
|---|---|---|---|
| 1 | **Type roles** (flags on the type): balancing, cost object, statistical driver | Tells the engine how to treat the type | Profit centre = balancing; project and cost centre = cost object; headcount or floor area = statistical driver |
| 2 | **Value attributes**: configurable fields per type (text, number, date, status, link to customer, employee or branch) | A dimension value becomes real master data | Project: customer, dates, manager, contract value. Profit centre: manager, responsible branch |
| 3 | **Value lifecycle**: status and validity dates; posting refused outside them | Closing a project or cost centre is enforced | Project completed, cost centre retired |
| 4 | **Valid-combination rules between types**: requires, implies, default derivation | Keeps combinations meaningful | A project belongs to one profit centre, so choosing the project sets it |
| 5 | **Balancing**: for a balancing type, each journal entry nets to zero per value; the engine adds inter-unit clearing lines when it does not; balance sheet and profit and loss per value | Profit centre accounting without a separate ledger | Store or division books that balance, with transfers cleared through an inter-unit account |
| 6 | **Break-down reports**: a column or row per value of a chosen type, rolled up through the hierarchy, drill to the ledger | Profit and loss, balance sheet or cost report by any dimension in one run, no hand-built columns | Profit and loss per branch, per project, per product line |
| 7 | **Allocation engine over any type**: a rule moves cost from source values and accounts to destination values by a basis (fixed percentage, revenue, a statistical driver, another column), net zero | Overhead absorption and cost distribution | Head office cost to branches; shared service cost to projects |
| 8 | **Dimensions on every document** (Sprint 16) with Required rules enforced | Costing from sales, purchases and expenses without a journal | A purchase bill requires a project on construction material accounts |
| 9 | **Rules per account do the project accounting work**: work in progress, unbilled revenue, deferred revenue and retention accounts mark the project type as required | A project's balances are queries over the ledger, not a second ledger | Project profitability, work in progress per project |

Project **billing** (fixed price, milestone, time and material) and **revenue recognition** (percentage of completion, completed contract) are processes: documents and runs keyed by the project dimension value, posting through the normal engine. They are built after items 2, 3 and 8, and need the accounting-rules layer (the same as for tax). They are not a separate project ledger.

### 7.4 Budgeting on the same framework

* **Budget version** (original, revised, forecast) with lines of: account or account group × **dimension combination** (any subset of the company's types, stored in the existing combination structure) × fiscal period × amount, with an optional quantity.
* **Controls**: a company chooses which dimension types a control applies to (for example department plus account group, or project plus all cost accounts), and the mode (report only, warn, stop), at posting, requisition and order.
* **Commitments**: open requisitions and orders carry the same dimension combination and count against the budget until invoiced.
* **Reporting**: budget is a **value basis** of the report designer (columns today are period basis × value basis × dimension filter, with variance and percent columns already built), so budget versus actual versus prior year works for any dimension without new report code.
* **Consequence**: there is no limit on dimensions for budgeting, costing or control; the limit is only what the company configures.

### 7.5 Foundations to decide first

Foreign currency (account currency, rates, revaluation) and parallel ledgers are not features to add to the chart later; they change what an amount is. They must be decided (even if built later) before profit centre, project and budget design is frozen.

### 7.6 Account determination

Documents name party, item, branch and transaction type; **determination rules** (the same mechanism as the tax design) return the accounts, so revenue, discount, return, cost of sales, inventory, variance and clearing accounts follow the item class and the profile rather than one account per role.

## 8. How the pieces fit with the tax design

The tax design (Sprints 14 to 14f) needs exactly the account attributes in 7.1 (tax category, currency, posting control) and the determination mechanism in 7.6. They should be one engine, one sprint line, not two.

## 9. Proposed requirements, tests and sprints (not yet registered)

| Proposed requirement | Content | Proposed sprint |
|---|---|---|
| BR-COA-09 | Account classification attributes (class, sub-class, nature or function, cash-flow class, statement key) | Account master enrichment |
| BR-COA-10 | Posting controls on the account (blocked, auto-post only, currency, tax category) and account groups with defaults | Account master enrichment |
| BR-COA-11 | Industry chart templates (retail, trading, manufacturing, services) reviewed by an accountant | Account master enrichment |
| BR-COA-12 | Chart views and mapping to statutory statements (local standard, IFRS); cash-flow statement from classes | After the above |
| BR-COA-13 | Effective dating and approval of chart changes | After the above |
| BR-DIM-09 | Dimension type roles (balancing, cost object, statistical driver) | Dimension framework |
| BR-DIM-10 | Dimension value attributes and lifecycle (status, validity dates, posting refused outside them) | Dimension framework |
| BR-DIM-11 | Valid-combination rules between types, with default derivation | Dimension framework |
| BR-DIM-12 | Balancing: per-value balanced entries, inter-unit clearing, balance sheet and profit and loss per value | Dimension framework |
| BR-DIM-13 | Break-down reports by any dimension type, with roll-up and drill | Dimension framework |
| BR-DIM-07 (widen) | Allocation engine over any dimension type and basis, including statistical drivers (was branch and cost centre only) | Cost allocation (Sprint 15) |
| BR-BUD-01..04 | Budget versions on account × dimension combination × period; controls by chosen types; commitments; budget as a report value basis | Budgeting |
| BR-PRJ-01..04 | Project billing, work in progress, revenue recognition, retention as processes keyed by the project dimension | After BR-DIM-10, Sprint 16 and the accounting-rules layer |
| BR-ACC-01 | Account determination rules by item class, party class, branch and transaction type | With the tax engine |
| BR-COA-14 | Retail accounts (contra-revenue, tender clearing, cash over and short, gift card and loyalty liabilities, shrinkage) | With the templates |
| BR-COA-15 | Manufacturing accounts (raw material, WIP, finished goods, variances, absorbed overhead) | With production, after costing |

Each needs system requirements and test cases written before it is built; none is registered until the owner agrees the direction.

## 10. Decisions needed from the owner

1. **Order**: account-master enrichment and templates first (cheap, unblocks tax, currency and budgeting), then the dimension-framework capabilities (roles, attributes, balancing, break-down reports, allocation over any type) and budgeting, or the other way round?
2. **Multi-currency and parallel ledgers**: in the programme, and before the dimension-framework capabilities are frozen?
3. **Which business models are real customers' needs now**: retail, trading, manufacturing, projects? The templates and the first accounts follow that.
4. **Profit centre versus branch**: is the branch dimension type the balancing (profit-centre) type, or is profit centre a separate dimension type across branches? Either is possible in the framework; the answer sets the default company setup.
5. **Project costing depth**: cost collection and profitability only, or billing and revenue recognition (percentage of completion) as well?
6. **Budget control**: report only, warn, or stop at posting and at purchase commitment?
7. **Statutory view**: which standard (local, IFRS, both) must the chart map to, and who signs off the template charts?

## 11. Sources and confidence

* Our code and requirement register as of 2026-10-19: `server/lib/chartOfAccounts.ts`, `src/db/schema.ts` (`company_accounts`, `account_dimension_rules`, `dimension_*`), `docs/gl-ap-ar/source/brd.mjs` (areas COA, DIM, PER, RPT, and the out-of-scope list).
* Finance Core Blueprint (`docs/reference`): FR-COA, FR-DIM, FR-LC, FR-WIP, FR-FA.
* Tier-1 behaviour: general product knowledge, partly corroborated by the Oracle and Dynamics pages cited in the taxation analysis ([Oracle tax determination](https://docs.oracle.com/en/cloud/saas/financials/26c/faitx/tax-determination.html), [Dynamics 365 sales tax groups](https://learn.microsoft.com/en-au/dynamics365/finance/general-ledger/tasks/set-up-sales-tax-groups-item-sales-tax-groups)). **The attribute lists in section 3 were not re-checked against vendor documentation today; confirm before copying any detail.**
* Saudi statutory chart format and zakat presentation: not researched here; needs a local accountant.
