-- Hospital (tenant) database: one per organization, created at signup (hms_<slug>).
-- Everything here belongs to that one hospital, so no organization_id columns are needed.
-- Same tables/constraints as the original shared schema (central migrations 001–007).

/* ------------------------------ Users ------------------------------ */

CREATE TABLE users (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name      VARCHAR(100) NOT NULL,
  email          VARCHAR(254) NOT NULL CHECK (email = lower(email)),
  password_hash  VARCHAR(255),
  role           VARCHAR(20)  NOT NULL CHECK (role IN ('SUPERADMIN', 'DOCTOR', 'OPERATOR')),
  status         VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('INVITED', 'ACTIVE', 'DISABLED')),
  phone          VARCHAR(20),
  specialization VARCHAR(100),
  license_number VARCHAR(50),
  created_by     UUID         REFERENCES users (id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT users_active_has_password CHECK (status <> 'ACTIVE' OR password_hash IS NOT NULL)
);

CREATE UNIQUE INDEX users_email_unique ON users (email);
CREATE UNIQUE INDEX users_license_unique ON users (lower(license_number)) WHERE license_number IS NOT NULL;
CREATE INDEX users_role_idx ON users (role);

/* --------------------------- Departments --------------------------- */

CREATE TABLE departments (
  id          VARCHAR(30)  PRIMARY KEY,          -- stable code used by the API
  name        VARCHAR(100) NOT NULL UNIQUE,
  description VARCHAR(255) NOT NULL,
  sort_order  SMALLINT     NOT NULL
);

INSERT INTO departments (id, name, description, sort_order) VALUES
  ('critical_care', 'Critical Care (ICU)', 'Intensivists managing critically ill and ventilated patients', 1),
  ('cardiology',    'Cardiology',          'Heart rhythm, blood pressure and cardiac monitoring',           2),
  ('neurology',     'Neurology',           'Agitation, consciousness and neurological assessment',          3),
  ('pulmonology',   'Pulmonology',         'Respiratory rate, SpO₂ and breathing support',                  4),
  ('geriatrics',    'Geriatrics',          'Elderly care, fall risk and mobility',                          5);

CREATE TABLE user_department_assignments (
  user_id       UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  department_id VARCHAR(30) NOT NULL REFERENCES departments (id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, department_id)
);

CREATE INDEX user_department_assignments_department_idx ON user_department_assignments (department_id);

/* ----------------------------- Doctors ----------------------------- */

CREATE TABLE doctors (
  id            VARCHAR(20)  PRIMARY KEY CHECK (id ~ '^D-[0-9]{3,}$'),   -- e.g. D-001
  name          VARCHAR(100) NOT NULL,
  department_id VARCHAR(30)  NOT NULL REFERENCES departments (id) ON UPDATE CASCADE,
  phone         VARCHAR(20),
  email         VARCHAR(254),
  status        VARCHAR(10)  NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  -- Login account (users) this doctor entry is kept in sync with, if any.
  user_id       UUID         UNIQUE REFERENCES users (id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX doctors_email_unique ON doctors (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX doctors_department_idx ON doctors (department_id);

/* ----------------------------- Patients ---------------------------- */

CREATE TABLE patients (
  id         VARCHAR(20)  PRIMARY KEY CHECK (id ~ '^P-[0-9]{3,}$'),   -- e.g. P-001
  name       VARCHAR(100) NOT NULL,
  room       VARCHAR(20)  NOT NULL,
  bed        VARCHAR(20)  NOT NULL,
  -- A doctor with patients can't be deleted (reassign the patients first).
  doctor_id  VARCHAR(20)  REFERENCES doctors (id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

/* ----------------------------- Devices ----------------------------- */

CREATE TABLE devices (
  device_id    VARCHAR(50)  PRIMARY KEY,                                   -- e.g. CAM-001, qs3490EAB52026
  device_type  VARCHAR(20)  NOT NULL CHECK (device_type IN ('ip_camera', 'motion_sensor', 'qstat', 'drager')),
  name         VARCHAR(100) NOT NULL,
  location     VARCHAR(100) NOT NULL DEFAULT 'Device Store',
  status       VARCHAR(10)  NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline')),
  patient_id   VARCHAR(20)  REFERENCES patients (id) ON UPDATE CASCADE ON DELETE SET NULL,
  last_seen_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- A patient has at most one device of each type.
CREATE UNIQUE INDEX devices_one_type_per_patient ON devices (patient_id, device_type) WHERE patient_id IS NOT NULL;
CREATE INDEX devices_type_idx ON devices (device_type);

CREATE TABLE ip_cameras (
  device_id        VARCHAR(50) PRIMARY KEY REFERENCES devices (device_id) ON UPDATE CASCADE ON DELETE CASCADE,
  ip_address       VARCHAR(45) NOT NULL,
  stream_url       TEXT        NOT NULL,
  resolution       VARCHAR(20) NOT NULL DEFAULT '1920x1080',
  fps              INTEGER     NOT NULL DEFAULT 30 CHECK (fps BETWEEN 1 AND 120),
  motion_detection BOOLEAN     NOT NULL DEFAULT true,
  recording        BOOLEAN     NOT NULL DEFAULT false
);

CREATE TABLE motion_sensors (
  device_id     VARCHAR(50) PRIMARY KEY REFERENCES devices (device_id) ON UPDATE CASCADE ON DELETE CASCADE,
  accel_x       REAL,
  accel_y       REAL,
  accel_z       REAL,
  gyro_x        REAL,
  gyro_y        REAL,
  gyro_z        REAL,
  mag_x         REAL,
  mag_y         REAL,
  mag_z         REAL,
  motion_status VARCHAR(10) CHECK (motion_status IN ('moving', 'still', 'unknown')),
  battery_level SMALLINT    CHECK (battery_level BETWEEN 0 AND 100),
  temperature   REAL
);

CREATE TABLE qstat_monitors (
  device_id        VARCHAR(50) PRIMARY KEY REFERENCES devices (device_id) ON UPDATE CASCADE ON DELETE CASCADE,
  heart_rate       SMALLINT,
  spo2             SMALLINT,
  respiratory_rate SMALLINT,
  temperature      REAL,
  systolic_bp      SMALLINT,
  diastolic_bp     SMALLINT,
  alarm_active     BOOLEAN     NOT NULL DEFAULT false,
  alarm_message    TEXT
);

CREATE TABLE drager_monitors (
  device_id        VARCHAR(50) PRIMARY KEY REFERENCES devices (device_id) ON UPDATE CASCADE ON DELETE CASCADE,
  heart_rate       SMALLINT,
  spo2             SMALLINT,
  respiratory_rate SMALLINT,
  temperature      REAL,
  systolic_bp      SMALLINT,
  diastolic_bp     SMALLINT,
  alarm_active     BOOLEAN     NOT NULL DEFAULT false,
  alarm_severity   VARCHAR(20),
  alarm_message    TEXT
);

/* ------------------------------ Events ----------------------------- */

CREATE TABLE events (
  id          BIGSERIAL    PRIMARY KEY,
  device_id   VARCHAR(50)  NOT NULL REFERENCES devices (device_id) ON UPDATE CASCADE ON DELETE CASCADE,
  device_type VARCHAR(20)  NOT NULL,
  category    VARCHAR(30)  NOT NULL,
  sub_type    VARCHAR(50),
  topic       VARCHAR(255) NOT NULL,
  data        JSONB        NOT NULL,
  device_ts   TIMESTAMPTZ,
  received_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX events_category_idx ON events (category);
CREATE INDEX events_device_time_idx ON events (device_id, received_at DESC);

/* ---------------------------- Audit log ---------------------------- */

CREATE TABLE audit_logs (
  id            BIGSERIAL   PRIMARY KEY,
  actor_user_id UUID        REFERENCES users (id) ON DELETE SET NULL,
  action        VARCHAR(60) NOT NULL,
  entity_type   VARCHAR(40) NOT NULL,
  entity_id     VARCHAR(64),
  metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
