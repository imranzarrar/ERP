import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq, inArray, like } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real HTTP against the running dev server + real Postgres. Covers the batched missing-key
// endpoint the browser now uses (one request for every missing key instead of one per key).
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';
const PREFIX = `zz batch key ${generateId().slice(0, 8)} `;

let companyId: string;
let userId: string;
let session: string;

async function post(body: any) {
  const res = await fetch(`${BASE_URL}/api/register-missing-keys`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-session-id': session }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: 'Translation Batch Test Co', address: 'x', phone: '0', email: 'tbatch@example.com',
    logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
  } as any);
  userId = generateId();
  const username = `tbatch_${userId}`;
  await db.insert(schema.users).values({ id: userId, username, password: await bcrypt.hash(TEST_PASSWORD, 10), role: 'admin', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  const res = await fetch(`${BASE_URL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: TEST_PASSWORD }) });
  session = (await res.json()).sessionId;
});

afterAll(async () => {
  await db.delete(schema.translations).where(like(schema.translations.key, `${PREFIX}%`));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
  await db.delete(schema.users).where(eq(schema.users.id, userId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
});

describe('POST /api/register-missing-keys (batched)', () => {
  it('registers many new keys in one request and skips ones that already exist', async () => {
    const keys = Array.from({ length: 30 }, (_, i) => `${PREFIX}${i}`);
    const first = await post({ keys });
    expect(first.status).toBe(200);
    expect(first.body.created).toBe(30);
    const rows = await db.select().from(schema.translations).where(inArray(schema.translations.key, keys));
    expect(rows).toHaveLength(30);
    expect(rows[0].en).toBe(rows[0].key);

    const again = await post({ keys: [...keys, `${PREFIX}new`] });
    expect(again.body.created).toBe(1); // only the one genuinely new key
  });

  it('caps a batch at 200 keys and ignores junk entries', async () => {
    const keys = Array.from({ length: 250 }, (_, i) => `${PREFIX}cap${i}`);
    const res = await post({ keys: [...keys, '', 42, null, 'x'.repeat(301)] });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(200);
  });

  it('rejects a non-array body', async () => {
    expect((await post({ keys: 'nope' })).status).toBe(400);
  });

  it('requires a logged-in session', async () => {
    const res = await fetch(`${BASE_URL}/api/register-missing-keys`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: [`${PREFIX}anon`] }) });
    expect(res.status).toBe(401);
  });
});
