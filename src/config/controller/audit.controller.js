const pool = require("../tenant-pool"); // the logged-in hospital's own database

/*
 * GET /audit-logs?entityType=&entityId=&page=&pageSize=   (Superadmin only)
 * Reads the audit log of the caller's hospital database only.
 */

const MAX_PAGE_SIZE = 100;

const listAuditLogs = async (req, res) => {
  const entityType = typeof req.query.entityType === "string" ? req.query.entityType.trim() : "";
  const entityId = typeof req.query.entityId === "string" ? req.query.entityId.trim() : "";
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 20));

  const params = [];
  const where = ["TRUE"];
  if (entityType) {
    params.push(entityType);
    where.push(`l.entity_type = $${params.length}`);
  }
  if (entityId) {
    params.push(entityId);
    where.push(`l.entity_id = $${params.length}`);
  }
  const whereSql = where.join(" AND ");

  try {
    const total = await pool.query(`SELECT COUNT(*)::int AS n FROM audit_logs l WHERE ${whereSql}`, params);
    const rows = await pool.query(
      `SELECT l.id, l.action, l.entity_type, l.entity_id, l.metadata, l.created_at,
              u.id AS actor_id, u.full_name AS actor_name
       FROM audit_logs l
       LEFT JOIN users u ON u.id = l.actor_user_id
       WHERE ${whereSql}
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    res.json({
      success: true,
      data: {
        items: rows.rows.map((r) => ({
          id: Number(r.id),
          action: r.action,
          entityType: r.entity_type,
          entityId: r.entity_id,
          metadata: r.metadata,
          actor: r.actor_id ? { id: r.actor_id, fullName: r.actor_name } : null,
          createdAt: r.created_at,
        })),
        total: total.rows[0].n,
        page,
        pageSize,
      },
    });
  } catch (error) {
    console.error("List audit logs failed:", error.message);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

module.exports = { listAuditLogs };
