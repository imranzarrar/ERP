import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server + real Postgres state, no
// mocks, matching this project's established convention. Verifies POST /api/audit-logs/purge
// (server.ts) actually does what it claims: permanently removes rows older than 1 year while
// leaving recent rows untouched, refused for a company admin and, for a super-admin, applied across every company — this route had never been exercised by an automated test
// before. This is the one intentional exception to every other soft-delete conversion in this
// session's audit pass: audit-log retention pruning is meant to be a real, permanent DELETE.
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyAId: string;
let companyBId: string;
let adminAId: string;
let adminBId: string;
let superAdminId: string;
let adminASessionId: string;
let adminBSessionId: string;
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

async function insertLogRow(companyId: string, userId: string, username: string, ageInDays: number) {
  const createdAt = new Date(Date.now() - ageInDays * 24 * 60 * 60 * 1000);
  await db.insert(schema.auditLogs).values({
    companyId, userId, username, action: 'TEST_ACTION', entityType: 'test', entityId: null, details: null, createdAt,
  });
}

beforeAll(async () => {
  companyAId = generateId();
  companyBId = generateId();
  await db.insert(schema.companies).values([
    { id: companyAId, name: 'AuditPurge Test Co A', address: 'x', phone: '0', email: 'auditpurgea@example.com', logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive' },
    { id: companyBId, name: 'AuditPurge Test Co B', address: 'x', phone: '0', email: 'auditpurgeb@example.com', logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive' },
  ]);

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  adminAId = generateId();
  adminBId = generateId();
  superAdminId = generateId();
  await db.insert(schema.users).values([
    { id: adminAId, username: `auditpurge_admin_a_${adminAId}`, password: passwordHash, role: 'admin', companyId: companyAId, isSuperAdmin: false, uiLanguage: 'en' },
    { id: adminBId, username: `auditpurge_admin_b_${adminBId}`, password: passwordHash, role: 'admin', companyId: companyBId, isSuperAdmin: false, uiLanguage: 'en' },
    { id: superAdminId, username: `auditpurge_super_${superAdminId}`, password: passwordHash, role: 'super-admin', companyId: companyAId, isSuperAdmin: true, uiLanguage: 'en' },
  ]);

  adminASessionId = await login(`auditpurge_admin_a_${adminAId}`);
  adminBSessionId = await login(`auditpurge_admin_b_${adminBId}`);
  superAdminSessionId = await login(`auditpurge_super_${superAdminId}`);
});

afterAll(async () => {
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, adminAId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, adminBId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, superAdminId));
  await db.delete(schema.users).where(eq(schema.users.id, adminAId));
  await db.delete(schema.users).where(eq(schema.users.id, adminBId));
  await db.delete(schema.users).where(eq(schema.users.id, superAdminId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyAId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyBId));
});

// Purging the audit trail is platform-owner only: a company admin must not be able to erase their own company's history.
describe('POST /api/audit-logs/purge', () => {
  it('a company admin is rejected, and nothing is purged', async () => {
    await insertLogRow(companyAId, adminAId, 'purge-test-fixture', 400); // older than 1 year
    await insertLogRow(companyBId, adminBId, 'purge-test-fixture', 400);

    const { status } = await api(adminASessionId, '/api/audit-logs/purge', { method: 'POST' });
    expect(status).toBe(403);

    const remainingA = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.userId, adminAId));
    expect(remainingA.filter(r => r.action === 'TEST_ACTION').length).toBe(1);
    const remainingB = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.userId, adminBId));
    expect(remainingB.filter(r => r.action === 'TEST_ACTION').length).toBe(1);
  });

  it('a super-admin purging removes rows older than 1 year across every company, and keeps recent rows', async () => {
    await insertLogRow(companyAId, adminAId, 'purge-test-fixture', 10); // recent: must survive
    const { status, body } = await api(superAdminSessionId, '/api/audit-logs/purge', { method: 'POST' });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const remainingA = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.userId, adminAId));
    expect(remainingA.filter(r => r.action === 'TEST_ACTION').length).toBe(1); // only the 10-day-old row
    const remainingB = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.userId, adminBId));
    expect(remainingB.every(r => r.action !== 'TEST_ACTION')).toBe(true);
  });
});
