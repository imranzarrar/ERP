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
  });
};

export const pool = createPool();

pool.on('error', (err) => {
  console.error('Unexpected error on idle SQL pool client:', err);
});

export const db = drizzle(pool, { schema });
