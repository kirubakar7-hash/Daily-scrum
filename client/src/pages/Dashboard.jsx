import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Users, UsersRound, CheckCircle2, Clock, LifeBuoy, ListTodo,
  Repeat, Zap, ClipboardList, Bell, TrendingUp,
  Target, Mail,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Badge, BarList, Button, Card, CardSkeleton, DonutChart, EmptyState, ErrorBanner, IllustrationEmptyList, IllustrationSuccess, IllustrationTeam, KpiCard } from '../components/ui';
import HelpBanner from '../components/HelpBanner';

/** Cascading per-row entrance, capped so a long list doesn't stay visibly "still populating" — matches
 *  the same cap Timeline already uses (ui.jsx) for consistency across the app. */
const rowDelay = (i) => ({ animationDelay: `${Math.min(i, 8) * 40}ms` });

export default function Dashboard() {
  const { user } = useAuth();
  const isOrgView = ['super_admin', 'senior_management'].includes(user.role);
  const isLeaderView = ['leader', 'admin'].includes(user.role);
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');

  function load() {
    setLoadError('');
    const path = isOrgView ? '/dashboard/org' : isLeaderView ? '/dashboard/leader' : '/dashboard/employee';
    api.get(path).then(setData).catch((e) => setLoadError(e.message || "Couldn't load the dashboard."));
  }

  useEffect(load, [isOrgView, isLeaderView]);

  if (!data) {
    if (loadError) {
      return <Card><ErrorBanner message={loadError} /><Button size="sm" variant="secondary" className="mt-2" onClick={load}>Retry</Button></Card>;
    }
    return (
      <div className="space-y-3">
        <div>
          <div className="h-6 w-56 rounded-lg bg-grey-100 animate-shimmer mb-2" />
          <div className="h-4 w-72 rounded-lg bg-grey-100 animate-shimmer" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {Array.from({ length: 4 }).map((_, i) => <CardSkeleton key={i} lines={1} />)}
        </div>
      </div>
    );
  }

  if (isOrgView) return <OrgDashboard data={data} role={user.role} />;
  if (isLeaderView) return <LeaderDashboard data={data} role={user.role} />;
  return <EmployeeDashboard data={data} />;
}

function SplitCard({ label, pct, explain, tone, icon: Icon }) {
  return (
    <Card interactive dense className="animate-fade-in-up">
      <div className="flex items-center gap-3">
        <DonutChart value={pct ?? 0} max={100} size={44} stroke={6} tone={tone} centerLabel={pct != null ? `${pct}%` : '—'} />
        <div className="min-w-0">
          <div className="text-sm font-bold text-grey-800 flex items-center gap-1.5">
            <Icon className="w-3.5 h-3.5 text-grey-400 shrink-0" /> {label}
          </div>
          <div className="text-xs text-grey-400 mt-0.5 leading-snug">{explain}</div>
        </div>
      </div>
    </Card>
  );
}

/** The on-demand "send now" trigger the user asked for, in place of a scheduled/automatic email:
 *  checks /status-email-ready on mount so it can explain a missing SMTP/recipient setup instead of
 *  just failing silently when clicked, then posts to /send-status-email and reports what happened. */
function StatusEmailButton() {
  const [ready, setReady] = useState(null);
  const [state, setState] = useState('idle'); // idle | sending | sent | failed
  const [message, setMessage] = useState('');

  useEffect(() => {
    api.get('/dashboard/status-email-ready')
      .then(setReady)
      .catch(() => setReady({ configured: false, recipients: [] }));
  }, []);

  function send() {
    setState('sending');
    setMessage('');
    api.post('/dashboard/send-status-email')
      .then((d) => {
        setState('sent');
        setMessage(`Sent to ${d.sent_to.length} recipient${d.sent_to.length === 1 ? '' : 's'} — ${d.task_count} outstanding task${d.task_count === 1 ? '' : 's'} listed.`);
      })
      .catch((e) => {
        setState('failed');
        setMessage(e.message || "Couldn't send the email.");
      });
  }

  if (ready && !ready.configured) {
    return (
      <Card dense className="animate-fade-in-up border-amber-200 bg-amber-50">
        <div className="flex items-center gap-2 text-sm text-amber-800">
          <Mail className="w-4 h-4 shrink-0" />
          Status email isn't set up yet — the server needs SMTP and recipient settings before this can be used.
        </div>
      </Card>
    );
  }

  return (
    <Card dense className="animate-fade-in-up">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-sm font-bold text-grey-800 flex items-center gap-1.5">
            <Mail className="w-4 h-4 text-brand-600 shrink-0" /> Daily Status Email
          </div>
          <div className="text-xs text-grey-400 mt-0.5">
            Sends today's summary and every outstanding task to {ready ? `${ready.recipients.length} stakeholder${ready.recipients.length === 1 ? '' : 's'}` : '…'}.
          </div>
        </div>
        <Button size="sm" onClick={send} disabled={!ready || state === 'sending'}>
          {state === 'sending' ? 'Sending…' : 'Send Status Update'}
        </Button>
      </div>
      {state === 'sent' && <div className="mt-2 text-xs font-medium text-emerald-700 bg-emerald-50 rounded-lg px-2.5 py-1.5">{message}</div>}
      {state === 'failed' && <div className="mt-2 text-xs font-medium text-accent-700 bg-accent-50 rounded-lg px-2.5 py-1.5">{message}</div>}
    </Card>
  );
}

function OrgDashboard({ data, role }) {
  const heading = role === 'super_admin' ? 'System Control Center' : 'Organization Overview';
  const sub = role === 'super_admin'
    ? 'Full visibility and control across every team, user, and record.'
    : 'A read-only view of how the organization is performing today.';
  const attn = data.attention_required;
  const hasOrgAttention = attn && Object.values(attn).some((arr) => arr.length > 0);
  return (
    <div className="space-y-3">
      <div className="animate-fade-in-up">
        <h1 className="text-lg font-bold text-grey-900">{heading}</h1>
        <p className="text-grey-500 text-sm mt-0.5">{sub} — {data.date}</p>
      </div>
      <HelpBanner>
        This screen rolls up every team's Daily Scrum into organization-wide numbers, calculated live from the database — nothing here is hard-coded.
        Drill down via <strong>Admin</strong> (manage users and teams) or <strong>Daily Scrum</strong> / <strong>History</strong> for the detail behind any number.
      </HelpBanner>

      {/* Same "bottlenecks first" placement as the Leader dashboard — the one thing a 2-minute visit
          should answer first is "what, specifically, needs my attention," not a pile of totals. */}
      <Card dense className="animate-fade-in-up">
        <h2 className="font-bold text-accent-700 mb-1 flex items-center gap-2"><Bell className="w-4 h-4" /> Needs Attention, Org-Wide</h2>
        <p className="text-xs text-grey-400 mb-2">These signals just mean "worth a look" — not a judgment on anyone's performance.</p>
        {!hasOrgAttention && <EmptyState icon={<IllustrationSuccess className="w-16 h-16 mx-auto animate-pop-in" />} title="All clear">Nothing needs urgent attention right now.</EmptyState>}
        {attn?.support_requests.length > 0 && (
          <AttentionGroup icon={LifeBuoy} tone="accent" title="Support Requested" items={attn.support_requests.map((c) => `${c.full_name} — ${c.description}${c.non_completion_explanation ? `: "${c.non_completion_explanation}"` : ''}`)} />
        )}
        {attn?.delayed_commitments.length > 0 && (
          <AttentionGroup icon={Clock} tone="accent" title="Delayed Tasks" items={attn.delayed_commitments.map((c) => `${c.full_name} — ${c.description} (${c.delay_days} day${c.delay_days === 1 ? '' : 's'} delayed)`)} />
        )}
      </Card>

      {role === 'super_admin' && <StatusEmailButton />}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <KpiCard dense className="animate-fade-in-up" style={rowDelay(0)} icon={<Users className="w-4 h-4" />} label="Active Users" value={data.active_users} to="/admin" tone="brand" />
        <KpiCard dense className="animate-fade-in-up" style={rowDelay(1)} icon={<UsersRound className="w-4 h-4" />} label="Teams" value={data.teams} to="/admin" tone="brand" />
        <KpiCard dense className="animate-fade-in-up" style={rowDelay(2)} icon={<CheckCircle2 className="w-4 h-4" />} label="Scrum Completed" value={`${data.scrum_completed}/${data.total_employees}`} to="/team" tone="brand" explain="Who's confirmed today's commitments so far." />
        <KpiCard dense className="animate-fade-in-up" style={rowDelay(3)} icon={<ListTodo className="w-4 h-4" />} label="Pending" value={data.pending} to="/history?status=pending" tone="grey" explain="Tasks not yet started." />
        <KpiCard dense className="animate-fade-in-up" style={rowDelay(4)} icon={<Zap className="w-4 h-4" />} label="In Progress" value={data.in_progress} to="/history?status=in_progress" tone="brand" explain="Tasks actively being worked." />
        <KpiCard dense className="animate-fade-in-up" style={rowDelay(5)} icon={<CheckCircle2 className="w-4 h-4" />} label="Completed" value={data.completed} to="/history?status=completed" tone="success" explain="Tasks marked done." />
        <KpiCard dense className="animate-fade-in-up" style={rowDelay(6)} icon={<LifeBuoy className="w-4 h-4" />} label="Support Required" value={data.support_required} to="/history?status=support_required" tone="accent" explain="Tasks currently flagged as needing a leader's help." />
      </div>
      <div className="grid sm:grid-cols-2 gap-2">
        <SplitCard label="Recurring Work" pct={data.recurring_pct} explain="Portion of recorded work that is regular, planned work." tone="brand" icon={Repeat} />
        <SplitCard label="Ad-hoc Work" pct={data.adhoc_pct} explain="Portion of recorded work that was unexpected or one-time." tone="grey" icon={Zap} />
      </div>
      <Card dense className="animate-fade-in-up">
        <h2 className="font-bold text-grey-900 mb-2 flex items-center gap-2"><UsersRound className="w-4 h-4 text-brand-600" /> By Team</h2>
        {data.by_team.length === 0 ? (
          <EmptyState icon={<IllustrationTeam className="w-16 h-16 mx-auto" />} title="No teams yet">Create a team under Admin to get started.</EmptyState>
        ) : (
          <div className="grid md:grid-cols-2 gap-4">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-grey-500 border-b border-grey-200"><th className="py-1">Team</th><th>Leader</th><th className="text-right">Scrum Today</th></tr></thead>
                <tbody>
                  {data.by_team.map((t, i) => (
                    <tr key={t.team_name} className="border-b border-grey-100 hover:bg-grey-50 transition-colors animate-fade-in-up" style={rowDelay(i)}>
                      <td className="py-1.5 font-semibold text-grey-800">{t.team_name}</td>
                      <td className="text-grey-600">{t.leader_name || <span className="text-grey-300">—</span>}</td>
                      <td className="text-right text-grey-700">{t.scrum_completed}/{t.employees}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <BarList
              tone="brand"
              max={100}
              items={data.by_team.map((t) => ({ label: t.team_name, value: t.employees ? Math.round((t.scrum_completed / t.employees) * 100) : 0 }))}
            />
          </div>
        )}
      </Card>
    </div>
  );
}

function LeaderDashboard({ data, role }) {
  const attn = data.attention_required;
  const hasAttention = attn && Object.values(attn).some((arr) => arr.length > 0);
  // An Admin has org-wide scope, same as Super Admin everywhere else — "My Team Today" undersold what
  // this screen actually shows them, so the heading and count now say so plainly.
  const heading = role === 'admin' ? 'Organization Today' : 'My Team Today';
  const teamLabel = role === 'admin' ? `${data.team_members} people across the organization` : `${data.team_members} people on your team`;

  return (
    <div className="space-y-3">
      <div className="animate-fade-in-up">
        <h1 className="text-lg font-bold text-grey-900">{heading}</h1>
        <p className="text-grey-500 text-sm mt-0.5">
          <Link to="/team" className="text-brand-600 font-semibold hover:underline">{teamLabel}</Link>
          {' '}· {data.pending} task{data.pending === 1 ? '' : 's'} pending
        </p>
      </div>

      <StatusEmailButton />

      {/* Bottlenecks first — matches how a leader actually scans this page: what needs me right now,
          before the supporting numbers. Every item below is unchanged from before, just promoted higher. */}
      <Card dense data-tour="attention-section" className="animate-fade-in-up">
        <h2 className="font-bold text-accent-700 mb-1 flex items-center gap-2"><Bell className="w-4 h-4" /> Leadership Attention Required</h2>
        <p className="text-xs text-grey-400 mb-2">These signals just mean "worth a look" — not a judgment on anyone's performance.</p>
        {!hasAttention && <EmptyState icon={<IllustrationSuccess className="w-16 h-16 mx-auto animate-pop-in" />} title="All clear">Nothing needs urgent attention right now.</EmptyState>}
        {attn.support_requests.length > 0 && (
          <AttentionGroup icon={LifeBuoy} tone="accent" title="Support Requested" items={attn.support_requests.map((c) => `${c.full_name} — ${c.description}${c.non_completion_explanation ? `: "${c.non_completion_explanation}"` : ''}`)} />
        )}
        {attn.delayed_commitments.length > 0 && (
          <AttentionGroup icon={Clock} tone="accent" title="Delayed Tasks" items={attn.delayed_commitments.map((c) => `${c.full_name} — ${c.description} (${c.delay_days} day${c.delay_days === 1 ? '' : 's'} delayed)`)} />
        )}
        {attn.repeated_support_requests.length > 0 && (
          <AttentionGroup icon={Repeat} tone="brand" title="Repeated Support Requests" items={attn.repeated_support_requests.map((c) => `${c.full_name} — ${c.description} (asked for help ${c.cnt} times)`)} />
        )}
        {attn.high_adhoc_workload.length > 0 && (
          <AttentionGroup icon={Zap} tone="amber" title="High Ad-hoc Workload" items={attn.high_adhoc_workload.map((e) => `${e.full_name} — ${Math.round((e.adhoc_count / e.total_count) * 100)}% ad-hoc`)} />
        )}
      </Card>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <KpiCard dense className="animate-fade-in-up" style={rowDelay(0)} icon={<Users className="w-4 h-4" />} label="Team Members" value={data.team_members} to="/team" tone="brand" />
        <KpiCard dense className="animate-fade-in-up" style={rowDelay(1)} icon={<CheckCircle2 className="w-4 h-4" />} label="Scrum Completed" value={`${data.scrum_completed}/${data.team_members}`} to="/team" tone="brand" explain="Who's confirmed today's commitments so far." />
        <KpiCard dense className="animate-fade-in-up" style={rowDelay(2)} icon={<ListTodo className="w-4 h-4" />} label="Pending" value={data.pending} to="/history?status=pending" tone="grey" explain="Tasks not yet started." />
        <KpiCard dense className="animate-fade-in-up" style={rowDelay(3)} icon={<Zap className="w-4 h-4" />} label="In Progress" value={data.in_progress} to="/history?status=in_progress" tone="brand" explain="Tasks actively being worked." />
        <KpiCard dense className="animate-fade-in-up" style={rowDelay(4)} icon={<CheckCircle2 className="w-4 h-4" />} label="Completed" value={data.completed} to="/history?status=completed" tone="success" explain="Tasks marked done." />
        <KpiCard dense className="animate-fade-in-up" style={rowDelay(5)} icon={<LifeBuoy className="w-4 h-4" />} label="Support Required" value={data.support_required} to="/history?status=support_required" tone="accent" explain="Tasks your team has flagged as needing your help." />
        <KpiCard dense className="animate-fade-in-up" style={rowDelay(6)} icon={<Target className="w-4 h-4" />} label="Commitment %" value={data.commitment_pct != null ? `${data.commitment_pct}%` : '—'} tone="success" explain="Percentage of due commitments that were completed." />
      </div>

      <div className="grid sm:grid-cols-2 gap-2">
        <SplitCard label="Recurring Work" pct={data.recurring_pct} explain="Portion of your team's work that is regular, planned work." tone="brand" icon={Repeat} />
        <SplitCard label="Ad-hoc Work" pct={data.adhoc_pct} explain="Portion of your team's work that was unexpected or one-time." tone="grey" icon={Zap} />
      </div>
    </div>
  );
}

const attentionToneClasses = {
  accent: 'bg-accent-50 text-accent-800',
  amber: 'bg-amber-50 text-amber-800',
  brand: 'bg-brand-50 text-brand-800',
};
const attentionIconClasses = {
  accent: 'text-accent-500',
  amber: 'text-amber-500',
  brand: 'text-brand-500',
};

function AttentionGroup({ title, items, icon: Icon, tone = 'amber' }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="text-sm font-semibold text-grey-700 mb-1.5 flex items-center gap-1.5">
        <Icon className={`w-3.5 h-3.5 ${attentionIconClasses[tone]}`} /> {title}
      </div>
      <ul className="text-sm text-grey-700 space-y-1">
        {items.map((t, i) => (
          <li key={i} className={`rounded-lg px-2.5 py-1.5 ${attentionToneClasses[tone]}`}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

function EmployeeDashboard({ data }) {
  return (
    <div className="space-y-3">
      <div className="animate-fade-in-up">
        <h1 className="text-lg font-bold text-grey-900">My Work</h1>
        <p className="text-grey-500 text-sm mt-0.5">What's on my plate today?</p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <KpiCard dense className="animate-fade-in-up" style={rowDelay(0)} icon={<ClipboardList className="w-4 h-4" />} label="Today's Tasks" value={data.today_commitments.length} to="/my-tasks" tone="brand" />
        <KpiCard dense className="animate-fade-in-up" style={rowDelay(1)} icon={<ListTodo className="w-4 h-4" />} label="Pending" value={data.pending} to="/history?status=pending" tone="grey" explain="Tasks not yet started." />
        <KpiCard dense className="animate-fade-in-up" style={rowDelay(2)} icon={<Zap className="w-4 h-4" />} label="In Progress" value={data.in_progress} to="/history?status=in_progress" tone="brand" explain="Tasks you're actively working." />
        <KpiCard dense className="animate-fade-in-up" style={rowDelay(3)} icon={<CheckCircle2 className="w-4 h-4" />} label="Completed" value={data.completed} to="/history?status=completed" tone="success" explain="Tasks you've marked done." />
        <KpiCard dense className="animate-fade-in-up" style={rowDelay(4)} icon={<LifeBuoy className="w-4 h-4" />} label="Support Required" value={data.support_required} to="/history?status=support_required" tone="accent" explain="Tasks you've flagged as needing help." />
        <KpiCard
          dense
          className="animate-fade-in-up"
          style={rowDelay(5)}
          icon={<TrendingUp className="w-4 h-4" />}
          label="Commitment %"
          value={data.commitment_completion_rate != null ? `${data.commitment_completion_rate}%` : '—'}
          tone="success"
          explain="Percentage of your due commitments that were completed."
        />
      </div>
      <Card dense className="animate-fade-in-up">
        <h2 className="font-bold text-grey-900 mb-2 flex items-center gap-2"><ClipboardList className="w-4 h-4 text-brand-600" /> Today's Activities</h2>
        {data.today_commitments.length === 0 ? (
          <EmptyState icon={<IllustrationEmptyList className="w-16 h-16 mx-auto" />} title="Nothing due today">
            Nothing has been assigned to you for today yet.
          </EmptyState>
        ) : (
          <ul className="space-y-2">
            {data.today_commitments.map((c, i) => (
              <li key={c.id} className="flex justify-between items-center text-sm border-b border-grey-100 pb-2 last:border-0 last:pb-0 animate-fade-in-up" style={rowDelay(i)}>
                <span className="text-grey-700">{c.description}</span>
                <Badge tone={c.status}>{c.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {data.delayed_work.length > 0 && (
        <Card dense className="border-accent-200 animate-fade-in-up">
          <h2 className="font-bold text-accent-700 mb-2 flex items-center gap-2"><Clock className="w-4 h-4" /> Delayed</h2>
          <ul className="space-y-1.5 text-sm">
            {data.delayed_work.map((c) => (
              <li key={c.id} className="flex items-center gap-2 text-grey-700">
                <span className="w-1.5 h-1.5 rounded-full bg-accent-500 shrink-0" />
                {c.description} — {c.delay_days} day{c.delay_days === 1 ? '' : 's'} delayed (due {c.due_date})
              </li>
            ))}
          </ul>
        </Card>
      )}
      {data.support_requested.length > 0 && (
        <Card dense className="border-accent-200 animate-fade-in-up">
          <h2 className="font-bold text-accent-700 mb-2 flex items-center gap-2"><LifeBuoy className="w-4 h-4" /> Waiting on Support</h2>
          <p className="text-xs text-grey-400 mb-2">These are visible to every Leader in their Requests inbox, waiting for one to review.</p>
          <ul className="space-y-1 text-sm text-grey-700">
            {data.support_requested.map((c) => <li key={c.id}>{c.description}</li>)}
          </ul>
        </Card>
      )}
    </div>
  );
}
