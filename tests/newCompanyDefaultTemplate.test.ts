import { describe, it, expect, afterAll } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { provisionStarterResources } from '../server/lib/companyProvisioning.js';

// A brand-new company's starter print templates: "Detailed Compact (A4)" is the one pre-selected
// (isActive) in the Print dialog; "Compact A4" and "Compact A4 Arabic" are saved but inactive.
// Real Postgres, no mocks — runs the real provisioning function on a throwaway company.
const NAME_PREFIX = 'Default Template Test Co';

afterAll(async () => {
  const rows = await db.select({ id: schema.companies.id }).from(schema.companies).where(like(schema.companies.name, `${NAME_PREFIX}%`));
  for (const { id: companyId } of rows) {
    await db.delete(schema.documentTemplates).where(eq(schema.documentTemplates.companyId, companyId));
    await db.delete(schema.fiscalMonths).where(eq(schema.fiscalMonths.companyId, companyId));
    await db.delete(schema.unitsOfMeasure).where(eq(schema.unitsOfMeasure.companyId, companyId));
    await db.delete(schema.warehouses).where(eq(schema.warehouses.companyId, companyId));
    await db.delete(schema.taxSlabs).where(eq(schema.taxSlabs.companyId, companyId));
    await db.delete(schema.vendors).where(eq(schema.vendors.companyId, companyId));
    await db.delete(schema.customers).where(eq(schema.customers.companyId, companyId));
    await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyId));
    await db.delete(schema.documentCounters).where(eq(schema.documentCounters.companyId, companyId));
    await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
  }
});

describe('new company starter templates', () => {
  it('provisions three templates with Detailed Compact (A4) as the only active English one', async () => {
    const companyId = generateId();
    await db.insert(schema.companies).values({
      id: companyId, name: `${NAME_PREFIX} ${companyId.slice(-6)}`, address: 'Test Address', phone: '0000000000', email: 'tpl@example.com',
      logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false,
    });
    await db.transaction(async (tx) => provisionStarterResources(tx, { companyId, companyName: 'Default Template Test Co' }));

    const templates = await db.select().from(schema.documentTemplates).where(eq(schema.documentTemplates.companyId, companyId));
    expect(templates.map(t => t.name).sort()).toEqual(['Compact A4', 'Compact A4 Arabic', 'Detailed Compact (A4)']);
    const active = templates.filter(t => t.isActive);
    expect(active.map(t => t.name)).toEqual(['Detailed Compact (A4)']);
    expect(active[0].language).toBe('English');
    expect(active[0].layoutJson).toBeTruthy();
    expect(templates.find(t => t.name === 'Compact A4')!.isActive).toBe(false);
    expect(templates.find(t => t.name === 'Compact A4 Arabic')!.isActive).toBe(false);
  });
});
