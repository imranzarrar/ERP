import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server + real Postgres state,
// matching this project's established no-mocks testing practice. Dedicated throwaway
// company/users/role, torn down in afterAll — never touches the seeded demo companies.
// Covers the new create/read/update/delete permission model (src/permissionSchema.ts):
// upsert routes branching create-vs-update by whether the row exists, master-data
// deactivate-toggle-as-delete, the dedicated quotation isCancelled flag (separate from
// its phase `status`), and the ZATCA-cleared-invoice immutability guard that applies
// regardless of permission.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let adminUserId: string;
let adminSessionId: string;
let scopedUserId: string;
let scopedSessionId: string;
let roleId: string;

let taxSlabId: string;
let customerId: string;
let bankId: string;
let prId: string;

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

async function setRolePermissions(permissions: any) {
  await db.update(schema.roles).set({ permissions }).where(eq(schema.roles.id, roleId));
}

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: 'Permission CRUD Test Co', address: 'x', phone: '0',
    email: 'permcrud@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
  } as any);

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

  adminUserId = generateId();
  const adminUsername = `permcrud_admin_${adminUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({
    id: adminUserId, username: adminUsername, password: passwordHash,
    role: 'admin', companyId, isSuperAdmin: false, uiLanguage: 'en',
  });
  adminSessionId = await login(adminUsername);

  roleId = generateId();
  await db.insert(schema.roles).values({
    id: roleId, companyId, name: 'CRUD Test Role', permissions: {},
  });

  scopedUserId = generateId();
  const scopedUsername = `permcrud_scoped_${scopedUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({
    id: scopedUserId, username: scopedUsername, password: passwordHash,
    role: 'user', companyId, isSuperAdmin: false, uiLanguage: 'en',
  });
  await db.insert(schema.userRoles).values({ userId: scopedUserId, roleId });
  scopedSessionId = await login(scopedUsername);

  taxSlabId = generateId();
  await db.insert(schema.taxSlabs).values({
    id: taxSlabId, name: 'PermCrud 15%', percentage: '15', companyId, isDefault: false,
  });

  customerId = generateId();
  await db.insert(schema.customers).values({
    id: customerId, name: 'PermCrud Customer', phone: '0500000000', email: 'c@example.com',
    address: 'x', companyId, buyerType: 'B2C',
  });

  bankId = generateId();
  await db.insert(schema.bankAccounts).values({
    id: bankId, bankName: 'PermCrud Bank', accountNumber: '2222',
    accountTitle: 'PermCrud Holder', openingBalance: '0', isActive: true,
    isDefault: true, companyId,
  });

  // validateTransactionDate requires an open fiscal month covering any transaction date
  // used below.
  await db.insert(schema.fiscalMonths).values({
    id: '2026-08', name: 'August 2026', status: 'Open', companyId,
  });

  prId = generateId();
  await db.insert(schema.purchaseRequisitions).values({
    id: prId, prNumber: 'PR-PERMCRUD-1', requestedBy: scopedUsername, date: new Date(),
    status: 'Pending', companyId,
  });
});

afterAll(async () => {
  const quotIds = (await db.select().from(schema.quotations).where(eq(schema.quotations.companyId, companyId))).map(q => q.id);
  if (quotIds.length > 0) {
    await db.delete(schema.quotationItems).where(inArray(schema.quotationItems.quotationId, quotIds));
  }
  await db.delete(schema.invoices).where(eq(schema.invoices.companyId, companyId));
  await db.delete(schema.quotations).where(eq(schema.quotations.companyId, companyId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, companyId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyId));
  await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyId));
  await db.delete(schema.purchaseRequisitions).where(eq(schema.purchaseRequisitions.companyId, companyId));
  await db.delete(schema.documentTemplates).where(eq(schema.documentTemplates.companyId, companyId));
  await db.delete(schema.userRoles).where(eq(schema.userRoles.roleId, roleId));
  await db.delete(schema.roles).where(eq(schema.roles.id, roleId));
  // Logging in wrote audit_log rows referencing these users - the FK has no cascade, so
  // those must go before the users themselves (same constraint hit by any throwaway test
  // user in this app once they've authenticated at least once). Also drop any staff
  // account the delegated-user tests created.
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
  await db.delete(schema.users).where(eq(schema.users.companyId, companyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
});

describe('Master-data Delete = deactivate toggle, branched by row existence', () => {
  it('customers.delete=false blocks the toggle-active route even with read+create+update', async () => {
    await setRolePermissions({
      customers: {
        create: { enabled: true }, read: { enabled: true },
        update: { enabled: true }, delete: { enabled: false },
      },
    });
    const res = await api(scopedSessionId, `/api/customers/${customerId}/toggle-active`, { method: 'PATCH' });
    expect(res.status).toBe(403);
  });

  it('customers.delete=true allows the toggle-active route and flips isActive', async () => {
    await setRolePermissions({
      customers: {
        create: { enabled: true }, read: { enabled: true },
        update: { enabled: true }, delete: { enabled: true },
      },
    });
    const res = await api(scopedSessionId, `/api/customers/${customerId}/toggle-active`, { method: 'PATCH' });
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);

    const [row] = await db.select().from(schema.customers).where(eq(schema.customers.id, customerId));
    expect(row.isActive).toBe(false);

    // Flip it back so later tests in this file see an active customer again.
    await api(scopedSessionId, `/api/customers/${customerId}/toggle-active`, { method: 'PATCH' });
  });

  it('editing a deactivated customer is rejected regardless of update permission', async () => {
    await setRolePermissions({
      customers: {
        create: { enabled: true }, read: { enabled: true },
        update: { enabled: true }, delete: { enabled: true },
      },
    });
    await api(scopedSessionId, `/api/customers/${customerId}/toggle-active`, { method: 'PATCH' }); // -> inactive
    const editRes = await api(scopedSessionId, '/api/customers', {
      method: 'POST',
      body: JSON.stringify({ id: customerId, name: 'Renamed while inactive', phone: '0500000000', email: 'c@example.com', address: 'x', buyerType: 'B2C' }),
    });
    expect(editRes.status).toBe(400);
    await api(scopedSessionId, `/api/customers/${customerId}/toggle-active`, { method: 'PATCH' }); // -> active again
  });

  it('create permission does not grant edit of an existing row, and vice versa', async () => {
    // create:true, update:false -> editing the existing customer must be forbidden.
    await setRolePermissions({
      customers: { create: { enabled: true }, read: { enabled: true }, update: { enabled: false }, delete: { enabled: false } },
    });
    const editRes = await api(scopedSessionId, '/api/customers', {
      method: 'POST',
      body: JSON.stringify({ id: customerId, name: 'Should be blocked', phone: '0500000000', email: 'c@example.com', address: 'x', buyerType: 'B2C' }),
    });
    expect(editRes.status).toBe(403);

    // create:false, update:true -> creating a brand-new customer must be forbidden.
    await setRolePermissions({
      customers: { create: { enabled: false }, read: { enabled: true }, update: { enabled: true }, delete: { enabled: false } },
    });
    const createRes = await api(scopedSessionId, '/api/customers', {
      method: 'POST',
      body: JSON.stringify({ name: 'New Customer', phone: '0511111111', email: 'new@example.com', address: 'x', buyerType: 'B2C' }),
    });
    expect(createRes.status).toBe(403);
  });
});

describe('Quotation cancel: dedicated isCancelled flag, separate from phase status', () => {
  it('cancelling sets isCancelled without touching status, and blocks a second cancel', async () => {
    await setRolePermissions({
      quotation: { create: { enabled: true }, read: { enabled: true }, update: { enabled: true }, delete: { enabled: true } },
    });
    const createRes = await api(scopedSessionId, '/api/transactions/quotations', {
      method: 'POST',
      body: JSON.stringify({
        quotationData: {
          date: '2026-08-01', customerId, taxSlabId, notes: 'test', status: 'Draft',
          createdById: scopedUserId, createdAt: new Date().toISOString(),
          items: [{ id: crypto.randomUUID(), description: 'Item', unitCost: 100, quantity: 1, unit: 'PCE' }],
        },
      }),
    });
    expect(createRes.status).toBe(200);

    const [created] = await db.select().from(schema.quotations)
      .where(eq(schema.quotations.companyId, companyId));
    expect(created).toBeTruthy();
    expect(created.isCancelled).toBe(false);

    const cancelRes = await api(scopedSessionId, `/api/transactions/quotations/${created.id}/cancel`, { method: 'POST' });
    expect(cancelRes.status).toBe(200);

    const [afterCancel] = await db.select().from(schema.quotations).where(eq(schema.quotations.id, created.id));
    expect(afterCancel.isCancelled).toBe(true);
    expect(afterCancel.status).toBe('Draft'); // phase untouched by cancellation

    const secondCancel = await api(scopedSessionId, `/api/transactions/quotations/${created.id}/cancel`, { method: 'POST' });
    expect(secondCancel.status).toBe(400);
  });

  it('quotation.delete=false blocks the cancel route', async () => {
    await setRolePermissions({
      quotation: { create: { enabled: true }, read: { enabled: true }, update: { enabled: true }, delete: { enabled: false } },
    });
    const createRes = await api(scopedSessionId, '/api/transactions/quotations', {
      method: 'POST',
      body: JSON.stringify({
        quotationData: {
          date: '2026-08-01', customerId, taxSlabId, notes: 'test2', status: 'Draft',
          createdById: scopedUserId, createdAt: new Date().toISOString(),
          items: [{ id: crypto.randomUUID(), description: 'Item', unitCost: 50, quantity: 1, unit: 'PCE' }],
        },
      }),
    });
    expect(createRes.status).toBe(200);
    const rows = await db.select().from(schema.quotations).where(eq(schema.quotations.companyId, companyId));
    const target = rows.find(q => q.notes === 'test2')!;

    const res = await api(scopedSessionId, `/api/transactions/quotations/${target.id}/cancel`, { method: 'POST' });
    expect(res.status).toBe(403);
  });
});

describe('ZATCA-cleared invoice immutability: a record-state rule, not a permission gap', () => {
  it('rejects editing a CLEARED invoice even for an admin', async () => {
    const invoiceId = generateId();
    await db.insert(schema.invoices).values({
      id: invoiceId, invoiceNumber: 'INV-PERMCRUD-1', date: '2026-08-01',
      customerId, taxSlabId, bankId, paymentStatus: 'Unpaid', notes: 'x',
      status: 'Active', createdById: adminUserId, createdAt: new Date(),
      companyId, zatcaStatus: 'CLEARED',
    } as any);

    const res = await api(adminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          id: invoiceId, date: '2026-08-01', customerId, taxSlabId, notes: 'edited',
          status: 'Active', createdById: adminUserId,
          items: [{ description: 'Edited Item', unitCost: 999, quantity: 1, unit: 'PCE' }],
        },
      }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ZATCA/i);
  });
});

describe('Staff enrollment: delegated users.create cannot mint an admin account', () => {
  it('a delegated (non-admin-tier) actor creating a user is forced to role=user regardless of what was requested', async () => {
    await setRolePermissions({ users: { create: { enabled: true }, read: { enabled: true }, update: { enabled: true }, delete: { enabled: true } } });

    const res = await api(scopedSessionId, '/api/users', {
      method: 'POST',
      body: JSON.stringify({
        id: generateId(),
        username: `permcrud_delegated_hire_${generateId().slice(0, 8)}`,
        password: TEST_PASSWORD,
        email: 'hire@example.com',
        role: 'admin',        // attempted escalation
        isSuperAdmin: true,   // attempted escalation
      }),
    });
    expect(res.status).toBe(200);

    const hire = (await db.select().from(schema.users).where(eq(schema.users.companyId, companyId)))
      .find(u => u.username.startsWith('permcrud_delegated_hire_'));
    expect(hire).toBeTruthy();
    expect(hire!.role).toBe('user');
    expect(hire!.isSuperAdmin).toBe(false);

    await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, hire!.id));
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, hire!.id));
    await db.delete(schema.users).where(eq(schema.users.id, hire!.id));
  });

  it('users.create=false blocks staff enrollment', async () => {
    await setRolePermissions({ users: { create: { enabled: false }, read: { enabled: true }, update: { enabled: true }, delete: { enabled: true } } });
    const res = await api(scopedSessionId, '/api/users', {
      method: 'POST',
      body: JSON.stringify({ username: `permcrud_blocked_${generateId().slice(0, 8)}`, password: TEST_PASSWORD, email: 'blocked@example.com' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('Document templates: full CRUD, cosmetic/low-risk delegation', () => {
  it('create/read/update/delete each independently gated', async () => {
    await setRolePermissions({ templates: { create: { enabled: false }, read: { enabled: false }, update: { enabled: false }, delete: { enabled: false } } });
    const blockedCreate = await api(scopedSessionId, '/api/templates', {
      method: 'POST',
      body: JSON.stringify({ name: 'PermCrud Template', language: 'en', pageSize: 'A4' }),
    });
    expect(blockedCreate.status).toBe(403);

    await setRolePermissions({ templates: { create: { enabled: true }, read: { enabled: true }, update: { enabled: true }, delete: { enabled: true } } });
    const created = await api(scopedSessionId, '/api/templates', {
      method: 'POST',
      body: JSON.stringify({ name: 'PermCrud Template', language: 'en', pageSize: 'A4' }),
    });
    expect(created.status).toBe(200);
    const templateId = created.body.id as string;

    const readRes = await api(scopedSessionId, '/api/templates');
    expect(readRes.status).toBe(200);

    const updateRes = await api(scopedSessionId, `/api/templates/${templateId}`, {
      method: 'PATCH',
      body: JSON.stringify({ printHeader: false }),
    });
    expect(updateRes.status).toBe(200);

    const deleteRes = await api(scopedSessionId, `/api/templates/${templateId}`, { method: 'DELETE' });
    expect(deleteRes.status).toBe(200);
  });
});

describe('Purchase Requisition approval: segregated from submission (inventory.approve vs inventory.pr)', () => {
  it('inventory.pr alone does not grant approval authority', async () => {
    await setRolePermissions({ inventory: { access: { enabled: true }, pr: { enabled: true }, po: { enabled: false }, grn: { enabled: false }, stock: { enabled: false }, approve: { enabled: false } } });
    const res = await api(scopedSessionId, `/api/inventory/purchase-requisitions/${prId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'Approved' }),
    });
    expect(res.status).toBe(403);
  });

  it('inventory.approve grants approval authority', async () => {
    await setRolePermissions({ inventory: { access: { enabled: true }, pr: { enabled: false }, po: { enabled: false }, grn: { enabled: false }, stock: { enabled: false }, approve: { enabled: true } } });
    const res = await api(scopedSessionId, `/api/inventory/purchase-requisitions/${prId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'Approved' }),
    });
    expect(res.status).toBe(200);
  });
});

describe('Fiscal months: open and close are separately-grantable authorities', () => {
  it('fiscalMonths.open does not grant closing a month, and vice versa', async () => {
    await setRolePermissions({ fiscalMonths: { open: { enabled: false }, close: { enabled: true } } });
    const openRes = await api(scopedSessionId, `/api/transactions/months?companyId=${companyId}`, {
      method: 'POST',
      body: JSON.stringify({ id: '2026-09', name: 'September 2026', status: 'Open' }),
    });
    expect(openRes.status).toBe(403);

    await setRolePermissions({ fiscalMonths: { open: { enabled: true }, close: { enabled: false } } });
    const closeRes = await api(scopedSessionId, `/api/transactions/months?companyId=${companyId}`, {
      method: 'POST',
      body: JSON.stringify({ id: '2026-08', name: 'August 2026', status: 'Closed' }),
    });
    expect(closeRes.status).toBe(403);

    await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.id, '2026-09'));
  });
});

describe('Bank transfer: separate from routine account editing', () => {
  it('banks.update alone does not grant interbank transfer', async () => {
    const destBankId = generateId();
    await db.insert(schema.bankAccounts).values({
      id: destBankId, bankName: 'PermCrud Dest Bank', accountNumber: '3333',
      accountTitle: 'Dest Holder', openingBalance: '0', isActive: true, isDefault: false, companyId,
    });

    await setRolePermissions({ banks: { create: { enabled: false }, read: { enabled: true }, update: { enabled: true }, delete: { enabled: false }, transfer: { enabled: false } } });
    const blocked = await api(scopedSessionId, '/api/transactions/interbank-transfer', {
      method: 'POST',
      body: JSON.stringify({ sourceBankId: bankId, destBankId, amount: 10, description: 'test', dateStr: '2026-08-01' }),
    });
    expect(blocked.status).toBe(403);

    await setRolePermissions({ banks: { create: { enabled: false }, read: { enabled: true }, update: { enabled: false }, delete: { enabled: false }, transfer: { enabled: true } } });
    const allowed = await api(scopedSessionId, '/api/transactions/interbank-transfer', {
      method: 'POST',
      body: JSON.stringify({ sourceBankId: bankId, destBankId, amount: 10, description: 'test', dateStr: '2026-08-01' }),
    });
    expect(allowed.status).toBe(200);

    await db.delete(schema.vouchers).where(eq(schema.vouchers.companyId, companyId));
    await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.id, destBankId));
  });
});

describe('Tax slabs: POST /tax-slabs branches create-vs-update (regression - used to check .update for both)', () => {
  it('taxSlabs.create=true, update=false allows adding a brand-new slab', async () => {
    await setRolePermissions({
      taxSlabs: { create: { enabled: true }, read: { enabled: true }, update: { enabled: false } },
    });
    const res = await api(scopedSessionId, '/api/tax-slabs', {
      method: 'POST',
      body: JSON.stringify({ id: generateId(), name: 'PermCrud New Slab', percentage: '5', isDefault: false }),
    });
    expect(res.status).toBe(200);
  });

  it('taxSlabs.create=false, update=true blocks adding a brand-new slab', async () => {
    await setRolePermissions({
      taxSlabs: { create: { enabled: false }, read: { enabled: true }, update: { enabled: true } },
    });
    const res = await api(scopedSessionId, '/api/tax-slabs', {
      method: 'POST',
      body: JSON.stringify({ id: generateId(), name: 'PermCrud Blocked Slab', percentage: '5', isDefault: false }),
    });
    expect(res.status).toBe(403);
  });

  it('editing the existing fixture slab requires update, not create', async () => {
    await setRolePermissions({
      taxSlabs: { create: { enabled: true }, read: { enabled: true }, update: { enabled: false } },
    });
    const blocked = await api(scopedSessionId, '/api/tax-slabs', {
      method: 'POST',
      body: JSON.stringify({ id: taxSlabId, name: 'PermCrud 15% Renamed', percentage: '15', isDefault: false }),
    });
    expect(blocked.status).toBe(403);

    await setRolePermissions({
      taxSlabs: { create: { enabled: false }, read: { enabled: true }, update: { enabled: true } },
    });
    const allowed = await api(scopedSessionId, '/api/tax-slabs', {
      method: 'POST',
      body: JSON.stringify({ id: taxSlabId, name: 'PermCrud 15% Renamed', percentage: '15', isDefault: false }),
    });
    expect(allowed.status).toBe(200);
  });
});

// Regression coverage for a real bug found live: PATCH /companies/:id/settings was
// isAdminUser()-only with no delegation path at all, so a Role granting companyProfile.*
// looked fully checked in the Roles editor but every save still 403'd — confirmed by
// reproducing the exact request against a real account before fixing it.
describe('companyProfile delegation on PATCH /companies/:id/settings', () => {
  it('without companyProfile.update, a delegated user is rejected', async () => {
    await setRolePermissions({});
    const res = await api(scopedSessionId, `/api/companies/${companyId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ portalTitle: 'Should Not Save' }),
    });
    expect(res.status).toBe(403);
  });

  it('with companyProfile.update, a delegated (non-admin-tier) user can save profile fields', async () => {
    await setRolePermissions({
      companyProfile: { read: { enabled: true }, update: { enabled: true } },
    });
    const res = await api(scopedSessionId, `/api/companies/${companyId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ portalTitle: 'Delegated Save Works', currency: 'SAR' }),
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const [row] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));
    expect(row.portalTitle).toBe('Delegated Save Works');
  });

  it('companyProfile.update does NOT extend to zatcaEnabled — that stays admin-tier-only', async () => {
    await setRolePermissions({
      companyProfile: { read: { enabled: true }, update: { enabled: true } },
    });
    const res = await api(scopedSessionId, `/api/companies/${companyId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ zatcaEnabled: true }),
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/ZATCA/);

    const [row] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));
    expect(row.zatcaEnabled).toBe(false);
  });

  it('a real company admin can still save profile fields and toggle zatcaEnabled without any Role permission', async () => {
    await setRolePermissions({});
    const profileRes = await api(adminSessionId, `/api/companies/${companyId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ portalTitle: 'Admin Save Works' }),
    });
    expect(profileRes.status).toBe(200);

    const zatcaRes = await api(adminSessionId, `/api/companies/${companyId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ zatcaEnabled: true }),
    });
    expect(zatcaRes.status).toBe(200);

    const [row] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));
    expect(row.zatcaEnabled).toBe(true);
    // Reset for test isolation, in case test ordering elsewhere ever depends on it.
    await db.update(schema.companies).set({ zatcaEnabled: false }).where(eq(schema.companies.id, companyId));
  });
});
