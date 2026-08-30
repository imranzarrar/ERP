import { db } from '../../../src/db/index.js';
import * as schema from '../../../src/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { sha256Base64 } from './crypto.js';
import { generateId } from '../../../src/id.js';
import { DOMParser } from '@xmldom/xmldom';
import { XmlCanonicalizer } from 'xmldsigjs';

export type ZatcaEnvironment = 'sandbox' | 'simulation' | 'production';

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
  * Retrieves the next ICV and previous invoice hash for a given company, scoped to one
  * ZATCA environment. Sandbox, Simulation, and Production are entirely separate ZATCA
  * backends with zero shared submission history (see CLAUDE.md's ZATCA section) — a point
  * lookup on `zatcaChainState`'s `(companyId, environment)` row, not a scan of `invoices`,
  * so this stays O(1) regardless of how large a tenant's invoice history grows. Invoice,
  * CreditNote, and DebitNote for one company share a single continuous sequence — there is
  * deliberately no `documentType` dimension here, matching ZATCA's chain-integrity model.
  *
  * Pass a locked transaction when this reservation must be durable and race-free — every
  * real caller already holds a row lock on the `companies` row for the duration of the
  * reservation (see processInvoiceZatca), which fully serializes concurrent calls for the
  * same company; this function does not need its own separate lock on top of that. The
  * default `db` executor is read-only/unlocked and safe only for display purposes (e.g.
  * "next ICV" shown in the onboarding status panel) where a stale read has no consequence.
  */
export async function getNextHashChainState(companyId: string, environment: ZatcaEnvironment, executor: any = db): Promise<HashChainState> {
  const [state] = await executor.select({
    currentIcv: schema.zatcaChainState.currentIcv,
    currentHash: schema.zatcaChainState.currentHash,
  })
  .from(schema.zatcaChainState)
  .where(and(eq(schema.zatcaChainState.companyId, companyId), eq(schema.zatcaChainState.environment, environment)));

  if (!state || !state.currentIcv) {
    return {
      icv: 1,
      previousInvoiceHash: INITIAL_PREVIOUS_INVOICE_HASH,
    };
  }

  return {
    icv: state.currentIcv + 1,
    previousInvoiceHash: state.currentHash || INITIAL_PREVIOUS_INVOICE_HASH,
  };
}

/**
  * True if `icv` is still the actual tip of this company's chain for this environment —
  * i.e. nothing else has been generated at a later position since. Used to decide whether
  * a stalled invoice's original reservation can still be safely reused/rolled back
  * (processInvoiceZatca's resubmission logic, and the cancel-route rollback) or whether it
  * has already been superseded and must be treated as permanently burned.
  */
export async function isStillChainTip(companyId: string, environment: ZatcaEnvironment, icv: number, executor: any = db): Promise<boolean> {
  const [state] = await executor.select({ currentIcv: schema.zatcaChainState.currentIcv })
    .from(schema.zatcaChainState)
    .where(and(eq(schema.zatcaChainState.companyId, companyId), eq(schema.zatcaChainState.environment, environment)));
  return !!state && state.currentIcv === icv;
}

/**
  * Durably sets this company's chain-state tip for one environment to an exact
  * (icv, hash) pair — upserting the `zatcaChainState` row. Used both to advance the chain
  * forward after a real reservation (icv/hash of the document just built) and to roll it
  * back on cancellation of an invoice that never reached ZATCA and was still the tip
  * (icv-1/previousInvoiceHash of the cancelled invoice — see the cancel route). Must be
  * called under the same company-row lock as the read that decided the new value.
  */
export async function setHashChainState(companyId: string, environment: ZatcaEnvironment, icv: number, hash: string | null, executor: any = db): Promise<void> {
  const [existing] = await executor.select({ id: schema.zatcaChainState.id })
    .from(schema.zatcaChainState)
    .where(and(eq(schema.zatcaChainState.companyId, companyId), eq(schema.zatcaChainState.environment, environment)));

  if (existing) {
    await executor.update(schema.zatcaChainState)
      .set({ currentIcv: icv, currentHash: hash, updatedAt: new Date() })
      .where(eq(schema.zatcaChainState.id, existing.id));
  } else {
    await executor.insert(schema.zatcaChainState).values({
      id: generateId(),
      companyId,
      environment,
      currentIcv: icv,
      currentHash: hash,
      updatedAt: new Date(),
    });
  }
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
