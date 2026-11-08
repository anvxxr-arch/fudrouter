-- scrub-balance-anomaly.step2.sql — F1 Step 2, re-derive the balance cache.
--
-- The set-based rule from `reconcileAll` (packages/platform/server/billing.ts),
-- written as a file so the operator runs the exact statement the worker runs,
-- in the exact order the ledger-first rule requires.
--
-- MUST run AFTER ops/scrub-balance-anomaly.step1.sql. Against an un-scrubbed
-- database the corrupt account's SUM is 1.11e19, the `::bigint` below raises
-- `bigint out of range`, and this statement fails — which is the correct, loud
-- failure that keeps a garbage cache from being written. Step 1 removes the
-- overflow first, after which the cast is lossless.
--
-- Only rows whose value actually differs are written (the `w.total <> b.balance_micro`
-- guard), so a re-run writes 0 rows — this is the cache half of the G5 idempotence
-- check.
--
-- `-1` wraps it in a transaction; it is one statement, so that is belt and braces.

WITH derived AS (
    SELECT billing_account_id AS account_id, sum(amount_micro) AS total
      FROM credit_ledger
     GROUP BY billing_account_id
),
wanted AS (
    SELECT b2.id, coalesce(d.total, 0)::bigint AS total
      FROM billing_account b2
      LEFT JOIN derived d ON d.account_id = b2.id
)
UPDATE billing_account b
   SET balance_micro = w.total, updated_at = now()
  FROM wanted w
 WHERE w.id = b.id
   AND w.total <> b.balance_micro;
