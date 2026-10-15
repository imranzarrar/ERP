// The date rules every document shares (docs/date-fields-standard.md). One place decides how the two core dates relate, so no route repeats the rule:
//   doc_date     the date of the document (what is printed on it; operational reports read it)
//   posting_date the date the ledger and every period lock use (financial statements read it); equal to doc_date unless a back-date policy says otherwise
// A document that posts takes `...documentDates(docDate)` into its insert; the back-date lock (server/lib/postingGuard.ts) decides whether a posting date is allowed.
import { nowDate } from './clock.js';

export interface DocumentDates { docDate: string; postingDate: string }

export function documentDates(docDate: string, postingDate?: string | null): DocumentDates {
  return { docDate, postingDate: postingDate || docDate };
}

// A document the system dates itself (a goods receipt, a transfer, a return, a stock take, a requisition): entered now, so its document date is today.
// `createdAt` keeps the moment so documents of one day stay in the order they were entered; `postingDate` is added for the ones that post.
export function entryStamp(userId: string | null, now: Date = nowDate()): { createdAt: Date; createdById: string | null; docDate: string } {
  return { createdAt: now, createdById: userId, docDate: now.toISOString().slice(0, 10) };
}
export function systemDated(userId: string | null, now: Date = nowDate()) {
  const stamp = entryStamp(userId, now);
  return { ...stamp, postingDate: stamp.docDate };
}
