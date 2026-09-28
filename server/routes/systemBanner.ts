import express from 'express';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { isSuperAdminUser } from '../lib/authz.js';
import { recordAuditLog } from '../lib/audit.js';

// Platform-wide, single-row announcement banner — see schema.ts's systemBanner table
// comment for why this deliberately has no companyId and stays on the superuser db.
// `publicRouter` is mounted BEFORE isAuthenticated (server.ts), same as onboarding's own
// public submission route, so the banner still shows on the login screen for someone about
// to log in right as maintenance starts. `adminRouter` is mounted after, super-admin only.
export const publicRouter = express.Router();
export const adminRouter = express.Router();

const SINGLETON_ID = 'singleton';

publicRouter.get('/system-banner', async (_req, res) => {
  try {
    const [row] = await db.select().from(schema.systemBanner).where(eq(schema.systemBanner.id, SINGLETON_ID));
    res.json({ enabled: row?.enabled ?? false, message: row?.message ?? '', updatedAt: row?.updatedAt ?? null });
  } catch (err) {
    console.error('[SystemBanner] GET failed:', err);
    // Fail closed to "no banner" rather than surfacing a 500 to every logged-out visitor —
    // this endpoint is polled constantly and must never be why the login screen breaks.
    res.json({ enabled: false, message: '', updatedAt: null });
  }
});

adminRouter.put('/system-banner', async (req: any, res) => {
  if (!isSuperAdminUser(req.user)) return res.status(403).json({ error: 'Forbidden' });

  const enabled = Boolean(req.body?.enabled);
  const message = String(req.body?.message ?? '').trim().slice(0, 2000);
  if (enabled && !message) return res.status(400).json({ error: 'Message is required when enabling the banner.' });

  const [row] = await db.insert(schema.systemBanner)
    .values({ id: SINGLETON_ID, enabled, message, updatedBy: req.user.id, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.systemBanner.id,
      set: { enabled, message, updatedBy: req.user.id, updatedAt: new Date() },
    })
    .returning();

  await recordAuditLog(req, enabled ? 'SYSTEM_BANNER_ENABLED' : 'SYSTEM_BANNER_DISABLED', 'SystemBanner', SINGLETON_ID, { message });
  res.json({ enabled: row.enabled, message: row.message, updatedAt: row.updatedAt });
});
