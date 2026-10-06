// Creates a fresh, empty test company with one admin user in the LOCAL development database, for driving the real screens by hand.
// The login is written to ux-test.credentials.local (git-ignored: *.local), never printed. Local development only.
//
//   npx tsx scripts/create-ux-test-company.ts "UX Test Co"
import fs from 'node:fs';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { provisionStarterResources } from '../server/lib/companyProvisioning.js';

const host = process.env.SQL_HOST || '';
if (host && !['localhost', '127.0.0.1', '::1'].includes(host)) { console.error('Refusing: this only runs against a local database.'); process.exit(1); }

const name = process.argv[2] || 'UX Test Co';
const companyId = generateId();
const userId = generateId();
const username = `ux_${userId.slice(-8)}`;
const password = crypto.randomBytes(9).toString('base64url') + 'aA1!';

await db.insert(schema.companies).values({
  id: companyId, name, address: 'Test Street', phone: '0500000000', email: 'ux@example.com', logoUrl: '', customHeader: '', customFooter: '',
  currency: 'SAR', counters: {}, zatcaEnabled: false, inventorySettings: { prOptionality: 'OPTIONAL', isDsdAllowed: true }, isInventoryModuleEnabled: true,
} as any);
await db.transaction(async (tx: any) => provisionStarterResources(tx, { companyId, companyName: name }));
await db.insert(schema.users).values({ id: userId, username, password: await bcrypt.hash(password, 10), role: 'admin', companyId, isSuperAdmin: false });
fs.writeFileSync('ux-test.credentials.local', JSON.stringify({ company: name, companyId, username, password }, null, 2));
console.log(`Created "${name}" (${companyId}). Login saved to ux-test.credentials.local`);
process.exit(0);
