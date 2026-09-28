import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server + real Postgres, no mocks,
// matching this project's convention (tests/companyOnboarding.test.ts). system_banner is a
// single, platform-wide singleton row shared by the whole app (including whatever a real
// browser session is looking at right now) — every test that changes it restores it to
// {enabled: false, message: ''} in afterAll so this file never leaves a real "maintenance"
// banner active for anyone else.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let homeCompanyId: string;
let superAdminSessionId: string;
let companyAdminSessionId: string; // role:'admin', NOT super-admin — for the 403 check
const createdUserIds: string[] = [];

async function api(sessionId: string | null, path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(sessionId ? { 'x-session-id': sessionId } : {}),
      ...(init.headers || {}),
    },
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

beforeAll(async () => {
  homeCompanyId = generateId();
  await db.insert(schema.companies).values({
    id: homeCompanyId, name: 'System Banner Test Co', address: 'x', phone: '0',
    email: 'home@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
  });

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

  const superAdminUserId = generateId();
  createdUserIds.push(superAdminUserId);
  const superAdminUsername = `bannertest_super_${superAdminUserId}`;
  await db.insert(schema.users).values({
    id: superAdminUserId, username: superAdminUsername, password: passwordHash,
    role: 'super-admin', companyId: homeCompanyId, isSuperAdmin: true, uiLanguage: 'en',
  });

  const companyAdminUserId = generateId();
  createdUserIds.push(companyAdminUserId);
  const companyAdminUsername = `bannertest_admin_${companyAdminUserId}`;
  await db.insert(schema.users).values({
    id: companyAdminUserId, username: companyAdminUsername, password: passwordHash,
    role: 'admin', companyId: homeCompanyId, isSuperAdmin: false, uiLanguage: 'en',
  });

  superAdminSessionId = await login(superAdminUsername);
  companyAdminSessionId = await login(companyAdminUsername);
});

afterAll(async () => {
  // Leave the singleton row in a known-off state — this is real, shared, cross-app state.
  await api(superAdminSessionId, '/api/system-banner', { method: 'PUT', body: JSON.stringify({ enabled: false, message: '' }) });
  // That PUT just set system_banner.updatedBy to this test's throwaway super-admin id —
  // null it out before deleting that user, or the row's own FK blocks the delete too.
  await db.update(schema.systemBanner).set({ updatedBy: null }).where(eq(schema.systemBanner.id, 'singleton'));

  for (const userId of createdUserIds) {
    await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, userId));
    // The PUT route above records an audit log entry (updatedBy/userId) — must go before
    // the user row itself, or the FK (audit_logs_user_id_users_id_fk) blocks the delete.
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  }
  await db.delete(schema.companies).where(eq(schema.companies.id, homeCompanyId));
});

describe('System Announcement Banner', () => {
  it('GET /api/system-banner is public (no session needed)', async () => {
    const { status, body } = await api(null, '/api/system-banner');
    expect(status).toBe(200);
    expect(typeof body.enabled).toBe('boolean');
    expect(typeof body.message).toBe('string');
  });

  it('rejects PUT from a non-super-admin with 403', async () => {
    const { status } = await api(companyAdminSessionId, '/api/system-banner', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true, message: 'Should not be allowed' }),
    });
    expect(status).toBe(403);
  });

  it('rejects enabling with an empty message', async () => {
    const { status, body } = await api(superAdminSessionId, '/api/system-banner', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true, message: '   ' }),
    });
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();
  });

  it('super-admin can enable it, and the public GET reflects it immediately', async () => {
    const message = `Scheduled maintenance test ${generateId()}`;
    const putRes = await api(superAdminSessionId, '/api/system-banner', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true, message }),
    });
    expect(putRes.status).toBe(200);
    expect(putRes.body.enabled).toBe(true);
    expect(putRes.body.message).toBe(message);
    expect(putRes.body.updatedAt).toBeTruthy();

    const getRes = await api(null, '/api/system-banner');
    expect(getRes.status).toBe(200);
    expect(getRes.body.enabled).toBe(true);
    expect(getRes.body.message).toBe(message);
  });

  it('super-admin can disable it again', async () => {
    const putRes = await api(superAdminSessionId, '/api/system-banner', {
      method: 'PUT',
      body: JSON.stringify({ enabled: false, message: 'irrelevant once disabled' }),
    });
    expect(putRes.status).toBe(200);
    expect(putRes.body.enabled).toBe(false);

    const getRes = await api(null, '/api/system-banner');
    expect(getRes.body.enabled).toBe(false);
  });
});
