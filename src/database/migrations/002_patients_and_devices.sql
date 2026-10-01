-- Patients + a common `devices` table, with one detail table per device type.
-- `ip_cameras` (from 001) is converted into a detail table; its existing rows are kept.

/* ------------------------------- Patients ------------------------------- */

CREATE TABLE patients (
  id                  VARCHAR(20)  PRIMARY KEY CHECK (id ~ '^P-[0-9]{3,}$'),   -- e.g. P-001
  name                VARCHAR(100) NOT NULL,
  room                VARCHAR(20)  NOT NULL,
  bed                 VARCHAR(20)  NOT NULL,
  attending_physician VARCHAR(100) NOT NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

/* ------------------------- Devices (all types) -------------------------- */

CREATE TABLE devices (
  device_id    VARCHAR(50)  PRIMARY KEY,                                   -- e.g. CAM-001, RUI-001
  device_type  VARCHAR(20)  NOT NULL
               CHECK (device_type IN ('ip_camera', 'motion_sensor', 'qstat', 'drager')),
  name         VARCHAR(100) NOT NULL,
  location     VARCHAR(100) NOT NULL DEFAULT 'Device Store',
  status       VARCHAR(10)  NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline')),
  -- NULL = available. Deleting a patient frees their devices.
  patient_id   VARCHAR(20)  REFERENCES patients (id) ON UPDATE CASCADE ON DELETE SET NULL,
  last_seen_at TIMESTAMPTZ,                                                -- last data from the device
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX devices_type_idx ON devices (device_type);

-- A patient can have at most one device of each type.
CREATE UNIQUE INDEX devices_one_type_per_patient
  ON devices (patient_id, device_type)
  WHERE patient_id IS NOT NULL;

/* ---------------- Move ip_cameras' common columns to devices ---------------- */

-- patients is empty at this point, so existing assignments can't be kept.
INSERT INTO devices (device_id, device_type, name, location, status, patient_id, last_seen_at, created_at, updated_at)
SELECT device_id, 'ip_camera', name,
       CASE WHEN patient_id IS NULL THEN location ELSE 'Device Store' END,
       status, NULL, last_seen_at, created_at, updated_at
FROM ip_cameras;

DROP INDEX IF EXISTS ip_cameras_one_per_patient;
ALTER TABLE ip_cameras
  DROP COLUMN id,
  DROP COLUMN name,
  DROP COLUMN location,
  DROP COLUMN status,
  DROP COLUMN patient_id,
  DROP COLUMN last_seen_at,
  DROP COLUMN created_at,
  DROP COLUMN updated_at;
ALTER TABLE ip_cameras DROP CONSTRAINT ip_cameras_device_id_key;
ALTER TABLE ip_cameras ADD PRIMARY KEY (device_id);
ALTER TABLE ip_cameras
  ADD CONSTRAINT ip_cameras_device_fk FOREIGN KEY (device_id)
  REFERENCES devices (device_id) ON UPDATE CASCADE ON DELETE CASCADE;

/* ----------------------- Type-specific detail tables ----------------------- */
-- Readings are NULL until the device starts reporting.

CREATE TABLE motion_sensors (
  device_id     VARCHAR(50) PRIMARY KEY
                REFERENCES devices (device_id) ON UPDATE CASCADE ON DELETE CASCADE,
  accel_x       REAL, accel_y REAL, accel_z REAL,          -- g
  gyro_x        REAL, gyro_y  REAL, gyro_z  REAL,          -- deg/s
  mag_x         REAL, mag_y   REAL, mag_z   REAL,          -- uT
  motion_status VARCHAR(10) CHECK (motion_status IN ('moving', 'still', 'unknown')),
  battery_level SMALLINT    CHECK (battery_level BETWEEN 0 AND 100),
  temperature   REAL                                       -- °C
);

CREATE TABLE qstat_monitors (
  device_id        VARCHAR(50) PRIMARY KEY
                   REFERENCES devices (device_id) ON UPDATE CASCADE ON DELETE CASCADE,
  heart_rate       SMALLINT,
  spo2             SMALLINT,
  respiratory_rate SMALLINT,
  temperature      REAL,
  systolic_bp      SMALLINT,
  diastolic_bp     SMALLINT,
  alarm_active     BOOLEAN NOT NULL DEFAULT FALSE,
  alarm_message    TEXT
);

CREATE TABLE drager_monitors (
  device_id        VARCHAR(50) PRIMARY KEY
                   REFERENCES devices (device_id) ON UPDATE CASCADE ON DELETE CASCADE,
  heart_rate       SMALLINT,
  spo2             SMALLINT,
  respiratory_rate SMALLINT,
  temperature      REAL,
  systolic_bp      SMALLINT,
  diastolic_bp     SMALLINT,
  alarm_active     BOOLEAN NOT NULL DEFAULT FALSE,
  alarm_severity   VARCHAR(20),
  alarm_message    TEXT
);
