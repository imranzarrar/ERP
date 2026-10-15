# Annex E — Developer guide for future ledger work

Read the Solution Design (03) principles first. This page is the practical checklist.

## Add a new source document that posts
1. Do not pick accounts. Call `postJournalEntry` with `referenceType`, `referenceId`, role lines, and a `context` (or let `partyOfDocument` read the party). Add the document type to `partyOfDocument` (`postingContext.ts`) and to the party back-fill (`scripts/backfill-party-tags.ts`) if it touches a customer/vendor.
2. Call `assertPostingAllowed(req, postingDate, { vat })` before writing; give the document `doc_date` + `posting_date` (`documentDates()`).
3. Reversal = `reverseAllEntriesFor` (it already honours the bank-reconciliation lock).
4. If the document moves cash, write a **voucher** (every cash movement is one) and decide its `reversalIsCashOut` direction.
5. If older reports must see it, extend the single translator (`settlementFacts.ts` / `financialReports.ts`), not each report.
6. Add rows to Annex D, tests, translations, permission leaf (registry first, then the route check), audit call.

## Add a table
Company column + RLS policy + index + composite `(company_id, id)` unique if referenced; `db:push`; `apply-rls-policies.mjs`; add to `pre-push-keys.mjs` if an existing populated table gains the unique key; build routes on `withTenantDb`; isolation test; `check:isolation`.

## Add a report
Prefer a **report definition** (rows × columns) over code. A new figure must come from `resolvedLines`; compute server-side for `req.targetCompanyId`; no row cap.

## Add a screen
`src/components/ledger/*`, route case in `LedgerModule.tsx`, menu item in `App.tsx` (permission key), title and subtitle, translations in `src/glTranslations.ts`, print through `PrintDocContext` (`usePrintDoc`).

## Add a permission
`src/permissionSchema.ts` (grantable) **and** `hasPermission` in the route (enforced). Separate authority gets its own leaf (see `bankReconciliation.adjust`).

## Date and naming rules
`doc_date`, `posting_date`, `<meaning>_date` (type `date`), `created_at/by`, `updated_at/by`; snake_case in the database, camelCase in code and API.

## Verification before you say done
`npm run lint` · `npm run check:isolation` · new tests · `TEST_BASE_URL=http://localhost:3001 npx vitest run` · consistency check clean · translations applied · `npx tsx scripts/build-gl-docs.mjs --check` · docs rebuilt.

## Do not
* Adjust one figure to match another; find the rule and fix its enforcement.
* Add a bulk "save everything" route.
* Select accounts in a route, or compute a report in the browser.
* Run a Live release script from the 2.0 checkout, or merge v2 into master.
