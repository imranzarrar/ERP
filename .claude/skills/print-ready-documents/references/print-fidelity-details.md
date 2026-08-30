# Print Fidelity — Deep Reference

The full "why" behind SKILL.md's checklist, with the exact mechanics of this project's print pipeline. Read this before editing `DocumentRenderer.tsx`'s `handlePrint` function, either `@media print` block, or anything about page sizing/fonts in the print path.

## How printing actually works here

There is no PDF-generation library in this project (`package.json` has no `puppeteer`/`playwright`/`jspdf`/`react-pdf`/`pdfkit`). Printing/PDF export is entirely the browser's native mechanism:

1. `DocumentRenderer.tsx`'s `handlePrint()` opens a blank popup window (`window.open('', '', 'height=800,width=1000')`).
2. It clones the **entire** `<head>` styling of the live app into that popup, then writes the printable element's HTML into the popup's `<body>`, followed by its own extra `<style>` block for print-only page geometry.
3. It calls `window.print()` inside the popup on load. The user's browser print dialog (with "Save as PDF" as one destination) is what actually produces the PDF — this project has no control over that dialog itself, only over the HTML/CSS fed into it.

This means "PDF matches preview" is entirely a function of the popup's HTML/CSS matching the live page's rendering — there's no separate rendering engine to keep in sync, but there's also no safety net if the popup's construction silently drops something the live page has.

## Bugs already found and fixed here — don't reintroduce them

### 1. `md:` breakpoints silently don't apply during actual print/PDF rendering — the deepest one

**Never use a bare `md:` (or any viewport-width variant) for layout inside the printable document. Always pair it with the matching `print:` variant.**

`md:` is `min-width: 48rem` (768px) — a query against the rendering *viewport's width*. The on-screen print popup is opened at `width=1000`, comfortably past that breakpoint, so `md:col-span-6`/`md:ms-auto`/etc. all correctly apply there. But **Chrome evaluates width-based media queries during actual print/PDF rendering against the physical page's printable width, not the popup window's width.** A4 (8.27in) minus this app's own 0.4in-per-side print margin leaves ~7.47in printable — at 96 CSS px/in that's **~717px, below the 768px `md:` breakpoint**. The practical effect: a layout that is visibly correct in the on-screen popup — confirmed live, screenshotted, looked right — still comes out wrong in the actual generated PDF, because `md:*` silently never activates at the point Chrome actually rasterizes the page. This is *not* the same bug as the dynamic-class-name issue below (fixing that one is necessary but not sufficient) — it reproduces even with every `md:col-span-N` class correctly present in the compiled CSS.

Confirmed affected and fixed: `documentTemplateDefaults.ts`'s `COL_SPAN_MD` lookup now has a parallel `COL_SPAN_PRINT` (`print:col-span-N`), applied together everywhere a block width is set. Also fixed: `docDetailsPosClass`/`totalsPosClass` in `DocumentRenderer.tsx`, which used `md:ms-auto`/`md:mx-auto`/`md:ml-auto` alone for right/center alignment (the doc-metadata header box and the totals summary box) — now each has a matching `print:ms-auto`/`print:mx-auto`/`print:ml-auto`. `print:` is a media *type* query (`@media print`), completely independent of width, so it's immune to this.

**If you add any new `md:`-gated positioning/sizing class inside the printable document, add the matching `print:` variant in the same edit** — a bare `md:` class there is presumptively wrong, not presumptively fine. (Outside the printable content — e.g. the modal backdrop/chrome around the document, which is never cloned into the print popup — plain `md:` is fine as normal responsive styling.)

### 2. Missing `print-color-adjust: exact` — the single most likely cause of "the PDF doesn't match the screen"

Browsers strip `background-color`, `background-image`, and `box-shadow` from print/PDF output by default (an ink-saving mode), **regardless of what the element's own CSS specifies** — this is a print-engine default, not a bug in any component's styling, and it is invisible in the on-screen preview since it only applies at print time. Every colored table header, status badge, and accent-colored totals box in this app (all Tailwind `bg-*` usage) printed as plain white until this was set. Fixed in two places — both need to stay in sync if either is touched:
- `src/index.css`'s `@media print` block (`* { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }`).
- `DocumentRenderer.tsx`'s popup-specific `<style>` block inside `handlePrint()` (same rule, since the popup is a separate document that only inherits what's explicitly cloned/written into it — `index.css`'s rule doesn't reach it directly, it's cloned in as one of the `<style>` tags, but the popup also carries its own copy as a belt-and-braces guarantee, matching the existing pattern for the Cairo font `@import` fallback below).

If a printed/PDF'd document is missing colors that are clearly present on screen, check this first — it's a one-line, well-documented browser default, not a rendering logic bug.

### 3. Font-loading race — printing before a webfont finishes downloading

```js
// window.onload fires once the popup's own resources ... have started loading, but does
// NOT reliably wait for an @import-loaded webfont to actually finish downloading and
// apply before firing — inconsistent across browsers. Printing before that finishes
// silently falls back to a system font for that snapshot only.
```

`handlePrint()` used to call `window.print()` directly from `window.onload`. The popup's fonts (Inter/Space Grotesk/JetBrains Mono/Lora/Cairo) load via a Google Fonts `@import`, and `window.onload` firing doesn't reliably wait for that import's actual font files to finish downloading and apply — especially on a cold cache (first print of a session). If `window.print()` fires first, that one print/PDF snapshot silently renders in a fallback system font while the on-screen preview (which had normal page-load time to fetch the font) looks correct — a real, easy-to-miss "fonts don't match" fidelity gap. Fixed by racing `document.fonts.ready` (resolves once every requested font has actually loaded) against a 1.5s timeout (so a font that fails to load entirely doesn't hang the print dialog forever) before calling `window.print()`.

### 4. `.outerHTML`, never `.innerHTML`, for the printable wrapper

```js
// printContent.outerHTML, not .innerHTML: printContent IS the "paper" wrapper div
// itself (bg-white, shadow-lg, p-8/md:p-12, max-w-4xl, print:min-h-[11in],
// print:p-0, etc. all live on this element's own class attribute, not on a
// child). .innerHTML only ever serializes an element's children, never its own
// tag/attributes...
```

`document.getElementById('printable-document-content')` returns the wrapper `<div>` itself, and that div's own `class` attribute carries real layout/paper styling (page width, padding, shadow). `.innerHTML` silently drops the wrapper's own attributes and only serializes its children — the popup would render the *inside* of the document with none of the "paper" styling around it. If you ever need to grab a different element for printing, check whether the styling lives on the element itself or its children before choosing which HTML property to serialize.

### 5. Clone every stylesheet, not a hand-picked subset

```js
// Clone every real <style>/<link rel="stylesheet"> tag from this document's <head>
// into the print window, instead of the small hand-maintained subset of Tailwind
// rules this used to carry (previously ~30 literal class rules covering a small
// fraction of what the JSX actually uses — most colors, rounded corners, shadows,
// grid spans, and every arbitrary-value class like bg-[#0F1E36] were silently
// unstyled in the actual printed output even though they rendered correctly in the
// on-screen preview).
const styleTags = Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))
  .map((el) => el.outerHTML)
  .join('\n');
```

Tailwind generates classes on demand from what's actually used in JSX — a hand-maintained "print stylesheet" will always drift behind the real one as templates evolve. Cloning every `<style>`/`<link>` tag from the live document's `<head>` (both dev's runtime-injected `<style>` tags and production's `<link>` bundle) guarantees the popup has access to the exact same compiled CSS the live page does. **If you ever add a new stylesheet mechanism to this app (a new `<link>`, a CSS-in-JS runtime, etc.), this selector needs to still catch it** — verify a print after any change to how CSS is delivered to the page, not just after template changes.

## `@page` rules — two exist, know which one wins

- `src/index.css` has a general `@media print { @page { margin: 0.5cm; } }` block. Because it's a real `<style>` tag in the live document's `<head>`, it gets cloned into the print popup by the mechanism above.
- `DocumentRenderer.tsx`'s `handlePrint()` writes its *own* `<style>` block into the popup **after** the cloned tags, with a more specific `@page` rule per document type:
  ```
  @page {
    size: ${thermal ? '4in 6in' : 'A4 portrait'};
    margin: ${thermal ? '0.1in' : '0.4in'};
  }
  ```
  Because this block is written later in the popup's `<head>`, it takes precedence for `@page`'s `size`/`margin` in practice — but this relies on source order, not an explicit override mechanism. **If you add a new page size or move where this style block is written, re-verify the margin/size actually applied is the one you expect**, not the `index.css` default silently winning again.

Current page geometry:

| Document class | `@page size` | `@page margin` | Notes |
|---|---|---|---|
| A4 (invoices, quotations, most documents) | `A4 portrait` | `0.4in` | Default. |
| Thermal receipt (`pageSize` includes `4in x 6in`) | `4in 6in` | `0.1in` | Also forces `font-size: 10px !important` on body/table/td/th/p/span/div, `padding: 4px !important` on th/td, caps `.company-logo` at 40px height / 100px width, and `#printable-inner` padding to 4px — a thermal receipt has no room for the normal document's spacing scale. |
| Reports/Expense/Ledger (`getPageSizeClass`) | (uses A4 defaults) | — | Rendered at `w-full min-w-[760px] max-w-4xl`, not driven by a template's `pageSize` field the way invoices/quotations are. |

If you add a new physical size (e.g. a different label/receipt format), add both a `getPageSizeClass()` branch (screen sizing) and a corresponding `@page` branch in `handlePrint()` (print sizing) — they're two separate switches that must stay in sync, since screen width and physical paper size are set independently.

## The phantom-blank-second-page bug

```js
// Handle page sizing styling. No forced min-height at all, screen or print.
// A prior fix scoped the ~11in/6in minimum to print-only (print:min-h-*), reasoning
// a physical page should be full paper height even for a short document — but that
// "11in"/"6in" is the RAW paper height, not the actually-printable area once the
// page's own @page margin is subtracted (A4 here is 11.69in tall with 0.4in top+
// bottom margins = 10.89in usable...). Forcing content to be AT LEAST the raw paper
// height guaranteed it was always slightly taller than the printable area, spilling
// a sliver of empty content onto a near-blank second page on every single print/PDF.
```

**Never add a forced minimum height (screen or print) to the printable wrapper**, even with good intentions ("a short invoice should still fill the page"). Raw paper height (e.g. 11.69in for A4) is not the same as the printable area after `@page` margins are subtracted — forcing content to at least the raw height guarantees it slightly overflows the actual printable area, producing a one-line phantom second page on *every* print. Let content size to itself; the browser's print engine paginates correctly on its own for genuinely long documents (many line items).

## The font-size cascade gotcha

```js
// The <table> itself used to hardcode text-xs unconditionally — since font-size
// (unlike font-weight/font-family) doesn't fall through to a descendant that has
// its own explicit size class, that hardcoded text-xs on <table> silently beat
// this block's own fontSize override for every header/cell inside it...
```

CSS inheritance behaves differently per property in a way that's easy to get wrong when composing Tailwind classes across parent/child elements: `font-weight` and `font-family` inherit and get overridden normally by a child's own class, but a *child's own explicit `font-size` class* does not automatically lose to a differently-computed parent style the way you might expect — a hardcoded `text-xs` sitting directly on an element (like `<table>`) will win over an intended override unless the hardcoded class is made conditional. Pattern used here: only apply the default size class when no explicit override is configured (`block.props?.fontSize ? '' : 'text-xs'`), so the override actually takes effect when set, and the existing default look is unchanged when it's not. Apply this same conditional-default pattern any time you add a new element that both has a sensible hardcoded default *and* needs to support a per-template override.

## Font stack reference

Defined in `src/index.css`'s `@theme` block, loaded via a single Google Fonts `@import` at the top of the file:

| CSS variable | Font | Used for | Why this one |
|---|---|---|---|
| `--font-sans` | Inter | Default body/UI text | Standard, highly legible UI sans. |
| `--font-display` | Space Grotesk | Headings/emphasis | Distinct from body text for hierarchy. |
| `--font-mono` | JetBrains Mono | Numbers, codes, references | Tabular figures, unambiguous digit shapes. |
| `--font-serif` | Lora | "Traditional Serif" template option | A genuine print-legible text serif — chosen specifically so Tailwind's `font-serif` utility doesn't fall back to the browser's Times/Georgia default, which reads as generic rather than deliberate on a printed business document. |
| `--font-arabic` | Cairo | Every RTL (Arabic) document, regardless of the template's chosen Latin font | The only font in this stack with real Arabic glyph coverage — Inter/Space Grotesk/JetBrains Mono/Lora all silently fall back to an OS-installed Arabic font otherwise, which is inconsistent across machines and print drivers. |

`DocumentRenderer.tsx`'s `getGlobalFontClass()` returns `''` for RTL documents specifically so the outer container's `font-arabic` inheritance isn't clobbered by a Latin font class layered on top — see SKILL.md rule 4. The print popup also carries a redundant inline `@import` of Cairo as a "belt-and-braces fallback ... for browsers/print drivers that skip `@import` inside a cloned `<style>` tag" — this is intentional duplication, not a bug to clean up.

## Pre-ship checklist

- [ ] Change verified through the *same* render path used for both preview and print (no parallel mockup).
- [ ] New block/field added to `DEFAULT_DOCUMENT_LAYOUT` in `documentTemplateDefaults.ts` if it should have a sane default — not hardcoded separately in the Canvas Designer or `DocumentRenderer`'s fallback.
- [ ] Print popup actually triggered and inspected (not just the on-screen page) — check `E:\ERP` isn't relying on a stale build; restart the dev server first if this touched server-side template data.
- [ ] Page count checked — no unexpected blank second page.
- [ ] RTL (Arabic/Urdu) variant checked if the document supports it — font, alignment, layout mirroring.
- [ ] Thermal (`4in x 6in`) variant checked separately if relevant — its own font-size/padding/logo overrides only apply at that page size.
- [ ] No new forced min-height added to the printable wrapper.
- [ ] Any new font-size class on a container element is conditional on "no explicit override set," not an unconditional hardcode.
- [ ] If a new stylesheet delivery mechanism was touched, re-verify the print popup's style-cloning still captures it.
- [ ] Colored elements (badges, colored headers, accent boxes) actually show their color in a real print/PDF, not just on screen — `print-color-adjust: exact` must stay present in both `index.css` and the popup's own `<style>` block.
- [ ] If new font weights/families were added, verify a *first* print (cold font cache) still renders in the right font, not a fallback — the `document.fonts.ready` race in `handlePrint()` is what protects this; don't remove it for a "simpler" `window.onload` → `window.print()` call.
- [ ] Every `md:` class inside the printable document has a matching `print:` class — check the on-screen popup AND the actual generated PDF separately; they can legitimately look different (see bug #1) since the popup window (wide) and the printed page (narrower than the `md:` 768px breakpoint) evaluate width-based media queries differently.
