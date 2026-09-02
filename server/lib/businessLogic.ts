
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and, isNull, inArray } from 'drizzle-orm';
import { generateId } from '../../src/id.js';
import { getAndIncrementDocumentNumber } from './documentNumbering.js';
import { toBaseQuantity, toBaseUnitCost } from './uomConversion.js';

// Round-half-up to 2 decimals. Applied after every intermediate step in a money
// calculation chain (not just once at the end via .toFixed(2)) so the value written to
// a `decimal(_, 2)` column matches what was actually computed, instead of accumulated
// floating-point drift showing up only when Postgres does its own final rounding.
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Extra precision for weighted-average cost/sale-price calculations (productsServices.
// averageCost/averageSalePrice) — 2 decimals is too coarse for a moving average recomputed
// on every transaction; small rounding error compounds visibly over many receipts/sales.
export function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

// Records one row in the stock ledger for an inventoryStocks mutation that has already
// been applied within the same transaction — this is a read-only audit trail of what
// happened, never a second place that decides quantities itself. `referenceId` is
// polymorphic (GRN/Return/Sale/Adjustment/StockTake id depending on transactionType, same
// as the column comment in schema.ts) — no single-table FK.
export async function writeStockLedgerEntry(tx: any, params: {
  productId: string;
  warehouseId: string;
  companyId: string;
  transactionType: 'GRN' | 'Return' | 'Sale' | 'Adjustment' | 'StockTake';
  referenceId: string;
  date: Date;
  quantityChange: number;
  endingQuantity: number;
  batchNumber?: string | null;
}) {
  await tx.insert(schema.stockLedgerTransactions).values({
    id: generateId(),
    productId: params.productId,
    warehouseId: params.warehouseId,
    transactionType: params.transactionType,
    referenceId: params.referenceId,
    date: params.date,
    quantityChange: String(round2(params.quantityChange)),
    endingQuantity: String(round2(params.endingQuantity)),
    batchNumber: params.batchNumber || null,
    companyId: params.companyId,
  });
}

// Two-tier fallback for "which warehouse should this sale be attributed to/deducted
// from": the invoice's own branch's configured default first, then the company's overall
// default (warehouses.isCompanyDefault), else null (nowhere to resolve to — caller decides
// whether that's acceptable, see resolveSaleWarehouse below). Never returns a 'backend'-type
// or inactive warehouse — both are filtered out at the source (a branch/company default is
// only ever allowed to be set to a 'sales'-type, active warehouse by the routes that set
// those flags), so no extra type/active check is needed here.
export async function resolveDefaultSaleWarehouseId(tx: any, companyId: string, branchId: string | null | undefined): Promise<string | null> {
  if (branchId) {
    const [branch] = await tx.select({ defaultWarehouseId: schema.branches.defaultWarehouseId })
      .from(schema.branches).where(eq(schema.branches.id, branchId));
    if (branch?.defaultWarehouseId) return branch.defaultWarehouseId;
  }
  const [companyDefault] = await tx.select({ id: schema.warehouses.id }).from(schema.warehouses)
    .where(and(eq(schema.warehouses.companyId, companyId), eq(schema.warehouses.isCompanyDefault, true)));
  return companyDefault?.id || null;
}

// Every route that inserts a line-item keyed by productId (PR/PO/GRN items, stock
// adjustments/takes, invoice/quotation items) took it straight from the client with no
// check that it belongs to this company at all — found during a second, independent
// isolation audit pass after the first pass's fixes had already landed. A crafted
// request could reference another company's real product id, creating stock/ledger/
// line-item rows under THIS company's companyId that point at a foreign product —
// polluting this company's own records and leaking the other company's product
// name/pricing through any report or error message that joins productId back to
// productsServices without its own companyId filter. One shared check for every call
// site rather than re-deriving it per route.
export async function assertProductsOwnedByCompany(tx: any, companyId: string, productIds: (string | null | undefined)[]): Promise<void> {
  const ids = Array.from(new Set(productIds.filter(Boolean))) as string[];
  if (ids.length === 0) return;
  const rows = await tx.select({ id: schema.productsServices.id }).from(schema.productsServices)
    .where(and(inArray(schema.productsServices.id, ids), eq(schema.productsServices.companyId, companyId)));
  const foundIds = new Set(rows.map((r: any) => r.id));
  if (ids.some(id => !foundIds.has(id))) {
    const err: any = new Error('One or more selected products were not found for this company.');
    err.status = 400;
    throw err;
  }
}

// "Sales should take place only from sales warehouses" as a real server-side rule, not
// just a UI convention — called wherever a warehouseId is about to be persisted onto a
// sale (an explicit client choice or an auto-resolved default alike).
// allowedBranchIds mirrors req.allowedBranchIds exactly (null = unrestricted) — passed
// through explicitly rather than the whole Express `req` so this lib file stays
// decoupled from the request layer. Closes a real gap: an invoice's own branchId was
// already correctly resolved/validated via resolveDocumentBranchId, but a client could
// still pass an explicit warehouseId belonging to a DIFFERENT branch — the visible
// document looks correctly attributed to the caller's own branch (so it passes every
// other check and looks legitimate in reports), while the actual stock deduction
// silently drains a different branch's inventory. Quieter and harder to notice than the
// document-level branch spoofing this same audit pass found elsewhere.
export async function assertSalesWarehouse(tx: any, warehouseId: string, companyId: string, allowedBranchIds?: string[] | null): Promise<void> {
  const [warehouse] = await tx.select().from(schema.warehouses)
    .where(and(eq(schema.warehouses.id, warehouseId), eq(schema.warehouses.companyId, companyId)));
  if (!warehouse) { const err: any = new Error('Selected warehouse not found for this company.'); err.status = 404; throw err; }
  if (warehouse.isActive === false) { const err: any = new Error(`Warehouse "${warehouse.name}" is deactivated and cannot be used for a sale.`); err.status = 400; throw err; }
  if (warehouse.type !== 'sales') { const err: any = new Error(`Warehouse "${warehouse.name}" is a backend warehouse — sales can only be posted against a sales warehouse.`); err.status = 400; throw err; }
  if (Array.isArray(allowedBranchIds) && !allowedBranchIds.includes(warehouse.branchId as any)) {
    const err: any = new Error(`Warehouse "${warehouse.name}" belongs to a branch you are not assigned to.`); err.status = 403; throw err;
  }
}

// Resolves the one warehouse an invoice/POS sale's stock-item lines will be deducted from,
// requiring one only when actually needed. `items` are the raw line items as submitted
// (already validated/typed by the caller) — this only needs each line's productId to know
// whether the sale contains any true stock ('item' type, not free-typed, not 'service')
// line at all; a services-only sale has nothing to deduct and never needs a warehouse.
export async function resolveSaleWarehouse(
  tx: any, companyId: string, branchId: string | null | undefined,
  items: Array<{ productId?: string | null }>, explicitWarehouseId?: string | null,
  allowedBranchIds?: string[] | null
): Promise<string | null> {
  const productIds = Array.from(new Set(items.map(i => i.productId).filter(Boolean))) as string[];
  if (productIds.length === 0) return explicitWarehouseId || null;

  const products = await tx.select({ id: schema.productsServices.id, type: schema.productsServices.type })
    .from(schema.productsServices).where(inArray(schema.productsServices.id, productIds));
  const hasStockItem = products.some((p: any) => p.type === 'item');
  if (!hasStockItem) return explicitWarehouseId || null;

  const warehouseId = explicitWarehouseId || await resolveDefaultSaleWarehouseId(tx, companyId, branchId);
  if (!warehouseId) {
    const err: any = new Error('This sale includes a stock item — configure a default sales warehouse for this branch or company (Master Entities > Warehouses), or select one on the sale itself.');
    err.status = 400;
    throw err;
  }
  await assertSalesWarehouse(tx, warehouseId, companyId, allowedBranchIds);
  return warehouseId;
}

// Reads exactly the same inventoryStocks row deductStockForSale below reads/writes (the
// unbatched bucket for this product+warehouse) — kept as its own query rather than folded
// into deductStockForSale so the pre-flight availability check (assertStockAvailable) and
// the actual deduction always agree on what "available" means, even though they run at
// different points in a request.
async function getUnbatchedStockQty(tx: any, companyId: string, productId: string, warehouseId: string): Promise<number> {
  const [existingStock] = await tx.select({ quantity: schema.inventoryStocks.quantity }).from(schema.inventoryStocks)
    .where(and(
      eq(schema.inventoryStocks.productId, productId),
      eq(schema.inventoryStocks.warehouseId, warehouseId),
      eq(schema.inventoryStocks.companyId, companyId),
      isNull(schema.inventoryStocks.batchNumber)
    ));
  return existingStock ? Number(existingStock.quantity) : 0;
}

// Opt-in guard (companies.inventorySettings.enforceStockAvailability, off by default —
// see that field's comment in src/types.ts) — when enabled, a sale of a stock item is
// rejected outright rather than silently clamping deducted stock at 0. Sums requested
// quantity per product first (a product can appear on more than one line) so splitting one
// oversell across two lines can't slip past a per-line check.
export async function assertStockAvailable(
  tx: any, companyId: string, warehouseId: string | null,
  items: Array<{ productId?: string | null; quantity: number; unitOfMeasureId?: string | null }>
): Promise<void> {
  const [company] = await tx.select({ inventorySettings: schema.companies.inventorySettings }).from(schema.companies).where(eq(schema.companies.id, companyId));
  if (!(company?.inventorySettings as any)?.enforceStockAvailability) return;
  if (!warehouseId) return; // resolveSaleWarehouse already blocks this case when a stock item is present

  // Converted to base-unit terms before summing — two lines of the same product entered
  // in different units (e.g. 1 Carton-12 + 3 loose Piece) must combine correctly rather
  // than being compared to on-hand stock in mismatched units.
  const requestedByProduct = new Map<string, number>();
  for (const item of items) {
    if (!item.productId) continue;
    const baseQty = await toBaseQuantity(tx, item.productId, item.unitOfMeasureId, companyId, Number(item.quantity));
    requestedByProduct.set(item.productId, (requestedByProduct.get(item.productId) || 0) + baseQty);
  }
  if (requestedByProduct.size === 0) return;

  const productIds = Array.from(requestedByProduct.keys());
  const products = await tx.select({ id: schema.productsServices.id, name: schema.productsServices.name, type: schema.productsServices.type })
    .from(schema.productsServices).where(inArray(schema.productsServices.id, productIds));
  const productById = new Map(products.map((p: any) => [p.id, p]));

  for (const [productId, requestedQty] of requestedByProduct) {
    const product = productById.get(productId) as any;
    if (!product || product.type !== 'item') continue;
    const available = await getUnbatchedStockQty(tx, companyId, productId, warehouseId);
    if (requestedQty > available) {
      const err: any = new Error(`Insufficient stock for "${product.name}": ${available} on hand at the selected warehouse, ${requestedQty} requested.`);
      err.status = 400;
      throw err;
    }
  }
}

// Deducts a sold quantity from inventoryStocks for one invoice/POS line and records the
// movement in the stock ledger. Only applies to catalog-linked lines on true "item" type
// products — a free-typed line (no productId) has nothing to deduct, and a "service" line
// (productId set but type === 'service') has no physical stock at all, so both are no-ops
// here rather than errors. Also no-ops when no warehouseId is given (nothing was resolved
// for this sale, e.g. a services-only invoice) — a sale must never be blocked by
// incomplete inventory setup by itself (that's what assertStockAvailable's opt-in flag is
// for). Clamped at 0 rather than allowed to go negative, matching every other
// stock-mutating route in this app (GRN reversal, Purchase Return, Stock Adjustment).
// `quantitySold` is in whatever unit the line was entered in (`unitOfMeasureId`, null =
// the product's own base unit) — converted to base-unit terms here, once, before it ever
// touches inventoryStocks/the ledger.
export async function deductStockForSale(tx: any, companyId: string, productId: string, quantitySold: number, referenceId: string, date: Date, warehouseId?: string | null, unitOfMeasureId?: string | null) {
  if (!warehouseId) return;
  const [product] = await tx.select({ type: schema.productsServices.type })
    .from(schema.productsServices).where(eq(schema.productsServices.id, productId)).for('update');
  if (!product || product.type !== 'item') return;

  const baseQuantitySold = await toBaseQuantity(tx, productId, unitOfMeasureId, companyId, quantitySold);

  const [existingStock] = await tx.select().from(schema.inventoryStocks)
    .where(and(
      eq(schema.inventoryStocks.productId, productId),
      eq(schema.inventoryStocks.warehouseId, warehouseId),
      eq(schema.inventoryStocks.companyId, companyId),
      isNull(schema.inventoryStocks.batchNumber)
    ))
    .for('update');

  const priorQty = existingStock ? Number(existingStock.quantity) : 0;
  const newQty = Math.max(0, round2(priorQty - baseQuantitySold));

  if (existingStock) {
    await tx.update(schema.inventoryStocks).set({ quantity: String(newQty) }).where(eq(schema.inventoryStocks.id, existingStock.id));
  } else {
    await tx.insert(schema.inventoryStocks).values({
      id: generateId(), productId, warehouseId, batchNumber: null, quantity: String(newQty), companyId,
    });
  }

  await writeStockLedgerEntry(tx, {
    productId, warehouseId, companyId,
    transactionType: 'Sale', referenceId, date,
    quantityChange: newQty - priorQty,
    endingQuantity: newQty, batchNumber: null,
  });
}

// Payment status is a derived fact of amountPaid vs. the total, not something the
// client should get to assert directly — previously every route trusted
// req.body.paymentStatus verbatim, which produced inconsistent/duplicate values in
// live data ('Partial' and 'Partially Paid' both meaning the same thing).
export function computePaymentStatus(amountPaid: number, total: number): 'Paid' | 'Partially Paid' | 'Unpaid' {
  const paid = round2(amountPaid || 0);
  const grand = round2(total || 0);
  if (paid <= 0) return 'Unpaid';
  if (paid >= grand) return 'Paid';
  return 'Partially Paid';
}

// Per-line tax-slab-with-header-fallback invoice total computation — extracted from
// POST /invoices (server/routes/transactions.ts) so the VAT Return feature's server-side
// figure computation (server/lib/vatReturn.ts) uses the exact same formula the invoice
// route itself persists with, instead of a second, driftable copy of this math. Callers
// resolve the header/line tax percentages from schema.taxSlabs themselves (this function
// takes plain numbers, no DB access) since the invoice route already has those rows loaded
// for its own insert, and the VAT Return module loads them separately per company.
export function computeInvoiceServerTotals(
  items: { unitCost: number | string; quantity: number | string; discountAmount?: number | string; taxSlabId?: string | null }[],
  headerPercentage: number,
  discountPercentage: number,
  lineSlabPercentageById: Map<string, number>
): { itemsSubtotal: number; headerDiscount: number; discountedSubtotal: number; taxAmount: number; grandTotal: number } {
  const itemsSubtotal = round2((items || []).reduce((acc: number, item: any) => {
    const cost = round2(Math.max(0, round2(Number(item.unitCost)) - round2(Number(item.discountAmount || 0))));
    return acc + round2(cost * Number(item.quantity));
  }, 0));
  const headerDiscount = round2(itemsSubtotal * (Number(discountPercentage || 0) / 100));
  const shrinkFactor = itemsSubtotal > 0 ? (itemsSubtotal - headerDiscount) / itemsSubtotal : 1;
  const discountedSubtotal = round2(Math.max(0, itemsSubtotal - headerDiscount));
  const taxAmount = round2((items || []).reduce((acc: number, item: any) => {
    const cost = round2(Math.max(0, round2(Number(item.unitCost)) - round2(Number(item.discountAmount || 0))));
    const lineSubtotal = round2(round2(cost * Number(item.quantity)) * shrinkFactor);
    const rate = item.taxSlabId && lineSlabPercentageById.has(item.taxSlabId) ? lineSlabPercentageById.get(item.taxSlabId)! : headerPercentage;
    return acc + round2(lineSubtotal * (rate / 100));
  }, 0));
  const grandTotal = round2(discountedSubtotal + taxAmount);
  return { itemsSubtotal, headerDiscount, discountedSubtotal, taxAmount, grandTotal };
}

export async function validateTransactionDate(date: string, companyId: string) {
  if (!date || !companyId) {
    const err = new Error('Transaction date and company ID are required for validation');
    (err as any).status = 400;
    throw err;
  }
  
  const monthId = date.substring(0, 7); // e.g. "2026-07"
  const [month] = await db.select()
    .from(schema.fiscalMonths)
    .where(
      and(
        eq(schema.fiscalMonths.id, monthId),
        eq(schema.fiscalMonths.companyId, companyId)
      )
    );
    
  if (!month) {
    const err = new Error(`Transaction date ${date} does not fall within any defined fiscal month.`);
    (err as any).status = 400;
    throw err;
  }
  
  if (month.status?.toLowerCase() !== 'open') {
    const err = new Error(`Transaction date ${date} falls in a closed fiscal month (${month.name}).`);
    (err as any).status = 400;
    throw err;
  }
  
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = String(now.getMonth() + 1).padStart(2, '0');
  const currentYearMonth = `${currentYear}-${currentMonth}`;
  
  if (monthId > currentYearMonth) {
    const err = new Error(`Transaction date ${date} falls in a future fiscal month (${month.name}).`);
    (err as any).status = 400;
    throw err;
  }
  
  return { valid: true, month };
}

// Blocks a new/edited financial document from landing inside a quarter whose VAT Return
// has already been marked ZATCA Filed (see server/routes/taxReturns.ts) — same 3-part
// shape as validateTransactionDate above (derive the period, look it up, reject if
// locked), and likewise thrown as a plain Error with .status attached rather than a
// permission check: filing is a regulatory one-way door, no role can override it.
export async function assertQuarterNotFiled(date: string, companyId: string): Promise<void> {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const quarter = Math.ceil(month / 3);
  const [filedReturn] = await db.select({ referenceNumber: schema.taxReturns.referenceNumber })
    .from(schema.taxReturns)
    .where(and(
      eq(schema.taxReturns.companyId, companyId),
      eq(schema.taxReturns.year, year),
      eq(schema.taxReturns.quarter, quarter),
      eq(schema.taxReturns.status, 'Filed'),
      eq(schema.taxReturns.isDeleted, false)
    ));
  if (filedReturn) {
    const err = new Error(`This date falls within ${filedReturn.referenceNumber}, which has already been filed with ZATCA and is permanently locked. No new or edited Invoice, Credit/Debit Note, Expense, or Purchase Bill may be dated in a filed quarter.`);
    (err as any).status = 400;
    throw err;
  }
}

export async function syncVoucherForExpense(tx: any, expenseId: string, companyId: string, data: any, userId: string) {
  const [existingVoucher] = await tx.select()
    .from(schema.vouchers)
    .where(
      and(
        eq(schema.vouchers.referenceType, 'Expense'),
        eq(schema.vouchers.referenceId, expenseId),
        eq(schema.vouchers.type, 'Payment')
      )
    );

  if (data.paymentStatus === 'Paid' && data.status !== 'Cancelled') {
    if (existingVoucher) {
      // Check if voucher's month is closed
      const voucherMonthId = existingVoucher.date.substring(0, 7);
      const [voucherMonth] = await tx.select()
        .from(schema.fiscalMonths)
        .where(
          and(
            eq(schema.fiscalMonths.id, voucherMonthId),
            eq(schema.fiscalMonths.companyId, companyId)
          )
        );
      const isVoucherMonthClosed = !voucherMonth || voucherMonth.status?.toLowerCase() !== 'open';

      if (!isVoucherMonthClosed) {
        await tx.update(schema.vouchers)
          .set({
            date: data.date,
            bankId: data.bankId,
            amount: data.amount,
            description: `Payment voucher for ${data.description || 'Expense'}`,
            companyId: companyId,
          })
          .where(eq(schema.vouchers.id, existingVoucher.id));
      }
    } else {
      const voucherNumber = await getAndIncrementDocumentNumber(tx, companyId, 'voucher', data.date, data.branchId || null);
      await tx.insert(schema.vouchers).values({
        id: generateId(),
        voucherNumber,
        type: 'Payment',
        date: data.date,
        bankId: data.bankId,
        amount: data.amount,
        description: `Payment voucher for ${data.description || 'Expense'}`,
        referenceType: 'Expense',
        referenceId: expenseId,
        companyId: companyId,
        // Always inherited from the expense being settled, never picked independently —
        // see schema.ts's vouchers.branchId comment.
        branchId: data.branchId || null,
        createdById: userId,
        createdAt: new Date(),
      });
    }
  } else {
    if (existingVoucher) {
      // Check if voucher's month is closed
      const voucherMonthId = existingVoucher.date.substring(0, 7);
      const [voucherMonth] = await tx.select()
        .from(schema.fiscalMonths)
        .where(
          and(
            eq(schema.fiscalMonths.id, voucherMonthId),
            eq(schema.fiscalMonths.companyId, companyId)
          )
        );
      const isVoucherMonthClosed = !voucherMonth || voucherMonth.status?.toLowerCase() !== 'open';

      if (isVoucherMonthClosed) {
        // Find existing reversal
        const [existingReversal] = await tx.select()
          .from(schema.vouchers)
          .where(
            and(
              eq(schema.vouchers.referenceType, 'Expense'),
              eq(schema.vouchers.referenceId, expenseId),
              eq(schema.vouchers.type, 'Reversal')
            )
          );

        if (!existingReversal) {
          const [openMonth] = await tx.select()
            .from(schema.fiscalMonths)
            .where(
              and(
                eq(schema.fiscalMonths.status, 'Open'),
                eq(schema.fiscalMonths.companyId, companyId)
              )
            )
            .limit(1);

          const todayStr = new Date().toISOString().split('T')[0];
          let finalReversalDate = todayStr;
          if (openMonth) {
            finalReversalDate = todayStr.startsWith(openMonth.id) 
              ? todayStr 
              : (data.date && data.date.startsWith(openMonth.id) ? data.date : openMonth.id + "-01");
          }

          const voucherNumber = await getAndIncrementDocumentNumber(tx, companyId, 'voucher', finalReversalDate, existingVoucher.branchId || null);
          await tx.insert(schema.vouchers).values({
            id: generateId(),
            voucherNumber,
            type: 'Reversal',
            date: finalReversalDate,
            bankId: existingVoucher.bankId,
            amount: existingVoucher.amount,
            description: `Reversal voucher for cancelled expense ${data.expenseNumber || ''} (Original: ${existingVoucher.voucherNumber})`,
            referenceType: 'Expense',
            referenceId: expenseId,
            companyId: companyId,
            branchId: existingVoucher.branchId || null,
            createdById: userId,
            createdAt: new Date(),
          });
        }
      } else {
        await tx.delete(schema.vouchers).where(eq(schema.vouchers.id, existingVoucher.id));
      }
    }
  }
}

export async function syncVoucherForInvoice(tx: any, invoiceId: string, companyId: string, data: any, userId: string) {
  const [existingVoucher] = await tx.select()
    .from(schema.vouchers)
    .where(
      and(
        eq(schema.vouchers.referenceType, 'Invoice'),
        eq(schema.vouchers.referenceId, invoiceId),
        eq(schema.vouchers.type, 'Receipt')
      )
    );

  if (data.paymentStatus === 'Paid' && data.status !== 'Cancelled') {
    if (existingVoucher) {
      // Check if voucher's month is closed
      const voucherMonthId = existingVoucher.date.substring(0, 7);
      const [voucherMonth] = await tx.select()
        .from(schema.fiscalMonths)
        .where(
          and(
            eq(schema.fiscalMonths.id, voucherMonthId),
            eq(schema.fiscalMonths.companyId, companyId)
          )
        );
      const isVoucherMonthClosed = !voucherMonth || voucherMonth.status?.toLowerCase() !== 'open';

      if (!isVoucherMonthClosed) {
        await tx.update(schema.vouchers)
          .set({
            date: String(data.paymentDate || data.date),
            bankId: data.bankId,
            amount: data.amountPaid || data.amount,
            description: `Receipt voucher generated automatically for paid invoice ${data.invoiceNumber}`,
            companyId: companyId,
          })
          .where(eq(schema.vouchers.id, existingVoucher.id));
      }
    } else {
      const voucherDate = String(data.paymentDate || data.date);
      const voucherNumber = await getAndIncrementDocumentNumber(tx, companyId, 'voucher', voucherDate, data.branchId || null);
      await tx.insert(schema.vouchers).values({
        id: generateId(),
        voucherNumber,
        type: 'Receipt',
        date: voucherDate,
        bankId: data.bankId,
        amount: data.amountPaid || data.amount,
        description: `Receipt voucher generated automatically for paid invoice ${data.invoiceNumber}`,
        referenceType: 'Invoice',
        referenceId: invoiceId,
        companyId: companyId,
        // Always inherited from the invoice being settled, never picked independently —
        // see schema.ts's vouchers.branchId comment.
        branchId: data.branchId || null,
        createdById: userId,
        createdAt: new Date(),
      });
    }
  } else {
    if (existingVoucher) {
      // Check if voucher's month is closed
      const voucherMonthId = existingVoucher.date.substring(0, 7);
      const [voucherMonth] = await tx.select()
        .from(schema.fiscalMonths)
        .where(
          and(
            eq(schema.fiscalMonths.id, voucherMonthId),
            eq(schema.fiscalMonths.companyId, companyId)
          )
        );
      const isVoucherMonthClosed = !voucherMonth || voucherMonth.status?.toLowerCase() !== 'open';

      if (isVoucherMonthClosed) {
        // Find existing reversal
        const [existingReversal] = await tx.select()
          .from(schema.vouchers)
          .where(
            and(
              eq(schema.vouchers.referenceType, 'Invoice'),
              eq(schema.vouchers.referenceId, invoiceId),
              eq(schema.vouchers.type, 'Reversal')
            )
          );

        if (!existingReversal) {
          const [openMonth] = await tx.select()
            .from(schema.fiscalMonths)
            .where(
              and(
                eq(schema.fiscalMonths.status, 'Open'),
                eq(schema.fiscalMonths.companyId, companyId)
              )
            )
            .limit(1);

          const todayStr = new Date().toISOString().split('T')[0];
          let finalReversalDate = todayStr;
          if (openMonth) {
            finalReversalDate = todayStr.startsWith(openMonth.id) 
              ? todayStr 
              : (data.date && data.date.startsWith(openMonth.id) ? data.date : openMonth.id + "-01");
          }

          const voucherNumber = await getAndIncrementDocumentNumber(tx, companyId, 'voucher', finalReversalDate, existingVoucher.branchId || null);
          await tx.insert(schema.vouchers).values({
            id: generateId(),
            voucherNumber,
            type: 'Reversal',
            date: finalReversalDate,
            bankId: existingVoucher.bankId,
            amount: existingVoucher.amount,
            description: `Reversal voucher for cancelled invoice ${data.invoiceNumber || ''} (Original: ${existingVoucher.voucherNumber})`,
            referenceType: 'Invoice',
            referenceId: invoiceId,
            companyId: companyId,
            branchId: existingVoucher.branchId || null,
            createdById: userId,
            createdAt: new Date(),
          });
        }
      } else {
        await tx.delete(schema.vouchers).where(eq(schema.vouchers.id, existingVoucher.id));
      }
    }
  }
}

// A Credit Note reverses money actually received on the original invoice — unlike
// Cancel (which flips the original invoice's own status and, within an open month, can
// legitimately wipe its Receipt as if the sale never happened), a Credit Note leaves the
// original invoice's own status/paymentStatus/amountPaid untouched by design (it really
// did happen — see CLAUDE.md's ZATCA section and the /invoices/:id/note route). Deleting
// the original Receipt voucher (as syncVoucherForInvoice's open-month branch does for
// Cancel) would therefore leave the invoice showing "Paid" with no corresponding bank
// entry anywhere — the exact inconsistency reported against the Bank Statement Ledger.
// So this always posts a genuine Reversal voucher and never touches the original Receipt,
// regardless of whether the original's fiscal month is open or closed.
export async function postCreditNoteReversalVoucher(tx: any, originalInvoiceId: string, companyId: string, creditNoteDate: string, userId: string) {
  const [existingVoucher] = await tx.select()
    .from(schema.vouchers)
    .where(
      and(
        eq(schema.vouchers.referenceType, 'Invoice'),
        eq(schema.vouchers.referenceId, originalInvoiceId),
        eq(schema.vouchers.type, 'Receipt')
      )
    );
  if (!existingVoucher) return;

  const [existingReversal] = await tx.select()
    .from(schema.vouchers)
    .where(
      and(
        eq(schema.vouchers.referenceType, 'Invoice'),
        eq(schema.vouchers.referenceId, originalInvoiceId),
        eq(schema.vouchers.type, 'Reversal')
      )
    );
  if (existingReversal) return;

  // The reversal is happening now, not on the original invoice's date — but a posting
  // still can't land in a closed fiscal month (same invariant syncVoucherForInvoice's own
  // reversal branch enforces above). Prefer today; if today isn't in the open month, clamp
  // into it the same way — the credit note's own date if that falls inside the open month,
  // else the 1st of the open month.
  const [openMonth] = await tx.select()
    .from(schema.fiscalMonths)
    .where(
      and(
        eq(schema.fiscalMonths.status, 'Open'),
        eq(schema.fiscalMonths.companyId, companyId)
      )
    )
    .limit(1);

  const todayStr = new Date().toISOString().split('T')[0];
  let finalReversalDate = todayStr;
  if (openMonth) {
    finalReversalDate = todayStr.startsWith(openMonth.id)
      ? todayStr
      : (creditNoteDate && creditNoteDate.startsWith(openMonth.id) ? creditNoteDate : openMonth.id + "-01");
  }

  const voucherNumber = await getAndIncrementDocumentNumber(tx, companyId, 'voucher', finalReversalDate, existingVoucher.branchId || null);
  await tx.insert(schema.vouchers).values({
    id: generateId(),
    voucherNumber,
    type: 'Reversal',
    date: finalReversalDate,
    bankId: existingVoucher.bankId,
    amount: existingVoucher.amount,
    description: `Reversal voucher for credited invoice (Original: ${existingVoucher.voucherNumber})`,
    referenceType: 'Invoice',
    referenceId: originalInvoiceId,
    companyId: companyId,
    branchId: existingVoucher.branchId || null,
    createdById: userId,
    createdAt: new Date(),
  });
}
