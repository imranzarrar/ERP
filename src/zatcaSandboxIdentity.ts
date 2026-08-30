// ZATCA's Sandbox environment is "restricted with static data" (confirmed by a ZATCA
// representative on the official Fatoora Developer Community forum, and reproduced live
// in this project 3 times with different CSRs) — the Production CSID endpoint always
// returns the SAME fixed certificate for one shared public test taxpayer identity,
// regardless of what a company's onboarding wizard submitted in Step 1. These are that
// identity's real values: VAT/CR confirmed directly from the certificate ZATCA actually
// returns (server/lib/zatca/sandboxSampleIdentity.ts decodes and verifies it); the address
// fields match ZATCA's own bundled SDK sample invoices for the same registered entity
// ("Maximum Speed Tech Supply LTD" / VAT 399999999900003 — tools/zatca-sdk/Data/Samples/).
//
// This file is the single source of truth for these values on BOTH sides: the client-side
// onboarding wizard (ZatcaOnboardingWizard.tsx) shows them as Sandbox's Step 1 defaults,
// and the server (sandboxSampleIdentity.ts) writes them into the environment config once
// it detects ZATCA actually returned this fixed certificate — keeping what an admin sees
// during onboarding consistent with what the certificate ends up bound to, instead of the
// two drifting apart (which is exactly what caused a real "certificate-permissions"
// rejection: the wizard showed a fictional TIN that was never what got issued).
export const ZATCA_SANDBOX_SAMPLE_VAT_NUMBER = '399999999900003';
export const ZATCA_SANDBOX_SAMPLE_CR_NUMBER = '886431145';
export const ZATCA_SANDBOX_SAMPLE_STREET_NAME = 'Prince Sultan';
export const ZATCA_SANDBOX_SAMPLE_BUILDING_NUMBER = '2322';
export const ZATCA_SANDBOX_SAMPLE_DISTRICT = 'Al-Murabba';
export const ZATCA_SANDBOX_SAMPLE_CITY = 'Riyadh';
export const ZATCA_SANDBOX_SAMPLE_POSTAL_CODE = '23333';
export const ZATCA_SANDBOX_SAMPLE_BUSINESS_CATEGORY = 'Commerce';
