-- Phase 2 · User management: Doctor/Operator accounts invited by the organization's Superadmin.
-- Extends the Phase 1 users table (no data is changed) and adds department assignments,
-- single-use invitation tokens and an audit log.

-- Invited users have no password until they accept the invitation.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE users DROP CONSTRAINT users_status_check;
ALTER TABLE users
  ADD CONSTRAINT users_status_check CHECK (status IN ('INVITED', 'ACTIVE', 'DISABLED')),
  -- An account can only be ACTIVE once it has a password.
  ADD CONSTRAINT users_active_has_password CHECK (status <> 'ACTIVE' OR password_hash IS NOT NULL);

ALTER TABLE users
  ADD COLUMN phone          VARCHAR(20),
  ADD COLUMN specialization VARCHAR(100),
  ADD COLUMN license_number VARCHAR(50),
  ADD COLUMN created_by     UUID REFERENCES users (id) ON DELETE SET NULL;

-- License / registration numbers are unique inside a hospital.
CREATE UNIQUE INDEX users_org_license_unique ON users (organization_id, lower(license_number))
  WHERE license_number IS NOT NULL;
CREATE INDEX users_org_role_idx ON users (organization_id, role);

-- Departments are the shared reference list from 003 (same codes the Doctors page uses).
CREATE TABLE user_department_assignments (
  user_id       UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  department_id VARCHAR(30) NOT NULL REFERENCES departments (id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, department_id)
);

CREATE INDEX user_department_assignments_department_idx ON user_department_assignments (department_id);

-- Password-setup links. Only the SHA-256 of the token is stored; each one is single-use and expires.
CREATE TABLE user_invitations (
  id              BIGSERIAL   PRIMARY KEY,
  organization_id UUID        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash      CHAR(64)    NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  created_by      UUID        REFERENCES users (id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX user_invitations_user_idx ON user_invitations (user_id, created_at DESC);

-- Administrative actions per organization. Metadata never contains passwords or tokens.
CREATE TABLE audit_logs (
  id              BIGSERIAL    PRIMARY KEY,
  organization_id UUID         NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  actor_user_id   UUID         REFERENCES users (id) ON DELETE SET NULL,
  action          VARCHAR(60)  NOT NULL,
  entity_type     VARCHAR(40)  NOT NULL,
  entity_id       VARCHAR(64),
  metadata        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_logs_org_created_idx ON audit_logs (organization_id, created_at DESC);
