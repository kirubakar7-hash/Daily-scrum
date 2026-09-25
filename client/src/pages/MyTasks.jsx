import { useEffect, useState } from 'react';
import { ListTodo } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Card } from '../components/ui';
import TeamTaskList from '../components/TeamTaskList';

/** Everyone's personal task list — create work, update your own status, request support or a due-date
 *  change. Anyone can assign a new task to any active person ("Assign to"); once created it belongs to
 *  them, and the creator can follow it (read-only) in Team Tasks. */
export default function MyTasks() {
  const { user } = useAuth();
  const readOnly = user.role === 'senior_management';
  const [assignees, setAssignees] = useState([{ employee_id: user.id, full_name: 'You' }]);

  useEffect(() => {
    if (readOnly) return;
    api.get('/users/assignable').then((d) => {
      setAssignees(d.users.map((u) => ({ employee_id: u.id, full_name: u.id === user.id ? 'You' : u.full_name })));
    }).catch(() => {});
  }, [user.id, readOnly]);

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
      <Card className="animate-fade-in-up">
        <TeamTaskList assignees={assignees} fetchUrl="/scrum/my-tasks" readOnly={readOnly} />
      </Card>
    </div>
  );
}
