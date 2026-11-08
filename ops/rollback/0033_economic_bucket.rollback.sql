-- 0033_economic_bucket.rollback.sql — undo migration 0033 exactly.
--
-- NOT applied by the `for f in migrations/*.sql` loop: it lives in ops/rollback/
-- on purpose, so a fresh-database replay can never run the undo step.
--
-- Drops exactly the columns, table and indexes 0033 added. The backfill 0033
-- performed (bucket='frpayg', basis retail/retail, markup 1.0, acquisition
-- 'unknown') is NOT reversed: those values were the honest passthrough of every
-- pre-0033 row, and deleting the columns is the revert — the numbers never
-- existed as separate state before 0033. `cost`/`provider_cost_micro` on the
-- rows are untouched, so billing history is unchanged.
--
-- Order matters: the partial index and the plain index are dropped before their
-- columns, and `provider_model_supply` goes before the columns that reference
-- its vocabulary only by value.
--
-- Idempotent: `DROP ... IF EXISTS` throughout, so a second run finds nothing and
-- does nothing.
--
-- Apply with a single transaction so a half-undone schema is impossible:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f ops/rollback/0033_economic_bucket.rollback.sql
-- No BEGIN/COMMIT in the file itself, matching 0030–0032: the test drives it
-- inside its own transaction.

DROP INDEX IF EXISTS "request_log_user_quota_idx";
DROP INDEX IF EXISTS "request_log_bucket_created_idx";

ALTER TABLE "request_log" DROP COLUMN IF EXISTS "cogs_estimated_micro";
ALTER TABLE "request_log" DROP COLUMN IF EXISTS "quota_usage_micro";
ALTER TABLE "request_log" DROP COLUMN IF EXISTS "markup_millionths";
ALTER TABLE "request_log" DROP COLUMN IF EXISTS "cost_basis";
ALTER TABLE "request_log" DROP COLUMN IF EXISTS "billing_basis";
ALTER TABLE "request_log" DROP COLUMN IF EXISTS "supply_bucket";
ALTER TABLE "request_log" DROP COLUMN IF EXISTS "bucket";

DROP TABLE IF EXISTS "provider_model_supply";

ALTER TABLE "credential" DROP COLUMN IF EXISTS "cost_basis_micro_per_day";
ALTER TABLE "credential" DROP COLUMN IF EXISTS "acquisition";

ALTER TABLE "subscription" DROP COLUMN IF EXISTS "economic_bucket";
ALTER TABLE "api_key" DROP COLUMN IF EXISTS "economic_bucket";
ALTER TABLE "billing_account" DROP COLUMN IF EXISTS "bucket";
