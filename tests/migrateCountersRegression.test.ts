import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Regression test for BACKLOG item 65: the legacy blob-sync endpoint (POST /api/migrate,
// src/db/migrateData.ts) used to include `counters` in its blind onConflictDoUpdate
// overwrite of the `companies` row. Any stale browser tab syncing an unrelated change
// (e.g. editing a customer) would carry an old, since-superseded `counters` snapshot and
// silently roll the shared document-number counter backward - the real root cause of
// duplicate invoiceNumber rows found live on CNC Woodcraft & Design (INV-1005/1006/1007
// each existed twice). Document numbering itself is correctly row-locked
// (getAndIncrementCounter in server/lib/businessLogic.ts) - this test proves the *other*
// write path can no longer clobber that state out of band.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let adminId: string;
let adminUsername: string;

async function login(username: string): Promise<{ sessionId: string }> {
  const res = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });
  const body = await res.json().catch(() => null);
  if (!body?.sessionId) throw new Error(`Login failed for ${username}: status ${res.status}, body ${JSON.stringify(body)}`);
  return { sessionId: body.sessionId };
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
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: 'MigrateCounters Test Co', address: 'x', phone: '0',
    email: 'migratecounters-test@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: { invoice: 1005 }, zatcaEnabled: false, themeId: 'classic-executive',
  } as any);

  adminId = generateId();
  adminUsername = `migratecounters_admin_${adminId.slice(0, 8)}`;
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  await db.insert(schema.users).values({
    id: adminId, username: adminUsername, password: passwordHash,
    role: 'admin', companyId, isSuperAdmin: false, uiLanguage: 'en',
  });
});

afterAll(async () => {
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
  await db.delete(schema.users).where(eq(schema.users.id, adminId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
});

describe('POST /api/migrate must never roll back a company\'s document-number counters', () => {
  it('a stale client counters snapshot sent via the generic sync path is ignored, not written', async () => {
    const { sessionId } = await login(adminUsername);

    // Simulate the real DB state having moved on past the client's stale in-memory
    // snapshot - e.g. an invoice was created elsewhere, advancing invoice: 1005 -> 1008.
    await db.update(schema.companies).set({ counters: { invoice: 1008 } }).where(eq(schema.companies.id, companyId));

    // A stale tab now syncs an unrelated change (its full blob still carries the OLD
    // counters: 1005 it loaded at page-load time, before the advance above happened).
    const staleCompanyBlob = {
      id: companyId,
      name: 'MigrateCounters Test Co',
      address: 'x', phone: '0', email: 'migratecounters-test@example.com',
      logoUrl: '', customHeader: '', customFooter: '',
      currency: 'SAR', themeId: 'classic-executive',
      counters: { invoice: 1005 }, // stale - this is the value that used to win
    };
    const res = await apiSession(sessionId, '/api/migrate', {
      method: 'POST',
      body: JSON.stringify({ companies: [staleCompanyBlob] }),
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));
    expect((row.counters as any).invoice).toBe(1008);
  });

  it('other company fields are still updated by the same sync call (only counters is excluded)', async () => {
    const { sessionId } = await login(adminUsername);

    const res = await apiSession(sessionId, '/api/migrate', {
      method: 'POST',
      body: JSON.stringify({
        companies: [{
          id: companyId,
          name: 'MigrateCounters Test Co - renamed',
          address: 'x', phone: '0', email: 'migratecounters-test@example.com',
          logoUrl: '', customHeader: '', customFooter: '',
          currency: 'SAR', themeId: 'classic-executive',
          counters: { invoice: 9999 },
        }],
      }),
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));
    expect(row.name).toBe('MigrateCounters Test Co - renamed');
    expect((row.counters as any).invoice).toBe(1008); // untouched, still not 9999
  });
});
