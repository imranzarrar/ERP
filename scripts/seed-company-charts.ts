// General Ledger Step 1: gives every company its chart of accounts (the standard Saudi starter chart + one ledger account per bank) and stamps every
// journal line made before the chart existed with the account it belongs to, using the roles' accounts as they stand now. Idempotent and safe to
// re-run: existing accounts are never touched, lines that already carry an account are never changed. Dry run by default.
// Usage: npx tsx scripts/seed-company-charts.ts [--apply] [--company <id>]
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { seedCompanyChart } from '../server/lib/chartOfAccounts.js';

const APPLY = process.argv.includes('--apply');
const ci = process.argv.indexOf('--company');
const ONLY = ci > -1 ? process.argv[ci + 1] : null;

const companies = (await db.select({ id: schema.companies.id, name: schema.companies.name }).from(schema.companies))
  .filter(c => !ONLY || c.id === ONLY);
console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}: ${companies.length} company(ies)`);

for (const c of companies) {
  await db.transaction(async (tx: any) => {
    const before: any = await tx.execute(sql`SELECT COUNT(*)::int AS n FROM company_accounts WHERE company_id = ${c.id}::uuid`);
    const had = Number(before.rows[0].n);
    const seeded = await seedCompanyChart(tx, c.id);
    // Stamp the lines that never got an account: by the bank's own account first, then by the role's account.
    const byBank: any = await tx.execute(sql`
      UPDATE journal_lines l SET account_id = a.id FROM company_accounts a
      WHERE l.company_id = ${c.id}::uuid AND l.account_id IS NULL AND l.account_key = 'BANK' AND l.bank_id IS NOT NULL
        AND a.company_id = l.company_id AND a.bank_id = l.bank_id`);
    const byKey: any = await tx.execute(sql`
      UPDATE journal_lines l SET account_id = a.id FROM company_accounts a
      WHERE l.company_id = ${c.id}::uuid AND l.account_id IS NULL AND l.account_key IS NOT NULL
        AND a.company_id = l.company_id AND a.system_key = l.account_key`);
    const left: any = await tx.execute(sql`SELECT COUNT(*)::int AS n FROM journal_lines WHERE company_id = ${c.id}::uuid AND account_id IS NULL`);
    console.log(`  ${c.name.padEnd(46)} accounts before ${String(had).padStart(2)} | created ${String(seeded.created).padStart(2)} + ${seeded.banks} bank | lines stamped ${(byBank.rowCount || 0) + (byKey.rowCount || 0)} | still unstamped ${left.rows[0].n}`);
    if (!APPLY) throw Object.assign(new Error('dry-run rollback'), { dryRun: true });
  }).catch((e: any) => { if (!e.dryRun) throw e; });
}
console.log(APPLY ? 'Done.' : 'Dry run only: nothing was saved. Re-run with --apply.');
process.exit(0);
