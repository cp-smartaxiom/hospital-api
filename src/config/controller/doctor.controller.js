const pool = require("../database");

/*
 * Doctors + departments API.
 * Doctor JSON: { id, name, departmentId, departmentName, phone, email, status, patientCount }
 * Input:       { id, name, departmentId, phone?, email?, status? }
 * Responses follow { success, message?, data }.
 */

const DOCTOR_ID = /^D-\d{3,}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[\d\s()-]{7,20}$/;
const STATUSES = ["active", "inactive"];

const SELECT_DOCTORS = `
  SELECT d.id, d.name, d.department_id, dep.name AS department_name, d.phone, d.email, d.status,
         (SELECT COUNT(*)::int FROM patients p WHERE p.doctor_id = d.id) AS patient_count
  FROM doctors d
  JOIN departments dep ON dep.id = d.department_id
`;

const toDoctor = (row) => ({
  id: row.id,
  name: row.name,
  departmentId: row.department_id,
  departmentName: row.department_name,
  phone: row.phone,
  email: row.email,
  status: row.status,
  patientCount: row.patient_count,
});

const fail = (res, status, message) => res.status(status).json({ success: false, message });

const findDoctor = async (id) => {
  const result = await pool.query(`${SELECT_DOCTORS} WHERE d.id = $1`, [id]);
  return result.rows[0] ? toDoctor(result.rows[0]) : null;
};

const handleDbError = (res, error, value = {}) => {
  if (error.code === "23505") {
    if (error.constraint === "doctors_pkey") return fail(res, 409, `Doctor ID ${value.id} already exists.`);
    if (error.constraint === "doctors_email_unique") return fail(res, 409, "Another doctor already uses this email.");
  }
  if (error.code === "23503" && error.constraint === "doctors_department_id_fkey") {
    return fail(res, 400, "Department not found.");
  }
  console.error(error);
  return fail(res, 500, "Internal server error");
};

const validateDoctorInput = (body, { isCreate }) => {
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const value = {
    id: str(body.id),
    name: str(body.name),
    departmentId: str(body.departmentId),
    phone: str(body.phone) || null,
    email: str(body.email).toLowerCase() || null,
    status: body.status ?? "active",
  };
  const errors = [];
  if (isCreate && !DOCTOR_ID.test(value.id)) errors.push("id is required and must look like D-001");
  if (!value.name) errors.push("name is required");
  if (value.name.length > 100) errors.push("name too long (max 100)");
  if (!value.departmentId) errors.push("departmentId is required");
  if (value.phone && !PHONE.test(value.phone)) errors.push("phone is not valid");
  if (value.email && (!EMAIL.test(value.email) || value.email.length > 150)) errors.push("email is not valid");
  if (!STATUSES.includes(value.status)) errors.push("status must be 'active' or 'inactive'");
  return { errors, value };
};

// GET /api/departments
const listDepartments = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT dep.id, dep.name, dep.description,
              COUNT(d.id)::int AS doctor_count
       FROM departments dep
       LEFT JOIN doctors d ON d.department_id = dep.id
       GROUP BY dep.id
       ORDER BY dep.sort_order`
    );
    res.json({
      success: true,
      data: result.rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        doctorCount: r.doctor_count,
      })),
    });
  } catch (error) {
    handleDbError(res, error);
  }
};

// GET /api/doctors?department=cardiology&status=active   (both optional)
const listDoctors = async (req, res) => {
  const conditions = [];
  const params = [];
  if (req.query.department) {
    params.push(req.query.department);
    conditions.push(`d.department_id = $${params.length}`);
  }
  if (req.query.status) {
    if (!STATUSES.includes(req.query.status)) return fail(res, 400, "status must be 'active' or 'inactive'");
    params.push(req.query.status);
    conditions.push(`d.status = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result = await pool.query(`${SELECT_DOCTORS} ${where} ORDER BY length(d.id), d.id`, params);
    res.json({ success: true, data: result.rows.map(toDoctor) });
  } catch (error) {
    handleDbError(res, error);
  }
};

// GET /api/doctors/:id
const getDoctor = async (req, res) => {
  try {
    const doctor = await findDoctor(req.params.id);
    if (!doctor) return fail(res, 404, "Doctor not found");
    res.json({ success: true, data: doctor });
  } catch (error) {
    handleDbError(res, error);
  }
};

// POST /api/doctors
const createDoctor = async (req, res) => {
  const { errors, value } = validateDoctorInput(req.body ?? {}, { isCreate: true });
  if (errors.length) return fail(res, 400, errors.join("; "));

  try {
    await pool.query(
      `INSERT INTO doctors (id, name, department_id, phone, email, status) VALUES ($1, $2, $3, $4, $5, $6)`,
      [value.id, value.name, value.departmentId, value.phone, value.email, value.status]
    );
    res.status(201).json({ success: true, message: "Doctor created successfully", data: await findDoctor(value.id) });
  } catch (error) {
    handleDbError(res, error, value);
  }
};

// PUT /api/doctors/:id   (id can't change)
const updateDoctor = async (req, res) => {
  const { errors, value } = validateDoctorInput(req.body ?? {}, { isCreate: false });
  if (errors.length) return fail(res, 400, errors.join("; "));

  try {
    const result = await pool.query(
      `UPDATE doctors SET name = $2, department_id = $3, phone = $4, email = $5, status = $6, updated_at = NOW()
       WHERE id = $1`,
      [req.params.id, value.name, value.departmentId, value.phone, value.email, value.status]
    );
    if (result.rowCount === 0) return fail(res, 404, "Doctor not found");
    res.json({ success: true, message: "Doctor updated successfully", data: await findDoctor(req.params.id) });
  } catch (error) {
    handleDbError(res, error, value);
  }
};

// DELETE /api/doctors/:id   → refused while patients are assigned
const deleteDoctor = async (req, res) => {
  try {
    const patients = await pool.query("SELECT COUNT(*)::int AS n FROM patients WHERE doctor_id = $1", [req.params.id]);
    if (patients.rows[0].n > 0) {
      return fail(
        res,
        409,
        `This doctor has ${patients.rows[0].n} patient(s). Assign them to another doctor before deleting.`
      );
    }
    const result = await pool.query("DELETE FROM doctors WHERE id = $1", [req.params.id]);
    if (result.rowCount === 0) return fail(res, 404, "Doctor not found");
    res.json({ success: true, message: "Doctor deleted successfully" });
  } catch (error) {
    // A patient assigned between the count and the delete still hits the FK.
    if (error.code === "23503") return fail(res, 409, "This doctor has patients. Reassign them first.");
    handleDbError(res, error);
  }
};

module.exports = { listDepartments, listDoctors, getDoctor, createDoctor, updateDoctor, deleteDoctor };
