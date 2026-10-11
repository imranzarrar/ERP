import React from 'react';
import { createPortal } from 'react-dom';
import { Plus, X } from 'lucide-react';
import { DatabaseState } from '../dbStore';
import { useTranslation, usePermissions } from '../hooks';
import { generateId } from '../id';

export interface QuickAddProductContext {
  db: DatabaseState;
  // Optional: a form without it (Expense) picks the new product up via onRefreshDb.
  onUpdateDbLocal?: (updater: (prev: DatabaseState) => DatabaseState) => void;
  onRefreshDb?: () => Promise<void>;
  // Which side of the business the form is on. Limits the flow choice to "Both" or this
  // side, so the new product always appears in the picker it was created from.
  side: 'sales' | 'purchase';
  // Stock-moving pickers (Purchase Requisition / Purchase Order) list physical items only,
  // so a product created from them must be one — the item/service choice is hidden.
  itemOnly?: boolean;
}

interface QuickAddProductModalProps extends QuickAddProductContext {
  initialName: string;
  onClose: () => void;
  // The saved product row, shaped like a db.products entry, so the caller can select it
  // on the line item exactly as if it had been picked from the catalog.
  onCreated: (product: any) => void;
}

// Minimal "new product" form opened from a line item's catalog search (BACKLOG item 100).
// Deliberately NOT the full MasterEntities product form: only name, item/service, which
// pickers it appears in, unit and price — stock thresholds, categories, images, barcodes
// etc. are filled in later from the Product Catalog. Saves through the same
// POST /api/products route as the full form (same products.create check, same company
// scoping, server-generated SKU). The caller only renders this when the user's roles grant
// products.create.
export default function QuickAddProductModal({
  db, onUpdateDbLocal, onRefreshDb, side, itemOnly, initialName, onClose, onCreated,
}: QuickAddProductModalProps) {
  const { t, isRTL } = useTranslation(db);
  const pieceUnit = (db.unitsOfMeasure || []).find(u => u.code === 'PCE' && u.isActive !== false);
  const [name, setName] = React.useState(initialName);
  const [itemKind, setItemKind] = React.useState<'item' | 'service'>('item');
  const [flow, setFlow] = React.useState<0 | 1 | 2>(0);
  // Same default and same id-vs-pseudo-value handling as MasterEntities' product form.
  const [unitId, setUnitId] = React.useState(pieceUnit ? pieceUnit.id : '');
  const [unitCode, setUnitCode] = React.useState('PCE');
  const [price, setPrice] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [errors, setErrors] = React.useState<string[]>([]);

  const close = () => { if (!saving) onClose(); };

  const handleSave = async () => {
    const errs: string[] = [];
    if (!name.trim()) errs.push(t('Product name is required.'));
    const priceNum = parseFloat(price);
    if (price.trim() === '' || isNaN(priceNum) || priceNum < 0) errs.push(t('Price must be a valid positive number.'));
    setErrors(errs);
    if (errs.length > 0) return;

    const product = {
      id: generateId(),
      name: name.trim(),
      description: '',
      unitPrice: priceNum,
      costPrice: null,
      salesPurchaseFlow: flow,
      itemKind,
      unit: unitCode,
      unitOfMeasureId: unitId || null,
      isPosItem: false,
      companyId: db.selectedCompanyId,
    };

    setSaving(true);
    try {
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(product),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setErrors([errData.error || t('Could not save the product.')]);
        return;
      }
      const row: any = { ...product, isActive: true };
      onUpdateDbLocal?.(prev => ({ ...prev, products: [...(prev.products || []).filter(p => p.id !== row.id), row] }));
      onCreated(row);
      // Brings in the server-generated SKU.
      onRefreshDb?.().catch(() => {});
    } catch {
      setErrors([t('Could not save the product.')]);
    } finally {
      setSaving(false);
    }
  };

  const inputClass = 'w-full bg-white border border-slate-200 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none';
  const labelClass = 'text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-0.5';

  return createPortal(
    <div
      className="fixed inset-0 z-[100] bg-slate-900/40 flex items-center justify-center p-4"
      // Portaled into document.body, outside App.tsx's root dir wrapper — set it here.
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
          <h3 className="text-sm font-bold text-slate-800">{t('New Product')}</h3>
          <button type="button" onClick={close} aria-label={t('Close')} className="text-slate-400 hover:text-slate-700">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-3 text-xs">
          <div>
            <label className={labelClass}>{t('Product / Service Name')}<span className="text-rose-500"> *</span></label>
            <input autoFocus value={name} onChange={e => setName(e.target.value)} className={inputClass} />
          </div>

          {!itemOnly && (<div>
            <label className={labelClass}>{t('Product Classification')}</label>
            <div className="flex gap-2">
              {(['item', 'service'] as const).map(k => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setItemKind(k)}
                  className={`flex-1 px-2 py-1.5 rounded-lg text-[11px] font-bold border transition-all ${itemKind === k ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}`}
                >
                  {k === 'item' ? t('Physical Item (Stockable & Counted)') : t('Service Rate (Non-Stockable / Labor)')}
                </button>
              ))}
            </div>
          </div>)}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>{t('Unit Price')} ({db.companySetup?.currency || 'SAR'})<span className="text-rose-500"> *</span></label>
              <input type="number" step="0.01" min="0" value={price} onChange={e => setPrice(e.target.value)} placeholder="0.00" className={`${inputClass} text-end`} />
            </div>
            <div>
              <label className={labelClass}>{t('Unit of Measure')}</label>
              <select
                value={unitId || unitCode}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === 'No' || val === 'PCE') { setUnitId(''); setUnitCode(val); return; }
                  // Select a real unit row by its id, never by code (two named units can
                  // share one ZATCA code).
                  const picked = (db.unitsOfMeasure || []).find(u => u.id === val);
                  setUnitId(val);
                  setUnitCode(picked ? picked.code : 'PCE');
                }}
                className={inputClass}
              >
                <option value="No">{t('None / Default')}</option>
                <option value="PCE">{t('Piece')} (PCE)</option>
                {(db.unitsOfMeasure || []).filter(u => u.isActive !== false).map(u => (
                  <option key={u.id} value={u.id}>{u.name} ({u.code})</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className={labelClass}>{t('Transaction Flow Type')}</label>
            <select value={String(flow)} onChange={e => setFlow(Number(e.target.value) as 0 | 1 | 2)} className={inputClass}>
              <option value="0">{t('Sales & Purchase (Both)')}</option>
              {side === 'sales'
                ? <option value="1">{t('Sales Earning Flow (Invoicing / POS)')}</option>
                : <option value="2">{t('Purchase Supply Flow (Supplier procurement)')}</option>}
            </select>
          </div>

          <p className="text-[10px] text-slate-400">{t('Barcode, category, stock levels and images can be added later from the Product Catalog.')}</p>

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
  );
}

// "+" for a plain product <select> (Purchase Requisition / Purchase Order lines). Hidden
// unless the user's roles grant products.create.
export function QuickAddProductButton({ onCreated, ...ctx }: QuickAddProductContext & { onCreated: (product: any) => void }) {
  const { t } = useTranslation(ctx.db);
  const { can } = usePermissions(ctx.db.currentUser);
  const [open, setOpen] = React.useState(false);
  if (!can('products.create')) return null;
  const title = t('Add new product');
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={title}
        aria-label={title}
        className="shrink-0 inline-flex items-center justify-center w-9 rounded-lg bg-indigo-50 text-indigo-600 hover:bg-indigo-600 hover:text-white border border-indigo-200 transition-colors"
      >
        <Plus className="w-4 h-4" />
      </button>
      {open && (
        <QuickAddProductModal
          {...ctx}
          initialName=""
          onClose={() => setOpen(false)}
          onCreated={(product) => { setOpen(false); onCreated(product); }}
        />
      )}
    </>
  );
}
