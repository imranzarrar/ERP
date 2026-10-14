# Sprint log: General Ledger, Step 1 (Demo / 2.0 only)

Status: **built, tested locally and deployed to the Demo (port 4000). Not on Live.** Branch `v2`. You test only now, on the Demo.
Nothing here has touched Live (1.0). Releasing it to Live is a separate decision (see "Before this goes to Live").

## What you can try (menu: **General Ledger**, between Inventory Management and Master Registries)

| Menu item | What it does |
|---|---|
| **Chart of Accounts → Accounts** | The company's own chart as a tree (headings collapse/expand), with balances, search, type filter, show inactive. Edit, deactivate/reactivate (never delete). |
| **Chart of Accounts → New Account** | Drawer: code, English + Arabic name, type, heading it sits under, "this is a heading". |
| **Chart of Accounts → Account Mapping** | Which account each kind of document posts to (16 posting roles, 6 expense categories, banks). A change applies to postings from now on; history never moves. |
| **Chart of Accounts → Import / Export** | Excel template, validate → preview → choose rows → save (adds accounts and renames; never changes a type, role or bank link). Export of the whole chart. |
| **Journals → Journal Listing** | Every ledger entry (invoices, expenses, bills, vouchers …) **and** every manual journal in one list: search, status, source, dates, "prepared by me", paging. Click a row for the full entry. |
| **Journals → New Manual Journal** | Type-ahead account picker, debit/credit lines, live balance check, "Save draft" or "Save and submit for approval". |
| **Journals → Pending Approval** | The approver's inbox. Open a journal → Approve and post / Reject (reason required). The owner/administrator can switch "allow approving your own journal" on here (off by default). |
| **Ledger Reports → General Ledger** | One account (or a heading with everything under it): opening balance, every movement, running balance, closing; click a line to see the entry; Excel export. |
| **Ledger Reports → Trial Balance (Ledger)** | Opening / movement / closing per account from the journal; says clearly whether it balances; click an account to drill into its ledger; Excel export. |
| **Ledger Reports → Ledger vs Documents** | Ledger vs the document-based reports, role by role, with differences flagged, plus manual-journal / opening-balance totals and pending counts. |
| **Opening Balances** | Enter balance-sheet opening balances, preview (nothing saved), optionally put a difference to an Equity account, confirm, post one entry. Reverse it (reason required) to post a corrected one. |

Everything is in English, Arabic (right-to-left) and Urdu.

## Accounting standards respected

- **Double entry, always balanced**: a journal cannot be submitted unless debits = credits; the database also refuses a line with both or neither side.
- **Maker–checker**: Draft → Pending approval → Posted. The preparer cannot approve their own journal (unless the owner enables it, and then the journal is marked "approved by its preparer"). Rejection needs a written reason and returns it to the preparer. Every step (prepared, edited, submitted, approved/rejected, posted, discarded, reversal started) is on the journal's own trail **and** in the audit log.
- **Nothing posted is ever edited or erased.** A posted journal is corrected only by a **reversal** (a new journal, dates ≥ the original, with a reason) that itself needs approval. A document-made entry is reversed only by its own document. "Delete" on a draft = **Discard** (the number stays on record as Discarded, so numbering has no unexplained gaps).
- **Control accounts are protected**: customers, suppliers, stock, VAT, goods-received and every bank/cash account can only be posted by their documents. Manual journals and opening balances refuse them (opening balances allow banks). Headings take no postings.
- **Periods respected**: a posting date needs an open fiscal month; a journal touching VAT accounts also needs a VAT quarter that is not frozen/filed (others: not filed). Checked at submit **and again at approval**.
- **History never moves**: every journal line stores the exact account it was posted to. Changing Account Mapping later affects only new postings. An expense cancelled/reversed credits the same account it debited.
- **Chart**: standard Saudi starter chart (34 accounts, English/Arabic) for every company, one ledger account per bank (created automatically), expense categories each mapped to their own account.
- **Opening balances**: balance-sheet accounts only; must balance (or the difference goes to a chosen Equity account and is shown); one live opening entry per company; warns if entries already exist before the opening date.

## Permissions (Roles screen, new group "General Ledger")

`chartOfAccounts`: create, read, update, delete (= deactivate), import, export · `accountMapping`: read, update · `journals`: create, read, update, delete (= discard), **post** (= approve/reject), **reverse** · `openingBalances`: read, preview, post · `reports`: generalLedger, trialBalanceLedger, ledgerReconciliation.
So "manager can post, accountant drafts only" = give the accountant `journals.create/read/update/delete`, the manager `journals.read/post/reverse`. The self-approval switch is administrator/owner only. Branch-restricted users only ever see their own branches' entries.

## Tenant isolation and foreign keys

- Every new table carries `company_id` **and** an RLS policy for the restricted tenant role; every route runs on the tenant connection; every id a client names (account, branch, parent) is checked against the company before use. `npm run check:isolation` is clean.
- **Composite foreign keys** `(id, company_id)` make the database itself refuse cross-company links: journal lines → accounts, manual-journal lines → journals and accounts, expense-category mapping → accounts, account parent → account, journal reversal links. Tests prove the database rejects them.
- A raw-SQL test as the tenant role (no WHERE clause) shows only its own company's rows on every new table.

## Schema changes and what they mean for Live (all additive)

New tables: `company_accounts`, `expense_category_accounts`, `manual_journals`, `manual_journal_lines`, `manual_journal_events`, `opening_balance_runs`. Changed: `journal_lines.account_key` now nullable (a manual line has an account, not a role), new nullable `journal_lines.account_id`, new `companies.journal_self_approval boolean not null default false`. No drops, no retypes, no renames; safe to push directly. db:push also shows its usual benign noise (it drops and re-adds ~10 foreign keys and 3 primary keys with identical definitions). After the push: `apply-rls-policies`, grants, `scripts/seed-company-charts.ts --apply` (gives every company its chart and stamps existing journal lines) and `scripts/apply-gl-translations.ts --apply`. The demo release script now does all of these.

## Tests

New: `tests/ledgerAccounts.test.ts` (14) and `tests/ledgerJournals.test.ts` (25): chart seeding, permissions, create/edit/deactivate rules, cross-company refusals (API **and** database), import/export, mapping not retroactive, bank lines, expense categories, drafting rules, approval/rejection/self-approval/period re-check, discard, reversals, listing/filters, entry detail, General Ledger / Trial Balance / Ledger vs Documents figures tying to each other, R7 rules, opening balances (rules, plug, post once, reverse, repost), raw RLS test.
Extended: `companyDeletion.test.ts` (ledger data is deleted with the company). Fixed: four test teardowns that deleted banks directly (each bank now owns a ledger account).
Result locally against the 2.0 server: everything passes **except** 9 onboarding / password-reset tests that need SMTP, which the 2.0 environment deliberately does not have (they pass on Live's server, which has it). `periodStory` and `periodFuzz` (day-by-day simulations that also run every consistency rule, now including R7) pass on a dev-clock server.
UX check by hand on localhost: created an account, prepared and submitted a journal as one user, approved it as another, saw it in the listing, General Ledger and Trial Balance; Arabic/RTL checked.

## Known limitations (be aware when testing)

1. **Manual journals and opening balances appear in the ledger reports but not in the existing Balance Sheet / Profit & Loss**, because those are built from documents (decision in `docs/reporting-rules.md`). "Ledger vs Documents" shows the two side by side and the consistency rule R6 ignores manual entries. Proposed **Step 1.5**: build the financial statements from the ledger, so a manual journal (accrual, depreciation, correction) flows into the P&L and Balance Sheet.
2. Trial Balance (Ledger) is cumulative: profit-and-loss accounts are not closed to retained earnings in it.
3. A manual journal cannot touch customer/supplier/stock/VAT/bank accounts (by design); opening balances for those come from their documents.
4. Recurring/accrual expenses post to the default expense account (they carry no category).
5. Posting dates are checked against the **fiscal month and VAT quarter**; there is no separate "ledger period lock" yet.

## Found along the way

- **Live bug (1.0, not fixed there):** `DELETE /api/companies/:id` does not delete journal entries/lines, so deleting a Cancelled company that has ledger entries fails (foreign keys). In 2.0 the deletion routine now removes the ledger tables too. Suggest the same small fix on `master` when convenient.
- drizzle-kit reads a unique constraint's columns back in a different order; declaring `(id, company_id)` made every `db:push` try to drop it (and fail). The two constraints are now declared in the read-back order (same cause as the long-standing "3 primary keys re-added" noise).
- A test bug (fixed) briefly closed and reopened the current month for every company in the local database; it never ran against Demo or Live.

## Before this goes to Live

Release the Demo first and test; then decide. For Live: merge `v2` into `master` only when you say so, run `deploy/release.sh` (add the chart-seeding and translation steps that `deploy/release-demo.sh` has), and tell me before the push so I can state the exact `db:push` plan to expect.
