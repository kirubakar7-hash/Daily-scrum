import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';

/* ---------------------------------------------------------------------------
 * Solidpro design system — shared primitives.
 * Brand: Primary Blue #16469D (--color-brand-*), Secondary Red #E01A22 (--color-accent-*),
 * Tertiary Grey #939597 (--color-grey-*). Keep the 70/20/10 balance: blue dominates chrome
 * and structure, red is reserved for alerts/important actions, grey supports.
 * ------------------------------------------------------------------------- */

export function Card({ children, className = '', interactive = false, dense = false, onClick, ...props }) {
  // A card that's clickable but has no <a>/<Link> wrapper (see KpiCard's onClick-without-to branch)
  // still needs to be reachable and activatable from a keyboard, not just a mouse.
  const keyboardProps = interactive && onClick
    ? { role: 'button', tabIndex: 0, onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); } } }
    : {};
  return (
    <div
      className={`bg-white rounded-2xl border border-grey-100 shadow-sm shadow-grey-900/[0.04] ${interactive ? 'transition-all duration-200 hover:shadow-lg hover:shadow-brand-900/[0.08] hover:border-brand-200 hover:-translate-y-0.5 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500' : ''} ${dense ? 'p-3.5' : 'p-5'} ${className}`}
      onClick={onClick}
      {...keyboardProps}
      {...props}
    >
      {children}
    </div>
  );
}

/** A popout dialog for "Create X" / "Add X" forms, so they float above the page instead of pushing
 *  content around inline. Closes on backdrop click, the X button, or Escape. Content is unmounted while
 *  closed (a form's own state resets each time it's reopened, matching how the inline forms behaved).
 *
 *  Rendered via a portal straight onto document.body — NOT in place in the component tree. `position:
 *  fixed` anchors to the nearest ancestor with a CSS transform, not necessarily the real viewport, and
 *  this app's own `animate-fade-in-up`/`animate-scale-in` classes leave a lingering `transform` on the
 *  element after they finish (animation-fill-mode: both). Almost every page section uses one of those
 *  classes, so without the portal the modal gets trapped inside whichever animated container it's
 *  nested in instead of covering the screen. */
/** Exit animation matches the 180ms .animate-fade-out/.animate-scale-out duration in index.css — keep
 *  them in sync if either changes. Content keeps rendering during the close animation (rather than
 *  vanishing on the same frame `open` flips false) so the panel and backdrop can play their reverse
 *  transition before actually leaving the DOM. */
const MODAL_CLOSE_MS = 180;

let modalTitleCount = 0;

export function Modal({ open, onClose, title, children, wide = false }) {
  const [rendered, setRendered] = useState(open);
  const [closing, setClosing] = useState(false);
  const dialogRef = useRef(null);
  const titleIdRef = useRef(null);
  const previouslyFocused = useRef(null);
  if (!titleIdRef.current) titleIdRef.current = `modal-title-${++modalTitleCount}`;

  useEffect(() => {
    if (open) { setRendered(true); setClosing(false); }
    else if (rendered) {
      setClosing(true);
      const t = setTimeout(() => { setRendered(false); setClosing(false); }, MODAL_CLOSE_MS);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!rendered) return;
    function onKey(e) {
      if (e.key === 'Escape') { onClose(); return; }
      // A basic focus trap: Tab/Shift+Tab cycles only among elements inside the dialog, instead of
      // escaping into the page behind it.
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [rendered, onClose]);

  // Move focus into the dialog on open, and back to whatever triggered it on close, so a keyboard user
  // isn't left wherever they were on the page behind an open (or just-closed) modal.
  useEffect(() => {
    if (open && rendered) {
      previouslyFocused.current = document.activeElement;
      const t = setTimeout(() => {
        const focusable = dialogRef.current?.querySelector('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])');
        (focusable || dialogRef.current)?.focus();
      }, 0);
      return () => clearTimeout(t);
    }
    if (!open && previouslyFocused.current) {
      previouslyFocused.current.focus?.();
      previouslyFocused.current = null;
    }
  }, [open, rendered]);

  if (!rendered) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className={`fixed inset-0 bg-grey-900/50 ${closing ? 'animate-fade-out' : 'animate-fade-in-up'}`} />
      <div
        ref={dialogRef}
        className={`relative bg-white rounded-2xl border border-grey-100 shadow-xl shadow-grey-900/20 w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} my-6 sm:my-10 max-h-[85vh] flex flex-col ${closing ? 'animate-scale-out' : 'animate-scale-in'}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleIdRef.current}
        tabIndex={-1}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-grey-100 shrink-0">
          <h2 id={titleIdRef.current} className="font-bold text-grey-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-8 h-8 rounded-full flex items-center justify-center text-grey-400 hover:text-grey-700 hover:bg-grey-100 transition-colors shrink-0 press-scale"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body
  );
}

export function Button({ children, variant = 'primary', size = 'md', className = '', ...props }) {
  const base = 'inline-flex items-center justify-center gap-1.5 font-semibold rounded-xl transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97] whitespace-nowrap';
  const sizes = {
    sm: 'px-3 py-1.5 text-xs',
    md: 'px-4 py-2.5 sm:py-2 text-sm min-h-[44px] sm:min-h-0',
    lg: 'px-6 py-3 text-base',
  };
  const variants = {
    primary: 'bg-brand-600 text-white shadow-sm shadow-brand-600/25 hover:bg-brand-700 hover:shadow-md hover:shadow-brand-600/30',
    secondary: 'bg-white text-grey-800 border border-grey-200 hover:border-brand-300 hover:text-brand-700 hover:bg-brand-50',
    danger: 'bg-accent-600 text-white shadow-sm shadow-accent-600/25 hover:bg-accent-700 hover:shadow-md hover:shadow-accent-600/30',
    ghost: 'text-brand-600 hover:bg-brand-50',
  };
  return (
    <button className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
}

/** A small red asterisk next to a field's label — the app's one visual marker for "this must be filled
 *  in", so a person finds out before clicking Save/Add instead of only from an error message after. */
function RequiredMark({ required }) {
  if (!required) return null;
  return <span className="text-accent-600" aria-hidden="true"> *</span>;
}

export function Input({ label, className = '', required, ...props }) {
  return (
    <label className="block">
      {label && <span className="block text-sm font-medium text-grey-700 mb-1">{label}<RequiredMark required={required} /></span>}
      <input
        required={required}
        className={`w-full rounded-xl border border-grey-300 px-3 py-2 text-sm text-grey-900 transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 ${className}`}
        {...props}
      />
    </label>
  );
}

export function Textarea({ label, className = '', required, ...props }) {
  return (
    <label className="block">
      {label && <span className="block text-sm font-medium text-grey-700 mb-1">{label}<RequiredMark required={required} /></span>}
      <textarea
        required={required}
        className={`w-full rounded-xl border border-grey-300 px-3 py-2 text-sm text-grey-900 transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 ${className}`}
        rows={3}
        {...props}
      />
    </label>
  );
}

export function Select({ label, children, className = '', required, ...props }) {
  return (
    <label className="block">
      {label && <span className="block text-sm font-medium text-grey-700 mb-1">{label}<RequiredMark required={required} /></span>}
      <select
        required={required}
        className={`w-full rounded-xl border border-grey-300 px-3 py-2 text-sm text-grey-900 bg-white transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 ${className}`}
        {...props}
      >
        {children}
      </select>
    </label>
  );
}

/* Status/type badges. Brand red carries real semantic weight here (danger/urgent), matching the
 * brief's "Red for important alerts". Success stays conventional emerald for at-a-glance clarity. */
const badgeColors = {
  completed: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20',
  resolved: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20',
  support_required: 'bg-accent-50 text-accent-700 ring-1 ring-accent-600/20',
  open: 'bg-accent-50 text-accent-700 ring-1 ring-accent-600/20',
  pending: 'bg-grey-100 text-grey-700 ring-1 ring-grey-500/15',
  in_progress: 'bg-brand-50 text-brand-700 ring-1 ring-brand-600/20',
  recurring: 'bg-brand-50 text-brand-700 ring-1 ring-brand-600/20',
  adhoc: 'bg-grey-100 text-grey-700 ring-1 ring-grey-500/15',
  approved: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20',
  rejected: 'bg-accent-50 text-accent-700 ring-1 ring-accent-600/20',
  support: 'bg-accent-50 text-accent-700 ring-1 ring-accent-600/20',
  due_date_change: 'bg-brand-50 text-brand-700 ring-1 ring-brand-600/20',
  High: 'bg-accent-50 text-accent-700 ring-1 ring-accent-600/20',
  Medium: 'bg-amber-50 text-amber-700 ring-1 ring-amber-600/20',
  Low: 'bg-grey-100 text-grey-700 ring-1 ring-grey-500/15',
};

export function Badge({ children, tone }) {
  const cls = badgeColors[tone] || badgeColors[children] || 'bg-grey-100 text-grey-700 ring-1 ring-grey-500/15';
  return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${cls}`}>{humanize(children)}</span>;
}

export function humanize(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function friendlyMessage(message) {
  const looksTechnical = /error|failed to fetch|network|undefined|typeerror|stack|500|fetch/i.test(message) && !/^(please|we need|incorrect|not permitted|not logged in|a user with|team name|invalid role|only a super admin|the designated super admin|your role has|you don't have permission|session expired|password must)/i.test(message);
  if (looksTechnical) {
    return "We couldn't save this information. Your entered information hasn't been lost — please try again.";
  }
  return message;
}

export function ErrorBanner({ message }) {
  if (!message) return null;
  return (
    <div className="flex items-start gap-2 bg-accent-50 text-accent-800 border border-accent-200 rounded-xl px-4 py-2.5 text-sm animate-fade-in-up">
      <svg className="w-4 h-4 mt-0.5 shrink-0" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l6.28 11.164c.75 1.334-.213 2.987-1.744 2.987H3.72c-1.53 0-2.494-1.653-1.744-2.987L8.257 3.1zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-.25-5.75a.75.75 0 00-1.5 0v2.5a.75.75 0 001.5 0v-2.5z" clipRule="evenodd" /></svg>
      <span>{friendlyMessage(message)}</span>
    </div>
  );
}

/** Inline "Delete" link that requires a second click to confirm — never fires on a single click. */
export function DeleteButton({ label = 'Delete', confirmLabel = 'Confirm?', onConfirm, disabled }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (disabled) return null;

  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} className="text-xs font-medium text-accent-600 hover:text-accent-800 transition-colors">
        {label}
      </button>
    );
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <span className="inline-flex items-center gap-2">
        <span className="text-xs text-accent-700">{confirmLabel}</span>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await onConfirm();
              setConfirming(false);
            } catch (e) {
              setError(e?.message || 'Something went wrong. Please try again.');
            } finally {
              setBusy(false);
            }
          }}
          className="text-xs font-semibold text-accent-600 hover:text-accent-800"
        >
          {busy ? 'Deleting…' : 'Yes, delete'}
        </button>
        <button type="button" onClick={() => { setConfirming(false); setError(''); }} className="text-xs text-grey-500 hover:text-grey-700">
          Cancel
        </button>
      </span>
      {error && <span className="text-xs text-accent-600">{error}</span>}
    </span>
  );
}

export function EmptyState({ children, icon, title, action }) {
  return (
    <div className="text-center py-10 px-4 animate-fade-in-up">
      {icon && <div className="mb-2 opacity-90">{icon}</div>}
      {title && <div className="text-sm font-semibold text-grey-700 mb-1">{title}</div>}
      <div className="text-grey-500 text-sm max-w-sm mx-auto">{children}</div>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Small on-brand illustrations for empty/success states — plain inline SVG line
 * art (no image assets, no icon library) so they stay tiny and themeable via the
 * same brand/accent/grey tokens as everything else. Each is deliberately reused
 * across every call site that shares its meaning (e.g. one "all clear" graphic
 * for every "nothing needs attention" moment) rather than drawing a new one per
 * screen — a shared visual vocabulary reads as more intentional than a pile of
 * one-off icons, and it's far less to maintain.
 * ------------------------------------------------------------------------- */

/** "Nothing outstanding / all caught up" — a celebratory badge+check. Pair with <Confetti /> for the
 *  single biggest completion moments (e.g. confirming the daily scrum); plain on its own for smaller
 *  recurring "all clear" spots so it doesn't feel like the same fanfare every time. */
export function IllustrationSuccess({ className = 'w-16 h-16' }) {
  return (
    <svg viewBox="0 0 120 120" className={className} fill="none" aria-hidden="true">
      <circle cx="60" cy="62" r="34" fill="var(--color-emerald-50, #ecfdf5)" />
      <circle cx="60" cy="62" r="34" stroke="#10b981" strokeWidth="3" strokeDasharray="4 6" opacity="0.5" />
      <path d="M45 62l10 10 20-22" stroke="#10b981" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="22" cy="32" r="4" fill="var(--color-brand-400)" />
      <circle cx="98" cy="40" r="3" fill="var(--color-accent-400)" />
      <circle cx="90" cy="94" r="4" fill="var(--color-brand-300)" />
      <circle cx="18" cy="86" r="3" fill="var(--color-accent-300)" />
    </svg>
  );
}

/** "Nothing here yet" — a blank checklist. The most common empty state: an empty task/history list. */
export function IllustrationEmptyList({ className = 'w-16 h-16' }) {
  return (
    <svg viewBox="0 0 120 120" className={className} fill="none" aria-hidden="true">
      <rect x="34" y="18" width="52" height="88" rx="8" fill="var(--color-grey-50)" stroke="var(--color-grey-200)" strokeWidth="2" />
      <rect x="46" y="12" width="28" height="14" rx="4" fill="var(--color-brand-100)" stroke="var(--color-brand-300)" strokeWidth="2" />
      <line x1="46" y1="46" x2="74" y2="46" stroke="var(--color-grey-300)" strokeWidth="3" strokeLinecap="round" strokeDasharray="1 7" />
      <line x1="46" y1="62" x2="74" y2="62" stroke="var(--color-grey-300)" strokeWidth="3" strokeLinecap="round" strokeDasharray="1 7" />
      <line x1="46" y1="78" x2="66" y2="78" stroke="var(--color-grey-300)" strokeWidth="3" strokeLinecap="round" strokeDasharray="1 7" />
    </svg>
  );
}

/** "No teams / people linked yet" — a few unconnected people nodes, waiting to be grouped. */
export function IllustrationTeam({ className = 'w-16 h-16' }) {
  return (
    <svg viewBox="0 0 120 120" className={className} fill="none" aria-hidden="true">
      <line x1="60" y1="48" x2="34" y2="80" stroke="var(--color-grey-300)" strokeWidth="2" strokeDasharray="1 6" strokeLinecap="round" />
      <line x1="60" y1="48" x2="86" y2="80" stroke="var(--color-grey-300)" strokeWidth="2" strokeDasharray="1 6" strokeLinecap="round" />
      <line x1="34" y1="80" x2="86" y2="80" stroke="var(--color-grey-300)" strokeWidth="2" strokeDasharray="1 6" strokeLinecap="round" />
      <g>
        <circle cx="60" cy="34" r="14" fill="var(--color-brand-100)" stroke="var(--color-brand-400)" strokeWidth="2.5" />
        <circle cx="60" cy="30" r="4.5" fill="var(--color-brand-500)" />
        <path d="M52 40q8-6 16 0" stroke="var(--color-brand-500)" strokeWidth="2.5" strokeLinecap="round" fill="none" />
      </g>
      <g>
        <circle cx="34" cy="88" r="12" fill="var(--color-grey-100)" stroke="var(--color-grey-300)" strokeWidth="2.5" />
        <circle cx="34" cy="85" r="3.8" fill="var(--color-grey-400)" />
        <path d="M27 93q7-5 14 0" stroke="var(--color-grey-400)" strokeWidth="2.5" strokeLinecap="round" fill="none" />
      </g>
      <g>
        <circle cx="86" cy="88" r="12" fill="var(--color-grey-100)" stroke="var(--color-grey-300)" strokeWidth="2.5" />
        <circle cx="86" cy="85" r="3.8" fill="var(--color-grey-400)" />
        <path d="M79 93q7-5 14 0" stroke="var(--color-grey-400)" strokeWidth="2.5" strokeLinecap="round" fill="none" />
      </g>
    </svg>
  );
}

/** "Search / find something" — a magnifying glass over a short list, for prompt and no-match states. */
export function IllustrationSearch({ className = 'w-16 h-16' }) {
  return (
    <svg viewBox="0 0 120 120" className={className} fill="none" aria-hidden="true">
      <rect x="26" y="26" width="50" height="62" rx="7" fill="var(--color-grey-50)" stroke="var(--color-grey-200)" strokeWidth="2" />
      <line x1="36" y1="44" x2="66" y2="44" stroke="var(--color-grey-300)" strokeWidth="3" strokeLinecap="round" />
      <line x1="36" y1="58" x2="66" y2="58" stroke="var(--color-grey-300)" strokeWidth="3" strokeLinecap="round" />
      <line x1="36" y1="72" x2="54" y2="72" stroke="var(--color-grey-300)" strokeWidth="3" strokeLinecap="round" />
      <circle cx="76" cy="76" r="17" fill="white" stroke="var(--color-brand-500)" strokeWidth="4" />
      <line x1="88" y1="88" x2="99" y2="99" stroke="var(--color-brand-500)" strokeWidth="4.5" strokeLinecap="round" />
    </svg>
  );
}

/** A brief burst of small dots for the app's single biggest "done!" moments — confirming the daily
 *  scrum. Deliberately not looping/persistent (fires once via .animate-confetti, ~0.7s) and skipped
 *  entirely under prefers-reduced-motion (see index.css). Positions/colors are fixed, not random, so
 *  the effect is identical on every render instead of jittering between mounts. */
const CONFETTI_DOTS = [
  { tx: -38, ty: -46, delay: 0, color: 'var(--color-brand-500)' },
  { tx: 34, ty: -50, delay: 40, color: 'var(--color-accent-500)' },
  { tx: -50, ty: -10, delay: 80, color: 'var(--color-amber-400, #fbbf24)' },
  { tx: 48, ty: -14, delay: 60, color: 'var(--color-brand-400)' },
  { tx: -18, ty: -58, delay: 120, color: 'var(--color-accent-400)' },
  { tx: 16, ty: -60, delay: 20, color: 'var(--color-emerald-500, #10b981)' },
  { tx: -44, ty: -30, delay: 100, color: 'var(--color-emerald-400, #34d399)' },
  { tx: 44, ty: -34, delay: 140, color: 'var(--color-brand-500)' },
];

export function Confetti() {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden="true">
      {CONFETTI_DOTS.map((d, i) => (
        <span
          key={i}
          className="absolute w-2 h-2 rounded-full animate-confetti"
          style={{ backgroundColor: d.color, '--tx': `${d.tx}px`, '--ty': `${d.ty}px`, animationDelay: `${d.delay}ms` }}
        />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * New premium primitives — KPI cards, progress, tooltip, timeline, skeletons.
 * ------------------------------------------------------------------------- */

const kpiTones = {
  brand: { ring: 'ring-brand-600/15', icon: 'bg-brand-50 text-brand-600', value: 'text-brand-700' },
  accent: { ring: 'ring-accent-600/15', icon: 'bg-accent-50 text-accent-600', value: 'text-accent-700' },
  grey: { ring: 'ring-grey-500/15', icon: 'bg-grey-100 text-grey-600', value: 'text-grey-800' },
  success: { ring: 'ring-emerald-600/15', icon: 'bg-emerald-50 text-emerald-600', value: 'text-emerald-700' },
  amber: { ring: 'ring-amber-600/15', icon: 'bg-amber-50 text-amber-600', value: 'text-amber-700' },
};

/** A KPI stat card: icon, big number, label, optional trend/sub text, optional click-through via `to`
 *  (unchanged, existing navigation behaviour). `onExpand` adds a SEPARATE, additional affordance — a small
 *  chevron toggle that expands an inline breakdown without disturbing the card's own `to` navigation, so an
 *  existing "click this KPI to go to X" action is never replaced, only supplemented. */
export function KpiCard({ icon, label, value, sub, tone = 'brand', to, onClick, onExpand, expanded, explain, dense = false, className = '', style }) {
  const t = kpiTones[tone] || kpiTones.brand;
  const content = (
    <Card
      interactive={!!(to || onClick)}
      onClick={onClick}
      dense={dense}
      style={style}
      className={`h-full ${expanded ? 'ring-2 ring-brand-400' : `ring-1 ${t.ring}`} group relative ${className}`}
    >
      <div className={`flex items-start justify-between ${dense ? 'gap-2' : 'gap-3'}`}>
        <div className="min-w-0">
          <div className={`${dense ? 'text-xl' : 'text-2xl'} font-bold tracking-tight ${t.value}`}>{value ?? '—'}</div>
          <div className="text-xs font-medium text-grey-500 mt-1 truncate">{label}</div>
          {sub && <div className="text-[11px] text-grey-400 mt-0.5">{sub}</div>}
        </div>
        {icon && (
          <div className={`${dense ? 'w-8 h-8' : 'w-10 h-10'} rounded-xl flex items-center justify-center shrink-0 transition-transform duration-200 group-hover:scale-110 ${t.icon}`}>
            {icon}
          </div>
        )}
      </div>
      {explain && <div className="text-[11px] text-grey-400 mt-2 leading-snug">{explain}</div>}
      {onExpand && (
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onExpand(); }}
          title="See breakdown"
          className="absolute bottom-2 right-2 w-6 h-6 rounded-full flex items-center justify-center text-grey-300 hover:text-brand-600 hover:bg-brand-50 transition-colors"
        >
          <svg className={`w-3 h-3 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
          </svg>
        </button>
      )}
    </Card>
  );
  if (to) {
    return (
      <Link to={to} onClick={(e) => { if (onClick) { e.preventDefault(); onClick(); } }} className="block h-full">
        {content}
      </Link>
    );
  }
  return content;
}

const barTones = {
  brand: 'bg-brand-600',
  accent: 'bg-accent-600',
  grey: 'bg-grey-500',
  success: 'bg-emerald-500',
  amber: 'bg-amber-500',
};

export function ProgressBar({ value = 0, max = 100, tone = 'brand', label, showPct = true }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, Math.round((value / max) * 100))) : 0;
  return (
    <div>
      {(label || showPct) && (
        <div className="flex items-center justify-between text-xs text-grey-500 mb-1">
          {label && <span>{label}</span>}
          {showPct && <span className="font-semibold text-grey-700">{pct}%</span>}
        </div>
      )}
      <div className="h-2 rounded-full bg-grey-100 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out ${barTones[tone] || barTones.brand}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** Small SVG donut for a completed/remaining-style split — no charting library needed. */
export function DonutChart({ value = 0, max = 100, size = 64, stroke = 8, tone = 'brand', centerLabel }) {
  const pct = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const toneStroke = { brand: 'stroke-brand-600', accent: 'stroke-accent-600', success: 'stroke-emerald-500', amber: 'stroke-amber-500', grey: 'stroke-grey-500' };
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} className="stroke-grey-100" fill="none" />
        <circle
          cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" strokeLinecap="round"
          className={`${toneStroke[tone] || toneStroke.brand} transition-all duration-700 ease-out`}
          strokeDasharray={c} strokeDashoffset={c - pct * c}
        />
      </svg>
      {centerLabel !== undefined && (
        <span className="absolute text-xs font-bold text-grey-800">{centerLabel}</span>
      )}
    </div>
  );
}

/** Simple horizontal bar chart from [{label, value, tone?}] — for "By Team" style breakdowns. */
export function BarList({ items, max, tone = 'brand' }) {
  const computedMax = max ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="space-y-2.5">
      {items.map((item) => (
        <div key={item.label}>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-grey-600 font-medium truncate">{item.label}</span>
            <span className="text-grey-800 font-semibold ml-2">{item.value}</span>
          </div>
          <div className="h-1.5 rounded-full bg-grey-100 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-700 ease-out ${barTones[item.tone || tone] || barTones.brand}`}
              style={{ width: `${Math.min(100, (item.value / computedMax) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Hover tooltip (CSS-only, no JS positioning) — wrap any inline trigger element. */
export function Tooltip({ children, text, side = 'top' }) {
  const sideCls = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
  };
  return (
    <span className="relative inline-flex group/tip focus-within/tip:outline-none">
      {children}
      <span className={`pointer-events-none absolute z-30 whitespace-nowrap opacity-0 group-hover/tip:opacity-100 group-focus-within/tip:opacity-100 transition-opacity duration-150 bg-grey-900 text-white text-[11px] font-medium rounded-lg px-2.5 py-1.5 shadow-lg ${sideCls[side]}`}>
        {text}
      </span>
    </span>
  );
}

/** Vertical timeline — for history/audit-style chronological lists. */
export function Timeline({ items, renderItem }) {
  return (
    <ol className="relative border-l-2 border-grey-100 ml-2">
      {items.map((item, i) => (
        <li key={item.id ?? i} className="pl-5 pb-5 last:pb-0 relative animate-fade-in-up" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
          <span className={`absolute -left-[7px] top-1 w-3 h-3 rounded-full ring-4 ring-white ${item.tone === 'accent' ? 'bg-accent-500' : item.tone === 'success' ? 'bg-emerald-500' : 'bg-brand-500'}`} />
          {renderItem(item, i)}
        </li>
      ))}
    </ol>
  );
}

/** Smooth expand/collapse for progressive disclosure — no JS height measurement needed (grid-template-rows
 *  animates cleanly to arbitrary content height in every modern browser). Content stays in the DOM either
 *  way, so nothing inside it is ever removed — just visually hidden while collapsed. */
export function Collapse({ open, children }) {
  return (
    <div className="grid transition-[grid-template-rows] duration-300 ease-out" style={{ gridTemplateRows: open ? '1fr' : '0fr' }}>
      <div className="overflow-hidden min-h-0">{children}</div>
    </div>
  );
}

/** "Overview → Breakdown" drill-down panel: click a KPI, see it broken down (by person, team, etc.), then
 *  jump into the detail. Lives below the KPI grid rather than distorting it. */
export function DrillDownPanel({ title, items, tone = 'brand', onClose, emptyLabel = 'Nothing to break down.' }) {
  return (
    <div className="animate-fade-in-up rounded-2xl border border-grey-100 bg-grey-50 p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-grey-500 uppercase tracking-wide">{title}</span>
        <button onClick={onClose} className="text-xs font-medium text-grey-400 hover:text-grey-600 transition-colors">Close ✕</button>
      </div>
      {items.length === 0 ? <p className="text-sm text-grey-400">{emptyLabel}</p> : <BarList items={items} tone={tone} />}
    </div>
  );
}

export function Skeleton({ className = '', ...props }) {
  return <div className={`animate-shimmer rounded-lg ${className}`} {...props} />;
}

/** A full-card loading placeholder, matching Card's shape, for consistent loading states. */
export function CardSkeleton({ lines = 3 }) {
  return (
    <Card>
      <Skeleton className="h-4 w-1/3 mb-3" />
      <div className="space-y-2">
        {Array.from({ length: lines }).map((_, i) => <Skeleton key={i} className="h-3" style={{ width: `${90 - i * 12}%` }} />)}
      </div>
    </Card>
  );
}
