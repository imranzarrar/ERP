import { db } from './index.js';
import * as schema from './schema.js';
import { desc, inArray } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
import { DEFAULT_LIST_LIMIT } from '../../server/lib/pagination.js';

export async function getFullState() {
  try {
    const companies = await db.select().from(schema.companies);
    const users = await db.select().from(schema.users);
    const roles = await db.select().from(schema.roles);
    const userRoles = await db.select().from(schema.userRoles);
    const templates = await db.select().from(schema.documentTemplates);
    const taxSlabs = await db.select().from(schema.taxSlabs);
    const products = await db.select().from(schema.productsServices);
    const customers = await db.select().from(schema.customers);
    const vendors = await db.select().from(schema.vendors);
    const banks = await db.select().from(schema.bankAccounts);
    const months = await db.select().from(schema.fiscalMonths);

    // Bounded by default (most recent N by createdAt, env-configurable via
    // DEFAULT_LIST_LIMIT) — these tables grow unboundedly with normal usage, and this
    // was previously an unfiltered full-table scan on every /api/state call. Response
    // shape stays a flat object of arrays, so dbStore.ts/components need no changes.
    const quotations = await db.select().from(schema.quotations).orderBy(desc(schema.quotations.createdAt)).limit(DEFAULT_LIST_LIMIT);
    const quotationIds = quotations.map(q => q.id);
    const quotationItems = quotationIds.length ? await db.select().from(schema.quotationItems).where(inArray(schema.quotationItems.quotationId, quotationIds)) : [];

    const invoices = await db.select().from(schema.invoices).orderBy(desc(schema.invoices.createdAt)).limit(DEFAULT_LIST_LIMIT);
    const invoiceIds = invoices.map(i => i.id);
    const invoiceItems = invoiceIds.length ? await db.select().from(schema.invoiceItems).where(inArray(schema.invoiceItems.invoiceId, invoiceIds)) : [];

    const expenses = await db.select().from(schema.expenses).orderBy(desc(schema.expenses.createdAt)).limit(DEFAULT_LIST_LIMIT);
    const expenseIds = expenses.map(e => e.id);
    const expenseItems = expenseIds.length ? await db.select().from(schema.expenseItems).where(inArray(schema.expenseItems.expenseId, expenseIds)) : [];

    const recurringTemplates = await db.select().from(schema.recurringExpenseTemplates);
    const recurringPostings = await db.select().from(schema.recurringPostings);
    const vouchers = await db.select().from(schema.vouchers).orderBy(desc(schema.vouchers.createdAt)).limit(DEFAULT_LIST_LIMIT);
    const investors = await db.select().from(schema.investors);
    const translations = await db.select().from(schema.translations);
    const posShifts = await db.select().from(schema.posShifts);
    const posHeldInvoices = await db.select().from(schema.posHeldInvoices);

    // New Inventory Tables
    const warehouses = await db.select().from(schema.warehouses);
    const purchaseRequisitions = await db.select().from(schema.purchaseRequisitions);
    const purchaseRequisitionItems = await db.select().from(schema.purchaseRequisitionItems);
    const purchaseOrders = await db.select().from(schema.purchaseOrders);
    const purchaseOrderItems = await db.select().from(schema.purchaseOrderItems);
    const goodsReceiptNotes = await db.select().from(schema.goodsReceiptNotes);
    const goodsReceiptNoteItems = await db.select().from(schema.goodsReceiptNoteItems);
    const inventoryStocks = await db.select().from(schema.inventoryStocks);
    
    // Advanced Catalog Master Tables
    const productCategories = await db.select().from(schema.productCategories);
    const unitsOfMeasure = await db.select().from(schema.unitsOfMeasure);
    const productWarehouses = await db.select().from(schema.productWarehouses);

    const quotationsWithItems = quotations.map(q => ({
      ...q,
      createdAt: q.createdAt.toISOString(),
      items: quotationItems.filter(i => i.quotationId === q.id).map(i => ({
        ...i,
        unitCost: Number(i.unitCost),
        quantity: Number(i.quantity),
        discountAmount: i.discountAmount ? Number(i.discountAmount) : undefined
      })),
      discountPercentage: q.discountPercentage ? Number(q.discountPercentage) : undefined
    }));

    const invoicesWithItems = invoices.map(i => ({
      ...i,
      createdAt: i.createdAt.toISOString(),
      paymentDate: i.paymentDate ? i.paymentDate.toISOString() : null,
      items: invoiceItems.filter(item => item.invoiceId === i.id).map(i => ({
        ...i,
        unitCost: Number(i.unitCost),
        quantity: Number(i.quantity),
        discountAmount: i.discountAmount ? Number(i.discountAmount) : undefined
      })),
      discountPercentage: i.discountPercentage ? Number(i.discountPercentage) : undefined,
      amountPaid: i.amountPaid ? Number(i.amountPaid) : undefined
    }));

    const expensesWithItems = expenses.map(e => ({
      ...e,
      createdAt: e.createdAt.toISOString(),
      paymentDate: e.paymentDate ? e.paymentDate.toISOString() : null,
      amount: Number(e.amount),
      amountPaid: e.amountPaid ? Number(e.amountPaid) : undefined,
      items: expenseItems.filter(item => item.expenseId === e.id).map(i => ({
        ...i,
        unitCost: Number(i.unitCost),
        quantity: Number(i.quantity)
      }))
    }));

    // Map PR items
    const prsWithItems = purchaseRequisitions.map(pr => ({
      ...pr,
      date: pr.date.toISOString(),
      items: purchaseRequisitionItems.filter(item => item.requisitionId === pr.id).map(item => ({
        ...item,
        quantity: Number(item.quantity)
      }))
    }));

    // Map PO items
    const posWithItems = purchaseOrders.map(po => ({
      ...po,
      date: po.date.toISOString(),
      deliveryDate: po.deliveryDate ? po.deliveryDate.toISOString() : null,
      totalAmount: Number(po.totalAmount),
      items: purchaseOrderItems.filter(item => item.purchaseOrderId === po.id).map(item => ({
        ...item,
        quantityOrdered: Number(item.quantityOrdered),
        unitPrice: Number(item.unitPrice),
        taxRate: Number(item.taxRate)
      }))
    }));

    // Map GRN items
    const grnsWithItems = goodsReceiptNotes.map(grn => ({
      ...grn,
      date: grn.date.toISOString(),
      items: goodsReceiptNoteItems.filter(item => item.grnId === grn.id).map(item => ({
        ...item,
        quantityReceived: Number(item.quantityReceived),
        unitCost: Number(item.unitCost),
        taxRate: Number(item.taxRate),
        expiryDate: item.expiryDate ? item.expiryDate.toISOString() : null
      }))
    }));

    // Map Stock values
    const stocksMapped = inventoryStocks.map(s => ({
      ...s,
      expiryDate: s.expiryDate ? s.expiryDate.toISOString() : null,
      quantity: Number(s.quantity)
    }));

    return {
      companies,
      users,
      roles,
      userRoles,
      templates,
      taxSlabs: taxSlabs.map(t => ({...t, percentage: Number(t.percentage)})),
      products: products.map(p => ({...p, unitPrice: Number(p.unitPrice)})),
      customers,
      vendors,
      banks: banks.map(b => ({...b, openingBalance: Number(b.openingBalance)})),
      months: months.map(m => ({...m, closedAt: m.closedAt ? m.closedAt.toISOString() : null})),
      quotations: quotationsWithItems,
      invoices: invoicesWithItems,
      expenses: expensesWithItems,
      recurringTemplates: recurringTemplates.map(r => ({...r, defaultAmount: Number(r.defaultAmount)})),
      recurringPostings,
      vouchers: vouchers.map(v => ({...v, amount: Number(v.amount), createdAt: v.createdAt.toISOString()})),
      investors: investors.map(i => ({
        ...i, 
        equityPercentage: Number(i.equityPercentage), 
        profitPercentage: i.profitPercentage ? Number(i.profitPercentage) : undefined, 
        capitalContributed: Number(i.capitalContributed),
        createdAt: i.createdAt.toISOString()
      })),
      translations,
      posShifts: posShifts.map(s => ({
        ...s,
        startTime: s.startTime.toISOString(),
        endTime: s.endTime ? s.endTime.toISOString() : undefined,
        startCash: Number(s.startCash),
        endCash: s.endCash ? Number(s.endCash) : undefined,
        expectedCash: s.expectedCash ? Number(s.expectedCash) : undefined,
      })),
      posHeldInvoices: posHeldInvoices.map(h => ({
        ...h,
        createdAt: h.createdAt.toISOString()
      })),
      warehouses,
      purchaseRequisitions: prsWithItems,
      purchaseOrders: posWithItems,
      goodsReceiptNotes: grnsWithItems,
      inventoryStocks: stocksMapped,
      productCategories,
      unitsOfMeasure,
      productWarehouses,
    };
  } catch (err: any) {
    console.error("[Database] PostgreSQL connection failed or is down:", err.message);
    throw err;
  }
}
