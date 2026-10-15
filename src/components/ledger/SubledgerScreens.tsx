import React from 'react';
import { Play, Download, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useTranslation } from '../../hooks';
import type { DatabaseState } from '../../dbStore';
import { ledgerApi, downloadLedgerFile, Card, Notice, inputCls, labelCls, primaryBtn, ghostBtn, money, moneyOrBlank, todayIso, yearStartIso } from './ui';

// Customer and vendor subledgers, read from the ledger (server/lib/subledger.ts): aging by party and a party's ledger. Both are views of the same journal lines on the
// receivable / payable control accounts, so they always agree with the Trial Balance.
export type PartyKind = 'customer' | 'vendor';
export interface PartyFocus { kind: PartyKind; partyId: string | null }

export function SubledgerAgingScreen({ db, kind, onOpenParty }: { db: DatabaseState; kind: PartyKind; onOpenParty: (f: PartyFocus) => void }) {
  const { t } = useTranslation(db);
  const [asOf, setAsOf] = React.useState(todayIso());
  const [data, setData] = React.useState<any>(null);
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const currency = db.companySetup?.currency || 'SAR';
  const run = React.useCallback(async () => {
    setLoading(true); setError('');
    try { setData(await ledgerApi(`/subledger/${kind}/aging?asOf=${asOf}`)); } catch (e: any) { setError(e.message); setData(null); } finally { setLoading(false); }
  }, [kind, asOf]);
  React.useEffect(() => { run(); }, [run]);
  const rec = data?.reconciliation;
  return (
    <div className="space-y-4 pb-10">
      {error && <Notice tone="error">{error}</Notice>}
      <Card className="p-4 flex flex-wrap items-end gap-3">
        <div><label className={labelCls}>{t('As at')}</label><input type="date" className={inputCls} value={asOf} onChange={e => setAsOf(e.target.value)} /></div>
        <button className={primaryBtn} onClick={run} disabled={loading}><Play className="w-3.5 h-3.5" />{t('Run')}</button>
        <button className={`${ghostBtn} ms-auto`} disabled={!data} onClick={() => downloadLedgerFile(`/subledger/${kind}/aging/export?asOf=${asOf}`, `${kind}-aging.xlsx`).catch(e => setError(e.message))}><Download className="w-3.5 h-3.5" />{t('Excel')}</button>
      </Card>
      {data?.branchRestricted && <Notice tone="info">{t('You are limited to your own branches, so these figures cover those branches only.')}</Notice>}
      {rec && (
        <div className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold ${Math.abs(rec.difference) < 0.011 && rec.untaggedLines === 0 ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'}`}>
          {Math.abs(rec.difference) < 0.011 && rec.untaggedLines === 0 ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          {Math.abs(rec.difference) < 0.011 && rec.untaggedLines === 0
            ? `${t(kind === 'customer' ? 'The customers add up to the receivable control accounts' : 'The vendors add up to the payable control accounts')}: ${money(rec.controlBalance)} ${currency}.`
            : `${t('The parties and the control accounts differ')}: ${money(rec.controlBalance)} / ${money(rec.agingTotal)} (${rec.untaggedLines} ${t('lines without a party')}).`}
        </div>
      )}
      {data && (
        <Card className="overflow-x-auto">
          <table className="w-full text-xs text-start">
            <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-500 tracking-wider">
              <tr>
                <th className="p-3 text-start">{t(kind === 'customer' ? 'Customer' : 'Vendor')}</th>
                {data.bucketLabels.map((b: string) => <th key={b} className="p-3 text-end">{b === 'Not due' ? t('Not due') : b === 'Over 90' ? t('Over 90') : `${b} ${t('days')}`}</th>)}
                <th className="p-3 text-end">{t('On account')}</th><th className="p-3 text-end">{t('Total')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.rows.length === 0 && <tr><td colSpan={8} className="p-6 text-center text-slate-400">{t('Nothing is open.')}</td></tr>}
              {data.rows.map((r: any) => (
                <tr key={r.partyId || 'none'} className="hover:bg-slate-50">
                  <td className="p-3"><button className="font-bold text-indigo-700 hover:underline cursor-pointer text-start" onClick={() => onOpenParty({ kind, partyId: r.partyId })}>{r.name}</button>{r.code ? <span className="text-slate-400 ms-2 font-mono">{r.code}</span> : null}</td>
                  {r.buckets.map((v: number, i: number) => <td key={i} className="p-3 text-end font-mono tabular-nums">{moneyOrBlank(v)}</td>)}
                  <td className="p-3 text-end font-mono tabular-nums text-emerald-700">{r.unapplied ? `(${money(r.unapplied)})` : ''}</td>
                  <td className="p-3 text-end font-mono tabular-nums font-bold">{money(r.total)}</td>
                </tr>
              ))}
            </tbody>
            {data.rows.length > 0 && (
              <tfoot className="bg-slate-50 font-bold border-t-2 border-slate-200">
                <tr><td className="p-3">{t('Total')} ({currency})</td>{data.totals.buckets.map((v: number, i: number) => <td key={i} className="p-3 text-end font-mono tabular-nums">{money(v)}</td>)}<td className="p-3 text-end font-mono tabular-nums">{data.totals.unapplied ? `(${money(data.totals.unapplied)})` : ''}</td><td className="p-3 text-end font-mono tabular-nums">{money(data.totals.total)}</td></tr>
              </tfoot>
            )}
          </table>
        </Card>
      )}
      <p className="text-[11px] text-slate-500">{t('Payments and credits are set against the oldest charges first; what remains is aged from its due date (the document date when no due date was entered). Click a name to see the ledger.')}</p>
    </div>
  );
}

export function PartyLedgerScreen({ db, kind, focus, onFocusConsumed, onOpenEntry }: { db: DatabaseState; kind: PartyKind; focus: PartyFocus | null; onFocusConsumed: () => void; onOpenEntry: (entryId: string) => void }) {
  const { t } = useTranslation(db);
  const [parties, setParties] = React.useState<any[]>([]);
  const [partyId, setPartyId] = React.useState<string>(focus && focus.kind === kind ? (focus.partyId || 'none') : '');
  const [from, setFrom] = React.useState(yearStartIso());
  const [to, setTo] = React.useState(todayIso());
  const [data, setData] = React.useState<any>(null);
  const [error, setError] = React.useState('');
  const currency = db.companySetup?.currency || 'SAR';
  React.useEffect(() => { ledgerApi<any>(`/subledger/${kind}/balances?asOf=${todayIso()}`).then(r => setParties(r.rows)).catch(e => setError(e.message)); }, [kind]);
  React.useEffect(() => { if (focus) onFocusConsumed(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const run = React.useCallback(async () => {
    if (!partyId) return;
    setError('');
    try { setData(await ledgerApi(`/subledger/${kind}/ledger?partyId=${partyId}&from=${from}&to=${to}`)); } catch (e: any) { setError(e.message); setData(null); }
  }, [kind, partyId, from, to]);
  React.useEffect(() => { run(); }, [run]);
  return (
    <div className="space-y-4 pb-10">
      {error && <Notice tone="error">{error}</Notice>}
      <Card className="p-4 flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[260px]"><label className={labelCls}>{t(kind === 'customer' ? 'Customer' : 'Vendor')}</label>
          <select className={inputCls} value={partyId} onChange={e => setPartyId(e.target.value)}>
            <option value="">{t('Choose...')}</option>
            {parties.map(p => <option key={p.partyId || 'none'} value={p.partyId || 'none'}>{p.name}{p.code ? ` · ${p.code}` : ''} ({money(p.balance)})</option>)}
          </select></div>
        <div><label className={labelCls}>{t('From')}</label><input type="date" className={inputCls} value={from} onChange={e => setFrom(e.target.value)} /></div>
        <div><label className={labelCls}>{t('To')}</label><input type="date" className={inputCls} value={to} onChange={e => setTo(e.target.value)} /></div>
        <button className={primaryBtn} onClick={run} disabled={!partyId}><Play className="w-3.5 h-3.5" />{t('Run')}</button>
        <button className={ghostBtn} disabled={!data} onClick={() => downloadLedgerFile(`/subledger/${kind}/ledger/export?partyId=${partyId}&from=${from}&to=${to}`, `${kind}-ledger.xlsx`).catch(e => setError(e.message))}><Download className="w-3.5 h-3.5" />{t('Excel')}</button>
      </Card>
      {!partyId && <Card className="p-8 text-center text-xs text-slate-400">{t(kind === 'customer' ? 'Choose a customer to see the ledger.' : 'Choose a vendor to see the ledger.')}</Card>}
      {data && (
        <>
          {data.branchRestricted && <Notice tone="info">{t('You are limited to your own branches, so these figures cover those branches only.')}</Notice>}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[[t('Opening balance'), data.opening], [t('Debits'), data.totals.debit], [t('Credits'), data.totals.credit], [t('Closing balance'), data.closing]].map(([label, v]: any) => (
              <Card key={label} className="p-4"><div className={labelCls}>{label}</div><div className="text-lg font-black text-slate-900 font-mono tabular-nums">{money(v)} <span className="text-[10px] text-slate-400 font-bold">{currency}</span></div></Card>
            ))}
          </div>
          <Card className="overflow-x-auto">
            <div className="px-5 py-3 border-b border-slate-100 text-xs font-bold text-slate-800">{data.party.name}{data.party.code ? ` · ${data.party.code}` : ''}</div>
            <table className="w-full text-xs text-start">
              <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-500 tracking-wider"><tr><th className="p-3 text-start">{t('Date')}</th><th className="p-3 text-start">{t('Type')}</th><th className="p-3 text-start">{t('Document')}</th><th className="p-3 text-start">{t('Description')}</th><th className="p-3 text-end">{t('Debit')}</th><th className="p-3 text-end">{t('Credit')}</th><th className="p-3 text-end">{t('Balance')}</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                <tr className="bg-slate-50/60"><td className="p-3 font-bold" colSpan={6}>{t('Opening balance')}</td><td className="p-3 text-end font-mono tabular-nums font-bold">{money(data.opening)}</td></tr>
                {data.lines.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-slate-400">{t('No movements in this period.')}</td></tr>}
                {data.lines.map((l: any, i: number) => (
                  <tr key={i} className="hover:bg-slate-50 cursor-pointer" onClick={() => onOpenEntry(l.entryId)}>
                    <td className="p-3 text-slate-600">{l.postingDate}</td><td className="p-3">{t(l.referenceType)}</td><td className="p-3 font-mono">{l.documentNumber || ''}</td><td className="p-3 text-slate-600">{l.description}</td>
                    <td className="p-3 text-end font-mono tabular-nums">{moneyOrBlank(l.debit)}</td><td className="p-3 text-end font-mono tabular-nums">{moneyOrBlank(l.credit)}</td><td className="p-3 text-end font-mono tabular-nums font-bold">{money(l.balance)}</td>
                  </tr>
                ))}
                <tr className="bg-slate-50 font-bold border-t-2 border-slate-200"><td className="p-3" colSpan={4}>{t('Closing balance')}</td><td className="p-3 text-end font-mono tabular-nums">{money(data.totals.debit)}</td><td className="p-3 text-end font-mono tabular-nums">{money(data.totals.credit)}</td><td className="p-3 text-end font-mono tabular-nums">{money(data.closing)}</td></tr>
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}
