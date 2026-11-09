-- 0039_be_db_hot_path_indexes.sql — index + constraint hardening for the hot
-- money/job queries (BE-DB audit, 2026-11-09, branch hack/be-db).
--
-- FINDINGS THIS MIGRATION CLOSES (each measured on the live `fudrouter` DB,
-- read-only EXPLAIN ANALYZE, 2026-11-09):
--
-- F1  `request_attempt_request_idx` is a byte-identical duplicate of the
--     UNIQUE constraint's own index. 0006 created BOTH
--     `request_attempt_request_attempt_unique (request_id, attempt)` and the
--     plain `request_attempt_request_idx (request_id, attempt)`. The unique
--     index is a strict superset (verified pg_index: same key, indisunique,
--     no partial predicate), so the plain copy is pure write amplification on
--     the second-highest-volume append table (293,885 rows, 190 MB, ~1,700
--     attempt rows/day): every insert maintains two identical B-trees, and
--     the plain index alone costs 20 MB. The FK
--     `request_attempt_request_id_request_log_id_fk ON DELETE cascade` still
--     finds its rows through the unique index's request_id prefix, so nothing
--     is lost.
--
-- F2  `payment` has no index usable by the approval-loop claim scan. The
--     escalation loop (`approval-loop.ts listOpenPayments`) scans
--     `where status = 'claimed' limit N` on every tick, and the live plan for
--     that shape is `Seq Scan on payment (Filter: status = 'claimed')` —
--     measured on the live table. Payments are low-volume today (0 rows), so
--     this is not yet slow, but it is the ONE query that grows linearly with
--     the gateway going live, and the seq scan never improves. A btree on
--     (status, created_at) mirrors `payment_account_created_idx`'s shape and
--     serves both the claim scan and any status+time dashboard read.
--
-- F3  The scheduler's fan-out tick (`scheduler.ts fanOutTargets`) walks
--     `job` with `type = X AND payload->>'providerId' = s.id` per provider
--     and `payload->>'connectionId' = s.id` per connection. Neither payload
--     key is indexed, so the measured plan for the connection lane (30
--     connections, 97,893 jobs) is a Seq Scan of the whole `job` table PER
--     CONNECTION: SubPlan 1 ran 27 times, each a 97,893-row Seq Scan
--     (Buffers: shared hit=57,509; Execution Time 304 ms for ONE tick). The
--     measured fix is an expression index on the two payload keys + type,
--     which serves BOTH fan-out lanes (provider and connection) and drops
--     the tick to 14.5 ms (connection lane) / 1.3 ms (provider lane) with the
--     same rows returned. Without it, the `credential_validation` fan-out
--     re-scans 97k rows x 30 connections every hour, and the cost grows with
--     the job table's completed backlog (45k webhook_delivery + 27k
--     alert_evaluation rows the retention sweep has not yet collected).
--
-- NOT IN THIS MIGRATION (reported, not executed):
--
--   - The 2 corrupt `credit_purchase` postings (5,555,555,555,555,000,000
--     micro each) that make `SUM(amount_micro)` for account
--     `bac_wrk_usr_VjOnC8IZktzGBVXBagJkGJPEhoocKe5L` = 1.111e19, above int64.
--     Those are DATA, not schema: the reviewed, pre-imaged scrub
--     (ops/scrub-balance-anomaly.step1.sql + step2.sql, pre-image
--     ops/rollback/scrub-balance-anomaly.rollback.sql, undo .undo.sql) is the
--     only safe way to remove them, and it is an operator procedure, not a
--     migration.
--
--   - Migrations 0033–0038 are still pending on this database
--     (schema_migration stops at 0032); this file deliberately touches none
--     of their objects, so it applies cleanly before or after them.
--
-- SAFETY: `DROP INDEX` is the only destructive statement and it is verified
-- redundant (the unique index's identical key serves every lookup; the FK
-- cascade is served by the unique index's leading column). All three
-- `CREATE INDEX` statements are PLAIN, not CONCURRENTLY, matching the
-- established runner convention (ops/migrate.sh feeds each file to
-- `psql -f`, and 0014/0015 document that CONCURRENTLY cannot run inside the
-- runner's transaction). The job/payment index builds are small relative to
-- request_log: `job` is 97,893 rows / ~30 MB and `payment` is empty.
--
-- IDEMPOTENT: DROP INDEX IF EXISTS + CREATE INDEX IF NOT EXISTS + the
-- constraint checks are ADD CONSTRAINT-only on tables whose rows cannot
-- violate them (payment/subscription are empty on this database, and the
-- writers already refuse a non-positive amount — payments.ts resolveGrant
-- `amount_mismatch`, postLedger's `RangeError` on a negative debit). Each
-- constraint is dropped-if-exists first, matching 0010/0035/0037.
--
-- ROLLBACK: ops/rollback/0039_be_db_hot_path_indexes.rollback.sql re-creates
-- the dropped index and drops the added ones/constraints.

-- ---------------------------------------------------------------------------
-- F1: drop the duplicate attempt index.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS "request_attempt_request_idx";

-- ---------------------------------------------------------------------------
-- F2: the payment claim scan.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "payment_status_created_idx"
	ON "payment" USING btree ("status", "created_at");

-- ---------------------------------------------------------------------------
-- F3: the scheduler fan-out lookup, both lanes in one index.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "job_fanout_target_idx"
	ON "job" USING btree ((("payload"->>'connectionId')), (("payload"->>'providerId')), "type");

-- ---------------------------------------------------------------------------
-- Money invariants. Whole-rupiah amounts and the window order are the three
-- properties every grant writer already guarantees in application code
-- (payments.ts PLANS are all positive; GrantSubscription derives
-- expires_at = now() + days) — these CHECKs move the guarantee into the
-- database so a future writer cannot mint a zero-rupiah entitlement or an
-- inverted window.
-- ---------------------------------------------------------------------------
ALTER TABLE "payment" DROP CONSTRAINT IF EXISTS "payment_amount_idr_positive_check";
ALTER TABLE "payment" ADD CONSTRAINT "payment_amount_idr_positive_check"
	CHECK ("amount_idr" > 0);

ALTER TABLE "subscription" DROP CONSTRAINT IF EXISTS "subscription_price_idr_positive_check";
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_price_idr_positive_check"
	CHECK ("price_idr" > 0);

ALTER TABLE "subscription" DROP CONSTRAINT IF EXISTS "subscription_window_order_check";
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_window_order_check"
	CHECK ("expires_at" > "starts_at");
