// Test helpers for the ledger report engine: find a company's default definition of a type, run it, and read the Trial Balance in a flat, per-account shape.
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

async function get(session: string, path: string) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { 'x-session-id': session } });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json().catch(() => ({})) : await res.arrayBuffer() };
}

export async function defaultDefinitionId(session: string, type: 'TrialBalance' | 'PnL' | 'BalanceSheet' | 'CashFlow' | 'ChangesInEquity'): Promise<string> {
  const r = await get(session, `/api/ledger/report-definitions?type=${type}`);
  const d = (r.body.definitions || []).find((x: any) => x.isDefault) || (r.body.definitions || [])[0];
  if (!d) throw new Error(`No ${type} definition (${r.status})`);
  return d.id;
}

export async function runReport(session: string, id: string, params: Record<string, string>) {
  return get(session, `/api/ledger/report-definitions/${id}/run?${new URLSearchParams(params)}`);
}

// Per-account Trial Balance: { balanced, totals:{debit,credit}, rows:[{code, name, isGroup, opening, debit, credit, closing}] } from the seeded definition.
export async function trialBalance(session: string, from: string, to: string, dims?: any) {
  const id = await defaultDefinitionId(session, 'TrialBalance');
  const r = await runReport(session, id, { from, to, mode: 'Detailed', ...(dims ? { dims: JSON.stringify(dims) } : {}) });
  if (r.status !== 200) throw new Error(`TB run failed ${r.status}: ${JSON.stringify(r.body)}`);
  const rows: any[] = [];
  const net = (c: any) => (c?.dr || 0) - (c?.cr || 0);
  const push = (code: string, name: string, isGroup: boolean, cells: any[]) => rows.push({ code, name, isGroup, opening: net(cells[0]), debit: cells[1]?.dr || 0, credit: cells[1]?.cr || 0, closing: net(cells[2]) });
  for (const row of r.body.rows) for (const d of row.detail || []) push(d.code, d.name, d.isGroup, d.cells);
  for (const n of r.body.notInDefinition || []) push(n.code, n.name, false, n.cells);
  const mov = (r.body.checks.totals || []).find((t: any) => t.columnNumber === 2) || { dr: 0, cr: 0 };
  return { balanced: !!r.body.checks.balanced, totals: { debit: mov.dr, credit: mov.cr }, rows, raw: r.body };
}
