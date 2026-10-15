#!/usr/bin/env node
// Unique keys that existing, populated tables gain because a new table references them with a composite (id, company_id) foreign key. drizzle-kit would
// otherwise stop and ask whether to TRUNCATE the populated table to add the key (never answer yes), so they are created here first, idempotently, before
// `db:push` (both release scripts run this). Add a line to KEYS for every such key.
// Usage: npx tsx scripts/pre-push-keys.mjs
import dotenv from 'dotenv';
dotenv.config({ path: 'app.secrets', quiet: true });
import pg from 'pg';

const KEYS = [
  ['branches', 'branches_id_company_unique', 'company_id, id'],
  ['customers', 'customers_id_company_unique', 'company_id, id'],
  ['vendors', 'vendors_id_company_unique', 'company_id, id'],
  ['vouchers', 'vouchers_id_company_unique', 'company_id, id'],
];

const pool = new pg.Pool({ host: process.env.SQL_HOST, user: process.env.SQL_USER, password: process.env.SQL_PASSWORD, database: process.env.SQL_DB_NAME });
let made = 0;
for (const [table, name, cols] of KEYS) {
  const t = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, [table]);
  if (!t.rowCount) { console.log(`  - ${table}: table does not exist yet, skipped`); continue; }
  const have = await pool.query(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [name]);
  if (have.rowCount) continue;
  await pool.query(`ALTER TABLE "${table}" ADD CONSTRAINT "${name}" UNIQUE (${cols})`);
  console.log(`  + ${name} on ${table}`); made++;
}
console.log(`unique keys: ${made} created, ${KEYS.length - made} already there or absent.`);
await pool.end();
