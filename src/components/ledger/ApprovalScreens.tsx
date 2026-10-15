import React from 'react';
import { Plus, Pencil, Power, CheckCircle2, XCircle, Trash2, ShieldCheck } from 'lucide-react';
import { useTranslation } from '../../hooks';
import type { DatabaseState } from '../../dbStore';
import { erpApi, Card, Notice, Modal, Drawer, inputCls, labelCls, primaryBtn, ghostBtn, dangerBtn, greenBtn, money, useBanner } from './ui';

// Approval rules (setup) and My Approvals (daily work). Server: server/lib/approvals.ts. A vendor payment that falls inside a rule's amount band waits here and posts nothing until
// every level has approved; the person who submitted it cannot approve it unless the company allows self-approval (switch on the rules screen, owner / administrator only).
const API = '/api/approvals';
type Level = { approverType: string; approverRef: string; managerSteps: number };
const TYPE_LABEL: Record<string, string> = { VendorPayment: 'Vendor payment' };

export function ApprovalRulesScreen({ db }: { db: DatabaseState }) {
  const { t } = useTranslation(db);
  const currency = db.companySetup?.currency || 'SAR';
  const [rules, setRules] = React.useState<any[]>([]);
  const [edit, setEdit] = React.useState<any | null>(null);
  const [self, setSelf] = React.useState<{ selfApproval: boolean; canChange: boolean }>({ selfApproval: false, canChange: false });
  const { banner, show } = useBanner();
  const roles: any[] = (db as any).roles || []; const users: any[] = db.users || [];
  const load = React.useCallback(async () => {
    try { setRules((await erpApi<{ rules: any[] }>(`${API}/rules`)).rules); setSelf(await erpApi('/api/ledger/journal-settings')); } catch (e: any) { show('error', e.message); }
  }, [show]);
  React.useEffect(() => { load(); }, [load]);
  const toggleSelf = async () => { try { await erpApi('/api/ledger/journal-settings', { method: 'PUT', body: { selfApproval: !self.selfApproval } }); await load(); show('success', t('Saved.')); } catch (e: any) { show('error', e.message); } };
  const who = (l: any) => l.approverType === 'Manager' ? `${t('Manager of the submitter')}${l.managerSteps > 1 ? ` (${l.managerSteps} ${t('steps up')})` : ''}`
    : l.approverType === 'Role' ? `${t('Role')}: ${roles.find(r => r.id === l.approverRef)?.name || l.approverRef}` : l.approverType === 'User' ? `${t('User')}: ${users.find(u => u.id === l.approverRef)?.username || l.approverRef}` : `${t('Permission')}: ${l.approverRef}`;
  return (
    <div className="space-y-4 pb-10">
      {banner && <Notice tone={banner.tone}>{banner.text}</Notice>}
      <Card className="p-4 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2 text-xs"><ShieldCheck className="w-4 h-4 text-indigo-600" />
          <div><div className="font-bold text-slate-800">{t('Allow the person who submits a document to approve it')}</div>
            <div className="text-slate-500">{self.selfApproval ? t('On: allowed, and the document is marked self-approved.') : t('Off: someone else must always approve (recommended).')}</div></div></div>
        <button className={`${self.selfApproval ? dangerBtn : ghostBtn} ms-auto`} disabled={!self.canChange} title={self.canChange ? '' : t('Only the company owner / administrator can change this.')} onClick={toggleSelf}>{self.selfApproval ? t('Turn off') : t('Turn on')}</button>
        <button className={primaryBtn} onClick={() => setEdit({ name: '', documentType: 'VendorPayment', minAmount: '0', maxAmount: '', priority: 100, levels: [{ approverType: 'Role', approverRef: '', managerSteps: 1 }] })}><Plus className="w-3.5 h-3.5" />{t('New rule')}</button>
      </Card>
      <Card className="overflow-x-auto">
        <table className="w-full text-xs text-start">
          <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-500 tracking-wider">
            <tr><th className="p-3 text-start">{t('Rule')}</th><th className="p-3 text-start">{t('Applies to')}</th><th className="p-3 text-end">{t('Amount above')}</th><th className="p-3 text-end">{t('Up to')}</th><th className="p-3 text-start">{t('Approval levels')}</th><th className="p-3 text-start">{t('Status')}</th><th className="p-3"></th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rules.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-slate-400">{t('No approval rules: every payment posts directly.')}</td></tr>}
            {rules.map(r => (
              <tr key={r.id} className={r.isActive ? '' : 'opacity-50'}>
                <td className="p-3 font-bold text-slate-800">{r.name}<div className="text-[10px] font-normal text-slate-400">{t('Priority')} {r.priority}</div></td>
                <td className="p-3">{t(TYPE_LABEL[r.documentType] || r.documentType)}</td>
                <td className="p-3 text-end font-mono tabular-nums">{money(r.minAmount)} {currency}</td>
                <td className="p-3 text-end font-mono tabular-nums">{r.maxAmount == null ? t('No ceiling') : money(r.maxAmount)}</td>
                <td className="p-3">{r.levels.map((l: any) => <div key={l.level}><span className="text-slate-400">{l.level}.</span> {who(l)}</div>)}</td>
                <td className="p-3">{r.isActive ? <span className="text-emerald-700 font-bold">{t('Active')}</span> : <span className="text-slate-400">{t('Inactive')}</span>}</td>
                <td className="p-3 text-end whitespace-nowrap">
                  <button className="text-indigo-700 hover:underline cursor-pointer me-3 inline-flex items-center gap-1" onClick={() => setEdit({ ...r, minAmount: String(r.minAmount), maxAmount: r.maxAmount == null ? '' : String(r.maxAmount), levels: r.levels.map((l: any) => ({ ...l, approverRef: l.approverRef || '' })) })}><Pencil className="w-3 h-3" />{t('Edit')}</button>
                  <button className="text-slate-600 hover:underline cursor-pointer inline-flex items-center gap-1" onClick={async () => { try { await erpApi(`${API}/rules/${r.id}/toggle-active`, { method: 'PATCH' }); await load(); } catch (e: any) { show('error', e.message); } }}><Power className="w-3 h-3" />{r.isActive ? t('Deactivate') : t('Activate')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {edit && <RuleEditor db={db} rule={edit} roles={roles} users={users} currency={currency} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await load(); show('success', t('Saved.')); }} />}
    </div>
  );
}

function RuleEditor({ db, rule, roles, users, currency, onClose, onSaved }: { db: DatabaseState; rule: any; roles: any[]; users: any[]; currency: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation(db);
  const [f, setF] = React.useState(rule); const [error, setError] = React.useState(''); const [busy, setBusy] = React.useState(false);
  const setLevel = (i: number, patch: Partial<Level>) => setF({ ...f, levels: f.levels.map((l: Level, j: number) => (j === i ? { ...l, ...patch } : l)) });
  const save = async () => {
    setBusy(true); setError('');
    try {
      const body = { name: f.name, documentType: f.documentType, minAmount: Number(f.minAmount || 0), maxAmount: f.maxAmount === '' ? null : Number(f.maxAmount), priority: Number(f.priority) || 100, levels: f.levels.map((l: Level) => ({ approverType: l.approverType, approverRef: l.approverType === 'Manager' ? null : l.approverRef, managerSteps: l.managerSteps })) };
      await erpApi(f.id ? `${API}/rules/${f.id}` : `${API}/rules`, { method: f.id ? 'PUT' : 'POST', body }); onSaved();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal title={t(f.id ? 'Edit approval rule' : 'New approval rule')} onClose={onClose} width="max-w-2xl"
      footer={<><button className={ghostBtn} onClick={onClose}>{t('Close')}</button><button className={primaryBtn} disabled={busy || !f.name.trim()} onClick={save}>{t('Save')}</button></>}>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2"><label className={labelCls}>{t('Rule name')}</label><input className={inputCls} value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></div>
        <div><label className={labelCls}>{t('Applies to')}</label><select className={inputCls} value={f.documentType} disabled><option value="VendorPayment">{t('Vendor payment')}</option></select></div>
        <div><label className={labelCls}>{t('Priority (lowest first)')}</label><input type="number" min="1" className={inputCls} value={f.priority} onChange={e => setF({ ...f, priority: e.target.value })} /></div>
        <div><label className={labelCls}>{t('Amount above')} ({currency})</label><input type="number" min="0" step="0.01" className={`${inputCls} font-mono`} value={f.minAmount} onChange={e => setF({ ...f, minAmount: e.target.value })} /></div>
        <div><label className={labelCls}>{t('Up to and including (empty = no ceiling)')}</label><input type="number" min="0" step="0.01" className={`${inputCls} font-mono`} value={f.maxAmount} onChange={e => setF({ ...f, maxAmount: e.target.value })} /></div>
      </div>
      <div className={labelCls}>{t('Approval levels, in order')}</div>
      <div className="space-y-2">
        {f.levels.map((l: Level, i: number) => (
          <div key={i} className="grid grid-cols-12 gap-2 items-end">
            <div className="col-span-1 text-center font-bold text-slate-500 pb-2">{i + 1}</div>
            <div className="col-span-4"><select className={inputCls} value={l.approverType} onChange={e => setLevel(i, { approverType: e.target.value, approverRef: '' })}>
              <option value="Role">{t('A role')}</option><option value="User">{t('A named user')}</option><option value="Manager">{t('Manager of the submitter')}</option><option value="Permission">{t('Anyone holding a permission')}</option></select></div>
            <div className="col-span-6">
              {l.approverType === 'Role' && <select className={inputCls} value={l.approverRef} onChange={e => setLevel(i, { approverRef: e.target.value })}><option value="">{t('Choose a role')}</option>{roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>}
              {l.approverType === 'User' && <select className={inputCls} value={l.approverRef} onChange={e => setLevel(i, { approverRef: e.target.value })}><option value="">{t('Choose a user')}</option>{users.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}</select>}
              {l.approverType === 'Permission' && <input className={inputCls} placeholder="vendorPayments.delete" value={l.approverRef} onChange={e => setLevel(i, { approverRef: e.target.value })} />}
              {l.approverType === 'Manager' && <select className={inputCls} value={l.managerSteps} onChange={e => setLevel(i, { managerSteps: Number(e.target.value) })}>{[1, 2, 3].map(n => <option key={n} value={n}>{n === 1 ? t('Direct manager') : `${n} ${t('steps up the chain')}`}</option>)}</select>}
            </div>
            <div className="col-span-1 pb-1">{f.levels.length > 1 && <button className="text-rose-600 cursor-pointer" onClick={() => setF({ ...f, levels: f.levels.filter((_: any, j: number) => j !== i) })}><Trash2 className="w-3.5 h-3.5" /></button>}</div>
          </div>
        ))}
        {f.levels.length < 5 && <button className={ghostBtn} onClick={() => setF({ ...f, levels: [...f.levels, { approverType: 'Role', approverRef: '', managerSteps: 1 }] })}><Plus className="w-3.5 h-3.5" />{t('Add a level')}</button>}
      </div>
      <p className="text-slate-500">{t('Levels approve one after another. A payment that matches no rule posts directly.')}</p>
    </Modal>
  );
}

export function MyApprovalsScreen({ db }: { db: DatabaseState }) {
  const { t } = useTranslation(db);
  const currency = db.companySetup?.currency || 'SAR';
  const [data, setData] = React.useState<any>({ waiting: [], mine: [] });
  const [open, setOpen] = React.useState<string | null>(null);
  const { banner, show } = useBanner();
  const load = React.useCallback(async () => { try { setData(await erpApi(`${API}/my`)); } catch (e: any) { show('error', e.message); } }, [show]);
  React.useEffect(() => { load(); }, [load]);
  const row = (r: any, mine: boolean) => (
    <tr key={r.id} className="hover:bg-slate-50 cursor-pointer" onClick={() => setOpen(r.id)}>
      <td className="p-3 font-bold text-indigo-700">{t(TYPE_LABEL[r.documentType] || r.documentType)}</td><td className="p-3">{r.summary}</td>
      <td className="p-3 text-end font-mono tabular-nums">{money(r.amount)} {currency}</td><td className="p-3">{t('Level')} {r.currentLevel} / {r.levels}</td>
      <td className="p-3">{mine ? (r.status === 'Pending' ? <span className="text-amber-600 font-bold">{t('Waiting')}</span> : r.status === 'Approved' ? <span className="text-emerald-700 font-bold">{t('Approved')}</span> : <span className="text-rose-600 font-bold">{t('Rejected')}</span>) : String(r.submittedAt).slice(0, 10)}</td>
    </tr>
  );
  const head = (last: string) => <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-500 tracking-wider"><tr><th className="p-3 text-start">{t('Document')}</th><th className="p-3 text-start">{t('Description')}</th><th className="p-3 text-end">{t('Amount')}</th><th className="p-3 text-start">{t('Level')}</th><th className="p-3 text-start">{last}</th></tr></thead>;
  return (
    <div className="space-y-4 pb-10">
      {banner && <Notice tone={banner.tone}>{banner.text}</Notice>}
      <div className="text-xs font-bold text-slate-800">{t('Waiting for you')} ({data.waiting.length})</div>
      <Card className="overflow-x-auto"><table className="w-full text-xs text-start">{head(t('Submitted'))}<tbody className="divide-y divide-slate-100">
        {data.waiting.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-slate-400">{t('Nothing is waiting for your approval.')}</td></tr>}{data.waiting.map((r: any) => row(r, false))}</tbody></table></Card>
      <div className="text-xs font-bold text-slate-800">{t('Submitted by you')}</div>
      <Card className="overflow-x-auto"><table className="w-full text-xs text-start">{head(t('Status'))}<tbody className="divide-y divide-slate-100">
        {data.mine.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-slate-400">{t('You have not submitted anything for approval.')}</td></tr>}{data.mine.map((r: any) => row(r, true))}</tbody></table></Card>
      {open && <RequestDrawer db={db} id={open} canDecide={data.waiting.some((w: any) => w.id === open)} currency={currency} onClose={() => setOpen(null)} onDone={async () => { setOpen(null); await load(); }} />}
    </div>
  );
}

function RequestDrawer({ db, id, canDecide, currency, onClose, onDone }: { db: DatabaseState; id: string; canDecide: boolean; currency: string; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation(db);
  const [d, setD] = React.useState<any>(null); const [remarks, setRemarks] = React.useState(''); const [error, setError] = React.useState(''); const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { erpApi(`${API}/requests/${id}`).then(setD).catch(e => setError(e.message)); }, [id]);
  const decide = async (action: 'Approved' | 'Rejected') => { setBusy(true); setError(''); try { await erpApi(`${API}/requests/${id}/decide`, { method: 'POST', body: { action, remarks } }); onDone(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const p = d?.payload || {};
  return (
    <Drawer title={d ? `${t(TYPE_LABEL[d.documentType] || d.documentType)} · ${money(d.amount)} ${currency}` : t('Approval')} onClose={onClose} width="max-w-lg"
      footer={d && d.status === 'Pending' && canDecide ? <><button className={dangerBtn} disabled={busy} onClick={() => decide('Rejected')}><XCircle className="w-3.5 h-3.5" />{t('Reject')}</button><button className={greenBtn} disabled={busy} onClick={() => decide('Approved')}><CheckCircle2 className="w-3.5 h-3.5" />{t('Approve')}</button></> : undefined}>
      {error && <Notice tone="error">{error}</Notice>}
      {d && (<>
        <div className="grid grid-cols-2 gap-3">
          <div><div className={labelCls}>{t('Submitted by')}</div><div className="font-bold">{d.submittedByName}</div></div>
          <div><div className={labelCls}>{t('Status')}</div><div className="font-bold">{t(d.status)}{d.selfApproved ? ` · ${t('self-approved')}` : ''}</div></div>
          <div><div className={labelCls}>{t('Date')}</div><div className="font-mono">{p.docDate}</div></div>
          <div><div className={labelCls}>{t('Level')}</div><div className="font-mono">{d.currentLevel} / {d.levels.length}</div></div>
          {p.reference && <div className="col-span-2"><div className={labelCls}>{t('Reference')}</div><div>{p.reference}</div></div>}
        </div>
        <div className="text-slate-500">{d.summary}</div>
        <div className={labelCls}>{t('History')}</div>
        <div className="space-y-1">{d.actions.length === 0 && <div className="text-slate-400">{t('No decision yet.')}</div>}{d.actions.map((a: any, i: number) => <div key={i}><b>{t(a.action)}</b> · {t('Level')} {a.level} · {a.by} · {String(a.at).slice(0, 16).replace('T', ' ')}{a.remarks ? ` — ${a.remarks}` : ''}</div>)}</div>
        {d.status === 'Pending' && canDecide && <div><label className={labelCls}>{t('Remarks (required to reject)')}</label><input className={inputCls} value={remarks} onChange={e => setRemarks(e.target.value)} /></div>}
        {d.status === 'Approved' && <Notice tone="success">{t('Approved: the payment was created.')}</Notice>}
      </>)}
    </Drawer>
  );
}
