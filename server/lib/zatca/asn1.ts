// Minimal DER (Distinguished Encoding Rules) builder — just enough of ASN.1 to construct
// a PKCS#10 CertificationRequest by hand. Node's `crypto` module has no CSR-building API
// at all, and this needs ECDSA secp256k1 (ZATCA's mandated curve), which is outside the
// standard WebCrypto curve set (P-256/P-384/P-521 only) — ruling out WebCrypto-based
// PKI libraries. Unlike elliptic-curve math itself (left entirely to Node's native,
// audited `crypto` implementation — see generateZatcaKeyPair/signInvoiceHash), DER is a
// deterministic, well-specified byte format: a bug here produces a CSR that fails
// parsing/validation loudly, not a silent cryptographic weakness, so hand-rolling this
// bounded piece is a reasonable engineering call rather than a shortcut.

function encodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

export const der = {
  sequence: (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts)),
  set: (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts)),
  // Context-specific tag, e.g. `context(0, true, bytes)` for a constructed [0] field.
  context: (tagNum: number, constructed: boolean, content: Buffer) =>
    tlv((constructed ? 0xa0 : 0x80) | tagNum, content),
  integer: (n: number) => {
    if (n === 0) return tlv(0x02, Buffer.from([0x00]));
    const bytes: number[] = [];
    let v = n;
    while (v > 0) {
      bytes.unshift(v & 0xff);
      v = Math.floor(v / 256);
    }
    if (bytes[0] & 0x80) bytes.unshift(0x00); // keep it non-negative per DER
    return tlv(0x02, Buffer.from(bytes));
  },
  boolean: (b: boolean) => tlv(0x01, Buffer.from([b ? 0xff : 0x00])),
  bitString: (content: Buffer, unusedBits = 0) => tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), content])),
  octetString: (content: Buffer) => tlv(0x04, content),
  oid: (dotted: string) => {
    const arcs = dotted.split('.').map(Number);
    const bytes: number[] = [arcs[0] * 40 + arcs[1]];
    for (let i = 2; i < arcs.length; i++) {
      let arc = arcs[i];
      const arcBytes: number[] = [arc & 0x7f];
      arc = Math.floor(arc / 128);
      while (arc > 0) {
        arcBytes.unshift((arc & 0x7f) | 0x80);
        arc = Math.floor(arc / 128);
      }
      bytes.push(...arcBytes);
    }
    return tlv(0x06, Buffer.from(bytes));
  },
  utf8String: (s: string) => tlv(0x0c, Buffer.from(s, 'utf8')),
  printableString: (s: string) => tlv(0x13, Buffer.from(s, 'ascii')),
  raw: (tag: number, content: Buffer) => tlv(tag, content),
};

// X.520 Distinguished Name attribute OIDs, plus the COSINE/RFC4519 `userId` OID and the
// PostalAddress/BusinessCategory attributes ZATCA's own CSR template embeds in the
// subjectAltName directoryName block.
export const OID = {
  countryName: '2.5.4.6',
  organizationName: '2.5.4.10',
  organizationalUnitName: '2.5.4.11',
  commonName: '2.5.4.3',
  // ZATCA's CSR template's "SN" field is documented as an EGS device serial number, but
  // the actual OID it resolves to (via OpenSSL's standard short-name table, which is what
  // ZATCA's own reference tooling is built on) is 2.5.4.4 "surname", not 2.5.4.5
  // "serialNumber" — confirmed by generating a real CSR with OpenSSL directly and
  // diffing its accepted DER against a rejected hand-built one at the byte level.
  egsSerialNumber: '2.5.4.4',
  title: '2.5.4.12',
  registeredAddress: '2.5.4.26',
  businessCategory: '2.5.4.15',
  userId: '0.9.2342.19200300.100.1.1',
  extensionRequest: '1.2.840.113549.1.9.14',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  subjectAltName: '2.5.29.17',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  // ZATCA-specific: marks the CSR as targeting their sandbox/compliance ("TSTZATCA-Code-
  // Signing") vs. production ("ZATCA-Code-Signing") certificate template — required by
  // their CSR validation, confirmed missing from an earlier hand-rolled CSR that ZATCA's
  // real endpoint rejected with a generic "Invalid Request" (found via a real, working
  // reference implementation's documented openssl CSR config, not guessed).
  certificateTemplateName: '1.3.6.1.4.1.311.20.2',
};

export type DnAttr = { oid: string; value: string; type?: 'printable' | 'utf8' };

// AttributeTypeAndValue wrapped in a single-element SET (RDN), per X.501 Name encoding.
function rdn(attr: DnAttr): Buffer {
  const valueTlv = attr.type === 'printable' ? der.printableString(attr.value) : der.utf8String(attr.value);
  return der.set(der.sequence(der.oid(attr.oid), valueTlv));
}

// Returns the *inner* content bytes of a Name (RDNSequence) — i.e. without the outer
// SEQUENCE tag — since callers need this both as a real SEQUENCE (Subject) and re-tagged
// under an IMPLICIT context tag (GeneralName's directoryName choice).
export function nameContent(attrs: DnAttr[]): Buffer {
  return Buffer.concat(attrs.map(rdn));
}
