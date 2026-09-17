import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Phase 2 of the RLS full-rollout (BACKLOG.md) migrated master-data routes — the rest of
// masterEntities.ts (vendors, products, banks, tax slabs, product categories, modifier
// groups, units of measure, job titles, product unit conversions, warehouses, product
// warehouses), plus branches.ts and employees.ts — onto the tenantDb() connection,
// mirroring the pattern already proven on `customers` (tests/tenantDbRls.test.ts).
//
// This file proves the same two things tenantDbRls.test.ts proved for customers, applied
// to a representative sample of Phase 2's tables: (1) the migrated routes still work
// end-to-end and correctly reject a cross-company hijack attempt (the exact bug class
// found and fixed on customers' own migration — a hijack-detection lookup accidentally
// routed through tenantDb would make the other company's row invisible instead of
// visibly rejected), and (2) the database itself enforces isolation via a raw
// erp_app_tenant connection with no WHERE clause. It also smoke-tests every other
// migrated GET endpoint to confirm the withTenantDb wiring didn't break at runtime.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyAId: string;
let companyBId: string;
let sessionId: string;

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function makeCompany(name: string) {
  const id = generateId();
  await db.insert(schema.companies).values({
    id, name, address: 'Test Address', phone: '0000000000', email: `${id}@example.com`,
    logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false,
  });
  return id;
}

beforeAll(async () => {
  companyAId = await makeCompany('TenantDb Phase2 Test Co A');
  companyBId = await makeCompany('TenantDb Phase2 Test Co B');

  const userAId = generateId();
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  const username = `tenantdb_p2_test_${userAId}`;
  await db.insert(schema.users).values({
    id: userAId, username, password: passwordHash, role: 'admin', companyId: companyAId, isSuperAdmin: false,
  });

  const loginRes = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });
  const loginBody = await loginRes.json().catch(() => null);
  if (!loginBody?.sessionId) {
    throw new Error(`Test setup failed: login did not return a sessionId (status ${loginRes.status}, body ${JSON.stringify(loginBody)})`);
  }
  sessionId = loginBody.sessionId;
});

afterAll(async () => {
  await db.delete(schema.productWarehouses).where(eq(schema.productWarehouses.companyId, companyAId));
  await db.delete(schema.productUnitConversions).where(eq(schema.productUnitConversions.companyId, companyAId));
  // No productModifierGroups/modifierChoices/modifierGroups rows are ever created by this
  // test file (only GET smoke-tested), so nothing to clean up here — deliberately not
  // adding an unscoped delete against these tables just to be "thorough."
  await db.delete(schema.productsServices).where(eq(schema.productsServices.companyId, companyAId));
  await db.delete(schema.productCategories).where(eq(schema.productCategories.companyId, companyAId));
  await db.delete(schema.unitsOfMeasure).where(eq(schema.unitsOfMeasure.companyId, companyAId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyAId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyAId));
  await db.delete(schema.vendors).where(eq(schema.vendors.companyId, companyAId));
  await db.delete(schema.vendors).where(eq(schema.vendors.companyId, companyBId));
  await db.delete(schema.employees).where(eq(schema.employees.companyId, companyAId));
  await db.delete(schema.jobTitles).where(eq(schema.jobTitles.companyId, companyAId));
  await db.delete(schema.warehouses).where(eq(schema.warehouses.companyId, companyAId));
  await db.delete(schema.branches).where(eq(schema.branches.companyId, companyAId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyAId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyBId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyAId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyBId));
  await db.delete(schema.users).where(eq(schema.users.companyId, companyAId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyAId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyBId));
});

describe('Vendors — end-to-end through tenantDb, plus cross-company hijack rejection', () => {
  let vendorAId: string;
  let vendorBId: string;

  it('creates a vendor for Company A through the tenantDb-backed POST /vendors route', async () => {
    const newId = generateId();
    const { status, body } = await api('/api/vendors', {
      method: 'POST',
      body: JSON.stringify({ id: newId, name: 'Company A Vendor', phone: '111', email: 'avendor@example.com', address: 'A Address', buyerType: 'B2C' }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const [row] = await db.select().from(schema.vendors).where(eq(schema.vendors.companyId, companyAId));
    expect(row).toBeTruthy();
    vendorAId = row.id;
  });

  it('GET /vendors for Company A never returns Company B\'s vendor', async () => {
    vendorBId = generateId();
    await db.insert(schema.vendors).values({
      id: vendorBId, name: 'Company B Vendor', phone: '222', email: 'bvendor@example.com', address: 'B', companyId: companyBId, buyerType: 'B2C',
    });
    const { status, body } = await api('/api/vendors');
    expect(status).toBe(200);
    const ids = body.map((v: any) => v.id);
    expect(ids).toContain(vendorAId);
    expect(ids).not.toContain(vendorBId);
  });

  it('blocks Company A from hijacking Company B\'s vendor via POST /vendors with a cross-company id', async () => {
    const { status, body } = await api('/api/vendors', {
      method: 'POST',
      body: JSON.stringify({ id: vendorBId, name: 'HIJACKED', phone: '999', email: 'hijack@example.com', address: 'A', buyerType: 'B2C' }),
    });
    expect(status).toBe(403);
    expect(body.error).toMatch(/another company/i);
    const [row] = await db.select().from(schema.vendors).where(eq(schema.vendors.id, vendorBId));
    expect(row.companyId).toBe(companyBId);
    expect(row.name).toBe('Company B Vendor');
  });

  it('a raw connection as erp_app_tenant, scoped to Company A, cannot see Company B\'s vendor even with no WHERE clause', async () => {
    const { Pool } = pg;
    const pool = new Pool({
      host: process.env.SQL_HOST, user: process.env.TENANT_DB_USER,
      password: process.env.TENANT_DB_PASSWORD, database: process.env.SQL_DB_NAME,
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.company_id', $1, true)", [companyAId]);
      const res = await client.query('SELECT id, company_id FROM vendors');
      const ids = res.rows.map((r: any) => r.id);
      expect(ids).toContain(vendorAId);
      expect(ids).not.toContain(vendorBId);
      expect(res.rows.every((r: any) => r.company_id === companyAId)).toBe(true);
      await client.query('ROLLBACK');
    } finally {
      client.release();
      await pool.end();
    }
  });
});

describe('Branches — default-swap transaction still atomic after removing the explicit db.transaction() wrapper', () => {
  it('creating a second default branch atomically un-defaults the first', async () => {
    const branchAId = generateId();
    const { status: s1 } = await api('/api/branches', {
      method: 'POST',
      body: JSON.stringify({ id: branchAId, name: 'Branch A', code: 'BRA', isDefault: true, autoCreateWarehouse: false }),
    });
    expect(s1).toBe(200);

    const branchBId = generateId();
    const { status: s2 } = await api('/api/branches', {
      method: 'POST',
      body: JSON.stringify({ id: branchBId, name: 'Branch B', code: 'BRB', isDefault: true, autoCreateWarehouse: false }),
    });
    expect(s2).toBe(200);

    const rows = await db.select().from(schema.branches).where(eq(schema.branches.companyId, companyAId));
    const branchA = rows.find(r => r.id === branchAId);
    const branchB = rows.find(r => r.id === branchBId);
    expect(branchA?.isDefault).toBe(false);
    expect(branchB?.isDefault).toBe(true);
  });
});

describe('Employees — atomic counter reservation still works without the explicit db.transaction() wrapper', () => {
  it('creates two employees in a row with sequential, non-colliding employee numbers', async () => {
    const jobTitleId = generateId();
    await db.insert(schema.jobTitles).values({ id: jobTitleId, companyId: companyAId, title: 'Tester', isActive: true });

    const { status: s1, body: b1 } = await api('/api/employees', {
      method: 'POST',
      body: JSON.stringify({ name: 'Employee One', jobTitleId }),
    });
    expect(s1).toBe(200);
    const { status: s2, body: b2 } = await api('/api/employees', {
      method: 'POST',
      body: JSON.stringify({ name: 'Employee Two', jobTitleId }),
    });
    expect(s2).toBe(200);
    expect(b1.employeeNumber).not.toBe(b2.employeeNumber);
  });
});

describe('Remaining migrated GET endpoints — smoke test the withTenantDb wiring', () => {
  it.each([
    '/api/products',
    '/api/banks',
    '/api/tax-slabs',
    '/api/product-categories',
    '/api/modifier-groups',
    '/api/units-of-measure',
    '/api/job-titles',
    '/api/product-unit-conversions',
    '/api/warehouses',
    '/api/product-warehouses',
  ])('%s returns 200 through tenantDb with no server error', async (path) => {
    const { status } = await api(path);
    expect(status).toBe(200);
  });
});
