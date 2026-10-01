const express = require("express");
const router = express.Router();

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

router.get("/devices", listDevices);
router.get("/devices/summary", getDeviceSummary); // must be before /devices/:id
router.get("/devices/:id", getDevice);
router.post("/devices", createDevice);
router.put("/devices/:id", updateDevice);
router.delete("/devices/:id", deleteDevice);
router.post("/devices/:id/assign", assignDevice);
router.post("/devices/:id/unassign", unassignDevice);

module.exports = router;
