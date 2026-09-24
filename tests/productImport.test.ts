import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import * as XLSX from 'xlsx';
import { eq, and } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real HTTP against the running dev server + real Postgres — no mocks, matching this
// project's established testing convention. Covers the Product/Service Master bulk
// import (server/lib/productImport.ts, server/routes/masterImport.ts): the SAME
// validation rules as POST /products (name/price required, itemKind/salesPurchaseFlow
// enums, category-by-name resolution scoped to the caller's own company, barcode as the
// re-import match key), the validate-then-commit split (nothing written until commit),
// partial success (one bad row never blocks the others), and permission/company scoping.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let otherCompanyId: string;
let adminUserId: string;
let adminSession: string;
let noPermUserId: string;
let noPermSession: string;
let categoryId: string;

async function login(username: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });
  const body = await res.json().catch(() => null);
  if (!body?.sessionId) throw new Error(`Login failed for ${username}: ${JSON.stringify(body)}`);
  return body.sessionId;
}

function buildXlsx(rows: (string | number)[][], headers: string[] = [
  'Name', 'Selling Price', 'Description', 'Cost Price', 'Item Kind', 'Sales/Purchase',
  'Unit', 'Category', 'Barcode', 'Min Stock Level', 'Max Stock Level', 'Reorder Lead Time', 'Active',
]): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  XLSX.utils.book_append_sheet(wb, ws, 'Products');
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

beforeAll(async () => {
  companyId = generateId();
  otherCompanyId = generateId();
  await db.insert(schema.companies).values([
    { id: companyId, name: 'Product Import Test Co', address: 'x', phone: '0', email: 'pimport@example.com', logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive' },
    { id: otherCompanyId, name: 'Product Import Other Co', address: 'x', phone: '0', email: 'pimport-other@example.com', logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive' },
  ] as any);

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  adminUserId = generateId();
  const adminUsername = `pimport_admin_${adminUserId}`;
  await db.insert(schema.users).values({ id: adminUserId, username: adminUsername, password: passwordHash, role: 'admin', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  adminSession = await login(adminUsername);

  noPermUserId = generateId();
  const noPermUsername = `pimport_noperm_${noPermUserId}`;
  await db.insert(schema.users).values({ id: noPermUserId, username: noPermUsername, password: passwordHash, role: 'staff', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  noPermSession = await login(noPermUsername);

  categoryId = generateId();
  await db.insert(schema.productCategories).values({ id: categoryId, name: 'PImport Category', companyId });
  // Same category NAME in a different company — must never resolve for the test company's import.
  await db.insert(schema.productCategories).values({ id: generateId(), name: 'PImport Category', companyId: otherCompanyId });
});

afterAll(async () => {
  await db.delete(schema.productsServices).where(eq(schema.productsServices.companyId, companyId));
  await db.delete(schema.productCategories).where(eq(schema.productCategories.companyId, companyId));
  await db.delete(schema.productCategories).where(eq(schema.productCategories.companyId, otherCompanyId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, adminUserId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, noPermUserId));
  await db.delete(schema.users).where(eq(schema.users.id, adminUserId));
  await db.delete(schema.users).where(eq(schema.users.id, noPermUserId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, otherCompanyId));
});

describe('GET /api/master-import/products/template', () => {
  it('returns a real xlsx workbook with the expected headers', async () => {
    const res = await fetch(`${BASE_URL}/api/master-import/products/template`, { headers: { 'x-session-id': adminSession } });
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    const wb = XLSX.read(buf, { type: 'buffer' });
    const rows: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    expect(rows[0]).toEqual(['Name', 'Selling Price', 'Description', 'Cost Price', 'Item Kind', 'Sales/Purchase', 'Unit', 'Category', 'Barcode', 'Min Stock Level', 'Max Stock Level', 'Reorder Lead Time', 'Active']);
  });

  it('is refused without the products.create permission', async () => {
    const res = await fetch(`${BASE_URL}/api/master-import/products/template`, { headers: { 'x-session-id': noPermSession } });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/master-import/products/validate', () => {
  it('validates a mix of good and bad rows without writing anything', async () => {
    const buf = buildXlsx([
      ['PImport Widget A', '19.99', 'A widget', '', '', '', '', '', '', '', '', '', ''],
      ['', '5', '', '', '', '', '', '', '', '', '', '', ''], // missing name
      ['PImport Widget B', '', '', '', '', '', '', '', '', '', '', '', ''], // missing price
      ['PImport Widget C', '10', '', '', 'bogus', '', '', '', '', '', '', '', ''], // bad itemKind
      ['PImport Widget D', '10', '', '', '', 'bogus', '', '', '', '', '', '', ''], // bad flow
      ['PImport Widget E', '10', '', '', '', '', '', 'Nonexistent Category', '', '', '', '', ''], // bad category
    ]);
    const { status, body } = await postFile(adminSession, '/api/master-import/products/validate', buf);
    expect(status).toBe(200);
    expect(body.summary).toEqual({ totalRows: 6, toCreate: 1, toUpdate: 0, errors: 5 });
    expect(body.rows[1].errors.join(' ')).toMatch(/Name is required/);
    expect(body.rows[2].errors.join(' ')).toMatch(/Selling Price is required/);
    expect(body.rows[3].errors.join(' ')).toMatch(/Item Kind must be/);
    expect(body.rows[4].errors.join(' ')).toMatch(/Sales\/Purchase must be/);
    expect(body.rows[5].errors.join(' ')).toMatch(/Category 'Nonexistent Category' was not found/);

    // Nothing was written by validate.
    const found = await db.select().from(schema.productsServices).where(and(eq(schema.productsServices.companyId, companyId), eq(schema.productsServices.name, 'PImport Widget A')));
    expect(found).toHaveLength(0);
  });

  it("resolves a category by name, scoped to the caller's own company", async () => {
    const buf = buildXlsx([['PImport Categorized', '5', '', '', '', '', '', 'PImport Category', '', '', '', '', '']]);
    const { body } = await postFile(adminSession, '/api/master-import/products/validate', buf);
    expect(body.rows[0].action).toBe('create');
    expect(body.rows[0].errors).toEqual([]);
  });

  it('is refused without the products.create permission', async () => {
    const buf = buildXlsx([['x', '1', '', '', '', '', '', '', '', '', '', '', '']]);
    const { status } = await postFile(noPermSession, '/api/master-import/products/validate', buf);
    expect(status).toBe(403);
  });
});

describe('POST /api/master-import/products/commit', () => {
  it('creates the valid rows, skips the invalid ones, and assigns real SKUs', async () => {
    const buf = buildXlsx([
      ['PImport Commit Good', '25', 'desc', '20', 'item', 'Both', 'PCE', '', '', '', '', '', ''],
      ['', '5', '', '', '', '', '', '', '', '', '', '', ''], // invalid, must be skipped
    ]);
    const { status, body } = await postFile(adminSession, '/api/master-import/products/commit', buf);
    expect(status).toBe(200);
    expect(body.summary).toEqual({ created: 1, updated: 0, skipped: 1 });
    expect(body.rows[1].reason).toMatch(/Name is required/);

    const [row] = await db.select().from(schema.productsServices).where(and(eq(schema.productsServices.companyId, companyId), eq(schema.productsServices.name, 'PImport Commit Good')));
    expect(row).toBeTruthy();
    expect(row.sku).toBeTruthy();
    expect(row.unitPrice).toBe('25.00');
  });

  it('a second upload with the same barcode UPDATES the existing product instead of duplicating it', async () => {
    const first = buildXlsx([['PImport Barcode Item', '10', '', '', '', '', '', '', 'BC-12345', '', '', '', '']]);
    const r1 = await postFile(adminSession, '/api/master-import/products/commit', first);
    expect(r1.body.summary.created).toBe(1);

    const second = buildXlsx([['PImport Barcode Item Renamed', '15', '', '', '', '', '', '', 'BC-12345', '', '', '', '']]);
    const r2 = await postFile(adminSession, '/api/master-import/products/commit', second);
    expect(r2.body.summary).toEqual({ created: 0, updated: 1, skipped: 0 });

    const rows = await db.select().from(schema.productsServices).where(and(eq(schema.productsServices.companyId, companyId), eq(schema.productsServices.barcode, 'BC-12345')));
    expect(rows).toHaveLength(1); // still just one row, not two
    expect(rows[0].name).toBe('PImport Barcode Item Renamed');
    expect(rows[0].unitPrice).toBe('15.00');
  });

  it('the same barcode twice IN ONE FILE errors on the second occurrence', async () => {
    const buf = buildXlsx([
      ['PImport Dup A', '10', '', '', '', '', '', '', 'BC-DUPE', '', '', '', ''],
      ['PImport Dup B', '10', '', '', '', '', '', '', 'BC-DUPE', '', '', '', ''],
    ]);
    const { body } = await postFile(adminSession, '/api/master-import/products/validate', buf);
    expect(body.rows[0].action).toBe('create');
    expect(body.rows[1].action).toBe('error');
    expect(body.rows[1].errors.join(' ')).toMatch(/also appears on row 2/);
  });

  it('excludeRows keeps a still-valid row out of the commit', async () => {
    const buf = buildXlsx([
      ['PImport Exclude Me', '10', '', '', '', '', '', '', '', '', '', '', ''],
      ['PImport Keep Me', '10', '', '', '', '', '', '', '', '', '', '', ''],
    ]);
    const { body } = await postFile(adminSession, '/api/master-import/products/commit', buf, { excludeRows: JSON.stringify([2]) });
    expect(body.summary).toEqual({ created: 1, updated: 0, skipped: 1 });
    const excluded = await db.select().from(schema.productsServices).where(and(eq(schema.productsServices.companyId, companyId), eq(schema.productsServices.name, 'PImport Exclude Me')));
    expect(excluded).toHaveLength(0);
    const kept = await db.select().from(schema.productsServices).where(and(eq(schema.productsServices.companyId, companyId), eq(schema.productsServices.name, 'PImport Keep Me')));
    expect(kept).toHaveLength(1);
  });

  it('refuses a file over the row cap', async () => {
    const rows = Array.from({ length: 2001 }, (_, i) => [`PImport Row ${i}`, '1', '', '', '', '', '', '', '', '', '', '', '']);
    const buf = buildXlsx(rows);
    const { status, body } = await postFile(adminSession, '/api/master-import/products/validate', buf);
    expect(status).toBe(400);
    expect(body.error).toMatch(/2000/);
  });

  it('is refused without the products.create permission, and never writes', async () => {
    const buf = buildXlsx([['PImport Should Not Exist', '10', '', '', '', '', '', '', '', '', '', '', '']]);
    const { status } = await postFile(noPermSession, '/api/master-import/products/commit', buf);
    expect(status).toBe(403);
    const found = await db.select().from(schema.productsServices).where(and(eq(schema.productsServices.companyId, companyId), eq(schema.productsServices.name, 'PImport Should Not Exist')));
    expect(found).toHaveLength(0);
  });
});
