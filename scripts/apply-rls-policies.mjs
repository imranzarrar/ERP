#!/usr/bin/env node
// Works around a confirmed drizzle-kit 0.31.10 bug: `db:push` creates each pgPolicy()
// declared in src/db/schema.ts but silently drops its `using`/`withCheck` predicate from
// the generated DDL (verified directly via `SELECT pg_get_expr(polqual, polrelid) FROM
// pg_policy` showing NULL after a push — see src/db/schema.ts's TENANT_DB_ROLE comment).
//
// Rather than hand-maintaining a duplicate list of every policy's real predicate (which
// would drift out of sync with schema.ts the moment someone edits a policy there and
// forgets this file), this script introspects schema.ts's OWN table definitions at
// runtime via drizzle-orm's getTableConfig() — which exposes each table's declared
// PgPolicy objects, including their real `using`/`withCheck` SQL objects — converts each
// to raw SQL text via PgDialect.sqlToQuery(), and applies it directly via
// `ALTER POLICY ... USING (...) WITH CHECK (...)`. schema.ts stays the single real source
// of truth; this script just makes sure Postgres actually has what it declares.
//
// Run this after every `db:push` that touches a table with an RLS policy (which, per
// .claude/skills/rls-tenant-isolation/SKILL.md, is now every table in the schema).
//
// Usage: npx tsx scripts/apply-rls-policies.mjs
// (must run through tsx, not plain node — it imports src/db/schema.ts, which plain
// node's ESM resolver can't load without a .ts->.js transpilation step.)
import dotenv from 'dotenv';
dotenv.config({ path: 'app.secrets', quiet: true });
import pg from 'pg';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import * as schema from '../src/db/schema.js';

const { Pool } = pg;
const dialect = new PgDialect();

const pool = new Pool({
  host: process.env.SQL_HOST,
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  database: process.env.SQL_DB_NAME,
});

function toSql(sqlObj) {
  if (!sqlObj) return null;
  const { sql, params } = dialect.sqlToQuery(sqlObj);
  if (params.length > 0) {
    throw new Error(`Policy predicate resolved with non-empty params (${JSON.stringify(params)}) — every RLS predicate in this app is expected to be fully inlined (column refs + literal casts only, no bind params). Refusing to apply, since a parameterized ALTER POLICY isn't supported.`);
  }
  return sql;
}

async function main() {
  // Iterate every export and let getTableConfig's own try/catch below sort tables from
  // non-tables (TENANT_DB_ROLE the string constant, any relations() exports, etc.) —
  // simpler and more robust than guessing at drizzle-orm's internal table-detection API.
  const tables = Object.values(schema);
  let applied = 0;
  let skipped = 0;
  const failures = [];

  for (const table of tables) {
    let config;
    try {
      config = getTableConfig(table);
    } catch {
      continue; // not a pgTable (e.g. a relations() export)
    }
    if (!config.policies || config.policies.length === 0) {
      skipped++;
      continue;
    }
    for (const policy of config.policies) {
      const usingSql = toSql(policy.using);
      const withCheckSql = toSql(policy.withCheck);
      if (usingSql === null && withCheckSql === null) continue; // policy declared with no predicate at all — nothing to apply
      const parts = [`ALTER POLICY "${policy.name}" ON "${config.name}"`];
      if (usingSql !== null) parts.push(`USING (${usingSql})`);
      if (withCheckSql !== null) parts.push(`WITH CHECK (${withCheckSql})`);
      const statement = parts.join(' ') + ';';
      try {
        await pool.query(statement);
        applied++;
      } catch (err) {
        failures.push({ table: config.name, policy: policy.name, statement, error: err.message });
      }
    }
  }

  console.log(`Applied ${applied} policy predicate(s), ${skipped} table(s) had no policy.`);
  if (failures.length > 0) {
    console.error(`${failures.length} FAILURE(S):`);
    for (const f of failures) {
      console.error(`  - ${f.table}.${f.policy}: ${f.error}\n    statement: ${f.statement}`);
    }
  }

  // Verification pass: confirm every applied policy's predicate is actually non-null in
  // the live database — don't trust the ALTER POLICY statement succeeding silently.
  const verifyResult = await pool.query(`
    SELECT schemaname, tablename, policyname,
           pg_get_expr(polqual, polrelid) AS using_expr,
           pg_get_expr(polwithcheck, polrelid) AS withcheck_expr
    FROM pg_policies
    JOIN pg_policy ON pg_policy.polname = pg_policies.policyname
    JOIN pg_class ON pg_class.oid = pg_policy.polrelid AND pg_class.relname = pg_policies.tablename
    WHERE schemaname = 'public'
    ORDER BY tablename;
  `);
  let verifiedOk = 0;
  const verifyFailures = [];
  for (const row of verifyResult.rows) {
    // "using true" policies (translations, roleTemplates, companyOnboardingRequests,
    // deletedCompanyLog) legitimately have a real, non-null predicate that's just the
    // literal `true` — still counts as verified, not a NULL/dropped predicate.
    if (row.using_expr === null && row.withcheck_expr === null) {
      verifyFailures.push(row);
    } else {
      verifiedOk++;
    }
  }
  console.log(`Verified ${verifiedOk} polic(ies) have a real (non-null) predicate in the database.`);
  if (verifyFailures.length > 0) {
    console.error(`${verifyFailures.length} POLICY/POLICIES STILL HAVE NULL PREDICATES (drizzle-kit's bug, not yet fixed for these):`);
    for (const f of verifyFailures) {
      console.error(`  - ${f.tablename}.${f.policyname}`);
    }
  }

  await pool.end();
  if (failures.length > 0 || verifyFailures.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('apply-rls-policies.mjs failed:', err);
  process.exit(1);
});
