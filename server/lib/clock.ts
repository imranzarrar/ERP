import { AsyncLocalStorage } from 'node:async_hooks';

// The business "today" of the app. In production (and by default everywhere) this is just the real clock: nowDate() === new Date().
//
// For TESTING realistic multi-month stories without waiting for real months to pass, a local copy of the server can be started with
// ALLOW_DEV_CLOCK=1. A request may then carry the header `x-dev-date: YYYY-MM-DD`, or its login session may have been given a date
// through POST /api/dev/clock, and everything that request does sees that day as today (document dates, "today's" postings, the
// current-month and future-date checks). The time of day stays real. The flag is never set on the VPS, and the clock is refused outright
// when NODE_ENV is 'production'.
const store = new AsyncLocalStorage<{ date: string }>();
const sessionDates = new Map<string, string>();
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const devClockEnabled = (): boolean => process.env.ALLOW_DEV_CLOCK === '1' && process.env.NODE_ENV !== 'production';

export function runWithDevDate<T>(date: string | null | undefined, fn: () => T): T {
  return date && DAY.test(date) ? store.run({ date }, fn) : fn();
}

export function setSessionDevDate(sessionId: string, date: string | null): void {
  if (!date) sessionDates.delete(sessionId);
  else sessionDates.set(sessionId, date);
}
export const getSessionDevDate = (sessionId: string | undefined | null): string | undefined => (sessionId ? sessionDates.get(sessionId) : undefined);

export function nowDate(): Date {
  const real = new Date();
  const override = store.getStore()?.date;
  if (!override) return real;
  const [y, m, d] = override.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, real.getUTCHours(), real.getUTCMinutes(), real.getUTCSeconds(), real.getUTCMilliseconds()));
}

export const todayStr = (): string => nowDate().toISOString().slice(0, 10);
