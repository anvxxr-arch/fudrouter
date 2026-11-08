-- 0034_economic_cost.sql — the three tables that let margin be real: real COGS
-- per mapping, markup per (bucket, model, mapping), and the frsubs rolling
-- quota. Additive; no existing table changes shape.
--
-- WHY `provider_cost_rule` MIRRORS `pricing_rule`: that table already encodes
-- the resolution semantics the router trusts — specific-beats-wide, newest
-- effective row wins, an `effective_until` closes a version without deleting
-- history. The COGS resolver must make the SAME choice as the retail resolver
-- for the same mapping, or a row could be billed at one rule and costed at
-- another. Reusing the shape (version + effective window + live partial index)
-- keeps that parity auditable.
--
-- WHY `source` IS NOT AN ENUM: the set is a data-provenance vocabulary
-- ('farm_zero' | 'subscription_flat' | 'invoice' | 'declared'), not a routing
-- predicate. A CHECK keeps typos out (below); a Postgres enum would make adding
-- a provenance a DDL migration. The comment on the column states the vocabulary
-- so an operator filling prices by hand sees it.
--
-- WHY `bucket_margin` IS ITS OWN TABLE, not a column on `provider_cost_rule`:
-- markup is a SELLING decision (bucket × model), while COGS is a BUYING fact
-- (mapping). The same mapping can be resold at different margins to frpayg and
-- frsubs; folding them together would force one margin per mapping.
--
-- WHY `bucket_quota` USES `quota_window`, NOT `window`: `window` is a reserved
-- word in Postgres (window functions) and `CREATE TABLE ... window text` fails
-- `syntax error at or near "window"` — verified during design. The column is
-- `quota_window`.
--
-- WHY THE QUOTA IS SEEDED WITH MICRO-USD AT A FIXED FX: the design fixes
-- FX = 16_000 IDR/USD and states the two rolling limits in IDR (50k / 500k).
--   limit_micro_usd(5h) = 50_000 IDR × 1e6 / 16_000 = 3_125_000 µUSD
--   limit_micro_usd(7d) = 500_000 IDR × 1e6 / 16_000 = 31_250_000 µUSD
-- `fx_idr_per_usd` is stored ON the row so a later FX bump is a new version, not
-- an in-place edit that would make history unreadable.
--
-- IDEMPOTENT: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and
-- the seed uses `ON CONFLICT DO NOTHING`, so a replay never resets a value an
-- operator has tuned.
--
-- ROLLBACK: ops/rollback/0034_economic_cost.rollback.sql drops exactly these
-- three tables (their indexes go with them).

-- ---------------------------------------------------------------------------
-- provider_cost_rule — the real (or declared) cost of one mapping, versioned.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "provider_cost_rule" (
	"provider_model_id" text NOT NULL,
	"version" integer NOT NULL DEFAULT 1,
	"currency" char(3) NOT NULL DEFAULT 'USD',
	-- Micro-USD per 1M tokens, same convention as pricing_rule (0006/0022).
	"input_price" numeric(18,6) NOT NULL,
	"cached_input_price" numeric(18,6),
	"output_price" numeric(18,6) NOT NULL,
	"reasoning_price" numeric(18,6),
	-- Provenance: 'farm_zero' | 'subscription_flat' | 'invoice' | 'declared'.
	-- farm_zero and subscription_flat are the two flat cases (0 and NULL on the
	-- request row); invoice/declared are real per-token prices.
	"source" text NOT NULL,
	"effective_from" timestamptz NOT NULL DEFAULT now(),
	"effective_until" timestamptz,
	PRIMARY KEY ("provider_model_id", "version"),
	CONSTRAINT "provider_cost_rule_source_check"
		CHECK ("source" IN ('farm_zero', 'subscription_flat', 'invoice', 'declared')),
	CONSTRAINT "provider_cost_rule_provider_model_id_provider_model_id_fk"
		FOREIGN KEY ("provider_model_id") REFERENCES "public"."provider_model"("id") ON DELETE CASCADE
);

-- The live-version lookup: the newest row with no closing date. Partial on
-- `effective_until IS NULL` because a closed version is never the answer.
CREATE INDEX IF NOT EXISTS "provider_cost_rule_live_idx"
	ON "provider_cost_rule" USING btree ("provider_model_id", "version")
	WHERE "effective_until" IS NULL;

-- ---------------------------------------------------------------------------
-- bucket_margin — markup per (bucket, model, optional mapping), in millionths.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "bucket_margin" (
	"id" text PRIMARY KEY,
	"bucket" text NOT NULL,
	"model_id" text NOT NULL,
	-- NULL = the margin applies to every mapping of this model in this bucket;
	-- a row naming one mapping is more specific and wins.
	"provider_model_id" text,
	"markup_millionths" bigint NOT NULL DEFAULT 1000000,
	"effective_from" timestamptz NOT NULL DEFAULT now(),
	"effective_until" timestamptz,
	CONSTRAINT "bucket_margin_markup_check" CHECK ("markup_millionths" >= 0),
	CONSTRAINT "bucket_margin_model_id_model_id_fk"
		FOREIGN KEY ("model_id") REFERENCES "public"."model"("id") ON DELETE CASCADE
);

-- Version identity: one open row per (bucket, model, mapping) at a given
-- effective_from. COALESCE folds the NULL (all-mappings) case into a single
-- key value so two NULL rows at the same instant cannot coexist.
CREATE UNIQUE INDEX IF NOT EXISTS "bucket_margin_version_idx"
	ON "bucket_margin" USING btree ("bucket", "model_id", COALESCE("provider_model_id", ''), "effective_from");

-- ---------------------------------------------------------------------------
-- bucket_quota — the frsubs rolling fair-use limit + operator knobs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "bucket_quota" (
	"bucket" text NOT NULL,
	-- '5h' | '7d' — the rolling window the counter is keyed by.
	"quota_window" text NOT NULL,
	"version" integer NOT NULL DEFAULT 1,
	-- The cap in micro-USD (retail-equivalent), not tokens: the counter stores
	-- micro-USD so no per-request conversion is needed at admission.
	"limit_micro_usd" bigint NOT NULL,
	"fx_idr_per_usd" integer NOT NULL,
	-- Operator defaults for the anti-arbitrage floor (§3.2): 30-day allowance in
	-- tokens and the throttle headroom in basis points. NULL until set.
	"allowance_token_30d" bigint,
	"throttle_headroom_bps" integer,
	"min_sample_attempts" integer DEFAULT 100,
	"min_sample_credentials" integer DEFAULT 10,
	"effective_from" timestamptz NOT NULL DEFAULT now(),
	"effective_until" timestamptz,
	PRIMARY KEY ("bucket", "quota_window", "version"),
	CONSTRAINT "bucket_quota_window_check" CHECK ("quota_window" IN ('5h', '7d')),
	CONSTRAINT "bucket_quota_limit_check" CHECK ("limit_micro_usd" > 0)
);

-- Seed the two frsubs windows at FX 16_000. DO NOTHING keeps a replay from
-- resetting a limit an operator has raised.
INSERT INTO "bucket_quota" ("bucket", "quota_window", "version", "limit_micro_usd", "fx_idr_per_usd")
VALUES
	('frsubs', '5h', 1, 3125000, 16000),
	('frsubs', '7d', 1, 31250000, 16000)
ON CONFLICT DO NOTHING;
