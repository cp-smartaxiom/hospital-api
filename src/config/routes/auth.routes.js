const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();

const { signup, login, logout, me } = require("../controller/auth.controller");
const { verifyInvitation, acceptInvitation } = require("../controller/invitation.controller");
const { requireAuth } = require("../auth/session");

const limiter = (windowMinutes, limit, options = {}) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    skip: () => process.env.NODE_ENV === "test",
    ...options,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { success: false, message: "Too many attempts. Please try again later." },
  });

router.post("/auth/signup", limiter(60, 10), signup);
router.post("/auth/login", limiter(15, 10, { skipSuccessfulRequests: true }), login);
router.post("/auth/logout", logout);
router.get("/auth/me", requireAuth, me);
router.post("/auth/invitations/verify", limiter(15, 30), verifyInvitation);
router.post("/auth/invitations/accept", limiter(15, 10), acceptInvitation);

module.exports = router;
