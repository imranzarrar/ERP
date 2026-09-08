import { chromium, type Browser } from 'playwright';

// Real server-side PDF generation for the "Download PDF" button — replaces the previous
// client-side html2canvas+jsPDF rasterization (src/pdfExport.ts, retired), which produced
// a picture of the invoice rather than real text: no selectable/searchable text, wrong
// Arabic letter shaping (canvas-based text rendering isn't a real text engine), and huge
// file sizes from embedding a full-page raster image. This drives a real headless
// Chromium to navigate to this same server's own /print/invoice/:id route (see
// src/PrintInvoiceView.tsx, src/main.tsx) and calls Chromium's own print-to-PDF — the
// exact same rendering engine that already produces correct output for the Print button's
// window.print() popup, just invoked headlessly instead of needing a visible dialog.
//
// One browser process is launched lazily and reused across requests (a fresh Chromium
// launch per PDF would be far too slow and memory-heavy for the VPS this runs on) — only
// a fresh, isolated BrowserContext per request, closed immediately after.
let browserPromise: Promise<Browser> | null = null;
function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    // PLAYWRIGHT_CHROMIUM_PATH is a local-dev-only escape hatch — some Windows security
    // software silently blocks Playwright's own freshly-downloaded, unsigned Chromium
    // binary from ever spawning (fails with a generic "spawn UNKNOWN", no clearer
    // signal) while an already-installed, signed system browser launches fine. Normal
    // production deployment (a Linux VPS, per docs/deployment-plan.md) never needs this
    // — `npx playwright install --with-deps chromium` there uses Playwright's own
    // bundled binary exactly as intended; leave this unset on the server.
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
    browserPromise = chromium.launch({ headless: true, args: ['--no-sandbox'], executablePath });
  }
  return browserPromise;
}

// Same-origin, same-process call to this server's own Express app — never a real network
// hop to an external host. Port matches server.ts's own hardcoded PORT constant.
const SELF_ORIGIN = `http://127.0.0.1:${process.env.PORT || 3000}`;

export async function renderInvoicePdf(invoiceId: string, sessionId: string): Promise<Buffer> {
  const browser = await getBrowser();
  const context = await browser.newContext();
  try {
    // Authenticates exactly like the automated test suite does — the x-session-id /
    // sessionId documented non-cookie auth path (server.ts's isAuthenticated) — via the
    // same localStorage key main.tsx's own fetch interceptor already reads on every
    // request. No new auth mechanism, no token to mint/verify/expire.
    await context.addInitScript((sid) => {
      window.localStorage.setItem('erp_session_id', sid);
    }, sessionId);

    const page = await context.newPage();
    await page.goto(`${SELF_ORIGIN}/print/invoice/${invoiceId}`, { waitUntil: 'networkidle' });

    const errorEl = await page.$('[data-print-error="true"]');
    if (errorEl) {
      const text = await errorEl.textContent();
      throw new Error(text || 'Failed to render invoice for PDF export.');
    }

    await page.waitForSelector('[data-print-ready="true"]', { timeout: 10000 });
    // Same font-loading guarantee as DocumentRenderer.tsx's handlePrint() and the
    // previous client-side exportNodeToPdf() — race against a timeout so a font that
    // fails to load entirely doesn't hang the request forever.
    await Promise.race([
      page.evaluate(() => (document as any).fonts?.ready),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    // Best-effort: the ZATCA QR code renders asynchronously after mount (see
    // DocumentRenderer.tsx's own autoPrint QR-polling comment for why) — wait for it,
    // but don't fail the whole PDF if this specific document has no QR block at all.
    await page.waitForSelector('[data-qr-ready="true"]', { timeout: 2000 }).catch(() => {});

    // Explicit A4 + margin, not preferCSSPageSize — index.css's general @media print
    // block only sets @page { margin: 0.5cm }, never a `size`; A4 sizing has only ever
    // lived in DocumentRenderer.tsx's handlePrint() popup-specific injected <style>
    // block, which this route doesn't go through at all (this is a real page navigation,
    // not the popup). Without an explicit size here, Playwright silently defaults to US
    // Letter. Matches handlePrint()'s own A4 geometry (0.4in margins) exactly.
    const pdfBuffer = await page.pdf({
      printBackground: true,
      format: 'A4',
      margin: { top: '0.4in', bottom: '0.4in', left: '0.4in', right: '0.4in' },
    });
    return pdfBuffer;
  } finally {
    await context.close();
  }
}
