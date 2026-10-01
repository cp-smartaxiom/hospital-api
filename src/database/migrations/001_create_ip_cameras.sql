-- IP cameras (device_type = 'ip_camera').
-- Column names mirror the device JSON used by the UI.

CREATE TABLE IF NOT EXISTS ip_cameras (
  id               SERIAL       PRIMARY KEY,
  device_id        VARCHAR(50)  NOT NULL UNIQUE,                 -- e.g. CAM-001
  name             VARCHAR(100) NOT NULL,
  location         VARCHAR(100) NOT NULL DEFAULT 'Device Store',
  status           VARCHAR(10)  NOT NULL DEFAULT 'offline'
                   CHECK (status IN ('online', 'offline')),
  patient_id       VARCHAR(20),                                  -- e.g. P-001; NULL = available
  ip_address       VARCHAR(45)  NOT NULL,
  stream_url       TEXT         NOT NULL,
  resolution       VARCHAR(20)  NOT NULL DEFAULT '1920x1080',
  fps              INTEGER      NOT NULL DEFAULT 30 CHECK (fps BETWEEN 1 AND 120),
  motion_detection BOOLEAN      NOT NULL DEFAULT TRUE,
  recording        BOOLEAN      NOT NULL DEFAULT FALSE,
  last_seen_at     TIMESTAMPTZ,                                  -- last heartbeat from the camera
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- A patient can have at most one IP camera.
CREATE UNIQUE INDEX IF NOT EXISTS ip_cameras_one_per_patient
  ON ip_cameras (patient_id)
  WHERE patient_id IS NOT NULL;
