const crypto = require("crypto");
const centralPool = require("../database");
const bcrypt = require("bcryptjs");
const { createSession, destroySession } = require("../auth/session");
const { getTenantPool } = require("../tenant-pool");
const { dbNameForSlug, createDatabase, migrateTenantDatabase, dropTenantDatabase } = require("../../database/tenants");

/*
 * Auth API.
 *   POST /auth/signup   create an organization with its own database (hms_<slug>) and its first
 *                       user (SUPERADMIN) in that database; undone completely if any step fails
 *   POST /auth/login    verify credentials, start a cookie session
 *   POST /auth/logout   revoke the session
 *   GET  /auth/me       current user + organization (requires session)
 * Responses follow { success, message?, data }. Passwords and hashes are never returned or logged.
 */

const BCRYPT_ROUNDS = 12;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// At least 8 chars with a letter and a digit.
const PASSWORD = /^(?=.*[A-Za-z])(?=.*\d).{8,128}$/;
// Compared against when the email doesn't exist, so response time doesn't reveal registered emails.
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", BCRYPT_ROUNDS);

const fail = (res, status, message, errors) =>
  res.status(status).json({ success: false, message, ...(errors && { errors }) });

const str = (value) => (typeof value === "string" ? value.trim() : "");
const normalizeEmail = (value) => str(value).toLowerCase();

/** "St. Mary's Hospital" → "st-marys-hospital" */
const slugify = (name) =>
  name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) // leaves room for "hms_" and a "-NN" suffix within Postgres' 63-char names
    .replace(/-+$/g, "") || "org";

const toUser = (row) => ({
  id: row.id,
  fullName: row.full_name,
  email: row.email,
  role: row.role,
  status: row.status,
});

const toOrganization = (row) => ({
  id: row.organization_id,
  name: row.organization_name,
  slug: row.organization_slug,
  status: row.organization_status,
});

const SELECT_USER = `
  SELECT id, full_name, email, password_hash, role, status FROM users
`;

/** Central registry row → API organization. */
const organizationOf = (org) => ({ id: org.id, name: org.name, slug: org.slug, status: org.status });

const DUPLICATE_EMAIL = "An account with this email already exists.";

const validateSignup = (body) => {
  const input = {
    fullName: str(body?.fullName),
    email: normalizeEmail(body?.email),
    organizationName: str(body?.organizationName).replace(/\s+/g, " "),
    password: typeof body?.password === "string" ? body.password : "",
    confirmPassword: typeof body?.confirmPassword === "string" ? body.confirmPassword : "",
  };
  const errors = {};

  if (input.fullName.length < 2 || input.fullName.length > 100) {
    errors.fullName = "Full name must be 2–100 characters.";
  }
  if (!EMAIL.test(input.email) || input.email.length > 254) {
    errors.email = "Enter a valid email address.";
  }
  if (input.organizationName.length < 2 || input.organizationName.length > 150) {
    errors.organizationName = "Organization name must be 2–150 characters.";
  } else if (!/[A-Za-z0-9]/.test(input.organizationName)) {
    errors.organizationName = "Organization name must contain letters or numbers.";
  }
  if (!PASSWORD.test(input.password)) {
    errors.password = "Password must be 8–128 characters and include a letter and a number.";
  }
  if (input.password !== input.confirmPassword) {
    errors.confirmPassword = "Passwords do not match.";
  }

  return { input, errors };
};

/** Registers the organization (PROVISIONING) with a unique slug (base, base-2, …) and its database name. */
const insertOrganization = async (client, name) => {
  const base = slugify(name);
  for (let n = 1; n <= 50; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const result = await client.query(
      `INSERT INTO organizations (name, slug, db_name, status) VALUES ($1, $2, $3, 'PROVISIONING')
       ON CONFLICT DO NOTHING
       RETURNING id, name, slug, db_name`,
      [name, slug, dbNameForSlug(slug)]
    );
    if (result.rows.length > 0) return result.rows[0];
  }
  throw new Error("Could not generate a unique organization slug");
};

/**
 * Signup = provision a new hospital:
 *   1. central: organization (PROVISIONING) + login email, in one transaction
 *   2. CREATE DATABASE hms_<slug> and create all its tables
 *   3. the Superadmin user inside that database
 *   4. organization → ACTIVE
 * CREATE DATABASE can't be part of a transaction, so a failure after step 1 is undone by hand:
 * the database is dropped and the central rows are deleted.
 */
const signup = async (req, res) => {
  const { input, errors } = validateSignup(req.body);
  if (Object.keys(errors).length > 0) {
    return fail(res, 400, "Please correct the highlighted fields.", errors);
  }

  try {
    const existing = await centralPool.query("SELECT 1 FROM user_directory WHERE email = $1", [input.email]);
    if (existing.rows.length > 0) {
      return fail(res, 409, DUPLICATE_EMAIL, { email: DUPLICATE_EMAIL });
    }
  } catch (error) {
    console.error("Signup failed:", error.message);
    return fail(res, 500, "Could not create the account. Please try again.");
  }
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const userId = crypto.randomUUID();

  // 1. Central registry
  let organization;
  const client = await centralPool.connect();
  try {
    await client.query("BEGIN");
    organization = await insertOrganization(client, input.organizationName);
    await client.query("INSERT INTO user_directory (email, user_id, organization_id) VALUES ($1, $2, $3)", [
      input.email,
      userId,
      organization.id,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    // Same email registered concurrently between the check and the insert.
    if (error.code === "23505" && error.constraint === "user_directory_pkey") {
      return fail(res, 409, DUPLICATE_EMAIL, { email: DUPLICATE_EMAIL });
    }
    console.error("Signup failed:", error.message);
    return fail(res, 500, "Could not create the account. Please try again.");
  } finally {
    client.release();
  }

  // 2–4. The hospital's own database
  let databaseCreated = false;
  try {
    await createDatabase(organization.db_name);
    databaseCreated = true;
    await migrateTenantDatabase(organization.db_name);
    // Role is fixed here by the backend: the first user of an organization is its SUPERADMIN.
    const user = await getTenantPool(organization.db_name).query(
      `INSERT INTO users (id, full_name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, 'SUPERADMIN')
       RETURNING id, full_name, email, role, status`,
      [userId, input.fullName, input.email, passwordHash]
    );
    const active = await centralPool.query(
      "UPDATE organizations SET status = 'ACTIVE', updated_at = NOW() WHERE id = $1 RETURNING id, name, slug, status",
      [organization.id]
    );

    res.status(201).json({
      success: true,
      message: "Account created. Please log in.",
      data: { user: toUser(user.rows[0]), organization: organizationOf(active.rows[0]) },
    });
  } catch (error) {
    console.error(`Signup provisioning failed (${organization.db_name}):`, error.message);
    await undoSignup(organization, databaseCreated);
    fail(res, 500, "Could not create the account. Please try again.");
  }
};

/**
 * Removes everything a failed signup created (database first, then the central rows).
 * Only drops the database when this signup created it — never an existing one with the same name.
 */
const undoSignup = async (organization, databaseCreated) => {
  if (databaseCreated) {
    try {
      await dropTenantDatabase(organization.db_name);
    } catch (error) {
      console.error(`Could not drop ${organization.db_name}:`, error.message);
    }
  }
  try {
    await centralPool.query("DELETE FROM organizations WHERE id = $1", [organization.id]); // cascades the directory row
  } catch (error) {
    console.error(`Could not remove organization ${organization.id}:`, error.message);
  }
};

const login = async (req, res) => {
  const INVALID = "Invalid email or password.";
  const email = normalizeEmail(req.body?.email);
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  if (!email || !password) {
    return fail(res, 400, "Email and password are required.");
  }

  try {
    // Which hospital (database) this email belongs to.
    const entry = (
      await centralPool.query(
        `SELECT d.user_id, o.id, o.name, o.slug, o.status, o.db_name
         FROM user_directory d
         JOIN organizations o ON o.id = d.organization_id
         WHERE d.email = $1`,
        [email]
      )
    ).rows[0];
    const row = entry?.db_name
      ? (await getTenantPool(entry.db_name).query(`${SELECT_USER} WHERE id = $1`, [entry.user_id])).rows[0]
      : undefined;

    const passwordOk = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !passwordOk) {
      return fail(res, 401, INVALID);
    }
    if (row.status !== "ACTIVE" || entry.status !== "ACTIVE") {
      return fail(res, 403, "This account is not active. Contact your administrator.");
    }

    await createSession(res, row.id, entry.id);
    res.json({
      success: true,
      message: "Logged in",
      data: { user: toUser(row), organization: organizationOf(entry) },
    });
  } catch (error) {
    console.error("Login failed:", error.message);
    fail(res, 500, "Internal server error");
  }
};

const logout = async (req, res) => {
  try {
    await destroySession(req, res);
    res.json({ success: true, message: "Logged out", data: null });
  } catch (error) {
    console.error("Logout failed:", error.message);
    fail(res, 500, "Internal server error");
  }
};

/** Uses only req.auth (from the session) — never ids from the request. */
const me = async (req, res) => {
  try {
    const user = (await req.tenantPool.query(`${SELECT_USER} WHERE id = $1`, [req.auth.userId])).rows[0];
    const organization = (
      await centralPool.query("SELECT id, name, slug, status FROM organizations WHERE id = $1", [req.auth.organizationId])
    ).rows[0];
    if (!user || !organization) {
      return fail(res, 401, "Authentication required");
    }
    res.json({ success: true, data: { user: toUser(user), organization: organizationOf(organization) } });
  } catch (error) {
    console.error("Load current user failed:", error.message);
    fail(res, 500, "Internal server error");
  }
};

module.exports = {
  signup,
  login,
  logout,
  me,
};
