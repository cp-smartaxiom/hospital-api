// Brings every database up to date:
//   1. central registry (hospital_db): src/database/migrations
//   2. every hospital database (hms_<slug>): src/database/tenant-migrations
// Usage: npm run migrate
const pool = require("../config/database");
const { closeAllTenantPools } = require("../config/tenant-pool");
const { runMigrations, CENTRAL_MIGRATIONS } = require("./migrator");
const { migrateTenantDatabase } = require("./tenants");

async function migrate() {
  await runMigrations(pool, CENTRAL_MIGRATIONS, " (central)");

  const hasDbName = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'organizations' AND column_name = 'db_name'"
  );
  if (hasDbName.rows.length > 0) {
    const tenants = await pool.query("SELECT db_name FROM organizations WHERE db_name IS NOT NULL ORDER BY db_name");
    for (const { db_name: dbName } of tenants.rows) {
      await migrateTenantDatabase(dbName, ` (${dbName})`);
    }
    console.log(`Hospital databases checked: ${tenants.rows.length}`);
  }
  console.log("Migrations up to date.");
}

migrate()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => Promise.all([closeAllTenantPools(), pool.end()]));
