import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

const STORAGE_KEY = 'dsm_welcome_dismissed';

const ROLE_STEPS = {
  employee: [
    'Log your own tasks in My Tasks, or your leader can assign you one.',
    'Move a task from Pending → In Progress → Completed as you work it.',
    'Stuck, or need a new due date? Request Support or a Due-Date Change right from the task.',
    'Review everything logged for you any time in History.',
  ],
  leader: [
    'See every open task for your team, sorted by what needs attention first.',
    'Open any task to review its full detail and history.',
    'Delayed work is flagged automatically from due dates — no manual scoring needed.',
    'Spot what needs your attention — overdue work, repeat support requests.',
    'Track your team\'s history and trends over time.',
  ],
  admin: [
    'Create and manage people and teams.',
    'Assign each person a role and a team.',
    'Review the audit log for important changes.',
    'Everything else works the same as for a Leader.',
  ],
  super_admin: [
    'Full visibility and control across the whole organization.',
    'Manage users, roles, and teams.',
    'Your account is protected — no one else can change it.',
    'Review the complete audit trail of every important change.',
  ],
  senior_management: [
    'A read-only view of how the organization is performing.',
    'See commitment and completion trends.',
    'Drill into History for the detail behind any number.',
  ],
};

const DISMISS_MS = 220;

export default function WelcomeBanner({ role, name, onStartTour }) {
  const [dismissed, setDismissed] = useState(true);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(STORAGE_KEY) === '1');
    } catch {
      setDismissed(true);
    }
  }, []);

  function dismiss() {
    setClosing(true);
    try { localStorage.setItem(STORAGE_KEY, '1'); } catch {}
    setTimeout(() => { setDismissed(true); setClosing(false); }, DISMISS_MS);
  }

  if (dismissed) return null;
  const steps = ROLE_STEPS[role] || ROLE_STEPS.employee;

  return (
    <div
      className={`relative overflow-hidden bg-gradient-to-br from-brand-700 via-brand-700 to-brand-900 text-white rounded-2xl p-5 mb-5 shadow-lg shadow-brand-900/20 transition-all duration-200 ${
        closing ? 'opacity-0 scale-[0.98] -translate-y-1' : 'animate-fade-in-up'
      }`}
    >
      <div className="absolute -right-8 -top-8 w-40 h-40 rounded-full bg-white/5 animate-float" />
      <div className="absolute right-16 bottom-0 w-24 h-24 rounded-full bg-accent-500/10 animate-float" style={{ animationDelay: '1.5s', animationDuration: '8s' }} />
      <div className="relative flex items-start justify-between gap-4">
        <div>
          <h2 className="font-bold text-lg">Welcome to Task Management{name ? `, ${name}` : ''} 👋</h2>
          <p className="text-brand-100 text-sm mt-1">This tool helps you:</p>
          <ol className="text-sm text-brand-50 mt-2 space-y-1 list-decimal list-inside">
            {steps.map((s) => <li key={s}>{s}</li>)}
          </ol>
          {onStartTour && (
            <button
              onClick={() => { dismiss(); onStartTour(); }}
              className="mt-3 text-sm font-semibold bg-white text-brand-700 rounded-xl px-3.5 py-1.5 hover:bg-brand-50 transition-colors shadow-sm press-scale"
            >
              Start guided tour →
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Close"
          className="relative w-8 h-8 rounded-full flex items-center justify-center text-brand-100 hover:text-white hover:bg-white/10 transition-colors shrink-0 press-scale"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

export function resetWelcomeBanner() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}
