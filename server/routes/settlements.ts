// Receipts and vendor payments across several documents, money held on account, and their cancellation (server/lib/settlements.ts). Every route runs inside the
// request's tenant transaction; the company is always req.targetCompanyId; every id a client names is checked to belong to it before it is used.
import express from 'express';
import { withTenantDb, tenantDb } from '../lib/tenantDb.js';
import { hasPermission } from '../lib/authz.js';
import { recordAuditLog } from '../lib/audit.js';
import { nowDate } from '../lib/clock.js';
import { branchIdsFor } from '../lib/ledgerQueries.js';
import { assertPostingAllowed } from '../lib/postingGuard.js';
import { applyOnAccount, cancelSettlement, listSettlements, openItems, recordSettlement, settlementDetail, type SettlementKind } from '../lib/settlements.js';

const router = express.Router();
const fail = (res: any, status: number, error: string) => res.status(status).json({ error });
const ID = /^[0-9a-f-]{36}$/i;
const today = () => nowDate().toISOString().slice(0, 10);
const MODULE: Record<SettlementKind, string> = { customer: 'customerReceipts', vendor: 'vendorPayments' };
const kindOf = (v: any): SettlementKind | null => (v === 'customer' || v === 'vendor' ? v : null);
const can = (req: any, kind: SettlementKind, leaf: string) => hasPermission(req.user, `${MODULE[kind]}.${leaf}`);
const dateOr = (v: any, fallback: string) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : fallback);

router.get('/settlements/open-items', withTenantDb, async (req: any, res) => {
  try {
    const kind = kindOf(req.query.kind); if (!kind) return fail(res, 400, 'Choose customer or vendor.');
    if (!can(req, kind, 'create') && !can(req, kind, 'update') && !can(req, kind, 'read')) return fail(res, 403, 'Forbidden');
    const partyId = String(req.query.partyId || ''); if (!ID.test(partyId)) return fail(res, 400, 'Choose a party.');
    res.json({ items: await openItems(tenantDb(), req.targetCompanyId, kind, partyId, branchIdsFor(req)) });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

router.get('/settlements', withTenantDb, async (req: any, res) => {
  try {
    const kind = kindOf(req.query.kind); if (!kind) return fail(res, 400, 'Choose customer or vendor.');
    if (!can(req, kind, 'read')) return fail(res, 403, 'Forbidden');
    const partyId = ID.test(String(req.query.partyId || '')) ? String(req.query.partyId) : null;
    res.json({ rows: await listSettlements(tenantDb(), req.targetCompanyId, kind, { partyId }) });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

router.get('/settlements/:id', withTenantDb, async (req: any, res) => {
  try {
    if (!ID.test(req.params.id)) return fail(res, 400, 'Invalid id.');
    const d = await settlementDetail(tenantDb(), req.targetCompanyId, req.params.id);
    if (!can(req, d.kind, 'read')) return fail(res, 403, 'Forbidden');
    res.json(d);
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

const create = (kind: SettlementKind) => async (req: any, res: any) => {
  try {
    if (!can(req, kind, 'create')) return fail(res, 403, 'Forbidden');
    const b = req.body || {};
    const partyId = String(b.partyId || ''); const bankId = String(b.bankId || '');
    if (!ID.test(partyId)) return fail(res, 400, kind === 'customer' ? 'Choose a customer.' : 'Choose a vendor.');
    if (!ID.test(bankId)) return fail(res, 400, 'Choose a bank or cash account.');
    const docDate = dateOr(b.docDate, today());
    await assertPostingAllowed(req, docDate, { vat: 'none' });
    const r = await recordSettlement(tenantDb(), req, { kind, partyId, bankId, docDate, amount: Number(b.amount), reference: b.reference, notes: b.notes, allocations: Array.isArray(b.allocations) ? b.allocations : [] });
    recordAuditLog(req, kind === 'customer' ? 'RECEIVE_PAYMENT' : 'PAY_VENDOR', 'voucher', r.voucherId, { voucherNumber: r.voucherNumber, partyId, amount: r.amount, applied: r.applied, unapplied: r.unapplied });
    res.json({ success: true, ...r });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
};
router.post('/settlements/receipts', withTenantDb, create('customer'));
router.post('/settlements/payments', withTenantDb, create('vendor'));

const settlementKind = async (req: any, id: string): Promise<SettlementKind> => (await settlementDetail(tenantDb(), req.targetCompanyId, id)).kind;

router.post('/settlements/:id/apply', withTenantDb, async (req: any, res) => {
  try {
    if (!ID.test(req.params.id)) return fail(res, 400, 'Invalid id.');
    const kind = await settlementKind(req, req.params.id);
    if (!can(req, kind, 'update')) return fail(res, 403, 'Forbidden');
    const docDate = dateOr(req.body?.docDate, today());
    await assertPostingAllowed(req, docDate, { vat: 'none' });
    const r = await applyOnAccount(tenantDb(), req, req.params.id, Array.isArray(req.body?.allocations) ? req.body.allocations : [], docDate);
    recordAuditLog(req, 'APPLY_ON_ACCOUNT', 'voucher', req.params.id, r);
    res.json({ success: true, ...r });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

router.post('/settlements/:id/cancel', withTenantDb, async (req: any, res) => {
  try {
    if (!ID.test(req.params.id)) return fail(res, 400, 'Invalid id.');
    const kind = await settlementKind(req, req.params.id);
    if (!can(req, kind, 'delete')) return fail(res, 403, 'Forbidden');
    const reason = String(req.body?.reason ?? '').trim().slice(0, 200);
    if (!reason) return fail(res, 400, 'Write the reason for cancelling.');
    const docDate = dateOr(req.body?.docDate, today());
    await assertPostingAllowed(req, docDate, { vat: 'none' });
    const r = await cancelSettlement(tenantDb(), req, req.params.id, docDate, reason);
    recordAuditLog(req, 'CANCEL_SETTLEMENT', 'voucher', req.params.id, { reason, ...r });
    res.json({ success: true, ...r });
  } catch (e: any) { fail(res, e.status || 500, e.message); }
});

export default router;
