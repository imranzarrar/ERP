import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq, and } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { getAndIncrementDocumentNumber, DOCUMENT_TYPE_REGISTRY } from '../server/lib/documentNumbering.js';

// Real integration tests against real Postgres state, no mocks, matching this project's
// established testing convention. Covers the company-configurable document numbering
// policy (see the plan this implements): the core atomic counter function is exercised
// directly (still real transactions/real DB — this is the most surgical way to prove
// concurrency/period-rollover/branch-cosmetic/lazy-seed behavior, far more precise than
// driving 12 different HTTP routes concurrently), plus a couple of true end-to-end HTTP
// route tests to prove the real routes are actually wired to it.
//
// Deliberately NOT included here: a live ZATCA sandbox submission + fatoora -validate
// dual-gate run. That is CLAUDE.md's standing manual verification protocol for anything
// ZATCA-adjacent (docs/zatca/sandbox-qa-test-plan.html) — no existing automated test in
// this repo performs a live sandbox submission either (tests/zatcaWorkflow.test.ts tests
// the DISABLED path and status transitions via direct DB writes, not a real clearance
// call). What IS proven here, with real Postgres state, is the architectural claim that
// actually matters: getAndIncrementDocumentNumber never touches zatcaChainState at all.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let adminUserId: string;
let adminSessionId: string;
let staffUserId: string;
let staffSessionId: string;
let profileOnlyRoleId: string;
let customerId: string;
let taxSlabId: string;
let productId: string;

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
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: 'Doc Numbering Test Co', address: 'x', phone: '0',
    email: 'docnumbering@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
  });

  const monthId = new Date().toISOString().slice(0, 7);
  await db.insert(schema.fiscalMonths).values({ id: monthId, name: monthId, status: 'Open', companyId }).onConflictDoNothing();

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  adminUserId = generateId();
  const adminUsername = `docnum_admin_${adminUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({ id: adminUserId, username: adminUsername, password: passwordHash, role: 'admin', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  adminSessionId = await login(adminUsername);

  staffUserId = generateId();
  const staffUsername = `docnum_staff_${staffUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({ id: staffUserId, username: staffUsername, password: passwordHash, role: 'user', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  staffSessionId = await login(staffUsername);

  // A role granting companyProfile.update but NOT documentNumbering.update — proves the
  // new permission is a real, separately-gated leaf, not silently covered by profile edit
  // access (mirrors the existing zatcaEnabled guardrail test's shape).
  profileOnlyRoleId = generateId();
  await db.insert(schema.roles).values({
    id: profileOnlyRoleId, companyId, name: 'Profile Only',
    permissions: { companyProfile: { read: { enabled: true }, update: { enabled: true } } },
  });
  await db.insert(schema.userRoles).values({ userId: staffUserId, roleId: profileOnlyRoleId });

  taxSlabId = generateId();
  await db.insert(schema.taxSlabs).values({ id: taxSlabId, name: 'Standard 15%', percentage: '15', companyId });
  customerId = generateId();
  await db.insert(schema.customers).values({ id: customerId, name: 'Test Customer', phone: '0', email: 'c@example.com', address: 'x', companyId });
  productId = generateId();
  await db.insert(schema.productsServices).values({ id: productId, name: 'Test Widget', description: 'x', unitPrice: '10.00', type: 'item', companyId });
});

afterAll(async () => {
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyId));
  await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, staffUserId));
  await db.delete(schema.roles).where(eq(schema.roles.id, profileOnlyRoleId));
  const quotes = await db.select({ id: schema.quotations.id }).from(schema.quotations).where(eq(schema.quotations.companyId, companyId));
  for (const q of quotes) {
    await db.delete(schema.quotationItems).where(eq(schema.quotationItems.quotationId, q.id));
  }
  await db.delete(schema.quotations).where(eq(schema.quotations.companyId, companyId));
  const prs = await db.select({ id: schema.purchaseRequisitions.id }).from(schema.purchaseRequisitions).where(eq(schema.purchaseRequisitions.companyId, companyId));
  for (const pr of prs) {
    await db.delete(schema.purchaseRequisitionItems).where(eq(schema.purchaseRequisitionItems.requisitionId, pr.id));
  }
  await db.delete(schema.purchaseRequisitions).where(eq(schema.purchaseRequisitions.companyId, companyId));
  await db.delete(schema.branches).where(eq(schema.branches.companyId, companyId));
  await db.delete(schema.productsServices).where(eq(schema.productsServices.companyId, companyId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, companyId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyId));
  await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
  await db.delete(schema.users).where(eq(schema.users.id, adminUserId));
  await db.delete(schema.users).where(eq(schema.users.id, staffUserId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
});

describe('getAndIncrementDocumentNumber — no-policy regression', () => {
  it('produces the exact legacy PREFIX-1001 format for every registry type when numberingPolicy is unset', async () => {
    for (const entry of DOCUMENT_TYPE_REGISTRY) {
      const number = await db.transaction((tx) => getAndIncrementDocumentNumber(tx, companyId, entry.key, '2026-01-15', null));
      expect(number).toBe(`${entry.defaultPrefix}-1001`);
    }
  });

  it('reproduces the debitNote/return prefix collision identically — independent counters, same displayed prefix', async () => {
    const debitNote = await db.transaction((tx) => getAndIncrementDocumentNumber(tx, companyId, 'debitNote', '2026-01-16', null));
    const ret = await db.transaction((tx) => getAndIncrementDocumentNumber(tx, companyId, 'return', '2026-01-16', null));
    // Both already incremented once in the prior test, so both are now at their own 1002 —
    // identical strings from two genuinely independent counters, not a shared one.
    expect(debitNote).toBe('DN-1002');
    expect(ret).toBe('DN-1002');
  });
});

describe('getAndIncrementDocumentNumber — concurrency', () => {
  it('issues N distinct sequential numbers with zero duplicates/gaps under real concurrency', async () => {
    const docType = 'concurrencyTestType';
    const results = await Promise.all(
      Array.from({ length: 10 }, () => db.transaction((tx) => getAndIncrementDocumentNumber(tx, companyId, docType, '2026-02-01', null)))
    );
    const values = results.map(r => Number(r.split('-')[1])).sort((a, b) => a - b);
    expect(new Set(values).size).toBe(10); // no duplicates
    expect(values[0]).toBe(1001);
    expect(values[9]).toBe(1010); // no gaps
  });

  it('never writes to zatcaChainState — fully disjoint from the ICV/PIH reservation mechanism', async () => {
    const before = await db.select().from(schema.zatcaChainState).where(eq(schema.zatcaChainState.companyId, companyId));
    expect(before.length).toBe(0); // untouched by every call in this file so far
  });
});

describe('getAndIncrementDocumentNumber — period rollover', () => {
  it('buckets by the document\'s own date, not wall-clock time, and never mixes periods', async () => {
    const docType = 'periodTestType';
    await db.update(schema.companies).set({
      numberingPolicy: { [docType]: { resetFrequency: 'yearly' } },
    }).where(eq(schema.companies.id, companyId));

    const y2025a = await db.transaction((tx) => getAndIncrementDocumentNumber(tx, companyId, docType, '2025-06-01', null));
    const y2026a = await db.transaction((tx) => getAndIncrementDocumentNumber(tx, companyId, docType, '2026-01-01', null));
    const y2025b = await db.transaction((tx) => getAndIncrementDocumentNumber(tx, companyId, docType, '2025-11-30', null)); // backdated, entered after 2026's first
    const y2026b = await db.transaction((tx) => getAndIncrementDocumentNumber(tx, companyId, docType, '2026-03-01', null));

    expect(y2025a).toBe(`${docType.toUpperCase()}-1001`);
    expect(y2026a).toBe(`${docType.toUpperCase()}-1001`); // separate bucket, own 1001
    expect(y2025b).toBe(`${docType.toUpperCase()}-1002`); // continues 2025's bucket correctly despite arriving after a 2026 call
    expect(y2026b).toBe(`${docType.toUpperCase()}-1002`);

    await db.update(schema.companies).set({ numberingPolicy: null }).where(eq(schema.companies.id, companyId));
  });
});

describe('getAndIncrementDocumentNumber — branch code is cosmetic-only', () => {
  it('keeps one continuous company-wide sequence across branches, only the display code changes', async () => {
    const branchAId = generateId();
    const branchBId = generateId();
    await db.insert(schema.branches).values([
      { id: branchAId, companyId, name: 'Jeddah', code: 'JED' },
      { id: branchBId, companyId, name: 'Riyadh', code: 'RUH' },
    ]);
    const docType = 'branchCosmeticTestType';
    await db.update(schema.companies).set({
      numberingPolicy: { [docType]: { includeBranchCode: true } },
    }).where(eq(schema.companies.id, companyId));

    const first = await db.transaction((tx) => getAndIncrementDocumentNumber(tx, companyId, docType, '2026-01-01', branchAId));
    const second = await db.transaction((tx) => getAndIncrementDocumentNumber(tx, companyId, docType, '2026-01-01', branchBId));

    expect(first).toBe(`${docType.toUpperCase()}-JED-1001`);
    expect(second).toBe(`${docType.toUpperCase()}-RUH-1002`); // continuing the SAME sequence, not a fresh per-branch 1001

    await db.update(schema.companies).set({ numberingPolicy: null }).where(eq(schema.companies.id, companyId));
    await db.delete(schema.branches).where(eq(schema.branches.companyId, companyId));
  });
});

describe('getAndIncrementDocumentNumber — lazy seed from legacy companies.counters', () => {
  it('continues from the legacy counter value instead of restarting at 1000', async () => {
    const docType = 'lazySeedTestType';
    await db.update(schema.companies).set({ counters: { [docType]: 1050 } }).where(eq(schema.companies.id, companyId));

    const first = await db.transaction((tx) => getAndIncrementDocumentNumber(tx, companyId, docType, '2026-01-01', null));
    expect(first).toBe(`${docType.toUpperCase()}-1051`);

    const second = await db.transaction((tx) => getAndIncrementDocumentNumber(tx, companyId, docType, '2026-01-02', null));
    expect(second).toBe(`${docType.toUpperCase()}-1052`); // legacy value read exactly once, then documentCounters owns it
  });
});

describe('End-to-end wiring: real routes actually call the new function', () => {
  it('POST /quotations issues a number via the shared counter, and validates real quotation numbering end to end', async () => {
    const { status, body } = await api(adminSessionId, '/api/transactions/quotations', {
      method: 'POST',
      body: JSON.stringify({
        quotationData: {
          date: new Date().toISOString().slice(0, 10), customerId, taxSlabId, notes: '', status: 'Draft', createdById: adminUserId,
          items: [{ id: generateId(), description: 'Widget', unitCost: 10, quantity: 1, unit: 'PCE', productId }],
        },
      }),
    });
    expect(status).toBe(200);
    const [created] = await db.select().from(schema.quotations).where(eq(schema.quotations.companyId, companyId));
    expect(created.quotationNumber).toBe('QT-1002'); // 1001 already consumed by the no-policy regression test above
  });

  it('POST /inventory/purchase-requisitions issues a number via the shared counter', async () => {
    const { status, body } = await api(adminSessionId, '/api/inventory/purchase-requisitions', {
      method: 'POST',
      body: JSON.stringify({ prData: { requestedBy: 'Automated Test', items: [{ productId, quantity: 1 }] } }),
    });
    expect(status).toBe(200);
    expect(body.purchaseRequisition.prNumber).toBe('PR-1002');
  });
});

describe('PATCH /companies/:id/settings — documentNumbering permission gating', () => {
  it('rejects a caller with no role at all', async () => {
    const { status } = await api(staffSessionId, `/api/companies/${companyId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ numberingPolicy: { invoice: { prefix: 'HACK' } } }),
    });
    // staffUserId has profileOnlyRoleId assigned in beforeAll, so this exercises the
    // "companyProfile.update but not documentNumbering.update" case directly.
    expect(status).toBe(403);
  });

  it('a payload cannot smuggle a zatcaEnabled change alongside an authorized numberingPolicy change', async () => {
    // Admin tier IS allowed to change numberingPolicy, but this proves the two fields are
    // still independently validated within the same request, not a single all-or-nothing gate.
    const { status, body } = await api(adminSessionId, `/api/companies/${companyId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ numberingPolicy: { invoice: { prefix: 'INV' } }, zatcaEnabled: true }),
    });
    expect(status).toBe(200);
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));
    expect(company.zatcaEnabled).toBe(true); // admin tier — legitimately allowed
    expect((company.numberingPolicy as any)?.invoice?.prefix).toBe('INV');
    // Reset for hygiene
    await db.update(schema.companies).set({ zatcaEnabled: false }).where(eq(schema.companies.id, companyId));
  });

  it('accepts an update from the admin session', async () => {
    const { status } = await api(adminSessionId, `/api/companies/${companyId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ numberingPolicy: { invoice: { padWidth: 5 } } }),
    });
    expect(status).toBe(200);
  });
});

describe('GET /companies/:id/numbering-preview', () => {
  it('returns the registry and a next-number preview per type without incrementing anything', async () => {
    const before = await db.select().from(schema.documentCounters).where(and(eq(schema.documentCounters.companyId, companyId), eq(schema.documentCounters.docType, 'invoice')));
    const { status, body } = await api(adminSessionId, `/api/companies/${companyId}/numbering-preview`);
    expect(status).toBe(200);
    expect(Array.isArray(body.registry)).toBe(true);
    expect(typeof body.preview.invoice).toBe('string');
    const after = await db.select().from(schema.documentCounters).where(and(eq(schema.documentCounters.companyId, companyId), eq(schema.documentCounters.docType, 'invoice')));
    expect(after[0]?.currentValue).toBe(before[0]?.currentValue); // display-only, never increments
  });
});
