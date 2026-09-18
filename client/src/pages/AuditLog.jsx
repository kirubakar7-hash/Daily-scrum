import { useEffect, useState } from 'react';
import { History, Pencil, Trash2, Plus, Mail } from 'lucide-react';
import { api } from '../lib/api';
import { Button, Card, EmptyState, ErrorBanner, IllustrationEmptyList, Timeline, humanize } from '../components/ui';
import HelpBanner from '../components/HelpBanner';

const SUBJECT_LABELS = {
  commitments: 'Task', blockers: 'Blocker', actions: 'Action', escalations: 'Escalation',
  departments: 'Department', teams: 'Team', users: 'User', categories: 'Subtask',
  recurring_activities: 'Recurring task', task_types: 'Task type', main_tasks: 'Main Task',
};

const FIELD_LABELS = {
  status: 'Status', role: 'Role', job_title: 'Job title', full_name: 'Name', email: 'Email',
  name: 'Name', description: 'Description', priority: 'Priority', due_date: 'Due date',
  due_time: 'Due time', estimated_effort: 'Estimated effort', dependency: 'Dependency',
  dependency_owner: 'Waiting on', remarks: 'Remarks', expected_outcome: 'Expected outcome', mechanic: 'Behaviour',
  team_id: 'Team', department_id: 'Department', leader_user_id: 'Team leader',
};

// These fields store internal IDs, not anything a person would recognize — never show the raw value.
const ID_FIELDS = new Set(['team_id', 'department_id', 'leader_user_id']);

/** Turns a raw (table_name, field_name, old_value, new_value) row into a plain-English sentence, so the
 *  log reads like "Task status changed: Pending → Completed" instead of "commitments.status". */
function describeLog(l) {
  const subject = SUBJECT_LABELS[l.table_name] || humanize(l.table_name);

  if (l.table_name === 'status_email' && l.field_name === 'sent') return { icon: Mail, tone: 'success', title: 'Daily status email sent', detail: l.new_value };
  if (l.field_name === 'created') return { icon: Plus, tone: 'success', title: `${subject} created`, detail: l.new_value };
  if (l.field_name === 'deleted') return { icon: Trash2, tone: 'accent', title: `${subject} deleted`, detail: l.old_value };
  if (l.field_name === 'password') return { icon: Pencil, tone: 'brand', title: `${subject} password was reset`, detail: null };
  if (l.field_name === 'support_requested') return { icon: Pencil, tone: 'accent', title: 'Flagged as needing support — waiting in the Requests inbox', detail: null };
  if (l.field_name === 'carried_forward') return { icon: Pencil, tone: 'brand', title: `${subject} due date changed`, detail: `now due ${l.new_value}` };
  if (l.field_name === 'due_date_change_rejected') return { icon: Pencil, tone: 'accent', title: `${subject} due-date-change request rejected`, detail: `stayed at ${l.old_value}` };
  if (l.field_name === 'assigned') return { icon: Plus, tone: 'brand', title: 'Recurring task assigned', detail: l.new_value };
  if (l.field_name === 'is_active') return { icon: Pencil, tone: l.new_value === '1' ? 'success' : 'accent', title: `${subject} ${l.new_value === '1' ? 'activated' : 'deactivated'}`, detail: null };

  const fieldLabel = FIELD_LABELS[l.field_name] || humanize(l.field_name);
  if (ID_FIELDS.has(l.field_name)) return { icon: Pencil, tone: 'brand', title: `${subject} — ${fieldLabel} changed`, detail: null };
  return { icon: Pencil, tone: 'brand', title: `${subject} — ${fieldLabel} changed`, detail: { from: l.old_value, to: l.new_value } };
}

export default function AuditLog() {
  const [logs, setLogs] = useState([]);
  const [loadError, setLoadError] = useState('');

  function load() {
    setLoadError('');
    api.get('/audit').then((d) => setLogs(d.logs)).catch((e) => setLoadError(e.message || "Couldn't load the audit log."));
  }

  useEffect(load, []);

  const timelineItems = logs.map((l) => ({ ...l, ...describeLog(l) }));

  return (
    <Card className="animate-fade-in-up">
      <div className="flex items-center gap-2.5 mb-1">
        <div className="w-9 h-9 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center shrink-0">
          <History className="w-4.5 h-4.5" />
        </div>
        <h1 className="text-xl font-bold text-grey-900">Audit Log</h1>
      </div>
      <p className="text-grey-500 text-sm mb-3">Every important change — what changed, who changed it, and when.</p>
      <HelpBanner>
        This log records changes that could affect someone's access or history — role changes, deactivations, due date changes, and similar updates.
        Nothing here can be edited or removed.
      </HelpBanner>
      <ErrorBanner message={loadError} />
      {loadError && <Button size="sm" variant="secondary" className="mt-2" onClick={load}>Retry</Button>}
      {!loadError && logs.length === 0 ? (
        <EmptyState icon={<IllustrationEmptyList className="w-20 h-20 mx-auto" />} title="No changes recorded yet">Once something important changes, it will show up here.</EmptyState>
      ) : !loadError && (
        <div className="mt-4">
          <Timeline
            items={timelineItems}
            renderItem={(l) => {
              const Icon = l.icon;
              return (
                <div className="text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <span className="inline-flex items-center gap-1.5 font-semibold text-grey-800">
                      <Icon className={`w-3.5 h-3.5 shrink-0 ${l.tone === 'accent' ? 'text-accent-600' : l.tone === 'success' ? 'text-emerald-600' : 'text-brand-600'}`} />
                      {l.title}
                    </span>
                    <span className="text-grey-400 text-xs whitespace-nowrap">{l.changed_at}</span>
                  </div>
                  {l.detail && typeof l.detail === 'object' && l.detail.from !== null && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <span className="line-through text-accent-600 text-xs bg-accent-50 rounded-md px-1.5 py-0.5">{l.detail.from}</span>
                      <span className="text-grey-300 text-xs">→</span>
                      <span className="text-emerald-700 text-xs font-medium bg-emerald-50 rounded-md px-1.5 py-0.5">{l.detail.to}</span>
                    </div>
                  )}
                  {l.detail && typeof l.detail === 'object' && l.detail.from === null && (
                    <div className="mt-1.5">
                      <span className="text-emerald-700 text-xs font-medium bg-emerald-50 rounded-md px-1.5 py-0.5">{l.detail.to}</span>
                    </div>
                  )}
                  {l.detail && typeof l.detail === 'string' && (
                    <div className="mt-1 text-xs text-grey-500">{l.detail}</div>
                  )}
                  <div className="text-xs text-grey-400 mt-1.5">
                    Changed by {l.changed_by_name || 'system'}
                    {l.owner_name && l.owner_name !== l.changed_by_name && <> on behalf of <strong className="text-grey-600">{l.owner_name}</strong></>}
                    {l.reason ? ` — ${l.reason}` : ''}
                  </div>
                </div>
              );
            }}
          />
        </div>
      )}
    </Card>
  );
}
