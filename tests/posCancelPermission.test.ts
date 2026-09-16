import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Regression test for a real, previously-dead permission: pos.cancel existed in
// permissionSchema.ts (a real, checkable "Allow POS Order Cancellations" leaf in the
// Roles editor) but POST /invoices/:id/cancel — the only route that ever cancels a POS
// sale — checked invoice.delete unconditionally instead, for every invoice regardless of
// origin. An admin unchecking pos.cancel for a role believed they'd blocked that role
// from cancelling POS sales; they hadn't, as long as invoice.delete was still granted.
// Fixed: the route now branches on the invoice's own isPosSale — pos.cancel for a POS
// sale, invoice.delete for everything else. This test proves both halves of that split,
// in both directions (a role with one leaf but not the other).
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let invoiceDeleteOnlyUserId: string;
let posCancelOnlyUserId: string;
let customerId: string;
let taxSlabId: string;
let bankId: string;

async function login(username: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });
  const body = await res.json().catch(() => null);
  if (!body?.sessionId) throw new Error(`Login failed for ${username}: ${JSON.stringify(body)}`);
  return body.sessionId;
}

async function cancelInvoice(sessionId: string, invoiceId: string) {
  const res = await fetch(`${BASE_URL}/api/transactions/invoices/${invoiceId}/cancel`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function makeInvoice(invoiceNumber: string, isPosSale: boolean): Promise<string> {
  const id = generateId();
  await db.insert(schema.invoices).values({
    id, invoiceNumber, date: new Date().toISOString().split('T')[0],
    customerId, taxSlabId, bankId, paymentStatus: 'Unpaid', notes: 'x', status: 'Active',
    createdById: invoiceDeleteOnlyUserId, createdAt: new Date(), companyId, isPosSale,
  } as any);
  return id;
}

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId, name: 'POS Cancel Permission Test Co', address: 'x', phone: '0',
    email: 'poscancelperm@example.com', logoUrl: '', customHeader: '', customFooter: '',
    currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
  } as any);

  const monthId = new Date().toISOString().slice(0, 7);
  await db.insert(schema.fiscalMonths).values({
    id: monthId, name: monthId, status: 'Open', companyId,
  }).onConflictDoNothing();

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

  const invoiceDeleteRoleId = generateId();
  await db.insert(schema.roles).values({
    id: invoiceDeleteRoleId, companyId, name: 'Invoice Delete Only',
    permissions: { invoice: { delete: { enabled: true } } },
  });
  invoiceDeleteOnlyUserId = generateId();
  const invoiceDeleteOnlyUsername = `poscancelperm_invdel_${invoiceDeleteOnlyUserId}`;
  await db.insert(schema.users).values({
    id: invoiceDeleteOnlyUserId, username: invoiceDeleteOnlyUsername, password: passwordHash,
    role: 'user', companyId, isSuperAdmin: false, uiLanguage: 'en',
  });
  await db.insert(schema.userRoles).values({ userId: invoiceDeleteOnlyUserId, roleId: invoiceDeleteRoleId });

  const posCancelRoleId = generateId();
  await db.insert(schema.roles).values({
    id: posCancelRoleId, companyId, name: 'POS Cancel Only',
    permissions: { pos: { cancel: { enabled: true } } },
  });
  posCancelOnlyUserId = generateId();
  const posCancelOnlyUsername = `poscancelperm_poscancel_${posCancelOnlyUserId}`;
  await db.insert(schema.users).values({
    id: posCancelOnlyUserId, username: posCancelOnlyUsername, password: passwordHash,
    role: 'user', companyId, isSuperAdmin: false, uiLanguage: 'en',
  });
  await db.insert(schema.userRoles).values({ userId: posCancelOnlyUserId, roleId: posCancelRoleId });

  customerId = generateId();
  await db.insert(schema.customers).values({
    id: customerId, name: 'POS Cancel Perm Customer', phone: '0500000099', email: 'pcpc@example.com', address: 'x', companyId, buyerType: 'B2C',
  } as any);

  taxSlabId = generateId();
  await db.insert(schema.taxSlabs).values({
    id: taxSlabId, name: 'PosCancelPerm 15%', percentage: '15', companyId, isDefault: false,
  });

  bankId = generateId();
  await db.insert(schema.bankAccounts).values({
    id: bankId, bankName: 'PosCancelPerm Bank', accountNumber: '8888', accountTitle: 'X',
    openingBalance: '0', isActive: true, isDefault: true, companyId,
  });
}, 30000);

afterAll(async () => {
  await db.delete(schema.vouchers).where(eq(schema.vouchers.companyId, companyId));
  await db.delete(schema.invoices).where(eq(schema.invoices.companyId, companyId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, companyId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyId));
  await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, invoiceDeleteOnlyUserId));
  await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, posCancelOnlyUserId));
  await db.delete(schema.roles).where(eq(schema.roles.companyId, companyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.companyId, companyId));
  await db.delete(schema.users).where(eq(schema.users.id, invoiceDeleteOnlyUserId));
  await db.delete(schema.users).where(eq(schema.users.id, posCancelOnlyUserId));
  await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
}, 30000);

describe('pos.cancel — previously-dead permission now actually gates POS-sale cancellation', () => {
  it('a role with invoice.delete but NOT pos.cancel cannot cancel a POS-sold invoice', async () => {
    const sessionId = await login(`poscancelperm_invdel_${invoiceDeleteOnlyUserId}`);
    const invoiceId = await makeInvoice('INV-POSCANCELPERM-1', true);
    const { status, body } = await cancelInvoice(sessionId, invoiceId);
    expect(status).toBe(403);
    const [row] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
    expect(row.status).toBe('Active');
  });

  it('a role with invoice.delete but NOT pos.cancel CAN still cancel a regular (non-POS) invoice', async () => {
    const sessionId = await login(`poscancelperm_invdel_${invoiceDeleteOnlyUserId}`);
    const invoiceId = await makeInvoice('INV-POSCANCELPERM-2', false);
    const { status } = await cancelInvoice(sessionId, invoiceId);
    expect(status).toBe(200);
    const [row] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
    expect(row.status).toBe('Cancelled');
  });

  it('a role with pos.cancel but NOT invoice.delete cannot cancel a regular (non-POS) invoice', async () => {
    const sessionId = await login(`poscancelperm_poscancel_${posCancelOnlyUserId}`);
    const invoiceId = await makeInvoice('INV-POSCANCELPERM-3', false);
    const { status } = await cancelInvoice(sessionId, invoiceId);
    expect(status).toBe(403);
    const [row] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
    expect(row.status).toBe('Active');
  });

  it('a role with pos.cancel but NOT invoice.delete CAN cancel a POS-sold invoice', async () => {
    const sessionId = await login(`poscancelperm_poscancel_${posCancelOnlyUserId}`);
    const invoiceId = await makeInvoice('INV-POSCANCELPERM-4', true);
    const { status } = await cancelInvoice(sessionId, invoiceId);
    expect(status).toBe(200);
    const [row] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
    expect(row.status).toBe('Cancelled');
  });
});
