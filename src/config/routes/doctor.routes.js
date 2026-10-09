const express = require("express");
const router = express.Router();
const { requireAuth } = require("../auth/session");

const {
  listDepartments,
  listDoctors,
  getDoctor,
  createDoctor,
  updateDoctor,
  deleteDoctor,
} = require("../controller/doctor.controller");

router.get("/departments", requireAuth, listDepartments);

router.get("/doctors", requireAuth, listDoctors);
router.get("/doctors/:id", requireAuth, getDoctor);
router.post("/doctors", requireAuth, createDoctor);
router.put("/doctors/:id", requireAuth, updateDoctor);
router.delete("/doctors/:id", requireAuth, deleteDoctor);

// Every route needs a session: it selects the hospital database (see requireAuth).
module.exports = router;
