import express from 'express';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and, sql, or, isNull } from 'drizzle-orm';
import { normalizePermissions } from '../../src/types.js';
import { isSuperAdminUser, hasPermission, assertOwnsRow } from '../lib/authz.js';
import { generateId } from '../../src/id.js';
import { validateBuyerFields } from '../lib/zatca/validators.js';

const router = express.Router();

// --- Customers ---
router.get('/customers', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.customers.view.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const companyId = req.targetCompanyId;
    const customers = await db.select().from(schema.customers).where(eq(schema.customers.companyId, companyId));
    res.json(customers);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/customers', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.customers.edit.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const data = { ...req.body };

    if (data.id) {
      const [existing] = await db.select().from(schema.customers).where(eq(schema.customers.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this customer belongs to another company' });
      }
    }

    data.companyId = req.targetCompanyId;

    // Authoritative check — the client mirrors this, but a customer/vendor record
    // reachable via ZATCA invoicing must never be saved with fields that would
    // guarantee a real ZATCA rejection later (B2B needs full identity; B2C needs a name).
    const fieldErrors = validateBuyerFields(data.buyerType, data);
    if (fieldErrors.length > 0) {
      return res.status(400).json({ error: fieldErrors.map(e => e.message).join(' '), fieldErrors });
    }

    await db.insert(schema.customers).values(data).onConflictDoUpdate({
      target: schema.customers.id,
      set: data
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/customers/:id', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.customers.edit.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;

    // Check if customer is referenced in quotations
    const quotRefs = await db.select()
      .from(schema.quotations)
      .where(and(eq(schema.quotations.customerId, id), eq(schema.quotations.companyId, req.targetCompanyId)))
      .limit(1);
    if (quotRefs.length > 0) {
      return res.status(400).json({ error: 'Cannot delete customer because they are recorded in quotations.' });
    }

    // Check if customer is referenced in invoices
    const invRefs = await db.select()
      .from(schema.invoices)
      .where(and(eq(schema.invoices.customerId, id), eq(schema.invoices.companyId, req.targetCompanyId)))
      .limit(1);
    if (invRefs.length > 0) {
      return res.status(400).json({ error: 'Cannot delete customer because they are recorded in invoices.' });
    }

    // Check if customer is referenced in POS held invoices
    const posRefs = await db.select()
      .from(schema.posHeldInvoices)
      .where(and(eq(schema.posHeldInvoices.customerId, id), eq(schema.posHeldInvoices.companyId, req.targetCompanyId)))
      .limit(1);
    if (posRefs.length > 0) {
      return res.status(400).json({ error: 'Cannot delete customer because they are recorded in POS held invoices.' });
    }

    await db.delete(schema.customers).where(and(eq(schema.customers.id, id), eq(schema.customers.companyId, req.targetCompanyId)));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Vendors ---
router.get('/vendors', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.vendors.view.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const companyId = req.targetCompanyId;
    const vendors = await db.select().from(schema.vendors).where(eq(schema.vendors.companyId, companyId));
    res.json(vendors);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/vendors', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.vendors.edit.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const data = { ...req.body };

    if (data.id) {
      const [existing] = await db.select().from(schema.vendors).where(eq(schema.vendors.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this vendor belongs to another company' });
      }
    }

    data.companyId = req.targetCompanyId;

    const fieldErrors = validateBuyerFields(data.buyerType, data);
    if (fieldErrors.length > 0) {
      return res.status(400).json({ error: fieldErrors.map(e => e.message).join(' '), fieldErrors });
    }

    await db.insert(schema.vendors).values(data).onConflictDoUpdate({
      target: schema.vendors.id,
      set: data
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/vendors/:id', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.vendors.edit.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;

    // Check if vendor is referenced in expenses
    const expRefs = await db.select()
      .from(schema.expenses)
      .where(and(eq(schema.expenses.vendorId, id), eq(schema.expenses.companyId, req.targetCompanyId)))
      .limit(1);
    if (expRefs.length > 0) {
      return res.status(400).json({ error: 'Cannot delete vendor because they are recorded in expenses.' });
    }

    // Check if vendor is referenced in recurring templates
    const recRefs = await db.select()
      .from(schema.recurringExpenseTemplates)
      .where(and(eq(schema.recurringExpenseTemplates.vendorId, id), eq(schema.recurringExpenseTemplates.companyId, req.targetCompanyId)))
      .limit(1);
    if (recRefs.length > 0) {
      return res.status(400).json({ error: 'Cannot delete vendor because they are recorded in recurring expense templates.' });
    }

    await db.delete(schema.vendors).where(and(eq(schema.vendors.id, id), eq(schema.vendors.companyId, req.targetCompanyId)));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Products ---
router.get('/products', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.products.view.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const companyId = req.targetCompanyId;
    const products = await db.select().from(schema.productsServices).where(eq(schema.productsServices.companyId, companyId));
    res.json(products);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/products', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.products.edit.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const data = { ...req.body };

    if (data.id) {
      const [existing] = await db.select().from(schema.productsServices).where(eq(schema.productsServices.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this product belongs to another company' });
      }
    }

    data.companyId = req.targetCompanyId;
    await db.insert(schema.productsServices).values(data).onConflictDoUpdate({
      target: schema.productsServices.id,
      set: data
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/products/:id', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.products.edit.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;

    // Get product to check name reference in item descriptions
    const product = await db.select()
      .from(schema.productsServices)
      .where(and(eq(schema.productsServices.id, id), eq(schema.productsServices.companyId, req.targetCompanyId)))
      .then(r => r[0]);

    if (!product) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    // Check if product is referenced in quotation items
    const quotItemRefs = await db.select()
      .from(schema.quotationItems)
      .innerJoin(schema.quotations, eq(schema.quotationItems.quotationId, schema.quotations.id))
      .where(and(
        eq(schema.quotations.companyId, req.targetCompanyId),
        sql`LOWER(TRIM(${schema.quotationItems.description})) = LOWER(TRIM(${product.name}))`
      ))
      .limit(1);
    if (quotItemRefs.length > 0) {
      return res.status(400).json({ error: `Cannot delete product "${product.name}" because it is recorded in quotations.` });
    }

    // Check if product is referenced in invoice items
    const invItemRefs = await db.select()
      .from(schema.invoiceItems)
      .innerJoin(schema.invoices, eq(schema.invoiceItems.invoiceId, schema.invoices.id))
      .where(and(
        eq(schema.invoices.companyId, req.targetCompanyId),
        sql`LOWER(TRIM(${schema.invoiceItems.description})) = LOWER(TRIM(${product.name}))`
      ))
      .limit(1);
    if (invItemRefs.length > 0) {
      return res.status(400).json({ error: `Cannot delete product "${product.name}" because it is recorded in invoices.` });
    }

    // Check if product is referenced in expense items
    const expItemRefs = await db.select()
      .from(schema.expenseItems)
      .innerJoin(schema.expenses, eq(schema.expenseItems.expenseId, schema.expenses.id))
      .where(and(
        eq(schema.expenses.companyId, req.targetCompanyId),
        sql`LOWER(TRIM(${schema.expenseItems.description})) = LOWER(TRIM(${product.name}))`
      ))
      .limit(1);
    if (expItemRefs.length > 0) {
      return res.status(400).json({ error: `Cannot delete product "${product.name}" because it is recorded in expenses.` });
    }

    await db.delete(schema.productsServices).where(and(eq(schema.productsServices.id, id), eq(schema.productsServices.companyId, req.targetCompanyId)));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Companies ---
// Creating/overwriting a company row is a platform-owner action, not a delegable
// business permission — true super-admin only (previously any company `admin` could
// pass an arbitrary company id here and overwrite another tenant's row entirely).
router.post('/companies', async (req: any, res) => {
  try {
    if (!isSuperAdminUser(req.user)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const data = req.body;
    await db.insert(schema.companies).values(data).onConflictDoUpdate({
      target: schema.companies.id,
      set: data
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Banks ---
router.get('/banks', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'banks.view')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const banks = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, req.targetCompanyId));
    res.json(banks);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/banks', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'banks.edit')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const data = { ...req.body };

    if (data.id) {
      const [existing] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this bank account belongs to another company' });
      }
    }

    data.companyId = req.targetCompanyId;
    await db.insert(schema.bankAccounts).values(data).onConflictDoUpdate({
      target: schema.bankAccounts.id,
      set: data
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Tax Slabs ---
// Legacy rows with companyId = NULL are shared defaults visible to every company;
// new tax slabs created going forward are scoped to the creating company.
router.get('/tax-slabs', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'taxSlabs.view')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const slabs = await db.select().from(schema.taxSlabs).where(or(eq(schema.taxSlabs.companyId, req.targetCompanyId), isNull(schema.taxSlabs.companyId)));
    res.json(slabs);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/tax-slabs', async (req: any, res) => {
  try {
    if (!hasPermission(req.user, 'taxSlabs.edit')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const data = { ...req.body };

    if (data.id) {
      const [existing] = await db.select().from(schema.taxSlabs).where(eq(schema.taxSlabs.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this tax slab belongs to another company' });
      }
    }

    data.companyId = req.targetCompanyId;
    await db.insert(schema.taxSlabs).values(data).onConflictDoUpdate({
      target: schema.taxSlabs.id,
      set: data
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Product Categories ---
router.get('/product-categories', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.categories.view.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const companyId = req.targetCompanyId;
    const categories = await db.select().from(schema.productCategories).where(eq(schema.productCategories.companyId, companyId));
    res.json(categories);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/product-categories', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.categories.edit.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const data = { ...req.body };

    if (data.id) {
      const [existing] = await db.select().from(schema.productCategories).where(eq(schema.productCategories.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this category belongs to another company' });
      }
    }

    data.companyId = req.targetCompanyId;
    await db.insert(schema.productCategories).values(data).onConflictDoUpdate({
      target: schema.productCategories.id,
      set: data
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/product-categories/:id', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.categories.edit.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    
    // Check if referenced in products
    const prodRefs = await db.select()
      .from(schema.productsServices)
      .where(and(eq(schema.productsServices.categoryId, id), eq(schema.productsServices.companyId, req.targetCompanyId)))
      .limit(1);
    if (prodRefs.length > 0) {
      return res.status(400).json({ error: 'Cannot delete category because it is assigned to products.' });
    }

    await db.delete(schema.productCategories).where(and(eq(schema.productCategories.id, id), eq(schema.productCategories.companyId, req.targetCompanyId)));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Units of Measure ---
router.get('/units-of-measure', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.units.view.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const companyId = req.targetCompanyId;
    const units = await db.select().from(schema.unitsOfMeasure).where(eq(schema.unitsOfMeasure.companyId, companyId));
    res.json(units);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/units-of-measure', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.units.edit.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const data = { ...req.body };

    if (data.id) {
      const [existing] = await db.select().from(schema.unitsOfMeasure).where(eq(schema.unitsOfMeasure.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this unit belongs to another company' });
      }
    }

    data.companyId = req.targetCompanyId;
    await db.insert(schema.unitsOfMeasure).values(data).onConflictDoUpdate({
      target: schema.unitsOfMeasure.id,
      set: data
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/units-of-measure/:id', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.units.edit.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;

    await db.delete(schema.unitsOfMeasure).where(and(eq(schema.unitsOfMeasure.id, id), eq(schema.unitsOfMeasure.companyId, req.targetCompanyId)));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Warehouses ---
router.get('/warehouses', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.warehouses.view.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const companyId = req.targetCompanyId;
    const warehousesList = await db.select().from(schema.warehouses).where(eq(schema.warehouses.companyId, companyId));
    res.json(warehousesList);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/warehouses', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.warehouses.edit.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const data = { ...req.body };

    if (data.id) {
      const [existing] = await db.select().from(schema.warehouses).where(eq(schema.warehouses.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this warehouse belongs to another company' });
      }
    } else {
      data.id = generateId();
    }

    data.companyId = req.targetCompanyId;
    await db.insert(schema.warehouses).values(data).onConflictDoUpdate({
      target: schema.warehouses.id,
      set: data
    });
    res.json({ success: true, id: data.id });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/warehouses/:id', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.warehouses.edit.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;

    // Check if warehouse is default on products
    const productRefs = await db.select()
      .from(schema.productsServices)
      .where(and(eq(schema.productsServices.defaultWarehouseId, id), eq(schema.productsServices.companyId, req.targetCompanyId)))
      .limit(1);
    if (productRefs.length > 0) {
      return res.status(400).json({ error: 'Cannot delete warehouse because it is set as default for some products.' });
    }

    // Check if warehouse has stock records
    const stockRefs = await db.select()
      .from(schema.inventoryStocks)
      .where(and(eq(schema.inventoryStocks.warehouseId, id), eq(schema.inventoryStocks.companyId, req.targetCompanyId)))
      .limit(1);
    if (stockRefs.length > 0) {
      return res.status(400).json({ error: 'Cannot delete warehouse because it contains inventory stock records.' });
    }

    await db.delete(schema.warehouses).where(and(eq(schema.warehouses.id, id), eq(schema.warehouses.companyId, req.targetCompanyId)));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Product Warehouses (Junction) ---
router.get('/product-warehouses', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.products.view.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const companyId = req.targetCompanyId;
    const mappings = await db.select().from(schema.productWarehouses).where(eq(schema.productWarehouses.companyId, companyId));
    res.json(mappings);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/product-warehouses', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.products.edit.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const data = { ...req.body };

    if (data.id) {
      const [existing] = await db.select().from(schema.productWarehouses).where(eq(schema.productWarehouses.id, data.id));
      if (!assertOwnsRow(existing, req)) {
        return res.status(403).json({ error: 'Forbidden: this product-warehouse mapping belongs to another company' });
      }
    } else {
      data.id = generateId();
    }

    data.companyId = req.targetCompanyId;

    await db.insert(schema.productWarehouses).values(data).onConflictDoUpdate({
      target: schema.productWarehouses.id,
      set: data
    });
    res.json({ success: true, id: data.id });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/product-warehouses/:id', async (req: any, res) => {
  try {
    const permissions = normalizePermissions(req.user.permissions, req.user.role, req.user.isSuperAdmin);
    if (!permissions.products.edit.enabled) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { id } = req.params;
    await db.delete(schema.productWarehouses).where(and(eq(schema.productWarehouses.id, id), eq(schema.productWarehouses.companyId, req.targetCompanyId)));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
