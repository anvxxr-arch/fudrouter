-- Rollback for 0038_subscription_payment_id_uniq.sql.
-- Drops exactly the index that migration adds.

DROP INDEX IF EXISTS "subscription_payment_id_uniq";