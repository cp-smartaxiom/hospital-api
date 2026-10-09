const centralPool = require("../config/database");
const { getTenantPool, closeTenantPool, DB_NAME } = require("../config/tenant-pool");
const { runMigrations, TENANT_MIGRATIONS } = require("./migrator");

/*
 * Hospital database lifecycle (the app's DB user needs the CREATEDB privilege).
 * Names come only from the organization slug (a-z, 0-9, '-'), never from raw user input,
 * and are validated again before being used as an identifier.
 */

/** "st-marys-hospital-2" → "hms_st_marys_hospital_2" */
const dbNameForSlug = (slug) => `hms_${slug.replace(/-/g, "_")}`;

const quoted = (dbName) => {
  if (!DB_NAME.test(dbName)) throw new Error("Invalid hospital database name");
  return `"${dbName}"`;
};

const databaseExists = async (dbName) =>
  (await centralPool.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName])).rows.length > 0;

/** CREATE DATABASE only (no tables yet). Throws if it already exists. */
const createDatabase = async (dbName) => {
  // CREATE DATABASE can't take parameters or run inside a transaction.
  await centralPool.query(`CREATE DATABASE ${quoted(dbName)}`);
};

/** CREATE DATABASE + all tenant migrations. */
const createTenantDatabase = async (dbName) => {
  await createDatabase(dbName);
  await migrateTenantDatabase(dbName);
};

const migrateTenantDatabase = (dbName, label = "") =>
  runMigrations(getTenantPool(dbName), TENANT_MIGRATIONS, label);

/** Drops a hospital database (closing our connections first). Used to undo a failed signup. */
const dropTenantDatabase = async (dbName) => {
  await closeTenantPool(dbName);
  await centralPool.query(`DROP DATABASE IF EXISTS ${quoted(dbName)} WITH (FORCE)`);
};

module.exports = { dbNameForSlug, databaseExists, createDatabase, createTenantDatabase, migrateTenantDatabase, dropTenantDatabase };
