---
name: update-docs-after-development
description: Use after ANY development on the General Ledger / Receivables / Payables / Bank core (or any finance-core feature, schema change, route, screen, permission, report, release step) and before saying the work is done. Updates every document of the GL/AP/AR 2.0 set — BRD, SRS, solution design, technical design, test strategy and catalogue, user manual with screenshots, sprint log, traceability matrix, data dictionary, API reference, permissions, posting rules, developer guide, runbook, glossary, README, CLAUDE.md, memory — then validates the mapping, commits and pushes. "All" means all: no document may be left stale.
---

# Update every document after development

The documentation set lives in `docs/gl-ap-ar/` (map: its `README.md`). Requirements, system requirements, sprints and test cases are **generated and validated** from four source files; the rest is hand-written and must be edited by whoever changed the behaviour. A change is not done until this skill has been walked through. Do it in the same session as the code, not later.

## 0. Decide what changed (one minute)
Write down, in one line each: new/changed **requirement** (what the business gets), **behaviour** (rules, states, posting), **data** (table/column/key), **API** (route, permission), **screen** (menu path, text), **report/print**, **release step** (script, back-fill), **limitation or decision**. Every line maps to rows in section 2.

## 1. The four source files (single source of truth — edit these, never the generated output)
| File | Edit when | What to do |
|---|---|---|
| `docs/gl-ap-ar/source/brd.mjs` | a business need is added, changed, delivered or descoped | add/modify the BR row (title, text, source, priority, **status**: Built / Partial / Planned, Blueprint refs). A BR turns *Built* only when every part is delivered and tested; otherwise *Partial* and say what is missing in its text |
| `docs/gl-ap-ar/source/srs.mjs` | how the system meets a BR changes | one or more FR statements per BR with the implementation anchor (file/route/screen) and the test-case ids (ranges allowed). A Built/Partial BR must list at least one test |
| `docs/gl-ap-ar/source/sprints.mjs` | work is planned, started or finished | add the sprint and its items (each names the BRs it serves); set `status` (Planned / In progress / Done), `dates`, and the **commit hashes** once committed |
| `docs/test-cases/catalogue-source.mjs` | a scenario is added, automated or retired | add cases to the right module (or add a module); set `automation` to the vitest file that really proves it, else `Candidate` / `Manual`. Put the case id in the `it('XXX-nnn …')` title of the automated test |

Rules: every BR is in at least one sprint item; every Built BR has a Done sprint; every test case traces to an FR; sprint items name real BRs.

## 2. Hand-written documents — update each one the change touches (when unsure, update it)
| Change | Document(s) to edit |
|---|---|
| New or changed principle, flow, state machine, decision | `03-solution-design-document.md` (principles, decision table D#, diagrams, risks) |
| Algorithm, module, table use, route logic, trap | `04-technical-design-document.md` (module map, the relevant section, known traps) |
| Test approach, new test type, environment, exit criteria | `05-test-strategy.md` |
| Any screen, menu path, button, message, flow | `06-user-manual.md` (chapter, "If the system says…" table, roles table, screen index) **and re-capture screenshots** (section 4) |
| A document posts or its entry changes | `annex-d-posting-rules.md` |
| New pattern developers must follow, new trap | `annex-e-developer-guide.md` |
| Release step, script, back-fill, rollback, support check | `annex-f-operations-runbook.md` |
| New term | `annex-g-glossary.md` |
| Anything above changes the document map | `docs/gl-ap-ar/README.md` |
| Research or decision on a future sprint | the sprint's own note (e.g. `s11-approval-rules-tier1-research.md`: decisions section) |
| Earlier working notes that the change makes wrong | fix or add a dated correction note (`docs/design-notes/ar-ap-bank-design.md` as-built section, `docs/design-notes/posting-control.md`, `docs/design-notes/date-fields-standard.md`, `docs/design-notes/accounting-rules.md`, `docs/design-notes/reporting-rules.md`) |
| Repo-wide commands, environments, conventions | `CLAUDE.md` |
| Standing decisions or project state the next session needs | project memory (`project_*.md`, `MEMORY.md` index line) |

## 3. Generated documents — rebuild, do not edit
```bash
node scripts/build-test-catalogue.mjs        # test cases: CSV, JSON, Gherkin, README
npx tsx scripts/build-gl-docs.mjs            # BRD, SRS, sprint log, traceability, data dictionary (A), API reference (B), permissions (C)
npx tsx scripts/build-gl-docs.mjs --check    # MUST print "OK" (fails on unmapped BR/FR/test/sprint)
node scripts/build-docs-html.mjs             # the two reading copies: docs/technical/index.html (+3 linked pages) and docs/user-manual/warraq-erp-user-manual.html; MUST print "OK" (every link, image, anchor resolves)
```
The two HTML documents are what people read (`docs/index.html` is the start page): never edit them. The technical one is built from the chapters listed in `CH` at the top of `scripts/build-docs-html.mjs` (add a new hand-written chapter there); the manual is the hand-built everyday-operations part (`docs/user-manual/source/part-a-everyday-operations.html`, edit by hand when a 1.0 screen changes) followed by the finance-core chapters from `docs/gl-ap-ar/06-user-manual.md`. Retired plans go to `docs/archive/` (add a line to its README), never into the top level.
The data dictionary reads `src/db/schema.ts` (write a `// comment` on every new column: it becomes the "Note" column), the API reference reads `server/routes/*.ts` (add the route file to `APIFILES` in `scripts/build-gl-docs.mjs` if it is new, and its mount prefix is read from `server.ts`), the permission annex reads `src/permissionSchema.ts` (add the group to the filter if new).

## 4. Screens in the manual
If any screen, menu entry, label or flow changed, edit `scripts/capture-manual-screens.ts` (add steps/seed data for the new screen; keep the order of the manual), run it with the 2.0 server up (`npx tsx scripts/capture-manual-screens.ts`; it creates a throw-away company, uses Chrome with `--no-sandbox`, and deletes the company), **look at the new images**, and reference them from `06-user-manual.md`. Delete only screenshots that the latest run no longer lists in `user-manual/screens/_index.json`, by explicit file name.

## 5. Translations
Every new user-visible string: add `[key, Arabic, Urdu]` to `src/glTranslations.ts`, then `npx tsx scripts/apply-gl-translations.ts --apply`. Server-generated names shown in reports (e.g. trial balance line names) are translated too.

## 6. Final gate (all must pass before "done")
1. `npm run lint` clean · `npm run check:isolation` clean.
2. New and affected tests pass: `TEST_BASE_URL=http://localhost:3001 npx vitest run <files>`; before a release, the full suite (only the SMTP-dependent `companyOnboarding` / `passwordReset` may fail).
3. `node scripts/build-test-catalogue.mjs`, `npx tsx scripts/build-gl-docs.mjs` and `node scripts/build-docs-html.mjs` run; `--check` and the HTML build print OK. **Chain the build, `--check`, lint and `git commit` with `&&` (never `;`) so a failure stops the commit and the push**: a source file with an unescaped apostrophe once broke the generators and was pushed.
4. Every row of section 2 reviewed (state "reviewed, no change" only when true).
5. `git add -A`, commit with the sprint item in the message, `git push origin v2` (2.0 only; never merge v2 into master).
6. If the release needs it: say which release steps changed (annex F) and run the Demo release (`deploy/release-demo.sh`); report the result.
7. The reply to the user lists: what changed, which documents were updated, test results, anything left open — including honest limits.

## 7. Never
Edit a generated file by hand · mark a BR Built that is only partly delivered · map a test case to a file that does not assert it · leave a screen in the manual that no longer exists · skip the manual's screenshots after a UI change · say "docs updated" without running `--check`.
