-- 0038_subscription_payment_id_uniq.sql — one subscription per payment.
--
-- WHY (FR-revised §7.3 "Uang = integer + ledger + idempoten", S3): a replayed
-- settlement must never stack a second window for the same payment. The Go
-- writer `GrantSubscription` already re-reads before insert (the sequential
-- case), but two concurrent callbacks for the same payment_id both see "not
-- granted yet" and both insert — the durable UNIQUE partial index below is the
-- stopper that makes the race impossible. `payment_id` is NULL for an admin
-- comp, which is deliberately NOT idempotent (NULLs are distinct in a unique
-- index), so the partial predicate restricts the uniqueness to real payments.
--
-- This mirrors the idempotency the ledger already relies on (`credit_ledger`
-- unique `idempotency_key`, migration 0016) and the payment table's own
-- `payment_gateway_ref_uniq`. Before this index the only guard was the in-flight
-- re-read, so a double callback could mint two `sub_…` rows and two keys.
--
-- IDEMPOTENT: `CREATE UNIQUE INDEX IF NOT EXISTS` converges on a replay.
--
-- ROLLBACK: ops/rollback/0038_subscription_payment_id_uniq.rollback.sql drops
-- exactly this index.

CREATE UNIQUE INDEX IF NOT EXISTS "subscription_payment_id_uniq"
	ON "subscription" USING btree ("payment_id")
	WHERE "payment_id" IS NOT NULL;