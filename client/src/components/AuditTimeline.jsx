import { Pencil, Trash2, Plus, CalendarClock, LifeBuoy } from 'lucide-react';
import { formatBusinessDateTime } from '../lib/businessDate';
import { EmptyState, IllustrationEmptyList, Timeline, humanize } from './ui';

const SUBJECT_LABELS = {
  commitments: 'Task', blockers: 'Blocker', actions: 'Action', escalations: 'Escalation',
  departments: 'Department', teams: 'Team', users: 'User', categories: 'Function',
  recurring_activities: 'Recurring task', task_types: 'Task type', main_tasks: 'Process',
  task_activities: 'Activity',
};

const FIELD_LABELS = {
  status: 'Status', role: 'Role', job_title: 'Job title', full_name: 'Name', email: 'Email',
  name: 'Name', description: 'Description', priority: 'Priority', due_date: 'Due date',
  due_time: 'Due time', estimated_effort: 'Estimated effort', dependency: 'Dependency',
  dependency_owner: 'Waiting on', remarks: 'Remarks', expected_outcome: 'Expected outcome', mechanic: 'Behaviour',
  team_id: 'Team', department_id: 'Department', leader_user_id: 'Team leader',
  category_id: 'Function', main_task_id: 'Process', task_activity_id: 'Activity', reviewer_id: 'Reviewer',
};

// These fields store internal IDs, not anything a person would recognize — never show the raw value.
const ID_FIELDS = new Set(['team_id', 'department_id', 'leader_user_id']);

/** Turns a raw (table_name, field_name, old_value, new_value) row into a plain-English sentence, so the
 *  log reads like "Task status changed: Pending → Completed" instead of "commitments.status". Shared by
 *  the org-wide Audit Log page and the per-task History popout, so the two never describe the same kind
 *  of change differently. */
function describeLog(l) {
  const subject = SUBJECT_LABELS[l.table_name] || humanize(l.table_name);

  if (l.field_name === 'created') return { icon: Plus, tone: 'success', title: `${subject} created`, detail: l.new_value };
  if (l.field_name === 'deleted') return { icon: Trash2, tone: 'accent', title: `${subject} deleted`, detail: l.old_value };
  if (l.field_name === 'password') return { icon: Pencil, tone: 'brand', title: `${subject} password was reset`, detail: null };
  if (l.field_name === 'support_requested') return { icon: Pencil, tone: 'accent', title: 'Flagged as needing support — waiting in the Requests inbox', detail: null };
  // Amber, not brand — matches the due-date cell's own "amber means changed from the original" convention.
  if (l.field_name === 'carried_forward') return { icon: CalendarClock, tone: 'amber', title: `${subject} due date changed`, detail: { from: l.old_value, to: l.new_value } };
  if (l.field_name === 'due_date_change_rejected') return { icon: CalendarClock, tone: 'accent', title: `${subject} due-date-change request rejected`, detail: `stayed at ${l.old_value}` };
  if (l.field_name === 'support_request_approved') return { icon: LifeBuoy, tone: 'success', title: 'Support request approved', detail: l.new_value };
  if (l.field_name === 'support_request_rejected') return { icon: LifeBuoy, tone: 'accent', title: 'Support request rejected', detail: l.new_value };
  if (l.field_name === 'assigned') return { icon: Plus, tone: 'brand', title: 'Recurring task assigned', detail: l.new_value };
  if (l.field_name === 'is_active') return { icon: Pencil, tone: l.new_value === '1' ? 'success' : 'accent', title: `${subject} ${l.new_value === '1' ? 'activated' : 'deactivated'}`, detail: null };

  const fieldLabel = FIELD_LABELS[l.field_name] || humanize(l.field_name);
  if (ID_FIELDS.has(l.field_name)) return { icon: Pencil, tone: 'brand', title: `${subject} — ${fieldLabel} changed`, detail: null };
  if (l.field_name === 'due_date') return { icon: CalendarClock, tone: 'amber', title: `${subject} — ${fieldLabel} changed`, detail: { from: l.old_value, to: l.new_value } };
  return { icon: Pencil, tone: 'brand', title: `${subject} — ${fieldLabel} changed`, detail: { from: l.old_value, to: l.new_value } };
}

// One place mapping each tone to its icon color + label-chip classes, so every entry type stays visually
// consistent without repeating the same ternary chain at every call site.
const TONE_STYLES = {
  accent: { icon: 'text-accent-600', chip: 'bg-accent-50 text-accent-700' },
  success: { icon: 'text-emerald-600', chip: 'bg-emerald-50 text-emerald-700' },
  amber: { icon: 'text-amber-600', chip: 'bg-amber-50 text-amber-700' },
  brand: { icon: 'text-brand-600', chip: 'bg-brand-50 text-brand-700' },
};

/** Renders a list of raw audit_logs rows as a Timeline of cards — every entry: a colored label chip +
 *  timestamp, an old→new diff (or single value) where relevant, and a "Changed by {name}" footer so it's
 *  always clear who did what. Used by both the org-wide Audit Log page (client/src/pages/AuditLog.jsx)
 *  and TeamTaskList.jsx's per-task History drawer, so the two never describe the same change differently. */
export default function AuditTimeline({ logs, emptyTitle = 'No changes recorded yet', emptyBody = 'Once something important changes, it will show up here.' }) {
  if (logs.length === 0) {
    return <EmptyState icon={<IllustrationEmptyList className="w-16 h-16 mx-auto" />} title={emptyTitle}>{emptyBody}</EmptyState>;
  }
  const timelineItems = logs.map((l) => ({ ...l, ...describeLog(l) }));
  return (
    <Timeline
      items={timelineItems}
      renderItem={(l) => {
        const Icon = l.icon;
        const styles = TONE_STYLES[l.tone] || TONE_STYLES.brand;
        return (
          <div className="bg-white border border-grey-100 rounded-xl p-2.5 hover:border-grey-200 transition-colors">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <span className={`inline-flex items-center gap-1 text-xs font-semibold px-1.5 py-0.5 rounded ${styles.chip}`}>
                <Icon className="w-3 h-3 shrink-0" />
                {l.title}
              </span>
              <span className="text-grey-400 text-[11px] whitespace-nowrap">{formatBusinessDateTime(l.changed_at)}</span>
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
            <div className="text-[11px] text-grey-400 mt-1.5 pt-1.5 border-t border-grey-100">
              Changed by <strong className="text-grey-600 font-medium">{l.changed_by_name || 'system'}</strong>
              {l.owner_name && l.owner_name !== l.changed_by_name && <> on behalf of <strong className="text-grey-600 font-medium">{l.owner_name}</strong></>}
              {l.reason ? ` — ${l.reason}` : ''}
            </div>
          </div>
        );
      }}
    />
  );
}
