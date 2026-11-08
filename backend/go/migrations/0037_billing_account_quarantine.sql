-- 0037_billing_account_quarantine.sql — add 'quarantine' to billing_account.status.
--
-- A2 (FR-revised §S1/P1.2, §7 invariant 4): reconcileAll must NOT cast an
-- out-of-int64 ledger sum to bigint, and must NOT silently skip the account.
-- The isolation action is `status='quarantine'` + an audit row for manual
-- triage. The Go admission gate (proxy/budget.go checkBudgets) already refuses
-- any `status <> 'active'`, so a quarantined account is cut off from spending
-- its unbounded balance the moment this vocabulary exists.
--
-- WHY WIDEN, NOT REPLACE: 0006 pins the CHECK to ('active','suspended',
-- 'closed'). Dropping and re-adding in one file with a wider set keeps the same
-- vocabulary plus the new value; a value migration is not needed — nothing
-- writes 'quarantine' yet until reconcileAll's isolate-exclude branch lands in
-- the same commit.
--
-- IDEMPOTENT: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT, matching 0010/0035.
-- Replay converges.
--
-- ROLLBACK: ops/rollback/0037_billing_account_quarantine.rollback.sql restores
-- the CHECK to ('active','suspended','closed'). It never rewrites row data: a
-- quarantined account stays quarantined after revert unless an operator sets it
-- back, which is the manual-triage contract.

BEGIN;

ALTER TABLE "billing_account" DROP CONSTRAINT IF EXISTS "billing_account_status_check";
ALTER TABLE "billing_account" ADD CONSTRAINT "billing_account_status_check"
	CHECK ("status" IN ('active', 'suspended', 'closed', 'quarantine'));

COMMIT;