import React from 'react';
import { useTranslation, usePermissions } from '../hooks';
import { DatabaseState, generateId } from '../dbStore';
import { ModifierGroup } from '../types';
import { Plus, Layers, Trash, Check, X } from 'lucide-react';

interface ModifierGroupsModuleProps {
  db: DatabaseState;
  onUpdateDbLocal: (updater: (prev: DatabaseState) => DatabaseState) => void;
  onRefreshDb?: () => Promise<void>;
  currentUser: any;
}

interface ChoiceDraft {
  id?: string;
  label: string;
  priceDelta: string;
}

export default function ModifierGroupsModule({ db, onRefreshDb, currentUser }: ModifierGroupsModuleProps) {
  const { t } = useTranslation(db);
  const { can } = usePermissions(currentUser);
  const companyId = db.selectedCompanyId;

  const groups = ((db.modifierGroups || []) as ModifierGroup[]).filter(g => g.companyId === companyId);

  const [success, setSuccess] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const triggerSuccess = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(null), 3500); };
  const triggerError = (msg: string) => { setError(msg); setTimeout(() => setError(null), 4500); };

  const canCreate = can('modifierGroups.create');
  const canUpdate = can('modifierGroups.update');
  const canDelete = can('modifierGroups.delete');

  const [name, setName] = React.useState('');
  const [isRequired, setIsRequired] = React.useState(true);
  const [choices, setChoices] = React.useState<ChoiceDraft[]>([{ label: '', priceDelta: '0' }]);
  const [editingId, setEditingId] = React.useState<string | null>(null);

  const clearForm = () => {
    setEditingId(null);
    setName('');
    setIsRequired(true);
    setChoices([{ label: '', priceDelta: '0' }]);
  };

  const startEdit = (g: ModifierGroup) => {
    setEditingId(g.id);
    setName(g.name);
    setIsRequired(!!g.isRequired);
    setChoices(g.choices.length ? g.choices.map(c => ({ id: c.id, label: c.label, priceDelta: String(c.priceDelta) })) : [{ label: '', priceDelta: '0' }]);
  };

  const updateChoice = (idx: number, field: 'label' | 'priceDelta', value: string) => {
    setChoices(prev => prev.map((c, i) => i === idx ? { ...c, [field]: value } : c));
  };
  const addChoiceRow = () => setChoices(prev => [...prev, { label: '', priceDelta: '0' }]);
  const removeChoiceRow = (idx: number) => setChoices(prev => prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx));

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return triggerError(t('A modifier group name is required.'));
    const cleanChoices = choices.map(c => ({ id: c.id, label: c.label.trim(), priceDelta: parseFloat(c.priceDelta) || 0 })).filter(c => c.label);
    if (cleanChoices.length === 0) return triggerError(t('At least one choice is required (e.g. Small, Medium, Large).'));
    try {
      const res = await fetch('/api/modifier-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingId || undefined,
          name: name.trim(),
          isRequired,
          choices: cleanChoices,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) return triggerError(data.error || t('Failed to save modifier group.'));
      triggerSuccess(editingId ? t('Modifier group updated successfully.') : t('Modifier group created successfully.'));
      clearForm();
      if (onRefreshDb) await onRefreshDb();
    } catch {
      triggerError(t('Failed to save modifier group.'));
    }
  };

  const handleToggleActive = async (id: string) => {
    const g = groups.find(x => x.id === id);
    const active = g?.isActive !== false;
    if (active && !window.confirm(t('Deactivate this modifier group? Any product still attached to it keeps its history, but it will no longer be offered on new POS sales.'))) return;
    try {
      const res = await fetch(`/api/modifier-groups/${id}/toggle-active`, { method: 'PATCH' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) return triggerError(data.error || t('Failed to update modifier group status.'));
      triggerSuccess(active ? t('Modifier group deactivated.') : t('Modifier group reactivated.'));
      if (onRefreshDb) await onRefreshDb();
    } catch {
      triggerError(t('Failed to update modifier group status.'));
    }
  };

  return (
    <div className="p-6 space-y-6">
      {success && <div className="p-3 bg-emerald-50 text-emerald-700 rounded-xl border border-emerald-100 text-xs font-semibold">{success}</div>}
      {error && <div className="p-3 bg-rose-50 text-rose-700 rounded-xl border border-rose-100 text-xs font-semibold">{error}</div>}

      <div>
        <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2"><Layers className="w-4 h-4" /> {t('Modifier Groups')}</h3>
        <p className="text-[11px] text-slate-400">{t('Reusable POS customization options (Size, Milk, Extra Shot…) — build a group once, then attach it to whichever products need it from the product form. A product with none attached sells exactly as it does today.')}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 border border-slate-100 rounded-2xl overflow-hidden shadow-sm">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 text-slate-500">
                <th className="p-3 text-start">{t('Group')}</th>
                <th className="p-3 text-start">{t('Choices')}</th>
                <th className="p-3 text-center">{t('Required')}</th>
                <th className="p-3 text-center">{t('Status')}</th>
                <th className="p-3 text-end">{t('Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {groups.length === 0 ? (
                <tr><td colSpan={5} className="p-6 text-center text-slate-400">{t('No modifier groups yet.')}</td></tr>
              ) : groups.map(g => (
                <tr key={g.id} className={`border-b border-slate-100 last:border-0 align-top ${g.isActive === false ? 'opacity-50' : ''}`}>
                  <td className="p-3 font-semibold text-slate-800">{g.name}</td>
                  <td className="p-3 text-slate-600">
                    <div className="flex flex-wrap gap-1">
                      {g.choices.map(c => (
                        <span key={c.id} className="px-2 py-0.5 rounded-full bg-slate-50 border border-slate-200 text-[10px]">
                          {c.label}{c.priceDelta ? ` (${c.priceDelta > 0 ? '+' : ''}${c.priceDelta})` : ''}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="p-3 text-center">
                    {g.isRequired
                      ? <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase bg-rose-50 text-rose-600 border border-rose-200">{t('Required')}</span>
                      : <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase bg-slate-100 text-slate-500 border border-slate-200">{t('Optional')}</span>}
                  </td>
                  <td className="p-3 text-center">
                    {g.isActive === false
                      ? <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase bg-slate-100 text-slate-500 border border-slate-200">{t('Inactive')}</span>
                      : <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase bg-emerald-50 text-emerald-700 border border-emerald-200">{t('Active')}</span>}
                  </td>
                  <td className="p-3 text-end">
                    <div className="flex justify-end gap-3">
                      {canUpdate && g.isActive !== false && (
                        <button type="button" onClick={() => startEdit(g)} className="text-[10px] font-bold text-indigo-600 hover:underline">{t('Edit')}</button>
                      )}
                      {canDelete && (
                        <button type="button" onClick={() => handleToggleActive(g.id)} className="text-[10px] font-bold text-rose-500 hover:underline">
                          {g.isActive === false ? t('Reactivate') : t('Deactivate')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {(editingId ? canUpdate : canCreate) && (
          <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
            <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3">
              {editingId ? t('Edit Modifier Group') : t('Create New Modifier Group')}
            </h4>
            <form onSubmit={handleSave} className="space-y-3">
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Name')}</label>
                <input type="text" required value={name} onChange={e => setName(e.target.value)}
                  placeholder={t('e.g. Size, Milk, Extra Shot')}
                  className="w-full bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500" />
              </div>
              <label className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer pt-1">
                <input type="checkbox" checked={isRequired} onChange={e => setIsRequired(e.target.checked)}
                  className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5 mt-0.5" />
                <span>{t('Required — a cashier must pick one before the item can be added to the sale (e.g. Size). Leave unchecked for an optional add-on (e.g. Extra Shot).')}</span>
              </label>

              <div className="space-y-1.5">
                <label className="text-[10px] font-bold text-slate-400 uppercase">{t('Choices')}</label>
                {choices.map((c, idx) => (
                  <div key={idx} className="flex gap-1.5 items-center">
                    <input type="text" placeholder={t('Label, e.g. Medium')} value={c.label} onChange={e => updateChoice(idx, 'label', e.target.value)}
                      className="flex-1 bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                    <input type="number" step="0.01" placeholder="0.00" value={c.priceDelta} onChange={e => updateChoice(idx, 'priceDelta', e.target.value)}
                      className="w-20 bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                    <button type="button" onClick={() => removeChoiceRow(idx)} disabled={choices.length <= 1}
                      className="text-slate-400 hover:text-rose-500 disabled:opacity-30 disabled:cursor-not-allowed p-1">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                <button type="button" onClick={addChoiceRow} className="text-[10px] font-bold text-indigo-600 hover:underline flex items-center gap-1">
                  <Plus className="w-3 h-3" /> {t('Add Choice')}
                </button>
                <p className="text-[10px] text-slate-400">{t('Price adjustment is added to the item\'s base price when that choice is picked — leave 0.00 for no price change.')}</p>
              </div>

              <div className="flex gap-2 pt-1">
                {editingId && (
                  <button type="button" onClick={clearForm} className="px-4 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl font-bold text-xs">{t('Cancel')}</button>
                )}
                <button type="submit" className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl px-4 py-1.5 text-xs font-bold flex items-center justify-center gap-1 shadow-sm">
                  {editingId ? <Check className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                  {editingId ? t('Save Changes') : t('Create Modifier Group')}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
