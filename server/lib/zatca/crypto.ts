import crypto from 'crypto';
import { der, OID, nameContent } from './asn1.js';

export interface ZatcaCsrParams {
  cn: string; // Common Name (e.g. Solution Name / App Name)
  organizationUnitName: string; // Branch Name / Department
  organizationName: string; // Company Name
  countryName?: string; // Default 'SA'
  serialNumber: string; // Device Serial Number (1-AppName|2-Version|3-UUID)
  vatNumber: string; // 15 digit TIN
  invoiceType: string; // '1100' for B2B + B2C, '1000' for B2B, '0100' for B2C
  location: string; // Building / Address / City
  industry: string; // Business category
  production?: boolean; // false/undefined => sandbox/compliance CSR template, true => production
}

/**
  * Generates an ECDSA secp256k1 keypair for ZATCA Phase 2 compliance
  */
export function generateZatcaKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'secp256k1',
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });

  return {
    privateKeyPem: privateKey,
    publicKeyPem: publicKey,
  };
}

/**
  * Builds a real PKCS#10 CertificationRequest per ZATCA's documented CSR template:
  * standard Subject DN (C/O/OU/CN) plus a custom subjectAltName directoryName carrying
  * SN (device serial), UID (VAT number), title (invoice type), registeredAddress, and
  * businessCategory — the same fields ZATCA's reference openssl.cnf embeds via
  * `subjectAltName = dirName:dir_sect`. DER-encoded by hand (see asn1.ts for why), signed
  * with the real secp256k1 private key, PEM-wrapped, then base64-encoded as ZATCA's API
  * expects.
  */
export function generateZatcaCsr(params: ZatcaCsrParams, privateKeyPem: string): string {
  const sanitizedVat = (params.vatNumber || '300000000000003').padEnd(15, '0');
  const sanitizedSerial = params.serialNumber || `1-ERP|2-2.0|3-${crypto.randomUUID()}`;
  const countryCode = params.countryName || 'SA';
  const organizationUnit = params.organizationUnitName || 'HeadOffice';
  const organization = params.organizationName || 'Company';
  const commonName = params.cn || 'ERP-ZATCA';
  const invoiceType = params.invoiceType || '1100';
  const location = params.location || 'Riyadh';
  const industry = params.industry || 'Commerce';

  // Subject DN — standard X.520 attributes only (no ZATCA-specific fields here; those
  // live in the SAN dirName block below, matching ZATCA's template). Order matters: CN,
  // OU, O, C is what ZATCA's real CSR endpoint actually accepts — confirmed by testing
  // a real openssl-generated CSR with this exact order against ZATCA's live sandbox
  // (issued successfully) after the previous C/O/OU/CN order was rejected outright.
  const subjectName = der.sequence(nameContent([
    { oid: OID.commonName, value: commonName, type: 'utf8' },
    { oid: OID.organizationalUnitName, value: organizationUnit, type: 'utf8' },
    { oid: OID.organizationName, value: organization, type: 'utf8' },
    { oid: OID.countryName, value: countryCode, type: 'printable' },
  ]));

  // Public key: derive SPKI DER straight from the private key rather than re-deriving
  // the EC point ourselves — Node's own secp256k1 SPKI export is already correctly
  // DER-encoded (AlgorithmIdentifier + BIT STRING), so it's reused as-is.
  const subjectPublicKeyInfo = crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' });

  // Note: basicConstraints/keyUsage are deliberately NOT included — ZATCA's own
  // reference CSR config leaves both commented out (confirmed via a real working
  // implementation), so only the two extensions below are sent.

  // subjectAltName: a single GeneralName of type [4] directoryName, carrying ZATCA's
  // custom SN/UID/title/registeredAddress/businessCategory attributes. The [4] context
  // tag wraps a full, separately-tagged Name SEQUENCE (EXPLICIT, not IMPLICIT as X.680
  // would suggest by default) — confirmed by diffing a ZATCA-accepted, openssl-generated
  // CSR byte-for-byte against a rejected hand-built one: the accepted one has an extra
  // inner SEQUENCE between the [4] tag and the RDN content that a strict IMPLICIT
  // reading would omit.
  const dirNameContent = nameContent([
    { oid: OID.egsSerialNumber, value: sanitizedSerial, type: 'utf8' },
    { oid: OID.userId, value: sanitizedVat, type: 'utf8' },
    { oid: OID.title, value: invoiceType, type: 'utf8' },
    { oid: OID.registeredAddress, value: location, type: 'utf8' },
    { oid: OID.businessCategory, value: industry, type: 'utf8' },
  ]);
  const subjectAltNameExt = der.sequence(
    der.oid(OID.subjectAltName),
    der.octetString(der.sequence(der.context(4, true, der.sequence(dirNameContent))))
  );

  // ZATCA-required certificate-template marker — value is a raw UTF8String TLV nested
  // inside the extension's OCTET STRING (matches openssl config's `ASN1:UTF8String:...`
  // extension syntax). Without this, ZATCA's real CSR endpoint rejects the request
  // outright with a generic error — confirmed missing from this CSR before, and adding
  // it is what actually got real CSID issuance working end-to-end.
  const certificateTemplateNameExt = der.sequence(
    der.oid(OID.certificateTemplateName),
    der.octetString(der.utf8String(params.production ? 'ZATCA-Code-Signing' : 'TSTZATCA-Code-Signing'))
  );

  const extensionRequestAttr = der.sequence(
    der.oid(OID.extensionRequest),
    der.set(der.sequence(certificateTemplateNameExt, subjectAltNameExt))
  );

  // CertificationRequestInfo.attributes is `[0] IMPLICIT SET OF Attribute` — the SET's
  // own tag (0x31) is replaced by the context tag, wrapping the one Attribute directly.
  const attributesField = der.context(0, true, extensionRequestAttr);

  const certificationRequestInfo = der.sequence(
    der.integer(0),
    subjectName,
    subjectPublicKeyInfo,
    attributesField
  );

  const signature = crypto.sign('sha256', certificationRequestInfo, { key: privateKeyPem, dsaEncoding: 'der' });
  const signatureAlgorithm = der.sequence(der.oid(OID.ecdsaWithSha256));

  const certificationRequest = der.sequence(
    certificationRequestInfo,
    signatureAlgorithm,
    der.bitString(signature, 0)
  );

  const base64Body = certificationRequest.toString('base64').match(/.{1,64}/g)!.join('\n');
  const pem = `-----BEGIN CERTIFICATE REQUEST-----\n${base64Body}\n-----END CERTIFICATE REQUEST-----\n`;

  return Buffer.from(pem).toString('base64');
}

/**
  * SHA-256 Digest in Base64
  */
export function sha256Base64(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('base64');
}

/**
  * SHA-256 Digest in Hex
  */
export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
  * ZATCA TLV (Type-Length-Value) Base64 Encoder for QR Codes
  * Tags 1 to 9 as specified by ZATCA
  */
export interface TlvTag {
  tag: number;
  value: string | Buffer;
}

export function encodeZatcaTlv(tags: TlvTag[]): string {
  const buffers: Buffer[] = [];

  for (const t of tags) {
    const tagBuf = Buffer.from([t.tag]);
    const valBuf = Buffer.isBuffer(t.value) ? t.value : Buffer.from(t.value, 'utf8');
    const lenBuf = Buffer.from([valBuf.length]);
    buffers.push(Buffer.concat([tagBuf, lenBuf, valBuf]));
  }

  return Buffer.concat(buffers).toString('base64');
}

/**
  * Sign invoice hash using private key. Signs the raw digest bytes (not the base64 text
  * representation) — standard ECDSA-over-a-hash practice, and what ZATCA's own reference
  * tooling does; signing the base64 string's UTF8 bytes instead (the previous behavior
  * here) produces a signature that XAdES verification against the real digest rejects.
  */
export function signInvoiceHash(invoiceHashBase64: string, privateKeyPem: string): string {
  const hashBytes = Buffer.from(invoiceHashBase64, 'base64');
  const signer = crypto.createSign('SHA256');
  signer.update(hashBytes);
  signer.end();
  return signer.sign(privateKeyPem, 'base64');
}
