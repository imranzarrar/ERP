import React from 'react';
import { useTranslation } from '../../hooks';
import type { DatabaseState } from '../../dbStore';
import { ledgerApi, inputCls, labelCls } from './ui';

// The company's posting rules (lock date, back-date window, reason threshold) as the document forms need them: so a form can ask for a reason when the date it was
// given is old enough to need one. The server enforces every rule whatever the form does (server/lib/postingGuard.ts).
export interface PostingPolicy { lockDate: string | null; maxBackDays: number | null; reasonAfterDays: number | null; canBackDate: boolean; canOverrideLock: boolean; today: string }

let cached: Promise<PostingPolicy> | null = null;
export function usePostingPolicy(): PostingPolicy | null {
  const [policy, setPolicy] = React.useState<PostingPolicy | null>(null);
  React.useEffect(() => {
    if (!cached) cached = ledgerApi<PostingPolicy>('/posting-policy');
    cached.then(setPolicy).catch(() => { cached = null; });
  }, []);
  return policy;
}
export const resetPostingPolicyCache = () => { cached = null; };

const dayNumber = (d: string) => Math.floor(Date.parse(d + 'T00:00:00.000Z') / 86400000);
export const daysBackOf = (date: string, today: string) => (date ? Math.max(0, dayNumber(today) - dayNumber(date)) : 0);

// "Back-dating reason": shown only when the policy asks for one for this date. `value` / `onChange` belong to the form, which sends it as backDateReason.
export function BackDateReason({ db, date, value, onChange }: { db: DatabaseState; date: string; value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation(db);
  const policy = usePostingPolicy();
  if (!policy) return null;
  const back = daysBackOf(date, policy.today);
  const locked = !!policy.lockDate && !!date && date <= policy.lockDate;
  const beyond = policy.maxBackDays !== null && back > policy.maxBackDays;
  const needsReason = policy.reasonAfterDays !== null && back > policy.reasonAfterDays;
  if (!locked && !beyond && !needsReason) return null;
  return (
    <div className="space-y-1">
      {locked && !policy.canOverrideLock && <div className="text-[11px] font-bold text-rose-600">{t('This date is on or before the posting lock date')} ({policy.lockDate}). {t('It will be refused.')}</div>}
      {beyond && !policy.canBackDate && <div className="text-[11px] font-bold text-rose-600">{t('This date is further back than the allowed window.')} {t('It will be refused.')}</div>}
      {(needsReason || (locked && policy.canOverrideLock) || (beyond && policy.canBackDate)) && (
        <>
          <label className={labelCls}>{t('Back-dating reason')}{needsReason ? ' *' : ''}</label>
          <input className={inputCls} value={value} maxLength={300} onChange={e => onChange(e.target.value)} placeholder={t('Why is this entry dated before today?')} />
        </>
      )}
    </div>
  );
}
