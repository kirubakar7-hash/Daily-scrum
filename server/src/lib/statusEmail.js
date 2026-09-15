import { db, today } from '../db.js';
import { withDelay } from './delay.js';

const STATUS_LABEL = { pending: 'Pending', in_progress: 'In Progress', support_required: 'Support Required' };
const STATUS_COLOR = { pending: '#6b665f', in_progress: '#1e5c56', support_required: '#a6291f' };

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Builds the daily status email — an org-wide summary plus every currently outstanding (non-completed)
 *  task, grouped by employee, oldest-due-first. Completed work is deliberately left out of the itemized
 *  list (per how this was asked for) — the summary line still counts it, since "how much got done today"
 *  is still useful context, but the point of the list itself is "what still needs attention." */
export function buildStatusEmail() {
  const date = today();

  const activeUsers = db.prepare(`SELECT COUNT(*) c FROM users WHERE is_active=1`).get().c;
  const teams = db.prepare(`SELECT COUNT(*) c FROM teams WHERE is_active=1`).get().c;
  const totalEmployees = db.prepare(`SELECT COUNT(*) c FROM users WHERE role='employee' AND is_active=1`).get().c;
  const scrumCompleted = db.prepare(`SELECT COUNT(*) c FROM scrum_sessions WHERE scrum_date=? AND status='completed'`).get(date).c;
  const completedToday = db.prepare(`SELECT COUNT(*) c FROM commitments WHERE status='completed' AND date(completed_at)=?`).get(date).c;
  const pendingCount = db.prepare(`SELECT COUNT(*) c FROM commitments WHERE status='pending' AND is_active=1`).get().c;
  const inProgressCount = db.prepare(`SELECT COUNT(*) c FROM commitments WHERE status='in_progress' AND is_active=1`).get().c;
  const supportRequiredCount = db.prepare(`SELECT COUNT(*) c FROM commitments WHERE status='support_required' AND is_active=1`).get().c;
  const delayedCount = db.prepare(`SELECT COUNT(*) c FROM commitments WHERE status != 'completed' AND due_date < ? AND is_active=1`).get(date).c;

  // Every outstanding task, across the whole org, oldest due date first so what's most overdue leads.
  const outstanding = db.prepare(`
    SELECT c.*, u.full_name AS employee_name
    FROM commitments c JOIN users u ON u.id = c.employee_id
    WHERE c.status != 'completed' AND c.is_active = 1 AND u.is_active = 1
    ORDER BY u.full_name, c.due_date
  `).all().map((r) => withDelay(r, date));

  const byEmployee = new Map();
  for (const t of outstanding) {
    if (!byEmployee.has(t.employee_name)) byEmployee.set(t.employee_name, []);
    byEmployee.get(t.employee_name).push(t);
  }

  const summaryRow = (label, value) => `
    <td style="padding:10px 16px;text-align:center;border-right:1px solid #e4e1d9;">
      <div style="font-size:22px;font-weight:700;color:#16191f;font-family:Georgia,serif;">${value}</div>
      <div style="font-size:11px;color:#6b665f;margin-top:2px;">${label}</div>
    </td>`;

  const taskRow = (t) => `
    <tr>
      <td style="padding:6px 10px;font-size:13px;color:#16191f;border-bottom:1px solid #edebe3;">${escapeHtml(t.description)}</td>
      <td style="padding:6px 10px;font-size:12px;border-bottom:1px solid #edebe3;white-space:nowrap;">
        <span style="color:${STATUS_COLOR[t.status] || '#6b665f'};font-weight:600;">${STATUS_LABEL[t.status] || t.status}</span>
      </td>
      <td style="padding:6px 10px;font-size:12px;color:#6b665f;border-bottom:1px solid #edebe3;white-space:nowrap;">
        ${escapeHtml(t.due_date || '—')}${t.delay_days > 0 ? ` <span style="color:#a6291f;font-weight:600;">(${t.delay_days}d late)</span>` : ''}
      </td>
    </tr>`;

  const employeeSections = [...byEmployee.entries()].map(([name, tasks]) => `
    <h3 style="font-size:14px;color:#16191f;margin:20px 0 6px;font-family:Georgia,serif;">${escapeHtml(name)} <span style="color:#6b665f;font-weight:400;font-size:12px;">(${tasks.length} outstanding)</span></h3>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr>
        <th style="text-align:left;padding:4px 10px;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#6b665f;border-bottom:1px solid #e4e1d9;">Task</th>
        <th style="text-align:left;padding:4px 10px;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#6b665f;border-bottom:1px solid #e4e1d9;">Status</th>
        <th style="text-align:left;padding:4px 10px;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#6b665f;border-bottom:1px solid #e4e1d9;">Due</th>
      </tr></thead>
      <tbody>${tasks.map(taskRow).join('')}</tbody>
    </table>`).join('');

  const html = `
  <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:640px;margin:0 auto;color:#16191f;">
    <div style="padding:20px 24px;background:#16469D;border-radius:8px 8px 0 0;">
      <div style="color:#bcd0f2;font-size:11px;letter-spacing:.08em;text-transform:uppercase;">Daily Scrum Monitoring</div>
      <h1 style="color:#fff;font-size:20px;margin:6px 0 0;font-family:Georgia,serif;">Daily Status — ${date}</h1>
    </div>
    <div style="border:1px solid #e4e1d9;border-top:none;border-radius:0 0 8px 8px;padding:20px 24px;">
      <table style="width:100%;border-collapse:collapse;background:#faf9f5;border-radius:6px;overflow:hidden;">
        <tr>
          ${summaryRow('Active Users', activeUsers)}
          ${summaryRow('Scrum Confirmed', `${scrumCompleted}/${totalEmployees}`)}
          ${summaryRow('Pending', pendingCount)}
          ${summaryRow('In Progress', inProgressCount)}
          ${summaryRow('Support Needed', supportRequiredCount)}
        </tr>
      </table>
      <p style="font-size:12px;color:#6b665f;margin:14px 0 0;">
        ${completedToday} task${completedToday === 1 ? '' : 's'} completed today.
        ${delayedCount > 0 ? `<span style="color:#a6291f;font-weight:600;">${delayedCount} task${delayedCount === 1 ? ' is' : 's are'} currently overdue.</span>` : 'Nothing is currently overdue.'}
      </p>

      <h2 style="font-size:15px;color:#16191f;margin:24px 0 4px;font-family:Georgia,serif;border-bottom:2px solid #16191f;padding-bottom:6px;">
        Outstanding Work (${outstanding.length})
      </h2>
      ${outstanding.length === 0
        ? '<p style="font-size:13px;color:#6b665f;">Nothing outstanding — every active task is completed.</p>'
        : employeeSections}

      <p style="font-size:11px;color:#9a968c;margin-top:28px;border-top:1px solid #e4e1d9;padding-top:12px;">
        Sent from Daily Scrum Monitoring. This reflects live data as of the moment it was sent.
      </p>
    </div>
  </div>`;

  const textLines = [
    `Daily Status — ${date}`,
    `Active Users: ${activeUsers} | Scrum Confirmed: ${scrumCompleted}/${totalEmployees} | Pending: ${pendingCount} | In Progress: ${inProgressCount} | Support Needed: ${supportRequiredCount}`,
    `${completedToday} completed today. ${delayedCount > 0 ? `${delayedCount} overdue.` : 'Nothing overdue.'}`,
    '',
    `Outstanding Work (${outstanding.length})`,
  ];
  for (const [name, tasks] of byEmployee) {
    textLines.push(`\n${name} (${tasks.length}):`);
    for (const t of tasks) {
      textLines.push(`  - [${STATUS_LABEL[t.status] || t.status}] ${t.description} (due ${t.due_date || '—'}${t.delay_days > 0 ? `, ${t.delay_days}d late` : ''})`);
    }
  }

  return {
    subject: `Daily Status — ${date}${delayedCount > 0 ? ` (${delayedCount} overdue)` : ''}`,
    html,
    text: textLines.join('\n'),
    taskCount: outstanding.length,
  };
}
