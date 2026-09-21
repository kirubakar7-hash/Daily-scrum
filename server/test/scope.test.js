import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canActOnEmployee, isReadOnly } from '../src/lib/scope.js';

// canActOnEmployee only touches the database for the 'leader' branch (subordinateIds' recursive query)
// — every other branch (self, admin/super_admin, employee/senior_management) short-circuits before that,
// so those stay safe to test here without a DB. A Leader's actual reporting-chain behavior is exercised
// via the "hierarchy —" tests in api.integration.test.js instead, against a real disposable schema.
// isReadOnly is pure (no DB) throughout.

test('canActOnEmployee — anyone can always act on their own record', async () => {
  for (const role of ['employee', 'leader', 'admin', 'super_admin', 'senior_management']) {
    assert.equal(await canActOnEmployee({ id: 'u1', role }, 'u1'), true, `role=${role}`);
  }
});

test('canActOnEmployee — Admin and Super Admin can act on anyone, org-wide', async () => {
  for (const role of ['admin', 'super_admin']) {
    assert.equal(await canActOnEmployee({ id: 'admin1', role }, 'someone-else'), true, `role=${role}`);
  }
});

test('canActOnEmployee — employee and senior_management cannot act on someone else', async () => {
  assert.equal(await canActOnEmployee({ id: 'u1', role: 'employee' }, 'u2'), false);
  assert.equal(await canActOnEmployee({ id: 'u1', role: 'senior_management' }, 'u2'), false);
});

test('isReadOnly — true only for senior_management, including its own record', () => {
  assert.equal(isReadOnly({ role: 'senior_management' }), true);
  for (const role of ['employee', 'leader', 'admin', 'super_admin']) {
    assert.equal(isReadOnly({ role }), false, `role=${role}`);
  }
});
