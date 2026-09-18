import { useEffect, useMemo, useState } from 'react';
import { Plus, RotateCw, Check, AlertTriangle, Repeat, Filter, Download, XCircle, MessageSquareText, LifeBuoy, CalendarClock } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Badge, Button, DeleteButton, EmptyState, ErrorBanner, humanize, IllustrationEmptyList, IllustrationSearch, Input, Modal, Select, Skeleton, Textarea } from './ui';
import RecurrencePicker, { DEFAULT_RULE } from './RecurrencePicker';
import InfoTip from './InfoTip';

const PRIORITIES = ['Low', 'Medium', 'High'];
const EMPTY_TASK_FILTERS = { employee: '', type: '', priority: '', status: '', category: '', mainTask: '' };
const today = new Date().toISOString().slice(0, 10);

function csvEscape(v) {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

const alwaysTrue = () => true;

/** Shared list+bulk+inline-edit table, reused by the leader-scoped "Team Tasks" tab, the org-wide
 *  "Team Tasks" page, and "My Tasks". `fetchUrl` picks the data source; `assignees` is who a new task can
 *  be created for; `canActOn(task)` (default: everyone can) decides per row whether the status/date/delete
 *  controls are live or read-only, layered on top of the list-wide `readOnly`; `showCreate` hides the
 *  Create Task button entirely for pages (like the org-wide view) that don't want a third creation surface. */
export default function TeamTaskList({ assignees: assigneesProp, team, readOnly, date = today, fetchUrl = '/leader/team-tasks', canActOn = alwaysTrue, showCreate = true }) {
  const { user } = useAuth();
  const assignees = assigneesProp || team || [];
  const [tasks, setTasks] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [notice, setNotice] = useState('');
  const [filters, setFilters] = useState(EMPTY_TASK_FILTERS);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState('');
  const [requestModal, setRequestModal] = useState(null); // { task, kind: 'support' | 'due_date_change' }
  const [loadError, setLoadError] = useState('');
  const [employeeOptions, setEmployeeOptions] = useState([]);
  const [categoryOptions, setCategoryOptions] = useState([]);
  const [mainTaskOptions, setMainTaskOptions] = useState([]);

  // Sourced from the org's canonical lists (not from whichever tasks happen to be loaded), same pattern
  // History.jsx already uses — otherwise someone with zero currently-open tasks can never be filtered to
  // at all. Both endpoints are open to every role, so this works the same regardless of who's viewing.
  useEffect(() => {
    api.get('/history/summary').then((d) => setEmployeeOptions(d.summary.map((s) => s.full_name).sort())).catch(() => {});
    api.get('/categories').then((d) => setCategoryOptions(d.categories.filter((c) => c.is_active).map((c) => c.name).sort())).catch(() => {});
    api.get('/main-tasks').then((d) => setMainTaskOptions(d.main_tasks.filter((m) => m.is_active).map((m) => m.name).sort())).catch(() => {});
  }, []);

  function load(noticeText) {
    setLoadError('');
    api.get(`${fetchUrl}?date=${date}`).then((d) => {
      setTasks(d.tasks);
      // Drop any selected id that no longer exists in the list (e.g. it was just completed elsewhere).
      setSelectedIds((prev) => new Set([...prev].filter((id) => d.tasks.some((t) => t.id === id))));
    }).catch((e) => setLoadError(e.message || "Couldn't load tasks."));
    if (noticeText) {
      setNotice(noticeText);
      setTimeout(() => setNotice(''), 4000);
    }
  }

  function toggleSelect(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Attempts every selected item regardless of an earlier one failing, and always reloads afterward —
  // otherwise items that succeeded server-side before a later failure kept showing their stale pre-bulk
  // state, since the old all-or-nothing loop only reloaded on full success.
  async function runBulk(ids, action, successMessage) {
    setBulkBusy(true);
    setBulkError('');
    const results = await Promise.allSettled(ids.map(action));
    const failed = results.filter((r) => r.status === 'rejected').length;
    setSelectedIds(new Set());
    setBulkBusy(false);
    if (failed > 0) {
      setBulkError(`${ids.length - failed} of ${ids.length} succeeded — ${failed} failed. The list below reflects what actually happened.`);
    }
    load(failed === 0 ? successMessage : undefined);
  }

  function bulkComplete() {
    const ids = [...selectedIds];
    return runBulk(ids, (id) => api.post(`/scrum/commitments/${id}/resolve`, { status: 'completed' }), `Marked ${ids.length} task${ids.length === 1 ? '' : 's'} completed.`);
  }

  function bulkReschedule(newDate) {
    const ids = [...selectedIds];
    return runBulk(ids, (id) => api.post(`/scrum/commitments/${id}/carry-forward`, { new_due_date: newDate }), `Rescheduled ${ids.length} task${ids.length === 1 ? '' : 's'} to ${newDate}.`);
  }

  // Bulk delete is Super Admin only, same restriction as the per-row Delete button — the server enforces
  // this too, so this is purely about not showing a control that would just fail for anyone else.
  function bulkDelete() {
    const ids = [...selectedIds];
    return runBulk(ids, (id) => api.del(`/scrum/commitments/${id}`), `Deleted ${ids.length} task${ids.length === 1 ? '' : 's'}.`);
  }

  async function remove(task) {
    setDeleteError('');
    try {
      await api.del(`/scrum/commitments/${task.id}`);
      load();
    } catch (e) {
      setDeleteError(e.message);
    }
  }

  useEffect(() => { load(); }, [date, fetchUrl]);

  const filteredTasks = useMemo(() => (tasks || []).filter((t) =>
    (!filters.employee || t.employee_name === filters.employee)
    && (!filters.type || t.type === filters.type)
    && (!filters.priority || t.priority === filters.priority)
    && (!filters.status || t.status === filters.status)
    && (!filters.category || t.category_name === filters.category)
    && (!filters.mainTask || t.main_task_name === filters.mainTask)
  ), [tasks, filters]);
  const filtersActive = Object.values(filters).some(Boolean);
  const isRowReadOnly = (t) => readOnly || !canActOn(t);
  const selectableTasks = useMemo(() => filteredTasks.filter((t) => !isRowReadOnly(t)), [filteredTasks, readOnly, canActOn]);

  function exportCsv() {
    const header = ['Task', 'Employee', 'Type', 'Subtask', 'Main Task', 'Priority', 'Due', 'Status'];
    const lines = [header.join(',')].concat(
      filteredTasks.map((t) => [t.description, t.employee_name, t.task_type_name || t.type, t.category_name || '', t.main_task_name || '', t.priority, t.due_date, t.status].map(csvEscape).join(','))
    );
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'team-tasks.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!tasks) {
    if (loadError) {
      return (
        <div className="py-2 space-y-2">
          <ErrorBanner message={loadError} />
          <Button size="sm" variant="secondary" onClick={() => load()}>Retry</Button>
        </div>
      );
    }
    return (
      <div className="space-y-2 py-2">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-start sm:items-center justify-between gap-3 mb-3 flex-col sm:flex-row">
        <p className="text-xs text-grey-500 leading-relaxed">
          By due date. Completed tasks move to History automatically.
          Click a due date to change it — <span className="text-amber-700 font-semibold">amber</span> means it's been changed from the original.
          Every change shows a <span className="text-emerald-600 font-semibold">Saved</span> confirmation.
          {user.role === 'super_admin'
            ? ' As Super Admin, you can delete any task.'
            : ['leader', 'admin'].includes(user.role)
              ? ' You can delete a task you created yourself — not one someone else logged.'
              : ' Only a Leader or Admin can delete a task.'}
          {' '}Tick the checkboxes to complete or reschedule several tasks at once.
        </p>
        {!readOnly && showCreate && (
          <Button data-tour="create-task-button" onClick={() => setShowForm(true)} className="shrink-0">
            <Plus className="w-4 h-4" /> Create Task
          </Button>
        )}
      </div>

      {!readOnly && showCreate && (
        <Modal open={showForm} onClose={() => setShowForm(false)} title="Create Task" wide>
          <CreateTaskForm
            assignees={assignees}
            onCreated={() => {
              setShowForm(false);
              load();
            }}
          />
        </Modal>
      )}

      {requestModal && (
        <RequestModal
          task={requestModal.task}
          kind={requestModal.kind}
          onClose={() => setRequestModal(null)}
          onSubmitted={(msg) => { setRequestModal(null); load(msg); }}
        />
      )}

      <ErrorBanner message={deleteError} />
      {notice && (
        <div className="flex items-center gap-2 text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-3.5 py-2 text-sm mb-3 animate-scale-in">
          <Check className="w-4 h-4 shrink-0" /> {notice}
        </div>
      )}

      {tasks.length > 0 && (
        <div className="bg-grey-50 rounded-xl p-3.5 mb-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-grey-500 mb-2 uppercase tracking-wide">
            <Filter className="w-3.5 h-3.5" /> Filter
          </div>
          <div className="grid sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
            <Select value={filters.employee} onChange={(e) => setFilters((f) => ({ ...f, employee: e.target.value }))}>
              <option value="">All employees</option>
              {employeeOptions.map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
            <Select value={filters.type} onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))}>
              <option value="">All types</option>
              <option value="recurring">Recurring</option>
              <option value="adhoc">Ad-hoc</option>
            </Select>
            <Select value={filters.category} onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value }))}>
              <option value="">All subtasks</option>
              {categoryOptions.map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
            <Select value={filters.mainTask} onChange={(e) => setFilters((f) => ({ ...f, mainTask: e.target.value }))}>
              <option value="">All main tasks</option>
              {mainTaskOptions.map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
            <Select value={filters.priority} onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value }))}>
              <option value="">All priorities</option>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </Select>
            <Select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
              <option value="">All statuses</option>
              <option value="pending">Pending</option>
              <option value="in_progress">In Progress</option>
              <option value="completed">Completed</option>
              <option value="support_required">Support Required</option>
            </Select>
          </div>
          <div className="flex flex-wrap items-center gap-4 mt-3 pt-3 border-t border-grey-200">
            {filtersActive && (
              <button onClick={() => setFilters(EMPTY_TASK_FILTERS)} className="inline-flex items-center gap-1 text-xs font-medium text-grey-500 hover:text-grey-700 transition-colors">
                <XCircle className="w-3.5 h-3.5" /> Clear Filters
              </button>
            )}
            <button onClick={exportCsv} className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-800 transition-colors">
              <Download className="w-3.5 h-3.5" /> Export to CSV
            </button>
            <span className="text-xs text-grey-400">{filteredTasks.length} of {tasks.length} task{tasks.length === 1 ? '' : 's'}</span>
          </div>
        </div>
      )}

      {!readOnly && selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 bg-brand-50 border border-brand-100 rounded-xl px-3.5 py-2.5 mb-3 animate-scale-in">
          <span className="text-sm font-semibold text-brand-800">{selectedIds.size} selected</span>
          <Button size="sm" disabled={bulkBusy} onClick={bulkComplete}><Check className="w-3.5 h-3.5" /> Mark Completed</Button>
          {quickPickDates().map(([label, dateVal]) => (
            <Button key={label} size="sm" variant="secondary" disabled={bulkBusy} onClick={() => bulkReschedule(dateVal)}>
              Reschedule → {label}
            </Button>
          ))}
          {user.role === 'super_admin' && (
            <DeleteButton
              label={`Delete ${selectedIds.size} task${selectedIds.size === 1 ? '' : 's'}`}
              confirmLabel={`Permanently delete ${selectedIds.size} task${selectedIds.size === 1 ? '' : 's'}?`}
              disabled={bulkBusy}
              onConfirm={bulkDelete}
            />
          )}
          <button onClick={() => setSelectedIds(new Set())} className="text-xs font-medium text-grey-500 hover:text-grey-700 transition-colors ml-1">
            Clear selection
          </button>
          {bulkBusy && <span className="text-xs text-grey-400">Working…</span>}
        </div>
      )}
      <ErrorBanner message={bulkError} />

      {filteredTasks.length === 0 ? (
        <EmptyState
          icon={tasks.length === 0
            ? <IllustrationEmptyList className="w-16 h-16 mx-auto" />
            : <IllustrationSearch className="w-16 h-16 mx-auto" />}
          title={tasks.length === 0 ? 'No open tasks' : 'No tasks match these filters'}
        >
          {tasks.length === 0
            ? (readOnly || !showCreate ? 'Nothing here right now.' : 'Create the first task using the button above, or check back — completed tasks move to History.')
            : 'Try clearing a filter above.'}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto mt-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-grey-500 border-b border-grey-200">
                {!readOnly && selectableTasks.length > 0 && (
                  <th className="py-2 pr-2 w-8">
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={selectedIds.size === selectableTasks.length}
                      onChange={() => setSelectedIds(selectedIds.size === selectableTasks.length ? new Set() : new Set(selectableTasks.map((t) => t.id)))}
                      className="cursor-pointer"
                    />
                  </th>
                )}
                <th className="py-2 pr-4">Task</th>
                <th className="py-2 pr-4">Employee</th>
                <th className="py-2 pr-4">Type</th>
                <th className="py-2 pr-4">Subtask</th>
                <th className="py-2 pr-4">Main Task</th>
                <th className="py-2 pr-4">Priority</th>
                <th className="py-2 pr-4">Due</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4"></th>
              </tr>
            </thead>
            <tbody>
              {filteredTasks.map((t, i) => {
                const rowReadOnly = isRowReadOnly(t);
                const isOwnTask = t.employee_id === user.id;
                const canRequest = isOwnTask && !readOnly && t.status !== 'completed';
                return (
                <tr key={t.id} className="border-b border-grey-100 hover:bg-grey-50 transition-colors animate-fade-in-up" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                  {!readOnly && selectableTasks.length > 0 && (
                    <td className="py-2.5 pr-2">
                      {!rowReadOnly && (
                        <input type="checkbox" checked={selectedIds.has(t.id)} onChange={() => toggleSelect(t.id)} className="cursor-pointer" aria-label={`Select ${t.description}`} />
                      )}
                    </td>
                  )}
                  <td className="py-2.5 pr-4 font-semibold text-grey-800 max-w-[280px]">
                    {t.description}
                    {t.status === 'support_required' && (t.non_completion_reason || t.non_completion_explanation) && (
                      <div className="flex items-start gap-1 mt-1 text-xs font-normal text-accent-700 bg-accent-50 rounded-lg px-2 py-1">
                        <MessageSquareText className="w-3 h-3 mt-0.5 shrink-0" />
                        <span>
                          {t.non_completion_reason && <strong>{t.non_completion_reason}</strong>}
                          {t.non_completion_reason && t.non_completion_explanation && ' — '}
                          {t.non_completion_explanation}
                        </span>
                      </div>
                    )}
                  </td>
                  <td className="py-2.5 pr-4 text-grey-600">{t.employee_name}</td>
                  <td className="py-2.5 pr-4">
                    <Badge tone={t.type}>{t.task_type_name || t.type}</Badge>
                    {t.type === 'recurring' && t.recurring_frequency && (
                      <div className="text-xs text-grey-400 mt-0.5 flex items-center gap-1">
                        <Repeat className="w-3 h-3" /> {t.recurring_frequency}
                      </div>
                    )}
                  </td>
                  <td className="py-2.5 pr-4 text-grey-600">{t.category_name || <span className="text-grey-300">—</span>}</td>
                  <td className="py-2.5 pr-4 text-grey-600">{t.main_task_name || <span className="text-grey-300">—</span>}</td>
                  <td className="py-2.5 pr-4"><Badge tone={t.priority}>{t.priority}</Badge></td>
                  <td className="py-2.5 pr-4">
                    {rowReadOnly ? (
                      <StaticDueDate task={t} />
                    ) : (
                      <DueDateCell task={t} onChanged={load} />
                    )}
                  </td>
                  <td className="py-2.5 pr-4">
                    {rowReadOnly ? <Badge tone={t.status}>{t.status}</Badge> : <StatusDropdown task={t} onChanged={load} />}
                  </td>
                  <td className="py-2.5 pr-4">
                    <div className="flex items-center gap-2">
                      {canRequest && (
                        <>
                          <button
                            type="button"
                            title="Request support"
                            onClick={() => setRequestModal({ task: t, kind: 'support' })}
                            className="text-grey-400 hover:text-accent-600 transition-colors press-scale"
                          >
                            <LifeBuoy className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            title="Request a due-date change"
                            onClick={() => setRequestModal({ task: t, kind: 'due_date_change' })}
                            className="text-grey-400 hover:text-brand-600 transition-colors press-scale"
                          >
                            <CalendarClock className="w-4 h-4" />
                          </button>
                        </>
                      )}
                      {!rowReadOnly && (
                        <DeleteButton
                          confirmLabel="Delete?"
                          disabled={user.role === 'super_admin' ? false : (t.created_by !== user.id || !['leader', 'admin'].includes(user.role))}
                          onConfirm={() => remove(t)}
                        />
                      )}
                    </div>
                  </td>
                </tr>
              );})}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Support Required is deliberately NOT selectable here — it must always come with a reason, which only
// the Request Support modal (the LifeBuoy icon) collects. Offering it as a bare option let anyone bypass
// that modal and land a reason-less request in the Leader's inbox. A task that's already Support Required
// still needs to show that state and let someone move it on, so the current status is always included.
const STATUS_OPTIONS = [
  ['pending', 'Pending'],
  ['in_progress', 'In Progress'],
  ['completed', 'Completed'],
];

function StatusDropdown({ task, onChanged }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [justSaved, setJustSaved] = useState(false);
  const options = STATUS_OPTIONS.some(([v]) => v === task.status)
    ? STATUS_OPTIONS
    : [[task.status, humanize(task.status)], ...STATUS_OPTIONS];

  async function change(e) {
    const status = e.target.value;
    if (status === task.status) return;
    setSaving(true);
    setError('');
    try {
      const res = await api.post(`/scrum/commitments/${task.id}/resolve`, { status });
      if (res.next_occurrence) onChanged(`Next one due ${res.next_occurrence.due_date}.`);
      else onChanged();
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <select
        value={task.status}
        onChange={change}
        disabled={saving}
        className={`text-xs font-semibold rounded-full px-2.5 py-2 sm:py-1 border-0 min-h-[40px] sm:min-h-0 cursor-pointer transition-opacity ${saving ? 'opacity-60' : ''} ${badgeClass(task.status)}`}
      >
        {options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </select>
      {justSaved && (
        <div className="text-emerald-600 text-xs mt-1 flex items-center gap-1 animate-scale-in">
          <Check className="w-3 h-3" /> Saved
        </div>
      )}
      {error && <div className="text-accent-600 text-xs mt-1">{error}</div>}
    </div>
  );
}

/** True once due_date has moved away from the original — i.e. it's been Carried Forward at least once. */
function wasChanged(task) {
  return task.original_due_date && task.due_date !== task.original_due_date;
}

function StaticDueDate({ task }) {
  const changed = wasChanged(task);
  return (
    <div>
      <span className={`inline-flex items-center gap-1 ${changed ? 'text-amber-700 font-semibold' : 'text-grey-700'}`} title={changed ? `Originally due ${task.original_due_date}` : undefined}>
        {task.due_date}
        {changed && <RotateCw className="w-3 h-3" />}
      </span>
      {task.delay_days > 0 && (
        <div className="text-accent-600 font-semibold text-xs flex items-center gap-1 mt-0.5">
          <AlertTriangle className="w-3 h-3" /> {task.delay_days}d delayed
        </div>
      )}
    </div>
  );
}

/** Tomorrow / next Monday / a week out — the three dates a leader reaches for most when pushing a task out. */
function quickPickDates() {
  const mk = (d) => d.toISOString().slice(0, 10);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  const nextMonday = new Date();
  const untilMonday = (8 - nextMonday.getDay()) % 7 || 7;
  nextMonday.setDate(nextMonday.getDate() + untilMonday);

  const inAWeek = new Date();
  inAWeek.setDate(inAWeek.getDate() + 7);

  return [
    ['Tomorrow', mk(tomorrow)],
    ['Next Monday', mk(nextMonday)],
    ['In a week', mk(inAWeek)],
  ];
}

function DueDateCell({ task, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [justSaved, setJustSaved] = useState(false);
  const changed = wasChanged(task);

  async function save(newDate) {
    setEditing(false);
    if (!newDate || newDate === task.due_date) return;
    setSaving(true);
    setError('');
    try {
      await api.post(`/scrum/commitments/${task.id}/carry-forward`, { new_due_date: newDate });
      onChanged();
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="space-y-1.5 animate-scale-in">
        <input
          type="date"
          autoFocus
          defaultValue={task.due_date}
          disabled={saving}
          onChange={(e) => save(e.target.value)}
          onBlur={() => setEditing(false)}
          className="text-xs border border-grey-300 rounded-lg px-2 py-1.5 min-h-[36px] focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500"
        />
        <div className="flex flex-wrap gap-1">
          {quickPickDates().map(([label, date]) => (
            <button
              key={label}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => save(date)}
              className="text-xs bg-grey-100 hover:bg-brand-100 hover:text-brand-700 text-grey-700 rounded-full px-2.5 py-1.5 min-h-[32px] transition-colors"
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setEditing(true)}
        disabled={saving}
        className={`inline-flex items-center gap-1 text-left hover:underline decoration-dotted py-1.5 sm:py-0 min-h-[36px] sm:min-h-0 transition-colors ${changed ? 'text-amber-700 font-semibold' : 'text-grey-700 hover:text-brand-700'}`}
        title={changed ? `Originally due ${task.original_due_date} — click to change again` : 'Click to change the due date'}
      >
        {saving ? 'Saving…' : task.due_date}
        {changed && !saving && <RotateCw className="w-3 h-3" />}
      </button>
      {justSaved && (
        <div className="text-emerald-600 text-xs flex items-center gap-1 animate-scale-in">
          <Check className="w-3 h-3" /> Saved
        </div>
      )}
      {task.delay_days > 0 && (
        <div className="text-accent-600 font-semibold text-xs flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" /> {task.delay_days}d delayed
        </div>
      )}
      {error && <div className="text-accent-600 text-xs">{error}</div>}
    </div>
  );
}

function badgeClass(status) {
  if (status === 'completed') return 'bg-emerald-100 text-emerald-700';
  if (status === 'support_required') return 'bg-accent-100 text-accent-700';
  if (status === 'in_progress') return 'bg-brand-100 text-brand-700';
  return 'bg-grey-100 text-grey-600';
}

function CreateTaskForm({ assignees: assigneesProp, onCreated }) {
  const { user } = useAuth();
  // Whoever's creating the task can always assign it to themselves too — without this a Leader could
  // only ever assign tasks to their team, never to themselves.
  const assignees = assigneesProp.some((a) => a.employee_id === user.id)
    ? assigneesProp
    : [...assigneesProp, { employee_id: user.id, full_name: `${user.full_name} (you)` }];
  const [employeeId, setEmployeeId] = useState(assignees[0]?.employee_id || user.id);
  const [description, setDescription] = useState('');
  const [taskTypes, setTaskTypes] = useState([]);
  const [taskTypeId, setTaskTypeId] = useState('');
  const [categories, setCategories] = useState([]);
  const [categoryId, setCategoryId] = useState('');
  const [mainTasks, setMainTasks] = useState([]);
  const [mainTaskId, setMainTaskId] = useState('');
  const [recurrenceRule, setRecurrenceRule] = useState(DEFAULT_RULE);
  const [priority, setPriority] = useState('Medium');
  const [dueDate, setDueDate] = useState(today);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    api.get('/task-types').then((d) => {
      const active = d.task_types.filter((t) => t.is_active);
      setTaskTypes(active);
      setTaskTypeId((v) => v || active.find((t) => t.mechanic === 'adhoc')?.id || active[0]?.id || '');
    }).catch(() => setLoadError("Couldn't load Task Types — try closing and reopening this form."));
    api.get('/categories').then((d) => setCategories(d.categories.filter((c) => c.is_active))).catch(() => setLoadError("Couldn't load Subtasks — try closing and reopening this form."));
    api.get('/main-tasks').then((d) => setMainTasks(d.main_tasks.filter((m) => m.is_active))).catch(() => setLoadError("Couldn't load Main Tasks — try closing and reopening this form."));
  }, []);

  const selectedType = taskTypes.find((t) => t.id === taskTypeId);
  const isRecurring = selectedType?.mechanic === 'recurring';
  const mainTasksForCategory = mainTasks.filter((m) => !categoryId || m.category_id === categoryId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (mainTaskId && !mainTasksForCategory.some((m) => m.id === mainTaskId)) setMainTaskId('');
  }, [categoryId, mainTasks]);

  async function create() {
    setError('');
    if (!employeeId) return setError('Choose who this task is for.');
    if (!description.trim()) return setError('Please describe the task.');
    setSaving(true);
    try {
      await api.post('/scrum/commitments', {
        employee_id: employeeId, description, task_type_id: taskTypeId || undefined, category_id: categoryId || undefined, main_task_id: mainTaskId || undefined, priority, due_date: dueDate,
        recurrence_rule: isRecurring ? recurrenceRule : undefined,
      });
      setDescription('');
      onCreated();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid sm:grid-cols-2 gap-3">
        {assignees.length > 1 ? (
          <Select label="Assign to" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            {assignees.map((m) => <option key={m.employee_id} value={m.employee_id}>{m.full_name}</option>)}
          </Select>
        ) : (
          <div>
            <span className="block text-sm font-medium text-grey-700 mb-1">Assign to</span>
            <div className="text-sm text-grey-500 px-3 py-2 bg-grey-50 rounded-xl border border-grey-200">You</div>
          </div>
        )}
        <Input label="Due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      </div>
      <Textarea required label="Task description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Follow up with Procurement on the approved PR" />
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Select label="Type" value={taskTypeId} onChange={(e) => setTaskTypeId(e.target.value)}>
          {taskTypes.map((t) => <option key={t.id} value={t.id}>{t.name}{t.mechanic === 'recurring' ? ' (repeats)' : ''}</option>)}
        </Select>
        <Select label="Subtask" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">None</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Select label="Main Task" value={mainTaskId} onChange={(e) => setMainTaskId(e.target.value)}>
          <option value="">None</option>
          {mainTasksForCategory.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </Select>
        <Select label={<>Priority<InfoTip term="priority" /></>} value={priority} onChange={(e) => setPriority(e.target.value)}>
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
      </div>
      {isRecurring && <RecurrencePicker value={recurrenceRule} onChange={setRecurrenceRule} />}
      <ErrorBanner message={loadError} />
      <ErrorBanner message={error} />
      <Button variant="secondary" onClick={create} disabled={saving}>{saving ? 'Creating…' : <><Plus className="w-4 h-4" /> Create Task</>}</Button>
    </div>
  );
}

const SUPPORT_REASONS = ['Workload', 'Finance', 'Procurement', 'Approval', 'Management', 'Customer', 'Vendor', 'Technical', 'Information pending', 'Priority changed', 'Other'];

/** "Request Support" / "Request a Due-Date Change" — both create a `requests` row for a Leader to review
 *  in the Requests inbox; neither changes the task itself until a Leader approves it (see routes/requests.js). */
function RequestModal({ task, kind, onClose, onSubmitted }) {
  const isSupport = kind === 'support';
  const [reason, setReason] = useState(SUPPORT_REASONS[0]);
  const [explanation, setExplanation] = useState('');
  const [requestedDate, setRequestedDate] = useState(task.due_date);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    if (isSupport && !explanation.trim()) return setError('Please describe what help you need.');
    if (!isSupport && !requestedDate) return setError('Please choose the date you want to request.');
    if (!isSupport && requestedDate === task.due_date) return setError("That's already this task's due date — choose a different one.");
    setSaving(true);
    try {
      if (isSupport) {
        await api.post(`/scrum/commitments/${task.id}/resolve`, {
          status: 'support_required', non_completion_reason: reason, non_completion_explanation: explanation,
        });
        onSubmitted('Support requested — your leader will review it.');
      } else {
        await api.post(`/scrum/commitments/${task.id}/request-due-date-change`, { requested_due_date: requestedDate });
        onSubmitted('Due-date change requested — your leader will review it.');
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={isSupport ? 'Request Support' : 'Request a Due-Date Change'}>
      <div className="space-y-3">
        <p className="text-sm text-grey-600 flex items-center">{task.description}{isSupport && <InfoTip term="supportRequest" />}</p>
        {isSupport ? (
          <>
            <Select label="What kind of support?" value={reason} onChange={(e) => setReason(e.target.value)}>
              {SUPPORT_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </Select>
            <Textarea required label="What help do you need?" value={explanation} onChange={(e) => setExplanation(e.target.value)} placeholder="Describe what's blocking you and what would help…" />
          </>
        ) : (
          <Input required label="Requested due date" type="date" value={requestedDate} onChange={(e) => setRequestedDate(e.target.value)} />
        )}
        <ErrorBanner message={error} />
        <Button onClick={submit} disabled={saving}>{saving ? 'Submitting…' : 'Submit Request'}</Button>
      </div>
    </Modal>
  );
}
