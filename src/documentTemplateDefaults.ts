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
// Tailwind (v4, no config/safelist in this project) statically scans source text for
// literal class-name tokens — it can't resolve a template-literal-interpolated class like
// `md:col-span-${w}`. AdminSettings.tsx's Canvas Designer and DocumentRenderer.tsx both
// used to build that class dynamically, which silently compiled only the widths that
// happened to already appear as literal text elsewhere in the codebase (1-5 and 8) —
// width 6, used by this file's own `company_details`/`customer_info` pairing below, was
// completely absent from the built CSS, so the documented "side by side" intent silently
// collapsed to stacked full-width on any real (non-mobile) screen, including print. Every
// class below is a literal token so Tailwind always generates it; both consumers look
// widths up here instead of interpolating their own.
export const COL_SPAN_MD: Record<number, string> = {
  1: 'md:col-span-1',
  2: 'md:col-span-2',
  3: 'md:col-span-3',
  4: 'md:col-span-4',
  5: 'md:col-span-5',
  6: 'md:col-span-6',
  7: 'md:col-span-7',
  8: 'md:col-span-8',
  9: 'md:col-span-9',
  10: 'md:col-span-10',
  11: 'md:col-span-11',
  12: 'md:col-span-12',
};

// `md:` is a viewport-WIDTH media query (min-width: 48rem = 768px) — fine for the
// on-screen popup (opened at width=1000), but Chrome evaluates width-based media queries
// during actual print/PDF rendering against the PAGE's printable width, not the popup
// window's width. A4 (8.27in) minus this app's own 0.4in-per-side print margin leaves
// only ~7.47in printable — at 96 CSS px/in that's ~717px, BELOW the 768px `md:` breakpoint.
// So `md:col-span-6` (used by the default company_details/customer_info side-by-side
// pairing) correctly applies on screen but silently never activates specifically during
// print/PDF generation, even after the width-6-was-never-compiled bug above was fixed —
// confirmed live: on-screen preview showed the correct 2-column pairing, the generated PDF
// still showed them stacked, spilling onto a near-empty second page. `print:` is a media
// *type* query (@media print), not a width query, so it isn't subject to this at all —
// applied alongside `md:` so both the responsive on-screen behavior and the print/PDF
// output are guaranteed correct, independent of the page-vs-window width mismatch.
export const COL_SPAN_PRINT: Record<number, string> = {
  1: 'print:col-span-1',
  2: 'print:col-span-2',
  3: 'print:col-span-3',
  4: 'print:col-span-4',
  5: 'print:col-span-5',
  6: 'print:col-span-6',
  7: 'print:col-span-7',
  8: 'print:col-span-8',
  9: 'print:col-span-9',
  10: 'print:col-span-10',
  11: 'print:col-span-11',
  12: 'print:col-span-12',
};

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

// Denser, traditional GCC tax-invoice layout — same row grid and same DocumentRenderer
// component/data path as DEFAULT_DOCUMENT_LAYOUT above (per this app's one-render-path
// rule: there is no separate "detailed" mockup, only different block props), just with
// the itemized-address/detailed-columns options that DocumentRenderer's customer_info
// and items_table blocks support turned on. Selected as a starting preset when an admin
// creates a new template (AdminSettings.tsx's Add Template form) rather than auto-applied
// to any existing template, so it never changes how a company's current invoices print.
//
// `compact: true` on the header blocks (doc_details/company_details/customer_info)
// shrinks titles, folds Arabic sub-captions inline instead of onto their own line, and
// merges fields (Invoice Number+Date, Status+Payment Status) onto shared lines — this
// is the "narrow header" version of the same blocks DEFAULT_DOCUMENT_LAYOUT uses, kept
// as an opt-in prop (not a change to the shared rendering default) so the plain default
// template's appearance is untouched. Combined with gridGapY: 'tight' (set when this
// preset seeds a new template, see AdminSettings.tsx's handleAddTemplate) so the header
// row-to-row spacing is minimal too — a real 20-line-item invoice on this preset was
// spilling onto a near-empty second page before these changes, purely from header height.
// The ONE fixed template every company's "Download PDF" button renders with —
// deliberately independent of whatever Print template a company has customized/
// activated (a real product decision: Print stays per-company customizable, Download
// PDF is always the same consistent, correct layout for every company). Built from
// DEFAULT_DOCUMENT_LAYOUT above, the same proven 12-column grid every template in this
// app is based on — not a new one-off design.
export function buildFixedDownloadTemplate(companyId: string | undefined) {
  return {
    id: 'download-pdf-fixed-template',
    name: 'Download PDF (fixed)',
    language: 'English',
    pageSize: '8.27in x 11.69in (A4)',
    isActive: true,
    printHeader: true,
    printFooter: true,
    printLogo: true,
    printQrCode: true,
    companyId,
    layoutJson: JSON.stringify(DEFAULT_DOCUMENT_LAYOUT),
  };
}

export const DETAILED_TAX_INVOICE_LAYOUT = [
  { id: 'logo', title: 'Company Logo', w: 4, visible: true, props: { align: 'left' } },
  { id: 'doc_details', title: 'Document Metadata', w: 8, visible: true, props: { isBilingual: true, compact: true, showDocNumber: true, showDate: true, showDueDate: true, showPaymentStatus: true, showOriginQ: true, showTRN: true, showCreatedBy: true } },
  { id: 'company_details', title: 'Company Details', w: 6, visible: true, props: { isBilingual: true, compact: true, showVat: true, showAddress: true, showContact: true, showBank: true } },
  { id: 'customer_info', title: 'Customer Info', w: 6, visible: true, props: { isBilingual: true, compact: true, showName: true, showContact: true, showAddress: true, showVatNumber: true, addressStyle: 'itemized', borderStyle: 'solid' } },
  { id: 'custom_header', title: 'Custom Header text', w: 12, visible: true, props: { isBilingual: true, compact: true } },
  { id: 'items_table', title: 'Items Table', w: 12, visible: true, props: { isBilingual: true, compact: true, showSNo: true, showItemCode: true, showDescription: true, showQty: true, showUnitCost: true, showDiscount: true, showTotal: true, showTaxAmount: true, showLineSubtotal: true, borderStyle: 'stripe' } },
  { id: 'notes', title: 'Notes block', w: 5, visible: true, props: { isBilingual: true, compact: true } },
  { id: 'qr_code', title: 'ZATCA QR Code', w: 3, visible: true, props: { align: 'center', size: 'medium', isBilingual: true, compact: true } },
  { id: 'totals_summary', title: 'Total Summary', w: 4, visible: true, props: { isBilingual: true, compact: true, showSubtotal: true, showDiscount: true, showNetSubtotal: true, showVat: true, showGrandTotal: true, showGrandTotalWords: true, accentColor: 'indigo' } },
  { id: 'custom_footer', title: 'Custom Footer text', w: 12, visible: true, props: { isBilingual: true } },
];
