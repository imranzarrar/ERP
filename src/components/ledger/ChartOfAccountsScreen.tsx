import React from 'react';
import { Search, Plus, Upload, Download, ChevronRight, ChevronDown, Pencil, Power, FileSpreadsheet, CheckCircle2, Lock, Landmark, Layers } from 'lucide-react';
import { useTranslation, usePermissions } from '../../hooks';
import type { DatabaseState } from '../../dbStore';
import {
  ledgerApi, downloadLedgerFile, money, inputCls, labelCls, primaryBtn, ghostBtn, Card, Notice, Drawer, Modal, useBanner, ACCOUNT_TYPES,
} from './ui';

interface Account {
  id: string; code: string; name: string; nameAr: string | null; type: string; parentId: string | null; parentCode: string | null; isGroup: boolean;
  systemKey: string | null; isControl: boolean; bankId: string | null; isActive: boolean; balance: number; lines: number;
}

const TYPE_TONE: Record<string, string> = {
  Asset: 'bg-sky-50 text-sky-700 border-sky-200', Liability: 'bg-amber-50 text-amber-700 border-amber-200', Equity: 'bg-violet-50 text-violet-700 border-violet-200',
  Revenue: 'bg-emerald-50 text-emerald-700 border-emerald-200', Expense: 'bg-rose-50 text-rose-700 border-rose-200',
};

// Chart of Accounts: the company's own list of ledger accounts, as a tree. Accounts can be added, renamed, moved and deactivated (never erased),
// imported from / exported to Excel; the posting roles (what an invoice or an expense posts to) are on the Account Mapping screen.
export default function ChartOfAccountsScreen({ db, autoOpen, onDone }: { db: DatabaseState; autoOpen?: 'create' | 'import'; onDone?: () => void }) {
  const { t, lang } = useTranslation(db);
  const { can } = usePermissions(db.currentUser);
  const { banner, show } = useBanner();
  const [accounts, setAccounts] = React.useState<Account[]>([]);
  const [unmapped, setUnmapped] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [q, setQ] = React.useState('');
  const [typeFilter, setTypeFilter] = React.useState('');
  const [showInactive, setShowInactive] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const [editing, setEditing] = React.useState<Account | 'new' | null>(autoOpen === 'create' ? 'new' : null);
  const [importOpen, setImportOpen] = React.useState(autoOpen === 'import');

  const load = React.useCallback(async () => {
    try {
      const r = await ledgerApi<{ accounts: Account[]; unmappedLines: number }>('/accounts');
      setAccounts(r.accounts); setUnmapped(r.unmappedLines);
    } catch (e: any) { show('error', e.message); }
    finally { setLoading(false); }
  }, [show]);
  React.useEffect(() => { load(); }, [load]);

  const nameOf = (a: { name: string; nameAr: string | null }) => (lang === 'ar' && a.nameAr ? a.nameAr : a.name);
  const currency = db.companySetup?.currency || 'SAR';

  // Visible rows: search / type / inactive filters keep a match's whole ancestry visible so the tree stays readable.
  const rows = React.useMemo(() => {
    const byId = new Map<string, Account>(accounts.map(a => [a.id, a] as [string, Account]));
    const needle = q.trim().toLowerCase();
    const match = (a: Account) => (showInactive || a.isActive) && (!typeFilter || a.type === typeFilter) && (!needle || a.code.toLowerCase().includes(needle) || a.name.toLowerCase().includes(needle) || (a.nameAr || '').toLowerCase().includes(needle));
    const keep = new Set<string>();
    for (const a of accounts) if (match(a)) { let cur: Account | undefined = a; while (cur && !keep.has(cur.id)) { keep.add(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined; } }
    const depth = (a: Account) => { let d = 0; let cur = a; while (cur.parentId && byId.get(cur.parentId) && d < 10) { d++; cur = byId.get(cur.parentId)!; } return d; };
    const hidden = (a: Account) => { let cur = a; while (cur.parentId) { if (collapsed.has(cur.parentId) && !needle) return true; const p = byId.get(cur.parentId); if (!p) break; cur = p; } return false; };
    return accounts.filter(a => keep.has(a.id) && !hidden(a)).map(a => ({ a, depth: depth(a) }));
  }, [accounts, q, typeFilter, showInactive, collapsed]);

  const toggle = async (a: Account) => {
    try {
      await ledgerApi(`/accounts/${a.id}/toggle-active`, { method: 'PATCH' });
      show('success', a.isActive ? t('Account deactivated.') : t('Account reactivated.'));
      await load();
    } catch (e: any) { show('error', e.message); }
  };

  const hasKids = (id: string) => accounts.some(a => a.parentId === id);

  return (
    <div className="space-y-4 pb-10">
      {banner && <Notice tone={banner.tone}>{banner.text}</Notice>}
      {unmapped > 0 && <Notice tone="warn">{t('Some ledger lines are not on any account of your chart:')} {unmapped}. {t('Check Account Mapping.')}</Notice>}
      <Card className="p-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute top-1/2 -translate-y-1/2 start-3" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('Search code or name')} className={`${inputCls} ps-9`} />
        </div>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} className={`${inputCls} !w-auto`}>
          <option value="">{t('All types')}</option>
          {ACCOUNT_TYPES.map(x => <option key={x} value={x}>{t(x)}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-slate-600 font-semibold cursor-pointer">
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} /> {t('Show inactive')}
        </label>
        <div className="flex items-center gap-2 ms-auto">
          <button className={ghostBtn} onClick={() => setCollapsed(new Set(accounts.filter(a => a.isGroup).map(a => a.id)))}><Layers className="w-3.5 h-3.5" />{t('Collapse all')}</button>
          <button className={ghostBtn} onClick={() => setCollapsed(new Set())}>{t('Expand all')}</button>
          {can('chartOfAccounts.export') && <button className={ghostBtn} onClick={() => downloadLedgerFile('/accounts/export', 'chart-of-accounts.xlsx').catch(e => show('error', e.message))}><Download className="w-3.5 h-3.5" />{t('Export')}</button>}
          {can('chartOfAccounts.import') && <button className={ghostBtn} onClick={() => setImportOpen(true)}><Upload className="w-3.5 h-3.5" />{t('Import')}</button>}
          {can('chartOfAccounts.create') && <button className={primaryBtn} onClick={() => setEditing('new')}><Plus className="w-3.5 h-3.5" />{t('New Account')}</button>}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-start">
            <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-500 tracking-wider">
              <tr>
                <th className="p-3 ps-5 text-start">{t('Code')}</th>
                <th className="p-3 text-start">{t('Account')}</th>
                <th className="p-3 text-start">{t('Type')}</th>
                <th className="p-3 text-start">{t('Role')}</th>
                <th className="p-3 text-end">{t('Balance')} ({currency})</th>
                <th className="p-3 text-center">{t('Status')}</th>
                <th className="p-3 pe-5 text-end">{t('Actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={7} className="p-8 text-center text-slate-400">{t('Loading...')}</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} className="p-8 text-center text-slate-400">{t('No accounts match.')}</td></tr>
              ) : rows.map(({ a, depth }) => (
                <tr key={a.id} className={`${a.isActive ? '' : 'opacity-50'} ${a.isGroup ? 'bg-slate-50/70 font-bold' : 'hover:bg-indigo-50/30'}`}>
                  <td className="p-3 ps-5 font-mono text-slate-600">{a.code}</td>
                  <td className="p-3">
                    <div className="flex items-center gap-1.5" style={{ paddingInlineStart: depth * 18 }}>
                      {a.isGroup && hasKids(a.id) ? (
                        <button onClick={() => setCollapsed(prev => { const n = new Set(prev); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); return n; })} className="text-slate-400 hover:text-slate-700 cursor-pointer">
                          {collapsed.has(a.id) ? <ChevronRight className="w-3.5 h-3.5 rtl:rotate-180" /> : <ChevronDown className="w-3.5 h-3.5" />}
                        </button>
                      ) : <span className="w-3.5" />}
                      <span className={a.isGroup ? 'text-slate-900' : 'text-slate-700 font-semibold'}>{nameOf(a)}</span>
                      {a.isGroup && <span className="text-[9px] uppercase text-slate-400 font-bold">{t('Heading')}</span>}
                    </div>
                  </td>
                  <td className="p-3"><span className={`px-2 py-0.5 rounded-full border text-[9px] font-bold uppercase ${TYPE_TONE[a.type] || ''}`}>{t(a.type)}</span></td>
                  <td className="p-3">
                    <div className="flex flex-wrap gap-1">
                      {a.bankId && <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 text-[9px] font-bold uppercase"><Landmark className="w-3 h-3" />{t('Bank')}</span>}
                      {a.systemKey && !a.bankId && <span className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 text-[9px] font-bold uppercase">{t('Posting role')}</span>}
                      {a.isControl && <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[9px] font-bold uppercase"><Lock className="w-3 h-3" />{t('Control')}</span>}
                    </div>
                  </td>
                  <td className="p-3 text-end font-mono tabular-nums">{Math.abs(a.balance) < 0.005 && !a.isGroup ? <span className="text-slate-300">0.00</span> : money(a.balance)}</td>
                  <td className="p-3 text-center">
                    <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${a.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'}`}>{a.isActive ? t('Active') : t('Inactive')}</span>
                  </td>
                  <td className="p-3 pe-5 text-end">
                    <div className="inline-flex items-center gap-1.5">
                      {can('chartOfAccounts.update') && <button title={t('Edit')} onClick={() => setEditing(a)} className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 cursor-pointer"><Pencil className="w-3.5 h-3.5" /></button>}
                      {can('chartOfAccounts.delete') && <button title={a.isActive ? t('Deactivate') : t('Reactivate')} onClick={() => toggle(a)} className={`p-1.5 rounded-lg cursor-pointer ${a.isActive ? 'bg-rose-50 hover:bg-rose-100 text-rose-700' : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700'}`}><Power className="w-3.5 h-3.5" /></button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {editing && (
        <AccountDrawer db={db} accounts={accounts} account={editing === 'new' ? null : editing} onClose={() => { setEditing(null); if (autoOpen === 'create') onDone?.(); }}
          onSaved={async (msg) => { setEditing(null); show('success', msg); await load(); if (autoOpen === 'create') onDone?.(); }} />
      )}
      {importOpen && <ImportModal db={db} onClose={() => { setImportOpen(false); if (autoOpen === 'import') onDone?.(); }} onImported={load} />}
    </div>
  );
}

function AccountDrawer({ db, accounts, account, onClose, onSaved }: { db: DatabaseState; accounts: Account[]; account: Account | null; onClose: () => void; onSaved: (msg: string) => void }) {
  const { t } = useTranslation(db);
  const isNew = !account;
  const [code, setCode] = React.useState(account?.code || '');
  const [name, setName] = React.useState(account?.name || '');
  const [nameAr, setNameAr] = React.useState(account?.nameAr || '');
  const [type, setType] = React.useState(account?.type || 'Expense');
  const [parentId, setParentId] = React.useState(account?.parentId || '');
  const [isGroup, setIsGroup] = React.useState(account?.isGroup || false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  // The type is fixed once an account has postings, a posting role or a bank behind it; the server enforces it, the screen just says so.
  const typeLocked = !isNew && (account!.lines > 0 || !!account!.systemKey || !!account!.bankId || account!.isControl || account!.isGroup);
  const parents = accounts.filter(a => a.isGroup && a.isActive && a.type === type && a.id !== account?.id);

  const save = async () => {
    setSaving(true); setError('');
    try {
      if (isNew) await ledgerApi('/accounts', { method: 'POST', body: { code, name, nameAr, type, parentId: parentId || null, isGroup } });
      else await ledgerApi(`/accounts/${account!.id}`, { method: 'PUT', body: { code, name, nameAr, ...(typeLocked ? {} : { type }), parentId: parentId || null } });
      onSaved(isNew ? t('Account created.') : t('Account saved.'));
    } catch (e: any) { setError(e.message); setSaving(false); }
  };

  return (
    <Drawer title={isNew ? t('New Account') : `${t('Edit Account')} ${account!.code}`} onClose={onClose}
      footer={<><button className={ghostBtn} onClick={onClose}>{t('Cancel')}</button><button className={primaryBtn} disabled={saving || !code.trim() || !name.trim()} onClick={save}>{saving ? t('Saving...') : t('Save')}</button></>}>
      {error && <Notice tone="error">{error}</Notice>}
      {!isNew && (account!.systemKey || account!.isControl) && <Notice tone="info">{t('This account is used by documents (a posting role or control account). You can rename it; its type and role stay fixed. Change the role on the Account Mapping screen.')}</Notice>}
      <div className="grid grid-cols-3 gap-3">
        <div><label className={labelCls}>{t('Code')}</label><input className={`${inputCls} font-mono`} value={code} onChange={e => setCode(e.target.value)} maxLength={12} /></div>
        <div className="col-span-2">
          <label className={labelCls}>{t('Type')}</label>
          <select className={inputCls} value={type} disabled={typeLocked} onChange={e => { setType(e.target.value); setParentId(''); }}>
            {ACCOUNT_TYPES.map(x => <option key={x} value={x}>{t(x)}</option>)}
          </select>
        </div>
      </div>
      {typeLocked && <p className="text-[11px] text-slate-500 -mt-2">{t('The type cannot change once an account has postings, a role or a bank behind it.')}</p>}
      <div><label className={labelCls}>{t('Account name (English)')}</label><input className={inputCls} value={name} onChange={e => setName(e.target.value)} maxLength={120} /></div>
      <div><label className={labelCls}>{t('Account name (Arabic)')}</label><input dir="rtl" className={inputCls} value={nameAr} onChange={e => setNameAr(e.target.value)} maxLength={120} /></div>
      <div>
        <label className={labelCls}>{t('Under heading')}</label>
        <select className={inputCls} value={parentId} onChange={e => setParentId(e.target.value)}>
          <option value="">{t('No heading (top level)')}</option>
          {parents.map(p => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
        </select>
      </div>
      {isNew && (
        <label className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer">
          <input type="checkbox" className="mt-0.5" checked={isGroup} onChange={e => setIsGroup(e.target.checked)} />
          <span><b>{t('This is a heading')}</b><br /><span className="text-slate-500">{t('A heading groups the accounts under it and shows their total. It takes no postings.')}</span></span>
        </label>
      )}
    </Drawer>
  );
}

interface RowResult { rowNumber: number; name: string; action: 'create' | 'update' | 'error'; errors: string[] }

function ImportModal({ db, onClose, onImported }: { db: DatabaseState; onClose: () => void; onImported: () => Promise<void> | void }) {
  const { t } = useTranslation(db);
  const [file, setFile] = React.useState<File | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{ summary: { totalRows: number; toCreate: number; toUpdate: number; errors: number }; rows: RowResult[] } | null>(null);
  const [excluded, setExcluded] = React.useState<Set<number>>(new Set());
  const [done, setDone] = React.useState<{ created: number; updated: number; skipped: number } | null>(null);

  const choose = async (f: File) => {
    setFile(f); setError(null); setResult(null); setDone(null); setLoading(true);
    try {
      const fd = new FormData(); fd.append('file', f);
      const r = await ledgerApi<any>('/accounts/import/validate', { method: 'POST', body: fd });
      setResult(r); setExcluded(new Set((r.rows as RowResult[]).filter(x => x.action === 'error').map(x => x.rowNumber)));
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  };
  const included = result ? result.rows.filter(r => r.action !== 'error' && !excluded.has(r.rowNumber)).map(r => r.rowNumber) : [];
  const commit = async () => {
    if (!file) return;
    setLoading(true); setError(null);
    try {
      const fd = new FormData(); fd.append('file', file); fd.append('include', JSON.stringify(included));
      const r = await ledgerApi<any>('/accounts/import/commit', { method: 'POST', body: fd });
      setDone(r.summary); await onImported();
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  };

  return (
    <Modal title={t('Import Chart of Accounts from Excel')} width="max-w-3xl" onClose={onClose}
      footer={done ? <button className={primaryBtn} onClick={onClose}>{t('Close')}</button> : <><button className={ghostBtn} onClick={onClose}>{t('Cancel')}</button><button className={primaryBtn} disabled={loading || included.length === 0} onClick={commit}>{t('Import')} {included.length > 0 ? `(${included.length})` : ''}</button></>}>
      {done ? (
        <div className="text-center space-y-2 py-4">
          <CheckCircle2 className="w-9 h-9 text-emerald-500 mx-auto" />
          <p className="text-sm font-bold text-slate-800">{t('Import finished')}</p>
          <p className="text-slate-600">{done.created} {t('created')} · {done.updated} {t('renamed')} · {done.skipped} {t('skipped')}</p>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-xl p-3">
            <p className="text-slate-600 pe-3">{t('Start from the template so your column headers match. An import adds accounts and renames existing ones; it never changes a type, a posting role or a bank link.')}</p>
            <button onClick={() => downloadLedgerFile('/accounts/import/template', 'chart-of-accounts-template.xlsx').catch(e => setError(e.message))} className={`${ghostBtn} shrink-0`}><FileSpreadsheet className="w-3.5 h-3.5" />{t('Download Template')}</button>
          </div>
          <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-slate-200 hover:border-indigo-300 rounded-xl py-7 cursor-pointer transition-colors">
            <Upload className="w-6 h-6 text-slate-400" />
            <span className="font-bold text-slate-700">{file ? file.name : t('Choose a .xlsx or .csv file')}</span>
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) choose(f); }} />
          </label>
          {error && <Notice tone="error">{error}</Notice>}
          {loading && <p className="text-center text-slate-400">{t('Working...')}</p>}
          {result && !loading && (
            <>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3"><div className="text-lg font-black text-emerald-700">{result.summary.toCreate}</div><div className="text-emerald-600 font-bold">{t('Will be created')}</div></div>
                <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-3"><div className="text-lg font-black text-indigo-700">{result.summary.toUpdate}</div><div className="text-indigo-600 font-bold">{t('Will be renamed')}</div></div>
                <div className="bg-rose-50 border border-rose-200 rounded-xl p-3"><div className="text-lg font-black text-rose-700">{result.summary.errors}</div><div className="text-rose-600 font-bold">{t('Have errors')}</div></div>
              </div>
              <div className="border border-slate-200 rounded-xl overflow-hidden max-h-72 overflow-y-auto">
                <table className="w-full text-start">
                  <thead className="sticky top-0 bg-slate-50 text-[10px] uppercase font-bold text-slate-500"><tr><th className="p-2 w-8" /><th className="p-2 text-start">{t('Row')}</th><th className="p-2 text-start">{t('Account')}</th><th className="p-2 text-start">{t('Result')}</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {result.rows.map(r => (
                      <tr key={r.rowNumber} className={r.action === 'error' ? 'bg-rose-50/40' : ''}>
                        <td className="p-2"><input type="checkbox" disabled={r.action === 'error'} checked={r.action !== 'error' && !excluded.has(r.rowNumber)} onChange={() => setExcluded(prev => { const n = new Set(prev); if (n.has(r.rowNumber)) n.delete(r.rowNumber); else n.add(r.rowNumber); return n; })} /></td>
                        <td className="p-2 text-slate-500">{r.rowNumber}</td>
                        <td className="p-2 font-semibold text-slate-700">{r.name}</td>
                        <td className="p-2">{r.action === 'error' ? <span className="text-rose-600">{r.errors.join(' ')}</span> : r.action === 'create' ? <span className="text-emerald-700 font-bold">{t('Create')}</span> : <span className="text-indigo-700 font-bold">{t('Rename')}</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

