const express = require("express");
const router = express.Router();

const {
  listPatients,
  getPatient,
  createPatient,
  updatePatient,
  deletePatient,
} = require("../controller/patient.controller");

router.get("/patients", listPatients);
router.get("/patients/:id", getPatient);
router.post("/patients", createPatient);
router.put("/patients/:id", updatePatient);
router.delete("/patients/:id", deletePatient);

module.exports = router;
