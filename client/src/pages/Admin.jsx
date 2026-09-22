import { useEffect, useMemo, useRef, useState } from 'react';
import { Users, UsersRound, Tag, Tags, Repeat, Plus, Check, UserPlus, ListTree, ListChecks } from 'lucide-react';
import { api } from '../lib/api';
import { badgeClassFor, Badge, Button, Card, CardSkeleton, DeleteButton, EmptyState, ErrorBanner, IllustrationEmptyList, IllustrationTeam, Input, Modal, Select } from '../components/ui';
import HelpBanner from '../components/HelpBanner';
import RecurrencePicker, { DEFAULT_RULE } from '../components/RecurrencePicker';
import ImportButton from '../components/ImportButton';
import { useAuth } from '../lib/AuthContext';

const TABS = [
  ['Users', Users],
  ['Teams', UsersRound],
  ['Task Types', Tag],
  ['Functions', Tags],
  ['Processes', ListTree],
  ['Activities', ListChecks],
  ['Recurring Tasks', Repeat],
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
      {items.length === 0 ? (
        <EmptyState icon={<IllustrationTeam className="w-14 h-14 mx-auto" />} title="No teams yet">
          Add one above to get started.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm mt-3">
            <thead><tr className="text-left text-grey-500 border-b border-grey-200"><th className="py-1.5">Team</th><th>Leader</th><th>Status</th><th colSpan={2}></th></tr></thead>
            <tbody>
              {items.map((t, i) => (
                <tr key={t.id} className="border-b border-grey-100 hover:bg-grey-50 transition-colors animate-fade-in-up" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                  <td className="py-2 font-semibold text-grey-800">{t.name}</td>
                  <td className="text-grey-600">{t.leader_name || <span className="text-grey-300">—</span>}</td>
                  <td><Badge tone={t.is_active ? 'completed' : 'support_required'}>{t.is_active ? 'Active' : 'Inactive'}</Badge></td>
                  <td><button className="text-xs font-medium text-brand-600 hover:text-brand-800 transition-colors" onClick={() => toggle(t)}>{t.is_active ? 'Deactivate' : 'Activate'}</button></td>
                  <td><DeleteButton confirmLabel={`Delete "${t.name}"? This can't be undone.`} onConfirm={() => remove(t)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
      {items.length === 0 ? (
        <EmptyState icon={<IllustrationEmptyList className="w-14 h-14 mx-auto" />} title="No Functions yet">
          Add one above to get started.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm mt-3">
            <thead><tr className="text-left text-grey-500 border-b border-grey-200"><th className="py-1.5">Name</th><th>Description</th><th>Status</th><th colSpan={2}></th></tr></thead>
            <tbody>
              {items.map((c, i) => (
                <tr key={c.id} className="border-b border-grey-100 hover:bg-grey-50 transition-colors animate-fade-in-up" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                  <td className="py-2 pr-2">
                    <input
                      type="text"
                      defaultValue={c.name}
                      onBlur={(e) => { if (e.target.value.trim() && e.target.value !== c.name) rename(c, e.target.value, c.description); else e.target.value = c.name; }}
                      className="w-32 font-semibold text-grey-800 border border-transparent hover:border-grey-200 focus:border-brand-500 rounded-lg px-1.5 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                    />
                    {savedId === c.id && (
                      <div className="text-emerald-600 text-xs mt-0.5 flex items-center gap-1 animate-scale-in">
                        <Check className="w-3 h-3" /> Saved
                      </div>
                    )}
                  </td>
                  <td className="pr-2">
                    <input
                      type="text"
                      defaultValue={c.description || ''}
                      placeholder="—"
                      onBlur={(e) => { if (e.target.value !== (c.description || '')) rename(c, c.name, e.target.value || null); }}
                      className="w-40 text-grey-500 border border-transparent hover:border-grey-200 focus:border-brand-500 rounded-lg px-1.5 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                    />
                  </td>
                  <td><Badge tone={c.is_active ? 'completed' : 'support_required'}>{c.is_active ? 'Active' : 'Inactive'}</Badge></td>
                  <td><button className="text-xs font-medium text-brand-600 hover:text-brand-800 transition-colors" onClick={() => toggle(c)}>{c.is_active ? 'Deactivate' : 'Activate'}</button></td>
                  <td><DeleteButton confirmLabel={`Delete "${c.name}"? This can't be undone.`} onConfirm={() => remove(c)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ErrorBanner message={loadError} />
      {loadError && <Button size="sm" variant="secondary" className="mt-2" onClick={load}>Retry</Button>}
      <ErrorBanner message={error} />
    </Card>
  );
}

/* ---------------- Processes (parked under a Function, contain individual Activities) ---------------- */
function MainTasksTab() {
  const [items, setItems] = useState(null);
  const [categories, setCategories] = useState([]);
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [savedId, setSavedId] = useState(null);

  function load() {
    setLoadError('');
    api.get('/main-tasks').then((d) => setItems(d.main_tasks)).catch((e) => setLoadError(e.message || "Couldn't load Processes."));
    // Unfiltered — the inline per-row Function select below needs to resolve a Process's CURRENT
    // Function even if that Function has since been deactivated, or the select shows blank/wrong
    // instead of the real linked name. The create-form only offers activeCategories (below).
    api.get('/categories').then((d) => setCategories(d.categories)).catch(() => {});
  }
  useEffect(() => { load(); }, []);
  const activeCategories = categories.filter((c) => c.is_active);

  async function create() {
    setError('');
    if (!name.trim()) return setError('Name is required.');
    if (!categoryId) return setError('Choose the Function this Process belongs to.');
    try {
      await api.post('/main-tasks', { name, category_id: categoryId, description });
      setName(''); setCategoryId(''); setDescription(''); setFormOpen(false); load();
    } catch (e) { setError(e.message); }
  }

  async function toggle(mt) {
    await api.patch(`/main-tasks/${mt.id}`, { is_active: mt.is_active ? 0 : 1 });
    load();
  }

  async function updateCategory(mt, newCategoryId) {
    setError('');
    try {
      await api.patch(`/main-tasks/${mt.id}`, { category_id: newCategoryId || null });
      load();
    } catch (e) { setError(e.message); }
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
          A grouping between Function and individual Activities — e.g. Function "Finance" contains Processes like "FP&A" or "Accounts Payable", each of which contains the Activities that make up that Process's work.
        </p>
        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <ImportButton
            entityLabel="Processes"
            headers={['name', 'category_name', 'description']}
            example={{ name: 'FP&A', category_name: 'Finance', description: 'Financial Planning & Analysis' }}
            endpoint="/main-tasks/import"
            onDone={load}
          />
          <Button onClick={() => setFormOpen(true)}><Plus className="w-4 h-4" /> Add Process</Button>
        </div>
      </div>
      <Modal open={formOpen} onClose={() => setFormOpen(false)} title="Add Process">
        <div className="space-y-3">
          <Input label="Process name" placeholder="e.g. FP&A" value={name} onChange={(e) => setName(e.target.value)} />
          <Select label="Function" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Choose a Function…</option>
            {activeCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Input label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
          <ErrorBanner message={error} />
          <Button onClick={create}><Plus className="w-4 h-4" /> Add Process</Button>
        </div>
      </Modal>
      {items.length === 0 ? (
        <EmptyState icon={<IllustrationEmptyList className="w-14 h-14 mx-auto" />} title="No Processes yet">
          Add one above to get started.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm mt-3">
            <thead><tr className="text-left text-grey-500 border-b border-grey-200"><th className="py-1.5">Process</th><th>Function</th><th>Status</th><th colSpan={2}></th></tr></thead>
            <tbody>
              {items.map((mt, i) => (
                <tr key={mt.id} className="border-b border-grey-100 hover:bg-grey-50 transition-colors animate-fade-in-up" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                  <td className="py-2 pr-2">
                    <input
                      type="text"
                      defaultValue={mt.name}
                      onBlur={(e) => { if (e.target.value.trim() && e.target.value !== mt.name) rename(mt, e.target.value); else e.target.value = mt.name; }}
                      className="w-32 font-semibold text-grey-800 border border-transparent hover:border-grey-200 focus:border-brand-500 rounded-lg px-1.5 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                    />
                    {savedId === mt.id && (
                      <div className="text-emerald-600 text-xs mt-0.5 flex items-center gap-1 animate-scale-in">
                        <Check className="w-3 h-3" /> Saved
                      </div>
                    )}
                  </td>
                  <td>
                    <select
                      className="border border-grey-200 rounded-lg px-1.5 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500"
                      value={mt.category_id || ''}
                      onChange={(e) => updateCategory(mt, e.target.value)}
                    >
                      {categories.map((c) => <option key={c.id} value={c.id}>{c.name}{!c.is_active ? ' (inactive)' : ''}</option>)}
                    </select>
                  </td>
                  <td><Badge tone={mt.is_active ? 'completed' : 'support_required'}>{mt.is_active ? 'Active' : 'Inactive'}</Badge></td>
                  <td><button className="text-xs font-medium text-brand-600 hover:text-brand-800 transition-colors" onClick={() => toggle(mt)}>{mt.is_active ? 'Deactivate' : 'Activate'}</button></td>
                  <td><DeleteButton confirmLabel={`Delete "${mt.name}"? This can't be undone.`} onConfirm={() => remove(mt)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
  const [categories, setCategories] = useState([]);
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState(''); // create-form only, to narrow the Process list below — not stored on the Activity itself
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
    api.get('/categories').then((d) => setCategories(d.categories.filter((c) => c.is_active))).catch(() => {});
  }
  useEffect(() => { load(); }, []);

  const activeMainTasks = mainTasks.filter((m) => m.is_active);
  const mainTasksForCategory = activeMainTasks.filter((m) => !categoryId || m.category_id === categoryId);

  async function create() {
    setError('');
    if (!name.trim()) return setError('Name is required.');
    if (!mainTaskId) return setError('Choose the Process this Activity belongs to.');
    try {
      await api.post('/task-activities', { name, main_task_id: mainTaskId, description });
      setName(''); setCategoryId(''); setMainTaskId(''); setDescription(''); setFormOpen(false); load();
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
          <Select label="Function (to help find the Process below)" value={categoryId} onChange={(e) => { setCategoryId(e.target.value); setMainTaskId(''); }}>
            <option value="">All Functions</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select label="Process" value={mainTaskId} onChange={(e) => setMainTaskId(e.target.value)}>
            <option value="">Choose a Process…</option>
            {mainTasksForCategory.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
          <Input label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
          <ErrorBanner message={error} />
          <Button onClick={create}><Plus className="w-4 h-4" /> Add Activity</Button>
        </div>
      </Modal>
      {items.length === 0 ? (
        <EmptyState icon={<IllustrationEmptyList className="w-14 h-14 mx-auto" />} title="No Activities yet">
          Add one above to get started.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm mt-3">
            <thead><tr className="text-left text-grey-500 border-b border-grey-200"><th className="py-1.5">Activity</th><th>Process</th><th>Status</th><th colSpan={2}></th></tr></thead>
            <tbody>
              {items.map((a, i) => (
                <tr key={a.id} className="border-b border-grey-100 hover:bg-grey-50 transition-colors animate-fade-in-up" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                  <td className="py-2 pr-2">
                    <input
                      type="text"
                      defaultValue={a.name}
                      onBlur={(e) => { if (e.target.value.trim() && e.target.value !== a.name) rename(a, e.target.value); else e.target.value = a.name; }}
                      className="w-40 font-semibold text-grey-800 border border-transparent hover:border-grey-200 focus:border-brand-500 rounded-lg px-1.5 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                    />
                    {savedId === a.id && (
                      <div className="text-emerald-600 text-xs mt-0.5 flex items-center gap-1 animate-scale-in">
                        <Check className="w-3 h-3" /> Saved
                      </div>
                    )}
                  </td>
                  <td>
                    <select
                      className="border border-grey-200 rounded-lg px-1.5 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500"
                      value={a.main_task_id || ''}
                      onChange={(e) => updateMainTask(a, e.target.value)}
                    >
                      {mainTasks.map((m) => <option key={m.id} value={m.id}>{m.name}{!m.is_active ? ' (inactive)' : ''}</option>)}
                    </select>
                  </td>
                  <td><Badge tone={a.is_active ? 'completed' : 'support_required'}>{a.is_active ? 'Active' : 'Inactive'}</Badge></td>
                  <td><button className="text-xs font-medium text-brand-600 hover:text-brand-800 transition-colors" onClick={() => toggle(a)}>{a.is_active ? 'Deactivate' : 'Activate'}</button></td>
                  <td><DeleteButton confirmLabel={`Delete "${a.name}"? This can't be undone.`} onConfirm={() => remove(a)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
        {items.length === 0 ? (
          <EmptyState icon={<IllustrationTeam className="w-14 h-14 mx-auto" />} title="No users yet">
            Add one above to get started.
          </EmptyState>
        ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-grey-500 border-b border-grey-200"><th className="py-1.5 pr-2">Name</th><th className="pr-2">Job Title</th><th className="pr-2">Email</th><th className="pr-2">Role</th><th className="pr-2">Team</th><th className="pr-2">Status</th><th colSpan={2}></th></tr></thead>
            <tbody>
              {sortedItems.map((u, i) => (
                <tr key={u.id} className="border-b border-grey-100 hover:bg-grey-50 transition-colors animate-fade-in-up" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                  <td className="py-2 pr-2 font-semibold text-grey-800">
                    <div style={{ paddingLeft: `${u.depth * 20}px` }}>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span>{u.full_name}</span>
                        {u.is_super_admin_protected ? <Badge tone="pending">Protected</Badge> : null}
                      </div>
                      <div className="flex items-center gap-1 mt-0.5">
                        <span className="text-[11px] font-normal text-grey-400 whitespace-nowrap">reports to</span>
                        <select
                          className="text-[11px] font-normal text-grey-500 border-0 bg-transparent focus:outline-none focus:ring-1 focus:ring-brand-500/40 rounded px-0.5 -ml-0.5 cursor-pointer hover:text-brand-600 transition-colors"
                          value={u.manager_id || ''}
                          onChange={(e) => updateUser(u, { manager_id: e.target.value || null })}
                        >
                          <option value="">— no one</option>
                          {managers.filter((m) => m.id !== u.id).map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
                        </select>
                      </div>
                    </div>
                  </td>
                  <td className="pr-2">
                    <input
                      type="text"
                      defaultValue={u.job_title || ''}
                      placeholder="—"
                      onBlur={(e) => { if (e.target.value !== (u.job_title || '')) updateUser(u, { job_title: e.target.value || null }); }}
                      className="w-28 border border-grey-200 rounded-lg px-1.5 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500"
                    />
                  </td>
                  <td className="pr-2">
                    <input
                      type="email"
                      defaultValue={u.email}
                      disabled={!!u.is_super_admin_protected && currentUser.role !== 'super_admin'}
                      onBlur={(e) => { if (e.target.value !== u.email) updateUser(u, { email: e.target.value }); }}
                      className="w-40 border border-grey-200 rounded-lg px-1.5 py-1 text-xs text-grey-700 focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 disabled:bg-grey-50 disabled:text-grey-400"
                    />
                  </td>
                  <td className="pr-2">
                    <select
                      disabled={!!u.is_super_admin_protected}
                      className={`text-xs font-semibold rounded-full px-2.5 py-1 border-0 cursor-pointer transition-opacity focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:cursor-not-allowed disabled:opacity-80 ${badgeClassFor(u.role)}`}
                      value={u.role}
                      onChange={(e) => updateUser(u, { role: e.target.value })}
                    >
                      {ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </td>
                  <td className="pr-2">
                    <select
                      className="border border-grey-200 rounded-lg px-1.5 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500"
                      value={u.team_id || ''}
                      onChange={(e) => updateUser(u, { team_id: e.target.value || null })}
                    >
                      <option value="">—</option>
                      {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </td>
                  <td className="pr-2"><Badge tone={u.is_active ? 'completed' : 'support_required'}>{u.is_active ? 'Active' : 'Inactive'}</Badge></td>
                  <td className="pr-2">
                    <div className="flex items-center gap-2 whitespace-nowrap">
                      {!u.is_super_admin_protected && (
                        <button className="text-xs font-medium text-brand-600 hover:text-brand-800 transition-colors" onClick={() => updateUser(u, { is_active: u.is_active ? 0 : 1 })}>
                          {u.is_active ? 'Deactivate' : 'Activate'}
                        </button>
                      )}
                      <button className="text-xs font-medium text-grey-500 hover:text-grey-700 transition-colors" onClick={() => setResetTarget(u)}>
                        Reset Password
                      </button>
                    </div>
                  </td>
                  <td>
                    <DeleteButton
                      confirmLabel={`Delete "${u.full_name}"? This can't be undone.`}
                      disabled={u.is_super_admin_protected || u.id === currentUserId}
                      onConfirm={() => removeUser(u)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
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
      {items.length === 0 ? (
        <EmptyState icon={<IllustrationEmptyList className="w-14 h-14 mx-auto" />} title="No task types yet">
          Add one above to get started.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm mt-3">
            <thead><tr className="text-left text-grey-500 border-b border-grey-200"><th className="py-1.5">Name</th><th>Repeats?</th><th>Status</th><th colSpan={2}></th></tr></thead>
            <tbody>
              {items.map((t, i) => (
                <tr key={t.id} className="border-b border-grey-100 hover:bg-grey-50 transition-colors animate-fade-in-up" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                  <td className="py-2 pr-2">
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        defaultValue={t.name}
                        onBlur={(e) => { if (e.target.value.trim() && e.target.value !== t.name) rename(t, e.target.value); else e.target.value = t.name; }}
                        className="w-32 font-semibold text-grey-800 border border-transparent hover:border-grey-200 focus:border-brand-500 rounded-lg px-1.5 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                      />
                      {t.is_protected ? <Badge tone="pending">Built-in</Badge> : null}
                    </div>
                    {savedId === t.id && (
                      <div className="text-emerald-600 text-xs mt-0.5 flex items-center gap-1 animate-scale-in">
                        <Check className="w-3 h-3" /> Saved
                      </div>
                    )}
                  </td>
                  <td className="text-grey-500 flex items-center gap-1 py-2">{t.mechanic === 'recurring' && <Repeat className="w-3.5 h-3.5 text-brand-500" />}{t.mechanic === 'recurring' ? 'Yes' : 'No'}</td>
                  <td><Badge tone={t.is_active ? 'completed' : 'support_required'}>{t.is_active ? 'Active' : 'Inactive'}</Badge></td>
                  <td>
                    {!t.is_protected && (
                      <button className="text-xs font-medium text-brand-600 hover:text-brand-800 transition-colors" onClick={() => toggle(t)}>{t.is_active ? 'Deactivate' : 'Activate'}</button>
                    )}
                  </td>
                  <td><DeleteButton confirmLabel={`Delete "${t.name}"? This can't be undone.`} disabled={t.is_protected} onConfirm={() => remove(t)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ErrorBanner message={loadError} />
      {loadError && <Button size="sm" variant="secondary" className="mt-2" onClick={load}>Retry</Button>}
    </Card>
  );
}

/* ---------------- Recurring Tasks (master checklist) ---------------- */
function RecurringTasksTab() {
  const [items, setItems] = useState(null);
  const [types, setTypes] = useState([]);
  const [categories, setCategories] = useState([]);
  const [mainTasks, setMainTasks] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [title, setTitle] = useState('');
  const [taskTypeId, setTaskTypeId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [mainTaskId, setMainTaskId] = useState('');
  const [taskActivities, setTaskActivities] = useState([]);
  const [taskActivityId, setTaskActivityId] = useState('');
  const [allUsers, setAllUsers] = useState([]);
  const [reviewerId, setReviewerId] = useState('');
  const [recurrenceRule, setRecurrenceRule] = useState(DEFAULT_RULE);
  const [priority, setPriority] = useState('Medium');
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [employeeIds, setEmployeeIds] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [formOpen, setFormOpen] = useState(false);

  const recurringTypes = types.filter((t) => t.mechanic === 'recurring' && t.is_active);

  function load() {
    setLoadError('');
    api.get('/recurring-tasks').then((d) => setItems(d.recurring_tasks)).catch((e) => setLoadError(e.message || "Couldn't load recurring tasks."));
    api.get('/task-types').then((d) => {
      setTypes(d.task_types);
      const firstRecurring = d.task_types.find((t) => t.mechanic === 'recurring' && t.is_active);
      if (firstRecurring) setTaskTypeId((v) => v || firstRecurring.id);
    }).catch(() => {});
    api.get('/categories').then((d) => setCategories(d.categories.filter((c) => c.is_active))).catch(() => {});
    api.get('/main-tasks').then((d) => setMainTasks(d.main_tasks.filter((m) => m.is_active))).catch(() => {});
    api.get('/task-activities').then((d) => setTaskActivities(d.task_activities.filter((a) => a.is_active))).catch(() => {});
    api.get('/users').then((d) => { setAllUsers(d.users); setEmployees(d.users.filter((u) => u.role === 'employee' && u.is_active)); }).catch(() => {});
  }
  useEffect(() => { load(); }, []);

  // A Process only makes sense once its own Function is picked, and an Activity only makes sense once
  // its own Process is picked — keeps the Function -> Process -> Activity nesting something the form
  // actually enforces, not just a suggestion.
  const mainTasksForCategory = mainTasks.filter((m) => !categoryId || m.category_id === categoryId);
  const activitiesForMainTask = taskActivities.filter((a) => !mainTaskId || a.main_task_id === mainTaskId);
  const selectedActivity = taskActivities.find((a) => a.id === taskActivityId);
  const reviewers = allUsers.filter((u) => ['leader', 'admin', 'super_admin'].includes(u.role) && u.is_active);
  useEffect(() => {
    if (mainTaskId && !mainTasksForCategory.some((m) => m.id === mainTaskId)) setMainTaskId('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryId]);
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
    if (!categoryId) return setError('Choose the Function this task belongs to.');
    if (!mainTaskId) return setError('Choose the Process this task belongs to.');
    if (!taskActivityId) return setError('Choose the Activity this task belongs to.');
    if (employeeIds.length === 0) return setError('Choose at least one person to assign this to.');
    setSaving(true);
    try {
      await api.post('/recurring-tasks', {
        title, task_type_id: taskTypeId || null, category_id: categoryId, main_task_id: mainTaskId, task_activity_id: taskActivityId, reviewer_id: reviewerId || undefined,
        recurrence_rule: recurrenceRule, priority, start_date: startDate, employee_ids: employeeIds,
      });
      setTitle(''); setCategoryId(''); setMainTaskId(''); setTaskActivityId(''); setEmployeeIds([]); setFormOpen(false);
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
          headers={['title', 'employee_emails', 'task_type_name', 'category_name', 'main_task_name', 'activity_name', 'reviewer_email', 'priority', 'start_date', 'frequency']}
          example={{ title: 'Daily bank reconciliation', employee_emails: 'jane@company.com;alex@company.com', task_type_name: '', category_name: 'Finance', main_task_name: 'FP&A', activity_name: 'Bank Reconciliation', reviewer_email: '', priority: 'Medium', start_date: '2026-09-20', frequency: 'Daily' }}
          endpoint="/recurring-tasks/import"
          onDone={load}
        />
        <Button onClick={() => setFormOpen(true)}><Repeat className="w-4 h-4" /> Add Recurring Task</Button>
      </div>
      <Modal open={formOpen} onClose={() => setFormOpen(false)} title="Build a Recurring Task" wide>
        <p className="text-xs text-grey-400 mb-3">
          Create it once here and assign it to everyone who needs it — like a shared to-do list template. Each person gets their own copy,
          and a fresh one lines up automatically on the right day once they mark theirs done.
        </p>
        <div className="grid sm:grid-cols-2 gap-3 mb-3">
          <Select label="Function" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Choose a Function…</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select label="Process" value={mainTaskId} onChange={(e) => setMainTaskId(e.target.value)}>
            <option value="">Choose a Process…</option>
            {mainTasksForCategory.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
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
          <RecurrencePicker value={recurrenceRule} onChange={setRecurrenceRule} />
        </div>
        <div className="mb-3">
          <span className="block text-sm font-medium text-grey-700 mb-1.5">Assign to</span>
          {employees.length === 0 ? (
            <EmptyState icon={<IllustrationTeam className="w-14 h-14 mx-auto" />} title="No active employees yet" />
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
        {items.length === 0 ? (
          <EmptyState icon={<IllustrationEmptyList className="w-14 h-14 mx-auto" />} title="Nothing created yet">Build one above.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-grey-500 border-b border-grey-200"><th className="py-1.5">Task</th><th>Assigned to</th><th>Type</th><th>Function</th><th>Process</th><th>Frequency</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {items.map((r, i) => (
                  <tr key={r.id} className="border-b border-grey-100 hover:bg-grey-50 transition-colors animate-fade-in-up" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                    <td className="py-2 font-semibold text-grey-800">{r.title}</td>
                    <td className="text-grey-500">{r.employee_name}</td>
                    <td className="text-grey-500">{r.task_type_name || '—'}</td>
                    <td className="text-grey-500">{r.category_name || '—'}</td>
                    <td className="text-grey-500">{r.main_task_name || '—'}</td>
                    <td className="text-grey-500">{r.frequency}</td>
                    <td><Badge tone={r.is_active ? 'completed' : 'support_required'}>{r.is_active ? 'Active' : 'Paused'}</Badge></td>
                    <td><button className="text-xs font-medium text-brand-600 hover:text-brand-800 transition-colors" onClick={() => togglePause(r)}>{r.is_active ? 'Pause' : 'Resume'}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
