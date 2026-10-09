const crypto = require("crypto");
const centralPool = require("../database");
const { hashToken } = require("./session");
const { sendInvitationEmail, isEmailConfigured } = require("../email/email.service");

/*
 * Single-use, expiring password-setup invitations.
 *   The link carries the token in the URL fragment (#token=…), so it never reaches server or proxy logs.
 *   Only the token's SHA-256 is stored, in the central registry together with the hospital, so the
 *   accept page can find the right hospital database. Issuing a new invitation revokes the user's older ones.
 */

const INVITATION_TTL_HOURS = Number(process.env.INVITATION_TTL_HOURS) || 72;
const isProduction = process.env.NODE_ENV === "production";

const appUrl = () => (process.env.APP_URL || "http://localhost:4200").replace(/\/+$/, "");

/** Creates the invitation row (central DB) and returns the raw token. */
const issueInvitation = async ({ organizationId, userId, createdBy }) => {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITATION_TTL_HOURS * 60 * 60 * 1000);

  await centralPool.query(
    "UPDATE user_invitations SET revoked_at = NOW() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL",
    [userId]
  );
  await centralPool.query(
    `INSERT INTO user_invitations (organization_id, user_id, token_hash, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [organizationId, userId, hashToken(token), expiresAt, createdBy]
  );
  return { token, expiresAt, link: `${appUrl()}/accept-invite#token=${token}` };
};

/**
 * Emails the invitation after the transaction committed. Never throws: the account exists either way
 * and the Superadmin can resend. `devInviteUrl` is only returned outside production when no email
 * provider is configured, so invitations can be tested locally.
 */
const deliverInvitation = async ({ invitation, user, organizationName }) => {
  let emailSent = false;
  try {
    const result = await sendInvitationEmail({
      to: user.email,
      fullName: user.full_name,
      organizationName,
      role: user.role,
      link: invitation.link,
      expiresAt: invitation.expiresAt,
    });
    emailSent = result.delivered;
  } catch (error) {
    console.error("Invitation email failed:", error.message);
  }
  return {
    emailSent,
    expiresAt: invitation.expiresAt,
    ...(!isProduction && !isEmailConfigured() && { devInviteUrl: invitation.link }),
  };
};

/** Cancels a user's open invitations (e.g. when the account is deactivated or deleted). */
const revokeInvitations = (userId) =>
  centralPool.query(
    "UPDATE user_invitations SET revoked_at = NOW() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL",
    [userId]
  );

/** Latest invitation per user, keyed by user id (for the "Invitation" column). */
const latestInvitations = async (userIds) => {
  if (userIds.length === 0) return new Map();
  const { rows } = await centralPool.query(
    `SELECT DISTINCT ON (user_id) user_id, created_at, expires_at, used_at, revoked_at
     FROM user_invitations
     WHERE user_id = ANY($1)
     ORDER BY user_id, created_at DESC`,
    [userIds]
  );
  return new Map(rows.map((r) => [r.user_id, r]));
};

module.exports = { issueInvitation, deliverInvitation, revokeInvitations, latestInvitations };
