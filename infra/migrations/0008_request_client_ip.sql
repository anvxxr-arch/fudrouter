-- 0008_request_client_ip.sql — ADDITIVE ONLY.
--
-- Source of truth: docs/specs/2026-09-30-platform-schema.md §8.
--
-- PRD §29 lists `IP` in Request Metadata and PRD §70's abuse signals need IP
-- distribution ("unusual IP distribution", "many auth failures" per address),
-- but the 0006 request_log shape carried no client-address column — WebObserve
-- would have had to render "not recorded" for a field the PRD promises. This
-- adds the column only; the data plane populates it on every write.
--
-- `inet` rather than `text`: PostgreSQL then rejects a malformed address at
-- write time and can do subnet matching (`<<= '203.0.113.0/24'`) directly for
-- the security center, which is the only query shape that needs it.

BEGIN;

ALTER TABLE "request_log" ADD COLUMN "client_ip" inet;

-- PRD §70's IP-distribution signal scans by address over a time window; the
-- security center's other signals already have (status|project|api_key, created)
-- indexes to walk. One index, no more (PRD §149: request_log is high-write).
CREATE INDEX "request_log_client_ip_created_idx"
	ON "request_log" USING btree ("client_ip", "created_at");

COMMIT;
