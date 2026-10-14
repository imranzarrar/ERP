// The one definition of how a report row or column may be formatted. The server validates a saved definition with normalizeFormat(); the screens, the
// printout and the Excel export all read the same normalised object, so what the designer shows is what is printed and exported.
export type Align = 'start' | 'center' | 'end';
export type Border = 'none' | 'single' | 'double';
export interface ReportFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: 'none' | 'single' | 'double';
  indent?: number; // 0..4
  align?: Align; // the label
  amountAlign?: Align; // the figures
  borderTop?: Border;
  borderBottom?: Border;
  shade?: boolean;
  show?: 'always' | 'nonzero' | 'hidden'; // hidden = helper row used only by formulas
  pageBreakAfter?: boolean;
  negatives?: 'parentheses' | 'minus';
  decimals?: 0 | 2;
}

const ALIGN = ['start', 'center', 'end'];
const BORDER = ['none', 'single', 'double'];

// Returns a clean format object (unknown keys and bad values dropped) or an error message.
export function normalizeFormat(raw: any): { format: ReportFormat; error?: string } {
  const f: ReportFormat = {};
  if (raw === null || raw === undefined) return { format: f };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { format: f, error: 'Formatting must be an object.' };
  const bool = (k: keyof ReportFormat) => { if (raw[k] !== undefined) (f as any)[k] = raw[k] === true; };
  bool('bold'); bool('italic'); bool('shade'); bool('pageBreakAfter');
  if (raw.underline !== undefined) { if (!BORDER.includes(raw.underline)) return { format: f, error: 'Underline must be none, single or double.' }; f.underline = raw.underline; }
  if (raw.indent !== undefined) { const n = Number(raw.indent); if (!Number.isInteger(n) || n < 0 || n > 4) return { format: f, error: 'Indent must be 0 to 4.' }; f.indent = n; }
  for (const k of ['align', 'amountAlign'] as const) if (raw[k] !== undefined) { if (!ALIGN.includes(raw[k])) return { format: f, error: 'Alignment must be start, center or end.' }; f[k] = raw[k]; }
  for (const k of ['borderTop', 'borderBottom'] as const) if (raw[k] !== undefined) { if (!BORDER.includes(raw[k])) return { format: f, error: 'A border must be none, single or double.' }; f[k] = raw[k]; }
  if (raw.show !== undefined) { if (!['always', 'nonzero', 'hidden'].includes(raw.show)) return { format: f, error: 'Show must be always, nonzero or hidden.' }; f.show = raw.show; }
  if (raw.negatives !== undefined) { if (!['parentheses', 'minus'].includes(raw.negatives)) return { format: f, error: 'Negatives must be parentheses or minus.' }; f.negatives = raw.negatives; }
  if (raw.decimals !== undefined) { if (raw.decimals !== 0 && raw.decimals !== 2) return { format: f, error: 'Decimals must be 0 or 2.' }; f.decimals = raw.decimals; }
  return { format: f };
}

// A number as the report shows it, honouring the row's decimals and negative style.
export function formatAmount(v: number | null | undefined, f: ReportFormat = {}): string {
  if (v === null || v === undefined || isNaN(v)) return '';
  const d = f.decimals === 0 ? 0 : 2;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  if (v < -0.00001 && Math.abs(v) >= (d === 0 ? 0.5 : 0.005)) return f.negatives === 'minus' ? `-${s}` : `(${s})`;
  return s;
}
