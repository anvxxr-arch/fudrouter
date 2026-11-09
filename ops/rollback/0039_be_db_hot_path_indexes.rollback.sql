-- 0039_be_db_hot_path_indexes.rollback.sql — revert exactly what 0039 applied.
--
-- Restores the dropped duplicate attempt index (0006 shipped it; the rollback
-- keeps the pre-0039 shape even though the index is redundant, so a revert
-- never leaves the schema materially different from what the runner last
-- knew), drops the two payment/subscription indexes 0039 added, and restores
-- the constraint set to its 0038 shape.
--
-- IDEMPOTENT: every statement is IF EXISTS / IF NOT EXISTS. Replaying this
-- file converges.
--
-- ROLLBACK OF ROLLBACK: re-apply 0039_be_db_hot_path_indexes.sql.

-- F1 rollback: restore the (redundant, but pre-existing) attempt index.
CREATE INDEX IF NOT EXISTS "request_attempt_request_idx"
	ON "request_attempt" USING btree ("request_id", "attempt");

-- F2 rollback: drop the payment claim-scan index.
DROP INDEX IF EXISTS "payment_status_created_idx";

-- F3 rollback: drop the fan-out payload index.
DROP INDEX IF EXISTS "job_fanout_target_idx";

-- Money invariants rollback: drop the three CHECKs 0039 added.
ALTER TABLE "payment" DROP CONSTRAINT IF EXISTS "payment_amount_idr_positive_check";
ALTER TABLE "subscription" DROP CONSTRAINT IF EXISTS "subscription_price_idr_positive_check";
ALTER TABLE "subscription" DROP CONSTRAINT IF EXISTS "subscription_window_order_check";
