import React from 'react';
import { Pencil, Send, Trash2, CheckCircle2, XCircle, Undo2, History, ArrowRight } from 'lucide-react';
import { useTranslation, usePermissions } from '../../hooks';
import type { DatabaseState } from '../../dbStore';
import { ledgerApi, money, moneyOrBlank, todayIso, inputCls, labelCls, primaryBtn, ghostBtn, dangerBtn, greenBtn, Notice, Drawer, Modal, JournalStatusPill, SOURCE_LABEL } from './ui';

interface Line { id: string; accountId: string | null; accountCode: string; accountName: string; accountNameAr: string | null; debit: number; credit: number; note?: string | null }

// One journal on screen: a manual journal (with its approval trail and the actions its state allows) or a posted ledger entry from a document /
// opening balance (read-only). Every action is a server call that re-checks permission, state and the period; the buttons here only mirror that.
export default function JournalDetailPanel({ db, kind, id, onClose, onChanged, onEdit, onOpen }: {
  db: DatabaseState; kind: 'manual' | 'entry'; id: string; onClose: () => void; onChanged?: () => void; onEdit?: (id: string) => void;
  onOpen?: (kind: 'manual' | 'entry', id: string) => void;
}) {
  const { t, lang } = useTranslation(db);
  const { can } = usePermissions(db.currentUser);
  const [j, setJ] = React.useState<any>(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [modal, setModal] = React.useState<'reject' | 'reverse' | 'discard' | null>(null);
  const [text, setText] = React.useState('');
  const [revDate, setRevDate] = React.useState(todayIso());
  const currency = db.companySetup?.currency || 'SAR';

  const load = React.useCallback(async () => {
    try { setJ(await ledgerApi(kind === 'manual' ? `/manual-journals/${id}` : `/journals/entries/${id}`)); setError(''); }
    catch (e: any) { setError(e.message); }
  }, [kind, id]);
  React.useEffect(() => { setJ(null); load(); }, [load]);

  const run = async (fn: () => Promise<any>, after?: () => void) => {
    setBusy(true); setError('');
    try { await fn(); await load(); onChanged?.(); setModal(null); setText(''); after?.(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const acctName = (l: Line) => (lang === 'ar' && l.accountNameAr ? l.accountNameAr : l.accountName);
  const status: string = kind === 'manual' ? j?.status : 'Posted';
  const own = !!j?.isOwn;
  const canApprove = kind === 'manual' && status === 'Pending' && can('journals.post');
  const selfBlocked = canApprove && own && !j?.selfApprovalOn;

  const EVENT_LABEL: Record<string, string> = { Prepared: 'Prepared', Edited: 'Edited', Submitted: 'Submitted for approval', Approved: 'Approved', Rejected: 'Rejected', Posted: 'Posted to the ledger', Discarded: 'Discarded', ReversalStarted: 'Reversal started' };

  const actions = j && kind === 'manual' ? (
    <>
      {(status === 'Draft' || status === 'Rejected') && can('journals.delete') && <button className={dangerBtn} disabled={busy} onClick={() => setModal('discard')}><Trash2 className="w-3.5 h-3.5" />{t('Discard')}</button>}
      {(status === 'Draft' || status === 'Rejected') && can('journals.update') && !j.reversalOfId && <button className={ghostBtn} disabled={busy} onClick={() => onEdit?.(j.id)}><Pencil className="w-3.5 h-3.5" />{t('Edit')}</button>}
      {(status === 'Draft' || status === 'Rejected') && (can('journals.create') || can('journals.update')) && <button className={primaryBtn} disabled={busy} onClick={() => run(() => ledgerApi(`/manual-journals/${j.id}/submit`, { method: 'POST', body: {} }))}><Send className="w-3.5 h-3.5" />{t('Submit for approval')}</button>}
      {canApprove && <button className={dangerBtn} disabled={busy} onClick={() => setModal('reject')}><XCircle className="w-3.5 h-3.5" />{t('Reject')}</button>}
      {canApprove && <button className={greenBtn} disabled={busy || selfBlocked} title={selfBlocked ? t('You prepared this journal, so someone else must approve it.') : ''} onClick={() => run(() => ledgerApi(`/manual-journals/${j.id}/approve`, { method: 'POST', body: {} }))}><CheckCircle2 className="w-3.5 h-3.5" />{t('Approve and post')}</button>}
      {status === 'Posted' && !j.reversalOfId && !j.reversedById && can('journals.reverse') && <button className={ghostBtn} disabled={busy} onClick={() => setModal('reverse')}><Undo2 className="w-3.5 h-3.5" />{t('Reverse')}</button>}
    </>
  ) : null;

  return (
    <Drawer width="max-w-3xl" title={j ? `${kind === 'manual' ? j.number : (j.documentNumber || t('Ledger entry'))}` : t('Journal')} onClose={onClose} footer={actions}>
      {error && <Notice tone="error">{error}</Notice>}
      {!j && !error && <p className="text-slate-400">{t('Loading...')}</p>}
      {j && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <JournalStatusPill status={status} label={t(status)} />
            <span className="text-slate-500">{j.postingDate}{j.docDate && j.docDate !== j.postingDate ? ` · ${t('Document date')} ${j.docDate}` : ''}</span>
            {kind === 'entry' && <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px] font-bold uppercase">{t(SOURCE_LABEL[j.referenceType] || j.referenceType)}{j.documentNumber ? ` · ${j.documentNumber}` : ''}</span>}
            {kind === 'manual' && j.selfApproved && <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-bold uppercase">{t('Approved by its preparer')}</span>}
          </div>
          <div>
            <div className={labelCls}>{t('Description')}</div>
            <p className="text-sm font-semibold text-slate-800">{j.description}</p>
            {kind === 'manual' && j.reference && <p className="text-slate-500 mt-0.5">{t('Reference')}: {j.reference}</p>}
            {kind === 'manual' && j.preparerNote && <p className="text-slate-500 mt-0.5">{t('Note')}: {j.preparerNote}</p>}
          </div>
          {kind === 'manual' && status === 'Rejected' && j.decisionNote && <Notice tone="warn"><b>{t('Rejected')}:</b> {j.decisionNote}</Notice>}
          {kind === 'manual' && j.reversalOf && <Notice tone="info">{t('This journal reverses')} <button className="underline font-bold" onClick={() => onOpen?.('manual', j.reversalOf.id)}>{j.reversalOf.number}</button></Notice>}
          {kind === 'manual' && j.reversedBy && <Notice tone="info">{t('Reversed by')} <button className="underline font-bold" onClick={() => onOpen?.('manual', j.reversedBy.id)}>{j.reversedBy.number}</button> ({t(j.reversedBy.status)})</Notice>}
          {selfBlocked && <Notice tone="warn">{t('You prepared this journal, so someone else must approve it.')}</Notice>}

          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <table className="w-full text-start">
              <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-500">
                <tr><th className="p-2.5 text-start">{t('Account')}</th><th className="p-2.5 text-end">{t('Debit')} ({currency})</th><th className="p-2.5 text-end">{t('Credit')} ({currency})</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(j.lines as Line[]).map(l => (
                  <tr key={l.id}>
                    <td className="p-2.5"><span className="font-mono text-slate-500 me-2">{l.accountCode}</span><span className="font-semibold text-slate-800">{acctName(l)}</span>{l.note && <span className="block text-[11px] text-slate-500">{l.note}</span>}{(l as any).dimensionLabels?.length > 0 && <span className="flex flex-wrap gap-1 mt-0.5">{(l as any).dimensionLabels.map((d: any) => <span key={d.typeId} className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 text-[10px] font-bold">{d.typeName}: {d.name}</span>)}</span>}</td>
                    <td className="p-2.5 text-end font-mono tabular-nums">{moneyOrBlank(l.debit)}</td>
                    <td className="p-2.5 text-end font-mono tabular-nums">{moneyOrBlank(l.credit)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-slate-50 font-bold">
                <tr><td className="p-2.5 text-end">{t('Total')}</td><td className="p-2.5 text-end font-mono tabular-nums">{money(j.totalDebit)}</td><td className="p-2.5 text-end font-mono tabular-nums">{money(j.totalCredit)}</td></tr>
              </tfoot>
            </table>
          </div>

          {kind === 'manual' ? (
            <div>
              <div className={`${labelCls} flex items-center gap-1`}><History className="w-3 h-3" />{t('Approval trail')}</div>
              <ol className="space-y-1.5 border-s-2 border-slate-100 ps-3">
                {j.events.map((e: any) => (
                  <li key={e.id} className="text-[11px]">
                    <span className="font-bold text-slate-700">{t(EVENT_LABEL[e.action] || e.action)}</span>
                    <span className="text-slate-500"> · {e.userName} · {new Date(e.createdAt).toLocaleString()}</span>
                    {e.note && <span className="block text-slate-500">{e.note}</span>}
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <div className="text-[11px] text-slate-500 space-y-1">
              <div>{t('Posted by')} {j.createdByName} · {new Date(j.createdAt).toLocaleString()}</div>
              {j.referenceType === 'Manual' && (
                <button className="inline-flex items-center gap-1 text-indigo-600 font-bold" onClick={() => onOpen?.('manual', j.referenceId)}>{t('Open the manual journal')} <ArrowRight className="w-3 h-3 rtl:rotate-180" /></button>
              )}
            </div>
          )}
        </>
      )}

      {modal === 'reject' && (
        <Modal title={t('Reject journal')} onClose={() => setModal(null)} footer={<><button className={ghostBtn} onClick={() => setModal(null)}>{t('Cancel')}</button><button className={dangerBtn} disabled={busy || !text.trim()} onClick={() => run(() => ledgerApi(`/manual-journals/${id}/reject`, { method: 'POST', body: { note: text } }))}>{t('Reject')}</button></>}>
          <label className={labelCls}>{t('Reason (the preparer will see this)')}</label>
          <textarea className={`${inputCls} h-24`} value={text} onChange={e => setText(e.target.value)} maxLength={300} />
        </Modal>
      )}
      {modal === 'discard' && (
        <Modal title={t('Discard journal')} onClose={() => setModal(null)} footer={<><button className={ghostBtn} onClick={() => setModal(null)}>{t('Keep it')}</button><button className={dangerBtn} disabled={busy} onClick={() => run(() => ledgerApi(`/manual-journals/${id}`, { method: 'DELETE', body: {} }), onClose)}>{t('Discard')}</button></>}>
          <p className="text-slate-600">{t('The journal is thrown away and never reaches the ledger. Its number stays on record as discarded.')}</p>
        </Modal>
      )}
      {modal === 'reverse' && (
        <Modal title={t('Reverse journal')} onClose={() => setModal(null)} footer={<><button className={ghostBtn} onClick={() => setModal(null)}>{t('Cancel')}</button><button className={primaryBtn} disabled={busy || !text.trim()} onClick={() => run(async () => { const r = await ledgerApi<any>(`/manual-journals/${id}/reverse`, { method: 'POST', body: { reason: text, docDate: revDate } }); onOpen?.('manual', r.id); })}>{t('Create reversal draft')}</button></>}>
          <p className="text-slate-600">{t('A reversal is a new journal with every debit and credit swapped. It is created as a draft and needs approval before it reaches the ledger.')}</p>
          <div><label className={labelCls}>{t('Reversal date')}</label><input type="date" className={inputCls} value={revDate} onChange={e => setRevDate(e.target.value)} /></div>
          <div><label className={labelCls}>{t('Reason')}</label><textarea className={`${inputCls} h-20`} value={text} onChange={e => setText(e.target.value)} maxLength={300} /></div>
        </Modal>
      )}
    </Drawer>
  );
}
