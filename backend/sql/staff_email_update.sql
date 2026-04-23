-- Staff email migration SQL
-- Updates staff emails from @school.edu.ph to @uv.edu.ph
-- Only affects users with role IN ('Admin','Registrar','Accounting')

BEGIN;

-- Safety: only update the three targeted emails and only for staff roles
UPDATE users
SET email = CASE
    WHEN email = 'admin@school.edu.ph' THEN 'admin@uv.edu.ph'
    WHEN email = 'registrar.office@school.edu.ph' THEN 'registrar.office@uv.edu.ph'
    WHEN email = 'accounting.office@school.edu.ph' THEN 'accounting.office@uv.edu.ph'
    ELSE email
END,
updated_at = now()
WHERE role IN ('Admin','Registrar','Accounting')
  AND email IN ('admin@school.edu.ph','registrar.office@school.edu.ph','accounting.office@school.edu.ph');

COMMIT;

-- Verification: confirm the targeted staff emails were updated (should return 3 rows)
-- SELECT id, email, role FROM users
-- WHERE role IN ('Admin','Registrar','Accounting')
--   AND email IN ('admin@uv.edu.ph','registrar.office@uv.edu.ph','accounting.office@uv.edu.ph');

-- Double-check no students were affected (should return 0 rows)
-- SELECT id, email, role FROM users
-- WHERE role NOT IN ('Admin','Registrar','Accounting')
--   AND email IN ('admin@uv.edu.ph','registrar.office@uv.edu.ph','accounting.office@uv.edu.ph');
