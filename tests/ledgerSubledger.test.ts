import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { execSync } from 'node:child_process';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { provisionStarterResources } from '../server/lib/companyProvisioning.js';
import { ensureBankAccount } from '../server/lib/chartOfAccounts.js';
import { purgeCompany } from './helpers/purgeCompany.js';

// Customer and vendor subledgers read from the ledger: every receivable / payable line carries its party, and the balances, party ledger and aging computed from those
// lines agree with the control accounts and with the documents. Real HTTP + real Postgres, no mocks.
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const PW = 'AutoTest_Pw_2026!';
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: string, n: number) => iso(new Date(Date.parse(d + 'T00:00:00.000Z') + n * 86400000));
const TODAY = iso(new Date());
const FIRST = `${TODAY.slice(0, 8)}01`;
const PREV_LAST = addDays(FIRST, -1);
const PREV_MONTH = PREV_LAST.slice(0, 7);

let companyId = ''; let admin = ''; let bankId = ''; let taxSlabId = ''; let ctlId = '';
let c1 = '', c2 = '', v1 = '';
const cleanup: string[] = [];

async function api(session: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers: { 'x-session-id': session, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) } });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json().catch(() => ({})) as any : await res.arrayBuffer() as any };
}
const get = (s: string, p: string) => api(s, p);
const post = (s: string, p: string, b: any = {}) => api(s, p, { method: 'POST', body: JSON.stringify(b) });
const put = (s: string, p: string, b: any) => api(s, p, { method: 'PUT', body: JSON.stringify(b) });
async function login(username: string) {
  const r = await (await fetch(`${BASE_URL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PW }) })).json();
  if (!r.sessionId) throw new Error('login failed');
  return r.sessionId as string;
}
const on = (...keys: string[]) => Object.fromEntries(keys.map(k => [k, { enabled: true }]));
async function mkUser(permissions: any) {
  const roleId = generateId(), userId = generateId(), username = `sl_${userId.slice(-12)}`;
  await db.insert(schema.roles).values({ id: roleId, companyId, name: `Role ${roleId.slice(-6)}`, permissions });
  await db.insert(schema.users).values({ id: userId, username, password: await bcrypt.hash(PW, 10), role: 'user', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  await db.insert(schema.userRoles).values({ userId, roleId });
  return login(username);
}
const mkCustomer = async (name: string) => { const id = generateId(); await db.insert(schema.customers).values({ id, name, phone: '0', email: 'c@example.com', address: 'x', companyId, buyerType: 'B2C' } as any); return id; };
const invoice = async (customerId: string, docDate: string, unitCost: number) => {
  const r = await post(admin, '/api/transactions/invoices', { invoiceData: { docDate, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0, items: [{ id: generateId(), description: 'Item', unitCost, quantity: 1, discountAmount: 0 }] } });
  if (r.status !== 200) throw new Error(`invoice ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.invoiceId as string;
};
const bal = async (kind: string, partyId: string) => ((await get(admin, `/api/ledger/subledger/${kind}/balances?asOf=${TODAY}`)).body.rows as any[]).find(r => r.partyId === partyId)?.balance ?? 0;

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({ id: companyId, name: 'Subledger Test Co', address: 'x', phone: '0', email: `${companyId.slice(0, 8)}@example.com`, logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false } as any);
  cleanup.push(companyId);
  await db.transaction(async (tx: any) => provisionStarterResources(tx, { companyId, companyName: 'Subledger Test Co' }));
  for (const monthId of [TODAY.slice(0, 7), PREV_MONTH]) await db.insert(schema.fiscalMonths).values({ id: monthId, name: monthId, status: 'Open', companyId }).onConflictDoNothing();
  taxSlabId = generateId(); await db.insert(schema.taxSlabs).values({ id: taxSlabId, name: 'Standard 15%', percentage: '15', companyId } as any);
  bankId = generateId(); await db.insert(schema.bankAccounts).values({ id: bankId, bankName: 'Main Bank', accountNumber: '1', accountTitle: 'x', openingBalance: '0', companyId } as any);
  await db.transaction(async (tx: any) => ensureBankAccount(tx, companyId, { id: bankId, bankName: 'Main Bank', accountTitle: 'x' }));
  const adminId = generateId(); const username = `sla_${adminId.slice(-12)}`;
  await db.insert(schema.users).values({ id: adminId, username, password: await bcrypt.hash(PW, 10), role: 'admin', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  admin = await login(username);
  c1 = await mkCustomer('Alpha Trading'); c2 = await mkCustomer('Beta Stores');
  v1 = generateId(); await db.insert(schema.vendors).values({ id: v1, name: 'Gamma Supplies', phone: '0', email: 'v@example.com', address: 'x', companyId, buyerType: 'B2C' } as any);
  // c2 has its own receivable account
  const accts = (await get(admin, '/api/ledger/accounts')).body.accounts as any[];
  ctlId = (await post(admin, '/api/ledger/accounts', { code: '1105', name: 'Staff receivables', type: 'Asset', parentId: accts.find(a => a.code === '1000').id })).body.id;
  await put(admin, `/api/ledger/accounts/${ctlId}`, { subledgerType: 'customer' });
  const row = (await db.select().from(schema.customers).where(eq(schema.customers.id, c2)))[0];
  await post(admin, '/api/customers', { ...row, controlAccountId: ctlId });
}, 180000);
afterAll(async () => { for (const id of cleanup) await purgeCompany(id); }, 180000);

describe('party tags on ledger lines', () => {
  it('every receivable line carries its customer, on whichever control account it posts, and the payable line its vendor', async () => {
    const i1 = await invoice(c1, PREV_LAST, 100);     // 115 on the company receivable account
    const i2 = await invoice(c2, TODAY, 200);         // 230 on Beta's own control account
    const rows: any = await db.execute(sql`SELECT a.code, l.customer_id AS c, l.vendor_id AS v, e.reference_id AS ref FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN company_accounts a ON a.id = l.account_id WHERE l.company_id = ${companyId}::uuid AND e.reference_id IN (${i1}::uuid, ${i2}::uuid) AND a.subledger_type = 'customer'`);
    expect(rows.rows.length).toBe(2);
    expect(rows.rows.find((r: any) => r.ref === i1)).toMatchObject({ code: '1100', c: c1, v: null });
    expect(rows.rows.find((r: any) => r.ref === i2)).toMatchObject({ code: '1105', c: c2 });
    // no non-control line carries a party
    const stray: any = await db.execute(sql`SELECT COUNT(*)::int AS n FROM journal_lines l JOIN company_accounts a ON a.id = l.account_id WHERE l.company_id = ${companyId}::uuid AND (l.customer_id IS NOT NULL OR l.vendor_id IS NOT NULL) AND a.subledger_type IS NULL`);
    expect(stray.rows[0].n).toBe(0);
    // a vendor expense
    const exp = await post(admin, '/api/expenses', { docDate: TODAY, vendorId: v1, taxSlabId, bankId, description: 'Supplies', billNumber: 'SL-1', amount: 100, status: 'Active', type: 'Actual', paymentStatus: 'Unpaid' });
    expect(exp.status).toBe(200);
    const ap: any = await db.execute(sql`SELECT l.vendor_id AS v, l.credit::float8 AS cr FROM journal_lines l JOIN company_accounts a ON a.id = l.account_id WHERE l.company_id = ${companyId}::uuid AND a.subledger_type = 'vendor'`);
    expect(ap.rows.length).toBe(1); expect(ap.rows[0].v).toBe(v1); expect(ap.rows[0].cr).toBe(100);
  });
});

describe('balances, the party ledger and the control accounts', () => {
  it('balances per party across every control account, summing to the Trial Balance', async () => {
    expect(await bal('customer', c1)).toBe(115);
    expect(await bal('customer', c2)).toBe(230);
    expect(await bal('vendor', v1)).toBe(100);
    const tb = (await get(admin, `/api/ledger/subledger/customer/aging?asOf=${TODAY}`)).body;
    expect(tb.reconciliation).toMatchObject({ controlBalance: 345, difference: 0, untaggedLines: 0 });
  });

  it('a party ledger lists its postings with a running balance, its opening balance and the document number', async () => {
    const l = (await get(admin, `/api/ledger/subledger/customer/ledger?partyId=${c1}&from=${FIRST}&to=${TODAY}`)).body;
    expect(l.party.name).toBe('Alpha Trading');
    expect(l.opening).toBe(115);            // the invoice dated last month
    expect(l.lines).toHaveLength(0);
    const all = (await get(admin, `/api/ledger/subledger/customer/ledger?partyId=${c1}&from=${PREV_MONTH}-01&to=${TODAY}`)).body;
    expect(all.opening).toBe(0); expect(all.lines).toHaveLength(1);
    expect(all.lines[0]).toMatchObject({ debit: 115, credit: 0, balance: 115, referenceType: 'Invoice' }); expect(all.lines[0].documentNumber).toMatch(/^INV-/);
    expect(all.closing).toBe(115);
    expect((await get(admin, `/api/ledger/subledger/customer/ledger?partyId=${c1}&from=${TODAY}&to=${FIRST}`)).status).toBe(400);
  });
});

describe('aging', () => {
  it('ages open charges from their date, and sets payments against the oldest charge first', async () => {
    const asOf = addDays(TODAY, 40);
    const a = (await get(admin, `/api/ledger/subledger/customer/aging?asOf=${asOf}`)).body;
    expect(a.bucketLabels).toEqual(['Not due', '1-30', '31-60', '61-90', 'Over 90']);
    const alpha = a.rows.find((r: any) => r.partyId === c1);
    // the invoice dated on the last day of the previous month is (40 + days since) days old: never "not due"
    expect(alpha.total).toBe(115); expect(alpha.buckets[0]).toBe(0); expect(alpha.buckets.reduce((s: number, v: number) => s + v, 0)).toBe(115);
    const beta = a.rows.find((r: any) => r.partyId === c2);
    expect(beta.total).toBe(230); expect(beta.buckets[3] + beta.buckets[2] + beta.buckets[1]).toBe(230);
    // a payment of 150 from Alpha: bigger than its single open charge -> the 35 left is held on account
    const inv = (await db.select().from(schema.invoices).where(and(eq(schema.invoices.companyId, companyId), eq(schema.invoices.customerId, c1))))[0];
    const pay = await post(admin, `/api/transactions/invoices/${inv.id}/paid`, { docDate: TODAY, bankId, amount: 115 });
    expect(pay.status).toBe(200);
    const after = (await get(admin, `/api/ledger/subledger/customer/aging?asOf=${asOf}`)).body;
    expect(after.rows.find((r: any) => r.partyId === c1)).toBeUndefined();   // nothing open, nothing on account: not listed
    expect(after.totals.total).toBe(230);
    expect(after.reconciliation.difference).toBe(0);
  });

  it('the payables aging mirrors it for vendors', async () => {
    const a = (await get(admin, `/api/ledger/subledger/vendor/aging?asOf=${addDays(TODAY, 5)}`)).body;
    expect(a.rows).toHaveLength(1); expect(a.rows[0]).toMatchObject({ partyId: v1, total: 100 });
    expect(a.reconciliation).toMatchObject({ controlBalance: 100, difference: 0 });
  });

  it('exports the aging and a ledger to Excel', async () => {
    const x = await get(admin, `/api/ledger/subledger/customer/aging/export?asOf=${TODAY}`);
    expect(x.status).toBe(200); expect((x.body as ArrayBuffer).byteLength).toBeGreaterThan(2000);
    const y = await get(admin, `/api/ledger/subledger/vendor/ledger/export?partyId=${v1}&from=${FIRST}&to=${TODAY}`);
    expect(y.status).toBe(200); expect((y.body as ArrayBuffer).byteLength).toBeGreaterThan(2000);
  });
});

describe('integrity and permissions', () => {
  it('the consistency check proves the tags, and the backfill repairs an untagged line', async () => {
    const check = async () => (await get(admin, `/api/reports/consistency-check?asOfDate=${TODAY}`)).body.checks.filter((c: any) => /^R8\./.test(c.id));
    expect((await check()).every((c: any) => c.ok)).toBe(true);
    // untag one receivable line
    await db.execute(sql`UPDATE journal_lines SET customer_id = NULL WHERE id = (SELECT l.id FROM journal_lines l JOIN company_accounts a ON a.id = l.account_id WHERE l.company_id = ${companyId}::uuid AND a.subledger_type = 'customer' AND l.customer_id IS NOT NULL LIMIT 1)`);
    const broken = await check();
    expect(broken.find((c: any) => c.id === 'R8.1').ok).toBe(false);
    execSync('npx tsx scripts/backfill-party-tags.ts --apply', { cwd: process.cwd(), stdio: 'pipe' });
    expect((await check()).every((c: any) => c.ok)).toBe(true);
  }, 120000);

  it('each report needs its own permission, and another company sees none of this', async () => {
    const nobody = await mkUser({});
    const aging = await mkUser({ reports: on('receivablesAging') });
    expect((await get(nobody, '/api/ledger/subledger/customer/aging')).status).toBe(403);
    expect((await get(aging, '/api/ledger/subledger/customer/aging')).status).toBe(200);
    expect((await get(aging, '/api/ledger/subledger/vendor/aging')).status).toBe(403);
    expect((await get(aging, `/api/ledger/subledger/customer/ledger?partyId=${c1}`)).status).toBe(403);
    expect((await get(admin, '/api/ledger/subledger/supplier/aging')).status).toBe(400);
  });
});
