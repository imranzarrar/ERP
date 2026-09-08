import React from 'react';
import { useTranslation, useDirtyGuard } from '../hooks';
// from 'react';
import { DatabaseState, saveDatabase, getActiveOpenMonth, isDateInOpenMonth, getDefaultTaxSlabId, calculateInvoiceTotals } from '../dbStore';
import { generateId } from '../id';
import { getMonthToDateRange } from '../dateUtils';
import { Invoice, InvoiceItem, Customer, TaxSlab, BankAccount, User, normalizePermissions } from '../types';
import StatusPill, { StatusPillTone } from './StatusPill';
import ItemCatalogSearch from './ItemCatalogSearch';
import {
  Plus,
  Trash,
  Check,
  AlertTriangle,
  Search,
  CheckSquare,
  Lock,
  ChevronUp,
  ChevronDown,
  Paperclip,
  X,
  TrendingUp,
  Clock,
  CreditCard,
  Sparkles,
  Receipt,
  ShieldCheck,
  RefreshCw,
  Eye
} from 'lucide-react';

interface InvoiceModuleProps {
 db: DatabaseState;
 // Local-only React state update — no /api/migrate POST. Use this after a change was
 // already persisted via its own dedicated /api/transactions/... route, for a patch that
 // only needs to touch specific known fields (never a raw GET /api/state response — see
 // onRefreshDb below for why). Deliberately a function-updater only, not a raw
 // DatabaseState — see App.tsx's handleUpdateDbLocal comment for the incident this
 // prevents at compile time.
 onUpdateDbLocal: (updater: (prev: DatabaseState) => DatabaseState) => void;
 // Real GET /api/state refetch (App.tsx's triggerDbRefresh), merged the same way the
 // initial page load is. Every handler in this file used to fetch /api/state itself and
 // hand the RAW response straight to onUpdateDbLocal as a full replacement of `db` —
 // that silently dropped selectedCompanyId/companySetup/currentUser, since none of those
 // exist in the server's response at all (they're derived client-side only, by this exact
 // merge). Confirmed live: resubmitting an invoice to ZATCA reset the active-company
 // selector back to the first company in the list and broke admin/permission checks
 // reading db.currentUser, moments after a real, successful save. Use this for the actual
 // state update instead; a handler may still do its own scoped GET /api/state read for a
 // specific lookup (e.g. the newly created invoice's id for the print preview) without
 // ever passing that raw object to onUpdateDbLocal.
 onRefreshDb?: () => Promise<void>;
 onPrintDoc: (type: 'Quotation' | 'Invoice' | 'Expense', data: any) => void;
 // 'list' renders the Sales Invoices table; 'add' renders the create form — each is
 // mounted under its own nav tab/permission (invoices vs invoices-add). No edit mode:
 // invoices are never modified in place, only paid/cancelled (existing row actions).
 mode: 'list' | 'add';
 onDone: () => void;
 onCreateNew: () => void;
 // Navigates to the dedicated View screen for one invoice — used both by a successful
 // save (replacing the old auto-open-print-modal behavior) and by the list row's own
 // View link.
 onViewInvoice: (id: string) => void;
 // Reports whether the create form has unsaved changes, for App.tsx's handleNavigate
 // guard (see useDirtyGuard in hooks.ts). Not relevant to 'list' mode — there's no form
 // to lose there.
 onDirtyChange?: (dirty: boolean) => void;
}

export default function InvoiceModule({ db, onUpdateDbLocal, onRefreshDb, onPrintDoc, mode, onDone, onCreateNew, onViewInvoice, onDirtyChange }: InvoiceModuleProps) {
 const { t, isRTL, lang } = useTranslation(db);
 const currentUser = db.currentUser;
 // The branch an admin configured as this user's primary in Staff Permissions
 // (userBranches.isPrimary) — auto-selected on a fresh form below rather than left on
 // the generic "Default (your primary branch)" placeholder, so a multi-branch user gets
 // visual confirmation of which branch they're actually about to file under.
 const myPrimaryBranchId = (db.userBranches || []).find(ub => ub.userId === currentUser?.id && ub.isPrimary)?.branchId || '';
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

 // List Filters — default to start of the current month through today.
 const [filterStartDate, setFilterStartDate] = React.useState<string>(() => getMonthToDateRange().start);
 const [filterEndDate, setFilterEndDate] = React.useState<string>(() => getMonthToDateRange().end);
 const [filterStatus, setFilterStatus] = React.useState<'All' | 'Unpaid'>('All');
 const [filterZatcaStatus, setFilterZatcaStatus] = React.useState<string>('All');
 const [filterDocType, setFilterDocType] = React.useState<'All' | 'Invoice' | 'CreditNote' | 'DebitNote'>('All');

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

      return userPermissions.invoice.read.enabled || (currentUser?.id ? inv.createdById === currentUser.id : false);
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
 const defaultTax = getDefaultTaxSlabId(db);
 const defaultBank = db.banks.find(b => b.isDefault && b.companyId === db.selectedCompanyId)?.id || db.banks.find(b => b.companyId === db.selectedCompanyId)?.id || '';
 const defaultItems = [{ description: '', unitCost: 0, quantity: 1, discountAmount: 0, taxSlabId: defaultTax }];
 setFormDate(initialDate);
 setFormCustomerId(defaultCust);
 setFormTaxSlabId(defaultTax);
 setFormBankId(defaultBank);
 setFormItems(defaultItems);
 setFormBranchId(myPrimaryBranchId);
 setFormAmountPaidNow('');
 // Baseline for the unsaved-changes guard below — built from these same local values
 // (not the state variables, which haven't updated yet within this synchronous effect)
 // so the very first render after auto-population never reads as "dirty". formWarehouseId
 // is deliberately excluded — it's re-derived by its own effect after formBranchId settles
 // (see resolvedDefaultWarehouseId above), which would otherwise race this snapshot.
 markFormClean({
   formDate: initialDate, formCustomerId: defaultCust, formTaxSlabId: defaultTax, formBankId: defaultBank,
   formPaymentStatus: 'Paid', formAmountPaidNow: '', formNotes: '', formAttachmentUrl: '',
   formDiscountPercentage: 0, formItems: defaultItems, formBranchId: myPrimaryBranchId,
   formSalesAssociateId: '',
 });
 }
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [db.selectedCompanyId, openMonth?.id, myPrimaryBranchId]);

 const triggerError = (msg: string) => {
 setError(msg);
 setTimeout(() => setError(null), 4500);
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
 const [formPaymentStatus, setFormPaymentStatus] = React.useState<'Paid' | 'Partially Paid' | 'Unpaid'>('Paid');
 // Only meaningful when formPaymentStatus === 'Partially Paid' — see ExpenseModule.tsx's
 // matching field for the same reasoning (the server derives paymentStatus itself from
 // whatever amountPaid is actually sent, via computePaymentStatus).
 const [formAmountPaidNow, setFormAmountPaidNow] = React.useState('');
 const [formNotes, setFormNotes] = React.useState('');
 const [formAttachmentUrl, setFormAttachmentUrl] = React.useState('');
 const [formDiscountPercentage, setFormDiscountPercentage] = React.useState<number>(0);
 const [formItems, setFormItems] = React.useState<Omit<InvoiceItem, 'id'>[]>([
 { description: '', unitCost: 0, quantity: 1, discountAmount: 0 }
 ]);
 // Empty string means "let the server resolve it" (the creating user's primary branch,
 // or null if branches aren't in use for this company) — see QuotationModule's matching
 // field for the full reasoning.
 const [formBranchId, setFormBranchId] = React.useState('');
 const companyBranches = (db.branches || []).filter(b => b.companyId === db.selectedCompanyId && b.isActive !== false);

 // Empty string means "let the server resolve it" — same reasoning as formBranchId
 // above: the branch's own configured default sales warehouse, else the company's
 // overall default, else nowhere (only an actual problem if the invoice has a stock
 // item — server/lib/businessLogic.ts's resolveSaleWarehouse enforces that). A
 // 'backend'-type warehouse is never offered here — a sale can't be posted against one.
 const [formWarehouseId, setFormWarehouseId] = React.useState('');
 const companySalesWarehouses = (db.warehouses || []).filter(w => w.companyId === db.selectedCompanyId && w.isActive !== false && w.type !== 'backend');
 // Mirrors the server's own two-tier resolution order (resolveDefaultSaleWarehouseId) so
 // the field shown here is exactly what would be auto-picked if left untouched — purely a
 // display convenience, the server always re-resolves/re-validates independently.
 const resolvedDefaultWarehouseId = React.useMemo(() => {
   const branchDefault = formBranchId ? (db.branches || []).find(b => b.id === formBranchId)?.defaultWarehouseId : undefined;
   if (branchDefault) return branchDefault;
   return (db.warehouses || []).find(w => w.companyId === db.selectedCompanyId && w.isCompanyDefault)?.id || '';
 }, [db.branches, db.warehouses, db.selectedCompanyId, formBranchId]);

 // Re-derives the auto-selected warehouse whenever the branch changes (including the
 // initial branch auto-select above), mirroring the server's own resolution order —
 // staff can still override it afterward, same as any other pre-filled field.
 React.useEffect(() => {
 if (view !== 'create') return;
 setFormWarehouseId(resolvedDefaultWarehouseId);
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [formBranchId, view]);

 // Optional attribution field — which employee gets credit for this sale (e.g. for a
 // sales-bonus calculation). Never affects totals/tax/ZATCA XML. Branch-scoped so a
 // cashier restricted to one branch (out of possibly dozens) never has to search a
 // company-wide roster: an employee based at Head Office (branchId null) is always
 // offered everywhere, alongside only the currently selected branch's own staff.
 const [formSalesAssociateId, setFormSalesAssociateId] = React.useState('');
 const eligibleSalesAssociates = React.useMemo(() => {
   return (db.employees || []).filter(e => {
     if (e.companyId !== db.selectedCompanyId || e.isActive === false) return false;
     const jobTitle = (db.jobTitles || []).find(jt => jt.id === e.jobTitleId);
     if (!jobTitle?.isSalesRole) return false;
     return e.branchId === null || e.branchId === undefined || e.branchId === formBranchId;
   });
 }, [db.employees, db.jobTitles, db.selectedCompanyId, formBranchId]);

 // Re-narrows live when the branch selector changes, mirroring formWarehouseId above —
 // if the previously picked associate is no longer eligible for the newly selected
 // branch (e.g. they belong to a different branch), clear the stale selection rather
 // than silently submitting it.
 React.useEffect(() => {
   if (formSalesAssociateId && !eligibleSalesAssociates.some(e => e.id === formSalesAssociateId)) {
     setFormSalesAssociateId('');
   }
   // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [formBranchId]);

 const { isDirty: isInvoiceFormDirty, markClean: markFormClean } = useDirtyGuard({
   formDate, formCustomerId, formTaxSlabId, formBankId, formPaymentStatus, formAmountPaidNow, formNotes,
   formAttachmentUrl, formDiscountPercentage, formItems, formBranchId, formSalesAssociateId,
 });

 React.useEffect(() => {
   if (view === 'create') onDirtyChange?.(isInvoiceFormDirty);
   // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [isInvoiceFormDirty, view]);

 React.useEffect(() => {
   // Clears the parent's dirty flag the moment this form unmounts (navigating away via
   // any path, not just the tracked fields), so a stale "dirty" state can never leak into
   // whichever screen renders next.
   return () => onDirtyChange?.(false);
   // eslint-disable-next-line react-hooks/exhaustive-deps
 }, []);

 // Autocomplete support
 const [activeAutocompleteIdx, setActiveAutocompleteIdx] = React.useState<number | null>(null);
 const [autocompleteFilter, setAutocompleteFilter] = React.useState('');

 // Flattened catalog rows for ItemCatalogSearch: one row per sellable product (its base
 // unit), plus one extra row per active packaging/alternate unit it has configured (see
 // ProductUnitConversion) — each carrying that unit's OWN barcode/sku/price so scanning a
 // carton's own barcode resolves straight to the carton, not the base product. `id` stays
 // the real productId on every row (packaging rows just add unitOfMeasureId/
 // conversionFactor) so onSelectItem below always sets the correct productId regardless
 // of which row was picked.
 const salesProducts = React.useMemo(() => {
   const baseProducts = (db.products || []).filter(p => {
     const isCompMatch = !p.companyId || p.companyId === db.selectedCompanyId;
     // 0 = Both, 1 = Sales, 2 = Purchase — exclude only Purchase-only; Both/Sales show here.
     return isCompMatch && p.salesPurchaseFlow !== 2;
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

 const handleAddLineItem = () => {
 setFormItems([...formItems, { description: '', unitCost: 0, quantity: 1, discountAmount: 0, taxSlabId: formTaxSlabId, unit: 'PCE' }]);
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
 if (!userPermissions.invoice.create.enabled) {
 return triggerError('You do not have permission to issue sales invoices.');
 }

 const validItems = formItems.filter(item => item.description && item.description.trim() !== "");
 if (validItems.length === 0) {
 return triggerError('Please add at least one line item with a description.');
 }

 // Resolved below, once the real grand total is known — see amountPaidVal near
 // invoiceData's assembly.
 if (formPaymentStatus === 'Partially Paid') {
 const paidNow = parseFloat(formAmountPaidNow);
 if (isNaN(paidNow) || paidNow <= 0) return triggerError('Enter a valid amount received for a partially paid invoice.');
 }

 const cleanItems: InvoiceItem[] = validItems.map(item => ({
 id: generateId(),
 description: item.description.trim(),
 unitCost: parseFloat(item.unitCost as any) || 0,
 quantity: parseFloat(item.quantity as any) || 1,
 discountAmount: parseFloat(item.discountAmount as any) || 0,
 taxSlabId: item.taxSlabId || formTaxSlabId,
 unit: item.unit,
 // Pre-existing gap fixed alongside the warehouse feature: this was never carried
 // through from the line's own state (set by ItemCatalogSearch via handleSelectProduct)
 // to the request payload, so a catalog-linked line on a manually-created invoice
 // silently lost its product link — the server's isNewInvoice && item.productId branch
 // (server/routes/transactions.ts) never ran, meaning no stock deduction and no
 // averageSalePrice update ever happened for a regular (non-POS, non-quotation-converted)
 // invoice, no matter how the product was selected on the form.
 productId: item.productId || undefined,
 unitOfMeasureId: item.unitOfMeasureId || undefined,
 }));

 // Sales price (unitCost) is what makes a line item a real sale — zero or missing
 // means nothing was actually charged for it, and a discount that wipes out (or
 // exceeds) the sales price makes the line a giveaway rather than a discounted sale.
 // Both checked per line, before totals are computed, so the error points at the
 // actual offending line rather than a confusing invoice-level total mismatch.
 for (const item of cleanItems) {
 if (!item.unitCost || item.unitCost <= 0) {
 return triggerError(`"${item.description}": Sales price must be greater than 0.`);
 }
 if (item.unitCost - (item.discountAmount || 0) <= 0) {
 return triggerError(`"${item.description}": Discount cannot reduce the sales price to zero or below.`);
 }
 }

 const resolvedCustomerId = formCustomerId || db.customers.find(c => c.isSystem && (c.companyId === db.selectedCompanyId || !c.companyId))?.id || db.customers.find(c => c.companyId === db.selectedCompanyId || !c.companyId)?.id || db.customers[0]?.id || '';
 const totals = calculateInvoiceTotals(db, cleanItems, formTaxSlabId, formDiscountPercentage);
 if (totals.grandTotal <= 0) {
 return triggerError('The invoice net total must be greater than 0.');
 }

 // Same three-way model as Expense's own payment status — the server derives
 // paymentStatus itself from whatever amountPaid is actually sent (computePaymentStatus
 // in businessLogic.ts), so this is purely computing the right amountPaid to send.
 let amountPaidVal = 0;
 if (formPaymentStatus === 'Paid') {
 amountPaidVal = totals.grandTotal;
 } else if (formPaymentStatus === 'Partially Paid') {
 amountPaidVal = parseFloat(formAmountPaidNow) || 0;
 if (amountPaidVal >= totals.grandTotal) {
 return triggerError('A partially paid amount must be less than the invoice total — use "Paid" instead if the full amount was received.');
 }
 }

 const invoiceData = {
 date: formDate,
 customerId: resolvedCustomerId,
 taxSlabId: formTaxSlabId,
 bankId: formBankId,
 paymentStatus: formPaymentStatus,
 paymentDate: formPaymentStatus !== 'Unpaid' ? formDate : null,
 notes: formNotes,
 status: 'Active' as const,
 originQuotationId: null,
 items: cleanItems,
 discountPercentage: formDiscountPercentage,
 attachmentUrl: formAttachmentUrl,
 amountPaid: amountPaidVal,
 branchId: formBranchId || undefined,
 warehouseId: formWarehouseId || undefined,
 salesAssociateId: formSalesAssociateId || undefined,
 };

 // Bring Invoice save up to the same standard QuotationModule's handleSaveQuotation
 // already uses: await the real dedicated save endpoint, check the response is
 // actually ok, and only THEN reflect success/open the print preview — instead of
 // mutating local state and showing success before any request to the server had
 // even been made.
 setIsSavingInvoice(true);
 try {
   const response = await fetch(`/api/transactions/invoices`, {
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
   if (onRefreshDb) await onRefreshDb();

   const newInv = refreshed.invoices?.find((i: Invoice) => i.id === result.invoiceId);
   triggerSuccess(`Invoice ${newInv?.invoiceNumber || ''} issued successfully.`);
   // Clear the unsaved-changes flag synchronously, before navigating away below —
   // onDirtyChange's own effect wouldn't fire until after this render, which would be too
   // late and would wrongly trigger App.tsx's "unsaved changes" prompt right after a
   // successful save.
   onDirtyChange?.(false);

   if (newInv) {
     // Finalized creation flow: land on the invoice's dedicated View screen (Print,
     // Download PDF, ZATCA status, and payment/credit-note actions all live there now)
     // instead of forcing the print/preview overlay open immediately. The dedicated
     // save endpoint above already auto-triggers ZATCA clearance/reporting server-side
     // (fire-and-forget) — poll once, shortly after, so a rejection is surfaced as a
     // toast even though the user has already navigated away from this form.
     onViewInvoice(newInv.id);

     setTimeout(() => {
       fetch('/api/state').then(r => r.json()).then(latest => {
         if (!latest?.invoices) return;
         if (onRefreshDb) onRefreshDb();
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
   } else {
     onDone();
   }
 } catch (err: any) {
   triggerError(err.message || 'Failed to save invoice.');
 } finally {
   setIsSavingInvoice(false);
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
 {openMonth && userPermissions.invoice.create.enabled && (
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
 // A Credit Note here is a full-document reversal (MVP scope) — a second one against the
 // same invoice would credit the customer twice for one sale, so once one exists the
 // action is hidden rather than left clickable into a guaranteed server 400.
 const existingCreditNote = db.invoices.find(i => i.originalInvoiceId === inv.id && i.documentType === 'CreditNote');
 const totalAmt = getInvoiceTotal(inv);
 const paidAmt = inv.amountPaid || 0;
 const remainingAmt = Number((totalAmt - paidAmt).toFixed(2));

 return (
 <tr key={inv.id} className="border-b border-slate-100 hover:bg-slate-50/20">
 <td className="p-3 font-bold text-slate-900">
 <div className="flex items-center gap-2">
 <button
 type="button"
 onClick={() => onViewInvoice(inv.id)}
 className="hover:text-indigo-600 hover:underline transition-colors"
 title={t('View invoice')}
 >
 {inv.invoiceNumber}
 </button>
 {inv.attachmentUrl && (
 <button
 onClick={() => setViewAttachment(inv.attachmentUrl)}
 className="p-1.5 bg-slate-100 hover:bg-indigo-100 text-slate-500 hover:text-indigo-600 rounded-lg transition-colors"
 title={t('View Attachment')}
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
 {inv.documentType === 'CreditNote' ? t('Credit Note') : inv.documentType === 'DebitNote' ? t('Debit Note') : t('Invoice')}
 </StatusPill>
 {inv.originalInvoiceId && (() => {
 const original = db.invoices.find(o => o.id === inv.originalInvoiceId);
 return original ? (
 <div className="text-[9px] text-slate-400 font-mono mt-0.5 whitespace-nowrap">{t('Ref:')} {original.invoiceNumber}</div>
 ) : null;
 })()}
 </td>
 <td className="p-3 text-slate-600">{inv.date}</td>
 <td className="p-3 font-semibold text-slate-700">{cust?.name || t('Walk-in')}</td>
 <td className="p-3 text-slate-500 font-medium">{bank?.bankName || t('Default')}</td>
 <td className="p-3 text-end font-bold text-slate-900">
 <div>{totalAmt.toFixed(2)} {currencySymbol}</div>
 {inv.paymentStatus === 'Partially Paid' && inv.documentType !== 'CreditNote' && (
 <div className="text-[9px] font-medium text-slate-400">{t("Paid:")} {paidAmt.toFixed(2)}</div>
 )}
 </td>
 <td className="p-3 text-center">
 {existingCreditNote ? (
  <StatusPill tone="warn">{t('Credited')}</StatusPill>
 ) : (
  <StatusPill tone={inv.status === 'Active' ? 'good' : 'critical'}>{t(inv.status)}</StatusPill>
 )}
 </td>
 <td className="p-3 text-center">
 <div className="flex flex-col items-center gap-0.5">
 {inv.documentType === 'CreditNote' ? (
 // paymentStatus is stored as 'Unpaid' on every Credit Note (schema default, never
 // actually meaningful — see server/routes/transactions.ts's note-creation route),
 // since a Credit Note is not a receivable of its own. Showing the raw value here
 // reads as "the customer still owes this," backwards from what a credit means.
 <StatusPill tone="neutral">{t('Not Applicable')}</StatusPill>
 ) : (
 <>
 <StatusPill tone={inv.paymentStatus === 'Paid' ? 'good' : inv.paymentStatus === 'Partially Paid' ? 'info' : 'warn'}>
 {t(inv.paymentStatus)}
 </StatusPill>
 {(inv.paymentStatus === 'Partially Paid' || inv.paymentStatus === 'Unpaid') && (
 <span className="text-[9px] font-mono text-slate-400 font-semibold">
 {t("Paid:")} {paidAmt.toFixed(2)} / {t("Due:")} {remainingAmt.toFixed(2)}
 </span>
 )}
 </>
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
       <StatusPill tone={zTone}>
         <ShieldCheck className="w-2.5 h-2.5" />
         {t(zStatus)}
       </StatusPill>
     );
   })()}
 </td>
 {/* Actions collapses to a single entry point — every action (ZATCA detail/QR,
 Print, Record Payment, Cancel, Credit Note) now lives inside the dedicated
 View Invoice screen instead of being duplicated here as separate icons. */}
 <td className="p-3 text-end">
 <button
 type="button"
 onClick={() => onViewInvoice(inv.id)}
 className="px-3 py-1.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 transition cursor-pointer inline-flex items-center gap-1.5 text-[11px] font-bold border border-indigo-200"
 title={t('View invoice')}
 >
 <Eye className="w-3.5 h-3.5" />
 <span>{t('View')}</span>
 </button>
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
 <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{t('Invoice Date')}<span className="text-rose-500"> *</span></label>
 <input
 type="date"
 required
 value={formDate}
 onChange={(e) => setFormDate(e.target.value)}
 className="w-full bg-slate-50/70 hover:bg-white border border-slate-200 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 font-medium focus:outline-none transition-all"
 />
 </div>

 <div className="lg:col-span-3 space-y-0.5">
 <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{t('Customer')}<span className="text-rose-500"> *</span></label>
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
 <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{t('VAT Slab')}<span className="text-rose-500"> *</span></label>
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

 {companySalesWarehouses.length > 0 && (
 <div className="lg:col-span-2 space-y-0.5">
 <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{t('Sales Warehouse')}</label>
 <select
 value={formWarehouseId}
 onChange={(e) => setFormWarehouseId(e.target.value)}
 className="w-full bg-slate-50/70 hover:bg-white border border-slate-200 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 font-medium focus:outline-none transition-all"
 >
 <option value="">{t('Default (branch/company default)')}</option>
 {companySalesWarehouses.map(w => (
 <option key={w.id} value={w.id}>{w.name}</option>
 ))}
 </select>
 </div>
 )}

 {eligibleSalesAssociates.length > 0 && (
 <div className="lg:col-span-2 space-y-0.5">
 <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{t('Sales Associate')}</label>
 <select
 value={formSalesAssociateId}
 onChange={(e) => setFormSalesAssociateId(e.target.value)}
 className="w-full bg-slate-50/70 hover:bg-white border border-slate-200 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 font-medium focus:outline-none transition-all"
 >
 <option value="">{t('None')}</option>
 {eligibleSalesAssociates.map(e => (
 <option key={e.id} value={e.id}>{`${e.employeeNumber} — ${e.name}`}</option>
 ))}
 </select>
 </div>
 )}

 {/* Bank configuration is Admin-only editable; staff see read-only bank */}
 <div className="lg:col-span-3 space-y-0.5">
 <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{t("Post Inflow Bank")}{isAdmin && <span className="text-rose-500"> *</span>}</label>
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
 <div className="flex flex-wrap gap-3 px-2 py-1 bg-slate-50/80 rounded-lg border border-slate-200 text-xs">
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
 <label className="flex items-center gap-1 cursor-pointer text-slate-700 font-semibold text-[11px]">
 <input
 type="radio"
 name="invPayStatus"
 checked={formPaymentStatus === 'Partially Paid'}
 onChange={() => setFormPaymentStatus('Partially Paid')}
 className="text-indigo-600 focus:ring-indigo-500"
 />
 <span>{t("Partially Paid")}</span>
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
 {formPaymentStatus === 'Partially Paid' && (
 <input
 type="number"
 required
 step="0.01"
 min="0"
 placeholder={t('Amount received now')}
 value={formAmountPaidNow}
 onChange={(e) => setFormAmountPaidNow(e.target.value)}
 className="w-full bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 text-[11px] text-amber-900 font-semibold focus:outline-none mt-1"
 />
 )}
 </div>

 {/* Design File (Attachment) is temporarily disabled per product decision — the
 underlying formAttachmentUrl state/field is left intact for the existing attachment
 view elsewhere in this file; only the create-form upload control is hidden. */}

 <div className="lg:col-span-8 space-y-0.5">
 <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{t("Notes / Memo")}</label>
 <input
 type="text"
 placeholder={t('Job description, payments, setups')}
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
 <th className="py-2.5 px-3 text-start">{t('Item Description / Catalogue Search')}<span className="text-rose-500"> *</span></th>
 <th className="py-2.5 px-3 text-end w-32">{t('Unit Price')} ({currencySymbol})<span className="text-rose-500"> *</span></th>
 <th className="py-2.5 px-3 text-center w-24">{t('Quantity')}<span className="text-rose-500"> *</span></th>
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
 // matched.unit can be 'No' (None/Default) or 'Lumpsum' (MasterEntities.tsx's
 // product Unit-of-Measure picker) — neither is a real ZATCA code, so this falls
 // back to 'PCE' the same way normalizeZatcaUnitCode does server-side, rather
 // than carrying a non-code string onto the invoice line.
 const zatcaCode = matched.unit && matched.unit !== 'No' && matched.unit !== 'Lumpsum' ? matched.unit : 'PCE';
 handleUpdateLineItem(idx, 'unit', zatcaCode);
 handleUpdateLineItem(idx, 'productId', matched.id);
 // Set only when a packaging-unit row was picked (see salesProducts's comment) —
 // undefined/null on a base-unit row, matching "no alternate unit" everywhere else.
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
 step="0.01"
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
 <Plus className="w-3.5 h-3.5" /> {t('Add Line Item')}
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
 {t('Cancel')}
 </button>
 <button
 type="submit"
 disabled={isSavingInvoice}
 className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl px-5 py-2 font-bold text-xs shadow-sm disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
 >
 <RefreshCw className={`w-3.5 h-3.5 ${isSavingInvoice ? 'animate-spin' : 'hidden'}`} />
 {isSavingInvoice ? t('Saving...') : t('Confirm & Issue Invoice')}
 </button>
 </div>
 </form>
 )}

 {/* CREDIT/DEBIT NOTE MODAL */}
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

 </div>
 );
}
