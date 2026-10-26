-- 0024_access_control.sql — invite-only access, and the plan table a payment
-- gateway will eventually attach to.
--
-- The problem: Discord OAuth was the only way in and it created an account
-- unconditionally (apps/web/server/index.mjs `user.create.after` →
-- provisionAccount). Anyone who could reach the login button got a working API
-- key. There is no payment gateway yet, so the answer is an INVITE: an admin
-- allowlist of Discord ids, checked at account creation.
--
-- `access_status` defaults to 'active' on purpose. Every user that exists today
-- keeps working — the gate applies to accounts created after this migration.
-- Backfilling to 'pending' would revoke the whole user base in one statement.
--
--   active  — normal access
--   pending — signed up without an invite; refused at sign-in until an admin
--             approves (the session hook in index.mjs is the enforcement point)
--   revoked — access withdrawn; refused at sign-in
ALTER TABLE "user" ADD COLUMN "access_status" text NOT NULL DEFAULT 'active';
ALTER TABLE "user" ADD CONSTRAINT "user_access_status_check"
	CHECK ("access_status" IN ('active', 'pending', 'revoked'));

-- The invite list. One row per invited Discord id.
--
-- `discord_id` is NOT unique: an invite that was used can be revoked and
-- re-issued by adding a second row, and the `used_by`/`used_at` pair is what
-- distinguishes them. Lookup is by discord_id, so it carries its own index.
CREATE TABLE "invite_allowlist" (
	"id" text PRIMARY KEY NOT NULL,
	"discord_id" text NOT NULL,
	"note" text,
	"created_by" text,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"used_by" text,
	"used_at" timestamptz,
	CONSTRAINT "invite_allowlist_used_by_user_id_fk"
		FOREIGN KEY ("used_by") REFERENCES "public"."user"("id") ON DELETE SET NULL
);
CREATE INDEX "invite_allowlist_discord_idx" ON "invite_allowlist" USING btree ("discord_id");

-- Plans. There is no billing integration yet; this table exists so a gateway
-- has something to attach to, and so the key cap is a number an operator can
-- edit rather than a constant in code.
--
-- `max_api_keys` NULL means unlimited. `rpm`/`concurrency` are the published
-- limits — the Go data plane reads its own constants today
-- (store.FreeTierRPMPerAccount / FreeTierConcurrencyPerAccount); the columns
-- are seeded to those same values so the two cannot disagree at launch.
CREATE TABLE "plan" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"max_api_keys" integer,
	"rpm" integer,
	"concurrency" integer,
	"price_micro" bigint NOT NULL DEFAULT 0,
	"active" boolean NOT NULL DEFAULT true,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "plan_slug_unique" UNIQUE ("slug")
);

-- One plan row: the invite beta. max_api_keys = 5 replaces the "10 API keys"
-- marketing copy nothing enforced; rpm/concurrency match the Go constants.
--
-- Seeded BEFORE `billing_account.plan_id` is added below: that column defaults
-- to 'pln_free', and the foreign key validates every existing row the moment it
-- is created. Inserting the plan afterwards would make the ALTER fail on any
-- database that already has accounts.
INSERT INTO "plan" ("id", "slug", "name", "max_api_keys", "rpm", "concurrency", "price_micro", "active")
VALUES ('pln_free', 'free', 'Invite beta', 5, 75, 3, 0, true)
ON CONFLICT ("slug") DO NOTHING;

-- A billing account belongs to one plan. ON DELETE SET NULL, not CASCADE: a
-- retired plan must not delete the account and its ledger with it — the ledger
-- is the money record. The cap query falls back to the seeded free plan when
-- `plan_id` is NULL, so SET NULL degrades to the free tier rather than to
-- "unlimited". DEFAULT 'pln_free' means a new account never lands planless
-- without every insert site having to say so.
ALTER TABLE "billing_account" ADD COLUMN "plan_id" text DEFAULT 'pln_free';
ALTER TABLE "billing_account" ADD CONSTRAINT "billing_account_plan_id_plan_id_fk"
	FOREIGN KEY ("plan_id") REFERENCES "public"."plan"("id") ON DELETE SET NULL;
