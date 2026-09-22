import { Users } from 'lucide-react';
import { Card } from '../components/ui';
import TeamTaskList from '../components/TeamTaskList';
import { useAuth } from '../lib/AuthContext';

const WIDE_OPEN_ROLES = ['super_admin', 'admin', 'senior_management'];

/** The task list — Super Admin, Admin, and Senior Management see every task, org-wide, same as always.
 *  A Leader sees their own tasks plus everyone reporting to them, any depth. An Employee sees only their
 *  own. No Create Task button here — creating (and assigning to anyone) happens on My Tasks, so there's
 *  one obvious place to do it, not two. */
export default function AllTasks() {
  const { user } = useAuth();
  const readOnly = user.role === 'senior_management';
  const description = readOnly
    ? 'A read-only view of every task across the organization.'
    : WIDE_OPEN_ROLES.includes(user.role)
      ? "Every task across the organization. You can only update your own — a Leader can update anyone's."
      : user.role === 'leader'
        ? 'Your tasks and everyone reporting to you. You can update anyone in your chain.'
        : 'Your own tasks.';
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2.5 animate-fade-in-up">
        <div className="w-9 h-9 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center shrink-0">
          <Users className="w-4 h-4" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-grey-900">Team Tasks</h1>
          <p className="text-grey-500 text-sm mt-0.5">{description}</p>
        </div>
      </div>
      <Card className="animate-fade-in-up">
        <TeamTaskList fetchUrl="/leader/org-tasks" canActOn={(t) => !!t.can_act} showCreate={false} />
      </Card>
    </div>
  );
}
