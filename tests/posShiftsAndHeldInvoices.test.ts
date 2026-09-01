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

let companyId: string;
let otherCompanyId: string;
let adminUserId: string;
let adminSessionId: string;
let restrictedUserId: string;
let restrictedSessionId: string;
let otherCompanyAdminUserId: string;
let otherCompanySessionId: string;
let customerId: string;

const createdShiftIds: string[] = [];
const createdHeldInvoiceIds: string[] = [];

async function api(sessionId: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    // The auth middleware accepts x-session-id as a documented non-cookie identity path
    // (server.ts's isAuthenticated) — a real Node fetch client has no cookie jar, so this
    // is the supported way to authenticate a server-side test client, not a workaround.
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
  companyId = generateId();
  otherCompanyId = generateId();
  await db.insert(schema.companies).values([
    { id: companyId, name: 'Pos Test Co', address: 'x', phone: '0', email: 'postest@example.com', logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false },
    { id: otherCompanyId, name: 'Pos Test Co Other', address: 'x', phone: '0', email: 'postestother@example.com', logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false },
  ]);

  customerId = generateId();
  await db.insert(schema.customers).values({
    id: customerId, name: 'Pos Test Customer', phone: '0', email: 'poscustomer@example.com', address: 'x', companyId, buyerType: 'B2B',
  });

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

  adminUserId = generateId();
  const adminUsername = `postest_admin_${adminUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({
    id: adminUserId, username: adminUsername, password: passwordHash,
    role: 'admin', companyId, isSuperAdmin: false, uiLanguage: 'en',
  });

  // No role assigned via userRoles -> resolveUserPermissions() returns null ->
  // normalizePermissions falls into its fail-closed default (everything disabled),
  // exercising this route's 403 path without needing extra Role fixture rows.
  restrictedUserId = generateId();
  const restrictedUsername = `postest_restricted_${restrictedUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({
    id: restrictedUserId, username: restrictedUsername, password: passwordHash,
    role: 'user', companyId, isSuperAdmin: false, uiLanguage: 'en',
  });

  otherCompanyAdminUserId = generateId();
  const otherUsername = `postest_other_${otherCompanyAdminUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({
    id: otherCompanyAdminUserId, username: otherUsername, password: passwordHash,
    role: 'admin', companyId: otherCompanyId, isSuperAdmin: false, uiLanguage: 'en',
  });

  adminSessionId = await login(adminUsername);
  restrictedSessionId = await login(restrictedUsername);
  otherCompanySessionId = await login(otherUsername);
});

afterAll(async () => {
  for (const id of createdHeldInvoiceIds) {
    await db.delete(schema.posHeldInvoices).where(eq(schema.posHeldInvoices.id, id));
  }
  for (const id of createdShiftIds) {
    await db.delete(schema.posHeldInvoices).where(eq(schema.posHeldInvoices.shiftId, id));
    await db.delete(schema.posShifts).where(eq(schema.posShifts.id, id));
  }
  // Login itself writes an audit_logs row referencing the user, so that must go first.
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, adminUserId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, restrictedUserId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, otherCompanyAdminUserId));
  await db.delete(schema.users).where(eq(schema.users.id, adminUserId));
  await db.delete(schema.users).where(eq(schema.users.id, restrictedUserId));
  await db.delete(schema.users).where(eq(schema.users.id, otherCompanyAdminUserId));
  await db.delete(schema.customers).where(eq(schema.customers.id, customerId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, otherCompanyId));
});

describe('POST/GET /api/pos/shifts', () => {
  it('opens a shift and persists it scoped to the caller\'s company', async () => {
    const shiftId = generateId();
    createdShiftIds.push(shiftId);
    const { status, body } = await api(adminSessionId, '/api/pos/shifts', {
      method: 'POST',
      body: JSON.stringify({
        id: shiftId,
        // Deliberately spoof a foreign companyId — the route must override this with
        // req.targetCompanyId, never trust the client's value.
        companyId: otherCompanyId,
        userId: adminUserId,
        startTime: new Date().toISOString(),
        startCash: 100,
        status: 'open',
      }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [row] = await db.select().from(schema.posShifts).where(eq(schema.posShifts.id, shiftId));
    expect(row).toBeTruthy();
    expect(row.companyId).toBe(companyId);
    expect(row.companyId).not.toBe(otherCompanyId);
    expect(Number(row.startCash)).toBe(100);
    expect(row.status).toBe('open');
  });

  it('lists only the caller\'s company shifts', async () => {
    const { status, body } = await api(adminSessionId, '/api/pos/shifts');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.every((s: any) => s.companyId === companyId)).toBe(true);
    expect(body.some((s: any) => s.id === createdShiftIds[0])).toBe(true);
  });

  it('rejects a caller without pos.access permission', async () => {
    const { status } = await api(restrictedSessionId, '/api/pos/shifts');
    expect(status).toBe(403);
  });

  it('rejects opening a shift without pos.shifts permission', async () => {
    const { status } = await api(restrictedSessionId, '/api/pos/shifts', {
      method: 'POST',
      body: JSON.stringify({ id: generateId(), userId: restrictedUserId, startTime: new Date().toISOString(), startCash: 0, status: 'open' }),
    });
    expect(status).toBe(403);
  });
});

describe('PUT /api/pos/shifts/:id', () => {
  it('closes a shift, recording actual/expected cash and variance inputs', async () => {
    const shiftId = createdShiftIds[0];
    const { status, body } = await api(adminSessionId, `/api/pos/shifts/${shiftId}`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'closed', endTime: new Date().toISOString(), endCash: 150, expectedCash: 140 }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [row] = await db.select().from(schema.posShifts).where(eq(schema.posShifts.id, shiftId));
    expect(row.status).toBe('closed');
    expect(Number(row.endCash)).toBe(150);
    expect(Number(row.expectedCash)).toBe(140);
  });

  it('does not let a different company close a shift it does not own', async () => {
    const shiftId = createdShiftIds[0];
    const { status } = await api(otherCompanySessionId, `/api/pos/shifts/${shiftId}`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'closed', endTime: new Date().toISOString(), endCash: 9999, expectedCash: 9999 }),
    });
    expect(status).toBe(404); // the route now checks existence+ownership explicitly and 404s, rather than silently no-oping a WHERE clause that matches 0 rows
    const [row] = await db.select().from(schema.posShifts).where(eq(schema.posShifts.id, shiftId));
    expect(Number(row.endCash)).toBe(150); // unchanged from the previous test
  });

  it('rejects closing a shift without pos.shifts permission', async () => {
    const { status } = await api(restrictedSessionId, `/api/pos/shifts/${createdShiftIds[0]}`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'closed' }),
    });
    expect(status).toBe(403);
  });
});

describe('POST/GET/DELETE /api/pos/held-invoices', () => {
  it('holds an invoice and persists it scoped to the caller\'s company', async () => {
    const heldId = generateId();
    createdHeldInvoiceIds.push(heldId);
    const { status, body } = await api(adminSessionId, '/api/pos/held-invoices', {
      method: 'POST',
      body: JSON.stringify({
        id: heldId,
        shiftId: createdShiftIds[0],
        // Deliberately spoof a foreign companyId, same as the shifts test above.
        companyId: otherCompanyId,
        customerId,
        items: [{ productId: 'p1', productName: 'Widget', quantity: 2, unitPrice: 10, discount: 0, total: 20 }],
        createdAt: new Date().toISOString(),
        reference: 'POS-HOLD-TEST-1',
      }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [row] = await db.select().from(schema.posHeldInvoices).where(eq(schema.posHeldInvoices.id, heldId));
    expect(row).toBeTruthy();
    expect(row.companyId).toBe(companyId);
    expect(row.companyId).not.toBe(otherCompanyId);
    expect(row.reference).toBe('POS-HOLD-TEST-1');
    expect((row.items as any[]).length).toBe(1);
  });

  it('lists only the caller\'s company held invoices', async () => {
    const { status, body } = await api(adminSessionId, '/api/pos/held-invoices');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.every((h: any) => h.companyId === companyId)).toBe(true);
    expect(body.some((h: any) => h.id === createdHeldInvoiceIds[0])).toBe(true);
  });

  it('rejects listing held invoices without pos.access permission', async () => {
    const { status } = await api(restrictedSessionId, '/api/pos/held-invoices');
    expect(status).toBe(403);
  });

  it('does not let a different company delete (resume) a held invoice it does not own', async () => {
    const heldId = createdHeldInvoiceIds[0];
    const { status } = await api(otherCompanySessionId, `/api/pos/held-invoices/${heldId}`, { method: 'DELETE' });
    expect(status).toBe(404); // the route now checks existence+ownership explicitly and 404s, rather than silently no-oping a WHERE clause that matches 0 rows
    const [row] = await db.select().from(schema.posHeldInvoices).where(eq(schema.posHeldInvoices.id, heldId));
    expect(row).toBeTruthy(); // still present — the foreign-company delete was rejected, not silently ignored
  });

  it('rejects deleting (resuming) a held invoice without pos.access permission', async () => {
    const { status } = await api(restrictedSessionId, `/api/pos/held-invoices/${createdHeldInvoiceIds[0]}`, { method: 'DELETE' });
    expect(status).toBe(403);
  });

  it('resumes (deletes) a held invoice for the owning company', async () => {
    const heldId = createdHeldInvoiceIds[0];
    const { status, body } = await api(adminSessionId, `/api/pos/held-invoices/${heldId}`, { method: 'DELETE' });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [row] = await db.select().from(schema.posHeldInvoices).where(eq(schema.posHeldInvoices.id, heldId));
    expect(row).toBeFalsy();
  });
});
