import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { provisionStarterResources } from '../server/lib/companyProvisioning.js';
import { ensureBankAccount } from '../server/lib/chartOfAccounts.js';
import { purgeCompany } from './helpers/purgeCompany.js';

// Approval rules (Sprint 11): a vendor payment that matches a rule waits as a request and posts nothing until every level has approved; the submitter cannot approve unless the company allows it.
// Real HTTP + real Postgres, no mocks.
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const PW = 'AutoTest_Pw_2026!';
const iso = (d: Date) => d.toISOString().slice(0, 10);
const TODAY = iso(new Date());
const FIRST = `${TODAY.slice(0, 8)}01`;
const PREV_LAST = iso(new Date(Date.parse(FIRST + 'T00:00:00.000Z') - 86400000));

let A = ''; let admin = ''; let clerk = ''; let bankId = ''; let taxSlabId = '';
let cust = '', cust2 = '', vend = '';
let other: { id: string; admin: string; cust: string };
const cleanup: string[] = [];

async function api(session: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers: { 'x-session-id': session, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) } });
  return { status: res.status, body: await res.json().catch(() => ({})) as any };
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
async function mkCompany(name: string) {
  const id = generateId();
  await db.insert(schema.companies).values({ id, name, address: 'x', phone: '0', email: `${id.slice(0, 8)}@example.com`, logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false } as any);
  await db.transaction(async (tx: any) => provisionStarterResources(tx, { companyId: id, companyName: name }));
  cleanup.push(id);
  for (const monthId of [TODAY.slice(0, 7), PREV_LAST.slice(0, 7)]) await db.insert(schema.fiscalMonths).values({ id: monthId, name: monthId, status: 'Open', companyId: id }).onConflictDoNothing();
  const slab = generateId(); await db.insert(schema.taxSlabs).values({ id: slab, name: 'Standard 15%', percentage: '15', companyId: id } as any);
  const bank = generateId(); await db.insert(schema.bankAccounts).values({ id: bank, bankName: 'Main Bank', accountNumber: '1', accountTitle: name, openingBalance: '0', companyId: id } as any);
  await db.transaction(async (tx: any) => ensureBankAccount(tx, id, { id: bank, bankName: 'Main Bank', accountTitle: name }));
  const adminId = generateId(); const username = `st_${adminId.slice(-12)}`;
  await db.insert(schema.users).values({ id: adminId, username, password: await bcrypt.hash(PW, 10), role: 'admin', companyId: id, isSuperAdmin: false, uiLanguage: 'en' });
  return { id, slab, bank, session: await login(username) };
}
async function mkUser(companyId: string, permissions: any) {
  const roleId = generateId(), userId = generateId(), username = `stu_${userId.slice(-12)}`;
  await db.insert(schema.roles).values({ id: roleId, companyId, name: `Role ${roleId.slice(-6)}`, permissions });
  await db.insert(schema.users).values({ id: userId, username, password: await bcrypt.hash(PW, 10), role: 'user', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  await db.insert(schema.userRoles).values({ userId, roleId });
  return login(username);
}
const customer = async (companyId: string, name: string) => { const id = generateId(); await db.insert(schema.customers).values({ id, name, phone: '0', email: 'c@example.com', address: 'x', companyId, buyerType: 'B2C' } as any); return id; };
const invoice = async (customerId: string, unitCost: number, docDate = TODAY) => {
  const r = await post(admin, '/api/transactions/invoices', { invoiceData: { docDate, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0, items: [{ id: generateId(), description: 'Item', unitCost, quantity: 1, discountAmount: 0 }] } });
  if (r.status !== 200) throw new Error(`invoice ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.invoiceId as string;
};
const expense = async (amount: number, n: string) => {
  const r = await post(admin, '/api/expenses', { docDate: TODAY, vendorId: vend, taxSlabId, bankId, description: 'Supplies ' + n, billNumber: 'ST-' + n, amount, status: 'Active', type: 'Actual', paymentStatus: 'Unpaid' });
  if (r.status !== 200) throw new Error(`expense ${r.status} ${JSON.stringify(r.body)}`);
  return (await db.select().from(schema.expenses).where(and(eq(schema.expenses.companyId, A), eq(schema.expenses.billNumber, 'ST-' + n))))[0].id as string;
};
const inv = async (id: string) => (await db.select().from(schema.invoices).where(eq(schema.invoices.id, id)))[0];
const receipt = (body: any, s = admin) => post(s, '/api/settlements/receipts', { partyId: cust, bankId, docDate: TODAY, ...body });
const patch = (s: string, p: string, b: any = {}) => api(s, p, { method: 'PATCH', body: JSON.stringify(b) });
let roleA = '', roleB = '', S = { s: '', id: '' }, UA = { s: '', id: '' }, Bu = { s: '', id: '' }, M = { s: '', id: '' }, S2 = { s: '', id: '' };
const ROLE_PERMS = { vendorPayments: on('create', 'read', 'delete'), approvals: on('read'), purchaseBills: on('create', 'read') };
async function mkU(permissions: any, roleId?: string) {
  const rid = roleId || generateId(), userId = generateId(), username = `ap_${userId.slice(-12)}`;
  if (!roleId) await db.insert(schema.roles).values({ id: rid, companyId: A_, name: `Role ${rid.slice(-6)}`, permissions });
  await db.insert(schema.users).values({ id: userId, username, password: await bcrypt.hash(PW, 10), role: 'user', companyId: A_, isSuperAdmin: false, uiLanguage: 'en' });
  await db.insert(schema.userRoles).values({ userId, roleId: rid });
  return { s: await login(username), id: userId, roleId: rid };
}
let A_ = '';
const R = (p = '') => `/api/approvals${p}`;
const payBody = (amount: number, docDate = TODAY) => ({ partyId: vend, bankId, docDate, amount, allocations: [] as any[] });
const vouchersFor = async () => ((await db.execute(sql`SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id = ${A_}::uuid AND reference_type = 'VendorPayment'`)) as any).rows[0].n as number;
const rule = (over: any = {}) => post(admin, R('/rules'), { name: 'Large payments', documentType: 'VendorPayment', minAmount: 100, maxAmount: null, priority: 10, levels: [{ approverType: 'Role', approverRef: roleA }], ...over });
const deactivateAll = async () => { for (const r of (await get(admin, R('/rules'))).body.rules) if (r.isActive) await patch(admin, R(`/rules/${r.id}/toggle-active`)); };

beforeAll(async () => {
  const a = await mkCompany('Approvals Test Co A'); const b = await mkCompany('Approvals Test Co B');
  A_ = a.id; A = a.id; admin = a.session; bankId = a.bank; taxSlabId = a.slab;
  vend = generateId(); await db.insert(schema.vendors).values({ id: vend, name: 'Gamma', phone: '0', email: 'v@example.com', address: 'x', companyId: A_, buyerType: 'B2C' } as any);
  const ra = await mkU(ROLE_PERMS); roleA = ra.roleId; UA = ra;
  const rb = await mkU(ROLE_PERMS); roleB = rb.roleId; Bu = rb;
  S = await mkU(ROLE_PERMS); M = await mkU(ROLE_PERMS); S2 = await mkU(ROLE_PERMS);
  await db.insert(schema.userRoles).values({ userId: S.id, roleId: roleA });                  // the submitter also holds level-1 authority (for the self-approval cases)
  await db.update(schema.users).set({ managerId: M.id }).where(eq(schema.users.id, S2.id));
  other = { id: b.id, admin: b.session, cust: '' };
}, 180000);
afterAll(async () => { for (const id of cleanup) await purgeCompany(id); }, 180000);

describe('rules and the direct path', () => {
  it('APR-001 a payment with no matching rule posts directly, exactly as before', async () => {
    await expense(1000, 'N1');
    const before = await vouchersFor();
    const r = await post(admin, '/api/settlements/payments', payBody(150));
    expect(r.status).toBe(200); expect(r.body.pendingApproval).toBeUndefined(); expect(await vouchersFor()).toBe(before + 1);
  });

  it('rules need their own permission, name roles and users of this company only, and reject a bad band', async () => {
    expect((await post(S.s, R('/rules'), { name: 'x', documentType: 'VendorPayment', levels: [{ approverType: 'Role', approverRef: roleA }] })).status).toBe(403);
    expect((await rule({ levels: [{ approverType: 'Role', approverRef: generateId() }] })).status).toBe(400);
    expect((await rule({ minAmount: 500, maxAmount: 100 })).status).toBe(400);
    expect((await rule({ documentType: 'Journal' })).status).toBe(400);                         // only vendor payments are routed in this release
    expect((await rule({ levels: [] })).status).toBe(400);
  });
});

describe('a payment inside a rule band waits', () => {
  let reqId = '';
  it('APR-002/003 amount above the floor waits and posts nothing; exactly at the floor posts directly', async () => {
    await deactivateAll(); expect((await rule()).status).toBe(200);
    await expense(1000, 'N2');
    const before = await vouchersFor();
    const atFloor = await post(admin, '/api/settlements/payments', payBody(100));
    expect(atFloor.body.pendingApproval).toBeUndefined();                                       // 100.00 is not above 100
    const p = await post(S.s, '/api/settlements/payments', payBody(100.01));
    expect(p.status).toBe(200); expect(p.body.pendingApproval).toBe(true); reqId = p.body.requestId;
    expect(await vouchersFor()).toBe(before + 1);                                               // only the direct one: nothing was written for the waiting payment
    const mine = (await get(UA.s, R('/my'))).body; expect(mine.waiting.some((x: any) => x.id === reqId)).toBe(true);
    expect((await get(Bu.s, R('/my'))).body.waiting.some((x: any) => x.id === reqId)).toBe(false);   // not B's authority
  });

  it('a person without the authority cannot decide; the level holder approves and the payment is created once', async () => {
    expect((await post(Bu.s, R(`/requests/${reqId}/decide`), { action: 'Approved' })).status).toBe(403);
    const before = await vouchersFor();
    const ok = await post(UA.s, R(`/requests/${reqId}/decide`), { action: 'Approved' });
    expect(ok.status).toBe(200); expect(ok.body.status).toBe('Approved');
    expect(await vouchersFor()).toBe(before + 1);
    expect((await post(UA.s, R(`/requests/${reqId}/decide`), { action: 'Approved' })).status).toBe(400);   // already decided
    const d = (await get(UA.s, R(`/requests/${reqId}`))).body;
    expect(d).toMatchObject({ status: 'Approved', selfApproved: false }); expect(d.actions).toHaveLength(1); expect(d.resultDocumentId).toBeTruthy();
  });
});

describe('levels, self-approval, managers, rejection, the posting guard and isolation', () => {
  it('APR-004 a two-level chain needs both approvals in order, by different people', async () => {
    await deactivateAll(); expect((await rule({ levels: [{ approverType: 'Role', approverRef: roleA }, { approverType: 'Role', approverRef: roleB }] })).status).toBe(200);
    await expense(1000, 'N3');
    const p = await post(admin, '/api/settlements/payments', payBody(200)); const id = p.body.requestId; expect(id).toBeTruthy();
    const before = await vouchersFor();
    expect((await post(Bu.s, R(`/requests/${id}/decide`), { action: 'Approved' })).status).toBe(403);       // level 2 cannot go first
    expect((await post(UA.s, R(`/requests/${id}/decide`), { action: 'Approved' })).body).toMatchObject({ status: 'Pending', nextLevel: 2 });
    expect(await vouchersFor()).toBe(before);
    expect((await post(UA.s, R(`/requests/${id}/decide`), { action: 'Approved' })).status).toBe(403);         // and A is not B
    expect((await post(Bu.s, R(`/requests/${id}/decide`), { action: 'Approved' })).body.status).toBe('Approved');
    expect(await vouchersFor()).toBe(before + 1);
  });

  it('APR-005/006/007 the submitter cannot approve while the company setting is off; on, they can and it is flagged and audited; only admin changes it', async () => {
    await deactivateAll(); expect((await rule()).status).toBe(200);
    await expense(1000, 'N4');
    const p = await post(S.s, '/api/settlements/payments', payBody(300)); const id = p.body.requestId;
    expect((await post(S.s, R(`/requests/${id}/decide`), { action: 'Approved' })).status).toBe(403);
    expect((await get(S.s, R('/my'))).body.waiting.some((x: any) => x.id === id)).toBe(false);
    expect((await put(S.s, '/api/ledger/journal-settings', { selfApproval: true })).status).toBe(403);       // not an administrator
    expect((await put(admin, '/api/ledger/journal-settings', { selfApproval: true })).status).toBe(200);
    const ok = await post(S.s, R(`/requests/${id}/decide`), { action: 'Approved' }); expect(ok.body.status).toBe('Approved');
    expect((await get(S.s, R(`/requests/${id}`))).body.selfApproved).toBe(true);
    const log = (await db.execute(sql`SELECT COUNT(*)::int AS n FROM audit_logs WHERE company_id = ${A_}::uuid AND action = 'UPDATE_JOURNAL_SETTING'`)) as any; expect(log.rows[0].n).toBeGreaterThan(0);
    await put(admin, '/api/ledger/journal-settings', { selfApproval: false });
  });

  it('APR-008 the manager of the submitter can be the approver, nobody else', async () => {
    await deactivateAll(); expect((await rule({ levels: [{ approverType: 'Manager', managerSteps: 1 }] })).status).toBe(200);
    await expense(1000, 'N5');
    const id = (await post(S2.s, '/api/settlements/payments', payBody(250))).body.requestId;
    expect((await post(UA.s, R(`/requests/${id}/decide`), { action: 'Approved' })).status).toBe(403);
    expect((await post(M.s, R(`/requests/${id}/decide`), { action: 'Approved' })).body.status).toBe('Approved');
  });

  it('APR-009 a rejection needs remarks, posts nothing and keeps the history', async () => {
    await deactivateAll(); expect((await rule()).status).toBe(200);
    await expense(1000, 'N6');
    const id = (await post(admin, '/api/settlements/payments', payBody(260))).body.requestId; const before = await vouchersFor();
    expect((await post(UA.s, R(`/requests/${id}/decide`), { action: 'Rejected' })).status).toBe(400);
    expect((await post(UA.s, R(`/requests/${id}/decide`), { action: 'Rejected', remarks: 'Wrong bank' })).body.status).toBe('Rejected');
    expect(await vouchersFor()).toBe(before);
    const d = (await get(admin, R(`/requests/${id}`))).body; expect(d.status).toBe('Rejected'); expect(d.actions[0].remarks).toBe('Wrong bank');
  });

  it('APR-012 the posting guard runs again at the last approval: a lock date set meanwhile refuses it and the request stays pending', async () => {
    await expense(1000, 'N7');
    const id = (await post(admin, '/api/settlements/payments', payBody(270))).body.requestId; const before = await vouchersFor();
    expect((await put(admin, '/api/ledger/posting-policy', { lockDate: TODAY })).status).toBe(200);
    const r = await post(UA.s, R(`/requests/${id}/decide`), { action: 'Approved' });
    expect(r.status).toBe(400); expect(await vouchersFor()).toBe(before);
    expect((await get(admin, R(`/requests/${id}`))).body).toMatchObject({ status: 'Pending' });
    expect((await get(admin, R(`/requests/${id}`))).body.actions).toHaveLength(0);                 // the failed attempt left no trace
    await put(admin, '/api/ledger/posting-policy', { lockDate: null });
  });

  it('another company sees none of the rules or requests, and a retired rule stops matching', async () => {
    const id = (await db.execute(sql`SELECT id FROM approval_requests WHERE company_id = ${A_}::uuid LIMIT 1`) as any).rows[0].id;
    expect((await get(other.admin, R(`/requests/${id}`))).status).toBe(404);
    expect((await post(other.admin, R(`/requests/${id}/decide`), { action: 'Approved' })).status).toBe(404);
    expect((await get(other.admin, R('/rules'))).body.rules).toHaveLength(0);
    await deactivateAll(); await expense(1000, 'N8');
    expect((await post(admin, '/api/settlements/payments', payBody(400))).body.pendingApproval).toBeUndefined();
  });
});

describe('vendor bills follow the same rules (Sprint 11)', () => {
  let warehouseId = '', productId = '';
  const grn = async (qty: number, cost: number) => {
    const r = await post(admin, '/api/inventory/goods-receipt-notes', { grnData: { isDsd: true, vendorId: vend, warehouseId, receivedBy: 'Test', items: [{ productId, quantityReceived: qty, unitCost: cost, taxRate: 15 }] } });
    if (r.status !== 200) throw new Error(`grn ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.goodsReceiptNote.id as string;
  };
  const billRows = async () => ((await db.execute(sql`SELECT COUNT(*)::int AS n FROM purchase_bills WHERE company_id = ${A_}::uuid`)) as any).rows[0].n as number;
  const billBody = (grnId: string) => ({ billData: { docDate: TODAY, grnIds: [grnId], bankId, vendorBillNumber: 'V-' + grnId.slice(0, 6) } });
  it('APR-013 a bill above the band waits (no bill, GRN still unbilled), a bill below posts, and the last approval creates the bill once', async () => {
    await deactivateAll();
    warehouseId = (await db.select().from(schema.warehouses).where(eq(schema.warehouses.companyId, A_)))[0]?.id;
    if (!warehouseId) { warehouseId = generateId(); await db.insert(schema.warehouses).values({ id: warehouseId, name: 'Main', code: 'W1', companyId: A_ } as any); }
    productId = generateId(); await db.insert(schema.productsServices).values({ id: productId, name: 'Approval Widget', description: 'x', unitPrice: '10.00', itemKind: 'item', companyId: A_ } as any);
    expect((await rule({ name: 'Bills above 500', documentType: 'VendorBill', minAmount: 500 })).status).toBe(200);
    const small = await grn(2, 50);                                                            // 100 + VAT: below the band
    expect((await post(admin, '/api/inventory/purchase-bills', billBody(small))).body.pendingApproval).toBeUndefined();
    const big = await grn(10, 100);                                                            // 1000 + VAT 150
    const before = await billRows();
    const p = await post(S.s, '/api/inventory/purchase-bills', billBody(big));
    expect(p.status).toBe(200); expect(p.body.pendingApproval).toBe(true);
    expect(await billRows()).toBe(before);                                                     // nothing written for the waiting bill
    expect((await db.select().from(schema.goodsReceiptNotes).where(eq(schema.goodsReceiptNotes.id, big)))[0].isBilled).toBe(false);
    expect((await post(S.s, R(`/requests/${p.body.requestId}/decide`), { action: 'Approved' })).status).toBe(403);   // the submitter
    expect((await post(UA.s, R(`/requests/${p.body.requestId}/decide`), { action: 'Approved' })).body.status).toBe('Approved');
    expect(await billRows()).toBe(before + 1);
    expect((await db.select().from(schema.goodsReceiptNotes).where(eq(schema.goodsReceiptNotes.id, big)))[0].isBilled).toBe(true);
  });

  it('APR-014 the "paid at delivery" shortcut cannot bypass a rule: it is refused whole, and allowed when no rule applies', async () => {
    const grnCount = async () => ((await db.execute(sql`SELECT COUNT(*)::int AS n FROM goods_receipt_notes WHERE company_id = ${A_}::uuid`)) as any).rows[0].n as number;
    const before = await grnCount();
    const refused = await post(admin, '/api/inventory/goods-receipt-notes', { grnData: { isDsd: true, vendorId: vend, warehouseId, receivedBy: 'Test', autoPostBillPaid: true, billBankId: bankId, vendorBillNumber: 'AP-1', items: [{ productId, quantityReceived: 10, unitCost: 100, taxRate: 15 }] } });
    expect(refused.status).toBe(400); expect(refused.body.error).toMatch(/approval rule/i);
    expect(await grnCount()).toBe(before);                                                    // the receipt was not kept
    await deactivateAll();
    const ok = await post(admin, '/api/inventory/goods-receipt-notes', { grnData: { isDsd: true, vendorId: vend, warehouseId, receivedBy: 'Test', autoPostBillPaid: true, billBankId: bankId, vendorBillNumber: 'AP-2', items: [{ productId, quantityReceived: 10, unitCost: 100, taxRate: 15 }] } });
    expect(ok.status).toBe(200); expect(await grnCount()).toBe(before + 1);
  });
});

describe('the manager of a user (feeds the Manager approver)', () => {
  it('APR-015 a manager must be a user of the same company, never the user themselves, and the chain cannot loop', async () => {
    const mk = async (id: string, extra: any) => { const r = await post(admin, '/api/users', { id, password: PW, email: `mgr_${id.slice(-8)}@example.com`, role: 'user', companyId: A_, ...extra }); return r; };
    const u1 = generateId();
    expect((await mk(u1, { managerId: M.id })).status).toBe(200);
    expect((await db.select().from(schema.users).where(eq(schema.users.id, u1)))[0].managerId).toBe(M.id);
    const foreign = (await db.insert(schema.users).values({ id: generateId(), username: 'fm_' + generateId().slice(-8), password: 'x', role: 'user', companyId: other.id, isSuperAdmin: false, uiLanguage: 'en' } as any).returning())[0];
    expect((await mk(generateId(), { managerId: foreign.id })).status).toBe(400);                 // another company's user
    const u2 = generateId(); expect((await mk(u2, {})).status).toBe(200);
    expect((await mk(u2, { managerId: u2 })).status).toBe(400);                                    // their own manager
    await db.update(schema.users).set({ managerId: u1 }).where(eq(schema.users.id, M.id));         // M reports to u1 ...
    expect((await mk(u1, { managerId: M.id })).status).toBe(400);                                  // ... so u1 cannot report to M
    await db.update(schema.users).set({ managerId: null }).where(eq(schema.users.id, M.id));
    await db.delete(schema.users).where(eq(schema.users.id, foreign.id));
  });
});

describe('recall and delegation (Sprint 11)', () => {
  const pend = async (amount: number, session = admin) => (await post(session, '/api/settlements/payments', payBody(amount))).body.requestId as string;
  it('APR-010 the submitter can recall a pending request (nobody else can); nothing was posted and the history keeps it; it can be resubmitted', async () => {
    await deactivateAll(); expect((await rule()).status).toBe(200); await expense(1000, 'R1');
    const id = await pend(280); const before = await vouchersFor();
    expect((await post(UA.s, R(`/requests/${id}/recall`), {})).status).toBe(403);                     // not the submitter
    expect((await post(admin, R(`/requests/${id}/recall`), { remarks: 'wrong bank' })).status).toBe(200);
    const d = (await get(admin, R(`/requests/${id}`))).body; expect(d.status).toBe('Recalled'); expect(d.actions[0]).toMatchObject({ action: 'Recalled', remarks: 'wrong bank' });
    expect((await post(UA.s, R(`/requests/${id}/decide`), { action: 'Approved' })).status).toBe(400);   // no longer pending
    expect(await vouchersFor()).toBe(before);
    expect((await post(admin, R(`/requests/${id}/recall`), {})).status).toBe(400);                       // only once
    expect(await pend(280)).toBeTruthy();                                                                 // a fresh request can be submitted
  });

  it('APR-011 a delegate may decide inside the period and not outside it, and the history names who they acted for', async () => {
    await deactivateAll(); expect((await rule()).status).toBe(200); await expense(1000, 'R2');
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10), yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10), nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const deputy = await mkU(ROLE_PERMS);                                                                  // holds no level authority of their own
    const id = await pend(290);
    expect((await post(deputy.s, R(`/requests/${id}/decide`), { action: 'Approved' })).status).toBe(403);
    expect((await post(UA.s, R('/delegations'), { delegateId: UA.id, validFrom: yesterday, validTo: nextWeek })).status).toBe(400);   // not to yourself
    expect((await post(UA.s, R('/delegations'), { delegateId: deputy.id, validFrom: nextWeek, validTo: yesterday })).status).toBe(400); // end before start
    const future = await post(UA.s, R('/delegations'), { delegateId: deputy.id, validFrom: tomorrow, validTo: nextWeek }); expect(future.status).toBe(200);
    expect((await post(deputy.s, R(`/requests/${id}/decide`), { action: 'Approved' })).status).toBe(403);   // not started yet
    await patch(UA.s, R(`/delegations/${future.body.id}/end`));
    expect((await post(UA.s, R('/delegations'), { delegateId: deputy.id, validFrom: yesterday, validTo: yesterday })).status).toBe(200);
    expect((await post(deputy.s, R(`/requests/${id}/decide`), { action: 'Approved' })).status).toBe(403);   // already over
    const live = await post(UA.s, R('/delegations'), { delegateId: deputy.id, validFrom: yesterday, validTo: nextWeek }); expect(live.status).toBe(200);
    expect((await get(deputy.s, R('/my'))).body.waiting.some((x: any) => x.id === id)).toBe(true);
    const before = await vouchersFor();
    expect((await post(deputy.s, R(`/requests/${id}/decide`), { action: 'Approved' })).body.status).toBe('Approved');
    expect(await vouchersFor()).toBe(before + 1);
    expect((await get(admin, R(`/requests/${id}`))).body.actions[0].onBehalfOf).toBeTruthy();
    expect((await get(other.admin, R('/delegations'))).body.rows).toHaveLength(0);                         // another company sees none
  });
});
