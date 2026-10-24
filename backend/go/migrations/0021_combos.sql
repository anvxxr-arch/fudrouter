-- 0021_combos.sql — named fallback sequences.
--
-- A combo is an ordered list of models a customer names once and then treats as
-- one model string: `premium` = [claude-opus, gpt-6, glm-5]. When the first
-- model's candidates all fail, the walker proceeds to the next, which is exactly
-- what it already does across an alias's targets. So a combo is a RESOLUTION
-- shape, not a second routing engine — see store/combo.go.
--
-- Why a table rather than reusing model_alias: an alias maps one name to a SET
-- of models whose order the router scores by strategy, and the sets are
-- interchangeable across models of similar capability. A combo's order is
-- authored by the customer and is SEMANTIC — "try the expensive one first, fall
-- back to the cheap one" — so it must not be reordered by scoring. Keeping them
-- separate keeps `order by strategy` honest for aliases.
--
-- account_id, not workspace_id: migration 0019 made the account the tenant.
-- Nullable account_id is deliberately NOT allowed here, unlike model_alias:
-- a global combo would be a product-wide default that the operator cannot
-- override per customer, and nothing asks for one yet.
CREATE TABLE IF NOT EXISTS "combo" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean NOT NULL DEFAULT true,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "combo_account_id_user_id_fk"
		FOREIGN KEY ("account_id") REFERENCES "public"."user"("id") ON DELETE CASCADE
);

-- One name per account. The resolver looks up by (account_id, name), so this is
-- both the uniqueness rule and the lookup index.
CREATE UNIQUE INDEX IF NOT EXISTS "combo_account_name_idx"
	ON "combo" USING btree ("account_id", "name");

-- The ordered members. `position` is authored, never derived: the whole point of
-- a combo is that the customer decided the order.
--
-- model_id is ON DELETE CASCADE because a combo entry that names a deleted model
-- is meaningless — unlike request_log, whose model_id must survive so the
-- financial record stays readable.
CREATE TABLE IF NOT EXISTS "combo_model" (
	"combo_id" text NOT NULL,
	"position" integer NOT NULL,
	"model_id" text NOT NULL,
	CONSTRAINT "combo_model_combo_id_combo_id_fk"
		FOREIGN KEY ("combo_id") REFERENCES "public"."combo"("id") ON DELETE CASCADE,
	CONSTRAINT "combo_model_model_id_model_id_fk"
		FOREIGN KEY ("model_id") REFERENCES "public"."model"("id") ON DELETE CASCADE,
	PRIMARY KEY ("combo_id", "position")
);
