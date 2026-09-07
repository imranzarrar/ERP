import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq, and } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server + real Postgres state, no
// mocks, matching this project's established convention. Covers the Warehouse Transfer
// (Dispatch -> Receiving) feature end to end: stock deduction at dispatch, stock addition
// at receiving using the ACTUAL received quantity (which may differ from dispatched),
// the 1:1 dispatch->receiving fulfillment lock, cancellation + restock, and — the two
// dimensions this session's prior isolation audits kept finding real bugs in for a route
// that accepts more than one foreign key from the client — both tenant (company) and
// branch isolation, checked independently on both the dispatching side and the receiving
// side, since they can legitimately be different users at different branches.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let otherCompanyId: string;
let adminUserId: string;
let adminSessionId: string;
let otherAdminUserId: string;
let otherAdminSessionId: string;
let branchAUserId: string;
let branchASessionId: string;
let branchBUserId: string;
let branchBSessionId: string;
let branchARoleId: string;
let branchBRoleId: string;

let branchAId: string;
let branchBId: string;
let warehouseAId: string; // branch A
let warehouseBId: string; // branch B
let otherWarehouseId: string; // otherCompanyId's own warehouse
let productId: string;
let otherProductId: string; // owned by otherCompanyId

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
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });
  const body = await res.json().catch(() => null);
  if (!body?.sessionId) throw new Error(`Login failed for ${username}: status ${res.status}, body ${JSON.stringify(body)}`);
  return body.sessionId as string;
}

async function stockQty(warehouseId: string, pid: string = productId) {
  const [row] = await db.select().from(schema.inventoryStocks).where(and(
    eq(schema.inventoryStocks.productId, pid),
    eq(schema.inventoryStocks.warehouseId, warehouseId),
  ));
  return row ? Number(row.quantity) : 0;
}

async function seedStock(warehouseId: string, quantity: number, pid: string = productId) {
  await db.insert(schema.inventoryStocks).values({
    id: generateId(), productId: pid, warehouseId, batchNumber: null, quantity: String(quantity), companyId,
  });
}

function makeDispatchPayload(overrides: any = {}) {
  return {
    dispatchData: {
      fromWarehouseId: warehouseAId,
      toWarehouseId: warehouseBId,
      dispatchedBy: 'Test Dispatcher',
      vehicleNumber: 'LKN-9001',
      driverName: 'Test Driver',
      items: [{ productId, quantityDispatched: 10, batchNumber: null }],
      ...overrides,
    },
  };
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  const today = new Date().toISOString().split('T')[0];
  const monthId = today.slice(0, 7);

  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: 'Warehouse Transfer Test Co', address: 'x', phone: '0',
    email: 'whtransfer@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
  });
  await db.insert(schema.fiscalMonths).values({ id: monthId, name: monthId, status: 'Open', companyId }).onConflictDoNothing();

  productId = generateId();
  await db.insert(schema.productsServices).values({ id: productId, name: 'Transfer Widget', description: 'x', unitPrice: '10.00', itemKind: 'item', companyId });

  branchAId = generateId();
  await db.insert(schema.branches).values({ id: branchAId, companyId, name: 'Branch A', code: 'WTA', isActive: true, isDefault: true });
  branchBId = generateId();
  await db.insert(schema.branches).values({ id: branchBId, companyId, name: 'Branch B', code: 'WTB', isActive: true });

  warehouseAId = generateId();
  await db.insert(schema.warehouses).values({ id: warehouseAId, name: 'Warehouse A', code: 'WHA', isActive: true, companyId, branchId: branchAId, type: 'sales' });
  warehouseBId = generateId();
  await db.insert(schema.warehouses).values({ id: warehouseBId, name: 'Warehouse B', code: 'WHB', isActive: true, companyId, branchId: branchBId, type: 'sales' });

  await seedStock(warehouseAId, 1000);

  adminUserId = generateId();
  const adminUsername = `whtransfer_admin_${adminUserId}`;
  await db.insert(schema.users).values({ id: adminUserId, username: adminUsername, password: passwordHash, role: 'admin', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  adminSessionId = await login(adminUsername);

  // Branch-A-restricted user: full dispatch/receiving permissions, but userBranches limits
  // them to Branch A only.
  branchAUserId = generateId();
  const branchAUsername = `whtransfer_brA_${branchAUserId}`;
  await db.insert(schema.users).values({ id: branchAUserId, username: branchAUsername, password: passwordHash, role: 'staff', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  branchARoleId = generateId();
  await db.insert(schema.roles).values({
    id: branchARoleId, companyId, name: 'Branch A Transfer Role',
    permissions: {
      warehouseDispatches: { create: { enabled: true }, read: { enabled: true }, delete: { enabled: true } },
      warehouseReceivings: { create: { enabled: true }, read: { enabled: true } },
    },
  });
  await db.insert(schema.userRoles).values({ userId: branchAUserId, roleId: branchARoleId });
  await db.insert(schema.userBranches).values({ userId: branchAUserId, branchId: branchAId, isPrimary: true });
  branchASessionId = await login(branchAUsername);

  // Same, restricted to Branch B only.
  branchBUserId = generateId();
  const branchBUsername = `whtransfer_brB_${branchBUserId}`;
  await db.insert(schema.users).values({ id: branchBUserId, username: branchBUsername, password: passwordHash, role: 'staff', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  branchBRoleId = generateId();
  await db.insert(schema.roles).values({
    id: branchBRoleId, companyId, name: 'Branch B Transfer Role',
    permissions: {
      warehouseDispatches: { create: { enabled: true }, read: { enabled: true }, delete: { enabled: true } },
      warehouseReceivings: { create: { enabled: true }, read: { enabled: true } },
    },
  });
  await db.insert(schema.userRoles).values({ userId: branchBUserId, roleId: branchBRoleId });
  await db.insert(schema.userBranches).values({ userId: branchBUserId, branchId: branchBId, isPrimary: true });
  branchBSessionId = await login(branchBUsername);

  // A fully separate company/tenant, for cross-company isolation checks.
  otherCompanyId = generateId();
  await db.insert(schema.companies).values({
    id: otherCompanyId, name: 'Other Transfer Test Co', address: 'x', phone: '0',
    email: 'otherwhtransfer@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
  });
  await db.insert(schema.fiscalMonths).values({ id: monthId, name: monthId, status: 'Open', companyId: otherCompanyId }).onConflictDoNothing();
  otherWarehouseId = generateId();
  await db.insert(schema.warehouses).values({ id: otherWarehouseId, name: 'Other Co Warehouse', code: 'OCWH', isActive: true, companyId: otherCompanyId, type: 'sales' });
  otherProductId = generateId();
  await db.insert(schema.productsServices).values({ id: otherProductId, name: 'Other Co Widget', description: 'x', unitPrice: '10.00', itemKind: 'item', companyId: otherCompanyId });
  otherAdminUserId = generateId();
  const otherAdminUsername = `whtransfer_other_admin_${otherAdminUserId}`;
  await db.insert(schema.users).values({ id: otherAdminUserId, username: otherAdminUsername, password: passwordHash, role: 'admin', companyId: otherCompanyId, isSuperAdmin: false, uiLanguage: 'en' });
  otherAdminSessionId = await login(otherAdminUsername);
});

afterAll(async () => {
  // Delete child rows via their own parent-id column (neither item table carries
  // companyId directly), then parents, then everything else — order matters for FKs.
  for (const cid of [companyId, otherCompanyId]) {
    const dispatches = await db.select({ id: schema.warehouseDispatches.id }).from(schema.warehouseDispatches).where(eq(schema.warehouseDispatches.companyId, cid));
    for (const d of dispatches) {
      const receivings = await db.select({ id: schema.warehouseReceivings.id }).from(schema.warehouseReceivings).where(eq(schema.warehouseReceivings.dispatchId, d.id));
      for (const r of receivings) {
        await db.delete(schema.warehouseReceivingItems).where(eq(schema.warehouseReceivingItems.receivingId, r.id));
      }
      await db.delete(schema.warehouseReceivings).where(eq(schema.warehouseReceivings.dispatchId, d.id));
      await db.delete(schema.warehouseDispatchItems).where(eq(schema.warehouseDispatchItems.dispatchId, d.id));
    }
    await db.delete(schema.warehouseDispatches).where(eq(schema.warehouseDispatches.companyId, cid));
    await db.delete(schema.stockLedgerTransactions).where(eq(schema.stockLedgerTransactions.companyId, cid));
    await db.delete(schema.inventoryStocks).where(eq(schema.inventoryStocks.companyId, cid));
    await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, cid));
  }
  await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, branchAUserId));
  await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, branchBUserId));
  await db.delete(schema.roles).where(eq(schema.roles.companyId, companyId));
  await db.delete(schema.userBranches).where(eq(schema.userBranches.userId, branchAUserId));
  await db.delete(schema.userBranches).where(eq(schema.userBranches.userId, branchBUserId));
  await db.delete(schema.warehouses).where(eq(schema.warehouses.companyId, companyId));
  await db.delete(schema.warehouses).where(eq(schema.warehouses.companyId, otherCompanyId));
  await db.delete(schema.branches).where(eq(schema.branches.companyId, companyId));
  await db.delete(schema.productsServices).where(eq(schema.productsServices.companyId, companyId));
  await db.delete(schema.productsServices).where(eq(schema.productsServices.companyId, otherCompanyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, otherCompanyId));
  await db.delete(schema.users).where(eq(schema.users.id, adminUserId));
  await db.delete(schema.users).where(eq(schema.users.id, branchAUserId));
  await db.delete(schema.users).where(eq(schema.users.id, branchBUserId));
  await db.delete(schema.users).where(eq(schema.users.id, otherAdminUserId));
  await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyId));
  await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, otherCompanyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, otherCompanyId));
});

describe('Happy path: dispatch deducts source stock, default-quantity receiving adds destination stock', () => {
  it('creates a dispatch and deducts stock from the source warehouse', async () => {
    const before = await stockQty(warehouseAId);
    const res = await api(adminSessionId, '/api/inventory/warehouse-dispatches', {
      method: 'POST',
      body: JSON.stringify(makeDispatchPayload({ items: [{ productId, quantityDispatched: 10, batchNumber: null }] })),
    });
    expect(res.status).toBe(200);
    expect(res.body.dispatch.status).toBe('Dispatched');
    expect(await stockQty(warehouseAId)).toBe(before - 10);

    const [ledgerRow] = await db.select().from(schema.stockLedgerTransactions).where(and(
      eq(schema.stockLedgerTransactions.referenceId, res.body.dispatch.id),
      eq(schema.stockLedgerTransactions.transactionType, 'TransferOut'),
    ));
    expect(Number(ledgerRow.quantityChange)).toBe(-10);

    // Receive at the default (dispatched) quantity — omit quantityReceived entirely.
    const beforeB = await stockQty(warehouseBId);
    const recvRes = await api(adminSessionId, '/api/inventory/warehouse-receivings', {
      method: 'POST',
      body: JSON.stringify({ receivingData: { dispatchId: res.body.dispatch.id, receivedBy: 'Test Receiver', items: [{ dispatchItemId: res.body.dispatch.items[0].id }] } }),
    });
    expect(recvRes.status).toBe(200);
    expect(await stockQty(warehouseBId)).toBe(beforeB + 10);

    const [dispatchRow] = await db.select().from(schema.warehouseDispatches).where(eq(schema.warehouseDispatches.id, res.body.dispatch.id));
    expect(dispatchRow.status).toBe('Received');

    const [inLedgerRow] = await db.select().from(schema.stockLedgerTransactions).where(and(
      eq(schema.stockLedgerTransactions.referenceId, recvRes.body.receiving.id),
      eq(schema.stockLedgerTransactions.transactionType, 'TransferIn'),
    ));
    expect(Number(inLedgerRow.quantityChange)).toBe(10);
  });
});

describe('Partial/variance receiving', () => {
  it('adds only the actually-received quantity when it differs from dispatched', async () => {
    const dispatchRes = await api(adminSessionId, '/api/inventory/warehouse-dispatches', {
      method: 'POST',
      body: JSON.stringify(makeDispatchPayload({ items: [{ productId, quantityDispatched: 10, batchNumber: null }] })),
    });
    expect(dispatchRes.status).toBe(200);

    const beforeB = await stockQty(warehouseBId);
    const recvRes = await api(adminSessionId, '/api/inventory/warehouse-receivings', {
      method: 'POST',
      body: JSON.stringify({
        receivingData: {
          dispatchId: dispatchRes.body.dispatch.id, receivedBy: 'Test Receiver', discrepancyNotes: 'Two units short — box damaged in transit.',
          items: [{ dispatchItemId: dispatchRes.body.dispatch.items[0].id, quantityReceived: 8 }],
        },
      }),
    });
    expect(recvRes.status).toBe(200);
    expect(await stockQty(warehouseBId)).toBe(beforeB + 8);
    expect(Number(recvRes.body.receiving.items[0].quantityReceived)).toBe(8);
  });
});

describe('Double-receiving is rejected (1:1 fulfillment lock)', () => {
  it('rejects a second receiving against an already-received dispatch', async () => {
    const dispatchRes = await api(adminSessionId, '/api/inventory/warehouse-dispatches', {
      method: 'POST',
      body: JSON.stringify(makeDispatchPayload({ items: [{ productId, quantityDispatched: 5, batchNumber: null }] })),
    });
    const dispatchItemId = dispatchRes.body.dispatch.items[0].id;
    const first = await api(adminSessionId, '/api/inventory/warehouse-receivings', {
      method: 'POST',
      body: JSON.stringify({ receivingData: { dispatchId: dispatchRes.body.dispatch.id, receivedBy: 'R1', items: [{ dispatchItemId }] } }),
    });
    expect(first.status).toBe(200);

    const beforeB = await stockQty(warehouseBId);
    const second = await api(adminSessionId, '/api/inventory/warehouse-receivings', {
      method: 'POST',
      body: JSON.stringify({ receivingData: { dispatchId: dispatchRes.body.dispatch.id, receivedBy: 'R2', items: [{ dispatchItemId }] } }),
    });
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/already been received/i);
    expect(await stockQty(warehouseBId)).toBe(beforeB); // unchanged — no double stock addition
  });

  it('under concurrency, exactly one of two simultaneous receiving requests succeeds', async () => {
    const dispatchRes = await api(adminSessionId, '/api/inventory/warehouse-dispatches', {
      method: 'POST',
      body: JSON.stringify(makeDispatchPayload({ items: [{ productId, quantityDispatched: 6, batchNumber: null }] })),
    });
    const dispatchItemId = dispatchRes.body.dispatch.items[0].id;
    const beforeB = await stockQty(warehouseBId);

    const [r1, r2] = await Promise.all([
      api(adminSessionId, '/api/inventory/warehouse-receivings', {
        method: 'POST',
        body: JSON.stringify({ receivingData: { dispatchId: dispatchRes.body.dispatch.id, receivedBy: 'Concurrent-1', items: [{ dispatchItemId }] } }),
      }),
      api(adminSessionId, '/api/inventory/warehouse-receivings', {
        method: 'POST',
        body: JSON.stringify({ receivingData: { dispatchId: dispatchRes.body.dispatch.id, receivedBy: 'Concurrent-2', items: [{ dispatchItemId }] } }),
      }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 400]);
    expect(await stockQty(warehouseBId)).toBe(beforeB + 6); // stock added exactly once
  });
});

describe('Insufficient source stock is a hard rejection, not a clamp', () => {
  it('rejects and writes nothing when the source warehouse lacks enough stock', async () => {
    const before = await stockQty(warehouseAId);
    const dispatchCountBefore = (await db.select().from(schema.warehouseDispatches).where(eq(schema.warehouseDispatches.companyId, companyId))).length;
    const res = await api(adminSessionId, '/api/inventory/warehouse-dispatches', {
      method: 'POST',
      body: JSON.stringify(makeDispatchPayload({ items: [{ productId, quantityDispatched: before + 1000, batchNumber: null }] })),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/insufficient stock/i);
    expect(await stockQty(warehouseAId)).toBe(before); // unchanged
    const dispatchCountAfter = (await db.select().from(schema.warehouseDispatches).where(eq(schema.warehouseDispatches.companyId, companyId))).length;
    expect(dispatchCountAfter).toBe(dispatchCountBefore); // the whole transaction rolled back, no orphan dispatch row
  });
});

describe('Cancellation restores stock and blocks any later receiving', () => {
  it('cancelling a still-Dispatched record restores source stock and writes a reversing ledger entry', async () => {
    const before = await stockQty(warehouseAId);
    const dispatchRes = await api(adminSessionId, '/api/inventory/warehouse-dispatches', {
      method: 'POST',
      body: JSON.stringify(makeDispatchPayload({ items: [{ productId, quantityDispatched: 7, batchNumber: null }] })),
    });
    expect(await stockQty(warehouseAId)).toBe(before - 7);

    const cancelRes = await api(adminSessionId, `/api/inventory/warehouse-dispatches/${dispatchRes.body.dispatch.id}/cancel`, { method: 'POST' });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.dispatch.status).toBe('Cancelled');
    expect(await stockQty(warehouseAId)).toBe(before);

    const ledgerRowsForDispatch = await db.select().from(schema.stockLedgerTransactions).where(and(
      eq(schema.stockLedgerTransactions.referenceId, dispatchRes.body.dispatch.id),
      eq(schema.stockLedgerTransactions.transactionType, 'TransferOut'),
    ));
    const reversingLedgerRow = ledgerRowsForDispatch.find(r => Number(r.quantityChange) === 7);
    expect(reversingLedgerRow).toBeTruthy();

    // A cancelled dispatch can never be received.
    const recvRes = await api(adminSessionId, '/api/inventory/warehouse-receivings', {
      method: 'POST',
      body: JSON.stringify({ receivingData: { dispatchId: dispatchRes.body.dispatch.id, receivedBy: 'Too Late', items: [{ dispatchItemId: dispatchRes.body.dispatch.items[0].id }] } }),
    });
    expect(recvRes.status).toBe(400);
    expect(recvRes.body.error).toMatch(/cancelled/i);
  });

  it('rejects cancelling an already-received dispatch', async () => {
    const dispatchRes = await api(adminSessionId, '/api/inventory/warehouse-dispatches', {
      method: 'POST',
      body: JSON.stringify(makeDispatchPayload({ items: [{ productId, quantityDispatched: 3, batchNumber: null }] })),
    });
    await api(adminSessionId, '/api/inventory/warehouse-receivings', {
      method: 'POST',
      body: JSON.stringify({ receivingData: { dispatchId: dispatchRes.body.dispatch.id, receivedBy: 'R', items: [{ dispatchItemId: dispatchRes.body.dispatch.items[0].id }] } }),
    });
    const cancelRes = await api(adminSessionId, `/api/inventory/warehouse-dispatches/${dispatchRes.body.dispatch.id}/cancel`, { method: 'POST' });
    expect(cancelRes.status).toBe(400);
    expect(cancelRes.body.error).toMatch(/already been received/i);
  });
});

describe('Cross-branch isolation — both sides of dispatch creation, checked independently', () => {
  it('rejects dispatch creation when the caller lacks access to the DESTINATION branch', async () => {
    // branchAUser has Branch A only; toWarehouseId (warehouseB) is Branch B.
    const res = await api(branchASessionId, '/api/inventory/warehouse-dispatches', {
      method: 'POST',
      body: JSON.stringify(makeDispatchPayload({ items: [{ productId, quantityDispatched: 1, batchNumber: null }] })),
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/destination warehouse/i);
  });

  it('rejects dispatch creation when the caller lacks access to the SOURCE branch', async () => {
    // branchBUser has Branch B only; fromWarehouseId (warehouseA) is Branch A.
    const res = await api(branchBSessionId, '/api/inventory/warehouse-dispatches', {
      method: 'POST',
      body: JSON.stringify(makeDispatchPayload({ items: [{ productId, quantityDispatched: 1, batchNumber: null }] })),
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/source warehouse/i);
  });

  it('rejects receiving creation when the caller lacks access to the destination warehouse\'s branch', async () => {
    // Admin creates a legitimate dispatch into Branch B; branchAUser (no Branch B access)
    // must not be able to receive it, even though they can see/reach the dispatch itself.
    const dispatchRes = await api(adminSessionId, '/api/inventory/warehouse-dispatches', {
      method: 'POST',
      body: JSON.stringify(makeDispatchPayload({ items: [{ productId, quantityDispatched: 2, batchNumber: null }] })),
    });
    const beforeB = await stockQty(warehouseBId);
    const res = await api(branchASessionId, '/api/inventory/warehouse-receivings', {
      method: 'POST',
      body: JSON.stringify({ receivingData: { dispatchId: dispatchRes.body.dispatch.id, receivedBy: 'Blocked', items: [{ dispatchItemId: dispatchRes.body.dispatch.items[0].id }] } }),
    });
    expect(res.status).toBe(403);
    expect(await stockQty(warehouseBId)).toBe(beforeB); // nothing written
  });

  it('allows the branch-B user to receive that same dispatch (they own the destination branch)', async () => {
    const dispatchRes = await api(adminSessionId, '/api/inventory/warehouse-dispatches', {
      method: 'POST',
      body: JSON.stringify(makeDispatchPayload({ items: [{ productId, quantityDispatched: 2, batchNumber: null }] })),
    });
    const beforeB = await stockQty(warehouseBId);
    const res = await api(branchBSessionId, '/api/inventory/warehouse-receivings', {
      method: 'POST',
      body: JSON.stringify({ receivingData: { dispatchId: dispatchRes.body.dispatch.id, receivedBy: 'Branch B User', items: [{ dispatchItemId: dispatchRes.body.dispatch.items[0].id }] } }),
    });
    expect(res.status).toBe(200);
    expect(await stockQty(warehouseBId)).toBe(beforeB + 2);
  });
});

describe('Cross-company isolation', () => {
  it('rejects a dispatch whose fromWarehouseId belongs to another company', async () => {
    // Uses otherProductId (owned by otherCompanyId, the caller's own company) so the
    // request gets past the product-ownership check and actually exercises the
    // cross-company WAREHOUSE check this test is targeting.
    const res = await api(otherAdminSessionId, '/api/inventory/warehouse-dispatches', {
      method: 'POST',
      body: JSON.stringify({ dispatchData: { fromWarehouseId: warehouseAId, toWarehouseId: otherWarehouseId, dispatchedBy: 'Cross', items: [{ productId: otherProductId, quantityDispatched: 1 }] } }),
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/source warehouse/i);
  });

  it('rejects a dispatch whose toWarehouseId belongs to another company', async () => {
    const res = await api(adminSessionId, '/api/inventory/warehouse-dispatches', {
      method: 'POST',
      body: JSON.stringify({ dispatchData: { fromWarehouseId: warehouseAId, toWarehouseId: otherWarehouseId, dispatchedBy: 'Cross', items: [{ productId, quantityDispatched: 1 }] } }),
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/destination warehouse/i);
  });

  it('rejects receiving against a dispatchId belonging to another company', async () => {
    const dispatchRes = await api(adminSessionId, '/api/inventory/warehouse-dispatches', {
      method: 'POST',
      body: JSON.stringify(makeDispatchPayload({ items: [{ productId, quantityDispatched: 1, batchNumber: null }] })),
    });
    const res = await api(otherAdminSessionId, '/api/inventory/warehouse-receivings', {
      method: 'POST',
      body: JSON.stringify({ receivingData: { dispatchId: dispatchRes.body.dispatch.id, receivedBy: 'Cross', items: [{ dispatchItemId: dispatchRes.body.dispatch.items[0].id }] } }),
    });
    expect(res.status).toBe(404);
  });
});

describe('Document numbering under concurrency', () => {
  it('N concurrent dispatch creations get N unique dispatch numbers', async () => {
    const N = 5;
    const results = await Promise.all(
      Array.from({ length: N }).map(() => api(adminSessionId, '/api/inventory/warehouse-dispatches', {
        method: 'POST',
        body: JSON.stringify(makeDispatchPayload({ items: [{ productId, quantityDispatched: 1, batchNumber: null }] })),
      }))
    );
    for (const r of results) expect(r.status).toBe(200);
    const numbers = results.map(r => r.body.dispatch.dispatchNumber);
    expect(new Set(numbers).size).toBe(N);
  });
});

describe('GET /api/state — asymmetric from/to branch filtering', () => {
  it('a dispatch is visible to a branch-restricted user if it LEAVES their warehouse, regardless of destination', async () => {
    // Dispatched FROM Branch A (visible to branchAUser) TO Branch B.
    const dispatchRes = await api(adminSessionId, '/api/inventory/warehouse-dispatches', {
      method: 'POST',
      body: JSON.stringify(makeDispatchPayload({ items: [{ productId, quantityDispatched: 1, batchNumber: null }] })),
    });
    const stateRes = await api(branchASessionId, '/api/state');
    expect(stateRes.status).toBe(200);
    const ids = (stateRes.body.warehouseDispatches || []).map((d: any) => d.id);
    expect(ids).toContain(dispatchRes.body.dispatch.id);
  });

  it('a receiving is visible to a branch-restricted user if it ARRIVED at their warehouse, regardless of source — and the dispatch itself is NOT visible to them', async () => {
    // Admin dispatches FROM Branch A TO Branch B, and receives it too — branchBUser (Branch
    // B only) should see the RECEIVING (arrived at their warehouse) but NOT the DISPATCH
    // (which left Branch A, not Branch B).
    const dispatchRes = await api(adminSessionId, '/api/inventory/warehouse-dispatches', {
      method: 'POST',
      body: JSON.stringify(makeDispatchPayload({ items: [{ productId, quantityDispatched: 1, batchNumber: null }] })),
    });
    const recvRes = await api(adminSessionId, '/api/inventory/warehouse-receivings', {
      method: 'POST',
      body: JSON.stringify({ receivingData: { dispatchId: dispatchRes.body.dispatch.id, receivedBy: 'Admin', items: [{ dispatchItemId: dispatchRes.body.dispatch.items[0].id }] } }),
    });

    const stateRes = await api(branchBSessionId, '/api/state');
    const receivingIds = (stateRes.body.warehouseReceivings || []).map((r: any) => r.id);
    const dispatchIds = (stateRes.body.warehouseDispatches || []).map((d: any) => d.id);
    expect(receivingIds).toContain(recvRes.body.receiving.id);
    expect(dispatchIds).not.toContain(dispatchRes.body.dispatch.id);
  });
});
