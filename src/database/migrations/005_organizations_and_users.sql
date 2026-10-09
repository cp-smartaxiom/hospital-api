-- Multi-tenant auth: organizations (tenants), their users, and login sessions.
-- gen_random_uuid() is built into PostgreSQL 13+.

CREATE TABLE organizations (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name       VARCHAR(150) NOT NULL CHECK (length(trim(name)) >= 2),
  slug       VARCHAR(80)  NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  status     VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE users (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID         NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  full_name       VARCHAR(100) NOT NULL,
  email           VARCHAR(254) NOT NULL CHECK (email = lower(email)),   -- stored normalized
  password_hash   VARCHAR(255) NOT NULL,
  role            VARCHAR(20)  NOT NULL CHECK (role IN ('SUPERADMIN', 'DOCTOR', 'OPERATOR')),
  status          VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- One account per email across the whole application (login is by email only).
CREATE UNIQUE INDEX users_email_unique ON users (email);
CREATE INDEX users_organization_idx ON users (organization_id);

-- Server-side sessions. Only the SHA-256 of the cookie token is stored, so a DB leak can't be replayed.
CREATE TABLE user_sessions (
  id           BIGSERIAL   PRIMARY KEY,
  user_id      UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   CHAR(64)    NOT NULL UNIQUE,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX user_sessions_user_idx ON user_sessions (user_id);
