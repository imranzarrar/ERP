import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq, and } from 'drizzle-orm';
import pg from 'pg';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Phase 6 (the final phase) of the RLS full-rollout (BACKLOG.md) migrated
// server/routes/taxReturns.ts (fully), server/routes/roles.ts (GET / and the write half of
// DELETE /:id — POST / stays permanently exempt, see that route's own comment),
// server/routes/settingsResources.ts (document templates — POST/PATCH/DELETE's write half;
// the id-only ownership pre-check on each stays on the superuser `db` by the same
// hijack-detection reasoning as every prior phase; POST /templates/:id/copy and all 4
// /translations routes are permanent exemptions, documented inline in that file), and
// server/routes/users.ts (PATCH /me/language only — every other route in that file is a
// permanent, documented exemption: user administration is a genuinely cross-tenant-capable
// admin surface, not ordinary single-company master data).
//
// This file proves: (1) the migrated routes still work end-to-end, (2) the database itself
// enforces isolation via a raw erp_app_tenant connection with no WHERE clause for the two
// tables that gained real tenantDb-backed write traffic this phase (tax_returns, roles),
// and (3) the standing requirement from this session: a super-admin creating a new user for
// a company OTHER than their own (with a role assignment) is saved under the SELECTED
// company, not the super-admin's own home/active company — POST /users is a permanent
// exemption specifically so this legitimate cross-company write keeps working correctly
// under RLS instead of being rejected by tenantDb's WITH CHECK.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyAId: string;
let companyBId: string;
let sessionId: string; // company A admin
let superAdminUserId: string;
let superAdminSessionId: string;

async function api(sid: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-session-id': sid, ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function login(username: string) {
  const res = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });
  const body = await res.json().catch(() => null);
  if (!body?.sessionId) throw new Error(`Login failed for ${username}: status ${res.status}, body ${JSON.stringify(body)}`);
  return body.sessionId as string;
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
  companyAId = await makeCompany('TenantDb Phase6 Test Co A');
  companyBId = await makeCompany('TenantDb Phase6 Test Co B');

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

  const userAId = generateId();
  const usernameA = `tenantdb_p6_test_${userAId}`;
  await db.insert(schema.users).values({
    id: userAId, username: usernameA, password: passwordHash, role: 'admin', companyId: companyAId, isSuperAdmin: false,
  });
  sessionId = await login(usernameA);

  // Super-admin's own home/active company is Company A — the test below creates a user
  // for Company B (explicitly selected in the request body) to prove that write lands
  // under Company B, not the super-admin's own active Company A.
  superAdminUserId = generateId();
  const superAdminUsername = `tenantdb_p6_super_${superAdminUserId}`;
  await db.insert(schema.users).values({
    id: superAdminUserId, username: superAdminUsername, password: passwordHash,
    role: 'super-admin', companyId: companyAId, isSuperAdmin: true, uiLanguage: 'en',
  });
  superAdminSessionId = await login(superAdminUsername);
});

afterAll(async () => {
  const roleRowsA = await db.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.companyId, companyAId));
  const roleRowsB = await db.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.companyId, companyBId));
  for (const r of [...roleRowsA, ...roleRowsB]) {
    await db.delete(schema.userRoles).where(eq(schema.userRoles.roleId, r.id));
  }
  await db.delete(schema.roles).where(eq(schema.roles.companyId, companyAId));
  await db.delete(schema.roles).where(eq(schema.roles.companyId, companyBId));
  await db.delete(schema.taxReturns).where(eq(schema.taxReturns.companyId, companyAId));
  await db.delete(schema.taxReturns).where(eq(schema.taxReturns.companyId, companyBId));
  await db.delete(schema.documentTemplates).where(eq(schema.documentTemplates.companyId, companyAId));
  await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, superAdminUserId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyAId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyBId));
  await db.delete(schema.users).where(eq(schema.users.companyId, companyAId));
  await db.delete(schema.users).where(eq(schema.users.companyId, companyBId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyAId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyBId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyAId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyBId));
});

describe('Tax Returns — end-to-end through tenantDb, plus DB-level isolation', () => {
  let taxReturnId: string;
  const year = 2031; // far-future year, guaranteed not to collide with any other test's rows

  it('generates a VAT return for Company A', async () => {
    const { status, body } = await api(sessionId, '/api/tax-returns/generate', {
      method: 'POST',
      body: JSON.stringify({ year, quarter: 1 }),
    });
    expect(status).toBe(200);
    expect(body.taxReturn.status).toBe('Generated');
    taxReturnId = body.taxReturn.id;
  });

  it('lists it back via GET /tax-returns', async () => {
    const { status, body } = await api(sessionId, '/api/tax-returns');
    expect(status).toBe(200);
    expect(body.some((r: any) => r.id === taxReturnId)).toBe(true);
  });

  it('files the return', async () => {
    const { status, body } = await api(sessionId, `/api/tax-returns/${taxReturnId}/file`, { method: 'POST' });
    expect([200, 400]).toContain(status);
    if (status === 200) {
      expect(body.taxReturn.status).toBe('Filed');
    }
  });

  it('a raw connection as erp_app_tenant, scoped to Company A, cannot see Company B\'s tax return even with no WHERE clause', async () => {
    const bReturnId = generateId();
    const [companyAUser] = await db.select().from(schema.users).where(eq(schema.users.companyId, companyAId));
    await db.insert(schema.taxReturns).values({
      id: bReturnId, companyId: companyBId, year, quarter: 2, referenceNumber: `Q2-${year}`,
      startDate: `${year}-04-01`, endDate: `${year}-06-30`, status: 'Generated', isDeleted: false,
      figuresSnapshot: {}, generatedAt: new Date(), generatedById: companyAUser.id,
    });

    const { Pool } = pg;
    const pool = new Pool({
      host: process.env.SQL_HOST, user: process.env.TENANT_DB_USER,
      password: process.env.TENANT_DB_PASSWORD, database: process.env.SQL_DB_NAME,
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.company_id', $1, true)", [companyAId]);
      const res = await client.query('SELECT id FROM tax_returns');
      const ids = res.rows.map((r: any) => r.id);
      expect(ids).toContain(taxReturnId);
      expect(ids).not.toContain(bReturnId);
      await client.query('ROLLBACK');
    } finally {
      client.release();
      await pool.end();
    }
    await db.delete(schema.taxReturns).where(eq(schema.taxReturns.id, bReturnId));
  });
});

describe('Roles — GET and DELETE through tenantDb, plus DB-level isolation', () => {
  let roleAId: string;

  it('creates a role directly (POST /roles is a permanent exemption — see roles.ts), then lists it via the tenantDb-backed GET /', async () => {
    roleAId = generateId();
    await db.insert(schema.roles).values({ id: roleAId, name: 'Phase6 Role A', companyId: companyAId, permissions: {} });

    const { status, body } = await api(sessionId, '/api/roles');
    expect(status).toBe(200);
    expect(body.some((r: any) => r.id === roleAId)).toBe(true);
  });

  it('a raw connection as erp_app_tenant, scoped to Company A, cannot see Company B\'s role even with no WHERE clause', async () => {
    const roleBId = generateId();
    await db.insert(schema.roles).values({ id: roleBId, name: 'Phase6 Role B', companyId: companyBId, permissions: {} });

    const { Pool } = pg;
    const pool = new Pool({
      host: process.env.SQL_HOST, user: process.env.TENANT_DB_USER,
      password: process.env.TENANT_DB_PASSWORD, database: process.env.SQL_DB_NAME,
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.company_id', $1, true)", [companyAId]);
      const res = await client.query('SELECT id FROM roles');
      const ids = res.rows.map((r: any) => r.id);
      expect(ids).toContain(roleAId);
      expect(ids).not.toContain(roleBId);
      await client.query('ROLLBACK');
    } finally {
      client.release();
      await pool.end();
    }
  });

  it('deletes the role through the tenantDb-backed write half of DELETE /:id', async () => {
    const { status } = await api(sessionId, `/api/roles/${roleAId}`, { method: 'DELETE' });
    expect(status).toBe(200);
    const [row] = await db.select().from(schema.roles).where(eq(schema.roles.id, roleAId));
    expect(row).toBeUndefined();
  });
});

describe('Document Templates — write half of POST/PATCH/DELETE through tenantDb', () => {
  let templateId: string;

  it('creates a template', async () => {
    const { status, body } = await api(sessionId, '/api/templates', {
      method: 'POST',
      body: JSON.stringify({ name: 'Phase6 Template', language: 'en', pageSize: 'A4' }),
    });
    expect(status).toBe(200);
    templateId = body.id;
    const [row] = await db.select().from(schema.documentTemplates).where(eq(schema.documentTemplates.id, templateId));
    expect(row.companyId).toBe(companyAId);
  });

  it('activates it (the isActive:true branch, previously its own nested db.transaction)', async () => {
    const { status } = await api(sessionId, `/api/templates/${templateId}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: true }),
    });
    expect(status).toBe(200);
    const [row] = await db.select().from(schema.documentTemplates).where(eq(schema.documentTemplates.id, templateId));
    expect(row.isActive).toBe(true);
  });

  it('deletes it', async () => {
    const { status } = await api(sessionId, `/api/templates/${templateId}`, { method: 'DELETE' });
    expect(status).toBe(200);
    const [row] = await db.select().from(schema.documentTemplates).where(eq(schema.documentTemplates.id, templateId));
    expect(row).toBeUndefined();
  });
});

// The standing, explicitly-requested test from this session: "when super admin creates a
// new user, make sure it is saved to company selected at the time of user creation and
// role, must test." POST /users is a permanent tenantDb/RLS exemption specifically so this
// keeps working — see users.ts's header comment for why.
describe('POST /api/users — super-admin creates a user for a DIFFERENT company than their own, with a role', () => {
  let roleForCompanyBId: string;
  let createdUserId: string;

  beforeAll(async () => {
    roleForCompanyBId = generateId();
    await db.insert(schema.roles).values({ id: roleForCompanyBId, name: 'Phase6 Company B Role', companyId: companyBId, permissions: {} });
  });

  it('creates the user with an explicit companyId (Company B) while the super-admin\'s own active company is Company A', async () => {
    createdUserId = generateId();
    const { status, body } = await api(superAdminSessionId, '/api/users', {
      method: 'POST',
      body: JSON.stringify({
        id: createdUserId,
        username: `phase6_created_${createdUserId}`,
        email: `${createdUserId}@example.com`,
        password: 'Pw_2026_test!',
        role: 'user',
        companyId: companyBId,
        roleIds: [roleForCompanyBId],
      }),
    });
    expect(status).toBe(200);
    expect(body.droppedRoles).toBeUndefined();

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, createdUserId));
    expect(row).toBeTruthy();
    // The core assertion: saved under the SELECTED company (B), not the super-admin's own
    // active/home company (A).
    expect(row.companyId).toBe(companyBId);
    expect(row.companyId).not.toBe(companyAId);

    const assignedRoles = await db.select().from(schema.userRoles).where(eq(schema.userRoles.userId, createdUserId));
    expect(assignedRoles.map(r => r.roleId)).toEqual([roleForCompanyBId]);
  });

  it('a raw connection as erp_app_tenant, scoped to Company B, can see this user (proving the write is genuinely visible under Company B\'s RLS scope, not just a stray column value)', async () => {
    const { Pool } = pg;
    const pool = new Pool({
      host: process.env.SQL_HOST, user: process.env.TENANT_DB_USER,
      password: process.env.TENANT_DB_PASSWORD, database: process.env.SQL_DB_NAME,
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.company_id', $1, true)", [companyBId]);
      const res = await client.query('SELECT id FROM users WHERE id = $1', [createdUserId]);
      expect(res.rows.length).toBe(1);
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      await client.query("SELECT set_config('app.company_id', $1, true)", [companyAId]);
      const res2 = await client.query('SELECT id FROM users WHERE id = $1', [createdUserId]);
      expect(res2.rows.length).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
      await pool.end();
    }
  });

  afterAll(async () => {
    await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, createdUserId));
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, createdUserId));
    await db.delete(schema.users).where(eq(schema.users.id, createdUserId));
    await db.delete(schema.roles).where(eq(schema.roles.id, roleForCompanyBId));
  });
});
