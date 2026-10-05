import zlib from 'zlib';

// At-rest storage for the signed ZATCA UBL XML (invoices.xml_content_z).
//
// The XML is ~10-18 KB per invoice and is the single largest thing stored per invoice, so it is
// kept brotli-compressed (about 25-35% smaller than what Postgres' own TOAST compression
// achieves on the plain text column). It is the legal VAT record, so this layer is strictly
// lossless and self-checking:
//   * every write decompresses what it just produced and compares it byte-for-byte with the
//     input before returning — a compression defect throws instead of persisting a bad record;
//   * the first byte is a format tag, so another algorithm (e.g. a preset-dictionary variant)
//     can be added later without a flag day: old rows keep decoding by their own tag.
//
// Never compress anything other than the final signed document, and never hash/sign the
// compressed bytes — the XML's hash, signature and QR are all computed over the plain text
// before it reaches here.

const FORMAT_BROTLI = 0x01;

export function compressXml(xml: string): Buffer {
  const plain = Buffer.from(xml, 'utf8');
  const packed = zlib.brotliCompressSync(plain, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: plain.length,
    },
  });
  const out = Buffer.concat([Buffer.from([FORMAT_BROTLI]), packed]);
  if (decompressXml(out) !== xml) {
    throw new Error('XML compression round-trip mismatch — refusing to store a lossy copy of a signed invoice.');
  }
  return out;
}

export function decompressXml(stored: Buffer): string {
  if (!stored || stored.length < 2) throw new Error('Stored XML is empty or truncated.');
  switch (stored[0]) {
    case FORMAT_BROTLI:
      return zlib.brotliDecompressSync(stored.subarray(1)).toString('utf8');
    default:
      throw new Error(`Unknown stored-XML format tag 0x${stored[0].toString(16)}.`);
  }
}

// The columns to write when persisting a freshly built signed XML. `xmlContent` (the legacy
// plain-text column) is explicitly nulled so a re-signed invoice can never leave a stale plain
// copy alongside the new compressed one.
export function xmlColumnsForWrite(xml: string): { xmlContent: null; xmlContentZ: Buffer } {
  return { xmlContent: null, xmlContentZ: compressXml(xml) };
}

// Read side: prefers the compressed column, falls back to the legacy plain-text column for rows
// not yet backfilled. Returns null when the invoice has no XML at all.
export function readInvoiceXml(row: { xmlContent?: string | null; xmlContentZ?: Buffer | null }): string | null {
  if (row.xmlContentZ && row.xmlContentZ.length > 0) return decompressXml(row.xmlContentZ);
  return row.xmlContent ?? null;
}
