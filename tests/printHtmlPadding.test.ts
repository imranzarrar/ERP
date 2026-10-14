import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// The print popup gives <html> and <body> 20px of padding for the on-screen view. In print only <body> used to be reset, so <html> kept
// 0.42in of top+bottom padding on top of the page margin; an anchored template (min-height 10.5in in a 10.89in printable area) then ran past
// one page and printed a blank second page. Reproduced with headless Chrome: 2 pages before, 1 page after. Both print paths must reset html too.
describe('print popup resets html padding as well as body', () => {
  for (const file of ['src/components/DocumentRenderer.tsx', 'src/components/VatReturnsPanel.tsx']) {
    it(file, () => {
      const src = readFileSync(file, 'utf8');
      expect(src).toMatch(/@media print \{[\s\S]*?html, body \{ padding: 0; margin: 0; width: 100%; \}/);
    });
  }
});

// A document just over one page used to split its anchored footer (notes / QR / totals), leaving a lone "Amount in Words" strip on an
// otherwise empty second page; the footer now moves as one block, and the paper's screen-only shadow/border no longer prints.
describe('print keeps the anchored footer together', () => {
  it('DocumentRenderer', () => {
    const src = readFileSync('src/components/DocumentRenderer.tsx', 'utf8');
    expect(src).toMatch(/print:break-inside-avoid/);
    expect(src).toMatch(/print:shadow-none print:border-0/);
  });
});

// The items table: the currency is written only in the line Subtotal column when the table has one (Unit Cost / Taxable / Tax Amount
// are bare numbers, so the description gets the width), the Item Code column is dropped when no line has a code, and the last item line
// shares an unbreakable row group with the footer row so a page holding the QR/totals always holds at least one item line.
describe('items table layout and pagination', () => {
  const src = readFileSync('src/components/DocumentRenderer.tsx', 'utf8');
  it('writes the currency only on the Subtotal column of a table that has one', () => {
    expect(src).toMatch(/const currencyOnSubtotalOnly = showLineSubtotal;/);
    expect(src).toMatch(/fmtCell\(lineTaxable\)/);
    expect(src).toMatch(/\{fmt\(lineTaxable \+ lineTax\)\}/);
  });
  it('hides the Item Code column when no line has a code', () => {
    expect(src).toMatch(/showItemCodeCol = showItemCode && \(!compact \|\| items\.some/);
  });
  it('keeps the last item line and the footer row together', () => {
    expect(src).toMatch(/<tbody style=\{\{ breakInside: 'avoid' \}\}>/);
  });
});
