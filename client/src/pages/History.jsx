import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { formatBusinessDate } from '../lib/businessDate';
import { useDataTable } from '../lib/useDataTable';
import { Badge, Button, Card, EmptyState, ErrorBanner, IllustrationSearch, Input, Select, humanize } from '../components/ui';
import DataTable, { DataTableView } from '../components/DataTable';
import HelpBanner from '../components/HelpBanner';
import {
  History as HistoryIcon,
  Filter,
  Download,
  XCircle,
  Users,
  ClipboardList,
  ListChecks,
  Search,
  Check,
} from 'lucide-react';

const EMPTY_FILTERS = { date_from: '', date_to: '', type: '', status: '', main_task_id: '', task_activity_id: '', employee_id: '', team_id: '', priority: '' };
const TABS = [
  ['Browse', HistoryIcon],
  ['Search', Search],
];
const PRIORITIES = ['Low', 'Medium', 'High'];
const NO_ROWS = [];

// DataTable's column config — the single source of truth for what Task Records shows, sorts, filters and
// searches by. `value` is what each cell displays (used for sort/filter/search alike); `render` is only
// for cells that need more than that raw text (a Badge, or Notes' badges-plus-reason). Type and Status
// cells go through Badge, which humanizes, so their filter-list labels do too.
const RECORD_COLUMNS = [
  { key: 'code', label: 'Code', value: (c) => c.code || '', width: 130, minWidth: 110, cellClassName: 'font-mono text-xs text-grey-500 truncate' },
  { key: 'date', label: 'Date', value: (c) => c.scrum_date || '', width: 110, cellClassName: 'text-grey-500 truncate' },
  { key: 'employee', label: 'Employee', value: (c) => c.full_name || '', width: 140, cellClassName: 'font-semibold text-grey-800 truncate' },
  { key: 'task', label: 'Task', value: (c) => c.description || '', width: 260, cellClassName: 'text-grey-800' },
  { key: 'type', label: 'Type', value: (c) => c.type || '', format: humanize, width: 110, render: (c) => <Badge tone={c.type}>{c.type}</Badge> },
  { key: 'process', label: 'Process', value: (c) => c.main_task_name || '', width: 160, cellClassName: 'text-grey-600 truncate' },
  { key: 'activity', label: 'Activity', value: (c) => c.task_activity_name || '', width: 160, cellClassName: 'text-grey-600 truncate' },
  { key: 'reviewer', label: 'Reviewer', value: (c) => c.reviewer_name || '', width: 130, cellClassName: 'text-grey-600 truncate' },
  {
    key: 'status', label: 'Status', width: 140, order: ['pending', 'in_progress', 'support_required', 'completed'],
    value: (c) => c.status || '', format: humanize, render: (c) => <Badge tone={c.status}>{humanize(c.status)}</Badge>,
  },
  { key: 'completed', label: 'Completed', value: (c) => (c.completed_at ? formatBusinessDate(c.completed_at) : ''), width: 110, cellClassName: 'text-grey-500 truncate' },
  {
    key: 'notes', label: 'Notes', width: 240, sortable: false, filterable: false, cellClassName: 'max-w-[240px]',
    value: (c) => c.non_completion_reason || c.remarks || '',
    render: (c) => (
      <>
        <div className="flex flex-wrap gap-1 mb-1">
          {!!c.is_leader_support_task && <Badge tone="pending">Support Task</Badge>}
          {!c.is_leader_support_task && !!(c.carried_forward_to_id || c.had_support_request) && <Badge tone="pending">Escalated to Leader</Badge>}
        </div>
        {c.non_completion_reason || c.remarks ? (
          <span className="text-grey-600 text-xs">
            {c.non_completion_reason && <strong>{c.non_completion_reason}</strong>}
            {c.non_completion_reason && c.remarks && ' — '}
            {c.remarks}
          </span>
        ) : (!c.is_leader_support_task && !c.carried_forward_to_id && !c.had_support_request && <span className="text-grey-300">—</span>)}
      </>
    ),
  },
];

// Counts render red when non-zero for the two "needs attention" columns, as before.
const attention = (key) => (s) => <span className={s[key] > 0 ? 'font-semibold text-accent-600' : 'text-grey-600'}>{s[key]}</span>;
const SUMMARY_COLUMNS = [
  { key: 'employee', label: 'Employee', width: 170, value: (s) => s.full_name || '', cellClassName: 'font-semibold text-grey-800 truncate' },
  { key: 'tasks', label: 'Tasks', width: 100, value: (s) => s.activities ?? 0, cellClassName: 'text-grey-600' },
  { key: 'completed', label: 'Completed', width: 120, value: (s) => s.completed ?? 0, cellClassName: 'text-grey-600' },
  { key: 'support', label: 'Support Required', width: 160, value: (s) => s.support_required ?? 0, render: attention('support_required') },
  { key: 'escalated', label: 'Escalated', width: 120, value: (s) => s.escalated_to_leader ?? 0, render: attention('escalated_to_leader') },
  { key: 'recurring', label: 'Recurring', width: 120, value: (s) => s.recurring_activities ?? 0, cellClassName: 'text-grey-600' },
  { key: 'adhoc', label: 'Ad-hoc', width: 110, value: (s) => s.adhoc_activities ?? 0, cellClassName: 'text-grey-600' },
];

/** Splits CSV text into raw records without re-serializing any cell, so a kept row stays byte-identical to
 *  what the server sent. A description can hold a newline inside its quotes, so a plain split('\n') would
 *  break a record in two; an escaped "" toggles twice, which leaves the quote state unchanged. */
function csvRecords(text) {
  const records = [];
  let start = 0;
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') inQuotes = !inQuotes;
    else if (text[i] === '\n' && !inQuotes) { records.push(text.slice(start, i)); start = i + 1; }
  }
  if (start < text.length) records.push(text.slice(start));
  return records;
}

/** Reads whichever of EMPTY_FILTERS' keys are present in the URL — this is what makes a Dashboard KPI's
 *  "?status=support_required"-style drill-down link actually land pre-filtered instead of on a blank page. */
function filtersFromSearchParams(searchParams) {
  const f = { ...EMPTY_FILTERS };
  for (const key of Object.keys(EMPTY_FILTERS)) {
    const v = searchParams.get(key);
    if (v) f[key] = v;
  }
  return f;
}

export default function History() {
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState(searchParams.get('tab') === 'search' ? 'Search' : 'Browse');
  const [filters, setFilters] = useState(() => filtersFromSearchParams(searchParams));
  const [summary, setSummary] = useState(null);
  const [commitments, setCommitments] = useState(null);
  const [mainTasks, setMainTasks] = useState([]);
  const [taskActivities, setTaskActivities] = useState([]);
  const [teams, setTeams] = useState([]);
  const [employeeOptions, setEmployeeOptions] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [commitmentsTruncated, setCommitmentsTruncated] = useState(false);
  const table = useDataTable(commitments ?? NO_ROWS, RECORD_COLUMNS, {
    tableId: 'history-task-records', staleLabel: 'not in these records', loading: commitments === null,
  });

  function query(f = filters) {
    setLoadError('');
    const params = new URLSearchParams();
    Object.entries(f).forEach(([k, v]) => v && params.set(k, v));
    api.get(`/history/summary?${params}`).then((d) => setSummary(d.summary)).catch((e) => setLoadError(e.message || "Couldn't load History."));
    api.get(`/history/commitments?${params}`).then((d) => { setCommitments(d.commitments); setCommitmentsTruncated(!!d.commitments_truncated); }).catch((e) => setLoadError(e.message || "Couldn't load History."));
  }

  useEffect(() => {
    query(filtersFromSearchParams(searchParams));
    api.get('/main-tasks').then((d) => setMainTasks(d.main_tasks.filter((m) => m.is_active))).catch(() => {});
    api.get('/task-activities').then((d) => setTaskActivities(d.task_activities.filter((a) => a.is_active))).catch(() => {});
    api.get('/teams').then((d) => setTeams(d.teams.filter((t) => t.is_active))).catch(() => {});
    // Unfiltered, fetched once — so the Employee filter's own option list doesn't collapse to whoever
    // the current filter selection happens to include.
    api.get('/history/summary').then((d) => setEmployeeOptions(d.summary)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function clearFilters() {
    setFilters(EMPTY_FILTERS);
    table.clearFilters();
    query(EMPTY_FILTERS);
  }

  const [exported, setExported] = useState(false);

  function exportCsv() {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => v && params.set(k, v));
    const token = localStorage.getItem('dsm_token');
    setLoadError('');
    fetch(`/api/history/export.csv?${params}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => {
        // fetch() only rejects on a network-level failure — a 401/500 still resolves here, and without
        // this check the JSON error body would get downloaded and named scrum-history.csv as if it had
        // succeeded, instead of surfacing the actual error.
        if (!res.ok) throw new Error(`Export failed (${res.status}).`);
        if (!table.anyFilterActive) return res.blob();
        // Column filters and the search box are applied in the browser, so keep the server's own file
        // (same columns, same formula-injection escaping) and drop just the records the table isn't
        // showing, matched on Code.
        return res.text().then((text) => {
          const [header, ...rows] = csvRecords(text);
          const shown = new Set(table.rows.map((c) => c.code));
          const kept = rows.filter((r) => shown.has(r.match(/^"([^"]*)"/)?.[1]));
          return new Blob([[header, ...kept].join('\n')], { type: 'text/csv' });
        });
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'scrum-history.csv';
        a.click();
        setExported(true);
        setTimeout(() => setExported(false), 2000);
      })
      .catch((e) => setLoadError(e.message || "Couldn't export History."));
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center shrink-0">
          <HistoryIcon className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-grey-900">History</h1>
          <p className="text-grey-500 text-sm mt-0.5">The permanent record — every task ever entered. Browse by date, or search by keyword.</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 bg-grey-100 rounded-xl p-1 w-fit animate-fade-in-up">
        {TABS.map(([t, Icon]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            data-tour={t === 'Browse' ? 'history-browse-tab' : 'history-search-tab'}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold transition-all press-scale ${
              tab === t ? 'bg-white text-brand-700 shadow-sm' : 'text-grey-500 hover:text-grey-700'
            }`}
          >
            <Icon className="w-4 h-4" /> {t}
          </button>
        ))}
      </div>

      {tab === 'Browse' && (
        <>
          <Card className="animate-fade-in-up">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-grey-500 mb-3 uppercase tracking-wide">
              <Filter className="w-3.5 h-3.5" />
              Show me
            </div>
            <div className="grid sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <Input label="From" type="date" value={filters.date_from} onChange={(e) => setFilters((f) => ({ ...f, date_from: e.target.value }))} />
              <Input label="To" type="date" value={filters.date_to} onChange={(e) => setFilters((f) => ({ ...f, date_to: e.target.value }))} />
              <Select label="Employee" value={filters.employee_id} onChange={(e) => setFilters((f) => ({ ...f, employee_id: e.target.value }))}>
                <option value="">All employees</option>
                {employeeOptions.map((e) => <option key={e.employee_id} value={e.employee_id}>{e.full_name}</option>)}
              </Select>
              <Select label="Team" value={filters.team_id} onChange={(e) => setFilters((f) => ({ ...f, team_id: e.target.value }))}>
                <option value="">All teams</option>
                {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
              <Select label="Work type" value={filters.type} onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))}>
                <option value="">All types</option>
                <option value="recurring">Recurring</option>
                <option value="adhoc">Ad-hoc</option>
              </Select>
              <Select label="Status" value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
                <option value="">All statuses</option>
                <option value="pending">Pending</option>
                <option value="in_progress">In Progress</option>
                <option value="completed">Completed</option>
                <option value="support_required">Support Required</option>
                <option value="overdue">Overdue</option>
              </Select>
              <Select label="Process" value={filters.main_task_id} onChange={(e) => setFilters((f) => ({ ...f, main_task_id: e.target.value }))}>
                <option value="">All Processes</option>
                {mainTasks.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </Select>
              <Select label="Activity" value={filters.task_activity_id} onChange={(e) => setFilters((f) => ({ ...f, task_activity_id: e.target.value }))}>
                <option value="">All activities</option>
                {taskActivities.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
              <Select label="Priority" value={filters.priority} onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value }))}>
                <option value="">All priorities</option>
                {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </Select>
              <div className="flex items-end gap-2">
                <Button onClick={() => query()} className="w-full sm:w-auto">Apply Filters</Button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-4 mt-4 pt-3 border-t border-grey-100">
              <button onClick={clearFilters} className="inline-flex items-center gap-1 text-xs font-medium text-grey-500 hover:text-grey-700 transition-colors">
                <XCircle className="w-3.5 h-3.5" /> Clear Filters
              </button>
              <button onClick={exportCsv} className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-800 transition-colors press-scale">
                <Download className="w-3.5 h-3.5" /> Export to CSV
              </button>
              {exported && (
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 animate-scale-in">
                  <Check className="w-3.5 h-3.5" /> Downloaded
                </span>
              )}
            </div>
            <ErrorBanner message={loadError} />
            {loadError && <Button size="sm" variant="secondary" className="mt-2" onClick={() => query()}>Retry</Button>}
          </Card>

          <Card className="animate-fade-in-up" style={{ animationDelay: '80ms' }}>
              <div className="flex items-center gap-2 mb-1">
                <Users className="w-4 h-4 text-brand-600" />
                <h2 className="font-semibold text-grey-900">Summary by Employee</h2>
              </div>
              <HelpBanner>
                Each row is calculated live from stored records for the period you selected above.{' '}
                <strong>Escalated</strong> counts tasks that were flagged <Badge tone="support_required">Support Required</Badge> and sent to a Leader's Requests inbox for review.
              </HelpBanner>
              <DataTable
                data={summary}
                columns={SUMMARY_COLUMNS}
                tableId="history-summary"
                getRowId={(s) => s.employee_id}
                itemNoun={['employee', 'employees']}
                searchPlaceholder="Search employees…"
                loadingRows={4}
                emptyTitle="Nothing here yet"
                emptyBody="No records match this filter."
              />
          </Card>

          <Card className="animate-fade-in-up" style={{ animationDelay: '160ms' }}>
            <div className="flex items-center gap-2 mb-3">
              <ClipboardList className="w-4 h-4 text-brand-600" />
              <h2 className="font-semibold text-grey-900">Task Records</h2>
            </div>
            <DataTableView
              table={table}
              getRowId={(c) => c.id}
              searchPlaceholder="Search records…"
              emptyTitle="Nothing here yet"
              emptyBody="No records match this filter — try widening the date range."
              noMatchTitle="No records match these column filters"
              noMatchBody='Adjust a column filter or your search, or use "Clear filters" above.'
            />
            {commitmentsTruncated && (
              <p className="text-xs text-grey-400 mt-2">
                Showing the first {commitments.length} matching records{table.anyFilterActive ? ', and the table above only searches these' : ''} — narrow the date range or filters above to see the rest.
              </p>
            )}
          </Card>
        </>
      )}

      {tab === 'Search' && <SearchTab />}
    </div>
  );
}

const groupToneClasses = {
  brand: 'bg-brand-50 text-brand-600',
  accent: 'bg-accent-50 text-accent-600',
  success: 'bg-emerald-50 text-emerald-600',
};

function SearchTab() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [error, setError] = useState('');

  async function search(e) {
    e?.preventDefault();
    if (!q.trim()) return;
    setError('');
    try {
      const d = await api.get(`/search?q=${encodeURIComponent(q)}`);
      setResults(d);
    } catch (err) {
      setError(err.message || "Couldn't search right now.");
    }
  }

  return (
    <div className="space-y-4 animate-fade-in-up">
      <Card>
        <form onSubmit={search} className="flex gap-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-grey-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search tasks, actions…"
              className="pl-9"
              autoFocus
            />
          </div>
          <Button type="submit">Search</Button>
        </form>
        <ErrorBanner message={error} />
      </Card>

      {results ? (
        <div className="space-y-4">
          <ResultGroup title="Tasks" icon={<ClipboardList className="w-4 h-4" />} tone="brand" items={results.commitments} truncated={results.commitments_truncated} render={(r) => `${r.full_name} — ${r.description}`} />
          <ResultGroup title="Actions" icon={<ListChecks className="w-4 h-4" />} tone="brand" items={results.actions} truncated={results.actions_truncated} render={(r) => `${r.full_name} — ${r.description}`} />
        </div>
      ) : (
        <Card>
          <EmptyState icon={<IllustrationSearch className="w-16 h-16 mx-auto" />} title="Search across your organization">
            Find tasks and actions by keyword — results are grouped by category below.
          </EmptyState>
        </Card>
      )}
    </div>
  );
}

function ResultGroup({ title, icon, tone = 'brand', items, truncated, render }) {
  if (!items) return null;
  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${groupToneClasses[tone] || groupToneClasses.brand}`}>
            {icon}
          </div>
          <h2 className="font-semibold text-grey-800">{title}</h2>
        </div>
        <Badge>{items.length}</Badge>
      </div>
      {items.length === 0 ? (
        <EmptyState icon={<IllustrationSearch className="w-10 h-10 mx-auto" />} title="No matches">Try a different search term.</EmptyState>
      ) : (
        <>
          <ul className="space-y-0.5 text-sm">
            {items.map((r, i) => (
              <li key={r.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 -mx-2 hover:bg-grey-50 transition-colors animate-fade-in-up" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                <span className="text-grey-700 truncate">{render(r)}</span>
                <span className="text-grey-400 text-xs whitespace-nowrap shrink-0">{r.scrum_date}</span>
              </li>
            ))}
          </ul>
          {truncated && <p className="text-xs text-grey-400 mt-2">Showing the first {items.length} matches — narrow your search to see more precisely.</p>}
        </>
      )}
    </Card>
  );
}
