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
