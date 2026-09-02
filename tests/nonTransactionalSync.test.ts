import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server (npm run dev on
// localhost:3000) + real Postgres state, matching this project's established
// no-mocks testing practice. Dedicated throwaway company/users, torn down in afterAll —
// never touches the seeded demo companies used for manual QA.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyAId: string;
let companyBId: string;
let ownerUserId: string;
let ownerSessionId: string;
let otherCompanyUserId: string;
let otherCompanySessionId: string;

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

beforeAll(async () => {
  companyAId = generateId();
  companyBId = generateId();
  await db.insert(schema.companies).values([
    { id: companyAId, name: 'Sync Test Co A', address: 'x', phone: '0', email: 'a@example.com', logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive' },
    { id: companyBId, name: 'Sync Test Co B', address: 'x', phone: '0', email: 'b@example.com', logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive' },
  ]);

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

  ownerUserId = generateId();
  const ownerUsername = `synctest_owner_${ownerUserId}`;
  await db.insert(schema.users).values({
    id: ownerUserId, username: ownerUsername, password: passwordHash,
    role: 'admin', companyId: companyAId, isSuperAdmin: false, uiLanguage: 'en',
  });

  otherCompanyUserId = generateId();
  const otherUsername = `synctest_other_${otherCompanyUserId}`;
  await db.insert(schema.users).values({
    id: otherCompanyUserId, username: otherUsername, password: passwordHash,
    role: 'admin', companyId: companyBId, isSuperAdmin: false, uiLanguage: 'en',
  });

  ownerSessionId = await login(ownerUsername);
  otherCompanySessionId = await login(otherUsername);
});

afterAll(async () => {
  // Login itself writes an audit_logs row referencing the user, so that must go first.
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, ownerUserId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, otherCompanyUserId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  await db.delete(schema.users).where(eq(schema.users.id, otherCompanyUserId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyAId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyBId));
});

describe('PATCH /api/companies/:id/theme', () => {
  it('updates only themeId for the caller\'s own company', async () => {
    const { status, body } = await api(ownerSessionId, `/api/companies/${companyAId}/theme`, {
      method: 'PATCH',
      body: JSON.stringify({ themeId: 'midnight-slate' }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [row] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyAId));
    expect(row.themeId).toBe('midnight-slate');
    // Nothing else on the row should have moved.
    expect(row.name).toBe('Sync Test Co A');
  });

  it('rejects a caller changing a different company\'s theme', async () => {
    const { status } = await api(otherCompanySessionId, `/api/companies/${companyAId}/theme`, {
      method: 'PATCH',
      body: JSON.stringify({ themeId: 'hacked' }),
    });
    expect(status).toBe(403);

    const [row] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyAId));
    expect(row.themeId).not.toBe('hacked');
  });

  it('rejects a missing themeId', async () => {
    const { status } = await api(ownerSessionId, `/api/companies/${companyAId}/theme`, {
      method: 'PATCH',
      body: JSON.stringify({}),
    });
    expect(status).toBe(400);
  });
});

describe('PATCH /api/users/me/language', () => {
  it('updates only the caller\'s own uiLanguage', async () => {
    const { status, body } = await api(ownerSessionId, `/api/users/me/language`, {
      method: 'PATCH',
      body: JSON.stringify({ uiLanguage: 'ar' }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, ownerUserId));
    expect(row.uiLanguage).toBe('ar');

    // The other user's language must be untouched.
    const [otherRow] = await db.select().from(schema.users).where(eq(schema.users.id, otherCompanyUserId));
    expect(otherRow.uiLanguage).toBe('en');
  });

  it('rejects an invalid language code', async () => {
    const { status } = await api(ownerSessionId, `/api/users/me/language`, {
      method: 'PATCH',
      body: JSON.stringify({ uiLanguage: 'zz' }),
    });
    expect(status).toBe(400);
  });
});
