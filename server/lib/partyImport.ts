// Bulk import for Customer Master and Vendor Master — the two tables are near-identical
// (same buyer/ZATCA fields, same validateBuyerFields rules), so this one module drives
// both, parameterized by `entity`. Same design as server/lib/productImport.ts: Validate
// writes nothing, Commit re-validates from scratch and never trusts a client-echoed "this
// row is valid". A bad row never blocks the others in the same file.
import * as XLSX from 'xlsx';
import { eq, and } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { generateId } from '../../src/id.js';
import { getAndIncrementDocumentNumber } from './documentNumbering.js';
import { validateBuyerFields, isValidZatcaVatNumber } from './zatca/validators.js';
import { composeAddressFromZatcaFields } from '../routes/masterEntities.js';

export type PartyEntity = 'customer' | 'vendor';

export const PARTY_IMPORT_MAX_ROWS = 2000;

export const PARTY_TEMPLATE_HEADERS = [
  'Name', 'Buyer Type', 'VAT Number', 'Street Name', 'Building Number', 'District', 'City',
  'Postal Code', 'Phone', 'Email', 'CR Number', 'Country Code',
] as const;

const HEADER_TO_FIELD: Record<string, string> = {
  'name': 'name', 'buyer type': 'buyerType', 'vat number': 'vatNumber', 'street name': 'streetName',
  'building number': 'buildingNumber', 'district': 'district', 'city': 'city', 'postal code': 'postalCode',
  'phone': 'phone', 'email': 'email', 'cr number': 'crNumber', 'country code': 'countryCode',
};

export interface RawPartyRow { rowNumber: number; [field: string]: any; }

export function buildPartyTemplate(entity: PartyEntity): Buffer {
  const wb = XLSX.utils.book_new();
  const exampleRow = entity === 'customer'
    ? ['Al Fahd Trading Est.', 'B2B', '300012345600003', 'King Fahd Road', '3045', 'Al Olaya', 'Riyadh', '12871', '0501234567', 'billing@alfahd.example.com', '1010123456', 'SA']
    : ['Riyadh Supplies Co.', 'B2B', '300098765400003', 'Airport Road', '112', 'Al Malaz', 'Riyadh', '11564', '0559876543', 'ap@riyadhsupplies.example.com', '1010987654', 'SA'];
  const ws = XLSX.utils.aoa_to_sheet([[...PARTY_TEMPLATE_HEADERS], exampleRow]);
  ws['!cols'] = PARTY_TEMPLATE_HEADERS.map(h => ({ wch: Math.max(14, h.length + 2) }));
  XLSX.utils.book_append_sheet(wb, ws, entity === 'customer' ? 'Customers' : 'Vendors');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export function parsePartyWorkbook(buffer: Buffer): { rows: RawPartyRow[]; error?: string } {
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
  if (fieldByColIndex.filter(Boolean).length === 0) {
    return { rows: [], error: `No recognized columns found. Expected headers: ${PARTY_TEMPLATE_HEADERS.join(', ')}.` };
  }

  const rows: RawPartyRow[] = [];
  for (let i = 1; i < aoa.length; i++) {
    const line = aoa[i];
    if (!line || line.every((c: any) => String(c ?? '').trim() === '')) continue;
    const row: RawPartyRow = { rowNumber: i + 1 };
    fieldByColIndex.forEach((field, col) => {
      if (field) row[field] = String(line[col] ?? '').trim();
    });
    rows.push(row);
  }
  return { rows };
}

// Digits-only, last-9 comparison so "0501234567", "+966501234567" and "966 50 123 4567"
// all match as the same number regardless of how the prefix was typed. Returns '' (never
// matches anything) for anything shorter than 7 digits, so a garbage/placeholder value in
// the Phone column can't accidentally collide.
function normalizePhone(raw: string | null | undefined): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 7) return '';
  return digits.slice(-9);
}

export interface ValidatedPartyRow {
  rowNumber: number;
  action: 'create' | 'update' | 'error';
  name: string;
  errors: string[];
  matchedId?: string;
  values?: Record<string, any>;
}

function table(entity: PartyEntity) {
  return entity === 'customer' ? schema.customers : schema.vendors;
}

async function loadLookups(tdb: any, entity: PartyEntity, companyId: string) {
  const t = table(entity);
  const rows = await tdb.select({ id: t.id, name: t.name, vatNumber: t.vatNumber, phone: t.phone })
    .from(t).where(eq(t.companyId, companyId));
  const idByVat = new Map<string, string>();
  const idByPhone = new Map<string, { id: string; name: string }>();
  for (const r of rows) {
    if (r.vatNumber) idByVat.set(r.vatNumber, r.id);
    const np = normalizePhone(r.phone);
    if (np) idByPhone.set(np, { id: r.id, name: r.name });
  }
  return { idByVat, idByPhone };
}

async function resolveRow(
  raw: RawPartyRow,
  idByVat: Map<string, string>,
  idByPhone: Map<string, { id: string; name: string }>,
): Promise<ValidatedPartyRow> {
  const name = String(raw.name || '').trim();

  let buyerType = String(raw.buyerType || '').trim().toUpperCase();
  if (!buyerType) buyerType = 'B2C'; // matches the single-row form's own default
  if (buyerType !== 'B2B' && buyerType !== 'B2C') {
    return { rowNumber: raw.rowNumber, action: 'error', name, errors: ["Buyer Type must be 'B2B' or 'B2C' (or left blank)."] };
  }

  const fieldErrors = validateBuyerFields(buyerType, {
    name,
    vatNumber: raw.vatNumber || null,
    streetName: raw.streetName || null,
    buildingNumber: raw.buildingNumber || null,
    district: raw.district || null,
    city: raw.city || null,
    postalCode: raw.postalCode || null,
  });
  if (fieldErrors.length > 0) {
    return { rowNumber: raw.rowNumber, action: 'error', name, errors: fieldErrors.map(e => e.message) };
  }

  const vat = String(raw.vatNumber || '').trim();
  const hasValidVat = isValidZatcaVatNumber(vat);
  const normalizedPhone = normalizePhone(raw.phone);

  // VAT is authoritative: a matching VAT number always means "same party", full stop — an
  // update, regardless of what the Phone column says. Only when VAT does NOT establish a
  // match (blank, or a genuinely different/new VAT) does phone come into play at all — and
  // even then, only to update a party that ALSO has no VAT on file (or the same blank VAT
  // situation). If phone instead points at a DIFFERENT existing party while this row's VAT
  // is new/different, that is a conflict, not a silent update — see the incident this
  // guards against in the plan discussion: a shared/reused phone number must never cause
  // one company's real B2B record to be silently overwritten by an unrelated row.
  let matchedId: string | undefined;
  if (hasValidVat && idByVat.has(vat)) {
    matchedId = idByVat.get(vat);
  } else if (hasValidVat && normalizedPhone && idByPhone.has(normalizedPhone)) {
    // The row asserts its OWN specific, verifiable identity (a validly-formatted VAT) that
    // doesn't match anything on file — a genuinely new/different party — yet its phone
    // coincides with a DIFFERENT existing record. That mismatch is suspicious enough to flag
    // rather than silently merge; see this function's header comment for the incident this
    // guards against.
    const phoneMatch = idByPhone.get(normalizedPhone)!;
    return {
      rowNumber: raw.rowNumber, action: 'error', name,
      errors: [`Mobile number already exists on '${phoneMatch.name}', but the VAT number is different. Resolve this manually — it was not imported.`],
    };
  } else if (normalizedPhone && idByPhone.has(normalizedPhone)) {
    // No VAT claim on this row at all — phone is the only identifier available, and
    // matching on it is the normal, intended update path (e.g. a repeat B2C customer).
    matchedId = idByPhone.get(normalizedPhone)!.id;
  }

  let address: string | null = null;
  if (buyerType === 'B2B') {
    address = composeAddressFromZatcaFields({
      buildingNumber: raw.buildingNumber, streetName: raw.streetName, district: raw.district,
      city: raw.city, postalCode: raw.postalCode,
    });
  }

  return {
    rowNumber: raw.rowNumber,
    action: matchedId ? 'update' : 'create',
    name,
    errors: [],
    matchedId,
    values: {
      name,
      buyerType,
      vatNumber: vat || null,
      streetName: String(raw.streetName || '').trim() || null,
      buildingNumber: String(raw.buildingNumber || '').trim() || null,
      district: String(raw.district || '').trim() || null,
      city: String(raw.city || '').trim() || null,
      postalCode: String(raw.postalCode || '').trim() || null,
      phone: String(raw.phone || '').trim(),
      email: String(raw.email || '').trim(),
      address: address || '',
      crNumber: String(raw.crNumber || '').trim() || null,
      countryCode: String(raw.countryCode || '').trim() || 'SA',
      isSystem: false,
    },
  };
}

export async function validatePartyRows(tdb: any, entity: PartyEntity, companyId: string, rows: RawPartyRow[]): Promise<ValidatedPartyRow[]> {
  const { idByVat, idByPhone } = await loadLookups(tdb, entity, companyId);
  const results: ValidatedPartyRow[] = [];
  const seenVatInFile = new Map<string, number>();
  const seenPhoneInFile = new Map<string, number>();

  for (const raw of rows) {
    const result = await resolveRow(raw, idByVat, idByPhone);
    if (result.action !== 'error' && result.values) {
      const vat = result.values.vatNumber as string | null;
      const np = normalizePhone(result.values.phone);
      if (vat) {
        const first = seenVatInFile.get(vat);
        if (first !== undefined) {
          result.action = 'error';
          result.errors = [`VAT number also appears on row ${first} in this file.`];
        } else {
          seenVatInFile.set(vat, result.rowNumber);
        }
      } else if (np) {
        // Only checked when there's no VAT to disambiguate by — two rows with the SAME
        // valid, matching VAT are legitimately "the same party mentioned twice", not an
        // error; two rows with no VAT but the same phone are the actual duplicate risk.
        const first = seenPhoneInFile.get(np);
        if (first !== undefined && !result.matchedId) {
          result.action = 'error';
          result.errors = [`Mobile number also appears on row ${first} in this file.`];
        } else {
          seenPhoneInFile.set(np, result.rowNumber);
        }
      }
    }
    results.push(result);
  }
  return results;
}

export interface CommitOutcome { rowNumber: number; name: string; action: 'created' | 'updated' | 'skipped'; reason?: string; }

export async function commitPartyRows(tdb: any, entity: PartyEntity, companyId: string, rows: RawPartyRow[], excludeRowNumbers: Set<number>): Promise<CommitOutcome[]> {
  const validated = await validatePartyRows(tdb, entity, companyId, rows);
  const outcomes: CommitOutcome[] = [];
  const todayIso = new Date().toISOString().slice(0, 10);
  const t = table(entity);
  const codeDocType = entity === 'customer' ? 'customerCode' : 'vendorCode';

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
      if (row.action === 'update' && row.matchedId) {
        await tdb.update(t).set(row.values).where(and(eq(t.id, row.matchedId), eq(t.companyId, companyId)));
        outcomes.push({ rowNumber: row.rowNumber, name: row.name, action: 'updated' });
      } else {
        const id = generateId();
        const code = await getAndIncrementDocumentNumber(tdb, companyId, codeDocType as any, todayIso);
        const record: any = { id, ...row.values, companyId };
        if (entity === 'customer') record.customerCode = code; else record.vendorCode = code;
        await tdb.insert(t).values(record);
        outcomes.push({ rowNumber: row.rowNumber, name: row.name, action: 'created' });
      }
    } catch (err: any) {
      outcomes.push({ rowNumber: row.rowNumber, name: row.name, action: 'skipped', reason: err.message || 'Could not save this row.' });
    }
  }
  return outcomes;
}
