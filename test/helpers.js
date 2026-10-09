/*
 * Test helpers: starts the Express app on a random port and talks to it with fetch.
 * Tests run against the central database in .env (DB_NAME can be overridden for a separate test DB).
 * Every organization a test creates gets its own hms_<slug> database (that's what signup does);
 * cleanup() drops those databases and deletes the central rows, so existing data is never touched.
 */
process.env.NODE_ENV = "test"; // disables rate limits and dev email logging
delete process.env.SMTP_HOST; // invitations return devInviteUrl instead of sending email
delete process.env.MQTT_DEFAULT_ORGANIZATION; // unregistered MQTT devices are skipped in tests

const crypto = require("crypto");
const app = require("../src/app");
const pool = require("../src/config/database"); // central registry
const { getTenantPool, closeAllTenantPools } = require("../src/config/tenant-pool");
const { dropTenantDatabase } = require("../src/database/tenants");

const PASSWORD = "Passw0rd1";
const createdOrganizations = new Set();
let server;
let baseUrl;

const start = () =>
  new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}/api`;
      resolve();
    });
  });

/** fetch wrapper: returns { status, body, cookie } (cookie = "hms_session=…" when set). */
const api = async (path, { method = "GET", body, cookie } = {}) => {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { ...(body && { "Content-Type": "application/json" }), ...(cookie && { Cookie: cookie }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  return {
    status: res.status,
    body: await res.json().catch(() => null),
    cookie: setCookie ? setCookie.split(";")[0] : undefined,
  };
};

const uniqueEmail = (prefix) => `${prefix}-${crypto.randomUUID().slice(0, 8)}@example.test`;

/** Signs up a new organization and logs its Superadmin in. */
const createTenant = async (name = "Test Hospital") => {
  const email = uniqueEmail("admin");
  const signup = await api("/auth/signup", {
    method: "POST",
    body: { fullName: "Test Admin", email, organizationName: name, password: PASSWORD, confirmPassword: PASSWORD },
  });
  if (signup.status !== 201) throw new Error(`signup failed: ${JSON.stringify(signup.body)}`);
  createdOrganizations.add(signup.body.data.organization.id);
  const login = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD } });
  return { email, cookie: login.cookie, user: signup.body.data.user, organization: signup.body.data.organization };
};

const trackOrganization = (id) => createdOrganizations.add(id);

/** The hospital database name / pool of an organization. */
const dbNameOf = async (organizationId) =>
  (await pool.query("SELECT db_name FROM organizations WHERE id = $1", [organizationId])).rows[0]?.db_name ?? null;
const tenantDb = async (organizationId) => getTenantPool(await dbNameOf(organizationId));

/** Token from a devInviteUrl (…/accept-invite#token=…). */
const tokenFrom = (url) => new URL(url).hash.replace(/^#token=/, "");

const cleanup = async () => {
  const ids = [...createdOrganizations];
  if (ids.length > 0) {
    const dbs = (await pool.query("SELECT db_name FROM organizations WHERE id = ANY($1) AND db_name IS NOT NULL", [ids]))
      .rows;
    for (const { db_name: dbName } of dbs) await dropTenantDatabase(dbName);
    // Directory entries, sessions, invitations and device registrations cascade with the organization.
    await pool.query("DELETE FROM organizations WHERE id = ANY($1)", [ids]);
  }
  await new Promise((resolve) => server.close(resolve));
  await closeAllTenantPools();
  await pool.end();
};

module.exports = {
  start,
  api,
  cleanup,
  createTenant,
  trackOrganization,
  uniqueEmail,
  tokenFrom,
  dbNameOf,
  tenantDb,
  pool,
  PASSWORD,
};
