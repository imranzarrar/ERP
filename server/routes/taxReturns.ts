import express from 'express';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { generateId } from '../../src/id.js';
import { hasPermission } from '../lib/authz.js';
import { computeVatReturnFigures, getQuarterDateRange, assertNoUnreportedZatcaInvoices } from '../lib/vatReturn.js';

const router = express.Router();

// --- VAT Returns (ZATCA Filing) ---

router.get('/tax-returns', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'taxReturns.read')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    // Includes soft-deleted rows, clearly flagged via isDeleted — matches this app's
    // "retired records still show up, marked as such" convention (never disappear).
    const rows = await db.select().from(schema.taxReturns)
      .where(eq(schema.taxReturns.companyId, companyId))
      .orderBy(schema.taxReturns.year, schema.taxReturns.quarter);
    res.json(rows);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/tax-returns/generate', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'taxReturns.create')) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    const year = Number(req.body?.year);
    const quarter = Number(req.body?.quarter);
    if (!year || !Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
      return res.status(400).json({ error: 'A valid year and quarter (1-4) are required.' });
    }

    const created = await db.transaction(async (tx) => {
      // Defense-in-depth alongside the partial unique index — a clean 400 instead of a
      // raw constraint-violation 500 for the common case of a duplicate generate.
      const [existing] = await tx.select({ id: schema.taxReturns.id, referenceNumber: schema.taxReturns.referenceNumber })
        .from(schema.taxReturns)
        .where(and(
          eq(schema.taxReturns.companyId, companyId),
          eq(schema.taxReturns.year, year),
          eq(schema.taxReturns.quarter, quarter),
          eq(schema.taxReturns.isDeleted, false)
        ));
      if (existing) {
        const err: any = new Error(`${existing.referenceNumber} already exists. Delete it first if you need to regenerate.`);
        err.status = 400;
        throw err;
      }

      const { startDate, endDate } = getQuarterDateRange(year, quarter as 1 | 2 | 3 | 4);
      // Checked at GENERATE time too, not just FILE time — see assertNoUnreportedZatcaInvoices's
      // own comment for why: no point drafting a return while invoices that feed it are
      // still mid-flight or failed on the ZATCA e-invoicing side.
      await assertNoUnreportedZatcaInvoices(tx, companyId, startDate, endDate);
      const figures = await computeVatReturnFigures(companyId, year, quarter);

      const [row] = await tx.insert(schema.taxReturns).values({
        id: generateId(),
        companyId,
        year,
        quarter,
        referenceNumber: `Q${quarter}-${year}`,
        startDate,
        endDate,
        status: 'Generated',
        isDeleted: false,
        figuresSnapshot: figures,
        generatedAt: new Date(),
        generatedById: req.user.id,
      }).returning();
      return row;
    });

    res.json({ success: true, taxReturn: created });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Soft-delete — action route rather than a DELETE verb, matching this app's "delete is a
// status flip" convention (e.g. expense /cancel). Only ever allowed on a Generated row;
// a Filed row is permanently locked, no exceptions, checked unconditionally regardless
// of the taxReturns.delete permission (same shape as the ZATCA invoice-immutability check).
router.post('/tax-returns/:id/delete', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'taxReturns.delete')) return res.status(403).json({ error: 'Forbidden' });
    const { id } = req.params;
    const companyId = req.targetCompanyId;

    const [row] = await db.select().from(schema.taxReturns).where(and(eq(schema.taxReturns.id, id), eq(schema.taxReturns.companyId, companyId)));
    if (!row) return res.status(404).json({ error: 'Tax return not found.' });
    if (row.status === 'Filed') {
      return res.status(400).json({ error: 'This return has already been filed with ZATCA and is permanently locked — it cannot be deleted.' });
    }
    if (row.isDeleted) return res.status(400).json({ error: 'This return has already been deleted.' });

    await db.update(schema.taxReturns).set({ isDeleted: true }).where(eq(schema.taxReturns.id, id));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// The one-way door. Gated on its own leaf (taxReturns.file), separate from create/delete —
// filing is a materially bigger, harder-to-reverse authority, same reasoning as
// fiscalMonths.close getting its own leaf apart from .open.
router.post('/tax-returns/:id/file', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'taxReturns.file')) return res.status(403).json({ error: 'Forbidden' });
    const { id } = req.params;
    const companyId = req.targetCompanyId;

    await db.transaction(async (tx) => {
      // Row-locked for the duration of this transaction to prevent a concurrent double-file
      // — mirrors the ZATCA invoice-cancel race-guard pattern in transactions.ts.
      const [row] = await tx.select().from(schema.taxReturns)
        .where(and(eq(schema.taxReturns.id, id), eq(schema.taxReturns.companyId, companyId)))
        .for('update');
      if (!row) { const err: any = new Error('Tax return not found.'); err.status = 404; throw err; }
      if (row.isDeleted) { const err: any = new Error('This return has been deleted and cannot be filed. Regenerate it first.'); err.status = 400; throw err; }
      if (row.status === 'Filed') { const err: any = new Error('This return has already been filed with ZATCA.'); err.status = 400; throw err; }

      // Sequential-filing-order rule: to file (Y,Q), the immediately-preceding quarter P
      // must already be Filed IF this company has any non-deleted row strictly earlier
      // than (Y,Q) at all. A company with zero rows before (Y,Q) is filing its first-ever
      // tracked quarter and passes unconditionally — there is no way to know a true
      // VAT-registration start date, so the earliest quarter this tool ever touches
      // anchors the sequence. This forces "no skipping a quarter once you're tracking
      // earlier ones" without requiring every quarter back to year zero to exist.
      const allRows = await tx.select({ year: schema.taxReturns.year, quarter: schema.taxReturns.quarter, status: schema.taxReturns.status })
        .from(schema.taxReturns)
        .where(and(eq(schema.taxReturns.companyId, companyId), eq(schema.taxReturns.isDeleted, false)));
      const isEarlier = (y: number, q: number) => y < row.year || (y === row.year && q < row.quarter);
      const hasEarlierRow = allRows.some(r => isEarlier(r.year, r.quarter));
      if (hasEarlierRow) {
        const prevQuarter = row.quarter === 1 ? 4 : row.quarter - 1;
        const prevYear = row.quarter === 1 ? row.year - 1 : row.year;
        const prev = allRows.find(r => r.year === prevYear && r.quarter === prevQuarter);
        if (!prev || prev.status !== 'Filed') {
          const err: any = new Error(`Q${prevQuarter}-${prevYear} must be generated and filed before ${row.referenceNumber} can be filed.`);
          err.status = 400;
          throw err;
        }
      }

      // Re-checked at file time too (not just generate time) — new invoices can appear,
      // or an invoice's ZATCA status can change, in the window between generating a
      // draft and actually filing it. Filing while any invoice that feeds this quarter's
      // figures is still mid-flight or failed on the e-invoicing side would self-attest
      // a number ZATCA's own e-invoicing pipeline might still reject or hasn't seen at all.
      await assertNoUnreportedZatcaInvoices(tx, companyId, row.startDate, row.endDate);

      await tx.update(schema.taxReturns).set({ status: 'Filed', filedAt: new Date(), filedById: req.user.id }).where(eq(schema.taxReturns.id, id));
    });

    const [updated] = await db.select().from(schema.taxReturns).where(eq(schema.taxReturns.id, id));
    res.json({ success: true, taxReturn: updated });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

export default router;
