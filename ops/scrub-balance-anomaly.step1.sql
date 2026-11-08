-- scrub-balance-anomaly.step1.sql — F1 Step 1, the reviewed repair (ledger first).
--
-- This is the READY-TO-RUN form of the commented template in
-- `ops/scrub-balance-anomaly.sql`. It is NOT executed automatically by anything:
-- it lives in ops/ and only an operator runs it, against a reviewed REPORT 2.
--
-- Preconditions (enforced by ops/scrub-execution-checklist.md §4):
--   1. ops/rollback/scrub-balance-anomaly.rollback.sql has captured the pre-image.
--   2. REPORT 2 lists EXACTLY these two ids / idempotency keys. If it lists a third
--      row, STOP: that file's WHERE would not cover it and the anomaly is wider
--      than this repair assumes.
--
-- ORDERING vs A3 (migration 0036_admin_credit_namespace.sql): the two corrupt
-- postings carry the legacy `purchase:` idempotency namespace, which 0036 moves
-- to `admin_credit:` and records the old value in metadata.idempotency_key_prev.
-- Step 1 here matches each row by its PRIMARY KEY (id) plus the overflow
-- predicate, and by the idempotency key in EITHER form — the original
-- `purchase:...` or 0036's `admin_credit:...` (looked up via idempotency_key_prev)
-- — so the scrub works whether it runs before or after 0036. The idempotency-key
-- clause is an audit belt that stops a review typo in the id from silently
-- rewriting an unrelated posting; it is not what makes the UPDATE safe (the
-- primary key does that).
--
-- Two single-row UPDATEs — deliberately. A combined `... WHERE id IN (...) AND
-- (key = 'a' OR key = 'b') AND (amount_micro > 1e12 OR amount_micro < -1e12)`
-- would be a review hazard: `AND` binds tighter than `OR` in SQL's three-valued
-- logic, and the runbook document already records a re-run double-appending
-- provenance when that grouping slips. One statement per posting keeps the
-- overflow guard attached to each row, which is what makes the re-run (G5) a
-- clean `UPDATE 0`.
--
-- Each UPDATE is keyed on id + its idempotency key + the overflow predicate:
-- after Step 1 the row's amount_micro is 0, so the predicate is false and a
-- second run matches nothing. That triple is the idempotence contract. The
-- `idempotency_key = 'purchase:...' OR metadata->>'idempotency_key_prev' =
-- 'purchase:...'` disjunct is fully parenthesised so the overflow predicate still
-- binds to the whole row — the OR-grouping trap the runbook warns about is
-- avoided by keeping each posting's predicate in its own UPDATE and parenthesising
-- the key clause.
--
-- Repeatable read is not used: the operator holds the application write path
-- closed for the repair window (checklist §5), so no posting can land between
-- Step 1 and Step 2, and row locking on the two ids is enough. `-1` wraps the
-- file in one transaction so both postings commit or neither does.

-- Posting 1 — txn_01a178b8-3ef7-777e-9791-55c633a2b2d4
UPDATE credit_ledger
   SET amount_micro = 0,
       description  = coalesce(description, '') ||
                      ' [scrub-balance-anomaly: corrupt placeholder, was ' ||
                      amount_micro::text || ']'
 WHERE id = 'txn_01a178b8-3ef7-777e-9791-55c633a2b2d4'
   AND (idempotency_key = 'purchase:txn_01a178b8-3ef5-7b87-8928-a8d37e537fe8'
     OR idempotency_key = 'admin_credit:txn_01a178b8-3ef5-7b87-8928-a8d37e537fe8'
     OR metadata->>'idempotency_key_prev' = 'purchase:txn_01a178b8-3ef5-7b87-8928-a8d37e537fe8')
   AND (amount_micro > 1000000000000 OR amount_micro < -1000000000000);

-- Posting 2 — txn_01a178b8-3f00-70b4-9d1b-22f58628deb3
UPDATE credit_ledger
   SET amount_micro = 0,
       description  = coalesce(description, '') ||
                      ' [scrub-balance-anomaly: corrupt placeholder, was ' ||
                      amount_micro::text || ']'
 WHERE id = 'txn_01a178b8-3f00-70b4-9d1b-22f58628deb3'
   AND (idempotency_key = 'purchase:txn_01a178b8-3eff-7d0a-8838-fb7c80a830f9'
     OR idempotency_key = 'admin_credit:txn_01a178b8-3eff-7d0a-8838-fb7c80a830f9'
     OR metadata->>'idempotency_key_prev' = 'purchase:txn_01a178b8-3eff-7d0a-8838-fb7c80a830f9')
   AND (amount_micro > 1000000000000 OR amount_micro < -1000000000000);
