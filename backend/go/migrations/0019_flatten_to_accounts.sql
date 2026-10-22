-- 0019_flatten_to_accounts.sql — remove the workspace/project/environment
-- hierarchy; an API key belongs to the user account directly.
--
-- Why: the product is per-account. Every key already carries `user_id` (0000),
-- so the three scope columns were a second, redundant owner. Keeping both meant
-- two sources of truth for "whose key is this", and the console had to resolve
-- the hierarchy on every page just to find a key's owner.
--
-- Ordering matters and is the whole risk of this file:
--
--   * `api_key`, `request_log`, `billing_account`, `alert`, `webhook`,
--     `model_alias`, `budget`, `rate_limit`, `routing_policy`, `usage_hourly`
--     and `usage_daily` all carry `ON DELETE CASCADE` foreign keys to
--     `workspace`/`project`/`environment`. Dropping those tables first would
--     delete every key, ledger row, request log row and billing account with
--     them. Columns are dropped BEFORE the tables for that reason.
--   * `billing_account` is re-keyed, not dropped: credit_ledger and invoice
--     cascade off it, and the ledger is the money ledger. Rows are preserved;
--     only the owner column changes from workspace to user.
--   * `request_log` keeps its rows (append-only evidence, 90-day retention).
--     Its scope columns go; `user_id` and `api_key_id` remain the ownership.
--
-- Data preservation: every api_key row keeps `user_id` (already NOT NULL from
-- 0000), every billing_account row keeps its ledger by id. Only the hierarchy
-- rows themselves are discarded — they were pure scaffolding.
--
-- Not idempotent beyond IF EXISTS: this is a one-way migration, and re-running
-- it on a flattened database must be a no-op rather than a second rewrite.

-- ---------------------------------------------------------------- api_key ----
-- Keys are user-scoped. The columns were added nullable in 0006, so no default
-- backfill is needed; `user_id` was NOT NULL from the start.
ALTER TABLE "api_key" DROP CONSTRAINT IF EXISTS "api_key_workspace_id_workspace_id_fk";
ALTER TABLE "api_key" DROP CONSTRAINT IF EXISTS "api_key_project_id_project_id_fk";
ALTER TABLE "api_key" DROP CONSTRAINT IF EXISTS "api_key_environment_id_environment_id_fk";
DROP INDEX IF EXISTS "api_key_project_idx";
DROP INDEX IF EXISTS "api_key_environment_idx";
ALTER TABLE "api_key" DROP COLUMN IF EXISTS "workspace_id";
ALTER TABLE "api_key" DROP COLUMN IF EXISTS "project_id";
ALTER TABLE "api_key" DROP COLUMN IF EXISTS "environment_id";

-- ------------------------------------------------------------ request_log ----
-- Keep the rows and the api_key/user ownership; drop the scoped dimensions.
ALTER TABLE "request_log" DROP CONSTRAINT IF EXISTS "request_log_workspace_id_workspace_id_fk";
ALTER TABLE "request_log" DROP CONSTRAINT IF EXISTS "request_log_project_id_project_id_fk";
ALTER TABLE "request_log" DROP CONSTRAINT IF EXISTS "request_log_environment_id_environment_id_fk";
DROP INDEX IF EXISTS "request_log_project_created_idx";
DROP INDEX IF EXISTS "request_log_workspace_created_idx";
DROP INDEX IF EXISTS "request_log_environment_created_idx";
ALTER TABLE "request_log" DROP COLUMN IF EXISTS "workspace_id";
ALTER TABLE "request_log" DROP COLUMN IF EXISTS "project_id";
ALTER TABLE "request_log" DROP COLUMN IF EXISTS "environment_id";

-- --------------------------------------------------------- billing_account ----
-- Re-key the account from workspace to user in place: credit_ledger and invoice
-- reference it by `billing_account_id`, so recreating it would destroy the money
-- ledger. `workspace_id` → `user_id`, and the unique index moves with it.
--
-- An account whose workspace has no owner and no member cannot be re-keyed. The
-- guard is the LEDGER, not invoices: the ledger is the money record, while an
-- invoice is a generated document. Requiring "no invoice rows" too (the first
-- draft) aborts on a live account that carries a zero-value `open` invoice for a
-- probe workspace — and an ownerless account has no customer to bill, so the
-- document is worthless while the abort blocks the whole deploy. Any account
-- holding ledger rows still fails loudly at the SET NOT NULL below rather than
-- being deleted, because that would erase money.
ALTER TABLE "billing_account" ADD COLUMN IF NOT EXISTS "user_id" text;
UPDATE "billing_account" ba
   SET "user_id" = w."owner_user_id"
  FROM "workspace" w
 WHERE w."id" = ba."workspace_id"
   AND ba."user_id" IS NULL
   AND w."owner_user_id" IS NOT NULL;
UPDATE "billing_account" ba
   SET "user_id" = wm."user_id"
  FROM "workspace_member" wm
 WHERE wm."workspace_id" = ba."workspace_id"
   AND ba."user_id" IS NULL
   AND wm."user_id" IS NOT NULL;
-- Say what is being discarded instead of dropping it in silence.
DO $$
DECLARE
	acct int;
	inv int;
BEGIN
	SELECT count(*) INTO acct FROM "billing_account" ba
	 WHERE ba."user_id" IS NULL
	   AND NOT EXISTS (SELECT 1 FROM "credit_ledger" cl WHERE cl."billing_account_id" = ba."id");
	SELECT count(*) INTO inv FROM "invoice" i
	 JOIN "billing_account" ba ON ba."id" = i."billing_account_id"
	 WHERE ba."user_id" IS NULL
	   AND NOT EXISTS (SELECT 1 FROM "credit_ledger" cl WHERE cl."billing_account_id" = ba."id");
	IF acct > 0 THEN
		RAISE NOTICE '0019: deleting % ownerless billing account(s) and the % generated invoice(s) attached to them (no ledger rows)', acct, inv;
	END IF;
END $$;
DELETE FROM "billing_account" ba
 WHERE ba."user_id" IS NULL
   AND NOT EXISTS (SELECT 1 FROM "credit_ledger" cl WHERE cl."billing_account_id" = ba."id");
ALTER TABLE "billing_account" ALTER COLUMN "user_id" SET NOT NULL;
DROP INDEX IF EXISTS "billing_account_workspace_idx";
ALTER TABLE "billing_account" DROP CONSTRAINT IF EXISTS "billing_account_workspace_id_workspace_id_fk";
ALTER TABLE "billing_account" DROP COLUMN IF EXISTS "workspace_id";
CREATE UNIQUE INDEX "billing_account_user_idx" ON "billing_account" USING btree ("user_id");
ALTER TABLE "billing_account" ADD CONSTRAINT "billing_account_user_id_user_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade;

-- --------------------------------------------------------------- budgets -----
-- Budget scopes collapse to the account. A workspace-scoped budget WAS the
-- customer's spend cap, so deleting it would silently remove a control the
-- operator set — the cap is re-keyed onto the owner instead. Project- and
-- environment-scoped caps have no account analogue (they bounded a slice, not
-- the tenant) and are dropped with the tables they referenced.
--
-- Two workspaces can share an owner, so the mapping collides on
-- (scope, scope_id, period). Postgres refuses `ON CONFLICT DO UPDATE` when the
-- SAME command proposes two rows for one target ("cannot affect row a second
-- time"), so the collapse happens in the SELECT: one row per owner+period,
-- taking the tightest value of each column. Rehearsing this against a
-- two-workspace-one-owner fixture is what surfaced it — the first rehearsal gave
-- every workspace its own owner, so the merge never executed.
--
-- `action_at_100` is ordered explicitly rather than alphabetically: block <
-- notify < restrict happens to sort correctly today, and a migration that
-- depends on that coincidence breaks the day the vocabulary changes.
ALTER TABLE "budget" DROP CONSTRAINT IF EXISTS "budget_scope_check";
INSERT INTO "budget" ("id", "scope", "scope_id", "period", "amount_micro", "warn_percent", "critical_percent", "action_at_100")
SELECT 'bdg_' || substr(md5(min(b."id")), 1, 24), 'account', w."owner_user_id", b."period",
       min(b."amount_micro"), min(b."warn_percent"), min(b."critical_percent"),
       CASE min(CASE b."action_at_100" WHEN 'block' THEN 0 WHEN 'restrict' THEN 1 ELSE 2 END)
         WHEN 0 THEN 'block' WHEN 1 THEN 'restrict' ELSE 'notify' END
  FROM "budget" b
  JOIN "workspace" w ON w."id" = b."scope_id"
 WHERE b."scope" = 'workspace'
   AND w."owner_user_id" IS NOT NULL
 GROUP BY w."owner_user_id", b."period";
DELETE FROM "budget" WHERE "scope" IN ('workspace', 'project', 'environment');
-- `account` is the new scope name for what `workspace` meant: one budget per
-- user account. `api_key` stays for per-key caps.
ALTER TABLE "budget" ADD CONSTRAINT "budget_scope_check" CHECK ("scope" IN ('account', 'api_key'));

-- ------------------------------------------------------------ rate_limit -----
-- Same collapse as budget, same reason for the GROUP BY. `min` ignores NULLs,
-- which is the wanted semantics: a workspace with no rpm cap does not loosen a
-- sibling's 60 rpm.
ALTER TABLE "rate_limit" DROP CONSTRAINT IF EXISTS "rate_limit_scope_check";
INSERT INTO "rate_limit" ("id", "scope", "scope_id", "rpm", "tpm", "rpd", "tpd", "concurrency", "daily_spend_micro", "monthly_spend_micro")
SELECT 'lim_' || substr(md5(min(r."id")), 1, 24), 'account', w."owner_user_id",
       min(r."rpm"), min(r."tpm"), min(r."rpd"), min(r."tpd"), min(r."concurrency"),
       min(r."daily_spend_micro"), min(r."monthly_spend_micro")
  FROM "rate_limit" r
  JOIN "workspace" w ON w."id" = r."scope_id"
 WHERE r."scope" = 'workspace'
   AND w."owner_user_id" IS NOT NULL
 GROUP BY w."owner_user_id";
DELETE FROM "rate_limit" WHERE "scope" IN ('workspace', 'project', 'environment');
ALTER TABLE "rate_limit" ADD CONSTRAINT "rate_limit_scope_check" CHECK ("scope" IN ('account', 'api_key'));

-- --------------------------------------------------------- routing_policy ----
-- Routing was resolvable per environment → project → workspace → platform. With
-- no hierarchy the only scopes are platform (all three NULL) and account. Rows
-- that only made sense for a project/environment are removed; the platform
-- default (all-NULL) survives.
DELETE FROM "routing_policy" WHERE "project_id" IS NOT NULL OR "environment_id" IS NOT NULL;
ALTER TABLE "routing_policy" DROP CONSTRAINT IF EXISTS "routing_policy_workspace_id_workspace_id_fk";
ALTER TABLE "routing_policy" DROP CONSTRAINT IF EXISTS "routing_policy_project_id_project_id_fk";
ALTER TABLE "routing_policy" DROP CONSTRAINT IF EXISTS "routing_policy_environment_id_environment_id_fk";
DROP INDEX IF EXISTS "routing_policy_project_idx";
DROP INDEX IF EXISTS "routing_policy_environment_idx";
ALTER TABLE "routing_policy" DROP COLUMN IF EXISTS "project_id";
ALTER TABLE "routing_policy" DROP COLUMN IF EXISTS "environment_id";
-- The workspace-scoped rows become the account-scoped rows, but the VALUE has
-- to move too: `workspace_id` holds a `wrk_…` id and the new FK points at
-- `user.id`. Without this remap every surviving row fails the FK on add (found
-- by rehearsing 0019 against a prod-shaped database). A row whose workspace has
-- no owner cannot be re-homed; leaving it would turn a customer policy into the
-- platform default (account_id NULL), so it is deleted rather than widened.
UPDATE "routing_policy" rp
   SET "workspace_id" = w."owner_user_id"
  FROM "workspace" w
 WHERE rp."workspace_id" = w."id"
   AND w."owner_user_id" IS NOT NULL;
DELETE FROM "routing_policy" WHERE "workspace_id" IS NOT NULL AND "workspace_id" NOT IN (SELECT "id" FROM "user");
ALTER TABLE "routing_policy" RENAME COLUMN "workspace_id" TO "account_id";
-- The index follows the column it indexes; leaving it named `_ws_` would be a
-- name that lies about what it covers.
ALTER INDEX IF EXISTS "routing_policy_ws_idx" RENAME TO "routing_policy_account_idx";
ALTER TABLE "routing_policy" ADD CONSTRAINT "routing_policy_account_id_user_id_fk"
	FOREIGN KEY ("account_id") REFERENCES "public"."user"("id") ON DELETE cascade;

-- ------------------------------------------------------------ model_alias ----
-- Alias scope was project → workspace → global. With no hierarchy: account →
-- global. Project-scoped aliases lose their meaning; they are re-homed to the
-- workspace's account rather than deleted, because an alias that resolved for a
-- project should keep resolving for the same customer.
ALTER TABLE "model_alias" DROP CONSTRAINT IF EXISTS "model_alias_project_id_project_id_fk";
ALTER TABLE "model_alias" DROP CONSTRAINT IF EXISTS "model_alias_workspace_id_workspace_id_fk";
-- Workspace-scoped aliases map straight to the workspace owner. The statement
-- order matters: an earlier draft re-homed project-scoped rows to
-- `project.workspace_id` first, which then failed this column's new FK to
-- `user` (a workspace id is not a user id). Each row is mapped once, from
-- whichever scope it actually carries.
UPDATE "model_alias" a
   SET "workspace_id" = w."owner_user_id"
  FROM "workspace" w
 WHERE a."workspace_id" = w."id"
   AND w."owner_user_id" IS NOT NULL;
-- Project-only aliases (workspace_id NULL) map through the project's owner.
UPDATE "model_alias" a
   SET "workspace_id" = w."owner_user_id"
  FROM "project" p
  JOIN "workspace" w ON w."id" = p."workspace_id"
 WHERE a."project_id" = p."id"
   AND a."workspace_id" IS NULL
   AND w."owner_user_id" IS NOT NULL;
DROP INDEX IF EXISTS "model_alias_scope_name_idx";
ALTER TABLE "model_alias" DROP COLUMN IF EXISTS "project_id";
ALTER TABLE "model_alias" RENAME COLUMN "workspace_id" TO "account_id";
-- NULL account_id = the global virtual models. The COALESCE index keeps the
-- NULL-as-distinct-scope semantics the old one had.
CREATE UNIQUE INDEX "model_alias_scope_name_idx" ON "model_alias"
	USING btree (COALESCE("account_id", ''), "name");
ALTER TABLE "model_alias" ADD CONSTRAINT "model_alias_account_id_user_id_fk"
	FOREIGN KEY ("account_id") REFERENCES "public"."user"("id") ON DELETE cascade;

-- ------------------------------------------------------------------ alert ----
ALTER TABLE "alert" DROP CONSTRAINT IF EXISTS "alert_workspace_id_workspace_id_fk";
ALTER TABLE "alert" DROP CONSTRAINT IF EXISTS "alert_project_id_project_id_fk";
DROP INDEX IF EXISTS "alert_workspace_idx";
ALTER TABLE "alert" DROP COLUMN IF EXISTS "project_id";
-- Same value remap as routing_policy: the column holds a workspace id, the new
-- FK wants a user id. An alert with no resolvable owner is deleted, because a
-- NULL account_id would silently make it a platform-wide alert.
UPDATE "alert" a SET "workspace_id" = w."owner_user_id"
  FROM "workspace" w WHERE a."workspace_id" = w."id" AND w."owner_user_id" IS NOT NULL;
DELETE FROM "alert" WHERE "workspace_id" IS NOT NULL AND "workspace_id" NOT IN (SELECT "id" FROM "user");
ALTER TABLE "alert" RENAME COLUMN "workspace_id" TO "account_id";
CREATE INDEX "alert_account_idx" ON "alert" USING btree ("account_id");
ALTER TABLE "alert" ADD CONSTRAINT "alert_account_id_user_id_fk"
	FOREIGN KEY ("account_id") REFERENCES "public"."user"("id") ON DELETE cascade;

-- ---------------------------------------------------------------- webhook ----
ALTER TABLE "webhook" DROP CONSTRAINT IF EXISTS "webhook_workspace_id_workspace_id_fk";
DROP INDEX IF EXISTS "webhook_workspace_idx";
ALTER TABLE "webhook" DROP COLUMN IF EXISTS "project_id";
UPDATE "webhook" h SET "workspace_id" = w."owner_user_id"
  FROM "workspace" w WHERE h."workspace_id" = w."id" AND w."owner_user_id" IS NOT NULL;
DELETE FROM "webhook" WHERE "workspace_id" IS NOT NULL AND "workspace_id" NOT IN (SELECT "id" FROM "user");
ALTER TABLE "webhook" RENAME COLUMN "workspace_id" TO "account_id";
CREATE INDEX "webhook_account_idx" ON "webhook" USING btree ("account_id");
ALTER TABLE "webhook" ADD CONSTRAINT "webhook_account_id_user_id_fk"
	FOREIGN KEY ("account_id") REFERENCES "public"."user"("id") ON DELETE cascade;

-- ----------------------------------------------------------- system_event ----
-- Historical rows keep their workspace_id value (it is an opaque text column
-- with no FK); only new code stops writing it. Nothing to migrate.

-- ------------------------------------------------------- usage aggregates ----
-- The rollup dimensions lose the three scoped columns, and the buckets must be
-- COLLAPSED, not merely renamed. A plain UPDATE breaks two ways, both found by
-- rehearsing against a workspace with two projects:
--
--   * two project buckets for one workspace become the same dimension tuple, so
--     the UNIQUE index rebuilt below rejects them and the migration aborts;
--   * a workspace with no owner keeps a `wrk_…` value in `account_id`, which no
--     dashboard query matches — the spend vanishes from view without an error.
--
-- So rows are summed into a scratch table and swapped in. A workspace with no
-- owner maps to NULL, which is the "unattributed" bucket the rollup already
-- produces for request_log rows with no user_id — honest, and it collides with
-- nothing. The histogram buckets are spelled out because `jsonb_object_agg`
-- cannot merge duplicate keys in a single pass; the vocabulary is HISTOGRAM_SQL's
-- in packages/platform/server/workers.ts, frozen at this migration.
ALTER TABLE "usage_hourly" DROP COLUMN IF EXISTS "project_id";
ALTER TABLE "usage_hourly" DROP COLUMN IF EXISTS "environment_id";
ALTER TABLE "usage_daily" DROP COLUMN IF EXISTS "project_id";
ALTER TABLE "usage_daily" DROP COLUMN IF EXISTS "environment_id";

CREATE TEMP TABLE "usage_hourly_collapsed" AS
SELECT h."bucket_start", w."owner_user_id" AS "account_id",
       h."api_key_id", h."model_id", h."provider_id", h."connection_id", h."status", h."endpoint",
       sum(h."requests") AS "requests", sum(h."successes") AS "successes",
       sum(h."tokens_in") AS "tokens_in", sum(h."cached_input_tokens") AS "cached_input_tokens",
       sum(h."tokens_out") AS "tokens_out", sum(h."reasoning_tokens") AS "reasoning_tokens",
       sum(h."total_tokens") AS "total_tokens", sum(h."cost_micro") AS "cost_micro",
       sum(h."latency_ms_sum") AS "latency_ms_sum",
       jsonb_build_object(
         '50',    sum(coalesce((h."latency_histogram"->>'50')::bigint, 0)),
         '100',   sum(coalesce((h."latency_histogram"->>'100')::bigint, 0)),
         '250',   sum(coalesce((h."latency_histogram"->>'250')::bigint, 0)),
         '500',   sum(coalesce((h."latency_histogram"->>'500')::bigint, 0)),
         '1000',  sum(coalesce((h."latency_histogram"->>'1000')::bigint, 0)),
         '2500',  sum(coalesce((h."latency_histogram"->>'2500')::bigint, 0)),
         '5000',  sum(coalesce((h."latency_histogram"->>'5000')::bigint, 0)),
         '10000', sum(coalesce((h."latency_histogram"->>'10000')::bigint, 0)),
         '25000', sum(coalesce((h."latency_histogram"->>'25000')::bigint, 0)),
         '60000', sum(coalesce((h."latency_histogram"->>'60000')::bigint, 0)),
         'inf',   sum(coalesce((h."latency_histogram"->>'inf')::bigint, 0))
       ) AS "latency_histogram",
       sum(h."ttft_ms_sum") AS "ttft_ms_sum", sum(h."fallback_count") AS "fallback_count",
       sum(h."retry_count") AS "retry_count", max(h."updated_at") AS "updated_at"
  FROM "usage_hourly" h
  LEFT JOIN "workspace" w ON w."id" = h."workspace_id"
 GROUP BY h."bucket_start", w."owner_user_id", h."api_key_id", h."model_id",
          h."provider_id", h."connection_id", h."status", h."endpoint";

CREATE TEMP TABLE "usage_daily_collapsed" AS
SELECT d."bucket_start", w."owner_user_id" AS "account_id",
       d."api_key_id", d."model_id", d."provider_id", d."connection_id", d."status", d."endpoint",
       sum(d."requests") AS "requests", sum(d."successes") AS "successes",
       sum(d."tokens_in") AS "tokens_in", sum(d."cached_input_tokens") AS "cached_input_tokens",
       sum(d."tokens_out") AS "tokens_out", sum(d."reasoning_tokens") AS "reasoning_tokens",
       sum(d."total_tokens") AS "total_tokens", sum(d."cost_micro") AS "cost_micro",
       sum(d."latency_ms_sum") AS "latency_ms_sum",
       jsonb_build_object(
         '50',    sum(coalesce((d."latency_histogram"->>'50')::bigint, 0)),
         '100',   sum(coalesce((d."latency_histogram"->>'100')::bigint, 0)),
         '250',   sum(coalesce((d."latency_histogram"->>'250')::bigint, 0)),
         '500',   sum(coalesce((d."latency_histogram"->>'500')::bigint, 0)),
         '1000',  sum(coalesce((d."latency_histogram"->>'1000')::bigint, 0)),
         '2500',  sum(coalesce((d."latency_histogram"->>'2500')::bigint, 0)),
         '5000',  sum(coalesce((d."latency_histogram"->>'5000')::bigint, 0)),
         '10000', sum(coalesce((d."latency_histogram"->>'10000')::bigint, 0)),
         '25000', sum(coalesce((d."latency_histogram"->>'25000')::bigint, 0)),
         '60000', sum(coalesce((d."latency_histogram"->>'60000')::bigint, 0)),
         'inf',   sum(coalesce((d."latency_histogram"->>'inf')::bigint, 0))
       ) AS "latency_histogram",
       sum(d."ttft_ms_sum") AS "ttft_ms_sum", sum(d."fallback_count") AS "fallback_count",
       sum(d."retry_count") AS "retry_count", max(d."updated_at") AS "updated_at"
  FROM "usage_daily" d
  LEFT JOIN "workspace" w ON w."id" = d."workspace_id"
 GROUP BY d."bucket_start", w."owner_user_id", d."api_key_id", d."model_id",
          d."provider_id", d."connection_id", d."status", d."endpoint";

DROP INDEX IF EXISTS "usage_hourly_dims_idx";
DROP INDEX IF EXISTS "usage_daily_dims_idx";
TRUNCATE "usage_hourly";
TRUNCATE "usage_daily";
-- workspace_id becomes the account key.
ALTER TABLE "usage_hourly" RENAME COLUMN "workspace_id" TO "account_id";
ALTER TABLE "usage_daily" RENAME COLUMN "workspace_id" TO "account_id";
INSERT INTO "usage_hourly" ("bucket_start", "account_id", "api_key_id", "model_id",
	"provider_id", "connection_id", "status", "endpoint", "requests", "successes",
	"tokens_in", "cached_input_tokens", "tokens_out", "reasoning_tokens", "total_tokens",
	"cost_micro", "latency_ms_sum", "latency_histogram", "ttft_ms_sum", "fallback_count",
	"retry_count", "updated_at")
SELECT "bucket_start", "account_id", "api_key_id", "model_id",
	"provider_id", "connection_id", "status", "endpoint", "requests", "successes",
	"tokens_in", "cached_input_tokens", "tokens_out", "reasoning_tokens", "total_tokens",
	"cost_micro", "latency_ms_sum", "latency_histogram", "ttft_ms_sum", "fallback_count",
	"retry_count", "updated_at"
  FROM "usage_hourly_collapsed";
INSERT INTO "usage_daily" ("bucket_start", "account_id", "api_key_id", "model_id",
	"provider_id", "connection_id", "status", "endpoint", "requests", "successes",
	"tokens_in", "cached_input_tokens", "tokens_out", "reasoning_tokens", "total_tokens",
	"cost_micro", "latency_ms_sum", "latency_histogram", "ttft_ms_sum", "fallback_count",
	"retry_count", "updated_at")
SELECT "bucket_start", "account_id", "api_key_id", "model_id",
	"provider_id", "connection_id", "status", "endpoint", "requests", "successes",
	"tokens_in", "cached_input_tokens", "tokens_out", "reasoning_tokens", "total_tokens",
	"cost_micro", "latency_ms_sum", "latency_histogram", "ttft_ms_sum", "fallback_count",
	"retry_count", "updated_at"
  FROM "usage_daily_collapsed";
DROP TABLE "usage_hourly_collapsed";
DROP TABLE "usage_daily_collapsed";
CREATE UNIQUE INDEX "usage_hourly_dims_idx" ON "usage_hourly" USING btree (
	"bucket_start",
	COALESCE("account_id", ''), COALESCE("api_key_id", ''), COALESCE("model_id", ''),
	COALESCE("provider_id", ''), COALESCE("connection_id", ''), "status", "endpoint"
);
CREATE UNIQUE INDEX "usage_daily_dims_idx" ON "usage_daily" USING btree (
	"bucket_start",
	COALESCE("account_id", ''), COALESCE("api_key_id", ''), COALESCE("model_id", ''),
	COALESCE("provider_id", ''), COALESCE("connection_id", ''), "status", "endpoint"
);

-- --------------------------------------------------------------- audit_log ----
-- Historical audit rows keep their workspace_id text (evidence of what was true
-- then). No FK exists, so nothing cascades; new writes stop setting it.

-- ------------------------------------------------------------ drop tables -----
-- Order: children before parents. `environment` references `routing_policy` (now
-- account/platform scoped) — that column is dropped first so no FK blocks the
-- table drop.
ALTER TABLE "environment" DROP CONSTRAINT IF EXISTS "environment_routing_policy_id_routing_policy_id_fk";
DROP TABLE IF EXISTS "environment";
DROP TABLE IF EXISTS "project";
DROP TABLE IF EXISTS "workspace_member";
DROP TABLE IF EXISTS "workspace_role";
DROP TABLE IF EXISTS "workspace";

-- ------------------------------------------------- builtin role templates -----
-- workspace_role is gone, so the builtin role rows that 0007 seeded have no
-- home. The platform role table (`user.role`) is unaffected.
