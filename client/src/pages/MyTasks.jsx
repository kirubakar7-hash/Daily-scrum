import { useEffect, useState } from 'react';
import { ListTodo, CheckCircle2 } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Button, Card, ErrorBanner } from '../components/ui';
import TeamTaskList from '../components/TeamTaskList';

const LEADER_TIER = ['leader', 'admin', 'super_admin'];

/** Everyone's personal task list — create your own work, update your own status, request support or a
 *  due-date change. A Leader can also assign a new task to anyone here (not just themselves), matching
 *  the same org-wide "Assign to" list Team Tasks uses. */
export default function MyTasks() {
  const { user } = useAuth();
  const readOnly = user.role === 'senior_management';
  const [assignees, setAssignees] = useState([{ employee_id: user.id, full_name: 'You' }]);

  useEffect(() => {
    if (!LEADER_TIER.includes(user.role)) return;
    api.get('/users').then((d) => {
      setAssignees(d.users.filter((u) => u.is_active).map((u) => ({ employee_id: u.id, full_name: u.id === user.id ? 'You' : u.full_name })));
    }).catch(() => {});
  }, [user.id, user.role]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2.5 animate-fade-in-up">
        <div className="w-9 h-9 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center shrink-0">
          <ListTodo className="w-4 h-4" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-grey-900">My Tasks</h1>
          <p className="text-grey-500 text-sm mt-0.5">
            {readOnly ? 'A read-only view of everything assigned to you.' : 'Everything assigned to you — create, update, and request help or a new due date.'}
          </p>
        </div>
      </div>
      {!readOnly && <ConfirmScrumCard />}
      <Card className="animate-fade-in-up">
        <TeamTaskList assignees={assignees} fetchUrl="/scrum/my-tasks" readOnly={readOnly} />
      </Card>
    </div>
  );
}

/** Your own daily check-in — separate from any individual task, this is what shows up as "Done"/"Pending"
 *  on your leader's Daily Scrum > Team Overview for today. Self-service only (never on someone else's
 *  behalf), and only ever for today — there's no date picker here on purpose, unlike Team Overview's,
 *  since confirming a past day after the fact wouldn't mean anything. */
function ConfirmScrumCard() {
  const [session, setSession] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');

  function load() {
    api.get('/scrum/today').then((d) => setSession(d.session)).catch(() => {});
  }
  useEffect(load, []);

  async function confirm() {
    setConfirming(true);
    setError('');
    try {
      await api.post('/scrum/confirm', {});
      load();
    } catch (e) {
      setError(e.message || "Couldn't confirm your scrum.");
    } finally {
      setConfirming(false);
    }
  }

  if (!session) return null;

  return (
    <Card dense className="animate-fade-in-up">
      {session.status === 'completed' ? (
        <div className="flex items-center gap-1.5 text-sm font-semibold text-emerald-700">
          <CheckCircle2 className="w-4 h-4 shrink-0" /> You've confirmed today's scrum.
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="text-sm text-grey-600">
            <span className="font-semibold text-grey-800">Confirm today's scrum</span> — let your leader know you're checked in for today.
          </div>
          <Button size="sm" onClick={confirm} disabled={confirming}>
            <CheckCircle2 className="w-3.5 h-3.5" /> {confirming ? 'Confirming…' : 'Confirm Scrum'}
          </Button>
        </div>
      )}
      <ErrorBanner message={error} />
    </Card>
  );
}
