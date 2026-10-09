const centralPool = require("../database");
const { getTenantPool } = require("../tenant-pool");
const bcrypt = require("bcryptjs");
const { hashToken } = require("../auth/session");
const { recordAudit } = require("../audit");

/*
 * Public invitation endpoints (the invited Doctor/Operator isn't logged in yet).
 *   POST /auth/invitations/verify   { token }                              → who the invitation is for
 *   POST /auth/invitations/accept   { token, password, confirmPassword }   → sets the password, activates
 * The token is sent in the body (not the URL) and only its hash is looked up in the central registry,
 * which also says which hospital database the user lives in. All failure cases
 * (unknown, used, revoked, expired, disabled account) return the same 410 message.
 */

const BCRYPT_ROUNDS = 12;
const PASSWORD = /^(?=.*[A-Za-z])(?=.*\d).{8,128}$/;
const INVALID_INVITATION = "This invitation link is invalid or has expired. Ask your administrator for a new one.";

const fail = (res, status, message, errors) =>
  res.status(status).json({ success: false, message, ...(errors && { errors }) });

// Central part: the invitation and its hospital.
const SELECT_VALID_INVITATION = `
  SELECT i.id AS invitation_id, i.user_id, o.id AS organization_id, o.name AS organization_name, o.db_name
  FROM user_invitations i
  JOIN organizations o ON o.id = i.organization_id
  WHERE i.token_hash = $1
    AND i.used_at IS NULL
    AND i.revoked_at IS NULL
    AND i.expires_at > NOW()
    AND o.status = 'ACTIVE'
    AND o.db_name IS NOT NULL
`;

/** Hospital part: the invited user, if still waiting to accept. */
const invitedUser = async (db, userId, lock = "") =>
  (
    await db.query(`SELECT id, full_name, email, role FROM users WHERE id = $1 AND status = 'INVITED' ${lock}`, [
      userId,
    ])
  ).rows[0];

const readToken = (body) => (typeof body?.token === "string" && body.token.length <= 200 ? body.token : "");

const verifyInvitation = async (req, res) => {
  const token = readToken(req.body);
  if (!token) return fail(res, 410, INVALID_INVITATION);
  try {
    const invitation = (await centralPool.query(SELECT_VALID_INVITATION, [hashToken(token)])).rows[0];
    const user = invitation && (await invitedUser(getTenantPool(invitation.db_name), invitation.user_id));
    if (!user) return fail(res, 410, INVALID_INVITATION);
    res.json({
      success: true,
      data: { fullName: user.full_name, email: user.email, role: user.role, organizationName: invitation.organization_name },
    });
  } catch (error) {
    console.error("Verify invitation failed:", error.message);
    fail(res, 500, "Internal server error");
  }
};

const acceptInvitation = async (req, res) => {
  const token = readToken(req.body);
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const confirmPassword = typeof req.body?.confirmPassword === "string" ? req.body.confirmPassword : "";

  const errors = {};
  if (!PASSWORD.test(password)) {
    errors.password = "Password must be 8–128 characters and include a letter and a number.";
  }
  if (password !== confirmPassword) errors.confirmPassword = "Passwords do not match.";
  if (Object.keys(errors).length > 0) return fail(res, 400, "Please correct the highlighted fields.", errors);
  if (!token) return fail(res, 410, INVALID_INVITATION);

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const central = await centralPool.connect();
  let tenant;
  try {
    await central.query("BEGIN");
    // FOR UPDATE: two simultaneous accepts of the same token can't both succeed.
    const invitation = (await central.query(`${SELECT_VALID_INVITATION} FOR UPDATE OF i`, [hashToken(token)])).rows[0];
    if (!invitation) {
      await central.query("ROLLBACK");
      return fail(res, 410, INVALID_INVITATION);
    }

    tenant = await getTenantPool(invitation.db_name).connect();
    await tenant.query("BEGIN");
    const user = await invitedUser(tenant, invitation.user_id, "FOR UPDATE");
    if (!user) {
      await tenant.query("ROLLBACK");
      await central.query("ROLLBACK");
      return fail(res, 410, INVALID_INVITATION);
    }
    await tenant.query("UPDATE users SET password_hash = $1, status = 'ACTIVE', updated_at = NOW() WHERE id = $2", [
      passwordHash,
      user.id,
    ]);
    await recordAudit(tenant, {
      actorUserId: user.id,
      action: "user.invitation_accepted",
      entityType: "user",
      entityId: user.id,
    });

    await central.query("UPDATE user_invitations SET used_at = NOW() WHERE id = $1", [invitation.invitation_id]);
    await central.query(
      "UPDATE user_invitations SET revoked_at = NOW() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL",
      [user.id]
    );
    // Commit the token use first: if the hospital commit then failed, the user simply asks for a new link.
    await central.query("COMMIT");
    await tenant.query("COMMIT");

    res.json({ success: true, message: "Password set. You can now log in.", data: { email: user.email } });
  } catch (error) {
    await tenant?.query("ROLLBACK").catch(() => {});
    await central.query("ROLLBACK").catch(() => {});
    console.error("Accept invitation failed:", error.message);
    fail(res, 500, "Internal server error");
  } finally {
    tenant?.release();
    central.release();
  }
};

module.exports = { verifyInvitation, acceptInvitation };
