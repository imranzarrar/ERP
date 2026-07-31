// Single source of truth for the default document (invoice/quotation) print layout.
//
// Previously AdminSettings.tsx's Canvas Designer and DocumentRenderer.tsx's own
// no-layoutJson fallback each hardcoded their OWN "default ZATCA layout" array, and the
// two had drifted apart (different column widths, different row pairings — e.g. one put
// the invoice-number/date block on its own full-width row below the logo, the other put
// it beside the logo). Worse, a freshly created template (AdminSettings' handleAddTemplate)
// had no layoutJson at all until an admin explicitly opened the Canvas Designer and hit
// Save — until then it silently rendered via DocumentRenderer's OWN divergent fallback,
// not the designer's default. Both now import this one array.
//
// Layout reasoning (row-by-row, 12-column grid):
//   Row 1: logo (4) + doc details/invoice-number-date-status (8) — logo top-left, invoice
//          metadata top-right, sharing one row (the conventional invoice-header layout).
//   Row 2: seller/company details (6) + buyer/customer info (6) — "Bill From" / "Bill To"
//          side by side, a standard, compact, professional pairing.
//   Row 3: custom header text (12, optional — company can leave blank).
//   Row 4: items table (12) — needs the full page width.
//   Row 5: notes/terms (5) + QR code (3) + totals summary (4) — QR gets enough width to
//          stay comfortably scannable, totals get the most prominent right-hand position.
//   Row 6: custom footer text (12, optional).
export const DEFAULT_DOCUMENT_LAYOUT = [
  { id: 'logo', title: 'Company Logo', w: 4, visible: true, props: { align: 'left' } },
  { id: 'doc_details', title: 'Document Metadata', w: 8, visible: true, props: { isBilingual: true, showDocNumber: true, showDate: true, showDueDate: true, showPaymentStatus: true, showOriginQ: true, showTRN: true, showCreatedBy: true } },
  { id: 'company_details', title: 'Company Details', w: 6, visible: true, props: { isBilingual: true, showVat: true, showAddress: true, showContact: true, showBank: true } },
  { id: 'customer_info', title: 'Customer Info', w: 6, visible: true, props: { isBilingual: true, showName: true, showContact: true, showAddress: true, showVatNumber: true, borderStyle: 'solid' } },
  { id: 'custom_header', title: 'Custom Header text', w: 12, visible: true, props: { isBilingual: true } },
  { id: 'items_table', title: 'Items Table', w: 12, visible: true, props: { isBilingual: true, showSNo: true, showItemCode: true, showDescription: true, showQty: true, showUnitCost: true, showDiscount: true, showTotal: true, borderStyle: 'stripe' } },
  { id: 'notes', title: 'Notes block', w: 5, visible: true, props: { isBilingual: true } },
  { id: 'qr_code', title: 'ZATCA QR Code', w: 3, visible: true, props: { align: 'center', size: 'medium', isBilingual: true } },
  { id: 'totals_summary', title: 'Total Summary', w: 4, visible: true, props: { isBilingual: true, showSubtotal: true, showDiscount: true, showNetSubtotal: true, showVat: true, showGrandTotal: true, showGrandTotalWords: true, accentColor: 'indigo' } },
  { id: 'custom_footer', title: 'Custom Footer text', w: 12, visible: true, props: { isBilingual: true } },
];
