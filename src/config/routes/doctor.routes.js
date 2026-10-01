const express = require("express");
const router = express.Router();

const {
  listDepartments,
  listDoctors,
  getDoctor,
  createDoctor,
  updateDoctor,
  deleteDoctor,
} = require("../controller/doctor.controller");

router.get("/departments", listDepartments);

router.get("/doctors", listDoctors);
router.get("/doctors/:id", getDoctor);
router.post("/doctors", createDoctor);
router.put("/doctors/:id", updateDoctor);
router.delete("/doctors/:id", deleteDoctor);

module.exports = router;
