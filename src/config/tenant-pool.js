const { Pool } = require("pg");
const { AsyncLocalStorage } = require("async_hooks");
require("dotenv").config();

/*
 * Connections to hospital (tenant) databases — one database per organization (hms_<slug>).
 *
 *   getTenantPool(dbName)   cached pg Pool for that database
 *   runWithTenant(pool, fn) runs fn (and everything async it starts) against that hospital's database
 *   module export           a pool-like object ({ query, connect }) that uses the database of the
 *                           current request — set by requireAuth from the session, never from input.
 *                           Using it outside runWithTenant throws, so a query can't silently hit
 *                           the wrong database.
 */

const DB_NAME = /^hms_[a-z0-9_]{1,59}$/;
const pools = new Map();
const context = new AsyncLocalStorage();

const getTenantPool = (dbName) => {
  if (!DB_NAME.test(dbName)) throw new Error("Invalid hospital database name");
  let pool = pools.get(dbName);
  if (!pool) {
    pool = new Pool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: dbName,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      // Many hospitals share one Postgres server, so keep each pool small and release idle connections.
      max: Number(process.env.TENANT_POOL_MAX) || 5,
      idleTimeoutMillis: 30000,
    });
    pool.on("error", (err) => console.error(`PostgreSQL error (${dbName}):`, err.message));
    pools.set(dbName, pool);
  }
  return pool;
};

const closeTenantPool = async (dbName) => {
  const pool = pools.get(dbName);
  if (!pool) return;
  pools.delete(dbName);
  await pool.end();
};

const closeAllTenantPools = () => Promise.all([...pools.keys()].map(closeTenantPool));

const runWithTenant = (pool, fn) => context.run({ pool }, fn);

const current = () => {
  const store = context.getStore();
  if (!store) throw new Error("No hospital database selected for this request");
  return store.pool;
};

module.exports = {
  query: (...args) => current().query(...args),
  connect: () => current().connect(),
  getTenantPool,
  closeTenantPool,
  closeAllTenantPools,
  runWithTenant,
  DB_NAME,
};
