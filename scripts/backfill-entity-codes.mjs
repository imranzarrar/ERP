// One-time backfill: assigns customer_code / vendor_code / sku to every existing
// customer/vendor/product row (they predate these columns, so start out NULL), and
// copies the deprecated tax_reg_number into vat_number wherever vat_number is empty (see
// CLAUDE.md-adjacent plan discussion: customers/vendors now use vat_number as the single
// VAT field; tax_reg_number is frozen, unread/unwritten by the app from here on).
//
// Must run exactly once, after `npm run db:push` adds customer_code/vendor_code (sku
// already existed as a manually-typed column). Per company, per entity type, existing
// rows are numbered 1..N in id order (UUIDv7 ids are time-ordered, so this reproduces
// creation order without needing a createdAt column, which none of these three tables
// have) — system placeholder rows (Walk-in Customer/Cash Vendor) are numbered like any
// other row, not excluded, matching whatever slot their creation time actually falls in.
// Each company's document_counters row for that doc type is then advanced to N, so the
// next real create (via getAndIncrementDocumentNumber) continues at N+1 instead of
// colliding with a backfilled code.
import dotenv from 'dotenv';
dotenv.config({ path: 'app.secrets' });
import pg from 'pg';
import { randomUUID } from 'crypto';

const pool = new pg.Pool({
  host: process.env.SQL_HOST,
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  database: process.env.SQL_DB_NAME,
});

const PAD_WIDTH = 5;
const zatcaVatFormat = /^3\d{13}3$/;

async function backfillCodes(client, table, codeColumn, docType) {
  const { rows: companies } = await client.query(`SELECT DISTINCT company_id FROM ${table}`);
  let totalAssigned = 0;
  for (const { company_id: companyId } of companies) {
    const { rows: pending } = await client.query(
      `SELECT id FROM ${table} WHERE company_id = $1 AND ${codeColumn} IS NULL ORDER BY id ASC`,
      [companyId]
    );
    if (pending.length === 0) continue;

    for (let i = 0; i < pending.length; i++) {
      const code = String(i + 1).padStart(PAD_WIDTH, '0');
      await client.query(`UPDATE ${table} SET ${codeColumn} = $1 WHERE id = $2`, [code, pending[i].id]);
    }
    totalAssigned += pending.length;

    // Advance (or create) this company's counter so the next real create continues right
    // after the backfilled range — pre-increment convention, so current_value = N means
    // the next issued value is N+1.
    await client.query(
      `INSERT INTO document_counters (id, company_id, doc_type, period_key, current_value)
       VALUES ($1, $2, $3, 'NONE', $4)
       ON CONFLICT (company_id, doc_type, period_key)
       DO UPDATE SET current_value = GREATEST(document_counters.current_value, EXCLUDED.current_value)`,
      [randomUUID(), companyId, docType, pending.length]
    );
  }
  console.log(`${table}.${codeColumn}: assigned codes to ${totalAssigned} row(s) across ${companies.length} compan(y/ies).`);
}

async function copyVatNumbers(client, table) {
  const { rowCount } = await client.query(
    `UPDATE ${table} SET vat_number = tax_reg_number
     WHERE (vat_number IS NULL OR vat_number = '') AND tax_reg_number IS NOT NULL AND tax_reg_number != ''`
  );
  console.log(`${table}: copied tax_reg_number -> vat_number for ${rowCount} row(s).`);

  // Flag, don't skip — a copied value that doesn't pass the strict ZATCA format only
  // matters for a B2B row (B2C's vat_number is free-form), and only breaks something the
  // next time that customer/vendor is used on an invoice, not right now.
  const { rows: invalid } = await client.query(
    `SELECT id, name, company_id, vat_number FROM ${table}
     WHERE buyer_type = 'B2B' AND vat_number IS NOT NULL AND vat_number !~ '^3[0-9]{13}3$'`
  );
  if (invalid.length > 0) {
    console.warn(`${table}: ${invalid.length} B2B row(s) have a vat_number that fails the strict 15-digit ZATCA format (won't submit to ZATCA until corrected):`);
    for (const row of invalid) {
      console.warn(`  - ${row.id} (${row.name}, company ${row.company_id}): "${row.vat_number}"`);
    }
  }
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await backfillCodes(client, 'customers', 'customer_code', 'customerCode');
    await backfillCodes(client, 'vendors', 'vendor_code', 'vendorCode');
    await backfillCodes(client, 'products_services', 'sku', 'sku');

    await copyVatNumbers(client, 'customers');
    await copyVatNumbers(client, 'vendors');

    await client.query('COMMIT');
    console.log('Backfill complete.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
