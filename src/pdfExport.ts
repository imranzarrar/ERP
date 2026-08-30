import jsPDF from 'jspdf';
// html2canvas-pro, not html2canvas: Tailwind v4's default palette emits oklch() colors,
// which the unmaintained-for-this-case html2canvas 1.4.1 can't parse — it throws
// "Attempting to parse an unsupported color function 'oklch'" on the very first
// oklch-colored element it walks, aborting the whole capture. html2canvas-pro is the
// actively maintained, API-compatible fork built specifically to parse oklch/oklab/
// color-mix — a drop-in replacement, no other code here changes.
import html2canvas from 'html2canvas-pro';

// Renders an already-mounted DOM node (the same invoice content DocumentRenderer builds
// in `embedded` mode — no modal chrome) into a real, downloadable PDF file. Deliberately
// client-side (html2canvas rasterizes the node, jsPDF wraps the raster into a PDF page) —
// no server-side rendering, no new deployment footprint, distinct from the browser's own
// print-to-PDF dialog (Print stays a separate action; this is a genuine one-click download).
export async function exportNodeToPdf(node: HTMLElement, filename: string): Promise<void> {
  const canvas = await html2canvas(node, {
    scale: 2, // sharper output than the DOM's own pixel density
    useCORS: true,
    backgroundColor: '#ffffff',
  });

  const imgData = canvas.toDataURL('image/png');

  // A4 in points (jsPDF default unit), scaled to fit the canvas's own aspect ratio so the
  // invoice isn't stretched or cropped regardless of how many line items it has.
  const pageWidth = 595.28;
  const pageHeight = (canvas.height * pageWidth) / canvas.width;

  const pdf = new jsPDF({
    orientation: pageHeight > pageWidth ? 'portrait' : 'landscape',
    unit: 'pt',
    format: [pageWidth, pageHeight],
  });

  pdf.addImage(imgData, 'PNG', 0, 0, pageWidth, pageHeight);
  pdf.save(filename.endsWith('.pdf') ? filename : `${filename}.pdf`);
}
