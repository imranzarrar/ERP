import React from 'react';
import {
 Quotation,
 Invoice,
 Expense,
 Voucher,
 CompanySetup,
 DocumentTemplate,
 TaxSlab,
 BankLedgerEntry
} from '../types';
import { Printer, Download, Eye, X, Globe, FileText, Check, AlertCircle } from 'lucide-react';
import { calculateInvoiceTotals, DatabaseState } from '../dbStore';
import { useTranslation } from '../hooks';
import { ensureCompatibleImage } from '../imageUtils';
import QRCode from 'qrcode';
import { DEFAULT_DOCUMENT_LAYOUT, COL_SPAN_MD, COL_SPAN_PRINT } from '../documentTemplateDefaults';
import { amountToWordsForCurrency } from '../numberToWords';

interface DocumentRendererProps {
 documentType: 'Quotation' | 'Invoice' | 'Expense' | 'Voucher' | 'PaymentReceipt' | 'Ledger' | 'Report' | 'WarehouseDispatch' | 'WarehouseReceiving';
 data: any; // Can be Quotation, Invoice, Expense, Voucher, PaymentReceipt, or Ledger/Report data
 companySetup: CompanySetup;
 templates: DocumentTemplate[];
 taxSlabs: TaxSlab[];
 db?: DatabaseState;
 onViewAnotherDoc?: (type: 'Quotation' | 'Invoice' | 'Expense' | 'Voucher', id: string) => void;
 onClose: () => void;
 // When true, renders just the paper content (no fixed-overlay modal, no toolbar/print
 // button, no Close button) so it can be embedded inline inside another page — used by
 // AdminSettings.tsx's Canvas Designer to show a genuine, always-live preview of the
 // template actually being edited, using the exact same rendering code path as the real
 // print output. Previously the Designer's canvas showed its own separate, simplified
 // mockup (e.g. a literal "[Visual Logo Asset Loaded]" placeholder instead of the real
 // logo image, with different alignment behavior than the real renderer) — which is
 // exactly why what an admin saw while editing didn't match what actually printed.
 embedded?: boolean;
 // POS Terminal's receipt printout — an Invoice rendered as a genuine 80mm continuous-
 // roll thermal receipt (worldwide standard POS paper width, printable area ~72mm) instead
 // of the 12-column Canvas Designer layout, which is fundamentally an A4-shaped design
 // tool and cannot usefully fit on 80mm. Deliberately reuses documentType: 'Invoice' —
 // NOT a separate document type — so the already-verified ZATCA QR/tax-breakdown/
 // bilingual-translation computation in renderQuotationOrInvoice is shared byte-for-byte,
 // never re-derived for the receipt. See getPageSizeClass()/handlePrint() for the
 // matching physical page geometry (80mm width, auto/continuous height — a fixed height
 // like the existing 4in x 6in business-document thermal size would be wrong here).
 forceThermalReceipt?: boolean;
 // Fires handlePrint() once automatically on mount instead of waiting for the toolbar's
 // Print button — this is what POS's "Auto Print Receipt" setting (posSettings.autoPrint)
 // actually wires to now. The print popup already self-closes ~500ms after printing (see
 // handlePrint()'s window.close() below), so this produces a real "sale completes, receipt
 // prints" flow with no extra click, matching real POS behavior — see PosModule.tsx.
 autoPrint?: boolean;
 // A window handle from window.open() called SYNCHRONOUSLY by the caller's own click
 // handler, before any async work — see handlePrint()'s comment for why this exists
 // (popup blockers kill a window.open() that fires from a delayed autoPrint effect).
 // Ignored when autoPrint is false; only meaningful paired with it.
 preOpenedPrintWindow?: Window | null;
}

// Simple English-to-Arabic dictionary for high-fidelity bilingual output
const TRANSLATIONS: Record<string, string> = {
 // Document Titles
 'Quotation': 'عرض سعر',
 'Invoice': 'فاتورة مبيعات',
 'Credit Note': 'إشعار دائن',
 'Debit Note': 'إشعار مدين',
 'Reference Invoice': 'الفاتورة المرجعية',
 'Expense': 'سند مصروف',
 'Receipt Voucher': 'سند قبض',
 'Payment Voucher': 'سند صرف',
 'Reversal Voucher': 'سند عكسي',
 'TransferOut Voucher': 'تحويل بنكي صادر',
 'TransferIn Voucher': 'تحويل بنكي وارد',
 'Bank Ledger': 'كشف حساب البنك',

 // Fields
 'Quotation Number': 'رقم عرض السعر',
 'Origin Quotation': 'عرض السعر المرجعي',
 'Invoice Number': 'رقم الفاتورة',
 'Expense Number': 'رقم المصروف',
 'Voucher Number': 'رقم السند',
 'Date': 'التاريخ',
 'Payment Date': 'تاريخ الدفع',
 'Customer': 'العميل',
 'Vendor': 'المورد',
 'Phone': 'الهاتف',
 'Email': 'البريد الإلكتروني',
 'Address': 'العنوان',
 'Status': 'الحالة',
 'Bank Account': 'الحساب البنكي',
 'Payment Status': 'حالة الدفع',

 // Table columns
 'S.No': 'الرقم',
 'Description': 'الوصف / البند',
 'Unit Cost': 'سعر الوحدة',
 'Quantity': 'الكمية',
 'Total': 'الإجمالي',
 'Amount': 'المبلغ',

 // Summary
 'Subtotal': 'المجموع الفرعي',
 'VAT': 'ضريبة القيمة المضافة',
 'Grand Total': 'المجموع الكلي',
 'Notes': 'ملاحظات',
 'Discount': 'الخصم',

 // POS thermal receipt (renderQuotationOrInvoice's forceThermalReceipt branch)
 'Payment Method': 'طريقة الدفع',
 'Amount Paid': 'المبلغ المدفوع',
 'Balance Due': 'الرصيد المستحق',
 'Change': 'الباقي',
 'Against': 'مقابل',
 'Thank you for your business!': 'شكرًا لتعاملكم معنا!',

 // Statuses
 'Draft': 'مسودة',
 'Sent': 'تم الإرسال',
 'Accepted': 'مقبول',
 'Converted': 'تم التحويل',
 'Cancelled': 'ملغي',
 'Paid': 'مدفوع',
 'Pending': 'معلق',
 'Unpaid': 'غير مدفوع',
 'Active': 'نشط'
};

// Same keys, Urdu — mirrors TRANSLATIONS above so Urdu-language templates get the same
// high-fidelity bilingual output Arabic templates already had.
const URDU_TRANSLATIONS: Record<string, string> = {
 'Quotation': 'کوٹیشن',
 'Invoice': 'انوائس',
 'Credit Note': 'کریڈٹ نوٹ',
 'Debit Note': 'ڈیبٹ نوٹ',
 'Reference Invoice': 'حوالہ انوائس',
 'Expense': 'اخراجات کی رسید',
 'Receipt Voucher': 'وصولی واؤچر',
 'Payment Voucher': 'ادائیگی واؤچر',
 'Reversal Voucher': 'واپسی واؤچر',
 'TransferOut Voucher': 'بینک ٹرانسفر (بھیجا گیا)',
 'TransferIn Voucher': 'بینک ٹرانسفر (موصول)',
 'Bank Ledger': 'بینک لیجر',

 'Quotation Number': 'کوٹیشن نمبر',
 'Origin Quotation': 'اصل کوٹیشن',
 'Invoice Number': 'انوائس نمبر',
 'Expense Number': 'اخراجات نمبر',
 'Voucher Number': 'واؤچر نمبر',
 'Date': 'تاریخ',
 'Payment Date': 'ادائیگی کی تاریخ',
 'Customer': 'گاہک',
 'Vendor': 'وینڈر',
 'Phone': 'فون',
 'Email': 'ای میل',
 'Address': 'پتہ',
 'Status': 'حیثیت',
 'Bank Account': 'بینک اکاؤنٹ',
 'Payment Status': 'ادائیگی کی حیثیت',

 'S.No': 'نمبر شمار',
 'Description': 'تفصیل',
 'Unit Cost': 'فی یونٹ قیمت',
 'Quantity': 'مقدار',
 'Total': 'کل',
 'Amount': 'رقم',

  'Subtotal': 'ذیلی مجموعہ',
 'VAT': 'ویٹ ٹیکس',
 'Grand Total': 'مجموعی کل',
 'Notes': 'نوٹس',
 'Discount': 'رعایت',

 'Payment Method': 'ادائیگی کا طریقہ',
 'Amount Paid': 'ادا شدہ رقم',
 'Balance Due': 'بقایا رقم',
 'Change': 'بقیہ رقم',
 'Against': 'کے عوض',
 'Thank you for your business!': 'آپ کے کاروبار کا شکریہ!',

 'Draft': 'مسودہ',
 'Sent': 'بھیج دیا گیا',
 'Accepted': 'منظور شدہ',
 'Converted': 'تبدیل شدہ',
 'Cancelled': 'منسوخ شدہ',
 'Paid': 'ادا شدہ',
 'Pending': 'زیر التواء',
 'Unpaid': 'غیر ادا شدہ',
 'Active': 'فعال'
};

export default function DocumentRenderer({
 documentType,
 data,
 companySetup,
 templates,
 taxSlabs,
 db,
 onViewAnotherDoc,
 onClose,
 embedded = false,
 forceThermalReceipt = false,
 autoPrint = false,
 preOpenedPrintWindow = null
}: DocumentRendererProps) {
 // Find active template or default
 const companyTemplates = React.useMemo(() => {
   const filtered = templates.filter(t => t.companyId === companySetup?.id);
   return filtered.length > 0 ? filtered : templates;
 }, [templates, companySetup?.id]);

 const activeTemplate = companyTemplates.find(t => t.isActive) || companyTemplates[0];
 const [selectedTemplateId, setSelectedTemplateId] = React.useState<string>(activeTemplate?.id || '');

 // `id="printable-document-content"` is not unique on the page — a real, confirmed bug:
 // e.g. the Invoice View screen mounts its own DocumentRenderer instance in the
 // background (rendering the company's ACTIVE template) at the same time this
 // component's own "Document Print Engine" preview modal is open (rendering whatever
 // template the user picked in the modal's dropdown, which can be a completely
 // different one). document.getElementById always returns the FIRST matching element
 // in document order — confirmed live, that's the hidden background instance, not this
 // modal's own preview — so handlePrint() was silently printing whatever the OTHER
 // instance happened to be showing, never the template actually selected here. A ref
 // scoped to this component instance can't make that mistake regardless of how many
 // other instances of this same id exist elsewhere on the page.
 const printableRef = React.useRef<HTMLDivElement>(null);
 
 const currentTemplate = companyTemplates.find(t => t.id === selectedTemplateId) || activeTemplate;
 const isBilingualDoc = documentType === 'Quotation' || documentType === 'Invoice';
 const isArabic = currentTemplate?.language === 'Arabic' && isBilingualDoc;
 const isUrdu = currentTemplate?.language === 'Urdu' && isBilingualDoc;
 const isRTL = isArabic || isUrdu;
 const dir = isRTL ? 'rtl' : 'ltr';

 // Quotation/Invoice go through the fixed local dictionaries above, driven by the
 // TEMPLATE's own configured language (a company printing a customer-facing invoice in
 // Arabic regardless of which employee created it) — deliberately independent of the
 // viewing user's own UI language. Every other document type printed from this component
 // (Expense, Voucher, PaymentReceipt, Ledger, Report) is an internal/back-office document
 // with no customer-facing template language of its own, so it falls back to the app's
 // real, DB-backed translation system keyed on the *viewing user's* uiLanguage — the same
 // one every other screen in the app uses. Without this fallback, every t() call in
 // renderExpense/renderVoucher/renderPaymentReceipt/renderLedger/renderReport was a
 // silent no-op (isBilingualDoc is false for all of them), always rendering English
 // regardless of language — a real, previously-undiscovered bug this fixes for all five
 // render paths at once, rather than needing every call site touched individually.
 const { t: tGeneral } = useTranslation(db || ({ translations: [] } as unknown as DatabaseState));
 const t = (key: string): string => {
 if (isUrdu) return URDU_TRANSLATIONS[key] || key;
 if (isArabic) return TRANSLATIONS[key] || key;
 if (!isBilingualDoc) return tGeneral(key);
 return key;
 };

 // Helper to format currency
 const currencySymbol = companySetup?.currency || 'SAR';
 const fmt = (val: number) => `${Number(val).toFixed(2)} ${currencySymbol}`;

 const getTemplateTheme = () => {
 const id = currentTemplate?.id || '';
 if (id === 'tmpl-classic-navy') {
 return {
 primaryText: 'text-[#0F1E36]',
 bgHeader: 'bg-[#0F1E36] text-white',
 borderAccent: 'border-[#0F1E36]',
 buttonOrPill: 'bg-[#0F1E36]/10 text-[#0F1E36]',
 accentText: 'text-[#1E3A8A]',
 accentFont: 'font-sans',
 tableHeaderClass: 'bg-[#0F1E36] text-white',
 customerCardClass: 'bg-slate-50 border-s-4 border-[#0F1E36] p-4 rounded-e-xl'
 };
 } else if (id === 'tmpl-sleek-charcoal') {
 return {
 primaryText: 'text-[#242424]',
 bgHeader: 'bg-[#242424] text-white',
 borderAccent: 'border-[#242424]',
 buttonOrPill: 'bg-[#242424]/10 text-[#242424]',
 accentText: 'text-[#374151]',
 accentFont: 'font-mono',
 tableHeaderClass: 'bg-[#242424] text-white',
 customerCardClass: 'bg-stone-50 border-stone-200 border p-4 rounded-xl'
 };
 } else if (id === 'tmpl-2') { // Arabic Traditional
 return {
 primaryText: 'text-[#0E3A2F]',
 bgHeader: 'bg-[#0E3A2F] text-white',
 borderAccent: 'border-[#0E3A2F]',
 buttonOrPill: 'bg-[#0E3A2F]/10 text-[#0E3A2F]',
 accentText: 'text-[#0E3A2F]',
 accentFont: 'font-sans',
 tableHeaderClass: 'bg-[#0E3A2F] text-white',
 customerCardClass: 'bg-[#F2F7F5] border-e-4 border-[#0E3A2F] p-4 rounded-s-xl'
 };
 } else {
 // Standard template
 return {
 primaryText: 'text-slate-950',
 bgHeader: 'bg-indigo-50 text-indigo-900',
 borderAccent: 'border-slate-200',
 buttonOrPill: 'bg-indigo-100 text-indigo-800',
 accentText: 'text-indigo-600',
 accentFont: 'font-sans',
 tableHeaderClass: 'bg-slate-100 text-slate-700',
 customerCardClass: 'bg-slate-50 border border-slate-100 p-4 rounded-xl'
 };
 }
 };
 
  const [zoomLevel, setZoomLevel] = React.useState(1);
  React.useEffect(() => {
    const handleResize = () => {
      const isThermal = forceThermalReceipt || currentTemplate?.pageSize?.includes('4in x 6in');
      const baseWidth = isThermal ? 400 : 800;
      if (window.innerWidth < baseWidth + 48) {
        setZoomLevel(Math.max(0.3, (window.innerWidth - 48) / baseWidth));
      } else {
        setZoomLevel(1);
      }
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [currentTemplate]);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const theme = getTemplateTheme();

 // Handle page sizing styling. No forced min-height at all, screen or print.
 // A prior fix scoped the ~11in/6in minimum to print-only (print:min-h-*), reasoning
 // a physical page should be full paper height even for a short document — but that
 // "11in"/"6in" is the RAW paper height, not the actually-printable area once the
 // page's own @page margin is subtracted (A4 here is 11.69in tall with 0.4in top+
 // bottom margins = 10.89in usable; the 4in x 6in thermal size uses 0.1in margins =
 // 5.8in usable). Forcing content to be AT LEAST the raw paper height guaranteed it
 // was always slightly taller than the printable area, spilling a sliver of empty
 // content onto a near-blank second page on every single print/PDF — confirmed live
 // against a real generated PDF. Letting the page size to its actual content (like
 // real invoicing software does) fits a short document on one page correctly, and a
 // genuinely long one (many line items) still paginates correctly via the browser's
 // own print engine — @page below still controls the physical paper size/margins.
 const getPageSizeClass = () => {
 // Real 80mm continuous-roll thermal paper (the worldwide-standard POS receipt width —
 // 58mm is the other common size, but 80mm is what this app's POS Terminal targets).
 // Deliberately independent of currentTemplate.pageSize, same reasoning as the
 // Expense/Ledger/Report branch below: a receipt's physical size is fixed by the till's
 // printer hardware, not by whatever A4/thermal-label page size the company picked for
 // its regular Invoice template.
 if (forceThermalReceipt) {
 return 'w-[80mm] text-[10px]';
 }
 if (documentType === 'Expense' || documentType === 'Ledger' || documentType === 'Report' || documentType === 'WarehouseDispatch' || documentType === 'WarehouseReceiving') {
 return 'w-full min-w-[760px] max-w-4xl'; // Standard report size
 }
 const size = currentTemplate?.pageSize || '8.27in x 11.69in';
 if (size.includes('4in x 6in')) {
 return 'w-[4in] text-xs';
 }
 return 'w-full min-w-[760px] max-w-4xl'; // A4/Letter size
 };

 // Trigger browser print of the document container
 const handlePrint = () => {
 const printContent = printableRef.current;
 if (!printContent) return;

 // preOpenedPrintWindow lets a caller open the popup SYNCHRONOUSLY inside its own
 // click handler (e.g. POS's "Confirm Payment" button) and hand the still-open window
 // reference in here once the receipt data/QR are actually ready — possibly seconds
 // later, after network awaits. Chrome (and most browsers) only allow window.open() to
 // succeed within a user gesture's "transient activation" window; calling it ourselves
 // from a delayed effect (auto-print firing after the sale's network round-trip and the
 // QR-readiness poll) reliably gets silently blocked as an unsolicited popup — confirmed
 // live: "Please allow popups" fired on every auto-printed POS receipt. Writing content
 // into an ALREADY-OPEN window has no such restriction, only the act of opening one does.
 const printWindow = (preOpenedPrintWindow && !preOpenedPrintWindow.closed)
 ? preOpenedPrintWindow
 : window.open('', '', 'height=800,width=1000');
 if (!printWindow) {
 alert('Please allow popups to print/generate PDF.');
 return;
 }

 // Clone every real <style>/<link rel="stylesheet"> tag from this document's <head>
 // into the print window, instead of the small hand-maintained subset of Tailwind
 // rules this used to carry (previously ~30 literal class rules covering a small
 // fraction of what the JSX actually uses — most colors, rounded corners, shadows,
 // grid spans, and every arbitrary-value class like bg-[#0F1E36] were silently
 // unstyled in the actual printed output even though they rendered correctly in the
 // on-screen preview). This guarantees the print output is styled with the exact
 // same compiled CSS as the live preview — dev serves Tailwind via runtime-injected
 // <style> tags, production serves it via a <link>; both are covered here. The
 // popup opened via window.open('', ...) inherits this document's location as its
 // base URL, so relative stylesheet hrefs still resolve correctly.
 const styleTags = Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))
 .map((el) => el.outerHTML)
 .join('\n');

 // printContent.outerHTML, not .innerHTML: printContent IS the "paper" wrapper div
 // itself (bg-white, shadow-lg, p-8/md:p-12, max-w-4xl, print:min-h-[11in],
 // print:p-0, etc. all live on this element's own class attribute, not on a
 // child). .innerHTML only ever serializes an element's children, never its own
 // tag/attributes — using it here silently dropped every one of those classes
 // from the actual print/PDF output, including both classes from this session's
 // print-spacing fix, even though the on-screen preview (where this element is
 // part of the live DOM, attributes and all) looked correct. Confirmed by
 // intercepting window.open and inspecting the exact HTML this call was about to
 // write: with .innerHTML the popup body started directly at the inner
 // #printable-inner child, missing the outer wrapper and all of its classes.
 printWindow.document.write(`
 <html>
 <head>
 <title>${documentType} - ${data.invoiceNumber || data.quotationNumber || data.expenseNumber || 'Document'}</title>
 ${styleTags}
 <style>
 /* Print-only concerns the cloned app stylesheet above doesn't cover: base page
 chrome, physical paper size/margins, and thermal-receipt scaling. The Arabic
 (--font-arabic / Cairo) and every other app font are self-hosted via
 @fontsource (index.css, bundled by Vite) and already came across in the
 cloned stylesheet above — same-origin, so no separate import is needed here,
 and none of this print path depends on an external host being reachable. */
 html, body {
 margin: 0;
 padding: 20px;
 color: #1e293b;
 direction: ${dir};
 background-color: white;
 }
 @media print {
 /* Browsers strip background-color/box-shadow from print output by default (an
 ink-saving "economy" mode) regardless of the element's own CSS — without this,
 every colored table header/status badge/accent totals box in this document (all
 Tailwind bg-* usage) prints as plain white even though it's fully colored in the
 on-screen preview and in the cloned stylesheet above. This is the single most
 likely cause of "the PDF doesn't look like what I saw on screen." */
 * {
 -webkit-print-color-adjust: exact !important;
 print-color-adjust: exact !important;
 color-adjust: exact !important;
 }
 body { padding: 0; margin: 0; width: 100%; }
 .no-print { display: none !important; }
 @page {
 /* 80mm width, auto height: a real thermal roll has no fixed page length — it just
 feeds and cuts after the content ends, unlike A4 or the existing 4in x 6in business-
 document size (both fixed-height). "auto" is what tells the print engine/driver to
 treat this as continuous paper instead of forcing a 6in-tall page with a wasteful
 blank tail (or, for a long receipt, an unwanted mid-receipt page break). */
 size: ${forceThermalReceipt ? '80mm auto' : currentTemplate?.pageSize?.includes('4in x 6in') ? '4in 6in' : 'A4 portrait'};
 margin: ${forceThermalReceipt ? '2mm' : currentTemplate?.pageSize?.includes('4in x 6in') ? '0.1in' : '0.4in'};
 }
 /* Scale down for small thermal receipt paper */
 ${forceThermalReceipt ? `
 body, table, td, th, p, span, div {
 font-size: 10px !important;
 }
 .company-logo {
 max-height: 32px !important;
 max-width: 70mm !important;
 }
 #printable-inner {
 padding: 2mm !important;
 }
 ` : currentTemplate?.pageSize?.includes('4in x 6in') ? `
 body, table, td, th, p, span, div {
 font-size: 10px !important;
 }
 th, td {
 padding: 4px !important;
 }
 .company-logo {
 max-height: 40px !important;
 max-width: 100px !important;
 }
 #printable-inner {
 padding: 4px !important;
 }
 ` : ''}
 }
 </style>
 </head>
 <body>
 ${printContent.outerHTML}
 <script>
 window.onload = function() {
 // window.onload fires once the popup's own resources (its cloned stylesheets,
 // including the Google Fonts @import above) have started loading, but does NOT
 // reliably wait for an @import-loaded webfont to actually finish downloading and
 // apply before firing — inconsistent across browsers. Printing before that
 // finishes silently falls back to a system font for that snapshot only, so the
 // PDF's typography doesn't match the on-screen preview (which had time to load
 // the font normally). document.fonts.ready resolves once every requested font
 // has actually loaded; race it against a short timeout so a font that fails to
 // load entirely doesn't hang the print dialog forever.
 var doPrint = function() {
 window.print();
 setTimeout(function() { window.close(); }, 500);
 };
 if (window.document.fonts && window.document.fonts.ready) {
 Promise.race([
 window.document.fonts.ready,
 new Promise(function(resolve) { setTimeout(resolve, 1500); })
 ]).then(doPrint);
 } else {
 doPrint();
 }
 };
 </script>
 </body>
 </html>
 `);
 printWindow.document.close();
 };

 // POS's "Auto Print Receipt" setting fires this once, right after mount, instead of
 // waiting for a toolbar click — see the `autoPrint` prop doc comment above.
 React.useEffect(() => {
  if (!autoPrint) return;
  let cancelled = false;
  // The ZATCA QR image loads asynchronously (the QRCode.toDataURL effect above, inside
  // renderQuotationOrInvoice) after this component mounts. Printing the instant we mount
  // would capture the DOM before that image's src is actually set, silently producing a
  // receipt with a blank QR box — printing a Saudi B2C receipt with no scannable QR is a
  // real compliance problem, not just a cosmetic one. Poll briefly for the receipt's own
  // QR <img> (tagged data-qr-ready, only rendered once localQrDataUri is set) to actually
  // exist before printing — mirrors handlePrint()'s own document.fonts.ready race just
  // below: wait for the real thing, but never hang forever if it doesn't show up (e.g. QR
  // generation itself failed, or this document has no QR block at all).
  const qrExpected = forceThermalReceipt && documentType === 'Invoice' && currentTemplate?.printQrCode !== false;
  const deadline = Date.now() + 2000;
  const tryPrint = () => {
   if (cancelled) return;
   const qrReady = !qrExpected || printableRef.current?.querySelector('[data-qr-ready="true"]');
   if (qrReady || Date.now() > deadline) {
    handlePrint();
   } else {
    setTimeout(tryPrint, 100);
   }
  };
  const initial = setTimeout(tryPrint, 150);
  return () => { cancelled = true; clearTimeout(initial); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [autoPrint]);

 const renderQuotationOrInvoice = (doc: Quotation | Invoice) => {
  const isInvoice = 'invoiceNumber' in doc;
  const docNum = isInvoice ? (doc as Invoice).invoiceNumber : (doc as Quotation).quotationNumber;
  const notes = doc.notes;
  const items = doc.items || [];
  // The branch this document was created under (if any) — same data the ZATCA XML's
  // seller address is built from (server/lib/zatca/processInvoice.ts), so the printed
  // paper and the e-invoice XML always agree on which outlet's address is shown. Falls
  // back to the company's own address (companySetup, used below) when unset — most
  // companies never adopt branches at all, and this must stay a no-op for them.
  const docBranch = (doc as any).branchId && db ? (db as any).branches?.find((b: any) => b.id === (doc as any).branchId) : undefined;
  const branchAddressLine = docBranch
   ? [docBranch.buildingNumber, docBranch.streetName, docBranch.district, docBranch.city, docBranch.postalCode].filter(Boolean).join(', ')
   : undefined;

  // Credit/Debit Notes are rows in the same invoices table (documentType +
  // originalInvoiceId + creditNoteReason, see CLAUDE.md) — the printed document must
  // say so clearly (title, an amber/blue warning accent, and a reference back to the
  // original invoice being adjusted) rather than silently printing as if it were an
  // ordinary Invoice, which would be actively misleading on a compliance document.
  const noteKind = isInvoice ? ((doc as Invoice).documentType || 'Invoice') : 'Invoice';
  const isCreditNote = noteKind === 'CreditNote';
  const isDebitNote = noteKind === 'DebitNote';
  const originalInvoiceId = isInvoice ? (doc as Invoice).originalInvoiceId : undefined;
  const originalInvoice = originalInvoiceId && db ? db.invoices.find(i => i.id === originalInvoiceId) : undefined;
  // Derived, not a stored status value (see permission-crud-model skill: cancellation/
  // reversal is a dedicated flag, not an overloaded status column) — an invoice that has
  // already been reversed by a Credit Note should read "Credited" on its own printout
  // instead of still showing the underlying 'Active' status, which reads as if nothing
  // happened to it.
  const existingCreditNote = isInvoice && db
   ? db.invoices.find(i => i.originalInvoiceId === (doc as Invoice).id && i.documentType === 'CreditNote')
   : undefined;
  const noteReason = isInvoice ? (doc as Invoice).creditNoteReason : undefined;
  // Amber for Credit Note (matches the amber "warn" tone InvoiceModule.tsx already
  // uses for the same document elsewhere in the app), blue for Debit Note (matches
  // its "info" tone there) — same semantics, now carried onto the printed page too.
  const noteAccentText = isCreditNote ? 'text-amber-600' : isDebitNote ? 'text-blue-600' : theme.primaryText;
  const noteBadgeClass = isCreditNote
   ? 'bg-amber-50 text-amber-700 border border-amber-200'
   : isDebitNote
   ? 'bg-blue-50 text-blue-700 border border-blue-200'
   : '';
  
  // Compute totals using our robust helper including discounts!
  const totals = calculateInvoiceTotals({ taxSlabs } as any, items, doc.taxSlabId, doc.discountPercentage);

  // Resolve each line's own VAT rate the exact same way calculateInvoiceTotals
  // (dbStore.ts) and the ZATCA XML builder (xmlBuilder.ts) do: an explicit per-line
  // taxRate override, else the line's own taxSlabId looked up against real tax slabs,
  // else the invoice's header rate. Shared by both the items table (per-line display)
  // and the totals summary (category breakdown) below.
  const getItemTaxRate = (item: any): number => {
   if (item.taxRate !== undefined && item.taxRate !== null && !isNaN(item.taxRate)) return item.taxRate;
   if (item.taxSlabId) {
    const slab = (taxSlabs || []).find((s: any) => s.id === item.taxSlabId);
    if (slab) return Number(slab.percentage);
   }
   return totals.percentage;
  };

  // ZATCA's own XML (xmlBuilder.ts's taxGroups) reports one TaxSubtotal PER DISTINCT
  // rate actually present on the invoice — a mixed-rate invoice (e.g. 15% + 0% Exempt
  // lines, a real, tested scenario) previously printed only a single blended "VAT (X%)"
  // figure using the HEADER's rate, which doesn't represent what ZATCA actually cleared.
  // Only used for display when there's genuinely more than one rate; a single-rate
  // invoice keeps the simpler one-line display below.
  const vatRateGroups = new Map<number, { taxableAmount: number; taxAmount: number }>();
  items.forEach((item: any) => {
   const rate = getItemTaxRate(item);
   const itemGross = (item.unitCost || 0) * item.quantity;
   const itemLineDisc = (item.discountAmount || 0) * item.quantity;
   const itemTaxable = Math.max(0, itemGross - itemLineDisc) * (1 - ((doc.discountPercentage || 0) / 100));
   const existing = vatRateGroups.get(rate);
   if (existing) {
    existing.taxableAmount += itemTaxable;
    existing.taxAmount += itemTaxable * (rate / 100);
   } else {
    vatRateGroups.set(rate, { taxableAmount: itemTaxable, taxAmount: itemTaxable * (rate / 100) });
   }
  });
  const hasMultipleVatRates = vatRateGroups.size > 1;

  // Compute verified QR Code details (Saudi ZATCA compliant textual metadata)
  const seller = companySetup.name;
  // Previously fell back to a hardcoded, fabricated VAT number ("300123456700003")
  // when the company had none configured — the exact same class of bug already found
  // and fixed for buyer VAT (item 29): never invent a real-looking tax-registration
  // number for an actual seller. Only used in the unsigned-invoice fallback QR text
  // below (a real, signed invoice always carries its own genuine qrCodeContent).
  const currentVat = companySetup.vatNumber || "Not Configured";
  const timestamp = doc.date;
  const zatcaQr = (doc as Invoice).qrCodeContent;
  const docZatcaStatus = (doc as Invoice).zatcaStatus;
  // A real ZATCA clearance/reporting confirmation is the ONLY thing that may claim
  // "verified" — every other status (including simply not having a real qrCodeContent
  // yet) must read as an honest, neutral placeholder instead of a false verification
  // claim that used to be shown regardless of the invoice's actual zatcaStatus.
  const isZatcaConfirmed = docZatcaStatus === 'CLEARED' || docZatcaStatus === 'REPORTED';
  const zatcaPlaceholderStatusLabel =
    docZatcaStatus === 'REJECTED' ? 'REJECTED BY ZATCA' :
    docZatcaStatus === 'ERROR' ? 'SUBMISSION ERROR' :
    docZatcaStatus === 'PENDING' ? 'SUBMISSION PENDING' :
    'NOT YET CLEARED BY ZATCA';
  const qrDataStr = zatcaQr || `--- SAUDI ARABIA ELECTRONIC INVOICE (ZATCA) ---\nSeller: ${seller}\nVAT ID: ${currentVat}\nDoc ID: ${docNum}\nDate: ${timestamp}\nGross: ${totals.subtotal.toFixed(2)} SAR\nDiscount: ${totals.discountAmount.toFixed(2)} SAR\nVAT (15%): ${totals.taxAmount.toFixed(2)} SAR\nGrand Total: ${totals.grandTotal.toFixed(2)} SAR\nStatus: ${zatcaPlaceholderStatusLabel}`;
  // Generated locally (not fetched from a third-party image API) so Print, the browser's
  // own print-to-PDF, and the Download PDF path (html2canvas rasterizing this component's
  // DOM) never depend on an external host being reachable — a real, repeated cause of
  // "Failed to generate PDF" when html2canvas's CORS-mode image fetch for a remote QR
  // couldn't complete (network blips, ad/tracker blockers, corporate proxies).
  const [localQrDataUri, setLocalQrDataUri] = React.useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(qrDataStr, { margin: 1, width: 300 })
      .then((url) => { if (!cancelled) setLocalQrDataUri(url); })
      .catch(() => { if (!cancelled) setLocalQrDataUri(null); });
    return () => { cancelled = true; };
  }, [qrDataStr]);

  // POS Terminal's 80mm thermal receipt — a compact, stacked layout instead of the
  // 12-column Canvas Designer grid below (that grid is an A4-shaped design tool; at 80mm
  // wide, side-by-side blocks like seller/buyer simply don't fit). Deliberately reuses
  // every value already computed above (totals, vatRateGroups, zatcaQr/localQrDataUri,
  // isZatcaConfirmed, isCreditNote/isDebitNote) instead of re-deriving any of it — this is
  // the same real ZATCA/tax data as the full-size printout, just laid out for a paper
  // roll. See DocumentRendererProps.forceThermalReceipt and PosModule.tsx.
  if (forceThermalReceipt) {
   // Deliberately minimal — a cashier-facing 80mm receipt, not a full tax-invoice
   // printout. Customer identity and payment method are dropped by design; only the
   // items, the ZATCA-relevant totals, and (for a cash sale) the amount tendered/change
   // are shown.
   const amountPaidVal = isInvoice ? ((doc as Invoice).amountPaid || 0) : 0;
   const changeDue = amountPaidVal > totals.grandTotal ? amountPaidVal - totals.grandTotal : 0;
   const receiptTitle = isCreditNote ? 'Credit Note' : isDebitNote ? 'Debit Note' : (isInvoice ? 'Invoice' : 'Quotation');
   const dividerClass = 'border-t border-dashed border-slate-400 my-1.5';

   return (
    <div className="text-[10px] leading-snug text-slate-900">
     <div className="text-center mb-1.5">
      {companySetup.logoUrl && (
       // Inline style, not just the Tailwind class — a guaranteed size cap that still
       // applies even if the print popup's cloned stylesheet fails to load for any
       // reason (see the main A4 logo block's matching comment below for why this
       // matters: a real production PDF was found with this exact class present but
       // an unconstrained, page-dominating logo, consistent with the cloned
       // stylesheet not having applied at all for that print job).
       <img src={companySetup.logoUrl} alt="" className="company-logo mx-auto mb-1 max-h-8 object-contain" style={{ maxHeight: '32px', width: 'auto', height: 'auto', objectFit: 'contain' }} />
      )}
      <p className="font-bold text-[12px]">{companySetup.name}</p>
      {(branchAddressLine || companySetup.address) && (
       <p className="text-[9px] text-slate-600 whitespace-pre-line">{branchAddressLine || companySetup.address}</p>
      )}
      {companySetup.vatNumber && <p className="text-[9px] text-slate-600">{t('VAT')}: {companySetup.vatNumber}</p>}
      {companySetup.phone && <p className="text-[9px] text-slate-600">{t('Phone')}: {companySetup.phone}</p>}
     </div>

     <div className={dividerClass} />

     <p className="text-center font-bold text-[11px] uppercase">
      {t(receiptTitle)}
      {(isCreditNote || isDebitNote) && originalInvoice && (
       <span className="block text-[9px] font-normal normal-case">{t('Against')} {originalInvoice.invoiceNumber}</span>
      )}
     </p>
     <div className="flex justify-between mt-1">
      <span>{t('Invoice Number')}:</span>
      <span className="font-semibold">{docNum}</span>
     </div>
     <div className="flex justify-between">
      <span>{t('Date')}:</span>
      <span>{timestamp}</span>
     </div>

     <div className={dividerClass} />

     <div>
      {items.map((item: any, idx: number) => {
       const lineTotal = (item.unitCost || 0) * item.quantity - (item.discountAmount || 0) * item.quantity;
       return (
        <div key={item.id || idx} className="mb-1">
         <div className="flex justify-between font-semibold">
          <span className="flex-1 pe-1">{item.description}</span>
          <span className="shrink-0">{fmt(lineTotal)}</span>
         </div>
         <div className="text-slate-500 text-[9px]">
          <span>{item.quantity} x {fmt(item.unitCost || 0)}</span>
         </div>
        </div>
       );
      })}
     </div>

     <div className={dividerClass} />

     <div className="flex justify-between">
      <span>{t('Subtotal')}:</span>
      <span>{fmt(totals.subtotal)}</span>
     </div>
     {totals.discountAmount > 0 && (
      <div className="flex justify-between">
       <span>{t('Discount')}:</span>
       <span>-{fmt(totals.discountAmount)}</span>
      </div>
     )}
     {hasMultipleVatRates ? (
      Array.from(vatRateGroups.entries()).map(([rate, group]) => (
       <div key={rate} className="flex justify-between">
        <span>{t('VAT')} ({rate}%):</span>
        <span>{fmt(group.taxAmount)}</span>
       </div>
      ))
     ) : (
      <div className="flex justify-between">
       <span>{t('VAT')} ({totals.percentage}%):</span>
       <span>{fmt(totals.taxAmount)}</span>
      </div>
     )}

     <div className={dividerClass} />

     <div className="flex justify-between font-bold text-[13px]">
      <span>{t('Grand Total')}:</span>
      <span>{fmt(totals.grandTotal)}</span>
     </div>

     {changeDue > 0 && (
      <>
       <div className={dividerClass} />
       <div className="flex justify-between">
        <span>{t('Amount Paid')}:</span>
        <span>{fmt(amountPaidVal)}</span>
       </div>
       <div className="flex justify-between font-semibold">
        <span>{t('Change')}:</span>
        <span>{fmt(changeDue)}</span>
       </div>
      </>
     )}

     {isInvoice && currentTemplate?.printQrCode !== false && (
      <>
       <div className={dividerClass} />
       <div className="flex flex-col items-center">
        {localQrDataUri ? (
         <img data-qr-ready="true" src={localQrDataUri} alt="ZATCA QR Verification" className="w-20 h-20" />
        ) : (
         <div className="w-20 h-20 bg-slate-100 rounded" />
        )}
        <span className={`text-[8px] font-bold mt-1 ${isZatcaConfirmed ? 'text-slate-400' : 'text-amber-500'}`}>
         {isZatcaConfirmed ? (docZatcaStatus === 'CLEARED' ? 'Cleared' : 'Reported') : 'Not Yet Cleared'}
        </span>
       </div>
      </>
     )}

     <div className={dividerClass} />
     <p className="text-center text-[9px] mt-1">{t('Thank you for your business!')}</p>
    </div>
   );
  }

  // Parse custom template layout configurations
  let parsedLayout: any[] = [];
  try {
   if (currentTemplate?.layoutJson) {
    parsedLayout = JSON.parse(currentTemplate.layoutJson);
   }
  } catch (e) {
   console.error("Failed to parse custom template layoutJson:", e);
  }

  if (!Array.isArray(parsedLayout) || parsedLayout.length === 0) {
   // Shared with AdminSettings.tsx's Canvas Designer (src/documentTemplateDefaults.ts) —
   // this used to be a second, independently-hardcoded "default ZATCA layout" that had
   // drifted from the designer's own default (different widths, different row pairings),
   // so a company with no template configured saw a DIFFERENT layout than what the
   // designer's own "Reset to Default" button would produce.
   parsedLayout = DEFAULT_DOCUMENT_LAYOUT;
  }

  const getGridGapClass = () => {
    const gap = currentTemplate?.gridGapY || 'normal';
    switch (gap) {
      case 'tight': return 'gap-y-2';
      case 'compact': return 'gap-y-3.5';
      case 'loose': return 'gap-y-10';
      case 'normal':
      default:
        return 'gap-y-6';
    }
  };

  const getGlobalFontClass = () => {
    // An Arabic/Urdu document always keeps the Cairo/Noto stack set on the outer
    // printable-document-content container (see below) — none of serif/mono/sans
    // here have real Arabic glyph coverage, so applying one of those classes on top
    // would override the correct inherited font-family with an OS/browser fallback
    // font for every Arabic character, exactly the inconsistency this fix exists to
    // remove. Returning '' lets the outer container's font simply inherit through.
    if (isRTL) return '';
    const font = currentTemplate?.globalFontFamily || 'sans';
    switch (font) {
      case 'serif': return 'font-serif';
      case 'mono': return 'font-mono';
      case 'display': return 'font-display';
      case 'helvetica': return 'font-helvetica';
      case 'calibri': return 'font-calibri';
      case 'sans':
      default:
        return 'font-sans';
    }
  };

  // Shared color-name -> text-class mapping, originally local to totals_summary — now
  // reused by doc_details/company_details too, so a template like Tier-1 can give its
  // title/seller-identity text its OWN brand accent (e.g. 'amber' as a warm copper
  // stand-in — no new Tailwind color needed) independent of the company's portal-wide
  // UI theme, instead of being stuck with theme.primaryText/theme.accentText everywhere.
  const resolveAccentTextClass = (colorName: string | undefined, fallbackClass: string) => {
   if (colorName === 'indigo') return 'text-indigo-600';
   if (colorName === 'emerald') return 'text-emerald-600';
   if (colorName === 'slate') return 'text-slate-700';
   if (colorName === 'amber') return 'text-amber-600';
   if (colorName === 'blue') return 'text-blue-600';
   return fallbackClass;
  };

  const getBlockStyle = (block: any) => {
    const style: React.CSSProperties = {};
    if (block.props?.mt !== undefined) {
      const mtVal = block.props.mt;
      const marginMap: Record<string, string> = {
        '0': '0px',
        '1': '4px',
        '2': '8px',
        '3': '12px',
        '4': '16px',
        '6': '24px',
        '8': '32px',
        '12': '48px',
      };
      style.marginTop = marginMap[mtVal] || '16px';
    }
    if (block.props?.mb !== undefined) {
      const mbVal = block.props.mb;
      const marginMap: Record<string, string> = {
        '0': '0px',
        '1': '4px',
        '2': '8px',
        '3': '12px',
        '4': '16px',
        '6': '24px',
        '8': '32px',
        '12': '48px',
      };
      style.marginBottom = marginMap[mbVal] || '16px';
    }
    if (block.props?.p !== undefined) {
      const pVal = block.props.p;
      const padMap: Record<string, string> = {
        '0': '0px',
        '1': '4px',
        '2': '8px',
        '3': '12px',
        '4': '16px',
        '6': '24px'
      };
      style.padding = padMap[pVal] || '0px';
    }
    return style;
  };

  const getBlockTypographyClasses = (block: any) => {
    const classes: string[] = [];
    if (block.props?.fontSize) {
      const fSize = block.props.fontSize;
      if (fSize === 'xs') classes.push('text-xs');
      else if (fSize === 'sm') classes.push('text-sm');
      else if (fSize === 'base') classes.push('text-base');
      else if (fSize === 'lg') classes.push('text-lg');
      else if (fSize === 'xl') classes.push('text-xl');
    }
    if (block.props?.fontWeight) {
      const fWeight = block.props.fontWeight;
      if (fWeight === 'normal') classes.push('font-normal');
      else if (fWeight === 'medium') classes.push('font-medium');
      else if (fWeight === 'semibold') classes.push('font-semibold');
      else if (fWeight === 'bold') classes.push('font-bold');
      else if (fWeight === 'extrabold') classes.push('font-extrabold');
    }
    // Same RTL guard as getGlobalFontClass() above, for the same reason: none of
    // sans/serif/display/mono/helvetica/calibri have real Arabic glyph coverage, so
    // applying one of these per-block on an Arabic/Urdu document overrides the correct
    // inherited Cairo font-family with an OS/browser fallback for every Arabic
    // character on that block — confirmed live on a real production invoice (garbled,
    // disconnected Arabic letters) via a template block with an explicit fontFamily
    // override. getGlobalFontClass() already skips this for the whole document; this
    // per-block override was added later without the same guard.
    if (!isRTL && block.props?.fontFamily) {
      const fFamily = block.props.fontFamily;
      if (fFamily === 'sans') classes.push('font-sans');
      else if (fFamily === 'serif') classes.push('font-serif');
      else if (fFamily === 'display') classes.push('font-display');
      else if (fFamily === 'mono') classes.push('font-mono');
      else if (fFamily === 'helvetica') classes.push('font-helvetica');
      else if (fFamily === 'calibri') classes.push('font-calibri');
    }
    return classes.join(' ');
  };

  const activeBlocks = parsedLayout.filter(b => b.visible !== false);

  // Anchoring the notes/QR/totals row to the bottom of the page (rather than letting it
  // sit directly under a short items table) needs two real siblings for `justify-between`
  // to distribute space between — a single flat grid, as this used to be, can't do that.
  // Opt-in only (a block must explicitly set anchorBottom) so every pre-existing template
  // renders byte-for-byte the same as before.
  const footerBlockIds = ['notes', 'qr_code', 'totals_summary', 'custom_footer'];
  const anchorFooterToBottom = activeBlocks.some(b => footerBlockIds.includes(b.id) && b.props?.anchorBottom === true);
  const mainBlocks = anchorFooterToBottom ? activeBlocks.filter(b => !footerBlockIds.includes(b.id)) : activeBlocks;
  const footerBlocks = anchorFooterToBottom ? activeBlocks.filter(b => footerBlockIds.includes(b.id)) : [];
  // On screen this is an approximate "looks like a full sheet" height (the on-screen
  // width isn't literally physical inches, so exact precision doesn't matter there). The
  // print:-scoped value is NOT a guess, and is NOT the raw paper height — using the raw
  // height (e.g. 11.69in for A4) is exactly what caused the original phantom-blank-
  // second-page bug documented on getPageSizeClass() above, because it's taller than
  // what's actually left to fill once @page's own margin is subtracted. This starts from
  // the real printable area (paper size minus BOTH top+bottom @page margins, matching
  // handlePrint()'s own @page rule: A4 11.69in - 2*0.4in = 10.89in; thermal 6in - 2*0.1in
  // = 5.8in) and then deliberately UNDERSHOOTS it by a safety margin (~0.3in) rather than
  // using that exact theoretical maximum — confirmed live that using the exact 10.89in
  // pushed just the last line (custom_footer's thank-you text) onto a real second page,
  // almost certainly from the print engine's own inch-to-device-pixel rounding, not from
  // this codebase's own CSS. Never round this back up to the exact printable value —
  // some margin of safety here is the entire point, not a rough draft to be tightened.
  const isThermal = currentTemplate?.pageSize?.includes('4in x 6in');
  const anchorHeightClass = anchorFooterToBottom
   ? (isThermal ? 'min-h-[3.5in] print:min-h-[5.5in]' : 'min-h-[11in] print:min-h-[10.5in]')
   : '';

  const renderBlock = (block: any) => {
      const blockColClass = `col-span-12 ${COL_SPAN_MD[block.w] || COL_SPAN_MD[12]} ${COL_SPAN_PRINT[block.w] || COL_SPAN_PRINT[12]}`;

      if (block.id === 'logo') {
       // Spacer, not `return null` — this block shares its grid row with doc_details.
       // Removing it from the DOM entirely (rather than reserving its column) shifts
       // doc_details left to fill the gap, same class of bug as the notes/qr_code/
       // totals_summary row below — see that comment for the confirmed failure case.
       if (currentTemplate?.printLogo === false) return <div key={block.id} className={blockColClass} />;
       const alignClass = block.props?.align === 'right' ? 'justify-end' : block.props?.align === 'center' ? 'justify-center' : 'justify-start';
       return (
        // items-start (not items-center) — this block shares a grid row with doc_details,
        // whose content (title/subtitle/badge/invoice number/date/ref/status/payment
        // status — especially tall on a Credit/Debit Note) is often much taller than the
        // logo itself. Vertically centering made the logo visually float mid-row instead
        // of sitting flush at the top alongside the invoice title, which read as
        // misaligned/unprofessional on an actual printed Credit Note.
        <div key={block.id} className={`${blockColClass} flex ${alignClass} items-start ${getBlockTypographyClasses(block)}`} style={getBlockStyle(block)}>
         {companySetup.logoUrl ? (
          <img
           src={ensureCompatibleImage(companySetup.logoUrl)}
           alt="Logo"
           // Cap BOTH axes and let the browser preserve the logo's own aspect ratio
           // (object-contain + w/h-auto) — a max-height-only cap (the previous rule)
           // lets a wide landscape wordmark logo stretch arbitrarily wide inside its
           // half-width header column, while a max-width-only cap would let a tall
           // square/vertical logo tower over the rest of the header. Capping both
           // means a square logo and a wide wordmark logo both settle at a sensible,
           // consistent size regardless of which shape a given company uploads.
           //
           // The inline `style` duplicates the Tailwind class values on purpose — a
           // real production PDF was found with a large (AI-generated banner-style)
           // logo rendered at its raw, unconstrained pixel size, blowing a single A4
           // page out to roughly double its normal height. The print popup's classes
           // all come from the cloned stylesheet (handlePrint()'s styleTags) — if that
           // clone fails or hasn't finished for any reason, every Tailwind class on
           // this element silently does nothing, but an inline style always applies
           // regardless. Same belt-and-braces reasoning as the Cairo Arabic font's
           // redundant inline @import in handlePrint() — keep both in sync if either
           // numeric value ever changes.
           className="company-logo mb-2 max-h-16 max-w-[180px] w-auto h-auto object-contain"
           style={{ maxHeight: '64px', maxWidth: '180px', width: 'auto', height: 'auto', objectFit: 'contain' }}
           referrerPolicy="no-referrer"
          />
         ) : (
          <div className="w-12 h-12 bg-slate-900 text-white rounded-lg flex items-center justify-center font-bold text-lg mb-2">
           CNC
          </div>
         )}
        </div>
       );
      }

      if (block.id === 'company_details') {
       // Spacer, not `return null` — shares its grid row with customer_info. See the
       // logo/notes blocks' comments for the confirmed sibling-shift failure mode.
       if (currentTemplate?.printHeader === false) return <div key={block.id} className={blockColClass} />;
       const showAddress = block.props?.showAddress !== false;
       const showVat = block.props?.showVat !== false;
       const isBilingual = block.props?.isBilingual !== false;
       // Narrow/compact templates (e.g. Detailed Tax Invoice) drop the repeated
       // "اسم البائع / {name}" line and tighten the address/line spacing — the header
       // block was the single biggest space cost on a dense invoice, pushing a 20-line
       // items table onto a second page before any real content was even rendered.
       const compact = block.props?.compact === true;
       const textAlignClass = block.props?.align === 'right' ? 'text-right' : block.props?.align === 'center' ? 'text-center' : '';
       // Undefined (every pre-existing template) preserves the exact old plain-text
       // rendering — this only activates for a template that explicitly opts in
       // (e.g. Tier-1), so a seller block can be given the same bordered-card
       // treatment customer_info already has, for genuine seller/buyer visual parity
       // rather than one side looking like a design afterthought next to the other.
       const borderStyle = block.props?.borderStyle;
       // Same accentColor override as doc_details/totals_summary — a template can give
       // the seller's name/VAT/CR its own brand color instead of always inheriting the
       // company's portal-wide UI theme colors (theme.primaryText/theme.accentText).
       const sellerNameAccent = resolveAccentTextClass(block.props?.accentColor, theme.primaryText);
       const sellerVatAccent = resolveAccentTextClass(block.props?.accentColor, theme.accentText);
       const innerContent = (
        <>
         <h1 className={`${compact ? 'text-base' : 'text-xl'} font-bold ${sellerNameAccent}`}>
          {companySetup.name}
          {docBranch && (
           <span className="ms-1.5 text-xs font-semibold text-slate-500 align-middle">— {docBranch.name}</span>
          )}
          {isBilingual && !borderStyle && (
           compact ? (
            <span className="ms-1.5 text-[9px] font-medium text-slate-400 align-middle">(البائع)</span>
           ) : (
            <span className="block text-[11px] font-medium text-slate-400 mt-0.5">اسم البائع / {companySetup.name}</span>
           )
          )}
         </h1>
         {showAddress && (
          <p className={`text-xs text-slate-500 whitespace-pre-line ${compact ? 'leading-snug mt-0.5 line-clamp-2' : 'leading-relaxed mt-1'} max-w-sm`}>{branchAddressLine || companySetup.address}</p>
         )}
         <p className="text-xs text-slate-500 mt-0.5">{t('Phone')}: {docBranch?.phone || companySetup.phone} | {t('Email')}: {companySetup.email}</p>
         {/* Compact mode folds VAT+CR onto one line (matching customer_info's own
             compact pattern exactly) instead of two separate lines — the seller card
             was taking noticeably more vertical space than the buyer card right next
             to it for no informational gain, since address/VAT/CR/phone is already
             everything either party needs. */}
         {showVat && (companySetup.vatNumber || companySetup.crNumber) && (
          compact ? (
           <p className={`text-xs font-semibold mt-0.5 ${sellerVatAccent}`}>
            {companySetup.vatNumber && <span>VAT Reg: <span className="font-mono">{companySetup.vatNumber}</span></span>}
            {companySetup.vatNumber && companySetup.crNumber && <span> | </span>}
            {companySetup.crNumber && <span>{t('CR')}: <span className="font-mono">{companySetup.crNumber}</span></span>}
           </p>
          ) : (
           <>
            {companySetup.vatNumber && (
             <p className={`text-xs font-semibold mt-0.5 ${sellerVatAccent}`}>
              VAT Reg: <span className="font-mono">{companySetup.vatNumber}</span>
              {isBilingual && (
               <span className="ms-1 font-normal text-slate-400 text-[10px]">(الرقم الضريبي)</span>
              )}
             </p>
            )}
            {companySetup.crNumber && (
             <p className={`text-xs font-semibold mt-0.5 ${sellerVatAccent}`}>
              {t('CR')}: <span className="font-mono">{companySetup.crNumber}</span>
              {isBilingual && (
               <span className="ms-1 font-normal text-slate-400 text-[10px]">(السجل التجاري)</span>
              )}
             </p>
            )}
           </>
          )
         )}
        </>
       );
       if (!borderStyle) {
        return (
         <div key={block.id} className={`${blockColClass} text-slate-800 ${textAlignClass} ${getBlockTypographyClasses(block)}`} style={getBlockStyle(block)}>
          {innerContent}
         </div>
        );
       }
       // Card variant — same shape/spacing as customer_info's card (rounded-2xl,
       // bg-white, border, shadow-sm, p-4) plus its matching "role" header row, so the
       // two blocks read as one deliberate pair rather than mismatched treatments.
       let cardClass = `${compact ? 'p-2.5' : 'p-4'} rounded-2xl bg-white text-xs `;
       cardClass += borderStyle === 'dashed' ? 'border border-dashed border-slate-350' : 'border border-slate-150 shadow-sm';
       return (
        <div key={block.id} className={`${blockColClass} ${getBlockTypographyClasses(block)}`} style={getBlockStyle(block)}>
         <div className={`${cardClass} ${textAlignClass}`}>
          <div className={`flex justify-between items-center border-b border-slate-100 ${compact ? 'pb-1 mb-1' : 'pb-1.5 mb-2'}`}>
           <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{t('Seller')}</h3>
           {isBilingual && (
            <span className="text-[10px] font-bold text-slate-400">البائع / Seller</span>
           )}
          </div>
          {innerContent}
         </div>
        </div>
       );
      }

      if (block.id === 'doc_details') {
       const isBilingual = block.props?.isBilingual !== false;
       const showPaymentStatus = block.props?.showPaymentStatus !== false;
       const showOriginQ = block.props?.showOriginQ !== false;
       // Narrow/compact templates (Detailed Tax Invoice) shrink the title, fold the
       // Arabic sub-captions inline instead of onto their own line, and merge
       // Invoice Number/Date and Status/Payment Status onto shared lines — this block
       // sits in the same row as the logo, so its height sets the floor for the whole
       // header, and it was previously the tallest single block on the page.
       const compact = block.props?.compact === true;
       // Default (no explicit align) is the RTL-aware "far side" convention: pushed to
       // the end of the reading direction, which reads as right-aligned in LTR and
       // left-aligned in RTL. An explicit align overrides that with a fixed physical
       // side regardless of document direction — that was already the stated intent
       // here, but the explicit-"right" branch still used ms-auto (a logical/direction-
       // aware property) instead of a physical one, so the intent and implementation
       // disagreed: under an RTL (Arabic/Urdu) template, ms-auto flips to push the box
       // toward the LEFT while its own text-right stayed physically right — confirmed
       // live, an explicit align:"right" on an Arabic template produced a metadata box
       // flush against the column's LEFT edge with right-aligned text inside it. The
       // default and "center" branches were already correct (default's text-align is
       // itself direction-aware to match ms-auto; mx-auto is symmetric either way).
       // md:* alone isn't enough here: `md:` is a viewport-WIDTH query (768px), but Chrome
       // evaluates width-based media queries during actual print/PDF rendering against the
       // page's printable width, not the on-screen popup window's width — A4 minus this
       // app's 0.4in print margins leaves ~717px, below 768px, so md:ms-auto/mx-auto/ml-auto
       // silently never applied specifically during print/PDF generation even though the
       // on-screen preview (a wide popup window) looked correctly aligned. print:* is a
       // media *type* query, immune to this, so it's paired with every md:* alignment class
       // below (same fix as the col-span-width bug in documentTemplateDefaults.ts).
       const docDetailsPosClass = !block.props?.align
        ? `text-${dir === 'rtl' ? 'left' : 'right'} md:ms-auto print:ms-auto`
        : block.props.align === 'left' ? 'text-left'
        : block.props.align === 'center' ? 'text-center md:mx-auto print:mx-auto'
        : 'text-right md:ml-auto print:ml-auto';
       // An explicit accentColor lets a template (e.g. Tier-1) give the title its own
       // brand color regardless of the company's portal-wide UI theme — falls back to
       // the existing theme-driven noteAccentText for every template that doesn't set it.
       const titleAccentText = resolveAccentTextClass(block.props?.accentColor, noteAccentText);
       return (
        <div key={block.id} className={`${blockColClass} ${docDetailsPosClass} max-w-xs ${getBlockTypographyClasses(block)}`} style={getBlockStyle(block)}>
         <h2 className={`${compact ? 'text-base' : 'text-2xl'} font-bold uppercase tracking-wider ${titleAccentText} mb-1`}>
          {isCreditNote ? t('Credit Note') : isDebitNote ? t('Debit Note') : isInvoice ? t('Invoice') : t('Quotation')}
          {isBilingual && (
           compact ? (
            <span className="ms-1.5 text-[10px] font-semibold text-slate-400 normal-case align-middle">
             / {isCreditNote ? 'إشعار دائن' : isDebitNote ? 'إشعار مدين' : isInvoice ? 'فاتورة مبيعات' : 'عرض سعر'}
            </span>
           ) : (
            <span className="block text-sm font-semibold text-slate-400 mt-0.5">
             {isCreditNote ? 'إشعار دائن' : isDebitNote ? 'إشعار مدين' : isInvoice ? 'فاتورة مبيعات' : 'عرض سعر'}
            </span>
           )
          )}
          {(isCreditNote || isDebitNote) && (
           <span className={`inline-block mt-1.5 px-2 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider normal-case ${noteBadgeClass}`}>
            {isCreditNote ? 'Adjustment — reduces original invoice' : 'Adjustment — increases original invoice'}
           </span>
          )}
         </h2>
         <div className={`text-xs text-slate-500 ${compact ? 'space-y-0.5' : 'space-y-1'}`}>
          <p>
           <span className="font-semibold text-slate-700">
            {isInvoice ? t('Invoice Number') : t('Quotation Number')}:
           </span>{' '}
           {docNum}
           {isBilingual && (
            compact ? (
             <span className="ms-1 text-[9px] text-slate-400">({isInvoice ? 'رقم الفاتورة' : 'رقم عرض السعر'})</span>
            ) : (
             <span className="block text-[9px] text-slate-400">
              {isInvoice ? 'رقم الفاتورة' : 'رقم عرض السعر'}
             </span>
            )
           )}
           {compact && (
            <span className="ms-2">
             <span className="font-semibold text-slate-700">{t('Date')}:</span> {doc.date}
            </span>
           )}
          </p>
          {!compact && (
           <p>
            <span className="font-semibold text-slate-700">{t('Date')}:</span> {doc.date}
            {isBilingual && <span className="block text-[9px] text-slate-400">التاريخ</span>}
           </p>
          )}
          {(isCreditNote || isDebitNote) && (
           <p className={`font-semibold ${noteAccentText}`}>
            <span>Ref: {originalInvoice ? originalInvoice.invoiceNumber : (originalInvoiceId || '—')}</span>
            {isBilingual && (
             compact ? (
              <span className="ms-1 text-[9px] text-slate-400 font-normal">({t('Reference Invoice')})</span>
             ) : (
              <span className="block text-[9px] text-slate-400 font-normal">{t('Reference Invoice')}</span>
             )
            )}
            {noteReason && (
             <span className="block text-[10px] text-slate-500 font-normal normal-case mt-0.5">{noteReason}</span>
            )}
           </p>
          )}
          {isInvoice && showOriginQ && (doc as Invoice).originQuotationId && db && (() => {
           const qId = (doc as Invoice).originQuotationId;
           const originQ = db.quotations.find(q => q.id === qId);
           if (originQ) {
            return (
             <p>
              <span className="font-semibold text-slate-700">{t('Origin Quotation')}:</span>{' '}
              {onViewAnotherDoc ? (
               <button
                type="button"
                onClick={() => onViewAnotherDoc('Quotation', qId!)}
                className="text-indigo-600 hover:text-indigo-800 hover:underline font-bold font-mono no-print inline-block"
               >
                {originQ.quotationNumber}
               </button>
              ) : null}
              <span className="font-mono font-bold text-slate-800 hidden print:inline">{originQ.quotationNumber}</span>
             </p>
            );
           }
           return null;
          })()}
          {isInvoice && (doc as Invoice).documentType !== 'CreditNote' && (doc as Invoice).paymentStatus === 'Paid' && (
           // paymentDate is a `timestamp` column (schema.ts) — unlike `date` (a plain text
           // column, already just "YYYY-MM-DD"), it round-trips through the API as a full
           // ISO datetime string (e.g. "2026-08-03T00:00:00.000Z"). Truncate to the date
           // portion so it matches every other date field's format on this document instead
           // of leaking a raw timestamp onto a printed invoice.
           <p><span className="font-semibold text-emerald-600 font-bold">{t('Payment Date')}:</span> {(doc as Invoice).paymentDate ? String((doc as Invoice).paymentDate).split('T')[0] : ''}</p>
          )}
          <p className={compact ? 'flex flex-wrap items-center gap-x-3' : ''}>
           <span>
            <span className="font-semibold text-slate-700">{t('Status')}:</span>{' '}
            <span className={`px-1.5 py-0.5 rounded font-semibold ${
             existingCreditNote ? 'bg-amber-100 text-amber-800' :
             doc.status === 'Cancelled' ? 'bg-rose-100 text-rose-800' :
             doc.status === 'Converted' ? 'bg-cyan-100 text-cyan-800' :
             doc.status === 'Accepted' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-800'
            }`}>
             {existingCreditNote ? t('Credited') : t(doc.status)}
            </span>
           </span>
           {compact && isInvoice && showPaymentStatus && (doc as Invoice).documentType !== 'CreditNote' && (
            <span>
             <span className="font-semibold text-slate-700">{t('Payment Status')}:</span>{' '}
             <span className={`px-1.5 py-0.5 rounded font-semibold ${
              (doc as Invoice).paymentStatus === 'Paid' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
             }`}>
              {t((doc as Invoice).paymentStatus)}
             </span>
            </span>
           )}
          </p>
          {!compact && isInvoice && showPaymentStatus && (doc as Invoice).documentType !== 'CreditNote' && (
           <p>
            <span className="font-semibold text-slate-700">{t('Payment Status')}:</span>{' '}
            <span className={`px-1.5 py-0.5 rounded font-semibold ${
             (doc as Invoice).paymentStatus === 'Paid' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
            }`}>
             {t((doc as Invoice).paymentStatus)}
            </span>
           </p>
          )}
         </div>
        </div>
       );
      }

      if (block.id === 'customer_info') {
       const isBilingual = block.props?.isBilingual !== false;
       const showAddress = block.props?.showAddress !== false;
       const showContact = block.props?.showContact !== false;
       const borderStyle = block.props?.borderStyle || 'solid';
       // Narrow/compact templates (Detailed Tax Invoice) use a smaller card and tighter
       // internal spacing — this card sits beside company_details in the same row, so
       // its height (previously inflated further by the itemized address below) set
       // the floor for that whole row.
       const compact = block.props?.compact === true;
       // A bordered card (like totals_summary), not a paragraph — align positions the
       // card itself within its column (default: full width, unaffected; center/right
       // narrow it to make room to visibly shift, then position it there) rather than
       // text-align, which would just look odd against the card's own flex header row.
       // Width is relative (w-4/5 of the COLUMN), not a fixed max-w-sm — a fixed pixel
       // width does nothing when the block's own grid column (user-configurable, e.g.
       // w:5 of 12 ≈ 300px) is already narrower than that fixed value, which is
       // exactly what happened here: confirmed live, align:"right" was saved
       // correctly but produced zero visible change because max-w-sm (384px)
       // never actually constrained a column already narrower than that.
       // ms-auto (margin-inline-start, a logical/writing-mode-aware property) is correct
       // for the doc_details block's DEFAULT (no explicit align) case, which is
       // deliberately RTL-aware — but here "right" is an EXPLICIT, PHYSICAL override
       // (paired with a physical text-right on the card's own content), so the box
       // position must also be physical. ms-auto flips meaning under RTL (inline-start
       // is the RIGHT side in RTL), which pushed the card to the LEFT of its column
       // while its text still read right-aligned — confirmed live on the Arabic
       // template: align:"right" produced a card flush against the column's LEFT edge.
       // ml-auto (margin-left, physical) always pushes right regardless of direction.
       const cardPosClass = block.props?.align === 'right' ? 'w-4/5 ml-auto' : block.props?.align === 'center' ? 'w-4/5 mx-auto' : '';

       let cardClass = `${compact ? 'p-2.5' : 'p-4'} rounded-2xl bg-white text-xs `;
       if (borderStyle === 'solid') cardClass += "border border-slate-150 shadow-sm";
       else if (borderStyle === 'dashed') cardClass += "border border-dashed border-slate-350";
       else cardClass += "p-0";
       cardClass += ` ${cardPosClass}`;

       return (
        <div key={block.id} className={`${blockColClass} ${getBlockTypographyClasses(block)}`} style={getBlockStyle(block)}>
         <div className={cardClass}>
          <div className={`flex justify-between items-center border-b border-slate-100 ${compact ? 'pb-1 mb-1' : 'pb-1.5 mb-2'}`}>
           <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{t('Customer')}</h3>
           {isBilingual && (
            <span className="text-[10px] font-bold text-slate-400">العميل / Buyer</span>
           )}
          </div>
          {data.customerData ? (
           <div className={`text-xs text-slate-700 ${compact ? 'space-y-0.5' : 'space-y-1'}`}>
            <p className={`font-semibold text-slate-900 ${compact ? 'text-xs' : 'text-sm'}`}>{data.customerData.name}</p>
            {showContact && (data.customerData.phone !== '-' || data.customerData.email !== '-') && (
             compact ? (
              <p>
               {data.customerData.phone !== '-' && <span>{data.customerData.phone}</span>}
               {data.customerData.phone !== '-' && data.customerData.email !== '-' && <span> | </span>}
               {data.customerData.email !== '-' && <span>{data.customerData.email}</span>}
              </p>
             ) : (
              <>
               {data.customerData.phone !== '-' && <p>{t('Phone')}: {data.customerData.phone}</p>}
               {data.customerData.email !== '-' && <p>{t('Email')}: {data.customerData.email}</p>}
              </>
             )
            )}
            {/* Itemized mode (the Detailed Tax Invoice template) shows the individual
                ZATCA address fields (customers.buildingNumber/streetName/district/city/
                postalCode/countryCode — already stored, just never rendered separately
                before) instead of one free-text line, matching the traditional GCC
                tax-invoice layout — but folded onto one flowing, comma-joined line
                (like a normal mailing address) rather than one label+value line per
                field, which used to run up to 6 lines tall and was the single biggest
                contributor to the header spilling the items table onto page 2. Falls
                back to the single-line address whenever none of those granular fields
                are actually filled in (e.g. older customer records created before this
                data was collected), so an itemized template never prints an empty line. */}
            {showAddress && block.props?.addressStyle === 'itemized' && (
             data.customerData.buildingNumber || data.customerData.streetName ||
             data.customerData.district || data.customerData.city || data.customerData.postalCode
            ) ? (
             <p>
              {[
               [data.customerData.buildingNumber, data.customerData.streetName].filter(Boolean).join(' '),
               data.customerData.district,
               data.customerData.city,
               data.customerData.postalCode,
               data.customerData.countryCode || 'SA'
              ].filter(Boolean).join(', ')}
             </p>
            ) : (
             showAddress && data.customerData.address !== '-' && (
              compact
               ? <p className="line-clamp-2">{data.customerData.address}</p>
               : <p>{t('Address')}: {data.customerData.address}</p>
             )
            )}
            {/* ZATCA's data dictionary marks Buyer VAT (BT-48) Mandatory for Standard
                (B2B) invoices — it was already correctly written into the XML, but
                never shown on the human-readable printed document itself. */}
            {(data.customerData.vatNumber || data.customerData.crNumber) && (
             compact ? (
              <p className="font-semibold">
               {data.customerData.vatNumber && <span>{t('VAT Reg')}: <span className="font-mono">{data.customerData.vatNumber}</span></span>}
               {data.customerData.vatNumber && data.customerData.crNumber && <span> | </span>}
               {data.customerData.crNumber && <span>{t('CR')}: <span className="font-mono">{data.customerData.crNumber}</span></span>}
              </p>
             ) : (
              <>
               {data.customerData.vatNumber && (
                <p className="font-semibold">
                 {t('VAT Reg')}: <span className="font-mono">{data.customerData.vatNumber}</span>
                 {isBilingual && <span className="ms-1 font-normal text-slate-400 text-[10px]">(الرقم الضريبي للعميل)</span>}
                </p>
               )}
               {data.customerData.crNumber && (
                <p className="font-semibold">
                 {t('CR')}: <span className="font-mono">{data.customerData.crNumber}</span>
                 {isBilingual && <span className="ms-1 font-normal text-slate-400 text-[10px]">(السجل التجاري للعميل)</span>}
                </p>
               )}
              </>
             )
            )}
           </div>
          ) : (
           <p className="text-xs text-slate-500">{t('Walk-in Customer')}</p>
          )}
         </div>
        </div>
       );
      }

      if (block.id === 'custom_header') {
       if (currentTemplate?.printHeader === false || !companySetup.customHeader) return null;
       const compact = block.props?.compact === true;
       const textAlignClass = block.props?.align === 'right' ? 'text-right' : block.props?.align === 'center' ? 'text-center' : 'text-left';
       return (
        <div key={block.id} className={`${blockColClass} ${getBlockTypographyClasses(block)}`} style={getBlockStyle(block)}>
         <div className={`bg-slate-50/50 rounded-xl text-xs text-slate-600 border border-slate-100 whitespace-pre-line ${compact ? 'p-1.5 line-clamp-2' : 'p-3.5'} ${textAlignClass}`}>
          {companySetup.customHeader}
         </div>
        </div>
       );
      }

      if (block.id === 'items_table') {
       const isBilingual = block.props?.isBilingual !== false;
       const showSNo = block.props?.showSNo !== false;
       const rowStyle = block.props?.borderStyle || 'stripe';
       // Opt-in (default false), unlike the flags above — these add whole new columns
       // rather than toggle an existing one, so an existing template's layout width
       // stays unaffected unless a template (like Detailed Tax Invoice) explicitly asks
       // for them.
       const showItemCode = block.props?.showItemCode === true;
       const showTaxAmount = block.props?.showTaxAmount === true;
       const showLineSubtotal = block.props?.showLineSubtotal === true;
       // When showLineSubtotal is on, the existing amount column (net-of-discount,
       // pre-VAT) is relabeled "Taxable" and a genuine post-VAT "Subtotal" column is
       // added after it — otherwise that column keeps meaning "Total" as it always has,
       // for backward compatibility with every existing template.
       const amountColLabel = showLineSubtotal ? t('Taxable') : t('Total');
       const amountColLabelAr = showLineSubtotal ? 'الخاضع للضريبة' : 'الإجمالي';
       // getItemTaxRate is shared/hoisted above (also used by the totals_summary
       // block's multi-rate breakdown) — previously the printed table showed no rate
       // at all, so a mixed-rate invoice (a real, tested scenario this session) gave a
       // customer no way to see which line was taxed at which rate.
       // Compact mode: shrinks row padding (py-2.5 -> py-1) and font-size (text-xs/12px
       // -> 10.5px) — measured live on a real 20-line invoice: at py-2.5/text-xs the
       // table alone was 1059px tall against a 1045px A4 printable height, meaning even
       // a zero-height header couldn't have made 20 lines fit on one page. Both literal
       // class strings ('py-1'/'py-2.5', the arbitrary text size) appear as complete
       // tokens right here, so Tailwind's static scanner compiles them regardless of
       // which one this ternary picks at render time (same reasoning as COL_SPAN_MD's
       // comment in documentTemplateDefaults.ts).
       const compact = block.props?.compact === true;
       const cellPad = compact ? 'py-0.5' : 'py-2.5';
       const tableFontClass = block.props?.fontSize ? '' : (compact ? 'text-[10.5px]' : 'text-xs');

       return (
        // The <table> itself used to hardcode text-xs unconditionally — since font-size
        // (unlike font-weight/font-family) doesn't fall through to a descendant that has
        // its own explicit size class, that hardcoded text-xs on <table> silently beat
        // this block's own fontSize override for every header/cell inside it (confirmed:
        // a saved fontSize:"sm" override still measured 12px via getComputedStyle on a
        // real <th>, not the requested 14px), even though fontWeight/fontFamily worked
        // correctly since <table> never set those. Only fall back to the default text-xs
        // when no explicit fontSize is configured, so the override actually takes effect
        // while the existing default (no override) appearance is unchanged.
        <div key={block.id} className={`${blockColClass} overflow-x-auto ${getBlockTypographyClasses(block)}`} style={getBlockStyle(block)}>
         <table className={`w-full ${tableFontClass} border-collapse min-w-[500px]`}>
          <thead>
           <tr className={theme.tableHeaderClass}>
            {showSNo && <th className={`${cellPad} px-3 font-semibold text-center w-12 whitespace-nowrap`}>{t('S.No')}</th>}
            {showItemCode && <th className={`${cellPad} px-3 font-semibold text-center w-20 whitespace-nowrap`}>
             {t('Item Code')}
             {isBilingual && <span className="block text-[10px] font-normal text-slate-200 mt-0.5">رمز الصنف</span>}
            </th>}
            <th className={`${cellPad} px-3 font-semibold ${isRTL ? 'text-end' : 'text-start'}`}>
             {t('Description')}
             {isBilingual && <span className="block text-[10px] font-normal text-slate-200 mt-0.5">الوصف / البند</span>}
            </th>
            <th className={`${cellPad} px-3 font-semibold text-center w-24 whitespace-nowrap`}>
             {t('Unit Cost')}
             {isBilingual && <span className="block text-[10px] font-normal text-slate-200 mt-0.5">سعر الوحدة</span>}
            </th>
            <th className={`${cellPad} px-3 font-semibold text-center w-20 whitespace-nowrap`}>
             {t('Quantity')}
             {isBilingual && <span className="block text-[10px] font-normal text-slate-200 mt-0.5">الكمية</span>}
            </th>
            <th className={`${cellPad} px-3 font-semibold text-center w-16 whitespace-nowrap`}>
             {t('VAT %')}
             {isBilingual && <span className="block text-[10px] font-normal text-slate-200 mt-0.5">نسبة الضريبة</span>}
            </th>
            <th className={`${cellPad} px-3 font-semibold w-24 whitespace-nowrap ${isRTL ? 'text-start' : 'text-end'}`}>
             {amountColLabel}
             {isBilingual && <span className="block text-[10px] font-normal text-slate-200 mt-0.5">{amountColLabelAr}</span>}
            </th>
            {showTaxAmount && <th className={`${cellPad} px-3 font-semibold w-24 whitespace-nowrap ${isRTL ? 'text-start' : 'text-end'}`}>
             {t('Tax Amount')}
             {isBilingual && <span className="block text-[10px] font-normal text-slate-200 mt-0.5">مبلغ الضريبة</span>}
            </th>}
            {showLineSubtotal && <th className={`${cellPad} px-3 font-semibold w-24 whitespace-nowrap ${isRTL ? 'text-start' : 'text-end'}`}>
             {t('Subtotal')}
             {isBilingual && <span className="block text-[10px] font-normal text-slate-200 mt-0.5">المجموع الفرعي</span>}
            </th>}
           </tr>
          </thead>
          <tbody>
           {items.map((item: any, idx: number) => {
            const itemNetCost = Math.max(0, (item.unitCost || 0) - (item.discountAmount || 0));
            const stripeClass = rowStyle === 'stripe' && idx % 2 === 1 ? 'bg-slate-50/40' : '';
            const itemRate = getItemTaxRate(item);
            return (
             <tr key={item.id} className={`border-b border-slate-100 ${stripeClass}`}>
              {showSNo && <td className={`${cellPad} px-3 text-center text-slate-500 w-12 whitespace-nowrap`}>{idx + 1}</td>}
              {showItemCode && (() => {
               // Free-typed lines (no productId — see invoiceItems.productId's schema
               // comment) have no catalog code to show; blank rather than an error.
               const product = item.productId ? db?.products?.find((p: any) => p.id === item.productId) : null;
               return <td className={`${cellPad} px-3 text-center text-slate-500 w-20 whitespace-nowrap font-mono`}>{product?.sku || product?.barcode || '—'}</td>;
              })()}
              <td className={`${cellPad} px-3 text-slate-800 font-medium ${isRTL ? 'text-end' : 'text-start'}`}>
               <div>{item.description}</div>
               {item.discountAmount > 0 && block.props?.showDiscount !== false && (
                <div className="text-[10px] text-rose-500 font-semibold">
                 Discounted -{fmt(item.discountAmount)} per unit
                </div>
               )}
              </td>
              <td className={`${cellPad} px-3 text-center text-slate-600 w-24`}>
               {item.discountAmount > 0 ? (
                // Two explicit stacked lines, not one nowrap-forced line — "77.00 SAR" +
                // "76.00 SAR" together don't fit this column's width at normal invoice
                // font size, and whitespace-nowrap on one line just forces an overflow/
                // overlap instead of wrapping. block+text-xs keeps both numbers fully
                // legible on their own line regardless of column width.
                <div className="whitespace-nowrap">
                 <div className="line-through text-slate-400 text-[10px]">{fmt(item.unitCost)}</div>
                 <div className="font-bold text-slate-700">{fmt(itemNetCost)}</div>
                </div>
               ) : (
                <span className="whitespace-nowrap">{fmt(item.unitCost)}</span>
               )}
              </td>
              <td className={`${cellPad} px-3 text-center text-slate-600 w-20 whitespace-nowrap`}>
               {item.quantity}
               {/* The same unit code submitted to ZATCA in this invoice's XML
                   (normalizeZatcaUnitCode, src/zatcaUnitCodes.ts) — always shown
                   (including the PCE default) so the printed document and the ZATCA
                   submission never silently disagree about what unit a line was sold
                   in, and so it's directly visible during compliance verification. */}
               <span className="text-[10px] text-slate-400 ms-1">{item.unit || 'PCE'}</span>
              </td>
              <td className={`${cellPad} px-3 text-center text-slate-600 w-16 whitespace-nowrap`}>{itemRate}%</td>
              {(() => {
               const lineTaxable = itemNetCost * item.quantity;
               const lineTax = lineTaxable * (itemRate / 100);
               return (
                <>
                 <td className={`${cellPad} px-3 text-slate-800 font-semibold w-24 whitespace-nowrap ${isRTL ? 'text-start' : 'text-end'}`}>{fmt(lineTaxable)}</td>
                 {showTaxAmount && <td className={`${cellPad} px-3 text-slate-600 w-24 whitespace-nowrap ${isRTL ? 'text-start' : 'text-end'}`}>{fmt(lineTax)}</td>}
                 {showLineSubtotal && <td className={`${cellPad} px-3 text-slate-900 font-bold w-24 whitespace-nowrap ${isRTL ? 'text-start' : 'text-end'}`}>{fmt(lineTaxable + lineTax)}</td>}
                </>
               );
              })()}
             </tr>
            );
           })}
          </tbody>
         </table>
        </div>
       );
      }

      if (block.id === 'notes') {
       // An invisible spacer (not `return null`) when there's no note text — this
       // block shares its grid row with qr_code/totals_summary. Returning null
       // removes it from the DOM entirely, and CSS Grid auto-placement then shifts
       // the remaining siblings left to fill the gap instead of holding their
       // intended column position — confirmed live: an invoice with no notes text
       // printed with its QR code and totals summary both stranded mid-page instead
       // of the totals summary sitting flush at the right margin. Reserving the
       // column (even empty) keeps every sibling's position independent of whether
       // this one has content, matching how the row looks whenever notes IS set.
       if (!notes) return <div key={block.id} className={blockColClass} />;
       const isBilingual = block.props?.isBilingual === true;
       const compact = block.props?.compact === true;
       const textAlignClass = block.props?.align === 'right' ? 'text-right' : block.props?.align === 'center' ? 'text-center' : 'text-left';
       return (
        <div key={block.id} className={`${blockColClass} ${getBlockTypographyClasses(block)}`} style={getBlockStyle(block)}>
         <div className={`border border-slate-150 rounded-xl bg-slate-50/40 ${compact ? 'p-2' : 'p-3.5'} ${textAlignClass}`}>
          <h4 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
           {t('Notes')}
           {isBilingual && <span className="ms-1.5 text-[9px] text-slate-400">الشروط والأحكام</span>}
          </h4>
          <p className={`text-xs text-slate-600 whitespace-pre-line ${compact ? 'leading-snug line-clamp-3' : 'leading-relaxed'}`}>{notes}</p>
         </div>
        </div>
       );
      }

      if (block.id === 'qr_code') {
       // Quotations are never submitted to ZATCA at all — there's no clearance
       // concept for them. Previously this block rendered unconditionally, showing a
       // fake "ZATCA QR Verification... Not Yet Cleared" badge on a document type
       // ZATCA has no knowledge of whatsoever, which is actively confusing (implies a
       // quotation is expected to be ZATCA-cleared, when it structurally never is).
       // Spacer, not `return null` — shares its grid row with notes/totals_summary.
       // Removing it from the DOM entirely shifted totals_summary left to fill the
       // gap instead of holding its intended column (confirmed live on a real
       // printed invoice with no notes text: QR and totals both ended up stranded
       // mid-page instead of totals sitting flush at the right margin). This means
       // EVERY Quotation had this same misalignment unconditionally, since
       // isInvoice is always false there — not just the empty-notes edge case.
       if (!isInvoice) return <div key={block.id} className={blockColClass} />;
       if (currentTemplate?.printQrCode === false) return <div key={block.id} className={blockColClass} />;
       const alignClass = block.props?.align === 'right' ? 'justify-end' : block.props?.align === 'left' ? 'justify-start' : 'justify-center';
       const isBilingual = block.props?.isBilingual !== false;
       const compact = block.props?.compact === true;
       const size = compact ? 'small' : (block.props?.size || 'medium');
       const sizeClass = size === 'small' ? 'w-12 h-12' : size === 'large' ? 'w-24 h-24' : 'w-20 h-20';

       return (
        <div key={block.id} className={`${blockColClass} flex ${alignClass} items-center ${getBlockTypographyClasses(block)}`} style={getBlockStyle(block)}>
         <div className={`flex flex-col items-center justify-center bg-white rounded-xl border border-slate-150 shadow-sm shrink-0 ${compact ? 'p-1.5' : 'p-2.5'}`}>
          {localQrDataUri ? (
           <img src={localQrDataUri} alt="ZATCA QR Verification" className={sizeClass} />
          ) : (
           <div className={`${sizeClass} bg-slate-100 rounded`} />
          )}
          {/* tracking-wider (letter-spacing) breaks Arabic's cursive glyph joining —
              Arabic letters must connect to their neighbors, and forcing a gap between
              them renders as disconnected/overlapping shapes instead of legible script
              (confirmed live: "تم التخليص" printed garbled). Keep tracking-wider/uppercase
              on the Latin portion only; the Arabic portion gets its own untracked span,
              matching every other bilingual caption in this file. */}
          <span className={`text-[8px] font-bold mt-1 whitespace-nowrap ${isZatcaConfirmed ? 'text-slate-400' : 'text-amber-500'}`}>
           <span className="uppercase tracking-wider">
            {isZatcaConfirmed ? (docZatcaStatus === 'CLEARED' ? 'Cleared' : 'Reported') : 'Not Yet Cleared'}
           </span>
           {isBilingual && (
            <span className="ms-1">
             / {isZatcaConfirmed ? (docZatcaStatus === 'CLEARED' ? 'تم التخليص' : 'تم الإبلاغ') : 'قيد الانتظار'}
            </span>
           )}
          </span>
         </div>
        </div>
       );
      }

      if (block.id === 'totals_summary') {
       const isBilingual = block.props?.isBilingual !== false;
       // Default to the same amber/blue warning accent as the title above for a
       // Credit/Debit Note (a template with an explicit accentColor still wins) — the
       // grand total is the number most likely to be scanned at a glance, so it should
       // carry the same "this adjusts another invoice" visual cue.
       const accentColor = block.props?.accentColor || (isCreditNote ? 'amber' : isDebitNote ? 'blue' : 'indigo');

       const totalAccentText = resolveAccentTextClass(accentColor, "text-indigo-600");

       // Financial convention (and the pre-existing default) is right-aligned via
       // w-full max-w-sm md:ms-auto — proven working (this is what real generated
       // invoices already show correctly). An explicit 'left' override needs the box
       // to actually shrink narrower than its own column for "no auto margin" to read
       // as left-aligned rather than just filling the column edge-to-edge either way —
       // same fixed-vs-relative-width flaw already found and fixed on customer_info:
       // max-w-sm (384px) does nothing when the column itself (e.g. w:4 ≈ 230px,
       // typical for this block sharing a row with notes+qr_code) is already
       // narrower, so w-4/5 (relative to the column) is used for the two non-default
       // explicit choices instead.
       const totalsWidthClass = block.props?.align === 'left' || block.props?.align === 'center' ? 'w-4/5' : 'w-full max-w-sm';
       // The UNSET/default case keeps the logical md:ms-auto ("proven working" per the
       // comment above, left untouched here). An EXPLICIT align:"right" is a literal,
       // physical choice though — same reasoning as customer_info's cardPosClass fix
       // just above: ms-auto is direction-aware and flips to push the box LEFT under an
       // RTL (Arabic/Urdu) template, silently contradicting an admin's explicit "right"
       // pick. md:ml-auto is physical and always pushes right regardless of direction.
       // md: alone doesn't survive actual print/PDF rendering — see docDetailsPosClass's
       // comment above for why print:* is paired with every md:* alignment class here too.
       const totalsPosClass = block.props?.align === 'left' ? '' : block.props?.align === 'center' ? 'md:mx-auto print:mx-auto' : block.props?.align === 'right' ? 'md:ml-auto print:ml-auto' : 'md:ms-auto print:ms-auto';
       // Compact mode drops the Arabic sub-captions (folded into the label itself for
       // bilingual clarity, e.g. "VAT / ضريبة") and tightens padding/spacing — this row
       // shares grid space with notes/qr_code and was part of the 195px footer block
       // that, together with a dense items table, was still pushing a 20-line invoice
       // onto a second page even with an already-compact header.
       const compact = block.props?.compact === true;
       return (
        <div key={block.id} className={`${blockColClass} ${getBlockTypographyClasses(block)}`} style={getBlockStyle(block)}>
         <div className={`border border-slate-100 rounded-xl bg-slate-50 ${compact ? 'space-y-0.5 p-2' : 'space-y-1.5 p-4'} ${totalsWidthClass} ${totalsPosClass}`}>
         <div className="flex justify-between text-xs text-slate-600">
          <span className="whitespace-nowrap">
           {t('Subtotal')}{isBilingual && !compact && ':'}
           {isBilingual && (compact ? <span className="text-[9px] text-slate-400"> / المجموع الفرعي:</span> : <span className="block text-[8px] text-slate-400">المجموع الفرعي</span>)}
           {!isBilingual && ':'}
          </span>
          <span className="font-medium whitespace-nowrap font-mono">{fmt(totals.subtotal)}</span>
         </div>

         {totals.discountAmount > 0 && (
          <div className="flex justify-between text-xs text-rose-600 font-bold">
           <span className="whitespace-nowrap">
            Total Discount:
            {isBilingual && !compact && <span className="block text-[8px] text-rose-400">مجموع الخصومات</span>}
           </span>
           <span className="whitespace-nowrap font-mono">-{fmt(totals.discountAmount)}</span>
          </div>
         )}

         {totals.discountAmount > 0 && (
          <div className={`flex justify-between text-xs text-slate-700 font-semibold border-t border-slate-100 ${compact ? '' : 'pt-1'}`}>
           <span className="whitespace-nowrap">
            Net Subtotal:
            {isBilingual && !compact && <span className="block text-[8px] text-slate-400">صافي الفرعي</span>}
           </span>
           <span className="whitespace-nowrap font-mono">{fmt(totals.discountedSubtotal)}</span>
          </div>
         )}

         {hasMultipleVatRates ? (
          // Mirrors the ZATCA XML's own one-TaxSubtotal-per-rate breakdown — a single
          // blended "VAT (X%)" figure using just the header rate would misrepresent
          // what a mixed-rate invoice actually cleared with ZATCA.
          Array.from(vatRateGroups.entries()).sort((a, b) => b[0] - a[0]).map(([rate, group]) => (
           <div key={rate} className="flex justify-between text-xs text-slate-600">
            <span className="whitespace-nowrap">
             {t('VAT')} ({rate}%):
             {isBilingual && !compact && <span className="block text-[8px] text-slate-400">ضريبة القيمة المضافة</span>}
            </span>
            <span className="font-medium whitespace-nowrap font-mono">{fmt(Number(group.taxAmount.toFixed(2)))}</span>
           </div>
          ))
         ) : totals.percentage > 0 && (
          <div className="flex justify-between text-xs text-slate-600">
           <span className="whitespace-nowrap">
            {t('VAT')} ({totals.percentage}%):
            {isBilingual && !compact && <span className="block text-[8px] text-slate-400">ضريبة القيمة المضافة</span>}
           </span>
           <span className="font-medium whitespace-nowrap font-mono">{fmt(totals.taxAmount)}</span>
          </div>
         )}

                   <div className={`flex justify-between text-sm font-bold text-slate-900 border-t border-slate-200 ${compact ? 'pt-1' : 'pt-2 mt-1'}`}>
           <span className="whitespace-nowrap">
            {t('Grand Total')}:
            {isBilingual && !compact && <span className="block text-[9px] text-slate-400">الإجمالي الكلي</span>}
           </span>
           <span className={`${totalAccentText} text-base whitespace-nowrap font-mono font-bold`}>{fmt(totals.grandTotal)}</span>
          </div>

          {/* Amount Paid / Balance Due — Invoice only (a Quotation has no payment concept
              at all). Balance Due is hidden once the invoice is fully paid — showing
              "Balance Due: 0.00" on a settled invoice reads as an outstanding claim, not
              a confirmation of payment. */}
          {isInvoice && (
           <>
            <div className={`flex justify-between text-xs text-emerald-700 font-semibold ${compact ? '' : 'pt-1'}`}>
             <span className="whitespace-nowrap">
              {t('Amount Paid')}:
              {isBilingual && !compact && <span className="block text-[8px] text-emerald-500">المبلغ المدفوع</span>}
             </span>
             <span className="whitespace-nowrap font-mono">{fmt((doc as Invoice).amountPaid || 0)}</span>
            </div>
            {Math.max(0, totals.grandTotal - ((doc as Invoice).amountPaid || 0)) > 0.004 && (
             <div className="flex justify-between text-xs text-rose-600 font-bold">
              <span className="whitespace-nowrap">
               {t('Balance Due')}:
               {isBilingual && !compact && <span className="block text-[8px] text-rose-400">الرصيد المستحق</span>}
              </span>
              <span className="whitespace-nowrap font-mono">{fmt(Math.max(0, totals.grandTotal - ((doc as Invoice).amountPaid || 0)))}</span>
             </div>
            )}
           </>
          )}

          {/* Declared in documentTemplateDefaults.ts's DEFAULT_DOCUMENT_LAYOUT since that
              file was first written, but never actually implemented here — an admin
              could enable "Grand Total in Words" in the Canvas Designer and it silently
              did nothing. Defaults to on (`!== false`) for consistency with every other
              flag in this block, which means it now also activates on the existing
              default template, not just the new Detailed Tax Invoice one. Hidden entirely
              in compact mode — it's the lowest-value line in this block (a legal nicety,
              not a number anyone reads first) and often the single tallest line since it
              wraps to 2 full-width lines for a large total. */}
          {block.props?.showGrandTotalWords !== false && !compact && (
           <div className="text-[10px] text-slate-500 border-t border-slate-100 pt-1.5 mt-1 leading-snug">
            <span className="font-semibold text-slate-600">{t('Amount in Words')}: </span>
            {amountToWordsForCurrency(totals.grandTotal, companySetup.currency)}
           </div>
          )}
         </div>
        </div>
       );
      }

       if (block.id === 'custom_footer') {
        if (currentTemplate?.printFooter === false || !companySetup.customFooter) return null;
        // Center is the pre-existing default footer convention — align lets a
        // template explicitly choose left/right instead.
        const footerAlignClass = block.props?.align === 'right' ? 'text-right' : block.props?.align === 'left' ? 'text-left' : 'text-center';
        return (
         <div key={block.id} className={`col-span-12 footer-text mt-6 pt-4 border-t border-slate-200 ${footerAlignClass} text-[10px] text-slate-400 whitespace-pre-line ${getBlockTypographyClasses(block)}`} style={getBlockStyle(block)}>
          {companySetup.customFooter}
         </div>
        );
       }

       if (block.type === 'custom_field' || block.id.startsWith('custom_field_')) {
        const alignClass = block.props?.align === 'right' ? 'text-right' : block.props?.align === 'center' ? 'text-center' : 'text-left';
        let valueStr = block.props?.staticText || '';
        const binding = block.props?.fieldBinding;
        if (binding === 'docNumber') valueStr = docNum;
        else if (binding === 'docDate') valueStr = doc.date;
        else if (binding === 'dueDate') valueStr = (doc as any).dueDate || (doc as Invoice).paymentDate || '-';
        else if (binding === 'paymentStatus') valueStr = (doc as Invoice).paymentStatus || doc.status;
        else if (binding === 'paymentMethod') valueStr = data.bankData?.bankName || 'Default Bank';
        else if (binding === 'originQuotation') valueStr = (doc as Invoice).originQuotationId || '-';
        else if (binding === 'customerName') valueStr = data.customerData?.name || 'Walk-in Customer';
        else if (binding === 'customerVat') valueStr = data.customerData?.vatNumber || '-';
        else if (binding === 'customerPhone') valueStr = data.customerData?.phone || '-';
        else if (binding === 'customerAddress') valueStr = data.customerData?.address || '-';
        else if (binding === 'companyVat') valueStr = companySetup.vatNumber || '-';
        else if (binding === 'companyBank') valueStr = (companySetup as any).bankIban || data.bankData?.iban || '-';
        else if (binding === 'createdBy') valueStr = (doc as any).createdBy || 'Admin';

        // Same "Box Frame Style" options as customer_info (solid/dashed/none) — the
        // Canvas Designer panel previously never exposed this control for custom_field
        // at all, so every custom field was stuck with a hardcoded solid card.
        const borderStyle = block.props?.borderStyle || 'solid';
        let cardClass = "p-2.5 rounded-xl bg-slate-50/50 space-y-0.5 ";
        if (borderStyle === 'solid') cardClass += "border border-slate-150";
        else if (borderStyle === 'dashed') cardClass += "border border-dashed border-slate-350";
        else cardClass += "p-0";

        return (
         <div key={block.id} className={`${blockColClass} ${alignClass} ${getBlockTypographyClasses(block)}`} style={getBlockStyle(block)}>
          <div className={cardClass}>
           <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
            {block.props?.labelEn || block.title || 'Custom Field'}
            {block.props?.isBilingual !== false && block.props?.labelAr && (
             <span className="ms-1.5 font-normal text-slate-400">{block.props.labelAr}</span>
            )}
           </p>
           <p className="text-xs font-semibold text-slate-800">{valueStr || '-'}</p>
          </div>
         </div>
        );
       }

       return null;
  };

  return (
   <div className={`flex flex-col justify-between ${anchorHeightClass} ${getGlobalFontClass()}`} id="printable-inner">
    <div className={`grid grid-cols-12 gap-x-4 ${getGridGapClass()}`}>
     {mainBlocks.map(renderBlock)}
    </div>
    {anchorFooterToBottom && (
     <div className={`grid grid-cols-12 gap-x-4 ${getGridGapClass()}`}>
      {footerBlocks.map(renderBlock)}
     </div>
    )}
   </div>
  );
  };

  const renderExpense = (exp: Expense) => {
 const taxSlab = taxSlabs.find(ts => ts.id === exp.taxSlabId);
 const showTax = taxSlab && taxSlab.percentage > 0;
 const baseAmount = showTax ? exp.amount / (1 + (taxSlab.percentage / 100)) : exp.amount;
 const taxAmount = exp.amount - baseAmount;

 return (
 <div className="flex flex-col h-full justify-between">
 <div>
 {/* Header */}
 <div className="flex justify-between items-start border-b border-slate-200 pb-6 mb-6">
 <div>
 <h1 className="text-xl font-bold text-slate-900">{companySetup.name}</h1>
 <p className="text-xs text-slate-500">{companySetup.address}</p>
 </div>
 <div className="text-end">
 <h2 className="text-2xl font-bold uppercase text-rose-600 mb-1">{t('Expense')}</h2>
 <p className="text-xs text-slate-500"><span className="font-semibold">{t('Expense Number')}:</span> {exp.expenseNumber}</p>
 <p className="text-xs text-slate-500"><span className="font-semibold">{t('Date')}:</span> {exp.date}</p>
 </div>
 </div>

 <div className="grid grid-cols-2 gap-4 mb-6 text-xs">
 <div className="bg-slate-50 p-3 rounded-lg border border-slate-100">
 <p className="font-semibold text-slate-400 uppercase tracking-wider text-[10px] mb-1">{t('Vendor')}</p>
 <p className="font-bold text-slate-800 text-sm">{data.vendorData?.name || t('Cash Vendor')}</p>
 {data.vendorData?.phone && data.vendorData.phone !== '-' && <p className="text-slate-500 mt-1">{t('Phone')}: {data.vendorData.phone}</p>}
 </div>
 <div className="bg-slate-50 p-3 rounded-lg border border-slate-100">
 <p className="font-semibold text-slate-400 uppercase tracking-wider text-[10px] mb-1">Payment Method & Bank</p>
 <p className="font-bold text-slate-800">{data.bankData?.bankName || 'Default Bank'}</p>
 <p className="text-slate-500 mt-0.5">Account: {data.bankData?.accountNumber || '-'}</p>
 <p className="text-slate-500 mt-0.5">Status:{' '}
 <span className={`px-1 rounded text-[10px] font-semibold ${
 exp.paymentStatus === 'Paid' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
 }`}>
 {exp.paymentStatus}
 </span>
 </p>
 </div>
 </div>

 <div className="border border-slate-100 rounded-xl p-4 bg-slate-50/50 mb-6">
 <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Transaction Details</h3>
 <div className="text-xs text-slate-700 space-y-2">
 <p><span className="font-bold text-slate-800">Description:</span> {exp.description}</p>
 <p><span className="font-bold text-slate-800">Expense Type:</span> {exp.type} {exp.type === 'Accrual' && <span className="px-1.5 py-0.5 bg-purple-100 text-purple-800 rounded font-bold uppercase text-[9px]">Accrual</span>}</p>
 {exp.originAccrualId && (
 <p className="text-indigo-600 font-medium">✨ Settles prior accrual expense ID: {exp.originAccrualId}</p>
 )}
 </div>
 </div>

 {/* Table for itemised lines if any */}
 {exp.items && exp.items.length > 0 && (
 <div className="mb-6">
 <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Itemised Breakdown</h3>
 <div className="overflow-x-auto"><table className="w-full text-xs border-collapse min-w-[500px]">
 <thead>
 <tr className="bg-slate-100 text-slate-700">
 <th className="py-2 px-3 text-center w-12 whitespace-nowrap">S.No</th>
 <th className={`py-2 px-3 font-semibold ${isRTL ? 'text-end' : 'text-start'}`}>Item Name / Description</th>
 <th className="py-2 px-3 text-center w-24 whitespace-nowrap">Unit Cost</th>
 <th className="py-2 px-3 text-center w-20 whitespace-nowrap">Quantity</th>
 <th className={`py-2 px-3 font-semibold w-24 whitespace-nowrap ${isRTL ? 'text-start' : 'text-end'}`}>Total</th>
 </tr>
 </thead>
 <tbody>
 {exp.items.map((item: any, idx: number) => (
 <tr key={item.id} className="border-b border-slate-100">
 <td className="py-1.5 px-3 text-center text-slate-500 w-12 whitespace-nowrap">{idx + 1}</td>
 <td className={`py-1.5 px-3 text-slate-800 font-medium ${isRTL ? 'text-end' : 'text-start'}`}>{item.description}</td>
 <td className="py-1.5 px-3 text-center text-slate-600 w-24 whitespace-nowrap">{fmt(item.unitCost)}</td>
 <td className="py-1.5 px-3 text-center text-slate-600 w-20 whitespace-nowrap">{item.quantity}</td>
 <td className={`py-1.5 px-3 text-slate-800 font-semibold w-24 whitespace-nowrap ${isRTL ? 'text-start' : 'text-end'}`}>{fmt(item.unitCost * item.quantity)}</td>
 </tr>
 ))}
 </tbody>
 </table></div>
 </div>
 )}

 {/* Totals */}
 <div className="flex justify-end mt-6">
 <div className="w-72 bg-slate-100 p-4 rounded-xl border border-slate-200">
 {showTax && (
 <div className="space-y-1 text-xs text-slate-600 mb-2 pb-2 border-b border-slate-200">
 <div className="flex justify-between">
 <span>Amount (Excl VAT):</span>
 <span>{fmt(baseAmount)}</span>
 </div>
 <div className="flex justify-between">
 <span>VAT ({taxSlab.percentage}%):</span>
 <span>{fmt(taxAmount)}</span>
 </div>
 </div>
 )}
 <div className="flex justify-between text-sm font-bold text-slate-900">
 <span>Total Expense Cost:</span>
 <span className="text-rose-600 text-base">{fmt(exp.amount)}</span>
 </div>
 </div>
 </div>
 </div>

 {companySetup.customFooter && (
 <div className="footer-text mt-12 pt-4 border-t border-slate-200 text-center text-[10px] text-slate-400">
 {companySetup.customFooter}
 </div>
 )}
 </div>
 );
 };

 const renderVoucher = (vch: Voucher) => {
 // Who the money actually moved with — a customer for an Invoice-linked voucher, a
 // vendor for an Expense/PurchaseBill-linked one. The LABEL depends on direction, not
 // just who's involved: a Reversal moves money the opposite way from a normal
 // Receipt/Payment (mirrors the Debit/Credit column logic a few lines below — a
 // Reversal against an Invoice is money going back OUT to the customer, e.g. a Credit
 // Note undoing a prior receipt; a Reversal against an Expense/PurchaseBill is money
 // coming back IN from the vendor). Getting this backwards on a printed reversal
 // receipt would misrepresent which way the cash actually moved.
 const isReversal = vch.type === 'Reversal';
 const voucherParty = (() => {
 if (vch.referenceType === 'Invoice' && db) {
 const inv = db.invoices.find(i => i.id === vch.referenceId);
 const cust = inv ? db.customers.find(c => c.id === inv.customerId) : undefined;
 if (cust) return { label: isReversal ? 'Refunded To' : 'Received From', name: cust.name, phone: cust.phone, email: cust.email, address: cust.address };
 } else if (vch.referenceType === 'Expense' && db) {
 const exp = db.expenses.find(e => e.id === vch.referenceId);
 const vend = exp ? db.vendors.find(v => v.id === exp.vendorId) : undefined;
 if (vend) return { label: isReversal ? 'Refunded By' : 'Paid To', name: vend.name, phone: vend.phone, email: vend.email, address: vend.address };
 } else if (vch.referenceType === 'PurchaseBill' && db) {
 const bill = (db as any).purchaseBills?.find((b: any) => b.id === vch.referenceId);
 const vend = bill ? db.vendors.find(v => v.id === bill.vendorId) : undefined;
 if (vend) return { label: isReversal ? 'Refunded By' : 'Paid To', name: vend.name, phone: vend.phone, email: vend.email, address: vend.address };
 } else if (vch.referenceType === 'Equity' && db) {
 // referenceId is the investor's own id directly (not an invoice/expense/bill to look
 // through) — see POST /investors/:id/contribute in transactions.ts.
 const investor = (db as any).investors?.find((i: any) => i.id === vch.referenceId);
 if (investor) return { label: isReversal ? 'Refunded To' : 'Received From', name: investor.name, phone: investor.phone, email: investor.email, address: undefined };
 }
 // 'Transfer' (TransferOut/TransferIn) deliberately falls through to null — referenceId
 // is a synthetic id pairing the two legs of an inter-bank transfer, not a customer,
 // vendor, or investor; there is genuinely no "party" to show for it.
 return null;
 })();

 return (
 <div className="flex flex-col h-full justify-between text-xs">
 <div>
 {/* Header */}
 <div className="flex justify-between items-start border-b border-slate-200 pb-6 mb-6">
 <div>
 <h1 className="text-xl font-bold text-slate-900">{companySetup.name}</h1>
 <p className="text-xs text-slate-500">{companySetup.address}</p>
 </div>
 <div className="text-end">
 <h2 className="text-xl font-bold uppercase text-indigo-700 tracking-wider mb-1">
 {t(vch.type + ' Voucher')}
 </h2>
 <p className="text-slate-500"><span className="font-semibold">{t('Voucher Number')}:</span> {vch.voucherNumber}</p>
 <p className="text-slate-500"><span className="font-semibold">{t('Date')}:</span> {vch.date}</p>
 </div>
 </div>

 {voucherParty && (
 <div className="mb-6">
 <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">{t(voucherParty.label)}</p>
 <p className="text-sm font-bold text-slate-900">{voucherParty.name}</p>
 {(voucherParty.phone || voucherParty.email) && (
 <p className="text-[11px] text-slate-500">{[voucherParty.phone, voucherParty.email].filter(v => v && v !== '-').join(' | ')}</p>
 )}
 {voucherParty.address && voucherParty.address !== '-' && (
 <p className="text-[11px] text-slate-500 whitespace-pre-line">{voucherParty.address}</p>
 )}
 </div>
 )}

 <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4 mb-6">
 <div className="flex justify-between items-center mb-2">
 <span className="text-xs font-semibold uppercase tracking-wider text-indigo-600">{t('Total Voucher Amount')}</span>
 <span className="text-xl font-black text-indigo-900">{fmt(vch.amount)}</span>
 </div>
 <p className="text-[11px] text-indigo-800 leading-relaxed">
 <span className="font-bold">{t('Description:')}</span> {vch.description}
 </p>
 </div>

 <div className="overflow-x-auto"><table className="w-full text-xs min-w-[500px]">
 <thead>
 <tr className="bg-slate-100 text-slate-600">
 <th className="py-2 px-3 text-start">{t('Account Affected')}</th>
 <th className="py-2 px-3 text-start">{t('Reference Source')}</th>
 <th className="py-2 px-3 text-start">{t('Document ID')}</th>
 <th className="py-2 px-3 text-end">{t('Debit / Inflow')}</th>
 <th className="py-2 px-3 text-end">{t('Credit / Outflow')}</th>
 </tr>
 </thead>
 <tbody>
 <tr>
 <td className="py-3 px-3 font-semibold text-slate-800">
 🏦 {data.bankData?.bankName || t('Bank Ledger Account')}
 </td>
 <td className="py-3 px-3 text-slate-600">{vch.referenceType}</td>
 <td className="py-3 px-3 text-slate-600 font-mono">
 {(() => {
 let docNum = '-';
 let refType: 'Invoice' | 'Expense' | null = null;
 if (vch.referenceType === 'Invoice' && db) {
 const inv = db.invoices.find(i => i.id === vch.referenceId);
 if (inv) {
 docNum = inv.invoiceNumber;
 refType = 'Invoice';
 }
 } else if (vch.referenceType === 'Expense' && db) {
 const exp = db.expenses.find(e => e.id === vch.referenceId);
 if (exp) {
 docNum = exp.expenseNumber;
 refType = 'Expense';
 }
 } else if (vch.referenceType === 'PurchaseBill' && db) {
 // No cross-module "view this Purchase Bill" navigation exists from a printed
 // document today (onViewAnotherDoc only knows Quotation/Invoice/Expense/Voucher,
 // and Purchase Bills live in a separate Inventory/Procurement screen) — shown as
 // plain text rather than a dead/incorrect link.
 const bill = (db as any).purchaseBills?.find((b: any) => b.id === vch.referenceId);
 if (bill) docNum = bill.billNumber;
 }

 if (docNum !== '-' && refType && onViewAnotherDoc) {
 return (
 <>
 <button
 type="button"
 onClick={() => onViewAnotherDoc(refType!, vch.referenceId)}
 className="text-indigo-600 hover:text-indigo-800 hover:underline font-bold font-mono no-print"
 >
 {docNum}
 </button>
 <span className="font-mono font-bold text-slate-800 hidden print:inline">{docNum}</span>
 </>
 );
 }
 return <span className="font-mono font-bold text-slate-800">{docNum !== '-' ? docNum : vch.referenceId}</span>;
 })()}
 </td>
 <td className="py-3 px-3 text-end text-emerald-600 font-bold">
 {(vch.type === 'Receipt' || vch.type === 'TransferIn' || (vch.type === 'Reversal' && vch.referenceType === 'Expense')) ? fmt(vch.amount) : '-'}
 </td>
 <td className="py-3 px-3 text-end text-rose-600 font-bold">
 {(vch.type === 'Payment' || vch.type === 'TransferOut' || (vch.type === 'Reversal' && vch.referenceType === 'Invoice')) ? fmt(vch.amount) : '-'}
 </td>
 </tr>
 </tbody>
 </table></div>

 <div className="mt-8 grid grid-cols-2 gap-12 pt-8">
 <div className="text-center">
 <div className="border-b border-slate-300 w-36 mx-auto mb-2 h-10"></div>
 <p className="text-[10px] text-slate-400">{t('Authorized Signature')}</p>
 </div>
 <div className="text-center">
 <div className="border-b border-slate-300 w-36 mx-auto mb-2 h-10"></div>
 <p className="text-[10px] text-slate-400">{t('Receiver Signature')}</p>
 </div>
 </div>
 </div>

 {companySetup.customFooter && (
 <div className="footer-text mt-12 pt-4 border-t border-slate-200 text-center text-[10px] text-slate-400">
 {companySetup.customFooter}
 </div>
 )}
 </div>
 );
 };

 // A clean, customer/vendor-facing "proof of payment" slip — deliberately separate from
 // renderVoucher above, which is the internal double-entry-style accounting record (its
 // Debit/Credit/"Account Affected" bookkeeping table is meaningful to this company's own
 // books, not to whoever is holding the receipt). Same underlying Voucher data, just a
 // different audience: no accounting table, instead the settled document's reference and
 // remaining balance, and the amount spelled out in words the way an invoice already does.
 const renderPaymentReceipt = (vch: Voucher) => {
  const isReversal = vch.type === 'Reversal';
  // Mirrors renderVoucher's own party resolution (same reasoning: label depends on
  // direction, not just who's involved) — kept as its own local copy rather than a
  // shared helper since the two renderers otherwise share almost nothing else.
  const voucherParty = (() => {
   if (vch.referenceType === 'Invoice' && db) {
    const inv = db.invoices.find(i => i.id === vch.referenceId);
    const cust = inv ? db.customers.find(c => c.id === inv.customerId) : undefined;
    if (cust) return { label: isReversal ? 'Refunded To' : 'Received From', name: cust.name, phone: cust.phone, email: cust.email, address: cust.address };
   } else if (vch.referenceType === 'Expense' && db) {
    const exp = db.expenses.find(e => e.id === vch.referenceId);
    const vend = exp ? db.vendors.find(v => v.id === exp.vendorId) : undefined;
    if (vend) return { label: isReversal ? 'Refunded By' : 'Paid To', name: vend.name, phone: vend.phone, email: vend.email, address: vend.address };
   } else if (vch.referenceType === 'PurchaseBill' && db) {
    const bill = (db as any).purchaseBills?.find((b: any) => b.id === vch.referenceId);
    const vend = bill ? db.vendors.find(v => v.id === bill.vendorId) : undefined;
    if (vend) return { label: isReversal ? 'Refunded By' : 'Paid To', name: vend.name, phone: vend.phone, email: vend.email, address: vend.address };
   } else if (vch.referenceType === 'Equity' && db) {
    const investor = (db as any).investors?.find((i: any) => i.id === vch.referenceId);
    if (investor) return { label: isReversal ? 'Refunded To' : 'Received From', name: investor.name, phone: investor.phone, email: investor.email, address: undefined };
   }
   return null;
  })();

  // The settled document's own number + what's still owed after this specific payment —
  // the whole point of a receipt is proving what was paid and what, if anything, remains.
  const settledDoc = (() => {
   if (vch.referenceType === 'Invoice' && db) {
    const inv = db.invoices.find(i => i.id === vch.referenceId);
    if (!inv) return null;
    const grandTotal = calculateInvoiceTotals({ taxSlabs } as any, inv.items, inv.taxSlabId, inv.discountPercentage).grandTotal;
    return { docNum: inv.invoiceNumber, remaining: Math.max(0, grandTotal - (inv.amountPaid || 0)) };
   }
   if (vch.referenceType === 'Expense' && db) {
    const exp = db.expenses.find(e => e.id === vch.referenceId);
    if (!exp) return null;
    return { docNum: exp.expenseNumber, remaining: Math.max(0, exp.amount - (exp.amountPaid || 0)) };
   }
   if (vch.referenceType === 'PurchaseBill' && db) {
    const bill = (db as any).purchaseBills?.find((b: any) => b.id === vch.referenceId);
    if (!bill) return null;
    return { docNum: bill.billNumber, remaining: Math.max(0, bill.grandTotal - (bill.amountPaid || 0)) };
   }
   return null;
  })();

  const title = isReversal ? 'Refund Receipt' : vch.type === 'Receipt' ? 'Payment Receipt' : 'Payment Voucher';

  return (
   <div className="flex flex-col h-full justify-between text-xs">
    <div>
     <div className="flex justify-between items-start border-b border-slate-200 pb-6 mb-6">
      <div>
       <h1 className="text-xl font-bold text-slate-900">{companySetup.name}</h1>
       <p className="text-xs text-slate-500">{companySetup.address}</p>
       <p className="text-xs text-slate-500">{t('Phone')}: {companySetup.phone} | {t('Email')}: {companySetup.email}</p>
      </div>
      <div className="text-end">
       <h2 className="text-xl font-bold uppercase text-emerald-700 tracking-wider mb-1">{t(title)}</h2>
       <p className="text-slate-500"><span className="font-semibold">{t('Receipt Number')}:</span> {vch.voucherNumber}</p>
       <p className="text-slate-500"><span className="font-semibold">{t('Date')}:</span> {vch.date}</p>
      </div>
     </div>

     {voucherParty && (
      <div className="mb-6">
       <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">{t(voucherParty.label)}</p>
       <p className="text-sm font-bold text-slate-900">{voucherParty.name}</p>
       {(voucherParty.phone || voucherParty.email) && (
        <p className="text-[11px] text-slate-500">{[voucherParty.phone, voucherParty.email].filter(v => v && v !== '-').join(' | ')}</p>
       )}
       {voucherParty.address && voucherParty.address !== '-' && (
        <p className="text-[11px] text-slate-500 whitespace-pre-line">{voucherParty.address}</p>
       )}
      </div>
     )}

     <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-4 mb-4">
      <div className="flex justify-between items-center">
       <span className="text-xs font-semibold uppercase tracking-wider text-emerald-700">{t('Amount')}</span>
       <span className="text-2xl font-black text-emerald-900">{fmt(vch.amount)}</span>
      </div>
      <p className="text-[11px] text-emerald-800 mt-1 italic">{amountToWordsForCurrency(Number(vch.amount), companySetup.currency)}</p>
     </div>

     <div className="grid grid-cols-2 gap-4 text-xs mb-6">
      <div>
       <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{t('Payment Method')}</p>
       <p className="font-semibold text-slate-800">{data.bankData?.bankName || t('Bank Account')}</p>
      </div>
      {settledDoc && (
       <div>
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{t('Against Document')}</p>
        <p className="font-semibold text-slate-800 font-mono">{settledDoc.docNum}</p>
       </div>
      )}
      {settledDoc && (
       <div>
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{t('Balance Remaining')}</p>
        <p className={`font-bold ${settledDoc.remaining > 0.01 ? 'text-amber-600' : 'text-emerald-600'}`}>
         {settledDoc.remaining > 0.01 ? fmt(settledDoc.remaining) : t('Fully Settled')}
        </p>
       </div>
      )}
     </div>

     <div className="mt-10 grid grid-cols-2 gap-12 pt-8">
      <div className="text-center">
       <div className="border-b border-slate-300 w-36 mx-auto mb-2 h-10"></div>
       <p className="text-[10px] text-slate-400">{t('Authorized Signature')}</p>
      </div>
      <div className="text-center">
       <div className="border-b border-slate-300 w-36 mx-auto mb-2 h-10"></div>
       <p className="text-[10px] text-slate-400">{t('Receiver Signature')}</p>
      </div>
     </div>
    </div>

    {companySetup.customFooter && (
     <div className="footer-text mt-12 pt-4 border-t border-slate-200 text-center text-[10px] text-slate-400">
      {companySetup.customFooter}
     </div>
    )}
   </div>
  );
 };

 const renderLedger = (ledgerData: { bank: any; entries: BankLedgerEntry[] }) => {
 return (
 <div className="text-xs">
 <div className="border-b border-slate-200 pb-4 mb-4 flex justify-between items-end">
 <div>
 <h1 className="text-base font-bold text-slate-900">{companySetup.name}</h1>
 <p className="text-[10px] text-slate-500">{t('Bank Statement Report')}</p>
 </div>
 <div className="text-end">
 <h2 className="text-lg font-bold text-indigo-700">{t('BANK ACCOUNT LEDGER')}</h2>
 <p className="text-[11px] font-bold text-slate-800">{ledgerData.bank.bankName}</p>
 <p className="text-[10px] text-slate-500">{t('A/C Title:')} {ledgerData.bank.accountTitle} | {t('No:')} {ledgerData.bank.accountNumber}</p>
 </div>
 </div>

 <div className="overflow-x-auto"><table className="w-full text-start text-[11px] min-w-[600px]">
 <thead>
 <tr className="bg-slate-100 text-slate-700 border-b border-slate-300">
 <th className="py-2 px-2">{t('Date')}</th>
 <th className="py-2 px-2">{t('Voucher No')}</th>
 <th className="py-2 px-2">{t('Type')}</th>
 <th className="py-2 px-2">{t('Description')}</th>
 <th className="py-2 px-2 text-end">{t('Debit (Receipts)')}</th>
 <th className="py-2 px-2 text-end">{t('Credit (Payments)')}</th>
 <th className="py-2 px-2 text-end">{t('Running Balance')}</th>
 </tr>
 </thead>
 <tbody>
 <tr className="border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
 <td className="py-2 px-2">-</td>
 <td className="py-2 px-2">-</td>
 <td className="py-2 px-2">{t('OPENING')}</td>
 <td className="py-2 px-2">{t('Account Initial Setup Balance')}</td>
 <td className="py-2 px-2 text-end">-</td>
 <td className="py-2 px-2 text-end">-</td>
 <td className="py-2 px-2 text-end">{fmt(ledgerData.bank.openingBalance)}</td>
 </tr>
 {ledgerData.entries.map((entry, idx) => (
 <tr key={idx} className="border-b border-slate-100 hover:bg-slate-50/50">
 <td className="py-2 px-2 font-medium">{entry.date}</td>
 <td className="py-2 px-2 font-mono font-semibold text-slate-600">{entry.voucherNumber}</td>
 <td className="py-2 px-2">
 <span className={`px-1 py-0.5 rounded text-[10px] font-semibold ${
 entry.type === 'Receipt' ? 'bg-emerald-50 text-emerald-700' :
 entry.type === 'Payment' ? 'bg-rose-50 text-rose-700' :
 entry.type === 'Reversal' ? 'bg-amber-50 text-amber-700' : 'bg-blue-50 text-blue-700'
 }`}>
 {t(entry.type)}
 </span>
 </td>
 <td className="py-2 px-2 max-w-xs truncate">{entry.description}</td>
 <td className="py-2 px-2 text-end text-emerald-600 font-semibold">{entry.debit > 0 ? fmt(entry.debit) : '-'}</td>
 <td className="py-2 px-2 text-end text-rose-600 font-semibold">{entry.credit > 0 ? fmt(entry.credit) : '-'}</td>
 <td className={`py-2 px-2 text-end font-bold ${entry.runningBalance < 0 ? 'text-rose-600 font-black' : 'text-slate-800'}`}>
 {fmt(entry.runningBalance)}
 </td>
 </tr>
 ))}
 </tbody>
 </table></div>
 </div>
 );
 };

 const renderReport = (reportWrapper: any) => {
 let title = t('Financial Report');
 let subtitle = '';
 let columns: string[] = [];
 let rows: any[][] = [];

 if (!reportWrapper) {
 return (
 <div className="text-center py-6 text-rose-500">
 {t('No report data provided.')}
 </div>
 );
 }

 const { type, startDate, endDate, data: rData } = reportWrapper;
 subtitle = `${t('Period:')} ${startDate || ''} ${t('to')} ${endDate || ''}`;

 if (type === 'TrialBalance' && rData) {
 title = t('Trial Balance Sheet (Dual-Ledger)');
 columns = [t('Ledger Chart Account Head'), `${t('Debit')} (${currencySymbol})`, `${t('Credit')} (${currencySymbol})`];
 const ledgers = rData.ledgers || [];
 rows = ledgers.map((l: any) => [
 l.name,
 l.debit > 0 ? `${currencySymbol} ${l.debit.toFixed(2)}` : '-',
 l.credit > 0 ? `${currencySymbol} ${l.credit.toFixed(2)}` : '-'
 ]);
 rows.push([
 t('Balanced Sum Total:'),
 `${currencySymbol} ${(rData.totalDebits || 0).toFixed(2)}`,
 `${currencySymbol} ${(rData.totalCredits || 0).toFixed(2)}`
 ]);
 } else if (type === 'SalesVAT' && Array.isArray(rData)) {
 title = t('Sales VAT Register (Output Tax)');
 columns = [t('Invoice No'), t('Date'), t('Customer Name'), t('VAT Reg No'), `${t('Subtotal')} (${currencySymbol})`, `${t('VAT Amount (15%)')} (${currencySymbol})`, `${t('Grand Total')} (${currencySymbol})`];
 rows = rData.map((r: any) => [
 r.invoiceNumber,
 r.date,
 r.customerName,
 r.taxRegNumber,
 `${currencySymbol} ${r.subtotal.toFixed(2)}`,
 `${currencySymbol} ${r.taxAmount.toFixed(2)}`,
 `${currencySymbol} ${r.grandTotal.toFixed(2)}`
 ]);
 const subtotalSum = rData.reduce((s: number, r: any) => s + r.subtotal, 0);
 const taxSum = rData.reduce((s: number, r: any) => s + r.taxAmount, 0);
 const grandSum = rData.reduce((s: number, r: any) => s + r.grandTotal, 0);
 rows.push([
 t('Total Sum:'),
 '',
 '',
 '',
 `${currencySymbol} ${subtotalSum.toFixed(2)}`,
 `${currencySymbol} ${taxSum.toFixed(2)}`,
 `${currencySymbol} ${grandSum.toFixed(2)}`
 ]);
 } else if (type === 'PurchaseVAT' && Array.isArray(rData)) {
 title = t('Purchase VAT Register (Input Tax)');
 columns = [t('Expense No'), t('Date'), t('Vendor Name'), t('VAT Reg No'), `${t('Subtotal')} (${currencySymbol})`, `${t('VAT Input')} (${currencySymbol})`, `${t('Total Paid')} (${currencySymbol})`];
 rows = rData.map((r: any) => [
 r.expenseNumber,
 r.date,
 r.vendorName,
 r.taxRegNumber,
 `${currencySymbol} ${r.subtotal.toFixed(2)}`,
 `${currencySymbol} ${r.taxAmount.toFixed(2)}`,
 `${currencySymbol} ${r.grandTotal.toFixed(2)}`
 ]);
 const subtotalSum = rData.reduce((s: number, r: any) => s + r.subtotal, 0);
 const taxSum = rData.reduce((s: number, r: any) => s + r.taxAmount, 0);
 const grandSum = rData.reduce((s: number, r: any) => s + r.grandTotal, 0);
 rows.push([
 t('Total Sum:'),
 '',
 '',
 '',
 `${currencySymbol} ${subtotalSum.toFixed(2)}`,
 `${currencySymbol} ${taxSum.toFixed(2)}`,
 `${currencySymbol} ${grandSum.toFixed(2)}`
 ]);
 } else if (type === 'BankLedger' && rData) {
 const isAllBanks = rData.bankName === 'All Banks Combined';
 title = `${t('Bank General Ledger')}: ${isAllBanks ? t('All Banks Combined') : (rData.bankName || '')}`;
 columns = isAllBanks
 ? [t('Voucher No'), t('Date'), t('Bank'), t('Type'), t('Source Doc #'), t('Description'), `${t('Debit / Inflow')} (${currencySymbol})`, `${t('Credit / Outflow')} (${currencySymbol})`, `${t('Running Balance')} (${currencySymbol})`]
 : [t('Voucher No'), t('Date'), t('Type'), t('Source Doc #'), t('Description'), `${t('Debit / Inflow')} (${currencySymbol})`, `${t('Credit / Outflow')} (${currencySymbol})`, `${t('Running Balance')} (${currencySymbol})`];
 const vouchers = rData.vouchers || [];
 rows = vouchers.map((v: any) => {
 let docNum = '-';
 if (db) {
 const voucher = db.vouchers.find(item => item.voucherNumber === v.voucherNumber);
 if (voucher) {
 if (voucher.referenceType === 'Invoice') {
 const inv = db.invoices.find(i => i.id === voucher.referenceId);
 if (inv) docNum = inv.invoiceNumber;
 } else if (voucher.referenceType === 'Expense') {
 const exp = db.expenses.find(e => e.id === voucher.referenceId);
 if (exp) docNum = exp.expenseNumber;
 }
 }
 }
 const rowData = [
 v.voucherNumber,
 v.date,
 ];
 if (isAllBanks) {
 rowData.push(v.bankName || '-');
 }
 rowData.push(
 t(v.type),
 docNum,
 v.description,
 v.debit > 0 ? `+${v.debit.toFixed(2)}` : '-',
 v.credit > 0 ? `-${v.credit.toFixed(2)}` : '-',
 `${currencySymbol} ${v.runningBalance.toFixed(2)}`
 );
 return rowData;
 });
 rows.push([
 t('End Balance:'),
 '',
 ...(isAllBanks ? [''] : []),
 '',
 '',
 '',
 '',
 '',
 `${currencySymbol} ${(rData.endingBalance || 0).toFixed(2)}`
 ]);
 } else if (type === 'Outstanding' && rData) {
 title = t('Outstanding Accounts Statement (A/R & A/P)');
 columns = [t('Classification'), t('Document #'), t('Due/Exp Date'), t('Contact Entity'), t('Payment Status'), `${t('Total')} (${currencySymbol})`, `${t('Paid')} (${currencySymbol})`, `${t('Outstanding Balance')} (${currencySymbol})`];

 const invRows = (rData.invoices || []).map((i: any) => [
 t('Receivable (Customer Invoice)'),
 i.docNumber,
 i.date,
 i.contactName,
 t(i.paymentStatus),
 `${currencySymbol} ${i.total.toFixed(2)}`,
 `${currencySymbol} ${i.paid.toFixed(2)}`,
 `${currencySymbol} ${i.outstanding.toFixed(2)}`
 ]);

 const expRows = (rData.expenses || []).map((e: any) => [
 t('Payable (Supplier Expense)'),
 e.docNumber,
 e.date,
 e.contactName,
 t(e.paymentStatus),
 `${currencySymbol} ${e.total.toFixed(2)}`,
 `${currencySymbol} ${e.paid.toFixed(2)}`,
 `${currencySymbol} ${e.outstanding.toFixed(2)}`
 ]);

 rows = [...invRows, ...expRows];

 const totalReceivable = (rData.invoices || []).reduce((sum: number, i: any) => sum + i.outstanding, 0);
 const totalPayable = (rData.expenses || []).reduce((sum: number, e: any) => sum + e.outstanding, 0);

 rows.push([
 t('Totals Summary:'),
 '',
 '',
 '',
 '',
 `${t('A/R')}: ${currencySymbol} ${totalReceivable.toFixed(2)}`,
 `${t('A/P')}: ${currencySymbol} ${totalPayable.toFixed(2)}`,
 `${t('Net Receivable')}: ${currencySymbol} ${(totalReceivable - totalPayable).toFixed(2)}`
 ]);
 } else if (type === 'ProfitLoss' && rData) {
 title = t('Profit & Loss Statement');
 subtitle = `${t('Basis:')} ${rData.accountingBasis === 'Accrual' ? t('Accrual Basis') : t('Cash Basis')} | ${t('Period:')} ${startDate || ''} ${t('to')} ${endDate || ''}`;
 columns = [t('Category'), t('Details'), `${t('Amount')} (${currencySymbol})`];

 rows.push([t('Income Statement'), t('Total Revenue'), `${currencySymbol} ${rData.totalRevenue.toFixed(2)}`]);
 rows.push([t('Income Statement'), t('Total Expenses'), `${currencySymbol} ${rData.totalExpenses.toFixed(2)}`]);
 rows.push([t('Income Statement'), t('Net Profit'), `${currencySymbol} ${rData.netProfit.toFixed(2)}`]);
 rows.push(['---', '---', '---']);
 rows.push([t('Cash Flow Analysis'), t('Operating Inflows'), `+${currencySymbol} ${rData.operatingInflows.toFixed(2)}`]);
 rows.push([t('Cash Flow Analysis'), t('Operating Outflows'), `-${currencySymbol} ${rData.operatingOutflows.toFixed(2)}`]);
 rows.push([t('Cash Flow Analysis'), t('Investing Outflows (CapEx)'), `-${currencySymbol} ${rData.investingOutflows.toFixed(2)}`]);
 rows.push([t('Cash Flow Analysis'), t('Financing Inflows (Equity)'), `+${currencySymbol} ${rData.financingInflows.toFixed(2)}`]);
 rows.push([t('Cash Flow Analysis'), t('Net Cash Flow'), `${currencySymbol} ${rData.netCashFlow.toFixed(2)}`]);

 if (rData.investorShares && rData.investorShares.length > 0) {
 rows.push(['---', '---', '---']);
 rData.investorShares.forEach((inv: any) => {
 rows.push([t('Investor Profit Share'), `${inv.name} (${inv.profitPercentage}%)`, `${currencySymbol} ${inv.shareAmount.toFixed(2)}`]);
 });
 }
 } else if (type === 'BalanceSheet' && rData) {
 title = t('Balance Sheet');
 subtitle = `${t('As of')} ${rData.asOfDate}`;
 columns = [t('Section'), t('Line'), `${t('Amount')} (${currencySymbol})`];
 rows.push([t('Assets'), t('Bank Balances'), `${currencySymbol} ${rData.bankBalance.toFixed(2)}`]);
 rows.push([t('Assets'), t('Accounts Receivable'), `${currencySymbol} ${rData.accountsReceivable.toFixed(2)}`]);
 rows.push([t('Assets'), t('Inventory Value'), `${currencySymbol} ${rData.inventoryValue.toFixed(2)}`]);
 rows.push([t('Assets'), t('Total Assets'), `${currencySymbol} ${rData.totalAssets.toFixed(2)}`]);
 rows.push([t('Liabilities'), t('Accounts Payable'), `${currencySymbol} ${rData.accountsPayable.toFixed(2)}`]);
 rows.push([t('Liabilities'), t('Total Liabilities'), `${currencySymbol} ${rData.totalLiabilities.toFixed(2)}`]);
 rows.push([t('Equity'), t('Capital Contributed'), `${currencySymbol} ${rData.capitalContributed.toFixed(2)}`]);
 rows.push([t('Equity'), t('Retained Earnings'), `${currencySymbol} ${rData.retainedEarnings.toFixed(2)}`]);
 rows.push([t('Equity'), t('Total Equity'), `${currencySymbol} ${rData.totalEquity.toFixed(2)}`]);
 } else if (type === 'VatReturnSummary' && rData) {
 title = t('VAT Return Summary');
 subtitle = `${t('Filing Period:')} ${rData.startDate} ${t('to')} ${rData.endDate}`;
 columns = [t('Item'), `${t('Amount')} (${currencySymbol})`];
 rows.push([t('Output VAT (Sales)'), `${currencySymbol} ${rData.outputVat.toFixed(2)}`]);
 rows.push([t('Input VAT (Purchases)'), `${currencySymbol} ${rData.inputVat.toFixed(2)}`]);
 rows.push([rData.netVatPayable >= 0 ? t('Net VAT Payable') : t('Net VAT Refundable'), `${currencySymbol} ${Math.abs(rData.netVatPayable).toFixed(2)}`]);
 } else if (type === 'InvestorProfitShare' && rData) {
 title = t('Investor Profit Share');
 subtitle = `${t('Period:')} ${rData.startDate} ${t('to')} ${rData.endDate} | ${t('Net Profit:')} ${currencySymbol} ${rData.netProfit.toFixed(2)}`;
 columns = [t('Investor'), t('Profit %'), `${t('Share Amount')} (${currencySymbol})`];
 rows = (rData.investorShares || []).map((inv: any) => [inv.name, `${inv.profitPercentage}%`, `${currencySymbol} ${inv.shareAmount.toFixed(2)}`]);
 } else if (type === 'FiscalMonthClosingHistory' && rData) {
 title = t('Fiscal Month Closing History');
 columns = [t('Month'), t('Closed At'), `${t('Revenue')} (${currencySymbol})`, `${t('Expenses')} (${currencySymbol})`, `${t('Net Profit')} (${currencySymbol})`];
 rows = (rData.months || []).map((m: any) => [m.name, m.closedAt ? String(m.closedAt).split('T')[0] : '-', `${currencySymbol} ${Number(m.closedPnL?.totalRevenue || 0).toFixed(2)}`, `${currencySymbol} ${Number(m.closedPnL?.totalExpenses || 0).toFixed(2)}`, `${currencySymbol} ${Number(m.closedPnL?.netProfit || 0).toFixed(2)}`]);
 } else if (type === 'SalesRegister' && rData) {
 title = t('Sales Register');
 subtitle = `${t('Period:')} ${startDate || ''} ${t('to')} ${endDate || ''}`;
 columns = [t('Invoice #'), t('Date'), t('Customer'), t('Status'), t('Payment'), t('ZATCA'), `${t('Grand Total')} (${currencySymbol})`];
 rows = (rData.rows || []).map((r: any) => [r.invoiceNumber, r.date, r.customerName, t(r.status), t(r.paymentStatus), t(r.zatcaStatus), `${currencySymbol} ${r.grandTotal.toFixed(2)}`]);
 rows.push([t('Total'), '', '', '', '', '', `${currencySymbol} ${(rData.totalSales || 0).toFixed(2)}`]);
 } else if (type === 'ItemWiseSales' && rData) {
 title = t('Item-wise Sales Report');
 subtitle = `${t('Period:')} ${startDate || ''} ${t('to')} ${endDate || ''}`;
 columns = [t('Product'), t('Quantity Sold'), `${t('Revenue')} (${currencySymbol})`];
 rows = (rData.rows || []).map((r: any) => [r.name, String(r.quantity), `${currencySymbol} ${r.revenue.toFixed(2)}`]);
 rows.push([t('Total'), String(rData.totalQuantity || 0), `${currencySymbol} ${(rData.totalRevenue || 0).toFixed(2)}`]);
 } else if (type === 'CustomerStatement' && rData) {
 title = `${t('Customer Statement')}: ${rData.customerName || ''}`;
 columns = [t('Date'), t('Type'), t('Document #'), `${t('Invoiced')} (${currencySymbol})`, `${t('Received')} (${currencySymbol})`, `${t('Balance')} (${currencySymbol})`];
 rows = (rData.entries || []).map((e: any) => [e.date, t(e.type), e.docNumber, e.debit > 0 ? `${currencySymbol} ${e.debit.toFixed(2)}` : '-', e.credit > 0 ? `${currencySymbol} ${e.credit.toFixed(2)}` : '-', `${currencySymbol} ${e.runningBalance.toFixed(2)}`]);
 rows.push([t('Ending Balance'), '', '', '', '', `${currencySymbol} ${(rData.endingBalance || 0).toFixed(2)}`]);
 } else if (type === 'QuotationConversion' && rData) {
 title = t('Quotation Conversion Report');
 subtitle = `${t('Period:')} ${startDate || ''} ${t('to')} ${endDate || ''} | ${t('Conversion Rate:')} ${(rData.conversionRate || 0).toFixed(1)}%`;
 columns = [t('Quotation #'), t('Date'), t('Customer'), t('Status')];
 rows = (rData.rows || []).map((r: any) => [r.quotationNumber, r.date, r.customerName, t(r.status)]);
 } else if (type === 'SalesByStaff' && rData) {
 title = t('Sales by Staff');
 subtitle = `${t('Period:')} ${startDate || ''} ${t('to')} ${endDate || ''}`;
 columns = [t('Staff'), t('Invoices'), `${t('Revenue')} (${currencySymbol})`];
 rows = (rData.rows || []).map((r: any) => [r.username, String(r.invoiceCount), `${currencySymbol} ${r.revenue.toFixed(2)}`]);
 rows.push([t('Total'), '', `${currencySymbol} ${(rData.totalRevenue || 0).toFixed(2)}`]);
 } else if (type === 'PosShiftSummary' && rData) {
 title = t('POS Shift Summary');
 subtitle = `${t('Period:')} ${startDate || ''} ${t('to')} ${endDate || ''}`;
 columns = [t('Date'), t('Cashier'), t('Status'), `${t('Sales')} (${currencySymbol})`, `${t('Expected Cash')} (${currencySymbol})`, `${t('End Cash')} (${currencySymbol})`, `${t('Variance')} (${currencySymbol})`];
 rows = (rData.rows || []).map((r: any) => [r.date, r.cashier, t(r.status), `${currencySymbol} ${r.totalSales.toFixed(2)}`, `${currencySymbol} ${r.expectedCash.toFixed(2)}`, `${currencySymbol} ${r.endCash.toFixed(2)}`, `${currencySymbol} ${r.variance.toFixed(2)}`]);
 } else if (type === 'PurchaseRegister' && rData) {
 title = t('Purchase Register');
 subtitle = `${t('Period:')} ${startDate || ''} ${t('to')} ${endDate || ''}`;
 columns = [t('Expense #'), t('Date'), t('Vendor'), t('Classification'), t('Payment'), `${t('Amount')} (${currencySymbol})`];
 rows = (rData.rows || []).map((r: any) => [r.expenseNumber, r.date, r.vendorName, r.classification ? t(r.classification) : '', t(r.paymentStatus), `${currencySymbol} ${r.amount.toFixed(2)}`]);
 rows.push([t('Total'), '', '', '', '', `${currencySymbol} ${(rData.totalAmount || 0).toFixed(2)}`]);
 } else if (type === 'VendorStatement' && rData) {
 title = `${t('Vendor Statement')}: ${rData.vendorName || ''}`;
 columns = [t('Date'), t('Type'), t('Document #'), `${t('Billed')} (${currencySymbol})`, `${t('Paid')} (${currencySymbol})`, `${t('Balance')} (${currencySymbol})`];
 rows = (rData.entries || []).map((e: any) => [e.date, t(e.type), e.docNumber, e.debit > 0 ? `${currencySymbol} ${e.debit.toFixed(2)}` : '-', e.credit > 0 ? `${currencySymbol} ${e.credit.toFixed(2)}` : '-', `${currencySymbol} ${e.runningBalance.toFixed(2)}`]);
 rows.push([t('Ending Balance'), '', '', '', '', `${currencySymbol} ${(rData.endingBalance || 0).toFixed(2)}`]);
 } else if (type === 'PoStatus' && rData) {
 title = t('Purchase Order Status Report');
 subtitle = `${t('Period:')} ${startDate || ''} ${t('to')} ${endDate || ''}`;
 columns = [t('PO #'), t('Date'), t('Vendor'), t('Status'), t('Age (days)'), `${t('Total')} (${currencySymbol})`];
 rows = (rData.rows || []).map((r: any) => [r.poNumber, r.date, r.vendorName, t(r.status), r.ageDays !== null ? String(r.ageDays) : '-', `${currencySymbol} ${r.totalAmount.toFixed(2)}`]);
 rows.push([t('Total'), '', '', '', '', `${currencySymbol} ${(rData.totalAmount || 0).toFixed(2)}`]);
 } else if (type === 'GrnPoVariance' && rData) {
 title = t('GRN vs. PO Variance');
 subtitle = `${t('Period:')} ${startDate || ''} ${t('to')} ${endDate || ''}`;
 columns = [t('PO #'), t('Vendor'), t('Product'), t('Ordered'), t('Received'), t('Variance')];
 rows = (rData.rows || []).map((r: any) => [r.poNumber, r.vendorName, r.productName, String(r.ordered), String(r.received), String(r.variance)]);
 } else if (type === 'StockValuation' && rData) {
 title = t('Stock Valuation Report');
 columns = [t('Product'), t('Warehouse'), t('On Hand'), `${t('Unit Cost')} (${currencySymbol})`, `${t('Value')} (${currencySymbol})`];
 rows = (rData.rows || []).map((r: any) => [r.productName, r.warehouseName, String(r.quantity), `${currencySymbol} ${r.unitCost.toFixed(4)}`, `${currencySymbol} ${r.value.toFixed(2)}`]);
 rows.push([t('Total Stock Value'), '', '', '', `${currencySymbol} ${(rData.totalValue || 0).toFixed(2)}`]);
 } else if (type === 'ItemProfitability' && rData) {
 title = t('Item Profitability Report');
 columns = [t('Product'), t('Qty Sold'), `${t('Avg Cost')} (${currencySymbol})`, `${t('Avg Sale Price')} (${currencySymbol})`, `${t('Margin')} (${currencySymbol})`, t('Margin %')];
 rows = (rData.rows || []).map((r: any) => [r.productName, String(r.totalQuantitySold), `${currencySymbol} ${r.averageCost.toFixed(4)}`, `${currencySymbol} ${r.averageSalePrice.toFixed(4)}`, `${currencySymbol} ${r.marginAmount.toFixed(2)}`, `${r.marginPct.toFixed(1)}%`]);
 } else if (type === 'LowStock' && rData) {
 title = t('Low Stock / Reorder Report');
 columns = [t('Product'), t('Warehouse'), t('On Hand'), t('Min Level'), t('Shortfall')];
 rows = (rData.rows || []).map((r: any) => [r.productName, r.warehouseName, String(r.onHand), String(r.minLevel), String(r.shortfall)]);
 } else if (type === 'StockTakeVarianceHistory' && rData) {
 title = t('Stock Take Variance History');
 subtitle = `${t('Period:')} ${startDate || ''} ${t('to')} ${endDate || ''}`;
 columns = [t('Stock Take #'), t('Date'), t('Warehouse'), t('Product'), t('System Qty'), t('Counted Qty'), t('Variance')];
 rows = (rData.rows || []).map((r: any) => [r.referenceNumber, r.date, r.warehouseName, r.productName, String(r.systemQuantity), String(r.physicalQuantity), (r.variance > 0 ? '+' : '') + String(r.variance)]);
 } else if (type === 'StockMovementLedger' && rData) {
 title = t('Stock Movement Ledger');
 subtitle = `${t('Period:')} ${startDate || ''} ${t('to')} ${endDate || ''}`;
 const movementTypeLabels: Record<string, string> = { GRN: t('Goods Receipt'), Return: t('Purchase Return'), Sale: t('Sale'), Adjustment: t('Stock Adjustment'), StockTake: t('Stock Take') };
 columns = [t('Date'), t('Product'), t('Warehouse'), t('Type'), t('Batch'), t('Qty Change'), t('Ending Qty')];
 rows = (rData.rows || []).map((r: any) => [r.date.slice(0, 10), r.productName, r.warehouseName, movementTypeLabels[r.transactionType] || r.transactionType, r.batchNumber || '-', (r.quantityChange >= 0 ? '+' : '') + String(r.quantityChange), String(r.endingQuantity)]);
 } else {
 title = reportWrapper.title || title;
 subtitle = reportWrapper.subtitle || subtitle;
 columns = reportWrapper.columns || [];
 rows = reportWrapper.rows || [];
 }

 return (
 <div className="text-xs">
 <div className="border-b border-slate-200 pb-4 mb-4 flex justify-between items-end">
 <div>
 <h1 className="text-base font-bold text-slate-900">{companySetup.name}</h1>
 <p className="text-[10px] text-slate-500">{companySetup.address}</p>
 </div>
 <div className="text-end">
 <h2 className="text-lg font-bold text-slate-800 uppercase tracking-wider">{title}</h2>
 <p className="text-[10px] text-slate-500">{subtitle}</p>
 </div>
 </div>

 <div className="overflow-x-auto"><table className="w-full text-start min-w-[600px]">
 <thead>
 <tr className="bg-slate-100 text-slate-700 border-b border-slate-300">
 {columns.map((col, idx) => (
 <th key={idx} className="py-2 px-2 text-[10px] uppercase font-bold tracking-wider">{col}</th>
 ))}
 </tr>
 </thead>
 <tbody>
 {rows.length === 0 ? (
 <tr>
 <td colSpan={columns.length} className="py-6 text-center text-slate-400">
 {t('No records found for the active criteria.')}
 </td>
 </tr>
 ) : (
 rows.map((row, rIdx) => (
 <tr key={rIdx} className={`border-b border-slate-100 hover:bg-slate-50/50 ${
 rIdx === rows.length - 1 && (type === 'TrialBalance' || type === 'SalesVAT' || type === 'PurchaseVAT' || type === 'BankLedger')
 ? 'font-bold bg-slate-50 border-t-2 border-slate-200'
 : ''
 }`}>
 {row.map((cell, cIdx) => (
 <td key={cIdx} className="py-2 px-2 text-slate-700 max-w-xs truncate">{cell}</td>
 ))}
 </tr>
 ))
 )}
 </tbody>
 </table></div>
 </div>
 );
 };

 // Internal warehouse paperwork — never customer-facing, so this follows the fixed-layout
 // internal-document style (renderVoucher/renderPaymentReceipt above), not the bilingual
 // Canvas-Designer path Quotation/Invoice use. Each side's warehouse is shown alongside its
 // OWN branch (not the company's default) since a dispatch/receiving can legitimately span
 // two different branches — falling back to the company name only when a warehouse has no
 // branch assigned, same as every other branch-optional printout in this app.
 const renderWarehouseDispatch = (dispatch: any) => {
  const fromWh = db?.warehouses?.find(w => w.id === dispatch.fromWarehouseId);
  const toWh = db?.warehouses?.find(w => w.id === dispatch.toWarehouseId);
  const fromBranch = fromWh?.branchId ? (db as any)?.branches?.find((b: any) => b.id === fromWh.branchId) : undefined;
  const toBranch = toWh?.branchId ? (db as any)?.branches?.find((b: any) => b.id === toWh.branchId) : undefined;

  return (
   <div className="flex flex-col h-full justify-between text-xs">
    <div>
     <div className="flex justify-between items-start border-b border-slate-200 pb-6 mb-6">
      <div>
       <h1 className="text-xl font-bold text-slate-900">{companySetup.name}</h1>
       <p className="text-xs text-slate-500">{companySetup.address}</p>
      </div>
      <div className="text-end">
       <h2 className="text-xl font-bold uppercase text-indigo-700 tracking-wider mb-1">{t('Warehouse Dispatch Note')}</h2>
       <p className="text-slate-500"><span className="font-semibold">{t('Dispatch Number')}:</span> {dispatch.dispatchNumber}</p>
       <p className="text-slate-500"><span className="font-semibold">{t('Date')}:</span> {new Date(dispatch.date).toLocaleDateString()}</p>
      </div>
     </div>

     <div className="grid grid-cols-2 gap-6 mb-6">
      <div className="bg-slate-50 border border-slate-100 rounded-xl p-4">
       <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">{t('From')}</p>
       <p className="text-sm font-bold text-slate-900">{fromWh?.name || t('Unknown Warehouse')}</p>
       <p className="text-[11px] text-slate-500">{fromBranch?.name || companySetup.name}</p>
      </div>
      <div className="bg-slate-50 border border-slate-100 rounded-xl p-4">
       <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">{t('To')}</p>
       <p className="text-sm font-bold text-slate-900">{toWh?.name || t('Unknown Warehouse')}</p>
       <p className="text-[11px] text-slate-500">{toBranch?.name || companySetup.name}</p>
      </div>
     </div>

     <div className="grid grid-cols-2 gap-4 text-xs mb-6">
      <div>
       <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{t('Dispatched By')}</p>
       <p className="font-semibold text-slate-800">{dispatch.dispatchedBy}</p>
      </div>
      <div>
       <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{t('Status')}</p>
       <p className="font-semibold text-slate-800">{t(dispatch.status)}</p>
      </div>
      {dispatch.vehicleNumber && (
       <div>
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{t('Vehicle Number')}</p>
        <p className="font-semibold text-slate-800">{dispatch.vehicleNumber}</p>
       </div>
      )}
      {dispatch.driverName && (
       <div>
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{t('Driver Name')}</p>
        <p className="font-semibold text-slate-800">{dispatch.driverName}</p>
       </div>
      )}
      {dispatch.driverContact && (
       <div>
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{t('Driver Contact')}</p>
        <p className="font-semibold text-slate-800">{dispatch.driverContact}</p>
       </div>
      )}
      {dispatch.expectedArrivalDate && (
       <div>
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{t('Expected Arrival')}</p>
        <p className="font-semibold text-slate-800">{new Date(dispatch.expectedArrivalDate).toLocaleDateString()}</p>
       </div>
      )}
     </div>

     {dispatch.notes && (
      <div className="mb-6">
       <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">{t('Notes')}</p>
       <p className="text-[11px] text-slate-600 whitespace-pre-line">{dispatch.notes}</p>
      </div>
     )}

     <div className="overflow-x-auto"><table className="w-full text-xs min-w-[500px]">
      <thead>
       <tr className="bg-slate-100 text-slate-600">
        <th className="py-2 px-3 text-start">{t('Product')}</th>
        <th className="py-2 px-3 text-end">{t('Qty Dispatched')}</th>
        <th className="py-2 px-3 text-start">{t('Unit')}</th>
        <th className="py-2 px-3 text-start">{t('Batch / Expiry')}</th>
       </tr>
      </thead>
      <tbody>
       {(dispatch.items || []).map((item: any, idx: number) => {
        const prod = db?.products?.find(p => p.id === item.productId);
        const uom = item.unitOfMeasureId ? (db as any)?.unitsOfMeasure?.find((u: any) => u.id === item.unitOfMeasureId) : undefined;
        return (
         <tr key={idx} className="border-b border-slate-100">
          <td className="py-2 px-3 font-semibold text-slate-800">{prod?.name || t('Unknown Product')}</td>
          <td className="py-2 px-3 text-end font-bold text-indigo-700">{item.quantityDispatched}</td>
          <td className="py-2 px-3 text-slate-600">{uom?.name || t('Base Unit')}</td>
          <td className="py-2 px-3 text-slate-600 font-mono text-[11px]">
           {item.batchNumber || '-'}{item.expiryDate ? ` / ${new Date(item.expiryDate).toLocaleDateString()}` : ''}
          </td>
         </tr>
        );
       })}
      </tbody>
     </table></div>

     <div className="mt-8 grid grid-cols-2 gap-12 pt-8">
      <div className="text-center">
       <div className="border-b border-slate-300 w-36 mx-auto mb-2 h-10"></div>
       <p className="text-[10px] text-slate-400">{t('Dispatched By (Signature)')}</p>
      </div>
      <div className="text-center">
       <div className="border-b border-slate-300 w-36 mx-auto mb-2 h-10"></div>
       <p className="text-[10px] text-slate-400">{t('Driver Acknowledgment (Signature)')}</p>
      </div>
     </div>
    </div>

    {companySetup.customFooter && (
     <div className="footer-text mt-12 pt-4 border-t border-slate-200 text-center text-[10px] text-slate-400">
      {companySetup.customFooter}
     </div>
    )}
   </div>
  );
 };

 // The variance columns (dispatched vs. received) are the one thing this printout needs
 // that the Dispatch Note doesn't — the whole point of a Receiving Note is proving what
 // actually arrived versus what was sent.
 const renderWarehouseReceiving = (receiving: any) => {
  const dispatch = (db as any)?.warehouseDispatches?.find((d: any) => d.id === receiving.dispatchId);
  const fromWh = db?.warehouses?.find(w => w.id === dispatch?.fromWarehouseId);
  const toWh = db?.warehouses?.find(w => w.id === dispatch?.toWarehouseId);
  const fromBranch = fromWh?.branchId ? (db as any)?.branches?.find((b: any) => b.id === fromWh.branchId) : undefined;
  const toBranch = toWh?.branchId ? (db as any)?.branches?.find((b: any) => b.id === toWh.branchId) : undefined;

  return (
   <div className="flex flex-col h-full justify-between text-xs">
    <div>
     <div className="flex justify-between items-start border-b border-slate-200 pb-6 mb-6">
      <div>
       <h1 className="text-xl font-bold text-slate-900">{companySetup.name}</h1>
       <p className="text-xs text-slate-500">{companySetup.address}</p>
      </div>
      <div className="text-end">
       <h2 className="text-xl font-bold uppercase text-emerald-700 tracking-wider mb-1">{t('Warehouse Receiving Note')}</h2>
       <p className="text-slate-500"><span className="font-semibold">{t('Receiving Number')}:</span> {receiving.receivingNumber}</p>
       <p className="text-slate-500"><span className="font-semibold">{t('Date')}:</span> {new Date(receiving.date).toLocaleDateString()}</p>
       <p className="text-slate-500"><span className="font-semibold">{t('Dispatch #:')}</span> {dispatch?.dispatchNumber || '-'}</p>
      </div>
     </div>

     {/* Destination shown first (this is a receiving document, primarily this side's
         record), source second for traceability — per the approved plan. */}
     <div className="grid grid-cols-2 gap-6 mb-6">
      <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-4">
       <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 mb-1">{t('Received At')}</p>
       <p className="text-sm font-bold text-slate-900">{toWh?.name || t('Unknown Warehouse')}</p>
       <p className="text-[11px] text-slate-500">{toBranch?.name || companySetup.name}</p>
      </div>
      <div className="bg-slate-50 border border-slate-100 rounded-xl p-4">
       <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">{t('Dispatched From')}</p>
       <p className="text-sm font-bold text-slate-900">{fromWh?.name || t('Unknown Warehouse')}</p>
       <p className="text-[11px] text-slate-500">{fromBranch?.name || companySetup.name}</p>
      </div>
     </div>

     <div className="grid grid-cols-2 gap-4 text-xs mb-6">
      <div>
       <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{t('Received By')}</p>
       <p className="font-semibold text-slate-800">{receiving.receivedBy}</p>
      </div>
      {receiving.condition && (
       <div>
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{t('Condition')}</p>
        <p className="font-semibold text-slate-800">{receiving.condition}</p>
       </div>
      )}
     </div>

     {receiving.discrepancyNotes && (
      <div className="mb-4 bg-amber-50 border border-amber-100 rounded-xl p-3">
       <p className="text-[10px] font-bold uppercase tracking-wider text-amber-700 mb-1">{t('Discrepancy Notes')}</p>
       <p className="text-[11px] text-amber-900 whitespace-pre-line">{receiving.discrepancyNotes}</p>
      </div>
     )}

     {receiving.notes && (
      <div className="mb-6">
       <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">{t('Notes')}</p>
       <p className="text-[11px] text-slate-600 whitespace-pre-line">{receiving.notes}</p>
      </div>
     )}

     <div className="overflow-x-auto"><table className="w-full text-xs min-w-[500px]">
      <thead>
       <tr className="bg-slate-100 text-slate-600">
        <th className="py-2 px-3 text-start">{t('Product')}</th>
        <th className="py-2 px-3 text-end">{t('Qty Dispatched')}</th>
        <th className="py-2 px-3 text-end">{t('Qty Received')}</th>
        <th className="py-2 px-3 text-end">{t('Variance')}</th>
        <th className="py-2 px-3 text-start">{t('Batch')}</th>
       </tr>
      </thead>
      <tbody>
       {(receiving.items || []).map((item: any, idx: number) => {
        const dispatchItem = (dispatch?.items || []).find((di: any) => di.id === item.dispatchItemId);
        const prod = db?.products?.find(p => p.id === item.productId);
        const qtyDispatched = dispatchItem?.quantityDispatched ?? 0;
        const variance = item.quantityReceived - qtyDispatched;
        return (
         <tr key={idx} className="border-b border-slate-100">
          <td className="py-2 px-3 font-semibold text-slate-800">{prod?.name || t('Unknown Product')}</td>
          <td className="py-2 px-3 text-end text-slate-600">{qtyDispatched}</td>
          <td className="py-2 px-3 text-end font-bold text-emerald-700">{item.quantityReceived}</td>
          <td className={`py-2 px-3 text-end font-bold ${variance === 0 ? 'text-slate-400' : variance < 0 ? 'text-rose-600' : 'text-amber-600'}`}>
           {variance > 0 ? `+${variance}` : variance}
          </td>
          <td className="py-2 px-3 text-slate-600 font-mono text-[11px]">{item.batchNumber || '-'}</td>
         </tr>
        );
       })}
      </tbody>
     </table></div>

     <div className="mt-8 grid grid-cols-2 gap-12 pt-8">
      <div className="text-center">
       <div className="border-b border-slate-300 w-36 mx-auto mb-2 h-10"></div>
       <p className="text-[10px] text-slate-400">{t('Received By (Signature)')}</p>
      </div>
      <div className="text-center">
       <div className="border-b border-slate-300 w-36 mx-auto mb-2 h-10"></div>
       <p className="text-[10px] text-slate-400">{t('Warehouse Supervisor (Signature)')}</p>
      </div>
     </div>
    </div>

    {companySetup.customFooter && (
     <div className="footer-text mt-12 pt-4 border-t border-slate-200 text-center text-[10px] text-slate-400">
      {companySetup.customFooter}
     </div>
    )}
   </div>
  );
 };

 const renderDocumentBody = () => {
 switch (documentType) {
 case 'Quotation':
 case 'Invoice':
 return renderQuotationOrInvoice(data);
 case 'Expense':
 return renderExpense(data);
 case 'Voucher':
 return renderVoucher(data);
 case 'PaymentReceipt':
 return renderPaymentReceipt(data);
 case 'Ledger':
 return renderLedger(data);
 case 'Report':
 return renderReport(data);
 case 'WarehouseDispatch':
 return renderWarehouseDispatch(data);
 case 'WarehouseReceiving':
 return renderWarehouseReceiving(data);
 default:
 return <div className="text-center p-8 text-rose-500"><AlertCircle className="mx-auto mb-2" /> Unsupported Document Type</div>;
 }
 };

 // The actual paper/page content — identical whether rendered standalone in the full
 // modal or embedded inline in the Canvas Designer's live preview. Extracting this means
 // there is only ever ONE rendering code path for what an invoice/quotation looks like;
 // the Designer's preview can never drift from the real thing the way the old separate
 // mockup canvas did.
 const paperContent = (
 <div className="p-3 md:p-5 bg-slate-100/50 overflow-x-auto print:p-0 w-full flex justify-center">
 <div style={{ zoom: zoomLevel }} className="print:!zoom-100">
            <div
              ref={printableRef}
              id="printable-document-content"
 className={`bg-white shadow-lg border border-slate-200/60 p-8 md:p-12 text-slate-800 print:min-w-0 print:w-full print:p-0 md:mx-auto overflow-hidden ${isRTL ? '' : theme.accentFont} ${getPageSizeClass()}`}
 // Arabic/Urdu documents always render in the bilingual-capable Cairo/Noto stack
 // (--font-arabic, index.css) regardless of the template's own Latin accent font
 // (Space Grotesk, JetBrains Mono, etc.) — none of those have real Arabic glyph
 // coverage, so honoring them here would just mean an inconsistent OS-fallback
 // font for every Arabic character on the page. Inline style (not a Tailwind
 // class) so it reliably wins regardless of class ordering/specificity.
 style={{ direction: dir, fontFamily: isRTL ? 'var(--font-arabic, "Cairo", "Inter", sans-serif)' : undefined }}
 >
 {renderDocumentBody()}
            </div>
          </div>
        </div>
 );

 if (embedded) {
 return paperContent;
 }

 return (
 <div className="fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-sm flex justify-center items-start overflow-y-auto p-4 md:p-8">
 <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 flex flex-col w-full max-w-5xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">

 {/* Controls Bar */}
 <div className="bg-slate-50 border-b border-slate-100 px-5 py-3 flex flex-wrap justify-between items-center gap-4 no-print">
 <div className="flex items-center gap-2.5">
 <div className="w-9 h-9 bg-indigo-50 text-indigo-600 rounded-lg flex items-center justify-center">
 <FileText className="w-5 h-5" />
 </div>
 <div>
 <h2 className="text-sm font-bold text-slate-900">Document Print Engine</h2>
 <p className="text-[11px] text-slate-400">Bilingual translations & page configuration</p>
 </div>
 </div>

 <div className="flex items-center gap-2">
 {/* Template Selector for invoices and quotations */}
 {(documentType === 'Quotation' || documentType === 'Invoice') && (
 <div className="flex items-center gap-1.5 me-2">
 <Globe className="w-3.5 h-3.5 text-slate-400" />
 <select
 value={selectedTemplateId}
 onChange={(e) => setSelectedTemplateId(e.target.value)}
 className="bg-white border border-slate-200 rounded-lg px-2.5 py-1 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-500"
 >
 {companyTemplates.map(tmpl => (
 <option key={tmpl.id} value={tmpl.id}>
 {tmpl.name} ({tmpl.pageSize}) {tmpl.isActive ? '⭐' : ''}
 </option>
 ))}
 </select>
 </div>
 )}

 {/* PDF download and signed-XML download both live in the dedicated Invoice View
 screen now (Download PDF, View signed XML) — this toolbar keeps only Print
 itself, so the two entry points don't duplicate each other. */}
 <button
 onClick={handlePrint}
 className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold transition"
 id="btn-print-doc"
 >
 <Printer className="w-3.5 h-3.5" />
 <span>Print</span>
 </button>

 <button
 onClick={onClose}
 className="p-1.5 hover:bg-slate-200 text-slate-400 hover:text-slate-600 rounded-lg transition"
 >
 <X className="w-4 h-4" />
 </button>
 </div>
 </div>

 {paperContent}
 </div>
 </div>
 );
}
