import React from 'react';
import { useTranslation, usePermissions } from '../hooks';
// from 'react';
import { DatabaseState, saveDatabase } from '../dbStore';
import { generateId } from '../id';
import { ProductService, Customer, Vendor, User } from '../types';
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
, X, FolderKanban, Scaling, MapPin } from 'lucide-react';

interface MasterEntitiesProps {
 db: DatabaseState;
 onUpdateDb: (db: DatabaseState) => void;
 forceSubTab?: SubTab;
 // 'list' renders the directory table only; 'add' renders the create/edit form only —
 // each is mounted under its own nav tab/permission (e.g. customers vs customers-add).
 mode: 'list' | 'add';
 editId?: string;
 onDone: () => void;
 onEdit: (id: string) => void;
 onCreateNew: () => void;
}

type SubTab = 'customers' | 'vendors' | 'products' | 'categories' | 'units' | 'warehouses';

export default function MasterEntities({ db, onUpdateDb, forceSubTab, mode, editId, onDone, onEdit, onCreateNew }: MasterEntitiesProps) {
 const { t, isRTL, lang } = useTranslation(db);
 const currentUser = db.currentUser;
 const { can } = usePermissions(currentUser);
 const isAdmin = currentUser?.isSuperAdmin || currentUser?.role === 'admin';
  
  // --- Server-side state ---
  const [customers, setCustomers] = React.useState<any[]>([]);
  const [vendors, setVendors] = React.useState<any[]>([]);
  const [products, setProducts] = React.useState<any[]>([]);
  const [categories, setCategories] = React.useState<any[]>([]);
  const [units, setUnits] = React.useState<any[]>([]);
  const [productWarehouses, setProductWarehouses] = React.useState<any[]>([]);
  const [warehouses, setWarehouses] = React.useState<any[]>([]);

  const fetchEntities = async () => {
    if (!db.selectedCompanyId) return;
    try {
      const [cRes, vRes, pRes, catRes, uRes, pwRes, whRes] = await Promise.all([
        fetch(`/api/customers?companyId=${db.selectedCompanyId}`),
        fetch(`/api/vendors?companyId=${db.selectedCompanyId}`),
        fetch(`/api/products?companyId=${db.selectedCompanyId}`),
        fetch(`/api/product-categories?companyId=${db.selectedCompanyId}`),
        fetch(`/api/units-of-measure?companyId=${db.selectedCompanyId}`),
        fetch(`/api/product-warehouses?companyId=${db.selectedCompanyId}`),
        fetch(`/api/warehouses?companyId=${db.selectedCompanyId}`)
      ]);
      const [cData, vData, pData, catData, uData, pwData, whData] = await Promise.all([
        cRes.ok ? cRes.json().catch(() => []) : [],
        vRes.ok ? vRes.json().catch(() => []) : [],
        pRes.ok ? pRes.json().catch(() => []) : [],
        catRes.ok ? catRes.json().catch(() => []) : [],
        uRes.ok ? uRes.json().catch(() => []) : [],
        pwRes.ok ? pwRes.json().catch(() => []) : [],
        whRes.ok ? whRes.json().catch(() => []) : []
      ]);
      setCustomers(Array.isArray(cData) ? cData : []);
      setVendors(Array.isArray(vData) ? vData : []);
      setProducts(Array.isArray(pData) ? pData : []);
      setCategories(Array.isArray(catData) ? catData : []);
      setUnits(Array.isArray(uData) ? uData : []);
      setProductWarehouses(Array.isArray(pwData) ? pwData : []);
      setWarehouses(Array.isArray(whData) ? whData : []);

      // Keep parent app in sync with any newly fetched master entities
      onUpdateDb({
        ...db,
        customers: Array.isArray(cData) ? cData : [],
        vendors: Array.isArray(vData) ? vData : [],
        products: Array.isArray(pData) ? pData : [],
        productCategories: Array.isArray(catData) ? catData : [],
        unitsOfMeasure: Array.isArray(uData) ? uData : [],
        productWarehouses: Array.isArray(pwData) ? pwData : [],
        warehouses: Array.isArray(whData) ? whData : []
      });
    } catch (e) {
      console.error("Failed to fetch master entities:", e);
    }
  };

  React.useEffect(() => {
    fetchEntities();
  }, [db.selectedCompanyId]);
 const [subTab, setSubTab] = React.useState<SubTab>(() => {
 if (forceSubTab) return forceSubTab;
 if (can('customers.view')) return 'customers';
 if (can('vendors.view')) return 'vendors';
 if (can('products.view')) return 'products';
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
 const [buyerType, setBuyerType] = React.useState<'B2B' | 'B2C'>('B2B');
 const [zatcaVatNumber, setZatcaVatNumber] = React.useState('');
 const [zatcaStreetName, setZatcaStreetName] = React.useState('');
 const [zatcaBuildingNumber, setZatcaBuildingNumber] = React.useState('');
 const [zatcaDistrict, setZatcaDistrict] = React.useState('');
 const [zatcaCity, setZatcaCity] = React.useState('');
 const [zatcaPostalCode, setZatcaPostalCode] = React.useState('');

 // Product fields
 const [prodName, setProdName] = React.useState('');
 const [prodType, setProdType] = React.useState<'Sales' | 'Purchase'>('Sales');
 const [prodPrice, setProdPrice] = React.useState('');
 const [prodUnit, setProdUnit] = React.useState('No');
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

  // Warehouses list for editing product
  const [activeProductWarehouses, setActiveProductWarehouses] = React.useState<any[]>([]);
  const [addPwWarehouseId, setAddPwWarehouseId] = React.useState('');
  const [addPwBin, setAddPwBin] = React.useState('');
  const [addPwMin, setAddPwMin] = React.useState('');
  const [addPwMax, setAddPwMax] = React.useState('');
  const [addPwLeadTime, setAddPwLeadTime] = React.useState('');

 const clearForm = () => {
 setEditingId(null);
 setName('');
 setEmail('');
 setPhone('');
 setAddress('');
 setTaxRegNumber('');
 setBuyerType('B2B');
 setZatcaVatNumber('');
 setZatcaStreetName('');
 setZatcaBuildingNumber('');
 setZatcaDistrict('');
 setZatcaCity('');
 setZatcaPostalCode('');
 setProdName('');
 setProdType('Sales');
 setProdPrice('');
 setProdUnit('No');
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
    setActiveProductWarehouses([]);
    setAddPwWarehouseId('');
    setAddPwBin('');
    setAddPwMin('');
    setAddPwMax('');
    setAddPwLeadTime('');
 };

 // Check Permissions using the new granular RBAC permissions
 const canViewCustomers = can('customers.view');
 const canEditCustomers = can('customers.edit');

 const canViewVendors = can('vendors.view');
 const canEditVendors = can('vendors.edit');

 const canViewProducts = can('products.view');
 const canEditProducts = can('products.edit');

 const canViewCategories = can('categories.view');
 const canEditCategories = can('categories.edit');

 const canViewUnits = can('units.view');
 const canEditUnits = can('units.edit');

 const canViewWarehouses = can('warehouses.view');
 const canEditWarehouses = can('warehouses.edit');

  const companyCustomers = customers;
  const companyVendors = vendors;
  const companyProducts = products;
  const uniqueCategories = Array.from(new Set(companyProducts.map(p => p.category).filter(Boolean))) as string[];

 // Handlers - Customers
const handleSaveCustomer = async (e: React.FormEvent) => {
  e.preventDefault();
  if (!canEditCustomers) return triggerError('Insufficient permissions to manage customers.');
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
    clearForm();
    await fetchEntities();
    onDone();
  } catch (err: any) {
    triggerError('Failed to save customer to database.');
  }
  };

 const handleDeleteCustomer = async (id: string) => {
 if (!canEditCustomers) return triggerError('Insufficient permissions.');
 const cust = db.customers.find(c => c.id === id);
 if (cust?.isSystem) return triggerError('System customer cannot be deleted.');
 if (!window.confirm('Are you sure you want to delete this customer?')) return;

 try {
 const res = await fetch('/api/customers/' + id, { method: 'DELETE' });
 if (!res.ok) {
 const errData = await res.json().catch(() => ({}));
 return triggerError(errData.error || 'Failed to delete customer.');
 }
 const newDb = { ...db, customers: db.customers.filter(c => c.id !== id) };
 onUpdateDb(newDb);
 triggerSuccess('Customer profile removed.');
 } catch(err) {
 triggerError('Failed to delete customer.');
 }
 };

 // Handlers - Vendors
 const handleSaveVendor = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!canEditVendors) return triggerError('Insufficient permissions to manage vendors.');
 if (buyerFieldErrors.length > 0) return triggerError(buyerFieldErrors.join(' '));

 const zatcaFields = {
   buyerType,
   vatNumber: zatcaVatNumber || null,
   streetName: zatcaStreetName || null,
   buildingNumber: zatcaBuildingNumber || null,
   district: zatcaDistrict || null,
   city: zatcaCity || null,
   postalCode: zatcaPostalCode || null,
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
 onUpdateDb(newDb);
 clearForm();
 onDone();
 } catch(err) {
 triggerError('Failed to save vendor.');
 }
 };

 const handleDeleteVendor = async (id: string) => {
 if (!canEditVendors) return triggerError('Insufficient permissions.');
 const vend = db.vendors.find(v => v.id === id);
 if (vend?.isSystem) return triggerError('System vendor cannot be deleted.');
 if (!window.confirm('Are you sure you want to delete this vendor?')) return;

 try {
 const res = await fetch('/api/vendors/' + id, { method: 'DELETE' });
 if (!res.ok) {
 const errData = await res.json().catch(() => ({}));
 return triggerError(errData.error || 'Failed to delete vendor.');
 }
 const newDb = { ...db, vendors: db.vendors.filter(v => v.id !== id) };
 onUpdateDb(newDb);
 triggerSuccess('Vendor removed.');
 } catch(err) {
 triggerError('Failed to delete vendor.');
 }
 };

 // Handlers - Products
 const handleSaveProduct = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!canEditProducts) return triggerError('Only Administrator accounts can edit catalog products.');
 if (!prodName.trim()) return triggerError('Product name is required.');
    if (prodIsPos && !prodCategory.trim()) return triggerError('Category is required when Enable for POS is checked.');

 const priceNum = parseFloat(prodPrice);
 if (isNaN(priceNum) || priceNum < 0) return triggerError('Price must be a valid positive number.');

 const newDb = { ...db };
 let savedProd;
 if (editingId) {
 const idx = newDb.products.findIndex(p => p.id === editingId);
 if (idx !== -1) {
 savedProd = {
 ...newDb.products[idx],
 name: prodName,
 type: prodType,
 unitPrice: priceNum,
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
 reorderLeadTime: prodReorderLeadTime
 };
 newDb.products[idx] = savedProd;
 }
 } else {
 savedProd = {
 id: generateId(),
 name: prodName,
 description: '',
 unitPrice: priceNum,
 type: prodType,
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
 companyId: db.selectedCompanyId
 };
 newDb.products.push(savedProd);
 }

 try {
 if (savedProd) {
 await fetch('/api/products', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(savedProd) });
 }
 onUpdateDb(newDb);
 clearForm();
 await fetchEntities();
 onDone();
 } catch(err) {
 triggerError('Failed to save product.');
 }
 };


 const handleRestoreProducts = () => {
 if (!canEditProducts) return triggerError('Admin only.');
 const newDb = { ...db };
 let restoredCount = 0;
 
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

 itemsToCheck.forEach(item => {
 if (!existingProductNames.has(item.name.toLowerCase())) {
 newDb.products.push({
 id: generateId(),
 name: item.name,
 description: 'Restored from existing document',
 type: item.type,
 unitPrice: item.price,
 unit: 'No',
 companyId: db.selectedCompanyId
 });
 existingProductNames.add(item.name.toLowerCase());
 restoredCount++;
 }
 });

 if (restoredCount > 0) {
 onUpdateDb(newDb);
 triggerSuccess(`Successfully restored ${restoredCount} products from historical documents.`);
 } else {
 triggerSuccess('No missing products found in active documents.');
 }
 };

  const handleDeleteProduct = async (id: string) => {
   if (!canEditProducts) return triggerError('Admin only.');
   if (!window.confirm('Are you sure you want to delete this product?')) return;
   
   try {
     const res = await fetch('/api/products/' + id, { method: 'DELETE' });
     if (!res.ok) {
       const errData = await res.json().catch(() => ({}));
       return triggerError(errData.error || 'Failed to delete product.');
     }
     const newDb = {
       ...db,
       products: db.products.filter(p => p.id !== id)
     };
     onUpdateDb(newDb);
     triggerSuccess('Catalog product deleted.');
   } catch (err) {
     triggerError('Failed to delete product.');
   }
  };

  // Handlers - Product Categories
  const handleSaveCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEditCategories) return triggerError('Only Administrators can edit categories.');
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
      clearForm();
      await fetchEntities();
      onDone();
    } catch (err) {
      triggerError('Failed to save category.');
    }
  };

  const handleDeleteCategory = async (id: string) => {
    if (!canEditCategories) return triggerError('Only Administrators can delete categories.');
    if (!window.confirm('Are you sure you want to delete this category?')) return;

    try {
      const res = await fetch(`/api/product-categories/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        return triggerError(errData.error || 'Failed to delete category.');
      }
      triggerSuccess('Category removed.');
      await fetchEntities();
    } catch (err) {
      triggerError('Failed to delete category.');
    }
  };

  // Handlers - Units of Measure
  const handleSaveUnit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEditUnits) return triggerError('Only Administrators can edit units.');
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
      clearForm();
      await fetchEntities();
      onDone();
    } catch (err) {
      triggerError('Failed to save unit.');
    }
  };

  const handleDeleteUnit = async (id: string) => {
    if (!canEditUnits) return triggerError('Only Administrators can delete units.');
    if (!window.confirm('Are you sure you want to delete this unit?')) return;

    try {
      const res = await fetch(`/api/units-of-measure/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        return triggerError(errData.error || 'Failed to delete unit.');
      }
      triggerSuccess('Unit removed.');
      await fetchEntities();
    } catch (err) {
      triggerError('Failed to delete unit.');
    }
  };

  // Handlers - Warehouses
  const handleSaveWarehouse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEditWarehouses) return triggerError('Only Administrators can edit warehouses.');
    if (!whName.trim()) return triggerError('Warehouse name is required.');
    if (!whCode.trim()) return triggerError('Warehouse code is required.');

    const warehouseData = {
      id: editingId || generateId(),
      name: whName.trim(),
      code: whCode.trim(),
      address: whAddress.trim() || null,
      isActive: whIsActive,
      companyId: db.selectedCompanyId
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
      clearForm();
      await fetchEntities();
      onDone();
    } catch (err) {
      triggerError('Failed to save warehouse.');
    }
  };

  const handleDeleteWarehouse = async (id: string) => {
    if (!canEditWarehouses) return triggerError('Only Administrators can delete warehouses.');
    if (!window.confirm('Are you sure you want to delete this warehouse?')) return;

    try {
      const res = await fetch(`/api/warehouses/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        return triggerError(errData.error || 'Failed to delete warehouse.');
      }
      triggerSuccess('Warehouse removed.');
      await fetchEntities();
    } catch (err) {
      triggerError('Failed to delete warehouse.');
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
      await fetchEntities();
      
      // Update local view list
      const pwRes = await fetch(`/api/product-warehouses?companyId=${db.selectedCompanyId}`);
      if (pwRes.ok) {
        const pwData = await pwRes.json();
        setActiveProductWarehouses(pwData.filter((pw: any) => pw.productId === productId));
      }
    } catch (err) {
      triggerError('Failed to save warehouse mapping.');
    }
  };

  const handleDeleteWarehouseMapping = async (mappingId: string, productId: string) => {
    if (!window.confirm('Are you sure you want to remove this warehouse location mapping?')) return;

    try {
      const res = await fetch(`/api/product-warehouses/${mappingId}`, { method: 'DELETE' });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        return triggerError(errData.error || 'Failed to delete mapping.');
      }
      triggerSuccess('Warehouse location removed.');
      await fetchEntities();
      
      // Update local view list
      const pwRes = await fetch(`/api/product-warehouses?companyId=${db.selectedCompanyId}`);
      if (pwRes.ok) {
        const pwData = await pwRes.json();
        setActiveProductWarehouses(pwData.filter((pw: any) => pw.productId === productId));
      }
    } catch (err) {
      triggerError('Failed to remove warehouse location.');
    }
  };

 const handleStartEdit = (entity: any, type: SubTab) => {
   setEditingId(entity.id);
   if (type === 'products') {
     setProdName(entity.name);
     setProdType(entity.type);
     setProdPrice(entity.unitPrice.toString());
     setProdUnit(entity.unit || 'No');
     setProdIsPos(entity.isPosItem || false);
     setProdCategory(entity.category || '');
     setProdImage(entity.base64Image || '');
     setProdBarcode(entity.barcode || '');
     setProdSku(entity.sku || '');
     setProdCatalogType(entity.catalogType || 'item');
     setProdCategoryId(entity.categoryId || '');
     setProdDefaultWarehouseId(entity.defaultWarehouseId || '');
     setProdBinLocation(entity.binLocation || '');
     setProdMinLevel(entity.minLevel ? String(entity.minLevel) : '');
     setProdMaxLevel(entity.maxLevel ? String(entity.maxLevel) : '');
     setProdReorderLeadTime(entity.reorderLeadTime || '');

     // Load associated warehouse links
     const associated = productWarehouses.filter((pw: any) => pw.productId === entity.id);
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
 const list = forceSubTab === 'customers' ? customers
   : forceSubTab === 'vendors' ? vendors
   : forceSubTab === 'products' ? products
   : forceSubTab === 'categories' ? categories
   : forceSubTab === 'units' ? units
   : warehouses;
 const entity = list.find((e: any) => e.id === editId);
 if (entity) handleStartEdit(entity, forceSubTab);
 }, [mode, editId, forceSubTab, customers, vendors, products, categories, units, warehouses]);

 if (!canViewCustomers && !canViewVendors && !canViewProducts && !canViewCategories && !canViewUnits && !canViewWarehouses) {
 return (
 <div className="p-12 bg-white border border-slate-200 rounded-2xl text-center shadow-sm max-w-md mx-auto space-y-4">
 <Lock className="w-12 h-12 text-rose-500 mx-auto animate-bounce" />
 <h3 className="font-extrabold text-slate-900 text-base">Access Restricted</h3>
 <p className="text-xs text-slate-400 leading-relaxed">
 Your staff profile does not have permission to access any of the Master Directories (Customers, Vendors, Products, Categories, Units, or Warehouses). Please request your administrator to update your access profile.
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
 <span>{editingId ? 'Modify Record' : 'Register New Profile'}</span>
 </h4>
 <div className="flex items-center justify-between">
 <span className="text-[9px] font-bold text-indigo-600 bg-indigo-50 border border-indigo-100 px-1.5 py-0.5 rounded uppercase">
 🏢 Company: {db.companySetup?.name}
 </span>
 <button
 type="button"
 onClick={onDone}
 className="text-slate-500 hover:text-slate-800 text-xs font-semibold px-2.5 py-1 rounded-lg hover:bg-slate-200/60 transition"
 >
 Back to List
 </button>
 </div>
 </div>

 {/* Customer / Vendor Forms */}
 {(subTab === 'customers' || subTab === 'vendors') && (
 <form onSubmit={subTab === 'customers' ? handleSaveCustomer : handleSaveVendor} className="space-y-4 text-xs">
 
 {(!canEditCustomers && subTab === 'customers') || (!canEditVendors && subTab === 'vendors') ? (
 <div className="p-4 bg-rose-50 text-rose-700 rounded-xl border border-rose-100 flex items-start gap-2 text-[11px] font-semibold leading-relaxed">
 <Lock className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
 <span>You do not have the required Staff Permissions to create or modify this directory.</span>
 </div>
 ) : (
 <>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Entity Name</label>
 <input
 type="text"
 required
 placeholder="e.g. CNC Woodworks Ltd"
 value={name}
 onChange={(e) => setName(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Email Address</label>
 <input
 type="email"
 placeholder="billing@example.com"
 value={email}
 onChange={(e) => setEmail(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Contact Phone</label>
 <input
 type="text"
 placeholder="+966 5..."
 value={phone}
 onChange={(e) => setPhone(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Physical Address</label>
 <input
 type="text"
 placeholder="Street, City, Postal Code"
 value={address}
 onChange={(e) => setAddress(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">VAT Registration Number</label>
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
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-2">ZATCA Invoice Type</label>
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
 {bt === 'B2B' ? 'B2B — Standard Invoice' : 'B2C — Simplified Invoice'}
 </button>
 ))}
 </div>
 <p className="text-[10px] text-slate-400 mt-1.5">
 {buyerType === 'B2C'
 ? 'Simplified (B2C): only the name above is required for ZATCA.'
 : 'Standard (B2B): ZATCA requires a full, verifiable buyer identity below.'}
 </p>
 </div>

 {buyerType === 'B2B' && (
 <div className="grid grid-cols-2 gap-3 bg-slate-50 p-4 rounded-xl border border-slate-200/60">
 <div className="col-span-2 md:col-span-1 space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">ZATCA VAT Number (15 digits)*</label>
 <input type="text" placeholder="3xxxxxxxxxxxxxx" value={zatcaVatNumber} onChange={(e) => setZatcaVatNumber(e.target.value)} className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs font-mono text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150" />
 </div>
 <div className="col-span-2 md:col-span-1 space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Building Number*</label>
 <input type="text" placeholder="1234" value={zatcaBuildingNumber} onChange={(e) => setZatcaBuildingNumber(e.target.value)} className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150" />
 </div>
 <div className="col-span-2 md:col-span-1 space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Street Name*</label>
 <input type="text" placeholder="King Fahd Road" value={zatcaStreetName} onChange={(e) => setZatcaStreetName(e.target.value)} className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150" />
 </div>
 <div className="col-span-2 md:col-span-1 space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">District*</label>
 <input type="text" placeholder="Olaya" value={zatcaDistrict} onChange={(e) => setZatcaDistrict(e.target.value)} className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150" />
 </div>
 <div className="col-span-2 md:col-span-1 space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">City*</label>
 <input type="text" placeholder="Riyadh" value={zatcaCity} onChange={(e) => setZatcaCity(e.target.value)} className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150" />
 </div>
 <div className="col-span-2 md:col-span-1 space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Postal Code (5 digits)*</label>
 <input type="text" placeholder="12345" value={zatcaPostalCode} onChange={(e) => setZatcaPostalCode(e.target.value)} className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs font-mono text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150" />
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
 Cancel
 </button>
 )}
 <button
 type="submit"
 className="flex-1 bg-indigo-600 hover:bg-indigo-700 hover:shadow-lg hover:shadow-indigo-600/10 text-white rounded-xl py-2.5 font-bold transition-all duration-150 text-center"
 >
 {editingId ? 'Save Changes' : 'Register Profile'}
 </button>
 </div>
 </>
 )}
 </form>
 )}

 {/* Product Form */}
 {subTab === 'products' && (
 <form onSubmit={handleSaveProduct} className="space-y-4 text-xs">
 {!canEditProducts ? (
 <div className="p-4 bg-rose-50 text-rose-700 rounded-xl border border-rose-100 flex items-start gap-2 text-[11px] font-semibold leading-relaxed">
 <Lock className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
 <span>The catalog is global and read-only for non-admin accounts. Contact an administrator to add tools or services.</span>
 </div>
 ) : (
 <>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Product / Service Name</label>
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
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Product Classification</label>
 <select
 value={prodCatalogType}
 onChange={(e) => setProdCatalogType(e.target.value as any)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none transition-all duration-150"
 >
 <option value="item">Physical Item (Stockable & Counted)</option>
 <option value="service">Service Rate (Non-Stockable / Labor)</option>
 </select>
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">System Category Link</label>
 <select
 value={prodCategoryId}
 onChange={(e) => {
 const catId = e.target.value;
 setProdCategoryId(catId);
 const selectedCat = categories.find(c => c.id === catId);
 if (selectedCat) {
 setProdCategory(selectedCat.name); // Keep legacy field in sync
 } else {
 setProdCategory('');
 }
 }}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none transition-all duration-150"
 >
 <option value="">-- No Category --</option>
 {categories.map(cat => (
 <option key={cat.id} value={cat.id}>{cat.name}</option>
 ))}
 </select>
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Default Warehouse Branch</label>
 <select
 value={prodDefaultWarehouseId}
 onChange={(e) => setProdDefaultWarehouseId(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none transition-all duration-150"
 >
 <option value="">-- No Default Warehouse --</option>
 {(db.warehouses || []).map(wh => (
 <option key={wh.id} value={wh.id}>{wh.name}</option>
 ))}
 </select>
 </div>

 {prodCatalogType === 'item' && (
 <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200/60 space-y-3 mt-2">
 <div className="text-[10px] font-extrabold text-indigo-600 uppercase tracking-wider">Stock Control & Thresholds</div>
 
 <div className="space-y-1">
 <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Bin Location / Aisles</label>
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
 <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Min Level</label>
 <input
 type="number"
 placeholder="0"
 value={prodMinLevel}
 onChange={(e) => setProdMinLevel(e.target.value)}
 className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none"
 />
 </div>
 <div className="space-y-1">
 <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Max Level</label>
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
 <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Reorder Lead-Time</label>
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
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Transaction Flow Type</label>
 <select
 value={prodType}
 onChange={(e) => setProdType(e.target.value as any)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none transition-all duration-150"
 >
 <option value="Sales">Sales Earning Flow (Invoicing / POS)</option>
 <option value="Purchase">Purchase Supply Flow (Supplier procurement)</option>
 </select>
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Unit of Measure</label>
 <select
 value={prodUnit}
 onChange={(e) => setProdUnit(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none transition-all duration-150"
 >
 <option value="No">None / Default</option>
 <option value="Lumpsum">Lumpsum</option>
 {units.map(u => (
 <option key={u.id} value={u.code}>{u.name} ({u.code})</option>
 ))}
 </select>
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Unit Cost / Price ({db.companySetup?.currency || 'SAR'})</label>
 <input
 type="number"
 required
 step="0.01"
 placeholder="e.g. 45.00"
 value={prodPrice}
 onChange={(e) => setProdPrice(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>

 {editingId && prodCatalogType === 'item' && (
 <div className="bg-indigo-50/50 p-3.5 rounded-xl border border-indigo-100 space-y-3 mt-2">
 <div className="text-[10px] font-extrabold text-indigo-700 uppercase tracking-wider flex items-center gap-1">
 <MapPin className="w-3.5 h-3.5" /> Warehouse Extension
 </div>
 <p className="text-[10px] text-slate-500 leading-relaxed">
 Link this product to multiple warehouse branches with branch-specific thresholds.
 </p>

 {activeProductWarehouses.length > 0 && (
 <div className="bg-white rounded-lg border border-indigo-100 overflow-hidden divide-y divide-indigo-50">
 {activeProductWarehouses.map((pw: any) => {
 const wh = (db.warehouses || []).find(w => w.id === pw.warehouseId);
 return (
 <div key={pw.id} className="p-2 flex items-center justify-between text-[11px]">
 <div className="space-y-0.5">
 <div className="font-bold text-slate-700">{wh ? wh.name : 'Unknown Branch'}</div>
 <div className="text-[10px] text-slate-400 flex flex-wrap gap-x-2">
 {pw.binLocation && <span>Bin: {pw.binLocation}</span>}
 {pw.minLevel && <span>Min: {pw.minLevel}</span>}
 {pw.maxLevel && <span>Max: {pw.maxLevel}</span>}
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
 <div className="font-bold text-indigo-700 text-[10px] uppercase">Link Another Warehouse Branch</div>
 
 <div className="space-y-1">
 <select
 value={addPwWarehouseId}
 onChange={(e) => setAddPwWarehouseId(e.target.value)}
 className="w-full bg-white border border-slate-200 rounded px-2 py-1 text-xs focus:outline-none"
 >
 <option value="">-- Choose Branch --</option>
 {(db.warehouses || []).filter(wh => wh.id !== prodDefaultWarehouseId && !activeProductWarehouses.some(pw => pw.warehouseId === wh.id)).map(wh => (
 <option key={wh.id} value={wh.id}>{wh.name}</option>
 ))}
 </select>
 </div>

 <div className="grid grid-cols-2 gap-2">
 <div className="space-y-0.5">
 <label className="text-[9px] font-bold text-slate-400">Bin Location</label>
 <input type="text" placeholder="e.g. Row B" value={addPwBin} onChange={(e) => setAddPwBin(e.target.value)} className="w-full bg-white border border-slate-200 rounded px-1.5 py-0.5 text-xs" />
 </div>
 <div className="space-y-0.5">
 <label className="text-[9px] font-bold text-slate-400">Lead Time</label>
 <input type="text" placeholder="e.g. 2 days" value={addPwLeadTime} onChange={(e) => setAddPwLeadTime(e.target.value)} className="w-full bg-white border border-slate-200 rounded px-1.5 py-0.5 text-xs" />
 </div>
 <div className="space-y-0.5">
 <label className="text-[9px] font-bold text-slate-400">Min Stock</label>
 <input type="number" placeholder="0" value={addPwMin} onChange={(e) => setAddPwMin(e.target.value)} className="w-full bg-white border border-slate-200 rounded px-1.5 py-0.5 text-xs" />
 </div>
 <div className="space-y-0.5">
 <label className="text-[9px] font-bold text-slate-400">Max Stock</label>
 <input type="number" placeholder="500" value={addPwMax} onChange={(e) => setAddPwMax(e.target.value)} className="w-full bg-white border border-slate-200 rounded px-1.5 py-0.5 text-xs" />
 </div>
 </div>

 <button
 type="button"
 onClick={() => handleAddWarehouseMapping(editingId)}
 className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-1 rounded text-[10px] uppercase transition"
 >
 Add Location Link
 </button>
 </div>
 </div>
 )}

 <div className="space-y-4 pt-2 border-t border-slate-100">
                  <div className="flex items-center gap-2">
                    <input type="checkbox" checked={prodIsPos} onChange={(e) => setProdIsPos(e.target.checked)} className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-4 h-4" />
                    <span className="font-bold text-slate-700 text-xs">Enable in POS Module</span>
                  </div>
                  
                    <div className="grid grid-cols-2 gap-4 bg-slate-50 p-4 rounded-xl border border-slate-200/60">
                      <div className="col-span-2 md:col-span-1 space-y-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Category</label>
                        <input list="category-options" type="text" placeholder="e.g. Beverages" value={prodCategory} onChange={(e) => setProdCategory(e.target.value)} required={prodIsPos} className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150" />
                        <datalist id="category-options">
                          {uniqueCategories.map((cat, idx) => <option key={idx} value={cat} />)}
                        </datalist>
                      </div>
                      <div className="col-span-2 md:col-span-1 space-y-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Barcode</label>
                        <input type="text" placeholder="Scan or type" value={prodBarcode} onChange={(e) => setProdBarcode(e.target.value)} className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150" />
                      </div>
                      <div className="col-span-2 md:col-span-1 space-y-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">SKU</label>
                        <input type="text" placeholder="Stock Keeping Unit" value={prodSku} onChange={(e) => setProdSku(e.target.value)} className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150" />
                      </div>
                      <div className="col-span-2 space-y-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Product Image (Base64)</label>
                        <input type="file" accept="image/*" onChange={(e) => {
                          const file = e.target.files?.[0];
                          if(!file) return;
                          const activeComp = db.companies.find(c => c.id === db.selectedCompanyId);
                          const maxSizeKB = activeComp.posSettings?.maxImageSizeKB || 500;
                          const maxDim = activeComp.posSettings?.maxImageDimensions || 800;
                          
                          if (file.size > maxSizeKB * 1024) {
                            alert(`File too large! Maximum allowed size is ${maxSizeKB}KB.`);
                            e.target.value = '';
                            return;
                          }
                          
                          const reader = new FileReader();
                          reader.onload = (event) => {
                            const img = new Image();
                            img.onload = () => {
                              if (img.width > maxDim || img.height > maxDim) {
                                alert(`Image dimensions too large! Max allowed is ${maxDim}x${maxDim}px.`);
                                return;
                              }
                              setProdImage(event.target?.result as string);
                            };
                            img.src = event.target?.result as string;
                          };
                          reader.readAsDataURL(file);
                        }} className="w-full text-xs text-slate-600 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100" />
                        {prodImage && <img src={prodImage} alt="Preview" className="w-16 h-16 object-cover rounded-lg border border-slate-200 mt-2 shadow-sm" />}
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
 Cancel
 </button>
 )}
 <button
 type="submit"
 className="flex-1 bg-indigo-600 hover:bg-indigo-700 hover:shadow-lg hover:shadow-indigo-600/10 text-white rounded-xl py-2.5 font-bold transition-all duration-150 text-center"
 >
 {editingId ? 'Save Product' : 'Add to Inventory'}
 </button>
 </div>
 </>
 )}
 </form>
 )}

 {/* Product Category Form */}
 {subTab === 'categories' && (
 <form onSubmit={handleSaveCategory} className="space-y-4 text-xs">
 {!canEditCategories ? (
 <div className="p-4 bg-rose-50 text-rose-700 rounded-xl border border-rose-100 flex items-start gap-2 text-[11px] font-semibold leading-relaxed">
 <Lock className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
 <span>You do not have permissions to manage categories.</span>
 </div>
 ) : (
 <>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Category Name</label>
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
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Parent Category (Optional)</label>
 <select
 value={catParentId}
 onChange={(e) => setCatParentId(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 focus:outline-none transition-all duration-150"
 >
 <option value="">-- No Parent (Top Level) --</option>
 {categories.filter(c => c.id !== editingId).map(c => (
 <option key={c.id} value={c.id}>{c.name}</option>
 ))}
 </select>
 </div>

 <div className="border-t border-slate-100 pt-3 mt-2 space-y-3">
 <h5 className="text-[10px] font-extrabold text-indigo-600 uppercase tracking-wider">Accounting GL Mapping</h5>
 
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Sales/Revenue GL Account</label>
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
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Inventory Asset GL Account</label>
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
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">COGS / Expense GL Account</label>
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
 Cancel
 </button>
 )}
 <button
 type="submit"
 className="flex-1 bg-indigo-600 hover:bg-indigo-700 hover:shadow-lg hover:shadow-indigo-600/10 text-white rounded-xl py-2.5 font-bold transition-all duration-150 text-center"
 >
 {editingId ? 'Save Category' : 'Create Category'}
 </button>
 </div>
 </>
 )}
 </form>
 )}

 {/* Unit of Measure Form */}
 {subTab === 'units' && (
 <form onSubmit={handleSaveUnit} className="space-y-4 text-xs">
 {!canEditUnits ? (
 <div className="p-4 bg-rose-50 text-rose-700 rounded-xl border border-rose-100 flex items-start gap-2 text-[11px] font-semibold leading-relaxed">
 <Lock className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
 <span>You do not have permissions to manage units.</span>
 </div>
 ) : (
 <>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Unit Name</label>
 <input
 type="text"
 required
 placeholder="e.g. Piece"
 value={unitName}
 onChange={(e) => setUnitName(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>

 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Unit Code / Abbreviation</label>
 <input
 type="text"
 required
 placeholder="e.g. PCS, BOX"
 value={unitCode}
 onChange={(e) => setUnitCode(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150"
 />
 </div>

 <div className="flex gap-2 pt-3">
 {editingId && (
 <button
 type="button"
 onClick={clearForm}
 className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl font-bold transition-all duration-150"
 >
 Cancel
 </button>
 )}
 <button
 type="submit"
 className="flex-1 bg-indigo-600 hover:bg-indigo-700 hover:shadow-lg hover:shadow-indigo-600/10 text-white rounded-xl py-2.5 font-bold transition-all duration-150 text-center"
 >
 {editingId ? 'Save Unit' : 'Create Unit'}
 </button>
 </div>
 </>
 )}
 </form>
 )}

 {/* Physical Warehouses Form */}
 {subTab === 'warehouses' && (
 <form onSubmit={handleSaveWarehouse} className="space-y-4 text-xs">
 {!canEditWarehouses ? (
 <div className="p-4 bg-rose-50 text-rose-700 rounded-xl border border-rose-100 flex items-start gap-2 text-[11px] font-semibold leading-relaxed">
 <Lock className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
 <span>You do not have permissions to manage warehouses.</span>
 </div>
 ) : (
 <>
 <div className="space-y-1">
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Warehouse Name</label>
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
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Warehouse Code</label>
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
 <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Address / Location</label>
 <textarea
 placeholder="e.g. Riyadh Industrial Area"
 value={whAddress}
 onChange={(e) => setWhAddress(e.target.value)}
 className="w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none transition-all duration-150 h-20 resize-none"
 />
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
 Active & Operational Location
 </label>
 </div>

 <div className="flex gap-2 pt-3">
 {editingId && (
 <button
 type="button"
 onClick={clearForm}
 className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl font-bold transition-all duration-150"
 >
 Cancel
 </button>
 )}
 <button
 type="submit"
 className="flex-1 bg-indigo-600 hover:bg-indigo-700 hover:shadow-lg hover:shadow-indigo-600/10 text-white rounded-xl py-2.5 font-bold transition-all duration-150 text-center"
 >
 {editingId ? 'Save Warehouse' : 'Create Warehouse'}
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
 {subTab === 'customers' && 'Active Customer Directory'}
 {subTab === 'vendors' && 'Material Suppliers & Vendors Registry'}
 {subTab === 'products' && 'Product Catalog & Service Rates'}
 {subTab === 'categories' && 'Inventory Category Tree & GL Mappings'}
 {subTab === 'units' && 'Units of Measure Registry'}
 {subTab === 'warehouses' && 'Physical Warehouses & Stock Locations'}
 </h4>
 <div className="flex items-center gap-2 mt-0.5">
 <span className="text-[9px] font-bold text-indigo-600 bg-indigo-50 border border-indigo-100 px-1.5 py-0.5 rounded uppercase">
 🏢 Scoped: {db.companySetup?.name}
 </span>
 </div>
 </div>
 <span className="px-2.5 py-1 bg-white border border-slate-200/60 rounded-xl text-[10px] font-bold text-slate-500">
 Total: {subTab === 'customers' ? companyCustomers.length : subTab === 'vendors' ? companyVendors.length : subTab === 'products' ? companyProducts.length : subTab === 'categories' ? categories.length : subTab === 'units' ? units.length : warehouses.length} records
 </span>
 {((subTab === 'customers' && canEditCustomers) || (subTab === 'vendors' && canEditVendors) || (subTab === 'products' && canEditProducts) || (subTab === 'categories' && canEditCategories) || (subTab === 'units' && canEditUnits) || (subTab === 'warehouses' && canEditWarehouses)) && (
 <button
 onClick={onCreateNew}
 className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-[10px] font-bold flex items-center gap-1"
 >
 <Plus className="w-3 h-3" /> New {subTab === 'customers' ? 'Customer' : subTab === 'vendors' ? 'Vendor' : subTab === 'products' ? 'Product' : subTab === 'categories' ? 'Category' : subTab === 'units' ? 'Unit' : 'Warehouse'}
 </button>
 )}
 {subTab === 'products' && canEditProducts && (
 <button
 onClick={handleRestoreProducts}
 className="px-2.5 py-1 bg-indigo-50 border border-indigo-200 text-indigo-700 hover:bg-indigo-100 rounded-xl text-[10px] font-bold"
 title="Restore deleted products that are still in invoices"
 >
 Restore Missing Products
 </button>
 )}
 </div>
 
 {subTab === 'customers' && (
 <div className="overflow-x-auto">
 <table className="w-full text-start border-collapse">
 <thead>
 <tr className="bg-slate-50/70 border-b border-slate-100 text-[10px] uppercase font-bold text-slate-500 tracking-wider">
 <th className="p-4 ps-5">Customer Profile Name</th>
 <th className="p-4">Contact Email</th>
 <th className="p-4">VAT Registration</th>
 <th className="p-4 pe-5 text-end">Actions</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100 ">
 {companyCustomers.map(c => (
 <tr key={c.id} className="hover:bg-slate-50/40 text-slate-700 transition-colors duration-150">
 <td className="p-4 ps-5">
 <span className="font-bold text-slate-900 block">{c.name}</span>
 <span className="text-[10px] text-slate-400 block mt-0.5 font-medium">
 {c.phone || 'No phone'} • {c.address || 'No physical address'}
 </span>
 </td>
 <td className="p-4 font-medium text-slate-600">{c.email || <span className="text-slate-350 italic">None</span>}</td>
 <td className="p-4">
 {c.taxRegNumber ? (
 <span className="font-mono font-bold bg-slate-50 border border-slate-100 text-slate-700 rounded px-1.5 py-0.5 text-[10px]">{c.taxRegNumber}</span>
 ) : (
 <span className="text-slate-350 italic text-[10px]">Unregistered</span>
 )}
 </td>
 <td className="p-4 pe-5 text-end space-x-1.5">
 {!c.isSystem && canEditCustomers ? (
 <div className="inline-flex gap-1.5">
 <button
 onClick={() => onEdit(c.id)}
 className="px-2 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 rounded-lg text-[10px] font-bold transition-all duration-150"
 >
 Edit
 </button>
 <button
 onClick={() => handleDeleteCustomer(c.id)}
 className="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-lg text-[10px] font-bold transition-all duration-150"
 >
 Delete
 </button>
 </div>
 ) : (
 c.isSystem ? <span className="text-[10px] text-slate-400 bg-slate-100/80 px-2 py-0.5 rounded-md italic font-semibold">System Record</span> : null
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
 <th className="p-4 ps-5">Vendor / Material Supplier</th>
 <th className="p-4">Email</th>
 <th className="p-4">VAT Registration</th>
 <th className="p-4 pe-5 text-end">Actions</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100 ">
 {companyVendors.map(v => (
 <tr key={v.id} className="hover:bg-slate-50/40 text-slate-700 transition-colors duration-150">
 <td className="p-4 ps-5">
 <span className="font-bold text-slate-900 block">{v.name}</span>
 <span className="text-[10px] text-slate-400 block mt-0.5 font-medium">
 {v.phone || 'No phone'} • {v.address || 'No physical address'}
 </span>
 </td>
 <td className="p-4 font-medium text-slate-600">{v.email || <span className="text-slate-350 italic">None</span>}</td>
 <td className="p-4">
 {v.taxRegNumber ? (
 <span className="font-mono font-bold bg-slate-50 border border-slate-100 text-slate-700 rounded px-1.5 py-0.5 text-[10px]">{v.taxRegNumber}</span>
 ) : (
 <span className="text-slate-350 italic text-[10px]">Unregistered</span>
 )}
 </td>
 <td className="p-4 pe-5 text-end space-x-1.5">
 {!v.isSystem && canEditVendors ? (
 <div className="inline-flex gap-1.5">
 <button
 onClick={() => onEdit(v.id)}
 className="px-2 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 rounded-lg text-[10px] font-bold transition-all duration-150"
 >
 Edit
 </button>
 <button
 onClick={() => handleDeleteVendor(v.id)}
 className="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-lg text-[10px] font-bold transition-all duration-150"
 >
 Delete
 </button>
 </div>
 ) : (
 v.isSystem ? <span className="text-[10px] text-slate-400 bg-slate-100/80 px-2 py-0.5 rounded-md italic font-semibold">System Record</span> : null
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
 <th className="p-4 ps-5">Catalog Service / Item</th>
 <th className="p-4">Image</th>
 <th className="p-4">POS Enabled</th>
 <th className="p-4">Type / Ledger Scope</th>
 <th className="p-4">Unit</th>
 <th className="p-4 text-end">Unit Rate Price</th>
 {canEditProducts && <th className="p-4 pe-5 text-end">Actions</th>}
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100 ">
 {companyProducts.map(p => (
 <tr key={p.id} className="hover:bg-slate-50/40 text-slate-700 transition-colors duration-150">
 <td className="p-4 ps-5 font-bold text-slate-900">{p.name}</td>
 <td className="p-4">
   {p.base64Image ? <img src={p.base64Image} alt={p.name} className="w-10 h-10 object-cover rounded" /> : <div className="w-10 h-10 bg-slate-100 rounded"></div>}
 </td>
 <td className="p-4">{p.isPosItem ? 'Yes' : 'No'}</td>
 <td className="p-4 font-semibold">
 <span className={`px-2.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider ${
 p.type === 'Sales' ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 'bg-rose-50 text-rose-700 border border-rose-100'
 }`}>
 {p.type}
 </span>
 </td>
 <td className="p-4 font-semibold text-slate-600">{p.unit || 'No'}</td>
 <td className="p-4 text-end font-extrabold text-slate-900 text-sm">{db.companySetup?.currency || 'SAR'} {Number(p.unitPrice || 0).toFixed(2)}</td>
 {canEditProducts && (
 <td className="p-4 pe-5 text-end space-x-1.5">
 <div className="inline-flex gap-1.5">
 <button
 onClick={() => onEdit(p.id)}
 className="px-2 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 rounded-lg text-[10px] font-bold transition-all duration-150"
 >
 Edit
 </button>
 <button
 onClick={() => handleDeleteProduct(p.id)}
 className="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-lg text-[10px] font-bold transition-all duration-150"
 >
 Delete
 </button>
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
 <th className="p-4 ps-5">Category Name</th>
 <th className="p-4">Parent Category</th>
 <th className="p-4">Sales GL Mapping</th>
 <th className="p-4">Asset GL Mapping</th>
 <th className="p-4">COGS GL Mapping</th>
 {canEditCategories && <th className="p-4 pe-5 text-end">Actions</th>}
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100 ">
 {categories.map(c => {
 // Real saved/schema fields are parentCategoryId/salesGlGroup/purchaseGlGroup/cogsGlGroup
 // — this used to read parentId/salesGlAccount/purchaseGlAccount/cogsGlAccount, which
 // don't exist, so every category with real GL codes and a real parent still displayed
 // "Unmapped"/"-- Top Level --" here regardless of what was actually saved.
 const parent = categories.find(parentCat => parentCat.id === (c as any).parentCategoryId);
 return (
 <tr key={c.id} className="hover:bg-slate-50/40 text-slate-700 transition-colors duration-150">
 <td className="p-4 ps-5">
 <span className="font-bold text-slate-900 block">{c.name}</span>
 </td>
 <td className="p-4 text-slate-500 font-medium">{parent ? parent.name : <span className="text-slate-400 italic">-- Top Level --</span>}</td>
 <td className="p-4"><code className="font-mono bg-slate-50 border border-slate-100 text-slate-700 rounded px-1.5 py-0.5 text-[10px]">{(c as any).salesGlGroup || 'Unmapped'}</code></td>
 <td className="p-4"><code className="font-mono bg-slate-50 border border-slate-100 text-slate-700 rounded px-1.5 py-0.5 text-[10px]">{(c as any).purchaseGlGroup || 'Unmapped'}</code></td>
 <td className="p-4"><code className="font-mono bg-slate-50 border border-slate-100 text-slate-700 rounded px-1.5 py-0.5 text-[10px]">{(c as any).cogsGlGroup || 'Unmapped'}</code></td>
 {canEditCategories && (
 <td className="p-4 pe-5 text-end">
 <div className="inline-flex gap-1.5">
 <button
 onClick={() => onEdit(c.id)}
 className="px-2 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 rounded-lg text-[10px] font-bold transition-all duration-150"
 >
 Edit
 </button>
 <button
 onClick={() => handleDeleteCategory(c.id)}
 className="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-lg text-[10px] font-bold transition-all duration-150"
 >
 Delete
 </button>
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
 <th className="p-4 ps-5">Unit Name</th>
 <th className="p-4">Unit Code / Abbreviation</th>
 {canEditUnits && <th className="p-4 pe-5 text-end">Actions</th>}
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100 ">
 {units.map(u => (
 <tr key={u.id} className="hover:bg-slate-50/40 text-slate-700 transition-colors duration-150">
 <td className="p-4 ps-5 font-bold text-slate-900">{u.name}</td>
 <td className="p-4">
 <span className="font-mono font-bold bg-slate-50 border border-slate-100 text-indigo-600 rounded px-1.5 py-0.5 text-[10px]">{u.code}</span>
 </td>
 {canEditUnits && (
 <td className="p-4 pe-5 text-end">
 <button
 onClick={() => handleDeleteUnit(u.id)}
 className="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-lg text-[10px] font-bold transition-all duration-150"
 >
 Delete
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
 <th className="p-4 ps-5">Warehouse Code</th>
 <th className="p-4">Warehouse Name</th>
 <th className="p-4">Location Address</th>
 <th className="p-4">Status</th>
 {canEditWarehouses && <th className="p-4 pe-5 text-end">Actions</th>}
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100">
 {warehouses.map(wh => (
 <tr key={wh.id} className="hover:bg-slate-50/40 text-slate-700 transition-colors duration-150">
 <td className="p-4 ps-5">
 <span className="font-mono font-bold bg-slate-50 border border-slate-100 text-indigo-600 rounded px-1.5 py-0.5 text-[10px]">{wh.code}</span>
 </td>
 <td className="p-4 font-bold text-slate-900">{wh.name}</td>
 <td className="p-4 text-slate-500 font-medium">{wh.address || <span className="text-slate-350 italic">No address specified</span>}</td>
 <td className="p-4">
 <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider ${
 wh.isActive ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 'bg-rose-50 text-rose-700 border border-rose-100'
 }`}>
 {wh.isActive ? 'Active' : 'Inactive'}
 </span>
 </td>
 {canEditWarehouses && (
 <td className="p-4 pe-5 text-end space-x-1.5">
 <div className="inline-flex gap-1.5">
 <button
 onClick={() => onEdit(wh.id)}
 className="px-2 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 rounded-lg text-[10px] font-bold transition-all duration-150"
 >
 Edit
 </button>
 <button
 onClick={() => handleDeleteWarehouse(wh.id)}
 className="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-lg text-[10px] font-bold transition-all duration-150"
 >
 Delete
 </button>
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
