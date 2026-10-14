import React from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import { useTranslation } from '../../hooks';
import type { DatabaseState } from '../../dbStore';
import { ledgerApi, inputCls, labelCls, ghostBtn } from './ui';

// Shared pieces for dynamic dimensions: the list of dimension types with their selectable values (fetched once per screen), a filter control every ledger
// report uses, and the per-line pickers of a journal.
export interface DimEntity { id: string; code: string; name: string; nameAr: string | null; parentId: string | null }
export interface DimType { id: string; code: string; name: string; nameAr: string | null; valueSource: string; linkedEntity: string | null; isHierarchical: boolean; entities: DimEntity[] }
export interface DimOptions { types: DimType[]; rules: Record<string, Record<string, { rule: 'optional' | 'required' | 'not_allowed'; defaultEntityId: string | null }>> }
export type DimTags = Record<string, string>;
export type DimFilterValue = Record<string, string[]>;

export function useDimensionOptions(): { options: DimOptions | null; reload: () => void } {
  const [options, setOptions] = React.useState<DimOptions | null>(null);
  const load = React.useCallback(() => { ledgerApi<DimOptions>('/dimension-options').then(setOptions).catch(() => setOptions({ types: [], rules: {} })); }, []);
  React.useEffect(() => { load(); }, [load]);
  return { options, reload: load };
}

export const typeName = (t: { name: string; nameAr: string | null }, lang: string) => (lang === 'ar' && t.nameAr ? t.nameAr : t.name);
export const entityLabel = (e: DimEntity, lang: string) => `${e.code} · ${lang === 'ar' && e.nameAr ? e.nameAr : e.name}`;

// Entities in tree order with a depth, so a hierarchical dimension reads as a tree in every dropdown.
export function treeOrder(entities: DimEntity[]): { e: DimEntity; depth: number }[] {
  const byParent = new Map<string | null, DimEntity[]>();
  const ids = new Set(entities.map(e => e.id));
  for (const e of entities) { const k = e.parentId && ids.has(e.parentId) ? e.parentId : null; const l = byParent.get(k) || []; l.push(e); byParent.set(k, l); }
  const out: { e: DimEntity; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => { for (const e of byParent.get(parent) || []) { out.push({ e, depth }); if (depth < 12) walk(e.id, depth + 1); } };
  walk(null, 0);
  return out;
}

// A compact filter: "Dimensions (2)" opens a panel with one multi-select per dimension. A parent value includes its children on the server.
export function DimensionFilter({ db, options, value, onChange }: { db: DatabaseState; options: DimOptions | null; value: DimFilterValue; onChange: (v: DimFilterValue) => void }) {
  const { t, lang } = useTranslation(db);
  const [open, setOpen] = React.useState(false);
  const count = Object.values(value).filter(v => v.length > 0).length;
  if (!options || options.types.length === 0) return null;
  const toggle = (typeId: string, id: string) => {
    const cur = value[typeId] || [];
    const next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
    const out = { ...value, [typeId]: next }; if (!next.length) delete out[typeId];
    onChange(out);
  };
  return (
    <div className="relative">
      <button type="button" className={ghostBtn} onClick={() => setOpen(o => !o)}><SlidersHorizontal className="w-3.5 h-3.5" />{t('Dimensions')}{count ? ` (${count})` : ''}</button>
      {open && (
        <div className="absolute z-40 mt-1 w-[min(92vw,420px)] bg-white border border-slate-200 rounded-xl shadow-xl p-3 space-y-3 max-h-[70vh] overflow-y-auto" style={{ insetInlineStart: 0 }}>
          <div className="flex items-center justify-between"><span className="text-xs font-bold text-slate-700">{t('Show only postings tagged with')}</span>
            <div className="flex items-center gap-2">{count > 0 && <button className="text-[11px] font-bold text-rose-600 cursor-pointer" onClick={() => onChange({})}>{t('Clear')}</button>}<button onClick={() => setOpen(false)} className="text-slate-400 cursor-pointer"><X className="w-3.5 h-3.5" /></button></div></div>
          {options.types.map(ty => (
            <div key={ty.id}>
              <div className={labelCls}>{typeName(ty, lang)}</div>
              <div className="max-h-40 overflow-y-auto border border-slate-200 rounded-lg p-1.5 space-y-0.5">
                {treeOrder(ty.entities).map(({ e, depth }) => (
                  <label key={e.id} className="flex items-center gap-2 text-xs cursor-pointer rounded px-1 hover:bg-slate-50" style={{ paddingInlineStart: 4 + depth * 14 }}>
                    <input type="checkbox" checked={(value[ty.id] || []).includes(e.id)} onChange={() => toggle(ty.id, e.id)} />{entityLabel(e, lang)}
                  </label>
                ))}
                {ty.entities.length === 0 && <div className="text-[11px] text-slate-400 p-1">{t('No values yet.')}</div>}
              </div>
            </div>
          ))}
          <p className="text-[11px] text-slate-500">{t('Choosing a parent value includes everything under it. A posting must match every dimension you tick.')}</p>
        </div>
      )}
    </div>
  );
}

// The dimension pickers of one journal line: only the dimensions the account allows, Required ones marked, the account's default pre-filled.
export function LineDimensions({ db, options, accountId, value, onChange }: { db: DatabaseState; options: DimOptions | null; accountId: string; value: DimTags; onChange: (v: DimTags) => void }) {
  const { t, lang } = useTranslation(db);
  if (!options || !accountId) return null;
  const rules = options.rules[accountId] || {};
  const shown = options.types.filter(ty => rules[ty.id]?.rule !== 'not_allowed' && (ty.entities.length > 0 || rules[ty.id]?.rule === 'required'));
  if (!shown.length) return null;
  return (
    <div className="flex flex-wrap gap-2 mt-1.5">
      {shown.map(ty => {
        const r = rules[ty.id];
        const missing = r?.rule === 'required' && !value[ty.id];
        return (
          <label key={ty.id} className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">
            <span className={missing ? 'text-rose-600' : ''}>{typeName(ty, lang)}{r?.rule === 'required' ? ' *' : ''}</span>
            <select className={`${inputCls} !w-auto !py-1 !text-[11px] normal-case tracking-normal font-normal ${missing ? '!border-rose-300' : ''}`} value={value[ty.id] || ''}
              onChange={e => { const n = { ...value }; if (e.target.value) n[ty.id] = e.target.value; else delete n[ty.id]; onChange(n); }}>
              <option value="">{r?.defaultEntityId ? t('Default') : '—'}</option>
              {treeOrder(ty.entities).map(({ e, depth }) => <option key={e.id} value={e.id}>{'  '.repeat(depth)}{entityLabel(e, lang)}</option>)}
            </select>
          </label>
        );
      })}
    </div>
  );
}
