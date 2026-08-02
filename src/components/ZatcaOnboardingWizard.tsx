import React, { useState, useEffect } from 'react';
import { DatabaseState } from '../dbStore';
import { ShieldCheck, Server, Key, CheckCircle, AlertTriangle, RefreshCw, FileCode, QrCode, Send, Lock, Globe, Building, ArrowRight, ChevronRight, Zap } from 'lucide-react';

interface ZatcaOnboardingWizardProps {
  db: DatabaseState;
  onUpdateDb: (db: DatabaseState) => void;
}

type ZatcaEnvironment = 'sandbox' | 'simulation' | 'production';

interface EnvironmentStatus {
  environment: ZatcaEnvironment;
  isOnboarded: boolean;
  hasEcdsaKey: boolean;
  hasComplianceCsid: boolean;
  hasProductionCsid: boolean;
  complianceTestsPassed: boolean;
  tinNumber: string;
  crNumber: string;
  streetName: string;
  buildingNumber: string;
  district: string;
  city: string;
  postalCode: string;
  countryCode: string;
  businessCategory: string;
}

export default function ZatcaOnboardingWizard({ db, onUpdateDb }: ZatcaOnboardingWizardProps) {
  const activeCompanyId = db.selectedCompanyId;
  const activeCompany = db.companies?.find(c => c.id === activeCompanyId);

  const [loading, setLoading] = useState(false);
  const [activeStep, setActiveStep] = useState<number>(1);
  // Which environment's onboarding state this wizard is currently viewing/editing —
  // independent of which environment is set as active for live invoice processing.
  const [environment, setEnvironment] = useState<ZatcaEnvironment>('sandbox');
  const [activeEnvironment, setActiveEnvironment] = useState<ZatcaEnvironment>('sandbox');

  // Form State — taxpayer identity is per-environment (sandbox uses ZATCA's published
  // test identity; simulation/production need the company's real registration), so these
  // are re-populated from `environments` every time the viewed `environment` changes,
  // never from a shared company-level field.
  const [tinNumber, setTinNumber] = useState('300000000000003');
  const [crNumber, setCrNumber] = useState('1010000000');
  const [streetName, setStreetName] = useState('King Fahd Road');
  const [buildingNumber, setBuildingNumber] = useState('1234');
  const [district, setDistrict] = useState('Olaya');
  const [city, setCity] = useState('Riyadh');
  const [postalCode, setPostalCode] = useState('12345');
  const [businessCategory, setBusinessCategory] = useState('Commerce');
  // OTP is never persisted server-side (used once, inline, with the CSR exchange).
  // Sandbox always accepts ZATCA's documented placeholder; simulation/production OTPs
  // must come from the company's real ZATCA Fatoora portal login each time.
  const [otp, setOtp] = useState('123456');

  // Status & Key State
  const [environments, setEnvironments] = useState<EnvironmentStatus[]>([]);
  const [generatedCsr, setGeneratedCsr] = useState<string>('');
  const [complianceResult, setComplianceResult] = useState<any>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [hashInfo, setHashInfo] = useState<{ nextIcv: number; previousInvoiceHash: string } | null>(null);

  const currentEnvStatus = environments.find(e => e.environment === environment);

  useEffect(() => {
    setOtp(environment === 'sandbox' ? '123456' : '');
  }, [environment]);

  const fetchZatcaStatus = async () => {
    if (!activeCompanyId) return;
    try {
      const res = await fetch(`/api/zatca/company-status/${activeCompanyId}`);
      if (res.ok) {
        const data = await res.json();
        setEnvironments(data.environments || []);
        setHashInfo({ nextIcv: data.nextIcv, previousInvoiceHash: data.previousInvoiceHash });
        if (data.activeEnvironment) setActiveEnvironment(data.activeEnvironment);

        // Identity is per-environment now — always re-populate from the currently-viewed
        // environment's own row, never from a shared company-level field.
        const envStatus = (data.environments || []).find((e: EnvironmentStatus) => e.environment === environment);
        setTinNumber(envStatus?.tinNumber || '300000000000003');
        setCrNumber(envStatus?.crNumber || '1010000000');
        setStreetName(envStatus?.streetName || 'King Fahd Road');
        setBuildingNumber(envStatus?.buildingNumber || '1234');
        setDistrict(envStatus?.district || 'Olaya');
        setCity(envStatus?.city || 'Riyadh');
        setPostalCode(envStatus?.postalCode || '12345');
        setBusinessCategory(envStatus?.businessCategory || 'Commerce');

        // Determine step for the currently-viewed environment (5 steps: Identity, CSR,
        // OTP+Compliance CSID, Compliance Test, Production CSID/Active).
        if (envStatus?.isOnboarded) {
          setActiveStep(5);
        } else if (envStatus?.hasComplianceCsid) {
          setActiveStep(4);
        } else if (envStatus?.hasEcdsaKey) {
          setActiveStep(3);
        } else {
          setActiveStep(1);
        }
      }
    } catch (e) {
      console.error('Failed to fetch ZATCA status', e);
    }
  };

  useEffect(() => {
    fetchZatcaStatus();
  }, [activeCompanyId, environment]);

  // Mirrors server/lib/zatca/validators.ts's validateTaxpayerIdentity — client-side
  // check so a malformed value is caught immediately, before it ever reaches the CSR
  // (and, later, before an OTP attempt would be spent on it).
  const identityFieldErrors: string[] = [];
  if (!/^3\d{13}3$/.test(tinNumber.trim())) identityFieldErrors.push('VAT/TIN must be exactly 15 digits, starting and ending with 3 (confirmed against a real ZATCA sandbox rejection — BR-KSA-44).');
  if (!crNumber.trim()) identityFieldErrors.push('CR number is required.');
  if (!streetName.trim()) identityFieldErrors.push('Street name is required.');
  if (!buildingNumber.trim()) identityFieldErrors.push('Building number is required.');
  if (!district.trim()) identityFieldErrors.push('District is required.');
  if (!city.trim()) identityFieldErrors.push('City is required.');
  if (!/^\d{5}$/.test(postalCode.trim())) identityFieldErrors.push('Postal code must be exactly 5 digits.');

  const handleSaveConfig = async () => {
    if (identityFieldErrors.length > 0) {
      setMessage({ type: 'error', text: identityFieldErrors.join(' ') });
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch('/api/zatca/company-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: activeCompanyId,
          environment,
          tinNumber,
          crNumber,
          streetName,
          buildingNumber,
          district,
          city,
          postalCode,
          countryCode: 'SA',
          businessCategory,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setMessage({ type: 'success', text: `Tax identity & address profile saved for ${environment}.` });
      setActiveStep(2);
      await fetchZatcaStatus();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  const handleSetActiveEnvironment = async (target: ZatcaEnvironment) => {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch('/api/zatca/set-active-environment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: activeCompanyId, environment: target }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setActiveEnvironment(target);
      setMessage({ type: 'success', text: `${target.toUpperCase()} is now the active environment for live invoice processing.` });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateCsr = async () => {
    // Regenerating overwrites the environment's private key immediately server-side. If a
    // CSID was already issued against the previous key, its certificate's public key no
    // longer matches — signing breaks silently unless the operator is warned up front.
    if (currentEnvStatus?.hasComplianceCsid || currentEnvStatus?.hasProductionCsid) {
      const proceed = window.confirm(
        `${environment.toUpperCase()} already has an issued CSID. Generating a new key pair will invalidate it — you'll need to redo Compliance CSID issuance${currentEnvStatus?.hasProductionCsid ? ' and Production CSID' : ''} and testing. Continue?`
      );
      if (!proceed) return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch('/api/zatca/generate-keypair-csr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: activeCompanyId, environment }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setGeneratedCsr(data.csrBase64);
      setMessage({ type: 'success', text: 'ECDSA secp256k1 Key Pair & CSR generated successfully!' });
      setActiveStep(3);
      await fetchZatcaStatus();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  const handleRequestComplianceCsid = async () => {
    // `generatedCsr` is transient component state, only populated by handleGenerateCsr
    // in this mount — it does NOT survive a refresh/remount (fetchZatcaStatus only
    // restores boolean flags like hasEcdsaKey, which can jump activeStep straight to 3
    // without ever re-populating this). Previously, a remount after Step 2 meant this
    // fell through to the literal string 'MOCK_CSR_DATA', which got submitted to
    // ZATCA's REAL gateway (sandbox/simulation are never mocked) — burning a genuine,
    // single-use, ~1-hour OTP on a submission that's guaranteed to fail. Block it
    // outright instead of ever substituting a placeholder for real ZATCA traffic.
    if (!generatedCsr) {
      setMessage({ type: 'error', text: 'No CSR is loaded in this session. Go back to Step 2 and generate the keypair/CSR again before requesting a Compliance CSID — submitting without a real CSR would waste your OTP on a guaranteed failure.' });
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch('/api/zatca/request-compliance-csid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: activeCompanyId,
          environment,
          otp,
          csrBase64: generatedCsr,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setMessage({ type: 'success', text: `Compliance CSID Granted! Request ID: ${data.requestId}` });
      setActiveStep(4);
      await fetchZatcaStatus();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  const handleRunComplianceTests = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch('/api/zatca/run-compliance-suite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: activeCompanyId, environment }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setComplianceResult(data);
      setMessage({ type: data.status === 'PASSED' ? 'success' : 'info', text: data.message });
      await fetchZatcaStatus();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  const handleRequestProductionCsid = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch('/api/zatca/request-production-csid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: activeCompanyId, environment }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setMessage({ type: 'success', text: `${environment.toUpperCase()} onboarding complete. Production CSID activated.` });
      setActiveStep(5);
      await fetchZatcaStatus();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-8 max-w-6xl mx-auto p-1">
      {/* Environment-aware status banner. IMPORTANT: this describes the PLATFORM'S
          underlying signing code (dual-gate verified once during development against
          ZATCA's real sandbox gateway and ZATCA's own official SDK validator) — it is
          NOT a per-company onboarding status. A brand-new company with zero CSR/CSID
          activity of its own will still see this banner, since it's about whether the
          code THIS company is about to use has been proven correct, not about what
          this company has done yet. Confirmed live: this was genuinely mistaken for
          "this company has passed Sandbox" by a real user — reworded to make the
          distinction explicit rather than assume it reads as intended. Each company's
          OWN actual progress is the step-by-step wizard below (CSR generation, OTP,
          Compliance CSID, compliance tests, Production CSID), not this banner. */}
      <div className={`p-4 rounded-2xl border-2 flex items-start gap-3 shadow-sm ${
        environment === 'sandbox' ? 'border-emerald-400 bg-emerald-50 text-emerald-900' : 'border-blue-400 bg-blue-50 text-blue-900'
      }`}>
        {environment === 'sandbox'
          ? <CheckCircle className="w-5 h-5 shrink-0 mt-0.5 text-emerald-500" />
          : <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-blue-500" />}
        <div className="text-sm font-medium leading-relaxed">
          {environment === 'sandbox' ? (
            <><span className="font-black uppercase tracking-wide">About this app's Sandbox code — not {activeCompany?.name || 'your company'}'s onboarding progress.</span>{' '}
            The CSR construction, XML canonicalization, and XAdES-BES digital signing logic this app uses have been independently verified against ZATCA's real sandbox gateway and ZATCA's own official SDK validator — so when {activeCompany?.name || 'your company'} completes the steps below, they're backed by proven-correct code. {activeCompany?.name || 'This company'} itself hasn't onboarded yet — that's tracked by the steps below, not this message.</>
          ) : (
            <><span className="font-black uppercase tracking-wide">{environment.toUpperCase()} — Awaiting Real Credentials.</span>{' '}
            This uses the same verified signing code as Sandbox, but hasn't been exercised against ZATCA's real {environment} gateway yet — that requires {activeCompany?.name || 'your company'}'s actual registered VAT/CR/address and a live Fatoora OTP for this environment.</>
          )}
        </div>
      </div>
      {/* Header Banner */}
      <div className="bg-slate-900 rounded-3xl p-6 md:p-8 text-white shadow-xl relative overflow-hidden">
        <div className="absolute -right-10 -bottom-10 opacity-10 pointer-events-none">
          <ShieldCheck className="w-96 h-96 text-emerald-400" />
        </div>
        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div>
            <div className="inline-flex items-center gap-2 bg-emerald-500/20 text-emerald-400 text-xs font-bold px-3 py-1 rounded-full mb-3 border border-emerald-500/30">
              <Zap className="w-3.5 h-3.5" /> Saudi Arabia ZATCA Phase 2 (Fatoora) Compliant
            </div>
            <h2 className="text-2xl md:text-3xl font-black text-white tracking-tight">
              E-Invoicing Phase 2 (Integration & Clearance)
            </h2>
            <p className="text-slate-400 text-sm mt-1 max-w-2xl leading-relaxed">
              Connect {activeCompany?.name || 'Organization'} to the Saudi ZATCA Fatoora Portal. Sandbox, Simulation and Production each maintain fully independent CSID credentials and onboarding progress.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <button
              onClick={fetchZatcaStatus}
              disabled={loading}
              className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold rounded-2xl flex items-center justify-center gap-2 transition-all border border-slate-700"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh Status
            </button>
          </div>
        </div>
      </div>

      {/* Alert Messages */}
      {message && (
        <div className={`p-4 rounded-2xl text-xs font-bold flex items-center justify-between gap-3 shadow-sm border ${
          message.type === 'success' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' :
          message.type === 'error' ? 'bg-rose-50 text-rose-800 border-rose-200' : 'bg-blue-50 text-blue-800 border-blue-200'
        }`}>
          <div className="flex items-center gap-2">
            {message.type === 'success' ? <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" /> : <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />}
            <span>{message.text}</span>
          </div>
          <button onClick={() => setMessage(null)} className="text-slate-400 hover:text-slate-600 text-sm font-bold">×</button>
        </div>
      )}

      {/* Live Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
          <p className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider">Active for Live Processing</p>
          <div className="mt-2 flex items-center gap-2">
            <Globe className="w-5 h-5 text-indigo-600" />
            <span className="text-base font-extrabold uppercase text-slate-800">{activeEnvironment}</span>
          </div>
          <p className="text-[11px] text-slate-400 mt-1">Used by every new invoice submission</p>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
          <p className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider">{environment.toUpperCase()} Onboarding State</p>
          <div className="mt-2 flex items-center gap-2">
            {currentEnvStatus?.isOnboarded ? (
              <span className="px-2.5 py-1 bg-emerald-100 text-emerald-700 font-extrabold text-xs rounded-full flex items-center gap-1">
                <CheckCircle className="w-3.5 h-3.5" /> Onboarded
              </span>
            ) : (
              <span className="px-2.5 py-1 bg-amber-100 text-amber-700 font-extrabold text-xs rounded-full flex items-center gap-1">
                <AlertTriangle className="w-3.5 h-3.5" /> Pending Setup
              </span>
            )}
          </div>
          <p className="text-[11px] text-slate-400 mt-1">CSID Cert & Key Status (this environment only)</p>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
          <p className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider">Next Sequence Counter (ICV)</p>
          <p className="text-xl font-black text-slate-900 mt-1">#{hashInfo?.nextIcv || 1}</p>
          <p className="text-[11px] text-slate-400 mt-1">Sequential Cryptographic Count</p>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
          <p className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider">Previous Invoice Hash (PIH)</p>
          <p className="text-xs font-mono font-bold text-slate-700 truncate mt-2 bg-slate-50 p-1.5 rounded border border-slate-200">
            {hashInfo?.previousInvoiceHash || 'NWZlY2ViNjZmZmM4...'}
          </p>
          <p className="text-[11px] text-slate-400 mt-1">Chain Integrity Guard</p>
        </div>
      </div>

      {/* Environment Selector Toggle Cards */}
      <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm space-y-4">
        <div>
          <h3 className="text-base font-extrabold text-slate-900 flex items-center gap-2">
            <Server className="w-5 h-5 text-indigo-600" /> Environment
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Sandbox, Simulation, and Production each hold independent onboarding progress and credentials — completing one never overwrites another. Pick which one to view/edit below, and separately choose which one is active for live invoices.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {([
            { key: 'sandbox' as const, title: 'Sandbox Portal', badge: 'Testing', badgeClass: 'bg-amber-100 text-amber-800', desc: 'Ideal for testing CSR, CSID generation, and XML UBL 2.1 validation without submitting tax liabilities.', endpoint: 'gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal' },
            { key: 'simulation' as const, title: 'Simulation Portal', badge: 'Staging', badgeClass: 'bg-blue-100 text-blue-800', desc: 'Pre-production testing environment mirroring live ZATCA rules and compliance validation endpoints.', endpoint: 'gw-fatoora.zatca.gov.sa/e-invoicing/simulation' },
            { key: 'production' as const, title: 'Production Gateway', badge: 'Live Tax', badgeClass: 'bg-emerald-100 text-emerald-800', desc: 'Official Saudi Customs & Tax Gateway. Real-time clearance for B2B invoices and reporting for B2C invoices.', endpoint: 'gw-fatoora.zatca.gov.sa/e-invoicing/core' },
          ]).map(env => {
            const envStatus = environments.find(e => e.environment === env.key);
            return (
              <div
                key={env.key}
                onClick={() => setEnvironment(env.key)}
                className={`p-4 rounded-2xl border-2 cursor-pointer transition-all flex flex-col justify-between ${
                  environment === env.key ? 'border-indigo-600 bg-indigo-50/40 ring-2 ring-indigo-600/20' : 'border-slate-200 hover:border-slate-300'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span className="font-extrabold text-sm text-slate-900">{env.title}</span>
                    <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded ${env.badgeClass}`}>{env.badge}</span>
                  </div>
                  <p className="text-xs text-slate-500 mt-2">{env.desc}</p>
                  <div className="flex items-center gap-2 mt-2">
                    {envStatus?.isOnboarded ? (
                      <span className="text-[10px] font-bold text-emerald-700 flex items-center gap-1"><CheckCircle className="w-3 h-3" /> Onboarded</span>
                    ) : (
                      <span className="text-[10px] font-bold text-slate-400">Not onboarded</span>
                    )}
                    {activeEnvironment === env.key && (
                      <span className="text-[10px] font-black uppercase px-1.5 py-0.5 rounded bg-indigo-600 text-white">Active</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between mt-3">
                  <p className="text-[10px] font-mono text-indigo-600 truncate">{env.endpoint}</p>
                  {activeEnvironment !== env.key && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleSetActiveEnvironment(env.key); }}
                      disabled={loading}
                      className="text-[10px] font-bold text-indigo-600 hover:text-indigo-800 underline shrink-0 ml-2"
                    >
                      Set active
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* STEP-BY-STEP ONBOARDING WIZARD */}
      <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
        {/* Step Progress Bar */}
        <div className="border-b border-slate-200 bg-slate-50/60 p-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 text-center">
            {[
              { num: 1, title: 'Company Identity' },
              { num: 2, title: 'Key pair & CSR' },
              { num: 3, title: 'OTP & Compliance CSID' },
              { num: 4, title: 'Compliance Test' },
              { num: 5, title: 'Production CSID' },
            ].map(step => (
              <button
                key={step.num}
                onClick={() => setActiveStep(step.num)}
                className={`py-2 px-3 rounded-xl text-xs font-bold transition-all text-start flex items-center gap-2 ${
                  activeStep === step.num
                    ? 'bg-indigo-600 text-white shadow'
                    : activeStep > step.num
                    ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
                    : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
                }`}
              >
                <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black shrink-0 ${
                  activeStep === step.num ? 'bg-white/20 text-white' : activeStep > step.num ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-600'
                }`}>
                  {step.num}
                </span>
                <span className="truncate">{step.title}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Wizard Step Details */}
        <div className="p-6 md:p-8 space-y-6">
          {/* STEP 1: Tax Identity & Address */}
          {activeStep === 1 && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-extrabold text-slate-900 flex items-center gap-2">
                  <Building className="w-5 h-5 text-indigo-600" /> Step 1: ZATCA Tax Identity & National Address ({environment})
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  {environment === 'sandbox'
                    ? "Sandbox uses ZATCA's own published test identity by default — the values below are pre-filled and normally don't need to change."
                    : `Enter ${activeCompany?.name || 'your company'}'s real ZATCA-registered VAT/TIN, CR number, and National Address for ${environment} — this must match your official registration exactly.`}
                  {' '}Each environment (Sandbox/Simulation/Production) keeps its own independent identity — editing one never overwrites another.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">15-Digit VAT Number (TIN)*</label>
                  <input
                    type="text"
                    value={tinNumber}
                    onChange={e => setTinNumber(e.target.value)}
                    placeholder="300000000000003"
                    className="w-full px-3.5 py-2.5 text-xs font-mono font-bold rounded-xl border border-slate-300 focus:ring-2 focus:ring-indigo-500"
                  />
                  <span className="text-[10px] text-slate-400 mt-0.5 block">Must be 15 digits starting with 3</span>
                </div>

                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">Commercial Registration (CR) Number</label>
                  <input
                    type="text"
                    value={crNumber}
                    onChange={e => setCrNumber(e.target.value)}
                    placeholder="1010000000"
                    className="w-full px-3.5 py-2.5 text-xs font-mono font-bold rounded-xl border border-slate-300 focus:ring-2 focus:ring-indigo-500"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">Building Number (4 Digits)</label>
                  <input
                    type="text"
                    value={buildingNumber}
                    onChange={e => setBuildingNumber(e.target.value)}
                    placeholder="1234"
                    className="w-full px-3.5 py-2.5 text-xs font-bold rounded-xl border border-slate-300 focus:ring-2 focus:ring-indigo-500"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">Street Name</label>
                  <input
                    type="text"
                    value={streetName}
                    onChange={e => setStreetName(e.target.value)}
                    placeholder="King Fahd Road"
                    className="w-full px-3.5 py-2.5 text-xs font-bold rounded-xl border border-slate-300 focus:ring-2 focus:ring-indigo-500"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">District Name</label>
                  <input
                    type="text"
                    value={district}
                    onChange={e => setDistrict(e.target.value)}
                    placeholder="Olaya"
                    className="w-full px-3.5 py-2.5 text-xs font-bold rounded-xl border border-slate-300 focus:ring-2 focus:ring-indigo-500"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">City</label>
                  <input
                    type="text"
                    value={city}
                    onChange={e => setCity(e.target.value)}
                    placeholder="Riyadh"
                    className="w-full px-3.5 py-2.5 text-xs font-bold rounded-xl border border-slate-300 focus:ring-2 focus:ring-indigo-500"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">Postal Code (5 Digits)</label>
                  <input
                    type="text"
                    value={postalCode}
                    onChange={e => setPostalCode(e.target.value)}
                    placeholder="12345"
                    className="w-full px-3.5 py-2.5 text-xs font-mono font-bold rounded-xl border border-slate-300 focus:ring-2 focus:ring-indigo-500"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">Business Industry Category</label>
                  <input
                    type="text"
                    value={businessCategory}
                    onChange={e => setBusinessCategory(e.target.value)}
                    placeholder="Commerce / Retail"
                    className="w-full px-3.5 py-2.5 text-xs font-bold rounded-xl border border-slate-300 focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
              </div>

              {identityFieldErrors.length > 0 && (
                <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-[11px] font-bold text-rose-700 space-y-0.5">
                  {identityFieldErrors.map((e, i) => <div key={i}>• {e}</div>)}
                </div>
              )}

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-200">
                <button
                  onClick={handleSaveConfig}
                  disabled={loading || identityFieldErrors.length > 0}
                  className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-extrabold rounded-2xl flex items-center gap-2 shadow-md shadow-indigo-600/20"
                >
                  Save & Continue to Step 2 <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* STEP 2: Key Pair & CSR */}
          {activeStep === 2 && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-extrabold text-slate-900 flex items-center gap-2">
                  <Key className="w-5 h-5 text-indigo-600" /> Step 2: Generate ECDSA Cryptographic Keypair & CSR ({environment})
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  ZATCA Phase 2 requires an Elliptic Curve Digital Signature Algorithm (ECDSA) <code className="bg-slate-100 px-1 py-0.5 rounded font-mono">secp256k1</code> keypair and X.509 Certificate Signing Request, generated separately per environment.
                </p>
              </div>

              <div className="bg-slate-50 p-5 rounded-2xl border border-slate-200 space-y-3">
                <div className="flex items-center gap-3 text-xs font-bold text-slate-700">
                  <Lock className="w-4 h-4 text-slate-500" /> Private Key Storage: database, scoped to {environment} — not yet encrypted at rest (tracked separately, see BACKLOG.md)
                </div>
                <div className="text-xs text-slate-600 leading-relaxed">
                  Clicking the button below generates a fresh ECDSA private key and packages your organization details into a Base64-encoded ZATCA CSR for this environment.
                </div>
              </div>

              {generatedCsr && (
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-700 block">Generated ZATCA Base64 CSR:</label>
                  <textarea
                    readOnly
                    rows={4}
                    value={generatedCsr}
                    className="w-full p-3 font-mono text-[11px] bg-slate-900 text-emerald-400 rounded-2xl border border-slate-800"
                  />
                </div>
              )}

              <div className="flex justify-between items-center pt-4 border-t border-slate-200">
                <button
                  onClick={() => setActiveStep(1)}
                  className="px-4 py-2 bg-slate-100 text-slate-700 text-xs font-bold rounded-2xl"
                >
                  Back
                </button>

                <button
                  onClick={handleGenerateCsr}
                  disabled={loading}
                  className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-extrabold rounded-2xl flex items-center gap-2 shadow-md shadow-indigo-600/20"
                >
                  <Key className="w-4 h-4" /> {loading ? 'Generating...' : 'Generate ECDSA Keypair & CSR'}
                </button>
              </div>
            </div>
          )}

          {/* STEP 3: OTP + Issue Compliance CSID (merged — target UX is "switch
              environment, provide OTP, and that's it": a fresh OTP is short-lived
              (~1 hour), so entry and submission are one action, not two clicks apart) */}
          {activeStep === 3 && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-extrabold text-slate-900 flex items-center gap-2">
                  <Send className="w-5 h-5 text-indigo-600" /> Step 3: Enter OTP & Issue Compliance CSID ({environment})
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  {environment === 'sandbox'
                    ? <>Sandbox always accepts <code className="bg-slate-100 px-1 py-0.5 rounded font-mono">123456</code> as the OTP — no real portal login needed for testing.</>
                    : <>ZATCA OTPs are short-lived (~1 hour) — log into the official Saudi ZATCA Fatoora Portal, request a fresh 6-digit E-Invoicing OTP for {environment}, then paste and submit it here immediately. It's used once and never stored.</>
                  }
                </p>
              </div>

              <div className="max-w-md space-y-3">
                <label className="text-xs font-bold text-slate-700 block">ZATCA Portal OTP Code (6 Digits)</label>
                <input
                  type="text"
                  maxLength={6}
                  value={otp}
                  onChange={e => setOtp(e.target.value)}
                  placeholder={environment === 'sandbox' ? '123456' : 'Enter OTP from ZATCA portal'}
                  className="w-full text-center tracking-widest text-xl font-mono font-black py-3 rounded-2xl border-2 border-indigo-500 focus:ring-4 focus:ring-indigo-100"
                />
              </div>

              <div className="bg-emerald-50 border border-emerald-200 p-5 rounded-2xl space-y-2">
                <p className="text-xs font-bold text-emerald-900">Ready for ZATCA Gateway Handshake</p>
                <p className="text-xs text-emerald-700">
                  Target Endpoint: <code className="font-mono bg-emerald-100/80 px-1 rounded">{environment === 'sandbox' ? 'gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal' : environment === 'simulation' ? 'gw-fatoora.zatca.gov.sa/e-invoicing/simulation' : 'gw-fatoora.zatca.gov.sa/e-invoicing/core'}</code>
                </p>
              </div>

              <div className="flex justify-between items-center pt-4 border-t border-slate-200">
                <button
                  onClick={() => setActiveStep(2)}
                  className="px-4 py-2 bg-slate-100 text-slate-700 text-xs font-bold rounded-2xl"
                >
                  Back
                </button>

                <button
                  onClick={handleRequestComplianceCsid}
                  disabled={loading || !otp || otp.length < 6}
                  className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-extrabold rounded-2xl flex items-center gap-2 shadow-md shadow-indigo-600/20"
                >
                  <ShieldCheck className="w-4 h-4" /> {loading ? 'Issuing...' : 'Issue Compliance CSID'}
                </button>
              </div>
            </div>
          )}

          {/* STEP 4: Compliance Test Suite */}
          {activeStep === 4 && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-extrabold text-slate-900 flex items-center gap-2">
                  <FileCode className="w-5 h-5 text-indigo-600" /> Step 4: Execute Mandatory ZATCA Compliance Test Suite ({environment})
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  This submits real Standard B2B and Simplified B2C sample invoices to ZATCA. Credit Note and Debit Note scenarios are reported as not-yet-implemented — this ERP doesn't generate those document types yet.
                </p>
              </div>

              {complianceResult && (
                <div className="bg-slate-900 text-white p-5 rounded-2xl space-y-3 font-mono text-xs">
                  <p className={`font-bold ${complianceResult.status === 'PASSED' ? 'text-emerald-400' : 'text-amber-400'}`}>Suite Status: {complianceResult.status}</p>
                  <div className="space-y-1.5">
                    {complianceResult.tests?.map((t: any, idx: number) => (
                      <div key={idx} className="flex items-center justify-between bg-slate-800 p-2.5 rounded-xl border border-slate-700">
                        <span>{t.name}</span>
                        <span className={`px-2 py-0.5 font-bold rounded text-[10px] ${
                          t.status === 'CLEARED' || t.status === 'REPORTED' ? 'bg-emerald-500/20 text-emerald-400' :
                          t.status === 'NOT_IMPLEMENTED' ? 'bg-slate-600/40 text-slate-300' : 'bg-rose-500/20 text-rose-400'
                        }`}>
                          {t.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex justify-between items-center pt-4 border-t border-slate-200">
                <button
                  onClick={handleRunComplianceTests}
                  disabled={loading}
                  className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-extrabold rounded-2xl flex items-center gap-2"
                >
                  <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Run Compliance Tests
                </button>

                <button
                  onClick={handleRequestProductionCsid}
                  disabled={loading || !currentEnvStatus?.complianceTestsPassed}
                  title={!currentEnvStatus?.complianceTestsPassed ? 'Run and pass the compliance test suite for this environment first' : undefined}
                  className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-extrabold rounded-2xl flex items-center gap-2 shadow-md shadow-emerald-600/20"
                >
                  <CheckCircle className="w-4 h-4" /> Upgrade to Production CSID <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* STEP 5: Active Production State */}
          {activeStep === 5 && (
            <div className="space-y-6">
              <div className="bg-emerald-50 border border-emerald-200 p-6 rounded-3xl text-center space-y-3">
                <div className="w-12 h-12 bg-emerald-500 text-white rounded-full flex items-center justify-center mx-auto shadow-lg shadow-emerald-500/30">
                  <CheckCircle className="w-6 h-6" />
                </div>
                <h3 className="text-xl font-black text-emerald-950">
                  {environment.toUpperCase()} Fully Onboarded to ZATCA Phase 2!
                </h3>
                <p className="text-xs text-emerald-800 max-w-xl mx-auto leading-relaxed">
                  {activeCompany?.name} is authorized for UBL 2.1 E-Invoice digital signing, real-time B2B Clearance, B2C Reporting, and cryptographic hash-chaining in the {environment} environment.
                  {activeEnvironment !== environment && ' This environment is not yet set as active for live invoice processing — use "Set active" above when ready.'}
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-1">
                  <span className="text-[10px] font-extrabold text-slate-400 uppercase">Standard Tax Invoice (B2B)</span>
                  <p className="text-xs font-bold text-slate-800">Automated Real-Time Clearance Gateway Enabled</p>
                  <p className="text-[11px] text-slate-500">Invoices receive official ZATCA Clearance Stamp before email/PDF generation.</p>
                </div>

                <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-1">
                  <span className="text-[10px] font-extrabold text-slate-400 uppercase">Simplified Tax Invoice (B2C)</span>
                  <p className="text-xs font-bold text-slate-800">24-Hour Batch Reporting Gateway Enabled</p>
                  <p className="text-[11px] text-slate-500">POS and retail sales are queued with cryptographic TLV QR code stamps.</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
