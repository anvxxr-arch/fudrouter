-- 0032_virtual_tier_aliases.rollback.sql — undo migration 0032 exactly.
--
-- Deletes the three `model_alias` rows 0032 inserted, by id, so a database that
-- already had a row of the same NAME (created by an operator) is left alone —
-- only the ids this migration owns are removed.
--
-- `model_alias_target` rows attached to these aliases are removed with them by
-- the ON DELETE CASCADE on `model_alias_target.alias_id`. That is the intended
-- revert, not collateral damage: the allowlist only means something while the
-- tier row exists, and leaving orphan targets behind is impossible by schema.
--
-- What survives the rollback: resolution itself. `fudrouter/smart` and friends
-- are known to the router through the virtualModels map in
-- internal/store/catalog.go, so after this rollback they still resolve — to the
-- full active fan-out, exactly as they did before 0032. No request that worked
-- before the rollback starts failing because of it.
--
-- Idempotent: a second run deletes nothing.
--
-- Apply inside one transaction so a half-undone schema is impossible:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f ops/rollback/0032_virtual_tier_aliases.rollback.sql

DELETE FROM "model_alias"
WHERE "id" IN ('als_fudrouter-smart', 'als_fudrouter-medium', 'als_fudrouter-worker');
