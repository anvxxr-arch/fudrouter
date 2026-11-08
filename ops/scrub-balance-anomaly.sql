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
-- Root cause (as found, with evidence)
-- ---------------------------------------------------------------------------
-- The live defect is documented in docs/changelog/2026-10-31-benchmark-
-- optimization.md and repeated in
-- docs/specs/2026-11-08-economic-layer-design.md §6/§8:
--
--   billing_account.balance_micro = 5555555987774996738  (~5.55e18)
--
-- That is ~5.5 TRILLION USD in micro-units, on a normal customer account. A
-- genuine balance of this size is impossible, and the magnitude is the tell:
--    5.55e18 > 2^52 = 4.50e15  (and > 2^53 = 9.01e15, JS MAX_SAFE_INTEGER)
-- i.e. it is ABOVE the range where an IEEE-754 double can represent every
-- integer. A real bigint ledger posting cannot produce 5555555987774996738;
-- that trailing digit pattern is the residue of a float/double round-trip
-- (Number(x) loses low bits past 2^53). The same integer-overflow warning is
-- documented in backend/go/internal/cost/cost.go:12-14 ("int64 tops out at
-- 9.22e18"; "widened to numeric(18,6) precisely so those real prices fit").
--
-- balance_micro is only a CACHE of SUM(credit_ledger.amount_micro) (0006
-- §billing, billing.ts). So a corrupt cache is repaired by re-deriving, but a
-- corrupt LEDGER row must be fixed FIRST — otherwise reconciling propagates the
-- 5.55e18 into the cache instead of removing it. The design calls this out
-- explicitly: "reconcileAll ... MUST NOT run before the balance-anomaly scrub"
-- (economic-layer-design §8 invariant 4). That is why this script reports BOTH
-- classes and orders the repairs: ledger first, then cache.
-- ---------------------------------------------------------------------------

-- Threshold: one prepaid account holding more than $1M (1e12 micro-USD) is not
-- a real balance; it is overflow/garbage. Bump this only with operator review.
-- abs() is avoided on bigint because abs(INT64_MIN) overflows: use two bounds.

-- ---------------------------------------------------------------------------
-- REPORT 1 — affected accounts: out-of-range cache, ledger mismatch, or both.
-- drift_micro > 0 means the cache owes MORE than the ledger says (impossible);
-- drift_micro < 0 means the cache under-reports the ledger (real, but still a
-- cache bug worth fixing once the ledger is clean).
-- ---------------------------------------------------------------------------
WITH ledger AS (
    SELECT billing_account_id AS account_id,
           sum(amount_micro)::bigint AS ledger_sum,
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

-- -- Step 1 (LEDGER): null out the float round-trip postings. Scoped to the
-- -- rows REPORT 2 lists, matched by id AND original idempotency_key AND the
-- -- overflow predicate, so a review typo cannot rewrite a legitimate posting.
-- -- Preserve provenance in description rather than deleting the row (the
-- -- durable idempotency key keeps retries from re-posting, and the audit trail
-- -- stays readable).
-- -- UPDATE credit_ledger
-- --    SET amount_micro = 0,
-- --        description = coalesce(description, '') ||
-- --                      ' [scrub-balance-anomaly: float round-trip, was ' ||
-- --                      amount_micro::text || ']'
-- --  WHERE id = 'txn_…'
-- --    AND idempotency_key = 'usage:…'
-- --    AND (amount_micro > 1000000000000 OR amount_micro < -1000000000000);

-- -- Step 2 (CACHE): re-derive balance_micro from the now-clean ledger — the
-- -- exact set-based rule reconcileAll (packages/platform/server/billing.ts)
-- -- uses, written only for rows that actually differ. Run AFTER step 1.
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