// Builds the two reading copies of the documentation from their sources, and checks every link in them.
//   docs/technical/index.html (+ data-dictionary, traceability, test-catalogue pages) — the technical documentation
//   docs/user-manual/warraq-erp-user-manual.html — the user manual (everyday operations from source/part-a-... + finance core from gl-ap-ar/06)
//   docs/index.html — where to start
// Run after build-gl-docs.mjs:  node scripts/build-docs-html.mjs   (exit 1 if any link, image or anchor is broken)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { Marked } from 'marked';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const D = (...p) => path.join(ROOT, 'docs', ...p);
const read = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = s => String(s).toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^\p{L}\p{N}]+/g, '-').replace(/^-|-$/g, '');
const problems = [];
const today = new Date().toISOString().slice(0, 10);
const REV = (() => { try { const h = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(); const b = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(); return `${today}, branch ${b}, after commit ${h}`; } catch { return today; } })();

// ---------------------------------------------------------------- markdown -> html
// ctx: { id (chapter id), src (repo-relative source), outDir (absolute dir of the output page), linkmap, shift (heading shift), imgBase }
function render(md, ctx) {
  const used = new Set();
  const renderer = {
    heading(text, level, raw) {
      const lv = Math.min(6, level + ctx.shift);
      let id = `${ctx.id}--${slug(raw) || 'section'}`, n = 2;
      while (used.has(id)) id = `${ctx.id}--${slug(raw)}-${n++}`;
      used.add(id);
      return `<h${lv} id="${id}">${text}</h${lv}>\n`;
    },
    table(header, body) { return `<div class="table-wrap"><table class="plan"><thead>${header}</thead><tbody>${body}</tbody></table></div>\n`; },
    code(code, lang) {
      if (lang === 'mermaid') { ctx.mermaid = true; return `<pre class="mermaid">${esc(code)}</pre>\n`; }
      return `<pre class="code"><code>${esc(code)}</code></pre>\n`;
    },
    blockquote(q) { return `<div class="callout"><div class="label">Note</div>${q}</div>\n`; },
    link(href, title, text) {
      const h = fixHref(href, ctx);
      if (h === null) { problems.push(`${ctx.src}: link to "${href}" has no target, shown as plain text`); return text; }
      const ext = /^https?:/.test(h);
      return `<a href="${esc(h)}"${ext ? ' target="_blank" rel="noopener"' : ''}>${text}</a>`;
    },
    image(href, title, text) {
      const h = ctx.imgBase ? ctx.imgBase(href) : href;
      return `<figure class="shot"><img src="${esc(h)}" alt="${esc(text)}" loading="lazy"><figcaption>${esc(text)}</figcaption></figure>`;
    },
  };
  const m = new Marked({ renderer, gfm: true, breaks: false });
  return m.parse(md);
}
function fixHref(href, ctx) {
  if (/^(https?:|mailto:)/.test(href)) return href;
  if (href.startsWith('#module-')) return href;
  if (href.startsWith('#')) return `#${ctx.id}--${href.slice(1)}`;
  const [file, frag] = href.split('#');
  const key = path.posix.normalize(path.posix.join(path.posix.dirname(ctx.src), file));
  if (ctx.linkmap[key]) return ctx.linkmap[key] + (frag ? `#${frag}` : '');
  const abs = path.join(ROOT, key);
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return path.relative(ctx.outDir, abs).split(path.sep).join('/') + (frag ? `#${frag}` : '');
  return null;
}
const title1 = md => (md.match(/^# (.+)$/m) || [, 'Untitled'])[1].trim();
const stripH1 = md => md.replace(/^# .+\n/, '');

// ---------------------------------------------------------------- shared look
const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">`;
const CSS = `
:root{--primary:#4f46e5;--primary-dark:#1e1b4b;--primary-soft:#f5f3ff;--primary-line:#ddd6fe;--ink:#1a1c23;--ink-soft:#565b6b;--paper:#f6f5fb;--raised:#fff;--line:#e2e1ee;--good:#059669;--warn:#d97706;--font-display:"Space Grotesk","Segoe UI",system-ui,sans-serif;--font-body:"Inter","Segoe UI",system-ui,sans-serif;--font-mono:"JetBrains Mono",Consolas,ui-monospace,monospace}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.62 var(--font-body)}
a{color:var(--primary)}h1,h2,h3,h4{font-family:var(--font-display);color:var(--primary-dark);letter-spacing:-.01em;text-wrap:balance}
code{font-family:var(--font-mono);font-size:.85em;background:var(--primary-soft);border:1px solid var(--primary-line);padding:.05em .4em;border-radius:4px;color:#312e81}
.layout{display:grid;grid-template-columns:290px minmax(0,1fr);max-width:1500px;margin:0 auto}
.rail{position:sticky;top:0;align-self:start;height:100vh;overflow:auto;padding:1.2rem 1rem 2rem;border-right:1px solid var(--line);background:var(--raised);font-size:.84rem}
.rail .mark{font:700 1rem var(--font-display);color:var(--primary-dark);margin-bottom:.2rem}.rail .sub{color:var(--ink-soft);font-size:.74rem;margin-bottom:1rem}
.rail .grp{font:700 .66rem var(--font-display);letter-spacing:.08em;text-transform:uppercase;color:var(--primary);margin:1.1rem 0 .3rem}
.rail a{display:block;padding:.28rem .55rem;border-radius:7px;color:var(--ink);text-decoration:none}.rail a:hover{background:var(--primary-soft)}.rail a.active{background:var(--primary);color:#fff}
.rail a.home{font-weight:600}
main{padding:2rem 2.4rem 4rem;min-width:0}
.chapter{max-width:1040px;margin:0 0 3.5rem;scroll-margin-top:1rem}
.chapter>h2{font-size:1.7rem;margin:0 0 .3rem;padding-top:1.6rem;position:relative}.chapter>h2::before{content:"";position:absolute;top:0;left:0;width:46px;height:4px;border-radius:4px;background:linear-gradient(90deg,#4f46e5,#818cf8)}
.eyebrow{font:600 .72rem var(--font-mono);color:var(--primary);margin:0 0 .4rem}.src{font-size:.74rem;color:var(--ink-soft);margin:0 0 1.2rem}
.chapter h3{font-size:1.2rem;margin:2rem 0 .6rem}.chapter h4{font-size:1rem;margin:1.4rem 0 .5rem;color:#312e81}.chapter h5,.chapter h6{font-size:.92rem;margin:1.1rem 0 .4rem}
.table-wrap{overflow-x:auto;margin:1rem 0 1.6rem;border:1px solid var(--line);border-radius:12px;background:var(--raised)}
table.plan{width:100%;border-collapse:collapse;font-size:.84rem}table.plan th{text-align:left;font:700 .66rem var(--font-display);letter-spacing:.05em;text-transform:uppercase;color:#fff;background:var(--primary-dark);padding:.6rem .8rem;white-space:nowrap}
table.plan td{padding:.55rem .8rem;border-top:1px solid var(--line);vertical-align:top}table.plan tr:nth-child(even) td{background:#fbfaff}
pre.code{background:#0f172a;color:#e2e8f0;padding:1rem 1.2rem;border-radius:12px;overflow:auto;font:.8rem/1.55 var(--font-mono)}pre.code code{background:none;border:0;padding:0;color:inherit}
pre.mermaid{background:var(--raised);border:1px solid var(--line);border-radius:12px;padding:1rem;overflow:auto;text-align:center}
.callout{background:var(--raised);border:1px solid var(--line);border-left:4px solid var(--primary);border-radius:0 14px 14px 0;padding:.9rem 1.2rem;margin:1.2rem 0}.callout .label{font:700 .68rem var(--font-display);letter-spacing:.08em;text-transform:uppercase;color:var(--primary);margin-bottom:.3rem}.callout p:last-child{margin-bottom:0}
.callout.warn{border-left-color:var(--warn)}.callout.warn .label{color:#92400e}
figure.shot{margin:1.2rem 0 1.6rem}figure.shot img{max-width:100%;border:1px solid var(--line);border-radius:12px;box-shadow:0 12px 28px -14px rgba(30,27,75,.35)}figure.shot figcaption{font-size:.76rem;color:var(--ink-soft);margin-top:.35rem}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem;margin:1.2rem 0}.card{background:var(--raised);border:1px solid var(--line);border-radius:14px;padding:1.1rem 1.25rem;text-decoration:none;color:var(--ink);display:block}.card:hover{border-color:var(--primary)}.card b{font:700 1rem var(--font-display);color:var(--primary-dark);display:block;margin-bottom:.25rem}.card span{font-size:.84rem;color:var(--ink-soft)}
.pill{display:inline-block;font:600 .68rem var(--font-mono);padding:.1rem .5rem;border-radius:99px;background:var(--primary-soft);color:#3730a3;border:1px solid var(--primary-line)}
.filters{display:flex;flex-wrap:wrap;gap:.6rem;margin:1rem 0}.filters input,.filters select{font:inherit;padding:.4rem .6rem;border:1px solid var(--line);border-radius:8px;background:var(--raised)}
@media (max-width:900px){.layout{grid-template-columns:1fr}.rail{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line)}main{padding:1.2rem 1rem 3rem}}
@media print{.rail{display:none}.layout{grid-template-columns:1fr}.chapter{page-break-before:always}}
`;
const SPY = `<script>(function(){var l=[].slice.call(document.querySelectorAll('.rail a[href^="#"]'));var s=l.map(function(a){return document.querySelector(a.getAttribute('href'))}).filter(Boolean);if(!('IntersectionObserver' in window))return;var io=new IntersectionObserver(function(e){e.forEach(function(x){if(!x.isIntersecting)return;var id='#'+x.target.id;l.forEach(function(a){a.classList.toggle('active',a.getAttribute('href')===id)})})},{rootMargin:'-10% 0px -80% 0px'});s.forEach(function(x){io.observe(x)})})();</script>`;
const MERMAID = `<script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js"></script><script>if(window.mermaid)mermaid.initialize({startOnLoad:true,theme:'neutral'});</script>`;
const page = ({ title, rail, body, mermaid }) => `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${FONTS}<style>${CSS}</style></head><body><div class="layout">${rail}<main>${body}</main></div>${SPY}${mermaid ? MERMAID : ''}</body></html>\n`;

// ---------------------------------------------------------------- technical documentation
const GL = 'docs/gl-ap-ar/';
const SUB = { 'data-dictionary.html': GL + 'annex-a-data-dictionary.md', 'traceability.html': GL + '08-traceability-matrix.md', 'test-catalogue.html': 'docs/test-cases/README.md' };
const TECH_OUT = D('technical');
const linkmap = Object.fromEntries(Object.entries(SUB).map(([h, s]) => [s, h]));
const CH = [
  { part: 'Orientation' },
  { id: 'overview', title: 'How this documentation fits together', html: 'overview' },
  { id: 'environments', src: 'docs/operations/environments.md' },
  { part: 'The whole system' },
  { id: 'platform', src: 'docs/platform/00-platform-architecture.md' },
  { id: 'module-catalogue', src: 'docs/platform/annex-h-module-catalogue.md' },
  { part: 'Requirements' },
  { id: 'brd', src: GL + '01-business-requirements-document.md' },
  { id: 'srs', src: GL + '02-software-requirements-specification.md' },
  { part: 'Design' },
  { id: 'solution-design', src: GL + '03-solution-design-document.md' },
  { id: 'technical-design', src: GL + '04-technical-design-document.md' },
  { id: 'accounting-rules', src: 'docs/design-notes/accounting-rules.md' },
  { id: 'period-rule', src: 'docs/design-notes/reporting-rules.md' },
  { id: 'date-standard', src: 'docs/design-notes/date-fields-standard.md' },
  { id: 'posting-control', src: 'docs/design-notes/posting-control.md' },
  { id: 'ar-ap-bank', src: 'docs/design-notes/ar-ap-bank-design.md', tag: 'Decision record: written before building, with an as-built section' },
  { id: 'dimensions-decisions', src: 'docs/design-notes/gl-step1-5-decisions.md', tag: 'Decision record: written before building' },
  { id: 'approval-research', src: 'docs/design-notes/approval-rules-tier1-research.md', tag: 'Decision record: Sprint 11 research and owner decisions' },
  { id: 'agreed-register', src: 'docs/design-notes/agreed-decisions-register.md', tag: 'Standing register: read before any finance design' },
  { id: 'coa-benchmark', src: 'docs/design-notes/coa-tier1-benchmark.md', tag: 'Benchmark and proposal for decision: nothing built' },
  { id: 'tax-analysis', src: 'docs/design-notes/taxation-analysis.md', tag: 'Analysis and proposal for decision: nothing built (Sprints 14 to 14f)' },
  { part: 'Quality' },
  { id: 'test-strategy', src: GL + '05-test-strategy.md' },
  { part: 'Delivery' },
  { id: 'sprint-log', src: GL + '07-sprint-log.md' },
  { part: 'Reference' },
  { id: 'api', src: GL + 'annex-b-api-reference.md' },
  { id: 'permissions', src: GL + 'annex-c-permissions-matrix.md' },
  { id: 'posting-rules', src: GL + 'annex-d-posting-rules.md' },
  { id: 'developer-guide', src: GL + 'annex-e-developer-guide.md' },
  { id: 'runbook', src: GL + 'annex-f-operations-runbook.md' },
  { id: 'glossary', src: GL + 'annex-g-glossary.md' },
  { part: 'Operations and proposals' },
  { id: 'deployment', src: 'docs/operations/deployment-plan.md' },
  { id: 'ha-proposal', src: 'docs/proposals/high-availability-plan.md', tag: 'Proposal: nothing built yet' },
  { id: 'ai-proposal', src: 'docs/proposals/ai-feature-plan.md', tag: 'Proposal: nothing built yet' },
  { part: 'Linked documents' },
  { id: 'linked', title: 'Linked pages and other documents', html: 'linked' },
];
for (const c of CH) if (c.src) linkmap[c.src] = `#${c.id}`;

function overview() {
  return `<p>This is the technical documentation of Warraq ERP as a whole: how the platform works (companies, permissions, ledger, e-invoicing), every module with its endpoints, tables, screens and tests, and the requirements, design, tests and delivery history. The requirements and tests of the older modules (sales, expenses, procurement, POS, ZATCA, VAT, master data, users) were written as built from the code and its automated tests; those of the finance core (General Ledger, Receivables, Payables, Bank) were written before it was built. It is one document, read top to bottom or by the menu on the left. Three long tables are on their own pages and linked: the <a href="data-dictionary.html">data dictionary</a>, the <a href="traceability.html">traceability matrix</a> and the <a href="test-catalogue.html">test-case catalogue</a>.</p>
<div class="table-wrap"><table class="plan"><thead><tr><th>If you want to know…</th><th>Read</th></tr></thead><tbody>
<tr><td>How the whole system works, and what modules exist</td><td><a href="#platform">Platform architecture</a>, then the <a href="#module-catalogue">Module catalogue</a> (one sheet per module)</td></tr>
<tr><td>What the business asked for in the finance core, and what is built</td><td><a href="#brd">Business requirements</a>, then <a href="#srs">System requirements</a></td></tr>
<tr><td>How the system is shaped and why</td><td><a href="#solution-design">Solution design</a> (principles, decisions), then <a href="#technical-design">Technical design</a> (algorithms, tables, traps)</td></tr>
<tr><td>The rules every document must obey (dates, periods, posting, cancellation)</td><td><a href="#accounting-rules">Accounting rules</a>, <a href="#period-rule">Period rule</a>, <a href="#date-standard">Date standard</a>, <a href="#posting-control">Posting control</a></td></tr>
<tr><td>What a document posts to the ledger</td><td><a href="#posting-rules">Posting rules</a></td></tr>
<tr><td>Tables and columns</td><td><a href="data-dictionary.html">Data dictionary</a></td></tr>
<tr><td>Endpoints and who may call them</td><td><a href="#api">API reference</a>, <a href="#permissions">Permissions matrix</a></td></tr>
<tr><td>How to add a feature without breaking the rules</td><td><a href="#developer-guide">Developer guide</a></td></tr>
<tr><td>How it is tested, and which test proves which requirement</td><td><a href="#test-strategy">Test strategy</a>, <a href="test-catalogue.html">catalogue</a>, <a href="traceability.html">traceability</a></td></tr>
<tr><td>What was delivered, when, and what is still planned</td><td><a href="#sprint-log">Sprint log</a></td></tr>
<tr><td>How to release, back up, roll back, support</td><td><a href="#environments">Environments</a>, <a href="#runbook">Operations runbook</a>, <a href="#deployment">Deployment plan</a></td></tr>
<tr><td>How to use the screens</td><td><a href="../user-manual/warraq-erp-user-manual.html">User manual</a></td></tr>
</tbody></table></div>
<div class="callout"><div class="label">Which version is described</div><p>The finance core is <b>Warraq 2.0</b> (branch <code>v2</code>, the Demo). Live (1.0, branch <code>master</code>) does not have it yet. Chapters say so where it matters; the <a href="#environments">Environments</a> chapter explains the two tracks.</p></div>
<div class="callout warn"><div class="label">Reading copy, not the source</div><p>This page is generated. The requirements, system requirements, sprint log, traceability and annexes A to C are generated from <code>docs/gl-ap-ar/source/*.mjs</code> and from the code; the other chapters are hand-written Markdown under <code>docs/gl-ap-ar</code>, <code>docs/design-notes</code>, <code>docs/operations</code> and <code>docs/proposals</code>. Edit those, then run <code>npx tsx scripts/build-gl-docs.mjs</code> and <code>node scripts/build-docs-html.mjs</code>; never edit this page. The skill <code>update-docs-after-development</code> walks through it.</p></div>
<p class="src">Version: built ${REV}.</p>`;
}
function linked() {
  const c = (h, b, s) => `<a class="card" href="${h}"><b>${b}</b><span>${s}</span></a>`;
  return `<div class="cards">
${c('data-dictionary.html', 'Data dictionary', 'Every table and column of the finance core, generated from the schema (annex A).')}
${c('traceability.html', 'Traceability matrix', 'Blueprint to business requirement to system requirement to test case to sprint.')}
${c('test-catalogue.html', 'Test-case catalogue', 'Every test case with its steps, filterable. Also as CSV, JSON and Gherkin in docs/test-cases.')}
${c('../user-manual/warraq-erp-user-manual.html', 'User manual', 'The screens, step by step, for everyday operations and the finance core.')}
${c('../zatca/zatca-onboarding-user-manual.html', 'ZATCA onboarding guide', 'Company set-up for e-invoicing, verified against the ZATCA sandbox.')}
${c('../zatca/sandbox-qa-test-plan.html', 'ZATCA QA test plan', 'The dual-gate verification protocol for anything touching the ZATCA pipeline.')}
${c('../reference/Finance-Core-Blueprint.pdf', 'Finance Core Blueprint (PDF)', 'The original requirements blueprint every business requirement traces to.')}
${c('../archive/README.md', 'Archive', 'Superseded plans, early sprint logs and design experiments. Kept for history; not current.')}
</div>`;
}

const subRail = `<aside class="rail"><div class="mark">Warraq ERP</div><div class="sub">Technical documentation</div><a class="home" href="index.html">← Technical documentation</a><a class="home" href="../index.html">← All documentation</a></aside>`;
function buildTechnical() {
  const rail = ['<aside class="rail"><div class="mark">Warraq ERP</div><div class="sub">Technical documentation</div><a class="home" href="../index.html">← All documentation</a>'];
  const body = ['<p class="eyebrow">Warraq ERP · Technical documentation</p><h1 style="font-size:2.3rem;margin:.2rem 0 1.5rem">Warraq ERP: platform, modules and finance core</h1>'];
  let n = 0, mermaid = false;
  for (const c of CH) {
    if (c.part) { rail.push(`<div class="grp">${esc(c.part)}</div>`); continue; }
    n++;
    let title = c.title, inner;
    if (c.html) inner = c.html === 'overview' ? overview() : linked();
    else {
      const md = read(path.join(ROOT, c.src)); title = c.title || title1(md).replace(/\s+[—-]\s+General Ledger.*$/, '');
      const ctx = { id: c.id, src: c.src, outDir: TECH_OUT, linkmap, shift: 1 };
      inner = `<p class="src">Source: <code>${esc(c.src)}</code>${c.tag ? ` · <span class="pill">${esc(c.tag)}</span>` : ''}</p>` + render(stripH1(md), ctx);
      if (ctx.mermaid) mermaid = true;
    }
    rail.push(`<a href="#${c.id}">${n}. ${esc(title)}</a>`);
    body.push(`<section class="chapter" id="${c.id}"><p class="eyebrow">Chapter ${n}</p><h2>${esc(title)}</h2>${inner}</section>`);
  }
  rail.push('</aside>');
  write(D('technical', 'index.html'), page({ title: 'Warraq ERP Technical Documentation', rail: rail.join(''), body: body.join('\n'), mermaid }));
  for (const [file, src] of [['data-dictionary.html', GL + 'annex-a-data-dictionary.md'], ['traceability.html', GL + '08-traceability-matrix.md']]) {
    const md = read(path.join(ROOT, src));
    const ctx = { id: path.basename(file, '.html'), src, outDir: TECH_OUT, linkmap: { ...linkmap, [src]: file }, shift: 1 };
    write(D('technical', file), page({ title: `${title1(md)} · Warraq ERP`, rail: subRail, body: `<section class="chapter"><p class="eyebrow">Technical documentation · linked page</p><h2>${esc(title1(md))}</h2><p class="src">Source: <code>${esc(src)}</code></p>${render(stripH1(md), ctx)}</section>` }));
  }
  buildCatalogue();
}
function buildCatalogue() {
  const j = JSON.parse(read(D('test-cases', 'test-case-catalogue.json')));
  const readme = read(D('test-cases', 'README.md'));
  const ctx = { id: 'catalogue', src: 'docs/test-cases/README.md', outDir: TECH_OUT, linkmap: {}, shift: 1 };
  const intro = render(stripH1(readme).split('\n## Coverage today')[0], ctx);
  const mods = j.modules.map(m => `<option value="${esc(m.id)}">${esc(m.id)} · ${esc(m.name)}</option>`).join('');
  const rows = j.cases.map(c => `<tr data-m="${esc(c.moduleId)}" data-p="${esc(c.priority)}" data-s="${esc(c.status)}"><td style="white-space:nowrap"><b>${esc(c.id)}</b></td><td>${esc(c.title)}<div style="color:var(--ink-soft);font-size:.78rem;margin-top:.3rem"><b>Given</b> ${esc(c.given)}<br><b>When</b> ${esc(c.when)}<br><b>Then</b> ${esc(c.then)}</div></td><td>${esc(c.type)}</td><td>${esc(c.priority)}</td><td>${esc(c.layer)}</td><td>${c.automation && /^tests\//.test(c.automation) ? `<code>${esc(c.automation)}</code>` : esc(c.status)}</td></tr>`).join('');
  const body = `<section class="chapter"><p class="eyebrow">Technical documentation · linked page</p><h2>Test-case catalogue</h2><p class="src">Generated ${esc(j.generated)} from <code>docs/test-cases/catalogue-source.mjs</code> · ${j.cases.length} cases in ${j.modules.length} modules</p>${intro}
<div class="filters"><input id="q" placeholder="Search id, title, steps…" size="34"><select id="m"><option value="">All modules</option>${mods}</select><select id="p"><option value="">All priorities</option><option>P1</option><option>P2</option><option>P3</option></select><select id="s"><option value="">Any status</option><option>Automated</option><option>Candidate</option><option>Manual</option></select><span id="n" class="pill"></span></div>
<div class="table-wrap"><table class="plan" id="t"><thead><tr><th>ID</th><th>Case</th><th>Type</th><th>Pri</th><th>Layer</th><th>Automated by</th></tr></thead><tbody>${rows}</tbody></table></div></section>
<script>(function(){var r=[].slice.call(document.querySelectorAll('#t tbody tr')),q=document.getElementById('q'),m=document.getElementById('m'),p=document.getElementById('p'),s=document.getElementById('s'),n=document.getElementById('n');function f(){var t=q.value.toLowerCase(),c=0;r.forEach(function(x){var ok=(!m.value||x.dataset.m===m.value)&&(!p.value||x.dataset.p===p.value)&&(!s.value||x.dataset.s===s.value)&&(!t||x.textContent.toLowerCase().indexOf(t)>-1);x.hidden=!ok;if(ok)c++});n.textContent=c+' shown'}[q,m,p,s].forEach(function(e){e.addEventListener('input',f)});f()})();</script>`;
  write(D('technical', 'test-catalogue.html'), page({ title: 'Test-case catalogue · Warraq ERP', rail: subRail, body }));
}

// ---------------------------------------------------------------- user manual: part A (hand-built, source/) + finance core (gl-ap-ar/06)
function buildManual() {
  let a = read(D('user-manual', 'source', 'part-a-everyday-operations.html'));
  const md = read(D('gl-ap-ar', '06-user-manual.md'));
  const out = D('user-manual');
  const parts = stripH1(md).split(/^## /m); const intro = parts.shift();
  const secs = parts.map((p, i) => { const nl = p.indexOf('\n'); const head = p.slice(0, nl).trim(); return { n: i + 1, head: head.replace(/^\d+\.\s*/, ''), id: `fc-${i + 1}`, body: p.slice(nl + 1) }; });
  const mk = id => ({ id, src: GL + '06-user-manual.md', outDir: out, linkmap: {}, shift: 0, imgBase: h => path.posix.join('../gl-ap-ar', h) });
  const css = `
  .fc figure.shot{margin:1.2rem 0 1.6rem}.fc figure.shot img{max-width:100%;border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow)}.fc figure.shot figcaption{font-size:.76rem;color:var(--ink-soft);margin-top:.35rem}
  .fc pre.code{background:#0f172a;color:#e2e8f0;padding:1rem 1.2rem;border-radius:12px;overflow:auto;font-size:.8rem}.fc pre.code code{background:none;border:0;color:inherit}.fc table.plan td{vertical-align:top}.fc h3{scroll-margin-top:2rem}`;
  a = a.replace('</style>', css + '\n</style>');
  a = a.replace('<b>Coverage</b><span>40+ screens, every module</span>', '<b>Coverage</b><span>Everyday operations + the 2.0 finance core</span>');
  a = a.replace('<p class="cover-eyebrow">Master Data · Transactions · Reports · Configuration</p>', '<p class="cover-eyebrow">Master Data · Transactions · Reports · Configuration · General Ledger, Receivables, Payables, Bank</p>');
  const railLinks = ['<div class="rail-group">Finance core (Warraq 2.0)</div>', '<a href="#fc-intro">Overview</a>', ...secs.map(s => `<a href="#${s.id}">${s.n}. ${esc(s.head).replace(/\s*\(BR[^)]*\)/, '')}</a>`)].join('\n        ');
  a = a.replace('<div class="rail-group">Reference</div>', railLinks + '\n        <div class="rail-group">Reference</div>');
  const introHtml = `<section id="fc-intro" class="wide fc" style="max-width:none;"><p class="section-eyebrow">Finance core (Warraq 2.0)</p><h2>General Ledger, Receivables, Payables and Bank</h2>
<div class="callout risk"><div class="label">Which version</div><p style="margin:0">The chapters from here to the glossary describe <b>Warraq 2.0</b> (the Demo). Live (1.0) does not have them yet. The screens in these chapters are real screenshots of a demonstration company, <i>Al-Noor Trading Co</i>; the panels above are reproductions.</p></div>
${render(intro.replace(/^\s*Version[^\n]*\n/, ''), mk('fc-intro'))}
<p>For how the system works inside, and what each requirement is, see the <a href="../technical/index.html">technical documentation</a>.</p></section>`;
  const secHtml = secs.map(s => `<section id="${s.id}" class="wide fc" style="max-width:none;"><p class="section-eyebrow">Finance core · chapter ${s.n}</p><h2>${esc(s.head)}</h2>${render(s.body, mk(s.id))}</section>`).join('\n\n');
  a = a.replace('<section id="appendix"', () => introHtml + '\n\n' + secHtml + '\n\n      <section id="appendix"');
  a = a.replace('<title>Warraq — ERP User Manual</title>', '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Warraq ERP User Manual</title>');
  if (!a.includes('id="fc-1"')) problems.push('manual: finance-core chapters were not injected');
  a = a.replace('<div class="signoff">', '<div class="signoff"><p style="color:#c6c8ef;margin:0 0 1rem">Back to <a style="color:#fff" href="../index.html">all documentation</a> · <a style="color:#fff" href="../technical/index.html">technical documentation</a> · <a style="color:#fff" href="../zatca/zatca-onboarding-user-manual.html">ZATCA onboarding guide</a></p><p style="color:#c6c8ef;margin:0 0 1rem;font-size:.8rem">Version: built ' + REV + '.</p>');
  write(D('user-manual', 'warraq-erp-user-manual.html'), a);
}

// ---------------------------------------------------------------- start page
function buildHub() {
  const body = `<p class="eyebrow">Warraq ERP</p><h1 style="font-size:2.4rem;margin:.2rem 0 .6rem">Documentation: start here</h1>
<p style="max-width:70ch">Two documents cover the system. Open one of these; everything else in this folder is either a source they are built from, or an archive.</p>
<div class="cards">
<a class="card" href="user-manual/warraq-erp-user-manual.html"><b>User manual</b><span>For people who use Warraq: every screen step by step. Everyday operations (point of sale, invoices, purchasing, reports, set-up) and the finance core (ledger, receivables, payables, bank, approvals).</span></a>
<a class="card" href="technical/index.html"><b>Technical documentation</b><span>For analysts, developers and testers: requirements, design, rules, tests, sprint log, API, data, operations. One document with three linked tables.</span></a>
</div>
<h3 style="margin-top:2.4rem">Related</h3>
<div class="cards">
<a class="card" href="zatca/zatca-onboarding-user-manual.html"><b>ZATCA onboarding guide</b><span>Setting a company up for e-invoicing, step by step.</span></a>
<a class="card" href="zatca/sandbox-qa-test-plan.html"><b>ZATCA QA test plan</b><span>How anything touching the e-invoicing pipeline is verified.</span></a>
<a class="card" href="reference/Finance-Core-Blueprint.pdf"><b>Finance Core Blueprint</b><span>The original requirements blueprint (PDF).</span></a>
<a class="card" href="archive/README.md"><b>Archive</b><span>Superseded plans and experiments, kept for history.</span></a>
</div>
<h3 style="margin-top:2.4rem">What the folders are</h3>
<div class="table-wrap"><table class="plan"><thead><tr><th>Folder</th><th>What it holds</th></tr></thead><tbody>
<tr><td><code>user-manual/</code>, <code>technical/</code></td><td>The two documents above (generated; do not edit)</td></tr>
<tr><td><code>gl-ap-ar/</code></td><td>Sources of both: Markdown chapters, <code>source/*.mjs</code> for requirements and sprints, manual screenshots</td></tr>
<tr><td><code>platform/</code></td><td>How the whole system works, and the generated catalogue of every module</td></tr>
<tr><td><code>design-notes/</code>, <code>operations/</code>, <code>proposals/</code></td><td>Hand-written chapters included in the technical document</td></tr>
<tr><td><code>test-cases/</code></td><td>The test-case catalogue: source, CSV, JSON, Gherkin</td></tr>
<tr><td><code>zatca/</code>, <code>reference/</code></td><td>ZATCA guides and the blueprint</td></tr>
<tr><td><code>archive/</code></td><td>Superseded; not current</td></tr>
</tbody></table></div><p class="src">Version: built ${REV}. To rebuild: <code>npx tsx scripts/build-gl-docs.mjs &amp;&amp; node scripts/build-docs-html.mjs</code>.</p>`;
  write(D('index.html'), page({ title: 'Warraq ERP Documentation', rail: '<aside class="rail"><div class="mark">Warraq ERP</div><div class="sub">Documentation</div><a class="home" href="user-manual/warraq-erp-user-manual.html">User manual</a><a class="home" href="technical/index.html">Technical documentation</a></aside>', body }));
}

const written = [];
function write(f, s) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); written.push(f); }

// ---------------------------------------------------------------- link check
function check(f) {
  const html = fs.readFileSync(f, 'utf8'); const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const u = m[1]; if (/^(https?:|mailto:|data:|javascript:)/.test(u)) continue;
    if (u.startsWith('#')) { if (!ids.has(u.slice(1))) problems.push(`${path.relative(ROOT, f)}: missing anchor ${u}`); continue; }
    const [file, frag] = u.split('#'); const abs = path.resolve(path.dirname(f), decodeURIComponent(file));
    if (!fs.existsSync(abs)) problems.push(`${path.relative(ROOT, f)}: missing file ${u}`);
    else if (frag && abs.endsWith('.html')) { const t = fs.readFileSync(abs, 'utf8'); if (!t.includes(`id="${frag}"`)) problems.push(`${path.relative(ROOT, f)}: missing anchor ${u}`); }
  }
}

buildTechnical(); buildManual(); buildHub();
for (const f of written) check(f);
console.log('Written:', written.map(f => path.relative(ROOT, f)).join(', '));
if (problems.length) { console.log(`\n${problems.length} problem(s):`); for (const p of [...new Set(problems)].slice(0, 80)) console.log(' -', p); process.exit(1); }
console.log('OK: every link, image and anchor resolves.');
