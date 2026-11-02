-- 0026_model_slug_alias.sql — one upstream model = one canonical row.
--
-- The defect it records: `model` has a NOT NULL UNIQUE `slug`, and the bulk
-- onboarders (ops/onboard-*.mjs, ops/catalog-discover.mjs) mint a row per
-- (provider, upstream model id) — with the provider namespace PREFIXED onto the
-- slug and with the upstream's own CASING. So one upstream model exists as
-- several canonical rows. MEASURED on the deployed catalogue (2026-11-02, 570
-- rows): `kimi-k2.6`, `Kimi-K2.6` and `tokenharbor/kimi-k2.6` are three rows,
-- and the same upstream model accounts for nine in total across cbcn, cp, ocg,
-- cmc/moonshotai and moonshotai; `deepseek-v4.1-flash` accounts for eleven. 118
-- of the 570 rows belong to a family of two or more.
--
-- Why that is a ROUTING defect, not a cosmetic one: the candidate fan-out is
-- `model.id -> provider_model -> provider`, so each duplicate row owns only ITS
-- OWN providers. An upstream model reachable through four providers is four
-- depth-1 rows instead of one depth-4 model, and the attempt walker has nothing
-- left to fail over to when the first is down. Of the 159 models the router can
-- route at all, 152 sit at depth 1 for exactly this reason.
--
-- Nothing is renamed and the rows are NOT merged. Both would break clients: the
-- prefixed and mixed-case strings are in the wild, and `model.slug` is unique so
-- a merge has to delete rows that `request_log.model_id` and `provider_model`
-- still reference. This migration records the IDENTITY only. ResolveModel
-- consults it after its literal-slug arm MISSES, so a client-visible slug keeps
-- resolving to exactly the row it resolves to today, and an old name gains a
-- route instead of losing one.
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
-- Idempotent on purpose, like every migration file here: it is re-runnable
-- (CREATE ... IF NOT EXISTS, and the backfill inserts ON CONFLICT DO NOTHING) so
-- a partially-applied database, or a rehearsal that follows the documented
-- pg_dump + migrate recipe, converges instead of aborting on the second run.
-- TestModelSlugAliasMigrationIsIdempotent pins that by executing this file
-- twice.

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
-- Two spellings collapse into one family key:
--
--   1. the provider namespace, stripped from the FRONT (`^.*/` is greedy, so
--      `cp/cline-pass/deepseek-v4.1-flash` loses BOTH namespaces and keeps its
--      leaf) — applied ONLY when the leaf is already a slug of its own, so a
--      provider-side id that merely contains a slash is left alone;
--   2. lowercased, so `Kimi-K2.6` joins `kimi-k2.6`.
--
-- The winner inside a family is chosen by a fixed, deterministic order:
-- an ACTIVE row beats an inactive one (the alias has to point at something the
-- router will actually serve), a plain slug beats a prefixed one (the identity
-- a customer would name), then lower-case, then slug ascending — the last key
-- exists only so two identical ranks cannot make the result depend on physical
-- row order.
--
-- The unsafe direction of this rule is a FALSE merge: two genuinely different
-- upstream models whose leaves collide (`vendorA/foo` and vendorB's plain `foo`)
-- would be grouped. The blast radius is bounded by construction — this table
-- only ever ADDS a resolution arm (the literal arm wins on a live slug), so a
-- false merge costs a wrong depth statistic and never a 404. In this catalogue
-- every prefix is one of the router's own provider namespaces and every leaf is
-- the upstream's real model id; an operator who finds a collision can delete the
-- single row (`delete from model_slug_alias where alias = '...'`) and the name
-- immediately resolves literally again.
WITH family AS (
	SELECT m.id,
	       m.slug,
	       m.status,
	       CASE
	         WHEN position('/' in m.slug) > 0
	          AND EXISTS (SELECT 1 FROM model t
	                      WHERE lower(t.slug) = lower(regexp_replace(m.slug, '^.*/', '')))
	         THEN lower(regexp_replace(m.slug, '^.*/', ''))
	         ELSE lower(m.slug)
	       END AS family_key
	FROM model m
), ranked AS (
	SELECT f.id,
	       f.slug,
	       f.family_key,
	       row_number() OVER (
	         PARTITION BY f.family_key
	         ORDER BY (f.status = 'active') DESC,
	                  (position('/' in f.slug) = 0) DESC,
	                  (f.slug = lower(f.slug)) DESC,
	                  f.slug
	       ) AS rn
	FROM family f
), canon AS (
	SELECT family_key, id AS canonical_model_id, slug AS canonical_slug
	FROM ranked
	WHERE rn = 1
)
INSERT INTO "model_slug_alias" ("alias", "canonical_model_id")
SELECT r.slug, c.canonical_model_id
FROM ranked r
JOIN canon c ON c.family_key = r.family_key
WHERE r.rn > 1
  -- A single-row family is its own identity and needs no alias; this is also
  -- the guard that keeps a re-run from inserting a self-referential row.
  AND r.slug <> c.canonical_slug
ON CONFLICT ("alias") DO NOTHING;
