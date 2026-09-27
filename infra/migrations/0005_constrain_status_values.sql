-- Constrain `provider.status` and `model.status` to the values the code
-- actually understands.
--
-- Both columns are plain `text` with a default and no CHECK, so anything can be
-- written into them. That matters because the data plane matches on exact
-- literals: `internal/store` serves a model when
--
--   m.status = 'active' AND (p.status = 'active' OR (p.status = 'dev' AND <flag>))
--
-- so a typo does not error — the row just stops being served. `disabled` is
-- meant to hide a provider; `'acitve'` does exactly the same thing, silently,
-- with no log line and nothing in `/v1/models` to explain the missing slug. The
-- admin form validated against its own list (`STATUSES`), and the onboarding
-- scripts now validate too, but the column itself accepted anything, and a
-- direct `update`, a future script, or a hand-run psql session would not.
--
-- The constraint is what makes the invariant a property of the database rather
-- than of every caller that remembers to check.
--
-- NOT VALID is not used: the tables are small (9 providers, 308 models) and a
-- full validation is one sequential scan. A NOT VALID constraint would leave
-- pre-existing bad rows in place and still trust the new ones, which is the
-- worst of both.

BEGIN;

-- Guard before constraining: a bad value must be corrected deliberately, not
-- silently dropped by a delete. Nothing is deleted here, so if this trips, the
-- operator has to look at the row.
DO $$
DECLARE
  bad_provider text;
  bad_model text;
BEGIN
  SELECT string_agg(DISTINCT status, ', ') INTO bad_provider
  FROM provider
  WHERE status NOT IN ('active', 'dev', 'disabled');

  IF bad_provider IS NOT NULL THEN
    RAISE EXCEPTION
      'provider.status holds values outside (active, dev, disabled): % — fix them deliberately, this migration will not guess',
      bad_provider;
  END IF;

  SELECT string_agg(DISTINCT status, ', ') INTO bad_model
  FROM model
  WHERE status NOT IN ('active', 'inactive');

  IF bad_model IS NOT NULL THEN
    RAISE EXCEPTION
      'model.status holds values outside (active, inactive): % — fix them deliberately, this migration will not guess',
      bad_model;
  END IF;
END
$$;

ALTER TABLE provider
  DROP CONSTRAINT IF EXISTS provider_status_check,
  ADD CONSTRAINT provider_status_check
    CHECK (status IN ('active', 'dev', 'disabled'));

ALTER TABLE model
  DROP CONSTRAINT IF EXISTS model_status_check,
  ADD CONSTRAINT model_status_check
    CHECK (status IN ('active', 'inactive'));

-- Tripwire: prove the constraint is actually enforced, from inside the same
-- transaction. This is the point of the migration — a CHECK that was added but
-- not proven is just a hope. Each probe is expected to RAISE, so success here
-- means the error arrived. `begin ... exception` swallows the exact error the
-- constraint must produce; if the statement had succeeded instead, the block
-- would fall through and this migration would fail.
DO $$
DECLARE
  enforced_provider boolean := false;
  enforced_model boolean := false;
BEGIN
  BEGIN
    INSERT INTO provider (id, name, base_url, credentials_enc, status, priority)
    VALUES ('__check_probe__', 'probe', 'https://example.invalid', 'x', 'acitve', 0);
  EXCEPTION WHEN check_violation THEN
    enforced_provider := true;
  END;

  BEGIN
    -- `input_price`/`output_price` are NOT NULL, so a probe that omits them
    -- trips the wrong constraint and the check would look unenforced.
    INSERT INTO model (id, slug, name, provider_id, input_price, output_price, status)
    VALUES ('__check_probe__', '__check_probe__', 'probe', '__check_probe__', 0, 0, 'published');
  EXCEPTION WHEN check_violation THEN
    enforced_model := true;
  END;

  IF NOT enforced_provider THEN
    RAISE EXCEPTION 'provider_status_check did not reject an invalid status';
  END IF;
  IF NOT enforced_model THEN
    RAISE EXCEPTION 'model_status_check did not reject an invalid status';
  END IF;

  RAISE NOTICE 'provider and model status constraints both enforced';
END
$$;

COMMIT;
