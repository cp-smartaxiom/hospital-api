// Phase 2: user management (Doctor / Operator invitations), RBAC, tenant isolation, audit log.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start, api, cleanup, createTenant, uniqueEmail, tokenFrom, tenantDb, pool, PASSWORD } = require("./helpers");

let a; // tenant A
let b; // tenant B
let dbA; // tenant A's own database

before(async () => {
  await start();
  a = await createTenant("Users Tenant A");
  b = await createTenant("Users Tenant B");
  dbA = await tenantDb(a.organization.id);
});
after(cleanup);

const doctorBody = (overrides = {}) => ({
  role: "DOCTOR",
  fullName: "Dr. Kiran Desai",
  email: uniqueEmail("doctor"),
  phone: "+91 98765 43210",
  specialization: "Cardiology",
  licenseNumber: `MCI-${Math.floor(Math.random() * 1e6)}`,
  departmentIds: ["cardiology", "critical_care"],
  ...overrides,
});

const operatorBody = (overrides = {}) => ({
  role: "OPERATOR",
  fullName: "Ravi Kumar",
  email: uniqueEmail("operator"),
  departmentIds: ["critical_care"],
  ...overrides,
});

const invite = (tenant, body) => api("/users/invitations", { method: "POST", cookie: tenant.cookie, body });

/** Invites a user and accepts the invitation; returns { user, cookie } logged in as that user. */
const inviteAndActivate = async (tenant, body) => {
  const res = await invite(tenant, body);
  const token = tokenFrom(res.body.data.invitation.devInviteUrl);
  await api("/auth/invitations/accept", {
    method: "POST",
    body: { token, password: PASSWORD, confirmPassword: PASSWORD },
  });
  const login = await api("/auth/login", { method: "POST", body: { email: body.email, password: PASSWORD } });
  return { user: res.body.data.user, cookie: login.cookie };
};

test("doctor invitation creates an INVITED doctor in the Superadmin's organization", async () => {
  const body = doctorBody({ organizationId: b.organization.id }); // must be ignored
  const res = await invite(a, body);
  assert.equal(res.status, 201);
  const { user, invitation } = res.body.data;
  assert.equal(user.role, "DOCTOR");
  assert.equal(user.status, "INVITED");
  assert.equal(user.invitation.status, "PENDING");
  assert.equal(user.specialization, "Cardiology");
  assert.deepEqual(user.departments.map((d) => d.id).sort(), ["cardiology", "critical_care"]);
  assert.ok(invitation.devInviteUrl.includes("#token="));

  // Stored in A's own database; the login email points at hospital A.
  const row = (await dbA.query("SELECT password_hash FROM users WHERE id = $1", [user.id])).rows[0];
  const entry = (await pool.query("SELECT organization_id FROM user_directory WHERE user_id = $1", [user.id])).rows[0];
  assert.equal(entry.organization_id, a.organization.id);
  assert.equal((await (await tenantDb(b.organization.id)).query("SELECT 1 FROM users WHERE id = $1", [user.id])).rows.length, 0);
  assert.equal(row.password_hash, null);
  const stored = (await pool.query("SELECT token_hash FROM user_invitations WHERE user_id = $1", [user.id])).rows[0];
  assert.notEqual(stored.token_hash, tokenFrom(invitation.devInviteUrl)); // only the hash is stored
});

test("operator invitation creates an OPERATOR and drops doctor-only fields", async () => {
  const res = await invite(a, operatorBody({ specialization: "Ignored", licenseNumber: "X-1" }));
  assert.equal(res.status, 201);
  assert.equal(res.body.data.user.role, "OPERATOR");
  assert.equal(res.body.data.user.specialization, null);
  assert.equal(res.body.data.user.licenseNumber, null);
});

test("invitations validate input and can't create Superadmins", async () => {
  const superadmin = await invite(a, doctorBody({ role: "SUPERADMIN" }));
  assert.equal(superadmin.status, 400);
  assert.ok(superadmin.body.errors.role);

  const invalid = await invite(a, { role: "DOCTOR", fullName: "", email: "bad", departmentIds: [] });
  assert.equal(invalid.status, 400);
  for (const field of ["fullName", "email", "specialization", "departmentIds"]) {
    assert.ok(invalid.body.errors[field], `${field} error`);
  }

  const unknownDept = await invite(a, operatorBody({ departmentIds: ["no_such_department"] }));
  assert.equal(unknownDept.status, 400);

  const existing = await invite(a, operatorBody({ email: b.email })); // emails are unique application-wide
  assert.equal(existing.status, 409);
});

test("duplicate license number in the same hospital is rejected", async () => {
  const licenseNumber = `DUP-${Date.now()}`;
  assert.equal((await invite(a, doctorBody({ licenseNumber }))).status, 201);
  const dup = await invite(a, doctorBody({ licenseNumber: licenseNumber.toLowerCase() }));
  assert.equal(dup.status, 409);
  assert.ok(dup.body.errors.licenseNumber);
  assert.equal((await invite(b, doctorBody({ licenseNumber }))).status, 201); // other hospital: allowed
});

test("invitation token is single-use and lets the user log in", async () => {
  const body = operatorBody();
  const res = await invite(a, body);
  const token = tokenFrom(res.body.data.invitation.devInviteUrl);

  // Can't log in before accepting.
  assert.equal((await api("/auth/login", { method: "POST", body: { email: body.email, password: PASSWORD } })).status, 401);

  const verify = await api("/auth/invitations/verify", { method: "POST", body: { token } });
  assert.equal(verify.status, 200);
  assert.equal(verify.body.data.organizationName, "Users Tenant A");

  const mismatch = await api("/auth/invitations/accept", {
    method: "POST",
    body: { token, password: PASSWORD, confirmPassword: "Different1" },
  });
  assert.equal(mismatch.status, 400);

  const accept = await api("/auth/invitations/accept", {
    method: "POST",
    body: { token, password: PASSWORD, confirmPassword: PASSWORD },
  });
  assert.equal(accept.status, 200);
  const again = await api("/auth/invitations/accept", {
    method: "POST",
    body: { token, password: "Another123", confirmPassword: "Another123" },
  });
  assert.equal(again.status, 410);

  const login = await api("/auth/login", { method: "POST", body: { email: body.email, password: PASSWORD } });
  assert.equal(login.status, 200);
  assert.equal(login.body.data.user.role, "OPERATOR");
  assert.equal(login.body.data.organization.id, a.organization.id);
});

test("expired and superseded invitation tokens are rejected", async () => {
  const res = await invite(a, operatorBody());
  const user = res.body.data.user;
  const firstToken = tokenFrom(res.body.data.invitation.devInviteUrl);

  const resent = await api(`/users/${user.id}/resend-invitation`, { method: "POST", cookie: a.cookie });
  assert.equal(resent.status, 200);
  const secondToken = tokenFrom(resent.body.data.invitation.devInviteUrl);
  assert.equal((await api("/auth/invitations/verify", { method: "POST", body: { token: firstToken } })).status, 410);

  await pool.query("UPDATE user_invitations SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id = $1", [user.id]);
  const expired = await api("/auth/invitations/accept", {
    method: "POST",
    body: { token: secondToken, password: PASSWORD, confirmPassword: PASSWORD },
  });
  assert.equal(expired.status, 410);

  const listed = await api(`/users/${user.id}`, { cookie: a.cookie });
  assert.equal(listed.body.data.invitation.status, "EXPIRED");
});

test("list supports role, status, department, search and pagination", async () => {
  const tag = `Searchable ${Date.now()}`;
  await invite(a, doctorBody({ fullName: `${tag} One`, departmentIds: ["neurology"] }));
  await invite(a, doctorBody({ fullName: `${tag} Two`, departmentIds: ["geriatrics"] }));
  await invite(a, operatorBody({ fullName: `${tag} Three`, departmentIds: ["neurology"] }));

  const q = encodeURIComponent(tag);
  const doctors = await api(`/users?role=DOCTOR&search=${q}`, { cookie: a.cookie });
  assert.equal(doctors.body.data.total, 2);
  assert.ok(doctors.body.data.items.every((u) => u.role === "DOCTOR"));

  const neuro = await api(`/users?search=${q}&department=neurology`, { cookie: a.cookie });
  assert.equal(neuro.body.data.total, 2);

  const paged = await api(`/users?search=${q}&pageSize=2&page=2&sort=name`, { cookie: a.cookie });
  assert.equal(paged.body.data.total, 3);
  assert.equal(paged.body.data.items.length, 1);

  const invited = await api(`/users?search=${q}&status=INVITED`, { cookie: a.cookie });
  assert.equal(invited.body.data.total, 3);

  assert.equal((await api("/users?role=NURSE", { cookie: a.cookie })).status, 400);
  // The full list includes the hospital's Superadmin (listed, but not manageable by id).
  const all = await api("/users?pageSize=100", { cookie: a.cookie });
  assert.ok(all.body.data.items.some((u) => u.role === "SUPERADMIN" && u.id === a.user.id));
  const admins = await api("/users?role=SUPERADMIN", { cookie: a.cookie });
  assert.deepEqual(admins.body.data.items.map((u) => u.id), [a.user.id]);
});

test("update edits profile and departments, but not role, email or organization", async () => {
  const { user } = (await invite(a, doctorBody())).body.data;
  const res = await api(`/users/${user.id}`, {
    method: "PATCH",
    cookie: a.cookie,
    body: { fullName: "Dr. Updated", departmentIds: ["pulmonology"] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.fullName, "Dr. Updated");
  assert.deepEqual(res.body.data.departments.map((d) => d.id), ["pulmonology"]);
  assert.equal(res.body.data.specialization, "Cardiology"); // untouched fields kept

  for (const body of [{ role: "SUPERADMIN" }, { email: "x@example.test" }, { organizationId: b.organization.id }]) {
    assert.equal((await api(`/users/${user.id}`, { method: "PATCH", cookie: a.cookie, body })).status, 400);
  }
});

test("deactivating blocks login and ends sessions; reactivating restores access", async () => {
  const body = operatorBody();
  const { user, cookie } = await inviteAndActivate(a, body);
  assert.equal((await api("/auth/me", { cookie })).status, 200);

  const off = await api(`/users/${user.id}/status`, { method: "PATCH", cookie: a.cookie, body: { status: "DISABLED" } });
  assert.equal(off.status, 200);
  assert.equal(off.body.data.status, "DISABLED");
  assert.equal((await api("/auth/me", { cookie })).status, 401);
  assert.equal((await api("/auth/login", { method: "POST", body: { email: body.email, password: PASSWORD } })).status, 403);

  const on = await api(`/users/${user.id}/status`, { method: "PATCH", cookie: a.cookie, body: { status: "ACTIVE" } });
  assert.equal(on.body.data.status, "ACTIVE");
  assert.equal((await api("/auth/login", { method: "POST", body: { email: body.email, password: PASSWORD } })).status, 200);

  const bad = await api(`/users/${user.id}/status`, { method: "PATCH", cookie: a.cookie, body: { status: "INVITED" } });
  assert.equal(bad.status, 400);
});

test("reactivating a user who never accepted returns them to INVITED", async () => {
  const { user, invitation } = (await invite(a, operatorBody())).body.data;
  await api(`/users/${user.id}/status`, { method: "PATCH", cookie: a.cookie, body: { status: "DISABLED" } });
  // The pending invitation was cancelled by the deactivation.
  const token = tokenFrom(invitation.devInviteUrl);
  assert.equal((await api("/auth/invitations/verify", { method: "POST", body: { token } })).status, 410);
  const on = await api(`/users/${user.id}/status`, { method: "PATCH", cookie: a.cookie, body: { status: "ACTIVE" } });
  assert.equal(on.body.data.status, "INVITED");
});

test("cross-tenant requests by id are rejected with 404", async () => {
  const { user } = (await invite(a, operatorBody())).body.data;
  const asB = { cookie: b.cookie };
  assert.equal((await api(`/users/${user.id}`, asB)).status, 404);
  assert.equal((await api(`/users/${user.id}`, { ...asB, method: "PATCH", body: { fullName: "Hijack" } })).status, 404);
  assert.equal(
    (await api(`/users/${user.id}/status`, { ...asB, method: "PATCH", body: { status: "DISABLED" } })).status,
    404
  );
  assert.equal((await api(`/users/${user.id}/resend-invitation`, { ...asB, method: "POST" })).status, 404);
  assert.equal((await api("/users/not-a-uuid", asB)).status, 404);

  const listB = await api("/users?pageSize=100", asB);
  assert.ok(listB.body.data.items.every((u) => u.id !== user.id));

  // Superadmins themselves aren't manageable through these endpoints.
  assert.equal((await api(`/users/${b.user.id}`, asB)).status, 404);
  assert.equal((await api(`/users/${a.user.id}`, { cookie: a.cookie })).status, 404);
});

test("Doctors and Operators can't use administrative APIs or escalate", async () => {
  const doctor = await inviteAndActivate(a, doctorBody());
  const asDoctor = { cookie: doctor.cookie };
  assert.equal((await api("/users", asDoctor)).status, 403);
  assert.equal((await api("/audit-logs", asDoctor)).status, 403);
  assert.equal((await invite(doctor, doctorBody({ role: "SUPERADMIN" }))).status, 403);
  assert.equal(
    (await api(`/users/${doctor.user.id}`, { ...asDoctor, method: "PATCH", body: { role: "SUPERADMIN" } })).status,
    403
  );
  const me = await api("/auth/me", asDoctor);
  assert.equal(me.body.data.user.role, "DOCTOR");

  assert.equal((await api("/users")).status, 401);
});

test("administrative changes are audited per organization without secrets", async () => {
  const { user } = (await invite(a, operatorBody())).body.data;
  await api(`/users/${user.id}`, { method: "PATCH", cookie: a.cookie, body: { fullName: "Audited Name" } });
  await api(`/users/${user.id}/status`, { method: "PATCH", cookie: a.cookie, body: { status: "DISABLED" } });

  const logs = await api(`/audit-logs?entityType=user&entityId=${user.id}`, { cookie: a.cookie });
  assert.equal(logs.status, 200);
  assert.deepEqual(
    logs.body.data.items.map((l) => l.action).reverse(),
    ["user.invited", "user.updated", "user.deactivated"]
  );
  assert.equal(logs.body.data.items[0].actor.id, a.user.id);
  const text = JSON.stringify(logs.body);
  assert.equal(/token|password/i.test(text), false);

  const fromB = await api(`/audit-logs?entityId=${user.id}`, { cookie: b.cookie });
  assert.equal(fromB.body.data.total, 0);
});

test("invited doctors appear in the Doctors directory and stay in sync", async () => {
  const { user } = (await invite(a, doctorBody({ departmentIds: ["neurology", "cardiology"] }))).body.data;
  assert.match(user.doctorId, /^D-\d{3,}$/);

  const doctor = (await api(`/doctors/${user.doctorId}`, { cookie: a.cookie })).body.data;
  assert.equal(doctor.name, user.fullName);
  assert.equal(doctor.email, user.email);
  assert.equal(doctor.departmentId, "neurology"); // first selected department
  assert.equal(doctor.status, "active");
  assert.equal(doctor.hasAccount, true);

  // Profile and department changes in User Management flow into the directory.
  await api(`/users/${user.id}`, {
    method: "PATCH",
    cookie: a.cookie,
    body: { fullName: "Dr. Synced", departmentIds: ["pulmonology"] },
  });
  const updated = (await api(`/doctors/${user.doctorId}`, { cookie: a.cookie })).body.data;
  assert.equal(updated.name, "Dr. Synced");
  assert.equal(updated.departmentId, "pulmonology");

  await api(`/users/${user.id}/status`, { method: "PATCH", cookie: a.cookie, body: { status: "DISABLED" } });
  assert.equal((await api(`/doctors/${user.doctorId}`, { cookie: a.cookie })).body.data.status, "inactive");
  await api(`/users/${user.id}/status`, { method: "PATCH", cookie: a.cookie, body: { status: "ACTIVE" } });
  assert.equal((await api(`/doctors/${user.doctorId}`, { cookie: a.cookie })).body.data.status, "active");

  // The Doctors API can't edit or delete an account-linked doctor (it would drift from the account).
  const put = await api(`/doctors/${user.doctorId}`, {
    method: "PUT",
    cookie: a.cookie,
    body: { name: "Other", departmentId: "cardiology", status: "active" },
  });
  assert.equal(put.status, 409);
  assert.equal((await api(`/doctors/${user.doctorId}`, { method: "DELETE", cookie: a.cookie })).status, 409);
});

test("inviting an existing directory doctor's email links that doctor instead of duplicating", async () => {
  const email = uniqueEmail("directory");
  const id = `D-${900000 + Math.floor(Math.random() * 99999)}`;
  await api("/doctors", { method: "POST", cookie: a.cookie, body: { id, name: "Old Entry", departmentId: "geriatrics", email } });
  try {
    const { user } = (await invite(a, doctorBody({ email, fullName: "Dr. Linked", departmentIds: ["geriatrics"] })))
      .body.data;
    assert.equal(user.doctorId, id);
    const doctor = (await api(`/doctors/${id}`, { cookie: a.cookie })).body.data;
    assert.equal(doctor.name, "Dr. Linked");
    assert.equal(doctor.hasAccount, true);
  } finally {
    await dbA.query("DELETE FROM doctors WHERE id = $1 AND user_id IS NULL", [id]);
  }
});

test("operators are not added to the Doctors directory", async () => {
  const { user } = (await invite(a, operatorBody())).body.data;
  assert.equal(user.doctorId, null);
  const rows = await dbA.query("SELECT 1 FROM doctors WHERE user_id = $1", [user.id]);
  assert.equal(rows.rows.length, 0);
});

test("an existing Doctors-list entry can be given a login account (no duplicate)", async () => {
  const id = `D-${800000 + Math.floor(Math.random() * 99999)}`;
  await api("/doctors", { method: "POST", cookie: a.cookie, body: { id, name: "Legacy Doctor", departmentId: "cardiology" } });
  try {
    const res = await invite(a, doctorBody({ doctorId: id, fullName: "Dr. Legacy", departmentIds: ["cardiology"] }));
    assert.equal(res.status, 201);
    assert.equal(res.body.data.user.doctorId, id);
    const doctor = (await api(`/doctors/${id}`, { cookie: a.cookie })).body.data;
    assert.equal(doctor.name, "Dr. Legacy");
    assert.equal(doctor.userId, res.body.data.user.id);

    // Already linked → can't be linked again.
    assert.equal((await invite(a, doctorBody({ doctorId: id }))).status, 409);
  } finally {
    await dbA.query("DELETE FROM doctors WHERE id = $1 AND user_id IS NULL", [id]);
  }
});

test("Superadmin can delete accounts; doctors with patients are protected", async () => {
  const operator = (await invite(a, operatorBody())).body.data.user;
  assert.equal((await api(`/users/${operator.id}`, { method: "DELETE", cookie: b.cookie })).status, 404); // other tenant
  assert.equal((await api(`/users/${operator.id}`, { method: "DELETE", cookie: a.cookie })).status, 200);
  assert.equal((await api(`/users/${operator.id}`, { cookie: a.cookie })).status, 404);

  const doctor = (await invite(a, doctorBody())).body.data.user;
  const patientId = `P-${900000 + Math.floor(Math.random() * 99999)}`;
  await dbA.query("INSERT INTO patients (id, name, room, bed, doctor_id) VALUES ($1, 'Test Patient', '1', 'A', $2)", [
    patientId,
    doctor.doctorId,
  ]);
  try {
    const blocked = await api(`/users/${doctor.id}`, { method: "DELETE", cookie: a.cookie });
    assert.equal(blocked.status, 409);
  } finally {
    await dbA.query("DELETE FROM patients WHERE id = $1", [patientId]);
  }
  assert.equal((await api(`/users/${doctor.id}`, { method: "DELETE", cookie: a.cookie })).status, 200);
  assert.equal((await api(`/doctors/${doctor.doctorId}`, { cookie: a.cookie })).status, 404); // directory entry removed too

  const logs = await api(`/audit-logs?entityId=${doctor.id}`, { cookie: a.cookie });
  assert.equal(logs.body.data.items[0].action, "user.deleted");
});

test("deleting a doctor with patients moves them to the chosen doctor", async () => {
  const from = (await invite(a, doctorBody())).body.data.user;
  const to = (await invite(a, doctorBody())).body.data.user;
  const legacyId = `D-${600000 + Math.floor(Math.random() * 99999)}`;
  await api("/doctors", { method: "POST", cookie: a.cookie, body: { id: legacyId, name: "Legacy With Patients", departmentId: "cardiology" } });
  const p1 = `P-${900000 + Math.floor(Math.random() * 49999)}`;
  const p2 = `P-${950000 + Math.floor(Math.random() * 49999)}`;
  await dbA.query("INSERT INTO patients (id, name, room, bed, doctor_id) VALUES ($1, 'T1', '1', 'A', $2), ($3, 'T2', '1', 'B', $4)", [
    p1,
    from.doctorId,
    p2,
    legacyId,
  ]);
  try {
    // Account doctor: needs a valid, different, active target.
    assert.equal((await api(`/users/${from.id}`, { method: "DELETE", cookie: a.cookie })).status, 409);
    assert.equal(
      (await api(`/users/${from.id}?reassignTo=${from.doctorId}`, { method: "DELETE", cookie: a.cookie })).status,
      400
    );
    assert.equal(
      (await api(`/users/${from.id}?reassignTo=${to.doctorId}`, { method: "DELETE", cookie: a.cookie })).status,
      200
    );
    const moved = await dbA.query("SELECT doctor_id FROM patients WHERE id = $1", [p1]);
    assert.equal(moved.rows[0].doctor_id, to.doctorId);

    // Directory doctor without an account, through the Doctors API.
    assert.equal((await api(`/doctors/${legacyId}`, { method: "DELETE", cookie: a.cookie })).status, 409);
    assert.equal((await api(`/doctors/${legacyId}?reassignTo=${to.doctorId}`, { method: "DELETE", cookie: a.cookie })).status, 200);
    const moved2 = await dbA.query("SELECT doctor_id FROM patients WHERE id = $1", [p2]);
    assert.equal(moved2.rows[0].doctor_id, to.doctorId);
  } finally {
    await dbA.query("DELETE FROM patients WHERE id = ANY($1)", [[p1, p2]]);
    await dbA.query("DELETE FROM doctors WHERE id = $1", [legacyId]);
  }
});
