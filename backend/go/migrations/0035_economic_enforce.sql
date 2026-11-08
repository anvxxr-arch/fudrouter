-- gated: writers must emit bucket/basis before these CHECKs tighten.
--
-- 0035_economic_enforce.sql — turn the additive 0033/0034 vocabulary into an
-- enforced contract. NOT NULL on the canonical bucket, closed enums on every
-- basis column, and the four arithmetic/three-value CHECKs that make
-- `provider_cost_micro` honest.
--
-- GATED ON PURPOSE (ops/migrate.sh:62-65): every writer that inserts these rows
-- must emit `bucket`/`billing_basis`/`cost_basis`/`markup_millionths` FIRST.
-- Applying this while a writer still emits the old shape narrows the contract
-- under it and every insert dies on `check_violation` — exactly the 0010
-- failure mode. The gate makes the staging explicit and reproducible: remove
-- the `gated:` line in the SAME commit that flips the writers (design §9 F2).
--
-- WHY THE ARITHMETIC CHECK SPELLS OUT `IS NOT NULL` (K12): a CHECK passes only
-- when its expression is FALSE, not when it is NULL. `markup_millionths > 1e6
-- AND cost = (provider_cost_micro * markup + 500000) / 1000000` evaluates to
-- NULL when provider_cost_micro is NULL, so a markup>1.0 row with NO cost would
-- slip through. The explicit `provider_cost_micro IS NOT NULL` forces the
-- branch to FALSE and rejects it (proven in PG17: T1).
--
-- WHY THE FARM-ZERO CHECK USES `IS NOT DISTINCT FROM 0`, not `= 0` (K12): the
-- same NULL-propagation bug. `provider_cost_micro = 0` is NULL when the column
-- is NULL, so `cost_basis='farm_zero'` with a NULL cost would pass — a farmed
-- row claiming zero cost with no evidence of zero. `IS NOT DISTINCT FROM 0`
-- evaluates NULL as "not zero" and rejects it (proven in PG17: T4).
--
-- IDEMPOTENT: each CHECK is dropped-if-exists before it is re-added, matching
-- 0010, so a manual replay of this file converges. SET NOT NULL is a no-op when
-- already set.
--
-- ROLLBACK: ops/rollback/0035_economic_enforce.rollback.sql drops these
-- constraints and the NOT NULL, returning the columns to the 0033 shape. It
-- never rewrites row data, so history survives the revert.

BEGIN;

-- Canonical bucket: after 0033's backfill and the writer cutover every row has
-- one, so it can be required. A NULL bucket would make precedence resolution
-- fall through to the default silently, hiding a writer bug.
ALTER TABLE "billing_account" ALTER COLUMN "bucket" SET NOT NULL;

ALTER TABLE "billing_account" DROP CONSTRAINT IF EXISTS "billing_account_bucket_check";
ALTER TABLE "billing_account" ADD CONSTRAINT "billing_account_bucket_check"
	CHECK ("bucket" IN ('frcheap', 'frpayg', 'frsubs'));

-- Overrides stay nullable (NULL = inherit), but a non-NULL value must be a real
-- bucket: `IS NULL OR IN (...)` keeps inherit legal while rejecting a typo.
ALTER TABLE "api_key" DROP CONSTRAINT IF EXISTS "api_key_bucket_check";
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_bucket_check"
	CHECK ("economic_bucket" IS NULL OR "economic_bucket" IN ('frcheap', 'frpayg', 'frsubs'));

ALTER TABLE "subscription" DROP CONSTRAINT IF EXISTS "subscription_bucket_check";
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_bucket_check"
	CHECK ("economic_bucket" IS NULL OR "economic_bucket" IN ('frcheap', 'frpayg', 'frsubs'));

ALTER TABLE "credential" DROP CONSTRAINT IF EXISTS "credential_acquisition_check";
ALTER TABLE "credential" ADD CONSTRAINT "credential_acquisition_check"
	CHECK ("acquisition" IN ('farmed', 'payg', 'oauth', 'unknown'));

-- Snapshot enums. `billing_basis` says which side the debit is priced from;
-- `cost_basis` says what `provider_cost_micro` means.
ALTER TABLE "request_log" DROP CONSTRAINT IF EXISTS "request_log_billing_basis_check";
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_billing_basis_check"
	CHECK ("billing_basis" IN ('retail', 'provider'));

ALTER TABLE "request_log" DROP CONSTRAINT IF EXISTS "request_log_cost_basis_check";
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_cost_basis_check"
	CHECK ("cost_basis" IN ('farm_zero', 'subscription_flat', 'provider', 'retail', 'unknown'));

-- Markup > 1.0 is only legal over real provider COGS at the exact half-up
-- arithmetic the writer uses. Anything else is an imaginary margin on top of a
-- retail or NULL cost.
ALTER TABLE "request_log" DROP CONSTRAINT IF EXISTS "request_log_markup_basis_check";
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_markup_basis_check" CHECK (
	"markup_millionths" <= 1000000
	OR (
		"billing_basis" = 'provider'
		AND "cost_basis" = 'provider'
		AND "provider_cost_micro" IS NOT NULL
		AND "currency" = 'USD'
		AND "cost" = ("provider_cost_micro" * "markup_millionths" + 500000) / 1000000
	)
);

-- Three-value COGS: farmed supply costs exactly 0, and only with evidence of a
-- farm_zero basis. NULL (flat subscription) is explicitly NOT zero.
ALTER TABLE "request_log" DROP CONSTRAINT IF EXISTS "request_log_farm_zero_check";
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_farm_zero_check"
	CHECK ("cost_basis" <> 'farm_zero' OR "provider_cost_micro" IS NOT DISTINCT FROM 0);

-- A flat-fee subscription has no per-request COGS: NULL, never 0.
ALTER TABLE "request_log" DROP CONSTRAINT IF EXISTS "request_log_subscription_flat_check";
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_subscription_flat_check"
	CHECK ("cost_basis" <> 'subscription_flat' OR "provider_cost_micro" IS NULL);

-- 'retail'/'unknown' cannot claim a COGS value — a non-NULL number there would
-- be a zero/alias claim without farm_zero evidence. They must stay NULL.
ALTER TABLE "request_log" DROP CONSTRAINT IF EXISTS "request_log_unknown_cogs_check";
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_unknown_cogs_check"
	CHECK ("cost_basis" NOT IN ('retail', 'unknown') OR "provider_cost_micro" IS NULL);

COMMIT;
