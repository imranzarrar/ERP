import { db } from '../../../src/db/index.js';
import * as schema from '../../../src/db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { sha256Base64 } from './crypto.js';
import { DOMParser } from '@xmldom/xmldom';
import { XmlCanonicalizer } from 'xmldsigjs';

// ZATCA's well-known initial Previous Invoice Hash for the first invoice in a chain:
// Base64 of the ASCII hex STRING of SHA-256('0') (not the raw digest bytes — ZATCA's own
// spec calls for base64-encoding the hex representation). Independently verified via
// both Node's crypto module and `openssl dgst -sha256` against the literal character '0':
// SHA256('0') hex = 5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9.
// The previous value here ('NWZlY2ViNjZmZmM4NmEzOGA0OA==') decoded to a truncated,
// corrupted string ('5feceb66ffc86a38`48') that didn't match this hash at all — every
// chain's first invoice was carrying a genuinely wrong genesis PIH as a result, which is
// exactly what the SDK's local `-validate` caught (`[PIH] FAILED`, KSA-13) even for a
// chain's very first invoice, where ZATCA's real sandbox clearance API stayed silent
// because it doesn't audit the genesis link's exact value on submission.
export const INITIAL_PREVIOUS_INVOICE_HASH = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==';

export interface HashChainState {
  icv: number;
  previousInvoiceHash: string;
}

/**
  * Retrieves the next ICV and previous invoice hash for a given company.
  *
  * Pass a locked transaction (see reserveNextHashChainState below) when this reservation
  * must be durable and race-free; the default `db` executor is read-only/unlocked and
  * safe only for display purposes (e.g. "next ICV" shown in the onboarding status panel)
  * where a stale read has no consequence.
  */
export async function getNextHashChainState(companyId: string, executor: any = db): Promise<HashChainState> {
  const [lastInvoice] = await executor.select({
    icv: schema.invoices.icv,
    currentInvoiceHash: schema.invoices.currentInvoiceHash,
  })
  .from(schema.invoices)
  .where(eq(schema.invoices.companyId, companyId))
  .orderBy(desc(schema.invoices.icv))
  .limit(1);

  if (!lastInvoice || !lastInvoice.icv || lastInvoice.icv === 0) {
    return {
      icv: 1,
      previousInvoiceHash: INITIAL_PREVIOUS_INVOICE_HASH,
    };
  }

  return {
    icv: (lastInvoice.icv || 0) + 1,
    previousInvoiceHash: lastInvoice.currentInvoiceHash || INITIAL_PREVIOUS_INVOICE_HASH,
  };
}

/**
  * Computes the ZATCA invoice hash: SHA-256 over the XML-Signature-canonicalized
  * (Canonical XML 1.0, no comments — matching the algorithm ZATCA's own "fatoora" SDK
  * uses) form of the invoice, with the UBLExtensions/Signature/QR nodes stripped first
  * (those are derived FROM this hash, so including them would be circular).
  *
  * A plain SHA-256 of the raw serialized XML string does NOT match what ZATCA computes
  * — confirmed by testing directly against ZATCA's live Compliance Invoice API with real
  * sandbox credentials (XSD validation passed; a naive-hash submission was rejected with
  * "invalid-invoice-hash" every time). Real XML canonicalization is what closes that gap.
  */
export function computeInvoiceHash(xmlString: string): string {
  const dom = new DOMParser().parseFromString(xmlString, 'text/xml');
  const root = dom.documentElement;
  if (!root) throw new Error('computeInvoiceHash: failed to parse invoice XML');

  for (const tagName of ['ext:UBLExtensions', 'cac:Signature']) {
    const nodes = Array.from(root.getElementsByTagName(tagName));
    for (const node of nodes) node.parentNode?.removeChild(node);
  }
  // The QR code lives in its own AdditionalDocumentReference (cbc:ID = "QR") — strip
  // only that one, not the ICV/PIH references that share the same element name.
  const docRefs = Array.from(root.getElementsByTagName('cac:AdditionalDocumentReference'));
  for (const node of docRefs) {
    const idEl = node.getElementsByTagName('cbc:ID')[0];
    if (idEl?.textContent === 'QR') node.parentNode?.removeChild(node);
  }

  const canonicalizer = new XmlCanonicalizer(false, false);
  const canonicalXml = canonicalizer.Canonicalize(dom as unknown as Node);
  return sha256Base64(canonicalXml);
}
