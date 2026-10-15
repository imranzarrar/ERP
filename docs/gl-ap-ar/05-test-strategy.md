# Test Strategy — General Ledger, Receivables, Payables 2.0

Version 1.0 / 2026-10-15. The complete case list is the catalogue in `docs/test-cases/` (290 cases: CSV, JSON, Gherkin); each case is traced to a system requirement and a business requirement in the traceability matrix (08).

## 1. Objectives

1. Prove every business requirement with at least one repeatable test; none is "verified by looking".
2. Make money-affecting behaviour (posting, settlement, reconciliation, period rules) regression-proof.
3. Prove tenant isolation at the database level, not only in routes.
4. Keep the suite runnable by one command against a real server and database, so it can be automated by any tool.

## 2. Principles

* **No mocks.** Tests make real HTTP requests to a running server and assert directly in PostgreSQL.
* **Each scenario owns its data.** A throw-away company, users, bank and master data are created in `beforeAll` and purged in `afterAll` (`tests/helpers/purgeCompany.ts`); seeded demo companies are never touched.
* **Through the door a user can reach.** Fixtures use the real routes (or screens for UI tests); data no user could create is not a valid fixture.
* **A test names its requirement.** Put the catalogue id in the `it(...)` title when automating a case (`it('RCP-013 cancels a receipt …')`).
* **The consistency check is an oracle.** Financial scenarios end by running `/api/reports/consistency-check` and expecting no error-level failure; Ledger-vs-Documents must agree.

## 3. Levels

| Level | What | Tool | Where |
|---|---|---|---|
| Static | Types, cross-tenant FK tripwire, catalogue/doc consistency | `npm run lint`, `npm run check:isolation`, `node scripts/build-test-catalogue.mjs --check`, `npx tsx scripts/build-gl-docs.mjs --check` | CI-ready scripts |
| API / integration | Routes + services + Postgres | vitest (`tests/*.test.ts`) | 80+ files |
| Database | RLS, composite keys, constraints, migrations | vitest with a second `erp_app_tenant` connection | `rlsPolicyCoverage`, `crossCompanyIsolation`, per-feature files |
| UI | Screens, print preview, RTL | Playwright (Chromium installed) | catalogue cases marked UI / Manual |
| Non-functional | Concurrency, volume, load | vitest parallel calls; k6/Artillery for load | catalogue module NFR |
| Release | Migration, idempotency, rollback | dry run on a copy of production | catalogue module REL |
| Exploratory / UAT | Walk the user manual with a fresh company | Person | Section 8 |

## 4. Test types covered

Functional, negative, boundary, security (permissions, isolation, injection, session), integration (posting ↔ reports ↔ subledger ↔ bank), regression (past incidents), usability (screens, RTL), performance (volume, concurrency). The type, priority (P1 money / compliance / isolation, P2 core flow, P3 comfort) and layer of every case are in the catalogue.

## 5. Environments and data

| Environment | Use |
|---|---|
| Local 2.0 (`localhost:3001`, database `erp_v2`) | Development and the automated suite (`TEST_BASE_URL=http://localhost:3001 npx vitest run`) |
| Demo (VPS, port 4000, database `erp_demo`) | Owner acceptance, scrubbed copy of production allowed |
| Live (master) | Fixes only; promotion tested on a copy first (S20) |

Tests need a running server (restart after backend edits; the 3001 server has no watcher) and the SMTP-dependent files (`companyOnboarding`, `passwordReset`) fail without a real mail server: that is expected and listed in the release notes.

## 6. Entry and exit criteria

* **Entry** for a sprint item: BR and FR exist; cases identified or drafted in the catalogue.
* **Exit** for a sprint: all its cases automated or explicitly marked Manual with a recorded UI walk-through; `npm run lint` clean; `check:isolation` clean; full suite green except the known SMTP files; consistency check clean on a mixed-activity company; translations applied (EN/AR/UR); documents rebuilt (`build-gl-docs.mjs`) with no problems.
* **Release** exit: reviewed `db:push` plan shows additive changes only; RLS and constraint scripts verified; health check passes; rollback tag recorded.

## 7. Defect handling

A defect is fixed where the rule is enforced (engine, guard, helper), with a regression test named after the catalogue id (or a new case added to the source). No figure is "adjusted" to make a report agree.

## 8. UAT script

Follow the user manual (06) end to end in a new company: set up, post documents, receive and pay, reconcile, close the period, print. Every step has an expected screen and figure; record deviations as new catalogue cases.

## 9. Coverage and traceability

* Forward and backward mapping: `08-traceability-matrix.md` (generated; fails the build if a built requirement has no case or a case maps to no requirement).
* Automation status per case (Automated / Candidate / Manual): `docs/test-cases/README.md`.
* To automate a Candidate: copy the nearest vitest file (for example `tests/settlements.test.ts` for money flows, `tests/bankReconciliation.test.ts` for sessions), add the case id to the title, then change its `automation` to the file in `docs/test-cases/catalogue-source.mjs` and rebuild.

## 10. Tooling map for external automation tools

| Tool | Consumes |
|---|---|
| TestRail / Xray / Zephyr / Azure Test Plans | `test-case-catalogue.csv` |
| Cucumber / Playwright-BDD / Behave | `docs/test-cases/features/*.feature` |
| Postman / Newman | Annex B (API reference) |
| k6 / Artillery | Scenarios NFR-001…009 (thresholds in the case text) |
