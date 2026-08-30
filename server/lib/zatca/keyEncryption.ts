import crypto from 'crypto';

// Encrypts zatcaEnvironmentConfigs.ecdsaPrivateKey at rest — the private key that signs
// every ZATCA invoice/CN/DN for a company was previously stored as a plain PEM string in
// Postgres, for Sandbox, Simulation, and Production alike. AES-256-GCM (authenticated —
// catches tampering, not just confidentiality) with a random IV per encryption and the
// auth tag stored alongside the ciphertext, all keyed off one required env var.
//
// Format: `zenc:v1:<ivBase64>:<authTagBase64>:<ciphertextBase64>` — the `zenc:v1:` prefix
// lets decryptPrivateKey distinguish an encrypted value from a legacy plaintext PEM
// (which always starts with `-----BEGIN`) during the one-time migration, and gives room
// for a v2 format later without breaking existing rows.

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV is the GCM-recommended size (not 16)
const FORMAT_PREFIX = 'zenc:v1:';

function getEncryptionKey(): Buffer {
  const secret = process.env.ZATCA_KEY_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error('ZATCA_KEY_ENCRYPTION_SECRET environment variable must be set — refusing to store or read a ZATCA private key without it.');
  }
  const key = Buffer.from(secret, 'base64');
  if (key.length !== 32) {
    throw new Error(`ZATCA_KEY_ENCRYPTION_SECRET must decode to exactly 32 bytes (256 bits) for AES-256-GCM; got ${key.length}.`);
  }
  return key;
}

export function encryptPrivateKey(plaintextPem: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintextPem, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${FORMAT_PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

// Transitional: a value not carrying the `zenc:v1:` prefix is a pre-encryption legacy row
// (a real PEM always starts with `-----BEGIN`) and is returned as-is rather than rejected
// outright — every write path re-encrypts on its next natural update (Step 2 regeneration,
// the sandbox-sample-key swap in requestProductionCsid), so this branch is expected to see
// less traffic over time rather than needing a forced one-time migration to be correct.
export function decryptPrivateKey(stored: string): string {
  if (!stored.startsWith(FORMAT_PREFIX)) {
    return stored;
  }
  const key = getEncryptionKey();
  const parts = stored.slice(FORMAT_PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted ZATCA private key value — expected 3 colon-separated parts after the format prefix.');
  }
  const [ivB64, authTagB64, ciphertextB64] = parts;
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]);
  return plaintext.toString('utf8');
}
