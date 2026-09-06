import React from 'react';
import { useTranslation, usePermissions, useDirtyGuard } from '../hooks';
import { DatabaseState, generateId, getDefaultTaxSlabId } from '../dbStore';
import {
  Warehouse,
  PurchaseRequisition,
  PurchaseRequisitionItem,
  PurchaseOrder,
  PurchaseOrderItem,
  GoodsReceiptNote,
  GoodsReceiptNoteItem,
  InventoryStock,
  ProductService,
  Vendor,
  PurchaseBill,
  PurchaseReturn,
  PhysicalStockTake,
  WarehouseDispatch,
  WarehouseDispatchItem,
  WarehouseReceiving
} from '../types';
import {
  Plus,
  Search,
  Building2,
  FileText,
  ClipboardCheck,
  Boxes,
  AlertCircle,
  Calendar,
  User,
  Eye,
  CheckCircle2,
  XCircle,
  TrendingUp,
  DollarSign,
  Layers,
  FileCheck,
  PackageCheck,
  Receipt,
  Undo2,
  ClipboardList,
  Truck,
  PackageOpen,
  Printer,
  Ban
} from 'lucide-react';

interface InventoryModuleProps {
  db: DatabaseState;
  // setDb-only local state update (App.tsx's handleUpdateDbLocal) — no /api/migrate POST.
  // Every handler in this file already calls a real REST route (warehouses, PR/PO/GRN,
  // stock adjustments) and only reaches this afterward to reflect that success in local
  // state (see PosModule.tsx's comment on its own onUpdateDbLocal for a real incident the
  // full-blob sync this used to sit alongside caused elsewhere). Deliberately a
  // function-updater only, not a raw DatabaseState — see App.tsx's handleUpdateDbLocal
  // comment for the incident this prevents at compile time.
  onUpdateDbLocal: (updater: (prev: DatabaseState) => DatabaseState) => void;
  // Real GET /api/state refetch (App.tsx's triggerDbRefresh) — used after actions whose
  // full effect isn't a single record's own fields (GRN reversal, Return cancellation,
  // Stock Take finalization all mutate inventoryStocks quantities server-side that this
  // component has no reliable way to re-derive locally), so the on-hand quantity shown
  // doesn't stay stale until an unrelated later reload happens to pick it up.
  onRefreshDb?: () => Promise<void>;
  // Opens the shared print/preview overlay (App.tsx's printDoc state) — used to
  // auto-open a printable payment receipt right after a Purchase Bill disbursement.
  onPrintDoc?: (type: 'PaymentReceipt' | 'WarehouseDispatch' | 'WarehouseReceiving', data: any) => void;
  currentUser: any;
  defaultTab?: 'stock' | 'pr' | 'po' | 'grn' | 'warehouses' | 'bills' | 'returns' | 'stocktakes' | 'dispatch' | 'receiving';
  // Reports whether ANY of this module's 8 create forms currently has unsaved changes,
  // for App.tsx's handleNavigate guard (see useDirtyGuard in hooks.ts). Unlike Invoice/
  // Quotation/Expense, this component has no onDone/mode prop — each form is its own
  // internal open/close boolean, not a nav-tab transition — so its own Cancel/Close
  // buttons are guarded locally (see confirmDiscard below) rather than solely relying on
  // this callback; this callback exists only for the sidebar-navigates-elsewhere case.
  onDirtyChange?: (dirty: boolean) => void;
}

export default function InventoryModule({
  db,
  onUpdateDbLocal,
  onRefreshDb,
  onPrintDoc,
  currentUser,
  defaultTab = 'stock',
  onDirtyChange
}: InventoryModuleProps) {
  const { t } = useTranslation(db);
  const { can } = usePermissions(currentUser);
  const isAdmin = currentUser?.role === 'admin' || currentUser?.isSuperAdmin === true;
  const companyId = db.selectedCompanyId;

  // Currency is derived from the active company's real configuration (matches the
  // pattern already used in PosModule.tsx), never hardcoded — different companies in
  // this multi-tenant app can be configured with different currencies.
  const activeCompany = db.companies?.find((c: any) => c.id === companyId);
  const currency = activeCompany?.currency || 'SAR';

  // Default VAT rate comes from the company's actual configured default tax slab
  // (Admin Settings > Tax Slabs > Set Default), not a hardcoded "assume 15%" guess —
  // that guess was silently wrong for any company whose real default rate wasn't 15%,
  // and disagreed with what Invoice/Quotation/POS forms use for the same company.
  const defaultTaxSlab = db.taxSlabs?.find(ts => ts.id === getDefaultTaxSlabId(db));
  const defaultTaxRate = defaultTaxSlab?.percentage ?? 15;

  // Inline success/error banners (matches InvoiceModule.tsx's triggerError/triggerSuccess
  // pattern) plus per-action submitting guards so create buttons can't be double-clicked
  // mid-request.
  const [success, setSuccess] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const triggerSuccess = (msg: string) => {
    setSuccess(msg);
    setTimeout(() => setSuccess(null), 3500);
  };
  const triggerError = (msg: string) => {
    setError(msg);
    setTimeout(() => setError(null), 4500);
  };
  const [isSubmittingPr, setIsSubmittingPr] = React.useState(false);
  const [isSubmittingPo, setIsSubmittingPo] = React.useState(false);
  const [isSubmittingGrn, setIsSubmittingGrn] = React.useState(false);
  const [isSubmittingWarehouse, setIsSubmittingWarehouse] = React.useState(false);
  const [isSubmittingAdjustment, setIsSubmittingAdjustment] = React.useState(false);

  // State
  const [activeSubTab, setActiveSubTab] = React.useState<'stock' | 'pr' | 'po' | 'grn' | 'warehouses' | 'bills' | 'returns' | 'stocktakes' | 'dispatch' | 'receiving'>(defaultTab);

  // Lists from state filtered by current company
  const warehouses = (db.warehouses || []).filter(w => w.companyId === companyId);
  const purchaseRequisitions = (db.purchaseRequisitions || []).filter(pr => pr.companyId === companyId);
  const purchaseOrders = (db.purchaseOrders || []).filter(po => po.companyId === companyId);
  const goodsReceiptNotes = (db.goodsReceiptNotes || []).filter(grn => grn.companyId === companyId);
  const inventoryStocks = (db.inventoryStocks || []).filter(s => s.companyId === companyId);
  const purchaseBills = (db.purchaseBills || []).filter((b: PurchaseBill) => b.companyId === companyId);
  const purchaseReturns = (db.purchaseReturns || []).filter((r: PurchaseReturn) => r.companyId === companyId);
  const physicalStockTakes = (db.physicalStockTakes || []).filter((s: PhysicalStockTake) => s.companyId === companyId);
  const warehouseDispatches = (db.warehouseDispatches || []).filter((d: WarehouseDispatch) => d.companyId === companyId);
  const warehouseReceivings = (db.warehouseReceivings || []).filter((r: WarehouseReceiving) => r.companyId === companyId);
  const banks = (db.banks || []).filter((b: any) => b.isActive && b.companyId === companyId);
  const products = (db.products || []).filter(p => p.companyId === companyId);
  const vendors = (db.vendors || []).filter(v => v.companyId === companyId);

  // Search & Filters
  const [searchQuery, setSearchQuery] = React.useState('');
  const [warehouseFilter, setWarehouseFilter] = React.useState('all');

  // Detail / View modals
  const [viewingPr, setViewingPr] = React.useState<PurchaseRequisition | null>(null);
  const [viewingPo, setViewingPo] = React.useState<PurchaseOrder | null>(null);
  const [viewingGrn, setViewingGrn] = React.useState<GoodsReceiptNote | null>(null);
  const [viewingBill, setViewingBill] = React.useState<PurchaseBill | null>(null);
  const [viewingReturn, setViewingReturn] = React.useState<PurchaseReturn | null>(null);
  const [viewingStockTake, setViewingStockTake] = React.useState<PhysicalStockTake | null>(null);
  const [viewingDispatch, setViewingDispatch] = React.useState<WarehouseDispatch | null>(null);
  const [viewingReceiving, setViewingReceiving] = React.useState<WarehouseReceiving | null>(null);
  // The dispatch currently being received against — opens the Receiving confirm form,
  // pre-filled from this dispatch's own items (see handleOpenReceiving).
  const [receivingAgainstDispatch, setReceivingAgainstDispatch] = React.useState<WarehouseDispatch | null>(null);

  // Creation Modals
  const [isCreatingPr, setIsCreatingPr] = React.useState(false);
  const [editingPrId, setEditingPrId] = React.useState<string | null>(null);
  const [isCreatingPo, setIsCreatingPo] = React.useState(false);
  const [isCreatingGrn, setIsCreatingGrn] = React.useState(false);
  const [isCreatingWarehouse, setIsCreatingWarehouse] = React.useState(false);
  const [isAdjustingStock, setIsAdjustingStock] = React.useState(false);
  const [isCreatingBill, setIsCreatingBill] = React.useState(false);
  const [isCreatingReturn, setIsCreatingReturn] = React.useState(false);
  const [isCreatingStockTake, setIsCreatingStockTake] = React.useState(false);
  const [isPayingBill, setIsPayingBill] = React.useState<PurchaseBill | null>(null);
  const [isSubmittingBill, setIsSubmittingBill] = React.useState(false);
  const [isSubmittingReturn, setIsSubmittingReturn] = React.useState(false);
  const [isSubmittingStockTake, setIsSubmittingStockTake] = React.useState(false);
  const [isCreatingDispatch, setIsCreatingDispatch] = React.useState(false);
  const [isSubmittingDispatch, setIsSubmittingDispatch] = React.useState(false);
  const [isSubmittingReceiving, setIsSubmittingReceiving] = React.useState(false);
  const [isCancellingDispatch, setIsCancellingDispatch] = React.useState(false);

  // PR Form State
  const [prForm, setPrForm] = React.useState({
    requestedBy: currentUser?.username || '',
    notes: '',
    branchId: '',
    items: [] as Array<{ productId: string; quantity: number; purpose: string }>
  });
  const companyBranches = (db.branches || []).filter(b => b.companyId === db.selectedCompanyId && b.isActive !== false);
  // The branch an admin configured as this user's primary in Staff Permissions
  // (userBranches.isPrimary) — auto-selected on a fresh PR/PO form rather than left on the
  // generic "Default (your primary branch)" placeholder, so a multi-branch user gets visual
  // confirmation of which branch they're actually about to file under.
  const myPrimaryBranchId = (db.userBranches || []).find((ub: any) => ub.userId === currentUser?.id && ub.isPrimary)?.branchId || '';
  const [newPrItem, setNewPrItem] = React.useState({ productId: '', quantity: 1, purpose: '' });

  // PO Form State
  const [poForm, setPoForm] = React.useState({
    vendorId: '',
    requisitionId: '', // Optional
    deliveryDate: '',
    notes: '',
    branchId: '',
    items: [] as Array<{ productId: string; quantityOrdered: number; unitPrice: number; taxRate: number; unitOfMeasureId?: string }>
  });
  const [newPoItem, setNewPoItem] = React.useState({ productId: '', quantityOrdered: 1, unitPrice: 0, taxRate: defaultTaxRate, unitOfMeasureId: '' });
  const [poBarcodeInput, setPoBarcodeInput] = React.useState('');

  // GRN Form State
  const [grnForm, setGrnForm] = React.useState({
    purchaseOrderId: '',
    warehouseId: warehouses[0]?.id || '',
    vendorId: '',
    isDsd: false,
    receivedBy: currentUser?.username || '',
    notes: '',
    vehicleNumber: '',
    driverName: '',
    items: [] as Array<{ productId: string; quantityReceived: number; unitCost: number; taxRate: number; batchNumber: string; expiryDate: string; unitOfMeasureId?: string }>
  });
  const [newGrnItem, setNewGrnItem] = React.useState({ productId: '', quantityReceived: 1, unitCost: 0, taxRate: defaultTaxRate, batchNumber: '', expiryDate: '', unitOfMeasureId: '' });
  const [grnBarcodeInput, setGrnBarcodeInput] = React.useState('');

  // Warehouse Form State
  const [warehouseForm, setWarehouseForm] = React.useState({ name: '', code: '', address: '' });

  // Stock Adjustment Form State
  const [adjustmentForm, setAdjustmentForm] = React.useState({
    productId: '',
    warehouseId: warehouses[0]?.id || '',
    quantity: 0,
    batchNumber: '',
    reason: ''
  });

  // Purchase Bill Form State — references one or more un-billed GRNs (the 3-way match);
  // totals are always computed server-side from those GRNs, never entered here.
  const [billForm, setBillForm] = React.useState({ grnIds: [] as string[], dueDate: '', bankId: '' });
  const [payBillForm, setPayBillForm] = React.useState({ date: '', amount: '', bankId: '' });

  // Purchase Return (Debit Note) Form State
  const [returnForm, setReturnForm] = React.useState({
    grnId: '',
    notes: '',
    items: [] as Array<{ productId: string; quantityReturned: number; batchNumber: string; unitOfMeasureId?: string }>
  });
  const [newReturnItem, setNewReturnItem] = React.useState({ productId: '', quantityReturned: 1, batchNumber: '', unitOfMeasureId: '' });
  const [returnBarcodeInput, setReturnBarcodeInput] = React.useState('');

  // Physical Stock Take Form State — systemQuantity is always snapshotted server-side,
  // never entered here; this only collects what was physically counted.
  const [stockTakeForm, setStockTakeForm] = React.useState({
    warehouseId: warehouses[0]?.id || '',
    performedBy: currentUser?.username || '',
    notes: '',
    items: [] as Array<{ productId: string; physicalQuantity: number; batchNumber: string; unitOfMeasureId?: string }>
  });
  const [newStockTakeItem, setNewStockTakeItem] = React.useState({ productId: '', physicalQuantity: 0, batchNumber: '', unitOfMeasureId: '' });
  const [stockTakeBarcodeInput, setStockTakeBarcodeInput] = React.useState('');

  // Warehouse Dispatch Form State
  const [dispatchForm, setDispatchForm] = React.useState({
    fromWarehouseId: warehouses[0]?.id || '',
    toWarehouseId: '',
    vehicleNumber: '',
    driverName: '',
    driverContact: '',
    expectedArrivalDate: '',
    dispatchedBy: currentUser?.username || '',
    notes: '',
    items: [] as Array<{ productId: string; quantityDispatched: number; batchNumber: string; expiryDate: string; unitOfMeasureId?: string }>
  });
  const [newDispatchItem, setNewDispatchItem] = React.useState({ productId: '', quantityDispatched: 1, batchNumber: '', expiryDate: '', unitOfMeasureId: '' });
  const [dispatchBarcodeInput, setDispatchBarcodeInput] = React.useState('');

  // Warehouse Receiving Form State — quantityReceived per line defaults to the dispatch
  // line's own quantityDispatched (seeded in handleOpenReceiving), independently editable.
  const [receivingForm, setReceivingForm] = React.useState({
    receivedBy: currentUser?.username || '',
    condition: '',
    discrepancyNotes: '',
    notes: '',
    items: [] as Array<{ dispatchItemId: string; productId: string; quantityDispatched: number; quantityReceived: number; batchNumber: string; unitOfMeasureId?: string }>
  });

  // Shared barcode/SKU resolver for the four forms above — mirrors
  // server/lib/uomConversion.ts's resolveProductByCode exactly, but resolves entirely
  // client-side against already-loaded db state (no round-trip needed): an active
  // packaging unit's own barcode/sku first, then the base product's own barcode/sku.
  const resolveProductByCode = React.useCallback((code: string): { productId: string; unitOfMeasureId: string | null; purchasePrice: number | null; salePrice: number | null } | null => {
    const trimmed = code.trim();
    if (!trimmed) return null;
    const conversionHit = (db.productUnitConversions || []).find(puc =>
      puc.isActive !== false && (puc.barcode === trimmed || (puc.sku && puc.sku.toLowerCase() === trimmed.toLowerCase()))
    );
    if (conversionHit) {
      return {
        productId: conversionHit.productId, unitOfMeasureId: conversionHit.unitOfMeasureId,
        purchasePrice: conversionHit.purchasePrice ?? null, salePrice: conversionHit.salePrice ?? null,
      };
    }
    const baseHit = (db.products || []).find((p: any) => p.barcode === trimmed || (p.sku && p.sku.toLowerCase() === trimmed.toLowerCase()));
    if (!baseHit) return null;
    return { productId: baseHit.id, unitOfMeasureId: null, purchasePrice: baseHit.costPrice ?? baseHit.unitPrice, salePrice: baseHit.unitPrice };
  }, [db.productUnitConversions, db.products]);

  // Unsaved-changes guard — one useDirtyGuard per document type (see hooks.ts). This
  // component has no onDone/mode prop like Invoice/Quotation/Expense; each form is its
  // own internal open/close boolean rather than a nav-tab transition, so a form's own
  // Cancel/Close buttons never go through App.tsx's handleNavigate at all. confirmDiscard
  // below guards those buttons directly; onDirtyChange (reported from the OR of all 8) is
  // only for the case where the user navigates elsewhere via the sidebar while a form here
  // is open and dirty.
  const { isDirty: isPrDirty, markClean: markPrClean } = useDirtyGuard(prForm);
  const { isDirty: isPoDirty, markClean: markPoClean } = useDirtyGuard(poForm);
  const { isDirty: isGrnDirty, markClean: markGrnClean } = useDirtyGuard(grnForm);
  const { isDirty: isBillDirty, markClean: markBillClean } = useDirtyGuard(billForm);
  const { isDirty: isReturnDirty, markClean: markReturnClean } = useDirtyGuard(returnForm);
  const { isDirty: isStockTakeDirty, markClean: markStockTakeClean } = useDirtyGuard(stockTakeForm);
  const { isDirty: isDispatchDirty, markClean: markDispatchClean } = useDirtyGuard(dispatchForm);
  const { isDirty: isReceivingDirty, markClean: markReceivingClean } = useDirtyGuard(receivingForm);

  // Baseline each form the moment it opens (its own state has already been reset/seeded
  // to starting values by whichever "New X"/"Edit X"/"Receive" handler flipped this same
  // visibility flag, in the same synchronous event — so the value read here is correct).
  React.useEffect(() => { if (isCreatingPr) markPrClean(prForm); }, [isCreatingPr, editingPrId]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { if (isCreatingPo) markPoClean(poForm); }, [isCreatingPo]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { if (isCreatingGrn) markGrnClean(grnForm); }, [isCreatingGrn]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { if (isCreatingBill) markBillClean(billForm); }, [isCreatingBill]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { if (isCreatingReturn) markReturnClean(returnForm); }, [isCreatingReturn]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { if (isCreatingStockTake) markStockTakeClean(stockTakeForm); }, [isCreatingStockTake]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { if (isCreatingDispatch) markDispatchClean(dispatchForm); }, [isCreatingDispatch]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { if (receivingAgainstDispatch) markReceivingClean(receivingForm); }, [receivingAgainstDispatch]); // eslint-disable-line react-hooks/exhaustive-deps

  const anyInventoryFormDirty = isPrDirty || isPoDirty || isGrnDirty || isBillDirty || isReturnDirty || isStockTakeDirty || isDispatchDirty || isReceivingDirty;
  React.useEffect(() => {
    onDirtyChange?.(anyInventoryFormDirty);
  }, [anyInventoryFormDirty]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    return () => onDirtyChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Guards a form's own Cancel/Close button — returns false (caller must bail out, not
  // proceed with closing) when the form is dirty and the user chooses not to discard.
  const confirmDiscard = (isDirty: boolean): boolean => {
    if (isDirty && !window.confirm(t('You have unsaved changes. Leave without saving?'))) return false;
    return true;
  };

  // Automatically update activeSubTab if defaultTab changes
  React.useEffect(() => {
    setActiveSubTab(defaultTab);
  }, [defaultTab]);

  // Sync logged-in user to form states
  React.useEffect(() => {
    if (currentUser?.username) {
      setPrForm(prev => ({ ...prev, requestedBy: currentUser.username }));
      setGrnForm(prev => ({ ...prev, receivedBy: currentUser.username }));
      setDispatchForm(prev => ({ ...prev, dispatchedBy: currentUser.username }));
      setReceivingForm(prev => ({ ...prev, receivedBy: currentUser.username }));
    }
  }, [currentUser]);

  // Close active forms when companyId changes
  React.useEffect(() => {
    setIsCreatingPr(false);
    setEditingPrId(null);
    setViewingPr(null);
    setIsCreatingPo(false);
    setViewingPo(null);
    setIsCreatingGrn(false);
    setViewingGrn(null);
    setIsCreatingWarehouse(false);
    setIsAdjustingStock(false);
    setIsCreatingBill(false);
    setViewingBill(null);
    setIsPayingBill(null);
    setIsCreatingReturn(false);
    setViewingReturn(null);
    setIsCreatingStockTake(false);
    setViewingStockTake(null);
    setIsCreatingDispatch(false);
    setViewingDispatch(null);
    setViewingReceiving(null);
    setReceivingAgainstDispatch(null);
  }, [companyId]);

  const isFormOrDetailOpen = !!(
    isCreatingPr || viewingPr ||
    isCreatingPo || viewingPo ||
    isCreatingGrn || viewingGrn ||
    isCreatingWarehouse || isAdjustingStock ||
    isCreatingBill || viewingBill || isPayingBill ||
    isCreatingReturn || viewingReturn ||
    isCreatingStockTake || viewingStockTake ||
    isCreatingDispatch || viewingDispatch || viewingReceiving || receivingAgainstDispatch
  );

  // Handle Warehouse Creation — goes through the real backend route (POST /api/warehouses)
  // instead of being pushed straight into local state with zero server persistence.
  const handleCreateWarehouse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!warehouseForm.name || !warehouseForm.code || isSubmittingWarehouse) return;
    setIsSubmittingWarehouse(true);
    try {
      const newWh: Warehouse = {
        id: generateId(),
        name: warehouseForm.name,
        code: warehouseForm.code.toUpperCase(),
        address: warehouseForm.address,
        isActive: true,
        companyId
      };

      const res = await fetch('/api/warehouses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newWh)
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || t('Failed to register warehouse.'));
      }

      onUpdateDbLocal(prev => ({
        ...prev,
        warehouses: [...(prev.warehouses || []), newWh]
      }));

      triggerSuccess(t('Warehouse registered successfully.'));
      // Reset form
      setWarehouseForm({ name: '', code: '', address: '' });
      setIsCreatingWarehouse(false);
    } catch (err: any) {
      triggerError(err?.message || t('Failed to register warehouse.'));
    } finally {
      setIsSubmittingWarehouse(false);
    }
  };

  // Handle PR Item Actions
  const addPrItem = () => {
    if (!newPrItem.productId || newPrItem.quantity <= 0) return;
    setPrForm(prev => ({
      ...prev,
      items: [...prev.items, { ...newPrItem }]
    }));
    setNewPrItem({ productId: '', quantity: 1, purpose: '' });
  };

  const removePrItem = (index: number) => {
    setPrForm(prev => ({
      ...prev,
      items: prev.items.filter((_, i) => i !== index)
    }));
  };

  // Create OR edit a PR — goes through the real backend routes (POST for a new PR, PUT
  // for editing an existing Pending one). PR numbers are generated by a per-company
  // atomic counter (server/lib/documentNumbering.ts's getAndIncrementDocumentNumber),
  // instead of the previous `array.length + 1001` client-side guess, which two concurrent
  // submissions could both compute identically and thus duplicate.
  const handleCreatePr = async (e: React.FormEvent) => {
    e.preventDefault();
    if (prForm.items.length === 0 || isSubmittingPr) return;
    setIsSubmittingPr(true);
    try {
      const isEdit = !!editingPrId;
      const res = await fetch(isEdit ? `/api/inventory/purchase-requisitions/${editingPrId}` : '/api/inventory/purchase-requisitions', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prData: {
            requestedBy: prForm.requestedBy,
            notes: prForm.notes,
            branchId: prForm.branchId || undefined,
            items: prForm.items
          }
        })
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || t('Failed to submit purchase requisition.'));
      }
      const savedPr: PurchaseRequisition = payload.purchaseRequisition;

      onUpdateDbLocal(prev => ({
        ...prev,
        purchaseRequisitions: isEdit
          ? (prev.purchaseRequisitions || []).map(pr => pr.id === savedPr.id ? savedPr : pr)
          : [...(prev.purchaseRequisitions || []), savedPr]
      }));

      triggerSuccess(isEdit ? t('Purchase requisition updated successfully.') : t('Purchase requisition submitted successfully.'));
      setPrForm({ requestedBy: currentUser?.username || '', notes: '', branchId: myPrimaryBranchId, items: [] });
      markPrClean({ requestedBy: currentUser?.username || '', notes: '', branchId: myPrimaryBranchId, items: [] });
      setEditingPrId(null);
      setIsCreatingPr(false);
      setViewingPr(null);
    } catch (err: any) {
      triggerError(err?.message || t('Failed to submit purchase requisition.'));
    } finally {
      setIsSubmittingPr(false);
    }
  };

  const handleStartEditPr = (pr: PurchaseRequisition) => {
    setEditingPrId(pr.id);
    setPrForm({
      requestedBy: pr.requestedBy,
      notes: pr.notes || '',
      items: (pr.items || []).map(item => ({ productId: item.productId, quantity: Number(item.quantity), purpose: item.purpose || '' }))
    });
    setViewingPr(null);
    setIsCreatingPr(true);
  };

  const handleCancelPr = () => {
    if (!confirmDiscard(isPrDirty)) return;
    setIsCreatingPr(false);
    setEditingPrId(null);
    setPrForm({ requestedBy: currentUser?.username || '', notes: '', branchId: myPrimaryBranchId, items: [] });
  };

  // Withdraw a Pending PR — the submitter's own action (inventory.pr), separate from the
  // approve/reject flow below which requires inventory.approve.
  const handleWithdrawPr = async (prId: string) => {
    if (!window.confirm(t('Withdraw this purchase requisition? This cannot be undone.'))) return;
    try {
      const res = await fetch(`/api/inventory/purchase-requisitions/${prId}/withdraw`, { method: 'PATCH' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || t('Failed to withdraw purchase requisition.'));
      }
      const updatedPr: PurchaseRequisition = payload.purchaseRequisition;
      onUpdateDbLocal(prev => ({
        ...prev,
        purchaseRequisitions: (prev.purchaseRequisitions || []).map(pr => pr.id === updatedPr.id ? { ...pr, ...updatedPr } : pr)
      }));
      triggerSuccess(t('Purchase requisition withdrawn.'));
      setViewingPr(null);
    } catch (err: any) {
      triggerError(err?.message || t('Failed to withdraw purchase requisition.'));
    }
  };

  // Approve / Reject PR (For Admins / Supervisors) — goes through the real backend route
  // (PATCH /api/inventory/purchase-requisitions/:id/status) instead of a local-only status
  // flip that never reached the server.
  const handlePrStatus = async (prId: string, status: 'Approved' | 'Rejected') => {
    try {
      const res = await fetch(`/api/inventory/purchase-requisitions/${prId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || t('Failed to update requisition status.'));
      }

      onUpdateDbLocal(prev => ({
        ...prev,
        purchaseRequisitions: (prev.purchaseRequisitions || []).map(pr =>
          pr.id === prId ? { ...pr, status } : pr
        )
      }));
      setViewingPr(null);
    } catch (err: any) {
      triggerError(err?.message || t('Failed to update requisition status.'));
    }
  };

  // Handle PO Item Actions
  const addPoItem = () => {
    if (!newPoItem.productId || newPoItem.quantityOrdered <= 0) return;
    setPoForm(prev => ({
      ...prev,
      items: [...prev.items, { ...newPoItem }]
    }));
    setNewPoItem({ productId: '', quantityOrdered: 1, unitPrice: 0, taxRate: defaultTaxRate, unitOfMeasureId: '' });
  };

  const removePoItem = (index: number) => {
    setPoForm(prev => ({
      ...prev,
      items: prev.items.filter((_, i) => i !== index)
    }));
  };

  // Handle PR Selection in PO Form
  const handlePoPrSelect = (prId: string) => {
    const selectedPr = purchaseRequisitions.find(pr => pr.id === prId);
    if (!selectedPr) return;

    const poItems = (selectedPr.items || []).map(item => {
      const prod = products.find(p => p.id === item.productId);
      return {
        productId: item.productId,
        quantityOrdered: item.quantity,
        unitPrice: Number(prod?.costPrice ?? prod?.unitPrice ?? 0),
        taxRate: defaultTaxRate
      };
    });

    setPoForm(prev => ({
      ...prev,
      requisitionId: prId,
      items: poItems
    }));
  };

  // Create PO — goes through a real backend route (POST /api/inventory/purchase-orders)
  // whose PO number is generated by the same per-company atomic counter as PR/invoice/
  // quotation numbering, instead of the previous `array.length + 1001` client guess.
  const handleCreatePo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!poForm.vendorId || poForm.items.length === 0 || isSubmittingPo) return;
    setIsSubmittingPo(true);
    try {
      const res = await fetch('/api/inventory/purchase-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          poData: {
            vendorId: poForm.vendorId,
            requisitionId: poForm.requisitionId || undefined,
            deliveryDate: poForm.deliveryDate || undefined,
            notes: poForm.notes,
            branchId: poForm.branchId || undefined,
            items: poForm.items
          }
        })
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || t('Failed to issue purchase order.'));
      }
      const newPo: PurchaseOrder = payload.purchaseOrder;

      onUpdateDbLocal(prev => ({
        ...prev,
        purchaseOrders: [...(prev.purchaseOrders || []), newPo],
        purchaseRequisitions: poForm.requisitionId
          ? (prev.purchaseRequisitions || []).map(pr =>
              pr.id === poForm.requisitionId ? { ...pr, status: 'Closed' as const } : pr
            )
          : prev.purchaseRequisitions
      }));

      triggerSuccess(t('Purchase order issued successfully.'));
      setPoForm({ vendorId: '', requisitionId: '', deliveryDate: '', notes: '', branchId: myPrimaryBranchId, items: [] });
      markPoClean({ vendorId: '', requisitionId: '', deliveryDate: '', notes: '', branchId: myPrimaryBranchId, items: [] });
      setIsCreatingPo(false);
    } catch (err: any) {
      triggerError(err?.message || t('Failed to issue purchase order.'));
    } finally {
      setIsSubmittingPo(false);
    }
  };

  const handleCancelPoForm = () => {
    if (!confirmDiscard(isPoDirty)) return;
    setIsCreatingPo(false);
  };

  // Cancel PO — goes through the real backend route (PATCH
  // /api/inventory/purchase-orders/:id/cancel) instead of a local-only status flip that
  // never reached the server.
  const handleCancelPo = async (poId: string) => {
    try {
      const res = await fetch(`/api/inventory/purchase-orders/${poId}/cancel`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' }
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || t('Failed to cancel purchase order.'));
      }

      onUpdateDbLocal(prev => ({
        ...prev,
        purchaseOrders: (prev.purchaseOrders || []).map(po =>
          po.id === poId ? { ...po, status: 'Cancelled' as const } : po
        )
      }));
      setViewingPo(null);
    } catch (err: any) {
      triggerError(err?.message || t('Failed to cancel purchase order.'));
    }
  };

  // Handle GRN Item Actions
  const addGrnItem = () => {
    if (!newGrnItem.productId || newGrnItem.quantityReceived <= 0) return;
    setGrnForm(prev => ({
      ...prev,
      items: [...prev.items, { ...newGrnItem }]
    }));
    setNewGrnItem({ productId: '', quantityReceived: 1, unitCost: 0, taxRate: defaultTaxRate, batchNumber: '', expiryDate: '', unitOfMeasureId: '' });
  };

  const removeGrnItem = (index: number) => {
    setGrnForm(prev => ({
      ...prev,
      items: prev.items.filter((_, i) => i !== index)
    }));
  };

  // Handle PO Selection in GRN — a Purchase Order that is already "Partially Received"
  // must remain selectable so the remaining balance can still be received (otherwise the
  // partial-receipt workflow has no way to ever finish). Quantities are prefilled with
  // only the outstanding (ordered minus already-received) balance per product, so
  // re-selecting a partially received PO doesn't offer to re-receive what's already in.
  const handleGrnPoSelect = (poId: string) => {
    const selectedPo = purchaseOrders.find(po => po.id === poId);
    if (!selectedPo) return;

    const alreadyReceivedByProduct = new Map<string, number>();
    goodsReceiptNotes
      .filter(grn => grn.purchaseOrderId === poId)
      .forEach(grn => {
        (grn.items || []).forEach(item => {
          alreadyReceivedByProduct.set(
            item.productId,
            (alreadyReceivedByProduct.get(item.productId) || 0) + Number(item.quantityReceived)
          );
        });
      });

    const grnItems = (selectedPo.items || [])
      .map(item => {
        const alreadyReceived = alreadyReceivedByProduct.get(item.productId) || 0;
        const remaining = Number(item.quantityOrdered) - alreadyReceived;
        return {
          productId: item.productId,
          quantityReceived: remaining,
          unitCost: item.unitPrice,
          taxRate: item.taxRate || 0,
          batchNumber: '',
          expiryDate: ''
        };
      })
      .filter(item => item.quantityReceived > 0);

    setGrnForm(prev => ({
      ...prev,
      purchaseOrderId: poId,
      vendorId: selectedPo.vendorId,
      isDsd: false,
      items: grnItems
    }));
  };

  // Create GRN & Update Stock Levels — goes through a real backend route (POST
  // /api/inventory/goods-receipt-notes) so the GRN number uses the same atomic
  // per-company counter as PR/PO/invoice numbering, and so the linked PO's fulfillment
  // status is derived server-side from actual received-vs-ordered quantities (summed
  // across every GRN raised against it) instead of being unconditionally marked
  // "Received" the instant any GRN references it.
  const handleCreateGrn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!grnForm.warehouseId || grnForm.items.length === 0 || isSubmittingGrn) return;
    setIsSubmittingGrn(true);
    try {
      const res = await fetch('/api/inventory/goods-receipt-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grnData: {
            purchaseOrderId: grnForm.isDsd ? undefined : (grnForm.purchaseOrderId || undefined),
            vendorId: grnForm.vendorId,
            warehouseId: grnForm.warehouseId,
            isDsd: grnForm.isDsd,
            receivedBy: grnForm.receivedBy,
            notes: grnForm.notes,
            items: grnForm.items
          }
        })
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || t('Failed to record goods receipt.'));
      }

      // vehicleNumber/driverName are not columns on the goods_receipt_notes table
      // (pre-existing schema limitation, unrelated to this fix) so they're kept
      // client-side only, same as before this change.
      const newGrn: GoodsReceiptNote = {
        ...payload.goodsReceiptNote,
        vehicleNumber: grnForm.vehicleNumber || undefined,
        driverName: grnForm.driverName || undefined
      };
      const updatedPo: { id: string; status: PurchaseOrder['status'] } | null = payload.updatedPurchaseOrder;

      onUpdateDbLocal(prev => {
        const currentStocks = [...(prev.inventoryStocks || [])];
        (newGrn.items || []).forEach(item => {
          const match = currentStocks.find(s =>
            s.productId === item.productId &&
            s.warehouseId === newGrn.warehouseId &&
            s.batchNumber === (item.batchNumber || undefined) &&
            s.companyId === companyId
          );

          if (match) {
            match.quantity = Number(match.quantity) + Number(item.quantityReceived);
          } else {
            currentStocks.push({
              id: generateId(),
              productId: item.productId,
              warehouseId: newGrn.warehouseId,
              batchNumber: item.batchNumber || undefined,
              expiryDate: item.expiryDate || undefined,
              quantity: item.quantityReceived,
              companyId
            });
          }
        });

        return {
          ...prev,
          goodsReceiptNotes: [...(prev.goodsReceiptNotes || []), newGrn],
          inventoryStocks: currentStocks,
          purchaseOrders: updatedPo
            ? (prev.purchaseOrders || []).map(po => po.id === updatedPo.id ? { ...po, status: updatedPo.status } : po)
            : prev.purchaseOrders
        };
      });

      triggerSuccess(t('Goods receipt recorded and stock updated successfully.'));
      setGrnForm({
        purchaseOrderId: '',
        warehouseId: warehouses[0]?.id || '',
        vendorId: '',
        isDsd: false,
        receivedBy: currentUser?.username || '',
        notes: '',
        vehicleNumber: '',
        driverName: '',
        items: []
      });
      markGrnClean({
        purchaseOrderId: '',
        warehouseId: warehouses[0]?.id || '',
        vendorId: '',
        isDsd: false,
        receivedBy: currentUser?.username || '',
        notes: '',
        vehicleNumber: '',
        driverName: '',
        items: []
      });
      setIsCreatingGrn(false);
    } catch (err: any) {
      triggerError(err?.message || t('Failed to record goods receipt.'));
    } finally {
      setIsSubmittingGrn(false);
    }
  };

  const handleCancelGrnForm = () => {
    if (!confirmDiscard(isGrnDirty)) return;
    setIsCreatingGrn(false);
  };

  // Reverse a GRN — correction path for a wrong-quantity/wrong-batch receipt. Reverts the
  // stock movement and the linked PO's fulfillment status server-side; refreshes local
  // stock/PO state to match rather than trying to re-derive the reversal client-side.
  const handleReverseGrn = async (grnId: string) => {
    if (!window.confirm(t('Reverse this goods receipt? This will roll back the stock it added and cannot be undone.'))) return;
    try {
      const res = await fetch(`/api/inventory/goods-receipt-notes/${grnId}/reverse`, { method: 'POST' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || t('Failed to reverse goods receipt.'));
      }
      const updatedPo: { id: string; status: PurchaseOrder['status'] } | null = payload.updatedPurchaseOrder;
      onUpdateDbLocal(prev => ({
        ...prev,
        goodsReceiptNotes: (prev.goodsReceiptNotes || []).map(g => g.id === grnId ? { ...g, isReversed: true } : g),
        purchaseOrders: updatedPo
          ? (prev.purchaseOrders || []).map(po => po.id === updatedPo.id ? { ...po, status: updatedPo.status } : po)
          : prev.purchaseOrders
      }));
      // The GRN/PO status flip above is instant; the actual stock quantity this reversal
      // rolled back is only known server-side, so refresh to pick it up rather than
      // leaving the on-hand figure stale until an unrelated later reload.
      if (onRefreshDb) await onRefreshDb();
      triggerSuccess(t('Goods receipt reversed successfully.'));
      setViewingGrn(null);
    } catch (err: any) {
      triggerError(err?.message || t('Failed to reverse goods receipt.'));
    }
  };

  const handleAddDispatchItem = () => {
    if (!newDispatchItem.productId || newDispatchItem.quantityDispatched <= 0) return;
    setDispatchForm(prev => ({ ...prev, items: [...prev.items, { ...newDispatchItem }] }));
    setNewDispatchItem({ productId: '', quantityDispatched: 1, batchNumber: '', expiryDate: '', unitOfMeasureId: '' });
    setDispatchBarcodeInput('');
  };

  const handleRemoveDispatchItem = (idx: number) => {
    setDispatchForm(prev => ({ ...prev, items: prev.items.filter((_, i) => i !== idx) }));
  };

  // Create a dispatch — goes through POST /api/inventory/warehouse-dispatches, which
  // deducts source-warehouse stock server-side. Refreshes from the server afterward
  // (like handleReverseGrn above) rather than hand-reconstructing the stock deltas
  // locally — this route doesn't return the precise updated stock rows an optimistic
  // merge would need, and the on-hand figures here are exactly the kind of thing worth
  // getting from the source of truth rather than guessing.
  const handleCreateDispatch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dispatchForm.fromWarehouseId || !dispatchForm.toWarehouseId || dispatchForm.items.length === 0 || isSubmittingDispatch) return;
    if (dispatchForm.fromWarehouseId === dispatchForm.toWarehouseId) {
      return triggerError(t('Source and destination warehouse must be different.'));
    }
    setIsSubmittingDispatch(true);
    try {
      const res = await fetch('/api/inventory/warehouse-dispatches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dispatchData: dispatchForm })
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || t('Failed to create dispatch.'));
      }
      onUpdateDbLocal(prev => ({
        ...prev,
        warehouseDispatches: [...(prev.warehouseDispatches || []), payload.dispatch]
      }));
      if (onRefreshDb) await onRefreshDb();
      triggerSuccess(t('Dispatch created and stock deducted from the source warehouse.'));
      setDispatchForm({
        fromWarehouseId: warehouses[0]?.id || '',
        toWarehouseId: '',
        vehicleNumber: '',
        driverName: '',
        driverContact: '',
        expectedArrivalDate: '',
        dispatchedBy: currentUser?.username || '',
        notes: '',
        items: []
      });
      markDispatchClean({
        fromWarehouseId: warehouses[0]?.id || '',
        toWarehouseId: '',
        vehicleNumber: '',
        driverName: '',
        driverContact: '',
        expectedArrivalDate: '',
        dispatchedBy: currentUser?.username || '',
        notes: '',
        items: []
      });
      setIsCreatingDispatch(false);
    } catch (err: any) {
      triggerError(err?.message || t('Failed to create dispatch.'));
    } finally {
      setIsSubmittingDispatch(false);
    }
  };

  const handleCancelDispatchForm = () => {
    if (!confirmDiscard(isDispatchDirty)) return;
    setIsCreatingDispatch(false);
  };

  // Seed the Receiving confirm form from a dispatch's own items — quantityReceived
  // defaults to quantityDispatched per line (the user's explicit "by default received qty
  // is same as dispatched" requirement), independently editable per line below.
  const handleOpenReceiving = (dispatch: WarehouseDispatch) => {
    setReceivingForm({
      receivedBy: currentUser?.username || '',
      condition: '',
      discrepancyNotes: '',
      notes: '',
      items: (dispatch.items || []).map((item: WarehouseDispatchItem) => ({
        dispatchItemId: item.id,
        productId: item.productId,
        quantityDispatched: item.quantityDispatched,
        quantityReceived: item.quantityDispatched,
        batchNumber: item.batchNumber || '',
        unitOfMeasureId: item.unitOfMeasureId || undefined,
      }))
    });
    setReceivingAgainstDispatch(dispatch);
  };

  const handleUpdateReceivingItemQty = (idx: number, quantityReceived: number) => {
    setReceivingForm(prev => {
      const items = [...prev.items];
      items[idx] = { ...items[idx], quantityReceived };
      return { ...prev, items };
    });
  };

  // Confirm receiving against the open dispatch — goes through POST
  // /api/inventory/warehouse-receivings, which adds destination-warehouse stock using the
  // ACTUAL received quantity and flips the dispatch to 'Received' server-side (the
  // atomic check-then-set that prevents double-receiving under concurrency).
  const handleSubmitReceiving = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!receivingAgainstDispatch || receivingForm.items.length === 0 || isSubmittingReceiving) return;
    setIsSubmittingReceiving(true);
    try {
      const res = await fetch('/api/inventory/warehouse-receivings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receivingData: {
            dispatchId: receivingAgainstDispatch.id,
            receivedBy: receivingForm.receivedBy,
            condition: receivingForm.condition || undefined,
            discrepancyNotes: receivingForm.discrepancyNotes || undefined,
            notes: receivingForm.notes || undefined,
            items: receivingForm.items.map(item => ({
              dispatchItemId: item.dispatchItemId,
              quantityReceived: item.quantityReceived,
              batchNumber: item.batchNumber || undefined,
              unitOfMeasureId: item.unitOfMeasureId,
            }))
          }
        })
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || t('Failed to record receiving.'));
      }
      onUpdateDbLocal(prev => ({
        ...prev,
        warehouseReceivings: [...(prev.warehouseReceivings || []), payload.receiving],
        warehouseDispatches: (prev.warehouseDispatches || []).map(d =>
          d.id === receivingAgainstDispatch.id ? { ...d, status: 'Received' as const } : d
        ),
      }));
      if (onRefreshDb) await onRefreshDb();
      triggerSuccess(t('Receiving recorded and stock added to the destination warehouse.'));
      markReceivingClean(receivingForm);
      setReceivingAgainstDispatch(null);
    } catch (err: any) {
      triggerError(err?.message || t('Failed to record receiving.'));
    } finally {
      setIsSubmittingReceiving(false);
    }
  };

  const handleCancelReceivingForm = () => {
    if (!confirmDiscard(isReceivingDirty)) return;
    setReceivingAgainstDispatch(null);
  };

  // Cancel a still-pending (not yet received) dispatch — restores the source warehouse's
  // stock server-side. Only offered in the UI while status === 'Dispatched'.
  const handleCancelDispatch = async (dispatchId: string) => {
    if (!window.confirm(t('Cancel this dispatch? The stock already deducted from the source warehouse will be restored.'))) return;
    setIsCancellingDispatch(true);
    try {
      const res = await fetch(`/api/inventory/warehouse-dispatches/${dispatchId}/cancel`, { method: 'POST' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || t('Failed to cancel dispatch.'));
      }
      onUpdateDbLocal(prev => ({
        ...prev,
        warehouseDispatches: (prev.warehouseDispatches || []).map(d => d.id === dispatchId ? { ...d, status: 'Cancelled' as const } : d)
      }));
      if (onRefreshDb) await onRefreshDb();
      triggerSuccess(t('Dispatch cancelled and stock restored to the source warehouse.'));
      setViewingDispatch(null);
    } catch (err: any) {
      triggerError(err?.message || t('Failed to cancel dispatch.'));
    } finally {
      setIsCancellingDispatch(false);
    }
  };

  // Handle Manual Stock Adjustment — goes through the real backend route (POST
  // /api/inventory/stock-adjustments), which reuses the GRN route's exact
  // lock-then-increment-or-insert math (clamped at 0), instead of mutating local state only.
  const handleStockAdjustment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adjustmentForm.productId || !adjustmentForm.warehouseId || isSubmittingAdjustment) return;
    setIsSubmittingAdjustment(true);
    try {
      const res = await fetch('/api/inventory/stock-adjustments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: adjustmentForm.productId,
          warehouseId: adjustmentForm.warehouseId,
          quantity: adjustmentForm.quantity,
          batchNumber: adjustmentForm.batchNumber || undefined,
          reason: adjustmentForm.reason
        })
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || t('Failed to apply stock adjustment.'));
      }
      const updatedStock: InventoryStock = payload.inventoryStock;

      onUpdateDbLocal(prev => {
        const currentStocks = [...(prev.inventoryStocks || [])];
        const idx = currentStocks.findIndex(s => s.id === updatedStock.id);
        if (idx >= 0) {
          currentStocks[idx] = updatedStock;
        } else {
          currentStocks.push(updatedStock);
        }
        return { ...prev, inventoryStocks: currentStocks };
      });

      triggerSuccess(t('Stock adjustment applied successfully.'));
      setAdjustmentForm({ productId: '', warehouseId: warehouses[0]?.id || '', quantity: 0, batchNumber: '', reason: '' });
      setIsAdjustingStock(false);
    } catch (err: any) {
      triggerError(err?.message || t('Failed to apply stock adjustment.'));
    } finally {
      setIsSubmittingAdjustment(false);
    }
  };

  // GRNs eligible to be billed: not already billed, not reversed, in this company.
  const billableGrns = goodsReceiptNotes.filter(g => !g.isBilled && !g.isReversed);

  const toggleBillGrn = (grnId: string) => {
    setBillForm(prev => ({
      ...prev,
      grnIds: prev.grnIds.includes(grnId) ? prev.grnIds.filter(id => id !== grnId) : [...prev.grnIds, grnId]
    }));
  };

  // Create a Purchase Bill — the 3-way match: totals are computed server-side from the
  // referenced GRN(s), never sent from here.
  const handleCreateBill = async (e: React.FormEvent) => {
    e.preventDefault();
    if (billForm.grnIds.length === 0 || isSubmittingBill) return;
    setIsSubmittingBill(true);
    try {
      const res = await fetch('/api/inventory/purchase-bills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ billData: { grnIds: billForm.grnIds, dueDate: billForm.dueDate || undefined, bankId: billForm.bankId || undefined } })
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || t('Failed to create purchase bill.'));

      const newBill: PurchaseBill = payload.purchaseBill;
      onUpdateDbLocal(prev => ({
        ...prev,
        purchaseBills: [...(prev.purchaseBills || []), newBill],
        goodsReceiptNotes: (prev.goodsReceiptNotes || []).map((g: GoodsReceiptNote) => billForm.grnIds.includes(g.id) ? { ...g, isBilled: true } : g)
      }));
      triggerSuccess(t('Purchase bill created successfully.'));
      setBillForm({ grnIds: [], dueDate: '', bankId: '' });
      markBillClean({ grnIds: [], dueDate: '', bankId: '' });
      setIsCreatingBill(false);
    } catch (err: any) {
      triggerError(err?.message || t('Failed to create purchase bill.'));
    } finally {
      setIsSubmittingBill(false);
    }
  };

  const handleCancelBillForm = () => {
    if (!confirmDiscard(isBillDirty)) return;
    setIsCreatingBill(false);
    setBillForm({ grnIds: [], dueDate: '', bankId: '' });
  };

  const handlePayBill = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isPayingBill || isSubmittingBill) return;
    setIsSubmittingBill(true);
    try {
      const res = await fetch(`/api/inventory/purchase-bills/${isPayingBill.id}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: payBillForm.date, bankId: payBillForm.bankId, amount: payBillForm.amount ? Number(payBillForm.amount) : undefined })
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || t('Failed to record bill payment.'));
      // Mirror the server's own computed amountPaid/status directly — same pattern as
      // every other create/update handler in this file — instead of re-deriving that
      // arithmetic client-side, which could silently drift from the server's actual logic.
      const updatedBill: PurchaseBill = payload.purchaseBill;
      onUpdateDbLocal(prev => ({
        ...prev,
        purchaseBills: (prev.purchaseBills || []).map((b: PurchaseBill) => b.id === updatedBill.id ? updatedBill : b)
      }));
      triggerSuccess(t('Payment recorded successfully.'));
      // Auto-open the printable receipt right away — proof of disbursement on the spot.
      if (payload.voucher && onPrintDoc) {
        const voucherBank = db.banks.find(b => b.id === payload.voucher.bankId);
        onPrintDoc('PaymentReceipt', { ...payload.voucher, bankData: voucherBank });
      }
      setIsPayingBill(null);
      setPayBillForm({ date: '', amount: '', bankId: '' });
      setViewingBill(null);
    } catch (err: any) {
      triggerError(err?.message || t('Failed to record bill payment.'));
    } finally {
      setIsSubmittingBill(false);
    }
  };

  const handleCancelBill = async (bill: PurchaseBill) => {
    if (!window.confirm(t('Cancel this purchase bill? This releases its referenced receipts so they can be re-billed.'))) return;
    try {
      const res = await fetch(`/api/inventory/purchase-bills/${bill.id}/cancel`, { method: 'PATCH' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || t('Failed to cancel purchase bill.'));
      const grnIds = bill.grnIds.split(',').filter(Boolean);
      onUpdateDbLocal(prev => ({
        ...prev,
        purchaseBills: (prev.purchaseBills || []).map((b: PurchaseBill) => b.id === bill.id ? { ...b, status: 'Cancelled' } : b),
        goodsReceiptNotes: (prev.goodsReceiptNotes || []).map((g: GoodsReceiptNote) => grnIds.includes(g.id) ? { ...g, isBilled: false } : g)
      }));
      triggerSuccess(t('Purchase bill cancelled.'));
      setViewingBill(null);
    } catch (err: any) {
      triggerError(err?.message || t('Failed to cancel purchase bill.'));
    }
  };

  // Handle Purchase Return (Debit Note) item actions
  const addReturnItem = () => {
    if (!newReturnItem.productId || newReturnItem.quantityReturned <= 0) return;
    setReturnForm(prev => ({ ...prev, items: [...prev.items, { ...newReturnItem }] }));
    setNewReturnItem({ productId: '', quantityReturned: 1, batchNumber: '', unitOfMeasureId: '' });
  };
  const removeReturnItem = (index: number) => {
    setReturnForm(prev => ({ ...prev, items: prev.items.filter((_, i) => i !== index) }));
  };

  const handleCreateReturn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!returnForm.grnId || returnForm.items.length === 0 || isSubmittingReturn) return;
    setIsSubmittingReturn(true);
    try {
      const res = await fetch('/api/inventory/purchase-returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnData: { grnId: returnForm.grnId, notes: returnForm.notes, items: returnForm.items } })
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || t('Failed to create purchase return.'));

      const newReturn: PurchaseReturn = payload.purchaseReturn;
      onUpdateDbLocal(prev => ({ ...prev, purchaseReturns: [...(prev.purchaseReturns || []), newReturn] }));
      triggerSuccess(t('Purchase return recorded successfully.'));
      setReturnForm({ grnId: '', notes: '', items: [] });
      markReturnClean({ grnId: '', notes: '', items: [] });
      setIsCreatingReturn(false);
    } catch (err: any) {
      triggerError(err?.message || t('Failed to create purchase return.'));
    } finally {
      setIsSubmittingReturn(false);
    }
  };

  const handleCancelReturnForm = () => {
    if (!confirmDiscard(isReturnDirty)) return;
    setIsCreatingReturn(false);
    setReturnForm({ grnId: '', notes: '', items: [] });
  };

  const handleCancelReturn = async (returnId: string) => {
    if (!window.confirm(t('Cancel this purchase return? This will restore the stock it removed.'))) return;
    try {
      const res = await fetch(`/api/inventory/purchase-returns/${returnId}/cancel`, { method: 'PATCH' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || t('Failed to cancel purchase return.'));
      // Status updates immediately; the exact restored stock quantity is only known
      // server-side, so refresh to pick it up rather than leaving the on-hand figure
      // stale until an unrelated later reload.
      onUpdateDbLocal(prev => ({
        ...prev,
        purchaseReturns: (prev.purchaseReturns || []).map((r: PurchaseReturn) => r.id === returnId ? { ...r, status: 'Cancelled' } : r)
      }));
      if (onRefreshDb) await onRefreshDb();
      triggerSuccess(t('Purchase return cancelled.'));
      setViewingReturn(null);
    } catch (err: any) {
      triggerError(err?.message || t('Failed to cancel purchase return.'));
    }
  };

  // Handle Stock Take item actions
  const addStockTakeItem = () => {
    if (!newStockTakeItem.productId) return;
    setStockTakeForm(prev => ({ ...prev, items: [...prev.items, { ...newStockTakeItem }] }));
    setNewStockTakeItem({ productId: '', physicalQuantity: 0, batchNumber: '', unitOfMeasureId: '' });
  };
  const removeStockTakeItem = (index: number) => {
    setStockTakeForm(prev => ({ ...prev, items: prev.items.filter((_, i) => i !== index) }));
  };

  const handleCreateStockTake = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stockTakeForm.warehouseId || stockTakeForm.items.length === 0 || isSubmittingStockTake) return;
    setIsSubmittingStockTake(true);
    try {
      const res = await fetch('/api/inventory/stock-takes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stockTakeData: stockTakeForm })
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || t('Failed to start stock take.'));

      const newStockTake: PhysicalStockTake = payload.stockTake;
      onUpdateDbLocal(prev => ({ ...prev, physicalStockTakes: [...(prev.physicalStockTakes || []), newStockTake] }));
      triggerSuccess(t('Stock take started successfully.'));
      setStockTakeForm({ warehouseId: warehouses[0]?.id || '', performedBy: currentUser?.username || '', notes: '', items: [] });
      markStockTakeClean({ warehouseId: warehouses[0]?.id || '', performedBy: currentUser?.username || '', notes: '', items: [] });
      setIsCreatingStockTake(false);
    } catch (err: any) {
      triggerError(err?.message || t('Failed to start stock take.'));
    } finally {
      setIsSubmittingStockTake(false);
    }
  };

  const handleCancelStockTakeForm = () => {
    if (!confirmDiscard(isStockTakeDirty)) return;
    setIsCreatingStockTake(false);
    setStockTakeForm({ warehouseId: warehouses[0]?.id || '', performedBy: currentUser?.username || '', notes: '', items: [] });
  };

  const handleFinalizeStockTake = async (stockTakeId: string) => {
    if (!window.confirm(t('Finalize this stock take? This will post stock adjustments for every counted line and cannot be undone.'))) return;
    try {
      const res = await fetch(`/api/inventory/stock-takes/${stockTakeId}/finalize`, { method: 'POST' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || t('Failed to finalize stock take.'));
      // Status updates immediately; the exact posted stock quantities are only known
      // server-side, so refresh to pick them up rather than leaving the on-hand figures
      // stale until an unrelated later reload.
      onUpdateDbLocal(prev => ({
        ...prev,
        physicalStockTakes: (prev.physicalStockTakes || []).map((s: PhysicalStockTake) => s.id === stockTakeId ? { ...s, status: 'Completed' } : s)
      }));
      if (onRefreshDb) await onRefreshDb();
      triggerSuccess(t('Stock take finalized and adjustments posted.'));
      setViewingStockTake(null);
    } catch (err: any) {
      triggerError(err?.message || t('Failed to finalize stock take.'));
    }
  };

  const handleCancelStockTake = async (stockTakeId: string) => {
    if (!window.confirm(t('Cancel this stock take? This count will be discarded.'))) return;
    try {
      const res = await fetch(`/api/inventory/stock-takes/${stockTakeId}/cancel`, { method: 'PATCH' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || t('Failed to cancel stock take.'));
      onUpdateDbLocal(prev => ({
        ...prev,
        physicalStockTakes: (prev.physicalStockTakes || []).map((s: PhysicalStockTake) => s.id === stockTakeId ? { ...s, status: 'Cancelled' } : s)
      }));
      triggerSuccess(t('Stock take cancelled.'));
      setViewingStockTake(null);
    } catch (err: any) {
      triggerError(err?.message || t('Failed to cancel stock take.'));
    }
  };

  return (
    <div className="space-y-6" id="inventory-module-container">
      {/* Inline success/error banners — matches InvoiceModule.tsx's triggerError/triggerSuccess pattern */}
      {error && (
        <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-lg text-rose-700 text-sm font-medium flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}
      {success && (
        <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-700 text-sm font-medium flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          {success}
        </div>
      )}
      {/* MODULE HEADER */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-gray-100 pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 flex items-center gap-2">
            {activeSubTab === 'stock' && <Boxes className="h-7 w-7 text-indigo-600" />}
            {activeSubTab === 'pr' && <FileText className="h-7 w-7 text-indigo-600" />}
            {activeSubTab === 'po' && <ClipboardCheck className="h-7 w-7 text-indigo-600" />}
            {activeSubTab === 'grn' && <PackageCheck className="h-7 w-7 text-indigo-600" />}
            {activeSubTab === 'warehouses' && <Building2 className="h-7 w-7 text-indigo-600" />}
            {activeSubTab === 'bills' && <Receipt className="h-7 w-7 text-indigo-600" />}
            {activeSubTab === 'returns' && <Undo2 className="h-7 w-7 text-indigo-600" />}
            {activeSubTab === 'stocktakes' && <ClipboardList className="h-7 w-7 text-indigo-600" />}
            {activeSubTab === 'dispatch' && <Truck className="h-7 w-7 text-indigo-600" />}
            {activeSubTab === 'receiving' && <PackageOpen className="h-7 w-7 text-indigo-600" />}
            {activeSubTab === 'stock' && t('Stock Registry')}
            {activeSubTab === 'pr' && t('Purchase Requisitions')}
            {activeSubTab === 'po' && t('Purchase Orders')}
            {activeSubTab === 'grn' && t('Goods Receipt (GRN)')}
            {activeSubTab === 'warehouses' && t('Physical Warehouses')}
            {activeSubTab === 'bills' && t('Purchase Bills')}
            {activeSubTab === 'returns' && t('Purchase Returns')}
            {activeSubTab === 'stocktakes' && t('Physical Stock Takes')}
            {activeSubTab === 'dispatch' && t('Warehouse Dispatch')}
            {activeSubTab === 'receiving' && t('Warehouse Receiving')}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {activeSubTab === 'stock' && t('Monitor physical inventory levels, serial numbers, batches, and locations in real-time.')}
            {activeSubTab === 'pr' && t('Submit and manage request forms for material procurement, and track approval workflows.')}
            {activeSubTab === 'po' && t('Issue official commercial documents to external vendors for materials and service procurements.')}
            {activeSubTab === 'grn' && t('Record receipts of ordered goods at warehouse docks, check counts, and automatically update stocks.')}
            {activeSubTab === 'warehouses' && t('Setup and govern multiple physical storage locations, distribution centers, and shop floors.')}
            {activeSubTab === 'bills' && t('Record vendor invoices against received goods — totals are always computed from the linked receipt, never entered by hand.')}
            {activeSubTab === 'returns' && t('Send goods back to a vendor against a prior receipt and record the resulting debit note.')}
            {activeSubTab === 'stocktakes' && t('Count physical stock and reconcile it against system quantities.')}
            {activeSubTab === 'dispatch' && t('Send stock from one warehouse to another — stock leaves the source warehouse immediately and stays in transit until received.')}
            {activeSubTab === 'receiving' && t('Confirm what actually arrived against a pending dispatch — quantities default to what was dispatched but can be adjusted.')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!isFormOrDetailOpen && (
            <>
              {activeSubTab === 'stock' && can('inventory.stock') && (
                <button
                  onClick={() => setIsAdjustingStock(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-50 text-indigo-700 font-medium rounded-lg hover:bg-indigo-100 text-sm transition"
                >
                  <TrendingUp className="h-4 w-4" />
                  {t('Adjust Stock')}
                </button>
              )}
              {activeSubTab === 'pr' && can('inventory.pr') && (
                <button
                  onClick={() => { setPrForm(prev => ({ ...prev, branchId: myPrimaryBranchId })); setIsCreatingPr(true); }}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 text-sm shadow-sm transition"
                >
                  <Plus className="h-4 w-4" />
                  {t('New Requisition')}
                </button>
              )}
              {activeSubTab === 'po' && can('inventory.po') && (
                <button
                  onClick={() => { setPoForm(prev => ({ ...prev, branchId: myPrimaryBranchId })); setIsCreatingPo(true); }}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 text-sm shadow-sm transition"
                >
                  <Plus className="h-4 w-4" />
                  {t('New Purchase Order')}
                </button>
              )}
              {activeSubTab === 'grn' && can('inventory.grn') && (
                <button
                  onClick={() => setIsCreatingGrn(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 text-sm shadow-sm transition"
                >
                  <Plus className="h-4 w-4" />
                  {t('Receive Goods (GRN)')}
                </button>
              )}
              {activeSubTab === 'warehouses' && currentUser.role === 'admin' && (
                <button
                  onClick={() => setIsCreatingWarehouse(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 text-sm shadow-sm transition"
                >
                  <Plus className="h-4 w-4" />
                  {t('Create Warehouse')}
                </button>
              )}
              {activeSubTab === 'bills' && can('purchaseBills.create') && (
                <button
                  onClick={() => setIsCreatingBill(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 text-sm shadow-sm transition"
                >
                  <Plus className="h-4 w-4" />
                  {t('New Purchase Bill')}
                </button>
              )}
              {activeSubTab === 'returns' && can('purchaseReturns.create') && (
                <button
                  onClick={() => setIsCreatingReturn(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 text-sm shadow-sm transition"
                >
                  <Plus className="h-4 w-4" />
                  {t('New Purchase Return')}
                </button>
              )}
              {activeSubTab === 'stocktakes' && can('stockTakes.create') && (
                <button
                  onClick={() => setIsCreatingStockTake(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 text-sm shadow-sm transition"
                >
                  <Plus className="h-4 w-4" />
                  {t('New Stock Take')}
                </button>
              )}
              {activeSubTab === 'dispatch' && can('warehouseDispatches.create') && (
                <button
                  onClick={() => { setDispatchForm(prev => ({ ...prev, fromWarehouseId: warehouses[0]?.id || '', toWarehouseId: '', items: [] })); setIsCreatingDispatch(true); }}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 text-sm shadow-sm transition"
                >
                  <Plus className="h-4 w-4" />
                  {t('New Dispatch')}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Tabs Navigation is removed as each sub-tab is an isolated workspace managed via sidebar */}

      {/* SEARCH AND FILTERS ROW */}
      {!isFormOrDetailOpen && (
        <div className="flex flex-col sm:flex-row gap-4 items-center justify-between bg-white p-4 rounded-xl border border-gray-100 shadow-xs">
          <div className="relative w-full sm:max-w-xs">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder={t('Search item or code...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2 border border-gray-200 rounded-lg text-sm bg-gray-50/30 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            />
          </div>

          {activeSubTab === 'stock' && (
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <span className="text-xs font-medium text-gray-500">{t('Warehouse:')}</span>
              <select
                value={warehouseFilter}
                onChange={(e) => setWarehouseFilter(e.target.value)}
                className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="all">{t('All Locations')}</option>
                {warehouses.map(wh => (
                  <option key={wh.id} value={wh.id}>{wh.name} ({wh.code})</option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {/* TAB CONTENT RENDERING */}

      {/* SUB-TAB 1: STOCK REGISTRY */}
      {activeSubTab === 'stock' && !isFormOrDetailOpen && (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100">
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Product / Material')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('SKU')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Location / Warehouse')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Batch Number')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Expiry Date')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider text-right">{t('On Hand Quantity')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {inventoryStocks
                  .filter(stock => {
                    const prod = products.find(p => p.id === stock.productId);
                    const wh = warehouses.find(w => w.id === stock.warehouseId);
                    const matchesSearch = prod?.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                                          prod?.sku?.toLowerCase().includes(searchQuery.toLowerCase());
                    const matchesWarehouse = warehouseFilter === 'all' || stock.warehouseId === warehouseFilter;
                    return matchesSearch && matchesWarehouse;
                  })
                  .map(stock => {
                    const prod = products.find(p => p.id === stock.productId);
                    const wh = warehouses.find(w => w.id === stock.warehouseId);
                    return (
                      <tr key={stock.id} className="hover:bg-gray-50/50 transition">
                        <td className="px-6 py-4">
                          <div className="font-semibold text-gray-900">{prod?.name || t('Unknown Product')}</div>
                          <div className="text-xs text-gray-500 mt-0.5">{prod?.description || ''}</div>
                        </td>
                        <td className="px-6 py-4 text-sm font-mono text-gray-600">{prod?.sku || 'N/A'}</td>
                        <td className="px-6 py-4">
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-gray-100 text-gray-800">
                            <Building2 className="h-3 w-3" />
                            {wh?.name || t('Unknown Warehouse')}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">{stock.batchNumber || '-'}</td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {stock.expiryDate ? new Date(stock.expiryDate).toLocaleDateString() : '-'}
                        </td>
                        <td className="px-6 py-4 text-right">
                          <span className={`text-base font-bold ${Number(stock.quantity) <= 5 ? 'text-rose-600' : 'text-emerald-600'}`}>
                            {stock.quantity}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                {inventoryStocks.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-gray-500">
                      <div className="flex flex-col items-center gap-2">
                        <Boxes className="h-10 w-10 text-gray-300" />
                        <p className="text-sm font-medium">{t('No stock balances logged yet.')}</p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUB-TAB 2: PURCHASE REQUISITIONS */}
      {activeSubTab === 'pr' && !isFormOrDetailOpen && (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100">
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('PR Number')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Requested By')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Date Requested')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Items Count')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Status')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider text-right">{t('Actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {purchaseRequisitions
                  .filter(pr => pr.prNumber.toLowerCase().includes(searchQuery.toLowerCase()))
                  .map(pr => (
                    <tr key={pr.id} className="hover:bg-gray-50/50 transition">
                      <td className="px-6 py-4 font-semibold text-indigo-700">{pr.prNumber}</td>
                      <td className="px-6 py-4 text-sm text-gray-800">{pr.requestedBy}</td>
                      <td className="px-6 py-4 text-sm text-gray-500">{new Date(pr.date).toLocaleDateString()}</td>
                      <td className="px-6 py-4 text-sm text-gray-600">{(pr.items || []).length}</td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium ${
                          pr.status === 'Approved' ? 'bg-emerald-50 text-emerald-700' :
                          pr.status === 'Pending' ? 'bg-amber-50 text-amber-700' :
                          (pr.status === 'Closed' || pr.status === 'Cancelled') ? 'bg-gray-100 text-gray-700' :
                          'bg-rose-50 text-rose-700'
                        }`}>
                          {t(pr.status)}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <button
                          onClick={() => setViewingPr(pr)}
                          className="p-1 text-gray-400 hover:text-indigo-600 transition"
                        >
                          <Eye className="h-5 w-5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                {purchaseRequisitions.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-gray-500">
                      <div className="flex flex-col items-center gap-2">
                        <FileText className="h-10 w-10 text-gray-300" />
                        <p className="text-sm font-medium">{t('No purchase requisitions created yet.')}</p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUB-TAB 3: PURCHASE ORDERS */}
      {activeSubTab === 'po' && !isFormOrDetailOpen && (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100">
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('PO Number')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Vendor')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Date Created')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Total Amount')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Status')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider text-right">{t('Actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {purchaseOrders
                  .filter(po => po.poNumber.toLowerCase().includes(searchQuery.toLowerCase()))
                  .map(po => {
                    const vend = vendors.find(v => v.id === po.vendorId);
                    return (
                      <tr key={po.id} className="hover:bg-gray-50/50 transition">
                        <td className="px-6 py-4 font-semibold text-indigo-700">{po.poNumber}</td>
                        <td className="px-6 py-4 text-sm text-gray-800">{vend?.name || t('Unknown Vendor')}</td>
                        <td className="px-6 py-4 text-sm text-gray-500">{new Date(po.date).toLocaleDateString()}</td>
                        <td className="px-6 py-4 text-sm font-semibold text-gray-900">
                          {Number(po.totalAmount).toFixed(2)} {currency}
                        </td>
                        <td className="px-6 py-4">
                          <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium ${
                            po.status === 'Received' ? 'bg-emerald-50 text-emerald-700' :
                            po.status === 'Partially Received' ? 'bg-amber-50 text-amber-700' :
                            po.status === 'Sent' ? 'bg-indigo-50 text-indigo-700' :
                            'bg-gray-100 text-gray-700'
                          }`}>
                            {t(po.status)}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <button
                            onClick={() => setViewingPo(po)}
                            className="p-1 text-gray-400 hover:text-indigo-600 transition"
                          >
                            <Eye className="h-5 w-5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                {purchaseOrders.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-gray-500">
                      <div className="flex flex-col items-center gap-2">
                        <ClipboardCheck className="h-10 w-10 text-gray-300" />
                        <p className="text-sm font-medium">{t('No purchase orders raised yet.')}</p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUB-TAB 4: GOODS RECEIPTS (GRN) */}
      {activeSubTab === 'grn' && !isFormOrDetailOpen && (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100">
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('GRN Number')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Vendor')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Receiving Warehouse')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Vehicle / Driver')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Date Received')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Received By')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider text-right">{t('Actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {goodsReceiptNotes
                  .filter(grn => grn.grnNumber.toLowerCase().includes(searchQuery.toLowerCase()))
                  .map(grn => {
                    const vend = vendors.find(v => v.id === grn.vendorId);
                    const wh = warehouses.find(w => w.id === grn.warehouseId);
                    return (
                      <tr key={grn.id} className="hover:bg-gray-50/50 transition">
                        <td className="px-6 py-4 font-semibold text-indigo-700">{grn.grnNumber}</td>
                        <td className="px-6 py-4 text-sm text-gray-800">{vend?.name || t('Unknown Vendor')}</td>
                        <td className="px-6 py-4 text-sm text-gray-600">{wh?.name || t('Unknown Warehouse')}</td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {grn.vehicleNumber || grn.driverName ? (
                            <div>
                              <div className="font-semibold text-gray-900">{grn.vehicleNumber || '-'}</div>
                              <div className="text-xs text-gray-500">{grn.driverName || '-'}</div>
                            </div>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-500">{new Date(grn.date).toLocaleDateString()}</td>
                        <td className="px-6 py-4 text-sm text-gray-700">{grn.receivedBy}</td>
                        <td className="px-6 py-4 text-right">
                          <button
                            onClick={() => setViewingGrn(grn)}
                            className="p-1 text-gray-400 hover:text-indigo-600 transition"
                          >
                            <Eye className="h-5 w-5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                {goodsReceiptNotes.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
                      <div className="flex flex-col items-center gap-2">
                        <PackageCheck className="h-10 w-10 text-gray-300" />
                        <p className="text-sm font-medium">{t('No goods receipt notes logged yet.')}</p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUB-TAB 5: WAREHOUSES */}
      {activeSubTab === 'warehouses' && !isFormOrDetailOpen && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {warehouses.map(wh => {
            const whStocks = inventoryStocks.filter(s => s.warehouseId === wh.id);
            const totalItems = whStocks.reduce((sum, s) => sum + Number(s.quantity), 0);
            return (
              <div key={wh.id} className="bg-white p-6 rounded-xl border border-gray-200 shadow-xs hover:shadow-md transition duration-200">
                <div className="flex justify-between items-start">
                  <div className="p-2.5 bg-indigo-50 rounded-lg text-indigo-600">
                    <Building2 className="h-6 w-6" />
                  </div>
                  <span className="text-xs font-mono font-bold text-gray-400 px-2 py-1 bg-gray-50 rounded border border-gray-100">
                    {wh.code}
                  </span>
                </div>
                <h3 className="text-lg font-bold text-gray-900 mt-4">{wh.name}</h3>
                <p className="text-sm text-gray-500 mt-1">{wh.address || t('No address registered')}</p>
                <div className="mt-5 pt-4 border-t border-gray-100 flex justify-between text-sm">
                  <span className="text-gray-500">{t('Stock Positions:')}</span>
                  <span className="font-semibold text-gray-950">{whStocks.length}</span>
                </div>
                <div className="mt-2 flex justify-between text-sm">
                  <span className="text-gray-500">{t('Total Units:')}</span>
                  <span className="font-bold text-indigo-700">{totalItems}</span>
                </div>
              </div>
            );
          })}
          {warehouses.length === 0 && (
            <div className="col-span-full py-12 text-center text-gray-500">
              <Building2 className="h-12 w-12 mx-auto text-gray-300" />
              <p className="mt-2 text-sm font-medium">{t('No active warehouses registered.')}</p>
            </div>
          )}
        </div>
      )}

      {/* SUB-TAB: PURCHASE BILLS */}
      {activeSubTab === 'bills' && !isFormOrDetailOpen && (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100">
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Bill Number')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Vendor')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Grand Total')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Paid')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Status')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider text-right">{t('Actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {purchaseBills
                  .filter(b => b.billNumber.toLowerCase().includes(searchQuery.toLowerCase()))
                  .map(b => {
                    const vend = vendors.find(v => v.id === b.vendorId);
                    return (
                      <tr key={b.id} className="hover:bg-gray-50/50 transition">
                        <td className="px-6 py-4 font-semibold text-indigo-700">{b.billNumber}</td>
                        <td className="px-6 py-4 text-sm text-gray-800">{vend?.name || t('Unknown Vendor')}</td>
                        <td className="px-6 py-4 text-sm font-semibold text-gray-900">{b.grandTotal.toFixed(2)} {currency}</td>
                        <td className="px-6 py-4 text-sm text-gray-600">{b.amountPaid.toFixed(2)} {currency}</td>
                        <td className="px-6 py-4">
                          <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium ${
                            b.status === 'Paid' ? 'bg-emerald-50 text-emerald-700' :
                            b.status === 'Partially Paid' ? 'bg-amber-50 text-amber-700' :
                            b.status === 'Cancelled' ? 'bg-gray-100 text-gray-500' :
                            'bg-indigo-50 text-indigo-700'
                          }`}>
                            {t(b.status)}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <button onClick={() => setViewingBill(b)} className="p-1 text-gray-400 hover:text-indigo-600 transition">
                            <Eye className="h-5 w-5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                {purchaseBills.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-gray-500">
                      <div className="flex flex-col items-center gap-2">
                        <Receipt className="h-10 w-10 text-gray-300" />
                        <p className="text-sm font-medium">{t('No purchase bills recorded yet.')}</p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUB-TAB: PURCHASE RETURNS (DEBIT NOTES) */}
      {activeSubTab === 'returns' && !isFormOrDetailOpen && (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100">
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Return Number')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Vendor')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Linked GRN')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Date')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Status')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider text-right">{t('Actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {purchaseReturns
                  .filter(r => r.returnNumber.toLowerCase().includes(searchQuery.toLowerCase()))
                  .map(r => {
                    const vend = vendors.find(v => v.id === r.vendorId);
                    const grn = goodsReceiptNotes.find(g => g.id === r.grnId);
                    return (
                      <tr key={r.id} className="hover:bg-gray-50/50 transition">
                        <td className="px-6 py-4 font-semibold text-indigo-700">{r.returnNumber}</td>
                        <td className="px-6 py-4 text-sm text-gray-800">{vend?.name || t('Unknown Vendor')}</td>
                        <td className="px-6 py-4 text-sm text-gray-600">{grn?.grnNumber || '-'}</td>
                        <td className="px-6 py-4 text-sm text-gray-500">{new Date(r.date).toLocaleDateString()}</td>
                        <td className="px-6 py-4">
                          <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium ${
                            r.status === 'Active' ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'
                          }`}>
                            {t(r.status)}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <button onClick={() => setViewingReturn(r)} className="p-1 text-gray-400 hover:text-indigo-600 transition">
                            <Eye className="h-5 w-5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                {purchaseReturns.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-gray-500">
                      <div className="flex flex-col items-center gap-2">
                        <Undo2 className="h-10 w-10 text-gray-300" />
                        <p className="text-sm font-medium">{t('No purchase returns recorded yet.')}</p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUB-TAB: PHYSICAL STOCK TAKES */}
      {activeSubTab === 'stocktakes' && !isFormOrDetailOpen && (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100">
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Reference')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Warehouse')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Performed By')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Date')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Status')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider text-right">{t('Actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {physicalStockTakes
                  .filter(s => s.referenceNumber.toLowerCase().includes(searchQuery.toLowerCase()))
                  .map(s => {
                    const wh = warehouses.find(w => w.id === s.warehouseId);
                    return (
                      <tr key={s.id} className="hover:bg-gray-50/50 transition">
                        <td className="px-6 py-4 font-semibold text-indigo-700">{s.referenceNumber}</td>
                        <td className="px-6 py-4 text-sm text-gray-800">{wh?.name || t('Unknown Warehouse')}</td>
                        <td className="px-6 py-4 text-sm text-gray-600">{s.performedBy}</td>
                        <td className="px-6 py-4 text-sm text-gray-500">{new Date(s.date).toLocaleDateString()}</td>
                        <td className="px-6 py-4">
                          <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium ${
                            s.status === 'Completed' ? 'bg-emerald-50 text-emerald-700' :
                            s.status === 'Cancelled' ? 'bg-gray-100 text-gray-500' :
                            'bg-amber-50 text-amber-700'
                          }`}>
                            {t(s.status)}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <button onClick={() => setViewingStockTake(s)} className="p-1 text-gray-400 hover:text-indigo-600 transition">
                            <Eye className="h-5 w-5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                {physicalStockTakes.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-gray-500">
                      <div className="flex flex-col items-center gap-2">
                        <ClipboardList className="h-10 w-10 text-gray-300" />
                        <p className="text-sm font-medium">{t('No stock takes recorded yet.')}</p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeSubTab === 'dispatch' && !isFormOrDetailOpen && (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100">
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Dispatch #')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('From → To')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Vehicle / Driver')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Date')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Status')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider text-right">{t('Actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {warehouseDispatches
                  .filter(d => d.dispatchNumber.toLowerCase().includes(searchQuery.toLowerCase()))
                  .map(d => {
                    const fromWh = warehouses.find(w => w.id === d.fromWarehouseId);
                    const toWh = warehouses.find(w => w.id === d.toWarehouseId);
                    return (
                      <tr key={d.id} className="hover:bg-gray-50/50 transition">
                        <td className="px-6 py-4 font-semibold text-indigo-700 font-mono">{d.dispatchNumber}</td>
                        <td className="px-6 py-4 text-sm text-gray-800">
                          {fromWh?.name || t('Unknown Warehouse')} → {toWh?.name || t('Unknown Warehouse')}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {d.vehicleNumber || d.driverName ? `${d.vehicleNumber || '-'} / ${d.driverName || '-'}` : '-'}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-500">{new Date(d.date).toLocaleDateString()}</td>
                        <td className="px-6 py-4">
                          <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium ${
                            d.status === 'Received' ? 'bg-emerald-50 text-emerald-700' :
                            d.status === 'Cancelled' ? 'bg-gray-100 text-gray-500' :
                            'bg-amber-50 text-amber-700'
                          }`}>
                            {t(d.status)}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <div className="flex items-center justify-end gap-3">
                            {d.status === 'Dispatched' && can('warehouseReceivings.create') && (
                              <button
                                onClick={() => handleOpenReceiving(d)}
                                className="px-2.5 py-1 bg-indigo-50 text-indigo-700 rounded-md text-xs font-semibold hover:bg-indigo-100 transition"
                              >
                                {t('Receive')}
                              </button>
                            )}
                            <button onClick={() => setViewingDispatch(d)} className="p-1 text-gray-400 hover:text-indigo-600 transition">
                              <Eye className="h-5 w-5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                {warehouseDispatches.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-gray-500">
                      <div className="flex flex-col items-center gap-2">
                        <Truck className="h-10 w-10 text-gray-300" />
                        <p className="text-sm font-medium">{t('No warehouse dispatches recorded yet.')}</p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeSubTab === 'receiving' && !isFormOrDetailOpen && (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100">
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Receiving #')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Dispatch #')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Destination Warehouse')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Received By')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">{t('Date')}</th>
                  <th className="px-6 py-4 text-xs font-semibold text-gray-600 uppercase tracking-wider text-right">{t('Actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {warehouseReceivings
                  .filter(r => r.receivingNumber.toLowerCase().includes(searchQuery.toLowerCase()))
                  .map(r => {
                    const dispatch = warehouseDispatches.find(d => d.id === r.dispatchId);
                    const toWh = warehouses.find(w => w.id === dispatch?.toWarehouseId);
                    return (
                      <tr key={r.id} className="hover:bg-gray-50/50 transition">
                        <td className="px-6 py-4 font-semibold text-indigo-700 font-mono">{r.receivingNumber}</td>
                        <td className="px-6 py-4 text-sm text-gray-600 font-mono">{dispatch?.dispatchNumber || '-'}</td>
                        <td className="px-6 py-4 text-sm text-gray-800">{toWh?.name || t('Unknown Warehouse')}</td>
                        <td className="px-6 py-4 text-sm text-gray-600">{r.receivedBy}</td>
                        <td className="px-6 py-4 text-sm text-gray-500">{new Date(r.date).toLocaleDateString()}</td>
                        <td className="px-6 py-4 text-right">
                          <button onClick={() => setViewingReceiving(r)} className="p-1 text-gray-400 hover:text-indigo-600 transition">
                            <Eye className="h-5 w-5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                {warehouseReceivings.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-gray-500">
                      <div className="flex flex-col items-center gap-2">
                        <PackageOpen className="h-10 w-10 text-gray-300" />
                        <p className="text-sm font-medium">{t('No warehouse receivings recorded yet.')}</p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ----------------- MODALS & VIEWS ----------------- */}

      {/* PR VIEW DETAIL PANEL */}
      {viewingPr && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm w-full animate-fade-in">
          <div className="overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
              <div>
                <h3 className="text-lg font-bold text-gray-900">{t('Purchase Requisition Details')}</h3>
                <span className="text-sm font-semibold text-indigo-700 font-mono mt-0.5 inline-block">{viewingPr.prNumber}</span>
              </div>
              <button 
                onClick={() => setViewingPr(null)} 
                className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 bg-white transition"
              >
                {t('Back to List')}
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-gray-500">{t('Requested By:')}</span>
                  <p className="font-semibold text-gray-900 mt-0.5">{viewingPr.requestedBy}</p>
                </div>
                <div>
                  <span className="text-gray-500">{t('Date Requested:')}</span>
                  <p className="font-semibold text-gray-900 mt-0.5">{new Date(viewingPr.date).toLocaleString()}</p>
                </div>
                <div className="col-span-2">
                  <span className="text-gray-500">{t('Notes:')}</span>
                  <p className="text-gray-700 mt-0.5 bg-gray-50 p-2.5 rounded border border-gray-100">{viewingPr.notes || '-'}</p>
                </div>
              </div>
              <div className="mt-6">
                <h4 className="text-sm font-semibold text-gray-700 mb-2">{t('Requested Items')}</h4>
                <div className="border border-gray-100 rounded-lg overflow-hidden">
                  <table className="w-full text-left">
                    <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                      <tr>
                        <th className="px-4 py-2">{t('Product')}</th>
                        <th className="px-4 py-2 text-right">{t('Quantity')}</th>
                        <th className="px-4 py-2">{t('Purpose')}</th>
                      </tr>
                    </thead>
                    <tbody className="text-sm divide-y divide-gray-100">
                      {(viewingPr.items || []).map((item, idx) => {
                        const prod = products.find(p => p.id === item.productId);
                        return (
                          <tr key={idx}>
                            <td className="px-4 py-2 font-medium text-gray-900">{prod?.name || t('Unknown Product')}</td>
                            <td className="px-4 py-2 text-right font-bold text-gray-950">{item.quantity}</td>
                            <td className="px-4 py-2 text-gray-600">{item.purpose || '-'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            <div className="p-6 border-t border-gray-200 flex justify-between bg-gray-50">
              <div className="flex gap-2">
                <button
                  onClick={() => setViewingPr(null)}
                  className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-100 text-gray-700 transition"
                >
                  {t('Close')}
                </button>
                {viewingPr.status === 'Pending' && can('inventory.pr') && (
                  <>
                    <button
                      onClick={() => handleStartEditPr(viewingPr)}
                      className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-100 text-gray-700 transition"
                    >
                      {t('Edit')}
                    </button>
                    <button
                      onClick={() => handleWithdrawPr(viewingPr.id)}
                      className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-200 transition"
                    >
                      {t('Withdraw')}
                    </button>
                  </>
                )}
              </div>
              {viewingPr.status === 'Pending' && can('inventory.approve') && (
                <div className="flex gap-2">
                  <button
                    onClick={() => handlePrStatus(viewingPr.id, 'Rejected')}
                    className="px-4 py-2 bg-rose-50 text-rose-700 rounded-lg text-sm font-medium hover:bg-rose-100 transition"
                  >
                    {t('Reject PR')}
                  </button>
                  <button
                    onClick={() => handlePrStatus(viewingPr.id, 'Approved')}
                    className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 transition"
                  >
                    {t('Approve PR')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* PO VIEW DETAIL PANEL */}
      {viewingPo && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm w-full animate-fade-in">
          <div className="overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
              <div>
                <h3 className="text-lg font-bold text-gray-900">{t('Purchase Order Details')}</h3>
                <span className="text-sm font-semibold text-indigo-700 font-mono mt-0.5 inline-block">{viewingPo.poNumber}</span>
              </div>
              <button 
                onClick={() => setViewingPo(null)} 
                className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 bg-white transition"
              >
                {t('Back to List')}
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-gray-500">{t('Vendor:')}</span>
                  <p className="font-semibold text-gray-900 mt-0.5">
                    {vendors.find(v => v.id === viewingPo.vendorId)?.name || t('Unknown Vendor')}
                  </p>
                </div>
                <div>
                  <span className="text-gray-500">{t('PO Date:')}</span>
                  <p className="font-semibold text-gray-900 mt-0.5">{new Date(viewingPo.date).toLocaleString()}</p>
                </div>
                <div>
                  <span className="text-gray-500">{t('Expected Delivery:')}</span>
                  <p className="font-semibold text-gray-900 mt-0.5">
                    {viewingPo.deliveryDate ? new Date(viewingPo.deliveryDate).toLocaleDateString() : '-'}
                  </p>
                </div>
                <div>
                  <span className="text-gray-500">{t('Linked PR:')}</span>
                  <p className="font-semibold text-gray-900 mt-0.5">
                    {purchaseRequisitions.find(pr => pr.id === viewingPo.requisitionId)?.prNumber || '-'}
                  </p>
                </div>
              </div>
              <div className="mt-6">
                <h4 className="text-sm font-semibold text-gray-700 mb-2">{t('Ordered Items')}</h4>
                <div className="border border-gray-100 rounded-lg overflow-hidden">
                  <table className="w-full text-left">
                    <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                      <tr>
                        <th className="px-4 py-2">{t('Product')}</th>
                        <th className="px-4 py-2 text-right">{t('Quantity')}</th>
                        <th className="px-4 py-2 text-right">{t('Unit Price')}</th>
                        <th className="px-4 py-2 text-right">{t('VAT')}</th>
                        <th className="px-4 py-2 text-right">{t('Total')}</th>
                      </tr>
                    </thead>
                    <tbody className="text-sm divide-y divide-gray-100">
                      {(viewingPo.items || []).map((item, idx) => {
                        const prod = products.find(p => p.id === item.productId);
                        const subTotal = item.quantityOrdered * item.unitPrice;
                        const vat = subTotal * ((item.taxRate || 0) / 100);
                        return (
                          <tr key={idx}>
                            <td className="px-4 py-2 font-medium text-gray-900">{prod?.name || t('Unknown Product')}</td>
                            <td className="px-4 py-2 text-right font-semibold text-gray-950">{item.quantityOrdered}</td>
                            <td className="px-4 py-2 text-right">{item.unitPrice.toFixed(2)} {currency}</td>
                            <td className="px-4 py-2 text-right">{vat.toFixed(2)} {currency}</td>
                            <td className="px-4 py-2 text-right font-bold">{(subTotal + vat).toFixed(2)} {currency}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="mt-4 flex justify-end text-lg font-bold text-gray-900">
                  {t('Grand Total:')} &nbsp;{Number(viewingPo.totalAmount).toFixed(2)} {currency}
                </div>
              </div>
            </div>
            <div className="p-6 border-t border-gray-200 flex justify-between bg-gray-50">
              <button
                onClick={() => setViewingPo(null)}
                className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-100 text-gray-700 transition"
              >
                {t('Close')}
              </button>
              {viewingPo.status === 'Sent' && (
                <button
                  onClick={() => handleCancelPo(viewingPo.id)}
                  className="px-4 py-2 bg-rose-50 text-rose-700 rounded-lg text-sm font-medium hover:bg-rose-100 transition"
                >
                  {t('Cancel PO')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* GRN VIEW DETAIL PANEL */}
      {viewingGrn && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm w-full animate-fade-in">
          <div className="overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
              <div>
                <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                  {t('Goods Receipt Note Details')}
                  {viewingGrn.isReversed && (
                    <span className="px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide bg-rose-50 text-rose-700">{t('Reversed')}</span>
                  )}
                </h3>
                <span className="text-sm font-semibold text-indigo-700 font-mono mt-0.5 inline-block">{viewingGrn.grnNumber}</span>
              </div>
              <button
                onClick={() => setViewingGrn(null)}
                className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 bg-white transition"
              >
                {t('Back to List')}
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-gray-500">{t('Vendor:')}</span>
                  <p className="font-semibold text-gray-900 mt-0.5">
                    {vendors.find(v => v.id === viewingGrn.vendorId)?.name || t('Unknown Vendor')}
                  </p>
                </div>
                <div>
                  <span className="text-gray-500">{t('Received Warehouse:')}</span>
                  <p className="font-semibold text-gray-900 mt-0.5">
                    {warehouses.find(w => w.id === viewingGrn.warehouseId)?.name || t('Unknown Warehouse')}
                  </p>
                </div>
                <div>
                  <span className="text-gray-500">{t('Date Received:')}</span>
                  <p className="font-semibold text-gray-900 mt-0.5">{new Date(viewingGrn.date).toLocaleString()}</p>
                </div>
                <div>
                  <span className="text-gray-500">{t('Received By:')}</span>
                  <p className="font-semibold text-gray-900 mt-0.5">{viewingGrn.receivedBy}</p>
                </div>
                <div>
                  <span className="text-gray-500">{t('Delivery Mode:')}</span>
                  <p className="font-semibold text-gray-900 mt-0.5">
                    {viewingGrn.isDsd ? t('DSD (Direct Shop Delivery)') : t('Regular Purchase Order Delivery')}
                  </p>
                </div>
                {viewingGrn.vehicleNumber && (
                  <div>
                    <span className="text-gray-500">{t('Vehicle Number:')}</span>
                    <p className="font-semibold text-indigo-700 mt-0.5">{viewingGrn.vehicleNumber}</p>
                  </div>
                )}
                {viewingGrn.driverName && (
                  <div>
                    <span className="text-gray-500">{t('Driver Name:')}</span>
                    <p className="font-semibold text-indigo-700 mt-0.5">{viewingGrn.driverName}</p>
                  </div>
                )}
              </div>
              <div className="mt-6">
                <h4 className="text-sm font-semibold text-gray-700 mb-2">{t('Received Items Ledger')}</h4>
                <div className="border border-gray-100 rounded-lg overflow-hidden">
                  <table className="w-full text-left">
                    <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                      <tr>
                        <th className="px-4 py-2">{t('Product')}</th>
                        <th className="px-4 py-2 text-right">{t('Qty Received')}</th>
                        <th className="px-4 py-2 text-right">{t('Unit Cost')}</th>
                        <th className="px-4 py-2 text-right">{t('Tax %')}</th>
                        <th className="px-4 py-2 text-right">{t('VAT')}</th>
                        <th className="px-4 py-2 text-right">{t('Total')}</th>
                        <th className="px-4 py-2">{t('Batch / Expiry')}</th>
                      </tr>
                    </thead>
                    <tbody className="text-sm divide-y divide-gray-100">
                      {(viewingGrn.items || []).map((item, idx) => {
                        const prod = products.find(p => p.id === item.productId);
                        const subTotal = item.quantityReceived * item.unitCost;
                        const vat = subTotal * ((item.taxRate || 0) / 100);
                        return (
                          <tr key={idx}>
                            <td className="px-4 py-2 font-medium text-gray-900">{prod?.name || t('Unknown Product')}</td>
                            <td className="px-4 py-2 text-right font-bold text-emerald-600">{item.quantityReceived}</td>
                            <td className="px-4 py-2 text-right">{item.unitCost.toFixed(2)} {currency}</td>
                            <td className="px-4 py-2 text-right">{item.taxRate || 0}%</td>
                            <td className="px-4 py-2 text-right">{vat.toFixed(2)} {currency}</td>
                            <td className="px-4 py-2 text-right font-bold">{(subTotal + vat).toFixed(2)} {currency}</td>
                            <td className="px-4 py-2 text-gray-600 text-xs">
                              <span className="font-mono">{item.batchNumber || '-'}</span>
                              {item.expiryDate ? ` / ${new Date(item.expiryDate).toLocaleDateString()}` : ''}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="mt-4 flex flex-col items-end gap-1.5 text-sm font-semibold text-gray-700">
                  <div>
                    {t('Subtotal (excl. tax):')} &nbsp;
                    <span className="font-bold text-gray-900">
                      {(viewingGrn.items || []).reduce((sum, item) => sum + item.quantityReceived * item.unitCost, 0).toFixed(2)} {currency}
                    </span>
                  </div>
                  <div>
                    {t('VAT Total:')} &nbsp;
                    <span className="font-bold text-gray-900">
                      {(viewingGrn.items || []).reduce((sum, item) => sum + (item.quantityReceived * item.unitCost * ((item.taxRate || 0) / 100)), 0).toFixed(2)} {currency}
                    </span>
                  </div>
                  <div className="text-lg font-bold text-emerald-700 mt-1 border-t border-gray-100 pt-1.5">
                    {t('Grand Total:')} &nbsp;
                    <span>
                      {(viewingGrn.items || []).reduce((sum, item) => sum + (item.quantityReceived * item.unitCost * (1 + ((item.taxRate || 0) / 100))), 0).toFixed(2)} {currency}
                    </span>
                  </div>
                </div>
              </div>
            </div>
            <div className="p-6 border-t border-gray-200 flex justify-between bg-gray-50">
              <button
                onClick={() => setViewingGrn(null)}
                className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-100 text-gray-700 transition"
              >
                {t('Close')}
              </button>
              {!viewingGrn.isReversed && can('inventory.grn') && (
                <button
                  onClick={() => handleReverseGrn(viewingGrn.id)}
                  className="px-4 py-2 bg-rose-50 text-rose-700 rounded-lg text-sm font-medium hover:bg-rose-100 transition"
                >
                  {t('Reverse Receipt')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* DISPATCH VIEW DETAIL PANEL */}
      {viewingDispatch && (() => {
        const fromWh = warehouses.find(w => w.id === viewingDispatch.fromWarehouseId);
        const toWh = warehouses.find(w => w.id === viewingDispatch.toWarehouseId);
        return (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm w-full animate-fade-in">
            <div className="overflow-hidden flex flex-col">
              <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
                <div>
                  <h3 className="text-lg font-bold text-gray-900">{t('Warehouse Dispatch Details')}</h3>
                  <span className="text-sm font-semibold text-indigo-700 font-mono mt-0.5 inline-block">{viewingDispatch.dispatchNumber}</span>
                </div>
                <button
                  onClick={() => setViewingDispatch(null)}
                  className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 bg-white transition"
                >
                  {t('Back to List')}
                </button>
              </div>
              <div className="p-6 space-y-4">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-gray-500">{t('From Warehouse:')}</span>
                    <p className="font-semibold text-gray-900 mt-0.5">{fromWh?.name || t('Unknown Warehouse')}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">{t('To Warehouse:')}</span>
                    <p className="font-semibold text-gray-900 mt-0.5">{toWh?.name || t('Unknown Warehouse')}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">{t('Date:')}</span>
                    <p className="font-semibold text-gray-900 mt-0.5">{new Date(viewingDispatch.date).toLocaleString()}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">{t('Dispatched By:')}</span>
                    <p className="font-semibold text-gray-900 mt-0.5">{viewingDispatch.dispatchedBy}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">{t('Status:')}</span>
                    <p className="font-semibold text-gray-900 mt-0.5">{t(viewingDispatch.status)}</p>
                  </div>
                  {viewingDispatch.vehicleNumber && (
                    <div>
                      <span className="text-gray-500">{t('Vehicle Number:')}</span>
                      <p className="font-semibold text-indigo-700 mt-0.5">{viewingDispatch.vehicleNumber}</p>
                    </div>
                  )}
                  {viewingDispatch.driverName && (
                    <div>
                      <span className="text-gray-500">{t('Driver Name:')}</span>
                      <p className="font-semibold text-indigo-700 mt-0.5">{viewingDispatch.driverName}</p>
                    </div>
                  )}
                  {viewingDispatch.driverContact && (
                    <div>
                      <span className="text-gray-500">{t('Driver Contact:')}</span>
                      <p className="font-semibold text-gray-900 mt-0.5">{viewingDispatch.driverContact}</p>
                    </div>
                  )}
                  {viewingDispatch.expectedArrivalDate && (
                    <div>
                      <span className="text-gray-500">{t('Expected Arrival:')}</span>
                      <p className="font-semibold text-gray-900 mt-0.5">{new Date(viewingDispatch.expectedArrivalDate).toLocaleDateString()}</p>
                    </div>
                  )}
                  {viewingDispatch.notes && (
                    <div className="col-span-2">
                      <span className="text-gray-500">{t('Notes:')}</span>
                      <p className="text-gray-700 mt-0.5 bg-gray-50 p-2.5 rounded border border-gray-100">{viewingDispatch.notes}</p>
                    </div>
                  )}
                </div>
                <div className="mt-6">
                  <h4 className="text-sm font-semibold text-gray-700 mb-2">{t('Dispatched Items')}</h4>
                  <div className="border border-gray-100 rounded-lg overflow-hidden">
                    <table className="w-full text-left">
                      <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                        <tr>
                          <th className="px-4 py-2">{t('Product')}</th>
                          <th className="px-4 py-2 text-right">{t('Qty Dispatched')}</th>
                          <th className="px-4 py-2">{t('Batch / Expiry')}</th>
                        </tr>
                      </thead>
                      <tbody className="text-sm divide-y divide-gray-100">
                        {(viewingDispatch.items || []).map((item, idx) => {
                          const prod = products.find(p => p.id === item.productId);
                          return (
                            <tr key={idx}>
                              <td className="px-4 py-2 font-medium text-gray-900">{prod?.name || t('Unknown Product')}</td>
                              <td className="px-4 py-2 text-right font-bold text-indigo-600">{item.quantityDispatched}</td>
                              <td className="px-4 py-2 text-gray-600 text-xs">
                                <span className="font-mono">{item.batchNumber || '-'}</span>
                                {item.expiryDate ? ` / ${new Date(item.expiryDate).toLocaleDateString()}` : ''}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              <div className="p-6 border-t border-gray-200 flex justify-between bg-gray-50">
                <button
                  onClick={() => setViewingDispatch(null)}
                  className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-100 text-gray-700 transition"
                >
                  {t('Close')}
                </button>
                <div className="flex items-center gap-3">
                  {onPrintDoc && (
                    <button
                      onClick={() => onPrintDoc('WarehouseDispatch', viewingDispatch)}
                      className="inline-flex items-center gap-2 px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 bg-white transition"
                    >
                      <Printer className="h-4 w-4" />
                      {t('Print')}
                    </button>
                  )}
                  {viewingDispatch.status === 'Dispatched' && can('warehouseDispatches.delete') && (
                    <button
                      onClick={() => handleCancelDispatch(viewingDispatch.id)}
                      disabled={isCancellingDispatch}
                      className="inline-flex items-center gap-2 px-4 py-2 bg-rose-50 text-rose-700 rounded-lg text-sm font-medium hover:bg-rose-100 transition disabled:opacity-50"
                    >
                      <Ban className="h-4 w-4" />
                      {isCancellingDispatch ? t('Cancelling...') : t('Cancel Dispatch')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* RECEIVING VIEW DETAIL PANEL */}
      {viewingReceiving && (() => {
        const dispatch = warehouseDispatches.find(d => d.id === viewingReceiving.dispatchId);
        const fromWh = warehouses.find(w => w.id === dispatch?.fromWarehouseId);
        const toWh = warehouses.find(w => w.id === dispatch?.toWarehouseId);
        return (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm w-full animate-fade-in">
            <div className="overflow-hidden flex flex-col">
              <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
                <div>
                  <h3 className="text-lg font-bold text-gray-900">{t('Warehouse Receiving Details')}</h3>
                  <span className="text-sm font-semibold text-indigo-700 font-mono mt-0.5 inline-block">{viewingReceiving.receivingNumber}</span>
                </div>
                <button
                  onClick={() => setViewingReceiving(null)}
                  className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 bg-white transition"
                >
                  {t('Back to List')}
                </button>
              </div>
              <div className="p-6 space-y-4">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-gray-500">{t('Dispatch #:')}</span>
                    <p className="font-semibold text-gray-900 mt-0.5 font-mono">{dispatch?.dispatchNumber || '-'}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">{t('From Warehouse:')}</span>
                    <p className="font-semibold text-gray-900 mt-0.5">{fromWh?.name || t('Unknown Warehouse')}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">{t('To Warehouse:')}</span>
                    <p className="font-semibold text-gray-900 mt-0.5">{toWh?.name || t('Unknown Warehouse')}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">{t('Date:')}</span>
                    <p className="font-semibold text-gray-900 mt-0.5">{new Date(viewingReceiving.date).toLocaleString()}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">{t('Received By:')}</span>
                    <p className="font-semibold text-gray-900 mt-0.5">{viewingReceiving.receivedBy}</p>
                  </div>
                  {viewingReceiving.condition && (
                    <div>
                      <span className="text-gray-500">{t('Condition:')}</span>
                      <p className="font-semibold text-gray-900 mt-0.5">{viewingReceiving.condition}</p>
                    </div>
                  )}
                  {viewingReceiving.discrepancyNotes && (
                    <div className="col-span-2">
                      <span className="text-gray-500">{t('Discrepancy Notes:')}</span>
                      <p className="text-gray-700 mt-0.5 bg-amber-50 p-2.5 rounded border border-amber-100">{viewingReceiving.discrepancyNotes}</p>
                    </div>
                  )}
                  {viewingReceiving.notes && (
                    <div className="col-span-2">
                      <span className="text-gray-500">{t('Notes:')}</span>
                      <p className="text-gray-700 mt-0.5 bg-gray-50 p-2.5 rounded border border-gray-100">{viewingReceiving.notes}</p>
                    </div>
                  )}
                </div>
                <div className="mt-6">
                  <h4 className="text-sm font-semibold text-gray-700 mb-2">{t('Received Items')}</h4>
                  <div className="border border-gray-100 rounded-lg overflow-hidden">
                    <table className="w-full text-left">
                      <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                        <tr>
                          <th className="px-4 py-2">{t('Product')}</th>
                          <th className="px-4 py-2 text-right">{t('Qty Dispatched')}</th>
                          <th className="px-4 py-2 text-right">{t('Qty Received')}</th>
                          <th className="px-4 py-2 text-right">{t('Variance')}</th>
                          <th className="px-4 py-2">{t('Batch')}</th>
                        </tr>
                      </thead>
                      <tbody className="text-sm divide-y divide-gray-100">
                        {(viewingReceiving.items || []).map((item, idx) => {
                          const dispatchItem = (dispatch?.items || []).find(di => di.id === item.dispatchItemId);
                          const prod = products.find(p => p.id === item.productId);
                          const qtyDispatched = dispatchItem?.quantityDispatched ?? 0;
                          const variance = item.quantityReceived - qtyDispatched;
                          return (
                            <tr key={idx}>
                              <td className="px-4 py-2 font-medium text-gray-900">{prod?.name || t('Unknown Product')}</td>
                              <td className="px-4 py-2 text-right text-gray-600">{qtyDispatched}</td>
                              <td className="px-4 py-2 text-right font-bold text-emerald-600">{item.quantityReceived}</td>
                              <td className={`px-4 py-2 text-right font-semibold ${variance === 0 ? 'text-gray-400' : variance < 0 ? 'text-rose-600' : 'text-amber-600'}`}>
                                {variance > 0 ? `+${variance}` : variance}
                              </td>
                              <td className="px-4 py-2 text-gray-600 text-xs font-mono">{item.batchNumber || '-'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              <div className="p-6 border-t border-gray-200 flex justify-between bg-gray-50">
                <button
                  onClick={() => setViewingReceiving(null)}
                  className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-100 text-gray-700 transition"
                >
                  {t('Close')}
                </button>
                {onPrintDoc && (
                  <button
                    onClick={() => onPrintDoc('WarehouseReceiving', viewingReceiving)}
                    className="inline-flex items-center gap-2 px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 bg-white transition"
                  >
                    <Printer className="h-4 w-4" />
                    {t('Print')}
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* CREATE PR PANEL */}
      {isCreatingPr && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm w-full animate-fade-in">
          <div className="overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
              <h3 className="text-lg font-bold text-gray-900">{editingPrId ? t('Edit Purchase Requisition (PR)') : t('Create Purchase Requisition (PR)')}</h3>
              <button
                onClick={handleCancelPr}
                className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 bg-white transition"
              >
                {t('Back to List')}
              </button>
            </div>
            <form onSubmit={handleCreatePr} className="flex-1 flex flex-col">
              <div className="p-6 space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Requested By')}</label>
                    <input
                      type="text"
                      value={prForm.requestedBy}
                      readOnly
                      disabled
                      required
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-100 text-gray-400 cursor-not-allowed"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Internal Notes')}</label>
                    <input
                      type="text"
                      placeholder={t('Purpose, urgent instructions...')}
                      value={prForm.notes}
                      onChange={(e) => setPrForm({ ...prForm, notes: e.target.value })}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-indigo-500"
                    />
                  </div>
                  {companyBranches.length > 0 && (
                    <div>
                      <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Branch')}</label>
                      <select
                        value={prForm.branchId}
                        onChange={(e) => setPrForm({ ...prForm, branchId: e.target.value })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-indigo-500"
                      >
                        <option value="">{t('Default (your primary branch)')}</option>
                        {companyBranches.map(b => (
                          <option key={b.id} value={b.id}>{b.name}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>

                {/* Add Item Form */}
                <div className="border border-gray-100 rounded-xl p-4 bg-gray-50/50 space-y-3 mt-4">
                  <h4 className="text-xs font-bold text-gray-600 uppercase tracking-wider">{t('Add Requested Material')}</h4>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <select
                        value={newPrItem.productId}
                        onChange={(e) => setNewPrItem({ ...newPrItem, productId: e.target.value })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                      >
                        <option value="">{t('-- Select Product --')}</option>
                        {products.map(p => (
                          <option key={p.id} value={p.id}>{p.name} ({p.sku || 'N/A'})</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <input
                        type="number"
                        placeholder={t('Quantity')}
                        value={newPrItem.quantity}
                        onChange={(e) => setNewPrItem({ ...newPrItem, quantity: Number(e.target.value) })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                      />
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        placeholder={t('Purpose')}
                        value={newPrItem.purpose}
                        onChange={(e) => setNewPrItem({ ...newPrItem, purpose: e.target.value })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                      />
                      <button
                        type="button"
                        onClick={addPrItem}
                        className="px-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition font-bold"
                      >
                        +
                      </button>
                    </div>
                  </div>
                </div>

                {/* Items List */}
                <div className="mt-4">
                  <h4 className="text-xs font-semibold text-gray-700 mb-2">{t('Items to Purchase')}</h4>
                  <div className="border border-gray-100 rounded-lg overflow-hidden">
                    <table className="w-full text-left">
                      <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                        <tr>
                          <th className="px-4 py-2">{t('Product')}</th>
                          <th className="px-4 py-2 text-right">{t('Qty')}</th>
                          <th className="px-4 py-2">{t('Purpose')}</th>
                          <th className="px-4 py-2 text-right">{t('Action')}</th>
                        </tr>
                      </thead>
                      <tbody className="text-sm divide-y divide-gray-100 bg-white">
                        {prForm.items.map((item, idx) => {
                          const prod = products.find(p => p.id === item.productId);
                          return (
                            <tr key={idx}>
                              <td className="px-4 py-2">{prod?.name || t('Unknown Product')}</td>
                              <td className="px-4 py-2 text-right font-semibold">{item.quantity}</td>
                              <td className="px-4 py-2 text-gray-600">{item.purpose || '-'}</td>
                              <td className="px-4 py-2 text-right">
                                <button
                                  type="button"
                                  onClick={() => removePrItem(idx)}
                                  className="text-rose-600 hover:text-rose-800 text-sm font-semibold"
                                >
                                  {t('Remove')}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                        {prForm.items.length === 0 && (
                          <tr>
                            <td colSpan={4} className="px-4 py-6 text-center text-gray-400 text-xs">
                              {t('No items added yet. Use the selector above to add materials.')}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              <div className="p-6 border-t border-gray-200 flex justify-end gap-3 bg-gray-50">
                <button
                  type="button"
                  onClick={handleCancelPr}
                  className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-100 text-gray-700 transition"
                >
                  {t('Cancel')}
                </button>
                <button
                  type="submit"
                  disabled={prForm.items.length === 0 || isSubmittingPr}
                  className="px-5 py-2 bg-indigo-600 text-white font-medium rounded-lg text-sm shadow-sm hover:bg-indigo-700 transition disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  {isSubmittingPr ? t('Submitting...') : (editingPrId ? t('Save Changes') : t('Submit Requisition'))}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CREATE PO PANEL */}
      {isCreatingPo && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm w-full animate-fade-in">
          <div className="overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
              <h3 className="text-lg font-bold text-gray-900">{t('Raise Purchase Order (PO)')}</h3>
              <button 
                onClick={handleCancelPoForm} 
                className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 bg-white transition"
              >
                {t('Back to List')}
              </button>
            </div>
            <form onSubmit={handleCreatePo} className="flex-1 flex flex-col">
              <div className="p-6 space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Vendor')}</label>
                    <select
                      value={poForm.vendorId}
                      onChange={(e) => setPoForm({ ...poForm, vendorId: e.target.value })}
                      required
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                    >
                      <option value="">{t('-- Select Vendor --')}</option>
                      {vendors.map(v => (
                        <option key={v.id} value={v.id}>{v.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Load Approved PR (Optional)')}</label>
                    <select
                      value={poForm.requisitionId}
                      onChange={(e) => handlePoPrSelect(e.target.value)}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                    >
                      <option value="">{t('-- No Requisition Link --')}</option>
                      {purchaseRequisitions
                        .filter(pr => pr.status === 'Approved')
                        .map(pr => (
                          <option key={pr.id} value={pr.id}>{pr.prNumber} ({pr.requestedBy})</option>
                        ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Expected Delivery Date')}</label>
                    <input
                      type="date"
                      value={poForm.deliveryDate}
                      onChange={(e) => setPoForm({ ...poForm, deliveryDate: e.target.value })}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Internal Memo')}</label>
                    <input
                      type="text"
                      placeholder={t('Delivery/pricing instructions...')}
                      value={poForm.notes}
                      onChange={(e) => setPoForm({ ...poForm, notes: e.target.value })}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  {companyBranches.length > 0 && (
                    <div>
                      <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Branch')}</label>
                      <select
                        value={poForm.branchId}
                        onChange={(e) => setPoForm({ ...poForm, branchId: e.target.value })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                      >
                        <option value="">{t('Default (your primary branch, or linked PR\'s)')}</option>
                        {companyBranches.map(b => (
                          <option key={b.id} value={b.id}>{b.name}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>

                {/* Add Item Form */}
                <div className="border border-gray-100 rounded-xl p-4 bg-gray-50/50 space-y-3 mt-4">
                  <h4 className="text-xs font-bold text-gray-600 uppercase tracking-wider">{t('Add Material & Pricing')}</h4>
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 mb-1">{t('Scan Barcode / SKU')}</label>
                    <input
                      type="text"
                      placeholder={t('Scan or type a barcode — resolves the product and its unit automatically')}
                      value={poBarcodeInput}
                      onChange={(e) => setPoBarcodeInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return;
                        e.preventDefault();
                        const resolved = resolveProductByCode(poBarcodeInput);
                        if (!resolved) { triggerError(t('No product matches that barcode/SKU.')); return; }
                        setNewPoItem({ ...newPoItem, productId: resolved.productId, unitOfMeasureId: resolved.unitOfMeasureId || '', unitPrice: resolved.purchasePrice ?? newPoItem.unitPrice });
                        setPoBarcodeInput('');
                      }}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                    <div className="sm:col-span-4">
                      <label className="block text-xs font-semibold text-gray-500 mb-1">{t('Select Product')}</label>
                      <select
                        value={newPoItem.productId}
                        onChange={(e) => {
                          const selectedProd = products.find(prod => prod.id === e.target.value);
                          setNewPoItem({
                            ...newPoItem,
                            productId: e.target.value,
                            unitOfMeasureId: '',
                            unitPrice: Number(selectedProd?.costPrice ?? selectedProd?.unitPrice ?? 0)
                          });
                        }}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                      >
                        <option value="">{t('-- Select Product --')}</option>
                        {products.map(p => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="sm:col-span-2">
                      <label className="block text-xs font-semibold text-gray-500 mb-1">{t('Unit')}</label>
                      <select
                        value={newPoItem.unitOfMeasureId}
                        onChange={(e) => setNewPoItem({ ...newPoItem, unitOfMeasureId: e.target.value })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                      >
                        <option value="">{t('Base Unit')}</option>
                        {(db.productUnitConversions || []).filter(puc => puc.productId === newPoItem.productId && puc.isActive !== false).map(puc => {
                          const uom = (db.unitsOfMeasure || []).find(u => u.id === puc.unitOfMeasureId);
                          return <option key={puc.id} value={puc.unitOfMeasureId}>{uom ? uom.name : t('Unit')} (×{puc.conversionFactor})</option>;
                        })}
                      </select>
                    </div>
                    <div className="sm:col-span-2">
                      <label className="block text-xs font-semibold text-gray-500 mb-1">{t('Quantity')}</label>
                      <input
                        type="number"
                        placeholder={t('Quantity')}
                        value={newPoItem.quantityOrdered}
                        onChange={(e) => setNewPoItem({ ...newPoItem, quantityOrdered: Number(e.target.value) })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="block text-xs font-semibold text-gray-500 mb-1">{t('Unit Cost')}</label>
                      <input
                        type="number"
                        step="0.01"
                        placeholder={t('Unit Cost')}
                        value={newPoItem.unitPrice || ''}
                        onChange={(e) => setNewPoItem({ ...newPoItem, unitPrice: Number(e.target.value) })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                      />
                    </div>
                    <div className="sm:col-span-3">
                      <label className="block text-xs font-semibold text-gray-500 mb-1">{t('Tax Slab')}</label>
                      <select
                        value={newPoItem.taxRate}
                        onChange={(e) => setNewPoItem({ ...newPoItem, taxRate: Number(e.target.value) })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                      >
                        {db.taxSlabs?.map(ts => (
                          <option key={ts.id} value={ts.percentage}>{ts.name} ({ts.percentage}%)</option>
                        ))}
                        {!db.taxSlabs && (
                          <>
                            <option value={15}>VAT (15%)</option>
                            <option value={5}>VAT (5%)</option>
                            <option value={0}>Exempt (0%)</option>
                          </>
                        )}
                        {db.taxSlabs && !db.taxSlabs.some(ts => ts.percentage === 0) && (
                          <option value={0}>{t('Exempt (0%)')}</option>
                        )}
                      </select>
                    </div>
                    <div className="sm:col-span-1 flex items-end">
                      <button
                        type="button"
                        onClick={addPoItem}
                        className="w-full h-9 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition font-bold text-sm flex items-center justify-center shadow-xs"
                      >
                        {t('Add')}
                      </button>
                    </div>
                  </div>
                </div>

                {/* PO Items Table */}
                <div className="mt-4">
                  <h4 className="text-xs font-semibold text-gray-700 mb-2">{t('Purchase Order Items')}</h4>
                  <div className="border border-gray-100 rounded-lg overflow-hidden">
                    <table className="w-full text-left">
                      <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                        <tr>
                          <th className="px-4 py-2">{t('Product')}</th>
                          <th className="px-4 py-2 text-right">{t('Qty')}</th>
                          <th className="px-4 py-2 text-right">{t('Unit Cost')}</th>
                          <th className="px-4 py-2 text-right">{t('VAT')}</th>
                          <th className="px-4 py-2 text-right">{t('Total')}</th>
                          <th className="px-4 py-2 text-right">{t('Action')}</th>
                        </tr>
                      </thead>
                      <tbody className="text-sm divide-y divide-gray-100 bg-white">
                        {poForm.items.map((item, idx) => {
                          const prod = products.find(p => p.id === item.productId);
                          const subTotal = item.quantityOrdered * item.unitPrice;
                          const vat = subTotal * (item.taxRate / 100);
                          return (
                            <tr key={idx}>
                              <td className="px-4 py-2 font-medium text-gray-800">{prod?.name || t('Unknown Product')}</td>
                              <td className="px-4 py-2 text-right">
                                <input
                                  type="number"
                                  value={item.quantityOrdered}
                                  onChange={(e) => {
                                    const val = Number(e.target.value);
                                    const updatedItems = [...poForm.items];
                                    updatedItems[idx] = { ...item, quantityOrdered: val };
                                    setPoForm({ ...poForm, items: updatedItems });
                                  }}
                                  className="w-20 text-right border border-gray-200 rounded px-2 py-1 text-xs bg-white inline-block"
                                />
                              </td>
                              <td className="px-4 py-2 text-right">
                                <input
                                  type="number"
                                  step="0.01"
                                  value={item.unitPrice}
                                  onChange={(e) => {
                                    const val = Number(e.target.value);
                                    const updatedItems = [...poForm.items];
                                    updatedItems[idx] = { ...item, unitPrice: val };
                                    setPoForm({ ...poForm, items: updatedItems });
                                  }}
                                  className="w-24 text-right border border-gray-200 rounded px-2 py-1 text-xs bg-white inline-block"
                                />
                              </td>
                              <td className="px-4 py-2 text-right">
                                <select
                                  value={item.taxRate}
                                  onChange={(e) => {
                                    const val = Number(e.target.value);
                                    const updatedItems = [...poForm.items];
                                    updatedItems[idx] = { ...item, taxRate: val };
                                    setPoForm({ ...poForm, items: updatedItems });
                                  }}
                                  className="w-28 text-right border border-gray-200 rounded px-2 py-1 text-xs bg-white inline-block"
                                >
                                  {db.taxSlabs?.map(ts => (
                                    <option key={ts.id} value={ts.percentage}>{ts.name} ({ts.percentage}%)</option>
                                  ))}
                                  {!db.taxSlabs && (
                                    <>
                                      <option value={15}>VAT (15%)</option>
                                      <option value={5}>VAT (5%)</option>
                                      <option value={0}>Exempt (0%)</option>
                                    </>
                                  )}
                                  {db.taxSlabs && !db.taxSlabs.some(ts => ts.percentage === 0) && (
                                    <option value={0}>{t('Exempt (0%)')}</option>
                                  )}
                                </select>
                              </td>
                              <td className="px-4 py-2 text-right font-semibold text-gray-900">{(subTotal + vat).toFixed(2)} {currency}</td>
                              <td className="px-4 py-2 text-right">
                                <button
                                  type="button"
                                  onClick={() => removePoItem(idx)}
                                  className="text-rose-600 hover:text-rose-800 text-sm font-semibold"
                                >
                                  {t('Remove')}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                        {poForm.items.length === 0 && (
                          <tr>
                            <td colSpan={6} className="px-4 py-6 text-center text-gray-400 text-xs">
                              {t('No purchase items added yet.')}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              <div className="p-6 border-t border-gray-200 flex justify-end gap-3 bg-gray-50">
                <button
                  type="button"
                  onClick={handleCancelPoForm}
                  className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-100 text-gray-700 transition"
                >
                  {t('Cancel')}
                </button>
                <button
                  type="submit"
                  disabled={poForm.items.length === 0 || !poForm.vendorId || isSubmittingPo}
                  className="px-5 py-2 bg-indigo-600 text-white font-medium rounded-lg text-sm shadow-sm hover:bg-indigo-700 transition disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  {isSubmittingPo ? t('Issuing...') : t('Issue Purchase Order')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CREATE GRN PANEL */}
      {isCreatingGrn && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm w-full animate-fade-in">
          <div className="overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
              <h3 className="text-lg font-bold text-gray-900">{t('Receive Goods / GRN Ledger')}</h3>
              <button 
                onClick={handleCancelGrnForm} 
                className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 bg-white transition"
              >
                {t('Back to List')}
              </button>
            </div>
            <form onSubmit={handleCreateGrn} className="flex-1 flex flex-col">
              <div className="p-6 space-y-4">
                {/* Delivery Mode Option */}
                <div className="bg-indigo-50 p-3.5 rounded-lg border border-indigo-100 flex gap-4 items-center mb-2">
                  <span className="text-sm font-bold text-indigo-900">{t('Receipt Type:')}</span>
                  <label className="flex items-center gap-1.5 text-sm font-semibold text-gray-700 cursor-pointer">
                    <input
                      type="radio"
                      checked={!grnForm.isDsd}
                      onChange={() => setGrnForm({ ...grnForm, isDsd: false, purchaseOrderId: '', items: [] })}
                      className="text-indigo-600"
                    />
                    {t('PO Linked Delivery')}
                  </label>
                  <label className="flex items-center gap-1.5 text-sm font-semibold text-gray-700 cursor-pointer">
                    <input
                      type="radio"
                      checked={grnForm.isDsd}
                      onChange={() => setGrnForm({ ...grnForm, isDsd: true, purchaseOrderId: '', items: [] })}
                      className="text-indigo-600"
                    />
                    {t('Direct Shop Delivery (DSD)')}
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  {!grnForm.isDsd && (
                    <div>
                      <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Select Sent PO')}</label>
                      <select
                        value={grnForm.purchaseOrderId}
                        onChange={(e) => handleGrnPoSelect(e.target.value)}
                        required={!grnForm.isDsd}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                      >
                        <option value="">{t('-- Select Purchase Order --')}</option>
                        {/* A Partially Received PO must stay selectable so the remaining
                            balance can still be received — otherwise a partial delivery
                            could never be completed. */}
                        {purchaseOrders
                          .filter(po => po.status === 'Sent' || po.status === 'Partially Received')
                          .map(po => (
                            <option key={po.id} value={po.id}>{po.poNumber}{po.status === 'Partially Received' ? ` (${t('Partially Received')})` : ''} ({vendors.find(v => v.id === po.vendorId)?.name})</option>
                          ))}
                      </select>
                    </div>
                  )}
                  {grnForm.isDsd && (
                    <div>
                      <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Vendor')}</label>
                      <select
                        value={grnForm.vendorId}
                        onChange={(e) => setGrnForm({ ...grnForm, vendorId: e.target.value })}
                        required={grnForm.isDsd}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                      >
                        <option value="">{t('-- Select Vendor --')}</option>
                        {vendors.map(v => (
                          <option key={v.id} value={v.id}>{v.name}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Store / Warehouse Location')}</label>
                    <select
                      value={grnForm.warehouseId}
                      onChange={(e) => setGrnForm({ ...grnForm, warehouseId: e.target.value })}
                      required
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                    >
                      {warehouses.map(wh => (
                        <option key={wh.id} value={wh.id}>{wh.name} ({wh.code})</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Received By')}</label>
                    <input
                      type="text"
                      value={grnForm.receivedBy}
                      readOnly
                      disabled
                      required
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-100 text-gray-400 cursor-not-allowed"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Receipt Memo / Note')}</label>
                    <input
                      type="text"
                      placeholder={t('Delivery dispatch note ID...')}
                      value={grnForm.notes}
                      onChange={(e) => setGrnForm({ ...grnForm, notes: e.target.value })}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Vehicle Number')}</label>
                    <input
                      type="text"
                      placeholder={t('Vehicle # (e.g. LKN-1234)')}
                      value={grnForm.vehicleNumber}
                      onChange={(e) => setGrnForm({ ...grnForm, vehicleNumber: e.target.value })}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Driver Name')}</label>
                    <input
                      type="text"
                      placeholder={t('Driver Full Name')}
                      value={grnForm.driverName}
                      onChange={(e) => setGrnForm({ ...grnForm, driverName: e.target.value })}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                </div>

                {/* Add Item Form (Only required or allowed for DSD, PO items map automatically but can be appended) */}
                <div className="border border-gray-100 rounded-xl p-4 bg-gray-50/50 space-y-3 mt-4">
                  <h4 className="text-xs font-bold text-gray-600 uppercase tracking-wider">
                    {grnForm.isDsd ? t('Add Delivery Product & Batch') : t('Adjust/Add Incoming Delivery Item')}
                  </h4>
                  <input
                    type="text"
                    placeholder={t('Scan or type a barcode — resolves the product and its unit automatically')}
                    value={grnBarcodeInput}
                    onChange={(e) => setGrnBarcodeInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return;
                      e.preventDefault();
                      const resolved = resolveProductByCode(grnBarcodeInput);
                      if (!resolved) { triggerError(t('No product matches that barcode/SKU.')); return; }
                      setNewGrnItem({ ...newGrnItem, productId: resolved.productId, unitOfMeasureId: resolved.unitOfMeasureId || '', unitCost: resolved.purchasePrice ?? newGrnItem.unitCost, taxRate: 15 });
                      setGrnBarcodeInput('');
                    }}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                  />
                  <div className="grid grid-cols-1 sm:grid-cols-7 gap-3">
                    <div className="sm:col-span-2">
                      <select
                        value={newGrnItem.productId}
                        onChange={(e) => {
                          const selectedProd = products.find(prod => prod.id === e.target.value);
                          setNewGrnItem({
                            ...newGrnItem,
                            productId: e.target.value,
                            unitOfMeasureId: '',
                            unitCost: Number(selectedProd?.costPrice ?? selectedProd?.unitPrice ?? 0),
                            taxRate: 15
                          });
                        }}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                      >
                        <option value="">{t('-- Select Product --')}</option>
                        {products.map(p => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <select
                        value={newGrnItem.unitOfMeasureId}
                        onChange={(e) => setNewGrnItem({ ...newGrnItem, unitOfMeasureId: e.target.value })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                      >
                        <option value="">{t('Base Unit')}</option>
                        {(db.productUnitConversions || []).filter(puc => puc.productId === newGrnItem.productId && puc.isActive !== false).map(puc => {
                          const uom = (db.unitsOfMeasure || []).find(u => u.id === puc.unitOfMeasureId);
                          return <option key={puc.id} value={puc.unitOfMeasureId}>{uom ? uom.name : t('Unit')} (×{puc.conversionFactor})</option>;
                        })}
                      </select>
                    </div>
                    <div>
                      <input
                        type="number"
                        placeholder={t('Qty')}
                        value={newGrnItem.quantityReceived}
                        onChange={(e) => setNewGrnItem({ ...newGrnItem, quantityReceived: Number(e.target.value) })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                      />
                    </div>
                    <div>
                      <input
                        type="number"
                        step="0.01"
                        placeholder={t('Cost')}
                        value={newGrnItem.unitCost}
                        onChange={(e) => setNewGrnItem({ ...newGrnItem, unitCost: Number(e.target.value) })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                      />
                    </div>
                    <div>
                      <input
                        type="number"
                        placeholder={t('Tax %')}
                        value={newGrnItem.taxRate}
                        onChange={(e) => setNewGrnItem({ ...newGrnItem, taxRate: Number(e.target.value) })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                      />
                    </div>
                    <div>
                      <input
                        type="text"
                        placeholder={t('Batch No.')}
                        value={newGrnItem.batchNumber}
                        onChange={(e) => setNewGrnItem({ ...newGrnItem, batchNumber: e.target.value })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                      />
                    </div>
                    <div className="flex gap-1">
                      <input
                        type="date"
                        placeholder={t('Expiry')}
                        value={newGrnItem.expiryDate}
                        onChange={(e) => setNewGrnItem({ ...newGrnItem, expiryDate: e.target.value })}
                        className="w-full border border-gray-200 rounded-lg px-2 py-2 text-xs bg-white"
                      />
                      <button
                        type="button"
                        onClick={addGrnItem}
                        className="px-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition font-bold text-sm"
                      >
                        +
                      </button>
                    </div>
                  </div>
                </div>

                {/* GRN Items Table */}
                <div className="mt-4">
                  <h4 className="text-xs font-semibold text-gray-700 mb-2">{t('Incoming Items to Stock')}</h4>
                  <div className="border border-gray-100 rounded-lg overflow-hidden">
                    <table className="w-full text-left">
                      <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                        <tr>
                          <th className="px-4 py-2">{t('Product')}</th>
                          <th className="px-4 py-2 text-right">{t('Qty Received')}</th>
                          <th className="px-4 py-2 text-right">{t('Unit Cost')}</th>
                          <th className="px-4 py-2 text-right">{t('Tax %')}</th>
                          <th className="px-4 py-2 text-right">{t('VAT')}</th>
                          <th className="px-4 py-2 text-right">{t('Total')}</th>
                          <th className="px-4 py-2">{t('Batch / Expiry')}</th>
                          <th className="px-4 py-2 text-right">{t('Action')}</th>
                        </tr>
                      </thead>
                      <tbody className="text-sm divide-y divide-gray-100 bg-white">
                        {grnForm.items.map((item, idx) => {
                          const prod = products.find(p => p.id === item.productId);
                          const subTotal = item.quantityReceived * item.unitCost;
                          const vat = subTotal * ((item.taxRate || 0) / 100);
                          return (
                            <tr key={idx}>
                              <td className="px-4 py-2">{prod?.name || t('Unknown Product')}</td>
                              <td className="px-4 py-2 text-right font-bold text-emerald-600">{item.quantityReceived}</td>
                              <td className="px-4 py-2 text-right">{item.unitCost.toFixed(2)} {currency}</td>
                              <td className="px-4 py-2 text-right">{item.taxRate || 0}%</td>
                              <td className="px-4 py-2 text-right">{vat.toFixed(2)} {currency}</td>
                              <td className="px-4 py-2 text-right font-semibold">{(subTotal + vat).toFixed(2)} {currency}</td>
                              <td className="px-4 py-2 text-xs text-gray-500">
                                <span className="font-mono">{item.batchNumber || '-'}</span>
                                {item.expiryDate ? ` / ${new Date(item.expiryDate).toLocaleDateString()}` : ''}
                              </td>
                              <td className="px-4 py-2 text-right">
                                <button
                                  type="button"
                                  onClick={() => removeGrnItem(idx)}
                                  className="text-rose-600 hover:text-rose-800 text-sm font-semibold"
                                >
                                  {t('Remove')}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                         {grnForm.items.length === 0 && (
                          <tr>
                            <td colSpan={8} className="px-4 py-6 text-center text-gray-400 text-xs">
                              {t('No materials loaded. Raise items above to confirm GRN receipt.')}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              <div className="p-6 border-t border-gray-200 flex justify-end gap-3 bg-gray-50">
                <button
                  type="button"
                  onClick={handleCancelGrnForm}
                  className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-100 text-gray-700 transition"
                >
                  {t('Cancel')}
                </button>
                <button
                  type="submit"
                  disabled={grnForm.items.length === 0 || (!grnForm.isDsd && !grnForm.purchaseOrderId) || (grnForm.isDsd && !grnForm.vendorId) || isSubmittingGrn}
                  className="px-5 py-2 bg-emerald-600 text-white font-medium rounded-lg text-sm shadow-sm hover:bg-emerald-700 transition disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  {isSubmittingGrn ? t('Recording...') : t('Confirm Receipt & Update Stock')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CREATE DISPATCH PANEL */}
      {isCreatingDispatch && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm w-full animate-fade-in">
          <div className="overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
              <h3 className="text-lg font-bold text-gray-900">{t('New Warehouse Dispatch')}</h3>
              <button
                type="button"
                onClick={handleCancelDispatchForm}
                className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 bg-white transition"
              >
                {t('Back to List')}
              </button>
            </div>
            <form onSubmit={handleCreateDispatch} className="flex-1 flex flex-col">
              <div className="p-6 space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('From Warehouse')}</label>
                    <select
                      value={dispatchForm.fromWarehouseId}
                      onChange={(e) => setDispatchForm({ ...dispatchForm, fromWarehouseId: e.target.value })}
                      required
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                    >
                      <option value="">{t('-- Select Source Warehouse --')}</option>
                      {warehouses.map(wh => (
                        <option key={wh.id} value={wh.id}>{wh.name} ({wh.code})</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('To Warehouse')}</label>
                    <select
                      value={dispatchForm.toWarehouseId}
                      onChange={(e) => setDispatchForm({ ...dispatchForm, toWarehouseId: e.target.value })}
                      required
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                    >
                      <option value="">{t('-- Select Destination Warehouse --')}</option>
                      {warehouses.filter(wh => wh.id !== dispatchForm.fromWarehouseId).map(wh => (
                        <option key={wh.id} value={wh.id}>{wh.name} ({wh.code})</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Dispatched By')}</label>
                    <input
                      type="text"
                      value={dispatchForm.dispatchedBy}
                      readOnly
                      disabled
                      required
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-100 text-gray-400 cursor-not-allowed"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Vehicle Number')}</label>
                    <input
                      type="text"
                      placeholder={t('Vehicle # (e.g. LKN-1234)')}
                      value={dispatchForm.vehicleNumber}
                      onChange={(e) => setDispatchForm({ ...dispatchForm, vehicleNumber: e.target.value })}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Driver Name')}</label>
                    <input
                      type="text"
                      placeholder={t('Driver Full Name')}
                      value={dispatchForm.driverName}
                      onChange={(e) => setDispatchForm({ ...dispatchForm, driverName: e.target.value })}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Driver Contact')}</label>
                    <input
                      type="text"
                      placeholder={t('Driver Phone Number')}
                      value={dispatchForm.driverContact}
                      onChange={(e) => setDispatchForm({ ...dispatchForm, driverContact: e.target.value })}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Expected Arrival Date')}</label>
                    <input
                      type="date"
                      value={dispatchForm.expectedArrivalDate}
                      onChange={(e) => setDispatchForm({ ...dispatchForm, expectedArrivalDate: e.target.value })}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Notes')}</label>
                    <input
                      type="text"
                      placeholder={t('Internal notes...')}
                      value={dispatchForm.notes}
                      onChange={(e) => setDispatchForm({ ...dispatchForm, notes: e.target.value })}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                </div>

                {/* Add Item Form */}
                <div className="border border-gray-100 rounded-xl p-4 bg-gray-50/50 space-y-3 mt-4">
                  <h4 className="text-xs font-bold text-gray-600 uppercase tracking-wider">{t('Add Item to Dispatch')}</h4>
                  <input
                    type="text"
                    placeholder={t('Scan or type a barcode — resolves the product and its unit automatically')}
                    value={dispatchBarcodeInput}
                    onChange={(e) => setDispatchBarcodeInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return;
                      e.preventDefault();
                      const resolved = resolveProductByCode(dispatchBarcodeInput);
                      if (!resolved) { triggerError(t('No product matches that barcode/SKU.')); return; }
                      setNewDispatchItem({ ...newDispatchItem, productId: resolved.productId, unitOfMeasureId: resolved.unitOfMeasureId || '' });
                      setDispatchBarcodeInput('');
                    }}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                  />
                  <div className="grid grid-cols-1 sm:grid-cols-6 gap-3">
                    <div className="sm:col-span-2">
                      <select
                        value={newDispatchItem.productId}
                        onChange={(e) => setNewDispatchItem({ ...newDispatchItem, productId: e.target.value, unitOfMeasureId: '' })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                      >
                        <option value="">{t('-- Select Product --')}</option>
                        {products.map(p => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <select
                        value={newDispatchItem.unitOfMeasureId}
                        onChange={(e) => setNewDispatchItem({ ...newDispatchItem, unitOfMeasureId: e.target.value })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                      >
                        <option value="">{t('Base Unit')}</option>
                        {(db.productUnitConversions || []).filter(puc => puc.productId === newDispatchItem.productId && puc.isActive !== false).map(puc => {
                          const uom = (db.unitsOfMeasure || []).find(u => u.id === puc.unitOfMeasureId);
                          return <option key={puc.id} value={puc.unitOfMeasureId}>{uom ? uom.name : t('Unit')} (×{puc.conversionFactor})</option>;
                        })}
                      </select>
                    </div>
                    <div>
                      <input
                        type="number"
                        placeholder={t('Qty')}
                        value={newDispatchItem.quantityDispatched}
                        onChange={(e) => setNewDispatchItem({ ...newDispatchItem, quantityDispatched: Number(e.target.value) })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                      />
                    </div>
                    <div>
                      <input
                        type="text"
                        placeholder={t('Batch No.')}
                        value={newDispatchItem.batchNumber}
                        onChange={(e) => setNewDispatchItem({ ...newDispatchItem, batchNumber: e.target.value })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                      />
                    </div>
                    <div className="flex gap-1">
                      <input
                        type="date"
                        placeholder={t('Expiry')}
                        value={newDispatchItem.expiryDate}
                        onChange={(e) => setNewDispatchItem({ ...newDispatchItem, expiryDate: e.target.value })}
                        className="w-full border border-gray-200 rounded-lg px-2 py-2 text-xs bg-white"
                      />
                      <button
                        type="button"
                        onClick={handleAddDispatchItem}
                        className="px-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition font-bold text-sm"
                      >
                        +
                      </button>
                    </div>
                  </div>
                </div>

                {/* Dispatch Items Table */}
                <div className="mt-4">
                  <h4 className="text-xs font-semibold text-gray-700 mb-2">{t('Items to Dispatch')}</h4>
                  <div className="border border-gray-100 rounded-lg overflow-hidden">
                    <table className="w-full text-left">
                      <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                        <tr>
                          <th className="px-4 py-2">{t('Product')}</th>
                          <th className="px-4 py-2 text-right">{t('Qty')}</th>
                          <th className="px-4 py-2">{t('Batch / Expiry')}</th>
                          <th className="px-4 py-2 text-right">{t('Action')}</th>
                        </tr>
                      </thead>
                      <tbody className="text-sm divide-y divide-gray-100 bg-white">
                        {dispatchForm.items.map((item, idx) => {
                          const prod = products.find(p => p.id === item.productId);
                          return (
                            <tr key={idx}>
                              <td className="px-4 py-2">{prod?.name || t('Unknown Product')}</td>
                              <td className="px-4 py-2 text-right font-bold text-indigo-600">{item.quantityDispatched}</td>
                              <td className="px-4 py-2 text-xs text-gray-500">
                                <span className="font-mono">{item.batchNumber || '-'}</span>
                                {item.expiryDate ? ` / ${new Date(item.expiryDate).toLocaleDateString()}` : ''}
                              </td>
                              <td className="px-4 py-2 text-right">
                                <button
                                  type="button"
                                  onClick={() => handleRemoveDispatchItem(idx)}
                                  className="text-rose-600 hover:text-rose-800 text-sm font-semibold"
                                >
                                  {t('Remove')}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                        {dispatchForm.items.length === 0 && (
                          <tr>
                            <td colSpan={4} className="px-4 py-6 text-center text-gray-400 text-xs">
                              {t('No items added yet. Add items above to dispatch.')}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              <div className="p-6 border-t border-gray-200 flex justify-end gap-3 bg-gray-50">
                <button
                  type="button"
                  onClick={handleCancelDispatchForm}
                  className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-100 text-gray-700 transition"
                >
                  {t('Cancel')}
                </button>
                <button
                  type="submit"
                  disabled={!dispatchForm.fromWarehouseId || !dispatchForm.toWarehouseId || dispatchForm.items.length === 0 || isSubmittingDispatch}
                  className="px-5 py-2 bg-indigo-600 text-white font-medium rounded-lg text-sm shadow-sm hover:bg-indigo-700 transition disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  {isSubmittingDispatch ? t('Dispatching...') : t('Confirm Dispatch & Deduct Stock')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* RECEIVING CONFIRM PANEL */}
      {receivingAgainstDispatch && (() => {
        const fromWh = warehouses.find(w => w.id === receivingAgainstDispatch.fromWarehouseId);
        const toWh = warehouses.find(w => w.id === receivingAgainstDispatch.toWarehouseId);
        return (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm w-full animate-fade-in">
            <div className="overflow-hidden flex flex-col">
              <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
                <div>
                  <h3 className="text-lg font-bold text-gray-900">{t('Receive Against Dispatch')}</h3>
                  <span className="text-sm font-semibold text-indigo-700 font-mono mt-0.5 inline-block">{receivingAgainstDispatch.dispatchNumber}</span>
                </div>
                <button
                  type="button"
                  onClick={handleCancelReceivingForm}
                  className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 bg-white transition"
                >
                  {t('Back to List')}
                </button>
              </div>
              <form onSubmit={handleSubmitReceiving} className="flex-1 flex flex-col">
                <div className="p-6 space-y-4">
                  <div className="bg-indigo-50 p-3.5 rounded-lg border border-indigo-100 text-sm text-indigo-900">
                    {t('From:')} <span className="font-semibold">{fromWh?.name || t('Unknown Warehouse')}</span> &nbsp;→&nbsp;
                    {t('To:')} <span className="font-semibold">{toWh?.name || t('Unknown Warehouse')}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Received By')}</label>
                      <input
                        type="text"
                        value={receivingForm.receivedBy}
                        readOnly
                        disabled
                        required
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-100 text-gray-400 cursor-not-allowed"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Condition')}</label>
                      <input
                        type="text"
                        placeholder={t('e.g. Good, Damaged packaging...')}
                        value={receivingForm.condition}
                        onChange={(e) => setReceivingForm({ ...receivingForm, condition: e.target.value })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Discrepancy Notes')}</label>
                      <input
                        type="text"
                        placeholder={t('Explain any quantity mismatch...')}
                        value={receivingForm.discrepancyNotes}
                        onChange={(e) => setReceivingForm({ ...receivingForm, discrepancyNotes: e.target.value })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Notes')}</label>
                      <input
                        type="text"
                        placeholder={t('Internal notes...')}
                        value={receivingForm.notes}
                        onChange={(e) => setReceivingForm({ ...receivingForm, notes: e.target.value })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                      />
                    </div>
                  </div>

                  <div className="mt-4">
                    <h4 className="text-xs font-semibold text-gray-700 mb-2">{t('Confirm Received Quantities')}</h4>
                    <div className="border border-gray-100 rounded-lg overflow-hidden">
                      <table className="w-full text-left">
                        <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                          <tr>
                            <th className="px-4 py-2">{t('Product')}</th>
                            <th className="px-4 py-2 text-right">{t('Qty Dispatched')}</th>
                            <th className="px-4 py-2 text-right">{t('Qty Received')}</th>
                            <th className="px-4 py-2 text-right">{t('Variance')}</th>
                            <th className="px-4 py-2">{t('Batch')}</th>
                          </tr>
                        </thead>
                        <tbody className="text-sm divide-y divide-gray-100 bg-white">
                          {receivingForm.items.map((item, idx) => {
                            const prod = products.find(p => p.id === item.productId);
                            const variance = item.quantityReceived - item.quantityDispatched;
                            return (
                              <tr key={idx}>
                                <td className="px-4 py-2 font-medium text-gray-900">{prod?.name || t('Unknown Product')}</td>
                                <td className="px-4 py-2 text-right text-gray-600">{item.quantityDispatched}</td>
                                <td className="px-4 py-2 text-right">
                                  <input
                                    type="number"
                                    min={0}
                                    value={item.quantityReceived}
                                    onChange={(e) => handleUpdateReceivingItemQty(idx, Number(e.target.value))}
                                    className="w-24 border border-gray-200 rounded-lg px-2 py-1 text-sm text-right bg-white"
                                  />
                                </td>
                                <td className={`px-4 py-2 text-right font-semibold ${variance === 0 ? 'text-gray-400' : variance < 0 ? 'text-rose-600' : 'text-amber-600'}`}>
                                  {variance > 0 ? `+${variance}` : variance}
                                </td>
                                <td className="px-4 py-2 text-gray-600 text-xs font-mono">{item.batchNumber || '-'}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
                <div className="p-6 border-t border-gray-200 flex justify-end gap-3 bg-gray-50">
                  <button
                    type="button"
                    onClick={handleCancelReceivingForm}
                    className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-100 text-gray-700 transition"
                  >
                    {t('Cancel')}
                  </button>
                  <button
                    type="submit"
                    disabled={receivingForm.items.length === 0 || isSubmittingReceiving}
                    className="px-5 py-2 bg-emerald-600 text-white font-medium rounded-lg text-sm shadow-sm hover:bg-emerald-700 transition disabled:bg-gray-300 disabled:cursor-not-allowed"
                  >
                    {isSubmittingReceiving ? t('Recording...') : t('Confirm Receiving & Update Stock')}
                  </button>
                </div>
              </form>
            </div>
          </div>
        );
      })()}

      {/* CREATE WAREHOUSE PANEL */}
      {isCreatingWarehouse && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm w-full animate-fade-in">
          <div className="overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
              <h3 className="text-lg font-bold text-gray-900">{t('Add Warehouse Location')}</h3>
              <button 
                onClick={() => setIsCreatingWarehouse(false)} 
                className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 bg-white transition"
              >
                {t('Back to List')}
              </button>
            </div>
            <form onSubmit={handleCreateWarehouse}>
              <div className="p-6 space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Location/Warehouse Name')}</label>
                  <input
                    type="text"
                    required
                    placeholder={t('e.g. Laser Cut Sub-Store')}
                    value={warehouseForm.name}
                    onChange={(e) => setWarehouseForm({ ...warehouseForm, name: e.target.value })}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Unique Code')}</label>
                  <input
                    type="text"
                    required
                    placeholder={t('e.g. WH-SUB')}
                    value={warehouseForm.code}
                    onChange={(e) => setWarehouseForm({ ...warehouseForm, code: e.target.value })}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-indigo-500 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Street Address/Notes')}</label>
                  <input
                    type="text"
                    placeholder={t('Old Industrial Area, Gate 4')}
                    value={warehouseForm.address}
                    onChange={(e) => setWarehouseForm({ ...warehouseForm, address: e.target.value })}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-indigo-500"
                  />
                </div>
              </div>
              <div className="p-6 border-t border-gray-200 flex justify-end gap-3 bg-gray-50">
                <button
                  type="button"
                  onClick={() => setIsCreatingWarehouse(false)}
                  className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-100 text-gray-700 transition"
                >
                  {t('Cancel')}
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingWarehouse}
                  className="px-5 py-2 bg-indigo-600 text-white font-medium rounded-lg text-sm shadow-sm hover:bg-indigo-700 transition disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  {isSubmittingWarehouse ? t('Registering...') : t('Register Warehouse')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ADJUST STOCK PANEL */}
      {isAdjustingStock && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm w-full animate-fade-in">
          <div className="overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
              <h3 className="text-lg font-bold text-gray-900">{t('Material Stock Adjustment')}</h3>
              <button 
                onClick={() => setIsAdjustingStock(false)} 
                className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 bg-white transition"
              >
                {t('Back to List')}
              </button>
            </div>
            <form onSubmit={handleStockAdjustment}>
              <div className="p-6 space-y-4">
                <div className="p-3 bg-amber-50 rounded-lg border border-amber-100 text-amber-800 text-xs flex gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0 text-amber-600" />
                  <p>{t('Warning: Adjustments will directly update warehouse stock records. Use positive values for additions, and negative values for deductions.')}</p>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Select Product')}</label>
                  <select
                    value={adjustmentForm.productId}
                    onChange={(e) => setAdjustmentForm({ ...adjustmentForm, productId: e.target.value })}
                    required
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                  >
                    <option value="">{t('-- Choose Material --')}</option>
                    {products.map(p => (
                      <option key={p.id} value={p.id}>{p.name} ({p.sku || 'N/A'})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Warehouse')}</label>
                  <select
                    value={adjustmentForm.warehouseId}
                    onChange={(e) => setAdjustmentForm({ ...adjustmentForm, warehouseId: e.target.value })}
                    required
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                  >
                    {warehouses.map(wh => (
                      <option key={wh.id} value={wh.id}>{wh.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Batch Number (Optional)')}</label>
                  <input
                    type="text"
                    placeholder="e.g. BATCH-A99"
                    value={adjustmentForm.batchNumber}
                    onChange={(e) => setAdjustmentForm({ ...adjustmentForm, batchNumber: e.target.value })}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Quantity Adjustment')}</label>
                  <input
                    type="number"
                    required
                    placeholder="e.g. 10 or -5"
                    value={adjustmentForm.quantity || ''}
                    onChange={(e) => setAdjustmentForm({ ...adjustmentForm, quantity: Number(e.target.value) })}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">{t('Reason for Adjustment')}</label>
                  <input
                    type="text"
                    required
                    placeholder={t('e.g. Stock count discrepancy, damaged item')}
                    value={adjustmentForm.reason}
                    onChange={(e) => setAdjustmentForm({ ...adjustmentForm, reason: e.target.value })}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  />
                </div>
              </div>
              <div className="p-6 border-t border-gray-200 flex justify-end gap-3 bg-gray-50">
                <button
                  type="button"
                  onClick={() => setIsAdjustingStock(false)}
                  className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-100 text-gray-700 transition"
                >
                  {t('Cancel')}
                </button>
                <button
                  type="submit"
                  disabled={!adjustmentForm.productId || !adjustmentForm.quantity || isSubmittingAdjustment}
                  className="px-5 py-2 bg-indigo-600 text-white font-medium rounded-lg text-sm shadow-sm hover:bg-indigo-700 transition disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  {isSubmittingAdjustment ? t('Applying...') : t('Apply Adjustment')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* PURCHASE BILL VIEW DETAIL PANEL */}
      {viewingBill && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm w-full animate-fade-in">
          <div className="overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
              <div>
                <h3 className="text-lg font-bold text-gray-900">{t('Purchase Bill Details')}</h3>
                <span className="text-sm font-semibold text-indigo-700 font-mono mt-0.5 inline-block">{viewingBill.billNumber}</span>
              </div>
              <button onClick={() => setViewingBill(null)} className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 bg-white transition">
                {t('Back to List')}
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-gray-500">{t('Vendor:')}</span>
                  <p className="font-semibold text-gray-900 mt-0.5">{vendors.find(v => v.id === viewingBill.vendorId)?.name || t('Unknown Vendor')}</p>
                </div>
                <div>
                  <span className="text-gray-500">{t('Due Date:')}</span>
                  <p className="font-semibold text-gray-900 mt-0.5">{viewingBill.dueDate ? new Date(viewingBill.dueDate).toLocaleDateString() : '-'}</p>
                </div>
                <div className="col-span-2">
                  <span className="text-gray-500">{t('Referenced Receipts (GRN):')}</span>
                  <p className="font-semibold text-gray-900 mt-0.5 font-mono">
                    {viewingBill.grnIds.split(',').filter(Boolean).map(id => goodsReceiptNotes.find(g => g.id === id)?.grnNumber || id).join(', ')}
                  </p>
                </div>
              </div>
              <div className="mt-4 flex flex-col items-end gap-1.5 text-sm font-semibold text-gray-700 border-t border-gray-100 pt-4">
                <div>{t('Subtotal (excl. tax):')} &nbsp;<span className="font-bold text-gray-900">{viewingBill.subTotal.toFixed(2)} {currency}</span></div>
                <div>{t('VAT Total:')} &nbsp;<span className="font-bold text-gray-900">{viewingBill.taxTotal.toFixed(2)} {currency}</span></div>
                <div className="text-lg font-bold text-indigo-700">{t('Grand Total:')} &nbsp;<span>{viewingBill.grandTotal.toFixed(2)} {currency}</span></div>
                <div className="text-emerald-700">{t('Paid:')} &nbsp;<span className="font-bold">{viewingBill.amountPaid.toFixed(2)} {currency}</span></div>
                {(viewingBill.grandTotal - viewingBill.amountPaid) > 0.004 && (
                  <div className="text-rose-600">{t('Balance Due:')} &nbsp;<span className="font-bold">{(viewingBill.grandTotal - viewingBill.amountPaid).toFixed(2)} {currency}</span></div>
                )}
              </div>
            </div>
            <div className="p-6 border-t border-gray-200 flex justify-between bg-gray-50">
              <button onClick={() => setViewingBill(null)} className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-100 text-gray-700 transition">
                {t('Close')}
              </button>
              <div className="flex gap-2">
                {viewingBill.status === 'Unpaid' && can('purchaseBills.delete') && (
                  <button onClick={() => handleCancelBill(viewingBill)} className="px-4 py-2 bg-rose-50 text-rose-700 rounded-lg text-sm font-medium hover:bg-rose-100 transition">
                    {t('Cancel Bill')}
                  </button>
                )}
                {(viewingBill.status === 'Unpaid' || viewingBill.status === 'Partially Paid') && can('purchaseBills.update') && (
                  <button
                    onClick={() => { setIsPayingBill(viewingBill); setPayBillForm({ date: new Date().toISOString().split('T')[0], amount: '', bankId: viewingBill.bankId || db.banks.find(b => b.isDefault)?.id || '' }); }}
                    className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 transition"
                  >
                    {t('Record Payment')}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* PAY BILL MODAL */}
      {isPayingBill && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex justify-center items-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl border border-slate-100 shadow-2xl p-6 w-full max-w-sm my-auto">
            <h3 className="font-bold text-sm text-slate-900 mb-1">{t('Record Bill Payment')}</h3>
            <p className="text-xs text-slate-400 mb-4">
              {isPayingBill.billNumber} — {t('Remaining:')} {(isPayingBill.grandTotal - isPayingBill.amountPaid).toFixed(2)} {currency}
            </p>
            <form onSubmit={handlePayBill} className="space-y-4 text-xs">
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Payment Date')}</label>
                <input type="date" required value={payBillForm.date} onChange={(e) => setPayBillForm({ ...payBillForm, date: e.target.value })}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Disbursement Bank')}</label>
                {isAdmin ? (
                  <select required value={payBillForm.bankId} onChange={(e) => setPayBillForm({ ...payBillForm, bankId: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500">
                    {db.banks.filter(b => b.isActive).map(b => (
                      <option key={b.id} value={b.id}>{b.bankName}</option>
                    ))}
                  </select>
                ) : (
                  <div className="w-full bg-slate-100 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-500 font-semibold">
                    {db.banks.find(b => b.id === payBillForm.bankId)?.bankName || t('Default Bank')}
                  </div>
                )}
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Amount')} ({currency}) — {t('leave blank to pay in full')}</label>
                <input type="number" step="0.01" min="0" value={payBillForm.amount} onChange={(e) => setPayBillForm({ ...payBillForm, amount: e.target.value })}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setIsPayingBill(null)} className="px-3 py-1.5 bg-slate-100 text-slate-500 rounded-lg text-xs font-semibold hover:bg-slate-200 transition">
                  {t('Cancel')}
                </button>
                <button type="submit" disabled={isSubmittingBill} className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold transition shadow-sm disabled:opacity-60">
                  {isSubmittingBill ? t('Saving...') : t('Record Payment')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CREATE PURCHASE BILL PANEL */}
      {isCreatingBill && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm w-full animate-fade-in">
          <div className="overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
              <h3 className="text-lg font-bold text-gray-900">{t('New Purchase Bill')}</h3>
              <button onClick={handleCancelBillForm} className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 bg-white transition">
                {t('Back to List')}
              </button>
            </div>
            <form onSubmit={handleCreateBill} className="flex-1 flex flex-col">
              <div className="p-6 space-y-4">
                <p className="text-xs text-gray-500">{t('Select one or more un-billed receipts from the same vendor. Totals are computed automatically from what was actually received.')}</p>
                <div className="border border-gray-100 rounded-lg overflow-hidden max-h-72 overflow-y-auto">
                  {billableGrns.length === 0 ? (
                    <div className="p-6 text-center text-gray-400 text-xs">{t('No un-billed receipts available.')}</div>
                  ) : (
                    billableGrns.map(g => {
                      const vend = vendors.find(v => v.id === g.vendorId);
                      const checked = billForm.grnIds.includes(g.id);
                      return (
                        <label key={g.id} className={`flex items-center justify-between px-4 py-2.5 text-xs border-b border-gray-50 last:border-b-0 cursor-pointer ${checked ? 'bg-indigo-50' : 'hover:bg-gray-50'}`}>
                          <span className="flex items-center gap-2">
                            <input type="checkbox" checked={checked} onChange={() => toggleBillGrn(g.id)} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
                            <span className="font-semibold text-gray-900">{g.grnNumber}</span>
                          </span>
                          <span className="text-gray-500">{vend?.name || t('Unknown Vendor')} • {new Date(g.date).toLocaleDateString()}</span>
                        </label>
                      );
                    })
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-gray-400 uppercase">{t('Due Date')}</label>
                    <input type="date" value={billForm.dueDate} onChange={(e) => setBillForm({ ...billForm, dueDate: e.target.value })}
                      className="w-full bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs text-gray-800 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-gray-400 uppercase">{t('Payment Bank Account')}</label>
                    <select value={billForm.bankId} onChange={(e) => setBillForm({ ...billForm, bankId: e.target.value })}
                      className="w-full bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs text-gray-800 focus:outline-none focus:ring-1 focus:ring-indigo-500">
                      <option value="">{t('Select bank')}</option>
                      {banks.map(b => <option key={b.id} value={b.id}>{b.bankName}</option>)}
                    </select>
                  </div>
                </div>
              </div>
              <div className="p-6 border-t border-gray-200 flex justify-end gap-3 bg-gray-50">
                <button type="button" onClick={handleCancelBillForm} className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-100 text-gray-700 transition">
                  {t('Cancel')}
                </button>
                <button type="submit" disabled={billForm.grnIds.length === 0 || isSubmittingBill} className="px-5 py-2 bg-indigo-600 text-white font-medium rounded-lg text-sm shadow-sm hover:bg-indigo-700 transition disabled:bg-gray-300 disabled:cursor-not-allowed">
                  {isSubmittingBill ? t('Creating...') : t('Create Bill')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* PURCHASE RETURN VIEW DETAIL PANEL */}
      {viewingReturn && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm w-full animate-fade-in">
          <div className="overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
              <div>
                <h3 className="text-lg font-bold text-gray-900">{t('Purchase Return Details')}</h3>
                <span className="text-sm font-semibold text-indigo-700 font-mono mt-0.5 inline-block">{viewingReturn.returnNumber}</span>
              </div>
              <button onClick={() => setViewingReturn(null)} className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 bg-white transition">
                {t('Back to List')}
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-gray-500">{t('Vendor:')}</span>
                  <p className="font-semibold text-gray-900 mt-0.5">{vendors.find(v => v.id === viewingReturn.vendorId)?.name || t('Unknown Vendor')}</p>
                </div>
                <div>
                  <span className="text-gray-500">{t('Linked GRN:')}</span>
                  <p className="font-semibold text-gray-900 mt-0.5 font-mono">{goodsReceiptNotes.find(g => g.id === viewingReturn.grnId)?.grnNumber || '-'}</p>
                </div>
                <div className="col-span-2">
                  <span className="text-gray-500">{t('Notes:')}</span>
                  <p className="text-gray-700 mt-0.5 bg-gray-50 p-2.5 rounded border border-gray-100">{viewingReturn.notes || '-'}</p>
                </div>
              </div>
              <div className="mt-4">
                <h4 className="text-sm font-semibold text-gray-700 mb-2">{t('Returned Items')}</h4>
                <div className="border border-gray-100 rounded-lg overflow-hidden">
                  <table className="w-full text-left">
                    <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                      <tr>
                        <th className="px-4 py-2">{t('Product')}</th>
                        <th className="px-4 py-2 text-right">{t('Qty Returned')}</th>
                        <th className="px-4 py-2">{t('Batch')}</th>
                      </tr>
                    </thead>
                    <tbody className="text-sm divide-y divide-gray-100">
                      {(viewingReturn.items || []).map((item, idx) => {
                        const prod = products.find(p => p.id === item.productId);
                        return (
                          <tr key={idx}>
                            <td className="px-4 py-2 font-medium text-gray-900">{prod?.name || t('Unknown Product')}</td>
                            <td className="px-4 py-2 text-right font-bold text-rose-600">{item.quantityReturned}</td>
                            <td className="px-4 py-2 text-gray-600 text-xs font-mono">{item.batchNumber || '-'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            <div className="p-6 border-t border-gray-200 flex justify-between bg-gray-50">
              <button onClick={() => setViewingReturn(null)} className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-100 text-gray-700 transition">
                {t('Close')}
              </button>
              {viewingReturn.status === 'Active' && can('purchaseReturns.delete') && (
                <button onClick={() => handleCancelReturn(viewingReturn.id)} className="px-4 py-2 bg-rose-50 text-rose-700 rounded-lg text-sm font-medium hover:bg-rose-100 transition">
                  {t('Cancel Return')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* CREATE PURCHASE RETURN PANEL */}
      {isCreatingReturn && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm w-full animate-fade-in">
          <div className="overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
              <h3 className="text-lg font-bold text-gray-900">{t('New Purchase Return')}</h3>
              <button onClick={handleCancelReturnForm} className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 bg-white transition">
                {t('Back to List')}
              </button>
            </div>
            <form onSubmit={handleCreateReturn} className="flex-1 flex flex-col">
              <div className="p-6 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-gray-400 uppercase">{t('Goods Receipt Note')}</label>
                    <select required value={returnForm.grnId} onChange={(e) => setReturnForm({ ...returnForm, grnId: e.target.value })}
                      className="w-full bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs text-gray-800 focus:outline-none focus:ring-1 focus:ring-indigo-500">
                      <option value="">{t('Select receipt')}</option>
                      {goodsReceiptNotes.filter(g => !g.isReversed).map(g => <option key={g.id} value={g.id}>{g.grnNumber}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-gray-400 uppercase">{t('Notes')}</label>
                    <input type="text" value={returnForm.notes} onChange={(e) => setReturnForm({ ...returnForm, notes: e.target.value })}
                      className="w-full bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs text-gray-800 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                  </div>
                </div>

                <div className="border-t border-gray-100 pt-4">
                  <h4 className="text-xs font-bold text-gray-700 uppercase mb-2">{t('Returned Items')}</h4>
                  <input
                    type="text"
                    placeholder={t('Scan or type a barcode — resolves the product and its unit automatically')}
                    value={returnBarcodeInput}
                    onChange={(e) => setReturnBarcodeInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return;
                      e.preventDefault();
                      const resolved = resolveProductByCode(returnBarcodeInput);
                      if (!resolved) { triggerError(t('No product matches that barcode/SKU.')); return; }
                      setNewReturnItem({ ...newReturnItem, productId: resolved.productId, unitOfMeasureId: resolved.unitOfMeasureId || '' });
                      setReturnBarcodeInput('');
                    }}
                    className="w-full bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs mb-2"
                  />
                  <div className="grid grid-cols-12 gap-2 items-end mb-3">
                    <div className="col-span-4 space-y-1">
                      <label className="text-[9px] font-bold text-gray-400 uppercase">{t('Product')}</label>
                      <select value={newReturnItem.productId} onChange={(e) => setNewReturnItem({ ...newReturnItem, productId: e.target.value, unitOfMeasureId: '' })}
                        className="w-full bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 text-xs">
                        <option value="">{t('Select product')}</option>
                        {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </div>
                    <div className="col-span-2 space-y-1">
                      <label className="text-[9px] font-bold text-gray-400 uppercase">{t('Unit')}</label>
                      <select value={newReturnItem.unitOfMeasureId} onChange={(e) => setNewReturnItem({ ...newReturnItem, unitOfMeasureId: e.target.value })}
                        className="w-full bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 text-xs">
                        <option value="">{t('Base Unit')}</option>
                        {(db.productUnitConversions || []).filter(puc => puc.productId === newReturnItem.productId && puc.isActive !== false).map(puc => {
                          const uom = (db.unitsOfMeasure || []).find(u => u.id === puc.unitOfMeasureId);
                          return <option key={puc.id} value={puc.unitOfMeasureId}>{uom ? uom.name : t('Unit')} (×{puc.conversionFactor})</option>;
                        })}
                      </select>
                    </div>
                    <div className="col-span-3 space-y-1">
                      <label className="text-[9px] font-bold text-gray-400 uppercase">{t('Quantity')}</label>
                      <input type="number" min="0.001" step="0.001" value={newReturnItem.quantityReturned}
                        onChange={(e) => setNewReturnItem({ ...newReturnItem, quantityReturned: parseFloat(e.target.value) || 0 })}
                        className="w-full bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 text-xs" />
                    </div>
                    <div className="col-span-2 space-y-1">
                      <label className="text-[9px] font-bold text-gray-400 uppercase">{t('Batch')}</label>
                      <input type="text" value={newReturnItem.batchNumber} onChange={(e) => setNewReturnItem({ ...newReturnItem, batchNumber: e.target.value })}
                        className="w-full bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 text-xs" />
                    </div>
                    <div className="col-span-1">
                      <button type="button" onClick={addReturnItem} className="w-full p-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition">
                        <Plus className="h-4 w-4 mx-auto" />
                      </button>
                    </div>
                  </div>
                  <div className="border border-gray-100 rounded-lg overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <tbody className="divide-y divide-gray-100">
                        {returnForm.items.map((item, idx) => {
                          const prod = products.find(p => p.id === item.productId);
                          return (
                            <tr key={idx}>
                              <td className="px-3 py-2 font-medium text-gray-900">{prod?.name}</td>
                              <td className="px-3 py-2 text-right">{item.quantityReturned}</td>
                              <td className="px-3 py-2 text-gray-500 font-mono">{item.batchNumber || '-'}</td>
                              <td className="px-3 py-2 text-right">
                                <button type="button" onClick={() => removeReturnItem(idx)} className="text-rose-500 hover:text-rose-700">
                                  <XCircle className="h-4 w-4" />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                        {returnForm.items.length === 0 && (
                          <tr><td colSpan={4} className="px-3 py-4 text-center text-gray-400">{t('No items added yet.')}</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              <div className="p-6 border-t border-gray-200 flex justify-end gap-3 bg-gray-50">
                <button type="button" onClick={handleCancelReturnForm} className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-100 text-gray-700 transition">
                  {t('Cancel')}
                </button>
                <button type="submit" disabled={!returnForm.grnId || returnForm.items.length === 0 || isSubmittingReturn} className="px-5 py-2 bg-indigo-600 text-white font-medium rounded-lg text-sm shadow-sm hover:bg-indigo-700 transition disabled:bg-gray-300 disabled:cursor-not-allowed">
                  {isSubmittingReturn ? t('Recording...') : t('Record Return')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* PHYSICAL STOCK TAKE VIEW DETAIL PANEL */}
      {viewingStockTake && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm w-full animate-fade-in">
          <div className="overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
              <div>
                <h3 className="text-lg font-bold text-gray-900">{t('Stock Take Details')}</h3>
                <span className="text-sm font-semibold text-indigo-700 font-mono mt-0.5 inline-block">{viewingStockTake.referenceNumber}</span>
              </div>
              <button onClick={() => setViewingStockTake(null)} className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 bg-white transition">
                {t('Back to List')}
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-gray-500">{t('Warehouse:')}</span>
                  <p className="font-semibold text-gray-900 mt-0.5">{warehouses.find(w => w.id === viewingStockTake.warehouseId)?.name || t('Unknown Warehouse')}</p>
                </div>
                <div>
                  <span className="text-gray-500">{t('Performed By:')}</span>
                  <p className="font-semibold text-gray-900 mt-0.5">{viewingStockTake.performedBy}</p>
                </div>
              </div>
              <div className="mt-4">
                <h4 className="text-sm font-semibold text-gray-700 mb-2">{t('Counted Items')}</h4>
                <div className="border border-gray-100 rounded-lg overflow-hidden">
                  <table className="w-full text-left">
                    <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                      <tr>
                        <th className="px-4 py-2">{t('Product')}</th>
                        <th className="px-4 py-2 text-right">{t('System Qty')}</th>
                        <th className="px-4 py-2 text-right">{t('Physical Qty')}</th>
                        <th className="px-4 py-2 text-right">{t('Variance')}</th>
                      </tr>
                    </thead>
                    <tbody className="text-sm divide-y divide-gray-100">
                      {(viewingStockTake.items || []).map((item, idx) => {
                        const prod = products.find(p => p.id === item.productId);
                        return (
                          <tr key={idx}>
                            <td className="px-4 py-2 font-medium text-gray-900">{prod?.name || t('Unknown Product')}</td>
                            <td className="px-4 py-2 text-right text-gray-600">{item.systemQuantity}</td>
                            <td className="px-4 py-2 text-right font-bold text-gray-900">{item.physicalQuantity}</td>
                            <td className={`px-4 py-2 text-right font-bold ${item.variance > 0 ? 'text-emerald-600' : item.variance < 0 ? 'text-rose-600' : 'text-gray-400'}`}>
                              {item.variance > 0 ? '+' : ''}{item.variance}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            <div className="p-6 border-t border-gray-200 flex justify-between bg-gray-50">
              <button onClick={() => setViewingStockTake(null)} className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-100 text-gray-700 transition">
                {t('Close')}
              </button>
              {viewingStockTake.status === 'Draft' && (
                <div className="flex gap-2">
                  {can('stockTakes.delete') && (
                    <button onClick={() => handleCancelStockTake(viewingStockTake.id)} className="px-4 py-2 bg-rose-50 text-rose-700 rounded-lg text-sm font-medium hover:bg-rose-100 transition">
                      {t('Cancel')}
                    </button>
                  )}
                  {can('stockTakes.update') && (
                    <button onClick={() => handleFinalizeStockTake(viewingStockTake.id)} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 transition">
                      {t('Finalize & Post Adjustments')}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* CREATE STOCK TAKE PANEL */}
      {isCreatingStockTake && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm w-full animate-fade-in">
          <div className="overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
              <h3 className="text-lg font-bold text-gray-900">{t('New Stock Take')}</h3>
              <button
                onClick={handleCancelStockTakeForm}
                className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 bg-white transition"
              >
                {t('Back to List')}
              </button>
            </div>
            <form onSubmit={handleCreateStockTake} className="flex-1 flex flex-col">
              <div className="p-6 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-gray-400 uppercase">{t('Warehouse')}</label>
                    <select required value={stockTakeForm.warehouseId} onChange={(e) => setStockTakeForm({ ...stockTakeForm, warehouseId: e.target.value })}
                      className="w-full bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs text-gray-800 focus:outline-none focus:ring-1 focus:ring-indigo-500">
                      {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-gray-400 uppercase">{t('Performed By')}</label>
                    <input type="text" required value={stockTakeForm.performedBy} onChange={(e) => setStockTakeForm({ ...stockTakeForm, performedBy: e.target.value })}
                      className="w-full bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs text-gray-800 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                  </div>
                </div>

                <div className="border-t border-gray-100 pt-4">
                  <h4 className="text-xs font-bold text-gray-700 uppercase mb-2">{t('Counted Items')}</h4>
                  <p className="text-[10px] text-gray-400 mb-2">{t('The current system quantity is snapshotted automatically when you add an item — you only enter what was physically counted.')}</p>
                  <input
                    type="text"
                    placeholder={t('Scan or type a barcode — resolves the product and its unit automatically')}
                    value={stockTakeBarcodeInput}
                    onChange={(e) => setStockTakeBarcodeInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return;
                      e.preventDefault();
                      const resolved = resolveProductByCode(stockTakeBarcodeInput);
                      if (!resolved) { triggerError(t('No product matches that barcode/SKU.')); return; }
                      setNewStockTakeItem({ ...newStockTakeItem, productId: resolved.productId, unitOfMeasureId: resolved.unitOfMeasureId || '' });
                      setStockTakeBarcodeInput('');
                    }}
                    className="w-full bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs mb-2"
                  />
                  <div className="grid grid-cols-12 gap-2 items-end mb-3">
                    <div className="col-span-4 space-y-1">
                      <label className="text-[9px] font-bold text-gray-400 uppercase">{t('Product')}</label>
                      <select value={newStockTakeItem.productId} onChange={(e) => setNewStockTakeItem({ ...newStockTakeItem, productId: e.target.value, unitOfMeasureId: '' })}
                        className="w-full bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 text-xs">
                        <option value="">{t('Select product')}</option>
                        {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </div>
                    <div className="col-span-2 space-y-1">
                      <label className="text-[9px] font-bold text-gray-400 uppercase">{t('Unit')}</label>
                      <select value={newStockTakeItem.unitOfMeasureId} onChange={(e) => setNewStockTakeItem({ ...newStockTakeItem, unitOfMeasureId: e.target.value })}
                        className="w-full bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 text-xs">
                        <option value="">{t('Base Unit')}</option>
                        {(db.productUnitConversions || []).filter(puc => puc.productId === newStockTakeItem.productId && puc.isActive !== false).map(puc => {
                          const uom = (db.unitsOfMeasure || []).find(u => u.id === puc.unitOfMeasureId);
                          return <option key={puc.id} value={puc.unitOfMeasureId}>{uom ? uom.name : t('Unit')} (×{puc.conversionFactor})</option>;
                        })}
                      </select>
                    </div>
                    <div className="col-span-3 space-y-1">
                      <label className="text-[9px] font-bold text-gray-400 uppercase">{t('Physical Qty')}</label>
                      <input type="number" min="0" step="0.001" value={newStockTakeItem.physicalQuantity}
                        onChange={(e) => setNewStockTakeItem({ ...newStockTakeItem, physicalQuantity: parseFloat(e.target.value) || 0 })}
                        className="w-full bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 text-xs" />
                    </div>
                    <div className="col-span-2 space-y-1">
                      <label className="text-[9px] font-bold text-gray-400 uppercase">{t('Batch')}</label>
                      <input type="text" value={newStockTakeItem.batchNumber} onChange={(e) => setNewStockTakeItem({ ...newStockTakeItem, batchNumber: e.target.value })}
                        className="w-full bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 text-xs" />
                    </div>
                    <div className="col-span-1">
                      <button type="button" onClick={addStockTakeItem} className="w-full p-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition">
                        <Plus className="h-4 w-4 mx-auto" />
                      </button>
                    </div>
                  </div>
                  <div className="border border-gray-100 rounded-lg overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <tbody className="divide-y divide-gray-100">
                        {stockTakeForm.items.map((item, idx) => {
                          const prod = products.find(p => p.id === item.productId);
                          return (
                            <tr key={idx}>
                              <td className="px-3 py-2 font-medium text-gray-900">{prod?.name}</td>
                              <td className="px-3 py-2 text-right">{item.physicalQuantity}</td>
                              <td className="px-3 py-2 text-gray-500 font-mono">{item.batchNumber || '-'}</td>
                              <td className="px-3 py-2 text-right">
                                <button type="button" onClick={() => removeStockTakeItem(idx)} className="text-rose-500 hover:text-rose-700">
                                  <XCircle className="h-4 w-4" />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                        {stockTakeForm.items.length === 0 && (
                          <tr><td colSpan={4} className="px-3 py-4 text-center text-gray-400">{t('No items counted yet.')}</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              <div className="p-6 border-t border-gray-200 flex justify-end gap-3 bg-gray-50">
                <button
                  type="button"
                  onClick={handleCancelStockTakeForm}
                  className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-100 text-gray-700 transition"
                >
                  {t('Cancel')}
                </button>
                <button type="submit" disabled={!stockTakeForm.warehouseId || stockTakeForm.items.length === 0 || isSubmittingStockTake} className="px-5 py-2 bg-indigo-600 text-white font-medium rounded-lg text-sm shadow-sm hover:bg-indigo-700 transition disabled:bg-gray-300 disabled:cursor-not-allowed">
                  {isSubmittingStockTake ? t('Starting...') : t('Start Stock Take')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
