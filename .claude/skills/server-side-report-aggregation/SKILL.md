---
name: server-side-report-aggregation
description: Use this skill whenever building or editing ANY report, dashboard KPI/card, list-screen total, running balance, or other aggregate figure in this ERP — trigger proactively even if the request doesn't mention performance or scale (e.g. "add a total to the vendor list," "build a new inventory valuation report," "show this month's revenue on the dashboard"). Also trigger when reviewing a new transaction/document-creation route that writes a value which later feeds a report or a permanent record (e.g. a fiscal-month close, a snapshot total). This app has a real, recurring bug class here — an aggregate number computed client-side from a row-capped or client-trusted source — and this skill is the standing rule to prevent it, not just the record of the one incident that found it.
---

# Server-Side Report Aggregation & Company Scoping (this ERP)

Every report, dashboard KPI, list-screen total, or running balance in this app must be computed **server-side**, scoped **exclusively** by `req.targetCompanyId`, over a query with **no row cap**. This is a standing architectural rule, not advice specific to one screen — read this before adding any new aggregate figure, and re-read it if a number "looks wrong for a big company" or "was right yesterday, wrong today."

## The incident this rule comes from

`src/db/apiState.ts`'s `getFullState()` (backing `GET /api/state`, the single blob every screen in this app used to compute reports from) caps `invoices`, `quotations`, `expenses`, `vouchers`, and `stockLedgerTransactions` to the most recent `DEFAULT_LIST_LIMIT` (500) rows — a deliberate, correct performance fix for an earlier unbounded-full-table-scan problem. The bug: every report/dashboard/KPI in this app was computed **client-side**, by summing those same capped arrays. Once a tenant's own history (or, before a first fix, the *whole platform's combined volume*) exceeded 500 rows in one of these tables, older rows silently fell out of the window — a tenant's own invoices/expenses/vouchers would vanish from their own dashboard and reports, with no error, no warning. Invisible at low volume; guaranteed to surface as real data loss exactly when this SaaS succeeds at scaling (see `CLAUDE.md`'s multi-tenant priority). Full incident and fix: BACKLOG.md items 110+.

A second, related issue found in the same investigation: `POST /api/transactions/months` (closing a fiscal month) stored `closedPnL` — a client-computed profit/loss figure — **as sent, unvalidated**, into a permanent record that later feeds the Balance Sheet. That's the same root mistake in a different shape: trusting a client-computed aggregate for something that matters, instead of having the server compute its own authoritative number.

## The rule

1. **Compute it server-side.** A dedicated function scoped by `companyId` (+ a date range, customer/vendor/investor/shift id, etc. where relevant), querying with **no `.limit()`** — Postgres returns everything that actually matches, however many rows that is. Sum in JS with `round2` (`server/lib/businessLogic.ts`), the same way `server/lib/vatReturn.ts`'s `computeVatReturnFigures` already does (the original, already-correct pattern this rule generalizes from) and `server/lib/financialReports.ts` continues. Do **not** reach for a naive `.limit(500)` "for safety" — a report's own scoping (one company, a real date range, one customer) already bounds the row count to whatever actually happened; a row cap on top of that is exactly the mistake this rule exists to prevent.
2. **Do not re-derive the underlying business math in raw SQL.** `SUM()`/`GROUP BY` is tempting but wrong here: this app's real calculations (discount shrink-factor, Credit Note sign-flip, tax-slab-percentage lookups) already live in `computeInvoiceServerTotals` and friends — reuse them. A second, independently-maintained implementation of the same math in raw SQL is exactly the "two implementations quietly drift apart" bug class `dbStore.ts`'s own Cancel Invoice incident (BACKLOG item 35) came from. Fetch the full scoped row set, run it through the existing helpers, sum the result.
3. **Company scope comes from `req.targetCompanyId` only — never `req.query.companyId`/`req.body.companyId`.** See [[session-company-scoping]] (`.claude/skills/session-company-scoping/SKILL.md`) for the full resolution mechanics and why skipping straight to a client-supplied value is the exact bug this app has already been burned by (BACKLOG item 64). A route that needs a company id reads `const companyId = req.targetCompanyId;` and 400s if it's falsy — full stop.
4. **No new client fetch call for a report/KPI ever sends a `companyId` param.** This is what makes "never stale after a super-admin switches companies" structural instead of something to hope holds — the server already knows which company a request is scoped to; the client re-sending it is both redundant and the exact opening for a stale-value bug. If a screen needs to show which company its numbers belong to, read it from the response (`/api/state`'s `activeCompanyId` field is the precedent — trust what the server says, never re-derive it client-side from `loggedUser.companyId`/local state).
5. **A plain list screen showing "the most recent N records" is fine** reading from the capped `/api/state` arrays — that's a reasonable product decision for a browsing/search screen, not a bug. This rule is specifically about **numbers someone will act on**: a total, a KPI card, a running balance, a figure that gets permanently written somewhere (a closed month's P&L, a filed VAT return, a posted voucher amount).

## Worked pattern to copy

```ts
// server/lib/financialReports.ts (or a new file, same shape)
export async function computeSomeReportFigure(companyId: string, startDate: string, endDate: string) {
  const rows = await db.select().from(schema.someTable).where(and(
    eq(schema.someTable.companyId, companyId),
    gte(schema.someTable.date, startDate),
    lte(schema.someTable.date, endDate),
  )); // no .limit() — the date range + companyId scoping already bounds this
  let total = 0;
  for (const row of rows) {
    total = round2(total + /* reuse existing business-logic helpers here */);
  }
  return { rows, total };
}
```

```ts
// server/routes/reports.ts
router.get('/reports/some-report', async (req: any, res) => {
  if (!hasPermission(req.user, 'reports.someReport')) return res.status(403).json({ error: 'Forbidden' });
  const companyId = req.targetCompanyId;
  if (!companyId) return res.status(400).json({ error: 'No company selected.' });
  const { startDate, endDate } = req.query;
  res.json(await computeSomeReportFigure(companyId, startDate, endDate));
});
```

Client side: fetch this endpoint on the same trigger the UI already uses to generate/refresh the report (mount, a "Generate" button, a date-range change) — never re-derive the total from `db.invoices`/`db.expenses`/etc.

## Before assuming an existing client-side report function is still authoritative

Several of this app's report/dashboard calculations (`Dashboard.tsx`, `ReportViewer.tsx`'s `getTrialBalance`/`getProfitLossData`/`getBalanceSheetData`, `SalesReportsModule.tsx`, `PurchaseReportsModule.tsx`, `PosModule.tsx`'s shift aggregates, `InvoiceModule.tsx`/`QuotationModule.tsx`'s KPI cards, `AdminSettings.tsx`'s Equity tab) are being migrated to this pattern (BACKLOG.md items 110+, project plan file). Before building on or "fixing" one of these client-side functions, grep `server/lib/financialReports.ts` and `server/routes/reports.ts` first — it may already have moved server-side, in which case the client-side function is either deleted or kept only because a different, still-legitimate caller needs it (e.g. `src/dbStore.ts`'s `calculateMonthPnL` stayed for the month-close confirmation *preview*, which is non-authoritative by design — the server recomputes the real value at the moment the request actually completes).
