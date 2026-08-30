import express from 'express';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { isAdminUser, isSuperAdminUser, assertOwnsRow, hasPermission } from '../lib/authz.js';
import { generateId } from '../../src/id.js';

const router = express.Router();

// --- Document Templates (company-scoped print templates) ---
// Admin tier always passes; a non-admin actor may also reach these via the delegated
// `templates.*` permission (cosmetic/reversible — doesn't touch financial or ZATCA
// submission data, safe to hand to e.g. an IT/design-focused role).
const TEMPLATE_FIELDS = ['name', 'language', 'pageSize', 'isActive', 'printHeader', 'printFooter', 'printLogo', 'printQrCode', 'layoutJson', 'gridGapY', 'globalFontFamily'];

router.get('/templates', async (req: any, res) => {
  try {
    if (!isAdminUser(req.user) && !hasPermission(req.user, 'templates.read')) return res.status(403).json({ error: 'Forbidden' });
    const templates = await db.select().from(schema.documentTemplates).where(eq(schema.documentTemplates.companyId, req.targetCompanyId));
    res.json(templates);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/templates', async (req: any, res) => {
  try {
    const data0: any = req.body;
    const isEdit = Boolean(data0?.id);
    const requiredLeaf = isEdit ? 'templates.update' : 'templates.create';
    if (!isAdminUser(req.user) && !hasPermission(req.user, requiredLeaf)) return res.status(403).json({ error: 'Forbidden' });
    const data: any = { ...req.body };
    if (!data.name || !String(data.name).trim()) {
      return res.status(400).json({ error: 'Template name is required.' });
    }

    if (data.id) {
      const [existing] = await db.select().from(schema.documentTemplates).where(eq(schema.documentTemplates.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this template belongs to another company' });
      }
    } else {
      data.id = generateId();
    }

    const insertData: any = { id: data.id, companyId: req.targetCompanyId };
    for (const f of TEMPLATE_FIELDS) if (data[f] !== undefined) insertData[f] = data[f];

    await db.insert(schema.documentTemplates).values(insertData).onConflictDoUpdate({
      target: schema.documentTemplates.id,
      set: insertData
    });
    res.json({ success: true, id: data.id });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Single PATCH backs all of: toggle print option, update an arbitrary property, save the
// Canvas Designer's layout JSON, AND activation. Activation (isActive: true) runs inside a
// transaction that first deactivates same-company/language siblings — mirrors taxSlabs's
// isDefault handling in masterEntities.ts, same partial-unique-index shape as this table's
// own `unique_active_template` (companyId, language) WHERE is_active = true.
router.patch('/templates/:id', async (req: any, res) => {
  try {
    if (!isAdminUser(req.user) && !hasPermission(req.user, 'templates.update')) return res.status(403).json({ error: 'Forbidden' });
    const { id } = req.params;
    const [existing] = await db.select().from(schema.documentTemplates).where(eq(schema.documentTemplates.id, id));
    if (!existing) return res.status(404).json({ error: 'Template not found.' });
    if (!assertOwnsRow(existing, req)) {
      return res.status(403).json({ error: 'Forbidden: this template belongs to another company' });
    }

    const updates: any = {};
    for (const f of TEMPLATE_FIELDS) if (req.body[f] !== undefined) updates[f] = req.body[f];
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No fields to update.' });

    if (updates.isActive === true) {
      await db.transaction(async (tx) => {
        await tx.update(schema.documentTemplates)
          .set({ isActive: false })
          .where(and(
            eq(schema.documentTemplates.companyId, existing.companyId),
            eq(schema.documentTemplates.language, existing.language),
            eq(schema.documentTemplates.isActive, true)
          ));
        await tx.update(schema.documentTemplates).set(updates).where(eq(schema.documentTemplates.id, id));
      });
    } else {
      await db.update(schema.documentTemplates).set(updates).where(eq(schema.documentTemplates.id, id));
    }
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/templates/:id', async (req: any, res) => {
  try {
    if (!isAdminUser(req.user) && !hasPermission(req.user, 'templates.delete')) return res.status(403).json({ error: 'Forbidden' });
    const { id } = req.params;
    const [existing] = await db.select().from(schema.documentTemplates).where(eq(schema.documentTemplates.id, id));
    if (!existing) return res.status(404).json({ error: 'Template not found.' });
    if (!assertOwnsRow(existing, req)) {
      return res.status(403).json({ error: 'Forbidden: this template belongs to another company' });
    }
    await db.delete(schema.documentTemplates).where(eq(schema.documentTemplates.id, id));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Translations (global UX dictionary — schema.ts's `translations` table has no
// companyId, deliberately shared across every tenant). AdminSettings.tsx already gates its
// Translations sub-tab to super-admins only (`superAdminOnly: true`); mirrored here. ---
router.get('/translations', async (req: any, res) => {
  try {
    if (!isSuperAdminUser(req.user)) return res.status(403).json({ error: 'Forbidden' });
    const translations = await db.select().from(schema.translations);
    res.json(translations);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/translations', async (req: any, res) => {
  try {
    if (!isSuperAdminUser(req.user)) return res.status(403).json({ error: 'Forbidden' });
    const data: any = {
      id: req.body.id || generateId(),
      key: req.body.key ?? '',
      en: req.body.en ?? '',
      ar: req.body.ar ?? '',
      ur: req.body.ur ?? '',
    };
    await db.insert(schema.translations).values(data).onConflictDoUpdate({
      target: schema.translations.id,
      set: data
    });
    res.json({ success: true, id: data.id });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/translations/:id', async (req: any, res) => {
  try {
    if (!isSuperAdminUser(req.user)) return res.status(403).json({ error: 'Forbidden' });
    const { id } = req.params;
    const updates: any = {};
    for (const f of ['key', 'en', 'ar', 'ur']) if (req.body[f] !== undefined) updates[f] = req.body[f];
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No fields to update.' });

    const result = await db.update(schema.translations).set(updates).where(eq(schema.translations.id, id)).returning();
    if (result.length === 0) return res.status(404).json({ error: 'Translation not found.' });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/translations/:id', async (req: any, res) => {
  try {
    if (!isSuperAdminUser(req.user)) return res.status(403).json({ error: 'Forbidden' });
    const { id } = req.params;
    await db.delete(schema.translations).where(eq(schema.translations.id, id));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Bulk upsert and the Auto-Translate (Gemini) flow it backed were removed by explicit
// product decision: the Translations tab now edits one record per explicit user action
// (Create/Update/Delete), never a whole-array sync — see BACKLOG.md for the writeup.

export default router;
