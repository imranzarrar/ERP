# Does the architecture serve the core? Stress test against manufacturing cost accounting and multiple taxation

Written 2026-10-19 at the owner's request: "align this with manufacturing domain cost accounting requirements, as well as multiple taxation requirements, to make sure the architecture serves the core."

**Agreed entries that apply** (register `agreed-decisions-register`): AG-01, AG-02, AG-04, AG-05 (follows); AG-10, AG-12, AG-13, AG-14, AG-15, AG-16 (follows); AG-11 (follows, **with a tension**, below); AG-17 (follows, widening needed); AG-30, AG-31, AG-32, AG-33 (follows); AG-71 and AG-77 (this note is the review they require). **No agreed entry is contradicted.**

**The tension.** The Blueprint (FR-WIP-01 to 08 and its entity list) describes **work orders** and **projects** as "cost objects" with their own tables and their own `accumulated_*` cost columns. AG-11 says management accounting is carried by the dimension framework and never by separate modules or ledgers. They are reconciled by the wording already proposed in the register (section J): a work order is a **process document keyed by a dimension value**; the ledger stays the single source of cost; the Blueprint's accumulated columns, if kept at all, are derived caches checked by the consistency check, never a second truth. This note assumes that wording. The owner must confirm it (decision 1).

**Method.** (1) State the architecture under test. (2) List what manufacturing cost accounting needs (tier-1 practice and IAS 2). (3) List what multiple taxation needs. (4) Walk one complete manufacturer through the architecture with numbers. (5) Record what holds, what is missing and the design adjustment. Tier-1 content is from general knowledge of SAP (product costing and controlling), Oracle (cost management), Dynamics 365 (production control and cost accounting) and IAS 2; clause-level details should be confirmed with the company's accountant.

## 1. The architecture under test

| Layer | Content | Status |
|---|---|---|
| L0 Ledger | One ledger, one posting engine, balanced entries, typed party tags, period guard | Built |
| L1 Account master | Classes, sub-classes, posting controls, tax category, currency, groups, templates, effective dating | Proposed (chart benchmark 7.1) |
| L2 Dimension framework | Unlimited types; roles (balancing, cost object, statistical driver); attributes; lifecycle; valid combinations; allocation over any type; break-down reports; budgets | Types, values, combinations, rules, filters built; the rest proposed (7.3, 7.4) |
| L3 Determination | One rule engine that returns tax codes and accounts from transaction type, party profile, item class, branch and date | Proposed (tax design, chart benchmark 7.6) |
| L4 Process modules keyed by dimension | Procurement and landed cost, production (work orders), projects, billing, budgets | Procurement built (no landed cost); the rest planned or absent |
| L5 Reports | One report engine with break-down, budget and quantity bases | Engine built; bases proposed |
| L6 Periods | Per-module status, runs with locks, year-end | Month lock built; the rest planned (Sprints 12, 13) |

## 2. What manufacturing cost accounting requires

| # | Requirement | Tier-1 and standard practice |
|---|---|---|
| M1 | **Item classes and inventory accounts by class** | Item type (raw material, semi-finished, finished, trading goods, consumables, service) with a valuation class that decides the inventory, variance, price-difference and scrap accounts |
| M2 | **Costing method per item class** | Moving average, FIFO or standard cost; standard cost with variances; actual cost by order |
| M3 | **Bill of material, routing, work centres, activity types** | Materials, operations, labour and machine hours, with a rate per hour per cost centre and activity type |
| M4 | **Work order lifecycle** | Planned, released, issued, completed, closed; cost collected from material issues, traced labour, machine time, overhead application, subcontract charges |
| M5 | **Cost centre accounting and overhead absorption** | Pools of indirect cost, absorption by rate (labour hours, machine hours, units), allocation cycles between service and production cost centres, under- and over-absorption true-up |
| M6 | **Normal capacity and abnormal waste (IAS 2)** | Fixed overhead absorbed on normal capacity; abnormal waste and idle capacity expensed, not capitalised |
| M7 | **Work in progress** | Per-order cost to date; period-end WIP valuation (order costing) or equivalent units (process costing) |
| M8 | **Completion** | Transfer from WIP to finished goods at actual or standard cost per unit; goods receipt from production |
| M9 | **Variances** | Material price and usage, labour rate and efficiency, overhead spending, volume and capacity; posted and settled to cost of sales or inventory |
| M10 | **Scrap, rework, co-products and by-products** | Scrap to a loss account, by-product credit, joint-cost allocation by net realisable value or physical units |
| M11 | **Subcontracting (job work)** | Material sent to a vendor, stock held at the vendor, processing charge added to cost |
| M12 | **Valuation and write-down** | Lower of cost and net realisable value; revaluation; landed cost into raw material cost |
| M13 | **Statistical quantities** | Hours, units, floor area as drivers, stored with the posting |
| M14 | **Period runs and controls** | Overhead run, WIP run, variance settlement, cost roll-up; previewed, approved, period-locked, audited |
| M15 | **Reports** | Cost of goods manufactured, product cost per unit, order cost versus standard, variance analysis, WIP, inventory valuation by class, margin by product |

## 3. What multiple taxation requires of a manufacturer

| # | Requirement |
|---|---|
| X1 | Several rates and supply natures in one company (standard, zero-rated, exempt, out of scope) chosen from profiles, never by hand |
| X2 | Recoverable and non-recoverable input tax; non-recoverable tax enters the cost of the item bought |
| X3 | Import of raw material: customs value, duty (with exemptions for manufacturing inputs), import VAT, several payees, foreign currency |
| X4 | Reverse charge and withholding on services bought from non-residents (engineering, licences, management fees) |
| X5 | Exports and zero-rated sales with proof; exempt sales with recovery apportionment |
| X6 | Excise on excisable goods, on release for consumption, included in the price and returned separately |
| X7 | Deemed supplies (internal consumption, free samples, gifts of finished goods) with tax and no revenue |
| X8 | Capital goods (machinery): input tax recovery and any adjustment rules |
| X9 | Several tax registrations or jurisdictions in one company (a branch in another state), with tax on transfers between registrations |
| X10 | Time of supply, advances from customers, credit and debit notes at the original rate |
| X11 | Tax-exclusive standard cost; tax lines tagged with code, direction and return box; VAT return and registers from the ledger; settlement entry |
| X12 | Effective-dated rates and rules; e-invoice category and exemption code from the same tax code |

## 4. Worked example: one manufacturer through the architecture

A manufacturer buys local and imported raw material, runs one work order, scraps some units, sells domestically and exports. Amounts in riyals. Overhead and labour are assumed to carry no VAT, to keep the example short. Every line below is posted by the engine; **the operator names only the party, the items and the work order**. The bracket shows what the engine finds on its own.

| Step | Entry | Found by the engine |
|---|---|---|
| 1 Local raw material A: 1,000 + VAT 15% | Dr Raw material 1,000; Dr VAT input 150; Cr AP (vendor) 1,150 | Domestic purchase, recoverable (tax profile and item class); inventory account by valuation class |
| 2 Import raw material B: goods 2,000, freight 50; customs value 2,050; duty 5% = 102.50; import VAT 15% on 2,152.50 = 322.88 | Dr Raw material 2,152.50 (2,000 + 50 + 102.50 landed); Dr VAT input (import) 322.88; Cr AP supplier 2,000; Cr AP forwarder 50; Cr customs authority 425.38 (102.50 + 322.88) | Foreign vendor and goods: import of goods; duty from the item's tariff rate; landed cost allocation; one payable per payee. Debits 2,475.38 = credits 2,475.38 |
| 3 Issue to work order WO-001: A 600, B 1,000 | Dr WIP 1,600; Cr Raw material 1,600 | Valuation class (raw material to WIP); tags: work order WO-001, cost centre Production |
| 4 Traced direct labour 400 | Dr WIP 400; Cr Direct labour absorbed 400 (the payroll expense is posted by payroll as an actual) | Work order tag; labour is traced, not allocated |
| 5 Overhead applied: 20 machine hours at 12.50 | Dr WIP 250; Cr Overhead applied (clearing) 250 | Absorption rule of the cost centre and activity type; statistical driver: 20 hours |
| 6 Actual factory overhead of the month 500 | Dr Factory overhead expense 500 (cost centre Production); Cr AP 500 | An ordinary bill, tagged to the cost centre |
| 7 Completion: 100 units made, 5 scrapped (abnormal) | WIP total 2,250. Dr Inventory write-off 112.50; Cr WIP 112.50. Dr Finished goods 2,137.50; Cr WIP 2,137.50 (95 units at 22.50) | Scrap rule; completion transfers actual cost to finished goods at the batch's unit cost |
| 8 Period-end overhead true-up: actual 500, applied 250 | Dr Overhead applied 250; Dr Cost of sales 250 (under-absorbed); Cr Factory overhead expense 500 | Overhead run with preview and approval; nothing is lost or double-counted |
| 9 Domestic sale 50 units at 40 + VAT 15% | Dr AR 2,300; Cr Revenue 2,000; Cr VAT output 300. Dr Cost of sales 1,125; Cr Finished goods 1,125 | Domestic standard-rated; tags: profit centre, product line, customer |
| 10 Export 40 units at 38 | Dr AR 1,520; Cr Revenue (export) 1,520; tax line of zero with zero-rated nature and reason code. Dr Cost of sales 900; Cr Finished goods 900 | Foreign customer, export item: zero-rated; e-invoice category from the tax code |
| 11 Filing the quarter | Output 300; input 150 + 322.88 = 472.88; net refund 172.88. Dr VAT output 300; Dr VAT receivable from authority 172.88; Cr VAT input 472.88 | Return from ledger tax tags; settlement entry |

Result: finished goods left 5 units at 112.50; every cost reaches cost of sales or a visible loss; the ledger tags answer "cost of work order WO-001", "margin by product line", "overhead by cost centre" and "VAT by return box" from the same lines.

## 5. Findings: what holds, what is missing

### 5.1 What the architecture already supports

* Cost collection by work order, cost centre and profit centre **is the dimension framework**: one combination per line, unlimited types, hierarchies, rules per account (a WIP account can require the work order type). No second ledger is needed (AG-10, AG-11, AG-12).
* Tracing and absorption fit the **allocation engine over any type** (AG-17 widened): traced cost is posted straight to the work order; pooled cost is allocated by a rate or driver. This is the Blueprint's single "cost distribution" primitive.
* Tax follows the **same determination engine** as accounts, so imported material, exports and non-recoverable tax cost resolve without operator input.
* Reports: break-down by dimension and the variance columns already in the report engine cover work order, cost centre and product-line statements.

### 5.2 Gaps, in order of how much they block manufacturing

| # | Gap | Design adjustment (proposal) |
|---|---|---|
| G1 | **One inventory account and one item class.** Manufacturing needs raw material, WIP, finished goods and trading goods as separate reconcilable accounts, and price-difference, variance, scrap and overhead-applied accounts | Item **valuation class** on the item master; roles per class (raw material, WIP, finished goods, variance, scrap, applied overhead, labour absorbed); the determination engine picks accounts by valuation class and movement type. Extends AG-02 and AG-04; no new module |
| G2 | **No work order, and no rule on how it relates to dimensions** | A work order is a document with a lifecycle whose creation also creates a **dimension value of a system "work order" type** (role: cost object). Every cost line carries it. Cost per work order is a ledger query. Any denormalised totals are caches under the consistency check |
| G3 | **Statistical quantities** (hours, units) are not stored with postings | **Quantity and unit of measure on ledger lines** (statistical key figures), or a statistical ledger of quantities keyed by the same dimension combination; required for rates, per-unit cost and capacity |
| G4 | **Costing method: average only** | Decide per item class: moving average for raw material; **actual cost by order** for work in progress and finished goods; **standard cost with variances** as an optional method. The variance accounts and the settlement run are part of the design from the start so that adding standard cost later is not a rewrite |
| G5 | **Overhead absorption rules** | Rate per cost centre and activity type and period, normal capacity per cost centre (IAS 2: fixed overhead on normal capacity, idle capacity and abnormal waste to expense), **allocation cycles** (service cost centres to production), preview, approval, true-up to cost of sales or variance |
| G6 | **Scrap, rework, co-products, by-products** | Basis types for the allocation engine: net realisable value and physical units; by-product credit account; scrap recovery sale as an ordinary sale with its tax class |
| G7 | **Subcontracting** | A document type and a **stock at vendor** location; the processing charge is a bill tagged to the work order; tax determination gets a transaction type for job work |
| G8 | **Period runs** | Overhead run, WIP valuation, variance settlement, cost roll-up as **runs** with preview, approval, period lock and audit, using the per-module period status of Sprint 12 |
| G9 | **Imports and landed cost** | Foreign currency, landed cost sheets, customs entry (the tax programme, Sprint 14e) are prerequisites for imported raw material cost |
| G10 | **IAS 2 controls** | Net realisable value write-down run; rule that abnormal waste and unallocated fixed overhead are expensed; consistent cost formula per item class |
| G11 | **Reports** | Cost of goods manufactured, work order cost, variance analysis, WIP and inventory valuation by class need **quantity and rate as value bases** in the report engine beside amount and budget |
| G12 | **Standards and budgets** | Standard cost per product and period and budgets by cost centre and work order use the same dimension-combination structure as other budgets |

### 5.3 Tax gaps specific to manufacturing

| # | Gap | Design adjustment (proposal) |
|---|---|---|
| T1 | Customs duty exemption for manufacturing inputs, drawback, bonded and free-zone inventory | Item tax profile carries tariff code and duty rate; vendor and company profile carry exemption certificates with validity; determination returns duty zero when a valid certificate applies |
| T2 | Non-recoverable tax must reach the cost of raw material and then the work order | The tax engine posts the non-recoverable part to the **inventory line** (already designed); the cost then flows to work in progress through the issue, as in step 3 |
| T3 | Excise on excisable goods | Excise component (Sprint 14f) with its own accounts, base rules and return; included in the selling price, not in manufacturing cost |
| T4 | Deemed supplies (internal consumption, samples, gifts of finished goods) | A **transaction type** "deemed supply" in the determination engine: tax output, no revenue, stock out at cost |
| T5 | Capital goods (machinery) | Tax category on the fixed-asset account (account master 7.1) plus recovery rules; adjustment rules to be confirmed with a tax adviser |
| T6 | Several registrations or jurisdictions | **Tax registration on the branch** (and company); determination takes the registration of the issuing branch; transfers between registrations get a transaction type; tax jurisdiction is an object in the tax design |
| T7 | Time of supply and advances | Tax point date on the document (date standard already allows it); advance receipts carry tax and are set off on the final invoice |
| T8 | Scrap and by-product sales | Their own item tax class through the same determination |
| T9 | Withholding on services from non-residents (licences, engineering) | Sprint 14d; vendor profile and service class decide the rate and treaty relief |
| T10 | Standard cost must exclude recoverable tax | Rule of the cost engine: costs are net of recoverable tax by construction, because only the non-recoverable part is posted to inventory |

## 6. Verdict on the architecture, and effect on the agreed entries

* **It serves the core, with additions.** The ledger, the dimension framework, the allocation primitive and the tax and account determination engine are the right foundation for manufacturing and multi-tax: the worked example resolved every step through them without a separate costing ledger.
* **What must be added to serve it:** valuation classes and class roles (G1), the work order as a document keyed to a dimension value (G2), quantities with postings (G3), a costing-method decision and variance design (G4), absorption with capacity and cycles (G5), and the runs (G8). None changes an agreed entry; G1 and G2 depend on the AG-11 wording.
* **Review of agreed entries (register section J) updated by this test:** AG-04 extends to valuation class and movement type; AG-05 gains a typed reference for the work order and the asset; AG-11 wording (process documents keyed by dimension values) is **required** by manufacturing, not optional; AG-12 reword stands; AG-17 widens to cycles, quantities and statistical drivers; AG-33 year-end is unaffected.
* **Sequencing consequence.** Manufacturing sits on three prerequisites that are also needed by tax: account master and valuation classes, the determination engine, and foreign currency with landed cost. Building those first serves both domains; building manufacturing first would force rework.

## 7. Proposed requirements (not registered; for decision)

| Proposed id | Content |
|---|---|
| BR-MFG-01 | Item types and valuation classes; inventory, WIP, finished goods, variance, scrap and applied-overhead accounts by class through determination |
| BR-MFG-02 | Work order document (planned, released, issued, completed, closed) creating a work-order dimension value; cost collection from issues, traced labour, subcontract charges |
| BR-MFG-03 | Statistical quantities with postings (hours, units) and activity types per cost centre |
| BR-MFG-04 | Overhead absorption: rates, normal capacity, allocation cycles, run with preview and approval, true-up |
| BR-MFG-05 | Completion to finished goods at batch unit cost; scrap and rework; co-products and by-products |
| BR-MFG-06 | Costing method per item class (average, actual by order, optional standard with variances); variance posting and settlement |
| BR-MFG-07 | Subcontracting with stock at vendor and processing charge |
| BR-MFG-08 | Period runs (overhead, WIP, variances, cost roll-up) with per-module period locks |
| BR-MFG-09 | Net realisable value write-down and IAS 2 expense rules |
| BR-MFG-10 | Manufacturing reports (cost of goods manufactured, work order cost, variance, WIP, valuation by class) with quantity and rate bases |
| BR-TAX-18 | Transaction types for deemed supply, job work and transfers between registrations; tax registration per branch |
| BR-TAX-19 | Duty exemption and drawback certificates on profiles with validity |

## 8. Decisions needed from the owner

1. **AG-11 wording:** confirm that process documents (work order, project billing, budget commitment) keyed by a dimension value are allowed, while a second ledger or a hard-coded cost object is not.
2. **Costing method for the first manufacturing release:** actual cost by order with moving-average raw material, or standard costing with variances from the start?
3. **Costing style:** order (job) costing only, or process (equivalent units) costing as well?
4. **Capacity basis:** normal capacity per cost centre required from the start (IAS 2), or a simple rate first?
5. **Which manufacturers are real:** discrete (wood, steel, assembly), process (food, chemicals) or both? Joint products and by-products matter for the second.
6. **Subcontracting and several plants or tax registrations:** needed now or later?
7. **Quantity on ledger lines versus a statistical ledger:** which storage do you prefer (the first is simpler to report; the second keeps the monetary ledger unchanged)?
8. **Order of work:** account master, valuation classes and determination first (serving tax and manufacturing), then currency and landed cost, then work orders and absorption?

## 9. Sources and confidence

* Finance Core Blueprint (`docs/reference`): FR-WIP-01 to 08, FR-LC, FR-DIM, cost distribution rules, work orders and projects entities.
* Our design notes: agreed-decisions register, chart of accounts benchmark, taxation analysis.
* IAS 2 (inventories: cost of conversion, normal capacity, abnormal waste, net realisable value) and general tier-1 practice (SAP product costing and controlling, Oracle cost management, Dynamics 365 production and cost accounting), **from general knowledge, not re-read in this session; confirm with the company's accountant before relying on specific clauses**.
* Saudi tax points in section 3 are marked in the taxation analysis as needing a tax adviser's confirmation.
