// EGS solution identity embedded in every ZATCA CSR's device serial number field
// (SN, format "1-AppName|2-Version|3-UUID" — see generateZatcaCsr in crypto.ts). Purely
// descriptive metadata ZATCA records against each onboarded device (visible in the
// Fatoora Portal's "list of onboarded devices" view) — has no bearing on the actual
// signing key or on any certificate already issued: those are fixed at the moment a CSR
// is submitted and are never retroactively affected by changing these constants later.
export const ZATCA_EGS_APP_NAME = 'Warraq';
export const ZATCA_EGS_APP_VERSION = '1.1';
