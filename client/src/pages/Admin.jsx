import { useEffect, useMemo, useRef, useState } from 'react';
import { Users, UsersRound, Tag, Repeat, Plus, Check, UserPlus, ListTree, ListChecks } from 'lucide-react';
import { api } from '../lib/api';
import { getBusinessDate } from '../lib/businessDate';
import { badgeClassFor, Badge, Button, Card, CardSkeleton, DeleteButton, EmptyState, ErrorBanner, IllustrationTeam, Input, Modal, Select } from '../components/ui';
import HelpBanner from '../components/HelpBanner';
import DataTable, { DataTableView } from '../components/DataTable';
import { useDataTable } from '../lib/useDataTable';
import RecurrencePicker, { DEFAULT_RULE } from '../components/RecurrencePicker';
import ImportButton from '../components/ImportButton';
import { useAuth } from '../lib/AuthContext';

// "Functions" (categories.js) is deliberately not a visible tab here — the org has exactly one Function
// today, auto-resolved behind the scenes (see server/src/lib/masterData.js), so there's no day-to-day
// decision left for anyone to make on this screen. The full CRUD (CategoriesTab, below) and its backend
// route are untouched and still reachable by adding 'Functions' back to this list, if a second Function
// is ever genuinely needed.
const TABS = [
  ['Users', Users],
  ['Teams', UsersRound],
  ['Task Types', Tag],
  ['Processes', ListTree],
  ['Activities', ListChecks],
  ['Recurring Tasks', Repeat],
];

/* ---------------- Admin tables: shared DataTable pieces ----------------
 * Every Admin list renders through the app's one DataTable. Each column config below is that table's single
 * source of truth; cells that edit in place get the tab's own save handlers through `ctx` (cellContext). */

const NAME_INPUT = 'w-full font-semibold text-grey-800 border border-transparent hover:border-grey-200 focus:border-brand-500 rounded-lg px-1.5 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40';
const TEXT_INPUT = 'w-full text-grey-500 border border-transparent hover:border-grey-200 focus:border-brand-500 rounded-lg px-1.5 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40';
const SMALL_INPUT = 'w-full border border-grey-200 rounded-lg px-1.5 py-1 text-xs text-grey-700 focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 disabled:bg-grey-50 disabled:text-grey-400';
const SMALL_SELECT = 'w-full border border-grey-200 rounded-lg px-1.5 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500';
const LINK_BUTTON = 'text-xs font-medium text-brand-600 hover:text-brand-800 transition-colors';

/** An inline-edit text cell: saves on blur when changed; `required` restores the old value if cleared. */
function InlineText({ value, onSave, required, placeholder, className, saved, type = 'text', disabled }) {
  return (
    <>
      <input
        type={type}
        defaultValue={value || ''}
        placeholder={placeholder}
        disabled={disabled}
        onBlur={(e) => {
          const v = e.target.value;
          if (required && !v.trim()) { e.target.value = value || ''; return; }
          if (v !== (value || '')) onSave(v);
        }}
        className={className}
      />
      {saved && (
        <div className="text-emerald-600 text-xs mt-0.5 flex items-center gap-1 animate-scale-in">
          <Check className="w-3 h-3" /> Saved
        </div>
      )}
    </>
  );
}

function statusColumn(activeLabel = 'Active', inactiveLabel = 'Inactive') {
  return {
    key: 'status', label: 'Status', width: 110,
    value: (r) => (r.is_active ? activeLabel : inactiveLabel),
    render: (r) => <Badge tone={r.is_active ? 'completed' : 'support_required'}>{r.is_active ? activeLabel : inactiveLabel}</Badge>,
  };
}

/** The Activate/Deactivate (or Pause/Resume) link plus Delete that ends most Admin rows. */
function RowControls({ toggleLabel, onToggle, confirmLabel, onDelete, canDelete = true, children }) {
  return (
    <div className="flex items-center gap-3 whitespace-nowrap">
      {onToggle && <button type="button" className={LINK_BUTTON} onClick={onToggle}>{toggleLabel}</button>}
      {children}
      {onDelete && <DeleteButton confirmLabel={confirmLabel} disabled={!canDelete} onConfirm={onDelete} />}
    </div>
  );
}

const nameEditColumn = (label, saveName) => ({
  key: 'name', label, width: 220, value: (r) => r.name || '',
  render: (r, ctx) => <InlineText value={r.name} required saved={ctx.savedId === r.id} onSave={(v) => saveName(r, v, ctx)} className={NAME_INPUT} />,
});

const TEAM_COLUMNS = [
  { key: 'name', label: 'Team', width: 220, value: (t) => t.name || '', cellClassName: 'font-semibold text-grey-800 truncate' },
  { key: 'leader', label: 'Leader', width: 200, value: (t) => t.leader_name || '', cellClassName: 'text-grey-600 truncate' },
  statusColumn(),
];

const CATEGORY_COLUMNS = [
  nameEditColumn('Name', (c, v, ctx) => ctx.rename(c, v, c.description)),
  {
    key: 'description', label: 'Description', width: 280, value: (c) => c.description || '',
    render: (c, ctx) => <InlineText value={c.description} placeholder="—" onSave={(v) => ctx.rename(c, c.name, v || null)} className={TEXT_INPUT} />,
  },
  statusColumn(),
];

const MAIN_TASK_COLUMNS = [nameEditColumn('Process', (mt, v, ctx) => ctx.rename(mt, v)), statusColumn()];

const ACTIVITY_COLUMNS = [
  nameEditColumn('Activity', (a, v, ctx) => ctx.rename(a, v)),
  {
    key: 'process', label: 'Process', width: 220, value: (a) => a.main_task_name || '',
    render: (a, ctx) => (
      <select className={SMALL_SELECT} value={a.main_task_id || ''} onChange={(e) => ctx.updateMainTask(a, e.target.value)}>
        {ctx.mainTasks.map((m) => <option key={m.id} value={m.id}>{m.name}{!m.is_active ? ' (inactive)' : ''}</option>)}
      </select>
    ),
  },
  statusColumn(),
];

const TASK_TYPE_COLUMNS = [
  {
    key: 'name', label: 'Name', width: 240, value: (t) => t.name || '',
    render: (t, ctx) => (
      <>
        <div className="flex items-center gap-1.5">
          <InlineText value={t.name} required onSave={(v) => ctx.rename(t, v)} className={NAME_INPUT} />
          {t.is_protected ? <Badge tone="pending">Built-in</Badge> : null}
        </div>
        {ctx.savedId === t.id && (
          <div className="text-emerald-600 text-xs mt-0.5 flex items-center gap-1 animate-scale-in">
            <Check className="w-3 h-3" /> Saved
          </div>
        )}
      </>
    ),
  },
  {
    key: 'repeats', label: 'Repeats?', width: 110, value: (t) => (t.mechanic === 'recurring' ? 'Yes' : 'No'),
    render: (t) => (
      <span className="text-grey-500 inline-flex items-center gap-1">
        {t.mechanic === 'recurring' && <Repeat className="w-3.5 h-3.5 text-brand-500" />}{t.mechanic === 'recurring' ? 'Yes' : 'No'}
      </span>
    ),
  },
  statusColumn(),
];

const RECURRING_COLUMNS = [
  { key: 'task', label: 'Task', width: 240, value: (r) => r.title || '', cellClassName: 'font-semibold text-grey-800 break-words' },
  { key: 'employee', label: 'Assigned to', width: 150, value: (r) => r.employee_name || '', cellClassName: 'text-grey-500 truncate' },
  { key: 'type', label: 'Type', width: 130, value: (r) => r.task_type_name || '', cellClassName: 'text-grey-500 truncate' },
  { key: 'process', label: 'Process', width: 170, value: (r) => r.main_task_name || '', cellClassName: 'text-grey-500 truncate' },
  { key: 'frequency', label: 'Frequency', width: 160, value: (r) => r.frequency || '', cellClassName: 'text-grey-500' },
  statusColumn('Active', 'Paused'),
];

// Users: the org chart indent only means something in the default (hierarchy) order, so it's dropped as
// soon as the list is sorted, filtered or searched (ctx.indent).
const USER_COLUMNS = [
  {
    key: 'name', label: 'Name', width: 240, value: (u) => u.full_name || '', cellClassName: 'font-semibold text-grey-800',
    render: (u, ctx) => (
      <div style={{ paddingLeft: ctx.indent ? `${u.depth * 20}px` : 0 }}>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span>{u.full_name}</span>
          {u.is_super_admin_protected ? <Badge tone="pending">Protected</Badge> : null}
        </div>
        <div className="flex items-center gap-1 mt-0.5">
          <span className="text-[11px] font-normal text-grey-400 whitespace-nowrap">reports to</span>
          <select
            className="text-[11px] font-normal text-grey-500 border-0 bg-transparent focus:outline-none focus:ring-1 focus:ring-brand-500/40 rounded px-0.5 -ml-0.5 cursor-pointer hover:text-brand-600 transition-colors"
            value={u.manager_id || ''}
            onChange={(e) => ctx.updateUser(u, { manager_id: e.target.value || null })}
          >
            <option value="">— no one</option>
            {ctx.managers.filter((m) => m.id !== u.id).map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
          </select>
        </div>
      </div>
    ),
  },
  {
    key: 'jobTitle', label: 'Job Title', width: 150, value: (u) => u.job_title || '',
    render: (u, ctx) => <InlineText value={u.job_title} placeholder="—" onSave={(v) => ctx.updateUser(u, { job_title: v || null })} className={SMALL_INPUT} />,
  },
  {
    key: 'email', label: 'Email', width: 210, value: (u) => u.email || '',
    render: (u, ctx) => (
      <InlineText
        type="email"
        value={u.email}
        required
        disabled={!!u.is_super_admin_protected && ctx.currentUser.role !== 'super_admin'}
        onSave={(v) => ctx.updateUser(u, { email: v })}
        className={SMALL_INPUT}
      />
    ),
  },
  {
    key: 'role', label: 'Role', width: 160, value: (u) => u.role || '', format: (v) => ROLES.find(([r]) => r === v)?.[1] || v,
    order: ['super_admin', 'admin', 'senior_management', 'leader', 'employee'],
    render: (u, ctx) => (
      <select
        disabled={!!u.is_super_admin_protected}
        className={`text-xs font-semibold rounded-full px-2.5 py-1 border-0 cursor-pointer transition-opacity focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:cursor-not-allowed disabled:opacity-80 ${badgeClassFor(u.role)}`}
        value={u.role}
        onChange={(e) => ctx.updateUser(u, { role: e.target.value })}
      >
        {ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    ),
  },
  {
    key: 'team', label: 'Team', width: 150, value: (u) => u.team_name || '',
    render: (u, ctx) => (
      <select className={SMALL_SELECT} value={u.team_id || ''} onChange={(e) => ctx.updateUser(u, { team_id: e.target.value || null })}>
        <option value="">—</option>
        {ctx.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
    ),
  },
  statusColumn(),
];

export default function Admin() {
  const { user } = useAuth();
  const [tab, setTab] = useState('Users');
  return (
    <div className="space-y-5">
      <div className="animate-fade-in-up">
        <h1 className="text-xl font-bold text-grey-900">Administration</h1>
        <p className="text-grey-500 text-sm mt-0.5">Manage who has access and how the org is structured.</p>
      </div>
      <HelpBanner>
        Create people here first, then assign them to a Team so they show up correctly on dashboards and Leader reviews.
        {user.role === 'super_admin' && ' As Super Admin, your own account is protected — no one else can change its role or deactivate it, even through this screen.'}
      </HelpBanner>
      <div className="flex flex-wrap gap-1 bg-grey-100 rounded-xl p-1 w-fit" data-tour="admin-tabs">
        {TABS.map(([t, Icon]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold transition-all press-scale ${
              tab === t ? 'bg-white text-brand-700 shadow-sm' : 'text-grey-500 hover:text-grey-700'
            }`}
          >
            <Icon className="w-4 h-4" /> {t}
          </button>
        ))}
      </div>
      <div key={tab} className="animate-fade-in-up">
        {tab === 'Users' && <UsersTab />}
        {tab === 'Teams' && <TeamsTab />}
        {tab === 'Task Types' && <TaskTypesTab />}
        {tab === 'Functions' && <CategoriesTab />}
        {tab === 'Processes' && <MainTasksTab />}
        {tab === 'Activities' && <ActivitiesTab />}
        {tab === 'Recurring Tasks' && <RecurringTasksTab />}
      </div>
    </div>
  );
}

/* ---------------- Teams ---------------- */
function TeamsTab() {
  const [items, setItems] = useState(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [formOpen, setFormOpen] = useState(false);

  function load() {
    setLoadError('');
    api.get('/teams').then((d) => setItems(d.teams)).catch((e) => setLoadError(e.message || "Couldn't load teams."));
  }
  useEffect(() => { load(); }, []);

  async function create() {
    setError('');
    if (!name.trim()) return setError('Name is required.');
    try {
      await api.post('/teams', { name });
      setName(''); setFormOpen(false); load();
    } catch (e) { setError(e.message); }
  }

  async function toggle(team) {
    await api.patch(`/teams/${team.id}`, { is_active: team.is_active ? 0 : 1 });
    load();
  }

  async function remove(team) {
    setError('');
    try {
      await api.del(`/teams/${team.id}`);
      load();
    } catch (e) { setError(e.message); }
  }

  if (items === null) {
    if (loadError) {
      return (
        <Card>
          <ErrorBanner message={loadError} />
          <Button size="sm" variant="secondary" className="mt-2" onClick={load}>Retry</Button>
        </Card>
      );
    }
    return <CardSkeleton lines={4} />;
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <ImportButton
          entityLabel="Teams"
          headers={['name']}
          example={{ name: 'Finance Operations' }}
          endpoint="/teams/import"
          onDone={load}
        />
        <Button onClick={() => setFormOpen(true)}><Plus className="w-4 h-4" /> Add Team</Button>
      </div>
      <Modal open={formOpen} onClose={() => setFormOpen(false)} title="Add Team">
        <div className="space-y-3">
          <Input label="Team name" value={name} onChange={(e) => setName(e.target.value)} />
          <ErrorBanner message={error} />
          <Button onClick={create}><Plus className="w-4 h-4" /> Add Team</Button>
        </div>
      </Modal>
      {items.length > 0 && (
        <p className="text-xs text-grey-400 mb-3">
          Leader is figured out automatically — whoever on the team most other members report to. Change it by updating "Reports To" under Admin → Users.
        </p>
      )}
      <DataTable
          data={items}
          columns={TEAM_COLUMNS}
          tableId="admin-teams"
          itemNoun={['team', 'teams']}
          searchPlaceholder="Search teams…"
          emptyIcon={<IllustrationTeam className="w-14 h-14 mx-auto" />}
          emptyTitle="No teams yet"
          emptyBody="Add one above to get started."
          rowActionsLabel=""
          rowActionsWidth={170}
          renderRowActions={(t) => (
            <RowControls toggleLabel={t.is_active ? 'Deactivate' : 'Activate'} onToggle={() => toggle(t)} confirmLabel={`Delete "${t.name}"? This can't be undone.`} onDelete={() => remove(t)} />
          )}
        />
      <ErrorBanner message={loadError} />
      {loadError && <Button size="sm" variant="secondary" className="mt-2" onClick={load}>Retry</Button>}
      <ErrorBanner message={error} />
    </Card>
  );
}

/* ---------------- Categories ---------------- */
function CategoriesTab() {
  const [items, setItems] = useState(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [savedId, setSavedId] = useState(null);

  function load() {
    setLoadError('');
    api.get('/categories').then((d) => setItems(d.categories)).catch((e) => setLoadError(e.message || "Couldn't load categories."));
  }
  useEffect(() => { load(); }, []);

  async function create() {
    setError('');
    if (!name.trim()) return setError('Name is required.');
    try {
      await api.post('/categories', { name, description });
      setName(''); setDescription(''); setFormOpen(false); load();
    } catch (e) { setError(e.message); }
  }

  async function toggle(cat) {
    await api.patch(`/categories/${cat.id}`, { is_active: cat.is_active ? 0 : 1 });
    load();
  }

  async function rename(cat, newName, newDescription) {
    setError('');
    try {
      await api.patch(`/categories/${cat.id}`, { name: newName, description: newDescription });
      load();
      setSavedId(cat.id);
      setTimeout(() => setSavedId((id) => (id === cat.id ? null : id)), 2000);
    } catch (e) { setError(e.message); throw e; }
  }

  async function remove(cat) {
    setError('');
    try {
      await api.del(`/categories/${cat.id}`);
      load();
    } catch (e) { setError(e.message); }
  }

  if (items === null) {
    if (loadError) {
      return (
        <Card>
          <ErrorBanner message={loadError} />
          <Button size="sm" variant="secondary" className="mt-2" onClick={load}>Retry</Button>
        </Card>
      );
    }
    return <CardSkeleton lines={4} />;
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3 mb-3">
        <p className="text-xs text-grey-400">
          The top level of the org structure — e.g. Finance, Compliance, Operations. Each Function contains several Processes, which in turn contain Activities. Separate from Task Type, which only controls whether work repeats.
        </p>
        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <ImportButton
            entityLabel="Functions"
            headers={['name', 'description']}
            example={{ name: 'Finance', description: 'Accounting and financial reporting tasks' }}
            endpoint="/categories/import"
            onDone={load}
          />
          <Button onClick={() => setFormOpen(true)}><Plus className="w-4 h-4" /> Add Function</Button>
        </div>
      </div>
      <Modal open={formOpen} onClose={() => setFormOpen(false)} title="Add Function">
        <div className="space-y-3">
          <Input label="Function name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
          <ErrorBanner message={error} />
          <Button onClick={create}><Plus className="w-4 h-4" /> Add Function</Button>
        </div>
      </Modal>
      <DataTable
          data={items}
          columns={CATEGORY_COLUMNS}
          tableId="admin-functions"
          itemNoun={['Function', 'Functions']}
          searchPlaceholder="Search Functions…"
          cellContext={{ rename, savedId }}
          emptyTitle="No Functions yet"
          emptyBody="Add one above to get started."
          rowActionsLabel=""
          rowActionsWidth={170}
          renderRowActions={(c) => (
            <RowControls toggleLabel={c.is_active ? 'Deactivate' : 'Activate'} onToggle={() => toggle(c)} confirmLabel={`Delete "${c.name}"? This can't be undone.`} onDelete={() => remove(c)} />
          )}
        />
      <ErrorBanner message={loadError} />
      {loadError && <Button size="sm" variant="secondary" className="mt-2" onClick={load}>Retry</Button>}
      <ErrorBanner message={error} />
    </Card>
  );
}

/* ---------------- Processes (parked under a Function, contain individual Activities) ---------------- */
function MainTasksTab() {
  const [items, setItems] = useState(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [savedId, setSavedId] = useState(null);

  function load() {
    setLoadError('');
    api.get('/main-tasks').then((d) => setItems(d.main_tasks)).catch((e) => setLoadError(e.message || "Couldn't load Processes."));
  }
  useEffect(() => { load(); }, []);

  // Function isn't asked for here — the org has exactly one today, so the server auto-assigns it (see
  // resolveDefaultCategoryId in masterData.js). It's still manageable under Admin's own Functions tab.
  async function create() {
    setError('');
    if (!name.trim()) return setError('Name is required.');
    try {
      await api.post('/main-tasks', { name, description });
      setName(''); setDescription(''); setFormOpen(false); load();
    } catch (e) { setError(e.message); }
  }

  async function toggle(mt) {
    await api.patch(`/main-tasks/${mt.id}`, { is_active: mt.is_active ? 0 : 1 });
    load();
  }

  async function rename(mt, newName) {
    setError('');
    try {
      await api.patch(`/main-tasks/${mt.id}`, { name: newName });
      load();
      setSavedId(mt.id);
      setTimeout(() => setSavedId((id) => (id === mt.id ? null : id)), 2000);
    } catch (e) { setError(e.message); throw e; }
  }

  async function remove(mt) {
    setError('');
    try {
      await api.del(`/main-tasks/${mt.id}`);
      load();
    } catch (e) { setError(e.message); }
  }

  if (items === null) {
    if (loadError) {
      return (
        <Card>
          <ErrorBanner message={loadError} />
          <Button size="sm" variant="secondary" className="mt-2" onClick={load}>Retry</Button>
        </Card>
      );
    }
    return <CardSkeleton lines={4} />;
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3 mb-3">
        <p className="text-xs text-grey-400">
          A grouping of Activities — e.g. Process "FP&A" contains Activities like "Bank Reconciliation" or "GST Return Filing".
        </p>
        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <ImportButton
            entityLabel="Processes"
            headers={['name', 'description']}
            example={{ name: 'FP&A', description: 'Financial Planning & Analysis' }}
            endpoint="/main-tasks/import"
            onDone={load}
          />
          <Button onClick={() => setFormOpen(true)}><Plus className="w-4 h-4" /> Add Process</Button>
        </div>
      </div>
      <Modal open={formOpen} onClose={() => setFormOpen(false)} title="Add Process">
        <div className="space-y-3">
          <Input label="Process name" placeholder="e.g. FP&A" value={name} onChange={(e) => setName(e.target.value)} />
          <Input label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
          <ErrorBanner message={error} />
          <Button onClick={create}><Plus className="w-4 h-4" /> Add Process</Button>
        </div>
      </Modal>
      <DataTable
          data={items}
          columns={MAIN_TASK_COLUMNS}
          tableId="admin-processes"
          itemNoun={['Process', 'Processes']}
          searchPlaceholder="Search Processes…"
          cellContext={{ rename, savedId }}
          emptyTitle="No Processes yet"
          emptyBody="Add one above to get started."
          rowActionsLabel=""
          rowActionsWidth={170}
          renderRowActions={(mt) => (
            <RowControls toggleLabel={mt.is_active ? 'Deactivate' : 'Activate'} onToggle={() => toggle(mt)} confirmLabel={`Delete "${mt.name}"? This can't be undone.`} onDelete={() => remove(mt)} />
          )}
        />
      <ErrorBanner message={loadError} />
      {loadError && <Button size="sm" variant="secondary" className="mt-2" onClick={load}>Retry</Button>}
      <ErrorBanner message={error} />
    </Card>
  );
}

/* ---------------- Activities (parked under a Process, one level below it) ---------------- */
function ActivitiesTab() {
  const [items, setItems] = useState(null);
  const [mainTasks, setMainTasks] = useState([]);
  const [name, setName] = useState('');
  const [mainTaskId, setMainTaskId] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [savedId, setSavedId] = useState(null);

  function load() {
    setLoadError('');
    api.get('/task-activities').then((d) => setItems(d.task_activities)).catch((e) => setLoadError(e.message || "Couldn't load Activities."));
    // Unfiltered — the inline per-row Process select below needs to resolve an Activity's CURRENT
    // Process even if that Process has since been deactivated, or the select shows blank/wrong instead
    // of the real linked name. The create-form only offers activeMainTasks (below).
    api.get('/main-tasks').then((d) => setMainTasks(d.main_tasks)).catch(() => {});
  }
  useEffect(() => { load(); }, []);

  const activeMainTasks = mainTasks.filter((m) => m.is_active);

  async function create() {
    setError('');
    if (!name.trim()) return setError('Name is required.');
    if (!mainTaskId) return setError('Choose the Process this Activity belongs to.');
    try {
      await api.post('/task-activities', { name, main_task_id: mainTaskId, description });
      setName(''); setMainTaskId(''); setDescription(''); setFormOpen(false); load();
    } catch (e) { setError(e.message); }
  }

  async function toggle(a) {
    await api.patch(`/task-activities/${a.id}`, { is_active: a.is_active ? 0 : 1 });
    load();
  }

  async function updateMainTask(a, newMainTaskId) {
    setError('');
    try {
      await api.patch(`/task-activities/${a.id}`, { main_task_id: newMainTaskId || null });
      load();
    } catch (e) { setError(e.message); }
  }

  async function rename(a, newName) {
    setError('');
    try {
      await api.patch(`/task-activities/${a.id}`, { name: newName });
      load();
      setSavedId(a.id);
      setTimeout(() => setSavedId((id) => (id === a.id ? null : id)), 2000);
    } catch (e) { setError(e.message); throw e; }
  }

  async function remove(a) {
    setError('');
    try {
      await api.del(`/task-activities/${a.id}`);
      load();
    } catch (e) { setError(e.message); }
  }

  if (items === null) {
    if (loadError) {
      return (
        <Card>
          <ErrorBanner message={loadError} />
          <Button size="sm" variant="secondary" className="mt-2" onClick={load}>Retry</Button>
        </Card>
      );
    }
    return <CardSkeleton lines={4} />;
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3 mb-3">
        <p className="text-xs text-grey-400">
          The type of work under a Process — e.g. Process "FP&A" contains Activities like "Bank Reconciliation" or "GST Return Filing". Activities are a catalog of work TYPES, not the specific task itself — an employee's actual task (e.g. "Complete HDFC Bank Reconciliation for August 2026") is created separately against one of these.
        </p>
        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <ImportButton
            entityLabel="Activities"
            headers={['name', 'main_task_name', 'description']}
            example={{ name: 'Bank Reconciliation', main_task_name: 'FP&A', description: '' }}
            endpoint="/task-activities/import"
            onDone={load}
          />
          <Button onClick={() => setFormOpen(true)}><Plus className="w-4 h-4" /> Add Activity</Button>
        </div>
      </div>
      <Modal open={formOpen} onClose={() => setFormOpen(false)} title="Add Activity">
        <div className="space-y-3">
          <Input label="Activity name" placeholder="e.g. Bank Reconciliation" value={name} onChange={(e) => setName(e.target.value)} />
          <Select label="Process" value={mainTaskId} onChange={(e) => setMainTaskId(e.target.value)}>
            <option value="">Choose a Process…</option>
            {activeMainTasks.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
          <Input label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
          <ErrorBanner message={error} />
          <Button onClick={create}><Plus className="w-4 h-4" /> Add Activity</Button>
        </div>
      </Modal>
      <DataTable
          data={items}
          columns={ACTIVITY_COLUMNS}
          tableId="admin-activities"
          itemNoun={['Activity', 'Activities']}
          searchPlaceholder="Search Activities…"
          cellContext={{ rename, savedId, mainTasks, updateMainTask }}
          emptyTitle="No Activities yet"
          emptyBody="Add one above to get started."
          rowActionsLabel=""
          rowActionsWidth={170}
          renderRowActions={(a) => (
            <RowControls toggleLabel={a.is_active ? 'Deactivate' : 'Activate'} onToggle={() => toggle(a)} confirmLabel={`Delete "${a.name}"? This can't be undone.`} onDelete={() => remove(a)} />
          )}
        />
      <ErrorBanner message={loadError} />
      {loadError && <Button size="sm" variant="secondary" className="mt-2" onClick={load}>Retry</Button>}
      <ErrorBanner message={error} />
    </Card>
  );
}

/* ---------------- Users ---------------- */
const ROLES = [
  ['employee', 'Employee'], ['leader', 'Leader'], ['admin', 'Admin'],
  ['senior_management', 'Senior Management'], ['super_admin', 'Super Admin'],
];

function UsersTab() {
  const { user: currentUser } = useAuth();
  const currentUserId = currentUser.id;
  const [items, setItems] = useState(null);
  const [teams, setTeams] = useState([]);
  const [form, setForm] = useState({ full_name: '', email: '', password: '', role: 'employee', team_id: '', manager_id: '', job_title: '' });
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState(null);
  const managers = useMemo(() => (items || []).filter((u) => ['leader', 'admin', 'super_admin'].includes(u.role) && u.is_active), [items]);
  // Depth-first walk of manager_id -> reports, so the table reads top-to-bottom as an org chart instead
  // of creation order. A dangling/unset manager_id is treated as a root, and a `visited` guard means a
  // stray cycle in bad data can't loop forever — it just stops re-descending, same defensive spirit as
  // subordinateIds() on the server.
  const sortedItems = useMemo(() => {
    if (!items) return [];
    const byId = new Map(items.map((u) => [u.id, u]));
    const childrenByManager = new Map();
    for (const u of items) {
      const key = u.manager_id && byId.has(u.manager_id) ? u.manager_id : null;
      if (!childrenByManager.has(key)) childrenByManager.set(key, []);
      childrenByManager.get(key).push(u);
    }
    for (const list of childrenByManager.values()) list.sort((a, b) => a.full_name.localeCompare(b.full_name));

    const ordered = [];
    const visited = new Set();
    function visit(managerId, depth) {
      for (const u of childrenByManager.get(managerId) || []) {
        if (visited.has(u.id)) continue;
        visited.add(u.id);
        ordered.push({ ...u, depth });
        visit(u.id, depth + 1);
      }
    }
    visit(null, 0);
    for (const u of items) if (!visited.has(u.id)) ordered.push({ ...u, depth: 0 });
    return ordered;
  }, [items]);
  // Team name joined in here (the users endpoint only returns team_id) so the Team column can filter and
  // search by the name it shows.
  const userRows = useMemo(() => {
    const teamName = new Map(teams.map((t) => [t.id, t.name]));
    return sortedItems.map((u) => ({ ...u, team_name: teamName.get(u.team_id) || '' }));
  }, [sortedItems, teams]);
  const userTable = useDataTable(userRows, USER_COLUMNS, { tableId: 'admin-users' });

  function load() {
    setLoadError('');
    api.get('/users').then((d) => setItems(d.users)).catch((e) => setLoadError(e.message || "Couldn't load users."));
    api.get('/teams').then((d) => setTeams(d.teams)).catch(() => {});
  }
  useEffect(() => { load(); }, []);

  async function create() {
    setError('');
    if (!form.full_name || !form.email || !form.password) return setError('Name, email, and password are required.');
    try {
      await api.post('/users', form);
      setForm({ full_name: '', email: '', password: '', role: 'employee', team_id: '', manager_id: '', job_title: '' });
      setFormOpen(false);
      load();
    } catch (e) { setError(e.message); }
  }

  async function updateUser(user, patch) {
    setError('');
    try {
      await api.patch(`/users/${user.id}`, patch);
      load();
    } catch (e) { setError(e.message); }
  }

  async function removeUser(user) {
    setError('');
    try {
      await api.del(`/users/${user.id}`);
      load();
    } catch (e) { setError(e.message); }
  }

  if (items === null) {
    if (loadError) {
      return (
        <Card>
          <ErrorBanner message={loadError} />
          <Button size="sm" variant="secondary" className="mt-2" onClick={load}>Retry</Button>
        </Card>
      );
    }
    return <CardSkeleton lines={4} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3" data-tour="admin-create-user">
        <ImportButton
          entityLabel="Users"
          headers={['full_name', 'email', 'password', 'role', 'team_name', 'job_title']}
          example={{ full_name: 'Jane Doe', email: 'jane@company.com', password: 'TempPass123', role: 'employee', team_name: 'General Team', job_title: 'Accountant' }}
          endpoint="/users/import"
          onDone={load}
        />
        <Button onClick={() => setFormOpen(true)}><UserPlus className="w-4 h-4" /> Add User</Button>
      </div>
      <Modal open={formOpen} onClose={() => setFormOpen(false)} title="Create User" wide>
        <div className="grid sm:grid-cols-2 gap-3">
          <Input label="Full name" value={form.full_name} onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))} />
          <Input label="Email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
          <Input label="Temporary password" type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />
          <Input label="Job title" value={form.job_title} onChange={(e) => setForm((f) => ({ ...f, job_title: e.target.value }))} />
          <Select label="Role" value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
            {ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
          <Select label="Team" value={form.team_id} onChange={(e) => setForm((f) => ({ ...f, team_id: e.target.value }))}>
            <option value="">No team</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
          <Select label="Reports To" value={form.manager_id} onChange={(e) => setForm((f) => ({ ...f, manager_id: e.target.value }))}>
            <option value="">No manager</option>
            {managers.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
          </Select>
        </div>
        <ErrorBanner message={error} />
        <Button className="mt-3" onClick={create}><Plus className="w-4 h-4" /> Create User</Button>
      </Modal>

      <Card>
        <h2 className="font-bold text-grey-900 mb-1 flex items-center gap-2"><Users className="w-4 h-4 text-brand-600" /> All Users</h2>
        <p className="text-xs text-grey-400 mb-3">
          Deactivate keeps their history and lets them be reactivated later. Delete permanently removes the account — only allowed once they have no Scrum history recorded.
        </p>
        <DataTableView
          table={userTable}
          itemNoun={['user', 'users']}
          searchPlaceholder="Search users…"
          cellContext={{ managers, teams, updateUser, currentUser, indent: !userTable.sort && !userTable.anyFilterActive }}
          emptyIcon={<IllustrationTeam className="w-14 h-14 mx-auto" />}
          emptyTitle="No users yet"
          emptyBody="Add one above to get started."
          rowActionsLabel=""
          rowActionsWidth={250}
          renderRowActions={(u) => (
            <RowControls
              toggleLabel={u.is_active ? 'Deactivate' : 'Activate'}
              onToggle={u.is_super_admin_protected ? null : () => updateUser(u, { is_active: u.is_active ? 0 : 1 })}
              confirmLabel={`Delete "${u.full_name}"? This can't be undone.`}
              canDelete={!u.is_super_admin_protected && u.id !== currentUserId}
              onDelete={() => removeUser(u)}
            >
              <button type="button" className="text-xs font-medium text-grey-500 hover:text-grey-700 transition-colors" onClick={() => setResetTarget(u)}>
                Reset Password
              </button>
            </RowControls>
          )}
        />
        <ErrorBanner message={loadError} />
        {loadError && <Button size="sm" variant="secondary" className="mt-2" onClick={load}>Retry</Button>}
        <ErrorBanner message={error} />
      </Card>

      {resetTarget && <ResetPasswordModal user={resetTarget} onClose={() => setResetTarget(null)} />}
    </div>
  );
}

function ResetPasswordModal({ user, onClose }) {
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function submit() {
    setError('');
    if (password.length < 8) return setError('Password must be at least 8 characters.');
    setSaving(true);
    try {
      await api.post(`/users/${user.id}/reset-password`, { password });
      setDone(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Reset Password — ${user.full_name}`}>
      {done ? (
        <div className="space-y-3">
          <p className="text-sm text-grey-700">
            Password reset. Share this with {user.full_name} — they'll need to sign in again, and any device they were already signed in on will need to sign in again too.
          </p>
          <div className="font-mono text-sm bg-grey-100 rounded-xl px-3 py-2">{password}</div>
          <Button onClick={onClose}>Done</Button>
        </div>
      ) : (
        <div className="space-y-3">
          <Input label="New temporary password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <ErrorBanner message={error} />
          <Button onClick={submit} disabled={saving}>{saving ? 'Saving…' : 'Reset Password'}</Button>
        </div>
      )}
    </Modal>
  );
}

/* ---------------- Task Types ---------------- */
function TaskTypesTab() {
  const [items, setItems] = useState(null);
  const [name, setName] = useState('');
  const [mechanic, setMechanic] = useState('adhoc');
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [savedId, setSavedId] = useState(null);

  function load() {
    setLoadError('');
    api.get('/task-types').then((d) => setItems(d.task_types)).catch((e) => setLoadError(e.message || "Couldn't load task types."));
  }
  useEffect(() => { load(); }, []);

  async function create() {
    setError('');
    if (!name.trim()) return setError('Name is required.');
    try {
      await api.post('/task-types', { name, mechanic });
      setName(''); setFormOpen(false); load();
    } catch (e) { setError(e.message); }
  }

  async function toggle(type) {
    setError('');
    try {
      await api.patch(`/task-types/${type.id}`, { is_active: type.is_active ? 0 : 1 });
      load();
    } catch (e) { setError(e.message); }
  }

  async function rename(type, newName) {
    setError('');
    try {
      await api.patch(`/task-types/${type.id}`, { name: newName });
      load();
      setSavedId(type.id);
      setTimeout(() => setSavedId((id) => (id === type.id ? null : id)), 2000);
    } catch (e) { setError(e.message); throw e; }
  }

  async function remove(type) {
    setError('');
    try {
      await api.del(`/task-types/${type.id}`);
      load();
    } catch (e) { setError(e.message); }
  }

  if (items === null) {
    if (loadError) {
      return (
        <Card>
          <ErrorBanner message={loadError} />
          <Button size="sm" variant="secondary" className="mt-2" onClick={load}>Retry</Button>
        </Card>
      );
    }
    return <CardSkeleton lines={4} />;
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="font-bold text-grey-900 mb-1 flex items-center gap-2"><Tag className="w-4 h-4 text-brand-600" /> Task Types</h2>
          <p className="text-xs text-grey-400">
            The types people can choose from when logging work — each one is either Recurring (repeats automatically once completed) or Ad-hoc (one-time).
            "Recurring" and "Ad-hoc" are built in and can be renamed but not removed — the app relies on at least one active type of each kind.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <ImportButton
            entityLabel="Task Types"
            headers={['name', 'mechanic']}
            example={{ name: 'Compliance Review', mechanic: 'adhoc' }}
            endpoint="/task-types/import"
            onDone={load}
          />
          <Button onClick={() => setFormOpen(true)}><Plus className="w-4 h-4" /> Add Task Type</Button>
        </div>
      </div>
      <Modal open={formOpen} onClose={() => setFormOpen(false)} title="Add Task Type">
        <div className="space-y-3">
          <Input label="Type name" placeholder="e.g. Compliance Review" value={name} onChange={(e) => setName(e.target.value)} />
          <Select label="Behaviour" value={mechanic} onChange={(e) => setMechanic(e.target.value)}>
            <option value="adhoc">One-time (Ad-hoc)</option>
            <option value="recurring">Repeats (Recurring)</option>
          </Select>
          <ErrorBanner message={error} />
          <Button onClick={create}><Plus className="w-4 h-4" /> Add Type</Button>
        </div>
      </Modal>
      <DataTable
          data={items}
          columns={TASK_TYPE_COLUMNS}
          tableId="admin-task-types"
          itemNoun={['task type', 'task types']}
          searchPlaceholder="Search task types…"
          cellContext={{ rename, savedId }}
          emptyTitle="No task types yet"
          emptyBody="Add one above to get started."
          rowActionsLabel=""
          rowActionsWidth={170}
          renderRowActions={(t) => (
            <RowControls
              toggleLabel={t.is_active ? 'Deactivate' : 'Activate'}
              onToggle={t.is_protected ? null : () => toggle(t)}
              confirmLabel={`Delete "${t.name}"? This can't be undone.`}
              canDelete={!t.is_protected}
              onDelete={() => remove(t)}
            />
          )}
        />
      <ErrorBanner message={loadError} />
      {loadError && <Button size="sm" variant="secondary" className="mt-2" onClick={load}>Retry</Button>}
    </Card>
  );
}

/* ---------------- Recurring Tasks (master checklist) ---------------- */
/** Edit one person's recurring task. Only fields that actually changed are sent, so opening and saving an
 *  older series doesn't rewrite its schedule label. Changes shape every task generated from now on; tasks
 *  already on someone's list keep their details (the server's PATCH /recurring-tasks/:id explains why). */
function EditRecurringModal({ item, onClose, onSaved, mainTasks, taskActivities, recurringTypes, employees, reviewers }) {
  const [title, setTitle] = useState(item.title || '');
  const [employeeId, setEmployeeId] = useState(item.employee_id || '');
  const [mainTaskId, setMainTaskId] = useState(item.main_task_id || '');
  const [taskActivityId, setTaskActivityId] = useState(item.task_activity_id || '');
  const [taskTypeId, setTaskTypeId] = useState(item.task_type_id || '');
  const [priority, setPriority] = useState(item.priority || 'Medium');
  const [reviewerId, setReviewerId] = useState(item.reviewer_id || '');
  const [rule, setRule] = useState(item.rule || DEFAULT_RULE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const activitiesForMainTask = taskActivities.filter((a) => !mainTaskId || a.main_task_id === mainTaskId);
  // Someone who has since been deactivated still shows as the current assignee rather than a blank choice.
  const assignees = employees.some((e) => e.id === item.employee_id)
    ? employees
    : [{ id: item.employee_id, full_name: `${item.employee_name || 'Unknown'} (inactive)` }, ...employees];

  function chooseMainTask(id) {
    setMainTaskId(id);
    if (!taskActivities.some((a) => a.id === taskActivityId && a.main_task_id === id)) setTaskActivityId('');
  }

  async function save() {
    setError('');
    if (!title.trim()) return setError('Please describe the recurring task.');
    if (!mainTaskId) return setError('Choose the Process this task belongs to.');
    if (!taskActivityId) return setError('Choose the Activity this task belongs to.');
    const next = {
      title: title.trim(), employee_id: employeeId, main_task_id: mainTaskId, task_activity_id: taskActivityId,
      task_type_id: taskTypeId, priority, reviewer_id: reviewerId || null,
    };
    const changes = Object.fromEntries(Object.entries(next).filter(([k, v]) => (v || null) !== (item[k] || null)));
    if (JSON.stringify(rule) !== JSON.stringify(item.rule)) changes.recurrence_rule = rule;
    if (Object.keys(changes).length === 0) return onClose();
    setSaving(true);
    try {
      await api.patch(`/recurring-tasks/${item.id}`, changes);
      onSaved();
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Edit Recurring Task" wide>
      <p className="text-xs text-grey-400 mb-3">
        Changes apply from the next task onward. Tasks already on {item.employee_name ? `${item.employee_name}'s` : 'their'} list keep their
        current details — change those in Team Tasks. A new schedule carries on from the most recent task.
      </p>
      <div className="grid sm:grid-cols-2 gap-3 mb-3">
        <Select label="Process" value={mainTaskId} onChange={(e) => chooseMainTask(e.target.value)}>
          <option value="">Choose a Process…</option>
          {mainTasks.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </Select>
        <Select label="Activity" value={taskActivityId} onChange={(e) => setTaskActivityId(e.target.value)}>
          <option value="">Choose an Activity…</option>
          {activitiesForMainTask.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
        <Input label="What is the SPECIFIC task?" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Select label="Type" value={taskTypeId} onChange={(e) => setTaskTypeId(e.target.value)}>
          {!taskTypeId && <option value="">No type</option>}
          {recurringTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
        <Select label="Assigned to" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
          {assignees.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
        </Select>
        <Select label="Priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
          {['Low', 'Medium', 'High'].map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
        <Select label="Reviewer" value={reviewerId} onChange={(e) => setReviewerId(e.target.value)}>
          <option value="">No reviewer</option>
          {reviewers.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
        </Select>
      </div>
      <div className="mb-3">
        <span className="block text-sm font-medium text-grey-700 mb-1.5">How often?</span>
        <RecurrencePicker value={rule} onChange={setRule} startDate={item.series_start_date} />
      </div>
      <ErrorBanner message={error} />
      <div className="flex justify-end gap-2 mt-3">
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : <><Check className="w-4 h-4" /> Save Changes</>}</Button>
      </div>
    </Modal>
  );
}

function RecurringTasksTab() {
  const [items, setItems] = useState(null);
  const [types, setTypes] = useState([]);
  const [mainTasks, setMainTasks] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [title, setTitle] = useState('');
  const [taskTypeId, setTaskTypeId] = useState('');
  const [mainTaskId, setMainTaskId] = useState('');
  const [taskActivities, setTaskActivities] = useState([]);
  const [taskActivityId, setTaskActivityId] = useState('');
  const [allUsers, setAllUsers] = useState([]);
  const [reviewerId, setReviewerId] = useState('');
  const [recurrenceRule, setRecurrenceRule] = useState(DEFAULT_RULE);
  const [priority, setPriority] = useState('Medium');
  const [startDate, setStartDate] = useState(getBusinessDate());
  const [employeeIds, setEmployeeIds] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);

  const recurringTypes = types.filter((t) => t.mechanic === 'recurring' && t.is_active);

  function load() {
    setLoadError('');
    api.get('/recurring-tasks').then((d) => setItems(d.recurring_tasks)).catch((e) => setLoadError(e.message || "Couldn't load recurring tasks."));
    api.get('/task-types').then((d) => {
      setTypes(d.task_types);
      const firstRecurring = d.task_types.find((t) => t.mechanic === 'recurring' && t.is_active);
      if (firstRecurring) setTaskTypeId((v) => v || firstRecurring.id);
    }).catch(() => {});
    api.get('/main-tasks').then((d) => setMainTasks(d.main_tasks.filter((m) => m.is_active))).catch(() => {});
    api.get('/task-activities').then((d) => setTaskActivities(d.task_activities.filter((a) => a.is_active))).catch(() => {});
    api.get('/users').then((d) => { setAllUsers(d.users); setEmployees(d.users.filter((u) => ['employee', 'leader'].includes(u.role) && u.is_active)); }).catch(() => {});
  }
  useEffect(() => { load(); }, []);

  // An Activity only makes sense once its own Process is picked — keeps the Process -> Activity nesting
  // something the form actually enforces, not just a suggestion. Function (above Process) isn't asked
  // for here — see resolveDefaultCategoryId's comment in masterData.js.
  const activitiesForMainTask = taskActivities.filter((a) => !mainTaskId || a.main_task_id === mainTaskId);
  const selectedActivity = taskActivities.find((a) => a.id === taskActivityId);
  const reviewers = allUsers.filter((u) => ['leader', 'admin', 'super_admin'].includes(u.role) && u.is_active);
  useEffect(() => {
    if (taskActivityId && !activitiesForMainTask.some((a) => a.id === taskActivityId)) setTaskActivityId('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainTaskId]);

  // Reviewer defaults to the single assignee's manager when exactly one person is picked (the common
  // case) — with several assignees at once each may have a different manager, so it's left for the
  // Admin to choose explicitly rather than guessing one person's manager for everyone.
  const autoFilledReviewer = useRef(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const defaultReviewer = employeeIds.length === 1 ? (allUsers.find((u) => u.id === employeeIds[0])?.manager_id || '') : '';
    // Snapshot the OLD auto-fill value before overwriting the ref — see the identical comment on this
    // same pattern in TeamTaskList.jsx's CreateTaskForm.
    const previousAutoFill = autoFilledReviewer.current;
    autoFilledReviewer.current = defaultReviewer;
    setReviewerId((r) => (!r || r === previousAutoFill) ? defaultReviewer : r);
  }, [employeeIds, allUsers]);

  // Activity is a TYPE of work, not the specific task itself (see ActivitiesTab above) — picking one no
  // longer copies its name into the title. It only shapes the placeholder into a concrete example.
  const titlePlaceholder = selectedActivity
    ? `Be specific — e.g. "${selectedActivity.name} for August 2026"`
    : 'e.g. Daily bank reconciliation';

  function toggleEmployee(id) {
    setEmployeeIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  async function create() {
    setError('');
    if (!title.trim()) return setError('Please describe the recurring task.');
    if (!mainTaskId) return setError('Choose the Process this task belongs to.');
    if (!taskActivityId) return setError('Choose the Activity this task belongs to.');
    if (employeeIds.length === 0) return setError('Choose at least one person to assign this to.');
    setSaving(true);
    try {
      await api.post('/recurring-tasks', {
        title, task_type_id: taskTypeId || null, main_task_id: mainTaskId, task_activity_id: taskActivityId, reviewer_id: reviewerId || undefined,
        recurrence_rule: recurrenceRule, priority, start_date: startDate, employee_ids: employeeIds,
      });
      setTitle(''); setMainTaskId(''); setTaskActivityId(''); setEmployeeIds([]); setFormOpen(false);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function togglePause(item) {
    await api.patch(`/recurring-tasks/${item.id}`, { is_active: item.is_active ? 0 : 1 });
    load();
  }

  if (items === null) {
    if (loadError) {
      return (
        <Card>
          <ErrorBanner message={loadError} />
          <Button size="sm" variant="secondary" className="mt-2" onClick={load}>Retry</Button>
        </Card>
      );
    }
    return <CardSkeleton lines={4} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ImportButton
          entityLabel="Recurring Tasks"
          headers={['title', 'employee_emails', 'task_type_name', 'main_task_name', 'activity_name', 'reviewer_email', 'priority', 'start_date', 'frequency']}
          example={{ title: 'Daily bank reconciliation', employee_emails: 'jane@company.com;alex@company.com', task_type_name: '', main_task_name: 'FP&A', activity_name: 'Bank Reconciliation', reviewer_email: '', priority: 'Medium', start_date: '2026-09-20', frequency: 'Daily' }}
          endpoint="/recurring-tasks/import"
          onDone={load}
        />
        <Button onClick={() => setFormOpen(true)}><Repeat className="w-4 h-4" /> Add Recurring Task</Button>
      </div>
      <Modal open={formOpen} onClose={() => setFormOpen(false)} title="Build a Recurring Task" wide>
        <p className="text-xs text-grey-400 mb-3">
          Create it once here and assign it to everyone who needs it — like a shared to-do list template. Each person gets their own copy,
          and a fresh one appears automatically on every scheduled day — whether or not the previous one is done yet.
        </p>
        <div className="grid sm:grid-cols-2 gap-3 mb-3">
          <Select label="Process" value={mainTaskId} onChange={(e) => setMainTaskId(e.target.value)}>
            <option value="">Choose a Process…</option>
            {mainTasks.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
          <Select label="Activity" value={taskActivityId} onChange={(e) => setTaskActivityId(e.target.value)}>
            <option value="">Choose an Activity…</option>
            {activitiesForMainTask.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
          <Input label="What is the SPECIFIC task?" placeholder={titlePlaceholder} value={title} onChange={(e) => setTitle(e.target.value)} />
          <Select label="Type" value={taskTypeId} onChange={(e) => setTaskTypeId(e.target.value)}>
            {recurringTypes.length === 0 && <option value="">No recurring type available</option>}
            {recurringTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
          <Select label="Priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
            {['Low', 'Medium', 'High'].map((p) => <option key={p} value={p}>{p}</option>)}
          </Select>
          <Input label="Starting" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          <Select label="Reviewer" value={reviewerId} onChange={(e) => setReviewerId(e.target.value)}>
            <option value="">No reviewer</option>
            {reviewers.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
          </Select>
        </div>
        <div className="mb-3">
          <span className="block text-sm font-medium text-grey-700 mb-1.5">How often?</span>
          <RecurrencePicker value={recurrenceRule} onChange={setRecurrenceRule} startDate={startDate} />
        </div>
        <div className="mb-3">
          <span className="block text-sm font-medium text-grey-700 mb-1.5">Assign to</span>
          {employees.length === 0 ? (
            <EmptyState icon={<IllustrationTeam className="w-14 h-14 mx-auto" />} title="No active employees or leaders yet" />
          ) : (
            <div className="flex flex-wrap gap-2">
              {employees.map((emp) => {
                const selected = employeeIds.includes(emp.id);
                return (
                  <button
                    key={emp.id}
                    type="button"
                    onClick={() => toggleEmployee(emp.id)}
                    className={`inline-flex items-center gap-1.5 text-xs font-medium rounded-full px-3 py-1.5 border transition-all press-scale ${
                      selected ? 'bg-brand-600 text-white border-brand-600 shadow-sm' : 'bg-white text-grey-600 border-grey-200 hover:border-brand-300 hover:text-brand-700'
                    }`}
                  >
                    {selected && <Check className="w-3.5 h-3.5" />}
                    {emp.full_name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <ErrorBanner message={error} />
        <Button onClick={create} disabled={saving}>{saving ? 'Creating…' : <><Plus className="w-4 h-4" /> Create & Assign</>}</Button>
      </Modal>

      <Card>
        <h2 className="font-bold text-grey-900 mb-3">Every Assigned Recurring Task</h2>
        <ErrorBanner message={loadError} />
        {loadError && <Button size="sm" variant="secondary" className="mb-3" onClick={load}>Retry</Button>}
        <DataTable
          data={items}
          columns={RECURRING_COLUMNS}
          tableId="admin-recurring"
          itemNoun={['recurring task', 'recurring tasks']}
          searchPlaceholder="Search recurring tasks…"
          emptyTitle="Nothing created yet"
          emptyBody="Build one above."
          rowActionsLabel=""
          rowActionsWidth={120}
          renderRowActions={(r) => (
            <RowControls toggleLabel={r.is_active ? 'Pause' : 'Resume'} onToggle={() => togglePause(r)}>
              <button type="button" className={LINK_BUTTON} onClick={() => setEditing(r)}>Edit</button>
            </RowControls>
          )}
        />
      </Card>
      {editing && (
        <EditRecurringModal
          key={editing.id}
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
          mainTasks={mainTasks}
          taskActivities={taskActivities}
          recurringTypes={recurringTypes}
          employees={employees}
          reviewers={reviewers}
        />
      )}
    </div>
  );
}
