/*
 * Keeps the doctors directory (doctors table: Doctors page, patient assignment, department counts)
 * in sync with Doctor login accounts. Call inside the transaction that changed the user.
 *   - Links `linkDoctorId` when given (an existing directory doctor without an account), else reuses an
 *     unlinked doctor with the same email, otherwise creates the next D-### id.
 *   - Primary department: the current one if still assigned, else the first in `departmentIds`.
 *   - Status: DISABLED account → inactive; INVITED / ACTIVE → active.
 */

const doctorStatus = (userStatus) => (userStatus === "DISABLED" ? "inactive" : "active");

const syncDoctorRecord = async (client, userId, departmentIds = [], { linkDoctorId } = {}) => {
  const user = (
    await client.query("SELECT id, full_name, email, phone, status, role FROM users WHERE id = $1", [userId])
  ).rows[0];
  if (!user || user.role !== "DOCTOR") return null;

  const assigned = (
    await client.query(
      `SELECT a.department_id FROM user_department_assignments a
       JOIN departments dep ON dep.id = a.department_id
       WHERE a.user_id = $1 ORDER BY dep.sort_order`,
      [userId]
    )
  ).rows.map((r) => r.department_id);
  if (assigned.length === 0) return null;
  const preferred = departmentIds.find((d) => assigned.includes(d)) ?? assigned[0];

  if (linkDoctorId) {
    const result = await client.query("UPDATE doctors SET user_id = $2 WHERE id = $1 AND user_id IS NULL", [
      linkDoctorId,
      userId,
    ]);
    if (result.rowCount === 0) throw Object.assign(new Error("Doctor not linkable"), { code: "DOCTOR_NOT_LINKABLE" });
  }

  const linked = (await client.query("SELECT id, department_id FROM doctors WHERE user_id = $1", [userId])).rows[0];
  if (linked) {
    const department = assigned.includes(linked.department_id) ? linked.department_id : preferred;
    await client.query(
      `UPDATE doctors SET name = $2, email = $3, phone = $4, department_id = $5, status = $6, updated_at = NOW()
       WHERE id = $1`,
      [linked.id, user.full_name, user.email, user.phone, department, doctorStatus(user.status)]
    );
    return linked.id;
  }

  const sameEmail = (
    await client.query("SELECT id FROM doctors WHERE lower(email) = $1 AND user_id IS NULL", [user.email])
  ).rows[0];
  if (sameEmail) {
    await client.query(
      `UPDATE doctors SET user_id = $2, name = $3, phone = COALESCE($4, phone), department_id = $5, status = $6,
              updated_at = NOW()
       WHERE id = $1`,
      [sameEmail.id, userId, user.full_name, user.phone, preferred, doctorStatus(user.status)]
    );
    return sameEmail.id;
  }

  // Serialize id generation so two invitations can't pick the same D-###.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('doctors.id'))");
  const next = (
    await client.query("SELECT COALESCE(MAX(substring(id FROM 3)::int), 0) + 1 AS n FROM doctors")
  ).rows[0].n;
  const id = `D-${String(next).padStart(3, "0")}`;
  await client.query(
    `INSERT INTO doctors (id, name, department_id, phone, email, status, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, user.full_name, preferred, user.phone, user.email, doctorStatus(user.status), userId]
  );
  return id;
};

/**
 * Before deleting doctor `fromId` (inside the caller's transaction): moves its patients to `toId`.
 * Returns { status, message } when that isn't possible, or null when the doctor can be deleted.
 *   - no patients            → nothing to do
 *   - patients, no toId      → 409 (caller must pick another doctor)
 *   - toId invalid/inactive  → 400
 */
const reassignPatients = async (client, fromId, toId) => {
  // Lock the doctor so a patient can't be assigned between the move and the delete.
  await client.query("SELECT 1 FROM doctors WHERE id = $1 FOR UPDATE", [fromId]);
  const count = (await client.query("SELECT COUNT(*)::int AS n FROM patients WHERE doctor_id = $1", [fromId]))
    .rows[0].n;
  if (count === 0) return null;
  if (!toId) {
    return {
      status: 409,
      message: `This doctor has ${count} patient(s). Choose another doctor to take them over, or deactivate instead.`,
    };
  }
  if (toId === fromId) return { status: 400, message: "Choose a different doctor for the patients." };
  const target = (await client.query("SELECT status FROM doctors WHERE id = $1", [toId])).rows[0];
  if (!target) return { status: 400, message: "The doctor chosen for the patients doesn't exist." };
  if (target.status !== "active") return { status: 400, message: "The doctor chosen for the patients is inactive." };
  await client.query("UPDATE patients SET doctor_id = $2, updated_at = NOW() WHERE doctor_id = $1", [fromId, toId]);
  return null;
};

module.exports = { syncDoctorRecord, reassignPatients };
