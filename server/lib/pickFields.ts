// Keeps only the named own properties of a request body. Create routes build the stored row from an explicit list of the fields their
// forms send, so a request cannot set a server-owned field (ZATCA state, created-by/at, status, reversal link, document type) by naming it.
export function pickFields(source: any, allowed: readonly string[]): Record<string, any> {
  const out: Record<string, any> = {};
  if (!source || typeof source !== 'object') return out;
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

// What the Invoice and POS screens send to POST /invoices (the rest of the row is set by the server).
export const INVOICE_CREATE_FIELDS = [
  'docDate', 'customerId', 'taxSlabId', 'bankId', 'paymentStatus', 'paymentDate', 'notes', 'attachmentUrl', 'originQuotationId',
  'discountPercentage', 'discountAmount', 'amountPaid', 'branchId', 'warehouseId', 'salesAssociateId', 'isPosSale', 'shiftId',
] as const;

// What the Expense screen sends to POST /expenses.
export const EXPENSE_CREATE_FIELDS = [
  'docDate', 'vendorId', 'taxSlabId', 'bankId', 'paymentStatus', 'paymentDate', 'amountPaid', 'description', 'amount',
  'attachmentUrl', 'classification', 'assetType', 'branchId', 'billNumber', 'expenseType',
] as const;
