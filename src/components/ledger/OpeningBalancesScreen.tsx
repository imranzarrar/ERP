import React from 'react';
import { Plus, Trash2, Eye, ShieldCheck, Undo2, AlertTriangle, CheckCircle2, Landmark } from 'lucide-react';
import { useTranslation, usePermissions } from '../../hooks';
import type { DatabaseState } from '../../dbStore';
import { ledgerApi, money, todayIso, inputCls, labelCls, primaryBtn, ghostBtn, dangerBtn, Card, Notice, Modal, useBanner } from './ui';
import { AccountPicker, type Acct } from './JournalFormScreen';

interface Eligible { id: string; code: string; name: string; nameAr: string | null; type: string; bankId: string | null }
interface Sheet { key: number; accountId: string; debit: string; credit: string }
let sheetKey = 1;
const blank = (): Sheet => ({ key: sheetKey++, accountId: '', debit: '', credit: '' });
const num = (s: string) => { const n = Number(s); return isNaN(n) ? 0 : Math.round(n * 100) / 100; };

// Opening Balances: the balances brought forward when the books start here. Entered once, previewed (nothing saved), then posted as a single
// balanced ledger entry. Customer, supplier, stock and VAT balances are not typed here: they come from their own documents.
export default function OpeningBalancesScreen({ db }: { db: DatabaseState }) {
  const { t } = useTranslation(db);
  const { can } = usePermissions(db.currentUser);
  const { banner, show } = useBanner();
  const [info, setInfo] = React.useState<any>(null);
  const [date, setDate] = React.useState(todayIso().slice(0, 8) + '01');
  const [rows, setRows] = React.useState<Sheet[]>([blank(), blank(), blank()]);
  const [plugId, setPlugId] = React.useState('');
  const [preview, setPreview] = React.useState<any>(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [confirm, setConfirm] = React.useState(false);
  const [acceptEarlier, setAcceptEarlier] = React.useState(false);
  const [reversing, setReversing] = React.useState<any>(null);
  const [reason, setReason] = React.useState('');
  const currency = db.companySetup?.currency || 'SAR';

  const load = React.useCallback(async () => { try { setInfo(await ledgerApi('/opening-balances')); } catch (e: any) { setError(e.message); } }, []);
  React.useEffect(() => { load(); }, [load]);

  const eligible: Acct[] = (info?.eligibleAccounts || []).map((a: Eligible) => ({ ...a, isGroup: false, isActive: true, isControl: false }));
  const liveRun = (info?.runs || []).find((r: any) => !r.reversed);
  const canPost = can('openingBalances.post');
  const canPreview = can('openingBalances.preview') || canPost;

  const set = (key: number, patch: Partial<Sheet>) => { setPreview(null); setConfirm(false); setRows(rs => rs.map(r => r.key === key ? { ...r, ...patch } : r)); };
  const filled = rows.filter(r => r.accountId && (num(r.debit) || num(r.credit)));
  const body = () => ({ cutOffDate: date, lines: filled.map(r => ({ accountId: r.accountId, debit: num(r.debit) || 0, credit: num(r.credit) || 0 })), plugAccountId: plugId || undefined });

  const useBanks = () => {
    const sugg = (info?.bankSuggestions || []).filter((b: any) => b.accountId && !rows.some(r => r.accountId === b.accountId));
    if (!sugg.length) { show('error', t('No bank has an opening figure to bring in.')); return; }
    setPreview(null);
    setRows(rs => [...rs.filter(r => r.accountId || r.debit || r.credit), ...sugg.map((b: any) => ({ key: sheetKey++, accountId: b.accountId, debit: b.amount > 0 ? String(b.amount) : '', credit: b.amount < 0 ? String(-b.amount) : '' })), blank()]);
  };

  const runPreview = async () => {
    setBusy(true); setError(''); setPreview(null); setConfirm(false);
    try { setPreview(await ledgerApi('/opening-balances/preview', { method: 'POST', body: body() })); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const post = async () => {
    setBusy(true); setError('');
    try {
      await ledgerApi('/opening-balances/post', { method: 'POST', body: { ...body(), confirm: true, acceptEarlierActivity: acceptEarlier } });
      show('success', t('Opening balances posted.')); setPreview(null); setRows([blank(), blank(), blank()]); setConfirm(false); await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const reverse = async () => {
    setBusy(true);
    try { await ledgerApi(`/opening-balances/${reversing.id}/reverse`, { method: 'POST', body: { reason } }); show('success', t('Opening balances reversed. You can post corrected ones.')); setReversing(null); setReason(''); await load(); }
    catch (e: any) { setError(e.message); setReversing(null); } finally { setBusy(false); }
  };

  const earlierWarn = preview?.warnings?.some((w: string) => /already posted before/.test(w));

  return (
    <div className="space-y-5 pb-10 max-w-5xl">
      {banner && <Notice tone={banner.tone}>{banner.text}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {(info?.runs || []).length > 0 && (
        <Card className="overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 bg-slate-50/70 text-[11px] font-extrabold uppercase tracking-wider text-slate-600">{t('Posted opening balances')}</div>
          <div className="divide-y divide-slate-100">
            {info.runs.map((r: any) => (
              <div key={r.id} className="px-5 py-3 flex flex-wrap items-center gap-3 text-xs">
                <div className="flex-1 min-w-[200px]">
                  <div className="font-bold text-slate-800">{t('As at')} {r.cutOffDate} · {r.summary?.lines} {t('accounts')} · {money(r.summary?.totalDebit)} {currency}</div>
                  <div className="text-slate-500">{t('Posted by')} {r.postedByName} · {new Date(r.postedAt).toLocaleString()}{r.reversed ? ` · ${t('Reversed')}: ${r.summary?.reversalReason || ''}` : ''}</div>
                </div>
                {r.reversed ? <span className="px-2 py-0.5 rounded-full bg-slate-200 text-slate-600 text-[9px] font-bold uppercase">{t('Reversed')}</span>
                  : <><span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[9px] font-bold uppercase">{t('Live')}</span>
                    {canPost && <button className={ghostBtn} onClick={() => setReversing(r)}><Undo2 className="w-3.5 h-3.5" />{t('Reverse')}</button>}</>}
              </div>
            ))}
          </div>
        </Card>
      )}

      {liveRun && <Notice tone="info">{t('Opening balances are already posted for this company. To change them, reverse the entry above and post corrected balances.')}</Notice>}

      {!liveRun && canPreview && (
        <Card className="p-5 space-y-4">
          <div>
            <h3 className="text-sm font-bold text-slate-900">{t('Enter opening balances')}</h3>
            <p className="text-[11px] text-slate-500 mt-0.5">{t('Balance-sheet accounts only. Customer, supplier, stock and VAT balances come from their own documents, so those accounts are not offered. Profit and loss start from nothing.')}</p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div><label className={labelCls}>{t('Opening date')}</label><input type="date" className={inputCls} value={date} onChange={e => { setDate(e.target.value); setPreview(null); }} /></div>
            {info?.firstActivityDate && <p className="text-[11px] text-slate-500 pb-2">{t('First ledger activity so far:')} {info.firstActivityDate}</p>}
            <button className={`${ghostBtn} ms-auto`} onClick={useBanks}><Landmark className="w-3.5 h-3.5" />{t('Bring in the banks\' opening figures')}</button>
          </div>
          <div className="border border-slate-200 rounded-xl">
            <table className="w-full text-xs text-start">
              <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-500 tracking-wider"><tr><th className="p-2.5 ps-4 text-start">{t('Account')}</th><th className="p-2.5 text-end w-36">{t('Debit')}</th><th className="p-2.5 text-end w-36">{t('Credit')}</th><th className="w-10" /></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map(r => (
                  <tr key={r.key}>
                    <td className="p-2 ps-4"><AccountPicker accounts={eligible} value={r.accountId} lang={db.currentUser?.uiLanguage || 'en'} placeholder={t('Type a code or name')} onChange={id => set(r.key, { accountId: id })} /></td>
                    <td className="p-2"><input type="number" min="0" step="0.01" className={`${inputCls} text-end font-mono`} value={r.debit} onChange={e => set(r.key, { debit: e.target.value, credit: e.target.value ? '' : r.credit })} /></td>
                    <td className="p-2"><input type="number" min="0" step="0.01" className={`${inputCls} text-end font-mono`} value={r.credit} onChange={e => set(r.key, { credit: e.target.value, debit: e.target.value ? '' : r.debit })} /></td>
                    <td className="p-2 text-center">{rows.length > 1 && <button onClick={() => { setPreview(null); setRows(rs => rs.filter(x => x.key !== r.key)); }} className="text-slate-400 hover:text-rose-600 cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-slate-50"><tr>
                <td className="p-2.5 ps-4"><button className={ghostBtn} onClick={() => setRows(rs => [...rs, blank()])}><Plus className="w-3.5 h-3.5" />{t('Add line')}</button></td>
                <td className="p-2.5 text-end font-mono font-bold">{money(rows.reduce((s, r) => s + num(r.debit), 0))}</td>
                <td className="p-2.5 text-end font-mono font-bold">{money(rows.reduce((s, r) => s + num(r.credit), 0))}</td><td />
              </tr></tfoot>
            </table>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[260px]"><label className={labelCls}>{t('If the sheet is out of balance, put the difference to')}</label>
              <select className={inputCls} value={plugId} onChange={e => { setPlugId(e.target.value); setPreview(null); }}>
                <option value="">{t('Nothing: I will fix the figures')}</option>
                {(info?.equityAccounts || []).map((a: any) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
              </select></div>
            <button className={`${primaryBtn} ms-auto`} disabled={busy || filled.length === 0} onClick={runPreview}><Eye className="w-3.5 h-3.5" />{t('Preview (nothing is saved)')}</button>
          </div>

          {preview && (
            <div className="border border-indigo-200 bg-indigo-50/30 rounded-xl p-4 space-y-3">
              <div className="text-xs font-bold text-slate-800">{t('Preview of the entry dated')} {date}</div>
              <table className="w-full text-xs text-start">
                <tbody className="divide-y divide-slate-100">
                  {[...preview.lines, ...(preview.plug ? [{ ...preview.plug, plug: true }] : [])].map((l: any, i: number) => (
                    <tr key={i}><td className="py-1.5"><span className="font-mono text-slate-500 me-2">{l.code}</span>{l.name}{l.plug && <span className="ms-2 text-[10px] uppercase text-amber-600 font-bold">{t('difference')}</span>}</td><td className="py-1.5 text-end font-mono w-32">{l.debit ? money(l.debit) : ''}</td><td className="py-1.5 text-end font-mono w-32">{l.credit ? money(l.credit) : ''}</td></tr>
                  ))}
                  <tr className="font-black"><td className="py-1.5 text-end">{t('Total')} ({currency})</td><td className="py-1.5 text-end font-mono">{money(preview.totalDebit)}</td><td className="py-1.5 text-end font-mono">{money(preview.totalCredit)}</td></tr>
                </tbody>
              </table>
              {preview.warnings.map((w: string, i: number) => <Notice key={i} tone="warn">{w}</Notice>)}
              {preview.canPost && !preview.warnings.length && <Notice tone="success"><span className="inline-flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5" />{t('Balanced and ready to post.')}</span></Notice>}
              {preview.canPost && canPost && (
                <div className="space-y-2">
                  {earlierWarn && <label className="flex items-start gap-2 text-xs text-amber-800 cursor-pointer"><input type="checkbox" className="mt-0.5" checked={acceptEarlier} onChange={e => setAcceptEarlier(e.target.checked)} />{t('I understand that earlier entries exist and these figures may be counted twice.')}</label>}
                  <label className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer"><input type="checkbox" className="mt-0.5" checked={confirm} onChange={e => setConfirm(e.target.checked)} />{t('I have reviewed these opening balances. Posting creates one ledger entry; a mistake can only be corrected by reversing it.')}</label>
                  <button className={primaryBtn} disabled={busy || !confirm || (earlierWarn && !acceptEarlier)} onClick={post}><ShieldCheck className="w-3.5 h-3.5" />{t('Post opening balances')}</button>
                </div>
              )}
              {!preview.canPost && <div className="text-[11px] text-rose-600 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" />{t('This sheet cannot be posted yet.')}</div>}
            </div>
          )}
        </Card>
      )}

      {reversing && (
        <Modal title={t('Reverse opening balances')} onClose={() => setReversing(null)} footer={<><button className={ghostBtn} onClick={() => setReversing(null)}>{t('Cancel')}</button><button className={dangerBtn} disabled={busy || !reason.trim()} onClick={reverse}>{t('Reverse')}</button></>}>
          <p className="text-slate-600">{t('A reversing entry swaps every debit and credit of the opening entry, so you can post corrected balances afterwards.')}</p>
          <div><label className={labelCls}>{t('Reason')}</label><textarea className={`${inputCls} h-20`} value={reason} onChange={e => setReason(e.target.value)} maxLength={300} /></div>
        </Modal>
      )}
    </div>
  );
}
