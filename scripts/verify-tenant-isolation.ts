// Proves Postgres Row-Level Security really isolates companies, using the same restricted role
// (erp_app_tenant) the app connects as. Safe to run against production: everything happens inside
// ONE transaction that is always rolled back, so no company, customer or bank row is ever
// committed and nothing is left behind.
//
// Usage (repo root, where app.secrets lives):  npx tsx scripts/verify-tenant-isolation.ts
// Exit code 0 = every check passed; 1 = a check failed (or could not run).
import dotenv from 'dotenv';
dotenv.config({ path: 'app.secrets', quiet: true });
import { sql, eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';

const ROLLBACK = new Error('rollback-sentinel');
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

async function main() {
  const companyA = generateId();
  const companyB = generateId();
  const custA = generateId();
  const custB = generateId();
  const bankB = generateId();

  try {
    await db.transaction(async (tx: any) => {
      const mkCompany = (id: string, n: string) => tx.insert(schema.companies).values({
        id, name: `ISOLATION-CHECK ${n}`, address: 'x', phone: '0', email: `isolation-${n}@example.invalid`,
        logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false, themeId: 'classic-executive',
      } as any);
      await mkCompany(companyA, 'A');
      await mkCompany(companyB, 'B');
      await tx.insert(schema.customers).values({ id: custA, name: 'Customer of A', phone: '0', email: 'a@example.invalid', address: 'x', companyId: companyA, buyerType: 'B2C' } as any);
      await tx.insert(schema.customers).values({ id: custB, name: 'Customer of B', phone: '0', email: 'b@example.invalid', address: 'x', companyId: companyB, buyerType: 'B2C' } as any);
      await tx.insert(schema.bankAccounts).values({ id: bankB, bankName: 'Bank of B', accountNumber: '1', accountTitle: 'B', openingBalance: '0', isActive: true, isDefault: true, companyId: companyB } as any);

      // From here on act exactly like the app's tenant connection: restricted role, company set per transaction.
      await tx.execute(sql`set local role erp_app_tenant`);

      const asCompany = async (id: string | null) => {
        await tx.execute(sql`select set_config('app.company_id', ${id ?? ''}, true)`);
      };
      const names = async (table: any) => (await tx.select().from(table)).map((r: any) => r.name ?? r.bankName);

      await asCompany(companyA);
      const seenByA = await names(schema.customers);
      check('company A sees its own customer', seenByA.includes('Customer of A'));
      check('company A does NOT see company B\'s customer', !seenByA.includes('Customer of B'));
      check('company A does NOT see company B\'s bank account', !(await names(schema.bankAccounts)).includes('Bank of B'));
      const allCompanies = (await tx.select().from(schema.companies)).map((r: any) => r.name);
      check('company A cannot list company B in the companies table', !allCompanies.includes('ISOLATION-CHECK B') && allCompanies.includes('ISOLATION-CHECK A'));

      await asCompany(companyB);
      const seenByB = await names(schema.customers);
      check('company B sees its own customer', seenByB.includes('Customer of B'));
      check('company B does NOT see company A\'s customer', !seenByB.includes('Customer of A'));

      await asCompany(companyA);
      const upd = await tx.update(schema.customers).set({ name: 'HIJACKED' }).where(eq(schema.customers.id, custB)).returning();
      check('company A cannot UPDATE company B\'s row', upd.length === 0, `rows affected: ${upd.length}`);
      const del = await tx.delete(schema.customers).where(eq(schema.customers.id, custB)).returning();
      check('company A cannot DELETE company B\'s row', del.length === 0, `rows affected: ${del.length}`);

      let insertBlocked = false;
      try {
        await tx.transaction(async (sp: any) => {
          await sp.insert(schema.customers).values({ id: generateId(), name: 'Planted in B by A', phone: '0', email: 'x@example.invalid', address: 'x', companyId: companyB, buyerType: 'B2C' } as any);
        });
      } catch { insertBlocked = true; }
      check('company A cannot INSERT a row into company B', insertBlocked);

      await tx.execute(sql`reset app.company_id`);
      let visibleWithoutCompany = -1; // -1 = the query was refused outright (also a safe outcome)
      try {
        await tx.transaction(async (sp: any) => { visibleWithoutCompany = (await sp.select().from(schema.customers)).length; });
      } catch { visibleWithoutCompany = -1; }
      check('with NO company set, no customer rows are visible (zero rows or refused)', visibleWithoutCompany <= 0, visibleWithoutCompany === -1 ? 'query refused' : `visible: ${visibleWithoutCompany}`);

      throw ROLLBACK; // always discard everything created above
    });
  } catch (err) {
    if (err !== ROLLBACK) {
      console.error('Could not run the isolation check:', (err as any)?.message || err);
      failures++;
    }
  }

  // Confirm nothing was left behind.
  const leftover = await db.select().from(schema.companies).where(sql`${schema.companies.name} like 'ISOLATION-CHECK %'`);
  check('temporary companies were rolled back (nothing left behind)', leftover.length === 0, `leftover: ${leftover.length}`);

  console.log(failures === 0 ? '\nALL ISOLATION CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
