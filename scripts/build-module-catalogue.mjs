// Generates docs/platform/annex-h-module-catalogue.md: one sheet per module of the whole system (older 1.0 modules and the 2.0 finance core),
// built from the code: endpoints and permissions (server/routes), tables touched (schema.ts), screens (src/components), tests (tests/).
// The "what it is" sentence and the manual link are written below, by hand, and checked: a route file with no entry here fails the build.
//   node scripts/build-module-catalogue.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

// file (server/routes/<file>.ts) -> sheet
import { MODULES, MAN } from './lib/moduleMap.mjs';

const server = read('server.ts');
const imports = new Map(); for (const m of server.matchAll(/import \{?\s*(?:default as )?(\w+)\s*\}? from '\.\/server\/routes\/(\w+)(?:\.js)?'/g)) imports.set(m[2], m[1]);
const mounts = new Map(); for (const m of server.matchAll(/app\.use\('([^']+)'(?:, \w+)*, (\w+)\)/g)) for (const [f, v] of imports) if (v === m[2]) mounts.set(f, m[1]);
const schema = read('src/db/schema.ts'); const tableName = new Map(); for (const m of schema.matchAll(/export const (\w+) = pgTable\('([^']+)'/g)) tableName.set(m[1], m[2]);
const tests = fs.readdirSync(path.join(ROOT, 'tests')).filter(f => f.endsWith('.test.ts')).map(f => [f, read('tests/' + f)]);
const routeFiles = fs.readdirSync(path.join(ROOT, 'server/routes')).filter(f => f.endsWith('.ts')).map(f => f.replace(/\.ts$/, ''));
const missing = routeFiles.filter(f => !MODULES.some(m => m.file === f)); const gone = MODULES.filter(m => !routeFiles.includes(m.file)).map(m => m.file);
if (missing.length || gone.length) { console.error('Module catalogue out of date. Route files without a sheet:', missing.join(', ') || '-', '| sheets without a route file:', gone.join(', ') || '-'); process.exit(1); }
const comps = fs.readdirSync(path.join(ROOT, 'src/components')); const missingComp = [];

let out = `# Annex H: Module catalogue (every module, older and new)\n\nGenerated ${new Date().toISOString().slice(0, 10)} by \`node scripts/build-module-catalogue.mjs\` from the code: endpoints and permissions from \`server/routes\`, tables from \`src/db/schema.ts\`, tests from \`tests/\`. The one-line description of each module and the manual link are written in that script. This is the index of **what the system contains**; the rules that apply to all of it are in the Platform architecture chapter, and the finance core is specified in the requirements and design chapters.\n\n`;
out += `| Module | Mount | Endpoints | Tables touched | Tests |\n|---|---|---|---|---|\n`;
const sheets = [];
for (const m of MODULES) {
  const src = read(`server/routes/${m.file}.ts`); const lines = src.split('\n'); const mount = mounts.get(m.file) || '/api';
  const rows = [];
  const routeIdx = []; lines.forEach((l, i) => { if (/router\.(get|post|put|patch|delete)\(\s*'/.test(l)) routeIdx.push(i); });
  // gates declared once for the whole file: router.use(requirePermission(...)) or an admin-only gate
  const fileGate = [...src.matchAll(/router\.use\([^\n]*?requirePermission\('([\w.]+)'\)/g)].map(y => y[1]);
  const fileAdmin = /router\.use\([^\n]*(isAdminUser|isSuperAdminUser|isCompanyAdmin|requireAdmin)/.test(src);
  routeIdx.forEach((i, k) => { const x = lines[i].match(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/); const end = routeIdx[k + 1] ?? lines.length; const body = lines.slice(i, end).join(' ');
    const perms = new Set([...fileGate, ...[...body.matchAll(/hasPermission\(req\.user, [`']([\w.${}]+)[`']/g)].map(y => y[1]), ...[...body.matchAll(/requirePermission\('([\w.]+)'\)/g)].map(y => y[1]), ...[...body.matchAll(/guarded\('(\w+)'/g)].map(y => y[1]), ...[...body.matchAll(/\bpermissions?\.([a-zA-Z]+)\.([a-zA-Z]+)(?:\.enabled)?/g)].filter(y => !['user', 'role', 'length', 'permissions'].includes(y[1])).map(y => `${y[1]}.${y[2]}`)]);
    if (fileAdmin || /isSuperAdminUser(req.user)|isAdminUser(req.user)|isCompanyAdmin(req.user)/.test(body)) perms.add('administrator check');
    if (!perms.size && /\b(canSee|can|canRead|canWrite|allowed|need)\(req\b/.test(body)) perms.add('checked by a helper in the handler');
    if (!perms.size && /router\.use\(\s*(async\s*)?\(/.test(src)) perms.add('file-level gate (router.use)');
    rows.push([x[1].toUpperCase(), (mount === '/api' ? '/api' : mount) + (x[2] === '/' ? '' : x[2]), [...perms].join(', ')]); });
  const tables = [...new Set([...src.matchAll(/schema\.(\w+)/g)].map(y => tableName.get(y[1])).filter(Boolean))].sort();
  const prefixes = [...new Set(rows.map(r => r[1].split('/:')[0].replace(/\/$/, '')))];
  let hit = tests.filter(([, t]) => prefixes.some(p => p.length > 8 && t.includes(p))).map(([f]) => f.replace('.test.ts', '')).sort();
  if (!hit.length && mount !== '/api') hit = tests.filter(([f, t]) => t.includes(mount) || f.toLowerCase().includes(m.file.toLowerCase())).map(([f]) => f.replace('.test.ts', '')).sort();
  const screens = m.screens.map(s => { const f = s.replace(/\/$/, ''); if (!comps.includes(f) && !comps.includes(f.split('/')[0])) missingComp.push(s); return `\`${s}\``; }).join(', ');
  const id = `module-${m.file}`;
  sheets.push({ id, text: `## ${m.title}\n\n<a id="${id}"></a>${m.is}\n\n* **Route file:** \`server/routes/${m.file}.ts\`, mounted at \`${mount}\`${m.finance ? ' (finance core: also in the API reference and permissions annexes)' : ''}\n* **Screens:** ${screens || 'none'}\n* **User manual:** ${m.manual.length ? m.manual.map(a => `[${a}](${MAN}#${a})`).join(', ') : 'not covered'}\n* **Tables touched directly:** ${tables.length ? tables.map(t => `\`${t}\``).join(', ') : 'none'}\n* **Tests that call it:** ${hit.length ? hit.map(t => `\`${t}\``).join(', ') : 'none by path (covered through related tests or by lib code)'}\n\n${rows.length ? `| Method | Path | Permission |\n|---|---|---|\n${rows.map(r => `| ${r[0]} | \`${r[1]}\` | ${r[2] ? `\`${r[2]}\`` : 'not detected: signed-in user, or checked inside the handler (see route file)'} |`).join('\n')}` : 'Endpoints are declared in a non-standard way; see the route file.'}\n` });
  out += `| [${m.title}](#${id}) | \`${mount}\` | ${rows.length} | ${tables.length} | ${hit.length} |\n`;
}
out += '\n' + sheets.map(s => s.text).join('\n');
fs.mkdirSync(path.join(ROOT, 'docs/platform'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs/platform/annex-h-module-catalogue.md'), out);
if (missingComp.length) console.log('Note: screens not found in src/components:', [...new Set(missingComp)].join(', '));
console.log(`Written: docs/platform/annex-h-module-catalogue.md (${MODULES.length} modules)`);
