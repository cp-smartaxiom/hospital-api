const crypto = require("crypto");
const centralPool = require("../database");
const { getTenantPool, runWithTenant } = require("../tenant-pool");

/*
 * Cookie-based server sessions.
 *   The browser holds a random token in an HttpOnly cookie; the central DB stores only its SHA-256
 *   (plus the hospital it belongs to), so sessions can be revoked on logout and a DB leak can't be replayed.
 *   The user record itself lives in that hospital's own database.
 */

const SESSION_COOKIE = "hms_session";
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS) || 12;
const isProduction = process.env.NODE_ENV === "production";

const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

const cookieOptions = () => ({
  httpOnly: true,
  secure: isProduction,
  sameSite: "strict",
  path: "/api",
});

/** Creates a session row and sets the cookie. */
const createSession = async (res, userId, organizationId) => {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000);
  await centralPool.query(
    "INSERT INTO user_sessions (user_id, organization_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)",
    [userId, organizationId, hashToken(token), expiresAt]
  );
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), expires: expiresAt });
};

/** Revokes the request's session (if any) and clears the cookie. */
const destroySession = async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    await centralPool.query(
      "UPDATE user_sessions SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL",
      [hashToken(token)]
    );
  }
  res.clearCookie(SESSION_COOKIE, cookieOptions());
};

/**
 * Resolves the logged-in user from the session cookie. The hospital (and so its database) and the
 * role come only from the server-side records — never from the request.
 * Sets req.auth = { userId, organizationId, role, dbName } and runs the rest of the request against
 * that hospital's database (see tenant-pool.js).
 */
const requireAuth = async (req, res, next) => {
  const expired = () => {
    res.clearCookie(SESSION_COOKIE, cookieOptions());
    return res.status(401).json({ success: false, message: "Session expired. Please log in again." });
  };

  let auth;
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    const session = (
      await centralPool.query(
        `SELECT s.user_id, o.id AS organization_id, o.db_name
         FROM user_sessions s
         JOIN organizations o ON o.id = s.organization_id
         WHERE s.token_hash = $1
           AND s.revoked_at IS NULL
           AND s.expires_at > NOW()
           AND o.status = 'ACTIVE'
           AND o.db_name IS NOT NULL`,
        [hashToken(token)]
      )
    ).rows[0];
    if (!session) return expired();

    const pool = getTenantPool(session.db_name);
    const user = (await pool.query("SELECT role FROM users WHERE id = $1 AND status = 'ACTIVE'", [session.user_id]))
      .rows[0];
    if (!user) return expired();

    auth = { userId: session.user_id, organizationId: session.organization_id, role: user.role, dbName: session.db_name };
    req.auth = auth;
    req.tenantPool = pool;
  } catch (error) {
    console.error("Auth check failed:", error.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
  runWithTenant(req.tenantPool, () => next());
};

/** Use after requireAuth. Role comes from the DB via the session, never from the request. */
const requireRole =
  (...roles) =>
  (req, res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return res.status(403).json({ success: false, message: "You do not have permission to do this." });
    }
    next();
  };

/** Ends every open session of a user (e.g. when the account is deactivated or deleted). */
const revokeUserSessions = (userId) =>
  centralPool.query("UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL", [
    userId,
  ]);

module.exports = {
  createSession,
  destroySession,
  requireAuth,
  requireRole,
  revokeUserSessions,
  hashToken,
};
