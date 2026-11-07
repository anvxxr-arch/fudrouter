-- 0031_virtual_allowlist_live_idx.rollback.sql — undo migration 0031 exactly.
--
-- NOT applied by the `for f in migrations/*.sql` loop: it lives in ops/rollback/
-- on purpose, so a fresh-database replay can never run the undo step.
--
-- The migration creates exactly one object and this drops exactly that object.
-- There is no data to restore and nothing to re-point, which is what makes the
-- rollback trivially safe: an index is a redundant structure over rows the
-- table already holds, so dropping it can only cost the planner a better path.
-- The query it accelerates stays correct, just slower (measured 3.6 ms -> 69 ms
-- on the 2026-11-04 catalogue).
--
-- Idempotent: a second run finds no index and does nothing.
--
-- Apply with a single transaction so a half-undone schema is impossible:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f ops/rollback/0031_virtual_allowlist_live_idx.rollback.sql
-- No BEGIN/COMMIT in the file itself, for the same reason as the migration: the
-- test drives it inside its own transaction.

DROP INDEX IF EXISTS "request_attempt_live_idx";
