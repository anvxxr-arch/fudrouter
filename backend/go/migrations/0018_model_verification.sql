-- Evidence table for `model_verification` (packages/platform/server/workers.ts).
--
-- The problem it records: a provider's catalog advertises model X, but the
-- upstream serves model Y — a different model, a relabeled alias, or nothing at
-- all. The catalog (`provider_model`) is a CLAIM; only a completed chat probe
-- against the connection with the provider's own credential is evidence, so
-- each probe appends one row here with what the upstream itself reported
-- (`response_model`), what was requested (`requested_slug`), and a verdict.
--
-- Append-only, like request_log: a verdict is evidence from a point in time,
-- never a mutable property — the "latest verdict" an admin reads is a max-by
-- created_at query, not a column anyone updates. The job re-probes and inserts;
-- nothing ever UPDATEs these rows.
--
-- `provider_model_id` is the mapping row. It is SET NULL on delete (not
-- CASCADE): deleting a mapping must not erase the evidence that a provider once
-- served the wrong model — the same survive-the-subject rule request_log's
-- ledger columns follow.
CREATE TABLE "model_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_model_id" text,
	"requested_slug" text NOT NULL,
	"response_model" text,
	"verdict" text NOT NULL,
	"error" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"latency_ms" integer,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	-- 'error' carries the transient outcome (5xx, rate limit, timeout) that
	-- proves nothing about what the provider serves: collapsing it into
	-- 'not_served' would flag a healthy model on every flaky probe, and
	-- dropping the row would hide the failure and leave a stale verdict.
	CONSTRAINT "model_verification_verdict_check" CHECK ("verdict" IN ('pass', 'mismatch', 'not_served', 'error'))
);
CREATE INDEX "model_verification_provider_model_idx" ON "model_verification"
	USING btree ("provider_model_id", "created_at" DESC);
CREATE INDEX "model_verification_created_idx" ON "model_verification" USING btree ("created_at");
ALTER TABLE "model_verification" ADD CONSTRAINT "model_verification_provider_model_id_provider_model_id_fk"
	FOREIGN KEY ("provider_model_id") REFERENCES "public"."provider_model"("id") ON DELETE set null;
