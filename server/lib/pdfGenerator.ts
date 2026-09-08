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
    // Force print media BEFORE the page ever loads/mounts — otherwise the page renders
    // once in normal screen context (any JS that measures its own width, e.g. a
    // ResizeObserver-driven table column, bakes in a screen-context value) and only
    // switches to print CSS at the moment page.pdf() is called, by which point some
    // sizing may already be stale. Confirmed live: content overflowed the right edge of
    // the page and got clipped on the left without this — a real horizontal-offset bug,
    // not just a missing margin.
    await page.emulateMedia({ media: 'print' });
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

    // A real bug found live: passing page.pdf()'s own `margin` option (0.4in) while this
    // page's actual CSS still declares index.css's general @page { margin: 0.5cm } means
    // Chromium LAYS OUT the content assuming one margin (0.5cm — the CSS the page
    // actually has) but then PLACES that already-laid-out content into a page reserving a
    // different, larger margin (the API's 0.4in) — content sized for the wider area
    // doesn't fit the narrower one, so it overflowed the right edge and was clipped on
    // the left. handlePrint()'s popup avoids this entirely by injecting its own matching
    // @page rule so layout-time and placement-time margins are always the same value;
    // this route never did that. Fixed the same way: inject the exact A4 @page rule
    // BEFORE asking for the PDF, then let preferCSSPageSize read that same value back —
    // one single source of truth for the geometry, never two numbers that can disagree.
    await page.addStyleTag({ content: '@page { size: A4 portrait; margin: 0.4in; }' });
    const pdfBuffer = await page.pdf({ printBackground: true, preferCSSPageSize: true });
    return pdfBuffer;
  } finally {
    await context.close();
  }
}
