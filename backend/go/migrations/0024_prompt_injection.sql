-- 0024_prompt_injection.sql — operator-authored prompt injection.
--
-- The feature 9Router Pro is bought for: one injection per TARGET, applied to
-- the upstream request body by the data plane before dispatch. Three scopes,
-- stacked in a fixed order (account → api_key → model), at most one row per
-- scope applying to a single request.
--
-- Why this belongs in the ROUTER and not the client: the persona must follow
-- the model, not the app. A customer who switches models mid-flight (or whose
-- agent fails over to a second model) keeps the same behaviour, because the
-- injection is re-resolved per request on the server. A client-side prompt
-- cannot do that, which is why every combo hop here sees the same injection.
--
-- Why it is a TABLE and not a column on api_key: a model-scoped injection is
-- per MODEL, not per key, and a key-scoped one must not fork a row per model.
-- The three scopes are one table with nullable target columns — the exact
-- shape 9Router Pro uses (global / per key / per model).
--
-- FAIL-OPEN IS A HARD RULE (see internal/proxy/injection.go): a request whose
-- body cannot be rewritten is dispatched unchanged. An injection is a product
-- feature, never a reason a chat fails. That is also why `content` has no
-- length cap here — 9Router Pro's own usage runs 11K–102K characters per
-- persona — while the console caps input at 256 KiB to keep a paste accident
-- from filling the disk.
CREATE TABLE IF NOT EXISTS "prompt_injection" (
	"id" text PRIMARY KEY NOT NULL,
	-- The tenant. NULL is deliberately NOT allowed: unlike model_alias, a
	-- platform-wide injection would silently reshape every customer's traffic,
	-- which is a decision nobody has asked for and one the commercial claim
	-- cannot defend.
	"account_id" text NOT NULL,
	-- NULL = account-wide (applies to every key of this account).
	"api_key_id" text,
	-- NULL = every model. Matched case-insensitively against BOTH the name the
	-- client asked for (combo, alias, virtual) and the canonical slug it
	-- resolved to, so an injection authored for `claude-opus` also fires when
	-- it is reached through a combo or an alias.
	"model_slug" text,
	-- system_prepend | system_append | chat_script
	"mode" text NOT NULL DEFAULT 'system_prepend',
	"content" text NOT NULL,
	"enabled" boolean NOT NULL DEFAULT true,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "prompt_injection_mode_check"
		CHECK ("mode" IN ('system_prepend', 'system_append', 'chat_script')),
	CONSTRAINT "prompt_injection_account_id_user_id_fk"
		FOREIGN KEY ("account_id") REFERENCES "public"."user"("id") ON DELETE CASCADE,
	CONSTRAINT "prompt_injection_api_key_id_api_key_id_fk"
		FOREIGN KEY ("api_key_id") REFERENCES "public"."api_key"("id") ON DELETE CASCADE
);

-- The hot-path read: one query per request resolving all three scopes for
-- (account, key, model-name). Partial on enabled because a disabled row is
-- never read by the router.
CREATE INDEX IF NOT EXISTS "prompt_injection_account_idx"
	ON "prompt_injection" USING btree ("account_id", "api_key_id", "model_slug")
	WHERE "enabled";

-- One injection per target. Two account-wide rows would stack twice, which is
-- not what "stacking global → key → model" means.
CREATE UNIQUE INDEX IF NOT EXISTS "prompt_injection_scope_uniq"
	ON "prompt_injection" USING btree (
		"account_id",
		coalesce("api_key_id", ''),
		coalesce(lower("model_slug"), '')
	);
