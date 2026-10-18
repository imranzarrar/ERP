// Walk-through of the older manual chapters against the application: every field label, button, column header and menu item that the
// hand-built manual shows in its mock-up panels must exist somewhere in the application's source text. Anything that does not is likely
// stale (renamed or removed) or mistyped. Read-only; prints the unmatched labels per chapter.
//   node scripts/audit-manual-labels.mjs [--all]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'docs/user-manual/source/part-a-everyday-operations.html'), 'utf8').replace(/\r\n/g, '\n');
const norm = s => s.replace(/&amp;/g, '&').replace(/&[a-z#0-9]+;/g, ' ').replace(/<[^>]+>/g, ' ').replace(/[*:]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
// the application's text: every source file under src/ plus the seed translations
let corpus = '';
const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.(tsx?|json)$/.test(f.name)) corpus += '\n' + fs.readFileSync(p, 'utf8'); } };
walk(path.join(ROOT, 'src')); walk(path.join(ROOT, 'server'));
corpus = norm(corpus.replace(/\\'/g, "'"));
const has = label => { if (corpus.includes(label)) return true; const base = label.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim(); return base.length > 2 && corpus.includes(base); };

const sections = [...html.matchAll(/<section id="([^"]+)"[\s\S]*?\n      <\/section>/g)];
let total = 0, missing = 0; const out = [];
for (const [block, id] of sections) {
  const labels = new Set();
  // mock-up panels only: field labels, headings, buttons, table headers, side items
  for (const panel of block.matchAll(/<div class="app-shell">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g)) {
    for (const m of panel[0].matchAll(/<(label|th|button|h5|span class="chip"|div class="item[^"]*")[^>]*>([^<]{2,60})</g)) labels.add(norm(m[2]));
  }
  for (const m of block.matchAll(/<div class="mock-field"[^>]*><label>([^<]+)<\/label>/g)) labels.add(norm(m[1]));
  if (process.argv.includes('--prose')) for (const m of block.matchAll(/<b>([^<]{3,40})<\/b>/g)) labels.add(norm(m[1]));
  const bad = [...labels].filter(l => l && l.length > 2 && !/^[\d\s.,/%-]+$/.test(l) && !has(l));
  total += labels.size; missing += bad.length;
  if (bad.length || process.argv.includes('--all')) out.push(`  #${id}: ${labels.size} labels, ${bad.length} not found in the application${bad.length ? '\n      - ' + bad.join('\n      - ') : ''}`);
}
console.log(`Checked ${total} labels in ${sections.length} chapters against src/: ${missing} not found.\n${out.join('\n')}`);
