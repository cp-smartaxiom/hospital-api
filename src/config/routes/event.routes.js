const express = require("express");
const router = express.Router();
const { requireAuth } = require("../auth/session");

const { getEvents, streamEvents } = require("../controller/event.controller");

router.get("/events", requireAuth, getEvents);
router.get("/events/stream", requireAuth, streamEvents);

// Every route needs a session: it selects the hospital database (see requireAuth).
module.exports = router;
