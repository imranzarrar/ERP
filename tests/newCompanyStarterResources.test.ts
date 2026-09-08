import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Covers AdminSettings.handleAddCompany's starter-resource creation (bank/customer/
// vendor/warehouse/template/fiscal month), migrated off the generic onUpdateDb blob sync onto
// dedicated real routes. Real HTTP against the already-running dev server + real
// Postgres, no mocks — matches this project's established testing convention. Creates
// its own throwaway company (via the real super-admin-gated POST /api/companies route,
// exactly like the UI does) and tears everything down in afterAll.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let superAdminHomeCompanyId: string;
let superAdminUserId: string;
let superAdminSessionId: string;
let newCompanyId: string;

async function api(sessionId: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
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
  superAdminHomeCompanyId = generateId();
  await db.insert(schema.companies).values({
    id: superAdminHomeCompanyId, name: 'NewCompanyTest Super Admin Home', address: 'x', phone: '0',
    email: 'home@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
  });

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  superAdminUserId = generateId();
  const superAdminUsername = `newcotest_super_${superAdminUserId}`;
  await db.insert(schema.users).values({
    id: superAdminUserId, username: superAdminUsername, password: passwordHash,
    role: 'super-admin', companyId: superAdminHomeCompanyId, isSuperAdmin: true, uiLanguage: 'en',
  });

  superAdminSessionId = await login(superAdminUsername);
});

afterAll(async () => {
  if (superAdminUserId) {
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, superAdminUserId));
  }
  if (newCompanyId) {
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, newCompanyId));
    await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, newCompanyId));
    await db.delete(schema.documentTemplates).where(eq(schema.documentTemplates.companyId, newCompanyId));
    await db.delete(schema.warehouses).where(eq(schema.warehouses.companyId, newCompanyId));
    await db.delete(schema.unitsOfMeasure).where(eq(schema.unitsOfMeasure.companyId, newCompanyId));
    await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, newCompanyId));
    await db.delete(schema.vendors).where(eq(schema.vendors.companyId, newCompanyId));
    await db.delete(schema.customers).where(eq(schema.customers.companyId, newCompanyId));
    await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, newCompanyId));
    await db.delete(schema.companies).where(eq(schema.companies.id, newCompanyId));
  }
  if (superAdminUserId) {
    await db.delete(schema.users).where(eq(schema.users.id, superAdminUserId));
  }
  if (superAdminHomeCompanyId) {
    await db.delete(schema.companies).where(eq(schema.companies.id, superAdminHomeCompanyId));
  }
});

describe('New-company starter resources (AdminSettings.handleAddCompany)', () => {
  it('creates the company and every starter resource via real routes, scoped to the new company, while the caller is still viewing a different company', async () => {
    newCompanyId = generateId();
    const finalizedCompany = {
      id: newCompanyId, name: 'Starter Resources Test Co', address: 'addr', phone: '0',
      email: 'newco@example.com', logoUrl: '', customHeader: '', customFooter: '',
      currency: 'SAR', counters: { quotation: 1001, invoice: 1001, expense: 1001, voucher: 1001 },
      themeId: 'classic-executive',
    };

    // superAdminSessionId's own companyId is superAdminHomeCompanyId, NOT newCompanyId —
    // mirrors the real UI scenario where the admin creating the company is not "in" it yet.
    const createCompanyRes = await api(superAdminSessionId, '/api/companies', {
      method: 'POST',
      body: JSON.stringify(finalizedCompany),
    });
    expect(createCompanyRes.status).toBe(200);

    const newBank = {
      id: generateId(), bankName: 'Main Operating Bank', accountNumber: 'SA123',
      accountTitle: 'Starter Resources Test Co Operating Account', openingBalance: 0,
      isActive: true, isDefault: true,
    };
    const bankRes = await api(superAdminSessionId, '/api/banks', {
      method: 'POST', body: JSON.stringify({ ...newBank, companyId: newCompanyId }),
    });
    expect(bankRes.status).toBe(200);

    const newCustomer = { id: generateId(), name: 'Walk-in Customer', phone: '-', email: '-', address: '-', isSystem: true, buyerType: 'B2C' };
    const customerRes = await api(superAdminSessionId, '/api/customers', {
      method: 'POST', body: JSON.stringify({ ...newCustomer, companyId: newCompanyId }),
    });
    expect(customerRes.status).toBe(200);

    const newVendor = { id: generateId(), name: 'Cash Vendor', phone: '-', email: '-', address: '-', isSystem: true, buyerType: 'B2C' };
    const vendorRes = await api(superAdminSessionId, '/api/vendors', {
      method: 'POST', body: JSON.stringify({ ...newVendor, companyId: newCompanyId }),
    });
    expect(vendorRes.status).toBe(200);

    // Fixed English label by explicit product decision (kept in parity with
    // companyProvisioning.ts's server-side onboarding-approval flow) — not the company's
    // own name (which the older behavior used, to support Arabic/Urdu company names).
    const newWarehouse = { id: generateId(), name: 'Main Warehouse', code: 'MAIN', isActive: true, type: 'sales' };
    const warehouseRes = await api(superAdminSessionId, '/api/warehouses', {
      method: 'POST', body: JSON.stringify({ ...newWarehouse, companyId: newCompanyId }),
    });
    expect(warehouseRes.status).toBe(200);

    const newTaxSlab = { id: generateId(), name: 'Standard VAT', percentage: 15, isDefault: true };
    const taxSlabRes = await api(superAdminSessionId, '/api/tax-slabs', {
      method: 'POST', body: JSON.stringify({ ...newTaxSlab, companyId: newCompanyId }),
    });
    expect(taxSlabRes.status).toBe(200);

    const newUnitOfMeasure = { id: generateId(), name: 'Piece', code: 'PCE', isActive: true };
    const uomRes = await api(superAdminSessionId, '/api/units-of-measure', {
      method: 'POST', body: JSON.stringify({ ...newUnitOfMeasure, companyId: newCompanyId }),
    });
    expect(uomRes.status).toBe(200);

    const newTemplate = {
      id: generateId(), name: 'Standard English (A4)', language: 'English',
      pageSize: '8.27in x 11.69in (A4)', isActive: true, printHeader: true, printFooter: true,
      printLogo: true, printQrCode: true,
    };
    const templateRes = await api(superAdminSessionId, '/api/templates', {
      method: 'POST', body: JSON.stringify({ ...newTemplate, companyId: newCompanyId }),
    });
    expect(templateRes.status).toBe(200);

    const now = new Date();
    const currentMonthId = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const newMonth = { id: currentMonthId, name: 'Test Month', status: 'Open' };
    const monthRes = await api(superAdminSessionId, '/api/transactions/months', {
      method: 'POST', body: JSON.stringify({ ...newMonth, companyId: newCompanyId }),
    });
    expect(monthRes.status).toBe(200);

    // Verify everything actually persisted to Postgres, scoped to the NEW company, not
    // the super-admin's own home company (this is exactly what the companyId-in-body
    // override on the auth middleware needs to have honored correctly).
    const [bankRow] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, newBank.id));
    expect(bankRow?.companyId).toBe(newCompanyId);
    expect(bankRow?.isDefault).toBe(true);

    const [customerRow] = await db.select().from(schema.customers).where(eq(schema.customers.id, newCustomer.id));
    expect(customerRow?.companyId).toBe(newCompanyId);

    const [vendorRow] = await db.select().from(schema.vendors).where(eq(schema.vendors.id, newVendor.id));
    expect(vendorRow?.companyId).toBe(newCompanyId);

    const [warehouseRow] = await db.select().from(schema.warehouses).where(eq(schema.warehouses.id, newWarehouse.id));
    expect(warehouseRow?.companyId).toBe(newCompanyId);
    expect(warehouseRow?.name).toBe('Main Warehouse');
    // The company's very first warehouse ever — POST /api/warehouses auto-promotes it.
    expect(warehouseRow?.isCompanyDefault).toBe(true);

    const [taxSlabRow] = await db.select().from(schema.taxSlabs).where(eq(schema.taxSlabs.id, newTaxSlab.id));
    expect(taxSlabRow?.companyId).toBe(newCompanyId);
    expect(Number(taxSlabRow?.percentage)).toBe(15);
    expect(taxSlabRow?.isDefault).toBe(true);

    const [uomRow] = await db.select().from(schema.unitsOfMeasure).where(eq(schema.unitsOfMeasure.id, newUnitOfMeasure.id));
    expect(uomRow?.companyId).toBe(newCompanyId);
    expect(uomRow?.code).toBe('PCE');

    const [templateRow] = await db.select().from(schema.documentTemplates).where(eq(schema.documentTemplates.id, newTemplate.id));
    expect(templateRow?.companyId).toBe(newCompanyId);
    expect(templateRow?.isActive).toBe(true);

    const [monthRow] = await db.select().from(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, newCompanyId));
    expect(monthRow?.id).toBe(currentMonthId);
    expect(monthRow?.status).toBe('Open');

    // And confirm none of it leaked onto the super-admin's own home company.
    const homeBanks = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, superAdminHomeCompanyId));
    expect(homeBanks.length).toBe(0);
  });
});
