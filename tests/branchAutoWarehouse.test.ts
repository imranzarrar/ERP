import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq, and } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server + real Postgres state, no
// mocks, matching this project's established convention. Covers auto-provisioning a
// matching warehouse when a brand-new branch is created (POST /api/branches): for most
// retail branches the selling floor IS the warehouse, so this removes what used to be a
// mandatory manual second step. Behavior: on a genuinely new branch, with no explicit
// defaultWarehouseId already chosen, and autoCreateWarehouse !== false (the default), a
// 'sales'-type warehouse is created mirroring the branch's own name/code, linked via
// branchId, and wired as the branch's own defaultWarehouseId — all in one transaction.
// Never fires on an edit to an existing branch, never overrides an explicitly-chosen
// defaultWarehouseId, and still respects the "company's very first warehouse becomes its
// default" rule identically to a manually-created warehouse.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let superAdminUserId: string;
let superAdminSessionId: string;
let existingWarehouseId: string; // pre-existing warehouse, used for the "explicit choice wins" case

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

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: 'Branch Auto Warehouse Test Co', address: 'x', phone: '0',
    email: 'branchautowh@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
  });

  // A pre-existing warehouse, unattached to any branch — used to prove an explicit
  // defaultWarehouseId choice at branch-creation time is never overridden.
  existingWarehouseId = generateId();
  await db.insert(schema.warehouses).values({
    id: existingWarehouseId, name: 'Central Warehouse', code: 'CENTRAL', isActive: true,
    companyId, type: 'sales',
  });

  superAdminUserId = generateId();
  const username = `branchautowh_super_${superAdminUserId}`;
  await db.insert(schema.users).values({ id: superAdminUserId, username, password: passwordHash, role: 'admin', companyId, isSuperAdmin: true, uiLanguage: 'en' });
  superAdminSessionId = await login(username);
});

afterAll(async () => {
  await db.update(schema.branches).set({ defaultWarehouseId: null }).where(eq(schema.branches.companyId, companyId));
  await db.delete(schema.warehouses).where(eq(schema.warehouses.companyId, companyId));
  await db.delete(schema.branches).where(eq(schema.branches.companyId, companyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
  await db.delete(schema.users).where(eq(schema.users.id, superAdminUserId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
});

describe('Auto-provisioning a matching warehouse on new branch creation', () => {
  it('creates a sales warehouse mirroring the branch\'s own name/code, wired as its default', async () => {
    const res = await api(superAdminSessionId, '/api/branches', {
      method: 'POST',
      body: JSON.stringify({ name: 'Riyadh Store', code: 'RUH1', isDefault: true }),
    });
    expect(res.status).toBe(200);
    expect(res.body.warehouseId).toBeTruthy();

    const [branch] = await db.select().from(schema.branches).where(eq(schema.branches.id, res.body.id));
    expect(branch.defaultWarehouseId).toBe(res.body.warehouseId);

    const [warehouse] = await db.select().from(schema.warehouses).where(eq(schema.warehouses.id, res.body.warehouseId));
    expect(warehouse.name).toBe('Riyadh Store');
    expect(warehouse.code).toBe('RUH1');
    expect(warehouse.type).toBe('sales');
    expect(warehouse.branchId).toBe(branch.id);
    expect(warehouse.companyId).toBe(companyId);
    // This is the company's very first warehouse (the pre-existing one in beforeAll
    // belongs to a DIFFERENT company's isolation... no wait, it's the SAME company —
    // see the next test for the actual "first warehouse" assertion, since the
    // pre-existing `existingWarehouseId` fixture warehouse means this one is NOT first.
    expect(warehouse.isCompanyDefault).toBe(false);
  });

  it('the very first warehouse ever for a company still auto-becomes the company default, even via this path', async () => {
    // A second, fully separate company with zero pre-existing warehouses, so the
    // auto-provisioned one really is its first.
    const freshCompanyId = generateId();
    await db.insert(schema.companies).values({
      id: freshCompanyId, name: 'Branch Auto Warehouse Fresh Co', address: 'x', phone: '0',
      email: 'branchautowhfresh@example.com', logoUrl: '', customHeader: '', customFooter: '',
      currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
    });
    const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
    const freshUserId = generateId();
    const freshUsername = `branchautowh_fresh_${freshUserId}`;
    await db.insert(schema.users).values({ id: freshUserId, username: freshUsername, password: passwordHash, role: 'admin', companyId: freshCompanyId, isSuperAdmin: true, uiLanguage: 'en' });
    const freshSessionId = await login(freshUsername);

    const res = await api(freshSessionId, '/api/branches', {
      method: 'POST',
      body: JSON.stringify({ name: 'First Branch', code: 'FB1' }),
    });
    expect(res.status).toBe(200);
    const [warehouse] = await db.select().from(schema.warehouses).where(eq(schema.warehouses.id, res.body.warehouseId));
    expect(warehouse.isCompanyDefault).toBe(true);

    // Cleanup this test's own isolated fixtures.
    await db.update(schema.branches).set({ defaultWarehouseId: null }).where(eq(schema.branches.companyId, freshCompanyId));
    await db.delete(schema.warehouses).where(eq(schema.warehouses.companyId, freshCompanyId));
    await db.delete(schema.branches).where(eq(schema.branches.companyId, freshCompanyId));
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, freshCompanyId));
    await db.delete(schema.users).where(eq(schema.users.id, freshUserId));
    await db.delete(schema.companies).where(eq(schema.companies.id, freshCompanyId));
  });

  it('never auto-creates when autoCreateWarehouse is explicitly false', async () => {
    const res = await api(superAdminSessionId, '/api/branches', {
      method: 'POST',
      body: JSON.stringify({ name: 'Jeddah Office', code: 'JED1', autoCreateWarehouse: false }),
    });
    expect(res.status).toBe(200);
    expect(res.body.warehouseId).toBeUndefined();
    const [branch] = await db.select().from(schema.branches).where(eq(schema.branches.id, res.body.id));
    expect(branch.defaultWarehouseId).toBeNull();
  });

  it('never overrides an explicitly-chosen defaultWarehouseId, even with autoCreateWarehouse left at its true default', async () => {
    const res = await api(superAdminSessionId, '/api/branches', {
      method: 'POST',
      body: JSON.stringify({ name: 'Dammam Kiosk', code: 'DMM1', defaultWarehouseId: existingWarehouseId }),
    });
    expect(res.status).toBe(200);
    expect(res.body.warehouseId).toBeUndefined(); // nothing new was created
    const [branch] = await db.select().from(schema.branches).where(eq(schema.branches.id, res.body.id));
    expect(branch.defaultWarehouseId).toBe(existingWarehouseId);
  });

  it('never fires on an edit to an existing branch', async () => {
    const createRes = await api(superAdminSessionId, '/api/branches', {
      method: 'POST',
      body: JSON.stringify({ name: 'Khobar Branch', code: 'KHB1', autoCreateWarehouse: false }),
    });
    expect(createRes.body.warehouseId).toBeUndefined();

    const editRes = await api(superAdminSessionId, '/api/branches', {
      method: 'POST',
      body: JSON.stringify({ id: createRes.body.id, name: 'Khobar Branch Updated', code: 'KHB1', autoCreateWarehouse: true }),
    });
    expect(editRes.status).toBe(200);
    expect(editRes.body.warehouseId).toBeUndefined();
    const [branch] = await db.select().from(schema.branches).where(eq(schema.branches.id, createRes.body.id));
    expect(branch.defaultWarehouseId).toBeNull();
    expect(branch.name).toBe('Khobar Branch Updated');
  });
});

describe('Deactivating a branch never touches its warehouse', () => {
  it('leaves the auto-created warehouse active after the branch is deactivated', async () => {
    const createRes = await api(superAdminSessionId, '/api/branches', {
      method: 'POST',
      body: JSON.stringify({ name: 'Closing Branch', code: 'CLS1' }),
    });
    const warehouseId = createRes.body.warehouseId;
    expect(warehouseId).toBeTruthy();

    const toggleRes = await api(superAdminSessionId, `/api/branches/${createRes.body.id}/toggle-active`, { method: 'PATCH' });
    expect(toggleRes.status).toBe(200);
    expect(toggleRes.body.isActive).toBe(false);

    const [warehouse] = await db.select().from(schema.warehouses).where(eq(schema.warehouses.id, warehouseId));
    expect(warehouse.isActive).toBe(true); // still active — so remaining stock can still be dispatched out
  });
});
