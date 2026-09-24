// Bulk (spreadsheet) import for master data — see docs plan discussion (2026-09-24) and
// server/lib/productImport.ts for why the actual business rules live there, not here: this
// file is the thin HTTP layer (auth, permission, file upload) around that shared logic.
// Product/Service Master is the first master wired up; Vendor and Customer Master follow
// the same pattern later.
import express from 'express';
import multer from 'multer';
import { normalizePermissions } from '../../src/types.js';
import { withTenantDb, tenantDb } from '../lib/tenantDb.js';
import {
  PRODUCT_IMPORT_MAX_ROWS, buildProductTemplate, parseWorkbook, validateProductRows, commitProductRows,
} from '../lib/productImport.js';

const router = express.Router();

// Memory storage only — the file is parsed once and discarded, never written to disk
// (matches this app's existing convention: no filesystem-dependent state anywhere, see
// server/lib/companyLogo.ts's own comment on the same point). 5MB comfortably covers a
// few thousand rows of plain spreadsheet data.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.get('/master-import/products/template', withTenantDb, async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.products.create.enabled) return res.status(403).json({ error: 'Forbidden' });
    const buf = buildProductTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="product-import-template.xlsx"');
    res.send(buf);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

function parseAndCheckRows(req: any, res: any): ReturnType<typeof parseWorkbook>['rows'] | null {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded.' });
    return null;
  }
  const { rows, error } = parseWorkbook(req.file.buffer);
  if (error) {
    res.status(400).json({ error });
    return null;
  }
  if (rows.length === 0) {
    res.status(400).json({ error: 'No data rows found in the file (only a header row, or the file is empty).' });
    return null;
  }
  if (rows.length > PRODUCT_IMPORT_MAX_ROWS) {
    res.status(400).json({ error: `This file has ${rows.length} rows — the limit per upload is ${PRODUCT_IMPORT_MAX_ROWS}. Split it into smaller files.` });
    return null;
  }
  return rows;
}

// Validate-only: parses and checks every row, writes nothing. Used to show the review
// table before the user confirms anything.
router.post('/master-import/products/validate', withTenantDb, upload.single('file'), async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.products.create.enabled) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });

    const rows = parseAndCheckRows(req, res);
    if (!rows) return;

    const results = await validateProductRows(tenantDb(), companyId, rows);
    const summary = {
      totalRows: results.length,
      toCreate: results.filter(r => r.action === 'create').length,
      toUpdate: results.filter(r => r.action === 'update').length,
      errors: results.filter(r => r.action === 'error').length,
    };
    res.json({
      summary,
      rows: results.map(r => ({ rowNumber: r.rowNumber, name: r.name, action: r.action, errors: r.errors })),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Commit: re-parses and re-validates the SAME file from scratch (never trusts a
// client-echoed "this row is valid" from the earlier /validate call — another user could
// have created a conflicting row, or a category could have been deleted, in between).
// excludeRows (a JSON array of spreadsheet row numbers, from the review screen's
// unchecked rows) is the only other input trusted from the client.
router.post('/master-import/products/commit', withTenantDb, upload.single('file'), async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.products.create.enabled) return res.status(403).json({ error: 'Forbidden' });
    const companyId = req.targetCompanyId;
    if (!companyId) return res.status(400).json({ error: 'No company selected.' });

    const rows = parseAndCheckRows(req, res);
    if (!rows) return;

    let excludeRowNumbers = new Set<number>();
    if (req.body.excludeRows) {
      try {
        const parsed = JSON.parse(req.body.excludeRows);
        if (Array.isArray(parsed)) excludeRowNumbers = new Set(parsed.map(Number).filter(Number.isFinite));
      } catch {
        return res.status(400).json({ error: 'excludeRows must be a JSON array of row numbers.' });
      }
    }

    const outcomes = await commitProductRows(tenantDb(), companyId, rows, excludeRowNumbers);
    const summary = {
      created: outcomes.filter(o => o.action === 'created').length,
      updated: outcomes.filter(o => o.action === 'updated').length,
      skipped: outcomes.filter(o => o.action === 'skipped').length,
    };
    res.json({ summary, rows: outcomes });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
