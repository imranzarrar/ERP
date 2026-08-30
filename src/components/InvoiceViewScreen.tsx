import React from 'react';
import { useTranslation } from '../hooks';
import { DatabaseState, calculateInvoiceTotals } from '../dbStore';
import { normalizePermissions } from '../types';
import StatusPill, { StatusPillTone } from './StatusPill';
import DocumentRenderer from './DocumentRenderer';
import { exportNodeToPdf } from '../pdfExport';
import { ArrowLeft, Printer, Download, FileText, Ban, ShieldCheck, Code, Wallet, QrCode, RefreshCw, AlertTriangle } from 'lucide-react';
import QRCodeLib from 'qrcode';

interface InvoiceViewScreenProps {
  db: DatabaseState;
  invoiceId: string;
  onBack: () => void;
  onPrintDoc: (type: 'Invoice' | 'PaymentReceipt', data: any) => void;
  onRefreshDb?: () => Promise<void>;
}

// The View screen's actions reuse the exact same routes/guards InvoiceModule.tsx's list
// row already uses (Cancel, Credit Note, Record Payment) — this component is a new home
// for those actions, not new business logic. See the approved plan for why.
export default function InvoiceViewScreen({ db, invoiceId, onBack, onPrintDoc, onRefreshDb }: InvoiceViewScreenProps) {
  const { t } = useTranslation(db);
  const currentUser = db.currentUser;
  const isAdmin = currentUser?.role === 'admin' || currentUser?.isSuperAdmin === true;
  const userPermissions = normalizePermissions(currentUser?.permissions, currentUser?.role, currentUser?.isSuperAdmin);
  const [triggerError, setTriggerError] = React.useState<string | null>(null);
  const [triggerSuccessMsg, setTriggerSuccessMsg] = React.useState<string | null>(null);
  const [showXml, setShowXml] = React.useState(false);
  const [noteReason, setNoteReason] = React.useState('');
  const [showNoteForm, setShowNoteForm] = React.useState(false);
  const [showPayForm, setShowPayForm] = React.useState(false);
  const [payAmount, setPayAmount] = React.useState('');
  const [payDate, setPayDate] = React.useState('');
  const [payBankId, setPayBankId] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [zatcaSubmitting, setZatcaSubmitting] = React.useState(false);
  const pdfNodeRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!triggerError && !triggerSuccessMsg) return;
    const timer = setTimeout(() => { setTriggerError(null); setTriggerSuccessMsg(null); }, 4000);
    return () => clearTimeout(timer);
  }, [triggerError, triggerSuccessMsg]);

  const inv = db.invoices.find(i => i.id === invoiceId);
  const customer = inv ? db.customers.find(c => c.id === inv.customerId) : undefined;
  const bank = inv ? db.banks.find(b => b.id === inv.bankId) : undefined;
  // Every Receipt/Reversal voucher ever posted against this invoice, most recent first —
  // an invoice settled across several installments (e.g. cash now, two different banks
  // later) previously had no way to see or reprint any payment but the last one.
  const paymentHistory = inv
    ? db.vouchers
        .filter(v => v.referenceType === 'Invoice' && v.referenceId === inv.id)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    : [];

  // Generated locally, not fetched from a third-party image API — this card is visible
  // on-screen (not just in Print/PDF), so a network-dependent QR meant this whole card
  // silently showed no QR code at all with no internet access. Mirrors the same fix in
  // DocumentRenderer.tsx.
  const [localQrDataUri, setLocalQrDataUri] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!inv?.qrCodeContent) { setLocalQrDataUri(null); return; }
    let cancelled = false;
    QRCodeLib.toDataURL(inv.qrCodeContent, { margin: 1, width: 280 })
      .then((url) => { if (!cancelled) setLocalQrDataUri(url); })
      .catch(() => { if (!cancelled) setLocalQrDataUri(null); });
    return () => { cancelled = true; };
  }, [inv?.qrCodeContent]);

  if (!inv) {
    return (
      <div className="p-8 text-center text-slate-500">
        <p>{t('Invoice not found.')}</p>
        <button onClick={onBack} className="mt-3 text-indigo-600 font-bold text-sm">{t('Back to invoices')}</button>
      </div>
    );
  }

  const totals = calculateInvoiceTotals(db, inv.items, inv.taxSlabId, inv.discountPercentage);
  const existingCreditNote = db.invoices.find(i => i.originalInvoiceId === inv.id && i.documentType === 'CreditNote');
  const zatcaBlocksCancel = !!inv.zatcaStatus && ['SUBMITTING', 'CLEARED', 'REPORTED'].includes(inv.zatcaStatus);
  const canCancel = userPermissions.invoice.delete.enabled && inv.status === 'Active' && !zatcaBlocksCancel;
  const isCreditNote = inv.documentType === 'CreditNote';

  const zatcaTone: StatusPillTone =
    inv.zatcaStatus === 'CLEARED' ? 'good' :
    inv.zatcaStatus === 'REPORTED' ? 'info' :
    inv.zatcaStatus === 'SUBMITTING' || inv.zatcaStatus === 'PENDING' ? 'warn' :
    inv.zatcaStatus === 'REJECTED' || inv.zatcaStatus === 'ERROR' ? 'critical' : 'neutral';

  const refreshAndClose = async () => {
    if (onRefreshDb) await onRefreshDb();
  };

  const handleCancel = async () => {
    if (!canCancel || busy) return;
    if (!window.confirm(t('Cancel this invoice? This cannot be undone.'))) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/transactions/invoices/${inv.id}/cancel`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to cancel invoice.');
      await refreshAndClose();
      setTriggerSuccessMsg(t('Invoice cancelled.'));
    } catch (err: any) {
      setTriggerError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitNote = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/transactions/invoices/${inv.id}/note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'CreditNote', reason: noteReason }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to create credit note.');
      await refreshAndClose();
      setShowNoteForm(false);
      setNoteReason('');
      setTriggerSuccessMsg(t('Credit note issued.'));
    } catch (err: any) {
      setTriggerError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const totalAmt = totals.grandTotal;
  const paidAmt = inv.amountPaid || 0;
  const remainingAmt = Number((totalAmt - paidAmt).toFixed(2));

  const handleSubmitPayment = async () => {
    if (busy) return;
    const amt = parseFloat(payAmount);
    if (isNaN(amt) || amt <= 0) return setTriggerError(t('Please enter a valid payment amount greater than zero.'));
    if (!payDate) return setTriggerError(t('Please select a payment date.'));
    if (!payBankId) return setTriggerError(t('Please select a receiving bank.'));
    setBusy(true);
    try {
      const res = await fetch(`/api/transactions/invoices/${inv.id}/paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentDate: payDate, bankId: payBankId, amount: amt }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || 'Failed to record payment.');
      await refreshAndClose();
      setShowPayForm(false);
      setPayAmount('');
      setTriggerSuccessMsg(t('Payment recorded.'));
      // Auto-open the printable receipt right away — the customer paying needs proof of
      // payment on the spot, same UX as a new invoice's own print/preview popping up.
      if (data.voucher) {
        const voucherBank = db.banks.find(b => b.id === data.voucher.bankId);
        onPrintDoc('PaymentReceipt', { ...data.voucher, bankData: voucherBank });
      }
    } catch (err: any) {
      setTriggerError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleManualZatcaSubmit = async () => {
    if (zatcaSubmitting) return;
    setZatcaSubmitting(true);
    try {
      const res = await fetch(`/api/zatca/submit-invoice/${inv.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || 'Failed to submit to ZATCA');
      await refreshAndClose();
      setTriggerSuccessMsg(`ZATCA Submission Status: ${data.status || 'Success'}`);
    } catch (err: any) {
      setTriggerError(err.message || 'Error submitting to ZATCA');
    } finally {
      setZatcaSubmitting(false);
    }
  };

  const handleDownloadXml = () => {
    if (!inv.xmlContent) return;
    const blob = new Blob([inv.xmlContent], { type: 'text/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ZATCA-UBL-${inv.invoiceNumber}.xml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadPdf = async () => {
    if (!pdfNodeRef.current || busy) return;
    setBusy(true);
    try {
      await exportNodeToPdf(pdfNodeRef.current, inv.invoiceNumber);
    } catch (err: any) {
      console.error('PDF export failed:', err);
      setTriggerError(t('Failed to generate PDF.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-4">
      {triggerError && <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-sm font-semibold">{triggerError}</div>}
      {triggerSuccessMsg && <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm font-semibold">{triggerSuccessMsg}</div>}

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <button onClick={onBack} aria-label={t('Back to invoices')} className="w-9 h-9 rounded-xl border border-slate-200 flex items-center justify-center hover:bg-slate-50">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <p className="text-xs text-slate-400 font-semibold">{isCreditNote ? t('Credit Note') : t('Sales invoice')}</p>
            <h1 className="text-xl font-extrabold text-slate-900">{inv.invoiceNumber}</h1>
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => onPrintDoc('Invoice', { ...inv, customerData: customer, bankData: bank })} className="px-3 py-2 rounded-xl border border-slate-200 text-sm font-bold text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5">
            <Printer className="w-4 h-4" />{t('Print')}
          </button>
          <button onClick={handleDownloadPdf} disabled={busy} className="px-3 py-2 rounded-xl border border-slate-200 text-sm font-bold text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5 disabled:opacity-50">
            <Download className="w-4 h-4" />{t('Download PDF')}
          </button>
          {!isCreditNote && !existingCreditNote && (
            <button onClick={() => setShowNoteForm(true)} className="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold inline-flex items-center gap-1.5">
              <FileText className="w-4 h-4" />{t('Issue credit note')}
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-2xl p-5">
          <div className="flex justify-between mb-4">
            <div>
              <p className="text-xs text-slate-400 font-semibold">{t('Billed to')}</p>
              <p className="font-bold text-slate-900">{customer?.name || t('Walk-in')}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-slate-400 font-semibold">{t('Issue date')}</p>
              <p className="font-semibold text-slate-700">{inv.date}</p>
            </div>
          </div>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-slate-100 text-slate-400 text-xs">
                <th className="text-left font-semibold py-2">{t('Item')}</th>
                <th className="text-right font-semibold py-2">{t('Qty')}</th>
                <th className="text-right font-semibold py-2">{t('Rate')}</th>
                <th className="text-right font-semibold py-2">{t('Amount')}</th>
              </tr>
            </thead>
            <tbody>
              {inv.items.map(item => (
                <tr key={item.id} className="border-b border-slate-50">
                  <td className="py-2">{item.description}</td>
                  <td className="text-right py-2">{item.quantity}</td>
                  <td className="text-right py-2">{Number(item.unitCost).toFixed(2)}</td>
                  <td className="text-right py-2">{(Number(item.unitCost) * Number(item.quantity)).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex flex-col items-end gap-1 mt-3 pt-3 border-t border-slate-100 text-sm">
            <div className="flex justify-between w-44"><span className="text-slate-400">{t('Subtotal')}</span><span>{totals.discountedSubtotal.toFixed(2)}</span></div>
            <div className="flex justify-between w-44"><span className="text-slate-400">{t('VAT')}</span><span>{totals.taxAmount.toFixed(2)}</span></div>
            <div className="flex justify-between w-44 font-extrabold text-base pt-1"><span>{t('Total')}</span><span>{totals.grandTotal.toFixed(2)}</span></div>
          </div>
        </div>

        <div className="space-y-3">
          <div className="bg-white border border-slate-200 rounded-2xl p-4">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">{t('ZATCA status')}</p>
            <div className="flex items-center gap-2 mb-2">
              <StatusPill tone={zatcaTone}>{t(inv.zatcaStatus || 'NOT_SUBMITTED')}</StatusPill>
              {inv.icv ? <span className="text-[11px] text-slate-400">ICV {inv.icv}</span> : null}
            </div>
            {inv.clearanceTimestamp && (
              <p className="text-xs text-slate-500 mb-2">{t('Cleared at')}: {new Date(inv.clearanceTimestamp).toLocaleString()}</p>
            )}
            {inv.zatcaStatus === 'DISABLED' && (
              <p className="text-[11px] text-slate-500 mb-2">
                {t('ZATCA integration is not enabled for this company yet. Ask a Super Admin to enable it in Admin Settings, or complete Sandbox onboarding to enable it automatically.')}
              </p>
            )}

            {(inv.zatcaStatus === 'ERROR' || inv.zatcaStatus === 'REJECTED' || !inv.zatcaStatus || inv.zatcaStatus === 'NOT_SUBMITTED') && inv.zatcaStatus !== 'DISABLED' && (userPermissions.invoice.create.enabled || userPermissions.invoice.update.enabled) && (
              <button
                onClick={handleManualZatcaSubmit}
                disabled={zatcaSubmitting}
                className="w-full mb-2 text-xs font-bold bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg py-1.5 inline-flex items-center justify-center gap-1.5"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${zatcaSubmitting ? 'animate-spin' : ''}`} />
                {zatcaSubmitting ? t('Submitting to ZATCA...') : t('Submit / Re-submit to ZATCA')}
              </button>
            )}

            {(inv.uuid || inv.currentInvoiceHash) && (
              <div className="mb-2 p-2.5 rounded-lg bg-slate-50 border border-slate-100 space-y-1.5 font-mono text-[10px] break-all">
                <div>
                  <span className="text-slate-400 font-sans text-[9px] uppercase font-bold block">{t('Invoice UUID:')}</span>
                  <span className="text-slate-700">{inv.uuid || 'N/A'}</span>
                </div>
                <div>
                  <span className="text-slate-400 font-sans text-[9px] uppercase font-bold block">{t('Current Invoice Hash (SHA-256):')}</span>
                  <span className="text-slate-700">{inv.currentInvoiceHash || 'N/A'}</span>
                </div>
                <div>
                  <span className="text-slate-400 font-sans text-[9px] uppercase font-bold block">{t('Previous Invoice Hash (PIH):')}</span>
                  <span className="text-slate-700">{inv.previousInvoiceHash || 'N/A'}</span>
                </div>
              </div>
            )}

            {inv.qrCodeContent && (
              <div className="flex flex-col items-center justify-center p-2.5 mb-2 bg-slate-50 rounded-lg border border-slate-100">
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 flex items-center gap-1"><QrCode className="w-3 h-3" />{t('ZATCA Phase 2 QR Code')}</p>
                {localQrDataUri ? (
                  <img
                    src={localQrDataUri}
                    alt="ZATCA Phase 2 QR Code"
                    className="w-28 h-28 rounded border border-slate-200 bg-white p-1"
                  />
                ) : (
                  <div className="w-28 h-28 rounded bg-slate-100" />
                )}
              </div>
            )}

            {inv.zatcaValidationResults && (inv.zatcaValidationResults as any[]).length > 0 && (
              <div className="mb-2 p-2.5 rounded-lg bg-amber-50 border border-amber-200 space-y-1">
                <div className="font-bold text-amber-900 flex items-center gap-1 text-[11px]">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                  {t('ZATCA Gateway Validation Diagnostics')}
                </div>
                <ul className="list-disc list-inside space-y-0.5 text-amber-800 text-[10px] font-mono">
                  {(inv.zatcaValidationResults as any[]).map((res: any, idx: number) => (
                    <li key={idx}>[{res.type || res.code || 'INFO'}]: {res.message || JSON.stringify(res)}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex gap-1.5">
              <button onClick={() => setShowXml(true)} disabled={!inv.xmlContent} className="flex-1 text-xs font-bold border border-slate-200 rounded-lg py-1.5 hover:bg-slate-50 inline-flex items-center justify-center gap-1.5 disabled:opacity-40">
                <Code className="w-3.5 h-3.5" />{t('View signed XML')}
              </button>
              <button onClick={handleDownloadXml} disabled={!inv.xmlContent} title={t('Download XML File')} className="text-xs font-bold border border-slate-200 rounded-lg py-1.5 px-2 hover:bg-slate-50 inline-flex items-center justify-center disabled:opacity-40">
                <Download className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {!isCreditNote && (
            <div className="bg-white border border-slate-200 rounded-2xl p-4">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">{t('Payment')}</p>
              <StatusPill tone={inv.paymentStatus === 'Paid' ? 'good' : inv.paymentStatus === 'Partially Paid' ? 'info' : 'warn'}>{t(inv.paymentStatus)}</StatusPill>
              {inv.paymentStatus !== 'Paid' && (
                <button onClick={() => {
                  setPayAmount(remainingAmt.toString());
                  setPayDate(new Date().toISOString().split('T')[0]);
                  setPayBankId(inv.bankId || db.banks.find(b => b.isDefault)?.id || '');
                  setShowPayForm(true);
                }} className="w-full mt-2 text-xs font-bold border border-slate-200 rounded-lg py-1.5 hover:bg-slate-50 inline-flex items-center justify-center gap-1.5">
                  <Wallet className="w-3.5 h-3.5" />{t('Record payment')}
                </button>
              )}
              {paymentHistory.length > 0 && (
                <div className="mt-3 pt-3 border-t border-slate-100 space-y-1.5">
                  <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">{t('Payment History')}</p>
                  {paymentHistory.map(v => {
                    const vBank = db.banks.find(b => b.id === v.bankId);
                    const isRefund = v.type === 'Reversal';
                    return (
                      <div key={v.id} className="flex items-center justify-between text-[11px] py-1">
                        <div className="min-w-0">
                          <p className="font-semibold text-slate-700 truncate">{v.date} — {vBank?.bankName || t('Bank Account')}</p>
                          <p className="text-slate-400 font-mono">{v.voucherNumber}</p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className={`font-bold ${isRefund ? 'text-rose-600' : 'text-emerald-600'}`}>
                            {isRefund ? '-' : ''}{Number(v.amount).toFixed(2)}
                          </span>
                          <button
                            type="button"
                            onClick={() => onPrintDoc('PaymentReceipt', { ...v, bankData: vBank })}
                            title={t('Print receipt')}
                            className="p-1 rounded-lg text-slate-400 hover:text-indigo-600 hover:bg-indigo-50"
                          >
                            <Printer className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {!isCreditNote && (
            <button onClick={handleCancel} disabled={!canCancel || busy} title={!canCancel ? t('This invoice has already been submitted to ZATCA and cannot be cancelled. Issue a Credit Note instead.') : ''} className="w-full text-sm font-bold text-rose-600 border border-rose-200 rounded-xl py-2 hover:bg-rose-50 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5">
              <Ban className="w-4 h-4" />{t('Cancel invoice')}
            </button>
          )}
        </div>
      </div>

      {showXml && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowXml(false)}>
          <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[80vh] overflow-auto p-5" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-3">
              <p className="font-bold text-slate-900 inline-flex items-center gap-1.5"><ShieldCheck className="w-4 h-4 text-indigo-600" />{t('Signed XML')}</p>
              <button onClick={() => setShowXml(false)} className="text-slate-400 hover:text-slate-700 text-sm font-bold">{t('Close')}</button>
            </div>
            <pre className="text-[11px] bg-slate-50 rounded-xl p-3 overflow-auto whitespace-pre-wrap">{inv.xmlContent}</pre>
          </div>
        </div>
      )}

      {showNoteForm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowNoteForm(false)}>
          <div className="bg-white rounded-2xl max-w-sm w-full p-5" onClick={e => e.stopPropagation()}>
            <p className="font-bold text-slate-900 mb-3">{t('Issue credit note')}</p>
            <textarea value={noteReason} onChange={e => setNoteReason(e.target.value)} placeholder={t('Reason (optional)')} className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm mb-3" rows={3} />
            <div className="flex gap-2">
              <button onClick={() => setShowNoteForm(false)} className="flex-1 py-2 rounded-xl border border-slate-200 text-sm font-bold">{t('Cancel')}</button>
              <button onClick={handleSubmitNote} disabled={busy} className="flex-1 py-2 rounded-xl bg-indigo-600 text-white text-sm font-bold disabled:opacity-50">{t('Issue')}</button>
            </div>
          </div>
        </div>
      )}

      {showPayForm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowPayForm(false)}>
          <div className="bg-white rounded-2xl max-w-sm w-full p-5" onClick={e => e.stopPropagation()}>
            <p className="font-bold text-slate-900 mb-3">{t('Record payment')}</p>
            <div className="space-y-1 mb-3">
              <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Payment Date')}</label>
              <input type="date" value={payDate} onChange={e => setPayDate(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm" />
            </div>
            <div className="space-y-1 mb-3">
              <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Receiving Bank')}</label>
              {isAdmin ? (
                <select value={payBankId} onChange={e => setPayBankId(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm">
                  {db.banks.filter(b => b.isActive).map(b => (
                    <option key={b.id} value={b.id}>{b.bankName}</option>
                  ))}
                </select>
              ) : (
                <div className="w-full bg-slate-100 border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-500 font-semibold">
                  {db.banks.find(b => b.id === payBankId)?.bankName || t('Default Bank')}
                </div>
              )}
            </div>
            <div className="space-y-1 mb-3">
              <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Amount')}</label>
              <input type="number" value={payAmount} onChange={e => setPayAmount(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm" />
            </div>
            <div className="flex gap-2">
              <button onClick={() => setShowPayForm(false)} className="flex-1 py-2 rounded-xl border border-slate-200 text-sm font-bold">{t('Cancel')}</button>
              <button onClick={handleSubmitPayment} disabled={busy} className="flex-1 py-2 rounded-xl bg-indigo-600 text-white text-sm font-bold disabled:opacity-50">{t('Save')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Off-screen, always-mounted real renderer — exactly what Print produces — used only
          as the source node for Download PDF's html2canvas rasterization. Never visible. */}
      <div style={{ position: 'absolute', left: '-9999px', top: 0, width: '800px' }} aria-hidden="true">
        <div ref={pdfNodeRef}>
          <DocumentRenderer
            embedded
            documentType="Invoice"
            data={{ ...inv, customerData: customer, bankData: bank }}
            companySetup={db.companySetup as any}
            templates={db.templates}
            taxSlabs={db.taxSlabs}
            db={db}
            onClose={() => {}}
          />
        </div>
      </div>
    </div>
  );
}
