-- Hourly truth poll for `model_status_poll` (packages/platform/server/workers.ts).
--
-- The problem it records: `/v1/models` advertises a catalogue gated on LIVE
-- credentials, but a published model can still fail a real completion probe —
-- dead upstream, revoked key that has not aged into cooldown yet, slug drift.
-- "Published" counts what the router claims; only "worked" counts what a user
-- can actually use. One row per hourly run keeps both numbers and the gap
-- between them, so "percuma ada tapi gabisa dipake" is a query, not a guess.
--
-- Append-only like model_verification: a snapshot is evidence from a point in
-- time. `failures` is capped at the first 100 rows by the handler — the
-- aggregate columns are the record, the list is a debugging aid.
CREATE TABLE "model_status_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"published" integer NOT NULL,
	"worked" integer NOT NULL,
	"failed" integer NOT NULL,
	"fail_breakdown" jsonb NOT NULL DEFAULT '{}',
	"failures" jsonb NOT NULL DEFAULT '[]',
	"worked_p50_ms" integer,
	"worked_max_ms" integer,
	"duration_ms" integer NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "model_status_snapshot_created_idx" ON "model_status_snapshot"
	USING btree ("created_at" DESC);
