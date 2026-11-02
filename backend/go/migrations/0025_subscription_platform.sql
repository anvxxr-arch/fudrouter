-- 0025_subscription_platform.sql — subscriptions, payments, key IP guard, warnings.
--
-- The owner directive (docs/specs/2026-10-31-subscription-platform-target.md)
-- changes the member-facing product from pay-per-token to TIME-BASED
-- SUBSCRIPTIONS (1d/3d/7d/14d/28d in IDR). Token metering stays — it feeds
-- abuse detection and the ledger — but a member buys time, not tokens.
--
-- Four tables, one migration, because they are one feature: a payment grants a
-- subscription, the subscription gates the key, the key is IP-guarded, and a
-- violation raises a warning. Splitting them would let a half-applied state
-- exist where a paid member has no entitlement.
--
-- Why `subscription` is separate from `billing_account`: the account holds the
-- MONEY (credit_ledger, balance_micro); the subscription holds the TIME. A
-- member can have a zero balance and a live subscription (they paid for 7 days,
-- spent nothing yet), and a member can have credit and no subscription. Merging
-- them would make "expired" and "broke" the same state, which they are not.
--
-- Why `payment` is separate from `invoice`: an invoice is a generated document
-- (0006); a payment is an attempt to move money through a gateway. One invoice
-- can have several payment attempts (a failed card, then a retry), and a
-- gateway webhook arrives against a payment, not an invoice. The unique key is
-- the gateway's own reference, so a replayed webhook is idempotent.

-- ---------------------------------------------------------------------------
-- subscription — the entitlement. One row per paid period.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "subscription" (
	"id" text PRIMARY KEY NOT NULL,
	-- The tenant. The user account IS the tenant since 0019.
	"account_id" text NOT NULL,
	-- The plan the member bought. Constrained to the five the owner priced, so
	-- a typo in a bot command cannot mint an unpriced entitlement.
	"plan" text NOT NULL,
	"status" text NOT NULL DEFAULT 'active',
	-- The paid window. `expires_at` is the only field the hot path reads, so it
	-- is indexed; `starts_at` exists so a future-dated grant is representable
	-- without a second table.
	"starts_at" timestamptz NOT NULL DEFAULT now(),
	"expires_at" timestamptz NOT NULL,
	-- What was actually paid, in IDR minor units (rupiah has no minor unit in
	-- practice, so this is whole rupiah × 100 for consistency with the ledger's
	-- micro convention — see the CHECK below).
	"price_idr" bigint NOT NULL,
	-- The payment that granted this. NULL only for an admin comp.
	"payment_id" text,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "subscription_plan_check"
		CHECK ("plan" IN ('sub_1d', 'sub_3d', 'sub_7d', 'sub_14d', 'sub_28d')),
	CONSTRAINT "subscription_status_check"
		CHECK ("status" IN ('active', 'expired', 'cancelled', 'refunded')),
	CONSTRAINT "subscription_account_id_user_id_fk"
		FOREIGN KEY ("account_id") REFERENCES "public"."user"("id") ON DELETE CASCADE
);

-- The hot-path read: "does this account have a live subscription right now?"
-- Partial on active because an expired/cancelled row is never the answer.
CREATE INDEX IF NOT EXISTS "subscription_account_live_idx"
	ON "subscription" USING btree ("account_id", "expires_at")
	WHERE "status" = 'active';

-- ---------------------------------------------------------------------------
-- payment — one attempt to move money through a gateway.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "payment" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	-- Which surface started it: the web checkout, or a bot command.
	"channel" text NOT NULL,
	-- The gateway's own reference (order id / invoice id). UNIQUE so a replayed
	-- webhook updates the same row instead of granting twice.
	"gateway_ref" text NOT NULL,
	"gateway" text NOT NULL,
	"plan" text NOT NULL,
	"amount_idr" bigint NOT NULL,
	"status" text NOT NULL DEFAULT 'pending',
	-- The raw webhook body, kept for dispute resolution. Never parsed on the
	-- hot path; only an operator reads it.
	"raw" jsonb,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "payment_channel_check"
		CHECK ("channel" IN ('web', 'discord', 'telegram', 'admin')),
	CONSTRAINT "payment_status_check"
		CHECK ("status" IN ('pending', 'claimed', 'confirmed', 'rejected', 'failed', 'expired', 'refunded')),
	CONSTRAINT "payment_plan_check"
		CHECK ("plan" IN ('sub_1d', 'sub_3d', 'sub_7d', 'sub_14d', 'sub_28d')),
	CONSTRAINT "payment_account_id_user_id_fk"
		FOREIGN KEY ("account_id") REFERENCES "public"."user"("id") ON DELETE CASCADE
);

-- Idempotency: the gateway reference is unique per gateway. A webhook that
-- arrives twice (gateways retry) must not grant twice.
CREATE UNIQUE INDEX IF NOT EXISTS "payment_gateway_ref_uniq"
	ON "payment" USING btree ("gateway", "gateway_ref");

CREATE INDEX IF NOT EXISTS "payment_account_created_idx"
	ON "payment" USING btree ("account_id", "created_at" DESC);

-- ---------------------------------------------------------------------------
-- api_key_ip — the max-3-IP allowlist per key (owner rule 14).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "api_key_ip" (
	"id" text PRIMARY KEY NOT NULL,
	"api_key_id" text NOT NULL,
	-- The address the key was first seen from. `inet` so a CIDR can be stored
	-- later without a migration; today every row is a /32 or /128.
	"ip" inet NOT NULL,
	"first_seen_at" timestamptz NOT NULL DEFAULT now(),
	"last_seen_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "api_key_ip_api_key_id_api_key_id_fk"
		FOREIGN KEY ("api_key_id") REFERENCES "public"."api_key"("id") ON DELETE CASCADE
);

-- One row per (key, address). The 3-slot cap is enforced in the application
-- (a COUNT before insert), not here, because the cap is a product rule that may
-- change and a CHECK cannot express "at most 3 rows per key".
CREATE UNIQUE INDEX IF NOT EXISTS "api_key_ip_uniq"
	ON "api_key_ip" USING btree ("api_key_id", "ip");

-- ---------------------------------------------------------------------------
-- member_warning — the auto-warn pipeline (owner rule 16).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "member_warning" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	-- What triggered it: a rate breach, an IP breach, an expiry, an abuse flag.
	"kind" text NOT NULL,
	"severity" text NOT NULL DEFAULT 'warn',
	"message" text NOT NULL,
	-- Which channels have been delivered. A jsonb array of channel names, so a
	-- new channel (email, webhook) needs no migration.
	"delivered" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"acknowledged_at" timestamptz,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "member_warning_severity_check"
		CHECK ("severity" IN ('info', 'warn', 'error')),
	CONSTRAINT "member_warning_account_id_user_id_fk"
		FOREIGN KEY ("account_id") REFERENCES "public"."user"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "member_warning_account_created_idx"
	ON "member_warning" USING btree ("account_id", "created_at" DESC);

-- ---------------------------------------------------------------------------
-- api_key: the single-key rule (owner rule 13) and the auto-restrict flag
-- (owner rule 15).
-- ---------------------------------------------------------------------------
-- `restricted_at` is set by the auto-restrict path when a key breaches a rule.
-- A restricted key authenticates but is refused at the policy gate, so the
-- member sees a clear "your key is restricted" rather than a generic 401.
ALTER TABLE "api_key" ADD COLUMN IF NOT EXISTS "restricted_at" timestamptz;
ALTER TABLE "api_key" ADD COLUMN IF NOT EXISTS "restricted_reason" text;

-- The single-key rule is enforced in the application (create refuses when an
-- active key exists), but the index makes the check O(1) and lets a future
-- partial-unique constraint be added without a scan.
CREATE INDEX IF NOT EXISTS "api_key_user_active_idx"
	ON "api_key" USING btree ("user_id")
	WHERE "revoked_at" IS NULL;
