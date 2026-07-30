import React from 'react';
import { useTranslation } from '../hooks';
import { DatabaseState, saveDatabase, getActiveOpenMonth, saveExpense, markExpensePaid, cancelExpense, calculateInvoiceTotals } from '../dbStore';
import { generateId } from '../id';
import { Expense, ExpenseItem, Vendor, TaxSlab, BankAccount, User, normalizePermissions } from '../types';
import {
 FileText,
 Plus,
 Trash,
 Check,
 Printer,
 ChevronRight,
 AlertTriangle,
 Lock,
 Search,
 CheckSquare,
 Sparkles,
 ChevronUp,
 ChevronDown,
 Paperclip,
 X,
 Maximize2,
 CreditCard
} from 'lucide-react';

interface ExpenseModuleProps {
 db: DatabaseState;
 onUpdateDb: (db: DatabaseState) => void;
 onPrintDoc: (type: 'Quotation' | 'Invoice' | 'Expense', data: any) => void;
 // 'list' renders the Expenses table; 'add' renders the create form — each is mounted
 // under its own nav tab/permission (expenses vs expenses-add). No edit mode: expenses
 // are never modified in place, only paid/cancelled (existing row actions).
 mode: 'list' | 'add';
 onDone: () => void;
 onCreateNew: () => void;
}

export default function ExpenseModule({ db, onUpdateDb, onPrintDoc, mode, onDone, onCreateNew }: ExpenseModuleProps) {
 const { t, isRTL, lang } = useTranslation(db);
 const currentUser = db.currentUser;
 const isAdmin = currentUser?.role === 'admin' || currentUser?.isSuperAdmin === true;
 const userPermissions = normalizePermissions(currentUser?.permissions, currentUser?.role, currentUser?.isSuperAdmin);
 const openMonth = getActiveOpenMonth(db);
 const currencySymbol = db.companySetup?.currency || 'SAR';

 // Sorting state (default: createdAt descending, so newly added is on top!)
 const [sortField, setSortField] = React.useState<string>('createdAt');
 const [sortOrder, setSortOrder] = React.useState<'asc' | 'desc'>('desc');

 // Pagination state
 const [currentPage, setCurrentPage] = React.useState(1);
 const itemsPerPage = 20;

 // List Filters
 const [filterStartDate, setFilterStartDate] = React.useState<string>(openMonth ? `${openMonth.id}-01` : '');
 const [filterEndDate, setFilterEndDate] = React.useState<string>(() => {
 if (!openMonth) return '';
 const parts = openMonth.id.split('-');
 const lastDay = new Date(Number(parts[0]), Number(parts[1]), 0).getDate();
 return `${openMonth.id}-${lastDay.toString().padStart(2, '0')}`;
 });
 const [filterStatus, setFilterStatus] = React.useState<'All' | 'Unpaid'>('All');

 // Update filters if openMonth changes
 React.useEffect(() => {
 if (openMonth) {
 setFilterStartDate(`${openMonth.id}-01`);
 const parts = openMonth.id.split('-');
 const lastDay = new Date(Number(parts[0]), Number(parts[1]), 0).getDate();
 setFilterEndDate(`${openMonth.id}-${lastDay.toString().padStart(2, '0')}`);
 }
 }, [openMonth?.id]);


 // Notifications
 const [success, setSuccess] = React.useState<string | null>(null);
 const [error, setError] = React.useState<string | null>(null);

 const triggerSuccess = (msg: string) => {
 setSuccess(msg);
 setTimeout(() => setSuccess(null), 3500);
 };

 // Reset or adjust form state when active company changes
 React.useEffect(() => {
 if (view === 'create') {
 const today = new Date().toISOString().split('T')[0];
 const initialDate = openMonth ? (today.startsWith(openMonth.id) ? today : `${openMonth.id}-01`) : today;
 const defaultVendor = db.vendors.find(v => v.isSystem && (v.companyId === db.selectedCompanyId || !v.companyId))?.id || db.vendors.find(v => v.companyId === db.selectedCompanyId || !v.companyId)?.id || '';
 const defaultTax = db.taxSlabs.find(t => t.percentage === 0)?.id || db.taxSlabs[0]?.id || '';
 const defaultBank = db.banks.find(b => b.isDefault && b.companyId === db.selectedCompanyId)?.id || db.banks.find(b => b.companyId === db.selectedCompanyId)?.id || '';
 setFormDate(initialDate);
 setFormVendorId(defaultVendor);
 setFormTaxSlabId(defaultTax);
 setFormBankId(defaultBank);
 setFormItems([{ description: '', unitCost: 0, quantity: 1 }]);
 }
 setPayingExpense(null);
 }, [db.selectedCompanyId, openMonth?.id]);

 const triggerError = (msg: string) => {
 setError(msg);
 setTimeout(() => setError(null), 4500);
 };

 // View state — fixed for the lifetime of this mount by which page (mode) rendered it.
 const [viewAttachment, setViewAttachment] = React.useState<string | null>(null);
 const [isSavingExpense, setIsSavingExpense] = React.useState(false);
  const [view] = React.useState<"list" | "create">(mode === 'add' ? 'create' : 'list');
  // Expenses from server
  const [expenses, setExpenses] = React.useState<Expense[]>([]);
  const fetchExpenses = async () => {
    try {
      const resp = await fetch(`/api/expenses?companyId=${db.selectedCompanyId}`);
      const data = await resp.json();
      if (Array.isArray(data)) {
        setExpenses(data);
      } else {
        setExpenses([]);
        if (data && data.error) {
          setError(data.error);
        }
      }
    } catch (e) {
      console.error("Failed to fetch expenses:", e);
      setExpenses([]);
    }
  };
  React.useEffect(() => {
    fetchExpenses();
  }, [db.selectedCompanyId]);

  // Filter based on role and active filters
  const filteredExpenses = expenses.filter(exp => {
    const expCompanyId = exp.companyId;
    if (expCompanyId !== db.selectedCompanyId) return false;

    // Date & Status Filters
    if (filterStartDate && exp.date < filterStartDate) return false;
    if (filterEndDate && exp.date > filterEndDate) return false;
    if (filterStatus === 'Unpaid' && (exp.paymentStatus === 'Paid' || exp.status !== 'Active')) return false;

    if (isAdmin || userPermissions.expense.view.enabled) return true;
    return exp.createdById === currentUser.id;
  });

  // Reset page when length changes
  React.useEffect(() => {
    setCurrentPage(1);
  }, [filteredExpenses.length]);


 // Form states
 const [formDate, setFormDate] = React.useState('');
 const [formVendorId, setFormVendorId] = React.useState('');
 const [formTaxSlabId, setFormTaxSlabId] = React.useState('');
 const [formBankId, setFormBankId] = React.useState('');
 const [formPaymentStatus, setFormPaymentStatus] = React.useState<'Paid' | 'Unpaid'>('Paid');
 const [formDescription, setFormDescription] = React.useState('');
 const [formAmount, setFormAmount] = React.useState('');
 const [formClassification, setFormClassification] = React.useState<'Expense' | 'Asset'>('Expense');
 const [formAssetType, setFormAssetType] = React.useState<'Equipment' | 'Machinery' | 'Tools' | 'Computers' | 'Vehicles' | 'Furniture' | 'Other'>('Equipment');
 const [formAttachmentUrl, setFormAttachmentUrl] = React.useState('');
// @ts-ignore
const [formAssetType_ignored, setFormAssetType_ignored] = React.useState<'Equipment' | 'Machinery' | 'Tools' | 'Computers' | 'Vehicles' | 'Furniture' | 'Other'>('Equipment');
 
 // Optional itemised line items support
 const [showItemised, setShowItemised] = React.useState(false);
 const [formItems, setFormItems] = React.useState<Omit<ExpenseItem, 'id'>[]>([]);

 // Autocomplete support
 const [activeAutocompleteIdx, setActiveAutocompleteIdx] = React.useState<number | null>(null);
 const [autocompleteFilter, setAutocompleteFilter] = React.useState('');

 // Settle pay modal
 const [payingExpense, setPayingExpense] = React.useState<Expense | null>(null);
 const [payForm, setPayForm] = React.useState({
 date: openMonth ? `${openMonth.id}-01` : '',
 bankId: '',
 amount: ''
 });

 const purchaseProducts = React.useMemo(() => {
   return (db.products || []).filter(p => {
     const isCompMatch = !p.companyId || p.companyId === db.selectedCompanyId;
     const pType = (p.type || '').toLowerCase();
     return isCompMatch && pType !== 'sales';
   });
 }, [db.products, db.selectedCompanyId]);

 // Initiate Create
 // Navigate to the dedicated Add page for creation
 const handleInitiateCreate = () => {
 if (!openMonth) return triggerError('Please open a fiscal month first.');
 onCreateNew();
 };

 // Auto calculate total amount if itemised list is used
 React.useEffect(() => {
 if (showItemised && formItems.length > 0) {
 // Sum items including VAT if applicable
 const totals = calculateInvoiceTotals(db, formItems, formTaxSlabId);
 setFormAmount(totals.grandTotal.toString());
 }
 }, [formItems, formTaxSlabId, showItemised]);

 const handleAddLineItem = () => {
 setFormItems([...formItems, { description: '', unitCost: 0, quantity: 1 }]);
 };

 const handleRemoveLineItem = (idx: number) => {
 setFormItems(formItems.filter((_, i) => i !== idx));
 if (formItems.length === 1) setShowItemised(false);
 };

 const handleUpdateLineItem = (idx: number, field: keyof Omit<ExpenseItem, 'id'>, val: any) => {
 setFormItems(prev => {
 const updated = [...prev];
 updated[idx] = {
 ...updated[idx],
 [field]: val
 };
 return updated;
 });
 };

 const handleSelectProduct = (idx: number, name: string, unitPrice: number) => {
 setFormItems(prev => {
 const updated = [...prev];
 updated[idx] = {
 ...updated[idx],
 description: name,
 unitCost: unitPrice
 };
 return updated;
 });
 };

 // Submit Save
 const handleSaveExpense = async (e: React.FormEvent) => {
 e.preventDefault();
 if (isSavingExpense) return;
 if (formClassification === 'Asset' && !formAttachmentUrl) {
 return triggerError('Bill/Receipt attachment is mandatory when purchasing an Asset.');
 }

 if (!isAdmin && !userPermissions.expense.create.enabled) {
 return triggerError('You do not have permission to log expenses.');
 }
 const amountVal = parseFloat(formAmount);
 if (isNaN(amountVal) || amountVal <= 0) return triggerError('Expense amount must be a valid positive number.');
 if (!formDescription.trim()) return triggerError('Expense description is required.');

 if (showItemised) {
 const validItems = formItems.filter(item => item.description && item.description.trim() !== "");
 if (validItems.length === 0) {
 return triggerError('Please add at least one itemised line with a description.');
 }
 }

 const cleanItems: ExpenseItem[] = showItemised ? formItems.filter(item => item.description && item.description.trim() !== "").map(item => ({
 id: generateId(),
 description: item.description.trim(),
 unitCost: parseFloat(item.unitCost as any) || 0,
 quantity: parseFloat(item.quantity as any) || 1
 })) : [];

 const expData = {
 date: formDate,
 vendorId: formVendorId || db.vendors.find(v => v.isSystem)!.id,
 taxSlabId: formTaxSlabId,
 bankId: formBankId,
 paymentStatus: formPaymentStatus,
 paymentDate: formPaymentStatus === 'Paid' ? formDate : null,
 description: formDescription,
 amount: amountVal,
 status: 'Active' as const,
 type: 'Actual' as const,
 items: cleanItems,
 attachmentUrl: formAttachmentUrl,
 classification: formClassification,
 assetType: formClassification === 'Asset' ? formAssetType : undefined
 };

 setIsSavingExpense(true);
 try {
  const response = await fetch("/api/expenses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(expData) });
  const result = await response.json();
  // POST /api/expenses only ever returns { success: true } or { error }, never a `db`
  // field — a prior version called onUpdateDb(result.db) here, which resolved to
  // onUpdateDb(undefined) on every real save, nulling the entire app's `db` state on
  // the very next render (every downstream read of db.selectedCompanyId/db.vendors/etc.
  // would throw). fetchExpenses() below already refreshes this module's own list; the
  // global db is refreshed by the normal navigation/reload path instead of guessing at
  // a delta this endpoint doesn't return.
  if (!response.ok || result.error) {
 triggerError(result.error || 'Failed to save expense.');
 return;
 }
  await fetchExpenses();
 triggerSuccess('Expense saved successfully. Cash flows registered in ledger.');
 onDone();
 } catch (err: any) {
 triggerError(err?.message || 'Failed to save expense — check your connection and try again.');
 } finally {
 setIsSavingExpense(false);
 }
 };

 // Handle subsequently mark pending expense paid
 const handleInitiatePay = (exp: Expense) => {
 if (!openMonth) return triggerError('Please open a fiscal month first.');
 setPayingExpense(exp);
 const today = new Date().toISOString().split('T')[0];
 const initialDate = today.startsWith(openMonth.id) ? today : `${openMonth.id}-01`;
 setPayForm({
 date: initialDate,
 bankId: exp.bankId || db.banks.find(b => b.isDefault)?.id || ''
 });
 };

 const handleConfirmPay = (e: React.FormEvent) => {
 e.preventDefault();
 if (!payingExpense) return;

 const amt = parseFloat(payForm.amount);
 if (isNaN(amt) || amt <= 0) return triggerError('Please enter a valid payment amount.');

 const result = markExpensePaid(db, payingExpense.id, payForm.date, payForm.bankId, amt);
 if (result.error) {
 triggerError(result.error);
 } else {
 triggerSuccess(`Expense ${payingExpense.expenseNumber} payment of ${amt} ${currencySymbol} received and payment voucher posted.`);
 onUpdateDb(result.db);
 setPayingExpense(null);
 }
 };

 // Cancel expense
 const handleCancelExpense = (expId: string) => {
 const canCancel = isAdmin || userPermissions.cancel.access.enabled;
 if (!canCancel) return triggerError('You do not have cancellation permission.');

 const result = cancelExpense(db, expId);
 if (result.error) {
 triggerError(result.error);
 } else {
 triggerSuccess('Expense cancelled successfully. Reversal vouchers generated in bank ledger.');
 onUpdateDb(result.db);
 }
 };

 // Sorting handler
 const handleSort = (field: string) => {
 if (sortField === field) {
 setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
 } else {
 setSortField(field);
 setSortOrder('asc');
 }
 setCurrentPage(1);
 };

 // Sort expenses
 const sortedExpenses = React.useMemo(() => {
 const list = [...filteredExpenses];
 
 if (sortField === 'createdAt') {
 list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
 return list;
 }

 list.sort((a, b) => {
 let valA: any = a[sortField as keyof Expense];
 let valB: any = b[sortField as keyof Expense];

 if (sortField === 'vendor') {
 const vendA = db.vendors.find(v => v.id === a.vendorId)?.name || 'Cash Vendor';
 const vendB = db.vendors.find(v => v.id === b.vendorId)?.name || 'Cash Vendor';
 valA = vendA.toLowerCase();
 valB = vendB.toLowerCase();
 } else {
 if (typeof valA === 'string') valA = valA.toLowerCase();
 if (typeof valB === 'string') valB = valB.toLowerCase();
 }

 // Fallback secondary sort: newest on top
 if (valA === valB || valA === undefined || valB === undefined) {
 return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
 }

 if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
 if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
 return 0;
 });

 return list;
 }, [filteredExpenses, sortField, sortOrder, db.vendors]);

 // Paginated expenses
 const totalPages = Math.ceil(sortedExpenses.length / itemsPerPage);
 const paginatedExpenses = React.useMemo(() => {
 const startIdx = (currentPage - 1) * itemsPerPage;
 return sortedExpenses.slice(startIdx, startIdx + itemsPerPage);
 }, [sortedExpenses, currentPage]);

 const renderSortableHeader = (label: string, field: string, align: 'left' | 'center' | 'right' = 'left') => {
 const isCurrent = sortField === field;
 return (
 <th
 onClick={() => handleSort(field)}
 className={`p-3 cursor-pointer select-none hover:bg-slate-100 :bg-slate-800 transition-colors ${
 align === 'right' ? 'text-end' : align === 'center' ? 'text-center' : 'text-start'
 }`}
 >
 <div className={`flex items-center gap-1 ${
 align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start'
 }`}>
 <span>{label}</span>
 {isCurrent ? (
 sortOrder === 'asc' ? <ChevronUp className="w-3.5 h-3.5 text-indigo-600 inline" /> : <ChevronDown className="w-3.5 h-3.5 text-indigo-600 inline" />
 ) : (
 <ChevronDown className="w-3 h-3 text-slate-300 opacity-40 inline" />
 )}
 </div>
 </th>
 );
 };

 return (
 <div className="space-y-6">
 
 {/* Notifications */}
 {success && (
 <div className="bg-emerald-50 text-emerald-700 p-3 px-6 text-xs font-semibold rounded-xl border border-emerald-100 flex items-center gap-2">
 <Check className="w-4 h-4 text-emerald-500" />
 <span>{success}</span>
 </div>
 )}
 {error && (
 <div className="bg-rose-50 text-rose-700 p-3 px-6 text-xs font-semibold rounded-xl border border-rose-100 flex items-center gap-2">
 <AlertTriangle className="w-4 h-4 text-rose-500" />
 <span>{error}</span>
 </div>
 )}

 {/* LIST VIEW */}
 {view === 'list' && (
 <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
 <div className="p-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
 <div>
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Purchase & Workshop Expenses ({filteredExpenses.length})</h4>
 <div className="flex items-center gap-2 mt-0.5">
 <p className="text-[10px] text-slate-400">{isAdmin ? 'All shop expenses and accruals' : 'Your submitted workshop expenses'}</p>
 <span className="text-[9px] font-bold text-indigo-600 bg-indigo-50 border border-indigo-100 px-1.5 py-0.5 rounded uppercase">
 🏢 Scoped: {db.companySetup?.name}
 </span>
 </div>
 </div>
 {openMonth && (isAdmin || userPermissions.expense.create.enabled) && (
 <button
 onClick={handleInitiateCreate}
 className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-3 py-1.5 text-xs font-bold flex items-center gap-1 shadow-sm"
 >
 <Plus className="w-3.5 h-3.5" /> Log Expense
 </button>
 )}
 </div>
 
 {/* List Filters */}
 <div className="p-3 border-b border-slate-100 bg-white flex flex-wrap items-center gap-4">
 <div className="flex items-center gap-2">
 <label className="text-[10px] font-bold text-slate-500 uppercase">{t("Date From:")}</label>
 <input 
 type="date"
 value={filterStartDate}
 onChange={(e) => setFilterStartDate(e.target.value)}
 className="bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs focus:outline-none font-semibold text-slate-700"
 />
 </div>
 <div className="flex items-center gap-2">
 <label className="text-[10px] font-bold text-slate-500 uppercase">{t("Date To:")}</label>
 <input 
 type="date"
 value={filterEndDate}
 onChange={(e) => setFilterEndDate(e.target.value)}
 className="bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs focus:outline-none font-semibold text-slate-700"
 />
 </div>
 <div className="flex items-center gap-2 ms-auto">
 <label className="text-[10px] font-bold text-slate-500 uppercase">{t("Status:")}</label>
 <select 
 value={filterStatus}
 onChange={(e) => setFilterStatus(e.target.value as any)}
 className="bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs focus:outline-none font-semibold text-slate-700"
 >
 <option value="All">All Expenses</option>
 <option value="Unpaid">{t("Pending / Unpaid Only")}</option>
 </select>
 </div>
 </div>

 <div className="overflow-x-auto">
 <table className="w-full text-xs text-start">
 <thead>
 <tr className="bg-slate-50/50 border-b border-slate-100 text-slate-500 uppercase tracking-wider text-[10px]">
 {renderSortableHeader('Expense No', 'expenseNumber')}
 {renderSortableHeader('Date', 'date')}
 {renderSortableHeader('Vendor', 'vendor')}
 {renderSortableHeader('Description', 'description')}
 {renderSortableHeader('Type', 'type')}
 {renderSortableHeader('Amount', 'amount', 'right')}
 {renderSortableHeader('Status', 'status', 'center')}
 {renderSortableHeader('Payment', 'paymentStatus', 'center')}
 <th className="p-3 text-end">Actions</th>
 </tr>
 </thead>
 <tbody>
 {paginatedExpenses.length === 0 ? (
 <tr>
 <td colSpan={9} className="p-8 text-center text-slate-400">
 No expense entries recorded for this period. Click "Log Expense" to document procurement costs.
 </td>
 </tr>
 ) : (
 paginatedExpenses.map(exp => {
 const vend = db.vendors.find(v => v.id === exp.vendorId);
 const bank = db.banks.find(b => b.id === exp.bankId);
 const isPending = (exp.paymentStatus === 'Unpaid' || exp.paymentStatus === 'Partially Paid') && exp.status === 'Active';
 const canCancel = (isAdmin || userPermissions.cancel.access.enabled) && exp.status === 'Active';

 return (
 <tr key={exp.id} className="border-b border-slate-100 hover:bg-slate-50/20">
 <td className="p-3 font-bold text-slate-900">
 <div className="flex items-center gap-2">
 {exp.expenseNumber}
 {exp.attachmentUrl && (
 <button
 onClick={() => setViewAttachment(exp.attachmentUrl)}
 className="p-1.5 bg-slate-100 hover:bg-rose-100 text-slate-500 hover:text-rose-600 rounded-lg transition-colors"
 title="View Attachment"
 >
 <Paperclip className="w-3.5 h-3.5" />
 </button>
 )}
 </div>
 </td>
 <td className="p-3 text-slate-600">{exp.date}</td>
 <td className="p-3 font-semibold text-slate-700">{vend?.name || 'Cash Vendor'}</td>
 <td className="p-3 text-slate-600 font-medium max-w-xs truncate">
 <div className="flex flex-col">
 <span>{exp.description}</span>
 {exp.classification === 'Asset' && (
 <span className="text-[9px] font-bold text-amber-600 uppercase tracking-wider mt-0.5">
 📦 Asset ({exp.assetType})
 </span>
 )}
 </div>
 </td>
 <td className="p-3">
 <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
 exp.type === 'Accrual' ? 'bg-purple-100 text-purple-800' : 'bg-slate-100 text-slate-700'
 }`}>
 {exp.type}
 </span>
 </td>
 <td className="p-3 text-end">
 <span className="font-bold text-slate-900">{currencySymbol} {Number(exp.amount).toFixed(2)}</span>
 {exp.amountPaid !== undefined && exp.amountPaid > 0 && (
 <span className="block text-[10px] text-emerald-600 font-medium">{t("Paid:")} {Number(exp.amountPaid).toFixed(2)}</span>
 )}
 </td>
 <td className="p-3 text-center">
 <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${
 exp.status === 'Active' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
 }`}>
 {exp.status}
 </span>
 </td>
 <td className="p-3 text-center">
 <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${
 exp.paymentStatus === 'Paid' ? 'bg-emerald-100 text-emerald-800' :
 exp.paymentStatus === 'Partially Paid' ? 'bg-indigo-100 text-indigo-800 font-bold' :
 'bg-amber-100 text-amber-800'
 }`}>
 {exp.paymentStatus}
 </span>
 </td>
 <td className="p-3 text-end space-x-1.5">
 <div className="inline-flex items-center justify-end gap-1.5 flex-wrap">
 <button
 onClick={() => onPrintDoc('Expense', { ...exp, vendorData: vend, bankData: bank })}
 className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 transition cursor-pointer inline-flex items-center gap-1 text-[11px] font-semibold"
 title="Print Expense Bill"
 >
 <Printer className="w-3.5 h-3.5" />
 <span>Print</span>
 </button>

 {isPending && exp.type === 'Actual' && openMonth && (
 <button
 onClick={() => handleInitiatePay(exp)}
 className="p-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white transition cursor-pointer inline-flex items-center gap-1 text-[10px] font-bold shadow-sm"
 title="Settle Payment"
 >
 <CreditCard className="w-3.5 h-3.5" />
 <span>Settle Pay</span>
 </button>
 )}

 {canCancel && (
 <button
 onClick={() => {
 if (window.confirm('⚠️ Are you sure you want to CANCEL this expense? This action will void the expense and post a reversal voucher if it was paid. It cannot be undone!')) {
 handleCancelExpense(exp.id);
 }
 }}
 className="p-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 transition cursor-pointer inline-flex items-center gap-1 text-[11px] font-bold"
 title="Cancel Expense"
 >
 <AlertTriangle className="w-3.5 h-3.5" />
 <span>Cancel</span>
 </button>
 )}
 </div>
 </td>
 </tr>
 );
 })
 )}
 </tbody>
 </table>
 </div>

 {/* Pagination Bar */}
 {totalPages > 1 && (
 <div className="p-4 border-t border-slate-100 bg-slate-50/30 flex items-center justify-between flex-wrap gap-2">
 <p className="text-[11px] text-slate-400">
 Showing <span className="font-bold text-slate-700 ">{(currentPage - 1) * itemsPerPage + 1}</span> to{' '}
 <span className="font-bold text-slate-700 ">
 {Math.min(currentPage * itemsPerPage, sortedExpenses.length)}
 </span>{' '}
 of <span className="font-bold text-slate-700 ">{sortedExpenses.length}</span> records
 </p>
 <div className="flex gap-1">
 <button
 type="button"
 disabled={currentPage === 1}
 onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
 className="px-2.5 py-1 rounded bg-white border border-slate-200 text-slate-600 font-bold hover:bg-slate-50 :bg-slate-800 disabled:opacity-50 disabled:hover:bg-white :hover:bg-slate-950 transition text-xs"
 >
 Previous
 </button>
 {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
 <button
 key={page}
 type="button"
 onClick={() => setCurrentPage(page)}
 className={`px-3 py-1 rounded font-bold text-xs transition ${
 currentPage === page
 ? 'bg-indigo-600 text-white shadow-sm'
 : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 :bg-slate-800'
 }`}
 >
 {page}
 </button>
 ))}
 <button
 type="button"
 disabled={currentPage === totalPages}
 onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
 className="px-2.5 py-1 rounded bg-white border border-slate-200 text-slate-600 font-bold hover:bg-slate-50 :bg-slate-800 disabled:opacity-50 disabled:hover:bg-white :hover:bg-slate-950 transition text-xs"
 >
 Next
 </button>
 </div>
 </div>
 )}
 </div>
 )}

 {/* CREATE FORM VIEW */}
 {view === 'create' && (
 <form onSubmit={handleSaveExpense} className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 space-y-6">
 <div className="flex justify-between items-center border-b border-slate-100 pb-3">
 <div>
 <h3 className="font-bold text-sm text-slate-800 uppercase tracking-wider">{t('Log Procurement / Tooling Expense')}</h3>
 <div className="flex items-center gap-1.5 mt-0.5">
 <span className="text-[9px] font-bold text-indigo-600 bg-indigo-50 border border-indigo-100 px-1.5 py-0.5 rounded uppercase">
 🏢 {t('Submitting for:')} {db.companySetup?.name}
 </span>
 </div>
 </div>
 <button
 type="button"
 onClick={onDone}
 className="text-slate-400 hover:text-slate-600 text-xs font-semibold"
 >
 {t("Back to List")}
 </button>
 </div>

 <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-xs">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Expense Issue Date')}</label>
 <input
 type="date"
 required
 value={formDate}
 onChange={(e) => setFormDate(e.target.value)}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Vendor')}</label>
 <select
 required
 value={formVendorId}
 onChange={(e) => setFormVendorId(e.target.value)}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none"
 >
 {db.vendors.filter(v => v.companyId === db.selectedCompanyId || !v.companyId).map(v => (
 <option key={v.id} value={v.id}>{v.name} {v.isSystem ? '(Default)' : ''}</option>
 ))}
 </select>
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Input Tax Slab')}</label>
 <select
 required
 value={formTaxSlabId}
 onChange={(e) => setFormTaxSlabId(e.target.value)}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none"
 >
 {db.taxSlabs.map(t => (
 <option key={t.id} value={t.id}>{t.name}</option>
 ))}
 </select>
 </div>

 {/* Bank is Admin-only editable; staff see read-only bank */}
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Disbursement Bank</label>
 {isAdmin ? (
 <select
 required
 value={formBankId}
 onChange={(e) => setFormBankId(e.target.value)}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none"
 >
 {db.banks.filter(b => b.isActive && b.companyId === db.selectedCompanyId).map(b => (
 <option key={b.id} value={b.id}>{b.bankName} (Default: {b.isDefault ? 'Yes' : 'No'})</option>
 ))}
 </select>
 ) : (
 <div className="w-full bg-slate-100 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-500 font-semibold flex items-center gap-1.5">
 <Lock className="w-3.5 h-3.5 text-slate-400" />
 <span>{db.banks.find(b => b.id === formBankId)?.bankName || 'Default Bank'}</span>
 </div>
 )}
 </div>

 <div className="col-span-1 md:col-span-2 space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Payment Status')}</label>
 <div className="flex gap-4 p-1">
 <label className="flex items-center gap-1.5 cursor-pointer text-slate-700 font-semibold">
 <input
 type="radio"
 name="expPayStatus"
 checked={formPaymentStatus === 'Paid'}
 onChange={() => setFormPaymentStatus('Paid')}
 />
 <span>{t('Paid (Generates Payment Voucher instantly)')}</span>
 </label>
 <label className="flex items-center gap-1.5 cursor-pointer text-slate-700">
 <input
 type="radio"
 name="expPayStatus"
 checked={formPaymentStatus === 'Unpaid'}
 onChange={() => setFormPaymentStatus('Unpaid')}
 />
 <span>{t('Pending Outstanding payment')}</span>
 </label>
 </div>
 </div>

 <div className="col-span-1 md:col-span-2 space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Procurement Classification')}</label>
 <div className="flex gap-4 p-1">
 <label className="flex items-center gap-1.5 cursor-pointer text-slate-700 font-semibold">
 <input
 type="radio"
 name="formClassification"
 checked={formClassification === 'Expense'}
 onChange={() => setFormClassification('Expense')}
 />
 <span>{t('Operating Expense (OpEx)')}</span>
 </label>
 <label className="flex items-center gap-1.5 cursor-pointer text-slate-700 font-semibold">
 <input
 type="radio"
 name="formClassification"
 checked={formClassification === 'Asset'}
 onChange={() => setFormClassification('Asset')}
 />
 <span className="text-amber-600 ">{t('Fixed Asset (CapEx)')}</span>
 </label>
 </div>
 </div>

 {formClassification === 'Asset' && (
 <div className="col-span-1 md:col-span-2 space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Fixed Asset Category')}</label>
 <select
 required
 value={formAssetType}
 onChange={(e) => setFormAssetType(e.target.value as any)}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none"
 >
 <option value="Machinery">{t('Machinery & CNC Equipment')}</option>
 <option value="Equipment">{t('Factory & Shop Equipment')}</option>
 <option value="Tools">{t('Power Tools & Hand Tools')}</option>
 <option value="Computers">{t('Computers & Software Servers')}</option>
 <option value="Vehicles">{t('Logistics & Delivery Vehicles')}</option>
 <option value="Furniture">{t('Office & Showroom Furniture')}</option>
 <option value="Other">{t('Other Non-Current Capital Asset')}</option>
 </select>
 </div>
 )}

 <div className="col-span-1 md:col-span-2 space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Bill / Receipt (Attachment)')}</label>
 <input
 type="file"
 accept="image/jpeg, image/gif, image/bmp, image/png, application/pdf"
 onChange={(e) => {
 const file = e.target.files?.[0];
 if (file) {
 const reader = new FileReader();
 reader.onloadend = () => {
 setFormAttachmentUrl(reader.result as string);
 };
 reader.readAsDataURL(file);
 }
 }}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1 text-xs text-slate-800 focus:outline-none"
 />
 {formAttachmentUrl && <p className="text-[10px] text-emerald-500 mt-0.5">File attached successfully</p>}
 </div>
 
 <div className="col-span-1 md:col-span-2 space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('General Description / Summary')}</label>
 <input
 type="text"
 required
 placeholder="e.g. Spiral upcut router bits purchases, factory glue"
 value={formDescription}
 onChange={(e) => setFormDescription(e.target.value)}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none"
 />
 </div>
 </div>

 {/* Optional itemised line items toggling */}
 <div className="space-y-4">
 <div className="flex items-center justify-between border-b border-slate-100 pb-2">
 <div className="flex items-center gap-2">
 <input
 type="checkbox"
 id="chk-itemised"
 checked={showItemised}
 onChange={(e) => {
 setShowItemised(e.target.checked);
 if (e.target.checked && formItems.length === 0) {
 setFormItems([{ description: '', unitCost: 0, quantity: 1 }]);
 }
 }}
 className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
 />
 <label htmlFor="chk-itemised" className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1 cursor-pointer">
 <Sparkles className="w-3.5 h-3.5 text-indigo-500 animate-pulse" />
 {t('Enable Itemised Purchase Breakdown')}
 </label>
 </div>
 <span className="text-[10px] text-slate-400">{t('Recommended for stock tracking')}</span>
 </div>

 {showItemised && (
 <div className="border border-slate-200 rounded-xl bg-white shadow-xs my-2 relative">
 <div className="overflow-x-auto overflow-y-visible">
 <table className="w-full text-start text-xs border-collapse min-w-[550px]">
 <thead>
 <tr className="bg-slate-100/90 border-b border-slate-200 text-[10px] font-extrabold text-slate-600 uppercase tracking-wider">
 <th className="py-2.5 px-3 text-start w-10">#</th>
 <th className="py-2.5 px-3 text-start">{t('Item Description / Catalog Search')}</th>
 <th className="py-2.5 px-3 text-end w-32">{t('Unit Cost')} ({currencySymbol})</th>
 <th className="py-2.5 px-3 text-center w-24">{t('Quantity')}</th>
 <th className="py-2.5 px-3 text-end w-32">{t('Total')} ({currencySymbol})</th>
 <th className="py-2.5 px-3 text-center w-12"></th>
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100">
 {formItems.map((item, idx) => {
 const lineTotal = (item.unitCost || 0) * (item.quantity || 1);

 return (
 <tr key={idx} className="hover:bg-slate-50/80 transition-colors">
 <td className="py-2 px-3 text-slate-400 font-bold text-[11px] align-top pt-3">{idx + 1}</td>
 <td className="py-2 px-2 align-top">
 <input
 type="text"
 required
 list={`expense-catalog-${idx}`}
 placeholder={t("Type or search material from catalog...")}
 value={item.description}
 onChange={(e) => {
 const val = e.target.value;
 handleUpdateLineItem(idx, 'description', val);
 const matched = purchaseProducts.find(p => p.name.toLowerCase() === val.trim().toLowerCase());
 if (matched) {
 handleUpdateLineItem(idx, 'unitCost', matched.unitPrice || 0);
 }
 }}
 className="w-full bg-slate-50/50 hover:bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500 font-medium"
 />
 <datalist id={`expense-catalog-${idx}`}>
 {purchaseProducts.map(p => (
 <option key={p.id} value={p.name}>
 {`${currencySymbol} ${Number(p.unitPrice || 0).toFixed(2)} ${p.description ? '— ' + p.description : ''}`}
 </option>
 ))}
 </datalist>
 </td>

 <td className="py-2 px-2 align-top">
 <input
 type="number"
 required
 step="0.01"
 placeholder="0.00"
 value={item.unitCost || ''}
 onChange={(e) => handleUpdateLineItem(idx, 'unitCost', parseFloat(e.target.value) || 0)}
 className="w-full text-end bg-slate-50/50 hover:bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500 font-semibold"
 />
 </td>

 <td className="py-2 px-2 align-top">
 <input
 type="number"
 required
 min="1"
 placeholder="1"
 value={item.quantity || ''}
 onChange={(e) => handleUpdateLineItem(idx, 'quantity', parseInt(e.target.value, 10) || 1)}
 className="w-full text-center bg-slate-50/50 hover:bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500 font-semibold"
 />
 </td>

 <td className="py-2 px-3 text-end font-bold text-slate-900 text-xs align-top pt-3">
 {lineTotal.toFixed(2)}
 </td>

 <td className="py-2 px-2 text-center align-top pt-2">
 <button
 type="button"
 onClick={() => handleRemoveLineItem(idx)}
 className="p-1 hover:bg-rose-100 text-slate-400 hover:text-rose-600 rounded-md transition-all cursor-pointer"
 >
 <Trash className="w-3.5 h-3.5" />
 </button>
 </td>
 </tr>
 );
 })}
 </tbody>
 </table>
 </div>

 <div className="p-2.5 bg-slate-50/80 border-t border-slate-200 flex justify-between items-center">
 <button
 type="button"
 onClick={handleAddLineItem}
 className="inline-flex items-center gap-1.5 text-xs font-bold text-indigo-600 hover:text-indigo-800 px-3 py-1.5 rounded-lg bg-indigo-50/70 hover:bg-indigo-100/80 border border-indigo-200/60 transition-all cursor-pointer"
 >
 <Plus className="w-3.5 h-3.5" /> {t('Add Fabrication Line')}
 </button>
 <div className="text-xs font-semibold text-slate-500">
 {t("Total Items:")} <span className="text-slate-900 font-bold">{formItems.length}</span>
 </div>
 </div>
 </div>
 )}
 </div>

 {/* Amount input (lockable if itemised) */}
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">
 {showItemised ? 'Total Amount (Calculated from lines)' : `Total Expense Amount (${currencySymbol})`}
 </label>
 <input
 type="number"
 required
 step="0.01"
 disabled={showItemised}
 placeholder="0.00"
 value={formAmount}
 onChange={(e) => setFormAmount(e.target.value)}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none disabled:bg-slate-100 disabled:text-slate-500 disabled:font-bold"
 />
 </div>

 <div className="flex justify-end gap-3 pt-2">
 <button
 type="button"
 onClick={onDone}
 className="px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl font-semibold text-xs"
 >
 Cancel
 </button>
 <button
 type="submit"
 disabled={isSavingExpense}
 className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed text-white rounded-xl px-5 py-2 font-bold text-xs shadow-sm"
 >
 {isSavingExpense ? t('Saving...') : t('Save Expense Entry')}
 </button>
 </div>
 </form>
 )}

 {/* Subsequent payment modal */}
 {payingExpense && (
 <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex justify-center items-center p-4 overflow-y-auto">
 <div className="bg-white rounded-2xl border border-slate-100 shadow-2xl p-6 w-full max-w-sm my-auto animate-in fade-in zoom-in-95 duration-100 text-xs text-slate-600">
 <h3 className="font-bold text-sm text-slate-900 mb-1 flex items-center gap-1">
 <CheckSquare className="w-5 h-5 text-emerald-600" />
 Settle Pending Expense
 </h3>
 <p className="mb-4">Recording subsequent payment disbursement for expense {payingExpense.expenseNumber}.</p>

 <form onSubmit={handleConfirmPay} className="space-y-4">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Payment Settlement Date</label>
 <input
 type="date"
 required
 value={payForm.date}
 onChange={(e) => setPayForm({ ...payForm, date: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Disbursement Bank</label>
 {isAdmin ? (
 <select
 required
 value={payForm.bankId}
 onChange={(e) => setPayForm({ ...payForm, bankId: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800"
 >
 {db.banks.filter(b => b.isActive).map(b => (
 <option key={b.id} value={b.id}>{b.bankName}</option>
 ))}
 </select>
 ) : (
 <div className="w-full bg-slate-100 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-500 font-semibold flex items-center gap-1.5">
 <Lock className="w-3.5 h-3.5 text-slate-400" />
 <span>{db.banks.find(b => b.id === payForm.bankId)?.bankName || 'Default Bank'}</span>
 </div>
 )}
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Payment Amount</label>
 <div className="relative">
 <input
 type="number"
 step="0.01"
 required
 max={Number((payingExpense.amount - (payingExpense.amountPaid || 0)).toFixed(2))}
 min="0.01"
 value={payForm.amount}
 onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl ps-2.5 pe-12 py-1.5 text-xs text-slate-800 font-bold"
 />
 <div className="absolute inset-y-0 end-0 pe-3 flex items-center pointer-events-none text-[10px] font-bold text-slate-400">
 {currencySymbol}
 </div>
 </div>
 <div className="flex justify-between text-[10px] text-slate-400 pt-1 px-0.5">
 <span>Already {t("Paid:")} {Number(payingExpense.amountPaid || 0).toFixed(2)} {currencySymbol}</span>
 <span>Remaining: {Number(payingExpense.amount - (payingExpense.amountPaid || 0)).toFixed(2)} {currencySymbol}</span>
 </div>
 </div>

 <div className="flex justify-end gap-2.5 pt-2">
 <button
 type="button"
 onClick={() => setPayingExpense(null)}
 className="px-3 py-1.5 bg-slate-100 text-slate-500 rounded-lg font-semibold hover:bg-slate-200"
 >
 Cancel
 </button>
 <button
 type="submit"
 className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg shadow-sm"
 >
 Confirm Payment Disbursement
 </button>
 </div>
 </form>
 </div>
 </div>
 )}

 {/* ATTACHMENT MODAL */}
 {viewAttachment && (
 <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm overflow-y-auto">
 <div className="bg-white rounded-[24px] shadow-2xl w-full max-w-3xl overflow-hidden my-auto animate-in fade-in zoom-in duration-200">
 <div className="flex justify-between items-center p-4 border-b border-slate-100 bg-slate-50/50">
 <h3 className="font-bold text-slate-800 flex items-center gap-2">
 <Paperclip className="w-4 h-4 text-indigo-500" />
 Document Attachment
 </h3>
 <button onClick={() => setViewAttachment(null)} className="p-2 bg-white hover:bg-rose-50 text-slate-400 hover:text-rose-500 rounded-xl transition-colors shadow-sm border border-slate-200">
 <X className="w-4 h-4" />
 </button>
 </div>
 <div className="p-4 bg-slate-50 flex items-center justify-center min-h-[300px]">
 {viewAttachment.startsWith('data:image') ? (
 <img src={viewAttachment} alt="Attachment" className="max-w-full max-h-[70vh] rounded-xl shadow-sm object-contain" />
 ) : (
 <div className="text-sm font-bold text-slate-500 p-8 border-2 border-dashed border-slate-200 rounded-xl bg-white">
 Non-image document attached
 </div>
 )}
 </div>
 </div>
 </div>
 )}
 </div>
 );
}
