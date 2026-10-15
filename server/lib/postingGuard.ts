// The one place that decides whether a posting date is allowed (docs/posting-control.md). Every route that posts something dated, or reverses something at its
// own date, calls assertPostingAllowed() instead of repeating "open month + VAT quarter" pairs, so the rules below cannot be applied to one document type and
// forgotten on another:
//   1. the fiscal month: it must exist, be open, and not be in the future                           (validateTransactionDate)
//   2. the VAT quarter: not generated / filed for a tax document, not filed for the rest            (assertQuarterNotFrozen / assertQuarterNotFiled)
//   3. the company's posting policy (table posting_policies, edited on the Posting Control screen):
//        lock date      nothing may be dated on or before it, except for someone holding postingControl.overrideLock
//        back-date days nothing may be dated more than N days before today, except for someone holding postingControl.backDate
//        reason         a back-dated posting older than N days must carry a reason (request field backDateReason)
//      A posting that used an override, or that carries a reason, is written to the audit log as BACKDATED_POSTING.
// With no policy row, steps 1 and 2 are exactly what every route did before.
import { and, eq } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { tenantDb } from './tenantDb.js';
import { hasPermission } from './authz.js';
import { recordAuditLog } from './audit.js';
import { nowDate } from './clock.js';
import { validateTransactionDate, assertQuarterNotFiled, assertQuarterNotFrozen } from './businessLogic.js';

export type VatMode = 'frozen' | 'filed' | 'none';
export interface PostingPolicy { lockDate: string | null; maxBackDays: number | null; reasonAfterDays: number | null }
const NO_POLICY: PostingPolicy = { lockDate: null, maxBackDays: null, reasonAfterDays: null };
const fail = (message: string) => Object.assign(new Error(message), { status: 400 });
const DAY = 86400000;
const dayNumber = (d: string) => Math.floor(Date.parse(d + 'T00:00:00.000Z') / DAY);

export async function loadPostingPolicy(tdb: any, companyId: string): Promise<PostingPolicy> {
  const [p] = await tdb.select().from(schema.postingPolicies).where(eq(schema.postingPolicies.companyId, companyId));
  return p ? { lockDate: p.lockDate || null, maxBackDays: p.maxBackDays ?? null, reasonAfterDays: p.reasonAfterDays ?? null } : NO_POLICY;
}

// How many days before today a date is (0 = today or later).
export function daysBack(postingDate: string, today: string = nowDate().toISOString().slice(0, 10)): number {
  return Math.max(0, dayNumber(today) - dayNumber(postingDate));
}

export async function assertPostingAllowed(req: any, postingDate: string, opts: { vat: VatMode; reason?: string | null; companyId?: string }): Promise<{ daysBack: number; override: string | null }> {
  const companyId = opts.companyId || req.targetCompanyId;
  await validateTransactionDate(postingDate, companyId);
  if (opts.vat === 'frozen') await assertQuarterNotFrozen(postingDate, companyId);
  else if (opts.vat === 'filed') await assertQuarterNotFiled(postingDate, companyId);

  const policy = await loadPostingPolicy(tenantDb(), companyId);
  const back = daysBack(postingDate);
  let override: string | null = null;
  if (policy.lockDate && postingDate <= policy.lockDate) {
    if (!hasPermission(req.user, 'postingControl.overrideLock')) throw fail(`Postings dated on or before ${policy.lockDate} are locked (posting lock date). Ask someone with the right to post before the lock date, or ask finance to move the lock date.`);
    override = 'lock';
  }
  if (policy.maxBackDays !== null && back > policy.maxBackDays) {
    if (!hasPermission(req.user, 'postingControl.backDate')) throw fail(`This date is ${back} days back; entries may be dated at most ${policy.maxBackDays} day${policy.maxBackDays === 1 ? '' : 's'} back. Ask someone with the right to post back-dated entries.`);
    override = override || 'window';
  }
  const reason = String(opts.reason ?? req.body?.backDateReason ?? '').trim().slice(0, 300);
  if (policy.reasonAfterDays !== null && back > policy.reasonAfterDays && !reason) throw fail(`A reason is required for an entry dated ${back} days back (back-dating reason).`);
  if (override || (reason && back > 0)) {
    // a stand-in request, so this extra entry does not stop the route's own audit entry (recordAuditLog marks the request it is given as already logged)
    recordAuditLog({ user: req.user, targetCompanyId: companyId, headers: req.headers, ip: req.ip }, 'BACKDATED_POSTING', 'posting', req.params?.id || null, { route: `${req.baseUrl || ''}${req.route?.path || ''}`, postingDate, daysBack: back, reason: reason || null, override });
  }
  return { daysBack: back, override };
}
