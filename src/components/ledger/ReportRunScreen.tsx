import React from 'react';
import { Download, Printer, Play, CheckCircle2, AlertTriangle, Pencil } from 'lucide-react';
import { useTranslation, usePermissions } from '../../hooks';
import type { DatabaseState } from '../../dbStore';
import { formatAmount, type ReportFormat } from '../../reportFormat';
import { ledgerApi, downloadLedgerFile, todayIso, yearStartIso, inputCls, labelCls, primaryBtn, ghostBtn, Card, Notice } from './ui';
import { DimensionFilter, useDimensionOptions, type DimFilterValue } from './dimensions';

export type ReportKind = 'TrialBalance' | 'PnL' | 'BalanceSheet' | 'Custom';
export interface DrillFocus { accountIds: string[]; from: string; to: string; dims?: DimFilterValue }

const BORDER = (b?: string) => (b === 'double' ? '3px double #111' : b === 'single' ? '1px solid #111' : undefined);
const ALIGN = (a?: string, dflt: string = 'start') => ((a || dflt) === 'center' ? 'center' : (a || dflt) === 'end' ? 'right' : 'left') as any;

export function rowStyle(f: ReportFormat): React.CSSProperties {
  return { fontWeight: f.bold ? 700 : 400, fontStyle: f.italic ? 'italic' : 'normal', background: f.shade ? '#f1f2f8' : undefined, borderTop: BORDER(f.borderTop), borderBottom: BORDER(f.borderBottom) };
}
export function labelStyle(f: ReportFormat): React.CSSProperties {
  return { paddingInlineStart: 8 + (f.indent || 0) * 18, textAlign: ALIGN(f.align, 'start'), textDecoration: f.underline && f.underline !== 'none' ? 'underline' : undefined, textDecorationStyle: f.underline === 'double' ? 'double' : undefined };
}
export function amountStyle(f: ReportFormat): React.CSSProperties {
  return { textAlign: ALIGN(f.amountAlign, 'end'), textDecoration: f.underline && f.underline !== 'none' ? 'underline' : undefined, textDecorationStyle: f.underline === 'double' ? 'double' : undefined };
}

// A statement as the report engine returns it: rows x columns with the formatting of the definition; every figure opens the General Ledger behind it.
export function StatementTable({ db, result, onDrill, dims, tableRef }: { db: DatabaseState; result: any; onDrill?: (f: DrillFocus) => void; dims?: DimFilterValue; tableRef?: React.Ref<HTMLTableElement> }) {
  const { t, lang } = useTranslation(db);
  const cols: any[] = result.columns;
  const text = (x: { label: string | null; labelAr: string | null } | any, key: 'label' = 'label') => (lang === 'ar' && x.labelAr ? x.labelAr : x[key]);
  const fig = (c: any, cell: any, side: 'v' | 'dr' | 'cr', f: ReportFormat) => {
    if (!cell) return '';
    const v = side === 'v' ? cell.v : side === 'dr' ? cell.dr : cell.cr;
    if (v === null || v === undefined) return '';
    if (c.kind === 'Percent') return `${Number(v).toFixed(1)}%`;
    if ((side === 'dr' || side === 'cr') && Math.abs(v) < 0.005) return '';
    return formatAmount(v, f);
  };
  const click = (cell: any, c: any) => { if (onDrill && cell?.drill && cell.drill.accountIds.length > 0) onDrill({ accountIds: cell.drill.accountIds, from: cell.drill.from, to: cell.drill.to, dims }); void c; };
  const Cells = ({ cells, f }: { cells: any[]; f: ReportFormat }) => (
    <>
      {cols.map((c, i) => {
        const cell = cells[i];
        const clickable = onDrill && cell?.drill && cell.drill.accountIds.length > 0 && c.kind === 'Value';
        const style = { ...amountStyle({ ...f, ...(c.format || {}) }), fontVariantNumeric: 'tabular-nums' as const, fontFamily: 'ui-monospace, Consolas, monospace', cursor: clickable ? 'pointer' : undefined };
        if (c.presentation === 'DrCr') return [<td key={`${i}d`} style={style} className="p-2" onClick={() => click(cell, c)}>{fig(c, cell, 'dr', f)}</td>, <td key={`${i}c`} style={style} className="p-2" onClick={() => click(cell, c)}>{fig(c, cell, 'cr', f)}</td>];
        return <td key={i} style={style} className={`p-2 ${clickable ? 'hover:bg-indigo-50' : ''}`} onClick={() => click(cell, c)}>{fig(c, cell, 'v', f)}</td>;
      })}
    </>
  );
  return (
    <table ref={tableRef} className="w-full text-xs bg-white text-slate-900" style={{ borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ borderBottom: '2px solid #111' }}>
          <th rowSpan={cols.some(c => c.presentation === 'DrCr') ? 2 : 1} className="p-2 text-start" />
          {cols.map((c, i) => <th key={i} colSpan={c.presentation === 'DrCr' ? 2 : 1} className="p-2 text-center text-[10px] uppercase tracking-wider font-extrabold">{text(c)}<div className="font-normal normal-case text-[10px] text-slate-500">{c.window && c.kind === 'Value' ? (c.valueBasis === 'ClosingBalance' ? c.window.to : `${c.window.from} → ${c.window.to}`) : ''}</div></th>)}
        </tr>
        {cols.some(c => c.presentation === 'DrCr') && <tr style={{ borderBottom: '1px solid #111' }}>{cols.map((c, i) => c.presentation === 'DrCr' ? [<th key={`${i}d`} className="p-1.5 text-end text-[10px] uppercase">{t('Debit')}</th>, <th key={`${i}c`} className="p-1.5 text-end text-[10px] uppercase">{t('Credit')}</th>] : <th key={i} />)}</tr>}
      </thead>
      <tbody>
        {result.rows.map((r: any) => {
          if (r.rowType === 'Spacer') return <tr key={r.rowNumber}><td colSpan={1 + cols.reduce((s: number, c: any) => s + (c.presentation === 'DrCr' ? 2 : 1), 0)} className="p-1.5">&nbsp;</td></tr>;
          if (r.rowType === 'Heading' || r.rowType === 'Text') return <tr key={r.rowNumber} style={rowStyle(r.format)}><td colSpan={1 + cols.reduce((s: number, c: any) => s + (c.presentation === 'DrCr' ? 2 : 1), 0)} className="p-2" style={labelStyle(r.format)}>{text(r)}</td></tr>;
          return (
            <React.Fragment key={r.rowNumber}>
              <tr style={rowStyle(r.format)}><td className="p-2" style={labelStyle(r.format)}>{text(r)}</td><Cells cells={r.cells} f={r.format} /></tr>
              {(r.detail || []).map((d: any) => (
                <tr key={d.accountId} style={{ ...rowStyle({ ...r.format, bold: d.isGroup, shade: false, borderTop: undefined, borderBottom: undefined }), color: '#475569' }}>
                  <td className="p-1.5" style={{ paddingInlineStart: 8 + ((r.format.indent || 0) + 1 + d.depth) * 16 }}><span className="font-mono text-[10px] text-slate-400 me-1.5">{d.code}</span>{lang === 'ar' && d.nameAr ? d.nameAr : d.name}</td>
                  <Cells cells={d.cells} f={{ ...r.format, bold: d.isGroup, shade: false, borderTop: undefined, borderBottom: undefined }} />
                </tr>
              ))}
            </React.Fragment>
          );
        })}
        {result.notInDefinition.length > 0 && (
          <>
            <tr><td colSpan={1 + cols.reduce((s: number, c: any) => s + (c.presentation === 'DrCr' ? 2 : 1), 0)} className="p-2" style={{ background: '#fdf1d8', color: '#6b4300', fontWeight: 700 }}>{t('Not in this report (not included in the totals above)')}</td></tr>
            {result.notInDefinition.map((n: any) => (
              <tr key={n.accountId} style={{ background: '#fffaf0', color: '#6b4300' }}><td className="p-1.5" style={{ paddingInlineStart: 24 }}><span className="font-mono text-[10px] me-1.5">{n.code}</span>{lang === 'ar' && n.nameAr ? n.nameAr : n.name}</td><Cells cells={n.cells} f={{}} /></tr>
            ))}
          </>
        )}
      </tbody>
    </table>
  );
}

// Run a report definition: pick which definition, the period (or the date for a balance sheet), a dimension filter, Summary or Detailed; export and print.
export default function ReportRunScreen({ db, reportType, onDrill, onDesign }: { db: DatabaseState; reportType: ReportKind; onDrill: (f: DrillFocus) => void; onDesign?: () => void }) {
  const { t, lang } = useTranslation(db);
  const { can } = usePermissions(db.currentUser);
  const [defs, setDefs] = React.useState<any[]>([]);
  const [defId, setDefId] = React.useState('');
  const [from, setFrom] = React.useState(yearStartIso());
  const [to, setTo] = React.useState(todayIso());
  const [mode, setMode] = React.useState<'Summary' | 'Detailed' | ''>('');
  const [dims, setDims] = React.useState<DimFilterValue>({});
  const [result, setResult] = React.useState<any>(null);
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const { options: dimOptions } = useDimensionOptions();
  const tableRef = React.useRef<HTMLTableElement>(null);
  const asAt = reportType === 'BalanceSheet';
  const currency = db.companySetup?.currency || 'SAR';

  React.useEffect(() => {
    ledgerApi<any>(`/report-definitions?type=${reportType}`).then(r => {
      const list = r.definitions.filter((d: any) => d.isActive); setDefs(list);
      setDefId(cur => cur || (list.find((d: any) => d.isDefault) || list[0])?.id || '');
    }).catch(e => setError(e.message));
  }, [reportType]);
  const def = defs.find(d => d.id === defId);
  const query = React.useCallback(() => {
    const p = new URLSearchParams({ from, to, mode: mode || def?.defaultDisplayMode || 'Summary' });
    if (Object.keys(dims).length) p.set('dims', JSON.stringify(dims));
    return p.toString();
  }, [from, to, mode, def, dims]);
  const run = React.useCallback(async () => {
    if (!defId) return;
    setLoading(true); setError('');
    try { setResult(await ledgerApi(`/report-definitions/${defId}/run?${query()}`)); } catch (e: any) { setError(e.message); setResult(null); } finally { setLoading(false); }
  }, [defId, query]);
  React.useEffect(() => { const h = setTimeout(run, 150); return () => clearTimeout(h); }, [run]);

  const print = () => {
    if (!tableRef.current || !result) return;
    const w = window.open('', '_blank'); if (!w) return;
    const title = `${lang === 'ar' && result.definition.nameAr ? result.definition.nameAr : result.definition.name}`;
    w.document.write(`<html dir="${lang === 'ar' || lang === 'ur' ? 'rtl' : 'ltr'}"><head><title>${title}</title><style>body{font-family:Inter,Arial,sans-serif;font-size:11px;margin:24px;color:#111}h2{margin:0 0 2px}p{margin:0 0 12px;color:#555}table{width:100%;border-collapse:collapse}td,th{padding:3px 6px}@page{margin:12mm}</style></head><body><h2>${db.companySetup?.name || ''}</h2><h3 style="margin:0">${title}</h3><p>${asAt ? `${t('As at')} ${result.params.to}` : `${result.params.from} → ${result.params.to}`} · ${currency}</p>${tableRef.current.outerHTML}</body></html>`);
    w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
  };

  return (
    <div className="space-y-4 pb-10">
      {error && <Notice tone="error">{error}</Notice>}
      <Card className="p-4 flex flex-wrap items-end gap-3">
        <div className="min-w-[220px]"><label className={labelCls}>{t('Report layout')}</label>
          <select className={inputCls} value={defId} onChange={e => { setDefId(e.target.value); setMode(''); }}>{defs.map(d => <option key={d.id} value={d.id}>{lang === 'ar' && d.nameAr ? d.nameAr : d.name}{d.isDefault ? ` (${t('default')})` : ''}</option>)}</select></div>
        {!asAt && <div><label className={labelCls}>{t('From')}</label><input type="date" className={inputCls} value={from} onChange={e => setFrom(e.target.value)} /></div>}
        <div><label className={labelCls}>{asAt ? t('As at') : t('To')}</label><input type="date" className={inputCls} value={to} onChange={e => setTo(e.target.value)} /></div>
        <div><label className={labelCls}>{t('Detail')}</label>
          <select className={inputCls} value={mode || def?.defaultDisplayMode || 'Summary'} onChange={e => setMode(e.target.value as any)}><option value="Summary">{t('Summary')}</option><option value="Detailed">{t('Detailed (accounts)')}</option></select></div>
        <DimensionFilter db={db} options={dimOptions} value={dims} onChange={setDims} />
        <button className={primaryBtn} onClick={run} disabled={loading || !defId}><Play className="w-3.5 h-3.5" />{t('Run')}</button>
        <div className="flex items-center gap-2 ms-auto">
          {onDesign && can('reportDefinitions.read') && <button className={ghostBtn} onClick={onDesign}><Pencil className="w-3.5 h-3.5" />{t('Design')}</button>}
          <button className={ghostBtn} disabled={!result} onClick={print}><Printer className="w-3.5 h-3.5" />{t('Print')}</button>
          <button className={ghostBtn} disabled={!defId} onClick={() => downloadLedgerFile(`/report-definitions/${defId}/export?${query()}`, 'report.xlsx').catch(e => setError(e.message))}><Download className="w-3.5 h-3.5" />{t('Excel')}</button>
        </div>
      </Card>
      {result && (
        <>
          {result.branchRestricted && <Notice tone="info">{t('You are limited to your own branches, so these figures cover those branches only and may not balance.')}</Notice>}
          {Object.keys(dims).length > 0 && reportType === 'BalanceSheet' && <Notice tone="info">{t('A balance sheet filtered by a dimension is partial: only postings carrying that tag are included.')}</Notice>}
          {result.unmappedLines > 0 && <Notice tone="warn">{t('Some ledger lines are not on any account of your chart:')} {result.unmappedLines}. {t('Check Account Mapping.')}</Notice>}
          {result.checks.balanced !== undefined && (
            <div className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold ${result.checks.balanced ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'}`}>
              {result.checks.balanced ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
              {reportType === 'TrialBalance'
                ? (result.checks.balanced ? t('The trial balance balances: total debits equal total credits.') : t('The trial balance does not balance. Do not rely on these figures until this is explained.'))
                : (result.checks.balanced ? t('The balance sheet balances: assets equal liabilities plus equity.') : `${t('The balance sheet is out of balance by')} ${formatAmount(Math.abs(result.checks.difference || 0))}.`)}
            </div>
          )}
          {result.checks.uncovered > 0 && <Notice tone="warn">{result.checks.uncovered} {t('accounts have figures but are in no row of this layout. They are listed at the bottom and are not in the totals.')}</Notice>}
          <Card className="p-5 overflow-x-auto">
            <div className="text-center mb-3">
              <div className="text-sm font-black text-slate-900">{db.companySetup?.name}</div>
              <div className="text-xs font-bold text-slate-700">{lang === 'ar' && result.definition.nameAr ? result.definition.nameAr : result.definition.name}</div>
              <div className="text-[11px] text-slate-500">{asAt ? `${t('As at')} ${result.params.to}` : `${result.params.from} → ${result.params.to}`} · {currency}</div>
            </div>
            <StatementTable db={db} result={result} dims={dims} onDrill={onDrill} tableRef={tableRef} />
            <p className="text-[11px] text-slate-500 mt-3">{t('Click a figure to see the ledger entries behind it.')}</p>
          </Card>
        </>
      )}
    </div>
  );
}
