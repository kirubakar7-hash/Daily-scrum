import { useEffect, useState } from 'react';
import { ListTodo } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Card } from '../components/ui';
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
          <p className="text-grey-500 text-sm mt-0.5">Everything assigned to you — create, update, and request help or a new due date.</p>
        </div>
      </div>
      <Card className="animate-fade-in-up">
        <TeamTaskList assignees={assignees} fetchUrl="/scrum/my-tasks" readOnly={readOnly} />
      </Card>
    </div>
  );
}
