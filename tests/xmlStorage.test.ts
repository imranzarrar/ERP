import { describe, it, expect } from 'vitest';
import { compressXml, decompressXml, readInvoiceXml, xmlColumnsForWrite } from '../server/lib/zatca/xmlStorage.js';

// Pure unit tests (no server/DB) for the signed-XML at-rest format. The XML is the legal VAT
// record, so the bar is byte-exact round trips including non-ASCII (Arabic party names).
const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>\n<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">` +
  `<cbc:ID>INV-1001</cbc:ID><cac:PartyName><cbc:Name>مؤسسة قمم التشكيل للصيانة</cbc:Name></cac:PartyName>` +
  Array.from({ length: 40 }, (_, i) => `<cac:InvoiceLine><cbc:ID>${i}</cbc:ID><cbc:LineExtensionAmount currencyID="SAR">${i * 10.5}</cbc:LineExtensionAmount></cac:InvoiceLine>`).join('\n') +
  `<ds:SignatureValue>MEUCIQD${'A1b2C3d4'.repeat(12)}</ds:SignatureValue></Invoice>`;

describe('signed XML at-rest storage', () => {
  it('round-trips byte-exactly, including Arabic text, and is smaller than the plain text', () => {
    const stored = compressXml(SAMPLE);
    expect(decompressXml(stored)).toBe(SAMPLE);
    expect(stored.length).toBeLessThan(Buffer.byteLength(SAMPLE));
  });

  it('preserves whitespace, CRLF and a trailing newline exactly', () => {
    const xml = '<a>\r\n  <b>x</b>\r\n</a>\n';
    expect(decompressXml(compressXml(xml))).toBe(xml);
  });

  it('tags the format in byte 0 and rejects unknown or truncated data', () => {
    const stored = compressXml('<a/>');
    expect(stored[0]).toBe(0x01);
    expect(() => decompressXml(Buffer.from([0x7f, 1, 2, 3]))).toThrow(/Unknown stored-XML format/);
    expect(() => decompressXml(Buffer.from([0x01]))).toThrow(/empty or truncated/);
  });

  it('xmlColumnsForWrite nulls the legacy plain column so a re-sign can never leave a stale copy', () => {
    const cols = xmlColumnsForWrite(SAMPLE);
    expect(cols.xmlContent).toBeNull();
    expect(readInvoiceXml(cols)).toBe(SAMPLE);
  });

  it('readInvoiceXml prefers the compressed column and falls back to the legacy text column', () => {
    expect(readInvoiceXml({ xmlContent: 'legacy', xmlContentZ: compressXml('fresh') })).toBe('fresh');
    expect(readInvoiceXml({ xmlContent: 'legacy', xmlContentZ: null })).toBe('legacy');
    expect(readInvoiceXml({ xmlContent: null, xmlContentZ: null })).toBeNull();
  });
});
