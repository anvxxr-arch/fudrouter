-- Spend fallback for the environment scope (spec §7: the Valkey spend counter
-- is the fast path, the DB sum is authoritative on a counter miss).
--
-- Every other spend scope already has its (scope, created_at) index
-- (request_log_workspace_created_idx, request_log_project_created_idx,
-- request_log_api_key_created_idx); environment was the gap. Measured on the
-- live table: environment Seq Scan 28ms vs workspace index scan 0.5ms for the
-- same month-sum shape. Plain CREATE INDEX (not CONCURRENTLY): the table is
-- small and migrations run inside a transaction, where CONCURRENTLY is
-- forbidden.
CREATE INDEX IF NOT EXISTS "request_log_environment_created_idx"
	ON "request_log" USING btree ("environment_id", "created_at");
