import React from 'react';
import { useTranslation, useDirtyGuard } from '../hooks';
import { DatabaseState, saveDatabase, getActiveOpenMonth, isDateInOpenMonth, getDefaultTaxSlabId, calculateInvoiceTotals } from '../dbStore';
import { generateId } from '../id';
import { Quotation, QuotationItem, Customer, TaxSlab, User, normalizePermissions } from '../types';
import StatusPill from './StatusPill';
import ItemCatalogSearch from './ItemCatalogSearch';
import PartySearchSelect from './PartySearchSelect';
import { usePaginatedList } from '../usePaginatedList';
import { RowNumberTh, RowNumberTd, PaginationFooter } from './PaginationControls';
import { handleLineItemGridKeyDown, handleFormSaveShortcut } from '../lineItemKeyboardNav';
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
 // Reports whether the create/edit form has unsaved changes, for App.tsx's handleNavigate
 // guard (see useDirtyGuard in hooks.ts).
 onDirtyChange?: (dirty: boolean) => void;
}

export default function QuotationModule({ db, onUpdateDbLocal, onRefreshDb, onPrintDoc, mode, editId, onDone, onEdit, onCreateNew, onConverted, onDirtyChange }: QuotationModuleProps) {
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
 // Baseline for the unsaved-changes guard — built from these same local values, not the
 // state variables (which haven't updated yet within this synchronous effect). formNotes/
 // formDiscountPercentage/formItems aren't touched by this create-defaults effect, so
 // their tracked baseline is just their own useState initial values.
 markFormClean({
   formDate: initialDate, formCustomerId: defaultCust, formTaxSlabId: defaultTax,
   formBranchId: myPrimaryBranchId, formNotes: '', formDiscountPercentage: 0,
   formItems: [{ description: '', unitCost: 0, quantity: 1, discountAmount: 0 }],
 });
 // eslint-disable-next-line react-hooks/exhaustive-deps
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
 const mappedItems = q.items.map(item => ({
 description: item.description,
 unitCost: item.unitCost,
 quantity: item.quantity,
 discountAmount: item.discountAmount || 0,
 taxSlabId: item.taxSlabId,
 }));
 setFormItems(mappedItems);
 markFormClean({
   formDate: q.date, formCustomerId: q.customerId, formTaxSlabId: q.taxSlabId,
   formBranchId: q.branchId || '', formNotes: q.notes, formDiscountPercentage: q.discountPercentage || 0,
   formItems: mappedItems,
 });
 // eslint-disable-next-line react-hooks/exhaustive-deps
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

 // List quotations - real server-side pagination (GET /api/quotations with ?page=...),
 // replacing the old client-side filter over the capped `db.quotations` array (see
 // .claude/skills/server-side-report-aggregation/SKILL.md — a plain list screen is fine to
 // paginate, but must not silently drop older rows past a fixed cap once a tenant's own
 // history grows). Company scoping and the admin-vs-own-records visibility rule are both
 // already enforced server-side in GET /api/quotations (server/routes/transactions.ts).
 const quotationsList = usePaginatedList<Quotation>('/api/transactions/quotations', 50, view === 'list');
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

 const { isDirty: isQuotationFormDirty, markClean: markFormClean } = useDirtyGuard({
   formDate, formCustomerId, formTaxSlabId, formBranchId, formNotes, formDiscountPercentage, formItems,
 });

 React.useEffect(() => {
   if (view === 'create' || view === 'edit') onDirtyChange?.(isQuotationFormDirty);
   // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [isQuotationFormDirty, view]);

 React.useEffect(() => {
   return () => onDirtyChange?.(false);
   // eslint-disable-next-line react-hooks/exhaustive-deps
 }, []);

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
     // 0 = Both, 1 = Sales, 2 = Purchase — exclude only Purchase-only; Both/Sales show here.
     return isCompMatch && p.salesPurchaseFlow !== 2;
   });
   // See InvoiceModule.tsx's matching salesProducts memo: db.products rows carry a
   // runtime unit_of_measure_id (display-only default-unit pointer) that must be cleared
   // on base rows, or onSelectItem below would mistake a base-unit pick for a packaging
   // selection and send a unitOfMeasureId the server can't resolve.
   const rows: (typeof baseProducts[number] & { unitOfMeasureId?: string | null; conversionFactor?: number })[] =
     baseProducts.map(p => ({ ...p, unitOfMeasureId: undefined }));
   for (const puc of (db.productUnitConversions || [])) {
     if (puc.isActive === false) continue;
     const product = baseProducts.find(p => p.id === puc.productId);
     if (!product) continue;
     const uom = (db.unitsOfMeasure || []).find(u => u.id === puc.unitOfMeasureId);
     rows.push({
       ...product,
       name: `${product.name} (${uom ? uom.name : t('Packaging Unit')} × ${puc.conversionFactor})`,
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

 // Blocks a second click/Enter while a save or conversion is still in flight. The ref (not
  // just state) is what actually stops the second call: state updates are async, so two
  // fast clicks would otherwise both see "not busy" and create two documents.
  const busyRef = React.useRef(false);
  const [isBusy, setIsBusy] = React.useState(false);
  const runGuarded = (fn: (e: React.FormEvent) => Promise<void>) => async (e: React.FormEvent) => {
    e.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setIsBusy(true);
    try { await fn(e); } finally { busyRef.current = false; setIsBusy(false); }
  };

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

    // editingQuotationId set means this is an edit, not a new document — the existing
    // quotationNumber must be carried through, or the server (which only generates a fresh
    // one when this field is empty, see server/routes/transactions.ts) silently reassigns
    // the NEXT number in the sequence on every single edit, bumping e.g. QT-3 to QT-4 the
    // moment someone just fixes a typo or changes the tax slab on a still-Draft quotation.
    const existingQuotation = editingQuotationId ? db.quotations.find(q => q.id === editingQuotationId) : undefined;
    const qData = {
      id: editingQuotationId,
      createdById: currentUser.id,
      date: formDate,
      customerId: formCustomerId || db.customers.find(c => c.isSystem)!.id,
      taxSlabId: formTaxSlabId,
      notes: formNotes,
      status: existingQuotation ? existingQuotation.status : "Draft" as const,
      quotationNumber: existingQuotation?.quotationNumber,
      items: cleanItems,
      discountPercentage: formDiscountPercentage,
      companyId: db.selectedCompanyId,
      branchId: formBranchId || undefined,
    };

    try {
      const response = await fetch(`/api/transactions/quotations`, {
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
      // Synchronously, before navigating away — see InvoiceModule.tsx's identical comment
      // for why this can't just wait on the isDirty effect.
      onDirtyChange?.(false);
      onDone();
    } catch (err: any) {
      triggerError(err.message);
    }
  };

 // Takes the full quotation object (the row already on-screen), not just its id — a
 // db.quotations.find(...) lookup here would silently no-op for a quotation past
 // /api/state's row cap once the paginated list (which has no such cap) shows an older
 // page than that lookup could see.
 const handleStatusChange = async (q: Quotation, newStatus: Quotation['status']) => {
  try {
    const response = await fetch(`/api/transactions/quotations/${q.id}`, {
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
      quotations: prev.quotations.map(item => item.id === q.id ? { ...item, status: newStatus } : item)
    }));
    if (onRefreshDb) await onRefreshDb();
    quotationsList.reload();
    reloadQuotationKpis();
  } catch (err: any) {
    triggerError(err.message || 'Failed to update quotation status');
  }
 };

 // Cancel quotation — dedicated route that sets the isCancelled flag (server-side
 // blocked for Converted or already-cancelled quotations), replacing the old
 // handleStatusChange(qId, 'Cancelled') generic-PUT approach.
 const handleCancelQuotation = async (qId: string) => {
  try {
    const response = await fetch(`/api/transactions/quotations/${qId}/cancel`, {
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
    quotationsList.reload();
    reloadQuotationKpis();
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
 discountAmount: item.discountAmount || 0,
 // Carried through from the quotation line, not re-derived — dropping these silently
 // turned every converted invoice into an untracked "manual" line with no warehouse
 // resolution and no stock deduction, even though the quotation itself was created by
 // searching a real stock item (found live: quantity never left inventory_stocks after
 // converting a 3-unit quotation, while an identical direct invoice correctly deducted).
 productId: item.productId,
 unit: item.unit,
 unitOfMeasureId: item.unitOfMeasureId,
 taxSlabId: item.taxSlabId,
 taxRate: item.taxRate
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
    const response = await fetch(`/api/transactions/quotations/${convertingQ.id}/convert`, {
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
    quotationsList.reload();
    reloadQuotationKpis();
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

 // Fetched from GET /api/reports/quotation-kpis (server/lib/financialReports.ts) instead
 // of summed client-side from db.quotations — see
 // .claude/skills/server-side-report-aggregation/SKILL.md. Also fixes a real bug found
 // while porting: the original never excluded a cancelled quotation from these totals
 // (isCancelled was never checked here), inflating both figures — the server version
 // excludes them, matching this codebase's own established "cancelled documents never
 // inflate a total" convention (see e.g. SalesReportsModule.tsx's getSalesRegisterData).
 // totalCount/convertedCount/activeCount were added alongside the pagination migration so
 // these KPI cards no longer depend on the (now removed) full client-side quotations list.
 const [quotationKpis, setQuotationKpis] = React.useState({ totalValue: 0, convertedValue: 0, totalCount: 0, convertedCount: 0, activeCount: 0 });
 const reloadQuotationKpis = React.useCallback(() => {
   if (!db.selectedCompanyId) return;
   fetch('/api/reports/quotation-kpis').then(r => r.ok ? r.json() : null).then(d => { if (d) setQuotationKpis(d); }).catch(() => {});
 }, [db.selectedCompanyId]);
 React.useEffect(() => { reloadQuotationKpis(); }, [reloadQuotationKpis]);
 const kpiTotalValue = quotationKpis.totalValue;
 const kpiConvertedValue = quotationKpis.convertedValue;
 const kpiConvertedCount = quotationKpis.convertedCount;
 const kpiActiveQuotesCount = quotationKpis.activeCount;

 const renderSortableHeader = (label: string, field: string, align: 'left' | 'center' | 'right' = 'left') => {
 const isCurrent = quotationsList.sortBy === field;
 return (
 <th
 onClick={() => quotationsList.toggleSort(field)}
 className={`p-3 cursor-pointer select-none hover:bg-slate-100 :bg-slate-800 transition-colors ${
 align === 'right' ? 'text-end' : align === 'center' ? 'text-center' : 'text-start'
 }`}
 >
 <div className={`flex items-center gap-1 ${
 align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start'
 }`}>
 <span>{label}</span>
 {isCurrent ? (
 quotationsList.sortDir === 'asc' ? <ChevronUp className="w-3.5 h-3.5 text-indigo-600 inline" /> : <ChevronDown className="w-3.5 h-3.5 text-indigo-600 inline" />
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
         <span>{quotationKpis.totalCount} {t("proposals issued")}</span>
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
         <span>{kpiConvertedCount} {t("converted to invoices")}</span>
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
         {quotationKpis.totalCount > 0 ? ((kpiConvertedCount / quotationKpis.totalCount) * 100).toFixed(1) : '0.0'}%
       </div>
       <div className="w-full bg-slate-800 h-1.5 rounded-full mt-2 overflow-hidden">
         <div
           className="bg-emerald-400 h-full rounded-full transition-all duration-500"
           style={{ width: `${quotationKpis.totalCount > 0 ? Math.min(100, (kpiConvertedCount / quotationKpis.totalCount) * 100) : 0}%` }}
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
     {quotationsList.total}
   </span>
 </h4>
 <div className="flex items-center gap-2 mt-1">
 <p className="text-[10px] text-slate-400">{isAdmin ? t('All user quotations') : t('Your personal quotation documents')}</p>
 <span className="text-[9px] font-bold text-indigo-600 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded-full uppercase">
 🏢 {t("Scoped:")} {db.companySetup?.name}
 </span>
 </div>
 </div>
 <div className="flex items-center gap-2">
 <div className="relative">
 <Search className="w-3.5 h-3.5 text-slate-400 absolute start-3 top-1/2 -translate-y-1/2" />
 <input
 type="text"
 value={quotationsList.search}
 onChange={e => quotationsList.setSearch(e.target.value)}
 placeholder={t('Search Doc No...')}
 className="ps-8 pe-3 py-2 rounded-xl border border-slate-200 text-xs w-48 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
 />
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
 </div>

 <div className="overflow-x-auto">
 <table className="w-full text-xs text-start">
 <thead>
 <tr className="bg-slate-50/50 border-b border-slate-100 text-slate-500 uppercase tracking-wider text-[10px]">
 <th className="p-3 text-start w-10">#</th>
 {renderSortableHeader(t('Doc No'), 'quotationNumber')}
 {renderSortableHeader(t('Date'), 'date')}
 <th className="p-3 text-start">{t('Customer')}</th>
 <th className="p-3 text-end">{t('Grand Total')}</th>
 {renderSortableHeader(t('Status'), 'status', 'center')}
 <th className="p-3 text-end">{t('Actions')}</th>
 </tr>
 </thead>
 <tbody>
 {quotationsList.loading ? (
 <tr>
 <td colSpan={7} className="p-8 text-center text-slate-400">{t('Loading...')}</td>
 </tr>
 ) : quotationsList.rows.length === 0 ? (
 <tr>
 <td colSpan={7} className="p-8 text-center text-slate-400">
 {t('No quotations found for this period. Click "New Quotation" to start.')}
 </td>
 </tr>
 ) : (
 quotationsList.rows.map((q, qIdx) => {
 const cust = db.customers.find(c => c.id === q.customerId);
 const isAccepted = q.status === 'Accepted';
 const isDraft = q.status === 'Draft' || q.status === 'Sent';
 const canCancel = userPermissions.quotation.delete.enabled;

 return (
 <tr key={q.id} className="border-b border-slate-100 hover:bg-slate-50/20">
 <RowNumberTd page={quotationsList.page} pageSize={quotationsList.pageSize} index={qIdx} />
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
 onClick={() => handleStatusChange(q, 'Accepted')}
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

 <PaginationFooter db={db} page={quotationsList.page} totalPages={quotationsList.totalPages} total={quotationsList.total} pageSize={quotationsList.pageSize} onPageChange={quotationsList.setPage} />
 </div>
 )}

 {/* CREATE & EDIT FORM VIEW */}
 {(view === 'create' || view === 'edit') && (
 <form onSubmit={runGuarded(handleSaveQuotation)} onKeyDown={handleFormSaveShortcut} className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-4 sm:p-5 space-y-4">
 <div className="flex justify-between items-center bg-slate-50/80 rounded-xl px-3.5 py-2 border border-slate-200/60">
 <div className="flex items-center gap-2.5 flex-wrap">
 <h3 className="font-extrabold text-xs text-slate-800 uppercase tracking-wider">
 {view === 'create' ? t('Draft New Quotation') : t('Modify Existing Quotation')}
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
 <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{t('Document Date')}<span className="text-rose-500"> *</span></label>
 <input
 type="date"
 required
 value={formDate}
 onChange={(e) => setFormDate(e.target.value)}
 className="w-full bg-slate-50/70 hover:bg-white border border-slate-200 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 font-medium focus:outline-none transition-all"
 />
 </div>

 <div className="lg:col-span-3 space-y-0.5">
 <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{t('Customer Selection')}<span className="text-rose-500"> *</span></label>
 <PartySearchSelect
 required
 valueId={formCustomerId}
 onSelect={setFormCustomerId}
 items={db.customers.filter(c => c.companyId === db.selectedCompanyId || !c.companyId).map(c => ({ id: c.id, name: c.name, code: c.customerCode, vatNumber: c.vatNumber, isSystem: c.isSystem }))}
 placeholder={t('Search by name, code, or VAT...')}
 noMatchesLabel={t('No matching customers')}
 systemLabel={t('Default')}
 className="w-full bg-slate-50/70 hover:bg-white border border-slate-200 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 font-medium focus:outline-none transition-all"
 />
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
 <span>{t('Itemised Line Items')}</span>
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
 <th className="py-2.5 px-3 text-center w-28">{t('VAT Slab')}</th>
 <th className="py-2.5 px-3 text-end w-32">{t('Total')} ({currencySymbol})</th>
 <th className="py-2.5 px-3 text-center w-12"></th>
 </tr>
 </thead>
 <tbody
 className="divide-y divide-slate-100"
 onKeyDown={(e) => handleLineItemGridKeyDown(e, { onAddRow: handleAddLineItem, onRemoveRow: handleRemoveLineItem })}
 >
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

 <td className="py-2 px-2 align-top">
 <select
 value={item.taxSlabId || formTaxSlabId}
 onChange={(e) => handleUpdateLineItem(idx, 'taxSlabId', e.target.value)}
 className="w-full bg-slate-50/50 hover:bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-800 focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500 font-medium"
 >
 {db.taxSlabs.map(slab => (
 <option key={slab.id} value={slab.id}>{slab.name} ({slab.percentage}%)</option>
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
 <div className="flex items-center gap-4">
 <span className="hidden sm:inline text-[10px] text-slate-400 font-medium">{t('Tip: Enter moves to the next field (adds a row at the end) · Alt+Backspace removes a row · Ctrl+S saves')}</span>
 <div className="text-xs font-semibold text-slate-500">
 {t("Total Items:")} <span className="text-slate-900 font-bold">{formItems.length}</span>
 </div>
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
 disabled={isBusy}
 className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed text-white rounded-xl px-5 py-2 font-bold text-xs shadow-sm"
 >
 {isBusy ? t('Saving...') : t('Save Quotation File')}
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

 <form onSubmit={runGuarded(handleConvert)} className="space-y-5 mt-4">
 {/* Top Configuration Grid */}
 <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Customer Relationship')}<span className="text-rose-500"> *</span></label>
 <PartySearchSelect
 required
 valueId={convForm.customerId}
 onSelect={(id) => setConvForm({ ...convForm, customerId: id })}
 items={db.customers.map(c => ({ id: c.id, name: c.name, code: c.customerCode, vatNumber: c.vatNumber, isSystem: c.isSystem }))}
 placeholder={t('Search by name, code, or VAT...')}
 noMatchesLabel={t('No matching customers')}
 systemLabel={t('System Default')}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-indigo-600 font-medium"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Invoice Issue Date')}<span className="text-rose-500"> *</span></label>
 <input
 type="date"
 required
 value={convForm.date}
 onChange={(e) => setConvForm({ ...convForm, date: e.target.value })}
 className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-indigo-600 font-medium"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Post Inflows Bank')}<span className="text-rose-500"> *</span></label>
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
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('VAT Slab Configuration')}<span className="text-rose-500"> *</span></label>
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
 <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Payment Status')}<span className="text-rose-500"> *</span></label>
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
 <Plus className="w-3.5 h-3.5" /> {t('Add Line Item')}
 </button>
 </div>

 <div className="space-y-2 max-h-52 overflow-y-auto pe-1">
 {convForm.items.map((item, idx) => {
 const lineTotal = Math.max(0, item.unitCost - (item.discountAmount || 0)) * item.quantity;
 return (
 <div key={item.id} className="grid grid-cols-1 md:grid-cols-12 gap-2.5 bg-slate-50 border border-slate-100 p-2.5 rounded-xl items-center">
 <div className="md:col-span-5 col-span-12 space-y-1">
 <label className="text-[9px] text-slate-400 font-semibold uppercase">{t('Description')}<span className="text-rose-500"> *</span></label>
 <input
 type="text"
 required
 placeholder={t('Product or Service Description')}
 value={item.description}
 onChange={(e) => handleConvUpdateLine(idx, 'description', e.target.value)}
 className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1 text-xs text-slate-800 focus:outline-none font-medium"
 />
 </div>

 <div className="md:col-span-2 col-span-4 space-y-1">
 <label className="text-[9px] text-slate-400 font-semibold uppercase">{t('Unit Cost')} ({currencySymbol})<span className="text-rose-500"> *</span></label>
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
 <label className="text-[9px] text-slate-400 font-semibold uppercase">{t('Qty')}<span className="text-rose-500"> *</span></label>
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
 disabled={isBusy}
 className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed text-white rounded-xl px-5 py-2 font-bold text-xs shadow-sm transition"
 >
 {isBusy ? t('Saving...') : t('Approve & Issue Invoice')}
 </button>
 </div>
 </form>
 </div>
 </div>
 )}

 </div>
 );
}
