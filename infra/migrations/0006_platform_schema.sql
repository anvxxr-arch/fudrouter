-- 0006_platform_schema.sql — ADDITIVE ONLY.
--
-- Source of truth: docs/specs/2026-09-30-platform-schema.md (PRD §6–7, §22, §44–48,
-- §52–63, §70–81, §88, §96, §104, §128). Every column here is spelled in that
-- document; if the two disagree, the spec wins and this file is the bug.
--
-- Sequencing contract (spec §1 "Migration sequencing"): this file only ADDS
-- tables/columns, so the S0 code keeps running against it unmodified. Data
-- backfill lives in 0007; status-vocabulary changes and NOT NULL tightening land
-- in 0008 with their writers; legacy column drops land in 0009 with the last
-- caller's removal. Nothing here rewrites an existing row.
--
-- Conventions (spec §0): singular table names; ids are text `prefix_<id>` minted
-- app-side (PRD §81); money is bigint integer micro-units ($1 = 1e6); unit prices
-- are numeric(18,6) micro-units per 1M tokens; timestamps are timestamptz UTC.

BEGIN;

-- `schema_migration` bookkeeping is created by scripts/migrate.sh before any
-- file runs, so 0006 does not create it.

-- ---------------------------------------------------------------- accounts ----
-- PRD §6: User -> Workspace -> Project -> Environment -> API Key.

CREATE TABLE "workspace" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"owner_user_id" text,
	"status" text NOT NULL DEFAULT 'active',
	"settings" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "workspace_status_check" CHECK ("status" IN ('active', 'archived', 'suspended'))
);
CREATE UNIQUE INDEX "workspace_slug_idx" ON "workspace" USING btree ("slug");
CREATE INDEX "workspace_owner_idx" ON "workspace" USING btree ("owner_user_id");
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_owner_user_id_user_id_fk"
	FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE set null;

-- Roles are ROWS (spec §2): builtin templates carry workspace_id NULL; a custom
-- role is a workspace-scoped row. `permissions` is a jsonb array of PRD §46
-- permission codes — the complete code list is pinned in lib/server/rbac.ts.
CREATE TABLE "workspace_role" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"name" text NOT NULL,
	"permissions" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
-- COALESCE because NULL workspace_id is the builtin tier and NULLs are distinct
-- in a plain unique index — without it two `owner` templates could coexist.
CREATE UNIQUE INDEX "workspace_role_ws_name_idx"
	ON "workspace_role" USING btree (COALESCE("workspace_id", ''), "name");
ALTER TABLE "workspace_role" ADD CONSTRAINT "workspace_role_workspace_id_workspace_id_fk"
	FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade;

CREATE TABLE "workspace_member" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role_id" text NOT NULL,
	"status" text NOT NULL DEFAULT 'active',
	"invited_by" text,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "workspace_member_status_check" CHECK ("status" IN ('active', 'invited', 'suspended'))
);
CREATE UNIQUE INDEX "workspace_member_ws_user_idx" ON "workspace_member" USING btree ("workspace_id", "user_id");
CREATE INDEX "workspace_member_user_idx" ON "workspace_member" USING btree ("user_id");
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_workspace_id_workspace_id_fk"
	FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade;
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_user_id_user_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade;
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_role_id_workspace_role_id_fk"
	FOREIGN KEY ("role_id") REFERENCES "public"."workspace_role"("id") ON DELETE restrict;

CREATE TABLE "project" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"status" text NOT NULL DEFAULT 'active',
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "project_status_check" CHECK ("status" IN ('active', 'archived', 'suspended'))
);
CREATE UNIQUE INDEX "project_ws_slug_idx" ON "project" USING btree ("workspace_id", "slug");
ALTER TABLE "project" ADD CONSTRAINT "project_workspace_id_workspace_id_fk"
	FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade;

-- Routing policy is created before `environment` only because
-- environment.routing_policy_id references it (spec §9).
CREATE TABLE "routing_policy" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"project_id" text,
	"environment_id" text,
	"name" text NOT NULL,
	"strategy" text NOT NULL DEFAULT 'balanced',
	"enabled" boolean NOT NULL DEFAULT true,
	"max_attempts" integer NOT NULL DEFAULT 2,
	"request_timeout_ms" integer NOT NULL DEFAULT 30000,
	"fallback_enabled" boolean NOT NULL DEFAULT true,
	"provider_preferences" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"model_preferences" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"constraints" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"weights" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "routing_policy_strategy_check" CHECK ("strategy" IN (
		'balanced', 'lowest_cost', 'lowest_latency', 'highest_reliability',
		'provider_priority', 'weighted', 'round_robin', 'random', 'smart'
	))
);
CREATE INDEX "routing_policy_ws_idx" ON "routing_policy" USING btree ("workspace_id");
CREATE INDEX "routing_policy_project_idx" ON "routing_policy" USING btree ("project_id");
CREATE INDEX "routing_policy_env_idx" ON "routing_policy" USING btree ("environment_id");

CREATE TABLE "environment" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL DEFAULT 'active',
	"routing_policy_id" text,
	"monthly_budget_micro" bigint,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "environment_type_check" CHECK ("type" IN ('development', 'staging', 'production', 'custom')),
	CONSTRAINT "environment_status_check" CHECK ("status" IN ('active', 'disabled'))
);
CREATE UNIQUE INDEX "environment_project_slug_idx" ON "environment" USING btree ("project_id", "slug");
ALTER TABLE "environment" ADD CONSTRAINT "environment_project_id_project_id_fk"
	FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade;
ALTER TABLE "environment" ADD CONSTRAINT "environment_routing_policy_id_routing_policy_id_fk"
	FOREIGN KEY ("routing_policy_id") REFERENCES "public"."routing_policy"("id") ON DELETE set null;

-- ------------------------------------------------------------- provider net ----
-- PRD §52–56: Provider -> Connection -> Credential. `provider.base_url` and
-- `provider.credentials_enc` stay until 0009 (spec §1 sequencing) and are
-- superseded by connection/credential rows.

ALTER TABLE "provider" ADD COLUMN "slug" text;
ALTER TABLE "provider" ADD COLUMN "description" text;
ALTER TABLE "provider" ADD COLUMN "type" text;
-- PRD §52 vocabulary lives in 0008 (with its writers). `tier` carries S0's
-- commercial gate forward — S0 gated on provider.status='dev', a value the PRD
-- vocabulary does not have (spec §4).
ALTER TABLE "provider" ADD COLUMN "tier" text NOT NULL DEFAULT 'commercial';
ALTER TABLE "provider" ADD COLUMN "homepage" text;
ALTER TABLE "provider" ADD COLUMN "documentation_url" text;
ALTER TABLE "provider" ADD COLUMN "enabled" boolean NOT NULL DEFAULT true;
ALTER TABLE "provider" ADD COLUMN "updated_at" timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX "provider_slug_idx" ON "provider" USING btree ("slug");
ALTER TABLE "provider" ADD CONSTRAINT "provider_tier_check" CHECK ("tier" IN ('commercial', 'dev'));

CREATE TABLE "connection" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"base_url" text NOT NULL,
	"region" text,
	"auth_type" text NOT NULL DEFAULT 'bearer',
	"timeout_ms" integer NOT NULL DEFAULT 120000,
	"priority" integer NOT NULL DEFAULT 100,
	"enabled" boolean NOT NULL DEFAULT true,
	"health_status" text NOT NULL DEFAULT 'unknown',
	"config" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "connection_auth_type_check" CHECK ("auth_type" IN ('bearer', 'oauth', 'header', 'query')),
	CONSTRAINT "connection_health_status_check" CHECK ("health_status" IN ('healthy', 'degraded', 'unhealthy', 'unknown'))
);
CREATE UNIQUE INDEX "connection_provider_slug_idx" ON "connection" USING btree ("provider_id", "slug");
ALTER TABLE "connection" ADD CONSTRAINT "connection_provider_id_provider_id_fk"
	FOREIGN KEY ("provider_id") REFERENCES "public"."provider"("id") ON DELETE cascade;

-- One account = one credential row (spec §4). `secret_enc` uses the S0 envelope:
-- base64(iv[12] || ct || tag[16]), AES-256-GCM, CREDENTIALS_MASTER_KEY. The
-- plaintext is one account JSON; raw secrets never leave the backend (PRD §92,
-- §136).
CREATE TABLE "credential" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"name" text NOT NULL,
	"secret_enc" text NOT NULL,
	"status" text NOT NULL DEFAULT 'unknown',
	"priority" integer NOT NULL DEFAULT 100,
	"weight" integer NOT NULL DEFAULT 100,
	"last_used_at" timestamptz,
	"last_success_at" timestamptz,
	"last_error_at" timestamptz,
	"cooldown_until" timestamptz,
	"metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "credential_status_check" CHECK ("status" IN (
		'healthy', 'rate_limited', 'cooldown', 'auth_failed', 'invalid', 'disabled', 'unknown'
	))
);
CREATE INDEX "credential_connection_idx" ON "credential" USING btree ("connection_id");
CREATE INDEX "credential_status_idx" ON "credential" USING btree ("status");
ALTER TABLE "credential" ADD CONSTRAINT "credential_connection_id_connection_id_fk"
	FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade;

-- ---------------------------------------------------------------- catalog -----
-- PRD §57–59: canonical models, provider mappings, aliases (§35–36).

ALTER TABLE "model" ADD COLUMN "family" text;
ALTER TABLE "model" ADD COLUMN "developer" text;
ALTER TABLE "model" ADD COLUMN "description" text;
ALTER TABLE "model" ADD COLUMN "modality" jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "model" ADD COLUMN "max_output" integer;
ALTER TABLE "model" ADD COLUMN "capabilities" jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "model" ADD COLUMN "updated_at" timestamptz NOT NULL DEFAULT now();
-- `context` (S0) is the context window; the PRD's `context_window` name is not
-- worth a rename migration (spec §5).

CREATE TABLE "provider_model" (
	"id" text PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"connection_id" text,
	"provider_model_id" text NOT NULL,
	"enabled" boolean NOT NULL DEFAULT true,
	"capabilities_override" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"context_override" integer,
	"status" text NOT NULL DEFAULT 'available',
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "provider_model_status_check" CHECK ("status" IN (
		'available', 'degraded', 'unavailable', 'deprecated', 'disabled'
	))
);
CREATE UNIQUE INDEX "provider_model_target_idx" ON "provider_model"
	USING btree ("model_id", "provider_id", COALESCE("connection_id", ''));
CREATE INDEX "provider_model_provider_idx" ON "provider_model" USING btree ("provider_id");
ALTER TABLE "provider_model" ADD CONSTRAINT "provider_model_model_id_model_id_fk"
	FOREIGN KEY ("model_id") REFERENCES "public"."model"("id") ON DELETE cascade;
ALTER TABLE "provider_model" ADD CONSTRAINT "provider_model_provider_id_provider_id_fk"
	FOREIGN KEY ("provider_id") REFERENCES "public"."provider"("id") ON DELETE cascade;
ALTER TABLE "provider_model" ADD CONSTRAINT "provider_model_connection_id_connection_id_fk"
	FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE set null;

CREATE TABLE "model_alias" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"project_id" text,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean NOT NULL DEFAULT true,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now()
);
-- workspace_id NULL = the global `fudrouter/*` virtual models (PRD §36).
CREATE UNIQUE INDEX "model_alias_scope_name_idx" ON "model_alias"
	USING btree (COALESCE("workspace_id", ''), COALESCE("project_id", ''), "name");
ALTER TABLE "model_alias" ADD CONSTRAINT "model_alias_workspace_id_workspace_id_fk"
	FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade;
ALTER TABLE "model_alias" ADD CONSTRAINT "model_alias_project_id_project_id_fk"
	FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade;

CREATE TABLE "model_alias_target" (
	"alias_id" text NOT NULL,
	"model_id" text NOT NULL,
	"position" integer NOT NULL,
	PRIMARY KEY ("alias_id", "position")
);
ALTER TABLE "model_alias_target" ADD CONSTRAINT "model_alias_target_alias_id_model_alias_id_fk"
	FOREIGN KEY ("alias_id") REFERENCES "public"."model_alias"("id") ON DELETE cascade;
ALTER TABLE "model_alias_target" ADD CONSTRAINT "model_alias_target_model_id_model_id_fk"
	FOREIGN KEY ("model_id") REFERENCES "public"."model"("id") ON DELETE cascade;

-- ---------------------------------------------------------------- pricing -----
-- PRD §60–61: versioned, immutable history. A new price is a NEW ROW; the old
-- one gets effective_until. Prices are micro-units of currency per 1M tokens.
CREATE TABLE "pricing_rule" (
	"id" text PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"provider_model_id" text,
	"version" integer NOT NULL DEFAULT 1,
	"currency" char(3) NOT NULL DEFAULT 'USD',
	"input_price" numeric(18, 6) NOT NULL,
	"cached_input_price" numeric(18, 6),
	"output_price" numeric(18, 6) NOT NULL,
	"reasoning_price" numeric(18, 6),
	"effective_from" timestamptz NOT NULL,
	"effective_until" timestamptz,
	"created_by" text,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "pricing_rule_version_idx" ON "pricing_rule"
	USING btree ("model_id", COALESCE("provider_model_id", ''), "version");
CREATE INDEX "pricing_rule_model_effective_idx" ON "pricing_rule" USING btree ("model_id", "effective_from");
ALTER TABLE "pricing_rule" ADD CONSTRAINT "pricing_rule_model_id_model_id_fk"
	FOREIGN KEY ("model_id") REFERENCES "public"."model"("id") ON DELETE cascade;

-- ---------------------------------------------------- keys / limits / budget ---
-- PRD §25–26. The S0 `limits` jsonb column stays until 0009; `policy` is the
-- per-key policy (endpoints, models, aliases, IP allowlist, RPM/TPM/concurrency,
-- spend caps) — see spec §3 for the key list.

ALTER TABLE "api_key" ADD COLUMN "workspace_id" text;
ALTER TABLE "api_key" ADD COLUMN "project_id" text;
ALTER TABLE "api_key" ADD COLUMN "environment_id" text;
ALTER TABLE "api_key" ADD COLUMN "status" text NOT NULL DEFAULT 'active';
ALTER TABLE "api_key" ADD COLUMN "policy" jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "api_key" ADD COLUMN "expires_at" timestamptz;
ALTER TABLE "api_key" ADD COLUMN "updated_at" timestamptz NOT NULL DEFAULT now();
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_status_check" CHECK ("status" IN ('active', 'disabled', 'revoked'));
CREATE INDEX "api_key_project_idx" ON "api_key" USING btree ("project_id");
CREATE INDEX "api_key_environment_idx" ON "api_key" USING btree ("environment_id");
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_workspace_id_workspace_id_fk"
	FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade;
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_project_id_project_id_fk"
	FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade;
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_environment_id_environment_id_fk"
	FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade;

-- PRD §41: limits per scope. Effective limit = min across the chain
-- platform -> workspace -> project -> environment -> api_key (spec §7).
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text NOT NULL,
	"rpm" integer,
	"tpm" bigint,
	"rpd" integer,
	"tpd" bigint,
	"concurrency" integer,
	"daily_spend_micro" bigint,
	"monthly_spend_micro" bigint,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "rate_limit_scope_check" CHECK ("scope" IN ('workspace', 'project', 'environment', 'api_key'))
);
CREATE UNIQUE INDEX "rate_limit_scope_idx" ON "rate_limit" USING btree ("scope", "scope_id");

-- PRD §40: thresholds at warn/critical/100%. Valkey counts, PostgreSQL aggregates.
CREATE TABLE "budget" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text NOT NULL,
	"period" text NOT NULL,
	"amount_micro" bigint NOT NULL,
	"warn_percent" integer NOT NULL DEFAULT 70,
	"critical_percent" integer NOT NULL DEFAULT 90,
	"action_at_100" text NOT NULL DEFAULT 'block',
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "budget_scope_check" CHECK ("scope" IN ('workspace', 'project', 'environment')),
	CONSTRAINT "budget_period_check" CHECK ("period" IN ('daily', 'weekly', 'monthly')),
	CONSTRAINT "budget_action_check" CHECK ("action_at_100" IN ('notify', 'restrict', 'block'))
);
CREATE UNIQUE INDEX "budget_scope_idx" ON "budget" USING btree ("scope", "scope_id", "period");

-- --------------------------------------------------------------- requests -----
-- PRD §28–29, §61, §86–88: request_log keeps its S0 name and column names
-- (tokens_in/tokens_out/cost) per spec §8; `cost` is the CUSTOMER CHARGE.

ALTER TABLE "request_log" ALTER COLUMN "tokens_in" SET DATA TYPE bigint;
ALTER TABLE "request_log" ALTER COLUMN "tokens_out" SET DATA TYPE bigint;

ALTER TABLE "request_log" ADD COLUMN "workspace_id" text;
ALTER TABLE "request_log" ADD COLUMN "project_id" text;
ALTER TABLE "request_log" ADD COLUMN "environment_id" text;
ALTER TABLE "request_log" ADD COLUMN "endpoint" text;
ALTER TABLE "request_log" ADD COLUMN "requested_model" text;
ALTER TABLE "request_log" ADD COLUMN "provider_model_id" text;
ALTER TABLE "request_log" ADD COLUMN "connection_id" text;
ALTER TABLE "request_log" ADD COLUMN "credential_id" text;
ALTER TABLE "request_log" ADD COLUMN "routing_policy_id" text;
ALTER TABLE "request_log" ADD COLUMN "strategy" text;
ALTER TABLE "request_log" ADD COLUMN "error_code" text;
ALTER TABLE "request_log" ADD COLUMN "http_status" integer;
ALTER TABLE "request_log" ADD COLUMN "cached_input_tokens" bigint;
ALTER TABLE "request_log" ADD COLUMN "reasoning_tokens" bigint;
ALTER TABLE "request_log" ADD COLUMN "total_tokens" bigint;
ALTER TABLE "request_log" ADD COLUMN "input_price_micro" numeric(18, 6);
ALTER TABLE "request_log" ADD COLUMN "cached_input_price_micro" numeric(18, 6);
ALTER TABLE "request_log" ADD COLUMN "output_price_micro" numeric(18, 6);
ALTER TABLE "request_log" ADD COLUMN "reasoning_price_micro" numeric(18, 6);
ALTER TABLE "request_log" ADD COLUMN "pricing_rule_id" text;
ALTER TABLE "request_log" ADD COLUMN "provider_cost_micro" bigint;
ALTER TABLE "request_log" ADD COLUMN "credit_charged_micro" bigint;
ALTER TABLE "request_log" ADD COLUMN "ttft_ms" integer;
ALTER TABLE "request_log" ADD COLUMN "timing" jsonb;
ALTER TABLE "request_log" ADD COLUMN "attempts" integer NOT NULL DEFAULT 1;
ALTER TABLE "request_log" ADD COLUMN "fallback_used" boolean NOT NULL DEFAULT false;
ALTER TABLE "request_log" ADD COLUMN "stream" boolean NOT NULL DEFAULT false;
ALTER TABLE "request_log" ADD COLUMN "client_disconnected" boolean NOT NULL DEFAULT false;
ALTER TABLE "request_log" ADD COLUMN "request_body" text;
ALTER TABLE "request_log" ADD COLUMN "response_body" text;

-- PRD §149's index list, minus the two S0 indexes that already exist.
CREATE INDEX "request_log_project_created_idx" ON "request_log" USING btree ("project_id", "created_at");
CREATE INDEX "request_log_workspace_created_idx" ON "request_log" USING btree ("workspace_id", "created_at");
CREATE INDEX "request_log_provider_created_idx" ON "request_log" USING btree ("provider_id", "created_at");
CREATE INDEX "request_log_model_created_idx" ON "request_log" USING btree ("model_id", "created_at");
CREATE INDEX "request_log_status_created_idx" ON "request_log" USING btree ("status", "created_at");

-- Ledger survival rule (S0 hard-won lesson): the financial record outlives its
-- subject. Subject FKs (user_id/api_key_id) stay SET NULL; organizational FKs
-- CASCADE — deleting a project takes its request rows with it, which is the only
-- consistent choice for scoped history (PRD §22 "delete").
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_workspace_id_workspace_id_fk"
	FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade;
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_project_id_project_id_fk"
	FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade;
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_environment_id_environment_id_fk"
	FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade;

-- PRD §8, §29: one request, N routing attempts. Append-only.
CREATE TABLE "request_attempt" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"provider_id" text,
	"connection_id" text,
	"credential_id" text,
	"provider_model_id" text,
	"http_status" integer,
	"error_code" text,
	"retryable" boolean,
	"latency_ms" integer NOT NULL DEFAULT 0,
	"ttft_ms" integer,
	"provider_cost_micro" bigint,
	"reason" text,
	"started_at" timestamptz NOT NULL,
	"finished_at" timestamptz,
	"metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
	CONSTRAINT "request_attempt_request_attempt_unique" UNIQUE ("request_id", "attempt")
);
CREATE INDEX "request_attempt_request_idx" ON "request_attempt" USING btree ("request_id", "attempt");
ALTER TABLE "request_attempt" ADD CONSTRAINT "request_attempt_request_id_request_log_id_fk"
	FOREIGN KEY ("request_id") REFERENCES "public"."request_log"("id") ON DELETE cascade;

-- PRD §96–97: aggregates the long-range dashboards read instead of raw rows.
-- Dimensions that do not apply to a row are NULL; the unique index COALESCEs
-- them ('' sentinel) because NULLs are distinct.
CREATE TABLE "usage_hourly" (
	"bucket_start" timestamptz NOT NULL,
	"workspace_id" text,
	"project_id" text,
	"environment_id" text,
	"api_key_id" text,
	"model_id" text,
	"provider_id" text,
	"connection_id" text,
	"status" text NOT NULL,
	"endpoint" text NOT NULL,
	"requests" bigint NOT NULL DEFAULT 0,
	"successes" bigint NOT NULL DEFAULT 0,
	"tokens_in" bigint NOT NULL DEFAULT 0,
	"cached_input_tokens" bigint NOT NULL DEFAULT 0,
	"tokens_out" bigint NOT NULL DEFAULT 0,
	"reasoning_tokens" bigint NOT NULL DEFAULT 0,
	"total_tokens" bigint NOT NULL DEFAULT 0,
	"cost_micro" bigint NOT NULL DEFAULT 0,
	"latency_ms_sum" bigint NOT NULL DEFAULT 0,
	"latency_histogram" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"ttft_ms_sum" bigint NOT NULL DEFAULT 0,
	"fallback_count" bigint NOT NULL DEFAULT 0,
	"retry_count" bigint NOT NULL DEFAULT 0,
	"updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "usage_hourly_dims_idx" ON "usage_hourly" USING btree (
	"bucket_start",
	COALESCE("workspace_id", ''), COALESCE("project_id", ''), COALESCE("environment_id", ''),
	COALESCE("api_key_id", ''), COALESCE("model_id", ''), COALESCE("provider_id", ''),
	COALESCE("connection_id", ''), "status", "endpoint"
);

CREATE TABLE "usage_daily" (
	"bucket_start" timestamptz NOT NULL,
	"workspace_id" text,
	"project_id" text,
	"environment_id" text,
	"api_key_id" text,
	"model_id" text,
	"provider_id" text,
	"connection_id" text,
	"status" text NOT NULL,
	"endpoint" text NOT NULL,
	"requests" bigint NOT NULL DEFAULT 0,
	"successes" bigint NOT NULL DEFAULT 0,
	"tokens_in" bigint NOT NULL DEFAULT 0,
	"cached_input_tokens" bigint NOT NULL DEFAULT 0,
	"tokens_out" bigint NOT NULL DEFAULT 0,
	"reasoning_tokens" bigint NOT NULL DEFAULT 0,
	"total_tokens" bigint NOT NULL DEFAULT 0,
	"cost_micro" bigint NOT NULL DEFAULT 0,
	"latency_ms_sum" bigint NOT NULL DEFAULT 0,
	"latency_histogram" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"ttft_ms_sum" bigint NOT NULL DEFAULT 0,
	"fallback_count" bigint NOT NULL DEFAULT 0,
	"retry_count" bigint NOT NULL DEFAULT 0,
	"updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "usage_daily_dims_idx" ON "usage_daily" USING btree (
	"bucket_start",
	COALESCE("workspace_id", ''), COALESCE("project_id", ''), COALESCE("environment_id", ''),
	COALESCE("api_key_id", ''), COALESCE("model_id", ''), COALESCE("provider_id", ''),
	COALESCE("connection_id", ''), "status", "endpoint"
);

-- ----------------------------------------------------------------- billing -----
-- PRD §47–48, §128–129: ledger, never a bare balance. balance_micro is a cache
-- of SUM(credit_ledger.amount_micro), reconcilable at any time.

CREATE TABLE "billing_account" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"currency" char(3) NOT NULL DEFAULT 'USD',
	"status" text NOT NULL DEFAULT 'active',
	"warning_threshold_micro" bigint NOT NULL DEFAULT 10000000,
	"hard_stop_threshold_micro" bigint NOT NULL DEFAULT 0,
	"balance_micro" bigint NOT NULL DEFAULT 0,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "billing_account_status_check" CHECK ("status" IN ('active', 'suspended', 'closed'))
);
CREATE UNIQUE INDEX "billing_account_workspace_idx" ON "billing_account" USING btree ("workspace_id");
ALTER TABLE "billing_account" ADD CONSTRAINT "billing_account_workspace_id_workspace_id_fk"
	FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade;

CREATE TABLE "credit_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"billing_account_id" text NOT NULL,
	"type" text NOT NULL,
	"amount_micro" bigint NOT NULL,
	"currency" char(3) NOT NULL DEFAULT 'USD',
	"request_id" text,
	"idempotency_key" text,
	"description" text,
	"metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_by" text,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "credit_ledger_type_check" CHECK ("type" IN (
		'credit_purchase', 'usage_charge', 'adjustment', 'refund', 'promotion', 'expiration'
	))
);
-- Idempotency is DURABLE (PRD §118): the unique key is the stopper, Valkey is
-- only a fast-path hint.
CREATE UNIQUE INDEX "credit_ledger_idempotency_idx" ON "credit_ledger" USING btree ("idempotency_key");
CREATE INDEX "credit_ledger_account_created_idx" ON "credit_ledger" USING btree ("billing_account_id", "created_at");
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_billing_account_id_billing_account_id_fk"
	FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_account"("id") ON DELETE cascade;

CREATE TABLE "invoice" (
	"id" text PRIMARY KEY NOT NULL,
	"billing_account_id" text NOT NULL,
	"number" text NOT NULL,
	"period_start" timestamptz NOT NULL,
	"period_end" timestamptz NOT NULL,
	"amount_micro" bigint NOT NULL DEFAULT 0,
	"currency" char(3) NOT NULL DEFAULT 'USD',
	"status" text NOT NULL DEFAULT 'draft',
	"issued_at" timestamptz,
	"paid_at" timestamptz,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "invoice_status_check" CHECK ("status" IN ('draft', 'open', 'paid', 'void', 'uncollectible'))
);
CREATE UNIQUE INDEX "invoice_number_idx" ON "invoice" USING btree ("number");
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_billing_account_id_billing_account_id_fk"
	FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_account"("id") ON DELETE cascade;

-- --------------------------------------------------------------- operations ----
-- PRD §42–43, §63, §70–77, §104–105, §19.

CREATE TABLE "alert" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"project_id" text,
	"name" text NOT NULL,
	"condition" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"channel" text NOT NULL DEFAULT 'inapp',
	"enabled" boolean NOT NULL DEFAULT true,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "alert_channel_check" CHECK ("channel" IN ('inapp', 'email', 'webhook'))
);
CREATE INDEX "alert_workspace_idx" ON "alert" USING btree ("workspace_id");
ALTER TABLE "alert" ADD CONSTRAINT "alert_workspace_id_workspace_id_fk"
	FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade;
ALTER TABLE "alert" ADD CONSTRAINT "alert_project_id_project_id_fk"
	FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade;

CREATE TABLE "alert_event" (
	"id" text PRIMARY KEY NOT NULL,
	"alert_id" text NOT NULL,
	"triggered_at" timestamptz NOT NULL DEFAULT now(),
	"value" numeric NOT NULL,
	"message" text NOT NULL DEFAULT '',
	"state" text NOT NULL DEFAULT 'firing',
	"resolved_at" timestamptz,
	"delivered_at" timestamptz,
	CONSTRAINT "alert_event_state_check" CHECK ("state" IN ('firing', 'resolved'))
);
CREATE INDEX "alert_event_alert_idx" ON "alert_event" USING btree ("alert_id", "triggered_at");
ALTER TABLE "alert_event" ADD CONSTRAINT "alert_event_alert_id_alert_id_fk"
	FOREIGN KEY ("alert_id") REFERENCES "public"."alert"("id") ON DELETE cascade;

CREATE TABLE "webhook" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text,
	"url" text NOT NULL,
	"secret_enc" text,
	"events" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"enabled" boolean NOT NULL DEFAULT true,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "webhook_workspace_idx" ON "webhook" USING btree ("workspace_id");
ALTER TABLE "webhook" ADD CONSTRAINT "webhook_workspace_id_workspace_id_fk"
	FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade;

CREATE TABLE "webhook_delivery" (
	"id" text PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"status" text NOT NULL DEFAULT 'pending',
	"attempts" integer NOT NULL DEFAULT 0,
	"max_attempts" integer NOT NULL DEFAULT 5,
	"next_attempt_at" timestamptz NOT NULL DEFAULT now(),
	"response_code" integer,
	"error" text,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"delivered_at" timestamptz,
	CONSTRAINT "webhook_delivery_status_check" CHECK ("status" IN ('pending', 'delivered', 'failed', 'cancelled'))
);
CREATE INDEX "webhook_delivery_pending_idx" ON "webhook_delivery" USING btree ("status", "next_attempt_at");
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_webhook_id_webhook_id_fk"
	FOREIGN KEY ("webhook_id") REFERENCES "public"."webhook"("id") ON DELETE cascade;

-- PRD §75: PostgreSQL is the durable queue; workers claim with SKIP LOCKED.
CREATE TABLE "job" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"status" text NOT NULL DEFAULT 'pending',
	"attempts" integer NOT NULL DEFAULT 0,
	"max_attempts" integer NOT NULL DEFAULT 5,
	"available_at" timestamptz NOT NULL DEFAULT now(),
	"started_at" timestamptz,
	"finished_at" timestamptz,
	"error" text,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "job_status_check" CHECK ("status" IN ('pending', 'running', 'completed', 'failed', 'cancelled'))
);
CREATE INDEX "job_claim_idx" ON "job" USING btree ("status", "available_at");

-- PRD §77: durable observability/workflow events — NOT an event bus.
CREATE TABLE "system_event" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"resource" text,
	"resource_id" text,
	"workspace_id" text,
	"metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "system_event_type_created_idx" ON "system_event" USING btree ("type", "created_at");
CREATE INDEX "system_event_created_idx" ON "system_event" USING btree ("created_at");

-- PRD §71, §137: append-only in application code. Secrets are redacted at
-- write time — never in before/after/metadata.
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_user_id" text,
	"actor_kind" text NOT NULL DEFAULT 'user',
	"action" text NOT NULL,
	"resource" text NOT NULL,
	"resource_id" text,
	"workspace_id" text,
	"ip" text,
	"before" jsonb,
	"after" jsonb,
	"metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "audit_log_actor_kind_check" CHECK ("actor_kind" IN ('user', 'system', 'api_key'))
);
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");
CREATE INDEX "audit_log_resource_idx" ON "audit_log" USING btree ("resource", "resource_id");
CREATE INDEX "audit_log_workspace_idx" ON "audit_log" USING btree ("workspace_id");

-- PRD §19: status page incidents with a timeline.
CREATE TABLE "incident" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"component" text NOT NULL,
	"severity" text NOT NULL DEFAULT 'minor',
	"status" text NOT NULL DEFAULT 'investigating',
	"started_at" timestamptz NOT NULL DEFAULT now(),
	"resolved_at" timestamptz,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "incident_severity_check" CHECK ("severity" IN ('minor', 'major', 'critical')),
	CONSTRAINT "incident_status_check" CHECK ("status" IN ('investigating', 'identified', 'monitoring', 'resolved'))
);
CREATE INDEX "incident_status_idx" ON "incident" USING btree ("status", "started_at");

CREATE TABLE "incident_update" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"status" text NOT NULL,
	"message" text NOT NULL DEFAULT '',
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "incident_update_status_check" CHECK ("status" IN ('investigating', 'identified', 'monitoring', 'resolved'))
);
CREATE INDEX "incident_update_incident_idx" ON "incident_update" USING btree ("incident_id", "created_at");
ALTER TABLE "incident_update" ADD CONSTRAINT "incident_update_incident_id_incident_id_fk"
	FOREIGN KEY ("incident_id") REFERENCES "public"."incident"("id") ON DELETE cascade;

-- PRD §104: simple flags in PostgreSQL, cached in Valkey. No external service.
CREATE TABLE "feature_flag" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL DEFAULT '',
	"enabled" boolean NOT NULL DEFAULT false,
	"rollout" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"updated_by" text,
	"updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "feature_flag_name_idx" ON "feature_flag" USING btree ("name");

-- PRD §70: rule-based abuse signals (no ML).
CREATE TABLE "security_rule" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"config" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"enabled" boolean NOT NULL DEFAULT true,
	"action" text NOT NULL DEFAULT 'log',
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "security_rule_action_check" CHECK ("action" IN ('log', 'block'))
);
CREATE UNIQUE INDEX "security_rule_name_idx" ON "security_rule" USING btree ("name");

-- PRD §63, §105, §138: runtime breaker CONFIG lives in PostgreSQL (state is
-- Valkey-only and may vanish, spec §12); platform settings are a kv of jsonb.
CREATE TABLE "circuit_breaker" (
	"id" text PRIMARY KEY NOT NULL,
	"target" text NOT NULL,
	"target_id" text NOT NULL,
	"failure_threshold" integer NOT NULL DEFAULT 5,
	"window_seconds" integer NOT NULL DEFAULT 60,
	"open_ms" integer NOT NULL DEFAULT 30000,
	"half_open_probes" integer NOT NULL DEFAULT 2,
	"enabled" boolean NOT NULL DEFAULT true,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "circuit_breaker_target_check" CHECK ("target" IN ('provider', 'connection', 'model'))
);
CREATE UNIQUE INDEX "circuit_breaker_target_idx" ON "circuit_breaker" USING btree ("target", "target_id");

CREATE TABLE "system_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL DEFAULT 'null'::jsonb,
	"updated_by" text,
	"updated_at" timestamptz NOT NULL DEFAULT now()
);

COMMIT;
