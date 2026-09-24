import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import * as XLSX from 'xlsx';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real HTTP against the running dev server + real Postgres — no mocks, matching this
// project's testing convention. Covers Customer Master + Vendor Master bulk import
// (server/lib/partyImport.ts, server/routes/masterImport.ts): the SAME validateBuyerFields
// rules POST /customers and POST /vendors already enforce, blank Buyer Type defaulting to
// B2C (matching the single-row form), and the matching rule — VAT is authoritative (a VAT
// match always updates, regardless of phone); when VAT does NOT match, a phone match against
// a DIFFERENT existing party is a conflict (rejected, never silently updated), not a fallback
// update target. Both entities share one implementation, so this file runs the same suite
// against both /master-import/customers/* and /master-import/vendors/*.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

const VALID_VAT_1 = '300012345600003';
const VALID_VAT_2 = '300098765400003';
const VALID_VAT_3 = '300011122200003';

async function login(username: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });
  const body = await res.json().catch(() => null);
  if (!body?.sessionId) throw new Error(`Login failed for ${username}: ${JSON.stringify(body)}`);
  return body.sessionId;
}

const HEADERS = ['Name', 'Buyer Type', 'VAT Number', 'Street Name', 'Building Number', 'District', 'City', 'Postal Code', 'Phone', 'Email', 'CR Number', 'Country Code'];

function buildXlsx(rows: (string | number)[][]): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([HEADERS, ...rows]);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

async function postFile(sessionId: string, path: string, buf: Buffer, extra?: Record<string, string>) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'import.xlsx');
  if (extra) for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  const res = await fetch(`${BASE_URL}${path}`, { method: 'POST', headers: { 'x-session-id': sessionId }, body: fd });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

let companyId: string;
let otherCompanyId: string;
let adminUserId: string;
let adminSession: string;
let noPermUserId: string;
let noPermSession: string;

beforeAll(async () => {
  companyId = generateId();
  otherCompanyId = generateId();
  await db.insert(schema.companies).values([
    { id: companyId, name: 'Party Import Test Co', address: 'x', phone: '0', email: 'pjimport@example.com', logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive' },
    { id: otherCompanyId, name: 'Party Import Other Co', address: 'x', phone: '0', email: 'pjimport-other@example.com', logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive' },
  ] as any);

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  adminUserId = generateId();
  const adminUsername = `pjimport_admin_${adminUserId}`;
  await db.insert(schema.users).values({ id: adminUserId, username: adminUsername, password: passwordHash, role: 'admin', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  adminSession = await login(adminUsername);

  noPermUserId = generateId();
  const noPermUsername = `pjimport_noperm_${noPermUserId}`;
  await db.insert(schema.users).values({ id: noPermUserId, username: noPermUsername, password: passwordHash, role: 'staff', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  noPermSession = await login(noPermUsername);
});

afterAll(async () => {
  await db.delete(schema.customers).where(eq(schema.customers.companyId, companyId));
  await db.delete(schema.vendors).where(eq(schema.vendors.companyId, companyId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, otherCompanyId));
  await db.delete(schema.vendors).where(eq(schema.vendors.companyId, otherCompanyId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, adminUserId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, noPermUserId));
  await db.delete(schema.users).where(eq(schema.users.id, adminUserId));
  await db.delete(schema.users).where(eq(schema.users.id, noPermUserId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, otherCompanyId));
});

for (const entity of ['customers', 'vendors'] as const) {
  const table = entity === 'customers' ? schema.customers : schema.vendors;
  const singularLabel = entity === 'customers' ? 'customer' : 'vendor';

  describe(`${entity} bulk import`, () => {
    it('GET template returns the expected headers and is permission-gated', async () => {
      const ok = await fetch(`${BASE_URL}/api/master-import/${entity}/template`, { headers: { 'x-session-id': adminSession } });
      expect(ok.status).toBe(200);
      const wb = XLSX.read(Buffer.from(await ok.arrayBuffer()), { type: 'buffer' });
      const rows: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
      expect(rows[0]).toEqual(HEADERS);

      const denied = await fetch(`${BASE_URL}/api/master-import/${entity}/template`, { headers: { 'x-session-id': noPermSession } });
      expect(denied.status).toBe(403);
    });

    it('missing name errors; blank Buyer Type defaults to B2C and only needs a name', async () => {
      const buf = buildXlsx([
        ['', '', '', '', '', '', '', '', '0500000000', '', '', ''], // blank name, but not a fully-blank row (would otherwise be skipped)
        [`${singularLabel} B2C Minimal`, '', '', '', '', '', '', '', '', '', '', ''],
      ]);
      const { body } = await postFile(adminSession, `/api/master-import/${entity}/validate`, buf);
      expect(body.rows[0].action).toBe('error');
      expect(body.rows[0].errors.join(' ')).toMatch(/Name is required/);
      expect(body.rows[1].action).toBe('create');
      expect(body.rows[1].errors).toEqual([]);
    });

    it('B2B requires VAT + full address; invalid VAT format errors', async () => {
      const buf = buildXlsx([
        [`${singularLabel} B2B Incomplete`, 'B2B', '', '', '', '', '', '', '', '', '', ''],
        [`${singularLabel} B2B Bad VAT`, 'B2B', '12345', 'St', '1', 'D', 'City', '12345', '', '', '', ''],
      ]);
      const { body } = await postFile(adminSession, `/api/master-import/${entity}/validate`, buf);
      expect(body.rows[0].action).toBe('error');
      expect(body.rows[0].errors.join(' ')).toMatch(/VAT number must be exactly 15 digits/);
      expect(body.rows[1].action).toBe('error');
      expect(body.rows[1].errors.join(' ')).toMatch(/VAT number must be exactly 15 digits/);
    });

    it('an unrecognized Buyer Type errors', async () => {
      const buf = buildXlsx([[`${singularLabel} Bad Type`, 'B2Z', '', '', '', '', '', '', '', '', '', '']]);
      const { body } = await postFile(adminSession, `/api/master-import/${entity}/validate`, buf);
      expect(body.rows[0].errors.join(' ')).toMatch(/Buyer Type must be/);
    });

    it('creates a valid B2B row with a real code and composed address', async () => {
      const buf = buildXlsx([[`${singularLabel} Commit B2B`, 'B2B', VALID_VAT_1, 'King Fahd Rd', '3045', 'Al Olaya', 'Riyadh', '12871', '0501234567', 'x@example.com', '', 'SA']]);
      const { body } = await postFile(adminSession, `/api/master-import/${entity}/commit`, buf);
      expect(body.summary).toEqual({ created: 1, updated: 0, skipped: 0 });
      const [row]: any[] = await db.select().from(table).where(eq((table as any).name, `${singularLabel} Commit B2B`));
      expect(row).toBeTruthy();
      expect(row[entity === 'customers' ? 'customerCode' : 'vendorCode']).toBeTruthy();
      expect(row.address).toMatch(/3045 King Fahd Rd/);
      expect(row.address).toMatch(/12871/);
    });

    it('a second upload with the SAME VAT updates the existing record, regardless of phone', async () => {
      const first = buildXlsx([[`${singularLabel} VAT Match A`, 'B2B', VALID_VAT_2, 'St', '1', 'D', 'City', '11111', '0501111111', '', '', 'SA']]);
      const r1 = await postFile(adminSession, `/api/master-import/${entity}/commit`, first);
      expect(r1.body.summary.created).toBe(1);

      // Same VAT, DIFFERENT phone and name — must still be treated as the same party (update).
      const second = buildXlsx([[`${singularLabel} VAT Match A Renamed`, 'B2B', VALID_VAT_2, 'St', '1', 'D', 'City', '11111', '0509999999', '', '', 'SA']]);
      const r2 = await postFile(adminSession, `/api/master-import/${entity}/commit`, second);
      expect(r2.body.summary).toEqual({ created: 0, updated: 1, skipped: 0 });

      const rows: any[] = await db.select().from(table).where(eq((table as any).vatNumber, VALID_VAT_2));
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe(`${singularLabel} VAT Match A Renamed`);
      expect(rows[0].phone).toBe('0509999999');
    });

    it('no VAT + matching phone updates the existing record (B2C path)', async () => {
      const first = buildXlsx([[`${singularLabel} Phone Match A`, 'B2C', '', '', '', '', '', '', '0512345678', '', '', '']]);
      const r1 = await postFile(adminSession, `/api/master-import/${entity}/commit`, first);
      expect(r1.body.summary.created).toBe(1);

      // Same phone, different formatting — must still normalize-match.
      const second = buildXlsx([[`${singularLabel} Phone Match A Updated`, 'B2C', '', '', '', '', '', '', '+966 51 234 5678', '', '', '']]);
      const r2 = await postFile(adminSession, `/api/master-import/${entity}/commit`, second);
      expect(r2.body.summary).toEqual({ created: 0, updated: 1, skipped: 0 });

      const rows: any[] = await db.select().from(table).where(eq((table as any).name, `${singularLabel} Phone Match A Updated`));
      expect(rows).toHaveLength(1);
    });

    it('a DIFFERENT/new VAT that happens to share a phone with an existing party is a CONFLICT, not an update', async () => {
      const seed = buildXlsx([[`${singularLabel} Conflict Seed`, 'B2C', '', '', '', '', '', '', '0533334444', '', '', '']]);
      const r1 = await postFile(adminSession, `/api/master-import/${entity}/commit`, seed);
      expect(r1.body.summary.created).toBe(1);

      const conflict = buildXlsx([[`${singularLabel} Conflict New`, 'B2B', VALID_VAT_3, 'St', '1', 'D', 'City', '22222', '0533334444', '', '', 'SA']]);
      const v = await postFile(adminSession, `/api/master-import/${entity}/validate`, conflict);
      expect(v.body.rows[0].action).toBe('error');
      expect(v.body.rows[0].errors.join(' ')).toMatch(/Mobile number already exists on 'customer Conflict Seed'|Mobile number already exists on 'vendor Conflict Seed'/);

      const c = await postFile(adminSession, `/api/master-import/${entity}/commit`, conflict);
      expect(c.body.summary).toEqual({ created: 0, updated: 0, skipped: 1 });
      // The conflicting VAT must NOT have been created as a new row, and the seed row untouched.
      const newVatRows: any[] = await db.select().from(table).where(eq((table as any).vatNumber, VALID_VAT_3));
      expect(newVatRows).toHaveLength(0);
    });

    it('duplicate VAT within the same file errors on the second occurrence', async () => {
      const vat = '300055566600003';
      const buf = buildXlsx([
        [`${singularLabel} Dup A`, 'B2B', vat, 'St', '1', 'D', 'City', '33333', '', '', '', 'SA'],
        [`${singularLabel} Dup B`, 'B2B', vat, 'St', '1', 'D', 'City', '33333', '', '', '', 'SA'],
      ]);
      const { body } = await postFile(adminSession, `/api/master-import/${entity}/validate`, buf);
      expect(body.rows[0].action).toBe('create');
      expect(body.rows[1].action).toBe('error');
      expect(body.rows[1].errors.join(' ')).toMatch(/also appears on row 2/);
    });

    it('excludeRows keeps a still-valid row out of the commit', async () => {
      const buf = buildXlsx([
        [`${singularLabel} Exclude Me`, 'B2C', '', '', '', '', '', '', '', '', '', ''],
        [`${singularLabel} Keep Me`, 'B2C', '', '', '', '', '', '', '', '', '', ''],
      ]);
      const { body } = await postFile(adminSession, `/api/master-import/${entity}/commit`, buf, { excludeRows: JSON.stringify([2]) });
      expect(body.summary).toEqual({ created: 1, updated: 0, skipped: 1 });
      const excluded: any[] = await db.select().from(table).where(eq((table as any).name, `${singularLabel} Exclude Me`));
      expect(excluded).toHaveLength(0);
    });

    it('a VAT match is scoped to the caller\'s own company (no cross-company match)', async () => {
      // Seed the SAME VAT in the OTHER company directly.
      const otherId = generateId();
      const otherValues: any = entity === 'customers'
        ? { id: otherId, name: 'Other Co Customer', phone: '0', email: 'x@example.com', address: 'x', companyId: otherCompanyId, buyerType: 'B2B', vatNumber: '300077788800003' }
        : { id: otherId, name: 'Other Co Vendor', phone: '0', email: 'x@example.com', address: 'x', companyId: otherCompanyId, buyerType: 'B2B', vatNumber: '300077788800003' };
      await db.insert(table as any).values(otherValues);

      const buf = buildXlsx([[`${singularLabel} Cross Company`, 'B2B', '300077788800003', 'St', '1', 'D', 'City', '44444', '', '', '', 'SA']]);
      const { body } = await postFile(adminSession, `/api/master-import/${entity}/commit`, buf);
      expect(body.summary).toEqual({ created: 1, updated: 0, skipped: 0 }); // created, not matched against the other company's row
    });

    it('refuses a file over the row cap', async () => {
      const rows = Array.from({ length: 2001 }, (_, i) => [`${singularLabel} Row ${i}`, 'B2C', '', '', '', '', '', '', '', '', '', '']);
      const buf = buildXlsx(rows);
      const { status, body } = await postFile(adminSession, `/api/master-import/${entity}/validate`, buf);
      expect(status).toBe(400);
      expect(body.error).toMatch(/2000/);
    });

    it('is refused without the create permission, and never writes', async () => {
      const buf = buildXlsx([[`${singularLabel} Should Not Exist`, 'B2C', '', '', '', '', '', '', '', '', '', '']]);
      const v = await postFile(noPermSession, `/api/master-import/${entity}/validate`, buf);
      expect(v.status).toBe(403);
      const c = await postFile(noPermSession, `/api/master-import/${entity}/commit`, buf);
      expect(c.status).toBe(403);
      const found: any[] = await db.select().from(table).where(eq((table as any).name, `${singularLabel} Should Not Exist`));
      expect(found).toHaveLength(0);
    });
  });
}
