// One-off: upsert translations-export.json into whatever DB this process's app.secrets
// points at. Run this ON THE TARGET (e.g. the VPS, using its own app.secrets) — never runs
// against a DB other than the one its local app.secrets/env names.
//
// `translations` has no unique constraint on `key` (only on `id`), so this can't use a
// plain ON CONFLICT upsert — it looks up each row by `key` first: missing keys are
// inserted fresh; existing keys only get their blank ar/ur columns filled in, matching the
// established convention (see .claude/skills/ux-translation/SKILL.md) of never overwriting
// a row that already has real content.
import dotenv from 'dotenv';
dotenv.config({ path: 'app.secrets' });
import pg from 'pg';
import fs from 'fs';
import crypto from 'crypto';

const pool = new pg.Pool({
  host: process.env.SQL_HOST,
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  database: process.env.SQL_DB_NAME,
});

function uuid() {
  return crypto.randomUUID();
}

async function main() {
  // Explicit 'utf8' rather than relying on implicit Buffer coercion — this file is full of
  // Arabic/Urdu multi-byte text, and node-postgres itself only ever speaks UTF-8 on the
  // wire (matches src/db/index.ts's own Pool, which sets no client_encoding override
  // either — every Postgres DB this app talks to is UTF8, same as this file).
  const rows = JSON.parse(fs.readFileSync(new URL('./translations-export.json', import.meta.url), 'utf8'));
  let inserted = 0, filled = 0, skipped = 0;

  for (const row of rows) {
    const existing = await pool.query('SELECT id, ar, ur FROM translations WHERE key = $1', [row.key]);
    if (existing.rows.length === 0) {
      await pool.query('INSERT INTO translations (id, key, en, ar, ur) VALUES ($1, $2, $3, $4, $5)', [uuid(), row.key, row.en, row.ar, row.ur]);
      inserted++;
    } else {
      const cur = existing.rows[0];
      const newAr = (!cur.ar || !cur.ar.trim()) && row.ar ? row.ar : cur.ar;
      const newUr = (!cur.ur || !cur.ur.trim()) && row.ur ? row.ur : cur.ur;
      if (newAr !== cur.ar || newUr !== cur.ur) {
        await pool.query('UPDATE translations SET ar = $1, ur = $2 WHERE id = $3', [newAr, newUr, cur.id]);
        filled++;
      } else {
        skipped++;
      }
    }
  }

  console.log(`Done. Inserted ${inserted} new keys, filled blanks on ${filled} existing keys, left ${skipped} unchanged.`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
