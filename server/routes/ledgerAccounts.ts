// General Ledger Step 1: the company's Chart of Accounts (list, create, edit, deactivate, Excel import / export) and Account Mapping.
// Every route runs on the restricted tenant connection (withTenantDb), so row-level security backs the company filter written in each query, and
// every foreign key a client can name (parent, account) is checked to belong to this company before it is used.
import express from 'express';
import multer from 'multer';
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { generateId } from '../../src/id.js';
import { withTenantDb, tenantDb } from '../lib/tenantDb.js';
import { hasPermission } from '../lib/authz.js';
import { recordAuditLog } from '../lib/audit.js';
import { nowDate } from '../lib/clock.js';
import { ACCOUNT_TYPES, isDebitNormal, EXPENSE_CATEGORIES, EXPENSE_CATEGORY_DEFAULTS } from '../lib/chartOfAccounts.js';
import { accountTotals, branchIdsFor, round2 } from '../lib/ledgerQueries.js';
import {
  CHART_IMPORT_MAX_ROWS, buildChartTemplate, buildChartExport, parseChartWorkbook, validateChartRows, commitChartRows,
} from '../lib/chartImport.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9.\-]{0,11}$/;

const fail = (res: any, status: number, error: string) => res.status(status).json({ error });

async function loadAccount(tdb: any, companyId: string, id: string) {
  const [a] = await tdb.select().from(schema.companyAccounts).where(and(eq(schema.companyAccounts.id, id), eq(schema.companyAccounts.companyId, companyId)));
  return a;
}

// How many posted lines and draft journal lines point at this account: the reason a type can no longer change and a deletion is never offered.
async function usageOf(tdb: any, companyId: string, accountId: string) {
  const totals = await accountTotals(tdb, companyId);
  const t = totals.get(accountId);
  const res: any = await tdb.execute(sql`SELECT COUNT(*)::int AS n FROM manual_journal_lines mjl JOIN manual_journals mj ON mj.id = mjl.journal_id AND mj.company_id = mjl.company_id WHERE mjl.company_id = ${companyId}::uuid AND mjl.account_id = ${accountId}::uuid AND mj.status <> 'Posted'`);
  return { lines: t?.lines || 0, debit: t?.debit || 0, credit: t?.credit || 0, draftLines: Number(res.rows[0]?.n || 0) };
}

// ---- list ----
router.get('/accounts', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'chartOfAccounts.read') && !hasPermission(req.user, 'journals.create') && !hasPermission(req.user, 'accountMapping.read')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb();
    const companyId = req.targetCompanyId;
    const accounts = await tdb.select().from(schema.companyAccounts).where(eq(schema.companyAccounts.companyId, companyId));
    const totals = await accountTotals(tdb, companyId, { branchIds: branchIdsFor(req) });
    const byId = new Map<string, any>(accounts.map((a: any) => [a.id, a]));
    const rows = accounts.map((a: any) => {
      const t = totals.get(a.id) || { debit: 0, credit: 0, lines: 0 };
      const net = round2(t.debit - t.credit);
      return { ...a, debit: round2(t.debit), credit: round2(t.credit), lines: t.lines, net, balance: isDebitNormal(a.type) ? net : -net, parentCode: a.parentId ? byId.get(a.parentId)?.code || null : null };
    });
    // A heading shows the total of everything beneath it.
    const children = new Map<string, any[]>();
    for (const r of rows) if (r.parentId) { const l = children.get(r.parentId) || []; l.push(r); children.set(r.parentId, l); }
    const roll = (r: any): number => r.isGroup ? round2((children.get(r.id) || []).reduce((s, c) => s + roll(c), 0)) : r.balance;
    for (const r of rows) if (r.isGroup) { r.balance = roll(r); r.lines = (children.get(r.id) || []).reduce((s, c) => s + c.lines, 0); }
    const unmapped = totals.get(null);
    rows.sort((a: any, b: any) => a.code.localeCompare(b.code, undefined, { numeric: true }));
    res.json({ accounts: rows, unmappedLines: unmapped?.lines || 0 });
  } catch (e: any) { fail(res, 500, e.message); }
});

// ---- create ----
router.post('/accounts', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'chartOfAccounts.create')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb();
    const companyId = req.targetCompanyId;
    const code = String(req.body?.code ?? '').trim();
    const name = String(req.body?.name ?? '').trim();
    const nameAr = String(req.body?.nameAr ?? '').trim() || null;
    const type = String(req.body?.type ?? '');
    const isGroup = req.body?.isGroup === true;
    if (!CODE_RE.test(code)) return fail(res, 400, 'Code may use letters, digits, "." and "-", up to 12 characters.');
    if (!name) return fail(res, 400, 'Account name (English) is required.');
    if (name.length > 120 || (nameAr && nameAr.length > 120)) return fail(res, 400, 'Names may be up to 120 characters.');
    if (!(ACCOUNT_TYPES as string[]).includes(type)) return fail(res, 400, 'Choose a valid account type.');
    const [dup] = await tdb.select({ id: schema.companyAccounts.id }).from(schema.companyAccounts).where(and(eq(schema.companyAccounts.companyId, companyId), eq(schema.companyAccounts.code, code)));
    if (dup) return fail(res, 400, `Code ${code} is already used by another account.`);
    let parentId: string | null = null;
    if (req.body?.parentId) {
      const parent = await loadAccount(tdb, companyId, String(req.body.parentId));
      if (!parent) return fail(res, 400, 'Invalid parent account.');
      if (!parent.isGroup) return fail(res, 400, 'The parent must be a Heading account.');
      if (parent.type !== type) return fail(res, 400, `The parent is ${parent.type}; an account under it must be ${parent.type} too.`);
      if (!parent.isActive) return fail(res, 400, 'The parent account is inactive.');
      parentId = parent.id;
    }
    const id = generateId();
    await tdb.insert(schema.companyAccounts).values({ id, companyId, code, name, nameAr, type, parentId, isGroup, systemKey: null, isControl: false, bankId: null, isActive: true, createdAt: nowDate() });
    recordAuditLog(req, 'CREATE_ACCOUNT', 'company_account', id, { code, name, type });
    res.json({ success: true, id });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// ---- edit ----
router.put('/accounts/:id', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'chartOfAccounts.update')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb();
    const companyId = req.targetCompanyId;
    const acct = await loadAccount(tdb, companyId, req.params.id);
    if (!acct) return fail(res, 404, 'Account not found.');
    const body = req.body || {};
    const patch: any = {};
    if (body.code !== undefined) {
      const code = String(body.code).trim();
      if (!CODE_RE.test(code)) return fail(res, 400, 'Code may use letters, digits, "." and "-", up to 12 characters.');
      if (code !== acct.code) {
        const [dup] = await tdb.select({ id: schema.companyAccounts.id }).from(schema.companyAccounts).where(and(eq(schema.companyAccounts.companyId, companyId), eq(schema.companyAccounts.code, code)));
        if (dup) return fail(res, 400, `Code ${code} is already used by another account.`);
        patch.code = code;
      }
    }
    if (body.name !== undefined) { const n = String(body.name).trim(); if (!n || n.length > 120) return fail(res, 400, 'Account name (English) is required, up to 120 characters.'); patch.name = n; }
    if (body.nameAr !== undefined) { const n = String(body.nameAr || '').trim(); if (n.length > 120) return fail(res, 400, 'The Arabic name may be up to 120 characters.'); patch.nameAr = n || null; }
    const usage = await usageOf(tdb, companyId, acct.id);
    if (body.type !== undefined && body.type !== acct.type) {
      if (!(ACCOUNT_TYPES as string[]).includes(body.type)) return fail(res, 400, 'Choose a valid account type.');
      if (usage.lines > 0 || usage.draftLines > 0) return fail(res, 400, 'The type cannot change: this account already has postings (or journal drafts).');
      if (acct.systemKey || acct.bankId || acct.isControl) return fail(res, 400, 'The type of a system role or bank account cannot change.');
      const kids = await tdb.select({ id: schema.companyAccounts.id }).from(schema.companyAccounts).where(and(eq(schema.companyAccounts.companyId, companyId), eq(schema.companyAccounts.parentId, acct.id)));
      if (kids.length > 0) return fail(res, 400, 'Move or retype the accounts under this heading first.');
      patch.type = body.type;
    }
    if (body.parentId !== undefined && (body.parentId || null) !== (acct.parentId || null)) {
      if (body.parentId) {
        const parent = await loadAccount(tdb, companyId, String(body.parentId));
        if (!parent) return fail(res, 400, 'Invalid parent account.');
        if (!parent.isGroup) return fail(res, 400, 'The parent must be a Heading account.');
        if (parent.id === acct.id) return fail(res, 400, 'An account cannot be its own parent.');
        if (parent.type !== (patch.type || acct.type)) return fail(res, 400, `The parent is ${parent.type}; an account under it must be ${parent.type} too.`);
        // no loops: walk up from the new parent
        let cur: any = parent; let guard = 0;
        while (cur && guard++ < 50) { if (cur.id === acct.id) return fail(res, 400, 'That would make the chart loop.'); cur = cur.parentId ? await loadAccount(tdb, companyId, cur.parentId) : null; }
        patch.parentId = parent.id;
      } else patch.parentId = null;
    }
    if (Object.keys(patch).length === 0) return res.json({ success: true, unchanged: true });
    await tdb.update(schema.companyAccounts).set(patch).where(and(eq(schema.companyAccounts.id, acct.id), eq(schema.companyAccounts.companyId, companyId)));
    recordAuditLog(req, 'UPDATE_ACCOUNT', 'company_account', acct.id, { before: { code: acct.code, name: acct.name, nameAr: acct.nameAr, type: acct.type }, change: patch });
    res.json({ success: true });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// ---- deactivate / reactivate: "delete" never erases an account ----
router.patch('/accounts/:id/toggle-active', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'chartOfAccounts.delete')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb();
    const companyId = req.targetCompanyId;
    const acct = await loadAccount(tdb, companyId, req.params.id);
    if (!acct) return fail(res, 404, 'Account not found.');
    if (acct.isActive) {
      if (acct.systemKey) return fail(res, 400, 'This account is the posting account of a system role (see Account Mapping). Point the role at another account first.');
      if (acct.isControl && !acct.bankId) return fail(res, 400, 'A control account cannot be deactivated.');
      if (acct.bankId) {
        const [bank] = await tdb.select({ isActive: schema.bankAccounts.isActive }).from(schema.bankAccounts).where(and(eq(schema.bankAccounts.id, acct.bankId), eq(schema.bankAccounts.companyId, companyId)));
        if (bank?.isActive !== false) return fail(res, 400, 'Deactivate the bank account first; its ledger account follows.');
      }
      const mapped = await tdb.select({ category: schema.expenseCategoryAccounts.category }).from(schema.expenseCategoryAccounts).where(and(eq(schema.expenseCategoryAccounts.companyId, companyId), eq(schema.expenseCategoryAccounts.accountId, acct.id)));
      if (mapped.length > 0) return fail(res, 400, `Expense category "${mapped[0].category}" posts to this account. Change it in Account Mapping first.`);
      const kids = await tdb.select({ isActive: schema.companyAccounts.isActive }).from(schema.companyAccounts).where(and(eq(schema.companyAccounts.companyId, companyId), eq(schema.companyAccounts.parentId, acct.id)));
      if (kids.some((k: any) => k.isActive)) return fail(res, 400, 'Deactivate the accounts under this heading first.');
      const usage = await usageOf(tdb, companyId, acct.id);
      if (Math.abs(round2(usage.debit - usage.credit)) > 0.001) return fail(res, 400, 'An account can only be deactivated when its balance is zero.');
      if (usage.draftLines > 0) return fail(res, 400, 'A journal that is not yet posted still uses this account.');
    } else if (acct.parentId) {
      const parent = await loadAccount(tdb, companyId, acct.parentId);
      if (parent && !parent.isActive) return fail(res, 400, 'Reactivate the parent heading first.');
    }
    await tdb.update(schema.companyAccounts).set({ isActive: !acct.isActive }).where(and(eq(schema.companyAccounts.id, acct.id), eq(schema.companyAccounts.companyId, companyId)));
    recordAuditLog(req, acct.isActive ? 'DEACTIVATE_ACCOUNT' : 'REACTIVATE_ACCOUNT', 'company_account', acct.id, { code: acct.code, name: acct.name });
    res.json({ success: true, isActive: !acct.isActive });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// ---- Excel export / import ----
router.get('/accounts/export', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'chartOfAccounts.export')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb();
    const accounts = await tdb.select().from(schema.companyAccounts).where(eq(schema.companyAccounts.companyId, req.targetCompanyId));
    accounts.sort((a: any, b: any) => a.code.localeCompare(b.code, undefined, { numeric: true }));
    const buf = buildChartExport(accounts, new Map(accounts.map((a: any) => [a.id, a.code])));
    recordAuditLog(req, 'EXPORT_CHART', 'company_account', null, { accounts: accounts.length });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="chart-of-accounts.xlsx"');
    res.send(buf);
  } catch (e: any) { fail(res, 500, e.message); }
});

router.get('/accounts/import/template', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'chartOfAccounts.import')) return fail(res, 403, 'Forbidden');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="chart-of-accounts-template.xlsx"');
    res.send(buildChartTemplate());
  } catch (e: any) { fail(res, 500, e.message); }
});

function readUpload(req: any, res: any) {
  if (!req.file) { fail(res, 400, 'No file uploaded.'); return null; }
  const { rows, error } = parseChartWorkbook(req.file.buffer);
  if (error) { fail(res, 400, error); return null; }
  if (rows.length === 0) { fail(res, 400, 'No data rows found in the file.'); return null; }
  if (rows.length > CHART_IMPORT_MAX_ROWS) { fail(res, 400, `The file has ${rows.length} rows; the limit is ${CHART_IMPORT_MAX_ROWS}.`); return null; }
  return rows;
}

router.post('/accounts/import/validate', withTenantDb, upload.single('file'), async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'chartOfAccounts.import')) return fail(res, 403, 'Forbidden');
    const rows = readUpload(req, res); if (!rows) return;
    const result = await validateChartRows(tenantDb(), req.targetCompanyId, rows);
    res.json({
      summary: { totalRows: result.length, toCreate: result.filter(r => r.action === 'create').length, toUpdate: result.filter(r => r.action === 'update').length, errors: result.filter(r => r.action === 'error').length },
      rows: result.map(r => ({ rowNumber: r.rowNumber, name: `${r.code} · ${r.name}`, action: r.action, errors: r.errors })),
    });
  } catch (e: any) { fail(res, 500, e.message); }
});

router.post('/accounts/import/commit', withTenantDb, upload.single('file'), async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'chartOfAccounts.import')) return fail(res, 403, 'Forbidden');
    const rows = readUpload(req, res); if (!rows) return;
    let include: number[] = [];
    try { include = JSON.parse(String(req.body?.include || '[]')); } catch { return fail(res, 400, 'Invalid selection.'); }
    const tdb = tenantDb();
    // Checked again here, from the uploaded file itself: the preview is never trusted.
    const validated = await validateChartRows(tdb, req.targetCompanyId, rows);
    const out = await commitChartRows(tdb, req.targetCompanyId, validated, new Set(include.map(Number)));
    recordAuditLog(req, 'IMPORT_CHART', 'company_account', null, out);
    res.json({ summary: out, rows: validated.map(v => ({ rowNumber: v.rowNumber, name: `${v.code} · ${v.name}`, action: v.action === 'error' || !include.map(Number).includes(v.rowNumber) ? 'skipped' : (v.action === 'update' ? 'updated' : 'created'), reason: v.errors[0] })) });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

// ---- Account Mapping ----
const ROLE_LABELS: Record<string, { label: string; usedBy: string; group: string; required: boolean }> = {
  SALES_REVENUE: { label: 'Sales revenue', usedBy: 'Invoices, POS, credit notes', group: 'Sales and POS', required: true },
  AR: { label: 'Receivable', usedBy: 'Invoices, receipts, credit notes', group: 'Sales and POS', required: false },
  VAT_OUTPUT: { label: 'VAT output', usedBy: 'Invoices, credit notes', group: 'Sales and POS', required: false },
  INVENTORY: { label: 'Inventory', usedBy: 'Goods receipts, sales, returns', group: 'Purchasing and inventory', required: false },
  GR_IR_CLEARING: { label: 'Goods received not invoiced', usedBy: 'Goods receipts, bills', group: 'Purchasing and inventory', required: false },
  AP: { label: 'Payable', usedBy: 'Bills, expenses, payments', group: 'Purchasing and inventory', required: false },
  VAT_INPUT: { label: 'VAT input', usedBy: 'Bills, expenses, returns', group: 'Purchasing and inventory', required: false },
  VENDOR_CREDIT_RECEIVABLE: { label: 'Vendor credit receivable', usedBy: 'Purchase returns, vendor refunds', group: 'Purchasing and inventory', required: false },
  COGS: { label: 'Cost of goods sold', usedBy: 'Sales, stock revaluation', group: 'Purchasing and inventory', required: true },
  DIRECT_OPEX: { label: 'Default expense', usedBy: 'Expenses with no account of their own', group: 'Expenses', required: true },
  FIXED_ASSETS: { label: 'Fixed assets', usedBy: 'Expenses classified as assets', group: 'Expenses', required: false },
  BANK: { label: 'Bank / cash (not allocated)', usedBy: 'Receipts and payments with no bank named', group: 'Banks, capital and tax', required: false },
  PAID_IN_CAPITAL: { label: 'Owner capital', usedBy: 'Investors and capital', group: 'Banks, capital and tax', required: true },
  RETAINED_EARNINGS: { label: 'Retained earnings', usedBy: 'Period close', group: 'Banks, capital and tax', required: false },
  VAT_PAYABLE_TO_AUTHORITY: { label: 'VAT payable to authority', usedBy: 'VAT return settlement', group: 'Banks, capital and tax', required: false },
  ROUNDING_ADJUSTMENT: { label: 'Rounding', usedBy: 'Totals with rounding', group: 'Banks, capital and tax', required: true },
};
// Roles whose account is a control account (documents post to them; nothing is entered by hand).
const CONTROL_ROLES = new Set(['BANK', 'AR', 'INVENTORY', 'VAT_INPUT', 'VENDOR_CREDIT_RECEIVABLE', 'GR_IR_CLEARING', 'AP', 'VAT_OUTPUT', 'VAT_PAYABLE_TO_AUTHORITY']);

router.get('/mapping', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'accountMapping.read')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb();
    const companyId = req.targetCompanyId;
    const [accounts, sysAccounts, catRows, banks] = await Promise.all([
      tdb.select().from(schema.companyAccounts).where(eq(schema.companyAccounts.companyId, companyId)),
      tdb.select().from(schema.systemAccounts),
      tdb.select().from(schema.expenseCategoryAccounts).where(eq(schema.expenseCategoryAccounts.companyId, companyId)),
      tdb.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, companyId)),
    ]);
    const byKey = new Map<string, any>(accounts.filter((a: any) => a.systemKey).map((a: any) => [a.systemKey, a]));
    const roles = sysAccounts.map((s: any) => {
      const meta = ROLE_LABELS[s.key] || { label: s.name, usedBy: '', group: 'Other', required: false };
      return { key: s.key, label: meta.label, usedBy: meta.usedBy, group: meta.group, required: meta.required, type: s.type, control: CONTROL_ROLES.has(s.key), accountId: byKey.get(s.key)?.id || null };
    });
    const catMap = new Map<string, string>(catRows.map((c: any) => [c.category, c.accountId]));
    const categories = EXPENSE_CATEGORIES.map(c => ({ category: c, accountId: catMap.get(c) || null }));
    const accountByBank = new Map<string, any>(accounts.filter((a: any) => a.bankId).map((a: any) => [a.bankId, a]));
    const bankRows = banks.map((b: any) => ({ bankId: b.id, bankName: b.bankName, accountId: accountByBank.get(b.id)?.id || null, isActive: b.isActive !== false }));
    res.json({ roles, categories, banks: bankRows, accounts: accounts.map((a: any) => ({ id: a.id, code: a.code, name: a.name, nameAr: a.nameAr, type: a.type, isGroup: a.isGroup, isActive: a.isActive, isControl: a.isControl, systemKey: a.systemKey, bankId: a.bankId })) });
  } catch (e: any) { fail(res, 500, e.message); }
});

// Point a posting role at another account. Applies to postings made from now on: every journal line stores its account when it is posted.
router.put('/mapping/role', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'accountMapping.update')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb();
    const companyId = req.targetCompanyId;
    const key = String(req.body?.key || '');
    const [role] = await tdb.select().from(schema.systemAccounts).where(eq(schema.systemAccounts.key, key));
    if (!role) return fail(res, 400, 'Unknown posting role.');
    const target = await loadAccount(tdb, companyId, String(req.body?.accountId || ''));
    if (!target) return fail(res, 400, 'Invalid account.');
    if (target.isGroup) return fail(res, 400, 'A heading cannot take postings. Choose a normal account.');
    if (!target.isActive) return fail(res, 400, 'That account is inactive.');
    if (target.type !== role.type) return fail(res, 400, `This role needs a ${role.type} account; ${target.code} is ${target.type}.`);
    if (target.bankId) return fail(res, 400, 'A bank account takes the postings of its own bank only.');
    if (target.systemKey && target.systemKey !== key) return fail(res, 400, `${target.code} is already the account of another role (${target.systemKey}).`);
    const [current] = await tdb.select().from(schema.companyAccounts).where(and(eq(schema.companyAccounts.companyId, companyId), eq(schema.companyAccounts.systemKey, key)));
    if (current && current.id === target.id) return res.json({ success: true, unchanged: true });
    if (current) await tdb.update(schema.companyAccounts).set({ systemKey: null, isControl: false }).where(and(eq(schema.companyAccounts.id, current.id), eq(schema.companyAccounts.companyId, companyId)));
    await tdb.update(schema.companyAccounts).set({ systemKey: key, isControl: CONTROL_ROLES.has(key) }).where(and(eq(schema.companyAccounts.id, target.id), eq(schema.companyAccounts.companyId, companyId)));
    recordAuditLog(req, 'CHANGE_ACCOUNT_MAPPING', 'company_account', target.id, { role: key, from: current?.code || null, to: target.code });
    res.json({ success: true });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

router.put('/mapping/category', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'accountMapping.update')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb();
    const companyId = req.targetCompanyId;
    const category = String(req.body?.category || '');
    if (!EXPENSE_CATEGORIES.includes(category)) return fail(res, 400, 'Unknown expense category.');
    const target = await loadAccount(tdb, companyId, String(req.body?.accountId || ''));
    if (!target) return fail(res, 400, 'Invalid account.');
    if (target.isGroup || !target.isActive) return fail(res, 400, 'Choose an active, normal account.');
    if (target.type !== 'Expense') return fail(res, 400, 'An expense category posts to an Expense account.');
    if (target.isControl || target.bankId) return fail(res, 400, 'A control account cannot be used here.');
    if (target.systemKey && target.systemKey !== 'DIRECT_OPEX') return fail(res, 400, 'That account belongs to another posting role.');
    const [existing] = await tdb.select().from(schema.expenseCategoryAccounts).where(and(eq(schema.expenseCategoryAccounts.companyId, companyId), eq(schema.expenseCategoryAccounts.category, category)));
    if (existing) {
      if (existing.accountId === target.id) return res.json({ success: true, unchanged: true });
      await tdb.update(schema.expenseCategoryAccounts).set({ accountId: target.id, updatedAt: nowDate(), updatedById: req.user.id }).where(and(eq(schema.expenseCategoryAccounts.id, existing.id), eq(schema.expenseCategoryAccounts.companyId, companyId)));
    } else {
      await tdb.insert(schema.expenseCategoryAccounts).values({ id: generateId(), companyId, category, accountId: target.id, updatedAt: nowDate(), updatedById: req.user.id });
    }
    recordAuditLog(req, 'CHANGE_ACCOUNT_MAPPING', 'expense_category_account', target.id, { category, to: target.code });
    res.json({ success: true });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

export default router;
export { EXPENSE_CATEGORY_DEFAULTS };
