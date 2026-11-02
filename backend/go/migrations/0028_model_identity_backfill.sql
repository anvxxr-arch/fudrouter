-- 0027_model_identity_backfill.sql — preserve names, unite provider fan-out.
--
-- 0026 recorded identities but ResolveModel preferred a live duplicate and the
-- candidate query still joined only its id. On the catalogue copy, the exact
-- active/chat/connection/credential predicate found 159 models, 152 at depth 1;
-- adding alias rows alone did not change a single candidate set. The router now
-- uses this identity on both resolution and candidate reads. Model rows, upstream
-- ids, mapping ids and price history stay in place: deleting or re-keying them
-- would either break old slugs or change the auditable billing history.
--
-- model_alias is already the account-scoped, ordered-target feature (0006/0019).
-- model_slug_alias is deliberately separate, so existing account aliases retain
-- their precedence and their foreign keys.
CREATE TABLE IF NOT EXISTS "model_slug_alias" (
	"alias" text PRIMARY KEY NOT NULL,
	"canonical_model_id" text NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "model_slug_alias_canonical_model_id_model_id_fk"
		FOREIGN KEY ("canonical_model_id") REFERENCES "public"."model"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "model_slug_alias_canonical_idx"
	ON "model_slug_alias" USING btree ("canonical_model_id");

-- Strip only a namespace belonging to the row's actual provider, and only when
-- the entire remainder already exists. Stripping every slash to its leaf can
-- conflate vendor/model with an unrelated model. InferHub's nested namespaces
-- are the registry already used by ops/merge-model-prefixes.mjs; they are scoped
-- to that provider rather than treated as globally reserved prefixes.
WITH provider_prefix AS (
	SELECT id AS provider_id, lower(id) AS prefix FROM provider
	UNION
	SELECT id, lower(regexp_replace(id, '^prv[_-]', '')) FROM provider
	UNION
	SELECT id, lower(slug) FROM provider WHERE coalesce(slug, '') <> ''
	UNION
	SELECT id, lower(regexp_replace(slug, '^prv[_-]', ''))
	FROM provider WHERE coalesce(slug, '') <> ''
	UNION
	SELECT p.id, x.prefix
	FROM provider p
	CROSS JOIN unnest(ARRAY[
		'ag', 'ali', 'cb', 'cbcn', 'cc', 'cmc', 'cp', 'cx', 'ocg', 'ih',
		'cp/cline-pass', 'cp/zai', 'cp/xai', 'cmc/zai-org', 'cmc/z-ai',
		'cmc/moonshotai', 'cmc/minimaxai', 'cmc/meta', 'cmc/xai'
	]) AS x(prefix)
	WHERE p.id = 'prv_inferhub'
), family AS (
	SELECT m.id, m.slug, m.status,
	       coalesce((
	           SELECT lower(t.slug)
	           FROM provider_prefix pp
	           JOIN model t ON lower(t.slug) = lower(substr(m.slug, length(pp.prefix) + 2))
	           WHERE left(lower(m.slug), length(pp.prefix) + 1) = pp.prefix || '/'
	             AND position('/' in t.slug) = 0
	             AND (m.provider_id = pp.provider_id OR EXISTS (
	                 SELECT 1 FROM provider_model pm
	                 WHERE pm.model_id = m.id AND pm.provider_id = pp.provider_id
	             ))
	           ORDER BY length(pp.prefix) DESC, t.slug
	           LIMIT 1
	       ), lower(m.slug)) AS family_key
	FROM model m
), ranked AS (
	SELECT f.id, f.slug, f.family_key,
	       first_value(f.id) OVER (
	           PARTITION BY f.family_key
	           ORDER BY (f.status = 'active') DESC,
	                    (position('/' in f.slug) = 0) DESC,
	                    (f.slug = lower(f.slug)) DESC,
	                    f.slug, f.id
	       ) AS canonical_model_id
	FROM family f
)
INSERT INTO "model_slug_alias" ("alias", "canonical_model_id")
SELECT slug, canonical_model_id FROM ranked WHERE id <> canonical_model_id
-- Preserve an operator's explicit binding, and keep repeated runs byte-for-byte
-- identical rather than rewriting created_at or choosing a new winner.
ON CONFLICT ("alias") DO NOTHING;
