import { db } from '../../../src/db/index.js';
import * as schema from '../../../src/db/schema.js';
import { eq, and, ne, inArray } from 'drizzle-orm';
import { getNextHashChainState, isStillChainTip, setHashChainState, ZatcaEnvironment } from './hashChain.js';
import { generateZatcaUblXml } from './xmlBuilder.js';
import { ZatcaApiClient } from './apiClient.js';
import { recordAuditLog } from '../audit.js';
import { validateBuyerFields } from './validators.js';
import { normalizeZatcaUnitCode } from '../../../src/zatcaUnitCodes.js';
import { decryptPrivateKey } from './keyEncryption.js';
import crypto from 'crypto';

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// UNCL5305 tax category inference — tax_slabs only stores a name + percentage, no
// explicit category code, so this is inferred from what's actually on file: a slab
// literally named "Exempt" maps to ZATCA's 'E' (Exempt) category; any other 0% slab maps
// to 'Z' (Zero-rated) rather than assuming Exempt, since KSA VAT law treats zero-rated
// and exempt goods as legally distinct categories with different reporting rules;
// anything above 0% is 'S' (Standard).
function resolveTaxCategoryCode(slabName: string | undefined, percentage: number): string {
  if (percentage === 0) {
    return slabName?.toLowerCase().includes('exempt') ? 'E' : 'Z';
  }
  return 'S';
}

export async function processInvoiceZatca(invoiceId: string) {
  // Hoisted above the try block (not `const` inside it) so the catch block below can
  // still attribute a thrown API error to the right company/environment for audit
  // logging, even if the failure happens partway through.
  let companyId: string | null = null;
  let environment: ZatcaEnvironment = 'sandbox';
  try {
    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
    if (!invoice) return { error: 'Invoice not found' };

    companyId = invoice.companyId;
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));
    environment = (company?.zatcaEnvironment as ZatcaEnvironment) || 'sandbox';

    // Master on/off switch — a company that hasn't enabled ZATCA (default for every new
    // company) must never attempt a real submission, regardless of environment. It must
    // still receive a genuine Phase-1-compliant QR (tags 1-5: seller name, VAT/TIN,
    // timestamp, grand total, VAT total — mandatory on every KSA VAT invoice regardless of
    // e-invoicing enrollment) so printed invoices are compliant from day one instead of
    // accumulating a backlog of QR-less invoices. See the `!zatcaEnabled` branch below,
    // which builds that preview QR/XML WITHOUT touching the real per-company hash chain
    // (icv/previousInvoiceHash) — that chain is genesis-linked and must only ever be
    // reserved once, in order, for invoices that actually get submitted. Once the company
    // later enables ZATCA, this same invoice gets resubmitted through the real path further
    // down and the signed Phase-2 QR (tags 1-9) overwrites this preview.
    const zatcaEnabled = Boolean((company as any)?.zatcaEnabled);

    // Mark as in-flight before any further processing (hash chain reservation, signing,
    // network call). Without this, an invoice sits at its stale creation-time status
    // ('NOT_SUBMITTED') for the entire duration of this async job — a window in which a
    // user could cancel the invoice locally, only for this already-in-flight submission
    // to still land as a genuine CLEARED/REPORTED at ZATCA moments later, leaving a
    // permanent ZATCA record with no Credit Note ever issued to reconcile it. Every
    // terminal branch below (DISABLED/NOT_SUBMITTED/ERROR/CLEARED/REPORTED/REJECTED)
    // overwrites this, so it is never left stuck. Skipped for the DISABLED-path preview
    // below — that path never reserves the hash chain or calls the network, so there is no
    // in-flight window a concurrent Cancel could race against.
    //
    // The `status != 'Cancelled'` guard is load-bearing, not defensive decoration: the
    // `invoice` row was fetched above with a plain (unlocked) SELECT, so by the time this
    // UPDATE actually runs, POST /invoices/:id/cancel could have already committed a
    // cancellation on the same row. Postgres evaluates an UPDATE's WHERE clause and its
    // SET atomically against the row's *current* state, not the stale copy this function
    // is holding in memory — so making the transition itself conditional (instead of
    // trusting the in-memory `invoice.status` read a moment earlier) is what actually
    // closes the race, regardless of which of the two requests happens to run first.
    // `.returning()` is how we find out whether the guard actually matched: zero rows back
    // means a concurrent cancel won, and this invoice must never reserve a hash-chain
    // position or reach ZATCA at all.
    if (zatcaEnabled) {
      // Also refuses a second concurrent call already in flight for this same invoice
      // (SUBMITTING) — without this, two near-simultaneous calls (e.g. a double-click on
      // "resubmit", or a race between the original fire-and-forget call and a fast manual
      // resubmit) could both pass this guard and both proceed to reserve a chain position,
      // wastefully burning an extra ICV for nothing once the fresh-mint resubmission logic
      // below no longer treats a stalled reservation as automatically safe to reuse.
      const [claimed] = await db.update(schema.invoices)
        .set({ zatcaStatus: 'SUBMITTING' })
        .where(and(
          eq(schema.invoices.id, invoiceId),
          ne(schema.invoices.status, 'Cancelled'),
          ne(schema.invoices.zatcaStatus, 'SUBMITTING'),
        ))
        .returning({ id: schema.invoices.id });
      if (!claimed) {
        return { error: 'Invoice was cancelled, or already has a submission in flight.' };
      }
    }

    const [config] = await db.select().from(schema.zatcaEnvironmentConfigs)
      .where(and(eq(schema.zatcaEnvironmentConfigs.companyId, companyId), eq(schema.zatcaEnvironmentConfigs.environment, environment)));
    // Per-branch seller address override — each outlet's real address shown to the buyer/
    // ZATCA, while the CSID/ICV chain stays shared for the whole company (confirmed
    // unaffected: nothing below touches signing or hashChain.ts). Overridden per-field,
    // not all-or-nothing, so a branch that's only set e.g. a different city doesn't lose
    // the company's own street/building fallback for whatever it hasn't set.
    const [branch] = (invoice as any).branchId
      ? await db.select().from(schema.branches).where(eq(schema.branches.id, (invoice as any).branchId))
      : [undefined];
    const sellerStreet = branch?.streetName || config?.streetName || 'King Fahd Rd';
    const sellerBuildingNumber = branch?.buildingNumber || config?.buildingNumber || '1234';
    const sellerDistrict = branch?.district || config?.district || 'Olaya';
    const sellerCity = branch?.city || config?.city || 'Riyadh';
    const sellerPostalCode = branch?.postalCode || config?.postalCode || '12345';
    const sellerCountryCode = branch?.countryCode || config?.countryCode || 'SA';
    const [customer] = invoice.customerId ? await db.select().from(schema.customers).where(eq(schema.customers.id, invoice.customerId)) : [undefined];
    const [taxSlab] = invoice.taxSlabId ? await db.select().from(schema.taxSlabs).where(eq(schema.taxSlabs.id, invoice.taxSlabId)) : [undefined];
    // Credit/Debit Note support — this row's own documentType decides which UBL
    // sub-document to build; both still flow through the exact same locked ICV/PIH
    // reservation below, since ZATCA's chain integrity spans every document type for a
    // company, not invoices alone.
    const documentType = (invoice as any).documentType || 'Invoice';
    const [originalInvoice] = (invoice as any).originalInvoiceId
      ? await db.select().from(schema.invoices).where(eq(schema.invoices.id, (invoice as any).originalInvoiceId))
      : [undefined];
    // invoices has no stored subtotal/total — line items live in the separate
    // invoice_items table and totals are always derived, matching how
    // POST /api/transactions/invoices computes them at creation time.
    const invoiceItemRows = await db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, invoiceId));

    // Each line can carry its own tax_slab_id (falls back to the invoice's header slab
    // when not set) — resolve every distinct slab actually referenced in one query rather
    // than forcing every line onto the header rate regardless of what it was sold under.
    const distinctSlabIds = Array.from(new Set(
      invoiceItemRows.map(it => it.taxSlabId).filter((id): id is string => Boolean(id))
    ));
    const referencedSlabs = distinctSlabIds.length > 0
      ? await db.select().from(schema.taxSlabs).where(inArray(schema.taxSlabs.id, distinctSlabIds))
      : [];
    const slabById = new Map(referencedSlabs.map(s => [s.id, s]));

    const inv = invoice as any;
    const vatRate = taxSlab ? Number(taxSlab.percentage) : 15;
    // B2C -> Simplified (0200000); B2B (or no buyer classification) -> Standard (388).
    // POS sales don't override this — a POS sale to a B2B-flagged customer is still
    // Standard, and a non-POS sale to a B2C-flagged customer is still Simplified.
    const isSimplified = customer ? customer.buyerType === 'B2C' : Boolean(inv.isPosSale);
    const invoiceTypeCode = isSimplified ? '0200000' : '388';

    // Final gate: never build/send a ZATCA XML for a B2B customer missing the identity
    // ZATCA requires for a valid AccountingCustomerParty — the customer/vendor routes
    // validate this at save time too, but a record saved before that validation existed
    // (or edited directly) must not silently produce a doomed submission here. Only applies
    // to the real (zatcaEnabled) submission path — the DISABLED-path preview QR below only
    // ever needs seller fields (tags 1-5), so an incomplete buyer never blocks a company
    // from getting a compliant Phase-1 QR on a printed invoice before ZATCA is even turned
    // on for them.
    if (zatcaEnabled && customer) {
      const buyerErrors = validateBuyerFields(customer.buyerType, customer as any);
      if (buyerErrors.length > 0) {
        await db.update(schema.invoices)
          .set({
            zatcaStatus: 'NOT_SUBMITTED',
            zatcaValidationResults: [{ code: 'BUYER_INCOMPLETE', message: `Customer "${customer.name}" is missing required ZATCA fields: ${buyerErrors.map(e => e.message).join(' ')}` }] as any,
          })
          .where(eq(schema.invoices.id, invoiceId));
        return { success: false, status: 'NOT_SUBMITTED', error: `Customer "${customer.name}" is missing required ZATCA fields: ${buyerErrors.map(e => e.message).join(' ')}` };
      }
    }

    // Header discount shrinks every line proportionally (same % reduction across the
    // board), matching dbStore.ts's calculateInvoiceTotals exactly — then each line's own
    // resolved rate (its own tax_slab_id if set, else the invoice's header slab) is
    // applied to ITS OWN discounted amount, not one shared rate applied to everything.
    const itemsSubtotalRaw = round2(invoiceItemRows.reduce((acc, it) => {
      const unitCost = round2(Number(it.unitCost));
      const discount = round2(Number(it.discountAmount || 0));
      const netUnitCost = round2(Math.max(0, unitCost - discount));
      return acc + round2(netUnitCost * Number(it.quantity));
    }, 0));
    const headerDiscount = round2(itemsSubtotalRaw * (Number(invoice.discountPercentage || 0) / 100));
    const shrinkFactor = itemsSubtotalRaw > 0 ? (itemsSubtotalRaw - headerDiscount) / itemsSubtotalRaw : 1;

    const formattedItems = invoiceItemRows.map((it) => {
      const unitCost = round2(Number(it.unitCost));
      const discount = round2(Number(it.discountAmount || 0));
      const netUnitCost = round2(Math.max(0, unitCost - discount));
      const lineSubtotalRaw = round2(netUnitCost * Number(it.quantity));
      const lineSubtotal = round2(lineSubtotalRaw * shrinkFactor);
      // PriceAmount in the XML stays the raw, undiscounted unitCost (see below) — the gap
      // between quantity*unitCost and the final discounted lineSubtotal must be declared
      // as its own line-level AllowanceCharge or ZATCA's BR-KSA-EN16931-11 reconciliation
      // check fails on any discounted line (per-item discount and/or header discount %).
      const lineDiscountAmount = round2(Math.max(0, round2(unitCost * Number(it.quantity)) - lineSubtotal));

      const resolvedSlab = it.taxSlabId ? slabById.get(it.taxSlabId) : undefined;
      const lineVatRate = resolvedSlab ? Number(resolvedSlab.percentage) : vatRate;
      const lineTaxCategoryCode = resolvedSlab
        ? resolveTaxCategoryCode(resolvedSlab.name, lineVatRate)
        : resolveTaxCategoryCode(taxSlab?.name, lineVatRate);
      const exemptionSlab = resolvedSlab || taxSlab;

      return {
        name: it.description,
        quantity: Number(it.quantity),
        unitPrice: unitCost,
        subtotal: lineSubtotal,
        vatRate: lineVatRate,
        vatAmount: round2(lineSubtotal * (lineVatRate / 100)),
        totalAmount: round2(lineSubtotal * (1 + lineVatRate / 100)),
        taxCategoryCode: lineTaxCategoryCode,
        // Only meaningful for 'E'/'Z' categories, and only emitted at all once an admin
        // has actually configured a real reason for this slab (src/db/schema.ts's
        // taxSlabs comment) — undefined otherwise, reproducing today's existing warning
        // rather than a fabricated code.
        exemptionReasonCode: exemptionSlab?.exemptionReasonCode || undefined,
        exemptionReason: exemptionSlab?.exemptionReason || undefined,
        lineDiscountAmount: lineDiscountAmount > 0 ? lineDiscountAmount : undefined,
        unitCode: normalizeZatcaUnitCode(it.unit),
      };
    });

    const subtotal = round2(formattedItems.reduce((acc, item) => acc + item.subtotal, 0));
    const totalVat = round2(formattedItems.reduce((acc, item) => acc + item.vatAmount, 0));
    const grandTotal = round2(subtotal + totalVat);

    // Computed once and reused everywhere (XML, API call, DB save) — previously two
    // separate crypto.randomUUID() calls could generate different values, and the API
    // call never received a uuid at all, causing ZATCA's real validator to reject the
    // submission with "UUID provided in the invoice doesn't match UUID in the provided
    // Request" (confirmed via a real Compliance Invoice API call).
    // `let`, not `const` — the reservation transaction below may replace this with a fresh
    // UUID if a prior reservation on this invoice is being superseded rather than reused
    // (ZATCA's own guidance: a UUID must never be reused once its original reservation is
    // no longer safely reusable — see the resubmission-identity logic further down).
    let invoiceUuid = inv.uuid || crypto.randomUUID();

    // IssueDate/IssueTime must reflect when this invoice was actually generated/issued to
    // the customer, once, and never drift on a later retry or resubmit — otherwise the
    // document ZATCA eventually clears could carry a different timestamp than whatever was
    // already printed/shown to the customer at creation time. `invoice.createdAt` is set
    // once at row insert and never written to again anywhere in this codebase, so deriving
    // IssueTime from it (the same way IssueDate already correctly derives from
    // `invoice.date`) keeps it stable across every processing attempt for free, with no new
    // state to track. ZATCA's own guidance (Detailed Technical Guidelines FAQ) explicitly
    // permits — but does not require — updating the time on a genuine resubmission; this
    // app deliberately chooses not to, for document-integrity reasons (see prior
    // discussion): what's cleared must match what the customer already has.
    const issueTime = new Date(invoice.createdAt as any).toISOString().split('T')[1]?.substring(0, 8) || '12:00:00';

    if (!zatcaEnabled) {
      // DISABLED-path preview: build a real Phase-1-compliant QR/XML WITHOUT touching the
      // real per-company hash chain at all. icv=0/previousInvoiceHash='' below are
      // throwaway placeholders fed only to generateZatcaUblXml so it has something to embed
      // in the AdditionalDocumentReference nodes — they are deliberately NOT persisted onto
      // the invoice's own icv/previousInvoiceHash/currentInvoiceHash columns (left at their
      // schema default of null/0). This matters concretely: further down, when this company
      // later enables ZATCA and this same invoice is resubmitted, the check
      // `if (invoice.icv && invoice.previousInvoiceHash)` must see nothing reserved yet and
      // fall through to a REAL getNextHashChainState() reservation — if we persisted these
      // placeholders here, that later resubmission would wrongly believe a chain position
      // was already claimed and reuse a bogus one, corrupting the real genesis-linked chain
      // for every invoice after it. Also deliberately omits privateKeyPem/certificatePem
      // even if the company happens to have CSID config on file — this is explicitly an
      // unsigned pre-enablement preview (tags 1-7, no crypto signature/public key), not a
      // real Phase-2 submission.
      const previewDoc = generateZatcaUblXml({
        invoiceNumber: inv.invoiceNumber || inv.id,
        uuid: invoiceUuid,
        issueDate: inv.invoiceDate || inv.date || new Date().toISOString().split('T')[0],
        issueTime,
        invoiceTypeCode,
        documentSubtypeCode: documentType === 'CreditNote' ? '381' : documentType === 'DebitNote' ? '383' : '388',
        billingReference: originalInvoice ? { invoiceNumber: originalInvoice.invoiceNumber } : undefined,
        paymentMeansNote: documentType === 'CreditNote'
          ? ((invoice as any).creditNoteReason || 'In case of goods or services refund')
          : documentType === 'DebitNote'
          ? ((invoice as any).creditNoteReason || 'Amendment of the supply value which is pre-agreed upon between the supplier and consumer')
          : undefined,
        currency: inv.currency || company?.currency || 'SAR',
        icv: 0,
        previousInvoiceHash: '',
        seller: {
          name: company?.name || 'Company',
          tin: config?.tinNumber || '300000000000003',
          crNumber: config?.crNumber || '1010000000',
          street: sellerStreet,
          buildingNumber: sellerBuildingNumber,
          district: sellerDistrict,
          city: sellerCity,
          postalCode: sellerPostalCode,
          countryCode: sellerCountryCode,
        },
        buyer: customer ? {
          name: customer.name,
          tin: customer.vatNumber || undefined,
          buildingNumber: customer.buildingNumber || undefined,
          street: customer.streetName || undefined,
          district: customer.district || undefined,
          city: customer.city || undefined,
          postalCode: customer.postalCode || undefined,
        } : undefined,
        items: formattedItems.length > 0 ? formattedItems : [
          { name: 'Standard Line Item', quantity: 1, unitPrice: subtotal, subtotal, vatRate, vatAmount: totalVat, totalAmount: grandTotal }
        ],
        subtotal,
        totalVat,
        grandTotal,
        // No privateKeyPem/certificatePem — forces the unsigned tags-1-7 branch.
      });

      await db.update(schema.invoices)
        .set({
          invoiceTypeCode,
          uuid: invoiceUuid,
          xmlContent: previewDoc.signedXmlContent,
          qrCodeContent: previewDoc.qrCodeBase64,
          zatcaStatus: 'DISABLED',
          zatcaValidationResults: [{ code: 'ZATCA_DISABLED', message: 'ZATCA integration is disabled for this company.' }] as any,
        })
        .where(eq(schema.invoices.id, invoiceId));
      return { success: true, status: 'DISABLED', qrCodeContent: previewDoc.qrCodeBase64, xmlContent: previewDoc.signedXmlContent };
    }

    // Reserving the next ICV/PIH and persisting it MUST be one atomic, locked step — this
    // whole function runs as a fire-and-forget background job per invoice (never awaited
    // by the invoice-creation request), so two invoices created close together can and DID
    // start processing concurrently. Both would otherwise read "the last invoice is X" at
    // the same moment and independently conclude they're each the next link in the chain —
    // reproduced live: two invoices created back-to-back both landed on the identical ICV
    // and identical previousInvoiceHash, a genuine fork ZATCA's own chain-integrity model
    // forbids. Locking the company row serializes this per company: only one invoice at a
    // time can claim "I'm next," and its claim is durably written before the lock releases,
    // so the next concurrent caller genuinely sees it. This lock is exclusively ICV/PIH's
    // own — the human-readable invoice-number counter (server/lib/documentNumbering.ts)
    // lives in a separate table (documentCounters) with its own atomic upsert and never
    // contends for this row; the two systems are deliberately disjoint.
    let icv = 0;
    let pih = '';
    let zatcaDoc!: ReturnType<typeof generateZatcaUblXml>;
    // Set inside the transaction, logged after it commits — recordAuditLog uses the plain
    // (untransacted) `db` connection, and auditLogs.companyId is a foreign key into
    // companies; calling it from inside a transaction that's already holding a FOR UPDATE
    // lock on that exact companies row self-deadlocks (a real bug caught here: the
    // separate connection's insert blocks waiting for a row lock the still-open outer
    // transaction holds, until Postgres's statement_timeout cancels it).
    let supersededAudit: Record<string, any> | null = null;
    await db.transaction(async (tx) => {
      await tx.select().from(schema.companies).where(eq(schema.companies.id, companyId!)).for('update');

      // Resubmission identity: per ZATCA's own guidance (Detailed Technical Guidelines
      // FAQ), a document's ICV/UUID are only safe to reuse on a later attempt when BOTH
      // (a) the original attempt definitively never reached ZATCA's network at all — the
      // only status/code combination that guarantees this is NOT_SUBMITTED with the
      // ONBOARDING_INCOMPLETE code (set below, before any fetch call ever happens; a
      // network exception or an actual REJECTED response are both treated conservatively
      // as "might have reached ZATCA," never safe to assume otherwise), and (b) nothing
      // else has been generated at a later chain position since (isStillChainTip) — if
      // another invoice already chained off this one's original hash, that position is
      // permanently structural regardless of what ZATCA itself ever saw. Failing either
      // condition, this is treated as a brand-new document: fresh ICV/PIH (chaining off
      // whatever the real current tip is now) and a fresh UUID, exactly as ZATCA's FAQ
      // describes a fix-and-resubmit ("similar to submitting a new invoice").
      const neverReachedZatca = invoice.zatcaStatus === 'NOT_SUBMITTED'
        && Array.isArray(invoice.zatcaValidationResults)
        && (invoice.zatcaValidationResults as any[]).some((r: any) => r?.code === 'ONBOARDING_INCOMPLETE');

      const reuseExisting = Boolean(
        invoice.icv && invoice.previousInvoiceHash && neverReachedZatca
        && await isStillChainTip(companyId!, environment, invoice.icv, tx)
      );

      if (reuseExisting) {
        icv = invoice.icv!;
        pih = invoice.previousInvoiceHash!;
      } else {
        if (invoice.icv) {
          // A prior reservation exists but can no longer be safely reused — captured here
          // for the audit trail (written after the transaction commits, see above),
          // mirroring how ZATCA's own platform permanently records a rejected document's
          // hash even though it was never accepted.
          supersededAudit = {
            companyId, environment,
            oldIcv: invoice.icv, oldUuid: invoice.uuid, oldHash: invoice.currentInvoiceHash,
            reason: neverReachedZatca ? 'superseded_by_later_invoice' : 'zatca_contact_confirmed_or_ambiguous',
          };
          invoiceUuid = crypto.randomUUID();
        }
        const hashState = await getNextHashChainState(companyId!, environment, tx);
        icv = hashState.icv;
        pih = hashState.previousInvoiceHash;
      }

      zatcaDoc = generateZatcaUblXml({
        invoiceNumber: inv.invoiceNumber || inv.id,
        uuid: invoiceUuid,
        issueDate: inv.invoiceDate || inv.date || new Date().toISOString().split('T')[0],
        issueTime,
        invoiceTypeCode,
        documentSubtypeCode: documentType === 'CreditNote' ? '381' : documentType === 'DebitNote' ? '383' : '388',
        billingReference: originalInvoice ? { invoiceNumber: originalInvoice.invoiceNumber } : undefined,
        paymentMeansNote: documentType === 'CreditNote'
          ? ((invoice as any).creditNoteReason || 'In case of goods or services refund')
          : documentType === 'DebitNote'
          ? ((invoice as any).creditNoteReason || 'Amendment of the supply value which is pre-agreed upon between the supplier and consumer')
          : undefined,
        currency: inv.currency || company?.currency || 'SAR',
        icv,
        previousInvoiceHash: pih,
        seller: {
          name: company?.name || 'Company',
          tin: config?.tinNumber || '300000000000003',
          crNumber: config?.crNumber || '1010000000',
          street: sellerStreet,
          buildingNumber: sellerBuildingNumber,
          district: sellerDistrict,
          city: sellerCity,
          postalCode: sellerPostalCode,
          countryCode: sellerCountryCode,
        },
        buyer: customer ? {
          name: customer.name,
          tin: customer.vatNumber || undefined,
          buildingNumber: customer.buildingNumber || undefined,
          street: customer.streetName || undefined,
          district: customer.district || undefined,
          city: customer.city || undefined,
          postalCode: customer.postalCode || undefined,
        } : undefined,
        items: formattedItems.length > 0 ? formattedItems : [
          { name: 'Standard Line Item', quantity: 1, unitPrice: subtotal, subtotal, vatRate, vatAmount: totalVat, totalAmount: grandTotal }
        ],
        subtotal,
        totalVat,
        grandTotal,
        privateKeyPem: config?.ecdsaPrivateKey ? decryptPrivateKey(config.ecdsaPrivateKey) : undefined,
        certificatePem: config?.productionCsidCert || config?.complianceCsidCert || undefined,
      });

      // Durably claim this ICV/hash position before the lock releases — this is what
      // makes the reservation actually visible to the next concurrent caller, instead of
      // only being written after a slow network call (the original bug: the claim wasn't
      // persisted until after ZATCA's response, so nothing stopped a second invoice from
      // reading the same "last invoice" in the meantime). Advances zatcaChainState's tip
      // for this (companyId, environment) in the same locked step, so the very next
      // concurrent caller's isStillChainTip/getNextHashChainState call sees it too.
      await setHashChainState(companyId!, environment, icv, zatcaDoc.invoiceHashBase64, tx);

      await tx.update(schema.invoices)
        .set({
          invoiceTypeCode,
          uuid: invoiceUuid,
          icv,
          previousInvoiceHash: pih,
          currentInvoiceHash: zatcaDoc.invoiceHashBase64,
          xmlContent: zatcaDoc.signedXmlContent,
          qrCodeContent: zatcaDoc.qrCodeBase64,
        })
        .where(eq(schema.invoices.id, invoiceId));
    });

    if (supersededAudit) {
      await recordAuditLog({ targetCompanyId: companyId }, 'zatca_chain_identity_superseded', 'invoices', invoiceId, supersededAudit);
    }

    // Call ZATCA API — deliberately outside the lock above: the network call doesn't
    // affect chain integrity (that was already settled and persisted), and holding a
    // company-wide row lock across a slow external HTTP call would needlessly serialize
    // every invoice for that company on ZATCA's response time.
    const client = new ZatcaApiClient({ environment });

    const encodedXml = Buffer.from(zatcaDoc.signedXmlContent).toString('base64');
    const csidCert = config?.productionCsidCert || config?.complianceCsidCert || 'MOCK_CSID';
    const csidSecret = config?.productionCsidSecret || config?.complianceCsidSecret || 'MOCK_SECRET';

    // Sandbox and Simulation are never mocked (see apiClient.ts's isMocked), and ZATCA's
    // real clearance/reporting endpoints only authenticate a Production CSID — a
    // Compliance CSID genuinely gets 401'd there, confirmed live. Rather than let every
    // invoice fail with a raw network error while onboarding is still in progress (in
    // ANY environment, not just sandbox), report that honestly instead of attempting a
    // call we already know will fail.
    if (!config?.productionCsidCert) {
      await db.update(schema.invoices)
        .set({
          zatcaStatus: 'NOT_SUBMITTED',
          zatcaValidationResults: [{ code: 'ONBOARDING_INCOMPLETE', message: 'Real ZATCA clearance/reporting requires a Production CSID, which requires the full compliance test suite to pass first. XML/hash/QR were generated and are ready to submit once onboarding completes.' }] as any,
        })
        .where(eq(schema.invoices.id, invoiceId));
      return { success: true, status: 'NOT_SUBMITTED', qrCodeContent: zatcaDoc.qrCodeBase64, xmlContent: zatcaDoc.signedXmlContent };
    }

    let apiResult;
    if (invoiceTypeCode === '388') {
      apiResult = await client.clearStandardInvoice(encodedXml, zatcaDoc.invoiceHashBase64, csidCert, csidSecret, invoiceUuid);
    } else {
      apiResult = await client.reportSimplifiedInvoice(encodedXml, zatcaDoc.invoiceHashBase64, csidCert, csidSecret, invoiceUuid);
    }

    const finalStatus = apiResult.clearanceStatus === 'CLEARED' ? 'CLEARED' :
                      apiResult.clearanceStatus === 'REPORTED' ? 'REPORTED' : 'REJECTED';

    // A REJECTED result is a normal HTTP 200 from ZATCA (not a thrown error) carrying the
    // real defect detail in validationResults — record it the same way a thrown API error
    // is recorded, so a real rejection during Simulation/Production is diagnosable from
    // auditLogs, not just from the invoice row's own zatcaValidationResults.
    if (finalStatus === 'REJECTED') {
      await recordAuditLog({ targetCompanyId: companyId }, 'zatca_invoice_rejected', 'invoices', invoiceId, {
        companyId, environment, invoiceTypeCode, validationResults: apiResult.validationResults,
      });
    }

    await db.update(schema.invoices)
      .set({
        invoiceTypeCode,
        uuid: invoiceUuid,
        icv,
        previousInvoiceHash: pih,
        currentInvoiceHash: zatcaDoc.invoiceHashBase64,
        xmlContent: zatcaDoc.signedXmlContent,
        qrCodeContent: zatcaDoc.qrCodeBase64,
        zatcaStatus: finalStatus,
        zatcaValidationResults: apiResult.validationResults as any,
        clearanceTimestamp: new Date(),
      })
      .where(eq(schema.invoices.id, invoiceId));

    return {
      success: true,
      status: finalStatus,
      zatcaValidationResults: apiResult.validationResults,
      qrCodeContent: zatcaDoc.qrCodeBase64,
      xmlContent: zatcaDoc.signedXmlContent,
    };
  } catch (err: any) {
    console.error('[ZATCA Processor Error]:', err);
    if (companyId) {
      await recordAuditLog({ targetCompanyId: companyId }, 'zatca_api_error', 'invoices', invoiceId, {
        companyId, environment, step: err?.zatcaStep || 'processInvoiceZatca',
        httpStatus: err?.zatcaHttpStatus, responseBody: err?.zatcaResponseBody, message: err?.message,
      });
    }
    await db.update(schema.invoices)
      .set({
        zatcaStatus: 'ERROR',
        zatcaValidationResults: [{ code: 'SYS_ERR', message: err.message }] as any,
      })
      .where(eq(schema.invoices.id, invoiceId));
    return { error: err.message };
  }
}
