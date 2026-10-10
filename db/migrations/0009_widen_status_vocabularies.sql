-- 0009_widen_status_vocabularies.sql — WIDEN ONLY, no value migration.
--
-- Source of truth: docs/specs/2026-09-30-platform-schema.md §1 "Migration sequencing".
--
-- Why widen first: PRD §52 (provider: operational|degraded|disabled|maintenance|
-- outage) and PRD §125 (model: active|deprecated|sunset|disabled) are the target
-- vocabularies, but migration 0005 pinned `provider_status_check` to
-- ('active','dev','disabled') and `model_status_check` to ('active','inactive').
-- Admin forms writing the PRD values hit `check_violation` on every insert/update
-- (measured by AdminOps, 2026-09-30).
--
-- Deliberately NOT a value migration here. Mapping 'dev' -> 'operational' or
-- 'inactive' -> 'deprecated' in the same file as the constraint change would
-- break the two reachability predicates that still read the old literals
-- (`apps/web/src/lib/publish.ts` and `apps/router/internal/store`) — flip
-- one without the other and every published model vanishes from /models and
-- /v1/models. That cutover lands as ONE commit (0010) with the predicate flips
-- and the 27 onboarding-script sweeps. Until then both vocabularies coexist and
-- every reader already handles both (the router's `providerServableSQL` was
-- written dual-vocabulary for exactly this window).
--
-- Accepting both sets is safe in the transition window: nothing constrains a
-- writer to one side, and reads are already dual. 0010 narrows to the PRD set.

BEGIN;

ALTER TABLE "provider" DROP CONSTRAINT IF EXISTS "provider_status_check";
ALTER TABLE "provider" ADD CONSTRAINT "provider_status_check"
	CHECK ("status" IN (
		-- S0 vocabulary (0005), until 0010 narrows.
		'active', 'dev',
		-- PRD §52 vocabulary.
		'operational', 'degraded', 'disabled', 'maintenance', 'outage'
	));

ALTER TABLE "model" DROP CONSTRAINT IF EXISTS "model_status_check";
ALTER TABLE "model" ADD CONSTRAINT "model_status_check"
	CHECK ("status" IN (
		-- S0 vocabulary (0005), until 0010 narrows.
		'active', 'inactive',
		-- PRD §125 vocabulary.
		'deprecated', 'sunset', 'disabled'
	));

-- request_log.status has never had a CHECK (0005 did not touch it). Its
-- constraint waits for the data plane's old writers to be gone — the router is
-- mid-rewrite to the spec §8 taxonomy and its "writers done" signal is the gate.
-- Nothing to widen here: with no constraint, any value writes freely today.

COMMIT;
