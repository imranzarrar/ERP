# Agreed decisions register (finance core and the way we work)

**Purpose.** One list of what the owner and the team have *agreed*, so that no new analysis, design or build contradicts it, and so that nothing agreed is forgotten when the work moves to another area. It exists because a benchmark written on 2026-10-19 proposed separate profit-centre and project modules, which contradicted the agreed design that dimensions are unlimited and flexible. The correction is recorded here as AG-11.

**Rules for using it.**

1. **Read it all before working on the chart of accounts, dimensions, posting, account determination, tax, budgeting, costing, periods, reports or any finance design.** Start the work by listing the entries that apply (AG numbers) and say whether the new work follows each one.
2. **A new proposal that conflicts with an entry must say so in its first paragraph** and ask the owner; it may not quietly replace it.
3. **Entries marked "owner-stated" are the owner's words or explicit instructions and outrank any document.**
4. **After any decision, add or change the entry in the same session** (with date and source). Proposals that are not yet agreed go in the last section, not above.
5. The skill `.claude/skills/agreed-decisions/SKILL.md` and `CLAUDE.md` make this binding for every session.
6. **Agreed does not mean frozen:** compare the applicable entries with tier-1 practice and the professional checklist (sections J and K) and propose changes (AG-77).

Status: **Built** (in the code), **Planned** (agreed, in the sprint plan), **Standing** (a way of working).

## A. Ledger, chart of accounts and posting

| ID | Agreed | Source | Status |
|---|---|---|---|
| AG-01 | **One ledger, one engine.** Every statement is a query over posted journal lines; no second calculation | CFO decision 1 (`gl-step1-5-decisions`) | Built |
| AG-02 | **Company-owned chart** with 16 posting roles that documents use; re-pointing a role is not retroactive | Solution design D1 | Built |
| AG-03 | **Control accounts** by subledger type; only their own documents post to them; several per type are allowed; customers and vendors may name their own control account | D2; posting profiles decision | Built |
| AG-04 | **Documents name who and what, never accounts.** One resolution step inside the posting engine, driven by a posting context (party, item, branch, bank, category), finds accounts and dimension tags. Owner-stated: "select a party or item in any transaction and the rules apply automatically" | Posting profiles decision; owner 2026-10-14 | Built for parties, banks, categories; extended in planned tax and account-determination work |
| AG-05 | **Typed party tags** (customer, vendor) on ledger lines, set by the engine; the control account equals the sum of its parties, proved by a consistency rule | D3 | Built |
| AG-06 | Bilingual (English and Arabic) account names; Excel import and export of the chart with a preview; an account's type cannot change once it has postings, and an account in use cannot be deactivated | BR-COA | Built |
| AG-07 | A posting is balanced (debits equal credits) enforced on the server for every entry | Blueprint integrity rule | Built |

## B. Dimensions (flexible by design)

| ID | Agreed | Source | Status |
|---|---|---|---|
| AG-10 | **Dimensions are unlimited and configurable.** A company defines any number of dimension types (Branch and Department are seeded); each is combinable on any ledger line; values form hierarchies. They are the single mechanism for **budgeting, costing, control and profit and loss** by any analytical view. Owner-stated, reaffirmed 2026-10-19 | Blueprint FR-DIM-01; owner | Built (types, values, combinations, rules, filters) |
| AG-11 | **Management accounting is delivered as capabilities of the dimension framework, never as separate hard-coded modules or ledgers.** Profit centre, cost centre, project, product line, region and channel are dimension types. Budget, balancing, attributes, lifecycle, allocation and break-down reports are added to the framework so any type can use them. (Correction recorded 2026-10-19 after the chart-of-accounts benchmark proposed separate objects.) | Owner 2026-10-19 | Standing; capabilities Planned |
| AG-12 | Dimensions are **analytical, not a second ledger**: they never change an account balance; a balance sheet filtered by a dimension is shown as partial | CFO decision 5 | Built |
| AG-13 | Storage: a deduplicated **dimension combination id** per line; typed entries with real foreign keys and composite company keys; branch has one meaning (the entry's branch unless the combination names one) | Architect decisions 2 to 4 | Built |
| AG-14 | **Rules per account**: a dimension is required, optional or not allowed for an account, with an optional default. Manual journals enforce Required; documents apply defaults and enforce Required only once their forms collect dimensions | CFO decision 8 | Built for journals; documents Planned (Sprint 16) |
| AG-15 | Default tags are filled in this priority: line, document, customer or vendor default, bank default, account default | BR-DIM-04 | Built |
| AG-16 | One shared query layer (`resolvedLines`) applies the dimension filter to the ledger, journal listing and every report | Architect decision 5 | Built |
| AG-17 | Cost allocation runs redistribute shared cost by fixed or revenue percentage, net zero, into an allocated-overhead account, with contribution margin and fully loaded subtotals | BR-DIM-07, BR-DIM-08 | Planned (Sprint 15); widening to any dimension type proposed, not yet agreed |
| AG-18 | **The GL core is domain-neutral and flexible**: its structure must be able to carry the scenarios of any domain (retail, trading, manufacturing including order costing, real estate, contracting, services, fund accounting) **if and when asked**, without redesign. Domain modules are built only on request and use the core's general primitives; the core holds no domain-specific tables. Analysis is not a request to build. Owner-stated 2026-10-19 | Owner | Standing; structural readiness reviewed in `domain-neutral-core` |
| AG-19 | **Tax is a layered structure built on tax profiles.** Tax profiles are attached to customers, vendors, items and the company; the system determines the tax treatment and the accounts from the profiles and the transaction type; the data entry operator selects neither the tax nor any account; the structure is flexible for every scenario (retail, trading, imports, manufacturing, real estate) and follows the best financial standards. Owner-stated 2026-10-19. The **direction** is agreed; the detailed design (`taxation-analysis`) is a proposal awaiting the decisions in its section 10. Today's single VAT output and input accounts are an interim state | Owner | Direction agreed (Standing); design Planned (Sprints 14 to 14f); interim behaviour Built |

## C. Reports

| ID | Agreed | Source | Status |
|---|---|---|---|
| AG-20 | **One report-definition engine**; the standard statements are editable, cloneable definitions; no second calculation | D5; architect decision 6 | Built |
| AG-21 | **Integrity is shown on the page**: the balance sheet says whether assets equal liabilities plus equity; the trial balance says whether debits equal credits; an account that no row covers is listed as "Not in this definition" | CFO decision 3 | Built |
| AG-22 | No account can be selected by two rows of one definition (no double counting) | CFO decision 4 | Built |
| AG-23 | Every figure drills to the ledger with the same account set, period, dimension filter and basis | Architect decision 9 | Built |
| AG-24 | **Ledger reports and document-based reports run side by side** until a gated cut-over; *Ledger vs Documents* proves they agree | D13; CFO decision 2 | Built |
| AG-25 | **Every report, KPI and total is computed on the server**, scoped by the request's company, with no row cap; never summed from the capped state endpoint | Standing rule | Standing |
| AG-26 | Layout design, dimension setup and viewing are separate permissions; every change to a definition, dimension or rule is audited; posted figures never change because a definition changed | CFO decision 7 | Built |

## D. Dates, periods and control of posting

| ID | Agreed | Source | Status |
|---|---|---|---|
| AG-30 | Every document has a **document date** and a **posting date**; business dates are named `<meaning>_date` and are real dates; system moments are `<meaning>_at`; one concept has one name everywhere | Date-fields standard; owner | Built |
| AG-31 | **The posting guard is one function** (lock date, back-date window, reason, permission overrides, audit); every dated posting goes through it | D7 | Built |
| AG-32 | Cancel, reverse and return only while the document's fiscal month is open and its VAT quarter is not filed | Period rule note | Built |
| AG-33 | Year-end close: one closing entry into retained earnings; a closed year is never reopened; later corrections are disclosed prior-period adjustments | Blueprint FR-CLOSE | Planned (Sprint 13) |

## E. Documents, settlements and bank

| ID | Agreed | Source | Status |
|---|---|---|---|
| AG-40 | A settlement is **one voucher, one entry and N allocation rows**; the remainder stays on account | D8 | Built |
| AG-41 | `settlementFacts` is the only translator between allocations and per-document payments for the older reports | D9 | Built |
| AG-42 | Bank fees and interest are a voucher **and** an entry, limited to expense and income accounts; the reconciliation lock is enforced in the reversal function | D10, D11 | Built |
| AG-43 | Documents print from one server-resolved posting payload | D12 | Built |
| AG-44 | Credit and debit notes are rows of the invoices table sharing one hash chain; a cleared invoice can only be reversed by a credit note | ZATCA decisions | Built |
| AG-45 | No hard delete of a financial record: documents are cancelled or reversed, master data is made inactive | Permission model | Standing |
| AG-46 | No bulk "save everything" endpoint; every document is written through its own route with period rules | `noBulkSave` decision | Standing |

## F. Approvals

| ID | Agreed | Source | Status |
|---|---|---|---|
| AG-50 | Maker-checker for manual journals first; amount-threshold rules layered on top (a matching rule replaces the single step) | D14 | Built |
| AG-51 | An approval request holds the **intent** of a document, never a half-posted document; the document is created by its own executor at the last approval; a shortcut cannot bypass a rule | D15, D16 | Built |
| AG-52 | Approvers by role, named user, permission or manager of the submitter; delegation with dates in version 1 (all level types); escalation later; notifications in the system only; one company setting decides self-approval | Sprint 11 owner decisions | Built (escalation Planned) |

## G. Tenancy, security and environments

| ID | Agreed | Source | Status |
|---|---|---|---|
| AG-60 | Every business table carries a company; the company of a request comes only from the authenticated request; every table has a row-level-security policy; company-scoped links use composite keys | Platform architecture | Standing |
| AG-61 | Permissions are the union of the user's roles, with create / read / update / delete and a few action leaves; record state is checked separately | Permission model | Standing |
| AG-62 | **Live (1.0) takes fixes only; all new development is on the 2.0 branch and Demo**; nothing from 2.0 reaches Live until the owner decides | Environments | Standing |

## H. The way we work

| ID | Agreed | Source | Status |
|---|---|---|---|
| AG-70 | **Architecture first, no patches**: stop, recall memory and the analysis documents, map the code, design one integrated solution, build complete slices (schema, row-level security, engine, routes, permissions, screens, translations, tests, docs) | Owner; skill `architecture-first` | Standing |
| AG-71 | **Tier-1 depth is the standard**: before designing or building in any finance area, benchmark it against SAP, Oracle, Dynamics and NetSuite (built, partial, absent; structural consequence) and check the foundation list (currency, ledgers, accounting rules, periods, lifecycle, determination from profiles, audit, localisation). The Blueprint is not the ceiling. Owner 2026-10-19 | Owner | Standing |
| AG-72 | Tests are mandatory: real HTTP requests and real database checks, no mocks, scenarios driven through the real screens | Owner | Standing |
| AG-73 | Every new user-visible text is translated into Arabic and Urdu | Owner | Standing |
| AG-74 | After any development, update every document of the set (skill `update-docs-after-development`); "all means all" | Owner | Standing |
| AG-75 | Do not repeat passwords or secrets; test documents on production only in the designated company; no destructive action without the owner's decision | Owner | Standing |
| AG-76 | The Demo schema or release step that needs an owner's confirmation is confirmed by the owner, not automated | 2026-10-18 | Standing |
| AG-77 | **Agreed decisions are reviewed, not frozen.** Each applicable entry is compared with tier-1 practice and professional accounting guidelines (IFRS, internal control, local law) whenever the area is worked on; the review proposes changes (section J) and the owner decides. A review never silently changes an entry. Owner 2026-10-19 | Owner | Standing |

## I. Proposals awaiting a decision (not agreed; do not build)

| Proposal | Where | Needs from the owner |
|---|---|---|
| Tax engine **details** (the direction is agreed, AG-19): tax codes, profiles, determination rules, recovery, reverse charge, withholding, imports, Sprints 14 to 14f | `taxation-analysis` and the sprint plan | The nine decisions in its section 10 |
| Account master enrichment, chart templates, chart views, effective dating | `coa-tier1-benchmark` sections 7.1, 7.2 | Order, business models, statutory standard |
| Dimension framework capabilities (roles, attributes, lifecycle, valid combinations, balancing, break-down reports) and budgeting on dimension combinations | `coa-tier1-benchmark` sections 7.3, 7.4 | Whether to build, and the order |
| Foreign currency and parallel ledgers | `coa-tier1-benchmark` section 7.5 | Whether they are in the programme, before the above are frozen |
| Account determination rules (one mechanism for tax and accounts) | both notes | Agreement to treat as one engine |
| Structural readiness of the core for any domain: typed references, quantities on lines, accounting events, recognition schedules, currency and ledgers | `domain-neutral-core` | The seven decisions in its section 9 |
| Manufacturing cost accounting as an **illustration** of what the structure must permit (not a build request) | `manufacturing-and-tax-alignment` | Nothing now; domain choices when a module is requested |

## J. Professional review of the agreed decisions (tier-1 practice and accounting guidelines)

Agreed does not mean frozen (AG-77). Each agreed entry is compared with how tier-1 systems work and with professional accounting practice, and the result is one of: **Confirmed** (consistent), **Refine** (keep, with an addition), **Challenge** (the wording or the substance may be wrong and needs a decision). Nothing below changes an entry until the owner agrees; the suggestions are the proposals. This review is professional judgement from general knowledge of SAP, Oracle, Dynamics 365, NetSuite and the IFRS framework; the standards were not re-read in this session, so specific clauses should be confirmed by the company's accountant.

| AG | Verdict | Comparison and suggested change |
|---|---|---|
| 01 One ledger, one engine | Confirmed | SAP's universal journal and Dynamics 365's general ledger work this way. **Refine:** add the capability for parallel ledgers (local standard, IFRS, tax or zakat books) and a subledger accounting layer (Oracle) so the same document can produce more than one accounting view; keep one engine. |
| 02 Posting roles | Refine | Tier-1 systems find accounts by role **and** by item or product class, party class, branch and transaction type (SAP account determination, Oracle subledger accounting rules). Suggest: roles remain the default, with determination rules on top (the same mechanism as tax determination). Non-retroactive mapping is correct practice. |
| 03 Control accounts | Confirmed | Matches reconciliation accounts in SAP and control accounts in Oracle and D365. **Refine:** allow a controlled, audited manual adjustment to a control account that still carries the party tag (provisions, write-offs), instead of refusing every manual posting. |
| 04 Documents name who and what | Confirmed | This is exactly tier-1 account determination. Extend it to item class and transaction type (see AG-02). |
| 05 Typed party tags | Refine | Add the other subledger references tier-1 systems carry: item (inventory), employee, fixed asset, project, tax code. One typed-reference mechanism, not one column per subledger. |
| 06 Chart handling | Refine | Add "blocked for posting" separate from inactive, effective dating, approval of chart changes, and the account attributes in the chart benchmark (class, cash-flow class, tax category, currency). |
| 07 Balanced entries | Refine | Keep. Add: for a balancing dimension type, the entry must balance per value (inter-unit clearing), as Oracle's balancing segment and SAP's profit-centre accounting do. |
| 10 Dimensions unlimited | Confirmed | D365 financial dimensions are the closest model; Oracle and SAP have fixed segment sets, so ours is more flexible. **Refine:** "unlimited" needs a stated performance envelope (combinations, report scans) measured with a large data set. |
| 11 Management accounting as dimension capabilities | Confirmed, with a wording refinement | D365 runs projects and cost centres on dimensions too; SAP and Oracle use dedicated structures. The agreed principle (no separate ledger) is sound. **Refine the wording:** processes that need documents (project billing, work in progress, revenue recognition, budget commitments) are process modules **keyed by a dimension value**, and are allowed; what is forbidden is a second ledger or a hard-coded object that bypasses the framework. |
| 12 Dimensions are analytical | **Challenge** | True for the account total, but profit-centre accounting in SAP and balancing segments in Oracle produce a **balance sheet and profit and loss per unit**. Suggest rewording: "A dimension never changes an account's total. A type flagged balancing must also balance per value." |
| 13 Combination storage | Confirmed | Deduplicated combinations are what D365 does. Test filtering at scale. |
| 14 Rules per account | Refine | Tier-1 also has conditional rules (required for certain document types, origins or amounts; D365 advanced rule structures). Suggest as a later extension. |
| 15 Default priority | Confirmed | |
| 16 Shared query layer | Confirmed | |
| 17 Allocations | Refine | SAP assessments and distributions, Oracle allocations and D365 allocation rules support several bases including statistical drivers and any dimension. Widen as proposed (BR-DIM-07). |
| 20 One report engine | Refine | Add report versions and comparatives under governance, consolidation, statutory formats and a machine-readable export (XBRL-ready) where required. |
| 21 Integrity on the page | Confirmed | A strong internal-control feature; keep. |
| 22 No double counting | Refine | Presentation standards (IAS 1) forbid offsetting and require splitting an account by balance side in some statements (an overdrawn bank is a liability). Add a "split by balance sign" row type so a rule against double counting does not prevent correct presentation. |
| 23 Drill-down | Confirmed | |
| 24 Side-by-side reports | Confirmed, needs an end date | Tier-1 practice is one source. Keep the gate, but set a decision date and criteria for the cut-over so two sets of figures do not live indefinitely. |
| 25 Server-side figures | Confirmed | |
| 26 Permissions and audit | Refine | Add segregation-of-duties conflict rules (for example create and approve a vendor payment, create vendor and change its bank account), field-level and period-based rights, and change history on master data (internal-control frameworks such as COSO, SOX-style controls). |
| 30 Dates | Refine | Add the dates the tax and currency work needs: tax point (time of supply), value date, exchange-rate date. The standard already allows them. |
| 31 Posting guard | Confirmed | Tier-1 has period status per module (general ledger, receivables, payables, inventory) and adjustment periods; planned in Sprint 12. |
| 32 Cancel only in open periods | Confirmed | Consistent with IAS 8: no retrospective rewriting of closed periods; correction by a later reversing entry. |
| 33 Year-end close | Refine | Tier-1 systems differ: SAP carries balances forward without posting closing entries to profit and loss accounts; Dynamics posts closing transactions. Either is acceptable. Decide which one, and make sure year-to-date reports and carried-forward balances are consistent with the choice. Keep the rule that a closed year is not reopened. |
| 40 Settlement model | Confirmed | Same as SAP clearing and Dynamics settlement. **Refine:** add payment terms, early-payment discounts, write-off and tolerance handling, payment runs. |
| 41 to 43 | Confirmed | Internal consistency rules; nothing to change. |
| 44 Credit and debit notes | Confirmed | Required by the e-invoicing regulation. |
| 45 No hard delete | Confirmed | Audit-trail requirement. **Refine:** add a retention and anonymisation policy for personal data in master records (data-protection law), without breaking financial history. |
| 46 No bulk save | Confirmed | |
| 50 to 52 Approvals | Refine | Add approval of master-data changes (vendor bank account, credit limit, tax profile), parallel and conditional approval, and approval by account or cost object. Escalation is already planned. |
| 60 Tenancy | Confirmed | |
| 61 Permissions | Refine | See AG-26. |
| 70 to 76 Ways of working | Confirmed | AG-71 is extended by AG-77. |

**Net result of the review.** One entry should change in wording (AG-12) and one in scope (AG-11); the rest stand with additions. The additions cluster on the same foundations as before: an accounting-rules layer, parallel ledgers, currency, per-module periods, segregation of duties and master-data governance.


### J2. Stress test against manufacturing cost accounting and multiple taxation (2026-10-19)

The design note *Does the architecture serve the core?* walked a manufacturer through the architecture. Result for the agreed entries: **none is contradicted; four need extension and one needs the owner's confirmation.**

| AG | Effect of the stress test |
|---|---|
| 04 | Extend determination to item valuation class and movement type (raw material, work in progress, finished goods, scrap, variance accounts) |
| 05 | Add typed references for the work order and the asset |
| 11 | **Confirmation needed.** Manufacturing requires a work order document keyed to a dimension value; the refined wording (process documents keyed by dimension values are allowed; a second ledger or a hard-coded cost object is not) is required, not optional |
| 17 | Widen allocation to cycles between cost centres, quantity drivers, normal-capacity rules and net-realisable-value bases |
| 12 | The proposed rewording (a balancing type must also balance per value) stands |

Prerequisites shared by manufacturing and tax, in the order that serves both: account master and valuation classes, then the determination engine, then foreign currency and landed cost, then work orders and absorption.

## K. Professional accounting checklist (applied to new designs and to this register)

| Principle or standard | The test for our design | Where we stand |
|---|---|---|
| Double entry and completeness | Every transaction has a balanced entry; nothing posts outside the engine | Met (AG-07, AG-31) |
| Accrual and cut-off | Revenue and cost in the right period; accruals and deferrals supported | Partial: recurring accruals only; prepaid and deferred items absent |
| Immutability and audit trail | A posted entry is never edited; correction by reversal; who, what and when kept | Met for entries; master-data change history is partial |
| Authorisation and segregation of duties | Approval rules; conflicting duties separated | Approvals met; conflict rules absent |
| Sequential numbering | Statutory documents numbered without duplicates, gaps explained | Met for numbering; gap reporting absent |
| Reconciliation | Subledger equals control account; bank reconciled | Met |
| Period control | Open, closed, locked periods; adjustments disclosed | Met for months; year-end planned |
| Presentation (IAS 1, IAS 7) | Current versus non-current, no inappropriate offsetting, cash flow statement | Partial: no sub-classes; fixed-format cash flow |
| Inventory (IAS 2) | Cost formulas, lower of cost and net realisable value, landed cost | Partial: average cost only; no write-down; landed cost planned |
| Foreign currency (IAS 21) | Functional currency, rates, revaluation, exchange differences | Absent |
| Revenue (IFRS 15) | Performance obligations, deferral, contract assets and liabilities | Absent |
| Property, plant and equipment (IAS 16), leases (IFRS 16) | Asset register, depreciation, disposal | Absent (out of scope) |
| Provisions and credit losses (IAS 37, IFRS 9) | Bad-debt provision, other provisions | Absent |
| Taxes | Indirect tax accounting, withholding, zakat and income tax feed | Partial; design proposed |
| Local law (e-invoicing, VAT, records retention) | Statutory formats and retention | Met for e-invoicing and VAT filing locks; retention policy to define |

Use this table as a checklist for every new finance design: for each row say whether the design meets it and, if not, which later sprint will.
