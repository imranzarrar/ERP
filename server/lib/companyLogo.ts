// The company logo is stored as a data: URL on companies.logo_url (it is printed on every
// document, including PDFs rendered by a headless browser). Shipping that inline in /api/state made
// every state load AND every post-save refresh re-download the whole image (1 MB in production).
// State now carries a short, versioned address instead; the bytes are served once from
// GET /api/public/company-logo/:id?v=<md5> with a one-year immutable cache, so the browser fetches
// the logo once and only again when it actually changes (the version in the address changes with it).
//
// IMPORTANT invariant: that address must NEVER be written back over the stored image. Any write path
// that accepts logoUrl from the client (settings PATCH, the legacy /api/migrate blob) treats a value
// with this prefix as "unchanged".
export const LOGO_PATH_PREFIX = '/api/public/company-logo/';

export function logoPlaceholderUrl(companyId: string, versionHash: string): string {
  return `${LOGO_PATH_PREFIX}${companyId}?v=${versionHash}`;
}

export function isLogoPlaceholder(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(LOGO_PATH_PREFIX);
}

/** Splits a data: URL into its mime type and bytes; null if it is not a base64 image data URL. */
export function parseImageDataUrl(value: string | null | undefined): { mime: string; bytes: Buffer } | null {
  if (!value) return null;
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(value);
  if (!m) return null;
  return { mime: m[1], bytes: Buffer.from(m[2].replace(/\s/g, ''), 'base64') };
}
