import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { provisionStarterResources } from '../server/lib/companyProvisioning.js';
import { ensureBankAccount } from '../server/lib/chartOfAccounts.js';
import { purgeCompany } from './helpers/purgeCompany.js';

// General Ledger Step 1.5, slice 1b: posting profiles. A customer or vendor names its own control account and default dimensions; every document for
// that party then posts its receivable / payable line to that account and starts its lines from those tags, with no route choosing accounts itself.
// Real HTTP + real Postgres, no mocks.
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const PW = 'AutoTest_Pw_2026!';
const TODAY = new Date().toISOString().slice(0, 10);

interface Co { id: string; adminId: string; admin: string; bankId: string; taxSlabId: string }
let A: Co, B: Co;
let clerk = '';
const cleanup: string[] = [];

async function api(session: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers: { 'x-session-id': session, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) } });
  return { status: res.status, body: await res.json().catch(() => ({})) as any };
}
const get = (s: string, p: string) => api(s, p);
const post = (s: string, p: string, b: any = {}) => api(s, p, { method: 'POST', body: JSON.stringify(b) });
const put = (s: string, p: string, b: any) => api(s, p, { method: 'PUT', body: JSON.stringify(b) });
const patch = (s: string, p: string, b?: any) => api(s, p, { method: 'PATCH', ...(b ? { body: JSON.stringify(b) } : {}) });
async function login(username: string) {
  const r = await (await fetch(`${BASE_URL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PW }) })).json();
  if (!r.sessionId) throw new Error('login failed');
  return r.sessionId as string;
}
async function mkCompany(name: string): Promise<Co> {
  const id = generateId();
  await db.insert(schema.companies).values({ id, name, address: 'x', phone: '0', email: `${id.slice(0, 8)}@example.com`, logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false } as any);
  await db.transaction(async (tx: any) => provisionStarterResources(tx, { companyId: id, companyName: name }));
  cleanup.push(id);
  const monthId = TODAY.slice(0, 7);
  await db.insert(schema.fiscalMonths).values({ id: monthId, name: monthId, status: 'Open', companyId: id }).onConflictDoNothing();
  const taxSlabId = generateId();
  await db.insert(schema.taxSlabs).values({ id: taxSlabId, name: 'Standard 15%', percentage: '15', companyId: id } as any);
  const bankId = generateId();
  await db.insert(schema.bankAccounts).values({ id: bankId, bankName: 'Main Bank', accountNumber: '1', accountTitle: name, openingBalance: '0', companyId: id } as any);
  await db.transaction(async (tx: any) => ensureBankAccount(tx, id, { id: bankId, bankName: 'Main Bank', accountTitle: name }));
  const adminId = generateId(); const username = `pp_${adminId.slice(-12)}`;
  await db.insert(schema.users).values({ id: adminId, username, password: await bcrypt.hash(PW, 10), role: 'admin', companyId: id, isSuperAdmin: false, uiLanguage: 'en' });
  return { id, adminId, admin: await login(username), bankId, taxSlabId };
}
async function mkUser(companyId: string, permissions: any) {
  const roleId = generateId(), userId = generateId(), username = `ppu_${userId.slice(-12)}`;
  await db.insert(schema.roles).values({ id: roleId, companyId, name: `Role ${roleId.slice(-6)}`, permissions });
  await db.insert(schema.users).values({ id: userId, username, password: await bcrypt.hash(PW, 10), role: 'user', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  await db.insert(schema.userRoles).values({ userId, roleId });
  return login(username);
}
const on = (...keys: string[]) => Object.fromEntries(keys.map(k => [k, { enabled: true }]));
const codeOf = (list: any[], code: string) => list.find(a => a.code === code);

async function mkCustomer(co: Co, name: string) {
  const id = generateId();
  await db.insert(schema.customers).values({ id, name, phone: '0', email: 'c@example.com', address: 'x', companyId: co.id, buyerType: 'B2C' } as any);
  return id;
}
async function invoice(co: Co, customerId: string, amountPaid = 0) {
  const r = await post(co.admin, '/api/transactions/invoices', { invoiceData: { date: TODAY, customerId, taxSlabId: co.taxSlabId, bankId: co.bankId, notes: '', status: 'Active', amountPaid, items: [{ id: generateId(), description: 'Item', unitCost: 100, quantity: 1, discountAmount: 0 }] } });
  if (r.status !== 200) throw new Error(`invoice failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.invoiceId as string;
}
// The ledger lines of one source document, with the account code and the dimension tags they carry.
async function linesOf(companyId: string, referenceId: string) {
  const res: any = await db.execute(sql`
    SELECT l.account_key AS "key", a.code, l.debit::float8 AS debit, l.credit::float8 AS credit, e.reversal_of_id AS "reversalOf",
           (SELECT COALESCE(jsonb_object_agg(x.dimension_type_id, x.entity_id), '{}'::jsonb) FROM dimension_combination_entries x WHERE x.combination_id = l.dimension_combination_id) AS tags
    FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id LEFT JOIN company_accounts a ON a.id = l.account_id
    WHERE e.company_id = ${companyId}::uuid AND e.reference_id = ${referenceId}::uuid ORDER BY e.created_at, l.id`);
  return res.rows as { key: string; code: string; debit: number; credit: number; reversalOf: string | null; tags: Record<string, string> }[];
}
const balanceOf = async (companyId: string, code: string) => {
  const res: any = await db.execute(sql`SELECT COALESCE(SUM(l.debit - l.credit),0)::float8 AS n FROM journal_lines l JOIN company_accounts a ON a.id = l.account_id WHERE l.company_id = ${companyId}::uuid AND a.code = ${code}`);
  return Number(res.rows[0].n);
};

let ctlId = '', vctlId = '', deptType = '', ccSales = '', ccCash = '', ccGulf = '';
let plainCust = '', staffCust = '', gulfCust = '';

beforeAll(async () => {
  A = await mkCompany('Posting Profile Test Co A');
  B = await mkCompany('Posting Profile Test Co B');
  clerk = await mkUser(A.id, { customers: on('create', 'read', 'update'), vendors: on('create', 'read', 'update') });
  const list = (await get(A.admin, '/api/ledger/accounts')).body.accounts as any[];
  const created = await post(A.admin, '/api/ledger/accounts', { code: '1105', name: 'Staff receivables', type: 'Asset', parentId: codeOf(list, '1000').id });
  ctlId = created.body.id;
  const v = await post(A.admin, '/api/ledger/accounts', { code: '2020', name: 'Foreign suppliers', type: 'Liability', parentId: codeOf(list, '2000').id });
  vctlId = v.body.id;
  const [dt] = await db.select().from(schema.dimensionTypes).where(and(eq(schema.dimensionTypes.companyId, A.id), eq(schema.dimensionTypes.code, 'DEPARTMENT')));
  deptType = dt.id;
  ccSales = (await post(A.admin, '/api/ledger/cost-centers', { code: 'SALES', name: 'Sales' })).body.id;
  ccCash = (await post(A.admin, '/api/ledger/cost-centers', { code: 'CASH', name: 'Cash desk' })).body.id;
  ccGulf = (await post(A.admin, '/api/ledger/cost-centers', { code: 'GULF', name: 'Gulf region' })).body.id;
  plainCust = await mkCustomer(A, 'Plain Customer');
  staffCust = await mkCustomer(A, 'Staff Customer');
  gulfCust = await mkCustomer(A, 'Gulf Customer');
}, 180000);
afterAll(async () => { for (const id of cleanup) await purgeCompany(id); }, 180000);

const customerRow = async (id: string) => (await db.select().from(schema.customers).where(eq(schema.customers.id, id)))[0];
const saveCustomer = async (co: Co | string, id: string, extra: any) => {
  const row = await customerRow(id);
  const session = typeof co === 'string' ? co : co.admin;
  return post(session, '/api/customers', { ...row, ...extra });
};

describe('control accounts in the chart', () => {
  it('the role accounts and bank accounts of the chart are stamped with their subledger', async () => {
    const list = (await get(A.admin, '/api/ledger/accounts')).body.accounts as any[];
    expect(codeOf(list, '1100').subledgerType).toBe('customer');
    expect(codeOf(list, '2010').subledgerType).toBe('vendor');
    expect(codeOf(list, '1200').subledgerType).toBe('inventory');
    expect(codeOf(list, '1300').subledgerType).toBe('tax');
    expect(list.find(a => a.bankId === A.bankId).subledgerType).toBe('bank');
    expect(codeOf(list, '1400').subledgerType ?? null).toBeNull(); // fixed assets are not a control account
  });

  it('an ordinary account becomes a customer or vendor control account, only if it fits and has no postings', async () => {
    expect((await put(A.admin, `/api/ledger/accounts/${ctlId}`, { subledgerType: 'customer' })).status).toBe(200);
    expect((await put(A.admin, `/api/ledger/accounts/${vctlId}`, { subledgerType: 'vendor' })).status).toBe(200);
    const list = (await get(A.admin, '/api/ledger/accounts')).body.accounts as any[];
    expect(codeOf(list, '1105')).toMatchObject({ subledgerType: 'customer', isControl: true });
    // a control account is refused by manual journals (nobody can bypass the subledger)
    const j = await post(A.admin, '/api/ledger/manual-journals', { date: TODAY, description: 'x', lines: [{ accountId: ctlId, debit: 5 }, { accountId: codeOf(list, '6200').id, credit: 5 }] });
    expect(j.status).toBe(400);
    // wrong type for the subledger, a system role, a heading, an unknown subledger
    const other = (await post(A.admin, '/api/ledger/accounts', { code: '1106', name: 'Another', type: 'Liability', parentId: codeOf(list, '2000').id })).body.id;
    expect((await put(A.admin, `/api/ledger/accounts/${other}`, { subledgerType: 'customer' })).status).toBe(400);
    expect((await put(A.admin, `/api/ledger/accounts/${codeOf(list, '1100').id}`, { subledgerType: '' })).status).toBe(400);
    expect((await put(A.admin, `/api/ledger/accounts/${codeOf(list, '1000').id}`, { subledgerType: 'customer' })).status).toBe(400);
    expect((await put(A.admin, `/api/ledger/accounts/${other}`, { subledgerType: 'inventory' })).status).toBe(400);
    // the control accounts a customer or vendor can pick: only these, never the company's own AR / AP role accounts
    const cust = (await get(A.admin, '/api/ledger/control-accounts?kind=customer')).body.accounts;
    expect(cust.map((a: any) => a.code)).toEqual(['1105']);
    expect((await get(A.admin, '/api/ledger/control-accounts?kind=vendor')).body.accounts.map((a: any) => a.code)).toEqual(['2020']);
    expect((await get(B.admin, '/api/ledger/control-accounts?kind=customer')).body.accounts).toEqual([]);
  });
});

describe('a customer\'s posting profile', () => {
  it('accepts a control account of its own subledger and default dimensions, and nothing else', async () => {
    expect((await saveCustomer(A, staffCust, { controlAccountId: ctlId, defaultDimensions: { [deptType]: ccSales } })).status).toBe(200);
    const row = await customerRow(staffCust);
    expect(row.controlAccountId).toBe(ctlId); expect(row.defaultDimensionCombinationId).toBeTruthy();
    const prof = (await get(A.admin, `/api/ledger/party-profile?kind=customer&id=${staffCust}`)).body;
    expect(prof).toEqual({ controlAccountId: ctlId, dimensions: { [deptType]: ccSales } });
    // the vendor control account, the company's AR role account, another company's account and a heading are all refused
    const list = (await get(A.admin, '/api/ledger/accounts')).body.accounts as any[];
    for (const bad of [vctlId, codeOf(list, '1100').id, codeOf(list, '1000').id, codeOf((await get(B.admin, '/api/ledger/accounts')).body.accounts, '1100').id]) {
      const r = await saveCustomer(A, plainCust, { controlAccountId: bad });
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
    expect((await customerRow(plainCust)).controlAccountId).toBeNull();
    // a foreign dimension value is refused too
    const foreignDept = (await post(B.admin, '/api/ledger/cost-centers', { code: 'X', name: 'Foreign' })).body.id;
    expect((await saveCustomer(A, plainCust, { defaultDimensions: { [deptType]: foreignDept } })).status).toBeGreaterThanOrEqual(400);
  });

  it('only someone with Account Mapping can change it, but saving the customer\'s other details still works for everyone', async () => {
    const before = await customerRow(staffCust);
    const edit = await saveCustomer(clerk, staffCust, { name: 'Staff Customer (renamed)' });
    expect(edit.status).toBe(200); // the form echoes the stored control account back unchanged: not a change
    const row = await customerRow(staffCust);
    expect(row.name).toBe('Staff Customer (renamed)'); expect(row.controlAccountId).toBe(before.controlAccountId); expect(row.defaultDimensionCombinationId).toBe(before.defaultDimensionCombinationId);
    expect((await saveCustomer(clerk, plainCust, { controlAccountId: ctlId })).status).toBe(403);
    expect((await saveCustomer(clerk, plainCust, { defaultDimensions: { [deptType]: ccSales } })).status).toBe(403);
    expect((await customerRow(plainCust)).controlAccountId).toBeNull();
    // raw column names in the payload are ignored, never written
    await saveCustomer(A, plainCust, { defaultDimensionCombinationId: before.defaultDimensionCombinationId });
    expect((await customerRow(plainCust)).defaultDimensionCombinationId).toBeNull();
  });

  it('clearing the profile goes back to the company defaults', async () => {
    expect((await saveCustomer(A, gulfCust, { controlAccountId: ctlId, defaultDimensions: { [deptType]: ccGulf } })).status).toBe(200);
    expect((await saveCustomer(A, gulfCust, { controlAccountId: null, defaultDimensions: {} })).status).toBe(200);
    const row = await customerRow(gulfCust);
    expect(row.controlAccountId).toBeNull(); expect(row.defaultDimensionCombinationId).toBeNull();
  });

  it('a control account in use cannot stop being one, and cannot be deactivated', async () => {
    expect((await put(A.admin, `/api/ledger/accounts/${ctlId}`, { subledgerType: '' })).status).toBe(400);
    expect((await patch(A.admin, `/api/ledger/accounts/${ctlId}/toggle-active`)).status).toBe(400);
  });
});

describe('documents post through the profile', () => {
  it('an invoice, its payment and its cancellation use the customer\'s control account and tags; a customer without a profile uses the role account', async () => {
    const inv = await invoice(A, staffCust);
    const raised = await linesOf(A.id, inv);
    const ar = raised.find(l => l.key === 'AR')!;
    expect(ar.code).toBe('1105'); expect(ar.debit).toBe(115);
    expect(ar.tags).toEqual({ [deptType]: ccSales });
    expect(raised.find(l => l.key === 'SALES_REVENUE')!.code).toBe('4010'); // revenue stays on the company's account
    expect(raised.find(l => l.key === 'SALES_REVENUE')!.tags).toEqual({ [deptType]: ccSales }); // but is tagged by the customer's default
    expect(await balanceOf(A.id, '1105')).toBe(115);
    expect(await balanceOf(A.id, '1100')).toBe(0);

    const paid = await post(A.admin, `/api/transactions/invoices/${inv}/paid`, { paymentDate: TODAY, bankId: A.bankId, amount: 115 });
    expect(paid.status).toBe(200);
    expect(await balanceOf(A.id, '1105')).toBe(0); // the receipt relieves the same control account

    const plain = await invoice(A, plainCust);
    const plainAr = (await linesOf(A.id, plain)).find(l => l.key === 'AR')!;
    expect(plainAr.code).toBe('1100'); expect(plainAr.tags).toEqual({});
    expect(await balanceOf(A.id, '1100')).toBe(115);

    // cancelling reverses onto the accounts the original used, whatever the profile says today
    expect((await saveCustomer(A, staffCust, { controlAccountId: null })).status).toBe(200);
    const open = await invoice(A, staffCust);
    expect((await linesOf(A.id, open)).find(l => l.key === 'AR')!.code).toBe('1100'); // profile now cleared
    const c = await post(A.admin, `/api/transactions/invoices/${plain}/cancel`, {});
    expect(c.status).toBe(200);
    expect(await balanceOf(A.id, '1100')).toBe(115); // the cancelled plain invoice is gone; the new invoice (115) remains
    expect(await balanceOf(A.id, '1105')).toBe(0);
  });

  it('the bank\'s default dimensions tag its lines, and the customer\'s outrank them', async () => {
    expect((await patch(A.admin, `/api/banks/${A.bankId}`, { defaultDimensions: { [deptType]: ccCash } })).status).toBe(200);
    expect((await saveCustomer(A, staffCust, { controlAccountId: ctlId, defaultDimensions: { [deptType]: ccSales } })).status).toBe(200);
    const withProfile = await invoice(A, staffCust, 115);
    const bankLine = (await linesOf(A.id, withProfile)).find(l => l.key === 'BANK')!;
    expect(bankLine.tags).toEqual({ [deptType]: ccSales }); // customer beats bank
    const plain = await invoice(A, plainCust, 115);
    const plainBank = (await linesOf(A.id, plain)).find(l => l.key === 'BANK')!;
    expect(plainBank.tags).toEqual({ [deptType]: ccCash }); // no customer profile: the bank's default
    expect((await get(A.admin, `/api/ledger/party-profile?kind=bank&id=${A.bankId}`)).body.dimensions).toEqual({ [deptType]: ccCash });
    // another company cannot read this company's party profile
    expect((await get(B.admin, `/api/ledger/party-profile?kind=bank&id=${A.bankId}`)).status).toBe(404);
  });

  it('an expense for a vendor: the payable posts to the vendor\'s control account, and the vendor form refuses a wrong one', async () => {
    const vendorId = generateId();
    await db.insert(schema.vendors).values({ id: vendorId, name: 'Gulf Supplies', phone: '0', email: 'v@example.com', address: 'x', companyId: A.id, buyerType: 'B2C' } as any);
    const row = (await db.select().from(schema.vendors).where(eq(schema.vendors.id, vendorId)))[0];
    const roleAp = codeOf((await get(A.admin, '/api/ledger/accounts')).body.accounts, '2010').id;
    expect((await post(A.admin, '/api/vendors', { ...row, controlAccountId: roleAp })).status).toBe(400); // the company's own AP is the default, not a choice
    expect((await post(A.admin, '/api/vendors', { ...row, controlAccountId: ctlId })).status).toBe(400); // a customer control account
    const okV = await post(A.admin, '/api/vendors', { ...row, controlAccountId: vctlId });
    expect(okV.status, JSON.stringify(okV.body)).toBe(200);
    const r = await post(A.admin, '/api/expenses', { date: TODAY, vendorId, taxSlabId: A.taxSlabId, bankId: A.bankId, description: 'Supplies', billNumber: 'V-1', amount: 100, status: 'Active', type: 'Actual', paymentStatus: 'Unpaid' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [exp] = await db.select().from(schema.expenses).where(and(eq(schema.expenses.companyId, A.id), eq(schema.expenses.vendorId, vendorId)));
    const lines = await linesOf(A.id, exp.id);
    expect(lines.find(l => l.key === 'AP')!.code).toBe('2020');
    expect(await balanceOf(A.id, '2020')).toBe(-100);
    expect(await balanceOf(A.id, '2010')).toBe(0);
    // paying it relieves the same control account
    const pay = await post(A.admin, `/api/expenses/${exp.id}/pay`, { date: TODAY, bankId: A.bankId, amount: 100 });
    expect(pay.status, JSON.stringify(pay.body)).toBe(200);
    expect(await balanceOf(A.id, '2020')).toBe(0);
  });
});
