import * as XLSX from 'xlsx';

// Generic JSON-report -> workbook converter, shared by every report route in
// server/routes/reports.ts (see its own ?format=xlsx handling). Deliberately data-shape
// agnostic rather than one bespoke mapper per report type — every report here already
// returns either { rows: [...], totalX, ... } (a list report) or a flat object of scalars
// plus a couple of named arrays (a statement, e.g. TrialBalanceFigures's `ledgers`,
// ProfitLossFigures's `investorShares`). Both shapes fall out of the same two rules:
// - Every top-level array of objects becomes its own sheet, named after its key.
// - Every top-level scalar (string/number/boolean/null) becomes one row of a "Summary"
//   sheet, so a Balance Sheet (all scalars, no rows) still exports something useful.
// A field that's itself a nested object (none of today's reports have one at top level)
// is skipped rather than guessed at.
function reportDataToSheets(data: any): { name: string; rows: any[] }[] {
  const sheets: { name: string; rows: any[] }[] = [];
  const summary: Record<string, any> = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      const rows = typeof value[0] === 'object' && value[0] !== null ? value : value.map(v => ({ value: v }));
      sheets.push({ name: key, rows });
    } else if (value === null || typeof value !== 'object') {
      summary[key] = value;
    }
  }
  if (Object.keys(summary).length > 0) {
    sheets.unshift({ name: 'Summary', rows: [summary] });
  }
  if (sheets.length === 0) sheets.push({ name: 'Data', rows: [data] });
  return sheets;
}

// Excel sheet names are capped at 31 characters and can't contain \/?*[]: — every key used
// here (reportData's own field names) is already a short, safe camelCase identifier, but
// this stays defensive rather than assuming that forever.
function safeSheetName(name: string, usedNames: Set<string>): string {
  let safe = name.replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || 'Sheet';
  let unique = safe;
  let i = 2;
  while (usedNames.has(unique)) { unique = `${safe.slice(0, 28)}_${i}`; i++; }
  usedNames.add(unique);
  return unique;
}

// Sends `data` (whatever a report route would otherwise res.json()) as a downloadable
// .xlsx workbook instead — same data, different transport. Never re-derives or recomputes
// anything: the caller has already done the real (server-side, company-scoped, no-row-cap)
// computation; this only reshapes the JSON result into sheets.
export function sendReportExcel(res: any, filename: string, data: any): void {
  const wb = XLSX.utils.book_new();
  const usedNames = new Set<string>();
  for (const sheet of reportDataToSheets(data)) {
    const ws = XLSX.utils.json_to_sheet(sheet.rows);
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName(sheet.name, usedNames));
  }
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const safeFilename = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
  res.send(buf);
}
