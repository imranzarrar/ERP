import React from 'react';
import { useTranslation, usePermissions } from '../../hooks';
import type { DatabaseState } from '../../dbStore';
import { ledgerApi, inputCls, labelCls } from './ui';
import { useDimensionOptions, typeName, entityLabel, treeOrder, type DimTags } from './dimensions';

// "Posting profile" section of the Customer, Vendor and Bank forms: which control account the party's receivable / payable lines post to, and the
// dimension tags every ledger line of its documents starts from. Shown only to someone who may change accounting setup (Account Mapping). The parent
// keeps the value; `null` means "not loaded or not touched", and the parent then leaves these fields out of the save.
export interface ProfileValue { controlAccountId: string; dimensions: DimTags }
export const emptyProfile = (): ProfileValue => ({ controlAccountId: '', dimensions: {} });

export default function PostingProfileFields({ db, kind, entityId, value, onChange }: { db: DatabaseState; kind: 'customer' | 'vendor' | 'bank'; entityId: string | null; value: ProfileValue | null; onChange: (v: ProfileValue | null) => void }) {
  const { t, lang } = useTranslation(db);
  const { can } = usePermissions(db.currentUser);
  const allowed = can('accountMapping.update');
  const { options } = useDimensionOptions();
  const [accounts, setAccounts] = React.useState<{ id: string; code: string; name: string; nameAr: string | null }[]>([]);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    if (!allowed) { onChange(null); return; }
    let live = true;
    if (kind !== 'bank') ledgerApi<any>(`/control-accounts?kind=${kind}`).then(r => { if (live) setAccounts(r.accounts); }).catch(e => live && setError(e.message));
    if (entityId) ledgerApi<any>(`/party-profile?kind=${kind}&id=${entityId}`).then(r => { if (live) onChange({ controlAccountId: r.controlAccountId || '', dimensions: r.dimensions || {} }); }).catch(() => live && onChange(emptyProfile()));
    else onChange(emptyProfile());
    return () => { live = false; };
  }, [allowed, kind, entityId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!allowed || !value) return null;
  const setDim = (typeId: string, entityId2: string) => { const n = { ...value.dimensions }; if (entityId2) n[typeId] = entityId2; else delete n[typeId]; onChange({ ...value, dimensions: n }); };
  const types = (options?.types || []).filter(ty => ty.entities.length > 0);
  return (
    <div className="col-span-2 rounded-xl border border-indigo-100 bg-indigo-50/40 p-3 space-y-3">
      <div>
        <div className="text-[11px] font-black text-indigo-800 uppercase tracking-wider">{t('Posting profile')}</div>
        <p className="text-[11px] text-slate-500">{kind === 'bank' ? t('Every ledger line on this bank account starts from these dimension tags.') : t('Documents for this party post to the account below and start from these dimension tags. Leave empty to use the company default.')}</p>
      </div>
      {error && <div className="text-[11px] font-bold text-rose-600">{error}</div>}
      {kind !== 'bank' && (
        <div>
          <label className={labelCls}>{kind === 'customer' ? t('Receivable account') : t('Payable account')}</label>
          <select className={inputCls} value={value.controlAccountId} onChange={e => onChange({ ...value, controlAccountId: e.target.value })}>
            <option value="">{t('Company default')}</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.code} · {lang === 'ar' && a.nameAr ? a.nameAr : a.name}</option>)}
          </select>
          {accounts.length === 0 && <p className="text-[11px] text-slate-400 mt-1">{t('No other control accounts yet. Mark an account as a customer or vendor control account in the Chart of Accounts.')}</p>}
        </div>
      )}
      {types.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {types.map(ty => (
            <div key={ty.id}>
              <label className={labelCls}>{typeName(ty, lang)}</label>
              <select className={inputCls} value={value.dimensions[ty.id] || ''} onChange={e => setDim(ty.id, e.target.value)}>
                <option value="">—</option>
                {treeOrder(ty.entities).map(({ e, depth }) => <option key={e.id} value={e.id}>{'  '.repeat(depth)}{entityLabel(e, lang)}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
