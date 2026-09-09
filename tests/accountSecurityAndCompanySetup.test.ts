import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server + real Postgres state,
// no mocks, matching this project's established convention. Covers a batch of setup-form
// fixes from one session: company VAT number format validation, product description now
// being mandatory, the account password policy (min length + letter + digit) on
// POST /api/users, and the forced-password-change flow (mustChangePassword flag set by an
// admin-driven password change, surfaced on login, cleared by the new self-service
// POST /api/auth/change-password route).
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let adminUserId: string;
let adminSessionId: string;

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

async function login(username: string, password: string) {
  const res = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: 'Account Security Test Co', address: 'x', phone: '0',
    email: 'accsec@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
  });
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  adminUserId = generateId();
  const adminUsername = `accsec_admin_${adminUserId}`;
  await db.insert(schema.users).values({
    id: adminUserId, username: adminUsername, password: passwordHash,
    role: 'admin', companyId, isSuperAdmin: false, uiLanguage: 'en',
  });
  const loginRes = await login(adminUsername, TEST_PASSWORD);
  adminSessionId = loginRes.body.sessionId;
});

afterAll(async () => {
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
  await db.delete(schema.productsServices).where(eq(schema.productsServices.companyId, companyId));
  await db.delete(schema.users).where(eq(schema.users.companyId, companyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
});

describe('Company VAT number validation', () => {
  it('rejects a VAT number that is not exactly 15 digits', async () => {
    const res = await api(adminSessionId, `/api/companies/${companyId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ vatNumber: '12345' }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/15 digits/i);
  });

  it('rejects a VAT number containing non-digit characters', async () => {
    const res = await api(adminSessionId, `/api/companies/${companyId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ vatNumber: '30012345670000A' }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts a blank VAT number (optional pre-ZATCA-onboarding)', async () => {
    const res = await api(adminSessionId, `/api/companies/${companyId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ vatNumber: '' }),
    });
    expect(res.status).toBe(200);
  });

  it('accepts a real 15-digit VAT number', async () => {
    const res = await api(adminSessionId, `/api/companies/${companyId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ vatNumber: '300123456700003' }),
    });
    expect(res.status).toBe(200);
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));
    expect(company.vatNumber).toBe('300123456700003');
  });
});

describe('Product description is optional', () => {
  it('accepts a new product with no description at all', async () => {
    const res = await api(adminSessionId, '/api/products', {
      method: 'POST',
      body: JSON.stringify({ name: 'No Description Widget', unitPrice: 10, itemKind: 'item' }),
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.productsServices).where(eq(schema.productsServices.id, res.body.id));
    expect(row.description).toBe('');
  });

  it('accepts a new product with a real description', async () => {
    const res = await api(adminSessionId, '/api/products', {
      method: 'POST',
      body: JSON.stringify({ name: 'Described Widget', description: 'A real description', unitPrice: 10, itemKind: 'item' }),
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.productsServices).where(eq(schema.productsServices.id, res.body.id));
    expect(row.description).toBe('A real description');
  });
});

describe('Account password policy on POST /api/users', () => {
  it('rejects a password shorter than 6 characters', async () => {
    const res = await api(adminSessionId, '/api/users', {
      method: 'POST',
      body: JSON.stringify({ id: generateId(), username: `weakpw1_${generateId()}`, email: 'weakpw1@example.com', password: 'ab1', role: 'admin', companyId }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/6 characters/i);
  });

  it('rejects a password with no digit', async () => {
    const res = await api(adminSessionId, '/api/users', {
      method: 'POST',
      body: JSON.stringify({ id: generateId(), username: `weakpw2_${generateId()}`, email: 'weakpw2@example.com', password: 'abcdefgh', role: 'admin', companyId }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a password with no letter', async () => {
    const res = await api(adminSessionId, '/api/users', {
      method: 'POST',
      body: JSON.stringify({ id: generateId(), username: `weakpw3_${generateId()}`, email: 'weakpw3@example.com', password: '12345678', role: 'admin', companyId }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts a compliant password', async () => {
    const res = await api(adminSessionId, '/api/users', {
      method: 'POST',
      body: JSON.stringify({ id: generateId(), username: `strongpw_${generateId()}`, email: 'strongpw@example.com', password: 'Str0ngPw', role: 'admin', companyId }),
    });
    expect(res.status).toBe(200);
  });
});

describe('Forced password change + self-service change-password', () => {
  it('flags mustChangePassword when an admin sets a password for a brand-new account', async () => {
    const newUserId = generateId();
    // Username is derived server-side from email for every brand-new account (see
    // users.ts) — a client-supplied username is ignored on create, so login uses the
    // email, not a separate handle.
    const newUsername = `forcedchange_${newUserId}@example.com`;
    const res = await api(adminSessionId, '/api/users', {
      method: 'POST',
      body: JSON.stringify({ id: newUserId, email: newUsername, password: 'AdminSet1', role: 'admin', companyId }),
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, newUserId));
    expect(row.mustChangePassword).toBe(true);
    expect(row.username).toBe(newUsername);

    const loginRes = await login(newUsername, 'AdminSet1');
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.user.mustChangePassword).toBe(true);

    // Wrong current password is rejected, doesn't clear the flag.
    const wrongRes = await api(loginRes.body.sessionId, '/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: 'WrongOne1', newPassword: 'MyOwnPw1' }),
    });
    expect(wrongRes.status).toBe(401);

    // A weak new password is rejected by the same policy as account creation.
    const weakRes = await api(loginRes.body.sessionId, '/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: 'AdminSet1', newPassword: '123456' }),
    });
    expect(weakRes.status).toBe(400);

    // Correct current password + a compliant new password succeeds and clears the flag.
    const changeRes = await api(loginRes.body.sessionId, '/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: 'AdminSet1', newPassword: 'MyOwnPw1' }),
    });
    expect(changeRes.status).toBe(200);
    const [rowAfter] = await db.select().from(schema.users).where(eq(schema.users.id, newUserId));
    expect(rowAfter.mustChangePassword).toBe(false);

    // Old password no longer works; the new one does.
    const oldLoginRes = await login(newUsername, 'AdminSet1');
    expect(oldLoginRes.status).toBe(401);
    const newLoginRes = await login(newUsername, 'MyOwnPw1');
    expect(newLoginRes.status).toBe(200);
    expect(newLoginRes.body.user.mustChangePassword).toBe(false);
  });

  it('does not leak the password hash to the client via GET /api/state', async () => {
    const res = await api(adminSessionId, '/api/state');
    expect(res.status).toBe(200);
    const someUser = (res.body.users || []).find((u: any) => u.companyId === companyId);
    expect(someUser).toBeTruthy();
    expect(someUser.password).toBeUndefined();
  });
});

describe('Deactivating an account actually locks it out (regression)', () => {
  // Previously "Toggle Status" (PATCH /api/users/:id/active) only ever flipped
  // users.isActive in the DB — nothing in POST /api/login or the isAuthenticated
  // middleware ever checked it, so a deactivated account could still log in fresh, and
  // an already-logged-in session kept working indefinitely with zero enforcement.
  it('rejects login for a deactivated account', async () => {
    const userId = generateId();
    const username = `accsec_deactivated_${userId}`;
    await db.insert(schema.users).values({
      id: userId, username, password: await bcrypt.hash(TEST_PASSWORD, 10),
      role: 'user', companyId, isSuperAdmin: false, uiLanguage: 'en', isActive: false,
    });
    const res = await login(username, TEST_PASSWORD);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/deactivated/i);
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  it('cuts off an already-logged-in session the moment the account is deactivated', async () => {
    const userId = generateId();
    const username = `accsec_livecutoff_${userId}`;
    await db.insert(schema.users).values({
      id: userId, username, password: await bcrypt.hash(TEST_PASSWORD, 10),
      role: 'user', companyId, isSuperAdmin: false, uiLanguage: 'en', isActive: true,
    });
    const loginRes = await login(username, TEST_PASSWORD);
    expect(loginRes.status).toBe(200);
    const sessionId = loginRes.body.sessionId;

    // Session works fine while active.
    const beforeRes = await api(sessionId, '/api/state');
    expect(beforeRes.status).toBe(200);

    // Admin deactivates the account via the real route (not a raw DB write) — this is
    // the exact "Toggle Status" action a real admin takes in the UI.
    const toggleRes = await api(adminSessionId, `/api/users/${userId}/active`, {
      method: 'PATCH', body: JSON.stringify({ isActive: false }),
    });
    expect(toggleRes.status).toBe(200);

    // The SAME still-open session must now be rejected on its very next request — no
    // separate session-invalidation step, matching the existing companyCancelled pattern.
    const afterRes = await api(sessionId, '/api/state');
    expect(afterRes.status).toBe(401);

    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });
});

describe('A soft-deleted account\'s username/email can be reused (regression)', () => {
  // DELETE /api/users/:id only ever sets isDeleted:1 — the row (and its username/email)
  // still physically exists. The uniqueness check in POST /api/users (and the DB-level
  // partial unique indexes backing it) previously didn't exclude isDeleted=1 rows, so a
  // deleted account's email permanently blocked ever creating a new one with that same
  // email again (re-hiring the same person, fixing a typo'd account, etc.).
  it('lets POST /api/users create a new account reusing a deleted account\'s email', async () => {
    const deletedId = generateId();
    const reusedEmail = `accsec_reuse_${deletedId}@example.com`;
    await db.insert(schema.users).values({
      id: deletedId, username: reusedEmail, email: reusedEmail,
      password: await bcrypt.hash(TEST_PASSWORD, 10),
      role: 'user', companyId, isSuperAdmin: false, uiLanguage: 'en', isDeleted: 1,
    });

    const newId = generateId();
    const res = await api(adminSessionId, '/api/users', {
      method: 'POST',
      body: JSON.stringify({ id: newId, email: reusedEmail, password: 'ReusedPw1', role: 'user', companyId }),
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, newId));
    expect(row.email).toBe(reusedEmail);
    expect(row.isDeleted).toBe(0);

    await db.delete(schema.users).where(eq(schema.users.id, deletedId));
    await db.delete(schema.users).where(eq(schema.users.id, newId));
  });

  it('the DB-level partial unique index itself allows a live row once the old row is soft-deleted', async () => {
    const deletedId = generateId();
    const newId = generateId();
    const reusedEmail = `accsec_dbindex_reuse_${deletedId}@example.com`;
    await db.insert(schema.users).values({
      id: deletedId, username: reusedEmail, email: reusedEmail,
      password: await bcrypt.hash(TEST_PASSWORD, 10),
      role: 'user', companyId, isSuperAdmin: false, uiLanguage: 'en', isDeleted: 1,
    });
    // A direct insert (bypassing the app-layer check entirely) proves the constraint
    // itself — not just the route's own pre-check — is what was narrowed.
    await db.insert(schema.users).values({
      id: newId, username: reusedEmail, email: reusedEmail,
      password: await bcrypt.hash(TEST_PASSWORD, 10),
      role: 'user', companyId, isSuperAdmin: false, uiLanguage: 'en', isDeleted: 0,
    });
    const rows = await db.select().from(schema.users).where(eq(schema.users.email, reusedEmail));
    expect(rows.length).toBe(2);

    await db.delete(schema.users).where(eq(schema.users.id, deletedId));
    await db.delete(schema.users).where(eq(schema.users.id, newId));
  });
});
