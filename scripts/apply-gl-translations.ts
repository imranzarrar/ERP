// Puts the General Ledger screens' Arabic / Urdu text into the shared translations table: inserts keys that are missing and fills a blank ar / ur,
// and never overwrites a translation someone already wrote or edited. Safe to re-run. Usage: npx tsx scripts/apply-gl-translations.ts [--apply]
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { GL_TRANSLATION_ITEMS } from '../src/glTranslations.js';

const APPLY = process.argv.includes('--apply');
const rows = await db.select().from(schema.translations);
const byKey = new Map(rows.map(r => [r.key, r]));
let inserted = 0, filled = 0, untouched = 0;
for (const item of GL_TRANSLATION_ITEMS) {
  const ex = byKey.get(item.key);
  if (!ex) { inserted++; if (APPLY) await db.insert(schema.translations).values(item); continue; }
  const patch: any = {};
  if (!ex.ar) patch.ar = item.ar;
  if (!ex.ur) patch.ur = item.ur;
  if (Object.keys(patch).length) { filled++; if (APPLY) await db.update(schema.translations).set(patch).where(eq(schema.translations.id, ex.id)); } else untouched++;
}
console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'}: ${GL_TRANSLATION_ITEMS.length} keys | insert ${inserted} | fill blanks ${filled} | already translated ${untouched}`);
process.exit(0);
