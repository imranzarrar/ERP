import React from 'react';
import { useTranslation, translateMonthLabel, usePermissions } from '../hooks';
import { DatabaseState, saveDatabase, openNewMonth, closeMonth, SEED_BANKS, SEED_TAX_SLABS, SEED_TEMPLATES, getBankBalance, checkRecurringPreconditions, calculateMonthPnL, SEED_USERS, generateId } from '../dbStore';
import { CompanySetup, BankAccount, TaxSlab, DocumentTemplate, FiscalMonth, User, UserRole, Investor, Customer, Vendor, Role, Warehouse } from '../types';
import { PermissionNode, buildPermissionTree, allPermissionNodeIds } from '../permissionSchema';
import { THEME_PROFILES, applyTheme } from '../theme';
import VatReturnsPanel from './VatReturnsPanel';
import {
 Building,
 Wallet,
 Settings,
 Percent,
 Calendar,
 FileSpreadsheet,
 Plus,
 Check,
 AlertTriangle,
 ArrowRightLeft,
 ChevronRight,
 Trash2,
 Lock,
 Unlock,
 CheckCircle,
 TrendingDown,
 TrendingUp,
 UserCheck,
 Upload,
 Image,
 Coins,
 Edit2,
 Key,
 Database,
 Copy,
 Download,
 RefreshCw,
 Languages,
 Search,
 Sparkles,
 Sliders,
 ShoppingCart,
 ShieldCheck,
 Shield, MapPin, Hash, FileCheck, Monitor, LogOut, Inbox, Layers} from 'lucide-react';
import { ensureCompatibleImage } from '../imageUtils';
import { DEFAULT_DOCUMENT_LAYOUT, DETAILED_TAX_INVOICE_LAYOUT, COL_SPAN_MD, COL_SPAN_PRINT } from '../documentTemplateDefaults';
import { XMLParser } from 'fast-xml-parser';
import DocumentRenderer from './DocumentRenderer';
import ZatcaOnboardingWizard from './ZatcaOnboardingWizard';

// Shared sample invoice data for template preview — used both by the Canvas Designer's
// embedded live preview (updates as you edit) and the standalone "Live Print Preview"
// modal, so both show the exact same realistic content.
const TEMPLATE_PREVIEW_SAMPLE_INVOICE = {
  invoiceNumber: 'INV-2026-MOCK',
  date: new Date().toISOString().split('T')[0],
  dueDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
  customerData: {
    name: 'Walk-in Client (Al-Hazmi Corp.)',
    phone: '+966 50 123 4567',
    email: 'info@alhazmi-corp.com',
    address: 'Olaya Street, Riyadh, Saudi Arabia',
    vatNumber: '310987654300003'
  },
  items: [
    {
      id: 'item-1',
      description: 'Enterprise ERP Implementation / تطبيق نظام إدارة الموارد للمؤسسات',
      quantity: 1,
      unitCost: 15000,
      vatPercentage: 15,
      total: 15000
    },
    {
      id: 'item-2',
      description: 'ZATCA Phase 2 E-Invoicing Compliance Consulting / استشارات امتثال الفوترة الإلكترونية المرحلة الثانية',
      quantity: 2,
      unitCost: 2500,
      vatPercentage: 15,
      total: 5000
    }
  ],
  taxSlabId: 'vat-15',
  discountPercentage: 5,
  notes: 'This is a high-fidelity sample document preview showing how your custom layout template will render during actual printing.',
  bankData: {
    bankName: 'Saudi National Bank (SNB)',
    accountNumber: 'SA8000000000012345678901'
  }
};

const getNestedValue = (obj: any, path: string): boolean => {
  if (!obj) return false;
  const keys = path.split('.');
  let current = obj;
  for (const k of keys) {
    if (current === undefined || current === null || typeof current !== 'object') {
      return false;
    }
    current = current[k];
  }
  return current === true || (typeof current === 'object' && current?.enabled === true);
};

const setNestedValue = (obj: any, path: string, val: boolean): any => {
  const keys = path.split('.');
  const newObj = { ...obj };
  let current = newObj;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (i === keys.length - 1) {
      if (typeof current[key] === 'object' && current[key] !== null) {
        current[key] = { ...current[key], enabled: val };
      } else {
        current[key] = val;
      }
    } else {
      current[key] = { ...(current[key] || {}) };
      current = current[key];
    }
  }
  return newObj;
};

const isNodeFullyChecked = (node: PermissionNode, permissionsObj: any): boolean => {
  if (node.permissionPath) {
    return getNestedValue(permissionsObj, node.permissionPath);
  }
  if (node.children && node.children.length > 0) {
    return node.children.every(child => isNodeFullyChecked(child, permissionsObj));
  }
  return false;
};

const isNodePartiallyChecked = (node: PermissionNode, permissionsObj: any): boolean => {
  if (node.permissionPath) {
    return false;
  }
  
  const checkDescendants = (n: PermissionNode): boolean[] => {
    if (n.permissionPath) {
      return [getNestedValue(permissionsObj, n.permissionPath)];
    }
    if (n.children) {
      return n.children.flatMap(checkDescendants);
    }
    return [];
  };

  const results = checkDescendants(node);
  const checkedCount = results.filter(Boolean).length;
  return checkedCount > 0 && checkedCount < results.length;
};

const toggleNodeRecursively = (node: PermissionNode, checked: boolean, currentPermissions: any) => {
  let updated = { ...currentPermissions };
  
  const recurse = (n: PermissionNode) => {
    if (n.permissionPath) {
      updated = setNestedValue(updated, n.permissionPath, checked);
    }
    if (n.children) {
      n.children.forEach(recurse);
    }
  };

  recurse(node);
  return updated;
};

// Reusable cascading permission-tree editor. Used by the Roles editor (a role's own
// `permissions` JSON) — the single place permissions are now configured, since users are
// assigned roles rather than having permissions edited directly.
const PERMISSION_TREE: PermissionNode[] = buildPermissionTree();
const PERMISSION_TREE_ALL_NODE_IDS: Record<string, boolean> = Object.fromEntries(
  allPermissionNodeIds(PERMISSION_TREE).map(id => [id, true])
);

function PermissionTree({ permissions, onChange, t }: { permissions: any; onChange: (updated: any) => void; t: (key: string) => string }) {
  const [expandedNodes, setExpandedNodes] = React.useState<Record<string, boolean>>(PERMISSION_TREE_ALL_NODE_IDS);

  const handleToggle = (node: PermissionNode, checked: boolean) => {
    onChange(toggleNodeRecursively(node, checked, permissions || {}));
  };

  const TreeNode = ({ node, depth = 0 }: { key?: string; node: PermissionNode; depth?: number }) => {
    const isExpanded = !!expandedNodes[node.id];
    const hasChildren = node.children && node.children.length > 0;

    const fullyChecked = isNodeFullyChecked(node, permissions);
    const partiallyChecked = isNodePartiallyChecked(node, permissions);

    const toggleExpanded = () => {
      setExpandedNodes(prev => ({ ...prev, [node.id]: !prev[node.id] }));
    };

    return (
      <div className="relative select-none">
        <div className="flex items-center gap-2 py-1.5 relative">
          {depth > 0 && (
            <div className="absolute left-[-16px] top-[-8px] bottom-[14px] w-[1px] border-l border-dashed border-slate-300" />
          )}
          {depth > 0 && (
            <div className="absolute left-[-16px] top-[14px] w-[14px] h-[1px] border-b border-dashed border-slate-300" />
          )}

          {hasChildren ? (
            <button
              type="button"
              onClick={toggleExpanded}
              className="w-4 h-4 shrink-0 flex items-center justify-center border border-slate-300 bg-slate-50 text-slate-500 rounded text-[11px] font-black hover:bg-slate-100 transition cursor-pointer z-10"
            >
              {isExpanded ? '-' : '+'}
            </button>
          ) : (
            <div className="w-4 h-4 shrink-0" />
          )}

          <div className="relative flex items-center justify-center">
            <input
              type="checkbox"
              checked={fullyChecked}
              ref={el => {
                if (el) el.indeterminate = partiallyChecked;
              }}
              onChange={(e) => handleToggle(node, e.target.checked)}
              className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5 cursor-pointer"
            />
          </div>

          <span
            onClick={hasChildren ? toggleExpanded : undefined}
            className={`text-xs text-slate-700 cursor-pointer flex items-center gap-1.5 hover:text-indigo-600 transition ${hasChildren ? 'font-semibold text-slate-800' : 'text-slate-600 font-medium'}`}
          >
            {hasChildren ? (
              <span className="text-[12px] filter grayscale shrink-0">📁</span>
            ) : (
              <span className="text-[12px] filter grayscale shrink-0">⚙️</span>
            )}
            {t(node.label)}
          </span>
        </div>

        {hasChildren && isExpanded && (
          <div className="pl-6 border-l border-dashed border-slate-200 ml-[7px] space-y-0.5">
            {node.children!.map((child) => (
              <TreeNode key={child.id} node={child} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200/60 space-y-3">
      <div className="flex items-center justify-between border-b border-slate-200 pb-2">
        <div>
          <p className="text-[10px] font-extrabold text-slate-800 uppercase tracking-wider">{t('Permissions Tree')}</p>
          <p className="text-[9px] text-slate-500">{t('Configure cascading module & directory usecases')}</p>
        </div>
        <button
          type="button"
          onClick={() => setExpandedNodes(PERMISSION_TREE_ALL_NODE_IDS)}
          className="text-[9px] font-bold text-indigo-600 hover:text-indigo-800 uppercase cursor-pointer"
        >
          {t('Expand All')}
        </button>
      </div>
      <div className="pt-1 px-1 space-y-1">
        {PERMISSION_TREE.map((node) => (
          <TreeNode key={node.id} node={node} depth={0} />
        ))}
      </div>
    </div>
  );
}

interface SettingsSubTab {
  id: string;
  label: string;
  icon: any;
  superAdminOnly?: boolean;
  adminOnly?: boolean;
  requiredPermission?: string | string[];
}

// Each sub-tab declares exactly one of:
//   - superAdminOnly: true       -> visible only to a real super-admin
//   - adminOnly: true            -> visible only at company-admin tier or above; no
//                                    delegable permission exists for this tab on purpose
//                                    (see the permission-crud-model skill for which areas
//                                    are deliberately kept off the Role system entirely -
//                                    ZATCA config, Role definition, the Companies
//                                    directory, Translations, and Database Backup/Sync,
//                                    none of which are safe or requested to delegate.
//                                    Company Profile used to be on this list too but is
//                                    now delegable via companyProfile.read/update — see
//                                    that leaf's own comment in permissionSchema.ts for
//                                    why zatcaEnabled specifically stays excluded even
//                                    though it's saved through the same endpoint)
//   - requiredPermission: '...' or [...] -> visible to an admin, OR to any non-admin
//                                    actor whose Role grants at least one of the listed
//                                    leaves (checked via can()/canAny() below)
// A sub-tab with NONE of these three markers is a bug, not an oversight - isTabVisible()
// fails closed (admin-only) for anything undeclared, so forgetting to mark a new tab
// never accidentally opens it to everyone.
const CATEGORY_GROUPS: { id: string; label: string; icon: any; subTabs: SettingsSubTab[] }[] = [
  {
    id: 'org',
    label: 'Organization & Setup',
    icon: Building,
    subTabs: [
      { id: 'companies', label: 'Companies Directory', icon: Building, superAdminOnly: true },
      { id: 'onboarding', label: 'Onboarding Requests', icon: Inbox, superAdminOnly: true },
      { id: 'roleTemplates', label: 'Role Templates', icon: Layers, superAdminOnly: true },
      { id: 'company', label: 'Company Profile', icon: Settings, requiredPermission: 'companyProfile.read' },
      { id: 'zatca', label: 'ZATCA Phase 2 E-Invoicing', icon: ShieldCheck, adminOnly: true },
      { id: 'banks', label: 'Bank Accounts', icon: Wallet, requiredPermission: 'banks.read' },
      { id: 'taxes', label: 'Tax Slabs', icon: Percent, requiredPermission: 'taxSlabs.read' },
      { id: 'branches', label: 'Branches (Locations)', icon: MapPin, requiredPermission: 'branches.read' },
      { id: 'numbering', label: 'Document Numbering', icon: Hash, requiredPermission: 'documentNumbering.read' },
    ]
  },
  {
    id: 'ops',
    label: 'Operations & Config',
    icon: Sliders,
    subTabs: [
      { id: 'templates', label: 'Document Templates', icon: FileSpreadsheet, requiredPermission: 'templates.read' },
      // POS Terminal Settings edits company.posSettings via the same admin-tier-only
      // route as Company Profile (PATCH /companies/:id/settings) - no companySettings
      // permission was built (deliberately dropped, see BACKLOG item 61), so this stays
      // admin-only too.
      { id: 'pos', label: 'POS Terminal Settings', icon: ShoppingCart, adminOnly: true },
      { id: 'translations', label: 'Translations', icon: Languages, superAdminOnly: true },
    ]
  },
  {
    id: 'governance',
    label: 'Governance & Staff',
    icon: UserCheck,
    subTabs: [
      { id: 'users', label: 'Staff Permissions', icon: UserCheck, requiredPermission: 'users.read' },
      // Role *definition* stays admin-only on purpose - the "who sets the boundaries"
      // layer shouldn't be delegable to something the boundaries apply to.
      { id: 'roles', label: 'Roles', icon: Shield, adminOnly: true },
    ]
  },
  {
    id: 'ledger',
    label: 'Fiscal & Capital',
    icon: Calendar,
    subTabs: [
      { id: 'months', label: 'Month Opening / Closing', icon: Calendar, requiredPermission: ['fiscalMonths.open', 'fiscalMonths.close'] },
      { id: 'equity', label: 'Capital & Equity', icon: Coins, requiredPermission: 'investors.access' },
      { id: 'taxReturns', label: 'VAT Returns (ZATCA Filing)', icon: FileCheck, requiredPermission: ['taxReturns.create', 'taxReturns.read', 'taxReturns.delete', 'taxReturns.file'] },
    ]
  },
  {
    id: 'data',
    label: 'System & Backup',
    icon: Database,
    subTabs: [
      // Export/import/force-push/audit-purge live here - dangerous whole-tenant-data
      // operations, never proposed for delegation.
      { id: 'database', label: 'Database Backup & Sync', icon: Database, adminOnly: true },
      // Forcibly ending another staff member's session is the same tier as the above -
      // admin-only, not a delegable permission leaf.
      { id: 'sessions', label: 'Active Sessions', icon: Monitor, adminOnly: true },
    ]
  }
];

// Classic Sidebar layout only — Sleek Hub doesn't use per-tab icon colors (it colors
// the whole button on active state instead), but Classic Sidebar's icons were always
// individually colored, so this preserves that look now that it renders from
// CATEGORY_GROUPS instead of its own hardcoded copy.
const CLASSIC_SIDEBAR_ICON_COLOR: Record<string, string> = {
  companies: 'text-indigo-500',
  company: 'text-amber-500',
  zatca: 'text-sky-500',
  banks: 'text-blue-500',
  taxes: 'text-violet-500',
  templates: 'text-emerald-500',
  pos: 'text-pink-500',
  translations: 'text-fuchsia-500',
  users: 'text-slate-500',
  roles: 'text-cyan-500',
  months: 'text-orange-500',
  equity: 'text-amber-500',
  database: 'text-emerald-500',
};

interface AdminSettingsProps {
 db: DatabaseState;
 // setDb-only local state update (App.tsx's handleUpdateDbLocal) — no /api/migrate POST.
 // Used where a real route already persisted the change (or nothing needed persisting at
 // all, e.g. a pure company-view switch) and the call was only reflecting that in local
 // state. Force Publish to Cloud and Import Database (file/pasted) below call
 // /api/migrate directly with a full backup blob instead — that's deliberate for both:
 // they're explicit, rare, admin-initiated whole-database operations where "overwrite the
 // server with what I have" is the actual intent, not an accident, and there's no
 // sensible per-record route to migrate a backup restore to. Deliberately a
 // function-updater only, not a raw DatabaseState — see App.tsx's handleUpdateDbLocal
 // comment for the incident this prevents at compile time.
 onUpdateDbLocal: (updater: (prev: DatabaseState) => DatabaseState) => void;
 onRefreshDb?: () => Promise<void>;
 defaultTab?: 'company' | 'banks' | 'taxes' | 'templates' | 'months' | 'users' | 'roles' | 'equity' | 'companies' | 'database' | 'zatca';
}

export default function AdminSettings({ db, onUpdateDbLocal, onRefreshDb, defaultTab }: AdminSettingsProps) {
 const { t } = useTranslation(db);
 const isAdmin = db.currentUser?.role === 'admin' || db.currentUser?.isSuperAdmin === true;
 const { can } = usePermissions(db.currentUser);
 const canAny = (key: string | string[]): boolean => Array.isArray(key) ? key.some(k => can(k)) : can(key);
 // Per-module CRUD grants for the six tabs newly reachable by non-admin actors via
 // requiredPermission (see CATEGORY_GROUPS above). can() already resolves true for any
 // admin/super-admin internally, so these are safe to use uniformly for both tiers.
 const canCreateBanks = can('banks.create');
 const canUpdateBanks = can('banks.update');
 const canDeleteBanks = can('banks.delete');
 const canTransferBanks = can('banks.transfer');
 const canCreateTaxSlabs = can('taxSlabs.create');
 const canUpdateTaxSlabs = can('taxSlabs.update');
 const canUpdateBranches = can('branches.update');
 const canDeleteBranches = can('branches.delete');
 const canUpdateDocumentNumbering = can('documentNumbering.update');
 const canCreateTemplates = can('templates.create');
 const canUpdateTemplates = can('templates.update');
 const canDeleteTemplates = can('templates.delete');
 const canCreateUsers = can('users.create');
 const canUpdateUsers = can('users.update');
 const canDeleteUsers = can('users.delete');
 const canOpenFiscalMonths = can('fiscalMonths.open');
 const canCloseFiscalMonths = can('fiscalMonths.close');
 // No separate canAccessInvestors const / per-button gate: the Capital & Equity tab's
 // CATEGORY_GROUPS entry already requires investors.access to render at all (isAdmin ||
 // can('investors.access') via isTabVisible), and every mutating route this tab's forms
 // call (POST /transactions/investors, its contribution-recording counterpart) checks
 // that exact same single flag server-side — so tab-level visibility already is the
 // correct, non-redundant gate for every action inside it.
 // See CATEGORY_GROUPS' header comment for what each marker means. Fails closed:
 // a sub-tab with none of the three markers is treated as admin-only, never as open to
 // everyone - forgetting to mark a new tab can only make it too restrictive, not too open.
 const isTabVisible = (st: SettingsSubTab): boolean => {
   if (st.superAdminOnly) return !!db.currentUser?.isSuperAdmin;
   if (st.adminOnly) return isAdmin;
   if (st.requiredPermission) return canAny(st.requiredPermission);
   return isAdmin;
 };
 const firstVisibleTabId = (): string => {
   for (const cat of CATEGORY_GROUPS) {
     const found = cat.subTabs.find(st => isTabVisible(st));
     if (found) return found.id;
   }
   return 'company';
 };
 const [activeTab, setActiveTab] = React.useState<'company' | 'banks' | 'taxes' | 'templates' | 'months' | 'users' | 'roles' | 'equity' | 'companies' | 'database' | 'translations' | 'pos' | 'zatca'>(() => {
   const requested = CATEGORY_GROUPS.flatMap(c => c.subTabs).find(s => s.id === defaultTab);
   if (requested && isTabVisible(requested)) return defaultTab as any;
   return firstVisibleTabId() as any;
 });
 const [useSleekLayout, setUseSleekLayout] = React.useState<boolean>(true);
 const activeCatGroup = CATEGORY_GROUPS.find(cat => cat.subTabs.some(st => st.id === activeTab)) || CATEGORY_GROUPS[0];
 const [previewTemplate, setPreviewTemplate] = React.useState<DocumentTemplate | null>(null);

  const [fiscalMonths, setFiscalMonths] = React.useState<any[]>([]);
  const fetchMonths = async () => {
    if (!db.selectedCompanyId) return;
    try {
      const resp = await fetch(`/api/transactions/months`);
      if (!resp.ok) {
        console.warn(`Failed to fetch fiscalMonths in AdminSettings (status ${resp.status})`);
        return;
      }
      const contentType = resp.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        console.warn("Received non-JSON response for fiscalMonths in AdminSettings");
        return;
      }
      const data = await resp.json();
      if (Array.isArray(data)) {
        setFiscalMonths(data);
        // Sync back to db.months if needed
        onUpdateDbLocal(prev => ({
          ...prev,
          months: [...(prev.months || []).filter(m => m.companyId !== db.selectedCompanyId), ...data]
        }));
      } else {
        console.warn("Received non-array data for fiscal months in AdminSettings:", data);
      }
    } catch (e) {
      console.error("Failed to fetch fiscalMonths in AdminSettings:", e);
    }
  };

  React.useEffect(() => {
    fetchMonths();
  }, [db.selectedCompanyId]);

  React.useEffect(() => {
    if (db.months) {
      const filtered = db.months.filter(m => m.companyId === db.selectedCompanyId);
      setFiscalMonths(filtered);
    }
  }, [db.months, db.selectedCompanyId]);
 React.useEffect(() => {
 if (defaultTab) {
 setActiveTab(defaultTab);
 }
 }, [defaultTab]);

 const currencySymbol = db.companySetup?.currency || 'SAR';
 const formRef = React.useRef<HTMLDivElement>(null);

 // Success/Error notifications
 const [successMsg, setSuccessMsg] = React.useState<string | null>(null);
 const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

 const triggerSuccess = (msg: string) => {
 setSuccessMsg(msg);
 window.scrollTo({ top: 0, behavior: 'smooth' });
 setTimeout(() => setSuccessMsg(null), 4000);
 };

 const triggerError = (msg: string) => {
 setErrorMsg(msg);
 window.scrollTo({ top: 0, behavior: 'smooth' });
 setTimeout(() => setErrorMsg(null), 5000);
 };

 const [transFilterModule, setTransFilterModule] = React.useState<string>('All');
 const [transSearchQuery, setTransSearchQuery] = React.useState<string>('');
 // Edits are explicit, single-record transactions (Create/Update/Delete), not a
 // per-keystroke or whole-array sync — see BACKLOG.md. That means the list can read
 // db.translations directly instead of keeping its own local mirror: nothing here
 // writes until a modal's Save button is clicked, and a successful write always
 // refetches via onRefreshDb before the modal closes.
 const [translationModal, setTranslationModal] = React.useState<{ mode: 'add' | 'edit'; id?: string; key: string; en: string; ar: string; ur: string } | null>(null);
 const [isSavingTranslation, setIsSavingTranslation] = React.useState(false);
 const [deletingTranslationId, setDeletingTranslationId] = React.useState<string | null>(null);

 // Database backup and portability state
 const [copied, setCopied] = React.useState(false);
 const [pastedJson, setPastedJson] = React.useState('');

 // --- Audit Logs State & Actions ---
 const [auditLogs, setAuditLogs] = React.useState<any[]>([]);
 const [isLoadingAudit, setIsLoadingAudit] = React.useState(false);
 const [auditSearch, setAuditSearch] = React.useState('');
 const [auditActionFilter, setAuditActionFilter] = React.useState('');
 const [auditTypeFilter, setAuditTypeFilter] = React.useState('');
 const [isConfirmingPurge, setIsConfirmingPurge] = React.useState(false);

 const fetchAuditLogs = async () => {
   setIsLoadingAudit(true);
   try {
     const activeUserId = db.currentUser?.id || localStorage.getItem('erp_session_user_id') || localStorage.getItem('erp_active_user_id') || 'admin';
     const activeSessionId = localStorage.getItem('erp_session_id') || localStorage.getItem('erp_active_session_id') || '';
     let url = `/api/audit-logs?companyId=${db.selectedCompanyId || 'all'}&userId=${encodeURIComponent(activeUserId)}&sessionId=${encodeURIComponent(activeSessionId)}`;
     if (auditSearch) url += `&search=${encodeURIComponent(auditSearch)}`;
     if (auditActionFilter) url += `&action=${encodeURIComponent(auditActionFilter)}`;
     if (auditTypeFilter) url += `&entityType=${encodeURIComponent(auditTypeFilter)}`;
     
     const response = await fetch(url, {
       headers: {
         'X-User-ID': activeUserId,
         'X-Session-ID': activeSessionId,
         'Authorization': `Bearer ${activeUserId}`
       }
     });
     const data = await response.json();
     if (response.ok && Array.isArray(data)) {
       setAuditLogs(data);
     } else {
       setAuditLogs([]);
     }
   } catch (error) {
     console.error('Failed to fetch audit logs:', error);
     setAuditLogs([]);
   } finally {
     setIsLoadingAudit(false);
   }
 };

 const handlePurgeAuditLogs = async () => {
   try {
     const activeUserId = db.currentUser?.id || localStorage.getItem('erp_session_user_id') || localStorage.getItem('erp_active_user_id') || 'admin';
     const activeSessionId = localStorage.getItem('erp_session_id') || localStorage.getItem('erp_active_session_id') || '';
     const response = await fetch(`/api/audit-logs/purge?userId=${encodeURIComponent(activeUserId)}&sessionId=${encodeURIComponent(activeSessionId)}`, {
       method: 'POST',
       headers: {
         'Content-Type': 'application/json',
         'X-User-ID': activeUserId,
         'X-Session-ID': activeSessionId,
         'Authorization': `Bearer ${activeUserId}`
       }
     });
     const result = await response.json();
     if (response.ok && result.success) {
       triggerSuccess('Audit logs older than 1 year purged successfully.');
       setIsConfirmingPurge(false);
       fetchAuditLogs();
     } else {
       triggerError(`Failed to purge audit logs: ${result.error || 'Unknown error'}`);
     }
   } catch (err: any) {
     triggerError(`Error purging audit logs: ${err.message}`);
   }
 };

 React.useEffect(() => {
   if (activeTab === 'database') {
     fetchAuditLogs();
   }
 }, [activeTab, db.selectedCompanyId, auditSearch, auditActionFilter, auditTypeFilter]);

 const [activeSessions, setActiveSessions] = React.useState<any[]>([]);
 const [sessionsLoading, setSessionsLoading] = React.useState(false);
 const [revokingSid, setRevokingSid] = React.useState<string | null>(null);
 const [currentSessionId, setCurrentSessionId] = React.useState<string | null>(null);

 const loadActiveSessions = React.useCallback(async () => {
   setSessionsLoading(true);
   try {
     const res = await fetch('/api/admin/sessions');
     const data = await res.json().catch(() => ({}));
     if (res.ok) {
       setActiveSessions(data.sessions || []);
       setCurrentSessionId(data.currentSessionId || null);
     } else {
       setActiveSessions([]);
     }
   } finally {
     setSessionsLoading(false);
   }
 }, []);

 React.useEffect(() => {
   if (activeTab === 'sessions') loadActiveSessions();
 }, [activeTab, loadActiveSessions]);

 const handleRevokeSession = async (sid: string, username: string) => {
   if (!window.confirm(t('Revoke this session? The user will be signed out immediately.') + ` (${username})`)) return;
   setRevokingSid(sid);
   try {
     const res = await fetch(`/api/admin/sessions/${sid}`, { method: 'DELETE' });
     const data = await res.json().catch(() => ({}));
     if (res.ok) {
       triggerSuccess(t('Session revoked.'));
       loadActiveSessions();
     } else {
       triggerError(data.error || t('Failed to revoke session.'));
     }
   } finally {
     setRevokingSid(null);
   }
 };

 const handleExportDb = async () => {
 try {
 const activeUserId = db.currentUser?.id || localStorage.getItem('erp_session_user_id') || localStorage.getItem('erp_active_user_id') || 'admin';
 const activeSessionId = localStorage.getItem('erp_session_id') || localStorage.getItem('erp_active_session_id') || '';
 
 triggerSuccess('Generating PostgreSQL SQL Backup...');
 const response = await fetch(`/api/export-postgres?userId=${encodeURIComponent(activeUserId)}&sessionId=${encodeURIComponent(activeSessionId)}`, { headers: { 'X-User-ID': activeUserId, 'X-Session-ID': activeSessionId, 'Authorization': `Bearer ${activeUserId}` } });
 
 if (!response.ok) {
   let errMsg = `Server returned status: ${response.status}`;
   try {
     const errData = await response.json();
     if (errData && errData.error) {
       errMsg = errData.error;
     }
   } catch (_) {}
   throw new Error(errMsg);
 }
 
 const blob = await response.blob();
 const url = window.URL.createObjectURL(blob);
 const exportFileDefaultName = `postgres_backup_${new Date().toISOString().split('T')[0]}.sql`;
 
 const linkElement = document.createElement('a');
 linkElement.setAttribute('href', url);
 linkElement.setAttribute('download', exportFileDefaultName);
 linkElement.click();
 window.URL.revokeObjectURL(url);
 triggerSuccess('Database exported successfully as .sql file from PostgreSQL!');
 } catch (err: any) {
 console.error("Database export error:", err);
 triggerError('Failed to export database: ' + err.message);
 }
 };

 const handleCopyToClipboard = () => {
 try {
 navigator.clipboard.writeText(JSON.stringify(db, null, 2));
 setCopied(true);
 triggerSuccess('Database JSON copied to clipboard!');
 setTimeout(() => setCopied(false), 3000);
 } catch (err) {
 triggerError('Failed to copy database to clipboard.');
 }
 };

 const handleForcePushToCloud = async () => {
 // Previously a no-op: this unconditionally showed a success toast with no fetch call
 // at all, so an admin clicking "Force Publish" to recover from a suspected sync issue
 // was told it worked regardless of what actually happened (nothing). Now genuinely
 // pushes the current in-memory db to the same /api/migrate endpoint every other write
 // in the app uses, and only reports success on a real 2xx response.
 try {
 const res = await fetch('/api/migrate', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify(db),
 });
 if (!res.ok) {
 const body = await res.json().catch(() => ({}));
 triggerError(body.error || `Failed to publish to cloud (server returned ${res.status}).`);
 return;
 }
 triggerSuccess('Successfully published local database to Cloud!');
 if (onRefreshDb) await onRefreshDb();
 } catch (err: any) {
 triggerError('Failed to publish to cloud: ' + err.message);
 }
 };

  const [downloadingZip, setDownloadingZip] = React.useState(false);

   const handleDownloadSourceCode = async () => {
    try {
      const activeUserId = db.currentUser?.id || localStorage.getItem('erp_session_user_id') || '';
      const activeSessionId = localStorage.getItem('erp_session_id') || '';
      
      setDownloadingZip(true);
      triggerSuccess('Generating and packing source code ZIP file on server...');
      
      const response = await fetch(`/api/download-source-code?userId=${encodeURIComponent(activeUserId)}&sessionId=${encodeURIComponent(activeSessionId)}`, { 
        headers: { 
          'X-User-ID': activeUserId, 
          'X-Session-ID': activeSessionId, 
          'Authorization': `Bearer ${activeUserId}` 
        } 
      });
      
      if (!response.ok) {
        let errMsg = `Server returned status: ${response.status} ${response.statusText}`;
        try {
          const errData = await response.json();
          if (errData && errData.error) {
            errMsg = errData.error;
          }
        } catch (_) {}
        throw new Error(errMsg);
      }
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      
      const linkElement = document.createElement('a');
      linkElement.setAttribute('href', url);
      linkElement.setAttribute('download', 'source_code.zip');
      linkElement.click();
      window.URL.revokeObjectURL(url);
      triggerSuccess('Source code ZIP downloaded successfully!');
    } catch (err: any) {
      console.error("Error downloading source code:", err);
      triggerError('Failed to download source code ZIP: ' + err.message);
    } finally {
      setDownloadingZip(false);
    }
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileReader = new FileReader();
    if (e.target.files && e.target.files[0]) {
      const fileName = e.target.files[0].name.toLowerCase();
      fileReader.readAsText(e.target.files[0], "UTF-8");
      fileReader.onload = async (event) => {
        try {
          const content = event.target?.result as string;
          let parsed;
          if (fileName.endsWith('.xml')) {
            const parser = new XMLParser();
            const rawParsed = parser.parse(content);
            parsed = rawParsed.DatabaseState || rawParsed.root || rawParsed;
          } else {
            parsed = JSON.parse(content);
          }
          
          if (!parsed.users || !parsed.companies) {
            throw new Error("Invalid schema");
          }
          
          triggerSuccess('Uploading database to Cloud Database...');
          
          const res = await fetch('/api/migrate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(parsed)
          });
          
          if (!res.ok) {
            const errJson = await res.json().catch(() => ({}));
            throw new Error(errJson.error || 'Database sync failed on server');
          }
           
          triggerSuccess('Database synchronized! Portal will reload shortly...');
          setTimeout(() => {
            window.location.reload();
          }, 1500);
        } catch (error: any) {
          triggerError(error.message || 'Invalid backup file structure. Please ensure it is a valid ERP JSON/XML backup.');
        }
      };
    }
  };

  const handleImportPasted = async () => {
    try {
      const parsed = JSON.parse(pastedJson);
      if (!parsed.users || !parsed.companies) {
        throw new Error("Invalid schema");
      }
      
      triggerSuccess('Uploading database to Cloud Database...');
      
      const res = await fetch('/api/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed)
      });
      
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || 'Database sync failed on server');
      }
       
      triggerSuccess('Database synchronized! Portal will reload shortly...');
      setPastedJson('');
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } catch (error: any) {
      triggerError(error.message || 'Invalid pasted JSON structure. Please check the content and try again.');
    }
  };

 // ----------------------------------------
 // SUB-TAB: COMPANIES MANAGEMENT (SUPER-ADMIN ONLY)
 // ----------------------------------------
 const [newCompany, setNewCompany] = React.useState<CompanySetup>({
 id: '',
 name: '',
 address: '',
 phone: '',
 email: '',
 logoUrl: '',
 customHeader: '',
 customFooter: '',
 vatNumber: '',
 themeId: 'classic-executive',
 currency: 'SAR',
 portalTitle: '',
 portalSubtitle: '',
 isInventoryModuleEnabled: false,
 inventorySettings: { prOptionality: 'OPTIONAL', isDsdAllowed: true },
 counters: {
 quotation: 1001,
 invoice: 1001,
 expense: 1001,
 voucher: 1001
 }
 });

 const [newCompLogoDragging, setNewCompLogoDragging] = React.useState(false);

 const handleNewCompLogoFile = (file: File) => {
 if (!file.type.startsWith('image/') && !file.name.endsWith('.bmp')) {
 triggerError('Please upload a valid image file (PNG, JPG, BMP, WEBP).');
 return;
 }
 const reader = new FileReader();
 reader.onload = (e) => {
 const rawBase64 = e.target?.result as string;
 if (rawBase64) {
 const converted = ensureCompatibleImage(rawBase64);
 setNewCompany(prev => ({ ...prev, logoUrl: converted }));
 triggerSuccess('New organization logo uploaded and optimized successfully!');
 }
 };
 reader.onerror = () => {
 triggerError('Error reading logo file.');
 };
 reader.readAsDataURL(file);
 };

 const handleAddCompany = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!newCompany.name.trim()) return triggerError('Company name is required.');
 if (newCompany.vatNumber && !/^\d{15}$/.test(newCompany.vatNumber)) {
 return triggerError('VAT number must be exactly 15 digits.');
 }

 const companyIdClean = generateId();

 const brandTitle = newCompany.portalTitle?.trim() || (newCompany.name.substring(0, 10).toUpperCase() + ' PORTAL');
 const brandSubtitle = newCompany.portalSubtitle?.trim() || 'Shop ERP System';

 const finalizedCompany: CompanySetup = {
 ...newCompany,
 id: companyIdClean,
 portalTitle: brandTitle,
 portalSubtitle: brandSubtitle,
 themeId: newCompany.themeId || 'classic-executive',
 currency: newCompany.currency || 'SAR',
 counters: {
 quotation: Number(newCompany.counters?.quotation) || 1001,
 invoice: Number(newCompany.counters?.invoice) || 1001,
 expense: Number(newCompany.counters?.expense) || 1001,
 voucher: Number(newCompany.counters?.voucher) || 1001,
 }
 };

 // Auto-create standard resources for the new organization so that it's instantly
 // operational. IDs here must be plain generateId() output — bankAccounts.id,
 // customers.id, vendors.id, and documentTemplates.id are all real Postgres `uuid`
 // columns (BACKLOG.md item 25's schema migration); a string prefix glued onto a
 // UUID like 'tmpl-<uuid>' isn't valid UUID syntax and Postgres rejects it outright.
 // Found live: this silently broke the entire rest of new-company onboarding
 // (bank/customer/vendor/template never got created) every time, with only a generic
 // "sync failed" surfaced to the user — the company row itself still saves fine since
 // that's now a separate, successful API call.
 const newBank: BankAccount = {
 id: generateId(),
 bankName: 'Main Operating Bank',
 accountNumber: 'SA' + Math.floor(1000000000000000000000 + Math.random() * 9000000000000000000000).toString(),
 accountTitle: `${finalizedCompany.name} Operating Account`,
 openingBalance: 0,
 isActive: true,
 isDefault: true,
 companyId: finalizedCompany.id
 };

 // B2C: ZATCA only requires a name for these (see validateBuyerFields) — these system
 // placeholder records have no real VAT/address to give, so they must be B2C, not the
 // schema's B2B default, or the real /api/customers /api/vendors routes reject them.
 const newCustomer: Customer = {
 id: generateId(),
 name: 'Walk-in Customer',
 phone: '-',
 email: '-',
 address: '-',
 isSystem: true,
 buyerType: 'B2C',
 companyId: finalizedCompany.id
 };

 const newVendor: Vendor = {
 id: generateId(),
 name: 'Cash Vendor',
 phone: '-',
 email: '-',
 address: '-',
 isSystem: true,
 buyerType: 'B2C',
 companyId: finalizedCompany.id
 };

 // Every company gets one default warehouse from day one, same reasoning as branches'
 // own auto-provisioned warehouse (server/routes/branches.ts): without one, a company
 // that never bothers creating a branch at all (a genuine single-location business)
 // would have zero warehouses until someone remembers to create one manually, and any
 // stock-item sale hard-fails until then. Fixed English label by explicit product
 // decision (previously named after the company itself to support Arabic/Urdu company
 // names — that reasoning is intentionally overridden here; kept in sync with
 // companyProvisioning.ts's server-side equivalent).
 // POST /api/warehouses already auto-promotes a company's very first warehouse to
 // isCompanyDefault, so nothing extra is needed here for that.
 const newWarehouse: Warehouse = {
 id: generateId(),
 name: 'Main Warehouse',
 code: 'MAIN',
 isActive: true,
 companyId: finalizedCompany.id,
 type: 'sales',
 // Always true here — this is unconditionally the company's very first warehouse in
 // this flow (a brand-new company, zero pre-existing warehouses possible), matching
 // what the server independently computes for the same reason (POST /api/warehouses).
 isCompanyDefault: true,
 };

 const newTemplate: DocumentTemplate = {
 id: generateId(),
 name: 'Standard English (A4)',
 language: 'English',
 pageSize: '8.27in x 11.69in (A4)',
 isActive: true,
 printHeader: true,
 printFooter: true,
 printLogo: true,
 printQrCode: true,
 companyId: finalizedCompany.id
 };

 // Kept in parity with companyProvisioning.ts's server-side onboarding-approval flow —
 // the two starter-resource lists had drifted (this path was missing both of these),
 // so a company created manually here had zero tax slabs (empty VAT dropdown on every
 // Invoice/Quotation/Expense/POS form) and no default unit of measure.
 const newTaxSlab = {
 id: generateId(),
 name: 'Standard VAT',
 percentage: 15,
 isDefault: true,
 companyId: finalizedCompany.id
 };

 const newUnitOfMeasure = {
 id: generateId(),
 name: 'Piece',
 code: 'PCE',
 isActive: true,
 companyId: finalizedCompany.id
 };

 // The company's starting open month is the REAL current month at creation time, not
 // a hardcoded date — a brand-new organization created any time after this line was
 // originally written would otherwise start with "June 2026" open regardless of
 // today's actual date (found live: still hardcoded months after this session's
 // multi-open-month work). No fabricated pre-closed prior month either — that
 // invented a "May 2026" with meaningless zero P&L that served no real purpose; a
 // new company just starts with its actual current month open.
 const now = new Date();
 const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
 const currentMonthId = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
 const currentMonthName = `${monthNames[now.getMonth()]} ${now.getFullYear()}`;
 const newMonths: FiscalMonth[] = [
 { id: currentMonthId, name: currentMonthName, status: 'Open', companyId: finalizedCompany.id }
 ];

 // Create the company row itself via the real, dedicated, super-admin-gated route —
 // not the generic blob-sync path. That path always echoes back the caller's ENTIRE
 // current in-memory state (every table, not just what changed) on every save anywhere
 // in the app, which is exactly what let an already-open stale browser tab silently
 // RESURRECT companies that had been deliberately deleted, just by saving something
 // unrelated (confirmed live, twice). migrateData.ts's companies handling is now
 // update-only specifically to close that hole. The rest of this organization's
 // starter setup (bank/customer/vendor/template/fiscal month) now goes through its own
 // dedicated real route too, same reasoning — each call explicitly targets the brand-
 // new company via `companyId` in the body (this admin's own req.targetCompanyId is
 // whatever company they're currently viewing, not the one just created; the auth
 // middleware honors an explicit companyId in the body for super-admins only, which is
 // exactly who this form is gated to).
 const createResource = async (path: string, payload: any, label: string): Promise<boolean> => {
 try {
 const res = await fetch(path, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ ...payload, companyId: finalizedCompany.id }),
 });
 if (!res.ok) {
 const body = await res.json().catch(() => ({}));
 triggerError(body.error || `Failed to create starter ${label} for the new organization.`);
 return false;
 }
 return true;
 } catch {
 triggerError(`Failed to create starter ${label} — check your connection and try again.`);
 return false;
 }
 };

 try {
 const res = await fetch('/api/companies', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify(finalizedCompany),
 });
 if (!res.ok) {
 const body = await res.json().catch(() => ({}));
 triggerError(body.error || 'Failed to create company — the server rejected this request.');
 return;
 }
 } catch (err: any) {
 triggerError('Failed to create company — check your connection and try again.');
 return;
 }

 if (!(await createResource('/api/banks', newBank, 'bank account'))) return;
 if (!(await createResource('/api/customers', newCustomer, 'customer'))) return;
 if (!(await createResource('/api/vendors', newVendor, 'vendor'))) return;
 if (!(await createResource('/api/tax-slabs', newTaxSlab, 'tax slab'))) return;
 if (!(await createResource('/api/warehouses', newWarehouse, 'warehouse'))) return;
 if (!(await createResource('/api/units-of-measure', newUnitOfMeasure, 'unit of measure'))) return;
 if (!(await createResource('/api/templates', newTemplate, 'document template'))) return;
 for (const month of newMonths) {
 if (!(await createResource('/api/transactions/months', month, 'fiscal month'))) return;
 }

 // Merge into local state only — everything above is already persisted via its own
 // real route, so no further blob sync is needed here.
 // Save and update — every table above was already persisted via its own real route.
 onUpdateDbLocal(prev => ({
 ...prev,
 companies: [...(prev.companies || []), finalizedCompany],
 banks: [...prev.banks, newBank],
 customers: [...prev.customers, newCustomer],
 vendors: [...prev.vendors, newVendor],
 taxSlabs: [...(prev.taxSlabs || []), newTaxSlab],
 warehouses: [...(prev.warehouses || []), newWarehouse],
 unitsOfMeasure: [...(prev.unitsOfMeasure || []), newUnitOfMeasure],
 templates: [...prev.templates, newTemplate],
 months: [...prev.months, ...newMonths]
 }));
 triggerSuccess(`Organization "${finalizedCompany.name}" registered successfully with standard operational defaults!`);

 // Reset form
 setNewCompany({
 id: '',
 name: '',
 address: '',
 phone: '',
 email: '',
 logoUrl: '',
 customHeader: '',
 customFooter: '',
 vatNumber: '',
 themeId: 'classic-executive',
 currency: 'SAR',
 portalTitle: '',
 portalSubtitle: '',
 isInventoryModuleEnabled: false,
 inventorySettings: { prOptionality: 'OPTIONAL', isDsdAllowed: true },
 counters: {
 quotation: 1001,
 invoice: 1001,
 expense: 1001,
 voucher: 1001
 }
 });
 };

 // Master on/off switch for ZATCA Phase 2 submission — Super-Admin manual override,
 // for cases like temporarily pausing ZATCA during a data migration. Auto-enabled
 // separately by the server once a company's Sandbox onboarding completes
 // (server/routes/zatca.ts request-production-csid).
 const handleToggleZatcaEnabled = async (companyId: string, enabled: boolean) => {
   try {
     const res = await fetch(`/api/companies/${companyId}/settings`, {
       method: 'PATCH',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ zatcaEnabled: enabled })
     });
     const data = await res.json().catch(() => ({}));
     if (!res.ok || data.error) {
       return triggerError(data.error || 'Failed to update ZATCA integration setting.');
     }
     triggerSuccess(`Successfully ${enabled ? 'enabled' : 'disabled'} ZATCA integration for organization.`);
     if (onRefreshDb) await onRefreshDb();
   } catch (err: any) {
     triggerError(err.message || 'Failed to update ZATCA integration setting.');
   }
 };

 const handleSetRegistrationStatus = async (companyId: string, status: 'Trial' | 'Registered' | 'Cancelled') => {
   try {
     const res = await fetch(`/api/companies/${companyId}/registration-status`, {
       method: 'PATCH',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ status }),
     });
     const data = await res.json().catch(() => ({}));
     if (!res.ok || data.error) {
       return triggerError(data.error || 'Failed to update registration status.');
     }
     triggerSuccess(`Registration marked "${status}".`);
     if (onRefreshDb) await onRefreshDb();
   } catch (err: any) {
     triggerError(err.message || 'Failed to update registration status.');
   }
 };

 // The single most destructive action in this app — permanently purges a company and
 // every row belonging to it (server/routes/companies.ts). Only reachable here for a
 // Cancelled company (the server refuses otherwise too, as a second gate), and only after
 // typing the company's exact name — a plain Confirm click is not enough for this one.
 const handleConfirmDeleteCompany = async () => {
   if (!deletingCompany) return;
   try {
     const res = await fetch(`/api/companies/${deletingCompany.id}`, { method: 'DELETE' });
     const data = await res.json().catch(() => ({}));
     if (!res.ok || data.error) {
       return triggerError(data.error || 'Failed to delete company.');
     }
     triggerSuccess(`"${deletingCompany.name}" and all of its data have been permanently deleted.`);
     setDeletingCompany(null);
     setDeleteCompanyConfirmText('');
     if (onRefreshDb) await onRefreshDb();
   } catch (err: any) {
     triggerError(err.message || 'Failed to delete company.');
   }
 };

 // ----------------------------------------
 // SUB-TAB: COMPANY SETUP
 // ----------------------------------------
 const [companyForm, setCompanyForm] = React.useState<CompanySetup>({ ...db.companySetup });
 const [isDragging, setIsDragging] = React.useState(false);

 React.useEffect(() => {
 setCompanyForm({ ...db.companySetup });
 }, [db.companySetup]);

 // POS Terminal Settings tab — a local draft, saved explicitly (Save Changes button)
 // instead of the old per-field auto-save-on-every-keystroke behavior (previously every
 // input called handlePosSettingsChange directly, firing a PATCH per change with no
 // explicit save action at all — confusing UX with no confirmation the change "took").
 // Keyed only on the selected company (not on db.companies/posSettings) so an unrelated
 // db refresh elsewhere in the app never wipes an in-progress, unsaved edit here — only
 // switching companies re-syncs the draft from that company's actual saved settings.
 const [posDraft, setPosDraft] = React.useState<any>(() => {
 const ac = db.companies.find(c => c.id === db.selectedCompanyId);
 return { ...(ac?.posSettings || {}) };
 });
 const [isSavingPosSettings, setIsSavingPosSettings] = React.useState(false);
 React.useEffect(() => {
 const ac = db.companies.find(c => c.id === db.selectedCompanyId);
 setPosDraft({ ...(ac?.posSettings || {}) });
 }, [db.selectedCompanyId]);

 const handleLogoFile = (file: File) => {
 if (!file.type.startsWith('image/') && !file.name.endsWith('.bmp')) {
 triggerError('Please upload a valid image file (PNG, JPG, BMP, WEBP).');
 return;
 }

 const reader = new FileReader();
 reader.onload = (e) => {
 const rawBase64 = e.target?.result as string;
 if (rawBase64) {
 // Convert to highly compatible PNG base64 to prevent rendering issues with BMP in standard browsers or iframes
 const converted = ensureCompatibleImage(rawBase64);
 setCompanyForm(prev => ({ ...prev, logoUrl: converted }));
 triggerSuccess('Logo file uploaded and optimized successfully!');
 }
 };
 reader.onerror = () => {
 triggerError('Error reading file.');
 };
 reader.readAsDataURL(file);
 };

 const handleDragOver = (e: React.DragEvent) => {
 e.preventDefault();
 setIsDragging(true);
 };

 const handleDragLeave = () => {
 setIsDragging(false);
 };

 const handleDrop = (e: React.DragEvent) => {
 e.preventDefault();
 setIsDragging(false);
 if (e.dataTransfer.files && e.dataTransfer.files[0]) {
 handleLogoFile(e.dataTransfer.files[0]);
 }
 };

 const handleCompanySave = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!companyForm.name.trim()) return triggerError('Company name is required.');
 // VAT is optional pre-ZATCA-onboarding, but if provided must be a real 15-digit
 // registration number — the input itself already strips non-digits and caps length,
 // this is the final guard against a shorter/pasted value slipping through.
 if (companyForm.vatNumber && !/^\d{15}$/.test(companyForm.vatNumber)) {
 return triggerError('VAT number must be exactly 15 digits.');
 }

 // Process the logo to ensure if it is BMP base64 or raw base64, it is converted to highly compatible PNG base64
 const finalLogoUrl = ensureCompatibleImage(companyForm.logoUrl);

 const updatedForm = { ...companyForm, logoUrl: finalLogoUrl };

 try {
   const res = await fetch(`/api/companies/${updatedForm.id}/settings`, {
     method: 'PATCH',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({
       name: updatedForm.name,
       address: updatedForm.address,
       phone: updatedForm.phone,
       email: updatedForm.email,
       logoUrl: updatedForm.logoUrl,
       customHeader: updatedForm.customHeader,
       customFooter: updatedForm.customFooter,
       vatNumber: updatedForm.vatNumber,
       crNumber: updatedForm.crNumber,
       themeId: updatedForm.themeId,
       currency: updatedForm.currency,
       portalTitle: updatedForm.portalTitle,
       portalSubtitle: updatedForm.portalSubtitle,
     })
   });
   const data = await res.json().catch(() => ({}));
   if (!res.ok || data.error) {
     return triggerError(data.error || 'Failed to update company configuration.');
   }
   setCompanyForm(updatedForm); // Update local form state with processed/optimized base64
   triggerSuccess('Company global configuration updated successfully.');
   if (onRefreshDb) await onRefreshDb();
 } catch (err: any) {
   triggerError(err.message || 'Failed to update company configuration.');
 }
 };

 // POS Configuration tab toggles pass a plain updated-company object (not a form event) on
 // every change — calling handleCompanySave(newComp) crashed on its unconditional
 // e.preventDefault(), and handleCompanySave also reads from companyForm state rather than
 // its argument, so it wouldn't have persisted posSettings anyway. Dedicated handler instead
 // of overloading handleCompanySave's signature, which the real Company Setup form's
 // onSubmit still relies on being a plain (e: React.FormEvent) function.
 const handlePosSettingsChange = async (companyId: string, posSettings: any) => {
 try {
   const res = await fetch(`/api/companies/${companyId}/settings`, {
     method: 'PATCH',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ posSettings })
   });
   const data = await res.json().catch(() => ({}));
   if (!res.ok || data.error) {
     return triggerError(data.error || 'Failed to update POS configuration.');
   }
   if (onRefreshDb) await onRefreshDb();
 } catch (err: any) {
   triggerError(err.message || 'Failed to update POS configuration.');
 }
 };

 // ----------------------------------------
 // SUB-TAB: BANK MANAGEMENT
 // ----------------------------------------
 const [editingBankId, setEditingBankId] = React.useState<string | null>(null);
 const [bankForm, setBankForm] = React.useState<Omit<BankAccount, 'id'>>({
 bankName: '',
 accountNumber: '',
 accountTitle: '',
 openingBalance: 0,
 isActive: true,
 isDefault: false
 });

 const [transferForm, setTransferForm] = React.useState({
 sourceBankId: '',
 destBankId: '',
 amount: '',
 description: '',
 date: new Date().toISOString().split('T')[0]
 });

 const handleAddBank = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!bankForm.bankName.trim()) return triggerError('Bank name is required.');
 if (!bankForm.accountNumber.trim()) return triggerError('Account number is required.');
 if (!bankForm.accountTitle.trim()) return triggerError('Account title is required.');

 try {
   if (editingBankId) {
     const res = await fetch(`/api/banks/${editingBankId}`, {
       method: 'PATCH',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({
         bankName: bankForm.bankName,
         accountTitle: bankForm.accountTitle,
         accountNumber: bankForm.accountNumber,
         openingBalance: bankForm.openingBalance,
         isDefault: bankForm.isDefault
       })
     });
     const data = await res.json().catch(() => ({}));
     if (!res.ok || data.error) return triggerError(data.error || 'Failed to update bank.');
     triggerSuccess(`Bank "${bankForm.bankName}" updated successfully.`);
     setEditingBankId(null);
   } else {
     // If this will be the company's only active bank, it becomes the default
     // regardless of the form checkbox — mirrors the previous client-only behavior.
     const activeBankCount = db.banks.filter(b => b.isActive).length;
     const newBank: BankAccount = {
       ...bankForm,
       id: generateId(),
       companyId: db.selectedCompanyId,
       isDefault: bankForm.isDefault || activeBankCount === 0
     };
     const res = await fetch('/api/banks', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify(newBank)
     });
     const data = await res.json().catch(() => ({}));
     if (!res.ok || data.error) return triggerError(data.error || 'Failed to add bank.');
     triggerSuccess(`Bank "${newBank.bankName}" added successfully.`);
   }

   if (onRefreshDb) await onRefreshDb();
 } catch (err: any) {
   triggerError(err.message || 'An error occurred while saving the bank.');
 }

 setBankForm({
 bankName: '',
 accountNumber: '',
 accountTitle: '',
 openingBalance: 0,
 isActive: true,
 isDefault: false
 });
 };

 const handleSetDefaultBank = async (bankId: string) => {
 try {
   const res = await fetch(`/api/banks/${bankId}/set-default`, { method: 'PATCH' });
   const data = await res.json().catch(() => ({}));
   if (!res.ok || data.error) return triggerError(data.error || 'Failed to update default bank.');
   triggerSuccess('Default bank updated successfully.');
   if (onRefreshDb) await onRefreshDb();
 } catch (err: any) {
   triggerError(err.message || 'Failed to update default bank.');
 }
 };

 const handleToggleBankActive = async (bankId: string) => {
 const bank = db.banks.find(b => b.id === bankId);
 if (!bank) return;
 if (bank.isDefault && bank.isActive) {
 return triggerError('Cannot deactivate the Default Bank. Set another bank as default first.');
 }

 try {
   const res = await fetch(`/api/banks/${bankId}/toggle-active`, { method: 'PATCH' });
   const data = await res.json().catch(() => ({}));
   if (!res.ok || data.error) return triggerError(data.error || 'Failed to toggle bank active status.');
   triggerSuccess('Bank active status toggled.');
   if (onRefreshDb) await onRefreshDb();
 } catch (err: any) {
   triggerError(err.message || 'Failed to toggle bank active status.');
 }
 };

 const handleInterBankTransfer = async (e: React.FormEvent) => {
 e.preventDefault();
 const amountNum = parseFloat(transferForm.amount);
 if (isNaN(amountNum) || amountNum <= 0) return triggerError('Please enter a valid transfer amount.');
 if (!transferForm.sourceBankId || !transferForm.destBankId) return triggerError('Please select both source and destination banks.');
 if (transferForm.sourceBankId === transferForm.destBankId) return triggerError('Source and destination accounts must be different.');

 try {
   const res = await fetch('/api/transactions/interbank-transfer', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({
       sourceBankId: transferForm.sourceBankId,
       destBankId: transferForm.destBankId,
       amount: amountNum,
       description: transferForm.description || 'Inter-bank fund transfer',
       dateStr: transferForm.date
     })
   });
   const data = await res.json();
   if (!res.ok || data.error) {
     triggerError(data.error || 'Failed to transfer funds.');
   } else {
     const currencySymbol = db.companySetup?.currency || 'SAR';
     triggerSuccess(`Successfully transferred ${currencySymbol} ${amountNum.toFixed(2)} between bank accounts.`);
     if (onRefreshDb) {
       await onRefreshDb();
     }
     setTransferForm({
       sourceBankId: '',
       destBankId: '',
       amount: '',
       description: '',
       date: new Date().toISOString().split('T')[0]
     });
   }
 } catch (err: any) {
   triggerError(err.message || 'An error occurred during transfer.');
 }
 };

 // ----------------------------------------
 // SUB-TAB: TAX SLABS
 // ----------------------------------------
 const [taxForm, setTaxForm] = React.useState({
 name: '',
 percentage: '',
 isDefault: false
 });

 // Only this company's own tax slabs are eligible to be "the" default — the
 // company-shared/legacy rows (companyId null) aren't company-specific by
 // definition, so they're excluded from the unset-other-defaults sweep below.
 const companyTaxSlabs = db.taxSlabs.filter(t => t.companyId === db.selectedCompanyId);

 // Inline editor for a 0%-rate slab's ZATCA exemption reason (BR-KSA-23 and related) —
 // a real VATEX-SA-xx legal classification that varies per company, so there's no
 // sensible default to pre-fill; deliberately a small inline editor rather than a full
 // edit form, since name/percentage editing is out of scope for this specific fix.
 const [editingExemptionId, setEditingExemptionId] = React.useState<string | null>(null);
 const [exemptionForm, setExemptionForm] = React.useState({ code: '', reason: '' });
 const handleSaveExemptionReason = async (slabId: string) => {
 // POST /api/tax-slabs is a full-row upsert (drizzle's onConflictDoUpdate uses the same
 // object for both the INSERT and UPDATE branches) — name/percentage have no DB-level
 // default, so a partial {id, exemptionReasonCode, exemptionReason} payload fails with a
 // NOT NULL violation even though the row already exists. Every other caller of this
 // route (handleAddTax) already sends the full slab; this must too.
 const slab = db.taxSlabs.find(t => t.id === slabId);
 if (!slab) return triggerError('Tax slab not found.');
 try {
 const res = await fetch('/api/tax-slabs', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ ...slab, exemptionReasonCode: exemptionForm.code.trim() || null, exemptionReason: exemptionForm.reason.trim() || null })
 });
 const data = await res.json().catch(() => ({}));
 if (!res.ok || data.error) return triggerError(data.error || 'Failed to save exemption reason.');
 onUpdateDbLocal(prev => ({
 ...prev,
 taxSlabs: prev.taxSlabs.map(t => t.id === slabId ? { ...t, exemptionReasonCode: exemptionForm.code.trim() || null, exemptionReason: exemptionForm.reason.trim() || null } : t)
 }));
 triggerSuccess('ZATCA exemption reason saved.');
 setEditingExemptionId(null);
 } catch (err: any) {
 triggerError(err.message || 'Failed to save exemption reason.');
 }
 };

 const handleAddTax = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!taxForm.name.trim()) return triggerError('Tax slab name is required.');
 const pct = parseFloat(taxForm.percentage);
 if (isNaN(pct) || pct < 0 || pct > 100) return triggerError('Percentage must be a number between 0 and 100.');

 const newSlab: TaxSlab = {
 id: generateId(),
 name: taxForm.name,
 percentage: pct,
 companyId: db.selectedCompanyId,
 // The very first tax slab a company ever creates becomes its default
 // automatically (mirrors the same "first active bank becomes default bank"
 // convention just above) — otherwise a brand-new company would have no
 // default at all until an admin remembers to set one explicitly.
 isDefault: taxForm.isDefault || companyTaxSlabs.length === 0
 };

 try {
   const res = await fetch('/api/tax-slabs', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify(newSlab)
   });
   const data = await res.json().catch(() => ({}));
   if (!res.ok || data.error) return triggerError(data.error || 'Failed to add tax slab.');
   triggerSuccess(`Tax slab "${newSlab.name}" added successfully.${newSlab.isDefault ? ' Set as default.' : ''}`);
   setTaxForm({ name: '', percentage: '', isDefault: false });
   if (onRefreshDb) await onRefreshDb();
 } catch (err: any) {
   triggerError(err.message || 'Failed to add tax slab.');
 }
 };

 const handleSetDefaultTaxSlab = async (taxSlabId: string) => {
 // Server decides whether this is already the company's own row (just flips the
 // default) or a shared/legacy row (clones it into a company-owned default) — same
 // logic previously duplicated here client-side, see PATCH /api/tax-slabs/:id/set-default.
 try {
   const res = await fetch(`/api/tax-slabs/${taxSlabId}/set-default`, { method: 'PATCH' });
   const data = await res.json().catch(() => ({}));
   if (!res.ok || data.error) return triggerError(data.error || 'Failed to update default tax slab.');
   triggerSuccess('Default tax slab updated. New documents will pre-fill this rate.');
   if (onRefreshDb) await onRefreshDb();
 } catch (err: any) {
   triggerError(err.message || 'Failed to update default tax slab.');
 }
 };

 // ----------------------------------------
 // SUB-TAB: BRANCHES (LOCATIONS)
 // ----------------------------------------
 const companyBranches = (db.branches || []).filter(b => b.companyId === db.selectedCompanyId);
 const [editingBranchId, setEditingBranchId] = React.useState<string | null>(null);
 const emptyBranchForm = {
   name: '', code: '', streetName: '', buildingNumber: '', district: '', city: '',
   postalCode: '', countryCode: 'SA', phone: '', isDefault: false, isActive: true,
   defaultWarehouseId: '', autoCreateWarehouse: true,
 };
 const [branchForm, setBranchForm] = React.useState(emptyBranchForm);
 // Only 'sales'-type, active warehouses are eligible — a branch's default is what an
 // invoice/POS form auto-fills onto a sale, and a sale can never be posted against a
 // 'backend' warehouse (server/lib/businessLogic.ts's assertSalesWarehouse enforces this
 // too). Deliberately company-wide, not filtered to this branch's own branchId — a
 // shared/unassigned warehouse (branchId null) can still be a specific branch's default.
 const branchEligibleWarehouses = (db.warehouses || []).filter(w => w.companyId === db.selectedCompanyId && w.isActive !== false && w.type !== 'backend');

 const startEditBranch = (b: any) => {
   setEditingBranchId(b.id);
   setBranchForm({
     name: b.name || '', code: b.code || '', streetName: b.streetName || '', buildingNumber: b.buildingNumber || '',
     district: b.district || '', city: b.city || '', postalCode: b.postalCode || '', countryCode: b.countryCode || 'SA',
     phone: b.phone || '', isDefault: Boolean(b.isDefault), isActive: b.isActive !== false,
     defaultWarehouseId: b.defaultWarehouseId || '', autoCreateWarehouse: false,
   });
 };
 const clearBranchForm = () => { setEditingBranchId(null); setBranchForm(emptyBranchForm); };

 const [isBackfilling, setIsBackfilling] = React.useState(false);
 const [backfillTargetBranchId, setBackfillTargetBranchId] = React.useState('');

 // One-time (per company) cleanup action — every document created before this company
 // adopted branches (invoices, quotations, vouchers, expenses, PRs, POs, purchase bills,
 // warehouses) has a NULL branchId forever unless explicitly attributed to one now (see
 // server/routes/branches.ts's POST /branches/backfill-unassigned). Never runs
 // automatically — always an explicit admin choice, since silently reattributing
 // historical documents to a branch they were never actually created under is a real,
 // visible data change, not a cosmetic default.
 const handleBackfillUnassigned = async (branchId: string) => {
   if (!branchId) return triggerError('Choose a branch first.');
   const branch = companyBranches.find(b => b.id === branchId);
   if (!window.confirm(`Attribute every existing document (invoices, quotations, vouchers, expenses, purchase requisitions/orders/bills, warehouses) that has no branch yet to "${branch?.name}"? This only touches rows that are currently unassigned — nothing already attributed to a branch is changed.`)) return;
   setIsBackfilling(true);
   try {
     const res = await fetch('/api/branches/backfill-unassigned', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ branchId }),
     });
     const data = await res.json().catch(() => ({}));
     if (!res.ok || data.error) return triggerError(data.error || 'Failed to backfill unassigned documents.');
     const counts = data.counts || {};
     const summary = Object.entries(counts).filter(([, n]) => Number(n) > 0).map(([k, n]) => `${n} ${k}`).join(', ');
     triggerSuccess(summary ? `Attributed to "${branch?.name}": ${summary}.` : `Nothing to backfill — every document already has a branch.`);
     if (onRefreshDb) await onRefreshDb();
   } catch (err: any) {
     triggerError(err.message || 'Failed to backfill unassigned documents.');
   } finally {
     setIsBackfilling(false);
   }
 };

 const handleSaveBranch = async (e: React.FormEvent) => {
   e.preventDefault();
   if (!branchForm.name.trim()) return triggerError('Branch name is required.');
   if (!branchForm.code.trim()) return triggerError('Branch code is required.');
   const isFirstBranch = !editingBranchId && companyBranches.length === 0;
   try {
     const res = await fetch('/api/branches', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({
         id: editingBranchId || undefined,
         ...branchForm,
         // The very first branch a company creates becomes its default automatically —
         // same convention already used for the first tax slab / first active bank.
         isDefault: branchForm.isDefault || companyBranches.length === 0,
         defaultWarehouseId: branchForm.defaultWarehouseId || null,
         // Only meaningful for a genuinely new branch — the server ignores it on an edit.
         autoCreateWarehouse: branchForm.autoCreateWarehouse,
       }),
     });
     const data = await res.json().catch(() => ({}));
     if (!res.ok || data.error) return triggerError(data.error || 'Failed to save branch.');
     triggerSuccess(editingBranchId ? `Branch "${branchForm.name}" updated.` : `Branch "${branchForm.name}" created.`);
     clearBranchForm();
     if (onRefreshDb) await onRefreshDb();
     // Prompted only once, right when a company creates its very first branch — this is
     // exactly the moment pre-existing documents become "unassigned" in a way that now
     // matters (see the feature comment on handleBackfillUnassigned above).
     if (isFirstBranch && data.id) {
       if (window.confirm(`"${branchForm.name}" is this company's first branch. Attribute every existing document that has no branch yet (invoices, quotations, vouchers, expenses, purchase requisitions/orders/bills, warehouses) to it now? You can also do this later from this tab.`)) {
         await handleBackfillUnassigned(data.id);
       }
     }
   } catch (err: any) {
     triggerError(err.message || 'Failed to save branch.');
   }
 };

 const handleToggleBranchActive = async (id: string) => {
   const b = companyBranches.find(x => x.id === id);
   const isActive = b?.isActive !== false;
   if (isActive && !window.confirm('Deactivate this branch? It will be hidden from new documents but its history stays intact. You can reactivate it anytime.')) return;
   try {
     const res = await fetch(`/api/branches/${id}/toggle-active`, { method: 'PATCH' });
     const data = await res.json().catch(() => ({}));
     if (!res.ok || data.error) return triggerError(data.error || 'Failed to update branch status.');
     triggerSuccess(data.isActive ? 'Branch reactivated.' : 'Branch deactivated.');
     if (onRefreshDb) await onRefreshDb();
   } catch (err: any) {
     triggerError(err.message || 'Failed to update branch status.');
   }
 };

 // ----------------------------------------
 // SUB-TAB: DOCUMENT NUMBERING
 // ----------------------------------------
 // Rules keyed by DOCUMENT_TYPE_REGISTRY's `key` (server/lib/documentNumbering.ts) — the
 // registry itself (label/defaultPrefix per type) is fetched from the preview endpoint
 // rather than duplicated here, so a future registry addition needs no frontend change.
 const [numberingRegistry, setNumberingRegistry] = React.useState<{ key: string; label: string; defaultPrefix: string }[]>([]);
 const [numberingPreview, setNumberingPreview] = React.useState<Record<string, string>>({});
 const [numberingRules, setNumberingRules] = React.useState<Record<string, { prefix?: string; separator?: string; padWidth?: number; includeBranchCode?: boolean; resetFrequency?: 'never' | 'yearly' | 'monthly' }>>({});
 const [numberingLoading, setNumberingLoading] = React.useState(false);

 const loadNumberingSettings = React.useCallback(async () => {
   if (!db.selectedCompanyId) return;
   setNumberingLoading(true);
   try {
     const res = await fetch(`/api/companies/${db.selectedCompanyId}/numbering-preview`);
     const data = await res.json().catch(() => ({}));
     if (res.ok && !data.error) {
       setNumberingRegistry(data.registry || []);
       setNumberingPreview(data.preview || {});
     }
   } finally {
     setNumberingLoading(false);
   }
   const activeCompany = db.companies.find(c => c.id === db.selectedCompanyId);
   setNumberingRules({ ...(activeCompany?.numberingPolicy || {}) });
 }, [db.selectedCompanyId, db.companies]);

 React.useEffect(() => {
   if (activeTab === 'numbering') loadNumberingSettings();
   // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [activeTab, db.selectedCompanyId]);

 const updateNumberingRule = (docType: string, patch: Partial<{ prefix: string; separator: string; padWidth: number; includeBranchCode: boolean; resetFrequency: 'never' | 'yearly' | 'monthly' }>) => {
   setNumberingRules(prev => ({ ...prev, [docType]: { ...prev[docType], ...patch } }));
 };

 const handleSaveNumberingPolicy = async () => {
   if (!db.selectedCompanyId) return;
   try {
     const res = await fetch(`/api/companies/${db.selectedCompanyId}/settings`, {
       method: 'PATCH',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ numberingPolicy: numberingRules }),
     });
     const data = await res.json().catch(() => ({}));
     if (!res.ok || data.error) return triggerError(data.error || 'Failed to update document numbering settings.');
     triggerSuccess('Document numbering settings updated.');
     if (onRefreshDb) await onRefreshDb();
     loadNumberingSettings();
   } catch (err: any) {
     triggerError(err.message || 'Failed to update document numbering settings.');
   }
 };

 // Surfaces (never silently resolves) any two types whose effective prefix would collide —
 // e.g. debitNote/return both default to 'DN'. This is a pre-existing, true-to-today
 // ambiguity in the underlying data, not something this UI introduces or should hide.
 const numberingPrefixCollisions = React.useMemo(() => {
   const byPrefix = new Map<string, string[]>();
   for (const entry of numberingRegistry) {
     const prefix = numberingRules[entry.key]?.prefix ?? entry.defaultPrefix;
     byPrefix.set(prefix, [...(byPrefix.get(prefix) || []), entry.key]);
   }
   const collidingKeys = new Set<string>();
   for (const keys of byPrefix.values()) {
     if (keys.length > 1) keys.forEach(k => collidingKeys.add(k));
   }
   return collidingKeys;
 }, [numberingRegistry, numberingRules]);

 // ----------------------------------------
 // SUB-TAB: TEMPLATES
 // ----------------------------------------
 const [tmplForm, setTmplForm] = React.useState({
 name: '',
 language: 'English' as 'English' | 'Arabic' | 'Urdu',
 pageSize: '8.27in x 11.69in (A4)',
 // Starting layout only — both presets go through the exact same DocumentRenderer/
 // Canvas Designer path afterward, an admin can freely edit either one's blocks once
 // created. 'detailed' seeds the itemized-address/per-line-tax-columns layout that
 // matches the traditional GCC tax-invoice format (see documentTemplateDefaults.ts's
 // DETAILED_TAX_INVOICE_LAYOUT for the reasoning).
 preset: 'standard' as 'standard' | 'detailed'
 });

 const handleAddTemplate = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!tmplForm.name.trim()) return triggerError('Template name is required.');

 // id/companyId are assigned server-side (POST /api/templates) — a template with no
 // layoutJson doesn't render blank, it silently falls back to DocumentRenderer.tsx's OWN
 // no-layout default, which a newly created template's designer would show as ITS OWN
 // starting point anyway. Seeding it here means what an admin sees before ever opening
 // the Canvas Designer already matches what they'd see after opening it and hitting Save.
 const newTmpl = {
 name: tmplForm.name,
 language: tmplForm.language,
 pageSize: tmplForm.pageSize,
 isActive: false,
 printHeader: true,
 printFooter: true,
 printLogo: true,
 printQrCode: true,
 layoutJson: JSON.stringify(tmplForm.preset === 'detailed' ? DETAILED_TAX_INVOICE_LAYOUT : DEFAULT_DOCUMENT_LAYOUT),
 // The detailed preset's blocks already shrink their own internal spacing via
 // compact:true (see DETAILED_TAX_INVOICE_LAYOUT) — pairing that with a tight
 // row-to-row grid gap (vs. the 24px 'normal' default) is what actually makes the
 // header narrow enough for a real 20-line-item invoice to fit on one page.
 ...(tmplForm.preset === 'detailed' ? { gridGapY: 'tight' } : {}),
 };

 try {
   const resp = await fetch('/api/templates', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify(newTmpl)
   });
   const result = await resp.json().catch(() => ({}));
   if (!resp.ok) {
     return triggerError(result.error || 'Failed to register template.');
   }
   if (onRefreshDb) await onRefreshDb();
   triggerSuccess(`Template "${newTmpl.name}" registered. Activate it below.`);
   setTmplForm({ name: '', language: 'English', pageSize: '8.27in x 11.69in (A4)', preset: 'standard' });
 } catch (err: any) {
   triggerError('Failed to register template: ' + err.message);
 }
 };

 const handleActivateTemplate = async (tmplId: string) => {
 try {
   const resp = await fetch(`/api/templates/${tmplId}`, {
     method: 'PATCH',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ isActive: true })
   });
   const result = await resp.json().catch(() => ({}));
   if (!resp.ok) {
     return triggerError(result.error || t('Failed to activate template.'));
   }
   if (onRefreshDb) await onRefreshDb();
   triggerSuccess(t('Document layout template activated.'));
 } catch (err: any) {
   triggerError(t('Failed to activate template:') + ' ' + err.message);
 }
 };

 // DELETE /api/templates/:id already existed server-side with no UI ever calling it — the
 // only way to retire a template was activating a different one, leaving unwanted
 // templates to accumulate forever. Confirms harder when deleting the currently-active
 // template, since that leaves its (companyId, language) pair with no active template
 // until another one is explicitly activated (DocumentRenderer falls back to the built-in
 // default layout in the meantime, so nothing breaks, but it's a real behavior change).
 const handleDeleteTemplate = async (tmpl: any) => {
   const warning = tmpl.isActive
     ? `"${tmpl.name}" ${t('is the ACTIVE template for')} ${tmpl.language} ${t('documents. Deleting it means')} ${tmpl.language} ${t('documents print with the built-in default layout until you activate another template. Delete anyway?')}`
     : `${t('Delete template')} "${tmpl.name}"? ${t('This cannot be undone.')}`;
   if (!window.confirm(warning)) return;
   try {
     const resp = await fetch(`/api/templates/${tmpl.id}`, { method: 'DELETE' });
     const result = await resp.json().catch(() => ({}));
     if (!resp.ok) {
       return triggerError(result.error || t('Failed to delete template.'));
     }
     if (onRefreshDb) await onRefreshDb();
     triggerSuccess(t('Template deleted.'));
   } catch (err: any) {
     triggerError(t('Failed to delete template:') + ' ' + err.message);
   }
 };

 const handleToggleOption = async (tmplId: string, option: 'printHeader' | 'printFooter' | 'printLogo' | 'printQrCode') => {
 const targetTmpl = db.templates.find(t => t.id === tmplId);
 const newVal = targetTmpl ? (targetTmpl[option] !== false ? false : true) : true;
 try {
   const resp = await fetch(`/api/templates/${tmplId}`, {
     method: 'PATCH',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ [option]: newVal })
   });
   const result = await resp.json().catch(() => ({}));
   if (!resp.ok) {
     return triggerError(result.error || 'Failed to update print preference.');
   }
   if (onRefreshDb) await onRefreshDb();
   triggerSuccess('Template print preference updated.');
 } catch (err: any) {
   triggerError('Failed to update print preference: ' + err.message);
 }
  };

 const handleUpdateTemplateProperty = async (tmplId: string, propKey: string, val: any) => {
   try {
     const resp = await fetch(`/api/templates/${tmplId}`, {
       method: 'PATCH',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ [propKey]: val })
     });
     const result = await resp.json().catch(() => ({}));
     if (!resp.ok) {
       return triggerError(result.error || 'Failed to update template option.');
     }
     if (onRefreshDb) await onRefreshDb();
     triggerSuccess('Template option updated.');
   } catch (err: any) {
     triggerError('Failed to update template option: ' + err.message);
   }
 };

  // ----------------------------------------
  // CUSTOM VISUAL 'CANVAS' TEMPLATE DESIGNER
  // ----------------------------------------
  // DEFAULT_LAYOUT used to be a local copy that had drifted from DocumentRenderer.tsx's
  // own separate fallback array (different widths/row-pairings) — now both import the
  // same shared constant. See src/documentTemplateDefaults.ts for the full reasoning.
  const DEFAULT_LAYOUT = DEFAULT_DOCUMENT_LAYOUT;

  const [designingTemplateId, setDesigningTemplateId] = React.useState<string | null>(null);
  // Snapshot of canvasBlocks as loaded, so Cancel/navigate-away can detect real unsaved
  // edits instead of silently discarding them — block-level edits (width, props, reorder,
  // add/hide) only ever mutate local state until "Save Layout Configuration" is clicked,
  // unlike Global Row Gap/Font Family which PATCH the server immediately on change.
  const [canvasBlocksSnapshot, setCanvasBlocksSnapshot] = React.useState<string>('[]');
  const [canvasBlocks, setCanvasBlocks] = React.useState<any[]>([]);
  const [selectedBlockId, setSelectedBlockId] = React.useState<string | null>(null);
  const [draggedBlockId, setDraggedBlockId] = React.useState<string | null>(null);

  const handleAddCustomBlock = (fieldBinding: string = 'none', labelTitle: string = 'Custom Field') => {
    const customId = 'custom_field_' + Date.now();
    const newBlock = {
      id: customId,
      title: labelTitle,
      w: 6,
      visible: true,
      type: 'custom_field',
      props: {
        fieldBinding,
        labelEn: labelTitle,
        labelAr: '',
        staticText: '',
        align: 'left',
        fontSize: 'xs',
        fontWeight: 'normal',
        mt: '2',
        mb: '2',
        p: '2',
        borderStyle: 'solid',
        isBilingual: true
      }
    };
    setCanvasBlocks(prev => [...prev, newBlock]);
    setSelectedBlockId(customId);
    triggerSuccess(`Added custom block "${labelTitle}" to canvas.`);
  };

  const handleOpenCanvasDesigner = (tmpl: any) => {
    setDesigningTemplateId(tmpl.id);
    let blocks = [];
    if (tmpl.layoutJson) {
      try {
        blocks = JSON.parse(tmpl.layoutJson);
      } catch (e) {
        console.error("Failed to parse layoutJson:", e);
      }
    }
    if (!blocks || blocks.length === 0) {
      blocks = JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
    }
    setCanvasBlocks(blocks);
    setCanvasBlocksSnapshot(JSON.stringify(blocks));
    setSelectedBlockId(null);
  };

  const hasUnsavedCanvasChanges = JSON.stringify(canvasBlocks) !== canvasBlocksSnapshot;

  const handleCancelCanvasDesigner = () => {
    if (hasUnsavedCanvasChanges && !window.confirm(t('You have unsaved layout changes (width, order, block properties) that will be lost. Discard them?'))) {
      return;
    }
    setDesigningTemplateId(null);
  };

  const handleSaveCanvasLayout = async () => {
    if (!designingTemplateId) return;
    try {
      const resp = await fetch(`/api/templates/${designingTemplateId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layoutJson: JSON.stringify(canvasBlocks) })
      });
      const result = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        return triggerError(result.error || 'Failed to save canvas layout.');
      }
      if (onRefreshDb) await onRefreshDb();
    } catch (err: any) {
      return triggerError('Failed to save canvas layout: ' + err.message);
    }
    triggerSuccess(t('Canvas layout configuration saved successfully.'));
    setDesigningTemplateId(null);
  };

  const handleResetLayout = () => {
    if (window.confirm(t('Are you sure you want to reset this canvas layout to the ZATCA default?'))) {
      setCanvasBlocks(JSON.parse(JSON.stringify(DEFAULT_LAYOUT)));
      setSelectedBlockId(null);
      triggerSuccess(t('Layout reset to default. Save to persist.'));
    }
  };

  const handleCanvasDragStart = (e: React.DragEvent, blockId: string) => {
    e.dataTransfer.setData("text/plain", blockId);
    setDraggedBlockId(blockId);
  };

  const handleCanvasDragOver = (e: React.DragEvent, blockId: string) => {
    e.preventDefault();
  };

  const handleCanvasDrop = (e: React.DragEvent, targetBlockId: string) => {
    e.preventDefault();
    const sourceId = e.dataTransfer.getData("text/plain") || draggedBlockId;
    if (!sourceId || sourceId === targetBlockId) return;

    const sourceIndex = canvasBlocks.findIndex(b => b.id === sourceId);
    const targetIndex = canvasBlocks.findIndex(b => b.id === targetBlockId);
    if (sourceIndex === -1 || targetIndex === -1) return;

    const updatedBlocks = [...canvasBlocks];
    const [removed] = updatedBlocks.splice(sourceIndex, 1);
    updatedBlocks.splice(targetIndex, 0, removed);
    setCanvasBlocks(updatedBlocks);
    setDraggedBlockId(null);
  };

  const handleUpdateBlockWidth = (blockId: string, width: number) => {
    setCanvasBlocks(prev => prev.map(b => b.id === blockId ? { ...b, w: width } : b));
  };

  // Keyboard-accessible reordering alternative to the canvas's HTML5 drag-and-drop
  // (handleCanvasDragStart/Over/Drop above) — a keyboard-only admin previously had no
  // way to reorder blocks at all. Moves relative to the neighboring VISIBLE block, not
  // just the adjacent array entry — canvasBlocks also holds hidden (visible: false)
  // blocks interleaved with visible ones, so a naive adjacent-index swap could silently
  // no-op (swapping past a hidden block) or reorder two blocks that aren't actually
  // next to each other on the rendered canvas.
  const handleMoveBlock = (blockId: string, direction: 'up' | 'down') => {
    setCanvasBlocks(prev => {
      const visibleIds = prev.filter(b => b.visible !== false).map(b => b.id);
      const posInVisible = visibleIds.indexOf(blockId);
      if (posInVisible === -1) return prev;
      const neighborId = direction === 'up' ? visibleIds[posInVisible - 1] : visibleIds[posInVisible + 1];
      if (!neighborId) return prev; // already first/last visible block
      const updated = [...prev];
      const blockIdx = updated.findIndex(b => b.id === blockId);
      const neighborIdx = updated.findIndex(b => b.id === neighborId);
      [updated[blockIdx], updated[neighborIdx]] = [updated[neighborIdx], updated[blockIdx]];
      return updated;
    });
  };

  const handleToggleBlockVisibility = (blockId: string, visible: boolean) => {
    setCanvasBlocks(prev => prev.map(b => b.id === blockId ? { ...b, visible } : b));
    if (!visible && selectedBlockId === blockId) {
      setSelectedBlockId(null);
    }
  };

  // "Hide" (handleToggleBlockVisibility) only ever sets visible:false — a custom block
  // (id starts with 'custom_field_', created via handleAddCustomBlock) could never actually
  // be removed from the array, so hidden ones accumulate in layoutJson forever across an
  // admin's editing history. Default DEFAULT_LAYOUT blocks stay hide-only (they're the
  // standard set, meant to be re-showable), but a custom block's whole reason for existing
  // is gone once it's unwanted, so it gets a real removal instead.
  const handleRemoveCustomBlock = (blockId: string) => {
    if (!window.confirm(t('Permanently remove this custom block? This cannot be undone (unlike Hide, which keeps it available to re-add).'))) return;
    setCanvasBlocks(prev => prev.filter(b => b.id !== blockId));
    if (selectedBlockId === blockId) setSelectedBlockId(null);
  };

  const handleUpdateBlockProp = (blockId: string, propKey: string, val: any) => {
    setCanvasBlocks(prev => prev.map(b => {
      if (b.id === blockId) {
        return {
          ...b,
          props: {
            ...b.props,
            [propKey]: val
          }
        };
      }
      return b;
    }));
  };

  const handleDummyPlaceholder = () => {
 };

 // ----------------------------------------
 // SUB-TAB: MONTH MANAGEMENT
 // ----------------------------------------
 const [monthForm, setMonthForm] = React.useState({
 year: '2026',
 month: '07'
 });

 // Modal control for closing confirmation
 const [isClosingMonth, setIsClosingMonth] = React.useState<FiscalMonth | null>(null);
 const [closeOption, setCloseOption] = React.useState<'paid_only' | 'including_pending'>('paid_only');

 const handleOpenMonth = async (e: React.FormEvent) => {
 e.preventDefault();
 const result = openNewMonth(db, monthForm.year, monthForm.month, db.selectedCompanyId);
 if (result.error) {
 triggerError(result.error);
 } else {
 try {
 const m = result.db.months.find((x: any) => x.id === `${monthForm.year}-${monthForm.month}`);
 if (m) {
 const res = await fetch(`/api/transactions/months`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(m) });
 if (!res.ok) {
 const body = await res.json().catch(() => ({}));
 triggerError(body.error || 'Failed to open fiscal month — the server rejected this request.');
 return;
 }
 }
 triggerSuccess(`Fiscal Month "${monthForm.year}-${monthForm.month}" opened successfully.`);
 onUpdateDbLocal(() => result.db);
 await fetchMonths();
 } catch (err) {
 triggerError('Failed to save to database.');
 }
 }
 };

 const handleInitiateClose = (m: FiscalMonth) => {
 // Run pre-condition checks
 const check = checkRecurringPreconditions(db, m.id);
 if (!check.satisfied) {
 const list = check.unposted.map(t => t.description).join(', ');
 triggerError(`Cannot close month. Please post active recurring expenses first: [${list}]`);
 return;
 }

 setIsClosingMonth(m);
 };

 const handleConfirmClose = async () => {
 if (!isClosingMonth) return;
 const pnl = calculateMonthPnL(db, isClosingMonth.id);
 const result = closeMonth(db, isClosingMonth.id, closeOption);
 if (result.error) {
 triggerError(result.error);
 } else {
 try {
 const m = result.db.months.find((x: any) => x.id === isClosingMonth.id);
 if (m) {
 // This action tells the admin the month is "permanently closed and locked" — a
 // rejected server write must never be reported as that permanent an outcome.
 const res = await fetch(`/api/transactions/months`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(m) });
 if (!res.ok) {
 const body = await res.json().catch(() => ({}));
 triggerError(body.error || 'Failed to close fiscal month — the server rejected this request. The month has NOT been closed.');
 return;
 }
 }
 triggerSuccess(`Fiscal Month "${isClosingMonth.id}" has been permanently closed and locked.`);
 setIsClosingMonth(null);
 onUpdateDbLocal(() => result.db);
 await fetchMonths();
 } catch (err) {
 triggerError('Failed to update closed month in database. The month has NOT been closed.');
 }
 }
 };

 // ----------------------------------------
 // SUB-TAB: USER & PERMISSION MANAGEMENT
 // ----------------------------------------
 const [isAddingUser, setIsAddingUser] = React.useState(false);
 const [userCompanyFilter, setUserCompanyFilter] = React.useState<string>('all');
 const [editingUser, setEditingUser] = React.useState<User | null>(null);
 const [confirmDeleteUserId, setConfirmDeleteUserId] = React.useState<string | null>(null);
 const [deletingCompany, setDeletingCompany] = React.useState<{ id: string; name: string } | null>(null);
 const [deleteCompanyConfirmText, setDeleteCompanyConfirmText] = React.useState('');

 const [userForm, setUserForm] = React.useState({
 username: '',
 email: '',
 password: '',
 confirmPassword: '',
 role: 'user' as UserRole,
 companyId: db.selectedCompanyId,
 roleIds: [] as string[],
 // Zero branchIds means company-wide (sees/can act on every branch) — that's the
 // `branches.viewAllBranches` permission leaf's job (granted via a Role, same as any
 // other leaf), not row presence here. A non-empty list restricts the user to exactly
 // those branches; primaryBranchId picks their default focus among them.
 branchIds: [] as string[],
 primaryBranchId: '',
 // Nullable link to the HR employees table — mandatory server-side only once the
 // company has onboarded at least one active employee (server/routes/users.ts);
 // empty string here means "not linked," same convention as primaryBranchId.
 employeeId: '',
  });

  // The "Assigned Company" field above was a one-time useState initializer that never
  // tracked the active-company selector after mount — a super-admin who opened this tab
  // on one company, then switched companies via the top-nav selector without this
  // component remounting, would still have userForm.companyId silently pointing at the
  // OLD company. Since the submit payload prefers userForm.companyId over
  // db.selectedCompanyId (`userForm.companyId || db.selectedCompanyId`), the new user
  // (and any role assignment, which is itself company-scoped server-side) silently landed
  // in the wrong company with zero error anywhere — confirmed live. Resyncing here matches
  // the same pattern already used for `roles` just below.
  React.useEffect(() => {
    setUserForm(prev => ({ ...prev, companyId: db.selectedCompanyId }));
  }, [db.selectedCompanyId]);

  // Roles render straight from the shared `db.roles` (populated by `/api/state`,
  // refreshed via `onRefreshDb`) — this used to be a separately-fetched local copy that
  // only refetched on company switch, so a role created/updated elsewhere never appeared
  // here without a hard page reload.
  const [isAddingRole, setIsAddingRole] = React.useState(false);
  const [editingRole, setEditingRole] = React.useState<Role | null>(null);
  const [confirmDeleteRoleId, setConfirmDeleteRoleId] = React.useState<string | null>(null);
  const [roleForm, setRoleForm] = React.useState<{ id: string | null; name: string; permissions: any }>({
    id: null,
    name: '',
    permissions: {}
  });

  const handleSaveRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roleForm.name.trim()) return triggerError('Role name is required.');
    try {
      const resp = await fetch('/api/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: roleForm.id,
          name: roleForm.name.trim(),
          permissions: roleForm.permissions,
          companyId: db.selectedCompanyId
        })
      });
      const result = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        return triggerError(result.error || 'Failed to save role.');
      }
      triggerSuccess(roleForm.id ? 'Role updated successfully.' : 'Role created successfully.');
      setIsAddingRole(false);
      setEditingRole(null);
      setRoleForm({ id: null, name: '', permissions: {} });
      if (onRefreshDb) await onRefreshDb();
    } catch (err: any) {
      triggerError('Failed to save role: ' + err.message);
    }
  };

  const handleDeleteRole = async (id: string) => {
    try {
      const resp = await fetch(`/api/roles/${id}`, { method: 'DELETE' });
      const result = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        return triggerError(result.error || 'Failed to delete role.');
      }
      triggerSuccess('Role removed.');
      setConfirmDeleteRoleId(null);
      if (onRefreshDb) await onRefreshDb();
    } catch (err: any) {
      triggerError('Failed to delete role: ' + err.message);
    }
  };

  // --- Role Templates: a cross-tenant, admin-curated permission-set library (unlike
  // Roles above, which are always scoped to one company) — cloned into a brand-new
  // company's own Roles at onboarding-approval time. Same editor shape as Roles, just
  // pointed at /api/role-templates.
  const [confirmDeleteRoleTemplateId, setConfirmDeleteRoleTemplateId] = React.useState<string | null>(null);
  const [roleTemplateForm, setRoleTemplateForm] = React.useState<{ id: string | null; name: string; description: string; permissions: any }>({
    id: null, name: '', description: '', permissions: {}
  });

  const handleSaveRoleTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roleTemplateForm.name.trim()) return triggerError('Template name is required.');
    try {
      const resp = await fetch('/api/role-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: roleTemplateForm.id,
          name: roleTemplateForm.name.trim(),
          description: roleTemplateForm.description.trim() || null,
          permissions: roleTemplateForm.permissions,
        })
      });
      const result = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        return triggerError(result.error || 'Failed to save role template.');
      }
      triggerSuccess(roleTemplateForm.id ? 'Role template updated successfully.' : 'Role template created successfully.');
      setRoleTemplateForm({ id: null, name: '', description: '', permissions: {} });
      if (onRefreshDb) await onRefreshDb();
    } catch (err: any) {
      triggerError('Failed to save role template: ' + err.message);
    }
  };

  const handleDeleteRoleTemplate = async (id: string) => {
    try {
      const resp = await fetch(`/api/role-templates/${id}`, { method: 'DELETE' });
      const result = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        return triggerError(result.error || 'Failed to delete role template.');
      }
      triggerSuccess('Role template removed.');
      setConfirmDeleteRoleTemplateId(null);
      if (onRefreshDb) await onRefreshDb();
    } catch (err: any) {
      triggerError('Failed to delete role template: ' + err.message);
    }
  };

  // --- Company Onboarding Requests: review/approve/reject a public signup
  // (src/components/CompanyOnboardingScreen.tsx). Approve atomically creates the
  // company + starter resources + user server-side (server/routes/onboarding.ts).
  const [reviewingRequestId, setReviewingRequestId] = React.useState<string | null>(null);
  const [approvalMode, setApprovalMode] = React.useState<'admin' | 'template'>('admin');
  const [approvalTemplateId, setApprovalTemplateId] = React.useState('');
  const [rejectingRequestId, setRejectingRequestId] = React.useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = React.useState('');
  const [onboardingActionLoading, setOnboardingActionLoading] = React.useState(false);

  const handleApproveOnboarding = async (id: string) => {
    if (approvalMode === 'template' && !approvalTemplateId) {
      return triggerError('Select a role template first.');
    }
    setOnboardingActionLoading(true);
    try {
      const resp = await fetch(`/api/admin/onboarding-requests/${id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: approvalMode, roleTemplateId: approvalMode === 'template' ? approvalTemplateId : undefined })
      });
      const result = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        return triggerError(result.error || 'Failed to approve this request.');
      }
      triggerSuccess(result.emailSent
        ? 'Company approved — the new user has been emailed a link to set their password.'
        : `Company approved. Email isn't configured on this server, so share this set-password link with them yourself: ${result.resetUrl}`);
      setReviewingRequestId(null);
      setApprovalMode('admin');
      setApprovalTemplateId('');
      if (onRefreshDb) await onRefreshDb();
    } catch (err: any) {
      triggerError('Failed to approve this request: ' + err.message);
    } finally {
      setOnboardingActionLoading(false);
    }
  };

  const handleRejectOnboarding = async (id: string) => {
    setOnboardingActionLoading(true);
    try {
      const resp = await fetch(`/api/admin/onboarding-requests/${id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: rejectionReason.trim() || undefined })
      });
      const result = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        return triggerError(result.error || 'Failed to reject this request.');
      }
      triggerSuccess('Request rejected.');
      setRejectingRequestId(null);
      setRejectionReason('');
      if (onRefreshDb) await onRefreshDb();
    } catch (err: any) {
      triggerError('Failed to reject this request: ' + err.message);
    } finally {
      setOnboardingActionLoading(false);
    }
  };

 const handleAddUser = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!userForm.username.trim()) return triggerError('Username is required.');
 // Mandatory — this is what the "Forgot password?" flow keys off (see server.ts's
 // POST /api/auth/forgot-password): an account with no email on file can never receive
 // a reset link, so every account created/edited here must have one.
 const cleanEmail = userForm.email.trim();
 if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
 return triggerError('A valid email address is required.');
 }

 const isUserAdmin = userForm.role === 'admin';

 // Non-admin users derive all of their access from assigned Roles — must have at
 // least one, otherwise the account can do nothing (fails closed by design).
 if (!isUserAdmin && userForm.roleIds.length === 0) {
 return triggerError('Staff accounts must be assigned at least one Role. Create or select a Role first.');
 }

 // Blank means "leave unchanged" on edit (server preserves the existing hash when no
 // password is sent at all) and "use the documented 123456 default" on create — never a
 // literal '123456' fallback for an edit, which would silently reset a real password.
 const trimmedPassword = userForm.password.trim();
 if (trimmedPassword) {
 if (trimmedPassword !== userForm.confirmPassword.trim()) {
 return triggerError('Password and Confirm Password do not match.');
 }
 if (trimmedPassword.length < 6 || !/[a-zA-Z]/.test(trimmedPassword) || !/[0-9]/.test(trimmedPassword)) {
 return triggerError('Password must be at least 6 characters and contain at least one letter and one digit.');
 }
 }
 // Omitted (not the literal '123456') either way — POST /api/users applies the
 // documented 123456 default itself when no password is sent at all for a brand-new
 // account, and preserves the existing hash on an edit. Sending '123456' explicitly here
 // would also incorrectly trip the letter+digit policy check below on the server.
 const assignedPassword = trimmedPassword || undefined;
 let savedUser = null;

 if (editingUser) {
 // Update existing user
 savedUser = {
 ...editingUser,
 username: userForm.username.trim(),
 email: cleanEmail,
 password: assignedPassword,
 role: userForm.role,
 companyId: userForm.companyId || db.selectedCompanyId,
  roleIds: userForm.roleIds,
  branchIds: userForm.branchIds,
  primaryBranchId: userForm.primaryBranchId || undefined,
  employeeId: userForm.employeeId || null,
 } as any;

 try {
 const res = await fetch('/api/users', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(savedUser) });
 const body = await res.json().catch(() => ({}));
 if (!res.ok) {
 triggerError(body.error || 'Failed to save user — the server rejected this change.');
 return;
 }
 // POST /api/users already persisted the record — refetch from the server instead
 // of hand-merging a client-side copy through the full-blob /api/migrate sync.
 await onRefreshDb?.();
 if (body.droppedRoles?.length || body.droppedBranches?.length) {
 // A requested role/branch belongs to a different company than this user and was
 // NOT assigned — the save itself still succeeded, but this must be loud, not a
 // silent {success:true} (see server/routes/users.ts) — a user left with fewer
 // roles/branches than intended is a real access gap, not a cosmetic detail.
 const reasons = [...(body.droppedRoles || []), ...(body.droppedBranches || [])].map((d: any) => d.reason).join(' ');
 triggerError('Account updated, but not everything requested was assigned: ' + reasons);
 } else {
 triggerSuccess('Account details updated successfully.');
 }
 setEditingUser(null);
 } catch (err) {
 triggerError('Failed to save to database');
 return;
 }
 } else {
 // Create new user
 const newUser = {
 id: generateId(),
 username: userForm.username.trim(),
 email: cleanEmail,
 password: assignedPassword,
 role: userForm.role,
 companyId: userForm.companyId || db.selectedCompanyId,
 isActive: true, // Active by default
 uiLanguage: 'en',
  roleIds: userForm.roleIds,
  branchIds: userForm.branchIds,
  primaryBranchId: userForm.primaryBranchId || undefined,
  employeeId: userForm.employeeId || null,
 };

 try {
 const res = await fetch('/api/users', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(newUser) });
 const body = await res.json().catch(() => ({}));
 if (!res.ok) {
 triggerError(body.error || 'Failed to create user — the server rejected this request.');
 return;
 }
 await onRefreshDb?.();
 if (body.droppedRoles?.length || body.droppedBranches?.length) {
 // See the matching comment in the edit-user branch above — a dropped role/branch
 // means this account has fewer permissions than what was actually requested.
 const reasons = [...(body.droppedRoles || []), ...(body.droppedBranches || [])].map((d: any) => d.reason).join(' ');
 triggerError('Account created, but not everything requested was assigned: ' + reasons);
 } else {
 triggerSuccess('Account created successfully.');
 }
 } catch (err) {
 triggerError('Failed to save to database');
 return;
 }
 }

 setIsAddingUser(false);
 setUserForm({
 username: '',
 email: '',
 password: '',
 confirmPassword: '',
 role: 'user',
 companyId: db.selectedCompanyId,
 roleIds: [],
 branchIds: [],
 primaryBranchId: '',
 employeeId: '',
  });
 };
 const handleToggleUserActive = async (userId: string) => {
 if (db.currentUser && userId === db.currentUser.id) {
 return triggerError(t('You cannot deactivate your own active session!'));
 }
 const targetUser = db.users.find(u => u.id === userId);
 if (targetUser?.isSuperAdmin) {
 return triggerError(t('Super Admin accounts cannot be deactivated!'));
 }
 const newStatus = targetUser?.isActive !== false ? false : true;

 try {
 const res = await fetch(`/api/users/${userId}/active`, {
 method: 'PATCH',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ isActive: newStatus })
 });
 if (!res.ok) {
 const body = await res.json().catch(() => ({}));
 triggerError(body.error || t('Failed to update user status — the server rejected this request.'));
 return;
 }
 await onRefreshDb?.();
 triggerSuccess(`${t('User')} "${targetUser?.username}" ${newStatus ? t('is now active.') : t('is now deactivated.')}`);
 } catch (err) {
 triggerError(t('Failed to update user status — check your connection and try again.'));
 }
 };

 const handleDeleteUser = (userId: string) => {
  if (!window.confirm(t('Are you sure you want to delete this user?'))) return;
  if (db.currentUser && userId === db.currentUser.id) {
 return triggerError(t('You cannot delete your own active session!'));
 }
 const userToDelete = db.users.find(u => u.id === userId);
 if (!userToDelete) return;
 if (userToDelete.isSuperAdmin) {
 return triggerError(t('Super Admin accounts cannot be deleted!'));
 }

 setConfirmDeleteUserId(userId);
 };

 const executeDeleteUser = async () => {
 if (!confirmDeleteUserId) return;
 const userToDelete = db.users.find(u => u.id === confirmDeleteUserId);
 if (!userToDelete) {
 setConfirmDeleteUserId(null);
 return;
 }

 // Previously fire-and-forget (`.catch(console.error)`, never awaited) — local state
 // was updated and "deleted" success shown unconditionally, so a rejected server
 // delete (403 cross-tenant, 500, etc.) left the user still existing server-side while
 // the UI claimed it was gone.
 try {
 const res = await fetch(`/api/users/${confirmDeleteUserId}`, { method: 'DELETE' });
 if (!res.ok) {
 const body = await res.json().catch(() => ({}));
 triggerError(body.error || t('Failed to delete user — the server rejected this request.'));
 setConfirmDeleteUserId(null);
 return;
 }
 } catch (err) {
 triggerError(t('Failed to delete user — check your connection and try again.'));
 setConfirmDeleteUserId(null);
 return;
 }

 // DELETE /api/users/:id already persisted isDeleted:1 server-side — refetch instead
 // of hand-setting the flag locally and pushing the whole db blob through /api/migrate.
 await onRefreshDb?.();
 triggerSuccess(`${t('User')} "${userToDelete.username}" ${t('has been deleted.')}`);
 setConfirmDeleteUserId(null);
 };

 // ----------------------------------------
 // SUB-TAB: EQUITY & INVESTOR RELATION
 // ----------------------------------------
 const [investorForm, setInvestorForm] = React.useState({
 name: '',
 email: '',
 phone: '',
 equityPercentage: '',
 profitPercentage: '',
 notes: '',
 companyId: db.selectedCompanyId
 });

 const [investmentForm, setInvestmentForm] = React.useState({
 investorId: '',
 bankId: '',
 amount: '',
 date: new Date().toISOString().split('T')[0],
 description: ''
 });

 const handleAddInvestor = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!investorForm.name.trim()) return triggerError('Investor name is required.');

 const pct = parseFloat(investorForm.equityPercentage) || 0;
 if (pct < 0 || pct > 100) return triggerError('Equity percentage must be between 0 and 100.');

 const profitPct = investorForm.profitPercentage !== '' ? parseFloat(investorForm.profitPercentage) : pct;
 if (isNaN(profitPct) || profitPct < 0 || profitPct > 100) return triggerError('Profit percentage must be between 0 and 100.');

 // id/capitalContributed/createdAt were previously generated inside dbStore.ts's
 // saveInvestor — that function is no longer called (it only ran locally, never
 // persisted server-side), so the same defaults are generated here before POSTing.
 const newInvestor: Omit<Investor, 'companyId'> & { companyId: string } = {
 id: generateId(),
 name: investorForm.name.trim(),
 email: investorForm.email.trim(),
 phone: investorForm.phone.trim(),
 equityPercentage: pct,
 profitPercentage: profitPct,
 capitalContributed: 0,
 isActive: true,
 notes: investorForm.notes.trim() || undefined,
 createdAt: new Date().toISOString(),
 companyId: db.selectedCompanyId
 };

 try {
   const res = await fetch('/api/transactions/investors', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify(newInvestor)
   });
   const data = await res.json().catch(() => ({}));
   if (!res.ok || data.error) return triggerError(data.error || 'Failed to register investor.');
   triggerSuccess(`Investor "${newInvestor.name}" registered successfully.`);
   setInvestorForm({
     name: '',
     email: '',
     phone: '',
     equityPercentage: '',
     profitPercentage: '',
     notes: '',
     companyId: db.selectedCompanyId
   });
   if (onRefreshDb) await onRefreshDb();
 } catch (err: any) {
   triggerError(err.message || 'Failed to register investor.');
 }
 };

 const handleAddInvestment = async (e: React.FormEvent) => {
 e.preventDefault();
 const amountNum = parseFloat(investmentForm.amount);
 if (isNaN(amountNum) || amountNum <= 0) return triggerError('Please enter a valid contribution amount.');
 if (!investmentForm.investorId) return triggerError('Please select an investor.');
 if (!investmentForm.bankId) return triggerError('Please select a target bank account.');

 try {
 const res = await fetch(`/api/transactions/investors/${investmentForm.investorId}/investment`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({
 bankId: investmentForm.bankId,
 amount: amountNum,
 date: investmentForm.date,
 description: investmentForm.description || 'Equity capital injection'
 })
 });
 if (!res.ok) {
 const body = await res.json().catch(() => ({}));
 triggerError(body.error || 'Failed to record investment — the server rejected this request.');
 return;
 }
 triggerSuccess(`Successfully recorded investment of ${currencySymbol} ${amountNum.toFixed(2)}.`);
 await onRefreshDb?.();
 setInvestmentForm({
 investorId: '',
 bankId: '',
 amount: '',
 date: new Date().toISOString().split('T')[0],
 description: ''
 });
 } catch (err) {
 triggerError('Failed to record investment — check your connection and try again.');
 }
 };

 // ----------------------------------------
 // RENDERING
 // ----------------------------------------
 return (
 <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden min-h-[500px]">
 
 {/* Notifications */}
 {successMsg && (
 <div className="bg-emerald-50 text-emerald-700 p-3 px-6 text-xs font-semibold border-b border-emerald-100 flex items-center gap-2">
 <CheckCircle className="w-4 h-4 text-emerald-500" />
 <span>{successMsg}</span>
 </div>
 )}
 {errorMsg && (
 <div className="bg-rose-50 text-rose-700 p-3 px-6 text-xs font-semibold border-b border-rose-100 flex items-center gap-2">
 <AlertTriangle className="w-4 h-4 text-rose-500" />
 <span>{errorMsg}</span>
 </div>
 )}

  {/* TOP ADMIN HUB BAR WITH LAYOUT TOGGLE */}
  <div className="bg-slate-900 text-white p-4 px-6 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-slate-800">
    <div className="flex items-center gap-3">
      <div className="w-10 h-10 rounded-xl bg-indigo-600/30 border border-indigo-500/40 flex items-center justify-center shrink-0">
        <Settings className="w-5 h-5 text-indigo-400" />
      </div>
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-extrabold uppercase tracking-wider text-slate-100">{t('Administration & Governance Hub')}</h2>
          <span className="text-[10px] bg-indigo-500/20 text-indigo-300 font-bold px-2 py-0.5 rounded-full border border-indigo-500/30">
            {useSleekLayout ? t('⚡ Sleek Hub (Max Workspace)') : t('🗂️ Classic Sidebar')}
          </span>
        </div>
        <p className="text-[11px] text-slate-400 mt-0.5">{t('Manage organization profiles, permissions, banking, taxes, and system ledger configurations.')}</p>
      </div>
    </div>

    {/* Layout Mode Toggle */}
    <div className="flex items-center bg-slate-800/90 p-1 rounded-xl border border-slate-700 shrink-0 shadow-inner">
      <button
        onClick={() => setUseSleekLayout(true)}
        className={`px-3.5 py-1.5 rounded-lg text-xs font-extrabold transition-all flex items-center gap-1.5 cursor-pointer ${
          useSleekLayout
            ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30 ring-1 ring-indigo-400/30'
            : 'text-slate-400 hover:text-slate-200'
        }`}
        title="Switch to full-width Sleek Header Layout"
      >
        <Sparkles className="w-3.5 h-3.5 text-amber-300" />
        <span>{t('Sleek Hub')}</span>
      </button>
      <button
        onClick={() => setUseSleekLayout(false)}
        className={`px-3.5 py-1.5 rounded-lg text-xs font-extrabold transition-all flex items-center gap-1.5 cursor-pointer ${
          !useSleekLayout
            ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30 ring-1 ring-indigo-400/30'
            : 'text-slate-400 hover:text-slate-200'
        }`}
        title="Switch to Classic Sidebar Layout"
      >
        <Building className="w-3.5 h-3.5" />
        <span>{t('Classic Sidebar')}</span>
      </button>
    </div>
  </div>

  {/* SLEEK TOP NAVIGATION BAR (ONLY SHOWN IN SLEEK MODE) */}
  {useSleekLayout && (
    <div className="border-b border-slate-200/80 bg-slate-50/90 p-3.5 px-6 space-y-3">
      {/* Category Level Tabs */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
        {CATEGORY_GROUPS.filter(cat => cat.subTabs.some(st => isTabVisible(st))).map((cat) => {
          const isCatActive = cat.subTabs.some(st => st.id === activeTab);
          const IconComp = cat.icon;

          return (
            <button
              key={cat.id}
              onClick={() => {
                const available = cat.subTabs.find(st => isTabVisible(st));
                if (available) setActiveTab(available.id as any);
              }}
              className={`px-4 py-2.5 rounded-xl text-xs font-extrabold flex items-center gap-2.5 shrink-0 transition-all cursor-pointer border ${
                isCatActive
                  ? 'bg-indigo-600 text-white border-indigo-600 shadow-md shadow-indigo-600/20 ring-2 ring-indigo-600/20'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100 hover:border-slate-300'
              }`}
            >
              <IconComp className={`w-4 h-4 ${isCatActive ? 'text-white' : 'text-indigo-500'}`} />
              <span>{t(cat.label)}</span>
            </button>
          );
        })}
      </div>

      {/* Sub-Tabs Bar for Active Category */}
      <div className="flex items-center gap-2 pt-2 border-t border-slate-200/60 flex-wrap">
        {activeCatGroup?.subTabs
          .filter(st => isTabVisible(st))
          .map(st => {
            const isSubActive = activeTab === st.id;
            const SubIcon = st.icon;
            return (
              <button
                key={st.id}
                onClick={() => setActiveTab(st.id as any)}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-extrabold flex items-center gap-2 transition-all cursor-pointer border ${
                  isSubActive
                    ? 'bg-slate-900 text-white border-slate-900 shadow-sm'
                    : 'bg-white text-slate-600 hover:bg-slate-100 border-slate-200'
                }`}
              >
                <SubIcon className={`w-3.5 h-3.5 ${isSubActive ? 'text-indigo-400' : 'text-slate-400'}`} />
                <span>{t(st.label)}</span>
              </button>
            );
          })}
      </div>
    </div>
  )}

  <div className={useSleekLayout ? "block min-h-[500px]" : "grid grid-cols-1 md:grid-cols-4 min-h-[500px]"}>
    {/* Sidebar Nav */}
    {!useSleekLayout && (
      <div className="bg-slate-50/50 border-e border-slate-200/80 p-5 space-y-6">
        {/* Renders from the SAME CATEGORY_GROUPS source of truth the Sleek Hub layout
            uses above, instead of a second hand-maintained copy of every tab's id/
            label/grouping — that duplication is exactly how this layout ended up with
            zero t() translation wiring (every label here was a raw hardcoded string)
            AND silently missing two entire tabs ('zatca' and 'roles' had no button in
            this layout at all, so a Classic-Sidebar admin had no way to reach ZATCA
            settings or Roles/RBAC unless activeTab already happened to be on one of
            them from elsewhere). One source of truth now — this layout can't drift
            from Sleek Hub's tab list again. */}
        {CATEGORY_GROUPS.map(cat => {
          const visibleSubTabs = cat.subTabs.filter(st => isTabVisible(st));
          if (visibleSubTabs.length === 0) return null;
          return (
            <div key={cat.id} className="space-y-1.5">
              <p className="text-[9px] font-extrabold text-slate-400 uppercase tracking-widest px-3 mb-2">{t(cat.label)}</p>
              {visibleSubTabs.map(st => {
                const SubIcon = st.icon;
                const isActive = activeTab === st.id;
                return (
                  <button
                    key={st.id}
                    onClick={() => setActiveTab(st.id as any)}
                    className={`w-full text-start px-3.5 py-2.5 text-xs font-bold rounded-2xl flex items-center justify-between transition-all duration-150 ${isActive ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/10' : 'text-slate-600 hover:bg-slate-100/60'}`}
                  >
                    <span className="flex items-center gap-2.5">
                      <SubIcon className={`w-4 h-4 shrink-0 ${isActive ? '' : CLASSIC_SIDEBAR_ICON_COLOR[st.id] || 'text-slate-400'}`} />
                      {t(st.label)}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    )}

    {/* Form Area */}
    <div className={useSleekLayout ? "p-6 md:p-8 w-full" : "col-span-3 p-6 md:p-8"}>
 
 {/* TAB: ZATCA E-INVOICING PHASE 2 */}
 {activeTab === 'zatca' && (
   <ZatcaOnboardingWizard db={db} />
 )}

 {/* TAB: COMPANIES */}
 {activeTab === 'companies' && (
 <div className="space-y-6">
 <div>
 <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wide">{t('Multi-Organization & Company Profiles')}</h3>
 <p className="text-[11px] text-slate-400 mt-0.5">As an Administrator, you can view all registered companies or spin up a new company profile with automated workspace defaults.</p>
 </div>

 <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
 {/* DIRECTORY LISTING */}
 <div className="lg:col-span-2 space-y-4">
 <h4 className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider block mb-1">Registered Organizations ({db.companies?.length || 0})</h4>
 
 <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
 {(db.companies || []).map((company) => {
 const theme = THEME_PROFILES.find(p => p.id === company.themeId) || THEME_PROFILES[0];
 const companyBanks = db.banks.filter(b => b.companyId === company.id);
 // Several fiscal months can be open concurrently per company now (cap of 3); show the
 // oldest (the only one currently closable) plus a count of the rest, if any.
 const companyOpenMonths = fiscalMonths
 .filter(m => m.companyId === company.id && m.status === 'Open')
 .sort((a, b) => a.id.localeCompare(b.id));
 const activeMonth = companyOpenMonths[0];
 
 return (
 <div key={company.id} className="p-4 bg-white border border-slate-200/60 rounded-2xl shadow-sm hover:shadow-md transition-all duration-200 flex flex-col justify-between">
 <div>
 <div className="flex items-start justify-between gap-2.5 mb-3">
 <div className="flex items-center gap-2.5">
 <div className="w-10 h-10 rounded-2xl bg-slate-50 border border-slate-100 flex items-center justify-center p-1 relative">
 {company.logoUrl ? (
 <img src={company.logoUrl} alt={company.name} className="w-full h-full object-contain" referrerPolicy="no-referrer" />
 ) : (
 <span className="font-extrabold text-sm text-indigo-600 ">
 {company.name.substring(0, 2).toUpperCase()}
 </span>
 )}
 </div>
 <div>
 <h5 className="font-extrabold text-xs text-slate-800 ">{company.name}</h5>
 <span className="font-mono text-[9px] px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded font-semibold">{company.id}</span>
 </div>
 </div>

 <div className="flex flex-col items-end gap-1">
 <span className="px-2 py-0.5 bg-indigo-50 text-indigo-700 font-extrabold rounded text-[9px] uppercase tracking-wider">
 {company.currency || 'SAR'}
 </span>
 {company.registrationStatus && company.registrationStatus !== 'Registered' && (
 <span className={`px-2 py-0.5 font-extrabold rounded text-[9px] uppercase tracking-wider ${
 company.registrationStatus === 'Trial' ? 'bg-amber-50 text-amber-700' : 'bg-rose-50 text-rose-700'
 }`}>
 {t(company.registrationStatus)}
 </span>
 )}
 </div>
 </div>

 <div className="space-y-1.5 text-[11px] border-t border-slate-100 pt-3">
 <div className="flex justify-between">
 <span className="text-slate-400">VAT Reg:</span>
 <span className="font-mono text-slate-700 font-semibold">{company.vatNumber || 'N/A'}</span>
 </div>
 <div className="flex justify-between">
 <span className="text-slate-400">Branding:</span>
 <span className="text-slate-700 font-semibold truncate max-w-[120px]" title={company.portalTitle}>{company.portalTitle}</span>
 </div>
 <div className="flex justify-between">
 <span className="text-slate-400">Active Month:</span>
 <span className="text-emerald-600 font-extrabold uppercase text-[10px]">
 {activeMonth ? `🔓 ${activeMonth.name}${companyOpenMonths.length > 1 ? ` (+${companyOpenMonths.length - 1})` : ''}` : '🔒 All Closed'}
 </span>
 </div>
 <div className="flex justify-between">
 <span className="text-slate-400">Accounts/Banks:</span>
 <span className="text-slate-700 font-semibold">{companyBanks.length} configured</span>
 </div>
 <div className="flex items-center justify-between border-t border-slate-100/50 pt-1.5 mt-1.5">
   <span className="text-slate-400 flex items-center gap-1">
     <span>🛡️</span> ZATCA Integration:
   </span>
   <div className="flex items-center gap-2">
     <span className={`font-mono text-[9px] font-bold px-1.5 py-0.5 rounded uppercase ${company.zatcaEnabled ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>
       {company.zatcaEnabled ? 'Enabled' : 'Disabled'}
     </span>
     <label className="relative inline-flex items-center cursor-pointer scale-75 origin-right">
       <input
         type="checkbox"
         checked={company.zatcaEnabled || false}
         onChange={(e) => handleToggleZatcaEnabled(company.id, e.target.checked)}
         className="sr-only peer"
       />
       <div className="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
     </label>
   </div>
 </div>
 <div className="flex items-center justify-between border-t border-slate-100/50 pt-1.5 mt-1.5">
   <span className="text-slate-400 flex items-center gap-1">
     <span>📋</span> {t('Registration:')}
   </span>
   <div className="flex items-center gap-1.5">
     {(company.registrationStatus || 'Registered') === 'Trial' && (
       <>
         <button type="button" onClick={() => handleSetRegistrationStatus(company.id!, 'Registered')} className="text-[9px] font-bold text-emerald-600 hover:text-emerald-800 uppercase cursor-pointer">{t('Mark Registered')}</button>
         <button type="button" onClick={() => handleSetRegistrationStatus(company.id!, 'Cancelled')} className="text-[9px] font-bold text-rose-500 hover:text-rose-700 uppercase cursor-pointer">{t('Cancel')}</button>
       </>
     )}
     {(company.registrationStatus || 'Registered') === 'Registered' && (
       <button type="button" onClick={() => handleSetRegistrationStatus(company.id!, 'Cancelled')} className="text-[9px] font-bold text-rose-500 hover:text-rose-700 uppercase cursor-pointer">{t('Cancel Registration')}</button>
     )}
     {company.registrationStatus === 'Cancelled' && (
       <>
         <button type="button" onClick={() => handleSetRegistrationStatus(company.id!, 'Registered')} className="text-[9px] font-bold text-emerald-600 hover:text-emerald-800 uppercase cursor-pointer">{t('Reinstate')}</button>
         <button type="button" onClick={() => setDeletingCompany({ id: company.id!, name: company.name })} className="text-[9px] font-black text-white bg-rose-600 hover:bg-rose-700 px-2 py-0.5 rounded uppercase tracking-wider cursor-pointer">{t('Delete Company & All Data')}</button>
       </>
     )}
   </div>
 </div>
 </div>
 </div>

 <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between">
 <div className="flex items-center gap-1.5">
 <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Theme:</span>
 <div className="flex items-center gap-0.5">
 <span className="w-2.5 h-2.5 rounded-full border border-white shadow-sm" style={{ backgroundColor: theme.variables.primaryColor }} title={theme.name} />
 <span className="w-2.5 h-2.5 rounded-full border border-white shadow-sm" style={{ backgroundColor: theme.variables.accentBase }} />
 </div>
 <span className="text-[10px] text-slate-500 font-medium truncate max-w-[80px]">{theme.name}</span>
 </div>

 {db.selectedCompanyId === company.id ? (
 <span className="text-[9px] font-black text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full uppercase tracking-wider">Active Workspace</span>
 ) : (
 <button
 onClick={() => {
 // Purely a local "which company am I viewing" switch — same as the sidebar/header
 // company switchers in App.tsx (Phase 0 fix) — nothing changed that needs
 // persisting, so no sync at all, not even the local-only variant's setState-only
 // effect needs to be framed as a "sync."
 applyTheme(company.themeId || 'classic-executive');

 onUpdateDbLocal(prev => ({ ...prev, selectedCompanyId: company.id!, companySetup: company }));
 triggerSuccess(`Switched active workspace to "${company.name}"`);
 }}
 className="text-[10px] font-bold text-indigo-600 hover:text-indigo-800 :text-indigo-300 transition-colors"
 >
 Switch to...
 </button>
 )}
 </div>
 </div>
 );
 })}
 </div>
 </div>

 {/* CREATE NEW COMPANY FORM */}
 <div className="p-5 bg-slate-50 border border-slate-200/60 rounded-2xl">
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3">Register New Organization</h4>
 
 <form onSubmit={handleAddCompany} className="space-y-4">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Organization Name</label>
 <input
 type="text"
 required
 placeholder="e.g. Freon Corporate"
 value={newCompany.name}
 onChange={(e) => setNewCompany({ ...newCompany, name: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>

 <div className="grid grid-cols-2 gap-3">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Currency</label>
 <input
 type="text"
 required
 placeholder="e.g. SAR or USD"
 value={newCompany.currency}
 onChange={(e) => setNewCompany({ ...newCompany, currency: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-semibold"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">VAT Number (Optional)</label>
 <input
 type="text"
 inputMode="numeric"
 maxLength={15}
 placeholder="15 digits"
 value={newCompany.vatNumber}
 onChange={(e) => setNewCompany({ ...newCompany, vatNumber: e.target.value.replace(/\D/g, '').slice(0, 15) })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-mono"
 />
 </div>
 </div>

 <div className="grid grid-cols-2 gap-3">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Phone</label>
 <input
 type="text"
 placeholder="+966..."
 value={newCompany.phone}
 onChange={(e) => setNewCompany({ ...newCompany, phone: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Email</label>
 <input
 type="email"
 placeholder="contact@freon.sa"
 value={newCompany.email}
 onChange={(e) => setNewCompany({ ...newCompany, email: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Theme Accent</label>
 <select
 value={newCompany.themeId}
 onChange={(e) => setNewCompany({ ...newCompany, themeId: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-3 py-2 text-xs text-slate-800 focus:outline-none"
 >
 {THEME_PROFILES.map(p => (
 <option key={p.id} value={p.id}>{p.name}</option>
 ))}
 </select>
 </div>

 <div className="p-3.5 rounded-2xl bg-slate-100/50 border border-slate-200/60 space-y-3">
   <div className="space-y-0.5">
     <span className="text-[11px] font-bold text-slate-700">Inventory & Procurement</span>
     <p className="text-[9px] text-slate-400">Stock registries, PO, and GRN workflows are always available — access is controlled per-role in Roles, not by a company switch.</p>
   </div>

   <div className="space-y-2 pt-2 border-t border-slate-200/60">
     <div className="space-y-1">
       <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">PR Workflow</label>
       <select
         value={newCompany.inventorySettings?.prOptionality || 'OPTIONAL'}
         onChange={(e) => setNewCompany({
           ...newCompany,
           inventorySettings: {
             prOptionality: e.target.value as any,
             isDsdAllowed: newCompany.inventorySettings?.isDsdAllowed ?? true
           }
         })}
         className="w-full bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 text-[11px] text-slate-800 focus:outline-none"
       >
         <option value="MANDATORY">Mandatory PR</option>
         <option value="OPTIONAL">Optional PR</option>
         <option value="BYPASSED">Bypassed PR</option>
       </select>
     </div>

     <div className="flex items-center justify-between mt-1">
       <span className="text-[10px] text-slate-500 font-medium">Allow Direct Shop Delivery (DSD)</span>
       <label className="relative inline-flex items-center cursor-pointer scale-90">
         <input
           type="checkbox"
           checked={newCompany.inventorySettings?.isDsdAllowed ?? true}
           onChange={(e) => setNewCompany({
             ...newCompany,
             inventorySettings: {
               prOptionality: newCompany.inventorySettings?.prOptionality || 'OPTIONAL',
               isDsdAllowed: e.target.checked
             }
           })}
           className="sr-only peer"
         />
         <div className="w-8 h-4.5 bg-slate-200 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-3.5 after:w-3.5 after:transition-all peer-checked:bg-indigo-600"></div>
       </label>
     </div>
   </div>
 </div>

 <div className="space-y-1.5 border-t border-slate-200 pt-3">
 <span className="text-[9px] font-extrabold text-slate-400 uppercase tracking-widest block mb-1">Document Serials Setup</span>
 <div className="grid grid-cols-2 gap-2">
 <div className="space-y-1">
 <label className="text-[9px] text-slate-400 uppercase font-semibold">Invoice Starts At</label>
 <input
 type="number"
 value={newCompany.counters?.invoice}
 onChange={(e) => setNewCompany({
 ...newCompany,
 counters: { ...newCompany.counters!, invoice: parseInt(e.target.value) || 1001 }
 })}
 className="w-full bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs text-slate-800 font-mono text-center"
 />
 </div>
 <div className="space-y-1">
 <label className="text-[9px] text-slate-400 uppercase font-semibold">Quotation Starts</label>
 <input
 type="number"
 value={newCompany.counters?.quotation}
 onChange={(e) => setNewCompany({
 ...newCompany,
 counters: { ...newCompany.counters!, quotation: parseInt(e.target.value) || 1001 }
 })}
 className="w-full bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs text-slate-800 font-mono text-center"
 />
 </div>
 </div>
 </div>

 <div className="p-3 bg-amber-50/50 border border-amber-100/60 rounded-2xl">
 <p className="text-[10px] font-bold text-amber-800 uppercase tracking-wide">⭐ Automatic Seed Provisioning</p>
 <p className="text-[9px] text-amber-700 mt-1 leading-normal">
 To save you setup effort, registering this profile will auto-provision standard business resources: A Main Operating Bank, a Walk-in Customer, a Cash Vendor, a Main Warehouse, a Standard English PDF Template, and an open Operational Month period ({new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' })}).
 </p>
 </div>

 <button
 type="submit"
 className="w-full bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl py-2.5 font-bold text-xs transition shadow-sm"
 >
 Provision Organization
 </button>
 </form>
 </div>
 </div>
 </div>
 )}

 {/* TAB: COMPANY ONBOARDING REQUESTS */}
 {activeTab === 'onboarding' && (
 <div className="space-y-6 animate-fade-in">
 <div>
 <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wide">{t('Onboarding Requests')}</h3>
 <p className="text-[11px] text-slate-400 mt-0.5">{t('Public company signup requests (submitted via the ?onboard=1 link). Approving one atomically creates the company, its starter resources, and a user account for the requester.')}</p>
 </div>

 {successMsg && (
 <div className="p-3 bg-emerald-50 text-emerald-700 rounded-2xl border border-emerald-100 text-xs font-semibold">{successMsg}</div>
 )}
 {errorMsg && (
 <div className="p-3 bg-rose-50 text-rose-700 rounded-2xl border border-rose-100 text-xs font-semibold break-all">{errorMsg}</div>
 )}

 <div className="border border-slate-100 rounded-2xl overflow-hidden shadow-sm">
 <table className="w-full text-xs">
 <thead>
 <tr className="bg-slate-50 text-slate-500">
 <th className="p-3 text-start">{t('Company')}</th>
 <th className="p-3 text-start">{t('Contact')}</th>
 <th className="p-3 text-start">{t('Submitted')}</th>
 <th className="p-3 text-center">{t('Status')}</th>
 <th className="p-3 text-end">{t('Actions')}</th>
 </tr>
 </thead>
 <tbody>
 {(db.companyOnboardingRequests || []).length === 0 ? (
 <tr><td colSpan={5} className="p-6 text-center text-slate-400">{t('No onboarding requests yet.')}</td></tr>
 ) : (db.companyOnboardingRequests || []).map(r => (
 <React.Fragment key={r.id}>
 <tr className="border-b border-slate-100 last:border-0">
 <td className="p-3">
 <p className="font-semibold text-slate-800">{r.companyName}</p>
 <p className="text-[10px] text-slate-400">{r.companyEmail}</p>
 </td>
 <td className="p-3">
 <p className="text-slate-700">{r.contactName}</p>
 <p className="text-[10px] text-slate-400">{r.contactEmail}</p>
 </td>
 <td className="p-3 text-slate-500 font-mono text-[10px]">{r.createdAt ? new Date(r.createdAt).toLocaleString() : '-'}</td>
 <td className="p-3 text-center">
 <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase border ${
 r.status === 'Pending' ? 'bg-amber-50 text-amber-700 border-amber-200' :
 r.status === 'Approved' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
 'bg-slate-100 text-slate-500 border-slate-200'
 }`}>{r.status}</span>
 </td>
 <td className="p-3 text-end">
 {r.status === 'Pending' && (
 <div className="flex justify-end gap-3">
 <button type="button" onClick={() => { setReviewingRequestId(reviewingRequestId === r.id ? null : r.id); setRejectingRequestId(null); }} className="text-[10px] font-bold text-indigo-600 hover:underline">{t('Approve')}</button>
 <button type="button" onClick={() => { setRejectingRequestId(rejectingRequestId === r.id ? null : r.id); setReviewingRequestId(null); }} className="text-[10px] font-bold text-rose-600 hover:underline">{t('Reject')}</button>
 </div>
 )}
 {r.status === 'Approved' && r.reviewedAt && (
 <span className="text-[10px] text-slate-400">{t('Approved')} {new Date(r.reviewedAt).toLocaleDateString()}</span>
 )}
 {r.status === 'Rejected' && (
 <span className="text-[10px] text-slate-400" title={r.rejectionReason || ''}>{t('Rejected')}</span>
 )}
 </td>
 </tr>
 {reviewingRequestId === r.id && (
 <tr className="bg-indigo-50/40 border-b border-slate-100">
 <td colSpan={5} className="p-4">
 <div className="space-y-3">
 <div className="flex flex-wrap items-center gap-4">
 <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 cursor-pointer">
 <input type="radio" checked={approvalMode === 'admin'} onChange={() => setApprovalMode('admin')} />
 {t('Full Company Admin access')}
 </label>
 <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 cursor-pointer">
 <input type="radio" checked={approvalMode === 'template'} onChange={() => setApprovalMode('template')} />
 {t('Assign a Role Template')}
 </label>
 {approvalMode === 'template' && (
 <select value={approvalTemplateId} onChange={(e) => setApprovalTemplateId(e.target.value)} className="bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500">
 <option value="">{t('Choose template...')}</option>
 {(db.roleTemplates || []).map(rt => (
 <option key={rt.id} value={rt.id}>{rt.name}</option>
 ))}
 </select>
 )}
 </div>
 {approvalMode === 'template' && (
 <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-100 rounded-xl p-2.5">
 {t('This user will NOT be able to create or edit Roles for their own company later — only a Company Admin or platform Super Admin can. Choose "Full Company Admin access" instead if that matters.')}
 </p>
 )}
 <div className="flex gap-2">
 <button type="button" disabled={onboardingActionLoading} onClick={() => handleApproveOnboarding(r.id)} className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-xl text-[10px] font-bold transition">
 {onboardingActionLoading ? t('Working...') : t('Confirm Approval')}
 </button>
 <button type="button" onClick={() => setReviewingRequestId(null)} className="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-600 rounded-xl text-[10px] font-bold transition">{t('Cancel')}</button>
 </div>
 </div>
 </td>
 </tr>
 )}
 {rejectingRequestId === r.id && (
 <tr className="bg-rose-50/40 border-b border-slate-100">
 <td colSpan={5} className="p-4">
 <div className="space-y-3">
 <textarea
 value={rejectionReason}
 onChange={(e) => setRejectionReason(e.target.value)}
 placeholder={t('Optional reason (shown to the requester by email)')}
 className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-rose-500"
 rows={2}
 />
 <div className="flex gap-2">
 <button type="button" disabled={onboardingActionLoading} onClick={() => handleRejectOnboarding(r.id)} className="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white rounded-xl text-[10px] font-bold transition">
 {onboardingActionLoading ? t('Working...') : t('Confirm Rejection')}
 </button>
 <button type="button" onClick={() => { setRejectingRequestId(null); setRejectionReason(''); }} className="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-600 rounded-xl text-[10px] font-bold transition">{t('Cancel')}</button>
 </div>
 </div>
 </td>
 </tr>
 )}
 </React.Fragment>
 ))}
 </tbody>
 </table>
 </div>
 </div>
 )}

 {/* TAB: ROLE TEMPLATES */}
 {activeTab === 'roleTemplates' && (
 <div className="space-y-6 animate-fade-in">
 <div>
 <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wide">{t('Role Templates')}</h3>
 <p className="text-[11px] text-slate-400 mt-0.5">{t('A reusable, cross-company permission-set library — unlike ordinary Roles, these are not tied to any one company. Cloned into a brand-new company\'s own Roles when you approve an onboarding request in template mode.')}</p>
 </div>

 {successMsg && (
 <div className="p-3 bg-emerald-50 text-emerald-700 rounded-2xl border border-emerald-100 text-xs font-semibold">{successMsg}</div>
 )}
 {errorMsg && (
 <div className="p-3 bg-rose-50 text-rose-700 rounded-2xl border border-rose-100 text-xs font-semibold">{errorMsg}</div>
 )}

 <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
 <div className="lg:col-span-5 space-y-4">
 <form onSubmit={handleSaveRoleTemplate} className="bg-white border border-slate-200/60 rounded-2xl p-5 shadow-sm space-y-4">
 <div className="flex items-center justify-between">
 <h4 className="text-xs font-extrabold text-slate-700 uppercase tracking-wider">
 {roleTemplateForm.id ? t('Edit Template') : t('Create New Template')}
 </h4>
 {roleTemplateForm.id && (
 <button
 type="button"
 onClick={() => setRoleTemplateForm({ id: null, name: '', description: '', permissions: {} })}
 className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg text-[9px] font-bold uppercase transition"
 >
 {t('Cancel Edit')}
 </button>
 )}
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Template Name')}</label>
 <input
 type="text"
 required
 placeholder={t('e.g. Sales Manager, Accountant')}
 value={roleTemplateForm.name}
 onChange={(e) => setRoleTemplateForm(prev => ({ ...prev, name: e.target.value }))}
 className="w-full bg-slate-50 border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-semibold"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Description')} ({t('optional')})</label>
 <input
 type="text"
 placeholder={t('What is this template for?')}
 value={roleTemplateForm.description}
 onChange={(e) => setRoleTemplateForm(prev => ({ ...prev, description: e.target.value }))}
 className="w-full bg-slate-50 border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>

 <PermissionTree
 permissions={roleTemplateForm.permissions}
 onChange={(updated) => setRoleTemplateForm(prev => ({ ...prev, permissions: updated }))}
 t={t}
 />

 <button
 type="submit"
 className="w-full bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl py-2 font-bold text-xs transition shadow-sm cursor-pointer"
 >
 {roleTemplateForm.id ? t('Update Template') : t('Create Template')}
 </button>
 </form>
 </div>

 <div className="lg:col-span-7 space-y-4">
 <div className="bg-white border border-slate-200/60 rounded-2xl p-5 shadow-sm">
 <h4 className="text-xs font-extrabold text-slate-700 uppercase tracking-wider mb-4">
 {t('Templates')} ({(db.roleTemplates || []).length})
 </h4>
 <div className="space-y-2.5">
 {(db.roleTemplates || []).length === 0 && (
 <p className="text-xs text-slate-400 italic py-6 text-center">{t('No role templates created yet.')}</p>
 )}
 {(db.roleTemplates || []).map(rt => (
 <div key={rt.id} className="p-3 bg-slate-50 border border-slate-200/60 rounded-2xl flex items-center justify-between gap-3">
 <div className="min-w-0">
 <p className="text-xs font-bold text-slate-800 truncate">{rt.name}</p>
 {rt.description && <p className="text-[10px] text-slate-400 truncate">{rt.description}</p>}
 </div>
 <div className="flex items-center gap-1.5 shrink-0">
 <button
 type="button"
 onClick={() => setRoleTemplateForm({ id: rt.id, name: rt.name, description: rt.description || '', permissions: rt.permissions || {} })}
 className="p-1.5 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-all cursor-pointer"
 title={t('Edit template')}
 >
 <Edit2 className="w-3.5 h-3.5" />
 </button>
 {confirmDeleteRoleTemplateId === rt.id ? (
 <>
 <button type="button" onClick={() => handleDeleteRoleTemplate(rt.id)} className="px-2 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-[10px] font-bold transition">{t('Confirm')}</button>
 <button type="button" onClick={() => setConfirmDeleteRoleTemplateId(null)} className="px-2 py-1 bg-slate-200 hover:bg-slate-300 text-slate-600 rounded-lg text-[10px] font-bold transition">{t('Cancel')}</button>
 </>
 ) : (
 <button
 type="button"
 onClick={() => setConfirmDeleteRoleTemplateId(rt.id)}
 className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-all cursor-pointer"
 title={t('Delete template')}
 >
 <Trash2 className="w-3.5 h-3.5" />
 </button>
 )}
 </div>
 </div>
 ))}
 </div>
 </div>
 </div>
 </div>
 </div>
 )}

 {/* TAB: COMPANY */}

        {activeTab === 'pos' && (() => {
          const activeCompany = db.companies.find(c => c.id === db.selectedCompanyId)!;
          const gridColumns = posDraft.gridColumns || 5;
          const gridRows = posDraft.gridRows || 4;
          const applyDraft = (patch: Record<string, any>) => setPosDraft((prev: any) => ({ ...prev, ...patch }));
          const presets: Array<{ key: 'compact' | 'standard' | 'dense'; label: string; cols: number; rows: number }> = [
            { key: 'compact', label: t('Compact (12 tiles)'), cols: 3, rows: 4 },
            { key: 'standard', label: t('Standard (20 tiles)'), cols: 5, rows: 4 },
            { key: 'dense', label: t('Dense (30 tiles)'), cols: 6, rows: 5 },
          ];
          const activePreset = posDraft.gridDensityPreset || (presets.find(p => p.cols === gridColumns && p.rows === gridRows)?.key) || 'custom';
          const savedSettings = activeCompany.posSettings || {};
          const hasUnsavedChanges = JSON.stringify({ ...savedSettings }) !== JSON.stringify({ ...posDraft });
          const handleSavePosSettings = async () => {
            setIsSavingPosSettings(true);
            await handlePosSettingsChange(activeCompany.id, posDraft);
            setIsSavingPosSettings(false);
            triggerSuccess('POS settings saved.');
          };
          return (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-extrabold text-slate-900 tracking-tight mb-2">POS Configuration</h2>
                <p className="text-sm text-slate-500 font-medium">Configure Point of Sale settings, receipts, and behaviors.</p>
              </div>
              <div className="flex items-center gap-3">
                {hasUnsavedChanges && <span className="text-xs font-bold text-amber-600">{t('Unsaved changes')}</span>}
                <button
                  type="button"
                  onClick={handleSavePosSettings}
                  disabled={isSavingPosSettings || !hasUnsavedChanges}
                  className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl text-sm font-bold transition"
                >
                  <Check className="w-3.5 h-3.5" />
                  {isSavingPosSettings ? t('Saving...') : t('Save Changes')}
                </button>
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-sm">
              <div className="space-y-4">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" checked={posDraft.autoPrint ?? true} onChange={e => {
                    applyDraft({ autoPrint: e.target.checked });
                  }} className="w-5 h-5 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500" />
                  <div>
                    <div className="text-sm font-bold text-slate-800">Auto-Print Receipts</div>
                    <div className="text-xs text-slate-500">Automatically print thermal receipts after payment</div>
                  </div>
                </label>

                <div>
                  <label className="block text-sm font-bold text-slate-800 mb-2">Max POS Product Image Size (KB)</label>
                  <input type="number" min="50" max="5000" value={posDraft.maxImageSizeKB || 150} onChange={e => {
                    applyDraft({ maxImageSizeKB: parseInt(e.target.value) || 150 });
                  }} className="w-full max-w-xs bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-xl px-4 py-2.5 focus:ring-2 focus:ring-indigo-600" />
                  <p className="text-xs text-slate-500 mt-1">Recommended: 150KB — these ride along on every page load for every user, so keeping them small matters.</p>
                </div>

                <div>
                  <label className="block text-sm font-bold text-slate-800 mb-2">Max Image Dimensions (pixels)</label>
                  <input type="number" min="100" max="2000" value={posDraft.maxImageDimensions || 600} onChange={e => {
                    applyDraft({ maxImageDimensions: parseInt(e.target.value) || 600 });
                  }} className="w-full max-w-xs bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-xl px-4 py-2.5 focus:ring-2 focus:ring-indigo-600" />
                  <p className="text-xs text-slate-500 mt-1">Recommended: 600px — well above anything this app actually displays a product image at. Uploads larger than this are rejected, not resized.</p>
                </div>

                <div>
                  <label className="block text-sm font-bold text-slate-800 mb-2">Min Image Dimensions (pixels)</label>
                  <input type="number" min="0" max="1000" value={posDraft.minImageDimensions ?? 150} onChange={e => {
                    applyDraft({ minImageDimensions: parseInt(e.target.value) || 0 });
                  }} className="w-full max-w-xs bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-xl px-4 py-2.5 focus:ring-2 focus:ring-indigo-600" />
                  <p className="text-xs text-slate-500 mt-1">Recommended: 150px — rejects blurry/low-quality uploads scaled up from something tiny. Set to 0 to disable.</p>
                </div>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-sm">
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-bold text-slate-800">{t('POS Terminal Grid Density')}</h3>
                  <p className="text-xs text-slate-500 mt-0.5">{t('How many priority tiles the cashier\'s Terminal screen shows at once — items beyond this are still reachable via category tabs or search. See "Modifier Groups" and each product\'s "POS Grid Position" field to choose which items appear here.')}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {presets.map(p => (
                    <button key={p.key} type="button"
                      onClick={() => applyDraft({ gridColumns: p.cols, gridRows: p.rows, gridDensityPreset: p.key })}
                      className={`px-4 py-2 rounded-xl text-xs font-bold border transition-colors ${activePreset === p.key ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-slate-50 border-slate-200 text-slate-600 hover:border-indigo-300'}`}>
                      {p.label}
                    </button>
                  ))}
                  <button type="button"
                    onClick={() => applyDraft({ gridDensityPreset: 'custom' })}
                    className={`px-4 py-2 rounded-xl text-xs font-bold border transition-colors ${activePreset === 'custom' ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-slate-50 border-slate-200 text-slate-600 hover:border-indigo-300'}`}>
                    {t('Custom')}
                  </button>
                </div>
                <div className="flex items-center gap-4">
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">{t('Columns')}</label>
                    <input type="number" min={2} max={10} value={gridColumns}
                      onChange={e => applyDraft({ gridColumns: Math.max(2, Math.min(10, parseInt(e.target.value) || 2)), gridDensityPreset: 'custom' })}
                      className="w-24 bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-xl px-3 py-2 focus:ring-2 focus:ring-indigo-600" />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">{t('Rows')}</label>
                    <input type="number" min={2} max={8} value={gridRows}
                      onChange={e => applyDraft({ gridRows: Math.max(2, Math.min(8, parseInt(e.target.value) || 2)), gridDensityPreset: 'custom' })}
                      className="w-24 bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-xl px-3 py-2 focus:ring-2 focus:ring-indigo-600" />
                  </div>
                  <div className="text-xs font-bold text-slate-500 pt-5">= {gridColumns * gridRows} {t('tiles on screen')}</div>
                </div>
                {gridColumns * gridRows > 200 / 2 && (gridColumns > 8 || gridRows > 6) && (
                  <p className="text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-100 rounded-xl p-3">
                    ⚠ {t('A very dense grid makes tiles harder to tap accurately on touch hardware — consider fewer columns/rows, or a larger POS display.')}
                  </p>
                )}
              </div>
            </div>
          </div>
          );
        })()}

{activeTab === 'company' && (
 <div className="space-y-6">
 <div>
 <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wide">{t('Global Company Setup')}</h3>
 <p className="text-[11px] text-slate-400 mt-0.5">These details are applied globally to all printed quotations, invoices, and expenses.</p>
 </div>

 <form onSubmit={handleCompanySave} className="space-y-4">
 <div className="grid grid-cols-2 gap-4">
 <div className="space-y-1.5 col-span-2">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Company Logo</label>
 <div className="grid grid-cols-1 md:grid-cols-5 gap-4 items-start">
 {/* Drag and Drop Zone */}
 <div
 onDragOver={handleDragOver}
 onDragLeave={handleDragLeave}
 onDrop={handleDrop}
 className={`md:col-span-3 border-2 border-dashed rounded-2xl p-5 flex flex-col items-center justify-center text-center cursor-pointer transition-all duration-150 ${
 isDragging
 ? 'border-indigo-500 bg-indigo-50/50'
 : 'border-slate-200 hover:border-indigo-400 bg-slate-50/50 hover:bg-indigo-50/10'
 }`}
 onClick={() => document.getElementById('logo-file-input')?.click()}
 >
 <input
 id="logo-file-input"
 type="file"
 accept="image/*,.bmp"
 onChange={(e) => {
 if (e.target.files && e.target.files[0]) {
 handleLogoFile(e.target.files[0]);
 }
 }}
 className="hidden"
 />
 <Upload className="w-6 h-6 text-slate-400 mb-2" />
 <p className="text-xs font-semibold text-slate-700">
 {isDragging ? 'Drop your logo here' : 'Click or Drag Logo here'}
 </p>
 <p className="text-[10px] text-slate-400 mt-1">Supports PNG, JPG, WEBP, and BMP</p>
 <span className="text-[9px] text-indigo-600 font-bold bg-indigo-50 px-2 py-0.5 rounded-full mt-2 inline-block">
 BMP automatically converted to optimized PNG
 </span>
 </div>

 {/* Preview Zone */}
 <div className="md:col-span-2 border border-slate-200 rounded-2xl p-4 flex flex-col items-center justify-center bg-white h-[124px] relative group">
 {companyForm.logoUrl ? (
 <>
 <img
 src={companyForm.logoUrl}
 alt="Logo Preview"
 className="max-h-16 max-w-full object-contain mb-1.5"
 referrerPolicy="no-referrer"
 />
 <button
 type="button"
 onClick={() => setCompanyForm(prev => ({ ...prev, logoUrl: '' }))}
 className="absolute top-2 end-2 p-1 bg-rose-50 text-rose-600 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity hover:bg-rose-100"
 title="Remove Logo"
 >
 <Trash2 className="w-3.5 h-3.5" />
 </button>
 <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Logo Active</span>
 </>
 ) : (
 <div className="flex flex-col items-center justify-center text-center">
 <Image className="w-6 h-6 text-slate-300 mb-1" />
 <span className="text-[10px] font-medium text-slate-400">No Custom Logo</span>
 <span className="text-[9px] text-slate-300 mt-0.5">Defaults to CNC text</span>
 </div>
 )}
 </div>
 </div>

 {/* Manual Override text field */}
 <div className="mt-2.5">
 <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wide block mb-1">
 Manual Logo URL or Raw Base64 string
 </label>
 <input
 type="text"
 placeholder="e.g. https://domain.com/logo.png or Base64 string"
 value={companyForm.logoUrl}
 onChange={(e) => setCompanyForm({ ...companyForm, logoUrl: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-mono text-[10px]"
 />
 </div>
 </div>

 <div className="space-y-1.5">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Company Name</label>
 <input
 type="text"
 required
 value={companyForm.name}
 onChange={(e) => setCompanyForm({ ...companyForm, name: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-2xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>

 <div className="space-y-1.5">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Contact Phone</label>
 <input
 type="text"
 value={companyForm.phone}
 onChange={(e) => setCompanyForm({ ...companyForm, phone: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-2xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>

 <div className="space-y-1.5">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Contact Email</label>
 <input
 type="email"
 value={companyForm.email}
 onChange={(e) => setCompanyForm({ ...companyForm, email: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-2xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>

 <div className="space-y-1.5">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Physical Address</label>
 <input
 type="text"
 value={companyForm.address}
 onChange={(e) => setCompanyForm({ ...companyForm, address: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-2xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>

 <div className="space-y-1.5">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Saudi VAT Registration Number (15 digits)</label>
 <input
 type="text"
 inputMode="numeric"
 maxLength={15}
 placeholder="e.g. 300123456700003"
 value={companyForm.vatNumber || ''}
 onChange={(e) => setCompanyForm({ ...companyForm, vatNumber: e.target.value.replace(/\D/g, '').slice(0, 15) })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-2xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>

 <div className="space-y-1.5">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Commercial Registration Number (CR)</label>
 <input
 type="text"
 placeholder="e.g. 1010000000"
 value={companyForm.crNumber || ''}
 onChange={(e) => setCompanyForm({ ...companyForm, crNumber: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-2xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>

 <div className="space-y-1.5">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">ERP Currency Symbol / Code</label>
 <input
 type="text"
 placeholder="e.g. SAR, USD, $, £"
 value={companyForm.currency || 'SAR'}
 onChange={(e) => setCompanyForm({ ...companyForm, currency: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-2xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>

 <div className="space-y-1.5">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Portal Sidebar Branding Title</label>
 <input
 type="text"
 placeholder="e.g. CNC FAB PORTAL"
 value={companyForm.portalTitle || ''}
 onChange={(e) => setCompanyForm({ ...companyForm, portalTitle: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-2xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150 font-semibold"
 />
 </div>

 <div className="space-y-1.5 col-span-2">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Portal Sidebar Branding Subtitle</label>
 <input
 type="text"
 placeholder="e.g. Shop ERP System"
 value={companyForm.portalSubtitle || ''}
 onChange={(e) => setCompanyForm({ ...companyForm, portalSubtitle: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-2xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150 font-semibold"
 />
 </div>

 <div className="space-y-1.5 col-span-2">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Custom Header text (Bilingual/Intro info)</label>
 <textarea
 rows={2}
 value={companyForm.customHeader}
 onChange={(e) => setCompanyForm({ ...companyForm, customHeader: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-2xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>

 <div className="space-y-1.5 col-span-2">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Custom Footer text (Terms, Warranty, etc.)</label>
 <textarea
 rows={2}
 value={companyForm.customFooter}
 onChange={(e) => setCompanyForm({ ...companyForm, customFooter: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-2xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>

 <div className="col-span-2 border-t border-slate-100 pt-4 space-y-4">
   <div>
     <h4 className="text-xs font-extrabold text-slate-800 tracking-tight uppercase">Inventory & Purchasing Workflow</h4>
     <p className="text-[10px] text-slate-400 mt-0.5">Stock registries, PR, PO, and GRN are always available to any role granted the matching permission in Roles — these settings only control the PR/PO/GRN workflow itself, not whether the module appears.</p>
   </div>

   <div className="p-4 rounded-2xl bg-slate-50/50 border border-slate-100 space-y-4">
     <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
       <div className="space-y-1.5">
         <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Purchase Requisition Workflow</label>
         <select
           value={companyForm.inventorySettings?.prOptionality || 'OPTIONAL'}
           onChange={(e) => setCompanyForm({
             ...companyForm,
             inventorySettings: {
               prOptionality: e.target.value as any,
               isDsdAllowed: companyForm.inventorySettings?.isDsdAllowed ?? true
             }
           })}
           className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-2xl px-3 py-2 text-xs text-slate-800 focus:outline-none transition-all duration-150"
         >
           <option value="MANDATORY">Mandatory PR (Requires Approval before PO)</option>
           <option value="OPTIONAL">Optional PR (Can create PO standalone or from PR)</option>
           <option value="BYPASSED">Bypassed PR (Disable PR, PO is the entry point)</option>
         </select>
         <p className="text-[9px] text-slate-400">Controls whether Purchase Requisitions must precede official Purchase Orders.</p>
       </div>

       <div className="space-y-1.5 flex flex-col justify-between">
         <div className="flex items-center justify-between mt-1">
           <div className="space-y-0.5">
             <span className="text-[11px] font-bold text-slate-700">Allow Direct Shop Delivery (DSD)</span>
             <p className="text-[9px] text-slate-400">Permit suppliers to receive goods directly (GRN) without requiring a pre-approved PO.</p>
           </div>
           <label className="relative inline-flex items-center cursor-pointer">
             <input
               type="checkbox"
               checked={companyForm.inventorySettings?.isDsdAllowed ?? true}
               onChange={(e) => setCompanyForm({
                 ...companyForm,
                 inventorySettings: {
                   prOptionality: companyForm.inventorySettings?.prOptionality || 'OPTIONAL',
                   isDsdAllowed: e.target.checked
                 }
               })}
               className="sr-only peer"
             />
             <div className="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
           </label>
         </div>
       </div>

       <div className="space-y-1.5 flex flex-col justify-between">
         <div className="flex items-center justify-between mt-1">
           <div className="space-y-0.5">
             <span className="text-[11px] font-bold text-slate-700">Enforce Stock Availability at Sale</span>
             <p className="text-[9px] text-slate-400">Block a sale of a stock item once its resolved sales warehouse doesn't have enough quantity on hand, instead of silently allowing the balance to go to zero.</p>
           </div>
           <label className="relative inline-flex items-center cursor-pointer">
             <input
               type="checkbox"
               checked={companyForm.inventorySettings?.enforceStockAvailability ?? false}
               onChange={(e) => setCompanyForm({
                 ...companyForm,
                 inventorySettings: {
                   prOptionality: companyForm.inventorySettings?.prOptionality || 'OPTIONAL',
                   isDsdAllowed: companyForm.inventorySettings?.isDsdAllowed ?? true,
                   enforceStockAvailability: e.target.checked
                 }
               })}
               className="sr-only peer"
             />
             <div className="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
           </label>
         </div>
       </div>
     </div>
   </div>
 </div>

 <div className="col-span-2 border-t border-slate-100 pt-4 space-y-3">
 <div>
 <h4 className="text-xs font-extrabold text-slate-800 tracking-tight uppercase">Portal Theme Profile</h4>
 <p className="text-[10px] text-slate-400 mt-0.5">Select the active visual layout theme for the workshop ERP. Selecting a profile instantly overrides accents, buttons, and active indicators.</p>
 </div>
 <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
 {THEME_PROFILES.map((p) => {
 const isSelected = (companyForm.themeId || 'classic-executive') === p.id;
 return (
 <button
 key={p.id}
 type="button"
 onClick={() => {
 setCompanyForm({ ...companyForm, themeId: p.id });
 applyTheme(p.id);
 }}
 className={`p-3 rounded-2xl border text-start transition flex flex-col justify-between h-28 relative cursor-pointer ${
 isSelected
 ? 'bg-indigo-50/50 border-indigo-600 ring-1 ring-indigo-600 shadow-sm'
 : 'bg-white border-slate-200 hover:border-slate-300 hover:bg-slate-50'
 }`}
 >
 <div>
 <div className="flex items-center justify-between">
 <span className="text-xs font-bold text-slate-800">{p.name}</span>
 {isSelected && (
 <span className="w-4 h-4 bg-indigo-600 text-white rounded-full flex items-center justify-center text-[10px] font-bold">
 ✓
 </span>
 )}
 </div>
 <p className="text-[10px] text-slate-400 mt-1 leading-snug line-clamp-2">
 {p.description}
 </p>
 </div>
 
 <div className="flex items-center gap-1.5 mt-2">
 <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider me-1">Palette:</span>
 <div className="flex items-center gap-1">
 <span className="w-3.5 h-3.5 rounded-full border border-white shadow-sm" style={{ backgroundColor: p.variables.primaryColor }} title="Primary Color" />
 <span className="w-3.5 h-3.5 rounded-full border border-white shadow-sm" style={{ backgroundColor: p.variables.accentBase }} title="Accent Color" />
 <span className="w-3.5 h-3.5 rounded-full border border-white shadow-sm" style={{ backgroundColor: p.variables.primaryLight }} title="Light Accent" />
 </div>
 </div>
 </button>
 );
 })}
 </div>
 </div>
 </div>

 <div className="pt-3 flex justify-end">
 <button
 type="submit"
 className="bg-indigo-600 hover:bg-indigo-700 hover:shadow-lg hover:shadow-indigo-600/10 text-white rounded-2xl px-5 py-2.5 text-xs font-extrabold transition-all duration-150 shadow-sm"
 >
 Save Company Configuration
 </button>
 </div>
 </form>
 </div>
 )}

 {/* TAB: BANK MANAGEMENT */}
 {activeTab === 'banks' && (
 <div className="space-y-8">
 {/* List Banks with ledger balances */}
 <div>
 <h3 className="text-sm font-bold text-slate-900 mb-4">{t('Active Bank Accounts & Ledger Balances')}</h3>
 <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
 {db.banks.filter(b => !b.companyId || b.companyId === db.selectedCompanyId).map(b => {
 const balance = getBankBalance(db, b.id);
 return (
 <div
 key={b.id}
 className={`p-4 rounded-2xl border transition relative flex flex-col justify-between ${
 b.isDefault
 ? 'bg-indigo-50/40 border-indigo-200'
 : 'bg-white border-slate-100 hover:border-slate-200 shadow-sm'
 }`}
 >
 <div>
 <div className="flex justify-between items-start">
 <div>
 <p className="font-bold text-xs text-slate-900">{b.bankName}</p>
 <p className="text-[10px] text-slate-400 mt-0.5">{t('Account Title:')} {b.accountTitle}</p>
 <p className="text-[10px] text-slate-400 font-mono mt-0.5">{t('No:')} {b.accountNumber}</p>
 </div>
 <div className="flex gap-1.5">
 {b.isDefault && (
 <span className="px-1.5 py-0.5 bg-indigo-100 text-indigo-700 font-bold rounded text-[9px] uppercase">
 {t('Default')}
 </span>
 )}
 <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${b.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-400'}`}>
 {b.isActive ? t('Active') : t('Inactive')}
 </span>
 </div>
 </div>

 <div className="mt-3">
 <span className="text-[10px] text-slate-400 uppercase font-semibold">{t('Running Balance')}</span>
 <p className={`text-base font-black ${balance < 0 ? 'text-rose-600' : 'text-slate-800'}`}>
 {currencySymbol} {balance.toFixed(2)}
 {balance < 0 && <span className="text-[9px] text-rose-500 font-semibold ms-1.5 uppercase tracking-wide">{t('Negative')}</span>}
 </p>
 </div>
 </div>

 {/* Actions */}
 <div className="mt-4 pt-3 border-t border-slate-100/60 flex justify-end gap-2 items-center">
 {canUpdateBanks && (
 <>
 <button
 type="button"
 onClick={() => {
 setEditingBankId(b.id);
 setBankForm({
 bankName: b.bankName,
 accountTitle: b.accountTitle,
 accountNumber: b.accountNumber,
 openingBalance: b.openingBalance,
 isActive: b.isActive,
 isDefault: b.isDefault
 });
 setTimeout(() => {
 document.getElementById('bank-form-section')?.scrollIntoView({ behavior: 'smooth' });
 }, 50);
 }}
 className="text-[10px] font-bold text-slate-500 hover:text-indigo-600 transition"
 >
 {t('Edit')}
 </button>
 <span className="text-slate-200 text-xs font-light">|</span>
 </>
 )}
 {canUpdateBanks && !b.isDefault && b.isActive && (
 <>
 <button
 onClick={() => handleSetDefaultBank(b.id)}
 className="text-[10px] font-bold text-indigo-600 hover:text-indigo-800"
 >
 {t('Set Default')}
 </button>
 <span className="text-slate-200 text-xs font-light">|</span>
 </>
 )}
 {canDeleteBanks && (
 <button
 onClick={() => handleToggleBankActive(b.id)}
 className={`text-[10px] font-bold ${b.isActive ? 'text-rose-500 hover:text-rose-700' : 'text-emerald-500 hover:text-emerald-700'}`}
 >
 {b.isActive ? t('Deactivate') : t('Activate')}
 </button>
 )}
 </div>
 </div>
 );
 })}
 </div>
 </div>

 {/* Add Bank Form */}
 {(editingBankId ? canUpdateBanks : canCreateBanks) && (
 <div id="bank-form-section" className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3">
 {editingBankId ? t('Edit Bank Account Details') : t('Add New Bank Account')}
 </h4>
 <form onSubmit={handleAddBank} className="grid grid-cols-2 gap-3.5">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Bank Name')}</label>
 <input
 type="text"
 required
 placeholder={t('e.g. Riyad Bank, Al Rajhi')}
 value={bankForm.bankName}
 onChange={(e) => setBankForm({ ...bankForm, bankName: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Account Title')}</label>
 <input
 type="text"
 required
 placeholder={t('e.g. CNC Woodcraft LLC')}
 value={bankForm.accountTitle}
 onChange={(e) => setBankForm({ ...bankForm, accountTitle: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Account Number / IBAN')}</label>
 <input
 type="text"
 required
 placeholder={t('SA...')}
 value={bankForm.accountNumber}
 onChange={(e) => setBankForm({ ...bankForm, accountNumber: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Opening Balance')}</label>
 <input
 type="number"
 required
 placeholder="0.00"
 value={bankForm.openingBalance === 0 ? '0' : (bankForm.openingBalance || '')}
 onChange={(e) => setBankForm({ ...bankForm, openingBalance: e.target.value === '' ? 0 : parseFloat(e.target.value) })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>
 <div className="col-span-2 flex items-center gap-4 mt-1.5">
 <label className="flex items-center gap-1.5 text-xs text-slate-600">
 <input
 type="checkbox"
 checked={bankForm.isDefault}
 onChange={(e) => setBankForm({ ...bankForm, isDefault: e.target.checked })}
 className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
 />
 <span>{t('Set as Global Default Bank')}</span>
 </label>
 </div>
 <div className="col-span-2 flex justify-end gap-2">
 {editingBankId && (
 <button
 type="button"
 onClick={() => {
 setEditingBankId(null);
 setBankForm({
 bankName: '',
 accountNumber: '',
 accountTitle: '',
 openingBalance: 0,
 isActive: true,
 isDefault: false
 });
 }}
 className="bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-2xl px-3.5 py-1.5 text-xs font-bold transition shadow-sm"
 >
 {t('Cancel Edit')}
 </button>
 )}
 <button
 type="submit"
 className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl px-3.5 py-1.5 text-xs font-bold flex items-center gap-1 shadow-sm transition"
 >
 {editingBankId ? (
 <>
 <Check className="w-3.5 h-3.5" /> {t('Save Changes')}
 </>
 ) : (
 <>
 <Plus className="w-3.5 h-3.5" /> {t('Add Account')}
 </>
 )}
 </button>
 </div>
 </form>
 </div>
 )}

 {/* Inter-bank cash transfer */}
 {canTransferBanks && (
 <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
 <div className="flex items-center gap-1.5 mb-3">
 <ArrowRightLeft className="w-4 h-4 text-slate-500" />
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">{t('Inter-Bank Funds Transfer')}</h4>
 </div>
 <form onSubmit={handleInterBankTransfer} className="grid grid-cols-1 md:grid-cols-4 gap-3.5">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('From Account')}</label>
 <select
 required
 value={transferForm.sourceBankId}
 onChange={(e) => setTransferForm({ ...transferForm, sourceBankId: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 >
 <option value="">{t('Select source bank')}</option>
 {db.banks.filter(b => b.isActive && (!b.companyId || b.companyId === db.selectedCompanyId)).map(b => (
 <option key={b.id} value={b.id}>{b.bankName} ({currencySymbol} {getBankBalance(db, b.id).toFixed(2)})</option>
 ))}
 </select>
 </div>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('To Account')}</label>
 <select
 required
 value={transferForm.destBankId}
 onChange={(e) => setTransferForm({ ...transferForm, destBankId: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 >
 <option value="">{t('Select dest bank')}</option>
 {db.banks.filter(b => b.isActive && (!b.companyId || b.companyId === db.selectedCompanyId)).map(b => (
 <option key={b.id} value={b.id}>{b.bankName} ({currencySymbol} {getBankBalance(db, b.id).toFixed(2)})</option>
 ))}
 </select>
 </div>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Amount')} ({currencySymbol})</label>
 <input
 type="number"
 required
 step="0.01"
 placeholder="0.00"
 value={transferForm.amount}
 onChange={(e) => setTransferForm({ ...transferForm, amount: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Transfer Date')}</label>
 <input
 type="date"
 required
 value={transferForm.date}
 onChange={(e) => setTransferForm({ ...transferForm, date: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>
 <div className="md:col-span-3 space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Reason / Memo')}</label>
 <input
 type="text"
 placeholder={t('e.g. Funding operations, balancing reserves')}
 value={transferForm.description}
 onChange={(e) => setTransferForm({ ...transferForm, description: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>
 <div className="flex items-end">
 <button
 type="submit"
 className="w-full bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl py-2 text-xs font-bold flex items-center justify-center gap-1 shadow-sm"
 >
 <ArrowRightLeft className="w-3.5 h-3.5" /> {t('Transfer Funds')}
 </button>
 </div>
 </form>
 </div>
 )}
 </div>
 )}

 {/* TAB: TAX SLABS */}
 {activeTab === 'taxes' && (
 <div className="space-y-6">
 <div>
 <h3 className="text-sm font-bold text-slate-900">{t('Tax Slab Configuration')}</h3>
 <p className="text-[11px] text-slate-400">{t('Define percentages for document taxes. Standard values 0% and 15% are configured by default.')}</p>
 </div>

 <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
 {/* List tax slabs */}
 <div className="border border-slate-100 rounded-2xl overflow-hidden shadow-sm">
 <table className="w-full text-xs">
 <thead>
 <tr className="bg-slate-50 text-slate-500">
 <th className="p-3 text-start">{t('Tax Description')}</th>
 <th className="p-3 text-end">{t('Percentage Value')}</th>
 <th className="p-3 text-center">{t('Default')}</th>
 </tr>
 </thead>
 <tbody>
 {/* Every tax slab now belongs to exactly one company (no more shared/global
     rows) — this must filter to the active company, or every company sees and
     can toggle the default on every OTHER company's tax slabs too. */}
 {companyTaxSlabs.map((ts, idx) => (
 <React.Fragment key={ts.id}>
 <tr className={ts.percentage === 0 ? '' : 'border-b border-slate-100'}>
 <td className="p-3 font-semibold text-slate-800">{ts.name}</td>
 <td className="p-3 text-end font-mono font-bold text-indigo-600">{ts.percentage}%</td>
 <td className="p-3 text-center">
 {ts.isDefault ? (
 <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase bg-emerald-50 text-emerald-700 border border-emerald-200">
 ⭐ {t('Default')}
 </span>
 ) : (
 // Shown for both this company's own slabs AND shared/legacy ones (companyId
 // null) — picking a shared one clones it into a company-owned default rather
 // than mutating the shared row (see handleSetDefaultTaxSlab), so every
 // company can independently pick its own default from the same starting list.
 // Gated on taxSlabs.update (not .create) because PATCH /tax-slabs/:id/set-default
 // checks taxSlabs.update server-side — matching the real route, not the label.
 canUpdateTaxSlabs && (
 <button
 type="button"
 onClick={() => handleSetDefaultTaxSlab(ts.id)}
 className="text-[10px] font-bold text-indigo-600 hover:text-indigo-800 hover:underline"
 >
 {t('Set Default')}
 </button>
 )
 )}
 </td>
 </tr>
 {/* ZATCA requires a TaxExemptionReasonCode/Reason on any 0%-rate line whose slab
     name contains "exempt" (server/lib/zatca/processInvoice.ts's resolveTaxCategoryCode
     — 0% + name doesn't say "exempt" resolves to Zero-rated 'Z' instead, which has the
     same requirement but isn't this UI's scope right now). No safe default exists (a
     real VATEX-SA-xx legal classification varies per company), so this is an explicit,
     optional admin action rather than something auto-filled. */}
 {ts.percentage === 0 && canUpdateTaxSlabs && (
 <tr className="border-b border-slate-100 bg-amber-50/40">
 <td colSpan={3} className="px-3 pb-3">
 {editingExemptionId === ts.id ? (
 <div className="space-y-1.5 pt-1">
 <div className="grid grid-cols-2 gap-1.5">
 <input
 type="text"
 placeholder={t('VATEX-SA-xx code')}
 value={exemptionForm.code}
 onChange={e => setExemptionForm({ ...exemptionForm, code: e.target.value })}
 className="text-[10px] border border-slate-200 rounded-lg px-2 py-1"
 />
 <input
 type="text"
 placeholder={t('Reason text')}
 value={exemptionForm.reason}
 onChange={e => setExemptionForm({ ...exemptionForm, reason: e.target.value })}
 className="text-[10px] border border-slate-200 rounded-lg px-2 py-1"
 />
 </div>
 <div className="flex gap-2">
 <button type="button" onClick={() => handleSaveExemptionReason(ts.id)} className="text-[10px] font-bold text-emerald-700 hover:underline">{t('Save')}</button>
 <button type="button" onClick={() => setEditingExemptionId(null)} className="text-[10px] font-bold text-slate-400 hover:underline">{t('Cancel')}</button>
 </div>
 </div>
 ) : (
 <div className="flex items-center justify-between">
 <span className="text-[10px] text-amber-700">
 {ts.exemptionReasonCode
 ? <>{t('ZATCA Exemption Reason')}: <span className="font-mono font-bold">{ts.exemptionReasonCode}</span> — {ts.exemptionReason}</>
 : t('No ZATCA exemption reason set — invoices using this slab will carry the BR-KSA-23 sandbox warning.')}
 </span>
 <button
 type="button"
 onClick={() => { setEditingExemptionId(ts.id); setExemptionForm({ code: ts.exemptionReasonCode || '', reason: ts.exemptionReason || '' }); }}
 className="text-[10px] font-bold text-indigo-600 hover:underline shrink-0 ms-2"
 >
 {ts.exemptionReasonCode ? t('Edit') : t('Set Reason')}
 </button>
 </div>
 )}
 </td>
 </tr>
 )}
 </React.Fragment>
 ))}
 </tbody>
 </table>
 </div>

 {/* Add Slab form — a new row, gated on taxSlabs.create. POST /tax-slabs now
     branches create-vs-update by whether the submitted id already exists (see
     server/routes/masterEntities.ts), matching every other CRUD module. */}
 {canCreateTaxSlabs && (
 <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100 flex flex-col justify-between">
 <div>
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3">{t('Add Custom Tax Slab')}</h4>
 <form onSubmit={handleAddTax} className="space-y-4">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Slab Title')}</label>
 <input
 type="text"
 required
 placeholder={t('e.g. VAT (15%), Regional (5%)')}
 value={taxForm.name}
 onChange={(e) => setTaxForm({ ...taxForm, name: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Tax Percentage (%)')}</label>
 <input
 type="number"
 required
 step="0.1"
 placeholder="0.00"
 value={taxForm.percentage}
 onChange={(e) => setTaxForm({ ...taxForm, percentage: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>
 <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
 <input
 type="checkbox"
 checked={taxForm.isDefault}
 onChange={(e) => setTaxForm({ ...taxForm, isDefault: e.target.checked })}
 className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5"
 />
 <span>{t('Set as default for this company')}{companyTaxSlabs.length === 0 ? ` (${t('automatic — first slab')})` : ''}</span>
 </label>
 <div className="flex justify-end pt-1">
 <button
 type="submit"
 className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl px-4 py-1.5 text-xs font-bold flex items-center gap-1 shadow-sm"
 >
 <Plus className="w-3.5 h-3.5" /> {t('Save Slab')}
 </button>
 </div>
 </form>
 </div>
 </div>
 )}
 </div>
 </div>
 )}

 {/* TAB: BRANCHES (LOCATIONS) */}
 {activeTab === 'branches' && (
 <div className="space-y-6">
 <div>
 <h3 className="text-sm font-bold text-slate-900">{t('Branches (Locations)')}</h3>
 <p className="text-[11px] text-slate-400">{t('Physical locations under this company. Each invoice/quotation can be attributed to one, and its ZATCA seller address on the e-invoice reflects that branch\'s own address when set.')}</p>
 </div>

 {canUpdateBranches && companyBranches.length > 0 && (
 <div className="p-4 rounded-2xl bg-amber-50/60 border border-amber-100 flex flex-col md:flex-row md:items-center gap-3">
 <div className="flex-1 space-y-0.5">
 <span className="text-[11px] font-bold text-amber-800">{t('Backfill Unassigned Documents')}</span>
 <p className="text-[10px] text-amber-700/80">{t('Attribute every existing document (invoices, quotations, vouchers, expenses, purchase requisitions/orders/bills, warehouses) that has no branch yet to one branch. Safe to re-run — only rows that are currently unassigned are touched.')}</p>
 </div>
 <div className="flex items-center gap-2 shrink-0">
 <select
 value={backfillTargetBranchId}
 onChange={e => setBackfillTargetBranchId(e.target.value)}
 className="bg-white border border-amber-200 rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-amber-500"
 >
 <option value="">{t('Choose branch...')}</option>
 {companyBranches.map(b => (
 <option key={b.id} value={b.id}>{b.name}</option>
 ))}
 </select>
 <button
 type="button"
 disabled={isBackfilling || !backfillTargetBranchId}
 onClick={() => handleBackfillUnassigned(backfillTargetBranchId)}
 className="bg-amber-600 hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl px-3 py-1.5 text-xs font-bold whitespace-nowrap"
 >
 {isBackfilling ? t('Working...') : t('Run Backfill')}
 </button>
 </div>
 </div>
 )}

 <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
 <div className="lg:col-span-2 border border-slate-100 rounded-2xl overflow-hidden shadow-sm">
 <table className="w-full text-xs">
 <thead>
 <tr className="bg-slate-50 text-slate-500">
 <th className="p-3 text-start">{t('Name')}</th>
 <th className="p-3 text-start">{t('Code')}</th>
 <th className="p-3 text-start">{t('City')}</th>
 <th className="p-3 text-center">{t('Status')}</th>
 <th className="p-3 text-end">{t('Actions')}</th>
 </tr>
 </thead>
 <tbody>
 {companyBranches.length === 0 ? (
 <tr><td colSpan={5} className="p-6 text-center text-slate-400">{t('No branches yet. A super-admin can create the first one.')}</td></tr>
 ) : companyBranches.map(b => (
 <tr key={b.id} className="border-b border-slate-100 last:border-0">
 <td className="p-3 font-semibold text-slate-800">
 {b.name}
 {b.isDefault && <span className="ms-1.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase bg-emerald-50 text-emerald-700 border border-emerald-200">⭐ {t('Default')}</span>}
 </td>
 <td className="p-3 font-mono text-slate-600">{b.code}</td>
 <td className="p-3 text-slate-600">{b.city || '-'}</td>
 <td className="p-3 text-center">
 {b.isActive === false
 ? <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase bg-slate-100 text-slate-500 border border-slate-200">{t('Inactive')}</span>
 : <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase bg-emerald-50 text-emerald-700 border border-emerald-200">{t('Active')}</span>}
 </td>
 <td className="p-3 text-end">
 <div className="flex justify-end gap-3">
 {canUpdateBranches && (
 <button type="button" onClick={() => startEditBranch(b)} className="text-[10px] font-bold text-indigo-600 hover:underline">{t('Edit')}</button>
 )}
 {canDeleteBranches && (
 <button type="button" onClick={() => handleToggleBranchActive(b.id)} className="text-[10px] font-bold text-rose-500 hover:underline">
 {b.isActive === false ? t('Reactivate') : t('Deactivate')}
 </button>
 )}
 </div>
 </td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>

 {/* Add/Edit form. Creating a brand-new branch is deliberately super-admin-only —
     a licensing decision, not a permission leaf (mirrors POST /api/companies) — but
     an existing branch's own details are editable by anyone holding branches.update.
     A non-super-admin with no branches yet to edit simply sees nothing here, which
     is correct: there's nothing for them to do on this tab until one exists. */}
 {(db.currentUser?.isSuperAdmin || (editingBranchId && canUpdateBranches)) && (
 <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3">
 {editingBranchId ? t('Edit Branch') : t('Create New Branch')}
 </h4>
 <form onSubmit={handleSaveBranch} className="space-y-3">
 <div className="grid grid-cols-2 gap-3">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Branch Name')}</label>
 <input type="text" required value={branchForm.name} onChange={e => setBranchForm({ ...branchForm, name: e.target.value })}
 placeholder={t('e.g. Jeddah Branch')}
 className="w-full bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500" />
 </div>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Short Code')}</label>
 <input type="text" required value={branchForm.code} onChange={e => setBranchForm({ ...branchForm, code: e.target.value.toUpperCase() })}
 placeholder="JED" disabled={Boolean(editingBranchId)}
 className="w-full bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-slate-100 disabled:text-slate-400" />
 </div>
 </div>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Street Name')}</label>
 <input type="text" value={branchForm.streetName} onChange={e => setBranchForm({ ...branchForm, streetName: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500" />
 </div>
 <div className="grid grid-cols-2 gap-3">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Building Number')}</label>
 <input type="text" value={branchForm.buildingNumber} onChange={e => setBranchForm({ ...branchForm, buildingNumber: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500" />
 </div>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('District')}</label>
 <input type="text" value={branchForm.district} onChange={e => setBranchForm({ ...branchForm, district: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500" />
 </div>
 </div>
 <div className="grid grid-cols-2 gap-3">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('City')}</label>
 <input type="text" value={branchForm.city} onChange={e => setBranchForm({ ...branchForm, city: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500" />
 </div>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Postal Code')}</label>
 <input type="text" value={branchForm.postalCode} onChange={e => setBranchForm({ ...branchForm, postalCode: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500" />
 </div>
 </div>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Phone')}</label>
 <input type="text" value={branchForm.phone} onChange={e => setBranchForm({ ...branchForm, phone: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500" />
 </div>
 <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer pt-1">
 <input type="checkbox" checked={branchForm.isDefault} onChange={e => setBranchForm({ ...branchForm, isDefault: e.target.checked })}
 className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5" />
 <span>{t('Set as default for this company')}{companyBranches.length === 0 ? ` (${t('automatic — first branch')})` : ''}</span>
 </label>
 {!editingBranchId && (
 <label className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer pt-1">
 <input type="checkbox" checked={branchForm.autoCreateWarehouse} onChange={e => setBranchForm({ ...branchForm, autoCreateWarehouse: e.target.checked, defaultWarehouseId: '' })}
 className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5 mt-0.5" />
 <span>
 {t('Automatically create a matching warehouse for this branch')}
 <span className="block text-[10px] text-slate-400 font-normal mt-0.5">{t('Most retail branches are their own warehouse — the selling floor and the stock location are the same place. Uncheck this only if this branch will share an existing warehouse instead.')}</span>
 </span>
 </label>
 )}
 {(!branchForm.autoCreateWarehouse || Boolean(editingBranchId)) && branchEligibleWarehouses.length > 0 && (
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Default Sales Warehouse')}</label>
 <select value={branchForm.defaultWarehouseId} onChange={e => setBranchForm({ ...branchForm, defaultWarehouseId: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500">
 <option value="">{t('None — fall back to company default')}</option>
 {branchEligibleWarehouses.map(w => (
 <option key={w.id} value={w.id}>{w.name}</option>
 ))}
 </select>
 <p className="text-[10px] text-slate-400">{t('Auto-selected on a new Invoice/POS sale created under this branch, so staff never need to pick one manually.')}</p>
 </div>
 )}
 <div className="flex gap-2 justify-end pt-1">
 {editingBranchId && (
 <button type="button" onClick={clearBranchForm} className="px-4 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl font-bold text-xs">{t('Cancel')}</button>
 )}
 <button type="submit" className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl px-4 py-1.5 text-xs font-bold flex items-center gap-1 shadow-sm">
 <Plus className="w-3.5 h-3.5" /> {editingBranchId ? t('Save Branch') : t('Create Branch')}
 </button>
 </div>
 </form>
 </div>
 )}
 </div>
 </div>
 )}

 {/* TAB: DOCUMENT NUMBERING */}
 {activeTab === 'numbering' && (
 <div className="space-y-6">
 <div>
 <h3 className="text-sm font-bold text-slate-900">{t('Document Numbering')}</h3>
 <p className="text-[11px] text-slate-400">{t('How each document type\'s number is formatted for this company. The underlying sequence always counts company-wide, never per branch — a branch code, when enabled, only appears as cosmetic text in the printed number.')}</p>
 </div>

 {numberingLoading ? (
 <div className="text-xs text-slate-400 p-6 text-center">{t('Loading...')}</div>
 ) : (
 <div className="border border-slate-100 rounded-2xl overflow-hidden shadow-sm">
 <div className="overflow-x-auto">
 <table className="w-full text-xs">
 <thead>
 <tr className="bg-slate-50 text-slate-500">
 <th className="p-3 text-start">{t('Document Type')}</th>
 <th className="p-3 text-start">{t('Prefix')}</th>
 <th className="p-3 text-start">{t('Separator')}</th>
 <th className="p-3 text-start">{t('Pad Width')}</th>
 <th className="p-3 text-center">{t('Show Branch Code')}</th>
 <th className="p-3 text-start">{t('Reset')}</th>
 <th className="p-3 text-start">{t('Next Number Preview')}</th>
 </tr>
 </thead>
 <tbody>
 {numberingRegistry.map(entry => {
 const rule = numberingRules[entry.key] || {};
 const hasCollision = numberingPrefixCollisions.has(entry.key);
 return (
 <tr key={entry.key} className="border-b border-slate-100 last:border-0">
 <td className="p-3 font-semibold text-slate-800">
 {t(entry.label)}
 {hasCollision && (
 <span className="ms-1.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase bg-amber-50 text-amber-700 border border-amber-200" title={t('Another document type currently shares this same prefix')}>
 ⚠ {t('Prefix collision')}
 </span>
 )}
 </td>
 <td className="p-2">
 <input type="text" value={rule.prefix ?? entry.defaultPrefix}
 onChange={e => updateNumberingRule(entry.key, { prefix: e.target.value.toUpperCase() })}
 className="w-20 bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500" />
 </td>
 <td className="p-2">
 <input type="text" value={rule.separator ?? '-'} maxLength={3}
 onChange={e => updateNumberingRule(entry.key, { separator: e.target.value })}
 className="w-12 bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono text-center focus:outline-none focus:ring-1 focus:ring-indigo-500" />
 </td>
 <td className="p-2">
 <input type="number" min={0} max={10} value={rule.padWidth ?? 0}
 onChange={e => updateNumberingRule(entry.key, { padWidth: Math.max(0, parseInt(e.target.value) || 0) })}
 className="w-16 bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono text-center focus:outline-none focus:ring-1 focus:ring-indigo-500" />
 </td>
 <td className="p-2 text-center">
 <input type="checkbox" checked={rule.includeBranchCode ?? false}
 onChange={e => updateNumberingRule(entry.key, { includeBranchCode: e.target.checked })}
 className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5" />
 </td>
 <td className="p-2">
 <select value={rule.resetFrequency ?? 'never'}
 onChange={e => updateNumberingRule(entry.key, { resetFrequency: e.target.value as 'never' | 'yearly' | 'monthly' })}
 className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500">
 <option value="never">{t('Never')}</option>
 <option value="yearly">{t('Yearly')}</option>
 <option value="monthly">{t('Monthly')}</option>
 </select>
 </td>
 <td className="p-3 font-mono text-slate-600">{numberingPreview[entry.key] || '—'}</td>
 </tr>
 );
 })}
 </tbody>
 </table>
 </div>
 </div>
 )}

 <p className="text-[10px] text-slate-400">{t('Resets follow the document\'s own date, not today\'s date — a backdated document correctly still lands in its own period.')}</p>

 {canUpdateDocumentNumbering && (
 <div className="flex justify-end">
 <button type="button" onClick={handleSaveNumberingPolicy}
 className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl px-5 py-2 text-xs font-bold flex items-center gap-1.5 shadow-sm">
 <Check className="w-3.5 h-3.5" /> {t('Save Changes')}
 </button>
 </div>
 )}
 </div>
 )}

 {/* TAB: TEMPLATES */}
 {activeTab === 'templates' && (
  <div className="space-y-6 animate-fadeIn">
   {designingTemplateId ? (
    (() => {
     const tmpl = db.templates.find(t => t.id === designingTemplateId);
     if (!tmpl) return null;
     
     const availableBlocks = canvasBlocks.filter(b => b.visible === false);
     const activeBlocks = canvasBlocks.filter(b => b.visible !== false);
     const selectedBlock = canvasBlocks.find(b => b.id === selectedBlockId);

     // Advisory-only row composition — the real renderer's CSS grid (grid-cols-12 +
     // col-span-N) always wraps correctly on its own, so a row can never actually
     // overflow/break; this purely simulates that same greedy wrap so an admin can see
     // WHY a row looks uneven (e.g. a block landing alone on its own row because the
     // remaining space in the row above wasn't enough for it) instead of guessing.
     // Deliberately not a pass/fail warning — a row summing to less than 12 is often a
     // perfectly intentional design (e.g. one block centered alone), not a mistake.
     const canvasRows: { blocks: typeof activeBlocks; total: number }[] = [];
     for (const block of activeBlocks) {
      const currentRow = canvasRows[canvasRows.length - 1];
      if (currentRow && currentRow.total + block.w <= 12) {
       currentRow.blocks.push(block);
       currentRow.total += block.w;
      } else {
       canvasRows.push({ blocks: [block], total: block.w });
      }
     }

     return (
      <div className="space-y-6">
       {/* Designer Header */}
       <div className="flex flex-col md:flex-row justify-between items-start md:items-center bg-slate-50 p-5 rounded-2xl border border-slate-150 gap-4">
        <div>
         <div className="flex items-center gap-2">
          <span className="text-xl">🎨</span>
          <h3 className="text-sm font-extrabold text-slate-900">{t('Canvas Layout Designer:')} {tmpl.name}</h3>
          <span className={`px-1.5 py-0.5 rounded text-[8px] font-extrabold uppercase ${
           (tmpl.language === 'Arabic' || tmpl.language === 'Urdu') ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800'
          }`}>
           {tmpl.language}
          </span>
         </div>
         <p className="text-[11px] text-slate-500 mt-1">{t('Drag-and-drop elements to reorder. Adjust width spans. Configure properties to secure complete bilingual ZATCA compliance.')}</p>
         {/* Global Row Gap/Font Family below save to the server immediately on change;
             everything here (width, order, block properties, add/hide) stays local until
             "Save Layout Configuration" is clicked — surfaced explicitly since the two
             behave differently with no other visual cue. */}
         <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1 mt-2 inline-block">
          ⚠️ {t('Layout changes below (position, width, block settings) only save when you click')} <strong>{t('Save Layout Configuration')}</strong>. {t('Global Row Gap/Font Family (right panel) save immediately.')}
         </p>
        </div>
        <div className="flex gap-2 text-xs self-stretch md:self-auto justify-end items-start">
         <button
          type="button"
          onClick={() => {
            const tempTmpl: DocumentTemplate = {
              ...tmpl,
              layoutJson: JSON.stringify(canvasBlocks)
            };
            setPreviewTemplate(tempTmpl);
          }}
          className="px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-xl font-bold transition flex items-center gap-1.5 shadow-sm"
         >
          👁️ {t('Live Print Preview')}
         </button>
         <button
          type="button"
          onClick={handleResetLayout}
          className="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-xl font-bold transition flex items-center gap-1"
         >
          🔄 {t('Reset Default ZATCA')}
         </button>
         <button
          type="button"
          onClick={handleCancelCanvasDesigner}
          className="px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-xl font-bold transition"
         >
          {t('Cancel')}
         </button>
         <button
          type="button"
          onClick={handleSaveCanvasLayout}
          className={`px-4 py-1.5 rounded-xl font-bold shadow transition flex items-center gap-1.5 ${
           hasUnsavedCanvasChanges ? 'bg-indigo-600 hover:bg-indigo-700 text-white' : 'bg-slate-200 text-slate-500'
          }`}
         >
          💾 {t('Save Layout Configuration')}
          {hasUnsavedCanvasChanges && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" title={t('Unsaved changes')} />}
         </button>
        </div>
       </div>

       {/* Designer Body */}
       <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Left Panel: Block Configuration Library & Properties */}
        <div className="lg:col-span-1 space-y-4">
         {/* Property Editor */}
         {selectedBlock ? (
          <div className="p-4 bg-white border border-indigo-200 shadow-sm rounded-2xl space-y-4 animate-fadeIn">
           <div className="flex justify-between items-center pb-2 border-b border-slate-100">
            <span className="text-xs font-bold text-indigo-600 uppercase tracking-wider">{t('Configure Block')}</span>
            <button
             type="button"
             onClick={() => setSelectedBlockId(null)}
             className="text-[10px] text-slate-400 hover:text-slate-600"
            >
             ✕ {t('Close')}
            </button>
           </div>
           <div>
            <h4 className="text-xs font-extrabold text-slate-800">{selectedBlock.title}</h4>
            <p className="text-[9px] text-slate-400 mt-0.5">{t('Block Key:')} {selectedBlock.id}</p>
           </div>

           {/* Customize Option Fields */}
           <div className="space-y-4 pt-2">
            {/* Width Buttons */}
            <div className="space-y-1">
             <div className="flex justify-between items-center">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">{t('Grid Column Span')} ({selectedBlock.w}/12)</label>
              <span className="text-[9px] font-mono text-indigo-600 font-bold">{Math.round((selectedBlock.w / 12) * 100)}% {t('Width')}</span>
             </div>
             <div className="grid grid-cols-6 gap-1">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(width => (
               <button
                key={width}
                type="button"
                onClick={() => handleUpdateBlockWidth(selectedBlock.id, width)}
                className={`py-1 text-[9px] font-bold rounded border transition ${
                 selectedBlock.w === width
                  ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                }`}
                title={`${t('Span')} ${width} ${t('of 12 columns')}`}
               >
                {width}
               </button>
              ))}
             </div>
            </div>

            {/* Alignment Control — every block type now genuinely respects this in the
                real renderer except items_table (a full-width table; "alignment" has no
                meaningful effect there), so it's hidden specifically for that one block
                rather than shown as a control that visibly does nothing. */}
            {selectedBlock.id !== 'items_table' && (
             <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">{t('Horizontal Alignment')}</label>
              <div className="grid grid-cols-3 gap-1">
               {[
                { id: 'left', label: `${t('Left')} ⬅️` },
                { id: 'center', label: `${t('Center')} ↔️` },
                { id: 'right', label: `${t('Right')} ➡️` }
               ].map(item => (
                <button
                 key={item.id}
                 type="button"
                 onClick={() => handleUpdateBlockProp(selectedBlock.id, 'align', item.id)}
                 className={`py-1 text-[10px] font-bold rounded border transition ${
                  (selectedBlock.props?.align || 'left') === item.id
                   ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                   : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                 }`}
                >
                 {item.label}
                </button>
               ))}
              </div>
             </div>
            )}

            {/* Block specific properties */}
            {selectedBlock.id === 'company_details' && (
             <div className="space-y-2 bg-slate-50 p-2.5 rounded-xl border border-slate-200/80">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{t('Seller Header Fields')}</span>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.isBilingual !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'isBilingual', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Bilingual Seller Name')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.compact === true}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'compact', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Compact / Narrow Layout')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showVat !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showVat', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Show Tax / VAT Reg #')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showAddress !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showAddress', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Show Address')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showContact !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showContact', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Show Phone & Email')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showBank !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showBank', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Show IBAN / Bank Details')}</span>
              </label>
              <div className="space-y-1 pt-1">
               <span className="text-[10px] font-bold text-slate-400 block uppercase">{t('Box Frame Style')}</span>
               <select
                value={selectedBlock.props?.borderStyle || 'none'}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'borderStyle', e.target.value === 'none' ? undefined : e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
               >
                <option value="none">{t('Flat (No border) — Default')}</option>
                <option value="solid">{t('Solid Card — matches Customer box')}</option>
                <option value="dashed">{t('Dashed Box')}</option>
               </select>
               <p className="text-[9px] text-slate-400">{t('A Solid Card gives the Seller block the same bordered treatment as the Customer block beside it, for a matched, deliberate pair instead of two different styles side by side.')}</p>
              </div>
              <div className="space-y-1 pt-1">
               <span className="text-[10px] font-bold text-slate-400 block uppercase">{t('Accent Highlights')}</span>
               <select
                value={selectedBlock.props?.accentColor || ''}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'accentColor', e.target.value || undefined)}
                className="w-full bg-white border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
               >
                <option value="">{t('Match Portal Theme — Default')}</option>
                <option value="indigo">{t('Classic Indigo')}</option>
                <option value="emerald">{t('Compliance Emerald')}</option>
                <option value="slate">{t('Monochrome Slate')}</option>
                <option value="amber">{t('Warm Amber')}</option>
               </select>
               <p className="text-[9px] text-slate-400">{t('Gives the seller name and VAT/CR their own fixed color instead of following the company’s portal-wide theme color — useful for a template with its own consistent brand accent.')}</p>
              </div>
             </div>
            )}

            {selectedBlock.id === 'doc_details' && (
             <div className="space-y-2 bg-slate-50 p-2.5 rounded-xl border border-slate-200/80">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{t('Document Header Fields')}</span>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.isBilingual !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'isBilingual', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Bilingual Document Titles')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.compact === true}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'compact', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Compact / Narrow Layout')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showDocNumber !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showDocNumber', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Document Number')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showDate !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showDate', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Issue Date')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showDueDate !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showDueDate', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Due / Payment Date')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showPaymentStatus !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showPaymentStatus', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Payment Status Badge')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showOriginQ !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showOriginQ', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Origin Quotation Reference')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showCreatedBy !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showCreatedBy', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Created By User')}</span>
              </label>
              <div className="space-y-1 pt-1">
               <span className="text-[10px] font-bold text-slate-400 block uppercase">{t('Accent Highlights')}</span>
               <select
                value={selectedBlock.props?.accentColor || ''}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'accentColor', e.target.value || undefined)}
                className="w-full bg-white border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
               >
                <option value="">{t('Match Portal Theme — Default')}</option>
                <option value="indigo">{t('Classic Indigo')}</option>
                <option value="emerald">{t('Compliance Emerald')}</option>
                <option value="slate">{t('Monochrome Slate')}</option>
                <option value="amber">{t('Warm Amber')}</option>
               </select>
              </div>
             </div>
            )}

            {selectedBlock.id === 'customer_info' && (
             <div className="space-y-2 bg-slate-50 p-2.5 rounded-xl border border-slate-200/80">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{t('Customer Header Fields')}</span>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.isBilingual !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'isBilingual', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Bilingual Client Label')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.compact === true}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'compact', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Compact / Narrow Layout')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showName !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showName', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Customer / Vendor Name')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showAddress !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showAddress', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Show Physical Address')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showContact !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showContact', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Show Phone & Email')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showVatNumber !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showVatNumber', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Show Customer VAT / TRN #')}</span>
              </label>
              <div className="space-y-1 pt-1">
               <span className="text-[10px] font-bold text-slate-400 block uppercase">{t('Box Frame Style')}</span>
               <select
                value={selectedBlock.props?.borderStyle || 'solid'}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'borderStyle', e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
               >
                <option value="solid">{t('Solid Card')}</option>
                <option value="dashed">{t('Dashed Box')}</option>
                <option value="none">{t('Flat (No border)')}</option>
               </select>
              </div>
             </div>
            )}

            {selectedBlock.id === 'items_table' && (
             <div className="space-y-2 bg-slate-50 p-2.5 rounded-xl border border-slate-200/80">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{t('Details Table Columns Selection')}</span>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.isBilingual !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'isBilingual', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Bilingual Headings')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.compact === true}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'compact', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Compact Rows (smaller padding & font)')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showSNo !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showSNo', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('S.No Column')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showItemCode !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showItemCode', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Item SKU / Code')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showDescription !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showDescription', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Item Description')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showQty !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showQty', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Quantity Column')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showUnitCost !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showUnitCost', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Unit Cost / Rate Column')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showDiscount !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showDiscount', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Row Discounts')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showTotal !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showTotal', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Line Total Column')}</span>
              </label>
              <div className="space-y-1 pt-1">
               <span className="text-[10px] font-bold text-slate-400 block uppercase">{t('Table Row Style')}</span>
               <select
                value={selectedBlock.props?.borderStyle || 'stripe'}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'borderStyle', e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
               >
                <option value="classic">{t('Classic Underlines')}</option>
                <option value="stripe">{t('Striped Alternating Rows')}</option>
               </select>
              </div>
             </div>
            )}

            {selectedBlock.type === 'custom_field' || selectedBlock.id.startsWith('custom_field_') ? (
             <div className="space-y-2.5 bg-indigo-50/50 p-2.5 rounded-xl border border-indigo-200/80">
              <span className="text-[10px] font-bold text-indigo-700 uppercase tracking-wider block">{t('Custom Field Config')}</span>
              <div className="space-y-1">
               <label className="text-[10px] font-bold text-slate-500 block uppercase">{t('Dynamic Field Binding')}</label>
               <select
                value={selectedBlock.props?.fieldBinding || 'none'}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'fieldBinding', e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none font-semibold"
               >
                <option value="none">{t('Static Text / Custom Label')}</option>
                <option value="docNumber">{t('Document Number (INV/Q/EXP)')}</option>
                <option value="docDate">{t('Document Date')}</option>
                <option value="dueDate">{t('Payment / Due Date')}</option>
                <option value="paymentStatus">{t('Payment Status (Paid/Pending)')}</option>
                <option value="paymentMethod">{t('Payment Method / Bank')}</option>
                <option value="originQuotation">{t('Origin Quotation Link')}</option>
                <option value="customerName">{t('Customer / Vendor Name')}</option>
                <option value="customerVat">{t('Customer TRN / Tax Number')}</option>
                <option value="customerPhone">{t('Customer Phone')}</option>
                <option value="customerAddress">{t('Customer Address')}</option>
                <option value="companyVat">{t('Seller Tax / TRN')}</option>
                <option value="companyBank">{t('Seller IBAN / Bank')}</option>
                <option value="createdBy">{t('Created By User')}</option>
               </select>
              </div>
              <div className="space-y-1">
               <label className="text-[10px] font-bold text-slate-500 block uppercase">{t('English Label')}</label>
               <input
                type="text"
                value={selectedBlock.props?.labelEn || ''}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'labelEn', e.target.value)}
                placeholder={t('e.g. Reference PO #')}
                className="w-full bg-white border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
               />
              </div>
              <div className="space-y-1">
               <label className="text-[10px] font-bold text-slate-500 block uppercase">{t('Arabic Label (Optional)')}</label>
               <input
                type="text"
                value={selectedBlock.props?.labelAr || ''}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'labelAr', e.target.value)}
                placeholder="e.g. رقم أمر الشراء"
                className="w-full bg-white border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
               />
              </div>
              {selectedBlock.props?.fieldBinding === 'none' && (
               <div className="space-y-1">
                <label className="text-[10px] font-bold text-slate-500 block uppercase">{t('Static Content Value')}</label>
                <textarea
                 value={selectedBlock.props?.staticText || ''}
                 onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'staticText', e.target.value)}
                 placeholder={t('Enter fixed note or details...')}
                 rows={2}
                 className="w-full bg-white border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
                />
               </div>
              )}
              {/* The real renderer (DocumentRenderer.tsx) already respects isBilingual
                  for custom_field — only shows the Arabic label when it's not explicitly
                  false — but this panel never exposed a control to set it, so it was
                  always effectively stuck on whenever an Arabic label was filled in. */}
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.isBilingual !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'isBilingual', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Show Arabic Label')}</span>
              </label>
              <div className="space-y-1 pt-1">
               <span className="text-[10px] font-bold text-slate-400 block uppercase">{t('Box Frame Style')}</span>
               <select
                value={selectedBlock.props?.borderStyle || 'solid'}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'borderStyle', e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
               >
                <option value="solid">{t('Solid Card')}</option>
                <option value="dashed">{t('Dashed Box')}</option>
                <option value="none">{t('Flat (No border)')}</option>
               </select>
              </div>
             </div>
            ) : null}

            {selectedBlock.id === 'qr_code' && (
             <div className="space-y-2.5">
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.isBilingual !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'isBilingual', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Bilingual ZATCA verification text')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.compact === true}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'compact', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Compact / Narrow Layout')}</span>
              </label>
              <div className="space-y-1">
               <span className="text-[10px] font-bold text-slate-400 block uppercase">{t('QR Sizing')}</span>
               <select
                value={selectedBlock.props?.size || 'medium'}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'size', e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
               >
                <option value="small">{t('Small (40px)')}</option>
                <option value="medium">{t('Medium (80px)')}</option>
                <option value="large">{t('Large (110px)')}</option>
               </select>
              </div>
             </div>
            )}

            {selectedBlock.id === 'totals_summary' && (
             <div className="space-y-2 bg-slate-50 p-2.5 rounded-xl border border-slate-200/80">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{t('Totals Breakdown Fields')}</span>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.isBilingual !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'isBilingual', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Bilingual Calculations Description')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.compact === true}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'compact', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Compact / Narrow Layout')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showSubtotal !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showSubtotal', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Show Subtotal')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showDiscount !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showDiscount', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Show Total Discount')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showVat !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showVat', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Show VAT 15%')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showGrandTotal !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showGrandTotal', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Show Grand Total')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.anchorBottom === true}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'anchorBottom', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>{t('Anchor Notes/QR/Totals to page bottom')}</span>
              </label>
              <p className="text-[9px] text-slate-400 -mt-1">{t('Makes the preview show a full A4-height page with this row pinned to the bottom, instead of sitting directly under a short items table. Preview only — never affects the actual printed page height.')}</p>
              <div className="space-y-1 pt-1">
               <span className="text-[10px] font-bold text-slate-400 block uppercase">{t('Accent Highlights')}</span>
               <select
                value={selectedBlock.props?.accentColor || 'indigo'}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'accentColor', e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
               >
                <option value="indigo">{t('Classic Indigo')}</option>
                <option value="emerald">{t('Compliance Emerald')}</option>
                <option value="slate">{t('Monochrome Slate')}</option>
                <option value="amber">{t('Warm Amber')}</option>
               </select>
              </div>
             </div>
            )}

            {/* General bilingual toggle for custom headers/footers/notes */}
            {(selectedBlock.id === 'custom_header' || selectedBlock.id === 'custom_footer' || selectedBlock.id === 'notes') && (
             <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
               type="checkbox"
               checked={selectedBlock.props?.isBilingual === true}
               onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'isBilingual', e.target.checked)}
               className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
              />
              <span>{t('Bilingual Arabic Label Hint')}</span>
             </label>
            )}
            {/* custom_footer has no vertical-space problem worth a toggle (it's a single
                optional line at the very bottom of the page, not competing with the
                items table for room) — compact is offered only for the two blocks that
                actually sit in the header/footer rows squeezed by a long items table. */}
            {(selectedBlock.id === 'custom_header' || selectedBlock.id === 'notes') && (
             <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
               type="checkbox"
               checked={selectedBlock.props?.compact === true}
               onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'compact', e.target.checked)}
               className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
              />
              <span>{t('Compact / Narrow Layout')}</span>
             </label>
            )}
           </div>

            {/* Divider */}
            <div className="border-t border-slate-100 pt-3 space-y-3">
             <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-wider block">{t('Block Style & Spacing')}</span>

             {/* Font Sizing */}
             <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-400 block uppercase">{t('Font Size')}</label>
              <select
               value={selectedBlock.props?.fontSize || 'xs'}
               onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'fontSize', e.target.value)}
               className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
              >
               <option value="xs">{t('Extra Small (xs)')}</option>
               <option value="sm">{t('Small (sm)')}</option>
               <option value="base">{t('Medium (base)')}</option>
               <option value="lg">{t('Large (lg)')}</option>
               <option value="xl">{t('Extra Large (xl)')}</option>
              </select>
             </div>

             {/* Font Weight */}
             <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-400 block uppercase">{t('Font Weight')}</label>
              <select
               value={selectedBlock.props?.fontWeight || 'normal'}
               onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'fontWeight', e.target.value)}
               className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
              >
               <option value="normal">{t('Normal')}</option>
               <option value="medium">{t('Medium')}</option>
               <option value="semibold">{t('Semi-Bold')}</option>
               <option value="bold">{t('Bold')}</option>
               <option value="extrabold">{t('Extra-Bold')}</option>
              </select>
             </div>

             {/* Font Family */}
             <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-400 block uppercase">{t('Font Family')}</label>
              <select
               value={selectedBlock.props?.fontFamily || 'sans'}
               onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'fontFamily', e.target.value)}
               className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
              >
               <option value="sans">{t('Modern Sans-Serif (Inter)')}</option>
               <option value="helvetica">{t('Helvetica / Arial')}</option>
               <option value="calibri">{t('Calibri')}</option>
               <option value="serif">{t('Traditional Serif (Lora)')}</option>
               <option value="display">{t('Bold Display (Space Grotesk)')}</option>
               <option value="mono">{t('Technical Mono (JetBrains Mono)')}</option>
              </select>
             </div>

             {/* Vertical Spacing */}
             <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
               <label className="text-[10px] font-bold text-slate-400 block uppercase">{t('Margin Top')}</label>
               <select
                value={selectedBlock.props?.mt !== undefined ? selectedBlock.props?.mt : '4'}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'mt', e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
               >
                <option value="0">{t('None (0px)')}</option>
                <option value="1">{t('Extra Tight (4px)')}</option>
                <option value="2">{t('Tight (8px)')}</option>
                <option value="3">{t('Compact (12px)')}</option>
                <option value="4">{t('Normal (16px)')}</option>
                <option value="6">{t('Spacious (24px)')}</option>
                <option value="8">{t('Loose (32px)')}</option>
                <option value="12">{t('Extra Loose (48px)')}</option>
               </select>
              </div>
              <div className="space-y-1">
               <label className="text-[10px] font-bold text-slate-400 block uppercase">{t('Margin Bottom')}</label>
               <select
                value={selectedBlock.props?.mb !== undefined ? selectedBlock.props?.mb : '4'}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'mb', e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
               >
                <option value="0">{t('None (0px)')}</option>
                <option value="1">{t('Extra Tight (4px)')}</option>
                <option value="2">{t('Tight (8px)')}</option>
                <option value="3">{t('Compact (12px)')}</option>
                <option value="4">{t('Normal (16px)')}</option>
                <option value="6">{t('Spacious (24px)')}</option>
                <option value="8">{t('Loose (32px)')}</option>
                <option value="12">{t('Extra Loose (48px)')}</option>
               </select>
              </div>
             </div>

             {/* Padding — the real renderer (DocumentRenderer.tsx's getBlockStyle) has
                 always supported this via block.props?.p, applied as an outer inline
                 style on every block type, but no control ever exposed it; it could only
                 ever be set by hand-editing layoutJson. */}
             <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-400 block uppercase">{t('Padding')}</label>
              <select
               value={selectedBlock.props?.p !== undefined ? selectedBlock.props?.p : '0'}
               onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'p', e.target.value)}
               className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
              >
               <option value="0">{t('None (0px)')}</option>
               <option value="1">{t('Extra Tight (4px)')}</option>
               <option value="2">{t('Tight (8px)')}</option>
               <option value="3">{t('Compact (12px)')}</option>
               <option value="4">{t('Normal (16px)')}</option>
               <option value="6">{t('Spacious (24px)')}</option>
              </select>
             </div>
            </div>
          </div>
         ) : (
          <div className="space-y-4">
            <div className="p-4 bg-white border border-indigo-200 shadow-sm rounded-2xl space-y-4">
             <div className="pb-2 border-b border-slate-100 flex items-center justify-between">
              <span className="text-xs font-bold text-indigo-600 uppercase tracking-wider">{t('Global Document Style')}</span>
              <span className="text-[9px] font-bold bg-indigo-50 text-indigo-700 px-1.5 py-0.5 rounded-full uppercase">{t('Template')}</span>
             </div>

             {/* Global Row Gap */}
             <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-400 block uppercase">{t('Global Row Gap')}</label>
              <select
               value={tmpl.gridGapY || 'normal'}
               onChange={(e) => handleUpdateTemplateProperty(tmpl.id, 'gridGapY', e.target.value)}
               className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
              >
               <option value="tight">{t('High Density (8px Gap)')}</option>
               <option value="compact">{t('Compact (12px Gap)')}</option>
               <option value="normal">{t('Normal (24px Gap) - Default')}</option>
               <option value="loose">{t('Spacious (40px Gap)')}</option>
              </select>
             </div>

             {/* Global Font Family */}
             <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-400 block uppercase">{t('Global Font Family')}</label>
              <select
               value={tmpl.globalFontFamily || 'sans'}
               onChange={(e) => handleUpdateTemplateProperty(tmpl.id, 'globalFontFamily', e.target.value)}
               className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
              >
               <option value="sans">{t('Modern Sans-Serif (Inter)')}</option>
               <option value="helvetica">{t('Helvetica / Arial — global invoice standard')}</option>
               <option value="calibri">{t('Calibri — Microsoft Office standard')}</option>
               <option value="serif">{t('Traditional Serif (Lora)')}</option>
               <option value="display">{t('Bold Display (Space Grotesk)')}</option>
               <option value="mono">{t('Technical Mono (JetBrains Mono)')}</option>
              </select>
              <p className="text-[9px] text-slate-400">
               {t("Arabic/Urdu documents always render in Cairo (the app's Arabic-script pairing) for legible glyph rendering, regardless of this choice — none of the options above have real Arabic coverage.")}
              </p>
             </div>
            </div>

            <div className="p-4 bg-slate-50 border border-dashed border-slate-200 text-slate-400 rounded-2xl text-center py-6">
             <span className="text-xl block">👈</span>
             <span className="text-[11px] font-bold block mt-1">{t('Select any grid block on the canvas to customize element-specific styling.')}</span>
            </div>
          </div>
         )}

         {/* Available Blocks Library */}
         <div className="p-4 bg-slate-100/60 border border-slate-200 rounded-2xl space-y-3">
          <div className="flex justify-between items-center">
           <span className="text-xs font-bold text-slate-700 block uppercase tracking-wider">{t('Block Library')}</span>
           <button
            type="button"
            onClick={() => handleAddCustomBlock('none', 'Custom Field')}
            className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-[10px] font-bold rounded-lg transition shadow-sm flex items-center gap-1"
           >
            <span>+ {t('Custom Block')}</span>
           </button>
          </div>
          <p className="text-[10px] text-slate-400">{t('Click (+) to return items back into grid or add custom fields.')}</p>
          {availableBlocks.length === 0 ? (
           <p className="text-[10px] text-slate-400 italic text-center py-2 bg-white rounded-xl border border-dashed border-slate-150">{t('All default blocks are on stage! Use (+ Custom Block) to add more.')}</p>
          ) : (
           <div className="space-y-2">
            {availableBlocks.map(block => (
             <div
              key={block.id}
              className="bg-white p-3 border border-slate-200 rounded-xl shadow-sm flex justify-between items-center hover:border-indigo-300 transition"
             >
              <div>
               <span className="text-[11px] font-bold text-slate-700 block leading-tight">{block.title}</span>
               <span className="text-[8px] font-semibold text-slate-400 font-mono bg-slate-100 px-1 py-0.5 rounded uppercase mt-0.5 inline-block">
                {t('Key:')} {block.id}
               </span>
              </div>
              <div className="flex items-center gap-1.5">
               <button
                type="button"
                onClick={() => handleToggleBlockVisibility(block.id, true)}
                className="w-6 h-6 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 font-extrabold rounded-lg flex items-center justify-center transition"
                title={t('Add to canvas')}
               >
                +
               </button>
               {String(block.id).startsWith('custom_field_') && (
                <button
                 type="button"
                 onClick={() => handleRemoveCustomBlock(block.id)}
                 className="w-6 h-6 bg-rose-50 hover:bg-rose-100 text-rose-500 rounded-lg flex items-center justify-center transition"
                 title={t('Permanently remove this custom block')}
                >
                 🗑️
                </button>
               )}
              </div>
             </div>
            ))}
           </div>
          )}
         </div>
        </div>

        {/* Center Canvas Layout Workspace */}
        <div className="lg:col-span-3 space-y-4">
         <span className="text-xs font-bold text-slate-400 uppercase tracking-widest block text-center">{t('Interactive 12-Column Grid Stage')}</span>

         {/* Row composition summary — see canvasRows comment above for why this is
             advisory (how the row will wrap) rather than a pass/fail validation. */}
         {canvasRows.length > 0 && (
          <div className="max-w-[850px] mx-auto flex flex-wrap gap-1.5 justify-center">
           {canvasRows.map((row, rowIdx) => (
            <span
             key={rowIdx}
             title={row.blocks.map(b => b.title).join(' + ')}
             className={`text-[9px] font-bold px-2 py-1 rounded-full border ${
              row.total === 12
               ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
               : 'bg-amber-50 text-amber-700 border-amber-200'
             }`}
            >
             {t('Row')} {rowIdx + 1} • {row.total}/12
            </span>
           ))}
          </div>
         )}

         {/* The actual live-manipulated paper template.
             - Font: mirrors DocumentRenderer.tsx's getGlobalFontClass mapping exactly, so
               this canvas actually shows the font the template will print with (sans/
               serif/display/mono) instead of always showing the Admin Settings page's own
               UI font regardless of what's selected.
             - items-start: CSS Grid's default align-items is `stretch` — every block's
               card would stretch to match the tallest sibling sharing its row, which is
               exactly what made the real renderer's logo visually float mid-row (see the
               items-start fix in DocumentRenderer.tsx). Setting it here too means every
               block card here sizes to its own natural content height, matching how rows
               actually behave when printed. */}
         <div className={`bg-white border border-slate-200 shadow-xl rounded-2xl p-6 md:p-8 min-h-[600px] max-w-[850px] mx-auto space-y-6 ${
           tmpl.globalFontFamily === 'serif' ? 'font-serif' :
           tmpl.globalFontFamily === 'display' ? 'font-display' :
           tmpl.globalFontFamily === 'mono' ? 'font-mono' :
           tmpl.globalFontFamily === 'helvetica' ? 'font-helvetica' :
           tmpl.globalFontFamily === 'calibri' ? 'font-calibri' :
           'font-sans'
         }`}>
          <div className="grid grid-cols-12 gap-x-4 gap-y-6 items-start">
           {activeBlocks.map((block, blockIdx) => {
            const isSelected = block.id === selectedBlockId;
            const blockColClass = `col-span-12 ${COL_SPAN_MD[block.w] || COL_SPAN_MD[12]} ${COL_SPAN_PRINT[block.w] || COL_SPAN_PRINT[12]}`;
            const isFirstVisible = blockIdx === 0;
            const isLastVisible = blockIdx === activeBlocks.length - 1;

            return (
             <div
              key={block.id}
              draggable="true"
              onDragStart={(e) => handleCanvasDragStart(e, block.id)}
              onDragOver={(e) => handleCanvasDragOver(e, block.id)}
              onDrop={(e) => handleCanvasDrop(e, block.id)}
              onClick={(e) => {
               e.stopPropagation();
               setSelectedBlockId(block.id);
              }}
              className={`relative rounded-xl border p-4 transition group cursor-pointer ${
               isSelected
                ? 'border-indigo-500 bg-indigo-50/10 shadow-md ring-2 ring-indigo-500/10'
                : 'border-slate-200 hover:border-slate-350 hover:bg-slate-50/20 shadow-sm'
              } ${blockColClass}`}
             >
              {/* Block Design Overlay Actions */}
              <div className="absolute top-2 right-2 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition duration-150 z-20 bg-white/95 border border-slate-100 p-1 rounded-lg shadow-sm">
               {/* Keyboard-accessible reordering — real <button>s, so Tab + Enter/Space
                   work natively, unlike the drag handle below (pointer-only). */}
               <button
                type="button"
                onClick={(e) => { e.stopPropagation(); handleMoveBlock(block.id, 'up'); }}
                disabled={isFirstVisible}
                className="text-slate-500 hover:text-indigo-600 disabled:opacity-25 disabled:cursor-not-allowed p-0.5 rounded text-[10px]"
                title={t('Move block up')}
               >
                ↑
               </button>
               <button
                type="button"
                onClick={(e) => { e.stopPropagation(); handleMoveBlock(block.id, 'down'); }}
                disabled={isLastVisible}
                className="text-slate-500 hover:text-indigo-600 disabled:opacity-25 disabled:cursor-not-allowed p-0.5 rounded text-[10px]"
                title={t('Move block down')}
               >
                ↓
               </button>
               {/* Drag handle */}
               <div className="cursor-grab text-[11px] text-slate-400 hover:text-slate-700 px-1 font-semibold" title={t('Drag to reorder')}>
                ☰
               </div>
               {/* Width badge */}
               <span className="text-[8px] font-bold text-slate-400 bg-slate-100 px-1 rounded uppercase tracking-wider">
                {block.w}/12 {t('cols')}
               </span>
               {/* Settings Button */}
               <button
                type="button"
                onClick={(e) => {
                 e.stopPropagation();
                 setSelectedBlockId(block.id);
                }}
                className="text-slate-500 hover:text-indigo-600 p-0.5 rounded text-[10px]"
                title={t('Block Settings')}
               >
                ⚙️
               </button>
               {/* Delete block */}
               <button
                type="button"
                onClick={(e) => {
                 e.stopPropagation();
                 handleToggleBlockVisibility(block.id, false);
                }}
                className="text-slate-400 hover:text-rose-600 p-0.5 rounded text-[10px]"
                title={t('Remove block')}
               >
                🗑️
               </button>
              </div>

              {/* Block Title Label Tag */}
              <div className="absolute top-2 left-2 text-[8px] font-bold text-indigo-500 bg-indigo-50 px-1.5 py-0.5 rounded uppercase tracking-wider z-10">
               {block.title}
              </div>

              {/* Block Live-Visualizations */}
              <div className="pt-4 pb-2">
               {block.id === 'logo' && (
                <div className={`flex ${block.props?.align === 'right' ? 'justify-end' : block.props?.align === 'center' ? 'justify-center' : 'justify-start'}`}>
                 {db.companySetup?.logoUrl ? (
                  <div className="text-[10px] text-slate-400 italic flex items-center gap-2 bg-slate-50 border border-dashed border-slate-200 px-3 py-1.5 rounded-lg max-w-sm">
                   <span>[Visual Logo Asset Loaded]</span>
                  </div>
                 ) : (
                  <div className="w-10 h-10 bg-slate-800 text-white rounded-lg flex items-center justify-center font-bold text-sm">
                   CNC
                  </div>
                 )}
                </div>
               )}

               {block.id === 'company_details' && (
                <div className="space-y-1">
                 <h4 className="font-bold text-xs text-slate-900">
                  {db.companySetup?.name || 'My Business LLC'}
                  {block.props?.isBilingual !== false && (
                   <span className="block text-[10px] font-medium text-slate-400">اسم البائع / {db.companySetup?.name || 'مؤسستنا'}</span>
                  )}
                 </h4>
                 {block.props?.showAddress !== false && (
                  <p className="text-[10px] text-slate-500 leading-tight">
                   {db.companySetup?.address || '123 KAFD Riyadh, Saudi Arabia'}
                  </p>
                 )}
                 {block.props?.showVat !== false && (
                  <p className="text-[10px] font-semibold text-slate-700">
                   VAT Reg: <span className="font-mono">{db.companySetup?.vatNumber || '300123456700003'}</span>
                   {block.props?.isBilingual !== false && (
                    <span className="ms-1 font-normal text-slate-400 font-mono text-[9px]">(الرقم الضريبي: 300xxxxxxxx)</span>
                   )}
                  </p>
                 )}
                </div>
               )}

               {block.id === 'doc_details' && (
                <div className="border border-slate-100 p-3 rounded-lg bg-slate-50/50 flex justify-between items-center">
                 <div>
                  <h4 className="font-bold text-xs text-indigo-600">
                   TAX INVOICE / فاتورة ضريبية
                  </h4>
                  <p className="text-[10px] text-slate-400">Original Verified / نسخة أصلية معتمدة</p>
                 </div>
                 <div className="text-right text-[10px] text-slate-600 space-y-0.5">
                  <p><span className="font-semibold text-slate-800">No:</span> INV-2026-0042</p>
                  <p><span className="font-semibold text-slate-800">Date:</span> 2026-07-20</p>
                 </div>
                </div>
               )}

               {block.id === 'customer_info' && (
                <div className="border border-slate-150 p-3 rounded-lg space-y-1 bg-white">
                 <div className="flex justify-between items-center pb-1 border-b border-slate-100">
                  <span className="text-[9px] font-bold text-slate-400 uppercase">Customer details</span>
                  {block.props?.isBilingual !== false && (
                   <span className="text-[8px] font-bold text-slate-400 font-mono">العميل / Buyer</span>
                  )}
                 </div>
                 <p className="text-[10px] font-bold text-slate-800">Walk-in Client (Al-Hazmi Corp.)</p>
                 {block.props?.showAddress !== false && (
                  <p className="text-[9px] text-slate-500">Olaya Street, Riyadh, Saudi Arabia</p>
                 )}
                 <p className="text-[9px] text-slate-600 font-medium">VAT Reg Number: 310987654300003</p>
                </div>
               )}

               {block.id === 'custom_header' && (
                <div className="p-2 bg-slate-50 text-[10px] text-slate-500 italic rounded-lg border border-slate-100">
                 {db.companySetup?.customHeader || '[No Custom Header text provided]'}
                </div>
               )}

               {block.id === 'items_table' && (
                <div className="border border-slate-100 rounded-lg overflow-hidden text-[9px]">
                 <div className="bg-slate-800 text-white p-1.5 font-bold flex justify-between">
                  <span>{block.props?.isBilingual !== false ? 'Description / الوصف' : 'Description'}</span>
                  <div className="flex gap-4">
                   <span>Qty</span>
                   <span>Total</span>
                  </div>
                 </div>
                 <div className="p-1.5 space-y-1 bg-white">
                  <div className="flex justify-between border-b border-slate-50 pb-1">
                   <span>Full-Stack Development / خدمات التطوير البرمجي</span>
                   <div className="flex gap-4 font-mono font-medium">
                    <span>2</span>
                    <span>15,000.00</span>
                   </div>
                  </div>
                  <div className="flex justify-between">
                   <span>Saudi VAT Implementation Consulting</span>
                   <div className="flex gap-4 font-mono font-medium">
                    <span>1</span>
                    <span>5,000.00</span>
                   </div>
                  </div>
                 </div>
                </div>
               )}

               {block.id === 'notes' && (
                <div className="border border-slate-100 p-2.5 rounded-lg bg-slate-50">
                 <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wide block">Notes & Terms</span>
                 <p className="text-[9px] text-slate-600 mt-0.5">Please settle payment within 15 days from invoice issuance date. Bank transfers only.</p>
                </div>
               )}

               {block.id === 'qr_code' && (
                <div className={`flex ${block.props?.align === 'right' ? 'justify-end' : block.props?.align === 'left' ? 'justify-start' : 'justify-center'}`}>
                 <div className="flex flex-col items-center bg-white p-1.5 rounded-lg border border-slate-150 shadow-sm w-max">
                  <div className={`bg-slate-200 border border-slate-300 rounded ${
                   block.props?.size === 'small' ? 'w-10 h-10' : block.props?.size === 'large' ? 'w-20 h-20' : 'w-14 h-14'
                  } flex items-center justify-center text-[9px] font-bold text-slate-500 font-mono`}>
                   QR
                  </div>
                  <span className="text-[7px] font-bold text-slate-400 mt-1 uppercase">ZATCA Verified</span>
                 </div>
                </div>
               )}

               {block.id === 'totals_summary' && (
                <div className="border border-slate-150 p-3 rounded-lg bg-slate-50 space-y-1 text-[10px]">
                 <div className="flex justify-between text-slate-600">
                  <span>Subtotal (الفرعي):</span>
                  <span className="font-mono">20,000.00 SAR</span>
                 </div>
                 <div className="flex justify-between text-slate-600">
                  <span>VAT 15% (الضريبة):</span>
                  <span className="font-mono">3,000.00 SAR</span>
                 </div>
                 <div className="flex justify-between font-bold text-slate-900 border-t border-slate-200 pt-1">
                  <span>Grand Total (الإجمالي):</span>
                  <span className="font-mono text-indigo-600">23,000.00 SAR</span>
                 </div>
                </div>
               )}

               {block.id === 'custom_footer' && (
                <div className="p-1 border-t border-slate-100 text-center text-[8px] text-slate-400 leading-tight">
                 {db.companySetup?.customFooter || '[No Custom Footer text provided]'}
                </div>
               )}

               {(block.type === 'custom_field' || block.id.startsWith('custom_field_')) && (
                <div className="p-2.5 rounded-lg border border-indigo-100 bg-indigo-50/30 text-xs">
                 <div className="flex justify-between items-center font-bold text-slate-800">
                  <span>{block.props?.labelEn || block.title || 'Custom Field'}</span>
                  {block.props?.labelAr && <span className="text-slate-400 text-[10px]">{block.props.labelAr}</span>}
                 </div>
                 <p className="text-[10px] text-indigo-600 font-mono mt-1">
                  {block.props?.fieldBinding && block.props.fieldBinding !== 'none'
                   ? `[Dynamic Field: ${block.props.fieldBinding}]`
                   : block.props?.staticText || '[Custom Static Text Value]'}
                 </p>
                </div>
               )}
              </div>
             </div>
            );
           })}
          </div>
         </div>
        </div>
       </div>

       {/* Live Preview — uses the EXACT same rendering code path as the real print
           output (DocumentRenderer's embedded mode), fed the in-progress canvasBlocks
           directly. This can never drift from what actually prints the way the block
           mockups above (a separate, simplified visual approximation — e.g. logo shows
           as a plain placeholder, not the real image with the real alignment behavior)
           always risked. Updates automatically as blocks/widths/props change — no
           "Preview" button to click, no separate modal to open and close repeatedly
           while iterating on a design. */}
       <div className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
         <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">{t('Live Preview — Exactly What Will Print')}</span>
         <span className="text-[9px] font-bold bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full uppercase">{t('Real renderer, not a mockup')}</span>
        </div>
        <div className="border border-slate-200 rounded-2xl overflow-hidden bg-slate-100/50" style={{ maxHeight: '75vh', overflowY: 'auto' }}>
         <DocumentRenderer
          embedded
          documentType="Invoice"
          data={TEMPLATE_PREVIEW_SAMPLE_INVOICE}
          companySetup={(db.companySetup || { id: db.selectedCompanyId || 'company-1', name: 'Current Organization', currency: 'SAR', vatNumber: '300123456700003' }) as any}
          templates={[{ ...tmpl, layoutJson: JSON.stringify(canvasBlocks) }]}
          taxSlabs={db.taxSlabs}
          db={db}
          onClose={() => {}}
         />
        </div>
       </div>
      </div>
     );
    })()
   ) : (
    <div className="space-y-6">
     <div>
      <h3 className="text-sm font-bold text-slate-900">{t('Document Template Engine')}</h3>
      <p className="text-[11px] text-slate-400">{t('Create layouts for Quotations and Invoices. Only ONE template is active globally at a time.')}</p>
     </div>

     <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {db.templates.filter(t => (t.companyId || db.selectedCompanyId) === db.selectedCompanyId).map(tmpl => (
       <div
        key={tmpl.id}
        className={`p-4 rounded-2xl border flex flex-col justify-between transition ${
         tmpl.isActive
          ? 'bg-indigo-50/40 border-indigo-200 shadow-sm'
          : 'bg-white border-slate-100 shadow-sm hover:border-slate-200'
        }`}
       >
        <div>
         <div className="flex justify-between items-start">
          <h4 className="font-bold text-xs text-slate-900 leading-tight">{tmpl.name}</h4>
          <span className={`px-1.5 py-0.5 rounded text-[8px] font-bold uppercase ${
           (tmpl.language === 'Arabic' || tmpl.language === 'Urdu') ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800'
          }`}>
           {tmpl.language}
          </span>
         </div>
         <p className="text-[10px] text-slate-400 mt-2">{t('Page Size:')} {tmpl.pageSize}</p>
         <p className="text-[10px] text-slate-400 mt-1">{t('Direction:')} {tmpl.language === 'Arabic' ? t('RTL (Arabic)') : tmpl.language === 'Urdu' ? t('RTL (Urdu)') : t('LTR (English)')}</p>

         {/* Print Settings Checks */}
         <div className="mt-3 pt-3 border-t border-slate-100 space-y-1.5">
          <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider block">{t('Quick Print Toggles')}</span>
          <div className="grid grid-cols-2 gap-x-2 gap-y-1">
           <label className="flex items-center gap-1.5 text-[10px] text-slate-600 cursor-pointer select-none">
            <input
             type="checkbox"
             checked={tmpl.printHeader !== false}
             disabled={!canUpdateTemplates}
             onChange={() => handleToggleOption(tmpl.id, 'printHeader')}
             className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3 h-3 disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <span>{t('Print Header')}</span>
           </label>
           <label className="flex items-center gap-1.5 text-[10px] text-slate-600 cursor-pointer select-none">
            <input
             type="checkbox"
             checked={tmpl.printFooter !== false}
             disabled={!canUpdateTemplates}
             onChange={() => handleToggleOption(tmpl.id, 'printFooter')}
             className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3 h-3 disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <span>{t('Print Footer')}</span>
           </label>
           <label className="flex items-center gap-1.5 text-[10px] text-slate-600 cursor-pointer select-none">
            <input
             type="checkbox"
             checked={tmpl.printLogo !== false}
             disabled={!canUpdateTemplates}
             onChange={() => handleToggleOption(tmpl.id, 'printLogo')}
             className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3 h-3 disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <span>{t('Print Logo')}</span>
           </label>
           <label className="flex items-center gap-1.5 text-[10px] text-slate-600 cursor-pointer select-none">
            <input
             type="checkbox"
             checked={tmpl.printQrCode !== false}
             disabled={!canUpdateTemplates}
             onChange={() => handleToggleOption(tmpl.id, 'printQrCode')}
             className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3 h-3 disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <span>{t('Print QR Code')}</span>
           </label>
          </div>
         </div>
        </div>

        <div className="mt-4 pt-3 border-t border-slate-100/60 flex justify-between items-center">
         <div className="flex gap-1.5">
          {canUpdateTemplates && (
           <button
            type="button"
            onClick={() => handleOpenCanvasDesigner(tmpl)}
            className="text-[10px] font-bold text-slate-600 hover:text-indigo-600 transition flex items-center gap-1 bg-slate-50 hover:bg-indigo-50 px-2.5 py-1 rounded-lg"
           >
            ⚙️ {t('Design')}
           </button>
          )}
          <button
           type="button"
           onClick={() => setPreviewTemplate(tmpl)}
           className="text-[10px] font-bold text-indigo-600 hover:text-indigo-800 transition flex items-center gap-1 bg-indigo-50 hover:bg-indigo-100 px-2.5 py-1 rounded-lg"
          >
           👁️ {t('Preview')}
          </button>
         </div>
         <div className="flex items-center gap-2">
          {!tmpl.isActive ? (
           canUpdateTemplates && (
            <button
             type="button"
             onClick={() => handleActivateTemplate(tmpl.id)}
             className="text-[10px] font-bold text-indigo-600 hover:text-indigo-800"
            >
             {t('Set Active')}
            </button>
           )
          ) : (
           <span className="text-[10px] font-bold text-indigo-600">
            ⭐ {t('Active Default')}
           </span>
          )}
          {canDeleteTemplates && (
           <button
            type="button"
            onClick={() => handleDeleteTemplate(tmpl)}
            title={t('Delete template')}
            className="text-[10px] font-bold text-rose-500 hover:text-rose-700 transition px-1.5 py-1 rounded-lg hover:bg-rose-50"
           >
            🗑️
           </button>
          )}
         </div>
        </div>
       </div>
      ))}

      {/* Add Template Card */}
      {canCreateTemplates && (
      <div className="p-4 rounded-2xl border border-dashed border-slate-300 bg-slate-50 flex flex-col justify-between">
       <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-2">{t('Create Template')}</h4>
       <form onSubmit={handleAddTemplate} className="space-y-2 text-xs">
        <input
         type="text"
         required
         placeholder={t('Template Title')}
         value={tmplForm.name}
         onChange={(e) => setTmplForm({ ...tmplForm, name: e.target.value })}
         className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
        <select
         value={tmplForm.language}
         onChange={(e) => setTmplForm({ ...tmplForm, language: e.target.value as any })}
         className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1 text-xs text-slate-800 focus:outline-none"
        >
         <option value="English">{t('English (LTR)')}</option>
         <option value="Arabic">{t('Arabic (RTL)')}</option>
         <option value="Urdu">{t('Urdu (RTL)')}</option>
        </select>
        <select
         value={tmplForm.pageSize}
         onChange={(e) => setTmplForm({ ...tmplForm, pageSize: e.target.value })}
         className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1 text-xs text-slate-800 focus:outline-none"
        >
         {/* Only these two page sizes are actually honored by DocumentRenderer.tsx's print
             pipeline (A4 @page geometry vs. the 4in x 6in thermal-receipt branch, which also
             drives font-size/padding/logo-size scaling) — this used to be free text inviting
             values like "8in x 11in" that silently fell through to the generic A4 branch. */}
         <option value="8.27in x 11.69in (A4)">{t('A4 (8.27in x 11.69in)')}</option>
         <option value="4in x 6in">{t('Thermal Receipt (4in x 6in)')}</option>
        </select>
        {/* Starting point only — the Canvas Designer opens on whichever preset was
            picked, and every block/prop is still freely editable from there afterward.
            Only affects invoice/quotation printouts (itemized buyer address, per-line
            tax columns); expense/voucher templates render through a separate code path
            unaffected by this choice. */}
        <select
         value={tmplForm.preset}
         onChange={(e) => setTmplForm({ ...tmplForm, preset: e.target.value as any })}
         className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1 text-xs text-slate-800 focus:outline-none"
        >
         <option value="standard">{t('Standard Layout')}</option>
         <option value="detailed">{t('Detailed Tax Invoice')}</option>
        </select>
        <button
         type="submit"
         className="w-full bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg py-1.5 font-bold text-xs shadow-sm mt-1"
        >
         {t('Create')}
        </button>
       </form>
      </div>
      )}
     </div>
    </div>
   )}
  </div>
 )}

 {/* TAB: FISCAL MONTHS */}
 {activeTab === 'months' && (() => {
 // Purely informational — sorted oldest-first so the list/badge below can point at which
 // open month is next in line to close. This does NOT gate or block any action: the cap-of-3
 // and oldest-first-close rules are enforced ONLY server-side, in POST /api/transactions/months
 // (server/routes/transactions.ts). Every Open month's Close button stays clickable and the
 // Create button stays enabled regardless of count — attempting an action that the server
 // rejects (cap reached, not the oldest open month, etc.) surfaces that rejection via
 // triggerError exactly as returned by the server. Deliberately not re-implementing the rule
 // here — see BACKLOG.md item 35 for the precedent of a client-side copy of a business rule
 // silently diverging from the real server-side check.
 const companyOpenMonthsSorted = fiscalMonths
 .filter(m => m.status === 'Open' && m.companyId === db.selectedCompanyId)
 .sort((a, b) => a.id.localeCompare(b.id));
 const oldestOpenId = companyOpenMonthsSorted[0]?.id;

 return (
 <div className="space-y-6">
 <div>
 <h3 className="text-sm font-bold text-slate-900">{t('Fiscal Calendar Management')}</h3>
 <p className="text-[11px] text-slate-400">
 {t('Multiple fiscal periods may be open concurrently')} ({companyOpenMonthsSorted.length} {t('open now')}). {t('Transactions dated within any open month are accepted. Months close oldest-first — the server enforces both the concurrency cap and the close order and will reject an action here with a clear message if it doesn\'t qualify.')}
 </p>
 </div>

 <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
 {/* List calendar */}
 <div className="md:col-span-2 border border-slate-100 rounded-2xl overflow-hidden shadow-sm">
 <table className="w-full text-xs">
 <thead>
 <tr className="bg-slate-50 text-slate-500">
 <th className="p-3 text-start">{t('Fiscal Month')}</th>
 <th className="p-3 text-center">{t('Status')}</th>
 <th className="p-3 text-end">{t('Actions')}</th>
 </tr>
 </thead>
 <tbody>
 {fiscalMonths.filter(m => m.companyId === db.selectedCompanyId).map(m => {
 const isOldestOpen = m.status === 'Open' && m.id === oldestOpenId;
 return (
 <tr key={m.id} className="border-b border-slate-100">
 <td className="p-3 font-semibold text-slate-800">
 {translateMonthLabel(m.name, t)} <span className="text-[10px] text-slate-400 font-mono ms-1">({m.id})</span>
 {isOldestOpen && (
 <span className="ms-1.5 px-1.5 py-0.5 rounded-full text-[8px] font-bold uppercase bg-amber-100 text-amber-700" title={t('Oldest open month — the server currently allows closing this one.')}>{t('Oldest open')}</span>
 )}
 </td>
 <td className="p-3 text-center">
 <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${
 m.status === 'Open' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-400'
 }`}>
 {m.status === 'Open' ? `🔓 ${t('Open')}` : `🔒 ${t('Closed')}`}
 </span>
 </td>
 <td className="p-3 text-end">
 {m.status === 'Open' ? (
 canCloseFiscalMonths && (
 <button
 onClick={() => handleInitiateClose(m)}
 className="px-2.5 py-1 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-lg font-bold text-[10px] transition"
 >
 {t('Close & Lock Month')}
 </button>
 )
 ) : (
 <span className="text-[10px] text-slate-400 font-medium">{t('Locked')} ({m.closedOption === 'paid_only' ? t('Paid') : t('Accrual')})</span>
 )}
 </td>
 </tr>
 );
 })}
 </tbody>
 </table>
 </div>

 {/* Open New Month form */}
 {canOpenFiscalMonths && (
 <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3">{t('Open New Month')}</h4>
 <form onSubmit={handleOpenMonth} className="space-y-4">
 <p className="text-[11px] text-slate-400">
 {companyOpenMonthsSorted.length} {t('month(s) currently open. The server allows up to 3 concurrently open and will reject this if the cap is already reached.')}
 </p>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Year')}</label>
 <input
 type="text"
 required
 value={monthForm.year}
 onChange={(e) => setMonthForm({ ...monthForm, year: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none"
 />
 </div>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Month (MM)')}</label>
 <select
 value={monthForm.month}
 onChange={(e) => setMonthForm({ ...monthForm, month: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none"
 >
 <option value="01">{t('January')} (01)</option>
 <option value="02">{t('February')} (02)</option>
 <option value="03">{t('March')} (03)</option>
 <option value="04">{t('April')} (04)</option>
 <option value="05">{t('May')} (05)</option>
 <option value="06">{t('June')} (06)</option>
 <option value="07">{t('July')} (07)</option>
 <option value="08">{t('August')} (08)</option>
 <option value="09">{t('September')} (09)</option>
 <option value="10">{t('October')} (10)</option>
 <option value="11">{t('November')} (11)</option>
 <option value="12">{t('December')} (12)</option>
 </select>
 </div>
 <button
 type="submit"
 className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white rounded-2xl py-2 font-bold text-xs transition shadow-sm"
 >
 {t('Create Fiscal Period')}
 </button>
 </form>
 </div>
 )}
 </div>
 </div>
 );
 })()}

 {/* TAB: STAFF USERS */}
 {activeTab === 'users' && (
 <div className="space-y-6 animate-fade-in">
 {/* Header with Title and Filter info */}
 <div className="bg-slate-50 p-5 rounded-2xl border border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-4">
 <div>
 <h3 className="text-sm font-extrabold text-slate-900 uppercase tracking-wide">{t('Staff Accounts & RBAC Permissions')}</h3>
 <p className="text-[11px] text-slate-500 mt-0.5">{t('Provision user accounts, assign corporate boundaries, and manage dynamic roles and access restrictions.')}</p>
 </div>

 {db.currentUser?.isSuperAdmin ? (
 <div className="flex items-center gap-2 bg-white px-3 py-1.5 rounded-2xl border border-slate-200">
 <span className="text-[10px] font-bold text-slate-500 uppercase shrink-0">{t('Filter Directory:')}</span>
 <select
 value={userCompanyFilter}
 onChange={(e) => setUserCompanyFilter(e.target.value)}
 className="bg-transparent text-xs font-bold text-slate-700 focus:outline-none cursor-pointer"
 >
 <option value="all">{t('All Organizations')}</option>
 {db.companies?.map(comp => (
 <option key={comp.id} value={comp.id}>{comp.name}</option>
 ))}
 </select>
 </div>
 ) : (
 <div className="px-3 py-1.5 bg-slate-100 rounded-2xl border border-slate-200/40 text-[10px] font-extrabold text-indigo-700 uppercase flex items-center gap-1">
 🏢 {t('BOUNDED TO:')} {db.companySetup?.name || t('Current Organization')}
 </div>
 )}
 </div>

 {/* Stats Row */}
 <div className="grid grid-cols-3 gap-4">
 <div className="bg-slate-50/50 p-4 rounded-2xl border border-slate-100">
 <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">{t('Total Users')}</span>
 <p className="text-base font-black text-slate-800 mt-1">{db.users.filter(u => u.isDeleted !== 1).length}</p>
 </div>
 <div className="bg-slate-50/50 p-4 rounded-2xl border border-slate-100">
 <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">{t('Active Accounts')}</span>
 <p className="text-base font-black text-emerald-600 mt-1">
 {db.users.filter(u => u.isDeleted !== 1 && u.isActive !== false).length}
 </p>
 </div>
 <div className="bg-slate-50/50 p-4 rounded-2xl border border-slate-100">
 <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">{t('Deactivated')}</span>
 <p className="text-base font-black text-slate-400 mt-1">
 {db.users.filter(u => u.isDeleted !== 1 && u.isActive === false).length}
 </p>
 </div>
 </div>

 {/* Main side-by-side management layout */}
 <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">

 {/* COLUMN 1: ACCOUNT CREATION/EDIT FORM (Left) — gated per-mode: create needs
     users.create, editing an existing account needs users.update. A viewer with
     only users.read (directory-view-only) never sees this column at all. */}
 {(editingUser ? canUpdateUsers : canCreateUsers) && (
 <div ref={formRef} className="lg:col-span-5 bg-white border border-slate-200/60 rounded-2xl p-5 shadow-sm space-y-4">
 <div className="flex justify-between items-start">
 <div>
 <h4 className="text-xs font-extrabold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
 {editingUser ? (
 <>
 <Edit2 className="w-4 h-4 text-amber-600" />
 {t('Update User Account')}
 </>
 ) : (
 <>
 <Plus className="w-4 h-4 text-indigo-600" />
 {t('Provision New Account')}
 </>
 )}
 </h4>
 <p className="text-[10px] text-slate-400 mt-0.5">
 {editingUser ? t('Modify active credentials and permissions.') : t('Create a login and assign operational limits.')}
 </p>
 </div>
 {editingUser && (
 <button
 type="button"
 onClick={() => {
 setEditingUser(null);
 setUserForm({
 username: '',
 email: '',
 password: '',
 confirmPassword: '',
 role: 'user',
 companyId: db.selectedCompanyId,
 roleIds: [],
 branchIds: [],
 primaryBranchId: '',
 employeeId: '',
  });
 }}
 className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg text-[9px] font-bold uppercase transition"
 >
 {t('Cancel Edit')}
 </button>
 )}
 </div>

 <form onSubmit={handleAddUser} className="space-y-4">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Account Username')}</label>
 <input
 type="text"
 required
 placeholder={t('e.g. Accountant Sarah, Sales Tariq')}
 value={userForm.username}
 onChange={(e) => setUserForm({ ...userForm, username: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all font-semibold"
 />
 </div>

 <div className="space-y-1">
 <div className="flex items-center justify-between">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Account Email')}</label>
 <span className="text-[8px] text-slate-400 font-mono">{t('Required — used for password reset')}</span>
 </div>
 <input
 type="email"
 required
 placeholder={t('e.g. sarah@company.com')}
 value={userForm.email}
 onChange={(e) => setUserForm({ ...userForm, email: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all font-semibold"
 />
 </div>

 <div className="space-y-1">
 <div className="flex items-center justify-between">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Account Password')}</label>
 <span className="text-[8px] text-slate-400 font-mono">{editingUser ? t('Leave blank to keep current password') : t('Leave blank to default to 123456, or set one (min 6 chars, letter + digit)')}</span>
 </div>
 <input
 type="password"
 placeholder={editingUser ? t('Leave blank to keep current password') : t('e.g. Tariq@ERP1')}
 value={userForm.password}
 onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all font-semibold"
 />
 </div>

 {userForm.password.trim() && (
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Confirm Password')}</label>
 <input
 type="password"
 placeholder={t('Re-enter the password above')}
 value={userForm.confirmPassword}
 onChange={(e) => setUserForm({ ...userForm, confirmPassword: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all font-semibold"
 />
 </div>
 )}

 <div className="grid grid-cols-2 gap-3">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Account Role')}</label>
 <select
 value={userForm.role}
 onChange={(e) => setUserForm({ ...userForm, role: e.target.value as UserRole })}
 className="w-full bg-slate-50 border border-slate-200 focus:border-indigo-500 rounded-2xl px-2.5 py-2 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-semibold cursor-pointer"
 >
 <option value="user">{t('Staff Member')}</option>
 {/* Hidden for a delegated (non-admin-tier) actor: POST /api/users forces role
     to 'user' unconditionally for anyone here only via users.create/update, not
     real admin tier (see server/routes/users.ts) — showing this option to them
     would promise an escalation the server silently refuses. */}
 {isAdmin && <option value="admin">{t('Company Admin')}</option>}
 </select>
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Assigned Company')}</label>
 {db.currentUser?.isSuperAdmin ? (
 <select
 value={userForm.companyId}
 onChange={(e) => setUserForm({ ...userForm, companyId: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 focus:border-indigo-500 rounded-2xl px-2.5 py-2 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-semibold cursor-pointer"
 >
 {db.companies?.map(comp => (
 <option key={comp.id} value={comp.id}>{comp.name}</option>
 ))}
 </select>
 ) : (
 <div className="w-full bg-slate-100 border border-slate-200 rounded-2xl px-3 py-2 text-xs text-slate-500 font-bold overflow-hidden text-ellipsis whitespace-nowrap">
 🏢 {db.companySetup?.name || t('Scoped Company')}
 </div>
 )}
 </div>
 </div>

 {(() => {
   const employeeCompanyId = userForm.companyId || db.selectedCompanyId;
   const companyEmployees = (db.employees || []).filter(e => e.companyId === employeeCompanyId && e.isActive !== false);
   if (companyEmployees.length === 0) return null;
   return (
     <div className="space-y-1">
       <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Linked Employee')} <span className="text-rose-500">*</span></label>
       <select
         required
         value={userForm.employeeId}
         onChange={(e) => setUserForm({ ...userForm, employeeId: e.target.value })}
         className="w-full bg-slate-50 border border-slate-200 focus:border-indigo-500 rounded-2xl px-2.5 py-2 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-semibold cursor-pointer"
       >
         <option value="">{t('-- Choose Employee --')}</option>
         {companyEmployees.map(emp => (
           <option key={emp.id} value={emp.id}>{`${emp.employeeNumber} — ${emp.name}`}</option>
         ))}
       </select>
       <p className="text-[9px] text-slate-400 leading-relaxed pt-0.5">
         {t('This company uses HR employee onboarding — every login account must be linked to the onboarded employee it belongs to.')}
       </p>
     </div>
   );
 })()}

 {userForm.role === 'admin' ? (
 <div className="p-3 bg-rose-50 border border-rose-100 rounded-2xl text-[10px] text-rose-800 space-y-1">
 <p className="font-extrabold flex items-center gap-1">⭐ {t('Administrator Access')}</p>
 <p className="leading-relaxed text-slate-500">
 {t('Company Administrators have unrestricted power to create documents, update setups, and open/close fiscal periods strictly for their assigned company.')}
 </p>
 </div>
 ) : (
 <div className="space-y-1">
   <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Assigned Roles')}</label>
   {db.roles.length === 0 ? (
     <div className="p-3 bg-amber-50 border border-amber-100 rounded-2xl text-[10px] text-amber-800 leading-relaxed">
       {t('No Roles exist yet for this company. Create one in the')} <strong>{t('Roles')}</strong> {t('tab before provisioning staff accounts.')}
     </div>
   ) : (
     <div className="bg-slate-50 border border-slate-200/60 rounded-2xl p-3 space-y-1.5 max-h-48 overflow-y-auto">
       {db.roles.map(r => (
         <label key={r.id} className="flex items-center gap-2 text-xs text-slate-700 font-semibold cursor-pointer hover:text-indigo-600 transition">
           <input
             type="checkbox"
             checked={userForm.roleIds.includes(r.id)}
             onChange={(e) => {
               setUserForm(prev => ({
                 ...prev,
                 roleIds: e.target.checked
                   ? [...prev.roleIds, r.id]
                   : prev.roleIds.filter(id => id !== r.id)
               }));
             }}
             className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5 cursor-pointer"
           />
           {r.name}
         </label>
       ))}
     </div>
   )}
   <p className="text-[9px] text-slate-400 leading-relaxed pt-0.5">
     {t("A user with multiple roles gets the union of every assigned role's permissions — a page granted by more than one role just renders once.")}
   </p>
 </div>
 )}

 {userForm.role !== 'admin' && companyBranches.length > 0 && (
 <div className="space-y-1">
   <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Assigned Branches')}</label>
   <div className="bg-slate-50 border border-slate-200/60 rounded-2xl p-3 space-y-1.5 max-h-40 overflow-y-auto">
     {companyBranches.map(b => (
       <label key={b.id} className="flex items-center justify-between gap-2 text-xs text-slate-700 font-semibold cursor-pointer hover:text-indigo-600 transition">
         <span className="flex items-center gap-2">
           <input
             type="checkbox"
             checked={userForm.branchIds.includes(b.id)}
             onChange={(e) => {
               setUserForm(prev => {
                 const branchIds = e.target.checked ? [...prev.branchIds, b.id] : prev.branchIds.filter(id => id !== b.id);
                 // A cleared primary must not keep pointing at a branch no longer assigned.
                 const primaryBranchId = branchIds.includes(prev.primaryBranchId) ? prev.primaryBranchId : (branchIds[0] || '');
                 return { ...prev, branchIds, primaryBranchId };
               });
             }}
             className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5 cursor-pointer"
           />
           {b.name}
         </span>
         {userForm.branchIds.includes(b.id) && (
           <button
             type="button"
             onClick={() => setUserForm(prev => ({ ...prev, primaryBranchId: b.id }))}
             className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full border shrink-0 ${
               userForm.primaryBranchId === b.id
                 ? 'bg-indigo-600 text-white border-indigo-600'
                 : 'bg-white text-slate-400 border-slate-200 hover:text-indigo-600 hover:border-indigo-300'
             }`}
           >
             {userForm.primaryBranchId === b.id ? `⭐ ${t('Primary')}` : t('Set Primary')}
           </button>
         )}
       </label>
     ))}
   </div>
   <p className="text-[9px] text-slate-400 leading-relaxed pt-0.5">
     {t('Leave every branch unchecked for company-wide access (sees/can act on every branch) — restricting to specific branches only takes effect for a role that does NOT also grant "View & Act Across All Branches".')}
   </p>
 </div>
 )}

 <button
 type="submit"
 className="w-full bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl py-2 font-bold text-xs transition shadow-sm cursor-pointer mt-2"
 >
 {editingUser ? t('Update User Account Details') : t('Provision User Account')}
 </button>
 </form>
 </div>
 )}

 {/* COLUMN 2: ACTIVE STAFF DIRECTORY (Right) - High Density Card Layout to eliminate empty space */}
 <div className="lg:col-span-7 space-y-4">
 <div className="bg-white border border-slate-200/60 rounded-2xl p-5 shadow-sm">
 <h4 className="text-xs font-extrabold text-slate-700 uppercase tracking-wider mb-4">
 {t('Active Staff & Admins Directory')}
 </h4>

 <div className="space-y-3.5">
 {db.users
 .filter(u => u.isDeleted !== 1)
 .filter(u => userCompanyFilter === 'all' || u.companyId === userCompanyFilter)
 .map(u => {
 const userCompanyObj = db.companies?.find(c => c.id === u.companyId);
 const organizationName = u.isSuperAdmin
 ? t('All Companies (Super)')
 : (userCompanyObj?.name || u.companyId || t('Default Organization'));
 
 const isActive = u.isActive !== false;

 return (
 <div 
 key={u.id} 
 className={`p-4 rounded-2xl border transition-all duration-150 flex flex-col gap-3 relative ${
 isActive 
 ? 'bg-slate-50/20 border-slate-200/80 hover:border-indigo-200/80 hover:bg-slate-50/50' 
 : 'bg-slate-100/40 border-slate-200/40 opacity-75'
 }`}
 >
 {/* Card Header Row */}
 <div className="flex items-start justify-between">
 <div className="flex items-center gap-3">
 <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-black shrink-0 shadow-sm ${
 u.isSuperAdmin
 ? 'bg-purple-100 text-purple-700 border border-purple-200/50'
 : u.role === 'admin' 
 ? 'bg-rose-100 text-rose-700' 
 : 'bg-indigo-100 text-indigo-700'
 }`}>
 {u.username.substring(0, 2).toUpperCase()}
 </div>
 <div>
 <h5 className={`font-extrabold text-xs flex items-center gap-2 ${!isActive ? 'text-slate-400 line-through' : 'text-slate-900'}`}>
 {u.username}
 <span className={`px-1.5 py-0.5 rounded text-[8px] font-extrabold uppercase ${
 u.isSuperAdmin
 ? 'bg-purple-100 text-purple-700'
 : u.role === 'admin'
 ? 'bg-rose-100 text-rose-700'
 : 'bg-indigo-50 text-indigo-700'
 }`}>
 {u.isSuperAdmin ? t('Super Admin') : u.role === 'admin' ? t('Company Admin') : t('Staff')}
 </span>
 </h5>
 <span className="text-[9px] text-slate-400 font-mono mt-0.5 block">{t('Account ID:')} {u.id}</span>
 <span className={`text-[9px] font-mono mt-0.5 block ${u.email ? 'text-slate-400' : 'text-amber-600 font-bold'}`}>
 {u.email || t('No email on file — password reset unavailable')}
 </span>
 </div>
 </div>

 {/* Actions (Toggle Status & Delete) */}
 <div className="flex items-center gap-1.5">
 {/* Edit details and password button */}
 {canUpdateUsers && (
 <button
 type="button"
 onClick={() => {
 setEditingUser(u); formRef.current?.scrollIntoView({ behavior: 'smooth' });
 setUserForm({
 username: u.username,
 email: u.email || '',
 password: '',
 confirmPassword: '',
 role: u.role,
 companyId: u.companyId || db.selectedCompanyId,
  roleIds: (db.userRoles || []).filter(ur => ur.userId === u.id).map(ur => ur.roleId),
  branchIds: (db.userBranches || []).filter(ub => ub.userId === u.id).map(ub => ub.branchId),
  primaryBranchId: (db.userBranches || []).find(ub => ub.userId === u.id && ub.isPrimary)?.branchId || '',
  employeeId: (u as any).employeeId || '',
                        });
 }}
 className="p-1 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded transition-all cursor-pointer"
 title={t('Edit details & password')}
 >
 <Edit2 className="w-3.5 h-3.5" />
 </button>
 )}

 {/* Toggle Button */}
 {canDeleteUsers && (
 <button
 type="button"
 onClick={() => handleToggleUserActive(u.id)}
 disabled={u.id === db.currentUser?.id}
 className={`px-2 py-0.5 rounded text-[8px] font-extrabold uppercase transition-all tracking-wider flex items-center gap-1.5 border cursor-pointer select-none ${
 isActive
 ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
 : 'bg-slate-100 text-slate-400 border-slate-200 hover:bg-slate-200'
 } disabled:opacity-50 disabled:cursor-not-allowed`}
 title={u.id === db.currentUser?.id ? t('You cannot suspend yourself') : t('Toggle status')}
 >
 <span className={`w-1 h-1 rounded-full ${isActive ? 'bg-emerald-500' : 'bg-slate-400'}`}></span>
 {isActive ? t('Active') : t('Disabled')}
 </button>
 )}

 {/* Delete button */}
 {canDeleteUsers && (
 <button
 type="button"
 onClick={() => handleDeleteUser(u.id)}
 disabled={u.id === db.currentUser?.id}
 className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded transition-all cursor-pointer disabled:opacity-30"
 title={u.id === db.currentUser?.id ? t('Active session') : t('Remove account')}
 >
 <Trash2 className="w-3.5 h-3.5" />
 </button>
 )}
 </div>
 </div>

 {/* Card Middle Row: Scoped Organization */}
 <div className="flex items-center gap-1.5 bg-white p-2 rounded-lg border border-slate-150/40 text-[10px] text-slate-600">
 <span className="font-bold text-slate-400 uppercase text-[9px]">{t('Assigned Company:')}</span>
 <span className="font-extrabold text-slate-900 flex items-center gap-1">
 🏢 {organizationName}
 </span>
 </div>

 {/* Card Middle Row 2: Credentials & Access */}
 <div className="flex items-center gap-1.5 bg-white p-2 rounded-lg border border-slate-150/40 text-[10px] text-slate-600">
 <span className="font-bold text-slate-400 uppercase text-[9px]">{t('Sign-in Credentials:')}</span>
 <span className="font-extrabold text-slate-900 flex items-center gap-1 font-mono text-[9px] bg-slate-50 px-1 py-0.5 rounded border border-slate-100">
 <Key className="w-3 h-3 text-slate-400" />
 {t('Password is set — use Edit to change it')}
 </span>
 </div>

 {/* Card Bottom Row: Assigned roles */}
 <div className="pt-2 border-t border-slate-100 flex flex-wrap gap-1 items-center">
 <span className="text-[9px] font-bold text-slate-400 uppercase me-1">{t('RBAC Scope:')}</span>
 {u.role === 'admin' || u.isSuperAdmin ? (
 <span className="px-1.5 py-0.5 bg-rose-50 text-rose-700 text-[8px] font-bold uppercase rounded">{t('Full Authority')}</span>
 ) : (() => {
 const assignedRoleIds = new Set((db.userRoles || []).filter(ur => ur.userId === u.id).map(ur => ur.roleId));
 const assignedRoles = db.roles.filter(r => assignedRoleIds.has(r.id));
 return assignedRoles.length > 0 ? (
 <>
 {assignedRoles.map(r => (
 <span key={r.id} className="px-1.5 py-0.5 bg-indigo-50 text-indigo-700 text-[8px] font-semibold rounded">{r.name}</span>
 ))}
 </>
 ) : (
 <span className="px-1.5 py-0.5 bg-rose-50 text-rose-700 text-[8px] font-bold uppercase rounded">{t('No Role Assigned')}</span>
 );
 })()}
 </div>
 </div>
 );
 })}
 </div>
 </div>
 </div>

 </div>
 </div>
 )}

 {/* TAB: ROLES */}
 {activeTab === 'roles' && (
 <div className="space-y-6 animate-fade-in">
 <div>
 <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wide">{t('Roles')}</h3>
 <p className="text-[11px] text-slate-400 mt-0.5">
 {t("Define reusable, company-scoped permission sets. Assign one or more roles to a staff account instead of configuring permissions per user — a user's effective access is the union of every role they hold.")}
 </p>
 </div>

 {successMsg && (
 <div className="p-3 bg-emerald-50 text-emerald-700 rounded-2xl border border-emerald-100 text-xs font-semibold">{successMsg}</div>
 )}
 {errorMsg && (
 <div className="p-3 bg-rose-50 text-rose-700 rounded-2xl border border-rose-100 text-xs font-semibold">{errorMsg}</div>
 )}

 <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
 {/* COLUMN 1: ROLE FORM */}
 <div className="lg:col-span-5 space-y-4">
 <form onSubmit={handleSaveRole} className="bg-white border border-slate-200/60 rounded-2xl p-5 shadow-sm space-y-4">
 <div className="flex items-center justify-between">
 <h4 className="text-xs font-extrabold text-slate-700 uppercase tracking-wider">
 {roleForm.id ? t('Edit Role') : t('Create New Role')}
 </h4>
 {roleForm.id && (
 <button
 type="button"
 onClick={() => { setRoleForm({ id: null, name: '', permissions: {} }); setEditingRole(null); }}
 className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg text-[9px] font-bold uppercase transition"
 >
 {t('Cancel Edit')}
 </button>
 )}
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Role Name')}</label>
 <input
 type="text"
 required
 placeholder={t('e.g. Sales Rep, Cashier, Procurement Officer')}
 value={roleForm.name}
 onChange={(e) => setRoleForm(prev => ({ ...prev, name: e.target.value }))}
 className="w-full bg-slate-50 border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-semibold"
 />
 </div>

 <PermissionTree
 permissions={roleForm.permissions}
 onChange={(updated) => setRoleForm(prev => ({ ...prev, permissions: updated }))}
 t={t}
 />

 <button
 type="submit"
 className="w-full bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl py-2 font-bold text-xs transition shadow-sm cursor-pointer"
 >
 {roleForm.id ? t('Update Role') : t('Create Role')}
 </button>
 </form>
 </div>

 {/* COLUMN 2: ROLE LIST */}
 <div className="lg:col-span-7 space-y-4">
 <div className="bg-white border border-slate-200/60 rounded-2xl p-5 shadow-sm">
 <h4 className="text-xs font-extrabold text-slate-700 uppercase tracking-wider mb-4">
 {t('Roles for')} {db.companySetup?.name || t('this company')} ({db.roles.length})
 </h4>
 <div className="space-y-2.5">
 {db.roles.length === 0 && (
 <p className="text-xs text-slate-400 italic py-6 text-center">{t('No roles created yet.')}</p>
 )}
 {db.roles.map(r => {
 const assignedCount = (db.userRoles || []).filter(ur => ur.roleId === r.id).length;
 return (
 <div key={r.id} className="p-3 bg-slate-50 border border-slate-200/60 rounded-2xl flex items-center justify-between gap-3">
 <div className="min-w-0">
 <p className="text-xs font-bold text-slate-800 truncate">{r.name}</p>
 <p className="text-[10px] text-slate-400">{assignedCount} {assignedCount === 1 ? t('user assigned') : t('users assigned')}</p>
 </div>
 <div className="flex items-center gap-1.5 shrink-0">
 <button
 type="button"
 onClick={() => { setEditingRole(r); setRoleForm({ id: r.id, name: r.name, permissions: r.permissions || {} }); }}
 className="p-1.5 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-all cursor-pointer"
 title={t('Edit role')}
 >
 <Edit2 className="w-3.5 h-3.5" />
 </button>
 {confirmDeleteRoleId === r.id ? (
 <>
 <button type="button" onClick={() => handleDeleteRole(r.id)} className="px-2 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-[10px] font-bold transition">{t('Confirm')}</button>
 <button type="button" onClick={() => setConfirmDeleteRoleId(null)} className="px-2 py-1 bg-slate-200 hover:bg-slate-300 text-slate-600 rounded-lg text-[10px] font-bold transition">{t('Cancel')}</button>
 </>
 ) : (
 <button
 type="button"
 onClick={() => setConfirmDeleteRoleId(r.id)}
 className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-all cursor-pointer"
 title={t('Delete role')}
 >
 <Trash2 className="w-3.5 h-3.5" />
 </button>
 )}
 </div>
 </div>
 );
 })}
 </div>
 </div>
 </div>
 </div>
 </div>
 )}

 {/* TAB: EQUITY & CAPITAL INVESTORS */}
 {activeTab === 'equity' && (
 <div className="space-y-8 animate-fade-in">
 <div>
 <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wide">{t('Investor Equity & Capital Contributions')}</h3>
 <p className="text-[11px] text-slate-400 mt-0.5">{t('Manage capital investors, register equity percentages, and record official cash injections into your corporate bank accounts.')}</p>
 </div>

 <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">

 {/* COLUMN 1: LEFT SIDE (Form & Registry) */}
 <div className="lg:col-span-5 space-y-6">

 {/* Registration form */}
 <div className="bg-slate-50 border border-slate-100 p-5 rounded-2xl">
 <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-4 flex items-center gap-1.5">
 <Plus className="w-4 h-4 text-indigo-600" />
 {t('Register New Investor')}
 </h4>

 <form onSubmit={handleAddInvestor} className="space-y-3">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Investor Name')}</label>
 <input
 type="text"
 required
 placeholder={t('e.g. Abdullah bin Jameel')}
 value={investorForm.name}
 onChange={(e) => setInvestorForm({ ...investorForm, name: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Assigned Company')}</label>
 <div className="w-full bg-slate-100 border border-slate-200 rounded-2xl px-3 py-2 text-xs text-slate-500 font-bold overflow-hidden text-ellipsis whitespace-nowrap">
 🏢 {db.companySetup?.name || t('Scoped Company')}
 </div>
 </div>

 <div className="grid grid-cols-2 gap-3">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Contact Phone')}</label>
 <input
 type="text"
 placeholder={t('e.g. +966 50...')}
 value={investorForm.phone}
 onChange={(e) => setInvestorForm({ ...investorForm, phone: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Email Address')}</label>
 <input
 type="email"
 placeholder={t('e.g. abdullah@invest.sa')}
 value={investorForm.email}
 onChange={(e) => setInvestorForm({ ...investorForm, email: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>
 </div>

 <div className="grid grid-cols-2 gap-3">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Equity Share (%)')}</label>
 <input
 type="number"
 step="0.01"
 required
 min="0"
 max="100"
 placeholder={t('e.g. 50')}
 value={investorForm.equityPercentage}
 onChange={(e) => setInvestorForm({ ...investorForm, equityPercentage: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Profit Share (%)')}</label>
 <input
 type="number"
 step="0.01"
 min="0"
 max="100"
 placeholder={t('Defaults to Equity %')}
 value={investorForm.profitPercentage}
 onChange={(e) => setInvestorForm({ ...investorForm, profitPercentage: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Notes')}</label>
 <textarea
 rows={2}
 placeholder={t('Agreement details, transfer parameters...')}
 value={investorForm.notes}
 onChange={(e) => setInvestorForm({ ...investorForm, notes: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
 />
 </div>

 <button
 type="submit"
 className="w-full bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl py-2 font-bold text-xs transition shadow-sm mt-2"
 >
 {t('Add Investor to Registry')}
 </button>
 </form>
 </div>

 {/* Registered Investor Directory */}
 <div className="bg-white border border-slate-200/60 rounded-2xl p-5">
 <div className="flex flex-col gap-2.5 mb-4 pb-2 border-b border-slate-100">
 <div className="flex justify-between items-center">
 <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider">{t('Investor Shareholding Directory')}</h4>
 </div>
 </div>

 {(() => {
 const filteredInvestors = db.investors.filter(inv => {
 return (inv.companyId) === (db.selectedCompanyId);
 });

 if (filteredInvestors.length === 0) {
 return (
 <div className="text-center py-6 text-slate-400 text-xs">
 {t('No investors registered for the selected company scope.')}
 </div>
 );
 }

 return (
 <div className="space-y-3 divide-y divide-slate-100">
 {filteredInvestors.map((inv) => {
 // Calculate exact total capital contributed by summing vouchers in db
 const currentTotalContributed = db.vouchers
 .filter(v => v.referenceType === 'Equity' && v.referenceId === inv.id)
 .reduce((sum, v) => sum + v.amount, 0);

 const assignedCompanyName = db.companies?.find(c => c.id === inv.companyId)?.name || t('Scoped Company');

 return (
 <div key={inv.id} className="pt-3 first:pt-0">
 <div className="flex justify-between items-start">
 <div>
 <span className="font-extrabold text-slate-900 text-xs">{inv.name}</span>
 <div className="text-[10px] text-slate-400 space-x-2 mt-0.5 flex flex-wrap items-center gap-y-1">
 <span>{inv.phone || t('No Phone')}</span>
 <span>•</span>
 <span>{inv.email || t('No Email')}</span>
 <span>•</span>
 <span className="inline-flex items-center gap-1 font-bold text-slate-600 bg-slate-50 border border-slate-100 px-1.5 py-0.5 rounded-full text-[9px] uppercase tracking-wide">
 🏢 {assignedCompanyName}
 </span>
 </div>
 </div>
 <div className="flex flex-col items-end gap-1">
 <span className="bg-indigo-50 text-indigo-700 font-extrabold text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap">
 {inv.equityPercentage}% {t('Equity')}
 </span>
 <span className="bg-emerald-50 text-emerald-700 font-extrabold text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap">
 {inv.profitPercentage ?? inv.equityPercentage}% {t('Profit')}
 </span>
 </div>
 </div>

 <div className="flex justify-between items-center mt-2.5 bg-slate-50/50 p-2 rounded-lg border border-slate-100">
 <span className="text-[9px] font-extrabold text-slate-400 uppercase tracking-wider">{t('Total Funded Capital:')}</span>
 <span className="font-bold text-xs text-slate-950">
 {currencySymbol} {currentTotalContributed.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
 </span>
 </div>

 {inv.notes && (
 <p className="text-[10px] italic text-slate-400 mt-1.5 px-1 bg-slate-50/20 py-0.5 rounded border border-dotted border-slate-100">{inv.notes}</p>
 )}
 </div>
 );
 })}
 </div>
 );
 })()}
 </div>
 </div>

 {/* COLUMN 2: RIGHT SIDE (Contribution form & Logs) */}
 <div className="lg:col-span-7 space-y-6">

 {/* Record Contribution Form */}
 <div className="bg-white border border-slate-200/60 p-5 rounded-2xl shadow-sm">
 <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-4 flex items-center gap-1.5">
 <Coins className="w-4 h-4 text-emerald-500" />
 {t('Record Capital Contribution (Cash Injection)')}
 </h4>

 {!db.investors || db.investors.length === 0 ? (
 <div className="bg-amber-50 text-amber-800 p-3 rounded-2xl text-xs border border-amber-100 leading-relaxed">
 {t('Please register at least one investor in the Shareholding Directory first before recording capital investments.')}
 </div>
 ) : (
 <form onSubmit={handleAddInvestment} className="space-y-4">
 <div className="grid grid-cols-2 gap-4">
 <div className="space-y-1.5">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Select Investor')}</label>
 <select
 required
 value={investmentForm.investorId}
 onChange={(e) => setInvestmentForm({ ...investmentForm, investorId: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 focus:outline-none"
 >
 <option value="">{t('-- Choose Investor --')}</option>
 {db.investors.map(inv => (
 <option key={inv.id} value={inv.id}>{inv.name} ({inv.equityPercentage}%)</option>
 ))}
 </select>
 </div>

 <div className="space-y-1.5">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Target Bank Account (Debit Account)')}</label>
 <select
 required
 value={investmentForm.bankId}
 onChange={(e) => setInvestmentForm({ ...investmentForm, bankId: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 focus:outline-none"
 >
 <option value="">{t('-- Choose Account --')}</option>
 {db.banks.filter(b => b.isActive).map(b => (
 <option key={b.id} value={b.id}>{b.bankName} - {b.accountTitle}</option>
 ))}
 </select>
 </div>

 <div className="space-y-1.5">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Injection Amount')} ({currencySymbol})</label>
 <input
 type="number"
 step="0.01"
 required
 min="1"
 placeholder={t('e.g. 50000.00')}
 value={investmentForm.amount}
 onChange={(e) => setInvestmentForm({ ...investmentForm, amount: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 focus:outline-none"
 />
 </div>

 <div className="space-y-1.5">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Date Received')}</label>
 <input
 type="date"
 required
 value={investmentForm.date}
 onChange={(e) => setInvestmentForm({ ...investmentForm, date: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 focus:outline-none"
 />
 </div>
 </div>

 <div className="space-y-1.5">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Transaction Description / Notes')}</label>
 <input
 type="text"
 required
 placeholder={t('e.g. Seed investment, round A funding transfer...')}
 value={investmentForm.description}
 onChange={(e) => setInvestmentForm({ ...investmentForm, description: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 focus:outline-none"
 />
 </div>

 <button
 type="submit"
 className="w-full bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl py-2.5 font-bold text-xs transition shadow-sm"
 >
 {t('Process Investment (Generate Receipt Voucher)')}
 </button>
 </form>
 )}
 </div>

 {/* Investment Cash Contribution Log */}
 <div className="bg-white border border-slate-200/60 rounded-2xl p-5">
 <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-4">{t('Investment Contribution Receipt Log')}</h4>

 {db.vouchers.filter(v => v.referenceType === 'Equity').length === 0 ? (
 <div className="text-center py-8 text-slate-400 text-xs">
 {t('No capital contributions processed yet.')}
 </div>
 ) : (
 <div className="overflow-x-auto">
 <table className="w-full text-start text-xs">
 <thead>
 <tr className="border-b border-slate-100 text-slate-400">
 <th className="py-2 font-bold uppercase text-[9px] tracking-wider">{t('Voucher No')}</th>
 <th className="py-2 font-bold uppercase text-[9px] tracking-wider">{t('Date')}</th>
 <th className="py-2 font-bold uppercase text-[9px] tracking-wider">{t('Investor')}</th>
 <th className="py-2 font-bold uppercase text-[9px] tracking-wider">{t('Bank Account')}</th>
 <th className="py-2 font-bold uppercase text-[9px] tracking-wider">{t('Description')}</th>
 <th className="py-2 text-end font-bold uppercase text-[9px] tracking-wider">{t('Amount')}</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-50">
 {db.vouchers
 .filter(v => v.referenceType === 'Equity')
 .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
 .map(v => {
 const investor = !db.investors ? null : db.investors.find(i => i.id === v.referenceId);
 const bank = db.banks.find(b => b.id === v.bankId);
 return (
 <tr key={v.id} className="hover:bg-slate-50/50">
 <td className="py-3 font-mono font-bold text-[11px] text-indigo-600">{v.voucherNumber}</td>
 <td className="py-3 text-slate-500 whitespace-nowrap">{v.date}</td>
 <td className="py-3 font-semibold text-slate-900">{investor?.name || t('Unknown')}</td>
 <td className="py-3 text-slate-600 font-medium">{bank?.bankName || t('Unknown Bank')}</td>
 <td className="py-3 text-slate-500 max-w-[180px] truncate" title={v.description}>{v.description}</td>
 <td className="py-3 text-end font-extrabold text-slate-950">
 {currencySymbol} {v.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
 </td>
 </tr>
 );
 })}
 </tbody>
 </table>
 </div>
 )}
 </div>
 </div>

 </div>
 </div>
 )}

 {/* TAB: VAT RETURNS (ZATCA FILING) */}
 {activeTab === 'taxReturns' && (
 <VatReturnsPanel db={db} />
 )}

 {/* TAB: DATABASE PORTABILITY & SYNC */}

 {activeTab === 'translations' && (() => {
   const getTranslationModule = (key: string): string => {
     const k = key.toLowerCase();
     if (k.includes('quotation') || k.includes('validity') || k.includes('qt-') || k.includes('subject') || ['draft', 'approved', 'sent', 'accepted', 'converted'].includes(k)) {
       return 'Quotation';
     }
     if (k.includes('invoice') || k.includes('inv-') || k.includes('payment') || k.includes('due') || k.includes('receivable') || ['paid', 'unpaid', 'partially paid', 'pending', 'overdue'].includes(k)) {
       return 'Invoice';
     }
     if (k.includes('expense') || k.includes('procurement') || k.includes('exp-') || k.includes('accrual') || k.includes('actual') || k.includes('settle') || k.includes('recurring') || k.includes('posting')) {
       return 'Expense';
     }
     if (k.includes('pos') || k.includes('shift') || k.includes('cart') || k.includes('held') || k.includes('cash') || k.includes('terminal') || k.includes('register') || k.includes('drawer')) {
       return 'POS';
     }
     if (k.includes('report') || k.includes('ledger') || k.includes('p&l') || k.includes('balance sheet') || k.includes('income statement') || k.includes('trial balance') || k.includes('voucher') || k.includes('vch-') || k.includes('timeline') || k.includes('target') || k.includes('kpi') || k.includes('profit') || k.includes('sales figure') || k.includes('gross month')) {
       return 'Reports & KPIs';
     }
     if (k.includes('customer') || k.includes('vendor') || k.includes('product') || k.includes('service') || k.includes('bank') || k.includes('tax') || k.includes('vat')) {
       return 'Master Entities';
     }
     if (k.includes('settings') || k.includes('setup') || k.includes('rbac') || k.includes('calendar') || k.includes('equity') || k.includes('investor') || k.includes('database') || k.includes('portability') || k.includes('backup') || k.includes('translation') || k.includes('dictionary') || k.includes('company') || k.includes('user')) {
       return 'Settings & Admin';
     }
     return 'General';
   };

   const handleOpenAddTranslation = () => {
     setTranslationModal({ mode: 'add', key: '', en: '', ar: '', ur: '' });
   };

   const handleOpenEditTranslation = (item: any) => {
     setTranslationModal({ mode: 'edit', id: item.id, key: item.key, en: item.en || '', ar: item.ar || '', ur: item.ur || '' });
   };

   // One explicit transaction per action — a Create is one POST, an Update is one PATCH
   // fired only when Save is clicked (never per keystroke), a Delete is one DELETE. No
   // bulk/whole-array sync anywhere in this flow.
   const handleSaveTranslationModal = async (e: React.FormEvent) => {
     e.preventDefault();
     if (!translationModal) return;
     if (!translationModal.key.trim()) {
       triggerError(t('Translation key is required.'));
       return;
     }
     setIsSavingTranslation(true);
     try {
       const isEdit = translationModal.mode === 'edit';
       const res = await fetch(isEdit ? `/api/translations/${translationModal.id}` : '/api/translations', {
         method: isEdit ? 'PATCH' : 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
           key: translationModal.key.trim(),
           en: translationModal.en,
           ar: translationModal.ar,
           ur: translationModal.ur,
         }),
       });
       const result = await res.json().catch(() => ({}));
       if (!res.ok) {
         triggerError(result.error || t('Failed to save translation key.'));
         return;
       }
       triggerSuccess(isEdit ? t('Translation key updated successfully.') : t('New translation key added successfully.'));
       setTranslationModal(null);
       if (onRefreshDb) await onRefreshDb();
     } catch (err: any) {
       triggerError(err?.message || t('Failed to save translation key.'));
     } finally {
       setIsSavingTranslation(false);
     }
   };

   const handleConfirmDeleteTranslation = async () => {
     if (!deletingTranslationId) return;
     try {
       const res = await fetch(`/api/translations/${deletingTranslationId}`, { method: 'DELETE' });
       const result = await res.json().catch(() => ({}));
       if (!res.ok) {
         triggerError(result.error || t('Failed to delete translation key.'));
         return;
       }
       triggerSuccess(t('Translation key deleted successfully.'));
       if (onRefreshDb) await onRefreshDb();
     } catch (err: any) {
       triggerError(err?.message || t('Failed to delete translation key.'));
     } finally {
       setDeletingTranslationId(null);
     }
   };

   const allTranslations = db.translations || [];
   const filteredTranslations = allTranslations.filter((item: any) => {
     const search = transSearchQuery.toLowerCase();
     const keyMatch = item.key.toLowerCase().includes(search);
     const enMatch = (item.en || '').toLowerCase().includes(search);
     const arMatch = (item.ar || '').toLowerCase().includes(search);
     const urMatch = (item.ur || '').toLowerCase().includes(search);
     const matchesSearch = !transSearchQuery || keyMatch || enMatch || arMatch || urMatch;

     if (!matchesSearch) return false;
     if (transFilterModule === 'All') return true;
     return getTranslationModule(item.key) === transFilterModule;
   });

   const modules = ['All', 'Quotation', 'Invoice', 'Expense', 'POS', 'Reports & KPIs', 'Master Entities', 'Settings & Admin', 'General'];

   return (
     <div className="space-y-6">
       <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-slate-100 pb-4">
         <div>
           <h2 className="text-xl font-extrabold text-slate-900 flex items-center gap-2">
             <Languages className="w-6 h-6 text-indigo-600" />
             {t('UX Translations Dictionary')}
           </h2>
           <p className="text-sm text-slate-500 font-medium mt-1">{t('Manage global English, Arabic, and Urdu UX translations.')}</p>
         </div>
         <div className="flex items-center gap-3 self-end">
           <button
             type="button"
             onClick={handleOpenAddTranslation}
             className="bg-indigo-600 text-white px-4 py-2 rounded-2xl text-xs font-bold hover:bg-indigo-700 shadow-sm flex items-center gap-1.5"
           >
             <Plus className="w-4 h-4 shrink-0" /> {t('Add Translation')}
           </button>
         </div>
       </div>

       {/* Dynamic Filters Section */}
       <div className="bg-slate-50 border border-slate-200/60 rounded-2xl p-4 flex flex-col sm:flex-row items-center gap-4">
         <div className="w-full sm:w-1/3 relative">
           <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
           <input
             type="text"
             placeholder={t('Search translation key or values...')}
             value={transSearchQuery}
             onChange={(e) => setTransSearchQuery(e.target.value)}
             className="w-full pl-9 pr-4 py-2 bg-white border border-slate-200 rounded-xl text-xs font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
           />
         </div>
         <div className="w-full sm:w-1/3 flex items-center gap-2">
           <label className="text-xs font-bold text-slate-600 shrink-0">{t('Form/Module:')}</label>
           <select
             value={transFilterModule}
             onChange={(e) => setTransFilterModule(e.target.value)}
             className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
           >
             {modules.map(mod => (
               <option key={mod} value={mod}>{mod === 'All' ? t('All Modules / Forms') : t(mod)}</option>
             ))}
           </select>
         </div>
         <div className="w-full sm:w-1/3 text-end text-xs text-slate-500 font-medium sm:ml-auto">
           {t('Showing')} <strong className="text-slate-800 font-bold">{filteredTranslations.length}</strong> {t('of')} <strong className="text-indigo-600 font-bold">{allTranslations.length}</strong> {t('keys')}
         </div>
       </div>

       <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
         <table className="w-full text-start text-xs">
           <thead className="bg-slate-50 border-b border-slate-100 text-[10px] font-extrabold text-slate-500 uppercase tracking-wider">
             <tr>
               <th className="p-3 w-[25%] text-left">{t('UX Key')}</th>
               <th className="p-3 w-[24%] text-left">{t('English')}</th>
               <th className="p-3 w-[21%] text-left">{t('Arabic (ar)')}</th>
               <th className="p-3 w-[21%] text-left">{t('Urdu (ur)')}</th>
               <th className="p-3 w-[9%] text-end">{t('Actions')}</th>
             </tr>
           </thead>
           <tbody>
             {filteredTranslations.map((item: any) => (
               <tr key={item.id} className="border-b border-slate-50 hover:bg-slate-50/50">
                 <td className="p-3 align-top">
                   <span className="font-semibold text-slate-700 break-words">{item.key}</span>
                   <span className="text-[9px] text-indigo-500 font-mono mt-0.5 block">{getTranslationModule(item.key)}</span>
                 </td>
                 <td className="p-3 align-top text-slate-600 break-words">{item.en}</td>
                 <td className="p-3 align-top text-slate-600 break-words" dir="rtl">{item.ar}</td>
                 <td className="p-3 align-top text-slate-600 break-words" dir="rtl">{item.ur}</td>
                 <td className="p-3 align-top text-end">
                   <div className="flex items-center justify-end gap-1">
                     <button
                       type="button"
                       onClick={() => handleOpenEditTranslation(item)}
                       title={t('Edit')}
                       className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition"
                     >
                       <Edit2 className="w-3.5 h-3.5" />
                     </button>
                     <button
                       type="button"
                       onClick={() => setDeletingTranslationId(item.id)}
                       title={t('Delete')}
                       className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition"
                     >
                       <Trash2 className="w-3.5 h-3.5" />
                     </button>
                   </div>
                 </td>
               </tr>
             ))}
           </tbody>
         </table>
         {filteredTranslations.length === 0 && (
           <div className="p-12 text-center text-slate-400 font-medium flex flex-col items-center justify-center gap-2">
             <Languages className="w-8 h-8 text-slate-300" />
             <span>{t('No translations match the selected filter or search.')}</span>
           </div>
         )}
       </div>

       {/* Add/Edit Translation Modal */}
       {translationModal && (
         <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex justify-center items-center p-4 overflow-y-auto">
           <div className="bg-white rounded-2xl border border-slate-100 shadow-2xl p-6 w-full max-w-lg my-auto">
             <h3 className="font-bold text-sm text-slate-900 mb-1">
               {translationModal.mode === 'edit' ? t('Edit Translation Key') : t('Add New Translation Key')}
             </h3>
             <p className="text-xs text-slate-400 mb-4">{t('This is a single, global dictionary shared by every company on the platform.')}</p>
             <form onSubmit={handleSaveTranslationModal} className="space-y-4 text-xs">
               <div className="space-y-1">
                 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('UX Key')}</label>
                 <input
                   type="text"
                   required
                   value={translationModal.key}
                   onChange={(e) => setTranslationModal({ ...translationModal, key: e.target.value })}
                   className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                 />
               </div>
               <div className="space-y-1">
                 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('English')}</label>
                 <input
                   type="text"
                   value={translationModal.en}
                   onChange={(e) => setTranslationModal({ ...translationModal, en: e.target.value })}
                   className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                 />
               </div>
               <div className="space-y-1">
                 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Arabic (ar)')}</label>
                 <input
                   type="text"
                   dir="rtl"
                   value={translationModal.ar}
                   onChange={(e) => setTranslationModal({ ...translationModal, ar: e.target.value })}
                   className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 font-sans focus:outline-none focus:ring-1 focus:ring-indigo-500"
                 />
               </div>
               <div className="space-y-1">
                 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Urdu (ur)')}</label>
                 <input
                   type="text"
                   dir="rtl"
                   value={translationModal.ur}
                   onChange={(e) => setTranslationModal({ ...translationModal, ur: e.target.value })}
                   className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 font-sans focus:outline-none focus:ring-1 focus:ring-indigo-500"
                 />
               </div>
               <div className="flex justify-end gap-2 pt-2">
                 <button
                   type="button"
                   onClick={() => setTranslationModal(null)}
                   className="px-3 py-1.5 bg-slate-100 text-slate-500 rounded-lg text-xs font-semibold hover:bg-slate-200 transition"
                 >
                   {t('Cancel')}
                 </button>
                 <button
                   type="submit"
                   disabled={isSavingTranslation}
                   className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold transition shadow-sm disabled:opacity-60 disabled:cursor-not-allowed"
                 >
                   {isSavingTranslation ? t('Saving...') : t('Save')}
                 </button>
               </div>
             </form>
           </div>
         </div>
       )}

       {/* Delete Translation Confirmation Modal */}
       {deletingTranslationId && (
         <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex justify-center items-center p-4 overflow-y-auto">
           <div className="bg-white rounded-2xl border border-slate-100 shadow-2xl p-6 w-full max-w-sm my-auto">
             <div className="flex items-center gap-2 text-rose-600 mb-2">
               <AlertTriangle className="w-5 h-5" />
               <h3 className="text-lg font-bold">{t('Delete Translation Key')}</h3>
             </div>
             <p className="text-sm text-slate-600 mb-6 font-medium leading-relaxed">
               {t('Are you sure you want to delete')} "{allTranslations.find((item: any) => item.id === deletingTranslationId)?.key}"?
               <br /><br />
               {t('This removes it from the shared dictionary for every company. Any screen still using this key will show the raw key text until it is re-added.')}
             </p>
             <div className="flex justify-end gap-3 mt-6">
               <button
                 onClick={() => setDeletingTranslationId(null)}
                 className="px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-100 rounded-2xl transition"
               >
                 {t('Cancel')}
               </button>
               <button
                 onClick={handleConfirmDeleteTranslation}
                 className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white text-sm font-bold rounded-2xl transition shadow-sm"
               >
                 {t('Yes, Delete Key')}
               </button>
             </div>
           </div>
         </div>
       )}
     </div>
   );
 })()}

 {activeTab === 'database' && (
 <div className="space-y-6 animate-fade-in">
 <div>
 <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wide">{t('Database Portability & Backup')}</h3>
 <p className="text-[11px] text-slate-400 mt-0.5">{t('Export, import, or copy your entire database state to easily transfer configurations, profiles, and transactions to other testers or backup slots.')}</p>
 </div>

 <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100 space-y-6">
 
 {/* Export Card */}
 <div className="space-y-3">
 <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-2">
 <Download className="w-4 h-4 text-indigo-500" /> {t('Export Database')}
 </h4>
 <p className="text-xs text-slate-500 ">
 {t('Generate and download a JSON file containing all companies, users, settings, invoices, and transaction logs. This file can be shared with other users to restore your exact current system setup.')}
 </p>
 <div className="flex flex-wrap gap-2.5">
 <button
 onClick={handleExportDb}
 className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl text-xs font-bold transition flex items-center gap-2 cursor-pointer shadow-md shadow-indigo-600/10 animate-fade-in"
 >
 <Download className="w-4 h-4" /> {t('Download PostgreSQL Backup (.sql)')}
 </button>
 {db.currentUser?.isSuperAdmin && (
 <button
 onClick={handleDownloadSourceCode}
 disabled={downloadingZip}
 className="px-4 py-2.5 bg-amber-600 hover:bg-amber-500 text-white rounded-2xl text-xs font-bold transition flex items-center gap-2 cursor-pointer shadow-md shadow-amber-600/10 animate-fade-in disabled:opacity-50 disabled:cursor-not-allowed"
 >
 <Download className="w-4 h-4" /> {downloadingZip ? t('Zipping...') : t('Download Source Code ZIP')}
 </button>
 )}
 <button
 onClick={handleCopyToClipboard}
 className="px-4 py-2.5 bg-slate-200 hover:bg-slate-300 :bg-slate-700 text-slate-700 rounded-2xl text-xs font-bold transition flex items-center gap-2 cursor-pointer"
 >
 <Copy className="w-4 h-4" /> {copied ? t('Copied to Clipboard!') : t('Copy Database JSON String')}
 </button>
 <button
 onClick={handleForcePushToCloud}
 className="px-4 py-2.5 bg-amber-600 hover:bg-amber-500 text-white rounded-2xl text-xs font-bold transition flex items-center gap-2 cursor-pointer shadow-md shadow-amber-600/10"
 >
 <Upload className="w-4 h-4" /> {t('Force Publish Local to Cloud')}
 </button>
 </div>
 </div>

 <hr className="border-slate-200/40 " />

 {/* Import Card */}
 <div className="space-y-3">
 <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-2">
 <Upload className="w-4 h-4 text-indigo-500" /> {t('Import Database Setup')}
 </h4>
 <p className="text-xs text-slate-500 ">
 {t('Import an existing JSON backup to completely replace the active database setup in this browser. Warning: Importing a backup replaces all current transactions, companies, and user lists.')}
 </p>
 
 <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
 {/* File import element */}
 <div className="border border-slate-200 rounded-2xl p-5 bg-white flex flex-col items-center justify-center text-center gap-3">
 <div className="p-3 bg-indigo-50 rounded-2xl text-indigo-500">
 <Upload className="w-5 h-5" />
 </div>
 <div>
 <p className="text-xs font-bold text-slate-800 ">{t('Import .json / .xml File')}</p>
 <p className="text-[10px] text-slate-400 mt-0.5">{t('Select a database backup file to apply immediately')}</p>
 </div>
 <label className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl text-xs font-bold transition cursor-pointer select-none">
 <span>{t('Browse Backup File...')}</span>
 <input
 type="file"
 accept=".json,.xml"
 onChange={handleImportFile}
 className="hidden"
 />
 </label>
 </div>

 {/* Paste area */}
 <div className="border border-slate-200 rounded-2xl p-5 bg-white flex flex-col gap-3">
 <p className="text-xs font-bold text-slate-800 ">{t('Paste Database JSON String')}</p>
 <textarea
 placeholder={t('Paste raw JSON string here...')}
 value={pastedJson}
 onChange={(e) => setPastedJson(e.target.value)}
 className="w-full h-24 bg-slate-50 border border-slate-200 rounded-2xl p-2.5 text-[10px] text-slate-800 placeholder-slate-400 font-mono focus:outline-none focus:border-indigo-500"
 />
 <button
 onClick={handleImportPasted}
 disabled={!pastedJson.trim()}
 className="w-full bg-slate-800 hover:bg-slate-700 disabled:bg-slate-200 :bg-slate-800/50 disabled:text-slate-400 text-white rounded-2xl py-2 text-xs font-bold transition cursor-pointer flex items-center justify-center gap-1.5"
 >
 <Check className="w-3.5 h-3.5" /> {t('Apply Pasted Backup')}
 </button>
 </div>
 </div>
 </div>

 <hr className="border-slate-200/40 " />

 {/* Audit Logging & Purge Card */}
 <div className="space-y-4">
   <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
     <div>
       <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-2">
         <Database className="w-4 h-4 text-indigo-500" /> {t('System Audit Trails')}
       </h4>
       <p className="text-xs text-slate-500 mt-1">
         {t('Monitor and audit actions performed by users across all companies. Includes logins, creations, updates, and deletions.')}
       </p>
     </div>
     <button
       onClick={() => setIsConfirmingPurge(true)}
       className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-2xl text-xs font-bold transition flex items-center gap-2 cursor-pointer shadow-sm"
     >
       <Trash2 className="w-3.5 h-3.5 text-rose-400" /> {t('Purge Logs (> 1 Year)')}
     </button>
   </div>

   {/* Filter & Search Bar */}
   <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5 bg-white p-3 rounded-2xl border border-slate-100">
     <input
       type="text"
       placeholder={t('Search by user or details...')}
       value={auditSearch}
       onChange={(e) => setAuditSearch(e.target.value)}
       className="px-3 py-2 border border-slate-200 rounded-xl text-xs focus:outline-none focus:border-indigo-500"
     />
     <input
       type="text"
       placeholder={t('Filter by Action (e.g. LOGIN)')}
       value={auditActionFilter}
       onChange={(e) => setAuditActionFilter(e.target.value)}
       className="px-3 py-2 border border-slate-200 rounded-xl text-xs focus:outline-none focus:border-indigo-500"
     />
     <input
       type="text"
       placeholder={t('Filter by Entity (e.g. invoice)')}
       value={auditTypeFilter}
       onChange={(e) => setAuditTypeFilter(e.target.value)}
       className="px-3 py-2 border border-slate-200 rounded-xl text-xs focus:outline-none focus:border-indigo-500"
     />
     <button
       onClick={fetchAuditLogs}
       disabled={isLoadingAudit}
       className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-400 text-white rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer shadow-sm shadow-indigo-600/10"
     >
       <RefreshCw className={`w-3.5 h-3.5 ${isLoadingAudit ? 'animate-spin' : ''}`} />
       {isLoadingAudit ? t('Loading...') : t('Fetch Logs')}
     </button>
   </div>

   {/* Audit Table */}
   <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden max-h-[350px] overflow-y-auto shadow-sm">
     <table className="w-full text-start text-xs border-collapse">
       <thead>
         <tr className="bg-slate-50 border-b border-slate-200 text-[10px] font-bold text-slate-400 uppercase tracking-wider text-start">
           <th className="px-4 py-2.5 text-start font-bold">{t('Timestamp')}</th>
           <th className="px-4 py-2.5 text-start font-bold">{t('User')}</th>
           <th className="px-4 py-2.5 text-start font-bold">{t('Action')}</th>
           <th className="px-4 py-2.5 text-start font-bold">{t('Entity Type')}</th>
           <th className="px-4 py-2.5 text-start font-bold">{t('IP Address')}</th>
           <th className="px-4 py-2.5 text-start font-bold">{t('Details / Metadata')}</th>
         </tr>
       </thead>
       <tbody className="divide-y divide-slate-100 font-medium text-slate-600">
         {auditLogs.length > 0 ? (
           auditLogs.map((log) => (
             <tr key={log.id} className="hover:bg-slate-50/50 transition">
               <td className="px-4 py-2 whitespace-nowrap text-slate-400 text-[10px] font-mono">
                 {new Date(log.createdAt).toLocaleString()}
               </td>
               <td className="px-4 py-2 whitespace-nowrap font-bold text-slate-800">
                 {log.username}
               </td>
               <td className="px-4 py-2 whitespace-nowrap">
                 <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                   log.action.includes('FAILED') ? 'bg-rose-50 text-rose-600 border border-rose-100' :
                   log.action.includes('DELETE') ? 'bg-amber-50 text-amber-600 border border-amber-100' :
                   log.action.includes('PURGE') ? 'bg-purple-50 text-purple-600 border border-purple-100' :
                   'bg-emerald-50 text-emerald-600 border border-emerald-100'
                 }`}>
                   {log.action}
                 </span>
               </td>
               <td className="px-4 py-2 whitespace-nowrap font-mono text-[10px] text-slate-500">
                 {log.entityType}
               </td>
               <td className="px-4 py-2 whitespace-nowrap font-mono text-[10px] text-slate-400">
                 {log.ipAddress || '-'}
               </td>
               <td className="px-4 py-2 font-mono text-[10px] text-slate-500 break-all max-w-[300px] truncate" title={log.details}>
                 {log.details || '-'}
               </td>
             </tr>
           ))
         ) : (
           <tr>
             <td colSpan={6} className="px-4 py-8 text-center text-slate-400 font-medium">
               {t('No audit logs found. Click "Fetch Logs" to view or search the audit trail.')}
             </td>
           </tr>
         )}
       </tbody>
     </table>
   </div>
 </div>
 </div>
 </div>
 )}

 {activeTab === 'sessions' && (
 <div className="space-y-6 animate-fade-in">
 <div className="flex items-center justify-between">
 <div>
 <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wide">{t('Active Sessions')}</h3>
 <p className="text-[11px] text-slate-400 mt-0.5">{t('Everyone currently signed in')}{db.currentUser?.isSuperAdmin ? '' : ` — ${t('this company only')}`}. {t('Revoking a session signs that user out immediately on their next action.')}</p>
 </div>
 <button
 onClick={loadActiveSessions}
 disabled={sessionsLoading}
 className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl text-xs font-bold transition flex items-center gap-1.5 cursor-pointer shrink-0"
 >
 <RefreshCw className={`w-3.5 h-3.5 ${sessionsLoading ? 'animate-spin' : ''}`} />
 {t('Refresh')}
 </button>
 </div>

 <div className="border border-slate-100 rounded-2xl overflow-hidden shadow-sm">
 <table className="w-full text-xs">
 <thead>
 <tr className="bg-slate-50 text-slate-500">
 <th className="p-3 text-start">{t('User')}</th>
 {db.currentUser?.isSuperAdmin && <th className="p-3 text-start">{t('Company')}</th>}
 <th className="p-3 text-start">{t('Last Activity')}</th>
 <th className="p-3 text-start">{t('Expires')}</th>
 <th className="p-3 text-end">{t('Actions')}</th>
 </tr>
 </thead>
 <tbody>
 {sessionsLoading ? (
 <tr><td colSpan={5} className="p-6 text-center text-slate-400">{t('Loading...')}</td></tr>
 ) : activeSessions.length === 0 ? (
 <tr><td colSpan={5} className="p-6 text-center text-slate-400">{t('No active sessions found.')}</td></tr>
 ) : activeSessions.map((s) => (
 <tr key={s.sid} className="border-b border-slate-100 last:border-0">
 <td className="p-3 font-semibold text-slate-800">
 {s.username || t('Unknown')}
 {s.sid === currentSessionId && <span className="ms-1.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase bg-indigo-50 text-indigo-700 border border-indigo-200">{t('This device')}</span>}
 </td>
 {db.currentUser?.isSuperAdmin && <td className="p-3 text-slate-600">{s.companyName || '-'}</td>}
 <td className="p-3 text-slate-600 font-mono text-[10px]">{s.lastActivity ? new Date(s.lastActivity).toLocaleString() : '-'}</td>
 <td className="p-3 text-slate-600 font-mono text-[10px]">{s.expire ? new Date(s.expire).toLocaleString() : '-'}</td>
 <td className="p-3 text-end">
 {s.sid === currentSessionId ? (
 <span className="text-[10px] text-slate-400">{t('Use Sign Out instead')}</span>
 ) : (
 <button
 type="button"
 disabled={revokingSid === s.sid}
 onClick={() => handleRevokeSession(s.sid, s.username || t('Unknown'))}
 className="text-[10px] font-bold text-rose-600 hover:underline disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1"
 >
 <LogOut className="w-3 h-3" /> {revokingSid === s.sid ? t('Revoking...') : t('Revoke')}
 </button>
 )}
 </td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </div>
 )}

 {/* Purge Audit Logs Confirmation Modal */}
  {isConfirmingPurge && (
    <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex justify-center items-center p-4 overflow-y-auto animate-fade-in">
      <div className="bg-white rounded-2xl border border-slate-100 shadow-2xl p-6 w-full max-w-md">
        <div className="flex items-center gap-2 text-amber-600 mb-2">
          <AlertTriangle className="w-5 h-5 animate-pulse" />
          <h3 className="text-lg font-bold">{t('Purge Old Audit Logs')}</h3>
        </div>
        <p className="text-sm text-slate-600 mb-6 font-medium leading-relaxed">
          {t('Are you sure you want to purge all system audit logs older than')} <strong>{t('1 year')}</strong>?
          <br /><br />
          {t('This action will permanently delete historical user logs while safely retaining the most recent 365 days of data to prevent database bloat. This action is irreversible.')}
        </p>
        <div className="flex justify-end gap-3 mt-6">
          <button
            onClick={() => setIsConfirmingPurge(false)}
            className="px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-100 rounded-2xl transition cursor-pointer"
          >
            {t('Cancel')}
          </button>
          <button
            onClick={handlePurgeAuditLogs}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-sm font-bold rounded-2xl transition shadow-sm cursor-pointer"
          >
            {t('Yes, Purge Old Logs')}
          </button>
        </div>
      </div>
    </div>
  )}

 {/* Delete User Confirmation Modal */}
 {confirmDeleteUserId && (
 <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex justify-center items-center p-4 overflow-y-auto">
 <div className="bg-white rounded-2xl border border-slate-100 shadow-2xl p-6 w-full max-w-sm my-auto">
 <div className="flex items-center gap-2 text-rose-600 mb-2">
 <AlertTriangle className="w-5 h-5" />
 <h3 className="text-lg font-bold">{t('Delete User Account')}</h3>
 </div>
 <p className="text-sm text-slate-600 mb-6 font-medium leading-relaxed">
 {t('Are you sure you want to permanently delete user')} "{db.users.find(u => u.id === confirmDeleteUserId)?.username}"?
 <br /><br />
 {t('This action cannot be undone.')}
 </p>
 <div className="flex justify-end gap-3 mt-6">
 <button
 onClick={() => setConfirmDeleteUserId(null)}
 className="px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-100 rounded-2xl transition cursor-pointer"
 >
 {t('Cancel')}
 </button>
 <button
 onClick={executeDeleteUser}
 className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white text-sm font-bold rounded-2xl transition shadow-sm cursor-pointer"
 >
 {t('Yes, Delete User')}
 </button>
 </div>
 </div>
 </div>
 )}

 {/* Delete Company & All Data Modal — the single most destructive action in this app,
     so a plain Confirm click isn't enough: the admin must type the company's exact
     name. Only ever reachable for a company already marked Cancelled (see the
     Registration row above); the server refuses otherwise too, as a second gate. */}
 {deletingCompany && (
 <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex justify-center items-center p-4 overflow-y-auto">
 <div className="bg-white rounded-2xl border border-slate-100 shadow-2xl p-6 w-full max-w-md my-auto">
 <div className="flex items-center gap-2 text-rose-600 mb-2">
 <AlertTriangle className="w-5 h-5" />
 <h3 className="text-lg font-bold">{t('Delete Company & All Data')}</h3>
 </div>
 <p className="text-sm text-slate-600 mb-4 font-medium leading-relaxed">
 {t('This permanently deletes')} <strong className="text-slate-900">"{deletingCompany.name}"</strong> {t('and every invoice, customer, product, user, and record belonging to it — across the entire system. This cannot be undone.')}
 </p>
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
 {t('Type the company name to confirm:')} <span className="font-mono text-slate-600 normal-case">{deletingCompany.name}</span>
 </label>
 <input
 type="text"
 autoFocus
 value={deleteCompanyConfirmText}
 onChange={(e) => setDeleteCompanyConfirmText(e.target.value)}
 className="w-full mt-1 bg-white border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-1 focus:ring-rose-500"
 />
 <div className="flex justify-end gap-3 mt-6">
 <button
 onClick={() => { setDeletingCompany(null); setDeleteCompanyConfirmText(''); }}
 className="px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-100 rounded-2xl transition cursor-pointer"
 >
 {t('Cancel')}
 </button>
 <button
 disabled={deleteCompanyConfirmText !== deletingCompany.name}
 onClick={handleConfirmDeleteCompany}
 className="px-4 py-2 bg-rose-600 hover:bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold rounded-2xl transition shadow-sm cursor-pointer"
 >
 {t('Permanently Delete')}
 </button>
 </div>
 </div>
 </div>
 )}

 {/* Month Closing Modal */}
 {isClosingMonth && (
 <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex justify-center items-center p-4 overflow-y-auto">
 <div className="bg-white rounded-2xl border border-slate-100 shadow-2xl p-6 w-full max-w-lg my-auto">
 <div className="flex items-center gap-2 text-rose-600 mb-2">
 <AlertTriangle className="w-5 h-5" />
 <h3 className="font-bold text-base">{t('Close Month & Lock Period:')} {translateMonthLabel(isClosingMonth.name, t)}</h3>
 </div>
 <p className="text-xs text-slate-500 mb-4">
 {t('Closing a fiscal month is permanent. Once closed, you will not be able to create, edit, or delete any transactions within this period.')}
 </p>

 {/* P&L calculation results */}
 <div className="bg-slate-50 border border-slate-100 p-4 rounded-2xl mb-4 space-y-3">
 <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">{t('Month-End P&L Summary Report')}</h4>

 <div className="grid grid-cols-2 gap-4">
 <div className="p-3 bg-white border border-slate-200/60 rounded-2xl text-xs">
 <p className="font-bold text-slate-800">{t('Option A (Paid Basis)')}</p>
 <p className="text-[10px] text-slate-400 mt-0.5">{t('Based on settled payments only')}</p>
 <div className="mt-2 space-y-1">
 <div className="flex justify-between">
 <span>{t('Total Rev:')}</span>
 <span className="font-medium text-emerald-600">{currencySymbol} {calculateMonthPnL(db, isClosingMonth.id).paid.revenue.toFixed(2)}</span>
 </div>
 <div className="flex justify-between">
 <span>{t('Total Exp:')}</span>
 <span className="font-medium text-rose-600">{currencySymbol} {calculateMonthPnL(db, isClosingMonth.id).paid.expenses.toFixed(2)}</span>
 </div>
 <div className="flex justify-between font-bold border-t border-slate-100 pt-1 mt-1">
 <span>{t('Net P&L:')}</span>
 <span className={calculateMonthPnL(db, isClosingMonth.id).paid.net >= 0 ? 'text-emerald-700' : 'text-rose-700'}>
 {currencySymbol} {calculateMonthPnL(db, isClosingMonth.id).paid.net.toFixed(2)}
 </span>
 </div>
 </div>
 </div>

 <div className="p-3 bg-white border border-slate-200/60 rounded-2xl text-xs">
 <p className="font-bold text-slate-800">{t('Option B (Including Pending)')}</p>
 <p className="text-[10px] text-slate-400 mt-0.5">{t('Includes outstanding receivables/payables')}</p>
 <div className="mt-2 space-y-1">
 <div className="flex justify-between">
 <span>{t('Total Rev:')}</span>
 <span className="font-medium text-emerald-600">{currencySymbol} {calculateMonthPnL(db, isClosingMonth.id).includingPending.revenue.toFixed(2)}</span>
 </div>
 <div className="flex justify-between">
 <span>{t('Total Exp:')}</span>
 <span className="font-medium text-rose-600">{currencySymbol} {calculateMonthPnL(db, isClosingMonth.id).includingPending.expenses.toFixed(2)}</span>
 </div>
 <div className="flex justify-between font-bold border-t border-slate-100 pt-1 mt-1">
 <span>{t('Net P&L:')}</span>
 <span className={calculateMonthPnL(db, isClosingMonth.id).includingPending.net >= 0 ? 'text-emerald-700' : 'text-rose-700'}>
 {currencySymbol} {calculateMonthPnL(db, isClosingMonth.id).includingPending.net.toFixed(2)}
 </span>
 </div>
 </div>
 </div>
 </div>
 </div>

 {/* Selection */}
 <div className="space-y-2 mb-6">
 <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">{t('Select P&L View to Finalize Ledger')}</label>
 <div className="space-y-2">
 <label className="flex items-start gap-2 p-2.5 bg-slate-50 border border-slate-100 rounded-2xl hover:bg-slate-100/40 cursor-pointer">
 <input
 type="radio"
 name="closeOption"
 checked={closeOption === 'paid_only'}
 onChange={() => setCloseOption('paid_only')}
 className="mt-0.5 text-indigo-600"
 />
 <div>
 <p className="text-xs font-bold text-slate-800">{t('Finalize on Option A (Paid Basis)')}</p>
 <p className="text-[10px] text-slate-500">{t('Net Profit of')} {currencySymbol} {calculateMonthPnL(db, isClosingMonth.id).paid.net.toFixed(2)} {t('will be permanently archived.')}</p>
 </div>
 </label>

 <label className="flex items-start gap-2 p-2.5 bg-slate-50 border border-slate-100 rounded-2xl hover:bg-slate-100/40 cursor-pointer">
 <input
 type="radio"
 name="closeOption"
 checked={closeOption === 'including_pending'}
 onChange={() => setCloseOption('including_pending')}
 className="mt-0.5 text-indigo-600"
 />
 <div>
 <p className="text-xs font-bold text-slate-800">{t('Finalize on Option B (Including Pending)')}</p>
 <p className="text-[10px] text-slate-500">{t('Net Profit of')} {currencySymbol} {calculateMonthPnL(db, isClosingMonth.id).includingPending.net.toFixed(2)} {t('will be permanently archived.')}</p>
 </div>
 </label>
 </div>
 </div>

 <div className="flex justify-end gap-2.5">
 <button
 onClick={() => setIsClosingMonth(null)}
 className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-500 rounded-lg text-xs font-semibold transition"
 >
 {t('Cancel')}
 </button>
 <button
 onClick={handleConfirmClose}
 className="px-4 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold transition shadow-sm"
 >
 {t('Permanently Lock Month')}
 </button>
 </div>
 </div>
 </div>
 )}

 {/* PREVIEW TEMPLATE MODAL */}
 {previewTemplate && (
  <DocumentRenderer
   documentType="Invoice"
   data={TEMPLATE_PREVIEW_SAMPLE_INVOICE}
   companySetup={(db.companySetup || { id: db.selectedCompanyId || 'company-1', name: 'Current Organization', currency: 'SAR', vatNumber: '300123456700003' }) as any}
   templates={[previewTemplate]}
   taxSlabs={db.taxSlabs}
   db={db}
   onClose={() => setPreviewTemplate(null)}
  />
 )}

 </div>
 </div>
 </div>
 );
}
