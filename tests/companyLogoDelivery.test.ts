import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// The company logo lives on companies.logo_url as a data: URL. /api/state must NOT carry it inline
// (a 1 MB logo was re-downloaded on every load and every post-save refresh); it carries a short
// versioned address, the bytes come from a public, immutable-cached endpoint, and no write path may
// ever overwrite the stored image with that address.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';
// 1x1 transparent PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const LOGO = `data:image/png;base64,${PNG_B64}`;

let companyId: string;
let userId: string;
let session: string;

const api = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', 'x-session-id': session, ...(init.headers || {}) } });
  return { res, body: await res.clone().json().catch(() => ({})) };
};
const storedLogo = async () => (await db.select({ l: schema.companies.logoUrl }).from(schema.companies).where(eq(schema.companies.id, companyId)))[0].l;
const stateLogo = async () => {
  const { body } = await api('/api/state');
  return (body.companies as any[]).find(c => c.id === companyId).logoUrl as string;
};

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: 'Logo Delivery Test Co', address: 'x', phone: '0', email: 'logodelivery@example.com',
    logoUrl: LOGO, customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
  } as any);
  userId = generateId();
  const username = `logo_${userId}`;
  await db.insert(schema.users).values({ id: userId, username, password: await bcrypt.hash(TEST_PASSWORD, 10), role: 'admin', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  const r = await fetch(`${BASE_URL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: TEST_PASSWORD }) });
  session = (await r.json()).sessionId;
});

afterAll(async () => {
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
  await db.delete(schema.users).where(eq(schema.users.id, userId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
});

describe('company logo delivery', () => {
  it('/api/state carries a short versioned address, not the image', async () => {
    const url = await stateLogo();
    const [path, query] = url.split('?');
    expect(path).toBe(`/api/public/company-logo/${companyId}`);
    expect(query).toMatch(/^v=[0-9a-f]{12}$/);
    expect(url.startsWith('data:')).toBe(false);
  });

  it('the address serves the exact bytes, publicly, with a one-year immutable cache', async () => {
    const url = await stateLogo();
    const res = await fetch(`${BASE_URL}${url}`); // no session header at all
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(PNG_B64, 'base64'))).toBe(true);
  });

  it('the version in the address changes when the logo changes', async () => {
    const before = await stateLogo();
    const other = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await db.update(schema.companies).set({ logoUrl: `data:image/png;base64,${other}` }).where(eq(schema.companies.id, companyId));
    const after = await stateLogo();
    expect(after).not.toBe(before);
    await db.update(schema.companies).set({ logoUrl: LOGO }).where(eq(schema.companies.id, companyId));
  });

  it('unknown or malformed ids give 404', async () => {
    expect((await fetch(`${BASE_URL}/api/public/company-logo/${generateId()}`)).status).toBe(404);
    expect((await fetch(`${BASE_URL}/api/public/company-logo/not-a-uuid`)).status).toBe(404);
  });

  it('a company without a logo yields 404 and no placeholder', async () => {
    await db.update(schema.companies).set({ logoUrl: '' }).where(eq(schema.companies.id, companyId));
    expect((await fetch(`${BASE_URL}/api/public/company-logo/${companyId}`)).status).toBe(404);
    expect(await stateLogo()).toBe('');
    await db.update(schema.companies).set({ logoUrl: LOGO }).where(eq(schema.companies.id, companyId));
  });

  it('saving company settings with the handed-out address does NOT overwrite the stored image', async () => {
    const url = await stateLogo();
    const { res } = await api(`/api/companies/${companyId}/settings`, { method: 'PATCH', body: JSON.stringify({ name: 'Logo Delivery Test Co', logoUrl: url }) });
    expect(res.status).toBe(200);
    expect(await storedLogo()).toBe(LOGO);
  });

  it('a real new logo through the same route IS stored', async () => {
    const other = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==`;
    const { res } = await api(`/api/companies/${companyId}/settings`, { method: 'PATCH', body: JSON.stringify({ logoUrl: other }) });
    expect(res.status).toBe(200);
    expect(await storedLogo()).toBe(other);
    await db.update(schema.companies).set({ logoUrl: LOGO }).where(eq(schema.companies.id, companyId));
  });

  it('the legacy /api/migrate blob handing back the address does NOT overwrite the stored image', async () => {
    const url = await stateLogo();
    await api('/api/migrate', { method: 'POST', body: JSON.stringify({ companies: [{ id: companyId, name: 'Logo Delivery Test Co', address: 'x', phone: '0', email: 'logodelivery@example.com', logoUrl: url, customHeader: '', customFooter: '', currency: 'SAR' }] }) });
    expect(await storedLogo()).toBe(LOGO);
  });
});
