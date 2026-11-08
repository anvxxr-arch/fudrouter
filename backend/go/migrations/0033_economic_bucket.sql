-- 0033_economic_bucket.sql — bucket identity, supply guard, and the per-row
-- economic snapshot. Additive only: every column is nullable or defaulted, so a
-- live database keeps writing its old shape while the new columns fill in.
--
-- WHY (docs/specs/2026-11-08-economic-layer-design.md §3–§4): the router now
-- sells three economics classes — `frcheap` (flat 100k IDR/28d, farmed/free
-- supply), `frpayg` (prepaid, metered per token) and `frsubs` (flat
-- 150–500k IDR/28d, subscription/OAuth supply). Without a bucket ON the row,
-- "what did we pay?" and "what did we charge?" have to be re-derived from
-- provider/config at read time, and history silently changes whenever that
-- config moves. The snapshot columns freeze both sides of the trade.
--
-- WHY THIS REPLACES `provider_cost_micro = cost` (lifecycle.go:1312): that
-- assignment is a lie. A flat-fee subscription has NO per-request cost (NULL,
-- not 0), a farmed credential costs 0 (verified farm_zero), and a metered
-- provider costs the real invoice. One copied number erased all three meanings;
-- `cost_basis` records which meaning a row carries.
--
-- WHY `provider_model_supply` IS A JOIN TABLE, not a column on `provider_model`
-- (K3): one mapping can legitimately serve more than one bucket (a metered
-- provider account that is also usable by a subscription key). A column would
-- force duplicating the 728-row mapping table per bucket; the join table lets
-- one mapping appear in N buckets without touching the routing row.
--
-- WHY `quota_usage_micro` IS A SEPARATE COLUMN from `cost`: a flat-fee `frsubs`
-- request debits 0 (the money was paid up front), so `cost = 0` would erase the
-- only meter a fair-use quota can read. `quota_usage_micro` is the retail-
-- equivalent value of the same tokens, written only for `frsubs` (K7/K9).
--
-- NOT GATED: adding nullable/defaulted columns and indexes cannot reject an
-- existing row, so this file applies on its own. The CHECKs that make these
-- values honest land in the gated 0035, after every writer emits them
-- (ops/migrate.sh:62-65).
--
-- IDEMPOTENT: `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`,
-- `CREATE INDEX IF NOT EXISTS`, and the backfill filters `IS NULL`, so a
-- partially applied database or a replay converges instead of aborting.
--
-- ROLLBACK: ops/rollback/0033_economic_bucket.rollback.sql drops exactly the
-- columns, table and indexes this file adds.

-- ---------------------------------------------------------------------------
-- Canonical bucket: one per account, with a per-key override and a per-
-- subscription override. Precedence at admission is
-- subscription live -> api_key.economic_bucket -> billing_account.bucket ->
-- 'frpayg' (K2); the columns are the three tiers of that precedence.
-- ---------------------------------------------------------------------------
ALTER TABLE "billing_account" ADD COLUMN IF NOT EXISTS "bucket" text DEFAULT 'frpayg';

-- A per-key override. NULL means "inherit the account bucket", which is why it
-- is nullable: only a key that deliberately differs from its account carries a
-- value.
ALTER TABLE "api_key" ADD COLUMN IF NOT EXISTS "economic_bucket" text;

-- A live subscription grants a bucket for its lifetime. NULL = no subscription
-- tier, so the key/account precedence applies.
ALTER TABLE "subscription" ADD COLUMN IF NOT EXISTS "economic_bucket" text;

-- ---------------------------------------------------------------------------
-- Credential provenance: how the supply was acquired, and its flat cost.
-- `acquisition='farmed'` is the ONLY evidence that allows a farm_zero COGS of
-- exactly 0 (design invariant 2); anything else must stay `unknown` until an
-- operator triages it. `cost_basis_micro_per_day` is the flat subscription cost
-- amortised per day, used by the anti-arbitrage floor (§3.2), not by the
-- per-request charge.
-- ---------------------------------------------------------------------------
ALTER TABLE "credential" ADD COLUMN IF NOT EXISTS "acquisition" text DEFAULT 'unknown';
ALTER TABLE "credential" ADD COLUMN IF NOT EXISTS "cost_basis_micro_per_day" bigint;

-- ---------------------------------------------------------------------------
-- Supply guard: which buckets a mapping may serve. The PK is the natural key —
-- a mapping is in a bucket or it is not, and there is no surrogate id any query
-- would use.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "provider_model_supply" (
	"provider_model_id" text NOT NULL,
	"bucket" text NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY ("provider_model_id", "bucket"),
	-- CASCADE: a supply declaration without its mapping is a dangling routing
	-- claim; it dies with the row it describes.
	CONSTRAINT "provider_model_supply_provider_model_id_provider_model_id_fk"
		FOREIGN KEY ("provider_model_id") REFERENCES "public"."provider_model"("id") ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Per-row economic snapshot. Each column answers one question and is frozen at
-- request time so a later price/config change never rewrites history.
-- ---------------------------------------------------------------------------
-- Effective bucket of this request. NULL only for rows written before the
-- backfill below (and then immediately filled).
ALTER TABLE "request_log" ADD COLUMN IF NOT EXISTS "bucket" text;
-- Which bucket the SERVING mapping came from, when it differs from the buyer's
-- bucket (e.g. an frpayg key routed over farmed supply).
ALTER TABLE "request_log" ADD COLUMN IF NOT EXISTS "supply_bucket" text;
-- Which side the customer debit is priced from: retail list price, or real
-- provider COGS.
ALTER TABLE "request_log" ADD COLUMN IF NOT EXISTS "billing_basis" text NOT NULL DEFAULT 'retail';
-- The meaning of `provider_cost_micro`: farm_zero (0), subscription_flat (NULL),
-- provider (real), retail/unknown (NULL).
ALTER TABLE "request_log" ADD COLUMN IF NOT EXISTS "cost_basis" text NOT NULL DEFAULT 'retail';
-- Markup applied on top of COGS, in millionths (1_000_000 = 1.0). Default 1.0
-- is the passthrough that legacy rows already used.
ALTER TABLE "request_log" ADD COLUMN IF NOT EXISTS "markup_millionths" bigint NOT NULL DEFAULT 1000000;
-- Retail-equivalent meter for the frsubs fair-use quota; NULL for every other
-- bucket and for requests not yet metered.
ALTER TABLE "request_log" ADD COLUMN IF NOT EXISTS "quota_usage_micro" bigint;
-- Estimated COGS when no invoice exists (frcheap churn, unknown provenance).
-- Distinct from provider_cost_micro, which is only ever a real/verified value.
ALTER TABLE "request_log" ADD COLUMN IF NOT EXISTS "cogs_estimated_micro" bigint;

-- ---------------------------------------------------------------------------
-- Backfill legacy rows to the honest passthrough they already were: every row
-- written before this migration used retail pricing and copied retail cost into
-- provider_cost_micro, i.e. basis retail/retail at markup 1.0. Only NULL rows
-- are touched, so a re-run cannot overwrite a value a writer has since set.
--
-- provider_cost_micro is NULLED for exactly these rows. That column is the
-- three-value COGS claim (K4): retail/unknown basis carries NO COGS value, so
-- the legacy `provider_cost_micro = cost` copy is the "lie" the design names
-- (lifecycle.go:1312) and must not survive under a retail basis. This is not
-- optional cleanup: 0035's request_log_unknown_cogs_check requires
-- `cost_basis NOT IN ('retail','unknown') OR provider_cost_micro IS NULL`, so
-- leaving the copy in place makes 0035 un-appliable on any database with
-- legacy rows (measured: 549,869 in production). The value is not lost
-- information — it was always equal to `cost`, which the row still carries.
-- ---------------------------------------------------------------------------
UPDATE "request_log"
SET "bucket" = 'frpayg',
    "billing_basis" = 'retail',
    "cost_basis" = 'retail',
    "markup_millionths" = 1000000,
    "provider_cost_micro" = NULL
WHERE "bucket" IS NULL;

UPDATE "billing_account" SET "bucket" = 'frpayg' WHERE "bucket" IS NULL;

UPDATE "credential" SET "acquisition" = 'unknown' WHERE "acquisition" IS NULL;

-- ---------------------------------------------------------------------------
-- Read-path indexes. `bucket` is a low-cardinality leading column, so pairing it
-- with `created_at` serves the per-bucket range scans the spend dashboards run.
-- The quota index is partial on a non-NULL meter so it holds only frsubs rows,
-- and INCLUDE keeps the SUM() index-only.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "request_log_bucket_created_idx"
	ON "request_log" USING btree ("bucket", "created_at");

CREATE INDEX IF NOT EXISTS "request_log_user_quota_idx"
	ON "request_log" USING btree ("user_id", "created_at")
	INCLUDE ("quota_usage_micro")
	WHERE "quota_usage_micro" IS NOT NULL;
