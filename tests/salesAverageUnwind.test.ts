import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { provisionStarterResources } from '../server/lib/companyProvisioning.js';
import { purgeCompany } from './helpers/purgeCompany.js';

// Item Profitability reads productsServices.totalQuantitySold / averageSalePrice, a quantity-weighted rolling
// average folded in when an invoice is created. A cancelled or credited sale must come back OUT of it exactly,
// otherwise the report counts sales that no longer stand. A service product is used so the book needs no stock,
// and the three sales are at deliberately different prices so a wrong reversal could not accidentally match.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';
const NAME = 'Sales Average Unwind Test Co';
const today = new Date().toISOString().slice(0, 10);

let companyId: string, userId: string, sessionId: string, productId: string, customerId: string, taxSlabId: string, bankId: string;

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, ...(init.headers || {}) } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const post = (path: string, body: any) => api(path, { method: 'POST', body: JSON.stringify(body) });
const stats = async () => {
  const [p] = await db.select().from(schema.productsServices).where(eq(schema.productsServices.id, productId));
  return { qty: Number(p.totalQuantitySold), avg: Number(p.averageSalePrice) };
};
const sale = (qty: number, price: number) => post('/api/transactions/invoices', { invoiceData: {
  date: today, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0,
  items: [{ id: generateId(), description: 'Unwind item', unitCost: price, quantity: qty, discountAmount: 0, productId }],
} });

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: NAME, address: 'x', phone: '0', email: 'sa@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false,
  });
  await db.transaction(async (tx: any) => provisionStarterResources(tx, { companyId, companyName: NAME }));
  const one = async (table: any, col: any) => (await db.select().from(table).where(eq(col, companyId)))[0] as any;
  bankId = (await one(schema.bankAccounts, schema.bankAccounts.companyId)).id;
  customerId = (await one(schema.customers, schema.customers.companyId)).id;
  taxSlabId = (await one(schema.taxSlabs, schema.taxSlabs.companyId)).id;
  productId = generateId();
  await db.insert(schema.productsServices).values({
    id: productId, name: 'Unwind Service', description: 'Unwind Service', unitPrice: '40', costPrice: '0', itemKind: 'service', companyId,
  } as any);
  userId = generateId();
  const username = `sa_${userId.slice(-10)}`;
  await db.insert(schema.users).values({ id: userId, username, password: await bcrypt.hash(TEST_PASSWORD, 10), role: 'admin', companyId, isSuperAdmin: false });
  const login = await (await fetch(`${BASE_URL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: TEST_PASSWORD }) })).json();
  sessionId = login.sessionId;
  if (!sessionId) throw new Error('login failed');
}, 60000);

afterAll(async () => { await purgeCompany(companyId); }, 60000);

describe('cancelled and credited sales come back out of the product sale statistics, exactly', () => {
  it('a sale that stands is counted', async () => {
    expect((await sale(3, 40)).status).toBe(200);
    expect(await stats()).toEqual({ qty: 3, avg: 40 });
  });

  it('a cancelled sale is counted at first, then taken back out exactly', async () => {
    const h = await sale(1, 100);
    expect(h.status).toBe(200);
    expect(await stats()).toEqual({ qty: 4, avg: 55 });          // (3x40 + 1x100) / 4
    expect((await post(`/api/transactions/invoices/${h.body.invoiceId}/cancel`, {})).status).toBe(200);
    expect(await stats()).toEqual({ qty: 3, avg: 40 });
  });

  it('a credited sale is taken back out exactly, and the credited invoice can no longer be cancelled', async () => {
    const i = await sale(2, 70);
    expect(i.status).toBe(200);
    expect(await stats()).toEqual({ qty: 5, avg: 52 });          // (3x40 + 2x70) / 5
    const note = await post(`/api/transactions/invoices/${i.body.invoiceId}/note`, { type: 'CreditNote', reason: 'Unwind test' });
    expect(note.status).toBe(200);
    expect(await stats()).toEqual({ qty: 3, avg: 40 });
    // It was already reversed in full; cancelling it too would reverse it a second time.
    const again = await post(`/api/transactions/invoices/${i.body.invoiceId}/cancel`, {});
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/already been reversed by Credit Note/i);
    expect(await stats()).toEqual({ qty: 3, avg: 40 });
  });

  it('Item Profitability reports the real net figures', async () => {
    const { body } = await api('/api/reports/item-profitability');
    const row = body.rows.find((r: any) => r.productName === 'Unwind Service');
    expect(row.totalQuantitySold).toBe(3);
    expect(row.averageSalePrice).toBe(40);
  });

  it('when every sale has been taken back the statistics return to the never-sold state', async () => {
    const j = await sale(2, 25);
    expect(j.status).toBe(200);
    expect((await stats()).qty).toBe(5);
    expect((await post(`/api/transactions/invoices/${j.body.invoiceId}/cancel`, {})).status).toBe(200);
    expect(await stats()).toEqual({ qty: 3, avg: 40 });
  });
});
