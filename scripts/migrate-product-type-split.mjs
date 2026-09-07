// One-time backfill for the productsServices.type column split (see the plan this session
// implemented: itemKind + salesPurchaseFlow replace the old overloaded `type` column).
// Must run exactly once, immediately after `npm run db:push` adds the two new columns and
// before any new product is created — the column-level DEFAULT 'item' on itemKind applies
// to every existing row too, which this script deliberately corrects to the conservative
// 'service' default for pre-existing data (see the plan's reasoning: defaulting existing,
// never-reviewed products to 'item' would suddenly make stock deduction/availability
// checks start firing for products nobody set up with accurate on-hand quantities).
import dotenv from 'dotenv';
dotenv.config({ path: 'app.secrets' });
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.SQL_HOST,
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  database: process.env.SQL_DB_NAME,
});

async function main() {
  // 1. itemKind: every row that exists right now predates real classification -> 'service'
  // (safe no-op default; a user reclassifies their real stock items to 'item' afterward).
  const itemKindResult = await pool.query(`UPDATE products_services SET item_kind = 'service'`);
  console.log(`itemKind: backfilled ${itemKindResult.rowCount} rows to 'service'.`);

  // 2. salesPurchaseFlow: derive from the old `type` text column. 'Sales' -> 1, 'Purchase'
  // -> 2, anything else (the stray 'item' row, any blank/unexpected value) -> 0 (Both).
  const salesResult = await pool.query(`UPDATE products_services SET sales_purchase_flow = 1 WHERE type = 'Sales'`);
  const purchaseResult = await pool.query(`UPDATE products_services SET sales_purchase_flow = 2 WHERE type = 'Purchase'`);
  const bothResult = await pool.query(`UPDATE products_services SET sales_purchase_flow = 0 WHERE type IS NULL OR type NOT IN ('Sales', 'Purchase')`);
  console.log(`salesPurchaseFlow: ${salesResult.rowCount} -> Sales(1), ${purchaseResult.rowCount} -> Purchase(2), ${bothResult.rowCount} -> Both(0).`);

  // Verification counts, printed for a manual sanity check against the plan's expectations.
  const counts = await pool.query(`
    SELECT item_kind, sales_purchase_flow, COUNT(*) FROM products_services
    GROUP BY item_kind, sales_purchase_flow ORDER BY item_kind, sales_purchase_flow
  `);
  console.log('Post-migration distribution:', JSON.stringify(counts.rows, null, 2));

  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
