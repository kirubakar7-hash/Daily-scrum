import { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

/** Every step points at a data-tour="..." attribute somewhere on the page. If `route` is set and
 *  different from where the user currently is, the tour navigates there before showing the step. */
const TOUR_STEPS = {
  employee: [
    { route: '/my-tasks', selector: '[data-tour="nav-my-tasks"]', title: 'My Tasks', body: 'Log your own work here, or update tasks your leader assigned you.' },
    { route: '/my-tasks', selector: '[data-tour="create-task-button"]', title: 'Create a task', body: 'Add something you\'re working on — it\'s yours to update from Pending through Completed.' },
    { route: '/history', selector: '[data-tour="nav-history"]', title: 'My History', body: 'Everything logged for you, searchable any time.' },
    { route: '/history', selector: '[data-tour="history-search-tab"]', title: 'Search', body: 'Switch to this tab any time to find a task or action by keyword.' },
  ],
  leader: [
    { route: '/team', selector: '[data-tour="nav-team"]', title: 'Daily Scrum', body: 'Your team\'s home base — who\'s done their scrum today, and every open task.' },
    { route: '/team', selector: '[data-tour="team-overview-table"]', title: 'Team Overview', body: 'See who\'s completed today\'s scrum, who\'s delayed, and who needs support — at a glance.' },
    { route: '/team', selector: '[data-tour="team-tasks-section"]', title: 'Team Tasks', body: 'Every open task for your team, sorted by due date. Click a due date to reschedule it, or create a new task for someone.' },
    { route: '/team', selector: '[data-tour="create-task-button"]', title: 'Assign a task', body: 'Create a task for anyone on your team directly from here.' },
    { route: '/dashboard', selector: '[data-tour="nav-dashboard"]', title: 'Dashboard', body: 'A live rollup of your team\'s numbers — nothing here is typed in by hand.' },
    { route: '/dashboard', selector: '[data-tour="attention-section"]', title: 'Leadership Attention Required', body: 'Delayed work and support requests surface here automatically, so you don\'t have to go looking for them.' },
    { route: '/history', selector: '[data-tour="nav-history"]', title: 'History', body: 'Your team\'s full track record over time, searchable any time.' },
  ],
  admin: [
    { route: '/team', selector: '[data-tour="nav-team"]', title: 'Daily Scrum', body: 'Works the same as it does for a Leader — see your team\'s scrum and tasks.' },
    { route: '/admin', selector: '[data-tour="nav-admin"]', title: 'Admin', body: 'Manage every person and team in the organization.' },
    { route: '/admin', selector: '[data-tour="admin-tabs"]', title: 'Users, Teams, Task Types', body: 'Switch between these tabs to manage each part of your org structure.' },
    { route: '/admin', selector: '[data-tour="admin-create-user"]', title: 'Add a person', body: 'Create a new account here, then assign them a role and a team.' },
    { route: '/dashboard', selector: '[data-tour="nav-dashboard"]', title: 'Dashboard', body: 'A live, organization-wide rollup — nothing here is typed in by hand.' },
  ],
  super_admin: [
    { route: '/dashboard', selector: '[data-tour="nav-dashboard"]', title: 'System Control Center', body: 'Full visibility across every team, user, and record in the organization.' },
    { route: '/admin', selector: '[data-tour="nav-admin"]', title: 'Admin', body: 'Manage every person and team. Your own account is protected — no one can change or deactivate it, including you, by accident.' },
    { route: '/team', selector: '[data-tour="nav-team"]', title: 'Daily Scrum', body: 'See any team\'s scrum and tasks, same as a Leader would.' },
    { route: '/audit', selector: '[data-tour="nav-audit"]', title: 'Audit Log', body: 'Every important change across the whole system — who changed it, when, and why. Nothing here can be edited or removed.' },
    { route: '/history', selector: '[data-tour="history-search-tab"]', title: 'Search', body: 'Switch to this tab any time to find any task or action by keyword, across the entire organization.' },
  ],
  senior_management: [
    { route: '/dashboard', selector: '[data-tour="nav-dashboard"]', title: 'Organization Overview', body: 'A read-only view of how the organization is performing — live numbers, nothing typed in by hand.' },
    { route: '/history', selector: '[data-tour="nav-history"]', title: 'History', body: 'Drill into the detail behind any number, any time.' },
    { route: '/history', selector: '[data-tour="history-search-tab"]', title: 'Search', body: 'Switch to this tab any time to find any task or action by keyword.' },
  ],
};

export function tourStepsForRole(role) {
  return TOUR_STEPS[role] || TOUR_STEPS.employee;
}

export default function GuidedTour({ role, active, onFinish }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState(null);
  const navigate = useNavigate();
  const location = useLocation();
  const steps = tourStepsForRole(role);
  const step = active ? steps[stepIndex] : null;
  const scrolledForStep = useRef(-1);

  useEffect(() => {
    if (active) setStepIndex(0);
  }, [active]);

  useEffect(() => {
    if (step && location.pathname !== step.route) navigate(step.route);
  }, [step, location.pathname, navigate]);

  useEffect(() => {
    if (!step) { setRect(null); return; }
    let raf;
    function update() {
      const el = document.querySelector(step.selector);
      if (el) {
        if (scrolledForStep.current !== stepIndex) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          scrolledForStep.current = stepIndex;
        }
        setRect(el.getBoundingClientRect());
      } else {
        setRect(null);
      }
      raf = requestAnimationFrame(update);
    }
    raf = requestAnimationFrame(update);
    return () => cancelAnimationFrame(raf);
  }, [step, stepIndex]);

  if (!active || !step) return null;

  const isLast = stepIndex === steps.length - 1;
  const pad = 8;
  const box = rect
    ? { top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }
    : null;

  const tooltipTop = box ? Math.min(box.top + box.height + 12, window.innerHeight - 180) : window.innerHeight / 2 - 60;
  const tooltipLeft = box ? Math.min(Math.max(box.left, 12), window.innerWidth - 320) : window.innerWidth / 2 - 150;

  return (
    <div className="fixed inset-0 z-50" style={{ pointerEvents: 'none' }}>
      {box && (
        <div
          className="fixed rounded-lg transition-all duration-200"
          style={{
            top: box.top, left: box.left, width: box.width, height: box.height,
            boxShadow: '0 0 0 9999px rgba(15, 23, 42, 0.55)',
            border: '2px solid #16469D',
          }}
        />
      )}
      {!box && <div className="fixed inset-0" style={{ background: 'rgba(15, 23, 42, 0.55)' }} />}
      <div
        key={stepIndex}
        className="fixed bg-white rounded-2xl shadow-xl p-4 w-[300px] transition-[top,left] duration-200 animate-scale-in"
        style={{ top: tooltipTop, left: tooltipLeft, pointerEvents: 'auto' }}
      >
        <div className="text-xs text-grey-400 font-semibold mb-1">Step {stepIndex + 1} of {steps.length}</div>
        <h3 className="font-bold text-grey-900">{step.title}</h3>
        <p className="text-sm text-grey-600 mt-1">{step.body}</p>
        <div className="flex items-center justify-between mt-3">
          <button onClick={onFinish} className="text-xs text-grey-400 hover:text-grey-600 transition-colors press-scale">Skip tour</button>
          <div className="flex gap-2">
            {stepIndex > 0 && (
              <button onClick={() => setStepIndex((i) => i - 1)} className="text-xs px-3 py-1.5 rounded-lg bg-grey-100 text-grey-700 hover:bg-grey-200 transition-colors press-scale">
                ← Back
              </button>
            )}
            <button
              onClick={() => (isLast ? onFinish() : setStepIndex((i) => i + 1))}
              className="text-xs px-3 py-1.5 rounded-lg bg-brand-600 text-white hover:bg-brand-700 transition-colors press-scale"
            >
              {isLast ? 'Done' : 'Next →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
