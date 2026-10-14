import React from 'react';
import { Plus, Trash2, ArrowUp, ArrowDown, Copy, Save, RotateCcw, Star, Power, ListPlus, Columns3 } from 'lucide-react';
import { useTranslation, usePermissions } from '../../hooks';
import type { DatabaseState } from '../../dbStore';
import type { ReportFormat } from '../../reportFormat';
import { ledgerApi, todayIso, yearStartIso, inputCls, labelCls, primaryBtn, ghostBtn, dangerBtn, Card, Notice, Modal, useBanner } from './ui';
import { AccountPicker, type Acct } from './JournalFormScreen';
import { DimensionFilter, useDimensionOptions, type DimFilterValue } from './dimensions';
import { StatementTable } from './ReportRunScreen';

// The Report Designer: every row and column of a Trial Balance, Income Statement, Balance Sheet or custom report, with a live preview of the statement the
// rules produce (evaluated by the server on the unsaved design, so the preview is exactly what will be run).
const ROW_TYPES = [['Heading', 'Heading'], ['Accounts', 'Accounts (a group of accounts)'], ['Subtotal', 'Subtotal (adds the rows above since the last subtotal)'], ['Calculated', 'Formula (add or subtract rows)'], ['ProfitToDate', 'Profit (loss) to date'], ['Text', 'Text note'], ['Spacer', 'Blank row']] as const;
const DISPLAYS = [['Net', 'Net (debits less credits)'], ['Debit', 'Debits only'], ['Credit', 'Credits only'], ['DebitBalances', 'Debit balances only'], ['CreditBalances', 'Credit balances only'], ['Split', 'Split by account (no netting)']] as const;
const SELECTORS = [['Account', 'One account'], ['ParentRollup', 'A heading and everything under it'], ['Range', 'A range of codes'], ['Type', 'Every account of a type'], ['Role', 'The account of a posting role']] as const;
const PERIODS = [['CurrentPeriod', 'The period chosen'], ['YearToDate', 'Year to date'], ['PriorPeriod', 'The previous period'], ['PriorYear', 'Same period last year'], ['AsAtEnd', 'As at the end date'], ['AsAtPriorYearEnd', 'As at last year\'s end date'], ['AsAtPriorPeriodEnd', 'As at the end of the previous period'], ['CustomRange', 'A fixed date range']] as const;
const BASES = [['Movement', 'Movement (net activity)'], ['Debit', 'Debits'], ['Credit', 'Credits'], ['OpeningBalance', 'Opening balance'], ['ClosingBalance', 'Closing balance']] as const;
const ROLES: [string, string][] = [['SALES_REVENUE', 'Sales revenue'], ['AR', 'Receivable'], ['VAT_OUTPUT', 'VAT output'], ['INVENTORY', 'Inventory'], ['GR_IR_CLEARING', 'Goods received not invoiced'], ['AP', 'Payable'], ['VAT_INPUT', 'VAT input'], ['VENDOR_CREDIT_RECEIVABLE', 'Vendor credit receivable'], ['COGS', 'Cost of goods sold'], ['DIRECT_OPEX', 'Default expense'], ['FIXED_ASSETS', 'Fixed assets'], ['BANK', 'Bank / cash (not allocated)'], ['PAID_IN_CAPITAL', 'Owner capital'], ['RETAINED_EARNINGS', 'Retained earnings'], ['VAT_PAYABLE_TO_AUTHORITY', 'VAT payable to authority'], ['ROUNDING_ADJUSTMENT', 'Rounding']];

interface Sel { mode: 'Include' | 'Exclude'; selectorType: string; accountId?: string | null; rangeStart?: string | null; rangeEnd?: string | null; accountType?: string | null; systemKey?: string | null }
interface Row { rowNumber: number; rowType: string; label: string | null; labelAr: string | null; balanceDisplay: string; flipSign: boolean; calcFormula: { rowNumber: number; sign: number }[] | null; role: string | null; dimensionFilter: DimFilterValue | null; format: ReportFormat; selectors: Sel[] }
interface Col { columnNumber: number; label: string; labelAr: string | null; columnKind: string; periodBasis: string; customFrom: string | null; customTo: string | null; valueBasis: string; presentation: string; dimensionFilter: DimFilterValue | null; refColumnA: number | null; refColumnB: number | null; format: ReportFormat }

const blankRow = (rowNumber: number, rowType: string): Row => ({ rowNumber, rowType, label: rowType === 'Spacer' ? null : rowType === 'Heading' ? 'New heading' : rowType === 'Subtotal' ? 'Subtotal' : rowType === 'Calculated' ? 'Formula' : rowType === 'ProfitToDate' ? 'Profit (loss) to date' : rowType === 'Text' ? 'Note' : 'New group', labelAr: null, balanceDisplay: 'Net', flipSign: false, calcFormula: rowType === 'Calculated' ? [] : null, role: null, dimensionFilter: null, format: rowType === 'Heading' || rowType === 'Subtotal' ? { bold: true } : {}, selectors: [] });
const SegBtn = ({ options, value, onChange }: { options: [string, string][]; value: string; onChange: (v: string) => void }) => (
  <div className="inline-flex border border-slate-200 rounded-lg overflow-hidden">{options.map(([v, l]) => <button key={v} type="button" onClick={() => onChange(v)} className={`px-2.5 py-1 text-[11px] cursor-pointer ${value === v ? 'bg-indigo-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}>{l}</button>)}</div>
);

export default function ReportDesignerScreen({ db }: { db: DatabaseState }) {
  const { t, lang } = useTranslation(db);
  const { can } = usePermissions(db.currentUser);
  const { banner, show } = useBanner();
  const canEdit = can('reportDefinitions.update');
  const { options: dimOptions } = useDimensionOptions();
  const [defs, setDefs] = React.useState<any[]>([]);
  const [defId, setDefId] = React.useState('');
  const [meta, setMeta] = React.useState<any>(null);
  const [name, setName] = React.useState(''); const [nameAr, setNameAr] = React.useState(''); const [mode, setMode] = React.useState<'Summary' | 'Detailed'>('Summary');
  const [rows, setRows] = React.useState<Row[]>([]); const [cols, setCols] = React.useState<Col[]>([]);
  const [sel, setSel] = React.useState(0); const [tab, setTab] = React.useState<'rows' | 'columns'>('rows');
  const [dirty, setDirty] = React.useState(false);
  const [accounts, setAccounts] = React.useState<Acct[]>([]);
  const [preview, setPreview] = React.useState<any>(null); const [previewError, setPreviewError] = React.useState('');
  const [newOpen, setNewOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [from, setFrom] = React.useState(yearStartIso()); const [to, setTo] = React.useState(todayIso());

  const loadList = React.useCallback(async () => {
    try { const r = await ledgerApi<any>('/report-definitions'); setDefs(r.definitions); setDefId(cur => cur || r.definitions[0]?.id || ''); } catch (e: any) { show('error', e.message); }
  }, [show]);
  React.useEffect(() => { loadList(); ledgerApi<any>('/accounts').then(r => setAccounts(r.accounts)).catch(() => {}); }, [loadList]);

  React.useEffect(() => {
    if (!defId) return;
    ledgerApi<any>(`/report-definitions/${defId}`).then(d => {
      setMeta(d); setName(d.name); setNameAr(d.nameAr || ''); setMode(d.defaultDisplayMode); setRows(d.rows); setCols(d.columns); setSel(0); setDirty(false);
    }).catch(e => show('error', e.message));
  }, [defId, show]);

  // live preview of the unsaved design
  React.useEffect(() => {
    if (!meta || rows.length === 0 || cols.length === 0) return;
    const h = setTimeout(async () => {
      try { setPreview(await ledgerApi('/report-definitions/preview', { method: 'POST', body: { reportType: meta.reportType, name, rows, columns: cols, from, to, mode } })); setPreviewError(''); }
      catch (e: any) { setPreviewError(e.message); }
    }, 500);
    return () => clearTimeout(h);
  }, [meta, rows, cols, from, to, mode, name]);

  const touch = () => setDirty(true);
  const setRow = (i: number, patch: Partial<Row>) => { touch(); setRows(rs => rs.map((r, k) => k === i ? { ...r, ...patch } : r)); };
  const setFmt = (i: number, patch: Partial<ReportFormat>) => setRow(i, { format: { ...rows[i].format, ...patch } });
  const nextNumber = () => (rows.reduce((m, r) => Math.max(m, r.rowNumber), 0) || 0) + 10;
  const addRow = (type: string) => { touch(); const r = blankRow(nextNumber(), type); setRows(rs => { const n = [...rs]; n.splice(sel + 1, 0, r); return n; }); setSel(sel + 1); };
  const move = (d: number) => { const j = sel + d; if (j < 0 || j >= rows.length) return; touch(); setRows(rs => { const n = [...rs]; [n[sel], n[j]] = [n[j], n[sel]]; return n; }); setSel(j); };
  const remove = () => { touch(); setRows(rs => rs.filter((_, k) => k !== sel)); setSel(Math.max(0, sel - 1)); };
  const duplicate = () => { touch(); const r = rows[sel]; const c: Row = { ...JSON.parse(JSON.stringify(r)), rowNumber: nextNumber(), selectors: r.rowType === 'Accounts' ? [] : r.selectors, label: `${r.label || ''} (copy)` }; setRows(rs => { const n = [...rs]; n.splice(sel + 1, 0, c); return n; }); setSel(sel + 1); };
  const setCol = (i: number, patch: Partial<Col>) => { touch(); setCols(cs => cs.map((c, k) => k === i ? { ...c, ...patch } : c)); };
  const addCol = () => { touch(); setCols(cs => [...cs, { columnNumber: (cs.reduce((m, c) => Math.max(m, c.columnNumber), 0) || 0) + 1, label: 'New column', labelAr: null, columnKind: 'Value', periodBasis: 'CurrentPeriod', customFrom: null, customTo: null, valueBasis: 'Movement', presentation: 'Single', dimensionFilter: null, refColumnA: null, refColumnB: null, format: {} }]); };

  const save = async () => {
    setSaving(true);
    try { await ledgerApi(`/report-definitions/${defId}`, { method: 'PUT', body: { name, nameAr, defaultDisplayMode: mode, rows, columns: cols } }); show('success', t('Report saved.')); setDirty(false); await loadList(); }
    catch (e: any) { show('error', e.message); } finally { setSaving(false); }
  };
  const act = async (fn: () => Promise<any>, msg: string) => { try { await fn(); show('success', msg); await loadList(); const d = await ledgerApi<any>(`/report-definitions/${defId}`); setMeta(d); setRows(d.rows); setCols(d.columns); setName(d.name); setDirty(false); } catch (e: any) { show('error', e.message); } };

  const row = rows[sel];
  const accountsAll: Acct[] = accounts.filter((a: any) => a.isActive);
  const rowLabel = (r: Row) => (r.rowType === 'Spacer' ? `(${t('blank row')})` : r.label || '');

  return (
    <div className="space-y-4 pb-10">
      {banner && <Notice tone={banner.tone}>{banner.text}</Notice>}
      <Card className="p-4 flex flex-wrap items-end gap-3">
        <div className="min-w-[240px]"><label className={labelCls}>{t('Report')}</label>
          <select className={inputCls} value={defId} onChange={e => { if (dirty && !window.confirm(t('You have unsaved changes. Leave without saving?'))) return; setDefId(e.target.value); }}>
            {defs.map(d => <option key={d.id} value={d.id}>{d.name}{d.isDefault ? ` ★` : ''}{!d.isActive ? ` (${t('inactive')})` : ''} · {t(d.reportType === 'PnL' ? 'Income Statement' : d.reportType === 'TrialBalance' ? 'Trial Balance' : d.reportType === 'BalanceSheet' ? 'Balance Sheet' : 'Custom')}</option>)}
          </select></div>
        <div className="flex items-center gap-2 flex-wrap">
          {can('reportDefinitions.create') && <button className={ghostBtn} onClick={() => setNewOpen(true)}><Plus className="w-3.5 h-3.5" />{t('New / copy')}</button>}
          {canEdit && meta && !meta.isDefault && <button className={ghostBtn} onClick={() => act(() => ledgerApi(`/report-definitions/${defId}/set-default`, { method: 'PATCH' }), t('Now the default for its type.'))}><Star className="w-3.5 h-3.5" />{t('Make default')}</button>}
          {canEdit && meta?.isSystemSeeded && <button className={ghostBtn} onClick={() => { if (window.confirm(t('Rebuild this standard report from your chart? Your changes to it are lost.'))) act(() => ledgerApi(`/report-definitions/${defId}/reset`, { method: 'POST', body: {} }), t('Rebuilt from the chart.')); }}><RotateCcw className="w-3.5 h-3.5" />{t('Reset to standard')}</button>}
          {can('reportDefinitions.delete') && meta && <button className={ghostBtn} onClick={() => act(() => ledgerApi(`/report-definitions/${defId}/toggle-active`, { method: 'PATCH' }), t('Done.'))}><Power className="w-3.5 h-3.5" />{meta.isActive ? t('Deactivate') : t('Reactivate')}</button>}
        </div>
        {canEdit && <button className={`${primaryBtn} ms-auto`} disabled={!dirty || saving} onClick={save}><Save className="w-3.5 h-3.5" />{dirty ? t('Save changes') : t('Saved')}</button>}
      </Card>

      {meta && (
        <>
          <Card className="p-4 grid grid-cols-1 md:grid-cols-4 gap-3">
            <div><label className={labelCls}>{t('Name (English)')}</label><input className={inputCls} value={name} disabled={!canEdit} onChange={e => { setName(e.target.value); touch(); }} /></div>
            <div><label className={labelCls}>{t('Name (Arabic)')}</label><input dir="rtl" className={inputCls} value={nameAr} disabled={!canEdit} onChange={e => { setNameAr(e.target.value); touch(); }} /></div>
            <div><label className={labelCls}>{t('Shows by default')}</label><select className={inputCls} value={mode} disabled={!canEdit} onChange={e => { setMode(e.target.value as any); touch(); }}><option value="Summary">{t('Summary')}</option><option value="Detailed">{t('Detailed (accounts)')}</option></select></div>
            <div className="flex items-end gap-2"><div className="flex-1"><label className={labelCls}>{t('Preview from')}</label><input type="date" className={inputCls} value={from} onChange={e => setFrom(e.target.value)} /></div><div className="flex-1"><label className={labelCls}>{t('to')}</label><input type="date" className={inputCls} value={to} onChange={e => setTo(e.target.value)} /></div></div>
          </Card>

          <div className="flex gap-2">
            <button className={`px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer ${tab === 'rows' ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200'}`} onClick={() => setTab('rows')}><ListPlus className="w-3.5 h-3.5 inline me-1" />{t('Rows')} ({rows.length})</button>
            <button className={`px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer ${tab === 'columns' ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200'}`} onClick={() => setTab('columns')}><Columns3 className="w-3.5 h-3.5 inline me-1" />{t('Columns')} ({cols.length})</button>
          </div>

          {tab === 'rows' ? (
            <div className="grid grid-cols-1 xl:grid-cols-[260px_minmax(280px,360px)_1fr] gap-4 items-start">
              <Card className="p-3">
                <div className="flex gap-1.5 mb-2">
                  <select id="addRowType" className={`${inputCls} !py-1`} defaultValue="Accounts">{ROW_TYPES.map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}</select>
                  {canEdit && <button className={primaryBtn} onClick={() => addRow((document.getElementById('addRowType') as HTMLSelectElement).value)}><Plus className="w-3.5 h-3.5" /></button>}
                </div>
                <div className="space-y-0.5 max-h-[560px] overflow-y-auto">
                  {rows.map((r, i) => (
                    <button key={r.rowNumber} type="button" onClick={() => setSel(i)} className={`w-full flex items-center gap-2 text-start px-2 py-1.5 rounded-lg text-xs cursor-pointer ${i === sel ? 'bg-indigo-50 border border-indigo-300' : 'hover:bg-slate-50 border border-transparent'}`}>
                      <span className="font-mono text-[10px] text-slate-400 w-7">{r.rowNumber}</span>
                      <span className="text-[9px] uppercase font-bold text-slate-400 w-12 shrink-0">{r.rowType === 'Accounts' ? t('accts') : r.rowType === 'Calculated' ? t('formula') : r.rowType === 'ProfitToDate' ? t('profit') : t(r.rowType.toLowerCase())}</span>
                      <span className="truncate" style={{ fontWeight: r.format.bold ? 700 : 400, paddingInlineStart: (r.format.indent || 0) * 8 }}>{rowLabel(r)}</span>
                    </button>
                  ))}
                </div>
                {canEdit && <div className="flex gap-1.5 mt-2 flex-wrap"><button className={ghostBtn} onClick={() => move(-1)}><ArrowUp className="w-3.5 h-3.5" /></button><button className={ghostBtn} onClick={() => move(1)}><ArrowDown className="w-3.5 h-3.5" /></button><button className={ghostBtn} onClick={duplicate}><Copy className="w-3.5 h-3.5" /></button><button className={dangerBtn} onClick={remove}><Trash2 className="w-3.5 h-3.5" /></button></div>}
              </Card>

              <Card className="p-4 space-y-3 text-xs">
                {row ? <RowEditor row={row} rows={rows} sel={sel} accounts={accountsAll} dimOptions={dimOptions} canEdit={canEdit} db={db} setRow={(p) => setRow(sel, p)} setFmt={(p) => setFmt(sel, p)} /> : <p className="text-slate-400">{t('Select a row.')}</p>}
              </Card>

              <Card className="p-4 overflow-x-auto">
                <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500 mb-2">{t('Live preview')}</div>
                {previewError && <Notice tone="warn">{previewError}</Notice>}
                {preview && !previewError && <StatementTable db={db} result={preview} />}
                {preview && !previewError && preview.checks.uncovered > 0 && <p className="text-[11px] text-amber-700 mt-2">{preview.checks.uncovered} {t('accounts have figures but are in no row.')}</p>}
              </Card>
            </div>
          ) : (
            <ColumnsEditor db={db} cols={cols} canEdit={canEdit} dimOptions={dimOptions} setCol={setCol} addCol={addCol} remove={(i) => { touch(); setCols(cs => cs.filter((_, k) => k !== i)); }} move={(i, d) => { const j = i + d; if (j < 0 || j >= cols.length) return; touch(); setCols(cs => { const n = [...cs]; [n[i], n[j]] = [n[j], n[i]]; return n; }); }} />
          )}
        </>
      )}
      {newOpen && <NewReportModal db={db} defs={defs} current={defId} onClose={() => setNewOpen(false)} onCreated={async (id) => { setNewOpen(false); await loadList(); setDefId(id); }} />}
    </div>
  );
}

function RowEditor({ row, rows, sel, accounts, dimOptions, canEdit, db, setRow, setFmt }: { row: Row; rows: Row[]; sel: number; accounts: Acct[]; dimOptions: any; canEdit: boolean; db: DatabaseState; setRow: (p: Partial<Row>) => void; setFmt: (p: Partial<ReportFormat>) => void }) {
  const { t, lang } = useTranslation(db);
  const f = row.format;
  const earlier = rows.slice(0, sel).filter(r => ['Accounts', 'Subtotal', 'Calculated', 'ProfitToDate'].includes(r.rowType));
  const hasLabel = row.rowType !== 'Spacer';
  return (
    <>
      <div className="flex items-center justify-between"><h3 className="text-[11px] uppercase tracking-wider font-extrabold text-slate-500">{t('Row')} {row.rowNumber}</h3>
        <select className={`${inputCls} !w-auto !py-1`} disabled={!canEdit} value={row.rowType} onChange={e => setRow({ rowType: e.target.value, calcFormula: e.target.value === 'Calculated' ? (row.calcFormula || []) : null })}>{ROW_TYPES.map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}</select></div>
      {hasLabel && <><div><label className={labelCls}>{t('Label (English)')}</label><input className={inputCls} value={row.label || ''} disabled={!canEdit} onChange={e => setRow({ label: e.target.value })} /></div>
        <div><label className={labelCls}>{t('Label (Arabic)')}</label><input dir="rtl" className={inputCls} value={row.labelAr || ''} disabled={!canEdit} onChange={e => setRow({ labelAr: e.target.value })} /></div></>}

      {row.rowType === 'Accounts' && (
        <>
          <div><label className={labelCls}>{t('Value of the row')}</label>
            <select className={inputCls} disabled={!canEdit} value={row.balanceDisplay} onChange={e => setRow({ balanceDisplay: e.target.value })}>{DISPLAYS.map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}</select></div>
          <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" disabled={!canEdit} checked={row.flipSign} onChange={e => setRow({ flipSign: e.target.checked })} />{t('Show the opposite sign (credit-natured rows show positive)')}</label>
          <div><label className={labelCls}>{t('Accounts in this row')}</label>
            <div className="space-y-2">
              {row.selectors.map((s, i) => (
                <div key={i} className="border border-slate-200 rounded-lg p-2 space-y-1.5">
                  <div className="flex gap-1.5">
                    <select className={`${inputCls} !w-24 !py-1`} disabled={!canEdit} value={s.mode} onChange={e => setRow({ selectors: row.selectors.map((x, k) => k === i ? { ...x, mode: e.target.value as any } : x) })}><option value="Include">{t('Include')}</option><option value="Exclude">{t('Exclude')}</option></select>
                    <select className={`${inputCls} !py-1`} disabled={!canEdit} value={s.selectorType} onChange={e => setRow({ selectors: row.selectors.map((x, k) => k === i ? { mode: x.mode, selectorType: e.target.value } : x) })}>{SELECTORS.map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}</select>
                    {canEdit && <button className="text-slate-400 hover:text-rose-600 cursor-pointer" onClick={() => setRow({ selectors: row.selectors.filter((_, k) => k !== i) })}><Trash2 className="w-3.5 h-3.5" /></button>}
                  </div>
                  {(s.selectorType === 'Account' || s.selectorType === 'ParentRollup') && <AccountPicker accounts={s.selectorType === 'Account' ? accounts : accounts.filter(a => a.isGroup)} value={s.accountId || ''} lang={lang} placeholder={t('Type a code or name')} onChange={id => setRow({ selectors: row.selectors.map((x, k) => k === i ? { ...x, accountId: id } : x) })} />}
                  {s.selectorType === 'Range' && <div className="flex gap-1.5"><input className={`${inputCls} font-mono !py-1`} placeholder={t('From code')} value={s.rangeStart || ''} disabled={!canEdit} onChange={e => setRow({ selectors: row.selectors.map((x, k) => k === i ? { ...x, rangeStart: e.target.value } : x) })} /><input className={`${inputCls} font-mono !py-1`} placeholder={t('To code')} value={s.rangeEnd || ''} disabled={!canEdit} onChange={e => setRow({ selectors: row.selectors.map((x, k) => k === i ? { ...x, rangeEnd: e.target.value } : x) })} /></div>}
                  {s.selectorType === 'Type' && <select className={`${inputCls} !py-1`} disabled={!canEdit} value={s.accountType || ''} onChange={e => setRow({ selectors: row.selectors.map((x, k) => k === i ? { ...x, accountType: e.target.value } : x) })}><option value="">{t('Choose a type')}</option>{['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'].map(x => <option key={x} value={x}>{t(x)}</option>)}</select>}
                  {s.selectorType === 'Role' && <select className={`${inputCls} !py-1`} disabled={!canEdit} value={s.systemKey || ''} onChange={e => setRow({ selectors: row.selectors.map((x, k) => k === i ? { ...x, systemKey: e.target.value } : x) })}><option value="">{t('Choose a role')}</option>{ROLES.map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}</select>}
                </div>
              ))}
              {canEdit && <button className={ghostBtn} onClick={() => setRow({ selectors: [...row.selectors, { mode: row.selectors.length ? 'Exclude' : 'Include', selectorType: 'ParentRollup' }] })}><Plus className="w-3.5 h-3.5" />{t('Add accounts')}</button>}
            </div>
          </div>
          <div><label className={labelCls}>{t('Only postings tagged with')}</label><DimensionFilter db={db} options={dimOptions} value={row.dimensionFilter || {}} onChange={v => setRow({ dimensionFilter: Object.keys(v).length ? v : null })} /></div>
        </>
      )}

      {row.rowType === 'Calculated' && (
        <div><label className={labelCls}>{t('Formula: add or subtract earlier rows')}</label>
          <div className="space-y-1 max-h-48 overflow-y-auto border border-slate-200 rounded-lg p-1.5">
            {earlier.map(r => { const cur = (row.calcFormula || []).find(p => p.rowNumber === r.rowNumber); return (
              <div key={r.rowNumber} className="flex items-center gap-2"><SegBtn options={[['0', t('off')], ['1', '+'], ['-1', '−']]} value={cur ? String(cur.sign) : '0'} onChange={v => setRow({ calcFormula: [...(row.calcFormula || []).filter(p => p.rowNumber !== r.rowNumber), ...(v === '0' ? [] : [{ rowNumber: r.rowNumber, sign: Number(v) }])] })} /><span className="truncate"><span className="font-mono text-[10px] text-slate-400 me-1">{r.rowNumber}</span>{r.label}</span></div>
            ); })}
            {earlier.length === 0 && <p className="text-slate-400 p-1">{t('There are no earlier rows to use yet.')}</p>}
          </div>
        </div>
      )}
      {row.rowType === 'Subtotal' && <p className="text-slate-500">{t('Adds every Accounts row above it since the previous subtotal.')}</p>}

      {hasLabel && <div><label className={labelCls}>{t('Tag (for checks and formulas)')}</label>
        <select className={inputCls} disabled={!canEdit} value={row.role || ''} onChange={e => setRow({ role: e.target.value || null })}><option value="">{t('None')}</option><option value="total_assets">{t('Total assets')}</option><option value="total_liabilities">{t('Total liabilities')}</option><option value="total_equity">{t('Total equity')}</option><option value="net_profit">{t('Net profit')}</option><option value="gross_profit">{t('Gross profit')}</option><option value="total_revenue">{t('Total revenue')}</option></select>
        <p className="text-[10px] text-slate-400 mt-0.5">{t('A Balance Sheet checks itself using the rows tagged total assets, total liabilities and total equity.')}</p></div>}

      {hasLabel && (
        <div className="space-y-2 border-t border-slate-100 pt-3">
          <h4 className="text-[11px] uppercase tracking-wider font-extrabold text-slate-500">{t('Appearance')}</h4>
          <div className="flex flex-wrap gap-3">
            {([['bold', 'Bold'], ['italic', 'Italic'], ['shade', 'Shaded band'], ['pageBreakAfter', 'Page break after']] as [keyof ReportFormat, string][]).map(([k, l]) => <label key={k} className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" disabled={!canEdit} checked={!!f[k]} onChange={e => setFmt({ [k]: e.target.checked } as any)} />{t(l)}</label>)}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div><label className={labelCls}>{t('Underline')}</label><SegBtn options={[['none', t('None')], ['single', t('Single')], ['double', t('Double')]]} value={f.underline || 'none'} onChange={v => canEdit && setFmt({ underline: v as any })} /></div>
            <div><label className={labelCls}>{t('Indent')}</label><SegBtn options={['0', '1', '2', '3', '4'].map(x => [x, x] as [string, string])} value={String(f.indent || 0)} onChange={v => canEdit && setFmt({ indent: Number(v) })} /></div>
            <div><label className={labelCls}>{t('Border above')}</label><SegBtn options={[['none', t('None')], ['single', t('Single')], ['double', t('Double')]]} value={f.borderTop || 'none'} onChange={v => canEdit && setFmt({ borderTop: v as any })} /></div>
            <div><label className={labelCls}>{t('Border below')}</label><SegBtn options={[['none', t('None')], ['single', t('Single')], ['double', t('Double')]]} value={f.borderBottom || 'none'} onChange={v => canEdit && setFmt({ borderBottom: v as any })} /></div>
            <div><label className={labelCls}>{t('Label alignment')}</label><SegBtn options={[['start', t('Left')], ['center', t('Centre')], ['end', t('Right')]]} value={f.align || 'start'} onChange={v => canEdit && setFmt({ align: v as any })} /></div>
            <div><label className={labelCls}>{t('Figure alignment')}</label><SegBtn options={[['start', t('Left')], ['center', t('Centre')], ['end', t('Right')]]} value={f.amountAlign || 'end'} onChange={v => canEdit && setFmt({ amountAlign: v as any })} /></div>
            <div><label className={labelCls}>{t('Negatives')}</label><SegBtn options={[['parentheses', '(1,234)'], ['minus', '-1,234']]} value={f.negatives || 'parentheses'} onChange={v => canEdit && setFmt({ negatives: v as any })} /></div>
            <div><label className={labelCls}>{t('Decimals')}</label><SegBtn options={[['2', '0.00'], ['0', '0']]} value={String(f.decimals ?? 2)} onChange={v => canEdit && setFmt({ decimals: Number(v) as any })} /></div>
          </div>
          <div><label className={labelCls}>{t('Show')}</label>
            <select className={inputCls} disabled={!canEdit} value={f.show || 'always'} onChange={e => setFmt({ show: e.target.value as any })}><option value="always">{t('Always')}</option><option value="nonzero">{t('Only when not zero')}</option><option value="hidden">{t('Hidden (used only by formulas)')}</option></select></div>
        </div>
      )}
    </>
  );
}

function ColumnsEditor({ db, cols, canEdit, dimOptions, setCol, addCol, remove, move }: { db: DatabaseState; cols: Col[]; canEdit: boolean; dimOptions: any; setCol: (i: number, p: Partial<Col>) => void; addCol: () => void; remove: (i: number) => void; move: (i: number, d: number) => void }) {
  const { t } = useTranslation(db);
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-600">{t('A column picks a period and what to measure. Add a column per branch or cost centre by giving it a dimension filter; add a variance or percent column to compare two columns.')}</p>
      {cols.map((c, i) => (
        <Card key={c.columnNumber} className="p-4 space-y-3 text-xs">
          <div className="flex items-center justify-between"><span className="font-extrabold text-[11px] uppercase tracking-wider text-slate-500">{t('Column')} {c.columnNumber}</span>
            {canEdit && <div className="flex gap-1.5"><button className={ghostBtn} onClick={() => move(i, -1)}><ArrowUp className="w-3.5 h-3.5" /></button><button className={ghostBtn} onClick={() => move(i, 1)}><ArrowDown className="w-3.5 h-3.5" /></button><button className={dangerBtn} onClick={() => remove(i)}><Trash2 className="w-3.5 h-3.5" /></button></div>}</div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div><label className={labelCls}>{t('Heading (English)')}</label><input className={inputCls} value={c.label} disabled={!canEdit} onChange={e => setCol(i, { label: e.target.value })} /></div>
            <div><label className={labelCls}>{t('Heading (Arabic)')}</label><input dir="rtl" className={inputCls} value={c.labelAr || ''} disabled={!canEdit} onChange={e => setCol(i, { labelAr: e.target.value })} /></div>
            <div><label className={labelCls}>{t('Kind')}</label><select className={inputCls} disabled={!canEdit} value={c.columnKind} onChange={e => setCol(i, { columnKind: e.target.value, presentation: 'Single' })}><option value="Value">{t('Figures')}</option><option value="Variance">{t('Variance (A minus B)')}</option><option value="Percent">{t('Percent change (A against B)')}</option></select></div>
            {c.columnKind === 'Value' && <div><label className={labelCls}>{t('Shown as')}</label><select className={inputCls} disabled={!canEdit} value={c.presentation} onChange={e => setCol(i, { presentation: e.target.value })}><option value="Single">{t('One figure')}</option><option value="DrCr">{t('Debit and credit columns')}</option></select></div>}
          </div>
          {c.columnKind === 'Value' ? (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div><label className={labelCls}>{t('Period')}</label><select className={inputCls} disabled={!canEdit} value={c.periodBasis} onChange={e => setCol(i, { periodBasis: e.target.value })}>{PERIODS.map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}</select></div>
              {c.periodBasis === 'CustomRange' && <><div><label className={labelCls}>{t('From')}</label><input type="date" className={inputCls} value={c.customFrom || ''} disabled={!canEdit} onChange={e => setCol(i, { customFrom: e.target.value })} /></div><div><label className={labelCls}>{t('To')}</label><input type="date" className={inputCls} value={c.customTo || ''} disabled={!canEdit} onChange={e => setCol(i, { customTo: e.target.value })} /></div></>}
              <div><label className={labelCls}>{t('Measure')}</label><select className={inputCls} disabled={!canEdit} value={c.valueBasis} onChange={e => setCol(i, { valueBasis: e.target.value })}>{BASES.map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}</select></div>
              <div><label className={labelCls}>{t('Only postings tagged with')}</label><DimensionFilter db={db} options={dimOptions} value={c.dimensionFilter || {}} onChange={v => setCol(i, { dimensionFilter: Object.keys(v).length ? v : null })} /></div>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div><label className={labelCls}>{t('A')}</label><select className={inputCls} disabled={!canEdit} value={c.refColumnA ?? ''} onChange={e => setCol(i, { refColumnA: Number(e.target.value) })}><option value="">—</option>{cols.slice(0, i).filter(x => x.columnKind === 'Value').map(x => <option key={x.columnNumber} value={x.columnNumber}>{x.columnNumber} · {x.label}</option>)}</select></div>
              <div><label className={labelCls}>{t('B')}</label><select className={inputCls} disabled={!canEdit} value={c.refColumnB ?? ''} onChange={e => setCol(i, { refColumnB: Number(e.target.value) })}><option value="">—</option>{cols.slice(0, i).filter(x => x.columnKind === 'Value').map(x => <option key={x.columnNumber} value={x.columnNumber}>{x.columnNumber} · {x.label}</option>)}</select></div>
            </div>
          )}
        </Card>
      ))}
      {canEdit && <button className={ghostBtn} onClick={addCol}><Plus className="w-3.5 h-3.5" />{t('Add column')}</button>}
    </div>
  );
}

function NewReportModal({ db, defs, current, onClose, onCreated }: { db: DatabaseState; defs: any[]; current: string; onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation(db);
  const [name, setName] = React.useState(''); const [clone, setClone] = React.useState(current); const [type, setType] = React.useState('Custom'); const [err, setErr] = React.useState('');
  const go = async () => {
    try { const r = await ledgerApi<any>('/report-definitions', { method: 'POST', body: { name, cloneFromId: clone || undefined, reportType: clone ? undefined : type } }); onCreated(r.id); } catch (e: any) { setErr(e.message); }
  };
  return (
    <Modal title={t('New report')} onClose={onClose} footer={<><button className={ghostBtn} onClick={onClose}>{t('Cancel')}</button><button className={primaryBtn} disabled={!name.trim()} onClick={go}>{t('Create')}</button></>}>
      {err && <Notice tone="error">{err}</Notice>}
      <div><label className={labelCls}>{t('Name')}</label><input className={inputCls} value={name} onChange={e => setName(e.target.value)} placeholder={t('Management P&L')} /></div>
      <div><label className={labelCls}>{t('Start from')}</label>
        <select className={inputCls} value={clone} onChange={e => setClone(e.target.value)}><option value="">{t('A blank report')}</option>{defs.map(d => <option key={d.id} value={d.id}>{t('A copy of')} {d.name}</option>)}</select></div>
      {!clone && <div><label className={labelCls}>{t('Type')}</label><select className={inputCls} value={type} onChange={e => setType(e.target.value)}><option value="Custom">{t('Custom')}</option><option value="PnL">{t('Income Statement')}</option><option value="BalanceSheet">{t('Balance Sheet')}</option><option value="TrialBalance">{t('Trial Balance')}</option></select></div>}
    </Modal>
  );
}
