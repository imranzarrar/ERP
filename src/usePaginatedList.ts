import React from 'react';

// Shared client-side half of the pagination pattern used across every list screen
// (Product Catalog, Customers, Vendors, Invoices, Quotations, Expenses, ...). Pairs with
// server/lib/pagination.ts's parsePageSort/wantsPaged on the API side — passing `page`
// makes a route return {rows, total, page, pageSize} instead of its old plain array, so
// this hook works against any of those routes unchanged.
export interface PaginatedResult<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function usePaginatedList<T>(endpoint: string, pageSize: number = 50, enabled: boolean = true, extraParams: Record<string, string> = {}) {
  const [page, setPage] = React.useState(1);
  const [sortBy, setSortBy] = React.useState<string | null>(null);
  const [sortDir, setSortDir] = React.useState<'asc' | 'desc'>('asc');
  const [search, setSearch] = React.useState('');
  const [data, setData] = React.useState<PaginatedResult<T>>({ rows: [], total: 0, page: 1, pageSize });
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadToken, setReloadToken] = React.useState(0);

  // Stable string key so extraParams (a fresh object each render from the caller) only
  // triggers the fetch effect below when its actual contents change, not on every render.
  const extraParamsKey = JSON.stringify(extraParams);

  // Any filter change resets to page 1 — staying on page 6 of a now-3-page result (after a
  // search/filter narrows things down) would just show an empty page.
  React.useEffect(() => { setPage(1); }, [search, sortBy, sortDir, extraParamsKey]);

  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
        if (sortBy) { params.set('sortBy', sortBy); params.set('sortDir', sortDir); }
        if (search.trim()) params.set('search', search.trim());
        for (const [k, v] of Object.entries(JSON.parse(extraParamsKey) as Record<string, string>)) {
          if (v !== undefined && v !== null && v !== '') params.set(k, v);
        }
        const res = await fetch(`${endpoint}?${params.toString()}`);
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) { setError(body.error || 'Failed to load.'); return; }
        setData(body);
      } catch (e: any) {
        if (!cancelled) setError(e.message || 'Failed to load.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [endpoint, page, pageSize, sortBy, sortDir, search, reloadToken, enabled, extraParamsKey]);

  const toggleSort = (column: string) => {
    if (sortBy !== column) { setSortBy(column); setSortDir('asc'); return; }
    setSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'));
  };

  const totalPages = Math.max(1, Math.ceil(data.total / pageSize));
  const reload = () => setReloadToken(t => t + 1);

  return { rows: data.rows, total: data.total, page, pageSize, totalPages, loading, error, sortBy, sortDir, search, setPage, setSearch, toggleSort, reload };
}
