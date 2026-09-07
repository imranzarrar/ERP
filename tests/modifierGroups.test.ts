import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server (npm run dev on
// localhost:3000) + real Postgres state, matching this project's established
// no-mocks testing practice. Dedicated throwaway companies/users, torn down in
// afterAll — never touches the seeded demo companies used for manual QA.
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let otherCompanyId: string;
let adminUserId: string;
let adminSessionId: string;
let otherCompanyAdminUserId: string;
let otherCompanySessionId: string;
let customerId: string;
let bankId: string;
let taxSlabId: string;
let productId: string;
let otherCompanyModifierGroupId: string;
let createdModifierGroupId: string;
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

beforeAll(async () => {
  companyId = generateId();
  otherCompanyId = generateId();
  await db.insert(schema.companies).values([
    { id: companyId, name: 'Modifier Test Co', address: 'x', phone: '0', email: 'modtest@example.com', logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false },
    { id: otherCompanyId, name: 'Modifier Test Co Other', address: 'x', phone: '0', email: 'modtestother@example.com', logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false },
  ]);

  customerId = generateId();
  await db.insert(schema.customers).values({
    id: customerId, name: 'Walk-in Customer', phone: '-', email: '-', address: '-', companyId, buyerType: 'B2C', isSystem: true,
  });

  bankId = generateId();
  await db.insert(schema.bankAccounts).values({
    id: bankId, bankName: 'Main Operating Bank', accountNumber: 'SA123', accountTitle: 'Test Operating Account',
    openingBalance: '0', isActive: true, isDefault: true, companyId,
  });

  taxSlabId = generateId();
  await db.insert(schema.taxSlabs).values({ id: taxSlabId, name: 'Standard (15%)', percentage: '15', companyId, isDefault: true });

  productId = generateId();
  await db.insert(schema.productsServices).values({
    id: productId, name: 'Latte', description: 'Latte', unitPrice: '15', itemKind: 'service', unit: 'No', isPosItem: true, companyId,
  });

  const currentMonthId = new Date().toISOString().slice(0, 7);
  await db.insert(schema.fiscalMonths).values({ id: currentMonthId, name: 'Test Month', status: 'Open', companyId }).onConflictDoNothing();

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  adminUserId = generateId();
  const adminUsername = `modtest_admin_${adminUserId}`;
  await db.insert(schema.users).values({ id: adminUserId, username: adminUsername, password: passwordHash, role: 'admin', companyId, isSuperAdmin: false, uiLanguage: 'en' });
  adminSessionId = await login(adminUsername);

  otherCompanyAdminUserId = generateId();
  const otherUsername = `modtest_other_${otherCompanyAdminUserId}`;
  await db.insert(schema.users).values({ id: otherCompanyAdminUserId, username: otherUsername, password: passwordHash, role: 'admin', companyId: otherCompanyId, isSuperAdmin: false, uiLanguage: 'en' });
  otherCompanySessionId = await login(otherUsername);

  // A modifier group that genuinely belongs to the OTHER company — used to prove
  // cross-tenant attachment/edit attempts are rejected, not just "would be inconvenient."
  const { body: otherGroupBody } = await api(otherCompanySessionId, '/api/modifier-groups', {
    method: 'POST',
    body: JSON.stringify({ name: 'Other Co Size', isRequired: true, choices: [{ label: 'Small', priceDelta: 0 }] }),
  });
  otherCompanyModifierGroupId = otherGroupBody.id;
});

afterAll(async () => {
  if (createdInvoiceId) {
    // Paying an invoice creates a receipt voucher against the bank — must go before the
    // bank account is deleted below, same ordering posSaleZatcaPipeline.test.ts uses.
    await db.delete(schema.vouchers).where(eq(schema.vouchers.referenceId, createdInvoiceId));
    await db.delete(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, createdInvoiceId));
    await db.delete(schema.invoices).where(eq(schema.invoices.id, createdInvoiceId));
  }
  // Composite PK (id, companyId) — always scope by companyId too, never id alone (see
  // BACKLOG.md's test-suite-flakiness incident for why an unscoped delete here is
  // dangerous: fiscalMonths' id is a shared calendar-month string across every company).
  await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyId));
  await db.delete(schema.productModifierGroups).where(eq(schema.productModifierGroups.productId, productId));
  if (createdModifierGroupId) {
    await db.delete(schema.modifierChoices).where(eq(schema.modifierChoices.modifierGroupId, createdModifierGroupId));
    await db.delete(schema.modifierGroups).where(eq(schema.modifierGroups.id, createdModifierGroupId));
  }
  if (otherCompanyModifierGroupId) {
    await db.delete(schema.modifierChoices).where(eq(schema.modifierChoices.modifierGroupId, otherCompanyModifierGroupId));
    await db.delete(schema.modifierGroups).where(eq(schema.modifierGroups.id, otherCompanyModifierGroupId));
  }
  await db.delete(schema.productsServices).where(eq(schema.productsServices.id, productId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.id, taxSlabId));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.id, bankId));
  await db.delete(schema.customers).where(eq(schema.customers.id, customerId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, adminUserId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, otherCompanyAdminUserId));
  await db.delete(schema.users).where(eq(schema.users.id, adminUserId));
  await db.delete(schema.users).where(eq(schema.users.id, otherCompanyAdminUserId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, otherCompanyId));
});

describe('Modifier Group CRUD', () => {
  it('creates a group with choices, scoped to the caller\'s company', async () => {
    const { status, body } = await api(adminSessionId, '/api/modifier-groups', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Size',
        isRequired: true,
        choices: [{ label: 'Small', priceDelta: 0 }, { label: 'Medium', priceDelta: 2 }, { label: 'Large', priceDelta: 4 }],
      }),
    });
    expect(status).toBe(200);
    expect(body.id).toBeTruthy();
    createdModifierGroupId = body.id;

    const [groupRow] = await db.select().from(schema.modifierGroups).where(eq(schema.modifierGroups.id, createdModifierGroupId));
    expect(groupRow?.companyId).toBe(companyId);
    expect(groupRow?.isRequired).toBe(true);

    const choiceRows = await db.select().from(schema.modifierChoices).where(eq(schema.modifierChoices.modifierGroupId, createdModifierGroupId));
    expect(choiceRows.length).toBe(3);
    expect(choiceRows.map(c => Number(c.priceDelta)).sort((a, b) => a - b)).toEqual([0, 2, 4]);
  });

  it('only lists this company\'s own modifier groups, never another tenant\'s', async () => {
    const { status, body } = await api(adminSessionId, '/api/modifier-groups');
    expect(status).toBe(200);
    const ids = body.map((g: any) => g.id);
    expect(ids).toContain(createdModifierGroupId);
    expect(ids).not.toContain(otherCompanyModifierGroupId);
  });

  it('rejects editing another company\'s modifier group', async () => {
    const { status, body } = await api(adminSessionId, '/api/modifier-groups', {
      method: 'POST',
      body: JSON.stringify({ id: otherCompanyModifierGroupId, name: 'Hijacked', isRequired: false, choices: [{ label: 'x', priceDelta: 0 }] }),
    });
    expect(status).toBe(403);
    expect(body.error).toMatch(/another company/i);
  });
});

describe('Tenant isolation for product <-> modifier group attachment', () => {
  it('rejects attaching another company\'s modifier group id to your own product', async () => {
    const { status, body } = await api(adminSessionId, '/api/products', {
      method: 'POST',
      body: JSON.stringify({ id: productId, name: 'Latte', description: 'Latte', unitPrice: 15, itemKind: 'service', isPosItem: true, modifierGroupIds: [otherCompanyModifierGroupId] }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/not found for this company/i);

    const links = await db.select().from(schema.productModifierGroups).where(eq(schema.productModifierGroups.productId, productId));
    expect(links.length).toBe(0);
  });

  it('accepts attaching your own company\'s modifier group', async () => {
    const { status } = await api(adminSessionId, '/api/products', {
      method: 'POST',
      body: JSON.stringify({ id: productId, name: 'Latte', description: 'Latte', unitPrice: 15, itemKind: 'service', isPosItem: true, posGridPosition: 1, modifierGroupIds: [createdModifierGroupId] }),
    });
    expect(status).toBe(200);

    const links = await db.select().from(schema.productModifierGroups).where(eq(schema.productModifierGroups.productId, productId));
    expect(links.length).toBe(1);
    expect(links[0].modifierGroupId).toBe(createdModifierGroupId);

    const { body: productsBody } = await api(adminSessionId, '/api/products');
    const productRow = productsBody.find((p: any) => p.id === productId);
    expect(productRow.modifierGroupIds).toEqual([createdModifierGroupId]);
    expect(productRow.posGridPosition).toBe(1);
  });
});

describe('A modified POS sale does not disturb existing invoice/reporting math', () => {
  it('persists two differently-customized lines of the same product as two separate invoice_items rows, with modifier price deltas already folded into unitCost', async () => {
    const today = new Date().toISOString().split('T')[0];
    // Mirrors exactly what PosModule.tsx's addResolvedItemToCart produces client-side:
    // base price (15) + chosen delta, folded into unitCost before the line is ever
    // built — calculateInvoiceTotals and this route need no knowledge of modifiers.
    const invoiceData = {
      companyId,
      isPosSale: true,
      customerId,
      taxSlabId,
      bankId,
      date: today,
      paymentStatus: 'Paid',
      amountPaid: (17 + 19) * 1.15, // (15+2) + (15+4), +15% VAT
      paymentDate: today,
      notes: 'POS Sale',
      status: 'Active',
      originQuotationId: null,
      items: [
        { id: generateId(), description: 'Latte (Medium)', unitCost: 17, quantity: 1, discountAmount: 0, taxSlabId, productId },
        { id: generateId(), description: 'Latte (Large)', unitCost: 19, quantity: 1, discountAmount: 0, taxSlabId, productId },
      ],
    };

    const res = await api(adminSessionId, '/api/transactions/invoices', { method: 'POST', body: JSON.stringify({ invoiceData }) });
    expect(res.status).toBe(200);
    createdInvoiceId = res.body.invoiceId;
    expect(createdInvoiceId).toBeTruthy();

    const itemRows = await db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, createdInvoiceId!));
    expect(itemRows.length).toBe(2); // not merged into one line
    const unitCosts = itemRows.map(r => Number(r.unitCost)).sort((a, b) => a - b);
    expect(unitCosts).toEqual([17, 19]); // base 15 + delta 2, and base 15 + delta 4

    const invoiceRow = (await db.select().from(schema.invoices).where(eq(schema.invoices.id, createdInvoiceId!)))[0];
    expect(Math.round(Number(invoiceRow.amountPaid) * 100)).toBe(Math.round((17 + 19) * 1.15 * 100));

    // The concrete regression proof for "reporting is undisturbed": Item-wise Sales
    // Report (SalesReportsModule.tsx) groups strictly by productId, not by the line's
    // free-text description — so these two differently-modified lines must still roll
    // up into ONE product row with combined quantity/revenue, exactly like two plain
    // unmodified sales of the same product always have.
    const byProduct = new Map<string, { quantity: number; revenue: number }>();
    for (const item of itemRows) {
      const key = item.productId!;
      const existing = byProduct.get(key) || { quantity: 0, revenue: 0 };
      existing.quantity += Number(item.quantity);
      existing.revenue += Number(item.quantity) * Number(item.unitCost);
      byProduct.set(key, existing);
    }
    expect(byProduct.size).toBe(1);
    expect(byProduct.get(productId)!.quantity).toBe(2);
    expect(byProduct.get(productId)!.revenue).toBe(36); // 17 + 19
  });
});
