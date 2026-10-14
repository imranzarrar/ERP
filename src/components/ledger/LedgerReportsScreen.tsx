import React from 'react';
import { Download, ChevronLeft, ChevronRight, CheckCircle2, AlertTriangle, Play } from 'lucide-react';
import { useTranslation } from '../../hooks';
import type { DatabaseState } from '../../dbStore';
import { ledgerApi, downloadLedgerFile, money, moneyOrBlank, todayIso, yearStartIso, inputCls, labelCls, primaryBtn, ghostBtn, Card, Notice, SOURCE_LABEL } from './ui';
import { AccountPicker, type Acct } from './JournalFormScreen';
import JournalDetailPanel from './JournalDetailPanel';
import { DimensionFilter, useDimensionOptions, type DimFilterValue } from './dimensions';

export type LedgerReportKind = 'general-ledger' | 'reconciliation';
export interface AccountFocus { accountId?: string; accountIds?: string[]; from: string; to: string; dims?: DimFilterValue }

// The three ledger reports. All are computed in the database for this company from the journal; they never add up what the screen happens to hold.
export default function LedgerReportsScreen({ db, report, accountFocus }: { db: DatabaseState; report: LedgerReportKind; accountFocus?: AccountFocus | null }) {
  if (report === 'general-ledger') return <GeneralLedger db={db} focus={accountFocus || null} />;
  return <Reconciliation db={db} />;
}

function GeneralLedger({ db, focus }: { db: DatabaseState; focus: AccountFocus | null }) {
  const { t, lang } = useTranslation(db);
  const [accounts, setAccounts] = React.useState<Acct[]>([]);
  const [accountId, setAccountId] = React.useState(focus?.accountId || '');
  const [accountIds] = React.useState<string[]>(focus?.accountIds || []);
  const [from, setFrom] = React.useState(focus?.from || yearStartIso());
  const [to, setTo] = React.useState(focus?.to || todayIso());
  const [page, setPage] = React.useState(1);
  const [data, setData] = React.useState<any>(null);
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [open, setOpen] = React.useState<string | null>(null);
  const [dims, setDims] = React.useState<DimFilterValue>({});
  const { options: dimOptions } = useDimensionOptions();
  const dimQs = Object.keys(dims).length ? `&dims=${encodeURIComponent(JSON.stringify(dims))}` : '';
  const currency = db.companySetup?.currency || 'SAR';
  const pageSize = 50;

  React.useEffect(() => { ledgerApi<{ accounts: Acct[] }>('/accounts').then(r => setAccounts(r.accounts)).catch(e => setError(e.message)); }, []);

  // A drill-down from a statement can carry several accounts (a whole report line); picking one account here replaces that set.
  const [drillIds, setDrillIds] = React.useState<string[]>(accountIds);
  const pickAccount = (id: string) => { setDrillIds([]); setAccountId(id); };
  const scope = accountId ? `accountId=${accountId}` : drillIds.length ? `accountIds=${drillIds.join(',')}` : '';
  const run = React.useCallback(async (p = 1) => {
    if (!scope) return;
    setLoading(true); setError('');
    try { setData(await ledgerApi(`/reports/general-ledger?${scope}&from=${from}&to=${to}&page=${p}&pageSize=${pageSize}${dimQs}`)); setPage(p); }
    catch (e: any) { setError(e.message); setData(null); } finally { setLoading(false); }
  }, [scope, from, to, dimQs]);
  React.useEffect(() => { if (scope) run(1); }, [scope, from, to, dimQs]); // eslint-disable-line react-hooks/exhaustive-deps

  const pages = data ? Math.max(1, Math.ceil(data.totals.lines / pageSize)) : 1;
  return (
    <div className="space-y-4 pb-10">
      {error && <Notice tone="error">{error}</Notice>}
      <Card className="p-4 flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[260px]"><label className={labelCls}>{t('Account')}</label>
          <AccountPicker accounts={accounts.filter(a => a.isActive || true)} value={accountId} onChange={pickAccount} lang={lang} placeholder={drillIds.length ? `${drillIds.length} ${t('accts')}` : t('Choose an account or heading')} /></div>
        <div><label className={labelCls}>{t('From')}</label><input type="date" className={inputCls} value={from} onChange={e => setFrom(e.target.value)} /></div>
        <div><label className={labelCls}>{t('To')}</label><input type="date" className={inputCls} value={to} onChange={e => setTo(e.target.value)} /></div>
        <DimensionFilter db={db} options={dimOptions} value={dims} onChange={setDims} />
        <button className={primaryBtn} disabled={!scope || loading} onClick={() => run(1)}><Play className="w-3.5 h-3.5" />{t('Run')}</button>
        <button className={ghostBtn} disabled={!scope} onClick={() => downloadLedgerFile(`/reports/general-ledger/export?${scope}&from=${from}&to=${to}${dimQs}`, 'general-ledger.xlsx').catch(e => setError(e.message))}><Download className="w-3.5 h-3.5" />{t('Export')}</button>
      </Card>
      {!scope && <Card className="p-8 text-center text-xs text-slate-400">{t('Choose an account to see its ledger.')}</Card>}
      {data && (
        <>
          {data.branchRestricted && <Notice tone="info">{t('You are limited to your own branches, so these figures cover those branches only.')}</Notice>}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[[t('Opening balance'), data.opening], [t('Debits'), data.totals.debit], [t('Credits'), data.totals.credit], [t('Closing balance'), data.closing]].map(([label, v]: any) => (
              <Card key={label} className="p-4"><div className={labelCls}>{label}</div><div className="text-lg font-black text-slate-900 font-mono tabular-nums">{money(v)} <span className="text-[10px] text-slate-400 font-bold">{currency}</span></div></Card>
            ))}
          </div>
          <Card className="overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100 text-xs font-bold text-slate-800">{data.account.id === 'selection' ? t('Selected accounts') : <>{data.account.code} · {lang === 'ar' && data.account.nameAr ? data.account.nameAr : data.account.name}{data.account.isGroup ? ` (${t('including everything under this heading')})` : ''}</>}</div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-start">
                <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-500 tracking-wider">
                  <tr><th className="p-3 ps-5 text-start">{t('Date')}</th><th className="p-3 text-start">{t('Source')}</th>{data.account.isGroup && <th className="p-3 text-start">{t('Account')}</th>}<th className="p-3 text-start">{t('Description')}</th><th className="p-3 text-end">{t('Debit')}</th><th className="p-3 text-end">{t('Credit')}</th><th className="p-3 pe-5 text-end">{t('Balance')}</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  <tr className="bg-slate-50/60"><td colSpan={data.account.isGroup ? 6 : 5} className="p-3 ps-5 font-bold text-slate-600">{t('Opening balance')}</td><td className="p-3 pe-5 text-end font-mono font-bold">{money(data.opening)}</td></tr>
                  {data.rows.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-slate-400">{t('No movements in this period.')}</td></tr>}
                  {data.rows.map((r: any, i: number) => (
                    <tr key={`${r.entryId}-${i}`} onClick={() => setOpen(r.entryId)} className="hover:bg-indigo-50/40 cursor-pointer">
                      <td className="p-3 ps-5 text-slate-600">{r.date}</td>
                      <td className="p-3"><span className="px-2 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px] font-bold uppercase">{t(SOURCE_LABEL[r.referenceType] || r.referenceType)}</span>{r.documentNumber && <span className="ms-1.5 font-mono text-slate-500">{r.documentNumber}</span>}</td>
                      {data.account.isGroup && <td className="p-3 text-slate-600">{r.accountCode} {r.accountName}</td>}
                      <td className="p-3 text-slate-700 max-w-sm truncate">{r.description}</td>
                      <td className="p-3 text-end font-mono tabular-nums">{moneyOrBlank(r.debit)}</td>
                      <td className="p-3 text-end font-mono tabular-nums">{moneyOrBlank(r.credit)}</td>
                      <td className="p-3 pe-5 text-end font-mono tabular-nums font-semibold">{money(r.balance)}</td>
                    </tr>
                  ))}
                  <tr className="bg-slate-50 font-bold"><td colSpan={data.account.isGroup ? 4 : 3} className="p-3 ps-5">{t('Closing balance')}</td><td className="p-3 text-end font-mono">{money(data.totals.debit)}</td><td className="p-3 text-end font-mono">{money(data.totals.credit)}</td><td className="p-3 pe-5 text-end font-mono">{money(data.closing)}</td></tr>
                </tbody>
              </table>
            </div>
            {pages > 1 && (
              <div className="flex items-center justify-between px-5 py-3 border-t border-slate-100 text-[11px] text-slate-500">
                <span>{data.totals.lines} {t('movements')}</span>
                <div className="flex items-center gap-2">
                  <button disabled={page <= 1} onClick={() => run(page - 1)} className="p-1.5 rounded-lg border border-slate-200 disabled:opacity-40 cursor-pointer"><ChevronLeft className="w-3.5 h-3.5 rtl:rotate-180" /></button>
                  <span>{page} / {pages}</span>
                  <button disabled={page >= pages} onClick={() => run(page + 1)} className="p-1.5 rounded-lg border border-slate-200 disabled:opacity-40 cursor-pointer"><ChevronRight className="w-3.5 h-3.5 rtl:rotate-180" /></button>
                </div>
              </div>
            )}
          </Card>
        </>
      )}
      {open && <JournalDetailPanel db={db} kind="entry" id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Reconciliation({ db }: { db: DatabaseState }) {
  const { t } = useTranslation(db);
  const [asOf, setAsOf] = React.useState(todayIso());
  const [data, setData] = React.useState<any>(null);
  const [error, setError] = React.useState('');
  const currency = db.companySetup?.currency || 'SAR';
  React.useEffect(() => { setError(''); ledgerApi(`/reports/ledger-vs-documents?asOf=${asOf}`).then(setData).catch(e => { setError(e.message); setData(null); }); }, [asOf]);

  return (
    <div className="space-y-4 pb-10">
      {error && <Notice tone="error">{error}</Notice>}
      <Notice tone="info">{t('The ledger is the journal of every posting. The existing reports (Balance Sheet, Profit and Loss) are built from the documents. For everything documents post, the two must agree. Manual journals and opening balances live in the ledger only, so they are shown separately below.')}</Notice>
      <Card className="p-4 flex items-end gap-3"><div><label className={labelCls}>{t('As at')}</label><input type="date" className={inputCls} value={asOf} onChange={e => setAsOf(e.target.value)} /></div></Card>
      {data && (
        <>
          <div className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold ${data.inAgreement ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-amber-50 text-amber-800 border border-amber-200'}`}>
            {data.inAgreement ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
            {data.inAgreement ? t('The ledger agrees with the document-based reports, account by account.') : t('Some accounts differ between the ledger and the documents. Each difference is shown below.')}
          </div>
          <Card className="overflow-hidden">
            <table className="w-full text-xs text-start">
              <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-500 tracking-wider">
                <tr><th className="p-3 ps-5 text-start">{t('Account')}</th><th className="p-3 text-end">{t('Ledger')} ({currency})</th><th className="p-3 text-end">{t('Documents')} ({currency})</th><th className="p-3 text-end">{t('Difference')}</th><th className="p-3 pe-5 text-center w-16" /></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.rows.map((r: any) => (
                  <tr key={r.key}>
                    <td className="p-3 ps-5 font-semibold text-slate-700">{t(r.label)}</td>
                    <td className="p-3 text-end font-mono tabular-nums">{money(r.ledger)}</td>
                    <td className="p-3 text-end font-mono tabular-nums">{money(r.documents)}</td>
                    <td className={`p-3 text-end font-mono tabular-nums ${Math.abs(r.difference) < 0.011 ? 'text-slate-300' : 'text-rose-600 font-bold'}`}>{money(r.difference)}</td>
                    <td className="p-3 pe-5 text-center">{Math.abs(r.difference) < 0.011 ? <CheckCircle2 className="w-4 h-4 text-emerald-500 inline" /> : <AlertTriangle className="w-4 h-4 text-amber-500 inline" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <Card className="p-4"><div className={labelCls}>{t('Manual journals posted')}</div><div className="text-lg font-black text-slate-900">{data.manual.entries}</div><div className="text-[11px] text-slate-500 font-mono">{money(data.manual.debit)} {currency}</div></Card>
            <Card className="p-4"><div className={labelCls}>{t('Opening balance entries')}</div><div className="text-lg font-black text-slate-900">{data.opening.entries}</div><div className="text-[11px] text-slate-500 font-mono">{money(data.opening.debit)} {currency}</div></Card>
            <Card className="p-4"><div className={labelCls}>{t('Manual journals pending approval')}</div><div className="text-lg font-black text-slate-900">{data.pendingManual}</div></Card>
            <Card className="p-4"><div className={labelCls}>{t('Lines on no account')}</div><div className={`text-lg font-black ${data.unmappedLines ? 'text-rose-600' : 'text-slate-900'}`}>{data.unmappedLines}</div></Card>
          </div>
        </>
      )}
    </div>
  );
}
