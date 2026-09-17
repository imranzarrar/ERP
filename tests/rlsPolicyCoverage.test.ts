import { describe, it, expect } from 'vitest';
import dotenv from 'dotenv';
dotenv.config({ path: 'app.secrets', quiet: true });
import pg from 'pg';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import * as schema from '../src/db/schema.js';

// Regression test for the full RLS rollout (BACKLOG.md, RLS full-rollout entry) and the
// confirmed drizzle-kit 0.31.10 bug that silently drops a pgPolicy()'s USING/WITH CHECK
// predicate from db:push's generated DDL. This test is the automated version of the
// manual `SELECT pg_get_expr(polqual, polrelid) FROM pg_policy` check that first caught
// that bug on `customers` — it would fail immediately if a future `db:push` reintroduced
// the drop and nobody happened to re-run `scripts/apply-rls-policies.mjs` afterward.
//
// It introspects src/db/schema.ts itself (the same technique apply-rls-policies.mjs
// uses) rather than a hardcoded table list, so a newly-added table with its own policy is
// automatically covered without editing this file.
const dialect = new PgDialect();

function toSql(sqlObj: any): string | null {
  if (!sqlObj) return null;
  return dialect.sqlToQuery(sqlObj).sql;
}

describe('RLS policy coverage — every table\'s declared policy is actually live in Postgres', () => {
  it('every pgTable in schema.ts has RLS enabled and its policy predicate matches what schema.ts declares', async () => {
    const { Pool } = pg;
    const pool = new Pool({
      host: process.env.SQL_HOST, user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD, database: process.env.SQL_DB_NAME,
    });

    const declaredTables: { name: string; policies: { name: string; using: string | null; withCheck: string | null }[] }[] = [];
    for (const value of Object.values(schema)) {
      let config: ReturnType<typeof getTableConfig>;
      try {
        config = getTableConfig(value as any);
      } catch {
        continue; // not a pgTable export (e.g. TENANT_DB_ROLE, a relations() export)
      }
      if (!config.policies || config.policies.length === 0) continue;
      declaredTables.push({
        name: config.name,
        policies: config.policies.map((p) => ({ name: p.name, using: toSql(p.using), withCheck: toSql(p.withCheck) })),
      });
    }

    // Sanity: every table this session added RLS to should have been picked up by the
    // introspection above — if this is ever much smaller than expected, the loop above is
    // silently skipping real tables (a getTableConfig API change, a schema.ts export
    // shape change) rather than the rollout actually shrinking.
    expect(declaredTables.length).toBeGreaterThanOrEqual(60);

    const relRes = await pool.query(`
      SELECT relname, relrowsecurity FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r';
    `);
    const rlsByTable = new Map(relRes.rows.map((r: any) => [r.relname, r.relrowsecurity]));

    const policyRes = await pool.query(`
      SELECT polname, pg_get_expr(polqual, polrelid) AS using_expr, pg_get_expr(polwithcheck, polrelid) AS withcheck_expr
      FROM pg_policy;
    `);
    const liveByPolicyName = new Map(policyRes.rows.map((r: any) => [r.polname, r]));

    const failures: string[] = [];
    for (const table of declaredTables) {
      if (rlsByTable.get(table.name) !== true) {
        failures.push(`${table.name}: RLS is not enabled (relrowsecurity is not true)`);
        continue;
      }
      for (const policy of table.policies) {
        const live = liveByPolicyName.get(policy.name);
        if (!live) {
          failures.push(`${table.name}.${policy.name}: declared in schema.ts but no such policy exists in the database at all`);
          continue;
        }
        if (policy.using !== null && !live.using_expr) {
          failures.push(`${table.name}.${policy.name}: schema.ts declares a USING predicate but the database's is NULL (the drizzle-kit db:push bug — run: npx tsx scripts/apply-rls-policies.mjs)`);
        }
        if (policy.withCheck !== null && !live.withcheck_expr) {
          failures.push(`${table.name}.${policy.name}: schema.ts declares a WITH CHECK predicate but the database's is NULL (the drizzle-kit db:push bug — run: npx tsx scripts/apply-rls-policies.mjs)`);
        }
      }
    }

    await pool.end();
    expect(failures, failures.join('\n')).toEqual([]);
  });
});
