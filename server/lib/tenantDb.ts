// Opt-in, RLS-enforced data-access path — coexists with the app's default `db` export
// (src/db/index.ts, a Postgres superuser connection used by every existing route,
// completely unaffected by anything here). See src/db/schema.ts's TENANT_DB_ROLE comment
// for why a genuinely separate, non-superuser role is required for RLS to have any effect
// at all, and .claude/skills/data-isolation-guard for the app-level checks this supplements
// (never replaces — a route using tenantDb still needs its own req.targetCompanyId checks).
//
// Per-request flow: withTenantDb() checks out one client from a dedicated pool (connected
// as the restricted erp_app_tenant role), opens a transaction, and scopes it to the
// request's company via `SELECT set_config('app.company_id', $1, true)` — the `true`
// (is_local) makes this session-local-to-the-transaction, equivalent to SET LOCAL but
// safely parameterized. That setting is invisible to any other connection, and is reset
// automatically at COMMIT/ROLLBACK before the client returns to the pool — so a pooled
// connection can never leak one request's company scope into the next request that
// happens to reuse it. The bound client is stored in AsyncLocalStorage for the lifetime
// of the request; tenantDb() reads it back out. A route that calls tenantDb() without
// having gone through withTenantDb() first throws immediately, by design — silently
// falling back to an unscoped connection would defeat the entire point.
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../src/db/schema.js';

const { Pool } = pg;

const POOL_MAX = Number(process.env.TENANT_DB_POOL_MAX) || 10;
const STATEMENT_TIMEOUT_MS = Number(process.env.DB_STATEMENT_TIMEOUT_MS) || 15000;

const tenantPool = new Pool({
  host: process.env.SQL_HOST,
  user: process.env.TENANT_DB_USER,
  password: process.env.TENANT_DB_PASSWORD,
  database: process.env.SQL_DB_NAME,
  connectionTimeoutMillis: 15000,
  max: POOL_MAX,
  statement_timeout: STATEMENT_TIMEOUT_MS,
  options: '-c timezone=UTC',
});

tenantPool.on('error', (err) => {
  console.error('Unexpected error on idle tenant SQL pool client:', err);
});

type TenantContext = {
  db: NodePgDatabase<typeof schema>;
};

const tenantContextStorage = new AsyncLocalStorage<TenantContext>();

// Express middleware — apply per-route (or per-router), never globally: only a route
// that's actually been migrated to query via tenantDb() should pay for a dedicated
// transactional connection. Every other route is unaffected.
export async function withTenantDb(req: any, res: any, next: any) {
  if (!req.targetCompanyId) {
    return res.status(400).json({ error: 'No active company for this request' });
  }

  const client = await tenantPool.connect();
  let settled = false;
  const finalize = async (commit: boolean) => {
    if (settled) return;
    settled = true;
    try {
      await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    } catch (err) {
      console.error('tenantDb: failed to finalize transaction', err);
    } finally {
      client.release();
    }
  };

  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.company_id', $1, true)", [req.targetCompanyId]);
  } catch (err) {
    await finalize(false);
    return next(err);
  }

  res.on('finish', () => {
    void finalize(res.statusCode >= 200 && res.statusCode < 400);
  });
  res.on('close', () => {
    // 'close' fires even on a perfectly normal completion — sometimes racing ahead of
    // 'finish' on a fast loopback connection (confirmed happening in practice: a
    // successful 200 response got its transaction silently rolled back because this
    // handler used to fire unconditionally). Only treat it as a genuine abort when the
    // response was never actually completed.
    if (!res.writableEnded) {
      void finalize(false);
    }
  });

  const tenantDrizzle = drizzle(client, { schema });
  tenantContextStorage.run({ db: tenantDrizzle }, () => next());
}

export function tenantDb(): NodePgDatabase<typeof schema> {
  const ctx = tenantContextStorage.getStore();
  if (!ctx) {
    throw new Error('tenantDb() called outside of withTenantDb middleware context');
  }
  return ctx.db;
}
