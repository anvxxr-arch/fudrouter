-- scrub-balance-anomaly.undo.sql — revert an applied scrub-balance-anomaly repair.
--
-- Companions: `ops/rollback/scrub-balance-anomaly.rollback.sql` (pre-image capture,
-- run BEFORE the repair) and `ops/scrub-balance-anomaly.sql` (the report/repair).
-- Read the header of the capture file for why capture and undo are two files.
--
-- What this restores:
--   1. `credit_ledger.amount_micro` and `.description` on every row present in
--      `credit_ledger_scrub_preimage` back to the captured originals. The repair
--      set `amount_micro = 0` and appended a provenance suffix to `description`;
--      this puts BOTH back exactly as they were.
--   2. `billing_account.balance_micro` (and `updated_at`) on every account in
--      `billing_account_scrub_preimage`. Step 2 rewrote this cache; re-deriving it
--      from the restored ledger is impossible (the restored SUM overflows int64),
--      so the literal captured value is written back.
--
-- It does NOT drop the pre-image tables. Keeping them makes the undo itself
-- reversible (re-run the repair, then this undo again) and keeps the audit trail
-- of the original values available. Dropping them is a separate, deliberate act
-- once the operator has signed off and the backup has aged past retention.
--
-- Idempotent: both updates carry `IS DISTINCT FROM`, so a second undo finds the
-- rows already restored and updates 0. It cannot "double-restore" a value.
--
-- Scope: only rows/accounts that were captured. A database that was never
-- scrubbed has empty pre-image tables and this file is a no-op.
--
-- Usage:
--   psql "$DSN" -v ON_ERROR_STOP=1 -1 -f ops/rollback/scrub-balance-anomaly.undo.sql
--
-- Verify after: the pre-image tables and the live rows must agree — a checksum
-- over (id, amount_micro, description) on both sides must match for the captured
-- ids. `ops/verify/scrub-gates.sql` checks this as V6.

-- 1. Ledger: original amount + description. `IS DISTINCT FROM` handles NULL
-- descriptions (the repair's `coalesce(description,'')` turns a NULL into a
-- non-NULL string, so a naive `<>` would drop the row and leave the '' behind).
UPDATE credit_ledger c
   SET amount_micro = p.original_amount_micro,
       description  = p.original_description
  FROM credit_ledger_scrub_preimage p
 WHERE p.id = c.id
   AND (c.amount_micro IS DISTINCT FROM p.original_amount_micro
     OR c.description  IS DISTINCT FROM p.original_description);

-- 2. Cache: captured prior balance + updated_at. Deliberately a literal write,
-- not a re-derive: see the header. Scoped to the captured accounts only.
UPDATE billing_account b
   SET balance_micro = p.original_balance_micro,
       updated_at    = p.original_updated_at
  FROM billing_account_scrub_preimage p
 WHERE p.id = b.id
   AND (b.balance_micro IS DISTINCT FROM p.original_balance_micro
     OR b.updated_at    IS DISTINCT FROM p.original_updated_at);
