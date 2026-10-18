// Generates docs/platform/annex-h-module-catalogue.md: one sheet per module of the whole system (older 1.0 modules and the 2.0 finance core),
// built from the code: endpoints and permissions (server/routes), tables touched (schema.ts), screens (src/components), tests (tests/).
// The "what it is" sentence and the manual link are written below, by hand, and checked: a route file with no entry here fails the build.
//   node scripts/build-module-catalogue.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const MAN = '../user-manual/warraq-erp-user-manual.html';

// file (server/routes/<file>.ts) -> sheet
const MODULES = [
  { file: 'masterEntities', title: 'Master data', is: 'Customers, vendors, products, product categories, modifier groups, units of measure and their conversions, banks, tax slabs, job titles, and company profile, theme and numbering settings. Every document picks from these; none is ever hard-deleted, only made inactive.', screens: ['MasterEntities.tsx', 'ModifierGroupsModule.tsx', 'QuickAddPartyButton.tsx', 'QuickAddProductModal.tsx'], manual: ['partners', 'catalog', 'config-org'] },
  { file: 'masterImport', title: 'Product import', is: 'Bulk product load from a spreadsheet: download a template, validate the file, then commit.', screens: ['ProductImportModal.tsx', 'PartyImportModal.tsx'], manual: ['catalog'] },
  { file: 'branches', title: 'Branches', is: 'Physical locations inside a company. Documents optionally belong to a branch; users can be restricted to branches.', screens: ['AdminSettings.tsx'], manual: ['config-org'] },
  { file: 'employees', title: 'Employees and job titles', is: 'Employee records and their job titles (a person is separate from a login user).', screens: ['EmployeesModule.tsx'], manual: ['hr'] },
  { file: 'transactions', title: 'Sales documents, fiscal months, recurring postings', is: 'Quotations (convertible to invoices), tax invoices, credit notes, later payments and cancellation; fiscal month open/close; recurring expense templates, postings and accruals; interbank transfers; investor contributions. Invoices, credit notes and debit notes are submitted to ZATCA after commit. A cleared invoice can only be reversed by a credit note.', screens: ['QuotationModule.tsx', 'InvoiceModule.tsx', 'InvoiceViewScreen.tsx', 'RecurringExpenses.tsx', 'AdminSettings.tsx'], manual: ['sales', 'expenses', 'config-fiscal'] },
  { file: 'expenses', title: 'Expenses', is: 'Vendor expenses with VAT, payment at entry or later, reversal and cancellation. Posts to the ledger and creates the payment voucher through one shared path.', screens: ['ExpenseModule.tsx'], manual: ['expenses'] },
  { file: 'inventory', title: 'Procurement and inventory', is: 'Purchase requisitions, purchase orders, goods receipt notes, purchase bills (with payment), purchase returns, vendor refunds, warehouse dispatches and receivings, stock adjustments and stock takes. Stock is kept in a ledger of movements.', screens: ['InventoryModule.tsx'], manual: ['purchasing', 'warehouses'] },
  { file: 'pos', title: 'Point of sale', is: 'Cashier shifts, held (parked) sales and returns against earlier sales; sales themselves are invoices.', screens: ['PosModule.tsx'], manual: ['pos'] },
  { file: 'reports', title: 'Reports and dashboard', is: 'Every report, dashboard figure and list total is computed on the server for the active company, with no row cap: sales, purchase, stock, statements, profit and loss, trial balance, balance sheet, the consistency check. Document-based reports share one set of facts with the ledger reports.', screens: ['Dashboard.tsx', 'ReportViewer.tsx', 'SalesReportsModule.tsx', 'PurchaseReportsModule.tsx', 'InventoryReportsModule.tsx', 'ReportViewControls.tsx'], manual: ['fin-reports', 'ops-reports'] },
  { file: 'taxReturns', title: 'VAT returns', is: 'Quarterly VAT return generation and filing; a filed quarter locks the documents in it.', screens: ['VatReturnsPanel.tsx'], manual: ['config-fiscal'] },
  { file: 'zatca', title: 'ZATCA e-invoicing', is: 'Per-company, per-environment (sandbox, simulation, production) onboarding: key pair and CSR, compliance and production CSIDs, and invoice submission. The signing and hash-chain pipeline lives in server/lib/zatca and is the most sensitive code in the system.', screens: ['ZatcaOnboardingWizard.tsx'], manual: ['config-zatca'] },
  { file: 'users', title: 'Users', is: 'Login accounts and their roles, branch access and manager (used by approval rules). A delegated user can only create ordinary staff, never an administrator.', screens: ['AdminSettings.tsx', 'ChangePasswordScreen.tsx'], manual: ['config-roles'] },
  { file: 'roles', title: 'Roles and permissions', is: 'Roles hold create / read / update / delete (and a few action) permissions per module; a user holds the union of their roles.', screens: ['AdminSettings.tsx'], manual: ['config-roles'] },
  { file: 'roleTemplates', title: 'Role templates', is: 'Platform-wide starting roles a company can copy.', screens: ['AdminSettings.tsx'], manual: ['config-roles'] },
  { file: 'sessions', title: 'Active sessions', is: 'List and end signed-in sessions (super-admin).', screens: ['AdminSettings.tsx'], manual: ['config-roles'] },
  { file: 'companies', title: 'Companies', is: 'Company registration status and removal (platform administration).', screens: ['AdminSettings.tsx'], manual: ['config-org'] },
  { file: 'onboarding', title: 'Company onboarding', is: 'Self-service company sign-up with email confirmation and administrator approval.', screens: ['CompanyOnboardingScreen.tsx', 'ConfirmOnboardingEmailScreen.tsx'], manual: ['config-org'] },
  { file: 'settingsResources', title: 'Document templates and translations', is: 'Print layouts for every document and the English / Arabic / Urdu translation table.', screens: ['AdminSettings.tsx', 'DocumentRenderer.tsx'], manual: ['config-ops'] },
  { file: 'systemBanner', title: 'System banner', is: 'A platform notice shown to all users.', screens: ['SystemBanner.tsx'], manual: [] },
  { file: 'approvals', title: 'Approval rules (2.0)', is: 'Amount-threshold, multi-level approval for vendor payments, vendor bills, credit notes and manual journals, with delegation. Detailed in the finance-core chapters.', screens: ['ledger/ApprovalScreens.tsx'], manual: ['fc-intro'], finance: true },
  { file: 'ledgerAccounts', title: 'General ledger: accounts (2.0)', is: 'Company chart of accounts and account mapping.', screens: ['ledger/'], manual: ['fc-2'], finance: true },
  { file: 'ledgerJournals', title: 'General ledger: journals (2.0)', is: 'Manual journals with approval and reversal; the posting engine.', screens: ['ledger/'], manual: ['fc-6'], finance: true },
  { file: 'ledgerReports', title: 'General ledger: reports (2.0)', is: 'Trial balance, income statement, balance sheet, cash flow, ledger-versus-documents.', screens: ['ledger/'], manual: ['fc-7'], finance: true },
  { file: 'ledgerReportDefs', title: 'General ledger: report designer (2.0)', is: 'Configurable statement definitions.', screens: ['ledger/'], manual: ['fc-7'], finance: true },
  { file: 'ledgerDimensions', title: 'General ledger: dimensions (2.0)', is: 'Analytical dimensions (branch, department, custom) on ledger lines.', screens: ['ledger/'], manual: ['fc-2'], finance: true },
  { file: 'ledgerOpening', title: 'General ledger: opening balances (2.0)', is: 'Opening balance entry.', screens: ['ledger/'], manual: ['fc-2'], finance: true },
  { file: 'ledgerPostingPolicy', title: 'General ledger: posting control (2.0)', is: 'Lock date and back-date window.', screens: ['ledger/'], manual: ['fc-2'], finance: true },
  { file: 'ledgerSubledger', title: 'Receivables and payables ledgers (2.0)', is: 'Aging and party ledgers from party-tagged ledger lines.', screens: ['ledger/'], manual: ['fc-5'], finance: true },
  { file: 'settlements', title: 'Receipts and vendor payments (2.0)', is: 'Receive Payment and Pay Vendor across documents, on account, cancel.', screens: ['ledger/'], manual: ['fc-3', 'fc-4'], finance: true },
  { file: 'bankReconciliation', title: 'Bank reconciliation (2.0)', is: 'Reconciliation sessions per bank.', screens: ['ledger/'], manual: ['fc-8'], finance: true },
];

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
  lines.forEach((l, i) => { const x = l.match(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/); if (!x) return; const win = lines.slice(i, i + 14).join(' '); const win30 = lines.slice(i, i + 30).join(' ');
    const perms = [...new Set([...win.matchAll(/hasPermission\(req\.user, [`']([\w.${}]+)[`']/g)].map(y => y[1]), ...[...win.matchAll(/requirePermission\('([\w.]+)'\)/g)].map(y => y[1]), ...[...win.matchAll(/guarded\('(\w+)'/g)].map(y => y[1]), ...[...win.matchAll(/\bpermissions?\.([a-zA-Z]+)\.([a-zA-Z]+)(?:\.enabled)?/g)].filter(y => !['user', 'role', 'length'].includes(y[1])).map(y => `${y[1]}.${y[2]}`))];
    rows.push([x[1].toUpperCase(), (mount === '/api' ? '/api' : mount) + (x[2] === '/' ? '' : x[2]), perms.join(', ')]); });
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
