// One-off: copy the "Detailed Tax Invoice (A4)" document template (built and tested
// against the "CNC Woodcraft & Design" demo company in local dev) onto a real production
// company — "SharpSurv" by name, matched case-insensitively. Run this ON THE TARGET (the
// VPS, using its own app.secrets) — never runs against a DB other than the one its local
// app.secrets/env names.
//
// Looks the company up by name first and refuses to guess if the match isn't unique,
// since document_templates.company_id is a strict FK — inserting against the wrong
// company would attach this template to someone else's tenant. Always creates a NEW row
// (fresh id) rather than reusing the source row's id, since that id has no meaning
// outside the source company it was created under.
import dotenv from 'dotenv';
dotenv.config({ path: 'app.secrets' });
import pg from 'pg';
import fs from 'fs';
import crypto from 'crypto';

const pool = new pg.Pool({
  host: process.env.SQL_HOST,
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  database: process.env.SQL_DB_NAME,
});

const TARGET_COMPANY_NAME = 'SharpSurv';

async function main() {
  const template = JSON.parse(fs.readFileSync(new URL('./detailed-tax-invoice-template-export.json', import.meta.url), 'utf8'));

  const { rows: matches } = await pool.query(
    'SELECT id, name FROM companies WHERE name ILIKE $1',
    [`%${TARGET_COMPANY_NAME}%`]
  );

  if (matches.length === 0) {
    console.error(`No company matching "${TARGET_COMPANY_NAME}" found on this database. Nothing was inserted.`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`Multiple companies match "${TARGET_COMPANY_NAME}" — refusing to guess. Matches:`);
    for (const m of matches) console.error(`  ${m.id}  ${m.name}`);
    console.error('Edit TARGET_COMPANY_NAME in this script to the exact name, or hardcode the id directly, then re-run.');
    process.exit(1);
  }

  const company = matches[0];
  const newId = crypto.randomUUID();

  await pool.query(
    `INSERT INTO document_templates
      (id, name, language, page_size, is_active, print_header, print_footer, print_logo, print_qr_code, company_id, layout_json, grid_gap_y, global_font_family)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      newId,
      template.name,
      template.language,
      template.page_size,
      // Inserted inactive regardless of the source row's flag — an admin should
      // review/select it in the Canvas Designer before it becomes the active template.
      false,
      template.print_header,
      template.print_footer,
      template.print_logo,
      template.print_qr_code,
      company.id,
      template.layout_json,
      template.grid_gap_y,
      template.global_font_family,
    ]
  );

  console.log(`Created template "${template.name}" (id ${newId}) for company "${company.name}" (${company.id}).`);
  console.log('It was created INACTIVE — activate it from Settings > Document Numbering / Canvas Designer when ready.');
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
