import React from 'react';
import { DatabaseState, getActiveOpenMonth, postRecurringExpense, settleAccrualExpense, generateId } from '../dbStore';
import { RecurringExpenseTemplate, Expense, BankAccount } from '../types';
import {
 FileText,
 AlertTriangle,
 PlusCircle,
 Clock,
 CheckCircle,
 HelpCircle,
 Wallet,
 ArrowRight,
 ShieldCheck,
 Zap,
 Check,
 Edit2,
 Trash2,
 Plus,
 Sliders,
 Settings,
 Power,
 PowerOff,
 RefreshCw,
 XCircle
} from 'lucide-react';

interface RecurringExpensesProps {
 db: DatabaseState;
 onUpdateDb: (db: DatabaseState) => void;
 onRefreshDb?: () => Promise<void>;
}

import { useTranslation } from '../hooks';

export default function RecurringExpenses({ db, onUpdateDb, onRefreshDb }: RecurringExpensesProps) {
 const { t } = useTranslation(db);
 const openMonth = getActiveOpenMonth(db);
 const activeTemplates = db.recurringTemplates.filter(t => t.isActive);
 const allTemplates = db.recurringTemplates;
 const currencySymbol = db.companySetup?.currency || 'SAR';

 // Sub-tabs navigation
 const [subTab, setSubTab] = React.useState<'operations' | 'templates' | 'accruals'>('operations');

 // Success/Error notifications
 const [success, setSuccess] = React.useState<string | null>(null);
 const [error, setError] = React.useState<string | null>(null);

 const triggerSuccess = (msg: string) => {
 setSuccess(msg);
 setTimeout(() => setSuccess(null), 3000);
 };

 const triggerError = (msg: string) => {
 setErrorMsg(msg);
 setTimeout(() => setErrorMsg(null), 4000);
 };
 const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

 // Forms control for posting
 const [postingTemplate, setPostingTemplate] = React.useState<RecurringExpenseTemplate | null>(null);
 const [postType, setPostType] = React.useState<'Actual' | 'Accrual'>('Actual');
 const [postForm, setPostForm] = React.useState({
 amount: '',
 date: openMonth ? `${openMonth.id}-28` : new Date().toISOString().split('T')[0],
 paymentStatus: 'Paid' as 'Paid' | 'Unpaid',
 bankId: ''
 });

 // Accrual settlement forms
 const [settlingAccrual, setSettlingAccrual] = React.useState<Expense | null>(null);
 const [settleForm, setSettleForm] = React.useState({
 amount: '',
 date: openMonth ? `${openMonth.id}-28` : new Date().toISOString().split('T')[0],
 paymentStatus: 'Paid' as 'Paid' | 'Unpaid',
 bankId: ''
 });

 // Templates Management State
 const [editingTemplate, setEditingTemplate] = React.useState<RecurringExpenseTemplate | null>(null);
 const [isAddingTemplate, setIsAddingTemplate] = React.useState(false);

 // Reset active modals/forms when active company changes
 React.useEffect(() => {
 setPostingTemplate(null);
 setSettlingAccrual(null);
 setEditingTemplate(null);
 setIsAddingTemplate(false);
 if (openMonth) {
 const today = new Date().toISOString().split('T')[0];
 const initialDate = today.startsWith(openMonth.id) ? today : `${openMonth.id}-28`;
 setPostForm(prev => ({ ...prev, date: initialDate }));
 setSettleForm(prev => ({ ...prev, date: initialDate }));
 }
 }, [db.selectedCompanyId, openMonth?.id]);
 const [templateForm, setTemplateForm] = React.useState({
 description: '',
 defaultAmount: '',
 bankId: '',
 vendorId: '',
 taxSlabId: '',
 isActive: true
 });

 // Accruals Management State
 const [editingAccrual, setEditingAccrual] = React.useState<Expense | null>(null);
 const [accrualForm, setAccrualForm] = React.useState({
 description: '',
 amount: '',
 vendorId: '',
 bankId: '',
 date: '',
 taxSlabId: ''
 });

 // Start creating a template
 const handleStartAddTemplate = () => {
 setEditingTemplate(null);
 setTemplateForm({
 description: '',
 defaultAmount: '',
 bankId: db.banks.find(b => b.isDefault)?.id || db.banks[0]?.id || '',
 vendorId: db.vendors.find(v => v.isSystem)?.id || db.vendors[0]?.id || '',
 taxSlabId: db.taxSlabs[0]?.id || 'tax-0',
 isActive: true
 });
 setIsAddingTemplate(true);
 };

 // Start editing a template
 const handleStartEditTemplate = (t: RecurringExpenseTemplate) => {
 setEditingTemplate(t);
 setTemplateForm({
 description: t.description,
 defaultAmount: t.defaultAmount.toString(),
 bankId: t.bankId,
 vendorId: t.vendorId,
 taxSlabId: t.taxSlabId,
 isActive: t.isActive
 });
 setIsAddingTemplate(true);
 };

 // Toggle active/inactive template
 const handleToggleTemplateActive = (t: RecurringExpenseTemplate) => {
 const updatedTemplates = db.recurringTemplates.map(item => item.id === t.id ? {
 ...item,
 isActive: !item.isActive
 } : item);

 const updatedDb = {
 ...db,
 recurringTemplates: updatedTemplates
 };

 
 onUpdateDb(updatedDb);
 triggerSuccess(`Template "${t.description}" is now ${!t.isActive ? 'Active' : 'Inactive'}.`);
 };

 // Delete a template
 const handleDeleteTemplate = (id: string) => {
 if (!window.confirm('Are you sure you want to delete this recurring template? This will not affect prior postings but prevents future occurrences.')) return;

 const updatedTemplates = db.recurringTemplates.filter(t => t.id !== id);
 const updatedDb = {
 ...db,
 recurringTemplates: updatedTemplates
 };

 
 onUpdateDb(updatedDb);
 triggerSuccess('Recurring template deleted successfully.');
 };

 // Save template (add or edit)
 const handleSaveTemplate = (e: React.FormEvent) => {
 e.preventDefault();
 const amountNum = parseFloat(templateForm.defaultAmount);
 if (isNaN(amountNum) || amountNum <= 0) return triggerError('Please enter a valid amount.');

 let updatedTemplates = [...db.recurringTemplates];

 if (editingTemplate) {
 updatedTemplates = updatedTemplates.map(t => t.id === editingTemplate.id ? {
 ...t,
 description: templateForm.description,
 defaultAmount: amountNum,
 bankId: templateForm.bankId,
 vendorId: templateForm.vendorId,
 taxSlabId: templateForm.taxSlabId,
 isActive: templateForm.isActive
 } : t);
 triggerSuccess('Recurring template updated successfully.');
 } else {
 const newTemplate: RecurringExpenseTemplate = {
 id: generateId(),
 description: templateForm.description,
 defaultAmount: amountNum,
 bankId: templateForm.bankId,
 vendorId: templateForm.vendorId,
 taxSlabId: templateForm.taxSlabId,
 isActive: templateForm.isActive,
 companyId: db.selectedCompanyId
 };
 updatedTemplates.push(newTemplate);
 triggerSuccess('New recurring template created successfully.');
 }

 const updatedDb = {
 ...db,
 recurringTemplates: updatedTemplates
 };

 
 onUpdateDb(updatedDb);

 setEditingTemplate(null);
 setIsAddingTemplate(false);
 };

 // Start editing accrual
 const handleStartEditAccrual = (acc: Expense) => {
 setEditingAccrual(acc);
 setAccrualForm({
 description: acc.description,
 amount: acc.amount.toString(),
 vendorId: acc.vendorId,
 bankId: acc.bankId,
 date: acc.date,
 taxSlabId: acc.taxSlabId
 });
 };

 // Save accrual edit
 const handleSaveAccrual = (e: React.FormEvent) => {
 e.preventDefault();
 if (!editingAccrual) return;

 const amountNum = parseFloat(accrualForm.amount);
 if (isNaN(amountNum) || amountNum <= 0) return triggerError('Please enter a valid amount.');

 const updatedExpenses = db.expenses.map(exp => exp.id === editingAccrual.id ? {
 ...exp,
 description: accrualForm.description,
 amount: amountNum,
 vendorId: accrualForm.vendorId,
 bankId: accrualForm.bankId,
 date: accrualForm.date,
 taxSlabId: accrualForm.taxSlabId
 } : exp);

 const updatedDb = {
 ...db,
 expenses: updatedExpenses
 };

 
 onUpdateDb(updatedDb);
 triggerSuccess('Accrual entry updated successfully.');
 setEditingAccrual(null);
 };

 // Delete accrual
 const handleDeleteAccrual = (id: string) => {
 if (!window.confirm('Are you sure you want to delete this accrual entry? This will delete the accrual liability and associated postings.')) return;

 const updatedExpenses = db.expenses.filter(exp => exp.id !== id);
 const updatedPostings = db.recurringPostings.filter(post => post.expenseId !== id);

 const updatedDb = {
 ...db,
 expenses: updatedExpenses,
 recurringPostings: updatedPostings
 };

 
 onUpdateDb(updatedDb);
 triggerSuccess('Accrual entry deleted successfully.');
 };

 // Helper to find posting status for a template in the current open month
 const getPostingStatus = (templateId: string) => {
 if (!openMonth) return { status: 'No Open Month', expenseId: null };
 
 // Check if there is an expense of type 'Accrual' or 'Actual' linked to this month and template
 const postingKey = `${templateId}_${openMonth.id}`;
 const posting = db.recurringPostings.find(p => p.id === postingKey);

 if (posting) {
 return { status: posting.status, expenseId: posting.expenseId };
 }
 
 return { status: 'Unposted', expenseId: null };
 };

 const handleInitiatePost = (t: RecurringExpenseTemplate) => {
 if (!openMonth) return triggerError('Please open a fiscal month first.');
 setPostingTemplate(t);
 setPostForm({
 amount: t.defaultAmount.toString(),
 date: `${openMonth.id}-28`, // default to late in the month
 paymentStatus: 'Paid',
 bankId: t.bankId || db.banks.find(b => b.isDefault)?.id || db.banks[0]?.id || ''
 });
 };

 const handlePostRecurring = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!postingTemplate || !openMonth) return;

 const amountNum = parseFloat(postForm.amount);
 if (isNaN(amountNum) || amountNum <= 0) return triggerError('Please enter a valid expense amount.');

 try {
   const res = await fetch('/api/transactions/recurring-postings', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({
       templateId: postingTemplate.id,
       monthId: openMonth.id,
       postType,
       amount: amountNum,
       dateStr: postForm.date,
       paymentStatus: postForm.paymentStatus,
       bankId: postForm.bankId
     })
   });
   const data = await res.json();
   if (!res.ok || data.error) {
     triggerError(data.error || 'Failed to post recurring expense.');
   } else {
     triggerSuccess(`Successfully posted recurring template "${postingTemplate.description}" as ${postType}.`);
     if (onRefreshDb) {
       await onRefreshDb();
     }
     setPostingTemplate(null);
   }
 } catch (err: any) {
   triggerError(err.message || 'An error occurred while posting recurring expense.');
 }
 };

 const handleInitiateSettle = (accrual: Expense) => {
 if (!openMonth) return triggerError('Please open a fiscal month first.');
 setSettlingAccrual(accrual);
 setSettleForm({
 amount: accrual.amount.toString(),
 date: `${openMonth.id}-28`,
 paymentStatus: 'Paid',
 bankId: accrual.bankId || db.banks.find(b => b.isDefault)?.id || db.banks[0]?.id || ''
 });
 };

 const handleSettleAccrual = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!settlingAccrual) return;

 const amountNum = parseFloat(settleForm.amount);
 if (isNaN(amountNum) || amountNum <= 0) return triggerError('Please enter a valid actual amount.');

 try {
   const res = await fetch('/api/transactions/settle-accrual', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({
       accrualExpenseId: settlingAccrual.id,
       actualAmount: amountNum,
       actualDate: settleForm.date,
       paymentStatus: settleForm.paymentStatus,
       bankId: settleForm.bankId
     })
   });
   const data = await res.json();
   if (!res.ok || data.error) {
     triggerError(data.error || 'Failed to settle accrual expense.');
   } else {
     triggerSuccess('Accrual settled successfully and Actual Expense generated.');
     if (onRefreshDb) {
       await onRefreshDb();
     }
     setSettlingAccrual(null);
   }
 } catch (err: any) {
   triggerError(err.message || 'An error occurred while settling accrual.');
 }
 };

 // Unsettled accruals
 const unsettledAccruals = db.expenses.filter(e => e.type === 'Accrual' && e.status === 'Active' && !e.accrualSettled);

 return (
 <div className="space-y-6">
 
 {/* Notifications */}
 {success && (
 <div className="bg-emerald-50 text-emerald-700 p-3 px-6 text-xs font-semibold rounded-xl border border-emerald-100 flex items-center gap-2">
 <CheckCircle className="w-4 h-4 text-emerald-500" />
 <span>{success}</span>
 </div>
 )}
 {errorMsg && (
 <div className="bg-rose-50 text-rose-700 p-3 px-6 text-xs font-semibold rounded-xl border border-rose-100 flex items-center gap-2">
 <AlertTriangle className="w-4 h-4 text-rose-500" />
 <span>{errorMsg}</span>
 </div>
 )}

 {/* Sub-Tabs Selector */}
 <div className="flex gap-2 bg-slate-100 p-1 rounded-2xl w-full sm:w-max">
 <button
 onClick={() => setSubTab('operations')}
 className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
 subTab === 'operations'
 ? 'bg-white text-indigo-600 shadow-sm'
 : 'text-slate-500 hover:text-slate-700 :text-slate-300'
 }`}
 >
 <Sliders className="w-3.5 h-3.5" />
 Month Postings & Settle
 </button>
 <button
 onClick={() => setSubTab('templates')}
 className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
 subTab === 'templates'
 ? 'bg-white text-indigo-600 shadow-sm'
 : 'text-slate-500 hover:text-slate-700 :text-slate-300'
 }`}
 >
 <Settings className="w-3.5 h-3.5" />
 Manage Templates
 </button>
 <button
 onClick={() => setSubTab('accruals')}
 className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
 subTab === 'accruals'
 ? 'bg-white text-indigo-600 shadow-sm'
 : 'text-slate-500 hover:text-slate-700 :text-slate-300'
 }`}
 >
 <FileText className="w-3.5 h-3.5" />
 Manage Accrual Entries
 </button>
 </div>

 {subTab === 'operations' && (
 <div className="space-y-6">
 {/* Fiscal context block */}
 <div className="bg-indigo-50 border border-indigo-100 rounded-2xl p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
 <div>
 <div className="flex items-center gap-2">
 <h3 className="text-xs font-bold text-indigo-900 uppercase tracking-wider">{t('Current Period Status')}</h3>
 <span className="text-[9px] font-bold text-indigo-800 bg-indigo-100 border border-indigo-200 px-1.5 py-0.5 rounded uppercase">
 🏢 {db.companySetup?.name}
 </span>
 </div>
 <p className="text-xs text-indigo-700 mt-1">
 {openMonth ? (
 <span>Currently Open Month: <strong>{openMonth.name} ({openMonth.id})</strong></span>
 ) : (
 <span className="text-rose-600 font-bold flex items-center gap-1"><AlertTriangle className="w-4 h-4" /> NO FISCAL PERIOD OPEN</span>
 )}
 </p>
 </div>
 <div className="text-xs text-slate-500 max-w-md">
 Active recurring templates are <strong>mandatory</strong> to be posted (as Actual or Accrual) before the fiscal month can be successfully closed.
 </div>
 </div>

 {/* Templates List & Posting Status */}
 <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
 <div className="p-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
 <div>
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Active Recurring Expense Templates ({activeTemplates.length})</h4>
 <div className="flex items-center gap-2 mt-0.5">
 <p className="text-[10px] text-slate-400">Post salaries, rent, and software licenses for {openMonth?.name || 'open month'}</p>
 <span className="text-[9px] font-bold text-indigo-600 bg-indigo-50 border border-indigo-100 px-1.5 py-0.5 rounded uppercase">
 🏢 Scoped: {db.companySetup?.name}
 </span>
 </div>
 </div>
 </div>

 <div className="divide-y divide-slate-100 ">
 {activeTemplates.length === 0 ? (
 <div className="p-8 text-center text-slate-400 text-xs">
 No active recurring expense templates found. Define templates in Settings first.
 </div>
 ) : (
 activeTemplates.map(t => {
 const posting = getPostingStatus(t.id);
 const isUnposted = posting.status === 'Unposted';
 
 return (
 <div key={t.id} className="p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 hover:bg-slate-50/20 transition">
 <div>
 <span className="text-xs font-bold text-slate-900 ">{t.description}</span>
 <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-slate-400">
 <span>Default Cost: <strong>{currencySymbol} {t.defaultAmount.toFixed(2)}</strong></span>
 <span>•</span>
 <span>Default Account: <strong>{db.banks.find(b => b.id === t.bankId)?.bankName || 'Default'}</strong></span>
 </div>
 </div>

 <div className="flex items-center gap-3">
 <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide flex items-center gap-1 ${
 posting.status === 'Unposted' ? 'bg-amber-100 text-amber-800 ' :
 posting.status === 'Posted as Actual' ? 'bg-emerald-100 text-emerald-800 ' :
 posting.status === 'Posted as Accrual' ? 'bg-purple-100 text-purple-800 font-extrabold' : 'bg-indigo-100 text-indigo-800 '
 }`}>
 {posting.status === 'Unposted' && <Clock className="w-3 h-3" />}
 {posting.status === 'Posted as Actual' && <Check className="w-3 h-3" />}
 {posting.status === 'Posted as Accrual' && <Zap className="w-3 h-3" />}
 {posting.status === 'Accrual Settled' && <ShieldCheck className="w-3 h-3" />}
 <span>{posting.status}</span>
 </span>

 {openMonth && isUnposted && (
 <button
 onClick={() => handleInitiatePost(t)}
 className="px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold transition flex items-center gap-0.5 shadow-sm cursor-pointer"
 >
 Post Expense
 </button>
 )}
 </div>
 </div>
 );
 })
 )}
 </div>
 </div>

 {/* Unsettled Accruals Section */}
 <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
 <div className="p-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
 <div>
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Unsettled Accrual Ledger Entries ({unsettledAccruals.length})</h4>
 <p className="text-[10px] text-slate-400">Past accruals awaiting actual billing invoices and cash payments</p>
 </div>
 </div>

 <div className="divide-y divide-slate-100 ">
 {unsettledAccruals.length === 0 ? (
 <div className="p-6 text-center text-slate-400 text-xs">
 🎉 No outstanding accruals to settle.
 </div>
 ) : (
 unsettledAccruals.map(acc => {
 const vendor = db.vendors.find(v => v.id === acc.vendorId);
 return (
 <div key={acc.id} className="p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 hover:bg-slate-50/20 transition">
 <div>
 <span className="text-xs font-bold text-slate-800 ">{acc.description}</span>
 <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-slate-400">
 <span>Accrued Amount: <strong>{currencySymbol} {acc.amount.toFixed(2)}</strong></span>
 <span>•</span>
 <span>Period: <strong>{acc.date}</strong></span>
 <span>•</span>
 <span>Vendor: <strong>{vendor?.name || 'Cash Vendor'}</strong></span>
 </div>
 </div>

 {openMonth && (
 <button
 onClick={() => handleInitiateSettle(acc)}
 className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-bold transition flex items-center gap-1 shadow-sm cursor-pointer"
 >
 Settle Accrual <ArrowRight className="w-3.5 h-3.5" />
 </button>
 )}
 </div>
 );
 })
 )}
 </div>
 </div>
 </div>
 )}

 {subTab === 'templates' && (
 <div className="space-y-6 animate-in fade-in duration-200">
 <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
 <div className="p-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
 <div>
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">All Recurring Expense Templates ({allTemplates.length})</h4>
 <p className="text-[10px] text-slate-400 mt-0.5">Define active recurring workflows or deactivate temporarily so they don't block month closing</p>
 </div>
 <button
 onClick={handleStartAddTemplate}
 className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition flex items-center gap-1 shadow-sm cursor-pointer"
 >
 <Plus className="w-3.5 h-3.5" /> Add Template
 </button>
 </div>

 <div className="divide-y divide-slate-100 ">
 {allTemplates.length === 0 ? (
 <div className="p-8 text-center text-slate-400 text-xs">
 No recurring templates. Create one to automate standard operations!
 </div>
 ) : (
 allTemplates.map(t => {
 const vendor = db.vendors.find(v => v.id === t.vendorId);
 const bank = db.banks.find(b => b.id === t.bankId);
 const taxSlab = db.taxSlabs.find(ts => ts.id === t.taxSlabId);
 
 return (
 <div key={t.id} className="p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 hover:bg-slate-50/20 transition">
 <div className="space-y-1 font-sans">
 <div className="flex items-center gap-2">
 <span className="text-xs font-bold text-slate-900 ">{t.description}</span>
 <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wide ${
 t.isActive ? 'bg-emerald-100 text-emerald-800 ' : 'bg-slate-100 text-slate-800 '
 }`}>
 {t.isActive ? 'Active' : 'Inactive'}
 </span>
 </div>
 <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-400 font-mono">
 <span>Default Cost: <strong className="text-slate-700 ">{currencySymbol} {t.defaultAmount.toFixed(2)}</strong></span>
 <span>•</span>
 <span>Account: <strong className="text-slate-700 ">{bank?.bankName || 'Default'}</strong></span>
 <span>•</span>
 <span>Vendor: <strong className="text-slate-700 ">{vendor?.name || 'Cash Vendor'}</strong></span>
 <span>•</span>
 <span>Tax Slab: <strong className="text-slate-700 ">{taxSlab?.name || 'No Tax'}</strong></span>
 </div>
 </div>

 <div className="flex items-center gap-2 shrink-0">
 {/* Toggle active state */}
 <button
 onClick={() => handleToggleTemplateActive(t)}
 title={t.isActive ? 'Deactivate template' : 'Activate template'}
 className={`p-1.5 rounded-lg border transition cursor-pointer ${
 t.isActive 
 ? 'bg-emerald-50 border-emerald-200 text-emerald-600 hover:bg-emerald-100 ' 
 : 'bg-slate-50 border-slate-200 text-slate-400 hover:bg-slate-100 '
 }`}
 >
 {t.isActive ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
 </button>
 <button
 onClick={() => handleStartEditTemplate(t)}
 className="p-1.5 bg-slate-100 text-slate-700 hover:bg-slate-200 rounded-lg text-xs font-bold transition cursor-pointer animate-none"
 >
 <Edit2 className="w-3.5 h-3.5" />
 </button>
 <button
 onClick={() => handleDeleteTemplate(t.id)}
 className="p-1.5 bg-rose-50 text-rose-600 hover:bg-rose-100 :bg-rose-950/40 rounded-lg text-xs font-bold transition cursor-pointer"
 >
 <Trash2 className="w-3.5 h-3.5" />
 </button>
 </div>
 </div>
 );
 })
 )}
 </div>
 </div>
 </div>
 )}

 {subTab === 'accruals' && (
 <div className="space-y-6 animate-in fade-in duration-200">
 <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
 <div className="p-4 border-b border-slate-100 bg-slate-50/50">
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">All Active Accrual Entries ({db.expenses.filter(e => e.type === 'Accrual' && e.status === 'Active').length})</h4>
 <p className="text-[10px] text-slate-400 mt-0.5">Review, correct, or delete any generated accrual liability records before they are settled</p>
 </div>

 <div className="divide-y divide-slate-100 ">
 {db.expenses.filter(e => e.type === 'Accrual' && e.status === 'Active').length === 0 ? (
 <div className="p-8 text-center text-slate-400 text-xs">
 No active accrual entries found.
 </div>
 ) : (
 db.expenses.filter(e => e.type === 'Accrual' && e.status === 'Active').map(acc => {
 const vendor = db.vendors.find(v => v.id === acc.vendorId);
 const bank = db.banks.find(b => b.id === acc.bankId);
 
 return (
 <div key={acc.id} className="p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 hover:bg-slate-50/20 transition">
 <div className="space-y-1">
 <div className="flex items-center gap-2">
 <span className="text-xs font-bold text-slate-900 ">{acc.description}</span>
 <span className="text-[9px] font-bold text-slate-500 bg-slate-100 px-2 py-0.5 rounded uppercase">
 {acc.expenseNumber}
 </span>
 {acc.accrualSettled ? (
 <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wide bg-emerald-100 text-emerald-800 ">
 Settled
 </span>
 ) : (
 <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wide bg-amber-100 text-amber-800 font-extrabold">
 Outstanding Accrual
 </span>
 )}
 </div>
 <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-400">
 <span>Amount: <strong className="text-slate-700 ">{currencySymbol} {acc.amount.toFixed(2)}</strong></span>
 <span>•</span>
 <span>Date: <strong className="text-slate-700 ">{acc.date}</strong></span>
 <span>•</span>
 <span>Vendor: <strong className="text-slate-700 ">{vendor?.name || 'Cash Vendor'}</strong></span>
 <span>•</span>
 <span>Accrued Bank: <strong className="text-slate-700 ">{bank?.bankName || 'Default'}</strong></span>
 </div>
 </div>

 <div className="flex items-center gap-2 shrink-0">
 {!acc.accrualSettled && (
 <button
 onClick={() => handleStartEditAccrual(acc)}
 className="px-2.5 py-1.5 bg-slate-100 text-slate-700 hover:bg-slate-200 rounded-lg text-xs font-bold transition flex items-center gap-1 cursor-pointer"
 >
 <Edit2 className="w-3.5 h-3.5" /> Edit
 </button>
 )}
 <button
 onClick={() => handleDeleteAccrual(acc.id)}
 className="p-1.5 bg-rose-50 text-rose-600 hover:bg-rose-100 :bg-rose-950/40 rounded-lg text-xs font-bold transition cursor-pointer"
 >
 <Trash2 className="w-3.5 h-3.5" />
 </button>
 </div>
 </div>
 );
 })
 )}
 </div>
 </div>
 </div>
 )}

 {/* Templates Add/Edit Modal */}
 {isAddingTemplate && (
 <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex justify-center items-center p-4 overflow-y-auto">
 <div className="bg-white rounded-2xl border border-slate-100 shadow-2xl p-6 w-full max-w-md my-auto animate-in fade-in zoom-in-95 duration-100">
 <div className="flex justify-between items-center mb-1">
 <h3 className="font-bold text-sm text-slate-900 ">
 {editingTemplate ? t('Edit Recurring Template') : t('Add New Recurring Template')}
 </h3>
 <button
 type="button"
 onClick={() => setIsAddingTemplate(false)}
 className="text-slate-400 hover:text-slate-600 :text-slate-200 cursor-pointer"
 >
 <XCircle className="w-5 h-5" />
 </button>
 </div>
 <p className="text-xs text-slate-400 mb-4">Define a template for monthly ledger items (e.g. Workshop rent, system power bills)</p>

 <form onSubmit={handleSaveTemplate} className="space-y-4 text-xs">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Description / Title</label>
 <input
 type="text"
 required
 placeholder="e.g. Monthly workshop supervisor salary pool"
 value={templateForm.description}
 onChange={(e) => setTemplateForm({ ...templateForm, description: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>

 <div className="grid grid-cols-2 gap-3">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Default Amount ({currencySymbol})</label>
 <input
 type="number"
 step="0.01"
 required
 placeholder="e.g. 2500"
 value={templateForm.defaultAmount}
 onChange={(e) => setTemplateForm({ ...templateForm, defaultAmount: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Tax Slab</label>
 <select
 required
 value={templateForm.taxSlabId}
 onChange={(e) => setTemplateForm({ ...templateForm, taxSlabId: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 >
 {db.taxSlabs.map(ts => (
 <option key={ts.id} value={ts.id}>{ts.name}</option>
 ))}
 </select>
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Vendor</label>
 <select
 required
 value={templateForm.vendorId}
 onChange={(e) => setTemplateForm({ ...templateForm, vendorId: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 >
 {db.vendors.filter(v => v.companyId === db.selectedCompanyId || !v.companyId).map(v => (
 <option key={v.id} value={v.id}>{v.name}</option>
 ))}
 </select>
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Bank Account</label>
 <select
 required
 value={templateForm.bankId}
 onChange={(e) => setTemplateForm({ ...templateForm, bankId: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 >
 {db.banks.filter(b => b.isActive && b.companyId === db.selectedCompanyId).map(b => (
 <option key={b.id} value={b.id}>{b.bankName}</option>
 ))}
 </select>
 </div>

 <div className="col-span-2 flex items-center gap-2 pt-2">
 <input
 type="checkbox"
 id="template-active"
 checked={templateForm.isActive}
 onChange={(e) => setTemplateForm({ ...templateForm, isActive: e.target.checked })}
 className="w-4 h-4 text-indigo-600 border-slate-300 rounded focus:ring-indigo-500 cursor-pointer"
 />
 <label htmlFor="template-active" className="text-xs font-semibold text-slate-700 cursor-pointer select-none">
 Is Active Template (Required to post for month closing)
 </label>
 </div>
 </div>

 <div className="flex justify-end gap-2 pt-2">
 <button
 type="button"
 onClick={() => setIsAddingTemplate(false)}
 className="px-3 py-1.5 bg-slate-100 text-slate-500 rounded-lg text-xs font-semibold hover:bg-slate-200 transition cursor-pointer"
 >
 Cancel
 </button>
 <button
 type="submit"
 className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold transition shadow-sm cursor-pointer"
 >
 Save Template
 </button>
 </div>
 </form>
 </div>
 </div>
 )}

 {/* Accruals Edit Modal */}
 {editingAccrual && (
 <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex justify-center items-center p-4 overflow-y-auto">
 <div className="bg-white rounded-2xl border border-slate-100 shadow-2xl p-6 w-full max-w-md my-auto animate-in fade-in zoom-in-95 duration-100">
 <div className="flex justify-between items-center mb-1">
 <h3 className="font-bold text-sm text-slate-900 ">{t('Edit Accrual Ledger Entry')}</h3>
 <button
 type="button"
 onClick={() => setEditingAccrual(null)}
 className="text-slate-400 hover:text-slate-600 :text-slate-200 cursor-pointer"
 >
 <XCircle className="w-5 h-5" />
 </button>
 </div>
 <p className="text-xs text-slate-400 mb-4">Modify the liability description or amount of this active accrual ledger item ({editingAccrual.expenseNumber})</p>

 <form onSubmit={handleSaveAccrual} className="space-y-4 text-xs">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Description</label>
 <input
 type="text"
 required
 value={accrualForm.description}
 onChange={(e) => setAccrualForm({ ...accrualForm, description: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>

 <div className="grid grid-cols-2 gap-3">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Accrual Amount ({currencySymbol})</label>
 <input
 type="number"
 step="0.01"
 required
 value={accrualForm.amount}
 onChange={(e) => setAccrualForm({ ...accrualForm, amount: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Accrual Date</label>
 <input
 type="date"
 required
 value={accrualForm.date}
 onChange={(e) => setAccrualForm({ ...accrualForm, date: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Vendor</label>
 <select
 required
 value={accrualForm.vendorId}
 onChange={(e) => setAccrualForm({ ...accrualForm, vendorId: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 >
 {db.vendors.filter(v => v.companyId === db.selectedCompanyId || !v.companyId).map(v => (
 <option key={v.id} value={v.id}>{v.name}</option>
 ))}
 </select>
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Bank Account</label>
 <select
 required
 value={accrualForm.bankId}
 onChange={(e) => setAccrualForm({ ...accrualForm, bankId: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 >
 {db.banks.filter(b => b.isActive && b.companyId === db.selectedCompanyId).map(b => (
 <option key={b.id} value={b.id}>{b.bankName}</option>
 ))}
 </select>
 </div>
 </div>

 <div className="flex justify-end gap-2 pt-2">
 <button
 type="button"
 onClick={() => setEditingAccrual(null)}
 className="px-3 py-1.5 bg-slate-100 text-slate-500 rounded-lg text-xs font-semibold hover:bg-slate-200 transition cursor-pointer"
 >
 Cancel
 </button>
 <button
 type="submit"
 className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold transition shadow-sm cursor-pointer"
 >
 Save Changes
 </button>
 </div>
 </form>
 </div>
 </div>
 )}

 {/* Posting Dialog (Modal) */}
 {postingTemplate && (
 <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex justify-center items-center p-4 overflow-y-auto">
 <div className="bg-white rounded-2xl border border-slate-100 shadow-2xl p-6 w-full max-w-md my-auto animate-in fade-in zoom-in-95 duration-100">
 <h3 className="font-bold text-sm text-slate-900 mb-1">{t('Post Recurring Expense')}</h3>
 <p className="text-xs text-slate-400 mb-4">{postingTemplate.description}</p>

 <form onSubmit={handlePostRecurring} className="space-y-4 text-xs">
 {/* Type Switch */}
 <div className="space-y-1.5">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Posting Category</label>
 <div className="grid grid-cols-2 gap-2 bg-slate-100 p-1 rounded-xl">
 <button
 type="button"
 onClick={() => setPostType('Actual')}
 className={`py-1 text-center font-bold rounded-lg transition cursor-pointer ${
 postType === 'Actual' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500 hover:text-slate-700 :text-slate-300'
 }`}
 >
 Actual Expense
 </button>
 <button
 type="button"
 onClick={() => setPostType('Accrual')}
 className={`py-1 text-center font-bold rounded-lg transition cursor-pointer ${
 postType === 'Accrual' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500 hover:text-slate-700 :text-slate-300'
 }`}
 >
 Accrual Entry
 </button>
 </div>
 <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">
 {postType === 'Actual' 
 ? 'Generates a live expense record. If status is Paid, it automatically generates a Bank Payment Voucher.'
 : 'Records expense liability without cash flow. Accruals satisfy closure checks but do not generate a bank voucher.'
 }
 </p>
 </div>

 <div className="grid grid-cols-2 gap-3">
 <div className="space-y-1 col-span-2">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Amount ({currencySymbol})</label>
 <input
 type="number"
 step="0.01"
 required
 value={postForm.amount}
 onChange={(e) => setPostForm({ ...postForm, amount: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Posting Date</label>
 <input
 type="date"
 required
 value={postForm.date}
 onChange={(e) => setPostForm({ ...postForm, date: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Payment Bank Account</label>
 <select
 required
 disabled={postType === 'Accrual'}
 value={postForm.bankId}
 onChange={(e) => setPostForm({ ...postForm, bankId: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none disabled:bg-slate-100 :bg-slate-850 disabled:text-slate-400 focus:ring-1 focus:ring-indigo-500"
 >
 {db.banks.filter(b => b.isActive && b.companyId === db.selectedCompanyId).map(b => (
 <option key={b.id} value={b.id}>{b.bankName}</option>
 ))}
 </select>
 </div>

 {postType === 'Actual' && (
 <div className="col-span-2 space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Payment Status</label>
 <div className="flex gap-4 p-1">
 <label className="flex items-center gap-1.5 cursor-pointer ">
 <input
 type="radio"
 name="payStatus"
 checked={postForm.paymentStatus === 'Paid'}
 onChange={() => setPostForm({ ...postForm, paymentStatus: 'Paid' })}
 />
 <span>Paid (triggers Payment Voucher)</span>
 </label>
 <label className="flex items-center gap-1.5 cursor-pointer ">
 <input
 type="radio"
 name="payStatus"
 checked={postForm.paymentStatus === 'Unpaid'}
 onChange={() => setPostForm({ ...postForm, paymentStatus: 'Unpaid' })}
 />
 <span>Pending</span>
 </label>
 </div>
 </div>
 )}
 </div>

 <div className="flex justify-end gap-2 pt-2">
 <button
 type="button"
 onClick={() => setPostingTemplate(null)}
 className="px-3 py-1.5 bg-slate-100 text-slate-500 rounded-lg text-xs font-semibold hover:bg-slate-200 transition cursor-pointer"
 >
 Cancel
 </button>
 <button
 type="submit"
 className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold transition shadow-sm cursor-pointer"
 >
 Post to Ledger
 </button>
 </div>
 </form>
 </div>
 </div>
 )}

 {/* Settle Accrual Dialog (Modal) */}
 {settlingAccrual && (
 <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex justify-center items-center p-4 overflow-y-auto">
 <div className="bg-white rounded-2xl border border-slate-100 shadow-2xl p-6 w-full max-w-md my-auto animate-in fade-in zoom-in-95 duration-100">
 <h3 className="font-bold text-sm text-slate-900 mb-1">{t('Settle Accrual Liability')}</h3>
 <p className="text-xs text-slate-400 mb-4">Prior accrual: {settlingAccrual.description} ({currencySymbol} {settlingAccrual.amount.toFixed(2)})</p>

 <form onSubmit={handleSettleAccrual} className="space-y-4 text-xs">
 <div className="grid grid-cols-2 gap-3">
 <div className="space-y-1 col-span-2">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Actual Bill Invoice Amount ({currencySymbol})</label>
 <input
 type="number"
 step="0.01"
 required
 value={settleForm.amount}
 onChange={(e) => setSettleForm({ ...settleForm, amount: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Actual Settlement Date</label>
 <input
 type="date"
 required
 value={settleForm.date}
 onChange={(e) => setSettleForm({ ...settleForm, date: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Select Bank</label>
 <select
 required
 value={settleForm.bankId}
 onChange={(e) => setSettleForm({ ...settleForm, bankId: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 >
 {db.banks.filter(b => b.isActive && b.companyId === db.selectedCompanyId).map(b => (
 <option key={b.id} value={b.id}>{b.bankName}</option>
 ))}
 </select>
 </div>

 <div className="col-span-2 space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Settlement Payment Status</label>
 <div className="flex gap-4 p-1">
 <label className="flex items-center gap-1.5 cursor-pointer ">
 <input
 type="radio"
 name="settlePayStatus"
 checked={settleForm.paymentStatus === 'Paid'}
 onChange={() => setSettleForm({ ...settleForm, paymentStatus: 'Paid' })}
 />
 <span>Paid (posts cash out voucher now)</span>
 </label>
 <label className="flex items-center gap-1.5 cursor-pointer ">
 <input
 type="radio"
 name="settlePayStatus"
 checked={settleForm.paymentStatus === 'Unpaid'}
 onChange={() => setSettleForm({ ...settleForm, paymentStatus: 'Unpaid' })}
 />
 <span>Pending Actual Payment</span>
 </label>
 </div>
 </div>
 </div>

 <div className="flex justify-end gap-2 pt-2">
 <button
 type="button"
 onClick={() => setSettlingAccrual(null)}
 className="px-3 py-1.5 bg-slate-100 text-slate-500 rounded-lg text-xs font-semibold hover:bg-slate-200 transition cursor-pointer"
 >
 Cancel
 </button>
 <button
 type="submit"
 className="px-4 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg font-bold transition shadow-sm cursor-pointer"
 >
 Settle Accrual
 </button>
 </div>
 </form>
 </div>
 </div>
 )}

 </div>
 );
}
