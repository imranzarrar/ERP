import React from 'react';
import { Save, Wand2, Eraser, Ban, Link2, Printer, FilePlus2 } from 'lucide-react';
import { useTranslation } from '../../hooks';
import type { DatabaseState } from '../../dbStore';
import { erpApi, Card, Notice, Modal, Drawer, inputCls, labelCls, primaryBtn, ghostBtn, dangerBtn, money, todayIso, useBanner, usePrintDoc } from './ui';

// Receive Payment (customer) and Pay Vendor: one receipt / payment that settles several documents at once, or is kept on account (server/lib/settlements.ts).
// The two screens are the same screen with the party kind swapped, so a customer receipt and a vendor payment can never drift apart in behaviour.
export type SettleKind = 'customer' | 'vendor';
interface OpenItem { type: string; id: string; docNumber: string; date: string; total: number; paid: number; outstanding: number }
const TYPE_LABEL: Record<string, string> = { Invoice: 'Invoice', Expense: 'Expense', PurchaseBill: 'Purchase Bill' };
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// The documents of one party with a box to say how much of the money goes to each. `available` is the money that can still be given out.
function AllocationTable({ db, items, values, onChange, available, currency }: { db: DatabaseState; items: OpenItem[]; values: Record<string, string>; onChange: (v: Record<string, string>) => void; available: number; currency: string }) {
  const { t } = useTranslation(db);
  const key = (i: OpenItem) => `${i.type}:${i.id}`;
  const allocated = r2(items.reduce((s, i) => s + (Number(values[key(i)]) || 0), 0));
  const fifo = () => {
    let left = available; const next: Record<string, string> = {};
    for (const i of [...items].sort((a, b) => a.date.localeCompare(b.date) || a.docNumber.localeCompare(b.docNumber))) {
      const give = r2(Math.min(left, i.outstanding)); if (give > 0) { next[key(i)] = String(give); left = r2(left - give); }
    }
    onChange(next);
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button type="button" className={ghostBtn} onClick={fifo} disabled={!(available > 0) || !items.length}><Wand2 className="w-3.5 h-3.5" />{t('Allocate oldest first')}</button>
        <button type="button" className={ghostBtn} onClick={() => onChange({})} disabled={!allocated}><Eraser className="w-3.5 h-3.5" />{t('Clear')}</button>
        <span className="ms-auto text-[11px] text-slate-500">{t('Allocated')}: <b className={allocated > available + 0.005 ? 'text-rose-600' : 'text-slate-800'}>{money(allocated)} {currency}</b></span>
      </div>
      <div className="overflow-x-auto border border-slate-100 rounded-xl">
        <table className="w-full text-xs text-start">
          <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-500 tracking-wider">
            <tr><th className="p-2.5 text-start">{t('Document')}</th><th className="p-2.5 text-start">{t('Date')}</th><th className="p-2.5 text-end">{t('Total')}</th><th className="p-2.5 text-end">{t('Paid')}</th><th className="p-2.5 text-end">{t('Outstanding')}</th><th className="p-2.5 text-end w-36">{t('Apply')}</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.length === 0 && <tr><td colSpan={6} className="p-5 text-center text-slate-400">{t('Nothing is open for this party.')}</td></tr>}
            {items.map(i => (
              <tr key={key(i)} className="hover:bg-slate-50">
                <td className="p-2.5"><span className="font-bold text-slate-800">{i.docNumber}</span> <span className="text-slate-400">{t(TYPE_LABEL[i.type] || i.type)}</span></td>
                <td className="p-2.5 font-mono">{i.date}</td>
                <td className="p-2.5 text-end font-mono tabular-nums">{money(i.total)}</td>
                <td className="p-2.5 text-end font-mono tabular-nums">{money(i.paid)}</td>
                <td className="p-2.5 text-end font-mono tabular-nums font-bold">{money(i.outstanding)}</td>
                <td className="p-2.5 text-end">
                  <input type="number" min="0" step="0.01" max={i.outstanding} className={`${inputCls} text-end font-mono`} value={values[key(i)] ?? ''}
                    onChange={e => onChange({ ...values, [key(i)]: e.target.value })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const toAllocations = (items: OpenItem[], values: Record<string, string>) =>
  items.filter(i => Number(values[`${i.type}:${i.id}`]) > 0).map(i => ({ documentType: i.type, documentId: i.id, amount: r2(Number(values[`${i.type}:${i.id}`])) }));

export function SettlementEntryScreen({ db, kind, onSaved }: { db: DatabaseState; kind: SettleKind; onSaved?: (voucherId: string) => void }) {
  const { t } = useTranslation(db);
  const isCustomer = kind === 'customer';
  const currency = db.companySetup?.currency || 'SAR';
  const parties = ((isCustomer ? db.customers : db.vendors) || []).filter((p: any) => p.isActive !== false);
  const banks = (db.banks || []).filter((b: any) => b.isActive !== false);
  const [partyId, setPartyId] = React.useState('');
  const [bankId, setBankId] = React.useState(() => (banks.find((b: any) => b.isDefault) || banks[0])?.id || '');
  const [docDate, setDocDate] = React.useState(todayIso());
  const [amount, setAmount] = React.useState('');
  const [reference, setReference] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [items, setItems] = React.useState<OpenItem[]>([]);
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);
  const [done, setDone] = React.useState<any>(null);
  const { banner, show } = useBanner();
  const printDoc = usePrintDoc();

  const loadItems = React.useCallback(async (id: string) => {
    if (!id) { setItems([]); return; }
    try { setItems((await erpApi<{ items: OpenItem[] }>(`/api/settlements/open-items?kind=${kind}&partyId=${id}`)).items); } catch (e: any) { show('error', e.message); setItems([]); }
  }, [kind, show]);
  React.useEffect(() => { setValues({}); loadItems(partyId); }, [partyId, loadItems]);

  const amountNum = r2(Number(amount) || 0);
  const allocated = r2(items.reduce((s, i) => s + (Number(values[`${i.type}:${i.id}`]) || 0), 0));
  const onAccount = r2(amountNum - allocated);
  const valid = !!partyId && !!bankId && amountNum > 0 && allocated <= amountNum + 0.005;
  const word = isCustomer ? { title: 'Receive Payment', party: 'Customer', save: 'Save Receipt', held: 'will be kept on account for this customer and can be put against a later invoice.' }
    : { title: 'Pay Vendor', party: 'Vendor', save: 'Save Payment', held: 'will be kept on account with this vendor and can be put against a later bill.' };

  const save = async () => {
    setSaving(true);
    try {
      const r = await erpApi<any>(`/api/settlements/${isCustomer ? 'receipts' : 'payments'}`, { method: 'POST', body: { partyId, bankId, docDate, amount: amountNum, reference, notes, allocations: toAllocations(items, values) } });
      if (r.pendingApproval) { show('success', t('Sent for approval. It will be posted when every level has approved; follow it in My Approvals.')); setAmount(''); setReference(''); setNotes(''); setValues({}); return; }
      setDone(r); show('success', `${r.voucherNumber} ${t('saved.')}`); onSaved?.(r.voucherId);
    } catch (e: any) { show('error', e.message); } finally { setSaving(false); }
  };
  const again = () => { setDone(null); setAmount(''); setReference(''); setNotes(''); setValues({}); loadItems(partyId); };

  if (done) return (
    <div className="space-y-4 pb-10 max-w-2xl">
      {banner && <Notice tone={banner.tone}>{banner.text}</Notice>}
      <Card className="p-5 space-y-3">
        <div className="text-sm font-bold text-slate-900">{done.voucherNumber}</div>
        <div className="grid grid-cols-3 gap-3 text-xs">
          <div><div className={labelCls}>{t('Amount')}</div><div className="font-mono font-bold">{money(done.amount)} {currency}</div></div>
          <div><div className={labelCls}>{t('Applied to documents')}</div><div className="font-mono font-bold">{money(done.applied)} {currency}</div></div>
          <div><div className={labelCls}>{t('Held on account')}</div><div className="font-mono font-bold text-emerald-700">{money(done.unapplied)} {currency}</div></div>
        </div>
        <div className="flex gap-2">
          <button className={primaryBtn} onClick={async () => { try { printDoc('SettlementVoucher', await erpApi(`/api/settlements/${done.voucherId}`)); } catch (e: any) { show('error', e.message); } }}><Printer className="w-3.5 h-3.5" />{t('Print voucher')}</button>
          <button className={ghostBtn} onClick={again}><FilePlus2 className="w-3.5 h-3.5" />{t(isCustomer ? 'New receipt' : 'New payment')}</button>
        </div>
      </Card>
    </div>
  );

  return (
    <div className="space-y-4 pb-10">
      {banner && <Notice tone={banner.tone}>{banner.text}</Notice>}
      <Card className="p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
        <div><label className={labelCls}>{t(word.party)}</label>
          <select className={inputCls} value={partyId} onChange={e => setPartyId(e.target.value)}>
            <option value="">{t(isCustomer ? 'Choose a customer' : 'Choose a vendor')}</option>
            {parties.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></div>
        <div><label className={labelCls}>{t(isCustomer ? 'Deposit to' : 'Pay from')}</label>
          <select className={inputCls} value={bankId} onChange={e => setBankId(e.target.value)}>
            <option value="">{t('Choose a bank or cash account')}</option>
            {banks.map((b: any) => <option key={b.id} value={b.id}>{b.bankName}</option>)}
          </select></div>
        <div><label className={labelCls}>{t('Date')}</label><input type="date" className={inputCls} value={docDate} onChange={e => setDocDate(e.target.value)} /></div>
        <div><label className={labelCls}>{t('Amount')} ({currency})</label><input type="number" min="0" step="0.01" className={`${inputCls} font-mono`} value={amount} onChange={e => setAmount(e.target.value)} /></div>
        <div><label className={labelCls}>{t('Reference (cheque / transfer no.)')}</label><input className={inputCls} value={reference} onChange={e => setReference(e.target.value)} /></div>
        <div><label className={labelCls}>{t('Notes')}</label><input className={inputCls} value={notes} onChange={e => setNotes(e.target.value)} /></div>
      </Card>
      {partyId && (
        <Card className="p-4 space-y-3">
          <div className="text-xs font-bold text-slate-800">{t(isCustomer ? 'Invoices to settle' : 'Bills and expenses to settle')}</div>
          <AllocationTable db={db} items={items} values={values} onChange={setValues} available={amountNum} currency={currency} />
        </Card>
      )}
      <Card className="p-4 flex flex-wrap items-center gap-4 text-xs">
        <div>{t('Amount')}: <b className="font-mono">{money(amountNum)}</b></div>
        <div>{t('Applied to documents')}: <b className="font-mono">{money(allocated)}</b></div>
        <div>{t('Held on account')}: <b className={`font-mono ${onAccount < -0.005 ? 'text-rose-600' : 'text-emerald-700'}`}>{money(onAccount)}</b></div>
        <button className={`${primaryBtn} ms-auto`} disabled={!valid || saving} onClick={save}><Save className="w-3.5 h-3.5" />{t(word.save)}</button>
      </Card>
      {onAccount > 0.005 && amountNum > 0 && <Notice tone="info">{money(onAccount)} {currency} {t(word.held)}</Notice>}
      {onAccount < -0.005 && <Notice tone="error">{t('More is allocated than the amount received / paid.')}</Notice>}
    </div>
  );
}

export function SettlementListScreen({ db, kind, onNew }: { db: DatabaseState; kind: SettleKind; onNew: () => void }) {
  const { t } = useTranslation(db);
  const isCustomer = kind === 'customer';
  const currency = db.companySetup?.currency || 'SAR';
  const parties = ((isCustomer ? db.customers : db.vendors) || []);
  const [partyId, setPartyId] = React.useState('');
  const [rows, setRows] = React.useState<any[]>([]);
  const [open, setOpen] = React.useState<string | null>(null);
  const [error, setError] = React.useState('');
  const load = React.useCallback(async () => {
    setError('');
    try { setRows((await erpApi<{ rows: any[] }>(`/api/settlements?kind=${kind}${partyId ? `&partyId=${partyId}` : ''}`)).rows); } catch (e: any) { setError(e.message); setRows([]); }
  }, [kind, partyId]);
  React.useEffect(() => { load(); }, [load]);
  return (
    <div className="space-y-4 pb-10">
      {error && <Notice tone="error">{error}</Notice>}
      <Card className="p-4 flex flex-wrap items-end gap-3">
        <div className="min-w-[14rem]"><label className={labelCls}>{t(isCustomer ? 'Customer' : 'Vendor')}</label>
          <select className={inputCls} value={partyId} onChange={e => setPartyId(e.target.value)}>
            <option value="">{t('All')}</option>
            {parties.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></div>
        <button className={`${primaryBtn} ms-auto`} onClick={onNew}><FilePlus2 className="w-3.5 h-3.5" />{t(isCustomer ? 'Receive Payment' : 'Pay Vendor')}</button>
      </Card>
      <Card className="overflow-x-auto">
        <table className="w-full text-xs text-start">
          <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-500 tracking-wider">
            <tr><th className="p-3 text-start">{t('Number')}</th><th className="p-3 text-start">{t('Date')}</th><th className="p-3 text-start">{t(isCustomer ? 'Customer' : 'Vendor')}</th>
              <th className="p-3 text-end">{t('Amount')}</th><th className="p-3 text-end">{t('Applied to documents')}</th><th className="p-3 text-end">{t('Held on account')}</th><th className="p-3 text-start">{t('Status')}</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-slate-400">{t(isCustomer ? 'No receipts yet.' : 'No payments yet.')}</td></tr>}
            {rows.map(r => (
              <tr key={r.id} className="hover:bg-slate-50 cursor-pointer" onClick={() => setOpen(r.id)}>
                <td className="p-3 font-bold text-indigo-700">{r.voucherNumber}</td>
                <td className="p-3 font-mono">{r.docDate}</td>
                <td className="p-3">{r.partyName}</td>
                <td className="p-3 text-end font-mono tabular-nums">{money(r.amount)}</td>
                <td className="p-3 text-end font-mono tabular-nums">{money(r.applied)}</td>
                <td className="p-3 text-end font-mono tabular-nums text-emerald-700">{r.unapplied > 0 ? money(r.unapplied) : ''}</td>
                <td className="p-3">{r.cancelled ? <span className="text-rose-600 font-bold">{t('Cancelled')}</span> : r.unapplied > 0.005 ? <span className="text-amber-600 font-bold">{t('On account')}</span> : <span className="text-emerald-700 font-bold">{t('Settled')}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {open && <SettlementDetailDrawer db={db} kind={kind} id={open} currency={currency} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}

function SettlementDetailDrawer({ db, kind, id, currency, onClose, onChanged }: { db: DatabaseState; kind: SettleKind; id: string; currency: string; onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation(db);
  const [d, setD] = React.useState<any>(null);
  const [error, setError] = React.useState('');
  const [apply, setApply] = React.useState(false);
  const [cancel, setCancel] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const printDoc = usePrintDoc();
  const load = React.useCallback(async () => { try { setD(await erpApi(`/api/settlements/${id}`)); } catch (e: any) { setError(e.message); } }, [id]);
  React.useEffect(() => { load(); }, [load]);
  const doCancel = async () => {
    setBusy(true); setError('');
    try { await erpApi(`/api/settlements/${id}/cancel`, { method: 'POST', body: { reason } }); setCancel(false); setReason(''); await load(); onChanged(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Drawer title={d ? d.voucher.voucherNumber : t('Receipt')} onClose={onClose} width="max-w-xl"
      footer={d && !d.cancelled && (<>
        <button className={ghostBtn} onClick={() => printDoc('SettlementVoucher', d)}><Printer className="w-3.5 h-3.5" />{t('Print voucher')}</button>
        {d.unapplied > 0.005 && <button className={ghostBtn} onClick={() => setApply(true)}><Link2 className="w-3.5 h-3.5" />{t('Apply to documents')}</button>}
        <button className={dangerBtn} onClick={() => setCancel(true)}><Ban className="w-3.5 h-3.5" />{t('Cancel')}</button>
      </>)}>
      {error && <Notice tone="error">{error}</Notice>}
      {d && (<>
        {d.cancelled && <Notice tone="warn">{t('This receipt / payment has been cancelled.')}</Notice>}
        <div className="grid grid-cols-2 gap-3">
          <div><div className={labelCls}>{t(kind === 'customer' ? 'Customer' : 'Vendor')}</div><div className="font-bold">{d.party?.name}</div></div>
          <div><div className={labelCls}>{t('Bank / cash')}</div><div className="font-bold">{d.bankName}</div></div>
          <div><div className={labelCls}>{t('Date')}</div><div className="font-mono">{d.voucher.docDate}</div></div>
          <div><div className={labelCls}>{t('Amount')}</div><div className="font-mono font-bold">{money(d.voucher.amount)} {currency}</div></div>
          <div><div className={labelCls}>{t('Applied to documents')}</div><div className="font-mono">{money(d.applied)} {currency}</div></div>
          <div><div className={labelCls}>{t('Held on account')}</div><div className="font-mono text-emerald-700 font-bold">{money(d.unapplied)} {currency}</div></div>
        </div>
        <div className="text-[11px] text-slate-500">{d.voucher.description}</div>
        <div className={labelCls}>{t('Allocations')}</div>
        <table className="w-full text-xs"><tbody className="divide-y divide-slate-100">
          {d.allocations.length === 0 && <tr><td className="py-3 text-slate-400">{t('Nothing has been applied to a document.')}</td></tr>}
          {d.allocations.map((a: any) => (
            <tr key={a.id} className={a.reversed ? 'line-through text-slate-400' : ''}>
              <td className="py-2 font-bold">{a.documentNumber}</td><td className="py-2 text-slate-500">{t(TYPE_LABEL[a.documentType] || a.documentType)}</td>
              <td className="py-2 text-end font-mono tabular-nums">{money(a.amount)}</td>
            </tr>
          ))}
        </tbody></table>
      </>)}
      {apply && d && <ApplyModal db={db} kind={kind} d={d} currency={currency} onClose={() => setApply(false)} onDone={async () => { setApply(false); await load(); onChanged(); }} />}
      {cancel && (
        <Modal title={t('Cancel this receipt / payment')} onClose={() => setCancel(false)} width="max-w-md"
          footer={<><button className={ghostBtn} onClick={() => setCancel(false)}>{t('Keep it')}</button><button className={dangerBtn} disabled={!reason.trim() || busy} onClick={doCancel}>{t('Cancel receipt / payment')}</button></>}>
          <p className="text-slate-600">{t('The money goes back, the documents it settled become open again, and a reversal is posted. This cannot be undone.')}</p>
          <div><label className={labelCls}>{t('Reason')}</label><input className={inputCls} value={reason} onChange={e => setReason(e.target.value)} /></div>
        </Modal>
      )}
    </Drawer>
  );
}

function ApplyModal({ db, kind, d, currency, onClose, onDone }: { db: DatabaseState; kind: SettleKind; d: any; currency: string; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation(db);
  const [items, setItems] = React.useState<OpenItem[]>([]);
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { erpApi<{ items: OpenItem[] }>(`/api/settlements/open-items?kind=${kind}&partyId=${d.party.id}`).then(r => setItems(r.items)).catch(e => setError(e.message)); }, [kind, d.party.id]);
  const total = r2(items.reduce((s, i) => s + (Number(values[`${i.type}:${i.id}`]) || 0), 0));
  const save = async () => {
    setBusy(true); setError('');
    try { await erpApi(`/api/settlements/${d.voucher.id}/apply`, { method: 'POST', body: { allocations: toAllocations(items, values) } }); onDone(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal title={t('Apply money held on account')} onClose={onClose} width="max-w-3xl"
      footer={<><button className={ghostBtn} onClick={onClose}>{t('Close')}</button><button className={primaryBtn} disabled={!(total > 0) || total > d.unapplied + 0.005 || busy} onClick={save}>{t('Apply')}</button></>}>
      {error && <Notice tone="error">{error}</Notice>}
      <p className="text-slate-600">{t('Available on account')}: <b className="font-mono">{money(d.unapplied)} {currency}</b></p>
      <AllocationTable db={db} items={items} values={values} onChange={setValues} available={d.unapplied} currency={currency} />
    </Modal>
  );
}
