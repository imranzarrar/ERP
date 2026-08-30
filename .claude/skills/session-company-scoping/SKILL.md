---
name: session-company-scoping
description: Use this skill whenever touching session/auth code (server.ts's isAuthenticated, login/logout, anything reading or writing req.session), whenever adding or debugging a route that returns or mutates company-scoped data, whenever writing a test that needs an authenticated session, or whenever a bug report describes data that "exists but doesn't show up" / "shows the wrong company's data" / "worked before, broken now" for a super-admin or after switching companies. This app has hit this exact class of bug multiple times — read this before assuming a scoping bug is a permissions issue or a cache issue, and before writing a new test that authenticates over HTTP.
---

# Session & Company Scoping (this ERP)

This app is multi-tenant: every business table carries a `companyId`, and which company a request should act on is resolved once, centrally, in `server.ts`'s `isAuthenticated` middleware (`req.targetCompanyId`). Every route trusts that value rather than re-deriving company scope itself. Getting that one resolution wrong breaks the whole app at once — which is exactly what happened in BACKLOG item 64, a real production bug: a super-admin's company selection was silently discarded on almost every request, for a long time, because of three separate, compounding bugs in this exact area. Read this before touching anything nearby.

## The resolution order — and why each fallback exists

`req.targetCompanyId` resolves in this order:
1. **Explicit per-request override** (`req.query.companyId` / `req.body.companyId` / `x-company-id` header) — used when a request is deliberately acting on a specific company right now, independent of whatever's "currently selected."
2. **The persisted session selection** (`req.session.companyId`) — this is what "the company currently selected in the UI" actually means. Set at login (defaults to the user's own company) and updated by `POST /api/switch-company` when a super-admin switches.
3. **The user's own home company** (`user.companyId`) — last-resort default.

**Do not skip straight to step 3.** That was the original bug: the fallback chain used to be "explicit param, else the user's own company" — step 2 didn't exist, so any request that didn't repeat `?companyId=` (nearly all of them) silently reverted to the caller's own company, discarding their actual selection. If you're adding a new route, you almost never need to read `req.query.companyId` yourself — just use `req.targetCompanyId`, already resolved correctly by the time your handler runs.

## `/api/state` scoping: never bypass filtering for a super-admin

Every business-data array in `/api/state`'s response (`invoices`, `customers`, `expenses`, everything) must be filtered by `req.targetCompanyId` **unconditionally** — including for a super-admin. The one deliberate exception is the `companies` array itself, which stays unfiltered because a super-admin needs the full list to populate the company switcher they use to pick a company in the first place. Everything else is tenant business data; a super-admin browsing one company must never receive every other tenant's data in the same payload just because their role bypasses a filter. This was the first of item 64's three bugs — `isSuper ? unfiltered : filter(...)` on nearly every field.

## Two auth paths exist, and they don't share session state the way you'd expect

- **Cookie-based** (`connect.sid`, set at login) — the normal path for a real browser. `req.session` and `req.sessionID` are stable and correct across requests for the lifetime of that cookie.
- **`x-session-id` header (or `sessionId`/`session_id` query param)** — a documented non-cookie path, looked up directly against the `user_sessions` table (see `isAuthenticated`). This exists for automated tests and any API-style client with no cookie jar (see `CLAUDE.md`).

**The trap**: on the `x-session-id` path, `req.session` is a *fresh, disconnected* object — express-session allocates one per request regardless of whether a valid cookie was presented. Writing to `req.session.foo = bar` and calling `req.session.save()` silently saves to a brand-new, unrelated `user_sessions` row, **not** the row the `x-session-id` value actually points to. A later request reusing the same `x-session-id` will never see that write. This was item 64's second bug, specific to `/api/switch-company`.

**The fix, if you're persisting something into "the current session"**: use `req.activeSessionId` (set by `isAuthenticated` — `req.sessionID` on the cookie path, or the raw `x-session-id`/query value on the non-cookie path) and write directly to that `user_sessions` row via a raw update, rather than relying solely on `req.session.save()`:

```ts
const [existingRow] = await db.select().from(schema.user_sessions)
  .where(eq(schema.user_sessions.sid, req.activeSessionId));
if (existingRow) {
  await db.update(schema.user_sessions)
    .set({ sess: { ...(existingRow.sess as any), companyId } })
    .where(eq(schema.user_sessions.sid, req.activeSessionId));
}
```

This is correct for *both* auth paths — on the cookie path `req.activeSessionId === req.sessionID`, so it's the same row `req.session.save()` would have written anyway.

## Testing auth: cookies don't work with curl or Node's `fetch` here, and that's expected

This app's session cookie is `cookie: { secure: true, sameSite: 'none' }`. Real browsers accept a `Secure` cookie over `http://localhost` — a documented browser-specific exception (localhost is treated as a secure context) — but bare HTTP clients (curl, Node's built-in `fetch`/undici, anything without that exception) do not, and the server will not even send `Set-Cookie` over a non-TLS connection in that case. If you write a test using cookies (extracting `Set-Cookie`, replaying `Cookie:`), it will fail with 401 and no amount of retrying fixes it — this isn't a bug to chase, it's the wrong tool for this environment.

**Always use the `x-session-id` header for tests** — log in via `POST /api/login`, take `body.sessionId` from the JSON response (not a cookie), and send it back as `x-session-id` on every subsequent request. This is the same pattern every existing test file in `tests/` already uses.

## The bug class that no server-side test can catch: stale React closures

Item 64's third bug was purely client-side, in `App.tsx`: the company switcher called `setDb(prev => ({...prev, selectedCompanyId: target}))` (schedules a React state update — doesn't apply until the next render) and then immediately `await triggerDbRefresh()`, a function whose closure still held the *previous* render's `db.selectedCompanyId`. The refetch explicitly passed that stale value as `?companyId=`, which then overrode the (correctly-updated) session moments after it was fixed server-side. This class of bug is invisible to this project's test suite by construction — every test here is a real HTTP + Postgres integration test (deliberately no mocks, no React rendering) — so a bug living entirely in `useState`/closure timing can only be found by reading the code, never by a failing assertion. If you're debugging a scoping/permission bug where the server-side fix is verified correct (a direct API test passes) but the real UI still shows wrong data, **stop assuming it's still a server bug** — check for exactly this: a client-side function reading a value from its own closure that a sibling `setDb`/`setState` call in the same handler hasn't actually applied yet. The fix is usually to stop passing the stale value explicitly and let the (already-correct) server-side session resolve it instead.

## When a report says "the data isn't there"

Verify against the database directly before touching any code. Item 64 started as "invoices aren't showing" and the very first step was a direct Postgres query confirming the rows existed, were correctly saved, and correctly scoped — which is what turned a vague report into "the write path is fine, the read/scoping path is broken," instead of chasing the wrong half of the system. Don't accept your own "should be fixed now" as confirmation either — re-test directly against the real company/account named in the report once each fix lands, not a synthetic fixture; item 64's own first "it's fixed" claim (after the first two of three bugs were fixed) was wrong, and only re-testing against the real data caught it.
