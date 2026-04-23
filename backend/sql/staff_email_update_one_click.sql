-- One-click Supabase SQL script
-- Purpose: Update three staff emails from @school.edu.ph -> @uv.edu.ph
-- Scope: ONLY users with role IN ('Admin','Registrar','Accounting')
-- Date: 2026-04-21

-- IMPORTANT: Paste this entire script into the Supabase SQL editor and run.
-- The script will:
--  1) Preview targeted rows
--  2) Backup those rows to `staff_email_migration_backup`
--  3) Abort if any conflicting target emails already exist
--  4) Perform an atomic update and verify exactly 3 rows updated
--  5) Output verification queries
--  6) Provide rollback SQL (in comments) if needed

-- ===== 1) Preview the exact records that will be backed up/updated =====
SELECT id, email, role FROM users
WHERE lower(role) IN ('admin','registrar','accounting')
	AND lower(trim(email)) IN ('admin@school.edu.ph','registrar.office@school.edu.ph','accounting.office@school.edu.ph');

-- ===== 2) Backup the targeted rows (safe copy) =====
DROP TABLE IF EXISTS staff_email_migration_backup;
CREATE TABLE staff_email_migration_backup AS
SELECT * FROM users
WHERE lower(role) IN ('admin','registrar','accounting')
	AND lower(trim(email)) IN ('admin@school.edu.ph','registrar.office@school.edu.ph','accounting.office@school.edu.ph');

-- Ensure `updated_at` column exists so the UPDATE can set it safely
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- ===== 3 & 4) Idempotent conflict check and atomic update =====
DO $$
DECLARE
	old_count int := 0;
	new_count int := 0;
	conflict_count int := 0;
	updated_count int := 0;
BEGIN
	-- Ensure `updated_at` exists in this transaction
	BEGIN
		EXECUTE 'ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at timestamptz';
	EXCEPTION WHEN OTHERS THEN
		RAISE NOTICE 'Could not ensure updated_at column exists: %', SQLERRM;
	END;

	-- Count rows currently using the OLD and NEW emails among staff roles
	SELECT count(*) INTO old_count FROM users
	WHERE lower(role) IN ('admin','registrar','accounting')
	AND lower(trim(email)) IN ('admin@school.edu.ph','registrar.office@school.edu.ph','accounting.office@school.edu.ph');

	SELECT count(*) INTO new_count FROM users
	WHERE lower(role) IN ('admin','registrar','accounting')
	AND lower(trim(email)) IN ('admin@uv.edu.ph','registrar.office@uv.edu.ph','accounting.office@uv.edu.ph');

	-- If already fully migrated, succeed without error
	IF new_count = 3 THEN
		RAISE NOTICE 'Migration already applied: % rows found with new emails. Nothing to do.', new_count;
		RETURN;
	END IF;

	-- If no old rows exist but migration isn't complete, abort and require manual check
	IF old_count = 0 AND new_count < 3 THEN
		RAISE EXCEPTION 'No matching old emails found (%), and not all new emails present (%). Manual investigation required.', old_count, new_count;
	END IF;

	-- Check for conflicting new emails used by non-staff or unexpected rows
	SELECT count(*) INTO conflict_count FROM users
	WHERE lower(trim(email)) IN ('admin@uv.edu.ph','registrar.office@uv.edu.ph','accounting.office@uv.edu.ph')
	  AND NOT (lower(role) IN ('admin','registrar','accounting')
			   AND lower(trim(email)) IN ('admin@uv.edu.ph','registrar.office@uv.edu.ph','accounting.office@uv.edu.ph'));

	IF conflict_count > 0 THEN
		RAISE EXCEPTION 'Conflicting email(s) exist (%). Aborting migration.', conflict_count;
	END IF;

	-- Update any remaining old emails
	WITH updated AS (
		UPDATE users
		SET email = CASE
				WHEN lower(trim(email)) = 'admin@school.edu.ph' THEN 'admin@uv.edu.ph'
				WHEN lower(trim(email)) = 'registrar.office@school.edu.ph' THEN 'registrar.office@uv.edu.ph'
				WHEN lower(trim(email)) = 'accounting.office@school.edu.ph' THEN 'accounting.office@uv.edu.ph'
				ELSE email
			END,
			updated_at = now()
		WHERE lower(role) IN ('admin','registrar','accounting')
			AND lower(trim(email)) IN ('admin@school.edu.ph','registrar.office@school.edu.ph','accounting.office@school.edu.ph')
		RETURNING id
	)
	SELECT count(*) INTO updated_count FROM updated;

	-- Recompute new_count and verify final state
	SELECT count(*) INTO new_count FROM users
	WHERE lower(role) IN ('admin','registrar','accounting')
	AND lower(trim(email)) IN ('admin@uv.edu.ph','registrar.office@uv.edu.ph','accounting.office@uv.edu.ph');

	IF new_count <> 3 THEN
		RAISE EXCEPTION 'Post-update verification failed: expected 3 new emails, found %', new_count;
	END IF;

	RAISE NOTICE 'Staff email migration completed: % rows updated (now % with new emails).', updated_count, new_count;
END$$ LANGUAGE plpgsql;

-- ===== 5) Verification queries (should return 3 rows and 0 rows respectively) =====
-- Confirm staff were updated (expected: 3 rows)
-- Confirm staff were updated (expected: 3 rows)
SELECT id, email, role FROM users
WHERE lower(role) IN ('admin','registrar','accounting')
	AND lower(email) IN ('admin@uv.edu.ph','registrar.office@uv.edu.ph','accounting.office@uv.edu.ph');

-- Confirm no non-staff were affected (expected: 0 rows)
SELECT id, email, role FROM users
WHERE role NOT IN ('Admin','Registrar','Accounting')
	AND email IN ('admin@uv.edu.ph','registrar.office@uv.edu.ph','accounting.office@uv.edu.ph');

-- ===== 6) Rollback (if needed) =====
-- Restore from backup (restores the entire backed-up rows)
-- NOTE: this overwrites current values for the backed-up IDs.
-- To restore everything from the backup table run:
--
-- UPDATE users u
-- SET
--   email = b.email,
--   updated_at = now()
-- FROM staff_email_migration_backup b
-- WHERE u.id = b.id;
--
-- Or rollback a single mapping, for example:
-- UPDATE users
-- SET email = 'admin@school.edu.ph', updated_at = now()
-- WHERE email = 'admin@uv.edu.ph' AND role = 'Admin';

-- End of script

