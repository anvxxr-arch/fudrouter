-- 0035_economic_enforce.rollback.sql — undo migration 0035 exactly.
--
-- NOT applied by the `for f in migrations/*.sql` loop: it lives in ops/rollback/
-- on purpose, so a fresh-database replay can never run the undo step.
--
-- Drops the six CHECKs and the NOT NULL that 0035 added, returning the columns
-- to the 0033 shape. It NEVER rewrites row data: the rows a writer emitted while
-- 0035 was live keep their bucket/basis values, so history survives the revert.
-- This is the documented rollback for F2 (§9): "0035 dropped -> passthrough".
--
-- Idempotent: `DROP CONSTRAINT IF EXISTS`; `DROP NOT NULL` on an already-nullable
-- column is a no-op.
--
-- Apply with a single transaction so a half-undone schema is impossible:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f ops/rollback/0035_economic_enforce.rollback.sql
-- No BEGIN/COMMIT in the file itself, matching 0030–0032.

ALTER TABLE "request_log" DROP CONSTRAINT IF EXISTS "request_log_unknown_cogs_check";
ALTER TABLE "request_log" DROP CONSTRAINT IF EXISTS "request_log_subscription_flat_check";
ALTER TABLE "request_log" DROP CONSTRAINT IF EXISTS "request_log_farm_zero_check";
ALTER TABLE "request_log" DROP CONSTRAINT IF EXISTS "request_log_markup_basis_check";
ALTER TABLE "request_log" DROP CONSTRAINT IF EXISTS "request_log_cost_basis_check";
ALTER TABLE "request_log" DROP CONSTRAINT IF EXISTS "request_log_billing_basis_check";

ALTER TABLE "credential" DROP CONSTRAINT IF EXISTS "credential_acquisition_check";

ALTER TABLE "subscription" DROP CONSTRAINT IF EXISTS "subscription_bucket_check";
ALTER TABLE "api_key" DROP CONSTRAINT IF EXISTS "api_key_bucket_check";
ALTER TABLE "billing_account" DROP CONSTRAINT IF EXISTS "billing_account_bucket_check";

ALTER TABLE "billing_account" ALTER COLUMN "bucket" DROP NOT NULL;
