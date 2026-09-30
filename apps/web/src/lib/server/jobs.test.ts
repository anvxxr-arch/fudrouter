import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

// Hermetic setup (same discipline as credentials.test.ts): the modules under
// test read their environment at import time through `$env/dynamic/private`,
// so it must be pinned BEFORE the first import — hence vi.hoisted. The tests
// run against the dedicated `fudrouter_test` database (same migrations as
// dev) and never touch Valkey, so their result cannot depend on what is or
// is not running on the box.
vi.hoisted(() => {
	process.env.DATABASE_URL ??= 'postgres://fudrouter:fudrouter@127.0.0.1:5432/fudrouter_test';
	process.env.VALKEY_URL = '';
});

import { db } from '$lib/server/db';
import { job } from '$lib/server/db/schema';
import {
	BACKOFF_BASE_MS,
	backoffMs,
	cancelJob,
	claimJobs,
	completeJob,
	enqueue,
	failJob,
	type JobType
} from '$lib/server/jobs';

const TYPES: JobType[] = ['usage_aggregation', 'alert_evaluation'];

beforeEach(async () => {
	await db.delete(job).where(sql`${job.id} like 'job\\_%'`);
});

afterAll(async () => {
	await db.delete(job).where(sql`${job.id} like 'job\\_%'`);
	await db.$client.end({ timeout: 1 });
});

it('enqueue inserts a pending job claimJobs can hand out', async () => {
	const id = await enqueue('usage_aggregation', { from: 'x' }, { maxAttempts: 3 });
	const claimed = await claimJobs(['usage_aggregation'], 5);
	expect(claimed.map((c) => c.id)).toEqual([id]);
	expect(claimed[0].status).toBe('running');
	expect(claimed[0].attempts).toBe(1);
	expect(claimed[0].maxAttempts).toBe(3);
	expect(claimed[0].payload).toEqual({ from: 'x' });
});

it('concurrent claimers never receive the same job', async () => {
	const ids = [];
	for (let i = 0; i < 6; i++) {
		ids.push(await enqueue(TYPES[i % 2], { n: i }));
	}
	// Two workers racing on the same queue, each asking for the whole batch.
	const [a, b] = await Promise.all([claimJobs(TYPES, 6), claimJobs(TYPES, 6)]);
	const seen = [...a, ...b].map((c) => c.id);
	expect(new Set(seen).size).toBe(ids.length);
	for (const id of ids) expect(seen).toContain(id);
});

it('a single job is handed to exactly one of two racing claimers', async () => {
	const id = await enqueue('alert_evaluation', {});
	const [a, b] = await Promise.all([
		claimJobs(['alert_evaluation'], 1),
		claimJobs(['alert_evaluation'], 1)
	]);
	const holders = [a, b].filter((batch) => batch.length > 0);
	expect(holders).toHaveLength(1);
	expect(holders[0][0].id).toBe(id);
});

it('only claims jobs of the requested types and only once', async () => {
	const wanted = await enqueue('usage_aggregation', {});
	await enqueue('alert_evaluation', {});
	const first = await claimJobs(['usage_aggregation'], 10);
	expect(first.map((c) => c.id)).toEqual([wanted]);
	const second = await claimJobs(['usage_aggregation'], 10);
	expect(second).toEqual([]);
});

it('failJob retries with exponential backoff, then marks the job failed', async () => {
	const id = await enqueue('usage_aggregation', {}, { maxAttempts: 2 });

	let [claimed] = await claimJobs(['usage_aggregation'], 1);
	expect(claimed.attempts).toBe(1);
	const beforeRetry = Date.now();
	await failJob(id, 'boom 1');
	let row = (await db.select().from(job).where(eq(job.id, id)))[0];
	expect(row.status).toBe('pending');
	expect(row.error).toBe('boom 1');
	const wait1 = row.availableAt.getTime() - beforeRetry;
	// First retry waits one backoff step (base)…
	expect(wait1).toBeGreaterThanOrEqual(BACKOFF_BASE_MS - 5000);
	expect(wait1).toBeLessThanOrEqual(backoffMs(1) + 5000);

	// …simulate the backoff elapsing, then burn the final attempt.
	await db.update(job).set({ availableAt: new Date(Date.now() - 1000) }).where(eq(job.id, id));
	[claimed] = await claimJobs(['usage_aggregation'], 1);
	expect(claimed.attempts).toBe(2);
	await failJob(id, 'boom 2');
	row = (await db.select().from(job).where(eq(job.id, id)))[0];
	// Terminal failure: no retry window is scheduled.
	expect(row.status).toBe('failed');
	expect(row.error).toBe('boom 2');
	expect(row.finishedAt).not.toBeNull();
	expect(row.availableAt.getTime()).toBeLessThanOrEqual(Date.now());
});

it('failJob reschedules with growing backoff while attempts remain', async () => {
	const id = await enqueue('usage_aggregation', {}, { maxAttempts: 3 });
	await claimJobs(['usage_aggregation'], 1);
	await failJob(id, 'first');
	const first = (await db.select().from(job).where(eq(job.id, id)))[0];
	await db.update(job).set({ availableAt: new Date(Date.now() - 1000) }).where(eq(job.id, id));
	await claimJobs(['usage_aggregation'], 1);
	await failJob(id, 'second');
	const second = (await db.select().from(job).where(eq(job.id, id)))[0];
	expect(second.status).toBe('pending');
	// 30s then 60s: the gap between scheduled retries grows.
	expect(second.availableAt.getTime() - first.availableAt.getTime()).toBeGreaterThan(15_000);
});

it('completeJob settles a running job and cancelJob stops a pending one', async () => {
	const done = await enqueue('usage_aggregation', {});
	const claimed = await claimJobs(['usage_aggregation'], 1);
	expect(claimed[0].id).toBe(done);
	await completeJob(done);
	const finished = (await db.select().from(job).where(eq(job.id, done)))[0];
	expect(finished.status).toBe('completed');
	expect(finished.finishedAt).not.toBeNull();

	const doomed = await enqueue('alert_evaluation', {});
	await cancelJob(doomed);
	const cancelled = (await db.select().from(job).where(eq(job.id, doomed)))[0];
	expect(cancelled.status).toBe('cancelled');
	expect(await claimJobs(['alert_evaluation'], 1)).toEqual([]);
});

it('rejects unknown job types at enqueue time', async () => {
	await expect(enqueue('not_a_job_type' as JobType, {})).rejects.toThrow(/unknown job type/);
});
