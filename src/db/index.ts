// See server.ts's own dotenv.config() call for why this isn't the default `.env` filename.
// Loaded here too (not just in server.ts) because this module is also imported directly
// by standalone scripts that never go through server.ts's own startup.
import dotenv from 'dotenv';
dotenv.config({ path: 'app.secrets', quiet: true });
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const { Pool } = pg;

// Env-configurable with sane defaults: 20 connections is a reasonable ceiling for a
// single Node process, and a 15s statement timeout stops a runaway full-table-scan
// query from holding a connection open indefinitely.
const POOL_MAX = Number(process.env.DB_POOL_MAX) || 20;
const STATEMENT_TIMEOUT_MS = Number(process.env.DB_STATEMENT_TIMEOUT_MS) || 15000;

export const createPool = () => {
  return new Pool({
    host: process.env.SQL_HOST,
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    database: process.env.SQL_DB_NAME,
    connectionTimeoutMillis: 15000,
    max: POOL_MAX,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    // Force every physical connection's session timezone to UTC, regardless of whatever
    // the underlying Postgres server itself is configured to (this app must never depend
    // on that being UTC — confirmed on this dev machine it's actually Asia/Riyadh, set in
    // Postgres's own postgresql.conf, nothing this app controls). Passed as a libpq
    // startup option so it's part of the connection's own handshake — applied before any
    // query can possibly run on it. (A `pool.on('connect', client => client.query(...))`
    // follow-up query was tried first and rejected: it races the pool handing that same
    // connection to whatever query is already waiting, so the very first query on a
    // freshly-opened connection could still run under the server's default timezone —
    // confirmed happening in practice right after a restart, when every connection is new.)
    // Without this, any column relying on the schema's `.defaultNow()` (Postgres's own
    // now(), evaluated in the session's timezone) gets its local wall-clock digits stored
    // into a timezone-less `timestamp` column, then misread back as if they were already
    // UTC — silently skewed by the session's UTC offset. Columns whose value is computed
    // in JS (`new Date()`) and passed in explicitly were never affected (confirmed by
    // inventory: every financial/transactional table sets createdAt this way on every
    // insert path) — this only ever hit a handful of secondary tables
    // (password_reset_tokens, zatca_environment_configs, roles, role_templates,
    // company_onboarding_requests, deleted_company_log) that lean on the DB-level default.
    options: '-c timezone=UTC',
  });
};

export const pool = createPool();

pool.on('error', (err) => {
  console.error('Unexpected error on idle SQL pool client:', err);
});

export const db = drizzle(pool, { schema });
