import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server (npm run dev on
// localhost:3000) + real Postgres state, matching this project's established
// no-mocks testing practice. Dedicated throwaway company/users, torn down in afterAll —
// never touches the seeded demo companies used for manual QA. Covers the AdminSettings
// Company/Banks/Tax Slabs/Investor handlers migrated off the generic /api/migrate blob
// sync onto dedicated per-record routes.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyAId: string;
let companyBId: string;
let ownerUserId: string;
let ownerSessionId: string;
let otherCompanyUserId: string;
let otherCompanySessionId: string;

let fixtureBankId: string;
let fixtureTaxSlabId: string;

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
  companyAId = generateId();
  companyBId = generateId();
  await db.insert(schema.companies).values([
    {
      id: companyAId, name: 'AdminSettings Test Co A', address: 'x', phone: '0',
      email: 'a@example.com', logoUrl: '', customHeader: '', customFooter: '',
      currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
      isInventoryModuleEnabled: false,
    },
    {
      id: companyBId, name: 'AdminSettings Test Co B', address: 'x', phone: '0',
      email: 'b@example.com', logoUrl: '', customHeader: '', customFooter: '',
      currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
    },
  ]);

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

  ownerUserId = generateId();
  const ownerUsername = `adminsettings_owner_${ownerUserId}`;
  await db.insert(schema.users).values({
    id: ownerUserId, username: ownerUsername, password: passwordHash,
    role: 'admin', companyId: companyAId, isSuperAdmin: false, uiLanguage: 'en',
  });

  otherCompanyUserId = generateId();
  const otherUsername = `adminsettings_other_${otherCompanyUserId}`;
  await db.insert(schema.users).values({
    id: otherCompanyUserId, username: otherUsername, password: passwordHash,
    role: 'admin', companyId: companyBId, isSuperAdmin: false, uiLanguage: 'en',
  });

  ownerSessionId = await login(ownerUsername);
  otherCompanySessionId = await login(otherUsername);

  // A pre-existing default bank + default tax slab for company A, so the "clear other
  // defaults" behavior of the routes under test has something real to clear.
  fixtureBankId = generateId();
  await db.insert(schema.bankAccounts).values({
    id: fixtureBankId, bankName: 'Fixture Bank', accountNumber: '1111',
    accountTitle: 'Fixture Holder', openingBalance: '1000', isActive: true,
    isDefault: true, companyId: companyAId,
  });

  fixtureTaxSlabId = generateId();
  await db.insert(schema.taxSlabs).values({
    id: fixtureTaxSlabId, name: 'Fixture 15%', percentage: '15',
    companyId: companyAId, isDefault: true,
  });
});

afterAll(async () => {
  // Login itself writes an audit_logs row referencing the user, so that must go first;
  // company-scoped rows must go before the companies row they reference.
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, ownerUserId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, otherCompanyUserId));
  await db.delete(schema.investors).where(eq(schema.investors.companyId, companyAId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyAId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyAId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  await db.delete(schema.users).where(eq(schema.users.id, otherCompanyUserId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyAId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyBId));
});

describe('PATCH /api/companies/:id/settings', () => {
  it('updates the company profile fields for the caller\'s own company', async () => {
    const { status, body } = await api(ownerSessionId, `/api/companies/${companyAId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Renamed Co A', vatNumber: '300000000000003', portalTitle: 'My Portal' }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [row] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyAId));
    expect(row.name).toBe('Renamed Co A');
    expect(row.vatNumber).toBe('300000000000003');
    expect(row.portalTitle).toBe('My Portal');
    // Untouched field should be unaffected.
    expect(row.email).toBe('a@example.com');
  });

  it('updates the inventory module toggle and settings blob', async () => {
    const { status } = await api(ownerSessionId, `/api/companies/${companyAId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ isInventoryModuleEnabled: true, inventorySettings: { prOptionality: 'MANDATORY', isDsdAllowed: false } }),
    });
    expect(status).toBe(200);

    const [row] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyAId));
    expect(row.isInventoryModuleEnabled).toBe(true);
    expect(row.inventorySettings).toEqual({ prOptionality: 'MANDATORY', isDsdAllowed: false });
  });

  it('updates the ZATCA master switch', async () => {
    const { status } = await api(ownerSessionId, `/api/companies/${companyAId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ zatcaEnabled: true }),
    });
    expect(status).toBe(200);

    const [row] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyAId));
    expect(row.zatcaEnabled).toBe(true);
  });

  it('rejects a caller updating a different company\'s settings', async () => {
    const { status } = await api(otherCompanySessionId, `/api/companies/${companyAId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Hacked' }),
    });
    expect(status).toBe(403);

    const [row] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyAId));
    expect(row.name).not.toBe('Hacked');
  });

  it('rejects a request with no recognized fields', async () => {
    const { status } = await api(ownerSessionId, `/api/companies/${companyAId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ counters: { invoice: 9999 } }),
    });
    expect(status).toBe(400);
  });
});

describe('POST /api/banks', () => {
  it('creates a bank scoped to the caller\'s company', async () => {
    const newId = generateId();
    const { status, body } = await api(ownerSessionId, '/api/banks', {
      method: 'POST',
      body: JSON.stringify({
        id: newId, bankName: 'New Bank', accountNumber: '2222', accountTitle: 'New Holder',
        openingBalance: 500, isActive: true, isDefault: false,
      }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [row] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, newId));
    expect(row.companyId).toBe(companyAId);
    expect(row.bankName).toBe('New Bank');
    expect(row.isDefault).toBe(false);

    // Fixture bank should still be the default — untouched.
    const [fixture] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, fixtureBankId));
    expect(fixture.isDefault).toBe(true);

    await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.id, newId));
  });

  it('creating a new default bank clears the previous default atomically', async () => {
    const newId = generateId();
    const { status } = await api(ownerSessionId, '/api/banks', {
      method: 'POST',
      body: JSON.stringify({
        id: newId, bankName: 'New Default Bank', accountNumber: '3333', accountTitle: 'Default Holder',
        openingBalance: 0, isActive: true, isDefault: true,
      }),
    });
    expect(status).toBe(200);

    const [newRow] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, newId));
    expect(newRow.isDefault).toBe(true);

    const [fixture] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, fixtureBankId));
    expect(fixture.isDefault).toBe(false);

    // Restore fixture as default for subsequent tests.
    await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.id, newId));
    await db.update(schema.bankAccounts).set({ isDefault: true }).where(eq(schema.bankAccounts.id, fixtureBankId));
  });
});

describe('PATCH /api/banks/:id', () => {
  it('updates an existing bank\'s editable fields', async () => {
    const { status, body } = await api(ownerSessionId, `/api/banks/${fixtureBankId}`, {
      method: 'PATCH',
      body: JSON.stringify({ bankName: 'Renamed Fixture Bank', accountTitle: 'Renamed Holder' }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [row] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, fixtureBankId));
    expect(row.bankName).toBe('Renamed Fixture Bank');
    expect(row.accountTitle).toBe('Renamed Holder');
  });

  it('rejects a caller editing a bank owned by another company', async () => {
    const { status } = await api(otherCompanySessionId, `/api/banks/${fixtureBankId}`, {
      method: 'PATCH',
      body: JSON.stringify({ bankName: 'Hacked' }),
    });
    expect(status).toBe(403);
  });

  it('returns 404 for a nonexistent bank', async () => {
    const { status } = await api(ownerSessionId, `/api/banks/${generateId()}`, {
      method: 'PATCH',
      body: JSON.stringify({ bankName: 'X' }),
    });
    expect(status).toBe(404);
  });
});

describe('PATCH /api/banks/:id/set-default and /toggle-active', () => {
  it('cannot deactivate the current default bank', async () => {
    const { status, body } = await api(ownerSessionId, `/api/banks/${fixtureBankId}/toggle-active`, {
      method: 'PATCH',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/default/i);

    const [row] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, fixtureBankId));
    expect(row.isActive).toBe(true);
  });

  it('sets a different bank as default, clearing the previous one', async () => {
    const secondBankId = generateId();
    await db.insert(schema.bankAccounts).values({
      id: secondBankId, bankName: 'Second Bank', accountNumber: '4444', accountTitle: 'Second Holder',
      openingBalance: '0', isActive: true, isDefault: false, companyId: companyAId,
    });

    const { status } = await api(ownerSessionId, `/api/banks/${secondBankId}/set-default`, { method: 'PATCH' });
    expect(status).toBe(200);

    const [second] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, secondBankId));
    const [fixture] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, fixtureBankId));
    expect(second.isDefault).toBe(true);
    expect(fixture.isDefault).toBe(false);

    // Now that the fixture bank is no longer default, it can be deactivated then
    // reactivated to prove toggle-active works both directions.
    const toggleOff = await api(ownerSessionId, `/api/banks/${fixtureBankId}/toggle-active`, { method: 'PATCH' });
    expect(toggleOff.status).toBe(200);
    let [refetched] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, fixtureBankId));
    expect(refetched.isActive).toBe(false);

    const toggleOn = await api(ownerSessionId, `/api/banks/${fixtureBankId}/toggle-active`, { method: 'PATCH' });
    expect(toggleOn.status).toBe(200);
    [refetched] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, fixtureBankId));
    expect(refetched.isActive).toBe(true);

    // Restore fixture bank as the default for subsequent tests. secondBankId's default
    // must be cleared/removed FIRST — unique_default_bank allows only one default per
    // company at a time, so setting the fixture back to true while secondBankId is still
    // true would violate the constraint.
    await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.id, secondBankId));
    await db.update(schema.bankAccounts).set({ isDefault: true }).where(eq(schema.bankAccounts.id, fixtureBankId));
  });

  it('rejects a caller setting a different company\'s bank as default', async () => {
    const { status } = await api(otherCompanySessionId, `/api/banks/${fixtureBankId}/set-default`, { method: 'PATCH' });
    expect(status).toBe(403);
  });
});

describe('POST /api/tax-slabs', () => {
  it('creating a new default tax slab clears the previous default atomically', async () => {
    const newId = generateId();
    const { status } = await api(ownerSessionId, '/api/tax-slabs', {
      method: 'POST',
      body: JSON.stringify({ id: newId, name: 'New Default 5%', percentage: 5, companyId: companyAId, isDefault: true }),
    });
    expect(status).toBe(200);

    const [newRow] = await db.select().from(schema.taxSlabs).where(eq(schema.taxSlabs.id, newId));
    const [fixture] = await db.select().from(schema.taxSlabs).where(eq(schema.taxSlabs.id, fixtureTaxSlabId));
    expect(newRow.isDefault).toBe(true);
    expect(fixture.isDefault).toBe(false);

    // Restore fixture as default.
    await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.id, newId));
    await db.update(schema.taxSlabs).set({ isDefault: true }).where(eq(schema.taxSlabs.id, fixtureTaxSlabId));
  });
});

describe('PATCH /api/tax-slabs/:id/set-default', () => {
  it('flips default to a different row already owned by the company', async () => {
    const secondSlabId = generateId();
    await db.insert(schema.taxSlabs).values({
      id: secondSlabId, name: 'Second Slab 0%', percentage: '0', companyId: companyAId, isDefault: false,
    });

    const { status } = await api(ownerSessionId, `/api/tax-slabs/${secondSlabId}/set-default`, { method: 'PATCH' });
    expect(status).toBe(200);

    const [second] = await db.select().from(schema.taxSlabs).where(eq(schema.taxSlabs.id, secondSlabId));
    const [fixture] = await db.select().from(schema.taxSlabs).where(eq(schema.taxSlabs.id, fixtureTaxSlabId));
    expect(second.isDefault).toBe(true);
    expect(fixture.isDefault).toBe(false);

    // Restore fixture as default for cleanliness. secondSlabId must be removed FIRST —
    // unique_default_tax_slab allows only one default per company at a time.
    await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.id, secondSlabId));
    await db.update(schema.taxSlabs).set({ isDefault: true }).where(eq(schema.taxSlabs.id, fixtureTaxSlabId));
  });

  it('rejects a caller setting a default on a tax slab owned by another company', async () => {
    const { status } = await api(otherCompanySessionId, `/api/tax-slabs/${fixtureTaxSlabId}/set-default`, { method: 'PATCH' });
    expect(status).toBe(403);
  });

  it('returns 404 for a nonexistent tax slab', async () => {
    const { status } = await api(ownerSessionId, `/api/tax-slabs/${generateId()}/set-default`, { method: 'PATCH' });
    expect(status).toBe(404);
  });
});

describe('POST /api/transactions/investors', () => {
  it('creates an investor scoped to the caller\'s company', async () => {
    const newId = generateId();
    const { status, body } = await api(ownerSessionId, '/api/transactions/investors', {
      method: 'POST',
      body: JSON.stringify({
        id: newId, name: 'Test Investor', email: 'investor@example.com', phone: '5550000',
        equityPercentage: 20, profitPercentage: 25, capitalContributed: 0, isActive: true,
        createdAt: new Date().toISOString(), companyId: companyAId,
      }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [row] = await db.select().from(schema.investors).where(eq(schema.investors.id, newId));
    expect(row.companyId).toBe(companyAId);
    expect(row.name).toBe('Test Investor');
    expect(Number(row.equityPercentage)).toBe(20);
    expect(Number(row.profitPercentage)).toBe(25);
    expect(Number(row.capitalContributed)).toBe(0);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await fetch(`${BASE_URL}/api/transactions/investors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: generateId(), name: 'No Session', companyId: companyAId }),
    });
    expect([401, 403]).toContain(res.status);
  });
});
