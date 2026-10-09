const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();

const {
  listUsers,
  getUser,
  inviteUser,
  updateUser,
  updateUserStatus,
  resendInvitation,
  deleteUser,
} = require("../controller/user.controller");
const { listAuditLogs } = require("../controller/audit.controller");
const { requireAuth, requireRole } = require("../auth/session");

const superadmin = [requireAuth, requireRole("SUPERADMIN")];

// Invitations send email: at most 30 per hour per Superadmin.
const invitationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  keyGenerator: (req) => req.auth.userId,
  skip: () => process.env.NODE_ENV === "test",
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { success: false, message: "Too many invitations. Please try again later." },
});

router.get("/users", superadmin, listUsers);
router.post("/users/invitations", superadmin, invitationLimiter, inviteUser);
router.get("/users/:id", superadmin, getUser);
router.patch("/users/:id", superadmin, updateUser);
router.patch("/users/:id/status", superadmin, updateUserStatus);
router.post("/users/:id/resend-invitation", superadmin, invitationLimiter, resendInvitation);
router.delete("/users/:id", superadmin, deleteUser);

router.get("/audit-logs", superadmin, listAuditLogs);

module.exports = router;
