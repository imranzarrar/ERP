import React from 'react';
import { useTranslation, usePermissions } from '../hooks';
import { DatabaseState, generateId } from '../dbStore';
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
  Vendor
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
  PackageCheck
} from 'lucide-react';

interface InventoryModuleProps {
  db: DatabaseState;
  onUpdateDb: (updated: any) => void;
  currentUser: any;
  defaultTab?: 'stock' | 'pr' | 'po' | 'grn' | 'warehouses';
}

export default function InventoryModule({ 
  db, 
  onUpdateDb, 
  currentUser,
  defaultTab = 'stock' 
}: InventoryModuleProps) {
  const { t } = useTranslation(db);
  const { can } = usePermissions(currentUser);
  const companyId = db.selectedCompanyId;

  // State
  const [activeSubTab, setActiveSubTab] = React.useState<'stock' | 'pr' | 'po' | 'grn' | 'warehouses'>(defaultTab);
  
  // Lists from state filtered by current company
  const warehouses = (db.warehouses || []).filter(w => w.companyId === companyId);
  const purchaseRequisitions = (db.purchaseRequisitions || []).filter(pr => pr.companyId === companyId);
  const purchaseOrders = (db.purchaseOrders || []).filter(po => po.companyId === companyId);
  const goodsReceiptNotes = (db.goodsReceiptNotes || []).filter(grn => grn.companyId === companyId);
  const inventoryStocks = (db.inventoryStocks || []).filter(s => s.companyId === companyId);
  const products = (db.products || []).filter(p => p.companyId === companyId);
  const vendors = (db.vendors || []).filter(v => v.companyId === companyId);

  // Search & Filters
  const [searchQuery, setSearchQuery] = React.useState('');
  const [warehouseFilter, setWarehouseFilter] = React.useState('all');

  // Detail / View modals
  const [viewingPr, setViewingPr] = React.useState<PurchaseRequisition | null>(null);
  const [viewingPo, setViewingPo] = React.useState<PurchaseOrder | null>(null);
  const [viewingGrn, setViewingGrn] = React.useState<GoodsReceiptNote | null>(null);

  // Creation Modals
  const [isCreatingPr, setIsCreatingPr] = React.useState(false);
  const [isCreatingPo, setIsCreatingPo] = React.useState(false);
  const [isCreatingGrn, setIsCreatingGrn] = React.useState(false);
  const [isCreatingWarehouse, setIsCreatingWarehouse] = React.useState(false);
  const [isAdjustingStock, setIsAdjustingStock] = React.useState(false);

  // PR Form State
  const [prForm, setPrForm] = React.useState({
    requestedBy: currentUser?.username || '',
    notes: '',
    items: [] as Array<{ productId: string; quantity: number; purpose: string }>
  });
  const [newPrItem, setNewPrItem] = React.useState({ productId: '', quantity: 1, purpose: '' });

  // PO Form State
  const [poForm, setPoForm] = React.useState({
    vendorId: '',
    requisitionId: '', // Optional
    deliveryDate: '',
    notes: '',
    items: [] as Array<{ productId: string; quantityOrdered: number; unitPrice: number; taxRate: number }>
  });
  const [newPoItem, setNewPoItem] = React.useState({ productId: '', quantityOrdered: 1, unitPrice: 0, taxRate: 17 });

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
    items: [] as Array<{ productId: string; quantityReceived: number; unitCost: number; taxRate: number; batchNumber: string; expiryDate: string }>
  });
  const [newGrnItem, setNewGrnItem] = React.useState({ productId: '', quantityReceived: 1, unitCost: 0, taxRate: 15, batchNumber: '', expiryDate: '' });

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

  // Automatically update activeSubTab if defaultTab changes
  React.useEffect(() => {
    setActiveSubTab(defaultTab);
  }, [defaultTab]);

  // Sync logged-in user to form states
  React.useEffect(() => {
    if (currentUser?.username) {
      setPrForm(prev => ({ ...prev, requestedBy: currentUser.username }));
      setGrnForm(prev => ({ ...prev, receivedBy: currentUser.username }));
    }
  }, [currentUser]);

  // Close active forms when companyId changes
  React.useEffect(() => {
    setIsCreatingPr(false);
    setViewingPr(null);
    setIsCreatingPo(false);
    setViewingPo(null);
    setIsCreatingGrn(false);
    setViewingGrn(null);
    setIsCreatingWarehouse(false);
    setIsAdjustingStock(false);
  }, [companyId]);

  const isFormOrDetailOpen = !!(
    isCreatingPr || viewingPr || 
    isCreatingPo || viewingPo || 
    isCreatingGrn || viewingGrn || 
    isCreatingWarehouse || isAdjustingStock
  );

  // Handle Warehouse Creation
  const handleCreateWarehouse = (e: React.FormEvent) => {
    e.preventDefault();
    if (!warehouseForm.name || !warehouseForm.code) return;

    const newWh: Warehouse = {
      id: generateId(),
      name: warehouseForm.name,
      code: warehouseForm.code.toUpperCase(),
      address: warehouseForm.address,
      isActive: true,
      companyId
    };

    const updatedWarehouses = [...(db.warehouses || []), newWh];
    onUpdateDb({
      ...db,
      warehouses: updatedWarehouses
    });
    
    // Reset form
    setWarehouseForm({ name: '', code: '', address: '' });
    setIsCreatingWarehouse(false);
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

  // Create PR
  const handleCreatePr = (e: React.FormEvent) => {
    e.preventDefault();
    if (prForm.items.length === 0) return;

    const newPrId = generateId();
    const newPr: PurchaseRequisition = {
      id: newPrId,
      prNumber: `PR-${String((db.purchaseRequisitions || []).length + 1001)}`,
      requestedBy: prForm.requestedBy,
      date: new Date().toISOString(),
      status: 'Pending',
      notes: prForm.notes,
      companyId,
      items: prForm.items.map(item => ({
        id: generateId(),
        requisitionId: newPrId,
        productId: item.productId,
        quantity: item.quantity,
        purpose: item.purpose
      }))
    };

    onUpdateDb({
      ...db,
      purchaseRequisitions: [...(db.purchaseRequisitions || []), newPr]
    });

    setPrForm({ requestedBy: currentUser?.username || '', notes: '', items: [] });
    setIsCreatingPr(false);
  };

  // Approve / Reject PR (For Admins / Supervisors)
  const handlePrStatus = (prId: string, status: 'Approved' | 'Rejected') => {
    const updatedPrs = (db.purchaseRequisitions || []).map(pr => {
      if (pr.id === prId) {
        return { ...pr, status };
      }
      return pr;
    });
    onUpdateDb({
      ...db,
      purchaseRequisitions: updatedPrs
    });
    setViewingPr(null);
  };

  // Handle PO Item Actions
  const addPoItem = () => {
    if (!newPoItem.productId || newPoItem.quantityOrdered <= 0) return;
    setPoForm(prev => ({
      ...prev,
      items: [...prev.items, { ...newPoItem }]
    }));
    setNewPoItem({ productId: '', quantityOrdered: 1, unitPrice: 0, taxRate: 17 });
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
        unitPrice: Number(prod?.unitPrice || 0),
        taxRate: 17
      };
    });

    setPoForm(prev => ({
      ...prev,
      requisitionId: prId,
      items: poItems
    }));
  };

  // Create PO
  const handleCreatePo = (e: React.FormEvent) => {
    e.preventDefault();
    if (!poForm.vendorId || poForm.items.length === 0) return;

    const poId = generateId();
    const totalAmount = poForm.items.reduce((sum, item) => {
      const lineTotal = item.quantityOrdered * item.unitPrice;
      const tax = lineTotal * (item.taxRate / 100);
      return sum + lineTotal + tax;
    }, 0);

    const newPo: PurchaseOrder = {
      id: poId,
      poNumber: `PO-${String((db.purchaseOrders || []).length + 1001)}`,
      vendorId: poForm.vendorId,
      date: new Date().toISOString(),
      status: 'Sent',
      requisitionId: poForm.requisitionId || undefined,
      deliveryDate: poForm.deliveryDate || undefined,
      totalAmount,
      companyId,
      items: poForm.items.map(item => ({
        id: generateId(),
        purchaseOrderId: poId,
        productId: item.productId,
        quantityOrdered: item.quantityOrdered,
        unitPrice: item.unitPrice,
        taxRate: item.taxRate
      }))
    };

    // Also close the PR if linked
    let updatedPrs = db.purchaseRequisitions || [];
    if (poForm.requisitionId) {
      updatedPrs = updatedPrs.map(pr => {
        if (pr.id === poForm.requisitionId) {
          return { ...pr, status: 'Closed' as const };
        }
        return pr;
      });
    }

    onUpdateDb({
      ...db,
      purchaseOrders: [...(db.purchaseOrders || []), newPo],
      purchaseRequisitions: updatedPrs
    });

    setPoForm({ vendorId: '', requisitionId: '', deliveryDate: '', notes: '', items: [] });
    setIsCreatingPo(false);
  };

  // Cancel PO
  const handleCancelPo = (poId: string) => {
    const updatedPos = (db.purchaseOrders || []).map(po => {
      if (po.id === poId) {
        return { ...po, status: 'Cancelled' as const };
      }
      return po;
    });
    onUpdateDb({
      ...db,
      purchaseOrders: updatedPos
    });
    setViewingPo(null);
  };

  // Handle GRN Item Actions
  const addGrnItem = () => {
    if (!newGrnItem.productId || newGrnItem.quantityReceived <= 0) return;
    setGrnForm(prev => ({
      ...prev,
      items: [...prev.items, { ...newGrnItem }]
    }));
    setNewGrnItem({ productId: '', quantityReceived: 1, unitCost: 0, taxRate: 15, batchNumber: '', expiryDate: '' });
  };

  const removeGrnItem = (index: number) => {
    setGrnForm(prev => ({
      ...prev,
      items: prev.items.filter((_, i) => i !== index)
    }));
  };

  // Handle PO Selection in GRN
  const handleGrnPoSelect = (poId: string) => {
    const selectedPo = purchaseOrders.find(po => po.id === poId);
    if (!selectedPo) return;

    const grnItems = (selectedPo.items || []).map(item => {
      return {
        productId: item.productId,
        quantityReceived: item.quantityOrdered,
        unitCost: item.unitPrice,
        taxRate: item.taxRate || 0,
        batchNumber: '',
        expiryDate: ''
      };
    });

    setGrnForm(prev => ({
      ...prev,
      purchaseOrderId: poId,
      vendorId: selectedPo.vendorId,
      isDsd: false,
      items: grnItems
    }));
  };

  // Create GRN & Update Stock Levels automatically
  const handleCreateGrn = (e: React.FormEvent) => {
    e.preventDefault();
    if (!grnForm.warehouseId || grnForm.items.length === 0) return;

    const grnId = generateId();
    const newGrn: GoodsReceiptNote = {
      id: grnId,
      grnNumber: `GRN-${String((db.goodsReceiptNotes || []).length + 1001)}`,
      purchaseOrderId: grnForm.isDsd ? undefined : grnForm.purchaseOrderId || undefined,
      vendorId: grnForm.vendorId,
      warehouseId: grnForm.warehouseId,
      date: new Date().toISOString(),
      isDsd: grnForm.isDsd,
      receivedBy: grnForm.receivedBy,
      notes: grnForm.notes,
      vehicleNumber: grnForm.vehicleNumber || undefined,
      driverName: grnForm.driverName || undefined,
      companyId,
      items: grnForm.items.map(item => ({
        id: generateId(),
        grnId,
        productId: item.productId,
        quantityReceived: item.quantityReceived,
        unitCost: item.unitCost,
        taxRate: item.taxRate !== undefined ? item.taxRate : 0,
        batchNumber: item.batchNumber || undefined,
        expiryDate: item.expiryDate || undefined
      }))
    };

    // Update Stock Levels
    const currentStocks = [...(db.inventoryStocks || [])];
    newGrn.items?.forEach(item => {
      const match = currentStocks.find(s => 
        s.productId === item.productId &&
        s.warehouseId === newGrn.warehouseId &&
        s.batchNumber === item.batchNumber &&
        s.companyId === companyId
      );

      if (match) {
        match.quantity = Number(match.quantity) + Number(item.quantityReceived);
      } else {
        currentStocks.push({
          id: generateId(),
          productId: item.productId,
          warehouseId: newGrn.warehouseId,
          batchNumber: item.batchNumber,
          expiryDate: item.expiryDate,
          quantity: item.quantityReceived,
          companyId
        });
      }
    });

    // Update PO Status if linked
    let updatedPos = db.purchaseOrders || [];
    if (!grnForm.isDsd && grnForm.purchaseOrderId) {
      updatedPos = updatedPos.map(po => {
        if (po.id === grnForm.purchaseOrderId) {
          return { ...po, status: 'Received' as const };
        }
        return po;
      });
    }

    onUpdateDb({
      ...db,
      goodsReceiptNotes: [...(db.goodsReceiptNotes || []), newGrn],
      inventoryStocks: currentStocks,
      purchaseOrders: updatedPos
    });

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
    setIsCreatingGrn(false);
  };

  // Handle Manual Stock Adjustment
  const handleStockAdjustment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!adjustmentForm.productId || !adjustmentForm.warehouseId) return;

    const currentStocks = [...(db.inventoryStocks || [])];
    const match = currentStocks.find(s => 
      s.productId === adjustmentForm.productId &&
      s.warehouseId === adjustmentForm.warehouseId &&
      s.batchNumber === (adjustmentForm.batchNumber || undefined) &&
      s.companyId === companyId
    );

    if (match) {
      match.quantity = Math.max(0, Number(match.quantity) + Number(adjustmentForm.quantity));
    } else {
      if (adjustmentForm.quantity > 0) {
        currentStocks.push({
          id: generateId(),
          productId: adjustmentForm.productId,
          warehouseId: adjustmentForm.warehouseId,
          batchNumber: adjustmentForm.batchNumber || undefined,
          quantity: adjustmentForm.quantity,
          companyId
        });
      }
    }

    onUpdateDb({
      ...db,
      inventoryStocks: currentStocks
    });
    setAdjustmentForm({ productId: '', warehouseId: warehouses[0]?.id || '', quantity: 0, batchNumber: '', reason: '' });
    setIsAdjustingStock(false);
  };

  return (
    <div className="space-y-6" id="inventory-module-container">
      {/* MODULE HEADER */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-gray-100 pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 flex items-center gap-2">
            {activeSubTab === 'stock' && <Boxes className="h-7 w-7 text-indigo-600" />}
            {activeSubTab === 'pr' && <FileText className="h-7 w-7 text-indigo-600" />}
            {activeSubTab === 'po' && <ClipboardCheck className="h-7 w-7 text-indigo-600" />}
            {activeSubTab === 'grn' && <PackageCheck className="h-7 w-7 text-indigo-600" />}
            {activeSubTab === 'warehouses' && <Building2 className="h-7 w-7 text-indigo-600" />}
            {activeSubTab === 'stock' && t('Stock Registry')}
            {activeSubTab === 'pr' && t('Purchase Requisitions')}
            {activeSubTab === 'po' && t('Purchase Orders')}
            {activeSubTab === 'grn' && t('Goods Receipt (GRN)')}
            {activeSubTab === 'warehouses' && t('Physical Warehouses')}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {activeSubTab === 'stock' && t('Monitor physical inventory levels, serial numbers, batches, and locations in real-time.')}
            {activeSubTab === 'pr' && t('Submit and manage request forms for material procurement, and track approval workflows.')}
            {activeSubTab === 'po' && t('Issue official commercial documents to external vendors for materials and service procurements.')}
            {activeSubTab === 'grn' && t('Record receipts of ordered goods at warehouse docks, check counts, and automatically update stocks.')}
            {activeSubTab === 'warehouses' && t('Setup and govern multiple physical storage locations, distribution centers, and shop floors.')}
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
                  onClick={() => setIsCreatingPr(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-750 text-sm shadow-sm transition"
                >
                  <Plus className="h-4 w-4" />
                  {t('New Requisition')}
                </button>
              )}
              {activeSubTab === 'po' && can('inventory.po') && (
                <button
                  onClick={() => setIsCreatingPo(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-750 text-sm shadow-sm transition"
                >
                  <Plus className="h-4 w-4" />
                  {t('New Purchase Order')}
                </button>
              )}
              {activeSubTab === 'grn' && can('inventory.grn') && (
                <button
                  onClick={() => setIsCreatingGrn(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-750 text-sm shadow-sm transition"
                >
                  <Plus className="h-4 w-4" />
                  {t('Receive Goods (GRN)')}
                </button>
              )}
              {activeSubTab === 'warehouses' && currentUser.role === 'admin' && (
                <button
                  onClick={() => setIsCreatingWarehouse(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-750 text-sm shadow-sm transition"
                >
                  <Plus className="h-4 w-4" />
                  {t('Create Warehouse')}
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
              className="w-full pl-9 pr-4 py-2 border border-gray-200 rounded-lg text-sm bg-gray-55/30 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
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
                      <td className="px-6 py-4 font-semibold text-indigo-650">{pr.prNumber}</td>
                      <td className="px-6 py-4 text-sm text-gray-800">{pr.requestedBy}</td>
                      <td className="px-6 py-4 text-sm text-gray-500">{new Date(pr.date).toLocaleDateString()}</td>
                      <td className="px-6 py-4 text-sm text-gray-600">{(pr.items || []).length}</td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium ${
                          pr.status === 'Approved' ? 'bg-emerald-50 text-emerald-700' :
                          pr.status === 'Pending' ? 'bg-amber-50 text-amber-700' :
                          pr.status === 'Closed' ? 'bg-gray-100 text-gray-700' :
                          'bg-rose-50 text-rose-700'
                        }`}>
                          {pr.status}
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
                        <td className="px-6 py-4 font-semibold text-indigo-650">{po.poNumber}</td>
                        <td className="px-6 py-4 text-sm text-gray-800">{vend?.name || t('Unknown Vendor')}</td>
                        <td className="px-6 py-4 text-sm text-gray-500">{new Date(po.date).toLocaleDateString()}</td>
                        <td className="px-6 py-4 text-sm font-semibold text-gray-900">
                          {Number(po.totalAmount).toFixed(2)} SAR
                        </td>
                        <td className="px-6 py-4">
                          <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium ${
                            po.status === 'Received' ? 'bg-emerald-50 text-emerald-700' :
                            po.status === 'Sent' ? 'bg-indigo-50 text-indigo-700' :
                            'bg-gray-100 text-gray-700'
                          }`}>
                            {po.status}
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
                        <td className="px-6 py-4 font-semibold text-indigo-650">{grn.grnNumber}</td>
                        <td className="px-6 py-4 text-sm text-gray-800">{vend?.name || t('Unknown Vendor')}</td>
                        <td className="px-6 py-4 text-sm text-gray-600">{wh?.name || t('Unknown Warehouse')}</td>
                        <td className="px-6 py-4 text-sm text-gray-650">
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
              <div key={wh.id} className="bg-white p-6 rounded-xl border border-gray-150 shadow-xs hover:shadow-md transition duration-200">
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
                  <span className="font-bold text-indigo-650">{totalItems}</span>
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

      {/* ----------------- MODALS & VIEWS ----------------- */}

      {/* PR VIEW DETAIL PANEL */}
      {viewingPr && (
        <div className="bg-white rounded-xl border border-gray-150 shadow-sm w-full animate-fade-in">
          <div className="overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
              <div>
                <h3 className="text-lg font-bold text-gray-900">{t('Purchase Requisition Details')}</h3>
                <span className="text-sm font-semibold text-indigo-650 font-mono mt-0.5 inline-block">{viewingPr.prNumber}</span>
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
                  <p className="text-gray-750 mt-0.5 bg-gray-50 p-2.5 rounded border border-gray-100">{viewingPr.notes || '-'}</p>
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
            <div className="p-6 border-t border-gray-150 flex justify-between bg-gray-50">
              <button
                onClick={() => setViewingPr(null)}
                className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-100 text-gray-700 transition"
              >
                {t('Close')}
              </button>
              {viewingPr.status === 'Pending' && currentUser.role === 'admin' && (
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
        <div className="bg-white rounded-xl border border-gray-150 shadow-sm w-full animate-fade-in">
          <div className="overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
              <div>
                <h3 className="text-lg font-bold text-gray-900">{t('Purchase Order Details')}</h3>
                <span className="text-sm font-semibold text-indigo-650 font-mono mt-0.5 inline-block">{viewingPo.poNumber}</span>
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
                            <td className="px-4 py-2 text-right">{item.unitPrice.toFixed(2)} SAR</td>
                            <td className="px-4 py-2 text-right">{vat.toFixed(2)} SAR</td>
                            <td className="px-4 py-2 text-right font-bold">{(subTotal + vat).toFixed(2)} SAR</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="mt-4 flex justify-end text-lg font-bold text-gray-900">
                  {t('Grand Total:')} &nbsp;{Number(viewingPo.totalAmount).toFixed(2)} SAR
                </div>
              </div>
            </div>
            <div className="p-6 border-t border-gray-150 flex justify-between bg-gray-50">
              <button
                onClick={() => setViewingPo(null)}
                className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-100 text-gray-700 transition"
              >
                {t('Close')}
              </button>
              {viewingPo.status === 'Sent' && (
                <button
                  onClick={() => handleCancelPo(viewingPo.id)}
                  className="px-4 py-2 bg-rose-50 text-rose-700 rounded-lg text-sm font-medium hover:bg-rose-105 transition"
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
        <div className="bg-white rounded-xl border border-gray-150 shadow-sm w-full animate-fade-in">
          <div className="overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
              <div>
                <h3 className="text-lg font-bold text-gray-900">{t('Goods Receipt Note Details')}</h3>
                <span className="text-sm font-semibold text-indigo-650 font-mono mt-0.5 inline-block">{viewingGrn.grnNumber}</span>
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
                            <td className="px-4 py-2 text-right font-bold text-emerald-650">{item.quantityReceived}</td>
                            <td className="px-4 py-2 text-right">{item.unitCost.toFixed(2)} SAR</td>
                            <td className="px-4 py-2 text-right">{item.taxRate || 0}%</td>
                            <td className="px-4 py-2 text-right">{vat.toFixed(2)} SAR</td>
                            <td className="px-4 py-2 text-right font-bold">{(subTotal + vat).toFixed(2)} SAR</td>
                            <td className="px-4 py-2 text-gray-650 text-xs">
                              <span className="font-mono">{item.batchNumber || '-'}</span>
                              {item.expiryDate ? ` / ${new Date(item.expiryDate).toLocaleDateString()}` : ''}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="mt-4 flex flex-col items-end gap-1.5 text-sm font-semibold text-gray-750">
                  <div>
                    {t('Subtotal (excl. tax):')} &nbsp;
                    <span className="font-bold text-gray-900">
                      {(viewingGrn.items || []).reduce((sum, item) => sum + item.quantityReceived * item.unitCost, 0).toFixed(2)} SAR
                    </span>
                  </div>
                  <div>
                    {t('VAT Total:')} &nbsp;
                    <span className="font-bold text-gray-900">
                      {(viewingGrn.items || []).reduce((sum, item) => sum + (item.quantityReceived * item.unitCost * ((item.taxRate || 0) / 100)), 0).toFixed(2)} SAR
                    </span>
                  </div>
                  <div className="text-lg font-bold text-emerald-700 mt-1 border-t border-gray-100 pt-1.5">
                    {t('Grand Total:')} &nbsp;
                    <span>
                      {(viewingGrn.items || []).reduce((sum, item) => sum + (item.quantityReceived * item.unitCost * (1 + ((item.taxRate || 0) / 100))), 0).toFixed(2)} SAR
                    </span>
                  </div>
                </div>
              </div>
            </div>
            <div className="p-6 border-t border-gray-150 flex justify-end bg-gray-50">
              <button
                onClick={() => setViewingGrn(null)}
                className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-100 text-gray-700 transition"
              >
                {t('Close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CREATE PR PANEL */}
      {isCreatingPr && (
        <div className="bg-white rounded-xl border border-gray-150 shadow-sm w-full animate-fade-in">
          <div className="overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
              <h3 className="text-lg font-bold text-gray-900">{t('Create Purchase Requisition (PR)')}</h3>
              <button 
                onClick={() => setIsCreatingPr(false)} 
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
                        className="px-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-750 transition font-bold"
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
              <div className="p-6 border-t border-gray-150 flex justify-end gap-3 bg-gray-50">
                <button
                  type="button"
                  onClick={() => setIsCreatingPr(false)}
                  className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-100 text-gray-700 transition"
                >
                  {t('Cancel')}
                </button>
                <button
                  type="submit"
                  disabled={prForm.items.length === 0}
                  className="px-5 py-2 bg-indigo-600 text-white font-medium rounded-lg text-sm shadow-sm hover:bg-indigo-750 transition disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  {t('Submit Requisition')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CREATE PO PANEL */}
      {isCreatingPo && (
        <div className="bg-white rounded-xl border border-gray-150 shadow-sm w-full animate-fade-in">
          <div className="overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
              <h3 className="text-lg font-bold text-gray-900">{t('Raise Purchase Order (PO)')}</h3>
              <button 
                onClick={() => setIsCreatingPo(false)} 
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
                </div>

                {/* Add Item Form */}
                <div className="border border-gray-100 rounded-xl p-4 bg-gray-50/50 space-y-3 mt-4">
                  <h4 className="text-xs font-bold text-gray-600 uppercase tracking-wider">{t('Add Material & Pricing')}</h4>
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
                            unitPrice: Number(selectedProd?.unitPrice || 0)
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
                        <option value={17}>VAT (17%)</option>
                        {db.taxSlabs?.map(ts => (
                          ts.percentage !== 17 && (
                            <option key={ts.id} value={ts.percentage}>{ts.name} ({ts.percentage}%)</option>
                          )
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
                        className="w-full h-9 bg-indigo-600 text-white rounded-lg hover:bg-indigo-750 transition font-bold text-sm flex items-center justify-center shadow-xs"
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
                                  <option value={17}>VAT (17%)</option>
                                  {db.taxSlabs?.map(ts => (
                                    ts.percentage !== 17 && (
                                      <option key={ts.id} value={ts.percentage}>{ts.name} ({ts.percentage}%)</option>
                                    )
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
                              <td className="px-4 py-2 text-right font-semibold text-gray-900">{(subTotal + vat).toFixed(2)} SAR</td>
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
              <div className="p-6 border-t border-gray-150 flex justify-end gap-3 bg-gray-50">
                <button
                  type="button"
                  onClick={() => setIsCreatingPo(false)}
                  className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-100 text-gray-700 transition"
                >
                  {t('Cancel')}
                </button>
                <button
                  type="submit"
                  disabled={poForm.items.length === 0 || !poForm.vendorId}
                  className="px-5 py-2 bg-indigo-600 text-white font-medium rounded-lg text-sm shadow-sm hover:bg-indigo-750 transition disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  {t('Issue Purchase Order')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CREATE GRN PANEL */}
      {isCreatingGrn && (
        <div className="bg-white rounded-xl border border-gray-150 shadow-sm w-full animate-fade-in">
          <div className="overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
              <h3 className="text-lg font-bold text-gray-900">{t('Receive Goods / GRN Ledger')}</h3>
              <button 
                onClick={() => setIsCreatingGrn(false)} 
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
                        {purchaseOrders
                          .filter(po => po.status === 'Sent')
                          .map(po => (
                            <option key={po.id} value={po.id}>{po.poNumber} ({vendors.find(v => v.id === po.vendorId)?.name})</option>
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
                  <div className="grid grid-cols-1 sm:grid-cols-7 gap-3">
                    <div className="sm:col-span-2">
                      <select
                        value={newGrnItem.productId}
                        onChange={(e) => {
                          const selectedProd = products.find(prod => prod.id === e.target.value);
                          setNewGrnItem({ 
                            ...newGrnItem, 
                            productId: e.target.value,
                            unitCost: Number(selectedProd?.unitPrice || 0),
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
                        className="px-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-750 transition font-bold text-sm"
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
                              <td className="px-4 py-2 text-right font-bold text-emerald-650">{item.quantityReceived}</td>
                              <td className="px-4 py-2 text-right">{item.unitCost.toFixed(2)} SAR</td>
                              <td className="px-4 py-2 text-right">{item.taxRate || 0}%</td>
                              <td className="px-4 py-2 text-right">{vat.toFixed(2)} SAR</td>
                              <td className="px-4 py-2 text-right font-semibold">{(subTotal + vat).toFixed(2)} SAR</td>
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
              <div className="p-6 border-t border-gray-150 flex justify-end gap-3 bg-gray-50">
                <button
                  type="button"
                  onClick={() => setIsCreatingGrn(false)}
                  className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-100 text-gray-700 transition"
                >
                  {t('Cancel')}
                </button>
                <button
                  type="submit"
                  disabled={grnForm.items.length === 0 || (!grnForm.isDsd && !grnForm.purchaseOrderId) || (grnForm.isDsd && !grnForm.vendorId)}
                  className="px-5 py-2 bg-emerald-600 text-white font-medium rounded-lg text-sm shadow-sm hover:bg-emerald-700 transition disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  {t('Confirm Receipt & Update Stock')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CREATE WAREHOUSE PANEL */}
      {isCreatingWarehouse && (
        <div className="bg-white rounded-xl border border-gray-150 shadow-sm w-full animate-fade-in">
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
              <div className="p-6 border-t border-gray-150 flex justify-end gap-3 bg-gray-50">
                <button
                  type="button"
                  onClick={() => setIsCreatingWarehouse(false)}
                  className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-100 text-gray-700 transition"
                >
                  {t('Cancel')}
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-indigo-600 text-white font-medium rounded-lg text-sm shadow-sm hover:bg-indigo-750 transition"
                >
                  {t('Register Warehouse')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ADJUST STOCK PANEL */}
      {isAdjustingStock && (
        <div className="bg-white rounded-xl border border-gray-150 shadow-sm w-full animate-fade-in">
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
              <div className="p-6 border-t border-gray-150 flex justify-end gap-3 bg-gray-50">
                <button
                  type="button"
                  onClick={() => setIsAdjustingStock(false)}
                  className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-100 text-gray-700 transition"
                >
                  {t('Cancel')}
                </button>
                <button
                  type="submit"
                  disabled={!adjustmentForm.productId || !adjustmentForm.quantity}
                  className="px-5 py-2 bg-indigo-600 text-white font-medium rounded-lg text-sm shadow-sm hover:bg-indigo-750 transition disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  {t('Apply Adjustment')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
