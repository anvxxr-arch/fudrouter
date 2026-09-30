-- 0010_platform_status_narrow — narrow status vocabularies to the PRD sets + migrate values.
--
-- DANGER: this migration is only HALF the cutover. It MUST land in the SAME
-- commit that flips every writer of these values and the `publish.ts`
-- reachability predicate + the mirrored SQL in
-- `services/router/internal/store`. Apply the SQL and flip the code together,
-- or live writes are rejected by the narrowed CHECKs / the public catalog goes
-- dark. See docs/specs/2026-09-30-platform-schema.md §0010 for the sweep list.
--
-- DO NOT apply this file on its own. It is staged here (not applied) so the
-- cutover commit is mechanical: flip the writers, then `migrate up` runs this.
--
-- Value migration (safe, idempotent on already-migrated rows):
--   provider.status: 'active' | 'dev' -> 'operational'   (PRD §52; the S0 dev
--                    flag lives in provider.tier since 0007, so no information
--                    is lost — tier already carries it)
--   model.status:    'inactive'      -> 'deprecated'     (PRD §125)
-- 'active' models are already the PRD value and are left untouched.
BEGIN;

-- provider.status: S0 -> PRD §52.
UPDATE provider SET status = 'operational'
WHERE status IN ('active', 'dev');

-- model.status: S0 -> PRD §125.
UPDATE model SET status = 'deprecated'
WHERE status = 'inactive';

-- Narrow provider_status_check to PRD §52 (was widened to both sets in 0009).
ALTER TABLE provider DROP CONSTRAINT IF EXISTS provider_status_check;
ALTER TABLE provider ADD CONSTRAINT provider_status_check
  CHECK (status IN ('operational', 'degraded', 'disabled', 'maintenance', 'outage'));

-- Narrow model_status_check to PRD §125 (was widened to both sets in 0009).
ALTER TABLE model DROP CONSTRAINT IF EXISTS model_status_check;
ALTER TABLE model ADD CONSTRAINT model_status_check
  CHECK (status IN ('active', 'deprecated', 'sunset', 'disabled'));

COMMIT;

-- Deferred to a later migration (NOT here): the `request_log.status` constraint
-- (spec §8 taxonomy) lands once the data plane's legacy `error`/`upstream_error`
-- writers are gone (RouterPlane rewrite).
