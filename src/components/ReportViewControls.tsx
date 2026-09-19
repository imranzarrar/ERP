import React from 'react';
import { Eye, Loader2, ChevronLeft, ChevronRight } from 'lucide-react';

// Shared "View Report" plumbing for every report screen (Sales/Purchase/Inventory/Financial).
// A report never loads on open or on a filter change — the user sets filters, then clicks
// View Report. That single click is the only thing that queries the server (or, for the few
// reports still computed in-browser, the only thing that computes), so a company with
// thousands of documents a day never pays for a default-filter query it didn't ask for.

export interface ReportPagination { page: number; pageSize: number; totalRows: number; totalPages: number }

export function useReportViewer<T = any>(emptyData: T) {
  const emptyRef = React.useRef(emptyData);
  const [data, setData] = React.useState<T>(emptyData);
  // `appliedKey` identifies exactly what was viewed (the fetch URL for server-backed
  // reports, a filter-snapshot key for in-browser ones) — compared to the current filters'
  // key to tell whether the screen is showing stale results.
  const [appliedKey, setAppliedKey] = React.useState<string | null>(null);
  const [snapshot, setSnapshot] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(false);
  // true once there are results on screen for the current view (immediately for in-browser
  // reports; after the first successful response for server-backed ones).
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pageSize, setPageSize] = React.useState(100);
  const abortRef = React.useRef<AbortController | null>(null);
  const baseUrlRef = React.useRef<string | null>(null);

  const withPaging = (url: string, page: number, size: number) =>
    `${url}${url.includes('?') ? '&' : '?'}page=${page}&pageSize=${size}`;

  const run = React.useCallback(async (baseUrl: string, page: number, size: number) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(withPaging(baseUrl, page, size), { signal: controller.signal });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      const json = await res.json();
      if (controller.signal.aborted) return;
      baseUrlRef.current = baseUrl;
      setData(json);
      setLoaded(true);
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      setError(e?.message || 'Failed to load report');
    } finally {
      if (abortRef.current === controller) setLoading(false);
    }
  }, []);

  // key: identifies this view. url: server endpoint (omit for in-browser reports).
  // snap: the exact filter values in effect, so in-browser calculations use what was
  // clicked, not whatever the draft inputs have since been edited to.
  const view = React.useCallback((key: string, url?: string | null, snap?: any) => {
    setAppliedKey(key);
    setSnapshot(snap ?? null);
    if (url) {
      setLoaded(false);
      run(url, 1, pageSize);
    } else {
      setLoaded(true);
      abortRef.current?.abort();
      baseUrlRef.current = null;
      setLoading(false);
      setError(null);
    }
  }, [run, pageSize]);

  const goToPage = React.useCallback((page: number) => {
    if (baseUrlRef.current) run(baseUrlRef.current, page, pageSize);
  }, [run, pageSize]);

  const changePageSize = React.useCallback((size: number) => {
    setPageSize(size);
    if (baseUrlRef.current) run(baseUrlRef.current, 1, size);
  }, [run]);

  // Print/export needs every row, not just the on-screen page.
  const fetchAll = React.useCallback(async (): Promise<any | null> => {
    if (!baseUrlRef.current) return null;
    const url = baseUrlRef.current;
    const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}all=true`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${res.status})`);
    }
    return res.json();
  }, []);

  const reset = React.useCallback(() => {
    abortRef.current?.abort();
    baseUrlRef.current = null;
    setData(emptyRef.current);
    setAppliedKey(null);
    setSnapshot(null);
    setLoaded(false);
    setLoading(false);
    setError(null);
  }, []);

  React.useEffect(() => () => abortRef.current?.abort(), []);

  return {
    data, appliedKey, snapshot, loading, loaded, error, pageSize,
    hasViewed: appliedKey !== null,
    pagination: ((data as any)?.pagination as ReportPagination | undefined),
    view, goToPage, changePageSize, fetchAll, reset,
  };
}

interface ViewReportButtonProps {
  onView: () => void;
  loading: boolean;
  stale: boolean;
  disabled?: boolean;
  t: (key: string) => string;
}

// Last row of each report's filter grid, right-aligned: the stale hint (if any) then the button.
export function ViewReportButton({ onView, loading, stale, disabled, t }: ViewReportButtonProps) {
  return (
    <div className="col-span-full flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2 sm:gap-4 pt-1">
      {stale && !loading && (
        <p className="text-[10px] font-semibold text-amber-600">{t('Filters changed — click View Report to refresh.')}</p>
      )}
      <button
        type="button"
        onClick={onView}
        disabled={loading || disabled}
        className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-extrabold rounded-xl px-6 py-2.5 text-xs transition-all duration-150 flex items-center justify-center gap-1.5 shadow-md shrink-0"
      >
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
        {t('View Report')}
      </button>
    </div>
  );
}

interface ReportPlaceholderProps { loading: boolean; error: string | null; t: (key: string) => string }

// Shown in place of the report body until the user has clicked View Report (or while the
// very first request is in flight / failed).
export function ReportPlaceholder({ loading, error, t }: ReportPlaceholderProps) {
  if (error) {
    return <div className="text-center py-12 text-xs font-semibold text-rose-600">{error}</div>;
  }
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-xs text-slate-400">
        <Loader2 className="w-4 h-4 animate-spin" /> {t('Loading report...')}
      </div>
    );
  }
  return <div className="text-center py-12 text-xs text-slate-400">{t('Set your filters, then click View Report to load this report.')}</div>;
}

// Thin status strip shown above an already-loaded report while a refresh/page change is in
// flight or has failed, so the previous rows never look like the final answer.
export function ReportStatusStrip({ loading, error, t }: { loading: boolean; error: string | null; t: (key: string) => string }) {
  if (error) return <div className="mb-3 text-[11px] font-semibold text-rose-600">{error}</div>;
  if (loading) return <div className="mb-3 flex items-center gap-1.5 text-[11px] text-slate-400"><Loader2 className="w-3 h-3 animate-spin" /> {t('Loading report...')}</div>;
  return null;
}

interface ReportPagerProps {
  pagination: ReportPagination | undefined;
  pageSize: number;
  loading: boolean;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
  t: (key: string) => string;
}

export function ReportPager({ pagination, pageSize, loading, onPage, onPageSize, t }: ReportPagerProps) {
  if (!pagination || pagination.totalRows === 0) return null;
  const { page, totalPages, totalRows } = pagination;
  const from = (page - 1) * pagination.pageSize + 1;
  const to = Math.min(page * pagination.pageSize, totalRows);
  return (
    <div className="mt-4 pt-4 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3 text-[11px] text-slate-500">
      <span>{t('Showing')} {from}–{to} {t('of')} {totalRows} {t('rows')}</span>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5">
          {t('Rows per page')}
          <select value={pageSize} onChange={e => onPageSize(Number(e.target.value))} disabled={loading}
            className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-[11px] text-slate-700 focus:outline-none">
            {[50, 100, 250, 500].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => onPage(page - 1)} disabled={loading || page <= 1}
          className="p-1.5 rounded-lg border border-slate-200 disabled:opacity-40 hover:bg-slate-50" aria-label={t('Previous')}>
          <ChevronLeft className="w-3.5 h-3.5 rtl:rotate-180" />
        </button>
        <span className="font-semibold text-slate-700">{t('Page')} {page} {t('of')} {totalPages}</span>
        <button type="button" onClick={() => onPage(page + 1)} disabled={loading || page >= totalPages}
          className="p-1.5 rounded-lg border border-slate-200 disabled:opacity-40 hover:bg-slate-50" aria-label={t('Next')}>
          <ChevronRight className="w-3.5 h-3.5 rtl:rotate-180" />
        </button>
      </div>
    </div>
  );
}
