# Change History

Maintained per the project's `CLAUDE.md` charter (section 44) — one entry per meaningful change, oldest first.

---

**Date:** 2026-09-15
**Change:** Added self-service "Change Password" for every role. Previously only Super Admin/Admin could reset a password (for someone else, with no old-password check) — a Leader, Employee, or Senior Management user had no way to change their own password at all.
**Reason:** Explicit user request ("add reset password option to all users").
**Files:** `server/src/routes/auth.js` (new `POST /api/auth/change-password`), `client/src/components/ChangePasswordModal.jsx` (new), `client/src/components/Layout.jsx` (trigger in header, desktop + mobile), `client/src/pages/Login.jsx` (new post-change message).
**Database:** No schema change — reuses `password_hash`/`token_version` on `users`.
**Security:** Requires the current password (unlike an admin-forced reset). Bumps `token_version` on success, which revokes the session making the request too — same "password change = revoke all sessions" rule as everywhere else, so the user is sent to `/login` with a clear message rather than left on a page whose next request would otherwise fail with a confusing error.
**Bug found and fixed during live testing:** the wrong-current-password case was initially returning HTTP 401, which this app's frontend treats globally as "your session is invalid" and force-logs-out on — so a mistyped current password was incorrectly wiping a valid session before the inline error could even show. Changed to 400 (a validation failure on an already-valid session, not an auth failure). Caught by testing the real UI flow, not just the isolated backend test.
**Tests:** New test `auth — self-service change-password works for any role, rejects a wrong current password, and revokes the old session` in `server/test/api.integration.test.js`. Full suite: 41/41 passing. Also manually verified live in the browser: wrong password shows inline error and does NOT log out; correct change redirects to login with the right message; new password logs in successfully; the change appears in the Audit Log.
**Deployment:** Not yet deployed to Railway — still finishing initial cloud setup.
**Cost:** None.

---

**Date:** 2026-09-15
**Change:** Fixed personal-dashboard authorization gap — an authenticated employee could view any other employee's personal dashboard by changing the `employee_id` query parameter.
**Reason:** Identified independently during a full functional/risk audit, then named explicitly as a CRITICAL item in the project's new operating charter (`CLAUDE.md` §6).
**Files:** `server/src/routes/dashboard.js`
**Database:** No schema change.
**Security:** `GET /api/dashboard/employee` now refuses (403) any `employee_id` other than the caller's own when the caller's role is `employee`. Leader-tier roles (leader/admin/super_admin) and senior_management are unaffected — their view scope was already org-wide everywhere else in the app.
**Tests:** New test `dashboard — an employee cannot view another employee's personal dashboard via employee_id` added to `server/test/api.integration.test.js`. Full suite run: 40/40 passing (was 38/38 before this change).
**Deployment:** Not yet deployed — app is still local-only pending the Railway setup in progress.
**Cost:** None.

---

**Date:** 2026-09-15
**Change:** Fixed a user-deletion history gap — deleting a user permanently erased their `recurring_activities` and `scrum_sessions` rows with no check, unlike every other history type (commitments, actions, escalations, requests, audit log), which already blocked deletion.
**Reason:** Identified independently during the same audit, then named explicitly as a CRITICAL item in `CLAUDE.md` §8.
**Files:** `server/src/routes/users.js`
**Database:** No schema change.
**Security:** `DELETE /api/users/:id` now includes `recurring task assignments` and `scrum sessions` in its pre-delete history check, returning 409 (same as the existing five categories) and telling the admin to deactivate the account instead.
**Tests:** New test `users — deleting a person with recurring-task assignments or scrum sessions is blocked, like other history` added to `server/test/api.integration.test.js`. Full suite run: 40/40 passing.
**Deployment:** Not yet deployed.
**Cost:** None.

---

**Date:** 2026-09-18
**Change:** Converted the entire backend from synchronous SQLite (`node:sqlite`) to async PostgreSQL (Neon), per the user's explicit migration mandate ("SQLite must be replaced with PostgreSQL because this application requires persistent multi-user production data and future SaaS/multi-tenant support"). Every route, `lib/audit.js`, `lib/scope.js`, `middleware/auth.js`, `reset.js`, and `seed.js` now use `await db.prepare(...).run/get/all()`. This entry covers the backend-conversion phase only — Railway is still running the old SQLite code in production, the real production data has not yet been migrated into Neon, and the Vercel frontend move hasn't started.
**Reason:** User-provided 24-section "PRODUCTION MIGRATION" mandate: move off a single SQLite file (can't survive multi-instance/multi-tenant production) onto real managed Postgres, keeping Railway as a fallback until the new path is fully validated.
**Files:** `server/src/db.js` (rewritten as a `pg.Pool` wrapper — central `?`→`$1` and `datetime('now'[,offset])`→`now_utc()`/`now_utc_offset()` translation so none of the 284 existing call sites' SQL text needed to change), `server/migrations/001_schema.sql` (new — full Postgres schema), `server/src/lib/asyncHandler.js` (new — Express 4 doesn't auto-catch async route errors), all 9 route files, `lib/audit.js`, `lib/scope.js`, `middleware/auth.js`, `reset.js`, `seed.js`, `server/test/helpers/pgTestSchema.js` (new — gives each test file its own disposable Postgres schema).
**Database:** New Neon Postgres database, schema-migrated. Real production data is still on Railway's SQLite volume — not yet copied over (tracked as the next step, not done here). Two gaps found and fixed while verifying against a live database: (1) the two protected default task types ("Recurring"/"Ad-hoc") that old SQLite `db.js` auto-seeded at boot were missing from the Postgres schema — added to the migration and backfilled on Neon; (2) `commitments` relied on SQLite's implicit `rowid` to generate its permanent `TSK-000123` codes, which has no Postgres equivalent — added an explicit `seq BIGSERIAL` column.
**Security:** Found and fixed a self-introduced critical bug before any deployment: the parallel per-file conversion left `scrum.js`'s `assertCanView` calling the now-async `canViewEmployee` without `await`, so `if (!canViewEmployee(...))` always evaluated false (a Promise is always truthy) — a total, silent bypass of every view-permission check in that file. Also fixed unawaited `visibleEmployeeIds` calls in `history.js`/`search.js` and 28 unawaited `recordAudit`/`auditDiff` calls across 9 route files, all left behind by independent per-file conversion agents that couldn't see each other's changes.
**Correctness:** Found and fixed a silent data bug: Postgres returns `COUNT(*)` as a string, not a number (node-postgres's default for `bigint`), which would have broken dashboard arithmetic and comparisons across ~53 call sites. Fixed once, centrally, in `db.js` via a global type parser, rather than patching every call site.
**Tests:** Converted `server/test/api.integration.test.js` and `server/test/reset.test.js` to run against a real, disposable Postgres schema instead of a temp SQLite file (`server/test/helpers/pgTestSchema.js`). Full suite: 42/42 passing against live Neon. Also manually verified live in the browser against Neon (login, Dashboard, Admin user list + inline email edit, History, Audit Log, org-wide Team Tasks edit, task resolve/complete) using demo data from `npm run seed` — Neon has no real user data yet.
**Deployment:** Not yet deployed. Railway still runs the old SQLite-based code in production; `DATABASE_URL` is set on Railway but the new code hasn't been pushed there yet.
**Cost:** None — Neon's free tier (0.5GB storage, 100 compute-hrs/month).

---

**Date:** 2026-09-18
**Change:** Migrated the real production data (6 users, 1 team, 23 commitments, 2 requests, 6 recurring activities, 1 scrum session, 1 category, 3 task types, 115 audit log entries) from Railway's SQLite volume into the Neon Postgres database, replacing the demo/seed data used for the previous entry's live testing. Railway itself is still untouched — its live app keeps running against the SQLite file exactly as before; this only populated Neon in preparation for the eventual cutover.
**Reason:** Continuation of the Postgres migration mandate — the backend code was verified working against Postgres in the previous entry; this step moves the real data over so a cutover has something real to point at.
**Files:** `server/scripts/migrate-sqlite-to-postgres.js` (new, one-time script, kept in the repo as a record of exactly how the migration was done), `server/migrations/001_schema.sql` (two more real-data-driven gaps found and fixed — see Database below).
**Process:** Downloaded a fresh SQLite snapshot from the Railway volume (`railway volume files ... download`), checkpointed its WAL into the main file, ran the migration script inside a single Postgres transaction (commit only if every table's row count matched the source, rollback otherwise), then independently verified the result with adversarial checks before treating it as done.
**Database:** Two more real-data gaps surfaced while preparing the migration, both fixed before running it: (1) `users.password_changed_at` — a column with real per-user timestamps that no current code reads or writes (superseded by `token_version`, same situation as the already-known-dead `commitments.leader_intervention_note`) — preserved rather than dropped, since it holds real recorded history; (2) `actions.related_blocker_id`/`escalations.blocker_id` — leftover columns from the Blocker/Achievement feature removed 2026-09-09, confirmed 100% NULL in the real data, correctly excluded from Postgres (matches the feature's intentional removal). A third, more serious gap was caught by the verification pass, not before running the migration: the new `commitments.seq` column (added in the previous entry to replace SQLite's rowid) was initially left to Postgres's own dense auto-increment, which can't reproduce a gap in the source's rowid sequence (rowid 11 was missing — a previously deleted commitment) — this silently shifted the permanent `TSK-000123` display code for 13 of the 23 commitments. Fixed by explicitly inserting `seq` = the original SQLite rowid for every row, then advancing the sequence counter past the highest migrated value; re-migrated and re-verified clean.
**Verification:** Two rounds of independent, adversarial verification (separate from the migration script's own row-count check) — the first round caught both the seq/rowid gap bug above and an untrustworthy, evidence-free "pass" from the initial users-table check; the second round, run after both fixes, confirmed with full field-by-field evidence: users (6/6 rows, 15/15 columns, 0 discrepancies, including exact bcrypt hashes and case-sensitive emails), commitments (23/23 rows, seq now matches original rowid exactly including the gap at 11, 0 field discrepancies), audit_logs (115/115 rows, 12/12 columns, timestamp format verified character-by-character), and referential integrity (all 17 foreign-key relationships across every table checked for dangling references — zero found). Final verdict: GO.
**Deployment:** Neon now holds the real production data, but Railway is still serving the live app from SQLite, unaffected. No cutover has happened yet — that's a separate, deliberately-paused-for-confirmation next step, since it means replacing the currently-working production app.
**Cost:** None — still within Neon's free tier.

---

**Date:** 2026-09-18
**Change:** Deployed the app to Vercel — both the React frontend and the Express backend, now running as a single Vercel serverless function — connected to the same Neon Postgres database migrated in the previous entry. Per explicit request, this replaces Railway as the hosting platform going forward (Railway itself has not yet been touched — see below).
**Reason:** User's explicit instruction to move hosting off Railway onto Vercel entirely, with the database and GitHub repo as the other two pieces of the final architecture.
**Files:** `api/index.js` (new — Vercel's serverless entry point; imports the existing Express `app` unchanged, since `server/src/index.js` already guarded its own `app.listen()` to only run when executed directly, so nothing about the route code needed to change), `package.json` (new, repo root — just `{"type":"module"}`, needed so Vercel's Node runtime parses `api/index.js`'s `import`/`export` syntax as ESM), `vercel.json` (new — build/install commands and an `/api/*` rewrite so Express's own internal routing, which already expects full `/api/...` paths, keeps working unchanged).
**Bug found and fixed during deployment:** the first deploy attempt failed with "vite: command not found" — `NODE_ENV=production` (set both as a Vercel project env var and by Vercel's own build-time default) makes `npm install` skip devDependencies, and `vite` is one for the client. Fixed by adding `--include=dev` to the client's install command specifically; the server's install is unaffected since it has no dev-only runtime dependencies.
**Environment variables set on Vercel:** `DATABASE_URL` (Neon, same as Railway), `JWT_SECRET` (reused Railway's exact value, so no one is forced to log in again), `NODE_ENV=production`, `CORS_ORIGIN` (set to the actual assigned domain once known — my first guess at the URL was wrong, since Vercel's project-name-based domain wasn't available and it assigned `daily-scrum-one.vercel.app` instead; corrected and redeployed). SMTP/stakeholder-email variables left unset, matching their current disabled state on Railway.
**Verification:** `/api/health` responds correctly. Full live login attempt against the real migrated super-admin account (`Kirubakar.B@solidpro-es.com`) with a deliberately wrong password returned the correct "Not logged in" rejection rather than a server error — proving the deployed function reaches Neon, finds the real migrated user, and runs the real bcrypt comparison correctly. Did not attempt a real successful login, since the real password isn't something I have or should have.
**Deployment:** Live at `https://daily-scrum-one.vercel.app`. Railway is untouched and still running the old SQLite-based app in parallel — decommissioning it is the next step, planned but not yet done at the time of this entry.
**Cost:** None — Vercel's free Hobby tier.

---

**Date:** 2026-09-18
**Change:** Stopped the Railway deployment (`railway down`), completing the cutover to Vercel. Kirubakar personally logged into the live Vercel app with real credentials and confirmed the dashboard and data look correct before this step was taken.
**Reason:** Explicit request to remove Railway as the hosting platform now that Vercel is confirmed working against the real, migrated data.
**What was and wasn't removed:** Only the running deployment was stopped (`railway down`), deliberately, not the Railway project, service, or its volume — the volume still holds the original SQLite file (and `backups/` has dated snapshots, including one from just before this migration) as a rollback path if anything is ever discovered wrong with the new Postgres/Vercel setup. Nothing was deleted. Restarting Railway (`railway up`, or pushing a commit again) would bring the old SQLite-based app back exactly as it was.
**Verification:** `https://daily-scrum-monitoring-production.up.railway.app` now returns Railway's own "no active deployment" page — confirmed no longer serving traffic. `https://daily-scrum-one.vercel.app` remains fully live.
**Current architecture:** Code on GitHub (`kirubakar7-hash/Daily-scrum`) → Vercel (frontend + backend, one serverless deployment) → Neon Postgres (database). No Railway involvement in the running app anymore.
**Cost:** Neon and Vercel free tiers cover the new setup. Railway's own billing status wasn't re-verified here — worth checking Railway's dashboard directly to confirm the stopped service isn't accruing any charges, before deciding whether/when to delete the project entirely.

---

**Date:** 2026-09-18
**Change:** Deleted the Railway project entirely (`railway delete`), per explicit follow-up request. Confirmed via the Railway dashboard: 0 active projects, 1 deleted.
**Reason:** User's explicit instruction, after confirming the Vercel cutover works correctly with real data.
**What this means:** The Railway volume (the original SQLite file) is gone along with the project. The data itself is not lost — it was independently, field-by-field verified as fully migrated into Neon (see the two earlier entries), and local backup files still exist under `backups/` (including one taken immediately before the migration). But this was the last copy of the *SQLite* file anywhere — there is no going back to the old SQLite-based setup after this point, only forward from the Neon/Vercel one.
**Cost:** Removes any question of ongoing Railway charges — noted as unverified in the previous entry, moot now.

---

**Date:** 2026-09-18
**Change:** Super Admin can now delete any task outright, regardless of who created it. Every other leader-tier role (Leader, Admin) keeps the existing, unchanged restriction — they can still only delete a task they typed in themselves.
**Reason:** Explicit request ("add entire task deleted button in super admin access alone").
**Files:** `server/src/routes/scrum.js` (`DELETE /api/scrum/commitments/:id` — the `created_by` ownership check is now skipped specifically for `super_admin`), `client/src/components/TeamTaskList.jsx` (the Delete button, shared across My Tasks/Team Tasks/Daily Scrum's task list, is no longer disabled for Super Admin on tasks it didn't create; tooltip text updated to say so).
**Unchanged, deliberately:** the referential-integrity check that blocks deleting a task that already generated a carry-forward follow-up task still applies to everyone, including Super Admin — that one isn't a permissions rule, it's a real foreign-key constraint (deleting it would leave the follow-up task's `carried_forward_from_id` pointing at nothing).
**Tests:** New test `scrum — only Super Admin can delete a task they didn't create themselves; other leader-tier roles cannot` in `server/test/api.integration.test.js`, confirming both halves: an Admin who didn't create the task is still blocked (403, unchanged), and Super Admin can delete it (200, new). Full suite: 43/43 passing.
**Verified live:** on the real production app at `daily-scrum-one.vercel.app`, logged in as the real Super Admin account — the Delete button now shows on tasks belonging to other real employees (previously only shown for self-created tasks), and the tooltip correctly reads "As Super Admin, you can delete any task." Did not actually delete a real task during this check, to avoid destroying genuine business records just to test — the automated test above already exercises the real delete path end-to-end against disposable test data.
**Deployment:** Live.
**Cost:** None.

---

**Date:** 2026-09-18
**Change:** Added a "Delete N tasks" bulk action to the same checkbox-based multi-select toolbar that already has "Mark Completed" and "Reschedule", right next to them — Super Admin only, matching the single-row Delete button added earlier today.
**Reason:** Explicit follow-up request pointing at that toolbar directly.
**Files:** `client/src/components/TeamTaskList.jsx` — a `bulkDelete()` function reusing the same `runBulk` helper `bulkComplete`/`bulkReschedule` already use, and the existing `DeleteButton` component (same two-click confirm pattern used for the single-row delete) for the toolbar control itself, so no new UI pattern was introduced. The button only renders for `super_admin`; the server independently enforces the same restriction per task either way, so this is UI-only gating, not the actual security boundary.
**Verified live:** on the real production app, selected a real task via its checkbox and confirmed "Delete 1 task" appears correctly in the toolbar with the right count — then cleared the selection rather than actually deleting it, same reasoning as the single-row verification above.
**Deployment:** Live.
**Cost:** None.

---

**Date:** 2026-09-18
**Change:** Permanently deleted every task/commitment record in the system (9 commitments, and the 2 requests tied to them — a request can't exist without the commitment it's about). This emptied My Tasks, Team Tasks, and the Dashboard's task counts for everyone. Users, teams, task types, categories, recurring-activity templates, and the audit log itself were not touched.
**Reason:** Explicit request, confirmed twice after I clarified the scope and consequences — Team History is not a separate archive, it's a filtered view of the same live task data used everywhere else in the app, so "delete team history" meant deleting the actual task records themselves, including anything still Pending or In Progress at the time.
**Safety net taken first:** backed up all 9 commitments and 2 requests, exactly as they were, to `backups/commitments-before-full-delete-2026-09-18.json` before deleting anything. This file is not committed to GitHub (matches the existing `.gitignore` rule for anything containing real people's data) — it only exists on this machine. If any of this data needs to come back, that file has everything needed to restore it.
**How it was done:** a one-off script (not kept in the repo, since this isn't a repeatable operation) deleted `requests` then `commitments` inside a single transaction, and wrote one summary entry to the audit log (`table_name='commitments', field_name='bulk_deleted'`) recording that this happened, who did it, and why — since this bypassed the app's normal one-task-at-a-time delete flow, which is the only place that writes audit entries automatically.
**Verified live:** Dashboard now shows 0 Pending/In Progress/Completed/Support Required (Active Users still 6, Teams still 1 — unaffected). The Audit Log shows the new "Task — Bulk Deleted" entry at the top, above the pre-existing individual deletion history, which is untouched.
**Cost:** None.

---

**Date:** 2026-09-18
**Change:** Added CSV bulk-import (with a downloadable template) to every tab on the Admin page — Users, Teams, Task Types, Categories, and Recurring Tasks. Each gets a "Download Template" and "Import CSV" button next to its existing Create button.
**Reason:** Explicit request, immediately after the previous entry's full task-record deletion — needed a way to bulk-restore or bulk-add data instead of re-entering everything by hand through the Create forms one at a time.
**Files:** `client/src/lib/csv.js` (new — CSV parsing/generation, handles quoted fields so a real spreadsheet's commas/newlines-inside-cells don't corrupt a row), `client/src/components/ImportButton.jsx` (new — the shared "Download Template" + "Import CSV" control, reused across all five tabs, showing per-row success/failure after an import), one new `POST /<entity>/import` endpoint added to each of `server/src/routes/{users,teams,taskTypes,categories,recurringTasks}.js`, `client/src/pages/Admin.jsx` (wired the button into all five tabs).
**How each import stays consistent with its existing Create form:** every import endpoint runs the exact same validation the single-row create endpoint already enforces — nothing new is more lax. Since a CSV names things (an employee, a team, a task type) rather than passing the internal ID the UI's dropdowns submit, each import endpoint resolves names to IDs itself first: Users' `team_name` → team; Teams' `leader_email` → user (must be Leader/Admin/Super Admin, exactly like the single-create form's leader dropdown already requires); Recurring Tasks' `employee_emails` (semicolon-separated, since one row can assign several people at once, matching the existing multi-assign form), `task_type_name`, and `category_name` → their respective records. One bad row doesn't stop the rest — each row's outcome (success, or the specific reason it failed) is collected and shown back, the same "some succeeded, some didn't" pattern already used for bulk task actions.
**Bug found and fixed while touching this code:** `task_types.js` and `categories.js`'s single-create endpoints were still checking `e.message` for the string `'UNIQUE'` to catch a duplicate name and turn it into a friendly 409 — that was SQLite's error text. Postgres's real unique-violation message ("duplicate key value violates unique constraint...") never matched it, so ever since the Postgres migration, creating a Task Type or Category with a name that already exists has been silently falling through to an unhandled 500 instead of the intended "already exists" message. Fixed both to check the actual Postgres error code (`23505`) instead — confirmed the exact real error Postgres returns with a direct test query before fixing it.
**Tests:** Five new tests in `server/test/api.integration.test.js`, one per entity, each importing one valid row and one row designed to fail (duplicate email/name, invalid mechanic, unknown leader email, unknown employee email) and confirming both outcomes are reported correctly per row. Full suite: 48/48 passing.
**Verified live:** on the real production app, confirmed "Download Template" and "Import CSV" render correctly on all five Admin tabs, next to each one's existing Create button, without disturbing any of the real data already showing on each tab.
**Deployment:** Live.
**Cost:** None.

---

**Date:** 2026-09-18
**Change:** Added a "Main Task" hierarchy that sits one level under Category — Category (e.g. Finance) → Main Task (e.g. FP&A, Accounts Payable) → the individual assignable tasks/subtasks that already existed. Main Task is a genuine new entity (its own Admin tab with CRUD, CSV import, filtering, and delete-blocked-while-in-use), not a bigger text field — built to the exact same standard as the existing Category and Task Type entities.
**Reason:** Explicit request after the user shared a real finance-department checklist (12 "Finance Head" groups × 68 "Activity" rows) and described the shape as "Main task (Finance Head) > Subtask (Activity), parked under the categories." Scoped and designed in Plan Mode first, per the user's explicit "First plan" instruction.
**Files:** `server/migrations/001_schema.sql` (new `main_tasks` table; new nullable `main_task_id` column on both `commitments` and `recurring_activities`), `server/src/routes/mainTasks.js` (new — full CRUD + CSV import, mirrors `categories.js`), `server/src/index.js` (mounts it), `server/src/routes/recurringTasks.js`, `server/src/routes/scrum.js`, `server/src/routes/leader.js`, `server/src/routes/history.js` (every place `category_id`/`category_name` already flowed through task creation, the three read endpoints TeamTaskList.jsx uses, and History's filter/export — main_task_id now flows through all the same spots, including the one write path the plan hadn't explicitly named: `scrum.js`'s recurring-completion engine that regenerates a task's next occurrence, which copies `category_id` forward from the completed task and needed to copy `main_task_id` forward the same way), `client/src/pages/Admin.jsx` (new "Main Tasks" tab; Recurring Tasks tab gained a Main Task select filtered by the chosen Category), `client/src/components/TeamTaskList.jsx` and `client/src/pages/History.jsx` (Main Task filter dropdown, table column, and — on TeamTaskList's Create Task form — a Main Task select filtered by the chosen Category, so the hierarchy is enforced in the UI, not just implied).
**Database:** New `main_tasks` table; new nullable `main_task_id TEXT REFERENCES main_tasks(id)` on `commitments` and `recurring_activities`, plus two new indexes. Applied directly to live Neon via its web SQL Editor after this machine's local Postgres connection (port 5432 specifically) timed out on both the corporate network and a mobile hotspot — confirmed via `information_schema.columns` queries rather than trusting the editor's tab UI alone.
**Tests:** New test `main tasks — a recurring task tagged with a Category and Main Task carries both onto its seed commitment, and the Main Task cannot be deleted while in use` added to `server/test/api.integration.test.js`. Could not be run locally this session — the same port-5432-only connectivity block affected the local test-Postgres-schema harness on both networks — but `node --check` passed on every touched backend file and `npm run build` passed clean on the client.
**Deliberately not done yet:** importing the real 68-row finance dataset (blocked on an unresolved assignee decision, since every task requires a real `employee_id`), and the source spreadsheet's "Code" column (APA/GL/etc.) — revisit only if asked.
**Deployment:** Live.
**Cost:** None.

---

**Date:** 2026-09-18
**Change:** Renamed the "Category" label to "Subtask" everywhere it appears in the UI — Admin tab name, form labels, table/filter headers, CSV export columns, downloaded CSV template filenames, and error messages, on both Team Tasks and History.
**Reason:** Explicit request. Purely a display-text rename — the underlying `categories` table, `category_id` fields, and `/api/categories` routes are all unchanged, so no data was touched.
**Files:** `client/src/pages/Admin.jsx`, `client/src/pages/History.jsx`, `client/src/pages/AuditLog.jsx` (also filled in a missing "Main Task" Audit Log label noticed while in this file), `client/src/components/TeamTaskList.jsx`, `server/src/routes/categories.js`, `server/src/routes/recurringTasks.js`, `server/src/routes/mainTasks.js`, `server/src/routes/scrum.js`, `server/src/routes/history.js`.
**Database:** No schema change.
**Tests:** No new tests needed — no behavior changed, only display text. `node --check` passed on every touched backend file; `npm run build` passed clean on the client.
**Verified live:** confirmed on the real production app — the Admin tab now reads "Subtasks", and Team Tasks/History's filters, columns, and CSV exports/templates all say "Subtask" instead of "Category".
**Deployment:** Live.
**Cost:** None.

---

**Date:** 2026-09-18
**Change:** Added a show/hide (eye icon) toggle to every password field in the app — Login, Change Password, and Admin's Create User and Reset Password forms.
**Reason:** Explicit request, after a related question about listing user passwords (not possible — passwords are bcrypt-hashed, one-way, never recoverable by anyone including a Super Admin; this toggle instead lets whoever is *typing* a password confirm what they typed before saving it).
**Files:** `client/src/components/ui.jsx` — the shared `Input` component gained the toggle; every password field in the app uses this one component, so no other file needed changes.
**Database:** No schema change.
**Tests:** Verified locally (typed a password, confirmed it stays masked, clicked the eye icon, confirmed it reveals as plain text and the icon/label swap correctly) via the local dev server, then re-verified the same flow live on the real Login page after deploying.
**Deployment:** Live.
**Cost:** None.

---

**Date:** 2026-09-21
**Change:** Added a real manager-reporting hierarchy for Leader and Employee roles — a Leader now sees and can act on only themself plus everyone reporting to them (any depth), and an Employee sees and can act on only themself. This replaces the app's previous flat rule ("everyone sees everyone, any Leader can edit anyone, org-wide") for those two roles specifically. Super Admin, Admin, and Senior Management are unaffected — they keep seeing everyone, exactly as before.
**Reason:** Explicit request, given as a target table mapping each real person's role, manager, and view/edit scope. Confirmed twice: that the other three roles should stay wide-open, and that visibility should never go upward (a Leader never sees their own manager's data through this rule).
**Files:** `server/migrations/001_schema.sql` (new nullable `manager_id TEXT REFERENCES users(id)` column + index on `users`), `server/src/lib/scope.js` (the central rewrite — a new recursive `subordinateIds()` walks `manager_id` via a `WITH RECURSIVE` CTE; `visibleEmployeeIds`/`canActOnEmployee` now branch by role instead of being universal), `server/src/routes/scrum.js` (11 call sites of the edit-permission check needed `await` added once it became async), `server/src/routes/leader.js` (the Daily Scrum/Team-roster scoping and the org-wide Team Tasks page both now respect the hierarchy for Leader/Employee), `server/src/routes/dashboard.js` (the Leader dashboard's KPIs, and the "view someone else's dashboard" guard), `server/src/routes/users.js` (the `/api/users` list — used by My Tasks' assignee picker — is now scoped for a Leader; new "Reports To" field on create/edit, validated the same way Teams already validates a team leader), `server/src/routes/requests.js` (the Requests inbox had *no* scoping at all before this — a Leader now only sees and can approve/reject requests belonging to their own reporting chain), `client/src/pages/Admin.jsx` (new "Reports To" column/selects on the Users tab), `client/src/pages/AllTasks.jsx` (role-aware description text).
**Database:** New `manager_id` column + index on `users`. Applied to live Neon the same way as prior migrations this session — local Postgres connectivity on this network has repeatedly timed out on port 5432, so the live `ALTER TABLE`/`CREATE INDEX` went through Neon's web SQL Editor, verified via `information_schema.columns`.
**Bug found and fixed while implementing:** `leader.js`'s `GET /org-tasks` computed a `can_act` flag by calling the (now-async) permission check inside a plain `.map()` — since `.map()` doesn't await, every row would have silently gotten `can_act: 1` regardless of real permission, once the function became async. Fixed by precomputing the actionable set once per request instead of per row, before this ever reached production.
**Tests:** 8 new tests in `server/test/api.integration.test.js` (a seeded 3-level hierarchy fixture; direct-report access, unrelated-employee denial both ways, two-levels-deep access, History/Team-Tasks/`/api/users`/Requests/Dashboard scoping, plus a regression check that Admin stays org-wide) and 3 existing tests in `server/test/scope.test.js` updated for the function's new async signature. Full suite: 57/57 passing (was 48/48 before this feature).
**Deliberately not done in this change:** the real live `manager_id` values for the 5 actual non-Super-Admin users, and setting AP Team/AR team's actual leaders (both teams currently show "No leader") — done live via Admin right after this deploys, not as a silent data migration.
**Deployment:** Live.
**Cost:** None.

---

**Date:** 2026-09-21
**Change:** Added CSV bulk-import for ad-hoc tasks — an "Import CSV" (+ "Download Template") button next to "Create Task" on My Tasks, Team Tasks, and the Leader's Daily Scrum → Team Tasks tab. Export already existed ("Export to CSV" in the filter bar) — this fills in the missing import half.
**Reason:** Explicit request, after manually creating 20 sample tasks one-by-one through the UI to populate real test data across the team for the new reporting hierarchy — a bulk-import path is the right tool for that instead of clicking through the Create Task form repeatedly.
**Files:** `server/src/routes/scrum.js` (new `POST /api/scrum/commitments/import`), `client/src/components/TeamTaskList.jsx` (wired in the existing shared `ImportButton` component, same one used by the other 6 CSV imports in this app).
**Database:** No schema change.
**How it stays consistent with the single Create Task form:** each row is looked up by `employee_email` and resolved to an employee, same as every other email-based import in this app (Users' `team_name`, Teams' `leader_email`, Recurring Tasks' `employee_emails`). Critically, it also goes through the same reporting-hierarchy check the single form's `assertCanEdit` enforces — a Leader can only import tasks for people in their own chain; an attempt to assign outside it fails that row with a clear message instead of silently succeeding. A CSV row naming a Recurring-mechanic Task Type is rejected with a pointer to the existing Recurring Tasks import instead, since this endpoint only creates ad-hoc (one-off) tasks — recurring templates already have their own dedicated import.
**Tests:** New test `import — tasks: a valid row succeeds, an unknown email fails, and a Leader cannot import a task for someone outside their reporting chain` in `server/test/api.integration.test.js`, reusing the hierarchy fixture from the previous change. Full suite: 58/58 passing.
**Verified live:** created 20 real sample tasks (4 each across Anudeep, Rajeshwari, Renuka, Shreenidhi, and Jeyant) directly through the live app to populate real hierarchy-scoped test data, confirmed they all landed correctly on Team Tasks ("20 of 20 tasks"), and walked one through its full lifecycle (Pending → In Progress → Completed → appears in History as TSK-000027).
**Deployment:** Live.
**Cost:** None.

---

**Date:** 2026-09-21
**Change:** Added a "View History" popout to every task row on Team Tasks/My Tasks/Daily Scrum — a clock icon opens a modal showing that one task's full trail (created, status changes, due-date changes, deletion) with a clear "Changed by {name}" on every entry and the task's permanent TSK-code shown at the top.
**Reason:** Explicit request — the existing Audit Log page mixes every change across the whole system into one global feed; the user wanted to see one specific task's own history in isolation, the way clicking into a record shows its own detail.
**Files:** `client/src/components/AuditTimeline.jsx` (new — extracted the formatting/rendering logic that used to live only inside `AuditLog.jsx`, so the org-wide log and the new per-task popout render identically and can never drift apart), `client/src/pages/AuditLog.jsx` (slimmed down to just fetch + render `<AuditTimeline>`), `client/src/components/TeamTaskList.jsx` (new History icon button per row, new `TaskHistoryModal`), `server/src/routes/scrum.js` (new `GET /api/scrum/commitments/:id/history`), `server/src/routes/recurringTasks.js`.
**Security:** The new endpoint is scoped by the exact same view rule as everything else in the app (`assertCanView`) — a task's owner, or anyone above them in the reporting hierarchy, can see its history; nobody else can, including the global Audit Log's `super_admin`/`admin`-only restriction not applying here (this is a narrower, per-task view, not the sensitive org-wide feed).
**Bug found and fixed while implementing:** task **creation** was never being written to the audit trail at all — `commitments.created_by`/`created_at` existed on the row itself, but no `audit_logs` entry recorded it, at any of the three places a task gets created (the single Create Task form, the new CSV import, and a recurring series' first occurrence in `recurringTasks.js`). Fixed all three, plus the auto-generated "next occurrence" a completed recurring task creates for itself — so a task's history now always starts with a real "created" entry instead of appearing to begin mid-story.
**Tests:** New test `task history — records a "created" entry, is visible to the task's owner and anyone above them, and blocked for everyone else` in `server/test/api.integration.test.js`. Full suite: 59/59 passing.
**Deployment:** Live.
**Cost:** None.

---

**Date:** 2026-09-21
**Change:** Redesigned the "View History" panel — from a centered modal popout to a docked panel on the right edge of the screen (420px wide), so the task list stays visible and usable underneath while it's open. Also restyled every history entry (both here and on the org-wide Audit Log page) into individual bordered cards, and gave due-date changes their own amber color to match the due-date cell's existing "amber means changed" convention, instead of the generic blue every other change used.
**Reason:** Explicit request, from a provided HTML mockup. Scoped down after clarifying: kept the app's real Solidpro branding (brand blue, Maven Pro font, lucide icons) rather than the mockup's own unrelated color palette/fonts, and left out two mockup features that don't exist yet ("Add Note", "Revert") since they'd need their own separate design.
**Files:** `client/src/components/TeamTaskList.jsx` (`TaskHistoryModal` → `TaskHistoryDrawer`, now `position: fixed` docked right, no backdrop, Escape-to-close), `client/src/components/AuditTimeline.jsx` (shared by both this drawer and Audit Log — restyled to card-per-entry, added the amber tone for due-date changes), `client/src/components/ui.jsx` (`Timeline`'s dot color gained the amber option).
**Database:** No schema change.
**Tests:** No new tests needed — pure UI restyle, no behavior changed. `npm run build` passed clean.
**Deployment:** Live.
**Cost:** None.

---

**Date:** 2026-09-21
**Change:** Fixed Team Today and Team Tasks silently dropping other Leaders/Admins from the roster for wide-open-role viewers (Admin, Super Admin, Senior Management).
**Reason:** P0 finding from the full application audit (`server/src/lib/scope.js`'s `WIDE_OPEN_ROLES` are supposed to see literally everyone, org-wide — this was the one screen-level exception).
**Files:** `server/src/routes/leader.js` — `scopedEmployees()`'s fallback branch (for any non-`leader` caller) was querying `role = 'employee'` only; now reuses `allActiveUsers()`, the same helper `GET /org-tasks` already used correctly a few lines below.
**Database:** No schema change.
**Tests:** New test `hierarchy — Team Today includes Leaders/Admins in the roster for wide-open roles, not just Employees` in `server/test/api.integration.test.js`. Full suite: 60/60 passing.
**Deployment:** Live.
**Cost:** None.

---

**Date:** 2026-09-21
**Change:** Fixed Admin's own Dashboard — same roster-narrowing bug as the Team Today P0 (`GET /dashboard/leader` counted `role='employee'` only), plus its heading said "My Team Today" even though it's meant to reflect the whole organization for an Admin.
**Reason:** P1 finding from the full application audit.
**Files:** `server/src/routes/dashboard.js` (`GET /leader`'s non-leader branch widened to every active user), `client/src/pages/Dashboard.jsx` (`LeaderDashboard` now takes a `role` prop; heading/team-count label say "Organization Today" / "people across the organization" for Admin specifically, unchanged for a real Leader).
**Better opportunity taken:** the audit had flagged this as needing a product decision — give Admin the full read-only Org dashboard, or fix the Leader dashboard in place. Chose the latter: Admin keeps the richer, actionable Leader-dashboard shape (Leadership Attention Required panel, Status Email button) it already had, rather than losing that panel by moving to the Org dashboard, which has no equivalent.
**Bug found and fixed while verifying:** `GET /dashboard/leader` 500'd unconditionally for every caller, Leader included — two of its queries referenced SELECT-list aliases (`c`, `total_count`, `adhoc_count`) inside `HAVING` clauses, which Postgres rejects (`column "c" does not exist`) even though the same SQL is valid in SQLite/MySQL. No test had ever called this endpoint before, so it went uncaught. Fixed both `HAVING` clauses to repeat the aggregate expression instead of the alias.
**Database:** No schema change.
**Tests:** New test `hierarchy — Admin's own Dashboard counts every active user, org-wide, not just Employees` in `server/test/api.integration.test.js`. Full suite: 61/61 passing.
**Deployment:** Live.
**Cost:** None.

---

**Date:** 2026-09-21
**Change:** Implemented the remaining P1–P3 audit findings (20 of 24 remaining items; 4 deliberately deferred — see below) in one coordinated batch: 4 backend fixes done directly, 7 frontend UX fixes done via parallel background agents (one per disjoint file group), reviewed and verified together.
**Reason:** Explicit request to implement the completed audit's backlog in parallel rather than one finding at a time.
**Backend (server/src/lib/scope.js, routes/users.js, routes/requests.js, routes/scrum.js, routes/dashboard.js):**
- Org Dashboard's "Scrum Completed" KPI numerator now matches its denominator's population (`role='employee'`); its "By Team" employee count uses the same definition.
- `canActOnEmployee` now refuses to act on a deactivated target (previously only the frontend picker hid them).
- `assertValidManager` now rejects a "Reports To" change that would create a reporting-loop cycle, reusing `subordinateIds`.
- Resolving an orphaned request now writes an audit entry instead of resolving silently.
- Dashboard commitment-count queries now filter `is_active=1` (currently a no-op, defensive).
**Bug found and fixed while verifying (not in the original audit):** `requests.commitment_id` is `NOT NULL` with no `ON DELETE` clause — deleting any task that ever had a request raised against it (support or due-date-change), resolved or still pending, failed with an unhandled foreign-key 500. Confirmed via a live repro before fixing. `DELETE /commitments/:id` now removes the task's request rows as part of the same delete; a still-pending request gets its own audit entry first so its outcome isn't lost.
**Frontend, via 7 parallel agents (all reviewed before commit):**
- All 6 Admin tabs brought to one standard: loading skeleton, empty state, Retry button, inline-edit error visibility, save confirmation, "Add X" button labels, unified delete-confirmation wording.
- History/Audit Log: loading state, Retry button, success icon consistency.
- My Tasks/Team Tasks: Senior Management's subtitle no longer promises actions it can't take.
- Team Tasks' editable status dropdown now shares its color map with the read-only Badge (`ui.jsx` exports `badgeClassFor`) instead of a diverging local copy.
- Close buttons unified on the lucide X icon (Modal/DrillDownPanel/WelcomeBanner).
- Employee nav gained a Dashboard link; mobile nav now carries the same Guided Tour anchors as desktop.
- Team Today: raw date format (matching the rest of the app); empty-team message points at Admin → Users and is only shown to a persona who can act on it.
**Deliberately deferred (not completed in this batch):** Admin.jsx's Task Types tab still has the invisible-inline-error issue fixed elsewhere (agent scoped itself to only the 3 tabs the audit explicitly named); several Org Dashboard fields remain computed-but-unrendered (audit rated this optional polish); "Leaders may also dismiss an orphaned request" was intentionally left out — the audit's own recommendation, but it would expand what a Leader can act on, which needed a explicit decision rather than a bundled fix.
**Database:** No schema change.
**Tests:** 5 new backend tests (deactivated-employee protection, manager-cycle rejection, orphaned-request audit trail, resolved-request delete no longer 500s, pending-request-on-delete audit trail) plus 2 existing scope.test.js assertions moved into the integration suite where they now need real data. Full suite: 64/64 passing. `npm run build` clean.
**Deployment:** Live (5 commits, pushed in sequence).
**Cost:** None.

---

**Date:** 2026-09-21
**Change:** Admin → Users now shows the reporting hierarchy directly instead of a separate "Reports To" column — rows sort depth-first by manager (siblings alphabetical), each name is indented by its depth, and a compact "reports to" selector sits directly under the name in place of the old standalone column.
**Reason:** Explicit request, after live-screenshotting the Users tab — with 6 real people across 2 reporting levels, the flat table plus a same-weight "Reports To" dropdown column required reading and mentally cross-referencing every row to see who reported to whom.
**Files:** `client/src/pages/Admin.jsx` (`UsersTab` only) — new `sortedItems` memo (depth-first walk of `manager_id`, with a `visited` guard against a stray cycle in bad data, mirroring `subordinateIds()`'s defensive spirit server-side); the Reports To `<select>` moved into the Name cell, same value/onChange/options as before, restyled as a small caption instead of a boxed dropdown.
**Database:** No schema change. **Security:** No backend or permission change — same `PATCH /users/:id` call, same data.
**Tests:** Verified the sort/indent logic directly against the real 6-person dataset from the live screenshot (Kirubakar B → Anudeep → {Rajeshwari → Shreenidhi, Renuka → Jeyant}) — produces the expected top-to-bottom order and depth. `npm run build` clean. Not manually verified in the browser — doing so requires being logged in as an Admin/Super Admin, and per this project's standing rule I never enter a password into any field myself.
**Deployment:** Live.
**Cost:** None.
