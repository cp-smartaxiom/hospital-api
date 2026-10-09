// Phase 1: signup, login, session, tenant isolation.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const pg = require("pg");
const {
  start,
  api,
  cleanup,
  createTenant,
  trackOrganization,
  uniqueEmail,
  dbNameOf,
  tenantDb,
  pool,
  PASSWORD,
} = require("./helpers");

const databaseExists = async (name) =>
  (await pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rows.length > 0;

before(start);
after(cleanup);

const signupBody = (overrides = {}) => ({
  fullName: "Asha Rao",
  email: uniqueEmail("signup"),
  organizationName: "City General Hospital",
  password: PASSWORD,
  confirmPassword: PASSWORD,
  ...overrides,
});

test("signup creates the organization and its first SUPERADMIN with a hashed password", async () => {
  const body = signupBody({ role: "DOCTOR", organizationId: "00000000-0000-0000-0000-000000000000" });
  const res = await api("/auth/signup", { method: "POST", body });
  assert.equal(res.status, 201);
  trackOrganization(res.body.data.organization.id);

  const { user, organization } = res.body.data;
  assert.equal(user.role, "SUPERADMIN"); // body role/organizationId are ignored
  assert.equal(user.email, body.email);
  assert.equal(organization.slug.startsWith("city-general-hospital"), true);
  assert.equal(JSON.stringify(res.body).includes("password"), false);

  // The hospital got its own database, named after its slug, with the Superadmin inside it.
  const dbName = await dbNameOf(organization.id);
  assert.equal(dbName, `hms_${organization.slug.replace(/-/g, "_")}`);
  assert.ok(await databaseExists(dbName));
  const row = (await (await tenantDb(organization.id)).query("SELECT role, password_hash FROM users WHERE id = $1", [user.id]))
    .rows[0];
  assert.equal(row.role, "SUPERADMIN");
  const entry = (await pool.query("SELECT organization_id FROM user_directory WHERE email = $1", [body.email])).rows[0];
  assert.equal(entry.organization_id, organization.id);
  assert.notEqual(row.password_hash, PASSWORD);
  assert.equal(await bcrypt.compare(PASSWORD, row.password_hash), true);
});

test("signup rejects invalid input, password mismatch and duplicate email", async () => {
  const invalid = await api("/auth/signup", {
    method: "POST",
    body: { fullName: "A", email: "not-an-email", organizationName: "", password: "short", confirmPassword: "x" },
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(Object.keys(invalid.body.errors).sort(), [
    "confirmPassword",
    "email",
    "fullName",
    "organizationName",
    "password",
  ]);

  const mismatch = await api("/auth/signup", { method: "POST", body: signupBody({ confirmPassword: "Other1234" }) });
  assert.equal(mismatch.status, 400);
  assert.ok(mismatch.body.errors.confirmPassword);

  const first = signupBody();
  const ok = await api("/auth/signup", { method: "POST", body: first });
  trackOrganization(ok.body.data.organization.id);
  const dup = await api("/auth/signup", {
    method: "POST",
    body: signupBody({ email: first.email.toUpperCase(), organizationName: "Another" }),
  });
  assert.equal(dup.status, 409);
});

test("same organization name gets a unique slug", async () => {
  const a = await api("/auth/signup", { method: "POST", body: signupBody({ organizationName: "Slug Test Clinic" }) });
  const b = await api("/auth/signup", { method: "POST", body: signupBody({ organizationName: "Slug Test Clinic" }) });
  trackOrganization(a.body.data.organization.id);
  trackOrganization(b.body.data.organization.id);
  assert.notEqual(a.body.data.organization.slug, b.body.data.organization.slug);
});

test("a failed signup removes the new database and the organization", async () => {
  // Fail the Superadmin insert, which happens after the hospital database was created.
  const body = signupBody({ organizationName: `Rollback ${crypto.randomUUID().slice(0, 8)}` });
  const originalQuery = pg.Pool.prototype.query;
  pg.Pool.prototype.query = function (text, ...rest) {
    if (typeof text === "string" && text.includes("INSERT INTO users (id, full_name, email, password_hash, role)")) {
      pg.Pool.prototype.query = originalQuery;
      return Promise.reject(new Error("simulated failure"));
    }
    return originalQuery.call(this, text, ...rest);
  };

  const res = await api("/auth/signup", { method: "POST", body });
  pg.Pool.prototype.query = originalQuery;
  assert.equal(res.status, 500);
  const orgs = await pool.query("SELECT COUNT(*)::int AS n FROM organizations WHERE name = $1", [body.organizationName]);
  assert.equal(orgs.rows[0].n, 0, "organization must be removed");
  const login = await pool.query("SELECT 1 FROM user_directory WHERE email = $1", [body.email]);
  assert.equal(login.rows.length, 0, "email must be free again");
  const slug = body.organizationName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  assert.equal(await databaseExists(`hms_${slug}`), false, "database must be dropped");
});

test("a signup never drops a database it didn't create", async () => {
  const name = `Existing Db ${crypto.randomUUID().slice(0, 8)}`;
  const dbName = `hms_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
  await pool.query(`CREATE DATABASE "${dbName}"`);
  try {
    const res = await api("/auth/signup", { method: "POST", body: signupBody({ organizationName: name }) });
    assert.equal(res.status, 500);
    assert.ok(await databaseExists(dbName), "pre-existing database is kept");
  } finally {
    await pool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  }
});

test("login, /me, wrong password, logout and session invalidation", async () => {
  const tenant = await createTenant("Login Test Hospital");
  assert.ok(tenant.cookie);

  const wrong = await api("/auth/login", { method: "POST", body: { email: tenant.email, password: "Wrong1234" } });
  assert.equal(wrong.status, 401);
  const unknown = await api("/auth/login", { method: "POST", body: { email: uniqueEmail("nobody"), password: PASSWORD } });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.message, wrong.body.message); // doesn't reveal whether the email exists

  const me = await api("/auth/me", { cookie: tenant.cookie });
  assert.equal(me.status, 200);
  assert.equal(me.body.data.organization.id, tenant.organization.id);
  assert.equal(me.body.data.user.role, "SUPERADMIN");

  assert.equal((await api("/auth/me")).status, 401);

  await api("/auth/logout", { method: "POST", cookie: tenant.cookie });
  assert.equal((await api("/auth/me", { cookie: tenant.cookie })).status, 401);
});

test("inactive user or organization can't log in", async () => {
  const tenant = await createTenant("Inactive Test Hospital");
  await pool.query("UPDATE organizations SET status = 'SUSPENDED' WHERE id = $1", [tenant.organization.id]);
  const res = await api("/auth/login", { method: "POST", body: { email: tenant.email, password: PASSWORD } });
  assert.equal(res.status, 403);
  // Existing sessions stop working too.
  assert.equal((await api("/auth/me", { cookie: tenant.cookie })).status, 401);
});

test("each hospital has its own database: own users, patients, doctors and devices", async () => {
  const a = await createTenant("Tenant A Hospital");
  const b = await createTenant("Tenant B Hospital");
  const meA = await api("/auth/me", { cookie: a.cookie });
  const meB = await api("/auth/me", { cookie: b.cookie });
  assert.equal(meA.body.data.organization.name, "Tenant A Hospital");
  assert.equal(meB.body.data.organization.name, "Tenant B Hospital");
  assert.notEqual(await dbNameOf(a.organization.id), await dbNameOf(b.organization.id));

  // A new hospital starts empty (only the reference departments).
  for (const path of ["/doctors", "/patients", "/devices", "/events"]) {
    const res = await api(path, { cookie: b.cookie });
    assert.equal(res.status, 200, path);
    assert.deepEqual(res.body.data, [], `${path} empty for a new hospital`);
  }
  assert.equal((await api("/departments", { cookie: b.cookie })).body.data.length, 5);

  // Data created in A never shows up in B — even with the same ids.
  const doctor = { id: "D-001", name: "Dr. A", departmentId: "cardiology" };
  assert.equal((await api("/doctors", { method: "POST", cookie: a.cookie, body: doctor })).status, 201);
  const patient = { id: "P-001", name: "Patient A", room: "1", bed: "A", doctorId: "D-001" };
  assert.equal((await api("/patients", { method: "POST", cookie: a.cookie, body: patient })).status, 201);
  assert.deepEqual((await api("/patients", { cookie: b.cookie })).body.data, []);
  assert.equal((await api("/patients/P-001", { cookie: b.cookie })).status, 404);
  // B can use the same ids in its own database.
  assert.equal((await api("/doctors", { method: "POST", cookie: b.cookie, body: { ...doctor, name: "Dr. B" } })).status, 201);
  assert.equal((await api("/doctors/D-001", { cookie: a.cookie })).body.data.name, "Dr. A");
  assert.equal((await api("/doctors/D-001", { cookie: b.cookie })).body.data.name, "Dr. B");
});

test("device ids are registered to one hospital (MQTT routing)", async () => {
  const a = await createTenant("Device A Hospital");
  const b = await createTenant("Device B Hospital");
  const deviceId = `QS${crypto.randomUUID().slice(0, 8)}`;
  const device = { device_id: deviceId, device_type: "qstat", name: "QStat A" };
  assert.equal((await api("/devices", { method: "POST", cookie: a.cookie, body: device })).status, 201);
  assert.equal((await api("/devices", { method: "POST", cookie: b.cookie, body: device })).status, 409);
  const reg = await pool.query("SELECT organization_id FROM device_registry WHERE device_id = $1", [deviceId]);
  assert.equal(reg.rows[0].organization_id, a.organization.id);

  // An MQTT message for that device lands in A's database only.
  const { handleMqttMessage } = require("../src/config/controller/event.controller");
  handleMqttMessage(`sa/qstat/${deviceId}/monitoring/vitals`, Buffer.from(JSON.stringify({ pr: 72, rr: 16 })));
  let events = [];
  for (let i = 0; i < 40 && events.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
    events = (await api(`/events?deviceId=${deviceId}`, { cookie: a.cookie })).body.data;
  }
  assert.equal(events.length, 1);
  assert.equal((await api(`/events?deviceId=${deviceId}`, { cookie: b.cookie })).body.data.length, 0);

  // Deleting the device frees the id.
  assert.equal((await api(`/devices/${deviceId}`, { method: "DELETE", cookie: a.cookie })).status, 200);
  assert.equal((await api("/devices", { method: "POST", cookie: b.cookie, body: device })).status, 201);
});

test("existing data and migrations are intact", async () => {
  const applied = (await pool.query("SELECT name FROM schema_migrations ORDER BY name")).rows.map((r) => r.name);
  for (const name of [
    "004_events.sql",
    "005_organizations_and_users.sql",
    "006_user_management.sql",
    "007_link_doctor_accounts.sql",
  ]) {
    assert.ok(applied.includes(name), `${name} applied`);
  }
  assert.ok(applied.includes("008_database_per_hospital.sql"));

  // Hospital APIs now need a session (it selects the hospital database).
  assert.equal((await api("/doctors")).status, 401);
  const tenant = await createTenant("Migrations Hospital");
  const doctors = await api("/doctors", { cookie: tenant.cookie });
  assert.equal(doctors.status, 200);
  const tenantApplied = (await (await tenantDb(tenant.organization.id)).query("SELECT name FROM schema_migrations"))
    .rows.map((r) => r.name);
  assert.ok(tenantApplied.includes("001_initial_schema.sql"));
});

