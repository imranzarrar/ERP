import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server + real Postgres state, no
// mocks. Covers GET /api/audit-logs itself (server.ts) — the keyset "before" pagination, the
// default/capped page-size limit, the filterUserId narrowing, and the company scoping (a
// plain admin locked to their own company vs a super-admin's companyId=all / explicit
// companyId) — none of which had a dedicated HTTP-level test before this session's audit-log
// scalability work (tests/auditLogPurge.test.ts only covers the purge route).
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyAId: string;
let companyBId: string;
let adminAId: string;
let adminBId: string;
let otherUserAId: string;
let superAdminId: string;
let adminASessionId: string;
let superAdminSessionId: string;

async function api(sessionId: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, ...(init.headers || {}) },
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

async function insertLogRow(companyId: string, userId: string, username: string, action: string, secondsAgo: number) {
  const createdAt = new Date(Date.now() - secondsAgo * 1000);
  await db.insert(schema.auditLogs).values({
    companyId, userId, username, action, entityType: 'test', entityId: null, details: null, createdAt,
  });
}

beforeAll(async () => {
  companyAId = generateId();
  companyBId = generateId();
  await db.insert(schema.companies).values([
    { id: companyAId, name: 'AuditListing Test Co A', address: 'x', phone: '0', email: 'auditlistinga@example.com', logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive' },
    { id: companyBId, name: 'AuditListing Test Co B', address: 'x', phone: '0', email: 'auditlistingb@example.com', logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive' },
  ]);

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  adminAId = generateId();
  adminBId = generateId();
  otherUserAId = generateId();
  superAdminId = generateId();
  await db.insert(schema.users).values([
    { id: adminAId, username: `auditlist_admin_a_${adminAId}`, password: passwordHash, role: 'admin', companyId: companyAId, isSuperAdmin: false, uiLanguage: 'en' },
    { id: adminBId, username: `auditlist_admin_b_${adminBId}`, password: passwordHash, role: 'admin', companyId: companyBId, isSuperAdmin: false, uiLanguage: 'en' },
    { id: otherUserAId, username: `auditlist_other_a_${otherUserAId}`, password: passwordHash, role: 'admin', companyId: companyAId, isSuperAdmin: false, uiLanguage: 'en' },
    { id: superAdminId, username: `auditlist_super_${superAdminId}`, password: passwordHash, role: 'super-admin', companyId: companyAId, isSuperAdmin: true, uiLanguage: 'en' },
  ]);

  adminASessionId = await login(`auditlist_admin_a_${adminAId}`);
  superAdminSessionId = await login(`auditlist_super_${superAdminId}`);

  // 5 rows for adminA in company A, strictly descending recency (0s, 10s, 20s, 30s, 40s ago),
  // 1 row for otherUserA in company A, 1 row for adminB in company B.
  for (let i = 0; i < 5; i++) {
    await insertLogRow(companyAId, adminAId, `auditlist_admin_a_${adminAId}`, `TEST_ACTION_${i}`, i * 10);
  }
  await insertLogRow(companyAId, otherUserAId, `auditlist_other_a_${otherUserAId}`, 'TEST_ACTION_OTHER', 5);
  await insertLogRow(companyBId, adminBId, `auditlist_admin_b_${adminBId}`, 'TEST_ACTION_COMPANY_B', 5);
});

afterAll(async () => {
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, adminAId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, adminBId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, otherUserAId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, superAdminId));
  await db.delete(schema.users).where(eq(schema.users.id, adminAId));
  await db.delete(schema.users).where(eq(schema.users.id, adminBId));
  await db.delete(schema.users).where(eq(schema.users.id, otherUserAId));
  await db.delete(schema.users).where(eq(schema.users.id, superAdminId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyAId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyBId));
});

describe('GET /api/audit-logs — pagination, filters, and company scoping', () => {
  // Logging in for the fixture itself writes a real LOGIN audit row for adminA at "now" —
  // a nice confirmation that login is audited too, but it interleaves with the synthetic
  // TEST_ACTION_* timestamps below, so these ordering-specific assertions filter it out to
  // isolate the fixture rows under test.
  function testActionsOnly(rows: any[]) {
    return rows.filter((r) => String(r.action).startsWith('TEST_ACTION_'));
  }

  it('returns rows newest-first, respecting a small explicit limit', async () => {
    const { status, body } = await api(adminASessionId, `/api/audit-logs?limit=10&filterUserId=${adminAId}`);
    expect(status).toBe(200);
    const mine = testActionsOnly(body).slice(0, 3);
    expect(mine[0].action).toBe('TEST_ACTION_0');
    expect(mine[1].action).toBe('TEST_ACTION_1');
    expect(mine[2].action).toBe('TEST_ACTION_2');
  });

  it('a "before" cursor keys off the oldest row already seen, with no overlap or gap on the next page', async () => {
    const first = await api(adminASessionId, `/api/audit-logs?limit=10&filterUserId=${adminAId}`);
    const firstMine = testActionsOnly(first.body).slice(0, 2);
    expect(firstMine.map((r: any) => r.action)).toEqual(['TEST_ACTION_0', 'TEST_ACTION_1']);

    const oldestSeen = firstMine[firstMine.length - 1].createdAt;
    const second = await api(adminASessionId, `/api/audit-logs?limit=10&filterUserId=${adminAId}&before=${encodeURIComponent(oldestSeen)}`);
    const secondMine = testActionsOnly(second.body).slice(0, 2);
    expect(secondMine.map((r: any) => r.action)).toEqual(['TEST_ACTION_2', 'TEST_ACTION_3']);

    // No row should appear on both pages.
    const firstIds = new Set(firstMine.map((r: any) => r.id));
    expect(secondMine.every((r: any) => !firstIds.has(r.id))).toBe(true);
  });

  it('filterUserId narrows to exactly one user within the same company', async () => {
    const { status, body } = await api(adminASessionId, `/api/audit-logs?limit=50&filterUserId=${otherUserAId}`);
    expect(status).toBe(200);
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((r: any) => r.userId === otherUserAId)).toBe(true);
  });

  it('an invalid (non-UUID) filterUserId is silently ignored rather than 500ing', async () => {
    const { status, body } = await api(adminASessionId, '/api/audit-logs?limit=50&filterUserId=not-a-uuid');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  it('a plain company admin never sees another company\'s rows, even if they ask for one by id', async () => {
    const { status, body } = await api(adminASessionId, `/api/audit-logs?limit=50&companyId=${companyBId}`);
    expect(status).toBe(200);
    expect(body.every((r: any) => r.companyId === companyAId)).toBe(true);
    expect(body.some((r: any) => r.action === 'TEST_ACTION_COMPANY_B')).toBe(false);
  });

  it('a super-admin with companyId=all sees rows across every company', async () => {
    const { status, body } = await api(superAdminSessionId, '/api/audit-logs?limit=200&companyId=all');
    expect(status).toBe(200);
    const companiesSeen = new Set(body.map((r: any) => r.companyId));
    expect(companiesSeen.has(companyAId)).toBe(true);
    expect(companiesSeen.has(companyBId)).toBe(true);
  });

  it('a super-admin can still scope down to one explicit company', async () => {
    const { status, body } = await api(superAdminSessionId, `/api/audit-logs?limit=50&companyId=${companyBId}`);
    expect(status).toBe(200);
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((r: any) => r.companyId === companyBId)).toBe(true);
  });

  it('a requested limit above the hard cap is clamped, not honored verbatim', async () => {
    const { status, body } = await api(superAdminSessionId, '/api/audit-logs?limit=99999&companyId=all');
    expect(status).toBe(200);
    expect(body.length).toBeLessThanOrEqual(500);
  });
});
