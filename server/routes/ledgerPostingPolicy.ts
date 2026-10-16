// Posting control (docs/design-notes/posting-control.md): the company's lock date and back-dating rules. Everyone signed in may READ the policy (document forms need it to ask
// for a reason); changing it needs postingControl.update. The rules themselves are enforced in server/lib/postingGuard.ts.
import express from 'express';
import { eq } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { generateId } from '../../src/id.js';
import { withTenantDb, tenantDb } from '../lib/tenantDb.js';
import { hasPermission } from '../lib/authz.js';
import { recordAuditLog } from '../lib/audit.js';
import { nowDate } from '../lib/clock.js';
import { loadPostingPolicy } from '../lib/postingGuard.js';

const router = express.Router();
const fail = (res: any, status: number, error: string) => res.status(status).json({ error });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get('/posting-policy', withTenantDb, async (req: any, res) => {
  try {
    const policy = await loadPostingPolicy(tenantDb(), req.targetCompanyId);
    res.json({ ...policy, canBackDate: hasPermission(req.user, 'postingControl.backDate'), canOverrideLock: hasPermission(req.user, 'postingControl.overrideLock'), today: nowDate().toISOString().slice(0, 10) });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

const wholeDays = (v: any, label: string): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 3650) throw Object.assign(new Error(`${label} must be a whole number of days from 0 to 3650, or empty.`), { status: 400 });
  return n;
};

router.put('/posting-policy', withTenantDb, async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'postingControl.update')) return fail(res, 403, 'Forbidden');
    const tdb = tenantDb(); const companyId = req.targetCompanyId; const b = req.body || {};
    let lockDate: string | null = null;
    if (b.lockDate) {
      lockDate = String(b.lockDate);
      if (!DATE_RE.test(lockDate) || isNaN(Date.parse(lockDate))) return fail(res, 400, 'Enter a valid lock date.');
      if (lockDate > nowDate().toISOString().slice(0, 10)) return fail(res, 400, 'The lock date cannot be in the future.');
    }
    const maxBackDays = wholeDays(b.maxBackDays, 'The back-date window');
    const reasonAfterDays = wholeDays(b.reasonAfterDays, 'The reason threshold');
    const before = await loadPostingPolicy(tdb, companyId);
    const [existing] = await tdb.select({ id: schema.postingPolicies.id }).from(schema.postingPolicies).where(eq(schema.postingPolicies.companyId, companyId));
    const values = { lockDate, maxBackDays, reasonAfterDays, updatedAt: nowDate(), updatedById: req.user.id };
    if (existing) await tdb.update(schema.postingPolicies).set(values).where(eq(schema.postingPolicies.id, existing.id));
    else await tdb.insert(schema.postingPolicies).values({ id: generateId(), companyId, ...values });
    recordAuditLog(req, 'UPDATE_POSTING_POLICY', 'posting_policy', existing?.id || null, { before, after: { lockDate, maxBackDays, reasonAfterDays } });
    res.json({ success: true, lockDate, maxBackDays, reasonAfterDays });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

export default router;
