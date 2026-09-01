import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Covers PosModule.handlePayInvoice's move off the legacy dbStore.saveInvoice + full-
// blob onUpdateDb path onto the real, dedicated POST /api/transactions/invoices route —
// the same one every other invoice-creation path uses. Before this fix, a completed POS
// sale never reached processInvoiceZatca at all: invoices.zatcaStatus stayed at its
// schema default ('NOT_SUBMITTED') forever, regardless of the company's ZATCA
// configuration (BACKLOG.md items 32/40). This test proves the pipeline is now actually
// reached by asserting zatcaStatus moves to 'DISABLED' (the real terminal status
// processInvoiceZatca sets for a company with zatcaEnabled: false) rather than staying
// at 'NOT_SUBMITTED'. Real HTTP against the already-running dev server + real Postgres,
// no mocks, matching this project's established testing convention.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let adminUserId: string;
let adminSessionId: string;
let customerId: string;
let bankId: string;
let taxSlabId: string;
let productId: string;
let warehouseId: string;
let shiftId: string;
let currentMonthId: string;
let createdInvoiceId: string | undefined;

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

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: 'Pos Zatca Pipeline Test Co', address: 'x', phone: '0',
    email: 'poszatca@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
  });

  customerId = generateId();
  await db.insert(schema.customers).values({
    id: customerId, name: 'Walk-in Customer', phone: '-', email: '-', address: '-',
    companyId, buyerType: 'B2C', isSystem: true,
  });

  bankId = generateId();
  await db.insert(schema.bankAccounts).values({
    id: bankId, bankName: 'Main Operating Bank', accountNumber: 'SA123', accountTitle: 'Test Operating Account',
    openingBalance: '0', isActive: true, isDefault: true, companyId,
  });

  taxSlabId = generateId();
  await db.insert(schema.taxSlabs).values({
    id: taxSlabId, name: 'Standard (15%)', percentage: '15', companyId, isDefault: true,
  });

  productId = generateId();
  await db.insert(schema.productsServices).values({
    id: productId, name: 'Test Widget', description: 'Test Widget', unitPrice: '100', type: 'item', unit: 'KGM', companyId,
  });

  // A stock ('item' type) sale now requires a resolvable sales warehouse
  // (server/lib/businessLogic.ts's resolveSaleWarehouse) — a company default is enough
  // since this file only exercises the ZATCA pipeline reach-through, not warehouse routing.
  warehouseId = generateId();
  await db.insert(schema.warehouses).values({
    id: warehouseId, name: 'Main Store', code: 'MAIN', isActive: true, companyId, type: 'sales', isCompanyDefault: true,
  });

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  adminUserId = generateId();
  const adminUsername = `poszatca_admin_${adminUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({
    id: adminUserId, username: adminUsername, password: passwordHash,
    role: 'admin', companyId, isSuperAdmin: false, uiLanguage: 'en',
  });
  adminSessionId = await login(adminUsername);

  // Derived from the same UTC clock as the invoice's own `date` (below, via
  // toISOString().split('T')[0]) — using local getFullYear()/getMonth() here instead
  // produced a real flake for any timezone ahead of UTC (e.g. AST, UTC+3) during the
  // few hours after local midnight but before UTC's own day rolls over, since the
  // invoice's UTC-dated day could then fall in the *previous* UTC month while this row
  // was keyed to the new local month.
  currentMonthId = new Date().toISOString().slice(0, 7);
  await db.insert(schema.fiscalMonths).values({ id: currentMonthId, name: 'Test Month', status: 'Open', companyId });

  shiftId = generateId();
  await db.insert(schema.posShifts).values({
    id: shiftId, companyId, userId: adminUserId, startTime: new Date(), startCash: '0', status: 'open',
  });
});

afterAll(async () => {
  if (createdInvoiceId) {
    await db.delete(schema.vouchers).where(eq(schema.vouchers.referenceId, createdInvoiceId));
    await db.delete(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, createdInvoiceId));
    await db.delete(schema.invoices).where(eq(schema.invoices.id, createdInvoiceId));
  }
  await db.delete(schema.posShifts).where(eq(schema.posShifts.companyId, companyId));
  await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, adminUserId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
  await db.delete(schema.users).where(eq(schema.users.id, adminUserId));
  await db.delete(schema.stockLedgerTransactions).where(eq(schema.stockLedgerTransactions.companyId, companyId));
  await db.delete(schema.inventoryStocks).where(eq(schema.inventoryStocks.companyId, companyId));
  await db.delete(schema.warehouses).where(eq(schema.warehouses.id, warehouseId));
  await db.delete(schema.productsServices).where(eq(schema.productsServices.id, productId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.id, taxSlabId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.id, bankId));
  await db.delete(schema.customers).where(eq(schema.customers.id, customerId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
});

describe('POS sale creation via the real ZATCA-connected invoice route (PosModule.handlePayInvoice)', () => {
  it('creates a real invoice + receipt voucher and reaches processInvoiceZatca, mirroring what handlePayInvoice now sends', async () => {
    const today = new Date().toISOString().split('T')[0];
    const invoiceData = {
      companyId,
      isPosSale: true,
      shiftId,
      customerId,
      taxSlabId,
      bankId,
      date: today,
      paymentStatus: 'Paid',
      amountPaid: 230, // 2 x 100 = 200 subtotal, +15% VAT = 230
      paymentDate: today,
      notes: 'POS Sale',
      status: 'Active',
      originQuotationId: null,
      items: [
        { id: generateId(), description: 'Test Widget', unitCost: 100, quantity: 2, discountAmount: 0, taxSlabId, unit: 'KGM' },
      ],
    };

    const res = await api(adminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({ invoiceData }),
    });
    expect(res.status).toBe(200);
    expect(res.body.invoiceId).toBeTruthy();
    createdInvoiceId = res.body.invoiceId;

    const [invoiceRow] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, createdInvoiceId!));
    expect(invoiceRow?.companyId).toBe(companyId);
    expect(invoiceRow?.isPosSale).toBe(true);
    expect(invoiceRow?.shiftId).toBe(shiftId);
    expect(invoiceRow?.invoiceNumber).toMatch(/^INV-/);
    expect(invoiceRow?.paymentStatus).toBe('Paid');
    expect(Number(invoiceRow?.amountPaid)).toBe(230);

    const itemRows = await db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, createdInvoiceId!));
    expect(itemRows.length).toBe(1);
    expect(itemRows[0].unit).toBe('KGM');

    const voucherRows = await db.select().from(schema.vouchers).where(eq(schema.vouchers.referenceId, createdInvoiceId!));
    expect(voucherRows.length).toBe(1);
    expect(voucherRows[0].type).toBe('Receipt');

    // processInvoiceZatca runs fire-and-forget after the creation transaction commits —
    // poll briefly instead of asserting immediately.
    let finalStatus: string | undefined;
    for (let i = 0; i < 20; i++) {
      const [row] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, createdInvoiceId!));
      finalStatus = row?.zatcaStatus ?? undefined;
      if (finalStatus && finalStatus !== 'NOT_SUBMITTED') break;
      await sleep(250);
    }
    // The real regression this test guards against: before this fix, POS sales never
    // reached processInvoiceZatca at all, so zatcaStatus stayed at its schema default
    // ('NOT_SUBMITTED') forever. This company has zatcaEnabled: false, so the real
    // terminal status here is 'DISABLED', not 'NOT_SUBMITTED'.
    expect(finalStatus).toBe('DISABLED');
  });
});
