import { motion, AnimatePresence } from 'motion/react';
import React from 'react';
import { useTranslation, usePermissions } from './hooks';
import { getDatabase, saveDatabase, getActiveOpenMonth, getOpenMonths, DatabaseState } from './dbStore';
import { THEME_PROFILES, applyTheme } from './theme';
import { ensureCompatibleImage } from './imageUtils';

// Importing Modules
import Dashboard from './components/Dashboard';
import QuotationModule from './components/QuotationModule';
import InvoiceModule from './components/InvoiceModule';
import ExpenseModule from './components/ExpenseModule';
import RecurringExpenses from './components/RecurringExpenses';
import PosModule from './components/PosModule';
import MasterEntities from './components/MasterEntities';
import AdminSettings from './components/AdminSettings';
import DocumentRenderer from './components/DocumentRenderer';
import ReportViewer from './components/ReportViewer';
import LoginScreen from './components/LoginScreen';
import InventoryModule from './components/InventoryModule';

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
 HardHat,
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

  const handleUpdateDb = (newDb: DatabaseState | ((prev: DatabaseState) => DatabaseState)) => {
    let resolvedDb: DatabaseState;
    setDb(prev => {
      resolvedDb = typeof newDb === 'function' ? newDb(prev) : newDb;
      
      // Sync to Postgres (Server database is single source of truth)
      fetch('/api/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(resolvedDb)
      }).then(res => {
        if (!res.ok) {
          throw new Error('Sync failed with status ' + res.status);
        }
        setCloudError(null);
      }).catch(err => {
        console.error('Error syncing to Postgres:', err);
        setCloudError('Warning: Server database sync failed. Please check network connection.');
      });

      return resolvedDb;
    });
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

  const [printDoc, setPrintDoc] = React.useState<{
    type: 'Quotation' | 'Invoice' | 'Expense' | 'Voucher' | 'Ledger' | 'Report';
    data: any;
  } | null>(null);

  // Cross-cutting "which record is being edited" state for the List/Add page-split
  // pattern: a List row's Edit action sets this, then navigates to the module's
  // '-add' tab; the Add page reads it back to know whether it's creating or editing.
  const [editTarget, setEditTarget] = React.useState<{ module: string; id: string } | null>(null);

  const [settingsTab, setSettingsTab] = React.useState<string>('company');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = React.useState<boolean>(false);
  const [navSearchQuery, setNavSearchQuery] = React.useState<string>('');
  const { t, isRTL, lang } = useTranslation(db);
  const [expandedNavGroups, setExpandedNavGroups] = React.useState<Record<string, boolean>>({
    pos: true, sales: true, procurement: true
  });

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
        />
    );
  }

  const isAdmin = currentUser?.role === 'admin' || currentUser?.isSuperAdmin === true;
  const isSuperAdmin = currentUser?.isSuperAdmin === true;
  const { can } = usePermissions(currentUser);
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
  permissionKey?: string;
  subItems?: {
    id: string;
    label: string;
    permissionKey?: string;
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
            { id: 'expenses', label: t('Expenses'), permissionKey: 'expense.view' },
            { id: 'expenses-add', label: t('New Expense'), permissionKey: 'expense.create' },
            { id: 'recurring', label: t('Recurring & Accruals'), adminOnly: true }
          ]
        }
      ]
    },
    ...(activeCompanySetup?.isInventoryModuleEnabled ? [
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
              { id: 'inventory-stock', label: t('Stock Registry'), permissionKey: 'inventory.stock' }
            ]
          }
        ]
      }
    ] : []),
    {
      title: t('Master Registries'),
      items: [
        { 
          id: 'registries', label: t('Master Registries'), icon: FolderTree, adminOnly: false,
          subItems: [
            { id: 'customers', label: t('Customers CRM'), permissionKey: 'customers.view' },
            { id: 'customers-add', label: t('New Customer'), permissionKey: 'customers.edit' },
            { id: 'vendors', label: t('Vendors Directory'), permissionKey: 'vendors.view' },
            { id: 'vendors-add', label: t('New Vendor'), permissionKey: 'vendors.edit' },
            { id: 'products', label: t('Products & Pricing'), permissionKey: 'products.view' },
            { id: 'products-add', label: t('New Product'), permissionKey: 'products.edit' },
            { id: 'categories', label: t('Product Categories'), permissionKey: 'categories.view' },
            { id: 'categories-add', label: t('New Category'), permissionKey: 'categories.edit' },
            { id: 'units', label: t('Units of Measure'), permissionKey: 'units.view' },
            { id: 'units-add', label: t('New Unit'), permissionKey: 'units.edit' },
            { id: 'warehouses', label: t('Physical Warehouses'), permissionKey: 'warehouses.view' },
            { id: 'warehouses-add', label: t('New Warehouse'), permissionKey: 'warehouses.edit' }
          ]
        }
      ]
    },
    {
      title: t('Intelligence & Reports'),
      items: [
        { id: 'reports', label: t('Financial Reports'), icon: BarChart3, adminOnly: false, permissionKey: 'reports.access' }
      ]
    },
    {
      title: t('Setup & Governance'),
      items: [
        { id: 'settings', label: t('Settings & Companies'), icon: Settings, adminOnly: true }
      ]
    }
  ];


  const toggleNavGroup = (id: string) => {
    setExpandedNavGroups(prev => ({...prev, [id]: !prev[id]}));
  };

  // Flattened { tabId -> { permissionKey?, adminOnly? } } built from navSections — the
  // same table that already drives sidebar link visibility, reused here so both the
  // link and the actual page content are gated by one source of truth instead of two.
  // Deliberately NOT a hook (no React.useMemo) — this component has early `return`s
  // above (dbLoaded/currentUser checks) that a hook here would sit after, which breaks
  // the Rules of Hooks. navSections itself is already recomputed every render, so this
  // plain recomputation costs nothing extra.
  const tabPermissionMap = (() => {
    const map = new Map<string, { permissionKey?: string; adminOnly?: boolean }>();
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
    if (entry.permissionKey && !can(entry.permissionKey)) return false;
    return true;
  };

  // `preserveEditTarget` defaults to false so any generic navigation (sidebar clicks,
  // Cancel/Done handlers, "Create New" buttons) clears a stale edit target; only the
  // explicit onEdit path (below) passes true to carry the target across the navigate.
  const handleNavigate = (tabId: string, preserveEditTarget: boolean = false) => {
 const resolvedTabId = tabId.startsWith('settings-') ? 'settings' : tabId;
 if (!isTabAllowed(resolvedTabId)) return;
 if (!preserveEditTarget) setEditTarget(null);
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
 };

 // Shared List/Add wiring for the six MasterEntities sub-tabs — each gets a
 // '<sub>' (List) and '<sub>-add' (Add/Edit) tab pair following the same
 // editTarget/onEdit pattern used for Quotations/Invoices/Expenses.
 const renderMasterEntities = (sub: 'customers' | 'vendors' | 'products' | 'categories' | 'units' | 'warehouses') => (
 <MasterEntities
 db={activeDb}
 onUpdateDb={handleUpdateDb}
 forceSubTab={sub}
 mode={activeTab === `${sub}-add` ? 'add' : 'list'}
 editId={editTarget?.module === sub ? editTarget.id : undefined}
 onDone={() => handleNavigate(sub)}
 onEdit={(id) => { setEditTarget({ module: sub, id }); handleNavigate(`${sub}-add`, true); }}
 onCreateNew={() => handleNavigate(`${sub}-add`)}
 />
 );

 return (
 <div dir={isRTL ? "rtl" : "ltr"} className="min-h-screen bg-indigo-50/30 text-slate-800 font-sans flex flex-col md:flex-row antialiased selection:bg-indigo-500/20">
 
 {/* MOBILE HEADER */}
 <header className="md:hidden bg-indigo-950 text-white p-4 flex justify-between items-center border-b border-slate-800 shrink-0 z-30">
 <div className="flex items-center gap-2">
 <HardHat className="w-5 h-5 text-indigo-400" />
 <span className="font-extrabold text-xs uppercase tracking-wider">{activeCompanySetup.portalTitle || 'CNC FAB PORTAL'}</span>
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
 <span className="p-2 bg-indigo-600 rounded-xl text-white shadow-md shadow-indigo-600/30 shrink-0">
 <HardHat className="w-5 h-5 text-amber-300" />
 </span>
 {!isSidebarCollapsed && (
 <div className="min-w-0">
 <h1 className="font-extrabold text-xs uppercase text-white tracking-widest truncate">{activeCompanySetup.portalTitle || 'CNC FAB PORTAL'}</h1>
 <span className="text-[9px] text-indigo-300/80 font-bold block uppercase tracking-wider truncate">{activeCompanySetup.portalSubtitle || 'Shop ERP System'}</span>
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
 onChange={(e) => {
 const targetCompanyId = e.target.value;
 const targetCompSetup = db.companies?.find(c => c.id === targetCompanyId) || db.companySetup;
 handleUpdateDb({
 ...db,
 selectedCompanyId: targetCompanyId,
 companySetup: targetCompSetup
 });
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
 <span className="truncate">{t("Month Open:")} {t(openMonth.name)}{openMonthsCount > 1 ? ` (+${openMonthsCount - 1})` : ''}</span>
 </span>
 ) : (
 <span className="text-rose-400 font-bold flex items-center gap-1.5">
 <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {t("No Month Open")}
 </span>
 )}
 </div>
 ) : (
 <div className="my-1.5 flex justify-center" title={openMonth ? `Month Open: ${openMonth.name}${openMonthsCount > 1 ? ` (+${openMonthsCount - 1} more)` : ''}` : "No Month Open"}>
 <span className={`w-3 h-3 rounded-full ${openMonth ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`} />
 </div>
 )}

 {/* Navigation Links Grouped by Section */}
 <nav className={`${isSidebarCollapsed ? 'p-2 space-y-4' : 'p-3 space-y-4'}`}>
 {navSections.map(section => {
 // Filter out items in the section that are admin-only or restricted
 let visibleItems = section.items.filter(item => {
 if (item.adminOnly && !isAdmin) return false;
    const hasParentPermission = !item.permissionKey || can(item.permissionKey);
    
    let hasAccessToSubItem = false;
    if (item.subItems && item.subItems.length > 0) {
      hasAccessToSubItem = item.subItems.some(sub => 
        (!sub.adminOnly || isAdmin) &&
        (!sub.permissionKey || can(sub.permissionKey))
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
                      const isGroupExpanded = isQueryActive || expandedNavGroups[item.id] !== false;
                      const hasSubItems = item.subItems && item.subItems.length > 0;
                      
                      // Filter subItems based on permission and search query
                      const visibleSubItems = hasSubItems ? item.subItems!.filter(sub => {
                        if (sub.adminOnly && !isAdmin) return false;
                        if (sub.permissionKey && !can(sub.permissionKey)) return false;
                        if (isQueryActive) {
                          return sub.label.toLowerCase().includes(navSearchQuery.toLowerCase()) || item.label.toLowerCase().includes(navSearchQuery.toLowerCase());
                        }
                        return true;
                      }) : [];
                      
                      const actualHasSubItems = visibleSubItems.length > 0;
                      const isSubItemSelected = actualHasSubItems && visibleSubItems.some(sub => activeTab === sub.id);
                      const isSelected = activeTab === item.id || isSubItemSelected;
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

 {/* Sidebar Footer User Info */}
 <div className={`p-3 border-t border-indigo-900/50 bg-slate-950/80 ${isSidebarCollapsed ? 'flex flex-col items-center gap-2' : 'space-y-2.5'}`}>
 {!isSidebarCollapsed ? (
 <>
 <div className="flex items-center justify-between gap-2">
 <div className="flex items-center gap-2.5 min-w-0">
 <div className="p-1.5 bg-indigo-900/50 border border-indigo-700/50 rounded-lg text-indigo-300 shrink-0">
 <UserIcon className="w-4 h-4" />
 </div>
 <div className="min-w-0">
 <span className="text-[11px] font-extrabold text-white block truncate">{currentUser?.username}</span>
 <span className="text-[9px] font-bold text-indigo-400 uppercase tracking-wider block truncate">{currentUser?.role}</span>
 </div>
 </div>
 </div>

 <div className="flex gap-1 w-full justify-center pt-1 border-t border-indigo-900/40">
 {['en', 'ar', 'ur'].map(l => (
 <button
 key={l}
 onClick={() => {
 const updatedUsers = db.users.map(u => u.id === currentUser.id ? { ...u, uiLanguage: l as any } : u);
 handleUpdateDb({ ...db, users: updatedUsers, currentUser: { ...currentUser, uiLanguage: l as any } });
 }}
 className={`px-2.5 py-0.5 rounded text-[10px] font-extrabold uppercase transition-colors cursor-pointer ${lang === l ? 'bg-indigo-600 text-white shadow-sm' : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'}`}
 >
 {l}
 </button>
 ))}
 </div>
 
 <button
 onClick={handleLogout}
 className="w-full mt-1 py-1.5 px-2 bg-rose-950/30 hover:bg-rose-900/50 border border-rose-900/40 text-rose-200 rounded-xl text-[10px] font-extrabold uppercase transition-all flex items-center justify-center gap-1.5 cursor-pointer"
 >
 <LogOut className="w-3.5 h-3.5 text-rose-400" />
 <span>Sign Out</span>
 </button>

 <div className="text-[9px] text-slate-500 font-mono text-center pt-1">
 Ver 1.4.0 • ERP Stable Build
 </div>
 </>
 ) : (
 <>
 <div className="p-2 bg-indigo-900/40 border border-indigo-700/40 rounded-xl text-indigo-300" title={`${currentUser?.username} (${currentUser?.role})`}>
 <UserIcon className="w-4 h-4" />
 </div>
 <button
 onClick={handleLogout}
 className="p-2 bg-rose-950/40 hover:bg-rose-900/60 border border-rose-800/50 text-rose-300 rounded-xl transition-all cursor-pointer"
 title="Sign Out"
 >
 <LogOut className="w-4 h-4" />
 </button>
 </>
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
 onChange={(e) => {
 const nextCompanyId = e.target.value;
 const nextCompanySetup = db.companies?.find(c => c.id === nextCompanyId) || db.companySetup;
 const updatedDb = {
 ...db,
 selectedCompanyId: nextCompanyId,
 companySetup: nextCompanySetup
 };
 handleUpdateDb(updatedDb);
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
 onClick={() => {
 const updatedCompanySetup = {
 ...activeCompanySetup,
 themeId: p.id
 };
 const updatedDb = {
 ...db,
 companySetup: updatedCompanySetup,
 companies: db.companies?.map(c => c.id === activeDb.selectedCompanyId ? updatedCompanySetup : c) || [updatedCompanySetup]
 };
 handleUpdateDb(updatedDb);
 }}
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
 {activeTab === 'dashboard' ? t('Workshop Overview') :
 activeTab === 'reports' ? t('Financial Reports Register') :
 activeTab === 'customers' ? t('Customer Registry (CRM)') :
 activeTab === 'vendors' ? t('Vendor & Suppliers Directory') :
 activeTab === 'products' ? t('Products & Service Catalog') :
 activeTab === 'categories' ? t('Product Categories') :
 activeTab === 'units' ? t('Units of Measure') :
 activeTab === 'warehouses' ? t('Physical Warehouses') :
 activeTab === 'quotations-add' ? (editTarget?.module === 'quotations' ? t('Modify Existing Quotation') : t('New Quotation')) :
 activeTab === 'invoices-add' ? t('New Sales Invoice') :
 activeTab === 'expenses-add' ? t('New Expense') :
 t(activeTab)}
 </h2>
 <p className="text-xs text-slate-400 mt-1">
 {activeTab === 'dashboard' && t('Aggregated operational data, P&L graphs, and user quotas.')}
 {activeTab === 'quotations' && t('Draft fabrication estimates and plywood cutting blueprints.')}
 {activeTab === 'quotations-add' && t('Draft fabrication estimates and plywood cutting blueprints.')}
 {activeTab === 'invoices' && t('Finalise billing, issue commercial sales receipts, and trace cash receipts.')}
 {activeTab === 'invoices-add' && t('Finalise billing, issue commercial sales receipts, and trace cash receipts.')}
 {activeTab === 'expenses' && t('Procure tool bits, sheets, and audit workshop costs.')}
 {activeTab === 'expenses-add' && t('Procure tool bits, sheets, and audit workshop costs.')}
 {activeTab === 'recurring' && t('Manage salaries, rent ledger templates, and outstanding accruals.')}
 {activeTab === 'reports' && t('Generate Trial Balances, Sales and Purchase VAT registers, and Bank ledgers.')}
 {activeTab === 'customers' && t('Manage commercial accounts, client contacts, and outstanding customer VAT balances.')}
 {activeTab === 'vendors' && t('Manage suppliers list, procurement contacts, and supplier details.')}
 {activeTab === 'pos' && t('Fast and responsive POS interface for retail counter sales.')}
  {activeTab === 'products' && t('Define standard plywood/acrylic specifications, custom cuts, and pricing tiers.')}
 {activeTab === 'categories' && t('Define product hierarchy and Map material types to specific GL accounting groups.')}
 {activeTab === 'units' && t('Configure standardized weights, dimensions, volumes, and UoM conversion units.')}
 {activeTab === 'warehouses' && t('Setup and govern multiple physical storage locations, distribution centers, and shop floors.')}
 {activeTab === 'settings' && t('Administrative settings, company config, and month closures.')}
 </p>
 </div>

 <div className="flex items-center gap-3">
 <button
 onClick={() => setActiveTab('dashboard')}
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

 {/* Background-sync failure banner — surfaces handleUpdateDb's cloudError, which
 previously had no rendering anywhere: every optimistic write across the app
 (Users, Bank Accounts, Tax Slabs, Recurring templates, POS, Inventory, etc.)
 could silently fail to persist to Postgres with zero visible signal. */}
 {cloudError && (
 <div className="bg-rose-50 text-rose-700 p-3 px-6 text-xs font-semibold rounded-xl border border-rose-100 flex items-center gap-2 shrink-0">
 <AlertTriangle className="w-4 h-4 text-rose-500 shrink-0" />
 <span>{cloudError}</span>
 </div>
 )}

 {/* COMPONENT ROUTER VIEWPORT */}
 <AnimatePresence mode="wait">
 <motion.div
 key={activeTab}
 initial={{ opacity: 0, filter: 'blur(4px)' }}
 animate={{ opacity: 1, filter: 'blur(0px)' }}
 exit={{ opacity: 0, filter: 'blur(4px)' }}
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
 onUpdateDb={handleUpdateDb}
 onPrintDoc={(type, data) => setPrintDoc({ type, data })}
 mode={activeTab === 'quotations-add' ? 'add' : 'list'}
 editId={editTarget?.module === 'quotations' ? editTarget.id : undefined}
 onDone={() => handleNavigate('quotations')}
 onEdit={(id) => { setEditTarget({ module: 'quotations', id }); handleNavigate('quotations-add', true); }}
 onCreateNew={() => handleNavigate('quotations-add')}
 onConverted={() => handleNavigate('invoices')}
 />
 )}
 {(activeTab === 'invoices' || activeTab === 'invoices-add') && (
 <InvoiceModule
 db={activeDb}
 onUpdateDb={handleUpdateDb}
 onPrintDoc={(type, data) => setPrintDoc({ type, data })}
 mode={activeTab === 'invoices-add' ? 'add' : 'list'}
 onDone={() => handleNavigate('invoices')}
 onCreateNew={() => handleNavigate('invoices-add')}
 />
 )}
 {(activeTab === 'expenses' || activeTab === 'expenses-add') && (
 <ExpenseModule
 db={activeDb}
 onUpdateDb={handleUpdateDb}
 mode={activeTab === 'expenses-add' ? 'add' : 'list'}
 onDone={() => handleNavigate('expenses')}
 onCreateNew={() => handleNavigate('expenses-add')}
 onPrintDoc={(type, data) => setPrintDoc({ type, data })}
 />
 )}
 {activeTab === 'recurring' && isAdmin && (
 <RecurringExpenses db={activeDb} onUpdateDb={handleUpdateDb} onRefreshDb={triggerDbRefresh} />
 )}
 {activeTab === 'reports' && (
 <ReportViewer
 db={activeDb}
 onPrintDoc={(type, data) => setPrintDoc({ type, data })}
 />
 )}
 {(activeTab === 'customers' || activeTab === 'customers-add') && renderMasterEntities('customers')}
 {(activeTab === 'vendors' || activeTab === 'vendors-add') && renderMasterEntities('vendors')}
 {(activeTab === 'categories' || activeTab === 'categories-add') && renderMasterEntities('categories')}
 {(activeTab === 'units' || activeTab === 'units-add') && renderMasterEntities('units')}
 {(activeTab === 'warehouses' || activeTab === 'warehouses-add') && renderMasterEntities('warehouses')}
 {(activeTab === 'pos' || activeTab.startsWith('pos-')) && (
            <PosModule db={activeDb} onUpdateDb={handleUpdateDb} currentUser={currentUser} defaultTab={activeTab === 'pos' ? 'terminal' : activeTab.replace('pos-', '') as any} onClose={() => setActiveTab('dashboard')} />
          )}
  {(activeTab === 'products' || activeTab === 'products-add') && renderMasterEntities('products')}
 {(activeTab === 'inventory' || activeTab.startsWith('inventory-')) && (
         <InventoryModule
           db={activeDb}
           onUpdateDb={handleUpdateDb}
           currentUser={currentUser}
           defaultTab={activeTab === 'inventory' ? 'stock' : (activeTab.replace('inventory-', '') as any)}
         />
       )}

       {activeTab === 'settings' && isAdmin && (
 <AdminSettings db={activeDb} onUpdateDb={handleUpdateDb} onRefreshDb={triggerDbRefresh} defaultTab={settingsTab as any} />
 )}
 </>
 )}
 </motion.div>
 </AnimatePresence>
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

 </div>
 );
}
