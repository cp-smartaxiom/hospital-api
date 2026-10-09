const nodemailer = require("nodemailer");

/*
 * Outgoing email.
 *   SMTP_HOST set   → sends through SMTP (SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD, MAIL_FROM).
 *   not set         → nothing is sent. Outside production the message (incl. the link) is printed
 *                     to the console so invitations can be tested locally; in production it is not.
 * Returns { delivered: boolean }.
 */

const isProduction = process.env.NODE_ENV === "production";
let transporter;

const getTransporter = () => {
  if (!process.env.SMTP_HOST) return null;
  transporter ??= nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
  });
  return transporter;
};

const isEmailConfigured = () => Boolean(process.env.SMTP_HOST);

const sendEmail = async ({ to, subject, text, html }) => {
  const smtp = getTransporter();
  if (!smtp) {
    if (!isProduction && process.env.NODE_ENV !== "test") {
      console.log(`[email:dev] Not sent (SMTP not configured)\n  To: ${to}\n  Subject: ${subject}\n${text}`);
    }
    return { delivered: false };
  }
  await smtp.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text, html });
  return { delivered: true };
};

const ROLE_LABELS = { DOCTOR: "Doctor", OPERATOR: "Operator" };

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const sendInvitationEmail = ({ to, fullName, organizationName, role, link, expiresAt }) => {
  const roleLabel = ROLE_LABELS[role] ?? role;
  const expires = expiresAt.toUTCString();
  const text =
    `Hello ${fullName},\n\n` +
    `You have been invited to join ${organizationName} as a ${roleLabel}.\n` +
    `Set your password using this link (valid until ${expires}):\n\n${link}\n\n` +
    `If you were not expecting this invitation, you can ignore this email.`;
  const html =
    `<p>Hello ${escapeHtml(fullName)},</p>` +
    `<p>You have been invited to join <strong>${escapeHtml(organizationName)}</strong> as a ${escapeHtml(roleLabel)}.</p>` +
    `<p><a href="${escapeHtml(link)}">Set your password</a> (valid until ${escapeHtml(expires)}).</p>` +
    `<p>If you were not expecting this invitation, you can ignore this email.</p>`;
  return sendEmail({ to, subject: `Invitation to ${organizationName}`, text, html });
};

module.exports = { isEmailConfigured, sendEmail, sendInvitationEmail };
