import * as schema from '../../src/db/schema.js';
import { and, eq, ne, gte, lte, inArray, isNotNull } from 'drizzle-orm';
import { round2 } from './businessLogic.js';

// Input VAT from Purchase Bills, with Purchase Returns recorded in THEIR OWN period.
//
// A return against a billed GRN gives back the input VAT that was claimed on those goods. That adjustment
// belongs to the tax period in which the RETURN happens — not to the period of the original bill. Before this,
// a return either rewrote the (possibly already-filed) bill's own totals or, when the bill was already paid,
// never reduced the claim at all. Now:
//   * a bill counts at its ORIGINAL amounts, in the period of the bill's date — its stored totals are the
//     current ones, so what a return already took off them (billTotalsReduced) is added back; and
//   * each Active return that gave VAT back counts as a negative line in the period of the return's date.
// Cancelled returns restore the bill's totals and drop out of both parts, so they net to nothing.
export interface BillVatLine { kind: 'Bill' | 'Return'; documentNumber: string; date: string; vendorId: string; branchId: string | null; subtotal: number; vat: number; gross: number; }
export interface BillInputVat { subtotal: number; vat: number; billCount: number; returnCount: number; lines: BillVatLine[]; }

export async function computeBillInputVat(executor: any, companyId: string, startDate: string, endDate: string): Promise<BillInputVat> {
  const from = new Date(startDate + 'T00:00:00.000Z');
  const to = new Date(endDate + 'T23:59:59.999Z');

  const bills: any[] = await executor.select().from(schema.purchaseBills).where(and(
    eq(schema.purchaseBills.companyId, companyId),
    ne(schema.purchaseBills.status, 'Cancelled'),
    gte(schema.purchaseBills.date, from),
    lte(schema.purchaseBills.date, to),
  ));
  const billIds = bills.map(b => b.id);
  const reducedReturns: any[] = billIds.length
    ? await executor.select().from(schema.purchaseReturns).where(and(
        eq(schema.purchaseReturns.companyId, companyId),
        eq(schema.purchaseReturns.status, 'Active'),
        eq(schema.purchaseReturns.billTotalsReduced, true),
        inArray(schema.purchaseReturns.billId, billIds),
      ))
    : [];
  const addBackByBill = new Map<string, { net: number; vat: number }>();
  for (const r of reducedReturns) {
    const cur = addBackByBill.get(r.billId) || { net: 0, vat: 0 };
    // add back only what the return actually took off the bill (older rows: the whole return)
    const net = Number(r.netAdjustment || 0), vat = Number(r.inputVatAdjustment || 0);
    const reduction = r.billReduction != null ? Number(r.billReduction) : net + vat;
    const vatPart = net + vat > 0 ? round2(reduction * vat / (net + vat)) : 0;
    addBackByBill.set(r.billId, { net: round2(cur.net + (reduction - vatPart)), vat: round2(cur.vat + vatPart) });
  }

  const lines: BillVatLine[] = [];
  let subtotal = 0, vat = 0;
  for (const b of bills) {
    const add = addBackByBill.get(b.id) || { net: 0, vat: 0 };
    const sub = round2(Number(b.subTotal) + add.net);
    const tax = round2(Number(b.taxTotal) + add.vat);
    subtotal = round2(subtotal + sub);
    vat = round2(vat + tax);
    lines.push({ kind: 'Bill', documentNumber: b.billNumber, date: b.date.toISOString().slice(0, 10), vendorId: b.vendorId, branchId: b.branchId ?? null, subtotal: sub, vat: tax, gross: round2(sub + tax) });
  }

  const returns: any[] = await executor.select().from(schema.purchaseReturns).where(and(
    eq(schema.purchaseReturns.companyId, companyId),
    eq(schema.purchaseReturns.status, 'Active'),
    isNotNull(schema.purchaseReturns.inputVatAdjustment),
    gte(schema.purchaseReturns.date, from),
    lte(schema.purchaseReturns.date, to),
  ));
  for (const r of returns) {
    const net = round2(Number(r.netAdjustment || 0));
    const tax = round2(Number(r.inputVatAdjustment || 0));
    subtotal = round2(subtotal - net);
    vat = round2(vat - tax);
    lines.push({ kind: 'Return', documentNumber: r.returnNumber, date: r.date.toISOString().slice(0, 10), vendorId: r.vendorId, branchId: null, subtotal: -net, vat: -tax, gross: round2(-(net + tax)) });
  }

  return { subtotal, vat, billCount: bills.length, returnCount: returns.length, lines };
}
