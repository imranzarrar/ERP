import { motion } from 'motion/react';
import React from 'react';
import { useTranslation, usePermissions, translateMonthLabel } from './hooks';
import { getDatabase, saveDatabase, getActiveOpenMonth, getOpenMonths, DatabaseState } from './dbStore';
import { THEME_PROFILES, applyTheme } from './theme';
import { ensureCompatibleImage } from './imageUtils';

// Importing Modules
import Dashboard from './components/Dashboard';
import QuotationModule from './components/QuotationModule';
import InvoiceModule from './components/InvoiceModule';
import InvoiceViewScreen from './components/InvoiceViewScreen';
import ExpenseModule from './components/ExpenseModule';
import RecurringExpenses from './components/RecurringExpenses';
import PosModule from './components/PosModule';
import MasterEntities from './components/MasterEntities';
import AdminSettings from './components/AdminSettings';
import DocumentRenderer from './components/DocumentRenderer';
import ReportViewer from './components/ReportViewer';
import SalesReportsModule from './components/SalesReportsModule';
import PurchaseReportsModule from './components/PurchaseReportsModule';
import InventoryReportsModule from './components/InventoryReportsModule';
import LoginScreen from './components/LoginScreen';
import warraqMark from './assets/warraq-mark.svg';
import ResetPasswordScreen from './components/ResetPasswordScreen';
import ChangePasswordScreen from './components/ChangePasswordScreen';
import CompanyOnboardingScreen from './components/CompanyOnboardingScreen';
import InventoryModule from './components/InventoryModule';
import EmployeesModule from './components/EmployeesModule';
import ModifierGroupsModule from './components/ModifierGroupsModule';

// Importing Icons
import {
 LayoutDashboard,
 FileText,
 CreditCard,
 TrendingDown,
 RefreshCw,
 FolderTree,
 Settings,
 Menu,
 X,
 User as UserIcon,
 Printer,
 ChevronRight, ChevronDown,
 AlertTriangle,
 Lock,
 BarChart3,
 Users,
 Briefcase,
 Layers,
 Shield,
 LogOut,
 KeyRound,
 DatabaseZap,
 ShoppingCart, 
 Boxes,
 Search,
 PanelLeftClose,
 PanelLeft
} from 'lucide-react';



export default function App() {
 const [db, setDb] = React.useState<DatabaseState>(() => getDatabase());
 const [dbLoaded, setDbLoaded] = React.useState(false);
 const [sessionUserId, setSessionUserId] = React.useState<string | null>(localStorage.getItem('erp_session_user_id'));
 // Pre-login language choice — LoginScreen and ResetPasswordScreen render before any
 // db.currentUser exists, so there's no uiLanguage to read yet. Persisted separately from
 // the account-level preference (which is only set once someone actually logs in) so a
 // shared/kiosk machine remembers what the login screen itself was last shown in.
 const [preLoginLang, setPreLoginLang] = React.useState<'en' | 'ar' | 'ur'>(() => {
   const stored = localStorage.getItem('erp_pre_login_lang');
   return stored === 'ar' || stored === 'ur' ? stored : 'en';
 });
 const handlePreLoginLangChange = (lang: 'en' | 'ar' | 'ur') => {
   localStorage.setItem('erp_pre_login_lang', lang);
   setPreLoginLang(lang);
 };
 // Forgot-password reset link (?resetToken=...) — checked ahead of the logged-in-vs-login
 // branch below so it works the same way regardless of whether a stale session happens
 // to still be present in this browser.
 const [resetToken, setResetToken] = React.useState<string | null>(() => new URLSearchParams(window.location.search).get('resetToken'));
 // Public company-onboarding signup (?onboard=1) — reached the exact same way
 // resetToken is: a query param checked before the login gate, no real router needed,
 // since this SPA has none. See server/routes/onboarding.ts for the route this posts to.
 const [onboard, setOnboard] = React.useState<string | null>(() => new URLSearchParams(window.location.search).get('onboard'));

 React.useEffect(() => {
  if (!sessionUserId) {
    setDbLoaded(true);
    return;
  }

  setDbLoaded(false);
  fetch('/api/state')
  .then(async (r) => {
  if (r.status === 401) {
  console.warn("Unauthorized/Session expired. Forcing clean logout.");
  localStorage.removeItem('erp_session_user_id');
  localStorage.removeItem('erp_session_id');
  setSessionUserId(null);
  setDb(prev => {
  const newDb = { ...prev, currentUser: undefined };
  saveDatabase(newDb);
  return newDb;
  });
  throw new Error('Unauthorized');
  }
  if (!r.ok) {
  throw new Error(`HTTP error! status: ${r.status}`);
  }
  return r.json();
  })
  .then(data => {
  if (data && data.users) {
  setDb(prev => {
    // Postgres data is the absolute source of truth!
    const users = data.users || [];
    const companies = data.companies || [];
    
    const loggedUser = users.find((u: any) => u.id === sessionUserId);
    
    let selectedCompanyId = prev.selectedCompanyId;
    if (loggedUser) {
      const isSuperAdminUser = loggedUser.isSuperAdmin === true || loggedUser.role === 'super-admin' || loggedUser.role === 'superadmin';
      // Super-admins can switch companies (multi-tenant access) — keep whatever they've
      // already switched to across a refresh; only pin to their assigned company on
      // first load. Regular users are always pinned to their assigned company.
      if (!isSuperAdminUser || !selectedCompanyId) {
        selectedCompanyId = loggedUser.companyId;
      }
    }

    const companySetup = companies.find((c: any) => c.id === selectedCompanyId) || companies[0] || prev.companySetup;
    
    const merged = {
      ...prev,
      companies,
      // See src/db/schema.ts's roleTemplates/companyOnboardingRequests comments — both
      // are global/cross-tenant, already hard-emptied server-side (server.ts's /api/state
      // filteredState) for anyone but a real super-admin, so no client-side filtering
      // needed here, unlike every company-scoped field below.
      roleTemplates: data.roleTemplates || [],
      companyOnboardingRequests: data.companyOnboardingRequests || [],
      deletedCompanyLog: data.deletedCompanyLog || [],
      users,
      quotations: data.quotations || [],
      invoices: data.invoices || [],
      expenses: data.expenses || [],
      recurringTemplates: data.recurringTemplates || [],
      recurringPostings: data.recurringPostings || [],
      vouchers: data.vouchers || [],
      investors: data.investors || [],
      customers: data.customers || [],
      vendors: data.vendors || [],
      products: data.products || [],
      banks: data.banks || [],
      months: data.months || [],
      templates: data.templates || [],
      translations: data.translations || [],
      posShifts: data.posShifts || [],
      posHeldInvoices: data.posHeldInvoices || [],
      // Inventory & Procurement — previously absent from this merge entirely, so this
      // whole slice only ever reflected local optimistic appends made during the current
      // browser session (InventoryModule.tsx's own onUpdateDbLocal calls after each
      // create action) and reverted to empty on every full reload, even though the real
      // data was always correctly saved and correctly scoped server-side. A user create a
      // GRN, then a real page reload (a crash, or just F5) silently wiped it from view.
      warehouses: data.warehouses || [],
      purchaseRequisitions: data.purchaseRequisitions || [],
      purchaseOrders: data.purchaseOrders || [],
      goodsReceiptNotes: data.goodsReceiptNotes || [],
      inventoryStocks: data.inventoryStocks || [],
      purchaseBills: data.purchaseBills || [],
      purchaseReturns: data.purchaseReturns || [],
      physicalStockTakes: data.physicalStockTakes || [],
      warehouseDispatches: data.warehouseDispatches || [],
      warehouseReceivings: data.warehouseReceivings || [],
      productCategories: data.productCategories || [],
      unitsOfMeasure: data.unitsOfMeasure || [],
      productUnitConversions: data.productUnitConversions || [],
      productWarehouses: data.productWarehouses || [],
      jobTitles: data.jobTitles || [],
      employees: data.employees || [],
      // Same gap, same fix — Roles/RBAC and per-company tax slabs were also never copied
      // from the server response here, so `db.taxSlabs` stayed pinned to dbStore.ts's
      // hardcoded SEED_TAX_SLABS default forever (never the company's real slabs), and
      // db.roles/userRoles stayed permanently empty on every fresh load.
      taxSlabs: data.taxSlabs || [],
      roles: data.roles || [],
      userRoles: data.userRoles || [],
      branches: data.branches || [],
      userBranches: data.userBranches || [],
      modifierGroups: data.modifierGroups || [],
      currentUser: loggedUser || prev.currentUser,
      selectedCompanyId,
      companySetup,
    };

    setCloudError(null);
    return merged;
  });
  }
  setDbLoaded(true);
  }).catch(err => {
  console.error('Failed to load from Postgres:', err);
  if (err?.message !== 'Unauthorized') {
    setCloudError('Unable to connect to PostgreSQL database server. Retrying...');
  }
  setDbLoaded(true);
  });
 }, [sessionUserId]);
 const [activeTab, setActiveTab] = React.useState<string>('dashboard');
 const [mobileMenuOpen, setMobileMenuOpen] = React.useState<boolean>(false);

 const [cloudSyncing, setCloudSyncing] = React.useState<boolean>(true);
 const [cloudError, setCloudError] = React.useState<string | null>(null);
 const [lastSyncTimes, setLastSyncTimes] = React.useState<{meta: string | null, invoices: string | null, quotations: string | null, expenses: string | null}>({meta: null, invoices: null, quotations: null, expenses: null, vouchers: null});
 const [mismatchData, setMismatchData] = React.useState<{
 localUsersCount: number;
 cloudUsersCount: number;
 missingLocalInCloud: string[];
 missingCloudInLocal: string[];
 cloudDb: DatabaseState;
 } | null>(null);



  const triggerDbRefresh = async () => {
    if (!sessionUserId) return;
    try {
      // Deliberately no ?companyId= here. `db` in this closure can be stale relative to
      // the caller's own just-applied setDb() (e.g. the company switcher calls
      // setDb(...) then awaits this in the same handler, before the new state has
      // actually re-rendered) - passing a stale selectedCompanyId would override the
      // session with the *previous* company right after switch-company just correctly
      // updated it. The session (updated by POST /api/switch-company before any switch,
      // and at login otherwise) is the reliable source of truth; no query param needed.
      const r = await fetch('/api/state');
      if (r.ok) {
        const data = await r.json();
        if (data && data.users) {
          setDb(prev => {
            const users = data.users || [];
            const companies = data.companies || [];
            const loggedUser = users.find((u: any) => u.id === sessionUserId);
            let selectedCompanyId = prev.selectedCompanyId;
            if (loggedUser) {
              const isSuperAdminUser = loggedUser.isSuperAdmin === true || loggedUser.role === 'super-admin' || loggedUser.role === 'superadmin';
              if (!isSuperAdminUser || !selectedCompanyId) {
                selectedCompanyId = loggedUser.companyId;
              }
            }
            const merged = {
              ...prev,
              companies,
              // See the matching comment in the initial-load effect above — same gap,
              // same fix: both are global/cross-tenant and already hard-emptied
              // server-side for anyone but a real super-admin.
              roleTemplates: data.roleTemplates || [],
              companyOnboardingRequests: data.companyOnboardingRequests || [],
              deletedCompanyLog: data.deletedCompanyLog || [],
              users,
              quotations: data.quotations || [],
              invoices: data.invoices || [],
              expenses: data.expenses || [],
              recurringTemplates: data.recurringTemplates || [],
              recurringPostings: data.recurringPostings || [],
              vouchers: data.vouchers || [],
              investors: data.investors || [],
              customers: data.customers || [],
              vendors: data.vendors || [],
              products: data.products || [],
              banks: data.banks || [],
              months: data.months || [],
              templates: data.templates || [],
              translations: data.translations || [],
              posShifts: data.posShifts || [],
              posHeldInvoices: data.posHeldInvoices || [],
              // See the matching comment in the initial-load effect above — same gap,
              // same fix, this is the refresh path fired after most create/update actions.
              warehouses: data.warehouses || [],
              purchaseRequisitions: data.purchaseRequisitions || [],
              purchaseOrders: data.purchaseOrders || [],
              goodsReceiptNotes: data.goodsReceiptNotes || [],
              inventoryStocks: data.inventoryStocks || [],
              purchaseBills: data.purchaseBills || [],
              purchaseReturns: data.purchaseReturns || [],
              physicalStockTakes: data.physicalStockTakes || [],
              warehouseDispatches: data.warehouseDispatches || [],
              warehouseReceivings: data.warehouseReceivings || [],
              productCategories: data.productCategories || [],
              unitsOfMeasure: data.unitsOfMeasure || [],
              // Same gap already fixed once for this exact refresh path (see the comment
              // above this block) — productUnitConversions was missed here specifically
              // because this block's indentation differs from the initial-load effect's,
              // so an earlier exact-string replace_all only patched that one, not this one.
              productUnitConversions: data.productUnitConversions || [],
              productWarehouses: data.productWarehouses || [],
              jobTitles: data.jobTitles || [],
              employees: data.employees || [],
              taxSlabs: data.taxSlabs || [],
              roles: data.roles || [],
              userRoles: data.userRoles || [],
              branches: data.branches || [],
              userBranches: data.userBranches || [],
              modifierGroups: data.modifierGroups || [],
              currentUser: loggedUser || prev.currentUser,
              selectedCompanyId,
            };
            return merged;
          });
          setCloudError(null);
        }
      }
    } catch (err) {
      console.error('Failed to refresh DB state from Postgres:', err);
      setCloudError('Unable to synchronize with PostgreSQL server.');
    }
  };

  // Every actual write in this app now goes through its own dedicated /api/... REST
  // route (see server/routes/*.ts) — the full-blob POST /api/migrate sync this file used
  // to trigger on every write (an app-wide "save everything currently held in memory"
  // hazard) has no remaining callers as of this cleanup; removed along with it.
  //
  // Deliberately typed to accept ONLY an updater function, never a raw DatabaseState
  // object — this used to also accept a plain object, and nine separate call sites across
  // InvoiceModule/QuotationModule/PosModule exploited that by handing this a RAW,
  // unmerged `GET /api/state` JSON response directly. That response has no
  // selectedCompanyId/companySetup/currentUser field at all (those only exist because
  // this exact merge derives them on initial load), so every one of those calls silently
  // wiped the active-company selection and the logged-in user out of `db` the instant it
  // ran — confirmed live: resubmitting an invoice to ZATCA reset the company selector to
  // the first company in the list. Restricting the type to a function forces every caller
  // to write `prev => ({ ...prev, someField: newValue })` — a scoped patch that can never
  // drop a field it didn't explicitly touch — and makes the old raw-object call shape a
  // compile error instead of a silent runtime data-loss bug. If this ever fails to
  // compile elsewhere in the app, that call site has the same bug and needs the same fix,
  // not a cast back to the old signature.
  const handleUpdateDbLocal = (updater: (prev: DatabaseState) => DatabaseState) => {
    setDb(updater);
  };

  const activeDb = db;
  const currentUser = sessionUserId 
    ? (activeDb.users?.find(u => u.id === sessionUserId) || activeDb.currentUser)
    : undefined;
  const activeCompanySetup = activeDb.companies?.find(c => c.id === activeDb.selectedCompanyId) || activeDb.companySetup || {
    id: '',
    name: 'Company',
    currency: 'SAR',
    address: '',
    phone: '',
    email: '',
    vatNumber: '',
    isInventoryModuleEnabled: false,
  };

  React.useEffect(() => {
    if (activeCompanySetup?.themeId) {
      applyTheme(activeCompanySetup.themeId);
    }
  }, [activeCompanySetup?.themeId]);

  // Single-column persistence for two real, per-user/per-company settings — a targeted
  // PATCH, not a full-blob rewrite of every table in the company just to flip one field.
  // Local state updates immediately (optimistic); a failed PATCH surfaces via the
  // existing cloudError banner.
  const handleThemeChange = (themeId: string) => {
    const companyId = db.selectedCompanyId;
    const updatedCompanySetup = { ...activeCompanySetup, themeId };
    setDb(prev => ({
      ...prev,
      companySetup: updatedCompanySetup,
      companies: prev.companies?.map(c => c.id === companyId ? updatedCompanySetup : c) || [updatedCompanySetup]
    }));
    fetch(`/api/companies/${companyId}/theme`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ themeId })
    }).then(async res => {
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `status ${res.status}`);
      }
      setCloudError(null);
    }).catch(err => {
      console.error('Error saving theme:', err);
      setCloudError('Warning: theme change could not be saved. Please try again.');
    });
  };

  const handleLanguageChange = (uiLanguage: 'en' | 'ar' | 'ur') => {
    setDb(prev => ({
      ...prev,
      users: prev.users.map(u => u.id === currentUser?.id ? { ...u, uiLanguage } : u),
      currentUser: prev.currentUser ? { ...prev.currentUser, uiLanguage } : prev.currentUser
    }));
    fetch('/api/users/me/language', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uiLanguage })
    }).then(async res => {
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `status ${res.status}`);
      }
      setCloudError(null);
    }).catch(err => {
      console.error('Error saving language:', err);
      setCloudError('Warning: language change could not be saved. Please try again.');
    });
  };

  const [printDoc, setPrintDoc] = React.useState<{
    type: 'Quotation' | 'Invoice' | 'Expense' | 'Voucher' | 'PaymentReceipt' | 'Ledger' | 'Report' | 'WarehouseDispatch' | 'WarehouseReceiving';
    data: any;
  } | null>(null);

  // Cross-cutting "which record is being edited" state for the List/Add page-split
  // pattern: a List row's Edit action sets this, then navigates to the module's
  // '-add' tab; the Add page reads it back to know whether it's creating or editing.
  const [editTarget, setEditTarget] = React.useState<{ module: string; id: string } | null>(null);

  // Same shape/role as editTarget, for the invoice View screen — set right before
  // navigating to 'invoices-view' (post-create, or a list row's own View link).
  const [viewTarget, setViewTarget] = React.useState<{ id: string } | null>(null);

  // Whichever transactional form is currently open reports its own live dirty state here
  // (via onDirtyChange, see useDirtyGuard in hooks.ts) so handleNavigate — the single
  // choke point nearly all navigation already funnels through — can warn before
  // discarding in-progress work. A ref, not state: it's read synchronously inside
  // handleNavigate/beforeunload and doesn't need to trigger a re-render on its own.
  const isCurrentFormDirtyRef = React.useRef(false);

  React.useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isCurrentFormDirtyRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const [settingsTab, setSettingsTab] = React.useState<string>('company');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = React.useState<boolean>(false);
  const [showChangePasswordModal, setShowChangePasswordModal] = React.useState<boolean>(false);
  const [navSearchQuery, setNavSearchQuery] = React.useState<string>('');
  const { t, isRTL, lang } = useTranslation(db);
  // Every nav group starts collapsed at login — a group only opens once explicitly
  // toggled, searched, or it contains the current page (see isGroupExpanded below).
  const [expandedNavGroups, setExpandedNavGroups] = React.useState<Record<string, boolean>>({});

  // The root <div dir={isRTL ? "rtl" : "ltr"}> below correctly drives RTL layout for
  // everything React renders, but <html lang> lives in index.html, outside React's
  // reach — it stayed hardcoded to "en" regardless of the selected language. That
  // attribute is what screen readers, spell-check, and the browser's own
  // font-selection/translation-offer heuristics actually key off, not the nested div's
  // dir attribute, so it needs to be kept in sync separately.
  React.useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = isRTL ? 'rtl' : 'ltr';
  }, [lang, isRTL]);

  const handleLogout = () => {
    fetch('/api/logout', { method: 'POST' }).catch(() => null);
    localStorage.removeItem('erp_session_user_id');
    localStorage.removeItem('erp_session_id');
    localStorage.removeItem('currentUser');
    localStorage.removeItem('sessionId');
    setSessionUserId(null);
    setDb(prev => {
      const newDb = { ...prev, currentUser: undefined };
      saveDatabase(newDb);
      return newDb;
    });
  };

  const handleViewAnotherDoc = (type: string, id: string) => {
    if (type === 'Invoice') {
      const inv = activeDb.invoices?.find(i => i.invoiceNumber === id);
      if (inv) setPrintDoc({ type: 'Invoice', data: inv });
    } else if (type === 'Quotation') {
      const q = activeDb.quotations?.find(q => q.quotationNumber === id);
      if (q) setPrintDoc({ type: 'Quotation', data: q });
    } else if (type === 'Expense') {
      const e = activeDb.expenses?.find(e => e.expenseNumber === id);
      if (e) setPrintDoc({ type: 'Expense', data: e });
    } else if (type === 'Voucher') {
      const v = activeDb.vouchers?.find(v => v.voucherNumber === id);
      if (v) setPrintDoc({ type: 'Voucher', data: v });
    }
  };

  if (resetToken) {
    return (
      <ResetPasswordScreen
        token={resetToken}
        onDone={() => {
          const url = new URL(window.location.href);
          url.searchParams.delete('resetToken');
          window.history.replaceState({}, '', url.toString());
          setResetToken(null);
        }}
        lang={preLoginLang}
        onLangChange={handlePreLoginLangChange}
        db={db}
      />
    );
  }

  if (onboard) {
    return (
      <CompanyOnboardingScreen
        lang={preLoginLang}
        onLangChange={handlePreLoginLangChange}
        db={db}
        onBackToLogin={() => {
          const url = new URL(window.location.href);
          url.searchParams.delete('onboard');
          window.history.replaceState({}, '', url.toString());
          setOnboard(null);
        }}
      />
    );
  }

  if (!dbLoaded) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-indigo-50/30">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <LoginScreen
        lang={preLoginLang}
        onLangChange={handlePreLoginLangChange}
        db={db}
        onLoginSuccess={(loggedUser) => {
          localStorage.setItem('erp_session_user_id', loggedUser.id);
          setSessionUserId(loggedUser.id);
          
          setDb(prev => {
             const foundUser = prev.users?.find(u => u.id === loggedUser.id) || loggedUser;
             const hasUser = prev.users?.some(u => u.id === loggedUser.id);
             
             const selectedId = foundUser.companyId;
             const compSetup = prev.companies?.find(c => c.id === selectedId) || prev.companySetup;
             
             const newDb = { 
               ...prev, 
               currentUser: foundUser,
               selectedCompanyId: selectedId,
               companySetup: compSetup,
               users: hasUser ? prev.users : [...(prev.users || []), loggedUser]
             };
             saveDatabase(newDb);
             return newDb;
          });
        }}
        onGoToSignup={() => {
          const url = new URL(window.location.href);
          url.searchParams.set('onboard', '1');
          window.history.replaceState({}, '', url.toString());
          setOnboard('1');
        }}
        />
    );
  }

  // An admin-set password (including the 123456 default on a new account) forces this
  // screen before anything else — no nav, no data fetch, until the user sets their own.
  if ((currentUser as any).mustChangePassword) {
    return (
      <ChangePasswordScreen
        variant="forced"
        db={db}
        onSuccess={() => {
          setDb(prev => ({
            ...prev,
            currentUser: prev.currentUser ? { ...prev.currentUser, mustChangePassword: false } as any : prev.currentUser,
          }));
        }}
      />
    );
  }

  const isAdmin = currentUser?.role === 'admin' || currentUser?.isSuperAdmin === true;
  const isSuperAdmin = currentUser?.isSuperAdmin === true;
  // Pending company-onboarding requests needing review — super-admin only, since only a
  // super-admin can act on them (server/routes/onboarding.ts). GET /api/state already
  // hard-empties this array for anyone else (server.ts), so this is safe even before the
  // isSuperAdmin check below.
  const pendingOnboardingCount = isSuperAdmin
    ? (db.companyOnboardingRequests || []).filter((r: any) => r.status === 'Pending').length
    : 0;
  const { can } = usePermissions(currentUser);
  // A nav entry can require any ONE of several permissions (e.g. the Settings shell is
  // reachable if the actor holds *any* delegable settings-adjacent permission, not one
  // specific leaf) — admins already pass every individual `can()` check via
  // normalizePermissions' own isAdmin bypass, so this needs no separate isAdmin branch.
  const canAny = (key: string | string[]): boolean => Array.isArray(key) ? key.some(k => can(k)) : can(key);
  // Every permission that unlocks at least one Settings sub-tab (AdminSettings.tsx's own
  // CATEGORY_GROUPS gates each sub-tab individually with the matching leaf) - the
  // Settings shell itself just needs to know whether *any* of them apply, so a delegated
  // non-admin actor sees the nav entry at all. Company Profile/ZATCA/Roles/Companies
  // Directory/Translations/Database stay admin-tier-only by design and are deliberately
  // not in this list - see permission-crud-model skill.
  const SETTINGS_ACCESS_PERMISSIONS = [
    'banks.read', 'taxSlabs.read', 'templates.read', 'users.read',
    'investors.access', 'fiscalMonths.open', 'fiscalMonths.close',
  ];
 const openMonth = getActiveOpenMonth(activeDb);
 // Up to 3 fiscal months may be open concurrently now; openMonth is just the oldest
 // (the only one currently closable). Surface the total count alongside it.
 const openMonthsCount = getOpenMonths(activeDb).length;

 // Sidebar navigation options (Admin vs User restrictions) grouped into standard ERP sections
 type NavItem = {
  id: string;
  label: string;
  icon: any;
  adminOnly: boolean;
  permissionKey?: string | string[];
  subItems?: {
    id: string;
    label: string;
    permissionKey?: string | string[];
    adminOnly?: boolean;
  }[];
};

type NavSection = {
  title: string;
  items: NavItem[];
};

  const navSections: NavSection[] = [
    {
      title: t('Operations & Commerce'),
      items: [
        { id: 'dashboard', label: t('Command Center'), icon: LayoutDashboard, adminOnly: false },
        { 
          id: 'pos', label: t('Point of Sale (POS)'), icon: ShoppingCart, adminOnly: false, permissionKey: 'pos',
          subItems: [
            { id: 'pos-terminal', label: t('Terminal'), permissionKey: 'pos.terminal' },
            { id: 'pos-shifts', label: t('Shifts & Z-Reports'), permissionKey: 'pos.shifts' },
            { id: 'pos-history', label: t('Sales History'), permissionKey: 'pos.history' }
          ]
        },
        {
          id: 'sales', label: t('Sales & Receivables'), icon: FileText, adminOnly: false,
          subItems: [
            { id: 'quotations', label: t('Quotation Book'), permissionKey: 'sales.quotation' },
            { id: 'quotations-add', label: t('New Quotation'), permissionKey: 'quotation.create' },
            { id: 'invoices', label: t('Sales Invoices'), permissionKey: 'sales.invoice' },
            { id: 'invoices-add', label: t('New Invoice'), permissionKey: 'invoice.create' }
          ]
        },
        {
          id: 'procurement', label: t('Procurements'), icon: TrendingDown, adminOnly: false,
          subItems: [
            { id: 'expenses', label: t('Expenses'), permissionKey: 'expense.read' },
            { id: 'expenses-add', label: t('New Expense'), permissionKey: 'expense.create' },
            { id: 'recurring', label: t('Recurring & Accruals'), adminOnly: true }
          ]
        }
      ]
    },
    // Visibility is purely permission-driven (inventory.access/.pr/.po/.grn/.stock) — no
    // company-level "module enabled" gate anymore. There used to be one
    // (isInventoryModuleEnabled), but it had no admin bypass, unlike every permission check
    // in normalizePermissions(), so it silently hid this whole section from super-admins
    // too whenever a company's flag defaulted to off. Removed rather than patched with a
    // bypass, per explicit product decision — the permission system alone is the source of
    // truth for what's visible now, same as every other module.
    ...[
      {
        title: t('Inventory Management'),
        items: [
          {
            id: 'inventory',
            label: t('Inventory System'),
            icon: Boxes,
            adminOnly: false,
            permissionKey: 'inventory.access',
            subItems: [
              { id: 'inventory-pr', label: t('Purchase Requisitions'), permissionKey: 'inventory.pr' },
              { id: 'inventory-po', label: t('Purchase Orders'), permissionKey: 'inventory.po' },
              { id: 'inventory-grn', label: t('Goods Receipt (GRN)'), permissionKey: 'inventory.grn' },
              { id: 'inventory-stock', label: t('Stock Registry'), permissionKey: 'inventory.stock' },
              { id: 'inventory-bills', label: t('Purchase Bills'), permissionKey: 'purchaseBills.read' },
              { id: 'inventory-returns', label: t('Purchase Returns'), permissionKey: 'purchaseReturns.read' },
              { id: 'inventory-stocktakes', label: t('Physical Stock Takes'), permissionKey: 'stockTakes.read' },
              { id: 'inventory-dispatch', label: t('Warehouse Dispatch'), permissionKey: 'warehouseDispatches.read' },
              { id: 'inventory-receiving', label: t('Warehouse Receiving'), permissionKey: 'warehouseReceivings.read' }
            ]
          }
        ]
      }
    ],
    {
      title: t('Master Registries'),
      // Three category accordions instead of one flat 12-entry list — same reasoning and
      // pattern as the Intelligence & Reports restructuring above: group by what the data
      // actually represents (who you trade with / what you sell / where it lives) so a
      // role only ever scans the categories, and the entries inside them, it actually has.
      items: [
        {
          id: 'registries-partners', label: t('Trading Partners'), icon: FolderTree, adminOnly: false,
          subItems: [
            { id: 'customers', label: t('Customers CRM'), permissionKey: 'customers.read' },
            { id: 'customers-add', label: t('New Customer'), permissionKey: 'customers.create' },
            { id: 'vendors', label: t('Vendors Directory'), permissionKey: 'vendors.read' },
            { id: 'vendors-add', label: t('New Vendor'), permissionKey: 'vendors.create' }
          ]
        },
        {
          id: 'registries-catalog', label: t('Product Catalog'), icon: FolderTree, adminOnly: false,
          subItems: [
            { id: 'products', label: t('Products & Pricing'), permissionKey: 'products.read' },
            { id: 'products-add', label: t('New Product'), permissionKey: 'products.create' },
            { id: 'categories', label: t('Product Categories'), permissionKey: 'categories.read' },
            { id: 'categories-add', label: t('New Category'), permissionKey: 'categories.create' },
            { id: 'units', label: t('Units of Measure'), permissionKey: 'units.read' },
            { id: 'units-add', label: t('New Unit'), permissionKey: 'units.create' },
            { id: 'modifier-groups', label: t('Modifier Groups'), permissionKey: 'modifierGroups.read' },
            { id: 'modifier-groups-add', label: t('New Modifier Group'), permissionKey: 'modifierGroups.create' }
          ]
        },
        {
          id: 'registries-warehouses', label: t('Warehouses'), icon: FolderTree, adminOnly: false,
          subItems: [
            { id: 'warehouses', label: t('Physical Warehouses'), permissionKey: 'warehouses.read' },
            { id: 'warehouses-add', label: t('New Warehouse'), permissionKey: 'warehouses.create' }
          ]
        }
      ]
    },
    {
      title: t('Human Resources'),
      // Its own top-level group, not squeezed into Master Registries — HR is a distinct
      // bounded context this app has never had, and a future Timekeeping/Attendance
      // module will grow into this same group, same reasoning Inventory Management
      // already got its own top-level section.
      items: [
        {
          id: 'hr-employees', label: t('Employees'), icon: Briefcase, adminOnly: false,
          subItems: [
            { id: 'employees', label: t('Employees'), permissionKey: 'employees.read' },
            { id: 'employees-add', label: t('New Employee'), permissionKey: 'employees.create' },
            { id: 'job-titles', label: t('Job Titles'), permissionKey: 'jobTitles.read' },
            { id: 'job-titles-add', label: t('New Job Title'), permissionKey: 'jobTitles.create' }
          ]
        }
      ]
    },
    {
      title: t('Intelligence & Reports'),
      // Four category accordions, not one long flat list — a flat list would have grown
      // to 24 individual entries as the report catalog expanded, easily the longest
      // section in the sidebar and far harder to scan than any other group. Each category
      // is its own accordion parent (same pattern as Inventory Management above: the
      // parent is a togglable label only, every real destination is a subItem,
      // individually permission-gated) so a role only ever sees the categories — and the
      // reports inside them — they actually have access to.
      items: [
        {
          id: 'reports', label: t('Financial Reports'), icon: BarChart3, adminOnly: false,
          subItems: [
            { id: 'reports-trialbalance', label: t('Trial Balance Ledger'), permissionKey: 'reports.trialBalance' },
            { id: 'reports-salesvat', label: t('Sales VAT Register'), permissionKey: 'reports.salesVat' },
            { id: 'reports-purchasevat', label: t('Purchase VAT Register'), permissionKey: 'reports.purchaseVat' },
            { id: 'reports-bankledger', label: t('Bank Statement Ledger'), permissionKey: 'reports.bankLedger' },
            { id: 'reports-profitloss', label: t('Profit & Loss'), permissionKey: 'reports.profitLoss' },
            { id: 'reports-outstanding', label: t('Outstanding Aging & Balances'), permissionKey: 'reports.outstanding' },
            { id: 'reports-balancesheet', label: t('Balance Sheet'), permissionKey: 'reports.balanceSheet' },
            { id: 'reports-vatreturn', label: t('VAT Return Summary'), permissionKey: 'reports.vatReturnSummary' },
            { id: 'reports-investorshare', label: t('Investor Profit Share'), permissionKey: 'reports.investorProfitShare' },
            { id: 'reports-monthclosing', label: t('Fiscal Month Closing History'), permissionKey: 'reports.fiscalMonthClosingHistory' }
          ]
        },
        {
          id: 'reports-sales', label: t('Sales Reports'), icon: FileText, adminOnly: false,
          subItems: [
            { id: 'reports-salesregister', label: t('Sales Register'), permissionKey: 'reports.salesRegister' },
            { id: 'reports-itemsales', label: t('Item-wise Sales Report'), permissionKey: 'reports.itemWiseSales' },
            { id: 'reports-customerstatement', label: t('Customer Statement of Account'), permissionKey: 'reports.customerStatement' },
            { id: 'reports-quotationconversion', label: t('Quotation Conversion Report'), permissionKey: 'reports.quotationConversion' },
            { id: 'reports-salesbystaff', label: t('Sales by Staff'), permissionKey: 'reports.salesByStaff' },
            { id: 'reports-posshiftsummary', label: t('POS Shift Summary'), permissionKey: 'reports.posShiftSummary' }
          ]
        },
        {
          id: 'reports-purchase', label: t('Purchase Reports'), icon: TrendingDown, adminOnly: false,
          subItems: [
            { id: 'reports-purchaseregister', label: t('Purchase Register'), permissionKey: 'reports.purchaseRegister' },
            { id: 'reports-vendorstatement', label: t('Vendor Statement of Account'), permissionKey: 'reports.vendorStatement' },
            { id: 'reports-postatus', label: t('Purchase Order Status Report'), permissionKey: 'reports.poStatus' },
            { id: 'reports-grnvariance', label: t('GRN vs. PO Variance'), permissionKey: 'reports.grnPoVariance' }
          ]
        },
        {
          id: 'reports-inventory', label: t('Inventory Reports'), icon: Boxes, adminOnly: false,
          subItems: [
            { id: 'reports-stockvaluation', label: t('Stock Valuation Report'), permissionKey: 'reports.stockValuation' },
            { id: 'reports-itemprofitability', label: t('Item Profitability Report'), permissionKey: 'reports.itemProfitability' },
            { id: 'reports-lowstock', label: t('Low Stock / Reorder Report'), permissionKey: 'reports.lowStock' },
            { id: 'reports-stocktakevariance', label: t('Stock Take Variance History'), permissionKey: 'reports.stockTakeVarianceHistory' },
            { id: 'reports-stockmovementledger', label: t('Stock Movement Ledger'), permissionKey: 'reports.stockMovementLedger' },
            { id: 'reports-warehousetransferreconciliation', label: t('Warehouse Transfer Reconciliation'), permissionKey: 'reports.warehouseTransferReconciliation' }
          ]
        }
      ]
    },
    {
      title: t('Setup & Governance'),
      items: [
        { id: 'settings', label: t('Settings & Companies'), icon: Settings, adminOnly: false, permissionKey: SETTINGS_ACCESS_PERMISSIONS }
      ]
    }
  ];


  // Accordion bookkeeping: every group-header id (a nav item with subItems), and a
  // subItem-id -> owning-group-id lookup, both derived from navSections so they never
  // drift out of sync with the actual menu structure defined above.
  const allNavGroupIds = navSections.flatMap(s => s.items.filter(i => i.subItems && i.subItems.length > 0).map(i => i.id));
  const subItemToGroupId: Record<string, string> = {};
  navSections.forEach(s => s.items.forEach(i => {
    if (i.subItems) i.subItems.forEach(sub => { subItemToGroupId[sub.id] = i.id; });
  }));

  // Page header title for every report nav id, derived from the same subItems' own
  // labels above — the report catalog is now 24 entries across 4 categories, so this is
  // generated from the single source of truth (the nav definition) instead of a second
  // hand-maintained ternary chain that could silently drift from the actual menu labels.
  const REPORT_NAV_TITLES: Record<string, string> = {};
  navSections.forEach(s => s.items.forEach(i => {
    if (i.id.startsWith('reports') && i.subItems) {
      i.subItems.forEach(sub => { REPORT_NAV_TITLES[sub.id] = sub.label; });
    }
  }));

  // One-line subtitle per report, shown under the page title. Hand-written (not derived
  // from the nav label) since a subtitle needs to say more than the title already does.
  const REPORT_NAV_DESCRIPTIONS: Record<string, string> = {
    'reports-trialbalance': t('Company-wide debits and credits, balanced across every ledger account.'),
    'reports-salesvat': t('Output VAT collected on sales, itemised per invoice.'),
    'reports-purchasevat': t('Input VAT paid on purchases, itemised per expense.'),
    'reports-bankledger': t('Running balance and transaction history per bank account.'),
    'reports-profitloss': t('Revenue, expenses, and net profit for the selected period.'),
    'reports-outstanding': t('Aging customer receivables and vendor payables still open.'),
    'reports-balancesheet': t('Assets, liabilities, and equity as of a chosen date.'),
    'reports-vatreturn': t('Net VAT payable or refundable — Output VAT minus Input VAT for a filing period.'),
    'reports-investorshare': t("Each investor's profit-share allocation for the selected period."),
    'reports-monthclosing': t('Locked profit & loss snapshots from every closed fiscal month.'),
    'reports-salesregister': t('Every sales invoice in a period, with status and payment detail.'),
    'reports-itemsales': t('Quantity sold and revenue earned per product.'),
    'reports-customerstatement': t('Running balance of invoices and payments for one customer.'),
    'reports-quotationconversion': t('Quotations issued vs. converted into invoices — your sales conversion rate.'),
    'reports-salesbystaff': t('Revenue generated per salesperson.'),
    'reports-posshiftsummary': t('Cash vs. bank sales and cash variance per POS shift.'),
    'reports-purchaseregister': t('Every purchase expense in a period, by vendor and category.'),
    'reports-vendorstatement': t('Running balance of bills and payments for one vendor.'),
    'reports-postatus': t("Purchase orders by fulfillment status, with aging on what's still open."),
    'reports-grnvariance': t('Ordered vs. actually received quantity, per purchase order line.'),
    'reports-stockvaluation': t('On-hand quantity valued at average cost, per product and warehouse.'),
    'reports-itemprofitability': t('Average sale price vs. average cost margin, per product.'),
    'reports-lowstock': t('Products below their configured reorder level, per warehouse.'),
    'reports-stocktakevariance': t('Over/under counts from every completed physical stock take.'),
    'reports-stockmovementledger': t('Every posted in/out stock movement, chronologically, with a running ending quantity.'),
  };

  // Accordion: opening a group collapses every other group first, so only one section's
  // subItems are ever expanded at once — keeps the sidebar from growing tall with every
  // section left open. Closing the currently-open group just closes it.
  const toggleNavGroup = (id: string) => {
    setExpandedNavGroups(prev => {
      const isCurrentlyOpen = prev[id] === true;
      if (isCurrentlyOpen) {
        return { ...prev, [id]: false };
      }
      const next: Record<string, boolean> = {};
      allNavGroupIds.forEach(gid => { next[gid] = false; });
      next[id] = true;
      return next;
    });
  };

  // Flattened { tabId -> { permissionKey?, adminOnly? } } built from navSections — the
  // same table that already drives sidebar link visibility, reused here so both the
  // link and the actual page content are gated by one source of truth instead of two.
  // Deliberately NOT a hook (no React.useMemo) — this component has early `return`s
  // above (dbLoaded/currentUser checks) that a hook here would sit after, which breaks
  // the Rules of Hooks. navSections itself is already recomputed every render, so this
  // plain recomputation costs nothing extra.
  const tabPermissionMap = (() => {
    const map = new Map<string, { permissionKey?: string | string[]; adminOnly?: boolean }>();
    for (const section of navSections) {
      for (const item of section.items) {
        map.set(item.id, { permissionKey: item.permissionKey, adminOnly: item.adminOnly });
        if (item.subItems) {
          for (const sub of item.subItems) {
            map.set(sub.id, { permissionKey: sub.permissionKey, adminOnly: sub.adminOnly });
          }
        }
      }
    }
    return map;
  })();

  const isTabAllowed = (tabId: string): boolean => {
    const entry = tabPermissionMap.get(tabId);
    if (!entry) return true;
    if (entry.adminOnly && !isAdmin) return false;
    if (entry.permissionKey && !canAny(entry.permissionKey)) return false;
    return true;
  };

  // `preserveEditTarget` defaults to false so any generic navigation (sidebar clicks,
  // Cancel/Done handlers, "Create New" buttons) clears a stale edit target; only the
  // explicit onEdit path (below) passes true to carry the target across the navigate.
  const handleNavigate = (tabId: string, preserveEditTarget: boolean = false) => {
 if (isCurrentFormDirtyRef.current) {
   if (!window.confirm(t('You have unsaved changes. Leave without saving?'))) return;
   isCurrentFormDirtyRef.current = false;
 }
 const resolvedTabId = tabId.startsWith('settings-') ? 'settings' : tabId;
 if (!isTabAllowed(resolvedTabId)) return;
 // The main content area scrolls at the window/document level (no inner overflow
 // container — see <main> at the render below), and remounting the `key={activeTab}`
 // subtree does not reset that scroll position on its own. Without this, saving a long
 // form while scrolled down (e.g. Add Product) lands on the next page's content at the
 // same scroll offset, leaving its own success banner off-screen above the fold.
 window.scrollTo({ top: 0, behavior: 'smooth' });
 // Every module below (InvoiceModule, QuotationModule, MasterEntities, etc.) renders
 // straight off the App-level `db` prop and has no fetch-on-mount of its own — `db` is
 // only ever populated from the server at initial login and via triggerDbRefresh() calls
 // sprinkled after specific write actions. Before this call, clicking a left-nav item
 // only flipped local UI state (activeTab/editTarget/accordion) and reused whatever `db`
 // already held, so a record created elsewhere (another branch/user, or out-of-band)
 // stayed invisible until a full browser reload re-ran that one-time initial fetch —
 // confirmed live: a freshly-created invoice didn't appear in the Invoices list until F5.
 // Fire-and-forget: navigation must stay instant, and every render below already
 // tolerates `db` updating a moment after mount (that's exactly how triggerDbRefresh
 // already works everywhere else it's called).
 triggerDbRefresh();
 if (!preserveEditTarget) setEditTarget(null);
 if (tabId !== 'invoices-view') setViewTarget(null);
 if (tabId.startsWith('settings-')) {
 const sub = tabId.split('-')[1];
 setSettingsTab(sub);
 setActiveTab('settings');
 } else {
 if (tabId === 'settings') {
 setSettingsTab('company');
 }
 setActiveTab(tabId);
 }
 setMobileMenuOpen(false);

 // Accordion continued: navigating to a subItem keeps that subItem's own group open
 // (so the item you just clicked stays visible/selected) but collapses every other
 // group; navigating to a top-level leaf (Dashboard, Reports, Settings — none of
 // which own a subItem) collapses every group, since none of them need to stay open.
 const owningGroup = subItemToGroupId[tabId];
 setExpandedNavGroups(() => {
 const next: Record<string, boolean> = {};
 allNavGroupIds.forEach(gid => { next[gid] = gid === owningGroup; });
 return next;
 });
 };

 // Shared List/Add wiring for the six MasterEntities sub-tabs — each gets a
 // '<sub>' (List) and '<sub>-add' (Add/Edit) tab pair following the same
 // editTarget/onEdit pattern used for Quotations/Invoices/Expenses.
 const renderMasterEntities = (sub: 'customers' | 'vendors' | 'products' | 'categories' | 'units' | 'warehouses') => (
 <MasterEntities
 db={activeDb}
 onUpdateDbLocal={handleUpdateDbLocal}
 forceSubTab={sub}
 mode={activeTab === `${sub}-add` ? 'add' : 'list'}
 editId={editTarget?.module === sub ? editTarget.id : undefined}
 onDone={() => handleNavigate(sub)}
 onEdit={(id) => { setEditTarget({ module: sub, id }); handleNavigate(`${sub}-add`, true); }}
 onCreateNew={() => handleNavigate(`${sub}-add`)}
 onDirtyChange={(dirty) => { isCurrentFormDirtyRef.current = dirty; }}
 />
 );

 return (
 <div dir={isRTL ? "rtl" : "ltr"} className="min-h-screen bg-indigo-50/30 text-slate-800 font-sans flex flex-col md:flex-row antialiased selection:bg-indigo-500/20">
 
 {/* MOBILE HEADER */}
 <header className="md:hidden bg-indigo-950 text-white p-4 flex justify-between items-center border-b border-slate-800 shrink-0 z-30">
 <div className="flex items-center gap-2">
 <img src={warraqMark} alt="Warraq" className="w-6 h-6 rounded-md shrink-0" />
 <span className="font-extrabold text-xs uppercase tracking-wider">{activeCompanySetup.portalTitle || 'Warraq'}</span>
 </div>
 <button
 onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
 className="p-1 hover:bg-slate-800 rounded-lg text-slate-300"
 >
 {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
 </button>
 </header>

 {/* SIDEBAR NAVIGATION */}
 <aside className={`
 fixed md:sticky top-0 bottom-0 start-0 z-40 
 ${isSidebarCollapsed ? 'md:w-[76px]' : 'md:w-[270px]'} w-[270px] bg-gradient-to-b from-indigo-950 via-slate-900 to-indigo-950 text-slate-300 border-e border-indigo-900/80 shadow-2xl 
 flex flex-col justify-between shrink-0 transition-all duration-300 ease-in-out
 ${mobileMenuOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
 `}>
 <div className="flex flex-col overflow-y-auto scrollbar-none">
 {/* Logo Brand Header & Collapse Toggle */}
 <div className="p-4 border-b border-indigo-900/50 flex items-center justify-between gap-2">
 <div className="flex items-center gap-2.5 min-w-0">
 <img src={warraqMark} alt="Warraq" className="w-9 h-9 rounded-lg shadow-md shadow-black/30 shrink-0" />
 {!isSidebarCollapsed && (
 <div className="min-w-0">
 <h1 className="font-extrabold text-xs uppercase text-white tracking-widest truncate">{activeCompanySetup.portalTitle || 'Warraq'}</h1>
 <span className="text-[9px] text-indigo-300/80 font-bold block uppercase tracking-wider truncate">{activeCompanySetup.portalSubtitle || 'ERP System'}</span>
 </div>
 )}
 </div>

 {/* Desktop Collapse Button */}
 <button
 onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
 className="hidden md:flex p-1.5 hover:bg-indigo-900/60 rounded-lg text-slate-400 hover:text-white transition-colors shrink-0 cursor-pointer"
 title={isSidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
 >
 {isSidebarCollapsed ? <PanelLeft className="w-4 h-4 text-indigo-400" /> : <PanelLeftClose className="w-4 h-4 text-slate-400" />}
 </button>
 </div>

 {/* Account row — identity (who's logged in) and Sign Out (how to leave) merged into
 one always-visible row right under the header, instead of splitting them across the
 top and the bottom of a nav list that can scroll taller than the viewport. */}
 {!isSidebarCollapsed ? (
 <div className="mx-3.5 mt-3 flex items-center gap-2 shrink-0">
 <div className="flex items-center gap-2 min-w-0 flex-1 bg-black/20 border border-indigo-900/40 rounded-xl px-2.5 py-1.5">
 <div className="p-1 bg-indigo-900/50 border border-indigo-700/50 rounded-lg text-indigo-300 shrink-0">
 <UserIcon className="w-3.5 h-3.5" />
 </div>
 <div className="min-w-0">
 <span className="text-[11px] font-extrabold text-white block truncate">{currentUser?.username}</span>
 <span className="text-[8px] font-bold text-indigo-400 uppercase tracking-wider block truncate">{currentUser?.role}</span>
 </div>
 </div>
 <button
 onClick={() => setShowChangePasswordModal(true)}
 className="p-2.5 bg-indigo-900/30 hover:bg-indigo-900/50 border border-indigo-800/40 text-indigo-300 rounded-xl transition-all cursor-pointer shrink-0"
 title={t('Change Password')}
 >
 <KeyRound className="w-3.5 h-3.5" />
 </button>
 <button
 onClick={handleLogout}
 className="p-2.5 bg-rose-950/30 hover:bg-rose-900/50 border border-rose-900/40 text-rose-300 rounded-xl transition-all cursor-pointer shrink-0"
 title={t('Sign Out')}
 >
 <LogOut className="w-3.5 h-3.5" />
 </button>
 </div>
 ) : (
 <div className="mt-3 flex flex-col items-center gap-1.5 shrink-0">
 <div className="p-2 bg-indigo-900/40 border border-indigo-700/40 rounded-xl text-indigo-300" title={`${currentUser?.username} (${currentUser?.role})`}>
 <UserIcon className="w-4 h-4" />
 </div>
 <button
 onClick={() => setShowChangePasswordModal(true)}
 className="mx-auto p-2 bg-indigo-900/40 hover:bg-indigo-900/60 border border-indigo-800/40 text-indigo-300 rounded-xl transition-all cursor-pointer shrink-0"
 title={t('Change Password')}
 >
 <KeyRound className="w-4 h-4" />
 </button>
 <button
 onClick={handleLogout}
 className="mx-auto p-2 bg-rose-950/40 hover:bg-rose-900/60 border border-rose-800/50 text-rose-300 rounded-xl transition-all cursor-pointer shrink-0"
 title={t('Sign Out')}
 >
 <LogOut className="w-4 h-4" />
 </button>
 </div>
 )}

 {/* Navigation Quick Search Filter (When Expanded) */}
 {!isSidebarCollapsed && (
 <div className="px-3.5 pt-3">
 <div className="relative">
 <Search className="w-3.5 h-3.5 text-slate-500 absolute start-3 top-1/2 -translate-y-1/2" />
 <input
 type="text"
 value={navSearchQuery}
 onChange={(e) => setNavSearchQuery(e.target.value)}
 placeholder={t("Filter menu...")}
 className="w-full bg-slate-950/60 border border-indigo-900/60 focus:border-indigo-500 text-slate-200 text-xs font-semibold rounded-xl ps-8 pe-7 py-1.5 focus:outline-none placeholder:text-slate-600 transition-all"
 />
 {navSearchQuery && (
 <button
 onClick={() => setNavSearchQuery('')}
 className="absolute end-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-xs font-bold"
 >
 ✕
 </button>
 )}
 </div>
 </div>
 )}

 {/* Company Selection Switcher / Restricted Info Badge */}
 {!isSidebarCollapsed ? (
 isSuperAdmin ? (
 <div className="px-3.5 py-2.5 border-b border-indigo-900/40 bg-black/20 my-2">
 <label htmlFor="company-select" className="text-[9px] font-extrabold text-slate-500 uppercase tracking-widest block mb-1 px-0.5">
 {t("Active Organization")}
 </label>
 <select
 id="company-select"
 value={activeDb.selectedCompanyId}
 onChange={async (e) => {
 const targetCompanyId = e.target.value;
 const targetCompSetup = db.companies?.find(c => c.id === targetCompanyId) || db.companySetup;
 setDb(prev => ({ ...prev, selectedCompanyId: targetCompanyId, companySetup: targetCompSetup }));
 // Persist the selection into the session so every other request (and every other
 // page/tab) honors it too — /api/state is now scoped per-company, not an unfiltered
 // blob, so switching companies genuinely needs a real refetch of that company's data.
 try {
 await fetch('/api/switch-company', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ companyId: targetCompanyId }),
 });
 } catch (err) {
 console.error('Failed to persist company switch:', err);
 }
 await triggerDbRefresh();
 }}
 className="w-full bg-indigo-950/50 border border-indigo-800/80 text-slate-200 text-xs font-bold rounded-xl px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-sans cursor-pointer hover:border-slate-700/60 transition-colors truncate"
 >
 {db.companies?.map(comp => (
 <option key={comp.id} value={comp.id}>
 {comp.name}
 </option>
 ))}
 </select>
 </div>
 ) : (
 <div className="px-3.5 py-2.5 border-b border-indigo-900/40 bg-black/20 my-2">
 <label className="text-[9px] font-extrabold text-slate-500 uppercase tracking-widest block mb-1 px-0.5">
 {t("Assigned Company")}
 </label>
 <div className="bg-black/20 border border-indigo-800/40 rounded-xl px-2.5 py-1.5 text-xs text-slate-300 font-bold tracking-wide truncate">
 🏢 {activeCompanySetup.name}
 </div>
 </div>
 )
 ) : (
 <div className="my-2 border-b border-indigo-900/40 pb-2 flex justify-center" title={`Active: ${activeCompanySetup.name}`}>
 <span className="w-8 h-8 rounded-xl bg-indigo-900/40 border border-indigo-700/40 flex items-center justify-center text-xs">
 🏢
 </span>
 </div>
 )}

 {/* Current Month Banner */}
 {!isSidebarCollapsed ? (
 <div className="mx-3.5 my-1.5 p-2.5 bg-black/30 rounded-xl border border-indigo-800/40 text-[11px] leading-relaxed">
 <span className="text-[9px] font-bold text-slate-500 uppercase block tracking-wider mb-0.5">{t("Fiscal Status")}</span>
 {openMonth ? (
 <span className="text-emerald-400 font-extrabold flex items-center gap-1.5">
 <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-ping"></span>
 <span className="truncate">{t("Month Open:")} {translateMonthLabel(openMonth.name, t)}{openMonthsCount > 1 ? ` (+${openMonthsCount - 1})` : ''}</span>
 </span>
 ) : (
 <span className="text-rose-400 font-bold flex items-center gap-1.5">
 <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {t("No Month Open")}
 </span>
 )}
 </div>
 ) : (
 <div className="my-1.5 flex justify-center" title={openMonth ? `${t("Month Open:")} ${translateMonthLabel(openMonth.name, t)}${openMonthsCount > 1 ? ` (+${openMonthsCount - 1} more)` : ''}` : t("No Month Open")}>
 <span className={`w-3 h-3 rounded-full ${openMonth ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`} />
 </div>
 )}

 {/* Navigation Links Grouped by Section */}
 <nav className={`${isSidebarCollapsed ? 'p-2 space-y-4' : 'p-3 space-y-4'}`}>
 {navSections.map(section => {
 // Filter out items in the section that are admin-only or restricted
 let visibleItems = section.items.filter(item => {
 if (item.adminOnly && !isAdmin) return false;
    const hasParentPermission = !item.permissionKey || canAny(item.permissionKey);

    let hasAccessToSubItem = false;
    if (item.subItems && item.subItems.length > 0) {
      hasAccessToSubItem = item.subItems.some(sub =>
        (!sub.adminOnly || isAdmin) &&
        (!sub.permissionKey || canAny(sub.permissionKey))
      );
    }

    if (!hasParentPermission && !hasAccessToSubItem) return false;
 return true;
 });

 // Apply quick search query filter if typed
 if (navSearchQuery.trim()) {
   const query = navSearchQuery.toLowerCase();
   visibleItems = visibleItems.filter(item => {
     const matchItem = item.label.toLowerCase().includes(query);
     const matchSub = item.subItems?.some(s => s.label.toLowerCase().includes(query));
     return matchItem || matchSub;
   });
 }

 if (visibleItems.length === 0) return null;

 return (
 <div key={section.title} className="space-y-1">
 {!isSidebarCollapsed && (
 <span className="text-[9px] font-extrabold text-slate-500 uppercase tracking-widest px-3 block mb-1">
 {section.title}
 </span>
 )}
 <div className="space-y-0.5">
 {visibleItems.map(item => {
                      const isQueryActive = navSearchQuery.trim().length > 0;
                      const hasSubItems = item.subItems && item.subItems.length > 0;

                      // Filter subItems based on permission and search query
                      const visibleSubItems = hasSubItems ? item.subItems!.filter(sub => {
                        if (sub.adminOnly && !isAdmin) return false;
                        if (sub.permissionKey && !canAny(sub.permissionKey)) return false;
                        if (isQueryActive) {
                          return sub.label.toLowerCase().includes(navSearchQuery.toLowerCase()) || item.label.toLowerCase().includes(navSearchQuery.toLowerCase());
                        }
                        return true;
                      }) : [];

                      const actualHasSubItems = visibleSubItems.length > 0;
                      const isSubItemSelected = actualHasSubItems && visibleSubItems.some(sub => activeTab === sub.id);
                      const isSelected = activeTab === item.id || isSubItemSelected;
                      // Collapsed by default at login (expandedNavGroups starts empty) —
                      // a group only opens once explicitly toggled (toggleNavGroup) or
                      // navigated into (handleNavigate's accordion, which already sets the
                      // owning group true whenever its tab becomes active), so no separate
                      // "contains the active tab" fallback is needed here.
                      const isGroupExpanded = isQueryActive || expandedNavGroups[item.id] === true;
                      const Icon = item.icon;

                      // Collapsed sidebar view
                      if (isSidebarCollapsed) {
                        return (
                          <div key={item.id} className="relative group flex justify-center py-0.5">
                            <button
                              onClick={() => {
                                if (actualHasSubItems && visibleSubItems[0]) {
                                  handleNavigate(visibleSubItems[0].id);
                                } else {
                                  handleNavigate(item.id);
                                }
                              }}
                              className={`
                                w-11 h-11 rounded-2xl flex items-center justify-center transition-all cursor-pointer relative
                                ${isSelected 
                                  ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/40 ring-2 ring-indigo-400/40' 
                                  : 'text-slate-400 hover:bg-indigo-900/60 hover:text-slate-100'}
                              `}
                              title={item.label}
                            >
                              <Icon className="w-5 h-5 shrink-0" />
                              {isSubItemSelected && (
                                <span className="absolute -top-0.5 -end-0.5 w-2.5 h-2.5 bg-amber-400 rounded-full border-2 border-indigo-950" />
                              )}
                              {item.id === 'settings' && pendingOnboardingCount > 0 && (
                                <span className="absolute -top-1 -end-1 min-w-[16px] h-4 px-1 bg-rose-500 text-white text-[9px] font-bold rounded-full border-2 border-indigo-950 flex items-center justify-center">
                                  {pendingOnboardingCount > 9 ? '9+' : pendingOnboardingCount}
                                </span>
                              )}
                            </button>
                          </div>
                        );
                      }

                      // Expanded sidebar view
                      return (
                        <div key={item.id} className="space-y-1">
                          <button
                            onClick={() => {
                              if (actualHasSubItems && !isQueryActive) {
                                toggleNavGroup(item.id);
                              } else {
                                handleNavigate(item.id);
                              }
                            }}
                            className={`
                              w-full text-start px-3 py-2 rounded-xl text-xs font-bold transition flex items-center justify-between cursor-pointer border
                              ${(isSelected && !actualHasSubItems)
                                ? 'bg-indigo-600 text-white border-indigo-500 shadow-md shadow-indigo-600/20' 
                                : (isSubItemSelected 
                                  ? 'bg-indigo-950/80 text-indigo-200 border-indigo-800/80' 
                                  : 'bg-transparent border-transparent hover:bg-indigo-900/40 text-slate-400 hover:text-slate-100')}
                            `}
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <Icon className={`w-4 h-4 shrink-0 ${(isSelected || isSubItemSelected) ? 'text-indigo-300' : 'text-slate-500'}`} />
                              <span className="truncate">{item.label}</span>
                              {item.id === 'settings' && pendingOnboardingCount > 0 && (
                                <span className="shrink-0 min-w-[16px] h-4 px-1 bg-rose-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                                  {pendingOnboardingCount > 9 ? '9+' : pendingOnboardingCount}
                                </span>
                              )}
                            </div>
                            {actualHasSubItems && (
                              <ChevronDown className={`w-3.5 h-3.5 text-slate-500 shrink-0 transition-transform ${isGroupExpanded ? 'rotate-180' : ''}`} />
                            )}
                          </button>
                          
                          {/* SubItems */}
                          {actualHasSubItems && isGroupExpanded && (
                            <div className="ps-7 pe-1 space-y-0.5 border-s border-indigo-800/40 ms-4 my-1">
                              {visibleSubItems.map(sub => {
                                const isSubSelected = activeTab === sub.id;
                                return (
                                  <button
                                    key={sub.id}
                                    onClick={() => handleNavigate(sub.id)}
                                    className={`
                                      w-full text-start px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer flex items-center justify-between
                                      ${isSubSelected 
                                        ? 'bg-indigo-600/30 text-white font-extrabold border-s-2 border-indigo-400 ps-2.5' 
                                        : 'text-slate-400 hover:bg-indigo-900/30 hover:text-slate-200'}
                                    `}
                                  >
                                    <span>{sub.label}</span>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
 </div>
 </div>
 );
 })}
 </nav>
 </div>

 {/* Sidebar Footer — language switcher + version only; identity and Sign Out now
 live together in the account row right under the header (see above). */}
 <div className={`p-3 border-t border-indigo-900/50 bg-slate-950/80 ${isSidebarCollapsed ? 'flex flex-col items-center gap-2' : 'space-y-2.5'}`}>
 {!isSidebarCollapsed ? (
 <>
 <div className="flex gap-1 w-full justify-center">
 {['en', 'ar', 'ur'].map(l => (
 <button
 key={l}
 onClick={() => handleLanguageChange(l as any)}
 className={`px-2.5 py-0.5 rounded text-[10px] font-extrabold uppercase transition-colors cursor-pointer ${lang === l ? 'bg-indigo-600 text-white shadow-sm' : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'}`}
 >
 {l}
 </button>
 ))}
 </div>

 <div className="text-[9px] text-slate-500 font-mono text-center pt-1">
 Ver 1.4.0 • ERP Stable Build
 </div>
 </>
 ) : (
 <div className="flex gap-1 flex-col items-center">
 {['en', 'ar', 'ur'].map(l => (
 <button
 key={l}
 onClick={() => handleLanguageChange(l as any)}
 className={`w-7 py-0.5 rounded text-[9px] font-extrabold uppercase transition-colors cursor-pointer ${lang === l ? 'bg-indigo-600 text-white shadow-sm' : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'}`}
 >
 {l}
 </button>
 ))}
 </div>
 )}
 </div>
 </aside>

 {/* MAIN VIEWPORT */}
 <main className="flex-1 min-w-0 flex flex-col p-4 md:p-8 lg:p-10 space-y-6 md:max-w-[1400px] md:mx-auto w-full relative">
 
 

 {/* GLOBAL APPLICATION BRAND HEADER */}
 <div className="flex items-center justify-between border-b border-slate-200/80 pb-3 shrink-0">
 <div className="flex items-center gap-3">
 {activeCompanySetup.logoUrl ? (
 <img src={ensureCompatibleImage(activeCompanySetup.logoUrl)} alt="Company Logo" className="h-9 object-contain max-w-[140px]" referrerPolicy="no-referrer" />
 ) : (
 <div className="w-9 h-9 bg-indigo-600 text-white rounded-xl flex items-center justify-center font-bold text-sm shadow-sm">
 {activeCompanySetup.name.substring(0, 3).toUpperCase()}
 </div>
 )}
 <div>
 <h1 className="font-extrabold text-sm text-slate-900 tracking-wide uppercase leading-tight">{activeCompanySetup.name}</h1>
 <span className="text-[9px] text-slate-400 font-bold block uppercase tracking-wider">{activeCompanySetup.portalSubtitle || 'Industrial Fabrication Portal'}</span>
 </div>
 {isSuperAdmin && (
 <div className="ms-4 ps-4 border-s border-slate-200/80 flex items-center gap-2">
 <span className="text-[9px] font-black text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded uppercase tracking-wider shrink-0">Super Admin Workspace</span>
 <select
 value={activeDb.selectedCompanyId}
 onChange={async (e) => {
 const nextCompanyId = e.target.value;
 const nextCompanySetup = db.companies?.find(c => c.id === nextCompanyId) || db.companySetup;
 setDb(prev => ({ ...prev, selectedCompanyId: nextCompanyId, companySetup: nextCompanySetup }));
 // Same session-persisting switch as the sidebar selector above.
 try {
 await fetch('/api/switch-company', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ companyId: nextCompanyId }),
 });
 } catch (err) {
 console.error('Failed to persist company switch:', err);
 }
 await triggerDbRefresh();
 }}
 className="bg-slate-50 border border-slate-200 hover:border-slate-300 rounded-lg px-2.5 py-1 text-xs text-slate-800 font-bold focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer shadow-sm transition-all"
 >
 {db.companies?.map(c => (
 <option key={c.id} value={c.id}>🏢 {c.name}</option>
 ))}
 </select>
 </div>
 )}
 </div>
 <div className="flex items-center gap-3 bg-white border border-slate-200/80 px-3 py-1.5 rounded-xl text-[10px] text-slate-500 font-medium shadow-sm">
 <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Portal Theme:</span>
 <div className="flex items-center gap-2">
 {THEME_PROFILES.map(p => {
 const isSelected = (activeCompanySetup.themeId || 'classic-executive') === p.id;
 return (
 <button
 key={p.id}
 onClick={() => handleThemeChange(p.id)}
 className={`w-3.5 h-3.5 rounded-full border transition-all cursor-pointer ${
 isSelected 
 ? 'ring-2 ring-indigo-600 ring-offset-1 scale-110 border-white' 
 : 'border-slate-200 hover:scale-110'
 }`}
 style={{ backgroundColor: p.variables.primaryColor }}
 title={`Switch to ${p.name}`}
 />
 );
 })}
 </div>
 </div>
 </div>

 {/* TOP ACTION BAR */}
 <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 shrink-0">
 <div>
 <h2 className="text-xl font-extrabold text-slate-900 tracking-tight font-sans capitalize">
 {activeTab === 'dashboard' ? t('Business Overview') :
 activeTab.startsWith('reports-') ? (REPORT_NAV_TITLES[activeTab] || t('Financial Reports')) :
 activeTab === 'customers' ? t('Customer Registry (CRM)') :
 activeTab === 'customers-add' ? (editTarget?.module === 'customers' ? t('Edit Customer') : t('New Customer')) :
 activeTab === 'vendors' ? t('Vendor & Suppliers Directory') :
 activeTab === 'vendors-add' ? (editTarget?.module === 'vendors' ? t('Edit Vendor') : t('New Vendor')) :
 activeTab === 'products' ? t('Products & Service Catalog') :
 activeTab === 'products-add' ? (editTarget?.module === 'products' ? t('Edit Product') : t('New Product')) :
 activeTab === 'categories' ? t('Product Categories') :
 activeTab === 'categories-add' ? (editTarget?.module === 'categories' ? t('Edit Category') : t('New Category')) :
 activeTab === 'units' ? t('Units of Measure') :
 activeTab === 'units-add' ? (editTarget?.module === 'units' ? t('Edit Unit') : t('New Unit')) :
 activeTab === 'modifier-groups' || activeTab === 'modifier-groups-add' ? t('Modifier Groups') :
 activeTab === 'warehouses' ? t('Physical Warehouses') :
 activeTab === 'warehouses-add' ? (editTarget?.module === 'warehouses' ? t('Edit Warehouse') : t('New Warehouse')) :
 activeTab === 'quotations' ? t('Quotation Book') :
 activeTab === 'quotations-add' ? (editTarget?.module === 'quotations' ? t('Modify Existing Quotation') : t('New Quotation')) :
 activeTab === 'invoices' ? t('Sales Invoices') :
 activeTab === 'invoices-add' ? t('New Sales Invoice') :
 activeTab === 'invoices-view' ? t('View invoice') :
 activeTab === 'expenses' ? t('Recorded Expenses & Assets') :
 activeTab === 'expenses-add' ? t('New Expense') :
 activeTab === 'recurring' ? t('Recurring & Accruals') :
 activeTab === 'pos' ? t('Point of Sale (POS)') :
 activeTab === 'pos-terminal' ? t('Terminal') :
 activeTab === 'pos-shifts' ? t('Shifts & Z-Reports') :
 activeTab === 'pos-history' ? t('Sales History') :
 activeTab === 'procurement' ? t('Procurements') :
 activeTab === 'inventory' ? t('Inventory System') :
 activeTab === 'inventory-pr' ? t('Purchase Requisitions') :
 activeTab === 'inventory-po' ? t('Purchase Orders') :
 activeTab === 'inventory-grn' ? t('Goods Receipt (GRN)') :
 activeTab === 'inventory-stock' ? t('Stock Registry') :
 activeTab === 'inventory-bills' ? t('Purchase Bills') :
 activeTab === 'inventory-returns' ? t('Purchase Returns') :
 activeTab === 'inventory-stocktakes' ? t('Physical Stock Takes') :
 activeTab === 'inventory-dispatch' ? t('Warehouse Dispatch') :
 activeTab === 'inventory-receiving' ? t('Warehouse Receiving') :
 activeTab === 'settings' ? t('Settings & Companies') :
 t(activeTab)}
 </h2>
 <p className="text-xs text-slate-400 mt-1">
 {activeTab === 'dashboard' && t('Aggregated operational data, P&L graphs, and user quotas.')}
 {activeTab === 'quotations' && t('Draft cost estimates and proposals for your customers.')}
 {activeTab === 'quotations-add' && t('Draft cost estimates and proposals for your customers.')}
 {activeTab === 'invoices' && t('Finalise billing, issue commercial sales receipts, and trace cash receipts.')}
 {activeTab === 'invoices-add' && t('Finalise billing, issue commercial sales receipts, and trace cash receipts.')}
 {activeTab === 'expenses' && t('Track purchases, supplies, and operating costs.')}
 {activeTab === 'expenses-add' && t('Track purchases, supplies, and operating costs.')}
 {activeTab === 'recurring' && t('Manage salaries, rent ledger templates, and outstanding accruals.')}
 {activeTab.startsWith('reports-') && (REPORT_NAV_DESCRIPTIONS[activeTab] || '')}
 {activeTab === 'customers' && t('Manage commercial accounts, client contacts, and outstanding customer VAT balances.')}
 {activeTab === 'vendors' && t('Manage suppliers list, procurement contacts, and supplier details.')}
 {activeTab === 'pos' && t('Fast and responsive POS interface for retail counter sales.')}
  {activeTab === 'products' && t('Define product specifications, variants, and pricing tiers.')}
 {activeTab === 'categories' && t('Define product hierarchy and Map material types to specific GL accounting groups.')}
 {activeTab === 'units' && t('Configure standardized weights, dimensions, volumes, and UoM conversion units.')}
 {(activeTab === 'modifier-groups' || activeTab === 'modifier-groups-add') && t('Reusable POS customization options — Size, Milk, Extra Shot — attached optionally to whichever products need them.')}
 {activeTab === 'warehouses' && t('Setup and govern multiple physical storage locations, distribution centers, and shop floors.')}
 {activeTab === 'settings' && t('Administrative settings, company config, and month closures.')}
 </p>
 </div>

 <div className="flex items-center gap-3">
 <button
 onClick={() => triggerDbRefresh()}
 className="px-3.5 py-1.5 bg-white hover:bg-slate-50 text-slate-600 rounded-xl text-xs font-bold transition border border-slate-100 shadow-sm"
 >
 {t("Reload View")}
 </button>
 <div className="bg-slate-200/60 p-1 rounded-xl text-[10px] font-bold text-slate-500 uppercase flex items-center gap-1.5 border border-slate-100 shadow-sm shrink-0">
 <span className="px-2 py-0.5 bg-white rounded-lg text-slate-700 shadow-sm">{currentUser?.username}</span>
 <span className="pe-1.5">{currentUser?.role}</span>
 </div>
 </div>
 </div>

 {/* Background-sync failure banner — surfaces cloudError, set whenever a state
 refresh from GET /api/state fails, so a broken connection to Postgres has a
 visible signal instead of silently leaving stale data on screen. */}
 {cloudError && (
 <div className="bg-rose-50 text-rose-700 p-3 px-6 text-xs font-semibold rounded-xl border border-rose-100 flex items-center gap-2 shrink-0">
 <AlertTriangle className="w-4 h-4 text-rose-500 shrink-0" />
 <span>{cloudError}</span>
 </div>
 )}

 {/* COMPONENT ROUTER VIEWPORT — deliberately no AnimatePresence/exit animation here.
 This used to be `<AnimatePresence mode="wait"><motion.div exit={...}>`, which
 blocks mounting the NEXT tab's content until the PREVIOUS motion.div's exit
 animation reports complete. That completion callback depends on the browser
 actually driving requestAnimationFrame for this element; in at least one real
 environment (an automated/headless browser pane) it never fired, permanently
 stranding the page on the old tab's content forever (title/subtitle above,
 which read `activeTab` directly, updated fine — only this gated subtree stuck)
 with no way to recover short of a full reload. A stuck-forever failure mode
 for a single lost animation-frame callback is too fragile for the app's main
 router. Keeping `key={activeTab}` still remounts this div on every navigation
 (so the initial->animate fade/blur-in below still plays each time) without any
 exit phase for that remount to ever get stuck waiting on. */}
 <motion.div
 key={activeTab}
 initial={{ opacity: 0, filter: 'blur(4px)' }}
 animate={{ opacity: 1, filter: 'blur(0px)' }}
 transition={{ duration: 0.25, ease: 'easeOut' }}
 className="flex-1 min-h-0"
 >
 {!isTabAllowed(activeTab) ? (
 <div className="flex flex-col items-center justify-center h-full text-center gap-3 py-24">
 <Lock className="w-10 h-10 text-slate-300" />
 <p className="text-slate-500 font-medium">{t("You don't have permission to access this page.")}</p>
 </div>
 ) : (
 <>
 {activeTab === 'dashboard' && (
 <Dashboard db={activeDb} onNavigate={handleNavigate} lastSyncTimes={lastSyncTimes} />
 )}
 {(activeTab === 'quotations' || activeTab === 'quotations-add') && (
 <QuotationModule
 db={activeDb}
 onUpdateDbLocal={handleUpdateDbLocal}
 onRefreshDb={triggerDbRefresh}
 onPrintDoc={(type, data) => setPrintDoc({ type, data })}
 mode={activeTab === 'quotations-add' ? 'add' : 'list'}
 editId={editTarget?.module === 'quotations' ? editTarget.id : undefined}
 onDone={() => handleNavigate('quotations')}
 onEdit={(id) => { setEditTarget({ module: 'quotations', id }); handleNavigate('quotations-add', true); }}
 onCreateNew={() => handleNavigate('quotations-add')}
 onConverted={() => handleNavigate('invoices')}
 onDirtyChange={(dirty) => { isCurrentFormDirtyRef.current = dirty; }}
 />
 )}
 {(activeTab === 'invoices' || activeTab === 'invoices-add') && (
 <InvoiceModule
 db={activeDb}
 onUpdateDbLocal={handleUpdateDbLocal}
 onRefreshDb={triggerDbRefresh}
 onPrintDoc={(type, data) => setPrintDoc({ type, data })}
 mode={activeTab === 'invoices-add' ? 'add' : 'list'}
 onDone={() => handleNavigate('invoices')}
 onCreateNew={() => handleNavigate('invoices-add')}
 onViewInvoice={(id) => { setViewTarget({ id }); handleNavigate('invoices-view'); }}
 onDirtyChange={(dirty) => { isCurrentFormDirtyRef.current = dirty; }}
 />
 )}
 {activeTab === 'invoices-view' && viewTarget && (
 <InvoiceViewScreen
 db={activeDb}
 invoiceId={viewTarget.id}
 onBack={() => handleNavigate('invoices')}
 onPrintDoc={(type, data) => setPrintDoc({ type, data })}
 onRefreshDb={triggerDbRefresh}
 />
 )}
 {(activeTab === 'expenses' || activeTab === 'expenses-add') && (
 <ExpenseModule
 db={activeDb}
 mode={activeTab === 'expenses-add' ? 'add' : 'list'}
 onDone={() => handleNavigate('expenses')}
 onCreateNew={() => handleNavigate('expenses-add')}
 onPrintDoc={(type, data) => setPrintDoc({ type, data })}
 onRefreshDb={triggerDbRefresh}
 onDirtyChange={(dirty) => { isCurrentFormDirtyRef.current = dirty; }}
 />
 )}
 {activeTab === 'recurring' && isAdmin && (
 <RecurringExpenses db={activeDb} onRefreshDb={triggerDbRefresh} />
 )}
 {/* Financial Reports — which report to show is purely nav-driven (10 separate
 sidebar entries, same as InventoryModule's defaultTab prop for PR/PO/GRN) — no
 in-page tab switcher inside these modules for this to fall back to. */}
 {['reports-trialbalance', 'reports-salesvat', 'reports-purchasevat', 'reports-bankledger', 'reports-profitloss', 'reports-outstanding', 'reports-balancesheet', 'reports-vatreturn', 'reports-investorshare', 'reports-monthclosing'].includes(activeTab) && (
 <ReportViewer
 db={activeDb}
 defaultReportType={
 activeTab === 'reports-trialbalance' ? 'TrialBalance' :
 activeTab === 'reports-salesvat' ? 'SalesVAT' :
 activeTab === 'reports-purchasevat' ? 'PurchaseVAT' :
 activeTab === 'reports-bankledger' ? 'BankLedger' :
 activeTab === 'reports-profitloss' ? 'ProfitLoss' :
 activeTab === 'reports-outstanding' ? 'Outstanding' :
 activeTab === 'reports-balancesheet' ? 'BalanceSheet' :
 activeTab === 'reports-vatreturn' ? 'VatReturnSummary' :
 activeTab === 'reports-investorshare' ? 'InvestorProfitShare' :
 'FiscalMonthClosingHistory'
 }
 onPrintDoc={(type, data) => setPrintDoc({ type, data })}
 />
 )}
 {['reports-salesregister', 'reports-itemsales', 'reports-customerstatement', 'reports-quotationconversion', 'reports-salesbystaff', 'reports-posshiftsummary'].includes(activeTab) && (
 <SalesReportsModule
 db={activeDb}
 defaultReportType={
 activeTab === 'reports-salesregister' ? 'SalesRegister' :
 activeTab === 'reports-itemsales' ? 'ItemWiseSales' :
 activeTab === 'reports-customerstatement' ? 'CustomerStatement' :
 activeTab === 'reports-quotationconversion' ? 'QuotationConversion' :
 activeTab === 'reports-salesbystaff' ? 'SalesByStaff' :
 'PosShiftSummary'
 }
 onPrintDoc={(type, data) => setPrintDoc({ type, data })}
 />
 )}
 {['reports-purchaseregister', 'reports-vendorstatement', 'reports-postatus', 'reports-grnvariance'].includes(activeTab) && (
 <PurchaseReportsModule
 db={activeDb}
 defaultReportType={
 activeTab === 'reports-purchaseregister' ? 'PurchaseRegister' :
 activeTab === 'reports-vendorstatement' ? 'VendorStatement' :
 activeTab === 'reports-postatus' ? 'PoStatus' :
 'GrnPoVariance'
 }
 onPrintDoc={(type, data) => setPrintDoc({ type, data })}
 />
 )}
 {['reports-stockvaluation', 'reports-itemprofitability', 'reports-lowstock', 'reports-stocktakevariance', 'reports-stockmovementledger', 'reports-warehousetransferreconciliation'].includes(activeTab) && (
 <InventoryReportsModule
 db={activeDb}
 defaultReportType={
 activeTab === 'reports-stockvaluation' ? 'StockValuation' :
 activeTab === 'reports-itemprofitability' ? 'ItemProfitability' :
 activeTab === 'reports-lowstock' ? 'LowStock' :
 activeTab === 'reports-stocktakevariance' ? 'StockTakeVarianceHistory' :
 activeTab === 'reports-stockmovementledger' ? 'StockMovementLedger' :
 'WarehouseTransferReconciliation'
 }
 onPrintDoc={(type, data) => setPrintDoc({ type, data })}
 />
 )}
 {(activeTab === 'customers' || activeTab === 'customers-add') && renderMasterEntities('customers')}
 {(activeTab === 'vendors' || activeTab === 'vendors-add') && renderMasterEntities('vendors')}
 {(activeTab === 'categories' || activeTab === 'categories-add') && renderMasterEntities('categories')}
 {(activeTab === 'units' || activeTab === 'units-add') && renderMasterEntities('units')}
 {(activeTab === 'warehouses' || activeTab === 'warehouses-add') && renderMasterEntities('warehouses')}
 {(activeTab === 'pos' || activeTab.startsWith('pos-')) && (
            <PosModule db={activeDb} onUpdateDbLocal={handleUpdateDbLocal} onRefreshDb={triggerDbRefresh} currentUser={currentUser} defaultTab={activeTab === 'pos' ? 'terminal' : activeTab.replace('pos-', '') as any} onClose={() => handleNavigate('dashboard')} onViewInvoice={(id) => { setViewTarget({ id }); handleNavigate('invoices-view'); }} />
          )}
  {(activeTab === 'products' || activeTab === 'products-add') && renderMasterEntities('products')}
 {(activeTab === 'inventory' || activeTab.startsWith('inventory-')) && (
         <InventoryModule
           db={activeDb}
           onUpdateDbLocal={handleUpdateDbLocal}
           currentUser={currentUser}
           onRefreshDb={triggerDbRefresh}
           onPrintDoc={(type, data) => setPrintDoc({ type, data })}
           defaultTab={activeTab === 'inventory' ? 'stock' : (activeTab.replace('inventory-', '') as any)}
           onDirtyChange={(dirty) => { isCurrentFormDirtyRef.current = dirty; }}
         />
       )}

       {(activeTab.startsWith('employees') || activeTab.startsWith('job-titles')) && (
         <EmployeesModule
           db={activeDb}
           onUpdateDbLocal={handleUpdateDbLocal}
           onRefreshDb={triggerDbRefresh}
           currentUser={currentUser}
           defaultTab={activeTab as any}
         />
       )}

       {(activeTab === 'modifier-groups' || activeTab === 'modifier-groups-add') && (
         <ModifierGroupsModule
           db={activeDb}
           onUpdateDbLocal={handleUpdateDbLocal}
           onRefreshDb={triggerDbRefresh}
           currentUser={currentUser}
         />
       )}

       {activeTab === 'settings' && canAny(SETTINGS_ACCESS_PERMISSIONS) && (
 <AdminSettings db={activeDb} onUpdateDbLocal={handleUpdateDbLocal} onRefreshDb={triggerDbRefresh} defaultTab={settingsTab as any} />
 )}
 </>
 )}
 </motion.div>
 </main>

 {/* DOCUMENT PRINTING/PREVIEW OVERLAY */}
 {printDoc && (
 <DocumentRenderer
 documentType={printDoc.type}
 data={printDoc.data}
 companySetup={activeCompanySetup}
 templates={activeDb.templates}
 taxSlabs={activeDb.taxSlabs}
 db={activeDb}
 onViewAnotherDoc={handleViewAnotherDoc}
 onClose={() => setPrintDoc(null)}
 />
 )}

 {showChangePasswordModal && (
 <ChangePasswordScreen
 variant="modal"
 db={activeDb}
 onClose={() => setShowChangePasswordModal(false)}
 onSuccess={() => setShowChangePasswordModal(false)}
 />
 )}

 </div>
 );
}
