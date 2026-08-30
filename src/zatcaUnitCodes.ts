// ZATCA's UBL invoices require <cbc:InvoicedQuantity unitCode="..."> to be a valid
// UN/ECE Recommendation 20 code (the same standard code list used across EN16931/PEPPOL
// e-invoicing generally — ZATCA does not define its own separate unit-code list). This is
// a curated, well-established common subset covering typical trading/fabrication/service
// use — NOT the full multi-thousand-entry official Rec 20 list, which this project does
// not have a bundled machine-readable copy of (checked tools/zatca-sdk/Data/ — it ships
// XSDs and sample invoices, not a Rec 20 codelist file). If a business needs a unit not in
// this list, verify the exact code against ZATCA's official technical resources or UN/ECE
// Recommendation 20 Annex III before adding it here — do not guess a code and ship it,
// since an invalid unitCode is a real ZATCA submission rejection, not a cosmetic issue.
export interface ZatcaUnitCode {
  code: string;
  label: string; // human-readable, for the picker UI
  category: 'Count' | 'Weight' | 'Length' | 'Area' | 'Volume' | 'Time';
}

export const ZATCA_UNIT_CODES: ZatcaUnitCode[] = [
  // Count
  { code: 'PCE', label: 'Piece', category: 'Count' },
  { code: 'C62', label: 'Unit / Each', category: 'Count' },
  { code: 'SET', label: 'Set', category: 'Count' },
  { code: 'PR', label: 'Pair', category: 'Count' },
  { code: 'DZN', label: 'Dozen', category: 'Count' },
  // Weight
  { code: 'KGM', label: 'Kilogram', category: 'Weight' },
  { code: 'GRM', label: 'Gram', category: 'Weight' },
  { code: 'MGM', label: 'Milligram', category: 'Weight' },
  { code: 'TNE', label: 'Tonne (metric)', category: 'Weight' },
  // Length
  { code: 'MTR', label: 'Metre', category: 'Length' },
  { code: 'CMT', label: 'Centimetre', category: 'Length' },
  { code: 'MMT', label: 'Millimetre', category: 'Length' },
  { code: 'KMT', label: 'Kilometre', category: 'Length' },
  // Area
  { code: 'MTK', label: 'Square Metre', category: 'Area' },
  // Volume
  { code: 'MTQ', label: 'Cubic Metre', category: 'Volume' },
  { code: 'LTR', label: 'Litre', category: 'Volume' },
  { code: 'MLT', label: 'Millilitre', category: 'Volume' },
  // Time
  { code: 'HUR', label: 'Hour', category: 'Time' },
  { code: 'DAY', label: 'Day', category: 'Time' },
  { code: 'WEE', label: 'Week', category: 'Time' },
  { code: 'MON', label: 'Month', category: 'Time' },
  { code: 'ANN', label: 'Year', category: 'Time' },
];

export const ZATCA_UNIT_CODE_SET = new Set(ZATCA_UNIT_CODES.map(u => u.code));

export function isValidZatcaUnitCode(code: string | undefined | null): boolean {
  return !!code && ZATCA_UNIT_CODE_SET.has(code);
}

// Used at the ZATCA XML-generation boundary (defense in depth, same reasoning as
// validateBuyerFields elsewhere in this codebase): a line item's stored `unit` can be
// missing (legacy rows created before this column existed), or one of the two special
// non-ZATCA-code placeholder values the Product form's Unit-of-Measure picker offers
// ('No' = None/Default, 'Lumpsum' = not a per-unit quantity at all) — ZATCA always
// requires *some* valid unitCode, so all of those fall back to PCE (piece), the same
// default this pipeline already used everywhere before per-item units existed.
export function normalizeZatcaUnitCode(unit: string | undefined | null): string {
  if (unit && isValidZatcaUnitCode(unit)) return unit;
  return 'PCE';
}
