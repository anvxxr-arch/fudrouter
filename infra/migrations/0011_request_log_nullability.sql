-- 0011_request_log_nullability — let request_log record requests that fail
-- BEFORE a model resolves.
--
-- Spec §8 declares `model_id` "(resolved canonical, SET NULL — NULL = the
-- request died before a model resolved, e.g. MODEL_NOT_FOUND)" and lists
-- `provider_id NULL, provider_model_id NULL, connection_id NULL, credential_id
-- NULL`. But the literal DDL never matched: 0000 created `model_id`/
-- `provider_id` NOT NULL, and 0006 only ADDED the other nullable columns — it
-- never relaxed these two. Evidence (information_schema): `model_id` and
-- `provider_id` have is_nullable = NO while their siblings are YES.
--
-- Impact (reported by the data plane): every pre-model failure row — auth 401,
-- limit 429/402, budget block, MODEL_NOT_FOUND — was rejected with `null value
-- in column "model_id"` and dropped from the ledger, so the request never
-- reached request_log and WebObserve's history had gaps. Spec §8 "metadata
-- always" was violated.
--
-- Purely additive and idempotent: DROP NOT NULL cannot reject any existing row.
-- The data plane already writes NULL for an unresolved model/provider, so NO
-- writer change accompanies this file — unlike the gated 0010 (which must land
-- with its writer cutover), this is safe to apply on its own.
BEGIN;
ALTER TABLE "request_log" ALTER COLUMN "model_id" DROP NOT NULL;
ALTER TABLE "request_log" ALTER COLUMN "provider_id" DROP NOT NULL;
COMMIT;
