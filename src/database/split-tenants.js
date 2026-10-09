// One-time move to "one database per hospital" for organizations created before it.
// For every organization without a database it:
//   1. creates hms_<slug> with all hospital tables
//   2. copies that organization's users, department assignments and audit log into it
//   3. with --legacy-data-to=<slug>: also copies the shared operational data (departments, doctors,
//      patients, devices, camera/sensor/monitor rows, events) into that one hospital and registers
//      its devices for MQTT routing
//   4. records db_name on the organization
// Nothing is deleted from hospital_db. Safe to re-run: organizations that already have a database
// are skipped. Usage:
//   npm run tenants:split -- --legacy-data-to=apolloyash
const centralPool = require("../config/database");
const { getTenantPool, closeAllTenantPools } = require("../config/tenant-pool");
const { dbNameForSlug, databaseExists, createTenantDatabase, dropTenantDatabase } = require("./tenants");

const legacyArg = process.argv.find((a) => a.startsWith("--legacy-data-to="));
const legacySlug = legacyArg ? legacyArg.split("=")[1] : null;

// Operational tables in foreign-key order (parents first).
const LEGACY_TABLES = [
  "departments",
  "doctors",
  "patients",
  "devices",
  "ip_cameras",
  "motion_sensors",
  "qstat_monitors",
  "drager_monitors",
  "events",
];

/** Copies rows into the same-named tenant table, matching columns by name (extra source columns are ignored). */
const copyRows = async (tenant, table, rows, { onConflictDoNothing = false } = {}) => {
  if (rows.length === 0) return 0;
  const result = await tenant.query(
    `INSERT INTO ${table} SELECT * FROM json_populate_recordset(NULL::${table}, $1)
     ${onConflictDoNothing ? "ON CONFLICT DO NOTHING" : ""}`,
    [JSON.stringify(rows)]
  );
  return result.rowCount;
};

const resetSequence = (tenant, table) =>
  tenant.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`);

const splitOrganization = async (org) => {
  const dbName = dbNameForSlug(org.slug);
  if (await databaseExists(dbName)) {
    throw new Error(`${dbName} already exists but isn't linked to ${org.slug}; check it manually`);
  }
  console.log(`\n${org.name} (${org.slug}) → ${dbName}`);
  await createTenantDatabase(dbName);

  const tenant = await getTenantPool(dbName).connect();
  try {
    await tenant.query("BEGIN");
    const users = (await centralPool.query("SELECT * FROM users WHERE organization_id = $1", [org.id])).rows;
    console.log(`  users: ${await copyRows(tenant, "users", users)}`);
    const assignments = (
      await centralPool.query(
        "SELECT a.* FROM user_department_assignments a JOIN users u ON u.id = a.user_id WHERE u.organization_id = $1",
        [org.id]
      )
    ).rows;

    if (org.slug === legacySlug) {
      const userIds = new Set(users.map((u) => u.id));
      for (const table of LEGACY_TABLES) {
        let rows = (await centralPool.query(`SELECT * FROM ${table}`)).rows;
        // Doctor ↔ account links only for this hospital's own users.
        if (table === "doctors") rows = rows.map((d) => ({ ...d, user_id: userIds.has(d.user_id) ? d.user_id : null }));
        const n = await copyRows(tenant, table, rows, { onConflictDoNothing: table === "departments" });
        console.log(`  ${table}: ${n}`);
      }
      await resetSequence(tenant, "events");
    }

    console.log(`  department assignments: ${await copyRows(tenant, "user_department_assignments", assignments)}`);
    const audit = (await centralPool.query("SELECT * FROM audit_logs WHERE organization_id = $1", [org.id])).rows;
    console.log(`  audit log: ${await copyRows(tenant, "audit_logs", audit)}`);
    await resetSequence(tenant, "audit_logs");
    await tenant.query("COMMIT");
  } catch (error) {
    await tenant.query("ROLLBACK").catch(() => {});
    tenant.release();
    await dropTenantDatabase(dbName); // created by this run, nothing else uses it yet
    throw error;
  }
  tenant.release();

  if (org.slug === legacySlug) {
    const devices = await centralPool.query(
      `INSERT INTO device_registry (device_id, organization_id)
       SELECT device_id, $1 FROM devices ON CONFLICT (device_id) DO NOTHING`,
      [org.id]
    );
    console.log(`  devices registered for MQTT: ${devices.rowCount}`);
  }
  await centralPool.query("UPDATE organizations SET db_name = $2, updated_at = NOW() WHERE id = $1", [org.id, dbName]);
  console.log(`  done`);
};

async function main() {
  const orgs = (await centralPool.query("SELECT id, name, slug FROM organizations WHERE db_name IS NULL ORDER BY created_at"))
    .rows;
  if (legacySlug && !orgs.some((o) => o.slug === legacySlug)) {
    const linked = await centralPool.query("SELECT 1 FROM organizations WHERE slug = $1", [legacySlug]);
    throw new Error(
      linked.rows.length ? `${legacySlug} already has its own database` : `No organization with slug "${legacySlug}"`
    );
  }
  if (orgs.length === 0) console.log("Every organization already has its own database.");
  for (const org of orgs) await splitOrganization(org);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => Promise.all([closeAllTenantPools(), centralPool.end()]));
