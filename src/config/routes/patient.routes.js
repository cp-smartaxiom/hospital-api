const express = require("express");
const router = express.Router();
const { requireAuth } = require("../auth/session");

const {
  listPatients,
  getPatient,
  createPatient,
  updatePatient,
  deletePatient,
} = require("../controller/patient.controller");

router.get("/patients", requireAuth, listPatients);
router.get("/patients/:id", requireAuth, getPatient);
router.post("/patients", requireAuth, createPatient);
router.put("/patients/:id", requireAuth, updatePatient);
router.delete("/patients/:id", requireAuth, deletePatient);

// Every route needs a session: it selects the hospital database (see requireAuth).
module.exports = router;
