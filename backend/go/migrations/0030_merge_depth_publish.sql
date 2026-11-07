-- 0030_merge_depth_publish.sql — publish one PROVEN (canonical model x provider) pair.
--
-- WHY a probe and not `/models`: an aggregator lists what it SELLS, not what a
-- pooled key may CALL. Measured on this catalogue (2026-11-03): free.ai publishes
-- 466 ids on GET /v1/models, but every premium id answers
--   400 "'<id>' is not served by this endpoint"
-- to POST /chat/completions, because premium traffic lives on a different
-- upstream path this router does not dial. Publishing those rows would put 31
-- mappings in the candidate fan-out that cannot serve a single request.
--
-- The pair below is the ONLY one of 38 name-matched candidates that answered a
-- real chat completion. Evidence (ops/merge-depth-verify.mjs, 2026-11-03):
--   prv_googleai + models/gemma-4-31b-it -> HTTP 200, usage present
--   prv_googleai + gemma-4-31B-it        -> HTTP 400 "unexpected model name
--                                           format"  (so the prefix is required)
-- The two negative controls in the same run (a bogus id on prv_googleai and on
-- prv_tokenjuice) both returned 404, so a PASS is not a vacuous result.
--
-- WHAT this does NOT claim: a 2xx proves the mapping RESOLVES. It says nothing
-- about reliability or sustained availability. `status='available'` here means
-- "callable now", not "healthy"; reliability stays with model_verification and
-- request_attempt history.
--
-- CONTRACT IMPACT: no new model identity, no new provider, no alias row. The
-- catalogue slug set is unchanged (gemma-4-31B-it is already published through
-- prv_sambanova); what changes is that the identity gains a SECOND provider, so
-- routing depth for it goes 1 -> 2 whenever SambaNova's single credential is not
-- cooling. Depth is measured from dialable providers, and that key flaps, so the
-- mapping is permanent while the depth it buys is not. /v1/models output is
-- unchanged.
--
-- IDEMPOTENT: the insert is keyed by provider_model_target_idx
-- (model_id, provider_id, coalesce(connection_id,'')) via ON CONFLICT DO NOTHING,
-- and the audit row is keyed by pm_id, so a replay is a byte-for-byte no-op.
--
-- ROLLBACK: ops/rollback/0030_merge_depth_publish.rollback.sql (same card, tested
-- in internal/store/merge_depth_test.go). It deletes exactly the rows this
-- migration recorded in provider_model_merge_audit, so it cannot touch a mapping
-- that was already there.
-- ATOMICITY: deliberately NO BEGIN/COMMIT here. 0026 and 0028, the identity
-- migrations this builds on, carry none either, and the runner applies each file
-- with ON_ERROR_STOP so a failure aborts before `schema_migration` records it.
-- Keeping the transaction out of the file also lets a test run it inside its own
-- transaction — with an embedded COMMIT the test's fixtures would be committed to
-- the shared catalogue and every later assertion would read polluted state.
-- Apply by hand with `psql -1 -f` when you want a single-transaction apply.

-- The audit table is the rollback's source of truth: it records WHICH rows this
-- migration created (prev_* NULL) or repointed (prev_* set), so the rollback
-- never has to guess from a hardcoded id list.
CREATE TABLE IF NOT EXISTS "provider_model_merge_audit" (
	"pm_id" text PRIMARY KEY NOT NULL,
	"migration" text NOT NULL,
	"prev_model_id" text,
	"prev_enabled" boolean,
	"prev_status" text,
	"evidence" text NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now()
);

-- Guarded on the identity and the transport actually existing and being
-- servable: no row is invented for a model that was renamed, a provider that was
-- retired, or a connection that was removed. All three are matched by id/slug,
-- never created here.
INSERT INTO "provider_model" ("id", "model_id", "provider_id", "connection_id", "provider_model_id", "enabled", "status")
SELECT 'pmdl_merge_googleai_gemma_4_31b',
       m."id", p."id", c."id", 'models/gemma-4-31b-it', true, 'available'
FROM "model" m
JOIN "provider" p ON p."id" = 'prv_googleai'
                 AND p."enabled"
                 AND p."status" = 'active'
                 AND p."tier" = 'commercial'
JOIN "connection" c ON c."id" = 'con_prv_googleai-default'
                   AND c."provider_id" = p."id"
                   AND c."enabled"
WHERE lower(m."slug") = 'gemma-4-31b-it'
  AND m."status" = 'active'
ON CONFLICT DO NOTHING;

INSERT INTO "provider_model_merge_audit" ("pm_id", "migration", "prev_model_id", "prev_enabled", "prev_status", "evidence")
SELECT pm."id", '0030_merge_depth_publish', NULL, NULL, NULL,
       'chat probe 2026-11-03: POST /chat/completions model=models/gemma-4-31b-it -> 200; unprefixed id -> 400; negative controls -> 404'
FROM "provider_model" pm
WHERE pm."id" = 'pmdl_merge_googleai_gemma_4_31b'
ON CONFLICT ("pm_id") DO NOTHING;
