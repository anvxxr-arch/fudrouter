-- 0037_billing_account_quarantine.rollback.sql — undo migration 0037 exactly.
--
-- NOT applied by the `for f in migrations/*.sql` loop: it lives in ops/rollback/
-- on purpose, so a fresh-database replay can never run the undo step.
--
-- Restores billing_account_status_check to the 0006 vocabulary
-- ('active','suspended','closed'). It NEVER rewrites row data: a quarantined
-- account keeps its status, which is the manual-triage contract — an operator
-- must review and set the account back to 'active' deliberately.
--
-- Apply with a single transaction:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f ops/rollback/0037_billing_account_quarantine.rollback.sql
-- No BEGIN/COMMIT in the file itself, matching 0030–0035.

ALTER TABLE "billing_account" DROP CONSTRAINT IF EXISTS "billing_account_status_check";
ALTER TABLE "billing_account" ADD CONSTRAINT "billing_account_status_check"
	CHECK ("status" IN ('active', 'suspended', 'closed'));