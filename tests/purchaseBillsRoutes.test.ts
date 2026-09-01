import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq, and } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server + real Postgres state,
// matching this project's established no-mocks testing practice. Covers the Purchase
// Bills module (BACKLOG.md) — specifically the Tier-1 "3-way match" control: a bill's
// totals are computed server-side from the GRN it references (never trusted from the
// client), and a GRN can only ever be billed once.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let adminUserId: string;
let adminSessionId: string;
let staffUserId: string;
let staffSessionId: string;
let productId: string;
let vendorId: string;
let vendor2Id: string;
let warehouseId: string;
let bankId: string;

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

async function createGrn(vendor: string, quantityReceived: number, unitCost: number, taxRate = 15) {
  const { status, body } = await api(adminSessionId, '/api/inventory/goods-receipt-notes', {
    method: 'POST',
    body: JSON.stringify({
      grnData: { isDsd: true, vendorId: vendor, warehouseId, receivedBy: 'Automated Test', items: [{ productId, quantityReceived, unitCost, taxRate }] },
    }),
  });
  if (status !== 200) throw new Error(`createGrn failed: ${status} ${JSON.stringify(body)}`);
  return body.goodsReceiptNote.id as string;
}

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: 'PurchaseBills Test Co', address: 'x', phone: '0',
    email: 'purchasebills@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
  });

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  adminUserId = generateId();
  const adminUsername = `pbills_admin_${adminUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({
    id: adminUserId, username: adminUsername, password: passwordHash, role: 'admin', companyId, isSuperAdmin: false, uiLanguage: 'en',
  });
  staffUserId = generateId();
  const staffUsername = `pbills_staff_${staffUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({
    id: staffUserId, username: staffUsername, password: passwordHash, role: 'user', companyId, isSuperAdmin: false, uiLanguage: 'en',
  });
  adminSessionId = await login(adminUsername);
  staffSessionId = await login(staffUsername);

  vendorId = generateId();
  vendor2Id = generateId();
  await db.insert(schema.vendors).values([
    { id: vendorId, name: 'Test Vendor A', phone: '0', email: 'va@example.com', address: 'x', companyId },
    { id: vendor2Id, name: 'Test Vendor B', phone: '0', email: 'vb@example.com', address: 'x', companyId },
  ]);

  productId = generateId();
  await db.insert(schema.productsServices).values({
    id: productId, name: 'Bill Test Widget', description: 'x', unitPrice: '10.00', type: 'item', companyId,
  });

  warehouseId = generateId();
  await db.insert(schema.warehouses).values({ id: warehouseId, name: 'Main Store', code: 'MAIN', address: 'x', isActive: true, companyId });

  bankId = generateId();
  await db.insert(schema.bankAccounts).values({
    id: bankId, bankName: 'Test Bank', accountNumber: '000999', accountTitle: 'PurchaseBills Test Co', openingBalance: '0', companyId,
  });
});

afterAll(async () => {
  await db.delete(schema.vouchers).where(eq(schema.vouchers.companyId, companyId));
  await db.delete(schema.purchaseBills).where(eq(schema.purchaseBills.companyId, companyId));
  await db.delete(schema.inventoryStocks).where(eq(schema.inventoryStocks.companyId, companyId));
  const grns = await db.select({ id: schema.goodsReceiptNotes.id }).from(schema.goodsReceiptNotes).where(eq(schema.goodsReceiptNotes.companyId, companyId));
  for (const g of grns) {
    await db.delete(schema.goodsReceiptNoteItems).where(eq(schema.goodsReceiptNoteItems.grnId, g.id));
  }
  await db.delete(schema.goodsReceiptNotes).where(eq(schema.goodsReceiptNotes.companyId, companyId));
  await db.delete(schema.stockLedgerTransactions).where(eq(schema.stockLedgerTransactions.companyId, companyId));
  await db.delete(schema.warehouses).where(eq(schema.warehouses.companyId, companyId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyId));
  await db.delete(schema.productsServices).where(eq(schema.productsServices.companyId, companyId));
  await db.delete(schema.vendors).where(eq(schema.vendors.companyId, companyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
  await db.delete(schema.users).where(eq(schema.users.id, adminUserId));
  await db.delete(schema.users).where(eq(schema.users.id, staffUserId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
});

describe('POST /api/inventory/purchase-bills (3-way match)', () => {
  it('computes totals server-side from the referenced GRN, not from the client', async () => {
    const grnId = await createGrn(vendorId, 10, 100, 15); // 1000 subtotal, 150 tax
    const { status, body } = await api(adminSessionId, '/api/inventory/purchase-bills', {
      method: 'POST',
      // Deliberately send a bogus grandTotal — the route must ignore it and compute its own.
      body: JSON.stringify({ billData: { grnIds: [grnId], grandTotal: 1, bankId } }),
    });
    expect(status).toBe(200);
    expect(Number(body.purchaseBill.subTotal)).toBe(1000);
    expect(Number(body.purchaseBill.taxTotal)).toBe(150);
    expect(Number(body.purchaseBill.grandTotal)).toBe(1150);
    expect(body.purchaseBill.status).toBe('Unpaid');

    const [grn] = await db.select().from(schema.goodsReceiptNotes).where(eq(schema.goodsReceiptNotes.id, grnId));
    expect(grn.isBilled).toBe(true);
  });

  it('rejects billing the same GRN twice', async () => {
    const grnId = await createGrn(vendorId, 5, 50, 0);
    const first = await api(adminSessionId, '/api/inventory/purchase-bills', {
      method: 'POST',
      body: JSON.stringify({ billData: { grnIds: [grnId], bankId } }),
    });
    expect(first.status).toBe(200);

    const second = await api(adminSessionId, '/api/inventory/purchase-bills', {
      method: 'POST',
      body: JSON.stringify({ billData: { grnIds: [grnId], bankId } }),
    });
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/already been billed/i);
  });

  it('rejects a reversed GRN', async () => {
    const grnId = await createGrn(vendorId, 3, 20, 0);
    await api(adminSessionId, `/api/inventory/goods-receipt-notes/${grnId}/reverse`, { method: 'POST' });

    const { status, body } = await api(adminSessionId, '/api/inventory/purchase-bills', {
      method: 'POST',
      body: JSON.stringify({ billData: { grnIds: [grnId], bankId } }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/reversed/i);
  });

  it('rejects GRNs from two different vendors on one bill', async () => {
    const grnA = await createGrn(vendorId, 1, 10, 0);
    const grnB = await createGrn(vendor2Id, 1, 10, 0);

    const { status, body } = await api(adminSessionId, '/api/inventory/purchase-bills', {
      method: 'POST',
      body: JSON.stringify({ billData: { grnIds: [grnA, grnB], bankId } }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/same vendor/i);
  });

  it('rejects a caller without purchaseBills.create permission', async () => {
    const grnId = await createGrn(vendorId, 1, 10, 0);
    const { status } = await api(staffSessionId, '/api/inventory/purchase-bills', {
      method: 'POST',
      body: JSON.stringify({ billData: { grnIds: [grnId], bankId } }),
    });
    expect(status).toBe(403);
  });
});

describe('POST /api/inventory/purchase-bills/:id/pay + PATCH .../cancel', () => {
  it('supports a partial payment then a final payment reaching Paid', async () => {
    const grnId = await createGrn(vendorId, 10, 100, 0); // grandTotal 1000
    const { body: billBody } = await api(adminSessionId, '/api/inventory/purchase-bills', {
      method: 'POST',
      body: JSON.stringify({ billData: { grnIds: [grnId], bankId } }),
    });
    const billId = billBody.purchaseBill.id;

    const partial = await api(adminSessionId, `/api/inventory/purchase-bills/${billId}/pay`, {
      method: 'POST',
      body: JSON.stringify({ date: '2026-01-01', amount: 400 }),
    });
    expect(partial.status).toBe(200);
    let [bill] = await db.select().from(schema.purchaseBills).where(eq(schema.purchaseBills.id, billId));
    expect(bill.status).toBe('Partially Paid');
    expect(Number(bill.amountPaid)).toBe(400);

    const final = await api(adminSessionId, `/api/inventory/purchase-bills/${billId}/pay`, {
      method: 'POST',
      body: JSON.stringify({ date: '2026-01-02' }), // no amount -> pays the remainder
    });
    expect(final.status).toBe(200);
    [bill] = await db.select().from(schema.purchaseBills).where(eq(schema.purchaseBills.id, billId));
    expect(bill.status).toBe('Paid');
    expect(Number(bill.amountPaid)).toBe(1000);

    const vouchers = await db.select().from(schema.vouchers)
      .where(and(eq(schema.vouchers.referenceType, 'PurchaseBill'), eq(schema.vouchers.referenceId, billId)));
    expect(vouchers.length).toBe(2);
  });

  it('rejects overpaying beyond the remaining balance', async () => {
    const grnId = await createGrn(vendorId, 1, 100, 0);
    const { body: billBody } = await api(adminSessionId, '/api/inventory/purchase-bills', {
      method: 'POST',
      body: JSON.stringify({ billData: { grnIds: [grnId], bankId } }),
    });
    const { status } = await api(adminSessionId, `/api/inventory/purchase-bills/${billBody.purchaseBill.id}/pay`, {
      method: 'POST',
      body: JSON.stringify({ date: '2026-01-01', amount: 99999 }),
    });
    expect(status).toBe(400);
  });

  it('cancelling an Unpaid bill releases the GRN so it can be re-billed', async () => {
    const grnId = await createGrn(vendorId, 1, 10, 0);
    const { body: billBody } = await api(adminSessionId, '/api/inventory/purchase-bills', {
      method: 'POST',
      body: JSON.stringify({ billData: { grnIds: [grnId], bankId } }),
    });
    const billId = billBody.purchaseBill.id;

    const cancelRes = await api(adminSessionId, `/api/inventory/purchase-bills/${billId}/cancel`, { method: 'PATCH' });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.purchaseBill.status).toBe('Cancelled');

    const [grn] = await db.select().from(schema.goodsReceiptNotes).where(eq(schema.goodsReceiptNotes.id, grnId));
    expect(grn.isBilled).toBe(false);

    const rebill = await api(adminSessionId, '/api/inventory/purchase-bills', {
      method: 'POST',
      body: JSON.stringify({ billData: { grnIds: [grnId], bankId } }),
    });
    expect(rebill.status).toBe(200);
  });

  it('cannot cancel a bill that already has a payment posted', async () => {
    const grnId = await createGrn(vendorId, 1, 100, 0);
    const { body: billBody } = await api(adminSessionId, '/api/inventory/purchase-bills', {
      method: 'POST',
      body: JSON.stringify({ billData: { grnIds: [grnId], bankId } }),
    });
    const billId = billBody.purchaseBill.id;
    await api(adminSessionId, `/api/inventory/purchase-bills/${billId}/pay`, { method: 'POST', body: JSON.stringify({ date: '2026-01-01', amount: 10 }) });

    const { status } = await api(adminSessionId, `/api/inventory/purchase-bills/${billId}/cancel`, { method: 'PATCH' });
    expect(status).toBe(400);
  });
});
