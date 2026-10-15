-- Probe cursor column for `credential_validation`.
--
-- The handler (packages/platform/server/workers.ts) selects its batch with
-- `ORDER BY last_validated_at ASC NULLS FIRST, id` — least-recently-validated
-- first, which doubles as the cursor that carries progress across runs. That
-- ordering used to be on `last_used_at`, which the probe itself stamps on every
-- run: after the NULLs drained, the cursor stopped advancing and the same 250
-- rows were re-probed hourly with no progress, and the probe was also
-- rewriting the router's LRU signal on every pass. `last_validated_at` is
-- written only by this handler, so the cursor cannot be disturbed by the work
-- it orders, and the router's signal is left alone.
--
-- NULL default, not now(): existing rows must sort FIRST (NULLS FIRST) so the
-- first run after this migration validates the credentials that have never
-- been validated, instead of treating them as just-probed.
--
-- The index supports the ORDER BY + LIMIT pattern. On a populated table
-- with a mix of NULL and stamped rows, the planner can use the index to
-- seek the oldest rows without a full-table sort. On an empty or all-NULL
-- table the planner prefers a Seq Scan + Sort (the index degenerates to
-- reading everything in id order). The index is still necessary for the
-- steady-state tail where most rows are stamped and the cursor advances.
ALTER TABLE "credential" ADD COLUMN IF NOT EXISTS "last_validated_at" timestamptz;

CREATE INDEX IF NOT EXISTS "credential_last_validated_idx"
	ON "credential" USING btree ("last_validated_at" NULLS FIRST, "id");
