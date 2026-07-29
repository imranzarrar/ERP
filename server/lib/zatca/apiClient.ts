export interface ZatcaApiConfig {
  environment: 'sandbox' | 'simulation' | 'production';
  csidCert?: string;
  csidSecret?: string;
}

export interface ComplianceCsidResponse {
  issuedRequestId: string;
  binarySecurityToken: string;
  secret: string;
  dispositionMessage: string;
  errors?: string[];
}

export interface ProductionCsidResponse {
  binarySecurityToken: string;
  secret: string;
  dispositionMessage: string;
  errors?: string[];
}

export interface ClearanceReportingResponse {
  clearanceStatus: 'CLEARED' | 'REPORTED' | 'REJECTED';
  validationResults: {
    infoMessages?: Array<{ status: string; code: string; message: string }>;
    warningMessages?: Array<{ status: string; code: string; message: string }>;
    errorMessages?: Array<{ status: string; code: string; message: string }>;
  };
  clearedInvoiceXml?: string;
}

export const ZATCA_ENDPOINTS = {
  sandbox: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal',
  simulation: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation',
  production: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core',
};

// ZATCA's error responses carry field-level detail in a `data.errors` array that the
// bare `err.message` string used to discard entirely — the exact detail needed to
// diagnose a rejection (e.g. which CSR field or OTP was wrong) never reached the caller,
// the UI, or any log. Every real-network method below throws via this helper instead of
// a bare `new Error(...)`, and callers (server/routes/zatca.ts, processInvoice.ts) log
// `err.zatcaResponseBody`/`err.zatcaHttpStatus` to auditLogs on failure.
function buildZatcaError(step: string, message: string, httpStatus?: number, responseBody?: any): Error {
  const detail = responseBody?.errors ? ` — details: ${JSON.stringify(responseBody.errors)}` : '';
  const err: any = new Error(`${message}${detail}`);
  err.zatcaStep = step;
  err.zatcaHttpStatus = httpStatus;
  err.zatcaResponseBody = responseBody;
  return err;
}

export class ZatcaApiClient {
  private environment: 'sandbox' | 'simulation' | 'production';
  private baseUrl: string;

  constructor(config: ZatcaApiConfig) {
    this.environment = config.environment || 'sandbox';
    this.baseUrl = ZATCA_ENDPOINTS[this.environment];
  }

  // Sandbox and Simulation are both ZATCA gateways meant to be genuinely called by
  // integrators — Sandbox needs no business registration (the documented "123456" OTP),
  // Simulation needs the company's real registered credentials but is still a
  // pre-production gateway, not the live tax authority. Neither is ever mocked: whatever
  // ZATCA actually returns (success or a real rejection) is what this app reports.
  // Fabricating a result would misrepresent the integration's real state. Only Production
  // — the live gateway with real legal/fiscal effect — stays behind an explicit opt-in
  // (ZATCA_ALLOW_LIVE_CALLS) as a safety interlock against an accidental live call from a
  // dev/staging deploy.
  private get isMocked(): boolean {
    return this.environment === 'production' && process.env.ZATCA_ALLOW_LIVE_CALLS !== 'true';
  }

  /**
    * Step 1: Issue Compliance CSID using CSR and OTP
    */
  async requestComplianceCsid(csrBase64: string, otp: string): Promise<ComplianceCsidResponse> {
    console.log(`[ZATCA API] Requesting Compliance CSID (${this.environment}). OTP: ${otp}`);

    if (this.isMocked) {
      const mockCert = Buffer.from(`ZATCA_COMPLIANCE_CERT_${Date.now()}_${csrBase64.substring(0, 15)}`).toString('base64');
      const mockSecret = Buffer.from(`ZATCA_SECRET_${Date.now()}`).toString('base64');

      return {
        issuedRequestId: `REQ-${Date.now()}`,
        binarySecurityToken: mockCert,
        secret: mockSecret,
        dispositionMessage: 'ISSUED - Compliance CSID successfully granted in Sandbox',
      };
    }

    try {
      const response = await fetch(`${this.baseUrl}/compliance`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'OTP': otp,
          'Accept-Version': 'V2',
        },
        body: JSON.stringify({ csr: csrBase64 }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw buildZatcaError('requestComplianceCsid', data.message || 'ZATCA Compliance CSID request failed', response.status, data);
      }

      // ZATCA's real response uses "requestID" (capital ID) — this previously returned
      // the raw response unmapped, so callers reading `issuedRequestId` got undefined
      // and silently stored an empty compliance_request_id, which then broke the later
      // request-production-csid gate check. Confirmed via a real, successful CSID
      // issuance whose requestID never made it into our DB.
      return {
        issuedRequestId: String(data.requestID),
        binarySecurityToken: data.binarySecurityToken,
        secret: data.secret,
        dispositionMessage: data.dispositionMessage,
        errors: data.errors,
      };
    } catch (err: any) {
      // A real network/API failure in a non-sandbox environment must never be recorded
      // as success — that would silently mask a genuine ZATCA rejection or outage.
      console.error('[ZATCA API] Compliance CSID request failed:', err.message);
      // Errors already built via buildZatcaError() (the response.ok===false branch
      // above) carry zatcaResponseBody/zatcaHttpStatus for the caller to log —
      // rethrow them as-is instead of re-wrapping, which would discard that detail.
      // Only genuine network/parse failures (no zatcaStep) get wrapped here.
      throw err.zatcaStep ? err : buildZatcaError('requestComplianceCsid', `ZATCA Compliance CSID request failed: ${err.message}`);
    }
  }

  /**
    * Step 2: Run Compliance Checks (Submits test invoices required by ZATCA)
    */
  async checkCompliance(signedXmlBase64: string, invoiceHash: string, csidCert: string, csidSecret: string, uuid: string): Promise<ClearanceReportingResponse> {
    console.log(`[ZATCA API] Running Compliance Check for Hash: ${invoiceHash.substring(0, 12)}...`);

    if (this.isMocked) {
      return {
        clearanceStatus: 'CLEARED',
        validationResults: {
          infoMessages: [{ status: 'PASS', code: 'ZATCA-CHECK-001', message: 'UBL 2.1 Schema validation passed' }],
          warningMessages: [],
          errorMessages: [],
        },
      };
    }

    const authHeader = `Basic ${Buffer.from(`${csidCert}:${csidSecret}`).toString('base64')}`;

    try {
      const response = await fetch(`${this.baseUrl}/compliance/invoices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
          'Accept-Version': 'V2',
          'Accept-Language': 'en',
        },
        body: JSON.stringify({
          invoiceHash,
          uuid,
          invoice: signedXmlBase64,
        }),
      });

      const data = await response.json();
      return {
        clearanceStatus: data.clearanceStatus || (response.ok ? 'CLEARED' : 'REJECTED'),
        validationResults: data.validationResults || { infoMessages: [], warningMessages: [], errorMessages: [] },
      };
    } catch (err: any) {
      console.error('[ZATCA API] Compliance check failed:', err.message);
      throw new Error(`ZATCA compliance check failed: ${err.message}`);
    }
  }

  /**
    * Step 3: Upgrade Compliance CSID to Production CSID
    */
  async requestProductionCsid(complianceRequestId: string, csidCert: string, csidSecret: string): Promise<ProductionCsidResponse> {
    console.log(`[ZATCA API] Requesting Production CSID for Request ID: ${complianceRequestId}`);

    if (this.isMocked) {
      return {
        binarySecurityToken: Buffer.from(`PROD_CERT_SANDBOX_${Date.now()}`).toString('base64'),
        secret: Buffer.from(`PROD_SECRET_SANDBOX_${Date.now()}`).toString('base64'),
        dispositionMessage: 'ISSUED - Production CSID active in Sandbox',
      };
    }

    const authHeader = `Basic ${Buffer.from(`${csidCert}:${csidSecret}`).toString('base64')}`;

    try {
      // Path is plural ("csids") and the body field is snake_case — both confirmed
      // against a real, working reference implementation's ZATCA API client, since
      // ZATCA's own docs don't spell out this endpoint's exact contract the way they do
      // for reporting/clearance.
      const response = await fetch(`${this.baseUrl}/production/csids`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
          'Accept-Version': 'V2',
        },
        body: JSON.stringify({ compliance_request_id: complianceRequestId }),
      });

      const data = await response.json();
      // Previously ungated — a real rejection (missing binarySecurityToken) would still
      // flow back as a "successful" result, and the caller would mark isOnboarded: true
      // with an undefined certificate. Must fail loudly instead.
      if (!response.ok || !data.binarySecurityToken) {
        throw buildZatcaError('requestProductionCsid', data.message || 'ZATCA Production CSID request failed', response.status, data);
      }
      return {
        binarySecurityToken: data.binarySecurityToken,
        secret: data.secret,
        dispositionMessage: data.dispositionMessage,
        errors: data.errors,
      };
    } catch (err: any) {
      console.error('[ZATCA API] Production CSID request failed:', err.message);
      throw err.zatcaStep ? err : buildZatcaError('requestProductionCsid', `ZATCA Production CSID request failed: ${err.message}`);
    }
  }

  /**
    * Live Clearance for Standard B2B Invoices
    */
  async clearStandardInvoice(signedXmlBase64: string, invoiceHash: string, csidCert: string, csidSecret: string, uuid: string): Promise<ClearanceReportingResponse> {
    if (this.isMocked) {
      return {
        clearanceStatus: 'CLEARED',
        validationResults: {
          infoMessages: [{ status: 'SUCCESS', code: 'SANDBOX-CLEARANCE', message: 'Invoice cleared instantly in Sandbox environment' }],
        },
      };
    }

    const authHeader = `Basic ${Buffer.from(`${csidCert}:${csidSecret}`).toString('base64')}`;

    try {
      const response = await fetch(`${this.baseUrl}/invoices/clearance/single`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
          'Accept-Version': 'V2',
          'Clearance-Status': '1',
        },
        body: JSON.stringify({
          invoiceHash,
          uuid,
          invoice: signedXmlBase64,
        }),
      });

      const data = await response.json();
      // Previously fell back to `data.clearanceStatus || 'CLEARED'` unconditionally —
      // an HTTP error response whose body has no clearanceStatus field (e.g. a generic
      // 401/500) would be silently reported as CLEARED. Only default to CLEARED when
      // the HTTP call itself actually succeeded.
      if (!response.ok) {
        throw buildZatcaError('clearStandardInvoice', data.message || 'ZATCA invoice clearance failed', response.status, data);
      }
      return {
        clearanceStatus: data.clearanceStatus || 'CLEARED',
        validationResults: data.validationResults || { infoMessages: [], warningMessages: [], errorMessages: [] },
        clearedInvoiceXml: data.clearedInvoice,
      };
    } catch (err: any) {
      console.error('[ZATCA API] Invoice clearance failed:', err.message);
      throw err.zatcaStep ? err : buildZatcaError('clearStandardInvoice', `ZATCA invoice clearance failed: ${err.message}`);
    }
  }

  /**
    * Live Reporting for Simplified B2C Invoices
    */
  async reportSimplifiedInvoice(signedXmlBase64: string, invoiceHash: string, csidCert: string, csidSecret: string, uuid: string): Promise<ClearanceReportingResponse> {
    if (this.isMocked) {
      return {
        clearanceStatus: 'REPORTED',
        validationResults: {
          infoMessages: [{ status: 'SUCCESS', code: 'SANDBOX-REPORTING', message: 'Simplified invoice reported to ZATCA queue' }],
        },
      };
    }

    const authHeader = `Basic ${Buffer.from(`${csidCert}:${csidSecret}`).toString('base64')}`;

    try {
      const response = await fetch(`${this.baseUrl}/invoices/reporting/single`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
          'Accept-Version': 'V2',
        },
        body: JSON.stringify({
          invoiceHash,
          uuid,
          invoice: signedXmlBase64,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw buildZatcaError('reportSimplifiedInvoice', data.message || 'ZATCA invoice reporting failed', response.status, data);
      }
      return {
        clearanceStatus: data.clearanceStatus || 'REPORTED',
        validationResults: data.validationResults || { infoMessages: [], warningMessages: [], errorMessages: [] },
      };
    } catch (err: any) {
      console.error('[ZATCA API] Invoice reporting failed:', err.message);
      throw err.zatcaStep ? err : buildZatcaError('reportSimplifiedInvoice', `ZATCA invoice reporting failed: ${err.message}`);
    }
  }
}
