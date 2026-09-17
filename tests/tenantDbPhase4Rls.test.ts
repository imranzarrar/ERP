import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Phase 4 of the RLS full-rollout (BACKLOG.md) migrated server/routes/pos.ts's shifts,
// held-invoices, and returnable-invoices routes onto tenantDb() — POST /returns is
// deliberately deferred (fire-and-forget processInvoiceZatca, same category as
// transactions.ts's own deferred routes; see that route's own comment).
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyAId: string;
let companyBId: string;
let sessionId: string;

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
  companyAId = await makeCompany('TenantDb Phase4 Test Co A');
  companyBId = await makeCompany('TenantDb Phase4 Test Co B');

  const userAId = generateId();
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  const username = `tenantdb_p4_test_${userAId}`;
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
});

afterAll(async () => {
  await db.delete(schema.customers).where(eq(schema.customers.companyId, companyAId));
  await db.delete(schema.posHeldInvoices).where(eq(schema.posHeldInvoices.companyId, companyAId));
  await db.delete(schema.posHeldInvoices).where(eq(schema.posHeldInvoices.companyId, companyBId));
  await db.delete(schema.posShifts).where(eq(schema.posShifts.companyId, companyAId));
  await db.delete(schema.posShifts).where(eq(schema.posShifts.companyId, companyBId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyAId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyBId));
  await db.delete(schema.users).where(eq(schema.users.companyId, companyAId));
  await db.delete(schema.users).where(eq(schema.users.companyId, companyBId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyAId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyBId));
});

describe('POS shifts and held invoices — end-to-end through tenantDb', () => {
  let shiftAId: string;
  let shiftBId: string;

  it('opens a POS shift for Company A through the tenantDb-backed POST /shifts route', async () => {
    const [userA] = await db.select().from(schema.users).where(eq(schema.users.companyId, companyAId));
    const { status } = await api('/api/pos/shifts', {
      method: 'POST',
      // id and userId are both client-supplied on this route (see PosModule.tsx) —
      // matching real traffic.
      body: JSON.stringify({ id: generateId(), userId: userA.id, startTime: new Date().toISOString(), startCash: 100, status: 'open' }),
    });
    expect(status).toBe(200);
    const [row] = await db.select().from(schema.posShifts).where(eq(schema.posShifts.companyId, companyAId));
    expect(row).toBeTruthy();
    shiftAId = row.id;
  });

  it('GET /shifts for Company A never returns Company B\'s shift', async () => {
    shiftBId = generateId();
    const bUserId = generateId();
    await db.insert(schema.users).values({ id: bUserId, username: `p4bowner_${bUserId}`, password: 'x', role: 'admin', companyId: companyBId, isSuperAdmin: false });
    await db.insert(schema.posShifts).values({
      id: shiftBId, companyId: companyBId, userId: bUserId, startTime: new Date(), startCash: '0', status: 'open',
    });

    const { status, body } = await api('/api/pos/shifts');
    expect(status).toBe(200);
    const ids = body.map((s: any) => s.id);
    expect(ids).toContain(shiftAId);
    expect(ids).not.toContain(shiftBId);
  });

  it('a raw connection as erp_app_tenant, scoped to Company A, cannot see Company B\'s shift even with no WHERE clause', async () => {
    const { Pool } = pg;
    const pool = new Pool({
      host: process.env.SQL_HOST, user: process.env.TENANT_DB_USER,
      password: process.env.TENANT_DB_PASSWORD, database: process.env.SQL_DB_NAME,
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.company_id', $1, true)", [companyAId]);
      const res = await client.query('SELECT id FROM pos_shifts');
      const ids = res.rows.map((r: any) => r.id);
      expect(ids).toContain(shiftAId);
      expect(ids).not.toContain(shiftBId);
      await client.query('ROLLBACK');
    } finally {
      client.release();
      await pool.end();
    }
  });

  it('holds an invoice against the shift, lists it, then deletes it', async () => {
    const customerId = generateId();
    await db.insert(schema.customers).values({
      id: customerId, name: 'Phase4 Hold Customer', phone: '1', email: 'p4hold@example.com', address: 'A', companyId: companyAId, buyerType: 'B2C',
    });
    // id and customerId are both client-supplied on this route (see PosModule.tsx) —
    // matching real traffic.
    const { status, body } = await api('/api/pos/held-invoices', {
      method: 'POST',
      body: JSON.stringify({ id: generateId(), shiftId: shiftAId, customerId, items: [{ description: 'Held item', unitCost: 10, quantity: 1 }], reference: 'HOLD-1' }),
    });
    expect(status).toBe(200);
    const [held] = await db.select().from(schema.posHeldInvoices).where(eq(schema.posHeldInvoices.companyId, companyAId));
    expect(held).toBeTruthy();

    const { status: s2, body: listBody } = await api('/api/pos/held-invoices');
    expect(s2).toBe(200);
    expect(listBody.some((h: any) => h.id === held.id)).toBe(true);

    const { status: s3 } = await api(`/api/pos/held-invoices/${held.id}`, { method: 'DELETE' });
    expect(s3).toBe(200);
    const [afterDelete] = await db.select().from(schema.posHeldInvoices).where(eq(schema.posHeldInvoices.id, held.id));
    expect(afterDelete).toBeUndefined();
  });

  it('GET /returnable-invoices returns 200 through tenantDb with no server error', async () => {
    const { status } = await api('/api/pos/returnable-invoices');
    expect(status).toBe(200);
  });
});
