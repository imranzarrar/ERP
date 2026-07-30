import React from 'react';
import { useTranslation } from '../hooks';
// from 'react';
import { DatabaseState, saveDatabase, getActiveOpenMonth, isDateInOpenMonth, markInvoicePaid, calculateInvoiceTotals } from '../dbStore';
import { generateId } from '../id';
import { Invoice, InvoiceItem, Customer, TaxSlab, BankAccount, User, normalizePermissions } from '../types';
import StatusPill, { StatusPillTone } from './StatusPill';
import {
  FileText,
  Plus,
  Trash,
  Check,
  Printer,
  ChevronRight,
  AlertTriangle,
  Search,
  CheckSquare,
  Ban,
  Lock,
  Calendar,
  ChevronUp,
  ChevronDown,
  Paperclip,
  X,
  Maximize2,
  TrendingUp,
  DollarSign,
  Clock,
  CreditCard,
  Sparkles,
  Receipt,
  Building,
  UserCheck,
  ShieldCheck,
  QrCode,
  FileCode,
  RefreshCw
} from 'lucide-react';

interface InvoiceModuleProps {
 db: DatabaseState;
 onUpdateDb: (db: DatabaseState) => void;
 onPrintDoc: (type: 'Quotation' | 'Invoice' | 'Expense', data: any) => void;
 // 'list' renders the Sales Invoices table; 'add' renders the create form — each is
 // mounted under its own nav tab/permission (invoices vs invoices-add). No edit mode:
 // invoices are never modified in place, only paid/cancelled (existing row actions).
 mode: 'list' | 'add';
 onDone: () => void;
 onCreateNew: () => void;
}

export default function InvoiceModule({ db, onUpdateDb, onPrintDoc, mode, onDone, onCreateNew }: InvoiceModuleProps) {
 const { t, isRTL, lang } = useTranslation(db);
 const currentUser = db.currentUser;
 const isAdmin = currentUser?.role === 'admin' || currentUser?.isSuperAdmin === true;
 const userPermissions = normalizePermissions(currentUser?.permissions, currentUser?.role, currentUser?.isSuperAdmin);
 const openMonth = getActiveOpenMonth(db, db.selectedCompanyId);
 const currencySymbol = db.companySetup?.currency || 'SAR';

 // Sorting state (default: createdAt descending, so newly added is on top!)
 const [sortField, setSortField] = React.useState<string>('createdAt');
 const [sortOrder, setSortOrder] = React.useState<'asc' | 'desc'>('desc');

 // Pagination state
 const [currentPage, setCurrentPage] = React.useState(1);
 const itemsPerPage = 20;

 // List Filters
 const [filterStartDate, setFilterStartDate] = React.useState<string>('');
 const [filterEndDate, setFilterEndDate] = React.useState<string>("");
 const [filterStatus, setFilterStatus] = React.useState<'All' | 'Unpaid'>('All');
 const [filterZatcaStatus, setFilterZatcaStatus] = React.useState<string>('All');
 const [filterDocType, setFilterDocType] = React.useState<'All' | 'Invoice' | 'CreditNote' | 'DebitNote'>('All');
 const [zatcaModalInvoice, setZatcaModalInvoice] = React.useState<Invoice | null>(null);
 const [isSubmittingZatca, setIsSubmittingZatca] = React.useState<boolean>(false);

 // Update filters if openMonth changes
  // Filter Invoices
  const filteredInvoices = React.useMemo(() => {
    return db.invoices.filter(inv => {
      // Company Filter
      if (inv.companyId !== db.selectedCompanyId) return false;

      // Date & Status Filters
      if (filterStartDate && inv.date < filterStartDate) return false;
      if (filterEndDate && inv.date > filterEndDate) return false;
      if (filterStatus === "Unpaid" && (inv.paymentStatus === "Paid" || inv.status !== "Active")) return false;

      // ZATCA Status Filter
      if (filterZatcaStatus !== 'All') {
        const zStatus = inv.zatcaStatus || 'NOT_SUBMITTED';
        if (filterZatcaStatus === 'CLEARED_REPORTED' && zStatus !== 'CLEARED' && zStatus !== 'REPORTED') return false;
        if (filterZatcaStatus === 'PENDING' && zStatus !== 'PENDING') return false;
        if (filterZatcaStatus === 'REJECTED_ERROR' && zStatus !== 'REJECTED' && zStatus !== 'ERROR') return false;
        if (filterZatcaStatus === 'NOT_SUBMITTED' && zStatus !== 'NOT_SUBMITTED') return false;
      }

      // Document Type Filter (Invoice / Credit Note / Debit Note) — these all live in
      // the same table (see BACKLOG.md item 32), previously indistinguishable in this
      // list except by reading the invoice number prefix.
      if (filterDocType !== 'All') {
        const docType = inv.documentType || 'Invoice';
        if (docType !== filterDocType) return false;
      }

      return isAdmin || userPermissions.invoice.view.enabled || (currentUser?.id ? inv.createdById === currentUser.id : false);
    });
  }, [db.invoices, db.selectedCompanyId, filterStartDate, filterEndDate, filterStatus, filterZatcaStatus, filterDocType, isAdmin, currentUser]);

 // Reset page when length changes
 React.useEffect(() => {
 setCurrentPage(1);
 }, [filteredInvoices.length]);

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
 // Default to today only if today's own month is among the open ones (with several months
 // open concurrently, today's month need not be the oldest); otherwise fall back to the
 // 1st of the oldest open month.
 const initialDate = openMonth ? (isDateInOpenMonth(db, today) ? today : `${openMonth.id}-01`) : today;
 const defaultCust = db.customers.find(c => c.isSystem && (c.companyId === db.selectedCompanyId || !c.companyId))?.id || db.customers.find(c => c.companyId === db.selectedCompanyId || !c.companyId)?.id || '';
 const defaultTax = db.taxSlabs.find(t => t.percentage === 0)?.id || db.taxSlabs[0]?.id || '';
 const defaultBank = db.banks.find(b => b.isDefault && b.companyId === db.selectedCompanyId)?.id || db.banks.find(b => b.companyId === db.selectedCompanyId)?.id || '';
 setFormDate(initialDate);
 setFormCustomerId(defaultCust);
 setFormTaxSlabId(defaultTax);
 setFormBankId(defaultBank);
 setFormItems([{ description: '', unitCost: 0, quantity: 1, discountAmount: 0, taxSlabId: defaultTax }]);
 }
 setPayingInvoice(null);
 }, [db.selectedCompanyId, openMonth?.id]);

 const triggerError = (msg: string) => {
 setError(msg);
 setTimeout(() => setError(null), 4500);
 };

 const handleManualZatcaSubmit = async (invoiceId: string) => {
   setIsSubmittingZatca(true);
   try {
     const res = await fetch(`/api/zatca/submit-invoice/${invoiceId}`, {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
     });
     const data = await res.json();
     if (!res.ok || data.error) {
       triggerError(data.error || 'Failed to submit to ZATCA');
     } else {
       triggerSuccess(`ZATCA Submission Status: ${data.status || 'Success'}`);
       const refreshed = await fetch('/api/state').then(r => r.json()).catch(() => null);
       if (refreshed) {
         onUpdateDb(refreshed);
         const updatedInv = refreshed.invoices?.find((i: Invoice) => i.id === invoiceId);
         if (updatedInv) setZatcaModalInvoice(updatedInv);
       }
     }
   } catch (err: any) {
     triggerError(err.message || 'Error submitting to ZATCA');
   } finally {
     setIsSubmittingZatca(false);
   }
 };

 // View state — fixed for the lifetime of this mount by which page (mode) rendered it.
 const [viewAttachment, setViewAttachment] = React.useState<string | null>(null);
 const [view] = React.useState<'list' | 'create'>(mode === 'add' ? 'create' : 'list');
 const [isSavingInvoice, setIsSavingInvoice] = React.useState(false);

 // Form states
 const [formDate, setFormDate] = React.useState('');
 const [formCustomerId, setFormCustomerId] = React.useState('');
 const [formTaxSlabId, setFormTaxSlabId] = React.useState('');
 const [formBankId, setFormBankId] = React.useState('');
 const [formPaymentStatus, setFormPaymentStatus] = React.useState<'Paid' | 'Unpaid'>('Paid');
 const [formNotes, setFormNotes] = React.useState('');
 const [formAttachmentUrl, setFormAttachmentUrl] = React.useState('');
 const [formDiscountPercentage, setFormDiscountPercentage] = React.useState<number>(0);
 const [formItems, setFormItems] = React.useState<Omit<InvoiceItem, 'id'>[]>([
 { description: '', unitCost: 0, quantity: 1, discountAmount: 0 }
 ]);

 // Autocomplete support
 const [activeAutocompleteIdx, setActiveAutocompleteIdx] = React.useState<number | null>(null);
 const [autocompleteFilter, setAutocompleteFilter] = React.useState('');

 // Sub-payment prompt modal
 const [payingInvoice, setPayingInvoice] = React.useState<Invoice | null>(null);
 const [payForm, setPayForm] = React.useState({
 date: openMonth ? `${openMonth.id}-01` : '',
 bankId: '',
 amount: ''
 });

 // Credit/Debit Note modal — creates a new ZATCA document referencing an existing
 // invoice (full-document reversal only; see server/routes/transactions.ts's
 // POST /invoices/:id/note for the MVP scope note).
 const [noteInvoice, setNoteInvoice] = React.useState<Invoice | null>(null);
 const [noteForm, setNoteForm] = React.useState<{ type: 'CreditNote' | 'DebitNote'; reason: string }>({ type: 'CreditNote', reason: '' });
 const [isSavingNote, setIsSavingNote] = React.useState(false);
 // Local to the modal, not the page-level success/error banners — this modal is a
 // `fixed inset-0` full-screen overlay, so a banner rendered in the page behind it is
 // completely covered regardless of z-index (fixed-position elements establish their
 // own stacking context above normal in-flow content). Confirmed live: a real create
 // failure produced zero visible feedback and left the modal open with no way to tell
 // what happened except clicking Cancel.
 const [noteError, setNoteError] = React.useState<string | null>(null);

 const handleCreateNote = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!noteInvoice) return;
 setIsSavingNote(true);
 setNoteError(null);
 try {
 const res = await fetch(`/api/transactions/invoices/${noteInvoice.id}/note?companyId=${db.selectedCompanyId}`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ type: noteForm.type, reason: noteForm.reason }),
 });
 const result = await res.json();
 if (!res.ok || result.error) {
 throw new Error(result.error || 'Failed to create the note.');
 }
 const refreshed = await fetch('/api/state').then(r => r.json()).catch(() => null);
 if (!refreshed) {
 throw new Error('Note created, but the workspace could not be refreshed. Please reload the page.');
 }
 onUpdateDb(refreshed);
 const newNote = refreshed.invoices?.find((i: Invoice) => i.id === result.noteId);
 const noteLabel = noteForm.type === 'CreditNote' ? 'Credit' : 'Debit';
 triggerSuccess(`${noteLabel} Note ${newNote?.invoiceNumber || ''} created against ${noteInvoice.invoiceNumber}.`);
 setNoteInvoice(null);
 setNoteForm({ type: 'CreditNote', reason: '' });
 // Immediately open the new document's print/preview so its creation is visibly
 // confirmed, matching the same pattern handleSaveInvoice already uses — otherwise
 // the only way to see it succeeded is to spot the new row in the list yourself.
 if (newNote) {
 const cust = refreshed.customers?.find((c: Customer) => c.id === newNote.customerId);
 const bank = refreshed.banks?.find((b: BankAccount) => b.id === newNote.bankId);
 onPrintDoc('Invoice', { ...newNote, customerData: cust, bankData: bank });
 }
 } catch (err: any) {
 setNoteError(err.message || 'Failed to create the note.');
 } finally {
 setIsSavingNote(false);
 }
 };

 const salesProducts = React.useMemo(() => {
   return (db.products || []).filter(p => {
     const isCompMatch = !p.companyId || p.companyId === db.selectedCompanyId;
     const pType = (p.type || '').toLowerCase();
     return isCompMatch && pType !== 'purchase';
   });
 }, [db.products, db.selectedCompanyId]);

 // Navigate to the dedicated Add page for creation
 const handleInitiateCreate = () => {
 if (!openMonth) return triggerError('Please open a fiscal month first.');
 onCreateNew();
 };

 const handleAddLineItem = () => {
 setFormItems([...formItems, { description: '', unitCost: 0, quantity: 1, discountAmount: 0, taxSlabId: formTaxSlabId }]);
 };

 const handleRemoveLineItem = (idx: number) => {
 if (formItems.length === 1) return;
 setFormItems(formItems.filter((_, i) => i !== idx));
 };

 const handleUpdateLineItem = (idx: number, field: keyof Omit<InvoiceItem, 'id'>, val: any) => {
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
 const handleSaveInvoice = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!isAdmin && !userPermissions.invoice.create.enabled) {
 return triggerError('You do not have permission to issue sales invoices.');
 }

 const validItems = formItems.filter(item => item.description && item.description.trim() !== "");
 if (validItems.length === 0) {
 return triggerError('Please add at least one line item with a description.');
 }

 const cleanItems: InvoiceItem[] = validItems.map(item => ({
 id: generateId(),
 description: item.description.trim(),
 unitCost: parseFloat(item.unitCost as any) || 0,
 quantity: parseFloat(item.quantity as any) || 1,
 discountAmount: parseFloat(item.discountAmount as any) || 0,
 taxSlabId: item.taxSlabId || formTaxSlabId
 }));

 const resolvedCustomerId = formCustomerId || db.customers.find(c => c.isSystem && (c.companyId === db.selectedCompanyId || !c.companyId))?.id || db.customers.find(c => c.companyId === db.selectedCompanyId || !c.companyId)?.id || db.customers[0]?.id || '';
 const totals = calculateInvoiceTotals(db, cleanItems, formTaxSlabId, formDiscountPercentage);

 const invoiceData = {
 date: formDate,
 customerId: resolvedCustomerId,
 taxSlabId: formTaxSlabId,
 bankId: formBankId,
 paymentStatus: formPaymentStatus,
 paymentDate: formPaymentStatus === 'Paid' ? formDate : null,
 notes: formNotes,
 status: 'Active' as const,
 originQuotationId: null,
 items: cleanItems,
 discountPercentage: formDiscountPercentage,
 attachmentUrl: formAttachmentUrl,
 amountPaid: formPaymentStatus === 'Paid' ? totals.grandTotal : 0
 };

 // Bring Invoice save up to the same standard QuotationModule's handleSaveQuotation
 // already uses: await the real dedicated save endpoint, check the response is
 // actually ok, and only THEN reflect success/open the print preview — instead of
 // mutating local state and showing success before any request to the server had
 // even been made.
 setIsSavingInvoice(true);
 try {
   const response = await fetch(`/api/transactions/invoices?companyId=${db.selectedCompanyId}`, {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ invoiceData })
   });

   if (!response.ok) {
     const errData = await response.json().catch(() => ({}));
     throw new Error(errData.error || 'Failed to save invoice.');
   }

   const result = await response.json();

   // The dedicated endpoint is the source of truth for the generated invoice number,
   // computed totals, and items — refresh from it rather than trusting local echo.
   const refreshed = await fetch('/api/state').then(r => r.json()).catch(() => null);
   if (!refreshed) {
     throw new Error('Invoice saved, but the workspace could not be refreshed. Please reload the page.');
   }
   onUpdateDb(refreshed);

   const newInv = refreshed.invoices?.find((i: Invoice) => i.id === result.invoiceId);
   triggerSuccess(`Invoice ${newInv?.invoiceNumber || ''} issued successfully.`);

   if (newInv) {
     // Finalized creation flow: go straight to the invoice's print/preview overlay
     // (the same DocumentRenderer every other Print button uses) instead of forcing
     // the ZATCA details modal open. The dedicated save endpoint above already
     // auto-triggers ZATCA clearance/reporting server-side (fire-and-forget) — poll
     // once, shortly after, so a rejection is surfaced here too instead of only
     // being discoverable by reopening the invoice's ZATCA modal later.
     const cust = refreshed.customers?.find((c: Customer) => c.id === newInv.customerId) || db.customers.find(c => c.id === newInv.customerId);
     const bank = refreshed.banks?.find((b: BankAccount) => b.id === newInv.bankId) || db.banks.find(b => b.id === newInv.bankId);
     onPrintDoc('Invoice', { ...newInv, customerData: cust, bankData: bank });

     setTimeout(() => {
       fetch('/api/state').then(r => r.json()).then(latest => {
         if (!latest?.invoices) return;
         onUpdateDb(latest);
         const latestInv = latest.invoices.find((i: Invoice) => i.id === newInv.id);
         const zStatus = latestInv?.zatcaStatus;
         if (zStatus === 'REJECTED' || zStatus === 'ERROR') {
           const firstIssue = Array.isArray(latestInv?.zatcaValidationResults) && latestInv.zatcaValidationResults[0]?.message;
           triggerError(`ZATCA ${zStatus === 'REJECTED' ? 'rejected' : 'failed to process'} invoice ${latestInv.invoiceNumber}${firstIssue ? ': ' + firstIssue : '.'}`);
         } else if (zStatus === 'CLEARED' || zStatus === 'REPORTED') {
           triggerSuccess(`Invoice ${latestInv.invoiceNumber} ${zStatus === 'CLEARED' ? 'cleared' : 'reported'} by ZATCA.`);
         }
       }).catch(err => console.error('ZATCA status check error:', err));
     }, 2500);
   }

   onDone();
 } catch (err: any) {
   triggerError(err.message || 'Failed to save invoice.');
 } finally {
   setIsSavingInvoice(false);
 }
 };

 // Mark pending invoice paid
 const handleInitiatePay = (inv: Invoice) => {
 if (!openMonth) return triggerError('Please open a fiscal month first.');
 setPayingInvoice(inv);
 const today = new Date().toISOString().split('T')[0];
 const initialDate = isDateInOpenMonth(db, today) ? today : `${openMonth.id}-01`;
 const totalAmt = getInvoiceTotal(inv);
 const paidAmt = inv.amountPaid || 0;
 const remainingAmt = Number((totalAmt - paidAmt).toFixed(2));
 setPayForm({
 date: initialDate,
 bankId: inv.bankId || db.banks.find(b => b.isDefault)?.id || '',
 amount: remainingAmt.toString()
 });
 };

 const handleConfirmPay = (e: React.FormEvent) => {
 e.preventDefault();
 if (!payingInvoice) return;

 const amt = parseFloat(payForm.amount);
 if (isNaN(amt) || amt <= 0) {
 return triggerError('Please enter a valid payment amount greater than zero.');
 }

 const result = markInvoicePaid(db, payingInvoice.id, payForm.date, payForm.bankId, amt);
 if (result.error) {
 triggerError(result.error);
 } else {
 triggerSuccess(`Invoice ${payingInvoice.invoiceNumber} payment of ${amt} ${currencySymbol} received and receipt voucher generated.`);
 onUpdateDb(result.db);
 setPayingInvoice(null);
 }
 };

 // Cancel invoice
 const handleCancelInvoice = async (invId: string) => {
 const canCancel = isAdmin || userPermissions.cancel.access.enabled;
 if (!canCancel) return triggerError('You do not have cancellation permission.');

 try {
   const res = await fetch(`/api/transactions/invoices/${invId}/cancel`, {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
   });
   const data = await res.json();
   if (!res.ok || data.error) {
     triggerError(data.error || 'Failed to cancel invoice.');
   } else {
     const refreshed = await fetch('/api/state').then(r => r.json()).catch(() => null);
     if (refreshed) onUpdateDb(refreshed);
     triggerSuccess('Invoice cancelled successfully. Reverse receipt vouchers posted.');
   }
 } catch (err: any) {
   triggerError(err.message || 'Error cancelling invoice.');
 }
 };

 // Helper to format invoice grand total
 const getInvoiceTotal = (inv: Invoice) => {
 const totals = calculateInvoiceTotals(db, inv.items, inv.taxSlabId, inv.discountPercentage);
 return totals.grandTotal;
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

 // Sort invoices
 const sortedInvoices = React.useMemo(() => {
 const list = [...filteredInvoices];
 
 if (sortField === 'createdAt') {
 list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
 return list;
 }

 list.sort((a, b) => {
 let valA: any = a[sortField as keyof Invoice];
 let valB: any = b[sortField as keyof Invoice];

 if (sortField === 'customer') {
 const custA = db.customers.find(c => c.id === a.customerId)?.name || '';
 const custB = db.customers.find(c => c.id === b.customerId)?.name || '';
 valA = custA.toLowerCase();
 valB = custB.toLowerCase();
 } else if (sortField === 'bank') {
 const bankA = db.banks.find(bk => bk.id === a.bankId)?.bankName || '';
 const bankB = db.banks.find(bk => bk.id === b.bankId)?.bankName || '';
 valA = bankA.toLowerCase();
 valB = bankB.toLowerCase();
 } else if (sortField === 'grandTotal') {
 valA = getInvoiceTotal(a);
 valB = getInvoiceTotal(b);
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
 }, [filteredInvoices, sortField, sortOrder, db.customers, db.banks]);

 // Paginated invoices
 const totalPages = Math.ceil(sortedInvoices.length / itemsPerPage);
 const paginatedInvoices = React.useMemo(() => {
 const startIdx = (currentPage - 1) * itemsPerPage;
 return sortedInvoices.slice(startIdx, startIdx + itemsPerPage);
 }, [sortedInvoices, currentPage]);

 // KPI Analytics
 const activeInvoices = React.useMemo(() => {
   return filteredInvoices.filter(i => i.status === 'Active');
 }, [filteredInvoices]);

 const kpiTotalInvoiced = React.useMemo(() => {
   return activeInvoices.reduce((sum, inv) => sum + getInvoiceTotal(inv), 0);
 }, [activeInvoices]);

 const kpiTotalCollected = React.useMemo(() => {
   return activeInvoices.reduce((sum, inv) => {
     const tot = getInvoiceTotal(inv);
     if (inv.paymentStatus === 'Paid') return sum + tot;
     return sum + (inv.amountPaid || 0);
   }, 0);
 }, [activeInvoices]);

 const kpiPendingBalance = kpiTotalInvoiced - kpiTotalCollected;
 const kpiPaidCount = activeInvoices.filter(i => i.paymentStatus === 'Paid').length;
 const kpiPendingCount = activeInvoices.filter(i => i.paymentStatus === 'Unpaid' || i.paymentStatus === 'Partially Paid').length;

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

 {/* Workspace KPI Analytics Cards */}
 {view === 'list' && (
   <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
     {/* Total Invoiced */}
     <div className="p-4 rounded-2xl bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 text-white shadow-xl border border-indigo-900/60 relative overflow-hidden group">
       <div className="absolute -end-3 -bottom-3 w-20 h-20 bg-indigo-500/10 rounded-full blur-xl group-hover:bg-indigo-500/20 transition-all" />
       <div className="flex items-center justify-between mb-2">
         <span className="text-[10px] font-extrabold text-indigo-300 uppercase tracking-wider">{t("Total Invoiced")}</span>
         <span className="p-2 bg-indigo-600/30 border border-indigo-500/30 rounded-xl text-indigo-300">
           <Receipt className="w-4 h-4" />
         </span>
       </div>
       <div className="text-xl font-extrabold tracking-tight">
         {kpiTotalInvoiced.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span className="text-xs font-semibold text-indigo-300/80">{currencySymbol}</span>
       </div>
       <div className="text-[10px] text-slate-400 mt-1 flex items-center gap-1 font-semibold">
         <Sparkles className="w-3 h-3 text-amber-400" />
         <span>{filteredInvoices.length} {t("invoices in scope")}</span>
       </div>
     </div>

     {/* Revenue Collected */}
     <div className="p-4 rounded-2xl bg-gradient-to-br from-emerald-950/90 via-slate-900 to-emerald-950/80 text-white shadow-xl border border-emerald-900/60 relative overflow-hidden group">
       <div className="absolute -end-3 -bottom-3 w-20 h-20 bg-emerald-500/10 rounded-full blur-xl group-hover:bg-emerald-500/20 transition-all" />
       <div className="flex items-center justify-between mb-2">
         <span className="text-[10px] font-extrabold text-emerald-300 uppercase tracking-wider">{t("Collected Revenue")}</span>
         <span className="p-2 bg-emerald-600/30 border border-emerald-500/30 rounded-xl text-emerald-300">
           <TrendingUp className="w-4 h-4" />
         </span>
       </div>
       <div className="text-xl font-extrabold tracking-tight text-emerald-400">
         {kpiTotalCollected.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span className="text-xs font-semibold text-emerald-300/80">{currencySymbol}</span>
       </div>
       <div className="text-[10px] text-emerald-300/80 mt-1 flex items-center gap-1 font-semibold">
         <CheckSquare className="w-3 h-3 text-emerald-400" />
         <span>{kpiPaidCount} {t("fully settled")}</span>
       </div>
     </div>

     {/* Pending Balance */}
     <div className="p-4 rounded-2xl bg-gradient-to-br from-amber-950/80 via-slate-900 to-amber-950/70 text-white shadow-xl border border-amber-900/60 relative overflow-hidden group">
       <div className="absolute -end-3 -bottom-3 w-20 h-20 bg-amber-500/10 rounded-full blur-xl group-hover:bg-amber-500/20 transition-all" />
       <div className="flex items-center justify-between mb-2">
         <span className="text-[10px] font-extrabold text-amber-300 uppercase tracking-wider">{t("Pending Due")}</span>
         <span className="p-2 bg-amber-600/30 border border-amber-500/30 rounded-xl text-amber-300">
           <Clock className="w-4 h-4" />
         </span>
       </div>
       <div className="text-xl font-extrabold tracking-tight text-amber-400">
         {kpiPendingBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span className="text-xs font-semibold text-amber-300/80">{currencySymbol}</span>
       </div>
       <div className="text-[10px] text-amber-300/80 mt-1 flex items-center gap-1 font-semibold">
         <AlertTriangle className="w-3 h-3 text-amber-400" />
         <span>{kpiPendingCount} {t("awaiting payment")}</span>
       </div>
     </div>

     {/* Collection Rate */}
     <div className="p-4 rounded-2xl bg-gradient-to-br from-indigo-950 via-slate-900 to-slate-900 text-white shadow-xl border border-indigo-800/60 relative overflow-hidden group">
       <div className="flex items-center justify-between mb-2">
         <span className="text-[10px] font-extrabold text-indigo-300 uppercase tracking-wider">{t("Collection Rate")}</span>
         <span className="p-2 bg-indigo-600/30 border border-indigo-500/30 rounded-xl text-indigo-300">
           <CreditCard className="w-4 h-4" />
         </span>
       </div>
       <div className="text-xl font-extrabold tracking-tight">
         {kpiTotalInvoiced > 0 ? ((kpiTotalCollected / kpiTotalInvoiced) * 100).toFixed(1) : '100.0'}%
       </div>
       <div className="w-full bg-slate-800 h-1.5 rounded-full mt-2 overflow-hidden">
         <div 
           className="bg-emerald-400 h-full rounded-full transition-all duration-500" 
           style={{ width: `${kpiTotalInvoiced > 0 ? Math.min(100, (kpiTotalCollected / kpiTotalInvoiced) * 100) : 100}%` }}
         />
       </div>
     </div>
   </div>
 )}

 {/* LIST VIEW */}
 {view === 'list' && (
 <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
 <div className="p-4 border-b border-slate-100 bg-slate-50/70 flex flex-wrap justify-between items-center gap-3">
 <div>
 <h4 className="text-xs font-extrabold text-slate-800 uppercase tracking-wider flex items-center gap-2">
   <Receipt className="w-4 h-4 text-indigo-600" />
   <span>{t("Sales Invoices Workspace")}</span>
   <span className="text-[10px] font-bold text-slate-500 bg-slate-200/70 px-2 py-0.5 rounded-full">
     {filteredInvoices.length}
   </span>
 </h4>
 <div className="flex items-center gap-2 mt-1">
 <p className="text-[10px] text-slate-400">{isAdmin ? t('All shop sales records') : t('Your issued sales invoices')}</p>
 <span className="text-[9px] font-bold text-indigo-600 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded-full uppercase">
 🏢 {t("Scoped:")} {db.companySetup?.name}
 </span>
 </div>
 </div>
 {openMonth && (isAdmin || userPermissions.invoice.create.enabled) && (
 <button
 onClick={handleInitiateCreate}
 className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl px-4 py-2 text-xs font-extrabold flex items-center gap-1.5 shadow-md shadow-indigo-600/20 transition-all cursor-pointer"
 >
 <Plus className="w-4 h-4" /> {t("Issue New Invoice")}
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
 <div className="flex items-center gap-2">
 <label className="text-[10px] font-bold text-slate-500 uppercase">{t("ZATCA Status:")}</label>
 <select 
 value={filterZatcaStatus}
 onChange={(e) => setFilterZatcaStatus(e.target.value)}
 className="bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs focus:outline-none font-semibold text-slate-700"
 >
 <option value="All">{t("All ZATCA Statuses")}</option>
 <option value="CLEARED_REPORTED">✅ Cleared / Reported</option>
 <option value="PENDING">⏳ Pending</option>
 <option value="REJECTED_ERROR">❌ Rejected / Error</option>
 <option value="NOT_SUBMITTED">⚪ Not Submitted</option>
 </select>
 </div>
 <div className="flex items-center gap-2">
 <label className="text-[10px] font-bold text-slate-500 uppercase">{t("Document Type:")}</label>
 <select
 value={filterDocType}
 onChange={(e) => setFilterDocType(e.target.value as any)}
 className="bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs focus:outline-none font-semibold text-slate-700"
 >
 <option value="All">{t("All Document Types")}</option>
 <option value="Invoice">{t("Invoices Only")}</option>
 <option value="CreditNote">{t("Credit Notes Only")}</option>
 <option value="DebitNote">{t("Debit Notes Only")}</option>
 </select>
 </div>
 <div className="flex items-center gap-2 ms-auto">
 <label className="text-[10px] font-bold text-slate-500 uppercase">{t("Status:")}</label>
 <select 
 value={filterStatus}
 onChange={(e) => setFilterStatus(e.target.value as any)}
 className="bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs focus:outline-none font-semibold text-slate-700"
 >
 <option value="All">{t("All Invoices")}</option>
 <option value="Unpaid">{t("Pending / Unpaid Only")}</option>
 </select>
 </div>
 </div>

 <div className="overflow-x-auto">
 <table className="w-full text-xs text-start">
 <thead>
 <tr className="bg-slate-50/50 border-b border-slate-100 text-slate-500 uppercase tracking-wider text-[10px]">
 {renderSortableHeader(t('Invoice No'), 'invoiceNumber')}
 <th className="p-3 text-center">{t('Type')}</th>
 {renderSortableHeader(t('Date'), 'date')}
 {renderSortableHeader(t('Customer'), 'customer')}
 {renderSortableHeader(t('Post Bank'), 'bank')}
 {renderSortableHeader(t('Grand Total'), 'grandTotal', 'right')}
 {renderSortableHeader(t('Status'), 'status', 'center')}
 {renderSortableHeader(t('Payment'), 'paymentStatus', 'center')}
 {renderSortableHeader(t('ZATCA Status'), 'zatcaStatus', 'center')}
 <th className="p-3 text-end">{t('Actions')}</th>
 </tr>
 </thead>
 <tbody>
 {paginatedInvoices.length === 0 ? (
 <tr>
 <td colSpan={9} className="p-8 text-center text-slate-400">
 {t('No invoices issued for this period. Click "Issue Invoice" or convert from Quotations.')}
 </td>
 </tr>
 ) : (
 paginatedInvoices.map(inv => {
 const cust = db.customers.find(c => c.id === inv.customerId);
 const bank = db.banks.find(b => b.id === inv.bankId);
 const isPending = (inv.paymentStatus === 'Unpaid' || inv.paymentStatus === 'Partially Paid') && inv.status === 'Active';
 const zatcaBlocksCancel = !!inv.zatcaStatus && ['SUBMITTING', 'CLEARED', 'REPORTED'].includes(inv.zatcaStatus);
 const showCancelButton = (isAdmin || userPermissions.cancel.access.enabled) && inv.status === 'Active';
 const canCancel = showCancelButton && !zatcaBlocksCancel;
 const totalAmt = getInvoiceTotal(inv);
 const paidAmt = inv.amountPaid || 0;
 const remainingAmt = Number((totalAmt - paidAmt).toFixed(2));

 return (
 <tr key={inv.id} className="border-b border-slate-100 hover:bg-slate-50/20">
 <td className="p-3 font-bold text-slate-900">
 <div className="flex items-center gap-2">
 {inv.invoiceNumber}
 {inv.attachmentUrl && (
 <button
 onClick={() => setViewAttachment(inv.attachmentUrl)}
 className="p-1.5 bg-slate-100 hover:bg-indigo-100 text-slate-500 hover:text-indigo-600 rounded-lg transition-colors"
 title="View Attachment"
 >
 <Paperclip className="w-3.5 h-3.5" />
 </button>
 )}
 </div>
 {inv.originQuotationId && (() => {
 const originQ = db.quotations.find(q => q.id === inv.originQuotationId);
 if (originQ) {
 return (
 <div className="text-[10px] text-slate-400 font-normal mt-0.5 whitespace-nowrap">
 Ref:{' '}
 <button
 type="button"
 onClick={() => {
 const cust = db.customers.find(c => c.id === originQ.customerId);
 onPrintDoc('Quotation', { ...originQ, customerData: cust });
 }}
 className="text-indigo-600 hover:text-indigo-800 hover:underline font-bold font-mono"
 >
 {originQ.quotationNumber}
 </button>
 </div>
 );
 }
 return null;
 })()}
 </td>
 <td className="p-3 text-center">
 <StatusPill tone={inv.documentType === 'CreditNote' ? 'warn' : inv.documentType === 'DebitNote' ? 'info' : 'neutral'}>
 {inv.documentType === 'CreditNote' ? 'Credit Note' : inv.documentType === 'DebitNote' ? 'Debit Note' : 'Invoice'}
 </StatusPill>
 {inv.originalInvoiceId && (() => {
 const original = db.invoices.find(o => o.id === inv.originalInvoiceId);
 return original ? (
 <div className="text-[9px] text-slate-400 font-mono mt-0.5 whitespace-nowrap">Ref: {original.invoiceNumber}</div>
 ) : null;
 })()}
 </td>
 <td className="p-3 text-slate-600">{inv.date}</td>
 <td className="p-3 font-semibold text-slate-700">{cust?.name || 'Walk-in'}</td>
 <td className="p-3 text-slate-500 font-medium">{bank?.bankName || 'Default'}</td>
 <td className="p-3 text-end font-bold text-slate-900">
 <div>{totalAmt.toFixed(2)} {currencySymbol}</div>
 {inv.paymentStatus === 'Partially Paid' && (
 <div className="text-[9px] font-medium text-slate-400">{t("Paid:")} {paidAmt.toFixed(2)}</div>
 )}
 </td>
 <td className="p-3 text-center">
 <StatusPill tone={inv.status === 'Active' ? 'good' : 'critical'}>{inv.status}</StatusPill>
 </td>
 <td className="p-3 text-center">
 <div className="flex flex-col items-center gap-0.5">
 <StatusPill tone={inv.paymentStatus === 'Paid' ? 'good' : inv.paymentStatus === 'Partially Paid' ? 'info' : 'warn'}>
 {inv.paymentStatus}
 </StatusPill>
 {(inv.paymentStatus === 'Partially Paid' || inv.paymentStatus === 'Unpaid') && (
 <span className="text-[9px] font-mono text-slate-400 font-semibold">
 {t("Paid:")} {paidAmt.toFixed(2)} / {t("Due:")} {remainingAmt.toFixed(2)}
 </span>
 )}
 </div>
 </td>
 <td className="p-3 text-center">
   {(() => {
     const zStatus = inv.zatcaStatus || 'NOT_SUBMITTED';
     const zTone: StatusPillTone =
       zStatus === 'CLEARED' ? 'good' :
       zStatus === 'REPORTED' ? 'info' :
       zStatus === 'PENDING' || zStatus === 'SUBMITTING' ? 'warn' :
       zStatus === 'REJECTED' || zStatus === 'ERROR' ? 'critical' :
       zStatus === 'DISABLED' ? 'warn' :
       'neutral';
     return (
       <button
         onClick={() => setZatcaModalInvoice(inv)}
         className="inline-flex items-center gap-1 cursor-pointer group"
         title={zStatus === 'DISABLED' ? 'ZATCA integration is not enabled for this company yet' : 'View ZATCA Phase 2 Details & QR'}
       >
         <StatusPill tone={zTone}>
           <ShieldCheck className="w-2.5 h-2.5" />
           {zStatus}
         </StatusPill>
       </button>
     );
   })()}
 </td>
 <td className="p-3 text-end space-x-1.5">
 <div className="inline-flex items-center justify-end gap-1.5 flex-wrap">
 <button
   onClick={() => setZatcaModalInvoice(inv)}
   className="p-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-700 transition cursor-pointer inline-flex items-center gap-1 text-[11px] font-bold border border-emerald-200"
   title="ZATCA Phase 2 Details & QR Code"
 >
   <ShieldCheck className="w-3.5 h-3.5" />
   <span>ZATCA</span>
 </button>
 <button
 onClick={() => onPrintDoc('Invoice', { ...inv, customerData: cust, bankData: bank })}
 className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 transition cursor-pointer inline-flex items-center gap-1 text-[11px] font-semibold"
 title="Print / PDF Invoice"
 >
 <Printer className="w-3.5 h-3.5" />
 <span>Print</span>
 </button>

 {isPending && openMonth && (
 <button
 onClick={() => handleInitiatePay(inv)}
 className="p-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white transition cursor-pointer inline-flex items-center gap-1 text-[10px] font-bold shadow-sm"
 title="Receive Payment"
 >
 <CreditCard className="w-3.5 h-3.5" />
 <span>Receive Pay</span>
 </button>
 )}

 {showCancelButton && (
 <button
 onClick={() => {
 if (!canCancel) return;
 if (window.confirm('⚠️ Are you sure you want to CANCEL this sales invoice? This action will void the invoice and post a reversal receipt voucher. It cannot be undone!')) {
 handleCancelInvoice(inv.id);
 }
 }}
 disabled={!canCancel}
 className={`p-1.5 rounded-lg transition inline-flex items-center gap-1 text-[11px] font-bold ${canCancel ? 'bg-rose-50 hover:bg-rose-100 text-rose-700 cursor-pointer' : 'bg-slate-100 text-slate-400 cursor-not-allowed'}`}
 title={canCancel ? 'Cancel Invoice' : 'This invoice has already been submitted to ZATCA and cannot be cancelled. Issue a Credit/Debit Note instead.'}
 >
 <AlertTriangle className="w-3.5 h-3.5" />
 <span>Cancel</span>
 </button>
 )}

 {(!inv.documentType || inv.documentType === 'Invoice') && (
 <button
 onClick={() => { setNoteInvoice(inv); setNoteForm({ type: 'CreditNote', reason: '' }); setNoteError(null); }}
 className="p-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-700 transition cursor-pointer inline-flex items-center gap-1 text-[11px] font-bold"
 title="Create Credit/Debit Note"
 >
 <FileText className="w-3.5 h-3.5" />
 <span>Credit/Debit</span>
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
 {Math.min(currentPage * itemsPerPage, sortedInvoices.length)}
 </span>{' '}
 of <span className="font-bold text-slate-700 ">{sortedInvoices.length}</span> records
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
 <form onSubmit={handleSaveInvoice} className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-4 sm:p-5 space-y-4">
 <div className="flex justify-between items-center bg-slate-50/80 rounded-xl px-3.5 py-2 border border-slate-200/60">
 <div className="flex items-center gap-2.5 flex-wrap">
 <h3 className="font-extrabold text-xs text-slate-800 uppercase tracking-wider">{t('Draft & Issue Sales Invoice')}</h3>
 <span className="text-[9px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded-md uppercase flex items-center gap-1">
 <span>🏢</span> {t('Submitting for:')} <strong className="text-indigo-900">{db.companySetup?.name}</strong>
 </span>
 </div>
 <button
 type="button"
 onClick={onDone}
 className="text-slate-500 hover:text-slate-800 text-xs font-semibold px-2.5 py-1 rounded-lg hover:bg-slate-200/60 transition"
 >
 {t("Back to List")}
 </button>
 </div>

 <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-2.5 text-xs">
 <div className="lg:col-span-2 space-y-0.5">
 <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{t('Invoice Date')}</label>
 <input
 type="date"
 required
 value={formDate}
 onChange={(e) => setFormDate(e.target.value)}
 className="w-full bg-slate-50/70 hover:bg-white border border-slate-200 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 font-medium focus:outline-none transition-all"
 />
 </div>

 <div className="lg:col-span-3 space-y-0.5">
 <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{t('Customer')}</label>
 <select
 required
 value={formCustomerId}
 onChange={(e) => setFormCustomerId(e.target.value)}
 className="w-full bg-slate-50/70 hover:bg-white border border-slate-200 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 font-medium focus:outline-none transition-all"
 >
 {db.customers.filter(c => c.companyId === db.selectedCompanyId || !c.companyId).map(c => (
 <option key={c.id} value={c.id}>{c.name} {c.isSystem ? '(Default)' : ''}</option>
 ))}
 </select>
 </div>

 <div className="lg:col-span-2 space-y-0.5">
 <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{t('VAT Slab')}</label>
 <select
 required
 value={formTaxSlabId}
 onChange={(e) => setFormTaxSlabId(e.target.value)}
 className="w-full bg-slate-50/70 hover:bg-white border border-slate-200 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 font-medium focus:outline-none transition-all"
 >
 {db.taxSlabs.map(t => (
 <option key={t.id} value={t.id}>{t.name}</option>
 ))}
 </select>
 </div>

 {/* Bank configuration is Admin-only editable; staff see read-only bank */}
 <div className="lg:col-span-3 space-y-0.5">
 <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{t("Post Inflow Bank")}</label>
 {isAdmin ? (
 <select
 required
 value={formBankId}
 onChange={(e) => setFormBankId(e.target.value)}
 className="w-full bg-slate-50/70 hover:bg-white border border-slate-200 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 font-medium focus:outline-none transition-all"
 >
 {db.banks.filter(b => b.isActive && b.companyId === db.selectedCompanyId).map(b => (
 <option key={b.id} value={b.id}>{b.bankName} (Default: {b.isDefault ? 'Yes' : 'No'})</option>
 ))}
 </select>
 ) : (
 <div className="w-full bg-slate-100 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-500 font-semibold flex items-center gap-1.5">
 <Lock className="w-3.5 h-3.5 text-slate-400" />
 <span>{db.banks.find(b => b.id === formBankId)?.bankName || 'Default Bank'} (Read-Only)</span>
 </div>
 )}
 </div>

 <div className="lg:col-span-2 space-y-0.5">
 <label className="text-[10px] font-bold text-rose-600 uppercase tracking-wider block">{t("Header Discount %")}</label>
 <input
 type="number"
 min="0"
 max="100"
 placeholder="0"
 value={formDiscountPercentage || ''}
 onChange={(e) => setFormDiscountPercentage(Math.max(0, Math.min(100, parseFloat(e.target.value) || 0)))}
 className="w-full bg-rose-50/40 hover:bg-white border border-rose-200 focus:border-rose-400 focus:ring-1 focus:ring-rose-300 rounded-lg px-2.5 py-1.5 text-xs text-rose-900 font-bold focus:outline-none transition-all"
 />
 </div>

 {/* Row 2 */}
 <div className="lg:col-span-4 space-y-0.5">
 <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{t("Invoice Payment Status")}</label>
 <div className="flex gap-3 px-2 py-1 bg-slate-50/80 rounded-lg border border-slate-200 text-xs">
 <label className="flex items-center gap-1 cursor-pointer text-slate-700 font-semibold text-[11px]">
 <input
 type="radio"
 name="invPayStatus"
 checked={formPaymentStatus === 'Paid'}
 onChange={() => setFormPaymentStatus('Paid')}
 className="text-indigo-600 focus:ring-indigo-500"
 />
 <span>{t("Paid")}</span>
 </label>
 <label className="flex items-center gap-1 cursor-pointer text-slate-600 text-[11px]">
 <input
 type="radio"
 name="invPayStatus"
 checked={formPaymentStatus === 'Unpaid'}
 onChange={() => setFormPaymentStatus('Unpaid')}
 className="text-indigo-600 focus:ring-indigo-500"
 />
 <span>{t("Pending / Credit")}</span>
 </label>
 </div>
 </div>

 <div className="lg:col-span-3 space-y-0.5">
 <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{t("Design File (Attachment)")}</label>
 <input
 type="file"
 accept="image/jpeg, image/gif, image/bmp, image/png"
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
 className="w-full bg-slate-50/70 hover:bg-white border border-slate-200 rounded-lg px-2 py-1 text-[11px] text-slate-700 focus:outline-none"
 />
 {formAttachmentUrl && <p className="text-[10px] text-emerald-600 font-semibold mt-0.5">✓ File attached</p>}
 </div>
 
 <div className="lg:col-span-5 space-y-0.5">
 <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{t("Notes / Memo")}</label>
 <input
 type="text"
 placeholder="Job description, payments, setups"
 value={formNotes}
 onChange={(e) => setFormNotes(e.target.value)}
 className="w-full bg-slate-50/70 hover:bg-white border border-slate-200 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 font-medium focus:outline-none transition-all"
 />
 </div>
 </div>

 {/* Line Items Table */}
 <div className="space-y-2">
 <h4 className="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider flex items-center justify-between">
 <span>{t('Itemised Fabrication Line Items')}</span>
 <span className="text-[10px] text-slate-400 font-normal">{t('Compact Table View')}</span>
 </h4>
 
 <div className="border border-slate-200 rounded-xl bg-white shadow-xs relative">
 <div className="overflow-x-auto overflow-y-visible">
 <table className="w-full text-start text-xs border-collapse min-w-[650px]">
 <thead>
 <tr className="bg-slate-100/90 border-b border-slate-200 text-[10px] font-extrabold text-slate-600 uppercase tracking-wider">
 <th className="py-2.5 px-3 text-start w-10">#</th>
 <th className="py-2.5 px-3 text-start">{t('Item Description / Catalogue Search')}</th>
 <th className="py-2.5 px-3 text-end w-32">{t('Unit Price')} ({currencySymbol})</th>
 <th className="py-2.5 px-3 text-center w-24">{t('Quantity')}</th>
 <th className="py-2.5 px-3 text-end w-28">{t('Discount')} ({currencySymbol})</th>
 <th className="py-2.5 px-3 text-center w-36">{t('Tax Slab')}</th>
 <th className="py-2.5 px-3 text-end w-32">{t('Total')} ({currencySymbol})</th>
 <th className="py-2.5 px-3 text-center w-12"></th>
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100">
 {formItems.map((item, idx) => {
 const lineNetCost = Math.max(0, (item.unitCost || 0) - (item.discountAmount || 0));
 const lineTotal = lineNetCost * (item.quantity || 1);

 return (
 <tr key={idx} className="hover:bg-slate-50/80 transition-colors">
 <td className="py-2 px-3 text-slate-400 font-bold text-[11px] align-top pt-3">{idx + 1}</td>
 <td className="py-2 px-2 align-top">
 <input
 type="text"
 required
 list={`sales-catalog-${idx}`}
 placeholder={t("Type or search item from catalog...")}
 value={item.description}
 onChange={(e) => {
 const val = e.target.value;
 handleUpdateLineItem(idx, 'description', val);
 const matched = salesProducts.find(p => p.name.toLowerCase() === val.trim().toLowerCase());
 if (matched) {
 handleUpdateLineItem(idx, 'unitCost', matched.unitPrice || 0);
 }
 }}
 className="w-full bg-slate-50/50 hover:bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500 font-medium"
 />
 <datalist id={`sales-catalog-${idx}`}>
 {salesProducts.map(p => (
 <option key={p.id} value={p.name}>
 {`${Number(p.unitPrice || 0).toFixed(2)} ${currencySymbol} ${p.description ? '— ' + p.description : ''}`}
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

 <td className="py-2 px-2 align-top">
 <input
 type="number"
 min="0"
 placeholder="0.00"
 value={item.discountAmount || ''}
 onChange={(e) => handleUpdateLineItem(idx, 'discountAmount', parseFloat(e.target.value) || 0)}
 className="w-full text-end bg-rose-50/30 hover:bg-rose-50/80 border border-rose-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 focus:bg-white focus:outline-none focus:ring-1 focus:ring-rose-400 font-semibold"
 />
 </td>

 <td className="py-2 px-2 align-top">
 <select
 value={item.taxSlabId || formTaxSlabId}
 onChange={(e) => handleUpdateLineItem(idx, 'taxSlabId', e.target.value)}
 className="w-full bg-slate-50/50 hover:bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-[11px] text-slate-800 focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500 font-semibold"
 >
 {db.taxSlabs.map(slab => (
 <option key={slab.id} value={slab.id}>
 {slab.name} ({slab.percentage}%)
 </option>
 ))}
 </select>
 </td>

 <td className="py-2 px-3 text-end font-bold text-slate-900 text-xs align-top pt-3">
 {lineTotal.toFixed(2)}
 </td>

 <td className="py-2 px-2 text-center align-top pt-2">
 <button
 type="button"
 disabled={formItems.length === 1}
 onClick={() => handleRemoveLineItem(idx)}
 className="p-1 hover:bg-rose-100 text-slate-400 hover:text-rose-600 disabled:opacity-20 rounded-md transition-all cursor-pointer"
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
 </div>

 {/* Form Totals */}
 <div className="flex justify-end pt-4 border-t border-slate-100">
 <div className="w-80 bg-slate-50 p-4 rounded-xl border border-slate-100 space-y-1.5 text-xs">
 <div className="flex justify-between text-slate-500">
 <span>Items Gross Subtotal:</span>
 <span className="font-semibold text-slate-800">
 {calculateInvoiceTotals(db, formItems, formTaxSlabId, formDiscountPercentage).grossSubtotal.toFixed(2)} {currencySymbol}
 </span>
 </div>
 
 {(() => {
   const calc = calculateInvoiceTotals(db, formItems, formTaxSlabId, formDiscountPercentage);
   return (
     <>
       {calc.totalLineDiscount > 0 && (
         <div className="flex justify-between text-rose-600 font-semibold">
           <span>Line Item Discounts:</span>
           <span>-{calc.totalLineDiscount.toFixed(2)} {currencySymbol}</span>
         </div>
       )}

       {calc.totalLineDiscount > 0 && (
         <div className="flex justify-between text-slate-600 font-medium border-t border-slate-100/80 pt-1">
           <span>Net Subtotal:</span>
           <span className="font-semibold text-slate-800">{calc.subtotal.toFixed(2)} {currencySymbol}</span>
         </div>
       )}

       {formDiscountPercentage > 0 && (
         <div className="flex justify-between text-rose-600 font-semibold">
           <span>Header Discount ({formDiscountPercentage}%):</span>
           <span>-{calc.discountAmount.toFixed(2)} {currencySymbol}</span>
         </div>
       )}

       {calc.totalDiscount > 0 && (
         <div className="flex justify-between text-slate-700 font-bold border-t border-slate-100 pt-1">
           <span>Total Discount Applied:</span>
           <span className="text-rose-600">-{calc.totalDiscount.toFixed(2)} {currencySymbol}</span>
         </div>
       )}
     </>
   );
 })()}

 <div className="flex justify-between text-slate-500">
 <span>VAT Slab ({calculateInvoiceTotals(db, formItems, formTaxSlabId, formDiscountPercentage).percentage}%):</span>
 <span>
 {calculateInvoiceTotals(db, formItems, formTaxSlabId, formDiscountPercentage).taxAmount.toFixed(2)} {currencySymbol}
 </span>
 </div>

 <div className="flex justify-between font-bold text-sm text-slate-900 border-t border-slate-200 pt-2 mt-1">
 <span>{t("Grand Total")}:</span>
 <span className="text-indigo-600 text-base">
 {calculateInvoiceTotals(db, formItems, formTaxSlabId, formDiscountPercentage).grandTotal.toFixed(2)} {currencySymbol}
 </span>
 </div>
 </div>
 </div>

 <div className="flex justify-end gap-3 pt-2">
 <button
 type="button"
 onClick={onDone}
 disabled={isSavingInvoice}
 className="px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl font-semibold text-xs disabled:opacity-50"
 >
 Cancel
 </button>
 <button
 type="submit"
 disabled={isSavingInvoice}
 className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl px-5 py-2 font-bold text-xs shadow-sm disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
 >
 <RefreshCw className={`w-3.5 h-3.5 ${isSavingInvoice ? 'animate-spin' : 'hidden'}`} />
 {isSavingInvoice ? 'Saving...' : 'Confirm & Issue Invoice'}
 </button>
 </div>
 </form>
 )}

 {/* Subsequent payment modal */}
 {payingInvoice && (
 <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex justify-center items-center p-4 overflow-y-auto">
 <div className="bg-white rounded-2xl border border-slate-100 shadow-2xl p-6 w-full max-w-sm my-auto animate-in fade-in zoom-in-95 duration-100 text-xs text-slate-600">
 <h3 className="font-bold text-sm text-slate-900 mb-1 flex items-center gap-1">
 <CheckSquare className="w-5 h-5 text-emerald-600" />
 {t('Receive Invoice Payment')}
 </h3>
 <p className="mb-4">Recording subsequent payment settlement for invoice {payingInvoice.invoiceNumber}.</p>

 <form onSubmit={handleConfirmPay} className="space-y-4">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Payment Receipt Date</label>
 <input
 type="date"
 required
 value={payForm.date}
 onChange={(e) => setPayForm({ ...payForm, date: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t("Post Inflow Bank")}</label>
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
 <label className="text-[10px] font-bold text-slate-400 uppercase">Amount Received ({currencySymbol})</label>
 <div className="relative">
 <input
 type="number"
 step="0.01"
 required
 max={Number((getInvoiceTotal(payingInvoice) - (payingInvoice.amountPaid || 0)).toFixed(2))}
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
 <span>Already {t("Paid:")} {(payingInvoice.amountPaid || 0).toFixed(2)} {currencySymbol}</span>
 <span>Remaining: {(getInvoiceTotal(payingInvoice) - (payingInvoice.amountPaid || 0)).toFixed(2)} {currencySymbol}</span>
 </div>
 </div>

 <div className="flex justify-end gap-2.5 pt-2">
 <button
 type="button"
 onClick={() => setPayingInvoice(null)}
 className="px-3 py-1.5 bg-slate-100 text-slate-500 rounded-lg font-semibold hover:bg-slate-200"
 >
 Cancel
 </button>
 <button
 type="submit"
 className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg shadow-sm"
 >
 Receive Cash Out
 </button>
 </div>
 </form>
 </div>
 </div>
 )}

 {/* CREDIT/DEBIT NOTE MODAL */}
 {noteInvoice && (
 <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex justify-center items-center p-4 overflow-y-auto">
 <div className="bg-white rounded-2xl border border-slate-100 shadow-2xl p-6 w-full max-w-sm my-auto animate-in fade-in zoom-in-95 duration-100 text-xs text-slate-600">
 <h3 className="font-bold text-sm text-slate-900 mb-1 flex items-center gap-1">
 <FileText className="w-5 h-5 text-amber-600" />
 {t('Create Credit/Debit Note')}
 </h3>
 <p className="mb-4">Full-document reversal referencing invoice {noteInvoice.invoiceNumber}. This creates a new, separately-signed ZATCA document — the original invoice is not modified.</p>

 {noteError && (
 <div className="bg-rose-50 text-rose-700 p-2.5 px-3 mb-4 text-xs font-semibold rounded-xl border border-rose-100 flex items-start gap-2">
 <AlertTriangle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
 <span>{noteError}</span>
 </div>
 )}

 <form onSubmit={handleCreateNote} className="space-y-4">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Note Type</label>
 {/* Debit Note temporarily disabled per product decision — only Credit Note can be
     created right now. noteForm.type stays fixed at its 'CreditNote' default. */}
 <div className="w-full py-1.5 rounded-xl font-bold text-xs border bg-amber-600 text-white border-amber-600 text-center">
 Credit Note
 </div>
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">Reason</label>
 <textarea
 value={noteForm.reason}
 onChange={(e) => setNoteForm({ ...noteForm, reason: e.target.value })}
 placeholder={noteForm.type === 'CreditNote' ? 'e.g. Goods returned by customer' : 'e.g. Additional charges agreed after original invoice'}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800"
 rows={2}
 />
 </div>

 <div className="flex justify-end gap-2.5 pt-2">
 <button
 type="button"
 onClick={() => setNoteInvoice(null)}
 disabled={isSavingNote}
 className="px-3 py-1.5 bg-slate-100 text-slate-500 rounded-lg font-semibold hover:bg-slate-200 disabled:opacity-50"
 >
 Cancel
 </button>
 <button
 type="submit"
 disabled={isSavingNote}
 className="px-4 py-1.5 bg-amber-600 hover:bg-amber-700 text-white font-bold rounded-lg shadow-sm disabled:opacity-60"
 >
 {isSavingNote ? 'Saving...' : `Create ${noteForm.type === 'CreditNote' ? 'Credit' : 'Debit'} Note`}
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
 <img src={viewAttachment} alt="Attachment" className="max-w-full max-h-[70vh] rounded-xl shadow-sm object-contain" />
 </div>
 </div>
 </div>
 )}

 {/* ZATCA PHASE 2 DETAILS MODAL */}
 {zatcaModalInvoice && (
   <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm overflow-y-auto">
     <div className="bg-white rounded-[24px] shadow-2xl w-full max-w-3xl overflow-hidden my-auto animate-in fade-in zoom-in duration-200">
       <div className="flex justify-between items-center p-4 border-b border-slate-100 bg-slate-900 text-white">
         <div className="flex items-center gap-2.5">
           <ShieldCheck className="w-5 h-5 text-emerald-400" />
           <div>
             <h3 className="font-bold text-sm">ZATCA Phase 2 E-Invoice Clearance</h3>
             <p className="text-[10px] text-slate-400 font-mono">Invoice: {zatcaModalInvoice.invoiceNumber}</p>
           </div>
         </div>
         <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const cust = db.customers.find(c => c.id === zatcaModalInvoice.customerId);
                const bank = db.banks.find(b => b.id === zatcaModalInvoice.bankId);
                onPrintDoc('Invoice', { ...zatcaModalInvoice, customerData: cust, bankData: bank });
              }}
              className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold rounded-lg text-xs flex items-center gap-1.5 shadow-xs transition-all cursor-pointer"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>Print Invoice</span>
            </button>
            <button onClick={() => setZatcaModalInvoice(null)} className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
       </div>

       <div className="p-6 space-y-5 max-h-[80vh] overflow-y-auto text-xs">
         {/* Status Bar */}
         <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-xl bg-slate-50 border border-slate-200">
           <div>
             <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">ZATCA Clearance Status</div>
             <div className="mt-1 flex items-center gap-2">
               <StatusPill tone={
                 zatcaModalInvoice.zatcaStatus === 'CLEARED' ? 'good' :
                 zatcaModalInvoice.zatcaStatus === 'REPORTED' ? 'info' :
                 zatcaModalInvoice.zatcaStatus === 'PENDING' || zatcaModalInvoice.zatcaStatus === 'SUBMITTING' ? 'warn' :
                 zatcaModalInvoice.zatcaStatus === 'REJECTED' || zatcaModalInvoice.zatcaStatus === 'ERROR' ? 'critical' :
                 zatcaModalInvoice.zatcaStatus === 'DISABLED' ? 'warn' :
                 'neutral'
               } className="!text-xs !px-2.5 !py-1">
                 {zatcaModalInvoice.zatcaStatus || 'NOT_SUBMITTED'}
               </StatusPill>
               {zatcaModalInvoice.clearanceTimestamp && (
                 <span className="text-[10px] text-slate-500">
                   Timestamp: {new Date(zatcaModalInvoice.clearanceTimestamp).toLocaleString()}
                 </span>
               )}
             </div>
             {zatcaModalInvoice.zatcaStatus === 'DISABLED' && (
               <p className="text-[10px] text-slate-500 mt-1.5 max-w-xs">
                 ZATCA integration is not enabled for this company yet. Ask a Super Admin to enable it in Admin Settings, or complete Sandbox onboarding to enable it automatically.
               </p>
             )}
           </div>

           <button
             onClick={() => handleManualZatcaSubmit(zatcaModalInvoice.id)}
             disabled={isSubmittingZatca || zatcaModalInvoice.zatcaStatus === 'DISABLED'}
             title={zatcaModalInvoice.zatcaStatus === 'DISABLED' ? 'ZATCA integration is not enabled for this company yet' : undefined}
             className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-extrabold rounded-xl text-xs flex items-center gap-1.5 shadow-sm transition-all cursor-pointer"
           >
             <RefreshCw className={`w-3.5 h-3.5 ${isSubmittingZatca ? 'animate-spin' : ''}`} />
             {isSubmittingZatca ? 'Submitting to ZATCA...' : zatcaModalInvoice.zatcaStatus === 'DISABLED' ? 'ZATCA Not Enabled' : 'Submit / Re-submit to ZATCA'}
           </button>
         </div>

         {/* Cryptographic Details & QR */}
         <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
           <div className="md:col-span-2 space-y-2 bg-slate-50 p-3.5 rounded-xl border border-slate-200">
             <div className="font-bold text-slate-800 flex items-center gap-1.5 text-xs">
               <FileCode className="w-4 h-4 text-indigo-600" />
               Hash Chain & Cryptographic Identifier
             </div>
             <div className="space-y-1.5 font-mono text-[11px] break-all">
               <div>
                 <span className="text-slate-500 font-sans text-[10px] uppercase font-bold block">Invoice UUID:</span>
                 <span className="text-slate-800 font-semibold">{zatcaModalInvoice.uuid || 'N/A'}</span>
               </div>
               <div>
                 <span className="text-slate-500 font-sans text-[10px] uppercase font-bold block">Invoice Counter (ICV):</span>
                 <span className="text-indigo-600 font-bold">{zatcaModalInvoice.icv ?? 'N/A'}</span>
               </div>
               <div>
                 <span className="text-slate-500 font-sans text-[10px] uppercase font-bold block">Current Invoice Hash (SHA-256):</span>
                 <span className="text-slate-700">{zatcaModalInvoice.currentInvoiceHash || 'N/A'}</span>
               </div>
               <div>
                 <span className="text-slate-500 font-sans text-[10px] uppercase font-bold block">Previous Invoice Hash (PIH):</span>
                 <span className="text-slate-700">{zatcaModalInvoice.previousInvoiceHash || 'N/A'}</span>
               </div>
             </div>
           </div>

           <div className="flex flex-col items-center justify-center p-3.5 bg-slate-50 rounded-xl border border-slate-200 text-center">
             <div className="font-bold text-slate-800 mb-2 flex items-center gap-1 text-xs">
               <QrCode className="w-4 h-4 text-emerald-600" />
               ZATCA Phase 2 QR Code
             </div>
             {zatcaModalInvoice.qrCodeContent ? (
               <img
                 src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(zatcaModalInvoice.qrCodeContent)}`}
                 alt="ZATCA Phase 2 QR Code"
                 className="w-32 h-32 rounded border border-slate-200 bg-white p-1"
               />
             ) : (
               <div className="w-32 h-32 rounded bg-slate-100 flex items-center justify-center text-slate-400 text-[10px] p-2">
                 No QR Code Generated Yet
               </div>
             )}
           </div>
         </div>

         {/* Validation Warnings / Errors */}
         {zatcaModalInvoice.zatcaValidationResults && (zatcaModalInvoice.zatcaValidationResults as any[]).length > 0 && (
           <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 space-y-1.5">
             <div className="font-bold text-amber-900 flex items-center gap-1.5">
               <AlertTriangle className="w-4 h-4 text-amber-600" />
               ZATCA Gateway Validation Diagnostics
             </div>
             <ul className="list-disc list-inside space-y-1 text-amber-800 text-[11px] font-mono">
               {(zatcaModalInvoice.zatcaValidationResults as any[]).map((res: any, idx: number) => (
                 <li key={idx}>
                   [{res.type || res.code || 'INFO'}]: {res.message || JSON.stringify(res)}
                 </li>
               ))}
             </ul>
           </div>
         )}

         {/* Signed XML Preview */}
         {zatcaModalInvoice.xmlContent && (
           <div className="space-y-1.5">
             <div className="flex items-center justify-between">
               <span className="font-bold text-slate-800 text-xs">Signed UBL 2.1 XML Content</span>
               <button
                 onClick={() => {
                   const blob = new Blob([zatcaModalInvoice.xmlContent || ''], { type: 'text/xml' });
                   const url = URL.createObjectURL(blob);
                   const a = document.createElement('a');
                   a.href = url;
                   a.download = `ZATCA-UBL-${zatcaModalInvoice.invoiceNumber}.xml`;
                   a.click();
                 }}
                 className="text-[10px] text-indigo-600 font-bold hover:underline cursor-pointer"
               >
                 Download XML File
               </button>
             </div>
             <pre className="p-3 bg-slate-900 text-emerald-400 font-mono text-[10px] rounded-xl overflow-x-auto max-h-48 border border-slate-800">
               {zatcaModalInvoice.xmlContent}
             </pre>
           </div>
         )}
       </div>
     </div>
   </div>
 )}
 </div>
 );
}
