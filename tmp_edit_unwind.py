import io


def edit(path, pairs):
    s = io.open(path, encoding='utf-8').read()
    for old, new in pairs:
        assert s.count(old) == 1, (path, s.count(old), old[:90])
        s = s.replace(old, new)
    io.open(path, 'w', encoding='utf-8', newline='').write(s)


edit('server/routes/transactions.ts', [
    # credit note
    ("""      if (type === 'CreditNote' && item.productId) {
        await restockForSaleReversal(tdb, companyId, item.productId, Number(item.quantity), newNote.id, new Date(), original.warehouseId, item.unitOfMeasureId);
      }""",
     """      if (type === 'CreditNote' && item.productId) {
        await restockForSaleReversal(tdb, companyId, item.productId, Number(item.quantity), newNote.id, new Date(), original.warehouseId, item.unitOfMeasureId);
        // The returned units were not really sold: take them back out of the product's sale statistics too.
        await unwindAverageSalePrice(tdb, companyId, item.productId, item.unitOfMeasureId, Number(item.quantity), Number(item.unitCost));
      }"""),
    # cancel: refuse a credited invoice (it would put the goods back twice), unwind otherwise
    ("""    await tdb.update(schema.invoices).set({ status: 'Cancelled' }).where(eq(schema.invoices.id, id));

    // Restock — a pre-existing gap""",
     """    // A Credit Note already reversed this invoice in full (stock, ledger, refund). Cancelling it as well would put the
    // same goods back a second time and reverse its sale statistics twice.
    if (invoice.documentType !== 'CreditNote' && invoice.documentType !== 'DebitNote') {
      const [existingNote] = await tdb.select({ invoiceNumber: schema.invoices.invoiceNumber }).from(schema.invoices).where(and(
        eq(schema.invoices.companyId, invoice.companyId),
        eq(schema.invoices.originalInvoiceId, id),
        eq(schema.invoices.documentType, 'CreditNote'),
        eq(schema.invoices.status, 'Active'),
      ));
      if (existingNote) {
        const err: any = new Error(`This invoice has already been reversed by Credit Note ${existingNote.invoiceNumber}, so it cannot also be cancelled.`);
        err.status = 400;
        throw err;
      }
    }

    await tdb.update(schema.invoices).set({ status: 'Cancelled' }).where(eq(schema.invoices.id, id));

    // Restock — a pre-existing gap"""),
    ("""        await restockForSaleReversal(tdb, invoice.companyId, item.productId, Number(item.quantity), id, new Date(), invoice.warehouseId, item.unitOfMeasureId);
      }""",
     """        await restockForSaleReversal(tdb, invoice.companyId, item.productId, Number(item.quantity), id, new Date(), invoice.warehouseId, item.unitOfMeasureId);
        await unwindAverageSalePrice(tdb, invoice.companyId, item.productId, item.unitOfMeasureId, Number(item.quantity), Number(item.unitCost));
      }"""),
    ("import { invoiceListColumns } from '../../src/db/invoiceColumns.js';",
     "import { invoiceListColumns } from '../../src/db/invoiceColumns.js';\nimport { unwindAverageSalePrice } from '../lib/salesAverage.js';"),
])

edit('server/routes/pos.ts', [
    ("""      if (originalItem.productId) {
        await restockForSaleReversal(tdb, companyId, originalItem.productId, qty, noteId, new Date(), original.warehouseId, originalItem.unitOfMeasureId);
      }""",
     """      if (originalItem.productId) {
        await restockForSaleReversal(tdb, companyId, originalItem.productId, qty, noteId, new Date(), original.warehouseId, originalItem.unitOfMeasureId);
        // Only the returned part comes out of the product's sale statistics.
        await unwindAverageSalePrice(tdb, companyId, originalItem.productId, originalItem.unitOfMeasureId, qty, Number(originalItem.unitCost));
      }"""),
])
s = io.open('server/routes/pos.ts', encoding='utf-8').read()
s = s.replace("import ", "import { unwindAverageSalePrice } from '../lib/salesAverage.js';\nimport ", 1)
io.open('server/routes/pos.ts', 'w', encoding='utf-8', newline='').write(s)
print('ok')
