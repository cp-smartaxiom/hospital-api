const express = require("express");
const router = express.Router();
const { requireAuth } = require("../auth/session");

const {
  listDevices,
  getDeviceSummary,
  getDevice,
  createDevice,
  updateDevice,
  deleteDevice,
  assignDevice,
  unassignDevice,
} = require("../controller/device.controller");

router.get("/devices", requireAuth, listDevices);
router.get("/devices/summary", requireAuth, getDeviceSummary); // must be before /devices/:id
router.get("/devices/:id", requireAuth, getDevice);
router.post("/devices", requireAuth, createDevice);
router.put("/devices/:id", requireAuth, updateDevice);
router.delete("/devices/:id", requireAuth, deleteDevice);
router.post("/devices/:id/assign", requireAuth, assignDevice);
router.post("/devices/:id/unassign", requireAuth, unassignDevice);

// Every route needs a session: it selects the hospital database (see requireAuth).
module.exports = router;
