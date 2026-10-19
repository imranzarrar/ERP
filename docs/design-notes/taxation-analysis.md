# Taxation and tax profiles: analysis and design options (for decision, nothing built)

Written 2026-10-19 after the owner asked for a holistic accountant's view of taxation: how tier-1 ERPs do it, how imports, manufacturing and retail behave, how our solution measures up, and a flexible design in which **the system, not the data entry operator, decides what to post and where**. This note analyses and proposes; it does not decide. Section 10 lists the decisions needed.

Method (architecture first): the Finance Core Blueprint (FR-TAX, FR-RND, FR-LC, ERD), the existing design notes, the code as it is today, public documentation of the tier-1 products, and the Saudi (ZATCA) rules as published. Where a statement could not be checked against a primary source it is marked **[verify]**: nothing marked so should be built on before a tax adviser confirms it.

**Status of the direction (owner, 2026-10-19):** the layered tax structure built on tax profiles, with automatic determination of tax and accounts, is **agreed** (register AG-19); the detailed design below is the proposal that realises it, still open to the decisions in section 10.

**Agreed entries that apply** (register `agreed-decisions-register`): AG-02 and AG-04 (follows: the document names party and item, the engine finds accounts; the design extends this to tax), AG-05 (follows: tax code becomes a typed reference), AG-30 and AG-31 (follows: tax uses document date, posting date and the posting guard), AG-32 (follows), AG-24 (follows: the return is reconciled to documents), AG-71 and AG-77 (this note is the review they require). No agreed entry is contradicted.

## 1. What a correct tax solution must do (the accountant's test)

1. **Determine, then compute, then post, then report, then settle.** These are five separate responsibilities. Tier-1 systems keep them separate; mixing them (a rate on the document that also decides the account) is what makes a tax design rigid.
2. **The operator never chooses accounts or tax treatment.** The operator names the party and the items; the tax treatment follows from profiles and the transaction type. A manual override is possible only with a permission, a reason and an audit record.
3. **Tax is a subledger, not a balance.** Every tax line is tagged with the tax code, the jurisdiction, the direction (output, input, reverse charge, withholding), recoverability and the return box it belongs to, so the return, the registers and the ledger are the same numbers.
4. **Recoverable and non-recoverable tax are different accounting.** Recoverable input tax is an asset until set off; non-recoverable tax is part of the cost of what was bought.
5. **Rates and rules have effective dates.** A document keeps the code and the rate it was taxed with; changing the law (5% to 15% in 2020) never rewrites history.
6. **Tax follows the legal timing**, which is not always the invoice date (time of supply, advances, import clearance, reverse charge on payment or invoice).
7. **Filing is an accounting event**: the return settles the tax accounts against the authority payable (FR-TAX-02), and the period locks follow.
8. **Statutory output and the ledger agree**: the e-invoice (ZATCA) category and exemption code, the VAT return boxes and the ledger tax lines come from the same tax code.

## 2. How tier-1 ERPs do it

All of them separate "which tax applies" from "how it is calculated" from "where it posts".

| Concept | SAP (S/4HANA, ECC) | Oracle Fusion Tax | Dynamics 365 Finance | NetSuite (SuiteTax) | Odoo (SME reference) |
|---|---|---|---|---|---|
| Result of determination | **Tax code** (per country tax procedure; input or output) | **Tax rate** within a **tax status** within a **tax** within a **tax regime** | **Sales tax code**; the applicable codes are those present in both the party's group and the item's group | **Tax code** (group of tax types and agencies) | **Tax** (a record with its own accounts) |
| What drives it | Tax classification of customer / vendor / material (master data) and the condition technique; tax code can be defaulted or overridden per line | **Party tax profile** and **product fiscal classification** plus transaction attributes, through ordered **tax rules**; three levels from "defaults only" to full rule-based | **Sales tax group** (on customer, vendor, ledger account) intersected with **item sales tax group** (on item) | Nexus, item tax schedule, entity tax registrations, tax rules | **Fiscal position** (on partner) maps product taxes to other taxes and accounts |
| Recoverability | Tax code carries deductible and non-deductible parts, with accounts per process key | **Recovery rate** per tax, with its own recoverable and non-recoverable accounts | Tax code options: deductible percentage, use tax (self-assessment), exempt | Non-recoverable on the tax code | Tax repartition lines (base, tax, non-deductible) |
| Account determination | Tax code + process key (input, output, non-deductible, reverse charge) to G/L account | Tax accounts on the tax rate: tax account and recovery account | **Ledger posting groups** per tax code (sales tax payable, receivable, use tax) | Tax code to account per agency | Per tax and repartition line |
| Reverse charge / import | Tax codes with two postings (self-assessed output and input); import VAT through customs vendor | Self-assessed (reverse charge) taxes and import tax rules | Use tax and the "reverse charge" settings; charges codes for duty | Reverse charge tax codes | Reverse-charge taxes (two repartition lines) |
| Withholding | Extended withholding tax (per vendor, per withholding type, per business place) | Withholding tax codes, groups and rates | Withholding tax codes and groups on vendors | Withholding tax codes | Withholding taxes as negative taxes |
| Settlement | Tax-code-based VAT return and the tax payable clearing | Tax reporting ledger and the tax return | **Sales tax settlement period**: tax balance posts to the authority, which can be a vendor, then is paid | Tax return and payment | Tax closing entry |
| Reporting | Document-level tax data feeds statutory reports | Tax reporting ledger | Sales tax payment report, per code | Tax reports per agency and box | Tax report by repartition |

Sources checked: Oracle's [tax determination](https://docs.oracle.com/en/cloud/saas/financials/26c/faitx/tax-determination.html) and [tax rate setup](https://docs.oracle.com/en/cloud/saas/financials/24b/faitx/tax-rate-setup.html) pages (regime, status, rate, effective periods, recovery rate, rules); Microsoft's [sales tax groups and item sales tax groups](https://learn.microsoft.com/en-au/dynamics365/finance/general-ledger/tasks/set-up-sales-tax-groups-item-sales-tax-groups) (intersection of the party group and the item group; posting groups; settlement periods). The SAP, NetSuite and Odoo columns are from general product knowledge and were not re-checked in this session **[verify if any detail is relied on]**.

**The pattern worth copying:**

* *Profiles on both sides* (party and item) plus the *type of transaction*, resolved by an **ordered rule table** to a **tax code**.
* The **tax code is the unit of everything else**: rate (effective-dated), recoverability, accounts per role, e-invoice category, return box.
* **Accounts hang off the tax code**, not off the document and not off the item.
* A **settlement** step posts the period's tax against the authority.

## 3. Business scenarios and how tax behaves

(Saudi Arabia is the home jurisdiction; the design must also fit other GCC states and, later, other countries. Statements about law are summarised and marked **[verify]** where not confirmed in a primary source.)

### 3.1 Retail

* **Sale to consumers** (simplified invoice, POS): prices are usually **tax-inclusive**; the system must extract tax from the shelf price, round per line (FR-RND-01), and never change the legal total with cash rounding (FR-RND-02).
* **Mixed baskets**: standard-rated, zero-rated and exempt items on one receipt. Tax is per line; the receipt shows each category.
* **Returns and credit notes** reverse in the period of the return, with the original rate and code.
* **Stock transfers between branches** are not sales: no tax, no tax code.
* **Samples, gifts, shortages**: write-offs of stock; whether any deemed supply or input adjustment arises is a tax adviser's call **[verify]**.
* **Excise goods** (tobacco, energy and sweetened drinks) carry an excise tax in the price and on the invoice; excise is a second tax component on the same line **[verify scope]**.

### 3.2 Imports

* **Import of goods**: at clearance the customs authority collects duty and import VAT on the customs value plus duty (and excise, if any). The importer's documents are the **customs declaration** and the **freight, insurance and clearing-agent bills**. Accounting: duty and the clearing costs are **capitalised into stock** (landed cost, FR-LC-01..05); import VAT is **recoverable input tax** if the goods are used for taxable supplies, and not recoverable on goods for exempt use (ZATCA's input-tax guidance, summarised by secondary sources) **[verify]**. Whether import VAT can be deferred to the return instead of being paid at customs is **not confirmed** by this research and must be settled with a tax adviser before design **[verify]**.
* **Several payees for one shipment**: the supplier, the freight forwarder, the customs authority, the insurer and the clearing agent are separate liabilities (Blueprint, landed-cost model).
* **Foreign currency**: the supplier invoice is in dollars or euros; the tax and the inventory are in riyals. Rate on the date of customs clearance for VAT; the rates of receipt and of payment for the supplier, with exchange differences.
* **Import of services** from a non-resident (software, consulting, management fees): **reverse charge** (the Saudi customer self-assesses output VAT and, if entitled, deducts it as input VAT in the same return, in the return boxes ZATCA prescribes) **[verify boxes]**, and often **withholding tax** on the payment to the non-resident. Published rates differ between sources (royalties 15% and management fees 20% are consistent; technical or consulting services appear as 5% in most sources and 15% in one; treaty relief needs a residency certificate) **[verify rates]**. Withholding is remitted by the 10th day of the following month.
* **Intra-GCC** purchases follow the GCC VAT agreement; the treatment differs from a third-country import **[verify]**.

### 3.3 Exports and zero-rated supplies

* Exports of goods and services, international transport and some other supplies are **zero-rated**: tax rate 0%, but they are *supplies* (they go in the return and keep the right to recover input tax). They need an **exemption reason code** on the e-invoice and **proof** (customs export document).
* **Exempt** supplies (for example some financial services, residential real estate) are different: no tax charged and **no right to recover related input tax**. A business with both taxable and exempt supplies needs a **recovery apportionment** (a percentage of input tax recoverable).
* Zero-rated and exempt look identical on a document (no tax line) and are completely different in the return and in recovery; the ledger must distinguish them.

### 3.4 Manufacturing

* Raw materials and packaging bought with recoverable input VAT; inventory carried **tax-exclusive**.
* Raw material, work in progress and finished goods are separate inventory accounts (FR-WIP-01); tax never enters production cost unless it is non-recoverable.
* **Mixed supplies** (taxable domestic sales, zero-rated exports, exempt sales) make the **recovery percentage** a real parameter: input VAT on materials used for exempt output is not recoverable.
* **Free zones and bonded warehouses** change the place of supply and the customs treatment **[verify]**.
* **Scrap and by-products** are sales with their own tax class.

### 3.5 Cross-cutting

* **Advances and deposits**: tax at the time of payment where the law says so, then set off on the final invoice **[verify]**.
* **Credit and debit notes**: tax adjusts at the original rate and code.
* **Non-recoverable categories** (for example entertainment, some vehicles) go to cost whatever the rate **[verify list]**.
* **Fixed assets** carry input tax like other purchases; capital-goods adjustment rules may apply **[verify]**.
* **Bad-debt relief, reverse charge timing, partial payments**: timing rules differ by law.
* **Zakat and income tax** are year-end computations from the ledger, outside transaction tax; keep them out of this design but make sure the ledger can feed them.

## 4. Where we are today (checked in the code)

| Area | What exists | Evidence |
|---|---|---|
| Tax model | A **tax slab** per company: name, percentage, default flag, exemption reason code and text. Nothing else: no type (standard, zero, exempt), no direction, no effective dates, no accounts. | `tax_slabs` in `src/db/schema.ts` |
| Choosing the tax | The user picks a slab on the document header and optionally per invoice line. A line without a slab falls back to the header. Expenses and bills carry one slab. **No determination from the customer, the vendor or the item.** | `computeInvoiceServerTotals` in `server/lib/businessLogic.ts`; `taxSlabId` columns |
| Party and item data | Customer and vendor have a VAT number, a buyer type (B2B / B2C) and a country code. Items have a kind (item or service) and a category. **No tax profile, no residency class, no exemption certificate, no HS code or duty rate, no excise class.** | `customers`, `vendors`, catalog tables |
| Posting | Each document posts its total tax as one line to the single **VAT output** or **VAT input** account, only when the amount is above zero. | `server/routes/transactions.ts`, `expenses.ts`, `server/lib/purchasing.ts`, `inventory.ts`, `pos.ts` |
| Accounts | Chosen by posting role through the account mapping; the receivable and payable lines can use the party's own control account. Tax accounts are fixed roles, not per tax. | `postJournalEntry`, `postingContext.ts`, `partyProfile.ts`, `chartOfAccounts.ts` |
| Tags on ledger lines | Customer, vendor and dimensions. **No tax code, no direction, no recoverability, no return box.** | BR-TAX-01 is **Partial** |
| Recoverability | Everything on bills and expenses is treated as fully recoverable input tax. No non-recoverable part, no apportionment. | `inputVat.ts`, expense and bill posting |
| Import | **Not built**: no customs entry, no duty, no landed cost (specified in the Blueprint, none in code), no import VAT, no foreign-currency documents (currency is a text field defaulting to SAR, no rates). | grep of `server/`, `src/` |
| Reverse charge | **Not built.** | no code |
| Withholding | **Not built.** | no code |
| Excise | **Not built.** | no code |
| Return | VAT return computed from **documents** by quarter (not from ledger tags); a filed quarter locks VAT documents. **No settlement entry** (FR-TAX-02). | `taxReturns.ts`, `vatReturn.ts` |
| E-invoice | The slab percentage and exemption code drive the ZATCA tax category; works for standard, zero-rated and exempt lines. | `server/lib/zatca/` |
| Rounding | Tax is rounded per line and summed; no cash-rounding account (FR-RND-02 partial). | `computeInvoiceServerTotals` |

**Conclusion.** The present design is one *rate* chosen by hand. It cannot express a *treatment*: the accounts, recoverability, reverse charge, withholding, the return box and the legal category all hang off a bare percentage, and so cannot be automated. That is the root cause behind every gap in the table, not a list of separate missing features.

## 5. Design principles for our solution

1. **One tax engine** (`server/lib/tax/`), the only code that determines, computes and returns tax lines. Documents never contain tax logic; invoice, quotation, POS, expense, bill, goods receipt, return and credit note all call it.
2. **Profiles, not choices.** Tax treatment comes from the party profile, the item profile and the transaction type. The document form shows the outcome and allows an authorised override with a reason.
3. **The tax code is the unit.** A tax code bundles components (VAT, import VAT, reverse-charge VAT, withholding, excise, customs duty), each with its effective-dated rate, recoverability and accounts.
4. **Accounts are looked up, never typed**: from the tax code and the role of the component, through the existing posting engine and account mapping.
5. **Backward compatible.** Every existing slab becomes a tax code automatically; existing documents keep their slab and code; no history is re-posted.
6. **Auditable and period-safe.** Tax changes go through the posting guard and period rules already in place; changes to rules and codes are audited and effective-dated.
7. **The ledger is the book of tax**: return, registers and settlement read the ledger tax tags and reconcile to documents (the "Ledger vs Documents" pattern).

## 6. Candidate architecture (one option, for discussion)

### 6.1 The objects

| Object | Purpose | Key fields (indicative) |
|---|---|---|
| **Tax jurisdiction** | The authority and the law (for example KSA VAT; GCC state; withholding; customs) | country, authority (a vendor-like payee), return period type |
| **Tax component** | One kind of tax on a line | kind (vat, import_vat, reverse_charge, withholding, excise, duty), direction (collected, paid, both) |
| **Tax code** | The treatment a line receives; bundles one or more components | name, jurisdiction, e-invoice category and exemption code, return box per component, supply nature (standard, zero-rated, exempt, out of scope), active |
| **Tax rate** | Effective-dated rate of a component in a code | rate, valid from / to, base (net, net plus duty, gross) |
| **Tax code accounts** | Where each component posts | per component: output account, input-recoverable account, non-recoverable treatment (to cost or to expense), reverse-charge pair, clearing account, authority payable |
| **Recovery rule** | How much input tax is recoverable | percentage (fixed or by apportionment period), category blocks (for example entertainment) |
| **Party tax profile** | Per customer and vendor | registration status and number, residency class (domestic, GCC, foreign), designated zone, withholding applicability, exemption or treaty certificate and expiry, default treatment overrides |
| **Item tax profile** (tax class) | Per item or category | class (standard, zero, exempt, excise category), HS code and duty rate, recoverability class, tax-inclusive pricing flag |
| **Company tax profile** | Per company | registrations, accounting basis, partial-exemption method, rounding method, settlement frequency |
| **Tax determination rule** | Ordered rule table | transaction type, party class, item class, origin / destination, date range, then the tax code (or codes) |
| **Transaction tax lines** | What a document stores | per document line: code, component, base, rate, amount, recoverable and non-recoverable parts, account ids, return box |

### 6.2 Determination, in order

1. **Transaction type** from the document and the party: sale, export, retail sale, domestic purchase, import of goods, import of services, internal transfer. A foreign-resident vendor on a purchase makes it an import; a goods item makes it import of goods, a service item import of services.
2. Rules are matched most specific first on (transaction type, party class, item class, place, date); the first match wins; no match is an error that names the missing rule (never a silent zero).
3. The matched **tax code** gives components, rates valid on the document date, recoverability and accounts.
4. **Override** only with a permission, a reason and an audit entry; the override is shown on the document and in the register.

### 6.3 What posts (examples)

| Scenario | Tax lines created | Ledger effect |
|---|---|---|
| Domestic standard sale | Output VAT 15% | Dr receivable (customer); Cr revenue; Cr VAT output |
| Zero-rated export | Output VAT 0%, supply nature zero-rated, reason code | Dr receivable; Cr revenue; **tagged line** with tax code and zero amount for the return and e-invoice (no VAT line value) |
| Exempt sale | Supply nature exempt | As above, plus excluded from recoverable-input computations |
| Retail sale, tax-inclusive price | VAT extracted from the price | Dr bank or receivable; Cr revenue; Cr VAT output |
| Domestic purchase, recoverable | Input VAT | Dr inventory or expense; Dr VAT input; Cr payable |
| Domestic purchase, non-recoverable category | Input VAT 15%, recoverable 0% | The tax is added to the cost line |
| Import of goods | Customs duty, import VAT on (customs value plus duty) | At customs entry: Dr inventory (duty and clearing costs, by landed-cost allocation); Dr VAT input (recoverable import VAT); Cr customs authority payable; the supplier is a separate payable in foreign currency |
| Import of services | Reverse-charge VAT, withholding | Dr expense; Cr supplier payable (net of withholding); Cr withholding payable; Dr VAT input and Cr VAT output (self-assessed, in the return boxes) |
| Credit note | Same code, rate and accounts as the original, opposite sign | Mirror entry |
| Filing a quarter | Settlement | Dr VAT output, Cr VAT input, difference to VAT payable to the authority (FR-TAX-02) |

### 6.4 How the operator experiences it

* **Invoice for an import** (purchase from a foreign supplier): the operator chooses the vendor and the items. The vendor profile says "foreign", the item says "goods, HS code with duty rate", so the system proposes *import of goods*: it shows the duty and import VAT expected, asks for the customs declaration number and the clearing cost lines when the shipment is received, and posts everything (stock at landed cost, recoverable import VAT, payables to each payee). The operator picks no account.
* **Service invoice from a foreign vendor**: the same vendor profile and a service item give *import of services*: reverse charge and withholding are computed and posted automatically; the payment screen shows the withholding amount.
* **Retail**: the item's class decides the rate; prices are tax-inclusive per company setting; mixed baskets just work.
* **Manufacturing**: purchases of materials post recoverable input tax per the company's recovery rule; exports are zero-rated by the customer's profile; the monthly recovery percentage is a company setting, computed from the ledger.

### 6.5 Reporting and settlement

* **VAT return boxes** from ledger tax tags (sales by supply nature, output tax, purchases, input tax, import VAT, reverse charge, adjustments), reconciled to the registers and to documents by the existing *Ledger vs Documents* check.
* **Registers**: sales VAT, purchase VAT, import and customs, reverse charge, withholding (with certificates for the payee), excise.
* **Settlement entry** on filing; payment of the net to the authority goes through the normal payment screens (the authority is a vendor-like payee).
* **Withholding remittance** is its own liability with its own due date.

### 6.6 Dependencies that are bigger than tax

| Dependency | Why tax needs it | State |
|---|---|---|
| **Foreign currency** (rates, revaluation, exchange differences) | Import documents and withholding on foreign payments | Not built; currency is only a text field |
| **Landed cost** (Blueprint FR-LC) | Duty and clearing costs must reach inventory cost | Specified, not built |
| **Customs entry** document | Source of import VAT and duty with its own payee | Not built |
| **Item master fields** (HS code, duty, class) | Determination and duty | Not built |
| **Return box reference data** | Mapping tax code to box | Not built; must come from the authority's current return form **[verify]** |

## 7. Impact map (what a build touches)

Schema and RLS for every new table (all company-scoped), composite company keys, company-deletion routine, migration of tax slabs to tax codes with default profiles; the posting engine and `postingContext`; every document route (invoice, quotation, credit note, POS, expense, bill, goods receipt, return) and its screen; the ZATCA tax category mapping and XML builder; the VAT return and every VAT report; consistency-check rules for tax; permissions (tax codes, rules, profiles, override, settlement); audit log; translations (English, Arabic, Urdu); the print documents; tests (real HTTP and database, including period locks and cross-company isolation); the Blueprint traceability (BR-TAX-01..03 and new requirements); the documentation set and release script.

## 8. Order of work, mapped to sprints, requirements and tests (if the design is accepted)

The slices below are now in the sprint plan (Sprints 14 to 14f), and every slice has requirements (BR), system requirements (FR) and planned test cases in the generated documents. Section 12 lists the mapping in full.

| Slice | Sprint | Content | Requirements | Depends on |
|---|---|---|---|---|
| T1 | 14 | Tax codes, components, dated rates, accounts per code; tagged tax lines; migrate every slab; governance | BR-TAX-01, 04, 05, 06, 17 | none |
| T2 | 14b | Profiles, determination, override, supply natures, tax-inclusive pricing, cash rounding | BR-TAX-03, 07, 08, 09, 10, 11 | T1 |
| T3 | 14c | Recovery and apportionment; return and registers from ledger tags; settlement entry | BR-TAX-02, 12, 13 | T1, T2 |
| T4 | 14d | Reverse charge; withholding | BR-TAX-14, 15 | T2, T3 |
| T5 | 14e | Foreign currency, landed cost, customs entry, automatic import of goods, one payable per payee | BR-IMP-01..05 | T2, T3 |
| T6 | 14f | Excise and other components, if a customer needs them | BR-TAX-16 | T1 |

T1 to T3 deliver the domestic and retail cases completely and are the foundation; T4 and T5 are the import and manufacturing cases.

## 9. Risks and what must not be broken

* **ZATCA pipeline**: the e-invoice category and exemption code must keep coming from the tax code with byte-identical XML for existing cases; every change under `server/lib/zatca` is verified under the dual-gate protocol.
* **Filed quarters and closed months** must never be re-posted by a migration.
* **Two sources of truth**: during migration slab and tax code must not both drive the same document; one code path only, the old column read-only afterwards.
* **Rate changes** must not alter issued documents.

## 10. Decisions needed from the owner

1. **Scope of jurisdictions**: Saudi Arabia only for now, or design for other GCC states and countries from the start (affects jurisdiction and return-box modelling)?
2. **Which components are in scope and when**: VAT (all scenarios); import VAT and customs duty; reverse charge; withholding tax; excise. Which of these does a real customer of yours need first?
3. **Import VAT treatment**: pay at customs and recover in the return, or deferral where the law allows it **[verify with a tax adviser]**. This changes the entries.
4. **Recovery**: full recovery only, or apportionment for mixed taxable and exempt supplies (manufacturers and some retailers)?
5. **Pricing**: tax-inclusive or exclusive, per company, per price list, or per item?
6. **Override policy**: who may override a determined tax code, and must a reason be mandatory?
7. **Foreign currency and landed cost** are prerequisites for imports: are they in the same programme, and in which order relative to Sprint 12 to 14?
8. **Return form**: who supplies the current VAT return box definitions, and who reviews the tax-code setup for each new company (a template set per country, reviewed by a tax adviser)?
9. **Existing data**: confirm the migration rule: each current slab becomes one tax code of the matching supply nature (percentage above zero: standard; zero with an exemption reason: zero-rated or exempt as the reason code says).

## 12. Traceability: scenario to requirement to test to sprint

All of these exist as **planned** entries in the generated requirement register, system requirements, test-case catalogue (modules TAX and IMP, all marked Candidate until built) and sprint log. The Technical documentation's traceability page shows the same mapping with the system-requirement text.

| Scenario or capability (section 3 and 6) | Requirements | Planned test cases | Sprint |
|---|---|---|---|
| Rates that change over time, history untouched | BR-TAX-04 | TAX-001..003 | 14 |
| Tax on its own accounts, tagged lines, e-invoice category from the code | BR-TAX-01, BR-TAX-05 | TAX-004, 005, 030 | 14 |
| Existing slabs become codes without changing history | BR-TAX-06 | TAX-006, 007 | 14 |
| Who may change tax setup, audit, isolation | BR-TAX-17 | TAX-008, 009 | 14 |
| Domestic and retail sale, determination from profiles | BR-TAX-07, BR-TAX-08 | TAX-010..013 | 14b |
| Export and zero-rated, exempt, supply natures | BR-TAX-11 | TAX-011, 018, 019 | 14b |
| Override with reason | BR-TAX-09 | TAX-014, 015 | 14b |
| Retail tax-inclusive pricing, rounding | BR-TAX-10, BR-TAX-03 | TAX-016, 017 | 14b |
| Non-recoverable tax, apportionment (manufacturing, mixed supplies) | BR-TAX-12 | TAX-019..021 | 14c |
| Return and registers from the ledger, purchase return period | BR-TAX-13 | TAX-022, 024 | 14c |
| Settlement on filing | BR-TAX-02 | TAX-023 | 14c |
| Imported services: reverse charge | BR-TAX-14 | TAX-025, 026 | 14d |
| Payments to non-residents: withholding, treaty | BR-TAX-15 | TAX-027, 028 | 14d |
| Foreign currency and exchange differences | BR-IMP-01 | IMP-001..003 | 14e |
| Landed cost and landed average cost | BR-IMP-02 | IMP-004, 010 | 14e |
| Customs entry, import VAT and duty | BR-IMP-03 | IMP-006, 007 | 14e |
| Import of goods determined from the vendor profile | BR-IMP-04 | IMP-008 | 14e |
| One payable per payee | BR-IMP-05 | IMP-005, 009 | 14e |
| Excise | BR-TAX-16 | TAX-029 | 14f |

The posting entries for each scenario are in the Posting rules annex (planned section); the decisions are D18 to D24 in the Solution design; the module map is section 11b of the Technical design; the new terms are in the glossary. Section 10's decisions must be answered before Sprint 14 starts.


## 11. Sources and confidence

* Finance Core Blueprint (this repository, `docs/reference`): FR-TAX-01/02, FR-RND-01/02, FR-LC-01..05, FR-WIP-01, ERD ("tax_slabs gain Output/Input VAT account links").
* Code as of this date: see section 4.
* Oracle Fusion Tax documentation: [tax determination](https://docs.oracle.com/en/cloud/saas/financials/26c/faitx/tax-determination.html), [tax rate setup](https://docs.oracle.com/en/cloud/saas/financials/24b/faitx/tax-rate-setup.html).
* Microsoft Dynamics 365 Finance: [sales tax groups and item sales tax groups](https://learn.microsoft.com/en-au/dynamics365/finance/general-ledger/tasks/set-up-sales-tax-groups-item-sales-tax-groups).
* ZATCA guidelines (table of contents seen; substance **not** read in this session): [Imports and Exports](https://zatca.gov.sa/en/HelpCenter/guidelines/Documents/Guideline-on-Imports-and-Exports-under-VAT-Provision.pdf), [Input Tax Deduction](https://zatca.gov.sa/en/HelpCenter/guidelines/Documents/Guideline-on-Input-Tax-Deduction-under-VAT-Provisions.pdf), [Tax Invoicing and Records](https://zatca.gov.sa/en/HelpCenter/guidelines/Documents/Guideline-for-Tax-Invoicing-and-Records-under-VAT-Provisions.pdf), and the [reverse charge circular summary](https://pwc.com/m1/en/services/tax/me-tax-legal-news/2021/saudi-arabia-circular-on-the-reverse-charge-mechanism-application.html).
* Secondary commentary on withholding rates and input-tax deduction (rates disagree between sources): [ClearTax withholding tax](https://www.cleartax.com/sa/withholding-tax-saudi-arabia), [Dariba](https://www.dariba.co/withholding-tax-in-saudi-arabia/), [ClearTax input VAT](https://www.cleartax.com/sa/input-vat-deduction-ksa).
* **Not independently verified**: SAP, NetSuite and Odoo behaviour (general knowledge); every Saudi legal point marked **[verify]**. A qualified tax adviser should confirm the treatment of import VAT (deferral), reverse-charge boxes, withholding rates and non-recoverable categories before any of it is implemented.
