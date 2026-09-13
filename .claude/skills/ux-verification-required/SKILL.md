---
name: ux-verification-required
description: Mandatory for every code change in this app — a new feature, an edit to existing behavior, a bug fix, a schema change, anything touching server/routes, src/components, or server/lib. Trigger proactively before declaring any such change done, not only when the user explicitly asks for testing. `tsc --noEmit` passing and `npm run check:isolation` passing are necessary but never sufficient — this app has repeatedly had type-check-clean changes that were wrong or incomplete in the actual running UI (a translation that resolved through the wrong dictionary, a numbering default that looked right in code but showed the wrong value in the Doc Settings table, a picker whose Enter key could silently submit an unselected value). Every change needs to actually be driven in the browser against the real dev server and real Postgres data before it's reported as complete.
---

# UX-Level Verification Required (this ERP)

## Why this exists

In one session, several changes that were correct by type-checking and code review alone turned out to be wrong or incomplete once actually clicked through in the browser:
- A translation key added to the right dictionary in code still printed in English on an Arabic invoice, because the real lookup for that render path went through a *different* dictionary than the one edited (see the `single-source-of-truth` skill for the full story) — only caught by actually opening the print preview and reading it.
- A numbering-settings table row showed "Pad Width: 0" for a type whose real effective default was 5, and flagged three unrelated master-data sequences with a false "prefix collision" warning — both only visible by actually opening the Document Numbering tab.
- A searchable customer picker's Enter key could fall through to a native form-submit when nothing matched, silently keeping whatever customer was previously selected — a real defect no type-checker or lint pass could ever catch, only found by testing the actual keyboard interaction.

None of these were exotic edge cases — they were the *first thing a user would hit* using the feature normally. `tsc --noEmit` and `npm run check:isolation` (per `CLAUDE.md`) both passing is necessary, routine hygiene, not evidence the feature works.

## What to actually do, every time

1. Follow `CLAUDE.md`'s Commands section: start (or confirm already running) `npm run dev`, and give the backend a couple of seconds after any server-side file save before trusting the next request (it auto-restarts, but not instantly).
2. Use the Browser pane (`preview_start`, `navigate`, `computer`, `find`, `read_page`, `get_page_text`) to actually drive the change — log in, navigate to the real screen, perform the real action a user would perform. Prefer the seeded demo company "CNC Woodcraft & Design" for manual QA per `CLAUDE.md`; never touch it in ways that would corrupt data other sessions rely on, and prefer creating fresh throwaway test records over mutating seeded ones.
3. Test the golden path AND at least one adjacent case that isn't the golden path — a second language, an edge value, a second entry point into the same feature (e.g. this session's server-side company-provisioning path vs. the client-driven one, both of which call the same feature but are separate code paths that can silently diverge).
4. If the change touches printed documents, actually open the print preview for more than one template/language combination — printed output has repeatedly been the place where a change looked right in the editor and wrong on paper.
5. If the change touches a form or picker, actually type into it and use the keyboard (Enter, Tab, Escape), not just mouse clicks on obviously-correct paths — several real defects in this app have only existed on the keyboard path.
6. Only report a change as complete after this — not after `tsc`/lint alone. If browser verification genuinely isn't possible (no UI surface, a pure backend script, timing constraints), say so explicitly rather than silently skipping it, per this project's own stated norms.

This complements, not replaces, `npm run check:isolation` (server route changes) and `npm run lint` (every non-trivial change) from `CLAUDE.md` — do all of them, not one instead of another.
