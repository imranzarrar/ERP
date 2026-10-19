# A domain-neutral GL core: structural readiness for retail, trading, manufacturing, real estate and any other domain

Written 2026-10-19 on the owner's instruction: *"I did not ask you to proceed for work orders development, but the GL structure should be capable of handling all such scenarios if and when needed, order costing also. We need a flexible structure capable of doing all possible scenarios from domains like retail, real estate, manufacturing, trade."*

**This note proposes no domain module.** It answers one question: *is the GL core structured so that any domain's scenarios can be added later, as modules, without redesigning the core?* Nothing here is a request to build work orders, projects, leases or anything else. Domain modules are built only when the owner asks.

**Agreed entries that apply** (register `agreed-decisions-register`): AG-01, AG-02, AG-04, AG-05 (follows); AG-10, AG-11, AG-12 to AG-17 (follows; AG-11 and AG-12 have proposed wording changes); AG-71 and AG-77 (this note is the review they require). **Contradicts none.** The owner statement above is recorded as **AG-18**.

**Confidence.** The primitives and domain scenarios come from general knowledge of tier-1 ERPs (SAP, Oracle, Dynamics 365, NetSuite) and IFRS (IAS 2, 16, 23, 40; IFRS 15, 16); they were not re-read against the standards in this session, and the illustrative traces are teaching examples, not accounting advice.

## 1. The principle

A flexible finance core is made of a small number of **general primitives** that every domain reuses, plus **domain modules** that sit on top and use only those primitives. The core never learns the words *work order*, *lease*, *unit*, *shift* or *store*. If a domain needs a new table, it is a domain table; if it needs a new *kind* of ledger information, that is a missing primitive and must be added to the core once, for everyone.

The test of a domain-neutral core: **a new domain can be added by registering object types, dimension types, accounting events, determination rules, recognition schedules and runs, without changing the posting engine or the ledger tables.**

## 2. The primitives the core must offer

| # | Primitive | What it is | Where we stand |
|---|---|---|---|
| P1 | **Account master** | Classification, posting controls, tax category, currency, groups, effective dating | Basic; enrichment proposed (chart benchmark 7.1) |
| P2 | **Dimension framework** | Unlimited types with hierarchies, rules per account; roles, attributes, lifecycle, valid combinations, balancing | Types, values, combinations, rules, filters built; the rest proposed |
| P3 | **Typed business-object references** | A line can reference any registered business object (party, item, asset, project, order, property, unit, contract, lease, fund) by a typed, validated key | Customer and vendor only; **a generic mechanism is missing** |
| P4 | **Quantities and statistical values on lines** | Units, hours, area, occupancy stored with the posting, in a unit of measure | **Absent** |
| P5 | **Determination engine** | Rules that return accounts, tax codes and dimension defaults from a context (transaction type, party, item class, branch, date and **any registered attribute**) | Fixed roles plus party, bank and category defaults; the rule engine is proposed |
| P6 | **Allocation and distribution engine** | Moves cost or revenue between dimension values by any basis (fixed, revenue, quantity, statistical driver), with cycles and preview | Planned for branch and cost centre only |
| P7 | **Accounting events** | A document raises an event; rules turn the event into balanced lines with a preview and re-derivation (subledger accounting) | **Absent**: documents call the posting engine directly |
| P8 | **Runs** | Periodic processing with preview, approval, posting, period lock and audit | Ad hoc (recurring postings); a general mechanism is planned in part (periods) |
| P9 | **Recognition schedules** | A schedule that releases an amount over time or by progress (deferred income, prepaid cost, depreciation, lease income, percentage of completion) | **Absent** |
| P10 | **Currencies and parallel ledgers** | Transaction, functional and reporting currency; several ledgers for different accounting bases | **Absent** |
| P11 | **Period model per module** | Calendar, status per module, adjustment periods, year-end | Month lock; the rest planned |
| P12 | **Report value bases** | Amount, quantity, rate, budget, statistical; break-down by any dimension | Amount, variance, percent; the rest proposed |
| P13 | **Extensible attributes** | Configurable fields on dimension values and on registered objects, without schema change | **Absent** |
| P14 | **Lifecycle and workflow** | One state model for documents and objects with approval | Approvals for four document types; other documents ad hoc |

## 3. What is structural (decide now) and what is domain (decide when asked)

The primitives differ enormously in **retrofit cost**. Structural primitives change what a ledger line is, so they must be designed before more documents are built on the current shape; domain content can wait.

| Group | Primitives | Why |
|---|---|---|
| **Decide now (cheap today, very costly later)** | P3 typed references, P4 quantities, P10 currencies and ledgers, P7 accounting events, P9 recognition schedules | They change the shape of a line, an entry or a document-to-ledger path |
| **Decide soon (moderate)** | P1 account master, P2 dimension capabilities, P5 determination, P6 allocation, P13 attributes | They are additions to existing tables and engines |
| **Decide when a domain is asked for** | P8 runs (beyond the general mechanism), P11 per-module periods, P12 bases, P14 lifecycle, **all domain modules** | They follow the structural choices |

"Decide now" means *decide the design*, not necessarily build it: a design that reserves the shape (for example a nullable quantity and unit on a ledger line, a typed-reference table, an event layer in front of the posting engine) costs little and avoids a rewrite.

## 4. The domain extension contract

A domain module (retail, trade, manufacturing, real estate, contracting, services, fund accounting) is allowed to touch the core in **six ways only**:

1. **Register object types** (for example work order, property, unit, lease, project, fund) with their lifecycle and attributes (P3, P13, P14).
2. **Register dimension types** whose values mirror those objects (P2).
3. **Define accounting events** and their line rules, with account roles and dimension and tax context (P7, P5).
4. **Seed determination rules** and a **chart and dimension template** for the domain (P5, P1).
5. **Define schedules and runs** (recognition, absorption, depreciation, allocation) (P9, P8, P6).
6. **Add permissions, screens, reports and translations** in the usual way.

A domain module **never** adds ledger tables, a second posting path, a separate balance, or a report engine. Everything it posts goes through the one engine (AG-01) with its dimension tags (AG-10). This is the AG-11 wording the owner is asked to confirm.

## 5. Do the domains fit? Scenario by primitive

A mark means the scenario **needs** the primitive. Every scenario is expressible with the same fourteen primitives; none needs a primitive outside the list. (Illustrative, not exhaustive.)

| Domain and scenario | P1 | P2 | P3 | P4 | P5 | P6 | P7 | P8 | P9 | P10 | P12 | P13 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Retail**: sales by store and channel, returns, tender clearing, gift cards, loyalty deferral | x | x | x | x | x | | x | x | x | | x | |
| **Trading**: import with landed cost and customs, letters of credit, consignment, commissions | x | x | x | x | x | x | x | | | x | | x |
| **Manufacturing, order costing**: cost per order, absorbed overhead, scrap, variances | x | x | x | x | x | x | x | x | | | x | x |
| **Manufacturing, process costing**: cost per process and period, equivalent units, joint and by-products | x | x | | x | x | x | x | x | | | x | |
| **Manufacturing, standard costing**: standards, variances, revaluation | x | x | x | x | x | | x | x | | | x | |
| **Real estate development**: land and development cost by phase and unit, off-plan sales over time, instalments, escrow, retention | x | x | x | x | x | x | x | x | x | | x | x |
| **Real estate leasing**: lease schedule, straight-lined rent, deposits, service-charge recovery by area, VAT by use | x | x | x | x | x | x | x | x | x | | x | x |
| **Contracting and projects**: percentage of completion, milestones, retention, advances, claims | x | x | x | | x | x | x | x | x | | x | x |
| **Services**: time and material, prepaid and deferred services, utilisation | x | x | x | x | x | | x | | x | | x | |
| **Fund accounting (non-profit, waqf)**: balances per fund, restrictions | x | x | x | | x | x | | | | | x | |
| **Multi-entity or multi-country**: several books, currencies, taxes | x | x | | | x | | x | x | | x | x | |

Reading: the **most used** primitives are P1, P2, P3, P5, P7; the ones the current core lacks that appear in almost every row are **P3 (typed references), P4 (quantities), P7 (accounting events), P9 (recognition schedules), P10 (currencies and ledgers)**: that is the structural list in section 3.

## 6. Three illustrative traces (no domain table in the core)

**Order costing (manufacturing).** A work order is an object type with a dimension type of the same name. Material issue, traced labour and applied overhead are accounting events that debit work in progress with the work-order value as a tag; completion moves the cost to finished goods; scrap goes to a loss account. Cost per order is a ledger query by that tag; hours are quantities on the lines (P4); absorption is the allocation engine (P6) run as a run (P8). *Core change needed: P3, P4, P7 only.*

**Off-plan unit sale (real estate development).** A property, a phase and a unit are object types with dimension values. The customer's contract creates a receivable schedule and a **contract liability**; revenue is released over time by a recognition schedule keyed to the unit (P9) or at handover, per the accounting policy. Instalments settle through the normal receipt mechanism. Land and development cost sit in work in progress tagged by phase and are allocated to units by sellable area (a statistical driver, P4, P6). Escrow is a bank account flagged restricted (P1). *Core change needed: P3, P4, P9, P1.*

**Rental of an investment property (real estate leasing).** A lease is an object with a schedule of rent; invoices and straight-line income are schedule outputs (P9); the deposit is a liability tagged to the tenant and unit; service charges are recovered by area (P6); VAT depends on use (commercial standard-rated, residential exempt) through the item and unit tax class (P5). *Core change needed: P3, P9, P5.*

In all three the posting engine, the ledger lines, the report engine and the dimension framework are the same; only objects, events, rules and schedules differ.

## 7. Verdict on the current core

* **Sound and flexible:** one engine, balanced entries, the unlimited dimension framework with rules per account, typed party tags, the report engine, the posting guard. These are the right foundations (AG-01, AG-10 to AG-16).
* **Not yet domain-neutral:** a ledger line can only reference a customer or a vendor; it carries no quantity; documents post straight to the engine with no event layer; there is no schedule engine; there is one currency and one ledger. These five are the structural gaps (P3, P4, P7, P9, P10). They are small to reserve now and expensive to add after more documents and tables depend on the current shape.
* **Not a gap:** work orders, leases, projects, units, funds and the like. They are domain modules to be built when asked, on the primitives above.

## 8. What not to do now

* Do not build any domain module (work orders, projects, leases, units) without an explicit request.
* Do not add domain-specific columns or tables to the ledger, the dimension tables or the posting engine.
* Do not build the manufacturing, tax or real estate features proposed in other notes ahead of the structural primitives they depend on; the proposals in those notes are **illustrations of what the structure must permit**, not a build plan.

## 9. Decisions needed from the owner (structural only)

1. **Typed references (P3):** one generic mechanism for referencing any registered object from a ledger line, replacing one column per subledger. Agree the direction?
2. **Quantities (P4):** quantity and unit of measure on ledger lines, or a statistical ledger keyed by the same dimension combination?
3. **Accounting events (P7):** introduce an event layer between documents and the posting engine (preview, re-derivation, rules per event, parallel ledgers later), or keep direct posting? This also underlies currency and tax determination.
4. **Recognition schedules (P9):** one schedule engine for deferred income, prepaid cost, depreciation, lease income and progress-based recognition?
5. **Currency and ledgers (P10):** decide the design now (functional and reporting currency, one or several ledgers), even if building is later.
6. **AG-11 wording:** confirm that domain modules may own documents and lifecycle keyed by dimension values, while a second ledger or a hard-coded cost object is forbidden.
7. **Order:** which of P3, P4, P7, P9, P10 is designed first (they interact; P7 and P10 first is the safest sequence).

## 10. Sources

* Our code and register as of 2026-10-19; Finance Core Blueprint (`docs/reference`); the chart of accounts benchmark, the taxation analysis and the manufacturing and tax alignment note.
* Tier-1 practice and IFRS: general knowledge, to be confirmed by the company's accountant.
