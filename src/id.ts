// Isomorphic UUIDv7 generator (RFC 9562). Time-ordered (unlike the short random-string
// IDs this replaces across the schema — see BACKLOG.md), so Postgres B-tree insert
// locality stays good on high-volume tables, and collision probability is astronomically
// low even at very large scale (the previous 7-char base36 scheme had an expected ~64,000
// collisions at 100 million rows). Works identically in Node and the browser via the
// standard Web Crypto API (`crypto.getRandomValues`), available as a global in both
// without any environment-specific import or bundler shim.
export function generateId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // 48-bit big-endian Unix ms timestamp in bytes 0-5.
  const ts = BigInt(Date.now());
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  }

  // Version 7 in the high nibble of byte 6; low nibble + all of byte 7 stay random (rand_a).
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // Variant 10xxxxxx in the top 2 bits of byte 8; the rest stays random (start of rand_b).
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
