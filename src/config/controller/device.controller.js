const pool = require("../database");

/*
 * Devices API for all device types.
 *   devices          common fields (one row per device)
 *   ip_cameras       camera configuration
 *   motion_sensors   latest motion readings
 *   qstat_monitors   latest QStat measurements
 *   drager_monitors  latest Dräger vital signs
 * Responses follow { success, message?, data } and use the device JSON shape the UI expects.
 */

const DEVICE_TYPES = ["ip_camera", "motion_sensor", "qstat", "drager"];
const TYPE_LABELS = { ip_camera: "IP Camera", motion_sensor: "Motion Sensor", qstat: "QStat", drager: "Dräger" };
const DETAIL_TABLES = {
  ip_camera: "ip_cameras",
  motion_sensor: "motion_sensors",
  qstat: "qstat_monitors",
  drager: "drager_monitors",
};

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{2,50}$/;
const PATIENT_ID = /^P-\d{3,}$/;
const STORE = "Device Store";

const SELECT_DEVICES = `
  SELECT d.device_id, d.device_type, d.name, d.location, d.status, d.patient_id,
         COALESCE(d.last_seen_at, d.updated_at) AS timestamp,
         to_jsonb(c) AS camera, to_jsonb(m) AS motion, to_jsonb(q) AS qstat, to_jsonb(g) AS drager
  FROM devices d
  LEFT JOIN ip_cameras      c ON c.device_id = d.device_id
  LEFT JOIN motion_sensors  m ON m.device_id = d.device_id
  LEFT JOIN qstat_monitors  q ON q.device_id = d.device_id
  LEFT JOIN drager_monitors g ON g.device_id = d.device_id
`;

const vec = (x, y, z, unit) => ({ x, y, z, unit });

/** Joined DB row → device JSON (same shape as the sample payloads / UI models). */
const toDevice = (row) => {
  const base = {
    device_type: row.device_type,
    device_id: row.device_id,
    name: row.name,
    location: row.location,
    status: row.status,
    patient_id: row.patient_id,
    timestamp: row.timestamp,
  };

  switch (row.device_type) {
    case "ip_camera": {
      const c = row.camera ?? {};
      return {
        ...base,
        ip_address: c.ip_address,
        stream_url: c.stream_url,
        resolution: c.resolution,
        fps: c.fps,
        motion_detection: c.motion_detection,
        recording: c.recording,
      };
    }
    case "motion_sensor": {
      const m = row.motion ?? {};
      const hasReadings = m.accel_x !== null && m.accel_x !== undefined;
      return {
        ...base,
        motion_sensor: hasReadings
          ? {
              accelerometer: vec(m.accel_x, m.accel_y, m.accel_z, "g"),
              gyroscope: vec(m.gyro_x, m.gyro_y, m.gyro_z, "deg/s"),
              magnetometer: vec(m.mag_x, m.mag_y, m.mag_z, "uT"),
              motion_status: m.motion_status ?? "unknown",
            }
          : null,
        battery_level: m.battery_level ?? null,
        temperature: m.temperature ?? null,
      };
    }
    case "qstat": {
      const q = row.qstat ?? {};
      return {
        ...base,
        measurements: {
          heart_rate: q.heart_rate ?? null,
          spo2: q.spo2 ?? null,
          respiratory_rate: q.respiratory_rate ?? null,
          temperature: q.temperature ?? null,
          blood_pressure: { systolic: q.systolic_bp ?? null, diastolic: q.diastolic_bp ?? null },
        },
        alarm: { active: Boolean(q.alarm_active), message: q.alarm_message ?? null },
      };
    }
    case "drager": {
      const g = row.drager ?? {};
      return {
        ...base,
        vital_signs: {
          heart_rate: g.heart_rate ?? null,
          spo2: g.spo2 ?? null,
          respiratory_rate: g.respiratory_rate ?? null,
          temperature: g.temperature ?? null,
          systolic_bp: g.systolic_bp ?? null,
          diastolic_bp: g.diastolic_bp ?? null,
        },
        alarm: {
          active: Boolean(g.alarm_active),
          severity: g.alarm_severity ?? null,
          message: g.alarm_message ?? null,
        },
      };
    }
    default:
      return base;
  }
};

const fail = (res, status, message) => res.status(status).json({ success: false, message });

/** Maps Postgres constraint errors to friendly 4xx responses. */
const handleDbError = (res, error, input = {}) => {
  if (error.code === "23505") {
    if (error.constraint === "devices_pkey") return fail(res, 409, "Device ID already exists.");
    if (error.constraint === "devices_one_type_per_patient") {
      const label = TYPE_LABELS[input.device_type] ?? "device of this type";
      return fail(res, 409, `This patient already has a ${label}.`);
    }
  }
  if (error.code === "23503" && error.constraint === "devices_patient_id_fkey") {
    return fail(res, 400, "Patient not found.");
  }
  console.error(error);
  return fail(res, 500, "Internal server error");
};

const findDevice = async (db, deviceId) => {
  const result = await db.query(`${SELECT_DEVICES} WHERE d.device_id = $1`, [deviceId]);
  return result.rows[0] ? toDevice(result.rows[0]) : null;
};

/**
 * Validates the UI's device form body:
 * { device_type, device_id, name, location, status, patient_id, camera?: {...} }
 * `type` is the device's type (from the body on create, from the DB on update).
 */
const validateDeviceInput = (body, type, { isCreate }) => {
  const errors = [];
  const str = (v) => (typeof v === "string" ? v.trim() : "");

  const value = {
    device_type: type,
    device_id: str(body.device_id),
    name: str(body.name),
    location: str(body.location) || STORE,
    status: body.status ?? "offline",
    patient_id: body.patient_id ? str(body.patient_id) : null,
  };

  if (isCreate && !DEVICE_TYPES.includes(type)) {
    errors.push(`device_type must be one of: ${DEVICE_TYPES.join(", ")}`);
  }
  if (isCreate && !DEVICE_ID.test(value.device_id)) {
    errors.push("device_id is required (letters, numbers, - or _)");
  }
  if (!value.name) errors.push("name is required");
  if (!["online", "offline"].includes(value.status)) errors.push("status must be 'online' or 'offline'");
  if (value.patient_id && !PATIENT_ID.test(value.patient_id)) errors.push("patient_id must look like P-001");

  if (type === "ip_camera") {
    const camera = body.camera ?? {};
    value.camera = {
      ip_address: str(camera.ip_address),
      stream_url: str(camera.stream_url),
      resolution: str(camera.resolution) || "1920x1080",
      fps: camera.fps === undefined ? 30 : Number(camera.fps),
      motion_detection: camera.motion_detection === undefined ? true : Boolean(camera.motion_detection),
      recording: camera.recording === undefined ? false : Boolean(camera.recording),
    };
    if (!IPV4.test(value.camera.ip_address)) errors.push("camera.ip_address must be a valid IPv4 address");
    if (!value.camera.stream_url) errors.push("camera.stream_url is required");
    if (!/^\d{3,5}x\d{3,5}$/.test(value.camera.resolution)) errors.push("camera.resolution must look like 1920x1080");
    if (!Number.isInteger(value.camera.fps) || value.camera.fps < 1 || value.camera.fps > 120) {
      errors.push("camera.fps must be 1–120");
    }
  }

  return { errors, value };
};

/* --------------------------------- Handlers --------------------------------- */

// GET /api/devices?type=ip_camera   (type optional)
const listDevices = async (req, res) => {
  const { type } = req.query;
  if (type && !DEVICE_TYPES.includes(type)) {
    return fail(res, 400, `type must be one of: ${DEVICE_TYPES.join(", ")}`);
  }
  try {
    const result = type
      ? await pool.query(`${SELECT_DEVICES} WHERE d.device_type = $1 ORDER BY d.device_id`, [type])
      : await pool.query(`${SELECT_DEVICES} ORDER BY d.device_type, d.device_id`);
    res.json({ success: true, data: result.rows.map(toDevice) });
  } catch (error) {
    handleDbError(res, error);
  }
};

// GET /api/devices/summary   → total / assigned / available per type
const getDeviceSummary = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.type AS device_type,
              COUNT(d.device_id)::int  AS total,
              COUNT(d.patient_id)::int AS assigned
       FROM unnest($1::text[]) WITH ORDINALITY AS t(type, ord)
       LEFT JOIN devices d ON d.device_type = t.type
       GROUP BY t.type, t.ord
       ORDER BY t.ord`,
      [DEVICE_TYPES]
    );
    res.json({
      success: true,
      data: result.rows.map((r) => ({ ...r, available: r.total - r.assigned })),
    });
  } catch (error) {
    handleDbError(res, error);
  }
};

// GET /api/devices/:id
const getDevice = async (req, res) => {
  try {
    const device = await findDevice(pool, req.params.id);
    if (!device) return fail(res, 404, "Device not found");
    res.json({ success: true, data: device });
  } catch (error) {
    handleDbError(res, error);
  }
};

// POST /api/devices
const createDevice = async (req, res) => {
  const body = req.body ?? {};
  const { errors, value } = validateDeviceInput(body, body.device_type, { isCreate: true });
  if (errors.length) return fail(res, 400, errors.join("; "));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO devices (device_id, device_type, name, location, status, patient_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [value.device_id, value.device_type, value.name, value.location, value.status, value.patient_id]
    );
    if (value.device_type === "ip_camera") {
      const c = value.camera;
      await client.query(
        `INSERT INTO ip_cameras (device_id, ip_address, stream_url, resolution, fps, motion_detection, recording)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [value.device_id, c.ip_address, c.stream_url, c.resolution, c.fps, c.motion_detection, c.recording]
      );
    } else {
      // Detail row starts empty; readings arrive from the device.
      await client.query(`INSERT INTO ${DETAIL_TABLES[value.device_type]} (device_id) VALUES ($1)`, [value.device_id]);
    }
    await client.query("COMMIT");
    res.status(201).json({
      success: true,
      message: "Device created successfully",
      data: await findDevice(pool, value.device_id),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    handleDbError(res, error, value);
  } finally {
    client.release();
  }
};

// PUT /api/devices/:id   (device_id and device_type can't change)
const updateDevice = async (req, res) => {
  const client = await pool.connect();
  let value = {};
  try {
    const existing = await client.query("SELECT device_type FROM devices WHERE device_id = $1", [req.params.id]);
    if (existing.rows.length === 0) return fail(res, 404, "Device not found");

    const validated = validateDeviceInput(req.body ?? {}, existing.rows[0].device_type, { isCreate: false });
    value = validated.value;
    if (validated.errors.length) return fail(res, 400, validated.errors.join("; "));

    await client.query("BEGIN");
    await client.query(
      `UPDATE devices SET name = $2, location = $3, status = $4, patient_id = $5, updated_at = NOW()
       WHERE device_id = $1`,
      [req.params.id, value.name, value.location, value.status, value.patient_id]
    );
    if (value.device_type === "ip_camera") {
      const c = value.camera;
      await client.query(
        `UPDATE ip_cameras SET ip_address = $2, stream_url = $3, resolution = $4, fps = $5,
                motion_detection = $6, recording = $7
         WHERE device_id = $1`,
        [req.params.id, c.ip_address, c.stream_url, c.resolution, c.fps, c.motion_detection, c.recording]
      );
    }
    await client.query("COMMIT");
    res.json({ success: true, message: "Device updated successfully", data: await findDevice(pool, req.params.id) });
  } catch (error) {
    await client.query("ROLLBACK");
    handleDbError(res, error, value);
  } finally {
    client.release();
  }
};

// DELETE /api/devices/:id   (detail row is removed by ON DELETE CASCADE)
const deleteDevice = async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM devices WHERE device_id = $1", [req.params.id]);
    if (result.rowCount === 0) return fail(res, 404, "Device not found");
    res.json({ success: true, message: "Device deleted successfully" });
  } catch (error) {
    handleDbError(res, error);
  }
};

// POST /api/devices/:id/assign   body: { patient_id }
const assignDevice = async (req, res) => {
  const patientId = typeof req.body?.patient_id === "string" ? req.body.patient_id.trim() : "";
  if (!PATIENT_ID.test(patientId)) return fail(res, 400, "patient_id must look like P-001");

  let deviceType;
  try {
    const current = await pool.query("SELECT device_type, patient_id FROM devices WHERE device_id = $1", [
      req.params.id,
    ]);
    if (current.rows.length === 0) return fail(res, 404, "Device not found");
    deviceType = current.rows[0].device_type;
    const assignedTo = current.rows[0].patient_id;
    if (assignedTo && assignedTo !== patientId) {
      return fail(res, 409, `${req.params.id} is already assigned to ${assignedTo}. Unassign it first.`);
    }

    const result = await pool.query(
      `UPDATE devices d SET patient_id = p.id, location = 'Room ' || p.room, updated_at = NOW()
       FROM patients p
       WHERE d.device_id = $1 AND p.id = $2`,
      [req.params.id, patientId]
    );
    if (result.rowCount === 0) return fail(res, 404, "Patient not found");
    res.json({ success: true, message: "Device assigned", data: await findDevice(pool, req.params.id) });
  } catch (error) {
    handleDbError(res, error, { device_type: deviceType });
  }
};

// POST /api/devices/:id/unassign
const unassignDevice = async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE devices SET patient_id = NULL, location = $2, updated_at = NOW() WHERE device_id = $1`,
      [req.params.id, STORE]
    );
    if (result.rowCount === 0) return fail(res, 404, "Device not found");
    res.json({ success: true, message: "Device unassigned", data: await findDevice(pool, req.params.id) });
  } catch (error) {
    handleDbError(res, error);
  }
};

module.exports = {
  listDevices,
  getDeviceSummary,
  getDevice,
  createDevice,
  updateDevice,
  deleteDevice,
  assignDevice,
  unassignDevice,
};
