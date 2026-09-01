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
let targetUserId: string; // a normal (non-admin-self) user in company A to toggle/delete
let bankId: string;
let investorId: string;

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
    { id: companyAId, name: 'Users Admin Test Co A', address: 'x', phone: '0', email: 'a@example.com', logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive' },
    { id: companyBId, name: 'Users Admin Test Co B', address: 'x', phone: '0', email: 'b@example.com', logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive' },
  ]);

  const monthId = new Date().toISOString().slice(0, 7);
  await db.insert(schema.fiscalMonths).values({
    id: monthId, name: monthId, status: 'Open', companyId: companyAId,
  }).onConflictDoNothing();

  bankId = generateId();
  await db.insert(schema.bankAccounts).values({
    id: bankId, bankName: 'Test Bank', accountNumber: '000111222', accountTitle: 'Users Admin Test Co A',
    openingBalance: '0', isActive: true, companyId: companyAId,
  });

  investorId = generateId();
  await db.insert(schema.investors).values({
    id: investorId, name: 'Test Investor', email: 'investor@example.com', phone: '0000000000',
    equityPercentage: '10', profitPercentage: '10', capitalContributed: '0', isActive: true,
    createdAt: new Date(), companyId: companyAId,
  });

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

  ownerUserId = generateId();
  const ownerUsername = `useradmin_owner_${ownerUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({
    id: ownerUserId, username: ownerUsername, password: passwordHash,
    role: 'admin', companyId: companyAId, isSuperAdmin: false, uiLanguage: 'en',
  });

  targetUserId = generateId();
  const targetUsername = `useradmin_target_${targetUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({
    id: targetUserId, username: targetUsername, password: passwordHash,
    role: 'user', companyId: companyAId, isSuperAdmin: false, uiLanguage: 'en', isActive: true,
  });

  otherCompanyUserId = generateId();
  const otherUsername = `useradmin_other_${otherCompanyUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({
    id: otherCompanyUserId, username: otherUsername, password: passwordHash,
    role: 'admin', companyId: companyBId, isSuperAdmin: false, uiLanguage: 'en',
  });

  ownerSessionId = await login(ownerUsername);
  otherCompanySessionId = await login(otherUsername);
});

afterAll(async () => {
  // Login/actions write audit_logs rows referencing these users, so that must go first.
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, ownerUserId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, otherCompanyUserId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, targetUserId));
  await db.delete(schema.vouchers).where(eq(schema.vouchers.companyId, companyAId));
  await db.delete(schema.investors).where(eq(schema.investors.id, investorId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.id, bankId));
  await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyAId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  await db.delete(schema.users).where(eq(schema.users.id, otherCompanyUserId));
  await db.delete(schema.users).where(eq(schema.users.id, targetUserId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyAId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyBId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyAId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyBId));
});

describe('PATCH /api/users/:id/active', () => {
  it('deactivates a user in the caller\'s own company', async () => {
    const { status, body } = await api(ownerSessionId, `/api/users/${targetUserId}/active`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: false }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, targetUserId));
    expect(row.isActive).toBe(false);
  });

  it('reactivates the user again', async () => {
    const { status } = await api(ownerSessionId, `/api/users/${targetUserId}/active`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: true }),
    });
    expect(status).toBe(200);

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, targetUserId));
    expect(row.isActive).toBe(true);
  });

  it('rejects a caller toggling a user in another company', async () => {
    const { status } = await api(otherCompanySessionId, `/api/users/${targetUserId}/active`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: false }),
    });
    expect(status).toBe(403);

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, targetUserId));
    expect(row.isActive).toBe(true);
  });

  it('rejects a non-boolean isActive', async () => {
    const { status } = await api(ownerSessionId, `/api/users/${targetUserId}/active`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: 'yes' }),
    });
    expect(status).toBe(400);
  });

  it('rejects deactivating your own session', async () => {
    const { status, body } = await api(ownerSessionId, `/api/users/${ownerUserId}/active`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: false }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/own active session/i);
  });
});

// Regression coverage for a real bug found live: a role belonging to a different company
// than the target user was silently dropped from the assignment with an unqualified
// {success:true} — the user ended up with zero roles (and therefore an empty nav) with no
// error anywhere to explain why. Fixed by reporting exactly which roleIds were dropped and
// why, via the response's `droppedRoles` field (server/routes/users.ts).
describe('POST /api/users — cross-company role assignment', () => {
  let roleAId: string;
  let roleBId: string;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    roleAId = generateId();
    await db.insert(schema.roles).values({
      id: roleAId, name: 'Cross-Company Test Role A', companyId: companyAId, permissions: {},
    });
    roleBId = generateId();
    await db.insert(schema.roles).values({
      id: roleBId, name: 'Cross-Company Test Role B', companyId: companyBId, permissions: {},
    });
  });

  afterAll(async () => {
    for (const id of createdUserIds) {
      await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, id));
      await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, id));
      await db.delete(schema.users).where(eq(schema.users.id, id));
    }
    await db.delete(schema.roles).where(eq(schema.roles.id, roleAId));
    await db.delete(schema.roles).where(eq(schema.roles.id, roleBId));
  });

  it('assigns a role that belongs to the same company as the user', async () => {
    const newUserId = generateId();
    createdUserIds.push(newUserId);
    const { status, body } = await api(ownerSessionId, '/api/users', {
      method: 'POST',
      body: JSON.stringify({
        id: newUserId, username: `crosscompany_ok_${newUserId.slice(0, 8)}`,
        email: `${newUserId.slice(0, 8)}@example.com`, password: 'Pw_2026!', role: 'user',
        companyId: companyAId, roleIds: [roleAId],
      }),
    });
    expect(status).toBe(200);
    expect(body.droppedRoles).toBeUndefined();

    const assigned = await db.select().from(schema.userRoles).where(eq(schema.userRoles.userId, newUserId));
    expect(assigned.map(r => r.roleId)).toEqual([roleAId]);
  });

  it('drops a role that belongs to a different company and reports it in droppedRoles', async () => {
    const newUserId = generateId();
    createdUserIds.push(newUserId);
    const { status, body } = await api(ownerSessionId, '/api/users', {
      method: 'POST',
      body: JSON.stringify({
        id: newUserId, username: `crosscompany_drop_${newUserId.slice(0, 8)}`,
        email: `${newUserId.slice(0, 8)}@example.com`, password: 'Pw_2026!', role: 'user',
        companyId: companyAId, roleIds: [roleBId],
      }),
    });
    // The user save itself still succeeds — only the mismatched role is refused.
    expect(status).toBe(200);
    expect(body.droppedRoles).toBeTruthy();
    expect(body.droppedRoles.length).toBe(1);
    expect(body.droppedRoles[0].roleId).toBe(roleBId);
    expect(body.droppedRoles[0].reason).toMatch(/Cross-Company Test Role B/);

    const assigned = await db.select().from(schema.userRoles).where(eq(schema.userRoles.userId, newUserId));
    expect(assigned.length).toBe(0);
  });
});

describe('POST /api/transactions/investors/:id/investment', () => {
  it('records a capital investment: creates a Receipt voucher and bumps capitalContributed', async () => {
    const { status, body } = await api(ownerSessionId, `/api/transactions/investors/${investorId}/investment`, {
      method: 'POST',
      body: JSON.stringify({
        bankId,
        amount: 5000,
        date: new Date().toISOString().split('T')[0],
        description: 'Initial capital injection',
      }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [investorRow] = await db.select().from(schema.investors).where(eq(schema.investors.id, investorId));
    expect(Number(investorRow.capitalContributed)).toBe(5000);

    const vouchers = await db.select().from(schema.vouchers).where(eq(schema.vouchers.referenceId, investorId));
    expect(vouchers.length).toBe(1);
    expect(vouchers[0].type).toBe('Receipt');
    expect(vouchers[0].referenceType).toBe('Equity');
    expect(Number(vouchers[0].amount)).toBe(5000);
  });

  it('accumulates capitalContributed across multiple investments', async () => {
    const { status } = await api(ownerSessionId, `/api/transactions/investors/${investorId}/investment`, {
      method: 'POST',
      body: JSON.stringify({
        bankId,
        amount: 1500,
        date: new Date().toISOString().split('T')[0],
        description: 'Second injection',
      }),
    });
    expect(status).toBe(200);

    const [investorRow] = await db.select().from(schema.investors).where(eq(schema.investors.id, investorId));
    expect(Number(investorRow.capitalContributed)).toBe(6500);
  });

  it('rejects a non-positive amount', async () => {
    const { status } = await api(ownerSessionId, `/api/transactions/investors/${investorId}/investment`, {
      method: 'POST',
      body: JSON.stringify({
        bankId,
        amount: 0,
        date: new Date().toISOString().split('T')[0],
        description: 'Invalid',
      }),
    });
    expect(status).toBe(400);
  });

  it('rejects an inactive/unknown bank', async () => {
    const { status } = await api(ownerSessionId, `/api/transactions/investors/${investorId}/investment`, {
      method: 'POST',
      body: JSON.stringify({
        bankId: generateId(),
        amount: 100,
        date: new Date().toISOString().split('T')[0],
        description: 'Bad bank',
      }),
    });
    expect(status).not.toBe(200);
  });

  it('rejects an investor from another company (not found from the caller\'s scope)', async () => {
    const { status } = await api(otherCompanySessionId, `/api/transactions/investors/${investorId}/investment`, {
      method: 'POST',
      body: JSON.stringify({
        bankId,
        amount: 100,
        date: new Date().toISOString().split('T')[0],
        description: 'Cross-tenant attempt',
      }),
    });
    expect(status).not.toBe(200);

    const [investorRow] = await db.select().from(schema.investors).where(eq(schema.investors.id, investorId));
    expect(Number(investorRow.capitalContributed)).toBe(6500); // unchanged
  });
});
