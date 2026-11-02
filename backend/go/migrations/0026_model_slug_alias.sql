-- 0026_model_slug_alias.sql — one upstream model = one canonical row.
--
-- The defect it records: `model` has a NOT NULL UNIQUE `slug`, and the bulk
-- onboarders (ops/onboard-*.mjs, ops/seed-models.mjs) mint a row per
-- (provider, upstream model id) — with the provider namespace PREFIXED onto the
-- slug and with the upstream's own CASING. So one upstream model exists as
-- several canonical rows. MEASURED on the deployed catalogue (2026-11-02, 570
-- rows): `kimi-k2.6`, `Kimi-K2.6` and `tokenharbor/kimi-k2.6` are three rows,
-- and the same upstream model accounts for eight in total across cbcn, cp,
-- ocg, cmc/moonshotai and moonshotai; `deepseek-v4.1-flash` accounts for
-- eleven. 260 of the 570 rows sit in one of the 74 multi-row families (186 of
-- them are aliases; 384 identities remain).
--
-- Why that is a ROUTING defect, not a cosmetic one: the candidate fan-out is
-- `model.id -> provider_model -> provider`, so each duplicate row owns only ITS
-- OWN providers. An upstream model reachable through four providers is four
-- depth-1 rows instead of one depth-4 model, and the attempt walker has nothing
-- left to fail over to when the first is down. The task's routing predicate
-- measured 152 of 159 eligible models at depth 1; only families with another
-- usable provider can gain depth from identity folding.
--
-- Nothing is renamed and the rows are NOT merged. Both would break clients: the
-- prefixed and mixed-case strings are in the wild, and `model.slug` is unique so
-- a merge has to delete rows that `request_log.model_id` and `provider_model`
-- still reference. This migration records the IDENTITY only. ResolveModel and
-- CandidatesBatch use it without moving either the model or its mappings, so
-- the old input names and the mapping's original price history survive.
--
-- Name: `model_slug_alias`, deliberately NOT `model_alias`. `model_alias`
-- already exists (0006) for a different feature — a customer-authored NAME for a
-- SET of models with an ordered `model_alias_target` list, resolved per account.
-- Its shape (`id, account_id, name, enabled`) cannot carry a canonical-slug
-- identity without overloading `name` with two meanings and applying its unique
-- index `(account_id, name)` to rows that are not account-scoped. One table per
-- concept. This is also not `provider_model.provider_model_id`: that column is
-- the name sent UPSTREAM on one mapping; this table is the canonical-side
-- identity the CLIENT names.
--
-- Idempotent on purpose: it is re-runnable
-- (CREATE ... IF NOT EXISTS, and the backfill inserts ON CONFLICT DO NOTHING) so
-- a partially-applied database, or a rehearsal that follows the documented
-- pg_dump + migrate recipe, converges instead of aborting on the second run.
-- The migration tests execute this file and the forward backfill (0027) more
-- than once, including against a newly created alias table.

CREATE TABLE IF NOT EXISTS "model_slug_alias" (
	-- The name a CLIENT may send: an old prefixed slug, or a mixed-case variant.
	"alias" text PRIMARY KEY NOT NULL,
	-- The surviving row the alias resolves to.
	"canonical_model_id" text NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	-- CASCADE, not RESTRICT: an alias whose target is gone is a dangling name
	-- that would fail resolution with a raw FK error. The alias dies with the
	-- row it names, and the resolution query's `m3b.status = 'active'` guard
	-- keeps an alias to a merely-inactive row from routing.
	CONSTRAINT "model_slug_alias_canonical_model_id_model_id_fk"
		FOREIGN KEY ("canonical_model_id") REFERENCES "public"."model"("id") ON DELETE CASCADE
);

-- The hot-path lookup is by `alias` (the PRIMARY KEY, already indexed). This
-- index serves the other direction: grouping every name of one identity, which
-- is how the depth metric is computed, and it is the index Postgres needs to
-- check the FK when a `model` row is deleted.
CREATE INDEX IF NOT EXISTS "model_slug_alias_canonical_idx"
	ON "model_slug_alias" USING btree ("canonical_model_id");

-- ---------------------------------------------------------------------------
-- Backfill: the families that are unambiguously one upstream model.
-- ---------------------------------------------------------------------------
--
-- Strip only a namespace belonging to the row's actual provider and only if
-- the entire remaining plain slug already exists. A generic greedy slash strip
-- would unite unrelated vendor/model identities when their leaves collide.
-- Case variants are exact spelling equivalence; :free, dates and versions are
-- deliberately not removed. Keep this snapshot aligned with the forward
-- backfill in 0027 for databases that already recorded this migration.
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
-- A known binding is not re-written when a migration is replayed.
ON CONFLICT ("alias") DO NOTHING;
