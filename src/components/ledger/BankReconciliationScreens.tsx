import React from 'react';
import { Plus, Upload, Wand2, CheckCircle2, AlertTriangle, Lock, Unlock, Trash2, Unlink, Receipt, Undo2, ArrowLeft, Printer } from 'lucide-react';
import { useTranslation } from '../../hooks';
import type { DatabaseState } from '../../dbStore';
import { erpApi, Card, Notice, Modal, inputCls, labelCls, primaryBtn, ghostBtn, dangerBtn, greenBtn, money, todayIso, useBanner } from './ui';

// Bank reconciliation (server/lib/bankReconciliation.ts, Blueprint FR-BANK-01..05): pick a bank and the statement's date and ending balance, tick off (or match) every ledger
// line the bank has confirmed, post the bank fee / interest the books do not have yet, and complete only when the cleared lines add up to the statement.
const API = '/api/bank-reconciliations';
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function BankReconciliationScreen({ db }: { db: DatabaseState }) {
  const { t } = useTranslation(db);
  const currency = db.companySetup?.currency || 'SAR';
  const banks = (db.banks || []).filter((b: any) => b.isActive !== false);
  const [rows, setRows] = React.useState<any[]>([]);
  const [open, setOpen] = React.useState<string | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [bankFilter, setBankFilter] = React.useState('');
  const { banner, show } = useBanner();
  const load = React.useCallback(async () => {
    try { setRows((await erpApi<{ rows: any[] }>(`${API}${bankFilter ? `?bankId=${bankFilter}` : ''}`)).rows); } catch (e: any) { show('error', e.message); }
  }, [bankFilter, show]);
  React.useEffect(() => { load(); }, [load]);

  if (open) return <ReconciliationSession db={db} id={open} onBack={() => { setOpen(null); load(); }} />;
  return (
    <div className="space-y-4 pb-10">
      {banner && <Notice tone={banner.tone}>{banner.text}</Notice>}
      <Card className="p-4 flex flex-wrap items-end gap-3">
        <div className="min-w-[14rem]"><label className={labelCls}>{t('Bank / cash account')}</label>
          <select className={inputCls} value={bankFilter} onChange={e => setBankFilter(e.target.value)}>
            <option value="">{t('All')}</option>{banks.map((b: any) => <option key={b.id} value={b.id}>{b.bankName}</option>)}
          </select></div>
        <button className={`${primaryBtn} ms-auto`} onClick={() => setStarting(true)}><Plus className="w-3.5 h-3.5" />{t('Start reconciliation')}</button>
      </Card>
      <Card className="overflow-x-auto">
        <table className="w-full text-xs text-start">
          <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-500 tracking-wider">
            <tr><th className="p-3 text-start">{t('Statement date')}</th><th className="p-3 text-start">{t('Bank / cash account')}</th><th className="p-3 text-end">{t('Statement balance')}</th>
              <th className="p-3 text-end">{t('Book balance')}</th><th className="p-3 text-end">{t('Cleared lines')}</th><th className="p-3 text-start">{t('Status')}</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-slate-400">{t('No reconciliations yet.')}</td></tr>}
            {rows.map(r => (
              <tr key={r.id} className="hover:bg-slate-50 cursor-pointer" onClick={() => setOpen(r.id)}>
                <td className="p-3 font-mono font-bold text-indigo-700">{r.statementDate}</td><td className="p-3">{r.bankName}</td>
                <td className="p-3 text-end font-mono tabular-nums">{money(r.statementEndingBalance)} {currency}</td>
                <td className="p-3 text-end font-mono tabular-nums">{r.glBalanceAtReconciliation == null ? '' : money(r.glBalanceAtReconciliation)}</td>
                <td className="p-3 text-end font-mono tabular-nums">{r.clearedLines}</td>
                <td className="p-3">{r.status === 'Completed' ? <span className="inline-flex items-center gap-1 text-emerald-700 font-bold"><Lock className="w-3 h-3" />{t('Completed')}</span> : <span className="text-amber-600 font-bold">{t('In progress')}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {starting && <StartModal db={db} banks={banks} onClose={() => setStarting(false)} onStarted={id => { setStarting(false); setOpen(id); }} />}
    </div>
  );
}

function StartModal({ db, banks, onClose, onStarted }: { db: DatabaseState; banks: any[]; onClose: () => void; onStarted: (id: string) => void }) {
  const { t } = useTranslation(db);
  const [bankId, setBankId] = React.useState((banks.find((b: any) => b.isDefault) || banks[0])?.id || '');
  const [statementDate, setStatementDate] = React.useState(todayIso());
  const [balance, setBalance] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const go = async () => {
    setBusy(true); setError('');
    try { onStarted((await erpApi<any>(API, { method: 'POST', body: { bankId, statementDate, statementEndingBalance: Number(balance) } })).id); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal title={t('Start reconciliation')} onClose={onClose} width="max-w-md"
      footer={<><button className={ghostBtn} onClick={onClose}>{t('Close')}</button><button className={primaryBtn} disabled={!bankId || balance === '' || busy} onClick={go}>{t('Start')}</button></>}>
      {error && <Notice tone="error">{error}</Notice>}
      <div><label className={labelCls}>{t('Bank / cash account')}</label>
        <select className={inputCls} value={bankId} onChange={e => setBankId(e.target.value)}>{banks.map((b: any) => <option key={b.id} value={b.id}>{b.bankName}</option>)}</select></div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className={labelCls}>{t('Statement date')}</label><input type="date" className={inputCls} value={statementDate} max={todayIso()} onChange={e => setStatementDate(e.target.value)} /></div>
        <div><label className={labelCls}>{t('Statement ending balance')}</label><input type="number" step="0.01" className={`${inputCls} font-mono`} value={balance} onChange={e => setBalance(e.target.value)} /></div>
      </div>
      <p className="text-slate-500">{t('Take the ending balance from the last line of the bank statement.')}</p>
    </Modal>
  );
}

// ---- CSV import: parsed in the browser, shown for confirmation, then sent as plain lines ----
function splitCsv(text: string): string[][] {
  const rows: string[][] = []; let cur: string[] = []; let cell = ''; let q = false;
  const delim = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === delim) { cur.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; cur.push(cell); cell = ''; if (cur.some(x => x.trim())) rows.push(cur); cur = []; }
    else cell += c;
  }
  cur.push(cell); if (cur.some(x => x.trim())) rows.push(cur);
  return rows;
}
const toIso = (v: string): string | null => {
  const s = v.trim(); let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);          // day first (the usual order on a Saudi bank statement)
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
};
const toNum = (v: string): number => { const s = String(v ?? '').replace(/[\s,]/g, '').replace(/^\((.*)\)$/, '-$1'); return s === '' ? 0 : Number(s); };
export function parseStatementCsv(text: string): { lines: { date: string; description: string; reference: string; amount: number }[]; errors: string[] } {
  const rows = splitCsv(text.replace(/^﻿/, '')); const errors: string[] = [];
  if (rows.length < 2) return { lines: [], errors: ['The file has no data rows.'] };
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = (...names: string[]) => head.findIndex(h => names.some(n => h.includes(n)));
  const iDate = col('date'), iDesc = col('description', 'details', 'narration', 'particulars'), iRef = col('reference', 'ref', 'cheque'), iAmt = col('amount'), iDeb = col('debit', 'withdraw', 'paid out'), iCre = col('credit', 'deposit', 'paid in');
  if (iDate < 0 || (iAmt < 0 && iDeb < 0 && iCre < 0)) return { lines: [], errors: ['The first row must name the columns: Date, Description, and Amount (or Debit and Credit).'] };
  const lines: { date: string; description: string; reference: string; amount: number }[] = [];
  rows.slice(1).forEach((r, i) => {
    const date = toIso(r[iDate] || ''); const amount = iAmt >= 0 ? toNum(r[iAmt]) : toNum(r[iCre] || '') - toNum(r[iDeb] || '');
    if (!date) { errors.push(`Row ${i + 2}: the date "${r[iDate]}" is not understood.`); return; }
    if (!Number.isFinite(amount) || amount === 0) { errors.push(`Row ${i + 2}: no amount.`); return; }
    lines.push({ date, description: (iDesc >= 0 ? r[iDesc] : '') || '', reference: (iRef >= 0 ? r[iRef] : '') || '', amount: r2(amount) });
  });
  return { lines, errors };
}

function ReconciliationSession({ db, id, onBack }: { db: DatabaseState; id: string; onBack: () => void }) {
  const { t } = useTranslation(db);
  const currency = db.companySetup?.currency || 'SAR';
  const [d, setD] = React.useState<any>(null);
  const { banner, show } = useBanner();
  const [adjust, setAdjust] = React.useState<any>(null);          // statement line being posted as an entry (or {} for a free one)
  const [imp, setImp] = React.useState<{ lines: any[]; errors: string[] } | null>(null);
  const [sugg, setSugg] = React.useState<any[] | null>(null);
  const [reopen, setReopen] = React.useState(false);
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);
  const [newLine, setNewLine] = React.useState({ date: todayIso(), description: '', amount: '' });
  const [balanceEdit, setBalanceEdit] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const load = React.useCallback(async () => { try { setD(await erpApi(`${API}/${id}`)); } catch (e: any) { show('error', e.message); } }, [id, show]);
  React.useEffect(() => { load(); }, [load]);
  const act = async (fn: () => Promise<any>, ok?: string) => { try { const r = await fn(); if (ok) show('success', ok); await load(); return r; } catch (e: any) { show('error', e.message); } };
  if (!d) return <div className="space-y-3">{banner && <Notice tone={banner.tone}>{banner.text}</Notice>}<button className={ghostBtn} onClick={onBack}><ArrowLeft className="w-3.5 h-3.5" />{t('Back')}</button></div>;
  const s = d.summary; const open = d.session.status === 'InProgress';
  const post = (p: string, body?: any, method = 'POST') => erpApi(`${API}/${id}${p}`, { method, body });
  const free = d.lines.filter((l: any) => !l.statementLineId);
  const clearedCount = d.lines.filter((l: any) => l.cleared).length;
  const toggleAll = (on: boolean) => act(() => post('/clear', { lineIds: d.lines.filter((l: any) => !l.statementLineId && l.cleared !== on).map((l: any) => l.lineId), clear: on }));
  const sourceLabel = (l: any) => ({ BankCharge: 'Bank charge', BankInterest: 'Bank interest', CustomerReceipt: 'Customer receipt', VendorPayment: 'Vendor payment', Invoice: 'Invoice', Expense: 'Expense', PurchaseBill: 'Purchase Bill', Manual: 'Manual journal', Opening: 'Opening balance', Transfer: 'Transfer' } as any)[l.referenceType] || l.referenceType;

  const onFile = async (f: File | undefined) => {
    if (!f) return; const text = await f.text(); setImp(parseStatementCsv(text)); if (fileRef.current) fileRef.current.value = '';
  };
  const openSuggestions = async () => { const r = await erpApi<{ rows: any[] }>(`${API}/${id}/suggestions`); setSugg(r.rows); };

  return (
    <div className="space-y-4 pb-10">
      {banner && <Notice tone={banner.tone}>{banner.text}</Notice>}
      <div className="flex flex-wrap items-center gap-3">
        <button className={ghostBtn} onClick={onBack}><ArrowLeft className="w-3.5 h-3.5" />{t('Back')}</button>
        <div className="text-sm font-bold text-slate-900">{d.bank.name} · {d.session.statementDate}</div>
        {open ? <span className="text-amber-600 text-xs font-bold">{t('In progress')}</span> : <span className="inline-flex items-center gap-1 text-emerald-700 text-xs font-bold"><Lock className="w-3 h-3" />{t('Completed')}</span>}
        <div className="ms-auto flex gap-2">
          <button className={ghostBtn} onClick={() => window.open(`${API}/${id}/print`, '_blank')}><Printer className="w-3.5 h-3.5" />{t('Print report')}</button>
          {open && <button className={dangerBtn} onClick={() => setConfirmDiscard(true)}><Trash2 className="w-3.5 h-3.5" />{t('Discard')}</button>}
          {open && <button className={greenBtn} disabled={!s.canComplete} onClick={() => act(() => post('/complete'), t('Reconciliation completed.'))}><CheckCircle2 className="w-3.5 h-3.5" />{t('Complete')}</button>}
          {!open && <button className={ghostBtn} onClick={() => setReopen(true)}><Unlock className="w-3.5 h-3.5" />{t('Reopen')}</button>}
        </div>
      </div>

      <Card className="p-4 space-y-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <div><div className={labelCls}>{t('Statement ending balance')}</div>
            {open && balanceEdit !== null
              ? <input autoFocus type="number" step="0.01" className={`${inputCls} font-mono`} value={balanceEdit} onChange={e => setBalanceEdit(e.target.value)}
                  onBlur={() => { const v = balanceEdit; setBalanceEdit(null); if (v !== '' && Number(v) !== s.statementBalance) act(() => post('', { statementEndingBalance: Number(v) }, 'PATCH')); }} />
              : <button className="font-mono font-bold text-slate-900 hover:underline cursor-pointer" disabled={!open} onClick={() => setBalanceEdit(String(s.statementBalance))}>{money(s.statementBalance)} {currency}</button>}</div>
          <div><div className={labelCls}>{t('Cleared balance')}</div><div className="font-mono font-bold">{money(s.clearedBalance)} {currency}</div></div>
          <div><div className={labelCls}>{t('Book balance')}</div><div className="font-mono font-bold">{money(s.bookBalance)} {currency}</div></div>
          <div><div className={labelCls}>{t('Difference')}</div><div className={`font-mono font-bold ${Math.abs(s.difference) < 0.005 ? 'text-emerald-700' : 'text-rose-600'}`}>{money(s.difference)} {currency}</div></div>
        </div>
        <div className="text-[11px] text-slate-500 border-t border-slate-100 pt-2">
          {t('Statement balance')} {money(s.statementBalance)} + {t('deposits in transit')} {money(s.depositsInTransit)} − {t('payments outstanding')} {money(s.paymentsOutstanding)} = <b>{money(s.adjustedStatementBalance)}</b> {t('which should equal the book balance')} <b>{money(s.bookBalance)}</b>
          {Math.abs(s.adjustedStatementBalance - s.bookBalance) < 0.005 ? <span className="text-emerald-700 font-bold"> ✓</span> : <span className="text-rose-600 font-bold"> ✗</span>}
        </div>
        {open && !s.canComplete && (
          <div className="flex items-center gap-2 text-[11px] text-amber-700"><AlertTriangle className="w-3.5 h-3.5" />
            {s.unmatchedStatementLines > 0 ? `${s.unmatchedStatementLines} ${t('statement line(s) are not matched yet.')} ` : ''}{Math.abs(s.difference) >= 0.005 ? t('It can be completed only when the difference is zero. Post an entry for what the books are missing; do not force it.') : ''}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card className="overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
            <div className="text-xs font-bold text-slate-800">{t('Ledger lines of this bank account')}</div><span className="text-[10px] text-slate-400">{clearedCount}/{d.lines.length} {t('cleared')}</span>
            {open && <div className="ms-auto flex gap-2"><button className={ghostBtn} onClick={() => toggleAll(true)}>{t('Clear all')}</button><button className={ghostBtn} onClick={() => toggleAll(false)}>{t('Un-clear all')}</button></div>}
          </div>
          <div className="overflow-x-auto max-h-[28rem] overflow-y-auto">
            <table className="w-full text-xs text-start">
              <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-500 tracking-wider sticky top-0">
                <tr><th className="p-2.5 w-8"></th><th className="p-2.5 text-start">{t('Date')}</th><th className="p-2.5 text-start">{t('Description')}</th><th className="p-2.5 text-end">{t('Money in')}</th><th className="p-2.5 text-end">{t('Money out')}</th><th className="p-2.5"></th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {d.lines.length === 0 && <tr><td colSpan={6} className="p-5 text-center text-slate-400">{t('No ledger lines.')}</td></tr>}
                {d.lines.map((l: any) => (
                  <tr key={l.lineId} className={l.cleared ? 'bg-emerald-50/40' : ''}>
                    <td className="p-2.5"><input type="checkbox" checked={l.cleared} disabled={!open || !!l.statementLineId} title={l.statementLineId ? t('Matched to a statement line') : ''}
                      onChange={e => act(() => post('/clear', { lineIds: [l.lineId], clear: e.target.checked }))} /></td>
                    <td className="p-2.5 font-mono">{l.postingDate}</td>
                    <td className="p-2.5"><div className="font-medium text-slate-800">{l.description}</div><div className="text-[10px] text-slate-400">{t(sourceLabel(l))}{l.statementLineId ? ` · ${t('matched')}` : ''}</div></td>
                    <td className="p-2.5 text-end font-mono tabular-nums">{l.debit > 0 ? money(l.debit) : ''}</td>
                    <td className="p-2.5 text-end font-mono tabular-nums">{l.credit > 0 ? money(l.credit) : ''}</td>
                    <td className="p-2.5 text-end">{open && (l.referenceType === 'BankCharge' || l.referenceType === 'BankInterest') && l.cleared &&
                      <button className="text-rose-600 hover:underline cursor-pointer inline-flex items-center gap-1" title={t('Take this entry back')} onClick={() => act(() => post(`/adjustments/${l.referenceId}/reverse`, {}), t('The entry was reversed.'))}><Undo2 className="w-3 h-3" />{t('Reverse')}</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex flex-wrap items-center gap-2">
            <div className="text-xs font-bold text-slate-800">{t('Bank statement lines')}</div>
            {open && <div className="ms-auto flex gap-2">
              <button className={ghostBtn} onClick={openSuggestions} disabled={!d.statementLines.some((x: any) => !x.isMatched)}><Wand2 className="w-3.5 h-3.5" />{t('Suggest matches')}</button>
              <button className={ghostBtn} onClick={() => fileRef.current?.click()}><Upload className="w-3.5 h-3.5" />{t('Import CSV')}</button>
              <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={e => onFile(e.target.files?.[0])} />
            </div>}
          </div>
          {open && (
            <div className="px-4 py-3 border-b border-slate-100 grid grid-cols-12 gap-2 items-end">
              <div className="col-span-3"><label className={labelCls}>{t('Date')}</label><input type="date" className={inputCls} value={newLine.date} onChange={e => setNewLine({ ...newLine, date: e.target.value })} /></div>
              <div className="col-span-4"><label className={labelCls}>{t('Description')}</label><input className={inputCls} value={newLine.description} onChange={e => setNewLine({ ...newLine, description: e.target.value })} /></div>
              <div className="col-span-3"><label className={labelCls}>{t('Amount (+ in / − out)')}</label><input type="number" step="0.01" className={`${inputCls} font-mono`} value={newLine.amount} onChange={e => setNewLine({ ...newLine, amount: e.target.value })} /></div>
              <div className="col-span-2"><button className={`${primaryBtn} w-full justify-center`} disabled={!newLine.date || !Number(newLine.amount)}
                onClick={() => act(async () => { await post('/statement-lines', { lines: [{ date: newLine.date, description: newLine.description, amount: Number(newLine.amount) }] }); setNewLine({ ...newLine, description: '', amount: '' }); })}><Plus className="w-3.5 h-3.5" />{t('Add')}</button></div>
            </div>
          )}
          <div className="overflow-x-auto max-h-[24rem] overflow-y-auto">
            <table className="w-full text-xs text-start">
              <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-500 tracking-wider sticky top-0">
                <tr><th className="p-2.5 text-start">{t('Date')}</th><th className="p-2.5 text-start">{t('Description')}</th><th className="p-2.5 text-end">{t('Amount')}</th><th className="p-2.5 text-end">{t('Match')}</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {d.statementLines.length === 0 && <tr><td colSpan={4} className="p-5 text-center text-slate-400">{t('Add the lines of the bank statement, or import a CSV file.')}</td></tr>}
                {d.statementLines.map((x: any) => (
                  <tr key={x.id} className={x.isMatched ? 'bg-emerald-50/40' : ''}>
                    <td className="p-2.5 font-mono">{x.statementDate}</td><td className="p-2.5">{x.description}{x.reference ? <span className="text-slate-400"> · {x.reference}</span> : null}</td>
                    <td className={`p-2.5 text-end font-mono tabular-nums ${x.amount < 0 ? 'text-rose-600' : 'text-slate-800'}`}>{money(x.amount)}</td>
                    <td className="p-2.5 text-end whitespace-nowrap">
                      {x.isMatched ? (open ? <button className="text-slate-600 hover:underline cursor-pointer inline-flex items-center gap-1" onClick={() => act(() => post('/unmatch', { statementLineId: x.id }))}><Unlink className="w-3 h-3" />{t('Un-match')}</button> : <span className="text-emerald-700 font-bold">{t('matched')}</span>)
                        : open ? (<span className="inline-flex items-center gap-2">
                          <MatchPicker t={t} candidates={free.filter((l: any) => Math.abs((l.debit - l.credit) - x.amount) < 0.005)} onPick={(lineId: string) => act(() => post('/match', { statementLineId: x.id, journalLineId: lineId }))} />
                          <button className="text-indigo-700 hover:underline cursor-pointer inline-flex items-center gap-1" onClick={() => setAdjust(x)}><Receipt className="w-3 h-3" />{t(x.amount < 0 ? 'Post as bank charge' : 'Post as interest')}</button>
                          <button className="text-rose-600 cursor-pointer" title={t('Remove')} onClick={() => act(() => post(`/statement-lines/${x.id}`, undefined, 'DELETE'))}><Trash2 className="w-3 h-3" /></button>
                        </span>) : <span className="text-rose-600">{t('not matched')}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {adjust && <AdjustModal db={db} sessionId={id} line={adjust} onClose={() => setAdjust(null)} onDone={async () => { setAdjust(null); show('success', t('The entry was posted and cleared.')); await load(); }} />}
      {imp && (
        <Modal title={t('Import statement lines')} onClose={() => setImp(null)} width="max-w-2xl"
          footer={<><button className={ghostBtn} onClick={() => setImp(null)}>{t('Close')}</button>
            <button className={primaryBtn} disabled={!imp.lines.length} onClick={async () => { const l = imp.lines; setImp(null); const r = await act(() => post('/statement-lines', { lines: l })); if (r) show('success', `${r.added} ${t('added')}, ${r.skipped} ${t('already there')}.`); }}>{t('Add')} {imp.lines.length}</button></>}>
          {imp.errors.length > 0 && <Notice tone="warn"><div className="space-y-0.5">{imp.errors.slice(0, 6).map((e, i) => <div key={i}>{e}</div>)}{imp.errors.length > 6 && <div>…</div>}</div></Notice>}
          <div className="max-h-72 overflow-y-auto border border-slate-100 rounded-xl"><table className="w-full text-xs"><tbody className="divide-y divide-slate-100">
            {imp.lines.slice(0, 200).map((l, i) => <tr key={i}><td className="p-2 font-mono">{l.date}</td><td className="p-2">{l.description}</td><td className={`p-2 text-end font-mono ${l.amount < 0 ? 'text-rose-600' : ''}`}>{money(l.amount)}</td></tr>)}
          </tbody></table></div>
          <p className="text-slate-500">{t('Dates are read day first (31/12/2026) unless written year first (2026-12-31). Lines already in this reconciliation are skipped.')}</p>
        </Modal>
      )}
      {sugg && (
        <Modal title={t('Suggested matches')} onClose={() => setSugg(null)} width="max-w-2xl"
          footer={<><button className={ghostBtn} onClick={() => setSugg(null)}>{t('Close')}</button>
            <button className={primaryBtn} disabled={!sugg.length} onClick={async () => { const rows = sugg; setSugg(null); for (const r of rows) { try { await post('/match', { statementLineId: r.statementLineId, journalLineId: r.journalLineId }); } catch { /* the next load shows what is still open */ } } await load(); show('success', t('Matches applied.')); }}>{t('Accept all')} ({sugg.length})</button></>}>
          {sugg.length === 0 ? <p className="text-slate-500">{t('Nothing to suggest: no unmatched statement line has a ledger line of the same amount within 10 days.')}</p> :
            <table className="w-full text-xs"><tbody className="divide-y divide-slate-100">
              {sugg.map(r => { const sl = d.statementLines.find((x: any) => x.id === r.statementLineId); const ll = d.lines.find((x: any) => x.lineId === r.journalLineId);
                return <tr key={r.statementLineId}><td className="p-2"><div className="font-mono">{sl?.statementDate}</div><div>{sl?.description}</div></td><td className="p-2 text-end font-mono font-bold">{money(sl?.amount)}</td>
                  <td className="p-2 text-slate-400">↔</td><td className="p-2"><div className="font-mono">{ll?.postingDate}</div><div>{ll?.description}</div></td><td className="p-2 text-end text-[10px] text-slate-400">{r.dayDiff} {t('days apart')}</td></tr>; })}
            </tbody></table>}
        </Modal>
      )}
      {reopen && <ReopenModal db={db} onClose={() => setReopen(false)} onReopen={async reason => { await act(() => post('/reopen', { reason }), t('Reconciliation reopened.')); setReopen(false); }} />}
      {confirmDiscard && (
        <Modal title={t('Discard this reconciliation')} onClose={() => setConfirmDiscard(false)} width="max-w-md"
          footer={<><button className={ghostBtn} onClick={() => setConfirmDiscard(false)}>{t('Keep it')}</button><button className={dangerBtn} onClick={async () => { try { await post('', undefined, 'DELETE'); onBack(); } catch (e: any) { show('error', e.message); setConfirmDiscard(false); } }}>{t('Discard')}</button></>}>
          <p className="text-slate-600">{t('Every line cleared in it is released and its statement lines are removed. Entries posted from inside it (bank fees, interest) stay in the books.')}</p>
        </Modal>
      )}
    </div>
  );
}

function MatchPicker({ t, candidates, onPick }: { t: (k: string) => string; candidates: any[]; onPick: (lineId: string) => void }) {
  if (!candidates.length) return null;
  return (
    <select className="border border-slate-200 rounded-lg px-1.5 py-1 text-[11px] bg-white max-w-[11rem]" value="" onChange={e => { if (e.target.value) onPick(e.target.value); }}>
      <option value="">{t('Match to…')}</option>
      {candidates.map(c => <option key={c.lineId} value={c.lineId}>{c.postingDate} · {c.description.slice(0, 28)}</option>)}
    </select>
  );
}

function AdjustModal({ db, sessionId, line, onClose, onDone }: { db: DatabaseState; sessionId: string; line: any; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation(db);
  const out = Number(line.amount) < 0;
  const [accounts, setAccounts] = React.useState<any[]>([]);
  const [accountId, setAccountId] = React.useState('');
  const [description, setDescription] = React.useState(line.description || '');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { erpApi<{ accounts: any[] }>(`${API}/adjustment-accounts`).then(r => setAccounts(r.accounts.filter(a => a.type === (out ? 'Expense' : 'Revenue')))).catch(e => setError(e.message)); }, [out]);
  const go = async () => {
    setBusy(true); setError('');
    try { await erpApi(`${API}/${sessionId}/adjustment`, { method: 'POST', body: { statementLineId: line.id, accountId, description } }); onDone(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal title={t(out ? 'Post as bank charge' : 'Post as bank interest')} onClose={onClose} width="max-w-md"
      footer={<><button className={ghostBtn} onClick={onClose}>{t('Close')}</button><button className={primaryBtn} disabled={!accountId || busy} onClick={go}>{t('Post')}</button></>}>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div><div className={labelCls}>{t('Date')}</div><div className="font-mono">{line.statementDate}</div></div>
        <div><div className={labelCls}>{t('Amount')}</div><div className="font-mono font-bold">{money(line.amount)}</div></div>
      </div>
      <div><label className={labelCls}>{t(out ? 'Expense account' : 'Income account')}</label>
        <select className={inputCls} value={accountId} onChange={e => setAccountId(e.target.value)}><option value="">{t('Choose an account')}</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></div>
      <div><label className={labelCls}>{t('Description')}</label><input className={inputCls} value={description} onChange={e => setDescription(e.target.value)} /></div>
      <p className="text-slate-500">{t('One entry is posted between the bank and that account, dated on the statement line, and cleared in this reconciliation at once.')}</p>
    </Modal>
  );
}

function ReopenModal({ db, onClose, onReopen }: { db: DatabaseState; onClose: () => void; onReopen: (reason: string) => void }) {
  const { t } = useTranslation(db);
  const [reason, setReason] = React.useState('');
  return (
    <Modal title={t('Reopen this reconciliation')} onClose={onClose} width="max-w-md"
      footer={<><button className={ghostBtn} onClick={onClose}>{t('Close')}</button><button className={dangerBtn} disabled={!reason.trim()} onClick={() => onReopen(reason)}>{t('Reopen')}</button></>}>
      <p className="text-slate-600">{t('The cleared lines become changeable again. Only the latest completed reconciliation of a bank can be reopened, and the reason is recorded in the audit trail.')}</p>
      <div><label className={labelCls}>{t('Reason')}</label><input className={inputCls} value={reason} onChange={e => setReason(e.target.value)} /></div>
    </Modal>
  );
}
