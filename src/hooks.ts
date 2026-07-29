import type { TranslationItem, User } from './types';
import type { DatabaseState } from './dbStore';
import { SEED_TRANSLATIONS } from './dbStore';
import { normalizePermissions, getAtPath } from './types';

const reportedKeys = new Set<string>();

export function useTranslation(db: DatabaseState) {
  const lang = db.currentUser?.uiLanguage || 'en';

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

// Short-form aliases accepted by call sites throughout App.tsx/components, mapped to the
// canonical dotted paths normalizePermissions() actually produces.
const PERMISSION_PATH_ALIASES: Record<string, string> = {
  pos: 'pos.access',
  // Bare module-name aliases mean "can see this module at all" — mapped to `.view`.
  // Callers that specifically need to gate a create/add action use the canonical
  // 'quotation.create' / 'invoice.create' / 'expense.create' path directly (no alias
  // needed — it already matches normalizePermissions' output shape).
  quotation: 'quotation.view',
  'sales.quotation': 'quotation.view',
  invoice: 'invoice.view',
  'sales.invoice': 'invoice.view',
  expense: 'expense.view',
  cancel: 'cancel.access',
  investors: 'investors.access',
  fiscalMonths: 'fiscalMonths.access',
  reports: 'reports.access',
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
