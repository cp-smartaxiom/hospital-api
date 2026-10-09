-- Database per hospital. From here on hospital_db is the central registry only:
--   organizations     + db_name of each hospital's own database (hms_<slug>)
--   user_directory    email → hospital, so login knows which database to open
--   user_sessions     + organization_id (users themselves live in the hospital database)
--   user_invitations  token → hospital (the invited user lives in the hospital database)
--   device_registry   device id → hospital, so MQTT messages reach the right database
-- Each hospital's users, departments, doctors, patients, devices and events live in its own
-- database (src/database/tenant-migrations). Existing tables here are left untouched; copy their
-- data into a hospital database with `npm run tenants:split`.

ALTER TABLE organizations
  ADD COLUMN db_name VARCHAR(63) UNIQUE CHECK (db_name ~ '^hms_[a-z0-9_]{1,59}$');

-- PROVISIONING: signup is creating the hospital database; nobody can log in yet.
ALTER TABLE organizations DROP CONSTRAINT organizations_status_check;
ALTER TABLE organizations
  ADD CONSTRAINT organizations_status_check CHECK (status IN ('PROVISIONING', 'ACTIVE', 'SUSPENDED'));

-- One login email per account across all hospitals.
CREATE TABLE user_directory (
  email           VARCHAR(254) PRIMARY KEY CHECK (email = lower(email)),
  user_id         UUID         NOT NULL UNIQUE,
  organization_id UUID         NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX user_directory_organization_idx ON user_directory (organization_id);

INSERT INTO user_directory (email, user_id, organization_id, created_at)
SELECT email, id, organization_id, created_at FROM users;

-- Sessions and invitations point at users in hospital databases, so no FK to the old users table.
ALTER TABLE user_sessions ADD COLUMN organization_id UUID REFERENCES organizations (id) ON DELETE CASCADE;
UPDATE user_sessions s SET organization_id = u.organization_id FROM users u WHERE u.id = s.user_id;
DELETE FROM user_sessions WHERE organization_id IS NULL;
ALTER TABLE user_sessions ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE user_sessions DROP CONSTRAINT IF EXISTS user_sessions_user_id_fkey;

ALTER TABLE user_invitations
  DROP CONSTRAINT IF EXISTS user_invitations_user_id_fkey,
  DROP CONSTRAINT IF EXISTS user_invitations_created_by_fkey;

CREATE TABLE device_registry (
  device_id       VARCHAR(50) PRIMARY KEY,
  organization_id UUID        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX device_registry_organization_idx ON device_registry (organization_id);
