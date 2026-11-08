-- ops/scrub-balance-anomaly.sql — F1: find and (manually) repair balance anomalies
-- BEFORE the payment gateway goes live (FreeAccessNoPaymentGateway=false).
--
-- READ-ONLY. Every statement below produces a SELECT report. The repair
-- commands are present but COMMENTED OUT: an operator must review the report,
-- run the fixes by hand against a reviewed account list, then re-run the
-- report to confirm the anomalies are gone. Nothing here auto-updates.
--
-- Run against a SCRATCH/STAGING database first, never production `fudrouter`.
--   psql "$SCRATCH_DSN" -f ops/scrub-balance-anomaly.sql
--
-- ---------------------------------------------------------------------------
-- Root cause (verified against production `fudrouter`, 2026-11-08, read-only).
-- ---------------------------------------------------------------------------
--   credit_ledger rows:  2 × type='credit_purchase', amount_micro =
--       5555555555555000000  (= 5555555555555 × 1e6), created 2026-10-26,
--       description 'Credit purchase', on billing_account
--       bac_wrk_usr_VjOnC8IZktzGBVXBagJkGJPEhoocKe5L (a benchmark/user account).
--
--   billing_account.balance_micro for that account was 5555555987766272800,
--   which equals the CLEAN ledger sum (432211272800) plus exactly ONE of the
--   two corrupt postings — i.e. the cache is not merely SUM(ledger); it is
--   stale/drifted, one posting behind the ledger.
--
-- The magnitude is a PLACEHOLDER, not a float residue: 5555555555555 is an
-- admin/test input with the repeated-5 digit pattern, written through the
-- pre-bigint writer path that no longer exists. The writer that would have
-- produced it is gone — packages/platform/server/billing.ts:133-135 (postLedger)
-- now throws `TypeError` for any non-bigint `amountMicro`, and the Go charge
-- path ($1 = 1_000_000 micro-units, native int64/bigint) cannot mint this value.
-- So this is a one-off garbage posting to be scrubbed, not an ongoing writer bug.
--
-- balance_micro is only a CACHE of SUM(credit_ledger.amount_micro) (0006
-- §billing, billing.ts). A corrupt cache is repaired by re-deriving, but a
-- corrupt LEDGER row must be fixed FIRST — otherwise reconciling propagates the
-- garbage into the cache instead of removing it. The design calls this out
-- explicitly: "reconcileAll ... MUST NOT run before the balance-anomaly scrub"
-- (economic-layer-design §8 invariant 4).
--
-- There is a SECOND, harder reason the ledger must go first: both this script's
-- REPORT 1 and reconcileAll (billing.ts:275) cast SUM(amount_micro) to bigint
-- for at least one row, and the corrupt account's SUM (1.11e19) exceeds the
-- int64/bigint ceiling (9.22e18). Casting that value raises `bigint out of
-- range`, so REPORT 1 here keeps the sum numeric; reconcileAll's own
-- `::bigint` cast only stops overflowing AFTER Step 1 has nulled the corrupt
-- rows. Ledger-first is therefore not just "right order", it is the only order
-- in which Step 2 (and the hourly `billing_aggregation` job) can even run.
-- ---------------------------------------------------------------------------

-- Threshold: one account holding more than $1M (1e12 micro-USD) is not a real
-- balance; it is a placeholder/garbage posting from the pre-bigint era. Bump
-- this only with operator review. abs() is avoided on bigint because
-- abs(INT64_MIN) overflows: use two bounds.

-- ---------------------------------------------------------------------------
-- REPORT 1 — affected accounts: out-of-range cache, ledger mismatch, or both.
-- drift_micro > 0 means the cache owes MORE than the ledger says (impossible);
-- drift_micro < 0 means the cache under-reports the ledger (real, but still a
-- cache bug worth fixing once the ledger is clean).
--
-- ledger_sum is intentionally NUMERIC (not ::bigint): the corrupt account's
-- SUM exceeds int64, so casting it would raise `bigint out of range` and hide
-- the very row this report exists to surface.
-- ---------------------------------------------------------------------------
WITH ledger AS (
    SELECT billing_account_id AS account_id,
           sum(amount_micro) AS ledger_sum,
           sum(CASE WHEN amount_micro > 1000000000000
                     OR amount_micro < -1000000000000 THEN 1 ELSE 0 END) AS implausible_rows
      FROM credit_ledger
     GROUP BY billing_account_id
)
SELECT ba.id                                                       AS account_id,
       ba.user_id,
       ba.balance_micro,
       coalesce(l.ledger_sum, 0)                                  AS ledger_sum,
       (ba.balance_micro - coalesce(l.ledger_sum, 0))             AS drift_micro,
       (ba.balance_micro >= 1000000000000
         OR ba.balance_micro <= -1000000000000)                   AS balance_out_of_range,
       (coalesce(l.implausible_rows, 0) > 0)                      AS ledger_has_implausible_rows,
       (ba.balance_micro <> coalesce(l.ledger_sum, 0))            AS balance_mismatch
  FROM billing_account ba
  LEFT JOIN ledger l ON l.account_id = ba.id
 WHERE ba.balance_micro >= 1000000000000
    OR ba.balance_micro <= -1000000000000
    OR ba.balance_micro <> coalesce(l.ledger_sum, 0)
 ORDER BY greatest(abs(ba.balance_micro),
                   abs(ba.balance_micro - coalesce(l.ledger_sum, 0))) DESC
 LIMIT 200;

-- ---------------------------------------------------------------------------
-- REPORT 2 — the implausible LEDGER rows themselves, with their original
-- provenance. The idempotency_key is load-bearing: the durable unique key is
-- the stopper (PRD §118) and the audit trail that says WHICH posting produced
-- the garbage. Any repair must reference it so the fix is auditable back to the
-- original write. Do NOT delete blindly.
-- ---------------------------------------------------------------------------
SELECT id,
       billing_account_id,
       type,
       amount_micro,
       idempotency_key,
       description,
       created_at
  FROM credit_ledger
 WHERE amount_micro > 1000000000000
    OR amount_micro < -1000000000000
 ORDER BY abs(amount_micro) DESC
 LIMIT 200;

-- ---------------------------------------------------------------------------
-- REPAIRS (run manually, in this order, only after reviewing the two reports).
-- Each block is a TEMPLATE: replace the '…' placeholders with the exact ids /
-- values REPORT 1 and REPORT 2 listed. Re-run both reports afterwards and
-- confirm they return zero rows before touching FreeAccessNoPaymentGateway.
-- ---------------------------------------------------------------------------

-- -- Step 1 (LEDGER): null out the corrupt placeholder postings. Scoped to the
-- -- rows REPORT 2 lists, matched by id AND original idempotency_key AND the
-- -- overflow predicate, so a review typo cannot rewrite a legitimate posting.
-- -- Preserve provenance in description rather than deleting the row (the
-- -- durable idempotency key keeps retries from re-posting, and the audit trail
-- -- stays readable). The corrupt rows use the 'purchase:…' prefix, not
-- -- 'usage:…' — copy the exact key from REPORT 2, do not retype it.
-- -- UPDATE credit_ledger
-- --    SET amount_micro = 0,
-- --        description = coalesce(description, '') ||
-- --                      ' [scrub-balance-anomaly: corrupt placeholder, was ' ||
-- --                      amount_micro::text || ']'
-- --  WHERE id = 'txn_…'
-- --    AND idempotency_key = 'purchase:…'
-- --    AND (amount_micro > 1000000000000 OR amount_micro < -1000000000000);

-- -- Step 2 (CACHE): re-derive balance_micro from the now-clean ledger — the
-- -- exact set-based rule reconcileAll (packages/platform/server/billing.ts)
-- -- uses, written only for rows that actually differ. Run AFTER step 1.
-- -- The ::bigint cast is now safe because no account SUM exceeds int64.
-- -- WITH derived AS (
-- --     SELECT billing_account_id AS account_id, sum(amount_micro) AS total
-- --       FROM credit_ledger
-- --      GROUP BY billing_account_id
-- -- ),
-- -- wanted AS (
-- --     SELECT b2.id, coalesce(d.total, 0)::bigint AS total
-- --       FROM billing_account b2
-- --       LEFT JOIN derived d ON d.account_id = b2.id
-- -- )
-- -- UPDATE billing_account b
-- --    SET balance_micro = w.total, updated_at = now()
-- --   FROM wanted w
-- --  WHERE w.id = b.id
-- --    AND w.total <> b.balance_micro;