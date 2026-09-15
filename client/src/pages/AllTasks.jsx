import { Users } from 'lucide-react';
import { Card } from '../components/ui';
import TeamTaskList from '../components/TeamTaskList';

/** The org-wide task list — everyone can see every task here, but only your own rows (or, for a Leader,
 *  anyone's) are actually editable. No Create Task button here — creating happens on My Tasks or the
 *  Leader's Daily Scrum -> Team Tasks tab, so there's one obvious place to do it, not three. */
export default function AllTasks() {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2.5 animate-fade-in-up">
        <div className="w-9 h-9 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center shrink-0">
          <Users className="w-4 h-4" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-grey-900">Team Tasks</h1>
          <p className="text-grey-500 text-sm mt-0.5">Every task across the organization. You can only update your own — a Leader can update anyone's.</p>
        </div>
      </div>
      <Card className="animate-fade-in-up">
        <TeamTaskList fetchUrl="/leader/org-tasks" canActOn={(t) => !!t.can_act} showCreate={false} />
      </Card>
    </div>
  );
}
