import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real HTTP against the running dev server + real Postgres (no mocks). Covers what the
// "View Report" work added server-side: row paging (with totals still computed over the FULL
// result), the `all=true` print/export path, the Stock Movement Ledger's SQL-level date/
// warehouse/paging, the `?branchId=` filter that can only ever narrow a caller's own scope,
// and the resolved document numbers on ledger rows.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let adminUserId: string;
let adminSession: string;
let staffUserId: string;
let staffSession: string; // restricted to Branch A, may read the two reports below
let roleId: string;
let branchAId: string;
let branchBId: string;
let warehouseAId: string;
let warehouseBId: string;
let productId: string;
let taxSlabId: string;
let customerId: string;
let bankId: string;
let saleInvoiceId: string;
const invoiceIds: string[] = [];

async function login(username: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });
  const body = await res.json().catch(() => null);
  if (!body?.sessionId) throw new Error(`Login failed for ${username}: ${JSON.stringify(body)}`);
  return body.sessionId;
}

async function get(sessionId: string, path: string) {
  const res = await fetch(`${BASE_URL}/api${path}`, { headers: { 'x-session-id': sessionId } });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const LEDGER = '/reports/stock-movement-ledger?startDate=2026-03-10&endDate=2026-03-15';

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: 'Reports View Test Co', address: 'x', phone: '0', email: 'reportsview@example.com',
    logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
  } as any);

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  adminUserId = generateId();
  const adminUsername = `rptview_admin_${adminUserId}`;
  await db.insert(schema.users).values({ id: adminUserId, username: adminUsername, password: passwordHash, role: 'admin', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  adminSession = await login(adminUsername);

  branchAId = generateId();
  branchBId = generateId();
  await db.insert(schema.branches).values([
    { id: branchAId, companyId, name: 'Branch A', code: 'RVA', isActive: true, isDefault: true },
    { id: branchBId, companyId, name: 'Branch B', code: 'RVB', isActive: true },
  ] as any);
  warehouseAId = generateId();
  warehouseBId = generateId();
  await db.insert(schema.warehouses).values([
    { id: warehouseAId, name: 'Warehouse A', code: 'RVWA', isActive: true, companyId, branchId: branchAId, type: 'sales' },
    { id: warehouseBId, name: 'Warehouse B', code: 'RVWB', isActive: true, companyId, branchId: branchBId, type: 'sales' },
  ] as any);

  staffUserId = generateId();
  const staffUsername = `rptview_staff_${staffUserId}`;
  await db.insert(schema.users).values({ id: staffUserId, username: staffUsername, password: passwordHash, role: 'staff', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  roleId = generateId();
  await db.insert(schema.roles).values({
    id: roleId, companyId, name: 'Report Viewer Role',
    permissions: { reports: { stockMovementLedger: { enabled: true }, salesRegister: { enabled: true } } },
  } as any);
  await db.insert(schema.userRoles).values({ userId: staffUserId, roleId });
  await db.insert(schema.userBranches).values({ userId: staffUserId, branchId: branchAId, isPrimary: true });
  staffSession = await login(staffUsername);

  productId = generateId();
  await db.insert(schema.productsServices).values({ id: productId, name: 'Report Widget', description: 'x', unitPrice: '10.00', itemKind: 'item', companyId });
  taxSlabId = generateId();
  await db.insert(schema.taxSlabs).values({ id: taxSlabId, name: 'RptView 15%', percentage: '15', companyId, isDefault: false });
  customerId = generateId();
  await db.insert(schema.customers).values({ id: customerId, name: 'RptView Customer', phone: '0', email: 'c@example.com', address: 'x', companyId, buyerType: 'B2C' } as any);
  bankId = generateId();
  await db.insert(schema.bankAccounts).values({ id: bankId, bankName: 'RptView Bank', accountNumber: '1', accountTitle: 'x', openingBalance: '0', isActive: true, isDefault: true, companyId });

  // 25 invoices, each 1 unit @ 100 + 15% tax = 115.00 → 2875.00 in total.
  for (let i = 0; i < 25; i++) {
    const id = generateId();
    invoiceIds.push(id);
    await db.insert(schema.invoices).values({
      id, invoiceNumber: `INV-RPTVIEW-${String(i).padStart(3, '0')}`, date: '2026-03-12', customerId, taxSlabId, bankId,
      paymentStatus: 'Unpaid', notes: 'x', status: 'Active', createdById: adminUserId, createdAt: new Date('2026-03-12T10:00:00Z'), companyId,
    } as any);
    await db.insert(schema.invoiceItems).values({ id: generateId(), invoiceId: id, description: 'x', unitCost: '100', quantity: '1', discountAmount: '0', taxSlabId, unit: 'PCE' } as any);
  }
  saleInvoiceId = invoiceIds[0];

  // Warehouse A ledger: 12 rows inside the window, plus rows just outside/inside its edges.
  const ledger: any[] = [];
  for (let i = 0; i < 12; i++) {
    ledger.push({ id: generateId(), productId, warehouseId: warehouseAId, transactionType: i === 0 ? 'Sale' : 'Adjustment', referenceId: i === 0 ? saleInvoiceId : generateId(),
      date: new Date(Date.UTC(2026, 2, 10, 10, i, 0)), quantityChange: '1.000', endingQuantity: String(i + 1), batchNumber: null, companyId });
  }
  ledger.push({ id: generateId(), productId, warehouseId: warehouseAId, transactionType: 'Adjustment', referenceId: generateId(), date: new Date('2026-03-15T23:59:59.999Z'), quantityChange: '1.000', endingQuantity: '13', batchNumber: null, companyId }); // last instant of the end date — included
  ledger.push({ id: generateId(), productId, warehouseId: warehouseAId, transactionType: 'Adjustment', referenceId: generateId(), date: new Date('2026-03-16T00:00:00.000Z'), quantityChange: '1.000', endingQuantity: '14', batchNumber: null, companyId }); // next day — excluded
  ledger.push({ id: generateId(), productId, warehouseId: warehouseAId, transactionType: 'Adjustment', referenceId: generateId(), date: new Date('2026-03-09T23:59:59.999Z'), quantityChange: '1.000', endingQuantity: '0', batchNumber: null, companyId }); // day before — excluded
  for (let i = 0; i < 3; i++) {
    ledger.push({ id: generateId(), productId, warehouseId: warehouseBId, transactionType: 'Adjustment', referenceId: generateId(), date: new Date(Date.UTC(2026, 2, 10, 11, i, 0)), quantityChange: '2.000', endingQuantity: String((i + 1) * 2), batchNumber: null, companyId });
  }
  await db.insert(schema.stockLedgerTransactions).values(ledger);
});

afterAll(async () => {
  await db.delete(schema.stockLedgerTransactions).where(eq(schema.stockLedgerTransactions.companyId, companyId));
  if (invoiceIds.length) {
    await db.delete(schema.invoiceItems).where(inArray(schema.invoiceItems.invoiceId, invoiceIds));
    await db.delete(schema.invoices).where(inArray(schema.invoices.id, invoiceIds));
  }
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
  await db.delete(schema.userBranches).where(eq(schema.userBranches.userId, staffUserId));
  await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, staffUserId));
  await db.delete(schema.roles).where(eq(schema.roles.id, roleId));
  await db.delete(schema.users).where(inArray(schema.users.id, [adminUserId, staffUserId]));
  await db.delete(schema.warehouses).where(eq(schema.warehouses.companyId, companyId));
  await db.delete(schema.branches).where(eq(schema.branches.companyId, companyId));
  await db.delete(schema.productsServices).where(eq(schema.productsServices.companyId, companyId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, companyId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
});

describe('Stock Movement Ledger — SQL paging and date window', () => {
  it('pages in SQL: only the requested page comes back, with the full count and ascending order', async () => {
    const p1 = await get(adminSession, `${LEDGER}&page=1&pageSize=10`);
    expect(p1.status).toBe(200);
    expect(p1.body.rows).toHaveLength(10);
    expect(p1.body.pagination).toEqual({ page: 1, pageSize: 10, totalRows: 16, totalPages: 2 });
    const p2 = await get(adminSession, `${LEDGER}&page=2&pageSize=10`);
    expect(p2.body.rows).toHaveLength(6);
    const dates = [...p1.body.rows, ...p2.body.rows].map((r: any) => r.date);
    expect([...dates].sort()).toEqual(dates); // ascending across the page boundary
  });

  it('includes the last instant of the end date and excludes the next day and the day before', async () => {
    const res = await get(adminSession, `${LEDGER}&all=true`);
    expect(res.status).toBe(200);
    const dates: string[] = res.body.rows.map((r: any) => r.date);
    expect(dates).toContain('2026-03-15T23:59:59.999Z');
    expect(dates).not.toContain('2026-03-16T00:00:00.000Z');
    expect(dates).not.toContain('2026-03-09T23:59:59.999Z');
    expect(res.body.rows).toHaveLength(16);
    expect(res.body.pagination).toBeUndefined();
  });

  it('clamps an out-of-range page to the last page and a tiny pageSize up to the minimum', async () => {
    const far = await get(adminSession, `${LEDGER}&page=99&pageSize=10`);
    expect(far.body.pagination.page).toBe(2);
    expect(far.body.rows).toHaveLength(6);
    const tiny = await get(adminSession, `${LEDGER}&page=1&pageSize=1`);
    expect(tiny.body.pagination.pageSize).toBe(10);
  });

  it('resolves the source document number on each row (the invoice that caused a Sale movement)', async () => {
    const res = await get(adminSession, `${LEDGER}&all=true`);
    const sale = res.body.rows.find((r: any) => r.transactionType === 'Sale');
    expect(sale.referenceNumber).toBe('INV-RPTVIEW-000');
    const adjustment = res.body.rows.find((r: any) => r.transactionType === 'Adjustment');
    expect(adjustment.referenceNumber).toBe(''); // adjustments have no backing document
  });

  it('rejects an invalid date instead of returning everything', async () => {
    const res = await get(adminSession, '/reports/stock-movement-ledger?startDate=not-a-date&endDate=2026-03-15');
    expect(res.status).toBe(400);
  });
});

describe('?branchId= only ever narrows the caller’s own scope', () => {
  it('an unrestricted caller sees every branch by default and can narrow to one', async () => {
    const all = await get(adminSession, `${LEDGER}&all=true`);
    expect(all.body.rows).toHaveLength(16);
    const a = await get(adminSession, `${LEDGER}&all=true&branchId=${branchAId}`);
    expect(a.body.rows).toHaveLength(13);
    expect(new Set(a.body.rows.map((r: any) => r.warehouseName))).toEqual(new Set(['Warehouse A']));
    const b = await get(adminSession, `${LEDGER}&all=true&branchId=${branchBId}`);
    expect(b.body.rows).toHaveLength(3);
  });

  it('a Branch-A-restricted caller sees only Branch A, and asking for Branch B yields nothing (never widens)', async () => {
    const mine = await get(staffSession, `${LEDGER}&all=true`);
    expect(mine.status).toBe(200);
    expect(mine.body.rows).toHaveLength(13);
    const other = await get(staffSession, `${LEDGER}&all=true&branchId=${branchBId}`);
    expect(other.status).toBe(200);
    expect(other.body.rows).toHaveLength(0);
  });
});

describe('Row-listing reports page their rows but total over the full result', () => {
  const SALES = '/reports/sales-register?startDate=2026-03-01&endDate=2026-03-31';

  it('returns one page of rows while totalSales still covers all 25 invoices', async () => {
    const res = await get(adminSession, `${SALES}&page=1&pageSize=10`);
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(10);
    expect(res.body.pagination).toEqual({ page: 1, pageSize: 10, totalRows: 25, totalPages: 3 });
    expect(res.body.totalSales).toBe(2875);
    const last = await get(adminSession, `${SALES}&page=3&pageSize=10`);
    expect(last.body.rows).toHaveLength(5);
    expect(last.body.totalSales).toBe(2875);
  });

  it('all=true returns every row, unpaged (print/export path)', async () => {
    const res = await get(adminSession, `${SALES}&all=true`);
    expect(res.body.rows).toHaveLength(25);
    expect(res.body.pagination).toBeUndefined();
    expect(res.body.totalSales).toBe(2875);
  });

  it('a caller without the report permission is still refused, paging or not', async () => {
    const res = await get(staffSession, '/reports/item-wise-sales?startDate=2026-03-01&endDate=2026-03-31&page=1');
    expect(res.status).toBe(403);
  });
});

describe('Financial reports computed server-side (formerly in the browser)', () => {
  const RANGE = 'startDate=2026-03-01&endDate=2026-03-31';

  it('Sales VAT register: one page of rows, subtotal/tax/grand totals over all 25 invoices', async () => {
    const res = await get(adminSession, `/reports/sales-vat?${RANGE}&page=1&pageSize=10`);
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(10);
    expect(res.body.pagination.totalRows).toBe(25);
    expect(res.body.totals).toEqual({ subtotal: 2500, taxAmount: 375, grandTotal: 2875 });
    expect(res.body.rows[0].vatNumber).toBeDefined();
  });

  it('VAT return summary nets output VAT against input VAT', async () => {
    const res = await get(adminSession, `/reports/vat-return-summary?${RANGE}`);
    expect(res.status).toBe(200);
    expect(res.body.outputVat).toBe(375);
    expect(res.body.inputVat).toBe(0);
    expect(res.body.netVatPayable).toBe(375);
    expect(res.body.salesCount).toBe(25);
  });

  it('Purchase VAT register is empty and totals zero for a company with no expenses', async () => {
    const res = await get(adminSession, `/reports/purchase-vat?${RANGE}`);
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
    expect(res.body.totals.grandTotal).toBe(0);
  });

  it('Outstanding: every unpaid invoice counted, totals independent of the page', async () => {
    const res = await get(adminSession, `/reports/outstanding?${RANGE}&page=1&pageSize=10`);
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(10);
    expect(res.body.invoiceCount).toBe(25);
    expect(res.body.totalReceivable).toBe(2875);
    expect(res.body.netOutstanding).toBe(2875);
  });

  it('Bank ledger opening balance includes movements posted before the start date', async () => {
    const mk = (n: string, type: string, date: string, amount: string) => ({
      id: generateId(), voucherNumber: n, type, date, bankId, amount, description: 'rpt test', referenceType: 'Invoice', referenceId: saleInvoiceId,
      createdById: adminUserId, createdAt: new Date(`${date}T09:00:00Z`), companyId,
    });
    await db.insert(schema.vouchers).values([mk('RV-RPT-1', 'Receipt', '2026-02-01', '500.00'), mk('PV-RPT-1', 'Payment', '2026-03-12', '100.00')] as any);
    try {
      const res = await get(adminSession, `/reports/bank-ledger?${RANGE}&bankId=${bankId}`);
      expect(res.status).toBe(200);
      expect(res.body.openingBalance).toBe(500);
      expect(res.body.rows).toHaveLength(1);
      expect(res.body.rows[0].runningBalance).toBe(400);
      expect(res.body.rows[0].sourceDoc).toBe('INV-RPTVIEW-000');
      expect(res.body.endingBalance).toBe(400);
    } finally {
      await db.delete(schema.vouchers).where(eq(schema.vouchers.companyId, companyId));
    }
  });

  it('a caller without the report permission is refused', async () => {
    for (const path of ['sales-vat', 'purchase-vat', 'bank-ledger', 'outstanding', 'vat-return-summary', 'investor-profit-share']) {
      const res = await get(staffSession, `/reports/${path}?${RANGE}`);
      expect(res.status, path).toBe(403);
    }
    expect((await get(staffSession, '/reports/fiscal-month-closing-history')).status).toBe(403);
  });

  it('Investor profit share and fiscal month history respond for an admin', async () => {
    const inv = await get(adminSession, `/reports/investor-profit-share?${RANGE}`);
    expect(inv.status).toBe(200);
    expect(Array.isArray(inv.body.investorShares)).toBe(true);
    const fm = await get(adminSession, '/reports/fiscal-month-closing-history');
    expect(fm.status).toBe(200);
    expect(Array.isArray(fm.body.rows)).toBe(true);
  });
});
