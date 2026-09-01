import React from 'react';
import { useTranslation, usePermissions } from '../hooks';
import { DatabaseState } from '../dbStore';
import { Plus, Trash2, ShieldCheck, AlertTriangle, Check, Printer } from 'lucide-react';

interface VatReturnsPanelProps {
  db: DatabaseState;
}

interface TaxReturnRow {
  id: string;
  referenceNumber: string;
  year: number;
  quarter: number;
  status: 'Generated' | 'Filed';
  isDeleted: boolean;
  startDate: string;
  endDate: string;
  figuresSnapshot: {
    salesSubtotal: number;
    outputVat: number;
    purchasesSubtotal: number;
    inputVat: number;
    netVatPayable: number;
  };
  generatedAt: string;
  generatedById: string;
  filedAt: string | null;
  filedById: string | null;
}

const money = (n: number) => `SAR ${Number(n || 0).toFixed(2)}`;

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

// A quarterly VAT filing record, not a report — Generate freezes a server-computed
// snapshot, File is a manual ZATCA-filing attestation that permanently locks the quarter
// (there is no live ZATCA API for VAT return submission today, only e-invoicing). See
// server/routes/taxReturns.ts / server/lib/vatReturn.ts for the full lifecycle rules.
export default function VatReturnsPanel({ db }: VatReturnsPanelProps) {
  const { t, isRTL } = useTranslation(db);
  const { can } = usePermissions(db.currentUser);
  const company = db.companies?.find(c => c.id === db.selectedCompanyId);

  const currentYear = new Date().getFullYear();
  const currentQuarter = Math.ceil((new Date().getMonth() + 1) / 3);

  const [rows, setRows] = React.useState<TaxReturnRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [year, setYear] = React.useState(currentYear);
  const [quarter, setQuarter] = React.useState(currentQuarter);
  const [success, setSuccess] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const triggerSuccess = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(null), 4500); };
  const triggerError = (msg: string) => { setError(msg); setTimeout(() => setError(null), 6000); };

  const loadRows = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/tax-returns');
      const data = await res.json().catch(() => ([]));
      if (res.ok) setRows(data);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { loadRows(); }, [loadRows, db.selectedCompanyId]);

  const handleGenerate = async () => {
    try {
      const res = await fetch('/api/tax-returns/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, quarter }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) return triggerError(data.error || t('Failed to generate VAT return.'));
      triggerSuccess(t('VAT return generated.'));
      loadRows();
    } catch (err: any) {
      triggerError(err.message || t('Failed to generate VAT return.'));
    }
  };

  const handleFile = async (row: TaxReturnRow) => {
    if (!window.confirm(t('Mark {ref} as ZATCA Filed? This is permanent — the quarter will be locked and no new Invoice, Credit/Debit Note, Expense, or Purchase Bill can be dated within it afterward. This cannot be undone.').replace('{ref}', row.referenceNumber))) return;
    try {
      const res = await fetch(`/api/tax-returns/${row.id}/file`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) return triggerError(data.error || t('Failed to file VAT return.'));
      triggerSuccess(t('{ref} marked as ZATCA Filed.').replace('{ref}', row.referenceNumber));
      loadRows();
    } catch (err: any) {
      triggerError(err.message || t('Failed to file VAT return.'));
    }
  };

  const handleDelete = async (row: TaxReturnRow) => {
    if (!window.confirm(t('Delete this generated VAT return? You can regenerate {ref} afterward.').replace('{ref}', row.referenceNumber))) return;
    try {
      const res = await fetch(`/api/tax-returns/${row.id}/delete`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) return triggerError(data.error || t('Failed to delete VAT return.'));
      triggerSuccess(t('VAT return deleted.'));
      loadRows();
    } catch (err: any) {
      triggerError(err.message || t('Failed to delete VAT return.'));
    }
  };

  // Prints a standalone "VAT Return (Q{n}-{year})" copy — a fixed regulatory-summary
  // format, not a Canvas-Designer-customizable branded document, so this builds its own
  // print popup rather than routing through DocumentRenderer.tsx. Reuses that component's
  // proven print-fidelity mechanics exactly (clone every real <style>/<link> tag rather
  // than a hand-picked subset, print-color-adjust: exact since browsers strip background
  // colors from print output by default, and wait on document.fonts.ready before calling
  // window.print() so a mid-download webfont doesn't silently fall back to a system font
  // for the printed snapshot) — see DocumentRenderer.tsx's own handlePrint for the
  // original, harder-won version of each of these fixes.
  const handlePrint = (row: TaxReturnRow) => {
    const printWindow = window.open('', '', 'height=800,width=1000');
    if (!printWindow) {
      window.alert(t('Please allow popups to print/generate PDF.'));
      return;
    }
    const styleTags = Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))
      .map(el => el.outerHTML)
      .join('\n');

    const statusLabel = row.status === 'Filed' ? t('Filed') : t('Generated');
    const filedLine = row.status === 'Filed' && row.filedAt
      ? `<div class="vr-meta-row"><span>${escapeHtml(t('Filed On'))}</span><span>${escapeHtml(new Date(row.filedAt).toLocaleDateString())}</span></div>`
      : '';

    const rowsHtml = [
      { label: t('Sales'), value: money(row.figuresSnapshot.salesSubtotal) },
      { label: t('VAT on Sales'), value: money(row.figuresSnapshot.outputVat) },
      { label: t('Purchases'), value: money(row.figuresSnapshot.purchasesSubtotal) },
      { label: t('VAT on Purchases'), value: money(row.figuresSnapshot.inputVat) },
    ].map(r => `<tr><td class="vr-label">${escapeHtml(r.label)}</td><td class="vr-value">${escapeHtml(r.value)}</td></tr>`).join('\n');

    const printContent = `
      <div id="printable-document-content" class="vr-paper">
        <div class="vr-header">
          <div>
            <div class="vr-company-name">${escapeHtml(company?.name || '')}</div>
            <div class="vr-company-detail">${escapeHtml(company?.address || '')}</div>
            ${company?.vatNumber ? `<div class="vr-company-detail">${escapeHtml(t('VAT Registration Number'))}: ${escapeHtml(company.vatNumber)}</div>` : ''}
          </div>
          <div class="vr-title-block">
            <div class="vr-doc-title">${escapeHtml(t('VAT Return'))}</div>
            <div class="vr-doc-ref">${escapeHtml(row.referenceNumber)}</div>
          </div>
        </div>
        <div class="vr-meta">
          <div class="vr-meta-row"><span>${escapeHtml(t('Period'))}</span><span>${escapeHtml(row.startDate)} — ${escapeHtml(row.endDate)}</span></div>
          <div class="vr-meta-row"><span>${escapeHtml(t('Status'))}</span><span>${escapeHtml(statusLabel)}</span></div>
          ${filedLine}
        </div>
        <table class="vr-table">
          <tbody>
            ${rowsHtml}
            <tr class="vr-net-row"><td class="vr-label">${escapeHtml(t('Net Payable VAT'))}</td><td class="vr-value">${escapeHtml(money(row.figuresSnapshot.netVatPayable))}</td></tr>
          </tbody>
        </table>
        <p class="vr-footnote">${escapeHtml(t('Filing with ZATCA is a manual step performed on ZATCA\'s own VAT return portal — this record only tracks that it was done, and permanently locks the quarter\'s documents once you confirm it here.'))}</p>
      </div>
    `;

    printWindow.document.write(`
      <html>
      <head>
        <title>${escapeHtml(t('VAT Return'))} - ${escapeHtml(row.referenceNumber)}</title>
        ${styleTags}
        <style>
          html, body { margin: 0; padding: 20px; color: #1e293b; direction: ${isRTL ? 'rtl' : 'ltr'}; background-color: white; }
          .vr-paper { max-width: 720px; margin: 0 auto; }
          .vr-header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1e293b; padding-bottom: 16px; margin-bottom: 16px; }
          .vr-company-name { font-size: 18px; font-weight: 800; }
          .vr-company-detail { font-size: 12px; color: #475569; margin-top: 2px; }
          .vr-title-block { text-align: end; }
          .vr-doc-title { font-size: 20px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; }
          .vr-doc-ref { font-size: 14px; font-weight: 700; color: #4f46e5; margin-top: 2px; }
          .vr-meta { margin-bottom: 20px; }
          .vr-meta-row { display: flex; justify-content: space-between; font-size: 12px; padding: 4px 0; border-bottom: 1px solid #f1f5f9; }
          .vr-meta-row span:first-child { color: #64748b; font-weight: 600; }
          .vr-table { width: 100%; border-collapse: collapse; font-size: 13px; }
          .vr-table td { padding: 10px 4px; border-bottom: 1px solid #e2e8f0; }
          .vr-table .vr-label { color: #334155; font-weight: 600; }
          .vr-table .vr-value { text-align: end; font-family: monospace; }
          .vr-net-row td { border-top: 2px solid #1e293b; border-bottom: none; font-weight: 800; font-size: 15px; padding-top: 14px; }
          .vr-footnote { font-size: 10px; color: #94a3b8; margin-top: 24px; line-height: 1.5; }
          @media print {
            * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
            body { padding: 0; margin: 0; width: 100%; }
            @page { size: A4 portrait; margin: 0.6in; }
          }
        </style>
      </head>
      <body>
        ${printContent}
        <script>
          window.onload = function() {
            var doPrint = function() {
              window.print();
              setTimeout(function() { window.close(); }, 500);
            };
            if (window.document.fonts && window.document.fonts.ready) {
              Promise.race([
                window.document.fonts.ready,
                new Promise(function(resolve) { setTimeout(resolve, 1500); })
              ]).then(doPrint);
            } else {
              doPrint();
            }
          };
        </script>
      </body>
      </html>
    `);
    printWindow.document.close();
  };

  const years = Array.from({ length: 6 }, (_, i) => currentYear - 4 + i);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-bold text-slate-900">{t('VAT Returns (ZATCA Filing)')}</h3>
        <p className="text-[11px] text-slate-400">{t('Generate a quarterly VAT return from real Sales/Purchase data, then mark it as ZATCA Filed once you have filed it on ZATCA\'s own VAT portal. Filing is permanent and locks that quarter\'s documents.')}</p>
      </div>

      {success && <div className="p-2.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-xl text-xs font-semibold">{success}</div>}
      {error && <div className="p-2.5 bg-rose-50 text-rose-700 border border-rose-200 rounded-xl text-xs font-semibold">{error}</div>}

      {can('taxReturns.create') && (
        <div className="flex items-end gap-3 p-4 bg-slate-50 rounded-2xl border border-slate-100">
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Year')}</label>
            <select value={year} onChange={e => setYear(Number(e.target.value))}
              className="bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500">
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Quarter')}</label>
            <select value={quarter} onChange={e => setQuarter(Number(e.target.value))}
              className="bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500">
              <option value={1}>Q1 ({t('Jan')}–{t('Mar')})</option>
              <option value={2}>Q2 ({t('Apr')}–{t('Jun')})</option>
              <option value={3}>Q3 ({t('Jul')}–{t('Sep')})</option>
              <option value={4}>Q4 ({t('Oct')}–{t('Dec')})</option>
            </select>
          </div>
          <button type="button" onClick={handleGenerate}
            className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl px-4 py-1.5 text-xs font-bold flex items-center gap-1.5 shadow-sm">
            <Plus className="w-3.5 h-3.5" /> {t('Generate')}
          </button>
        </div>
      )}

      <div className="border border-slate-100 rounded-2xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 text-slate-500">
                <th className="p-3 text-start">{t('Reference')}</th>
                <th className="p-3 text-start">{t('Status')}</th>
                <th className="p-3 text-end">{t('Sales')}</th>
                <th className="p-3 text-end">{t('VAT on Sales')}</th>
                <th className="p-3 text-end">{t('Purchases')}</th>
                <th className="p-3 text-end">{t('VAT on Purchases')}</th>
                <th className="p-3 text-end">{t('Net Payable VAT')}</th>
                <th className="p-3 text-end">{t('Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} className="p-6 text-center text-slate-400">{t('Loading...')}</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={8} className="p-6 text-center text-slate-400">{t('No VAT returns generated yet.')}</td></tr>
              ) : rows.map(row => (
                <tr key={row.id} className={`border-b border-slate-100 last:border-0 ${row.isDeleted ? 'opacity-50' : ''}`}>
                  <td className="p-3 font-semibold text-slate-800">
                    {row.referenceNumber}
                    {row.isDeleted && <span className="ms-1.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase bg-slate-100 text-slate-500 border border-slate-200">{t('Deleted')}</span>}
                  </td>
                  <td className="p-3">
                    {row.status === 'Filed' ? (
                      <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase bg-emerald-50 text-emerald-700 border border-emerald-200 inline-flex items-center gap-1"><ShieldCheck className="w-3 h-3" /> {t('Filed')}</span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase bg-amber-50 text-amber-700 border border-amber-200">{t('Generated')}</span>
                    )}
                  </td>
                  <td className="p-3 text-end font-mono">{money(row.figuresSnapshot.salesSubtotal)}</td>
                  <td className="p-3 text-end font-mono">{money(row.figuresSnapshot.outputVat)}</td>
                  <td className="p-3 text-end font-mono">{money(row.figuresSnapshot.purchasesSubtotal)}</td>
                  <td className="p-3 text-end font-mono">{money(row.figuresSnapshot.inputVat)}</td>
                  <td className="p-3 text-end font-mono font-bold text-slate-800">{money(row.figuresSnapshot.netVatPayable)}</td>
                  <td className="p-3 text-end">
                    {!row.isDeleted && (
                      <div className="flex justify-end gap-3">
                        <button type="button" onClick={() => handlePrint(row)} className="text-[10px] font-bold text-slate-500 hover:underline flex items-center gap-1">
                          <Printer className="w-3 h-3" /> {t('Print')}
                        </button>
                        {row.status === 'Generated' && can('taxReturns.file') && (
                          <button type="button" onClick={() => handleFile(row)} className="text-[10px] font-bold text-emerald-600 hover:underline flex items-center gap-1">
                            <Check className="w-3 h-3" /> {t('Mark as ZATCA Filed')}
                          </button>
                        )}
                        {row.status === 'Generated' && can('taxReturns.delete') && (
                          <button type="button" onClick={() => handleDelete(row)} className="text-[10px] font-bold text-rose-500 hover:underline flex items-center gap-1">
                            <Trash2 className="w-3 h-3" /> {t('Delete')}
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[10px] text-slate-400 flex items-start gap-1.5">
        <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
        {t('Filing with ZATCA is a manual step performed on ZATCA\'s own VAT return portal — this record only tracks that it was done, and permanently locks the quarter\'s documents once you confirm it here.')}
      </p>
    </div>
  );
}
