-- Promote every provider to `active`.
--
-- The owner confirmed on 2026-09-26 that all seven upstreams are commercial
-- arrangements. `provider.status = 'dev'` means "a non-commercial /
-- personal-OAuth provider that must not ship" (spec §1), so `dev` was never the
-- truthful label here — it was inherited from the onboarding scripts, three of
-- which default to `dev` and whose upsert overwrites an existing row's status
-- on every re-run.
--
-- Making the data truthful decouples the catalog from
-- `ROUTER_ALLOW_DEV_PROVIDERS`, which until now was the difference between 270
-- served models and an empty product.
--
-- The gate itself is NOT changed here: the router must keep serving a `dev`
-- provider when the flag is on, because that is a spec §1 safety interlock and
-- the test suite pins both branches. This only stops the production catalog
-- from depending on that interlock.

BEGIN;

UPDATE provider SET status = 'active' WHERE status = 'dev';

-- The assertions below are a tripwire, not a proof. Because this statement
-- promotes every `dev` row, the two counts are equal by construction and the
-- check cannot fail on this data; its real job is to fail loudly on a future
-- edit of this file that narrows the UPDATE (a name filter, a status allow-list)
-- and reintroduces a catalog that depends on the flag. That was the shape of the
-- bug this migration exists to remove, so the tripwire stays — it costs one
-- query and it is the only thing standing between a future edit and a silent
-- regression to "270 models or zero".
DO $$
DECLARE
  dev_left integer;
  served_flag_on integer;
  served_flag_off integer;
  published integer;
BEGIN
  SELECT count(*) INTO dev_left FROM provider WHERE status = 'dev';
  IF dev_left <> 0 THEN
    RAISE EXCEPTION 'expected 0 dev providers after promotion, got %', dev_left;
  END IF;

  SELECT count(*) INTO published
  FROM model m JOIN provider p ON p.id = m.provider_id
  WHERE m.status = 'active';

  SELECT count(*) INTO served_flag_on
  FROM model m JOIN provider p ON p.id = m.provider_id
  WHERE m.status = 'active' AND (p.status = 'active' OR p.status = 'dev');

  SELECT count(*) INTO served_flag_off
  FROM model m JOIN provider p ON p.id = m.provider_id
  WHERE m.status = 'active' AND p.status = 'active';

  IF served_flag_on <> served_flag_off THEN
    RAISE EXCEPTION 'catalog still depends on the flag: on=% off=%',
      served_flag_on, served_flag_off;
  END IF;

  RAISE NOTICE 'published=%  served(flag on)=%  served(flag off)=%  — decoupled',
    published, served_flag_on, served_flag_off;
END
$$;

COMMIT;
