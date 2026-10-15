import React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import StatusPill from '../StatusPill';

// Small shared pieces for the General Ledger screens: one fetch helper that turns a server error into a readable message, money formatting that
// keeps columns aligned, and the page chrome (card, buttons, drawer) so every ledger screen looks and behaves the same.
export const ledgerApi = <T = any>(path: string, init: { method?: string; body?: any } = {}): Promise<T> => erpApi<T>(`/api/ledger${path}`, init);
// the same call for any /api route (the receipts and payments screens live under /api/settlements)
export async function erpApi<T = any>(url: string, init: { method?: string; body?: any } = {}): Promise<T> {
  const res = await fetch(url, {
    method: init.method || 'GET',
    headers: init.body !== undefined && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    body: init.body === undefined ? undefined : init.body instanceof FormData ? init.body : JSON.stringify(init.body),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body as T;
}

export async function downloadLedgerFile(path: string, filename: string) {
  const res = await fetch(`/api/ledger${path}`);
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || 'Download failed.'); }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export const money = (n: number | null | undefined) => (n === null || n === undefined || isNaN(Number(n)) ? '' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
// A debit / credit column cell: blank for zero so a ledger reads cleanly.
export const moneyOrBlank = (n: number) => (Math.abs(n) < 0.005 ? '' : money(n));
export const todayIso = () => new Date().toISOString().slice(0, 10);
export const monthStartIso = () => `${todayIso().slice(0, 8)}01`;
export const yearStartIso = () => `${todayIso().slice(0, 4)}-01-01`;

export const inputCls = 'w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50 disabled:text-slate-400';
export const labelCls = 'block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1';
export const primaryBtn = 'inline-flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl px-3.5 py-2 text-xs font-bold shadow-sm transition cursor-pointer';
export const ghostBtn = 'inline-flex items-center gap-1.5 bg-white hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed text-slate-700 border border-slate-200 rounded-xl px-3.5 py-2 text-xs font-bold transition cursor-pointer';
export const dangerBtn = 'inline-flex items-center gap-1.5 bg-rose-600 hover:bg-rose-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl px-3.5 py-2 text-xs font-bold shadow-sm transition cursor-pointer';
export const greenBtn = 'inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl px-3.5 py-2 text-xs font-bold shadow-sm transition cursor-pointer';

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string; key?: React.Key }) {
  return <div className={`bg-white rounded-2xl border border-slate-100 shadow-sm ${className}`}>{children}</div>;
}

export function Notice({ tone, children }: { tone: 'error' | 'success' | 'warn' | 'info'; children: React.ReactNode; key?: React.Key }) {
  const cls = tone === 'error' ? 'bg-rose-50 border-rose-200 text-rose-700' : tone === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
    : tone === 'warn' ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-sky-50 border-sky-200 text-sky-800';
  return <div className={`${cls} border rounded-xl px-3.5 py-2.5 text-xs font-medium`}>{children}</div>;
}

// Status of a manual journal / ledger entry as a coloured pill (labels are translated by the caller).
export function JournalStatusPill({ status, label }: { status: string; label: string }) {
  const tone = status === 'Posted' ? 'good' : status === 'Pending' ? 'warn' : status === 'Rejected' ? 'critical' : status === 'Discarded' ? 'neutral' : 'info';
  return <StatusPill tone={tone as any}>{label}</StatusPill>;
}

// A right-hand slide-over panel (drawer). Portalled to <body> so an animated ancestor cannot break its fixed positioning.
export function Drawer({ title, onClose, children, footer, width = 'max-w-md' }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; width?: string }) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`bg-white w-full ${width} h-full shadow-2xl flex flex-col`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 className="text-sm font-bold text-slate-900">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 cursor-pointer"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-end gap-2 bg-slate-50/60">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

export function Modal({ title, onClose, children, footer, width = 'max-w-lg' }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; width?: string }) {
  return createPortal(
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`bg-white rounded-2xl shadow-2xl w-full ${width} max-h-[88vh] flex flex-col`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 className="text-sm font-bold text-slate-900">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 cursor-pointer"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

// A short-lived success / error line shown under the page title.
export function useBanner() {
  const [banner, setBanner] = React.useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const timer = React.useRef<any>(null);
  const show = React.useCallback((tone: 'error' | 'success', text: string) => {
    setBanner({ tone, text });
    if (timer.current) clearTimeout(timer.current);
    if (tone === 'success') timer.current = setTimeout(() => setBanner(null), 4000);
  }, []);
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return { banner, show, clear: () => setBanner(null) };
}

export const ACCOUNT_TYPES = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'] as const;

// What a ledger entry came from, as a readable label (translated by the caller with t()).
export const SOURCE_LABEL: Record<string, string> = {
  Manual: 'Manual journal', Opening: 'Opening balances', Invoice: 'Invoice', CreditNote: 'Credit note', Expense: 'Expense', PurchaseBill: 'Purchase bill',
  Grn: 'Goods receipt', GRN: 'Goods receipt', PurchaseReturn: 'Purchase return', Voucher: 'Voucher', Transfer: 'Transfer', FiscalMonthClose: 'Month close', VatReturn: 'VAT return',
};
