import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Plus, RotateCw, Check, AlertTriangle, Repeat, Filter, Download, XCircle, MessageSquareText, LifeBuoy,
  CalendarClock, History as HistoryIcon, User, X, ArrowUpDown, ArrowUp, ArrowDown, ChevronLeft, ChevronRight, Pencil,
  Tag, ListTree, ListChecks, Calendar, UserCheck, Flag,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { getBusinessDate } from '../lib/businessDate';
import { badgeClassFor, Badge, Button, DeleteButton, EmptyState, ErrorBanner, humanize, IllustrationEmptyList, IllustrationSearch, Input, Modal, Select, Skeleton, Textarea } from './ui';
import RecurrencePicker, { DEFAULT_RULE } from './RecurrencePicker';
import InfoTip from './InfoTip';
import ImportButton from './ImportButton';
import AuditTimeline from './AuditTimeline';

const PRIORITIES = ['Low', 'Medium', 'High'];
const STATUS_SORT_ORDER = ['pending', 'in_progress', 'support_required', 'completed'];
const FILTER_COLUMNS = [
  { key: 'taskId', label: 'Task ID', sortKey: 'code' },
  { key: 'task', label: 'Task', sortKey: 'task' },
  { key: 'employee', label: 'Employee', sortKey: 'employee' },
  { key: 'type', label: 'Type', sortKey: null },
  { key: 'mainTask', label: 'Process', sortKey: null },
  { key: 'priority', label: 'Priority', sortKey: 'priority' },
  { key: 'due', label: 'Due', sortKey: 'due' },
  { key: 'status', label: 'Status', sortKey: 'status' },
];
const FILTER_KEYS = FILTER_COLUMNS.map((c) => c.key);
// Each column holds the raw values to SHOW; [] is Excel's "Select All", i.e. unfiltered.
const EMPTY_TASK_FILTERS = Object.fromEntries(FILTER_KEYS.map((k) => [k, []]));
// These three cells render through Badge, which humanizes; the rest show raw text, so their labels must too.
const HUMANIZED_KEYS = ['type', 'priority', 'status'];
const BLANK_LABEL = '(Blanks)';
const today = getBusinessDate();
const PAGE_SIZE = 25;
const POPOVER_WIDTH = 256;
const POPOVER_MIN_HEIGHT = 280;

function csvEscape(v) {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

const alwaysTrue = () => true;

/** The task's permanent, human-readable reference — same code format History already uses for the same
 *  row (TSK-000123, derived from the database's own row sequence). */
function taskCode(t) {
  return t.seq ? `TSK-${String(t.seq).padStart(6, '0')}` : '—';
}

/** One line describing what, if anything, this task needs from its viewer right now — a pending request
 *  waiting on review takes priority (it's a decision someone owes), then overdue, then nothing. Not shown
 *  for a row the viewer can't act on — there's no "action required" from someone who can't take it. */
function actionRequired(t) {
  if (t.pending_request_id) {
    return t.pending_request_type === 'due_date_change'
      ? { label: `Approve date → ${t.pending_request_due_date}`, tone: 'recurring' }
      : { label: 'Review support request', tone: 'support_required' };
  }
  if (t.delay_days > 0) return { label: `${t.delay_days}d overdue`, tone: 'support_required' };
  return null;
}

/** Ascending comparator for the sortable columns — a small fixed set (not user-defined key paths), so a
 *  plain switch is clearer than a generic accessor-function table nobody would reuse elsewhere. */
function compareTasks(a, b, sortBy) {
  switch (sortBy) {
    case 'code': return (a.seq || 0) - (b.seq || 0);
    case 'task': return (a.description || '').localeCompare(b.description || '');
    case 'employee': return (a.employee_name || '').localeCompare(b.employee_name || '');
    case 'due': return (a.due_date || '').localeCompare(b.due_date || '');
    case 'priority': return PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority);
    case 'status': return (a.status || '').localeCompare(b.status || '');
    default: return 0;
  }
}

/** A task with no named Task Type (older imports) falls back to the seeded default type's own name for its
 *  mechanic, so it reads, and filters, the same as a task that does carry that default type — not as a
 *  second "Recurring" or an "Adhoc" next to "Ad-Hoc". */
function typeLabel(t) {
  if (t.task_type_name) return t.task_type_name;
  if (t.type === 'recurring') return 'Recurring';
  if (t.type === 'adhoc') return 'Ad-hoc';
  return t.type || '';
}

/** The raw value a column filter matches against — what that column's cell displays. */
function columnRawValue(t, key) {
  switch (key) {
    case 'taskId': return t.seq ? taskCode(t) : '';
    case 'task': return t.description || '';
    case 'employee': return t.employee_name || '';
    case 'type': return typeLabel(t);
    case 'mainTask': return t.main_task_name || '';
    case 'priority': return t.priority || '';
    case 'due': return t.due_date || '';
    case 'status': return t.status || '';
    default: return '';
  }
}

function optionLabel(key, value) {
  if (value === '') return BLANK_LABEL;
  return HUMANIZED_KEYS.includes(key) ? humanize(value) : value;
}

// Built from the loaded rows (like Excel's own column filter), not the org's master lists — a value with
// no rows in this table would only ever filter down to nothing. Empty cells get a "(Blanks)" entry,
// otherwise unticking one Process would silently hide every task that has no Process at all.
function uniqueColumnOptions(tasks, key) {
  const values = [...new Set(tasks.map((t) => columnRawValue(t, key)))];
  const present = values.filter(Boolean);
  if (key === 'priority') present.sort((a, b) => PRIORITIES.indexOf(a) - PRIORITIES.indexOf(b));
  else if (key === 'status') present.sort((a, b) => STATUS_SORT_ORDER.indexOf(a) - STATUS_SORT_ORDER.indexOf(b));
  else present.sort((a, b) => a.localeCompare(b));
  if (values.includes('')) present.push('');
  return present.map((v) => ({ value: v, label: optionLabel(key, v) }));
}

function hasFilterValue(v) {
  return v.length > 0;
}

// A value that's ticked but whose last row just left the table (say, that task was completed) must still be
// listed, ticked and untickable. Otherwise the column looks unfiltered while it hides everything.
function withSelectedValues(options, selected, key) {
  const present = new Set(options.map((o) => o.value));
  const missing = selected.filter((v) => !present.has(v));
  if (missing.length === 0) return options;
  return [...options, ...missing.map((v) => ({ value: v, label: optionLabel(key, v), stale: true }))];
}

// Measured against the visual viewport (what's actually on screen, excluding a phone's open keyboard).
// Opens below the header button, or above when that side has more room; never shorter than
// POPOVER_MIN_HEIGHT, sliding over the header if it must, so the option list can't collapse to nothing.
// `renderedHeight` (once known) lets that slide stop at the popover's real height, not its maximum.
function popoverPosition(anchorEl, renderedHeight) {
  const rect = anchorEl.getBoundingClientRect();
  const vv = window.visualViewport;
  const viewTop = vv ? vv.offsetTop : 0;
  const viewLeft = vv ? vv.offsetLeft : 0;
  const viewBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  const viewRight = vv ? vv.offsetLeft + vv.width : window.innerWidth;
  const viewHeight = viewBottom - viewTop;
  const width = Math.min(POPOVER_WIDTH, viewRight - viewLeft - 16);
  const left = Math.max(viewLeft + 8, Math.min(rect.left, viewRight - width - 8));
  const below = viewBottom - rect.bottom - 14;
  const above = rect.top - viewTop - 14;
  const openBelow = below >= POPOVER_MIN_HEIGHT || below >= above;
  const maxHeight = Math.min(420, viewHeight - 16, Math.max(openBelow ? below : above, POPOVER_MIN_HEIGHT));
  const height = renderedHeight ? Math.min(renderedHeight, maxHeight) : maxHeight;
  if (openBelow) {
    return { top: Math.max(viewTop + 8, Math.min(rect.bottom + 6, viewBottom - 8 - height)), left, width, maxHeight };
  }
  const bottom = window.innerHeight - viewBottom + 8;
  return { bottom: Math.max(bottom, Math.min(window.innerHeight - rect.top + 6, window.innerHeight - viewTop - 8 - height)), left, width, maxHeight };
}

/** Excel-style per-column filter menu. Portaled to document.body and fixed-positioned under its header
 *  button, same reason Modal portals: this app's animate-* classes leave a lingering transform on
 *  ancestors, which would otherwise re-anchor `position: fixed` and clip it inside the table's
 *  overflow-x-auto wrapper. z-10 keeps it under the sticky top nav (z-20) and Modals (z-50), so on scroll
 *  it slides beneath the nav like an attached dropdown instead of painting over it.
 *
 *  Excel semantics: an unfiltered column opens with everything ticked. Typing in the search box pre-ticks
 *  every match in a separate selection ("Select All Search Results"), and Apply then shows exactly those.
 *  Edits stay local until Apply. */
function ColumnFilterPopover({ column, currentValue, options, anchorEl, onApply, onClear, onClose }) {
  const [checked, setChecked] = useState(() => new Set(currentValue.length ? currentValue : options.map((o) => o.value)));
  const [searchChecked, setSearchChecked] = useState(() => new Set());
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState(() => popoverPosition(anchorEl));
  // On a touch screen, autofocusing the search box pops the keyboard up over the checkboxes.
  const [finePointer] = useState(() => window.matchMedia?.('(pointer: fine)').matches ?? true);
  const popoverRef = useRef(null);

  // Keyboard-driven closes hand focus back to the funnel button. An outside click doesn't, since that
  // click has already put focus where the user wanted it.
  const closeToAnchor = useCallback((action) => { action(); anchorEl.focus(); }, [anchorEl]);

  useEffect(() => {
    function onPointerDown(e) {
      if (popoverRef.current?.contains(e.target) || anchorEl.contains(e.target)) return;
      onClose();
    }
    function onKey(e) {
      if (e.key === 'Escape') { closeToAnchor(onClose); return; }
      // Portaled to the end of <body>, so without this Tab would walk straight off the page.
      if (e.key !== 'Tab' || !popoverRef.current?.contains(document.activeElement)) return;
      const focusable = popoverRef.current.querySelectorAll('button:not([disabled]), input:not([disabled])');
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === popoverRef.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorEl, onClose, closeToAnchor]);

  // Re-measure every frame while open rather than only on scroll/resize: a notice appearing or vanishing
  // above the table shifts the header without firing either event. One rect read per frame, and a
  // re-render only when the position actually changes.
  useEffect(() => {
    let frame = 0;
    let last = JSON.stringify(popoverPosition(anchorEl));
    function track() {
      if (!anchorEl.isConnected) { onClose(); return; }
      const next = popoverPosition(anchorEl, popoverRef.current?.offsetHeight);
      const key = JSON.stringify(next);
      if (key !== last) { last = key; setPos(next); }
      frame = requestAnimationFrame(track);
    }
    frame = requestAnimationFrame(track);
    return () => cancelAnimationFrame(frame);
  }, [anchorEl, onClose]);

  const matches = (term) => (o) => o.label.toLowerCase().includes(term);
  const searching = query.trim() !== '';
  const visibleOptions = searching ? options.filter(matches(query.trim().toLowerCase())) : options;
  const selection = searching ? searchChecked : checked;
  const setSelection = searching ? setSearchChecked : setChecked;
  const allVisibleChecked = visibleOptions.length > 0 && visibleOptions.every((o) => selection.has(o.value));
  const someVisibleChecked = visibleOptions.some((o) => selection.has(o.value));

  function onSearch(e) {
    const q = e.target.value;
    setQuery(q);
    setSearchChecked(new Set(options.filter(matches(q.trim().toLowerCase())).map((o) => o.value)));
  }

  function toggleOption(value) {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value); else next.add(value);
      return next;
    });
  }

  function toggleAll() {
    setSelection((prev) => {
      const next = new Set(prev);
      visibleOptions.forEach((o) => (allVisibleChecked ? next.delete(o.value) : next.add(o.value)));
      return next;
    });
  }

  function apply() {
    if (!someVisibleChecked) return;
    const values = [...selection];
    // Every value ticked is Excel's unfiltered state — store it as [] so the column isn't flagged as filtered.
    closeToAnchor(() => onApply(values.length === options.length ? [] : values));
  }

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={`Filter ${column.label}`}
      tabIndex={-1}
      style={{ position: 'fixed', ...pos }}
      className="z-10 bg-white rounded-xl border border-grey-200 shadow-xl shadow-grey-900/15 flex flex-col overflow-y-auto focus:outline-none animate-scale-in"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-grey-100 shrink-0">
        <span className="text-xs font-semibold text-grey-700">Filter: {column.label}</span>
        <button type="button" onClick={() => closeToAnchor(onClose)} aria-label="Close filter" className="text-grey-400 hover:text-grey-700 transition-colors press-scale">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="px-2.5 pt-2.5 shrink-0">
        <Input
          autoFocus={finePointer}
          value={query}
          onChange={onSearch}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }}
          placeholder={`Search ${column.label}…`}
          aria-label={`Search ${column.label} values`}
          className="py-1.5! text-xs!"
        />
        <label className="flex items-center gap-2 text-xs font-semibold text-grey-700 px-1.5 py-1.5 mt-1.5 border-b border-grey-100 cursor-pointer">
          <input
            type="checkbox"
            checked={allVisibleChecked}
            ref={(el) => { if (el) el.indeterminate = someVisibleChecked && !allVisibleChecked; }}
            onChange={toggleAll}
            disabled={visibleOptions.length === 0}
            className="cursor-pointer"
          />
          {searching ? 'Select All Search Results' : 'Select All'}
        </label>
      </div>

      <div className="flex-1 min-h-16 max-h-60 overflow-y-auto px-2.5 py-1">
        {visibleOptions.length === 0 ? (
          <p className="text-xs text-grey-400 px-1.5 py-2">No matches.</p>
        ) : visibleOptions.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-xs text-grey-700 px-1.5 py-1.5 rounded-md hover:bg-grey-50 cursor-pointer">
            <input type="checkbox" checked={selection.has(o.value)} onChange={() => toggleOption(o.value)} className="cursor-pointer shrink-0" />
            <span className={`truncate ${o.value === '' ? 'italic text-grey-500' : ''}`}>{o.label}</span>
            {o.stale && <span className="ml-auto shrink-0 text-grey-400">no open tasks</span>}
          </label>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-grey-100 shrink-0">
        <button type="button" onClick={() => closeToAnchor(onClear)} className="text-xs font-medium text-grey-500 hover:text-grey-800 transition-colors press-scale">
          Clear
        </button>
        <Button size="sm" onClick={apply} disabled={!someVisibleChecked}>Apply</Button>
      </div>
    </div>,
    document.body
  );
}

function DetailField({ icon: Icon, label, value }) {
  return (
    <div className="flex items-start gap-2.5 bg-grey-50 border border-grey-100 rounded-lg px-3 py-2.5">
      <Icon className="w-4 h-4 mt-0.5 shrink-0 text-grey-400" />
      <div className="min-w-0">
        <div className="text-xs text-grey-400">{label}</div>
        <div className="text-sm text-grey-800 font-medium truncate">{value || '—'}</div>
      </div>
    </div>
  );
}

/** Shared list+bulk+inline-edit table, reused by "My Tasks" and the org-wide "Team Tasks" page. `fetchUrl`
 *  picks the data source; `assignees` is who a new task can be created for; `canActOn(task)` (default:
 *  everyone can) decides per row whether the status/date/delete controls are live or read-only, layered
 *  on top of the list-wide `readOnly`; `showCreate` hides the Create Task button entirely for pages (like
 *  the org-wide view) that don't want a second creation surface. */
export default function TeamTaskList({ assignees: assigneesProp, readOnly, date = today, fetchUrl = '/leader/org-tasks', canActOn = alwaysTrue, showCreate = true }) {
  const { user } = useAuth();
  const assignees = assigneesProp || [];
  const [tasks, setTasks] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [notice, setNotice] = useState('');
  const [filters, setFilters] = useState(EMPTY_TASK_FILTERS);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState('');
  const [requestModal, setRequestModal] = useState(null); // { task, kind: 'support' | 'due_date_change' }
  const [detailTask, setDetailTask] = useState(null);
  const [editTask, setEditTask] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [sort, setSort] = useState({ by: 'due', dir: 'asc' });
  const [page, setPage] = useState(1);
  const [openFilter, setOpenFilter] = useState(null); // { key, anchorEl } — one column menu open at a time
  const isAdminTier = ['admin', 'super_admin'].includes(user.role);

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
  // A filter/sort change can easily land past the end of a page that used to exist — back to page 1
  // rather than showing an empty page the user has to notice and back out of themselves.
  useEffect(() => { setPage(1); }, [filters, sort, tasks]);

  // AND across columns: a row must be in every filtered column's allowed set.
  const filteredTasks = useMemo(() => {
    const active = FILTER_KEYS.filter((k) => filters[k].length > 0).map((k) => [k, new Set(filters[k])]);
    return (tasks || []).filter((t) => active.every(([k, allowed]) => allowed.has(columnRawValue(t, k))));
  }, [tasks, filters]);
  const columnOptions = useMemo(
    () => Object.fromEntries(FILTER_KEYS.map((k) => [k, uniqueColumnOptions(tasks || [], k)])),
    [tasks]
  );
  const closeFilter = useCallback(() => setOpenFilter(null), []);
  const sortedTasks = useMemo(() => {
    const copy = [...filteredTasks];
    copy.sort((a, b) => (sort.dir === 'asc' ? 1 : -1) * compareTasks(a, b, sort.by));
    return copy;
  }, [filteredTasks, sort]);
  const pageCount = Math.max(1, Math.ceil(sortedTasks.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pagedTasks = useMemo(() => sortedTasks.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE), [sortedTasks, currentPage]);
  const filtersActive = Object.values(filters).some(hasFilterValue);
  const isRowReadOnly = (t) => readOnly || !canActOn(t);
  // Selection/bulk actions only ever apply to what's visibly on screen — selecting "all" shouldn't
  // silently reach into pages the user isn't looking at.
  const selectableTasks = useMemo(() => pagedTasks.filter((t) => !isRowReadOnly(t)), [pagedTasks, readOnly, canActOn]);

  function toggleSort(by) {
    setSort((s) => (s.by === by ? { by, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { by, dir: 'asc' }));
  }

  function exportCsv() {
    const header = ['Task ID', 'Task', 'Employee', 'Type', 'Process', 'Activity', 'Priority', 'Due', 'Status'];
    const lines = [header.join(',')].concat(
      sortedTasks.map((t) => [taskCode(t), t.description, t.employee_name, t.task_type_name || t.type, t.main_task_name || '', t.task_activity_name || '', t.priority, t.due_date, t.status].map(csvEscape).join(','))
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
          {' '}Click a column name to sort, or its <Filter className="inline w-3 h-3 -mt-0.5" /> icon to filter.
        </p>
        {!readOnly && showCreate && (
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <ImportButton
              entityLabel="Tasks"
              headers={['employee_email', 'description', 'task_type_name', 'main_task_name', 'activity_name', 'reviewer_email', 'priority', 'due_date']}
              example={{ employee_email: 'jane@company.com', description: 'Complete HDFC Bank Reconciliation for August 2026', task_type_name: '', main_task_name: 'FP&A', activity_name: 'Bank Reconciliation', reviewer_email: '', priority: 'Medium', due_date: '' }}
              endpoint="/scrum/commitments/import"
              onDone={() => load()}
            />
            <Button data-tour="create-task-button" onClick={() => setShowForm(true)}>
              <Plus className="w-4 h-4" /> Create Task
            </Button>
          </div>
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

      {detailTask && <TaskDetailDrawer task={detailTask} onChanged={load} canAct={!isRowReadOnly(detailTask)} onClose={() => setDetailTask(null)} />}

      {openFilter && (
        <ColumnFilterPopover
          key={openFilter.key}
          column={FILTER_COLUMNS.find((c) => c.key === openFilter.key)}
          currentValue={filters[openFilter.key]}
          options={withSelectedValues(columnOptions[openFilter.key], filters[openFilter.key], openFilter.key)}
          anchorEl={openFilter.anchorEl}
          onApply={(value) => { setFilters((f) => ({ ...f, [openFilter.key]: value })); closeFilter(); }}
          onClear={() => { setFilters((f) => ({ ...f, [openFilter.key]: EMPTY_TASK_FILTERS[openFilter.key] })); closeFilter(); }}
          onClose={closeFilter}
        />
      )}

      <ErrorBanner message={deleteError} />
      {notice && (
        <div className="flex items-center gap-2 text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-3.5 py-2 text-sm mb-3 animate-scale-in">
          <Check className="w-4 h-4 shrink-0" /> {notice}
        </div>
      )}

      {tasks.length > 0 && (
        <div className="flex flex-wrap items-center gap-4 mb-1">
          <span className="text-xs text-grey-400">{filteredTasks.length} of {tasks.length} task{tasks.length === 1 ? '' : 's'}</span>
          <button onClick={exportCsv} className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-800 transition-colors">
            <Download className="w-3.5 h-3.5" /> Export to CSV
          </button>
          {filtersActive && (
            <button onClick={() => setFilters(EMPTY_TASK_FILTERS)} className="inline-flex items-center gap-1 text-xs font-medium text-grey-500 hover:text-grey-700 transition-colors">
              <XCircle className="w-3.5 h-3.5" /> Clear all filters
            </button>
          )}
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
              confirmLabel={`Permanently delete ${selectedIds.size} task${selectedIds.size === 1 ? '' : 's'}? This can't be undone.`}
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

      {tasks.length === 0 ? (
        <EmptyState icon={<IllustrationEmptyList className="w-16 h-16 mx-auto" />} title="No open tasks">
          {readOnly || !showCreate ? 'Nothing here right now.' : 'Create the first task using the button above, or check back — completed tasks move to History.'}
        </EmptyState>
      ) : (
        <>
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
                {FILTER_COLUMNS.map((col) => {
                  const sorted = col.sortKey && sort.by === col.sortKey;
                  const SortIcon = sorted ? (sort.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
                  const filtered = hasFilterValue(filters[col.key]);
                  const open = openFilter?.key === col.key;
                  return (
                    <th key={col.key} className="py-2 pr-4 whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        {col.sortKey ? (
                          <button type="button" onClick={() => toggleSort(col.sortKey)} title={`Sort by ${col.label}`} className="inline-flex items-center gap-1 hover:text-grey-800 transition-colors press-scale">
                            {col.label} <SortIcon className={`w-3 h-3 ${sorted ? 'text-brand-600' : 'text-grey-300'}`} />
                          </button>
                        ) : col.label}
                        <button
                          type="button"
                          onClick={(e) => setOpenFilter(open ? null : { key: col.key, anchorEl: e.currentTarget })}
                          aria-label={`Filter ${col.label}${filtered ? ' (active)' : ''}`}
                          aria-haspopup="dialog"
                          aria-expanded={open}
                          title={filtered ? `${col.label} is filtered` : `Filter ${col.label}`}
                          className={`w-5 h-5 rounded flex items-center justify-center transition-colors press-scale ${filtered ? 'text-white bg-brand-600 hover:bg-brand-700' : open ? 'text-brand-600 bg-brand-50' : 'text-grey-300 hover:text-grey-600 hover:bg-grey-100'}`}
                        >
                          <Filter className="w-3 h-3" />
                        </button>
                      </div>
                    </th>
                  );
                })}
                <th className="py-2 pr-4">Action</th>
                <th className="py-2 pr-4"></th>
              </tr>
            </thead>
            <tbody>
              {pagedTasks.map((t, i) => {
                const rowReadOnly = isRowReadOnly(t);
                const isOwnTask = t.employee_id === user.id;
                const canRequest = isOwnTask && !readOnly && t.status !== 'completed';
                const action = isRowReadOnly(t) ? null : actionRequired(t);
                return (
                <tr key={t.id} className="border-b border-grey-100 hover:bg-grey-50 transition-colors animate-fade-in-up" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                  {!readOnly && selectableTasks.length > 0 && (
                    <td className="py-2.5 pr-2">
                      {!rowReadOnly && (
                        <input type="checkbox" checked={selectedIds.has(t.id)} onChange={() => toggleSelect(t.id)} className="cursor-pointer" aria-label={`Select ${t.description}`} />
                      )}
                    </td>
                  )}
                  <td className="py-2.5 pr-4">
                    <button
                      type="button"
                      onClick={() => setDetailTask(t)}
                      className="font-mono text-xs font-semibold text-brand-700 bg-brand-50 hover:bg-brand-100 px-1.5 py-0.5 rounded-md border border-brand-100 transition-colors press-scale"
                      title="View task detail"
                    >
                      {taskCode(t)}
                    </button>
                  </td>
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
                    <Badge tone={t.type}>{typeLabel(t)}</Badge>
                    {t.type === 'recurring' && t.recurring_frequency && (
                      <div className="text-xs text-grey-400 mt-0.5 flex items-center gap-1">
                        <Repeat className="w-3 h-3" /> {t.recurring_frequency}
                      </div>
                    )}
                  </td>
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
                    {action ? (
                      <button
                        type="button"
                        onClick={() => setDetailTask(t)}
                        className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-lg press-scale transition-colors ${badgeClassFor(action.tone)}`}
                        title="Open task detail to act on this"
                      >
                        <AlertTriangle className="w-3 h-3" /> {action.label}
                      </button>
                    ) : <span className="text-grey-300">—</span>}
                  </td>
                  <td className="py-2.5 pr-4">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        title="View task detail"
                        onClick={() => setDetailTask(t)}
                        className="text-grey-400 hover:text-brand-600 transition-colors press-scale"
                      >
                        <HistoryIcon className="w-4 h-4" />
                      </button>
                      {isAdminTier && (
                        <button
                          type="button"
                          title="Edit task"
                          onClick={() => setEditTask(t)}
                          className="text-grey-400 hover:text-brand-600 transition-colors press-scale"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                      )}
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
                          confirmLabel={`Delete "${t.description}"? This can't be undone.`}
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
          {pageCount > 1 && (
            <div className="flex items-center justify-between gap-3 mt-3 pt-3 border-t border-grey-100">
              <span className="text-xs text-grey-400">
                Page {currentPage} of {pageCount} — {sortedTasks.length} task{sortedTasks.length === 1 ? '' : 's'}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={currentPage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-grey-500 hover:bg-grey-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors press-scale"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  disabled={currentPage >= pageCount}
                  onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-grey-500 hover:bg-grey-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors press-scale"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>
        {/* Outside the horizontal scroller, so it stays on screen even when the table is scrolled sideways. */}
        {filteredTasks.length === 0 && (
          <EmptyState icon={<IllustrationSearch className="w-16 h-16 mx-auto" />} title="No tasks match these filters">
            Adjust a column filter, or use "Clear all filters" above.
          </EmptyState>
        )}
        </>
      )}
      {editTask && isAdminTier && (
        <EditTaskModal task={editTask} onClose={() => setEditTask(null)} onSaved={(msg) => { setEditTask(null); load(msg); }} />
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
        className={`text-xs font-semibold rounded-full px-2.5 py-2 sm:py-1 border-0 min-h-[40px] sm:min-h-0 cursor-pointer transition-opacity ${saving ? 'opacity-60' : ''} ${badgeClassFor(task.status)}`}
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

/** Tomorrow / next Monday / a week out — the three dates a leader reaches for most when pushing a task out.
 *  Anchored to the current IST business date, not the browser's own local clock (which could be any
 *  timezone a traveling Leader happens to be in) — then added entirely in UTC calendar-day space, same
 *  convention server/src/lib/recurrence.js uses, so this never drifts a day regardless of where it runs. */
function quickPickDates() {
  const [y, m, d] = getBusinessDate().split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  const mk = (offsetDays) => {
    const dt = new Date(base);
    dt.setUTCDate(dt.getUTCDate() + offsetDays);
    return dt.toISOString().slice(0, 10);
  };
  const untilMonday = (8 - base.getUTCDay()) % 7 || 7;

  return [
    ['Tomorrow', mk(1)],
    ['Next Monday', mk(untilMonday)],
    ['In a week', mk(7)],
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
  const [mainTasks, setMainTasks] = useState([]);
  const [mainTaskId, setMainTaskId] = useState('');
  const [taskActivities, setTaskActivities] = useState([]);
  const [taskActivityId, setTaskActivityId] = useState('');
  const [users, setUsers] = useState([]);
  const [reviewerId, setReviewerId] = useState('');
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
    api.get('/main-tasks').then((d) => setMainTasks(d.main_tasks.filter((m) => m.is_active))).catch(() => setLoadError("Couldn't load Processes — try closing and reopening this form."));
    api.get('/task-activities').then((d) => setTaskActivities(d.task_activities.filter((a) => a.is_active))).catch(() => setLoadError("Couldn't load Activities — try closing and reopening this form."));
    api.get('/users').then((d) => setUsers(d.users)).catch(() => {});
  }, []);

  const selectedType = taskTypes.find((t) => t.id === taskTypeId);
  const isRecurring = selectedType?.mechanic === 'recurring';
  const activitiesForMainTask = taskActivities.filter((a) => !mainTaskId || a.main_task_id === mainTaskId);
  const selectedActivity = taskActivities.find((a) => a.id === taskActivityId);
  const reviewers = users.filter((u) => ['leader', 'admin', 'super_admin'].includes(u.role) && u.is_active);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (taskActivityId && !activitiesForMainTask.some((a) => a.id === taskActivityId)) setTaskActivityId('');
  }, [mainTaskId, taskActivities]);

  // Reviewer defaults to whoever this employee reports to (their manager, from the org hierarchy) —
  // still editable, and only re-defaulted on an employee switch if it's untouched since the last
  // default, same "untouched auto-fill" convention as the description placeholder below.
  const autoFilledReviewer = useRef(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const emp = users.find((u) => u.id === employeeId);
    const defaultReviewer = emp?.manager_id || '';
    // Snapshot the OLD auto-fill value before overwriting the ref — the updater below runs during
    // React's next render, by which point a same-line ref mutation would already show the NEW value,
    // making the "is this still untouched" comparison always false against itself.
    const previousAutoFill = autoFilledReviewer.current;
    autoFilledReviewer.current = defaultReviewer;
    setReviewerId((r) => (!r || r === previousAutoFill) ? defaultReviewer : r);
  }, [employeeId, users]);

  // Activity is a TYPE of work (e.g. "Bank Reconciliation"), not the specific task itself — so picking
  // one no longer copies its name into the description. Instead it shapes the placeholder into a
  // concrete example, nudging toward something specific like "Bank Reconciliation for August 2026"
  // rather than leaving the Activity's bare catalog name as the actual task description.
  const descriptionPlaceholder = selectedActivity
    ? `Be specific — e.g. "${selectedActivity.name} for August 2026"`
    : 'e.g. Follow up with Procurement on the approved PR';

  async function create() {
    setError('');
    if (!employeeId) return setError('Choose who this task is for.');
    if (!description.trim()) return setError('Please describe the task.');
    if (!mainTaskId) return setError('Choose the Process this task belongs to.');
    if (!taskActivityId) return setError('Choose the Activity this task belongs to.');
    setSaving(true);
    try {
      await api.post('/scrum/commitments', {
        employee_id: employeeId, description, task_type_id: taskTypeId || undefined, main_task_id: mainTaskId, task_activity_id: taskActivityId, reviewer_id: reviewerId || undefined, priority, due_date: dueDate,
        recurrence_rule: isRecurring ? recurrenceRule : undefined,
      });
      setDescription(''); setMainTaskId(''); setTaskActivityId('');
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
      <div className="grid sm:grid-cols-2 gap-3">
        <Select label="Process" value={mainTaskId} onChange={(e) => setMainTaskId(e.target.value)}>
          <option value="">Choose a Process…</option>
          {mainTasks.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </Select>
        <Select label="Activity" value={taskActivityId} onChange={(e) => setTaskActivityId(e.target.value)}>
          <option value="">Choose an Activity…</option>
          {activitiesForMainTask.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
      </div>
      <Textarea
        required
        label="What is the SPECIFIC task? (an Activity is a type of work — say exactly what needs doing)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={descriptionPlaceholder}
      />
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Select label="Type" value={taskTypeId} onChange={(e) => setTaskTypeId(e.target.value)}>
          {taskTypes.map((t) => <option key={t.id} value={t.id}>{t.name}{t.mechanic === 'recurring' ? ' (repeats)' : ''}</option>)}
        </Select>
        <Select label={<>Priority<InfoTip term="priority" /></>} value={priority} onChange={(e) => setPriority(e.target.value)}>
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
        <Select label="Reviewer" value={reviewerId} onChange={(e) => setReviewerId(e.target.value)}>
          <option value="">No reviewer</option>
          {reviewers.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
        </Select>
      </div>
      {isRecurring && <RecurrencePicker value={recurrenceRule} onChange={setRecurrenceRule} />}
      <ErrorBanner message={loadError} />
      <ErrorBanner message={error} />
      <Button variant="secondary" onClick={create} disabled={saving}>{saving ? 'Creating…' : <><Plus className="w-4 h-4" /> Create Task</>}</Button>
    </div>
  );
}

/** Admin/Super Admin only — full-field edit of an existing task (Owner, Process, Activity, Task Type,
 *  Priority, Due date, Reviewer, Description), all recorded against the same Task ID via the normal
 *  audit-diff on the PATCH route. Doesn't offer Status (already editable inline via the status dropdown,
 *  which also runs side effects like advancing a recurring series — a bare status write here would skip
 *  those) or recurring-schedule fields (that belongs to Admin's Recurring Tasks screen). Task Type is
 *  restricted server-side to the task's existing Recurring/Ad-hoc mechanic — the dropdown here mirrors
 *  that by only offering same-mechanic types, so a rejected choice never surprises the person picking it. */
function EditTaskModal({ task, onClose, onSaved }) {
  const [employeeId, setEmployeeId] = useState(task.employee_id);
  const [description, setDescription] = useState(task.description);
  const [taskTypes, setTaskTypes] = useState([]);
  const [taskTypeId, setTaskTypeId] = useState(task.task_type_id || '');
  const [mainTasks, setMainTasks] = useState([]);
  const [mainTaskId, setMainTaskId] = useState(task.main_task_id || '');
  const [taskActivities, setTaskActivities] = useState([]);
  const [taskActivityId, setTaskActivityId] = useState(task.task_activity_id || '');
  const [users, setUsers] = useState([]);
  const [reviewerId, setReviewerId] = useState(task.reviewer_id || '');
  const [priority, setPriority] = useState(task.priority);
  const [dueDate, setDueDate] = useState(task.due_date);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    api.get('/task-types').then((d) => setTaskTypes(d.task_types.filter((t) => t.is_active && t.mechanic === task.type)))
      .catch(() => setLoadError("Couldn't load Task Types — try closing and reopening this form."));
    api.get('/main-tasks').then((d) => setMainTasks(d.main_tasks.filter((m) => m.is_active))).catch(() => setLoadError("Couldn't load Processes — try closing and reopening this form."));
    api.get('/task-activities').then((d) => setTaskActivities(d.task_activities.filter((a) => a.is_active))).catch(() => setLoadError("Couldn't load Activities — try closing and reopening this form."));
    api.get('/users').then((d) => setUsers(d.users.filter((u) => u.is_active))).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activitiesForMainTask = taskActivities.filter((a) => !mainTaskId || a.main_task_id === mainTaskId);
  const reviewers = users.filter((u) => ['leader', 'admin', 'super_admin'].includes(u.role));

  async function save() {
    setError('');
    if (!employeeId) return setError('Choose who this task is for.');
    if (!description.trim()) return setError('Please describe the task.');
    if (!mainTaskId) return setError('Choose the Process this task belongs to.');
    if (!taskActivityId) return setError('Choose the Activity this task belongs to.');
    setSaving(true);
    try {
      await api.patch(`/scrum/commitments/${task.id}`, {
        employee_id: employeeId, description, task_type_id: taskTypeId || null, main_task_id: mainTaskId, task_activity_id: taskActivityId,
        reviewer_id: reviewerId || null, priority, due_date: dueDate,
      });
      onSaved(`Saved changes to ${taskCode(task)}.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Edit ${taskCode(task)}`} wide>
      <div className="space-y-3">
        <div className="grid sm:grid-cols-2 gap-3">
          <Select label="Owner" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </Select>
          <Input label="Due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <Select label="Process" value={mainTaskId} onChange={(e) => setMainTaskId(e.target.value)}>
            <option value="">Choose a Process…</option>
            {mainTasks.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
          <Select label="Activity" value={taskActivityId} onChange={(e) => setTaskActivityId(e.target.value)}>
            <option value="">Choose an Activity…</option>
            {activitiesForMainTask.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </div>
        <Textarea required label="Task" value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Select label="Type" value={taskTypeId} onChange={(e) => setTaskTypeId(e.target.value)}>
            <option value="">—</option>
            {taskTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
          <Select label={<>Priority<InfoTip term="priority" /></>} value={priority} onChange={(e) => setPriority(e.target.value)}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </Select>
          <Select label="Reviewer" value={reviewerId} onChange={(e) => setReviewerId(e.target.value)}>
            <option value="">No reviewer</option>
            {reviewers.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
          </Select>
        </div>
        <ErrorBanner message={loadError} />
        <ErrorBanner message={error} />
        <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</Button>
      </div>
    </Modal>
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

/** "View History" panel — docked to the right edge of the screen rather than a centered popout, so the
 *  task list underneath stays visible and usable while it's open. Every recorded change to this one task
 *  (created, status, due date, deletion, etc.), each entry showing who did it and when. Reuses the exact
 *  same formatting as the org-wide Audit Log page (AuditTimeline), just scoped to a single task via
 *  GET /commitments/:id/history. */
/** Everything about one task, keyed by its permanent Task ID — the fields it currently has, any request
 *  still waiting on a decision, and the full change history. The single place this app's task lifecycle
 *  (created → updated → requested → approved → completed) can be read back end to end for one task. */
function TaskDetailDrawer({ task, onChanged, canAct, onClose }) {
  const [logs, setLogs] = useState(null);
  const [error, setError] = useState('');
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestError, setRequestError] = useState('');
  const code = taskCode(task);

  useEffect(() => {
    setLogs(null);
    setError('');
    api.get(`/scrum/commitments/${task.id}/history`)
      .then((d) => setLogs(d.logs))
      .catch((e) => setError(e.message || "Couldn't load this task's history."));
  }, [task.id]);

  async function resolveRequest(action) {
    setRequestBusy(true);
    setRequestError('');
    try {
      await api.post(`/requests/${task.pending_request_id}/${action}`, {});
      onChanged();
      onClose();
    } catch (e) {
      setRequestError(e.message || "Couldn't resolve this request.");
    } finally {
      setRequestBusy(false);
    }
  }

  const fields = [
    [User, 'Owner', task.employee_name],
    [ListTree, 'Process', task.main_task_name],
    [ListChecks, 'Activity', task.task_activity_name],
    [Tag, 'Type', typeLabel(task)],
    [Flag, 'Priority', task.priority ? humanize(task.priority) : null],
    [Calendar, 'Due date', task.due_date],
    [UserCheck, 'Reviewer', task.reviewer_name],
  ];

  const requestNote = task.non_completion_reason || task.non_completion_explanation;

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={(
        <span className="inline-flex items-center gap-2">
          <span className="text-xs font-mono font-semibold bg-brand-50 text-brand-700 px-2 py-0.5 rounded-md border border-brand-100">{code}</span>
          <span>Task Details</span>
        </span>
      )}
    >
      <div className="space-y-5">
        <div>
          <div className="flex items-center gap-2 flex-wrap mb-1.5">
            <Badge tone={task.status}>{task.status}</Badge>
            {task.priority && <Badge tone={task.priority}>{`${task.priority} priority`}</Badge>}
          </div>
          <h3 className="font-bold text-grey-900 text-lg leading-snug">{task.description}</h3>
        </div>

        {task.pending_request_id && (
          <div className="border border-amber-200 bg-amber-50 rounded-xl p-3.5">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-amber-800">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              {task.pending_request_type === 'due_date_change'
                ? `Due-date change requested → ${task.pending_request_due_date}`
                : 'Support requested'}
            </div>
            {requestNote && (
              <p className="text-xs text-amber-700 mt-1.5 leading-relaxed">
                {task.non_completion_reason && <span className="font-medium">{humanize(task.non_completion_reason)}: </span>}
                {task.non_completion_explanation}
              </p>
            )}
            {canAct ? (
              <>
                <div className="flex gap-2 mt-3">
                  <Button size="sm" disabled={requestBusy} onClick={() => resolveRequest('approve')}>Approve</Button>
                  <Button size="sm" variant="secondary" disabled={requestBusy} onClick={() => resolveRequest('reject')}>Reject</Button>
                </div>
                <ErrorBanner message={requestError} />
              </>
            ) : (
              <p className="text-xs text-amber-700 mt-2">Waiting on a Leader's review.</p>
            )}
          </div>
        )}

        <div>
          <h4 className="text-xs font-semibold text-grey-400 uppercase tracking-wide mb-2">Task Details</h4>
          <div className="grid sm:grid-cols-2 gap-2.5">
            {fields.map(([Icon, label, value]) => <DetailField key={label} icon={Icon} label={label} value={value} />)}
          </div>
        </div>

        <div>
          <h4 className="text-xs font-semibold text-grey-400 uppercase tracking-wide mb-2">Activity &amp; History</h4>
          <div className="flex items-start gap-2 bg-grey-50 border border-grey-100 rounded-lg px-3 py-2 text-xs text-grey-500 leading-relaxed mb-3">
            <HistoryIcon className="w-3.5 h-3.5 mt-0.5 shrink-0 text-grey-400" />
            <span>A permanent record of every change to this task. <span className="text-amber-700 font-medium">Amber</span> entries mean the due date was changed from its original schedule.</span>
          </div>
          <ErrorBanner message={error} />
          {!error && logs === null && (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          )}
          {!error && logs !== null && (
            <AuditTimeline logs={logs} emptyTitle="No history yet" emptyBody="Nothing recorded for this task yet." />
          )}
        </div>
      </div>
    </Modal>
  );
}
