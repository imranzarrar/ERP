import React from 'react';
import { createPortal } from 'react-dom';
import { Plus, X } from 'lucide-react';
import { DatabaseState } from '../dbStore';
import { useTranslation, usePermissions } from '../hooks';
import { generateId } from '../id';

interface QuickAddPartyButtonProps {
  kind: 'customer' | 'vendor';
  db: DatabaseState;
  onUpdateDbLocal: (updater: (prev: DatabaseState) => DatabaseState) => void;
  // Called with the new row's id once the server has saved it, so the form that opened
  // this can select it in the field that triggered the quick-add.
  onCreated: (id: string) => void;
  onRefreshDb?: () => Promise<void>;
  onError: (msg: string) => void;
  onSuccess?: (msg: string) => void;
}

// "+" next to a customer/vendor picker on a transactional form (BACKLOG item 100): a
// minimal create form so the user doesn't have to abandon the document in progress.
// Deliberately NOT the full MasterEntities form — only what ZATCA and the server require
// (name; for B2B the VAT number and national address), everything else is filled in later
// from the master screen. Saves through the same POST /api/customers|vendors route as the
// full form, so the same validation, company scoping and permission check apply. The
// button itself is hidden unless the user's roles grant customers.create / vendors.create.
export default function QuickAddPartyButton({
  kind, db, onUpdateDbLocal, onCreated, onRefreshDb, onError, onSuccess,
}: QuickAddPartyButtonProps) {
  const { t, isRTL } = useTranslation(db);
  const { can } = usePermissions(db.currentUser);
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [name, setName] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [buyerType, setBuyerType] = React.useState<'B2B' | 'B2C'>('B2C');
  const [vatNumber, setVatNumber] = React.useState('');
  const [streetName, setStreetName] = React.useState('');
  const [buildingNumber, setBuildingNumber] = React.useState('');
  const [district, setDistrict] = React.useState('');
  const [city, setCity] = React.useState('');
  const [postalCode, setPostalCode] = React.useState('');
  const [errors, setErrors] = React.useState<string[]>([]);

  if (!can(kind === 'customer' ? 'customers.create' : 'vendors.create')) return null;

  const reset = () => {
    setName(''); setPhone(''); setEmail(''); setBuyerType('B2C'); setVatNumber('');
    setStreetName(''); setBuildingNumber(''); setDistrict(''); setCity(''); setPostalCode('');
    setErrors([]);
  };

  const close = () => { if (!saving) { setOpen(false); reset(); } };

  // Mirrors server/lib/zatca/validators.ts's validateBuyerFields (the server re-checks).
  const validate = (): string[] => {
    const errs: string[] = [];
    if (!name.trim()) errs.push(t('Name is required.'));
    if (buyerType === 'B2B') {
      if (!/^3\d{13}3$/.test(vatNumber.trim())) errs.push(t('VAT number must be 15 digits, starting and ending with 3.'));
      if (!streetName.trim() || !buildingNumber.trim() || !district.trim() || !city.trim()) errs.push(t('Fill in every required address field.'));
      if (!/^\d{5}$/.test(postalCode.trim())) errs.push(t('Postal code must be exactly 5 digits.'));
    }
    return errs;
  };

  const handleSave = async () => {
    const errs = validate();
    setErrors(errs);
    if (errs.length > 0) return;

    const isB2B = buyerType === 'B2B';
    const id = generateId();
    const payload = {
      id,
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim(),
      address: '',
      buyerType,
      vatNumber: vatNumber.trim() || null,
      streetName: isB2B ? streetName.trim() : null,
      buildingNumber: isB2B ? buildingNumber.trim() : null,
      district: isB2B ? district.trim() : null,
      city: isB2B ? city.trim() : null,
      postalCode: isB2B ? postalCode.trim() : null,
      isSystem: false,
      companyId: db.selectedCompanyId,
    };

    setSaving(true);
    try {
      const res = await fetch(kind === 'customer' ? '/api/customers' : '/api/vendors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const msg = errData.error || t(kind === 'customer' ? 'Could not save the customer.' : 'Could not save the vendor.');
        setErrors([msg]);
        onError(msg);
        return;
      }
      // Visible in every picker immediately and selectable now; the refresh below then
      // brings in the server-generated customer/vendor code.
      const row: any = { ...payload, isActive: true };
      onUpdateDbLocal(prev => kind === 'customer'
        ? { ...prev, customers: [...prev.customers.filter(c => c.id !== id), row] }
        : { ...prev, vendors: [...prev.vendors.filter(v => v.id !== id), row] });
      onCreated(id);
      onSuccess?.(t(kind === 'customer' ? 'Customer added and selected.' : 'Vendor added and selected.'));
      setOpen(false);
      reset();
      onRefreshDb?.().catch(() => {});
    } catch {
      const msg = t(kind === 'customer' ? 'Could not save the customer.' : 'Could not save the vendor.');
      setErrors([msg]);
      onError(msg);
    } finally {
      setSaving(false);
    }
  };

  const inputClass = 'w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none';
  const labelClass = 'text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-0.5';
  const title = t(kind === 'customer' ? 'Add new customer' : 'Add new vendor');

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={title}
        aria-label={title}
        className="inline-flex items-center justify-center w-4 h-4 rounded bg-indigo-50 text-indigo-600 hover:bg-indigo-600 hover:text-white border border-indigo-200 transition-colors align-middle ms-1"
      >
        <Plus className="w-3 h-3" />
      </button>
      {open && createPortal(
        <div
          className="fixed inset-0 z-[100] bg-slate-900/40 flex items-center justify-center p-4"
          // Portaled into document.body (escapes transformed ancestors that break
          // position:fixed), which also escapes App.tsx's root dir wrapper — so set it here.
          dir={isRTL ? 'rtl' : 'ltr'}
          onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto"
            onKeyDown={(e) => {
              if (e.key === 'Escape') close();
              // Enter saves this dialog only — never submits the document form behind it.
              if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); handleSave(); }
            }}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
              <h3 className="text-sm font-bold text-slate-800">{t(kind === 'customer' ? 'New Customer' : 'New Vendor')}</h3>
              <button type="button" onClick={close} aria-label={t('Close')} className="text-slate-400 hover:text-slate-700">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-3 text-xs">
              <div>
                <label className={labelClass}>{t('Entity Name')}<span className="text-rose-500"> *</span></label>
                <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder={t('e.g. Acme Trading LLC')} className={inputClass} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>{t('Contact Phone')}</label>
                  <input value={phone} onChange={e => setPhone(e.target.value)} placeholder={t('Optional')} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>{t('Email Address')}</label>
                  <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder={t('Optional')} className={inputClass} />
                </div>
              </div>

              <div>
                <label className={labelClass}>{t('ZATCA Invoice Type')}</label>
                <div className="flex gap-2">
                  {(['B2C', 'B2B'] as const).map(bt => (
                    <button
                      key={bt}
                      type="button"
                      onClick={() => setBuyerType(bt)}
                      className={`flex-1 px-2 py-1.5 rounded-lg text-[11px] font-bold border transition-all ${buyerType === bt ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}`}
                    >
                      {bt === 'B2B' ? t('B2B — Standard Invoice') : t('B2C — Simplified Invoice')}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-slate-400 mt-1">
                  {buyerType === 'B2C'
                    ? t('Simplified (B2C): only the name above is required for ZATCA.')
                    : t('Standard (B2B): ZATCA requires a full, verifiable buyer identity below.')}
                </p>
              </div>

              <div>
                <label className={labelClass}>{t('VAT Number')}{buyerType === 'B2B' ? <span className="text-rose-500"> *</span> : null}</label>
                <input value={vatNumber} onChange={e => setVatNumber(e.target.value)} placeholder={buyerType === 'B2B' ? '3xxxxxxxxxxxxx3' : t('Optional')} className={`${inputClass} font-mono`} />
              </div>

              {buyerType === 'B2B' && (
                <div className="grid grid-cols-2 gap-3 bg-slate-50 p-3 rounded-xl border border-slate-200/60">
                  <div>
                    <label className={labelClass}>{t('Street Name*')}</label>
                    <input value={streetName} onChange={e => setStreetName(e.target.value)} className={inputClass} />
                  </div>
                  <div>
                    <label className={labelClass}>{t('Building Number*')}</label>
                    <input value={buildingNumber} onChange={e => setBuildingNumber(e.target.value)} className={inputClass} />
                  </div>
                  <div>
                    <label className={labelClass}>{t('District*')}</label>
                    <input value={district} onChange={e => setDistrict(e.target.value)} className={inputClass} />
                  </div>
                  <div>
                    <label className={labelClass}>{t('City*')}</label>
                    <input value={city} onChange={e => setCity(e.target.value)} className={inputClass} />
                  </div>
                  <div className="col-span-2">
                    <label className={labelClass}>{t('Postal Code (5 digits)*')}</label>
                    <input value={postalCode} onChange={e => setPostalCode(e.target.value)} inputMode="numeric" className={`${inputClass} font-mono`} />
                  </div>
                </div>
              )}

              {errors.length > 0 && (
                <ul className="bg-rose-50 border border-rose-200 text-rose-700 rounded-lg px-3 py-2 space-y-0.5 text-[11px]">
                  {errors.map((er, i) => <li key={i}>{er}</li>)}
                </ul>
              )}
            </div>

            <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-100 bg-slate-50/60 rounded-b-2xl">
              <button type="button" onClick={close} disabled={saving} className="px-3 py-1.5 rounded-lg text-xs font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-50">
                {t('Cancel')}
              </button>
              <button type="button" onClick={handleSave} disabled={saving} className="px-4 py-1.5 rounded-lg text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50">
                {saving ? t('Saving...') : t('Save & Select')}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
