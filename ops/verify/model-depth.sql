-- Read-only A1 depth report. Run with psql "$DATABASE_URL" -X -At -f this_file.
-- Both phases use the same snapshot and the task's exact eligibility predicate.
-- Only the identity dimension changes: stored row before, alias-folded row after.
-- Provider publication/tier and legacy blobs are deliberately NOT extra gates.
WITH eligible AS (
	SELECT m.id AS source_model_id,
	       coalesce(canonical.id, m.id) AS canonical_model_id,
	       pm.provider_id
	FROM model m
	JOIN provider_model pm ON pm.model_id = m.id
	JOIN connection c ON c.id = pm.connection_id
	LEFT JOIN model_slug_alias identity ON identity.alias = m.slug
	LEFT JOIN model canonical ON canonical.id = identity.canonical_model_id
	  AND canonical.status = 'active'
	WHERE m.status = 'active'
	  AND (m.capabilities->>'chat') IS DISTINCT FROM 'false'
	  AND pm.enabled
	  AND pm.status NOT IN ('disabled', 'unavailable')
	  AND c.enabled
	  AND c.health_status IS DISTINCT FROM 'unhealthy'
	  AND EXISTS (
	      SELECT 1 FROM credential cr
	      WHERE cr.connection_id = c.id
	        AND cr.status NOT IN ('disabled', 'invalid')
	        AND (cr.cooldown_until IS NULL OR cr.cooldown_until <= now())
	  )
), depths AS (
	SELECT 'before' AS phase, source_model_id AS model_id, count(DISTINCT provider_id) AS depth
	FROM eligible GROUP BY source_model_id
	UNION ALL
	SELECT 'after', canonical_model_id, count(DISTINCT provider_id)
	FROM eligible GROUP BY canonical_model_id
), distribution AS (
	SELECT phase,
	       count(*) AS total,
	       count(*) FILTER (WHERE depth = 1) AS depth_1,
	       count(*) FILTER (WHERE depth = 2) AS depth_2,
	       count(*) FILTER (WHERE depth >= 3) AS depth_3_plus
	FROM depths GROUP BY phase
)
SELECT jsonb_object_agg(phase, jsonb_build_object(
	'total', total,
	'depth_1', depth_1, 'depth_1_pct', round(100.0 * depth_1 / nullif(total, 0), 2),
	'depth_2', depth_2, 'depth_2_pct', round(100.0 * depth_2 / nullif(total, 0), 2),
	'depth_3_plus', depth_3_plus, 'depth_3_plus_pct', round(100.0 * depth_3_plus / nullif(total, 0), 2)
)) FROM distribution;
