import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canActOnEmployee, isReadOnly } from '../src/lib/scope.js';

// Only the self-record branch stays DB-free (it short-circuits before any query). Every other branch now
// looks up the target's is_active status first, so "Admin can act on anyone" / "Employee cannot act on
// someone else" need a real row to check against — those live in api.integration.test.js instead, against
// a real disposable schema. isReadOnly is pure (no DB) throughout.

test('canActOnEmployee — anyone can always act on their own record', async () => {
  for (const role of ['employee', 'leader', 'admin', 'super_admin', 'senior_management']) {
    assert.equal(await canActOnEmployee({ id: 'u1', role }, 'u1'), true, `role=${role}`);
  }
});

test('isReadOnly — true only for senior_management, including its own record', () => {
  assert.equal(isReadOnly({ role: 'senior_management' }), true);
  for (const role of ['employee', 'leader', 'admin', 'super_admin']) {
    assert.equal(isReadOnly({ role }), false, `role=${role}`);
  }
});
