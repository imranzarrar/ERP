// Wipes ONE company's transactional data (documents, ledger, stock, months, VAT returns) and leaves its master data
// (customers, vendors, products, banks, tax slabs, templates, users, roles, warehouses, ...) untouched.
//
// Hard-wired to the SharpSurv test company on purpose: it refuses any other id or name. Dry run by default —
// everything runs inside a transaction that is rolled back, so the row counts it prints are real but nothing changes.
//
//   npx tsx scripts/reset-company-transactions.ts             # dry run: counts only
//   npx tsx scripts/reset-company-transactions.ts --apply     # really delete (asks you to type the company name)
//
// Take a database dump first. A deletion cannot be undone.
import readline from 'node:readline';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';

const COMPANY_ID = 'c53d35d7-cc24-46b2-916a-a501bbd61ba7';
const COMPANY_NAME = 'SharpSurv';

// The roots of the transactional data. Everything that hangs off these through a foreign key (items, journal lines,
// stock-take lines, ...) is removed with them, children first.
const ROOTS = [
  'journal_entries', 'vouchers', 'invoices', 'quotations', 'expenses', 'recurring_postings', 'pos_held_invoices', 'pos_shifts',
  'purchase_returns', 'purchase_bills', 'goods_receipt_notes', 'purchase_orders', 'purchase_requisitions',
  'physical_stock_takes', 'warehouse_dispatches', 'warehouse_receivings', 'stock_ledger_transactions', 'inventory_stocks',
  'tax_returns', 'fiscal_months',
];

// Master data and system tables. If following the foreign keys would ever reach one of these, the script stops
// instead of deleting from it.
const PROTECTED = new Set([
  'companies', 'users', 'user_roles', 'roles', 'user_branches', 'branches', 'warehouses', 'customers', 'vendors', 'bank_accounts',
  'products_services', 'product_categories', 'product_unit_conversions', 'product_warehouses', 'product_modifier_groups',
  'modifier_groups', 'modifier_choices', 'units_of_measure', 'tax_slabs', 'document_templates', 'document_counters', 'job_titles',
  'employees', 'investors', 'recurring_expense_templates', 'system_accounts', 'gl_group_mappings', 'translations',
  'zatca_environment_configs', 'zatca_chain_state', 'audit_logs', 'user_sessions',
]);

const q = (t: string) => `"${t.replace(/"/g, '""')}"`;
const arr = (v: any): string[] => Array.isArray(v) ? v : String(v).replace(/^\{|\}$/g, '').split(',').map(x => x.replace(/^"|"$/g, ''));
const unq = (s: string) => s.replace(/^public\./, '').replace(/^"|"$/g, '');

class Rollback extends Error {}

async function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(prompt, a => { rl.close(); resolve(a.trim()); }));
}

async function run(apply: boolean) {
  const counts = new Map<string, number>();
  const nulled = new Map<string, number>();
  try {
    await db.transaction(async (tx: any) => {
      const [co]: any[] = (await tx.execute(sql`select id, name from companies where id = ${COMPANY_ID}::uuid`)).rows;
      if (!co || co.name !== COMPANY_NAME) throw new Error(`Company ${COMPANY_ID} is not named "${COMPANY_NAME}" (found: ${co?.name ?? 'nothing'}) — refusing.`);

      const fks: any = await tx.execute(sql`select c.conrelid::regclass::text child, c.confrelid::regclass::text parent,
        (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum) ccols,
        (select array_agg(a.attname::text order by k.ord) from unnest(c.confkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.attnum) pcols
        from pg_constraint c where c.contype='f' and c.connamespace='public'::regnamespace`);
      const byParent = new Map<string, { child: string; ccols: string[]; pcols: string[] }[]>();
      for (const f of (fks.rows ?? fks)) {
        const p = unq(f.parent);
        if (!byParent.has(p)) byParent.set(p, []);
        byParent.get(p)!.push({ child: unq(f.child), ccols: arr(f.ccols), pcols: arr(f.pcols) });
      }

      async function purge(table: string, cond: string, path: string[]) {
        if (PROTECTED.has(table)) throw new Error(`Following the foreign keys would delete from the protected master table "${table}" — stopping, nothing was changed.`);
        for (const f of byParent.get(table) ?? []) {
          if (f.child === table) continue;
          const cc = f.ccols.map(q).join(', '), pc = f.pcols.map(q).join(', ');
          const where = `(${cc}) in (select ${pc} from ${q(table)} where ${cond})`;
          if (path.includes(f.child)) {
            const r: any = await tx.execute(sql.raw(`update ${q(f.child)} set ${f.ccols.map(c => `${q(c)} = null`).join(', ')} where ${where}`));
            nulled.set(f.child, (nulled.get(f.child) ?? 0) + (r.rowCount ?? 0));
            continue;
          }
          // A protected table that merely POINTS at a transactional row (a nullable link) is detached, not deleted.
          if (PROTECTED.has(f.child)) {
            const r: any = await tx.execute(sql.raw(`update ${q(f.child)} set ${f.ccols.map(c => `${q(c)} = null`).join(', ')} where ${where}`));
            nulled.set(f.child, (nulled.get(f.child) ?? 0) + (r.rowCount ?? 0));
            continue;
          }
          await purge(f.child, where, [...path, table]);
        }
        const r: any = await tx.execute(sql.raw(`delete from ${q(table)} where ${cond}`));
        counts.set(table, (counts.get(table) ?? 0) + (r.rowCount ?? 0));
      }

      for (const t of ROOTS) {
        const hasCol: any = await tx.execute(sql`select 1 from information_schema.columns where table_schema='public' and table_name=${t} and column_name='company_id'`);
        if (!(hasCol.rows ?? hasCol).length) throw new Error(`Table ${t} has no company_id column — refusing to guess.`);
        await purge(t, `company_id = '${COMPANY_ID}'::uuid`, []);
      }

      // The running statistics on the products are derived from the documents just removed.
      const reset: any = await tx.execute(sql`update products_services set average_cost = 0, average_sale_price = 0,
        total_quantity_purchased = 0, total_quantity_sold = 0 where company_id = ${COMPANY_ID}::uuid`);
      counts.set('products_services (statistics reset, rows kept)', reset.rowCount ?? 0);

      // Likewise an investor's capital_contributed is the running total of the capital receipts (vouchers) just removed. Left in place it
      // would put capital on the Balance Sheet with no cash behind it, so the books would start out of balance.
      const capital: any = await tx.execute(sql`update investors set capital_contributed = 0 where company_id = ${COMPANY_ID}::uuid`);
      counts.set('investors (capital contributed reset to 0, rows kept)', capital.rowCount ?? 0);

      if (!apply) throw new Rollback();
      const typed = await ask(`\nType the company name (${COMPANY_NAME}) to COMMIT this deletion: `);
      if (typed !== COMPANY_NAME) throw new Error('Not confirmed — nothing was deleted.');
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  const rows = [...counts.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  console.log(`\n${apply ? 'DELETED' : 'DRY RUN — would delete'} for ${COMPANY_NAME}:`);
  for (const [t, n] of rows) console.log(`  ${String(n).padStart(7)}  ${t}`);
  if (nulled.size) {
    console.log('Links detached (set to null, rows kept):');
    for (const [t, n] of nulled) if (n > 0) console.log(`  ${String(n).padStart(7)}  ${t}`);
  }
  console.log(apply ? '\nDone. Master data was not touched.' : '\nNothing was changed. Re-run with --apply to delete.');
}

const apply = process.argv.includes('--apply');
if (apply && !process.stdin.isTTY) { console.error('--apply needs an interactive terminal.'); process.exit(1); }
run(apply).then(() => process.exit(0)).catch(e => { console.error('\nERROR:', e.message); process.exit(1); });
