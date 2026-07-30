import React from 'react';

export type StatusPillTone = 'good' | 'warn' | 'critical' | 'info' | 'neutral';

interface StatusPillProps {
  tone: StatusPillTone;
  children: React.ReactNode;
  className?: string;
}

// Shared five-color vocabulary for every status/payment/ZATCA badge across the Sales
// & Print screens (Invoices, Quotations, POS Sales History), replacing each screen's
// own ad-hoc badge classes with one component so the same word always renders the
// same color everywhere it appears.
//   good     -> Cleared / Paid / Accepted
//   warn     -> Pending / Partial / Draft
//   critical -> Rejected / Error / Cancelled
//   info     -> Reported / Sent / Converted (kept visually distinct from the app's
//               indigo primary-action color, which is reserved for clickable actions)
//   neutral  -> Not submitted / no status
const TONE_STYLES: Record<StatusPillTone, { badge: string; dot: string }> = {
  good: { badge: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500' },
  warn: { badge: 'bg-amber-50 text-amber-700 border-amber-200', dot: 'bg-amber-500' },
  critical: { badge: 'bg-rose-50 text-rose-700 border-rose-200', dot: 'bg-rose-500' },
  info: { badge: 'bg-sky-50 text-sky-700 border-sky-200', dot: 'bg-sky-500' },
  neutral: { badge: 'bg-slate-100 text-slate-600 border-slate-200', dot: 'bg-slate-400' },
};

export default function StatusPill({ tone, children, className = '' }: StatusPillProps) {
  const styles = TONE_STYLES[tone] || TONE_STYLES.neutral;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[9px] font-extrabold uppercase tracking-wider border whitespace-nowrap ${styles.badge} ${className}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${styles.dot}`} />
      {children}
    </span>
  );
}
