-- 0036_admin_credit_namespace.sql — move manual top-up idempotency keys off the
-- gateway-reserved `purchase:` namespace.
--
-- WHY (FR-revised §S5): the pre-gateway admin/member placeholder wrote manual
-- top-ups with idempotency key `purchase:<uuid>`, but `purchase:<ref>` is the
-- namespace the payment gateway will mint (S5: "purchase:<ref> dicadangkan untuk
-- payment gateway"). A retry of an old `purchase:` key after the gateway goes
-- live would either (a) silently drop a real gateway posting because an old
-- admin row already owns that key — `postLedger`'s `onConflictDoNothing` on the
-- durable `credit_ledger_idempotency_idx` unique index — or (b) a gateway ref
-- colliding with a still-open admin key. The namespace is freed by moving every
-- legacy manual key to `admin_credit:<uuid>`, matching the writer cutover in
-- apps/web/server/pages.mjs and admin.mjs (packages/platform/server/add-credit.ts).
--
-- Two legacy shapes existed, both written only by the manual top-up surfaces:
--   - `purchase:<uuid>`  — the member self-serve `addCreditKey`.
--   - `txn_<uuid>`       — the admin `/billing/credit` fallback key (`_newId('txn_')`),
--                          when the form's optional `key` was left blank.
-- `usage:<request_id>` (the meter) is untouched, and no other `txn_*` idempotency
-- key exists: `txn_` is the credit_ledger ENTRY id prefix (the `id` column), not
-- an idempotency namespace.
--
-- WHY PROVENANCE IS PRESERVED, NOT DELETED: the durable idempotency key is the
-- audit trail that says WHICH posting an amount belongs to (ops/scrub-balance-
-- anomaly.sql: "the idempotency_key is load-bearing"). Before overwriting it we
-- record the old value in `metadata.idempotency_key_prev`, so the rollback can
-- reverse exactly and an operator can always prove where a row came from.
--
-- IDEMPOTENT: each UPDATE is keyed off the OLD prefix; after the first run the
-- row starts with `admin_credit:`, so a re-run's predicate matches zero rows.
-- Re-run convergence is by construction: nothing is inserted, and the
-- `idempotency_key_prev` marker is only written while the old prefix is still
-- present (a second run writes nothing).
--
-- ATOMICITY: deliberately no BEGIN/COMMIT, matching 0026/0028/0030/0031/0032.
-- The runner applies the file with ON_ERROR_STOP, so a failure aborts before
-- `schema_migration` records it; each statement is a single idempotent UPDATE.
--
-- NEVER applied to production `fudrouter` by this file itself: the operator runs
-- ops/migrate.sh against a scratch/staging DATABASE_URL, then promotes.

UPDATE "credit_ledger"
   SET "idempotency_key" = 'admin_credit:' || substr("idempotency_key", 10),
       "metadata" = "metadata" || jsonb_build_object('idempotency_key_prev', "idempotency_key")
 WHERE "idempotency_key" LIKE 'purchase:%';

UPDATE "credit_ledger"
   SET "idempotency_key" = 'admin_credit:' || "idempotency_key",
       "metadata" = "metadata" || jsonb_build_object('idempotency_key_prev', "idempotency_key")
 WHERE "idempotency_key" LIKE 'txn\_%' ESCAPE '\';