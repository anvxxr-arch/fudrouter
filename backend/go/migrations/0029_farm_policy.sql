-- 0026_farm_policy.sql — per-provider signup-farm policy + dry-run planning.
--
-- NOTHING in this migration or in cmd/farmplan executes a farm. The operator's
-- standing order (2026-10-24) is that farms stay OFF and run only on a manual
-- trigger; this table exists so the planner can answer "what WOULD be farmed"
-- without a single outbound request.
--
-- Why a table and not constants: the live pool is wildly uneven — 11,427 of
-- 74,242 credentials are invalid (mistral alone carries 10,187, tokenharbor
-- 1,214) and 2,008 sit rate_limited (freeai 737, zro 462) — so "top the pool
-- up to N" is a per-provider decision, not a global one. enabled defaults to
-- FALSE for every provider (one seeded row each): a policy row is a statement
-- of intent, and intent must be explicit before anything may fire.
--
-- Why last_run_at lives here: cooldown_minutes is meaningless without the run
-- it cools down FROM. The evaluator computes remaining = cooldown_minutes -
-- since(last_run_at); a NULL last_run_at (every row, today) means never-run
-- and therefore never-cooled. Without the column the cooldown state would be
-- unrepresentable and the planner could only ever print "ready".
--
-- trigger_codes extends the built-in quota signals (INSUFFICIENT_CREDITS,
-- RATE_LIMITED) with provider-specific codes. The 24h production taxonomy is
-- dominated by CIRCUIT_OPEN 449 / UPSTREAM_ERROR 160 / PROVIDER_UNAVAILABLE 99
-- — noise for farming — so the meaningful subset is opt-in per provider rather
-- than a hardcoded list that grows on every router release.

CREATE TABLE IF NOT EXISTS "farm_policy" (
	-- One row per provider: the policy IS identified by its provider, so the
	-- PK carries the FK instead of a surrogate id no query would use.
	"provider_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean NOT NULL DEFAULT false,
	-- Deficit floor: a pool below min_usable_creds fires the deficit trigger
	-- even with no error codes (a silent drain leaves no errors to read).
	"min_usable_creds" integer NOT NULL DEFAULT 0,
	-- Pool ceiling the planner tops up to. 0 = no target configured; the
	-- evaluator then wants 0 credentials even when a trigger fires.
	"target_creds" integer NOT NULL DEFAULT 0,
	-- Extra request_log/request_attempt error codes treated as quota signals,
	-- on top of the built-in INSUFFICIENT_CREDITS and RATE_LIMITED.
	"trigger_codes" text[] NOT NULL DEFAULT '{}',
	-- Post-run cooldown: after a farm run, the policy is blocked for this many
	-- minutes. Combined with last_run_at below.
	"cooldown_minutes" integer NOT NULL DEFAULT 0,
	-- When this policy last executed a farm run. NULL = never (nothing has
	-- executed; see the standing order at the top of this file).
	"last_run_at" timestamptz,
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "farm_policy_min_usable_check" CHECK ("min_usable_creds" >= 0),
	CONSTRAINT "farm_policy_target_check" CHECK ("target_creds" >= 0),
	CONSTRAINT "farm_policy_cooldown_check" CHECK ("cooldown_minutes" >= 0),
	CONSTRAINT "farm_policy_provider_id_provider_id_fk"
		FOREIGN KEY ("provider_id") REFERENCES "public"."provider"("id") ON DELETE CASCADE
);

-- Seed one disabled row per existing provider: an operator flips enabled on a
-- provider they have decided to farm, never the reverse. DO NOTHING keeps a
-- re-run from resetting a value someone chose.
INSERT INTO "farm_policy" ("provider_id")
	SELECT "id" FROM "provider"
ON CONFLICT ("provider_id") DO NOTHING;

-- The planner runs per provider; without this index it would scan all
-- credentials per provider on a 74k-row table.
CREATE INDEX IF NOT EXISTS "credential_connection_status_idx"
	ON "credential" USING btree ("connection_id", "status");
