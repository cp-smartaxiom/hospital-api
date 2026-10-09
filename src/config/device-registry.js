const centralPool = require("./database");

/*
 * Central device id → hospital map. MQTT messages only carry the device id, so this is how they
 * reach the right hospital database. Device ids are therefore unique across all hospitals.
 */

/**
 * Registers a device for a hospital. Returns true if newly registered, false if it already was
 * (for the same hospital). Throws { code: "DEVICE_TAKEN" } if another hospital owns the id.
 */
const registerDevice = async (deviceId, organizationId) => {
  const inserted = await centralPool.query(
    "INSERT INTO device_registry (device_id, organization_id) VALUES ($1, $2) ON CONFLICT (device_id) DO NOTHING",
    [deviceId, organizationId]
  );
  if (inserted.rowCount === 1) return true;
  const owner = (await centralPool.query("SELECT organization_id FROM device_registry WHERE device_id = $1", [deviceId]))
    .rows[0];
  if (owner && owner.organization_id !== organizationId) {
    throw Object.assign(new Error("Device id belongs to another hospital"), { code: "DEVICE_TAKEN" });
  }
  return false;
};

const unregisterDevice = (deviceId, organizationId) =>
  centralPool.query("DELETE FROM device_registry WHERE device_id = $1 AND organization_id = $2", [
    deviceId,
    organizationId,
  ]);

/** Hospital (id + database) a device belongs to, or null. */
const hospitalForDevice = async (deviceId) =>
  (
    await centralPool.query(
      `SELECT o.id, o.db_name
       FROM device_registry r
       JOIN organizations o ON o.id = r.organization_id
       WHERE r.device_id = $1 AND o.status = 'ACTIVE' AND o.db_name IS NOT NULL`,
      [deviceId]
    )
  ).rows[0] ?? null;

/** Hospital by slug (used for MQTT_DEFAULT_ORGANIZATION), or null. */
const hospitalBySlug = async (slug) =>
  (
    await centralPool.query(
      "SELECT id, db_name FROM organizations WHERE slug = $1 AND status = 'ACTIVE' AND db_name IS NOT NULL",
      [slug]
    )
  ).rows[0] ?? null;

module.exports = { registerDevice, unregisterDevice, hospitalForDevice, hospitalBySlug };
