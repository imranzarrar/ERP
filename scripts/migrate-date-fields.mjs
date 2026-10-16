#!/usr/bin/env node
// Date-field standard (docs/design-notes/date-fields-standard.md): renames each document table's `date` to `doc_date` (or `posting_date`) IN PLACE, converts it to a real
// Postgres `date`, adds `posting_date` / `doc_date` back-filled from it, and creates the indexes. Run BEFORE `db:push` (both release scripts do): drizzle-kit
// cannot tell a rename from a drop + add and would delete the column's data, so the rename is done here and drizzle then finds the schema already satisfied.
// Idempotent: a table already migrated is skipped. Every table is migrated in its own transaction.
// Usage: npx tsx scripts/migrate-date-fields.mjs [--dry-run]
import dotenv from 'dotenv';
dotenv.config({ path: 'app.secrets', quiet: true });
import pg from 'pg';

const DRY = process.argv.includes('--dry-run');
const pool = new pg.Pool({ host: process.env.SQL_HOST, user: process.env.SQL_USER, password: process.env.SQL_PASSWORD, database: process.env.SQL_DB_NAME });

// slice 1: the sales documents and the ledger. Later slices add their tables to this list.
//   rename:  [old, new]            the column `old` becomes `new`, type date
//   derive:  [name, fromColumn]    a new NOT NULL date column back-filled from another one
//   index:   [indexName, columns]
//   stamp:   { doc: bool, posting: bool }   a table whose `date` was a TIMESTAMP set by the system: it becomes `created_at` (same value, so ordering within a day
//                                   is kept) and the date part is back-filled into `doc_date` / `posting_date`
const STEPS = [
  { table: 'quotations', rename: ['date', 'doc_date'], index: ['quotations_company_doc_date_idx', 'company_id, doc_date'] },
  { table: 'invoices', rename: ['date', 'doc_date'], derive: ['posting_date', 'doc_date'], index: ['invoices_company_doc_date_idx', 'company_id, doc_date'] },
  { table: 'expenses', rename: ['date', 'doc_date'], derive: ['posting_date', 'doc_date'], index: ['expenses_company_doc_date_idx', 'company_id, doc_date'] },
  { table: 'vouchers', rename: ['date', 'doc_date'], derive: ['posting_date', 'doc_date'], index: ['vouchers_company_doc_date_idx', 'company_id, doc_date'] },
  { table: 'journal_entries', rename: ['date', 'posting_date'], derive: ['doc_date', 'posting_date'], index: ['journal_entries_company_posting_date_idx', 'company_id, posting_date'] },
  { table: 'manual_journals', rename: ['date', 'doc_date'], derive: ['posting_date', 'doc_date'], index: ['manual_journals_company_doc_date_idx', 'company_id, doc_date'] },
  // slice 2 and 3: purchasing, stock and transfers (their old `date` was the entry time, a timestamp)
  { table: 'purchase_requisitions', stamp: { doc: true, posting: false }, index: ['purchase_requisitions_company_doc_date_idx', 'company_id, doc_date'] },
  { table: 'purchase_orders', stamp: { doc: true, posting: false }, index: ['purchase_orders_company_doc_date_idx', 'company_id, doc_date'] },
  { table: 'goods_receipt_notes', stamp: { doc: true, posting: true }, index: ['goods_receipt_notes_company_doc_date_idx', 'company_id, doc_date'] },
  { table: 'purchase_bills', stamp: { doc: true, posting: true }, index: ['purchase_bills_company_doc_date_idx', 'company_id, doc_date'] },
  { table: 'purchase_returns', stamp: { doc: true, posting: true }, index: ['purchase_returns_company_doc_date_idx', 'company_id, doc_date'] },
  { table: 'warehouse_dispatches', stamp: { doc: true, posting: true }, index: ['warehouse_dispatches_company_doc_date_idx', 'company_id, doc_date'] },
  { table: 'warehouse_receivings', stamp: { doc: true, posting: true }, index: ['warehouse_receivings_company_doc_date_idx', 'company_id, doc_date'] },
  { table: 'physical_stock_takes', stamp: { doc: true, posting: true }, index: ['physical_stock_takes_company_doc_date_idx', 'company_id, doc_date'] },
  { table: 'stock_ledger_transactions', stamp: { doc: false, posting: true }, index: ['stock_ledger_transactions_company_posting_date_idx', 'company_id, posting_date'] },
];

// business dates that were timestamps: a calendar day is a `date`, never a moment (docs/design-notes/date-fields-standard.md)
const CONVERTS = [['purchase_bills', 'due_date'], ['purchase_orders', 'delivery_date'], ['warehouse_dispatches', 'expected_arrival_date']];

const q = (id) => `"${id}"`;
async function columns(client, table) {
  const r = await client.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table]);
  return new Map(r.rows.map((x) => [x.column_name, x.data_type]));
}

async function main() {
  let migrated = 0, skipped = 0;
  for (const [table, column] of CONVERTS) {
    const client = await pool.connect();
    try {
      const cols = await columns(client, table);
      if (cols.has(column) && cols.get(column) !== 'date') {
        await client.query('BEGIN');
        await client.query(`ALTER TABLE ${q(table)} ALTER COLUMN ${q(column)} TYPE date USING ${q(column)}::date`);
        await client.query(DRY ? 'ROLLBACK' : 'COMMIT');
        console.log(`  ${DRY ? '(dry) ' : ''}${table}.${column} -> date`); migrated++;
      }
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); console.error(`  ! ${table}.${column}: ${e.message}`); process.exitCode = 1; }
    finally { client.release(); }
  }
  for (const step of STEPS) {
    const client = await pool.connect();
    try {
      const cols = await columns(client, step.table);
      if (cols.size === 0) { console.log(`  - ${step.table}: table does not exist yet, skipped`); skipped++; continue; }
      await client.query('BEGIN');
      const log = [];
      if (step.stamp) {
        if (cols.has('date') && !cols.has('created_at')) {
          await client.query(`ALTER TABLE ${q(step.table)} RENAME COLUMN "date" TO "created_at"`);
          cols.set('created_at', cols.get('date')); cols.delete('date'); log.push('date -> created_at');
        }
        for (const [flag, name] of [[step.stamp.doc, 'doc_date'], [step.stamp.posting, 'posting_date']]) {
          if (!flag || cols.has(name)) continue;
          await client.query(`ALTER TABLE ${q(step.table)} ADD COLUMN ${q(name)} date`);
          await client.query(`UPDATE ${q(step.table)} SET ${q(name)} = created_at::date WHERE ${q(name)} IS NULL`);
          await client.query(`ALTER TABLE ${q(step.table)} ALTER COLUMN ${q(name)} SET NOT NULL`);
          cols.set(name, 'date'); log.push(`+${name}`);
        }
        const [sIdx, sCols] = step.index;
        const haveS = await client.query(`SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [sIdx]);
        if (!haveS.rowCount) { await client.query(`CREATE INDEX ${q(sIdx)} ON ${q(step.table)} (${sCols})`); log.push(`+index ${sIdx}`); }
        await client.query(DRY ? 'ROLLBACK' : 'COMMIT');
        if (log.length) { console.log(`  ${DRY ? '(dry) ' : ''}${step.table}: ${log.join(', ')}`); migrated++; } else { console.log(`  = ${step.table}: already migrated`); skipped++; }
        continue;
      }
      const [oldName, newName] = step.rename;
      if (cols.has(oldName) && !cols.has(newName)) {
        await client.query(`ALTER TABLE ${q(step.table)} RENAME COLUMN ${q(oldName)} TO ${q(newName)}`);
        cols.set(newName, cols.get(oldName)); cols.delete(oldName);
        log.push(`${oldName} -> ${newName}`);
      }
      if (cols.get(newName) && cols.get(newName) !== 'date') {
        await client.query(`ALTER TABLE ${q(step.table)} ALTER COLUMN ${q(newName)} TYPE date USING ${q(newName)}::date`);
        log.push(`${newName} -> date`);
      }
      if (step.derive) {
        const [name, from] = step.derive;
        if (!cols.has(name)) {
          await client.query(`ALTER TABLE ${q(step.table)} ADD COLUMN ${q(name)} date`);
          await client.query(`UPDATE ${q(step.table)} SET ${q(name)} = ${q(from)} WHERE ${q(name)} IS NULL`);
          await client.query(`ALTER TABLE ${q(step.table)} ALTER COLUMN ${q(name)} SET NOT NULL`);
          log.push(`+${name} (from ${from})`);
        }
      }
      const [idx, idxCols] = step.index;
      const have = await client.query(`SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [idx]);
      if (!have.rowCount) { await client.query(`CREATE INDEX ${q(idx)} ON ${q(step.table)} (${idxCols})`); log.push(`+index ${idx}`); }
      await client.query(DRY ? 'ROLLBACK' : 'COMMIT');
      if (log.length) { console.log(`  ${DRY ? '(dry) ' : ''}${step.table}: ${log.join(', ')}`); migrated++; } else { console.log(`  = ${step.table}: already migrated`); skipped++; }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`  ! ${step.table}: ${e.message}`);
      process.exitCode = 1;
    } finally { client.release(); }
  }
  console.log(`${DRY ? 'DRY RUN: ' : ''}date fields: ${migrated} table(s) migrated, ${skipped} already done or absent.`);
  await pool.end();
}
main().catch((e) => { console.error('migrate-date-fields.mjs failed:', e); process.exit(1); });
