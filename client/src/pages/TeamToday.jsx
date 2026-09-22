import { useEffect, useState } from 'react';
import { ClipboardList, Users, CheckCircle2, AlertTriangle, LifeBuoy, CalendarClock, Inbox } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Badge, Button, Card, EmptyState, ErrorBanner, IllustrationEmptyList, IllustrationTeam, Input, Skeleton } from '../components/ui';
import HelpBanner from '../components/HelpBanner';
import TeamTaskList from '../components/TeamTaskList';

// The real current day — used wherever "today" must mean today regardless of what date Team Overview
// is currently browsing (Team Tasks/Requests deliberately stay on live, current data; see selectedDate).
const todayStr = new Date().toISOString().slice(0, 10);
const TABS = [
  ['Team Overview', Users],
  ['Team Tasks', ClipboardList],
  ['Requests', Inbox],
];

export default function TeamToday() {
  const { user } = useAuth();
  const [team, setTeam] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState('Team Overview');
  // Only Team Overview's scrum-status table is date-navigable — never wrapped in `new Date(...)`, since
  // that would shift the selected calendar day by the viewer's local timezone (kept as the plain
  // YYYY-MM-DD string the date input already produces, straight through to the API).
  const [selectedDate, setSelectedDate] = useState(todayStr);
  const readOnly = user.role === 'senior_management';
  const canReachAdmin = user.role === 'admin' || user.role === 'super_admin';

  function load() {
    setLoadError('');
    api.get(`/leader/team-today?date=${selectedDate}`).then((d) => setTeam(d.team)).catch((e) => setLoadError(e.message || "Couldn't load the team."));
  }

  useEffect(() => { load(); }, [selectedDate]);

  if (!team) {
    if (loadError) {
      return <Card><ErrorBanner message={loadError} /><Button size="sm" variant="secondary" className="mt-2" onClick={load}>Retry</Button></Card>;
    }
    return (
      <div className="space-y-4">
        <Card><Skeleton className="h-5 w-1/3 mb-3" /><Skeleton className="h-3 w-1/4 mb-5" /><Skeleton className="h-24 w-full" /></Card>
        <Card><Skeleton className="h-5 w-1/4 mb-3" /><Skeleton className="h-20 w-full" /></Card>
      </div>
    );
  }

  const totalDelayed = team.reduce((sum, r) => sum + r.delayed, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 animate-fade-in-up">
        <div>
          <h1 className="text-lg font-bold text-grey-900 flex items-center gap-2">
            <ClipboardList className="w-5 h-5 text-brand-600" />
            Daily Scrum — {selectedDate}
          </h1>
          {team.length > 0 && (
            <p className="text-sm text-grey-500 mt-0.5">
              <span className="font-semibold text-brand-600">{team.length}</span> team member{team.length === 1 ? '' : 's'}
              {totalDelayed > 0 && <> · <span className="font-semibold text-accent-600">{totalDelayed}</span> task{totalDelayed === 1 ? '' : 's'} delayed</>}
            </p>
          )}
        </div>
        {tab === 'Team Overview' && (
          <div className="flex items-end gap-2">
            <Input
              label="Viewing date"
              type="date"
              value={selectedDate}
              max={todayStr}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="!w-auto"
            />
            {selectedDate !== todayStr && (
              <Button size="sm" variant="secondary" onClick={() => setSelectedDate(todayStr)}>Back to Today</Button>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-1 bg-grey-100 rounded-xl p-1 w-fit animate-fade-in-up">
        {TABS.map(([t, Icon]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            data-tour={t === 'Team Overview' ? 'team-overview-table' : 'team-tasks-section'}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold transition-all press-scale ${
              tab === t ? 'bg-white text-brand-700 shadow-sm' : 'text-grey-500 hover:text-grey-700'
            }`}
          >
            <Icon className="w-4 h-4" /> {t}
          </button>
        ))}
      </div>

      {tab === 'Team Overview' && (
        <Card className="animate-fade-in-up">
          <HelpBanner>
            This screen shows what each person actually needs, without you asking. <strong>Scrum</strong> shows whether they've confirmed that day's commitments yet — pick a date above to look back at any past day.{' '}
            <Badge tone="support_required">Delayed</Badge> counts tasks whose due date has passed —{' '}
            calculated automatically from the due date, never entered by hand. <Badge tone="support_required">Support</Badge> shows tasks flagged as needing your help.
          </HelpBanner>

          {team.length === 0 ? (
            <EmptyState icon={<IllustrationTeam className="w-16 h-16 mx-auto" />} title="No team members assigned yet">
              {canReachAdmin
                ? 'Set the "Reports To" field for employees under Admin → Users to build out your team.'
                : 'No employees are set to report to you yet.'}
            </EmptyState>
          ) : (
            <div className="overflow-x-auto mt-2">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-grey-500 border-b border-grey-200">
                    <th className="py-2 pr-4">Employee</th>
                    <th className="py-2 pr-4 text-right">Scrum</th>
                    <th className="py-2 pr-4 text-right">Today's Work</th>
                    <th className="py-2 pr-4 text-right">Delayed</th>
                    <th className="py-2 pr-4 text-right">Support</th>
                  </tr>
                </thead>
                <tbody>
                  {team.map((row, i) => (
                    <tr key={row.employee_id} className="border-b border-grey-100 hover:bg-grey-50 transition-colors animate-fade-in-up" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                      <td className="py-2.5 pr-4">
                        <div className="flex items-center gap-2.5">
                          <span className="w-7 h-7 rounded-full bg-brand-50 text-brand-700 text-xs font-bold flex items-center justify-center shrink-0">
                            {row.full_name?.charAt(0)?.toUpperCase()}
                          </span>
                          <span className="font-semibold text-grey-800">{row.full_name}</span>
                        </div>
                      </td>
                      <td className="py-2 pr-4 text-right">
                        {row.scrum_status === 'completed'
                          ? <span className="inline-flex items-center gap-1 text-emerald-600 font-semibold"><CheckCircle2 className="w-3.5 h-3.5" /> Done</span>
                          : <span className="text-grey-400">Pending</span>}
                      </td>
                      <td className="py-2 pr-4 text-right text-grey-700">{row.today_work_count}</td>
                      <td className="py-2 pr-4 text-right">
                        {row.delayed > 0 ? (
                          <span className="inline-flex items-center gap-1 text-accent-600 font-semibold">
                            <AlertTriangle className="w-3.5 h-3.5" /> {row.delayed}
                          </span>
                        ) : <span className="text-grey-400">—</span>}
                      </td>
                      <td className="py-2 pr-4 text-right">
                        {row.support_required > 0 ? (
                          <span className="inline-flex items-center gap-1 text-amber-600 font-semibold">
                            <LifeBuoy className="w-3.5 h-3.5" /> {row.support_required}
                          </span>
                        ) : <span className="text-grey-400">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'Team Tasks' && (
        <Card className="animate-fade-in-up">
          <TeamTaskList team={team} readOnly={readOnly} date={todayStr} />
        </Card>
      )}

      {tab === 'Requests' && (
        <Card className="animate-fade-in-up">
          <RequestsTab readOnly={readOnly} />
        </Card>
      )}
    </div>
  );
}

const requestTypeLabel = { support: 'Support', due_date_change: 'Due-Date Change' };
const requestTypeTone = { support: 'support_required', due_date_change: 'recurring' };

function RequestsTab({ readOnly }) {
  const [requests, setRequests] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [notes, setNotes] = useState({});
  const [error, setError] = useState('');

  function load() {
    setLoadError('');
    api.get('/requests?status=pending').then((d) => setRequests(d.requests)).catch((e) => setLoadError(e.message || "Couldn't load requests."));
  }

  useEffect(() => { load(); }, []);

  async function resolve(id, action) {
    setBusyId(id);
    setError('');
    try {
      await api.post(`/requests/${id}/${action}`, { leader_note: notes[id] || undefined });
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  }

  if (!requests) {
    if (loadError) return <div><ErrorBannerInline message={loadError} /><Button size="sm" variant="secondary" onClick={load}>Retry</Button></div>;
    return <Skeleton className="h-24 w-full" />;
  }

  return (
    <div>
      <p className="text-xs text-grey-500 leading-relaxed mb-3">
        A Support request flags the task Support Required right away, visible to everyone — it's already waiting on a Leader's help, not just their approval.
        A Due-Date Change request leaves the current due date untouched until a Leader approves it.
      </p>
      <ErrorBannerInline message={error} />
      {requests.length === 0 ? (
        <EmptyState icon={<IllustrationEmptyList className="w-16 h-16 mx-auto" />} title="Nothing pending">
          No requests are waiting on you right now.
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {requests.map((r, i) => (
            <div key={r.id} className="border border-grey-200 rounded-xl p-3.5 animate-fade-in-up" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <Badge tone={requestTypeTone[r.type]}>{requestTypeLabel[r.type]}</Badge>
                    <span className="text-sm font-semibold text-grey-800">{r.description}</span>
                  </div>
                  <div className="text-xs text-grey-500">
                    Requested by <strong>{r.requested_by_name}</strong> for <strong>{r.employee_name}</strong>
                    {r.type === 'due_date_change' && <> — new due date <strong>{r.requested_due_date}</strong> (currently {r.due_date})</>}
                  </div>
                  {(r.reason || r.explanation) && (
                    <div className="text-xs text-grey-600 mt-1 flex items-start gap-1">
                      {r.type === 'support' ? <LifeBuoy className="w-3 h-3 mt-0.5 shrink-0" /> : <CalendarClock className="w-3 h-3 mt-0.5 shrink-0" />}
                      <span>{r.reason && <strong>{r.reason}</strong>}{r.reason && r.explanation && ' — '}{r.explanation}</span>
                    </div>
                  )}
                </div>
              </div>
              {!readOnly && (
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  <Input
                    className="flex-1 min-w-[160px]"
                    placeholder="Optional note…"
                    value={notes[r.id] || ''}
                    onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
                  />
                  <Button size="sm" disabled={busyId === r.id} onClick={() => resolve(r.id, 'approve')}>
                    <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                  </Button>
                  <Button size="sm" variant="secondary" disabled={busyId === r.id} onClick={() => resolve(r.id, 'reject')}>
                    Reject
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ErrorBannerInline({ message }) {
  if (!message) return null;
  return <div className="text-accent-600 text-sm mb-3">{message}</div>;
}
