import React from 'react';
import { useTranslation } from '../hooks';
import { DatabaseState, saveDatabase, openNewMonth, closeMonth, SEED_BANKS, SEED_TAX_SLABS, SEED_TEMPLATES, getBankBalance, checkRecurringPreconditions, calculateMonthPnL, SEED_USERS, saveInvestor, saveCapitalInvestment, generateId } from '../dbStore';
import { CompanySetup, BankAccount, TaxSlab, DocumentTemplate, FiscalMonth, User, UserRole, Investor, Customer, Vendor, Role } from '../types';
import { THEME_PROFILES, applyTheme } from '../theme';
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
 Shield} from 'lucide-react';
import { ensureCompatibleImage } from '../imageUtils';
import { XMLParser } from 'fast-xml-parser';
import DocumentRenderer from './DocumentRenderer';
import ZatcaOnboardingWizard from './ZatcaOnboardingWizard';


interface PermissionNode {
  id: string;
  label: string;
  permissionPath?: string;
  children?: PermissionNode[];
}

const permissionTreeSchema: PermissionNode[] = [
  {
    id: 'all',
    label: 'All Permissions',
    children: [
      {
        id: 'modules.pos',
        label: 'POS',
        children: [
          { id: 'modules.pos.access', label: 'Main POS Access', permissionPath: 'pos.access.enabled' },
          { id: 'modules.pos.terminal', label: 'Terminal Counter Access', permissionPath: 'pos.terminal.enabled' },
          { id: 'modules.pos.shifts', label: 'Shifts & Z-Reports Management', permissionPath: 'pos.shifts.enabled' },
          { id: 'modules.pos.history', label: 'POS Sales History Access', permissionPath: 'pos.history.enabled' },
          { id: 'modules.pos.return', label: 'Allow POS Refunds & Returns', permissionPath: 'pos.return.enabled' },
          { id: 'modules.pos.cancel', label: 'Allow POS Order Cancellations', permissionPath: 'pos.cancel.enabled' },
          { id: 'modules.pos.discount', label: 'Allow POS Custom Discounts', permissionPath: 'pos.discount.enabled' }
        ]
      },
      {
        id: 'modules.sales',
        label: 'Sales & Receivable',
        children: [
          {
            id: 'modules.sales.quotation',
            label: 'Quotation Book Access',
            children: [
              { id: 'modules.sales.quotation.view', label: 'View Quotation Book', permissionPath: 'quotation.view.enabled' },
              { id: 'modules.sales.quotation.create', label: 'Create Quotations', permissionPath: 'quotation.create.enabled' },
            ]
          },
          {
            id: 'modules.sales.invoice',
            label: 'Sales Invoices Access',
            children: [
              { id: 'modules.sales.invoice.view', label: 'View Sales Invoices', permissionPath: 'invoice.view.enabled' },
              { id: 'modules.sales.invoice.create', label: 'Create Sales Invoices', permissionPath: 'invoice.create.enabled' },
            ]
          }
        ]
      },
      {
        id: 'modules.procurements',
        label: 'Procurements',
        children: [
          {
            id: 'modules.procurements.expense',
            label: 'Expense & Vouchers Module',
            children: [
              { id: 'modules.procurements.expense.view', label: 'View Expenses', permissionPath: 'expense.view.enabled' },
              { id: 'modules.procurements.expense.create', label: 'Create Expenses', permissionPath: 'expense.create.enabled' },
            ]
          }
        ]
      },
      {
        id: 'modules.inventory',
        label: 'Inventory & Procurement',
        children: [
          { id: 'modules.inventory.access', label: 'Inventory Module Access', permissionPath: 'inventory.access.enabled' },
          { id: 'modules.inventory.pr', label: 'Purchase Requisitions (PR) Access', permissionPath: 'inventory.pr.enabled' },
          { id: 'modules.inventory.po', label: 'Purchase Orders (PO) Access', permissionPath: 'inventory.po.enabled' },
          { id: 'modules.inventory.grn', label: 'Goods Received Notes (GRN) Access', permissionPath: 'inventory.grn.enabled' },
          { id: 'modules.inventory.stock', label: 'Stock Registry & Adjustments Access', permissionPath: 'inventory.stock.enabled' }
        ]
      },
      {
        id: 'modules.master_registries',
        label: 'Master Registries',
        children: [
          {
            id: 'directories.customers',
            label: 'Customer Directory Access',
            children: [
              { id: 'directories.customers.view', label: 'View Customers CRM', permissionPath: 'customers.view.enabled' },
              { id: 'directories.customers.edit', label: 'Edit Customers CRM', permissionPath: 'customers.edit.enabled' },
            ]
          },
          {
            id: 'directories.vendors',
            label: 'Vendor Directory Access',
            children: [
              { id: 'directories.vendors.view', label: 'View Vendors Directory', permissionPath: 'vendors.view.enabled' },
              { id: 'directories.vendors.edit', label: 'Edit Vendors Directory', permissionPath: 'vendors.edit.enabled' },
            ]
          },
          {
            id: 'directories.products',
            label: 'Products & Inventory Access',
            children: [
              { id: 'directories.products.view', label: 'View Products & Pricing', permissionPath: 'products.view.enabled' },
              { id: 'directories.products.edit', label: 'Edit Products & Stock', permissionPath: 'products.edit.enabled' },
            ]
          }
        ]
      },
      {
        id: 'modules.reports',
        label: 'Financial Reports',
        children: [
          { id: 'modules.reports.access', label: 'Financial Reports Access', permissionPath: 'reports.access.enabled' }
        ]
      },
      {
        id: 'modules.financial_config',
        label: 'Financial Configuration',
        children: [
          { id: 'modules.financial_config.investors', label: 'Investors & Capital Access', permissionPath: 'investors.access.enabled' },
          { id: 'modules.financial_config.fiscal_months', label: 'Fiscal Month Close/Open Access', permissionPath: 'fiscalMonths.access.enabled' },
          {
            id: 'modules.financial_config.banks',
            label: 'Bank Accounts Access',
            children: [
              { id: 'modules.financial_config.banks.view', label: 'View Bank Accounts', permissionPath: 'banks.view.enabled' },
              { id: 'modules.financial_config.banks.edit', label: 'Edit Bank Accounts & Transfers', permissionPath: 'banks.edit.enabled' },
            ]
          },
          {
            id: 'modules.financial_config.tax_slabs',
            label: 'Tax Slabs Access',
            children: [
              { id: 'modules.financial_config.tax_slabs.view', label: 'View Tax Slabs', permissionPath: 'taxSlabs.view.enabled' },
              { id: 'modules.financial_config.tax_slabs.edit', label: 'Edit Tax Slabs', permissionPath: 'taxSlabs.edit.enabled' },
            ]
          }
        ]
      },
      {
        id: 'modules.settings',
        label: 'Settings & Companies',
        children: [
          { id: 'void_cancel.cancel', label: 'Document Cancellation', permissionPath: 'cancel.access.enabled' }
        ]
      }
    ]
  }
];

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
      if (n.permissionPath === 'cancel.access.enabled') {
        updated.cancel = checked;
      }
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
function PermissionTree({ permissions, onChange }: { permissions: any; onChange: (updated: any) => void }) {
  const [expandedNodes, setExpandedNodes] = React.useState<Record<string, boolean>>({
    all: true,
    modules: true,
    directories: true,
    void_cancel: true
  });

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
            {node.label}
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
          <p className="text-[10px] font-extrabold text-slate-800 uppercase tracking-wider">Permissions Tree</p>
          <p className="text-[9px] text-slate-500">Configure cascading module & directory usecases</p>
        </div>
        <button
          type="button"
          onClick={() => setExpandedNodes({ all: true, modules: true, directories: true, void_cancel: true })}
          className="text-[9px] font-bold text-indigo-600 hover:text-indigo-800 uppercase cursor-pointer"
        >
          Expand All
        </button>
      </div>
      <div className="pt-1 px-1 space-y-1">
        {permissionTreeSchema.map((node) => (
          <TreeNode key={node.id} node={node} depth={0} />
        ))}
      </div>
    </div>
  );
}

const CATEGORY_GROUPS = [
  {
    id: 'org',
    label: 'Organization & Setup',
    icon: Building,
    subTabs: [
      { id: 'companies', label: 'Companies Directory', icon: Building, superAdminOnly: true },
      { id: 'company', label: 'Company Profile', icon: Settings },
      { id: 'zatca', label: 'ZATCA Phase 2 E-Invoicing', icon: ShieldCheck },
      { id: 'banks', label: 'Bank Accounts', icon: Wallet },
      { id: 'taxes', label: 'Tax Slabs', icon: Percent },
    ]
  },
  {
    id: 'ops',
    label: 'Operations & Config',
    icon: Sliders,
    subTabs: [
      { id: 'templates', label: 'Document Templates', icon: FileSpreadsheet },
      { id: 'pos', label: 'POS Terminal Settings', icon: ShoppingCart },
      { id: 'translations', label: 'Translations', icon: Languages, superAdminOnly: true },
    ]
  },
  {
    id: 'governance',
    label: 'Governance & Staff',
    icon: UserCheck,
    subTabs: [
      { id: 'users', label: 'Staff Permissions', icon: UserCheck },
      { id: 'roles', label: 'Roles', icon: Shield },
    ]
  },
  {
    id: 'ledger',
    label: 'Fiscal & Capital',
    icon: Calendar,
    subTabs: [
      { id: 'months', label: 'Month Opening / Closing', icon: Calendar },
      { id: 'equity', label: 'Capital & Equity', icon: Coins },
    ]
  },
  {
    id: 'data',
    label: 'System & Backup',
    icon: Database,
    subTabs: [
      { id: 'database', label: 'Database Backup & Sync', icon: Database },
    ]
  }
];

interface AdminSettingsProps {
 db: DatabaseState;
 onUpdateDb: (db: DatabaseState) => void;
 onRefreshDb?: () => Promise<void>;
 defaultTab?: 'company' | 'banks' | 'taxes' | 'templates' | 'months' | 'users' | 'roles' | 'equity' | 'companies' | 'database' | 'zatca';
}

export default function AdminSettings({ db, onUpdateDb, onRefreshDb, defaultTab }: AdminSettingsProps) {
 const { t } = useTranslation(db);
 const [activeTab, setActiveTab] = React.useState<'company' | 'banks' | 'taxes' | 'templates' | 'months' | 'users' | 'roles' | 'equity' | 'companies' | 'database' | 'translations' | 'pos' | 'zatca'>(defaultTab || 'company');
 const [useSleekLayout, setUseSleekLayout] = React.useState<boolean>(true);
 const activeCatGroup = CATEGORY_GROUPS.find(cat => cat.subTabs.some(st => st.id === activeTab)) || CATEGORY_GROUPS[0];
 const [previewTemplate, setPreviewTemplate] = React.useState<DocumentTemplate | null>(null);

  const [fiscalMonths, setFiscalMonths] = React.useState<any[]>([]);
  const fetchMonths = async () => {
    if (!db.selectedCompanyId) return;
    try {
      const resp = await fetch(`/api/transactions/months?companyId=${db.selectedCompanyId}`);
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
        const otherMonths = (db.months || []).filter(m => m.companyId !== db.selectedCompanyId);
        onUpdateDb({
          ...db,
          months: [...otherMonths, ...data]
        });
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
 const [isConfirmingTruncate, setIsConfirmingTruncate] = React.useState(false);

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
 const [isTranslating, setIsTranslating] = React.useState<boolean>(false);

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
 try {
  triggerSuccess('Successfully published local database to Cloud!');
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

 const handleTruncateTransactions = async () => {
 const activeCompanyIdId = db.selectedCompanyId;
 const activeCompanyIdName = db.companies?.find(c => c.id === activeCompanyIdId)?.name || 'Selected Company';
 
 try {
 const updated: DatabaseState = {
 ...db,
 quotations: (db.quotations || []).filter(q => q.companyId !== activeCompanyIdId),
 invoices: (db.invoices || []).filter(i => i.companyId !== activeCompanyIdId),
 expenses: (db.expenses || []).filter(e => e.companyId !== activeCompanyIdId),
 recurringPostings: (db.recurringPostings || []).filter(p => p.companyId !== activeCompanyIdId),
 vouchers: (db.vouchers || []).filter(v => v.companyId !== activeCompanyIdId),
 };

 if (updated.companies) {
 updated.companies = updated.companies.map(c => {
 if (c.id === activeCompanyIdId) {
 return {
 ...c,
 counters: {
 quotation: 1001,
 invoice: 1001,
 expense: 1001,
 voucher: 1001
 }
 };
 }
 return c;
 });
 }
 
 if (updated.companySetup && updated.companySetup.id === activeCompanyIdId) {
 updated.companySetup = {
 ...updated.companySetup,
 counters: {
 quotation: 1001,
 invoice: 1001,
 expense: 1001,
 voucher: 1001
 }
 };
 }

 
 onUpdateDb(updated);
  
 triggerSuccess(`All transaction data for ${activeCompanyIdName} has been successfully truncated and synchronized!`);
 } catch (err: any) {
 triggerError(`Failed to truncate transaction data: ${err.message}`);
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

 const handleAddCompany = (e: React.FormEvent) => {
 e.preventDefault();
 if (!newCompany.name.trim()) return triggerError('Company name is required.');
 
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

 // Auto-create standard resources for the new organization so that it's instantly operational
 const newBank: BankAccount = {
 id: 'bank-' + generateId(),
 bankName: 'Main Operating Bank',
 accountNumber: 'SA' + Math.floor(1000000000000000000000 + Math.random() * 9000000000000000000000).toString(),
 accountTitle: `${finalizedCompany.name} Operating Account`,
 openingBalance: 0,
 isActive: true,
 isDefault: true,
 companyId: finalizedCompany.id
 };

 const newCustomer: Customer = {
 id: 'cust-walkin-' + generateId(),
 name: 'Walk-in Customer',
 phone: '-',
 email: '-',
 address: '-',
 isSystem: true,
 companyId: finalizedCompany.id
 };

 const newVendor: Vendor = {
 id: 'vend-cash-' + generateId(),
 name: 'Cash Vendor',
 phone: '-',
 email: '-',
 address: '-',
 isSystem: true,
 companyId: finalizedCompany.id
 };

 const newTemplate: DocumentTemplate = {
 id: 'tmpl-' + generateId(),
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

 const newMonths: FiscalMonth[] = [
 { id: '2026-05', name: 'May 2026', status: 'Closed', closedAt: '2026-05-31T18:00:00Z', closedOption: 'paid_only', closedPnL: { totalRevenue: 0, totalExpenses: 0, netProfit: 0 }, companyId: finalizedCompany.id },
 { id: '2026-06', name: 'June 2026', status: 'Open', companyId: finalizedCompany.id }
 ];

 // Merge into the global database
 const updatedDb: DatabaseState = {
 ...db,
 companies: [...(db.companies || []), finalizedCompany],
 banks: [...db.banks, newBank],
 customers: [...db.customers, newCustomer],
 vendors: [...db.vendors, newVendor],
 templates: [...db.templates, newTemplate],
 months: [...db.months, ...newMonths]
 };

 // Save and update
 
 onUpdateDb(updatedDb);
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

 const handleToggleCompanyInventory = (companyId: string, enabled: boolean) => {
   const updatedCompanies = (db.companies || []).map(c => {
     if (c.id === companyId) {
       return {
         ...c,
         isInventoryModuleEnabled: enabled,
         inventorySettings: c.inventorySettings || { prOptionality: 'OPTIONAL', isDsdAllowed: true }
       };
     }
     return c;
   });

   let updatedCompanySetup = db.companySetup;
   if (db.selectedCompanyId === companyId) {
     updatedCompanySetup = {
       ...db.companySetup,
       isInventoryModuleEnabled: enabled,
       inventorySettings: db.companySetup?.inventorySettings || { prOptionality: 'OPTIONAL', isDsdAllowed: true }
     };
   }

   const updatedDb = {
     ...db,
     companies: updatedCompanies,
     companySetup: updatedCompanySetup
   };

   onUpdateDb(updatedDb);
   triggerSuccess(`Successfully ${enabled ? 'enabled' : 'disabled'} Inventory & Procurement Module for organization.`);
 };

 // ----------------------------------------
 // SUB-TAB: COMPANY SETUP
 // ----------------------------------------
 const [companyForm, setCompanyForm] = React.useState<CompanySetup>({ ...db.companySetup });
 const [isDragging, setIsDragging] = React.useState(false);

 React.useEffect(() => {
 setCompanyForm({ ...db.companySetup });
 }, [db.companySetup]);

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

 const handleCompanySave = (e: React.FormEvent) => {
 e.preventDefault();
 if (!companyForm.name.trim()) return triggerError('Company name is required.');
 
 // Process the logo to ensure if it is BMP base64 or raw base64, it is converted to highly compatible PNG base64
 const finalLogoUrl = ensureCompatibleImage(companyForm.logoUrl);

 const updatedForm = { ...companyForm, logoUrl: finalLogoUrl };
 const updatedCompanies = db.companies?.map(c => c.id === updatedForm.id ? updatedForm : c) || [updatedForm];
 const updated = { ...db, companySetup: updatedForm, companies: updatedCompanies };
 setCompanyForm(updatedForm); // Update local form state with processed/optimized base64
 
 onUpdateDb(updated);
 triggerSuccess('Company global configuration updated successfully.');
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

 const handleAddBank = (e: React.FormEvent) => {
 e.preventDefault();
 if (!bankForm.bankName.trim()) return triggerError('Bank name is required.');
 if (!bankForm.accountNumber.trim()) return triggerError('Account number is required.');
 if (!bankForm.accountTitle.trim()) return triggerError('Account title is required.');

 let newBanks = [...db.banks];

 if (editingBankId) {
 newBanks = newBanks.map(b => {
 if (b.id === editingBankId) {
 return {
 ...b,
 bankName: bankForm.bankName,
 accountTitle: bankForm.accountTitle,
 accountNumber: bankForm.accountNumber,
 openingBalance: bankForm.openingBalance,
 isDefault: bankForm.isDefault
 };
 }
 return b;
 });

 if (bankForm.isDefault) {
 newBanks.forEach(b => {
 if (b.id !== editingBankId) {
 b.isDefault = false;
 }
 });
 }

 const updated = { ...db, banks: newBanks };
 
 onUpdateDb(updated);
 triggerSuccess(`Bank "${bankForm.bankName}" updated successfully.`);
 setEditingBankId(null);
 } else {
 const newBank: BankAccount = {
 ...bankForm,
 id: generateId(),
 companyId: db.selectedCompanyId
 };

 if (newBank.isDefault) {
 // Unset previous defaults
 newBanks.forEach(b => b.isDefault = false);
 }
 newBanks.push(newBank);

 // If this is the only active bank, make it default
 const activeBanks = newBanks.filter(b => b.isActive);
 if (activeBanks.length === 1) {
 newBanks.forEach(b => b.isDefault = (b.id === activeBanks[0].id));
 }

 const updated = { ...db, banks: newBanks };
 
 onUpdateDb(updated);
 triggerSuccess(`Bank "${newBank.bankName}" added successfully.`);
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

 const handleSetDefaultBank = (bankId: string) => {
 const newBanks = db.banks.map(b => ({
 ...b,
 isDefault: b.id === bankId
 }));
 const updated = { ...db, banks: newBanks };
 
 onUpdateDb(updated);
 triggerSuccess('Default bank updated successfully.');
 };

 const handleToggleBankActive = (bankId: string) => {
 const bank = db.banks.find(b => b.id === bankId);
 if (!bank) return;
 if (bank.isDefault && bank.isActive) {
 return triggerError('Cannot deactivate the Default Bank. Set another bank as default first.');
 }

 const newBanks = db.banks.map(b => {
 if (b.id === bankId) {
 return { ...b, isActive: !b.isActive };
 }
 return b;
 });

 const updated = { ...db, banks: newBanks };
 
 onUpdateDb(updated);
 triggerSuccess('Bank active status toggled.');
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
 percentage: ''
 });

 const handleAddTax = (e: React.FormEvent) => {
 e.preventDefault();
 if (!taxForm.name.trim()) return triggerError('Tax slab name is required.');
 const pct = parseFloat(taxForm.percentage);
 if (isNaN(pct) || pct < 0 || pct > 100) return triggerError('Percentage must be a number between 0 and 100.');

 const newSlab: TaxSlab = {
 id: generateId(),
 name: taxForm.name,
 percentage: pct
 };

 const updated = { ...db, taxSlabs: [...db.taxSlabs, newSlab] };
 
 onUpdateDb(updated);
 triggerSuccess(`Tax slab "${newSlab.name}" added successfully.`);
 setTaxForm({ name: '', percentage: '' });
 };

 // ----------------------------------------
 // SUB-TAB: TEMPLATES
 // ----------------------------------------
 const [tmplForm, setTmplForm] = React.useState({
 name: '',
 language: 'English' as 'English' | 'Arabic' | 'Urdu',
 pageSize: '8.27in x 11.69in (A4)'
 });

 const handleAddTemplate = (e: React.FormEvent) => {
 e.preventDefault();
 if (!tmplForm.name.trim()) return triggerError('Template name is required.');

 const newTmpl: DocumentTemplate = {
 id: generateId(),
 name: tmplForm.name,
 language: tmplForm.language,
 pageSize: tmplForm.pageSize,
 isActive: false,
 printHeader: true,
 printFooter: true,
 printLogo: true,
 printQrCode: true,
 companyId: db.selectedCompanyId || undefined
 };

 const updated = { ...db, templates: [...db.templates, newTmpl] };
 
 onUpdateDb(updated);
 triggerSuccess(`Template "${newTmpl.name}" registered. Activate it below.`);
 setTmplForm({ name: '', language: 'English', pageSize: '8.27in x 11.69in (A4)' });
 };

 const handleActivateTemplate = (tmplId: string) => {
 const targetTmpl = db.templates.find(t => t.id === tmplId);
 if (!targetTmpl) return;

 const targetCompanyId = targetTmpl.companyId || db.selectedCompanyId;
 const targetLanguage = targetTmpl.language;

 const newTemplates = db.templates.map(t => {
 if (t.id === tmplId) {
 return { ...t, isActive: true, companyId: targetCompanyId };
 }
 const isSameCompany = (t.companyId || db.selectedCompanyId) === targetCompanyId;
 const isSameLanguage = t.language === targetLanguage;
 if (isSameCompany && isSameLanguage) {
 return { ...t, isActive: false };
 }
 return t;
 });
 const updated = { ...db, templates: newTemplates };
 
 onUpdateDb(updated);
 triggerSuccess('Document layout template activated.');
 };

 const handleToggleOption = (tmplId: string, option: 'printHeader' | 'printFooter' | 'printLogo' | 'printQrCode') => {
 const updatedTemplates = db.templates.map(t => {
 if (t.id === tmplId) {
 return {
 ...t,
 companyId: t.companyId || db.selectedCompanyId,
 [option]: t[option] !== false ? false : true
 };
 }
 return t;
 });
 const updated = { ...db, templates: updatedTemplates };
 
 onUpdateDb(updated);
 triggerSuccess('Template print preference updated.');
  };

 const handleUpdateTemplateProperty = (tmplId: string, propKey: string, val: any) => {
   const updatedTemplates = db.templates.map(t => {
     if (t.id === tmplId) {
       return {
         ...t,
         companyId: t.companyId || db.selectedCompanyId,
         [propKey]: val
       };
     }
     return t;
   });
   const updated = { ...db, templates: updatedTemplates };
   onUpdateDb(updated);
   triggerSuccess('Template option updated.');
 };

  // ----------------------------------------
  // CUSTOM VISUAL 'CANVAS' TEMPLATE DESIGNER
  // ----------------------------------------
  const DEFAULT_LAYOUT = [
    { id: 'logo', title: 'Company Logo', w: 4, visible: true, props: { align: 'left' } },
    { id: 'company_details', title: 'Company Details', w: 8, visible: true, props: { showVat: true, showAddress: true, showContact: true, showBank: true, isBilingual: true } },
    { id: 'doc_details', title: 'Document Metadata', w: 12, visible: true, props: { isBilingual: true, showDocNumber: true, showDate: true, showDueDate: true, showPaymentStatus: true, showOriginQ: true, showTRN: true, showCreatedBy: true } },
    { id: 'customer_info', title: 'Customer Info', w: 12, visible: true, props: { isBilingual: true, showName: true, showContact: true, showAddress: true, showVatNumber: true, borderStyle: 'solid' } },
    { id: 'custom_header', title: 'Custom Header text', w: 12, visible: true, props: { isBilingual: true } },
    { id: 'items_table', title: 'Items Table', w: 12, visible: true, props: { isBilingual: true, showSNo: true, showItemCode: true, showDescription: true, showQty: true, showUnitCost: true, showDiscount: true, showTotal: true, borderStyle: 'stripe' } },
    { id: 'notes', title: 'Notes block', w: 6, visible: true, props: { isBilingual: true } },
    { id: 'qr_code', title: 'ZATCA QR Code', w: 2, visible: true, props: { align: 'center', size: 'medium', isBilingual: true } },
    { id: 'totals_summary', title: 'Total Summary', w: 4, visible: true, props: { isBilingual: true, showSubtotal: true, showDiscount: true, showNetSubtotal: true, showVat: true, showGrandTotal: true, showGrandTotalWords: true, accentColor: 'indigo' } },
    { id: 'custom_footer', title: 'Custom Footer text', w: 12, visible: true, props: { isBilingual: true } }
  ];

  const [designingTemplateId, setDesigningTemplateId] = React.useState<string | null>(null);
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
    setSelectedBlockId(null);
  };

  const handleSaveCanvasLayout = () => {
    if (!designingTemplateId) return;
    const updatedTemplates = db.templates.map(t => {
      if (t.id === designingTemplateId) {
        return {
          ...t,
          layoutJson: JSON.stringify(canvasBlocks)
        };
      }
      return t;
    });
    const updated = { ...db, templates: updatedTemplates };
    onUpdateDb(updated);
    triggerSuccess('Canvas layout configuration saved successfully.');
    setDesigningTemplateId(null);
  };

  const handleResetLayout = () => {
    if (window.confirm('Are you sure you want to reset this canvas layout to the ZATCA default?')) {
      setCanvasBlocks(JSON.parse(JSON.stringify(DEFAULT_LAYOUT)));
      setSelectedBlockId(null);
      triggerSuccess('Layout reset to default. Save to persist.');
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

  const handleToggleBlockVisibility = (blockId: string, visible: boolean) => {
    setCanvasBlocks(prev => prev.map(b => b.id === blockId ? { ...b, visible } : b));
    if (!visible && selectedBlockId === blockId) {
      setSelectedBlockId(null);
    }
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
 await fetch(`/api/transactions/months?companyId=${db.selectedCompanyId}`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(m) });
 }
 triggerSuccess(`Fiscal Month "${monthForm.year}-${monthForm.month}" opened successfully.`);
 onUpdateDb(result.db);
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
 await fetch(`/api/transactions/months?companyId=${db.selectedCompanyId}`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(m) });
 }
 triggerSuccess(`Fiscal Month "${isClosingMonth.id}" has been permanently closed and locked.`);
 setIsClosingMonth(null);
 onUpdateDb(result.db);
 await fetchMonths();
 } catch (err) {
 triggerError('Failed to update closed month in database.');
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

 const [userForm, setUserForm] = React.useState({
 username: '',
 password: '',
 role: 'user' as UserRole,
 companyId: db.selectedCompanyId,
 roleIds: [] as string[],
  });

  // --- Roles state (company-scoped) ---
  const [roles, setRoles] = React.useState<Role[]>([]);
  const fetchRoles = async () => {
    if (!db.selectedCompanyId) return;
    try {
      const resp = await fetch(`/api/roles?companyId=${db.selectedCompanyId}`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (Array.isArray(data)) setRoles(data);
    } catch (e) {
      console.error('Failed to fetch roles:', e);
    }
  };
  React.useEffect(() => {
    fetchRoles();
  }, [db.selectedCompanyId]);

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
      await fetchRoles();
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
      await fetchRoles();
    } catch (err: any) {
      triggerError('Failed to delete role: ' + err.message);
    }
  };

 const handleAddUser = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!userForm.username.trim()) return triggerError('Username is required.');

 const isUserAdmin = userForm.role === 'admin';

 // Non-admin users derive all of their access from assigned Roles — must have at
 // least one, otherwise the account can do nothing (fails closed by design).
 if (!isUserAdmin && userForm.roleIds.length === 0) {
 return triggerError('Staff accounts must be assigned at least one Role. Create or select a Role first.');
 }

 const assignedPassword = userForm.password.trim() || (editingUser ? (editingUser.password || '123456') : '123456');
 let savedUser = null;

 if (editingUser) {
 // Update existing user
 const updatedUsers = db.users.map(u => {
 if (u.id === editingUser.id) {
 savedUser = {
 ...u,
 username: userForm.username.trim(),
 password: assignedPassword,
 role: userForm.role,
 companyId: userForm.companyId || db.selectedCompanyId,
  roleIds: userForm.roleIds,
 } as any;
 return savedUser;
 }
 return u;
 });

 const updated = { ...db, users: updatedUsers };
 
 // Keep currentUser in sync if editing self
 if (db.currentUser && editingUser.id === db.currentUser.id && savedUser) {
 updated.currentUser = savedUser;
 }
 
 try {
 if (savedUser) await fetch('/api/users', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(savedUser) });
 onUpdateDb(updated);
 triggerSuccess('Account details updated successfully.');
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
 password: assignedPassword,
 role: userForm.role,
 companyId: userForm.companyId || db.selectedCompanyId,
 isActive: true, // Active by default
 uiLanguage: 'en',
  roleIds: userForm.roleIds,
 };
 
 try {
 await fetch('/api/users', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(newUser) });
 const updated = { ...db, users: [...db.users, newUser as any] };
 onUpdateDb(updated);
 triggerSuccess('Account created successfully.');
 } catch (err) {
 triggerError('Failed to save to database');
 return;
 }
 }

 setIsAddingUser(false);
 setUserForm({
 username: '',
 password: '',
 role: 'user',
 companyId: db.selectedCompanyId,
 roleIds: [],
  });
 };
 const handleToggleUserActive = (userId: string) => {
 if (db.currentUser && userId === db.currentUser.id) {
 return triggerError('You cannot deactivate your own active session!');
 }
 const targetUser = db.users.find(u => u.id === userId);
 if (targetUser?.isSuperAdmin) {
 return triggerError('Super Admin accounts cannot be deactivated!');
 }
 const updatedUsers = db.users.map(u => {
 if (u.id === userId) {
 const newStatus = u.isActive !== false ? false : true;
 triggerSuccess(`User "${u.username}" is now ${newStatus ? 'active' : 'deactivated'}.`);
 return { ...u, isActive: newStatus };
 }
 return u;
 });
 const updated = { ...db, users: updatedUsers };
 
 onUpdateDb(updated);
 };

 const handleDeleteUser = (userId: string) => {
  if (!window.confirm('Are you sure you want to delete this user?')) return;
  if (db.currentUser && userId === db.currentUser.id) {
 return triggerError('You cannot delete your own active session!');
 }
 const userToDelete = db.users.find(u => u.id === userId);
 if (!userToDelete) return;
 if (userToDelete.isSuperAdmin) {
 return triggerError('Super Admin accounts cannot be deleted!');
 }

 setConfirmDeleteUserId(userId);
 };

 const executeDeleteUser = () => {
 if (!confirmDeleteUserId) return;
 const userToDelete = db.users.find(u => u.id === confirmDeleteUserId);
 if (!userToDelete) {
 setConfirmDeleteUserId(null);
 return;
 }

 const updatedUsers = db.users.map(u => u.id === confirmDeleteUserId ? { ...u, isDeleted: 1 } : u);
 fetch(`/api/users/${confirmDeleteUserId}`, { method: 'DELETE' }).catch(err => console.error(err));
 const updated = { ...db, users: updatedUsers };
 
 onUpdateDb(updated);
 triggerSuccess(`User "${userToDelete.username}" has been deleted.`);
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

 const handleAddInvestor = (e: React.FormEvent) => {
 e.preventDefault();
 if (!investorForm.name.trim()) return triggerError('Investor name is required.');
 
 const pct = parseFloat(investorForm.equityPercentage) || 0;
 if (pct < 0 || pct > 100) return triggerError('Equity percentage must be between 0 and 100.');

 const profitPct = investorForm.profitPercentage !== '' ? parseFloat(investorForm.profitPercentage) : pct;
 if (isNaN(profitPct) || profitPct < 0 || profitPct > 100) return triggerError('Profit percentage must be between 0 and 100.');

 const newInvsData: Omit<Investor, 'id' | 'capitalContributed' | 'createdAt'> = {
 name: investorForm.name.trim(),
 email: investorForm.email.trim(),
 phone: investorForm.phone.trim(),
 equityPercentage: pct,
 profitPercentage: profitPct,
 isActive: true,
 notes: investorForm.notes.trim() || undefined,
 companyId: db.selectedCompanyId
 };

 const result = saveInvestor(db, newInvsData);
 if (result.error) {
 triggerError(result.error);
 } else {
 triggerSuccess(`Investor "${newInvsData.name}" registered successfully.`);
 onUpdateDb(result.db);
 setInvestorForm({
 name: '',
 email: '',
 phone: '',
 equityPercentage: '',
 profitPercentage: '',
 notes: '',
 companyId: db.selectedCompanyId
 });
 }
 };

 const handleAddInvestment = (e: React.FormEvent) => {
 e.preventDefault();
 const amountNum = parseFloat(investmentForm.amount);
 if (isNaN(amountNum) || amountNum <= 0) return triggerError('Please enter a valid contribution amount.');
 if (!investmentForm.investorId) return triggerError('Please select an investor.');
 if (!investmentForm.bankId) return triggerError('Please select a target bank account.');

 const result = saveCapitalInvestment(
 db,
 investmentForm.investorId,
 investmentForm.bankId,
 amountNum,
 investmentForm.date,
 investmentForm.description || 'Equity capital injection'
 );

 if (result.error) {
 triggerError(result.error);
 } else {
 triggerSuccess(`Successfully recorded investment of ${currencySymbol} ${amountNum.toFixed(2)}.`);
 onUpdateDb(result.db);
 setInvestmentForm({
 investorId: '',
 bankId: '',
 amount: '',
 date: new Date().toISOString().split('T')[0],
 description: ''
 });
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
        {CATEGORY_GROUPS.map((cat) => {
          const isCatActive = cat.subTabs.some(st => st.id === activeTab);
          const IconComp = cat.icon;
          
          return (
            <button
              key={cat.id}
              onClick={() => {
                const available = cat.subTabs.find(st => !st.superAdminOnly || db.currentUser?.isSuperAdmin);
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
          .filter(st => !st.superAdminOnly || db.currentUser?.isSuperAdmin)
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
                {st.id === 'company' && (
                  <span className={`text-[8px] font-black px-1.5 py-0.5 rounded uppercase ${db.companySetup?.isInventoryModuleEnabled ? 'bg-emerald-500/20 text-emerald-600' : 'bg-slate-200 text-slate-500'}`}>
                    {db.companySetup?.isInventoryModuleEnabled ? 'ON' : 'OFF'}
                  </span>
                )}
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
        {/* GLOBAL SETTINGS */}
        <div className="space-y-1.5">
          <p className="text-[9px] font-extrabold text-slate-400 uppercase tracking-widest px-3 mb-2">Global Settings</p>
          {db.currentUser?.isSuperAdmin && (
            <button onClick={() => setActiveTab('companies')} className={`w-full text-start px-3.5 py-2.5 text-xs font-bold rounded-2xl flex items-center gap-2.5 transition-all duration-150 ${activeTab === 'companies' ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/10' : 'text-slate-600 hover:bg-slate-100/60'}`}>
              <Building className="w-4 h-4 shrink-0 text-indigo-500" /> Manage Companies
            </button>
          )}
          <button onClick={() => setActiveTab('company')} className={`w-full text-start px-3.5 py-2.5 text-xs font-bold rounded-2xl flex items-center justify-between transition-all duration-150 ${activeTab === 'company' ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/10' : 'text-slate-600 hover:bg-slate-100/60'}`}>
            <span className="flex items-center gap-2.5">
              <Settings className="w-4 h-4 shrink-0 text-amber-500" /> Company Setup
            </span>
            <span className={`text-[8px] font-black px-1.5 py-0.5 rounded uppercase tracking-wider ${db.companySetup?.isInventoryModuleEnabled ? 'bg-emerald-500/10 text-emerald-500' : 'bg-slate-500/10 text-slate-400'}`}>
              {db.companySetup?.isInventoryModuleEnabled ? '📦 ON' : 'OFF'}
            </span>
          </button>
          <button onClick={() => setActiveTab('users')} className={`w-full text-start px-3.5 py-2.5 text-xs font-bold rounded-2xl flex items-center gap-2.5 transition-all duration-150 ${activeTab === 'users' ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/10' : 'text-slate-600 hover:bg-slate-100/60'}`}>
            <UserCheck className="w-4 h-4 shrink-0" /> Staff Permissions
          </button>
          <button onClick={() => setActiveTab('database')} className={`w-full text-start px-3.5 py-2.5 text-xs font-bold rounded-2xl flex items-center gap-2.5 transition-all duration-150 ${activeTab === 'database' ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/10' : 'text-slate-600 hover:bg-slate-100/60'}`}>
            <Database className="w-4 h-4 shrink-0 text-emerald-500" /> Database Backup & Sync
          </button>
          {db.currentUser?.isSuperAdmin && (
            <button onClick={() => setActiveTab('translations')} className={`w-full text-start px-3.5 py-2.5 text-xs font-bold rounded-2xl flex items-center gap-2.5 transition-all duration-150 ${activeTab === 'translations' ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/10' : 'text-slate-600 hover:bg-slate-100/60'}`}>
              <Languages className="w-4 h-4 shrink-0 text-fuchsia-500" /> Translations
            </button>
          )}
        </div>

        {/* FINANCE MODULE */}
        <div className="space-y-1.5">
          <p className="text-[9px] font-extrabold text-slate-400 uppercase tracking-widest px-3 mb-2">Finance Module</p>
          <button onClick={() => setActiveTab('banks')} className={`w-full text-start px-3.5 py-2.5 text-xs font-bold rounded-2xl flex items-center gap-2.5 transition-all duration-150 ${activeTab === 'banks' ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/10' : 'text-slate-600 hover:bg-slate-100/60'}`}>
            <Wallet className="w-4 h-4 shrink-0 text-blue-500" /> Bank Accounts
          </button>
          <button onClick={() => setActiveTab('taxes')} className={`w-full text-start px-3.5 py-2.5 text-xs font-bold rounded-2xl flex items-center gap-2.5 transition-all duration-150 ${activeTab === 'taxes' ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/10' : 'text-slate-600 hover:bg-slate-100/60'}`}>
            <Percent className="w-4 h-4 shrink-0 text-violet-500" /> Tax Slabs
          </button>
          <button onClick={() => setActiveTab('months')} className={`w-full text-start px-3.5 py-2.5 text-xs font-bold rounded-2xl flex items-center gap-2.5 transition-all duration-150 ${activeTab === 'months' ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/10' : 'text-slate-600 hover:bg-slate-100/60'}`}>
            <Calendar className="w-4 h-4 shrink-0 text-orange-500" /> Month Opening / Closing
          </button>
          <button onClick={() => setActiveTab('equity')} className={`w-full text-start px-3.5 py-2.5 text-xs font-bold rounded-2xl flex items-center gap-2.5 transition-all duration-150 ${activeTab === 'equity' ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/10' : 'text-slate-600 hover:bg-slate-100/60'}`}>
            <Coins className="w-4 h-4 shrink-0 text-amber-500" /> Capital & Equity
          </button>
        </div>

        {/* SALES MODULE */}
        <div className="space-y-1.5">
          <p className="text-[9px] font-extrabold text-slate-400 uppercase tracking-widest px-3 mb-2">Sales Module</p>
          <button onClick={() => setActiveTab('templates')} className={`w-full text-start px-3.5 py-2.5 text-xs font-bold rounded-2xl flex items-center gap-2.5 transition-all duration-150 ${activeTab === 'templates' ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/10' : 'text-slate-600 hover:bg-slate-100/60'}`}>
            <FileSpreadsheet className="w-4 h-4 shrink-0 text-emerald-500" /> Document Templates
          </button>
        </div>

        {/* POS MODULE */}
        <div className="space-y-1.5">
          <p className="text-[9px] font-extrabold text-slate-400 uppercase tracking-widest px-3 mb-2">POS Module</p>
          <button onClick={() => setActiveTab('pos')} className={`w-full text-start px-3.5 py-2.5 text-xs font-bold rounded-2xl flex items-center gap-2.5 transition-all duration-150 ${activeTab === 'pos' ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/10' : 'text-slate-600 hover:bg-slate-100/60'}`}>
            <ShoppingCart className="w-4 h-4 shrink-0 text-pink-500" /> POS Settings
          </button>
        </div>
      </div>
    )}

    {/* Form Area */}
    <div className={useSleekLayout ? "p-6 md:p-8 w-full" : "col-span-3 p-6 md:p-8"}>
 
 {/* TAB: ZATCA E-INVOICING PHASE 2 */}
 {activeTab === 'zatca' && (
   <ZatcaOnboardingWizard db={db} onUpdateDb={onUpdateDb} />
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
 const activeMonth = fiscalMonths.find(m => m.companyId === company.id && m.status === 'Open');
 
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

 <span className="px-2 py-0.5 bg-indigo-50 text-indigo-700 font-extrabold rounded text-[9px] uppercase tracking-wider">
 {company.currency || 'SAR'}
 </span>
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
 {activeMonth ? `🔓 ${activeMonth.name}` : '🔒 All Closed'}
 </span>
 </div>
 <div className="flex justify-between">
 <span className="text-slate-400">Accounts/Banks:</span>
 <span className="text-slate-700 font-semibold">{companyBanks.length} configured</span>
 </div>
 <div className="flex items-center justify-between border-t border-slate-100/50 pt-1.5 mt-1.5">
   <span className="text-slate-400 flex items-center gap-1">
     <span>📦</span> Inventory Module:
   </span>
   <div className="flex items-center gap-2">
     <span className={`font-mono text-[9px] font-bold px-1.5 py-0.5 rounded uppercase ${company.isInventoryModuleEnabled ? 'bg-indigo-50 text-indigo-600' : 'bg-slate-100 text-slate-400'}`}>
       {company.isInventoryModuleEnabled ? 'Enabled' : 'Disabled'}
     </span>
     <label className="relative inline-flex items-center cursor-pointer scale-75 origin-right">
       <input 
         type="checkbox" 
         checked={company.isInventoryModuleEnabled || false} 
         onChange={(e) => handleToggleCompanyInventory(company.id, e.target.checked)}
         className="sr-only peer" 
       />
       <div className="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
     </label>
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
 const updatedDb = { ...db, selectedCompanyId: company.id!, companySetup: company };
 applyTheme(company.themeId || 'classic-executive');
 
 onUpdateDb(updatedDb);
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
 placeholder="15 digits"
 value={newCompany.vatNumber}
 onChange={(e) => setNewCompany({ ...newCompany, vatNumber: e.target.value })}
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
   <div className="flex items-center justify-between">
     <div className="space-y-0.5">
       <span className="text-[11px] font-bold text-slate-700">Enable Inventory & Procurement</span>
       <p className="text-[9px] text-slate-400">Activate stock registries, PO, GRN workflows.</p>
     </div>
     <label className="relative inline-flex items-center cursor-pointer">
       <input 
         type="checkbox" 
         checked={newCompany.isInventoryModuleEnabled || false} 
         onChange={(e) => setNewCompany({ ...newCompany, isInventoryModuleEnabled: e.target.checked })}
         className="sr-only peer" 
       />
       <div className="w-8 h-4.5 bg-slate-200 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-3.5 after:w-3.5 after:transition-all peer-checked:bg-indigo-600"></div>
     </label>
   </div>

   {newCompany.isInventoryModuleEnabled && (
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
   )}
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
 To save you setup effort, registering this profile will auto-provision standard business resources: A Main Operating Bank, a Walk-in Customer, a Cash Vendor, a Standard English PDF Template, and an open Operational Month period (June 2026).
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

 {/* TAB: COMPANY */}
 
        {activeTab === 'pos' && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div>
              <h2 className="text-xl font-extrabold text-slate-900 tracking-tight mb-2">POS Configuration</h2>
              <p className="text-sm text-slate-500 font-medium">Configure Point of Sale settings, receipts, and behaviors.</p>
            </div>
            <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-sm">
              <div className="space-y-4">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" checked={(db.companies?.find(c => c.id === (db.selectedCompanyId))!).posSettings?.autoPrint ?? true} onChange={e => {
                    const activeCompany = db.companies.find(c => c.id === db.selectedCompanyId);
                    const newComp = {...activeCompany, posSettings: {...(activeCompany.posSettings || {}), autoPrint: e.target.checked, maxImageSizeKB: activeCompany.posSettings?.maxImageSizeKB || 500}};
                    handleCompanySave(newComp);
                  }} className="w-5 h-5 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500" />
                  <div>
                    <div className="text-sm font-bold text-slate-800">Auto-Print Receipts</div>
                    <div className="text-xs text-slate-500">Automatically print thermal receipts after payment</div>
                  </div>
                </label>
                
                <div>
                  <label className="block text-sm font-bold text-slate-800 mb-2">Max POS Product Image Size (KB)</label>
                  <input type="number" min="100" max="5000" value={(db.companies?.find(c => c.id === (db.selectedCompanyId))!).posSettings?.maxImageSizeKB || 500} onChange={e => {
                    const activeCompany = db.companies.find(c => c.id === db.selectedCompanyId);
                    const newComp = {...activeCompany, posSettings: {...(activeCompany.posSettings || {}), maxImageSizeKB: parseInt(e.target.value) || 500, autoPrint: activeCompany.posSettings?.autoPrint ?? true}};
                    handleCompanySave(newComp);
                  }} className="w-full max-w-xs bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-xl px-4 py-2.5 focus:ring-2 focus:ring-indigo-600" />
                  <p className="text-xs text-slate-500 mt-1">Recommended: 500KB to keep the database small.</p>
                </div>
                
                <div>
                  <label className="block text-sm font-bold text-slate-800 mb-2">Max Image Dimensions (pixels)</label>
                  <input type="number" min="100" max="2000" value={(db.companies?.find(c => c.id === (db.selectedCompanyId))!).posSettings?.maxImageDimensions || 800} onChange={e => {
                    const activeCompany = db.companies.find(c => c.id === db.selectedCompanyId);
                    const newComp = {...activeCompany, posSettings: {...(activeCompany.posSettings || {}), maxImageDimensions: parseInt(e.target.value) || 800, autoPrint: activeCompany.posSettings?.autoPrint ?? true, maxImageSizeKB: activeCompany.posSettings?.maxImageSizeKB || 500}};
                    handleCompanySave(newComp);
                  }} className="w-full max-w-xs bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-xl px-4 py-2.5 focus:ring-2 focus:ring-indigo-600" />
                  <p className="text-xs text-slate-500 mt-1">Images larger than this (width/height) will be resized automatically.</p>
                </div>
              </div>
            </div>
          </div>
        )}

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
 placeholder="e.g. 300123456700003"
 value={companyForm.vatNumber || ''}
 onChange={(e) => setCompanyForm({ ...companyForm, vatNumber: e.target.value })}
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
     <h4 className="text-xs font-extrabold text-slate-800 tracking-tight uppercase">Enterprise Inventory & Purchasing Module (Optional)</h4>
     <p className="text-[10px] text-slate-400 mt-0.5">Enable multi-warehouse, batch controls, and complete purchase procurement workflows (PR, PO, GRN, Bills, Stock Take, Debit Notes).</p>
   </div>
   
   <div className="p-4 rounded-2xl bg-slate-50/50 border border-slate-100 space-y-4">
     <div className="flex items-center justify-between">
       <div className="space-y-0.5">
         <span className="text-xs font-bold text-slate-800">Activate Inventory Module</span>
         <p className="text-[10px] text-slate-400">Unlock stock registries, reorder alerts, and procurement tracking across the portal.</p>
       </div>
       <label className="relative inline-flex items-center cursor-pointer">
         <input 
           type="checkbox" 
           checked={companyForm.isInventoryModuleEnabled || false} 
           onChange={(e) => setCompanyForm({ ...companyForm, isInventoryModuleEnabled: e.target.checked })}
           className="sr-only peer" 
         />
         <div className="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
       </label>
     </div>

     {companyForm.isInventoryModuleEnabled && (
       <div className="border-t border-slate-100 pt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
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
       </div>
     )}
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
 <p className="text-[10px] text-slate-400 mt-0.5">Account Title: {b.accountTitle}</p>
 <p className="text-[10px] text-slate-400 font-mono mt-0.5">No: {b.accountNumber}</p>
 </div>
 <div className="flex gap-1.5">
 {b.isDefault && (
 <span className="px-1.5 py-0.5 bg-indigo-100 text-indigo-700 font-bold rounded text-[9px] uppercase">
 Default
 </span>
 )}
 <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${b.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-400'}`}>
 {b.isActive ? 'Active' : 'Inactive'}
 </span>
 </div>
 </div>

 <div className="mt-3">
 <span className="text-[10px] text-slate-400 uppercase font-semibold">Running Balance</span>
 <p className={`text-base font-black ${balance < 0 ? 'text-rose-600' : 'text-slate-800'}`}>
 {currencySymbol} {balance.toFixed(2)}
 {balance < 0 && <span className="text-[9px] text-rose-500 font-semibold ms-1.5 uppercase tracking-wide">Negative</span>}
 </p>
 </div>
 </div>

 {/* Actions */}
 <div className="mt-4 pt-3 border-t border-slate-100/60 flex justify-end gap-2 items-center">
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
 Edit
 </button>
 <span className="text-slate-200 text-xs font-light">|</span>
 {!b.isDefault && b.isActive && (
 <>
 <button
 onClick={() => handleSetDefaultBank(b.id)}
 className="text-[10px] font-bold text-indigo-600 hover:text-indigo-800"
 >
 Set Default
 </button>
 <span className="text-slate-200 text-xs font-light">|</span>
 </>
 )}
 <button
 onClick={() => handleToggleBankActive(b.id)}
 className={`text-[10px] font-bold ${b.isActive ? 'text-rose-500 hover:text-rose-700' : 'text-emerald-500 hover:text-emerald-700'}`}
 >
 {b.isActive ? 'Deactivate' : 'Activate'}
 </button>
 </div>
 </div>
 );
 })}
 </div>
 </div>

 {/* Add Bank Form */}
 <div id="bank-form-section" className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3">
 {editingBankId ? 'Edit Bank Account Details' : 'Add New Bank Account'}
 </h4>
 <form onSubmit={handleAddBank} className="grid grid-cols-2 gap-3.5">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Bank Name</label>
 <input
 type="text"
 required
 placeholder="e.g. Riyad Bank, Al Rajhi"
 value={bankForm.bankName}
 onChange={(e) => setBankForm({ ...bankForm, bankName: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Account Title</label>
 <input
 type="text"
 required
 placeholder="e.g. CNC Woodcraft LLC"
 value={bankForm.accountTitle}
 onChange={(e) => setBankForm({ ...bankForm, accountTitle: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Account Number / IBAN</label>
 <input
 type="text"
 required
 placeholder="SA..."
 value={bankForm.accountNumber}
 onChange={(e) => setBankForm({ ...bankForm, accountNumber: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Opening Balance</label>
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
 <span>Set as Global Default Bank</span>
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
 Cancel Edit
 </button>
 )}
 <button
 type="submit"
 className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl px-3.5 py-1.5 text-xs font-bold flex items-center gap-1 shadow-sm transition"
 >
 {editingBankId ? (
 <>
 <Check className="w-3.5 h-3.5" /> Save Changes
 </>
 ) : (
 <>
 <Plus className="w-3.5 h-3.5" /> Add Account
 </>
 )}
 </button>
 </div>
 </form>
 </div>

 {/* Inter-bank cash transfer */}
 <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
 <div className="flex items-center gap-1.5 mb-3">
 <ArrowRightLeft className="w-4 h-4 text-slate-500" />
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Inter-Bank Funds Transfer</h4>
 </div>
 <form onSubmit={handleInterBankTransfer} className="grid grid-cols-1 md:grid-cols-4 gap-3.5">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">From Account</label>
 <select
 required
 value={transferForm.sourceBankId}
 onChange={(e) => setTransferForm({ ...transferForm, sourceBankId: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 >
 <option value="">Select source bank</option>
 {db.banks.filter(b => b.isActive && (!b.companyId || b.companyId === db.selectedCompanyId)).map(b => (
 <option key={b.id} value={b.id}>{b.bankName} ({currencySymbol} {getBankBalance(db, b.id).toFixed(2)})</option>
 ))}
 </select>
 </div>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">To Account</label>
 <select
 required
 value={transferForm.destBankId}
 onChange={(e) => setTransferForm({ ...transferForm, destBankId: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 >
 <option value="">Select dest bank</option>
 {db.banks.filter(b => b.isActive && (!b.companyId || b.companyId === db.selectedCompanyId)).map(b => (
 <option key={b.id} value={b.id}>{b.bankName} ({currencySymbol} {getBankBalance(db, b.id).toFixed(2)})</option>
 ))}
 </select>
 </div>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Amount ({currencySymbol})</label>
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
 <label className="text-[10px] font-bold text-slate-400 uppercase">Transfer Date</label>
 <input
 type="date"
 required
 value={transferForm.date}
 onChange={(e) => setTransferForm({ ...transferForm, date: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>
 <div className="md:col-span-3 space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Reason / Memo</label>
 <input
 type="text"
 placeholder="e.g. Funding operations, balancing reserves"
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
 <ArrowRightLeft className="w-3.5 h-3.5" /> Transfer Funds
 </button>
 </div>
 </form>
 </div>
 </div>
 )}

 {/* TAB: TAX SLABS */}
 {activeTab === 'taxes' && (
 <div className="space-y-6">
 <div>
 <h3 className="text-sm font-bold text-slate-900">{t('Tax Slab Configuration')}</h3>
 <p className="text-[11px] text-slate-400">Define percentages for document taxes. Standard values 0% and 15% are configured by default.</p>
 </div>

 <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
 {/* List tax slabs */}
 <div className="border border-slate-100 rounded-2xl overflow-hidden shadow-sm">
 <table className="w-full text-xs">
 <thead>
 <tr className="bg-slate-50 text-slate-500">
 <th className="p-3 text-start">Tax Description</th>
 <th className="p-3 text-end">Percentage Value</th>
 </tr>
 </thead>
 <tbody>
 {db.taxSlabs.map((ts, idx) => (
 <tr key={ts.id} className="border-b border-slate-100">
 <td className="p-3 font-semibold text-slate-800">{ts.name}</td>
 <td className="p-3 text-end font-mono font-bold text-indigo-600">{ts.percentage}%</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>

 {/* Add Slab form */}
 <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100 flex flex-col justify-between">
 <div>
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3">Add Custom Tax Slab</h4>
 <form onSubmit={handleAddTax} className="space-y-4">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Slab Title</label>
 <input
 type="text"
 required
 placeholder="e.g. VAT (15%), Regional (5%)"
 value={taxForm.name}
 onChange={(e) => setTaxForm({ ...taxForm, name: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Tax Percentage (%)</label>
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
 <div className="flex justify-end pt-1">
 <button
 type="submit"
 className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl px-4 py-1.5 text-xs font-bold flex items-center gap-1 shadow-sm"
 >
 <Plus className="w-3.5 h-3.5" /> Save Slab
 </button>
 </div>
 </form>
 </div>
 </div>
 </div>
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

     return (
      <div className="space-y-6">
       {/* Designer Header */}
       <div className="flex flex-col md:flex-row justify-between items-start md:items-center bg-slate-50 p-5 rounded-2xl border border-slate-150 gap-4">
        <div>
         <div className="flex items-center gap-2">
          <span className="text-xl">🎨</span>
          <h3 className="text-sm font-extrabold text-slate-900">Canvas Layout Designer: {tmpl.name}</h3>
          <span className={`px-1.5 py-0.5 rounded text-[8px] font-extrabold uppercase ${
           (tmpl.language === 'Arabic' || tmpl.language === 'Urdu') ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800'
          }`}>
           {tmpl.language}
          </span>
         </div>
         <p className="text-[11px] text-slate-500 mt-1">Drag-and-drop elements to reorder. Adjust width spans. Configure properties to secure complete bilingual ZATCA compliance.</p>
        </div>
        <div className="flex gap-2 text-xs self-stretch md:self-auto justify-end">
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
          👁️ Live Print Preview
         </button>
         <button
          type="button"
          onClick={handleResetLayout}
          className="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-xl font-bold transition flex items-center gap-1"
         >
          🔄 Reset Default ZATCA
         </button>
         <button
          type="button"
          onClick={() => setDesigningTemplateId(null)}
          className="px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-xl font-bold transition"
         >
          Cancel
         </button>
         <button
          type="button"
          onClick={handleSaveCanvasLayout}
          className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold shadow transition flex items-center gap-1.5"
         >
          💾 Save Layout Configuration
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
            <span className="text-xs font-bold text-indigo-600 uppercase tracking-wider">Configure Block</span>
            <button 
             type="button"
             onClick={() => setSelectedBlockId(null)}
             className="text-[10px] text-slate-400 hover:text-slate-600"
            >
             ✕ Close
            </button>
           </div>
           <div>
            <h4 className="text-xs font-extrabold text-slate-800">{selectedBlock.title}</h4>
            <p className="text-[9px] text-slate-400 mt-0.5">Block Key: {selectedBlock.id}</p>
           </div>

           {/* Customize Option Fields */}
           <div className="space-y-4 pt-2">
            {/* Width Buttons */}
            <div className="space-y-1">
             <div className="flex justify-between items-center">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Grid Column Span ({selectedBlock.w}/12)</label>
              <span className="text-[9px] font-mono text-indigo-600 font-bold">{Math.round((selectedBlock.w / 12) * 100)}% Width</span>
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
                title={`Span ${width} of 12 columns`}
               >
                {width}
               </button>
              ))}
             </div>
            </div>

            {/* Alignment Control */}
            <div className="space-y-1">
             <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Horizontal Alignment</label>
             <div className="grid grid-cols-3 gap-1">
              {[
               { id: 'left', label: 'Left ⬅️' },
               { id: 'center', label: 'Center ↔️' },
               { id: 'right', label: 'Right ➡️' }
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

            {/* Block specific properties */}
            {selectedBlock.id === 'company_details' && (
             <div className="space-y-2 bg-slate-50 p-2.5 rounded-xl border border-slate-200/80">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Seller Header Fields</span>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.isBilingual !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'isBilingual', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Bilingual Seller Name</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showVat !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showVat', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Show Tax / VAT Reg #</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showAddress !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showAddress', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Show Address</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showContact !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showContact', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Show Phone & Email</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showBank !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showBank', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Show IBAN / Bank Details</span>
              </label>
             </div>
            )}

            {selectedBlock.id === 'doc_details' && (
             <div className="space-y-2 bg-slate-50 p-2.5 rounded-xl border border-slate-200/80">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Document Header Fields</span>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.isBilingual !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'isBilingual', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Bilingual Document Titles</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showDocNumber !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showDocNumber', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Document Number</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showDate !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showDate', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Issue Date</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showDueDate !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showDueDate', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Due / Payment Date</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showPaymentStatus !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showPaymentStatus', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Payment Status Badge</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showOriginQ !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showOriginQ', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Origin Quotation Reference</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showCreatedBy !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showCreatedBy', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Created By User</span>
              </label>
             </div>
            )}

            {selectedBlock.id === 'customer_info' && (
             <div className="space-y-2 bg-slate-50 p-2.5 rounded-xl border border-slate-200/80">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Customer Header Fields</span>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.isBilingual !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'isBilingual', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Bilingual Client Label</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showName !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showName', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Customer / Vendor Name</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showAddress !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showAddress', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Show Physical Address</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showContact !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showContact', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Show Phone & Email</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showVatNumber !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showVatNumber', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Show Customer VAT / TRN #</span>
              </label>
              <div className="space-y-1 pt-1">
               <span className="text-[10px] font-bold text-slate-400 block uppercase">Box Frame Style</span>
               <select
                value={selectedBlock.props?.borderStyle || 'solid'}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'borderStyle', e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
               >
                <option value="solid">Solid Card</option>
                <option value="dashed">Dashed Box</option>
                <option value="none">Flat (No border)</option>
               </select>
              </div>
             </div>
            )}

            {selectedBlock.id === 'items_table' && (
             <div className="space-y-2 bg-slate-50 p-2.5 rounded-xl border border-slate-200/80">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Details Table Columns Selection</span>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.isBilingual !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'isBilingual', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Bilingual Headings</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showSNo !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showSNo', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>S.No Column</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showItemCode !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showItemCode', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Item SKU / Code</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showDescription !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showDescription', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Item Description</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showQty !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showQty', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Quantity Column</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showUnitCost !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showUnitCost', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Unit Cost / Rate Column</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showDiscount !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showDiscount', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Row Discounts</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showTotal !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showTotal', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Line Total Column</span>
              </label>
              <div className="space-y-1 pt-1">
               <span className="text-[10px] font-bold text-slate-400 block uppercase">Table Row Style</span>
               <select
                value={selectedBlock.props?.borderStyle || 'stripe'}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'borderStyle', e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
               >
                <option value="classic">Classic Underlines</option>
                <option value="stripe">Striped Alternating Rows</option>
               </select>
              </div>
             </div>
            )}

            {selectedBlock.type === 'custom_field' || selectedBlock.id.startsWith('custom_field_') ? (
             <div className="space-y-2.5 bg-indigo-50/50 p-2.5 rounded-xl border border-indigo-200/80">
              <span className="text-[10px] font-bold text-indigo-700 uppercase tracking-wider block">Custom Field Config</span>
              <div className="space-y-1">
               <label className="text-[10px] font-bold text-slate-500 block uppercase">Dynamic Field Binding</label>
               <select
                value={selectedBlock.props?.fieldBinding || 'none'}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'fieldBinding', e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none font-semibold"
               >
                <option value="none">Static Text / Custom Label</option>
                <option value="docNumber">Document Number (INV/Q/EXP)</option>
                <option value="docDate">Document Date</option>
                <option value="dueDate">Payment / Due Date</option>
                <option value="paymentStatus">Payment Status (Paid/Pending)</option>
                <option value="paymentMethod">Payment Method / Bank</option>
                <option value="originQuotation">Origin Quotation Link</option>
                <option value="customerName">Customer / Vendor Name</option>
                <option value="customerVat">Customer TRN / Tax Number</option>
                <option value="customerPhone">Customer Phone</option>
                <option value="customerAddress">Customer Address</option>
                <option value="companyVat">Seller Tax / TRN</option>
                <option value="companyBank">Seller IBAN / Bank</option>
                <option value="createdBy">Created By User</option>
               </select>
              </div>
              <div className="space-y-1">
               <label className="text-[10px] font-bold text-slate-500 block uppercase">English Label</label>
               <input
                type="text"
                value={selectedBlock.props?.labelEn || ''}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'labelEn', e.target.value)}
                placeholder="e.g. Reference PO #"
                className="w-full bg-white border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
               />
              </div>
              <div className="space-y-1">
               <label className="text-[10px] font-bold text-slate-500 block uppercase">Arabic Label (Optional)</label>
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
                <label className="text-[10px] font-bold text-slate-500 block uppercase">Static Content Value</label>
                <textarea
                 value={selectedBlock.props?.staticText || ''}
                 onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'staticText', e.target.value)}
                 placeholder="Enter fixed note or details..."
                 rows={2}
                 className="w-full bg-white border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
                />
               </div>
              )}
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
               <span>Bilingual ZATCA verification text</span>
              </label>
              <div className="space-y-1">
               <span className="text-[10px] font-bold text-slate-400 block uppercase">QR Sizing</span>
               <select
                value={selectedBlock.props?.size || 'medium'}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'size', e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
               >
                <option value="small">Small (40px)</option>
                <option value="medium">Medium (80px)</option>
                <option value="large">Large (110px)</option>
               </select>
              </div>
             </div>
            )}

            {selectedBlock.id === 'totals_summary' && (
             <div className="space-y-2 bg-slate-50 p-2.5 rounded-xl border border-slate-200/80">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Totals Breakdown Fields</span>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.isBilingual !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'isBilingual', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Bilingual Calculations Description</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showSubtotal !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showSubtotal', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Show Subtotal</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showDiscount !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showDiscount', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Show Total Discount</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showVat !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showVat', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Show VAT 15%</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
               <input
                type="checkbox"
                checked={selectedBlock.props?.showGrandTotal !== false}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'showGrandTotal', e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 w-3.5 h-3.5"
               />
               <span>Show Grand Total</span>
              </label>
              <div className="space-y-1 pt-1">
               <span className="text-[10px] font-bold text-slate-400 block uppercase">Accent Highlights</span>
               <select
                value={selectedBlock.props?.accentColor || 'indigo'}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'accentColor', e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
               >
                <option value="indigo">Classic Indigo</option>
                <option value="emerald">Compliance Emerald</option>
                <option value="slate">Monochrome Slate</option>
                <option value="amber">Warm Amber</option>
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
              <span>Bilingual Arabic Label Hint</span>
             </label>
            )}
           </div>

            {/* Divider */}
            <div className="border-t border-slate-100 pt-3 space-y-3">
             <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-wider block">Block Style & Spacing</span>
             
             {/* Font Sizing */}
             <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-400 block uppercase">Font Size</label>
              <select
               value={selectedBlock.props?.fontSize || 'xs'}
               onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'fontSize', e.target.value)}
               className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
              >
               <option value="xs">Extra Small (xs)</option>
               <option value="sm">Small (sm)</option>
               <option value="base">Medium (base)</option>
               <option value="lg">Large (lg)</option>
               <option value="xl">Extra Large (xl)</option>
              </select>
             </div>

             {/* Font Weight */}
             <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-400 block uppercase">Font Weight</label>
              <select
               value={selectedBlock.props?.fontWeight || 'normal'}
               onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'fontWeight', e.target.value)}
               className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
              >
               <option value="normal">Normal</option>
               <option value="medium">Medium</option>
               <option value="semibold">Semi-Bold</option>
               <option value="bold">Bold</option>
               <option value="extrabold">Extra-Bold</option>
              </select>
             </div>

             {/* Font Family */}
             <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-400 block uppercase">Font Family</label>
              <select
               value={selectedBlock.props?.fontFamily || 'sans'}
               onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'fontFamily', e.target.value)}
               className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
              >
               <option value="sans">Modern Sans-Serif (Inter)</option>
               <option value="serif">Traditional Serif</option>
               <option value="mono">Technical Mono (Fira/JetBrains)</option>
              </select>
             </div>

             {/* Vertical Spacing */}
             <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
               <label className="text-[10px] font-bold text-slate-400 block uppercase">Margin Top</label>
               <select
                value={selectedBlock.props?.mt !== undefined ? selectedBlock.props?.mt : '4'}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'mt', e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
               >
                <option value="0">None (0px)</option>
                <option value="1">Extra Tight (4px)</option>
                <option value="2">Tight (8px)</option>
                <option value="3">Compact (12px)</option>
                <option value="4">Normal (16px)</option>
                <option value="6">Spacious (24px)</option>
                <option value="8">Loose (32px)</option>
                <option value="12">Extra Loose (48px)</option>
               </select>
              </div>
              <div className="space-y-1">
               <label className="text-[10px] font-bold text-slate-400 block uppercase">Margin Bottom</label>
               <select
                value={selectedBlock.props?.mb !== undefined ? selectedBlock.props?.mb : '4'}
                onChange={(e) => handleUpdateBlockProp(selectedBlock.id, 'mb', e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
               >
                <option value="0">None (0px)</option>
                <option value="1">Extra Tight (4px)</option>
                <option value="2">Tight (8px)</option>
                <option value="3">Compact (12px)</option>
                <option value="4">Normal (16px)</option>
                <option value="6">Spacious (24px)</option>
                <option value="8">Loose (32px)</option>
                <option value="12">Extra Loose (48px)</option>
               </select>
              </div>
             </div>
            </div>
          </div>
         ) : (
          <div className="space-y-4">
            <div className="p-4 bg-white border border-indigo-200 shadow-sm rounded-2xl space-y-4">
             <div className="pb-2 border-b border-slate-100 flex items-center justify-between">
              <span className="text-xs font-bold text-indigo-600 uppercase tracking-wider">Global Document Style</span>
              <span className="text-[9px] font-bold bg-indigo-50 text-indigo-700 px-1.5 py-0.5 rounded-full uppercase">Template</span>
             </div>
             
             {/* Global Row Gap */}
             <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-400 block uppercase">Global Row Gap</label>
              <select
               value={tmpl.gridGapY || 'normal'}
               onChange={(e) => handleUpdateTemplateProperty(tmpl.id, 'gridGapY', e.target.value)}
               className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
              >
               <option value="tight">High Density (8px Gap)</option>
               <option value="compact">Compact (12px Gap)</option>
               <option value="normal">Normal (24px Gap) - Default</option>
               <option value="loose">Spacious (40px Gap)</option>
              </select>
             </div>

             {/* Global Font Family */}
             <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-400 block uppercase">Global Font Family</label>
              <select
               value={tmpl.globalFontFamily || 'sans'}
               onChange={(e) => handleUpdateTemplateProperty(tmpl.id, 'globalFontFamily', e.target.value)}
               className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2 text-xs text-slate-800 focus:outline-none"
              >
               <option value="sans">Modern Sans-Serif (Inter)</option>
               <option value="serif">Traditional Serif</option>
               <option value="mono">Technical Mono (Fira/JetBrains)</option>
              </select>
             </div>
            </div>

            <div className="p-4 bg-slate-50 border border-dashed border-slate-200 text-slate-400 rounded-2xl text-center py-6">
             <span className="text-xl block">👈</span>
             <span className="text-[11px] font-bold block mt-1">Select any grid block on the canvas to customize element-specific styling.</span>
            </div>
          </div>
         )}

         {/* Available Blocks Library */}
         <div className="p-4 bg-slate-100/60 border border-slate-200 rounded-2xl space-y-3">
          <div className="flex justify-between items-center">
           <span className="text-xs font-bold text-slate-700 block uppercase tracking-wider">Block Library</span>
           <button
            type="button"
            onClick={() => handleAddCustomBlock('none', 'Custom Field')}
            className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-[10px] font-bold rounded-lg transition shadow-sm flex items-center gap-1"
           >
            <span>+ Custom Block</span>
           </button>
          </div>
          <p className="text-[10px] text-slate-400">Click (+) to return items back into grid or add custom fields.</p>
          {availableBlocks.length === 0 ? (
           <p className="text-[10px] text-slate-400 italic text-center py-2 bg-white rounded-xl border border-dashed border-slate-150">All default blocks are on stage! Use (+ Custom Block) to add more.</p>
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
                Key: {block.id}
               </span>
              </div>
              <button
               type="button"
               onClick={() => handleToggleBlockVisibility(block.id, true)}
               className="w-6 h-6 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 font-extrabold rounded-lg flex items-center justify-center transition"
               title="Add to canvas"
              >
               +
              </button>
             </div>
            ))}
           </div>
          )}
         </div>
        </div>

        {/* Center Canvas Layout Workspace */}
        <div className="lg:col-span-3 space-y-4">
         <span className="text-xs font-bold text-slate-400 uppercase tracking-widest block text-center">Interactive 12-Column Grid Stage</span>
         
         {/* The actual live-manipulated paper template */}
         <div className="bg-white border border-slate-200 shadow-xl rounded-2xl p-6 md:p-8 min-h-[600px] max-w-[850px] mx-auto space-y-6">
          <div className="grid grid-cols-12 gap-x-4 gap-y-6">
           {activeBlocks.map((block) => {
            const isSelected = block.id === selectedBlockId;
            const blockColClass = `col-span-12 md:col-span-${block.w}`;

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
               {/* Drag handle */}
               <div className="cursor-grab text-[11px] text-slate-400 hover:text-slate-700 px-1 font-semibold" title="Drag to reorder">
                ☰
               </div>
               {/* Width badge */}
               <span className="text-[8px] font-bold text-slate-400 bg-slate-100 px-1 rounded uppercase tracking-wider">
                {block.w}/12 cols
               </span>
               {/* Settings Button */}
               <button
                type="button"
                onClick={(e) => {
                 e.stopPropagation();
                 setSelectedBlockId(block.id);
                }}
                className="text-slate-500 hover:text-indigo-600 p-0.5 rounded text-[10px]"
                title="Block Settings"
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
                title="Remove block"
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
      </div>
     );
    })()
   ) : (
    <div className="space-y-6">
     <div>
      <h3 className="text-sm font-bold text-slate-900">{t('Document Template Engine')}</h3>
      <p className="text-[11px] text-slate-400">Create layouts for Quotations and Invoices. Only ONE template is active globally at a time.</p>
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
         <p className="text-[10px] text-slate-400 mt-2">Page Size: {tmpl.pageSize}</p>
         <p className="text-[10px] text-slate-400 mt-1">Direction: {tmpl.language === 'Arabic' ? 'RTL (Arabic)' : tmpl.language === 'Urdu' ? 'RTL (Urdu)' : 'LTR (English)'}</p>
         
         {/* Print Settings Checks */}
         <div className="mt-3 pt-3 border-t border-slate-100 space-y-1.5">
          <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider block">Quick Print Toggles</span>
          <div className="grid grid-cols-2 gap-x-2 gap-y-1">
           <label className="flex items-center gap-1.5 text-[10px] text-slate-600 cursor-pointer select-none">
            <input
             type="checkbox"
             checked={tmpl.printHeader !== false}
             onChange={() => handleToggleOption(tmpl.id, 'printHeader')}
             className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3 h-3"
            />
            <span>Print Header</span>
           </label>
           <label className="flex items-center gap-1.5 text-[10px] text-slate-600 cursor-pointer select-none">
            <input
             type="checkbox"
             checked={tmpl.printFooter !== false}
             onChange={() => handleToggleOption(tmpl.id, 'printFooter')}
             className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3 h-3"
            />
            <span>Print Footer</span>
           </label>
           <label className="flex items-center gap-1.5 text-[10px] text-slate-600 cursor-pointer select-none">
            <input
             type="checkbox"
             checked={tmpl.printLogo !== false}
             onChange={() => handleToggleOption(tmpl.id, 'printLogo')}
             className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3 h-3"
            />
            <span>Print Logo</span>
           </label>
           <label className="flex items-center gap-1.5 text-[10px] text-slate-600 cursor-pointer select-none">
            <input
             type="checkbox"
             checked={tmpl.printQrCode !== false}
             onChange={() => handleToggleOption(tmpl.id, 'printQrCode')}
             className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3 h-3"
            />
            <span>Print QR Code</span>
           </label>
          </div>
         </div>
        </div>

        <div className="mt-4 pt-3 border-t border-slate-100/60 flex justify-between items-center">
         <div className="flex gap-1.5">
          <button
           type="button"
           onClick={() => handleOpenCanvasDesigner(tmpl)}
           className="text-[10px] font-bold text-slate-600 hover:text-indigo-600 transition flex items-center gap-1 bg-slate-50 hover:bg-indigo-50 px-2.5 py-1 rounded-lg"
          >
           ⚙️ Design
          </button>
          <button
           type="button"
           onClick={() => setPreviewTemplate(tmpl)}
           className="text-[10px] font-bold text-indigo-600 hover:text-indigo-800 transition flex items-center gap-1 bg-indigo-50 hover:bg-indigo-100 px-2.5 py-1 rounded-lg"
          >
           👁️ Preview
          </button>
         </div>
         {!tmpl.isActive ? (
          <button
           type="button"
           onClick={() => handleActivateTemplate(tmpl.id)}
           className="text-[10px] font-bold text-indigo-600 hover:text-indigo-800"
          >
           Set Active
          </button>
         ) : (
          <span className="text-[10px] font-bold text-indigo-600">
           ⭐ Active Default
          </span>
         )}
        </div>
       </div>
      ))}

      {/* Add Template Card */}
      <div className="p-4 rounded-2xl border border-dashed border-slate-300 bg-slate-50 flex flex-col justify-between">
       <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-2">Create Template</h4>
       <form onSubmit={handleAddTemplate} className="space-y-2 text-xs">
        <input
         type="text"
         required
         placeholder="Template Title"
         value={tmplForm.name}
         onChange={(e) => setTmplForm({ ...tmplForm, name: e.target.value })}
         className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
        <select
         value={tmplForm.language}
         onChange={(e) => setTmplForm({ ...tmplForm, language: e.target.value as any })}
         className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1 text-xs text-slate-800 focus:outline-none"
        >
         <option value="English">English (LTR)</option>
         <option value="Arabic">Arabic (RTL)</option>
         <option value="Urdu">Urdu (RTL)</option>
        </select>
        <input
         type="text"
         placeholder="Size: e.g. 4in x 6in, 8in x 11in"
         value={tmplForm.pageSize}
         onChange={(e) => setTmplForm({ ...tmplForm, pageSize: e.target.value })}
         className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1 text-xs text-slate-800 focus:outline-none"
        />
        <button
         type="submit"
         className="w-full bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg py-1.5 font-bold text-xs shadow-sm mt-1"
        >
         Create
        </button>
       </form>
      </div>
     </div>
    </div>
   )}
  </div>
 )}

 {/* TAB: FISCAL MONTHS */}
 {activeTab === 'months' && (
 <div className="space-y-6">
 <div>
 <h3 className="text-sm font-bold text-slate-900">{t('Fiscal Calendar Management')}</h3>
 <p className="text-[11px] text-slate-400">Maintain open/closed fiscal periods. Only one month can be open. Transactions are restricted to the open month.</p>
 </div>

 <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
 {/* List calendar */}
 <div className="md:col-span-2 border border-slate-100 rounded-2xl overflow-hidden shadow-sm">
 <table className="w-full text-xs">
 <thead>
 <tr className="bg-slate-50 text-slate-500">
 <th className="p-3 text-start">Fiscal Month</th>
 <th className="p-3 text-center">Status</th>
 <th className="p-3 text-end">Actions</th>
 </tr>
 </thead>
 <tbody>
 {fiscalMonths.filter(m => m.companyId === db.selectedCompanyId).map(m => (
 <tr key={m.id} className="border-b border-slate-100">
 <td className="p-3 font-semibold text-slate-800">
 {m.name} <span className="text-[10px] text-slate-400 font-mono ms-1">({m.id})</span>
 </td>
 <td className="p-3 text-center">
 <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${
 m.status === 'Open' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-400'
 }`}>
 {m.status === 'Open' ? '🔓 Open' : '🔒 Closed'}
 </span>
 </td>
 <td className="p-3 text-end">
 {m.status === 'Open' ? (
 <button
 onClick={() => handleInitiateClose(m)}
 className="px-2.5 py-1 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-lg font-bold text-[10px] transition"
 >
 Close & Lock Month
 </button>
 ) : (
 <span className="text-[10px] text-slate-400 font-medium">Locked ({m.closedOption === 'paid_only' ? 'Paid' : 'Accrual'})</span>
 )}
 </td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>

 {/* Open New Month form */}
 <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3">Open New Month</h4>
 <form onSubmit={handleOpenMonth} className="space-y-4">
 <p className="text-[11px] text-slate-400">Ensure the currently open month is closed first. Only one month can be open.</p>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Year</label>
 <input
 type="text"
 required
 value={monthForm.year}
 onChange={(e) => setMonthForm({ ...monthForm, year: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none"
 />
 </div>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Month (MM)</label>
 <select
 value={monthForm.month}
 onChange={(e) => setMonthForm({ ...monthForm, month: e.target.value })}
 className="w-full bg-white border border-slate-200 rounded-2xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none"
 >
 <option value="01">January (01)</option>
 <option value="02">February (02)</option>
 <option value="03">March (03)</option>
 <option value="04">April (04)</option>
 <option value="05">May (05)</option>
 <option value="06">June (06)</option>
 <option value="07">July (07)</option>
 <option value="08">August (08)</option>
 <option value="09">September (09)</option>
 <option value="10">October (10)</option>
 <option value="11">November (11)</option>
 <option value="12">December (12)</option>
 </select>
 </div>
 <button
 type="submit"
 disabled={fiscalMonths.some(m => m.status === 'Open' && m.companyId === db.selectedCompanyId)}
 className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white rounded-2xl py-2 font-bold text-xs transition shadow-sm"
 >
 Create Fiscal Period
 </button>
 </form>
 </div>
 </div>
 </div>
 )}

 {/* TAB: STAFF USERS */}
 {activeTab === 'users' && (
 <div className="space-y-6 animate-fade-in">
 {/* Header with Title and Filter info */}
 <div className="bg-slate-50 p-5 rounded-2xl border border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-4">
 <div>
 <h3 className="text-sm font-extrabold text-slate-900 uppercase tracking-wide">{t('Staff Accounts & RBAC Permissions')}</h3>
 <p className="text-[11px] text-slate-500 mt-0.5">Provision user accounts, assign corporate boundaries, and manage dynamic roles and access restrictions.</p>
 </div>
 
 {db.currentUser?.isSuperAdmin ? (
 <div className="flex items-center gap-2 bg-white px-3 py-1.5 rounded-2xl border border-slate-200">
 <span className="text-[10px] font-bold text-slate-500 uppercase shrink-0">Filter Directory:</span>
 <select
 value={userCompanyFilter}
 onChange={(e) => setUserCompanyFilter(e.target.value)}
 className="bg-transparent text-xs font-bold text-slate-700 focus:outline-none cursor-pointer"
 >
 <option value="all">All Organizations</option>
 {db.companies?.map(comp => (
 <option key={comp.id} value={comp.id}>{comp.name}</option>
 ))}
 </select>
 </div>
 ) : (
 <div className="px-3 py-1.5 bg-slate-100 rounded-2xl border border-slate-200/40 text-[10px] font-extrabold text-indigo-700 uppercase flex items-center gap-1">
 🏢 BOUNDED TO: {db.companySetup?.name || 'Current Organization'}
 </div>
 )}
 </div>

 {/* Stats Row */}
 <div className="grid grid-cols-3 gap-4">
 <div className="bg-slate-50/50 p-4 rounded-2xl border border-slate-100">
 <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Total Users</span>
 <p className="text-base font-black text-slate-800 mt-1">{db.users.filter(u => u.isDeleted !== 1).length}</p>
 </div>
 <div className="bg-slate-50/50 p-4 rounded-2xl border border-slate-100">
 <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Active Accounts</span>
 <p className="text-base font-black text-emerald-600 mt-1">
 {db.users.filter(u => u.isDeleted !== 1 && u.isActive !== false).length}
 </p>
 </div>
 <div className="bg-slate-50/50 p-4 rounded-2xl border border-slate-100">
 <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Deactivated</span>
 <p className="text-base font-black text-slate-400 mt-1">
 {db.users.filter(u => u.isDeleted !== 1 && u.isActive === false).length}
 </p>
 </div>
 </div>

 {/* Main side-by-side management layout */}
 <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
 
 {/* COLUMN 1: ALWAYS-VISIBLE ACCOUNT CREATION FORM (Left) */}
 <div ref={formRef} className="lg:col-span-5 bg-white border border-slate-200/60 rounded-2xl p-5 shadow-sm space-y-4">
 <div className="flex justify-between items-start">
 <div>
 <h4 className="text-xs font-extrabold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
 {editingUser ? (
 <>
 <Edit2 className="w-4 h-4 text-amber-600" />
 Update User Account
 </>
 ) : (
 <>
 <Plus className="w-4 h-4 text-indigo-600" />
 Provision New Account
 </>
 )}
 </h4>
 <p className="text-[10px] text-slate-400 mt-0.5">
 {editingUser ? 'Modify active credentials and permissions.' : 'Create a login and assign operational limits.'}
 </p>
 </div>
 {editingUser && (
 <button
 type="button"
 onClick={() => {
 setEditingUser(null);
 setUserForm({
 username: '',
 password: '',
 role: 'user',
 companyId: db.selectedCompanyId,
 roleIds: [],
  });
 }}
 className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg text-[9px] font-bold uppercase transition"
 >
 Cancel Edit
 </button>
 )}
 </div>

 <form onSubmit={handleAddUser} className="space-y-4">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Account Username</label>
 <input
 type="text"
 required
 placeholder="e.g. Accountant Sarah, Sales Tariq"
 value={userForm.username}
 onChange={(e) => setUserForm({ ...userForm, username: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all font-semibold"
 />
 </div>

 <div className="space-y-1">
 <div className="flex items-center justify-between">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Account Password</label>
 {!editingUser && <span className="text-[8px] text-slate-400 font-mono">Defaults to 123456</span>}
 </div>
 <input
 type="text"
 placeholder="e.g. 123456, Tariq@ERP"
 value={userForm.password}
 onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all font-semibold"
 />
 </div>

 <div className="grid grid-cols-2 gap-3">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Account Role</label>
 <select
 value={userForm.role}
 onChange={(e) => setUserForm({ ...userForm, role: e.target.value as UserRole })}
 className="w-full bg-slate-50 border border-slate-200 focus:border-indigo-500 rounded-2xl px-2.5 py-2 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-semibold cursor-pointer"
 >
 <option value="user">Staff Member</option>
 <option value="admin">Company Admin</option>
 </select>
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Assigned Company</label>
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
 🏢 {db.companySetup?.name || 'Scoped Company'}
 </div>
 )}
 </div>
 </div>

 {userForm.role === 'admin' ? (
 <div className="p-3 bg-rose-50 border border-rose-100 rounded-2xl text-[10px] text-rose-800 space-y-1">
 <p className="font-extrabold flex items-center gap-1">⭐ Administrator Access</p>
 <p className="leading-relaxed text-slate-500">
 Company Administrators have unrestricted power to create documents, update setups, and open/close fiscal periods strictly for their assigned company.
 </p>
 </div>
 ) : (
 <div className="space-y-1">
   <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Assigned Roles</label>
   {roles.length === 0 ? (
     <div className="p-3 bg-amber-50 border border-amber-100 rounded-2xl text-[10px] text-amber-800 leading-relaxed">
       No Roles exist yet for this company. Create one in the <strong>Roles</strong> tab before provisioning staff accounts.
     </div>
   ) : (
     <div className="bg-slate-50 border border-slate-200/60 rounded-2xl p-3 space-y-1.5 max-h-48 overflow-y-auto">
       {roles.map(r => (
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
     A user with multiple roles gets the union of every assigned role's permissions — a page granted by more than one role just renders once.
   </p>
 </div>
 )}

 <button
 type="submit"
 className="w-full bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl py-2 font-bold text-xs transition shadow-sm cursor-pointer mt-2"
 >
 {editingUser ? 'Update User Account Details' : 'Provision User Account'}
 </button>
 </form>
 </div>

 {/* COLUMN 2: ACTIVE STAFF DIRECTORY (Right) - High Density Card Layout to eliminate empty space */}
 <div className="lg:col-span-7 space-y-4">
 <div className="bg-white border border-slate-200/60 rounded-2xl p-5 shadow-sm">
 <h4 className="text-xs font-extrabold text-slate-700 uppercase tracking-wider mb-4">
 Active Staff & Admins Directory
 </h4>

 <div className="space-y-3.5">
 {db.users
 .filter(u => u.isDeleted !== 1)
 .filter(u => userCompanyFilter === 'all' || u.companyId === userCompanyFilter)
 .map(u => {
 const userCompanyObj = db.companies?.find(c => c.id === u.companyId);
 const organizationName = u.isSuperAdmin 
 ? 'All Companies (Super)' 
 : (userCompanyObj?.name || u.companyId || 'Default Organization');
 
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
 {u.isSuperAdmin ? 'Super Admin' : u.role === 'admin' ? 'Company Admin' : 'Staff'}
 </span>
 </h5>
 <span className="text-[9px] text-slate-400 font-mono mt-0.5 block">Account ID: {u.id}</span>
 </div>
 </div>

 {/* Actions (Toggle Status & Delete) */}
 <div className="flex items-center gap-1.5">
 {/* Edit details and password button */}
 <button
 type="button"
 onClick={() => {
 setEditingUser(u); formRef.current?.scrollIntoView({ behavior: 'smooth' });
 setUserForm({
 username: u.username,
 password: u.password || '123456',
 role: u.role,
 companyId: u.companyId || db.selectedCompanyId,
  roleIds: (db.userRoles || []).filter(ur => ur.userId === u.id).map(ur => ur.roleId),
                        });
 }}
 className="p-1 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded transition-all cursor-pointer"
 title="Edit details & password"
 >
 <Edit2 className="w-3.5 h-3.5" />
 </button>

 {/* Toggle Button */}
 <button
 type="button"
 onClick={() => handleToggleUserActive(u.id)}
 disabled={u.id === db.currentUser?.id}
 className={`px-2 py-0.5 rounded text-[8px] font-extrabold uppercase transition-all tracking-wider flex items-center gap-1.5 border cursor-pointer select-none ${
 isActive
 ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
 : 'bg-slate-100 text-slate-400 border-slate-200 hover:bg-slate-200'
 } disabled:opacity-50 disabled:cursor-not-allowed`}
 title={u.id === db.currentUser?.id ? 'You cannot suspend yourself' : 'Toggle status'}
 >
 <span className={`w-1 h-1 rounded-full ${isActive ? 'bg-emerald-500' : 'bg-slate-400'}`}></span>
 {isActive ? 'Active' : 'Disabled'}
 </button>

 {/* Delete button */}
 <button
 type="button"
 onClick={() => handleDeleteUser(u.id)}
 disabled={u.id === db.currentUser?.id}
 className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded transition-all cursor-pointer disabled:opacity-30"
 title={u.id === db.currentUser?.id ? 'Active session' : 'Remove account'}
 >
 <Trash2 className="w-3.5 h-3.5" />
 </button>
 </div>
 </div>

 {/* Card Middle Row: Scoped Organization */}
 <div className="flex items-center gap-1.5 bg-white p-2 rounded-lg border border-slate-150/40 text-[10px] text-slate-600">
 <span className="font-bold text-slate-400 uppercase text-[9px]">Assigned Company:</span>
 <span className="font-extrabold text-slate-900 flex items-center gap-1">
 🏢 {organizationName}
 </span>
 </div>

 {/* Card Middle Row 2: Credentials & Access */}
 <div className="flex items-center gap-1.5 bg-white p-2 rounded-lg border border-slate-150/40 text-[10px] text-slate-600">
 <span className="font-bold text-slate-400 uppercase text-[9px]">Sign-in Credentials:</span>
 <span className="font-extrabold text-slate-900 flex items-center gap-1 font-mono text-[9px] bg-slate-50 px-1 py-0.5 rounded border border-slate-100">
 <Key className="w-3 h-3 text-slate-400" />
 Password: {u.password || '123456'}
 </span>
 </div>

 {/* Card Bottom Row: Assigned roles */}
 <div className="pt-2 border-t border-slate-100 flex flex-wrap gap-1 items-center">
 <span className="text-[9px] font-bold text-slate-400 uppercase me-1">RBAC Scope:</span>
 {u.role === 'admin' || u.isSuperAdmin ? (
 <span className="px-1.5 py-0.5 bg-rose-50 text-rose-700 text-[8px] font-bold uppercase rounded">Full Authority</span>
 ) : (() => {
 const assignedRoleIds = new Set((db.userRoles || []).filter(ur => ur.userId === u.id).map(ur => ur.roleId));
 const assignedRoles = roles.filter(r => assignedRoleIds.has(r.id));
 return assignedRoles.length > 0 ? (
 <>
 {assignedRoles.map(r => (
 <span key={r.id} className="px-1.5 py-0.5 bg-indigo-50 text-indigo-700 text-[8px] font-semibold rounded">{r.name}</span>
 ))}
 </>
 ) : (
 <span className="px-1.5 py-0.5 bg-rose-50 text-rose-700 text-[8px] font-bold uppercase rounded">No Role Assigned</span>
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
 <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wide">Roles</h3>
 <p className="text-[11px] text-slate-400 mt-0.5">
 Define reusable, company-scoped permission sets. Assign one or more roles to a staff account instead of configuring permissions per user — a user's effective access is the union of every role they hold.
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
 {roleForm.id ? 'Edit Role' : 'Create New Role'}
 </h4>
 {roleForm.id && (
 <button
 type="button"
 onClick={() => { setRoleForm({ id: null, name: '', permissions: {} }); setEditingRole(null); }}
 className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg text-[9px] font-bold uppercase transition"
 >
 Cancel Edit
 </button>
 )}
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Role Name</label>
 <input
 type="text"
 required
 placeholder="e.g. Sales Rep, Cashier, Procurement Officer"
 value={roleForm.name}
 onChange={(e) => setRoleForm(prev => ({ ...prev, name: e.target.value }))}
 className="w-full bg-slate-50 border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-semibold"
 />
 </div>

 <PermissionTree
 permissions={roleForm.permissions}
 onChange={(updated) => setRoleForm(prev => ({ ...prev, permissions: updated }))}
 />

 <button
 type="submit"
 className="w-full bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl py-2 font-bold text-xs transition shadow-sm cursor-pointer"
 >
 {roleForm.id ? 'Update Role' : 'Create Role'}
 </button>
 </form>
 </div>

 {/* COLUMN 2: ROLE LIST */}
 <div className="lg:col-span-7 space-y-4">
 <div className="bg-white border border-slate-200/60 rounded-2xl p-5 shadow-sm">
 <h4 className="text-xs font-extrabold text-slate-700 uppercase tracking-wider mb-4">
 Roles for {db.companySetup?.name || 'this company'} ({roles.length})
 </h4>
 <div className="space-y-2.5">
 {roles.length === 0 && (
 <p className="text-xs text-slate-400 italic py-6 text-center">No roles created yet.</p>
 )}
 {roles.map(r => {
 const assignedCount = (db.userRoles || []).filter(ur => ur.roleId === r.id).length;
 return (
 <div key={r.id} className="p-3 bg-slate-50 border border-slate-200/60 rounded-2xl flex items-center justify-between gap-3">
 <div className="min-w-0">
 <p className="text-xs font-bold text-slate-800 truncate">{r.name}</p>
 <p className="text-[10px] text-slate-400">{assignedCount} user{assignedCount === 1 ? '' : 's'} assigned</p>
 </div>
 <div className="flex items-center gap-1.5 shrink-0">
 <button
 type="button"
 onClick={() => { setEditingRole(r); setRoleForm({ id: r.id, name: r.name, permissions: r.permissions || {} }); }}
 className="p-1.5 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-all cursor-pointer"
 title="Edit role"
 >
 <Edit2 className="w-3.5 h-3.5" />
 </button>
 {confirmDeleteRoleId === r.id ? (
 <>
 <button type="button" onClick={() => handleDeleteRole(r.id)} className="px-2 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-[10px] font-bold transition">Confirm</button>
 <button type="button" onClick={() => setConfirmDeleteRoleId(null)} className="px-2 py-1 bg-slate-200 hover:bg-slate-300 text-slate-600 rounded-lg text-[10px] font-bold transition">Cancel</button>
 </>
 ) : (
 <button
 type="button"
 onClick={() => setConfirmDeleteRoleId(r.id)}
 className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-all cursor-pointer"
 title="Delete role"
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
 <p className="text-[11px] text-slate-400 mt-0.5">Manage capital investors, register equity percentages, and record official cash injections into your corporate bank accounts.</p>
 </div>

 <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
 
 {/* COLUMN 1: LEFT SIDE (Form & Registry) */}
 <div className="lg:col-span-5 space-y-6">
 
 {/* Registration form */}
 <div className="bg-slate-50 border border-slate-100 p-5 rounded-2xl">
 <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-4 flex items-center gap-1.5">
 <Plus className="w-4 h-4 text-indigo-600" />
 Register New Investor
 </h4>
 
 <form onSubmit={handleAddInvestor} className="space-y-3">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Investor Name</label>
 <input
 type="text"
 required
 placeholder="e.g. Abdullah bin Jameel"
 value={investorForm.name}
 onChange={(e) => setInvestorForm({ ...investorForm, name: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Assigned Company</label>
 <div className="w-full bg-slate-100 border border-slate-200 rounded-2xl px-3 py-2 text-xs text-slate-500 font-bold overflow-hidden text-ellipsis whitespace-nowrap">
 🏢 {db.companySetup?.name || 'Scoped Company'}
 </div>
 </div>

 <div className="grid grid-cols-2 gap-3">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Contact Phone</label>
 <input
 type="text"
 placeholder="e.g. +966 50..."
 value={investorForm.phone}
 onChange={(e) => setInvestorForm({ ...investorForm, phone: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Email Address</label>
 <input
 type="email"
 placeholder="e.g. abdullah@invest.sa"
 value={investorForm.email}
 onChange={(e) => setInvestorForm({ ...investorForm, email: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>
 </div>

 <div className="grid grid-cols-2 gap-3">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Equity Share (%)</label>
 <input
 type="number"
 step="0.01"
 required
 min="0"
 max="100"
 placeholder="e.g. 50"
 value={investorForm.equityPercentage}
 onChange={(e) => setInvestorForm({ ...investorForm, equityPercentage: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Profit Share (%)</label>
 <input
 type="number"
 step="0.01"
 min="0"
 max="100"
 placeholder="Defaults to Equity %"
 value={investorForm.profitPercentage}
 onChange={(e) => setInvestorForm({ ...investorForm, profitPercentage: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Notes</label>
 <textarea
 rows={2}
 placeholder="Agreement details, transfer parameters..."
 value={investorForm.notes}
 onChange={(e) => setInvestorForm({ ...investorForm, notes: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
 />
 </div>

 <button
 type="submit"
 className="w-full bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl py-2 font-bold text-xs transition shadow-sm mt-2"
 >
 Add Investor to Registry
 </button>
 </form>
 </div>

 {/* Registered Investor Directory */}
 <div className="bg-white border border-slate-200/60 rounded-2xl p-5">
 <div className="flex flex-col gap-2.5 mb-4 pb-2 border-b border-slate-100">
 <div className="flex justify-between items-center">
 <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider">Investor Shareholding Directory</h4>
 </div>
 </div>
 
 {(() => {
 const filteredInvestors = db.investors.filter(inv => {
 return (inv.companyId) === (db.selectedCompanyId);
 });

 if (filteredInvestors.length === 0) {
 return (
 <div className="text-center py-6 text-slate-400 text-xs">
 No investors registered for the selected company scope.
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

 const assignedCompanyName = db.companies?.find(c => c.id === inv.companyId)?.name || 'Scoped Company';

 return (
 <div key={inv.id} className="pt-3 first:pt-0">
 <div className="flex justify-between items-start">
 <div>
 <span className="font-extrabold text-slate-900 text-xs">{inv.name}</span>
 <div className="text-[10px] text-slate-400 space-x-2 mt-0.5 flex flex-wrap items-center gap-y-1">
 <span>{inv.phone || 'No Phone'}</span>
 <span>•</span>
 <span>{inv.email || 'No Email'}</span>
 <span>•</span>
 <span className="inline-flex items-center gap-1 font-bold text-slate-600 bg-slate-50 border border-slate-100 px-1.5 py-0.5 rounded-full text-[9px] uppercase tracking-wide">
 🏢 {assignedCompanyName}
 </span>
 </div>
 </div>
 <div className="flex flex-col items-end gap-1">
 <span className="bg-indigo-50 text-indigo-700 font-extrabold text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap">
 {inv.equityPercentage}% Equity
 </span>
 <span className="bg-emerald-50 text-emerald-700 font-extrabold text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap">
 {inv.profitPercentage ?? inv.equityPercentage}% Profit
 </span>
 </div>
 </div>
 
 <div className="flex justify-between items-center mt-2.5 bg-slate-50/50 p-2 rounded-lg border border-slate-100">
 <span className="text-[9px] font-extrabold text-slate-400 uppercase tracking-wider">Total Funded Capital:</span>
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
 Record Capital Contribution (Cash Injection)
 </h4>

 {!db.investors || db.investors.length === 0 ? (
 <div className="bg-amber-50 text-amber-800 p-3 rounded-2xl text-xs border border-amber-100 leading-relaxed">
 Please register at least one investor in the Shareholding Directory first before recording capital investments.
 </div>
 ) : (
 <form onSubmit={handleAddInvestment} className="space-y-4">
 <div className="grid grid-cols-2 gap-4">
 <div className="space-y-1.5">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Select Investor</label>
 <select
 required
 value={investmentForm.investorId}
 onChange={(e) => setInvestmentForm({ ...investmentForm, investorId: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 focus:outline-none"
 >
 <option value="">-- Choose Investor --</option>
 {db.investors.map(inv => (
 <option key={inv.id} value={inv.id}>{inv.name} ({inv.equityPercentage}%)</option>
 ))}
 </select>
 </div>

 <div className="space-y-1.5">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Target Bank Account (Debit Account)</label>
 <select
 required
 value={investmentForm.bankId}
 onChange={(e) => setInvestmentForm({ ...investmentForm, bankId: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 focus:outline-none"
 >
 <option value="">-- Choose Account --</option>
 {db.banks.filter(b => b.isActive).map(b => (
 <option key={b.id} value={b.id}>{b.bankName} - {b.accountTitle}</option>
 ))}
 </select>
 </div>

 <div className="space-y-1.5">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Injection Amount ({currencySymbol})</label>
 <input
 type="number"
 step="0.01"
 required
 min="1"
 placeholder="e.g. 50000.00"
 value={investmentForm.amount}
 onChange={(e) => setInvestmentForm({ ...investmentForm, amount: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 focus:outline-none"
 />
 </div>

 <div className="space-y-1.5">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Date Received</label>
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
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Transaction Description / Notes</label>
 <input
 type="text"
 required
 placeholder="e.g. Seed investment, round A funding transfer..."
 value={investmentForm.description}
 onChange={(e) => setInvestmentForm({ ...investmentForm, description: e.target.value })}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-2xl px-3 py-2 text-xs text-slate-800 focus:outline-none"
 />
 </div>

 <button
 type="submit"
 className="w-full bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl py-2.5 font-bold text-xs transition shadow-sm"
 >
 Process Investment (Generate Receipt Voucher)
 </button>
 </form>
 )}
 </div>

 {/* Investment Cash Contribution Log */}
 <div className="bg-white border border-slate-200/60 rounded-2xl p-5">
 <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-4">Investment Contribution Receipt Log</h4>

 {db.vouchers.filter(v => v.referenceType === 'Equity').length === 0 ? (
 <div className="text-center py-8 text-slate-400 text-xs">
 No capital contributions processed yet.
 </div>
 ) : (
 <div className="overflow-x-auto">
 <table className="w-full text-start text-xs">
 <thead>
 <tr className="border-b border-slate-100 text-slate-400">
 <th className="py-2 font-bold uppercase text-[9px] tracking-wider">Voucher No</th>
 <th className="py-2 font-bold uppercase text-[9px] tracking-wider">Date</th>
 <th className="py-2 font-bold uppercase text-[9px] tracking-wider">Investor</th>
 <th className="py-2 font-bold uppercase text-[9px] tracking-wider">Bank Account</th>
 <th className="py-2 font-bold uppercase text-[9px] tracking-wider">Description</th>
 <th className="py-2 text-end font-bold uppercase text-[9px] tracking-wider">Amount</th>
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
 <td className="py-3 font-semibold text-slate-900">{investor?.name || 'Unknown'}</td>
 <td className="py-3 text-slate-600 font-medium">{bank?.bankName || 'Unknown Bank'}</td>
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

   const updateTranslationItem = (id: string, updatedFields: Partial<any>) => {
     const newArr = (db.translations || []).map(item => {
       if (item.id === id) {
         return { ...item, ...updatedFields };
       }
       return item;
     });
     onUpdateDb({ ...db, translations: newArr });
   };

   const handleAutoTranslate = async () => {
     setIsTranslating(true);
     try {
       const response = await fetch('/api/translate-all', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ translations: db.translations })
       });
       if (!response.ok) {
         throw new Error(await response.text() || 'Failed to auto-translate');
       }
       const data = await response.json();
       if (data && Array.isArray(data.translations)) {
         onUpdateDb({ ...db, translations: data.translations });
         triggerSuccess('Automated dictionary translations populated successfully!');
       } else {
         throw new Error('Invalid response structure');
       }
     } catch (err: any) {
       console.error(err);
       triggerError(`Translation failed: ${err.message}`);
     } finally {
       setIsTranslating(false);
     }
   };

   const filteredTranslations = (db.translations || []).filter(t => {
     const search = transSearchQuery.toLowerCase();
     const keyMatch = t.key.toLowerCase().includes(search);
     const enMatch = (t.en || '').toLowerCase().includes(search);
     const arMatch = (t.ar || '').toLowerCase().includes(search);
     const urMatch = (t.ur || '').toLowerCase().includes(search);
     const matchesSearch = !transSearchQuery || keyMatch || enMatch || arMatch || urMatch;

     if (!matchesSearch) return false;
     if (transFilterModule === 'All') return true;
     return getTranslationModule(t.key) === transFilterModule;
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
           <p className="text-sm text-slate-500 font-medium mt-1">Manage global English, Arabic, and Urdu UX translations.</p>
         </div>
         <div className="flex items-center gap-3 self-end">
           <button
             type="button"
             disabled={isTranslating}
             onClick={handleAutoTranslate}
             className={`px-4 py-2 rounded-2xl text-xs font-bold flex items-center gap-2 shadow-sm transition-all duration-150 ${isTranslating ? 'bg-amber-100 text-amber-700 cursor-not-allowed' : 'bg-amber-500 text-white hover:bg-amber-600'}`}
           >
             <Sparkles className={`w-4 h-4 ${isTranslating ? 'animate-spin' : ''}`} />
             {isTranslating ? 'Translating via Google/Gemini...' : 'Auto-Translate (Google/Gemini)'}
           </button>
           <button
             type="button"
             onClick={() => {
                setTransSearchQuery('');
                setTransFilterModule('All');
                const newId = generateId();
                const newArr = [...(db.translations || []), { id: newId, key: 'New Key', en: '', ar: '', ur: '' }];
                onUpdateDb({ ...db, translations: newArr });
                triggerSuccess('New translation key added at the bottom of the list! Scroll down to edit.');
              }}
             className="bg-indigo-600 text-white px-4 py-2 rounded-2xl text-xs font-bold hover:bg-indigo-700 shadow-sm flex items-center gap-1.5"
           >
             <Plus className="w-4 h-4 shrink-0" /> Add Translation
           </button>
         </div>
       </div>

       {/* Dynamic Filters Section */}
       <div className="bg-slate-50 border border-slate-200/60 rounded-2xl p-4 flex flex-col sm:flex-row items-center gap-4">
         <div className="w-full sm:w-1/3 relative">
           <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
           <input
             type="text"
             placeholder="Search translation key or values..."
             value={transSearchQuery}
             onChange={(e) => setTransSearchQuery(e.target.value)}
             className="w-full pl-9 pr-4 py-2 bg-white border border-slate-200 rounded-xl text-xs font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
           />
         </div>
         <div className="w-full sm:w-1/3 flex items-center gap-2">
           <label className="text-xs font-bold text-slate-600 shrink-0">Form/Module:</label>
           <select
             value={transFilterModule}
             onChange={(e) => setTransFilterModule(e.target.value)}
             className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
           >
             {modules.map(mod => (
               <option key={mod} value={mod}>{mod === 'All' ? 'All Modules / Forms' : mod}</option>
             ))}
           </select>
         </div>
         <div className="w-full sm:w-1/3 text-end text-xs text-slate-500 font-medium sm:ml-auto">
           Showing <strong className="text-slate-800 font-bold">{filteredTranslations.length}</strong> of <strong className="text-indigo-600 font-bold">{(db.translations || []).length}</strong> keys
         </div>
       </div>

       <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
         <table className="w-full text-start text-xs">
           <thead className="bg-slate-50 border-b border-slate-100 text-[10px] font-extrabold text-slate-500 uppercase tracking-wider">
             <tr>
               <th className="p-3 w-[25%] text-left">UX Key</th>
               <th className="p-3 w-[25%] text-left">English</th>
               <th className="p-3 w-[22%] text-left">Arabic (ar)</th>
               <th className="p-3 w-[22%] text-left">Urdu (ur)</th>
               <th className="p-3 w-[6%] text-end">Action</th>
             </tr>
           </thead>
           <tbody>
             {filteredTranslations.map((t) => (
               <tr key={t.id} className="border-b border-slate-50 hover:bg-slate-50/50">
                 <td className="p-2">
                   <input 
                     value={t.key} 
                     onChange={(e) => updateTranslationItem(t.id, { key: e.target.value })} 
                     className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-indigo-500 text-slate-700" 
                   />
                   <span className="text-[9px] text-indigo-500 font-mono pl-1 mt-0.5 block">{getTranslationModule(t.key)}</span>
                 </td>
                 <td className="p-2">
                   <input 
                     value={t.en} 
                     onChange={(e) => updateTranslationItem(t.id, { en: e.target.value })} 
                     className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-500" 
                   />
                 </td>
                 <td className="p-2">
                   <input 
                     value={t.ar} 
                     dir="rtl"
                     onChange={(e) => updateTranslationItem(t.id, { ar: e.target.value })} 
                     className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-sans" 
                   />
                 </td>
                 <td className="p-2">
                   <input 
                     value={t.ur}
                     dir="rtl"
                     onChange={(e) => updateTranslationItem(t.id, { ur: e.target.value })} 
                     className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-sans" 
                   />
                 </td>
                 <td className="p-2 text-end">
                   <button
                     type="button"
                     onClick={() => {
                       const newArr = db.translations.filter(tr => tr.id !== t.id);
                       onUpdateDb({ ...db, translations: newArr });
                     }}
                     className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition"
                   >
                     <Trash2 className="w-4 h-4" />
                   </button>
                 </td>
               </tr>
             ))}
           </tbody>
         </table>
         {filteredTranslations.length === 0 && (
           <div className="p-12 text-center text-slate-400 font-medium flex flex-col items-center justify-center gap-2">
             <Languages className="w-8 h-8 text-slate-300" />
             <span>No translations match the selected filter or search.</span>
           </div>
         )}
       </div>
     </div>
   );
 })()}

 {activeTab === 'database' && (
 <div className="space-y-6 animate-fade-in">
 <div>
 <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wide">{t('Database Portability & Backup')}</h3>
 <p className="text-[11px] text-slate-400 mt-0.5">Export, import, or copy your entire database state to easily transfer configurations, profiles, and transactions to other testers or backup slots.</p>
 </div>

 <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100 space-y-6">
 
 {/* Export Card */}
 <div className="space-y-3">
 <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-2">
 <Download className="w-4 h-4 text-indigo-500" /> Export Database
 </h4>
 <p className="text-xs text-slate-500 ">
 Generate and download a JSON file containing all companies, users, settings, invoices, and transaction logs. This file can be shared with other users to restore your exact current system setup.
 </p>
 <div className="flex flex-wrap gap-2.5">
 <button
 onClick={handleExportDb}
 className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl text-xs font-bold transition flex items-center gap-2 cursor-pointer shadow-md shadow-indigo-600/10 animate-fade-in"
 >
 <Download className="w-4 h-4" /> Download PostgreSQL Backup (.sql)
 </button>
 {db.currentUser?.isSuperAdmin && (
 <button
 onClick={handleDownloadSourceCode}
 disabled={downloadingZip}
 className="px-4 py-2.5 bg-amber-600 hover:bg-amber-500 text-white rounded-2xl text-xs font-bold transition flex items-center gap-2 cursor-pointer shadow-md shadow-amber-600/10 animate-fade-in disabled:opacity-50 disabled:cursor-not-allowed"
 >
 <Download className="w-4 h-4" /> {downloadingZip ? 'Zipping...' : 'Download Source Code ZIP'}
 </button>
 )}
 <button
 onClick={handleCopyToClipboard}
 className="px-4 py-2.5 bg-slate-200 hover:bg-slate-300 :bg-slate-700 text-slate-700 rounded-2xl text-xs font-bold transition flex items-center gap-2 cursor-pointer"
 >
 <Copy className="w-4 h-4" /> {copied ? 'Copied to Clipboard!' : 'Copy Database JSON String'}
 </button>
 <button
 onClick={handleForcePushToCloud}
 className="px-4 py-2.5 bg-amber-600 hover:bg-amber-500 text-white rounded-2xl text-xs font-bold transition flex items-center gap-2 cursor-pointer shadow-md shadow-amber-600/10"
 >
 <Upload className="w-4 h-4" /> Force Publish Local to Cloud
 </button>
 </div>
 </div>

 <hr className="border-slate-200/40 " />

 {/* Import Card */}
 <div className="space-y-3">
 <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-2">
 <Upload className="w-4 h-4 text-indigo-500" /> Import Database Setup
 </h4>
 <p className="text-xs text-slate-500 ">
 Import an existing JSON backup to completely replace the active database setup in this browser. Warning: Importing a backup replaces all current transactions, companies, and user lists.
 </p>
 
 <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
 {/* File import element */}
 <div className="border border-slate-200 rounded-2xl p-5 bg-white flex flex-col items-center justify-center text-center gap-3">
 <div className="p-3 bg-indigo-50 rounded-2xl text-indigo-500">
 <Upload className="w-5 h-5" />
 </div>
 <div>
 <p className="text-xs font-bold text-slate-800 ">Import .json / .xml File</p>
 <p className="text-[10px] text-slate-400 mt-0.5">Select a database backup file to apply immediately</p>
 </div>
 <label className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl text-xs font-bold transition cursor-pointer select-none">
 <span>Browse Backup File...</span>
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
 <p className="text-xs font-bold text-slate-800 ">Paste Database JSON String</p>
 <textarea
 placeholder='Paste raw JSON string here...'
 value={pastedJson}
 onChange={(e) => setPastedJson(e.target.value)}
 className="w-full h-24 bg-slate-50 border border-slate-200 rounded-2xl p-2.5 text-[10px] text-slate-800 placeholder-slate-400 font-mono focus:outline-none focus:border-indigo-500"
 />
 <button
 onClick={handleImportPasted}
 disabled={!pastedJson.trim()}
 className="w-full bg-slate-800 hover:bg-slate-700 disabled:bg-slate-200 :bg-slate-800/50 disabled:text-slate-400 text-white rounded-2xl py-2 text-xs font-bold transition cursor-pointer flex items-center justify-center gap-1.5"
 >
 <Check className="w-3.5 h-3.5" /> Apply Pasted Backup
 </button>
 </div>
 </div>
 </div>

 <hr className="border-slate-200/40 " />

 {/* Truncate Card */}
 <div className="space-y-3">
 <h4 className="text-xs font-bold text-rose-600 uppercase tracking-wider flex items-center gap-2">
 <AlertTriangle className="w-4 h-4 text-rose-500 animate-pulse" /> Truncate Transactions (Dev/Testing Tool)
 </h4>
 <p className="text-xs text-slate-500 ">
 Immediately wipe and truncate all active transactional data—including all <span className="font-bold">quotations, invoices, expenses, recurring postings, and vouchers</span>—and reset the sequence counters back to 1001. This is highly useful for cleaning up test records before going live or running new test cycles.
 </p>
 <div>
 <button
 onClick={() => setIsConfirmingTruncate(true)}
 className="px-4 py-2.5 bg-rose-600 hover:bg-rose-500 text-white rounded-2xl text-xs font-bold transition flex items-center gap-2 cursor-pointer shadow-md shadow-rose-600/10"
 >
 <Trash2 className="w-4 h-4" /> Truncate & Reset Transaction Data
 </button>
 </div>
 </div>

 <hr className="border-slate-200/40 " />

 {/* Audit Logging & Purge Card */}
 <div className="space-y-4">
   <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
     <div>
       <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-2">
         <Database className="w-4 h-4 text-indigo-500" /> System Audit Trails
       </h4>
       <p className="text-xs text-slate-500 mt-1">
         Monitor and audit actions performed by users across all companies. Includes logins, creations, updates, and deletions.
       </p>
     </div>
     <button
       onClick={() => setIsConfirmingPurge(true)}
       className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-2xl text-xs font-bold transition flex items-center gap-2 cursor-pointer shadow-sm"
     >
       <Trash2 className="w-3.5 h-3.5 text-rose-400" /> Purge Logs (&gt; 1 Year)
     </button>
   </div>

   {/* Filter & Search Bar */}
   <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5 bg-white p-3 rounded-2xl border border-slate-100">
     <input
       type="text"
       placeholder="Search by user or details..."
       value={auditSearch}
       onChange={(e) => setAuditSearch(e.target.value)}
       className="px-3 py-2 border border-slate-200 rounded-xl text-xs focus:outline-none focus:border-indigo-500"
     />
     <input
       type="text"
       placeholder="Filter by Action (e.g. LOGIN)"
       value={auditActionFilter}
       onChange={(e) => setAuditActionFilter(e.target.value)}
       className="px-3 py-2 border border-slate-200 rounded-xl text-xs focus:outline-none focus:border-indigo-500"
     />
     <input
       type="text"
       placeholder="Filter by Entity (e.g. invoice)"
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
       {isLoadingAudit ? 'Loading...' : 'Fetch Logs'}
     </button>
   </div>

   {/* Audit Table */}
   <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden max-h-[350px] overflow-y-auto shadow-sm">
     <table className="w-full text-start text-xs border-collapse">
       <thead>
         <tr className="bg-slate-50 border-b border-slate-200 text-[10px] font-bold text-slate-400 uppercase tracking-wider text-start">
           <th className="px-4 py-2.5 text-start font-bold">Timestamp</th>
           <th className="px-4 py-2.5 text-start font-bold">User</th>
           <th className="px-4 py-2.5 text-start font-bold">Action</th>
           <th className="px-4 py-2.5 text-start font-bold">Entity Type</th>
           <th className="px-4 py-2.5 text-start font-bold">IP Address</th>
           <th className="px-4 py-2.5 text-start font-bold">Details / Metadata</th>
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
               No audit logs found. Click "Fetch Logs" to view or search the audit trail.
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

 {/* Purge Audit Logs Confirmation Modal */}
  {isConfirmingPurge && (
    <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex justify-center items-center p-4 overflow-y-auto animate-fade-in">
      <div className="bg-white rounded-2xl border border-slate-100 shadow-2xl p-6 w-full max-w-md">
        <div className="flex items-center gap-2 text-amber-600 mb-2">
          <AlertTriangle className="w-5 h-5 animate-pulse" />
          <h3 className="text-lg font-bold">Purge Old Audit Logs</h3>
        </div>
        <p className="text-sm text-slate-600 mb-6 font-medium leading-relaxed">
          Are you sure you want to purge all system audit logs older than <strong>1 year</strong>?
          <br /><br />
          This action will permanently delete historical user logs while safely retaining the most recent 365 days of data to prevent database bloat. This action is irreversible.
        </p>
        <div className="flex justify-end gap-3 mt-6">
          <button
            onClick={() => setIsConfirmingPurge(false)}
            className="px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-100 rounded-2xl transition cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handlePurgeAuditLogs}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-sm font-bold rounded-2xl transition shadow-sm cursor-pointer"
          >
            Yes, Purge Old Logs
          </button>
        </div>
      </div>
    </div>
  )}

 {/* Truncate Confirmation Modal */}
 {isConfirmingTruncate && (
 <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex justify-center items-center p-4 overflow-y-auto">
 <div className="bg-white rounded-2xl border border-slate-100 shadow-2xl p-6 w-full max-w-lg my-auto">
 <div className="flex items-center gap-2 text-rose-600 mb-2">
 <AlertTriangle className="w-5 h-5" />
 <h3 className="text-lg font-bold">Confirm Truncate Transactions</h3>
 </div>
 <p className="text-sm text-slate-600 mb-6 font-medium leading-relaxed">
 Are you absolutely sure you want to truncate all quotations, invoices, expenses, recurring postings, and vouchers for <strong>{db.companies?.find(c => c.id === (db.selectedCompanyId))?.name || 'Selected Company'}</strong>?
 <br /><br />
 This action is <span className="font-bold text-rose-600">permanent</span> and will synchronize across all environments immediately.
 </p>
 <div className="flex justify-end gap-3 mt-6">
 <button
 onClick={() => setIsConfirmingTruncate(false)}
 className="px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-100 rounded-2xl transition cursor-pointer"
 >
 Cancel
 </button>
 <button
 onClick={() => {
 setIsConfirmingTruncate(false);
 handleTruncateTransactions();
 }}
 className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white text-sm font-bold rounded-2xl transition shadow-sm cursor-pointer"
 >
 Yes, Truncate Data
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
 <h3 className="text-lg font-bold">Delete User Account</h3>
 </div>
 <p className="text-sm text-slate-600 mb-6 font-medium leading-relaxed">
 Are you sure you want to permanently delete user "{db.users.find(u => u.id === confirmDeleteUserId)?.username}"? 
 <br /><br />
 This action cannot be undone.
 </p>
 <div className="flex justify-end gap-3 mt-6">
 <button
 onClick={() => setConfirmDeleteUserId(null)}
 className="px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-100 rounded-2xl transition cursor-pointer"
 >
 Cancel
 </button>
 <button
 onClick={executeDeleteUser}
 className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white text-sm font-bold rounded-2xl transition shadow-sm cursor-pointer"
 >
 Yes, Delete User
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
 <h3 className="font-bold text-base">Close Month & Lock Period: {isClosingMonth.name}</h3>
 </div>
 <p className="text-xs text-slate-500 mb-4">
 Closing a fiscal month is permanent. Once closed, you will not be able to create, edit, or delete any transactions within this period.
 </p>

 {/* P&L calculation results */}
 <div className="bg-slate-50 border border-slate-100 p-4 rounded-2xl mb-4 space-y-3">
 <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Month-End P&L Summary Report</h4>
 
 <div className="grid grid-cols-2 gap-4">
 <div className="p-3 bg-white border border-slate-200/60 rounded-2xl text-xs">
 <p className="font-bold text-slate-800">Option A (Paid Basis)</p>
 <p className="text-[10px] text-slate-400 mt-0.5">Based on settled payments only</p>
 <div className="mt-2 space-y-1">
 <div className="flex justify-between">
 <span>Total Rev:</span>
 <span className="font-medium text-emerald-600">{currencySymbol} {calculateMonthPnL(db, isClosingMonth.id).paid.revenue.toFixed(2)}</span>
 </div>
 <div className="flex justify-between">
 <span>Total Exp:</span>
 <span className="font-medium text-rose-600">{currencySymbol} {calculateMonthPnL(db, isClosingMonth.id).paid.expenses.toFixed(2)}</span>
 </div>
 <div className="flex justify-between font-bold border-t border-slate-100 pt-1 mt-1">
 <span>Net P&L:</span>
 <span className={calculateMonthPnL(db, isClosingMonth.id).paid.net >= 0 ? 'text-emerald-700' : 'text-rose-700'}>
 {currencySymbol} {calculateMonthPnL(db, isClosingMonth.id).paid.net.toFixed(2)}
 </span>
 </div>
 </div>
 </div>

 <div className="p-3 bg-white border border-slate-200/60 rounded-2xl text-xs">
 <p className="font-bold text-slate-800">Option B (Including Pending)</p>
 <p className="text-[10px] text-slate-400 mt-0.5">Includes outstanding receivables/payables</p>
 <div className="mt-2 space-y-1">
 <div className="flex justify-between">
 <span>Total Rev:</span>
 <span className="font-medium text-emerald-600">{currencySymbol} {calculateMonthPnL(db, isClosingMonth.id).includingPending.revenue.toFixed(2)}</span>
 </div>
 <div className="flex justify-between">
 <span>Total Exp:</span>
 <span className="font-medium text-rose-600">{currencySymbol} {calculateMonthPnL(db, isClosingMonth.id).includingPending.expenses.toFixed(2)}</span>
 </div>
 <div className="flex justify-between font-bold border-t border-slate-100 pt-1 mt-1">
 <span>Net P&L:</span>
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
 <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">Select P&L View to Finalize Ledger</label>
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
 <p className="text-xs font-bold text-slate-800">Finalize on Option A (Paid Basis)</p>
 <p className="text-[10px] text-slate-500">Net Profit of {currencySymbol} {calculateMonthPnL(db, isClosingMonth.id).paid.net.toFixed(2)} will be permanently archived.</p>
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
 <p className="text-xs font-bold text-slate-800">Finalize on Option B (Including Pending)</p>
 <p className="text-[10px] text-slate-500">Net Profit of {currencySymbol} {calculateMonthPnL(db, isClosingMonth.id).includingPending.net.toFixed(2)} will be permanently archived.</p>
 </div>
 </label>
 </div>
 </div>

 <div className="flex justify-end gap-2.5">
 <button
 onClick={() => setIsClosingMonth(null)}
 className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-500 rounded-lg text-xs font-semibold transition"
 >
 Cancel
 </button>
 <button
 onClick={handleConfirmClose}
 className="px-4 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold transition shadow-sm"
 >
 Permanently Lock Month
 </button>
 </div>
 </div>
 </div>
 )}

 {/* PREVIEW TEMPLATE MODAL */}
 {previewTemplate && (
  <DocumentRenderer
   documentType="Invoice"
   data={{
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
   }}
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
