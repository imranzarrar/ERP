// Bulk import for the Product/Service master (server/routes/masterImport.ts). Every rule
// here is the SAME rule POST /products (masterEntities.ts) already enforces for a single
// row — this file does not invent a second, parallel set of business rules; it reuses the
// same validation shape so the two paths can never quietly drift apart.
//
// Design:
//   1. parseWorkbook() reads the uploaded .xlsx/.csv into plain row objects.
//   2. validateRows() checks every row against the company's own categories/barcodes and
//      returns a per-row outcome (create / update / error) — never writes anything.
//   3. commitRows() re-validates (never trusts a client-echoed "this row is valid") and
//      inserts/updates only the rows that are still valid and not excluded by the caller.
// A bad row is skipped, not fatal to the whole file — the caller sees exactly which rows
// failed and why.
import * as XLSX from 'xlsx';
import { eq, and, inArray } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { generateId } from '../../src/id.js';
import { getAndIncrementDocumentNumber } from './documentNumbering.js';

export const PRODUCT_IMPORT_MAX_ROWS = 2000;

export const PRODUCT_TEMPLATE_HEADERS = [
  'Name', 'Selling Price', 'Description', 'Cost Price', 'Item Kind', 'Sales/Purchase',
  'Unit', 'Category', 'Barcode', 'Min Stock Level', 'Max Stock Level', 'Reorder Lead Time', 'Active',
] as const;

const HEADER_TO_FIELD: Record<string, string> = {
  'name': 'name', 'selling price': 'unitPrice', 'description': 'description', 'cost price': 'costPrice',
  'item kind': 'itemKind', 'sales/purchase': 'salesPurchaseFlow', 'unit': 'unit', 'category': 'category',
  'barcode': 'barcode', 'min stock level': 'minLevel', 'max stock level': 'maxLevel',
  'reorder lead time': 'reorderLeadTime', 'active': 'isActive',
};

export interface RawProductRow { rowNumber: number; [field: string]: any; }

export function buildProductTemplate(): Buffer {
  const wb = XLSX.utils.book_new();
  const exampleRow = ['Afia Oil 1L', '12.50', 'Cooking oil, 1 litre bottle', '9.00', 'item', 'Both', 'PCE', 'Groceries', '6281234567890', '10', '200', '3 days', 'Yes'];
  const ws = XLSX.utils.aoa_to_sheet([[...PRODUCT_TEMPLATE_HEADERS], exampleRow]);
  ws['!cols'] = PRODUCT_TEMPLATE_HEADERS.map(h => ({ wch: Math.max(14, h.length + 2) }));
  XLSX.utils.book_append_sheet(wb, ws, 'Products');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// Parses the uploaded file into row objects keyed by our internal field names (not the
// display headers) — case/whitespace-insensitive header matching so "selling price" and
// " Selling Price " both work, but the SET of headers must still match the template
// (flexible column-mapping for a user's own differently-shaped spreadsheet is a later
// version, not this one).
export function parseWorkbook(buffer: Buffer): { rows: RawProductRow[]; error?: string } {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch {
    return { rows: [], error: 'Could not read this file — is it a valid .xlsx or .csv file?' };
  }
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { rows: [], error: 'The file has no sheets.' };
  const aoa: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  if (aoa.length === 0) return { rows: [], error: 'The file is empty.' };

  const headerRow = aoa[0].map((h: any) => String(h ?? '').trim().toLowerCase());
  const fieldByColIndex: (string | null)[] = headerRow.map(h => HEADER_TO_FIELD[h] ?? null);
  const recognized = fieldByColIndex.filter(Boolean).length;
  if (recognized === 0) {
    return { rows: [], error: `No recognized columns found. Expected headers: ${PRODUCT_TEMPLATE_HEADERS.join(', ')}.` };
  }

  const rows: RawProductRow[] = [];
  for (let i = 1; i < aoa.length; i++) {
    const line = aoa[i];
    if (!line || line.every((c: any) => String(c ?? '').trim() === '')) continue; // skip blank rows
    const row: RawProductRow = { rowNumber: i + 1 }; // spreadsheet row number (1 = header)
    fieldByColIndex.forEach((field, col) => {
      if (field) row[field] = String(line[col] ?? '').trim();
    });
    rows.push(row);
  }
  return { rows };
}

export interface ValidatedProductRow {
  rowNumber: number;
  action: 'create' | 'update' | 'error';
  name: string;
  errors: string[];
  matchedProductId?: string; // set when action === 'update'
  values?: Record<string, any>; // the resolved, ready-to-insert values (only when not 'error')
}

function toNumberOrUndefined(v: any): number | undefined | null {
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null; // null = "was given but not a valid number"
}

// Re-usable by both validateRows (preview) and commitRows (re-validates from scratch,
// exactly like the preview did, rather than trusting anything the client echoed back).
async function resolveRow(tdb: any, companyId: string, raw: RawProductRow, categoryIdByName: Map<string, string>, productIdByBarcode: Map<string, string>): Promise<ValidatedProductRow> {
  const errors: string[] = [];
  const name = String(raw.name || '').trim();
  if (!name) errors.push('Name is required.');

  const unitPrice = toNumberOrUndefined(raw.unitPrice);
  if (unitPrice === undefined) errors.push('Selling Price is required.');
  else if (unitPrice === null || unitPrice < 0) errors.push('Selling Price must be a number, 0 or more.');

  const costPrice = toNumberOrUndefined(raw.costPrice);
  if (costPrice === null) errors.push('Cost Price must be a number, 0 or more, if given.');

  let itemKind = String(raw.itemKind || '').trim().toLowerCase();
  if (!itemKind) itemKind = 'item';
  if (itemKind !== 'item' && itemKind !== 'service') errors.push("Item Kind must be 'item' or 'service' (or left blank).");

  const flowRaw = String(raw.salesPurchaseFlow || '').trim().toLowerCase();
  let salesPurchaseFlow = 0;
  if (flowRaw === '' || flowRaw === 'both') salesPurchaseFlow = 0;
  else if (flowRaw === 'sales') salesPurchaseFlow = 1;
  else if (flowRaw === 'purchase') salesPurchaseFlow = 2;
  else errors.push("Sales/Purchase must be 'Both', 'Sales', or 'Purchase' (or left blank).");

  const minLevel = toNumberOrUndefined(raw.minLevel);
  if (minLevel === null) errors.push('Min Stock Level must be a number, 0 or more, if given.');
  const maxLevel = toNumberOrUndefined(raw.maxLevel);
  if (maxLevel === null) errors.push('Max Stock Level must be a number, 0 or more, if given.');

  const activeRaw = String(raw.isActive ?? '').trim().toLowerCase();
  let isActive = true;
  if (['no', 'false', '0', 'inactive'].includes(activeRaw)) isActive = false;
  else if (activeRaw !== '' && !['yes', 'true', '1', 'active'].includes(activeRaw)) {
    errors.push("Active must be 'Yes' or 'No' (or left blank).");
  }

  let categoryId: string | null = null;
  const categoryName = String(raw.category || '').trim();
  if (categoryName) {
    const found = categoryIdByName.get(categoryName.toLowerCase());
    if (!found) errors.push(`Category '${categoryName}' was not found. Create it first, or leave this column blank.`);
    else categoryId = found;
  }

  const barcode = String(raw.barcode || '').trim();
  const matchedProductId = barcode ? productIdByBarcode.get(barcode) : undefined;

  if (errors.length > 0) {
    return { rowNumber: raw.rowNumber, action: 'error', name, errors };
  }

  return {
    rowNumber: raw.rowNumber,
    action: matchedProductId ? 'update' : 'create',
    name,
    errors: [],
    matchedProductId,
    values: {
      name,
      description: String(raw.description || '').trim(),
      unitPrice: String(unitPrice),
      costPrice: costPrice === undefined ? null : String(costPrice),
      itemKind,
      salesPurchaseFlow,
      // Matches the manual "Add Product" form's own default (MasterEntities.tsx's prodUnit
      // state) — a blank cell isn't "no unit", it's "didn't bother overriding the default".
      unit: String(raw.unit || '').trim() || 'PCE',
      categoryId,
      barcode: barcode || null,
      minLevel: minLevel === undefined ? null : String(minLevel),
      maxLevel: maxLevel === undefined ? null : String(maxLevel),
      reorderLeadTime: String(raw.reorderLeadTime || '').trim() || null,
      isActive,
      companyId,
    },
  };
}

async function loadLookups(tdb: any, companyId: string) {
  const categories = await tdb.select({ id: schema.productCategories.id, name: schema.productCategories.name })
    .from(schema.productCategories).where(eq(schema.productCategories.companyId, companyId));
  const categoryIdByName = new Map<string, string>(categories.map((c: any) => [c.name.toLowerCase(), c.id]));

  const withBarcode = await tdb.select({ id: schema.productsServices.id, barcode: schema.productsServices.barcode })
    .from(schema.productsServices).where(eq(schema.productsServices.companyId, companyId));
  const productIdByBarcode = new Map<string, string>(
    withBarcode.filter((p: any) => p.barcode).map((p: any) => [p.barcode as string, p.id])
  );
  return { categoryIdByName, productIdByBarcode };
}

export async function validateProductRows(tdb: any, companyId: string, rows: RawProductRow[]): Promise<ValidatedProductRow[]> {
  const { categoryIdByName, productIdByBarcode } = await loadLookups(tdb, companyId);
  const results: ValidatedProductRow[] = [];
  const seenBarcodesInFile = new Map<string, number>(); // barcode -> first row number, catches duplicates WITHIN the file itself
  for (const raw of rows) {
    const result = await resolveRow(tdb, companyId, raw, categoryIdByName, productIdByBarcode);
    if (result.values?.barcode) {
      const first = seenBarcodesInFile.get(result.values.barcode);
      if (first !== undefined) {
        result.action = 'error';
        result.errors = [`Barcode also appears on row ${first} in this file.`];
      } else {
        seenBarcodesInFile.set(result.values.barcode, result.rowNumber);
      }
    }
    results.push(result);
  }
  return results;
}

export interface CommitOutcome { rowNumber: number; name: string; action: 'created' | 'updated' | 'skipped'; reason?: string; }

// Inserts/updates the still-valid, non-excluded rows. Runs inside the caller's own
// withTenantDb transaction (no separate db.transaction() wrapper needed, same convention
// as every other route in this file) — a row that fails here is recorded as skipped, never
// thrown, so it can't roll back the rows that already succeeded.
export async function commitProductRows(tdb: any, companyId: string, rows: RawProductRow[], excludeRowNumbers: Set<number>): Promise<CommitOutcome[]> {
  const validated = await validateProductRows(tdb, companyId, rows);
  const outcomes: CommitOutcome[] = [];
  const todayIso = new Date().toISOString().slice(0, 10);

  for (const row of validated) {
    if (excludeRowNumbers.has(row.rowNumber)) {
      outcomes.push({ rowNumber: row.rowNumber, name: row.name, action: 'skipped', reason: 'excluded by user' });
      continue;
    }
    if (row.action === 'error') {
      outcomes.push({ rowNumber: row.rowNumber, name: row.name, action: 'skipped', reason: row.errors.join(' ') });
      continue;
    }
    try {
      if (row.action === 'update' && row.matchedProductId) {
        await tdb.update(schema.productsServices).set(row.values).where(and(
          eq(schema.productsServices.id, row.matchedProductId), eq(schema.productsServices.companyId, companyId),
        ));
        outcomes.push({ rowNumber: row.rowNumber, name: row.name, action: 'updated' });
      } else {
        const id = generateId();
        const sku = await getAndIncrementDocumentNumber(tdb, companyId, 'sku', todayIso);
        await tdb.insert(schema.productsServices).values({ id, sku, ...row.values });
        outcomes.push({ rowNumber: row.rowNumber, name: row.name, action: 'created' });
      }
    } catch (err: any) {
      outcomes.push({ rowNumber: row.rowNumber, name: row.name, action: 'skipped', reason: err.message || 'Could not save this row.' });
    }
  }
  return outcomes;
}
