import React from 'react';
import { Plus, Trash2, Save, Send, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useTranslation, usePermissions } from '../../hooks';
import type { DatabaseState } from '../../dbStore';
import { ledgerApi, money, todayIso, inputCls, labelCls, primaryBtn, ghostBtn, Card, Notice } from './ui';
import { LineDimensions, useDimensionOptions, type DimTags } from './dimensions';

export interface Acct { id: string; code: string; name: string; nameAr: string | null; type: string; isGroup: boolean; isActive: boolean; isControl: boolean }
interface FormLine { key: number; accountId: string; debit: string; credit: string; note: string; dims: DimTags }
let lineKey = 1;
const blankLine = (): FormLine => ({ key: lineKey++, accountId: '', debit: '', credit: '', note: '', dims: {} });
const num = (s: string) => { const n = Number(s); return isNaN(n) ? 0 : Math.round(n * 100) / 100; };

// Type-ahead account chooser: type a code or a name, pick from the short list. Headings, inactive, control and bank accounts are not offered
// (a document owns those); the server refuses them anyway.
export function AccountPicker({ accounts, value, onChange, lang, placeholder }: { accounts: Acct[]; value: string; onChange: (id: string) => void; lang: string; placeholder: string }) {
  const selected = accounts.find(a => a.id === value);
  const label = (a: Acct) => `${a.code} · ${lang === 'ar' && a.nameAr ? a.nameAr : a.name}`;
  const [text, setText] = React.useState(selected ? label(selected) : '');
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => { setText(selected ? label(selected) : ''); }, [value, selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const needle = text.trim().toLowerCase();
  const matches = accounts.filter(a => !needle || (selected && text === label(selected)) || a.code.toLowerCase().includes(needle) || a.name.toLowerCase().includes(needle) || (a.nameAr || '').includes(needle)).slice(0, 40);
  return (
    <div className="relative">
      <input className={inputCls} value={text} placeholder={placeholder} onFocus={() => setOpen(true)}
        onChange={e => { setText(e.target.value); setOpen(true); if (value) onChange(''); }}
        onBlur={() => setTimeout(() => { setOpen(false); setText(selected ? label(selected) : (accounts.find(a => label(a) === text)?.id ? text : '')); }, 150)} />
      {open && matches.length > 0 && (
        <div className="absolute z-30 mt-1 w-full max-h-56 overflow-y-auto bg-white border border-slate-200 rounded-xl shadow-lg">
          {matches.map(a => (
            <button type="button" key={a.id} onMouseDown={e => { e.preventDefault(); onChange(a.id); setText(label(a)); setOpen(false); }} className="w-full text-start px-3 py-1.5 text-xs hover:bg-indigo-50 cursor-pointer">
              <span className="font-mono text-slate-500 me-2">{a.code}</span>{lang === 'ar' && a.nameAr ? a.nameAr : a.name}<span className="ms-2 text-[9px] uppercase text-slate-400">{a.type}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// New / edit a manual journal. Saving keeps a draft; "Save and submit" sends it for approval. Nothing reaches the ledger until someone else approves.
export default function JournalFormScreen({ db, editId, onDone, onDirtyChange }: {
  db: DatabaseState; editId?: string; onDone: (savedId?: string) => void; onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t, lang } = useTranslation(db);
  const { can } = usePermissions(db.currentUser);
  const [accounts, setAccounts] = React.useState<Acct[]>([]);
  const [date, setDate] = React.useState(todayIso());
  const [description, setDescription] = React.useState('');
  const [reference, setReference] = React.useState('');
  const [preparerNote, setPreparerNote] = React.useState('');
  const [branchId, setBranchId] = React.useState('');
  const [lines, setLines] = React.useState<FormLine[]>([blankLine(), blankLine()]);
  const { options: dimOptions } = useDimensionOptions();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [loaded, setLoaded] = React.useState(!editId);
  const [number, setNumber] = React.useState('');
  const currency = db.companySetup?.currency || 'SAR';
  const branches = (db.branches || []).filter(b => b.companyId === db.selectedCompanyId && b.isActive !== false);
  const dirty = React.useRef(false);
  const touch = () => { if (!dirty.current) { dirty.current = true; onDirtyChange?.(true); } };

  React.useEffect(() => {
    ledgerApi<{ accounts: Acct[] }>('/accounts').then(r => setAccounts(r.accounts)).catch(e => setError(e.message));
  }, []);
  React.useEffect(() => {
    if (!editId) return;
    ledgerApi<any>(`/manual-journals/${editId}`).then(j => {
      setNumber(j.number); setDate(j.date); setDescription(j.description); setReference(j.reference || ''); setPreparerNote(j.preparerNote || ''); setBranchId(j.branchId || '');
      setLines(j.lines.map((l: any) => ({ key: lineKey++, accountId: l.accountId, debit: l.debit ? String(l.debit) : '', credit: l.credit ? String(l.credit) : '', note: l.note || '', dims: l.dimensions || {} })));
      setLoaded(true);
    }).catch(e => setError(e.message));
  }, [editId]);
  React.useEffect(() => () => onDirtyChange?.(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  const postable = accounts.filter(a => a.isActive && !a.isGroup && !a.isControl);
  const totalDebit = lines.reduce((s, l) => s + num(l.debit), 0);
  const totalCredit = lines.reduce((s, l) => s + num(l.credit), 0);
  const diff = Math.round((totalDebit - totalCredit) * 100) / 100;
  const balanced = Math.abs(diff) < 0.005 && totalDebit > 0;
  const filled = lines.filter(l => l.accountId || num(l.debit) || num(l.credit));

  const setLine = (key: number, patch: Partial<FormLine>) => { touch(); setLines(ls => ls.map(l => l.key === key ? { ...l, ...patch } : l)); };

  const payload = () => ({
    date, description, reference, preparerNote, branchId: branchId || null,
    lines: filled.map(l => ({ accountId: l.accountId, debit: num(l.debit) || 0, credit: num(l.credit) || 0, note: l.note, dimensions: l.dims })),
  });

  const save = async (submit: boolean) => {
    setBusy(true); setError('');
    try {
      let id = editId;
      if (editId) await ledgerApi(`/manual-journals/${editId}`, { method: 'PUT', body: payload() });
      else id = (await ledgerApi<any>('/manual-journals', { method: 'POST', body: payload() })).id;
      if (submit) await ledgerApi(`/manual-journals/${id}/submit`, { method: 'POST', body: {} });
      dirty.current = false; onDirtyChange?.(false);
      onDone(id);
    } catch (e: any) { setError(e.message); setBusy(false); }
  };

  if (!loaded) return <p className="text-xs text-slate-400 p-6">{error || t('Loading...')}</p>;

  return (
    <div className="space-y-4 pb-10 max-w-5xl">
      {error && <Notice tone="error">{error}</Notice>}
      <Notice tone="info">{t('A manual journal is a draft until someone else approves it. Customer, supplier, stock, VAT and bank accounts are not offered here: their entries come from invoices, bills, receipts and payments.')}</Notice>
      <Card className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-900">{editId ? `${t('Edit journal')} ${number}` : t('New Manual Journal')}</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div><label className={labelCls}>{t('Date')}</label><input type="date" className={inputCls} value={date} onChange={e => { touch(); setDate(e.target.value); }} /></div>
          <div className="md:col-span-2"><label className={labelCls}>{t('Description (narration)')}</label><input className={inputCls} value={description} maxLength={300} onChange={e => { touch(); setDescription(e.target.value); }} placeholder={t('What is this entry for?')} /></div>
          <div><label className={labelCls}>{t('Reference')}</label><input className={inputCls} value={reference} maxLength={100} onChange={e => { touch(); setReference(e.target.value); }} placeholder={t('Optional')} /></div>
          {branches.length > 0 && (
            <div><label className={labelCls}>{t('Branch')}</label>
              <select className={inputCls} value={branchId} onChange={e => { touch(); setBranchId(e.target.value); }}>
                <option value="">{t('Default (your primary branch)')}</option>
                {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select></div>
          )}
          <div className="md:col-span-3"><label className={labelCls}>{t('Note to the approver')}</label><input className={inputCls} value={preparerNote} maxLength={500} onChange={e => { touch(); setPreparerNote(e.target.value); }} placeholder={t('Optional: supporting detail for whoever reviews it')} /></div>
        </div>

        <div className="border border-slate-200 rounded-xl">
          <table className="w-full text-xs text-start">
            <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-500 tracking-wider">
              <tr><th className="p-2.5 ps-4 text-start w-8">#</th><th className="p-2.5 text-start">{t('Account')}</th><th className="p-2.5 text-start w-40">{t('Line note')}</th><th className="p-2.5 text-end w-32">{t('Debit')}</th><th className="p-2.5 text-end w-32">{t('Credit')}</th><th className="w-10" /></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lines.map((l, i) => (
                <tr key={l.key}>
                  <td className="p-2 ps-4 text-slate-400">{i + 1}</td>
                  <td className="p-2"><AccountPicker accounts={postable} value={l.accountId} lang={lang} placeholder={t('Type a code or name')} onChange={id => setLine(l.key, { accountId: id, dims: {} })} />
                    <LineDimensions db={db} options={dimOptions} accountId={l.accountId} value={l.dims} onChange={dims => setLine(l.key, { dims })} /></td>
                  <td className="p-2"><input className={inputCls} value={l.note} maxLength={300} onChange={e => setLine(l.key, { note: e.target.value })} /></td>
                  <td className="p-2"><input type="number" min="0" step="0.01" className={`${inputCls} text-end font-mono`} value={l.debit} onChange={e => setLine(l.key, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} /></td>
                  <td className="p-2"><input type="number" min="0" step="0.01" className={`${inputCls} text-end font-mono`} value={l.credit} onChange={e => setLine(l.key, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} /></td>
                  <td className="p-2 text-center">{lines.length > 2 && <button title={t('Remove line')} onClick={() => { touch(); setLines(ls => ls.filter(x => x.key !== l.key)); }} className="text-slate-400 hover:text-rose-600 cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-50">
              <tr>
                <td colSpan={3} className="p-2.5 ps-4"><button className={ghostBtn} onClick={() => { touch(); setLines(ls => [...ls, blankLine()]); }}><Plus className="w-3.5 h-3.5" />{t('Add line')}</button></td>
                <td className="p-2.5 text-end font-mono font-bold">{money(totalDebit)}</td>
                <td className="p-2.5 text-end font-mono font-bold">{money(totalCredit)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>

        <div className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold ${balanced ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-amber-50 text-amber-800 border border-amber-200'}`}>
          {balanced ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          {balanced ? t('Balanced: debits equal credits.') : (totalDebit === 0 && totalCredit === 0) ? t('Enter the accounts and amounts. Debits must equal credits.') : `${t('Out of balance by')} ${money(Math.abs(diff))} ${currency} (${diff > 0 ? t('debits are higher') : t('credits are higher')}). ${t('You can save a draft, but it cannot be submitted until it balances.')}`}
        </div>

        <div className="flex items-center justify-end gap-2">
          <button className={ghostBtn} disabled={busy} onClick={() => onDone()}>{t('Cancel')}</button>
          <button className={ghostBtn} disabled={busy || !description.trim() || filled.length === 0} onClick={() => save(false)}><Save className="w-3.5 h-3.5" />{t('Save draft')}</button>
          <button className={primaryBtn} disabled={busy || !description.trim() || !balanced || !can('journals.create') && !can('journals.update')} onClick={() => save(true)}><Send className="w-3.5 h-3.5" />{t('Save and submit for approval')}</button>
        </div>
      </Card>
    </div>
  );
}
