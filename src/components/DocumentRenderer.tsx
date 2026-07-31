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
import { ensureCompatibleImage } from '../imageUtils';
import { DEFAULT_DOCUMENT_LAYOUT } from '../documentTemplateDefaults';

interface DocumentRendererProps {
 documentType: 'Quotation' | 'Invoice' | 'Expense' | 'Voucher' | 'Ledger' | 'Report';
 data: any; // Can be Quotation, Invoice, Expense, Voucher, or Ledger/Report data
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
 embedded = false
}: DocumentRendererProps) {
 // Find active template or default
 const companyTemplates = React.useMemo(() => {
   const filtered = templates.filter(t => t.companyId === companySetup?.id);
   return filtered.length > 0 ? filtered : templates;
 }, [templates, companySetup?.id]);

 const activeTemplate = companyTemplates.find(t => t.isActive) || companyTemplates[0];
 const [selectedTemplateId, setSelectedTemplateId] = React.useState<string>(activeTemplate?.id || '');
 
 const currentTemplate = companyTemplates.find(t => t.id === selectedTemplateId) || activeTemplate;
 const isBilingualDoc = documentType === 'Quotation' || documentType === 'Invoice';
 const isArabic = currentTemplate?.language === 'Arabic' && isBilingualDoc;
 const isUrdu = currentTemplate?.language === 'Urdu' && isBilingualDoc;
 const isRTL = isArabic || isUrdu;
 const dir = isRTL ? 'rtl' : 'ltr';

 const t = (key: string): string => {
 if (isUrdu) return URDU_TRANSLATIONS[key] || key;
 if (isArabic) return TRANSLATIONS[key] || key;
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
      const isThermal = currentTemplate?.pageSize?.includes('4in x 6in');
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

 // Handle page sizing styling. min-height is print-only (`print:min-h-*`) — a real
 // printed page should be full paper height even when content is short, but forcing
 // that same ~11in minimum on the on-screen PREVIEW card made a short, few-line
 // invoice render inside a mostly-empty full-page-height box, reading as a large
 // block of wasted white space below the actual content on screen. The preview now
 // sizes to its actual content; only the physical print output keeps the full page.
 const getPageSizeClass = () => {
 if (documentType === 'Expense' || documentType === 'Ledger' || documentType === 'Report') {
 return 'w-full min-w-[760px] max-w-4xl print:min-h-[11in]'; // Standard report size
 }
 const size = currentTemplate?.pageSize || '8.27in x 11.69in';
 if (size.includes('4in x 6in')) {
 return 'w-[4in] print:min-h-[6in] text-xs';
 }
 return 'w-full min-w-[760px] max-w-4xl print:min-h-[11in]'; // A4/Letter size
 };

 // Trigger browser print of the document container
 const handlePrint = () => {
 const printContent = document.getElementById('printable-document-content');
 if (!printContent) return;

 const printWindow = window.open('', '', 'height=800,width=1000');
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
 chrome, physical paper size/margins, thermal-receipt scaling, and the Arabic
 font import for browsers/print drivers that skip @import inside a cloned
 <style> tag. --font-arabic itself (index.css) IS cloned above, so this import
 is a belt-and-braces fallback, not the primary source. */
 @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700&display=swap');
 html, body {
 margin: 0;
 padding: 20px;
 color: #1e293b;
 direction: ${dir};
 background-color: white;
 }
 @media print {
 body { padding: 0; margin: 0; width: 100%; }
 .no-print { display: none !important; }
 @page {
 size: ${currentTemplate?.pageSize?.includes('4in x 6in') ? '4in 6in' : 'A4 portrait'};
 margin: ${currentTemplate?.pageSize?.includes('4in x 6in') ? '0.1in' : '0.4in'};
 }
 /* Scale down for small thermal receipt paper */
 ${currentTemplate?.pageSize?.includes('4in x 6in') ? `
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
 window.print();
 setTimeout(function() { window.close(); }, 500);
 };
 </script>
 </body>
 </html>
 `);
 printWindow.document.close();
 };

 const renderQuotationOrInvoice = (doc: Quotation | Invoice) => {
  const isInvoice = 'invoiceNumber' in doc;
  const docNum = isInvoice ? (doc as Invoice).invoiceNumber : (doc as Quotation).quotationNumber;
  const notes = doc.notes;
  const items = doc.items || [];

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
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(qrDataStr)}`;

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
      case 'sans':
      default:
        return 'font-sans';
    }
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
    if (block.props?.fontFamily) {
      const fFamily = block.props.fontFamily;
      if (fFamily === 'sans') classes.push('font-sans');
      else if (fFamily === 'serif') classes.push('font-serif');
      else if (fFamily === 'display') classes.push('font-display');
      else if (fFamily === 'mono') classes.push('font-mono');
    }
    return classes.join(' ');
  };

  const activeBlocks = parsedLayout.filter(b => b.visible !== false);

  return (
   <div className={`flex flex-col h-full justify-between ${getGlobalFontClass()}`} id="printable-inner">
    <div className={`grid grid-cols-12 gap-x-4 ${getGridGapClass()}`}>
     {activeBlocks.map((block) => {
      const blockColClass = `col-span-12 md:col-span-${block.w}`;

      if (block.id === 'logo') {
       if (currentTemplate?.printLogo === false) return null;
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
           className="company-logo mb-2 max-h-16 max-w-[180px] w-auto h-auto object-contain"
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
       if (currentTemplate?.printHeader === false) return null;
       const showAddress = block.props?.showAddress !== false;
       const showVat = block.props?.showVat !== false;
       const isBilingual = block.props?.isBilingual !== false;
       return (
        <div key={block.id} className={`${blockColClass} text-slate-800 ${getBlockTypographyClasses(block)}`} style={getBlockStyle(block)}>
         <h1 className={`text-xl font-bold ${theme.primaryText}`}>
          {companySetup.name}
          {isBilingual && (
           <span className="block text-[11px] font-medium text-slate-400 mt-0.5">اسم البائع / {companySetup.name}</span>
          )}
         </h1>
         {showAddress && (
          <p className="text-xs text-slate-500 whitespace-pre-line leading-relaxed max-w-sm mt-1">{companySetup.address}</p>
         )}
         <p className="text-xs text-slate-500 mt-0.5">{t('Phone')}: {companySetup.phone} | {t('Email')}: {companySetup.email}</p>
         {showVat && companySetup.vatNumber && (
          <p className={`text-xs font-semibold mt-0.5 ${theme.accentText}`}>
           VAT Reg: <span className="font-mono">{companySetup.vatNumber}</span>
           {isBilingual && (
            <span className="ms-1 font-normal text-slate-400 text-[10px]">(الرقم الضريبي)</span>
           )}
          </p>
         )}
        </div>
       );
      }

      if (block.id === 'doc_details') {
       const isBilingual = block.props?.isBilingual !== false;
       const showPaymentStatus = block.props?.showPaymentStatus !== false;
       const showOriginQ = block.props?.showOriginQ !== false;
       return (
        <div key={block.id} className={`${blockColClass} text-${dir === 'rtl' ? 'left' : 'right'} max-w-xs md:ms-auto ${getBlockTypographyClasses(block)}`} style={getBlockStyle(block)}>
         <h2 className={`text-2xl font-bold uppercase tracking-wider ${noteAccentText} mb-1`}>
          {isCreditNote ? t('Credit Note') : isDebitNote ? t('Debit Note') : isInvoice ? t('Invoice') : t('Quotation')}
          {isBilingual && (
           <span className="block text-sm font-semibold text-slate-400 mt-0.5">
            {isCreditNote ? 'إشعار دائن' : isDebitNote ? 'إشعار مدين' : isInvoice ? 'فاتورة مبيعات' : 'عرض سعر'}
           </span>
          )}
          {(isCreditNote || isDebitNote) && (
           <span className={`inline-block mt-1.5 px-2 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider normal-case ${noteBadgeClass}`}>
            {isCreditNote ? 'Adjustment — reduces original invoice' : 'Adjustment — increases original invoice'}
           </span>
          )}
         </h2>
         <div className="text-xs text-slate-500 space-y-1">
          <p>
           <span className="font-semibold text-slate-700">
            {isInvoice ? t('Invoice Number') : t('Quotation Number')}:
           </span>{' '}
           {docNum}
           {isBilingual && (
            <span className="block text-[9px] text-slate-400">
             {isInvoice ? 'رقم الفاتورة' : 'رقم عرض السعر'}
            </span>
           )}
          </p>
          <p>
           <span className="font-semibold text-slate-700">{t('Date')}:</span> {doc.date}
           {isBilingual && <span className="block text-[9px] text-slate-400">التاريخ</span>}
          </p>
          {(isCreditNote || isDebitNote) && (
           <p className={`font-semibold ${noteAccentText}`}>
            <span>Ref: {originalInvoice ? originalInvoice.invoiceNumber : (originalInvoiceId || '—')}</span>
            {isBilingual && (
             <span className="block text-[9px] text-slate-400 font-normal">{t('Reference Invoice')}</span>
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
          {isInvoice && (doc as Invoice).paymentStatus === 'Paid' && (
           <p><span className="font-semibold text-emerald-600 font-bold">{t('Payment Date')}:</span> {(doc as Invoice).paymentDate}</p>
          )}
          <p>
           <span className="font-semibold text-slate-700">{t('Status')}:</span>{' '}
           <span className={`px-1.5 py-0.5 rounded font-semibold ${
            doc.status === 'Cancelled' ? 'bg-rose-100 text-rose-800' :
            doc.status === 'Converted' ? 'bg-cyan-100 text-cyan-800' :
            doc.status === 'Accepted' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-800'
           }`}>
            {t(doc.status)}
           </span>
          </p>
          {isInvoice && showPaymentStatus && (
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
       
       let cardClass = "p-4 rounded-2xl bg-white text-xs ";
       if (borderStyle === 'solid') cardClass += "border border-slate-150 shadow-sm";
       else if (borderStyle === 'dashed') cardClass += "border border-dashed border-slate-350";
       else cardClass += "p-0";

       return (
        <div key={block.id} className={`${blockColClass} ${getBlockTypographyClasses(block)}`} style={getBlockStyle(block)}>
         <div className={cardClass}>
          <div className="flex justify-between items-center pb-1.5 mb-2 border-b border-slate-100">
           <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{t('Customer')}</h3>
           {isBilingual && (
            <span className="text-[10px] font-bold text-slate-400">العميل / Buyer</span>
           )}
          </div>
          {data.customerData ? (
           <div className="text-xs text-slate-700 space-y-1">
            <p className="font-semibold text-slate-900 text-sm">{data.customerData.name}</p>
            {showContact && data.customerData.phone !== '-' && <p>{t('Phone')}: {data.customerData.phone}</p>}
            {showContact && data.customerData.email !== '-' && <p>{t('Email')}: {data.customerData.email}</p>}
            {showAddress && data.customerData.address !== '-' && <p>{t('Address')}: {data.customerData.address}</p>}
            {/* ZATCA's data dictionary marks Buyer VAT (BT-48) Mandatory for Standard
                (B2B) invoices — it was already correctly written into the XML, but
                never shown on the human-readable printed document itself. */}
            {data.customerData.vatNumber && (
             <p className="font-semibold">
              {t('VAT Reg')}: <span className="font-mono">{data.customerData.vatNumber}</span>
              {isBilingual && <span className="ms-1 font-normal text-slate-400 text-[10px]">(الرقم الضريبي للعميل)</span>}
             </p>
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
       return (
        <div key={block.id} className={`${blockColClass} ${getBlockTypographyClasses(block)}`} style={getBlockStyle(block)}>
         <div className="p-3.5 bg-slate-50/50 rounded-xl text-xs text-slate-600 border border-slate-100 whitespace-pre-line">
          {companySetup.customHeader}
         </div>
        </div>
       );
      }

      if (block.id === 'items_table') {
       const isBilingual = block.props?.isBilingual !== false;
       const showSNo = block.props?.showSNo !== false;
       const rowStyle = block.props?.borderStyle || 'stripe';
       // getItemTaxRate is shared/hoisted above (also used by the totals_summary
       // block's multi-rate breakdown) — previously the printed table showed no rate
       // at all, so a mixed-rate invoice (a real, tested scenario this session) gave a
       // customer no way to see which line was taxed at which rate.

       return (
        <div key={block.id} className={`${blockColClass} overflow-x-auto ${getBlockTypographyClasses(block)}`} style={getBlockStyle(block)}>
         <table className="w-full text-xs border-collapse min-w-[500px]">
          <thead>
           <tr className={theme.tableHeaderClass}>
            {showSNo && <th className="py-2.5 px-3 font-semibold text-center w-12 whitespace-nowrap">{t('S.No')}</th>}
            <th className={`py-2.5 px-3 font-semibold ${isRTL ? 'text-end' : 'text-start'}`}>
             {t('Description')}
             {isBilingual && <span className="block text-[10px] font-normal text-slate-200 mt-0.5">الوصف / البند</span>}
            </th>
            <th className="py-2.5 px-3 font-semibold text-center w-24 whitespace-nowrap">
             {t('Unit Cost')}
             {isBilingual && <span className="block text-[10px] font-normal text-slate-200 mt-0.5">سعر الوحدة</span>}
            </th>
            <th className="py-2.5 px-3 font-semibold text-center w-20 whitespace-nowrap">
             {t('Quantity')}
             {isBilingual && <span className="block text-[10px] font-normal text-slate-200 mt-0.5">الكمية</span>}
            </th>
            <th className="py-2.5 px-3 font-semibold text-center w-16 whitespace-nowrap">
             {t('VAT %')}
             {isBilingual && <span className="block text-[10px] font-normal text-slate-200 mt-0.5">نسبة الضريبة</span>}
            </th>
            <th className={`py-2.5 px-3 font-semibold w-24 whitespace-nowrap ${isRTL ? 'text-start' : 'text-end'}`}>
             {t('Total')}
             {isBilingual && <span className="block text-[10px] font-normal text-slate-200 mt-0.5">الإجمالي</span>}
            </th>
           </tr>
          </thead>
          <tbody>
           {items.map((item: any, idx: number) => {
            const itemNetCost = Math.max(0, (item.unitCost || 0) - (item.discountAmount || 0));
            const stripeClass = rowStyle === 'stripe' && idx % 2 === 1 ? 'bg-slate-50/40' : '';
            const itemRate = getItemTaxRate(item);
            return (
             <tr key={item.id} className={`border-b border-slate-100 ${stripeClass}`}>
              {showSNo && <td className="py-2.5 px-3 text-center text-slate-500 w-12 whitespace-nowrap">{idx + 1}</td>}
              <td className={`py-2.5 px-3 text-slate-800 font-medium ${isRTL ? 'text-end' : 'text-start'}`}>
               <div>{item.description}</div>
               {item.discountAmount > 0 && block.props?.showDiscount !== false && (
                <div className="text-[10px] text-rose-500 font-semibold">
                 Discounted -{fmt(item.discountAmount)} per unit
                </div>
               )}
              </td>
              <td className="py-2.5 px-3 text-center text-slate-600 w-24 whitespace-nowrap">
               {item.discountAmount > 0 ? (
                <span>
                 <span className="line-through text-slate-400 me-1">{fmt(item.unitCost)}</span>
                 <span className="font-bold text-slate-700">{fmt(itemNetCost)}</span>
                </span>
               ) : (
                fmt(item.unitCost)
               )}
              </td>
              <td className="py-2.5 px-3 text-center text-slate-600 w-20 whitespace-nowrap">{item.quantity}</td>
              <td className="py-2.5 px-3 text-center text-slate-600 w-16 whitespace-nowrap">{itemRate}%</td>
              <td className={`py-2.5 px-3 text-slate-800 font-semibold w-24 whitespace-nowrap ${isRTL ? 'text-start' : 'text-end'}`}>{fmt(itemNetCost * item.quantity)}</td>
             </tr>
            );
           })}
          </tbody>
         </table>
        </div>
       );
      }

      if (block.id === 'notes') {
       if (!notes) return null;
       const isBilingual = block.props?.isBilingual === true;
       return (
        <div key={block.id} className={`${blockColClass} ${getBlockTypographyClasses(block)}`} style={getBlockStyle(block)}>
         <div className="border border-slate-150 rounded-xl p-3.5 bg-slate-50/40">
          <h4 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
           {t('Notes')}
           {isBilingual && <span className="ms-1.5 text-[9px] text-slate-400">الشروط والأحكام</span>}
          </h4>
          <p className="text-xs text-slate-600 leading-relaxed whitespace-pre-line">{notes}</p>
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
       if (!isInvoice) return null;
       if (currentTemplate?.printQrCode === false) return null;
       const alignClass = block.props?.align === 'right' ? 'justify-end' : block.props?.align === 'left' ? 'justify-start' : 'justify-center';
       const isBilingual = block.props?.isBilingual !== false;
       const size = block.props?.size || 'medium';
       const sizeClass = size === 'small' ? 'w-12 h-12' : size === 'large' ? 'w-24 h-24' : 'w-20 h-20';
       
       return (
        <div key={block.id} className={`${blockColClass} flex ${alignClass} items-center ${getBlockTypographyClasses(block)}`} style={getBlockStyle(block)}>
         <div className="flex flex-col items-center justify-center p-2.5 bg-white rounded-xl border border-slate-150 shadow-sm shrink-0">
          <img src={qrCodeUrl} alt="ZATCA QR Verification" className={sizeClass} referrerPolicy="no-referrer" />
          <span className={`text-[8px] font-bold uppercase tracking-wider mt-1 whitespace-nowrap ${isZatcaConfirmed ? 'text-slate-400' : 'text-amber-500'}`}>
           {isZatcaConfirmed
            ? (isBilingual ? `${docZatcaStatus === 'CLEARED' ? 'Cleared' : 'Reported'} / ${docZatcaStatus === 'CLEARED' ? 'تم التخليص' : 'تم الإبلاغ'}` : (docZatcaStatus === 'CLEARED' ? 'Cleared' : 'Reported'))
            : (isBilingual ? 'Not Yet Cleared / قيد الانتظار' : 'Not Yet Cleared')}
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

       let totalAccentText = "text-indigo-600";
       if (accentColor === 'emerald') totalAccentText = "text-emerald-600";
       else if (accentColor === 'slate') totalAccentText = "text-slate-700";
       else if (accentColor === 'amber') totalAccentText = "text-amber-600";
       else if (accentColor === 'blue') totalAccentText = "text-blue-600";

       return (
        <div key={block.id} className={`${blockColClass} ${getBlockTypographyClasses(block)}`} style={getBlockStyle(block)}>
         <div className="space-y-1.5 border border-slate-100 p-4 rounded-xl bg-slate-50 md:ms-auto w-full max-w-sm">
         <div className="flex justify-between text-xs text-slate-600">
          <span className="whitespace-nowrap">
           {t('Subtotal')}:
           {isBilingual && <span className="block text-[8px] text-slate-400">المجموع الفرعي</span>}
          </span>
          <span className="font-medium whitespace-nowrap font-mono">{fmt(totals.subtotal)}</span>
         </div>

         {totals.discountAmount > 0 && (
          <div className="flex justify-between text-xs text-rose-600 font-bold">
           <span className="whitespace-nowrap">
            Total Discount:
            {isBilingual && <span className="block text-[8px] text-rose-400">مجموع الخصومات</span>}
           </span>
           <span className="whitespace-nowrap font-mono">-{fmt(totals.discountAmount)}</span>
          </div>
         )}

         {totals.discountAmount > 0 && (
          <div className="flex justify-between text-xs text-slate-700 font-semibold border-t border-slate-100 pt-1">
           <span className="whitespace-nowrap">
            Net Subtotal:
            {isBilingual && <span className="block text-[8px] text-slate-400">صافي الفرعي</span>}
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
             {isBilingual && <span className="block text-[8px] text-slate-400">ضريبة القيمة المضافة</span>}
            </span>
            <span className="font-medium whitespace-nowrap font-mono">{fmt(Number(group.taxAmount.toFixed(2)))}</span>
           </div>
          ))
         ) : totals.percentage > 0 && (
          <div className="flex justify-between text-xs text-slate-600">
           <span className="whitespace-nowrap">
            {t('VAT')} ({totals.percentage}%):
            {isBilingual && <span className="block text-[8px] text-slate-400">ضريبة القيمة المضافة</span>}
           </span>
           <span className="font-medium whitespace-nowrap font-mono">{fmt(totals.taxAmount)}</span>
          </div>
         )}

                   <div className="flex justify-between text-sm font-bold text-slate-900 border-t border-slate-200 pt-2 mt-1">
           <span className="whitespace-nowrap">
            {t('Grand Total')}:
            {isBilingual && <span className="block text-[9px] text-slate-400">الإجمالي الكلي</span>}
           </span>
           <span className={`${totalAccentText} text-base whitespace-nowrap font-mono font-bold`}>{fmt(totals.grandTotal)}</span>
          </div>
         </div>
        </div>
       );
      }

       if (block.id === 'custom_footer') {
        if (currentTemplate?.printFooter === false || !companySetup.customFooter) return null;
        return (
         <div key={block.id} className={`col-span-12 footer-text mt-6 pt-4 border-t border-slate-200 text-center text-[10px] text-slate-400 whitespace-pre-line ${getBlockTypographyClasses(block)}`} style={getBlockStyle(block)}>
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

        return (
         <div key={block.id} className={`${blockColClass} ${alignClass} ${getBlockTypographyClasses(block)}`} style={getBlockStyle(block)}>
          <div className="p-2.5 rounded-xl border border-slate-150 bg-slate-50/50 space-y-0.5">
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
      })}
     </div>
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

 <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4 mb-6">
 <div className="flex justify-between items-center mb-2">
 <span className="text-xs font-semibold uppercase tracking-wider text-indigo-600">Total Voucher Amount</span>
 <span className="text-xl font-black text-indigo-900">{fmt(vch.amount)}</span>
 </div>
 <p className="text-[11px] text-indigo-800 leading-relaxed">
 <span className="font-bold">Description:</span> {vch.description}
 </p>
 </div>

 <div className="overflow-x-auto"><table className="w-full text-xs min-w-[500px]">
 <thead>
 <tr className="bg-slate-100 text-slate-600">
 <th className="py-2 px-3 text-start">Account Affected</th>
 <th className="py-2 px-3 text-start">Reference Source</th>
 <th className="py-2 px-3 text-start">Document ID</th>
 <th className="py-2 px-3 text-end">Debit (Inflow)</th>
 <th className="py-2 px-3 text-end">Credit (Outflow)</th>
 </tr>
 </thead>
 <tbody>
 <tr>
 <td className="py-3 px-3 font-semibold text-slate-800">
 🏦 {data.bankData?.bankName || 'Bank Ledger Account'}
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
 return <span>{vch.referenceId}</span>;
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
 <p className="text-[10px] text-slate-400">Authorized Signature</p>
 </div>
 <div className="text-center">
 <div className="border-b border-slate-300 w-36 mx-auto mb-2 h-10"></div>
 <p className="text-[10px] text-slate-400">Receiver Signature</p>
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
 <p className="text-[10px] text-slate-500">Bank Statement Report</p>
 </div>
 <div className="text-end">
 <h2 className="text-lg font-bold text-indigo-700">BANK ACCOUNT LEDGER</h2>
 <p className="text-[11px] font-bold text-slate-800">{ledgerData.bank.bankName}</p>
 <p className="text-[10px] text-slate-500">A/C Title: {ledgerData.bank.accountTitle} | No: {ledgerData.bank.accountNumber}</p>
 </div>
 </div>

 <div className="overflow-x-auto"><table className="w-full text-start text-[11px] min-w-[600px]">
 <thead>
 <tr className="bg-slate-100 text-slate-700 border-b border-slate-300">
 <th className="py-2 px-2">Date</th>
 <th className="py-2 px-2">Voucher No</th>
 <th className="py-2 px-2">Type</th>
 <th className="py-2 px-2">Description</th>
 <th className="py-2 px-2 text-end">Debit (Receipts)</th>
 <th className="py-2 px-2 text-end">Credit (Payments)</th>
 <th className="py-2 px-2 text-end">Running Balance</th>
 </tr>
 </thead>
 <tbody>
 <tr className="border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
 <td className="py-2 px-2">-</td>
 <td className="py-2 px-2">-</td>
 <td className="py-2 px-2">OPENING</td>
 <td className="py-2 px-2">Account Initial Setup Balance</td>
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
 {entry.type}
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
 let title = 'Financial Report';
 let subtitle = '';
 let columns: string[] = [];
 let rows: any[][] = [];

 if (!reportWrapper) {
 return (
 <div className="text-center py-6 text-rose-500">
 No report data provided.
 </div>
 );
 }

 const { type, startDate, endDate, data: rData } = reportWrapper;
 subtitle = `Period: ${startDate || ''} to ${endDate || ''}`;

 if (type === 'TrialBalance' && rData) {
 title = 'Trial Balance Sheet (Dual-Ledger)';
 columns = ['Ledger Chart Account Head', `Debit (${currencySymbol})`, `Credit (${currencySymbol})`];
 const ledgers = rData.ledgers || [];
 rows = ledgers.map((l: any) => [
 l.name,
 l.debit > 0 ? `${currencySymbol} ${l.debit.toFixed(2)}` : '-',
 l.credit > 0 ? `${currencySymbol} ${l.credit.toFixed(2)}` : '-'
 ]);
 rows.push([
 'Balanced Sum Total:',
 `${currencySymbol} ${(rData.totalDebits || 0).toFixed(2)}`,
 `${currencySymbol} ${(rData.totalCredits || 0).toFixed(2)}`
 ]);
 } else if (type === 'SalesVAT' && Array.isArray(rData)) {
 title = 'Sales VAT Register (Output Tax)';
 columns = ['Invoice No', 'Date', 'Customer Name', 'VAT Reg No', `Subtotal (${currencySymbol})`, `VAT Amount (15%) (${currencySymbol})`, `Grand Total (${currencySymbol})`];
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
 'Total Sum:',
 '',
 '',
 '',
 `${currencySymbol} ${subtotalSum.toFixed(2)}`,
 `${currencySymbol} ${taxSum.toFixed(2)}`,
 `${currencySymbol} ${grandSum.toFixed(2)}`
 ]);
 } else if (type === 'PurchaseVAT' && Array.isArray(rData)) {
 title = 'Purchase VAT Register (Input Tax)';
 columns = ['Expense No', 'Date', 'Vendor Name', 'VAT Reg No', `Subtotal (${currencySymbol})`, `VAT Input (${currencySymbol})`, `Total Paid (${currencySymbol})`];
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
 'Total Sum:',
 '',
 '',
 '',
 `${currencySymbol} ${subtotalSum.toFixed(2)}`,
 `${currencySymbol} ${taxSum.toFixed(2)}`,
 `${currencySymbol} ${grandSum.toFixed(2)}`
 ]);
 } else if (type === 'BankLedger' && rData) {
 const isAllBanks = rData.bankName === 'All Banks Combined';
 title = `Bank General Ledger: ${rData.bankName || ''}`;
 columns = isAllBanks
 ? ['Voucher No', 'Date', 'Bank', 'Type', 'Source Doc #', 'Description', `Inflow (Debit) (${currencySymbol})`, `Outflow (Credit) (${currencySymbol})`, `Running Balance (${currencySymbol})`]
 : ['Voucher No', 'Date', 'Type', 'Source Doc #', 'Description', `Inflow (Debit) (${currencySymbol})`, `Outflow (Credit) (${currencySymbol})`, `Running Balance (${currencySymbol})`];
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
 v.type,
 docNum,
 v.description,
 v.debit > 0 ? `+${v.debit.toFixed(2)}` : '-',
 v.credit > 0 ? `-${v.credit.toFixed(2)}` : '-',
 `${currencySymbol} ${v.runningBalance.toFixed(2)}`
 );
 return rowData;
 });
 rows.push([
 'End Balance:',
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
 title = 'Outstanding Accounts Statement (A/R & A/P)';
 columns = ['Classification', 'Document #', 'Due/Exp Date', 'Contact Entity', 'Payment Status', `Total (${currencySymbol})`, `Paid (${currencySymbol})`, `Outstanding Balance (${currencySymbol})`];
 
 const invRows = (rData.invoices || []).map((i: any) => [
 'Receivable (Customer Invoice)',
 i.docNumber,
 i.date,
 i.contactName,
 i.paymentStatus,
 `${currencySymbol} ${i.total.toFixed(2)}`,
 `${currencySymbol} ${i.paid.toFixed(2)}`,
 `${currencySymbol} ${i.outstanding.toFixed(2)}`
 ]);

 const expRows = (rData.expenses || []).map((e: any) => [
 'Payable (Supplier Expense)',
 e.docNumber,
 e.date,
 e.contactName,
 e.paymentStatus,
 `${currencySymbol} ${e.total.toFixed(2)}`,
 `${currencySymbol} ${e.paid.toFixed(2)}`,
 `${currencySymbol} ${e.outstanding.toFixed(2)}`
 ]);

 rows = [...invRows, ...expRows];

 const totalReceivable = (rData.invoices || []).reduce((sum: number, i: any) => sum + i.outstanding, 0);
 const totalPayable = (rData.expenses || []).reduce((sum: number, e: any) => sum + e.outstanding, 0);

 rows.push([
 'Totals Summary:',
 '',
 '',
 '',
 '',
 `A/R: ${currencySymbol} ${totalReceivable.toFixed(2)}`,
 `A/P: ${currencySymbol} ${totalPayable.toFixed(2)}`,
 `Net Receivable: ${currencySymbol} ${(totalReceivable - totalPayable).toFixed(2)}`
 ]);
 } else if (type === 'ProfitLoss' && rData) {
 title = 'Profit & Loss Statement (Financial Performance)';
 subtitle = `Basis: ${rData.accountingBasis} | Period: ${startDate || ''} to ${endDate || ''}`;
 columns = ['Category', 'Details', `Amount (${currencySymbol})`];
 
 rows.push(['Income Statement', 'Total Revenue', `${currencySymbol} ${rData.totalRevenue.toFixed(2)}`]);
 rows.push(['Income Statement', 'Total Expenses', `${currencySymbol} ${rData.totalExpenses.toFixed(2)}`]);
 rows.push(['Income Statement', 'Net Profit', `${currencySymbol} ${rData.netProfit.toFixed(2)}`]);
 rows.push(['---', '---', '---']);
 rows.push(['Cash Flow Analysis', 'Operating Inflows', `+${currencySymbol} ${rData.operatingInflows.toFixed(2)}`]);
 rows.push(['Cash Flow Analysis', 'Operating Outflows', `-${currencySymbol} ${rData.operatingOutflows.toFixed(2)}`]);
 rows.push(['Cash Flow Analysis', 'Investing Outflows (CapEx)', `-${currencySymbol} ${rData.investingOutflows.toFixed(2)}`]);
 rows.push(['Cash Flow Analysis', 'Financing Inflows (Equity)', `+${currencySymbol} ${rData.financingInflows.toFixed(2)}`]);
 rows.push(['Cash Flow Analysis', 'Net Cash Flow', `${currencySymbol} ${rData.netCashFlow.toFixed(2)}`]);

 if (rData.investorShares && rData.investorShares.length > 0) {
 rows.push(['---', '---', '---']);
 rData.investorShares.forEach((inv: any) => {
 rows.push(['Investor Profit Share', `${inv.name} (${inv.profitPercentage}%)`, `${currencySymbol} ${inv.shareAmount.toFixed(2)}`]);
 });
 }
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
 No records found for the active criteria.
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

 const renderDocumentBody = () => {
 switch (documentType) {
 case 'Quotation':
 case 'Invoice':
 return renderQuotationOrInvoice(data);
 case 'Expense':
 return renderExpense(data);
 case 'Voucher':
 return renderVoucher(data);
 case 'Ledger':
 return renderLedger(data);
 case 'Report':
 return renderReport(data);
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

 <button
 onClick={handlePrint}
 className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold transition"
 id="btn-print-doc"
 >
 <Printer className="w-3.5 h-3.5" />
 <span>Print / Save PDF</span>
 </button>

 {documentType === 'Invoice' && (data as Invoice)?.xmlContent && (
 <button
 onClick={() => {
 const inv = data as Invoice;
 const blob = new Blob([inv.xmlContent || ''], { type: 'text/xml' });
 const url = URL.createObjectURL(blob);
 const a = document.createElement('a');
 a.href = url;
 a.download = `ZATCA-UBL-${inv.invoiceNumber}.xml`;
 a.click();
 URL.revokeObjectURL(url);
 }}
 className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold transition cursor-pointer shadow-sm"
 id="btn-download-xml"
 title="Download ZATCA Phase 2 Signed UBL 2.1 XML"
 >
 <Download className="w-3.5 h-3.5" />
 <span>ZATCA XML</span>
 </button>
 )}

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
