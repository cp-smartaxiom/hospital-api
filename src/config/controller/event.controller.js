const pool = require("../tenant-pool"); // hospital database of the request / of the MQTT device
const { getTenantPool, runWithTenant } = require("../tenant-pool");
const { hospitalForDevice, hospitalBySlug, registerDevice } = require("../device-registry");

/*
 * Events API for MQTT device data.
 *   Topic format: sa/<deviceType>/<deviceId>/monitoring/<category>[/<subType>]
 *   e.g. sa/qstat/qs3490EAB52026/monitoring/vitals/spo2
 * Every message:
 *   0. is routed to the hospital that owns the device (central device_registry). Unknown devices go to
 *      MQTT_DEFAULT_ORGANIZATION (a hospital slug) if set, otherwise they're skipped
 *   1. auto-creates the device in `devices` the first time it is seen (marks it online otherwise)
 *   2. is stored in `events`
 *   3. updates the latest readings in `qstat_monitors` (QStat only)
 *   4. is pushed to that hospital's UI clients on GET /api/events/stream (Server-Sent Events)
 * Responses follow { success, message?, data }.
 */

const DEVICE_TYPES = ["ip_camera", "motion_sensor", "qstat", "drager"];
const DEVICE_ID = /^[A-Za-z0-9_-]{2,50}$/;
const TYPE_LABELS = { ip_camera: "IP Camera", motion_sensor: "Motion Sensor", qstat: "QStat", drager: "Dräger" };
const MAX_LIMIT = 500;
const SSE_HEARTBEAT_MS = 25000;

/** Open SSE responses → the hospital (organization id) they belong to. */
const streamClients = new Map();

/** Topic string → { deviceType, deviceId, category, subType }, or null if it doesn't match. */
const parseTopic = (topic) => {
  const parts = topic.split("/");
  if (parts.length < 5 || parts[0] !== "sa" || parts[3] !== "monitoring") return null;

  return {
    deviceType: parts[1],
    deviceId: parts[2],
    category: parts[4],
    subType: parts.slice(5).join("/") || null,
  };
};

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const int = (v) => (num(v) === null ? null : Math.round(v));

/** QStat payload → qstat_monitors columns to update (empty object if nothing maps). */
const qstatColumns = (category, subType, data) => {
  if (category === "vitals" && !subType) return { heart_rate: int(data.pr), respiratory_rate: int(data.rr) };
  if (category === "vitals" && subType === "spo2") return { spo2: int(data.spo2) };
  if (category === "vitals" && subType === "skin_temperature") return { temperature: num(data.temp) };
  if (category === "alert") {
    return {
      alarm_active: data.active ?? true,
      alarm_message: data.message ?? data.type ?? JSON.stringify(data),
    };
  }
  return {};
};

const toEvent = (row) => ({
  id: Number(row.id),
  device_id: row.device_id,
  device_type: row.device_type,
  category: row.category,
  sub_type: row.sub_type,
  topic: row.topic,
  data: row.data,
  device_ts: row.device_ts,
  received_at: row.received_at,
});

/** Creates the device on first sight; otherwise marks it online and bumps last_seen_at. */
const upsertDevice = async (client, deviceId, deviceType) => {
  const { rows } = await client.query(
    `INSERT INTO devices (device_id, device_type, name, status, last_seen_at)
     VALUES ($1, $2, $3, 'online', NOW())
     ON CONFLICT (device_id) DO UPDATE
       SET status = 'online', last_seen_at = NOW(), updated_at = NOW()
     RETURNING (xmax = 0) AS created`,
    [deviceId, deviceType, `${TYPE_LABELS[deviceType]} ${deviceId}`]
  );

  if (deviceType === "qstat") {
    await client.query(
      "INSERT INTO qstat_monitors (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING",
      [deviceId]
    );
  }
  return rows[0].created;
};

const updateQStat = async (client, deviceId, columns) => {
  const entries = Object.entries(columns).filter(([, v]) => v !== null && v !== undefined);
  if (entries.length === 0) return;

  const sets = entries.map(([col], i) => `${col} = $${i + 2}`).join(", ");
  await client.query(`UPDATE qstat_monitors SET ${sets} WHERE device_id = $1`, [
    deviceId,
    ...entries.map(([, v]) => v),
  ]);
};

const broadcast = (organizationId, event) => {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const [res, orgId] of streamClients) if (orgId === organizationId) res.write(payload);
};

const warnedUnknown = new Set();

/** Hospital for a device: registry first, then MQTT_DEFAULT_ORGANIZATION (registering the device there). */
const resolveHospital = async (deviceId) => {
  const known = await hospitalForDevice(deviceId);
  if (known) return known;
  const slug = process.env.MQTT_DEFAULT_ORGANIZATION;
  const fallback = slug ? await hospitalBySlug(slug) : null;
  if (!fallback) {
    if (!warnedUnknown.has(deviceId)) {
      warnedUnknown.add(deviceId);
      console.warn(`[EVENT] Device ${deviceId} isn't registered to any hospital — add it in Settings → Devices.`);
    }
    return null;
  }
  await registerDevice(deviceId, fallback.id);
  return fallback;
};

/** Saves the message in the owning hospital's database, then streams it to that hospital's clients. */
const routeEvent = async (topic, info, data) => {
  const hospital = await resolveHospital(info.deviceId);
  if (!hospital) return;
  const event = await runWithTenant(getTenantPool(hospital.db_name), () => saveEvent(topic, info, data));
  broadcast(hospital.id, event);
};

const saveEvent = async (topic, info, data) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const created = await upsertDevice(client, info.deviceId, info.deviceType);
    if (created) console.log(`[EVENT] New device saved: ${info.deviceId} (${info.deviceType})`);

    const deviceTs = num(data.archived_ts) !== null ? new Date(data.archived_ts * 1000) : null;
    const { rows } = await client.query(
      `INSERT INTO events (device_id, device_type, category, sub_type, topic, data, device_ts)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [info.deviceId, info.deviceType, info.category, info.subType, topic, data, deviceTs]
    );

    if (info.deviceType === "qstat") {
      await updateQStat(client, info.deviceId, qstatColumns(info.category, info.subType, data));
    }

    await client.query("COMMIT");
    return toEvent(rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// Messages are processed one at a time so events are stored and streamed in arrival order.
let queue = Promise.resolve();

/** Called by the MQTT client for every message received. */
const handleMqttMessage = (topic, message) => {
  const info = parseTopic(topic);
  if (!info || !DEVICE_TYPES.includes(info.deviceType) || !DEVICE_ID.test(info.deviceId)) {
    console.warn(`[EVENT] Unknown topic format, skipped: ${topic}`);
    return;
  }

  let data;
  try {
    data = JSON.parse(message.toString());
  } catch (error) {
    console.error(`[EVENT] Invalid JSON on ${topic}:`, message.toString());
    return;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    console.error(`[EVENT] Payload is not a JSON object on ${topic}:`, message.toString());
    return;
  }

  const label = info.subType ? `${info.category}/${info.subType}` : info.category;
  console.log(`[EVENT] ${info.deviceId} | ${label} |`, JSON.stringify(data));

  queue = queue
    .then(() => routeEvent(topic, info, data))
    .catch((error) => console.error(`[EVENT] Failed to save ${topic}:`, error.message));
};

/**
 * GET /api/events?deviceId=&category=&type=&date=&search=&limit= — newest first, from the DB.
 *   category  all events of a category (vitals includes spo2 and skin_temperature)
 *   type      exact topic type: "vitals" (main topic only), "vitals/spo2", "activity", …
 *   date      yyyy-mm-dd, matched against received_at
 *   search    text in device_id, topic or payload
 */
const getEvents = async (req, res) => {
  try {
    const { deviceId, category, type, date, search } = req.query;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), MAX_LIMIT);

    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, message: "date must be yyyy-mm-dd" });
    }
    const [typeCategory, ...typeRest] = type ? String(type).split("/") : [null];

    const { rows } = await pool.query(
      `SELECT * FROM events
       WHERE ($1::text IS NULL OR device_id = $1)
         AND ($2::text IS NULL OR category = $2)
         AND ($3::text IS NULL OR (category = $3 AND sub_type IS NOT DISTINCT FROM $4::text))
         AND ($5::date IS NULL OR received_at::date = $5::date)
         AND ($6::text IS NULL OR device_id ILIKE $6 OR topic ILIKE $6 OR data::text ILIKE $6)
       ORDER BY received_at DESC, id DESC
       LIMIT $7`,
      [
        deviceId || null,
        category || null,
        typeCategory || null,
        typeRest.join("/") || null,
        date || null,
        search ? `%${search}%` : null,
        limit,
      ]
    );

    res.json({ success: true, count: rows.length, data: rows.map(toEvent) });
  } catch (error) {
    console.error("getEvents error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch events" });
  }
};

/** GET /api/events/stream — Server-Sent Events, one `data:` line per new event. */
const streamEvents = (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.write(": connected\n\n");

  streamClients.set(res, req.auth.organizationId);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), SSE_HEARTBEAT_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
    streamClients.delete(res);
  });
};

module.exports = {
  handleMqttMessage,
  getEvents,
  streamEvents,
};
