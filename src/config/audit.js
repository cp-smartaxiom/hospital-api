/*
 * Audit log for administrative actions, stored in the hospital's own database.
 * `db` is the hospital pool or a transaction client on it, so the entry commits/rolls back with the
 * change. Never put passwords, tokens or session data in `metadata`.
 */
const recordAudit = (db, { actorUserId, action, entityType, entityId, metadata = {} }) =>
  db.query(
    `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [actorUserId ?? null, action, entityType, entityId ?? null, JSON.stringify(metadata)]
  );

module.exports = { recordAudit };
