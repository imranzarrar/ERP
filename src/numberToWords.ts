// Converts a currency amount into words for printed documents (e.g. "Four Thousand Two
// Hundred Sixty-One Riyals and Thirty-Three Halalas Only") — the traditional GCC tax
// invoice format always carries this line, and this app's document layout has declared
// a `showGrandTotalWords` flag for it since documentTemplateDefaults.ts was written, but
// nothing ever implemented it (DocumentRenderer.tsx's totals_summary block never
// consumed the flag). Kept as its own small module rather than inline in
// DocumentRenderer.tsx since it's pure formatting logic with no component dependencies.

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function threeDigitsToWords(n: number): string {
  const parts: string[] = [];
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)]} Hundred`);
    n %= 100;
  }
  if (n >= 20) {
    const tens = TENS[Math.floor(n / 10)];
    const ones = n % 10;
    parts.push(ones ? `${tens}-${ONES[ones]}` : tens);
  } else if (n > 0) {
    parts.push(ONES[n]);
  }
  return parts.join(' ');
}

// Handles 0 up to just under a quadrillion — far beyond any realistic invoice total.
function integerToWords(n: number): string {
  if (n === 0) return 'Zero';
  const SCALES: [number, string][] = [
    [1_000_000_000, 'Billion'],
    [1_000_000, 'Million'],
    [1_000, 'Thousand'],
  ];
  const parts: string[] = [];
  for (const [scale, label] of SCALES) {
    if (n >= scale) {
      parts.push(`${threeDigitsToWords(Math.floor(n / scale))} ${label}`);
      n %= scale;
    }
  }
  if (n > 0) parts.push(threeDigitsToWords(n));
  return parts.join(' ');
}

// Currency-agnostic major/minor unit names, defaulting to Saudi Riyal/Halala since this
// app's default currency (companies.currency) is 'SAR' — pass explicit names for any
// other configured currency rather than assuming SAR everywhere.
export function amountToWords(
  amount: number,
  majorUnit: [string, string] = ['Riyal', 'Riyals'],
  minorUnit: [string, string] = ['Halala', 'Halalas']
): string {
  const rounded = Math.round(Math.max(0, amount) * 100) / 100;
  const wholePart = Math.floor(rounded);
  const fractionPart = Math.round((rounded - wholePart) * 100);

  const [majorSingular, majorPlural] = majorUnit;
  const [minorSingular, minorPlural] = minorUnit;

  const majorWords = `${integerToWords(wholePart)} ${wholePart === 1 ? majorSingular : majorPlural}`;
  if (fractionPart === 0) return `${majorWords} Only`;

  const minorWords = `${integerToWords(fractionPart)} ${fractionPart === 1 ? minorSingular : minorPlural}`;
  return `${majorWords} and ${minorWords} Only`;
}

// Looks up unit names for a currency code — falls back to the code itself (e.g. "5 USD")
// for anything not explicitly mapped, so an unrecognized currency degrades gracefully
// instead of mislabeling the amount as Riyals.
const CURRENCY_UNIT_NAMES: Record<string, { major: [string, string]; minor: [string, string] }> = {
  SAR: { major: ['Riyal', 'Riyals'], minor: ['Halala', 'Halalas'] },
  USD: { major: ['Dollar', 'Dollars'], minor: ['Cent', 'Cents'] },
  EUR: { major: ['Euro', 'Euros'], minor: ['Cent', 'Cents'] },
  AED: { major: ['Dirham', 'Dirhams'], minor: ['Fils', 'Fils'] },
};

export function amountToWordsForCurrency(amount: number, currencyCode: string | undefined | null): string {
  const units = CURRENCY_UNIT_NAMES[(currencyCode || 'SAR').toUpperCase()];
  if (!units) return `${amountToWords(amount, [currencyCode || 'Unit', currencyCode || 'Units'], ['Cent', 'Cents'])}`;
  return amountToWords(amount, units.major, units.minor);
}
