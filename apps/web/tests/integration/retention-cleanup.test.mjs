// Pins `data_retention_cleanup`'s opt-in `credential_days` branch end-to-end:
// with `retention.credential_days = N`, `invalid` credentials older than N
// days by `updated_at` (and never referenced by `request_log`/`request_attempt`)
// are deleted; `0`/absent keeps everything forever.
//
// The same fixture rules as credential-validation.test.mjs apply:
//   - SQL uses `sql.raw` with interpolated strings, not Date params — a Date
//     nested inside a `sql` fragment gets an indeterminate parameter type
//     (42P18) — the quirk retentionBatch documents at workers.ts:800-815.
//   - The postgres client is created INSIDE the test and the handler import is
//     dynamic, because `workers.ts` transitively imports `db/index.ts`, which
//     throws at import time when DATABASE_URL is unset.
// This test only seeds/deletes rows — it never encrypts — so it guards on
// `DATABASE_URL` alone and does NOT need `CREDENTIALS_MASTER_KEY` (unlike the
// credential-validation tests, which drive the encryption+probe path).
// `credential_days` and the retention handler read `getSetting`, which uses
// the module-level pool in `db/index.ts`; `workers.ts` also reaches `jobs.ts`
// -> `vk.ts`. Both singletons' sockets keep the Node event loop alive
// (documented at db/index.ts: "closeDb"), so the runner would wait out its full
// timeout on tests that already passed — exactly the scheduler-health-cadence
// hang. They are SHARED across this file's tests, so close them exactly once in
// an `after` hook, never per-test.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

// 40 days old: comfortably past a 30-day `credential_days` cutoff.
const OLD = new Date(Date.now() - 40 * 86_400_000).toISOString();
// 5 days old: inside the 30-day window, so never aged out even if `invalid`.
const RECENT = new Date(Date.now() - 5 * 86_400_000).toISOString();

// Seeds provider/connection/credential + optional request_log/request_attempt
// reference rows, with an interpolated-`updated_at` per fixture. Returns
// nothing; the caller runs the handler and reads survivors.
async function seedFixtures(testDb) {
	await testDb.execute(sql.raw(`insert into provider (id, name, base_url, credentials_enc, status, priority, tier, enabled) values ('prov_ret', 'test', 'http://127.0.0.1:1', 'x', 'active', 100, 'commercial', true) on conflict (id) do nothing`));
	await testDb.execute(sql.raw(`insert into connection (id, provider_id, name, slug, base_url, region, auth_type, timeout_ms, priority, enabled, health_status) values ('con_ret', 'prov_ret', 'test', 'test', 'http://127.0.0.1:1', 'us', 'bearer', 30000, 100, true, 'healthy') on conflict (id) do nothing`));
	// `cred_ret_del_invalid` is the row the ON run must delete; every other
	// fixture exists to pin the guards around it.
	await testDb.execute(sql.raw(`insert into credential (id, connection_id, name, secret_enc, status, updated_at) values
		('cred_ret_del_invalid', 'con_ret', 'del', 'x', 'invalid', '${OLD}'),
		('cred_ret_keep_log', 'con_ret', 'log', 'x', 'invalid', '${OLD}'),
		('cred_ret_keep_attempt', 'con_ret', 'att', 'x', 'invalid', '${OLD}'),
		('cred_ret_keep_unknown', 'con_ret', 'unk', 'x', 'unknown', '${OLD}'),
		('cred_ret_keep_healthy', 'con_ret', 'hea', 'x', 'healthy', '${OLD}'),
		('cred_ret_keep_disabled', 'con_ret', 'dis', 'x', 'disabled', '${OLD}'),
		('cred_ret_keep_recent', 'con_ret', 'rec', 'x', 'invalid', '${RECENT}')`));
	// `request_log` has defaults for everything except id/status; `credential_id`
	// is plain text (no FK), so it can dangle or be NULL. This row protects
	// `cred_ret_keep_log` from the "never referenced" guard.
	await testDb.execute(sql.raw(`insert into request_log (id, status, credential_id) values ('req_ret_log', 'success', 'cred_ret_keep_log')`));
	// The parent request_log carries a NULL credential_id so only the attempt
	// protects `cred_ret_keep_attempt` — proving the attempt guard is checked
	// independently of its parent row.
	await testDb.execute(sql.raw(`insert into request_log (id, status, credential_id) values ('req_ret_attempt_parent', 'success', null)`));
	await testDb.execute(sql.raw(`insert into request_attempt (id, request_id, attempt, credential_id, started_at) values ('att_ret_1', 'req_ret_attempt_parent', 1, 'cred_ret_keep_attempt', '${OLD}')`));
}

async function survivingIds(testDb) {
	const rows = await testDb.execute(sql.raw(`select id from credential where id like 'cred_ret_%' order by id`));
	return new Set(rows.map((r) => r.id));
}

async function teardown(testDb, testClient) {
	await testDb.execute(sql.raw(`delete from request_attempt where id like 'att_ret_%'`));
	await testDb.execute(sql.raw(`delete from request_log where id like 'req_ret_%'`));
	await testDb.execute(sql.raw(`delete from credential where id like 'cred_ret_%'`));
	await testDb.execute(sql.raw(`delete from connection where id = 'con_ret'`));
	await testDb.execute(sql.raw(`delete from provider where id = 'prov_ret'`));
	await testClient.end({ timeout: 5000 });
}

// The retention handler reads `getSetting` through the module-level pool in
// `db/index.ts`, which the handler import created; `workers.ts` also reaches
// `jobs.ts` -> `vk.ts`. Both singletons' sockets keep the Node event loop
// alive, so node --test would wait out the full timeout. These are SHARED
// across every test in this file — close them exactly once, in `after`, never
// per-test (closing after the first test kills the pool the second test's
// handler still needs).
after(async () => {
	const { closeDb } = await import('@fudrouter/platform/server/db/index.ts');
	const { closeVk } = await import('@fudrouter/platform/server/vk.ts');
	await closeDb();
	await closeVk();
});

// The opt-in default: `credential_days` absent/0 must leave the exact same
// old, invalid, unreferenced row alone. Deletion can never be a zero-config
// accident.
test('data_retention_cleanup keeps invalid credentials when credential_days is 0', { skip: !process.env.DATABASE_URL }, async () => {
	const { JOB_HANDLERS } = await import('@fudrouter/platform/server/workers.ts');
	const testClient = postgres(process.env.DATABASE_URL);
	const testDb = drizzle(testClient, { schema: await import('@fudrouter/platform/server/db/schema.ts') });
	try {
		await testDb.execute(sql.raw(`insert into system_setting (key, value) values ('retention', '{"credential_days": 0}'::jsonb) on conflict (key) do update set value = excluded.value`));
		await seedFixtures(testDb);

		await JOB_HANDLERS.data_retention_cleanup(testDb, {});

		const ids = await survivingIds(testDb);
		assert.ok(ids.has('cred_ret_del_invalid'), 'credential_days=0 must not delete an old invalid row');
	} finally {
		await teardown(testDb, testClient);
	}
});

// The opt-in ON state. Scope pins (each one is a "must NOT delete"):
//   - `invalid` + old + unreferenced → the only row that goes.
//   - `invalid` + old but referenced by request_log or request_attempt → kept
//     (both store credential_id as plain text; pruning a referenced row would
//     leave a dangling id).
//   - `unknown` is an uncertainty verdict, not a death verdict (the validation
//     probe writes it when it cannot judge a key) → kept.
//   - `healthy`/`disabled` never match `status = 'invalid'` → kept.
//   - `invalid` but recent → outside the window → kept.
test('data_retention_cleanup deletes only old unreferenced invalid credentials when credential_days is set', { skip: !process.env.DATABASE_URL }, async () => {
	const { JOB_HANDLERS } = await import('@fudrouter/platform/server/workers.ts');
	const testClient = postgres(process.env.DATABASE_URL);
	const testDb = drizzle(testClient, { schema: await import('@fudrouter/platform/server/db/schema.ts') });
	try {
		await testDb.execute(sql.raw(`insert into system_setting (key, value) values ('retention', '{"credential_days": 30}'::jsonb) on conflict (key) do update set value = excluded.value`));
		await seedFixtures(testDb);

		await JOB_HANDLERS.data_retention_cleanup(testDb, {});

		const ids = await survivingIds(testDb);
		assert.ok(!ids.has('cred_ret_del_invalid'), 'the old invalid unreferenced row must be deleted');
		assert.ok(ids.has('cred_ret_keep_log'), 'a row referenced by request_log must be kept');
		assert.ok(ids.has('cred_ret_keep_attempt'), 'a row referenced by request_attempt must be kept');
		assert.ok(ids.has('cred_ret_keep_unknown'), 'an unknown row must be kept');
		assert.ok(ids.has('cred_ret_keep_healthy'), 'a healthy row must be kept');
		assert.ok(ids.has('cred_ret_keep_disabled'), 'a disabled row must be kept');
		assert.ok(ids.has('cred_ret_keep_recent'), 'a recent invalid row must be kept');
	} finally {
		await teardown(testDb, testClient);
	}
});
