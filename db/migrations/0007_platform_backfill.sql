-- 0007_platform_backfill.sql — DATA ONLY.
--
-- Source of truth: docs/specs/2026-09-30-platform-schema.md §1–7.
--
-- Migrates S0 rows onto the 0006 shape. Per spec §1 this file changes no column
-- type, drops nothing, and tightens no constraint — it only rewrites/creates
-- rows, so the S0 code still runs afterwards.
--
-- ID wrapping (spec §1): S0 ids are mixed-shape (live: `user.id` = Better Auth
-- nanoid, `api_key.id`/`model.id`/`request_log.id` = uuidv7, `provider.id` =
-- slug). The backfill WRAPS what exists — `usr_<legacy>`, `prv_mingles` — so
-- every historical reference survives. Idempotent: guarded on the `prefix_` form.
--
-- FK dance: `user.id`/`provider.id`/`model.id`/`api_key.id` are referenced from
-- several tables, and both parents-first and children-first wrapping violate an
-- immediate FK. So: drop the FK constraints, wrap every column in one pass,
-- re-create the constraints. Single transaction — the schema is never observed
-- half-wrapped.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Wrap legacy ids.
--    (Bookkeeping is the runner's job — ops/migrate.sh records this file in
--    schema_migration after it applies; a self-insert here would race it.)
-- ---------------------------------------------------------------------------
ALTER TABLE "profile" DROP CONSTRAINT IF EXISTS "profile_user_id_user_id_fk";
ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_user_id_user_id_fk";
ALTER TABLE "account" DROP CONSTRAINT IF EXISTS "account_user_id_user_id_fk";
ALTER TABLE "api_key" DROP CONSTRAINT IF EXISTS "api_key_user_id_user_id_fk";
ALTER TABLE "model" DROP CONSTRAINT IF EXISTS "model_provider_id_provider_id_fk";
ALTER TABLE "request_log" DROP CONSTRAINT IF EXISTS "request_log_user_id_user_id_fk";
ALTER TABLE "request_log" DROP CONSTRAINT IF EXISTS "request_log_api_key_id_api_key_id_fk";
ALTER TABLE "request_log" DROP CONSTRAINT IF EXISTS "request_log_model_id_model_id_fk";
ALTER TABLE "request_log" DROP CONSTRAINT IF EXISTS "request_log_provider_id_provider_id_fk";

UPDATE "user" SET "id" = 'usr_' || "id" WHERE "id" NOT LIKE 'usr\_%';
UPDATE "profile" SET "user_id" = 'usr_' || "user_id" WHERE "user_id" NOT LIKE 'usr\_%';
UPDATE "session" SET "id" = 'ses_' || "id" WHERE "id" NOT LIKE 'ses\_%';
UPDATE "session" SET "user_id" = 'usr_' || "user_id" WHERE "user_id" NOT LIKE 'usr\_%';
UPDATE "account" SET "id" = 'acc_' || "id" WHERE "id" NOT LIKE 'acc\_%';
UPDATE "account" SET "user_id" = 'usr_' || "user_id" WHERE "user_id" NOT LIKE 'usr\_%';
UPDATE "verification" SET "id" = 'ver_' || "id" WHERE "id" NOT LIKE 'ver\_%';

UPDATE "provider" SET "id" = 'prv_' || "id" WHERE "id" NOT LIKE 'prv\_%';
UPDATE "model" SET "provider_id" = 'prv_' || "provider_id" WHERE "provider_id" NOT LIKE 'prv\_%';
UPDATE "model" SET "id" = 'mdl_' || "id" WHERE "id" NOT LIKE 'mdl\_%';

UPDATE "api_key" SET "user_id" = 'usr_' || "user_id" WHERE "user_id" NOT LIKE 'usr\_%';
UPDATE "api_key" SET "id" = 'key_' || "id" WHERE "id" NOT LIKE 'key\_%';

UPDATE "request_log" SET "user_id" = 'usr_' || "user_id"
	WHERE "user_id" IS NOT NULL AND "user_id" NOT LIKE 'usr\_%';
UPDATE "request_log" SET "api_key_id" = 'key_' || "api_key_id"
	WHERE "api_key_id" IS NOT NULL AND "api_key_id" NOT LIKE 'key\_%';
UPDATE "request_log" SET "model_id" = 'mdl_' || "model_id" WHERE "model_id" NOT LIKE 'mdl\_%';
UPDATE "request_log" SET "provider_id" = 'prv_' || "provider_id" WHERE "provider_id" NOT LIKE 'prv\_%';
UPDATE "request_log" SET "id" = 'req_' || "id" WHERE "id" NOT LIKE 'req\_%';

-- Re-create exactly the constraints dropped above (same names, same actions).
ALTER TABLE "profile" ADD CONSTRAINT "profile_user_id_user_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade;
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade;
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade;
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_user_id_user_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade;
ALTER TABLE "model" ADD CONSTRAINT "model_provider_id_provider_id_fk"
	FOREIGN KEY ("provider_id") REFERENCES "public"."provider"("id") ON DELETE cascade;
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_user_id_user_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null;
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_api_key_id_api_key_id_fk"
	FOREIGN KEY ("api_key_id") REFERENCES "public"."api_key"("id") ON DELETE set null;
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_model_id_model_id_fk"
	FOREIGN KEY ("model_id") REFERENCES "public"."model"("id");
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_provider_id_provider_id_fk"
	FOREIGN KEY ("provider_id") REFERENCES "public"."provider"("id");

-- ---------------------------------------------------------------------------
-- 2. Workspace hierarchy (spec §2 backfill).
--    Every user gets a personal workspace + default project + 3 environments +
--    owner membership + a billing account with zero opening balance.
--    Ids for backfill-created rows are deterministic from the user id, so the
--    script is idempotent without a registry of what it created.
-- ---------------------------------------------------------------------------
INSERT INTO "workspace" ("id", "name", "slug", "owner_user_id", "status", "settings")
SELECT
	'wrk_' || u."id",
	coalesce(nullif(trim(u."name"), ''), split_part(u."email", '@', 1)) || ' Workspace',
	-- slug: lowercase alphanumerics/dashes, then the tail of the user id for
	-- uniqueness (two "alex" users must not collide).
	left(regexp_replace(lower(coalesce(nullif(trim(u."name"), ''), split_part(u."email", '@', 1))), '[^a-z0-9]+', '-', 'g'), 40)
		|| '-' || right(u."id", 8),
	u."id",
	'active',
	'{}'::jsonb
FROM "user" u
WHERE NOT EXISTS (SELECT 1 FROM "workspace" w WHERE w."id" = 'wrk_' || u."id");

-- Builtin role templates (spec §2 permission matrix). Deterministic ids.
INSERT INTO "workspace_role" ("id", "workspace_id", "name", "permissions") VALUES
	('rol_owner',    NULL, 'owner',    '["workspace.read","workspace.write","workspace.delete","member.read","member.invite","member.remove","project.read","project.write","project.delete","key.read","key.create","key.rotate","key.revoke","routing.read","routing.write","alias.read","alias.write","request.read","analytics.read","usage.read","budget.read","budget.write","limit.read","limit.write","alert.read","alert.write","webhook.read","webhook.write","billing.read","billing.write"]'::jsonb),
	('rol_admin',    NULL, 'admin',    '["workspace.read","workspace.write","member.read","member.invite","member.remove","project.read","project.write","project.delete","key.read","key.create","key.rotate","key.revoke","routing.read","routing.write","alias.read","alias.write","request.read","analytics.read","usage.read","budget.read","budget.write","limit.read","limit.write","alert.read","alert.write","webhook.read","webhook.write","billing.read","billing.write"]'::jsonb),
	('rol_developer',NULL, 'developer','["workspace.read","member.read","project.read","project.write","key.read","key.create","key.rotate","key.revoke","routing.read","routing.write","alias.read","alias.write","request.read","analytics.read","usage.read","budget.read","limit.read","alert.read","alert.write","webhook.read","webhook.write"]'::jsonb),
	('rol_billing',  NULL, 'billing',  '["workspace.read","member.read","project.read","usage.read","analytics.read","billing.read","billing.write"]'::jsonb),
	('rol_viewer',   NULL, 'viewer',   '["workspace.read","member.read","project.read","key.read","routing.read","alias.read","request.read","analytics.read","usage.read","budget.read","limit.read","alert.read","webhook.read","billing.read"]'::jsonb)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "workspace_member" ("id", "workspace_id", "user_id", "role_id", "status")
SELECT
	'mem_' || w."id" || '-' || w."user_id",
	w."id",
	w."user_id",
	'rol_owner',
	'active'
FROM (
	SELECT w."id", w."owner_user_id" AS "user_id"
	FROM "workspace" w
	WHERE w."owner_user_id" IS NOT NULL
) w
WHERE NOT EXISTS (
	SELECT 1 FROM "workspace_member" m
	WHERE m."workspace_id" = w."id" AND m."user_id" = w."user_id"
);

INSERT INTO "project" ("id", "workspace_id", "name", "slug", "description", "status")
SELECT
	'prj_' || u."id",
	w."id",
	'Default',
	'default',
	'Created automatically during the workspace migration.',
	'active'
FROM "user" u
JOIN "workspace" w ON w."owner_user_id" = u."id"
WHERE NOT EXISTS (
	SELECT 1 FROM "project" p WHERE p."id" = 'prj_' || u."id"
);

INSERT INTO "environment" ("id", "project_id", "name", "slug", "type", "status")
SELECT
	'env_' || p."id" || '-' || e."slug",
	p."id",
	e."name",
	e."slug",
	e."type",
	'active'
FROM "project" p
CROSS JOIN (VALUES
	('development', 'Development', 'development'),
	('staging',     'Staging',     'staging'),
	('production',  'Production',  'production')
) AS e ("slug", "name", "type")
WHERE NOT EXISTS (
	SELECT 1 FROM "environment" x WHERE x."id" = 'env_' || p."id" || '-' || e."slug"
);

-- Billing account per workspace, zero opening balance (PRD §48: the ledger is
-- the balance; there is nothing to backfill from S0 — S0 had no billing).
INSERT INTO "billing_account" ("id", "workspace_id", "currency", "status")
SELECT 'bac_' || w."id", w."id", 'USD', 'active'
FROM "workspace" w
WHERE NOT EXISTS (SELECT 1 FROM "billing_account" b WHERE b."workspace_id" = w."id");

-- ---------------------------------------------------------------------------
-- 3. API keys: ownership + status + policy (spec §3).
--    S0 key -> the user's default project's production environment.
-- ---------------------------------------------------------------------------
UPDATE "api_key" k SET
	"workspace_id" = p."workspace_id",
	"project_id"   = p."id",
	"environment_id" = e."id"
FROM "project" p
JOIN "environment" e ON e."project_id" = p."id" AND e."slug" = 'production'
WHERE p."id" = 'prj_' || k."user_id"
  AND k."workspace_id" IS NULL;

UPDATE "api_key" SET "status" = 'revoked' WHERE "revoked_at" IS NOT NULL AND "status" = 'active';

-- S0 limits blob {rpm, monthly_cost_micro} -> policy shape (spec §3). The legacy
-- `limits` column is left untouched until 0009.
UPDATE "api_key" SET "policy" = (
	SELECT COALESCE(jsonb_strip_nulls(jsonb_build_object(
		'rpm',
		CASE WHEN "limits"->>'rpm' ~ '^[0-9]+$' THEN ("limits"->>'rpm')::bigint END,
		'monthly_spend_micro',
		CASE WHEN "limits"->>'monthly_cost_micro' ~ '^[0-9]+$'
			THEN ("limits"->>'monthly_cost_micro')::bigint END
	)), '{}'::jsonb)
)
WHERE "policy" = '{}'::jsonb AND "limits" <> '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- 4. Provider network (spec §4): one connection per S0 provider.
--    Credential ROWS need the encrypted blob split, which SQL cannot do —
--    ops/backfill-credentials.mjs runs right after this file
--    (ops/migrate.sh enforces the order; 0009 refuses to drop
--    provider.credentials_enc while any non-empty blob remains).
-- ---------------------------------------------------------------------------
UPDATE "provider" SET
	"slug" = regexp_replace(lower("id"), '[^a-z0-9]+', '-', 'g'),
	"type" = 'openai_compatible',
	"tier" = CASE WHEN "status" = 'dev' THEN 'dev' ELSE 'commercial' END,
	"enabled" = "status" <> 'disabled'
WHERE "slug" IS NULL;

-- Slug uniqueness: slugs were derived from the (unique) id; keep it that way.
-- If regexp folding ever collides, the unique index will fail loudly rather
-- than merge two providers.

INSERT INTO "connection" ("id", "provider_id", "name", "slug", "base_url", "auth_type", "config")
SELECT
	'con_' || p."id" || '-default',
	p."id",
	p."name",
	'default',
	p."base_url",
	'bearer',
	'{}'::jsonb
FROM "provider" p
WHERE NOT EXISTS (
	SELECT 1 FROM "connection" c WHERE c."id" = 'con_' || p."id" || '-default'
);

-- ---------------------------------------------------------------------------
-- 5. Catalog (spec §5): each S0 model row is provider-scoped. The row becomes
--    the canonical model; its upstream name becomes a provider_model mapping.
--    The customer-facing `slug` does not move.
-- ---------------------------------------------------------------------------
INSERT INTO "provider_model" (
	"id", "model_id", "provider_id", "connection_id", "provider_model_id",
	"enabled", "capabilities_override", "status"
)
SELECT
	'pmdl_' || m."id",
	m."id",
	m."provider_id",
	'con_' || m."provider_id" || '-default',
	m."slug",               -- S0 forwarded the slug as the upstream model name
	m."status" = 'active',
	'{}'::jsonb,
	CASE WHEN m."status" = 'active' THEN 'available' ELSE 'disabled' END
FROM "model" m
WHERE NOT EXISTS (SELECT 1 FROM "provider_model" pm WHERE pm."id" = 'pmdl_' || m."id");

-- ---------------------------------------------------------------------------
-- 6. Pricing (spec §6): version 1 of each model's price from the S0 columns.
--    The request cost snapshot backfills from it so history is self-describing.
-- ---------------------------------------------------------------------------
INSERT INTO "pricing_rule" (
	"id", "model_id", "provider_model_id", "version", "currency",
	"input_price", "cached_input_price", "output_price", "reasoning_price",
	"effective_from", "effective_until"
)
SELECT
	'prc_' || m."id" || '-v1',
	m."id",
	NULL,
	1,
	m."currency",
	m."input_price",
	NULL,
	m."output_price",
	NULL,
	m."created_at",
	NULL
FROM "model" m
WHERE NOT EXISTS (SELECT 1 FROM "pricing_rule" pr WHERE pr."id" = 'prc_' || m."id" || '-v1');

UPDATE "request_log" r SET
	"pricing_rule_id" = pr."id",
	"input_price_micro" = pr."input_price",
	"output_price_micro" = pr."output_price",
	"cached_input_price_micro" = pr."cached_input_price",
	"reasoning_price_micro" = pr."reasoning_price"
FROM "pricing_rule" pr
WHERE pr."model_id" = r."model_id" AND pr."version" = 1
  AND r."pricing_rule_id" IS NULL;

-- S0 billed one price (model list price) and knew no provider-side cost: the
-- customer charge IS the recorded cost, and the provider cost is the same
-- number until per-provider pricing exists (PRD §61 — a snapshot, not a lie).
UPDATE "request_log" SET
	"provider_cost_micro" = "cost",
	"credit_charged_micro" = "cost",
	"total_tokens" = COALESCE("tokens_in", 0) + COALESCE("tokens_out", 0)
WHERE "provider_cost_micro" IS NULL;

-- Ownership backfill (PRD §28 columns). `endpoint` stays NULL on purpose: S0
-- recorded chat and generic passthrough identically, so the historical endpoint
-- is genuinely unknown — NULL is the honest value and the dashboards group it as
-- "unknown" rather than inventing a history.
UPDATE "request_log" r SET
	"workspace_id" = p."workspace_id",
	"project_id" = p."id",
	"environment_id" = e."id",
	"requested_model" = (SELECT m."slug" FROM "model" m WHERE m."id" = r."model_id")
FROM "api_key" k
JOIN "project" p ON p."id" = k."project_id"
JOIN "environment" e ON e."id" = k."environment_id"
WHERE k."id" = r."api_key_id"
  AND r."workspace_id" IS NULL;

-- ---------------------------------------------------------------------------
-- 7. Seeds (spec §7, §9, §11).
-- ---------------------------------------------------------------------------

-- Platform default routing policy (PRD §139 defaults).
INSERT INTO "routing_policy" (
	"id", "workspace_id", "project_id", "environment_id", "name", "strategy",
	"enabled", "max_attempts", "request_timeout_ms", "fallback_enabled", "weights"
) VALUES (
	'rte_default', NULL, NULL, NULL, 'Platform Default', 'balanced',
	true, 2, 30000, true,
	'{"price": 0.25, "latency": 0.25, "reliability": 0.25, "capacity": 0.25}'::jsonb
) ON CONFLICT ("id") DO NOTHING;

-- Global virtual models (PRD §36). Target sets are strategy-resolved, not
-- pinned — see spec §5.
INSERT INTO "model_alias" ("id", "workspace_id", "project_id", "name", "description")
VALUES
	('als_fudrouter-auto',      NULL, NULL, 'fudrouter/auto',      'Route to the best model for the request; FUDRouter balances cost, latency and reliability.'),
	('als_fudrouter-fast',      NULL, NULL, 'fudrouter/fast',      'Prefer the lowest-latency healthy model.'),
	('als_fudrouter-cheap',     NULL, NULL, 'fudrouter/cheap',     'Preserve answer quality at the lowest cost.'),
	('als_fudrouter-balanced',  NULL, NULL, 'fudrouter/balanced',  'The default balanced score across price, latency, reliability and capacity.'),
	('als_fudrouter-reliable',  NULL, NULL, 'fudrouter/reliable',  'Prefer the route with the highest observed success rate.'),
	('als_fudrouter-reasoning', NULL, NULL, 'fudrouter/reasoning', 'Prefer reasoning-capable models.'),
	('als_fudrouter-coding',    NULL, NULL, 'fudrouter/coding',    'Prefer models with strong coding ability.')
ON CONFLICT ("id") DO NOTHING;

-- Platform settings (PRD §105, §138). Retention default: metadata yes,
-- content NO (PRD §94 — raw prompts are opt-in).
INSERT INTO "system_setting" ("key", "value") VALUES
	('default_routing_policy', '{"id": "rte_default"}'::jsonb),
	('platform_hard_limits', '{"rpm": 10000, "tpm": 100000000, "concurrency": 1000}'::jsonb),
	('retention', '{"request_metadata_days": 90, "request_content_days": 0, "system_events_days": 90, "audit_logs_days": 365}'::jsonb),
	('registration', '{"enabled": true}'::jsonb),
	('maintenance', '{"enabled": false}'::jsonb)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "feature_flag" ("id", "name", "description", "enabled") VALUES
	('flg_smart-routing', 'smart_routing', 'PRD §140 P2: learned routing signals on top of the static strategies.', false),
	('flg_alerts', 'alerts', 'Alert rules and alert events (PRD §42).', true),
	('flg_webhooks', 'webhooks', 'Outbound webhook deliveries (PRD §43).', true)
ON CONFLICT ("id") DO NOTHING;

-- Not seeded on purpose (spec §7, §11): rate_limit and budget rows (limits
-- inherit from system_setting until someone sets one), alerts, webhooks, jobs,
-- system_event, audit_log, incidents, security_rule, circuit_breaker rows —
-- all lifecycle-created.

COMMIT;
