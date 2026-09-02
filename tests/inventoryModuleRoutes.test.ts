import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq, and } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server (npm run dev on
// localhost:3000) + real Postgres state, matching this project's established no-mocks
// testing practice. Dedicated throwaway company/users/product/vendor/warehouse, torn down
// in afterAll — never touches the seeded demo companies used for manual QA.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let adminUserId: string;
let adminSessionId: string;
let staffUserId: string; // role 'user', no roles assigned -> every granular permission false
let staffSessionId: string;
let productId: string;
let vendorId: string;
let warehouseId: string;

async function api(sessionId: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    // x-session-id is the documented non-cookie auth path (server.ts's isAuthenticated),
    // used because a plain Node fetch client has no cookie jar.
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

async function createPr(status: 'Pending' | 'Draft' = 'Pending') {
  const prId = generateId();
  await db.insert(schema.purchaseRequisitions).values({
    id: prId,
    prNumber: `PR-TEST-${prId}`,
    requestedBy: 'Automated Test',
    date: new Date(),
    status,
    companyId,
  });
  await db.insert(schema.purchaseRequisitionItems).values({
    id: generateId(),
    requisitionId: prId,
    productId,
    quantity: '5.000',
  });
  return prId;
}

async function createPo(status: 'Sent' | 'Cancelled' | 'Received' = 'Sent') {
  const poId = generateId();
  await db.insert(schema.purchaseOrders).values({
    id: poId,
    poNumber: `PO-TEST-${poId}`,
    vendorId,
    date: new Date(),
    status,
    totalAmount: '100.00',
    companyId,
  });
  return poId;
}

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId,
    name: 'Inventory Routes Test Co',
    address: 'Test Address',
    phone: '0000000000',
    email: 'inventoryroutes@example.com',
    logoUrl: '',
    customHeader: '',
    customFooter: '',
    currency: 'SAR',
    counters: {},
    zatcaEnabled: false,
  });

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

  adminUserId = generateId();
  const adminUsername = `invtest_admin_${adminUserId}`;
  await db.insert(schema.users).values({
    id: adminUserId, username: adminUsername, password: passwordHash,
    role: 'admin', companyId, isSuperAdmin: false, uiLanguage: 'en',
  });

  staffUserId = generateId();
  const staffUsername = `invtest_staff_${staffUserId}`;
  await db.insert(schema.users).values({
    id: staffUserId, username: staffUsername, password: passwordHash,
    role: 'user', companyId, isSuperAdmin: false, uiLanguage: 'en',
  });

  adminSessionId = await login(adminUsername);
  staffSessionId = await login(staffUsername);

  vendorId = generateId();
  await db.insert(schema.vendors).values({
    id: vendorId, name: 'Test Vendor', phone: '0000000000', email: 'vendor@example.com', address: 'x', companyId,
  });

  productId = generateId();
  await db.insert(schema.productsServices).values({
    id: productId, name: 'Test Widget', description: 'x', unitPrice: '10.00', type: 'item', companyId,
  });

  warehouseId = generateId();
  await db.insert(schema.warehouses).values({
    id: warehouseId, name: 'Main Store', code: 'MAIN', address: 'x', isActive: true, companyId,
  });
});

afterAll(async () => {
  await db.delete(schema.inventoryStocks).where(eq(schema.inventoryStocks.companyId, companyId));
  const grns = await db.select().from(schema.goodsReceiptNotes).where(eq(schema.goodsReceiptNotes.companyId, companyId));
  for (const grn of grns) {
    await db.delete(schema.goodsReceiptNoteItems).where(eq(schema.goodsReceiptNoteItems.grnId, grn.id));
  }
  await db.delete(schema.goodsReceiptNotes).where(eq(schema.goodsReceiptNotes.companyId, companyId));
  const pos = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.companyId, companyId));
  for (const po of pos) {
    await db.delete(schema.purchaseOrderItems).where(eq(schema.purchaseOrderItems.purchaseOrderId, po.id));
  }
  await db.delete(schema.purchaseOrders).where(eq(schema.purchaseOrders.companyId, companyId));
  const prs = await db.select().from(schema.purchaseRequisitions).where(eq(schema.purchaseRequisitions.companyId, companyId));
  for (const pr of prs) {
    await db.delete(schema.purchaseRequisitionItems).where(eq(schema.purchaseRequisitionItems.requisitionId, pr.id));
  }
  await db.delete(schema.purchaseRequisitions).where(eq(schema.purchaseRequisitions.companyId, companyId));
  await db.delete(schema.stockLedgerTransactions).where(eq(schema.stockLedgerTransactions.companyId, companyId));
  await db.delete(schema.warehouses).where(eq(schema.warehouses.companyId, companyId));
  await db.delete(schema.productsServices).where(eq(schema.productsServices.companyId, companyId));
  await db.delete(schema.vendors).where(eq(schema.vendors.companyId, companyId));
  // Login itself writes an audit_logs row referencing the user, so that must go first.
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
  await db.delete(schema.users).where(eq(schema.users.id, adminUserId));
  await db.delete(schema.users).where(eq(schema.users.id, staffUserId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
});

describe('POST /api/warehouses (now wired from InventoryModule.tsx)', () => {
  it('persists a warehouse created by an admin', async () => {
    const id = generateId();
    const { status, body } = await api(adminSessionId, '/api/warehouses', {
      method: 'POST',
      body: JSON.stringify({ id, name: 'Secondary Store', code: 'SEC', address: 'y', isActive: true, companyId }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const [row] = await db.select().from(schema.warehouses).where(eq(schema.warehouses.id, id));
    expect(row).toBeTruthy();
    expect(row.name).toBe('Secondary Store');
    expect(row.companyId).toBe(companyId);

    await db.delete(schema.warehouses).where(eq(schema.warehouses.id, id));
  });

  it('rejects warehouse creation for a non-admin (edit permission false)', async () => {
    const id = generateId();
    const { status } = await api(staffSessionId, '/api/warehouses', {
      method: 'POST',
      body: JSON.stringify({ id, name: 'Should Not Exist', code: 'NOPE', companyId }),
    });
    expect(status).toBe(403);
    const rows = await db.select().from(schema.warehouses).where(eq(schema.warehouses.id, id));
    expect(rows.length).toBe(0);
  });
});

describe('PUT/PATCH /api/inventory/purchase-requisitions/:id (edit + withdraw)', () => {
  it('lets the submitter edit a Pending PR\'s items and notes', async () => {
    const prId = await createPr('Pending');
    const { status, body } = await api(adminSessionId, `/api/inventory/purchase-requisitions/${prId}`, {
      method: 'PUT',
      body: JSON.stringify({ prData: { requestedBy: 'Automated Test', notes: 'Updated notes', items: [{ productId, quantity: 9, purpose: 'Revised' }] } }),
    });
    expect(status).toBe(200);
    expect(body.purchaseRequisition.notes).toBe('Updated notes');
    expect(body.purchaseRequisition.items.length).toBe(1);
    expect(Number(body.purchaseRequisition.items[0].quantity)).toBe(9);

    const items = await db.select().from(schema.purchaseRequisitionItems).where(eq(schema.purchaseRequisitionItems.requisitionId, prId));
    expect(items.length).toBe(1); // old item row replaced, not duplicated
  });

  it('rejects editing a PR that is not Pending', async () => {
    const prId = await createPr('Pending');
    await db.update(schema.purchaseRequisitions).set({ status: 'Approved' }).where(eq(schema.purchaseRequisitions.id, prId));
    const { status } = await api(adminSessionId, `/api/inventory/purchase-requisitions/${prId}`, {
      method: 'PUT',
      body: JSON.stringify({ prData: { items: [{ productId, quantity: 1 }] } }),
    });
    expect(status).toBe(400);
  });

  it('rejects a caller without inventory.pr permission from editing', async () => {
    const prId = await createPr('Pending');
    const { status } = await api(staffSessionId, `/api/inventory/purchase-requisitions/${prId}`, {
      method: 'PUT',
      body: JSON.stringify({ prData: { items: [{ productId, quantity: 1 }] } }),
    });
    expect(status).toBe(403);
  });

  it('lets the submitter withdraw a Pending PR', async () => {
    const prId = await createPr('Pending');
    const { status, body } = await api(adminSessionId, `/api/inventory/purchase-requisitions/${prId}/withdraw`, { method: 'PATCH' });
    expect(status).toBe(200);
    expect(body.purchaseRequisition.status).toBe('Cancelled');
  });

  it('rejects withdrawing a PR that is not Pending', async () => {
    const prId = await createPr('Pending');
    await db.update(schema.purchaseRequisitions).set({ status: 'Approved' }).where(eq(schema.purchaseRequisitions.id, prId));
    const { status } = await api(adminSessionId, `/api/inventory/purchase-requisitions/${prId}/withdraw`, { method: 'PATCH' });
    expect(status).toBe(400);
  });

  it('a withdrawn (Cancelled) PR can no longer be used to raise a PO, even under MANDATORY', async () => {
    await db.update(schema.companies).set({ inventorySettings: { prOptionality: 'MANDATORY', isDsdAllowed: true } })
      .where(eq(schema.companies.id, companyId));
    const prId = await createPr('Pending');
    await api(adminSessionId, `/api/inventory/purchase-requisitions/${prId}/withdraw`, { method: 'PATCH' });

    const { status, body } = await api(adminSessionId, '/api/inventory/purchase-orders', {
      method: 'POST',
      body: JSON.stringify({ poData: { vendorId, requisitionId: prId, items: [{ productId, quantityOrdered: 2, unitPrice: 10 }] } }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/not Approved/i);

    await db.update(schema.companies).set({ inventorySettings: { prOptionality: 'OPTIONAL', isDsdAllowed: true } })
      .where(eq(schema.companies.id, companyId));
  });
});

describe('PATCH /api/inventory/purchase-requisitions/:id/status', () => {
  it('lets an admin approve a Pending PR', async () => {
    const prId = await createPr('Pending');
    const { status, body } = await api(adminSessionId, `/api/inventory/purchase-requisitions/${prId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'Approved' }),
    });
    expect(status).toBe(200);
    expect(body.purchaseRequisition.status).toBe('Approved');

    const [row] = await db.select().from(schema.purchaseRequisitions).where(eq(schema.purchaseRequisitions.id, prId));
    expect(row.status).toBe('Approved');
  });

  it('lets an admin reject a Pending PR', async () => {
    const prId = await createPr('Pending');
    const { status, body } = await api(adminSessionId, `/api/inventory/purchase-requisitions/${prId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'Rejected' }),
    });
    expect(status).toBe(200);
    expect(body.purchaseRequisition.status).toBe('Rejected');
  });

  it('rejects a non-admin caller', async () => {
    const prId = await createPr('Pending');
    const { status } = await api(staffSessionId, `/api/inventory/purchase-requisitions/${prId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'Approved' }),
    });
    expect(status).toBe(403);
    const [row] = await db.select().from(schema.purchaseRequisitions).where(eq(schema.purchaseRequisitions.id, prId));
    expect(row.status).toBe('Pending');
  });

  it('rejects an invalid status value', async () => {
    const prId = await createPr('Pending');
    const { status } = await api(adminSessionId, `/api/inventory/purchase-requisitions/${prId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'Bogus' }),
    });
    expect(status).toBe(400);
  });

  it('refuses to re-action a PR that is not Pending', async () => {
    const prId = await createPr('Draft');
    const { status } = await api(adminSessionId, `/api/inventory/purchase-requisitions/${prId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'Approved' }),
    });
    expect(status).toBe(400);
  });

  it('404s for a PR that does not exist', async () => {
    const { status } = await api(adminSessionId, `/api/inventory/purchase-requisitions/${generateId()}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'Approved' }),
    });
    expect(status).toBe(404);
  });
});

describe('PATCH /api/inventory/purchase-orders/:id/cancel', () => {
  it('lets a permitted user cancel a Sent PO', async () => {
    const poId = await createPo('Sent');
    const { status, body } = await api(adminSessionId, `/api/inventory/purchase-orders/${poId}/cancel`, {
      method: 'PATCH',
    });
    expect(status).toBe(200);
    expect(body.purchaseOrder.status).toBe('Cancelled');

    const [row] = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, poId));
    expect(row.status).toBe('Cancelled');
  });

  it('rejects a caller without inventory.po permission', async () => {
    const poId = await createPo('Sent');
    const { status } = await api(staffSessionId, `/api/inventory/purchase-orders/${poId}/cancel`, { method: 'PATCH' });
    expect(status).toBe(403);
    const [row] = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, poId));
    expect(row.status).toBe('Sent');
  });

  it('refuses to cancel a PO that is not Sent', async () => {
    const poId = await createPo('Received');
    const { status } = await api(adminSessionId, `/api/inventory/purchase-orders/${poId}/cancel`, { method: 'PATCH' });
    expect(status).toBe(400);
    const [row] = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, poId));
    expect(row.status).toBe('Received');
  });

  it('404s for a PO that does not exist', async () => {
    const { status } = await api(adminSessionId, `/api/inventory/purchase-orders/${generateId()}/cancel`, { method: 'PATCH' });
    expect(status).toBe(404);
  });
});

describe('POST /api/inventory/stock-adjustments', () => {
  it('creates a new stock row for a positive adjustment with no existing stock', async () => {
    const { status, body } = await api(adminSessionId, '/api/inventory/stock-adjustments', {
      method: 'POST',
      body: JSON.stringify({ productId, warehouseId, quantity: 20, reason: 'Initial count' }),
    });
    expect(status).toBe(200);
    expect(Number(body.inventoryStock.quantity)).toBe(20);

    const [row] = await db.select().from(schema.inventoryStocks).where(eq(schema.inventoryStocks.id, body.inventoryStock.id));
    expect(Number(row.quantity)).toBe(20);
  });

  it('increments an existing stock row rather than creating a duplicate', async () => {
    const { status, body } = await api(adminSessionId, '/api/inventory/stock-adjustments', {
      method: 'POST',
      body: JSON.stringify({ productId, warehouseId, quantity: 5, reason: 'Found extra units' }),
    });
    expect(status).toBe(200);
    expect(Number(body.inventoryStock.quantity)).toBe(25);

    const rows = await db.select().from(schema.inventoryStocks)
      .where(and(eq(schema.inventoryStocks.productId, productId), eq(schema.inventoryStocks.warehouseId, warehouseId), eq(schema.inventoryStocks.companyId, companyId)));
    expect(rows.length).toBe(1);
  });

  it('clamps a negative adjustment at 0 rather than going negative', async () => {
    const { status, body } = await api(adminSessionId, '/api/inventory/stock-adjustments', {
      method: 'POST',
      body: JSON.stringify({ productId, warehouseId, quantity: -1000, reason: 'Damaged stock write-off' }),
    });
    expect(status).toBe(200);
    expect(Number(body.inventoryStock.quantity)).toBe(0);
  });

  it('rejects a negative adjustment with no existing stock row to deduct from', async () => {
    const freshProductId = generateId();
    await db.insert(schema.productsServices).values({
      id: freshProductId, name: 'Fresh Widget', description: 'x', unitPrice: '5.00', type: 'item', companyId,
    });
    const { status } = await api(adminSessionId, '/api/inventory/stock-adjustments', {
      method: 'POST',
      body: JSON.stringify({ productId: freshProductId, warehouseId, quantity: -5, reason: 'Should fail' }),
    });
    expect(status).toBe(400);
    await db.delete(schema.productsServices).where(eq(schema.productsServices.id, freshProductId));
  });

  it('rejects a missing reason', async () => {
    const { status } = await api(adminSessionId, '/api/inventory/stock-adjustments', {
      method: 'POST',
      body: JSON.stringify({ productId, warehouseId, quantity: 5 }),
    });
    expect(status).toBe(400);
  });

  it('rejects a caller without inventory.stock permission', async () => {
    const { status } = await api(staffSessionId, '/api/inventory/stock-adjustments', {
      method: 'POST',
      body: JSON.stringify({ productId, warehouseId, quantity: 5, reason: 'Should be forbidden' }),
    });
    expect(status).toBe(403);
  });
});

// Regression coverage for the "isDsdAllowed / prOptionality are stored but never
// enforced" gap found alongside the nav-visibility bug (BACKLOG.md item 68): both were
// previously just a decorative company-settings checkbox with zero effect on the actual
// GRN/PO routes.
describe('company inventorySettings enforcement (isDsdAllowed / prOptionality)', () => {
  it('rejects a DSD receipt when the company has isDsdAllowed: false', async () => {
    await db.update(schema.companies).set({ inventorySettings: { prOptionality: 'OPTIONAL', isDsdAllowed: false } })
      .where(eq(schema.companies.id, companyId));

    const { status, body } = await api(adminSessionId, '/api/inventory/goods-receipt-notes', {
      method: 'POST',
      body: JSON.stringify({
        grnData: {
          isDsd: true,
          vendorId,
          warehouseId,
          receivedBy: 'Automated Test',
          items: [{ productId, quantityReceived: 3, unitCost: 10 }],
        },
      }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/Direct Shop Delivery is disabled/i);
  });

  it('allows a DSD receipt once isDsdAllowed is true again', async () => {
    await db.update(schema.companies).set({ inventorySettings: { prOptionality: 'OPTIONAL', isDsdAllowed: true } })
      .where(eq(schema.companies.id, companyId));

    const { status, body } = await api(adminSessionId, '/api/inventory/goods-receipt-notes', {
      method: 'POST',
      body: JSON.stringify({
        grnData: {
          isDsd: true,
          vendorId,
          warehouseId,
          receivedBy: 'Automated Test',
          items: [{ productId, quantityReceived: 3, unitCost: 10 }],
        },
      }),
    });
    expect(status).toBe(200);
    expect(body.goodsReceiptNote.isDsd).toBe(true);
  });

  it('rejects a PO with no requisition when prOptionality is MANDATORY', async () => {
    await db.update(schema.companies).set({ inventorySettings: { prOptionality: 'MANDATORY', isDsdAllowed: true } })
      .where(eq(schema.companies.id, companyId));

    const { status, body } = await api(adminSessionId, '/api/inventory/purchase-orders', {
      method: 'POST',
      body: JSON.stringify({ poData: { vendorId, items: [{ productId, quantityOrdered: 2, unitPrice: 10 }] } }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/requires an approved purchase requisition/i);
  });

  it('allows a PO with no requisition when prOptionality is OPTIONAL', async () => {
    await db.update(schema.companies).set({ inventorySettings: { prOptionality: 'OPTIONAL', isDsdAllowed: true } })
      .where(eq(schema.companies.id, companyId));

    const { status } = await api(adminSessionId, '/api/inventory/purchase-orders', {
      method: 'POST',
      body: JSON.stringify({ poData: { vendorId, items: [{ productId, quantityOrdered: 2, unitPrice: 10 }] } }),
    });
    expect(status).toBe(200);
  });

  it('rejects a PO referencing a requisition that is not Approved, in any prOptionality mode', async () => {
    await db.update(schema.companies).set({ inventorySettings: { prOptionality: 'OPTIONAL', isDsdAllowed: true } })
      .where(eq(schema.companies.id, companyId));
    const prId = await createPr('Pending');

    const { status, body } = await api(adminSessionId, '/api/inventory/purchase-orders', {
      method: 'POST',
      body: JSON.stringify({ poData: { vendorId, requisitionId: prId, items: [{ productId, quantityOrdered: 2, unitPrice: 10 }] } }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/not Approved/i);

    const [row] = await db.select().from(schema.purchaseRequisitions).where(eq(schema.purchaseRequisitions.id, prId));
    expect(row.status).toBe('Pending'); // untouched — rejected before the PR gets closed
  });

  it('accepts a PO referencing an Approved requisition and closes it, when MANDATORY', async () => {
    await db.update(schema.companies).set({ inventorySettings: { prOptionality: 'MANDATORY', isDsdAllowed: true } })
      .where(eq(schema.companies.id, companyId));
    const prId = await createPr('Pending');
    await db.update(schema.purchaseRequisitions).set({ status: 'Approved' }).where(eq(schema.purchaseRequisitions.id, prId));

    const { status, body } = await api(adminSessionId, '/api/inventory/purchase-orders', {
      method: 'POST',
      body: JSON.stringify({ poData: { vendorId, requisitionId: prId, items: [{ productId, quantityOrdered: 2, unitPrice: 10 }] } }),
    });
    expect(status).toBe(200);
    expect(body.purchaseOrder.requisitionId).toBe(prId);

    const [row] = await db.select().from(schema.purchaseRequisitions).where(eq(schema.purchaseRequisitions.id, prId));
    expect(row.status).toBe('Closed');

    // Reset — this describe block leaves the company on whatever inventorySettings its
    // last test set; later describe blocks in this file share the same company fixture
    // and assume the OPTIONAL/isDsdAllowed:true default unless they set it themselves.
    await db.update(schema.companies).set({ inventorySettings: { prOptionality: 'OPTIONAL', isDsdAllowed: true } })
      .where(eq(schema.companies.id, companyId));
  });
});

describe('POST /api/inventory/goods-receipt-notes/:id/reverse + average cost', () => {
  it('a DSD GRN folds into the product average cost as a quantity-weighted average', async () => {
    // Reset to a known baseline for this product before asserting exact averages.
    await db.update(schema.productsServices).set({ averageCost: '0', totalQuantityPurchased: '0' }).where(eq(schema.productsServices.id, productId));

    const first = await api(adminSessionId, '/api/inventory/goods-receipt-notes', {
      method: 'POST',
      body: JSON.stringify({ grnData: { isDsd: true, vendorId, warehouseId, receivedBy: 'Automated Test', items: [{ productId, quantityReceived: 10, unitCost: 10 }] } }),
    });
    expect(first.status).toBe(200);
    let [product] = await db.select().from(schema.productsServices).where(eq(schema.productsServices.id, productId));
    expect(Number(product.averageCost)).toBe(10); // (10*0 + 10*10) / 10

    const second = await api(adminSessionId, '/api/inventory/goods-receipt-notes', {
      method: 'POST',
      body: JSON.stringify({ grnData: { isDsd: true, vendorId, warehouseId, receivedBy: 'Automated Test', items: [{ productId, quantityReceived: 10, unitCost: 20 }] } }),
    });
    expect(second.status).toBe(200);
    [product] = await db.select().from(schema.productsServices).where(eq(schema.productsServices.id, productId));
    expect(Number(product.averageCost)).toBe(15); // (10*10 + 10*20) / 20
    expect(Number(product.totalQuantityPurchased)).toBe(20);
  });

  it('reverses stock and PO fulfillment status, but leaves average cost untouched', async () => {
    const poRes = await api(adminSessionId, '/api/inventory/purchase-orders', {
      method: 'POST',
      body: JSON.stringify({ poData: { vendorId, items: [{ productId, quantityOrdered: 5, unitPrice: 10 }] } }),
    });
    const poId = poRes.body.purchaseOrder.id;

    const grnRes = await api(adminSessionId, '/api/inventory/goods-receipt-notes', {
      method: 'POST',
      body: JSON.stringify({ grnData: { purchaseOrderId: poId, warehouseId, receivedBy: 'Automated Test', items: [{ productId, quantityReceived: 5, unitCost: 10 }] } }),
    });
    expect(grnRes.status).toBe(200);
    expect(grnRes.body.updatedPurchaseOrder.status).toBe('Received');
    const grnId = grnRes.body.goodsReceiptNote.id;

    const [productBefore] = await db.select().from(schema.productsServices).where(eq(schema.productsServices.id, productId));
    const avgCostBefore = productBefore.averageCost;

    const [stockBefore] = await db.select().from(schema.inventoryStocks)
      .where(and(eq(schema.inventoryStocks.productId, productId), eq(schema.inventoryStocks.warehouseId, warehouseId), eq(schema.inventoryStocks.companyId, companyId)));
    const qtyBefore = Number(stockBefore.quantity);

    const reverseRes = await api(adminSessionId, `/api/inventory/goods-receipt-notes/${grnId}/reverse`, { method: 'POST' });
    expect(reverseRes.status).toBe(200);
    expect(reverseRes.body.goodsReceiptNote.isReversed).toBe(true);
    expect(reverseRes.body.updatedPurchaseOrder.status).toBe('Sent'); // back to unreceived

    const [stockAfter] = await db.select().from(schema.inventoryStocks)
      .where(and(eq(schema.inventoryStocks.productId, productId), eq(schema.inventoryStocks.warehouseId, warehouseId), eq(schema.inventoryStocks.companyId, companyId)));
    expect(Number(stockAfter.quantity)).toBe(qtyBefore - 5);

    const [productAfter] = await db.select().from(schema.productsServices).where(eq(schema.productsServices.id, productId));
    expect(productAfter.averageCost).toBe(avgCostBefore); // untouched, by design

    const [poAfter] = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, poId));
    expect(poAfter.status).toBe('Sent');
  });

  it('rejects reversing an already-reversed GRN', async () => {
    const grnRes = await api(adminSessionId, '/api/inventory/goods-receipt-notes', {
      method: 'POST',
      body: JSON.stringify({ grnData: { isDsd: true, vendorId, warehouseId, receivedBy: 'Automated Test', items: [{ productId, quantityReceived: 1, unitCost: 5 }] } }),
    });
    const grnId = grnRes.body.goodsReceiptNote.id;
    const first = await api(adminSessionId, `/api/inventory/goods-receipt-notes/${grnId}/reverse`, { method: 'POST' });
    expect(first.status).toBe(200);
    const second = await api(adminSessionId, `/api/inventory/goods-receipt-notes/${grnId}/reverse`, { method: 'POST' });
    expect(second.status).toBe(400);
  });

  it('rejects a caller without inventory.grn permission from reversing', async () => {
    const grnRes = await api(adminSessionId, '/api/inventory/goods-receipt-notes', {
      method: 'POST',
      body: JSON.stringify({ grnData: { isDsd: true, vendorId, warehouseId, receivedBy: 'Automated Test', items: [{ productId, quantityReceived: 1, unitCost: 5 }] } }),
    });
    const grnId = grnRes.body.goodsReceiptNote.id;
    const { status } = await api(staffSessionId, `/api/inventory/goods-receipt-notes/${grnId}/reverse`, { method: 'POST' });
    expect(status).toBe(403);
  });

  it('404s for a GRN that does not exist', async () => {
    const { status } = await api(adminSessionId, `/api/inventory/goods-receipt-notes/${generateId()}/reverse`, { method: 'POST' });
    expect(status).toBe(404);
  });
});
