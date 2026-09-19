import { useState, useCallback } from 'react';
import type { TranslationItem, User } from './types';
import type { DatabaseState } from './dbStore';
import { SEED_TRANSLATIONS } from './dbStore';
import { normalizePermissions, getAtPath } from './types';

const reportedKeys = new Set<string>();

// --- Fast lookups -----------------------------------------------------------------------
// t() runs for every visible string on every render. A linear .find() over the whole
// dictionary made that cost (strings x keys) — fine at a few hundred keys, painful at
// thousands. Index each translations array once (keyed by array identity, so a refreshed
// db.translations is re-indexed automatically) and the static seed once.
const dbIndexCache = new WeakMap<object, Map<string, TranslationItem>>();
function indexFor(list: TranslationItem[]): Map<string, TranslationItem> {
  let m = dbIndexCache.get(list);
  if (!m) {
    m = new Map();
    for (const item of list) m.set(item.key, item);
    dbIndexCache.set(list, m);
  }
  return m;
}
let seedIndex: Map<string, TranslationItem> | null = null;
function seedLookup(key: string): TranslationItem | undefined {
  if (!seedIndex) {
    seedIndex = new Map();
    for (const item of SEED_TRANSLATIONS as TranslationItem[]) if (!seedIndex.has(item.key)) seedIndex.set(item.key, item);
  }
  return seedIndex.get(key);
}

// --- Missing-key reporting --------------------------------------------------------------
// Batched (one request per flush, never one per string), debounced, and switched off for
// good if the server says auto-registration is disabled (it is in production — new keys
// there come from reviewed changes, not from browsers).
const pendingKeys = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let reportingDisabled = false;
const MAX_KEYS_PER_BATCH = 200;
function queueMissingKey(key: string) {
  if (reportingDisabled || reportedKeys.has(key)) return;
  reportedKeys.add(key);
  pendingKeys.add(key);
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    const keys = Array.from(pendingKeys);
    pendingKeys.clear();
    for (let i = 0; i < keys.length && !reportingDisabled; i += MAX_KEYS_PER_BATCH) {
      try {
        const res = await fetch('/api/register-missing-keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keys: keys.slice(i, i + MAX_KEYS_PER_BATCH) }),
        });
        const body = await res.json().catch(() => ({}));
        if (body?.status === 'disabled') reportingDisabled = true;
      } catch (err) {
        console.warn('Failed to register missing translation keys:', err);
      }
    }
  }, 1500);
}

export function useTranslation(db: DatabaseState, langOverride?: 'en' | 'ar' | 'ur') {
  // langOverride exists for the pre-login screens (LoginScreen, ResetPasswordScreen) —
  // there's no db.currentUser yet to read a uiLanguage from at that point, so those
  // screens pass a language read from localStorage instead (see App.tsx). Every other
  // caller passes nothing and keeps today's behavior unchanged.
  const lang = langOverride || db.currentUser?.uiLanguage || 'en';

  const t = (key: string): string => {
    if (!key) return '';

    // 1. Check for overrides in database-loaded state
    const dbItem = db.translations ? indexFor(db.translations).get(key) : undefined;
    if (dbItem) {
      if (lang === 'ar' && dbItem.ar) return dbItem.ar;
      if (lang === 'ur' && dbItem.ur) return dbItem.ur;
      if (dbItem.en) return dbItem.en;
    }

    // 2. Check for values in our local pre-seeded static dictionary
    const staticItem = seedLookup(key);
    if (staticItem) {
      if (lang === 'ar' && staticItem.ar) return staticItem.ar;
      if (lang === 'ur' && staticItem.ur) return staticItem.ur;
      if (staticItem.en) return staticItem.en;
    }

    // 3. If missing in both, register it in the background asynchronously
    // Only once the translation table has actually arrived: before that (first render, login
    // screen, /api/state still in flight) EVERY key looks "missing", so this used to fire
    // ~100 POSTs at once — over HTTP/1.1 that saturates the browser's 6 connections and
    // delays the very /api/state request the translations are waiting on.
    // Only once the translation table has actually arrived: before that (first render, login
    // screen, /api/state in flight) EVERY key looks "missing".
    if (db.translations && db.translations.length > 0) queueMissingKey(key);

    return key;
  };

  const isRTL = lang === 'ar' || lang === 'ur';

  return { t, lang, isRTL };
}

// Fiscal month names are composed client/server-side as "<English month> <year>" (e.g.
// "August 2026", see AdminSettings.handleAddCompany and handleOpenMonth) — never a
// pre-translated string. Passing that whole composite straight into t() (as one call
// site used to) registers a brand-new "missing translation" key every single month,
// forever, and never actually translates since no such composite key could ever have a
// stored ar/ur value. This translates just the month WORD via the normal dictionary
// (so it benefits from the same ar/ur entries every other label uses) and reassembles
// it with the untouched numeric year, which needs no translation.
const MONTH_LABEL_RE = /^([A-Za-z]+)\s+(\d{4})$/;
export function translateMonthLabel(name: string | undefined | null, t: (key: string) => string): string {
  if (!name) return '';
  const match = MONTH_LABEL_RE.exec(name.trim());
  if (!match) return name; // not the expected "<Month> <year>" shape — render as-is rather than guess
  const [, monthWord, year] = match;
  return `${t(monthWord)} ${year}`;
}

// Short-form aliases accepted by call sites throughout App.tsx/components, mapped to the
// canonical dotted paths normalizePermissions() actually produces.
const PERMISSION_PATH_ALIASES: Record<string, string> = {
  pos: 'pos.access',
  // Bare module-name aliases mean "can see this module at all" — mapped to `.view`.
  // Callers that specifically need to gate a create/add action use the canonical
  // 'quotation.create' / 'invoice.create' / 'expense.create' path directly (no alias
  // needed — it already matches normalizePermissions' output shape).
  quotation: 'quotation.read',
  'sales.quotation': 'quotation.read',
  invoice: 'invoice.read',
  'sales.invoice': 'invoice.read',
  expense: 'expense.read',
  investors: 'investors.access',
  // No bare `fiscalMonths` alias: viewing months is universal/ungated, and the two real
  // authorities (fiscalMonths.open / fiscalMonths.close) are distinct enough that a
  // caller should name the one it actually means, not fall back to a combined alias.
  //
  // No bare `reports` alias either, same reasoning: there are six real, independently
  // delegable reports now (trialBalance/salesVat/purchaseVat/bankLedger/profitLoss/
  // outstanding) — a caller must name the specific one it means.
};

// Generalizes the snapshot-vs-current dirty-check AdminSettings.tsx's Canvas Designer
// already uses (`hasUnsavedCanvasChanges = JSON.stringify(current) !== JSON.stringify(snapshot)`)
// into a reusable hook for transactional forms (Invoice/Quotation/Expense/etc). A form
// module calls `markClean()` when it opens a create/edit session and again right after a
// successful save; `isDirty` then reflects whether `currentValues` has changed since that
// last mark. Callers pack their many individual useState fields into one object at the
// call site (see InvoiceModule.tsx) — there's no app-wide unified form-state shape to hook
// into automatically.
export function useDirtyGuard(currentValues: unknown) {
  const [snapshot, setSnapshot] = useState<string | null>(null);

  const markClean = useCallback((values: unknown) => {
    setSnapshot(JSON.stringify(values));
  }, []);

  const isDirty = snapshot !== null && JSON.stringify(currentValues) !== snapshot;

  return { isDirty, markClean };
}

export function usePermissions(currentUser: User | undefined) {
  // Delegate entirely to normalizePermissions (src/types.ts) — the single source of
  // truth for what a permission means — instead of maintaining a second, independently
  // drifting implementation here.
  const normalized = normalizePermissions(currentUser?.permissions, currentUser?.role, currentUser?.isSuperAdmin);

  const can = (permissionPath: string): boolean => {
    if (!currentUser) return false;
    const path = PERMISSION_PATH_ALIASES[permissionPath] || permissionPath;
    return getAtPath(normalized, path, false);
  };

  return { can };
}
