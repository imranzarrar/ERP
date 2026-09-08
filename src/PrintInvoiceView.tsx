import React from 'react';
import DocumentRenderer from './components/DocumentRenderer';
import { buildFixedDownloadTemplate } from './documentTemplateDefaults';

// The ONLY thing rendered at /print/invoice/:id — no sidebar, no login screen, no app
// shell. This exists purely as a navigation target for server/lib/pdfGenerator.ts's
// headless Chromium: it authenticates via the same x-session-id mechanism the automated
// test suite already uses (see main.tsx's fetch interceptor, which reads
// localStorage.erp_session_id — the headless browser has that seeded via
// context.addInitScript before this page ever loads), fetches the same full-state blob
// every other screen in this app already fetches, and renders the invoice through the
// exact same DocumentRenderer component Print uses — so this is never a second,
// divergent rendering path, just a chrome-less host for the real one.
export default function PrintInvoiceView({ invoiceId }: { invoiceId: string }) {
  const [state, setState] = React.useState<any>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    fetch('/api/state')
      .then(async (r) => {
        if (!r.ok) throw new Error(`Failed to load (${r.status})`);
        return r.json();
      })
      .then(setState)
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <div data-print-error="true">{error}</div>;
  if (!state) return <div>Loading…</div>;

  const inv = (state.invoices || []).find((i: any) => i.id === invoiceId);
  if (!inv) return <div data-print-error="true">Invoice not found</div>;

  const customer = (state.customers || []).find((c: any) => c.id === inv.customerId);
  const bank = (state.banks || []).find((b: any) => b.id === inv.bankId);
  const company = (state.companies || []).find((c: any) => c.id === inv.companyId);

  return (
    <div data-print-ready="true">
      <DocumentRenderer
        embedded
        documentType="Invoice"
        data={{ ...inv, customerData: customer, bankData: bank }}
        companySetup={company as any}
        templates={[buildFixedDownloadTemplate(inv.companyId) as any]}
        taxSlabs={state.taxSlabs}
        db={state}
        onClose={() => {}}
      />
    </div>
  );
}
