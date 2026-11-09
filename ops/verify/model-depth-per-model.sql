-- Per-model merge depth, identity-folded, using exactly the eligibility rules the
-- router applies before it will dial a mapping (see ops/verify/model-depth.sql).
--
-- "Depth" here = how many DISTINCT providers can serve one canonical identity.
-- One provider is a single point of failure; the card's goal is to move
-- identities from depth 1 to depth >= 2 without inventing providers.
--
-- Reading it:
--   * the identity is resolved through model_slug_alias, so a mapping stored on a
--     non-canonical spelling is counted for the canonical model (the router folds
--     the same way in internal/store/catalog.go);
--   * a mapping counts only if model + provider_model + connection are enabled,
--     the model is active and not chat=false, the connection is not unhealthy,
--     and at least one credential is neither disabled/invalid nor cooling down.
--     A row that exists but cannot dial is NOT depth.
--
-- Usage:  psql "$DATABASE_URL" -X -f ops/verify/model-depth-per-model.sql
--         psql "$DATABASE_URL" -X -f ops/verify/model-depth-per-model.sql -v min_depth=2
\if :{?min_depth}
\else
  \set min_depth 2
\endif

WITH resolvable AS (
  SELECT m.id AS model_id,
         coalesce(canon.slug, m.slug) AS canonical_slug
  FROM model m
  LEFT JOIN model_slug_alias identity ON identity.alias = m.slug
  LEFT JOIN model canon ON canon.id = identity.canonical_model_id AND canon.status = 'active'
  WHERE m.status = 'active'
    AND (m.capabilities->>'chat') IS DISTINCT FROM 'false'
),
live_mapping AS (
  SELECT r.canonical_slug, pm.provider_id
  FROM provider_model pm
  JOIN resolvable r ON r.model_id = pm.model_id
  JOIN connection c ON c.id = pm.connection_id
  WHERE pm.enabled
    AND pm.status NOT IN ('disabled','unavailable')
    AND c.enabled
    AND c.health_status IS DISTINCT FROM 'unhealthy'
    AND EXISTS (
      SELECT 1 FROM credential cr
      WHERE cr.connection_id = c.id
        AND cr.status NOT IN ('disabled','invalid')
        AND (cr.cooldown_until IS NULL OR cr.cooldown_until <= now())
    )
)
SELECT canonical_slug,
       count(DISTINCT provider_id) AS depth,
       string_agg(DISTINCT provider_id, ', ' ORDER BY provider_id) AS providers
FROM live_mapping
GROUP BY canonical_slug
HAVING count(DISTINCT provider_id) >= :min_depth
ORDER BY depth DESC, canonical_slug;
