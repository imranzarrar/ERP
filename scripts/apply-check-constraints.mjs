#!/usr/bin/env node
// drizzle-kit `db:push` creates a CHECK constraint the first time it sees it, but it does NOT notice when the constraint's condition changes later (same
// name, new text): the database keeps the old condition and rejects rows the schema file says are valid (found when 'CashFlow' was added to
// report_definitions_type_check). Same family of gap as the RLS policy predicates (see apply-rls-policies.mjs), solved the same way: schema.ts stays the
// single source of truth; this script reads every declared check() through drizzle's getTableConfig(), compares it with what Postgres actually has, and
// replaces any constraint whose condition differs. Idempotent; a second run changes nothing.
//
// Run after every `db:push` (deploy/release.sh and deploy/release-demo.sh do).
// Usage: npx tsx scripts/apply-check-constraints.mjs [--dry-run]
import dotenv from 'dotenv';
dotenv.config({ path: 'app.secrets', quiet: true });
import pg from 'pg';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import * as schema from '../src/db/schema.js';

const DRY = process.argv.includes('--dry-run');
const dialect = new PgDialect();
const pool = new pg.Pool({ host: process.env.SQL_HOST, user: process.env.SQL_USER, password: process.env.SQL_PASSWORD, database: process.env.SQL_DB_NAME });

const normal = (def) => String(def || '').replace(/\s+NOT VALID\s*$/i, '').replace(/\s+/g, ' ').trim();

async function main() {
  let unchanged = 0, created = 0, replaced = 0;
  const failures = [];
  for (const table of Object.values(schema)) {
    let config;
    try { config = getTableConfig(table); } catch { continue; }
    for (const check of config.checks || []) {
      const { sql: cond, params } = dialect.sqlToQuery(check.value);
      if (params.length) { failures.push(`${config.name}.${check.name}: the condition has bind parameters`); continue; }
      const qTable = `"${config.schema || 'public'}"."${config.name}"`;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2`, [qTable, check.name]);
        if (!existing.rows.length) {
          if (!DRY) await client.query(`ALTER TABLE ${qTable} ADD CONSTRAINT "${check.name}" CHECK (${cond})`);
          created++; console.log(`  + ${config.name}.${check.name} (was missing)`);
        } else {
          // let Postgres normalise the declared condition: add it under a temporary name without scanning rows, read it back, drop it
          const tmp = `${check.name}__cmp`.slice(0, 63);
          await client.query(`ALTER TABLE ${qTable} ADD CONSTRAINT "${tmp}" CHECK (${cond}) NOT VALID`);
          const declared = await client.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2`, [qTable, tmp]);
          await client.query(`ALTER TABLE ${qTable} DROP CONSTRAINT "${tmp}"`);
          if (normal(declared.rows[0].d) === normal(existing.rows[0].d)) unchanged++;
          else {
            console.log(`  ~ ${config.name}.${check.name}\n      database: ${normal(existing.rows[0].d)}\n      schema:   ${normal(declared.rows[0].d)}`);
            if (!DRY) {
              await client.query(`ALTER TABLE ${qTable} DROP CONSTRAINT "${check.name}"`);
              await client.query(`ALTER TABLE ${qTable} ADD CONSTRAINT "${check.name}" CHECK (${cond})`);
            }
            replaced++;
          }
        }
        await client.query(DRY ? 'ROLLBACK' : 'COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        failures.push(`${config.name}.${check.name}: ${e.message}`);
      } finally { client.release(); }
    }
  }
  console.log(`${DRY ? 'DRY RUN: ' : ''}check constraints: ${unchanged} up to date, ${replaced} replaced, ${created} created.`);
  if (failures.length) { console.error('FAILURES:\n  ' + failures.join('\n  ')); process.exitCode = 1; }
  await pool.end();
}
main().catch((e) => { console.error('apply-check-constraints.mjs failed:', e); process.exit(1); });
