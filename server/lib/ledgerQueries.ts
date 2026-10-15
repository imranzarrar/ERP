// Read side of the General Ledger: one definition of "which company account does a journal line belong to", and the balance / listing queries built
// on it. Every figure here is computed in Postgres for the one company in the request (never from a client value) and has no row cap.
import { sql } from 'drizzle-orm';
import type { DimFilter } from './dimensions.js';

// A line belongs to the account it was stamped with when it was posted (journal_lines.account_id). Lines that were never stamped (a company with
// no chart at the time) fall back to the CURRENT account of their posting role, or of their bank.
// drizzle spreads a JS array into a placeholder list, so build the Postgres array explicitly.
export function uuidArray(ids: string[]) {
  return ids.length ? sql`ARRAY[${sql.join(ids.map(i => sql`${i}::uuid`), sql`, `)}]` : sql`ARRAY[]::uuid[]`;
}
export function textArray(vals: string[]) {
  return vals.length ? sql`ARRAY[${sql.join(vals.map(v => sql`${v}::text`), sql`, `)}]` : sql`ARRAY[]::text[]`;
}

// A dimension filter on lines: a line matches a filter when its combination carries one of the chosen entities of that type. Branch also matches through the
// entry's own branch when the line has no Branch tag of its own (the entry branch stays the single source for document branches).
export function dimFilterSql(f: DimFilter, line: string = 'l', branchExpr: string = 'e.branch_id') {
  const ids = uuidArray(f.entityIds);
  const tag = sql`(SELECT ce.entity_id FROM dimension_combination_entries ce WHERE ce.combination_id = ${sql.raw(line)}.dimension_combination_id AND ce.company_id = ${sql.raw(line)}.company_id AND ce.dimension_type_id = ${f.typeId}::uuid)`;
  return f.isBranch ? sql` AND COALESCE(${tag}, ${sql.raw(branchExpr)}) = ANY(${ids})` : sql` AND ${tag} = ANY(${ids})`;
}

export function resolvedLines(companyId: string, opts: { from?: string; to?: string; branchIds?: string[] | null; excludeRef?: string[]; dims?: DimFilter[] } = {}) {
  const from = opts.from ? sql` AND e.posting_date >= ${opts.from}` : sql``;
  const to = opts.to ? sql` AND e.posting_date <= ${opts.to}` : sql``;
  const branch = Array.isArray(opts.branchIds) ? sql` AND e.branch_id = ANY(${uuidArray(opts.branchIds)})` : sql``;
  const excl = opts.excludeRef && opts.excludeRef.length ? sql` AND e.reference_type <> ALL(${textArray(opts.excludeRef)})` : sql``;
  const dims = (opts.dims || []).reduce((acc, f) => sql`${acc}${dimFilterSql(f)}`, sql``);
  return sql`(
    SELECT l.id AS line_id, l.journal_entry_id, e.posting_date, e.branch_id, e.reference_type, e.reference_id, e.created_at,
           COALESCE(ax.id, ab.id, ak.id) AS account_id, l.debit::numeric AS debit, l.credit::numeric AS credit, l.account_key, l.bank_id, l.dimension_combination_id, l.customer_id, l.vendor_id
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.journal_entry_id AND e.company_id = l.company_id
    LEFT JOIN company_accounts ax ON ax.id = l.account_id AND ax.company_id = l.company_id
    LEFT JOIN company_accounts ab ON l.account_id IS NULL AND l.account_key = 'BANK' AND l.bank_id IS NOT NULL AND ab.company_id = l.company_id AND ab.bank_id = l.bank_id
    LEFT JOIN company_accounts ak ON l.account_id IS NULL AND l.account_key IS NOT NULL AND ak.company_id = l.company_id AND ak.system_key = l.account_key
    WHERE l.company_id = ${companyId}::uuid${from}${to}${branch}${excl}${dims}
  ) rl`;
}

export interface AccountTotals { debit: number; credit: number; lines: number }

// Debit / credit totals per account (account_id null = lines no account could be found for).
export async function accountTotals(tx: any, companyId: string, opts: Parameters<typeof resolvedLines>[1] = {}): Promise<Map<string | null, AccountTotals>> {
  const res: any = await tx.execute(sql`SELECT rl.account_id, COALESCE(SUM(rl.debit),0)::float8 AS debit, COALESCE(SUM(rl.credit),0)::float8 AS credit, COUNT(*)::int AS lines FROM ${resolvedLines(companyId, opts)} GROUP BY rl.account_id`);
  const out = new Map<string | null, AccountTotals>();
  for (const r of res.rows) out.set(r.account_id, { debit: Number(r.debit), credit: Number(r.credit), lines: Number(r.lines) });
  return out;
}

// What a role-based branch restriction means for ledger reads: an unrestricted caller sees every entry; a restricted one only entries of its own
// branches (an entry with no branch is invisible to them, the same rule the documents follow).
export function branchIdsFor(req: any): string[] | null {
  return Array.isArray(req.allowedBranchIds) ? req.allowedBranchIds : null;
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
