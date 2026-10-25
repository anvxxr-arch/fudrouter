// apps/web/tests/integration/scheduler-health-cadence.test.mjs
//
// The resolver path: a cadence read at TICK time, not at boot.
//
// The clamp itself is unit-tested in packages/platform/test (no database
// needed). What is left to prove is the part that actually changes behaviour:
// that `schedulerTick` consults the resolver for a periodic entry, and that a
// tighter cadence makes a job due sooner than its constant would allow. A
// setting read once at startup would pass the clamp tests and still be wrong,
// which is the failure this file exists to catch.
//
// Run: node --test apps/web/tests/integration/ (needs DATABASE_URL)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';

const SKIP = !process.env.DATABASE_URL;

test('a tighter cadence makes provider_health_check due sooner', { skip: SKIP }, async () => {
	const { schedulerTick, SCHEDULE } = await import('@fudrouter/platform/server/scheduler.ts');
	const schema = await import('@fudrouter/platform/server/db/schema.ts');
	const client = postgres(process.env.DATABASE_URL);
	const db = drizzle(client, { schema });

	// One entry, so the tick's other jobs cannot enqueue and pollute the
	// assertion. `schedule` is injectable for exactly this.
	const entry = SCHEDULE.find((e) => e.type === 'provider_health_check');
	assert.ok(entry, 'provider_health_check must be a scheduled entry');
	assert.equal(entry.kind, 'periodic', 'it is a periodic entry, not a fan-out');

	const MARK = 'schc_test';
	await db.execute(sql.raw(`delete from job where type = 'provider_health_check'`));

	try {
		// Seed a run that finished 90 seconds ago. Against the 5-minute
		// constant that is NOT due; against a 1-minute cadence it IS.
		await db.execute(sql.raw(`
			insert into job (id, type, status, payload, created_at, finished_at)
			values ('${MARK}_prev', 'provider_health_check', 'completed', '{}', now() - interval '90 seconds', now() - interval '90 seconds')
		`));
		const now = new Date();

		// 1. Default cadence (no resolver): must skip.
		const skipped = await schedulerTick(db, now, [entry]);
		assert.deepEqual(
			skipped.enqueued.filter((e) => e.type === 'provider_health_check'),
			[],
			'a 90s-old run is not due at the 5-minute constant'
		);
		assert.ok(
			skipped.skipped.some((s) => s.type === 'provider_health_check' && s.reason === 'not-due'),
			'and it is skipped as not-due, not as in-flight'
		);

		// 2. Resolver returning 60s: must enqueue.
		const enqueued = await schedulerTick(db, now, [entry], async (type, fallback) => {
			assert.equal(type, 'provider_health_check');
			assert.equal(fallback, entry.everyMs, 'the resolver receives the constant as its fallback');
			return 60_000;
		});
		assert.equal(
			enqueued.enqueued.filter((e) => e.type === 'provider_health_check').length,
			1,
			'the same 90s-old run IS due once the cadence is 1 minute'
		);

		// 3. The resolver is not consulted for other types, and a non-configurable
		//    type keeps its constant.
		const seen = [];
		await schedulerTick(db, new Date(), SCHEDULE, async (type, fallback) => {
			seen.push(type);
			return fallback;
		});
		assert.ok(
			seen.every((t) => t === 'provider_health_check'),
			`only provider_health_check may be resolved, saw: ${seen.join(', ')}`
		);
	} finally {
		await db.execute(sql.raw(`delete from job where id like '${MARK}%'`));
		await db.execute(sql.raw(`delete from job where type = 'provider_health_check'`));
		await client.end({ timeout: 5 });
	}
});
