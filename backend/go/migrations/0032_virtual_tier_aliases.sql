-- 0032_virtual_tier_aliases.sql — register the three new allowlist tiers.
--
-- WHY: `fudrouter/auto`, `/smart`, `/medium` and `/worker` are the customer-facing
-- tier ladder (PRD §36). `auto` already has a `model_alias` row from 0007; the
-- other three did not, which meant the catalogue could not describe them and —
-- more importantly — an operator had no row to attach `model_alias_target`
-- entries to. Without a row, `fudrouter/smart` still RESOLVES (the router knows
-- the name from internal/store/catalog.go's virtualModels map), but the allowlist
-- that makes it a tier rather than a synonym for `auto` is unrepresentable.
--
-- WHY A ROW IS THE RIGHT PLACE FOR THE ALLOWLIST: `model_alias_target` is the
-- table that already expresses "this name maps to these models" (0006), and
-- 0019 collapsed the project/workspace scopes into `account_id`. A NULL
-- `account_id` is the platform-wide row, which is exactly what a global tier is.
-- Putting the list anywhere else (a config file, an env var) would make the
-- routing decision invisible to the control plane and to `/v1/models`.
--
-- WHY THESE STRATEGIES: every strategy below is already implemented in
-- internal/routing/select.go — this migration adds no behaviour, it names the
-- rows so the behaviour can be configured:
--
--	fudrouter/auto    random               widest live set, fair draw
--	fudrouter/smart   highest_reliability  measured success EWMA
--	fudrouter/medium  lowest_latency       measured p95
--	fudrouter/worker  lowest_cost          declared + rule pricing
--
-- The strategy itself lives in the Go map, not in this table: `model_alias` has
-- no strategy column, and adding one would duplicate a decision the resolver
-- already makes per name. This migration only makes the names addressable.
--
-- BACKWARD COMPATIBLE: these are NEW rows with NO targets, so each name resolves
-- through the same full fan-out it would have used had it been reachable at all.
-- An operator narrows a tier by inserting `model_alias_target` rows; deleting
-- them restores the fan-out. Nothing existing changes shape.
--
-- IDEMPOTENT: `ON CONFLICT ("id") DO NOTHING`, and the account/name unique index
-- is satisfied because no other row claims these names. Re-running is a no-op.
--
-- ROLLBACK: ops/rollback/0032_virtual_tier_aliases.rollback.sql deletes exactly
-- these three ids. `model_alias_target` rows attached to them go with them via
-- the ON DELETE CASCADE on `alias_id`, which is the intended revert: the name
-- stops existing as a configurable tier, and resolution falls back to the
-- virtualModels map alone (still routable, no allowlist).
--
-- ATOMICITY: no BEGIN/COMMIT, matching 0026/0028/0030/0031 — the runner applies
-- the file with ON_ERROR_STOP so a failure aborts before `schema_migration`
-- records it.

INSERT INTO "model_alias" ("id", "account_id", "name", "description", "enabled")
VALUES
	('als_fudrouter-smart',  NULL, 'fudrouter/smart',  'Route to the model with the highest measured success rate; the reliability tier.', true),
	('als_fudrouter-medium', NULL, 'fudrouter/medium', 'Route to the model with the lowest measured p95 latency; the latency tier.', true),
	('als_fudrouter-worker', NULL, 'fudrouter/worker', 'Route to the cheapest model that can serve the request; the cost tier.', true)
ON CONFLICT ("id") DO NOTHING;
