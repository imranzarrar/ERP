import React from 'react';
import { useTranslation, usePermissions, useDirtyGuard } from '../hooks';
// from 'react';
import { DatabaseState, saveDatabase } from '../dbStore';
import { generateId } from '../id';
import { ProductService, Customer, Vendor, User } from '../types';
import { ZATCA_UNIT_CODES } from '../zatcaUnitCodes';
import { 
 Plus,
 Trash,
 Check,
 Users,
 Briefcase,
 Layers,
 AlertTriangle,
 Lock,
 Edit2
, X, FolderKanban, Scaling, MapPin, Package } from 'lucide-react';

interface MasterEntitiesProps {
 db: DatabaseState;
 // setDb-only local state update (App.tsx's handleUpdateDbLocal) — no /api/migrate POST.
 // Every handler in this file already calls a real REST route (customers/vendors/products
 // CRUD, fetchEntities' GETs) and only reaches this afterward to reflect that success in
 // local state. Deliberately a function-updater only, not a raw DatabaseState — see
 // App.tsx's handleUpdateDbLocal comment for the incident this prevents.
 onUpdateDbLocal: (updater: (prev: DatabaseState) => DatabaseState) => void;
 onRefreshDb?: () => Promise<void>;
 forceSubTab?: SubTab;
 // 'list' renders the directory table only; 'add' renders the create/edit form only —
 // each is mounted under its own nav tab/permission (e.g. customers vs customers-add).
 mode: 'list' | 'add';
 editId?: string;
 onDone: () => void;
 onEdit: (id: string) => void;
 onCreateNew: () => void;
 // Reports whether the create/edit form has unsaved changes, for App.tsx's handleNavigate
 // guard (see useDirtyGuard in hooks.ts). Shared across all six sub-tabs (customers/
 // vendors/products/categories/units/warehouses) since they're all one component instance.
 onDirtyChange?: (dirty: boolean) => void;
}

type SubTab = 'customers' | 'vendors' | 'products' | 'categories' | 'units' | 'warehouses';

export default function MasterEntities({ db, onUpdateDbLocal, onRefreshDb, forceSubTab, mode, editId, onDone, onEdit, onCreateNew, onDirtyChange }: MasterEntitiesProps) {
 const { t, isRTL, lang } = useTranslation(db);
 const currentUser = db.currentUser;
 const { can } = usePermissions(currentUser);
 const isAdmin = currentUser?.isSuperAdmin || currentUser?.role === 'admin';
  
  // Every list/lookup below reads straight from the shared `db.X` arrays (populated by
  // `/api/state`, refreshed via `onRefreshDb`) — this module used to run its own parallel
  // set of 7 GET requests into separate local state on mount/company-switch only, which
  // meant a record created/updated elsewhere (another session, another module, or this
  // app's own "Reload View") never appeared here without a hard page reload, and did 7x
  // the network requests `/api/state` already covers in one call.
 const [subTab, setSubTab] = React.useState<SubTab>(() => {
 if (forceSubTab) return forceSubTab;
 if (can('customers.read')) return 'customers';
 if (can('vendors.read')) return 'vendors';
 if (can('products.read')) return 'products';
 return 'customers';
 });

 React.useEffect(() => {
 if (forceSubTab) {
 setSubTab(forceSubTab);
 clearForm();
 }
 }, [forceSubTab]);

 // Notifications
 const [success, setSuccess] = React.useState<string | null>(null);
 const [error, setError] = React.useState<string | null>(null);

 const triggerSuccess = (msg: string) => {
 setSuccess(msg);
 setTimeout(() => setSuccess(null), 3000);
 };

 const triggerError = (msg: string) => {
 setError(msg);
 setTimeout(() => setError(null), 4000);
 };

 // Form states
 const [editingId, setEditingId] = React.useState<string | null>(null);
 
 // Customer & Vendor fields
 const [name, setName] = React.useState('');
 const [email, setEmail] = React.useState('');
 const [phone, setPhone] = React.useState('');
 const [address, setAddress] = React.useState('');
 const [taxRegNumber, setTaxRegNumber] = React.useState('');
 // ZATCA buyer fields — distinct from the generic `taxRegNumber` display field above.
 // Standard (B2B) invoices need a full, verifiable buyer identity for a valid
 // AccountingCustomerParty; Simplified (B2C) only needs a name (see
 // server/lib/zatca/validators.ts's validateBuyerFields, which this mirrors).
 // Defaults to B2C — the safer default for a brand-new customer record: a wrongly-B2C
 // customer just submits as a valid Simplified invoice, while a wrongly-B2B one (the old
 // default) silently blocks ZATCA submission entirely until someone notices and fills in
 // a full VAT/address identity. Real incident: several companies' "Walk-in Customer" —
 // a retail/anonymous buyer by definition — ended up B2B this way, with no VAT/address
 // data, and any invoice against them was rejected pre-submission (BUYER_INCOMPLETE).
 const [buyerType, setBuyerType] = React.useState<'B2B' | 'B2C'>('B2C');
 const [zatcaVatNumber, setZatcaVatNumber] = React.useState('');
 const [zatcaStreetName, setZatcaStreetName] = React.useState('');
 const [zatcaBuildingNumber, setZatcaBuildingNumber] = React.useState('');
 const [zatcaDistrict, setZatcaDistrict] = React.useState('');
 const [zatcaCity, setZatcaCity] = React.useState('');
 const [zatcaPostalCode, setZatcaPostalCode] = React.useState('');
 // Not a ZATCA field — general Commercial Registration number shown on the printed
 // document alongside VAT (DocumentRenderer.tsx), separate from the ZATCA buyer-identity
 // block above.
 const [entityCrNumber, setEntityCrNumber] = React.useState('');

 // Product fields
 const [prodName, setProdName] = React.useState('');
 const [prodDescription, setProdDescription] = React.useState('');
 // 0 = Sales & Purchase (Both, the default), 1 = Sales only, 2 = Purchase only —
 // productsServices.salesPurchaseFlow, replaces the old overloaded `type` column.
 const [prodSalesPurchaseFlow, setProdSalesPurchaseFlow] = React.useState<0 | 1 | 2>(0);
 const [prodPrice, setProdPrice] = React.useState('');
 // Purchase/stock-valuation cost — separate from prodPrice (the selling price). Optional:
 // left blank, GRN/PO line cost defaults fall back to the selling price instead (see
 // InventoryModule.tsx's resolveProductByCode and its GRN/PO item-add handlers).
 const [prodCostPrice, setProdCostPrice] = React.useState('');
 const [prodUnit, setProdUnit] = React.useState('PCE');
  const [prodIsPos, setProdIsPos] = React.useState(false);
  const [prodCategory, setProdCategory] = React.useState('');
  const [prodImage, setProdImage] = React.useState('');
  const [prodBarcode, setProdBarcode] = React.useState('');
  const [prodSku, setProdSku] = React.useState('');

  // New inventory-related fields
  const [prodCatalogType, setProdCatalogType] = React.useState<'item' | 'service'>('item');
  const [prodCategoryId, setProdCategoryId] = React.useState('');
  const [prodDefaultWarehouseId, setProdDefaultWarehouseId] = React.useState('');
  const [prodBinLocation, setProdBinLocation] = React.useState('');
  const [prodMinLevel, setProdMinLevel] = React.useState('');
  const [prodMaxLevel, setProdMaxLevel] = React.useState('');
  const [prodReorderLeadTime, setProdReorderLeadTime] = React.useState('');
  const [prodGridPosition, setProdGridPosition] = React.useState('');
  const [prodModifierGroupIds, setProdModifierGroupIds] = React.useState<string[]>([]);

  // Category fields
  const [catName, setCatName] = React.useState('');
  const [catParentId, setCatParentId] = React.useState('');
  const [catSalesGl, setCatSalesGl] = React.useState('4000 - Product Sales');
  const [catPurchaseGl, setCatPurchaseGl] = React.useState('1200 - Inventory Asset');
  const [catCogsGl, setCatCogsGl] = React.useState('5000 - Cost of Goods Sold');

  // Unit of Measure fields
  const [unitName, setUnitName] = React.useState('');
  const [unitCode, setUnitCode] = React.useState('');

  // Warehouse fields
  const [whName, setWhName] = React.useState('');
  const [whCode, setWhCode] = React.useState('');
  const [whAddress, setWhAddress] = React.useState('');
  const [whIsActive, setWhIsActive] = React.useState(true);
  // Which branch this warehouse belongs to — GRN/Purchase Returns/Physical Stock Takes
  // have no branchId column of their own; their branch is derived via this join.
  const [whBranchId, setWhBranchId] = React.useState('');
  // 'sales' (default, a location a sale can be attributed to/deducted from) vs 'backend'
  // (distribution/storage only — never itself a sale's source, see warehouses.type's
  // schema comment). isCompanyDefault is undefined until the user explicitly touches it
  // on an edit, so the server's own "preserve unless explicitly sent" logic applies —
  // see the warehouse route's comment for why that matters.
  const [whType, setWhType] = React.useState<'sales' | 'backend'>('sales');
  const [whIsCompanyDefault, setWhIsCompanyDefault] = React.useState(false);

  // Warehouses list for editing product
  const [activeProductWarehouses, setActiveProductWarehouses] = React.useState<any[]>([]);
  const [addPwWarehouseId, setAddPwWarehouseId] = React.useState('');
  const [addPwBin, setAddPwBin] = React.useState('');
  const [addPwMin, setAddPwMin] = React.useState('');
  const [addPwMax, setAddPwMax] = React.useState('');
  const [addPwLeadTime, setAddPwLeadTime] = React.useState('');

  // Packaging/alternate units (e.g. "Carton-12") for the product being edited — see
  // ProductUnitConversion's comment in src/types.ts for the full model.
  const [addPucUnitId, setAddPucUnitId] = React.useState('');
  const [addPucFactor, setAddPucFactor] = React.useState('');
  const [addPucBarcode, setAddPucBarcode] = React.useState('');
  const [addPucSku, setAddPucSku] = React.useState('');
  const [addPucPurchasePrice, setAddPucPurchasePrice] = React.useState('');
  const [addPucSalePrice, setAddPucSalePrice] = React.useState('');

 // Unsaved-changes guard — one shared snapshot covering all six sub-tabs' own fields
 // (only the ones relevant to the currently active sub-tab ever differ from their
 // defaults, so this stays correct regardless of which entity type is being edited).
 // Deliberately excludes activeProductWarehouses/addPw*/addPuc* — those are secondary,
 // separately-persisted mini-forms (a product's warehouse-location and packaging-unit
 // mappings are saved immediately via their own dedicated actions, not as part of this
 // main Save submission), same reasoning as InvoiceModule.tsx excluding formWarehouseId.
 const { isDirty: isEntityFormDirty, markClean: markFormClean } = useDirtyGuard({
   name, email, phone, address, taxRegNumber, buyerType, zatcaVatNumber, zatcaStreetName,
   zatcaBuildingNumber, zatcaDistrict, zatcaCity, zatcaPostalCode, entityCrNumber,
   prodName, prodDescription, prodSalesPurchaseFlow, prodPrice, prodCostPrice, prodUnit, prodIsPos, prodCategory, prodImage,
   prodBarcode, prodSku, prodCatalogType, prodCategoryId, prodDefaultWarehouseId, prodBinLocation,
   prodMinLevel, prodMaxLevel, prodReorderLeadTime, prodGridPosition, prodModifierGroupIds,
   catName, catParentId, catSalesGl, catPurchaseGl, catCogsGl,
   unitName, unitCode,
   whName, whCode, whAddress, whIsActive, whBranchId, whType, whIsCompanyDefault,
 });

 React.useEffect(() => {
   if (mode === 'add') onDirtyChange?.(isEntityFormDirty);
   // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [isEntityFormDirty, mode]);

 React.useEffect(() => {
   return () => onDirtyChange?.(false);
   // eslint-disable-next-line react-hooks/exhaustive-deps
 }, []);

 // Baseline for a genuinely fresh add (no editId) — fields are already at their useState
 // defaults by this point (this component fully remounts on every mode/sub-tab transition,
 // same as Invoice/Quotation/Expense), so the snapshot is just those literal defaults.
 React.useEffect(() => {
   if (mode !== 'add' || editId) return;
   markFormClean({
     name: '', email: '', phone: '', address: '', taxRegNumber: '', buyerType: 'B2C',
     zatcaVatNumber: '', zatcaStreetName: '', zatcaBuildingNumber: '', zatcaDistrict: '',
     zatcaCity: '', zatcaPostalCode: '', entityCrNumber: '',
     prodName: '', prodDescription: '', prodSalesPurchaseFlow: 0, prodPrice: '', prodCostPrice: '', prodUnit: 'PCE',
     prodIsPos: false, prodCategory: '', prodImage: '', prodBarcode: '', prodSku: '',
     prodCatalogType: 'item', prodCategoryId: '', prodDefaultWarehouseId: '', prodBinLocation: '',
     prodMinLevel: '', prodMaxLevel: '', prodReorderLeadTime: '', prodGridPosition: '',
     prodModifierGroupIds: [] as string[],
     catName: '', catParentId: '', catSalesGl: '4000 - Product Sales',
     catPurchaseGl: '1200 - Inventory Asset', catCogsGl: '5000 - Cost of Goods Sold',
     unitName: '', unitCode: '',
     whName: '', whCode: '', whAddress: '', whIsActive: true, whBranchId: '',
     whType: 'sales' as const, whIsCompanyDefault: false,
   });
   // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [mode, editId, forceSubTab]);

 const clearForm = () => {
 setEditingId(null);
 setName('');
 setEmail('');
 setPhone('');
 setAddress('');
 setTaxRegNumber('');
 setBuyerType('B2C');
 setZatcaVatNumber('');
 setZatcaStreetName('');
 setZatcaBuildingNumber('');
 setZatcaDistrict('');
 setZatcaCity('');
 setZatcaPostalCode('');
 setEntityCrNumber('');
 setProdName('');
 setProdSalesPurchaseFlow(0);
 setProdPrice('');
 setProdCostPrice('');
 setProdUnit('PCE');
    setProdIsPos(false);
    setProdCategory('');
    setProdImage('');
    setProdBarcode('');
    setProdSku('');
    setProdCatalogType('item');
    setProdCategoryId('');
    setProdDefaultWarehouseId('');
    setProdBinLocation('');
    setProdMinLevel('');
    setProdMaxLevel('');
    setProdReorderLeadTime('');
    setProdGridPosition('');
    setProdModifierGroupIds([]);
    setAddPucUnitId('');
    setAddPucFactor('');
    setAddPucBarcode('');
    setAddPucSku('');
    setAddPucPurchasePrice('');
    setAddPucSalePrice('');
    setCatName('');
    setCatParentId('');
    setCatSalesGl('4000 - Product Sales');
    setCatPurchaseGl('1200 - Inventory Asset');
    setCatCogsGl('5000 - Cost of Goods Sold');
    setUnitName('');
    setUnitCode('');
    setWhName('');
    setWhCode('');
    setWhAddress('');
    setWhIsActive(true);
    setWhBranchId('');
    setWhType('sales');
    setWhIsCompanyDefault(false);
    setActiveProductWarehouses([]);
    setAddPwWarehouseId('');
    setAddPwBin('');
    setAddPwMin('');
    setAddPwMax('');
    setAddPwLeadTime('');
 };

 // Check Permissions using the new granular create/read/update/delete RBAC leaves
 const canViewCustomers = can('customers.read');
 const canCreateCustomers = can('customers.create');
 const canUpdateCustomers = can('customers.update');
 const canDeleteCustomers = can('customers.delete');

 const canViewVendors = can('vendors.read');
 const canCreateVendors = can('vendors.create');
 const canUpdateVendors = can('vendors.update');
 const canDeleteVendors = can('vendors.delete');

 const canViewProducts = can('products.read');
 const canCreateProducts = can('products.create');
 const canUpdateProducts = can('products.update');
 const canDeleteProducts = can('products.delete');

 const canViewCategories = can('categories.read');
 const canCreateCategories = can('categories.create');
 const canUpdateCategories = can('categories.update');
 const canDeleteCategories = can('categories.delete');

 const canViewUnits = can('units.read');
 const canCreateUnits = can('units.create');
 const canUpdateUnits = can('units.update');
 const canDeleteUnits = can('units.delete');

 const canViewWarehouses = can('warehouses.read');
 const canCreateWarehouses = can('warehouses.create');
 const canUpdateWarehouses = can('warehouses.update');
 const canDeleteWarehouses = can('warehouses.delete');

  const companyCustomers = db.customers;
  const companyVendors = db.vendors;
  const companyProducts = db.products;

 // Handlers - Customers
const handleSaveCustomer = async (e: React.FormEvent) => {
  e.preventDefault();
  if (!(editingId ? canUpdateCustomers : canCreateCustomers)) return triggerError('Insufficient permissions to manage customers.');
  if (buyerFieldErrors.length > 0) return triggerError(buyerFieldErrors.join(' '));

  const customerData = {
    id: editingId || generateId(),
    name, email, phone, address, taxRegNumber,
    buyerType,
    vatNumber: zatcaVatNumber || null,
    streetName: zatcaStreetName || null,
    buildingNumber: zatcaBuildingNumber || null,
    district: zatcaDistrict || null,
    city: zatcaCity || null,
    postalCode: zatcaPostalCode || null,
    crNumber: entityCrNumber || null,
    isSystem: false,
    companyId: db.selectedCompanyId
  };

  try {
    const res = await fetch('/api/customers', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(customerData) });
    if (!res.ok) {
      // The server re-validates ZATCA mandatory fields authoritatively (client mirror
      // above only covers what it knows to check) — a rejection here (bad VAT format,
      // duplicate, DB constraint) was previously swallowed silently and the form still
      // cleared and navigated away as if the save had succeeded.
      const errData = await res.json().catch(() => ({}));
      triggerError(errData.error || 'Failed to save customer — the server rejected this request.');
      return;
    }
    triggerSuccess(editingId ? 'Customer updated successfully.' : 'Customer added successfully.');
    clearForm();
    onDirtyChange?.(false);
    if (onRefreshDb) await onRefreshDb();
    onDone();
  } catch (err: any) {
    triggerError('Failed to save customer to database.');
  }
  };

 const handleToggleCustomerActive = async (id: string) => {
 if (!canDeleteCustomers) return triggerError(t('Insufficient permissions.'));
 const cust = db.customers.find(c => c.id === id);
 if (cust?.isSystem) return triggerError('System customer cannot be deactivated.');
 const isActive = cust?.isActive !== false;
 if (isActive && !window.confirm(t("Deactivate this customer? They'll be hidden from new documents but all their history stays intact. You can reactivate them anytime."))) return;

 try {
 const res = await fetch(`/api/customers/${id}/toggle-active`, { method: 'PATCH' });
 if (!res.ok) {
 const errData = await res.json().catch(() => ({}));
 return triggerError(errData.error || 'Failed to update customer status.');
 }
 const data = await res.json().catch(() => ({}));
 triggerSuccess(data.isActive ? 'Customer reactivated.' : 'Customer deactivated.');
 if (onRefreshDb) await onRefreshDb();
 } catch(err) {
 triggerError('Failed to update customer status.');
 }
 };

 // Handlers - Vendors
 const handleSaveVendor = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!(editingId ? canUpdateVendors : canCreateVendors)) return triggerError('Insufficient permissions to manage vendors.');
 if (buyerFieldErrors.length > 0) return triggerError(buyerFieldErrors.join(' '));

 const zatcaFields = {
   buyerType,
   vatNumber: zatcaVatNumber || null,
   streetName: zatcaStreetName || null,
   buildingNumber: zatcaBuildingNumber || null,
   district: zatcaDistrict || null,
   city: zatcaCity || null,
   postalCode: zatcaPostalCode || null,
   crNumber: entityCrNumber || null,
 };

 const newDb = { ...db };
 let savedVendor;
 if (editingId) {
 const idx = newDb.vendors.findIndex(v => v.id === editingId);
 if (idx !== -1) {
 if (newDb.vendors[idx].isSystem) return triggerError('System Vendor is a critical record and cannot be edited.');
 savedVendor = {
 ...newDb.vendors[idx],
 name, email, phone, address, taxRegNumber, ...zatcaFields
 };
 newDb.vendors[idx] = savedVendor;
 }
 } else {
 const isDuplicate = companyVendors.some(v => v.name.toLowerCase() === name.toLowerCase());
 if (isDuplicate) return triggerError('Vendor name already exists.');
 savedVendor = {
 id: generateId(),
 name, email, phone, address, taxRegNumber, ...zatcaFields,
 isSystem: false,
 companyId: db.selectedCompanyId
 };
 newDb.vendors.push(savedVendor);
 }

 try {
 if (savedVendor) {
 const res = await fetch('/api/vendors', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(savedVendor) });
 if (!res.ok) {
 const errData = await res.json().catch(() => ({}));
 triggerError(errData.error || 'Failed to save vendor — the server rejected this request.');
 return;
 }
 }
 onUpdateDbLocal(() => newDb);
 triggerSuccess(editingId ? 'Vendor updated successfully.' : 'Vendor added successfully.');
 clearForm();
 onDirtyChange?.(false);
 onDone();
 } catch(err) {
 triggerError('Failed to save vendor.');
 }
 };

 const handleToggleVendorActive = async (id: string) => {
 if (!canDeleteVendors) return triggerError(t('Insufficient permissions.'));
 const vend = db.vendors.find(v => v.id === id);
 if (vend?.isSystem) return triggerError('System vendor cannot be deactivated.');
 const isActive = vend?.isActive !== false;
 if (isActive && !window.confirm(t("Deactivate this vendor? They'll be hidden from new documents but all their history stays intact. You can reactivate them anytime."))) return;

 try {
 const res = await fetch(`/api/vendors/${id}/toggle-active`, { method: 'PATCH' });
 if (!res.ok) {
 const errData = await res.json().catch(() => ({}));
 return triggerError(errData.error || 'Failed to update vendor status.');
 }
 const data = await res.json().catch(() => ({}));
 triggerSuccess(data.isActive ? 'Vendor reactivated.' : 'Vendor deactivated.');
 if (onRefreshDb) await onRefreshDb();
 } catch(err) {
 triggerError('Failed to update vendor status.');
 }
 };

 // Handlers - Products
 const handleSaveProduct = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!(editingId ? canUpdateProducts : canCreateProducts)) return triggerError('Only Administrator accounts can edit catalog products.');
 if (!prodName.trim()) return triggerError('Product name is required.');
 if (!prodDescription.trim()) return triggerError('Description is required.');
    if (prodIsPos && !prodCategoryId) return triggerError('Category is required when Enable for POS is checked.');

 const priceNum = parseFloat(prodPrice);
 if (isNaN(priceNum) || priceNum < 0) return triggerError('Price must be a valid positive number.');
 // Optional — left blank, cost-affecting flows (GRN/PO line defaults) fall back to the
 // selling price instead, matching every pre-existing product that predates this field.
 const costPriceNum = prodCostPrice.trim() ? parseFloat(prodCostPrice) : null;
 if (prodCostPrice.trim() && (isNaN(costPriceNum as number) || (costPriceNum as number) < 0)) return triggerError('Cost price must be a valid positive number.');

 const newDb = { ...db };
 let savedProd;
 if (editingId) {
 const idx = newDb.products.findIndex(p => p.id === editingId);
 if (idx !== -1) {
 savedProd = {
 ...newDb.products[idx],
 name: prodName,
 description: prodDescription.trim(),
 salesPurchaseFlow: prodSalesPurchaseFlow,
 itemKind: prodCatalogType,
 unitPrice: priceNum,
 costPrice: costPriceNum,
 unit: prodUnit,
 base64Image: prodImage,
 isPosItem: prodIsPos,
 category: prodCategory,
 categoryId: prodCategoryId || null,
 barcode: prodBarcode,
 sku: prodSku,
 defaultWarehouseId: prodDefaultWarehouseId || null,
 binLocation: prodBinLocation,
 minLevel: prodMinLevel ? String(prodMinLevel) : null,
 maxLevel: prodMaxLevel ? String(prodMaxLevel) : null,
 reorderLeadTime: prodReorderLeadTime,
 posGridPosition: prodGridPosition ? parseInt(prodGridPosition, 10) : null,
 modifierGroupIds: prodModifierGroupIds,
 };
 newDb.products[idx] = savedProd;
 }
 } else {
 savedProd = {
 id: generateId(),
 name: prodName,
 description: prodDescription.trim(),
 unitPrice: priceNum,
 costPrice: costPriceNum,
 salesPurchaseFlow: prodSalesPurchaseFlow,
 itemKind: prodCatalogType,
 unit: prodUnit,
      isPosItem: prodIsPos,
      category: prodCategory,
      categoryId: prodCategoryId || null,
      base64Image: prodImage,
      barcode: prodBarcode,
      sku: prodSku,
      defaultWarehouseId: prodDefaultWarehouseId || null,
      binLocation: prodBinLocation,
      minLevel: prodMinLevel ? String(prodMinLevel) : null,
      maxLevel: prodMaxLevel ? String(prodMaxLevel) : null,
      reorderLeadTime: prodReorderLeadTime,
      posGridPosition: prodGridPosition ? parseInt(prodGridPosition, 10) : null,
      modifierGroupIds: prodModifierGroupIds,
 companyId: db.selectedCompanyId
 };
 newDb.products.push(savedProd);
 }

 try {
 if (savedProd) {
 const res = await fetch('/api/products', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(savedProd) });
 if (!res.ok) {
 const errData = await res.json().catch(() => ({}));
 triggerError(errData.error || 'Failed to save product — the server rejected this request.');
 return;
 }
 }
 onUpdateDbLocal(() => newDb);
 triggerSuccess(editingId ? 'Product updated successfully.' : 'Product added successfully.');
 clearForm();
 onDirtyChange?.(false);
 if (onRefreshDb) await onRefreshDb();
 onDone();
 } catch(err) {
 triggerError('Failed to save product.');
 }
 };


 const handleRestoreProducts = async () => {
 if (!canCreateProducts) return triggerError('Admin only.');

 const existingProductNames = new Set(companyProducts.map(p => p.name.toLowerCase()));

 const itemsToCheck: { name: string, price: number, type: 'Sales' }[] = [];
 db.invoices.filter(inv => inv.companyId === db.selectedCompanyId || !inv.companyId).forEach(inv => {
 inv.items.forEach(item => {
 if (item.description && item.description.trim()) itemsToCheck.push({ name: item.description.trim(), price: item.unitCost || 0, type: 'Sales' });
 });
 });
 db.quotations.filter(q => q.companyId === db.selectedCompanyId || !q.companyId).forEach(q => {
 q.items.forEach(item => {
 if (item.description && item.description.trim()) itemsToCheck.push({ name: item.description.trim(), price: item.unitCost || 0, type: 'Sales' });
 });
 });

 const candidates: typeof db.products = [];
 itemsToCheck.forEach(item => {
 if (!existingProductNames.has(item.name.toLowerCase())) {
 candidates.push({
 id: generateId(),
 name: item.name,
 description: 'Restored from existing document',
 // Real sold items (this function only ever scans invoice/quotation line items), so
 // 'Sales' visibility is correct. itemKind defaults to 'item' explicitly — a restored
 // product is exactly the "new product" case the schema's own default applies to
 // (unlike the bulk historical backfill, which is conservative because it can't know
 // what pre-existing, never-reviewed rows really are).
 salesPurchaseFlow: 1,
 itemKind: 'item',
 unitPrice: item.price,
 unit: 'No',
 companyId: db.selectedCompanyId
 });
 existingProductNames.add(item.name.toLowerCase());
 }
 });

 if (candidates.length === 0) {
 triggerSuccess('No missing products found in active documents.');
 return;
 }

 // Each candidate is POSTed individually to the real /api/products route (rather than
 // pushed straight into local state) so the server persists it — don't assume they all
 // succeeded; only the ones that actually landed get added to local state.
 const restored: typeof db.products = [];
 for (const product of candidates) {
 try {
 const res = await fetch('/api/products', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(product) });
 if (res.ok) restored.push(product);
 } catch (err) {
 // network failure on this one product — keep going, report the shortfall below
 }
 }

 if (restored.length > 0) {
 onUpdateDbLocal(prev => ({ ...prev, products: [...prev.products, ...restored] }));
 }

 if (restored.length === candidates.length) {
 triggerSuccess(`Successfully restored ${restored.length} products from historical documents.`);
 } else if (restored.length > 0) {
 triggerError(`Restored ${restored.length} of ${candidates.length} products — some failed to save.`);
 } else {
 triggerError('Failed to restore products.');
 }
 };

  const handleToggleProductActive = async (id: string) => {
   if (!canDeleteProducts) return triggerError(t('Insufficient permissions.'));
   const prod = db.products.find(p => p.id === id);
   const isActive = prod?.isActive !== false;
   if (isActive && !window.confirm(t("Deactivate this product? It'll be hidden from new documents but all its history stays intact. You can reactivate it anytime."))) return;

   try {
     const res = await fetch(`/api/products/${id}/toggle-active`, { method: 'PATCH' });
     if (!res.ok) {
       const errData = await res.json().catch(() => ({}));
       return triggerError(errData.error || 'Failed to update product status.');
     }
     const data = await res.json().catch(() => ({}));
     triggerSuccess(data.isActive ? 'Product reactivated.' : 'Product deactivated.');
     if (onRefreshDb) await onRefreshDb();
   } catch (err) {
     triggerError('Failed to update product status.');
   }
  };

  // Handlers - Product Categories
  const handleSaveCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!(editingId ? canUpdateCategories : canCreateCategories)) return triggerError('Only Administrators can edit categories.');
    if (!catName.trim()) return triggerError('Category name is required.');

    const catData = {
      id: editingId || generateId(),
      name: catName.trim(),
      parentCategoryId: catParentId || null,
      purchaseGlGroup: catPurchaseGl || null,
      salesGlGroup: catSalesGl || null,
      cogsGlGroup: catCogsGl || null,
      companyId: db.selectedCompanyId
    };

    try {
      const res = await fetch('/api/product-categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(catData)
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        return triggerError(errData.error || 'Failed to save category.');
      }
      triggerSuccess(editingId ? 'Category updated successfully.' : 'Category added successfully.');
      clearForm();
      onDirtyChange?.(false);
      if (onRefreshDb) await onRefreshDb();
      onDone();
    } catch (err) {
      triggerError('Failed to save category.');
    }
  };

  const handleToggleCategoryActive = async (id: string) => {
    if (!canDeleteCategories) return triggerError(t('Insufficient permissions.'));
    const cat = db.productCategories.find(c => c.id === id);
    const isActive = cat?.isActive !== false;
    if (isActive && !window.confirm(t("Deactivate this category? It'll be hidden from new documents but all its history stays intact. You can reactivate it anytime."))) return;

    try {
      const res = await fetch(`/api/product-categories/${id}/toggle-active`, { method: 'PATCH' });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        return triggerError(errData.error || 'Failed to update category status.');
      }
      const data = await res.json().catch(() => ({}));
      triggerSuccess(data.isActive ? 'Category reactivated.' : 'Category deactivated.');
      if (onRefreshDb) await onRefreshDb();
    } catch (err) {
      triggerError('Failed to update category status.');
    }
  };

  // Handlers - Units of Measure
  const handleSaveUnit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!(editingId ? canUpdateUnits : canCreateUnits)) return triggerError('Only Administrators can edit units.');
    if (!unitName.trim()) return triggerError('Unit name is required.');
    if (!unitCode.trim()) return triggerError('Unit code is required.');

    const unitData = {
      id: editingId || generateId(),
      name: unitName.trim(),
      code: unitCode.trim(),
      companyId: db.selectedCompanyId
    };

    try {
      const res = await fetch('/api/units-of-measure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(unitData)
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        return triggerError(errData.error || 'Failed to save unit.');
      }
      triggerSuccess(editingId ? 'Unit updated successfully.' : 'Unit added successfully.');
      clearForm();
      onDirtyChange?.(false);
      if (onRefreshDb) await onRefreshDb();
      onDone();
    } catch (err) {
      triggerError('Failed to save unit.');
    }
  };

  const handleToggleUnitActive = async (id: string) => {
    if (!canDeleteUnits) return triggerError(t('Insufficient permissions.'));
    const unit = db.unitsOfMeasure.find(u => u.id === id);
    const isActive = unit?.isActive !== false;
    if (isActive && !window.confirm(t("Deactivate this unit of measure? It'll be hidden from new documents but all its history stays intact. You can reactivate it anytime."))) return;

    try {
      const res = await fetch(`/api/units-of-measure/${id}/toggle-active`, { method: 'PATCH' });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        return triggerError(errData.error || 'Failed to update unit status.');
      }
      const data = await res.json().catch(() => ({}));
      triggerSuccess(data.isActive ? 'Unit reactivated.' : 'Unit deactivated.');
      if (onRefreshDb) await onRefreshDb();
    } catch (err) {
      triggerError('Failed to update unit status.');
    }
  };

  // Handlers - Warehouses
  const handleSaveWarehouse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!(editingId ? canUpdateWarehouses : canCreateWarehouses)) return triggerError('Only Administrators can edit warehouses.');
    if (!whName.trim()) return triggerError('Warehouse name is required.');
    if (!whCode.trim()) return triggerError('Warehouse code is required.');

    const warehouseData = {
      id: editingId || generateId(),
      name: whName.trim(),
      code: whCode.trim(),
      address: whAddress.trim() || null,
      isActive: whIsActive,
      companyId: db.selectedCompanyId,
      branchId: whBranchId || null,
      type: whType,
      // Omitted entirely (not even `false`) when creating a new warehouse and the
      // checkbox was left unchecked — lets the server auto-default a company's very
      // first warehouse. On an edit, always sent explicitly so an admin can un-default
      // one warehouse in favor of another.
      isCompanyDefault: editingId ? whIsCompanyDefault : (whIsCompanyDefault ? true : undefined),
    };

    try {
      const res = await fetch('/api/warehouses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(warehouseData)
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        return triggerError(errData.error || 'Failed to save warehouse.');
      }
      triggerSuccess(editingId ? 'Warehouse updated successfully.' : 'Warehouse added successfully.');
      clearForm();
      onDirtyChange?.(false);
      if (onRefreshDb) await onRefreshDb();
      onDone();
    } catch (err) {
      triggerError('Failed to save warehouse.');
    }
  };

  const handleToggleWarehouseActive = async (id: string) => {
    if (!canDeleteWarehouses) return triggerError(t('Insufficient permissions.'));
    const wh = db.warehouses.find(w => w.id === id);
    const isActive = wh?.isActive !== false;
    if (isActive && !window.confirm(t("Deactivate this warehouse? It'll be hidden from new documents but all its history stays intact. You can reactivate it anytime."))) return;

    try {
      const res = await fetch(`/api/warehouses/${id}/toggle-active`, { method: 'PATCH' });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        return triggerError(errData.error || 'Failed to update warehouse status.');
      }
      const data = await res.json().catch(() => ({}));
      triggerSuccess(data.isActive ? 'Warehouse reactivated.' : 'Warehouse deactivated.');
      if (onRefreshDb) await onRefreshDb();
    } catch (err) {
      triggerError('Failed to update warehouse status.');
    }
  };

  // Handlers - Product Warehouses (Junction)
  const handleAddWarehouseMapping = async (productId: string) => {
    if (!productId) return triggerError('No product selected.');
    if (!addPwWarehouseId) return triggerError('Please select a warehouse.');

    const mappingData = {
      productId,
      warehouseId: addPwWarehouseId,
      binLocation: addPwBin || null,
      minLevel: addPwMin ? String(addPwMin) : null,
      maxLevel: addPwMax ? String(addPwMax) : null,
      reorderLeadTime: addPwLeadTime || null
    };

    try {
      const res = await fetch('/api/product-warehouses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mappingData)
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        return triggerError(errData.error || 'Failed to map warehouse.');
      }
      triggerSuccess('Warehouse mapped successfully.');
      // Reset warehouse adding state
      setAddPwWarehouseId('');
      setAddPwBin('');
      setAddPwMin('');
      setAddPwMax('');
      setAddPwLeadTime('');
      if (onRefreshDb) await onRefreshDb();
      
      // Update local view list
      const pwRes = await fetch(`/api/product-warehouses`);
      if (pwRes.ok) {
        const pwData = await pwRes.json();
        setActiveProductWarehouses(pwData.filter((pw: any) => pw.productId === productId));
      }
    } catch (err) {
      triggerError('Failed to save warehouse mapping.');
    }
  };

  const handleDeleteWarehouseMapping = async (mappingId: string, productId: string) => {
    if (!window.confirm(t('Are you sure you want to remove this warehouse location mapping?'))) return;

    try {
      const res = await fetch(`/api/product-warehouses/${mappingId}`, { method: 'DELETE' });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        return triggerError(errData.error || 'Failed to delete mapping.');
      }
      triggerSuccess('Warehouse location removed.');
      if (onRefreshDb) await onRefreshDb();
      
      // Update local view list
      const pwRes = await fetch(`/api/product-warehouses`);
      if (pwRes.ok) {
        const pwData = await pwRes.json();
        setActiveProductWarehouses(pwData.filter((pw: any) => pw.productId === productId));
      }
    } catch (err) {
      triggerError('Failed to remove warehouse location.');
    }
  };

  // Handlers - Product Unit Conversions (packaging/alternate units)
  const clearUnitConversionForm = () => {
    setAddPucUnitId('');
    setAddPucFactor('');
    setAddPucBarcode('');
    setAddPucSku('');
    setAddPucPurchasePrice('');
    setAddPucSalePrice('');
  };

  const handleAddUnitConversion = async (productId: string) => {
    if (!productId) return triggerError('No product selected.');
    if (!addPucUnitId) return triggerError('Please select a unit of measure.');
    const factor = parseFloat(addPucFactor);
    if (!factor || factor <= 0) return triggerError('Conversion factor must be a positive number.');

    const conversionData = {
      productId,
      unitOfMeasureId: addPucUnitId,
      conversionFactor: String(factor),
      barcode: addPucBarcode.trim() || null,
      sku: addPucSku.trim() || null,
      purchasePrice: addPucPurchasePrice ? String(parseFloat(addPucPurchasePrice)) : null,
      salePrice: addPucSalePrice ? String(parseFloat(addPucSalePrice)) : null,
    };

    try {
      const res = await fetch('/api/product-unit-conversions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(conversionData)
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        return triggerError(errData.error || 'Failed to save packaging unit.');
      }
      triggerSuccess('Packaging unit added successfully.');
      clearUnitConversionForm();
      if (onRefreshDb) await onRefreshDb();
    } catch (err) {
      triggerError('Failed to save packaging unit.');
    }
  };

  const handleToggleUnitConversionActive = async (id: string) => {
    const puc = (db.productUnitConversions || []).find(p => p.id === id);
    const isActive = puc?.isActive !== false;
    if (isActive && !window.confirm(t('Deactivate this packaging unit? It will no longer be selectable on new transactions, but its history stays intact.'))) return;
    try {
      const res = await fetch(`/api/product-unit-conversions/${id}/toggle-active`, { method: 'PATCH' });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        return triggerError(errData.error || 'Failed to update packaging unit status.');
      }
      triggerSuccess(isActive ? 'Packaging unit deactivated.' : 'Packaging unit reactivated.');
      if (onRefreshDb) await onRefreshDb();
    } catch (err) {
      triggerError('Failed to update packaging unit status.');
    }
  };

 const handleStartEdit = (entity: any, type: SubTab) => {
   setEditingId(entity.id);
   if (type === 'products') {
     setProdName(entity.name);
     setProdDescription(entity.description || '');
     setProdSalesPurchaseFlow(entity.salesPurchaseFlow ?? 0);
     setProdPrice(entity.unitPrice.toString());
     setProdCostPrice(entity.costPrice != null ? entity.costPrice.toString() : '');
     setProdUnit(entity.unit || 'No');
     setProdIsPos(entity.isPosItem || false);
     setProdCategory(entity.category || '');
     setProdImage(entity.base64Image || '');
     setProdBarcode(entity.barcode || '');
     setProdSku(entity.sku || '');
     setProdCatalogType(entity.itemKind || 'item');
     setProdCategoryId(entity.categoryId || '');
     setProdDefaultWarehouseId(entity.defaultWarehouseId || '');
     setProdBinLocation(entity.binLocation || '');
     setProdMinLevel(entity.minLevel ? String(entity.minLevel) : '');
     setProdMaxLevel(entity.maxLevel ? String(entity.maxLevel) : '');
     setProdReorderLeadTime(entity.reorderLeadTime || '');
     setProdGridPosition(entity.posGridPosition != null ? String(entity.posGridPosition) : '');
     setProdModifierGroupIds(Array.isArray(entity.modifierGroupIds) ? entity.modifierGroupIds : []);

     // Load associated warehouse links
     const associated = db.productWarehouses.filter((pw: any) => pw.productId === entity.id);
     setActiveProductWarehouses(associated);
   } else if (type === 'categories') {
     setCatName(entity.name);
     setCatParentId(entity.parentCategoryId || '');
     setCatSalesGl(entity.salesGlGroup || '4000 - Product Sales');
     setCatPurchaseGl(entity.purchaseGlGroup || '1200 - Inventory Asset');
     setCatCogsGl(entity.cogsGlGroup || '5000 - Cost of Goods Sold');
   } else if (type === 'units') {
     setUnitName(entity.name);
     setUnitCode(entity.code);
   } else if (type === 'warehouses') {
     setWhName(entity.name);
     setWhCode(entity.code);
     setWhAddress(entity.address || '');
     setWhIsActive(entity.isActive ?? true);
     setWhBranchId((entity as any).branchId || '');
     setWhType(((entity as any).type === 'backend') ? 'backend' : 'sales');
     setWhIsCompanyDefault((entity as any).isCompanyDefault === true);
   } else {
     setName(entity.name);
     setEmail(entity.email || '');
     setPhone(entity.phone || '');
     setAddress(entity.address || '');
     setTaxRegNumber(entity.taxRegNumber || '');
     setBuyerType(entity.buyerType === 'B2C' ? 'B2C' : 'B2B');
     setZatcaVatNumber(entity.vatNumber || '');
     setZatcaStreetName(entity.streetName || '');
     setZatcaBuildingNumber(entity.buildingNumber || '');
     setZatcaDistrict(entity.district || '');
     setZatcaCity(entity.city || '');
     setZatcaPostalCode(entity.postalCode || '');
     setEntityCrNumber(entity.crNumber || '');
   }
 };

 // Mirrors server/lib/zatca/validators.ts's validateBuyerFields — B2C only needs a
 // name; B2B needs a full, verifiable identity for a valid ZATCA AccountingCustomerParty.
 const buyerFieldErrors: string[] = [];
 if (!name.trim()) buyerFieldErrors.push('Name is required.');
 if (buyerType === 'B2B') {
   if (!/^3\d{13}3$/.test(zatcaVatNumber.trim())) buyerFieldErrors.push('VAT number must be exactly 15 digits, starting and ending with 3, for a B2B customer/vendor.');
   if (!zatcaStreetName.trim()) buyerFieldErrors.push('Street name is required for a B2B customer/vendor.');
   if (!zatcaBuildingNumber.trim()) buyerFieldErrors.push('Building number is required for a B2B customer/vendor.');
   if (!zatcaDistrict.trim()) buyerFieldErrors.push('District is required for a B2B customer/vendor.');
   if (!zatcaCity.trim()) buyerFieldErrors.push('City is required for a B2B customer/vendor.');
   if (!/^\d{5}$/.test(zatcaPostalCode.trim())) buyerFieldErrors.push('Postal code must be exactly 5 digits for a B2B customer/vendor.');
 }

 // Prefill the form once the record to edit has loaded from the server (the Add
 // page fetches the same full company directory as the List page on mount).
 React.useEffect(() => {
 if (mode !== 'add' || !editId || !forceSubTab) return;
 const list = forceSubTab === 'customers' ? db.customers
   : forceSubTab === 'vendors' ? db.vendors
   : forceSubTab === 'products' ? db.products
   : forceSubTab === 'categories' ? db.productCategories
   : forceSubTab === 'units' ? db.unitsOfMeasure
   : db.warehouses;
 const entity: any = list.find((e: any) => e.id === editId);
 if (entity) {
   handleStartEdit(entity, forceSubTab);
   // Baseline for the dirty-guard, built from the entity's own fields (not the state
   // variables handleStartEdit just called setters for — those haven't updated yet
   // within this synchronous effect). Only the fields handleStartEdit actually sets for
   // this entity type need real values; every other sub-tab's fields stay at their
   // useState defaults regardless, so reusing the same literal here for those is exact.
   if (forceSubTab === 'products') {
     markFormClean({
       name: '', email: '', phone: '', address: '', taxRegNumber: '', buyerType: 'B2C',
       zatcaVatNumber: '', zatcaStreetName: '', zatcaBuildingNumber: '', zatcaDistrict: '',
       zatcaCity: '', zatcaPostalCode: '', entityCrNumber: '',
       prodName: entity.name, prodDescription: entity.description || '', prodSalesPurchaseFlow: entity.salesPurchaseFlow ?? 0, prodPrice: entity.unitPrice.toString(),
       prodCostPrice: entity.costPrice != null ? entity.costPrice.toString() : '',
       prodUnit: entity.unit || 'No', prodIsPos: entity.isPosItem || false,
       prodCategory: entity.category || '', prodImage: entity.base64Image || '',
       prodBarcode: entity.barcode || '', prodSku: entity.sku || '',
       prodCatalogType: entity.itemKind || 'item', prodCategoryId: entity.categoryId || '',
       prodDefaultWarehouseId: entity.defaultWarehouseId || '', prodBinLocation: entity.binLocation || '',
       prodMinLevel: entity.minLevel ? String(entity.minLevel) : '',
       prodMaxLevel: entity.maxLevel ? String(entity.maxLevel) : '',
       prodReorderLeadTime: entity.reorderLeadTime || '',
       prodGridPosition: entity.posGridPosition != null ? String(entity.posGridPosition) : '',
       prodModifierGroupIds: Array.isArray(entity.modifierGroupIds) ? entity.modifierGroupIds : [],
       catName: '', catParentId: '', catSalesGl: '4000 - Product Sales',
       catPurchaseGl: '1200 - Inventory Asset', catCogsGl: '5000 - Cost of Goods Sold',
       unitName: '', unitCode: '',
       whName: '', whCode: '', whAddress: '', whIsActive: true, whBranchId: '',
       whType: 'sales' as const, whIsCompanyDefault: false,
     });
   } else if (forceSubTab === 'categories') {
     markFormClean({
       name: '', email: '', phone: '', address: '', taxRegNumber: '', buyerType: 'B2C',
       zatcaVatNumber: '', zatcaStreetName: '', zatcaBuildingNumber: '', zatcaDistrict: '',
       zatcaCity: '', zatcaPostalCode: '', entityCrNumber: '',
       prodName: '', prodDescription: '', prodSalesPurchaseFlow: 0, prodPrice: '', prodCostPrice: '', prodUnit: 'PCE',
       prodIsPos: false, prodCategory: '', prodImage: '', prodBarcode: '', prodSku: '',
       prodCatalogType: 'item', prodCategoryId: '', prodDefaultWarehouseId: '', prodBinLocation: '',
       prodMinLevel: '', prodMaxLevel: '', prodReorderLeadTime: '', prodGridPosition: '',
       prodModifierGroupIds: [] as string[],
       catName: entity.name, catParentId: entity.parentCategoryId || '',
       catSalesGl: entity.salesGlGroup || '4000 - Product Sales',
       catPurchaseGl: entity.purchaseGlGroup || '1200 - Inventory Asset',
       catCogsGl: entity.cogsGlGroup || '5000 - Cost of Goods Sold',
       unitName: '', unitCode: '',
       whName: '', whCode: '', whAddress: '', whIsActive: true, whBranchId: '',
       whType: 'sales' as const, whIsCompanyDefault: false,
     });
   } else if (forceSubTab === 'units') {
     markFormClean({
       name: '', email: '', phone: '', address: '', taxRegNumber: '', buyerType: 'B2C',
       zatcaVatNumber: '', zatcaStreetName: '', zatcaBuildingNumber: '', zatcaDistrict: '',
       zatcaCity: '', zatcaPostalCode: '', entityCrNumber: '',
       prodName: '', prodDescription: '', prodSalesPurchaseFlow: 0, prodPrice: '', prodCostPrice: '', prodUnit: 'PCE',
       prodIsPos: false, prodCategory: '', prodImage: '', prodBarcode: '', prodSku: '',
       prodCatalogType: 'item', prodCategoryId: '', prodDefaultWarehouseId: '', prodBinLocation: '',
       prodMinLevel: '', prodMaxLevel: '', prodReorderLeadTime: '', prodGridPosition: '',
       prodModifierGroupIds: [] as string[],
       catName: '', catParentId: '', catSalesGl: '4000 - Product Sales',
       catPurchaseGl: '1200 - Inventory Asset', catCogsGl: '5000 - Cost of Goods Sold',
       unitName: entity.name, unitCode: entity.code,
       whName: '', whCode: '', whAddress: '', whIsActive: true, whBranchId: '',
       whType: 'sales' as const, whIsCompanyDefault: false,
     });
   } else if (forceSubTab === 'warehouses') {
     markFormClean({
       name: '', email: '', phone: '', address: '', taxRegNumber: '', buyerType: 'B2C',
       zatcaVatNumber: '', zatcaStreetName: '', zatcaBuildingNumber: '', zatcaDistrict: '',
       zatcaCity: '', zatcaPostalCode: '', entityCrNumber: '',
       prodName: '', prodDescription: '', prodSalesPurchaseFlow: 0, prodPrice: '', prodCostPrice: '', prodUnit: 'PCE',
       prodIsPos: false, prodCategory: '', prodImage: '', prodBarcode: '', prodSku: '',
       prodCatalogType: 'item', prodCategoryId: '', prodDefaultWarehouseId: '', prodBinLocation: '',
       prodMinLevel: '', prodMaxLevel: '', prodReorderLeadTime: '', prodGridPosition: '',
       prodModifierGroupIds: [] as string[],
       catName: '', catParentId: '', catSalesGl: '4000 - Product Sales',
       catPurchaseGl: '1200 - Inventory Asset', catCogsGl: '5000 - Cost of Goods Sold',
       unitName: '', unitCode: '',
       whName: entity.name, whCode: entity.code, whAddress: entity.address || '',
       whIsActive: entity.isActive ?? true, whBranchId: (entity as any).branchId || '',
       whType: (((entity as any).type === 'backend') ? 'backend' : 'sales'),
       whIsCompanyDefault: (entity as any).isCompanyDefault === true,
     });
   } else {
     // customers or vendors — same shared field shape.
     markFormClean({
       name: entity.name, email: entity.email || '', phone: entity.phone || '',
       address: entity.address || '', taxRegNumber: entity.taxRegNumber || '',
       buyerType: (entity.buyerType === 'B2C' ? 'B2C' : 'B2B'),
       zatcaVatNumber: entity.vatNumber || '', zatcaStreetName: entity.streetName || '',
       zatcaBuildingNumber: entity.buildingNumber || '', zatcaDistrict: entity.district || '',
       zatcaCity: entity.city || '', zatcaPostalCode: entity.postalCode || '',
       entityCrNumber: entity.crNumber || '',
       prodName: '', prodDescription: '', prodSalesPurchaseFlow: 0, prodPrice: '', prodCostPrice: '', prodUnit: 'PCE',
       prodIsPos: false, prodCategory: '', prodImage: '', prodBarcode: '', prodSku: '',
       prodCatalogType: 'item', prodCategoryId: '', prodDefaultWarehouseId: '', prodBinLocation: '',
       prodMinLevel: '', prodMaxLevel: '', prodReorderLeadTime: '', prodGridPosition: '',
       prodModifierGroupIds: [] as string[],
       catName: '', catParentId: '', catSalesGl: '4000 - Product Sales',
       catPurchaseGl: '1200 - Inventory Asset', catCogsGl: '5000 - Cost of Goods Sold',
       unitName: '', unitCode: '',
       whName: '', whCode: '', whAddress: '', whIsActive: true, whBranchId: '',
       whType: 'sales' as const, whIsCompanyDefault: false,
     });
   }
 }
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [mode, editId, forceSubTab, db.customers, db.vendors, db.products, db.productCategories, db.unitsOfMeasure, db.warehouses]);

 if (!canViewCustomers && !canViewVendors && !canViewProducts && !canViewCategories && !canViewUnits && !canViewWarehouses) {
 return (
 <div className="p-12 bg-white border border-slate-200 rounded-2xl text-center shadow-sm max-w-md mx-auto space-y-4">
 <Lock className="w-12 h-12 text-rose-500 mx-auto animate-bounce" />
 <h3 className="font-extrabold text-slate-900 text-base">{t('Access Restricted')}</h3>
 <p className="text-xs text-slate-400 leading-relaxed">
 {t('Your staff profile does not have permission to access any of the Master Directories (Customers, Vendors, Products, Categories, Units, or Warehouses). Please request your administrator to update your access profile.')}
 </p>
 </div>
 );
 }

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

 {/* Sub Tabs Selection */}
 {!forceSubTab && (
 <div className="bg-white border border-slate-200/80 rounded-2xl p-4 flex flex-wrap gap-2 shadow-sm">
 {canViewCustomers && (
 <button
 onClick={() => { setSubTab('customers'); clearForm(); }}
 className={`px-4 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
 subTab === 'customers' ? 'bg-indigo-600 text-white shadow-sm' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
 }`}
 >
 <Users className="w-3.5 h-3.5" /> Customer Registry
 </button>
 )}
 {canViewVendors && (
 <button
 onClick={() => { setSubTab('vendors'); clearForm(); }}
 className={`px-4 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
 subTab === 'vendors' ? 'bg-indigo-600 text-white shadow-sm' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
 }`}
 >
 <Briefcase className="w-3.5 h-3.5" /> Vendor Directory
 </button>
 )}
 {canViewProducts && (
 <button
 onClick={() => { setSubTab('products'); clearForm(); }}
 className={`px-4 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
 subTab === 'products' ? 'bg-indigo-600 text-white shadow-sm' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
 }`}
 >
 <Layers className="w-3.5 h-3.5" /> Service / Product Inventory
 </button>
 )}
 {canViewCategories && (
 <button
 onClick={() => { setSubTab('categories'); clearForm(); }}
 className={`px-4 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
 subTab === 'categories' ? 'bg-indigo-600 text-white shadow-sm' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
 }`}
 >
 <FolderKanban className="w-3.5 h-3.5" /> Product Categories
 </button>
 )}
 {canViewUnits && (
 <button
 onClick={() => { setSubTab('units'); clearForm(); }}
 className={`px-4 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
 subTab === 'units' ? 'bg-indigo-600 text-white shadow-sm' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
 }`}
 >
 <Scaling className="w-3.5 h-3.5" /> Units of Measure
 </button>
 )}
 {canViewWarehouses && (
 <button
 onClick={() => { setSubTab('warehouses'); clearForm(); }}
 className={`px-4 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
 subTab === 'warehouses' ? 'bg-indigo-600 text-white shadow-sm' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
 }`}
 >
 <MapPin className="w-3.5 h-3.5" /> Physical Warehouses
 </button>
 )}
 </div>
 )}

 <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

 {/* FORM VIEWPORT — Add/Edit page only */}
 {mode === 'add' && (
 <div className="lg:col-span-12 max-w-2xl bg-white border border-slate-200/80 rounded-2xl p-6 shadow-sm h-fit">
 <div className="border-b border-slate-100 pb-4 mb-5 space-y-2">
 <h4 className="text-xs font-extrabold text-slate-900 uppercase tracking-widest flex items-center gap-1.5">
 <span className="w-2 h-2 rounded-full bg-indigo-600 animate-pulse"></span>
 <span>{editingId ? t('Modify Record') : t('Register New Profile')}</span>
 </h4>
 <div className="flex items-center justify-between">
 <span className="text-[9px] font-bold text-indigo-600 bg-indigo-50 border border-indigo-100 px-1.5 py-0.5 rounded uppercase">
 🏢 {t('Company:')} {db.companySetup?.name}
 </span>
 <button
 type="button"
 onClick={onDone}
 className="text-slate-500 hover:text-slate-800 text-xs font-semibold px-2.5 py-1 rounded-lg hover:bg-slate-200/60 transition"
 >
 {t('Back to List')}
 </button>
 </div>
 </div>

 {/* Customer / Vendor Forms */}
 {(subTab === 'customers' || subTab === 'vendors') && (
 <form onSubmit={subTab === 'customers' ? handleSaveCustomer : handleSaveVendor} className="space-y-4 text-xs">

 {(!(editingId ? canUpdateCustomers : canCreateCustomers) && subTab === 'customers') || (!(editingId ? canUpdateVendors : canCreateVendors) && subTab === 'vendors') ? (
 <div className="p-4 bg-rose-50 text-rose-700 rounded-xl border border-rose-100 flex items-start gap-2 text-[11px] font-semibold leading-relaxed">
 <Lock className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
 <span>{t('You do not have the required Staff Permissions to create or modify this directory.')}</span>
 </div>
 ) : (
 <>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Entity Name')}<span className="text-rose-500"> *</span></label>
 <input
 type="text"
 required
 placeholder={t('e.g. CNC Woodworks Ltd')}
 value={name}
 onChange={(e) => setName(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Email Address')}</label>
 <input
 type="email"
 placeholder="billing@example.com"
 value={email}
 onChange={(e) => setEmail(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Contact Phone')}</label>
 <input
 type="text"
 placeholder="+966 5..."
 value={phone}
 onChange={(e) => setPhone(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Physical Address')}</label>
 <input
 type="text"
 placeholder={t('Street, City, Postal Code')}
 value={address}
 onChange={(e) => setAddress(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('VAT Registration Number')}</label>
 <input
 type="text"
 placeholder="e.g. 300123456700003"
 value={taxRegNumber}
 onChange={(e) => setTaxRegNumber(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>

 <div className="space-y-4 pt-2 border-t border-slate-100">
 <div>
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-2">{t('ZATCA Invoice Type')}</label>
 <div className="flex gap-2">
 {(['B2B', 'B2C'] as const).map(bt => (
 <button
 key={bt}
 type="button"
 onClick={() => setBuyerType(bt)}
 className={`flex-1 px-3 py-2 rounded-xl text-[11px] font-bold border transition-all ${
 buyerType === bt ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
 }`}
 >
 {bt === 'B2B' ? t('B2B — Standard Invoice') : t('B2C — Simplified Invoice')}
 </button>
 ))}
 </div>
 <p className="text-[10px] text-slate-400 mt-1.5">
 {buyerType === 'B2C'
 ? t('Simplified (B2C): only the name above is required for ZATCA.')
 : t('Standard (B2B): ZATCA requires a full, verifiable buyer identity below.')}
 </p>
 </div>

 {buyerType === 'B2B' && (
 <div className="grid grid-cols-2 gap-3 bg-slate-50 p-4 rounded-xl border border-slate-200/60">
 <div className="col-span-2 md:col-span-1 space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('ZATCA VAT Number (15 digits)*')}</label>
 <input type="text" placeholder="3xxxxxxxxxxxxxx" value={zatcaVatNumber} onChange={(e) => setZatcaVatNumber(e.target.value)} className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs font-mono text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150" />
 </div>
 <div className="col-span-2 md:col-span-1 space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Building Number*')}</label>
 <input type="text" placeholder="1234" value={zatcaBuildingNumber} onChange={(e) => setZatcaBuildingNumber(e.target.value)} className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150" />
 </div>
 <div className="col-span-2 md:col-span-1 space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Street Name*')}</label>
 <input type="text" placeholder="King Fahd Road" value={zatcaStreetName} onChange={(e) => setZatcaStreetName(e.target.value)} className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150" />
 </div>
 <div className="col-span-2 md:col-span-1 space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('District*')}</label>
 <input type="text" placeholder="Olaya" value={zatcaDistrict} onChange={(e) => setZatcaDistrict(e.target.value)} className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150" />
 </div>
 <div className="col-span-2 md:col-span-1 space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('City*')}</label>
 <input type="text" placeholder="Riyadh" value={zatcaCity} onChange={(e) => setZatcaCity(e.target.value)} className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150" />
 </div>
 <div className="col-span-2 md:col-span-1 space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Postal Code (5 digits)*')}</label>
 <input type="text" placeholder="12345" value={zatcaPostalCode} onChange={(e) => setZatcaPostalCode(e.target.value)} className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs font-mono text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150" />
 </div>
 <div className="col-span-2 md:col-span-1 space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Commercial Registration Number (Optional)')}</label>
 <input type="text" placeholder="1010000000" value={entityCrNumber} onChange={(e) => setEntityCrNumber(e.target.value)} className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs font-mono text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150" />
 </div>
 </div>
 )}

 {buyerFieldErrors.length > 0 && (
 <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-[11px] font-bold text-rose-700 space-y-0.5">
 {buyerFieldErrors.map((e, i) => <div key={i}>• {e}</div>)}
 </div>
 )}
 </div>

 <div className="flex gap-2 pt-3">
 {editingId && (
 <button
 type="button"
 onClick={clearForm}
 className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl font-bold transition-all duration-150"
 >
 {t('Cancel')}
 </button>
 )}
 <button
 type="submit"
 className="flex-1 bg-indigo-600 hover:bg-indigo-700 hover:shadow-lg hover:shadow-indigo-600/10 text-white rounded-xl py-2.5 font-bold transition-all duration-150 text-center"
 >
 {editingId ? t('Save Changes') : t('Register Profile')}
 </button>
 </div>
 </>
 )}
 </form>
 )}

 {/* Product Form */}
 {subTab === 'products' && (
 <form onSubmit={handleSaveProduct} className="space-y-4 text-xs">
 {!(editingId ? canUpdateProducts : canCreateProducts) ? (
 <div className="p-4 bg-rose-50 text-rose-700 rounded-xl border border-rose-100 flex items-start gap-2 text-[11px] font-semibold leading-relaxed">
 <Lock className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
 <span>{t('The catalog is global and read-only for non-admin accounts. Contact an administrator to add tools or services.')}</span>
 </div>
 ) : (
 <>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Product / Service Name')}<span className="text-rose-500"> *</span></label>
 <input
 type="text"
 required
 placeholder="e.g. 2D Plywood Cutting"
 value={prodName}
 onChange={(e) => setProdName(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Description')}<span className="text-rose-500"> *</span></label>
 <textarea
 required
 rows={2}
 placeholder="e.g. 4x8ft plywood sheet, 18mm thickness, cut to size on the CNC router"
 value={prodDescription}
 onChange={(e) => setProdDescription(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150 resize-y"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Product Classification')}</label>
 <select
 value={prodCatalogType}
 onChange={(e) => setProdCatalogType(e.target.value as any)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none transition-all duration-150"
 >
 <option value="item">{t('Physical Item (Stockable & Counted)')}</option>
 <option value="service">{t('Service Rate (Non-Stockable / Labor)')}</option>
 </select>
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('System Category Link')}</label>
 <select
 value={prodCategoryId}
 onChange={(e) => {
 const catId = e.target.value;
 setProdCategoryId(catId);
 const selectedCat = db.productCategories.find(c => c.id === catId);
 if (selectedCat) {
 setProdCategory(selectedCat.name); // Keep legacy field in sync
 } else {
 setProdCategory('');
 }
 }}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none transition-all duration-150"
 >
 <option value="">{t('-- No Category --')}</option>
 {db.productCategories.map(cat => (
 <option key={cat.id} value={cat.id}>{cat.name}</option>
 ))}
 </select>
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Default Warehouse Branch')}</label>
 <select
 value={prodDefaultWarehouseId}
 onChange={(e) => setProdDefaultWarehouseId(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none transition-all duration-150"
 >
 <option value="">{t('-- No Default Warehouse --')}</option>
 {(db.warehouses || []).map(wh => (
 <option key={wh.id} value={wh.id}>{wh.name}</option>
 ))}
 </select>
 </div>

 {prodCatalogType === 'item' && (
 <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200/60 space-y-3 mt-2">
 <div className="text-[10px] font-extrabold text-indigo-600 uppercase tracking-wider">{t('Stock Control & Thresholds')}</div>

 <div className="space-y-1">
 <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">{t('Bin Location / Aisles')}</label>
 <input
 type="text"
 placeholder="e.g. Shelf A-3"
 value={prodBinLocation}
 onChange={(e) => setProdBinLocation(e.target.value)}
 className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none"
 />
 </div>

 <div className="grid grid-cols-2 gap-3">
 <div className="space-y-1">
 <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">{t('Min Level')}</label>
 <input
 type="number"
 placeholder="0"
 value={prodMinLevel}
 onChange={(e) => setProdMinLevel(e.target.value)}
 className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none"
 />
 </div>
 <div className="space-y-1">
 <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">{t('Max Level')}</label>
 <input
 type="number"
 placeholder="e.g. 500"
 value={prodMaxLevel}
 onChange={(e) => setProdMaxLevel(e.target.value)}
 className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none"
 />
 </div>
 </div>

 <div className="space-y-1">
 <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">{t('Reorder Lead-Time')}</label>
 <input
 type="text"
 placeholder="e.g. 3 business days"
 value={prodReorderLeadTime}
 onChange={(e) => setProdReorderLeadTime(e.target.value)}
 className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none"
 />
 </div>
 </div>
 )}

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Transaction Flow Type')}</label>
 <select
 value={String(prodSalesPurchaseFlow)}
 onChange={(e) => setProdSalesPurchaseFlow(Number(e.target.value) as 0 | 1 | 2)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none transition-all duration-150"
 >
 <option value="0">{t('Sales & Purchase (Both)')}</option>
 <option value="1">{t('Sales Earning Flow (Invoicing / POS)')}</option>
 <option value="2">{t('Purchase Supply Flow (Supplier procurement)')}</option>
 </select>
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Unit of Measure')}</label>
 <select
 value={prodUnit}
 onChange={(e) => setProdUnit(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none transition-all duration-150"
 >
 <option value="No">{t('None / Default')}</option>
 <option value="PCE">{t('Piece')} (PCE)</option>
 <option value="Lumpsum">{t('Lumpsum')}</option>
 {db.unitsOfMeasure.map(u => (
 <option key={u.id} value={u.code}>{u.name} ({u.code})</option>
 ))}
 </select>
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Sales Price')} ({db.companySetup?.currency || 'SAR'})<span className="text-rose-500"> *</span></label>
 <input
 type="number"
 required
 step="0.01"
 placeholder="e.g. 45.00"
 value={prodPrice}
 onChange={(e) => setProdPrice(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 <p className="text-[10px] text-slate-400">{t('Charged to customers on invoices, quotations, and POS.')}</p>
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Cost Price')} ({db.companySetup?.currency || 'SAR'})</label>
 <input
 type="number"
 step="0.01"
 placeholder="e.g. 30.00"
 value={prodCostPrice}
 onChange={(e) => setProdCostPrice(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 <p className="text-[10px] text-slate-400">{t('Purchasing/stock cost — defaults GRN and Purchase Order line costs. Leave blank to default from Sales Price.')}</p>
 </div>

 {editingId && prodCatalogType === 'item' && (
 <div className="bg-indigo-50/50 p-3.5 rounded-xl border border-indigo-100 space-y-3 mt-2">
 <div className="text-[10px] font-extrabold text-indigo-700 uppercase tracking-wider flex items-center gap-1">
 <MapPin className="w-3.5 h-3.5" /> {t('Warehouse Extension')}
 </div>
 <p className="text-[10px] text-slate-500 leading-relaxed">
 {t('Link this product to multiple warehouse branches with branch-specific thresholds.')}
 </p>

 {activeProductWarehouses.length > 0 && (
 <div className="bg-white rounded-lg border border-indigo-100 overflow-hidden divide-y divide-indigo-50">
 {activeProductWarehouses.map((pw: any) => {
 const wh = (db.warehouses || []).find(w => w.id === pw.warehouseId);
 return (
 <div key={pw.id} className="p-2 flex items-center justify-between text-[11px]">
 <div className="space-y-0.5">
 <div className="font-bold text-slate-700">{wh ? wh.name : t('Unknown Branch')}</div>
 <div className="text-[10px] text-slate-400 flex flex-wrap gap-x-2">
 {pw.binLocation && <span>{t('Bin:')} {pw.binLocation}</span>}
 {pw.minLevel && <span>{t('Min:')} {pw.minLevel}</span>}
 {pw.maxLevel && <span>{t('Max:')} {pw.maxLevel}</span>}
 </div>
 </div>
 <button
 type="button"
 onClick={() => handleDeleteWarehouseMapping(pw.id, editingId)}
 className="text-rose-500 hover:text-rose-700 p-1"
 >
 <Trash className="w-3.5 h-3.5" />
 </button>
 </div>
 );
 })}
 </div>
 )}

 <div className="bg-white p-2.5 rounded-lg border border-indigo-100/80 space-y-2">
 <div className="font-bold text-indigo-700 text-[10px] uppercase">{t('Link Another Warehouse Branch')}</div>

 <div className="space-y-1">
 <select
 value={addPwWarehouseId}
 onChange={(e) => setAddPwWarehouseId(e.target.value)}
 className="w-full bg-white border border-slate-200 rounded px-2 py-1 text-xs focus:outline-none"
 >
 <option value="">{t('-- Choose Branch --')}</option>
 {(db.warehouses || []).filter(wh => wh.id !== prodDefaultWarehouseId && !activeProductWarehouses.some(pw => pw.warehouseId === wh.id)).map(wh => (
 <option key={wh.id} value={wh.id}>{wh.name}</option>
 ))}
 </select>
 </div>

 <div className="grid grid-cols-2 gap-2">
 <div className="space-y-0.5">
 <label className="text-[9px] font-bold text-slate-400">{t('Bin Location')}</label>
 <input type="text" placeholder="e.g. Row B" value={addPwBin} onChange={(e) => setAddPwBin(e.target.value)} className="w-full bg-white border border-slate-200 rounded px-1.5 py-0.5 text-xs" />
 </div>
 <div className="space-y-0.5">
 <label className="text-[9px] font-bold text-slate-400">{t('Lead Time')}</label>
 <input type="text" placeholder="e.g. 2 days" value={addPwLeadTime} onChange={(e) => setAddPwLeadTime(e.target.value)} className="w-full bg-white border border-slate-200 rounded px-1.5 py-0.5 text-xs" />
 </div>
 <div className="space-y-0.5">
 <label className="text-[9px] font-bold text-slate-400">{t('Min Stock')}</label>
 <input type="number" placeholder="0" value={addPwMin} onChange={(e) => setAddPwMin(e.target.value)} className="w-full bg-white border border-slate-200 rounded px-1.5 py-0.5 text-xs" />
 </div>
 <div className="space-y-0.5">
 <label className="text-[9px] font-bold text-slate-400">{t('Max Stock')}</label>
 <input type="number" placeholder="500" value={addPwMax} onChange={(e) => setAddPwMax(e.target.value)} className="w-full bg-white border border-slate-200 rounded px-1.5 py-0.5 text-xs" />
 </div>
 </div>

 <button
 type="button"
 onClick={() => handleAddWarehouseMapping(editingId)}
 className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-1 rounded text-[10px] uppercase transition"
 >
 {t('Add Location Link')}
 </button>
 </div>
 </div>
 )}

 {editingId && prodCatalogType === 'item' && (
 <div className="bg-amber-50/50 p-3.5 rounded-xl border border-amber-100 space-y-3 mt-2">
 <div className="text-[10px] font-extrabold text-amber-700 uppercase tracking-wider flex items-center gap-1">
 <Package className="w-3.5 h-3.5" /> {t('Alternate / Packaging Units')}
 </div>
 <p className="text-[10px] text-slate-500 leading-relaxed">
 {t('e.g. a Carton of 12 — its own barcode and price, but inventory always stays tracked in this product\'s own base unit.')}
 </p>

 {(db.productUnitConversions || []).filter(puc => puc.productId === editingId).length > 0 && (
 <div className="bg-white rounded-lg border border-amber-100 overflow-hidden divide-y divide-amber-50">
 {(db.productUnitConversions || []).filter(puc => puc.productId === editingId).map(puc => {
 const uom = (db.unitsOfMeasure || []).find(u => u.id === puc.unitOfMeasureId);
 return (
 <div key={puc.id} className={`p-2 flex items-center justify-between text-[11px] ${puc.isActive === false ? 'opacity-50' : ''}`}>
 <div className="space-y-0.5">
 <div className="font-bold text-slate-700">{uom ? uom.name : t('Unknown Unit')} — 1 = {puc.conversionFactor} {t('base units')}</div>
 <div className="text-[10px] text-slate-400 flex flex-wrap gap-x-2">
 {puc.barcode && <span>{t('Barcode:')} {puc.barcode}</span>}
 {puc.sku && <span>{t('SKU:')} {puc.sku}</span>}
 {puc.purchasePrice != null && <span>{t('Buy:')} {puc.purchasePrice}</span>}
 {puc.salePrice != null && <span>{t('Sell:')} {puc.salePrice}</span>}
 {puc.isActive === false && <span className="text-rose-500 font-bold">{t('Inactive')}</span>}
 </div>
 </div>
 <button
 type="button"
 onClick={() => handleToggleUnitConversionActive(puc.id)}
 className={`p-1 ${puc.isActive === false ? 'text-emerald-600 hover:text-emerald-700' : 'text-rose-500 hover:text-rose-700'}`}
 >
 {puc.isActive === false ? <Check className="w-3.5 h-3.5" /> : <Trash className="w-3.5 h-3.5" />}
 </button>
 </div>
 );
 })}
 </div>
 )}

 <div className="bg-white p-2.5 rounded-lg border border-amber-100/80 space-y-2">
 <div className="font-bold text-amber-700 text-[10px] uppercase">{t('Add Packaging Unit')}</div>

 <div className="grid grid-cols-2 gap-2">
 <div className="space-y-0.5">
 <label className="text-[9px] font-bold text-slate-400">{t('Unit of Measure')}</label>
 <select
 value={addPucUnitId}
 onChange={(e) => setAddPucUnitId(e.target.value)}
 className="w-full bg-white border border-slate-200 rounded px-2 py-1 text-xs focus:outline-none"
 >
 <option value="">{t('-- Choose Unit --')}</option>
 {(db.unitsOfMeasure || []).filter(u => u.isActive !== false).map(u => (
 <option key={u.id} value={u.id}>{u.name} ({u.code})</option>
 ))}
 </select>
 </div>
 <div className="space-y-0.5">
 <label className="text-[9px] font-bold text-slate-400">{t('1 Unit = How Many Base Units')}</label>
 <input type="number" min="0" step="0.0001" placeholder="e.g. 12" value={addPucFactor} onChange={(e) => setAddPucFactor(e.target.value)} className="w-full bg-white border border-slate-200 rounded px-1.5 py-0.5 text-xs" />
 </div>
 </div>

 <div className="grid grid-cols-2 gap-2">
 <div className="space-y-0.5">
 <label className="text-[9px] font-bold text-slate-400">{t('Barcode')}</label>
 <input type="text" placeholder={t('This packaging\'s own barcode')} value={addPucBarcode} onChange={(e) => setAddPucBarcode(e.target.value)} className="w-full bg-white border border-slate-200 rounded px-1.5 py-0.5 text-xs" />
 </div>
 <div className="space-y-0.5">
 <label className="text-[9px] font-bold text-slate-400">{t('SKU')}</label>
 <input type="text" value={addPucSku} onChange={(e) => setAddPucSku(e.target.value)} className="w-full bg-white border border-slate-200 rounded px-1.5 py-0.5 text-xs" />
 </div>
 </div>

 <div className="grid grid-cols-2 gap-2">
 <div className="space-y-0.5">
 <label className="text-[9px] font-bold text-slate-400">{t('Purchase Price')}</label>
 <input type="number" min="0" step="0.01" placeholder={t('Independent of base price')} value={addPucPurchasePrice} onChange={(e) => setAddPucPurchasePrice(e.target.value)} className="w-full bg-white border border-slate-200 rounded px-1.5 py-0.5 text-xs" />
 </div>
 <div className="space-y-0.5">
 <label className="text-[9px] font-bold text-slate-400">{t('Sale Price')}</label>
 <input type="number" min="0" step="0.01" placeholder={t('Independent of base price')} value={addPucSalePrice} onChange={(e) => setAddPucSalePrice(e.target.value)} className="w-full bg-white border border-slate-200 rounded px-1.5 py-0.5 text-xs" />
 </div>
 </div>

 <button
 type="button"
 onClick={() => handleAddUnitConversion(editingId)}
 className="w-full bg-amber-600 hover:bg-amber-700 text-white font-bold py-1 rounded text-[10px] uppercase transition"
 >
 {t('Add Packaging Unit')}
 </button>
 </div>
 </div>
 )}

 <div className="space-y-4 pt-2 border-t border-slate-100">
                  <div className="flex items-center gap-2">
                    <input type="checkbox" checked={prodIsPos} onChange={(e) => setProdIsPos(e.target.checked)} className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-4 h-4" />
                    <span className="font-bold text-slate-700 text-xs">{t('Enable in POS Module')}</span>
                  </div>

                    <div className="grid grid-cols-2 gap-4 bg-slate-50 p-4 rounded-xl border border-slate-200/60">
                      {prodIsPos && !prodCategoryId && (
                        <div className="col-span-2 p-2.5 bg-amber-50 text-amber-700 rounded-lg border border-amber-100 text-[10px] font-semibold">
                          {t('Set the "System Category Link" field above — POS grouping now reuses that same category (no separate free-text POS category anymore).')}
                        </div>
                      )}
                      <div className="col-span-2 md:col-span-1 space-y-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Barcode')}</label>
                        <input type="text" placeholder="Scan or type" value={prodBarcode} onChange={(e) => setProdBarcode(e.target.value)} className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150" />
                      </div>
                      <div className="col-span-2 md:col-span-1 space-y-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('SKU')}</label>
                        <input type="text" placeholder="Stock Keeping Unit" value={prodSku} onChange={(e) => setProdSku(e.target.value)} className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150" />
                      </div>
                      {prodIsPos && (
                        <div className="col-span-2 md:col-span-1 space-y-1">
                          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('POS Grid Position')}</label>
                          <input type="number" min="1" placeholder={t('Not on priority grid')} value={prodGridPosition} onChange={(e) => setProdGridPosition(e.target.value)} className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150" />
                          <p className="text-[10px] text-slate-400">{t('Lower shows first on the POS Terminal grid. Leave blank to keep this item off the priority grid (still reachable via category/search).')}</p>
                        </div>
                      )}
                      {prodIsPos && (db.modifierGroups || []).length > 0 && (
                        <div className="col-span-2 space-y-1">
                          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('POS Modifiers (optional)')}</label>
                          <div className="flex flex-wrap gap-2 bg-white border border-slate-200 rounded-xl p-3">
                            {(db.modifierGroups || []).filter((g: any) => g.isActive !== false).map((g: any) => {
                              const checked = prodModifierGroupIds.includes(g.id);
                              return (
                                <label key={g.id} className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold cursor-pointer border ${checked ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                                  <input type="checkbox" checked={checked} onChange={() => setProdModifierGroupIds(prev => checked ? prev.filter(id => id !== g.id) : [...prev, g.id])} className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5" />
                                  {g.name}{g.isRequired ? ' *' : ''}
                                </label>
                              );
                            })}
                          </div>
                          <p className="text-[10px] text-slate-400">{t('A customer picks one of these on the POS Terminal before this item is added to the sale. Leave all unchecked for a plain item with no customization.')}</p>
                        </div>
                      )}
                      <div className="col-span-2 space-y-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Product Image (Base64)')}</label>
                        <input type="file" accept="image/*" onChange={(e) => {
                          const file = e.target.files?.[0];
                          if(!file) return;
                          const activeComp = db.companies.find(c => c.id === db.selectedCompanyId);
                          const maxSizeKB = activeComp.posSettings?.maxImageSizeKB || 150;
                          const maxDim = activeComp.posSettings?.maxImageDimensions || 600;
                          const minDim = activeComp.posSettings?.minImageDimensions || 150;

                          if (file.size > maxSizeKB * 1024) {
                            alert(`${t('File too large! Maximum allowed size is')} ${maxSizeKB}KB.`);
                            e.target.value = '';
                            return;
                          }

                          const reader = new FileReader();
                          reader.onload = (event) => {
                            const img = new Image();
                            img.onload = () => {
                              if (img.width > maxDim || img.height > maxDim) {
                                alert(`${t('Image dimensions too large! Max allowed is')} ${maxDim}x${maxDim}px.`);
                                e.target.value = '';
                                return;
                              }
                              if (minDim && (img.width < minDim || img.height < minDim)) {
                                alert(`${t('Image dimensions too small! Minimum allowed is')} ${minDim}x${minDim}px.`);
                                e.target.value = '';
                                return;
                              }
                              setProdImage(event.target?.result as string);
                            };
                            img.src = event.target?.result as string;
                          };
                          reader.readAsDataURL(file);
                        }} className="w-full text-xs text-slate-600 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100" />
                        {prodImage && <img src={prodImage} alt={t('Preview')} className="w-16 h-16 object-cover rounded-lg border border-slate-200 mt-2 shadow-sm" />}
                      </div>
                    </div>
                </div>
 <div className="flex gap-2 pt-3">
 {editingId && (
 <button
 type="button"
 onClick={clearForm}
 className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl font-bold transition-all duration-150"
 >
 {t('Cancel')}
 </button>
 )}
 <button
 type="submit"
 className="flex-1 bg-indigo-600 hover:bg-indigo-700 hover:shadow-lg hover:shadow-indigo-600/10 text-white rounded-xl py-2.5 font-bold transition-all duration-150 text-center"
 >
 {editingId ? t('Save Product') : t('Add to Inventory')}
 </button>
 </div>
 </>
 )}
 </form>
 )}

 {/* Product Category Form */}
 {subTab === 'categories' && (
 <form onSubmit={handleSaveCategory} className="space-y-4 text-xs">
 {!(editingId ? canUpdateCategories : canCreateCategories) ? (
 <div className="p-4 bg-rose-50 text-rose-700 rounded-xl border border-rose-100 flex items-start gap-2 text-[11px] font-semibold leading-relaxed">
 <Lock className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
 <span>{t('You do not have permissions to manage categories.')}</span>
 </div>
 ) : (
 <>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Category Name')}<span className="text-rose-500"> *</span></label>
 <input
 type="text"
 required
 placeholder="e.g. Raw Timber"
 value={catName}
 onChange={(e) => setCatName(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Parent Category (Optional)')}</label>
 <select
 value={catParentId}
 onChange={(e) => setCatParentId(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none transition-all duration-150"
 >
 <option value="">{t('-- No Parent (Top Level) --')}</option>
 {db.productCategories.filter(c => c.id !== editingId).map(c => (
 <option key={c.id} value={c.id}>{c.name}</option>
 ))}
 </select>
 </div>

 <div className="border-t border-slate-100 pt-3 mt-2 space-y-3">
 <h5 className="text-[10px] font-extrabold text-indigo-600 uppercase tracking-wider">{t('Accounting GL Mapping')}</h5>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Sales/Revenue GL Account')}<span className="text-rose-500"> *</span></label>
 <input
 type="text"
 required
 placeholder="e.g. 4000 - Product Sales"
 value={catSalesGl}
 onChange={(e) => setCatSalesGl(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Inventory Asset GL Account')}<span className="text-rose-500"> *</span></label>
 <input
 type="text"
 required
 placeholder="e.g. 1200 - Inventory Asset"
 value={catPurchaseGl}
 onChange={(e) => setCatPurchaseGl(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('COGS / Expense GL Account')}<span className="text-rose-500"> *</span></label>
 <input
 type="text"
 required
 placeholder="e.g. 5000 - Cost of Goods Sold"
 value={catCogsGl}
 onChange={(e) => setCatCogsGl(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>
 </div>

 <div className="flex gap-2 pt-3">
 {editingId && (
 <button
 type="button"
 onClick={clearForm}
 className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl font-bold transition-all duration-150"
 >
 {t('Cancel')}
 </button>
 )}
 <button
 type="submit"
 className="flex-1 bg-indigo-600 hover:bg-indigo-700 hover:shadow-lg hover:shadow-indigo-600/10 text-white rounded-xl py-2.5 font-bold transition-all duration-150 text-center"
 >
 {editingId ? t('Save Category') : t('Create Category')}
 </button>
 </div>
 </>
 )}
 </form>
 )}

 {/* Unit of Measure Form */}
 {subTab === 'units' && (
 <form onSubmit={handleSaveUnit} className="space-y-4 text-xs">
 {!(editingId ? canUpdateUnits : canCreateUnits) ? (
 <div className="p-4 bg-rose-50 text-rose-700 rounded-xl border border-rose-100 flex items-start gap-2 text-[11px] font-semibold leading-relaxed">
 <Lock className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
 <span>{t('You do not have permissions to manage units.')}</span>
 </div>
 ) : (
 <>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('ZATCA Unit Code')}<span className="text-rose-500"> *</span></label>
 {/* Constrained to the allowed UN/ECE Recommendation 20 codes ZATCA's UBL invoices
     require (src/zatcaUnitCodes.ts) — this used to be free text (placeholder literally
     suggested "PCS, BOX", neither a real code), so a unit created here could never
     actually be submitted to ZATCA correctly. The server enforces this too; the picker
     is so an admin lands on a valid choice in the first place instead of hitting a
     rejection after typing. */}
 <select
 required
 value={unitCode}
 onChange={(e) => {
 const code = e.target.value;
 setUnitCode(code);
 const preset = ZATCA_UNIT_CODES.find(u => u.code === code);
 if (preset && (!unitName.trim() || ZATCA_UNIT_CODES.some(u => u.label === unitName.trim()))) {
 setUnitName(preset.label);
 }
 }}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none transition-all duration-150"
 >
 <option value="" disabled>{t('Select a ZATCA-recognized unit code...')}</option>
 {ZATCA_UNIT_CODES.map(u => (
 <option key={u.code} value={u.code}>{u.code} — {u.label} ({u.category})</option>
 ))}
 </select>
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Display Name')}<span className="text-rose-500"> *</span></label>
 <input
 type="text"
 required
 placeholder="e.g. Kilogram, Box of 12"
 value={unitName}
 onChange={(e) => setUnitName(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 <p className="text-[9px] text-slate-400">{t("Shown to users; the ZATCA code above is what's actually submitted on invoices.")}</p>
 </div>

 <div className="flex gap-2 pt-3">
 {editingId && (
 <button
 type="button"
 onClick={clearForm}
 className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl font-bold transition-all duration-150"
 >
 {t('Cancel')}
 </button>
 )}
 <button
 type="submit"
 className="flex-1 bg-indigo-600 hover:bg-indigo-700 hover:shadow-lg hover:shadow-indigo-600/10 text-white rounded-xl py-2.5 font-bold transition-all duration-150 text-center"
 >
 {editingId ? t('Save Unit') : t('Create Unit')}
 </button>
 </div>
 </>
 )}
 </form>
 )}

 {/* Physical Warehouses Form */}
 {subTab === 'warehouses' && (
 <form onSubmit={handleSaveWarehouse} className="space-y-4 text-xs">
 {!(editingId ? canUpdateWarehouses : canCreateWarehouses) ? (
 <div className="p-4 bg-rose-50 text-rose-700 rounded-xl border border-rose-100 flex items-start gap-2 text-[11px] font-semibold leading-relaxed">
 <Lock className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
 <span>{t('You do not have permissions to manage warehouses.')}</span>
 </div>
 ) : (
 <>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Warehouse Name')}<span className="text-rose-500"> *</span></label>
 <input
 type="text"
 required
 placeholder="e.g. Main Shop Floor"
 value={whName}
 onChange={(e) => setWhName(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Warehouse Code')}<span className="text-rose-500"> *</span></label>
 <input
 type="text"
 required
 placeholder="e.g. WH-MAIN"
 value={whCode}
 onChange={(e) => setWhCode(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Address / Location')}</label>
 <textarea
 placeholder="e.g. Riyadh Industrial Area"
 value={whAddress}
 onChange={(e) => setWhAddress(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150 h-20 resize-none"
 />
 </div>

 {(db.branches || []).filter(b => b.companyId === db.selectedCompanyId && b.isActive !== false).length > 0 && (
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
 {t('Branch')}{!editingId && <span className="text-rose-500"> *</span>}
 </label>
 <select
 value={whBranchId}
 onChange={(e) => setWhBranchId(e.target.value)}
 required={!editingId}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none transition-all duration-150"
 >
 {/* A brand-new warehouse must pick a real branch once the company has any —
     server/routes/masterEntities.ts's POST /warehouses enforces this too. An
     existing warehouse created before that company adopted branches can still
     show/keep "Unassigned" here rather than being forced to pick one on every
     unrelated edit — the backfill action in the Branches tab is the intended
     way to close that gap in bulk. */}
 {editingId && <option value="">{t('Unassigned (shared/company-wide)')}</option>}
 {!editingId && <option value="" disabled>{t('-- Choose Branch --')}</option>}
 {(db.branches || []).filter(b => b.companyId === db.selectedCompanyId && b.isActive !== false).map(b => (
 <option key={b.id} value={b.id}>{b.name}</option>
 ))}
 </select>
 </div>
 )}

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('Warehouse Type')}</label>
 <select
 value={whType}
 onChange={(e) => setWhType(e.target.value as 'sales' | 'backend')}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none transition-all duration-150"
 >
 <option value="sales">{t('Sales / Location Warehouse')}</option>
 <option value="backend">{t('Backend / Distribution Warehouse (not sellable from)')}</option>
 </select>
 <p className="text-[10px] text-slate-400">{t('A sale can only be posted against a Sales warehouse. Backend warehouses receive/store stock but never appear as a sales default.')}</p>
 </div>

 <div className="flex items-center gap-2 py-1.5">
 <input
 type="checkbox"
 id="whIsActive"
 checked={whIsActive}
 onChange={(e) => setWhIsActive(e.target.checked)}
 className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-4 h-4"
 />
 <label htmlFor="whIsActive" className="text-[11px] font-bold text-slate-600 cursor-pointer select-none">
 {t('Active & Operational Location')}
 </label>
 </div>

 {whType === 'sales' && (
 <div className="flex items-center gap-2 py-1.5">
 <input
 type="checkbox"
 id="whIsCompanyDefault"
 checked={whIsCompanyDefault}
 onChange={(e) => setWhIsCompanyDefault(e.target.checked)}
 className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-4 h-4"
 />
 <label htmlFor="whIsCompanyDefault" className="text-[11px] font-bold text-slate-600 cursor-pointer select-none">
 {t('Set as company-wide default sales warehouse')}
 </label>
 </div>
 )}

 <div className="flex gap-2 pt-3">
 {editingId && (
 <button
 type="button"
 onClick={clearForm}
 className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl font-bold transition-all duration-150"
 >
 {t('Cancel')}
 </button>
 )}
 <button
 type="submit"
 className="flex-1 bg-indigo-600 hover:bg-indigo-700 hover:shadow-lg hover:shadow-indigo-600/10 text-white rounded-xl py-2.5 font-bold transition-all duration-150 text-center"
 >
 {editingId ? t('Save Warehouse') : t('Create Warehouse')}
 </button>
 </div>
 </>
 )}
 </form>
 )}

 </div>
 )}

 {/* LISTINGS DIRECTORY VIEWPORT — List page only */}
 {mode === 'list' && (
 <div className="lg:col-span-12 bg-white border border-slate-200/80 rounded-2xl shadow-sm overflow-hidden text-xs">
 <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center flex-wrap gap-2">
 <div>
 <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
 {subTab === 'customers' && t('Active Customer Directory')}
 {subTab === 'vendors' && t('Material Suppliers & Vendors Registry')}
 {subTab === 'products' && t('Product Catalog & Service Rates')}
 {subTab === 'categories' && t('Inventory Category Tree & GL Mappings')}
 {subTab === 'units' && t('Units of Measure Registry')}
 {subTab === 'warehouses' && t('Physical Warehouses & Stock Locations')}
 </h4>
 <div className="flex items-center gap-2 mt-0.5">
 <span className="text-[9px] font-bold text-indigo-600 bg-indigo-50 border border-indigo-100 px-1.5 py-0.5 rounded uppercase">
 🏢 {t('Scoped:')} {db.companySetup?.name}
 </span>
 </div>
 </div>
 <span className="px-2.5 py-1 bg-white border border-slate-200/60 rounded-xl text-[10px] font-bold text-slate-500">
 {t('Total:')} {subTab === 'customers' ? companyCustomers.length : subTab === 'vendors' ? companyVendors.length : subTab === 'products' ? companyProducts.length : subTab === 'categories' ? db.productCategories.length : subTab === 'units' ? db.unitsOfMeasure.length : db.warehouses.length} {t('records')}
 </span>
 {((subTab === 'customers' && canCreateCustomers) || (subTab === 'vendors' && canCreateVendors) || (subTab === 'products' && canCreateProducts) || (subTab === 'categories' && canCreateCategories) || (subTab === 'units' && canCreateUnits) || (subTab === 'warehouses' && canCreateWarehouses)) && (
 <button
 onClick={onCreateNew}
 className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-[10px] font-bold flex items-center gap-1"
 >
 <Plus className="w-3 h-3" /> {t('New')} {subTab === 'customers' ? t('Customer') : subTab === 'vendors' ? t('Vendor') : subTab === 'products' ? t('Product') : subTab === 'categories' ? t('Category') : subTab === 'units' ? t('Unit') : t('Warehouse')}
 </button>
 )}
 {subTab === 'products' && canCreateProducts && (
 <button
 onClick={handleRestoreProducts}
 className="px-2.5 py-1 bg-indigo-50 border border-indigo-200 text-indigo-700 hover:bg-indigo-100 rounded-xl text-[10px] font-bold"
 title={t('Restore deleted products that are still in invoices')}
 >
 {t('Restore Missing Products')}
 </button>
 )}
 </div>

 {subTab === 'customers' && (
 <div className="overflow-x-auto">
 <table className="w-full text-start border-collapse">
 <thead>
 <tr className="bg-slate-50/70 border-b border-slate-100 text-[10px] uppercase font-bold text-slate-500 tracking-wider">
 <th className="p-4 ps-5">{t('Customer Profile Name')}</th>
 <th className="p-4">{t('Contact Email')}</th>
 <th className="p-4">{t('VAT Registration')}</th>
 <th className="p-4">{t('Status')}</th>
 <th className="p-4 pe-5 text-end">{t('Actions')}</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100 ">
 {companyCustomers.map(c => (
 <tr key={c.id} className={`hover:bg-slate-50/40 transition-colors duration-150 ${c.isActive === false ? 'opacity-60 text-slate-500' : 'text-slate-700'}`}>
 <td className="p-4 ps-5">
 <span className="font-bold text-slate-900 block">{c.name}</span>
 <span className="text-[10px] text-slate-400 block mt-0.5 font-medium">
 {c.phone || t('No phone')} • {c.address || t('No physical address')}
 </span>
 </td>
 <td className="p-4 font-medium text-slate-600">{c.email || <span className="text-slate-350 italic">{t('None')}</span>}</td>
 <td className="p-4">
 {c.taxRegNumber ? (
 <span className="font-mono font-bold bg-slate-50 border border-slate-100 text-slate-700 rounded px-1.5 py-0.5 text-[10px]">{c.taxRegNumber}</span>
 ) : (
 <span className="text-slate-350 italic text-[10px]">{t('Unregistered')}</span>
 )}
 </td>
 <td className="p-4">
 <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider ${
 c.isActive === false ? 'bg-rose-50 text-rose-700 border border-rose-100' : 'bg-emerald-50 text-emerald-700 border border-emerald-100'
 }`}>
 {c.isActive === false ? t('Inactive') : t('Active')}
 </span>
 </td>
 <td className="p-4 pe-5 text-end space-x-1.5">
 {!c.isSystem ? (
 <div className="inline-flex gap-1.5">
 {canUpdateCustomers && (
 <button
 onClick={() => onEdit(c.id)}
 className="px-2 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 rounded-lg text-[10px] font-bold transition-all duration-150"
 >
 {t('Edit')}
 </button>
 )}
 {canDeleteCustomers && (
 <button
 onClick={() => handleToggleCustomerActive(c.id)}
 className={`px-2 py-1 rounded-lg text-[10px] font-bold transition-all duration-150 ${
 c.isActive === false ? 'bg-emerald-50 hover:bg-emerald-100 text-emerald-600' : 'bg-rose-50 hover:bg-rose-100 text-rose-600'
 }`}
 >
 {c.isActive === false ? t('Reactivate') : t('Deactivate')}
 </button>
 )}
 </div>
 ) : (
 <span className="text-[10px] text-slate-400 bg-slate-100/80 px-2 py-0.5 rounded-md italic font-semibold">{t('System Record')}</span>
 )}
 </td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 )}

 {subTab === 'vendors' && (
 <div className="overflow-x-auto">
 <table className="w-full text-start border-collapse">
 <thead>
 <tr className="bg-slate-50/70 border-b border-slate-100 text-[10px] uppercase font-bold text-slate-500 tracking-wider">
 <th className="p-4 ps-5">{t('Vendor / Material Supplier')}</th>
 <th className="p-4">{t('Email')}</th>
 <th className="p-4">{t('VAT Registration')}</th>
 <th className="p-4">{t('Status')}</th>
 <th className="p-4 pe-5 text-end">{t('Actions')}</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100 ">
 {companyVendors.map(v => (
 <tr key={v.id} className={`hover:bg-slate-50/40 transition-colors duration-150 ${v.isActive === false ? 'opacity-60 text-slate-500' : 'text-slate-700'}`}>
 <td className="p-4 ps-5">
 <span className="font-bold text-slate-900 block">{v.name}</span>
 <span className="text-[10px] text-slate-400 block mt-0.5 font-medium">
 {v.phone || t('No phone')} • {v.address || t('No physical address')}
 </span>
 </td>
 <td className="p-4 font-medium text-slate-600">{v.email || <span className="text-slate-350 italic">{t('None')}</span>}</td>
 <td className="p-4">
 {v.taxRegNumber ? (
 <span className="font-mono font-bold bg-slate-50 border border-slate-100 text-slate-700 rounded px-1.5 py-0.5 text-[10px]">{v.taxRegNumber}</span>
 ) : (
 <span className="text-slate-350 italic text-[10px]">{t('Unregistered')}</span>
 )}
 </td>
 <td className="p-4">
 <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider ${
 v.isActive === false ? 'bg-rose-50 text-rose-700 border border-rose-100' : 'bg-emerald-50 text-emerald-700 border border-emerald-100'
 }`}>
 {v.isActive === false ? t('Inactive') : t('Active')}
 </span>
 </td>
 <td className="p-4 pe-5 text-end space-x-1.5">
 {!v.isSystem ? (
 <div className="inline-flex gap-1.5">
 {canUpdateVendors && (
 <button
 onClick={() => onEdit(v.id)}
 className="px-2 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 rounded-lg text-[10px] font-bold transition-all duration-150"
 >
 {t('Edit')}
 </button>
 )}
 {canDeleteVendors && (
 <button
 onClick={() => handleToggleVendorActive(v.id)}
 className={`px-2 py-1 rounded-lg text-[10px] font-bold transition-all duration-150 ${
 v.isActive === false ? 'bg-emerald-50 hover:bg-emerald-100 text-emerald-600' : 'bg-rose-50 hover:bg-rose-100 text-rose-600'
 }`}
 >
 {v.isActive === false ? t('Reactivate') : t('Deactivate')}
 </button>
 )}
 </div>
 ) : (
 <span className="text-[10px] text-slate-400 bg-slate-100/80 px-2 py-0.5 rounded-md italic font-semibold">{t('System Record')}</span>
 )}
 </td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 )}

 {subTab === 'products' && (
 <div className="overflow-x-auto">
 <table className="w-full text-start border-collapse">
 <thead>
 <tr className="bg-slate-50/70 border-b border-slate-100 text-[10px] uppercase font-bold text-slate-500 tracking-wider">
 <th className="p-4 ps-5">{t('Catalog Service / Item')}</th>
 <th className="p-4">{t('Image')}</th>
 <th className="p-4">{t('POS Enabled')}</th>
 <th className="p-4">{t('Type / Ledger Scope')}</th>
 <th className="p-4">{t('Unit')}</th>
 <th className="p-4">{t('Status')}</th>
 <th className="p-4 text-end">{t('Cost Price')}</th>
 <th className="p-4 text-end">{t('Sales Price')}</th>
 {(canUpdateProducts || canDeleteProducts) && <th className="p-4 pe-5 text-end">{t('Actions')}</th>}
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100 ">
 {companyProducts.map(p => (
 <tr key={p.id} className={`hover:bg-slate-50/40 transition-colors duration-150 ${p.isActive === false ? 'opacity-60 text-slate-500' : 'text-slate-700'}`}>
 <td className="p-4 ps-5 font-bold text-slate-900">{p.name}</td>
 <td className="p-4">
   {p.base64Image ? <img src={p.base64Image} alt={p.name} className="w-10 h-10 object-cover rounded" /> : <div className="w-10 h-10 bg-slate-100 rounded"></div>}
 </td>
 <td className="p-4">{p.isPosItem ? t('Yes') : t('No')}</td>
 <td className="p-4 font-semibold">
 <span className={`px-2.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider ${
 (p as any).salesPurchaseFlow === 1 ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' :
 (p as any).salesPurchaseFlow === 2 ? 'bg-rose-50 text-rose-700 border border-rose-100' :
 'bg-indigo-50 text-indigo-700 border border-indigo-100'
 }`}>
 {(p as any).salesPurchaseFlow === 1 ? t('Sales') : (p as any).salesPurchaseFlow === 2 ? t('Purchase') : t('Both')}
 </span>
 </td>
 <td className="p-4 font-semibold text-slate-600">{p.unit || t('No')}</td>
 <td className="p-4">
 <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider ${
 p.isActive === false ? 'bg-rose-50 text-rose-700 border border-rose-100' : 'bg-emerald-50 text-emerald-700 border border-emerald-100'
 }`}>
 {p.isActive === false ? t('Inactive') : t('Active')}
 </span>
 </td>
 <td className="p-4 text-end text-slate-500 text-sm">
 {db.companySetup?.currency || 'SAR'} {Number(p.costPrice ?? p.unitPrice ?? 0).toFixed(2)}
 {p.costPrice == null && <span className="ms-1 text-[9px] text-slate-400 font-semibold">({t('defaulted')})</span>}
 </td>
 <td className="p-4 text-end font-extrabold text-slate-900 text-sm">{db.companySetup?.currency || 'SAR'} {Number(p.unitPrice || 0).toFixed(2)}</td>
 {(canUpdateProducts || canDeleteProducts) && (
 <td className="p-4 pe-5 text-end space-x-1.5">
 <div className="inline-flex gap-1.5">
 {canUpdateProducts && (
 <button
 onClick={() => onEdit(p.id)}
 className="px-2 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 rounded-lg text-[10px] font-bold transition-all duration-150"
 >
 {t('Edit')}
 </button>
 )}
 {canDeleteProducts && (
 <button
 onClick={() => handleToggleProductActive(p.id)}
 className={`px-2 py-1 rounded-lg text-[10px] font-bold transition-all duration-150 ${
 p.isActive === false ? 'bg-emerald-50 hover:bg-emerald-100 text-emerald-600' : 'bg-rose-50 hover:bg-rose-100 text-rose-600'
 }`}
 >
 {p.isActive === false ? t('Reactivate') : t('Deactivate')}
 </button>
 )}
 </div>
 </td>
 )}
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 )}

 {subTab === 'categories' && (
 <div className="overflow-x-auto">
 <table className="w-full text-start border-collapse">
 <thead>
 <tr className="bg-slate-50/70 border-b border-slate-100 text-[10px] uppercase font-bold text-slate-500 tracking-wider">
 <th className="p-4 ps-5">{t('Category Name')}</th>
 <th className="p-4">{t('Parent Category')}</th>
 <th className="p-4">{t('Sales GL Mapping')}</th>
 <th className="p-4">{t('Asset GL Mapping')}</th>
 <th className="p-4">{t('COGS GL Mapping')}</th>
 <th className="p-4">{t('Status')}</th>
 {(canUpdateCategories || canDeleteCategories) && <th className="p-4 pe-5 text-end">{t('Actions')}</th>}
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100 ">
 {db.productCategories.map(c => {
 // Real saved/schema fields are parentCategoryId/salesGlGroup/purchaseGlGroup/cogsGlGroup
 // — this used to read parentId/salesGlAccount/purchaseGlAccount/cogsGlAccount, which
 // don't exist, so every category with real GL codes and a real parent still displayed
 // "Unmapped"/"-- Top Level --" here regardless of what was actually saved.
 const parent = db.productCategories.find(parentCat => parentCat.id === (c as any).parentCategoryId);
 return (
 <tr key={c.id} className={`hover:bg-slate-50/40 transition-colors duration-150 ${c.isActive === false ? 'opacity-60 text-slate-500' : 'text-slate-700'}`}>
 <td className="p-4 ps-5">
 <span className="font-bold text-slate-900 block">{c.name}</span>
 </td>
 <td className="p-4 text-slate-500 font-medium">{parent ? parent.name : <span className="text-slate-400 italic">{t('-- Top Level --')}</span>}</td>
 <td className="p-4"><code className="font-mono bg-slate-50 border border-slate-100 text-slate-700 rounded px-1.5 py-0.5 text-[10px]">{(c as any).salesGlGroup || t('Unmapped')}</code></td>
 <td className="p-4"><code className="font-mono bg-slate-50 border border-slate-100 text-slate-700 rounded px-1.5 py-0.5 text-[10px]">{(c as any).purchaseGlGroup || t('Unmapped')}</code></td>
 <td className="p-4"><code className="font-mono bg-slate-50 border border-slate-100 text-slate-700 rounded px-1.5 py-0.5 text-[10px]">{(c as any).cogsGlGroup || t('Unmapped')}</code></td>
 <td className="p-4">
 <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider ${
 c.isActive === false ? 'bg-rose-50 text-rose-700 border border-rose-100' : 'bg-emerald-50 text-emerald-700 border border-emerald-100'
 }`}>
 {c.isActive === false ? t('Inactive') : t('Active')}
 </span>
 </td>
 {(canUpdateCategories || canDeleteCategories) && (
 <td className="p-4 pe-5 text-end">
 <div className="inline-flex gap-1.5">
 {canUpdateCategories && (
 <button
 onClick={() => onEdit(c.id)}
 className="px-2 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 rounded-lg text-[10px] font-bold transition-all duration-150"
 >
 {t('Edit')}
 </button>
 )}
 {canDeleteCategories && (
 <button
 onClick={() => handleToggleCategoryActive(c.id)}
 className={`px-2 py-1 rounded-lg text-[10px] font-bold transition-all duration-150 ${
 c.isActive === false ? 'bg-emerald-50 hover:bg-emerald-100 text-emerald-600' : 'bg-rose-50 hover:bg-rose-100 text-rose-600'
 }`}
 >
 {c.isActive === false ? t('Reactivate') : t('Deactivate')}
 </button>
 )}
 </div>
 </td>
 )}
 </tr>
 );
 })}
 </tbody>
 </table>
 </div>
 )}

 {subTab === 'units' && (
 <div className="overflow-x-auto">
 <table className="w-full text-start border-collapse">
 <thead>
 <tr className="bg-slate-50/70 border-b border-slate-100 text-[10px] uppercase font-bold text-slate-500 tracking-wider">
 <th className="p-4 ps-5">{t('Unit Name')}</th>
 <th className="p-4">{t('Unit Code / Abbreviation')}</th>
 <th className="p-4">{t('Status')}</th>
 {canDeleteUnits && <th className="p-4 pe-5 text-end">{t('Actions')}</th>}
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100 ">
 {db.unitsOfMeasure.map(u => (
 <tr key={u.id} className={`hover:bg-slate-50/40 transition-colors duration-150 ${u.isActive === false ? 'opacity-60 text-slate-500' : 'text-slate-700'}`}>
 <td className="p-4 ps-5 font-bold text-slate-900">{u.name}</td>
 <td className="p-4">
 <span className="font-mono font-bold bg-slate-50 border border-slate-100 text-indigo-600 rounded px-1.5 py-0.5 text-[10px]">{u.code}</span>
 </td>
 <td className="p-4">
 <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider ${
 u.isActive === false ? 'bg-rose-50 text-rose-700 border border-rose-100' : 'bg-emerald-50 text-emerald-700 border border-emerald-100'
 }`}>
 {u.isActive === false ? t('Inactive') : t('Active')}
 </span>
 </td>
 {canDeleteUnits && (
 <td className="p-4 pe-5 text-end">
 <button
 onClick={() => handleToggleUnitActive(u.id)}
 className={`px-2 py-1 rounded-lg text-[10px] font-bold transition-all duration-150 ${
 u.isActive === false ? 'bg-emerald-50 hover:bg-emerald-100 text-emerald-600' : 'bg-rose-50 hover:bg-rose-100 text-rose-600'
 }`}
 >
 {u.isActive === false ? t('Reactivate') : t('Deactivate')}
 </button>
 </td>
 )}
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 )}

 {subTab === 'warehouses' && (
 <div className="overflow-x-auto">
 <table className="w-full text-start border-collapse">
 <thead>
 <tr className="bg-slate-50/70 border-b border-slate-100 text-[10px] uppercase font-bold text-slate-500 tracking-wider">
 <th className="p-4 ps-5">{t('Warehouse Code')}</th>
 <th className="p-4">{t('Warehouse Name')}</th>
 <th className="p-4">{t('Location Address')}</th>
 <th className="p-4">{t('Type')}</th>
 <th className="p-4">{t('Status')}</th>
 {(canUpdateWarehouses || canDeleteWarehouses) && <th className="p-4 pe-5 text-end">{t('Actions')}</th>}
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100">
 {db.warehouses.map(wh => (
 <tr key={wh.id} className={`hover:bg-slate-50/40 transition-colors duration-150 ${wh.isActive === false ? 'opacity-60 text-slate-500' : 'text-slate-700'}`}>
 <td className="p-4 ps-5">
 <span className="font-mono font-bold bg-slate-50 border border-slate-100 text-indigo-600 rounded px-1.5 py-0.5 text-[10px]">{wh.code}</span>
 </td>
 <td className="p-4 font-bold text-slate-900">
 {wh.name}
 {wh.isCompanyDefault && <span className="ms-1.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase bg-emerald-50 text-emerald-700 border border-emerald-200">⭐ {t('Default')}</span>}
 </td>
 <td className="p-4 text-slate-500 font-medium">{wh.address || <span className="text-slate-350 italic">{t('No address specified')}</span>}</td>
 <td className="p-4">
 <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider ${
 wh.type === 'backend' ? 'bg-amber-50 text-amber-700 border border-amber-100' : 'bg-indigo-50 text-indigo-700 border border-indigo-100'
 }`}>
 {wh.type === 'backend' ? t('Backend') : t('Sales')}
 </span>
 </td>
 <td className="p-4">
 <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider ${
 wh.isActive !== false ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 'bg-rose-50 text-rose-700 border border-rose-100'
 }`}>
 {wh.isActive !== false ? t('Active') : t('Inactive')}
 </span>
 </td>
 {(canUpdateWarehouses || canDeleteWarehouses) && (
 <td className="p-4 pe-5 text-end space-x-1.5">
 <div className="inline-flex gap-1.5">
 {canUpdateWarehouses && (
 <button
 onClick={() => onEdit(wh.id)}
 className="px-2 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 rounded-lg text-[10px] font-bold transition-all duration-150"
 >
 {t('Edit')}
 </button>
 )}
 {canDeleteWarehouses && (
 <button
 onClick={() => handleToggleWarehouseActive(wh.id)}
 className={`px-2 py-1 rounded-lg text-[10px] font-bold transition-all duration-150 ${
 wh.isActive === false ? 'bg-emerald-50 hover:bg-emerald-100 text-emerald-600' : 'bg-rose-50 hover:bg-rose-100 text-rose-600'
 }`}
 >
 {wh.isActive === false ? t('Reactivate') : t('Deactivate')}
 </button>
 )}
 </div>
 </td>
 )}
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 )}

 </div>
 )}

 </div>

 </div>
 );
}
