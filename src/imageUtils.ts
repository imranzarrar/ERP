/**
 * Decodes a BMP base64 string to a highly-compatible PNG Data URL purely in JS.
 * This works cross-browser and inside sandboxed iframes even if native BMP rendering is blocked.
 */
export function convertBmpToPng(base64Str: string): string | null {
  try {
    let rawString = base64Str;
    if (rawString.includes(';base64,')) {
      rawString = rawString.split(';base64,')[1];
    }
    rawString = rawString.replace(/\s/g, ''); // strip any whitespace

    // Decode base64 to binary string
    const binaryStr = window.atob(rawString);
    const len = binaryStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    // Validate BMP signature 'BM'
    if (bytes[0] !== 0x42 || bytes[1] !== 0x4D) {
      return null;
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const pixelOffset = view.getUint32(10, true);
    const dibHeaderSize = view.getUint32(14, true);
    const width = view.getInt32(18, true);
    const height = view.getInt32(22, true);
    const bpp = view.getUint16(26, true);
    
    // Support 24-bit (RGB), 32-bit (RGBA), and 8-bit (palette) BMPs
    if (bpp !== 24 && bpp !== 32 && bpp !== 8) {
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.abs(width);
    canvas.height = Math.abs(height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const imgData = ctx.createImageData(canvas.width, canvas.height);
    const data = imgData.data;

    const absWidth = Math.abs(width);
    const absHeight = Math.abs(height);
    const isBottomUp = height > 0;

    if (bpp === 24) {
      const rowSize = Math.floor((bpp * absWidth + 31) / 32) * 4;
      for (let y = 0; y < absHeight; y++) {
        const bmpY = isBottomUp ? (absHeight - 1 - y) : y;
        const rowOffset = pixelOffset + bmpY * rowSize;
        const destOffset = y * absWidth * 4;
        for (let x = 0; x < absWidth; x++) {
          const pxOffset = rowOffset + x * 3;
          if (pxOffset + 2 < bytes.length) {
            const b = bytes[pxOffset];
            const g = bytes[pxOffset + 1];
            const r = bytes[pxOffset + 2];
            const idx = destOffset + x * 4;
            data[idx] = r;
            data[idx + 1] = g;
            data[idx + 2] = b;
            data[idx + 3] = 255; // opaque
          }
        }
      }
    } else if (bpp === 32) {
      const rowSize = absWidth * 4;
      for (let y = 0; y < absHeight; y++) {
        const bmpY = isBottomUp ? (absHeight - 1 - y) : y;
        const rowOffset = pixelOffset + bmpY * rowSize;
        const destOffset = y * absWidth * 4;
        for (let x = 0; x < absWidth; x++) {
          const pxOffset = rowOffset + x * 4;
          if (pxOffset + 3 < bytes.length) {
            const b = bytes[pxOffset];
            const g = bytes[pxOffset + 1];
            const r = bytes[pxOffset + 2];
            const a = bytes[pxOffset + 3];
            const idx = destOffset + x * 4;
            data[idx] = r;
            data[idx + 1] = g;
            data[idx + 2] = b;
            data[idx + 3] = a;
          }
        }
      }
    } else if (bpp === 8) {
      const paletteOffset = 14 + dibHeaderSize;
      const rowSize = Math.floor((8 * absWidth + 31) / 32) * 4;
      for (let y = 0; y < absHeight; y++) {
        const bmpY = isBottomUp ? (absHeight - 1 - y) : y;
        const rowOffset = pixelOffset + bmpY * rowSize;
        const destOffset = y * absWidth * 4;
        for (let x = 0; x < absWidth; x++) {
          const pxOffset = rowOffset + x;
          if (pxOffset < bytes.length) {
            const paletteIndex = bytes[pxOffset];
            const entryOffset = paletteOffset + paletteIndex * 4;
            if (entryOffset + 2 < bytes.length) {
              const b = bytes[entryOffset];
              const g = bytes[entryOffset + 1];
              const r = bytes[entryOffset + 2];
              const idx = destOffset + x * 4;
              data[idx] = r;
              data[idx + 1] = g;
              data[idx + 2] = b;
              data[idx + 3] = 255;
            }
          }
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);
    return canvas.toDataURL('image/png');
  } catch (e) {
    console.error('Error parsing BMP base64:', e);
    return null;
  }
}

/**
 * Ensures any potential raw base64 or BMP base64 is processed and converted to highly compatible PNG base64.
 * If it's a URL, returns it unchanged.
 */
export function ensureCompatibleImage(logoUrl: string): string {
  if (!logoUrl) return '';
  const trimmed = logoUrl.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('/')) {
    return trimmed; // an address (external, or the app's own cached logo URL), not image data
  }

  // Check if it is BMP (starts with Qk) or contains a bmp mime type
  const isBmp = trimmed.startsWith('Qk') || trimmed.includes('image/bmp') || trimmed.includes('image/x-ms-bmp');
  
  if (isBmp) {
    const pngResult = convertBmpToPng(trimmed);
    if (pngResult) return pngResult;
  }

  // Ensure it has a correct data URL prefix if it looks like raw base64
  if (!trimmed.startsWith('data:')) {
    if (trimmed.startsWith('iVBORw0KGg')) {
      return 'data:image/png;base64,' + trimmed;
    } else if (trimmed.startsWith('/9j/')) {
      return 'data:image/jpeg;base64,' + trimmed;
    } else if (trimmed.startsWith('PHN2Z') || trimmed.startsWith('PD94b')) {
      return 'data:image/svg+xml;base64,' + trimmed;
    } else {
      return 'data:image/png;base64,' + trimmed;
    }
  }

  return trimmed;
}

/**
 * Shrinks an uploaded image (data URL) so it can be embedded in the company record without
 * bloating every /api/state response: the longest side is capped at maxDim (512px is far more
 * than a document header or the app bar ever draws) and it is re-encoded as PNG (keeps
 * transparency, prints reliably). Images that are already small are returned untouched. Never
 * returns something larger than its input, and falls back to the original if the browser cannot
 * decode/encode it. A 1 MB logo in production made every state load and post-save refresh ship
 * a megabyte of already-compressed bytes.
 */
export function downscaleImageDataUrl(dataUrl: string, maxDim = 512, keepIfSmallerThanChars = 120_000): Promise<string> {
  return new Promise((resolve) => {
    if (!dataUrl || !dataUrl.startsWith('data:image/')) return resolve(dataUrl);
    const img = new Image();
    img.onload = () => {
      try {
        const { naturalWidth: w, naturalHeight: h } = img;
        if (!w || !h) return resolve(dataUrl);
        if (Math.max(w, h) <= maxDim && dataUrl.length <= keepIfSmallerThanChars) return resolve(dataUrl);
        const scale = Math.min(1, maxDim / Math.max(w, h));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(dataUrl);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const out = canvas.toDataURL('image/png');
        resolve(out.length < dataUrl.length ? out : dataUrl);
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}
