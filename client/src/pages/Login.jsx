import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { Button, Card, ErrorBanner, Input } from '../components/ui';
import logoColor from '../assets/brand/solidpro_logo_color.png';
import markColor from '../assets/brand/solidpro_mark_color.png';

/** A small ambient scene of floating "task card" shapes for the sign-in hero panel — each drifts on its
 *  own float cycle (animate-float, staggered duration/delay) so the panel reads as alive rather than a
 *  static gradient with a logo watermark. Kept low-opacity/line-art so the headline stays the focal
 *  point; the one solid accent is the small checkmark badge, echoing the app's core "get things done"
 *  purpose right on the sign-in screen. */
function LoginHeroIllustration() {
  return (
    <svg viewBox="0 0 420 420" className="absolute -right-6 -bottom-10 w-[30rem] h-[30rem] pointer-events-none select-none" aria-hidden="true">
      <g className="animate-float" style={{ animationDuration: '9s' }}>
        <rect x="190" y="60" width="150" height="100" rx="14" fill="white" opacity="0.06" />
        <line x1="212" y1="90" x2="300" y2="90" stroke="white" strokeWidth="3" strokeLinecap="round" opacity="0.18" />
        <line x1="212" y1="106" x2="290" y2="106" stroke="white" strokeWidth="3" strokeLinecap="round" opacity="0.14" />
        <line x1="212" y1="122" x2="270" y2="122" stroke="white" strokeWidth="3" strokeLinecap="round" opacity="0.14" />
      </g>
      <g className="animate-float" style={{ animationDuration: '7s', animationDelay: '1s' }}>
        <rect x="230" y="210" width="130" height="90" rx="14" fill="white" opacity="0.05" />
        <circle cx="256" cy="238" r="8" fill="none" stroke="white" strokeWidth="3" opacity="0.2" />
        <line x1="276" y1="238" x2="335" y2="238" stroke="white" strokeWidth="3" strokeLinecap="round" opacity="0.16" />
        <circle cx="256" cy="264" r="8" fill="none" stroke="white" strokeWidth="3" opacity="0.2" />
        <line x1="276" y1="264" x2="320" y2="264" stroke="white" strokeWidth="3" strokeLinecap="round" opacity="0.16" />
      </g>
      <g className="animate-float" style={{ animationDuration: '6s', animationDelay: '2.2s' }}>
        <circle cx="140" cy="300" r="34" fill="var(--color-accent-500)" opacity="0.9" />
        <path d="M127 300l9 9 18-19" stroke="white" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </g>
      <circle cx="330" cy="330" r="4" fill="white" opacity="0.25" />
      <circle cx="110" cy="130" r="3" fill="white" opacity="0.2" />
      <circle cx="360" cy="200" r="3" fill="white" opacity="0.2" />
    </svg>
  );
}

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(
    searchParams.get('password_changed')
      ? 'Your password was changed — sign in with your new password.'
      : searchParams.get('expired') ? 'Your session expired — please sign in again.' : ''
  );
  const [busy, setBusy] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex bg-grey-50">
      {/* Brand panel — deep blue with the icon mark as a ghost watermark, per the letterhead treatment in the brand manual. */}
      <div className="hidden lg:flex lg:w-1/2 relative overflow-hidden bg-gradient-to-br from-brand-700 via-brand-800 to-brand-950 items-center justify-center p-12">
        <img
          src={markColor}
          alt=""
          aria-hidden="true"
          className="absolute -right-24 -bottom-24 w-[32rem] h-[32rem] opacity-[0.10] select-none"
          draggable={false}
        />
        <LoginHeroIllustration />
        <div className="relative z-10 max-w-md animate-fade-in-up">
          <div className="inline-flex items-center gap-2 text-accent-400 text-xs font-bold tracking-[0.2em] mb-6 uppercase">
            <span className="w-6 h-px bg-accent-400" /> Daily Scrum Monitoring
          </div>
          <h1 className="text-4xl font-bold text-white leading-tight mb-4">
            Every day's work,<br />in one clear place.
          </h1>
          <p className="text-brand-100 text-sm leading-relaxed mb-8">
            Log your commitments, see what's overdue, and keep your leader in the loop —
            without a single spoken standup.
          </p>
          <p className="text-white/60 text-xs font-semibold tracking-[0.25em] uppercase">Place for possibilities</p>
        </div>
      </div>

      {/* Sign-in panel */}
      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm animate-fade-in-up">
          <div className="text-center mb-8">
            <img src={logoColor} alt="Solidpro" className="h-10 w-auto mx-auto mb-6 select-none" draggable={false} />
            <h2 className="text-xl font-bold text-grey-900">Welcome back</h2>
            <p className="text-grey-500 text-sm mt-1">Sign in to tell your leader what's going on today.</p>
          </div>
          <Card className="shadow-lg shadow-grey-900/[0.06]">
            <form onSubmit={onSubmit} className="space-y-4">
              <Input label="Email" type="email" name="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required autoFocus />
              <Input label="Password" type="password" name="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              <ErrorBanner message={error} />
              <Button type="submit" className="w-full" disabled={busy}>
                {busy && <span className="w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" />}
                {busy ? 'Signing in…' : 'Sign In'}
              </Button>
            </form>
          </Card>
          <p className="text-center text-xs text-grey-400 mt-5">Accounts are created by your Admin or Super Admin.</p>
        </div>
      </div>
    </div>
  );
}
