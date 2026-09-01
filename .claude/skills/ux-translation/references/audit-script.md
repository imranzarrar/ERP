# Reusable translation audit script

Run this after wiring `t()` calls into a new/changed page, to find exactly what still needs real Arabic/Urdu content. Adapt the file list and the dynamic-key list each time — don't reuse a stale copy.

## Step 1 — extract literal keys from the changed files

```bash
grep -ohE "\bt\('[^']*'\)|\bt\(\"[^\"]*\"\)" <file1> <file2> ... \
  | sed -E "s/^t\(['\"]//; s/['\"]\)\$//" \
  | sort -u > keys.txt
```

This only catches `t('literal string')` calls. It will **not** catch `t(someVariable)`, and it will also silently mis-extract (or drop) any literal that contains an escaped apostrophe — `t('...branch\'s own...')` stops the regex at the escaped `\'`, not the string's real closing quote. Run a second, targeted pass for exactly that case and add anything it finds to `keys.txt` by hand — see `known-bugs.md` #7, which has bitten this project twice already. A single regex for this is fiddly to get right (a first attempt at one was itself wrong and matched nothing — verify whatever you write against a file you know contains the pattern before trusting it); this two-stage pipeline is simpler and confirmed working:

```bash
grep -n "t('" <file1> <file2> ... | grep -F "\\'"
```

## Step 2 — append dynamic keys by hand

For every `t(someVariable)` call site you added or touched, enumerate the actual possible values and append them to `keys.txt`. Examples from this project:

- Status/enum fields (`t(inv.status)`, `t(q.status)`, `t(exp.paymentStatus)`, ZATCA status codes) → look up the real union type in `src/types.ts` and list every member.
- A shared config array's label field (`t(cat.label)` reading from `CATEGORY_GROUPS`) → list every `label` value in that array.
- Month names via `translateMonthLabel()` → the 12 month words (`January`...`December`), not the composite `"<Month> <year>"` string.

If you can't enumerate the values (truly open-ended — see "fixed vocabulary vs. tenant data" in `SKILL.md`), it shouldn't be going through `t()` at all; fix the code instead of trying to audit it.

## Step 3 — cross-reference against the live database

```js
// check-keys.mjs — run with: npx tsx check-keys.mjs
import { db } from './src/db/index.js';
import * as schema from './src/db/schema.js';
import fs from 'fs';

// Deliberately NOT trimming — see known-bugs.md #6 for why a trimmed comparison
// produces false positives and duplicate rows.
const keys = fs.readFileSync('./keys.txt', 'utf8')
  .split('\n')
  .filter(line => line.replace(/\r$/, '').length > 0)
  .map(line => line.replace(/\r$/, ''));

const rows = await db.select().from(schema.translations);
const byKey = new Map(rows.map(r => [r.key, r]));

const noRowAtAll = [];
const missingArOrUr = [];
for (const key of keys) {
  const row = byKey.get(key);
  if (!row) { noRowAtAll.push(key); continue; }
  if (!row.ar?.trim() || !row.ur?.trim()) missingArOrUr.push(key);
}

console.log('No DB row at all (' + noRowAtAll.length + '):');
noRowAtAll.forEach(k => console.log(JSON.stringify(k)));
console.log('\nRow exists but missing ar or ur (' + missingArOrUr.length + '):');
missingArOrUr.forEach(k => console.log(JSON.stringify(k)));

process.exit(0);
```

## Step 4 — write and apply real content

```js
// apply-translations.mjs — run with: npx tsx apply-translations.mjs
import { db } from './src/db/index.js';
import * as schema from './src/db/schema.js';
import { eq } from 'drizzle-orm';
import { generateId } from './src/id.js';

// Fill in real, professional Arabic + Urdu here — not machine-translated filler.
// Match the tone already in SEED_TRANSLATIONS / the live table (formal business/ERP
// register). en defaults to the key itself unless the existing row says otherwise.
const TRANSLATIONS = {
  "Example Label": { ar: "مثال التسمية", ur: "مثال لیبل" },
};

const rows = await db.select().from(schema.translations);
const byKey = new Map(rows.map(r => [r.key, r]));
let updated = 0, inserted = 0;
for (const [key, { ar, ur }] of Object.entries(TRANSLATIONS)) {
  const existing = byKey.get(key);
  if (existing) {
    // Never overwrite a row that already has real content.
    if (!existing.ar?.trim() || !existing.ur?.trim()) {
      await db.update(schema.translations).set({ ar, ur }).where(eq(schema.translations.id, existing.id));
      updated++;
    }
  } else {
    await db.insert(schema.translations).values({ id: generateId(), key, en: key, ar, ur });
    inserted++;
  }
}
console.log('Updated:', updated, 'Inserted:', inserted);
process.exit(0);
```

Re-run Step 3 afterward — it should report zero missing keys. Then delete both scratch scripts from the repo root (`keys.txt`, `check-keys.mjs`, `apply-translations.mjs`) — they're one-time tools, not part of the codebase, same as any other scratch file this project's workflow produces.

## Live verification (when the Browser pane cooperates)

This project's Browser pane has a recurring `document.hidden` compositing issue that blocks page-transition rendering (see the project's own `BACKLOG.md` items 31/33/44 for history) — check `document.hidden` via the JS tool before trusting a page that looks stuck. When it's working:

1. Create a throwaway super-admin user directly in the DB with `uiLanguage: 'ar'` (mirror the pattern in any `tests/*.test.ts` fixture — real company/user rows, torn down afterward).
2. Log in through the actual app, navigate to the new/changed page.
3. Confirm the text renders in Arabic and layout mirrors correctly (RTL trap check — see `SKILL.md`).
4. Switch to `en` via the language toggle and confirm it reverts correctly.
5. Delete the throwaway user (and its `audit_logs` rows first, FK constraint) when done.
