// Not the default `.env` filename — see server.ts for why.
import dotenv from 'dotenv';
dotenv.config({ path: 'app.secrets', quiet: true });
import { describe, it, expect } from 'vitest';
import { encryptPrivateKey, decryptPrivateKey } from '../server/lib/zatca/keyEncryption.js';

// Unit coverage for the encryption-at-rest wrapper around zatcaEnvironmentConfigs.
// ecdsaPrivateKey — every invoice's ZATCA signature ultimately depends on this round-
// tripping exactly, for Sandbox, Simulation, and Production alike, so a silent corruption
// here would surface as every future invoice failing to sign, not as an obvious error at
// the point of the bug.

const SAMPLE_PEM = '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgTEST1234567890AB\n-----END PRIVATE KEY-----\n';

describe('encryptPrivateKey / decryptPrivateKey', () => {
  it('round-trips a PEM string exactly', () => {
    const encrypted = encryptPrivateKey(SAMPLE_PEM);
    const decrypted = decryptPrivateKey(encrypted);
    expect(decrypted).toBe(SAMPLE_PEM);
  });

  it('produces a different ciphertext each time (random IV), but both decrypt correctly', () => {
    const a = encryptPrivateKey(SAMPLE_PEM);
    const b = encryptPrivateKey(SAMPLE_PEM);
    expect(a).not.toBe(b);
    expect(decryptPrivateKey(a)).toBe(SAMPLE_PEM);
    expect(decryptPrivateKey(b)).toBe(SAMPLE_PEM);
  });

  it('encrypted values carry the zenc:v1: format prefix', () => {
    const encrypted = encryptPrivateKey(SAMPLE_PEM);
    expect(encrypted.startsWith('zenc:v1:')).toBe(true);
  });

  it('passes through a legacy plaintext PEM unchanged (pre-migration rows)', () => {
    expect(decryptPrivateKey(SAMPLE_PEM)).toBe(SAMPLE_PEM);
  });

  it('rejects a tampered ciphertext (GCM auth tag catches modification)', () => {
    const encrypted = encryptPrivateKey(SAMPLE_PEM);
    const parts = encrypted.split(':');
    // Flip the last character of the ciphertext segment (final colon-separated part).
    const ciphertext = parts[parts.length - 1];
    const tamperedChar = ciphertext[0] === 'A' ? 'B' : 'A';
    parts[parts.length - 1] = tamperedChar + ciphertext.slice(1);
    const tampered = parts.join(':');
    expect(() => decryptPrivateKey(tampered)).toThrow();
  });

  it('rejects a malformed encrypted value (wrong number of parts)', () => {
    expect(() => decryptPrivateKey('zenc:v1:onlyonepart')).toThrow(/Malformed/);
  });

  it('throws a clear error when ZATCA_KEY_ENCRYPTION_SECRET is unset', () => {
    const original = process.env.ZATCA_KEY_ENCRYPTION_SECRET;
    delete process.env.ZATCA_KEY_ENCRYPTION_SECRET;
    try {
      expect(() => encryptPrivateKey(SAMPLE_PEM)).toThrow(/ZATCA_KEY_ENCRYPTION_SECRET/);
    } finally {
      if (original !== undefined) process.env.ZATCA_KEY_ENCRYPTION_SECRET = original;
    }
  });

  it('throws a clear error when the secret is not a valid 32-byte key', () => {
    const original = process.env.ZATCA_KEY_ENCRYPTION_SECRET;
    process.env.ZATCA_KEY_ENCRYPTION_SECRET = Buffer.from('too-short').toString('base64');
    try {
      expect(() => encryptPrivateKey(SAMPLE_PEM)).toThrow(/32 bytes/);
    } finally {
      if (original !== undefined) process.env.ZATCA_KEY_ENCRYPTION_SECRET = original;
    }
  });
});
