---
name: agreed-decisions
description: Use at the START of any work on the chart of accounts, dimensions, posting or account determination, tax, budgeting, costing, profit or cost centres, projects, periods, reports, approvals or any finance design, and before writing any analysis, benchmark or proposal in those areas. It makes you re-read everything the owner has already agreed (docs/design-notes/agreed-decisions-register.md) so a new design never contradicts it. Trigger even when the request looks small.
---

# Refresh everything that was agreed, then work

The owner has repeatedly had to restate agreed decisions (for example: dimensions are unlimited and flexible and serve budgeting, costing, control and profit and loss, so profit centre, project and budget are capabilities of the dimension framework, never separate modules). This skill stops that.

## Steps (in order, every time)

1. **Read `docs/design-notes/agreed-decisions-register.md` in full.** Not a skim: it is short on purpose.
2. **Read the memory index** (`C:\Users\hp\.claude\projects\E--ERP\memory\MEMORY.md`) and open the entries that match the area (tier-1 depth standard, architecture first, consistent column names, GL step 1, step 2, docs structure, live versus demo).
3. **Read the decision sources the register points to** for the area you touch: `docs/design-notes/gl-step1-5-decisions.md` (dimensions, reports, posting profiles), the decision table D1 onward in `docs/gl-ap-ar/03-solution-design-document.md`, the Blueprint extract (`docs/reference/Finance-Core-Blueprint.pdf`), and the area's design note.
4. **Write at the top of your answer or document**: "Agreed entries that apply: AG-.., AG-.." and, for each, one word: *follows* or *conflicts*. If any *conflicts*, stop and ask the owner before continuing; do not quietly replace an agreed decision.
5. **Check the code against the agreed entries** before claiming a gap: a gap is "what the agreed design needs that the code lacks", not "what a tier-1 product has that we lack". Tier-1 comparison (AG-71) is done **inside** the agreed architecture, not instead of it.
6. **Review what was agreed, do not just obey it (AG-77).** Compare each applicable entry with tier-1 practice and with professional accounting guidelines (the checklist in register section K: double entry, cut-off, audit trail, segregation of duties, IFRS presentation, inventory, currency, revenue, provisions, taxes, local law). Record the verdict (Confirmed, Refine, Challenge) and any suggested change in register section J and put the suggestions in front of the owner. Change an entry only when the owner agrees.
7. **After the work, update the register in the same session**: new agreement, changed entry, or a proposal moved between "agreed" and "awaiting decision", with date and source. Then rebuild the documents (`update-docs-after-development`).

## Never

* Propose a separate module or ledger for something the agreed dimension framework is meant to carry (AG-10, AG-11).
* Treat the Blueprint as the ceiling (AG-71) or as contradicting an owner statement (owner-stated entries win).
* Present a proposal as agreed, or leave an agreed item out of the register after it was agreed.
* Skip this skill because the task is "just a benchmark" or "just a note": that is exactly how the 2026-10-19 error happened.
