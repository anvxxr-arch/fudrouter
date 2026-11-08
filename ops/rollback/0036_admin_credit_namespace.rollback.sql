-- 0036_admin_credit_namespace.rollback.sql — undo migration 0036 exactly.
--
-- NOT applied by the `for f in migrations/*.sql` loop: it lives in ops/rollback/
-- on purpose, so a fresh-database replay can never run the undo step.
--
-- Restores each migrated row's original idempotency_key from the
-- `metadata.idempotency_key_prev` value 0036 recorded before the rename, then
-- drops the marker. Rows written AFTER the cutover under `admin_credit:` carry
-- no `idempotency_key_prev`, so the `metadata ? 'idempotency_key_prev'` guard
-- leaves them untouched — the revert is scoped to exactly the rows 0036 moved.
--
-- CAVEAT (operator: read first): `purchase:` is reserved for the payment gateway
-- (FR-revised §S5), so rolling back re-opens the namespace clash 0036 closed.
-- Only run this to unwind the migration BEFORE the gateway writer is live.
--
-- IDEMPOTENT: the marker is removed in the same statement, so a second run finds
-- no rows with `idempotency_key_prev` and does nothing.
--
-- Apply with a single transaction so a half-undone state is impossible:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f ops/rollback/0036_admin_credit_namespace.rollback.sql

UPDATE "credit_ledger"
   SET "idempotency_key" = "metadata" ->> 'idempotency_key_prev',
       "metadata" = "metadata" - 'idempotency_key_prev'
 WHERE "metadata" ? 'idempotency_key_prev';