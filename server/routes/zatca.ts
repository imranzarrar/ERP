import { Router } from 'express';
import { db } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { generateZatcaKeyPair, generateZatcaCsr } from '../lib/zatca/crypto.js';
import { getNextHashChainState, INITIAL_PREVIOUS_INVOICE_HASH } from '../lib/zatca/hashChain.js';
import { generateZatcaUblXml } from '../lib/zatca/xmlBuilder.js';
import { ZatcaApiClient } from '../lib/zatca/apiClient.js';
import { processInvoiceZatca } from '../lib/zatca/processInvoice.js';
import { isAdminUser, isSuperAdminUser } from '../lib/authz.js';
import { generateId } from '../../src/id.js';
import { recordAuditLog } from '../lib/audit.js';
import { validateTaxpayerIdentity } from '../lib/zatca/validators.js';
import { certificateMatchesPrivateKey } from '../lib/zatca/x509.js';
import { getZatcaSandboxSampleBinarySecurityToken, getZatcaSandboxSamplePrivateKeyPem } from '../lib/zatca/sandboxSampleIdentity.js';

const router = Router();

type ZatcaEnvironment = 'sandbox' | 'simulation' | 'production';
const VALID_ENVIRONMENTS: ZatcaEnvironment[] = ['sandbox', 'simulation', 'production'];

function assertValidEnvironment(environment: any): asserts environment is ZatcaEnvironment {
  if (!VALID_ENVIRONMENTS.includes(environment)) {
    const err: any = new Error(`Invalid environment "${environment}". Must be one of: ${VALID_ENVIRONMENTS.join(', ')}`);
    err.status = 400;
    throw err;
  }
}

// Sandbox/simulation/production hold fully independent credentials and onboarding
// state (BACKLOG.md ZATCA finding #2) — this fetches (or upserts) exactly one
// environment's row, never the whole company.
async function getEnvConfig(companyId: string, environment: ZatcaEnvironment) {
  const [config] = await db.select().from(schema.zatcaEnvironmentConfigs)
    .where(and(eq(schema.zatcaEnvironmentConfigs.companyId, companyId), eq(schema.zatcaEnvironmentConfigs.environment, environment)));
  return config;
}

async function upsertEnvConfig(companyId: string, environment: ZatcaEnvironment, patch: Record<string, any>) {
  const existing = await getEnvConfig(companyId, environment);
  if (existing) {
    await db.update(schema.zatcaEnvironmentConfigs)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(schema.zatcaEnvironmentConfigs.id, existing.id));
    return { ...existing, ...patch };
  }
  const row = { id: generateId(), companyId, environment, ...patch };
  await db.insert(schema.zatcaEnvironmentConfigs).values(row);
  return row;
}

// Persists the full detail of a failed ZATCA API call (HTTP status + ZATCA's own
// response body, including its field-level `errors` array — see apiClient.ts's
// buildZatcaError) via the project's existing audit-log pattern, so a real
// Simulation/Production rejection can be root-caused from the DB instead of only a
// transient console line (BACKLOG.md ZATCA finding #14).
// ZATCA can reject a request WITHOUT throwing — checkCompliance/clearStandardInvoice/
// reportSimplifiedInvoice return a normal HTTP 200 with clearanceStatus: 'REJECTED' and
// the actual defect detail in validationResults.errorMessages. That's just as important
// to capture for diagnosis as a thrown network/API error, and previously wasn't recorded
// anywhere durable — only surfaced transiently in the API response.
async function logZatcaRejection(req: any, companyId: string, environment: string, step: string, validationResults: any) {
  await recordAuditLog(req, 'zatca_invoice_rejected', 'zatca_environment_config', null, {
    companyId,
    step,
    environment,
    validationResults,
  });
}

async function logZatcaApiError(req: any, companyId: string, environment: string, step: string, err: any) {
  // companyId is embedded directly in `details` (not just left to req.targetCompanyId)
  // because super-admin requests don't always have targetCompanyId populated, and this
  // log must be reliably attributable to the right company regardless of caller role.
  await recordAuditLog(req, 'zatca_api_error', 'zatca_environment_config', null, {
    companyId,
    step: err?.zatcaStep || step,
    environment,
    httpStatus: err?.zatcaHttpStatus,
    responseBody: err?.zatcaResponseBody,
    message: err?.message,
  });
}

// ZATCA configuration/signing is not a line-staff action and touches per-company
// cryptographic secrets — require admin/super-admin, and for non-super-admins verify
// the request's target company (from body/params, or resolved via invoiceId) matches
// req.targetCompanyId.
router.use(async (req: any, res: any, next: any) => {
  if (!isAdminUser(req.user)) {
    return res.status(403).json({ error: 'Forbidden: ZATCA configuration requires admin access' });
  }
  if (isSuperAdminUser(req.user)) {
    return next();
  }

  let targetCompanyId: string | undefined = req.body?.companyId || req.params?.companyId;

  if (!targetCompanyId) {
    const invoiceId = req.body?.invoiceId || req.params?.invoiceId;
    if (invoiceId) {
      try {
        const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
        if (!invoice) {
          return res.status(404).json({ error: 'Invoice not found' });
        }
        targetCompanyId = invoice.companyId || undefined;
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    }
  }

  if (targetCompanyId && targetCompanyId !== req.targetCompanyId) {
    return res.status(403).json({ error: 'Forbidden: company mismatch' });
  }
  next();
});

/**
  * GET ZATCA onboarding status for all three environments, plus the taxpayer profile
  * and which environment is currently active for live invoice processing.
  */
router.get('/company-status/:companyId', async (req, res) => {
  try {
    const { companyId } = req.params;
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));

    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const configs = await db.select().from(schema.zatcaEnvironmentConfigs).where(eq(schema.zatcaEnvironmentConfigs.companyId, companyId));
    const hashState = await getNextHashChainState(companyId);

    // Each environment carries its OWN taxpayer identity now (sandbox uses ZATCA's
    // published test identity; simulation/production need the company's real
    // registration) — never a single shared slot, matching how credentials already work.
    const environments = VALID_ENVIRONMENTS.map((environment) => {
      const config = configs.find(c => c.environment === environment);
      return {
        environment,
        isOnboarded: Boolean(config?.isOnboarded),
        hasEcdsaKey: Boolean(config?.ecdsaPrivateKey),
        hasComplianceCsid: Boolean(config?.complianceCsidCert),
        hasProductionCsid: Boolean(config?.productionCsidCert),
        complianceTestsPassed: Boolean(config?.complianceTestsPassedAt),
        tinNumber: config?.tinNumber || '',
        crNumber: config?.crNumber || '',
        streetName: config?.streetName || '',
        buildingNumber: config?.buildingNumber || '',
        district: config?.district || '',
        city: config?.city || '',
        postalCode: config?.postalCode || '',
        countryCode: config?.countryCode || 'SA',
        businessCategory: config?.businessCategory || '',
      };
    });

    res.json({
      companyId: company.id,
      companyName: company.name,
      activeEnvironment: company.zatcaEnvironment || 'sandbox',
      environments,
      nextIcv: hashState.icv,
      previousInvoiceHash: hashState.previousInvoiceHash,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
  * POST update one environment's taxpayer identity profile (TIN/CR/address). Identity is
  * per-environment, exactly like credentials — saving Simulation's real registration must
  * never touch Sandbox's test identity, or vice versa.
  */
router.post('/company-config', async (req, res) => {
  try {
    const {
      companyId,
      environment,
      tinNumber,
      crNumber,
      streetName,
      buildingNumber,
      district,
      city,
      postalCode,
      countryCode,
      businessCategory,
    } = req.body;

    if (!companyId) {
      return res.status(400).json({ error: 'Company ID is required' });
    }
    assertValidEnvironment(environment);

    await upsertEnvConfig(companyId, environment, {
      tinNumber,
      crNumber,
      streetName,
      buildingNumber,
      district,
      city,
      postalCode,
      countryCode: countryCode || 'SA',
      businessCategory: businessCategory || 'Commerce',
    });

    res.json({ message: `ZATCA taxpayer profile for ${environment} updated successfully.` });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
  * POST set which environment is active for live invoice processing. Refuses to activate
  * an environment that hasn't actually completed onboarding (no Production CSID) —
  * otherwise every subsequent invoice would either be silently mocked (pre-fix
  * Simulation behavior) or submitted unsigned to a real government gateway.
  */
router.post('/set-active-environment', async (req, res) => {
  try {
    const { companyId, environment } = req.body;
    if (!companyId) {
      return res.status(400).json({ error: 'Company ID is required' });
    }
    assertValidEnvironment(environment);

    const config = await getEnvConfig(companyId, environment);
    if (!config?.isOnboarded) {
      const err: any = new Error(`${environment} has not completed onboarding yet (no Production CSID) — cannot set it as the active environment for live invoices.`);
      err.status = 400;
      throw err;
    }

    await db.update(schema.companies)
      .set({ zatcaEnvironment: environment })
      .where(eq(schema.companies.id, companyId));

    res.json({ message: `${environment} is now the active environment for live invoice processing.`, zatcaEnvironment: environment });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
  * POST Step 2: Generate ECDSA Keypair & Certificate Signing Request (CSR) for one environment
  */
router.post('/generate-keypair-csr', async (req, res) => {
  try {
    const { companyId, environment } = req.body;
    assertValidEnvironment(environment);
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));

    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const config = await getEnvConfig(companyId, environment);

    // Identity fields are embedded directly in the CSR itself — a malformed VAT/address
    // here is only discoverable after ZATCA rejects the compliance/OTP exchange,
    // burning part of a ~1-hour OTP window for nothing. Catch it here instead, before
    // any OTP has even been requested.
    const identityErrors = validateTaxpayerIdentity({
      tinNumber: config?.tinNumber,
      crNumber: config?.crNumber,
      streetName: config?.streetName,
      buildingNumber: config?.buildingNumber,
      district: config?.district,
      city: config?.city,
      postalCode: config?.postalCode,
    });
    if (identityErrors.length > 0) {
      return res.status(400).json({
        error: `Complete this environment's taxpayer identity (Step 1) before generating a CSR: ${identityErrors.map(e => e.message).join(' ')}`,
        fieldErrors: identityErrors,
      });
    }

    const keyPair = generateZatcaKeyPair();

    const csrBase64 = generateZatcaCsr({
      cn: company.name,
      organizationUnitName: config!.district || 'HeadOffice',
      organizationName: company.name,
      countryName: config!.countryCode || 'SA',
      serialNumber: `1-ERP|2-2.0|3-${company.id}`,
      vatNumber: config!.tinNumber || '300000000000003',
      invoiceType: '1100',
      location: config!.city || 'Riyadh',
      industry: config!.businessCategory || 'Commerce',
      production: environment === 'production',
    }, keyPair.privateKeyPem);

    await upsertEnvConfig(companyId, environment, {
      ecdsaPrivateKey: keyPair.privateKeyPem,
    });

    res.json({
      csrBase64,
      publicKeyPem: keyPair.publicKeyPem,
      message: 'ECDSA secp256k1 Keypair and ZATCA CSR generated successfully',
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
  * POST Step 3 & 4: Exchange OTP + CSR for ZATCA Compliance CSID (one environment).
  * The OTP is used once, inline, and never persisted (see BACKLOG.md ZATCA finding #6) —
  * sandbox always accepts "123456" per ZATCA's documented sandbox placeholder;
  * simulation/production OTPs come from the company's real ZATCA Fatoora portal login.
  */
router.post('/request-compliance-csid', async (req, res) => {
  try {
    const { companyId, environment, otp, csrBase64 } = req.body;
    assertValidEnvironment(environment);
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));
    const config = await getEnvConfig(companyId, environment);

    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }
    if (!config?.ecdsaPrivateKey) {
      return res.status(400).json({ error: 'Generate the keypair & CSR (Step 2) for this environment before requesting a Compliance CSID.' });
    }

    const client = new ZatcaApiClient({ environment });

    const result = await client.requestComplianceCsid(csrBase64, otp);

    // ZATCA's response can be a genuinely successful API call yet still return a
    // certificate for a different key pair than the one we submitted (observed live
    // against the shared public sandbox test identity) — every signature made with our
    // stored key would then be cryptographically invalid against it. Fail loudly instead
    // of silently storing a broken pairing and reporting success.
    if (!certificateMatchesPrivateKey(result.binarySecurityToken, config.ecdsaPrivateKey)) {
      const err: any = new Error('ZATCA issued a Compliance CSID certificate that does not match this environment\'s private key. Not stored — this would sign every invoice with an invalid signature. Try again, or regenerate the keypair/CSR (Step 2) and retry.');
      err.status = 502;
      err.zatcaStep = 'requestComplianceCsid:keyMismatch';
      // Preserved for auditLogs — without this, the mismatch is recorded but the actual
      // rejected certificate (needed to tell "same wrong cert every time" from "a new
      // wrong cert each time") is lost the moment this request ends.
      err.zatcaResponseBody = { rejectedBinarySecurityToken: result.binarySecurityToken, dispositionMessage: result.dispositionMessage };
      throw err;
    }

    await upsertEnvConfig(companyId, environment, {
      complianceCsidCert: result.binarySecurityToken,
      complianceCsidSecret: result.secret,
      complianceRequestId: result.issuedRequestId,
      complianceTestsPassedAt: null,
    });

    res.json({
      message: 'Compliance CSID issued successfully',
      requestId: result.issuedRequestId,
      dispositionMessage: result.dispositionMessage,
    });
  } catch (err: any) {
    if (req.body?.companyId && req.body?.environment) {
      await logZatcaApiError(req, req.body.companyId, req.body.environment, 'requestComplianceCsid', err);
    }
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
  * POST Step 5: Run Automated Compliance Check Test Suite for one environment.
  * Genuinely submits both a Standard B2B and a Simplified B2C sample; Credit/Debit Note
  * are honestly reported as not-yet-implemented rather than fabricated as passed (see
  * BACKLOG.md ZATCA finding #7 — building those document types is Phase IX's job).
  */
router.post('/run-compliance-suite', async (req, res) => {
  try {
    const { companyId, environment } = req.body;
    assertValidEnvironment(environment);
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));
    const config = await getEnvConfig(companyId, environment);

    if (!company || !config?.complianceCsidCert) {
      return res.status(400).json({ error: 'This environment must have an active Compliance CSID certificate before running the compliance suite.' });
    }

    const client = new ZatcaApiClient({ environment });

    const baseFields = {
      currency: company.currency || 'SAR',
      icv: 1,
      previousInvoiceHash: INITIAL_PREVIOUS_INVOICE_HASH,
      seller: {
        name: company.name,
        tin: config.tinNumber || '300000000000003',
        crNumber: config.crNumber || '1010000000',
        street: config.streetName || 'King Fahd Road',
        buildingNumber: config.buildingNumber || '1234',
        district: config.district || 'Olaya',
        city: config.city || 'Riyadh',
        postalCode: config.postalCode || '12345',
        countryCode: config.countryCode || 'SA',
      },
      items: [
        { name: 'Compliance Test Product', quantity: 1, unitPrice: 100, subtotal: 100, vatRate: 15, vatAmount: 15, totalAmount: 115 },
      ],
      subtotal: 100,
      totalVat: 15,
      grandTotal: 115,
      privateKeyPem: config.ecdsaPrivateKey || undefined,
      certificatePem: config.complianceCsidCert || undefined,
    };

    const b2bUuid = crypto.randomUUID();
    const sampleB2b = generateZatcaUblXml({
      ...baseFields,
      invoiceNumber: `TEST-B2B-${Date.now()}`,
      uuid: b2bUuid,
      issueDate: new Date().toISOString().split('T')[0],
      issueTime: new Date().toISOString().split('T')[1].substring(0, 8),
      invoiceTypeCode: '388',
      buyer: {
        name: 'Compliance Test Corporate Buyer',
        tin: '311111111111113',
        buildingNumber: '9999',
        street: 'Business Bay',
        district: 'KAFD',
        city: 'Riyadh',
        postalCode: '11564',
      },
    });

    const b2cUuid = crypto.randomUUID();
    const sampleB2c = generateZatcaUblXml({
      ...baseFields,
      invoiceNumber: `TEST-B2C-${Date.now()}`,
      uuid: b2cUuid,
      issueDate: new Date().toISOString().split('T')[0],
      issueTime: new Date().toISOString().split('T')[1].substring(0, 8),
      invoiceTypeCode: '0200000',
      // AccountingCustomerParty must be present even for a Simplified (B2C) sample —
      // ZATCA's XSD rejects the document entirely when it's omitted, even though a real
      // walk-in B2C sale often has no buyer details on file.
      buyer: {
        name: 'Compliance Test Consumer',
        buildingNumber: '9999',
        street: 'Business Bay',
        district: 'KAFD',
        city: 'Riyadh',
        postalCode: '11564',
      },
    });

    const b2bResult = await client.checkCompliance(
      Buffer.from(sampleB2b.signedXmlContent).toString('base64'),
      sampleB2b.invoiceHashBase64,
      config.complianceCsidCert,
      config.complianceCsidSecret || '',
      b2bUuid
    );

    const b2cResult = await client.checkCompliance(
      Buffer.from(sampleB2c.signedXmlContent).toString('base64'),
      sampleB2c.invoiceHashBase64,
      config.complianceCsidCert,
      config.complianceCsidSecret || '',
      b2cUuid
    );

    const bothCleared = b2bResult.clearanceStatus === 'CLEARED' && b2cResult.clearanceStatus === 'CLEARED';

    if (bothCleared) {
      await upsertEnvConfig(companyId, environment, { complianceTestsPassedAt: new Date() });
    } else {
      if (b2bResult.clearanceStatus !== 'CLEARED') {
        await logZatcaRejection(req, companyId, environment, 'runComplianceSuite:standardB2B', b2bResult.validationResults);
      }
      if (b2cResult.clearanceStatus !== 'CLEARED') {
        await logZatcaRejection(req, companyId, environment, 'runComplianceSuite:simplifiedB2C', b2cResult.validationResults);
      }
    }

    res.json({
      status: bothCleared ? 'PASSED' : 'FAILED',
      tests: [
        { name: 'Standard B2B Invoice Test', status: b2bResult.clearanceStatus, details: b2bResult.validationResults },
        { name: 'Simplified B2C Invoice Test', status: b2cResult.clearanceStatus, details: b2cResult.validationResults },
        { name: 'Credit Note Test', status: 'NOT_IMPLEMENTED', details: { infoMessages: [{ code: 'PENDING', message: 'Credit Note document generation is not yet implemented in this ERP (tracked in BACKLOG.md).' }] } },
        { name: 'Debit Note Test', status: 'NOT_IMPLEMENTED', details: { infoMessages: [{ code: 'PENDING', message: 'Debit Note document generation is not yet implemented in this ERP (tracked in BACKLOG.md).' }] } },
      ],
      message: bothCleared
        ? '2/4 scenarios tested and cleared; Credit Note and Debit Note are pending (not yet implemented).'
        : '2/4 scenarios tested; one or more failed. Credit Note and Debit Note are pending (not yet implemented).',
    });
  } catch (err: any) {
    if (req.body?.companyId && req.body?.environment) {
      await logZatcaApiError(req, req.body.companyId, req.body.environment, 'runComplianceSuite', err);
    }
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
  * POST Step 6: Issue Production CSID & Onboard Company for one environment.
  * Requires the compliance suite to have actually run and passed for this environment
  * (see BACKLOG.md ZATCA finding #8) — not just that a compliance request ID exists.
  */
router.post('/request-production-csid', async (req, res) => {
  try {
    const { companyId, environment } = req.body;
    assertValidEnvironment(environment);
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));
    const config = await getEnvConfig(companyId, environment);

    if (!company || !config?.complianceRequestId) {
      return res.status(400).json({ error: 'Compliance CSID must be issued before requesting Production CSID' });
    }
    if (!config.complianceTestsPassedAt) {
      return res.status(400).json({ error: 'The compliance test suite must be run and pass for this environment before requesting Production CSID' });
    }
    if (!config.ecdsaPrivateKey) {
      return res.status(400).json({ error: 'This environment has no stored private key — regenerate the keypair & CSR (Step 2) before requesting Production CSID.' });
    }

    const client = new ZatcaApiClient({ environment });

    const prodResult = await client.requestProductionCsid(
      config.complianceRequestId,
      config.complianceCsidCert || '',
      config.complianceCsidSecret || ''
    );

    // A genuinely successful API call does not guarantee the returned certificate
    // actually pairs with our private key — confirmed live and reproduced 3x with fresh
    // keys each time, then confirmed as ZATCA's own documented behavior on their developer
    // forum: "Sandbox is restricted with static data" — sandbox's Production CSID endpoint
    // returns a fixed, canned certificate for the shared public test VAT
    // (399999999900003) regardless of the CSR actually submitted. Simulation/Production
    // use each company's own real, unique VAT, so this collision cannot occur there — a
    // mismatch in those environments is a genuine problem and must still hard-fail.
    let signingKeyToStore = config.ecdsaPrivateKey;
    let keyMatches = certificateMatchesPrivateKey(prodResult.binarySecurityToken, config.ecdsaPrivateKey);
    let usedSandboxSampleKey = false;

    if (!keyMatches && environment === 'sandbox' && prodResult.binarySecurityToken === getZatcaSandboxSampleBinarySecurityToken()) {
      // This is exactly ZATCA's own known, published sandbox sample certificate (verified
      // via a real sign/verify round trip against its bundled SDK sample private key) —
      // not an arbitrary mismatch. ZATCA's sandbox always returns this specific
      // certificate for the shared public test VAT, so the only way to get a genuinely
      // self-consistent signature there is to sign with ITS matching key, not the one we
      // generated ourselves. Switching now — this key never leaves sandbox and is never
      // used for Simulation/Production, where the strict hard-fail above still applies.
      signingKeyToStore = getZatcaSandboxSamplePrivateKeyPem();
      keyMatches = true;
      usedSandboxSampleKey = true;
      await recordAuditLog(req, 'zatca_sandbox_sample_key_adopted', 'zatca_environment_config', null, {
        companyId, environment,
        message: 'ZATCA sandbox returned its known published sample Production CSID certificate. Switched this environment\'s signing key to ZATCA\'s matching bundled sample private key so real invoices sign correctly. Sandbox only — never applied to Simulation/Production.',
      });
    } else if (!keyMatches && environment !== 'sandbox') {
      const err: any = new Error('ZATCA issued a Production CSID certificate that does not match this environment\'s private key. Not stored, and the environment was NOT marked onboarded — every invoice would have signed with an invalid signature. Try requesting the Production CSID again.');
      err.status = 502;
      err.zatcaStep = 'requestProductionCsid:keyMismatch';
      err.zatcaResponseBody = { rejectedBinarySecurityToken: prodResult.binarySecurityToken, dispositionMessage: prodResult.dispositionMessage };
      throw err;
    } else if (!keyMatches) {
      // Sandbox, but not the recognized ZATCA sample cert — an unrecognized mismatch.
      // Proceed (sandbox has no legal weight) but record it plainly, since we don't have
      // a matching key to offer here the way we do for the known sample.
      await recordAuditLog(req, 'zatca_sandbox_static_csid', 'zatca_environment_config', null, {
        companyId, environment,
        message: 'ZATCA sandbox returned a Production CSID certificate that does not match this environment\'s private key, and it is not the recognized ZATCA sample certificate — stored anyway for sandbox testing purposes only, but signatures will not be cryptographically self-consistent.',
      });
    }

    await upsertEnvConfig(companyId, environment, {
      ecdsaPrivateKey: signingKeyToStore,
      productionCsidCert: prodResult.binarySecurityToken,
      productionCsidSecret: prodResult.secret,
      isOnboarded: true,
    });

    // This route is the genuine "onboarding just finished" point for whichever
    // environment was passed in (despite its "Production CSID" name, it's called for
    // sandbox/simulation/production alike). Auto-flip the company-wide zatcaEnabled
    // switch only for sandbox, and only if sandbox is still this company's active
    // environment — companies are deliberately pushed through sandbox -> simulation ->
    // production one at a time, at their own pace, so this must never fire off a
    // simulation/production completion, nor off a sandbox re-onboard after the company
    // has already moved its active environment on.
    // TODO(simulation/production auto-enable): not implemented — per product decision,
    // enabling those environments stays a deliberate manual/Super-Admin step (the
    // AdminSettings toggle) until each environment gets its own "live" flag instead of
    // one shared company-wide switch.
    if (environment === 'sandbox' && (company.zatcaEnvironment || 'sandbox') === 'sandbox' && !company.zatcaEnabled) {
      await db.update(schema.companies).set({ zatcaEnabled: true }).where(eq(schema.companies.id, companyId));
      await recordAuditLog(req, 'zatca_auto_enabled_after_sandbox_onboarding', 'company', companyId, {
        companyId,
        message: 'Sandbox onboarding completed (Production CSID issued) — zatcaEnabled automatically switched on for this company.',
      });
    }

    res.json({
      message: usedSandboxSampleKey
        ? 'Production CSID activated for sandbox. ZATCA returned its known static test certificate, so this environment\'s signing key was switched to ZATCA\'s own matching sample private key — invoices will now sign correctly and validate cleanly. Sandbox only; Simulation/Production are unaffected.'
        : keyMatches
        ? 'Production CSID activated! Organization is now ZATCA Phase 2 Onboarded for this environment.'
        : 'Production CSID activated for sandbox testing. Note: ZATCA\'s sandbox returned an unrecognized, non-matching certificate — invoices will clear/report via the real API but will not be cryptographically self-consistent. Simulation/Production use each company\'s own real VAT and are not affected by this.',
      isOnboarded: true,
      dispositionMessage: prodResult.dispositionMessage,
    });
  } catch (err: any) {
    if (req.body?.companyId && req.body?.environment) {
      await logZatcaApiError(req, req.body.companyId, req.body.environment, 'requestProductionCsid', err);
    }
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * POST Submit or re-submit invoice directly to ZATCA Phase 2
 */
router.post('/submit-invoice/:invoiceId', async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const result = await processInvoiceZatca(invoiceId);
    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
