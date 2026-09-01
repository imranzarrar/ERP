import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server + real Postgres state,
// no mocks, matching this project's established convention. Covers the VAT Return
// (ZATCA Filing) feature end to end: server-computed figure correctness (including
// Credit Note netting and Purchase Bill inclusion in Input VAT), the generate/delete/
// regenerate lifecycle, the permanent Filed lock, the sequential-filing-order rule, the
// filed-quarter document lock (scoped to VAT-relevant documents only), and permission
// gating. Two companies are used: `companyId` for the main figure/lifecycle/lock tests
// (all around the CURRENT real quarter, since Purchase Bill creation always dates itself
// `new Date()` with no client-supplied date), and `seqCompanyId`, isolated, purely for
// the sequential-filing-order test (arbitrary past quarters with zero underlying data) —
// kept separate so its quarter rows never count as "earlier rows" against companyId's
// own filing of the current quarter.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

const now = new Date();
const currentYear = now.getFullYear();
const currentQuarter = Math.ceil((now.getMonth() + 1) / 3);
const otherQuarter = currentQuarter === 4 ? 1 : 4; // a quarter guaranteed later than currentQuarter within a year we never file, so it never becomes an "earlier row" blocking companyId's real filing
const otherYear = currentQuarter === 4 ? currentYear + 1 : currentYear;

let companyId: string;
let seqCompanyId: string;
let zatcaPendingCompanyId: string;
let adminUserId: string;
let adminSessionId: string;
let readOnlyUserId: string;
let readOnlySessionId: string;
let createReadUserId: string;
let createReadSessionId: string;
let seqAdminUserId: string;
let seqAdminSessionId: string;
let zatcaPendingAdminUserId: string;
let zatcaPendingAdminSessionId: string;
let zatcaPendingCustomerId: string;
let zatcaPendingTaxSlabId: string;
let zatcaPendingBankId: string;
let customerId: string;
let vendorId: string;
let taxSlabId: string;
let bankId: string;
let productId: string;
let warehouseId: string;
let invoiceAId: string;
let invoiceBId: string;
let monthId: string;
let generatedPendingReturnId: string;

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

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: 'Tax Returns Test Co', address: 'x', phone: '0',
    email: 'taxreturns@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
  });
  seqCompanyId = generateId();
  await db.insert(schema.companies).values({
    id: seqCompanyId, name: 'Tax Returns Sequence Test Co', address: 'x', phone: '0',
    email: 'taxreturnsseq@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
  });
  // A third, isolated company purely for the "unreported ZATCA invoice blocks
  // generate/file" scenario — the sequential-filing-order rule blocks a later quarter
  // whenever this company has ANY earlier row at all, regardless of how old or
  // unrelated, so this scenario's quarter must live on a company that never has any
  // other row, rather than sharing companyId or seqCompanyId.
  zatcaPendingCompanyId = generateId();
  await db.insert(schema.companies).values({
    id: zatcaPendingCompanyId, name: 'Tax Returns ZATCA Pending Test Co', address: 'x', phone: '0',
    email: 'taxreturnszatcapending@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
  });

  monthId = now.toISOString().slice(0, 7);
  await db.insert(schema.fiscalMonths).values({ id: monthId, name: monthId, status: 'Open', companyId }).onConflictDoNothing();

  taxSlabId = generateId();
  await db.insert(schema.taxSlabs).values({ id: taxSlabId, name: 'Standard 15%', percentage: '15', companyId });

  customerId = generateId();
  await db.insert(schema.customers).values({ id: customerId, name: 'Test Customer', phone: '0', email: 'c@example.com', address: 'x', companyId });

  vendorId = generateId();
  await db.insert(schema.vendors).values({ id: vendorId, name: 'Test Vendor', phone: '0', email: 'v@example.com', address: 'x', companyId });

  bankId = generateId();
  await db.insert(schema.bankAccounts).values({ id: bankId, bankName: 'Test Bank', accountNumber: '0009991', accountTitle: 'Tax Returns Test Co', openingBalance: '0', isActive: true, isDefault: true, companyId });

  productId = generateId();
  await db.insert(schema.productsServices).values({ id: productId, name: 'Test Widget', description: 'x', unitPrice: '10.00', type: 'item', companyId });

  warehouseId = generateId();
  await db.insert(schema.warehouses).values({ id: warehouseId, name: 'Main Store', code: 'MAIN', address: 'x', isActive: true, companyId });

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

  adminUserId = generateId();
  const adminUsername = `taxret_admin_${adminUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({ id: adminUserId, username: adminUsername, password: passwordHash, role: 'admin', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  adminSessionId = await login(adminUsername);

  // Role with only taxReturns.read — can list, cannot generate/delete/file.
  const readOnlyRoleId = generateId();
  await db.insert(schema.roles).values({ id: readOnlyRoleId, companyId, name: 'TaxReturns Read Only', permissions: { taxReturns: { read: { enabled: true } } } });
  readOnlyUserId = generateId();
  const readOnlyUsername = `taxret_ro_${readOnlyUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({ id: readOnlyUserId, username: readOnlyUsername, password: passwordHash, role: 'user', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  await db.insert(schema.userRoles).values({ userId: readOnlyUserId, roleId: readOnlyRoleId });
  readOnlySessionId = await login(readOnlyUsername);

  // Role with create+read — can generate/list, cannot file/delete.
  const createReadRoleId = generateId();
  await db.insert(schema.roles).values({ id: createReadRoleId, companyId, name: 'TaxReturns Create Read', permissions: { taxReturns: { create: { enabled: true }, read: { enabled: true } } } });
  createReadUserId = generateId();
  const createReadUsername = `taxret_cr_${createReadUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({ id: createReadUserId, username: createReadUsername, password: passwordHash, role: 'user', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  await db.insert(schema.userRoles).values({ userId: createReadUserId, roleId: createReadRoleId });
  createReadSessionId = await login(createReadUsername);

  seqAdminUserId = generateId();
  const seqAdminUsername = `taxret_seq_${seqAdminUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({ id: seqAdminUserId, username: seqAdminUsername, password: passwordHash, role: 'admin', companyId: seqCompanyId, isSuperAdmin: false, uiLanguage: 'en' });
  seqAdminSessionId = await login(seqAdminUsername);

  zatcaPendingAdminUserId = generateId();
  const zatcaPendingAdminUsername = `taxret_zp_${zatcaPendingAdminUserId.slice(0, 8)}`;
  await db.insert(schema.users).values({ id: zatcaPendingAdminUserId, username: zatcaPendingAdminUsername, password: passwordHash, role: 'admin', companyId: zatcaPendingCompanyId, isSuperAdmin: false, uiLanguage: 'en' });
  zatcaPendingAdminSessionId = await login(zatcaPendingAdminUsername);
  zatcaPendingTaxSlabId = generateId();
  await db.insert(schema.taxSlabs).values({ id: zatcaPendingTaxSlabId, name: 'Standard 15%', percentage: '15', companyId: zatcaPendingCompanyId });
  zatcaPendingCustomerId = generateId();
  await db.insert(schema.customers).values({ id: zatcaPendingCustomerId, name: 'Test Customer', phone: '0', email: 'c@example.com', address: 'x', companyId: zatcaPendingCompanyId });
  zatcaPendingBankId = generateId();
  await db.insert(schema.bankAccounts).values({ id: zatcaPendingBankId, bankName: 'Test Bank', accountNumber: '0009992', accountTitle: 'Tax Returns ZATCA Pending Test Co', openingBalance: '0', isActive: true, isDefault: true, companyId: zatcaPendingCompanyId });
});

afterAll(async () => {
  const invoiceIds = await db.select({ id: schema.invoices.id }).from(schema.invoices).where(eq(schema.invoices.companyId, companyId));
  for (const inv of invoiceIds) {
    await db.delete(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, inv.id));
  }
  await db.delete(schema.invoices).where(eq(schema.invoices.companyId, companyId));
  await db.delete(schema.expenses).where(eq(schema.expenses.companyId, companyId));
  const prIds = await db.select({ id: schema.purchaseRequisitions.id }).from(schema.purchaseRequisitions).where(eq(schema.purchaseRequisitions.companyId, companyId));
  for (const pr of prIds) await db.delete(schema.purchaseRequisitionItems).where(eq(schema.purchaseRequisitionItems.requisitionId, pr.id));
  await db.delete(schema.purchaseRequisitions).where(eq(schema.purchaseRequisitions.companyId, companyId));
  const poIds = await db.select({ id: schema.purchaseOrders.id }).from(schema.purchaseOrders).where(eq(schema.purchaseOrders.companyId, companyId));
  for (const po of poIds) await db.delete(schema.purchaseOrderItems).where(eq(schema.purchaseOrderItems.purchaseOrderId, po.id));
  await db.delete(schema.purchaseOrders).where(eq(schema.purchaseOrders.companyId, companyId));
  const billIds = await db.select({ id: schema.purchaseBills.id }).from(schema.purchaseBills).where(eq(schema.purchaseBills.companyId, companyId));
  await db.delete(schema.purchaseBills).where(eq(schema.purchaseBills.companyId, companyId));
  const grnIds = await db.select({ id: schema.goodsReceiptNotes.id }).from(schema.goodsReceiptNotes).where(eq(schema.goodsReceiptNotes.companyId, companyId));
  for (const g of grnIds) await db.delete(schema.goodsReceiptNoteItems).where(eq(schema.goodsReceiptNoteItems.grnId, g.id));
  await db.delete(schema.goodsReceiptNotes).where(eq(schema.goodsReceiptNotes.companyId, companyId));
  const stIds = await db.select({ id: schema.physicalStockTakes.id }).from(schema.physicalStockTakes).where(eq(schema.physicalStockTakes.companyId, companyId));
  for (const st of stIds) await db.delete(schema.physicalStockTakeItems).where(eq(schema.physicalStockTakeItems.stockTakeId, st.id));
  await db.delete(schema.physicalStockTakes).where(eq(schema.physicalStockTakes.companyId, companyId));
  const quoteIds = await db.select({ id: schema.quotations.id }).from(schema.quotations).where(eq(schema.quotations.companyId, companyId));
  for (const q of quoteIds) await db.delete(schema.quotationItems).where(eq(schema.quotationItems.quotationId, q.id));
  await db.delete(schema.quotations).where(eq(schema.quotations.companyId, companyId));
  await db.delete(schema.taxReturns).where(eq(schema.taxReturns.companyId, companyId));
  await db.delete(schema.taxReturns).where(eq(schema.taxReturns.companyId, seqCompanyId));
  await db.delete(schema.taxReturns).where(eq(schema.taxReturns.companyId, zatcaPendingCompanyId));
  await db.delete(schema.invoices).where(eq(schema.invoices.companyId, zatcaPendingCompanyId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, zatcaPendingCompanyId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, zatcaPendingCompanyId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, zatcaPendingCompanyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, zatcaPendingCompanyId));
  await db.delete(schema.users).where(eq(schema.users.id, zatcaPendingAdminUserId));
  await db.delete(schema.companies).where(eq(schema.companies.id, zatcaPendingCompanyId));
  await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, readOnlyUserId));
  await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, createReadUserId));
  await db.delete(schema.roles).where(eq(schema.roles.companyId, companyId));
  await db.delete(schema.stockLedgerTransactions).where(eq(schema.stockLedgerTransactions.companyId, companyId));
  await db.delete(schema.inventoryStocks).where(eq(schema.inventoryStocks.companyId, companyId));
  await db.delete(schema.warehouses).where(eq(schema.warehouses.companyId, companyId));
  await db.delete(schema.productsServices).where(eq(schema.productsServices.companyId, companyId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyId));
  await db.delete(schema.vendors).where(eq(schema.vendors.companyId, companyId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, companyId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyId));
  await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, seqCompanyId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyId));
  await db.delete(schema.users).where(eq(schema.users.id, adminUserId));
  await db.delete(schema.users).where(eq(schema.users.id, readOnlyUserId));
  await db.delete(schema.users).where(eq(schema.users.id, createReadUserId));
  await db.delete(schema.users).where(eq(schema.users.id, seqAdminUserId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, seqCompanyId));
});

describe('Figure correctness (Credit Note netting + Purchase Bill inclusion)', () => {
  it('creates known fixtures: Invoice A (kept), Invoice B + Credit Note (nets to zero), Expense, GRN + Purchase Bill', async () => {
    const today = now.toISOString().split('T')[0];

    const invA = await api(adminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: today, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0,
          items: [{ id: generateId(), description: 'Invoice A item', unitCost: 1000, quantity: 1, unit: 'PCE' }],
        },
      }),
    });
    expect(invA.status).toBe(200);
    invoiceAId = invA.body.invoiceId;

    const invB = await api(adminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: today, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0,
          items: [{ id: generateId(), description: 'Invoice B item', unitCost: 500, quantity: 1, unit: 'PCE' }],
        },
      }),
    });
    expect(invB.status).toBe(200);
    invoiceBId = invB.body.invoiceId;

    const cn = await api(adminSessionId, `/api/transactions/invoices/${invoiceBId}/note`, {
      method: 'POST',
      body: JSON.stringify({ type: 'CreditNote', reason: 'Test reversal' }),
    });
    expect(cn.status).toBe(200);

    const exp = await api(adminSessionId, '/api/expenses', {
      method: 'POST',
      body: JSON.stringify({
        date: today, vendorId, taxSlabId, bankId, description: 'Test expense',
        amount: 115, status: 'Active', type: 'Actual', paymentStatus: 'Unpaid',
      }),
    });
    expect(exp.status).toBe(200);

    const grn = await api(adminSessionId, '/api/inventory/goods-receipt-notes', {
      method: 'POST',
      body: JSON.stringify({
        grnData: { isDsd: true, vendorId, warehouseId, receivedBy: 'Automated Test', items: [{ productId, quantityReceived: 10, unitCost: 100, taxRate: 15 }] },
      }),
    });
    expect(grn.status).toBe(200);
    const bill = await api(adminSessionId, '/api/inventory/purchase-bills', {
      method: 'POST',
      body: JSON.stringify({ billData: { grnIds: [grn.body.goodsReceiptNote.id], bankId } }),
    });
    expect(bill.status).toBe(200);
    expect(Number(bill.body.purchaseBill.subTotal)).toBe(1000);
    expect(Number(bill.body.purchaseBill.taxTotal)).toBe(150);

    // Let the fire-and-forget ZATCA job settle (zatcaEnabled: false -> DISABLED) before
    // any later filing attempt checks for pending e-invoicing status.
    await new Promise(r => setTimeout(r, 700));
  });

  it('generate produces the correct hand-computed figures: Sales=1000, VAT-on-Sales=150, Purchases=1100, VAT-on-Purchases=165, Net Payable=-15', async () => {
    const { status, body } = await api(adminSessionId, '/api/tax-returns/generate', {
      method: 'POST',
      body: JSON.stringify({ year: currentYear, quarter: currentQuarter }),
    });
    expect(status).toBe(200);
    const f = body.taxReturn.figuresSnapshot;
    // Invoice A (1000/150) + Invoice B (500/75) netted by its Credit Note (-500/-75) = 1000/150 net.
    expect(f.salesSubtotal).toBe(1000);
    expect(f.outputVat).toBe(150);
    // Expense (115 incl. 15% VAT -> 100/15) + Purchase Bill (1000/150) = 1100/165.
    expect(f.purchasesSubtotal).toBe(1100);
    expect(f.inputVat).toBe(165);
    expect(f.netVatPayable).toBe(-15); // VAT on Sales (150) minus VAT on Purchases (165)
    expect(body.taxReturn.referenceNumber).toBe(`Q${currentQuarter}-${currentYear}`);
    expect(body.taxReturn.status).toBe('Generated');
  });
});

describe('Generate -> Delete -> Regenerate', () => {
  it('soft-deletes a Generated return and allows a fresh regenerate with the same figures', async () => {
    const [before] = await db.select().from(schema.taxReturns).where(eq(schema.taxReturns.companyId, companyId));
    const originalId = before.id;

    const del = await api(adminSessionId, `/api/tax-returns/${originalId}/delete`, { method: 'POST' });
    expect(del.status).toBe(200);
    const [afterDelete] = await db.select().from(schema.taxReturns).where(eq(schema.taxReturns.id, originalId));
    expect(afterDelete.isDeleted).toBe(true);
    expect(afterDelete.status).toBe('Generated'); // status and isDeleted are orthogonal

    const regen = await api(adminSessionId, '/api/tax-returns/generate', {
      method: 'POST',
      body: JSON.stringify({ year: currentYear, quarter: currentQuarter }),
    });
    expect(regen.status).toBe(200);
    expect(regen.body.taxReturn.id).not.toBe(originalId); // a genuinely new row, not an update-in-place
    expect(regen.body.taxReturn.figuresSnapshot.netVatPayable).toBe(-15);
  });

  it('rejects a duplicate generate while a non-deleted row for the same quarter already exists', async () => {
    const { status, body } = await api(adminSessionId, '/api/tax-returns/generate', {
      method: 'POST',
      body: JSON.stringify({ year: currentYear, quarter: currentQuarter }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(new RegExp(`Q${currentQuarter}-${currentYear}`));
  });
});

describe('Permission gating', () => {
  it('a read-only role can list but gets 403 on generate', async () => {
    const list = await api(readOnlySessionId, '/api/tax-returns');
    expect(list.status).toBe(200);
    const gen = await api(readOnlySessionId, '/api/tax-returns/generate', {
      method: 'POST', body: JSON.stringify({ year: otherYear, quarter: otherQuarter }),
    });
    expect(gen.status).toBe(403);
  });

  it('a create+read role can generate but gets 403 on file and on delete', async () => {
    const gen = await api(createReadSessionId, '/api/tax-returns/generate', {
      method: 'POST', body: JSON.stringify({ year: otherYear, quarter: otherQuarter }),
    });
    expect(gen.status).toBe(200);
    const rowId = gen.body.taxReturn.id;

    const file = await api(createReadSessionId, `/api/tax-returns/${rowId}/file`, { method: 'POST' });
    expect(file.status).toBe(403);
    const del = await api(createReadSessionId, `/api/tax-returns/${rowId}/delete`, { method: 'POST' });
    expect(del.status).toBe(403);

    // read-only role also can't delete this row
    const roDelete = await api(readOnlySessionId, `/api/tax-returns/${rowId}/delete`, { method: 'POST' });
    expect(roDelete.status).toBe(403);
  });
});

describe('Unreported ZATCA invoices block both Generate and File', () => {
  // Runs entirely on zatcaPendingCompanyId, a company that never has any other
  // tax-return row — the sequential-filing-order rule blocks a later quarter whenever
  // the company has ANY earlier row at all, regardless of age or relation, so this
  // scenario needs a company with zero other rows to test the ZATCA-completeness check
  // in isolation, without the sequential-order check (a real, separate 400 condition on
  // the same route) firing first.
  const pendingYear = currentYear;
  const pendingQuarter = 1;
  let pendingInvoiceId: string;

  it('generate is rejected while an Active invoice in the quarter has not completed ZATCA submission', async () => {
    pendingInvoiceId = generateId();
    await db.insert(schema.invoices).values({
      id: pendingInvoiceId, invoiceNumber: `PENDING-${pendingInvoiceId.slice(0, 8)}`,
      date: `${pendingYear}-02-15`, customerId: zatcaPendingCustomerId, taxSlabId: zatcaPendingTaxSlabId, bankId: zatcaPendingBankId, notes: '', status: 'Active',
      paymentStatus: 'Unpaid', createdById: zatcaPendingAdminUserId, createdAt: new Date(), amountPaid: '0',
      companyId: zatcaPendingCompanyId, documentType: 'Invoice', zatcaStatus: 'NOT_SUBMITTED',
    });

    const { status, body } = await api(zatcaPendingAdminSessionId, '/api/tax-returns/generate', {
      method: 'POST', body: JSON.stringify({ year: pendingYear, quarter: pendingQuarter }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/not completed ZATCA e-invoicing submission/i);
  });

  it('generate succeeds once the invoice resolves to a terminal ZATCA state', async () => {
    await db.update(schema.invoices).set({ zatcaStatus: 'CLEARED' }).where(eq(schema.invoices.id, pendingInvoiceId));

    const { status, body } = await api(zatcaPendingAdminSessionId, '/api/tax-returns/generate', {
      method: 'POST', body: JSON.stringify({ year: pendingYear, quarter: pendingQuarter }),
    });
    expect(status).toBe(200);
    generatedPendingReturnId = body.taxReturn.id;
  });

  it('file is independently re-checked: reverting the invoice to a pending state blocks filing even though generate already succeeded', async () => {
    await db.update(schema.invoices).set({ zatcaStatus: 'ERROR' }).where(eq(schema.invoices.id, pendingInvoiceId));

    const { status, body } = await api(zatcaPendingAdminSessionId, `/api/tax-returns/${generatedPendingReturnId}/file`, { method: 'POST' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/not completed ZATCA e-invoicing submission/i);

    // restore so afterAll's invoice cleanup doesn't leave anything ambiguous behind
    await db.update(schema.invoices).set({ zatcaStatus: 'CLEARED' }).where(eq(schema.invoices.id, pendingInvoiceId));
  });
});

describe('Filing, permanent lock, and the filed-quarter document lock', () => {
  let filedReturnId: string;

  it('files the current quarter (passes the ZATCA-completeness and sequential-order checks)', async () => {
    const target = (await db.select().from(schema.taxReturns).where(eq(schema.taxReturns.companyId, companyId)))
      .find(r => r.year === currentYear && r.quarter === currentQuarter && !r.isDeleted)!;
    filedReturnId = target.id;

    const { status, body } = await api(adminSessionId, `/api/tax-returns/${filedReturnId}/file`, { method: 'POST' });
    expect(status).toBe(200);
    expect(body.taxReturn.status).toBe('Filed');
    expect(body.taxReturn.filedById).toBe(adminUserId);
  });

  it('permanently locks the filed row — delete and file both reject', async () => {
    const del = await api(adminSessionId, `/api/tax-returns/${filedReturnId}/delete`, { method: 'POST' });
    expect(del.status).toBe(400);
    const file = await api(adminSessionId, `/api/tax-returns/${filedReturnId}/file`, { method: 'POST' });
    expect(file.status).toBe(400);
  });

  it('blocks new Invoice, Credit Note, Expense, and Purchase Bill dated in the filed quarter', async () => {
    const today = now.toISOString().split('T')[0];

    const newInvoice = await api(adminSessionId, '/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: { date: today, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0, items: [{ id: generateId(), description: 'blocked', unitCost: 10, quantity: 1, unit: 'PCE' }] },
      }),
    });
    expect(newInvoice.status).toBe(400);
    expect(newInvoice.body.error).toMatch(/filed with ZATCA/i);

    const newNote = await api(adminSessionId, `/api/transactions/invoices/${invoiceAId}/note`, {
      method: 'POST',
      body: JSON.stringify({ type: 'DebitNote', reason: 'Should be blocked' }),
    });
    expect(newNote.status).toBe(400);
    expect(newNote.body.error).toMatch(/filed with ZATCA/i);

    const newExpense = await api(adminSessionId, '/api/expenses', {
      method: 'POST',
      body: JSON.stringify({ date: today, vendorId, taxSlabId, bankId, description: 'blocked', amount: 50, status: 'Active', type: 'Actual', paymentStatus: 'Unpaid' }),
    });
    expect(newExpense.status).toBe(400);
    expect(newExpense.body.error).toMatch(/filed with ZATCA/i);

    const grn2 = await api(adminSessionId, '/api/inventory/goods-receipt-notes', {
      method: 'POST',
      body: JSON.stringify({ grnData: { isDsd: true, vendorId, warehouseId, receivedBy: 'Automated Test', items: [{ productId, quantityReceived: 1, unitCost: 10, taxRate: 15 }] } }),
    });
    expect(grn2.status).toBe(200); // GRN itself is not VAT-relevant, not blocked
    const newBill = await api(adminSessionId, '/api/inventory/purchase-bills', {
      method: 'POST',
      body: JSON.stringify({ billData: { grnIds: [grn2.body.goodsReceiptNote.id], bankId } }),
    });
    expect(newBill.status).toBe(400);
    expect(newBill.body.error).toMatch(/filed with ZATCA/i);
  });

  it('does NOT block Quotation, Purchase Requisition, Purchase Order, or Physical Stock Take dated in the filed quarter', async () => {
    const quote = await api(adminSessionId, '/api/transactions/quotations', {
      method: 'POST',
      body: JSON.stringify({
        quotationData: { date: now.toISOString().split('T')[0], customerId, taxSlabId, notes: '', status: 'Draft', createdById: adminUserId, items: [{ id: generateId(), description: 'not blocked', unitCost: 10, quantity: 1, unit: 'PCE' }] },
      }),
    });
    expect(quote.status).toBe(200);

    const pr = await api(adminSessionId, '/api/inventory/purchase-requisitions', {
      method: 'POST',
      body: JSON.stringify({ prData: { requestedBy: 'Automated Test', items: [{ productId, quantity: 1 }] } }),
    });
    expect(pr.status).toBe(200);

    const po = await api(adminSessionId, '/api/inventory/purchase-orders', {
      method: 'POST',
      body: JSON.stringify({ poData: { vendorId, items: [{ productId, quantityOrdered: 1, unitPrice: 10 }] } }),
    });
    expect(po.status).toBe(200);

    const st = await api(adminSessionId, '/api/inventory/stock-takes', {
      method: 'POST',
      body: JSON.stringify({ stockTakeData: { warehouseId, performedBy: 'Automated Test', items: [{ productId, physicalQuantity: 0 }] } }),
    });
    expect(st.status).toBe(200);
  });
});

describe('Sequential filing order (isolated company, zero underlying data)', () => {
  const seqYear = currentYear - 2; // safely in the past, unrelated to companyId's own filed quarter

  it('generates Q1 and Q3, skipping Q2 entirely', async () => {
    const q1 = await api(seqAdminSessionId, '/api/tax-returns/generate', { method: 'POST', body: JSON.stringify({ year: seqYear, quarter: 1 }) });
    expect(q1.status).toBe(200);
    const q3 = await api(seqAdminSessionId, '/api/tax-returns/generate', { method: 'POST', body: JSON.stringify({ year: seqYear, quarter: 3 }) });
    expect(q3.status).toBe(200);
  });

  it('rejects filing Q3 before Q1 is filed', async () => {
    const [q3] = (await db.select().from(schema.taxReturns).where(eq(schema.taxReturns.companyId, seqCompanyId))).filter(r => r.quarter === 3);
    const { status, body } = await api(seqAdminSessionId, `/api/tax-returns/${q3.id}/file`, { method: 'POST' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/must be generated and filed first|must be generated and filed before/i);
  });

  it('files Q1 successfully (no earlier row exists at all)', async () => {
    const [q1] = (await db.select().from(schema.taxReturns).where(eq(schema.taxReturns.companyId, seqCompanyId))).filter(r => r.quarter === 1);
    const { status } = await api(seqAdminSessionId, `/api/tax-returns/${q1.id}/file`, { method: 'POST' });
    expect(status).toBe(200);
  });

  it('still rejects filing Q3 — Q2 was never generated, let alone filed', async () => {
    const [q3] = (await db.select().from(schema.taxReturns).where(eq(schema.taxReturns.companyId, seqCompanyId))).filter(r => r.quarter === 3);
    const { status } = await api(seqAdminSessionId, `/api/tax-returns/${q3.id}/file`, { method: 'POST' });
    expect(status).toBe(400);
  });

  it('generating and filing Q2 unblocks filing Q3', async () => {
    const genQ2 = await api(seqAdminSessionId, '/api/tax-returns/generate', { method: 'POST', body: JSON.stringify({ year: seqYear, quarter: 2 }) });
    expect(genQ2.status).toBe(200);
    const fileQ2 = await api(seqAdminSessionId, `/api/tax-returns/${genQ2.body.taxReturn.id}/file`, { method: 'POST' });
    expect(fileQ2.status).toBe(200);

    const [q3] = (await db.select().from(schema.taxReturns).where(eq(schema.taxReturns.companyId, seqCompanyId))).filter(r => r.quarter === 3);
    const fileQ3 = await api(seqAdminSessionId, `/api/tax-returns/${q3.id}/file`, { method: 'POST' });
    expect(fileQ3.status).toBe(200);
  });
});

describe('Cross-company isolation', () => {
  it('one company cannot list, generate over, delete, or file another company\'s tax returns', async () => {
    const [seqRow] = await db.select().from(schema.taxReturns).where(eq(schema.taxReturns.companyId, seqCompanyId));

    const list = await api(adminSessionId, '/api/tax-returns');
    expect(list.status).toBe(200);
    expect(list.body.every((r: any) => r.companyId === companyId)).toBe(true);

    const del = await api(adminSessionId, `/api/tax-returns/${seqRow.id}/delete`, { method: 'POST' });
    expect(del.status).toBe(404);
    const file = await api(adminSessionId, `/api/tax-returns/${seqRow.id}/file`, { method: 'POST' });
    expect(file.status).toBe(404);
  });
});
