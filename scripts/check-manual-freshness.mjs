// Flags user-manual chapters whose screens or routes changed since the chapter was last reviewed.
//   node scripts/check-manual-freshness.mjs            list stale chapters; exit 1 if any (part of the documentation gate)
//   node scripts/check-manual-freshness.mjs --accept   record the current screens as reviewed (do this ONLY after reading the chapter against the running screen)
// The chapter -> screens map is scripts/lib/moduleMap.mjs (manual anchors per module). The baseline is docs/user-manual/source/reviewed-screens.json.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MODULES } from './lib/moduleMap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = path.join(ROOT, 'docs/user-manual/source/reviewed-screens.json');
const hashFile = f => crypto.createHash('sha1').update(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')).digest('hex').slice(0, 12);
function filesOf(screen) {
  const p = path.join(ROOT, 'src/components', screen);
  if (screen.endsWith('/')) return fs.readdirSync(p).filter(f => /\.(tsx|ts)$/.test(f)).map(f => path.join(p, f));
  return fs.existsSync(p) ? [p] : [];
}
// anchor -> { relative file -> hash }
const current = {};
for (const m of MODULES) {
  const files = [path.join(ROOT, 'server/routes', m.file + '.ts'), ...m.screens.flatMap(filesOf)];
  for (const a of m.manual) { const o = (current[a] ||= {}); for (const f of files) if (fs.existsSync(f)) o[path.relative(ROOT, f).split(path.sep).join('/')] = hashFile(f); }
}
if (process.argv.includes('--accept')) {
  fs.writeFileSync(BASE, JSON.stringify(current, null, 1) + '\n');
  console.log(`Recorded ${Object.keys(current).length} chapters as reviewed against the current screens.`); process.exit(0);
}
if (!fs.existsSync(BASE)) { console.log('No baseline yet: review the chapters, then run with --accept.'); process.exit(1); }
const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
const stale = [];
for (const [anchor, files] of Object.entries(current)) {
  const was = base[anchor] || {}; const changed = Object.keys(files).filter(f => was[f] !== files[f]);
  const gone = Object.keys(was).filter(f => !(f in files));
  if (changed.length || gone.length) stale.push([anchor, [...changed.map(f => (f in was ? 'changed ' : 'new ') + f), ...gone.map(f => 'removed ' + f)]]);
}
if (stale.length) {
  console.log(`${stale.length} manual chapter(s) have screens or routes that changed since they were reviewed:`);
  for (const [a, list] of stale) console.log(`  #${a}\n${list.map(x => '      ' + x).join('\n')}`);
  console.log('\nRead each chapter against the running screen, fix the manual (docs/user-manual/source/part-a-everyday-operations.html or docs/gl-ap-ar/06-user-manual.md), re-capture screens if needed, then run:  node scripts/check-manual-freshness.mjs --accept');
  process.exit(1);
}
console.log(`OK: ${Object.keys(current).length} manual chapters match the screens they were reviewed against.`);
