import React from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from '../hooks';
import type { DatabaseState } from '../dbStore';

// Pairs with src/usePaginatedList.ts. A <th> that toggles sort on click and shows the
// current sort direction — used across every paginated list table (Products, Customers,
// Vendors, Invoices, Quotations, Expenses, ...) so they all sort identically.
export function SortableTh({ label, column, sortBy, sortDir, onSort, className = '', align = 'start' }: {
  label: string; column: string; sortBy: string | null; sortDir: 'asc' | 'desc';
  onSort: (column: string) => void; className?: string; align?: 'start' | 'end' | 'center';
}) {
  const active = sortBy === column;
  const justify = align === 'end' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start';
  return (
    <th className={`p-4 ${className}`}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-1 ${justify} w-full hover:text-indigo-600 transition-colors ${active ? 'text-indigo-600' : ''}`}
      >
        <span>{label}</span>
        {active ? (
          sortDir === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronsUpDown className="w-3 h-3 opacity-40" />
        )}
      </button>
    </th>
  );
}

// Row-number column header/cell — a plain sequence (1, 2, 3...) continuing across pages,
// never the row's own database id (which is meaningless to a user and not sequential).
export function RowNumberTh({ label }: { label: string }) {
  return <th className="p-4 ps-5 text-start w-12">{label}</th>;
}
export function RowNumberTd({ page, pageSize, index }: { page: number; pageSize: number; index: number }) {
  return <td className="p-4 ps-5 text-slate-400 font-mono text-[11px]">{(page - 1) * pageSize + index + 1}</td>;
}

export function PaginationFooter({ db, page, totalPages, total, pageSize, onPageChange }: {
  db: DatabaseState; page: number; totalPages: number; total: number; pageSize: number; onPageChange: (page: number) => void;
}) {
  const { t } = useTranslation(db);
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div className="flex items-center justify-between px-5 py-3 border-t border-slate-100 text-[11px] text-slate-500">
      <span>
        {t('Showing')} <strong className="text-slate-700">{from}-{to}</strong> {t('of')} <strong className="text-slate-700">{total}</strong>
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="p-1.5 rounded-lg border border-slate-200 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50"
          aria-label={t('Previous page')}
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
        <span className="px-2 font-semibold text-slate-700">{page} / {totalPages}</span>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="p-1.5 rounded-lg border border-slate-200 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50"
          aria-label={t('Next page')}
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
