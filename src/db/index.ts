import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import dns from 'dns';
import * as schema from './schema.js';
import { DB_PROVIDER, AIVEN_CONFIG } from './dbCredentials.js';

const { Pool } = pg;

// Custom DNS lookup to resolve hostnames reliably on sandboxed runtimes
const customLookup = (hostname: string, options: any, callback: any) => {
  dns.lookup(hostname, { family: 4 }, (err, address, family) => {
    callback(err, address, family);
  });
};

// Env-configurable with sane defaults: 20 connections is a reasonable ceiling for a
// single Node process, and a 15s statement timeout stops a runaway full-table-scan
// query from holding a connection open indefinitely.
const POOL_MAX = Number(process.env.DB_POOL_MAX) || 20;
const STATEMENT_TIMEOUT_MS = Number(process.env.DB_STATEMENT_TIMEOUT_MS) || 15000;

export const createPool = () => {
  if (DB_PROVIDER === 'aiven') {
    return new Pool({
      host: AIVEN_CONFIG.host,
      port: AIVEN_CONFIG.port,
      user: AIVEN_CONFIG.user,
      password: AIVEN_CONFIG.password,
      database: AIVEN_CONFIG.database,
      ssl: AIVEN_CONFIG.ssl,
      connectionTimeoutMillis: 15000,
      max: POOL_MAX,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      lookup: customLookup
    } as any);
  } else {
    return new Pool({
      host: process.env.SQL_HOST,
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      database: process.env.SQL_DB_NAME,
      connectionTimeoutMillis: 15000,
      max: POOL_MAX,
      statement_timeout: STATEMENT_TIMEOUT_MS,
    });
  }
};

export const pool = createPool();

pool.on('error', (err) => {
  console.error('Unexpected error on idle SQL pool client:', err);
});

export const db = drizzle(pool, { schema });
