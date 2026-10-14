import React from 'react';
import { Search, Plus, ChevronLeft, ChevronRight, Inbox } from 'lucide-react';
import { useTranslation, usePermissions } from '../../hooks';
import type { DatabaseState } from '../../dbStore';
import { ledgerApi, money, inputCls, labelCls, primaryBtn, Card, Notice, JournalStatusPill, SOURCE_LABEL } from './ui';
import JournalDetailPanel from './JournalDetailPanel';
import { DimensionFilter, useDimensionOptions, type DimFilterValue } from './dimensions';

interface Row { kind: 'entry' | 'manual'; id: string; number: string; date: string; description: string; source: string; status: string; reference: string | null; amount: number; userName: string | null }
interface ListResp { rows: Row[]; total: number; page: number; pageSize: number; manualCounts: Record<string, number> }

// Journal Listing (every posted entry and every manual journal) and, with mode="pending", the Pending Approval inbox for the people who can approve.
export default function JournalListScreen({ db, mode, focus, onFocusConsumed, onNew, onEdit }: {
  db: DatabaseState; mode: 'all' | 'pending'; focus?: { kind: 'manual' | 'entry'; id: string } | null; onFocusConsumed?: () => void;
  onNew: () => void; onEdit: (id: string) => void;
}) {
  const { t } = useTranslation(db);
  const { can } = usePermissions(db.currentUser);
  const [data, setData] = React.useState<ListResp | null>(null);
  const [error, setError] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [q, setQ] = React.useState('');
  const [status, setStatus] = React.useState(mode === 'pending' ? 'Pending' : 'all');
  const [source, setSource] = React.useState('all');
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [mine, setMine] = React.useState(false);
  const [dims, setDims] = React.useState<DimFilterValue>({});
  const { options: dimOptions } = useDimensionOptions();
  const [open, setOpen] = React.useState<{ kind: 'manual' | 'entry'; id: string } | null>(focus || null);
  const currency = db.companySetup?.currency || 'SAR';
  const pageSize = 25;

  React.useEffect(() => { if (focus) { setOpen(focus); onFocusConsumed?.(); } }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = React.useCallback(async () => {
    const p = new URLSearchParams({ page: String(page), pageSize: String(pageSize), status, source });
    if (q.trim()) p.set('q', q.trim());
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (mine) p.set('mine', '1');
    if (Object.keys(dims).length) p.set('dims', JSON.stringify(dims));
    try { setData(await ledgerApi<ListResp>(`/journals?${p}`)); setError(''); } catch (e: any) { setError(e.message); }
  }, [page, status, source, q, from, to, mine, dims]);
  React.useEffect(() => { const h = setTimeout(load, 200); return () => clearTimeout(h); }, [load]);
  React.useEffect(() => { setPage(1); }, [status, source, q, from, to, mine, dims]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;
  const counts = data?.manualCounts || {};

  return (
    <div className="space-y-4 pb-10">
      {error && <Notice tone="error">{error}</Notice>}
      {mode === 'pending' && <SelfApprovalSetting db={db} />}
      {mode === 'pending' && (
        <Card className="p-4 flex items-center gap-3">
          <Inbox className="w-5 h-5 text-amber-500" />
          <div className="text-xs"><b className="text-slate-800">{counts.Pending || 0}</b> <span className="text-slate-500">{t('journals are waiting for approval. Open one to review its lines, then approve or reject it.')}</span></div>
        </Card>
      )}
      <Card className="p-4 flex flex-wrap items-end gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute top-1/2 translate-y-0 start-3 mt-0.5" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('Search number, description or reference')} className={`${inputCls} ps-9`} />
        </div>
        {mode === 'all' && (
          <>
            <div><label className={labelCls}>{t('Status')}</label>
              <select className={inputCls} value={status} onChange={e => setStatus(e.target.value)}>
                <option value="all">{t('All')}</option>
                {['Draft', 'Pending', 'Rejected', 'Posted', 'Discarded'].map(s => <option key={s} value={s}>{t(s)}{counts[s] ? ` (${counts[s]})` : ''}</option>)}
              </select></div>
            <div><label className={labelCls}>{t('Source')}</label>
              <select className={inputCls} value={source} onChange={e => setSource(e.target.value)}>
                <option value="all">{t('All')}</option><option value="manual">{t('Manual journals')}</option><option value="documents">{t('From documents')}</option><option value="opening">{t('Opening balances')}</option>
              </select></div>
            <div><label className={labelCls}>{t('From')}</label><input type="date" className={inputCls} value={from} onChange={e => setFrom(e.target.value)} /></div>
            <div><label className={labelCls}>{t('To')}</label><input type="date" className={inputCls} value={to} onChange={e => setTo(e.target.value)} /></div>
          </>
        )}
        {mode === 'all' && <DimensionFilter db={db} options={dimOptions} value={dims} onChange={setDims} />}
        <label className="flex items-center gap-1.5 text-xs text-slate-600 font-semibold cursor-pointer pb-2"><input type="checkbox" checked={mine} onChange={e => setMine(e.target.checked)} />{t('Prepared by me')}</label>
        {can('journals.create') && <button className={`${primaryBtn} ms-auto`} onClick={onNew}><Plus className="w-3.5 h-3.5" />{t('New Manual Journal')}</button>}
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-start">
            <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-500 tracking-wider">
              <tr>
                <th className="p-3 ps-5 text-start">{t('Number')}</th><th className="p-3 text-start">{t('Date')}</th><th className="p-3 text-start">{t('Description')}</th>
                <th className="p-3 text-start">{t('Source')}</th><th className="p-3 text-end">{t('Amount')} ({currency})</th><th className="p-3 text-center">{t('Status')}</th><th className="p-3 pe-5 text-start">{t('Prepared by')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {!data ? (
                <tr><td colSpan={7} className="p-8 text-center text-slate-400">{t('Loading...')}</td></tr>
              ) : data.rows.length === 0 ? (
                <tr><td colSpan={7} className="p-8 text-center text-slate-400">{t('No journals match.')}</td></tr>
              ) : data.rows.map(r => (
                <tr key={`${r.kind}-${r.id}`} onClick={() => setOpen({ kind: r.kind === 'manual' ? 'manual' : 'entry', id: r.id })} className="hover:bg-indigo-50/40 cursor-pointer">
                  <td className="p-3 ps-5 font-mono font-bold text-slate-700">{r.number}</td>
                  <td className="p-3 text-slate-600">{r.date}</td>
                  <td className="p-3 max-w-md"><span className="font-semibold text-slate-800 block truncate">{r.description}</span>{r.reference && <span className="text-[11px] text-slate-400">{t('Ref')}: {r.reference}</span>}</td>
                  <td className="p-3"><span className="px-2 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px] font-bold uppercase">{t(SOURCE_LABEL[r.source] || r.source)}</span></td>
                  <td className="p-3 text-end font-mono tabular-nums">{money(r.amount)}</td>
                  <td className="p-3 text-center"><JournalStatusPill status={r.status} label={t(r.status)} /></td>
                  <td className="p-3 pe-5 text-slate-500">{r.userName || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && data.total > 0 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-slate-100 text-[11px] text-slate-500">
            <span>{(page - 1) * pageSize + 1}–{Math.min(page * pageSize, data.total)} {t('of')} {data.total}</span>
            <div className="flex items-center gap-2">
              <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="p-1.5 rounded-lg border border-slate-200 disabled:opacity-40 cursor-pointer"><ChevronLeft className="w-3.5 h-3.5 rtl:rotate-180" /></button>
              <span>{page} / {totalPages}</span>
              <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} className="p-1.5 rounded-lg border border-slate-200 disabled:opacity-40 cursor-pointer"><ChevronRight className="w-3.5 h-3.5 rtl:rotate-180" /></button>
            </div>
          </div>
        )}
      </Card>

      {open && (
        <JournalDetailPanel db={db} kind={open.kind} id={open.id} onClose={() => setOpen(null)} onChanged={load}
          onEdit={(id) => { setOpen(null); onEdit(id); }} onOpen={(kind, id) => setOpen({ kind, id })} />
      )}
    </div>
  );
}

// The company owner / administrator decides whether a person may approve a journal they prepared themselves. Off by default (segregation of duties).
function SelfApprovalSetting({ db }: { db: DatabaseState }) {
  const { t } = useTranslation(db);
  const [st, setSt] = React.useState<{ selfApproval: boolean; canChange: boolean } | null>(null);
  const [err, setErr] = React.useState('');
  React.useEffect(() => { ledgerApi<any>('/journal-settings').then(setSt).catch(e => setErr(e.message)); }, []);
  if (err) return <Notice tone="error">{err}</Notice>;
  if (!st || !st.canChange) return null;
  const toggle = async () => {
    try { const r = await ledgerApi<any>('/journal-settings', { method: 'PUT', body: { selfApproval: !st.selfApproval } }); setSt({ ...st, selfApproval: r.selfApproval }); }
    catch (e: any) { setErr(e.message); }
  };
  return (
    <Card className="p-4 flex items-start gap-3">
      <input id="selfApproval" type="checkbox" className="mt-0.5" checked={st.selfApproval} onChange={toggle} />
      <label htmlFor="selfApproval" className="text-xs cursor-pointer">
        <b className="text-slate-800">{t('Allow a person to approve a journal they prepared themselves')}</b>
        <span className="block text-slate-500">{t('Off by default, so a second person always reviews. Turn it on only for a one-person finance team. A journal approved this way is marked on its trail.')}</span>
      </label>
    </Card>
  );
}
