const crypto = require("crypto");
const pool = require("../tenant-pool"); // the logged-in hospital's own database
const centralPool = require("../database"); // registry: login emails, invitations, organizations
const { recordAudit } = require("../audit");
const { issueInvitation, deliverInvitation, revokeInvitations, latestInvitations } = require("../auth/invitation");
const { revokeUserSessions } = require("../auth/session");
const { syncDoctorRecord, reassignPatients } = require("../doctor-sync");

/*
 * User management (Superadmin only): Doctor and Operator accounts of the caller's organization.
 *   GET   /users?role=&status=&department=&search=&sort=&page=&pageSize=   (all roles incl. SUPERADMIN;
 *                                       Superadmin accounts are listed but can't be changed here)
 *   POST  /users/invitations            create an INVITED account + email a password-setup link
 *   GET   /users/:id
 *   PATCH /users/:id                    profile fields + department assignments
 *   PATCH /users/:id/status             { status: ACTIVE | DISABLED }
 *   POST  /users/:id/resend-invitation
 *   DELETE /users/:id?reassignTo=D-###  removes the account (and its Doctors-directory entry; a doctor's
 *                                       patients move to `reassignTo`)
 * Queries run in the hospital database chosen by the session (requireAuth), so users of another
 * hospital simply don't exist here (404). Login emails are reserved in the central user_directory,
 * keeping them unique across hospitals. Superadmin accounts can't be managed here and roles can
 * only be DOCTOR or OPERATOR.
 * Doctor accounts are mirrored into the doctors directory (Doctors page, patient assignment) by
 * syncDoctorRecord in the same transaction.
 */

const STAFF_ROLES = ["DOCTOR", "OPERATOR"];
const LIST_ROLES = ["SUPERADMIN", ...STAFF_ROLES];
const STATUSES = ["INVITED", "ACTIVE", "DISABLED"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[\d\s()-]{7,20}$/;
const LICENSE = /^[A-Za-z0-9][A-Za-z0-9/.\- ]{1,49}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PAGE_SIZE = 100;

const fail = (res, status, message, errors) =>
  res.status(status).json({ success: false, message, ...(errors && { errors }) });

const str = (value) => (typeof value === "string" ? value.trim() : "");
const optional = (value) => str(value) || null;

const SELECT_STAFF = `
  SELECT u.id, u.full_name, u.email, u.phone, u.role, u.status, u.specialization, u.license_number,
         u.created_at, u.updated_at, (u.password_hash IS NOT NULL) AS has_password,
         (SELECT doc.id FROM doctors doc WHERE doc.user_id = u.id) AS doctor_id,
         COALESCE(dep.items, '[]'::json) AS departments
  FROM users u
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object('id', d.id, 'name', d.name) ORDER BY d.sort_order) AS items
    FROM user_department_assignments a
    JOIN departments d ON d.id = a.department_id
    WHERE a.user_id = u.id
  ) dep ON true
`;

/** Adds the latest invitation (kept in the central registry) to each user row. */
const withInvitations = async (rows) => {
  const invitations = await latestInvitations(rows.map((r) => r.id));
  return rows.map((r) => {
    const inv = invitations.get(r.id);
    return {
      ...r,
      invited_at: inv?.created_at ?? null,
      invitation_expires_at: inv?.expires_at ?? null,
      invitation_revoked_at: inv?.revoked_at ?? null,
    };
  });
};

const invitationStatus = (row) => {
  if (row.has_password) return "ACCEPTED";
  if (!row.invited_at) return "NOT_SENT";
  if (row.invitation_revoked_at) return "REVOKED";
  if (new Date(row.invitation_expires_at) <= new Date()) return "EXPIRED";
  return "PENDING";
};

const toStaff = (row) => ({
  id: row.id,
  fullName: row.full_name,
  email: row.email,
  phone: row.phone,
  role: row.role,
  status: row.status,
  specialization: row.specialization,
  licenseNumber: row.license_number,
  /** D-### entry in the doctors directory (doctors only). */
  doctorId: row.doctor_id,
  departments: row.departments,
  invitation: {
    status: invitationStatus(row),
    sentAt: row.invited_at,
    expiresAt: row.invitation_expires_at,
  },
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Loads one Doctor/Operator of this hospital, or null (also for malformed / unknown ids). */
const findStaff = async (db, id) => {
  if (!UUID.test(String(id))) return null;
  const result = await db.query(`${SELECT_STAFF} WHERE u.id = $1 AND u.role = ANY($2)`, [id, STAFF_ROLES]);
  return result.rows[0] ? (await withInvitations(result.rows))[0] : null;
};

/** Validates profile fields; `role` decides whether doctor-only fields apply. */
const validateProfile = (input, role) => {
  const errors = {};
  if (input.fullName.length < 2 || input.fullName.length > 100) {
    errors.fullName = "Full name must be 2–100 characters.";
  }
  if (input.phone && !PHONE.test(input.phone)) {
    errors.phone = "Enter a valid phone number.";
  }
  if (role === "DOCTOR") {
    if (!input.specialization || input.specialization.length < 2 || input.specialization.length > 100) {
      errors.specialization = "Specialization is required (2–100 characters).";
    }
    if (input.licenseNumber && !LICENSE.test(input.licenseNumber)) {
      errors.licenseNumber = "Use 2–50 letters, numbers, spaces, '/', '.' or '-'.";
    }
  }
  if (
    !Array.isArray(input.departmentIds) ||
    input.departmentIds.length === 0 ||
    input.departmentIds.length > 10 ||
    !input.departmentIds.every((d) => typeof d === "string" && d.length > 0 && d.length <= 30)
  ) {
    errors.departmentIds = "Select at least one department.";
  }
  return errors;
};

/** Department ids must exist in the reference list. Returns an error message or null. */
const checkDepartments = async (db, departmentIds) => {
  const unique = [...new Set(departmentIds)];
  const result = await db.query("SELECT id FROM departments WHERE id = ANY($1)", [unique]);
  return result.rows.length === unique.length ? null : "One or more selected departments do not exist.";
};

const replaceDepartments = async (client, userId, departmentIds) => {
  await client.query("DELETE FROM user_department_assignments WHERE user_id = $1", [userId]);
  await client.query(
    `INSERT INTO user_department_assignments (user_id, department_id)
     SELECT $1, unnest($2::varchar[])`,
    [userId, [...new Set(departmentIds)]]
  );
};

const uniqueViolation = (res, error) => {
  if (error.code !== "23505") return false;
  if (error.constraint === "users_email_unique" || error.constraint === "user_directory_pkey") {
    const message = "An account with this email already exists.";
    fail(res, 409, message, { email: message });
    return true;
  }
  if (error.constraint === "doctors_email_unique") {
    const message = "Another doctor in the Doctors list already uses this email.";
    fail(res, 409, message, { email: message });
    return true;
  }
  if (error.constraint === "users_license_unique") {
    const message = "This license number is already used in your hospital.";
    fail(res, 409, message, { licenseNumber: message });
    return true;
  }
  return false;
};

const organizationName = async (organizationId) =>
  (await centralPool.query("SELECT name FROM organizations WHERE id = $1", [organizationId])).rows[0]?.name ??
  "your hospital";

/** Frees a login email and ends access (after a user was deleted, or a failed invite). */
const releaseAccount = async (userId) => {
  await centralPool.query("DELETE FROM user_directory WHERE user_id = $1", [userId]);
  await revokeInvitations(userId);
  await centralPool.query("UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL", [
    userId,
  ]);
};

const listUsers = async (req, res) => {
  const role = str(req.query.role).toUpperCase();
  const status = str(req.query.status).toUpperCase();
  const department = str(req.query.department);
  const search = str(req.query.search).slice(0, 100);
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 20));
  const orderBy = req.query.sort === "name" ? "u.full_name ASC, u.id" : "u.created_at DESC, u.id";

  if (role && !LIST_ROLES.includes(role)) return fail(res, 400, "role must be SUPERADMIN, DOCTOR or OPERATOR");
  if (status && !STATUSES.includes(status)) return fail(res, 400, "status must be INVITED, ACTIVE or DISABLED");

  const params = [role ? [role] : LIST_ROLES];
  const where = ["u.role = ANY($1)"];
  if (status) {
    params.push(status);
    where.push(`u.status = $${params.length}`);
  }
  if (department) {
    params.push(department);
    where.push(
      `EXISTS (SELECT 1 FROM user_department_assignments a WHERE a.user_id = u.id AND a.department_id = $${params.length})`
    );
  }
  if (search) {
    params.push(`%${search.replace(/[\\%_]/g, (c) => "\\" + c)}%`);
    where.push(`(u.full_name ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
  }
  const whereSql = where.join(" AND ");

  try {
    const total = await pool.query(`SELECT COUNT(*)::int AS n FROM users u WHERE ${whereSql}`, params);
    const rows = await pool.query(
      `${SELECT_STAFF} WHERE ${whereSql} ORDER BY ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    res.json({
      success: true,
      data: { items: (await withInvitations(rows.rows)).map(toStaff), total: total.rows[0].n, page, pageSize },
    });
  } catch (error) {
    console.error("List users failed:", error.message);
    fail(res, 500, "Internal server error");
  }
};

const getUser = async (req, res) => {
  try {
    const row = await findStaff(pool, req.params.id);
    if (!row) return fail(res, 404, "User not found");
    res.json({ success: true, data: toStaff(row) });
  } catch (error) {
    console.error("Get user failed:", error.message);
    fail(res, 500, "Internal server error");
  }
};

const inviteUser = async (req, res) => {
  const { organizationId, userId: actorId } = req.auth;
  const body = req.body ?? {};
  const role = str(body.role).toUpperCase();
  const input = {
    fullName: str(body.fullName),
    email: str(body.email).toLowerCase(),
    phone: optional(body.phone),
    specialization: role === "DOCTOR" ? optional(body.specialization) : null,
    licenseNumber: role === "DOCTOR" ? optional(body.licenseNumber) : null,
    departmentIds: body.departmentIds,
    // Optional: give an existing Doctors-list entry (without an account) this login account.
    doctorId: role === "DOCTOR" ? optional(body.doctorId) : null,
  };

  const errors = validateProfile(input, role);
  if (!STAFF_ROLES.includes(role)) errors.role = "Role must be Doctor or Operator.";
  if (input.doctorId && !/^D-\d{3,}$/.test(input.doctorId)) errors.doctorId = "Invalid doctor id.";
  if (!EMAIL.test(input.email) || input.email.length > 254) errors.email = "Enter a valid email address.";
  if (Object.keys(errors).length > 0) return fail(res, 400, "Please correct the highlighted fields.", errors);

  // Reserve the login email application-wide first (central registry).
  const userId = crypto.randomUUID();
  try {
    await centralPool.query("INSERT INTO user_directory (email, user_id, organization_id) VALUES ($1, $2, $3)", [
      input.email,
      userId,
      organizationId,
    ]);
  } catch (error) {
    if (uniqueViolation(res, error)) return;
    console.error("Invite user failed:", error.message);
    return fail(res, 500, "Could not create the user. Please try again.");
  }

  const client = await pool.connect();
  let invitation;
  let created;
  try {
    const departmentError = await checkDepartments(client, input.departmentIds);
    if (departmentError) {
      await releaseAccount(userId);
      return fail(res, 400, departmentError, { departmentIds: departmentError });
    }

    await client.query("BEGIN");
    // The role comes from the whitelist above and the hospital from the session — never from the body as-is.
    created = (
      await client.query(
        `INSERT INTO users (id, full_name, email, phone, role, status, specialization, license_number, created_by)
         VALUES ($1, $2, $3, $4, $5, 'INVITED', $6, $7, $8)
         RETURNING id, full_name, email, role`,
        [userId, input.fullName, input.email, input.phone, role, input.specialization, input.licenseNumber, actorId]
      )
    ).rows[0];
    await replaceDepartments(client, created.id, input.departmentIds);
    await syncDoctorRecord(client, created.id, input.departmentIds, { linkDoctorId: input.doctorId });
    await recordAudit(client, {
      actorUserId: actorId,
      action: "user.invited",
      entityType: "user",
      entityId: created.id,
      metadata: {
        role,
        email: input.email,
        departmentIds: [...new Set(input.departmentIds)],
        ...(input.doctorId && { linkedDoctorId: input.doctorId }),
      },
    });
    // Central registry; if the commit below fails, the orphan token can't be used (no INVITED user).
    invitation = await issueInvitation({ organizationId, userId: created.id, createdBy: actorId });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    await releaseAccount(userId).catch((e) => console.error("Release email failed:", e.message));
    if (uniqueViolation(res, error)) return;
    if (error.code === "DOCTOR_NOT_LINKABLE") {
      return fail(res, 409, "This doctor doesn't exist or already has a login account.");
    }
    console.error("Invite user failed:", error.message);
    return fail(res, 500, "Could not create the user. Please try again.");
  } finally {
    client.release();
  }

  try {
    const delivery = await deliverInvitation({
      invitation,
      user: created,
      organizationName: await organizationName(organizationId),
    });
    const user = toStaff(await findStaff(pool, created.id));
    res.status(201).json({
      success: true,
      message: delivery.emailSent ? "Invitation sent." : "User created. Invitation email was not sent.",
      data: { user, invitation: delivery },
    });
  } catch (error) {
    console.error("Invite user response failed:", error.message);
    fail(res, 500, "User created, but the response failed. Refresh the list.");
  }
};

const updateUser = async (req, res) => {
  const { userId: actorId } = req.auth;
  const body = req.body ?? {};
  if ("role" in body || "email" in body || "organizationId" in body || "status" in body) {
    return fail(res, 400, "Role, email, organization and status can't be changed here.");
  }

  const client = await pool.connect();
  try {
    const existing = await findStaff(client, req.params.id);
    if (!existing) return fail(res, 404, "User not found");

    const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
    const isDoctor = existing.role === "DOCTOR";
    const input = {
      fullName: has("fullName") ? str(body.fullName) : existing.full_name,
      phone: has("phone") ? optional(body.phone) : existing.phone,
      specialization: !isDoctor ? null : has("specialization") ? optional(body.specialization) : existing.specialization,
      licenseNumber: !isDoctor ? null : has("licenseNumber") ? optional(body.licenseNumber) : existing.license_number,
      departmentIds: has("departmentIds") ? body.departmentIds : existing.departments.map((d) => d.id),
    };

    const errors = validateProfile(input, existing.role);
    if (Object.keys(errors).length > 0) return fail(res, 400, "Please correct the highlighted fields.", errors);
    const departmentError = await checkDepartments(client, input.departmentIds);
    if (departmentError) return fail(res, 400, departmentError, { departmentIds: departmentError });

    const before = {
      fullName: existing.full_name,
      phone: existing.phone,
      specialization: existing.specialization,
      licenseNumber: existing.license_number,
      departmentIds: existing.departments.map((d) => d.id).sort(),
    };
    const after = { ...input, departmentIds: [...new Set(input.departmentIds)].sort() };
    const changed = Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));

    if (changed.length > 0) {
      await client.query("BEGIN");
      await client.query(
        `UPDATE users SET full_name = $1, phone = $2, specialization = $3, license_number = $4, updated_at = NOW()
         WHERE id = $5`,
        [input.fullName, input.phone, input.specialization, input.licenseNumber, existing.id]
      );
      if (changed.includes("departmentIds")) await replaceDepartments(client, existing.id, input.departmentIds);
      await syncDoctorRecord(client, existing.id, input.departmentIds);
      await recordAudit(client, {
        actorUserId: actorId,
        action: "user.updated",
        entityType: "user",
        entityId: existing.id,
        metadata: { changed },
      });
      await client.query("COMMIT");
    }

    res.json({
      success: true,
      message: changed.length > 0 ? "User updated" : "No changes",
      data: toStaff(await findStaff(client, existing.id)),
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (uniqueViolation(res, error)) return;
    console.error("Update user failed:", error.message);
    fail(res, 500, "Internal server error");
  } finally {
    client.release();
  }
};

/**
 * ACTIVE re-enables the account (back to INVITED if the password was never set);
 * DISABLED blocks login, ends open sessions and cancels pending invitations.
 */
const updateUserStatus = async (req, res) => {
  const { userId: actorId } = req.auth;
  const requested = str(req.body?.status).toUpperCase();
  if (!["ACTIVE", "DISABLED"].includes(requested)) {
    return fail(res, 400, "status must be ACTIVE or DISABLED", { status: "Choose Active or Disabled." });
  }

  const client = await pool.connect();
  try {
    const existing = await findStaff(client, req.params.id);
    if (!existing) return fail(res, 404, "User not found");

    const next = requested === "DISABLED" ? "DISABLED" : existing.has_password ? "ACTIVE" : "INVITED";
    if (next === existing.status) {
      return res.json({ success: true, message: "No changes", data: toStaff(existing) });
    }

    await client.query("BEGIN");
    await client.query("UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2", [next, existing.id]);
    await syncDoctorRecord(client, existing.id);
    await recordAudit(client, {
      actorUserId: actorId,
      action: next === "DISABLED" ? "user.deactivated" : "user.activated",
      entityType: "user",
      entityId: existing.id,
      metadata: { from: existing.status, to: next },
    });
    await client.query("COMMIT");
    if (next === "DISABLED") {
      // Login is already blocked by the status (requireAuth checks it); this also cleans up.
      await revokeUserSessions(existing.id);
      await revokeInvitations(existing.id);
    }

    res.json({
      success: true,
      message: next === "DISABLED" ? "User deactivated" : "User activated",
      data: toStaff(await findStaff(client, existing.id)),
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Update user status failed:", error.message);
    fail(res, 500, "Internal server error");
  } finally {
    client.release();
  }
};

const resendInvitation = async (req, res) => {
  const { organizationId, userId: actorId } = req.auth;
  let existing;
  let invitation;
  try {
    existing = await findStaff(pool, req.params.id);
    if (!existing) return fail(res, 404, "User not found");
    if (existing.status !== "INVITED") {
      return fail(res, 409, "Only users who haven't accepted their invitation can be re-invited.");
    }
    invitation = await issueInvitation({ organizationId, userId: existing.id, createdBy: actorId });
    await recordAudit(pool, {
      actorUserId: actorId,
      action: "user.invitation_resent",
      entityType: "user",
      entityId: existing.id,
    });
  } catch (error) {
    console.error("Resend invitation failed:", error.message);
    return fail(res, 500, "Internal server error");
  }

  try {
    const delivery = await deliverInvitation({
      invitation,
      user: existing,
      organizationName: await organizationName(organizationId),
    });
    res.json({
      success: true,
      message: delivery.emailSent ? "Invitation sent." : "New invitation created. Email was not sent.",
      data: { user: toStaff(await findStaff(pool, existing.id)), invitation: delivery },
    });
  } catch (error) {
    console.error("Resend invitation response failed:", error.message);
    fail(res, 500, "Invitation created, but the response failed. Refresh the list.");
  }
};

/**
 * Permanently removes a Doctor/Operator account. A doctor who still has patients can't be removed
 * (reassign them first, or deactivate instead). The audit entry keeps the name and email.
 */
const deleteUser = async (req, res) => {
  const { userId: actorId } = req.auth;
  const client = await pool.connect();
  try {
    const existing = await findStaff(client, req.params.id);
    if (!existing) return fail(res, 404, "User not found");

    await client.query("BEGIN");
    const reassignTo = str(req.query.reassignTo) || null;
    if (existing.doctor_id) {
      const problem = await reassignPatients(client, existing.doctor_id, reassignTo);
      if (problem) {
        await client.query("ROLLBACK");
        return fail(res, problem.status, problem.message);
      }
      await client.query("DELETE FROM doctors WHERE id = $1", [existing.doctor_id]);
    }
    await client.query("DELETE FROM users WHERE id = $1", [existing.id]);
    await recordAudit(client, {
      actorUserId: actorId,
      action: "user.deleted",
      entityType: "user",
      entityId: existing.id,
      metadata: {
        role: existing.role,
        fullName: existing.full_name,
        email: existing.email,
        doctorId: existing.doctor_id,
        ...(reassignTo && existing.doctor_id && { patientsReassignedTo: reassignTo }),
      },
    });
    await client.query("COMMIT");
    await releaseAccount(existing.id); // frees the email, ends sessions, cancels invitations
    res.json({ success: true, message: "User deleted", data: null });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23503") {
      return fail(res, 409, "This user is still referenced by other records. Deactivate the account instead.");
    }
    console.error("Delete user failed:", error.message);
    fail(res, 500, "Internal server error");
  } finally {
    client.release();
  }
};

module.exports = {
  deleteUser,
  listUsers,
  getUser,
  inviteUser,
  updateUser,
  updateUserStatus,
  resendInvitation,
};
