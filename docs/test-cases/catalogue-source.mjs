// The single source of the test-case catalogue. `node scripts/build-test-catalogue.mjs` turns it into CSV (Excel / TestRail / Xray import), JSON, one Gherkin feature file per
// module (Cucumber / Playwright-BDD / Behave) and a readable Markdown. Edit THIS file only; never edit the generated files.
//
// Each case: [title, type, priority, given, when, then, layer, automation]
//   type      Functional | Negative | Boundary | Security | Integration | Regression | Usability | Performance
//   priority  P1 (money, compliance, isolation) | P2 (core flows) | P3 (comfort)
//   layer     API (HTTP only) | DB (direct SQL assertion) | UI (browser) | API+DB | UI+API
//   automation  the vitest file that already automates it ("tests/xxx.test.ts"), or "Candidate" (can be automated as written) or "Manual" (needs eyes: print layout, RTL look).
// Conventions: money in SAR with 2 decimals; "today" is the server clock; every scenario runs in its own throw-away company unless it says otherwise.

export const MODULES = [
  { id: 'PC', name: 'Posting control and period locks', ref: 'docs/posting-control.md; Blueprint FR-PER' },
  { id: 'DT', name: 'Document date standard', ref: 'docs/date-fields-standard.md' },
  { id: 'COA', name: 'Chart of accounts and account mapping', ref: 'Blueprint FR-COA' },
  { id: 'JV', name: 'Manual journals and approval', ref: 'Blueprint FR-JE' },
  { id: 'OPN', name: 'Opening balances', ref: 'Blueprint FR-JE' },
  { id: 'DIM', name: 'Dimensions (branch, department, custom)', ref: 'Blueprint FR-DIM' },
  { id: 'RPT', name: 'Ledger reports and the report designer', ref: 'Blueprint FR-RPT' },
  { id: 'APR', name: 'Approval rules (Sprint 11)', ref: 'Blueprint FR-APR-01..06; docs/gl-ap-ar/s11-approval-rules-tier1-research.md' },
  { id: 'AR', name: 'Receivables: invoices and credit notes', ref: 'Blueprint FR-AR, FR-APR-06' },
  { id: 'RCP', name: 'Customer receipts (Receive Payment)', ref: 'Blueprint FR-AR-01' },
  { id: 'AP', name: 'Payables: expenses, bills and returns', ref: 'Blueprint FR-AP-01..02' },
  { id: 'PAY', name: 'Vendor payments (Pay Vendor)', ref: 'Blueprint FR-AP-03' },
  { id: 'SUB', name: 'Customer and vendor subledgers', ref: 'Blueprint FR-AR-02, FR-AP-04' },
  { id: 'BNK', name: 'Bank reconciliation', ref: 'Blueprint FR-BANK-01..05' },
  { id: 'PRT', name: 'Voucher and posting print-outs', ref: 'docs/ar-ap-bank-design.md decision 6' },
  { id: 'XR', name: 'Document reports and statements (legacy, document-based)', ref: 'server/lib/financialReports.ts' },
  { id: 'SEC', name: 'Security, permissions and tenant isolation', ref: 'rls-tenant-isolation skill; permission-crud-model skill' },
  { id: 'I18N', name: 'Arabic / Urdu and right-to-left', ref: 'ux-translation skill' },
  { id: 'NFR', name: 'Performance, concurrency and resilience', ref: 'erp_saas_scale_priority' },
  { id: 'REL', name: 'Release and data migration', ref: 'deploy/release-demo.sh; deploy/release.sh' },
];

const T = {};
const add = (m, rows) => { T[m] = rows; };

add('PC', [
  ['A posting dated on or before the lock date is refused for every document type', 'Negative', 'P1', 'A lock date of the last day of last month is set', 'An invoice, expense, receipt, vendor payment, bank adjustment and manual journal are each dated on the lock date', 'Every one is refused with the lock-date message and nothing is written (no voucher, no ledger line)', 'API+DB', 'tests/postingControl.test.ts'],
  ['A posting the day after the lock date is accepted', 'Boundary', 'P1', 'A lock date is set', 'An invoice is dated lock date + 1 day', 'It posts normally', 'API', 'tests/postingControl.test.ts'],
  ['Cancelling an old document posts on the cancellation date and is also guarded', 'Negative', 'P1', 'An invoice from a locked period exists', 'It is cancelled with a reversal date inside the locked period', 'The cancellation is refused; with an open reversal date it succeeds', 'API', 'tests/postingControl.test.ts'],
  ['Only the override-lock permission lets a posting through the lock date, and it is audited', 'Security', 'P1', 'A user holds postingControl.overrideLock, another does not', 'Both post into the locked period', 'The first posts and an audit entry names it; the second is refused', 'API+DB', 'Candidate'],
  ['Back-date window: today passes, N days back passes, N+1 days back is refused', 'Boundary', 'P1', 'Maximum back-date days = 7', 'Documents are dated today, today-7, today-8', 'The first two post; the third is refused', 'API', 'tests/postingControl.test.ts'],
  ['A holder of the back-date permission may go past the window and an audit entry is written', 'Security', 'P1', 'Window = 7, user holds postingControl.backDate', 'The user posts a document dated 30 days back', 'It posts; the audit log has BACKDATED_POSTING with the reason', 'API+DB', 'tests/postingControl.test.ts'],
  ['A reason is required once an entry is older than the reason threshold', 'Negative', 'P1', 'Reason after 3 days', 'A document dated 5 days back is posted without a reason, then with one', 'The first is refused; the second posts and keeps the reason on the document and in the audit log', 'API+DB', 'tests/postingControl.test.ts'],
  ['The rules judge the posting date, not the document date', 'Functional', 'P1', 'Window = 7', 'A document is dated 30 days back but its posting date is today', 'It posts (the ledger date is within the window)', 'API', 'tests/postingControl.test.ts'],
  ['The same rules apply to expenses, payments and journals, not only invoices', 'Integration', 'P1', 'A lock date and a window are set', 'An expense, a payment and a manual journal are dated outside them', 'All three are refused', 'API', 'tests/postingControl.test.ts'],
  ['No policy means no restriction beyond the open fiscal month', 'Regression', 'P2', 'A company has never set a policy', 'Documents are dated anywhere in an open month', 'They post', 'API', 'tests/postingControl.test.ts'],
  ['The policy can be read by everyone but changed only with its own permission', 'Security', 'P1', 'A read-only user and an editor exist', 'Both try to save a new policy', 'Only the editor succeeds; invalid values (negative days, bad date) are refused for both', 'API', 'tests/postingControl.test.ts'],
  ['A closed fiscal month refuses every posting dated in it; reopening allows them', 'Negative', 'P1', 'October is closed', 'An invoice, receipt and journal dated in October are posted; October is then reopened and they are posted again', 'Refused while closed, accepted when open', 'API', 'tests/periodStory.test.ts'],
  ['A filed VAT quarter refuses VAT-touching postings but accepts others', 'Negative', 'P1', 'Q3 VAT return is filed', 'A VAT invoice and a non-VAT journal are dated in Q3', 'The invoice is refused; the journal posts', 'API', 'Candidate'],
  ['A frozen (not yet filed) VAT quarter refuses VAT journals', 'Negative', 'P2', 'Q3 is frozen', 'A manual journal touching a VAT account is dated in Q3', 'It is refused at submit and at approval', 'API', 'tests/ledgerJournals.test.ts'],
  ['The Posting Control screen shows the current rules and saves changes', 'Functional', 'P2', 'A user with postingControl.update opens the screen', 'They set a lock date and save', 'The new date shows after reload and the next posting obeys it', 'UI', 'Manual'],
  ['The Posting Control screen is read-only for a user without update permission', 'Usability', 'P3', 'A user with postingControl.read only', 'They open the screen', 'Fields are disabled and no Save button is offered', 'UI', 'Manual'],
  ['A policy change in company A never affects company B', 'Security', 'P1', 'Two companies', 'A sets a lock date', 'B can still post in that period', 'API', 'Candidate'],
  ['The bank-reconciliation fee entry obeys the lock date and the back-date window', 'Integration', 'P1', 'A lock date after the statement date', 'A bank charge is posted from a reconciliation dated before the lock', 'It is refused', 'API', 'Candidate'],
  ['A receipt or vendor payment dated in a locked period is refused', 'Negative', 'P1', 'A lock date is set', 'A receipt and a payment are dated inside it', 'Both are refused', 'API', 'tests/settlements.test.ts'],
]);

add('DT', [
  ['A document with only a document date gets the same posting date', 'Functional', 'P1', 'An invoice is created with docDate only', 'It is saved', 'posting_date equals doc_date', 'API+DB', 'Candidate'],
  ['A document posted into a later period keeps its own document date', 'Functional', 'P1', 'docDate = 5 Oct, postingDate = 2 Nov', 'The invoice is saved', 'Operational reports place it on 5 Oct; financial statements on 2 Nov', 'API', 'tests/postingControl.test.ts'],
  ['Operational reports (sales register, customer statement) use the document date', 'Functional', 'P2', 'Invoices with different doc and posting dates', 'The sales register is run for October', 'Rows are selected by doc_date', 'API', 'Candidate'],
  ['Financial statements (trial balance, balance sheet, VAT) use the posting date', 'Functional', 'P1', 'As above', 'The trial balance is run for October', 'Amounts are selected by posting_date', 'API', 'Candidate'],
  ['The API no longer accepts the retired date field', 'Regression', 'P1', 'A client sends {date: ...} to create an invoice or expense', 'The request is processed', 'The retired field is ignored or refused; docDate is required', 'API', 'tests/createRouteFieldAllowList.test.ts'],
  ['An invalid date string is refused on every dated endpoint', 'Negative', 'P2', 'Documents are posted with 2026-13-45, empty, and non-date text', 'Each is submitted', 'A clear 400 message; nothing is written', 'API', 'Candidate'],
  ['Created-by and created-at are stamped on every document and a later edit stamps updated-by / updated-at', 'Functional', 'P2', 'A document is created then edited by another user', 'Both rows are read', 'created_* belongs to the first user, updated_* to the second', 'API+DB', 'Candidate'],
  ['A document entered just before and just after midnight keeps the date the user chose', 'Boundary', 'P2', 'A document is dated today at 23:59 and at 00:01 local time', 'Both are saved', 'Each keeps its chosen date (no timezone shift)', 'API', 'Candidate'],
  ['Every renamed date column exists once in the live schema and no old name remains', 'Regression', 'P1', 'A migrated database', 'information_schema is queried for date / posting_date columns', 'Names follow docs/date-fields-standard.md; no table still has a plain "date" column', 'DB', 'Candidate'],
  ['Date columns are Postgres date, not timestamp, for business dates', 'Regression', 'P2', 'A migrated database', 'Column types are read', 'doc_date, posting_date and the <meaning>_date columns are of type date', 'DB', 'Candidate'],
]);

add('COA', [
  ['A new company gets the standard chart with every posting role mapped once and an account for its bank', 'Functional', 'P1', 'A company is created', 'Its chart is read', 'The Saudi starter chart exists, 16 posting roles are mapped once, the bank has its own account', 'API+DB', 'tests/ledgerAccounts.test.ts'],
  ['Company A never sees company B accounts', 'Security', 'P1', 'Two companies', 'B lists accounts', 'Only B accounts appear', 'API', 'tests/ledgerAccounts.test.ts'],
  ['A read-only role can list but not create, edit, deactivate, import, export or map', 'Security', 'P1', 'A role with chartOfAccounts.read only', 'Each action is attempted', 'Each write is refused with 403', 'API', 'tests/ledgerAccounts.test.ts'],
  ['A user with no ledger keys is refused the account list', 'Security', 'P2', 'A user with no chart permission', 'They list accounts', '403', 'API', 'tests/ledgerAccounts.test.ts'],
  ['Create an account under a heading', 'Functional', 'P1', 'A heading exists', 'A new account is created under it', 'It saves with the next level and the parent total includes it', 'API', 'tests/ledgerAccounts.test.ts'],
  ['Duplicate account code is refused', 'Negative', 'P1', 'Code 6500 exists', 'Another account is created with 6500', '400 duplicate code', 'API', 'tests/ledgerAccounts.test.ts'],
  ['A parent of a different type or a non-heading parent is refused', 'Negative', 'P2', 'An expense account', 'A revenue account is created under it', 'Refused', 'API', 'tests/ledgerAccounts.test.ts'],
  ['Tree depth: four levels are accepted, a fifth is refused', 'Boundary', 'P2', 'A chart with four nested headings', 'A fifth level is created', 'The limit message is shown', 'API', 'Candidate'],
  ['A parent cannot become its own descendant (loop)', 'Negative', 'P2', 'A heading with children', 'The heading is re-parented under its own child', 'Refused', 'API', 'Candidate'],
  ['An account with postings cannot change type', 'Negative', 'P1', 'An account with ledger lines', 'Its type is changed', 'Refused; name and code may still change', 'API', 'tests/ledgerAccounts.test.ts'],
  ['A control account can be renamed but not retyped or deactivated', 'Negative', 'P1', 'The receivable control account', 'It is retyped / deactivated', 'Refused', 'API', 'tests/ledgerAccounts.test.ts'],
  ['An account with a balance cannot be deactivated; a zero-balance one can, and can be reactivated', 'Boundary', 'P1', 'Two accounts, one with a balance', 'Each is deactivated', 'Only the zero-balance one succeeds', 'API', 'tests/ledgerAccounts.test.ts'],
  ['A heading with active children cannot be deactivated', 'Negative', 'P2', 'A heading with active children', 'It is deactivated', 'Refused', 'API', 'tests/ledgerAccounts.test.ts'],
  ['Pointing a posting role at another account is not retroactive', 'Regression', 'P1', 'Invoices posted to account X', 'The role is mapped to account Y', 'Old lines stay on X, new ones go to Y', 'API+DB', 'tests/ledgerAccounts.test.ts'],
  ['A bank line posts to the bank own account', 'Integration', 'P1', 'Two banks', 'A receipt is posted to each', 'Each line is on its own bank account', 'API+DB', 'tests/ledgerAccounts.test.ts'],
  ['The database refuses a line that points at another company account', 'Security', 'P1', 'Two companies', 'An insert links a line of A to an account of B', 'The composite foreign key rejects it', 'DB', 'tests/ledgerAccounts.test.ts'],
  ['Expense categories start on a default account and can be re-pointed to an Expense account only', 'Functional', 'P2', 'A category', 'It is mapped to a revenue account, then to an expense account', 'Refused, then accepted', 'API', 'tests/ledgerAccounts.test.ts'],
  ['Excel import previews first and saves only the chosen rows, never changing a type', 'Functional', 'P2', 'A valid import file', 'It is previewed, 2 of 5 rows are selected and saved', 'Only those 2 are created; existing types are untouched', 'API', 'tests/ledgerAccounts.test.ts'],
  ['A file with the wrong columns is refused; a reader may neither import nor export', 'Negative', 'P2', 'A wrong file; a read-only user', 'Import / export are attempted', 'Refused', 'API', 'tests/ledgerAccounts.test.ts'],
  ['An ordinary account becomes a customer or vendor control account only if it fits and has no postings', 'Functional', 'P1', 'An asset account without postings', 'It is made a customer control account; then one with postings', 'The first succeeds, the second is refused', 'API', 'tests/ledgerPostingProfile.test.ts'],
  ['Arabic account names show on Arabic documents and the chart', 'Usability', 'P3', 'An account with an Arabic name', 'The UI language is Arabic', 'The Arabic name is shown', 'UI', 'Manual'],
  ['Expense accounts picked in a bank reconciliation exclude headings, control and inactive accounts', 'Functional', 'P2', 'A chart with each kind', 'The adjustment account list is read', 'Only active, postable expense and revenue accounts are offered', 'API', 'tests/bankReconciliation.test.ts'],
]);

add('JV', [
  ['A draft saves with a number and refuses control, bank, heading, inactive, foreign and malformed lines', 'Negative', 'P1', 'A preparer', 'A draft is saved with each bad line', 'Each is refused with a line-specific message', 'API', 'tests/ledgerJournals.test.ts'],
  ['A user without journals.create cannot draft', 'Security', 'P1', 'An approver only', 'They draft', '403', 'API', 'tests/ledgerJournals.test.ts'],
  ['A draft can be edited (lines replaced) only with the update key', 'Functional', 'P2', 'A draft', 'It is edited with and without the key', 'Allowed / 403', 'API', 'tests/ledgerJournals.test.ts'],
  ['An unbalanced journal cannot be submitted', 'Negative', 'P1', 'Debits 100, credits 90', 'Submit', 'Refused with the difference shown', 'API', 'tests/ledgerJournals.test.ts'],
  ['A line with both debit and credit, or neither, is refused', 'Negative', 'P1', 'Lines with 10/10 and 0/0', 'Save', 'Refused', 'API', 'tests/ledgerJournals.test.ts'],
  ['Negative and absurdly large amounts are refused', 'Boundary', 'P2', 'Amounts -5 and 1e15', 'Save', 'Refused', 'API', 'Candidate'],
  ['Submit moves the draft to pending and locks it from editing', 'Functional', 'P1', 'A draft', 'Submit then edit', 'Edit refused', 'API', 'tests/ledgerJournals.test.ts'],
  ['Approval by someone else posts it to the ledger exactly once', 'Functional', 'P1', 'A pending journal', 'A different approver approves, then approves again', 'One ledger entry; the second approval is refused', 'API+DB', 'tests/ledgerJournals.test.ts'],
  ['Two approvers approve at the same moment: one entry only', 'Boundary', 'P1', 'A pending journal', 'Two approve requests run in parallel', 'One succeeds, one is refused, one ledger entry exists', 'API+DB', 'Candidate'],
  ['The preparer cannot approve their own journal unless the owner allows self-approval', 'Security', 'P1', 'Self-approval off', 'The preparer approves', 'Refused; after the owner enables it, allowed and flagged self-approved', 'API', 'tests/ledgerJournals.test.ts'],
  ['Only the owner / admin may change the self-approval setting', 'Security', 'P1', 'A non-admin approver', 'They change the setting', '403', 'API', 'tests/ledgerJournals.test.ts'],
  ['Rejection needs a reason and returns the journal to the preparer', 'Functional', 'P1', 'A pending journal', 'Reject without, then with a reason', 'Refused, then rejected; the preparer can fix and resubmit', 'API', 'tests/ledgerJournals.test.ts'],
  ['A month closed after submission blocks approval', 'Negative', 'P1', 'A pending journal dated in an open month', 'The month is closed, then the journal is approved', 'Refused', 'API', 'tests/ledgerJournals.test.ts'],
  ['Discarding a draft keeps its number on record; a posted journal cannot be discarded', 'Functional', 'P2', 'A draft and a posted journal', 'Each is discarded', 'First succeeds (number kept), second refused', 'API', 'tests/ledgerJournals.test.ts'],
  ['Reversal creates a reversing draft that itself needs approval and posts the mirror once', 'Functional', 'P1', 'A posted journal', 'Reverse, approve, reverse again', 'Mirror posted; second reversal refused', 'API+DB', 'tests/ledgerJournals.test.ts'],
  ['A discarded reversal frees the original to be reversed again', 'Functional', 'P2', 'A reversal draft', 'It is discarded', 'The original can be reversed again', 'API', 'tests/ledgerJournals.test.ts'],
  ['A document-made entry has no manual journal to reverse', 'Negative', 'P2', 'An invoice entry', 'Reverse is attempted from the journal screen', 'Refused with a pointer to the document', 'API', 'tests/ledgerJournals.test.ts'],
  ['The journal list filters by status, date and text and pages', 'Functional', 'P3', 'Many journals', 'Filters and paging are applied', 'Correct subsets and totals', 'API', 'tests/ledgerJournals.test.ts'],
  ['A posted entry shows its accounts and is invisible to another company', 'Security', 'P1', 'Two companies', 'B opens A entry', '404', 'API', 'tests/ledgerJournals.test.ts'],
  ['A back-dated journal beyond the reason threshold needs a reason that is kept', 'Integration', 'P1', 'Reason rule on', 'A journal dated 10 days back is submitted', 'Reason required; stored on the journal', 'API', 'tests/postingControl.test.ts'],
  ['Journal numbers are unique per company and never reused', 'Regression', 'P2', 'Drafts created and discarded', 'More drafts are created', 'Numbers keep increasing; a discarded number is not reused', 'API', 'Candidate'],
  ['Row-level security hides other companies manual journals even without a WHERE clause', 'Security', 'P1', 'Two companies', 'The tenant role selects all journals', 'Only its own rows', 'DB', 'tests/ledgerJournals.test.ts'],
  ['Journal voucher print data exists for a manual journal and the entry it posted', 'Functional', 'P2', 'A posted journal', 'print-data is requested for both', 'Same number, lines and totals; another company gets 404', 'API', 'tests/ledgerJournals.test.ts'],
  ['The journal form keeps typed data when a validation error is shown', 'Usability', 'P3', 'A journal with 5 lines', 'Save fails on line 3', 'All lines remain on screen with the error beside line 3', 'UI', 'Manual'],
]);

add('OPN', [
  ['Eligible accounts exclude control accounts but include banks with their own opening figure', 'Functional', 'P2', 'A company', 'The opening sheet is opened', 'Control accounts are absent; each bank shows its opening balance', 'API', 'tests/ledgerJournals.test.ts'],
  ['A preview does not save and refuses control, P&L, heading and foreign accounts', 'Negative', 'P1', 'A sheet with bad rows', 'Preview', 'Errors listed; nothing saved', 'API', 'tests/ledgerJournals.test.ts'],
  ['An unbalanced sheet cannot be posted until the difference goes to an Equity account', 'Negative', 'P1', 'Debits exceed credits', 'Post', 'Refused; accepted when the equity plug line is added', 'API', 'tests/ledgerJournals.test.ts'],
  ['Opening posts once, needs the post key and a confirmation', 'Security', 'P1', 'A valid sheet', 'Post without key / without confirmation / twice', 'Each wrong attempt refused; second live run refused', 'API', 'tests/ledgerJournals.test.ts'],
  ['A wrong opening entry can be reversed with a reason and a corrected one accepted', 'Functional', 'P2', 'A posted opening', 'Reverse then post again', 'Both succeed', 'API', 'tests/ledgerJournals.test.ts'],
  ['The opening balance sheet figure flows into the first period reports', 'Integration', 'P1', 'Opening posted', 'Balance sheet is run at the opening date', 'Totals equal the opening sheet and balance', 'API', 'Candidate'],
]);

add('DIM', [
  ['Branch and Department are seeded for every company and offered to pickers', 'Functional', 'P1', 'A new company', 'Dimension types are listed', 'Branch and Department exist', 'API', 'tests/ledgerDimensions.test.ts'],
  ['Custom dimensions can be added; duplicates are refused', 'Functional', 'P2', 'A company', 'Project is added twice', 'Second refused', 'API', 'tests/ledgerDimensions.test.ts'],
  ['Seeded dimensions can never be removed or re-sourced', 'Negative', 'P1', 'Branch dimension', 'Delete / change source', 'Refused', 'API', 'tests/ledgerDimensions.test.ts'],
  ['A value tree refuses loops, foreign parents and non-hierarchical nesting', 'Negative', 'P2', 'A dimension with values', 'Bad re-parenting', 'Refused', 'API', 'tests/ledgerDimensions.test.ts'],
  ['Cost centres have an optional home branch, hierarchy and the same guards', 'Functional', 'P2', 'Branches exist', 'Cost centres are built', 'Hierarchy and home branch work; loops refused', 'API', 'tests/ledgerDimensions.test.ts'],
  ['A rule on one account sets optional / required / not allowed with an optional default', 'Functional', 'P1', 'An expense account', 'A Required Department rule is set', 'Saved; headings and foreign accounts refused', 'API', 'tests/ledgerDimensions.test.ts'],
  ['A rule applies to a type, heading, range or list with a preview first', 'Functional', 'P2', 'Many accounts', 'Bulk rule is previewed then applied', 'Preview count equals applied count', 'API', 'tests/ledgerDimensions.test.ts'],
  ['A Required tag missing blocks submit but not draft save', 'Negative', 'P1', 'A Required rule', 'Draft saved; submit attempted; tag added; submit', 'Draft ok; submit refused; then accepted and posted once', 'API', 'tests/ledgerDimensions.test.ts'],
  ['A tag the account does not allow, an unknown, foreign or inactive value is refused', 'Negative', 'P1', 'Rules', 'Journals with each bad tag', 'Refused', 'API', 'tests/ledgerDimensions.test.ts'],
  ['Equal tags on several lines share one combination', 'Functional', 'P3', 'A journal with two lines tagged equally', 'Posted', 'One dimension combination row', 'API+DB', 'tests/ledgerDimensions.test.ts'],
  ['A reversal carries the original tags; an account default fills a missing tag', 'Functional', 'P2', 'A tagged journal', 'Reverse', 'Mirror lines keep tags', 'API', 'tests/ledgerDimensions.test.ts'],
  ['Documents apply defaults but never block on a Required rule', 'Regression', 'P1', 'An invoice for an account with a Required rule', 'The invoice is posted', 'It posts; defaults fill; no blocking', 'API', 'tests/ledgerDimensions.test.ts'],
  ['The database refuses a dimension entry pointing at another company value', 'Security', 'P1', 'Two companies', 'Cross insert', 'Composite FK rejects', 'DB', 'tests/ledgerDimensions.test.ts'],
  ['Branch-restricted user only sees entries of their own branches in ledger reads', 'Security', 'P1', 'A user restricted to branch X', 'General ledger and journals are read', 'Only branch X entries (entries with no branch are hidden)', 'API', 'Candidate'],
]);

add('RPT', [
  ['Every company has the five standard reports as editable defaults; another company sees none of them', 'Functional', 'P1', 'A new company', 'Report definitions are listed', 'Trial Balance, Income Statement, Balance Sheet, Cash Flow, Changes in Equity exist', 'API', 'tests/ledgerReportEngine.test.ts'],
  ['Income Statement: revenue positive, subtotals and formulas follow, comparatives and variance tie', 'Functional', 'P1', 'Revenue and expenses posted in two periods', 'Run with a prior period', 'Net profit and variance columns reconcile', 'API', 'tests/ledgerReportEngine.test.ts'],
  ['Balance Sheet balances, carries profit to date in equity, compares with the prior year end', 'Functional', 'P1', 'Postings across a year end', 'Run at date', 'Assets = liabilities + equity', 'API', 'tests/ledgerReportEngine.test.ts'],
  ['Trial Balance balances in opening, movement and closing, in Summary and Detailed mode', 'Functional', 'P1', 'Postings', 'Run both modes', 'Debit totals equal credit totals in each column', 'API', 'tests/ledgerReportEngine.test.ts'],
  ['A viewer needs the report own permission; designer permissions do not give it', 'Security', 'P1', 'A designer without view', 'Run a report', '403', 'API', 'tests/ledgerReportEngine.test.ts'],
  ['Cash Flow (indirect) explains the change in cash and agrees with bank and cash accounts', 'Integration', 'P1', 'Cash movements', 'Run for a period', 'Net change equals the bank account change', 'API', 'tests/ledgerReportEngine.test.ts'],
  ['Changes in Equity: opening + profit + movements = closing equity', 'Functional', 'P1', 'Capital and profit', 'Run', 'Closing equals balance sheet equity', 'API', 'tests/ledgerReportEngine.test.ts'],
  ['A row can pin to the opening balance; the Cash selector finds every bank account', 'Functional', 'P2', 'Several banks', 'Design a row with the Cash selector', 'All bank accounts included once', 'API', 'tests/ledgerReportEngine.test.ts'],
  ['Copy a standard report, edit it; only a designer can', 'Security', 'P2', 'A designer and a viewer', 'Both edit', 'Only the designer succeeds', 'API', 'tests/ledgerReportEngine.test.ts'],
  ['Account selection by range, rollup, type and role, include and exclude; double counting refused', 'Negative', 'P2', 'A design counting an account twice', 'Save', 'Refused', 'API', 'tests/ledgerReportEngine.test.ts'],
  ['Every balance display rule, subtotal, formula, hidden and non-zero row works', 'Functional', 'P2', 'A custom design', 'Run', 'Each rule shows as specified', 'API', 'tests/ledgerReportEngine.test.ts'],
  ['Every column option: debit / credit / opening / closing, Dr/Cr pairs, ranges, variance columns', 'Functional', 'P2', 'A custom design', 'Run', 'Values per option are correct', 'API', 'tests/ledgerReportEngine.test.ts'],
  ['Dimension filters on columns give a branch comparison; on the run they narrow the report', 'Functional', 'P2', 'Tagged postings', 'Run with filters', 'Totals match the filtered ledger', 'API', 'tests/ledgerReportEngine.test.ts'],
  ['Accounts no row covers are listed with a warning count', 'Functional', 'P2', 'A design that omits accounts', 'Run', 'Warning lists the uncovered accounts', 'API', 'tests/ledgerReportEngine.test.ts'],
  ['Malformed formatting is refused; default can be set; deactivate and reset work', 'Negative', 'P3', 'A design', 'Save with bad formatting', 'Refused', 'API', 'tests/ledgerReportEngine.test.ts'],
  ['Every figure drills down to the accounts and the General Ledger reproduces it', 'Integration', 'P1', 'A report figure', 'Drill down', 'The ledger lines sum to the figure', 'API', 'tests/ledgerReportEngine.test.ts'],
  ['Excel export carries bold, double underline, shading and number formats', 'Functional', 'P3', 'A report', 'Export', 'The workbook has the formatting', 'API', 'tests/ledgerReportEngine.test.ts'],
  ['General Ledger: opening, movements, running balance and closing add up', 'Functional', 'P1', 'Postings in and before the period', 'Run for one account', 'Opening + movements = closing; running balance ends at closing', 'API', 'tests/ledgerJournals.test.ts'],
  ['Ledger vs Documents separates manual journals from document postings and agrees to the cent', 'Integration', 'P1', 'Documents and manual journals', 'Run the comparison', 'Every account pair agrees; manual entries are listed apart', 'API', 'tests/ledgerJournals.test.ts'],
  ['Money held on account is compared like with like in Ledger vs Documents', 'Integration', 'P1', 'A receipt held on account', 'Run the comparison', 'AR agrees after netting customer advances', 'API', 'tests/settlements.test.ts'],
  ['The consistency check passes all error-level rules after a day of mixed activity', 'Integration', 'P1', 'Invoices, receipts, payments, journals, bank reconciliation', 'The consistency check runs', 'No error-level failure', 'API', 'tests/bankReconciliation.test.ts'],
  ['A report over 100000 ledger lines returns within the agreed time', 'Performance', 'P2', 'A company with 100000 lines', 'Trial balance and general ledger are run', 'Under 5 seconds each', 'API', 'Candidate'],
  ['Branch-restricted users see branch totals only and are told so', 'Security', 'P1', 'A restricted user', 'Run a report', 'Figures cover their branches; the notice is shown', 'UI+API', 'Candidate'],
]);

add('APR', [
  ['A document with no matching rule posts directly', 'Regression', 'P1', 'A company with no approval rules', 'A vendor payment and a vendor bill are created', 'Both post immediately, exactly as before', 'API', 'tests/approvals.test.ts'],
  ['A payment inside a rule band enters Pending Approval and posts nothing', 'Functional', 'P1', 'A rule: payments above 5000 need one approval', 'A payment of 6000 is submitted', 'No voucher, no ledger entry, no bank movement; the document is Pending Approval', 'API+DB', 'tests/approvals.test.ts'],
  ['Amount band boundaries: exactly at the threshold and just above it', 'Boundary', 'P1', 'Threshold 5000', 'Payments of 5000.00 and 5000.01', 'The first follows the rule defined for its band, the second the next band, with no gap or overlap', 'API', 'tests/approvals.test.ts'],
  ['A two-level chain needs both approvals in order', 'Functional', 'P1', 'A rule with level 1 (accountant role) and level 2 (finance manager)', 'Level 2 tries first, then level 1 approves, then level 2', 'Level 2 first is refused; after level 1 then level 2 the payment posts once', 'API+DB', 'tests/approvals.test.ts'],
  ['The submitter cannot approve while self-approval is off', 'Security', 'P1', 'The company setting is off', 'The submitter approves their own payment, bill, credit note and journal', 'Each is refused server-side at every level', 'API', 'tests/approvals.test.ts'],
  ['With self-approval on the submitter may approve and the document is flagged', 'Functional', 'P1', 'The company setting is on (changed by the owner, audited)', 'The submitter approves their own payment', 'It posts; flagged self-approved; the audit log shows the setting change and the use', 'API+DB', 'tests/approvals.test.ts'],
  ['Only owner/admin may change the self-approval setting', 'Security', 'P1', 'A finance manager without admin rights', 'They change the setting', '403; the setting is unchanged', 'API', 'tests/approvals.test.ts'],
  ['A manager of the submitter can be the approver', 'Functional', 'P2', 'A user with a manager; a level naming manager of the submitter', 'The submitter submits; the manager approves', 'Only that manager (or a valid delegate) may approve', 'API', 'tests/approvals.test.ts'],
  ['Rejection returns the document to draft with remarks and nothing posts', 'Functional', 'P1', 'A pending payment', 'An approver rejects without, then with remarks', 'Refused without remarks; with remarks the document is Draft and the history shows them', 'API+DB', 'tests/approvals.test.ts'],
  ['Editing a pending document recalls it; raising the amount restarts approval', 'Functional', 'P2', 'A payment pending at level 2 after level 1 approved', 'The amount is raised', 'Approval restarts from level 1 and earlier approvals no longer count', 'API', 'Candidate'],
  ['A delegate with a valid period may decide; outside it may not', 'Functional', 'P2', 'A delegation from manager to deputy for 3 days', 'The deputy approves inside and after the period', 'Allowed inside, refused after; both recorded with the delegator', 'API', 'Candidate'],
  ['The posting guard is re-checked at final approval and tenant isolation holds', 'Security', 'P1', 'A pending payment dated before a lock date set after submission; two companies', 'The last level approves; company B calls company A requests', 'Posting is refused by the guard; company B gets 404 and sees none of the rules or requests', 'API', 'tests/approvals.test.ts'],
  ['A vendor bill follows the same rules: above the band it waits and creates nothing, the last approval creates it once', 'Functional', 'P1', 'A rule for vendor bills above 500', 'A bill of 100 and a bill of 1150 are submitted; the submitter and then the level holder try to approve', 'The small bill posts; the large one waits (no bill, GRN unbilled); the submitter is refused; the approver creates the bill and the GRN is billed', 'API+DB', 'tests/approvals.test.ts'],
  ['The "paid at delivery" shortcut cannot bypass an approval rule', 'Security', 'P1', 'A rule for vendor bills above 500', 'A goods receipt of 1150 is saved with auto-post-bill-and-pay; then with no rule', 'It is refused whole (no receipt kept) with the rule named; with no rule it is allowed', 'API+DB', 'tests/approvals.test.ts'],
]);

add('AR', [
  ['An invoice posts Dr receivable, Cr revenue and VAT output, the receivable line tagged with the customer', 'Functional', 'P1', 'A customer and an item', 'An invoice of 1000 + 15% VAT is created', 'Entry: AR 1150 Dr (customer tag), revenue 1000 Cr, VAT 150 Cr', 'API+DB', 'tests/ledgerSubledger.test.ts'],
  ['An invoice for a customer with a posting profile uses the profile control account and tags', 'Functional', 'P1', 'A customer with a control account and default dimensions', 'An invoice is posted', 'The receivable line is on that account with those tags', 'API+DB', 'tests/ledgerPostingProfile.test.ts'],
  ['A credit note reverses revenue and VAT and keeps the customer tag', 'Functional', 'P1', 'An invoice', 'A credit note is raised', 'Mirror entry; customer balance falls', 'API+DB', 'tests/ledgerSubledger.test.ts'],
  ['A paid invoice cannot be cancelled once ZATCA cleared it; a credit note is the only way', 'Security', 'P1', 'A cleared invoice', 'Cancel is attempted', 'Refused', 'API', 'Candidate'],
  ['Cancelling an unpaid invoice reverses its entry on the cancellation date', 'Functional', 'P1', 'An unpaid invoice', 'Cancel', 'Reversal entry; customer balance zero', 'API+DB', 'tests/ledgerPostingProfile.test.ts'],
  ['An invoice with a header discount posts the discounted revenue and correct VAT', 'Functional', 'P1', 'Discount 10%', 'Create', 'Revenue and VAT computed after discount', 'API+DB', 'Candidate'],
  ['An invoice for a stock item also posts cost of goods sold and relieves inventory', 'Integration', 'P1', 'A stocked item with average cost', 'Sell it', 'COGS Dr and inventory Cr at the average cost', 'API+DB', 'Candidate'],
  ['Invoice payment status moves Unpaid, Partially Paid, Paid with amounts', 'Functional', 'P1', 'An invoice', 'Pay 40%, then the rest', 'Status and amount_paid follow', 'API', 'tests/invoicePaidRoute.test.ts'],
  ['A payment larger than the outstanding amount on the invoice route is refused', 'Negative', 'P1', 'An invoice with 100 outstanding', 'Pay 150', 'Refused', 'API', 'tests/invoicePaidRoute.test.ts'],
  ['A B2B invoice with missing buyer fields is refused for ZATCA; B2C is accepted', 'Negative', 'P1', 'A B2B customer without VAT number', 'Create an invoice', 'Refused with the missing field named', 'API', 'Candidate'],
  ['Invoice numbering is gap-free per company and per year rule', 'Regression', 'P2', 'Several invoices', 'Create, cancel, create', 'Numbers continue without reuse', 'API', 'tests/documentNumbering.test.ts'],
  ['A POS sale posts like an invoice and a POS return posts like a credit note', 'Integration', 'P1', 'A shift', 'Sell and return', 'Entries mirror each other', 'API+DB', 'tests/posSaleZatcaPipeline.test.ts'],
  ['ZATCA submission runs after the creating transaction commits and never blocks the request', 'Integration', 'P1', 'ZATCA enabled sandbox company', 'Create an invoice', 'Response returns first; status moves SUBMITTING then REPORTED / CLEARED', 'API', 'tests/posSaleZatcaPipeline.test.ts'],
  ['The ZATCA XML of a cleared invoice validates with the SDK (dual gate)', 'Integration', 'P1', 'A reported invoice', 'fatoora -validate is run on its XML', 'XSD, EN, KSA pass; PIH failure ignorable for a non-genesis invoice', 'UI+API', 'Manual'],
  ['The customer list screen shows balances that equal the ledger', 'Integration', 'P2', 'Customers with activity', 'Open the list', 'Balance column equals the party ledger balance', 'UI+API', 'Candidate'],
  ['An invoice dated outside the open month is refused with the month message', 'Negative', 'P1', 'A closed month', 'Create an invoice dated in it', 'Refused', 'API', 'tests/periodStory.test.ts'],
]);

add('RCP', [
  ['One receipt settles several invoices: one voucher, one ledger entry tagged with the customer, N allocations', 'Functional', 'P1', 'Two open invoices (115 and 230)', 'A receipt of 345 allocates both', 'One voucher, one entry (bank Dr / AR Cr, customer tag), two allocation rows, both invoices Paid', 'API+DB', 'tests/settlements.test.ts'],
  ['A receipt can be read back with its allocations and listed with applied and on-account figures', 'Functional', 'P2', 'A receipt', 'Detail and list are requested', 'Numbers, party, applied, unapplied are correct', 'API', 'tests/settlements.test.ts'],
  ['A partial allocation keeps the rest on account and the aging shows the credit', 'Functional', 'P1', 'Invoices 115 and 230; receipt 300 allocating 100 to the first', 'The aging and ledger are read', 'First invoice Partially Paid; 200 on account; customer total 45', 'API', 'tests/settlements.test.ts'],
  ['Money on account can be applied later to open invoices', 'Functional', 'P1', '200 held on account', 'Apply 150 to another invoice', 'Applied 150, 50 left; invoice Partially Paid', 'API', 'tests/settlements.test.ts'],
  ['Applying more than is held, or more than is owed on a document, is refused', 'Boundary', 'P1', '50 held; invoice owes 15', 'Apply 60, then 20 to the 15 invoice', 'Both refused; 15 accepted', 'API', 'tests/settlements.test.ts'],
  ['A receipt of zero, a negative, NaN or an absurd amount is refused', 'Negative', 'P1', 'A customer', 'POST receipts with each amount', 'Refused', 'API', 'tests/settlements.test.ts'],
  ['Allocations that exceed the receipt amount are refused', 'Negative', 'P1', 'Receipt 100', 'Allocations total 150', 'Refused', 'API', 'tests/settlements.test.ts'],
  ['A document listed twice, a document of another customer, or another company is refused', 'Security', 'P1', 'Documents of other parties and companies', 'Allocate to them', 'Each refused; nothing written', 'API', 'tests/settlements.test.ts'],
  ['An inactive or foreign bank is refused', 'Negative', 'P2', 'An inactive bank, another company bank', 'Receipt', 'Refused', 'API', 'tests/settlements.test.ts'],
  ['A receipt needs customerReceipts.create; reading needs read; cancelling needs delete', 'Security', 'P1', 'Users with partial permissions', 'Each action', 'Allowed / 403 according to the key', 'API', 'tests/settlements.test.ts'],
  ['Another company cannot see, apply or cancel a receipt', 'Security', 'P1', 'Two companies', 'B calls detail / apply / cancel with A id', '404', 'API', 'tests/settlements.test.ts'],
  ['A receipt obeys the posting control (lock date, back-date window)', 'Integration', 'P1', 'A lock date', 'Receipt dated before it', 'Refused', 'API', 'tests/settlements.test.ts'],
  ['Cancelling a receipt needs a reason, reverses the entry, writes a reversal voucher and reopens the invoices', 'Functional', 'P1', 'A receipt that paid two invoices', 'Cancel without and with a reason', 'First refused; then both invoices Unpaid, customer balance restored, reversal voucher present', 'API+DB', 'tests/settlements.test.ts'],
  ['A cancelled receipt cannot be cancelled again or applied', 'Negative', 'P2', 'A cancelled receipt', 'Cancel / apply', 'Refused', 'API', 'tests/settlements.test.ts'],
  ['An invoice settled through a receipt cannot be cancelled until the receipt is', 'Integration', 'P1', 'A settled invoice', 'Cancel the invoice', 'Refused with a message naming the receipt; allowed after the receipt is cancelled', 'API', 'tests/settlements.test.ts'],
  ['Receipt on account shows as Customer advances on the Balance Sheet and Trial Balance, which still balance', 'Integration', 'P1', 'A receipt held on account', 'Balance sheet and trial balance are run', 'Customer advances line equals the held amount; balanceCheck 0; debits = credits', 'API', 'tests/settlements.test.ts'],
  ['The balance sheet as at an earlier date ignores money applied or received later', 'Integration', 'P1', 'A receipt applied today', 'The balance sheet at last month end is run', 'No advances, AR as it was, balanced', 'API', 'tests/settlements.test.ts'],
  ['The customer statement shows the receipt at its full amount on its own date, and the cancellation', 'Integration', 'P1', 'A receipt 300 for 115 owed', 'Statement is run, then the receipt is cancelled', 'Ending balance -185 then 115', 'API', 'tests/settlements.test.ts'],
  ['A cancelled receipt takes the cash back out of the bank balance', 'Regression', 'P1', 'A receipt then its cancellation', 'Bank balance is read', 'Back to the starting balance (reversal of a receipt is cash out)', 'API', 'tests/settlements.test.ts'],
  ['The cash flow statement counts a receipt on the day the cash arrived, applied or not', 'Integration', 'P2', 'A receipt', 'Cash flow is run for the day', 'Operating inflows include it once', 'API', 'tests/settlements.test.ts'],
  ['Cash-basis revenue follows the application date of each allocation', 'Integration', 'P2', 'A receipt applied in two steps on different days', 'Profit and loss (cash basis) is run per day', 'Revenue appears on the day each part was applied, excluding VAT', 'API', 'Candidate'],
  ['Two requests apply the same on-account money at once: only one wins', 'Boundary', 'P1', '100 held on account', 'Two apply requests of 100 run in parallel', 'One succeeds, one is refused; 0 left', 'API+DB', 'Candidate'],
  ['Double-click on Save Receipt creates one receipt', 'Usability', 'P2', 'The Receive Payment form filled', 'Save is clicked twice quickly', 'One voucher only', 'UI', 'Manual'],
  ['Allocate oldest first fills invoices in date order until the amount is used', 'Usability', 'P2', 'Three open invoices of different dates', 'Amount covers 1.5 invoices; click Allocate oldest first', 'The first is full, the second half, the third zero', 'UI', 'Manual'],
  ['The Receive Payment screen blocks save when allocations exceed the amount', 'Usability', 'P2', 'Amount 100', 'Allocate 150', 'Save disabled with an explanatory message', 'UI', 'Manual'],
  ['Receipts list filters by customer and shows On account / Settled / Cancelled', 'Functional', 'P3', 'Receipts in each state', 'Filter by customer', 'Status text correct for each row', 'UI', 'Manual'],
  ['Receipt voucher voucher numbers are sequential with the other vouchers of the company', 'Regression', 'P3', 'Receipts and payments mixed', 'Create several', 'Voucher numbers continue one sequence', 'API', 'Candidate'],
]);

add('AP', [
  ['An expense posts Dr expense (and VAT input) Cr payable, the payable line tagged with the vendor', 'Functional', 'P1', 'A vendor', 'An expense of 100 + VAT is created unpaid', 'Entry as described; vendor balance rises', 'API+DB', 'tests/ledgerSubledger.test.ts'],
  ['A vendor posting profile sends the payable line to the vendor control account; the form refuses a wrong account', 'Functional', 'P1', 'A vendor with a profile', 'Expense and profile edits', 'Correct account; wrong account refused', 'API', 'tests/ledgerPostingProfile.test.ts'],
  ['Paying an expense later posts Dr payable Cr bank for the amount paid', 'Functional', 'P1', 'An unpaid expense', 'Pay in two parts', 'Two entries; status follows', 'API+DB', 'tests/expensePayCancel.test.ts'],
  ['A cancelled expense reverses every entry including its payments', 'Functional', 'P1', 'A part-paid expense', 'Cancel', 'Entries and vouchers reversed; bank restored', 'API+DB', 'tests/expensePayCancel.test.ts'],
  ['A capitalised (Asset) expense posts to fixed assets, not an expense account', 'Functional', 'P2', 'Classification Asset', 'Create', 'Dr fixed assets', 'API+DB', 'Candidate'],
  ['A goods receipt posts Dr inventory Cr GR/IR clearing at cost, without VAT', 'Functional', 'P1', 'A PO', 'Receive goods', 'Entry at cost; GR/IR liability appears', 'API+DB', 'tests/purchaseBillsRoutes.test.ts'],
  ['A purchase bill clears GR/IR, posts VAT input and credits payable', 'Functional', 'P1', 'A received GRN', 'Bill it', 'Dr GR/IR + VAT, Cr payable', 'API+DB', 'tests/purchaseBillsRoutes.test.ts'],
  ['A bill needs the vendor bill reference number', 'Negative', 'P2', 'A GRN', 'Create a bill without it', 'Refused', 'API', 'tests/purchaseBillsRoutes.test.ts'],
  ['A purchase return before billing reverses GR/IR; after billing reduces payable; after payment creates vendor credit', 'Functional', 'P1', 'Three GRN states', 'Return in each', 'Three different entries as designed', 'API+DB', 'tests/purchaseReturnsAndStockTakes.test.ts'],
  ['A billed GRN cannot be reversed; a purchase return is the way', 'Negative', 'P1', 'A billed GRN', 'Reverse', 'Refused', 'API', 'tests/purchaseBillsRoutes.test.ts'],
  ['A purchase return in a filed VAT quarter is refused or posted in the open period as designed', 'Integration', 'P2', 'A filed quarter', 'Return dated inside it', 'Refused with the VAT message', 'API', 'tests/purchaseReturnVatPeriod.test.ts'],
  ['Recurring expense templates post expenses and accruals through the same path', 'Integration', 'P2', 'A template', 'Post recurring and settle accrual', 'Entries identical in shape to a manual expense', 'API', 'tests/recurringTemplates.test.ts'],
  ['A settled accrual is counted once in payables and in the vendor statement', 'Regression', 'P1', 'An accrual settled by an actual expense', 'Reports are run', 'Counted once', 'API', 'tests/accrualSettlementVariance.test.ts'],
  ['A vendor refund receipt and its cancellation move cash and the vendor credit receivable', 'Functional', 'P2', 'A vendor credit', 'Receive the refund then cancel it', 'Bank and credit balances follow', 'API', 'Candidate'],
  ['An expense dated in a closed month or locked period is refused', 'Negative', 'P1', 'A closed month', 'Create', 'Refused', 'API', 'Candidate'],
]);

add('PAY', [
  ['One payment settles several expenses and bills: one voucher, one entry (payable Dr, bank Cr, vendor tag), N allocations', 'Functional', 'P1', 'Two open expenses', 'Pay both with one payment', 'One voucher and entry; both Paid', 'API+DB', 'tests/settlements.test.ts'],
  ['A payment can include a surplus kept on account with the vendor', 'Functional', 'P1', 'Open items 300; pay 340', '340 posted', '40 on account; the vendor aging shows -40', 'API', 'tests/settlements.test.ts'],
  ['A purchase bill can be settled by a vendor payment', 'Functional', 'P1', 'An unpaid bill', 'Pay through Pay Vendor', 'Bill status Paid', 'API', 'tests/settlements.test.ts'],
  ['An expense settled through a payment cannot be cancelled until the payment is cancelled', 'Integration', 'P1', 'A settled expense', 'Cancel it, then cancel the payment, then the expense', 'Refused, then allowed', 'API', 'tests/settlements.test.ts'],
  ['A vendor payment on account is an asset on the Balance Sheet until applied', 'Integration', 'P1', 'A payment on account', 'Balance sheet', 'Vendor advances line equals it; balanced', 'API', 'tests/settlements.test.ts'],
  ['The vendor statement shows the payment at its full amount and its cancellation', 'Integration', 'P1', 'A payment and cancellation', 'Vendor statement', 'Credit then debit lines', 'API', 'tests/settlements.test.ts'],
  ['A cancelled payment brings the cash back into the bank balance', 'Regression', 'P1', 'A payment cancelled', 'Bank balance', 'Restored', 'API', 'tests/settlements.test.ts'],
  ['Payments need vendorPayments.create; reading read; cancelling delete', 'Security', 'P1', 'Partial permissions', 'Each action', 'Allowed / 403', 'API', 'tests/settlements.test.ts'],
  ['A payment to a vendor with a negative open item (reversed paid expense) nets correctly', 'Boundary', 'P2', 'A reversed paid expense creating vendor credit', 'Pay other open items', 'Allocation uses the right outstanding amounts', 'API', 'Candidate'],
  ['The Pay Vendor screen lists bills and expenses together oldest first', 'Usability', 'P3', 'Bills and expenses', 'Select the vendor', 'One list with type labels sorted by date', 'UI', 'Manual'],
  ['Payment approval thresholds route large payments to a second person', 'Functional', 'P2', 'Approval rules (FR-APR) built', 'A payment above the threshold', 'It waits for approval', 'API', 'Manual'],
]);

add('SUB', [
  ['Every receivable line carries its customer on whichever control account it posts and every payable line its vendor', 'Integration', 'P1', 'Documents for several parties', 'The consistency rule R8 runs', 'No receivable / payable line is without a party', 'API+DB', 'tests/ledgerSubledger.test.ts'],
  ['Balances per party add up to the Trial Balance control accounts', 'Integration', 'P1', 'Activity for many parties', 'Balances and trial balance are read', 'Sum of parties = control account balance', 'API', 'tests/ledgerSubledger.test.ts'],
  ['A party ledger shows opening balance, postings, running balance and document number', 'Functional', 'P1', 'A party with history', 'Ledger for a period', 'Opening + movements = closing; document numbers shown', 'API', 'tests/ledgerSubledger.test.ts'],
  ['Aging ages open charges from their document date and sets payments against the oldest charge first', 'Functional', 'P1', 'Invoices at 5, 40, 80, 120 days old, one payment', 'Aging as at today', 'Buckets as expected; payment reduces the oldest', 'API', 'tests/ledgerSubledger.test.ts'],
  ['Aging bucket boundaries: day 30 is in the first bucket, day 31 in the next', 'Boundary', 'P2', 'Invoices dated exactly 30 and 31 days back', 'Aging', 'Correct buckets', 'API', 'Candidate'],
  ['The payables aging mirrors it for vendors', 'Functional', 'P2', 'Vendor bills', 'Payables aging', 'Mirror behaviour', 'API', 'tests/ledgerSubledger.test.ts'],
  ['Money held on account is shown in its own column and nets the party total', 'Functional', 'P1', 'On-account receipt', 'Receivables aging', 'On account column negative; total netted', 'API', 'tests/settlements.test.ts'],
  ['Aging and party ledger export to Excel', 'Functional', 'P3', 'Reports', 'Export', 'Workbook downloads and opens', 'API', 'tests/ledgerSubledger.test.ts'],
  ['The backfill repairs an untagged historical line and is idempotent', 'Regression', 'P1', 'A line with no party', 'Run the backfill twice', 'First tags it; second changes nothing', 'DB', 'tests/ledgerSubledger.test.ts'],
  ['Each subledger report needs its own permission and other companies see nothing', 'Security', 'P1', 'Users and two companies', 'Calls', '403 / empty', 'API', 'tests/ledgerSubledger.test.ts'],
  ['A customer with no activity does not appear; one with a zero balance only on request', 'Boundary', 'P3', 'Customers with zero and non-zero', 'Aging', 'Only open balances listed', 'API', 'Candidate'],
]);

add('BNK', [
  ['A session lists the bank account ledger lines up to the statement date and nothing else', 'Functional', 'P1', 'Receipts and payments on a bank', 'A reconciliation is started', 'Only that bank lines up to the date', 'API', 'tests/bankReconciliation.test.ts'],
  ['Only one reconciliation per bank can be in progress', 'Negative', 'P1', 'One in progress', 'Another is started for the same bank', 'Refused', 'API', 'tests/bankReconciliation.test.ts'],
  ['A new statement date must be after the last completed reconciliation of the bank', 'Boundary', 'P1', 'A completed reconciliation', 'A session dated earlier / equal', 'Refused', 'API', 'tests/bankReconciliation.test.ts'],
  ['A statement date in the future is refused', 'Boundary', 'P2', 'Today', 'A session dated tomorrow', 'Refused', 'API', 'Candidate'],
  ['The reconciling formula is live: statement + deposits in transit - payments outstanding equals the book balance when cleared', 'Functional', 'P1', 'Cleared lines', 'Detail is read', 'Difference = statement - cleared; adjusted statement equals book when balanced', 'API', 'tests/bankReconciliation.test.ts'],
  ['Completion is blocked while the difference is not zero and the reason is shown', 'Negative', 'P1', 'A 10 difference', 'Complete', 'Refused: does not balance', 'API', 'tests/bankReconciliation.test.ts'],
  ['Completion is blocked while a statement line is unmatched', 'Negative', 'P1', 'A matched total but one unmatched line', 'Complete', 'Refused', 'API', 'tests/bankReconciliation.test.ts'],
  ['Statement lines can be typed or imported; a second import of the same file adds nothing', 'Functional', 'P1', 'A CSV', 'Imported twice', 'First adds all, second skips all', 'API', 'tests/bankReconciliation.test.ts'],
  ['Two equal lines inside one file (two equal fees on a day) are both kept', 'Boundary', 'P2', 'A CSV with two identical rows', 'Import', 'Both added', 'API', 'Candidate'],
  ['Invalid statement lines (bad date, zero amount, too many rows) are refused', 'Negative', 'P2', 'Bad rows', 'Import', 'Refused with the row number', 'API', 'tests/bankReconciliation.test.ts'],
  ['CSV import accepts day-first dates, Debit/Credit columns, quoted text and semicolons', 'Functional', 'P2', 'Bank files in different layouts', 'Parse in the UI', 'Lines and signs are right; unparseable rows listed', 'UI', 'Candidate'],
  ['Match suggestions pair equal amounts within 10 days without applying them', 'Functional', 'P2', 'Unmatched lines and uncleared ledger lines', 'Suggestions requested', 'Pairs returned, nothing changed', 'API', 'tests/bankReconciliation.test.ts'],
  ['Matching refuses unequal amounts, already matched lines and lines of another bank or company', 'Negative', 'P1', 'Wrong pairs', 'Match', 'Refused', 'API', 'tests/bankReconciliation.test.ts'],
  ['A matched ledger line cannot be un-cleared until it is un-matched', 'Negative', 'P2', 'A matched line', 'Un-clear', 'Refused', 'API', 'tests/bankReconciliation.test.ts'],
  ['A line cleared in a completed reconciliation cannot be cleared again elsewhere', 'Negative', 'P1', 'A completed session', 'A later session clears the same line', 'The line is not offered / refused', 'API', 'Candidate'],
  ['A bank fee on the statement is posted from the session as a voucher and an entry, matched at once', 'Functional', 'P1', 'A -10 statement line', 'Post as bank charge to an expense account', 'Voucher Payment (BankCharge), entry Dr expense Cr bank, line cleared and matched, difference 0', 'API+DB', 'tests/bankReconciliation.test.ts'],
  ['Bank interest posts as a Receipt voucher to an income account', 'Functional', 'P1', 'A +5 statement line', 'Post as interest to a revenue account', 'Voucher Receipt (BankInterest), entry Dr bank Cr income', 'API+DB', 'tests/bankReconciliation.test.ts'],
  ['A charge to a revenue account, interest to an expense account, or any non P&L account is refused', 'Negative', 'P1', 'Wrong account types', 'Adjustments', 'Refused', 'API', 'tests/bankReconciliation.test.ts'],
  ['Bank charges and interest flow into the document based reports: balance sheet balances, trial balance lines, P&L, cash flow', 'Integration', 'P1', 'A posted charge', 'Reports', 'Bank balance down by the fee; currentPeriodEarnings down; TB has Bank Charges; balanced', 'API', 'tests/bankReconciliation.test.ts'],
  ['A fee entry can be reversed while the session is open and the reversal does not clear', 'Functional', 'P2', 'A fee entry', 'Reverse it in the session', 'Reversal voucher; bank restored; both lines uncleared', 'API', 'tests/bankReconciliation.test.ts'],
  ['Completion freezes the book balance and locks the cleared lines', 'Functional', 'P1', 'A balanced session', 'Complete', 'Status Completed; GL balance stored; no further change allowed', 'API', 'tests/bankReconciliation.test.ts'],
  ['A document behind a cleared line cannot be cancelled (receipt, payment) and nothing is half done', 'Integration', 'P1', 'A completed session', 'Cancel the receipt', 'Refused with the reconciliation message; the receipt is untouched', 'API', 'tests/bankReconciliation.test.ts'],
  ['Reopening needs its own permission, a reason, only the latest completed session, and is audited', 'Security', 'P1', 'Completed sessions', 'Reopen without permission / without reason / an older one / the latest', '403 / 400 / 400 / success with an audit entry', 'API+DB', 'tests/bankReconciliation.test.ts'],
  ['After reopening, un-matching and un-clearing a line frees its document for cancellation', 'Integration', 'P2', 'A reopened session', 'Free the line and cancel the receipt', 'Cancellation succeeds', 'API', 'tests/bankReconciliation.test.ts'],
  ['A session can be discarded, which releases every line it cleared', 'Functional', 'P2', 'An in-progress session', 'Discard', 'Lines uncleared; statement lines removed; entries posted from it stay', 'API+DB', 'tests/bankReconciliation.test.ts'],
  ['A reconciliation of another company is invisible and untouchable', 'Security', 'P1', 'Two companies', 'B reads / clears A session', '404', 'API', 'tests/bankReconciliation.test.ts'],
  ['Permissions are separate: read, create, match, adjust, complete, reopen', 'Security', 'P1', 'Users with each key', 'Each action', 'Only the matching key allows it', 'API', 'tests/bankReconciliation.test.ts'],
  ['Row-level security hides other companies sessions and statement lines without a WHERE clause', 'Security', 'P1', 'Two companies', 'Tenant role selects', 'Only own rows', 'DB', 'Candidate'],
  ['A bank with an opening balance reconciles from its first statement', 'Boundary', 'P2', 'A bank with opening balance 5000', 'First session', 'The opening line is offered to be cleared; formula balances', 'API', 'Candidate'],
  ['Large bank file: 2000 lines import and match within the time limit', 'Performance', 'P3', 'A 2000-row file', 'Import and suggestions', 'Under 10 seconds', 'API', 'Candidate'],
  ['The UI shows green check when the formula balances and disables Complete otherwise', 'Usability', 'P2', 'A session', 'Clear lines step by step', 'Indicator and button follow the difference', 'UI', 'Manual'],
]);

add('PRT', [
  ['A Receipt Voucher shows party, amount in words, bank, settled documents, held on account and the accounting entry', 'Functional', 'P1', 'A receipt across two invoices with 100 on account', 'Print voucher is opened', 'All sections present and amounts equal the screen', 'UI', 'Manual'],
  ['A Payment Voucher mirrors it for vendors with Paid to / Paid from wording', 'Functional', 'P1', 'A payment', 'Print', 'Wording and signatures correct', 'UI', 'Manual'],
  ['A cancelled voucher prints a CANCELLED stamp, strikes cancelled allocations and shows the reversing entry', 'Functional', 'P2', 'A cancelled receipt', 'Print', 'Stamp, struck lines, second entry labelled Reversing entry', 'UI', 'Manual'],
  ['Voucher print data carries the posting with the party tag and the preparer', 'Integration', 'P1', 'A receipt', 'GET settlement detail', 'posting lines, party name, preparedBy present', 'API', 'tests/settlements.test.ts'],
  ['A Journal Voucher prints any manual journal (any status) and any posted entry with account, party, dimensions and totals in words', 'Functional', 'P1', 'A draft journal and a posted invoice entry', 'Print each', 'Draft shows NOT POSTED; both show balanced totals', 'UI', 'Manual'],
  ['A Journal Voucher shows the approval trail: prepared by, approved by, self-approved flag', 'Functional', 'P2', 'A self-approved journal', 'Print', 'Approved by shows (self-approved)', 'UI', 'Manual'],
  ['The Bank Reconciliation Statement shows statement balance, deposits in transit, payments outstanding, adjusted balance, book balance, difference and the lists', 'Functional', 'P1', 'A completed session with outstanding items', 'Print', 'Figures equal the screen; lists complete', 'UI', 'Manual'],
  ['Arabic and Urdu vouchers print right to left with the right fonts', 'Usability', 'P1', 'A user in Arabic', 'Print each document', 'Mirrored layout, Arabic account names, no clipped text', 'UI', 'Manual'],
  ['The print popup keeps colours, page size and no blank second page', 'Usability', 'P2', 'Any voucher', 'Print to PDF', 'One A4 page, backgrounds kept', 'UI', 'Manual'],
  ['Print overlay sits above the detail drawer', 'Usability', 'P3', 'An open drawer', 'Print voucher', 'The preview is on top and closing it returns to the drawer', 'UI', 'Manual'],
  ['A voucher of another company cannot be printed', 'Security', 'P1', 'Two companies', 'B asks for A print data', '404', 'API', 'tests/settlements.test.ts'],
  ['Print data for a journal entry of another branch is hidden from a branch-restricted user', 'Security', 'P2', 'A branch-restricted user', 'print-data of another branch entry', '404', 'API', 'Candidate'],
  ['Amount in words is correct for 0.50, 1.00, 1000000.99 and negative totals', 'Boundary', 'P3', 'Amounts', 'Render', 'Correct English words with the currency', 'UI', 'Candidate'],
]);

add('XR', [
  ['Balance sheet balances after every kind of activity (documents, settlements, bank adjustments)', 'Integration', 'P1', 'Mixed activity', 'Run the balance sheet', 'balanceCheck = 0', 'API', 'tests/bankReconciliation.test.ts'],
  ['Balance sheet at past dates reflects payments made later', 'Regression', 'P1', 'A payment after the as-at date', 'Run at the earlier date', 'The invoice still counts as owed', 'API', 'tests/balanceSheetAsAtPastDate.test.ts'],
  ['Trial balance debits equal credits in every period', 'Integration', 'P1', 'Activity in several months', 'Each month', 'Equal', 'API', 'Candidate'],
  ['A month-close stores a profit that equals the profit and loss for that month', 'Integration', 'P1', 'A month with documents and bank charges', 'Close the month', 'closedPnL net equals P&L net', 'API', 'Candidate'],
  ['Customer and vendor statements end at the ledger balance of the party', 'Integration', 'P1', 'Documents and settlements', 'Statements and ledger', 'Same ending balance', 'API', 'tests/settlements.test.ts'],
  ['Dashboard KPIs equal the underlying reports', 'Integration', 'P2', 'A month of data', 'Dashboard and reports', 'Same figures', 'API', 'tests/reportsReconcileLedgerScenario.test.ts'],
  ['Reports are computed server side and never from the capped state list', 'Regression', 'P1', 'More than 500 documents', 'A report is run', 'Older documents are included', 'API', 'tests/apiStateGlobalCapIsolation.test.ts'],
  ['A branch-restricted report excludes other branches and carries a notice', 'Security', 'P2', 'Documents in two branches', 'Run restricted', 'Only own branch', 'API', 'Candidate'],
  ['Outstanding report lists open invoices, expenses and bills with the paid amounts that settlements moved', 'Integration', 'P1', 'A partial settlement', 'Outstanding report', 'Outstanding amounts reflect it', 'API', 'tests/settlements.test.ts'],
]);

add('SEC', [
  ['Every table has row-level security with a real predicate', 'Security', 'P1', 'The live database', 'pg_policy is read', 'Each table has a policy with a non-null predicate (except the shared ones)', 'DB', 'tests/rlsPolicyCoverage.test.ts'],
  ['A restricted tenant connection with no WHERE clause sees only its own company rows (per new table)', 'Security', 'P1', 'payment_allocations, bank_reconciliations, bank_statement_lines', 'Select * as erp_app_tenant', 'Only own company rows', 'DB', 'Candidate'],
  ['No route accepts a client supplied company id', 'Security', 'P1', 'Any report or list route', 'companyId is sent in query or body', 'It is ignored; the session company is used', 'API', 'tests/companyScoping.test.ts'],
  ['Foreign keys of one company cannot point into another (composite keys)', 'Security', 'P1', 'Two companies', 'Cross-company inserts on journal lines, allocations, statement lines', 'The database refuses', 'DB', 'tests/crossCompanyIsolation.test.ts'],
  ['The static isolation tripwire passes', 'Security', 'P1', 'The repository', 'npm run check:isolation', 'No unchecked client-supplied foreign keys', 'DB', 'Candidate'],
  ['Permission matrix: each route refuses a user lacking its key and each key unlocks only its own action', 'Security', 'P1', 'A user per permission', 'Calls', '403 / 200 by key', 'API', 'tests/permissionCrudModel.test.ts'],
  ['A super-admin acting on a company only affects that company', 'Security', 'P2', 'A super-admin with an explicit company', 'Writes', 'Rows belong to the chosen company', 'API', 'tests/companyScoping.test.ts'],
  ['Text fields are stored and rendered without script execution (XSS) on screens and prints', 'Security', 'P1', 'A description containing <script>', 'Open the screen and print', 'Shown as text', 'UI', 'Manual'],
  ['SQL special characters in search and description fields do not alter queries', 'Security', 'P1', 'Strings like \' OR 1=1 --', 'Search / create', 'Treated as data', 'API', 'Candidate'],
  ['An expired or foreign session id is refused', 'Security', 'P1', 'Random x-session-id', 'Any call', '401', 'API', 'Candidate'],
  ['Audit log records posting overrides, reopenings and cancellations with user and company', 'Security', 'P1', 'Each elevated action', 'Audit log is read', 'One entry per action with details', 'API+DB', 'tests/auditLogCoverage.test.ts'],
  ['Bulk "save everything" endpoints do not exist', 'Regression', 'P1', 'The API', 'POST /api/migrate and similar', '404', 'API', 'tests/noBulkSave.test.ts'],
  ['Passwords and secrets are never returned by any list endpoint', 'Security', 'P1', 'Users list', 'GET', 'No password hash in the payload', 'API', 'Candidate'],
  ['Rate limiting protects login and the public onboarding form', 'Security', 'P2', 'Many requests', 'Repeated', '429 after the limit', 'API', 'tests/companyOnboarding.test.ts'],
]);

add('I18N', [
  ['Every new screen string has an Arabic and Urdu translation in the live table', 'Functional', 'P1', 'The translations table', 'Keys used by the settlement, bank reconciliation, print and posting screens are read', 'No blank ar / ur', 'DB', 'Candidate'],
  ['Right-to-left layout mirrors tables, totals and drawers', 'Usability', 'P1', 'Arabic UI', 'Open Receive Payment, Receipts, Bank Reconciliation, Journal list', 'Columns, buttons and drawers mirror; numbers stay left-to-right', 'UI', 'Manual'],
  ['Dates and numbers keep the Western digit format everywhere', 'Usability', 'P2', 'Arabic UI', 'View amounts and dates', 'Consistent digits and ISO dates', 'UI', 'Manual'],
  ['Account names show in Arabic when present on the General Ledger and vouchers', 'Usability', 'P3', 'An Arabic account name', 'Print a voucher in Arabic', 'Arabic name shown', 'UI', 'Manual'],
  ['No translated text is cut off in buttons, tabs and column headers (longer Arabic and Urdu strings)', 'Usability', 'P2', 'Urdu UI', 'Walk every new screen', 'No clipped labels', 'UI', 'Manual'],
  ['Server messages shown to the user are readable in the UI language or clearly English', 'Usability', 'P3', 'A refused action in Arabic UI', 'Trigger an error', 'Message is shown (English allowed) without raw codes', 'UI', 'Manual'],
  ['Auto-registered missing keys do not create junk rows for tenant data (names, descriptions)', 'Regression', 'P2', 'Customer names in lists', 'Open lists', 'No translation rows are created for tenant text', 'DB', 'Candidate'],
]);

add('NFR', [
  ['Concurrent receipts for the same customer never over-allocate an invoice', 'Performance', 'P1', 'An invoice owing 100', 'Ten parallel receipts of 100 against it', 'Exactly one succeeds; amount_paid never exceeds the total', 'API+DB', 'Candidate'],
  ['Concurrent invoice creation yields unique gap-free numbers', 'Performance', 'P1', 'A company', '50 parallel invoices', 'Unique numbers, no gaps', 'API+DB', 'tests/documentNumbering.test.ts'],
  ['Hash-chain reservation serialises ZATCA invoices per company only', 'Performance', 'P1', 'Two companies', 'Parallel invoices', 'Per-company ICV sequence is gapless; companies do not block each other', 'API+DB', 'Candidate'],
  ['A request that fails half way leaves nothing behind (transaction rollback)', 'Regression', 'P1', 'A receipt whose later step fails (cancel of a reconciled line)', 'The call', 'No allocation, voucher or ledger change persists', 'API+DB', 'tests/bankReconciliation.test.ts'],
  ['Retrying a failed or duplicated request is safe', 'Functional', 'P2', 'The same receipt payload sent twice', 'Both sent', 'Two receipts exist (documented) or the second is refused when it over-allocates', 'API', 'Candidate'],
  ['Trial balance for a company with 100000 lines under 5 seconds', 'Performance', 'P2', 'A large company', 'Run', 'Within the limit', 'API', 'Candidate'],
  ['Listing receipts, journals and sessions pages with a limit and stays fast at 10000 rows', 'Performance', 'P3', 'Large tables', 'List', 'Limit honoured', 'API', 'Candidate'],
  ['The dev server restart picks up backend edits', 'Regression', 'P3', 'A backend file edit', 'Restart and call', 'New behaviour served', 'API', 'Manual'],
  ['Thousands of concurrent users: login, dashboard and posting stay within the agreed latency', 'Performance', 'P1', 'A load profile of 2000 virtual users', 'k6 / Artillery scenario', 'p95 under 800 ms for reads and 1500 ms for postings, no 5xx', 'API', 'Candidate'],
]);

add('REL', [
  ['The release script is idempotent: running it twice changes nothing the second time', 'Regression', 'P1', 'A deployed environment', 'release-demo.sh twice', 'Second run reports nothing to do and exits 0', 'API+DB', 'Manual'],
  ['The date migration renames columns in place, keeping data', 'Regression', 'P1', 'A copy of production', 'migrate-date-fields.mjs', 'Columns renamed, row counts and checksums equal', 'DB', 'Manual'],
  ['db:push shows no drop, rename or retype on the release', 'Regression', 'P1', 'The release plan', 'Read the printed plan', 'Only additive changes', 'DB', 'Manual'],
  ['Row-level security predicates are applied after every push and verified', 'Security', 'P1', 'After push', 'apply-rls-policies.mjs', 'All predicates non-null', 'DB', 'tests/rlsPolicyCoverage.test.ts'],
  ['Check constraints match schema.ts after push', 'Regression', 'P2', 'After push', 'apply-check-constraints.mjs', 'None replaced on a second run', 'DB', 'Manual'],
  ['The party-tag backfill tags history and a second run tags nothing', 'Regression', 'P1', 'A database with untagged lines', 'Run twice', 'First tags, second zero', 'DB', 'tests/ledgerSubledger.test.ts'],
  ['Translations are applied without overwriting edited ones', 'Regression', 'P2', 'A translation edited in the admin screen', 'apply-gl-translations --apply', 'The edit survives', 'DB', 'Manual'],
  ['Rollback to the previous tag restores service and never touches the database', 'Regression', 'P1', 'A failed release', 'rollback.sh', 'Old build serves; data intact', 'API', 'Manual'],
  ['Live (master) never receives v2 changes', 'Regression', 'P1', 'Both branches', 'Compare release scripts and schema', 'No v2-only table or column in master', 'DB', 'Manual'],
]);

export const CASES = [];
for (const m of MODULES) {
  (T[m.id] || []).forEach((row, i) => {
    const [title, type, priority, given, when, then, layer, automation] = row;
    CASES.push({ id: `${m.id}-${String(i + 1).padStart(3, '0')}`, module: m.name, moduleId: m.id, ref: m.ref, title, type, priority, given, when, then, layer, automation });
  });
}
