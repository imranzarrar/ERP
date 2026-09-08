import React from 'react';
import { KeyRound, Lock, ShieldCheck, AlertTriangle, CheckCircle, X } from 'lucide-react';
import { useTranslation } from '../hooks';
import type { DatabaseState } from '../dbStore';

// Two callers, one form: the full-screen "forced" gate (mustChangePassword, no way out
// except a successful change — see App.tsx) and the voluntary "modal" variant a logged-in
// user reaches from the sidebar any time. Both always verify the CURRENT password via
// POST /api/auth/change-password — even the forced case, since the user could have left
// their session open unattended after logging in with a password someone else knows.
interface ChangePasswordScreenProps {
  variant: 'forced' | 'modal';
  db: DatabaseState;
  onSuccess: () => void;
  onClose?: () => void; // modal variant only
}

export default function ChangePasswordScreen({ variant, db, onSuccess, onClose }: ChangePasswordScreenProps) {
  const { t, isRTL } = useTranslation(db);
  const [currentPassword, setCurrentPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [success, setSuccess] = React.useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!currentPassword) {
      setErrorMessage(t('Current password is required.'));
      return;
    }
    if (newPassword.length < 6 || !/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      setErrorMessage(t('New password must be at least 6 characters and contain at least one letter and one digit.'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorMessage(t('Passwords do not match.'));
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        setSuccess(true);
      } else {
        setErrorMessage(data.error || t('Failed to change password.'));
      }
    } catch (err) {
      setErrorMessage(t('Failed to change password. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  };

  const formBody = success ? (
    <div className="p-8 text-center space-y-4">
      <CheckCircle className="w-10 h-10 text-emerald-400 mx-auto" />
      <p className="text-sm text-slate-200 font-medium">{t('Password changed successfully.')}</p>
      <button
        onClick={onSuccess}
        className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-3 px-4 rounded-xl transition duration-200"
      >
        {t('Continue')}
      </button>
    </div>
  ) : (
    <form onSubmit={handleSubmit} className="space-y-4 p-8">
      <div className="space-y-4">
        <div>
          <label className="block text-[10px] font-bold text-indigo-300 uppercase tracking-wider mb-1.5">{t('Current Password')}</label>
          <div className="relative group">
            <div className="absolute inset-y-0 start-0 pl-3.5 flex items-center pointer-events-none text-slate-500 group-focus-within:text-indigo-400 transition-colors">
              <Lock className="w-4 h-4" />
            </div>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full bg-indigo-950/50 border border-indigo-900/80 text-white rounded-xl pl-10 pr-4 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all text-sm shadow-inner placeholder-slate-600 font-medium tracking-widest"
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </div>
        </div>

        <div>
          <label className="block text-[10px] font-bold text-indigo-300 uppercase tracking-wider mb-1.5">{t('New Password')}</label>
          <div className="relative group">
            <div className="absolute inset-y-0 start-0 pl-3.5 flex items-center pointer-events-none text-slate-500 group-focus-within:text-indigo-400 transition-colors">
              <KeyRound className="w-4 h-4" />
            </div>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full bg-indigo-950/50 border border-indigo-900/80 text-white rounded-xl pl-10 pr-4 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all text-sm shadow-inner placeholder-slate-600 font-medium tracking-widest"
              placeholder="••••••••"
              autoComplete="new-password"
            />
          </div>
          <p className="text-[9px] text-slate-500 mt-1 font-mono">{t('Min 6 characters, at least one letter and one digit.')}</p>
        </div>

        <div>
          <label className="block text-[10px] font-bold text-indigo-300 uppercase tracking-wider mb-1.5">{t('Confirm New Password')}</label>
          <div className="relative group">
            <div className="absolute inset-y-0 start-0 pl-3.5 flex items-center pointer-events-none text-slate-500 group-focus-within:text-indigo-400 transition-colors">
              <ShieldCheck className="w-4 h-4" />
            </div>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full bg-indigo-950/50 border border-indigo-900/80 text-white rounded-xl pl-10 pr-4 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all text-sm shadow-inner placeholder-slate-600 font-medium tracking-widest"
              placeholder="••••••••"
              autoComplete="new-password"
            />
          </div>
        </div>
      </div>

      {errorMessage && (
        <div className="p-3 bg-rose-950/40 border border-rose-900/50 rounded-xl flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <p className="text-[11px] font-medium text-rose-300 leading-relaxed">{errorMessage}</p>
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full relative group overflow-hidden bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold py-3.5 px-4 rounded-xl transition duration-200 shadow-xl shadow-indigo-900/20 active:scale-[0.98] outline-none mt-4"
      >
        <span className="relative z-10 flex items-center justify-center gap-2">
          <KeyRound className="w-4 h-4" />
          {submitting ? t('UPDATING...') : t('CHANGE PASSWORD')}
        </span>
      </button>
    </form>
  );

  if (variant === 'modal') {
    return (
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
        <div
          dir={isRTL ? 'rtl' : 'ltr'}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-md bg-indigo-950 border border-indigo-900/50 rounded-3xl shadow-2xl relative"
        >
          <button
            type="button"
            onClick={onClose}
            className="absolute top-4 end-4 z-10 text-slate-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
          <div className="text-center space-y-2 pt-8 px-8">
            <div className="inline-flex p-3 bg-indigo-900/30 border border-indigo-500/20 rounded-2xl shadow-inner text-indigo-400">
              <KeyRound className="w-8 h-8" />
            </div>
            <h2 className="text-lg font-black text-white tracking-widest uppercase">{t('Change Password')}</h2>
          </div>
          {formBody}
        </div>
      </div>
    );
  }

  return (
    <div dir={isRTL ? 'rtl' : 'ltr'} className="min-h-screen bg-indigo-950 flex flex-col justify-center items-center p-4 relative overflow-hidden font-sans selection:bg-indigo-600 selection:text-white">
      <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.05)_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_50%,#000_70%,transparent_100%)] opacity-60"></div>

      <div className="w-full max-w-md space-y-6 z-10">
        <div className="text-center space-y-2">
          <div className="inline-flex p-3 bg-indigo-900/30 border border-indigo-500/20 rounded-2xl shadow-inner text-indigo-400">
            <KeyRound className="w-8 h-8" />
          </div>
          <h2 className="text-xl font-black text-white tracking-widest uppercase">{t('Change Your Password')}</h2>
          <p className="text-xs text-slate-400 font-medium max-w-xs mx-auto">
            {t('An administrator set this account\'s password. You must choose your own before continuing.')}
          </p>
        </div>
        <div className="bg-indigo-950/80 backdrop-blur-xl border border-indigo-900/50 rounded-3xl shadow-2xl shadow-indigo-950/50">
          {formBody}
        </div>
      </div>
    </div>
  );
}
