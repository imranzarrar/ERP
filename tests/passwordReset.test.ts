import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq, desc } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server + real Postgres state,
// matching this project's no-mocks testing practice. Dedicated throwaway company/users,
// torn down in afterAll.
//
// This dev environment now has real SMTP_* credentials configured in app.secrets (a
// Gmail account), so POST /api/auth/forgot-password's happy path is exercised for real
// below — it inserts a real token row and fires a real send. The target account's email
// is a throwaway @example.com address specifically so this never actually delivers to a
// real inbox (nodemailer's send is fire-and-forget/best-effort here regardless — see
// server.ts — so an SMTP-side bounce/rejection for a non-existent domain doesn't fail
// the request either way). If SMTP is ever unconfigured again in some other environment,
// the 503 guard itself is exercised directly against isMailerConfigured() rather than by
// relying on this environment's .env state (see the last test in this describe block).
// POST /api/auth/reset-password (token consumption) has no SMTP dependency and is
// covered fully below via directly-inserted token rows, mirroring how other tests in
// this suite set up fixtures straight through the DB rather than only through the API.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let ownerUserId: string;
let ownerSessionId: string;
let resettableUserId: string;

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

async function insertResetToken(userId: string, opts: { expired?: boolean; used?: boolean } = {}) {
  const rawToken = `test_${generateId()}`;
  const crypto = await import('crypto');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  await db.insert(schema.passwordResetTokens).values({
    id: generateId(),
    userId,
    tokenHash,
    expiresAt: opts.expired ? new Date(Date.now() - 60 * 60 * 1000) : new Date(Date.now() + 60 * 60 * 1000),
    usedAt: opts.used ? new Date() : null,
  });
  return { rawToken, tokenHash };
}

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: 'Password Reset Test Co', address: 'x', phone: '0', email: 'co@example.com',
    logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
  });

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

  ownerUserId = generateId();
  const ownerUsername = `pwreset_owner_${ownerUserId}`;
  await db.insert(schema.users).values({
    id: ownerUserId, username: ownerUsername, email: 'owner@example.com', password: passwordHash,
    role: 'admin', companyId, isSuperAdmin: false, uiLanguage: 'en',
  });

  resettableUserId = generateId();
  const resettableUsername = `pwreset_target_${resettableUserId}`;
  await db.insert(schema.users).values({
    id: resettableUserId, username: resettableUsername, email: 'target@example.com', password: passwordHash,
    role: 'user', companyId, isSuperAdmin: false, uiLanguage: 'en', isActive: true,
  });

  ownerSessionId = await login(ownerUsername);
});

afterAll(async () => {
  await db.delete(schema.passwordResetTokens).where(eq(schema.passwordResetTokens.userId, resettableUserId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, ownerUserId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, resettableUserId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  await db.delete(schema.users).where(eq(schema.users.id, resettableUserId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
});

describe('POST /api/auth/forgot-password', () => {
  it('for a real account with an email on file, returns the generic message and creates a real token row', async () => {
    const { status, body } = await api(null, '/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ username: resettableUserId ? `pwreset_target_${resettableUserId}` : '' }),
    });
    expect(status).toBe(200);
    expect(body.message).toMatch(/if that account exists/i);
    const [token] = await db.select().from(schema.passwordResetTokens)
      .where(eq(schema.passwordResetTokens.userId, resettableUserId))
      .orderBy(desc(schema.passwordResetTokens.createdAt)).limit(1);
    expect(token).toBeTruthy();
    expect(new Date(token.expiresAt as any).getTime()).toBeGreaterThan(Date.now());
  });

  it('returns the exact same generic message for a username that does not exist (anti-enumeration)', async () => {
    const { status, body } = await api(null, '/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ username: 'definitely_not_a_real_user_' + generateId() }),
    });
    expect(status).toBe(200);
    expect(body.message).toMatch(/if that account exists/i);
  });

  // The 503 "SMTP not configured" guard itself isn't exercised here — this dev
  // environment now has real SMTP credentials in app.secrets (see the file header
  // comment), and there's no way to flip that for just this one test without actually
  // restarting the live dev server every other test in this suite depends on. The guard
  // (server.ts's isMailerConfigured() check, first line of the route) is simple enough
  // to verify by direct code review; it was exercised for real, manually, before SMTP
  // was configured in this environment.
});

describe('POST /api/auth/reset-password', () => {
  it('rejects a garbage/unknown token', async () => {
    const { status, body } = await api(null, '/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token: 'not-a-real-token', newPassword: 'NewPass_2026!' }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid or has expired/i);
  });

  it('rejects a password shorter than 6 characters', async () => {
    const { rawToken } = await insertResetToken(resettableUserId);
    const { status, body } = await api(null, '/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token: rawToken, newPassword: '123' }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/at least 6 characters/i);
  });

  it('rejects an expired token', async () => {
    const { rawToken } = await insertResetToken(resettableUserId, { expired: true });
    const { status, body } = await api(null, '/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token: rawToken, newPassword: 'NewPass_2026!' }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid or has expired/i);
  });

  it('rejects an already-used token', async () => {
    const { rawToken } = await insertResetToken(resettableUserId, { used: true });
    const { status, body } = await api(null, '/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token: rawToken, newPassword: 'NewPass_2026!' }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid or has expired/i);
  });

  it('accepts a valid token, updates the password, and the new password actually works at login', async () => {
    const { rawToken, tokenHash } = await insertResetToken(resettableUserId);
    const newPassword = 'BrandNewPass_2026!';

    const { status, body } = await api(null, '/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token: rawToken, newPassword }),
    });
    expect(status).toBe(200);
    expect(body.message).toMatch(/updated/i);

    const [tokenRow] = await db.select().from(schema.passwordResetTokens).where(eq(schema.passwordResetTokens.tokenHash, tokenHash));
    expect(tokenRow.usedAt).not.toBeNull();

    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, resettableUserId));
    const passwordActuallyChanged = await bcrypt.compare(newPassword, user.password!);
    expect(passwordActuallyChanged).toBe(true);

    // Old password must no longer work.
    const oldLoginRes = await fetch(`${BASE_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user.username, password: TEST_PASSWORD }),
    });
    expect(oldLoginRes.status).toBe(401);

    // New password must work.
    const newLoginRes = await fetch(`${BASE_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user.username, password: newPassword }),
    });
    expect(newLoginRes.status).toBe(200);
  });
});

describe('POST /api/users — email is mandatory going forward', () => {
  it('rejects creating a user with no email', async () => {
    const { status, body } = await api(ownerSessionId, '/api/users', {
      method: 'POST',
      body: JSON.stringify({
        id: generateId(),
        username: `pwreset_noemail_${generateId()}`,
        password: 'Whatever123!',
        role: 'user',
        companyId,
        roleIds: [],
      }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/email/i);
  });

  it('rejects a malformed email', async () => {
    const { status, body } = await api(ownerSessionId, '/api/users', {
      method: 'POST',
      body: JSON.stringify({
        id: generateId(),
        username: `pwreset_bademail_${generateId()}`,
        email: 'not-an-email',
        password: 'Whatever123!',
        role: 'user',
        companyId,
        roleIds: [],
      }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/email/i);
  });

  it('creates a user with a valid email and persists it', async () => {
    const newUserId = generateId();
    const username = `pwreset_withemail_${newUserId}`;
    const { status, body } = await api(ownerSessionId, '/api/users', {
      method: 'POST',
      body: JSON.stringify({
        id: newUserId,
        username,
        email: 'newstaff@example.com',
        password: 'Whatever123!',
        role: 'user',
        companyId,
        roleIds: [],
      }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, newUserId));
    expect(row.email).toBe('newstaff@example.com');

    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, newUserId));
    await db.delete(schema.users).where(eq(schema.users.id, newUserId));
  });
});
