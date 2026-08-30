import type { TranslationItem, User } from './types';
import type { DatabaseState } from './dbStore';
import { SEED_TRANSLATIONS } from './dbStore';
import { normalizePermissions, getAtPath } from './types';

const reportedKeys = new Set<string>();

export function useTranslation(db: DatabaseState, langOverride?: 'en' | 'ar' | 'ur') {
  // langOverride exists for the pre-login screens (LoginScreen, ResetPasswordScreen) —
  // there's no db.currentUser yet to read a uiLanguage from at that point, so those
  // screens pass a language read from localStorage instead (see App.tsx). Every other
  // caller passes nothing and keeps today's behavior unchanged.
  const lang = langOverride || db.currentUser?.uiLanguage || 'en';

  const t = (key: string): string => {
    if (!key) return '';

    // 1. Check for overrides in database-loaded state
    const dbItem = db.translations?.find((t: TranslationItem) => t.key === key);
    if (dbItem) {
      if (lang === 'ar' && dbItem.ar) return dbItem.ar;
      if (lang === 'ur' && dbItem.ur) return dbItem.ur;
      if (dbItem.en) return dbItem.en;
    }

    // 2. Check for values in our local pre-seeded static dictionary
    const staticItem = SEED_TRANSLATIONS.find((t: TranslationItem) => t.key === key);
    if (staticItem) {
      if (lang === 'ar' && staticItem.ar) return staticItem.ar;
      if (lang === 'ur' && staticItem.ur) return staticItem.ur;
      if (staticItem.en) return staticItem.en;
    }

    // 3. If missing in both, register it in the background asynchronously
    if (!reportedKeys.has(key)) {
      reportedKeys.add(key);
      fetch('/api/register-missing-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      }).catch(err => {
        console.warn('Failed to register missing translation key:', key, err);
      });
    }

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
