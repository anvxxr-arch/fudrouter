-- 0034_economic_cost.rollback.sql — undo migration 0034 exactly.
--
-- NOT applied by the `for f in migrations/*.sql` loop: it lives in ops/rollback/
-- on purpose, so a fresh-database replay can never run the undo step.
--
-- Drops the three tables 0034 created, in reverse dependency order. Their
-- indexes and the seeded frsubs quota rows go with the tables, so there is
-- nothing to delete separately. No row in any pre-existing table is touched:
-- 0034 only added new tables, so the revert cannot lose billing history.
--
-- Idempotent: `DROP TABLE IF EXISTS`, so a second run finds nothing.
--
-- Apply with a single transaction so a half-undone schema is impossible:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f ops/rollback/0034_economic_cost.rollback.sql
-- No BEGIN/COMMIT in the file itself, matching 0030–0032.

DROP TABLE IF EXISTS "bucket_quota";
DROP TABLE IF EXISTS "bucket_margin";
DROP TABLE IF EXISTS "provider_cost_rule";
