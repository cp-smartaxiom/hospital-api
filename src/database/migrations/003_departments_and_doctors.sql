-- Departments (fixed reference list), doctors, and patients.doctor_id replacing the free-text
-- attending_physician column.

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

CREATE TABLE doctors (
  id            VARCHAR(20)  PRIMARY KEY CHECK (id ~ '^D-[0-9]{3,}$'),   -- e.g. D-001
  name          VARCHAR(100) NOT NULL,
  department_id VARCHAR(30)  NOT NULL REFERENCES departments (id) ON UPDATE CASCADE,
  phone         VARCHAR(20),
  email         VARCHAR(150),
  status        VARCHAR(10)  NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX doctors_email_unique ON doctors (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX doctors_department_idx ON doctors (department_id);

-- A doctor with patients can't be deleted (reassign the patients first).
ALTER TABLE patients
  ADD COLUMN doctor_id VARCHAR(20) REFERENCES doctors (id) ON UPDATE CASCADE ON DELETE RESTRICT;

-- Keep existing data: turn each distinct attending_physician text into a doctor record
-- (department defaults to Critical Care; edit it from the UI) and link the patients.
INSERT INTO doctors (id, name, department_id)
SELECT 'D-' || lpad(row_number() OVER (ORDER BY doctor_name)::text, 3, '0'), doctor_name, 'critical_care'
FROM (
  SELECT DISTINCT trim(attending_physician) AS doctor_name
  FROM patients
  WHERE trim(attending_physician) <> ''
) names;

UPDATE patients p
SET doctor_id = d.id
FROM doctors d
WHERE d.name = trim(p.attending_physician);

ALTER TABLE patients DROP COLUMN attending_physician;
