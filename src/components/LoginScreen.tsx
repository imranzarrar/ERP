import React from 'react';
import { User } from '../types';
import { Key, Lock, Shield, User as UserIcon, AlertTriangle } from 'lucide-react';


interface LoginScreenProps {
 onLoginSuccess: (user: User) => void;
}

export default function LoginScreen({ 
 onLoginSuccess,
}: LoginScreenProps) {
 const [usernameInput, setUsernameInput] = React.useState('');
 const [passwordInput, setPasswordInput] = React.useState('');
 const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

 const handleLogin = async (e: React.FormEvent) => {
 e.preventDefault();
 setErrorMessage(null);

 const enteredUser = usernameInput.trim();
 const enteredPass = passwordInput.trim();

 if (!enteredUser || !enteredPass) {
 setErrorMessage('Username and Password are required.');
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
 setErrorMessage(data.error || 'Invalid credentials');
 }
 } catch (err) {
 setErrorMessage('Login failed. Please try again.');
 }
 };


 return (
    <div id="login-container" className="min-h-screen bg-indigo-950 flex flex-col justify-center items-center p-4 relative overflow-hidden font-sans selection:bg-indigo-600 selection:text-white">
      {/* Decorative background grid and ambient glows */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.05)_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_50%,#000_70%,transparent_100%)] opacity-60"></div>
      
      <div className="w-full max-w-md space-y-6 z-10">
        <div className="text-center space-y-2">
          <div className="inline-flex p-3 bg-indigo-900/30 border border-indigo-500/20 rounded-2xl shadow-inner text-indigo-400">
            <Shield className="w-8 h-8 animate-pulse" />
          </div>
          <h2 className="text-xl font-black text-white tracking-widest uppercase">
            INDUSTRIAL ERP PORTAL
          </h2>
          <p className="text-xs text-slate-400 font-medium max-w-xs mx-auto">
            Authorized personnel login. Dynamic corporate boundaries and RBAC validation enforced.
          </p>
        </div>

        <form onSubmit={handleLogin} className="space-y-4 p-8 bg-indigo-950/80 backdrop-blur-xl border border-indigo-900/50 rounded-3xl shadow-2xl shadow-indigo-950/50">
          
          <div className="space-y-4">
            <div>
              <label className="block text-[10px] font-bold text-indigo-300 uppercase tracking-wider mb-1.5">User Identity</label>
              <div className="relative group">
                <div className="absolute inset-y-0 start-0 pl-3.5 flex items-center pointer-events-none text-slate-500 group-focus-within:text-indigo-400 transition-colors">
                  <UserIcon className="w-4 h-4" />
                </div>
                <input
                  type="text"
                  value={usernameInput}
                  onChange={(e) => setUsernameInput(e.target.value)}
                  className="w-full bg-indigo-950/50 border border-indigo-900/80 text-white rounded-xl pl-10 pr-4 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all text-sm shadow-inner placeholder-slate-600 font-medium"
                  placeholder="Username or Account ID"
                  autoComplete="username"
                />
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-bold text-indigo-300 uppercase tracking-wider mb-1.5">Security Key</label>
              <div className="relative group">
                <div className="absolute inset-y-0 start-0 pl-3.5 flex items-center pointer-events-none text-slate-500 group-focus-within:text-indigo-400 transition-colors">
                  <Lock className="w-4 h-4" />
                </div>
                <input
                  type="password"
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  className="w-full bg-indigo-950/50 border border-indigo-900/80 text-white rounded-xl pl-10 pr-4 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all text-sm shadow-inner placeholder-slate-600 font-medium tracking-widest"
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
            className="w-full relative group overflow-hidden bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-3.5 px-4 rounded-xl transition duration-200 shadow-xl shadow-indigo-900/20 active:scale-[0.98] outline-none mt-4"
          >
            <span className="relative z-10 flex items-center justify-center gap-2">
              <Key className="w-4 h-4" />
              AUTHENTICATE SESSION
            </span>
          </button>
        </form>
      </div>
    </div>
  );
}
