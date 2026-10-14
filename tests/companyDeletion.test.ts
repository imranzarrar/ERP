import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration test against the already-running dev server + real Postgres, no mocks,
// matching this project's convention (tests/companyOnboarding.test.ts). Builds a full
// throwaway company via the real onboarding-approval flow (so it starts life exactly the
// way a real self-signup Trial company would), seeds a representative sample across the
// deletion routine's dependency chain (product, employee/branch, invoice+line item,
// purchase-order-to-GRN chain), then exercises the whole registration-status +
// "Delete Company & All Data" lifecycle end-to-end.
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let superAdminHomeCompanyId: string;
let superAdminUserId: string;
let superAdminSessionId: string;
let companyAdminUserId: string; // role:'admin' at the super-admin's own home company — for 403 checks
let companyAdminSessionId: string;
let onboardRequestId: string; // survives the purge (detached, not deleted) — must be cleaned up before superAdminUserId in afterAll, since its reviewedById references that user

async function api(sessionId: string | null, path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(sessionId ? { 'x-session-id': sessionId } : {}),
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function login(username: string, password: string = TEST_PASSWORD) {
  const res = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

beforeAll(async () => {
  superAdminHomeCompanyId = generateId();
  await db.insert(schema.companies).values({
    id: superAdminHomeCompanyId, name: 'Deletion Test Super Admin Home', address: 'x', phone: '0',
    email: 'home@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
  });

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

  superAdminUserId = generateId();
  const superAdminUsername = `deltest_super_${superAdminUserId}`;
  await db.insert(schema.users).values({
    id: superAdminUserId, username: superAdminUsername, password: passwordHash,
    role: 'super-admin', companyId: superAdminHomeCompanyId, isSuperAdmin: true, uiLanguage: 'en',
  });

  companyAdminUserId = generateId();
  const companyAdminUsername = `deltest_admin_${companyAdminUserId}`;
  await db.insert(schema.users).values({
    id: companyAdminUserId, username: companyAdminUsername, password: passwordHash,
    role: 'admin', companyId: superAdminHomeCompanyId, isSuperAdmin: false, uiLanguage: 'en',
  });

  superAdminSessionId = (await login(superAdminUsername)).body.sessionId;
  companyAdminSessionId = (await login(companyAdminUsername)).body.sessionId;
});

afterAll(async () => {
  if (onboardRequestId) {
    await db.delete(schema.companyOnboardingRequests).where(eq(schema.companyOnboardingRequests.id, onboardRequestId));
  }
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, superAdminUserId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, companyAdminUserId));
  await db.delete(schema.users).where(eq(schema.users.id, superAdminUserId));
  await db.delete(schema.users).where(eq(schema.users.id, companyAdminUserId));
  await db.delete(schema.companies).where(eq(schema.companies.id, superAdminHomeCompanyId));
});

describe('Company registration status + Delete Company & All Data', () => {
  it('full lifecycle: Trial -> seeded data -> login blocked on Cancelled -> refused-then-allowed purge', async () => {
    // 1. Stand up a real Trial company via the actual onboarding-approval flow.
    const uniq = generateId();
    const onboardId = generateId();
    onboardRequestId = onboardId;
    await db.insert(schema.companyOnboardingRequests).values({
      id: onboardId,
      companyName: `Deletion Test Co ${uniq}`,
      companyEmail: `deltest_${uniq}@example.com`,
      contactName: `Deletion Test Contact ${uniq}`,
      contactEmail: `deltest_contact_${uniq}@example.com`,
      status: 'Pending',
      // This test exercises the delete/purge lifecycle downstream of approval, not the
      // email-confirmation gate itself (see tests/companyOnboarding.test.ts for that) —
      // pre-verified so approve isn't refused for an unrelated reason.
      emailVerifiedAt: new Date(),
    });
    const approve = await api(superAdminSessionId, `/api/admin/onboarding-requests/${onboardId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'admin' }),
    });
    expect(approve.status).toBe(200);
    const companyId = approve.body.companyId as string;
    const targetUserId = approve.body.userId as string;

    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));
    expect(company.registrationStatus).toBe('Trial');

    // Set a real, known password directly (bypassing the email-reset flow — not what this
    // test is about) so login can be exercised before/after cancellation.
    const targetPasswordHash = await bcrypt.hash(TEST_PASSWORD, 10);
    await db.update(schema.users).set({ password: targetPasswordHash }).where(eq(schema.users.id, targetUserId));
    const [targetUser] = await db.select().from(schema.users).where(eq(schema.users.id, targetUserId));

    // Login works while Trial.
    expect((await login(targetUser.username)).status).toBe(200);

    const [defaultBank] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyId));
    const [defaultCustomer] = await db.select().from(schema.customers).where(eq(schema.customers.companyId, companyId));
    const [defaultVendor] = await db.select().from(schema.vendors).where(eq(schema.vendors.companyId, companyId));
    const [defaultTaxSlab] = await db.select().from(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyId));
    const [defaultWarehouse] = await db.select().from(schema.warehouses).where(eq(schema.warehouses.companyId, companyId));

    // 2. Seed a representative sample across the deletion routine's dependency chain.
    const jobTitleId = generateId();
    await db.insert(schema.jobTitles).values({ id: jobTitleId, companyId, title: 'Test Role' });
    const branchId = generateId();
    await db.insert(schema.branches).values({ id: branchId, companyId, name: 'Test Branch', code: 'TB1' });
    const employeeId = generateId();
    await db.insert(schema.employees).values({
      id: employeeId, companyId, employeeNumber: 'EMP-1', name: 'Test Employee',
      jobTitleId, branchId, createdAt: new Date(),
    });

    const categoryId = generateId();
    await db.insert(schema.productCategories).values({ id: categoryId, companyId, name: 'Test Category' });
    const productId = generateId();
    await db.insert(schema.productsServices).values({
      id: productId, companyId, name: 'Test Product', description: 'x', unitPrice: '10.00',
      itemKind: 'item', categoryId, defaultWarehouseId: defaultWarehouse.id,
    });

    const invoiceId = generateId();
    await db.insert(schema.invoices).values({
      id: invoiceId, companyId, invoiceNumber: 'INV-TEST-1', date: '2026-01-01',
      customerId: defaultCustomer.id, taxSlabId: defaultTaxSlab.id, bankId: defaultBank.id,
      paymentStatus: 'Paid', notes: '', status: 'Draft', createdById: targetUserId,
      createdAt: new Date(), branchId, warehouseId: defaultWarehouse.id, salesAssociateId: employeeId,
    });
    await db.insert(schema.invoiceItems).values({
      id: generateId(), invoiceId, description: 'Test line', unitCost: '10.00', quantity: '1.00', productId,
    });

    const poId = generateId();
    await db.insert(schema.purchaseOrders).values({
      id: poId, companyId, poNumber: 'PO-TEST-1', vendorId: defaultVendor.id,
      date: new Date(), totalAmount: '10.00', branchId,
    });
    await db.insert(schema.purchaseOrderItems).values({
      id: generateId(), purchaseOrderId: poId, productId, quantityOrdered: '1.000', unitPrice: '10.00',
    });
    const grnId = generateId();
    await db.insert(schema.goodsReceiptNotes).values({
      id: grnId, companyId, grnNumber: 'GRN-TEST-1', purchaseOrderId: poId, vendorId: defaultVendor.id,
      warehouseId: defaultWarehouse.id, date: new Date(), receivedBy: 'Test',
    });
    await db.insert(schema.goodsReceiptNoteItems).values({
      id: generateId(), grnId, productId, quantityReceived: '1.000', unitCost: '10.00',
    });

    // The general ledger: a posted manual journal with its reversal (self-references both ways), an opening run, and a ledger entry that reverses another.
    const acctIds = await db.select().from(schema.companyAccounts).where(eq(schema.companyAccounts.companyId, companyId));
    const exp = acctIds.find(a => a.code === '6200')!, inc = acctIds.find(a => a.code === '4100')!;
    const mjOrig = generateId(), mjRev = generateId();
    const e1 = generateId(), e2 = generateId();
    const ts = new Date();
    await db.insert(schema.journalEntries).values([
      { id: e1, companyId, date: '2026-01-02', referenceType: 'Manual', referenceId: mjOrig, description: 'orig', createdById: targetUserId, createdAt: ts },
      { id: e2, companyId, date: '2026-01-03', referenceType: 'Manual', referenceId: mjRev, description: 'rev', createdById: targetUserId, createdAt: ts, reversalOfId: e1 },
    ]);
    await db.insert(schema.journalLines).values([
      { id: generateId(), journalEntryId: e1, companyId, accountId: exp.id, debit: '5', credit: '0' }, { id: generateId(), journalEntryId: e1, companyId, accountId: inc.id, debit: '0', credit: '5' },
      { id: generateId(), journalEntryId: e2, companyId, accountId: exp.id, debit: '0', credit: '5' }, { id: generateId(), journalEntryId: e2, companyId, accountId: inc.id, debit: '5', credit: '0' },
    ]);
    await db.insert(schema.manualJournals).values({ id: mjOrig, companyId, number: 'MJ-T1', date: '2026-01-02', description: 'orig', status: 'Posted', preparedById: targetUserId, preparedAt: ts, journalEntryId: e1 });
    await db.insert(schema.manualJournals).values({ id: mjRev, companyId, number: 'MJ-T2', date: '2026-01-03', description: 'rev', status: 'Posted', preparedById: targetUserId, preparedAt: ts, journalEntryId: e2, reversalOfId: mjOrig });
    await db.update(schema.manualJournals).set({ reversedById: mjRev }).where(eq(schema.manualJournals.id, mjOrig));
    await db.insert(schema.manualJournalLines).values({ id: generateId(), journalId: mjOrig, companyId, accountId: exp.id, debit: '5', credit: '0' });
    await db.insert(schema.manualJournalEvents).values({ id: generateId(), journalId: mjOrig, companyId, action: 'Prepared', userId: targetUserId, createdAt: ts });
    await db.insert(schema.openingBalanceRuns).values({ id: generateId(), companyId, cutOffDate: '2026-01-01', journalEntryId: e1, summary: {}, postedById: targetUserId, postedAt: ts });
    // Dimensions: a custom type with a value (and a child), a cost centre under a branch, a tagged line, a rule with a default.
    const dimType = generateId(), dimVal = generateId(), dimKid = generateId(), cc = generateId(), combo = generateId();
    await db.insert(schema.dimensionTypes).values({ id: dimType, companyId, code: 'PC', name: 'Profit centre', valueSource: 'Custom', isHierarchical: true, createdAt: ts });
    await db.insert(schema.dimensionValues).values([{ id: dimVal, companyId, dimensionTypeId: dimType, code: 'A', name: 'A', createdAt: ts }, { id: dimKid, companyId, dimensionTypeId: dimType, code: 'A1', name: 'A1', parentValueId: dimVal, createdAt: ts }]);
    await db.insert(schema.costCenters).values({ id: cc, companyId, code: 'CC', name: 'Cost centre', homeBranchId: branchId, createdAt: ts });
    await db.insert(schema.dimensionCombinations).values({ id: combo, companyId, dedupKey: generateId(), createdAt: ts });
    await db.insert(schema.dimensionCombinationEntries).values({ id: generateId(), companyId, combinationId: combo, dimensionTypeId: dimType, entityId: dimKid, valueId: dimKid });
    await db.update(schema.journalLines).set({ dimensionCombinationId: combo }).where(eq(schema.journalLines.journalEntryId, e1));
    await db.insert(schema.accountDimensionRules).values({ id: generateId(), companyId, accountId: exp.id, dimensionTypeId: dimType, rule: 'optional', defaultValueId: dimVal });
    // a customer's posting profile points at a control account and a default dimension combination
    await db.update(schema.companyAccounts).set({ subledgerType: 'customer', isControl: true }).where(eq(schema.companyAccounts.id, exp.id));
    await db.update(schema.customers).set({ controlAccountId: exp.id, defaultDimensionCombinationId: combo }).where(eq(schema.customers.id, defaultCustomer.id));

    // 3. Registration-status guard rails.
    expect((await api(companyAdminSessionId, `/api/companies/${companyId}/registration-status`, { method: 'PATCH', body: JSON.stringify({ status: 'Cancelled' }) })).status).toBe(403);
    expect((await api(superAdminSessionId, `/api/companies/${companyId}`, { method: 'DELETE' })).status).toBe(400); // still Trial — refused

    const cancel = await api(superAdminSessionId, `/api/companies/${companyId}/registration-status`, { method: 'PATCH', body: JSON.stringify({ status: 'Cancelled' }) });
    expect(cancel.status).toBe(200);

    // 4. Login now blocked for that company's user.
    const blockedLogin = await login(targetUser.username);
    expect(blockedLogin.status).toBe(401);

    // A super-admin's own login is never subject to this check.
    expect((await login((await db.select().from(schema.users).where(eq(schema.users.id, superAdminUserId)))[0].username)).status).toBe(200);

    // 5. Non-super-admin still can't delete.
    expect((await api(companyAdminSessionId, `/api/companies/${companyId}`, { method: 'DELETE' })).status).toBe(403);

    // 6. The actual purge.
    const del = await api(superAdminSessionId, `/api/companies/${companyId}`, { method: 'DELETE' });
    expect(del.status).toBe(200);

    // 7. Everything belonging to the company is gone — spot-check across every tier.
    expect(await db.select().from(schema.companies).where(eq(schema.companies.id, companyId))).toEqual([]);
    expect(await db.select().from(schema.users).where(eq(schema.users.id, targetUserId))).toEqual([]);
    expect(await db.select().from(schema.employees).where(eq(schema.employees.id, employeeId))).toEqual([]);
    expect(await db.select().from(schema.jobTitles).where(eq(schema.jobTitles.id, jobTitleId))).toEqual([]);
    expect(await db.select().from(schema.branches).where(eq(schema.branches.id, branchId))).toEqual([]);
    expect(await db.select().from(schema.productsServices).where(eq(schema.productsServices.id, productId))).toEqual([]);
    expect(await db.select().from(schema.productCategories).where(eq(schema.productCategories.id, categoryId))).toEqual([]);
    expect(await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId))).toEqual([]);
    expect(await db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, invoiceId))).toEqual([]);
    expect(await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, poId))).toEqual([]);
    expect(await db.select().from(schema.purchaseOrderItems).where(eq(schema.purchaseOrderItems.purchaseOrderId, poId))).toEqual([]);
    expect(await db.select().from(schema.goodsReceiptNotes).where(eq(schema.goodsReceiptNotes.id, grnId))).toEqual([]);
    expect(await db.select().from(schema.goodsReceiptNoteItems).where(eq(schema.goodsReceiptNoteItems.grnId, grnId))).toEqual([]);
    expect(await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyId))).toEqual([]);
    expect(await db.select().from(schema.customers).where(eq(schema.customers.companyId, companyId))).toEqual([]);
    expect(await db.select().from(schema.vendors).where(eq(schema.vendors.companyId, companyId))).toEqual([]);
    expect(await db.select().from(schema.warehouses).where(eq(schema.warehouses.companyId, companyId))).toEqual([]);
    expect(await db.select().from(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyId))).toEqual([]);

    // The onboarding request itself survives, just detached.
    const [requestRow] = await db.select().from(schema.companyOnboardingRequests).where(eq(schema.companyOnboardingRequests.id, onboardId));
    expect(requestRow).toBeTruthy();
    expect(requestRow.createdCompanyId).toBeNull();

    // A tombstone was recorded.
    const [logRow] = await db.select().from(schema.deletedCompanyLog).where(eq(schema.deletedCompanyLog.companyId, companyId));
    expect(logRow).toBeTruthy();
    expect(logRow.companyName).toBe(company.name);
    expect(logRow.deletedByUserId).toBe(superAdminUserId);

    // 8. 404 on an already-deleted company for both routes.
    expect((await api(superAdminSessionId, `/api/companies/${companyId}`, { method: 'DELETE' })).status).toBe(404);
    expect((await api(superAdminSessionId, `/api/companies/${companyId}/registration-status`, { method: 'PATCH', body: JSON.stringify({ status: 'Registered' }) })).status).toBe(404);
  });

  it('rejects an invalid registration-status value', async () => {
    const { status, body } = await api(superAdminSessionId, `/api/companies/${superAdminHomeCompanyId}/registration-status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'NotARealStatus' }),
    });
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();
  });

  it('GET /api/state never exposes deletedCompanyLog to a non-super-admin', async () => {
    const nonSuper = await api(companyAdminSessionId, '/api/state');
    expect(nonSuper.status).toBe(200);
    expect(nonSuper.body.deletedCompanyLog).toEqual([]);

    const asSuper = await api(superAdminSessionId, '/api/state');
    expect(asSuper.status).toBe(200);
    expect(Array.isArray(asSuper.body.deletedCompanyLog)).toBe(true);
  });
});
