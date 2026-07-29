import crypto from 'crypto';

// Minimal DER TLV reader — decodes only what's needed to walk a well-formed X.509
// certificate / SPKI structure (definite-length encoding only, which is all X.509 ever
// uses). Not a general ASN.1 parser.
interface Tlv {
  tag: number;
  contentStart: number;
  contentEnd: number;
  next: number;
}

function readTlv(buf: Buffer, offset: number): Tlv {
  const tag = buf[offset];
  const lenByte = buf[offset + 1];
  let length: number;
  let contentStart: number;
  if (lenByte & 0x80) {
    const numBytes = lenByte & 0x7f;
    length = 0;
    for (let i = 0; i < numBytes; i++) length = (length << 8) | buf[offset + 2 + i];
    contentStart = offset + 2 + numBytes;
  } else {
    length = lenByte;
    contentStart = offset + 2;
  }
  return { tag, contentStart, contentEnd: contentStart + length, next: contentStart + length };
}

// Walks the immediate children of a top-level SEQUENCE.
function readSequenceChildren(buf: Buffer): Tlv[] {
  const outer = readTlv(buf, 0);
  const children: Tlv[] = [];
  let pos = outer.contentStart;
  while (pos < outer.contentEnd) {
    const child = readTlv(buf, pos);
    children.push(child);
    pos = child.next;
  }
  return children;
}

// A BIT STRING's content starts with a 1-byte "unused bits" count (always 0x00 for the
// byte-aligned content X.509 certs/keys use) — strip it to get the raw payload.
function bitStringContent(buf: Buffer, tlv: Tlv): Buffer {
  return buf.subarray(tlv.contentStart + 1, tlv.contentEnd);
}

export interface ZatcaCertificateInfo {
  pem: string;
  // ZATCA's documented (and empirically confirmed, via a real working reference
  // implementation) digest convention for XAdES CertDigest: sha256 over the certificate's
  // base64 body TEXT, hex-encoded, then THAT hex string's ASCII bytes are base64'd again —
  // not a plain base64(sha256(bytes)) as every other hash in this codebase uses.
  hash: string;
  issuer: string; // root-to-leaf, comma-joined — matches ds:X509IssuerName's expected order
  serialNumber: string; // decimal string
  // QR tag 8: the FULL SPKI DER bytes, unmodified — confirmed against ZATCA's own official
  // Java SDK (decompiled): it passes `certificate.getPublicKey().getEncoded()` directly,
  // which is Java's SubjectPublicKeyInfo DER encoding, not a stripped raw EC point.
  publicKeySpkiDer: Buffer;
  // QR tag 9 (Simplified/B2C only): the CA's signature over this cert, exactly as stored —
  // confirmed against the same SDK: `certificate.getSignature()` returns the raw ASN.1 DER
  // signature bytes with no reformatting (Java's default ECDSA signature encoding is DER,
  // not IEEE P1363, despite the Developer Portal Manual's P1363 language — the manual
  // doesn't match the SDK's actual behavior here).
  signatureDer: Buffer;
}

// ZATCA's CSID issuance response returns `binarySecurityToken` as base64-encoded PEM BODY
// TEXT (not a base64-encoded DER cert) — decoding it one level yields the actual
// (already 64-char-line-wrapped) certificate body to wrap with BEGIN/END markers. This is
// also exactly the value used as the HTTP Basic Auth username for the ZATCA APIs
// (apiClient.ts uses it undecoded there, correctly — Basic Auth wants the token as-is).
export function decodeZatcaCsidCertificate(binarySecurityToken: string): ZatcaCertificateInfo {
  const certBodyText = Buffer.from(binarySecurityToken, 'base64').toString('utf8');
  const pem = `-----BEGIN CERTIFICATE-----\n${certBodyText}\n-----END CERTIFICATE-----`;

  const certHashHex = crypto.createHash('sha256').update(certBodyText).digest('hex');
  const hash = Buffer.from(certHashHex).toString('base64');

  const x509 = new crypto.X509Certificate(pem);
  // Node's `.issuer` is newline-separated "K=V" pairs in subject-to-root order; ZATCA's
  // X509IssuerName wants root-to-subject, comma-joined — confirmed against a real working
  // reference implementation's exact transform.
  const issuer = x509.issuer.split('\n').reverse().join(', ');
  const serialNumber = BigInt('0x' + x509.serialNumber).toString(10);

  const certDer = x509.raw;
  const certChildren = readSequenceChildren(certDer);
  // Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
  const signatureValueTlv = certChildren[2];
  const signatureDer = bitStringContent(certDer, signatureValueTlv);

  // x509.publicKey is already a public KeyObject — export it directly rather than
  // re-wrapping via createPublicKey (which expects a private key or raw key material,
  // not an existing public KeyObject). Used as-is (full SPKI DER), matching
  // certificate.getPublicKey().getEncoded() in the official SDK.
  const publicKeySpkiDer = x509.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;

  return { pem, hash, issuer, serialNumber, publicKeySpkiDer, signatureDer };
}

// A ZATCA CSID response's certificate must be for the SAME keypair we submitted in the
// CSR — otherwise every signature made with our stored private key will be
// cryptographically invalid against that certificate's public key, and ZATCA (or any
// real validator) will reject it, even though both the API call and the certificate
// itself are individually "real". Confirmed necessary after ZATCA's real sandbox
// returned a genuinely-issued but mismatched Production CSID certificate for a company
// using the shared public sandbox test VAT — the API succeeding is not proof the
// returned certificate actually pairs with our key, so this must be checked explicitly
// before a CSID is ever accepted and stored.
export function certificateMatchesPrivateKey(binarySecurityToken: string, privateKeyPem: string): boolean {
  const { pem } = decodeZatcaCsidCertificate(binarySecurityToken);
  const certPublicKeyDer = new crypto.X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' });
  const derivedPublicKeyDer = crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' });
  return (certPublicKeyDer as Buffer).equals(derivedPublicKeyDer as Buffer);
}
