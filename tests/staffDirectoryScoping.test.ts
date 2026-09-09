import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server + real Postgres state,
// no mocks, matching this project's established convention. Covers a batch of "Provision
// New Account" bugs found by direct manual QA on the real form:
//
// 1. A super-admin's "Filter Directory" dropdown on the Staff Accounts screen never
//    actually fetched a different company's users — db.users (from GET /api/state) only
//    ever holds the currently active company's rows, and the dropdown just filtered that
//    same single-company array client-side. Fixed with a new GET /api/users route that
//    a super-admin can point at any company (or `all`), while a non-super-admin stays
//    hard-locked to their own company regardless of the query string.
// 2. DELETE /api/users/:id was scoped to req.targetCompanyId (the CALLER's own active
//    company) instead of the target row's actual company — deleting a user in a company
//    OTHER than whichever one happened to be active for the super-admin silently matched
//    zero rows while still reporting {success:true}. Fixed to check assertOwnsRow against
//    the real target row instead.
// 3. GET /api/users attaches each row's roleIds/branchIds/primaryBranchId directly (a join
//    bounded by the returned user ids) so the edit-form can prefill correctly for a user
//    outside the currently active company — db.userRoles/db.userBranches from /api/state
//    have the same single-company scoping problem as db.users itself.
// 4. users.fullName/users.phone: forced to null server-side whenever the account has a
//    linked employeeId (the employees row stays the single source of truth), only ever
//    stored directly when there's no employee link.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyAId: string;
let companyBId: string;
let superAdminId: string;
let scopedAdminId: string; // plain (non-super) admin, home company = A
let superAdminSessionId: string;
let scopedAdminSessionId: string;

let userInAId: string;
let userInBId: string;
let roleInBId: string;
let branchInBId: string;
let jobTitleBId: string;
let employeeBId: string;

async function login(username: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });
  const body = await res.json().catch(() => null);
  if (!body?.sessionId) throw new Error(`Login failed for ${username}: status ${res.status}, body ${JSON.stringify(body)}`);
  return body.sessionId;
}

async function apiSession(sessionId: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

beforeAll(async () => {
  companyAId = generateId();
  companyBId = generateId();
  await db.insert(schema.companies).values([
    {
      id: companyAId, name: 'StaffDirScoping Test Co A', address: 'x', phone: '0',
      email: 'staffdir-a@example.com', logoUrl: '', customHeader: '', customFooter: '',
      currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
    },
    {
      id: companyBId, name: 'StaffDirScoping Test Co B', address: 'x', phone: '0',
      email: 'staffdir-b@example.com', logoUrl: '', customHeader: '', customFooter: '',
      currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
    },
  ] as any);

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

  superAdminId = generateId();
  const superAdminUsername = `staffdir_super_${superAdminId}@example.com`;
  await db.insert(schema.users).values({
    id: superAdminId, username: superAdminUsername, email: superAdminUsername, password: passwordHash,
    role: 'admin', companyId: companyAId, isSuperAdmin: true, uiLanguage: 'en',
  });

  scopedAdminId = generateId();
  const scopedAdminUsername = `staffdir_admin_${scopedAdminId}@example.com`;
  await db.insert(schema.users).values({
    id: scopedAdminId, username: scopedAdminUsername, email: scopedAdminUsername, password: passwordHash,
    role: 'admin', companyId: companyAId, isSuperAdmin: false, uiLanguage: 'en',
  });

  superAdminSessionId = await login(superAdminUsername);
  scopedAdminSessionId = await login(scopedAdminUsername);

  userInAId = generateId();
  await db.insert(schema.users).values({
    id: userInAId, username: `staffdir_userA_${userInAId}@example.com`, email: `staffdir_userA_${userInAId}@example.com`,
    password: passwordHash, role: 'user', companyId: companyAId, isSuperAdmin: false, uiLanguage: 'en',
  });

  userInBId = generateId();
  await db.insert(schema.users).values({
    id: userInBId, username: `staffdir_userB_${userInBId}@example.com`, email: `staffdir_userB_${userInBId}@example.com`,
    password: passwordHash, role: 'user', companyId: companyBId, isSuperAdmin: false, uiLanguage: 'en',
  });

  roleInBId = generateId();
  await db.insert(schema.roles).values({ id: roleInBId, companyId: companyBId, name: 'StaffDir Test Role B', permissions: {} } as any);
  await db.insert(schema.userRoles).values({ userId: userInBId, roleId: roleInBId });

  branchInBId = generateId();
  await db.insert(schema.branches).values({ id: branchInBId, companyId: companyBId, name: 'StaffDir Test Branch B', code: 'SDB' } as any);
  await db.insert(schema.userBranches).values({ userId: userInBId, branchId: branchInBId, isPrimary: true });

  jobTitleBId = generateId();
  await db.insert(schema.jobTitles).values({ id: jobTitleBId, companyId: companyBId, title: 'StaffDir Test Title B' });
  employeeBId = generateId();
  await db.insert(schema.employees).values({
    id: employeeBId, companyId: companyBId, employeeNumber: 'SDB-001', name: 'Employee B One',
    jobTitleId: jobTitleBId, phone: '0599999999', isActive: true, createdAt: new Date(),
  });
});

afterAll(async () => {
  const allUserIds = [superAdminId, scopedAdminId, userInAId, userInBId].filter(Boolean);
  await db.delete(schema.userRoles).where(inArray(schema.userRoles.userId, allUserIds));
  await db.delete(schema.userBranches).where(inArray(schema.userBranches.userId, allUserIds));
  await db.delete(schema.auditLogs).where(inArray(schema.auditLogs.companyId, [companyAId, companyBId]));
  await db.delete(schema.users).where(inArray(schema.users.id, allUserIds));
  if (employeeBId) await db.delete(schema.employees).where(eq(schema.employees.id, employeeBId));
  if (jobTitleBId) await db.delete(schema.jobTitles).where(eq(schema.jobTitles.id, jobTitleBId));
  if (roleInBId) await db.delete(schema.roles).where(eq(schema.roles.id, roleInBId));
  if (branchInBId) await db.delete(schema.branches).where(eq(schema.branches.id, branchInBId));
  await db.delete(schema.companies).where(inArray(schema.companies.id, [companyAId, companyBId]));
});

describe('GET /api/users — directory scoping (issue #5 regression)', () => {
  it('a super-admin fetching a DIFFERENT company than their own home company gets that company\'s users', async () => {
    const res = await apiSession(superAdminSessionId, `/api/users?companyId=${companyBId}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((u: any) => u.id);
    expect(ids).toContain(userInBId);
    expect(ids).not.toContain(userInAId);
  });

  it('a super-admin fetching companyId=all gets users from every company', async () => {
    const res = await apiSession(superAdminSessionId, `/api/users?companyId=all`);
    expect(res.status).toBe(200);
    const ids = res.body.map((u: any) => u.id);
    expect(ids).toContain(userInAId);
    expect(ids).toContain(userInBId);
  });

  it('a non-super-admin cannot override companyId — always gets their own company only', async () => {
    const res = await apiSession(scopedAdminSessionId, `/api/users?companyId=${companyBId}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((u: any) => u.id);
    expect(ids).not.toContain(userInBId);
    expect(ids).toContain(userInAId);
  });

  it('never leaks a password hash', async () => {
    const res = await apiSession(superAdminSessionId, `/api/users?companyId=${companyBId}`);
    expect(res.status).toBe(200);
    for (const u of res.body) expect(u.password).toBeUndefined();
  });

  it('attaches roleIds/branchIds/primaryBranchId for a cross-company row (issue #6 regression)', async () => {
    const res = await apiSession(superAdminSessionId, `/api/users?companyId=${companyBId}`);
    expect(res.status).toBe(200);
    const row = res.body.find((u: any) => u.id === userInBId);
    expect(row).toBeTruthy();
    expect(row.roleIds).toEqual([roleInBId]);
    expect(row.branchIds).toEqual([branchInBId]);
    expect(row.primaryBranchId).toBe(branchInBId);
  });
});

describe('DELETE /api/users/:id — cross-company delete (was silently a no-op)', () => {
  it('lets a super-admin whose home company is A soft-delete a user that belongs to B', async () => {
    const res = await apiSession(superAdminSessionId, `/api/users/${userInBId}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, userInBId));
    expect(row.isDeleted).toBe(1);
    // Undo for the rest of the suite / afterAll's own bookkeeping.
    await db.update(schema.users).set({ isDeleted: 0 }).where(eq(schema.users.id, userInBId));
  });

  it('still rejects a non-super-admin deleting a user outside their own company', async () => {
    const res = await apiSession(scopedAdminSessionId, `/api/users/${userInBId}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, userInBId));
    expect(row.isDeleted).toBe(0);
  });
});

describe('users.fullName / users.phone — employee-link source-of-truth (new feature)', () => {
  it('stores fullName/phone directly when no employee is linked', async () => {
    const id = generateId();
    const email = `staffdir_noemp_${id}@example.com`;
    const res = await apiSession(superAdminSessionId, '/api/users', {
      method: 'POST',
      body: JSON.stringify({ id, email, password: 'AutoTest1', role: 'user', companyId: companyAId, fullName: 'No Employee Person', phone: '0511111111' }),
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, id));
    expect(row.fullName).toBe('No Employee Person');
    expect(row.phone).toBe('0511111111');
    await db.delete(schema.users).where(eq(schema.users.id, id));
  });

  it('forces fullName/phone to null when an employee is linked, even if the client sends values', async () => {
    const id = generateId();
    const email = `staffdir_withemp_${id}@example.com`;
    const res = await apiSession(superAdminSessionId, '/api/users', {
      method: 'POST',
      body: JSON.stringify({
        id, email, password: 'AutoTest1', role: 'user', companyId: companyBId,
        employeeId: employeeBId, fullName: 'Should Be Ignored', phone: '0522222222',
      }),
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, id));
    expect(row.employeeId).toBe(employeeBId);
    expect(row.fullName).toBeNull();
    expect(row.phone).toBeNull();
    await db.delete(schema.users).where(eq(schema.users.id, id));
  });
});
