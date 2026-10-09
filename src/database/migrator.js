const fs = require("fs");
const path = require("path");

const CENTRAL_MIGRATIONS = path.join(__dirname, "migrations");
const TENANT_MIGRATIONS = path.join(__dirname, "tenant-migrations");

/** Runs every *.sql file in `dir` once, in name order, each in its own transaction. Returns applied names. */
const runMigrations = async (pool, dir, label = "") => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  const applied = new Set((await pool.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const done = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      done.push(file);
      if (label) console.log(`Applied ${file}${label}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${file}${label} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }
  return done;
};

module.exports = { runMigrations, CENTRAL_MIGRATIONS, TENANT_MIGRATIONS };
