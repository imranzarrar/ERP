// Seeds the fixed, global chart of accounts (system_accounts) that every ledger posting
// (server/lib/ledger.ts -> journal_lines.account_key FK) depends on. It is reference data, not
// tenant data, and nothing else in the app creates it — a fresh database (e.g. production after its first
// db:push of the ledger tables) has an empty table, so every invoice/expense/GRN posting would fail
// until this has run. Idempotent: safe to re-run; it only inserts missing keys and corrects drift.
// Usage: npx tsx scripts/seed-system-accounts.ts [--apply]    (dry run by default)
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';

const ACCOUNTS: { key: string; code: string; name: string; type: string; normalBalance: string }[] = [
  { key: 'BANK', code: '1000', name: 'Bank', type: 'Asset', normalBalance: 'Debit' },
  { key: 'AR', code: '1100', name: 'Accounts Receivable', type: 'Asset', normalBalance: 'Debit' },
  { key: 'INVENTORY', code: '1200', name: 'Inventory', type: 'Asset', normalBalance: 'Debit' },
  { key: 'GR_IR_CLEARING', code: '1250', name: 'GR/IR Clearing', type: 'Liability', normalBalance: 'Credit' },
  { key: 'VAT_INPUT', code: '1300', name: 'VAT Input (Recoverable)', type: 'Asset', normalBalance: 'Debit' },
  { key: 'VENDOR_CREDIT_RECEIVABLE', code: '1350', name: 'Vendor Credit Receivable', type: 'Asset', normalBalance: 'Debit' },
  { key: 'FIXED_ASSETS', code: '1400', name: 'Fixed Assets', type: 'Asset', normalBalance: 'Debit' },
  { key: 'AP', code: '2000', name: 'Accounts Payable', type: 'Liability', normalBalance: 'Credit' },
  { key: 'VAT_OUTPUT', code: '2100', name: 'VAT Output (Payable)', type: 'Liability', normalBalance: 'Credit' },
  { key: 'VAT_PAYABLE_TO_AUTHORITY', code: '2150', name: 'VAT Payable to Authority', type: 'Liability', normalBalance: 'Credit' },
  { key: 'PAID_IN_CAPITAL', code: '3000', name: "Owner's Equity / Paid-in Capital", type: 'Equity', normalBalance: 'Credit' },
  { key: 'RETAINED_EARNINGS', code: '3100', name: 'Retained Earnings', type: 'Equity', normalBalance: 'Credit' },
  { key: 'SALES_REVENUE', code: '4000', name: 'Sales Revenue', type: 'Revenue', normalBalance: 'Credit' },
  { key: 'COGS', code: '5000', name: 'Cost of Goods Sold', type: 'Expense', normalBalance: 'Debit' },
  { key: 'DIRECT_OPEX', code: '5100', name: 'Direct Operating Expenses', type: 'Expense', normalBalance: 'Debit' },
  { key: 'ROUNDING_ADJUSTMENT', code: '5900', name: 'Rounding Adjustment', type: 'Expense', normalBalance: 'Debit' },
];

const APPLY = process.argv.includes('--apply');
const existing = new Map((await db.select().from(schema.systemAccounts)).map(a => [a.key, a]));
let inserted = 0, corrected = 0, unchanged = 0;
for (const a of ACCOUNTS) {
  const cur = existing.get(a.key);
  if (!cur) { inserted++; if (APPLY) await db.insert(schema.systemAccounts).values(a); }
  else if (cur.code !== a.code || cur.name !== a.name || cur.type !== a.type || cur.normalBalance !== a.normalBalance) {
    corrected++; if (APPLY) await db.update(schema.systemAccounts).set(a).where(eq(schema.systemAccounts.key, a.key));
  } else unchanged++;
}
const extra = [...existing.keys()].filter(k => !ACCOUNTS.some(a => a.key === k));
console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'}: ${inserted} to insert, ${corrected} to correct, ${unchanged} already correct.${extra.length ? ' Unknown extra keys left untouched: ' + extra.join(', ') : ''}`);
process.exit(0);
