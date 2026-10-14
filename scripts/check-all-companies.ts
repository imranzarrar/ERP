// READ-ONLY. Runs the reporting consistency check (server/lib/consistencyCheck.ts, the same rules as GET /api/reports/consistency-check)
// for every company in the database and prints one line per company, then the failing rules. It writes nothing.
//
//   npx tsx scripts/check-all-companies.ts                      # every company, as of today
//   npx tsx scripts/check-all-companies.ts <name>               # only companies whose name contains <name> (case-insensitive)
//   npx tsx scripts/check-all-companies.ts "" 2027-01-12        # as of a given date (use when documents are dated after today)
//
// A company with documents but NO journal entries was created before the ledger existed ("pre-ledger"): the books-balance rules cannot hold
// for it, so it is listed separately and does not fail the run. Exit code 1 only if a company that has ledger entries has an error-level failure.
import { eq, sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { computeConsistencyCheck } from '../server/lib/consistencyCheck.js';

const filter = (process.argv[2] || '').toLowerCase();
const asOf = /^\d{4}-\d{2}-\d{2}$/.test(process.argv[3] || '') ? process.argv[3] : undefined;
const companies = ((await db.select().from(schema.companies)) as any[]).filter(c => !filter || String(c.name).toLowerCase().includes(filter));

const count = async (table: any, col: any, id: string) => Number((await db.select({ n: sql<number>`count(*)` }).from(table).where(eq(col, id)))[0].n);

let failed = 0;
const preLedger: string[] = [];
for (const c of companies) {
  const docs = (await count(schema.invoices, schema.invoices.companyId, c.id)) + (await count(schema.expenses, schema.expenses.companyId, c.id));
  const entries = await count(schema.journalEntries, schema.journalEntries.companyId, c.id);
  const label = String(c.name).padEnd(40).slice(0, 40);
  try {
    const r = await computeConsistencyCheck(db, c.id, asOf);
    const failing = r.checks.filter(x => !x.ok);
    if (docs > 0 && entries === 0) {
      preLedger.push(`${c.name} (${docs} documents, no journal entries${r.errors ? `, would show ${r.errors} error(s)` : ''})`);
      continue;
    }
    if (r.errors > 0) failed++;
    console.log(`${r.errors > 0 ? 'FAIL' : failing.length ? 'warn' : ' ok '}  ${label}  ${r.checks.length} rules, ${r.errors} error(s), ${r.warnings} warning(s); ${docs} documents, ${entries} journal entries; as of ${r.asOf}`);
    for (const f of failing) console.log(`        ${f.severity === 'error' ? 'ERROR' : 'warn '} ${f.id}  ${f.rule}  —  ${f.detail}`);
  } catch (e: any) {
    failed++;
    console.log(`FAIL  ${label}  could not run: ${e.message}`);
  }
}
if (preLedger.length) {
  console.log(`\nPre-ledger companies (documents made before the ledger existed; the balance rules cannot hold for them, not checked):`);
  for (const p of preLedger) console.log(`   - ${p}`);
}
console.log(`\n${companies.length} compan${companies.length === 1 ? 'y' : 'ies'} found; ${failed} ledger-era compan${failed === 1 ? 'y' : 'ies'} with errors.`);
process.exit(failed > 0 ? 1 : 0);
