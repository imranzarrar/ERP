import { db } from './index.js';
import * as schema from './schema.js';
import { desc, inArray } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
import { DEFAULT_LIST_LIMIT } from '../../server/lib/pagination.js';

export async function getFullState() {
  try {
    const companies = await db.select().from(schema.companies);
    const roleTemplates = await db.select().from(schema.roleTemplates);
    const companyOnboardingRequests = await db.select().from(schema.companyOnboardingRequests).orderBy(desc(schema.companyOnboardingRequests.createdAt));
    const deletedCompanyLog = await db.select().from(schema.deletedCompanyLog).orderBy(desc(schema.deletedCompanyLog.deletedAt));
    // Explicit column list — password (bcrypt hash) must never reach the client. It's
    // never displayed for real (see AdminSettings.tsx's Staff Accounts directory, which
    // used to show a misleading `u.password || '123456'` fallback because this value was
    // always undefined on the client anyway) and shipping a hash to every browser tab is
    // needless exposure regardless.
    const users = await db.select({
      id: schema.users.id,
      uid: schema.users.uid,
      username: schema.users.username,
      email: schema.users.email,
      role: schema.users.role,
      companyId: schema.users.companyId,
      isSuperAdmin: schema.users.isSuperAdmin,
      isActive: schema.users.isActive,
      uiLanguage: schema.users.uiLanguage,
      isDeleted: schema.users.isDeleted,
      employeeId: schema.users.employeeId,
    }).from(schema.users);
    const roles = await db.select().from(schema.roles);
    const userRoles = await db.select().from(schema.userRoles);
    const branches = await db.select().from(schema.branches);
    const userBranches = await db.select().from(schema.userBranches);
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
    const purchaseBills = await db.select().from(schema.purchaseBills);
    const purchaseReturns = await db.select().from(schema.purchaseReturns);
    const purchaseReturnItems = await db.select().from(schema.purchaseReturnItems);
    const physicalStockTakes = await db.select().from(schema.physicalStockTakes);
    const physicalStockTakeItems = await db.select().from(schema.physicalStockTakeItems);
    // Grows with every stock-mutating transaction (GRN/Return/Sale/Adjustment/StockTake/
    // TransferOut/TransferIn) — bounded the same way invoices/vouchers are above, most-recent-first.
    const stockLedgerTransactions = await db.select().from(schema.stockLedgerTransactions).orderBy(desc(schema.stockLedgerTransactions.date)).limit(DEFAULT_LIST_LIMIT);
    const warehouseDispatches = await db.select().from(schema.warehouseDispatches);
    const warehouseDispatchItems = await db.select().from(schema.warehouseDispatchItems);
    const warehouseReceivings = await db.select().from(schema.warehouseReceivings);
    const warehouseReceivingItems = await db.select().from(schema.warehouseReceivingItems);

    // Advanced Catalog Master Tables
    const productCategories = await db.select().from(schema.productCategories);
    const unitsOfMeasure = await db.select().from(schema.unitsOfMeasure);
    const productUnitConversionsRaw = await db.select().from(schema.productUnitConversions);
    const productUnitConversions = productUnitConversionsRaw.map(c => ({
      ...c,
      conversionFactor: Number(c.conversionFactor),
      purchasePrice: c.purchasePrice !== null ? Number(c.purchasePrice) : null,
      salePrice: c.salePrice !== null ? Number(c.salePrice) : null,
    }));
    const productWarehouses = await db.select().from(schema.productWarehouses);
    const jobTitles = await db.select().from(schema.jobTitles);
    const employees = await db.select().from(schema.employees);

    const modifierGroupsRaw = await db.select().from(schema.modifierGroups);
    const modifierGroupIdsAll = modifierGroupsRaw.map(g => g.id);
    const modifierChoicesRaw = modifierGroupIdsAll.length
      ? await db.select().from(schema.modifierChoices).where(inArray(schema.modifierChoices.modifierGroupId, modifierGroupIdsAll))
      : [];
    const modifierGroups = modifierGroupsRaw.map(g => ({
      ...g,
      choices: modifierChoicesRaw
        .filter(c => c.modifierGroupId === g.id)
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
        .map(c => ({ ...c, priceDelta: Number(c.priceDelta) })),
    }));
    const productModifierGroupsRaw = await db.select().from(schema.productModifierGroups);
    const modifierGroupIdsByProduct = new Map<string, string[]>();
    for (const link of productModifierGroupsRaw.slice().sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))) {
      if (!modifierGroupIdsByProduct.has(link.productId)) modifierGroupIdsByProduct.set(link.productId, []);
      modifierGroupIdsByProduct.get(link.productId)!.push(link.modifierGroupId);
    }

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

    const billsMapped = purchaseBills.map(b => ({
      ...b,
      date: b.date.toISOString(),
      dueDate: b.dueDate ? b.dueDate.toISOString() : null,
      subTotal: Number(b.subTotal),
      taxTotal: Number(b.taxTotal),
      grandTotal: Number(b.grandTotal),
      amountPaid: Number(b.amountPaid),
    }));

    const returnsWithItems = purchaseReturns.map(r => ({
      ...r,
      date: r.date.toISOString(),
      items: purchaseReturnItems.filter(item => item.returnId === r.id).map(item => ({
        ...item,
        quantityReturned: Number(item.quantityReturned),
      })),
    }));

    const stockTakesWithItems = physicalStockTakes.map(st => ({
      ...st,
      date: st.date.toISOString(),
      items: physicalStockTakeItems.filter(item => item.stockTakeId === st.id).map(item => ({
        ...item,
        systemQuantity: Number(item.systemQuantity),
        physicalQuantity: Number(item.physicalQuantity),
        variance: Number(item.variance),
      })),
    }));

    const warehouseDispatchesWithItems = warehouseDispatches.map(d => ({
      ...d,
      date: d.date.toISOString(),
      expectedArrivalDate: d.expectedArrivalDate ? d.expectedArrivalDate.toISOString() : null,
      items: warehouseDispatchItems.filter(item => item.dispatchId === d.id).map(item => ({
        ...item,
        quantityDispatched: Number(item.quantityDispatched),
        expiryDate: item.expiryDate ? item.expiryDate.toISOString() : null,
      })),
    }));

    const warehouseReceivingsWithItems = warehouseReceivings.map(r => ({
      ...r,
      date: r.date.toISOString(),
      items: warehouseReceivingItems.filter(item => item.receivingId === r.id).map(item => ({
        ...item,
        quantityReceived: Number(item.quantityReceived),
        expiryDate: item.expiryDate ? item.expiryDate.toISOString() : null,
      })),
    }));

    const stockLedgerTransactionsMapped = stockLedgerTransactions.map(slt => ({
      ...slt,
      date: slt.date.toISOString(),
      quantityChange: Number(slt.quantityChange),
      endingQuantity: Number(slt.endingQuantity),
    }));

    return {
      companies,
      roleTemplates,
      companyOnboardingRequests: companyOnboardingRequests.map(r => ({
        ...r,
        createdAt: r.createdAt ? r.createdAt.toISOString() : null,
        reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
      })),
      deletedCompanyLog: deletedCompanyLog.map(r => ({
        ...r,
        deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
      })),
      users,
      roles,
      userRoles,
      branches,
      userBranches,
      templates,
      taxSlabs: taxSlabs.map(t => ({...t, percentage: Number(t.percentage)})),
      products: products.map(p => ({...p, unitPrice: Number(p.unitPrice), modifierGroupIds: modifierGroupIdsByProduct.get(p.id) || []})),
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
      purchaseBills: billsMapped,
      purchaseReturns: returnsWithItems,
      physicalStockTakes: stockTakesWithItems,
      stockLedgerTransactions: stockLedgerTransactionsMapped,
      warehouseDispatches: warehouseDispatchesWithItems,
      warehouseReceivings: warehouseReceivingsWithItems,
      productCategories,
      unitsOfMeasure,
      productUnitConversions,
      productWarehouses,
      jobTitles,
      employees,
      modifierGroups,
    };
  } catch (err: any) {
    console.error("[Database] PostgreSQL connection failed or is down:", err.message);
    throw err;
  }
}
