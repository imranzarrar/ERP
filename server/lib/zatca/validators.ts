// Shared ZATCA field-format validation — used both for company taxpayer identity
// (before CSR/OTP calls, so a malformed value is caught before burning part of a
// ~1-hour OTP window) and for customer/vendor buyer records (before they can be
// attached to a real ZATCA invoice). Formats are ZATCA's documented requirements,
// not guesses: VAT is exactly 15 digits starting with '3'; postal code is 5 digits.

export interface FieldError {
  field: string;
  message: string;
}

// Confirmed directly against a real ZATCA sandbox rejection (BR-KSA-44): the FIRST
// *and* LAST digit must both be '3', not just the first — a stricter rule than the
// commonly-quoted "15 digits starting with 3", and easy to get wrong without a live
// rejection to check against.
export function isValidZatcaVatNumber(vat: string | null | undefined): boolean {
  return typeof vat === 'string' && /^3\d{13}3$/.test(vat.trim());
}

export function isValidPostalCode(code: string | null | undefined): boolean {
  return typeof code === 'string' && /^\d{5}$/.test(code.trim());
}

// Company taxpayer identity — required for every environment before a CSR is generated,
// since these values are embedded directly in the CSR itself (BS: KSA-CSR fields) and a
// mistake here is only discoverable after ZATCA rejects the compliance/OTP exchange.
export function validateTaxpayerIdentity(fields: {
  tinNumber?: string | null;
  crNumber?: string | null;
  streetName?: string | null;
  buildingNumber?: string | null;
  district?: string | null;
  city?: string | null;
  postalCode?: string | null;
}): FieldError[] {
  const errors: FieldError[] = [];
  if (!isValidZatcaVatNumber(fields.tinNumber)) {
    errors.push({ field: 'tinNumber', message: 'VAT/TIN number must be exactly 15 digits, starting and ending with 3.' });
  }
  if (!fields.crNumber?.trim()) {
    errors.push({ field: 'crNumber', message: 'Commercial Registration (CR) number is required.' });
  }
  if (!fields.streetName?.trim()) {
    errors.push({ field: 'streetName', message: 'Street name is required.' });
  }
  if (!fields.buildingNumber?.trim()) {
    errors.push({ field: 'buildingNumber', message: 'Building number is required.' });
  }
  if (!fields.district?.trim()) {
    errors.push({ field: 'district', message: 'District is required.' });
  }
  if (!fields.city?.trim()) {
    errors.push({ field: 'city', message: 'City is required.' });
  }
  if (!isValidPostalCode(fields.postalCode)) {
    errors.push({ field: 'postalCode', message: 'Postal code must be exactly 5 digits.' });
  }
  return errors;
}

// Customer/vendor buyer records — mandatory fields differ by ZATCA invoice type:
// Standard (B2B) needs a full, verifiable buyer identity for a valid
// AccountingCustomerParty; Simplified (B2C) only needs a name (a real walk-in sale
// often has no VAT/address on file, and ZATCA's own rules don't require it there).
export function validateBuyerFields(buyerType: string | null | undefined, fields: {
  name?: string | null;
  vatNumber?: string | null;
  streetName?: string | null;
  buildingNumber?: string | null;
  district?: string | null;
  city?: string | null;
  postalCode?: string | null;
}): FieldError[] {
  const errors: FieldError[] = [];
  if (!fields.name?.trim()) {
    errors.push({ field: 'name', message: 'Name is required.' });
  }
  if (buyerType === 'B2C') {
    return errors;
  }
  // B2B (default/Standard)
  if (!isValidZatcaVatNumber(fields.vatNumber)) {
    errors.push({ field: 'vatNumber', message: 'VAT number must be exactly 15 digits, starting and ending with 3, for a B2B (Standard invoice) customer/vendor.' });
  }
  if (!fields.streetName?.trim()) {
    errors.push({ field: 'streetName', message: 'Street name is required for a B2B (Standard invoice) customer/vendor.' });
  }
  if (!fields.buildingNumber?.trim()) {
    errors.push({ field: 'buildingNumber', message: 'Building number is required for a B2B (Standard invoice) customer/vendor.' });
  }
  if (!fields.district?.trim()) {
    errors.push({ field: 'district', message: 'District is required for a B2B (Standard invoice) customer/vendor.' });
  }
  if (!fields.city?.trim()) {
    errors.push({ field: 'city', message: 'City is required for a B2B (Standard invoice) customer/vendor.' });
  }
  if (!isValidPostalCode(fields.postalCode)) {
    errors.push({ field: 'postalCode', message: 'Postal code must be exactly 5 digits for a B2B (Standard invoice) customer/vendor.' });
  }
  return errors;
}
