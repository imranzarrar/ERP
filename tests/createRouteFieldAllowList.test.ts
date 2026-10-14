import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { provisionStarterResources } from '../server/lib/companyProvisioning.js';
import { purgeCompany } from './helpers/purgeCompany.js';

// The create routes build the stored row from the fields their screens send. A crafted request that names a server-owned field (ZATCA
// state, status, created-by/at, numbers, the reversal/accrual links, the document type) must not be able to set it.
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const PW = 'AutoTest_Pw_2026!';
const NAME = 'Create Allow-list Test Co';
const today = new Date().toISOString().slice(0, 10);

let companyId = '', userId = '', sessionId = '', bankId = '', customerId = '', taxSlabId = '', vendorId = '';
async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, ...(init.headers || {}) } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const post = (p: string, b: any) => api(p, { method: 'POST', body: JSON.stringify(b) });

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: NAME, address: 'x', phone: '0', email: 'al@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false,
  } as any);
  await db.transaction(async (tx: any) => provisionStarterResources(tx, { companyId, companyName: NAME }));
  const one = async (table: any, col: any) => (await db.select().from(table).where(eq(col, companyId)))[0] as any;
  bankId = (await one(schema.bankAccounts, schema.bankAccounts.companyId)).id;
  customerId = (await one(schema.customers, schema.customers.companyId)).id;
  taxSlabId = (await one(schema.taxSlabs, schema.taxSlabs.companyId)).id;
  vendorId = (await one(schema.vendors, schema.vendors.companyId)).id;
  userId = generateId();
  const username = `al_${userId.slice(-10)}`;
  await db.insert(schema.users).values({ id: userId, username, password: await bcrypt.hash(PW, 10), role: 'admin', companyId, isSuperAdmin: false });
  const login = await (await fetch(`${BASE_URL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PW }) })).json();
  sessionId = login.sessionId;
  if (!sessionId) throw new Error('login failed');
  const created = await post('/api/transactions/months', { id: today.slice(0, 7), name: `Month ${today.slice(0, 7)}`, status: 'Open' });
  if (created.status !== 200) throw new Error('open month failed: ' + JSON.stringify(created.body));
}, 60000);

afterAll(async () => { await purgeCompany(companyId); }, 60000);

describe('POST /invoices ignores server-owned fields', () => {
  it('stores the real values, not the ones a crafted request names', async () => {
    const res = await post('/api/transactions/invoices', { invoiceData: {
      date: today, customerId, taxSlabId, bankId, notes: 'n', amountPaid: 0,
      items: [{ id: generateId(), description: 'Service', unitCost: 100, quantity: 1, discountAmount: 0 }],
      status: 'Cancelled', zatcaStatus: 'CLEARED', icv: 99, uuid: 'forged-uuid', currentInvoiceHash: 'forged-hash', qrCodeContent: 'forged-qr',
      invoiceNumber: 'HACK-1', createdById: generateId(), createdAt: '2020-01-01T00:00:00.000Z', originalInvoiceId: generateId(), creditNoteReason: 'x',
      clearanceTimestamp: '2020-01-01T00:00:00.000Z', companyId: generateId(),
    } });
    expect(res.status).toBe(200);
    const row = (await db.select().from(schema.invoices).where(eq(schema.invoices.id, res.body.invoiceId)))[0] as any;
    expect(row.companyId).toBe(companyId);
    expect(row.status).toBe('Active');
    expect(row.zatcaStatus).not.toBe('CLEARED');
    expect(row.icv ?? 0).not.toBe(99);
    expect(row.uuid).not.toBe('forged-uuid');
    expect(row.currentInvoiceHash).not.toBe('forged-hash');
    expect(row.qrCodeContent).not.toBe('forged-qr');
    expect(row.invoiceNumber).not.toBe('HACK-1');
    expect(row.createdById).toBe(userId);
    expect(row.createdAt.getFullYear()).toBeGreaterThan(2020);
    expect(row.originalInvoiceId).toBeNull();
    expect(row.creditNoteReason).toBeNull();
    expect(row.clearanceTimestamp).toBeNull();
    expect(row.documentType).toBe('Invoice');
  });

  it('still refuses a credit note sent through the create route', async () => {
    const res = await post('/api/transactions/invoices', { invoiceData: {
      date: today, customerId, taxSlabId, bankId, notes: '', amountPaid: 0, documentType: 'CreditNote',
      items: [{ id: generateId(), description: 'Service', unitCost: 100, quantity: 1, discountAmount: 0 }],
    } });
    expect(res.status).toBe(400);
  });
});

describe('POST /expenses ignores server-owned fields', () => {
  it('stores the real values, not the ones a crafted request names', async () => {
    const res = await post('/api/expenses', {
      date: today, vendorId, taxSlabId, bankId, paymentStatus: 'Unpaid', amountPaid: 0, description: 'Rent', amount: 115,
      billNumber: 'B-1', expenseType: 'Operating', classification: 'Expense',
      status: 'Cancelled', type: 'Accrual', reversalOfExpenseId: generateId(), originAccrualId: generateId(), accrualSettled: true,
      settledExpenseId: generateId(), expenseNumber: 'HACK-1', createdById: generateId(), createdAt: '2020-01-01T00:00:00.000Z', companyId: generateId(),
    });
    expect(res.status).toBe(200);
    const rows = await db.select().from(schema.expenses).where(eq(schema.expenses.companyId, companyId)) as any[];
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.status).toBe('Active');
    expect(row.type).toBe('Actual');
    expect(row.reversalOfExpenseId).toBeNull();
    expect(row.originAccrualId).toBeNull();
    expect(row.accrualSettled).toBeFalsy();
    expect(row.settledExpenseId).toBeNull();
    expect(row.expenseNumber).not.toBe('HACK-1');
    expect(row.createdById).toBe(userId);
    expect(row.createdAt.getFullYear()).toBeGreaterThan(2020);
  });
});

// Recurring posting and accrual settlement build their expense from named fields already; the server also has to reject a bad
// amount, post type or payment status, because the screen's own checks are skipped by a request that does not come from the screen.
describe('recurring posting and accrual settlement validate their input', () => {
  let templateId = '';
  beforeAll(async () => {
    const t = await post('/api/transactions/recurring-templates', { description: 'Rent', defaultAmount: 100, bankId, vendorId, taxSlabId, isActive: true });
    expect(t.status).toBe(200);
    templateId = t.body.id;
  });
  const posting = (extra: any) => post('/api/transactions/recurring-postings', { templateId, monthId: today.slice(0, 7), postType: 'Actual', amount: 100, dateStr: today, paymentStatus: 'Paid', bankId, ...extra });

  it('rejects a negative, zero or non-numeric amount', async () => {
    for (const amount of [-5, 0, 'abc', null]) expect((await posting({ amount })).status).toBe(400);
  });
  it('rejects an unknown post type or payment status', async () => {
    expect((await posting({ postType: 'Bogus' })).status).toBe(400);
    expect((await posting({ paymentStatus: 'Settled' })).status).toBe(400);
  });
  it('accepts a valid posting', async () => {
    expect((await posting({})).status).toBe(200);
  });
  it('rejects a bad actual amount when settling an accrual', async () => {
    for (const actualAmount of [-1, 0, 'x']) {
      expect((await post('/api/transactions/settle-accrual', { accrualExpenseId: generateId(), actualAmount, actualDate: today, paymentStatus: 'Paid', bankId })).status).toBe(400);
    }
  });
});
