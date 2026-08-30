---
name: ux-translation
description: Use this skill whenever adding, editing, or reviewing ANY user-facing page, form, modal, table, report, dashboard, or menu in this ERP — new fields on an existing form count too. Trigger proactively even if the user's request doesn't mention translation, language, Arabic, Urdu, or RTL at all (e.g. "add a discount field to the quotation form," "build a new warehouse transfer screen," "add a column to the customer table") — every new piece of UI text in this app must be wired for translation as part of building it, not as a follow-up pass. Also trigger when the user reports a page/form/menu "doesn't translate," "isn't RTL," or "shows English" in Arabic/Urdu mode, or asks you to audit translation coverage.
---

# UX Translation (this ERP)

This app is multi-language (English/Arabic/Urdu) by design, not by afterthought — every screen is expected to fully translate and correctly mirror to RTL. In practice this has repeatedly *not* held: a multi-session audit found entire forms, list tables, and even a whole sidebar layout sitting at 0% translation coverage despite the surrounding file already importing and correctly using the translation hook elsewhere. Read this before writing any new UI, and re-read it when told a page "doesn't translate" — that complaint has never once turned out to be a translation-content problem alone; it has always been a wiring gap, a data-modeling mistake, or both. See `references/known-bugs.md` for the specific incidents this skill was built from.

## The architecture (extend it, don't reinvent it)

- `src/hooks.ts`'s `useTranslation(db)` returns `{ t, lang, isRTL }`. `t(key)` checks `db.translations` (Postgres-backed, editable via Admin Settings → Translations) first, then the client-bundled `SEED_TRANSLATIONS` fallback in `src/dbStore.ts`. If a key matches neither, it silently returns the raw key as display text and fires `POST /api/register-missing-key` to auto-register an English-only row for someone to fill in later — **never rely on this auto-registration path to actually get a key translated**; it creates a permanent gap unless someone deliberately follows up, which is exactly how this app ended up with hundreds of stale English-only rows.
- `isRTL` (`ar`/`ur` → true) drives `dir={isRTL ? "rtl" : "ltr"}` on one root wrapper in `App.tsx`. Every other component inherits this via normal DOM nesting — there is no per-component `dir` to set. **Do not add a new `dir` attribute anywhere else in the tree.** If a new piece of UI looks LTR under Arabic, it is almost never a `dir` bug; see "The RTL trap" below.
- `<html lang>` is kept in sync separately via a `useEffect` in `App.tsx` (it doesn't follow from the wrapper `dir` — `<html>` lives in `index.html`, outside React). You should never need to touch this unless you're changing how language state itself is stored.

## Two things every string needs a decision on

**1. Is it fixed app vocabulary, or arbitrary data a tenant typed in?**

Only fixed vocabulary goes through `t()`. Examples of fixed vocabulary: field labels, button text, column headers, static help text, placeholder text, status/enum values stored in the DB (`"Active"`, `"Paid"`, `"Draft"`, ZATCA status codes, etc.).

Examples of things that must **never** be passed to `t()`: a customer/vendor/product name, a category name a company typed in, a fiscal month's composed name (`"August 2026"`), any other string a user or a specific tenant authored. Passing tenant data into `t()` silently pollutes the shared, global `translations` table with one-off junk that can never have a real translation (there's no fixed set of possible values), and it never actually translates the thing anyway — it just costs you a wasted API call and a garbage DB row every time. If the underlying value is genuinely composite (e.g. a month name = month word + year), translate only the fixed part and reassemble — see `translateMonthLabel()` in `src/hooks.ts` for the established pattern.

**2. Is the string dynamic (`t(someVariable)`) or literal (`t('Some Label')`)?**

Prefer literal keys wherever the text is knowable at write time. A dynamic call like `t(cat.label)` is invisible to a plain-text audit (`grep`/static scan) that only looks for `t('...')` calls — this is exactly how a whole layer of missing translations went undetected for multiple review passes in this project (Admin Settings' category/tab labels were being translated via `t(cat.label)` the entire time, correctly wired, but the underlying dictionary rows were never filled in, and no one noticed because grepping for `t('...')` string literals doesn't find `t(cat.label)`). If you must use a dynamic key (rendering the same JSX for N known variants, e.g. a config array), explicitly extract the resolved key set for translation instead of trusting a literal-string audit to find it — see the workflow below.

## The RTL trap

**English text inside a correctly-`dir="rtl"` container still visually reads left-to-right** — that's just Unicode bidi behavior for Latin script, not a bug. A form that's 100% untranslated will always *look* like RTL "isn't working" even when the container's direction is completely correct. Every "direction isn't RTL" report investigated in this project turned out to be this, not an actual broken `dir` attribute. So: **diagnose translation coverage first.** Only look for an actual RTL bug (wrong `dir`, a portal escaping the wrapper, hardcoded physical-direction classes) if translation is already complete and it still looks wrong.

When it's genuinely a layout issue: use Tailwind's logical properties (`ms-`/`me-`/`ps-`/`pe-`/`text-start`/`text-end`) instead of physical ones (`ml-`/`mr-`/`pl-`/`pr-`/`text-left`/`text-right`) for anything that should mirror under RTL — icons that imply directionality (arrows, chevrons), asymmetric spacing, floated elements. This codebase already does this correctly almost everywhere; a stray physical-direction class is the exception, not the norm, so grep for `text-left\|text-right\|ml-\|mr-\|pl-\|pr-` in any file you touch and fix what you find.

## Workflow for adding or reviewing a page/form/report

1. **Write every string through `t('...')` as you build**, not as a follow-up pass. Labels, placeholders, button text, empty-state text, validation/alert messages, column headers, tooltip/title attributes — all of it. Decide fixed-vocabulary-vs-tenant-data (above) as you go; don't wrap tenant data.
2. **Watch for variable-name collisions with `t`.** Multiple `.map(t => ...)` callbacks in this codebase name their loop variable `t` (tax slabs, template rows, translation rows themselves in the Admin Settings editor) — calling the real `t()` translator inside one of those scopes either silently resolves to the wrong `t` or fails to compile (`tsc` catches this: `TS2349: This expression is not callable`). If you need to translate something inside such a scope, rename the loop variable first (e.g. `tmpl`), don't work around it.
3. **After writing the code, audit what you actually call** — don't trust memory of what you wrapped. Run:
   ```bash
   grep -ohE "\bt\('[^']*'\)|\bt\(\"[^\"]*\"\)" <changed files> | sed -E "s/^t\(['\"]//; s/['\"]\)\$//" | sort -u
   ```
   then add any dynamic keys you used (`t(someVar)`) to that list by hand — enumerate the actual runtime values (e.g. every status string a field can hold, every label in a config array like `CATEGORY_GROUPS`).
4. **Cross-reference the resulting key list against the live `translations` table** (see `references/audit-script.md` for the exact reusable Node script) — find keys with no row at all, and keys with a row but blank `ar`/`ur`.
5. **Write real translations yourself.** Do not depend on the in-app "Auto-Translate" button (`AdminSettings.tsx`'s `handleAutoTranslate` → `POST /api/translate-all`) — it calls the Gemini API and silently does nothing useful for missing keys when `GEMINI_API_KEY` isn't configured (it currently is not, in this environment), and depending on an external paid API for core UI translation is the wrong foundation regardless. Write professional, natural business/ERP-register Arabic and Urdu directly — matching the tone already established in `SEED_TRANSLATIONS` and the live `translations` table (formal, e.g. "ترحيل" for "Post" in an accounting sense, not a literal/machine-translated word-for-word rendering). Apply them with the same upsert script pattern (insert new rows, update blank `ar`/`ur` on existing rows, never touch a row that already has content).
6. **Don't create duplicate/near-duplicate keys.** Before treating a key as "missing," check whether an existing key differs only by trailing/leading whitespace or punctuation — at least one real key in this app has load-bearing trailing whitespace (`'Welcome back, '` — the username is interpolated immediately after with no separator). An audit script that blindly `.trim()`s keys before comparing will misreport a real, already-translated key as missing and create a bogus duplicate row if you then "fix" it. Compare keys byte-for-byte.
7. **Verify**: `npm run lint` (`tsc --noEmit`) must be clean. Re-run the audit script from step 4 — it should report zero missing keys for everything your changed files actually reference. If the Browser pane is available and not stuck (see the project's recurring `document.hidden` compositing issue — check `document.hidden` before trusting a blocked-looking page), log in as a temporary throwaway user with `uiLanguage: 'ar'` and visually confirm the new page, deleting the user afterward.
8. **Clean up scratch files** (audit scripts, translation-content scripts) from the repo root when done — they're one-time tools, not part of the codebase.

## Scope note

This skill covers *making UI text translatable and actually translated*, plus the RTL-diagnosis guidance above. It does not cover the print/PDF document pipeline's own bilingual handling (Arabic labels alongside English on invoices/receipts, the Canvas Designer's per-block `isBilingual` toggle) — that's a related but architecturally separate system covered by the `print-ready-documents` skill.
