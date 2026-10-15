// Captures the screens of the GL / AR / AP user manual (docs/gl-ap-ar/06-user-manual.md) from a running 2.0 server, so the manual shows the real application.
// It creates a throw-away demo company ("Al-Noor Trading Co") with believable data through the real API, drives the real screens with Playwright, saves PNGs to
// docs/gl-ap-ar/user-manual/screens/, then deletes the company. Usage: (server on 3001 running)  npx tsx scripts/capture-manual-screens.ts
import fs from 'node:fs';
import bcrypt from 'bcrypt';
import { chromium, type Page } from 'playwright';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { provisionStarterResources } from '../server/lib/companyProvisioning.js';
import { ensureBankAccount } from '../server/lib/chartOfAccounts.js';
import { purgeCompany } from '../tests/helpers/purgeCompany.js';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3001';
const OUT = 'docs/gl-ap-ar/user-manual/screens'; fs.mkdirSync(OUT, { recursive: true });
const iso = (d: Date) => d.toISOString().slice(0, 10);
const TODAY = iso(new Date()); const day = (n: number) => iso(new Date(Date.now() - n * 86400000));
const PW = 'Manual_' + generateId().replace(/-/g, '').slice(-10) + '!';

// a previous aborted run may have left its company behind
for (const r of ((await db.execute(sql`SELECT id FROM companies WHERE name = 'Al-Noor Trading Co'`)) as any).rows) await purgeCompany(r.id);
const companyId = generateId(); const adminId = generateId(); const username = 'noor_' + adminId.slice(-6);
await db.insert(schema.companies).values({ id: companyId, name: 'Al-Noor Trading Co', address: 'King Fahd Road, Riyadh', phone: '0112345678', email: 'accounts@alnoor.example', logoUrl: '', customHeader: '', customFooter: 'Thank you for your business', currency: 'SAR', counters: {}, zatcaEnabled: false } as any);
await db.transaction(async (tx: any) => provisionStarterResources(tx, { companyId, companyName: 'Al-Noor Trading Co' }));
for (const m of [TODAY.slice(0, 7), day(35).slice(0, 7)]) await db.insert(schema.fiscalMonths).values({ id: m, name: m, status: 'Open', companyId }).onConflictDoNothing();
const slab = generateId(); await db.insert(schema.taxSlabs).values({ id: slab, name: 'Standard 15%', percentage: '15', companyId } as any);
const bank = generateId(); await db.insert(schema.bankAccounts).values({ id: bank, bankName: 'Al Rajhi Bank - Main Account', accountNumber: 'SA4580000204608016212908', accountTitle: 'Al-Noor Trading Co', openingBalance: '0', companyId } as any);
await db.transaction(async (tx: any) => ensureBankAccount(tx, companyId, { id: bank, bankName: 'Al Rajhi Bank - Main Account', accountTitle: 'Al-Noor Trading Co' }));
await db.insert(schema.users).values({ id: adminId, username, password: await bcrypt.hash(PW, 10), role: 'admin', companyId, isSuperAdmin: false, uiLanguage: 'en' });
const mkParty = async (table: any, name: string, phone: string) => { const id = generateId(); await db.insert(table).values({ id, name, phone, email: name.split(' ')[0].toLowerCase() + '@example.com', address: 'Riyadh', companyId, buyerType: 'B2C' } as any); return id; };
const custs = [await mkParty(schema.customers, 'Gulf Builders Co', '0501111111'), await mkParty(schema.customers, 'Najd Furniture Gallery', '0502222222'), await mkParty(schema.customers, 'Red Sea Contracting', '0503333333')];
const vends = [await mkParty(schema.vendors, 'Riyadh Office Supplies', '0504444444'), await mkParty(schema.vendors, 'Saudi Electricity Co', '0505555555')];

const login: any = await (await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PW }) })).json();
const sid = login.sessionId as string;
const call = async (path: string, body?: any, method = body ? 'POST' : 'GET') => { const r = await fetch(BASE + path, { method, headers: { 'x-session-id': sid, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j: any = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(j).slice(0, 200)}`); return j; };
const invoice = async (c: string, unit: number, d: string, desc: string) => (await call('/api/transactions/invoices', { invoiceData: { docDate: d, customerId: c, taxSlabId: slab, bankId: bank, notes: '', status: 'Active', amountPaid: 0, items: [{ id: generateId(), description: desc, unitCost: unit, quantity: 1, discountAmount: 0 }] } })).invoiceId as string;
const expense = async (v: string, amount: number, d: string, desc: string, bill: string) => { await call('/api/expenses', { docDate: d, vendorId: v, taxSlabId: slab, bankId: bank, description: desc, billNumber: bill, amount, status: 'Active', type: 'Actual', paymentStatus: 'Unpaid' }); };

// ---- believable data: two months of trading ----
const inv: string[] = [];
inv.push(await invoice(custs[0], 12000, day(34), 'Office partitions - Tower A'), await invoice(custs[1], 4500, day(20), 'Display shelving'), await invoice(custs[0], 8000, day(9), 'Meeting room fit-out'), await invoice(custs[2], 2500, day(3), 'Maintenance contract - Q4'));
await expense(vends[0], 1800, day(25), 'Office supplies', 'ROS-4471'); await expense(vends[1], 950, day(12), 'Electricity - October', 'SEC-9921'); await expense(vends[0], 640, day(4), 'Printer cartridges', 'ROS-4502');
await call('/api/settlements/receipts', { partyId: custs[1], bankId: bank, docDate: day(15), amount: 5175, reference: 'CHQ 20418', allocations: [{ documentType: 'Invoice', documentId: inv[1], amount: 5175 }] });
await call('/api/settlements/receipts', { partyId: custs[0], bankId: bank, docDate: day(6), amount: 10000, reference: 'TT 77012', allocations: [{ documentType: 'Invoice', documentId: inv[0], amount: 7000 }] });
const accts: any[] = (await call('/api/ledger/accounts')).accounts;
const exp = accts.find(a => a.type === 'Expense' && !a.isGroup && a.code === '6200') || accts.find(a => a.type === 'Expense' && !a.isGroup && !a.isControl);
const liab = accts.find(a => a.type === 'Liability' && !a.isGroup && !a.isControl);
await call('/api/ledger/manual-journals', { docDate: day(2), description: 'Accrue November rent', reference: 'LEASE-11', lines: [{ accountId: exp.id, debit: 3500 }, { accountId: liab.id, credit: 3500 }] }).then(async (d: any) => call(`/api/ledger/manual-journals/${d.id}/submit`, {}));
await call('/api/ledger/posting-policy', { maxBackDays: 45, reasonAfterDays: 14 }, 'PUT').catch(() => {});
// an approval rule: vendor payments above 500 need the finance manager's approval; one payment is submitted and waits
const roleId = generateId(); await db.insert(schema.roles).values({ id: roleId, companyId, name: 'Finance Manager', permissions: { approvals: { read: { enabled: true } }, vendorPayments: { read: { enabled: true } } } } as any);
await call('/api/approvals/rules', { name: 'Payments above 500', documentType: 'VendorPayment', minAmount: 500, maxAmount: null, priority: 10, levels: [{ approverType: 'Role', approverRef: roleId }] });
const pendingPay = await call('/api/settlements/payments', { partyId: vends[0], bankId: bank, docDate: day(1), amount: 1000, reference: 'TT 88120', allocations: [] });

// ---- the browser ----
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'chrome', args: ['--no-sandbox', '--disable-gpu'] }).catch(async (e) => { await purgeCompany(companyId); throw e; });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })).newPage();
let n = 0; const done: string[] = [];
const shot = async (name: string, ms = 1200) => { await page.waitForTimeout(ms); const f = `${String(++n).padStart(2, '0')}-${name}.png`; await page.screenshot({ path: `${OUT}/${f}` }); done.push(f); };
const closeOverlays = async () => { for (let i = 0; i < 3; i++) { const x = page.locator('div.fixed.inset-0 button:has(svg.lucide-x)'); if (!(await x.count())) break; await x.last().click({ timeout: 2000 }).catch(() => {}); await page.waitForTimeout(400); } };
const reset = async () => { await closeOverlays(); await page.reload(); await page.waitForTimeout(5000); await page.getByText('CHANGE PASSWORD').count().then(async c => { if (c) await closeOverlays(); }); };
const click = async (text: string) => { await page.getByText(text, { exact: true }).first().click({ timeout: 8000 }); };
const nav = async (group: string | null, item: string) => { try { if (group) { const vis = await page.getByText(item, { exact: true }).first().isVisible().catch(() => false); if (!vis) await click(group); } await click(item); await page.waitForTimeout(900); } catch (e: any) { console.log('nav failed', group, item, e.message.slice(0, 80)); } };

await page.goto(BASE); await page.waitForSelector('input[type=password]', { timeout: 30000 });
await shot('sign-in', 500);
await page.fill('input[type=text]', username); await page.fill('input[type=password]', PW); await page.click('button[type=submit]');
await page.waitForTimeout(5000);
await page.keyboard.press('Escape'); const closeBtn = page.locator('button:has(svg.lucide-x)').first(); if (await page.getByText('CHANGE PASSWORD').count()) await closeBtn.click().catch(() => {});
await shot('dashboard', 2500);

await nav('Chart of Accounts', 'Accounts'); await shot('chart-of-accounts');
await nav(null, 'Account Mapping'); await shot('account-mapping');
await nav('Dimensions', '1 Dimension Types'); await shot('dimension-types');
await nav(null, 'Posting Control'); await shot('posting-control');

await nav('Receivables', 'Receive Payment'); await shot('receive-payment-blank');
try { await page.locator('select').first().selectOption({ label: 'Red Sea Contracting' }); await page.waitForTimeout(800); await page.locator('input[type=number]').first().fill('2875'); await page.getByText('Allocate oldest first').click(); await shot('receive-payment-allocated'); } catch (e: any) { console.log('receive form', e.message.slice(0, 100)); }
await nav('Receivables', 'Receipts'); await shot('receipts-list');
try { await page.locator('tbody tr').first().click(); await page.waitForTimeout(1200); await shot('receipt-detail'); await page.getByText('Print voucher').first().click(); await shot('receipt-voucher-print', 2000); await reset(); } catch (e: any) { console.log('receipt detail', e.message.slice(0, 100)); }
await reset(); await nav('Payables', 'Pay Vendor'); try { await page.locator('select').first().selectOption({ label: 'Riyadh Office Supplies' }); await page.waitForTimeout(800); await page.locator('input[type=number]').first().fill('1000'); await page.getByText('Allocate oldest first').click(); await shot('pay-vendor-allocated'); } catch (e: any) { console.log('pay form', e.message.slice(0, 100)); }
await nav('Payables', 'Vendor Payments'); await shot('vendor-payments-list');

await reset(); await nav('Ledger Reports', 'Receivables Aging'); await shot('receivables-aging');
await nav(null, 'Customer Ledger'); await shot('customer-ledger');
await nav(null, 'Payables Aging'); await shot('payables-aging');
await nav('Journals', 'Journal Listing'); await shot('journal-listing');
try { await page.locator('tbody tr').first().click(); await page.waitForTimeout(1200); await shot('journal-detail'); await page.getByText('Print voucher').first().click(); await shot('journal-voucher-print', 2000); await reset(); } catch (e: any) { console.log('journal detail', e.message.slice(0, 100)); }
await reset(); await nav('Journals', 'New Manual Journal'); await shot('new-manual-journal');
await nav(null, 'Pending Approval'); await shot('pending-approval');
for (const [item, name] of [['Trial Balance (Ledger)', 'trial-balance'], ['Income Statement', 'income-statement'], ['Balance Sheet (Ledger)', 'balance-sheet'], ['Cash Flow Statement', 'cash-flow'], ['Ledger vs Documents', 'ledger-vs-documents'], ['Report Designer', 'report-designer']] as const) { await nav('Ledger Reports', item); await page.getByText('Run', { exact: true }).first().click({ timeout: 1500 }).catch(() => {}); await shot(name, 1800); }

// bank reconciliation: statement lines and clearing through the API, then the real screen
const sess = (await call('/api/bank-reconciliations', { bankId: bank, statementDate: TODAY, statementEndingBalance: 15170.2 })).id as string;
await call(`/api/bank-reconciliations/${sess}/statement-lines`, { lines: [{ date: day(15), description: 'CHEQUE DEPOSIT 20418', amount: 5175 }, { date: day(6), description: 'TRANSFER IN TT 77012', amount: 10000 }, { date: TODAY, description: 'MONTHLY ACCOUNT FEE', amount: -4.8 }] });
await nav(null, 'Bank Reconciliation'); await shot('bank-reconciliation-list');
try { await page.locator('tbody tr').first().click(); await page.waitForTimeout(1500); await shot('bank-reconciliation-session'); } catch (e: any) { console.log('rec session', e.message.slice(0, 100)); }
const d: any = await call(`/api/bank-reconciliations/${sess}`);
await call(`/api/bank-reconciliations/${sess}/clear`, { lineIds: d.lines.map((l: any) => l.lineId) });
for (const sl of d.statementLines.filter((x: any) => x.amount > 0)) { const l = d.lines.find((x: any) => Math.abs(x.debit - x.credit - sl.amount) < 0.005); if (l) await call(`/api/bank-reconciliations/${sess}/match`, { statementLineId: sl.id, journalLineId: l.lineId }); }
await page.reload(); await page.waitForTimeout(4000); await nav(null, 'Bank Reconciliation'); try { await page.locator('tbody tr').first().click(); await page.waitForTimeout(1500); await shot('bank-reconciliation-matched'); } catch { /* keep going */ }
const feeAcct = accts.find(a => a.type === 'Expense' && !a.isGroup && !a.isControl && a.code === '6500') || exp;
const fee = d.statementLines.find((x: any) => x.amount < 0);
await call(`/api/bank-reconciliations/${sess}/adjustment`, { statementLineId: fee.id, accountId: feeAcct.id, description: 'Monthly account fee' });
await call(`/api/bank-reconciliations/${sess}/complete`, {}).catch((e: any) => console.log('complete', e.message.slice(0, 120)));
await page.reload(); await page.waitForTimeout(4000); await nav(null, 'Bank Reconciliation'); try { await page.locator('tbody tr').first().click(); await page.waitForTimeout(1500); await shot('bank-reconciliation-completed'); await page.getByText('Print report').first().click(); await shot('bank-reconciliation-statement-print', 2000); } catch (e: any) { console.log('rec print', e.message.slice(0, 100)); }

await reset(); await nav(null, 'Approval Rules'); await shot('approval-rules');
await nav(null, 'My Approvals'); await shot('my-approvals');
try { await page.locator('tbody tr').last().click(); await page.waitForTimeout(1200); await shot('approval-request'); } catch (e: any) { console.log('approval request', e.message.slice(0, 100)); }
void pendingPay;
await browser.close();
await purgeCompany(companyId);
fs.writeFileSync(`${OUT}/_index.json`, JSON.stringify(done, null, 1));
console.log('captured', done.length, 'screens');
process.exit(0);
