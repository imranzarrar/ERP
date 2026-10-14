// Excel import / export of the chart of accounts (General Ledger Step 1). Same Validate -> preview -> Commit shape as the product and party imports:
// the file is parsed in memory, every row is checked against the company's own chart BEFORE anything is saved, and the accountant sees the result
// and can leave rows out. An import can add accounts and rename existing ones; it can never change a type, a system role, a control flag or a bank link.
import * as XLSX from 'xlsx';
import * as schema from '../../src/db/schema.js';
import { and, eq } from 'drizzle-orm';
import { generateId } from '../../src/id.js';
import { nowDate } from './clock.js';
import { ACCOUNT_TYPES } from './chartOfAccounts.js';

export const CHART_IMPORT_MAX_ROWS = 2000;
export const CHART_TEMPLATE_HEADERS = ['Code', 'Name (English)', 'Name (Arabic)', 'Type', 'Parent Code', 'Heading (Yes/No)'];

const HEADER_TO_FIELD: Record<string, string> = {
  'code': 'code', 'account code': 'code',
  'name (english)': 'name', 'name': 'name', 'account name': 'name', 'name english': 'name',
  'name (arabic)': 'nameAr', 'name arabic': 'nameAr', 'arabic name': 'nameAr',
  'type': 'type', 'account type': 'type',
  'parent code': 'parent', 'parent': 'parent',
  'heading (yes/no)': 'heading', 'heading': 'heading', 'group': 'heading',
};

export interface RawChartRow { rowNumber: number; code?: string; name?: string; nameAr?: string; type?: string; parent?: string; heading?: string }

export function buildChartTemplate(): Buffer {
  const rows = [
    CHART_TEMPLATE_HEADERS,
    ['6000', 'Operating Expenses', 'المصروفات التشغيلية', 'Expense', '', 'Yes'],
    ['6800', 'Marketing and Advertising', 'التسويق والإعلان', 'Expense', '6000', 'No'],
    ['6810', 'Travel', 'السفر', 'Expense', '6000', 'No'],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 10 }, { wch: 34 }, { wch: 30 }, { wch: 12 }, { wch: 12 }, { wch: 16 }];
  const note = XLSX.utils.aoa_to_sheet([
    ['How to fill this sheet'],
    ['Code: letters/digits, up to 12 characters, unique in your chart.'],
    ['Type: Asset, Liability, Equity, Revenue or Expense.'],
    ['Parent Code: the code of a Heading account of the same type (optional).'],
    ['Heading: Yes for a heading that groups accounts and takes no postings; No (or blank) for a normal account.'],
    ['An existing code is only renamed. Types, system roles and bank links are never changed by an import.'],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Chart');
  XLSX.utils.book_append_sheet(wb, note, 'Notes');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export function buildChartExport(accounts: any[], codeById: Map<string, string>): Buffer {
  const rows: any[][] = [[...CHART_TEMPLATE_HEADERS, 'Active', 'System role', 'Control']];
  for (const a of accounts) {
    rows.push([a.code, a.name, a.nameAr || '', a.type, a.parentId ? (codeById.get(a.parentId) || '') : '', a.isGroup ? 'Yes' : 'No', a.isActive ? 'Yes' : 'No', a.systemKey || '', a.isControl ? 'Yes' : 'No']);
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 10 }, { wch: 34 }, { wch: 30 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 8 }, { wch: 26 }, { wch: 9 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Chart');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export function parseChartWorkbook(buffer: Buffer): { rows: RawChartRow[]; error?: string } {
  let wb: XLSX.WorkBook;
  try { wb = XLSX.read(buffer, { type: 'buffer' }); } catch { return { rows: [], error: 'Could not read this file — is it a valid .xlsx or .csv file?' }; }
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { rows: [], error: 'The file has no sheets.' };
  const aoa: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  if (aoa.length === 0) return { rows: [], error: 'The file is empty.' };
  const headerRow = aoa[0].map((h: any) => String(h ?? '').trim().toLowerCase());
  const fieldByCol = headerRow.map(h => HEADER_TO_FIELD[h] ?? null);
  if (!fieldByCol.includes('code') || !fieldByCol.includes('name') || !fieldByCol.includes('type')) {
    return { rows: [], error: `The file needs at least the columns: Code, Name (English), Type. Expected headers: ${CHART_TEMPLATE_HEADERS.join(', ')}.` };
  }
  const rows: RawChartRow[] = [];
  for (let i = 1; i < aoa.length; i++) {
    const line = aoa[i];
    if (!line || line.every((c: any) => String(c ?? '').trim() === '')) continue;
    const row: RawChartRow = { rowNumber: i + 1 };
    fieldByCol.forEach((f, col) => { if (f) (row as any)[f] = String(line[col] ?? '').trim(); });
    rows.push(row);
  }
  return { rows };
}

export interface ValidatedChartRow {
  rowNumber: number; code: string; name: string; action: 'create' | 'update' | 'error'; errors: string[];
  values?: { code: string; name: string; nameAr: string | null; type: string; parentCode: string | null; isGroup: boolean };
  existingId?: string;
}

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9.\-]{0,11}$/;
const normType = (t: string) => ACCOUNT_TYPES.find(x => x.toLowerCase() === t.trim().toLowerCase());

export async function validateChartRows(tx: any, companyId: string, rows: RawChartRow[]): Promise<ValidatedChartRow[]> {
  const existing = await tx.select().from(schema.companyAccounts).where(eq(schema.companyAccounts.companyId, companyId));
  const byCode = new Map<string, any>(existing.map((a: any) => [a.code, a]));
  const seen = new Map<string, number>();
  const fileRows = new Map<string, { type?: string; isGroup: boolean }>();
  for (const r of rows) {
    const code = (r.code || '').trim();
    if (code && CODE_RE.test(code) && !fileRows.has(code)) {
      const heading = /^(yes|y|true|1)$/i.test((r.heading || '').trim());
      fileRows.set(code, { type: normType(r.type || ''), isGroup: heading });
    }
  }
  const out: ValidatedChartRow[] = [];
  for (const r of rows) {
    const errors: string[] = [];
    const code = (r.code || '').trim();
    const name = (r.name || '').trim();
    const nameAr = (r.nameAr || '').trim();
    const type = normType(r.type || '');
    const parentCode = (r.parent || '').trim();
    const isGroup = /^(yes|y|true|1)$/i.test((r.heading || '').trim());
    if (!code) errors.push('Code is required.');
    else if (!CODE_RE.test(code)) errors.push('Code may use letters, digits, "." and "-", up to 12 characters.');
    if (code && seen.has(code)) errors.push(`Code ${code} appears twice in the file (first on row ${seen.get(code)}).`);
    else if (code) seen.set(code, r.rowNumber);
    if (!name) errors.push('Name (English) is required.');
    else if (name.length > 120) errors.push('Name is longer than 120 characters.');
    if (nameAr.length > 120) errors.push('Arabic name is longer than 120 characters.');
    if (!type) errors.push('Type must be Asset, Liability, Equity, Revenue or Expense.');
    const ex = code ? byCode.get(code) : undefined;
    if (ex && type && ex.type !== type) errors.push(`Account ${code} already exists as ${ex.type}; an import never changes a type.`);
    if (ex && ex.isGroup !== isGroup) errors.push(`Account ${code} already exists as ${ex.isGroup ? 'a heading' : 'a normal account'}; an import never changes that.`);
    if (parentCode) {
      if (parentCode === code) errors.push('An account cannot be its own parent.');
      else {
        const fromFile = fileRows.get(parentCode);
        const fromDb = byCode.get(parentCode);
        const parentIsGroup = fromFile ? fromFile.isGroup : fromDb?.isGroup;
        const parentType = fromFile ? fromFile.type : fromDb?.type;
        if (!fromFile && !fromDb) errors.push(`Parent code ${parentCode} was not found in the file or in your chart.`);
        else if (!parentIsGroup) errors.push(`Parent ${parentCode} must be a Heading account.`);
        else if (type && parentType && parentType !== type) errors.push(`Parent ${parentCode} is ${parentType}; its children must be ${parentType} too.`);
      }
    }
    out.push({
      rowNumber: r.rowNumber, code, name, errors, action: errors.length ? 'error' : (ex ? 'update' : 'create'), existingId: ex?.id,
      values: errors.length ? undefined : { code, name, nameAr: nameAr || null, type: type as string, parentCode: parentCode || null, isGroup },
    });
  }
  // A parent chain inside the file must not loop (A under B under A).
  const parentOf = new Map<string, string>();
  for (const v of out) if (v.values?.parentCode) parentOf.set(v.values.code, v.values.parentCode);
  for (const v of out) {
    if (!v.values) continue;
    const trail = new Set<string>([v.values.code]);
    let cur = parentOf.get(v.values.code);
    while (cur) {
      if (trail.has(cur)) { v.errors.push('The parent codes form a loop.'); v.action = 'error'; v.values = undefined; break; }
      trail.add(cur); cur = parentOf.get(cur);
    }
  }
  return out;
}

// Saves the chosen rows. Parents are created before their children whatever the order in the file.
export async function commitChartRows(tx: any, companyId: string, validated: ValidatedChartRow[], includeRowNumbers: Set<number>) {
  const chosen = validated.filter(v => v.values && v.action !== 'error' && includeRowNumbers.has(v.rowNumber));
  const existing = await tx.select().from(schema.companyAccounts).where(eq(schema.companyAccounts.companyId, companyId));
  const idByCode = new Map<string, string>(existing.map((a: any) => [a.code, a.id]));
  let created = 0, updated = 0;
  const pending = [...chosen];
  let guard = pending.length + 5;
  while (pending.length > 0 && guard-- > 0) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const v = pending[i];
      const val = v.values!;
      if (v.action === 'update') {
        await tx.update(schema.companyAccounts).set({ name: val.name, nameAr: val.nameAr }).where(and(eq(schema.companyAccounts.id, v.existingId!), eq(schema.companyAccounts.companyId, companyId)));
        updated++; pending.splice(i, 1); continue;
      }
      let parentId: string | null = null;
      if (val.parentCode) {
        parentId = idByCode.get(val.parentCode) || null;
        if (!parentId) continue; // its parent is created later in this loop
      }
      const id = generateId();
      await tx.insert(schema.companyAccounts).values({
        id, companyId, code: val.code, name: val.name, nameAr: val.nameAr, type: val.type, parentId, isGroup: val.isGroup,
        systemKey: null, isControl: false, bankId: null, isActive: true, createdAt: nowDate(),
      });
      idByCode.set(val.code, id); created++; pending.splice(i, 1);
    }
  }
  return { created, updated, skipped: validated.length - created - updated };
}
