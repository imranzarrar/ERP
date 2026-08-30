import { encodeZatcaTlv, signInvoiceHash } from './crypto.js';
import { computeInvoiceHash } from './hashChain.js';
import { buildXadesSignature } from './xades.js';

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface ZatcaInvoiceData {
  invoiceNumber: string; // e.g. INV-2026-0001
  uuid: string; // UUID v4
  issueDate: string; // YYYY-MM-DD
  issueTime: string; // HH:mm:ss
  supplyDate?: string; // YYYY-MM-DD — KSA-5, defaults to issueDate when not tracked separately
  invoiceTypeCode: '388' | '0200000'; // '388' = Standard B2B, '0200000' = Simplified B2C
  // The actual UBL document-type numeric code: 388 = Invoice, 381 = Credit Note, 383 =
  // Debit Note (confirmed against the ZATCA SDK's own bundled sample Credit/Debit Note
  // XMLs — same <Invoice> UBL root and schema for all three, only this code plus
  // BillingReference/PaymentMeans differ). Defaults to '388' so every existing caller
  // (real invoices) is unaffected.
  documentSubtypeCode?: '388' | '381' | '383';
  // Credit/Debit Notes reference the original invoice they adjust — the sample shows
  // amounts stay POSITIVE (not negated) even though the document represents a refund/
  // reduction; ZATCA distinguishes intent via documentSubtypeCode, not sign.
  billingReference?: { invoiceNumber: string };
  // Required alongside billingReference — ZATCA's sample Credit/Debit Notes both carry
  // a <cac:PaymentMeans><cbc:PaymentMeansCode>10</cbc:PaymentMeansCode> block with an
  // instruction note explaining the adjustment; regular invoices omit this entirely.
  paymentMeansNote?: string;
  currency: string; // e.g. 'SAR'
  icv: number;
  previousInvoiceHash: string;
  seller: {
    name: string;
    tin: string;
    crNumber?: string;
    street: string;
    buildingNumber: string;
    district: string;
    city: string;
    postalCode: string;
    countryCode?: string;
  };
  buyer?: {
    name: string;
    tin?: string;
    street?: string;
    buildingNumber?: string;
    district?: string;
    city?: string;
    postalCode?: string;
    countryCode?: string;
  };
  items: Array<{
    name: string;
    quantity: number;
    unitPrice: number;
    subtotal: number;
    vatRate: number; // e.g. 15 for 15%
    vatAmount: number;
    totalAmount: number;
    // UNCL5305 tax category code — 'S' (Standard), 'Z' (Zero-rated), 'E' (Exempt), or 'O'
    // (Out of scope). Defaults to 'S' for callers that don't resolve it (e.g. the
    // compliance-suite's synthetic 15% samples, which are genuinely Standard-rated).
    taxCategoryCode?: string;
    // Required by ZATCA (BR-KSA-23 and related) whenever taxCategoryCode is 'E' (Exempt)
    // or 'Z' (Zero-rated) — the specific VATEX-SA-xx code/text is a real legal
    // classification that varies per company (see src/db/schema.ts's taxSlabs comment
    // for why there's no safe generic default). Omitted from the XML entirely when unset,
    // which reproduces today's existing (non-blocking, sandbox-only) warning rather than
    // emitting a fabricated code.
    exemptionReasonCode?: string;
    exemptionReason?: string;
    // The gap between (quantity * unitPrice) and subtotal — i.e. any per-item discount
    // plus this line's share of a header-level percentage discount, combined. Must be
    // declared as its own cac:AllowanceCharge (BR-KSA-EN16931-11): subtotal already has
    // this baked in while unitPrice stays the raw, undiscounted price, so without this
    // element ZATCA's own line-net-amount reconciliation (quantity * PriceAmount) no
    // longer equals LineExtensionAmount on any discounted line — exactly the warning this
    // field exists to eliminate. Omitted (no AllowanceCharge emitted) when zero.
    lineDiscountAmount?: number;
    // UN/ECE Recommendation 20 unit-of-measure code (see src/zatcaUnitCodes.ts) —
    // previously this whole field didn't exist and every line was hardcoded to 'PCE'
    // regardless of what was actually sold. Defaults to 'PCE' here too for callers that
    // don't resolve it (e.g. the compliance-suite's synthetic samples).
    unitCode?: string;
  }>;
  subtotal: number;
  totalVat: number;
  grandTotal: number;
  privateKeyPem?: string;
  certificatePem?: string;
}

export interface GeneratedZatcaDocument {
  xmlContent: string;
  invoiceHashBase64: string;
  qrCodeBase64: string;
  signedXmlContent: string;
}

export function generateZatcaUblXml(data: ZatcaInvoiceData): GeneratedZatcaDocument {
  const isSimplified = data.invoiceTypeCode === '0200000';
  // ZATCA's BT-23 business-process value is fixed at "reporting:1.0" for every e-invoice
  // regardless of Standard vs. Simplified — clearance vs. reporting is decided by which
  // physical API endpoint the signed XML is submitted to (and KSA-2 below), not by this
  // field. Confirmed against a real ZATCA validation response (BR-KSA-EN16931-01) after
  // this was previously set to "clearance:1.0" for Standard invoices.
  const profileId = 'reporting:1.0';
  const subType = isSimplified ? '0200000' : '0100000';
  const documentSubtypeCode = data.documentSubtypeCode || '388';

  const sellerTin = (data.seller.tin || '300000000000003').padEnd(15, '0');
  const sellerBuilding = (data.seller.buildingNumber || '1234').padEnd(4, '0');
  const sellerPostal = (data.seller.postalCode || '12345').padEnd(5, '0');
  // ZATCA's own schematron (BR-KSA-F-08) requires the CRN scheme's Other Seller ID to be
  // exactly 10 numeric digits. Confirmed live: ZATCA's own sandbox test certificate for
  // this shared identity embeds a genuinely 9-digit CR ("886431145", extracted verbatim
  // in x509.ts's extractZatcaCertificateTaxpayerIdentity from the cert's own Subject CN
  // "TST-886431145-..." — not a parsing bug, the certificate itself is 9 digits) —
  // left-padding with a leading zero is the standard normalization for a legacy 9-digit
  // Saudi CR number to the current 10-digit format, and satisfies the schematron's
  // structural check without fabricating a digit ZATCA never actually issued. Padded only
  // here, at the point of XML emission — the stored crNumber value itself (shown as-is on
  // the printed invoice's own "CR:" line elsewhere) is intentionally left untouched.
  // Emitted for both Standard/B2B and Simplified/B2C invoices — tried gating this to B2B
  // only (seemed reasonable: the buyer never sees a B2C receipt's seller-ID field), but
  // ZATCA's real sandbox rejected the resulting XML with a NEW warning (BR-KSA-08, "seller
  // identification must exist") that doesn't distinguish B2B/B2C at all — confirmed this
  // field is unconditionally required, not tied to buyer type.
  const sellerCrNumber = (data.seller.crNumber || '1010000000').padStart(10, '0');

  // ZATCA (and EN16931's BR-CO-17/BR-CO-18) require one cac:TaxSubtotal PER DISTINCT tax
  // category actually present on the invoice — not one header-level subtotal derived from
  // whichever item happens to be first. An invoice mixing a 15%-rated line with a 0%
  // exempt line must report both categories separately here, each with its own taxable
  // amount and tax amount, or ZATCA's schematron rejects the VAT breakdown as
  // inconsistent with the line totals.
  const taxGroups = new Map<string, { rate: number; code: string; taxableAmount: number; taxAmount: number; exemptionReasonCode?: string; exemptionReason?: string }>();
  for (const item of data.items) {
    const code = item.taxCategoryCode || 'S';
    // Exemption reason is part of the grouping key, not just the code+rate — two Exempt
    // slabs at the same 0% rate but with genuinely different legal reasons (e.g. real
    // estate vs. financial services) must not be silently merged into one TaxSubtotal.
    const key = `${code}|${item.vatRate}|${item.exemptionReasonCode || ''}`;
    const existing = taxGroups.get(key);
    if (existing) {
      existing.taxableAmount = round2(existing.taxableAmount + item.subtotal);
      existing.taxAmount = round2(existing.taxAmount + item.vatAmount);
    } else {
      taxGroups.set(key, { rate: item.vatRate, code, taxableAmount: item.subtotal, taxAmount: item.vatAmount, exemptionReasonCode: item.exemptionReasonCode, exemptionReason: item.exemptionReason });
    }
  }
  // TaxExemptionReasonCode/TaxExemptionReason only emitted when actually configured (see
  // the ZatcaInvoiceData.items comment above for why there's no fabricated default) —
  // required by ZATCA for 'E'/'Z' categories (BR-KSA-23 and related) once set.
  const taxSubtotalsXml = Array.from(taxGroups.values()).map(group => `    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${data.currency}">${group.taxableAmount.toFixed(2)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${data.currency}">${group.taxAmount.toFixed(2)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>${group.code}</cbc:ID>
        <cbc:Percent>${group.rate.toFixed(2)}</cbc:Percent>
        ${group.exemptionReasonCode ? `<cbc:TaxExemptionReasonCode>${escapeXml(group.exemptionReasonCode)}</cbc:TaxExemptionReasonCode>` : ''}
        ${group.exemptionReason ? `<cbc:TaxExemptionReason>${escapeXml(group.exemptionReason)}</cbc:TaxExemptionReason>` : ''}
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`).join('\n');

  // Format Items XML
  const itemsXml = data.items.map((item, idx) => `
    <cac:InvoiceLine>
      <cbc:ID>${idx + 1}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="${escapeXml(item.unitCode || 'PCE')}">${item.quantity}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="${data.currency}">${item.subtotal.toFixed(2)}</cbc:LineExtensionAmount>
      ${item.lineDiscountAmount && item.lineDiscountAmount > 0 ? `<cac:AllowanceCharge>
        <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
        <cbc:AllowanceChargeReason>Discount</cbc:AllowanceChargeReason>
        <cbc:Amount currencyID="${data.currency}">${item.lineDiscountAmount.toFixed(2)}</cbc:Amount>
      </cac:AllowanceCharge>` : ''}
      <cac:TaxTotal>
        <cbc:TaxAmount currencyID="${data.currency}">${item.vatAmount.toFixed(2)}</cbc:TaxAmount>
        <cbc:RoundingAmount currencyID="${data.currency}">${item.totalAmount.toFixed(2)}</cbc:RoundingAmount>
      </cac:TaxTotal>
      <cac:Item>
        <cbc:Name>${escapeXml(item.name)}</cbc:Name>
        <cac:ClassifiedTaxCategory>
          <cbc:ID>${item.taxCategoryCode || 'S'}</cbc:ID>
          <cbc:Percent>${item.vatRate}</cbc:Percent>
          ${item.exemptionReasonCode ? `<cbc:TaxExemptionReasonCode>${escapeXml(item.exemptionReasonCode)}</cbc:TaxExemptionReasonCode>` : ''}
          ${item.exemptionReason ? `<cbc:TaxExemptionReason>${escapeXml(item.exemptionReason)}</cbc:TaxExemptionReason>` : ''}
          <cac:TaxScheme>
            <cbc:ID>VAT</cbc:ID>
          </cac:TaxScheme>
        </cac:ClassifiedTaxCategory>
      </cac:Item>
      <cac:Price>
        <cbc:PriceAmount currencyID="${data.currency}">${item.unitPrice.toFixed(2)}</cbc:PriceAmount>
      </cac:Price>
    </cac:InvoiceLine>`).join('\n');

  // Real signing (BS: KSA-15 / BR-KSA-28-30/60) requires both a private key and the
  // issued CSID certificate — without both, the block is omitted entirely rather than
  // emitted empty/malformed, preserving prior behavior for any caller that doesn't
  // supply a cert (e.g. a preview generated before onboarding).
  const willSign = Boolean(data.privateKeyPem && data.certificatePem);
  const ublExtensionsPlaceholder = willSign
    ? `<ext:UBLExtensions>SET_UBL_EXTENSIONS_STRING</ext:UBLExtensions>\n  `
    : '';
  const signaturePlaceholder = willSign
    ? `<cac:Signature>
    <cbc:ID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ID>
    <cbc:SignatureMethod>urn:oasis:names:specification:ubl:dsig:enveloped:xades</cbc:SignatureMethod>
  </cac:Signature>\n  `
    : '';

  // Raw UBL XML without signature
  const rawXml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
         xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  ${ublExtensionsPlaceholder}<cbc:ProfileID>${profileId}</cbc:ProfileID>
  <cbc:ID>${escapeXml(data.invoiceNumber)}</cbc:ID>
  <cbc:UUID>${data.uuid}</cbc:UUID>
  <cbc:IssueDate>${data.issueDate}</cbc:IssueDate>
  <cbc:IssueTime>${data.issueTime}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="${subType}">${documentSubtypeCode}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${data.currency}</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>${data.currency}</cbc:TaxCurrencyCode>
  ${data.billingReference ? `<cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>${escapeXml(data.billingReference.invoiceNumber)}</cbc:ID>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>
  ` : ''}<cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>${data.icv}</cbc:UUID>
  </cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${data.previousInvoiceHash}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference>
    <cbc:ID>QR</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">SET_QR_CODE_DATA</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
  ${signaturePlaceholder}<cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="CRN">${escapeXml(sellerCrNumber)}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PostalAddress>
        <cbc:StreetName>${escapeXml(data.seller.street || 'King Fahd Road')}</cbc:StreetName>
        <cbc:BuildingNumber>${sellerBuilding}</cbc:BuildingNumber>
        <cbc:CitySubdivisionName>${escapeXml(data.seller.district || 'Olaya')}</cbc:CitySubdivisionName>
        <cbc:CityName>${escapeXml(data.seller.city || 'Riyadh')}</cbc:CityName>
        <cbc:PostalZone>${sellerPostal}</cbc:PostalZone>
        <cac:Country>
          <cbc:IdentificationCode>${data.seller.countryCode || 'SA'}</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${sellerTin}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(data.seller.name)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>${data.buyer ? (() => {
    // ZATCA's schematron (BR-KSA-63) only requires the buyer's full address when the
    // invoice type's `name` attribute matches Standard/B2B ("0100000") — confirmed by
    // reading the rule directly (Data/Rules/Schematrons/...ZATCA_E-invoice_Validation_
    // Rules.xsl): it's gated on `boolean(//*[matches(@name, '01\d{5}')])`, which never
    // matches Simplified/B2C ("0200000"). For B2B, validateBuyerFields already enforces
    // real address data at customer-creation time, so these fields are always genuinely
    // present by the time an invoice is built. For B2C, they're usually absent — this
    // used to fabricate a placeholder address ('Main Street', building '5678', etc.)
    // regardless, submitting a fake address on a real customer's e-invoice record even
    // though ZATCA never actually requires or checks one for B2C. `cac:PostalAddress` is
    // minOccurs="0" on PartyType (confirmed against the UBL XSD), so it's safe to omit
    // entirely rather than invent data nobody provided.
    const hasAnyAddress = Boolean(data.buyer!.street || data.buyer!.buildingNumber || data.buyer!.district || data.buyer!.city || data.buyer!.postalCode);
    return `
    <cac:Party>
      ${hasAnyAddress ? `<cac:PostalAddress>
        ${data.buyer!.street ? `<cbc:StreetName>${escapeXml(data.buyer!.street)}</cbc:StreetName>` : ''}
        ${data.buyer!.buildingNumber ? `<cbc:BuildingNumber>${escapeXml(data.buyer!.buildingNumber)}</cbc:BuildingNumber>` : ''}
        ${data.buyer!.district ? `<cbc:CitySubdivisionName>${escapeXml(data.buyer!.district)}</cbc:CitySubdivisionName>` : ''}
        ${data.buyer!.city ? `<cbc:CityName>${escapeXml(data.buyer!.city)}</cbc:CityName>` : ''}
        ${data.buyer!.postalCode ? `<cbc:PostalZone>${escapeXml(data.buyer!.postalCode)}</cbc:PostalZone>` : ''}
        <cac:Country>
          <cbc:IdentificationCode>${data.buyer!.countryCode || 'SA'}</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>` : ''}
      ${data.buyer!.tin ? `<cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(data.buyer!.tin)}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>` : ''}
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(data.buyer!.name)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>`;
  })() : ''}
  </cac:AccountingCustomerParty>
  <cac:Delivery>
    <cbc:ActualDeliveryDate>${data.supplyDate || data.issueDate}</cbc:ActualDeliveryDate>
  </cac:Delivery>
  ${data.paymentMeansNote ? `<cac:PaymentMeans>
    <cbc:PaymentMeansCode>10</cbc:PaymentMeansCode>
    <cbc:InstructionNote>${escapeXml(data.paymentMeansNote)}</cbc:InstructionNote>
  </cac:PaymentMeans>
  ` : ''}<cac:TaxTotal>
    <cbc:TaxAmount currencyID="${data.currency}">${data.totalVat.toFixed(2)}</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${data.currency}">${data.totalVat.toFixed(2)}</cbc:TaxAmount>
${taxSubtotalsXml}
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${data.currency}">${data.subtotal.toFixed(2)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${data.currency}">${data.subtotal.toFixed(2)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${data.currency}">${data.grandTotal.toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${data.currency}">${data.grandTotal.toFixed(2)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  ${itemsXml}
</Invoice>`;

  // Build signed XML by embedding the ds namespace declaration first — the hash below
  // must be computed over the exact bytes actually submitted as the "invoice" field
  // (signedXmlContent), not the pre-namespace rawXml. Computing it over the wrong
  // variant here previously produced a hash ZATCA's real validator rejected with
  // "invalid-invoice-hash" even though the XML itself passed XSD validation — caught via
  // a real call to ZATCA's Compliance Invoice API, not guessed.
  const signedXmlContent = rawXml.replace(
    '<Invoice xmlns',
    `<Invoice xmlns:ds="http://www.w3.org/2000/09/xmldsig#"\n xmlns`
  );

  const invoiceHashBase64 = computeInvoiceHash(signedXmlContent);

  // Build ZATCA TLV QR Code Tags. Signed invoices carry the full 9-tag cryptographic
  // stamp (BR-KSA-27 + BS: KSA-15..19: seller/VAT/timestamp/totals, hash, digital
  // signature, public key, and the CSID certificate's own signature); unsigned ones fall
  // back to the basic 5-tag set plus a placeholder signature tag, matching prior behavior
  // for any caller without a real cert (e.g. a pre-onboarding preview).
  // No trailing "Z" — confirmed against ZATCA's own official SDK, which formats this QR
  // field as `yyyy-MM-dd'T'HH:mm:ss` with no zone suffix, matching cbc:IssueDate/IssueTime
  // verbatim (real ZATCA sandbox flagged the "Z"-suffixed form as a timestamp mismatch).
  const timestampIso = `${data.issueDate}T${data.issueTime}`;
  let signatureBase64: string;
  let ublExtensionsXml = '';
  let qrTags: Array<{ tag: number; value: string | Buffer }>;

  // Tags 1-7 are all UTF8-text-encoded (tag 6/7 carry their base64 *string* forms as
  // text, not decoded to raw bytes) — confirmed against ZATCA's own official Java SDK
  // (decompiled): `BerTlvBuilder.addText(...)` for 1-6, and tag 7 uses
  // `digitalSignature.getBytes()` where digitalSignature is already the base64 string,
  // functionally identical to addText for ASCII content. Tags 8/9 are the only genuinely
  // binary ones: tag 8 (public key) is ALWAYS present once signed, tag 9 (CSID
  // certificate's own CA signature) ONLY for Simplified/B2C — same SDK, same method.
  if (willSign) {
    const xades = buildXadesSignature(invoiceHashBase64, data.certificatePem!, data.privateKeyPem!);
    signatureBase64 = xades.digitalSignatureBase64;
    ublExtensionsXml = xades.ublExtensionsXml;
    qrTags = [
      { tag: 1, value: data.seller.name },
      { tag: 2, value: sellerTin },
      { tag: 3, value: timestampIso },
      { tag: 4, value: data.grandTotal.toFixed(2) },
      { tag: 5, value: data.totalVat.toFixed(2) },
      { tag: 6, value: invoiceHashBase64 },
      { tag: 7, value: signatureBase64 },
      { tag: 8, value: xades.certInfo.publicKeySpkiDer },
    ];
    if (isSimplified) {
      qrTags.push({ tag: 9, value: xades.certInfo.signatureDer });
    }
  } else {
    signatureBase64 = data.privateKeyPem
      ? signInvoiceHash(invoiceHashBase64, data.privateKeyPem)
      : Buffer.from(`MOCK_SIG_${invoiceHashBase64.substring(0, 20)}`).toString('base64');
    qrTags = [
      { tag: 1, value: data.seller.name },
      { tag: 2, value: sellerTin },
      { tag: 3, value: timestampIso },
      { tag: 4, value: data.grandTotal.toFixed(2) },
      { tag: 5, value: data.totalVat.toFixed(2) },
      { tag: 6, value: invoiceHashBase64 },
      { tag: 7, value: signatureBase64 },
    ];
  }

  const qrCodeBase64 = encodeZatcaTlv(qrTags);

  // QR/UBLExtensions content depends on the invoice hash/signature, which in turn are
  // computed from the XML with those nodes stripped (see computeInvoiceHash) — so both
  // placeholders are only substituted with their real values here, after everything is
  // known, and this substitution never affects the hash that was already computed.
  let finalXmlContent = rawXml.replace('SET_QR_CODE_DATA', qrCodeBase64);
  let finalSignedXmlContent = signedXmlContent.replace('SET_QR_CODE_DATA', qrCodeBase64);
  if (willSign) {
    finalXmlContent = finalXmlContent.replace('SET_UBL_EXTENSIONS_STRING', ublExtensionsXml);
    finalSignedXmlContent = finalSignedXmlContent.replace('SET_UBL_EXTENSIONS_STRING', ublExtensionsXml);
  }

  return {
    xmlContent: finalXmlContent,
    invoiceHashBase64,
    qrCodeBase64,
    signedXmlContent: finalSignedXmlContent,
  };
}

function escapeXml(unsafe: string): string {
  if (!unsafe) return '';
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
