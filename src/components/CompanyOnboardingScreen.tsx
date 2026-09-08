import React from 'react';
import { Building2, Mail, Phone, MapPin, User as UserIcon, FileText, CheckCircle2, AlertTriangle, ArrowLeft } from 'lucide-react';
import { useTranslation } from '../hooks';
import type { DatabaseState } from '../dbStore';
import warraqMark from '../assets/warraq-mark.svg';

interface CompanyOnboardingScreenProps {
  lang: 'en' | 'ar' | 'ur';
  onLangChange: (lang: 'en' | 'ar' | 'ur') => void;
  db: DatabaseState;
  // Leaves the ?onboard=1 pre-login screen back to the normal login screen.
  onBackToLogin: () => void;
}

const inputClass = "w-full bg-[#151E19]/70 border border-[#3A4A3E]/60 text-white rounded-xl pl-10 pr-4 py-3 focus:outline-none focus:ring-2 focus:ring-[#AD8636] focus:border-[#AD8636] transition-all text-sm shadow-inner placeholder-slate-600 font-medium";
const labelClass = "block text-[10px] font-bold text-[#D9B268] uppercase tracking-wider mb-1.5";
const iconWrapClass = "absolute inset-y-0 start-0 pl-3.5 flex items-center pointer-events-none text-slate-500 group-focus-within:text-[#D9B268] transition-colors";

export default function CompanyOnboardingScreen({ lang, onLangChange, db, onBackToLogin }: CompanyOnboardingScreenProps) {
  const { t, isRTL } = useTranslation(db, lang);
  const [form, setForm] = React.useState({
    companyName: '', companyEmail: '', companyPhone: '', companyAddress: '',
    vatNumber: '', crNumber: '',
    contactName: '', contactEmail: '', contactPhone: '', notes: '',
    website: '', // honeypot — real users never see or fill this field
  });
  const [submitting, setSubmitting] = React.useState(false);
  const [submitted, setSubmitted] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const update = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(prev => ({ ...prev, [field]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    if (!form.companyName.trim() || !form.companyEmail.trim() || !form.contactName.trim()) {
      setErrorMessage(t('Company name, company email, and contact name are required.'));
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/onboarding-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorMessage(data.error || t('Something went wrong. Please try again.'));
        return;
      }
      setSubmitted(true);
    } catch {
      setErrorMessage(t('Something went wrong. Please check your connection and try again.'));
    } finally {
      setSubmitting(false);
    }
  };

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

      <div className="w-full max-w-lg space-y-6 z-10">
        <div className="text-center space-y-2">
          {submitted ? (
            <div className="inline-flex p-3 bg-emerald-500/10 border border-emerald-500/25 rounded-2xl shadow-inner text-emerald-400">
              <CheckCircle2 className="w-8 h-8" />
            </div>
          ) : (
            <img src={warraqMark} alt="Warraq" className="w-16 h-16 mx-auto rounded-[18px] shadow-lg shadow-black/50" />
          )}
          <div>
            <h2 className="font-brand text-2xl font-semibold text-white tracking-tight">
              {submitted ? t('Request Received') : t('Set Up Your Company')}
            </h2>
            <p className="text-sm font-bold text-[#D9B268] tracking-wide mt-1">{t('Warraq ERP System')}</p>
          </div>
          <p className="text-xs text-slate-400 font-medium max-w-sm mx-auto">
            {submitted
              ? t('Thank you — your request has been received. We will be in touch shortly.')
              : t('Tell us about your company and we will set up your account. An administrator will review your request shortly.')}
          </p>
        </div>

        {submitted ? (
          <div className="p-8 bg-[#20291F]/80 backdrop-blur-xl border border-[#3A4A3E]/50 rounded-3xl shadow-2xl shadow-black/40 text-center">
            <button
              type="button"
              onClick={onBackToLogin}
              className="text-[11px] font-bold text-slate-400 hover:text-slate-200 transition-colors flex items-center justify-center gap-1.5 mx-auto"
            >
              <ArrowLeft className="w-3 h-3" /> {t('Back to Login')}
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4 p-8 bg-[#20291F]/80 backdrop-blur-xl border border-[#3A4A3E]/50 rounded-3xl shadow-2xl shadow-black/40 max-h-[75vh] overflow-y-auto">
            {/* Honeypot — hidden from real users via CSS, never shown; a bot filling every
                field trips this, a human never sees it exists. */}
            <div className="hidden" aria-hidden="true">
              <label htmlFor="website">Website</label>
              <input id="website" type="text" tabIndex={-1} autoComplete="off" value={form.website} onChange={update('website')} />
            </div>

            <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{t('Company Details')}</div>

            <div>
              <label className={labelClass}>{t('Company Name')}<span className="text-rose-500"> *</span></label>
              <div className="relative group">
                <div className={iconWrapClass}><Building2 className="w-4 h-4" /></div>
                <input type="text" required value={form.companyName} onChange={update('companyName')} className={inputClass} placeholder={t('e.g. Acme Trading LLC')} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>{t('Company Email')}<span className="text-rose-500"> *</span></label>
                <div className="relative group">
                  <div className={iconWrapClass}><Mail className="w-4 h-4" /></div>
                  <input type="email" required value={form.companyEmail} onChange={update('companyEmail')} className={inputClass} placeholder="billing@example.com" />
                </div>
              </div>
              <div>
                <label className={labelClass}>{t('Company Phone')}</label>
                <div className="relative group">
                  <div className={iconWrapClass}><Phone className="w-4 h-4" /></div>
                  <input type="text" value={form.companyPhone} onChange={update('companyPhone')} className={inputClass} placeholder="+966 5..." />
                </div>
              </div>
            </div>

            <div>
              <label className={labelClass}>{t('Company Address')}</label>
              <div className="relative group">
                <div className={iconWrapClass}><MapPin className="w-4 h-4" /></div>
                <input type="text" value={form.companyAddress} onChange={update('companyAddress')} className={inputClass} placeholder={t('Street, City, Postal Code')} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>{t('VAT Number')}</label>
                <input type="text" value={form.vatNumber} onChange={update('vatNumber')} className="w-full bg-[#151E19]/70 border border-[#3A4A3E]/60 text-white rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-[#AD8636] focus:border-[#AD8636] transition-all text-sm shadow-inner placeholder-slate-600 font-medium" placeholder="e.g. 300123456700003" />
              </div>
              <div>
                <label className={labelClass}>{t('CR Number')}</label>
                <input type="text" value={form.crNumber} onChange={update('crNumber')} className="w-full bg-[#151E19]/70 border border-[#3A4A3E]/60 text-white rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-[#AD8636] focus:border-[#AD8636] transition-all text-sm shadow-inner placeholder-slate-600 font-medium" placeholder="e.g. 1010000000" />
              </div>
            </div>

            <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest pt-2">{t('Your Contact Details')}</div>

            <div>
              <label className={labelClass}>{t('Your Name')}<span className="text-rose-500"> *</span></label>
              <div className="relative group">
                <div className={iconWrapClass}><UserIcon className="w-4 h-4" /></div>
                <input type="text" required value={form.contactName} onChange={update('contactName')} className={inputClass} placeholder={t('Full name')} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>{t('Your Email')} <span className="text-slate-500 normal-case font-normal">{t('(optional — defaults to company email)')}</span></label>
                <div className="relative group">
                  <div className={iconWrapClass}><Mail className="w-4 h-4" /></div>
                  <input type="email" value={form.contactEmail} onChange={update('contactEmail')} className={inputClass} placeholder="you@example.com" />
                </div>
              </div>
              <div>
                <label className={labelClass}>{t('Your Phone')}</label>
                <div className="relative group">
                  <div className={iconWrapClass}><Phone className="w-4 h-4" /></div>
                  <input type="text" value={form.contactPhone} onChange={update('contactPhone')} className={inputClass} placeholder="+966 5..." />
                </div>
              </div>
            </div>

            <div>
              <label className={labelClass}>{t('Notes')}</label>
              <div className="relative group">
                <div className="absolute top-3 start-0 pl-3.5 flex items-start pointer-events-none text-slate-500 group-focus-within:text-[#D9B268] transition-colors">
                  <FileText className="w-4 h-4" />
                </div>
                <textarea rows={2} value={form.notes} onChange={update('notes')} className={`${inputClass} resize-none`} placeholder={t('Anything else we should know?')} />
              </div>
            </div>

            {errorMessage && (
              <div className="p-3 bg-rose-950/40 border border-rose-900/50 rounded-xl flex items-start gap-2.5 animate-fade-in">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <p className="text-[11px] font-medium text-rose-300 leading-relaxed">{errorMessage}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full relative group overflow-hidden bg-[#AD8636] hover:bg-[#C4993F] disabled:opacity-50 disabled:cursor-not-allowed text-[#151E19] font-bold py-3.5 px-4 rounded-xl transition duration-200 shadow-xl shadow-black/30 active:scale-[0.98] outline-none mt-2"
            >
              <span className="relative z-10 flex items-center justify-center gap-2">
                <Building2 className="w-4 h-4" />
                {submitting ? t('SUBMITTING...') : t('SUBMIT REQUEST')}
              </span>
            </button>

            <button
              type="button"
              onClick={onBackToLogin}
              className="w-full text-center text-[11px] font-bold text-slate-400 hover:text-slate-200 transition-colors flex items-center justify-center gap-1.5 mt-1"
            >
              <ArrowLeft className="w-3 h-3" /> {t('Back to Login')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
