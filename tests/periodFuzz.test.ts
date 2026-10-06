import { describe, it, expect, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { generateId } from '../src/id.js';
import { provisionStarterResources } from '../server/lib/companyProvisioning.js';
import { purgeCompany } from './helpers/purgeCompany.js';

// SEEDED SIMULATION (API-driven regression/fuzz; the real screens are exercised separately). A company runs several simulated months day by
// day on the developer clock, performing random but VALID business actions — sales, purchases, payments, credit notes, vendor returns,
// reversals, accruals, transfers, stock counts — closing each month and filing each quarter's VAT. After EVERY operation the whole rule set
// (GET /api/reports/consistency-check) must hold and no operation may fail with a server error. A violation is reproducible from the seed:
//   FUZZ_SEEDS=7,11 FUZZ_DAYS=100 npx vitest run tests/periodFuzz.test.ts
const BASE_URL = 'http://localhost:3000';
const PW = 'AutoTest_Pw_2026!';
const SEEDS = (process.env.FUZZ_SEEDS || '1,2,3').split(',').map(Number);
const DAYS = Number(process.env.FUZZ_DAYS || 70);

function rng(seed: number) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const now = new Date();
const q0 = Math.floor(now.getUTCMonth() / 3) * 3;
const Y = now.getUTCFullYear();
const monthId = (offset: number) => { const m = q0 + offset; return `${Y + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`; };
const dim = (ym: string) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

async function simulate(seed: number) {
  const rand = rng(seed);
  const pick = <T,>(a: T[]): T | undefined => a.length ? a[Math.floor(rand() * a.length)] : undefined;
  const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const log: string[] = [];

  const companyId = generateId();
  const NAME = `Fuzz ${seed} ${companyId.slice(0, 6)}`;
  await db.insert(schema.companies).values({ id: companyId, name: NAME, address: 'x', phone: '0', email: 'fz@example.com', logoUrl: '', customHeader: '', customFooter: '', currency: 'SAR', counters: {}, zatcaEnabled: false, inventorySettings: { prOptionality: 'OPTIONAL', isDsdAllowed: true } } as any);
  try {
    await db.transaction(async (tx: any) => provisionStarterResources(tx, { companyId, companyName: NAME }));
    const one = async (table: any, col: any) => (await db.select().from(table).where(eq(col, companyId)))[0] as any;
    const bankId = (await one(schema.bankAccounts, schema.bankAccounts.companyId)).id;
    const customerId = (await one(schema.customers, schema.customers.companyId)).id;
    const vendorId = (await one(schema.vendors, schema.vendors.companyId)).id;
    const taxSlabId = (await one(schema.taxSlabs, schema.taxSlabs.companyId)).id;
    const warehouseId = (await one(schema.warehouses, schema.warehouses.companyId)).id;
    const warehouse2Id = generateId();
    await db.insert(schema.warehouses).values({ id: warehouse2Id, name: 'Second Warehouse', code: 'WH2', isActive: true, companyId, type: 'sales', isCompanyDefault: false } as any);
    const bank2Id = generateId();
    await db.insert(schema.bankAccounts).values({ id: bank2Id, bankName: 'Second Bank', accountNumber: '222', accountTitle: 'Second', openingBalance: '0', companyId, isActive: true } as any);
    const P = generateId(), S = generateId(), P2 = generateId();
    await db.insert(schema.productsServices).values([
      { id: P2, name: 'Fuzz Item Two', description: 'Fuzz Item Two', unitPrice: '80', costPrice: '50', itemKind: 'item', companyId, averageCost: '0', totalQuantityPurchased: '0' },
      { id: P, name: 'Fuzz Item', description: 'Fuzz Item', unitPrice: '150', costPrice: '100', itemKind: 'item', companyId, averageCost: '0', totalQuantityPurchased: '0' },
      { id: S, name: 'Fuzz Service', description: 'Fuzz Service', unitPrice: '400', costPrice: '0', itemKind: 'service', companyId },
    ] as any);
    const userId = generateId(); const username = `fz_${userId.slice(-10)}`;
    await db.insert(schema.users).values({ id: userId, username, password: await bcrypt.hash(PW, 10), role: 'admin', companyId, isSuperAdmin: false });
    const sessionId = (await (await fetch(`${BASE_URL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PW }) })).json()).sessionId;
    if (!sessionId) throw new Error('login failed');

    let clock = '';
    const call = async (method: string, path: string, body?: any) => {
      const res = await fetch(`${BASE_URL}${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, 'x-dev-date': clock }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json().catch(() => ({})) as any };
    };
    const rep = async (name: string, q: string) => (await call('GET', `/api/reports/${name}?${q}`)).body;
    const D = (d: number, m: string) => `${m}-${String(Math.min(d, dim(m))).padStart(2, '0')}`;
    // a user-dated document: usually today, sometimes an earlier day of the same (open) month
    const docDate = () => { const dd = Number(clock.slice(8, 10)); return rand() < 0.2 && dd > 1 ? `${clock.slice(0, 8)}${String(between(1, dd - 1)).padStart(2, '0')}` : clock; };

    // ---- state the simulation keeps about what exists ----
    const invs: any[] = [], exps: any[] = [], grns: any[] = [], bills: any[] = [], rets: any[] = [], transit: any[] = [];
    let accrualTemplate = '';
    let ops = 0;

    const step = async (label: string, run: () => Promise<{ status: number; body: any }>, onOk?: (b: any) => void) => {
      const r = await run();
      ops++;
      log.push(`${clock} ${label} -> ${r.status}${r.status !== 200 ? ' ' + String(r.body?.error || '').slice(0, 70) : ''}`);
      expect(r.status, `seed ${seed} op ${ops} ${clock} ${label}: server error ${JSON.stringify(r.body).slice(0, 200)}\n${log.slice(-12).join('\n')}`).toBeLessThan(500);
      if (r.status === 200 && onOk) onOk(r.body);
      const c = await rep('consistency-check', `asOfDate=${clock}`);
      const bad = (c.checks || []).filter((x: any) => !x.ok && x.severity === 'error');
      expect(Array.isArray(c.checks) && c.checks.length > 10, `seed ${seed}: consistency check did not run`).toBe(true);
      expect(bad, `seed ${seed} op ${ops} on ${clock} after "${label}" (status ${r.status}): ${bad.map((x: any) => `[${x.id}] ${x.rule} -> ${x.detail}`).join(' || ')}\n${log.slice(-15).join('\n')}`).toEqual([]);
      return r;
    };

    // ---- the clock starts at the first month; open the quarter's months ----
    const M = [monthId(0), monthId(1), monthId(2), monthId(3), monthId(4)];
    clock = D(1, M[0]);
    for (const m of [M[1], M[2]]) await call('POST', '/api/transactions/months', { id: m, name: `Month ${m}`, status: 'Open' });
    // capital and the second bank float on day 1
    await call('POST', '/api/transactions/investors', { name: 'Fuzz Investor', email: 'i@example.com', phone: '1', equityPercentage: 100, profitPercentage: 100, capitalContributed: 0, isActive: true, createdAt: new Date().toISOString() });
    const investorId = ((await db.select().from(schema.investors).where(eq(schema.investors.companyId, companyId))) as any[])[0].id;
    await step('capital', () => call('POST', `/api/transactions/investors/${investorId}/investment`, { bankId, amount: 50000, date: clock, description: 'Capital' }));

    const openMonths = new Set([M[0], M[1], M[2]]);
    const closed = new Set<string>();
    const filedQuarters = new Set<number>();
    const tplRes = await call('POST', '/api/transactions/recurring-templates', { description: 'Rent', defaultAmount: 230, bankId, vendorId, taxSlabId, isActive: true });
    accrualTemplate = tplRes.body.id;

    // ---- the days ----
    const totalDays = Math.min(DAYS, 4 * 28);
    let dayCount = 0;
    for (let mi = 0; mi < 4 && dayCount < totalDays; mi++) {
      const m = M[mi];
      for (let d = 1; d <= 28 && dayCount < totalDays; d++) {
        dayCount++;
        clock = D(d, m);
        if (new Date(clock + 'T00:00:00Z').getUTCDay() === 5) continue;      // Fridays are rest days
        const actions = between(0, 3);
        for (let a = 0; a < actions; a++) {
          const roll = rand();
          const today = clock;
          // purchasing
          if (roll < 0.10) {
            const qty = between(3, 15);
            const pid = rand() < 0.65 ? P : P2;
            const cost = pid === P ? pick([90, 100, 110, 120])! : pick([45, 50, 55])!;
            const r = await step(`GRN ${qty} @${cost}${pid === P2 ? ' (item two)' : ''}`, () => call('POST', '/api/inventory/goods-receipt-notes', { grnData: { isDsd: true, vendorId, warehouseId, receivedBy: 'Fuzz', items: [{ productId: pid, quantityReceived: qty, unitCost: cost, taxRate: 15 }] } }), b => grns.push({ id: b.goodsReceiptNote.id, qty, returned: 0, billed: false, reversed: false, date: today, pid }));
            const g = grns[grns.length - 1];
            if (r.status === 200 && rand() < 0.75) {
              await step('bill', () => call('POST', '/api/inventory/purchase-bills', { billData: { grnIds: [g.id], bankId, date: docDate(), vendorBillNumber: 'F' + ops } }), b => { g.billed = true; bills.push({ id: b.purchaseBill.id, grnId: g.id, gross: Number(b.purchaseBill.grandTotal), paid: 0, date: today, cancelled: false }); });
            }
          }
          // selling
          else if (roll < 0.30) {
            const lines: any[] = []; const nLines = between(1, 3);
            for (let l = 0; l < nLines; l++) {
              const kind = pick(['stock', 'stock', 'stock2', 'service', 'typed'])!;
              const qty = between(1, 4); const disc = rand() < 0.2 ? between(1, 8) : 0;
              lines.push(kind === 'stock' ? { productId: P, unitCost: 150, quantity: qty, discountAmount: disc, stock: true }
                : kind === 'stock2' ? { productId: P2, unitCost: 80, quantity: qty, discountAmount: disc, stock: true }
                : kind === 'service' ? { productId: S, unitCost: 400, quantity: qty, discountAmount: disc, stock: false }
                : { unitCost: 60, quantity: qty, discountAmount: disc, stock: false });
            }
            let net = 0, tax = 0;
            for (const l of lines) { const base = Math.round((l.unitCost - l.discountAmount) * l.quantity * 100) / 100; net += base; tax += Math.round(base * 0.15 * 100) / 100; }
            const gross = Math.round((net + tax) * 100) / 100;
            const paid = rand() < 0.4 ? gross : rand() < 0.5 ? Math.round(gross * 0.4 * 100) / 100 : 0;
            const pos = lines.every(l => l.stock) && rand() < 0.3;
            const date = docDate();
            await step(`${pos ? 'POS' : 'invoice'} ${lines.length} line(s) ${gross}${date !== today ? ' dated ' + date : ''}`, () => call('POST', '/api/transactions/invoices', { invoiceData: { date, customerId, taxSlabId, bankId, notes: '', status: 'Active', amountPaid: pos ? gross : paid, ...(pos ? { isPosSale: true } : {}), items: lines.map(l => ({ id: generateId(), description: l.productId ? 'Fuzz line' : 'Typed line', unitCost: l.unitCost, quantity: l.quantity, discountAmount: l.discountAmount, ...(l.productId ? { productId: l.productId } : {}) })) } }),
              b => invs.push({ id: b.invoiceId, date, gross, paid: pos ? gross : paid, stock: lines.some(l => l.stock), pos, cancelled: false, credited: false }));
          }
          else if (roll < 0.33) {   // a POS sale partly returned
            const i = pick(invs.filter(x => x.pos && !x.cancelled && !x.credited && !x.returnedOnce));
            if (i) {
              const item = ((await db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, i.id))) as any[])[0];
              if (item) await step('POS partial return', () => call('POST', '/api/pos/returns', { invoiceId: i.id, items: [{ invoiceItemId: item.id, quantity: 1 }], reason: 'Fuzz return' }), () => { i.returnedOnce = true; });
            }
          }
          else if (roll < 0.35) {   // quotation, converted
            const price = between(1, 5) * 100;
            await call('POST', '/api/transactions/quotations', { quotationData: { date: today, customerId, taxSlabId, notes: `Fuzz quote ${ops}`, status: 'Accepted', createdById: userId, items: [{ id: generateId(), description: 'Quoted', unitCost: price, quantity: 1, unit: 'PCE', productId: S }] } });
            const q = ((await db.select().from(schema.quotations).where(eq(schema.quotations.companyId, companyId))) as any[]).find(x => x.notes === `Fuzz quote ${ops}`);
            if (q) await step('convert quotation', () => call('POST', `/api/transactions/quotations/${q.id}/convert`, { invoiceDate: today, bankId, paymentStatus: 'Unpaid', customCustomerId: customerId, customTaxSlabId: taxSlabId }));
          }
          else if (roll < 0.40) {   // collect on an unpaid invoice
            const i = pick(invs.filter(x => !x.cancelled && !x.credited && x.paid < x.gross - 0.01));
            if (i) { const amt = Math.round(Math.min(i.gross - i.paid, (i.gross - i.paid) * (0.3 + rand() * 0.7)) * 100) / 100; await step(`collect ${amt}`, () => call('POST', `/api/transactions/invoices/${i.id}/paid`, { paymentDate: today, bankId, amount: amt }), () => { i.paid = Math.round((i.paid + amt) * 100) / 100; }); }
          }
          else if (roll < 0.46) {   // credit note (any period; dated today)
            const i = pick(invs.filter(x => !x.cancelled && !x.credited && !x.pos));
            if (i) await step('credit note', () => call('POST', `/api/transactions/invoices/${i.id}/note`, { type: 'CreditNote', reason: 'Fuzz' }), () => { i.credited = true; });
          }
          else if (roll < 0.51) {   // cancel (only unlocked ones will succeed)
            const i = pick(invs.filter(x => !x.cancelled && !x.credited));
            if (i) await step('cancel invoice', () => call('POST', `/api/transactions/invoices/${i.id}/cancel`, {}), () => { i.cancelled = true; });
          }
          // expenses
          else if (roll < 0.62) {
            const gross = between(1, 8) * 115; const capex = rand() < 0.2; const paid = rand() < 0.5 ? gross : 0;
            await step(`expense ${gross}${capex ? ' capex' : ''}`, () => call('POST', '/api/expenses', { date: docDate(), vendorId, taxSlabId, bankId, status: 'Active', type: 'Actual', billNumber: 'X' + ops, description: `Fuzz expense ${ops}`, paymentStatus: paid ? 'Paid' : 'Unpaid', amountPaid: paid, paymentDate: paid ? today : null, amount: gross, ...(capex ? { classification: 'Asset' } : {}) }), () => exps.push({ gross, paid, desc: `Fuzz expense ${ops}`, cancelled: false, reversed: false, id: '' }));
            const e = exps[exps.length - 1];
            if (e && !e.id) { const row = ((await db.select().from(schema.expenses).where(eq(schema.expenses.companyId, companyId))) as any[]).find(x => x.description === e.desc); e.id = row?.id; }
          }
          else if (roll < 0.67) {   // pay an expense
            const e = pick(exps.filter(x => x.id && !x.cancelled && !x.reversed && x.paid < x.gross - 0.01));
            if (e) { const amt = Math.round((e.gross - e.paid) * 100) / 100; await step(`pay expense ${amt}`, () => call('POST', `/api/expenses/${e.id}/pay`, { date: today, bankId, amount: amt }), () => { e.paid = e.gross; }); }
          }
          else if (roll < 0.72) {   // an expense is wrong: cancel (unlocked) or reverse (locked)
            const e = pick(exps.filter(x => x.id && !x.cancelled && !x.reversed));
            if (e) {
              const r = await step('cancel expense', () => call('POST', `/api/expenses/${e.id}/cancel`, {}), () => { e.cancelled = true; });
              if (r.status !== 200) await step('reverse expense', () => call('POST', `/api/expenses/${e.id}/reverse`, {}), () => { e.reversed = true; });
            }
          }
          // vendor side
          else if (roll < 0.78) {
            const g = pick(grns.filter(x => !x.reversed && x.qty - x.returned > 0));
            if (g) { const q = between(1, Math.min(3, g.qty - g.returned)); await step(`vendor return ${q}`, () => call('POST', '/api/inventory/purchase-returns', { returnData: { grnId: g.id, items: [{ productId: g.pid, quantityReturned: q }] } }), b => { g.returned += q; rets.push({ id: b.purchaseReturn.id, cancelled: false }); }); }
          }
          else if (roll < 0.82) {
            const b = pick(bills.filter(x => !x.cancelled && x.paid < x.gross - 0.01));
            if (b) { const amt = Math.round(Math.min(b.gross - b.paid, (b.gross - b.paid) * (0.4 + rand() * 0.6)) * 100) / 100; await step(`pay bill ${amt}`, () => call('POST', `/api/inventory/purchase-bills/${b.id}/pay`, { date: today, bankId, amount: amt }), () => { b.paid = Math.round((b.paid + amt) * 100) / 100; }); }
          }
          else if (roll < 0.84) {
            const r = pick(rets.filter(x => !x.cancelled));
            if (r) await step('cancel vendor return', () => call('PATCH', `/api/inventory/purchase-returns/${r.id}/cancel`, {}), () => { r.cancelled = true; });
          }
          else if (roll < 0.86) {
            const b = pick(bills.filter(x => !x.cancelled && x.paid === 0));
            if (b) await step('cancel bill', () => call('PATCH', `/api/inventory/purchase-bills/${b.id}/cancel`, {}), () => { b.cancelled = true; });
          }
          else if (roll < 0.88) {
            const g = pick(grns.filter(x => !x.billed && !x.reversed && x.returned === 0));
            if (g) await step('reverse unbilled receipt', () => call('POST', `/api/inventory/goods-receipt-notes/${g.id}/reverse`, {}), () => { g.reversed = true; });
          }
          else if (roll < 0.91) {   // a vendor refund when something is owed back
            const bs = await rep('balance-sheet', `asOfDate=${today}`);
            if (bs.vendorCreditReceivable > 0.01) { const amt = Math.round(bs.vendorCreditReceivable * 100) / 100; await step(`vendor refund ${amt}`, () => call('POST', '/api/inventory/vendor-refunds', { vendorId, bankId, amount: amt, date: today })); }
          }
          // money and stock
          else if (roll < 0.94) {
            const fromFirst = rand() < 0.5;
            await step('transfer', () => call('POST', '/api/transactions/interbank-transfer', { sourceBankId: fromFirst ? bankId : bank2Id, destBankId: fromFirst ? bank2Id : bankId, amount: between(1, 20) * 50, description: 'Fuzz', dateStr: today }));
          }
          else if (roll < 0.96) {
            await step('stock adjustment', () => call('POST', '/api/inventory/stock-adjustments', { productId: pick([P, P2])!, warehouseId, quantity: rand() < 0.5 ? -between(1, 2) : between(1, 3), reason: 'Fuzz' }));
          }
          else if (roll < 0.97) {
            const w = ((await db.select().from(schema.inventoryStocks).where(eq(schema.inventoryStocks.warehouseId, warehouseId))) as any[])[0];
            if (w) { const t = await call('POST', '/api/inventory/stock-takes', { stockTakeData: { warehouseId, performedBy: 'Fuzz', items: [{ productId: P, physicalQuantity: Math.max(0, Number(w.quantity) - between(0, 2)) }] } }); if (t.status === 200) await step('stock take', () => call('POST', `/api/inventory/stock-takes/${t.body.stockTake.id}/finalize`, {})); }
          }
          else if (roll < 0.985) {   // goods moved between warehouses: dispatch, receive (sometimes short), or call a dispatch off
            const open = transit.filter(x => !x.done);
            const what = rand();
            if (what < 0.5 || open.length === 0) {
              const q = between(1, 4); const toSecond = rand() < 0.5;
              await step(`dispatch ${q}`, () => call('POST', '/api/inventory/warehouse-dispatches', { dispatchData: { fromWarehouseId: toSecond ? warehouseId : warehouse2Id, toWarehouseId: toSecond ? warehouse2Id : warehouseId, dispatchedBy: 'Fuzz', vehicleNumber: 'V', driverName: 'D', items: [{ productId: P, quantityDispatched: q, batchNumber: null }] } }), b => transit.push({ id: b.dispatch.id, itemId: b.dispatch.items[0].id, q, done: false }));
            } else {
              const t = pick(open)!;
              if (what < 0.85) {
                const short = t.q > 1 && rand() < 0.4 ? 1 : 0;
                await step(`receive dispatch${short ? ' short by 1' : ''}`, () => call('POST', '/api/inventory/warehouse-receivings', { receivingData: { dispatchId: t.id, receivedBy: 'Fuzz', items: [{ dispatchItemId: t.itemId, quantityReceived: t.q - short }] } }), () => { t.done = true; });
              } else {
                await step('cancel dispatch', () => call('POST', `/api/inventory/warehouse-dispatches/${t.id}/cancel`, {}), () => { t.done = true; });
              }
            }
          }
          else {   // accrual, then settle it at a different amount
            const acc = await call('POST', '/api/transactions/recurring-postings', { templateId: accrualTemplate, monthId: today.slice(0, 7), postType: 'Accrual', amount: 230, dateStr: today, paymentStatus: 'Unpaid', bankId });
            ops++; log.push(`${clock} accrual -> ${acc.status}`);
            if (acc.status === 200) {
              const row = ((await db.select().from(schema.expenses).where(eq(schema.expenses.companyId, companyId))) as any[]).filter(x => x.type === 'Accrual' && !x.accrualSettled && x.date === today)[0];
              if (row && rand() < 0.7) { clock = D(Math.min(28, d + 1), m); const actual = between(150, 400); await step(`settle accrual at ${actual}`, () => call('POST', '/api/transactions/settle-accrual', { accrualExpenseId: row.id, actualAmount: actual, actualDate: clock, paymentStatus: 'Paid', bankId })); }
            }
          }
        }
      }

      // ---- month end: close it (the rent template is switched off after its first month); at a quarter's end file the VAT ----
      clock = D(28, m);
      if (mi === 0) await call('PATCH', `/api/transactions/recurring-templates/${accrualTemplate}/toggle`, {});
      const rows = (await call('GET', '/api/transactions/months')).body; const monthRow = (Array.isArray(rows) ? rows : rows.rows).find((x: any) => x.id === m);
      const closeRes = await step(`close ${m}`, () => call('POST', '/api/transactions/months', { ...monthRow, status: 'Closed', closedAt: new Date(`${clock}T12:00:00Z`).toISOString(), closedOption: 'including_pending' }), () => closed.add(m));
      void closeRes;
      if (mi === 2) {   // quarter complete: generate and file on the first day of the next quarter
        clock = D(1, M[3]);
        await call('POST', '/api/transactions/months', { id: M[3], name: `Month ${M[3]}`, status: 'Open' });
        const gen = await step('generate VAT return', () => call('POST', '/api/tax-returns/generate', { year: Number(M[0].slice(0, 4)), quarter: q0 / 3 + 1 }));
        if (gen.status === 200) await step('file VAT return', () => call('POST', `/api/tax-returns/${gen.body.taxReturn.id}/file`, {}), () => filedQuarters.add(q0 / 3 + 1));
      } else if (mi < 2) {
        clock = D(28, m); await call('POST', '/api/transactions/months', { id: M[mi + 3], name: `Month ${M[mi + 3]}`, status: 'Open' }).catch(() => {});
      }
    }
    // final: the whole rule set once more, at the end of the simulated time
    clock = D(28, M[Math.min(3, Math.floor((totalDays - 1) / 28))]);
    const finalCheck = await rep('consistency-check', `asOfDate=${clock}`);
    const bad = (finalCheck.checks || []).filter((x: any) => !x.ok && x.severity === 'error');
    expect(bad, `seed ${seed} final: ${bad.map((x: any) => `[${x.id}] ${x.detail}`).join(' || ')}`).toEqual([]);
    return { ops, warnings: finalCheck.warnings, log };
  } finally {
    await purgeCompany(companyId);
  }
}

describe('seeded day-by-day simulation', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: ${DAYS} days of random valid business keep every rule intact`, async () => {
      const r = await simulate(seed);
      if (process.env.FUZZ_VERBOSE) console.log(`FUZZ seed ${seed}: ${r.ops} operations, ${r.warnings} warnings`);
      expect(r.ops).toBeGreaterThan(20);
    }, 1800000);
  }
});
