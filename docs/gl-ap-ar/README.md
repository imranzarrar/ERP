# GL / AP / AR 2.0 — documentation set

The source of truth for the finance core of Warraq ERP 2.0 (General Ledger, Receivables, Payables, Bank). It is traceable end to end: **Blueprint → business requirement (BR) → system requirement (FR) → test case → sprint**, forwards and backwards, and the mapping is validated by a script.

| # | Document | Kind |
|---|---|---|
| 01 | [Business Requirements Document](01-business-requirements-document.md) | generated from `source/brd.mjs` |
| 02 | [Software Requirements Specification](02-software-requirements-specification.md) | generated from `source/srs.mjs` |
| 03 | [Solution Design Document](03-solution-design-document.md) | hand-written |
| 04 | [Technical Design Document](04-technical-design-document.md) | hand-written |
| 05 | [Test Strategy](05-test-strategy.md) + the 290-case catalogue in [`../test-cases`](../test-cases/README.md) | hand-written + generated |
| 06 | [User Manual](06-user-manual.md) (screens in `user-manual/screens`) | hand-written; screens captured by script |
| 07 | [Sprint log and plan](07-sprint-log.md) | generated from `source/sprints.mjs` |
| 08 | [Traceability matrix](08-traceability-matrix.md) | generated |
| A | [Data dictionary](annex-a-data-dictionary.md) | generated from `src/db/schema.ts` |
| B | [API reference](annex-b-api-reference.md) | generated from `server/routes` |
| C | [Permissions matrix](annex-c-permissions-matrix.md) | generated from `src/permissionSchema.ts` |
| D | [Posting rules catalogue](annex-d-posting-rules.md) | hand-written |
| E | [Developer guide](annex-e-developer-guide.md) | hand-written |
| F | [Operations runbook](annex-f-operations-runbook.md) | hand-written |
| G | [Glossary](annex-g-glossary.md) | hand-written |

Earlier working documents (still valid as history and rationale): `docs/gl-step1-plan.md`, `gl-step1-5-decisions.md`, `ar-ap-bank-design.md` (see its *As built* section), `posting-control.md`, `date-fields-standard.md`, `accounting-rules.md`, `reporting-rules.md`, `sprint-log-gl-step*.md`.

## Ids

`BR-<AREA>-nn` business requirement · `FR-<AREA>-nn.k` system requirement (k-th of its BR) · `S<n>` sprint, `S<n>-nn` sprint item · test cases `<MODULE>-nnn` (e.g. `RCP-013`) · Blueprint `FR-XXX-nn` as printed in `docs/Finance-Core-Blueprint.pdf`.

## How to change anything (the rule)

1. New or changed need → edit `source/brd.mjs` (BR). How the system meets it → `source/srs.mjs` (FR, anchor, test ids). When it is built → `source/sprints.mjs`. New test → `docs/test-cases/catalogue-source.mjs`.
2. `npx tsx scripts/build-gl-docs.mjs --check` validates: every BR has FRs; every built BR has a test and a Done sprint; every BR is in a sprint; every test case traces to an FR; sprint items name real BRs.
3. `npx tsx scripts/build-gl-docs.mjs` regenerates 01, 02, 07, 08 and annexes A–C; `node scripts/build-test-catalogue.mjs` regenerates the catalogue; `npx tsx scripts/capture-manual-screens.ts` (server on 3001 running) regenerates the manual's screens.
4. Hand-written documents (03, 04, 05, 06, D–G) are updated by the developer who changes the behaviour; the Definition of Done in the test strategy lists the check.

Never edit a generated file by hand.
