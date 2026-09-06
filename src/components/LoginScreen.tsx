import React from 'react';
import { User } from '../types';
import { Key, Lock, User as UserIcon, AlertTriangle, Mail, CheckCircle, ArrowLeft } from 'lucide-react';
import { useTranslation } from '../hooks';
import type { DatabaseState } from '../dbStore';
import warraqMark from '../assets/warraq-mark.svg';

interface LoginScreenProps {
 onLoginSuccess: (user: User) => void;
 // No db.currentUser exists yet at this screen, so language is a standalone pre-login
 // choice (persisted in App.tsx via localStorage) rather than the account preference.
 lang: 'en' | 'ar' | 'ur';
 onLangChange: (lang: 'en' | 'ar' | 'ur') => void;
 db: DatabaseState;
 // Navigates to the public company-onboarding form (?onboard=1) — see
 // src/components/CompanyOnboardingScreen.tsx and App.tsx's onGoToSignup handler.
 onGoToSignup: () => void;
}

export default function LoginScreen({
 onLoginSuccess,
 lang,
 onLangChange,
 db,
 onGoToSignup,
}: LoginScreenProps) {
 const { t, isRTL } = useTranslation(db, lang);
 const [usernameInput, setUsernameInput] = React.useState('');
 const [passwordInput, setPasswordInput] = React.useState('');
 const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

 // Forgot-password sub-view — a small state machine within the same screen rather than
 // a separate route, since there's nothing else to navigate away to pre-login.
 const [showForgotPassword, setShowForgotPassword] = React.useState(false);
 const [forgotUsername, setForgotUsername] = React.useState('');
 const [forgotSubmitting, setForgotSubmitting] = React.useState(false);
 const [forgotResultMessage, setForgotResultMessage] = React.useState<{ type: 'success' | 'error'; text: string } | null>(null);

 const handleForgotPassword = async (e: React.FormEvent) => {
 e.preventDefault();
 setForgotResultMessage(null);
 if (!forgotUsername.trim()) {
 setForgotResultMessage({ type: 'error', text: t('Enter your username first.') });
 return;
 }
 setForgotSubmitting(true);
 try {
 const response = await fetch('/api/auth/forgot-password', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ username: forgotUsername.trim() }),
 });
 const data = await response.json().catch(() => ({}));
 if (response.ok) {
 setForgotResultMessage({ type: 'success', text: data.message || t('If that account exists and has an email on file, a password reset link has been sent to it.') });
 } else {
 setForgotResultMessage({ type: 'error', text: data.error || t('Failed to request a password reset.') });
 }
 } catch (err) {
 setForgotResultMessage({ type: 'error', text: t('Failed to request a password reset. Please try again.') });
 } finally {
 setForgotSubmitting(false);
 }
 };

 const handleLogin = async (e: React.FormEvent) => {
 e.preventDefault();
 setErrorMessage(null);

 const enteredUser = usernameInput.trim();
 const enteredPass = passwordInput.trim();

 if (!enteredUser || !enteredPass) {
 setErrorMessage(t('Username and Password are required.'));
 return;
 }

 try {
 const response = await fetch('/api/login', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ username: enteredUser, password: enteredPass }),
 });

 if (response.ok) {
 const data = await response.json();
 if (data && data.user) {
 if (data.sessionId) {
 localStorage.setItem('erp_session_id', data.sessionId);
 }
 onLoginSuccess(data.user);
 } else {
 window.location.reload();
 }
 } else {
 const data = await response.json();
 setErrorMessage(data.error || t('Invalid credentials'));
 }
 } catch (err) {
 setErrorMessage(t('Login failed. Please try again.'));
 }
 };


 return (
    <div id="login-container" dir={isRTL ? 'rtl' : 'ltr'} className="min-h-screen bg-[#151E19] flex flex-col justify-center items-center p-4 relative overflow-hidden font-sans selection:bg-[#AD8636] selection:text-[#151E19]">
      {/* Decorative background grid and ambient glows */}
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
          {showForgotPassword ? (
            <div className="inline-flex p-3 bg-[#AD8636]/10 border border-[#AD8636]/25 rounded-2xl shadow-inner text-[#D9B268]">
              <Mail className="w-8 h-8" />
            </div>
          ) : (
            <img src={warraqMark} alt="Warraq" className="w-16 h-16 mx-auto rounded-[18px] shadow-lg shadow-black/50" />
          )}
          {showForgotPassword ? (
            <h2 className="text-xl font-black text-white tracking-widest uppercase">{t('Reset Your Password')}</h2>
          ) : (
            <div>
              <h2 className="font-brand text-3xl font-semibold text-white tracking-tight">{t('Warraq ERP System')}</h2>
              <p className="text-sm font-bold text-[#D9B268] tracking-wide mt-1">{t('ZATCA Integrated Invoicing Solution')}</p>
            </div>
          )}
          <p className="text-xs text-slate-400 font-medium max-w-xs mx-auto">
            {showForgotPassword
              ? t('Enter your username and, if your account has an email on file, we\'ll send a reset link to it.')
              : t('Authorized personnel login. Dynamic corporate boundaries and RBAC validation enforced.')}
          </p>
        </div>

        {showForgotPassword ? (
          <form onSubmit={handleForgotPassword} className="space-y-4 p-8 bg-[#20291F]/80 backdrop-blur-xl border border-[#3A4A3E]/50 rounded-3xl shadow-2xl shadow-black/40">
            <div>
              <label className="block text-[10px] font-bold text-[#D9B268] uppercase tracking-wider mb-1.5">{t('Username')}</label>
              <div className="relative group">
                <div className="absolute inset-y-0 start-0 pl-3.5 flex items-center pointer-events-none text-slate-500 group-focus-within:text-[#D9B268] transition-colors">
                  <UserIcon className="w-4 h-4" />
                </div>
                <input
                  type="text"
                  value={forgotUsername}
                  onChange={(e) => setForgotUsername(e.target.value)}
                  className="w-full bg-[#151E19]/70 border border-[#3A4A3E]/60 text-white rounded-xl pl-10 pr-4 py-3 focus:outline-none focus:ring-2 focus:ring-[#AD8636] focus:border-[#AD8636] transition-all text-sm shadow-inner placeholder-slate-600 font-medium"
                  placeholder={t('Your username')}
                  autoComplete="username"
                />
              </div>
            </div>

            {forgotResultMessage && (
              <div className={`p-3 rounded-xl flex items-start gap-2.5 animate-fade-in border ${
                forgotResultMessage.type === 'success' ? 'bg-emerald-950/40 border-emerald-900/50' : 'bg-rose-950/40 border-rose-900/50'
              }`}>
                {forgotResultMessage.type === 'success'
                  ? <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  : <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />}
                <p className={`text-[11px] font-medium leading-relaxed ${forgotResultMessage.type === 'success' ? 'text-emerald-300' : 'text-rose-300'}`}>
                  {forgotResultMessage.text}
                </p>
              </div>
            )}

            <button
              type="submit"
              disabled={forgotSubmitting}
              className="w-full relative group overflow-hidden bg-[#AD8636] hover:bg-[#C4993F] disabled:opacity-50 disabled:cursor-not-allowed text-[#151E19] font-bold py-3.5 px-4 rounded-xl transition duration-200 shadow-xl shadow-black/30 active:scale-[0.98] outline-none mt-2"
            >
              <span className="relative z-10 flex items-center justify-center gap-2">
                <Mail className="w-4 h-4" />
                {forgotSubmitting ? t('SENDING...') : t('SEND RESET LINK')}
              </span>
            </button>

            <button
              type="button"
              onClick={() => { setShowForgotPassword(false); setForgotResultMessage(null); setForgotUsername(''); }}
              className="w-full text-center text-[11px] font-bold text-slate-400 hover:text-slate-200 transition-colors flex items-center justify-center gap-1.5 mt-2"
            >
              <ArrowLeft className="w-3 h-3" /> {t('Back to Login')}
            </button>
          </form>
        ) : (
        <form onSubmit={handleLogin} className="space-y-4 p-8 bg-[#20291F]/80 backdrop-blur-xl border border-[#3A4A3E]/50 rounded-3xl shadow-2xl shadow-black/40">

          <div className="space-y-4">
            <div>
              <label className="block text-[10px] font-bold text-[#D9B268] uppercase tracking-wider mb-1.5">{t('User Identity')}</label>
              <div className="relative group">
                <div className="absolute inset-y-0 start-0 pl-3.5 flex items-center pointer-events-none text-slate-500 group-focus-within:text-[#D9B268] transition-colors">
                  <UserIcon className="w-4 h-4" />
                </div>
                <input
                  type="text"
                  value={usernameInput}
                  onChange={(e) => setUsernameInput(e.target.value)}
                  className="w-full bg-[#151E19]/70 border border-[#3A4A3E]/60 text-white rounded-xl pl-10 pr-4 py-3 focus:outline-none focus:ring-2 focus:ring-[#AD8636] focus:border-[#AD8636] transition-all text-sm shadow-inner placeholder-slate-600 font-medium"
                  placeholder={t('Username or Account ID')}
                  autoComplete="username"
                />
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-bold text-[#D9B268] uppercase tracking-wider mb-1.5">{t('Security Key')}</label>
              <div className="relative group">
                <div className="absolute inset-y-0 start-0 pl-3.5 flex items-center pointer-events-none text-slate-500 group-focus-within:text-[#D9B268] transition-colors">
                  <Lock className="w-4 h-4" />
                </div>
                <input
                  type="password"
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  className="w-full bg-[#151E19]/70 border border-[#3A4A3E]/60 text-white rounded-xl pl-10 pr-4 py-3 focus:outline-none focus:ring-2 focus:ring-[#AD8636] focus:border-[#AD8636] transition-all text-sm shadow-inner placeholder-slate-600 font-medium tracking-widest"
                  placeholder="••••••••"
                  autoComplete="current-password"
                />
              </div>
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
            className="w-full relative group overflow-hidden bg-[#AD8636] hover:bg-[#C4993F] text-[#151E19] font-bold py-3.5 px-4 rounded-xl transition duration-200 shadow-xl shadow-black/30 active:scale-[0.98] outline-none mt-4"
          >
            <span className="relative z-10 flex items-center justify-center gap-2">
              <Key className="w-4 h-4" />
              {t('AUTHENTICATE SESSION')}
            </span>
          </button>

          <button
            type="button"
            onClick={() => { setShowForgotPassword(true); setErrorMessage(null); }}
            className="w-full text-center text-[11px] font-bold text-slate-400 hover:text-slate-200 transition-colors mt-1"
          >
            {t('Forgot password?')}
          </button>

          <div className="pt-3 mt-1 border-t border-[#3A4A3E]/50 text-center">
            <span className="text-[11px] text-slate-500">{t('New here?')} </span>
            <button
              type="button"
              onClick={onGoToSignup}
              className="text-[11px] font-bold text-[#D9B268] hover:text-[#C4993F] transition-colors"
            >
              {t('Sign up your company')}
            </button>
          </div>
        </form>
        )}
      </div>
    </div>
  );
}
