import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

// Real integration tests against the already-running dev server (npm run dev on
// localhost:3000) + real Postgres state, matching this project's established no-mocks
// testing practice (tests/zatcaWorkflow.test.ts, tests/nonTransactionalSync.test.ts).
// Verifies the ZATCA unit-code feature end to end: Units of Measure creation is
// constrained to the allowed list, a product's unit flows onto invoice line items, and
// the generated ZATCA XML actually carries the real per-item unitCode instead of the
// previously-hardcoded 'PCE'. The generated XML is also written to a scratch file for a
// subsequent real `fatoora -validate` dual-gate run (this project's established ZATCA
// verification standard — see CLAUDE.md and docs/zatca/sandbox-qa-test-plan.html).
const BASE_URL = 'http://localhost:3000';
const TEST_PASSWORD = 'AutoTest_Pw_2026!';

let companyId: string;
let userId: string;
let customerId: string;
let taxSlabId: string;
let bankId: string;
let sessionId: string;
let monthId: string;
const unitIds: string[] = [];
const productIds: string[] = [];
const createdInvoiceIds: string[] = [];

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

beforeAll(async () => {
  companyId = generateId();
  await db.insert(schema.companies).values({
    id: companyId,
    name: 'Unit Code Test Co',
    address: 'Test Address',
    phone: '0000000000',
    email: 'unitcodetest@example.com',
    logoUrl: '',
    customHeader: '',
    customFooter: '',
    currency: 'SAR',
    counters: {},
    zatcaEnabled: false, // matches zatcaWorkflow.test.ts's DISABLED-preview case — xmlContent/qrCodeContent are still generated, just never submitted over the network.
  });

  monthId = new Date().toISOString().slice(0, 7);
  await db.insert(schema.fiscalMonths).values({ id: monthId, name: monthId, status: 'Open', companyId }).onConflictDoNothing();

  taxSlabId = generateId();
  await db.insert(schema.taxSlabs).values({ id: taxSlabId, name: 'Standard 15%', percentage: '15', companyId });

  customerId = generateId();
  await db.insert(schema.customers).values({
    id: customerId, name: 'Unit Code Test Customer', phone: '0000000000', email: 'buyer@example.com',
    address: 'Test Address', companyId, buyerType: 'B2B',
  });

  bankId = generateId();
  await db.insert(schema.bankAccounts).values({
    id: bankId, bankName: 'Test Bank', accountNumber: '000111222', accountTitle: 'Unit Code Test Co',
    openingBalance: '0', companyId,
  });

  userId = generateId();
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  const username = `unitcodetest_${userId}`;
  await db.insert(schema.users).values({ id: userId, username, password: passwordHash, role: 'admin', companyId, isSuperAdmin: false });

  const loginRes = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });
  const loginBody = await loginRes.json().catch(() => null);
  if (!loginBody?.sessionId) throw new Error(`Login failed: ${loginRes.status} ${JSON.stringify(loginBody)}`);
  sessionId = loginBody.sessionId;
});

afterAll(async () => {
  for (const invId of createdInvoiceIds) {
    await db.delete(schema.vouchers).where(eq(schema.vouchers.referenceId, invId));
    await db.delete(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, invId));
  }
  await db.delete(schema.invoices).where(eq(schema.invoices.companyId, companyId));
  for (const id of productIds) await db.delete(schema.productsServices).where(eq(schema.productsServices.id, id));
  for (const id of unitIds) await db.delete(schema.unitsOfMeasure).where(eq(schema.unitsOfMeasure.id, id));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyId));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, companyId));
  await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyId));
  await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyId));
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.userId, userId));
  await db.delete(schema.users).where(eq(schema.users.id, userId));
  await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyId));
  await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
});

describe('POST /api/units-of-measure — ZATCA code allowlist', () => {
  it('rejects a code not on the ZATCA UN/ECE Rec 20 list', async () => {
    const { status, body } = await api('/api/units-of-measure', {
      method: 'POST',
      body: JSON.stringify({ id: generateId(), name: 'Box', code: 'BOX' }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/not a recognized ZATCA unit code/);
  });

  it('accepts a real ZATCA code', async () => {
    const id = generateId();
    const { status, body } = await api('/api/units-of-measure', {
      method: 'POST',
      body: JSON.stringify({ id, name: 'Kilogram', code: 'KGM' }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    unitIds.push(id);
  });
});

describe('Unit code flows from product through invoice into the real ZATCA XML', () => {
  it('creates 4 products with 4 different ZATCA units, invoices all 4, and the generated XML carries the correct unitCode per line', async () => {
    const unitDefs = [
      { code: 'PCE', name: 'Piece' },
      { code: 'KGM', name: 'Kilogram' },
      { code: 'MTR', name: 'Metre' },
      { code: 'LTR', name: 'Litre' },
    ];

    // 1. Create the 4 units (through the real, now-validated route).
    for (const u of unitDefs) {
      const id = generateId();
      const { status } = await api('/api/units-of-measure', { method: 'POST', body: JSON.stringify({ id, name: u.name, code: u.code }) });
      expect(status).toBe(200);
      unitIds.push(id);
    }

    // 2. Create 4 products, one per unit, through the real product route.
    const products: { id: string; unit: string }[] = [];
    for (const u of unitDefs) {
      const id = generateId();
      const { status } = await api('/api/products', {
        method: 'POST',
        body: JSON.stringify({
          id, name: `Test Product (${u.code})`, description: `Sold in ${u.name}`,
          unitPrice: 50, itemKind: 'item', unit: u.code, isPosItem: false,
        }),
      });
      expect(status).toBe(200);
      productIds.push(id);
      products.push({ id, unit: u.code });
    }

    // 3. Build a real invoice with 4 line items, one per product/unit — exactly what
    // InvoiceModule.tsx's catalog-match now does (unitCost/unit inherited from the
    // matched product).
    const items = unitDefs.map((u, idx) => ({
      id: generateId(),
      description: `Test Product (${u.code})`,
      unitCost: 50 + idx,
      quantity: 2 + idx,
      discountAmount: 0,
      unit: u.code,
    }));

    const { status: createStatus, body: createBody } = await api('/api/transactions/invoices', {
      method: 'POST',
      body: JSON.stringify({
        invoiceData: {
          date: new Date().toISOString().split('T')[0],
          customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: 0,
          items,
        },
      }),
    });
    expect(createStatus).toBe(200);
    const invId = createBody.invoiceId as string;
    createdInvoiceIds.push(invId);

    // 4. Verify the persisted invoice_items rows carry the right unit each.
    const savedItems = await db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, invId));
    expect(savedItems.length).toBe(4);
    for (const u of unitDefs) {
      const row = savedItems.find(i => i.description === `Test Product (${u.code})`);
      expect(row?.unit).toBe(u.code);
    }

    // 5. processInvoiceZatca runs fire-and-forget after the create response returns —
    // wait for it, then verify the actual generated UBL XML has the real per-item
    // unitCode, not the old hardcoded 'PCE' for every line.
    await new Promise((r) => setTimeout(r, 800));
    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invId));
    expect(invoice.xmlContent).toBeTruthy();
    const xml = invoice.xmlContent as string;

    for (const u of unitDefs) {
      expect(xml).toContain(`unitCode="${u.code}"`);
    }
    // Exactly 4 InvoicedQuantity lines, one per distinct unit above — guards against a
    // regression back to a single hardcoded code repeated 4 times.
    const matches = xml.match(/unitCode="[A-Z0-9]+"/g) || [];
    expect(new Set(matches).size).toBe(4);

    // Write the real generated XML to a scratch file for a manual `fatoora -validate`
    // dual-gate run — this project's established ZATCA verification standard.
    const outDir = path.join(process.cwd(), '.claude', 'scratch');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'unit-code-test-invoice.xml');
    fs.writeFileSync(outPath, xml, 'utf-8');
    console.log(`Wrote generated XML for SDK dual-gate validation to: ${outPath}`);
  });
});
