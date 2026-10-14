import React from 'react';
import { Lock, Landmark, Info } from 'lucide-react';
import { useTranslation, usePermissions } from '../../hooks';
import type { DatabaseState } from '../../dbStore';
import { ledgerApi, inputCls, Card, Notice, useBanner } from './ui';

interface Role { key: string; label: string; usedBy: string; group: string; required: boolean; type: string; control: boolean; accountId: string | null }
interface Acct { id: string; code: string; name: string; nameAr: string | null; type: string; isGroup: boolean; isActive: boolean; isControl: boolean; systemKey: string | null; bankId: string | null }
interface Mapping { roles: Role[]; categories: { category: string; accountId: string | null }[]; banks: { bankId: string; bankName: string; accountId: string | null; isActive: boolean }[]; accounts: Acct[] }

// Account Mapping: which ledger account each kind of document posts to. A change applies to postings made from now on; every journal line keeps
// the account it was posted to, so history never moves.
export default function AccountMappingScreen({ db }: { db: DatabaseState }) {
  const { t, lang } = useTranslation(db);
  const { can } = usePermissions(db.currentUser);
  const { banner, show } = useBanner();
  const [data, setData] = React.useState<Mapping | null>(null);
  const [saving, setSaving] = React.useState<string | null>(null);
  const canEdit = can('accountMapping.update');

  const load = React.useCallback(async () => {
    try { setData(await ledgerApi<Mapping>('/mapping')); } catch (e: any) { show('error', e.message); }
  }, [show]);
  React.useEffect(() => { load(); }, [load]);

  const nameOf = (a: Acct) => `${a.code} · ${lang === 'ar' && a.nameAr ? a.nameAr : a.name}`;

  const changeRole = async (key: string, accountId: string) => {
    setSaving(key);
    try { await ledgerApi('/mapping/role', { method: 'PUT', body: { key, accountId } }); show('success', t('Mapping saved. It applies to postings from now on.')); await load(); }
    catch (e: any) { show('error', e.message); } finally { setSaving(null); }
  };
  const changeCategory = async (category: string, accountId: string) => {
    setSaving(category);
    try { await ledgerApi('/mapping/category', { method: 'PUT', body: { category, accountId } }); show('success', t('Mapping saved. It applies to postings from now on.')); await load(); }
    catch (e: any) { show('error', e.message); } finally { setSaving(null); }
  };

  if (!data) return <p className="text-xs text-slate-400 p-6">{banner ? banner.text : t('Loading...')}</p>;
  const ORDER = ['Sales and POS', 'Purchasing and inventory', 'Expenses', 'Banks, capital and tax'];
  const groups: string[] = (Array.from(new Set(data.roles.map(r => r.group))) as string[]).sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));
  const expenseAccounts = data.accounts.filter(a => a.type === 'Expense' && !a.isGroup && a.isActive && !a.isControl && !a.bankId && (!a.systemKey || a.systemKey === 'DIRECT_OPEX'));

  return (
    <div className="space-y-5 pb-10">
      {banner && <Notice tone={banner.tone}>{banner.text}</Notice>}
      <Notice tone="info"><span className="inline-flex items-center gap-1.5"><Info className="w-3.5 h-3.5" />{t('Changing a mapping affects postings made from now on. Entries already posted keep the account they were posted to.')}</span></Notice>

      {groups.map(g => (
        <Card key={g} className="overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 bg-slate-50/70 text-[11px] font-extrabold uppercase tracking-wider text-slate-600">{t(g)}</div>
          <div className="divide-y divide-slate-100">
            {data.roles.filter(r => r.group === g).map(r => {
              const options = data.accounts.filter(a => a.type === r.type && !a.isGroup && a.isActive && !a.bankId && (!a.systemKey || a.systemKey === r.key));
              return (
                <div key={r.key} className="px-5 py-3 flex flex-wrap items-center gap-3">
                  <div className="flex-1 min-w-[220px]">
                    <div className="text-xs font-bold text-slate-800 flex items-center gap-1.5">{t(r.label)} {r.control && <span title={t('Control account: posted by documents only')}><Lock className="w-3 h-3 text-slate-400" /></span>}</div>
                    <div className="text-[11px] text-slate-500">{t(r.usedBy)}</div>
                  </div>
                  <span className="text-[10px] font-bold uppercase text-slate-400 w-16">{t(r.type)}</span>
                  <select className={`${inputCls} !w-72`} value={r.accountId || ''} disabled={!canEdit || saving === r.key} onChange={e => changeRole(r.key, e.target.value)}>
                    {!r.accountId && <option value="">{t('Not mapped')}</option>}
                    {options.map(a => <option key={a.id} value={a.id}>{nameOf(a)}</option>)}
                  </select>
                </div>
              );
            })}
          </div>
        </Card>
      ))}

      <Card className="overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 bg-slate-50/70 text-[11px] font-extrabold uppercase tracking-wider text-slate-600">{t('Expense categories')}</div>
        <div className="px-5 py-2 text-[11px] text-slate-500 border-b border-slate-100">{t('Each category of expense posts to its own account, so the ledger shows where the money went. An expense with no category posts to the default expense account above.')}</div>
        <div className="divide-y divide-slate-100">
          {data.categories.map(c => (
            <div key={c.category} className="px-5 py-3 flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-[220px] text-xs font-bold text-slate-800">{t(c.category)}</div>
              <select className={`${inputCls} !w-72`} value={c.accountId || ''} disabled={!canEdit || saving === c.category} onChange={e => changeCategory(c.category, e.target.value)}>
                {!c.accountId && <option value="">{t('Not mapped')}</option>}
                {expenseAccounts.map(a => <option key={a.id} value={a.id}>{nameOf(a)}</option>)}
              </select>
            </div>
          ))}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 bg-slate-50/70 text-[11px] font-extrabold uppercase tracking-wider text-slate-600">{t('Banks and cash accounts')}</div>
        <div className="px-5 py-2 text-[11px] text-slate-500 border-b border-slate-100">{t('Every bank or cash account has its own ledger account, created automatically when the bank is added.')}</div>
        <div className="divide-y divide-slate-100">
          {data.banks.length === 0 && <div className="px-5 py-4 text-xs text-slate-400">{t('No bank accounts yet.')}</div>}
          {data.banks.map(b => {
            const a = data.accounts.find(x => x.id === b.accountId);
            return (
              <div key={b.bankId} className="px-5 py-3 flex items-center gap-3 text-xs">
                <Landmark className="w-3.5 h-3.5 text-sky-600" />
                <span className="flex-1 font-bold text-slate-800">{b.bankName}{!b.isActive && <span className="ms-2 text-[10px] text-slate-400 uppercase">{t('Inactive')}</span>}</span>
                <span className="font-mono text-slate-600">{a ? nameOf(a) : '—'}</span>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
