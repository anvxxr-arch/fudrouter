-- Configurable cadence for the provider health-check job (PRD §76).
--
-- The cadence used to be a hardcoded 5 minutes in scheduler.ts, so tightening
-- detection needed a code change and a deploy. Seeded at 300000 — exactly the
-- value the constant carried — so an existing database behaves identically
-- until an operator changes it.
--
-- DO NOTHING, not DO UPDATE: a re-run must never overwrite a value someone
-- chose in the console.
INSERT INTO "system_setting" ("key", "value") VALUES
	('provider_health_check', '{"everyMs": 300000}'::jsonb)
ON CONFLICT ("key") DO NOTHING;
