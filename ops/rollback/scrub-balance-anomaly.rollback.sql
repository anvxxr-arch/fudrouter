-- scrub-balance-anomaly.rollback.sql — pre-image + undo for the F1 balance scrub.
--
-- A1 (fr-revised.md §0 P1.1) requires that every money step HAVE a pre-image and
-- an undo. `ops/scrub-balance-anomaly.sql` repairs the ledger by REWRITING
-- `amount_micro` to 0 and appending provenance to `description`; the old runbook
-- §3.2 only had a hand-typed reverse-UPDATE with the literal corrupt value and
-- description copied from memory. That is not a pre-image: a typo in the literal
-- silently "restores" the wrong number, and it cannot restore a row whose
-- original description differed from `'Credit purchase'`.
--
-- This file replaces the memory-based reverse with a captured snapshot:
--
--   PART A — CAPTURE (run BEFORE any repair). Copies the exact pre-repair rows
--            of `credit_ledger` that the repair WOULD change (the implausible
--            |amount_micro| > 1e12 placeholder rows) into
--            `credit_ledger_scrub_preimage`, keyed by `id` so re-running cannot
--            duplicate a row and cannot overwrite an already-captured original.
--            Also captures `billing_account.balance_micro` for the accounts that
--            own those rows, because Step 2 rewrites that cache too; a ledger-only
--            undo would leave the cache pointing at the scrubbed ledger.
--
--   PART B — UNDO (run to revert the scrub). Restores `amount_micro` and
--            `description` on every captured ledger row from the snapshot, then
--            restores the captured cache value on the captured accounts. It does
--            NOT delete the snapshot, so the undo is itself reversible (re-run
--            the repair and the same pre-image is still there).
--
-- Why the cache is restored FROM THE SNAPSHOT and not by re-deriving
-- SUM(ledger): after the undo the two corrupt rows are back, so the corrupt
-- account's SUM is 1.11e19 which OVERFLOWS int64 — the `::bigint` Step 2 would
-- raise `bigint out of range` (this is the exact defect the scrub exists to
-- remove). Restoring the literal captured balance is the only undo that works
-- while the corrupt state is deliberately restored.
--
-- Scope safety: both parts are predicates, never a bare table operation.
--   * PART A only copies rows matching the implausible-amount predicate.
--   * PART B only touches rows/accounts present in the snapshot table.
-- Running either against a CLEAN database (no implausible rows) copies nothing
-- and restores nothing: it is a no-op, not a mass rewrite.
--
-- Idempotence:
--   * PART A: `ON CONFLICT (id) DO NOTHING` — a second capture inserts 0 rows.
--   * PART B: `WHERE ... IS DISTINCT FROM ...` — a second undo updates 0 rows
--     (the values already equal the snapshot).
--
-- Usage (see ops/scrub-execution-checklist.md for the full operator order):
--   # before repair — CAPTURE
--   psql "$DSN" -v ON_ERROR_STOP=1 -1 -f ops/rollback/scrub-balance-anomaly.rollback.sql  # only PART A is active
--
--   Repair happens out-of-band: ops/scrub-balance-anomaly.step1-*.sql then step2.
--
--   # to revert — UNDO
--   psql "$DSN" -v ON_ERROR_STOP=1 -1 -f ops/rollback/scrub-balance-anomaly.undo.sql
--
-- PART B lives in the sibling file `scrub-balance-anomaly.undo.sql` on purpose:
-- a single file cannot be both "capture before repair" and "undo after repair"
-- without the operator editing it between runs, and an edited rollback script is
-- exactly the class of error this pre-image exists to prevent. The two files
-- share only the snapshot table and its shape.
--
-- No BEGIN/COMMIT in the file itself: the transactional `-1` flag wraps it, so a
-- failed capture cannot leave a half-written pre-image. This matches the
-- convention of the 0030–0035 rollbacks in this directory.
--
-- Fractional money? No. Every column here is `bigint` micro-units or text; no
-- float is introduced (HARD RULE: money never float).

-- The snapshot table. Not a migration — it is an operator artefact that exists
-- only while a scrub is in flight, and it is created IF NOT EXISTS so capture can
-- be retried. `original_*` names are deliberate: a reader must never mistake a
-- captured value for a current one. `captured_at` is the audit bracket around the
-- repair (capture time <= repair time <= undo time).
CREATE TABLE IF NOT EXISTS credit_ledger_scrub_preimage (
    -- PK on id == the capture is idempotent and a row is captured at most once.
    id                   text   PRIMARY KEY,
    billing_account_id   text   NOT NULL,
    idempotency_key      text,
    original_amount_micro bigint NOT NULL,
    original_description text,
    original_created_at  timestamptz NOT NULL,
    -- Provenance of the capture itself (not of the ledger row).
    captured_at          timestamptz NOT NULL DEFAULT now(),
    capture_note         text
);

-- The cache pre-image. Step 2 (reconcile) rewrites balance_micro; capturing it
-- here is what lets the undo put the exact pre-scrub cache back, including the
-- stale/drifted value the scrub is meant to remove.
CREATE TABLE IF NOT EXISTS billing_account_scrub_preimage (
    id                    text   PRIMARY KEY,
    original_balance_micro bigint NOT NULL,
    original_updated_at   timestamptz NOT NULL,
    captured_at           timestamptz NOT NULL DEFAULT now(),
    capture_note          text
);

-- CAPTURE the ledger pre-image: exactly the rows the repair's overflow predicate
-- selects. Same predicate as REPORT 2 / Step 1 so what is captured is what is
-- changed — nothing more (a legitimate posting is never captured) and nothing
-- less (a second corrupt row cannot be missed).
INSERT INTO credit_ledger_scrub_preimage
       (id, billing_account_id, idempotency_key,
        original_amount_micro, original_description, original_created_at, capture_note)
SELECT c.id,
       c.billing_account_id,
       c.idempotency_key,
       c.amount_micro,
       c.description,
       c.created_at,
       'captured before scrub-balance-anomaly Step 1'
  FROM credit_ledger c
 WHERE c.amount_micro > 1000000000000
    OR c.amount_micro < -1000000000000
ON CONFLICT (id) DO NOTHING;

-- CAPTURE the cache pre-image: the accounts that own a captured ledger row. Step
-- 2 touches every account whose cache differs from SUM(ledger), but the corrupt
-- posting's owner is the one guaranteed to move; capturing its exact prior
-- balance is what the undo restores. (A healthy account whose cache drifted for
-- an unrelated reason is NOT captured: this pre-image is scoped to the scrub.)
INSERT INTO billing_account_scrub_preimage
       (id, original_balance_micro, original_updated_at, capture_note)
SELECT b.id, b.balance_micro, b.updated_at,
       'captured before scrub-balance-anomaly Step 2'
  FROM billing_account b
 WHERE b.id IN (SELECT DISTINCT billing_account_id FROM credit_ledger_scrub_preimage)
ON CONFLICT (id) DO NOTHING;
