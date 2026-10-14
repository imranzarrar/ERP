import React from 'react';
import { Plus, Pencil, Power, Layers, Network, Building2, CheckCircle2, Circle } from 'lucide-react';
import { useTranslation, usePermissions } from '../../hooks';
import type { DatabaseState } from '../../dbStore';
import { ledgerApi, inputCls, labelCls, primaryBtn, ghostBtn, Card, Notice, Drawer, useBanner } from './ui';
import { treeOrder, typeName, type DimEntity } from './dimensions';

export type DimensionsMode = 'types' | 'values' | 'cost-centers';

// Dimensions setup. Three screens of the same module, in the order a finance team works: 1 define the dimensions, 2 fill them with values (or cost centres),
// 3 assign them to the chart of accounts (its own screen). Branch and Department are seeded; everything else is the company's own, as many as it needs.
export default function DimensionsScreen({ db, mode }: { db: DatabaseState; mode: DimensionsMode }) {
  if (mode === 'types') return <TypesScreen db={db} />;
  if (mode === 'values') return <ValuesScreen db={db} />;
  return <CostCentersScreen db={db} />;
}

function StepBar({ db, step }: { db: DatabaseState; step: 1 | 2 | 3 }) {
  const { t } = useTranslation(db);
  const steps = [t('1 Define the dimensions'), t('2 Add their values'), t('3 Assign them to accounts'), t('4 Tag postings and filter reports')];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-bold">
      {steps.map((s, i) => (
        <span key={i} className={`inline-flex items-center gap-1 ${i + 1 === step ? 'text-indigo-700' : 'text-slate-400'}`}>{i + 1 === step ? <Circle className="w-3 h-3 fill-indigo-600 text-indigo-600" /> : <CheckCircle2 className="w-3 h-3" />}{s}</span>
      ))}
    </div>
  );
}

function TypesScreen({ db }: { db: DatabaseState }) {
  const { t, lang } = useTranslation(db);
  const { can } = usePermissions(db.currentUser);
  const { banner, show } = useBanner();
  const [types, setTypes] = React.useState<any[] | null>(null);
  const [editing, setEditing] = React.useState<any | 'new' | null>(null);
  const load = React.useCallback(async () => { try { setTypes((await ledgerApi<any>('/dimensions')).types); } catch (e: any) { show('error', e.message); } }, [show]);
  React.useEffect(() => { load(); }, [load]);
  const toggle = async (ty: any) => { try { await ledgerApi(`/dimensions/${ty.id}/toggle-active`, { method: 'PATCH' }); show('success', ty.isActive ? t('Dimension deactivated.') : t('Dimension reactivated.')); await load(); } catch (e: any) { show('error', e.message); } };
  return (
    <div className="space-y-4 pb-10">
      {banner && <Notice tone={banner.tone}>{banner.text}</Notice>}
      <Card className="p-4 space-y-2">
        <StepBar db={db} step={1} />
        <p className="text-xs text-slate-600">{t('A dimension is an extra label on a posting: Branch, Department, Profit Centre, Project, whatever your business reports by. Branch and Department exist already. Add as many others as you need.')}</p>
        {can('dimensions.create') && <div><button className={primaryBtn} onClick={() => setEditing('new')}><Plus className="w-3.5 h-3.5" />{t('New Dimension')}</button></div>}
      </Card>
      <Card className="overflow-hidden">
        <table className="w-full text-xs text-start">
          <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-500 tracking-wider">
            <tr><th className="p-3 ps-5 text-start">{t('Code')}</th><th className="p-3 text-start">{t('Dimension')}</th><th className="p-3 text-start">{t('Values come from')}</th><th className="p-3 text-end">{t('Values')}</th><th className="p-3 text-start">{t('Account rules')}</th><th className="p-3 text-center">{t('Status')}</th><th className="p-3 pe-5 text-end">{t('Actions')}</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!types ? <tr><td colSpan={7} className="p-8 text-center text-slate-400">{t('Loading...')}</td></tr> : types.map(ty => (
              <tr key={ty.id} className={ty.isActive ? '' : 'opacity-50'}>
                <td className="p-3 ps-5 font-mono font-bold text-slate-700">{ty.code}</td>
                <td className="p-3 font-semibold text-slate-800">{typeName(ty, lang)} {ty.isSystem && <span className="ms-1 text-[9px] uppercase font-bold text-slate-400">{t('Built in')}</span>}{ty.isHierarchical && <span className="ms-1 inline-flex items-center gap-0.5 text-[9px] uppercase font-bold text-indigo-600"><Network className="w-3 h-3" />{t('Tree')}</span>}</td>
                <td className="p-3 text-slate-600">{ty.linkedEntity === 'branches' ? t('Branches (Settings)') : ty.linkedEntity === 'cost_centers' ? t('Cost centres') : t('Values you define')}</td>
                <td className="p-3 text-end font-mono">{ty.activeEntityCount}</td>
                <td className="p-3 text-slate-600">{(ty.rules.required || 0) > 0 && <span className="me-2 text-rose-700 font-bold">{ty.rules.required} {t('required')}</span>}{(ty.rules.optional || 0) > 0 && <span className="me-2">{ty.rules.optional} {t('optional')}</span>}{(ty.rules.not_allowed || 0) > 0 && <span className="text-slate-400">{ty.rules.not_allowed} {t('not allowed')}</span>}{!ty.rules.required && !ty.rules.optional && !ty.rules.not_allowed && <span className="text-slate-300">{t('Not assigned yet')}</span>}</td>
                <td className="p-3 text-center"><span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${ty.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'}`}>{ty.isActive ? t('Active') : t('Inactive')}</span></td>
                <td className="p-3 pe-5 text-end"><div className="inline-flex gap-1.5">
                  {can('dimensions.update') && <button title={t('Edit')} onClick={() => setEditing(ty)} className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 cursor-pointer"><Pencil className="w-3.5 h-3.5" /></button>}
                  {can('dimensions.delete') && !ty.isSystem && <button title={ty.isActive ? t('Deactivate') : t('Reactivate')} onClick={() => toggle(ty)} className={`p-1.5 rounded-lg cursor-pointer ${ty.isActive ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'}`}><Power className="w-3.5 h-3.5" /></button>}
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {editing && <TypeDrawer db={db} type={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={async (m) => { setEditing(null); show('success', m); await load(); }} />}
    </div>
  );
}

function TypeDrawer({ db, type, onClose, onSaved }: { db: DatabaseState; type: any | null; onClose: () => void; onSaved: (msg: string) => void }) {
  const { t } = useTranslation(db);
  const [code, setCode] = React.useState(type?.code || '');
  const [name, setName] = React.useState(type?.name || '');
  const [nameAr, setNameAr] = React.useState(type?.nameAr || '');
  const [tree, setTree] = React.useState(!!type?.isHierarchical);
  const [err, setErr] = React.useState(''); const [busy, setBusy] = React.useState(false);
  const save = async () => {
    setBusy(true); setErr('');
    try {
      if (!type) await ledgerApi('/dimensions', { method: 'POST', body: { code, name, nameAr, isHierarchical: tree } });
      else await ledgerApi(`/dimensions/${type.id}`, { method: 'PUT', body: { name, nameAr, ...(type.isSystem ? {} : { isHierarchical: tree }) } });
      onSaved(type ? t('Dimension saved.') : t('Dimension created.'));
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return (
    <Drawer title={type ? `${t('Edit Dimension')} ${type.code}` : t('New Dimension')} onClose={onClose} footer={<><button className={ghostBtn} onClick={onClose}>{t('Cancel')}</button><button className={primaryBtn} disabled={busy || !name.trim() || (!type && !code.trim())} onClick={save}>{t('Save')}</button></>}>
      {err && <Notice tone="error">{err}</Notice>}
      {!type && <div><label className={labelCls}>{t('Code')}</label><input className={`${inputCls} font-mono uppercase`} value={code} maxLength={20} onChange={e => setCode(e.target.value)} placeholder="PC" /></div>}
      <div><label className={labelCls}>{t('Name (English)')}</label><input className={inputCls} value={name} maxLength={80} onChange={e => setName(e.target.value)} placeholder={t('Profit Centre')} /></div>
      <div><label className={labelCls}>{t('Name (Arabic)')}</label><input dir="rtl" className={inputCls} value={nameAr} maxLength={80} onChange={e => setNameAr(e.target.value)} /></div>
      {!type?.isSystem && <label className="flex items-start gap-2 text-xs cursor-pointer"><input type="checkbox" className="mt-0.5" checked={tree} onChange={e => setTree(e.target.checked)} /><span><b>{t('Values form a tree')}</b><br /><span className="text-slate-500">{t('A value can sit under another. Filtering on a parent includes everything under it.')}</span></span></label>}
    </Drawer>
  );
}

function ValuesScreen({ db }: { db: DatabaseState }) {
  const { t, lang } = useTranslation(db);
  const { can } = usePermissions(db.currentUser);
  const { banner, show } = useBanner();
  const [types, setTypes] = React.useState<any[]>([]);
  const [typeId, setTypeId] = React.useState('');
  const [data, setData] = React.useState<{ type: any; values: (DimEntity & { isActive: boolean })[]; editable: boolean } | null>(null);
  const [editing, setEditing] = React.useState<any | 'new' | null>(null);
  React.useEffect(() => { ledgerApi<any>('/dimensions').then(r => { const custom = r.types.filter((x: any) => x.isActive); setTypes(custom); setTypeId(cur => cur || (custom.find((x: any) => x.valueSource === 'Custom') || custom[0])?.id || ''); }).catch(e => show('error', e.message)); }, [show]);
  const load = React.useCallback(async () => { if (!typeId) return; try { setData(await ledgerApi(`/dimensions/${typeId}/values`)); } catch (e: any) { show('error', e.message); } }, [typeId, show]);
  React.useEffect(() => { load(); }, [load]);
  const toggle = async (v: any) => { try { await ledgerApi(`/dimension-values/${v.id}/toggle-active`, { method: 'PATCH' }); await load(); } catch (e: any) { show('error', e.message); } };
  const ordered = data ? treeOrder(data.values) : [];
  return (
    <div className="space-y-4 pb-10">
      {banner && <Notice tone={banner.tone}>{banner.text}</Notice>}
      <Card className="p-4 space-y-3">
        <StepBar db={db} step={2} />
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px]"><label className={labelCls}>{t('Dimension')}</label>
            <select className={inputCls} value={typeId} onChange={e => setTypeId(e.target.value)}>{types.map(ty => <option key={ty.id} value={ty.id}>{typeName(ty, lang)}</option>)}</select></div>
          {data?.editable && can('dimensions.create') && <button className={`${primaryBtn} ms-auto`} onClick={() => setEditing('new')}><Plus className="w-3.5 h-3.5" />{t('New Value')}</button>}
        </div>
        {data && !data.editable && <Notice tone="info">{data.type.linkedEntity === 'branches' ? t('The values of Branch are your company branches. Add or edit them in Settings > Branches.') : t('The values of Department are cost centres. Manage them on the Cost Centres screen.')}</Notice>}
      </Card>
      <Card className="overflow-hidden">
        <table className="w-full text-xs text-start">
          <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-500 tracking-wider"><tr><th className="p-3 ps-5 text-start">{t('Code')}</th><th className="p-3 text-start">{t('Name')}</th><th className="p-3 text-center">{t('Status')}</th><th className="p-3 pe-5 text-end">{t('Actions')}</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {!data ? <tr><td colSpan={4} className="p-8 text-center text-slate-400">{t('Loading...')}</td></tr> : ordered.length === 0 ? <tr><td colSpan={4} className="p-8 text-center text-slate-400">{t('No values yet.')}</td></tr> : ordered.map(({ e, depth }) => {
              const v: any = data.values.find(x => x.id === e.id);
              return (
                <tr key={e.id} className={v.isActive ? '' : 'opacity-50'}>
                  <td className="p-3 ps-5 font-mono text-slate-600">{e.code}</td>
                  <td className="p-3 font-semibold text-slate-800" style={{ paddingInlineStart: 12 + depth * 18 }}>{lang === 'ar' && e.nameAr ? e.nameAr : e.name}</td>
                  <td className="p-3 text-center"><span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${v.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'}`}>{v.isActive ? t('Active') : t('Inactive')}</span></td>
                  <td className="p-3 pe-5 text-end">{data.editable && <div className="inline-flex gap-1.5">
                    {can('dimensions.update') && <button onClick={() => setEditing(v)} className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 cursor-pointer"><Pencil className="w-3.5 h-3.5" /></button>}
                    {can('dimensions.delete') && <button onClick={() => toggle(v)} className={`p-1.5 rounded-lg cursor-pointer ${v.isActive ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'}`}><Power className="w-3.5 h-3.5" /></button>}
                  </div>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      {editing && data && <ValueDrawer db={db} type={data.type} value={editing === 'new' ? null : editing} values={data.values} onClose={() => setEditing(null)} onSaved={async (m) => { setEditing(null); show('success', m); await load(); }} />}
    </div>
  );
}

function ValueDrawer({ db, type, value, values, onClose, onSaved }: { db: DatabaseState; type: any; value: any | null; values: any[]; onClose: () => void; onSaved: (m: string) => void }) {
  const { t } = useTranslation(db);
  const [code, setCode] = React.useState(value?.code || ''); const [name, setName] = React.useState(value?.name || ''); const [nameAr, setNameAr] = React.useState(value?.nameAr || '');
  const [parent, setParent] = React.useState(value?.parentId || ''); const [err, setErr] = React.useState(''); const [busy, setBusy] = React.useState(false);
  const save = async () => {
    setBusy(true); setErr('');
    try {
      if (!value) await ledgerApi(`/dimensions/${type.id}/values`, { method: 'POST', body: { code, name, nameAr, parentValueId: parent || null } });
      else await ledgerApi(`/dimension-values/${value.id}`, { method: 'PUT', body: { code, name, nameAr, parentValueId: parent || null } });
      onSaved(t('Value saved.'));
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return (
    <Drawer title={value ? t('Edit Value') : t('New Value')} onClose={onClose} footer={<><button className={ghostBtn} onClick={onClose}>{t('Cancel')}</button><button className={primaryBtn} disabled={busy || !code.trim() || !name.trim()} onClick={save}>{t('Save')}</button></>}>
      {err && <Notice tone="error">{err}</Notice>}
      <div><label className={labelCls}>{t('Code')}</label><input className={`${inputCls} font-mono`} value={code} maxLength={20} onChange={e => setCode(e.target.value)} /></div>
      <div><label className={labelCls}>{t('Name (English)')}</label><input className={inputCls} value={name} maxLength={120} onChange={e => setName(e.target.value)} /></div>
      <div><label className={labelCls}>{t('Name (Arabic)')}</label><input dir="rtl" className={inputCls} value={nameAr} maxLength={120} onChange={e => setNameAr(e.target.value)} /></div>
      {type.isHierarchical && <div><label className={labelCls}>{t('Under')}</label><select className={inputCls} value={parent} onChange={e => setParent(e.target.value)}><option value="">{t('Top level')}</option>{values.filter(v => v.id !== value?.id && v.isActive).map(v => <option key={v.id} value={v.id}>{v.code} · {v.name}</option>)}</select></div>}
    </Drawer>
  );
}

function CostCentersScreen({ db }: { db: DatabaseState }) {
  const { t, lang } = useTranslation(db);
  const { can } = usePermissions(db.currentUser);
  const { banner, show } = useBanner();
  const [rows, setRows] = React.useState<any[] | null>(null);
  const [editing, setEditing] = React.useState<any | 'new' | null>(null);
  const branches = (db.branches || []).filter(b => b.companyId === db.selectedCompanyId && b.isActive !== false);
  const load = React.useCallback(async () => { try { setRows((await ledgerApi<any>('/cost-centers')).costCenters); } catch (e: any) { show('error', e.message); } }, [show]);
  React.useEffect(() => { load(); }, [load]);
  const toggle = async (c: any) => { try { await ledgerApi(`/cost-centers/${c.id}/toggle-active`, { method: 'PATCH' }); await load(); } catch (e: any) { show('error', e.message); } };
  const ordered = rows ? treeOrder(rows.map(c => ({ id: c.id, code: c.code, name: c.name, nameAr: c.nameAr, parentId: c.parentId }))) : [];
  return (
    <div className="space-y-4 pb-10">
      {banner && <Notice tone={banner.tone}>{banner.text}</Notice>}
      <Card className="p-4 space-y-2">
        <StepBar db={db} step={2} />
        <p className="text-xs text-slate-600">{t('Cost centres are the values of the Department dimension. A cost centre may belong to one branch, or have no home branch when it is shared (shared centres are the ones whose cost can later be distributed to branches).')}</p>
        {can('dimensions.create') && <div><button className={primaryBtn} onClick={() => setEditing('new')}><Plus className="w-3.5 h-3.5" />{t('New Cost Centre')}</button></div>}
      </Card>
      <Card className="overflow-hidden">
        <table className="w-full text-xs text-start">
          <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-500 tracking-wider"><tr><th className="p-3 ps-5 text-start">{t('Code')}</th><th className="p-3 text-start">{t('Cost centre')}</th><th className="p-3 text-start">{t('Home branch')}</th><th className="p-3 text-center">{t('Status')}</th><th className="p-3 pe-5 text-end">{t('Actions')}</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {!rows ? <tr><td colSpan={5} className="p-8 text-center text-slate-400">{t('Loading...')}</td></tr> : ordered.length === 0 ? <tr><td colSpan={5} className="p-8 text-center text-slate-400">{t('No cost centres yet.')}</td></tr> : ordered.map(({ e, depth }) => {
              const c = rows.find(x => x.id === e.id);
              return (
                <tr key={c.id} className={c.isActive ? '' : 'opacity-50'}>
                  <td className="p-3 ps-5 font-mono text-slate-600">{c.code}</td>
                  <td className="p-3 font-semibold text-slate-800" style={{ paddingInlineStart: 12 + depth * 18 }}>{lang === 'ar' && c.nameAr ? c.nameAr : c.name}</td>
                  <td className="p-3 text-slate-600">{c.homeBranchId ? <span className="inline-flex items-center gap-1"><Building2 className="w-3 h-3" />{branches.find(b => b.id === c.homeBranchId)?.name || ''}</span> : <span className="text-slate-400">{t('Shared (no home branch)')}</span>}</td>
                  <td className="p-3 text-center"><span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${c.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'}`}>{c.isActive ? t('Active') : t('Inactive')}</span></td>
                  <td className="p-3 pe-5 text-end"><div className="inline-flex gap-1.5">
                    {can('dimensions.update') && <button onClick={() => setEditing(c)} className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 cursor-pointer"><Pencil className="w-3.5 h-3.5" /></button>}
                    {can('dimensions.delete') && <button onClick={() => toggle(c)} className={`p-1.5 rounded-lg cursor-pointer ${c.isActive ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'}`}><Power className="w-3.5 h-3.5" /></button>}
                  </div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      {editing && <CostCenterDrawer db={db} center={editing === 'new' ? null : editing} all={rows || []} branches={branches} onClose={() => setEditing(null)} onSaved={async (m) => { setEditing(null); show('success', m); await load(); }} />}
    </div>
  );
}

function CostCenterDrawer({ db, center, all, branches, onClose, onSaved }: { db: DatabaseState; center: any | null; all: any[]; branches: any[]; onClose: () => void; onSaved: (m: string) => void }) {
  const { t } = useTranslation(db);
  const [code, setCode] = React.useState(center?.code || ''); const [name, setName] = React.useState(center?.name || ''); const [nameAr, setNameAr] = React.useState(center?.nameAr || '');
  const [home, setHome] = React.useState(center?.homeBranchId || ''); const [parent, setParent] = React.useState(center?.parentId || '');
  const [err, setErr] = React.useState(''); const [busy, setBusy] = React.useState(false);
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const body = { code, name, nameAr, homeBranchId: home || null, parentId: parent || null };
      if (!center) await ledgerApi('/cost-centers', { method: 'POST', body }); else await ledgerApi(`/cost-centers/${center.id}`, { method: 'PUT', body });
      onSaved(t('Cost centre saved.'));
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return (
    <Drawer title={center ? t('Edit Cost Centre') : t('New Cost Centre')} onClose={onClose} footer={<><button className={ghostBtn} onClick={onClose}>{t('Cancel')}</button><button className={primaryBtn} disabled={busy || !code.trim() || !name.trim()} onClick={save}>{t('Save')}</button></>}>
      {err && <Notice tone="error">{err}</Notice>}
      <div><label className={labelCls}>{t('Code')}</label><input className={`${inputCls} font-mono`} value={code} maxLength={20} onChange={e => setCode(e.target.value)} /></div>
      <div><label className={labelCls}>{t('Name (English)')}</label><input className={inputCls} value={name} maxLength={120} onChange={e => setName(e.target.value)} /></div>
      <div><label className={labelCls}>{t('Name (Arabic)')}</label><input dir="rtl" className={inputCls} value={nameAr} maxLength={120} onChange={e => setNameAr(e.target.value)} /></div>
      <div><label className={labelCls}>{t('Home branch')}</label><select className={inputCls} value={home} onChange={e => setHome(e.target.value)}><option value="">{t('Shared (no home branch)')}</option>{branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
      <div><label className={labelCls}>{t('Under')}</label><select className={inputCls} value={parent} onChange={e => setParent(e.target.value)}><option value="">{t('Top level')}</option>{all.filter(c => c.id !== center?.id && c.isActive).map(c => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</select></div>
    </Drawer>
  );
}
