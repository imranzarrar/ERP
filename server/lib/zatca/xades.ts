import crypto from 'crypto';
import { decodeZatcaCsidCertificate, ZatcaCertificateInfo } from './x509.js';

// ZATCA's documented digest convention for CertDigest / SignedProperties digest: sha256
// hex-encoded, then the HEX STRING's own ASCII bytes are base64'd — a double-encoding
// confirmed against a real, working reference implementation (not derivable from the
// plain spec text alone). Distinct from the invoice hash itself, which is a normal
// base64(sha256(bytes)) — see hashChain.ts.
function zatcaWeirdDigest(input: string | Buffer): string {
  const hex = crypto.createHash('sha256').update(input).digest('hex');
  return Buffer.from(hex).toString('base64');
}

// Ground truth for both of the functions below was obtained by directly reverse-running
// ZATCA's own official SDK (decompiled `com.zatca.sdk.util.Utils.getNodeXmlValue` /
// `com.zatca.sdk.service.validation.signature.SignatureValidator`) against ZATCA's own
// genuinely-valid sample invoice (Data/Samples/Simplified/Invoice/Simplified_Invoice.xml)
// — a real Java test parsing that exact file with the SDK's bundled dom4j, XPath-selecting
// xades:SignedProperties, and hashing `node.asXML()` reproduced that sample's own embedded
// digest value byte-for-byte. Two things fell out of that experiment that aren't
// discoverable from the spec or the manual:
//
// 1. The SOURCE document (what gets embedded in the final signed XML) declares NO local
//    `xmlns:xades`/`xmlns:ds` anywhere in this subtree — it relies entirely on namespaces
//    inherited from real ancestors (`xades:QualifyingProperties`, `ds:Signature`).
// 2. dom4j's `Node.asXML()`, when serializing that node in ISOLATION (as SignatureValidator
//    does — it re-parses the submitted document and extracts just this node before
//    hashing), auto-hoists those same inherited declarations onto every element that uses
//    the prefix. That hoisted, self-contained string — not the bare source form — is what
//    actually gets hashed.
//
// So there are genuinely two different strings: one embedded as-is (no local xmlns), one
// used only to compute the digest (dom4j's hoisted form). Conflating them (either by
// embedding the hoisted form, or by hashing the bare form) produces a self-consistent but
// wrong digest — confirmed by two earlier failed attempts, both rejected by the real
// ZATCA sandbox validator with "wrong xadesSignedPropertiesDigestValue".
function buildSignedPropertiesEmbedded(signTimestamp: string, certHash: string, certIssuer: string, certSerial: string): string {
  return `<xades:SignedProperties Id="xadesSignedProperties">
                                    <xades:SignedSignatureProperties>
                                        <xades:SigningTime>${signTimestamp}</xades:SigningTime>
                                        <xades:SigningCertificate>
                                            <xades:Cert>
                                                <xades:CertDigest>
                                                    <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                                    <ds:DigestValue>${certHash}</ds:DigestValue>
                                                </xades:CertDigest>
                                                <xades:IssuerSerial>
                                                    <ds:X509IssuerName>${certIssuer}</ds:X509IssuerName>
                                                    <ds:X509SerialNumber>${certSerial}</ds:X509SerialNumber>
                                                </xades:IssuerSerial>
                                            </xades:Cert>
                                        </xades:SigningCertificate>
                                    </xades:SignedSignatureProperties>
                                </xades:SignedProperties>`;
}

// Same content, structure, and indentation as buildSignedPropertiesEmbedded — this is
// ONLY ever hashed, never embedded — but with xmlns:xades/xmlns:ds re-declared on every
// element that uses them, matching dom4j's real auto-hoisting behavior on isolated-node
// serialization (verified byte-for-byte, see comment above).
function buildSignedPropertiesForHashing(signTimestamp: string, certHash: string, certIssuer: string, certSerial: string): string {
  return `<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="xadesSignedProperties">
                                    <xades:SignedSignatureProperties>
                                        <xades:SigningTime>${signTimestamp}</xades:SigningTime>
                                        <xades:SigningCertificate>
                                            <xades:Cert>
                                                <xades:CertDigest>
                                                    <ds:DigestMethod xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                                    <ds:DigestValue xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${certHash}</ds:DigestValue>
                                                </xades:CertDigest>
                                                <xades:IssuerSerial>
                                                    <ds:X509IssuerName xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${certIssuer}</ds:X509IssuerName>
                                                    <ds:X509SerialNumber xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${certSerial}</ds:X509SerialNumber>
                                                </xades:IssuerSerial>
                                            </xades:Cert>
                                        </xades:SigningCertificate>
                                    </xades:SignedSignatureProperties>
                                </xades:SignedProperties>`;
}

function buildUblExtensionsBlock(
  invoiceHash: string,
  signedPropertiesHash: string,
  digitalSignature: string,
  certificateBody: string,
  signedPropertiesXml: string
): string {
  return `
    <ext:UBLExtension>
        <ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>
        <ext:ExtensionContent>
            <sig:UBLDocumentSignatures
                    xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2"
                    xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2"
                    xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2">
                <sac:SignatureInformation>
                    <cbc:ID>urn:oasis:names:specification:ubl:signature:1</cbc:ID>
                    <sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>
                    <ds:Signature Id="signature" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
                        <ds:SignedInfo>
                            <ds:CanonicalizationMethod
                                    Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
                            <ds:SignatureMethod
                                    Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"/>
                            <ds:Reference Id="invoiceSignedData" URI="">
                                <ds:Transforms>
                                    <ds:Transform
                                            Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::ext:UBLExtensions)</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform
                                            Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::cac:Signature)</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform
                                            Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform
                                            Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
                                </ds:Transforms>
                                <ds:DigestMethod
                                        Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                <ds:DigestValue>${invoiceHash}</ds:DigestValue>
                            </ds:Reference>
                            <ds:Reference
                                    Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties"
                                    URI="#xadesSignedProperties">
                                <ds:DigestMethod
                                        Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                <ds:DigestValue>${signedPropertiesHash}</ds:DigestValue>
                            </ds:Reference>
                        </ds:SignedInfo>
                        <ds:SignatureValue>${digitalSignature}</ds:SignatureValue>
                        <ds:KeyInfo>
                            <ds:X509Data>
                                <ds:X509Certificate>${certificateBody}</ds:X509Certificate>
                            </ds:X509Data>
                        </ds:KeyInfo>
                        <ds:Object>
                            <xades:QualifyingProperties Target="signature"
                                                        xmlns:xades="http://uri.etsi.org/01903/v1.3.2#">
                                ${signedPropertiesXml}
                            </xades:QualifyingProperties>
                        </ds:Object>
                    </ds:Signature>
                </sac:SignatureInformation>
            </sig:UBLDocumentSignatures>
        </ext:ExtensionContent>
    </ext:UBLExtension>`;
}

export interface XadesSignResult {
  ublExtensionsXml: string; // content to place inside <ext:UBLExtensions>...</ext:UBLExtensions>
  digitalSignatureBase64: string;
  certInfo: ZatcaCertificateInfo;
}

// Builds the full XAdES-BES enveloped signature block (BS: KSA-15) required by ZATCA for
// Simplified/B2C invoices (BR-KSA-28/29/30/60). `invoiceHashBase64` must already be the
// real canonicalized hash (see hashChain.ts) of the document with UBLExtensions/
// Signature/QR stripped — computing it is unaffected by this block's own presence.
export function buildXadesSignature(invoiceHashBase64: string, binarySecurityToken: string, privateKeyPem: string): XadesSignResult {
  const certInfo = decodeZatcaCsidCertificate(binarySecurityToken);

  // BS: KSA-15 — invoice hash signed with the EGS private key. Confirmed against ZATCA's
  // own official Java SDK (decompiled): it calls `Signature.getInstance("SHA256withECDSA")`
  // over the raw hash bytes and base64-encodes the result directly — Java's default
  // ECDSA signature encoding is ASN.1 DER, the same thing Node's crypto.sign produces, and
  // "SHA256withECDSA" re-hashes its input (the already-hashed invoice digest) with SHA256
  // before the ECDSA step, same as this call. No P1363 conversion anywhere in the real
  // reference implementation, despite the Developer Portal Manual's P1363 language.
  const hashBytes = Buffer.from(invoiceHashBase64, 'base64');
  const signer = crypto.createSign('SHA256');
  signer.update(hashBytes);
  signer.end();
  const digitalSignatureBase64 = signer.sign(privateKeyPem, 'base64');

  // No trailing "Z" and no milliseconds — confirmed against ZATCA's own official SDK
  // (decompiled): `DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss")` over
  // `LocalDateTime.now()`, a zone-less local timestamp. This value is embedded inside
  // the hashed SignedProperties block, so a format mismatch here changes the digest.
  const signTimestamp = new Date().toISOString().replace(/\.\d{3}Z$/, '');

  const signedPropertiesEmbedded = buildSignedPropertiesEmbedded(signTimestamp, certInfo.hash, certInfo.issuer, certInfo.serialNumber);
  const signedPropertiesForHashing = buildSignedPropertiesForHashing(signTimestamp, certInfo.hash, certInfo.issuer, certInfo.serialNumber);
  const signedPropertiesHash = zatcaWeirdDigest(signedPropertiesForHashing);

  // binarySecurityToken decodes to the PEM body text directly — that's what goes inside
  // ds:X509Certificate, not the outer (still-base64) token used for Basic Auth elsewhere.
  const certificateBody = Buffer.from(binarySecurityToken, 'base64').toString('utf8').trim();

  const ublExtensionsXml = buildUblExtensionsBlock(
    invoiceHashBase64,
    signedPropertiesHash,
    digitalSignatureBase64,
    certificateBody,
    signedPropertiesEmbedded
  );

  return { ublExtensionsXml, digitalSignatureBase64, certInfo };
}
