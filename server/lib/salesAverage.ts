import { eq } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { round2, round4 } from './businessLogic.js';
import { toBaseQuantity, toBaseUnitCost } from './uomConversion.js';

// Exact inverse of the "fold" that invoice creation applies to a product's running sale statistics
// (productsServices.totalQuantitySold / averageSalePrice, a quantity-weighted rolling average):
//     newAvg = (priorQty * priorAvg + soldQty * price) / (priorQty + soldQty)
// When a sale is cancelled, credited or partly returned, those units were never really sold, so they come back
// OUT of the statistic the same way — otherwise Item Profitability reports quantities and prices of sales that
// no longer stand. Because the average is a plain weighted mean over quantities we hold, the reversal is exact
// (up to the 4-decimal storage precision), not an approximation. Same line quantity, unit and unit price the
// creation fold used (the pre-discount line price, converted to the product's base unit).
export async function unwindAverageSalePrice(
  tx: any, companyId: string, productId: string, unitOfMeasureId: string | null | undefined, quantity: number, unitCost: number,
): Promise<void> {
  const [product] = await tx.select({
    averageSalePrice: schema.productsServices.averageSalePrice,
    totalQuantitySold: schema.productsServices.totalQuantitySold,
  }).from(schema.productsServices).where(eq(schema.productsServices.id, productId)).for('update');
  if (!product) return;

  const returnedQty = await toBaseQuantity(tx, productId, unitOfMeasureId, companyId, quantity);
  const baseUnitPrice = await toBaseUnitCost(tx, productId, unitOfMeasureId, companyId, unitCost);
  const priorQty = Number(product.totalQuantitySold || 0);
  const priorAvg = Number(product.averageSalePrice || 0);
  const newQty = priorQty - returnedQty;

  // Everything sold has been taken back: back to the never-sold state rather than a meaningless leftover average.
  if (newQty <= 0.0005) {
    await tx.update(schema.productsServices)
      .set({ averageSalePrice: '0', totalQuantitySold: '0' })
      .where(eq(schema.productsServices.id, productId));
    return;
  }
  const newAvg = round4((priorQty * priorAvg - returnedQty * baseUnitPrice) / newQty);
  await tx.update(schema.productsServices)
    .set({ averageSalePrice: String(Math.max(0, newAvg)), totalQuantitySold: String(round2(newQty)) })
    .where(eq(schema.productsServices.id, productId));
}
