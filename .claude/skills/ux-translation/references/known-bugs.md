# Known translation bugs found in this project (and what they teach)

Full detail lives in `BACKLOG.md` items 46-49. Summarized here as the specific failure patterns to watch for — each one recurred at least once even after being "fixed" in an earlier pass, because the fix targeted the symptom in one file rather than the pattern everywhere.

## 1. Page headings falling back to the raw route id

`App.tsx`'s page-heading logic was a long ternary keyed on `activeTab`, with `t(activeTab)` as the catch-all default for anything not explicitly listed. Only 11 of 33 real tab ids were listed — the other 22 fell through to `t(activeTab)`, which means the raw internal route id (`"pos-terminal"`, `"settings"`, `"customers-add"`) got treated as display text. No language ever showed a real heading for those pages; a CSS `capitalize` class just made `pos-terminal` render as `Pos-Terminal`, which looked like a translation gap but was actually a routing/wiring bug — adding an Arabic translation for the literal string `"pos-terminal"` would have been exactly the wrong fix.

**Lesson**: before adding a translation for something that looks like "just missing content," check whether the underlying key is even a real, intentional piece of vocabulary. A key that looks like an internal identifier (kebab-case, matches a route/tab id, matches a database enum's raw value) is a code bug, not a content gap.

## 2. Dynamic/composite strings fed straight into `t()`

`t(openMonth.name)` where `openMonth.name` is composed as `"<Month> <Year>"` (e.g. `"August 2026"`) registered a brand-new "missing" key every single month, forever — a composite value with no fixed vocabulary can never have a stable translation. Fixed by `translateMonthLabel()` (`src/hooks.ts`), which translates only the month word and reassembles with the untouched year.

The same category of bug reappeared independently in `PosModule.tsx`: `t(p.category)` and a category-filter pill list ran **arbitrary per-company category names** (data a specific tenant typed into "New Category") through the global translator. This doesn't just fail to translate — it pollutes the shared `translations` table with tenant-specific junk that can never sensibly be pre-translated by anyone.

**Lesson**: before wrapping a value in `t()`, ask "is this a string I could enumerate in advance?" If the answer depends on what a specific company/user typed into a form, the answer is no — render it as-is.

## 3. Files with the hook imported and used, but whole forms untranslated

Every one of `MasterEntities.tsx`, `QuotationModule.tsx`, `InvoiceModule.tsx`, `ExpenseModule.tsx` already called `useTranslation()` and used `t()` correctly *somewhere* (usually a status pill or a page title) — which made it easy to assume the file was "already translated" from a quick grep for `useTranslation`. In every case, an entire adjacent form (Add Customer, Add Product, the Convert-to-Invoice modal, the Record Payment modal, the Create Credit/Debit Note modal, whole list-view tables) sat right next to that working code, 100% hardcoded English.

**Lesson**: "this file imports `useTranslation`" is not evidence the file is translated. Audit the actual `t()` call sites (see `audit-script.md`), not the import list.

## 4. `t(cat.label)` — dynamic keys invisible to a plain-text grep audit

`AdminSettings.tsx`'s Sleek Hub layout correctly called `t(cat.label)`/`t(st.label)` for its category/tab labels, reading from a shared `CATEGORY_GROUPS` config array. This looked complete under a `grep "t('"` audit (which only finds string literals) — but every one of those 18 label keys had a DB row with real English and **blank** Arabic/Urdu. The wiring was right; the content was never filled in, and nothing surfaced that gap until the underlying key list was explicitly enumerated and checked against the database.

**Lesson**: a translation audit that only scans for `t('literal')` calls will systematically miss `t(variable)` calls. Enumerate the actual possible values of any dynamic key by hand (walk the config array, list the DB enum's values) and add them to the audit list explicitly.

## 5. A loop variable named `t` shadowing the translator

`RecurringExpenses.tsx` had two `.map(t => ...)` callbacks where `t` was a template/item object, not the translate function, in a file that also had `const { t } = useTranslation(db)` in outer scope. Adding `t(posting.status)` inside that callback compiled fine syntactically but resolved to the wrong `t` — TypeScript caught it (`TS2349: This expression is not callable`) because the shadowing variable had an incompatible type, but a looser type or a JS-only codebase would have failed silently or crashed at runtime.

**Lesson**: before adding a `t()` call inside any `.map()`/callback, confirm the loop parameter isn't also named `t`. If it is, rename the loop parameter (not the translator) — grep the file for `.map(t =>` first.

## 6. A duplicate row from an audit script that `.trim()`'d keys

A one-off Node script used to cross-reference "keys the code calls" against "keys the database has" applied `.trim()` to every key before comparing. One real key in the app, `t('Welcome back, ')` (`Dashboard.tsx` — trailing space is intentional, the username is concatenated immediately after with no separator), got trimmed to `'Welcome back,'` during the audit, didn't match the real (untrimmed) database row, got reported as "missing," and a second, bogus, never-looked-up duplicate row got created and inserted.

**Lesson**: never `.trim()` a translation key when comparing against the database. If an audit script reports a key "missing" that you're confident already has a translation, check for a whitespace/punctuation mismatch before writing new content for it.

## 7. An escaped apostrophe inside a single-quoted key breaks the grep-based audit

The audit script's extraction regex (`audit-script.md` step 1) is `t\('[^']*'\)` — it matches up to the *first* unescaped `'`. A call like `t('...branch\'s own address...')` or `t('...we\'ll send...')` has an escaped `\'` inside the string, which the regex doesn't know to skip: it stops early, so the match either fails silently or captures a truncated/wrong substring. The key never makes it into `keys.txt`, so it's never checked against the database — it just silently renders in English forever, with the audit script reporting a clean "zero missing" result right next to it. This bit `LoginScreen.tsx`'s `we\'ll` string in one pass, then bit two more strings (`branch\'s`, `PR\'s`) in the very next pass, because the first fix didn't change the audit method, only patched the one string found by other means.

**Lesson**: after running the standard extraction regex, run a second, targeted pass specifically for this blind spot: `grep -oE "t\('[^']*\\\\'[^']*'\)"` (or the equivalent for double-quoted calls) across every changed file, and add anything it finds to the key list by hand. Do this as a standing second step, not just when a translation is reported missing — the standard audit will never catch it on its own, no matter how many times it's re-run.

## 8. The in-app "Auto-Translate" button is not a safety net

`AdminSettings.tsx`'s `handleAutoTranslate` calls `POST /api/translate-all` (`server.ts`), which checks `SEED_TRANSLATIONS` offline first, then falls back to the Gemini API (`gemini-3.6-flash`) for anything still missing — but only if `GEMINI_API_KEY` is set in the environment. It is not set in this project's `.env`. Clicking the button does nothing for genuinely new keys and gives no clear signal about why. Don't point a user at this button as "the fix" for a missing-translation report, and don't assume a key will eventually get filled in by it — write the content directly.
