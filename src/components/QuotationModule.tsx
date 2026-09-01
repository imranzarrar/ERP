import React from 'react';
import { useTranslation } from '../hooks';
import { DatabaseState, saveDatabase, getActiveOpenMonth, isDateInOpenMonth, getDefaultTaxSlabId, calculateInvoiceTotals } from '../dbStore';
import { generateId } from '../id';
import { Quotation, QuotationItem, Customer, TaxSlab, User, normalizePermissions } from '../types';
import StatusPill from './StatusPill';
import ItemCatalogSearch from './ItemCatalogSearch';
import {
  FileText,
  Plus,
  Trash,
  Check,
  Printer,
  ChevronRight,
  AlertTriangle,
  ArrowRight,
  User as UserIcon,
  Search,
  CheckSquare,
  Edit3,
  ChevronUp,
  ChevronDown,
  Sparkles,
  TrendingUp,
  CheckCircle2,
  Clock,
  Receipt,
  Copy,
  Send
} from 'lucide-react';

interface QuotationModuleProps {
 db: DatabaseState;
 // Local-only React state update — no /api/migrate POST. Use this after a change was
 // already persisted via its own dedicated /api/transactions/... route, for a patch that
 // only needs to touch specific known fields (never a raw GET /api/state response — see
 // onRefreshDb below for why). Deliberately a function-updater only, not a raw
 // DatabaseState — see App.tsx's handleUpdateDbLocal comment for the incident this
 // prevents at compile time.
 onUpdateDbLocal: (updater: (prev: DatabaseState) => DatabaseState) => void;
 // Real GET /api/state refetch (App.tsx's triggerDbRefresh), merged the same way the
 // initial page load is — see InvoiceModule.tsx's identical prop for the full incident
 // this fixes (handing a raw /api/state response straight to onUpdateDbLocal silently
 // dropped selectedCompanyId/companySetup/currentUser and reset the active company).
 onRefreshDb?: () => Promise<void>;
 onPrintDoc: (type: 'Quotation' | 'Invoice' | 'Expense', data: any) => void;
 // 'list' renders the Quotation Book table; 'add' renders the create/edit form —
 // each is mounted under its own nav tab/permission (quotations vs quotations-add).
 mode: 'list' | 'add';
 editId?: string;
 onDone: () => void;
 onEdit: (id: string) => void;
 onCreateNew: () => void;
 // Called after a quotation is successfully converted into an invoice — navigates
 // to the Invoices List, mirroring the direct invoice-creation flow.
 onConverted: () => void;
}

export default function QuotationModule({ db, onUpdateDbLocal, onRefreshDb, onPrintDoc, mode, editId, onDone, onEdit, onCreateNew, onConverted }: QuotationModuleProps) {
 const { t, isRTL, lang } = useTranslation(db);
 const currentUser = db.currentUser;
 // The branch an admin configured as this user's primary in Staff Permissions
 // (userBranches.isPrimary) — auto-selected on a fresh form below rather than left on
 // the generic "Default (your primary branch)" placeholder, so a multi-branch user gets
 // visual confirmation of which branch they're actually about to file under. Empty for a
 // user with no branch assignment at all (viewAllBranches/company-wide), who has no
 // single default to pre-select — the placeholder stays correct for them.
 const myPrimaryBranchId = (db.userBranches || []).find(ub => ub.userId === currentUser?.id && ub.isPrimary)?.branchId || '';
 const isAdmin = currentUser?.role === 'admin' || currentUser?.isSuperAdmin === true;
 const userPermissions = normalizePermissions(currentUser?.permissions, currentUser?.role, currentUser?.isSuperAdmin);
 const openMonth = getActiveOpenMonth(db, db.selectedCompanyId);
 const currencySymbol = db.companySetup?.currency || 'SAR';

 // Sorting state (default: createdAt descending, so newly added is on top!)
 const [sortField, setSortField] = React.useState<string>('createdAt');
 const [sortOrder, setSortOrder] = React.useState<'asc' | 'desc'>('desc');

 // Quotations render straight from the shared `db.quotations` (populated by
 // `/api/state`, refreshed via `onRefreshDb`) — this module used to keep its own
 // separately-fetched copy here, which meant a quotation created/updated elsewhere
 // (another session, or this app's own "Reload View") never appeared in this list
 // without a hard page reload, since nothing ever re-ran that separate fetch.

 // Pagination state
 const [currentPage, setCurrentPage] = React.useState(1);
 const itemsPerPage = 20;

 // List quotations - filter for admin/staff with module permission to see all records for the company
 const filteredQuotations = db.quotations.filter(q => {
 const qCompanyId = q.companyId;
 if (qCompanyId !== db.selectedCompanyId) return false;
 if (userPermissions.quotation.read.enabled) return true;
 return q.createdById === currentUser.id;
 });

 // Reset page when length changes
 React.useEffect(() => {
 setCurrentPage(1);
 }, [filteredQuotations.length]);

 // Notifications
 const [success, setSuccess] = React.useState<string | null>(null);
 const [error, setError] = React.useState<string | null>(null);

 const triggerSuccess = (msg: string) => {
 setSuccess(msg);
 setTimeout(() => setSuccess(null), 3500);
 };

 // Populate default create-form values on the dedicated Add page (fresh quotation only —
 // edit prefill is handled separately below once the target record has loaded).
 React.useEffect(() => {
 if (mode !== 'add' || editId) return;
 const today = new Date().toISOString().split('T')[0];
 // Default to today only if today's own month is among the open ones (with several months
 // open concurrently, today's month need not be the oldest); otherwise fall back to the
 // 1st of the oldest open month.
 const initialDate = openMonth ? (isDateInOpenMonth(db, today) ? today : `${openMonth.id}-01`) : today;
 const defaultCust = db.customers.find(c => c.isSystem && (c.companyId === db.selectedCompanyId || !c.companyId))?.id || db.customers.find(c => c.companyId === db.selectedCompanyId || !c.companyId)?.id || '';
 const defaultTax = getDefaultTaxSlabId(db);
 setFormDate(initialDate);
 setFormCustomerId(defaultCust);
 setFormTaxSlabId(defaultTax);
 setFormBranchId(myPrimaryBranchId);
 }, [mode, editId, db.selectedCompanyId, openMonth?.id, myPrimaryBranchId]);

 // Prefill the form once the record to edit has loaded from the server.
 React.useEffect(() => {
 if (mode !== 'add' || !editId) return;
 const q = db.quotations.find(q => q.id === editId);
 if (!q) return;
 setEditingQuotationId(q.id);
 setFormDate(q.date);
 setFormCustomerId(q.customerId);
 setFormTaxSlabId(q.taxSlabId);
 setFormBranchId(q.branchId || '');
 setFormNotes(q.notes);
 setFormDiscountPercentage(q.discountPercentage || 0);
 setFormItems(q.items.map(item => ({
 description: item.description,
 unitCost: item.unitCost,
 quantity: item.quantity,
 discountAmount: item.discountAmount || 0
 })));
 }, [mode, editId, db.quotations]);

 React.useEffect(() => {
 setConvertingQ(null);
 }, [db.selectedCompanyId]);

 const triggerError = (msg: string) => {
 setError(msg);
 setTimeout(() => setError(null), 4500);
 };

 // View state — fixed for the lifetime of this mount by which page (mode) rendered it.
 const [view] = React.useState<'list' | 'create' | 'edit'>(mode === 'add' ? (editId ? 'edit' : 'create') : 'list');
 const [editingQuotationId, setEditingQuotationId] = React.useState<string | null>(null);

 // Form states
 const [formDate, setFormDate] = React.useState('');
 const [formCustomerId, setFormCustomerId] = React.useState('');
 const [formTaxSlabId, setFormTaxSlabId] = React.useState('');
 // Empty string means "let the server resolve it" (the creating user's primary branch,
 // or null if branches aren't in use for this company at all) — only meaningfully
 // choosable here for a user assigned to more than one branch, or one with
 // branches.viewAllBranches (who has no single default to fall back to server-side).
 const [formBranchId, setFormBranchId] = React.useState('');
 const companyBranches = (db.branches || []).filter(b => b.companyId === db.selectedCompanyId && b.isActive !== false);
 const [formNotes, setFormNotes] = React.useState('');
 const [formDiscountPercentage, setFormDiscountPercentage] = React.useState<number>(0);
 const [formItems, setFormItems] = React.useState<Omit<QuotationItem, 'id'>[]>([
 { description: '', unitCost: 0, quantity: 1, discountAmount: 0 }
 ]);

 // Autocomplete support
 const [activeAutocompleteIdx, setActiveAutocompleteIdx] = React.useState<number | null>(null);
 const [autocompleteFilter, setAutocompleteFilter] = React.useState('');

 // Conversion prompt states
 const [convertingQ, setConvertingQ] = React.useState<Quotation | null>(null);
 const [convForm, setConvForm] = React.useState({
 date: openMonth ? `${openMonth.id}-01` : '',
 bankId: '',
 paymentStatus: 'Paid' as 'Paid' | 'Partially Paid' | 'Unpaid',
 customerId: '',
 taxSlabId: '',
 notes: '',
 discountPercentage: 0,
 items: [] as Array<{
 id: string;
 description: string;
 unitCost: number;
 quantity: number;
 discountAmount?: number;
 }>
 });

 // See InvoiceModule.tsx's matching salesProducts memo for the full reasoning — one row
 // per sellable product plus one extra row per active packaging/alternate unit.
 const salesProducts = React.useMemo(() => {
   const baseProducts = (db.products || []).filter(p => {
     const isCompMatch = !p.companyId || p.companyId === db.selectedCompanyId;
     const pType = (p.type || '').toLowerCase();
     return isCompMatch && pType !== 'purchase';
   });
   const rows: (typeof baseProducts[number] & { unitOfMeasureId?: string | null; conversionFactor?: number })[] = [...baseProducts];
   for (const puc of (db.productUnitConversions || [])) {
     if (puc.isActive === false) continue;
     const product = baseProducts.find(p => p.id === puc.productId);
     if (!product) continue;
     const uom = (db.unitsOfMeasure || []).find(u => u.id === puc.unitOfMeasureId);
     rows.push({
       ...product,
       name: `${product.name} (${uom ? uom.name : t('Packaging Unit')})`,
       unitPrice: puc.salePrice ?? product.unitPrice,
       unit: uom ? uom.code : product.unit,
       barcode: puc.barcode || undefined,
       sku: puc.sku || undefined,
       unitOfMeasureId: puc.unitOfMeasureId,
       conversionFactor: puc.conversionFactor,
     });
   }
   return rows;
 }, [db.products, db.productUnitConversions, db.unitsOfMeasure, db.selectedCompanyId, t]);

 // Navigate to the dedicated Add page for creation
 const handleInitiateCreate = () => {
 if (!openMonth) return triggerError('Please open a fiscal month first.');
 onCreateNew();
 };

 // Navigate to the dedicated Add page in edit mode for this quotation
 const handleInitiateEdit = (q: Quotation) => {
 if (q.status === 'Converted') return triggerError('Converted quotations cannot be modified.');
 onEdit(q.id);
 };

 // Add line item to form
 const handleAddLineItem = () => {
 setFormItems([...formItems, { description: '', unitCost: 0, quantity: 1, discountAmount: 0, unit: 'PCE' }]);
 };

 // Remove line item
 const handleRemoveLineItem = (idx: number) => {
 if (formItems.length === 1) return;
 setFormItems(formItems.filter((_, i) => i !== idx));
 };

 // Update line item property
 const handleUpdateLineItem = (idx: number, field: keyof Omit<QuotationItem, 'id'>, val: any) => {
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

 // Save Quotation
  // Save Quotation
  const handleSaveQuotation = async (e: React.FormEvent) => {
    e.preventDefault();
    const canSave = editingQuotationId ? userPermissions.quotation.update.enabled : userPermissions.quotation.create.enabled;
    if (!canSave) {
      return triggerError("You do not have permission to manage quotations.");
    }

    const validItems = formItems.filter(item => item.description && item.description.trim() !== "");
    if (validItems.length === 0) {
      return triggerError("Please add at least one line item with a description.");
    }

    const cleanItems: QuotationItem[] = validItems.map(item => ({
      id: generateId(),
      description: item.description.trim(),
      unitCost: parseFloat(item.unitCost as any) || 0,
      quantity: parseFloat(item.quantity as any) || 1,
      discountAmount: parseFloat(item.discountAmount as any) || 0,
      taxSlabId: item.taxSlabId,
      unit: item.unit,
      // Pre-existing gap fixed alongside the packaging-units feature: this was never
      // carried through from the line's own state (set by ItemCatalogSearch via
      // handleSelectProduct) to the request payload, so a catalog-linked quotation line
      // silently lost its product link before it was ever persisted — meaning a
      // quotation-converted invoice's items always arrived with no productId, so neither
      // stock deduction nor the averageSalePrice fold ever ran for that path.
      productId: item.productId || undefined,
      unitOfMeasureId: item.unitOfMeasureId || undefined,
    }));

    const qData = {
      id: editingQuotationId,
      createdById: currentUser.id,
      date: formDate,
      customerId: formCustomerId || db.customers.find(c => c.isSystem)!.id,
      taxSlabId: formTaxSlabId,
      notes: formNotes,
      status: (view === "edit" && editingQuotationId) ? db.quotations.find(q => q.id === editingQuotationId)!.status : "Draft" as const,
      items: cleanItems,
      discountPercentage: formDiscountPercentage,
      companyId: db.selectedCompanyId,
      branchId: formBranchId || undefined,
    };

    try {
      const targetComp = db.selectedCompanyId;
      const response = await fetch(`/api/transactions/quotations?companyId=${targetComp}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quotationData: qData })
      });
      
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || "Failed to save quotation");
      }
      
      triggerSuccess("Quotation saved successfully.");
      if (onRefreshDb) await onRefreshDb();
      onDone();
    } catch (err: any) {
      triggerError(err.message);
    }
  };

 const handleStatusChange = async (qId: string, newStatus: Quotation['status']) => {
  try {
    const targetComp = db.selectedCompanyId;
    const q = db.quotations.find(x => x.id === qId);
    if (!q) return;

    const response = await fetch(`/api/transactions/quotations/${qId}?companyId=${targetComp}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quotationData: {
          ...q,
          status: newStatus
        }
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || "Failed to update quotation status on server");
    }

    // The PUT above already persisted the status change — patch local state to match
    // instead of re-deriving it via dbStore's updateQuotation() and re-syncing the
    // whole blob.
    triggerSuccess(`Quotation status updated to: ${newStatus}`);
    onUpdateDbLocal(prev => ({
      ...prev,
      quotations: prev.quotations.map(item => item.id === qId ? { ...item, status: newStatus } : item)
    }));
    if (onRefreshDb) await onRefreshDb();
  } catch (err: any) {
    triggerError(err.message || 'Failed to update quotation status');
  }
 };

 // Cancel quotation — dedicated route that sets the isCancelled flag (server-side
 // blocked for Converted or already-cancelled quotations), replacing the old
 // handleStatusChange(qId, 'Cancelled') generic-PUT approach.
 const handleCancelQuotation = async (qId: string) => {
  try {
    const targetComp = db.selectedCompanyId;
    const response = await fetch(`/api/transactions/quotations/${qId}/cancel?companyId=${targetComp}`, {
      method: 'POST',
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to cancel quotation');
    }

    triggerSuccess('Quotation cancelled successfully.');
    onUpdateDbLocal(prev => ({
      ...prev,
      quotations: prev.quotations.map(item => item.id === qId ? { ...item, isCancelled: true } : item)
    }));
    if (onRefreshDb) await onRefreshDb();
  } catch (err: any) {
    triggerError(err.message || 'Failed to cancel quotation');
  }
 };

 // Initiate Conversion
 const handleInitiateConversion = (q: Quotation) => {
 if (!openMonth) return triggerError('Please open a fiscal month first.');
 setConvertingQ(q);
 
 const today = new Date().toISOString().split('T')[0];
 const initialDate = isDateInOpenMonth(db, today) ? today : `${openMonth.id}-01`;
 const defaultBank = db.banks.find(b => b.isDefault)?.id || db.banks[0]?.id || '';

 setConvForm({
 date: initialDate,
 bankId: defaultBank,
 paymentStatus: 'Paid',
 customerId: q.customerId,
 taxSlabId: q.taxSlabId,
 notes: `Converted from accepted quotation ${q.quotationNumber}. ${q.notes}`,
 discountPercentage: q.discountPercentage || 0,
 items: q.items.map(item => ({
 id: generateId(),
 description: item.description,
 unitCost: item.unitCost,
 quantity: item.quantity,
 discountAmount: item.discountAmount || 0
 }))
 });
 };

 const handleConvert = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!convertingQ) return;
 if (!userPermissions.invoice.create.enabled) {
 return triggerError('You do not have permission to issue sales invoices.');
 }

 // Validate custom items
 if (convForm.items.length === 0) {
 return triggerError('At least one item line is required for the invoice.');
 }
 for (const item of convForm.items) {
 if (!item.description.trim()) {
 return triggerError('Item description is required.');
 }
 if (isNaN(item.unitCost) || item.unitCost < 0) {
 return triggerError('Item unit cost must be a positive number.');
 }
 }

  try {
    const targetComp = db.selectedCompanyId;
    const response = await fetch(`/api/transactions/quotations/${convertingQ.id}/convert?companyId=${targetComp}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        invoiceDate: convForm.date,
        bankId: convForm.bankId,
        paymentStatus: convForm.paymentStatus,
        customItems: convForm.items,
        customDiscountPercentage: convForm.discountPercentage,
        customTaxSlabId: convForm.taxSlabId,
        customCustomerId: convForm.customerId,
        customNotes: convForm.notes,
        createdById: currentUser.id
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to convert quotation on server');
    }

    // The convert route above already persisted the new invoice + quotation status
    // server-side but only echoes { success: true } — it doesn't hand back the created
    // invoice's id, so a scoped refetch (not a redundant dbStore recompute+sync) is the
    // only way to learn it. Applied via the local-only setter — this is a read, not a
    // write, so there's nothing to re-POST to /api/migrate.
    const refreshed = await fetch('/api/state').then(x => x.json()).catch(() => null);
    if (!refreshed) {
      throw new Error('Quotation converted, but the workspace could not be refreshed. Please reload the page.');
    }
    if (onRefreshDb) await onRefreshDb();

    const newInvoice = refreshed.invoices?.find((i: any) => i.originQuotationId === convertingQ.id);

    triggerSuccess(`Successfully converted ${convertingQ.quotationNumber} into a sales invoice.`);

    if (newInvoice?.id) {
      const invId = newInvoice.id;
      const invNumber = newInvoice.invoiceNumber;
      // Same finalized flow as a direct invoice creation: open the print/preview
      // overlay immediately, submit to ZATCA in the background (non-blocking).
      const cust = refreshed.customers?.find((c: any) => c.id === newInvoice.customerId) || db.customers.find(c => c.id === newInvoice.customerId);
      const bank = refreshed.banks?.find((b: any) => b.id === newInvoice.bankId) || db.banks.find(b => b.id === newInvoice.bankId);
      onPrintDoc('Invoice', { ...newInvoice, customerData: cust, bankData: bank });
      fetch(`/api/zatca/submit-invoice/${invId}`, { method: 'POST' })
        .then(async (r) => {
          const data = await r.json().catch(() => ({}));
          if (onRefreshDb) await onRefreshDb();
          // Surface the real outcome instead of leaving a background rejection only
          // discoverable by reopening the invoice's ZATCA modal later.
          if (!r.ok || data.error) {
            triggerError(`ZATCA submission for invoice ${invNumber} failed: ${data.error || 'Unknown error'}`);
          } else if (data.status === 'REJECTED' || data.status === 'ERROR') {
            triggerError(`ZATCA rejected invoice ${invNumber}.`);
          } else if (data.status === 'CLEARED' || data.status === 'REPORTED') {
            triggerSuccess(`Invoice ${invNumber} ${data.status === 'CLEARED' ? 'cleared' : 'reported'} by ZATCA.`);
          }
        })
        .catch(err => {
          console.error('ZATCA submit on conversion error:', err);
          triggerError(`ZATCA submission for invoice ${invNumber} failed: ${err.message || 'Network error'}`);
        });

      // Matches the direct-invoice-creation flow: land on the Invoices List
      // where the newly issued invoice (and its live ZATCA status) now lives.
      onConverted();
      return;
    }

    if (onRefreshDb) await onRefreshDb();
    setConvertingQ(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err: any) {
    triggerError(err.message || 'Failed to convert quotation.');
  }
 };

 const handleConvAddLine = () => {
 setConvForm(prev => ({
 ...prev,
 items: [...prev.items, {
 id: generateId(),
 description: '',
 unitCost: 0,
 quantity: 1,
 discountAmount: 0
 }]
 }));
 };

 const handleConvRemoveLine = (idx: number) => {
 setConvForm(prev => ({
 ...prev,
 items: prev.items.filter((_, i) => i !== idx)
 }));
 };

 const handleConvUpdateLine = (idx: number, field: string, value: any) => {
 setConvForm(prev => {
 const updated = [...prev.items];
 updated[idx] = {
 ...updated[idx],
 [field]: value
 };
 return {
 ...prev,
 items: updated
 };
 });
 };

 // Helper to format grand total
 const getQuotationTotal = (q: Quotation) => {
 const totals = calculateInvoiceTotals(db, q.items, q.taxSlabId, q.discountPercentage);
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

 // Sort quotations
 const sortedQuotations = React.useMemo(() => {
 const list = [...filteredQuotations];
 
 if (sortField === 'createdAt') {
 list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
 return list;
 }

 list.sort((a, b) => {
 let valA: any = a[sortField as keyof Quotation];
 let valB: any = b[sortField as keyof Quotation];

 if (sortField === 'customer') {
 const custA = db.customers.find(c => c.id === a.customerId)?.name || '';
 const custB = db.customers.find(c => c.id === b.customerId)?.name || '';
 valA = custA.toLowerCase();
 valB = custB.toLowerCase();
 } else if (sortField === 'grandTotal') {
 valA = getQuotationTotal(a);
 valB = getQuotationTotal(b);
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
 }, [filteredQuotations, sortField, sortOrder, db.customers]);

 // Paginated quotations
 const totalPages = Math.ceil(sortedQuotations.length / itemsPerPage);
 const paginatedQuotations = React.useMemo(() => {
 const startIdx = (currentPage - 1) * itemsPerPage;
 return sortedQuotations.slice(startIdx, startIdx + itemsPerPage);
 }, [sortedQuotations, currentPage]);

 // Quotation KPI Analytics
 const kpiTotalValue = React.useMemo(() => {
   return filteredQuotations.reduce((sum, q) => sum + getQuotationTotal(q), 0);
 }, [filteredQuotations]);

 const kpiConvertedQuotes = React.useMemo(() => {
   return filteredQuotations.filter(q => q.status === 'Converted');
 }, [filteredQuotations]);

 const kpiConvertedValue = React.useMemo(() => {
   return kpiConvertedQuotes.reduce((sum, q) => sum + getQuotationTotal(q), 0);
 }, [kpiConvertedQuotes]);

 const kpiActiveQuotesCount = filteredQuotations.filter(q => q.status === 'Draft' || !q.status).length;

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
     {/* Total Pipeline */}
     <div className="p-4 rounded-2xl bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 text-white shadow-xl border border-indigo-900/60 relative overflow-hidden group">
       <div className="flex items-center justify-between mb-2">
         <span className="text-[10px] font-extrabold text-indigo-300 uppercase tracking-wider">{t("Pipeline Value")}</span>
         <span className="p-2 bg-indigo-600/30 border border-indigo-500/30 rounded-xl text-indigo-300">
           <FileText className="w-4 h-4" />
         </span>
       </div>
       <div className="text-xl font-extrabold tracking-tight">
         {kpiTotalValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span className="text-xs font-semibold text-indigo-300/80">{currencySymbol}</span>
       </div>
       <div className="text-[10px] text-slate-400 mt-1 flex items-center gap-1 font-semibold">
         <Sparkles className="w-3 h-3 text-amber-400" />
         <span>{filteredQuotations.length} {t("proposals issued")}</span>
       </div>
     </div>

     {/* Converted to Invoices */}
     <div className="p-4 rounded-2xl bg-gradient-to-br from-emerald-950/90 via-slate-900 to-emerald-950/80 text-white shadow-xl border border-emerald-900/60 relative overflow-hidden group">
       <div className="flex items-center justify-between mb-2">
         <span className="text-[10px] font-extrabold text-emerald-300 uppercase tracking-wider">{t("Converted Sales")}</span>
         <span className="p-2 bg-emerald-600/30 border border-emerald-500/30 rounded-xl text-emerald-300">
           <CheckCircle2 className="w-4 h-4" />
         </span>
       </div>
       <div className="text-xl font-extrabold tracking-tight text-emerald-400">
         {kpiConvertedValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span className="text-xs font-semibold text-emerald-300/80">{currencySymbol}</span>
       </div>
       <div className="text-[10px] text-emerald-300/80 mt-1 flex items-center gap-1 font-semibold">
         <Receipt className="w-3 h-3 text-emerald-400" />
         <span>{kpiConvertedQuotes.length} {t("converted to invoices")}</span>
       </div>
     </div>

     {/* Active Proposals */}
     <div className="p-4 rounded-2xl bg-gradient-to-br from-indigo-950 via-slate-900 to-slate-900 text-white shadow-xl border border-indigo-800/60 relative overflow-hidden group">
       <div className="flex items-center justify-between mb-2">
         <span className="text-[10px] font-extrabold text-indigo-300 uppercase tracking-wider">{t("Open Proposals")}</span>
         <span className="p-2 bg-indigo-600/30 border border-indigo-500/30 rounded-xl text-indigo-300">
           <Clock className="w-4 h-4" />
         </span>
       </div>
       <div className="text-xl font-extrabold tracking-tight text-indigo-200">
         {kpiActiveQuotesCount} <span className="text-xs font-normal text-slate-400">{t("Active")}</span>
       </div>
       <div className="text-[10px] text-indigo-300/80 mt-1 font-semibold">
         {t("Awaiting client confirmation")}
       </div>
     </div>

     {/* Conversion Rate */}
     <div className="p-4 rounded-2xl bg-gradient-to-br from-indigo-950 via-slate-900 to-slate-900 text-white shadow-xl border border-indigo-800/60 relative overflow-hidden group">
       <div className="flex items-center justify-between mb-2">
         <span className="text-[10px] font-extrabold text-indigo-300 uppercase tracking-wider">{t("Conversion Rate")}</span>
         <span className="p-2 bg-indigo-600/30 border border-indigo-500/30 rounded-xl text-indigo-300">
           <TrendingUp className="w-4 h-4" />
         </span>
       </div>
       <div className="text-xl font-extrabold tracking-tight">
         {filteredQuotations.length > 0 ? ((kpiConvertedQuotes.length / filteredQuotations.length) * 100).toFixed(1) : '0.0'}%
       </div>
       <div className="w-full bg-slate-800 h-1.5 rounded-full mt-2 overflow-hidden">
         <div 
           className="bg-emerald-400 h-full rounded-full transition-all duration-500" 
           style={{ width: `${filteredQuotations.length > 0 ? Math.min(100, (kpiConvertedQuotes.length / filteredQuotations.length) * 100) : 0}%` }}
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
   <FileText className="w-4 h-4 text-indigo-600" />
   <span>{t("Quotations & Proposals Workspace")}</span>
   <span className="text-[10px] font-bold text-slate-500 bg-slate-200/70 px-2 py-0.5 rounded-full">
     {filteredQuotations.length}
   </span>
 </h4>
 <div className="flex items-center gap-2 mt-1">
 <p className="text-[10px] text-slate-400">{isAdmin ? t('All user quotations') : t('Your personal quotation documents')}</p>
 <span className="text-[9px] font-bold text-indigo-600 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded-full uppercase">
 🏢 {t("Scoped:")} {db.companySetup?.name}
 </span>
 </div>
 </div>
 {openMonth && userPermissions.quotation.create.enabled && (
 <button
 onClick={handleInitiateCreate}
 className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl px-4 py-2 text-xs font-extrabold flex items-center gap-1.5 shadow-md shadow-indigo-600/20 transition-all cursor-pointer"
 >
 <Plus className="w-4 h-4" /> {t("New Quotation")}
 </button>
 )}
 </div>

 <div className="overflow-x-auto">
 <table className="w-full text-xs text-start">
 <thead>
 <tr className="bg-slate-50/50 border-b border-slate-100 text-slate-500 uppercase tracking-wider text-[10px]">
 {renderSortableHeader(t('Doc No'), 'quotationNumber')}
 {renderSortableHeader(t('Date'), 'date')}
 {renderSortableHeader(t('Customer'), 'customer')}
 {renderSortableHeader(t('Grand Total'), 'grandTotal', 'right')}
 {renderSortableHeader(t('Status'), 'status', 'center')}
 <th className="p-3 text-end">{t('Actions')}</th>
 </tr>
 </thead>
 <tbody>
 {paginatedQuotations.length === 0 ? (
 <tr>
 <td colSpan={6} className="p-8 text-center text-slate-400">
 {t('No quotations found for this period. Click "New Quotation" to start.')}
 </td>
 </tr>
 ) : (
 paginatedQuotations.map(q => {
 const cust = db.customers.find(c => c.id === q.customerId);
 const isAccepted = q.status === 'Accepted';
 const isDraft = q.status === 'Draft' || q.status === 'Sent';
 const canCancel = userPermissions.quotation.delete.enabled;

 return (
 <tr key={q.id} className="border-b border-slate-100 hover:bg-slate-50/20">
 <td className="p-3 font-bold text-slate-900">{q.quotationNumber}</td>
 <td className="p-3 text-slate-600">{q.date}</td>
 <td className="p-3 font-semibold text-slate-700">{cust?.name || t('Walk-in')}</td>
 <td className="p-3 text-end font-bold text-slate-900">{getQuotationTotal(q).toFixed(2)} {currencySymbol}</td>
 <td className="p-3 text-center">
 <StatusPill tone={
 q.isCancelled ? 'critical' :
 q.status === 'Draft' ? 'warn' :
 q.status === 'Sent' ? 'info' :
 q.status === 'Accepted' ? 'good' :
 q.status === 'Converted' ? 'info' : 'critical'
 }>
 {q.isCancelled ? t('Cancelled') : t(q.status)}
 </StatusPill>
 </td>
 <td className="p-3 text-end space-x-1.5">
 <div className="inline-flex items-center justify-end gap-1.5 flex-wrap">
 <button
 onClick={() => onPrintDoc('Quotation', { ...q, customerData: cust })}
 className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 transition cursor-pointer inline-flex items-center gap-1 text-[11px] font-semibold"
 title={t('Print / Generate PDF')}
 >
 <Printer className="w-3.5 h-3.5" />
 <span>{t('Print')}</span>
 </button>
 
 {q.status !== 'Converted' && !q.isCancelled && userPermissions.quotation.update.enabled && (
 <button
 onClick={() => handleInitiateEdit(q)}
 className="p-1.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 transition cursor-pointer inline-flex items-center gap-1 text-[11px] font-bold"
 title={t('Edit Quotation')}
 >
 <Edit3 className="w-3.5 h-3.5" />
 <span>{t('Edit')}</span>
 </button>
 )}

 {isDraft && (
 <button
 onClick={() => handleStatusChange(q.id, 'Accepted')}
 className="p-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-700 transition cursor-pointer inline-flex items-center gap-1 text-[11px] font-bold"
 title={t('Accept Quotation')}
 >
 <CheckCircle2 className="w-3.5 h-3.5" />
 <span>{t('Accept')}</span>
 </button>
 )}

 {isAccepted && openMonth && userPermissions.invoice.create.enabled && (
 <button
 onClick={() => handleInitiateConversion(q)}
 className="p-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white transition cursor-pointer inline-flex items-center gap-1 text-[10px] font-bold shadow-sm"
 title={t('Convert to Sales Invoice')}
 >
 <ArrowRight className="w-3.5 h-3.5" />
 <span>{t('Convert to Invoice')}</span>
 </button>
 )}

 {!q.isCancelled && q.status !== 'Converted' && canCancel && (
 <button
 onClick={() => {
 if (window.confirm(t('⚠️ Are you sure you want to CANCEL this quotation? This cannot be undone.'))) {
 handleCancelQuotation(q.id);
 }
 }}
 className="p-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 transition cursor-pointer inline-flex items-center gap-1 text-[11px] font-bold"
 title={t('Cancel Quotation')}
 >
 <AlertTriangle className="w-3.5 h-3.5" />
 <span>{t('Cancel')}</span>
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
 {Math.min(currentPage * itemsPerPage, sortedQuotations.length)}
 </span>{' '}
 of <span className="font-bold text-slate-700 ">{sortedQuotations.length}</span> records
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

 {/* CREATE & EDIT FORM VIEW */}
 {(view === 'create' || view === 'edit') && (
 <form onSubmit={handleSaveQuotation} className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-4 sm:p-5 space-y-4">
 <div className="flex justify-between items-center bg-slate-50/80 rounded-xl px-3.5 py-2 border border-slate-200/60">
 <div className="flex items-center gap-2.5 flex-wrap">
 <h3 className="font-extrabold text-xs text-slate-800 uppercase tracking-wider">
 {view === 'create' ? t('Draft New Fabrication Quotation') : t('Modify Existing Quotation')}
 </h3>
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
 <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{t('Document Date')}</label>
 <input
 type="date"
 required
 value={formDate}
 onChange={(e) => setFormDate(e.target.value)}
 className="w-full bg-slate-50/70 hover:bg-white border border-slate-200 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 font-medium focus:outline-none transition-all"
 />
 </div>

 <div className="lg:col-span-3 space-y-0.5">
 <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{t('Customer Selection')}</label>
 <select
 required
 value={formCustomerId}
 onChange={(e) => setFormCustomerId(e.target.value)}
 className="w-full bg-slate-50/70 hover:bg-white border border-slate-200 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 font-medium focus:outline-none transition-all"
 >
 {db.customers.filter(c => c.companyId === db.selectedCompanyId || !c.companyId).map(c => (
 <option key={c.id} value={c.id}>{c.name} {c.isSystem ? t('(Default)') : ''}</option>
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

 {companyBranches.length > 0 && (
 <div className="lg:col-span-2 space-y-0.5">
 <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{t('Branch')}</label>
 <select
 value={formBranchId}
 onChange={(e) => setFormBranchId(e.target.value)}
 className="w-full bg-slate-50/70 hover:bg-white border border-slate-200 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 font-medium focus:outline-none transition-all"
 >
 <option value="">{t('Default (your primary branch)')}</option>
 {companyBranches.map(b => (
 <option key={b.id} value={b.id}>{b.name}</option>
 ))}
 </select>
 </div>
 )}

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

 <div className="lg:col-span-3 space-y-0.5">
 <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{t("Notes / Memo")}</label>
 <input
 type="text"
 placeholder={t("Job specifications, deadlines")}
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
 <ItemCatalogSearch
 required
 placeholder={t("Type or search item from catalog...")}
 value={item.description}
 items={salesProducts}
 currencySymbol={currencySymbol}
 noMatchesLabel={t('No matching items found.')}
 onChangeText={(val) => {
 handleUpdateLineItem(idx, 'description', val);
 // Editing free-text after a catalog selection means the line may no longer match
 // that product — clear the link (onSelectItem below re-sets it if this change was
 // itself the result of picking a match from the dropdown).
 handleUpdateLineItem(idx, 'productId', undefined);
 }}
 onSelectItem={(matched: any) => {
 handleUpdateLineItem(idx, 'unitCost', matched.unitPrice || 0);
 // 'No'/'Lumpsum' are the product Unit-of-Measure picker's non-ZATCA-code
 // placeholder values (MasterEntities.tsx) — fall back to 'PCE', matching
 // normalizeZatcaUnitCode's server-side default for the same cases.
 const zatcaCode = matched.unit && matched.unit !== 'No' && matched.unit !== 'Lumpsum' ? matched.unit : 'PCE';
 handleUpdateLineItem(idx, 'unit', zatcaCode);
 handleUpdateLineItem(idx, 'productId', matched.id);
 handleUpdateLineItem(idx, 'unitOfMeasureId', matched.unitOfMeasureId || undefined);
 }}
 className="w-full bg-slate-50/50 hover:bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500 font-medium"
 />
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
 <span>{t('Items Gross Subtotal:')}</span>
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
           <span>{t('Line Item Discounts:')}</span>
           <span>-{calc.totalLineDiscount.toFixed(2)} {currencySymbol}</span>
         </div>
       )}

       {calc.totalLineDiscount > 0 && (
         <div className="flex justify-between text-slate-600 font-medium border-t border-slate-100/80 pt-1">
           <span>{t('Net Subtotal:')}</span>
           <span className="font-semibold text-slate-800">{calc.subtotal.toFixed(2)} {currencySymbol}</span>
         </div>
       )}

       {formDiscountPercentage > 0 && (
         <div className="flex justify-between text-rose-600 font-semibold">
           <span>{t('Header Discount')} ({formDiscountPercentage}%):</span>
           <span>-{calc.discountAmount.toFixed(2)} {currencySymbol}</span>
         </div>
       )}

       {calc.totalDiscount > 0 && (
         <div className="flex justify-between text-slate-700 font-bold border-t border-slate-100 pt-1">
           <span>{t('Total Discount Applied:')}</span>
           <span className="text-rose-600">-{calc.totalDiscount.toFixed(2)} {currencySymbol}</span>
         </div>
       )}
     </>
   );
 })()}

 <div className="flex justify-between text-slate-500">
 <span>{t('VAT Slab')} ({calculateInvoiceTotals(db, formItems, formTaxSlabId, formDiscountPercentage).percentage}%):</span>
 <span>
 {calculateInvoiceTotals(db, formItems, formTaxSlabId, formDiscountPercentage).taxAmount.toFixed(2)} {currencySymbol}
 </span>
 </div>

 <div className="flex justify-between font-bold text-sm text-slate-900 border-t border-slate-200 pt-2 mt-1">
 <span>{t('Grand Estimate:')}</span>
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
 className="px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl font-semibold text-xs"
 >
 {t('Cancel')}
 </button>
 <button
 type="submit"
 className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl px-5 py-2 font-bold text-xs shadow-sm"
 >
 {t('Save Quotation File')}
 </button>
 </div>
 </form>
 )}

 {/* Convert accepted quotation to invoice modal */}
 {convertingQ && (
 <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex justify-center items-start overflow-y-auto p-4 md:p-6">
 <div className="bg-white rounded-2xl border border-slate-100 shadow-2xl p-6 w-full max-w-4xl my-auto animate-in fade-in zoom-in-95 duration-100 text-xs text-slate-600">
 <h3 className="font-bold text-sm text-slate-900 mb-1 flex items-center gap-1.5 border-b border-slate-100 pb-3">
 <CheckSquare className="w-5 h-5 text-indigo-600" />
 <div>
 <span className="text-base text-slate-900 block font-bold">{t('Customize & Convert Accepted Quotation')}</span>
 <span className="text-slate-400 text-xs block font-normal">{t('Review and adjust items, pricing, discounts, and payment details before issuing the permanent sales invoice from')} {convertingQ.quotationNumber}.</span>
 </div>
 </h3>

 <form onSubmit={handleConvert} className="space-y-5 mt-4">
 {/* Top Configuration Grid */}
 <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Customer Relationship')}</label>
 <select
 required
 value={convForm.customerId}
 onChange={(e) => setConvForm({ ...convForm, customerId: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-indigo-600 font-medium"
 >
 {db.customers.map(c => (
 <option key={c.id} value={c.id}>{c.name} {c.isSystem ? t('(System Default)') : ''}</option>
 ))}
 </select>
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Invoice Issue Date')}</label>
 <input
 type="date"
 required
 value={convForm.date}
 onChange={(e) => setConvForm({ ...convForm, date: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-indigo-600 font-medium"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Post Inflows Bank')}</label>
 <select
 required
 value={convForm.bankId}
 onChange={(e) => setConvForm({ ...convForm, bankId: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-indigo-600 font-medium"
 >
 {db.banks.filter(b => b.isActive).map(b => (
 <option key={b.id} value={b.id}>{b.bankName}</option>
 ))}
 </select>
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('VAT Slab Configuration')}</label>
 <select
 required
 value={convForm.taxSlabId}
 onChange={(e) => setConvForm({ ...convForm, taxSlabId: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-indigo-600 font-medium"
 >
 {db.taxSlabs.map(t => (
 <option key={t.id} value={t.id}>{t.name} ({t.percentage}%)</option>
 ))}
 </select>
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Header Discount (%)')}</label>
 <input
 type="number"
 min="0"
 max="100"
 step="0.01"
 value={convForm.discountPercentage}
 onChange={(e) => setConvForm({ ...convForm, discountPercentage: parseFloat(e.target.value) || 0 })}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-indigo-600 font-medium"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Payment Status')}</label>
 <select
 required
 value={convForm.paymentStatus}
 onChange={(e) => setConvForm({ ...convForm, paymentStatus: e.target.value as any })}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-indigo-600 font-medium"
 >
 <option value="Paid">{t('Fully Paid (posts Receipt instantly)')}</option>
 <option value="Partially Paid">{t('Partially Paid (requires first partial payment subsequent entry)')}</option>
 <option value="Unpaid">{t('Pending / Unpaid Outstanding')}</option>
 </select>
 </div>
 </div>

 {/* Notes Field */}
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Internal / Client Notes')}</label>
 <textarea
 value={convForm.notes}
 onChange={(e) => setConvForm({ ...convForm, notes: e.target.value })}
 rows={2}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-indigo-600"
 placeholder={t('Notes to appear on invoice...')}
 />
 </div>

 {/* Items Table */}
 <div className="border border-slate-100 rounded-xl p-4 bg-slate-50/20">
 <div className="flex justify-between items-center mb-2.5">
 <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Line Items (Adjustable)')}</span>
 <button
 type="button"
 onClick={handleConvAddLine}
 className="flex items-center gap-1 text-[11px] font-bold text-indigo-600 hover:text-indigo-800"
 >
 <Plus className="w-3.5 h-3.5" /> {t('Add New Item Line')}
 </button>
 </div>

 <div className="space-y-2 max-h-52 overflow-y-auto pe-1">
 {convForm.items.map((item, idx) => {
 const lineTotal = Math.max(0, item.unitCost - (item.discountAmount || 0)) * item.quantity;
 return (
 <div key={item.id} className="grid grid-cols-1 md:grid-cols-12 gap-2.5 bg-slate-50 border border-slate-100 p-2.5 rounded-xl items-center">
 <div className="md:col-span-5 col-span-12 space-y-1">
 <label className="text-[9px] text-slate-400 font-semibold uppercase">{t('Description')}</label>
 <input
 type="text"
 required
 placeholder={t('CNC Services / Materials')}
 value={item.description}
 onChange={(e) => handleConvUpdateLine(idx, 'description', e.target.value)}
 className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1 text-xs text-slate-800 focus:outline-none font-medium"
 />
 </div>

 <div className="md:col-span-2 col-span-4 space-y-1">
 <label className="text-[9px] text-slate-400 font-semibold uppercase">{t('Unit Cost')} ({currencySymbol})</label>
 <input
 type="number"
 required
 min="0"
 step="0.01"
 value={item.unitCost || ''}
 onChange={(e) => handleConvUpdateLine(idx, 'unitCost', parseFloat(e.target.value) || 0)}
 className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1 text-xs text-slate-800 focus:outline-none font-medium"
 />
 </div>

 <div className="md:col-span-1.5 col-span-4 space-y-1">
 <label className="text-[9px] text-slate-400 font-semibold uppercase">{t('Qty')}</label>
 <input
 type="number"
 required
 min="0.01"
 step="any"
 value={item.quantity || ''}
 onChange={(e) => handleConvUpdateLine(idx, 'quantity', parseFloat(e.target.value) || 0)}
 className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1 text-xs text-slate-800 focus:outline-none font-medium"
 />
 </div>

 <div className="md:col-span-1.5 col-span-4 space-y-1">
 <label className="text-[9px] text-slate-400 font-semibold uppercase">{t('Line Disc')} ({currencySymbol})</label>
 <input
 type="number"
 min="0"
 step="0.01"
 placeholder="0.00"
 value={item.discountAmount || ''}
 onChange={(e) => handleConvUpdateLine(idx, 'discountAmount', parseFloat(e.target.value) || 0)}
 className="w-full bg-rose-50/30 border border-rose-200 rounded-lg px-2.5 py-1 text-xs text-slate-800 focus:outline-none font-medium"
 />
 </div>

 <div className="md:col-span-1.5 col-span-10 text-end space-y-1 self-center">
 <p className="text-[9px] text-slate-400 font-semibold uppercase">{t('Line Net')}</p>
 <p className="text-xs font-bold text-slate-800">{lineTotal.toFixed(2)} {currencySymbol}</p>
 </div>

 <div className="md:col-span-0.5 col-span-2 text-center self-center">
 <button
 type="button"
 disabled={convForm.items.length === 1}
 onClick={() => handleConvRemoveLine(idx)}
 className="p-1.5 hover:bg-rose-50 text-slate-400 hover:text-rose-600 disabled:opacity-30 rounded-lg mt-3"
 title={t('Remove Line')}
 >
 <Trash className="w-4 h-4" />
 </button>
 </div>
 </div>
 );
 })}
 </div>
 </div>

 {/* Live Totals Card */}
 <div className="flex justify-end pt-3 border-t border-slate-100">
 <div className="w-80 bg-slate-50 p-4 rounded-xl border border-slate-100 space-y-1.5 text-xs">
 <div className="flex justify-between text-slate-500">
 <span>{t('Items Gross Subtotal:')}</span>
 <span className="font-semibold text-slate-800">
 {calculateInvoiceTotals(db, convForm.items, convForm.taxSlabId, convForm.discountPercentage).grossSubtotal.toFixed(2)} {currencySymbol}
 </span>
 </div>

 {(() => {
   const calc = calculateInvoiceTotals(db, convForm.items, convForm.taxSlabId, convForm.discountPercentage);
   return (
     <>
       {calc.totalLineDiscount > 0 && (
         <div className="flex justify-between text-rose-600 font-semibold">
           <span>{t('Line Item Discounts:')}</span>
           <span>-{calc.totalLineDiscount.toFixed(2)} {currencySymbol}</span>
         </div>
       )}

       {calc.totalLineDiscount > 0 && (
         <div className="flex justify-between text-slate-600 font-medium border-t border-slate-100/80 pt-1">
           <span>{t('Net Subtotal:')}</span>
           <span className="font-semibold text-slate-800">{calc.subtotal.toFixed(2)} {currencySymbol}</span>
         </div>
       )}

       {convForm.discountPercentage > 0 && (
         <div className="flex justify-between text-rose-600 font-semibold">
           <span>{t('Header Discount')} ({convForm.discountPercentage}%):</span>
           <span>-{calc.discountAmount.toFixed(2)} {currencySymbol}</span>
         </div>
       )}

       {calc.totalDiscount > 0 && (
         <div className="flex justify-between text-slate-700 font-bold border-t border-slate-100 pt-1">
           <span>{t('Total Discount Applied:')}</span>
           <span className="text-rose-600">-{calc.totalDiscount.toFixed(2)} {currencySymbol}</span>
         </div>
       )}
     </>
   );
 })()}

 <div className="flex justify-between text-slate-500">
 <span>{t('VAT Slab')} ({calculateInvoiceTotals(db, convForm.items, convForm.taxSlabId, convForm.discountPercentage).percentage}%):</span>
 <span>
 {calculateInvoiceTotals(db, convForm.items, convForm.taxSlabId, convForm.discountPercentage).taxAmount.toFixed(2)} {currencySymbol}
 </span>
 </div>

 <div className="flex justify-between font-bold text-sm text-slate-900 border-t border-slate-200 pt-2 mt-1">
 <span>{t("Grand Total")}:</span>
 <span className="text-indigo-600 text-base font-bold">
 {calculateInvoiceTotals(db, convForm.items, convForm.taxSlabId, convForm.discountPercentage).grandTotal.toFixed(2)} {currencySymbol}
 </span>
 </div>
 </div>
 </div>

 {/* Modal Actions */}
 <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
 <button
 type="button"
 onClick={() => setConvertingQ(null)}
 className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl font-semibold text-xs transition"
 >
 {t('Discard Conversion')}
 </button>
 <button
 type="submit"
 className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl px-5 py-2 font-bold text-xs shadow-sm transition"
 >
 {t('Approve & Issue Invoice')}
 </button>
 </div>
 </form>
 </div>
 </div>
 )}

 </div>
 );
}
