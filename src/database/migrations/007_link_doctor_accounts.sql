-- Link Doctor login accounts (users, role DOCTOR) to the doctors directory used by the Doctors page,
-- patient assignment and department counts. Linked rows are kept in sync by the user-management API
-- (name, email, phone, primary department, status); unlinked doctors work exactly as before.

ALTER TABLE doctors
  ADD COLUMN user_id UUID UNIQUE REFERENCES users (id) ON DELETE SET NULL;

-- Login emails can be up to 254 characters.
ALTER TABLE doctors ALTER COLUMN email TYPE VARCHAR(254);

-- Backfill doctor accounts invited before this migration: reuse a doctor with the same email if one
-- exists, otherwise add a new D-### entry in the doctor's first department.
DO $$
DECLARE
  u RECORD;
  dept VARCHAR(30);
  next_id INT;
BEGIN
  FOR u IN
    SELECT us.id, us.full_name, us.email, us.phone, us.status
    FROM users us
    WHERE us.role = 'DOCTOR'
      AND NOT EXISTS (SELECT 1 FROM doctors d WHERE d.user_id = us.id)
    ORDER BY us.created_at
  LOOP
    SELECT a.department_id INTO dept
    FROM user_department_assignments a
    JOIN departments dep ON dep.id = a.department_id
    WHERE a.user_id = u.id
    ORDER BY dep.sort_order
    LIMIT 1;
    CONTINUE WHEN dept IS NULL;

    UPDATE doctors
    SET user_id = u.id, name = u.full_name, phone = COALESCE(u.phone, phone),
        status = CASE WHEN u.status = 'DISABLED' THEN 'inactive' ELSE 'active' END, updated_at = NOW()
    WHERE lower(email) = u.email AND user_id IS NULL;

    IF NOT FOUND THEN
      SELECT COALESCE(MAX(substring(id FROM 3)::int), 0) + 1 INTO next_id FROM doctors;
      INSERT INTO doctors (id, name, department_id, phone, email, status, user_id)
      VALUES ('D-' || lpad(next_id::text, 3, '0'), u.full_name, dept, u.phone, u.email,
              CASE WHEN u.status = 'DISABLED' THEN 'inactive' ELSE 'active' END, u.id);
    END IF;
  END LOOP;
END $$;
