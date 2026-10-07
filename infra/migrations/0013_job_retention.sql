-- Job-queue retention.
--
-- `job` is an internal queue and every periodic/fan-out task writes one row:
-- webhook deliveries, alert evaluations, aggregations, credential probes and
-- health checks together added ~3-4k rows/day with nothing ever deleting them.
-- `data_retention_cleanup` covers `request_log`, `system_event` and `audit_log`
-- but not `job`, so the table only grew.
--
-- The retention setting was seeded in 0007 WITHOUT a `job_days` key, and the
-- cleanup handler reads the STORED row rather than a code default, so the new
-- deletion branch would read 0 (keep forever) unless the key is merged in. Merge
-- it in place and leave any operator edit to the other windows untouched.
--
-- Idempotent: re-running finds `job_days` present and changes nothing.
UPDATE "system_setting"
SET "value" = "value" || '{"job_days": 30}'::jsonb,
    "updated_at" = now()
WHERE "key" = 'retention'
  AND NOT ("value" ? 'job_days');
