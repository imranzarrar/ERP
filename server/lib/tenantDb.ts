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
  afterCommitCallbacks: (() => void)[];
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

  // Commit/rollback BEFORE the response is actually flushed to the client, not after.
  // res.end() is the one method every response-sending path (res.json/res.send/res.end
  // itself) ultimately calls, so overriding it here closes a real, confirmed race: with
  // the previous design (finalizing from a res.on('finish', ...) listener), 'finish'
  // fires only once the response bytes have already reached the client — a caller could
  // receive its 200, immediately issue a follow-up read on a different connection, and
  // race ahead of the still-in-flight async COMMIT, observing stale pre-write data. This
  // surfaced as an intermittent, hard-to-reproduce test failure (a bank's toggle-active
  // write appearing not to have happened when re-read immediately after) before being
  // traced to this exact ordering bug — not real flakiness.
  const context: TenantContext = { db: drizzle(client, { schema }), afterCommitCallbacks: [] };

  const originalEnd = res.end.bind(res);
  res.end = (...args: any[]) => {
    const shouldCommit = res.statusCode >= 200 && res.statusCode < 400;
    finalize(shouldCommit)
      .then(() => {
        // Only run after a genuine, confirmed COMMIT — never on rollback. Matches the
        // existing db.transaction()-then-fire-and-forget pattern used elsewhere in this
        // app (e.g. processInvoiceZatca after an invoice-creation transaction): a side
        // effect that queries the just-written row via a SEPARATE connection (its own,
        // not this request's tenantDb one) must never be allowed to run before that row
        // is actually visible outside this transaction, or it will find nothing.
        if (shouldCommit) {
          for (const cb of context.afterCommitCallbacks) {
            try { cb(); } catch (err) { console.error('tenantDb: afterCommit callback threw', err); }
          }
        }
        originalEnd(...args);
      })
      .catch((err) => {
        console.error('tenantDb: finalize before response end failed', err);
        originalEnd(...args);
      });
    return res;
  };

  // Fallback only, for a connection aborted before res.end() is ever reached (e.g. a
  // genuinely dropped client) — makes sure the transaction still gets rolled back and the
  // client released rather than leaking a connection out of the pool forever. finalize's
  // own `settled` guard makes this safe to fire alongside the res.end() override above
  // without double-committing or double-releasing.
  res.on('close', () => {
    if (!res.writableEnded) {
      void finalize(false);
    }
  });

  tenantContextStorage.run(context, () => next());
}

export function tenantDb(): NodePgDatabase<typeof schema> {
  const ctx = tenantContextStorage.getStore();
  if (!ctx) {
    throw new Error('tenantDb() called outside of withTenantDb middleware context');
  }
  return ctx.db;
}

// Registers a callback to run once this request's transaction has genuinely COMMITted —
// after the database has durably applied every write, but still BEFORE the HTTP response
// actually reaches the client. Use this for any fire-and-forget side effect that queries
// the just-written data via a different connection (e.g. processInvoiceZatca, called via
// its own internal db access after an invoice-creation transaction) — calling it directly
// inside a tenantDb-backed route handler would race ahead of the real commit, since that
// only happens when the response is finalized (see withTenantDb's res.end override), not
// synchronously at the point the handler calls insert/update. Never fires if the request
// ends in a rollback (non-2xx status or a thrown error).
export function runAfterTenantCommit(callback: () => void): void {
  const ctx = tenantContextStorage.getStore();
  if (!ctx) {
    throw new Error('runAfterTenantCommit() called outside of withTenantDb middleware context');
  }
  ctx.afterCommitCallbacks.push(callback);
}
