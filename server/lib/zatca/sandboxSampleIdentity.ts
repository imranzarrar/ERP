import crypto from 'crypto';

// ZATCA's Sandbox (developer-portal) environment is "restricted with static data" —
// confirmed directly by a ZATCA representative on the official Fatoora Developer
// Community forum (https://zatca1.discourse.group/t/zatca-sandbox-confused-about-onboarding-and-csid-process-php-integration/7383):
// the Production CSID endpoint always returns the SAME fixed certificate for the shared
// public test taxpayer identity (VAT 399999999900003 / CR 886431145), regardless of the
// CSR actually submitted — reproduced live in this project 3 times, with 2 genuinely
// different key pairs, always the identical certificate.
//
// That returned certificate is not arbitrary: it is ZATCA's OWN published sample
// certificate, bundled directly in their official Java SDK distribution
// (Data/Certificates/cert.pem) alongside its genuinely matching private key
// (Data/Certificates/ec-secp256k1-priv-key.pem) — verified with a real sign/verify round
// trip. ZATCA ships this pair specifically so sandbox testers using the shared identity
// have SOMETHING to sign with that will actually match what their sandbox hands back.
//
// SANDBOX ONLY. Simulation/Production each use a company's own real, unique VAT — ZATCA
// issues a genuine per-company certificate there, never this fixed one, and the
// key/certificate mismatch guard in zatca.ts (certificateMatchesPrivateKey) still hard-
// fails for those environments exactly as before. This module must never be reached for
// environment !== 'sandbox'.

export const ZATCA_SANDBOX_SAMPLE_CERT_SERIAL = '1100003803C5F74023B3FC5C5F000100003803';

const CERT_BODY_BASE64 =
  'MIID3jCCA4SgAwIBAgITEQAAOAPF90Ajs/xcXwABAAA4AzAKBggqhkjOPQQDAjBiMRUwEwYKCZImiZPyLGQBGRYFbG9jYWwxEzARBgoJkiaJk/IsZAEZFgNnb3YxFzAVBgoJkiaJk/IsZAEZFgdleHRnYXp0MRswGQYDVQQDExJQUlpFSU5WT0lDRVNDQTQtQ0EwHhcNMjQwMTExMDkxOTMwWhcNMjkwMTA5MDkxOTMwWjB1MQswCQYDVQQGEwJTQTEmMCQGA1UEChMdTWF4aW11bSBTcGVlZCBUZWNoIFN1cHBseSBMVEQxFjAUBgNVBAsTDVJpeWFkaCBCcmFuY2gxJjAkBgNVBAMTHVRTVC04ODY0MzExNDUtMzk5OTk5OTk5OTAwMDAzMFYwEAYHKoZIzj0CAQYFK4EEAAoDQgAEoWCKa0Sa9FIErTOv0uAkC1VIKXxU9nPpx2vlf4yhMejy8c02XJblDq7tPydo8mq0ahOMmNo8gwni7Xt1KT9UeKOCAgcwggIDMIGtBgNVHREEgaUwgaKkgZ8wgZwxOzA5BgNVBAQMMjEtVFNUfDItVFNUfDMtZWQyMmYxZDgtZTZhMi0xMTE4LTliNTgtZDlhOGYxMWU0NDVmMR8wHQYKCZImiZPyLGQBAQwPMzk5OTk5OTk5OTAwMDAzMQ0wCwYDVQQMDAQxMTAwMREwDwYDVQQaDAhSUlJEMjkyOTEaMBgGA1UEDwwRU3VwcGx5IGFjdGl2aXRpZXMwHQYDVR0OBBYEFEX+YvmmtnYoDf9BGbKo7ocTKYK1MB8GA1UdIwQYMBaAFJvKqqLtmqwskIFzVvpP2PxT+9NnMHsGCCsGAQUFBwEBBG8wbTBrBggrBgEFBQcwAoZfaHR0cDovL2FpYTQuemF0Y2EuZ292LnNhL0NlcnRFbnJvbGwvUFJaRUludm9pY2VTQ0E0LmV4dGdhenQuZ292LmxvY2FsX1BSWkVJTlZPSUNFU0NBNC1DQSgxKS5jcnQwDgYDVR0PAQH/BAQDAgeAMDwGCSsGAQQBgjcVBwQvMC0GJSsGAQQBgjcVCIGGqB2E0PsShu2dJIfO+xnTwFVmh/qlZYXZhD4CAWQCARIwHQYDVR0lBBYwFAYIKwYBBQUHAwMGCCsGAQUFBwMCMCcGCSsGAQQBgjcVCgQaMBgwCgYIKwYBBQUHAwMwCgYIKwYBBQUHAwIwCgYIKoZIzj0EAwIDSAAwRQIhALE/ichmnWXCUKUbca3yci8oqwaLvFdHVjQrveI9uqAbAiA9hC4M8jgMBADPSzmd2uiPJA6gKR3LE03U75eqbC/rXA==';

const PRIVATE_KEY_SEC1_BASE64 =
  'MHQCAQEEIL14JV+5nr/sE8Sppaf2IySovrhVBtt8+yz+g4NRKyz8oAcGBSuBBAAKoUQDQgAEoWCKa0Sa9FIErTOv0uAkC1VIKXxU9nPpx2vlf4yhMejy8c02XJblDq7tPydo8mq0ahOMmNo8gwni7Xt1KT9UeA==';

// binarySecurityToken is base64(certBodyText) — this project's decodeZatcaCsidCertificate
// (x509.ts) expects that double-encoding, matching what ZATCA's real API responses use.
export function getZatcaSandboxSampleBinarySecurityToken(): string {
  return Buffer.from(CERT_BODY_BASE64, 'utf8').toString('base64');
}

// Normalized to PKCS8 PEM to match the format generateZatcaKeyPair() already produces
// elsewhere in this codebase, so every stored ecdsaPrivateKey has one consistent shape.
export function getZatcaSandboxSamplePrivateKeyPem(): string {
  const sec1Pem = `-----BEGIN EC PRIVATE KEY-----\n${PRIVATE_KEY_SEC1_BASE64}\n-----END EC PRIVATE KEY-----`;
  const keyObject = crypto.createPrivateKey(sec1Pem);
  return keyObject.export({ type: 'pkcs8', format: 'pem' }) as string;
}
