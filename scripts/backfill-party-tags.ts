// Gives every ledger line that posts to a customer or vendor control account the customer / vendor of its source document (docs/ar-ap-bank-design.md, decision 1).
// New postings get the tag from the posting engine; this fills in history. Idempotent: a line that already carries a party is never changed. Dry run by default.
// Usage: npx tsx scripts/backfill-party-tags.ts [--apply]
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';

const APPLY = process.argv.includes('--apply');

// the account a line posts to: its own account, or the company's account of its role
const ACCOUNT = sql`JOIN company_accounts a ON a.company_id = l.company_id AND ((l.account_id IS NOT NULL AND a.id = l.account_id) OR (l.account_id IS NULL AND l.account_key IS NOT NULL AND a.system_key = l.account_key))`;

const STEPS: { label: string; col: 'customer_id' | 'vendor_id'; type: 'customer' | 'vendor'; refs: string[]; from: string; party: string; join: string }[] = [
  { label: 'invoices and credit notes', col: 'customer_id', type: 'customer', refs: ['Invoice', 'CreditNote'], from: 'invoices d', party: 'd.customer_id', join: 'd.id = e.reference_id' },
  { label: 'expenses', col: 'vendor_id', type: 'vendor', refs: ['Expense'], from: 'expenses d', party: 'd.vendor_id', join: 'd.id = e.reference_id' },
  { label: 'purchase bills', col: 'vendor_id', type: 'vendor', refs: ['PurchaseBill'], from: 'purchase_bills d', party: 'd.vendor_id', join: 'd.id = e.reference_id' },
  { label: 'goods receipts', col: 'vendor_id', type: 'vendor', refs: ['Grn'], from: 'goods_receipt_notes d', party: 'd.vendor_id', join: 'd.id = e.reference_id' },
  { label: 'purchase returns', col: 'vendor_id', type: 'vendor', refs: ['PurchaseReturn'], from: 'purchase_returns d', party: 'd.vendor_id', join: 'd.id = e.reference_id' },
  { label: 'vendor refunds', col: 'vendor_id', type: 'vendor', refs: ['VendorRefund'], from: 'vouchers d', party: 'd.reference_id', join: 'd.id = e.reference_id' },
];

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}: party tags of ledger lines`);
await db.transaction(async (tx: any) => {
  for (const s of STEPS) {
    const refs = sql.join(s.refs.map(r => sql`${r}`), sql`, `);
    const q = sql`
      UPDATE journal_lines l SET ${sql.raw(s.col)} = ${sql.raw(s.party)}
      FROM journal_entries e, ${sql.raw(s.from)}, company_accounts a
      WHERE e.id = l.journal_entry_id AND e.company_id = l.company_id AND e.reference_type IN (${refs}) AND ${sql.raw(s.join)} AND d.company_id = l.company_id
        AND a.company_id = l.company_id AND ((l.account_id IS NOT NULL AND a.id = l.account_id) OR (l.account_id IS NULL AND l.account_key IS NOT NULL AND a.system_key = l.account_key))
        AND a.subledger_type = ${s.type} AND l.${sql.raw(s.col)} IS NULL AND ${sql.raw(s.party)} IS NOT NULL`;
    const r: any = await tx.execute(q);
    console.log(`  ${s.label.padEnd(28)} ${String(r.rowCount ?? 0).padStart(6)} line(s) tagged`);
  }
  void ACCOUNT;
  const left: any = await tx.execute(sql`
    SELECT COUNT(*)::int AS n FROM journal_lines l JOIN company_accounts a ON a.company_id = l.company_id AND ((l.account_id IS NOT NULL AND a.id = l.account_id) OR (l.account_id IS NULL AND l.account_key IS NOT NULL AND a.system_key = l.account_key))
    WHERE (a.subledger_type = 'customer' AND l.customer_id IS NULL) OR (a.subledger_type = 'vendor' AND l.vendor_id IS NULL)`);
  console.log(`  receivable / payable lines still without a party: ${left.rows[0].n}`);
  if (!APPLY) throw Object.assign(new Error('dry-run rollback'), { dryRun: true });
}).catch((e: any) => { if (!e.dryRun) throw e; });
console.log('Done.');
process.exit(0);
