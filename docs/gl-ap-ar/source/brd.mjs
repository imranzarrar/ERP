// Business requirement register for General Ledger / Accounts Receivable / Accounts Payable 2.0.
// ONE source: the BRD, the traceability matrix and the roadmap are generated from it (node scripts/build-gl-docs.mjs). Edit here, never in the generated files.
//
// [id, title, requirement (what the business needs), source, priority, status, blueprint FRs]
//   priority  Must | Should | Could            (MoSCoW; "Won't" items are in OUT_OF_SCOPE)
//   status    Built (delivered in Demo 2.0) | Partial (delivered in part; the gap is named in the text) | Planned (in scope, not built yet)
//   source    Blueprint (docs/reference/Finance-Core-Blueprint.pdf) | Decision (a recorded owner decision) | Compliance (ZATCA / VAT / audit) | Standard (tier-1 ERP practice) | Platform

export const AREAS = [
  { id: 'COA', name: 'Chart of accounts and account mapping' },
  { id: 'JNL', name: 'Journals and opening balances' },
  { id: 'PER', name: 'Periods, posting control and close' },
  { id: 'DAT', name: 'Document date standard' },
  { id: 'DIM', name: 'Dimensions and cost centres' },
  { id: 'RPT', name: 'Ledger reporting' },
  { id: 'AR', name: 'Accounts receivable' },
  { id: 'AP', name: 'Accounts payable' },
  { id: 'BNK', name: 'Bank reconciliation' },
  { id: 'TAX', name: 'Tax and rounding postings' },
  { id: 'PRT', name: 'Printed accounting documents' },
  { id: 'SEC', name: 'Security, permissions and audit' },
  { id: 'LOC', name: 'Localisation' },
  { id: 'NFR', name: 'Platform and quality' },
  { id: "IMP", name: "Imports, landed cost and foreign currency" },
  { id: "FND", name: "Core foundations (events, ledgers, currency, references, quantities, schedules, determination)" },
  { id: "BUD", name: "Budgeting and commitment control" },
  { id: "SAL", name: "Sales documents (quotations, invoices, credit notes)" },
  { id: "EXP", name: "Expenses and recurring postings" },
  { id: "PUR", name: "Procurement and inventory" },
  { id: "POS", name: "Point of sale" },
  { id: "ZAT", name: "ZATCA e-invoicing" },
  { id: "VAT", name: "VAT returns and period locks" },
  { id: "MST", name: "Master data, numbering and imports" },
  { id: "ORG", name: "Tenancy, users and company administration" },
  { id: "REP", name: "Reports and dashboard (documents)" },
  { id: "CFG", name: "Document templates and translations" },
];

const R = [];
const add = (area, rows) => rows.forEach((r, i) => R.push({ id: `BR-${area}-${String(i + 1).padStart(2, '0')}`, area, title: r[0], text: r[1], source: r[2], priority: r[3], status: r[4], bp: r[5] || [] }));

add('COA', [
  ['Company-owned hierarchical chart', 'Every company has its own chart of accounts: code, English and Arabic name, type (asset, liability, equity, revenue, expense), parent heading and active flag. Headings group and total but take no postings.', 'Blueprint', 'Must', 'Built', ['FR-COA-01']],
  ['Starter chart at provisioning', 'A new company receives a standard Saudi chart automatically, with every posting role (receivable, payable, inventory, VAT, bank, revenue, cost of sales ...) mapped to exactly one account and its own account for each bank.', 'Blueprint', 'Must', 'Built', ['FR-COA-03']],
  ['Control accounts', 'Accounts for customers, vendors, stock, tax and banks are control accounts: only the document or subledger that owns them posts there, and manual journals refuse them.', 'Blueprint', 'Must', 'Built', ['FR-COA-02']],
  ['Retire, never delete', 'An account with postings can never be deleted. It can be deactivated only when its balance is zero and nothing depends on it; its type, role and bank link cannot change once used.', 'Blueprint', 'Must', 'Built', ['FR-COA-04']],
  ['Show dependants before deactivation', 'Before an account is deactivated the user sees every configuration record that points at it (role mappings, banks, categories, customer and vendor profiles).', 'Blueprint', 'Should', 'Partial', ['FR-COA-05']],
  ['Account mapping', 'The accountant chooses which account each posting role and each expense category posts to. A change applies to future postings only; old lines keep the account they were posted to.', 'Decision', 'Must', 'Built', []],
  ['Chart import and export', 'The chart can be exported to Excel and imported from Excel with a preview; only the rows the user selects are saved and an existing account type is never changed.', 'Decision', 'Should', 'Built', []],
  ['Audit of chart changes', 'Creating, changing, importing, mapping and deactivating accounts is written to the audit trail.', 'Standard', 'Must', 'Built', []],
  ["Account classification","Every account carries a class and sub-class (cash, bank, receivable, other current asset, non-current asset, current and non-current liability, equity, operating revenue, other income, cost of sales, operating expense, finance cost, tax), a nature or function for expenses, a cash-flow class and a statement mapping key, so that statutory and management statements and the cash-flow statement derive from the chart.","Decision","Must","Planned",[]],
  ["Posting controls and account groups","An account can be blocked for posting (distinct from inactive), restricted to automatic posting, required to carry a currency or a tax category, and belongs to an account group that supplies defaults and number ranges.","Decision","Must","Planned",[]],
  ["Industry chart templates","A company chooses a starter chart for retail, trading, manufacturing, real estate or services, each with its role accounts, dimension rules and statement layouts, reviewed by an accountant; a template can be merged into an existing chart.","Decision","Should","Planned",[]],
  ["Chart views and statutory mapping","One ledger can be presented through several chart views (IFRS as adopted in Saudi Arabia as the reference, local statutory, management) that map accounts to the view lines; statements and the cash-flow statement use the selected view.","Decision","Must","Planned",[]],
  ["Effective dating and approval of chart changes","Accounts carry valid-from and valid-to dates; changes to the chart can require approval and are audited; history is never rewritten.","Decision","Should","Planned",[]],
]);

add('JNL', [
  ['Manual journals with maker-checker', 'An accountant prepares a journal as a draft, submits it, and a different person with the posting right approves it (which posts it) or rejects it with a written reason, returning it to draft.', 'Decision', 'Must', 'Built', ['FR-JE-01']],
  ['Balanced entries only', 'A journal entry whose debits do not equal its credits is refused by the server inside the same transaction as the write, for documents and for manual journals alike.', 'Blueprint', 'Must', 'Built', ['FR-JE-01']],
  ['Posted entries are immutable', 'A posted entry is never updated or deleted. A correction is a reversing entry plus a new correct entry; a reversal can be made only once.', 'Blueprint', 'Must', 'Built', ['FR-JE-02']],
  ['Source and dimension recorded', 'Every entry records its source (document type and id) and every line carries the dimension tags and party its account requires.', 'Blueprint', 'Must', 'Built', ['FR-JE-03']],
  ['Entry numbering', 'Manual journals receive a unique sequential number per company; a discarded draft keeps its number on record.', 'Blueprint', 'Must', 'Built', ['FR-JE-04']],
  ['Reversal of a manual journal', 'A posted manual journal is reversed by a reversing draft that follows the same approval path; the original stays posted until the reversal is approved. Entries made by documents are reversed through their document, never by hand.', 'Decision', 'Must', 'Built', []],
  ['Self-approval safeguard', 'A preparer cannot approve their own journal unless the company owner switches that safeguard on; when on, such journals are marked and the change is audited.', 'Decision', 'Should', 'Built', ['FR-APR-03']],
  ['Journal listing and entry detail', 'Every posting of the company, from documents and from manual journals, can be listed and filtered (period, status, source, text) and opened to its lines and its source document.', 'Decision', 'Must', 'Built', []],
  ['Opening balances', 'A company that starts using the ledger part-way can post an opening entry: previewed first, balanced (a difference may be put to an equity account), posted once, with a confirmation, and reversible with a reason.', 'Decision', 'Must', 'Built', []],
  ['Amount-threshold approval rules', 'Approval rules per document type (journal, vendor bill, vendor payment, credit note) by amount, with several sequential levels, server-enforced, with no self-approval at any level and a full approval history; a document without a matching rule posts directly. Delivered so far (Sprint 11): vendor payments, vendor bills and credit notes, recall by the submitter, delegation with validity dates, the manager hierarchy, and the "paid at delivery" goods-receipt shortcut cannot bypass a rule. Manual journals follow a rule too when one matches their amount; with no matching rule they keep the single maker-checker step.', 'Blueprint', 'Should', 'Partial', ['FR-APR-01', 'FR-APR-02', 'FR-APR-03', 'FR-APR-04', 'FR-APR-05', 'FR-APR-06']],
]);

add('PER', [
  ['Open fiscal month rule', 'A dated posting must fall in an existing, open fiscal month and not in the future.', 'Standard', 'Must', 'Built', []],
  ['VAT quarter freeze', 'A tax document may not be dated in a VAT quarter whose return is generated or filed; any other posting may not be dated in a filed quarter.', 'Compliance', 'Must', 'Built', []],
  ['Lock date', 'The company sets a lock date; nothing may be dated on or before it except by a user holding the override right.', 'Standard', 'Must', 'Built', []],
  ['Back-date window', 'The company sets how many days back a posting may be dated; going further needs the back-date right.', 'Standard', 'Must', 'Built', []],
  ['Reason for back-dating', 'A posting older than a set number of days must carry a reason; a posting that used an override or a reason is written to the audit log.', 'Standard', 'Must', 'Built', []],
  ['One guard for every dated posting', 'Every route that posts something dated, or reverses something at its own date, passes through one posting guard, so no path can bypass the period rules. A manual journal is checked at submit and again at approval.', 'Platform', 'Must', 'Built', []],
  ['Month close from posted lines', 'Closing a fiscal month verifies the month trial balance from posted journal lines, locks the period and never zeroes revenue or expense accounts; the cached figure is a performance aid, never the only source.', 'Blueprint', 'Should', 'Partial', ['FR-CLOSE-01', 'FR-CLOSE-02']],
  ['Month-close readiness checklist', 'Before a month closes the system shows one checklist: bank reconciliations completed, VAT quarters filed, no draft or pending documents dated in the month, and the other period prerequisites.', 'Blueprint', 'Should', 'Planned', ['FR-CLOSE-03']],
  ['Restricted month and adjustment period', 'A month status between open and closed that only named users may post into, and a restricted adjustment period after year-end for controller / auditor correcting entries; a closed year is never reopened.', 'Blueprint', 'Should', 'Planned', ['FR-CLOSE-07', 'FR-CLOSE-08']],
  ['Year-end close', 'Year-end close computes the year result from posted lines and posts exactly one closing entry into retained earnings, then opens the next year automatically; balance sheet accounts carry forward with no posting.', 'Blueprint', 'Must', 'Planned', ['FR-CLOSE-04', 'FR-CLOSE-05', 'FR-CLOSE-06']],
  ['Per-module close', 'Receivables, payables, inventory and the general ledger can each be closed on their own date, as in tier-1 systems.', 'Standard', 'Could', 'Planned', []],
]);

add('DAT', [
  ['Document date on every document', 'Every document table has one field named doc_date holding the date of the document; operational reports use it.', 'Decision', 'Must', 'Built', []],
  ['Posting date for the ledger', 'Every document that posts also has posting_date (defaulting to doc_date); financial statements, period locks and VAT use it.', 'Decision', 'Must', 'Built', []],
  ['Consistent date naming', 'Other dates are named <meaning>_date and stored as real dates, not timestamps; one concept has one name across tables, code and API.', 'Decision', 'Must', 'Built', []],
  ['Audit stamps', 'Every document records created_at / created_by and, once edited, updated_at / updated_by.', 'Standard', 'Must', 'Built', []],
]);

add('DIM', [
  ['Configurable dimension types', 'The company defines any number of dimension types (Branch and Department are seeded and cannot be removed), each combinable on any ledger line.', 'Blueprint', 'Must', 'Built', ['FR-DIM-01']],
  ['Dimension values and cost centres', 'Dimension values form a hierarchy; cost centres (the Department dimension) have an optional home branch.', 'Blueprint', 'Must', 'Built', ['FR-DIM-02']],
  ['Account dimension rules', 'Each account marks a dimension required, optional or not allowed, with an optional default; rules can be applied in bulk to a type, heading, range or list after a preview.', 'Decision', 'Must', 'Built', ['FR-JE-03']],
  ['Default tags from context', 'The posting engine fills dimension tags from, in order, the line, the document, the customer or vendor default, the bank default and the account default, and drops tags an account does not allow.', 'Decision', 'Must', 'Built', []],
  ['Dimension filters', 'The general ledger, journal listing and every report can be filtered by dimension, including all descendants of a hierarchical value.', 'Blueprint', 'Must', 'Built', []],
  ['Dimensions captured on documents', 'Invoice, expense and bill forms collect dimensions, so a Required rule can be enforced on documents as it is on manual journals.', 'Decision', 'Should', 'Planned', []],
  ['Monthly allocation run', 'A configurable monthly run redistributes a shared cost centre across destination branches by fixed or revenue percentage into an allocated-overhead account, net zero at company level.', 'Blueprint', 'Could', 'Planned', ['FR-DIM-03']],
  ['Branch profit and loss subtotals', 'Branch P&L shows direct expenses and allocated overhead as separate subtotals (contribution margin, then fully loaded profit).', 'Blueprint', 'Could', 'Planned', ['FR-DIM-04']],
  ["Dimension type roles","A dimension type can be marked balancing (a profit unit), cost object, or statistical driver; the engine treats each role accordingly.","Decision","Must","Planned",[]],
  ["Dimension value attributes and lifecycle","A dimension value carries configurable attributes (text, number, date, status, link to a customer, employee or branch) and a lifecycle (status and validity dates); posting to a value outside its validity is refused.","Decision","Must","Planned",[]],
  ["Valid-combination rules between dimension types","A company can require, imply or default one dimension from another (a project belongs to one profit centre); invalid combinations are refused.","Decision","Must","Planned",[]],
  ["Balancing per dimension value","For a balancing type each entry balances per value: where it does not, the engine adds inter-unit clearing lines; balance sheet and profit and loss can be produced per value. Allocation (BR-DIM-07) is widened to any dimension type, any basis including statistical drivers, with allocation cycles.","Decision","Must","Planned",[]],
  ["Break-down reports","Any report can break down by any dimension type, one column or row per value rolled up through the hierarchy, with drill to the ledger.","Decision","Must","Planned",[]],
]);

add('RPT', [
  ['General ledger detail', 'For any account or set of accounts and a period, the general ledger shows opening balance, every movement with running balance, and links each line to its source document.', 'Decision', 'Must', 'Built', []],
  ['One report engine', 'Trial balance, income statement, balance sheet, cash flow and changes in equity are definitions (rows by columns) run by one engine over the same ledger lines; no second calculation exists.', 'Decision', 'Must', 'Built', []],
  ['Custom report designer', 'An authorised user copies a standard definition or builds a new one: account selection by account, parent, range, type or role with include and exclude, subtotals, formulas, balance display rules, and full formatting; the standard ones can be reset.', 'Decision', 'Should', 'Built', []],
  ['Drill-down to the ledger', 'Every figure of a report opens the general ledger for exactly the accounts, period, basis and dimension filter behind it, and the ledger reproduces the figure.', 'Blueprint', 'Must', 'Built', []],
  ['Comparatives, variance and dimension columns', 'Columns combine a period basis (current, year to date, prior period, prior year, as at, custom range), a value basis, an optional dimension filter, and variance columns that compare other columns.', 'Decision', 'Should', 'Built', []],
  ['Excel export with formatting', 'Any statement exports to a workbook that carries bold, shading, underline and number formats.', 'Decision', 'Should', 'Built', []],
  ['Integrity shown on the page', 'A balance sheet states whether assets equal liabilities plus equity, a trial balance whether debits equal credits, and accounts with a balance that no row covers are listed with a warning, so money cannot go missing silently.', 'Decision', 'Must', 'Built', []],
  ['Ledger versus documents', 'The ledger is compared with the document-based reports account by account, and a consistency check proves the accounting rules (books balance, balances tie to registers, locked periods never move, subledgers tie to control accounts).', 'Decision', 'Must', 'Built', []],
  ['Server-side, company-scoped figures', 'Every report figure is computed on the server for the one company of the request, with no row cap and never from a client-supplied company.', 'Platform', 'Must', 'Built', []],
  ['Branch-restricted reading', 'A user restricted to branches sees ledger figures of those branches only and is told so.', 'Standard', 'Should', 'Built', []],
  ['Printed financial statements', 'Statements print on the company header with page setup, comparatives and signature block, in English, Arabic or Urdu.', 'Should', 'Should', 'Planned', []],
  ['Cut-over of document-based statements', 'After the ledger and the documents agree on every company for an agreed period, the document-based statements are retired one at a time in favour of the ledger statements.', 'Decision', 'Should', 'Planned', []],
]);

add('AR', [
  ['Invoices and credit notes post to receivables', 'A posted invoice, credit note or debit note generates a balanced entry against the customer control account, tagged with the customer.', 'Blueprint', 'Must', 'Built', ['FR-AR-01']],
  ['Customer posting profile', 'A customer can name its own control account and default dimensions; documents for that customer post through them automatically, and a customer without a profile uses the company default.', 'Decision', 'Should', 'Built', []],
  ['Receipt across invoices or on account', 'One customer receipt settles several invoices at once, or is held on account, through a payment allocation record; it is one voucher and one ledger entry.', 'Blueprint', 'Must', 'Built', ['FR-AR-02']],
  ['Apply money held on account', 'Money held on account for a customer can be applied later to open invoices, in one or more steps, never more than is held or owed.', 'Blueprint', 'Must', 'Built', ['FR-AR-02']],
  ['Cancel a receipt', 'A receipt is cancelled with a reason: its entry is reversed, a reversal voucher is written and every settled invoice becomes open again; an invoice settled by a receipt cannot be cancelled until the receipt is.', 'Decision', 'Must', 'Built', []],
  ['Aging from the ledger', 'Receivables aging is a live query over posted lines on the receivable control accounts, oldest charge settled first, with money held on account shown in its own column; it equals the control account to the cent.', 'Blueprint', 'Must', 'Built', ['FR-AR-03']],
  ['Customer ledger', 'Any customer\'s postings are listed with opening balance, running balance, document numbers and links to the entries.', 'Blueprint', 'Must', 'Built', ['FR-AR-03']],
  ['Document reports follow settlements', 'The document-based balance sheet, trial balance, statements, outstanding report and cash flow reflect multi-document receipts and money held on account, including as-at dates in the past.', 'Decision', 'Must', 'Built', []],
  ['Credit note application', 'A credit note or customer credit can be applied to other open invoices of the same customer (partial credit memos), with allocation records.', 'Standard', 'Should', 'Planned', []],
  ['Customer statement printing and reminders', 'A customer statement can be printed or sent and overdue reminders can be produced from the aging.', 'Standard', 'Could', 'Planned', []],
]);

add('AP', [
  ['Goods receipt against clearing', 'A goods receipt recognises inventory at cost against a goods-received-not-invoiced account at the moment goods arrive, independent of the vendor bill.', 'Blueprint', 'Must', 'Built', ['FR-AP-01']],
  ['Matched bill recognises the payable', 'A purchase bill clears the clearing balance, books recoverable VAT and recognises the vendor payable at that moment, not when cash is paid.', 'Blueprint', 'Must', 'Built', ['FR-AP-02']],
  ['Expenses share the payable ledger', 'An expense without a purchase order posts through the same payable control account and the same vendor subledger as a purchase bill: one vendor position.', 'Blueprint', 'Must', 'Built', ['FR-AP-03']],
  ['Vendor posting profile', 'A vendor can name its own payable control account and default dimensions, applied automatically to its documents.', 'Decision', 'Should', 'Built', []],
  ['Payment across bills and expenses', 'One vendor payment settles several bills and expenses, or is held on account with the vendor, and can be applied or cancelled exactly like a customer receipt.', 'Blueprint', 'Must', 'Built', ['FR-AP-04']],
  ['Payables aging and vendor ledger', 'Payables aging and the vendor ledger mirror the receivables ones, from the ledger.', 'Blueprint', 'Must', 'Built', ['FR-AP-04']],
  ['Returns, vendor credit and refunds', 'A purchase return posts according to the state of its goods receipt (unbilled, billed, paid); a return after payment creates a vendor credit receivable, cleared by a vendor refund.', 'Decision', 'Must', 'Built', []],
  ['Approval of large payments', 'A vendor payment above a threshold waits for approval and releases no funds until every level has approved.', 'Blueprint', 'Should', 'Planned', ['FR-APR-02']],
  ['Payment runs', 'Several vendors\' due items are selected, approved and paid together in one run.', 'Standard', 'Could', 'Planned', []],
]);

add('BNK', [
  ['Reconciliation session per bank and statement', 'A reconciliation session exists per bank account per statement date and captures the statement ending balance; only one is in progress per bank and each date is after the last completed one.', 'Blueprint', 'Must', 'Built', ['FR-BANK-01']],
  ['Clear ledger lines against statement lines', 'The session lists every posted, uncleared line of the bank\'s ledger account; each can be ticked off or matched to a statement line that was typed or imported, with suggested matches that are never applied silently.', 'Blueprint', 'Must', 'Built', ['FR-BANK-02']],
  ['Live reconciling formula and blocked completion', 'The session shows statement balance + deposits in transit - payments outstanding against the book balance live, and cannot be completed while the difference is not zero or a statement line is unmatched.', 'Blueprint', 'Must', 'Built', ['FR-BANK-03']],
  ['Discrepancies by journal entry', 'A bank fee or bank interest found on the statement is posted from inside the session as an entry to an expense or income account, cleared and matched at once; a session is never force-completed.', 'Blueprint', 'Must', 'Built', ['FR-BANK-04']],
  ['Completed reconciliation locks its lines', 'A completed session locks its cleared lines (the document behind one cannot be cancelled); reopening needs its own permission and a reason, applies only to the latest completed session of a bank, and is audited.', 'Blueprint', 'Must', 'Built', ['FR-BANK-05']],
  ['Statement import', 'Statement lines can be imported from a CSV file (day-first or year-first dates, signed or debit/credit columns) after a preview, and re-importing the same file adds nothing.', 'Decision', 'Should', 'Built', []],
  ['Excel statement import and saved formats', 'Excel statements import directly and a bank\'s column layout is remembered.', 'Standard', 'Could', 'Planned', []],
  ['Bank charges and interest in every statement', 'Bank fees and interest found while reconciling appear in the profit and loss, trial balance, month-close figure, dashboard profit and cash flow, so the document-based statements still balance.', 'Decision', 'Must', 'Built', []],
]);

add('TAX', [
  ['VAT posted to its own accounts', 'Output and recoverable input VAT post to dedicated accounts, never blended into revenue or expense; each line carries its tax code.', 'Blueprint', 'Must', 'Partial', ['FR-TAX-01']],
  ['VAT settlement entry', 'Filing a quarter posts a settlement entry netting output against input VAT into VAT payable.', 'Blueprint', 'Should', 'Planned', ['FR-TAX-02']],
  ['Line rounding and cash rounding', 'Line tax is computed at higher precision and rounded per line; cash-tender rounding never changes the legal total and posts to a rounding account.', 'Blueprint', 'Should', 'Partial', ['FR-RND-01', 'FR-RND-02']],
  ["Tax codes with components and effective-dated rates","A tax code is the treatment a line receives. It bundles one or more components (VAT, import VAT, reverse-charge VAT, withholding, excise, customs duty), each with a rate that has a valid-from and valid-to date. A document keeps the code and the rate it was taxed with; a later rate change never alters it.","Standard","Must","Planned",["FR-TAX-01"]],
  ["Tax accounts per code and tagged tax lines","Each component of a tax code names the accounts it posts to: output, recoverable input, non-recoverable treatment, reverse-charge pair, clearing and the authority payable. Every tax line in the ledger carries the tax code, the component, the direction, the recoverable amount and the return box.","Blueprint","Must","Planned",["FR-TAX-01"]],
  ["Existing tax slabs become tax codes","Every tax slab of every company becomes one tax code of the matching supply nature, with no change to any existing document, ledger entry, e-invoice or filed return. After the migration the tax code is the only source of tax treatment; the old slab column is read-only.","Decision","Must","Planned",[]],
  ["Party, item and company tax profiles","A customer and a vendor carry a tax profile (registration, residency class domestic, GCC or foreign, designated zone, withholding applicability, exemption or treaty certificate with expiry). An item carries a tax class (standard, zero-rated, exempt, excise category, recoverability class, and for goods the customs tariff code and duty rate). A company carries its tax registrations, rounding method, price basis and recovery method.","Standard","Must","Planned",[]],
  ["Automatic tax determination","The system determines the tax code of every line from the transaction type, the party profile, the item class, the place and the date, through ordered rules where the most specific rule wins. A line with no matching rule is refused with a message naming the missing rule; the system never silently posts zero tax. The operator chooses neither the tax treatment nor any account.","Decision","Must","Planned",[]],
  ["Authorised override of a determined tax code","A user holding the override right may change the determined tax code of a line only with a reason. The override is audited and visible on the document and in the registers; a user without the right cannot change it, through the screen or the API.","Standard","Must","Planned",[]],
  ["Tax-inclusive and tax-exclusive pricing","A company, price list or item may price tax-inclusive. The system extracts the tax from the price per line, rounds per line, and the document total equals the price the customer sees.","Standard","Should","Planned",["FR-RND-01"]],
  ["Zero-rated, exempt and out-of-scope are different supplies","The supply nature (standard, zero-rated, exempt, out of scope) is a property of the tax code and is carried on the ledger tags, the return and the e-invoice category with its exemption reason code. A zero-rated supply keeps the right to recover input tax; an exempt supply does not.","Compliance","Must","Planned",[]],
  ["Recoverable and non-recoverable input tax","Input tax is split at posting into the recoverable part (an asset until set off) and the non-recoverable part (added to the cost of the purchase), by the item class, category blocks and the company recovery method, including a percentage apportioned between taxable and exempt supplies and computed from the ledger.","Standard","Should","Planned",[]],
  ["VAT return and registers from ledger tax tags","The VAT return boxes, the sales, purchase, import, reverse-charge and withholding registers are computed on the server from the ledger tax tags and reconcile to the documents; the consistency check compares the two.","Blueprint","Must","Planned",["FR-TAX-01"]],
  ["Reverse charge on imported services","A service bought from a non-resident vendor is determined as an import of services: output tax is self-assessed and, where the company is entitled, deducted as input tax in the same entry and in the prescribed return boxes.","Compliance","Must","Planned",[]],
  ["Withholding tax on payments to non-residents","A payment to a non-resident for a service class that attracts withholding deducts tax at the rate of that class, posts the liability to the authority with its own due date, and pays the vendor the net. A treaty certificate on the vendor profile lowers the rate only while it is valid. The payee receives a withholding record.","Compliance","Should","Planned",[]],
  ["Excise and other tax components","A line may carry an excise component (and other configured components) posting to its own accounts, included in the VAT base where the law says so.","Compliance","Could","Planned",[]],
  ["Governance of tax setup","Tax codes, rules, profiles and overrides have their own permissions (create, read, update, deactivate), are audited, are company-scoped with row-level security, and a tax code used by any document can only be deactivated, never deleted. Changes after a VAT quarter is filed apply only to later dates.","Standard","Must","Planned",[]],
]);

add('PRT', [
  ['Receipt and payment voucher', 'A receipt or payment prints as a voucher with party, amount in words, bank, settled documents, amount held on account, accounting entry and signatures; a cancelled one is stamped and shows its reversing entry.', 'Standard', 'Must', 'Built', []],
  ['Journal voucher', 'Any manual journal (in any status) and any posted entry prints as a journal voucher with accounts, parties, dimensions, totals in words and the approval trail.', 'Standard', 'Must', 'Built', []],
  ['Bank reconciliation statement', 'A reconciliation prints as the standard statement: balance per bank, deposits in transit, payments outstanding, adjusted balance, balance per books and the outstanding lists.', 'Standard', 'Must', 'Built', []],
  ['Right-to-left printing', 'Arabic and Urdu users print these documents right to left, with Arabic account names where they exist.', 'Standard', 'Must', 'Built', []],
]);

add('SEC', [
  ['Tenant isolation', 'A company\'s data is invisible to every other company at the database level (row-level security on every table, composite company keys) as well as in the application.', 'Platform', 'Must', 'Built', []],
  ['Permission model', 'Every module offers create, read, update and delete (delete meaning cancel or deactivate) plus action-specific rights where the authority differs (approve, post, reverse, back-date, override lock, adjust, complete, reopen); a user\'s rights are the union of their roles and are enforced on the server.', 'Platform', 'Must', 'Built', []],
  ['Audit trail of elevated actions', 'Posting overrides, back-dated postings, reopenings, cancellations, approvals, mapping and policy changes are recorded with user, company, time and details.', 'Standard', 'Must', 'Built', []],
  ['No bulk overwrite', 'There is no endpoint that overwrites documents in bulk; every document is written only by its own route, which applies the period rules.', 'Platform', 'Must', 'Built', []],
]);

add('LOC', [
  ['English, Arabic and Urdu', 'Every screen, message and printed accounting document is available in English, Arabic and Urdu with professional accounting vocabulary.', 'Decision', 'Must', 'Built', []],
  ['Right-to-left layout', 'Arabic and Urdu mirror the layout correctly (tables, totals, drawers, prints).', 'Decision', 'Must', 'Built', []],
  ['Amount in words in Arabic and Urdu', 'Amounts in words print in the user\'s language.', 'Standard', 'Could', 'Planned', []],
]);

add('NFR', [
  ['Scale', 'The design serves thousands of concurrent users across many companies: row-locks scoped to one company, indexed company filters, no cross-tenant serialisation.', 'Decision', 'Must', 'Built', []],
  ['Atomic requests', 'Every request is one database transaction: a failure anywhere leaves nothing half-written.', 'Platform', 'Must', 'Built', []],
  ['Real-database automated tests', 'Behaviour is proven by automated tests over real HTTP and real PostgreSQL, with no mocks; every new feature ships with tests.', 'Decision', 'Must', 'Built', []],
  ['Safe releases and environments', 'Live (1.0) and Demo (2.0) are separate tracks; releases run by script with a read-the-plan database step, row-level-security and constraint verification, and a rollback path.', 'Platform', 'Must', 'Built', []],
  ['Maintainable documentation', 'The requirements, design, test and sprint documents of the ledger core are generated from one traceable source and kept in the repository.', 'Decision', 'Must', 'Planned', []],
  ['Promotion to Live', 'The Demo release is promoted to the Live system in a controlled release, with data migration, back-fill and verification on a copy of production first.', 'Decision', 'Must', 'Planned', []],
]);

// ---- Modules built before the finance core (Warraq 1.0 baseline), written as-built from the code and its tests
add("SAL", [
  ["Quotations convert to invoices","A quotation can be created, edited, cancelled and converted into a tax invoice. A converted quotation is final. The conversion is an ordinary invoice and follows every invoice rule (numbering, period locks, e-invoicing).","Platform","Must","Built",[]],
  ["Invoice payments, in part or in full","An invoice can be paid in several payments. Each payment is its own receipt voucher. A payment is limited to the remaining balance; a zero or negative amount, a cancelled invoice, an already paid invoice and a credit note cannot be paid. Only a user with the create right can record a payment, and only in the invoice's own company.","Platform","Must","Built",[]],
  ["Cancelling an invoice","An invoice can be cancelled in an open period; the receipt voucher of a paid invoice is reversed by a reversal voucher, never deleted. An invoice dated in a filed VAT quarter cannot be cancelled; a ZATCA-cleared invoice cannot be cancelled (see BR-ZAT-02).","Platform","Must","Built",[]],
  ["Credit notes","A credit note reverses an invoice. Only one credit note can be raised against an invoice. When the original was paid, the credit note reverses its receipt; when unpaid, no voucher is touched. Credit notes follow the approval rules when one matches.","Platform","Must","Built",[]],
  ["Sales associate on an invoice","An invoice can name the employee who sold it. The employee must belong to the same company and be active; the field is optional.","Platform","Should","Built",[]],
]);

add("EXP", [
  ["Expense payments, in part or in full","An expense can be paid in several payments, each its own payment voucher, never above the remaining balance. Paid or cancelled expenses cannot be paid, and another company's expense is never found.","Platform","Must","Built",[]],
  ["Cancelling an expense","An expense can be cancelled once, by a user with the cancel right. A paid expense is cancelled with a reversal voucher. An expense dated in a filed VAT quarter cannot be cancelled.","Platform","Must","Built",[]],
  ["Recurring templates and accruals","A company keeps recurring expense templates (create, edit, switch off) and accrual entries (edit, cancel). Amounts must be valid; nothing is hard-deleted: a template is deactivated and an accrual cancelled, together with its linked recurring posting.","Platform","Should","Built",[]],
]);

add("PUR", [
  ["Purchase bills from goods receipts","A purchase bill is raised from goods receipt notes of one vendor. Its totals are computed on the server from the receipts, a receipt can be billed only once, a reversed receipt cannot be billed, and only a user with the create right can bill. A bill that matches an approval rule waits for approval.","Platform","Must","Built",[]],
  ["Purchase bill payment and cancellation","A bill can be paid in part and then in full, never above the balance. An unpaid bill can be cancelled, which releases its receipts for re-billing; a bill with a payment cannot be cancelled. A bill dated in a filed VAT quarter cannot be cancelled.","Platform","Must","Built",[]],
  ["Purchase returns","Goods can be returned to a vendor against a receipt: never more than was received or than remains after earlier returns, never against a reversed receipt. A return reduces stock and can be cancelled once (restoring stock). A return cannot be created while the current VAT quarter is filed.","Platform","Must","Built",[]],
  ["Physical stock takes","A stock take snapshots the system quantity on the server and computes the variance. Finalising posts the counted quantity as the stock level, once. A draft can be cancelled; a completed one cannot.","Platform","Must","Built",[]],
  ["Warehouse transfers","Stock moves between warehouses by a dispatch and a receiving. Dispatch deducts the source, receiving adds the quantity actually received, once even under concurrent requests. A dispatch still in transit can be cancelled to restore stock. Branch-restricted users act only on their own warehouses, and cross-company warehouses are refused.","Platform","Must","Built",[]],
]);

add("POS", [
  ["Cashier shifts","A cashier opens and closes a shift, recording actual and expected cash. Shifts are listed and closed only within their own company; opening and closing need the shift right and using the terminal needs the access right.","Platform","Must","Built",[]],
  ["Held sales","A sale in progress can be held and later resumed. Held sales are visible only within their company and need the terminal access right.","Platform","Should","Built",[]],
  ["POS sales are invoices","A POS sale is an ordinary tax invoice and goes through the same e-invoicing pipeline; a POS cancel needs its own permission.","Compliance","Must","Built",[]],
]);

add("ZAT", [
  ["E-invoicing is a per-company switch","E-invoicing is off for a company until its onboarding enables it. With it off, an invoice lands as DISABLED with a real basic QR code and never touches the ZATCA gateway or the hash chain; with it on, the same invoice proceeds.","Compliance","Must","Built",[]],
  ["Cancellation of e-invoiced documents","An invoice that reached ZATCA (cleared or reported) or is being submitted cannot be cancelled; a credit note is the only reversal. An invoice that never reached ZATCA can be cancelled.","Compliance","Must","Built",[]],
  ["Hash-chain integrity","Every document of a company and environment sits on one hash chain that starts at genesis for each new company and environment. Resubmitting the tip reuses its position; resubmitting an earlier document after a later one mints a fresh position; cancelling the tip that never reached ZATCA gives its position back; a cleared document cannot be resubmitted; the issue time is locked once set.","Compliance","Must","Built",[]],
  ["Safe storage of keys and signed documents","ZATCA private keys are encrypted at rest (authenticated encryption, random IV, tamper detection, clear error when the secret is missing or wrong). The signed XML is stored compressed, losslessly, and is served on demand, never in list payloads, and never to another tenant.","Compliance","Must","Built",[]],
]);

add("VAT", [
  ["VAT return figures","A quarterly VAT return is generated from the documents: sales, output VAT, purchases and input VAT, with credit notes netted. The return and the VAT summary report show the same numbers. A generated return can be deleted and regenerated, and a duplicate for the same quarter is refused.","Compliance","Must","Built",[]],
  ["Filing rules","A return cannot be generated or filed while an invoice in its quarter has not completed e-invoicing. Quarters must be filed in order; a filed return is permanently locked.","Compliance","Must","Built",[]],
  ["A filed quarter locks its documents","Once a quarter is filed (and while a generated return freezes it), no invoice, credit note, expense or purchase bill can be created in it, and none can be cancelled or converted into it. Quotations, requisitions, orders and stock takes are not locked.","Compliance","Must","Built",[]],
  ["VAT return rights and isolation","Reading, generating, filing and deleting a return are separate rights, and a company can never see or touch another company's returns.","Compliance","Must","Built",[]],
]);

add("MST", [
  ["Document numbering","Every document type has its own numbering in the PREFIX-1001 style, issued sequentially with no duplicates or gaps even under concurrent requests, per document period, continuing from the legacy counter. Changing the policy needs the right and cannot change e-invoicing settings.","Platform","Must","Built",[]],
  ["Customer and vendor import","Customers and vendors can be loaded from a spreadsheet: a template, validation before saving (a business customer needs a valid VAT number and full address), update of an existing record matched by VAT number or phone, conflict detection, a row cap and the create right.","Platform","Should","Built",[]],
  ["Product import","Products can be loaded from a spreadsheet: template, validation without writing, categories resolved by name in the company, real SKUs assigned, an existing barcode updates instead of duplicating, a row cap and the create right.","Platform","Should","Built",[]],
  ["Master data rights and retirement","Master data uses create, read, update and delete rights, where delete means making a record inactive. Create does not allow editing an existing row and update does not allow creating one; an inactive record cannot be edited. Cancel sets a flag without changing the status and works once.","Platform","Must","Built",[]],
]);

add("ORG", [
  ["Every request belongs to one company","Data returned and written is always for the company of the request: a user sees their own company; only a super-administrator can switch company, and the choice persists in the session. A company can never overwrite another company's customer, invoice, quotation or expense, and reports and dashboards are computed per company.","Platform","Must","Built",[]],
  ["User accounts","Administrators can deactivate and reactivate users of their own company (never their own session), assign roles of the same company only, and a delegated user creating accounts can only create ordinary staff. Passwords need at least six characters with a letter and a digit.","Platform","Must","Built",[]],
  ["Employees and job titles","Employees have a job title, an employee number issued in sequence (width and start configurable) and an optional branch. Duplicate active titles and numbers are refused, a deactivated title cannot be used, and a new login account must link to an active employee once the company has employees.","Platform","Should","Built",[]],
  ["Sessions and sign-in","A session records the user and company at sign-in, expires, and is extended once past half of its lifetime. Only a super-administrator can list sessions across companies.","Platform","Must","Built",[]],
  ["No bulk save of documents","There is no endpoint that overwrites posted documents in bulk. A document is written only through its own route, and a request naming an existing id cannot take over another document's lines.","Platform","Must","Built",[]],
  ["Capital contributions","An investor's capital contribution can be recorded: it creates a receipt voucher and adds to capital contributed, accumulating across contributions. Amounts must be positive, banks active and investors in the company.","Platform","Should","Built",[]],
]);

add("REP", [
  ["Server-side, paged and exact reports","Every register, statement and report is computed on the server for the active company. Long lists are paged in the database with the full count and totals over every row, with a no-paging path for print and export. An end date includes its whole last day, an invalid date is refused, a branch-restricted user never sees other branches, and a user without the report right is refused.","Platform","Must","Built",[]],
  ["Reports agree with the documents and with each other","Profit and loss, cash flow, balance sheet, trial balance, VAT summary, KPI cards, outstanding balances, the dashboard, the stock register and the ledger itself all reconcile to the source documents on a real book of invoices, credit notes, expenses and bills. Refunded money is not counted as collected and credited invoices are not pending.","Platform","Must","Built",[]],
]);

add("CFG", [
  ["Print templates and translations","Each company has its own print templates (create, edit options and layout, activate one per language, delete); only an administrator manages them and no template can be changed across companies. Translations are one shared table managed only by a super-administrator, per key.","Platform","Should","Built",[]],
]);

add("IMP", [
  ["Foreign-currency documents and exchange differences","A purchase document may be in a foreign currency with the rate of its date stored on it. Tax and inventory post in the company currency; a payment at another rate posts the exchange difference; a missing rate is refused.","Blueprint","Must","Planned",[]],
  ["Landed cost","Any number of cost lines (freight, duty, insurance, clearing agent, bank charges) can be added to a goods receipt, each capitalised into stock or expensed by default and overridable, allocated to items by value, quantity or manually, so that the average cost used for cost of sales is the fully landed cost.","Blueprint","Must","Planned",["FR-LC-01","FR-LC-02","FR-LC-04"]],
  ["Customs entry","An import is recorded by a customs entry: customs value, duty and import VAT payable to the customs authority, with the recoverable import VAT posted to input tax and any non-recoverable part added to the stock cost.","Compliance","Must","Planned",[]],
  ["Import of goods is determined automatically","A purchase of goods from a vendor whose profile is foreign is treated as an import of goods without the operator choosing it: the expected duty and import VAT are shown and the customs entry is requested at receipt.","Decision","Must","Planned",[]],
  ["Several payees per shipment","The goods vendor, the freight forwarder, the customs authority, the insurer and the clearing agent each become their own payable, visible in payables aging, none forced onto the goods bill.","Blueprint","Must","Planned",["FR-LC-03"]],
]);

add("FND", [
  ["Accounting events layer","A document raises an accounting event; accounting rules turn the event into balanced ledger lines with a preview and can re-derive them; every existing posting path moves onto this layer without changing its result.","Decision","Must","Planned",[]],
  ["Parallel ledgers","A company can keep more than one ledger (for example IFRS, local statutory, tax) fed by the same events, each with its own rules and period status.","Decision","Must","Planned",[]],
  ["Currency","Transaction, functional and reporting currencies; dated exchange rates; documents in foreign currency store the rate and the amounts in each currency; settlement posts exchange differences; open items and balances are revalued by a run.","Decision","Must","Planned",[]],
  ["Typed business-object references","A ledger line can reference any registered business object (party, item, asset, project, order, property, unit, lease, fund) through one typed, validated mechanism instead of one column per subledger.","Decision","Must","Planned",[]],
  ["Quantities on ledger lines","A ledger line can carry a quantity and unit of measure (hours, units, area) for rates, per-unit cost, capacity and statistical drivers; reports can show quantity and rate as value bases.","Decision","Must","Planned",[]],
  ["Recognition schedules","One schedule engine releases an amount over time or by progress (deferred income, prepaid cost, depreciation, lease income, percentage of completion) through previewed, approved and period-locked runs.","Decision","Must","Planned",[]],
  ["Account determination rules","Rules determine accounts from the transaction type, party class, item class, branch and date (and any registered attribute) so that documents name only who and what; one rule engine serves accounts and tax codes.","Decision","Must","Planned",[]],
  ["Segregation of duties and master-data approval","Conflicting duties are defined and enforced (for example create a vendor and change its bank account), and changes to sensitive master data (bank details, credit limit, tax profile) can require approval.","Decision","Should","Planned",[]],
]);

add("BUD", [
  ["Budget versions","Budgets are held in versions (original, revised, forecast) by account or account group, dimension combination and fiscal period, with optional quantity.","Decision","Must","Planned",[]],
  ["Budget control","A company chooses which dimension types a control applies to and the mode (report, warn or stop; warn by default) at posting, requisition and order.","Decision","Must","Planned",[]],
  ["Commitments","Open requisitions and orders count against the budget with their dimension combination until invoiced.","Decision","Must","Planned",[]],
  ["Budget versus actual reporting","Budget is a value basis of the report designer so that budget, actual, prior year and variance can be shown for any dimension.","Decision","Must","Planned",[]],
]);

export const BRS = R;

// Blueprint requirements that are NOT part of this scope (phase decisions), kept so the whole Blueprint is accounted for.
export const OUT_OF_SCOPE = [
  { ref: 'FR-FA-01..10', text: 'Fixed assets and depreciation (classes, CWIP, methods, runs, disposal, transfer, documents)', why: 'A later phase; the ledger and dimensions are designed not to block it.' },
  { ref: 'FR-LC-01..05', text: 'Landed cost / import costing', why: 'A later phase tied to procurement.' },
  { ref: 'FR-WIP-01..08', text: 'Manufacturing and project work-in-progress costing', why: 'No production module yet.' },
  { ref: '(Blueprint scope)', text: 'Multi-currency, intercompany, payroll calculation', why: 'Declared out of scope by the Blueprint for this phase.' },
  { ref: '(Decision)', text: 'Bank feeds / open-banking integration', why: 'Not requested; statement lines are typed or imported.' },
];
