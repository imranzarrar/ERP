def edit(p, pairs):
    s = open(p, encoding='utf-8', newline='').read(); crlf = '\r\n' in s; t = s.replace('\r\n', '\n')
    for a, b, *n in pairs:
        cnt = n[0] if n else 1
        assert t.count(a) == cnt, (p, a[:70], t.count(a))
        t = t.replace(a, b)
    open(p, 'w', encoding='utf-8', newline='').write(t.replace('\n', '\r\n') if crlf else t)

edit('src/components/ExpenseModule.tsx', [
    ("        date: formDate,", "        docDate: formDate,"),
    ("body: JSON.stringify({ date: payForm.date, bankId: payForm.bankId, amount: amt })", "body: JSON.stringify({ docDate: payForm.date, bankId: payForm.bankId, amount: amt })"),
    ("String(exp.date).slice(0, 7)", "String(exp.docDate).slice(0, 7)"),
    ("{exp.date}</td>", "{exp.docDate}</td>"),
])
edit('src/components/InvoiceModule.tsx', [
    (" date: formDate,", " docDate: formDate,"),
    ("{inv.date}</td>", "{inv.docDate}</td>"),
])
edit('src/components/QuotationModule.tsx', [
    ("      date: formDate,", "      docDate: formDate,"),
    ("{q.date}</td>", "{q.docDate}</td>"),
])
edit('src/components/PosModule.tsx', [
    ("      date: getPosSaleDate(),", "      docDate: getPosSaleDate(),"),
    ("{selectedInvoice.date} ·", "{selectedInvoice.docDate} ·"),
    ("const invoiceDate = new Date(i.date);", "const invoiceDate = new Date(i.docDate);"),
])
edit('src/components/RecurringExpenses.tsx', [
    (" date: accrualForm.date,", " docDate: accrualForm.date,"),
])
edit('src/components/AdminSettings.tsx', [
    (" date: investmentForm.date,", " docDate: investmentForm.date,"),
])
edit('src/components/InventoryModule.tsx', [
    ("body: JSON.stringify({ date: payBillForm.date, bankId: payBillForm.bankId,", "body: JSON.stringify({ docDate: payBillForm.date, bankId: payBillForm.bankId,"),
])
print('ok')
