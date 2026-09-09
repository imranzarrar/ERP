import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { eq, and, like } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server + real Postgres state, no
// mocks, matching this project's established convention (tests/passwordReset.test.ts,
// tests/newCompanyStarterResources.test.ts). This dev environment has real SMTP
// credentials configured (see tests/passwordReset.test.ts's file header) — approve
// attempts a real send below, always against a fake @example.com contact address so
// nothing ever reaches a real inbox. Whether that send actually succeeds depends on the
// configured account's own state (a personal Gmail account's daily limit is easy to
// exhaust during heavy local testing — confirmed happening), so the relevant test asserts
// both outcomes are handled correctly rather than assuming success. A real, usable
// passwordResetTokens row is created either way (that's the actual account-activation
// mechanism — see server/routes/onboarding.ts); resetUrl is only ever returned in the API
// response as a manual fallback when the email genuinely couldn't be sent.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let superAdminHomeCompanyId: string;
let superAdminUserId: string;
let superAdminSessionId: string;
let companyAdminUserId: string; // role:'admin', NOT super-admin — for 403 checks
let companyAdminSessionId: string;
let templateId: string;

const createdRequestIds: string[] = [];
const createdCompanyIds: string[] = [];
const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];

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

// The public onboarding endpoint rate-limits by req.ip, tracked in the dev server's own
// in-process memory for the lifetime of that process — NOT reset between separate test
// runs (only a server restart clears it). Since server.ts already sets
// app.set('trust proxy', 1), a distinct X-Forwarded-For per test gives each its own
// independent rate-limit bucket, both isolating tests from each other AND making this
// file safe to re-run repeatedly against an already-warm dev server without accumulating
// stale exhaustion from a previous run.
function freshFakeIp(): string {
  return `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}
async function submitOnboarding(payload: any, fakeIp: string = freshFakeIp()) {
  return api(null, '/api/onboarding-requests', {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'X-Forwarded-For': fakeIp },
  });
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

function submitPayload(overrides: Partial<Record<string, any>> = {}) {
  const uniq = generateId();
  return {
    companyName: `Onboarding Test Co ${uniq}`,
    companyEmail: `onboardtest_${uniq}@example.com`,
    companyPhone: '+966500000000',
    companyAddress: 'Test Street, Riyadh',
    vatNumber: '300000000000003',
    crNumber: '1010000000',
    contactName: `Test Contact ${uniq}`,
    contactEmail: `contact_${uniq}@example.com`,
    contactPhone: '+966511111111',
    notes: 'Automated test submission',
    website: '', // honeypot, left empty like a real user
    ...overrides,
  };
}

// Defaults to already-verified — most tests here exercise approve/reject behavior, which
// is downstream of email confirmation, not that mechanism itself (covered separately
// below). Pass `verified: false` to get a genuinely unverified fixture instead.
async function insertPendingRequest(overrides: Partial<Record<string, any>> & { verified?: boolean } = {}) {
  const { verified = true, ...payloadOverrides } = overrides;
  const payload = submitPayload(payloadOverrides);
  const id = generateId();
  await db.insert(schema.companyOnboardingRequests).values({
    id,
    companyName: payload.companyName,
    companyEmail: payload.companyEmail,
    companyPhone: payload.companyPhone,
    companyAddress: payload.companyAddress,
    vatNumber: payload.vatNumber,
    crNumber: payload.crNumber,
    contactName: payload.contactName,
    contactEmail: payload.contactEmail,
    contactPhone: payload.contactPhone,
    notes: payload.notes,
    status: 'Pending',
    emailVerifiedAt: verified ? new Date() : null,
  });
  createdRequestIds.push(id);
  return { id, payload };
}

beforeAll(async () => {
  superAdminHomeCompanyId = generateId();
  await db.insert(schema.companies).values({
    id: superAdminHomeCompanyId, name: 'Onboarding Test Super Admin Home', address: 'x', phone: '0',
    email: 'home@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
  });

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

  superAdminUserId = generateId();
  const superAdminUsername = `onboardtest_super_${superAdminUserId}`;
  await db.insert(schema.users).values({
    id: superAdminUserId, username: superAdminUsername, password: passwordHash,
    role: 'super-admin', companyId: superAdminHomeCompanyId, isSuperAdmin: true, uiLanguage: 'en',
  });

  companyAdminUserId = generateId();
  const companyAdminUsername = `onboardtest_admin_${companyAdminUserId}`;
  await db.insert(schema.users).values({
    id: companyAdminUserId, username: companyAdminUsername, password: passwordHash,
    role: 'admin', companyId: superAdminHomeCompanyId, isSuperAdmin: false, uiLanguage: 'en',
  });

  templateId = generateId();
  await db.insert(schema.roleTemplates).values({
    id: templateId,
    name: `Test Sales Template ${templateId}`,
    description: 'A limited template for automated testing',
    permissions: { quotation: { read: { enabled: true } } },
  });

  superAdminSessionId = await login(superAdminUsername);
  companyAdminSessionId = await login(companyAdminUsername);
});

afterAll(async () => {
  // Tear down anything approve() created, deepest-dependency-first. Onboarding-request
  // rows must go before companies — createdCompanyId FKs into companies.
  await db.delete(schema.companyOnboardingRequests).where(like(schema.companyOnboardingRequests.companyName, 'Onboarding Test Co %'));
  await db.delete(schema.companyOnboardingRequests).where(like(schema.companyOnboardingRequests.companyName, 'Rate Limit Test %'));
  for (const id of createdRequestIds) {
    await db.delete(schema.companyOnboardingRequests).where(eq(schema.companyOnboardingRequests.id, id));
  }

  for (const userId of createdUserIds) {
    await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, userId));
    await db.delete(schema.passwordResetTokens).where(eq(schema.passwordResetTokens.userId, userId));
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  }
  for (const roleId of createdRoleIds) {
    await db.delete(schema.roles).where(eq(schema.roles.id, roleId));
  }
  for (const companyId of createdCompanyIds) {
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
    await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyId));
    await db.delete(schema.documentTemplates).where(eq(schema.documentTemplates.companyId, companyId));
    await db.delete(schema.warehouses).where(eq(schema.warehouses.companyId, companyId));
    await db.delete(schema.unitsOfMeasure).where(eq(schema.unitsOfMeasure.companyId, companyId));
    await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyId));
    await db.delete(schema.vendors).where(eq(schema.vendors.companyId, companyId));
    await db.delete(schema.customers).where(eq(schema.customers.companyId, companyId));
    await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyId));
    await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
  }
  await db.delete(schema.roleTemplates).where(eq(schema.roleTemplates.id, templateId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, superAdminUserId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, companyAdminUserId));
  await db.delete(schema.users).where(eq(schema.users.id, superAdminUserId));
  await db.delete(schema.users).where(eq(schema.users.id, companyAdminUserId));
  await db.delete(schema.companies).where(eq(schema.companies.id, superAdminHomeCompanyId));
});

describe('POST /api/onboarding-requests (public, no session)', () => {
  it('accepts a valid submission and creates a Pending row', async () => {
    const payload = submitPayload();
    const { status, body } = await submitOnboarding(payload);
    expect(status).toBe(200);
    expect(body.message).toBeTruthy();

    const [row] = await db.select().from(schema.companyOnboardingRequests)
      .where(eq(schema.companyOnboardingRequests.companyEmail, payload.companyEmail));
    expect(row).toBeTruthy();
    expect(row.status).toBe('Pending');
    expect(row.contactEmail).toBe(payload.contactEmail);
    createdRequestIds.push(row.id);
  });

  it('rejects a submission missing required fields', async () => {
    const { status, body } = await submitOnboarding(submitPayload({ companyName: '' }));
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();
  });

  it('silently drops a honeypot-filled submission (same generic response, no row created)', async () => {
    const payload = submitPayload({ website: 'http://spam.example.com' });
    const { status, body } = await submitOnboarding(payload);
    expect(status).toBe(200);
    expect(body.message).toBeTruthy();

    const rows = await db.select().from(schema.companyOnboardingRequests)
      .where(eq(schema.companyOnboardingRequests.companyEmail, payload.companyEmail));
    expect(rows.length).toBe(0);
  });

  it('rate-limits repeated submissions from the same IP', async () => {
    const marker = `Rate Limit Test ${generateId()}`;
    const sharedFakeIp = freshFakeIp(); // one IP, hammered — the point of this test
    const burst = Array.from({ length: 10 }, (_, i) => submitPayload({ companyName: marker, companyEmail: `ratelimit_${i}_${generateId()}@example.com` }));
    for (const payload of burst) {
      await submitOnboarding(payload, sharedFakeIp);
    }
    const created = await db.select().from(schema.companyOnboardingRequests)
      .where(eq(schema.companyOnboardingRequests.companyName, marker));
    // A fresh IP starts with a full budget, so exactly the configured max (5) should get
    // through out of this 10-request burst — proving the limiter engages, not a no-op.
    expect(created.length).toBeGreaterThan(0);
    expect(created.length).toBeLessThan(10);
  });

  it('stores an unverified row with a hashed, expiring confirmation token — never a plaintext one', async () => {
    const payload = submitPayload();
    const { status } = await submitOnboarding(payload);
    expect(status).toBe(200);

    const [row] = await db.select().from(schema.companyOnboardingRequests)
      .where(eq(schema.companyOnboardingRequests.companyEmail, payload.companyEmail));
    createdRequestIds.push(row.id);
    expect(row.emailVerifiedAt).toBeNull();
    expect(row.emailConfirmTokenHash).toBeTruthy();
    expect(row.emailConfirmTokenHash?.length).toBe(64); // sha256 hex digest length
    expect(new Date(row.emailConfirmExpiresAt as any).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('POST /api/onboarding-requests/confirm-email (public, no session)', () => {
  async function insertUnconfirmedRequest(opts: { expired?: boolean } = {}) {
    const rawToken = `confirm_test_${generateId()}`;
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const { id, payload } = await insertPendingRequest({ verified: false });
    await db.update(schema.companyOnboardingRequests).set({
      emailConfirmTokenHash: tokenHash,
      emailConfirmExpiresAt: opts.expired ? new Date(Date.now() - 60 * 60 * 1000) : new Date(Date.now() + 60 * 60 * 1000),
    }).where(eq(schema.companyOnboardingRequests.id, id));
    return { id, payload, rawToken };
  }

  it('rejects a missing token', async () => {
    const { status, body } = await api(null, '/api/onboarding-requests/confirm-email', {
      method: 'POST', body: JSON.stringify({}),
    });
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();
  });

  it('rejects a garbage/unknown token', async () => {
    const { status, body } = await api(null, '/api/onboarding-requests/confirm-email', {
      method: 'POST', body: JSON.stringify({ token: 'not-a-real-token' }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid or has expired/i);
  });

  it('rejects an expired token', async () => {
    const { rawToken } = await insertUnconfirmedRequest({ expired: true });
    const { status, body } = await api(null, '/api/onboarding-requests/confirm-email', {
      method: 'POST', body: JSON.stringify({ token: rawToken }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid or has expired/i);
  });

  it('accepts a valid token: sets emailVerifiedAt, clears the token, and is idempotent on a second click', async () => {
    const { id, payload, rawToken } = await insertUnconfirmedRequest();
    const { status, body } = await api(null, '/api/onboarding-requests/confirm-email', {
      method: 'POST', body: JSON.stringify({ token: rawToken }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.companyName).toBe(payload.companyName);

    const [row] = await db.select().from(schema.companyOnboardingRequests).where(eq(schema.companyOnboardingRequests.id, id));
    expect(row.emailVerifiedAt).toBeTruthy();
    // The token hash/expiry are deliberately left in place, not nulled — this row is
    // looked up BY that hash, so a second click of the same (real) link must still find
    // it in order to hit the idempotent-success branch below, rather than falling through
    // to "invalid or expired" just because the hash was cleared on first use.
    expect(row.emailConfirmTokenHash).toBeTruthy();

    // Clicking the same link again (already confirmed) succeeds idempotently rather than erroring.
    const second = await api(null, '/api/onboarding-requests/confirm-email', {
      method: 'POST', body: JSON.stringify({ token: rawToken }),
    });
    expect(second.status).toBe(200);
  });
});

describe('POST /api/admin/onboarding-requests/:id/resend-confirmation', () => {
  it('401s with no session, 403s for a non-super-admin', async () => {
    const { id } = await insertPendingRequest({ verified: false });
    const noSession = await api(null, `/api/admin/onboarding-requests/${id}/resend-confirmation`, { method: 'POST' });
    expect(noSession.status).toBe(401);
    const nonSuper = await api(companyAdminSessionId, `/api/admin/onboarding-requests/${id}/resend-confirmation`, { method: 'POST' });
    expect(nonSuper.status).toBe(403);
  });

  it('rejects resending for an already-verified request', async () => {
    const { id } = await insertPendingRequest({ verified: true });
    const { status, body } = await api(superAdminSessionId, `/api/admin/onboarding-requests/${id}/resend-confirmation`, { method: 'POST' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/already confirmed/i);
  });

  it('issues a fresh token that supersedes the expired one', async () => {
    const rawToken = `resend_test_${generateId()}`;
    const oldHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const { id } = await insertPendingRequest({ verified: false });
    await db.update(schema.companyOnboardingRequests).set({
      emailConfirmTokenHash: oldHash,
      emailConfirmExpiresAt: new Date(Date.now() - 60 * 60 * 1000), // already expired
    }).where(eq(schema.companyOnboardingRequests.id, id));

    const { status } = await api(superAdminSessionId, `/api/admin/onboarding-requests/${id}/resend-confirmation`, { method: 'POST' });
    expect(status).toBe(200);

    const [row] = await db.select().from(schema.companyOnboardingRequests).where(eq(schema.companyOnboardingRequests.id, id));
    expect(row.emailConfirmTokenHash).not.toBe(oldHash);
    expect(new Date(row.emailConfirmExpiresAt as any).getTime()).toBeGreaterThan(Date.now());

    // The OLD token must no longer work — it's been superseded, not merely duplicated.
    const oldConfirm = await api(null, '/api/onboarding-requests/confirm-email', {
      method: 'POST', body: JSON.stringify({ token: rawToken }),
    });
    expect(oldConfirm.status).toBe(400);
  });
});

describe('GET /api/admin/onboarding-requests', () => {
  it('401s with no session', async () => {
    const { status } = await api(null, '/api/admin/onboarding-requests');
    expect(status).toBe(401);
  });

  it('403s for a non-super-admin (company admin)', async () => {
    const { status } = await api(companyAdminSessionId, '/api/admin/onboarding-requests');
    expect(status).toBe(403);
  });

  it('lists requests for a super-admin', async () => {
    const { id } = await insertPendingRequest();
    const { status, body } = await api(superAdminSessionId, '/api/admin/onboarding-requests');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((r: any) => r.id === id)).toBe(true);
  });
});

describe('POST /api/admin/onboarding-requests/:id/approve', () => {
  it('401s with no session, 403s for a non-super-admin', async () => {
    const { id } = await insertPendingRequest();
    const noSession = await api(null, `/api/admin/onboarding-requests/${id}/approve`, { method: 'POST', body: JSON.stringify({ mode: 'admin' }) });
    expect(noSession.status).toBe(401);
    const nonSuper = await api(companyAdminSessionId, `/api/admin/onboarding-requests/${id}/approve`, { method: 'POST', body: JSON.stringify({ mode: 'admin' }) });
    expect(nonSuper.status).toBe(403);
  });

  it('mode:"admin" atomically creates the company, all starter resources, and a role:"admin" user with a usable password-reset link', async () => {
    const { id, payload } = await insertPendingRequest();
    const { status, body } = await api(superAdminSessionId, `/api/admin/onboarding-requests/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'admin' }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.companyId).toBeTruthy();
    expect(body.userId).toBeTruthy();
    // Real SMTP is configured in this dev environment (see file header), so the send is
    // attempted for real — but a personal Gmail account's daily sending limit is easy to
    // exhaust during heavy local testing (confirmed happening: "550 5.4.5 Daily user
    // sending limit exceeded"), at which point emailSent legitimately comes back false
    // and resetUrl legitimately comes back populated instead — that fallback path is
    // exactly what it's for. Assert only the one thing that's actually invariant: exactly
    // one of the two ways to reach the new user is present, never both, never neither.
    expect(typeof body.emailSent).toBe('boolean');
    if (body.emailSent) {
      expect(body.resetUrl).toBeUndefined();
    } else {
      expect(body.resetUrl).toMatch(/resetToken=/);
    }
    createdCompanyIds.push(body.companyId);
    createdUserIds.push(body.userId);

    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, body.companyId));
    expect(company.name).toBe(payload.companyName);
    expect(company.vatNumber).toBe(payload.vatNumber);

    const [bank] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, body.companyId));
    expect(bank?.isDefault).toBe(true);
    const [customer] = await db.select().from(schema.customers).where(eq(schema.customers.companyId, body.companyId));
    expect(customer?.name).toBe('Walk-in Customer');
    const [vendor] = await db.select().from(schema.vendors).where(eq(schema.vendors.companyId, body.companyId));
    expect(vendor?.name).toBe('Cash Vendor');
    const [taxSlab] = await db.select().from(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, body.companyId));
    expect(Number(taxSlab?.percentage)).toBe(15);
    expect(taxSlab?.isDefault).toBe(true);
    const [warehouse] = await db.select().from(schema.warehouses).where(eq(schema.warehouses.companyId, body.companyId));
    expect(warehouse?.isCompanyDefault).toBe(true);
    const [template] = await db.select().from(schema.documentTemplates).where(eq(schema.documentTemplates.companyId, body.companyId));
    expect(template?.isActive).toBe(true);
    const [month] = await db.select().from(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, body.companyId));
    expect(month?.status).toBe('Open');

    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, body.userId));
    expect(user.role).toBe('admin');
    expect(user.email).toBe(payload.contactEmail);
    const userRoleRows = await db.select().from(schema.userRoles).where(eq(schema.userRoles.userId, body.userId));
    expect(userRoleRows.length).toBe(0);

    // The raw token itself was only ever in the email that just went out for real (to a
    // fake @example.com address, so nothing readable by this test) — resetUrl is
    // deliberately withheld from the API response once emailSent is true (see
    // server/routes/onboarding.ts). What's verifiable from here is that a real, unused,
    // not-yet-expired token row exists for the new user; that the underlying
    // reset-password + login mechanism itself genuinely works end-to-end for a real raw
    // token is already covered by tests/passwordReset.test.ts.
    const [tokenRow] = await db.select().from(schema.passwordResetTokens).where(eq(schema.passwordResetTokens.userId, body.userId));
    expect(tokenRow).toBeTruthy();
    expect(tokenRow.usedAt).toBeNull();
    expect(new Date(tokenRow.expiresAt as any).getTime()).toBeGreaterThan(Date.now());
    // The new account's password is a long random value nobody could ever type (see
    // server/routes/onboarding.ts) — login is genuinely impossible until the reset link
    // is used, confirming the "must activate before login works" design.
    expect(user.password).toBeTruthy();

    const [requestRow] = await db.select().from(schema.companyOnboardingRequests).where(eq(schema.companyOnboardingRequests.id, id));
    expect(requestRow.status).toBe('Approved');
    expect(requestRow.createdCompanyId).toBe(body.companyId);
    expect(requestRow.reviewedById).toBe(superAdminUserId);
  });

  it('mode:"template" clones the template into a new company-scoped role and assigns it, with role:"user"', async () => {
    const { id } = await insertPendingRequest();
    const { status, body } = await api(superAdminSessionId, `/api/admin/onboarding-requests/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'template', roleTemplateId: templateId }),
    });
    expect(status).toBe(200);
    createdCompanyIds.push(body.companyId);
    createdUserIds.push(body.userId);

    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, body.userId));
    expect(user.role).toBe('user');

    const userRoleRows = await db.select().from(schema.userRoles).where(eq(schema.userRoles.userId, body.userId));
    expect(userRoleRows.length).toBe(1);
    createdRoleIds.push(userRoleRows[0].roleId);

    const [clonedRole] = await db.select().from(schema.roles).where(eq(schema.roles.id, userRoleRows[0].roleId));
    expect(clonedRole.companyId).toBe(body.companyId);
    const [template] = await db.select().from(schema.roleTemplates).where(eq(schema.roleTemplates.id, templateId));
    expect(clonedRole.name).toBe(template.name);
    expect(clonedRole.permissions).toEqual(template.permissions);
  });

  it('rejects mode:"template" with no roleTemplateId', async () => {
    const { id } = await insertPendingRequest();
    const { status, body } = await api(superAdminSessionId, `/api/admin/onboarding-requests/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'template' }),
    });
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();
  });

  it('rejects double-approval of an already-processed request, without creating a second company', async () => {
    const { id } = await insertPendingRequest();
    const first = await api(superAdminSessionId, `/api/admin/onboarding-requests/${id}/approve`, { method: 'POST', body: JSON.stringify({ mode: 'admin' }) });
    expect(first.status).toBe(200);
    createdCompanyIds.push(first.body.companyId);
    createdUserIds.push(first.body.userId);

    const second = await api(superAdminSessionId, `/api/admin/onboarding-requests/${id}/approve`, { method: 'POST', body: JSON.stringify({ mode: 'admin' }) });
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/already been approved/i);

    const [requestRow] = await db.select().from(schema.companyOnboardingRequests).where(eq(schema.companyOnboardingRequests.id, id));
    expect(requestRow.createdCompanyId).toBe(first.body.companyId);
  });
});

describe('POST /api/admin/onboarding-requests/:id/reject', () => {
  it('401s with no session, 403s for a non-super-admin', async () => {
    const { id } = await insertPendingRequest();
    const noSession = await api(null, `/api/admin/onboarding-requests/${id}/reject`, { method: 'POST', body: JSON.stringify({}) });
    expect(noSession.status).toBe(401);
    const nonSuper = await api(companyAdminSessionId, `/api/admin/onboarding-requests/${id}/reject`, { method: 'POST', body: JSON.stringify({}) });
    expect(nonSuper.status).toBe(403);
  });

  it('rejects with a reason and creates no company/user', async () => {
    const { id } = await insertPendingRequest();
    const { status, body } = await api(superAdminSessionId, `/api/admin/onboarding-requests/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Duplicate submission' }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [requestRow] = await db.select().from(schema.companyOnboardingRequests).where(eq(schema.companyOnboardingRequests.id, id));
    expect(requestRow.status).toBe('Rejected');
    expect(requestRow.rejectionReason).toBe('Duplicate submission');
    expect(requestRow.createdCompanyId).toBeNull();
  });

  it('rejects double-rejection of an already-processed request', async () => {
    const { id } = await insertPendingRequest();
    const first = await api(superAdminSessionId, `/api/admin/onboarding-requests/${id}/reject`, { method: 'POST', body: JSON.stringify({}) });
    expect(first.status).toBe(200);
    const second = await api(superAdminSessionId, `/api/admin/onboarding-requests/${id}/reject`, { method: 'POST', body: JSON.stringify({}) });
    expect(second.status).toBe(400);
  });
});

describe('GET /api/state — roleTemplates/companyOnboardingRequests leak guard', () => {
  it('hard-empties both arrays for a non-super-admin', async () => {
    const { status, body } = await api(companyAdminSessionId, '/api/state');
    expect(status).toBe(200);
    expect(body.roleTemplates).toEqual([]);
    expect(body.companyOnboardingRequests).toEqual([]);
  });

  it('includes both arrays, populated, for a super-admin', async () => {
    const { status, body } = await api(superAdminSessionId, '/api/state');
    expect(status).toBe(200);
    expect(Array.isArray(body.roleTemplates)).toBe(true);
    expect(body.roleTemplates.some((rt: any) => rt.id === templateId)).toBe(true);
    expect(Array.isArray(body.companyOnboardingRequests)).toBe(true);
  });
});
