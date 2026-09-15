import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canActOnEmployee, isReadOnly } from '../src/lib/scope.js';

// canActOnEmployee/isReadOnly are pure (no DB) — visibleEmployeeIds/canViewEmployee do touch the
// database and are instead exercised indirectly via the integration tests (api.integration.test.js),
// through the actual view-scope behavior of the /history and /leader/org-tasks endpoints.

test('canActOnEmployee — anyone can always act on their own record', () => {
  for (const role of ['employee', 'leader', 'admin', 'super_admin', 'senior_management']) {
    assert.equal(canActOnEmployee({ id: 'u1', role }, 'u1'), true, `role=${role}`);
  }
});

test('canActOnEmployee — leader-tier roles can act on anyone, org-wide', () => {
  for (const role of ['leader', 'admin', 'super_admin']) {
    assert.equal(canActOnEmployee({ id: 'leader1', role }, 'someone-else'), true, `role=${role}`);
  }
});

test('canActOnEmployee — employee and senior_management cannot act on someone else', () => {
  assert.equal(canActOnEmployee({ id: 'u1', role: 'employee' }, 'u2'), false);
  assert.equal(canActOnEmployee({ id: 'u1', role: 'senior_management' }, 'u2'), false);
});

test('isReadOnly — true only for senior_management, including its own record', () => {
  assert.equal(isReadOnly({ role: 'senior_management' }), true);
  for (const role of ['employee', 'leader', 'admin', 'super_admin']) {
    assert.equal(isReadOnly({ role }), false, `role=${role}`);
  }
});
