-- Raw device events received over MQTT, one row per message.
-- Topic: sa/<device_type>/<device_id>/monitoring/<category>[/<sub_type>]
-- Devices seen for the first time are auto-created in `devices` (see event.controller.js).

CREATE TABLE events (
  id           BIGSERIAL    PRIMARY KEY,
  device_id    VARCHAR(50)  NOT NULL
               REFERENCES devices (device_id) ON UPDATE CASCADE ON DELETE CASCADE,
  device_type  VARCHAR(20)  NOT NULL,
  category     VARCHAR(30)  NOT NULL,             -- vitals, activity, environment, alert
  sub_type     VARCHAR(50),                       -- spo2, skin_temperature (NULL for the main topic)
  topic        VARCHAR(255) NOT NULL,
  data         JSONB        NOT NULL,             -- payload exactly as the device sent it
  device_ts    TIMESTAMPTZ,                       -- from payload.archived_ts
  received_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX events_device_time_idx ON events (device_id, received_at DESC);
CREATE INDEX events_category_idx ON events (category);
