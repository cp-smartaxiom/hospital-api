const pool = require("../database");

/*
 * Patients API. JSON uses the UI's field names:
 *   { id, name, room, bed, doctorId, doctorName, departmentName }
 * Input: { id, name, room, bed, doctorId }. Responses follow { success, message?, data }.
 */

const PATIENT_ID = /^P-\d{3,}$/;
const STORE = "Device Store";

const SELECT_PATIENTS = `
  SELECT p.id, p.name, p.room, p.bed, p.doctor_id,
         d.name AS doctor_name, dep.name AS department_name
  FROM patients p
  LEFT JOIN doctors d       ON d.id = p.doctor_id
  LEFT JOIN departments dep ON dep.id = d.department_id
`;

const toPatient = (row) => ({
  id: row.id,
  name: row.name,
  room: row.room,
  bed: row.bed,
  doctorId: row.doctor_id,
  doctorName: row.doctor_name,
  departmentName: row.department_name,
});

const fail = (res, status, message) => res.status(status).json({ success: false, message });

const findPatient = async (id) => {
  const result = await pool.query(`${SELECT_PATIENTS} WHERE p.id = $1`, [id]);
  return result.rows[0] ? toPatient(result.rows[0]) : null;
};

const validatePatientInput = (body, { isCreate }) => {
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const value = {
    id: str(body.id),
    name: str(body.name),
    room: str(body.room),
    bed: str(body.bed),
    doctorId: str(body.doctorId),
  };
  const errors = [];
  if (isCreate && !PATIENT_ID.test(value.id)) errors.push("id is required and must look like P-001");
  if (!value.name) errors.push("name is required");
  if (!value.room) errors.push("room is required");
  if (!value.bed) errors.push("bed is required");
  if (!value.doctorId) errors.push("doctorId is required");
  if (value.name.length > 100) errors.push("name too long (max 100)");
  if (value.room.length > 20 || value.bed.length > 20) errors.push("room/bed too long (max 20)");
  return { errors, value };
};

/**
 * The doctor must exist and be active — except when an existing patient keeps the doctor
 * they already have (so a doctor set to inactive doesn't block editing other fields).
 */
const checkDoctor = async (doctorId, currentDoctorId = null) => {
  const result = await pool.query("SELECT status FROM doctors WHERE id = $1", [doctorId]);
  if (result.rows.length === 0) return "Doctor not found";
  if (result.rows[0].status !== "active" && doctorId !== currentDoctorId) return "Doctor is inactive";
  return null;
};

// GET /api/patients
const listPatients = async (req, res) => {
  try {
    const result = await pool.query(`${SELECT_PATIENTS} ORDER BY length(p.id), p.id`);
    res.json({ success: true, data: result.rows.map(toPatient) });
  } catch (error) {
    console.error(error);
    fail(res, 500, "Internal server error");
  }
};

// GET /api/patients/:id
const getPatient = async (req, res) => {
  try {
    const patient = await findPatient(req.params.id);
    if (!patient) return fail(res, 404, "Patient not found");
    res.json({ success: true, data: patient });
  } catch (error) {
    console.error(error);
    fail(res, 500, "Internal server error");
  }
};

// POST /api/patients
const createPatient = async (req, res) => {
  const { errors, value } = validatePatientInput(req.body ?? {}, { isCreate: true });
  if (errors.length) return fail(res, 400, errors.join("; "));

  try {
    const doctorError = await checkDoctor(value.doctorId);
    if (doctorError) return fail(res, 400, doctorError);

    await pool.query(
      `INSERT INTO patients (id, name, room, bed, doctor_id) VALUES ($1, $2, $3, $4, $5)`,
      [value.id, value.name, value.room, value.bed, value.doctorId]
    );
    res.status(201).json({ success: true, message: "Patient created successfully", data: await findPatient(value.id) });
  } catch (error) {
    if (error.code === "23505") return fail(res, 409, `Patient ID ${value.id} already exists.`);
    console.error(error);
    fail(res, 500, "Internal server error");
  }
};

// PUT /api/patients/:id   (id can't change)
const updatePatient = async (req, res) => {
  const { errors, value } = validatePatientInput(req.body ?? {}, { isCreate: false });
  if (errors.length) return fail(res, 400, errors.join("; "));

  try {
    const existing = await pool.query("SELECT doctor_id FROM patients WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) return fail(res, 404, "Patient not found");

    const doctorError = await checkDoctor(value.doctorId, existing.rows[0].doctor_id);
    if (doctorError) return fail(res, 400, doctorError);

    await pool.query(
      `UPDATE patients SET name = $2, room = $3, bed = $4, doctor_id = $5, updated_at = NOW() WHERE id = $1`,
      [req.params.id, value.name, value.room, value.bed, value.doctorId]
    );
    res.json({ success: true, message: "Patient updated successfully", data: await findPatient(req.params.id) });
  } catch (error) {
    console.error(error);
    fail(res, 500, "Internal server error");
  }
};

// DELETE /api/patients/:id   → also frees the patient's devices
const deletePatient = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const freed = await client.query(
      `UPDATE devices SET patient_id = NULL, location = $2, updated_at = NOW() WHERE patient_id = $1`,
      [req.params.id, STORE]
    );
    const deleted = await client.query("DELETE FROM patients WHERE id = $1", [req.params.id]);
    if (deleted.rowCount === 0) {
      await client.query("ROLLBACK");
      return fail(res, 404, "Patient not found");
    }
    await client.query("COMMIT");
    res.json({
      success: true,
      message: `Patient deleted; ${freed.rowCount} device(s) released`,
      data: { releasedDevices: freed.rowCount },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    fail(res, 500, "Internal server error");
  } finally {
    client.release();
  }
};

module.exports = { listPatients, getPatient, createPatient, updatePatient, deletePatient };
