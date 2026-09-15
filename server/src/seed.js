import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { db, today } from './db.js';

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function hash(pw) {
  return bcrypt.hashSync(pw, 10);
}

const existingCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (existingCount > 0) {
  console.log(`Seed skipped — ${existingCount} users already exist. Delete server/data/scrum.db to reseed from scratch.`);
  process.exit(0);
}

console.log('Seeding Daily Scrum Monitoring demo data...');

const DEFAULT_PASSWORD = 'Password123!';

// Users: Super Admin, Admin (created first, teams reference leader ids so leaders created before teams get updated)
const superAdminId = uuid();
const adminId = uuid();
const leader1Id = uuid();
const leader2Id = uuid();

db.prepare(`INSERT INTO users (id, full_name, email, password_hash, role, job_title, is_super_admin_protected) VALUES (?, ?, ?, ?, ?, ?, 1)`)
  .run(superAdminId, 'Kirubakar B', 'superadmin@dailyscrum.local', hash(DEFAULT_PASSWORD), 'super_admin', 'Super Admin');

db.prepare(`INSERT INTO users (id, full_name, email, password_hash, role, job_title) VALUES (?, ?, ?, ?, ?, ?)`)
  .run(adminId, 'Arun Admin', 'admin@dailyscrum.local', hash(DEFAULT_PASSWORD), 'admin', 'Systems Admin');

db.prepare(`INSERT INTO users (id, full_name, email, password_hash, role, job_title) VALUES (?, ?, ?, ?, ?, ?)`)
  .run(leader1Id, 'Meena Leader', 'meena.leader@dailyscrum.local', hash(DEFAULT_PASSWORD), 'leader', 'Finance Team Lead');

db.prepare(`INSERT INTO users (id, full_name, email, password_hash, role, job_title) VALUES (?, ?, ?, ?, ?, ?)`)
  .run(leader2Id, 'Ravi Leader', 'ravi.leader@dailyscrum.local', hash(DEFAULT_PASSWORD), 'leader', 'Operations Team Lead');

const seniorMgmtId = uuid();
db.prepare(`INSERT INTO users (id, full_name, email, password_hash, role, job_title) VALUES (?, ?, ?, ?, ?, ?)`)
  .run(seniorMgmtId, 'Deepika Director', 'director@dailyscrum.local', hash(DEFAULT_PASSWORD), 'senior_management', 'Director');

// Teams
const teamFinanceOps = uuid();
const teamProcurement = uuid();
const teamCompliance = uuid();
db.prepare('INSERT INTO teams (id, name, leader_user_id) VALUES (?, ?, ?)').run(teamFinanceOps, 'Finance Operations', leader1Id);
db.prepare('INSERT INTO teams (id, name, leader_user_id) VALUES (?, ?, ?)').run(teamProcurement, 'Procurement', leader2Id);
db.prepare('INSERT INTO teams (id, name, leader_user_id) VALUES (?, ?, ?)').run(teamCompliance, 'Compliance', leader1Id);

db.prepare('UPDATE users SET team_id = ? WHERE id = ?').run(teamFinanceOps, leader1Id);
db.prepare('UPDATE users SET team_id = ? WHERE id = ?').run(teamProcurement, leader2Id);

// Employees
const employeeNames = [
  ['Kumar S', 'kumar@dailyscrum.local', teamFinanceOps, 'Accountant'],
  ['Priya R', 'priya@dailyscrum.local', teamFinanceOps, 'Accounts Executive'],
  ['Arul V', 'arul@dailyscrum.local', teamFinanceOps, 'Bank Reconciliation Lead'],
  ['Ganesh T', 'ganesh@dailyscrum.local', teamCompliance, 'Compliance Analyst'],
  ['Lakshmi N', 'lakshmi@dailyscrum.local', teamProcurement, 'Procurement Executive'],
  ['Ravi Kumar D', 'ravikumar@dailyscrum.local', teamProcurement, 'Purchase Officer'],
  ['Sundar M', 'sundar@dailyscrum.local', teamProcurement, 'Vendor Coordinator'],
  ['Divya P', 'divya@dailyscrum.local', teamCompliance, 'Audit Assistant'],
];

const employeeIds = employeeNames.map(([full_name, email, team_id, job_title]) => {
  const id = uuid();
  db.prepare(`INSERT INTO users (id, full_name, email, password_hash, role, team_id, job_title) VALUES (?, ?, ?, ?, 'employee', ?, ?)`)
    .run(id, full_name, email, hash(DEFAULT_PASSWORD), team_id, job_title);
  return { id, full_name, team_id };
});

// Historical scrum data for the last 10 working days so dashboards/history show real numbers
const REASONS = ['Finance', 'Procurement', 'Approval', 'Management', 'Vendor', 'Technical', 'Information pending'];
const RECURRING_TITLES = ['Daily bank reconciliation', 'Vendor invoice matching', 'Daily cash position report'];
const ADHOC_TITLES = ['Follow up with Procurement on approved PR', 'Arrange director signature for agreement', 'Respond to auditor query', 'Prepare ad-hoc MIS for management'];

function pick(arr, i) { return arr[i % arr.length]; }

let dayOffset = 20;
const workingDays = [];
while (workingDays.length < 10 && dayOffset >= 1) {
  const d = new Date();
  d.setDate(d.getDate() - dayOffset);
  dayOffset--;
  if (d.getDay() !== 0 && d.getDay() !== 6) workingDays.push(d.toISOString().slice(0, 10));
}

employeeIds.forEach((emp, empIdx) => {
  const recurringId = uuid();
  db.prepare('INSERT INTO recurring_activities (id, employee_id, title, frequency) VALUES (?, ?, ?, ?)')
    .run(recurringId, emp.id, pick(RECURRING_TITLES, empIdx), 'Daily');

  workingDays.forEach((date, dayIdx) => {
    const willComplete = (empIdx + dayIdx) % 4 !== 0; // ~75% completion rate, varies by employee
    const isRecurring = dayIdx % 3 !== 0;
    const cId = uuid();
    const desc = isRecurring ? pick(RECURRING_TITLES, empIdx) : pick(ADHOC_TITLES, empIdx + dayIdx);

    db.prepare(`
      INSERT INTO commitments (id, employee_id, scrum_date, description, type, recurring_activity_id, priority, due_date, status, completed_at, non_completion_reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      cId, emp.id, date, desc, isRecurring ? 'recurring' : 'adhoc', isRecurring ? recurringId : null,
      pick(['High', 'Medium', 'Low'], dayIdx), date, willComplete ? 'completed' : 'support_required',
      willComplete ? date + 'T18:00:00' : null, willComplete ? null : pick(REASONS, dayIdx),
      date + 'T09:30:00'
    );

    db.prepare(`INSERT INTO scrum_sessions (id, employee_id, scrum_date, status, completed_at) VALUES (?, ?, ?, 'completed', ?)`)
      .run(uuid(), emp.id, date, date + 'T09:35:00');
  });
});

// A couple of open actions and one open escalation for realism
db.prepare(`INSERT INTO actions (id, employee_id, scrum_date, description, owner, due_date, priority, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`)
  .run(uuid(), employeeIds[0].id, today(), 'Get Finance sign-off on pending PR #4521', 'Meena Leader', today(), 'High', today() + 'T09:00:00');

db.prepare(`INSERT INTO escalations (id, issue, employee_id, escalated_by, escalated_to, required_action, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`)
  .run(uuid(), 'Vendor payment blocked for 5 days pending approval', employeeIds[5].id, 'Ravi Leader', 'Finance Head', 'Escalate to Finance Head for urgent approval', today() + 'T09:00:00');

console.log('\nSeed complete. Demo login credentials (all use the same password):\n');
console.log(`Password for every account: ${DEFAULT_PASSWORD}\n`);
console.log('Role              Email                              Name');
console.log('----------------- ---------------------------------- --------------------');
console.log(`Super Admin       superadmin@dailyscrum.local        Kirubakar B`);
console.log(`Admin             admin@dailyscrum.local              Arun Admin`);
console.log(`Leader            meena.leader@dailyscrum.local       Meena Leader`);
console.log(`Leader            ravi.leader@dailyscrum.local        Ravi Leader`);
console.log(`Senior Management director@dailyscrum.local           Deepika Director`);
employeeNames.forEach(([name, email]) => console.log(`Employee          ${email.padEnd(35)} ${name}`));
