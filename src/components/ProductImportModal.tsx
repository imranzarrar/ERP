import React from 'react';
import { createPortal } from 'react-dom';
import { X, Upload, Download, FileSpreadsheet, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useTranslation } from '../hooks';
import type { DatabaseState } from '../dbStore';

// Product/Service Master bulk import — Validate, then Commit, per server/lib/productImport.ts.
// Nothing is written to the database until the user reviews the per-row result table and
// clicks "Import". A bad row never blocks the good ones in the same file.
interface RowResult { rowNumber: number; name: string; action: 'create' | 'update' | 'error'; errors: string[]; }
interface ValidateResponse { summary: { totalRows: number; toCreate: number; toUpdate: number; errors: number }; rows: RowResult[]; }
interface CommitRow { rowNumber: number; name: string; action: 'created' | 'updated' | 'skipped'; reason?: string; }
interface CommitResponse { summary: { created: number; updated: number; skipped: number }; rows: CommitRow[]; }

export default function ProductImportModal({ db, onClose, onImported }: { db: DatabaseState; onClose: () => void; onImported: () => Promise<void> | void }) {
  const { t } = useTranslation(db);
  const [file, setFile] = React.useState<File | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<ValidateResponse | null>(null);
  const [excluded, setExcluded] = React.useState<Set<number>>(new Set());
  const [commitResult, setCommitResult] = React.useState<CommitResponse | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const handleDownloadTemplate = async () => {
    const res = await fetch('/api/master-import/products/template');
    if (!res.ok) { setError(t('Could not download the template.')); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'product-import-template.xlsx';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  const handleFileChosen = async (f: File) => {
    setFile(f); setError(null); setResult(null); setCommitResult(null); setExcluded(new Set());
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const res = await fetch('/api/master-import/products/validate', { method: 'POST', body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || t('Failed to read this file.'));
      setResult(body as ValidateResponse);
      // Pre-exclude error rows by default — nothing failing is imported unless the user
      // explicitly re-includes it after fixing the underlying data.
      setExcluded(new Set((body as ValidateResponse).rows.filter(r => r.action === 'error').map(r => r.rowNumber)));
    } catch (e: any) {
      setError(e.message || t('Failed to read this file.'));
    } finally {
      setLoading(false);
    }
  };

  const toggleRow = (rowNumber: number) => {
    setExcluded(prev => {
      const next = new Set(prev);
      if (next.has(rowNumber)) next.delete(rowNumber); else next.add(rowNumber);
      return next;
    });
  };

  const includedCount = result ? result.rows.filter(r => r.action !== 'error' && !excluded.has(r.rowNumber)).length : 0;

  const handleCommit = async () => {
    if (!file) return;
    setLoading(true); setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('excludeRows', JSON.stringify(Array.from(excluded)));
      const res = await fetch('/api/master-import/products/commit', { method: 'POST', body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || t('Import failed.'));
      setCommitResult(body as CommitResponse);
      await onImported();
    } catch (e: any) {
      setError(e.message || t('Import failed.'));
    } finally {
      setLoading(false);
    }
  };

  // Rendered via a portal straight into document.body — this screen's content sits inside
  // an animated wrapper (App.tsx's motion.div, which transitions a `filter` on tab change).
  // A non-`none` `filter` on ANY ancestor creates a new containing block for `position:
  // fixed` descendants (same CSS rule as `transform`), so without the portal this overlay
  // would center itself against that wrapper's box instead of the real viewport — exactly
  // the "appears at the bottom of the screen instead of centered" bug this fixes. Same
  // pattern already used by PartySearchSelect.tsx/ItemCatalogSearch.tsx for the same reason.
  return createPortal(
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
            <FileSpreadsheet className="w-4 h-4 text-indigo-600" /> {t('Import Products from Spreadsheet')}
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
          {!commitResult && (
            <>
              <div className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-xl p-3">
                <p className="text-slate-600">{t('Start from the template so your column headers match exactly.')}</p>
                <button onClick={handleDownloadTemplate} className="shrink-0 flex items-center gap-1.5 bg-white border border-slate-200 hover:border-indigo-300 text-slate-700 rounded-lg px-3 py-1.5 font-bold">
                  <Download className="w-3.5 h-3.5" /> {t('Download Template')}
                </button>
              </div>

              <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-slate-200 hover:border-indigo-300 rounded-xl py-8 cursor-pointer transition-colors">
                <Upload className="w-6 h-6 text-slate-400" />
                <span className="font-bold text-slate-700">{file ? file.name : t('Choose a .xlsx or .csv file')}</span>
                <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileChosen(f); }} />
              </label>

              {error && <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl p-3">{error}</div>}

              {loading && <p className="text-center text-slate-400">{t('Working...')}</p>}

              {result && !loading && (
                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-2">
                    <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-center">
                      <div className="text-lg font-black text-emerald-700">{result.summary.toCreate}</div>
                      <div className="text-emerald-600 font-bold">{t('Will be created')}</div>
                    </div>
                    <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-3 text-center">
                      <div className="text-lg font-black text-indigo-700">{result.summary.toUpdate}</div>
                      <div className="text-indigo-600 font-bold">{t('Will be updated')}</div>
                    </div>
                    <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 text-center">
                      <div className="text-lg font-black text-rose-700">{result.summary.errors}</div>
                      <div className="text-rose-600 font-bold">{t('Have errors')}</div>
                    </div>
                  </div>

                  <div className="border border-slate-200 rounded-xl overflow-hidden max-h-72 overflow-y-auto">
                    <table className="w-full text-start">
                      <thead className="sticky top-0 bg-slate-50">
                        <tr className="text-[10px] uppercase font-bold text-slate-500">
                          <th className="p-2 text-start w-8"></th>
                          <th className="p-2 text-start">{t('Row')}</th>
                          <th className="p-2 text-start">{t('Name')}</th>
                          <th className="p-2 text-start">{t('Status')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {result.rows.map(r => (
                          <tr key={r.rowNumber} className={r.action === 'error' ? 'bg-rose-50/40' : excluded.has(r.rowNumber) ? 'opacity-40' : ''}>
                            <td className="p-2">
                              <input type="checkbox" checked={!excluded.has(r.rowNumber)} onChange={() => toggleRow(r.rowNumber)}
                                disabled={r.action === 'error'} />
                            </td>
                            <td className="p-2 font-mono text-slate-500">{r.rowNumber}</td>
                            <td className="p-2 font-semibold text-slate-700">{r.name || <span className="text-slate-400">{t('(no name)')}</span>}</td>
                            <td className="p-2">
                              {r.action === 'error' ? (
                                <span className="text-rose-600">{r.errors.join(' ')}</span>
                              ) : r.action === 'update' ? (
                                <span className="text-indigo-600 font-bold">{t('Update existing (barcode match)')}</span>
                              ) : (
                                <span className="text-emerald-600 font-bold">{t('New product')}</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}

          {commitResult && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-emerald-700 font-bold">
                <CheckCircle2 className="w-5 h-5" /> {t('Import complete.')}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-center">
                  <div className="text-lg font-black text-emerald-700">{commitResult.summary.created}</div>
                  <div className="text-emerald-600 font-bold">{t('Created')}</div>
                </div>
                <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-3 text-center">
                  <div className="text-lg font-black text-indigo-700">{commitResult.summary.updated}</div>
                  <div className="text-indigo-600 font-bold">{t('Updated')}</div>
                </div>
                <div className="bg-slate-100 border border-slate-200 rounded-xl p-3 text-center">
                  <div className="text-lg font-black text-slate-700">{commitResult.summary.skipped}</div>
                  <div className="text-slate-600 font-bold">{t('Skipped')}</div>
                </div>
              </div>
              {commitResult.rows.some(r => r.action === 'skipped') && (
                <div className="border border-slate-200 rounded-xl overflow-hidden max-h-56 overflow-y-auto">
                  <table className="w-full text-start">
                    <tbody className="divide-y divide-slate-100">
                      {commitResult.rows.filter(r => r.action === 'skipped').map(r => (
                        <tr key={r.rowNumber}>
                          <td className="p-2 font-mono text-slate-500">{r.rowNumber}</td>
                          <td className="p-2 font-semibold text-slate-700">{r.name}</td>
                          <td className="p-2 text-amber-600 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {r.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-100">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-slate-600 font-bold hover:bg-slate-100">
            {commitResult ? t('Close') : t('Cancel')}
          </button>
          {result && !commitResult && (
            <button onClick={handleCommit} disabled={loading || includedCount === 0}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold">
              {loading ? t('Importing...') : `${t('Import')} ${includedCount} ${t('rows')}`}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
