import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Proof-of-concept test for the tenantDb RLS rollout (server/lib/tenantDb.ts,
// src/db/schema.ts's TENANT_DB_ROLE comment). Two independent things are being proven:
//
// 1. The migrated /api/customers routes still work correctly end-to-end through the new
//    tenantDb path (not a regression from the app's default `db`).
// 2. The DATABASE ITSELF now enforces company isolation on `customers` — proven by
//    connecting directly as the restricted erp_app_tenant role and running a query with
//    NO WHERE clause at all. If this test only asserted through the app's own API (which
//    already filters by companyId at the application level), it would never actually
//    exercise the RLS policy — a route that forgot its own WHERE clause would still pass.
// This is the test that would have caught the confirmed drizzle-kit 0.31.10 bug (silently
// dropping the policy's USING/WITH CHECK predicate) had it not been caught by manual
// pg_policy inspection first.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyAId: string;
let companyBId: string;
let sessionId: string;
let customerAId: string;
let customerBId: string;

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function makeCompany(name: string) {
  const id = generateId();
  await db.insert(schema.companies).values({
    id, name, address: 'Test Address', phone: '0000000000', email: `${id}@example.com`,
    logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false,
  });
  return id;
}

beforeAll(async () => {
  companyAId = await makeCompany('TenantDb RLS Test Co A');
  companyBId = await makeCompany('TenantDb RLS Test Co B');

  const userAId = generateId();
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  const username = `tenantdb_test_${userAId}`;
  await db.insert(schema.users).values({
    id: userAId, username, password: passwordHash, role: 'admin', companyId: companyAId, isSuperAdmin: false,
  });

  const loginRes = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });
  const loginBody = await loginRes.json().catch(() => null);
  if (!loginBody?.sessionId) {
    throw new Error(`Test setup failed: login did not return a sessionId (status ${loginRes.status}, body ${JSON.stringify(loginBody)})`);
  }
  sessionId = loginBody.sessionId;

  customerBId = generateId();
  await db.insert(schema.customers).values({
    id: customerBId, name: 'Company B Customer (RLS)', phone: '222', email: 'bcust@example.com',
    address: 'B Address', companyId: companyBId, buyerType: 'B2C',
  });
});

afterAll(async () => {
  await db.delete(schema.customers).where(eq(schema.customers.companyId, companyAId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, companyBId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyAId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyBId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyAId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyBId));
  await db.delete(schema.users).where(eq(schema.users.companyId, companyAId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyAId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyBId));
});

describe('tenantDb end-to-end via the real API', () => {
  it('creates a customer for Company A through the tenantDb-backed POST /customers route', async () => {
    // customers.id has no DB- or app-level default (src/db/schema.ts) — the real client
    // always generates the UUID before POSTing, so the test must too.
    const newId = generateId();
    const { status, body } = await api('/api/customers', {
      method: 'POST',
      body: JSON.stringify({ id: newId, name: 'Company A Customer (RLS)', phone: '111', email: 'acust@example.com', address: 'A Address', buyerType: 'B2C' }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [row] = await db.select().from(schema.customers).where(eq(schema.customers.companyId, companyAId));
    expect(row).toBeTruthy();
    expect(row.name).toBe('Company A Customer (RLS)');
    customerAId = row.id;
  });

  it('GET /customers for Company A never returns Company B\'s customer', async () => {
    const { status, body } = await api('/api/customers');
    expect(status).toBe(200);
    const ids = body.map((c: any) => c.id);
    expect(ids).toContain(customerAId);
    expect(ids).not.toContain(customerBId);
  });
});

describe('Database-level RLS enforcement (bypasses the app entirely)', () => {
  it('a raw connection as erp_app_tenant, scoped to Company A, cannot see Company B\'s row even with no WHERE clause', async () => {
    const { Pool } = pg;
    const pool = new Pool({
      host: process.env.SQL_HOST,
      user: process.env.TENANT_DB_USER,
      password: process.env.TENANT_DB_PASSWORD,
      database: process.env.SQL_DB_NAME,
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.company_id', $1, true)", [companyAId]);
      // Deliberately no WHERE clause — if the RLS policy were missing/inert (the exact
      // failure mode confirmed and fixed this session), this would return every
      // customer row on the platform, including Company B's.
      const res = await client.query('SELECT id, company_id FROM customers');
      const ids = res.rows.map((r: any) => r.id);
      expect(ids).toContain(customerAId);
      expect(ids).not.toContain(customerBId);
      expect(res.rows.every((r: any) => r.company_id === companyAId)).toBe(true);
      await client.query('ROLLBACK');
    } finally {
      client.release();
      await pool.end();
    }
  });

  it('a raw connection as erp_app_tenant with no app.company_id set sees zero rows (fail-closed)', async () => {
    const { Pool } = pg;
    const pool = new Pool({
      host: process.env.SQL_HOST,
      user: process.env.TENANT_DB_USER,
      password: process.env.TENANT_DB_PASSWORD,
      database: process.env.SQL_DB_NAME,
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // app.company_id is never set on this connection at all.
      const res = await client.query('SELECT id FROM customers');
      expect(res.rows.length).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
      await pool.end();
    }
  });

  it('the superuser connection (main db export) bypasses RLS entirely, as expected — documents why tenantDb exists', async () => {
    const rows = await db.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.id, customerBId));
    expect(rows.length).toBe(1);
  });
});
