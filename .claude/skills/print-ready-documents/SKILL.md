---
name: print-ready-documents
description: Use this skill whenever building, editing, or debugging any printed/PDF business document in this ERP — invoices, quotations, expenses, vouchers, POS receipts, bank ledgers, or financial reports. This covers work in src/components/DocumentRenderer.tsx, src/documentTemplateDefaults.ts, or AdminSettings.tsx's Template/Canvas Designer tab; adding or repositioning a field on a printed document; changing fonts, spacing, or colors on a template; adding a new page size (e.g. a new receipt/label size); or any complaint that the PDF/printout doesn't match the on-screen preview, looks cut off, has a blank second page, shows the wrong font (especially Arabic/Urdu), or is generally not "print quality." Trigger this proactively even if the user just says "add a field to the invoice" or "the printed receipt looks off" without mentioning print/PDF/template explicitly — any change to what a document looks like when printed falls under this skill.
---

# Print-Ready Documents (this ERP)

This project already has a mature, hand-tuned print pipeline with several hard-won fixes baked into it — code comments in `DocumentRenderer.tsx` document real bugs that were shipped and caught (phantom blank pages, missing styles, wrong Arabic font). The point of this skill is to keep building on that foundation instead of re-discovering — or worse, re-introducing — the same failure modes. Read `references/print-fidelity-details.md` before touching the print pipeline itself (the `handlePrint` function, the `@media print`/`@page` rules, or anything about how the popup window is constructed) — it has the full "why" behind each rule below, with the exact code it protects.

## The one rule everything else follows

**The screen preview and the printed/PDF output must be the exact same render, not two separate implementations that are supposed to look alike.** This codebase already does this correctly: `DocumentRenderer`'s `embedded` prop lets the Canvas Designer preview and the real print output share one component and one data path — there is no separate "designer mockup." If you're ever tempted to build a simplified preview for speed or convenience, don't — that's exactly how "the PDF doesn't match what I saw on screen" bugs get created. Any new document type or view should reuse `DocumentRenderer`, not fork it.

## Workflow

1. **Find the single source of truth before adding a field or block.** Layout defaults live in `src/documentTemplateDefaults.ts` (`DEFAULT_DOCUMENT_LAYOUT`) — both the Canvas Designer and `DocumentRenderer`'s no-layout fallback import this one array (a past bug had them drift into two different default layouts). If you're adding a new block type, add it here, not as a second hardcoded default somewhere else.

2. **Respect the existing 12-column grid reasoning.** `DEFAULT_DOCUMENT_LAYOUT`'s header comment lays out *why* each block is sized and paired the way it is (logo+metadata sharing a row, seller/buyer side-by-side, items table full-width, totals getting the most prominent position). When adding a field, fit it into this reasoning rather than bolting it on — e.g. a new metadata field belongs inside `doc_details`'s props, not as a new top-level block competing for row space, unless it genuinely needs its own visual weight.

3. **Use the project's established font system — don't introduce a new font casually.** `src/index.css`'s `@theme` block defines `--font-sans` (Inter, general UI/body), `--font-display` (Space Grotesk, headings), `--font-mono` (JetBrains Mono, numbers/codes), `--font-serif` (Lora — chosen specifically because it's a genuine print-legible text serif, not Tailwind's Times/Georgia fallback), and `--font-arabic` (Cairo, the only font in the stack with real Arabic glyphs). If a template needs a new *look* (not a new script), reach for a pairing within this system before adding a Google Fonts import — every new font is another network dependency in the print popup that can silently fail to load in time.

4. **Never let a Latin font class win over the Arabic font on an RTL document.** `getGlobalFontClass()` in `DocumentRenderer.tsx` returns `''` for RTL docs specifically so the outer container's `font-arabic` inheritance isn't overridden — none of the Latin template fonts (Inter/Space Grotesk/JetBrains Mono/Lora) have Arabic glyph coverage, so overriding silently falls back to whatever font happens to be on the viewer's OS/print driver, which is inconsistent across machines. If you add a new font-family selector anywhere in the template system, it needs this same RTL guard.

5. **Before shipping any print-pipeline change, verify with the checklist in `references/print-fidelity-details.md`.** At minimum: no forced minimum page height, the print popup clones *every* `<style>`/`<link rel="stylesheet">` tag (not a hand-picked subset), the printable wrapper is serialized with `.outerHTML` (not `.innerHTML`), `@page` size/margin values are set once and consistently (there are currently two separate `@media print` blocks — `index.css`'s general one and `DocumentRenderer`'s popup-specific one — see the reference doc for which one actually governs the popup and why both exist), `print-color-adjust: exact` is present (browsers strip background colors from print output by default — the single most likely cause of "the PDF doesn't match the screen," and easy to miss since it's invisible in the on-screen preview), and `window.print()` waits on `document.fonts.ready` rather than firing straight from `window.onload` (a webfont mid-download at print time silently falls back to a system font for that one snapshot).

6. **Verify visually, not just by reading the code.** Open the app, navigate to the document (or the Canvas Designer's live preview, which is the same render path), and:
   - Trigger the real Print action and inspect the popup's rendered output, not just the on-screen page — that's the actual print/PDF surface.
   - Check the page count. A short document (e.g. a 2-line expense) spilling onto a near-blank second page means something is forcing a minimum height again.
   - If the document supports Arabic/Urdu, switch to that language and re-check — this is the single most common place fidelity breaks (see rule 4).
   - If the template has a thermal receipt size (`4in x 6in`), check it separately from A4 — it has its own font-size/padding/logo-size overrides that only apply at that page size.
   - Compare information density and whitespace against a real invoicing document, not just "does it look full" — efficient use of space means confident whitespace and clear hierarchy, not cramming every pixel.

## When you're designing layout/spacing, not just wiring a fix

This project already has a spacing scale for template rows (`gridGapY`: `tight` / `compact` / `normal` / `loose`, see `getGridGapClass()`) and per-block typography overrides (`getBlockTypographyClasses`/`getBlockStyle`). Prefer these existing knobs over ad-hoc inline styles — they're what the Canvas Designer's UI actually exposes to admins, so a layout built with inline one-off styles becomes unmaintainable through that UI. General principles that apply on top of these existing tools:

- **Hierarchy over decoration.** The grand total, invoice number, and customer name are what a reader's eye should land on first — size/weight/color should reflect that, not uniform styling for everything.
- **Group by relationship, not by arrival order.** Seller info and buyer info sit side-by-side because they're compared, not because they were coded in that sequence — apply the same logic to any new fields.
- **Whitespace is a design decision, not leftover space.** A dense financial table (items) can sit right next to generous whitespace around the totals block — that contrast is what makes the total easy to find, not a rendering inconsistency to "fix."
- **Tables must survive real data**, not just the 2-3 row example you're testing with — check a long-line-item invoice for row-striping/pagination behavior, not just a short one.

## Scope note

This skill covers the *rendering/print* side of documents. It does not cover business logic like tax/total calculations, ZATCA XML/hash-chain generation, or voucher posting — those are separate, unrelated systems (see the project's `CLAUDE.md` for the ZATCA pipeline specifically, which has its own much stricter verification protocol and should not be touched casually).
