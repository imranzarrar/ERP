import React from 'react';
import { Search, Wand2, CheckCircle2, Circle, Lock } from 'lucide-react';
import { useTranslation, usePermissions } from '../../hooks';
import type { DatabaseState } from '../../dbStore';
import { ledgerApi, inputCls, labelCls, primaryBtn, ghostBtn, Card, Notice, Modal, useBanner, ACCOUNT_TYPES } from './ui';
import { treeOrder, typeName, entityLabel, type DimEntity } from './dimensions';

interface RuleRow { accountId: string; typeId: string; rule: 'optional' | 'required' | 'not_allowed'; defaultEntityId: string | null }
interface Matrix { types: any[]; accounts: any[]; rules: RuleRow[] }

// Assigning dimensions to the chart of accounts: the account structure. Rows are accounts, columns are dimensions, each cell says whether a posting to that
// account must (Required), may (Optional) or must not (Not allowed) carry a tag of the dimension, with an optional default. A change applies to postings made
// from now on and never rewrites history.
export default function AccountDimensionRulesScreen({ db }: { db: DatabaseState }) {
  const { t, lang } = useTranslation(db);
  const { can } = usePermissions(db.currentUser);
  const { banner, show } = useBanner();
  const [m, setM] = React.useState<Matrix | null>(null);
  const [entities, setEntities] = React.useState<Record<string, DimEntity[]>>({});
  const [q, setQ] = React.useState(''); const [typeFilter, setTypeFilter] = React.useState(''); const [onlyUnset, setOnlyUnset] = React.useState(false);
  const [bulk, setBulk] = React.useState(false);
  const canEdit = can('accountDimensionRules.update');

  const load = React.useCallback(async () => {
    try {
      const r = await ledgerApi<Matrix>('/dimension-rules');
      setM(r);
      const opts = await ledgerApi<any>('/dimension-options');
      setEntities(Object.fromEntries(opts.types.map((ty: any) => [ty.id, ty.entities])));
    } catch (e: any) { show('error', e.message); }
  }, [show]);
  React.useEffect(() => { load(); }, [load]);

  const ruleOf = (accountId: string, typeId: string) => m?.rules.find(r => r.accountId === accountId && r.typeId === typeId);
  const setRule = async (accountId: string, typeId: string, rule: string, defaultEntityId: string | null) => {
    try {
      const r = await ledgerApi<any>('/dimension-rules', { method: 'PUT', body: { accountId, typeId, rule: rule || null, defaultEntityId } });
      if (rule === 'required' && r.untaggedPostedLines > 0) show('success', `${t('Saved. This applies to new postings.')} ${r.untaggedPostedLines} ${t('earlier postings on this account have no tag and stay as they are.')}`);
      await load();
    } catch (e: any) { show('error', e.message); await load(); }
  };

  if (!m) return <p className="text-xs text-slate-400 p-6">{banner ? banner.text : t('Loading...')}</p>;
  const accountsShown = m.accounts.filter(a => {
    if (typeFilter && a.type !== typeFilter) return false;
    if (q.trim() && !(a.code.toLowerCase().includes(q.toLowerCase()) || a.name.toLowerCase().includes(q.toLowerCase()) || (a.nameAr || '').includes(q))) return false;
    if (onlyUnset && !a.isGroup && m.types.some(ty => ruleOf(a.id, ty.id))) return false;
    return a.isActive;
  });
  const assigned = new Set(m.rules.map(r => r.accountId)).size;
  const valueCount = (Object.values(entities) as DimEntity[][]).reduce((s, l) => s + l.length, 0);
  const checklist = [
    { done: m.types.length > 0, label: `${t('1 Dimensions defined')}: ${m.types.length}` },
    { done: valueCount > 0, label: `${t('2 Values added')}: ${valueCount}` },
    { done: assigned > 0, label: `${t('3 Accounts with rules')}: ${assigned}` },
  ];

  return (
    <div className="space-y-4 pb-10">
      {banner && <Notice tone={banner.tone}>{banner.text}</Notice>}
      <Card className="p-4 space-y-2">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] font-bold">
          {checklist.map((c, i) => <span key={i} className={`inline-flex items-center gap-1 ${c.done ? 'text-emerald-700' : 'text-amber-600'}`}>{c.done ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Circle className="w-3.5 h-3.5" />}{c.label}</span>)}
        </div>
        <p className="text-xs text-slate-600">{t('For each account choose what a posting must carry. Required: the posting is refused without it. Optional: allowed. Not allowed: refused. A default is filled in when nothing is chosen. Rules apply from now on; earlier postings are never changed.')}</p>
        <p className="text-[11px] text-slate-500">{t('Documents (invoices, bills, expenses) use the defaults but are not blocked by Required until their forms ask for dimensions. Manual journals enforce Required today.')}</p>
      </Card>

      <Card className="p-4 flex flex-wrap items-end gap-3">
        <div className="relative flex-1 min-w-[200px]"><Search className="w-3.5 h-3.5 text-slate-400 absolute top-1/2 -translate-y-1/2 start-3" /><input value={q} onChange={e => setQ(e.target.value)} placeholder={t('Search code or name')} className={`${inputCls} ps-9`} /></div>
        <select className={`${inputCls} !w-auto`} value={typeFilter} onChange={e => setTypeFilter(e.target.value)}><option value="">{t('All types')}</option>{ACCOUNT_TYPES.map(x => <option key={x} value={x}>{t(x)}</option>)}</select>
        <label className="flex items-center gap-1.5 text-xs text-slate-600 font-semibold cursor-pointer"><input type="checkbox" checked={onlyUnset} onChange={e => setOnlyUnset(e.target.checked)} />{t('Only accounts with no rule')}</label>
        {canEdit && <button className={`${primaryBtn} ms-auto`} onClick={() => setBulk(true)}><Wand2 className="w-3.5 h-3.5" />{t('Apply to many accounts')}</button>}
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-start">
            <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-500 tracking-wider">
              <tr><th className="p-3 ps-5 text-start">{t('Code')}</th><th className="p-3 text-start">{t('Account')}</th>{m.types.map(ty => <th key={ty.id} className="p-3 text-start min-w-[190px]">{typeName(ty, lang)}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {accountsShown.map(a => (
                <tr key={a.id} className={a.isGroup ? 'bg-slate-50/70 font-bold' : ''}>
                  <td className="p-2.5 ps-5 font-mono text-slate-600">{a.code}</td>
                  <td className="p-2.5 text-slate-800">{lang === 'ar' && a.nameAr ? a.nameAr : a.name} {a.isControl && <Lock className="w-3 h-3 inline text-slate-400" />}</td>
                  {a.isGroup && <td colSpan={m.types.length} className="p-2.5 text-[10px] font-normal text-slate-400">{t('Use "Apply to many accounts" for a heading')}</td>}
                  {!a.isGroup && m.types.map(ty => {
                    const r = ruleOf(a.id, ty.id);
                    const ents = treeOrder(entities[ty.id] || []);
                    return (
                      <td key={ty.id} className="p-2">
                        <div className="flex gap-1.5">
                          <select disabled={!canEdit} className={`${inputCls} !py-1 !text-[11px] ${r?.rule === 'required' ? '!border-rose-300 !bg-rose-50/40' : ''}`} value={r?.rule || ''} onChange={e => setRule(a.id, ty.id, e.target.value, e.target.value === 'not_allowed' ? null : r?.defaultEntityId || null)}>
                            <option value="">{t('Not set')}</option><option value="optional">{t('Optional')}</option><option value="required">{t('Required')}</option><option value="not_allowed">{t('Not allowed')}</option>
                          </select>
                          {r && r.rule !== 'not_allowed' && (
                            <select disabled={!canEdit} className={`${inputCls} !py-1 !text-[11px]`} value={r.defaultEntityId || ''} onChange={e => setRule(a.id, ty.id, r.rule, e.target.value || null)} title={t('Default value')}>
                              <option value="">{t('No default')}</option>{ents.map(({ e, depth }) => <option key={e.id} value={e.id}>{'  '.repeat(depth)}{entityLabel(e, lang)}</option>)}
                            </select>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {accountsShown.length === 0 && <tr><td colSpan={2 + m.types.length} className="p-8 text-center text-slate-400">{t('No accounts match.')}</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
      {bulk && <BulkModal db={db} matrix={m} entities={entities} onClose={() => setBulk(false)} onDone={async (msg) => { setBulk(false); show('success', msg); await load(); }} />}
    </div>
  );
}

function BulkModal({ db, matrix, entities, onClose, onDone }: { db: DatabaseState; matrix: Matrix; entities: Record<string, DimEntity[]>; onClose: () => void; onDone: (msg: string) => void }) {
  const { t, lang } = useTranslation(db);
  const [typeId, setTypeId] = React.useState(matrix.types[0]?.id || ''); const [rule, setRule] = React.useState('optional'); const [def, setDef] = React.useState('');
  const [kind, setKind] = React.useState('type'); const [accountType, setAccountType] = React.useState('Expense'); const [headingId, setHeadingId] = React.useState('');
  const [from, setFrom] = React.useState(''); const [to, setTo] = React.useState(''); const [skip, setSkip] = React.useState(false);
  const [preview, setPreview] = React.useState<any>(null); const [err, setErr] = React.useState(''); const [busy, setBusy] = React.useState(false);
  const headings = matrix.accounts.filter(a => a.isGroup && a.isActive);
  const body = (dryRun: boolean) => ({ typeId, rule: rule === 'clear' ? null : rule, defaultEntityId: rule === 'not_allowed' || rule === 'clear' ? null : def || null, skipExisting: skip, dryRun, selector: kind === 'type' ? { kind, accountType } : kind === 'heading' ? { kind, headingId } : { kind, from, to } });
  const run = async (dryRun: boolean) => {
    setBusy(true); setErr('');
    try {
      const r = await ledgerApi<any>('/dimension-rules/bulk', { method: 'POST', body: body(dryRun) });
      if (dryRun) setPreview(r); else onDone(`${r.applied} ${t('accounts updated.')}${r.skipped ? ` ${r.skipped} ${t('left as they were.')}` : ''}`);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const ents = treeOrder(entities[typeId] || []);
  return (
    <Modal title={t('Apply a dimension rule to many accounts')} onClose={onClose} footer={<><button className={ghostBtn} onClick={onClose}>{t('Cancel')}</button><button className={ghostBtn} disabled={busy} onClick={() => run(true)}>{t('Preview')}</button><button className={primaryBtn} disabled={busy || !preview} onClick={() => run(false)}>{t('Apply')}</button></>}>
      {err && <Notice tone="error">{err}</Notice>}
      <div className="grid grid-cols-2 gap-3">
        <div><label className={labelCls}>{t('Dimension')}</label><select className={inputCls} value={typeId} onChange={e => { setTypeId(e.target.value); setDef(''); setPreview(null); }}>{matrix.types.map(ty => <option key={ty.id} value={ty.id}>{typeName(ty, lang)}</option>)}</select></div>
        <div><label className={labelCls}>{t('Rule')}</label><select className={inputCls} value={rule} onChange={e => { setRule(e.target.value); setPreview(null); }}><option value="optional">{t('Optional')}</option><option value="required">{t('Required')}</option><option value="not_allowed">{t('Not allowed')}</option><option value="clear">{t('Remove the rule')}</option></select></div>
      </div>
      {(rule === 'optional' || rule === 'required') && <div><label className={labelCls}>{t('Default value (optional)')}</label><select className={inputCls} value={def} onChange={e => { setDef(e.target.value); setPreview(null); }}><option value="">{t('No default')}</option>{ents.map(({ e, depth }) => <option key={e.id} value={e.id}>{'  '.repeat(depth)}{entityLabel(e, lang)}</option>)}</select></div>}
      <div><label className={labelCls}>{t('Apply to')}</label>
        <select className={inputCls} value={kind} onChange={e => { setKind(e.target.value); setPreview(null); }}><option value="type">{t('Every account of a type')}</option><option value="heading">{t('Everything under a heading')}</option><option value="range">{t('A range of account codes')}</option></select></div>
      {kind === 'type' && <select className={inputCls} value={accountType} onChange={e => { setAccountType(e.target.value); setPreview(null); }}>{ACCOUNT_TYPES.map(x => <option key={x} value={x}>{t(x)}</option>)}</select>}
      {kind === 'heading' && <select className={inputCls} value={headingId} onChange={e => { setHeadingId(e.target.value); setPreview(null); }}><option value="">{t('Choose a heading')}</option>{headings.map(h => <option key={h.id} value={h.id}>{h.code} · {h.name}</option>)}</select>}
      {kind === 'range' && <div className="grid grid-cols-2 gap-3"><div><label className={labelCls}>{t('From code')}</label><input className={`${inputCls} font-mono`} value={from} onChange={e => { setFrom(e.target.value); setPreview(null); }} /></div><div><label className={labelCls}>{t('To code')}</label><input className={`${inputCls} font-mono`} value={to} onChange={e => { setTo(e.target.value); setPreview(null); }} /></div></div>}
      <label className="flex items-center gap-2 text-xs cursor-pointer"><input type="checkbox" checked={skip} onChange={e => { setSkip(e.target.checked); setPreview(null); }} />{t('Leave accounts that already have a rule for this dimension as they are')}</label>
      {preview && <Notice tone="info">{preview.matched} {t('accounts match;')} <b>{preview.wouldApply}</b> {t('would change.')}{preview.untaggedPostedLines > 0 ? ` ${preview.untaggedPostedLines} ${t('earlier postings on them carry no tag and stay as they are.')}` : ''}</Notice>}
    </Modal>
  );
}
