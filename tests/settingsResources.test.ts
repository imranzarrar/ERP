import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server (npm run dev on
// localhost:3000) + real Postgres state, matching this project's established no-mocks
// testing practice (see tests/nonTransactionalSync.test.ts, tests/zatcaWorkflow.test.ts).
// Dedicated throwaway companies/users, torn down in afterAll — never touches the seeded
// demo companies used for manual QA.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyAId: string;
let companyBId: string;
let adminAUserId: string;
let adminASessionId: string;
let adminBUserId: string;
let adminBSessionId: string;
let superAdminUserId: string;
let superAdminSessionId: string;
let plainUserId: string;
let plainUserSessionId: string;

const createdTemplateIds: string[] = [];
const createdTranslationIds: string[] = [];

async function api(sessionId: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    // x-session-id is the documented non-cookie auth path for automated tests
    // (server.ts's isAuthenticated) — a plain fetch client has no cookie jar.
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
    { id: companyAId, name: 'Settings Test Co A', address: 'x', phone: '0', email: 'a-settings@example.com', logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive' },
    { id: companyBId, name: 'Settings Test Co B', address: 'x', phone: '0', email: 'b-settings@example.com', logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive' },
  ]);

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

  adminAUserId = generateId();
  const adminAUsername = `settingstest_adminA_${adminAUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({
    id: adminAUserId, username: adminAUsername, password: passwordHash,
    role: 'admin', companyId: companyAId, isSuperAdmin: false, uiLanguage: 'en',
  });

  adminBUserId = generateId();
  const adminBUsername = `settingstest_adminB_${adminBUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({
    id: adminBUserId, username: adminBUsername, password: passwordHash,
    role: 'admin', companyId: companyBId, isSuperAdmin: false, uiLanguage: 'en',
  });

  superAdminUserId = generateId();
  const superAdminUsername = `settingstest_super_${superAdminUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({
    id: superAdminUserId, username: superAdminUsername, password: passwordHash,
    role: 'super-admin', companyId: companyAId, isSuperAdmin: true, uiLanguage: 'en',
  });

  plainUserId = generateId();
  const plainUsername = `settingstest_plain_${plainUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({
    id: plainUserId, username: plainUsername, password: passwordHash,
    role: 'user', companyId: companyAId, isSuperAdmin: false, uiLanguage: 'en',
  });

  adminASessionId = await login(adminAUsername);
  adminBSessionId = await login(adminBUsername);
  superAdminSessionId = await login(superAdminUsername);
  plainUserSessionId = await login(plainUsername);
});

afterAll(async () => {
  for (const id of createdTemplateIds) {
    await db.delete(schema.documentTemplates).where(eq(schema.documentTemplates.id, id));
  }
  for (const id of createdTranslationIds) {
    await db.delete(schema.translations).where(eq(schema.translations.id, id));
  }
  // Login writes an audit_logs row referencing the user, so that must go first.
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, adminAUserId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, adminBUserId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, superAdminUserId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, plainUserId));
  await db.delete(schema.users).where(eq(schema.users.id, adminAUserId));
  await db.delete(schema.users).where(eq(schema.users.id, adminBUserId));
  await db.delete(schema.users).where(eq(schema.users.id, superAdminUserId));
  await db.delete(schema.users).where(eq(schema.users.id, plainUserId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyAId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyBId));
});

describe('Templates routes (server/routes/settingsResources.ts)', () => {
  it('rejects a non-admin user from creating a template', async () => {
    const { status } = await api(plainUserSessionId, '/api/templates', {
      method: 'POST',
      body: JSON.stringify({ name: 'Should Fail', language: 'English', pageSize: 'A4' }),
    });
    expect(status).toBe(403);
  });

  it('rejects a template with no name', async () => {
    const { status, body } = await api(adminASessionId, '/api/templates', {
      method: 'POST',
      body: JSON.stringify({ language: 'English', pageSize: 'A4' }),
    });
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();
  });

  it('creates a template scoped to the caller\'s company, server-assigning id/companyId', async () => {
    const { status, body } = await api(adminASessionId, '/api/templates', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Invoice Template A1',
        language: 'English',
        pageSize: '8.27in x 11.69in (A4)',
        isActive: false,
        printHeader: true, printFooter: true, printLogo: true, printQrCode: true,
        layoutJson: JSON.stringify([{ id: 'block1' }]),
      }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.id).toBeTruthy();
    createdTemplateIds.push(body.id);

    const [row] = await db.select().from(schema.documentTemplates).where(eq(schema.documentTemplates.id, body.id));
    expect(row).toBeTruthy();
    expect(row.companyId).toBe(companyAId);
    expect(row.name).toBe('Invoice Template A1');
    expect(row.layoutJson).toBe(JSON.stringify([{ id: 'block1' }]));
  });

  it('GET /api/templates only returns the caller\'s own company\'s templates', async () => {
    const { status, body } = await api(adminASessionId, '/api/templates');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.every((t: any) => t.companyId === companyAId)).toBe(true);
    expect(body.some((t: any) => t.id === createdTemplateIds[0])).toBe(true);

    const { body: bodyB } = await api(adminBSessionId, '/api/templates');
    expect(bodyB.some((t: any) => t.id === createdTemplateIds[0])).toBe(false);
  });

  it('PATCH toggles a single print option without touching other fields', async () => {
    const templateId = createdTemplateIds[0];
    const { status, body } = await api(adminASessionId, `/api/templates/${templateId}`, {
      method: 'PATCH',
      body: JSON.stringify({ printHeader: false }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [row] = await db.select().from(schema.documentTemplates).where(eq(schema.documentTemplates.id, templateId));
    expect(row.printHeader).toBe(false);
    expect(row.printFooter).toBe(true);
    expect(row.name).toBe('Invoice Template A1');
  });

  it('PATCH updates an arbitrary property (e.g. gridGapY / globalFontFamily)', async () => {
    const templateId = createdTemplateIds[0];
    const { status } = await api(adminASessionId, `/api/templates/${templateId}`, {
      method: 'PATCH',
      body: JSON.stringify({ gridGapY: 'loose', globalFontFamily: 'serif' }),
    });
    expect(status).toBe(200);

    const [row] = await db.select().from(schema.documentTemplates).where(eq(schema.documentTemplates.id, templateId));
    expect(row.gridGapY).toBe('loose');
    expect(row.globalFontFamily).toBe('serif');
  });

  it('PATCH persists Canvas Designer layoutJson', async () => {
    const templateId = createdTemplateIds[0];
    const newLayout = JSON.stringify([{ id: 'header', w: 12 }, { id: 'footer', w: 12 }]);
    const { status } = await api(adminASessionId, `/api/templates/${templateId}`, {
      method: 'PATCH',
      body: JSON.stringify({ layoutJson: newLayout }),
    });
    expect(status).toBe(200);

    const [row] = await db.select().from(schema.documentTemplates).where(eq(schema.documentTemplates.id, templateId));
    expect(row.layoutJson).toBe(newLayout);
  });

  it('rejects a cross-company PATCH (assertOwnsRow)', async () => {
    const templateId = createdTemplateIds[0];
    const { status } = await api(adminBSessionId, `/api/templates/${templateId}`, {
      method: 'PATCH',
      body: JSON.stringify({ printHeader: false }),
    });
    expect(status).toBe(403);
  });

  it('activating a template deactivates same-company/language siblings (unique_active_template)', async () => {
    // Second template, same company + language as the first.
    const { status: createStatus, body: createBody } = await api(adminASessionId, '/api/templates', {
      method: 'POST',
      body: JSON.stringify({ name: 'Invoice Template A2', language: 'English', pageSize: 'A4' }),
    });
    expect(createStatus).toBe(200);
    const secondId = createBody.id;
    createdTemplateIds.push(secondId);

    // Activate the first template.
    const { status: act1Status } = await api(adminASessionId, `/api/templates/${createdTemplateIds[0]}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: true }),
    });
    expect(act1Status).toBe(200);

    let [first] = await db.select().from(schema.documentTemplates).where(eq(schema.documentTemplates.id, createdTemplateIds[0]));
    expect(first.isActive).toBe(true);

    // Activating the second must flip the first back off (partial unique index would
    // otherwise reject two active rows for the same companyId+language).
    const { status: act2Status } = await api(adminASessionId, `/api/templates/${secondId}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: true }),
    });
    expect(act2Status).toBe(200);

    [first] = await db.select().from(schema.documentTemplates).where(eq(schema.documentTemplates.id, createdTemplateIds[0]));
    const [second] = await db.select().from(schema.documentTemplates).where(eq(schema.documentTemplates.id, secondId));
    expect(first.isActive).toBe(false);
    expect(second.isActive).toBe(true);
  });

  it('DELETE removes the row', async () => {
    const { status, body } = await api(adminASessionId, '/api/templates', {
      method: 'POST',
      body: JSON.stringify({ name: 'Temp Delete Me', language: 'Arabic', pageSize: 'A4' }),
    });
    expect(status).toBe(200);
    const id = body.id;

    const { status: delStatus } = await api(adminASessionId, `/api/templates/${id}`, { method: 'DELETE' });
    expect(delStatus).toBe(200);

    const rows = await db.select().from(schema.documentTemplates).where(eq(schema.documentTemplates.id, id));
    expect(rows.length).toBe(0);
  });
});

describe('Translations routes (server/routes/settingsResources.ts)', () => {
  it('rejects a company admin who is not a super-admin', async () => {
    const { status } = await api(adminASessionId, '/api/translations', {
      method: 'POST',
      body: JSON.stringify({ key: 'Should Fail', en: 'x', ar: 'x', ur: 'x' }),
    });
    expect(status).toBe(403);
  });

  it('super-admin creates a translation key, persisted per-key (no companyId column)', async () => {
    const { status, body } = await api(superAdminSessionId, '/api/translations', {
      method: 'POST',
      body: JSON.stringify({ key: `Settings Test Key ${Date.now()}`, en: 'Hello', ar: 'مرحبا', ur: 'ہیلو' }),
    });
    expect(status).toBe(200);
    expect(body.id).toBeTruthy();
    createdTranslationIds.push(body.id);

    const [row] = await db.select().from(schema.translations).where(eq(schema.translations.id, body.id));
    expect(row).toBeTruthy();
    expect(row.en).toBe('Hello');
    expect((row as any).companyId).toBeUndefined();
  });

  it('GET /api/translations lists rows for a super-admin', async () => {
    const { status, body } = await api(superAdminSessionId, '/api/translations');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((t: any) => t.id === createdTranslationIds[0])).toBe(true);
  });

  it('PATCH updates only the given fields on one key', async () => {
    const id = createdTranslationIds[0];
    const { status } = await api(superAdminSessionId, `/api/translations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ en: 'Hello Updated' }),
    });
    expect(status).toBe(200);

    const [row] = await db.select().from(schema.translations).where(eq(schema.translations.id, id));
    expect(row.en).toBe('Hello Updated');
    expect(row.ar).toBe('مرحبا');
  });

  it('PATCH on a non-existent id returns 404', async () => {
    const { status } = await api(superAdminSessionId, `/api/translations/${generateId()}`, {
      method: 'PATCH',
      body: JSON.stringify({ en: 'x' }),
    });
    expect(status).toBe(404);
  });

  it('bulk-upsert endpoint no longer exists (Translations tab edits are single-record only)', async () => {
    const { status } = await api(superAdminSessionId, '/api/translations/bulk-upsert', {
      method: 'POST',
      body: JSON.stringify({ translations: [] }),
    });
    expect(status).toBe(404);
  });

  it('DELETE removes a translation key', async () => {
    const { status, body } = await api(superAdminSessionId, '/api/translations', {
      method: 'POST',
      body: JSON.stringify({ key: 'Delete Me', en: 'x', ar: 'x', ur: 'x' }),
    });
    expect(status).toBe(200);
    const id = body.id;

    const { status: delStatus } = await api(superAdminSessionId, `/api/translations/${id}`, { method: 'DELETE' });
    expect(delStatus).toBe(200);

    const rows = await db.select().from(schema.translations).where(eq(schema.translations.id, id));
    expect(rows.length).toBe(0);
  });
});
