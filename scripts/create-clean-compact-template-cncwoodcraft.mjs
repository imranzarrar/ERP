// One-off: "Compact A4" + "Compact A4 Arabic" invoice templates for CNC Woodcraft &
// Design, per a visual reference the user provided, refined across a few rounds — logo
// top-left, no boxes/borders/background rectangles anywhere (company_details was already
// borderless in DocumentRenderer; customer_info/custom_header/notes/qr_code/
// totals_summary needed a new borderStyle:"none" opt-out added to DocumentRenderer.tsx
// since they previously always rendered a bordered/shaded card with no escape hatch),
// plain (non-striped) items table, and the notes/QR/totals footer row pinned to the
// bottom of the page so the items table gets all the vertical room above it.
//
// Both templates share the exact same layout array — DocumentRenderer's own `t()` for
// Invoice/Quotation is driven by the TEMPLATE's `language` field (fixed local
// TRANSLATIONS/URDU_TRANSLATIONS dictionaries, independent of the viewing user's own UI
// language — see DocumentRenderer.tsx's isArabic/isUrdu/t() block), so simply setting
// language:'Arabic' on the second row automatically translates every label and switches
// to RTL + the Cairo font. isBilingual is turned off on the Arabic copy — those flags
// exist to show a small SECOND-language caption alongside the primary text (e.g. an
// English-primary template showing a small Arabic sub-label); with Arabic as the
// primary language those hardcoded captions are themselves Arabic literals, so leaving
// isBilingual on would print a redundant Arabic caption directly under already-Arabic
// text.
//
// Only one template can be `is_active` (the default pre-selected one) per company, but
// EVERY saved template stays selectable from the Print dialog's template dropdown
// (DocumentRenderer.tsx's companyTemplates.map(...) select) — so both these coexist:
// English "Compact A4" is the default, Arabic "Compact A4 Arabic" is one dropdown
// selection away whenever this company needs to print in Arabic.
//
// Run this ON THE TARGET (the VPS, using its own app.secrets) after deploying, or
// locally against dev to preview first.
import dotenv from 'dotenv';
dotenv.config({ path: 'app.secrets' });
import pg from 'pg';
import crypto from 'crypto';

const pool = new pg.Pool({
  host: process.env.SQL_HOST,
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  database: process.env.SQL_DB_NAME,
});

const TARGET_COMPANY_NAME = 'CNC Woodcraft & Design';

function buildLayout({ isBilingual }) {
  return [
    { id: 'logo', title: 'Company Logo', w: 4, visible: true, props: { align: 'left' } },
    { id: 'doc_details', title: 'Document Metadata', w: 8, visible: true, props: { isBilingual, compact: true, showDocNumber: true, showDate: true, showDueDate: false, showPaymentStatus: true, showOriginQ: false, showTRN: false, showCreatedBy: false } },
    { id: 'company_details', title: 'Company Details', w: 6, visible: true, props: { isBilingual, compact: true, showVat: true, showAddress: true, showContact: true, showBank: false } },
    { id: 'customer_info', title: 'Customer Info', w: 6, visible: true, props: { isBilingual, compact: true, showName: true, showContact: true, showAddress: true, showVatNumber: true, addressStyle: 'itemized', borderStyle: 'none' } },
    { id: 'custom_header', title: 'Custom Header text', w: 12, visible: true, props: { isBilingual: false, compact: true, borderStyle: 'none' } },
    { id: 'items_table', title: 'Items Table', w: 12, visible: true, props: { isBilingual: false, showSNo: true, showItemCode: false, showDescription: true, showQty: true, showUnitCost: true, showDiscount: true, showTotal: true, borderStyle: 'plain' } },
    { id: 'notes', title: 'Notes block', w: 5, visible: true, props: { isBilingual: false, anchorBottom: true, borderStyle: 'none' } },
    { id: 'qr_code', title: 'ZATCA QR Code', w: 3, visible: true, props: { align: 'center', size: 'medium', isBilingual, anchorBottom: true, borderStyle: 'none' } },
    { id: 'totals_summary', title: 'Total Summary', w: 4, visible: true, props: { isBilingual: false, showSubtotal: true, showDiscount: true, showNetSubtotal: false, showVat: true, showGrandTotal: true, showGrandTotalWords: true, accentColor: 'slate', anchorBottom: true, borderStyle: 'none' } },
    { id: 'custom_footer', title: 'Custom Footer text', w: 12, visible: true, props: { isBilingual: false, anchorBottom: true } },
  ];
}

const englishLayout = buildLayout({ isBilingual: true });
const arabicLayout = buildLayout({ isBilingual: false });

async function main() {
  const { rows: matches } = await pool.query('SELECT id, name FROM companies WHERE name ILIKE $1', [`%${TARGET_COMPANY_NAME}%`]);

  if (matches.length === 0) {
    console.error(`No company matching "${TARGET_COMPANY_NAME}" found. Nothing changed.`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`Multiple companies match "${TARGET_COMPANY_NAME}" — refusing to guess:`);
    for (const m of matches) console.error(`  ${m.id}  ${m.name}`);
    process.exit(1);
  }

  const company = matches[0];
  const englishId = crypto.randomUUID();
  const arabicId = crypto.randomUUID();

  await pool.query('UPDATE document_templates SET is_active = false WHERE company_id = $1', [company.id]);

  await pool.query(
    `INSERT INTO document_templates
      (id, name, language, page_size, is_active, print_header, print_footer, print_logo, print_qr_code, company_id, layout_json, grid_gap_y)
     VALUES ($1, 'Compact A4', 'English', '8.27in x 11.69in (A4)', true, true, true, true, true, $2, $3, 'tight')`,
    [englishId, company.id, JSON.stringify(englishLayout)]
  );

  await pool.query(
    `INSERT INTO document_templates
      (id, name, language, page_size, is_active, print_header, print_footer, print_logo, print_qr_code, company_id, layout_json, grid_gap_y)
     VALUES ($1, 'Compact A4 Arabic', 'Arabic', '8.27in x 11.69in (A4)', false, true, true, true, true, $2, $3, 'tight')`,
    [arabicId, company.id, JSON.stringify(arabicLayout)]
  );

  console.log(`Created and activated "Compact A4" (id ${englishId}) for "${company.name}" (${company.id}).`);
  console.log(`Created "Compact A4 Arabic" (id ${arabicId}), selectable from the Print dialog's template dropdown.`);
  console.log('Every other template for this company was deactivated.');
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
