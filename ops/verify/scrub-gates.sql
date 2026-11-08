-- ops/verify/scrub-gates.sql — F1 go/no-go gates G1–G5, plus undo checks V6.
--
-- Read-only. Run against the SAME database the scrub ran on (staging first, then
-- production after the operator signs off). Every gate prints a machine-readable
-- `gate | value | PASS/FAIL` row so the operator can grep for FAIL instead of
-- eyeballing numbers.
--
-- Mapping to docs/specs/2026-11-08-F1-balance-runbook.md §5.1:
--   G1  accounts whose |balance_micro| >= 1e12 (placeholder wallet)      target 0
--   G2  accounts whose cache != SUM(ledger)   (drift)                     target 0
--   G3  ledger rows with |amount_micro| > 1e12 (placeholder posting)      target 0
--   G4  global  SUM(ledger) - SUM(balance)                                target 0
--   G5  idempotence: proven out-of-band by re-running the two step files
--       and reading the command tags back — here we assert the two corrupt
--       rows are already zeroed with provenance intact (see G5 below).
--
-- G1..G4 are pure invariants over the data and re-run cleanly. G5 cannot be a
-- SELECT: it is "run step1+step2 again and see UPDATE 0". The checklist covers
-- that; this file captures the post-condition (rows are at 0 with the suffix).
--
-- All sums use `sum(bigint) -> numeric` on purpose: a corrupt account's SUM
-- exceeds int64, so a `::bigint` cast here would itself raise `bigint out of
-- range` and hide the failure. numeric can hold 1.11e19; keep it that way.
--
-- V6 is the undo verification: after reverting, the live rows must equal the
-- captured pre-image exactly. It is a JOIN of the two, so it needs the pre-image
-- tables; on a database that was never captured it returns 0/0 and is skipped.

\pset footer off

-- G1 — accounts with an implausible cached balance.
SELECT 'G1_accounts_out_of_range' AS gate,
       count(*)::text AS value,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
  FROM billing_account
 WHERE balance_micro >= 1000000000000 OR balance_micro <= -1000000000000;

-- G2 — per-account drift: cache vs ledger. One row per drifting account is also
-- printed below so a FAIL is actionable (the gate alone says "how many").
SELECT 'G2_accounts_with_drift' AS gate,
       count(*)::text AS value,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
  FROM billing_account ba
  LEFT JOIN (SELECT billing_account_id a, sum(amount_micro) s
               FROM credit_ledger GROUP BY 1) l ON l.a = ba.id
 WHERE ba.balance_micro <> coalesce(l.s, 0);

-- G3 — implausible ledger rows.
SELECT 'G3_implausible_ledger_rows' AS gate,
       count(*)::text AS value,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
  FROM credit_ledger
 WHERE amount_micro > 1000000000000 OR amount_micro < -1000000000000;

-- G4 — global ledger vs balance.
SELECT 'G4_global_diff_micro' AS gate,
       ((SELECT sum(amount_micro) FROM credit_ledger)
      - (SELECT sum(balance_micro) FROM billing_account))::text AS value,
       CASE WHEN ((SELECT sum(amount_micro) FROM credit_ledger)
                - (SELECT sum(balance_micro) FROM billing_account)) = 0
            THEN 'PASS' ELSE 'FAIL' END AS verdict;

-- G5 — the two corrupt rows sit at 0 with the provenance suffix intact. A clean
-- row would have amount_micro = 0 AND the suffix; a row still carrying the
-- placeholder or one whose suffix was lost both FAIL.
--
-- The identity is the PRIMARY KEY (id), not the idempotency_key: migration
-- 0036 (A3) may have renamed the two legacy `purchase:` keys to `admin_credit:`
-- (with the original value preserved in metadata.idempotency_key_prev), and the
-- scrub must still count those rows as "intact". So the key clause accepts the
-- original `purchase:` form OR 0036's `admin_credit:` rename OR the
-- metadata.idempotency_key_prev carry-over — the three shapes Step 1 also
-- records in its WHERE. Matching on id + amount + description suffix is what
-- proves the scrub happened; the key clause is audit, not identity.
SELECT 'G5_scrubbed_rows_intact' AS gate,
       count(*)::text AS value,
       CASE WHEN count(*) = 2 THEN 'PASS' ELSE 'FAIL' END AS verdict
  FROM credit_ledger
 WHERE id IN ('txn_01a178b8-3ef7-777e-9791-55c633a2b2d4',
              'txn_01a178b8-3f00-70b4-9d1b-22f58628deb3')
   AND amount_micro = 0
   AND (
       idempotency_key IN ('purchase:txn_01a178b8-3ef5-7b87-8928-a8d37e537fe8',
                            'purchase:txn_01a178b8-3eff-7d0a-8838-fb7c80a830f9')
    OR idempotency_key IN ('admin_credit:txn_01a178b8-3ef5-7b87-8928-a8d37e537fe8',
                            'admin_credit:txn_01a178b8-3eff-7d0a-8838-fb7c80a830f9')
    OR metadata->>'idempotency_key_prev' IN ('purchase:txn_01a178b8-3ef5-7b87-8928-a8d37e537fe8',
                                              'purchase:txn_01a178b8-3eff-7d0a-8838-fb7c80a830f9')
   )
   AND description LIKE '%[scrub-balance-anomaly: corrupt placeholder, was %';

-- Detail rows for any FAIL above (empty when all gates pass).
\echo '--- drifting accounts (G2 detail; empty means G2 passed) ---'
SELECT ba.id, ba.user_id, ba.balance_micro,
       coalesce(l.s, 0) AS ledger_sum,
       ba.balance_micro - coalesce(l.s, 0) AS drift_micro
  FROM billing_account ba
  LEFT JOIN (SELECT billing_account_id a, sum(amount_micro) s
               FROM credit_ledger GROUP BY 1) l ON l.a = ba.id
 WHERE ba.balance_micro <> coalesce(l.s, 0)
 ORDER BY abs(ba.balance_micro - coalesce(l.s, 0)) DESC
 LIMIT 50;

-- V6 — undo verification (only meaningful after the undo file has run). Both
-- counts must be 0: mismatched ledger rows vs pre-image, and mismatched cache
-- accounts vs pre-image.
--
-- On a database that was never captured the pre-image tables do not exist, so a
-- plain SELECT would ERROR while parsing. `to_regclass` + psql `\gset`/`\if`
-- guards that: V6 prints SKIP when there is no pre-image. After a
-- repair-but-before-undo it reads FAIL on purpose — the live rows deliberately
-- differ from the captured originals — so read V6 against the undo step, not
-- against Step 1/2.
SELECT to_regclass('public.credit_ledger_scrub_preimage')    IS NOT NULL AS has_ledger_pi,
       to_regclass('public.billing_account_scrub_preimage') IS NOT NULL AS has_cache_pi
\gset

\echo '--- V6 undo fidelity (SKIP = never captured; PASS after correct undo) ---'

\if :has_ledger_pi
SELECT 'V6_ledger_preimage_mismatch' AS check,
       count(*)::text AS value,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
  FROM credit_ledger_scrub_preimage p
  JOIN credit_ledger c ON c.id = p.id
 WHERE c.amount_micro IS DISTINCT FROM p.original_amount_micro
    OR c.description  IS DISTINCT FROM p.original_description;
\else
\echo 'V6_ledger_preimage_mismatch | SKIP | pre-image table absent (never captured)'
\endif

\if :has_cache_pi
SELECT 'V6_cache_preimage_mismatch' AS check,
       count(*)::text AS value,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
  FROM billing_account_scrub_preimage p
  JOIN billing_account b ON b.id = p.id
 WHERE b.balance_micro IS DISTINCT FROM p.original_balance_micro;
\else
\echo 'V6_cache_preimage_mismatch | SKIP | pre-image table absent (never captured)'
\endif
