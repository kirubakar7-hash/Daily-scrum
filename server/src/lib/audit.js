import { db } from '../db.js';
import { v4 as uuid } from 'uuid';

export async function recordAudit({ tableName, recordId, fieldName = null, oldValue = null, newValue = null, changedBy, changedByName, reason = null, ownerId = null, ownerName = null }) {
  await db.prepare(`
    INSERT INTO audit_logs (id, table_name, record_id, field_name, old_value, new_value, changed_by, changed_by_name, reason, owner_id, owner_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuid(),
    tableName,
    recordId,
    fieldName,
    oldValue === null || oldValue === undefined ? null : String(oldValue),
    newValue === null || newValue === undefined ? null : String(newValue),
    changedBy || null,
    changedByName || null,
    reason,
    ownerId,
    ownerName
  );
}

/** Compares old/new objects field by field and logs each changed field. `ownerId`/`ownerName` — whose
 *  task this is — are recorded separately from `changedBy`/`changedByName` so the trail can show a
 *  Leader acting on someone else's task, not just who clicked the button. */
export async function auditDiff({ tableName, recordId, before, after, changedBy, changedByName, reason = null, skip = ['updated_at', 'created_at'], ownerId = null, ownerName = null }) {
  for (const key of Object.keys(after)) {
    if (skip.includes(key)) continue;
    const oldVal = before ? before[key] : undefined;
    const newVal = after[key];
    if (oldVal === newVal) continue;
    if (oldVal === undefined && newVal === undefined) continue;
    await recordAudit({ tableName, recordId, fieldName: key, oldValue: oldVal, newValue: newVal, changedBy, changedByName, reason, ownerId, ownerName });
  }
}
