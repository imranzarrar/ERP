import { sql } from 'drizzle-orm';
import { db } from '../../src/db/index.js';

// Deletes one company and EVERYTHING that hangs off it, by following the database's real foreign keys
// (children first), so a test's teardown cannot be broken again by the next table that gains a foreign key
// to users/banks/branches (it already broke 40+ teardowns when the ledger tables arrived). Circular
// references (e.g. branches <-> warehouses) are detached by nulling the referencing columns first.
// Test fixtures only — never call this with a real company id.
const q = (t: string) => `"${t.replace(/"/g, '""')}"`;
const arr = (v: any): string[] => Array.isArray(v) ? v : String(v).replace(/^\{|\}$/g, '').split(',').map(x => x.replace(/^"|"$/g, ''));
const unq = (s: string) => s.replace(/^public\./, '').replace(/^"|"$/g, '');

export async function purgeCompany(companyId: string): Promise<void> {
  await db.transaction(async (tx: any) => {
    const res: any = await tx.execute(sql`select c.conrelid::regclass::text child, c.confrelid::regclass::text parent,
      (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum) ccols,
      (select array_agg(a.attname::text order by k.ord) from unnest(c.confkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.attnum) pcols
      from pg_constraint c where c.contype='f' and c.connamespace='public'::regnamespace`);
    const byParent = new Map<string, { child: string; ccols: string[]; pcols: string[] }[]>();
    for (const f of (res.rows ?? res)) {
      const p = unq(f.parent);
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p)!.push({ child: unq(f.child), ccols: arr(f.ccols), pcols: arr(f.pcols) });
    }
    async function purge(table: string, cond: string, path: string[]) {
      for (const f of byParent.get(table) ?? []) {
        if (f.child === table) continue;
        const cc = f.ccols.map(q).join(', '), pc = f.pcols.map(q).join(', ');
        const where = `(${cc}) in (select ${pc} from ${q(table)} where ${cond})`;
        if (path.includes(f.child)) {
          await tx.execute(sql.raw(`update ${q(f.child)} set ${f.ccols.map(c => `${q(c)} = null`).join(', ')} where ${where}`));
          continue;
        }
        await purge(f.child, where, [...path, table]);
      }
      await tx.execute(sql.raw(`delete from ${q(table)} where ${cond}`));
    }
    await purge('companies', `id = '${companyId}'::uuid`, []);
  });
}
