// One-time (re-runnable) conversion of invoices.xml_content (plain text) to invoices.xml_content_z
// (brotli, see server/lib/zatca/xmlStorage.ts). Safe by construction:
//   * dry-run by default — pass --apply to write;
//   * each row is compressed through compressXml(), which decompresses and compares byte-for-byte
//     before returning, so a lossy copy can never be produced;
//   * the UPDATE only fires if the row still holds exactly the text that was compressed
//     (a concurrent re-sign is skipped, not overwritten) and nulls the plain column in the same statement;
//   * idempotent: only rows with xml_content set and xml_content_z empty are touched.
// Usage: npx tsx scripts/backfill-compress-invoice-xml.ts [--apply]
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { compressXml, decompressXml } from '../server/lib/zatca/xmlStorage.js';

const APPLY = process.argv.includes('--apply');
const BATCH = 200;
const rows = (r: any) => r.rows ?? r;

let converted = 0, skipped = 0, plainBytes = 0, packedBytes = 0;
let lastId = '00000000-0000-0000-0000-000000000000';
for (;;) {
  const batch = rows(await db.execute(sql`
    select id, xml_content from invoices
    where xml_content is not null and xml_content_z is null and id > ${lastId}::uuid
    order by id limit ${BATCH}`));
  if (!batch.length) break;
  for (const row of batch) {
    lastId = row.id;
    const packed = compressXml(row.xml_content);            // throws on any round-trip mismatch
    if (decompressXml(packed) !== row.xml_content) throw new Error(`verification failed for invoice ${row.id}`);
    plainBytes += Buffer.byteLength(row.xml_content);
    packedBytes += packed.length;
    if (!APPLY) { converted++; continue; }
    const res: any = await db.execute(sql`
      update invoices set xml_content_z = ${packed}, xml_content = null
      where id = ${row.id}::uuid and xml_content = ${row.xml_content} and xml_content_z is null`);
    if ((res.rowCount ?? 0) === 1) converted++; else skipped++;
  }
}
const pct = plainBytes ? Math.round((1 - packedBytes / plainBytes) * 100) : 0;
console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'}: ${converted} invoice XML(s) ${APPLY ? 'converted' : 'would convert'}, ${skipped} skipped (changed concurrently).`);
console.log(`Raw text ${plainBytes} B -> compressed ${packedBytes} B (${pct}% smaller before Postgres' own TOAST compression).`);
process.exit(0);
