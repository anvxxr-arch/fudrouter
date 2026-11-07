-- 0030_merge_depth_publish.rollback.sql — undo migration 0030 exactly.
--
-- NOT applied by the `for f in migrations/*.sql` loop: it lives in ops/rollback/
-- on purpose, so a fresh-database replay can never run the undo step.
--
-- The rollback reads provider_model_merge_audit instead of a hardcoded id list.
-- That is what makes it safe against a catalogue that moved on: a mapping that
-- this migration did NOT create is never touched, and a mapping an operator has
-- since repointed (prev_model_id set) is restored to its previous identity
-- rather than deleted.
--
-- Idempotent: a second run finds nothing to restore and nothing to delete.
--
-- Apply with a single transaction so a half-undone catalogue is impossible:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f ops/rollback/0030_merge_depth_publish.rollback.sql
-- No BEGIN/COMMIT in the file itself, for the same reason as the migration: the
-- test drives it inside its own transaction.

-- Repointed rows go back to their previous identity/state.
UPDATE "provider_model" pm
SET "model_id" = a."prev_model_id",
    "enabled"  = a."prev_enabled",
    "status"   = a."prev_status",
    "updated_at" = now()
FROM "provider_model_merge_audit" a
WHERE a."pm_id" = pm."id"
  AND a."migration" = '0030_merge_depth_publish'
  AND a."prev_model_id" IS NOT NULL;

-- Created rows are removed. prev_model_id IS NULL is the marker for "inserted
-- by this migration".
DELETE FROM "provider_model" pm
USING "provider_model_merge_audit" a
WHERE a."pm_id" = pm."id"
  AND a."migration" = '0030_merge_depth_publish'
  AND a."prev_model_id" IS NULL;

DELETE FROM "provider_model_merge_audit" a
WHERE a."migration" = '0030_merge_depth_publish';
