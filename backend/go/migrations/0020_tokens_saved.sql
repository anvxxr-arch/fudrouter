-- 0020_tokens_saved.sql — the metered token-compression saving.
--
-- The data plane compresses oversized tool results before dispatch
-- (internal/proxy/compress.go). Recording the saving per request is what makes
-- the feature a PRODUCT claim rather than a tweak: the customer can see what
-- compression bought them, on the same row that carries the charge.
--
-- It is an ESTIMATE (the provider's tokenizer is not exposed), so it is kept
-- strictly separate from tokens_in/tokens_out, which are the provider's reported
-- usage and the only numbers the bill may be computed from. A reader can tell
-- them apart by name and by column, and nothing multiplies tokens_saved by a
-- price.
--
-- NOT NULL DEFAULT 0, not nullable: "no compression ran" and "compression saved
-- nothing" are the same fact for every consumer, and a NULL would force each of
-- them to decide what it meant. This differs from total_tokens (PRD §122), where
-- NULL genuinely means "the provider did not report" — a distinction a saving of
-- zero does not need.
ALTER TABLE "request_log"
	ADD COLUMN IF NOT EXISTS "tokens_saved" bigint NOT NULL DEFAULT 0;
