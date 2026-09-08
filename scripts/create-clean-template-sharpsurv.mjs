// One-off: give "SharpSurv" a clean, single-language (no cramped bilingual headers),
// colored, properly-aligned invoice template — replacing the "Detailed Tax Invoice"
// copy that was found to render badly (garbled Arabic text and an oversized logo,
// both since fixed at the code level in DocumentRenderer.tsx, plus a real overlapping-
// price layout bug in the items table, also fixed). Run this ON THE TARGET (the VPS,
// using its own app.secrets) after deploying those fixes.
//
// Uses DEFAULT_DOCUMENT_LAYOUT's exact shape (src/documentTemplateDefaults.ts) — the
// same reasoned 12-column grid every other template in this app is built on — with
// isBilingual turned off for a cleaner look and a blue accent (matching SharpSurv's own
// brand color) on the totals block. Deactivates every other template for this company
// so this one is unambiguously what prints, and refuses to run if the company name
// match isn't unique.
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

const TARGET_COMPANY_NAME = 'SharpSurv';

const layout = [
  { id: 'logo', title: 'Company Logo', w: 4, visible: true, props: { align: 'left' } },
  { id: 'doc_details', title: 'Document Metadata', w: 8, visible: true, props: { isBilingual: false, showDocNumber: true, showDate: true, showDueDate: true, showPaymentStatus: true, showOriginQ: true, showTRN: true, showCreatedBy: true } },
  { id: 'company_details', title: 'Company Details', w: 6, visible: true, props: { isBilingual: false, showVat: true, showAddress: true, showContact: true, showBank: true } },
  { id: 'customer_info', title: 'Customer Info', w: 6, visible: true, props: { isBilingual: false, showName: true, showContact: true, showAddress: true, showVatNumber: true, borderStyle: 'solid' } },
  { id: 'custom_header', title: 'Custom Header text', w: 12, visible: true, props: { isBilingual: false } },
  { id: 'items_table', title: 'Items Table', w: 12, visible: true, props: { isBilingual: false, showSNo: true, showItemCode: true, showDescription: true, showQty: true, showUnitCost: true, showDiscount: true, showTotal: true, showTaxAmount: true, borderStyle: 'stripe' } },
  { id: 'notes', title: 'Notes block', w: 5, visible: true, props: { isBilingual: false } },
  { id: 'qr_code', title: 'ZATCA QR Code', w: 3, visible: true, props: { align: 'center', size: 'medium', isBilingual: false } },
  { id: 'totals_summary', title: 'Total Summary', w: 4, visible: true, props: { isBilingual: false, showSubtotal: true, showDiscount: true, showNetSubtotal: true, showVat: true, showGrandTotal: true, showGrandTotalWords: true, accentColor: 'blue' } },
  { id: 'custom_footer', title: 'Custom Footer text', w: 12, visible: true, props: { isBilingual: false } },
];

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
  const newId = crypto.randomUUID();

  await pool.query('UPDATE document_templates SET is_active = false WHERE company_id = $1', [company.id]);

  await pool.query(
    `INSERT INTO document_templates
      (id, name, language, page_size, is_active, print_header, print_footer, print_logo, print_qr_code, company_id, layout_json, grid_gap_y)
     VALUES ($1, 'Professional Clean (A4)', 'English', '8.27in x 11.69in (A4)', true, true, true, true, true, $2, $3, 'normal')`,
    [newId, company.id, JSON.stringify(layout)]
  );

  console.log(`Created and activated "Professional Clean (A4)" (id ${newId}) for "${company.name}" (${company.id}).`);
  console.log('Every other template for this company was deactivated.');
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
