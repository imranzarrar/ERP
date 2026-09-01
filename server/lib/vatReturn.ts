import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and, gte, lte, ne, inArray } from 'drizzle-orm';
import { round2, computeInvoiceServerTotals } from './businessLogic.js';

// Pure calendar-quarter math (KSA fiscal year = Jan-Dec, 4 standard calendar quarters) —
// no such helper existed anywhere in this codebase before this feature.
export function getQuarterDateRange(year: number, quarter: 1 | 2 | 3 | 4): { startDate: string; endDate: string } {
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const startDate = `${year}-${String(startMonth).padStart(2, '0')}-01`;
  const lastDay = new Date(year, endMonth, 0).getDate(); // day 0 of next month = last day of endMonth
  const endDate = `${year}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { startDate, endDate };
}

// Shared by both the generate and file routes (server/routes/taxReturns.ts) — deliberately
// checked at GENERATE time too, not just at FILE time: there is no real value in even
// drafting a return while some of the invoices that feed it haven't finished their ZATCA
// e-invoicing submission, since that nudges the admin to resolve the e-invoicing gap first
// rather than discovering it only once they try to actually file. DISABLED is excluded —
// it's a company-wide "e-invoicing not in use" state, not a per-invoice failure, so it
// never blocks anything.
export async function assertNoUnreportedZatcaInvoices(executor: any, companyId: string, startDate: string, endDate: string): Promise<void> {
  const pendingInvoices = await executor.select({ invoiceNumber: schema.invoices.invoiceNumber, zatcaStatus: schema.invoices.zatcaStatus })
    .from(schema.invoices)
    .where(and(
      eq(schema.invoices.companyId, companyId),
      eq(schema.invoices.status, 'Active'),
      gte(schema.invoices.date, startDate),
      lte(schema.invoices.date, endDate),
      inArray(schema.invoices.zatcaStatus, ['NOT_SUBMITTED', 'SUBMITTING', 'ERROR'])
    ));
  if (pendingInvoices.length > 0) {
    const err: any = new Error(`${pendingInvoices.length} invoice(s) dated in this quarter have not completed ZATCA e-invoicing submission (e.g. ${pendingInvoices[0].invoiceNumber}: ${pendingInvoices[0].zatcaStatus}). Cancel these invoices (or issue a Credit Note against them) or wait for them to finish reporting to ZATCA, then try again.`);
    err.status = 400;
    throw err;
  }
}

export interface VatReturnFigures {
  salesSubtotal: number;
  outputVat: number;
  purchasesSubtotal: number;
  inputVat: number;
  netVatPayable: number;
  breakdown: { salesCount: number; expenseCount: number; billCount: number };
}

// Real, server-side VAT figure computation for one company/quarter — never trusts a
// client-submitted number, matching how invoice totals are always server-recomputed
// (server/routes/transactions.ts's invoice route). Parallel to, and does NOT modify or
// replace, ReportViewer.tsx's existing ad-hoc getSalesVATData/getPurchaseVATData/
// getVatReturnSummaryData — those stay exactly as they are, this is an additive path
// that happens to compute the same underlying figures for a persisted filing record.
export async function computeVatReturnFigures(companyId: string, year: number, quarter: number): Promise<VatReturnFigures> {
  const { startDate, endDate } = getQuarterDateRange(year, quarter as 1 | 2 | 3 | 4);

  // --- Sales side: Active invoices (incl. Credit/Debit Notes) in the quarter ---
  const invoicesInRange = await db.select().from(schema.invoices).where(and(
    eq(schema.invoices.companyId, companyId),
    eq(schema.invoices.status, 'Active'),
    gte(schema.invoices.date, startDate),
    lte(schema.invoices.date, endDate)
  ));

  let salesSubtotal = 0;
  let outputVat = 0;
  if (invoicesInRange.length > 0) {
    const invoiceIds = invoicesInRange.map(inv => inv.id);
    const allItems = await db.select().from(schema.invoiceItems).where(inArray(schema.invoiceItems.invoiceId, invoiceIds));
    const itemsByInvoiceId = new Map<string, typeof allItems>();
    for (const item of allItems) {
      if (!itemsByInvoiceId.has(item.invoiceId)) itemsByInvoiceId.set(item.invoiceId, []);
      itemsByInvoiceId.get(item.invoiceId)!.push(item);
    }
    const taxSlabIds = Array.from(new Set([
      ...invoicesInRange.map(inv => inv.taxSlabId).filter(Boolean),
      ...allItems.map(it => it.taxSlabId).filter(Boolean),
    ])) as string[];
    const taxSlabRows = taxSlabIds.length > 0 ? await db.select().from(schema.taxSlabs).where(inArray(schema.taxSlabs.id, taxSlabIds)) : [];
    const percentageById = new Map(taxSlabRows.map(s => [s.id, Number(s.percentage)]));

    for (const inv of invoicesInRange) {
      const items = itemsByInvoiceId.get(inv.id) || [];
      const headerPercentage = inv.taxSlabId && percentageById.has(inv.taxSlabId) ? percentageById.get(inv.taxSlabId)! : 0;
      const { discountedSubtotal, taxAmount } = computeInvoiceServerTotals(
        items as any, headerPercentage, Number(inv.discountPercentage || 0), percentageById
      );
      // A Credit Note reverses an original sale — net it out, never sum it as a positive
      // sale, same convention already established in src/dbStore.ts's getInvoiceSign
      // (ported here as a plain ternary rather than importing that legacy client file).
      const sign = inv.documentType === 'CreditNote' ? -1 : 1;
      salesSubtotal = round2(salesSubtotal + discountedSubtotal * sign);
      outputVat = round2(outputVat + taxAmount * sign);
    }
  }

  // --- Purchases side, part 1: Active expenses in the quarter (header-only tax, back-calculated from a tax-inclusive amount) ---
  const expensesInRange = await db.select().from(schema.expenses).where(and(
    eq(schema.expenses.companyId, companyId),
    eq(schema.expenses.status, 'Active'),
    gte(schema.expenses.date, startDate),
    lte(schema.expenses.date, endDate)
  ));
  const expenseTaxSlabIds = Array.from(new Set(expensesInRange.map(e => e.taxSlabId).filter(Boolean))) as string[];
  const expenseTaxSlabRows = expenseTaxSlabIds.length > 0 ? await db.select().from(schema.taxSlabs).where(inArray(schema.taxSlabs.id, expenseTaxSlabIds)) : [];
  const expensePercentageById = new Map(expenseTaxSlabRows.map(s => [s.id, Number(s.percentage)]));

  let expenseSubtotal = 0;
  let expenseVat = 0;
  for (const exp of expensesInRange) {
    const rate = exp.taxSlabId && expensePercentageById.has(exp.taxSlabId) ? expensePercentageById.get(exp.taxSlabId)! : 0;
    const amount = Number(exp.amount);
    const subtotal = rate > 0 ? amount / (1 + rate / 100) : amount;
    const tax = amount - subtotal;
    expenseSubtotal = round2(expenseSubtotal + subtotal);
    expenseVat = round2(expenseVat + tax);
  }

  // --- Purchases side, part 2: Purchase Bills in the quarter (already carry their own subTotal/taxTotal, no back-calc needed) ---
  // purchaseBills.date is a timestamp column (unlike invoices/expenses' text 'YYYY-MM-DD'
  // dates), and bill creation always sets date: new Date() — no client-supplied bill date
  // exists today (server/routes/inventory.ts). Query with Date-object bounds accordingly.
  const billsInRange = await db.select().from(schema.purchaseBills).where(and(
    eq(schema.purchaseBills.companyId, companyId),
    ne(schema.purchaseBills.status, 'Cancelled'),
    gte(schema.purchaseBills.date, new Date(startDate + 'T00:00:00.000Z')),
    lte(schema.purchaseBills.date, new Date(endDate + 'T23:59:59.999Z'))
  ));
  let billSubtotal = 0;
  let billVat = 0;
  for (const bill of billsInRange) {
    billSubtotal = round2(billSubtotal + Number(bill.subTotal));
    billVat = round2(billVat + Number(bill.taxTotal));
  }

  const purchasesSubtotal = round2(expenseSubtotal + billSubtotal);
  const inputVat = round2(expenseVat + billVat);

  return {
    salesSubtotal,
    outputVat,
    purchasesSubtotal,
    inputVat,
    // Net Payable VAT = VAT on Sales minus VAT on Purchases (never gross Sales minus
    // gross Purchases) — same formula ReportViewer.tsx's getVatReturnSummaryData already
    // uses today; this feature persists it, it does not redefine it.
    netVatPayable: round2(outputVat - inputVat),
    breakdown: { salesCount: invoicesInRange.length, expenseCount: expensesInRange.length, billCount: billsInRange.length },
  };
}
