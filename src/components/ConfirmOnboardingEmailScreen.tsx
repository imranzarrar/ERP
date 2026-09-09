import React from 'react';
import { MailCheck, AlertTriangle, CheckCircle, Loader2 } from 'lucide-react';
import { useTranslation } from '../hooks';
import type { DatabaseState } from '../dbStore';

// Rendered pre-login from the emailed confirmation link's ?confirmOnboardingToken= param
// (see server/routes/onboarding.ts's POST /onboarding-requests/confirm-email) — same
// pattern as ResetPasswordScreen/CompanyOnboardingScreen: a standalone pre-login screen,
// language threaded down from App.tsx since there's no db.currentUser this early. Unlike
// those two, there's nothing for the visitor to fill in — the token in the URL IS the
// confirmation, so this fires the request automatically on mount rather than waiting on
// a form submit.
interface ConfirmOnboardingEmailScreenProps {
  token: string;
  onDone: () => void;
  lang: 'en' | 'ar' | 'ur';
  onLangChange: (lang: 'en' | 'ar' | 'ur') => void;
  db: DatabaseState;
}

export default function ConfirmOnboardingEmailScreen({ token, onDone, lang, onLangChange, db }: ConfirmOnboardingEmailScreenProps) {
  const { t, isRTL } = useTranslation(db, lang);
  const [status, setStatus] = React.useState<'confirming' | 'success' | 'error'>('confirming');
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [companyName, setCompanyName] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch('/api/onboarding-requests/confirm-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok) {
          setCompanyName(data.companyName || null);
          setStatus('success');
        } else {
          setErrorMessage(data.error || t('Failed to confirm your email.'));
          setStatus('error');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setErrorMessage(t('Failed to confirm your email. Please check your connection and try again.'));
          setStatus('error');
        }
      });
    return () => { cancelled = true; };
    // Fires exactly once on mount — the token is fixed for this screen's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div dir={isRTL ? 'rtl' : 'ltr'} className="min-h-screen bg-[#151E19] flex flex-col justify-center items-center p-4 relative overflow-hidden font-sans selection:bg-[#AD8636] selection:text-[#151E19]">
      <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.05)_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_50%,#000_70%,transparent_100%)] opacity-60"></div>

      <div className="absolute top-4 end-4 z-20 flex items-center gap-1 bg-[#20291F]/70 border border-[#3A4A3E]/50 rounded-xl p-1">
        {(['en', 'ar', 'ur'] as const).map(l => (
          <button
            key={l}
            type="button"
            onClick={() => onLangChange(l)}
            className={`px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase transition-colors ${lang === l ? 'bg-[#AD8636] text-[#151E19]' : 'text-slate-400 hover:text-slate-200'}`}
          >
            {l}
          </button>
        ))}
      </div>

      <div className="w-full max-w-md space-y-6 z-10">
        <div className="text-center space-y-2">
          <div className={`inline-flex p-3 rounded-2xl shadow-inner ${
            status === 'success' ? 'bg-emerald-500/10 border border-emerald-500/25 text-emerald-400'
            : status === 'error' ? 'bg-rose-500/10 border border-rose-500/25 text-rose-400'
            : 'bg-[#AD8636]/10 border border-[#AD8636]/25 text-[#D9B268]'
          }`}>
            {status === 'success' ? <CheckCircle className="w-8 h-8" />
              : status === 'error' ? <AlertTriangle className="w-8 h-8" />
              : <MailCheck className="w-8 h-8" />}
          </div>
          <h2 className="font-brand text-2xl font-semibold text-white tracking-tight">
            {status === 'success' ? t('Email Confirmed') : status === 'error' ? t('Confirmation Failed') : t('Confirming Your Email')}
          </h2>
          <p className="text-sm font-bold text-[#D9B268] tracking-wide mt-1">{t('Warraq ERP System')}</p>
        </div>

        <div className="p-8 bg-[#20291F]/80 backdrop-blur-xl border border-[#3A4A3E]/50 rounded-3xl shadow-2xl shadow-black/40 text-center space-y-4">
          {status === 'confirming' && (
            <div className="flex flex-col items-center gap-3 py-4">
              <Loader2 className="w-8 h-8 text-[#D9B268] animate-spin" />
              <p className="text-xs text-slate-400 font-medium">{t('One moment...')}</p>
            </div>
          )}

          {status === 'success' && (
            <p className="text-sm text-slate-200 font-medium leading-relaxed">
              {companyName
                ? t('Your email is confirmed. Your request for "{company}" is now with our team for review.').replace('{company}', companyName)
                : t('Your email is confirmed. Your request is now with our team for review.')}
            </p>
          )}

          {status === 'error' && (
            <div className="p-3 bg-rose-950/40 border border-rose-900/50 rounded-xl flex items-start gap-2.5 text-start">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <p className="text-[11px] font-medium text-rose-300 leading-relaxed">{errorMessage}</p>
            </div>
          )}

          {status !== 'confirming' && (
            <button
              onClick={onDone}
              className="w-full bg-[#AD8636] hover:bg-[#c49a44] text-[#151E19] font-bold py-3 px-4 rounded-xl transition duration-200"
            >
              {t('Back to Login')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
