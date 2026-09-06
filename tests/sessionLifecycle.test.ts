import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server + real Postgres, no
// mocks, matching this project's established convention (see tests/usersAdminActions.test.ts).
// Covers: (1) the session-TTL fix (server.ts's SESSION_TTL_SECONDS + connect-pg-simple ttl),
// (2) the ghost-row bug fix in isAuthenticated's non-cookie branch, (3) that the fix does NOT
// regress BACKLOG.md item 64's super-admin company-switch persistence over the x-session-id
// path, and (4) the new admin session list/revoke routes (server/routes/sessions.ts).
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyAId: string;
let companyBId: string;
let branchAId: string;
let branchBId: string;
let superAdminUserId: string;
let superAdminSessionId: string;
let companyAAdminUserId: string;
let companyAAdminSessionId: string;
let companyBAdminUserId: string;
let companyBAdminSessionId: string;
let companyANormalUserId: string;
let companyANormalSessionId: string;

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
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });
  const body = await res.json().catch(() => null);
  if (!body?.sessionId) throw new Error(`Login failed for ${username}: status ${res.status}, body ${JSON.stringify(body)}`);
  return body.sessionId as string;
}

// Scoped to one specific test user's own ghost rows (matched via the sess JSON blob,
// which is all the pre-fix ghost-row bug ever populated) rather than a global table-wide
// count — the dev Postgres instance is shared by every test file, several of which run
// concurrently in separate vitest workers and are themselves constantly logging in/out,
// so a global "did the row count change" check is flaky by construction. Scoping by
// userId makes the assertion immune to that unrelated concurrent activity.
async function countGhostRowsForUser(userId: string) {
  const [row] = await db.select({ count: sql<number>`count(*)::int` })
    .from(schema.user_sessions)
    .where(and(isNull(schema.user_sessions.userId), sql`${schema.user_sessions.sess}->>'userId' = ${userId}`));
  return row.count;
}

// The extend/backfill writes in isAuthenticated/login are fire-and-forget (never awaited
// by the request handler, deliberately — see server.ts's comments), so assertions on their
// side effects poll briefly instead of racing a fixed sleep.
async function waitUntil<T>(fn: () => Promise<T>, predicate: (v: T) => boolean, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  let last: T;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last!;
}

beforeAll(async () => {
  companyAId = generateId();
  companyBId = generateId();
  await db.insert(schema.companies).values([
    { id: companyAId, name: 'Session Lifecycle Test Co A', address: 'x', phone: '0', email: 'sla@example.com', logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive' },
    { id: companyBId, name: 'Session Lifecycle Test Co B', address: 'x', phone: '0', email: 'slb@example.com', logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive' },
  ]);

  branchAId = generateId();
  branchBId = generateId();
  await db.insert(schema.branches).values([
    { id: branchAId, companyId: companyAId, name: 'Session Test Branch A', code: 'SLA1' },
    { id: branchBId, companyId: companyBId, name: 'Session Test Branch B', code: 'SLB1' },
  ]);

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

  superAdminUserId = generateId();
  const superAdminUsername = `sesslife_super_${superAdminUserId}`;
  await db.insert(schema.users).values({
    id: superAdminUserId, username: superAdminUsername, password: passwordHash,
    role: 'super-admin', companyId: companyAId, isSuperAdmin: true, uiLanguage: 'en',
  });

  companyAAdminUserId = generateId();
  const companyAAdminUsername = `sesslife_admin_a_${companyAAdminUserId}`;
  await db.insert(schema.users).values({
    id: companyAAdminUserId, username: companyAAdminUsername, password: passwordHash,
    role: 'admin', companyId: companyAId, isSuperAdmin: false, uiLanguage: 'en',
  });

  companyBAdminUserId = generateId();
  const companyBAdminUsername = `sesslife_admin_b_${companyBAdminUserId}`;
  await db.insert(schema.users).values({
    id: companyBAdminUserId, username: companyBAdminUsername, password: passwordHash,
    role: 'admin', companyId: companyBId, isSuperAdmin: false, uiLanguage: 'en',
  });

  companyANormalUserId = generateId();
  const companyANormalUsername = `sesslife_normal_a_${companyANormalUserId}`;
  await db.insert(schema.users).values({
    id: companyANormalUserId, username: companyANormalUsername, password: passwordHash,
    role: 'user', companyId: companyAId, isSuperAdmin: false, uiLanguage: 'en',
  });

  superAdminSessionId = await login(superAdminUsername);
  companyAAdminSessionId = await login(companyAAdminUsername);
  companyBAdminSessionId = await login(companyBAdminUsername);
  companyANormalSessionId = await login(companyANormalUsername);
});

afterAll(async () => {
  const userIds = [superAdminUserId, companyAAdminUserId, companyBAdminUserId, companyANormalUserId];
  for (const id of userIds) {
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, id));
  }
  await db.delete(schema.user_sessions).where(eq(schema.user_sessions.userId, superAdminUserId));
  await db.delete(schema.user_sessions).where(eq(schema.user_sessions.userId, companyAAdminUserId));
  await db.delete(schema.user_sessions).where(eq(schema.user_sessions.userId, companyBAdminUserId));
  await db.delete(schema.user_sessions).where(eq(schema.user_sessions.userId, companyANormalUserId));
  await db.delete(schema.branches).where(eq(schema.branches.companyId, companyAId));
  await db.delete(schema.branches).where(eq(schema.branches.companyId, companyBId));
  for (const id of userIds) {
    await db.delete(schema.users).where(eq(schema.users.id, id));
  }
  await db.delete(schema.companies).where(eq(schema.companies.id, companyAId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyBId));
});

describe('Login populates the admin-session-list columns', () => {
  it('sets userId/companyId/lastActivity on the session row at login', async () => {
    const row = await waitUntil(
      async () => (await db.select().from(schema.user_sessions).where(eq(schema.user_sessions.sid, companyANormalSessionId)))[0],
      (r) => !!r?.userId,
    );
    expect(row.userId).toBe(companyANormalUserId);
    expect(row.companyId).toBe(companyAId);
    expect(row.lastActivity).toBeTruthy();
  });
});

// These three describe blocks use companyAAdminSessionId, not companyANormalSessionId —
// GET /api/branches requires the branches.read permission leaf, which an admin holds
// automatically via normalizePermissions' isAdmin bypass, but a plain 'user' role with no
// roles assigned does not (that would 403 regardless of session state, unrelated to what's
// being tested here). companyANormalSessionId is reserved for the permission-tier checks
// on the new admin session routes further down.
describe('Session TTL enforcement', () => {
  it('rejects a request once the session row has expired', async () => {
    await db.update(schema.user_sessions)
      .set({ expire: new Date(Date.now() - 60_000) })
      .where(eq(schema.user_sessions.sid, companyAAdminSessionId));

    const { status } = await api(companyAAdminSessionId, '/api/branches');
    expect(status).toBe(401);

    // Re-extend for later tests in this file that reuse the same login.
    await db.update(schema.user_sessions)
      .set({ expire: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) })
      .where(eq(schema.user_sessions.sid, companyAAdminSessionId));
  });
});

describe('Sliding expiration', () => {
  it('extends expire once it is past the halfway point of the TTL, on the next authenticated request', async () => {
    const nearExpiry = new Date(Date.now() + 60_000); // 1 minute left — well under half of a 7-day TTL, still valid
    await db.update(schema.user_sessions)
      .set({ expire: nearExpiry })
      .where(eq(schema.user_sessions.sid, companyAAdminSessionId));

    const { status } = await api(companyAAdminSessionId, '/api/branches');
    expect(status).toBe(200);

    const row = await waitUntil(
      async () => (await db.select().from(schema.user_sessions).where(eq(schema.user_sessions.sid, companyAAdminSessionId)))[0],
      (r) => r.expire.getTime() > nearExpiry.getTime() + 60_000,
    );
    // Should now be extended back out close to a full TTL, not just the 1-minute window it had.
    expect(row.expire.getTime()).toBeGreaterThan(nearExpiry.getTime() + 60_000);
  });
});

describe('Ghost-row fix: header-authenticated requests never insert extra user_sessions rows', () => {
  it('does not grow the count of null-userId rows across repeated requests', async () => {
    const before = await countGhostRowsForUser(companyAAdminUserId);
    for (let i = 0; i < 5; i++) {
      const { status } = await api(companyAAdminSessionId, '/api/branches');
      expect(status).toBe(200);
    }
    const after = await countGhostRowsForUser(companyAAdminUserId);
    expect(after).toBe(before);
    expect(after).toBe(0);
  });
});

describe('Company-switch persistence is not regressed by the ghost-row fix (BACKLOG item 64)', () => {
  it('keeps returning the switched-to company\'s data across repeated x-session-id requests, without creating ghost rows', async () => {
    const switchRes = await api(superAdminSessionId, '/api/switch-company', {
      method: 'POST',
      body: JSON.stringify({ companyId: companyBId }),
    });
    expect(switchRes.status).toBe(200);

    const before = await countGhostRowsForUser(superAdminUserId);
    for (let i = 0; i < 3; i++) {
      const { status, body } = await api(superAdminSessionId, '/api/branches');
      expect(status).toBe(200);
      const names = body.map((b: any) => b.name);
      expect(names).toContain('Session Test Branch B');
      expect(names).not.toContain('Session Test Branch A');
    }
    const after = await countGhostRowsForUser(superAdminUserId);
    expect(after).toBe(before);
    expect(after).toBe(0);

    // Switch back so this session doesn't leak a non-default target company into any
    // other test file that might reuse the same super-admin fixture pattern.
    await api(superAdminSessionId, '/api/switch-company', { method: 'POST', body: JSON.stringify({ companyId: companyAId }) });
  });
});

describe('GET /api/admin/sessions', () => {
  it('a non-admin is rejected', async () => {
    const { status } = await api(companyANormalSessionId, '/api/admin/sessions');
    expect(status).toBe(403);
  });

  it('a company-scoped admin sees their own company\'s sessions but never another company\'s', async () => {
    const { status, body } = await api(companyAAdminSessionId, '/api/admin/sessions');
    expect(status).toBe(200);
    const sids = body.sessions.map((s: any) => s.sid);
    expect(sids).toContain(companyAAdminSessionId);
    expect(sids).not.toContain(companyBAdminSessionId);
    for (const s of body.sessions) {
      expect(s.companyId).toBe(companyAId);
    }
  });

  it('a super-admin sees sessions across companies', async () => {
    const { status, body } = await api(superAdminSessionId, '/api/admin/sessions');
    expect(status).toBe(200);
    const sids = body.sessions.map((s: any) => s.sid);
    expect(sids).toContain(companyAAdminSessionId);
    expect(sids).toContain(companyBAdminSessionId);
  });
});

describe('DELETE /api/admin/sessions/:sid', () => {
  it('a non-admin is rejected', async () => {
    const { status } = await api(companyANormalSessionId, `/api/admin/sessions/${companyAAdminSessionId}`, { method: 'DELETE' });
    expect(status).toBe(403);
  });

  it('rejects revoking your own current session, with a clear message', async () => {
    const { status, body } = await api(companyAAdminSessionId, `/api/admin/sessions/${companyAAdminSessionId}`, { method: 'DELETE' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/logout/i);
    const [row] = await db.select().from(schema.user_sessions).where(eq(schema.user_sessions.sid, companyAAdminSessionId));
    expect(row).toBeTruthy();
  });

  it('rejects a company-scoped admin revoking a different company\'s session', async () => {
    const { status } = await api(companyAAdminSessionId, `/api/admin/sessions/${companyBAdminSessionId}`, { method: 'DELETE' });
    expect(status).toBe(403);
    const [row] = await db.select().from(schema.user_sessions).where(eq(schema.user_sessions.sid, companyBAdminSessionId));
    expect(row).toBeTruthy();
  });

  it('revokes another user\'s session in the same company, and that user is then unauthenticated', async () => {
    const { status } = await api(companyAAdminSessionId, `/api/admin/sessions/${companyANormalSessionId}`, { method: 'DELETE' });
    expect(status).toBe(200);

    const { status: nextStatus } = await api(companyANormalSessionId, '/api/branches');
    expect(nextStatus).toBe(401);

    // Log back in so this fixture user has a live session again for any later reference
    // (none currently follow, but keeps this describe block self-contained either way).
    companyANormalSessionId = await login(`sesslife_normal_a_${companyANormalUserId}`);
  });
});
