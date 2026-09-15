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
