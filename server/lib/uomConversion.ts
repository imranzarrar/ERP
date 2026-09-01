import * as schema from '../../src/db/schema.js';
import { and, eq, inArray } from 'drizzle-orm';

// Packaging/alternate Units of Measure — see productUnitConversions's schema comment for
// the full model. Every function here is company-scoped and takes an explicit `tx` (a
// drizzle transaction or the plain `db` instance) so callers can compose these inside their
// own transaction, the same convention every other business-logic helper in this codebase
// already follows (see businessLogic.ts's deductStockForSale/writeStockLedgerEntry).

// Returns 1 for the product's own base unit (unitOfMeasureId null/undefined — the
// overwhelmingly common case, and the only case for every product that has never
// configured a packaging unit at all). Throws a clear 400 if a unitOfMeasureId is given
// that has no active conversion row for this product — defends against a stale/mismatched
// id reaching a stock-mutating route (e.g. a deactivated packaging unit, or one that
// belongs to a different product entirely).
export async function getConversionFactor(
  tx: any, productId: string, unitOfMeasureId: string | null | undefined, companyId: string
): Promise<number> {
  if (!unitOfMeasureId) return 1;
  const [row] = await tx.select({ conversionFactor: schema.productUnitConversions.conversionFactor })
    .from(schema.productUnitConversions)
    .where(and(
      eq(schema.productUnitConversions.productId, productId),
      eq(schema.productUnitConversions.unitOfMeasureId, unitOfMeasureId),
      eq(schema.productUnitConversions.companyId, companyId),
      eq(schema.productUnitConversions.isActive, true),
    ));
  if (!row) {
    const err: any = new Error('This item has no active packaging unit matching the one selected on this line.');
    err.status = 400;
    throw err;
  }
  return Number(row.conversionFactor);
}

// quantity, as entered on the transaction line (in whatever unit was selected), converted
// to the product's own base-unit quantity — the only quantity inventoryStocks/
// stockLedgerTransactions ever store.
export async function toBaseQuantity(
  tx: any, productId: string, unitOfMeasureId: string | null | undefined, companyId: string, quantity: number
): Promise<number> {
  const factor = await getConversionFactor(tx, productId, unitOfMeasureId, companyId);
  return quantity * factor;
}

// unitCost, as entered on the transaction line (price per whatever unit was selected),
// converted to a per-base-unit cost — this is what averageCost/averageSalePrice must fold
// in, never the line's own raw unitCost, or a carton bought for 120 SAR would corrupt a
// per-piece weighted average into 120 SAR/piece instead of 10 SAR/piece.
export async function toBaseUnitCost(
  tx: any, productId: string, unitOfMeasureId: string | null | undefined, companyId: string, unitCost: number
): Promise<number> {
  const factor = await getConversionFactor(tx, productId, unitOfMeasureId, companyId);
  return factor === 0 ? unitCost : unitCost / factor;
}

// Batch helper for invoice/quotation item inserts: given a list of line items (each
// possibly carrying a unitOfMeasureId), returns a Map from unitOfMeasureId -> its
// `code` (already enforced to be a real ZATCA UN/ECE code at creation time — see
// POST /units-of-measure's isValidZatcaUnitCode check), so the ZATCA XML `unit` string
// can be derived from the actually-selected unit instead of whatever the client
// separately sent as `item.unit`. One query regardless of how many distinct units
// appear across the batch.
export async function loadZatcaCodesByUnitId(tx: any, items: Array<{ unitOfMeasureId?: string | null }>): Promise<Map<string, string | null>> {
  const ids = Array.from(new Set(items.map(i => i.unitOfMeasureId).filter(Boolean))) as string[];
  const map = new Map<string, string | null>();
  if (ids.length === 0) return map;
  const rows = await tx.select({ id: schema.unitsOfMeasure.id, code: schema.unitsOfMeasure.code })
    .from(schema.unitsOfMeasure).where(inArray(schema.unitsOfMeasure.id, ids));
  for (const row of rows) map.set(row.id, row.code);
  return map;
}
