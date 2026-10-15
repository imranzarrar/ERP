// Business requirement register for General Ledger / Accounts Receivable / Accounts Payable 2.0.
// ONE source: the BRD, the traceability matrix and the roadmap are generated from it (node scripts/build-gl-docs.mjs). Edit here, never in the generated files.
//
// [id, title, requirement (what the business needs), source, priority, status, blueprint FRs]
//   priority  Must | Should | Could            (MoSCoW; "Won't" items are in OUT_OF_SCOPE)
//   status    Built (delivered in Demo 2.0) | Partial (delivered in part; the gap is named in the text) | Planned (in scope, not built yet)
//   source    Blueprint (docs/Finance-Core-Blueprint.pdf) | Decision (a recorded owner decision) | Compliance (ZATCA / VAT / audit) | Standard (tier-1 ERP practice) | Platform

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
  ['Amount-threshold approval rules', 'Approval rules per document type (journal, vendor bill, vendor payment, credit note) by amount, with several sequential levels, server-enforced, with no self-approval at any level and a full approval history; a document without a matching rule posts directly. Delivered so far: vendor payments (Sprint 11); bills, credit notes and journals follow.', 'Blueprint', 'Should', 'Partial', ['FR-APR-01', 'FR-APR-02', 'FR-APR-03', 'FR-APR-04', 'FR-APR-05', 'FR-APR-06']],
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

export const BRS = R;

// Blueprint requirements that are NOT part of this scope (phase decisions), kept so the whole Blueprint is accounted for.
export const OUT_OF_SCOPE = [
  { ref: 'FR-FA-01..10', text: 'Fixed assets and depreciation (classes, CWIP, methods, runs, disposal, transfer, documents)', why: 'A later phase; the ledger and dimensions are designed not to block it.' },
  { ref: 'FR-LC-01..05', text: 'Landed cost / import costing', why: 'A later phase tied to procurement.' },
  { ref: 'FR-WIP-01..08', text: 'Manufacturing and project work-in-progress costing', why: 'No production module yet.' },
  { ref: '(Blueprint scope)', text: 'Multi-currency, intercompany, payroll calculation', why: 'Declared out of scope by the Blueprint for this phase.' },
  { ref: '(Decision)', text: 'Bank feeds / open-banking integration', why: 'Not requested; statement lines are typed or imported.' },
];
