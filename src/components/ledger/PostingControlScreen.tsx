import React from 'react';
import { Lock, Save } from 'lucide-react';
import { useTranslation, usePermissions } from '../../hooks';
import type { DatabaseState } from '../../dbStore';
import { ledgerApi, Card, Notice, inputCls, labelCls, primaryBtn } from './ui';
import { resetPostingPolicyCache, type PostingPolicy } from './postingPolicy';

// Posting Control: the finance team's rules for dating a posting, on top of the open / closed fiscal month. The rules apply to every document and journal at once.
export default function PostingControlScreen({ db }: { db: DatabaseState }) {
  const { t } = useTranslation(db);
  const { can } = usePermissions(db.currentUser);
  const canEdit = can('postingControl.update');
  const [policy, setPolicy] = React.useState<PostingPolicy | null>(null);
  const [lockDate, setLockDate] = React.useState('');
  const [maxBack, setMaxBack] = React.useState('');
  const [reasonAfter, setReasonAfter] = React.useState('');
  const [message, setMessage] = React.useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const p = await ledgerApi<PostingPolicy>('/posting-policy');
      setPolicy(p); setLockDate(p.lockDate || ''); setMaxBack(p.maxBackDays === null ? '' : String(p.maxBackDays)); setReasonAfter(p.reasonAfterDays === null ? '' : String(p.reasonAfterDays));
    } catch (e: any) { setMessage({ tone: 'error', text: e.message }); }
  }, []);
  React.useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true); setMessage(null);
    try {
      await ledgerApi('/posting-policy', { method: 'PUT', body: { lockDate: lockDate || null, maxBackDays: maxBack === '' ? null : Number(maxBack), reasonAfterDays: reasonAfter === '' ? null : Number(reasonAfter) } });
      resetPostingPolicyCache(); await load(); setMessage({ tone: 'success', text: t('Posting control saved.') });
    } catch (e: any) { setMessage({ tone: 'error', text: e.message }); } finally { setSaving(false); }
  };

  return (
    <div className="space-y-4 pb-10 max-w-3xl">
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      <Card className="p-5 space-y-5">
        <div className="flex items-start gap-3">
          <Lock className="w-5 h-5 text-indigo-600 mt-0.5" />
          <p className="text-xs text-slate-600 leading-relaxed">{t('These rules apply to every invoice, expense, payment, bill, return and journal. The fiscal month and VAT quarter rules always apply; the rules below tighten them. Someone holding the matching right can go past a rule, and every such posting is written to the audit log.')}</p>
        </div>
        <div>
          <label className={labelCls}>{t('Posting lock date')}</label>
          <input type="date" className={inputCls} disabled={!canEdit} max={policy?.today} value={lockDate} onChange={e => setLockDate(e.target.value)} />
          <p className="text-[11px] text-slate-500 mt-1">{t('Nothing may be dated on or before this day. Leave empty for no lock. Needs the right "post before the lock date" to go past it.')}</p>
        </div>
        <div>
          <label className={labelCls}>{t('Back-date window (days)')}</label>
          <input type="number" min={0} className={inputCls} disabled={!canEdit} value={maxBack} onChange={e => setMaxBack(e.target.value)} placeholder={t('No limit')} />
          <p className="text-[11px] text-slate-500 mt-1">{t('Nothing may be dated more than this many days before today. 0 means entries are dated today or later. Needs the right "post back-dated entries" to go past it.')}</p>
        </div>
        <div>
          <label className={labelCls}>{t('Ask for a reason after (days)')}</label>
          <input type="number" min={0} className={inputCls} disabled={!canEdit} value={reasonAfter} onChange={e => setReasonAfter(e.target.value)} placeholder={t('Never')} />
          <p className="text-[11px] text-slate-500 mt-1">{t('A posting dated more days back than this needs a written reason, kept in the audit log.')}</p>
        </div>
        {canEdit && <button className={primaryBtn} disabled={saving} onClick={save}><Save className="w-3.5 h-3.5" />{saving ? t('Saving...') : t('Save')}</button>}
        {policy && <p className="text-[11px] text-slate-500">{t('Today is')} {policy.today}. {policy.canBackDate ? t('You may post back-dated entries.') : ''} {policy.canOverrideLock ? t('You may post before the lock date.') : ''}</p>}
      </Card>
    </div>
  );
}
