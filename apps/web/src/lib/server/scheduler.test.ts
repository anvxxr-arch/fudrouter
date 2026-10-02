import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

// Hermetic setup (same discipline as jobs.test.ts): the modules under test read
// their environment at import time, so it must be pinned BEFORE the first
// import — hence vi.hoisted. Runs against the dedicated `fudrouter_test`
// database and never touches Valkey.
vi.hoisted(() => {
	process.env.DATABASE_URL ??= 'postgres://fudrouter:fudrouter@127.0.0.1:5432/fudrouter_test';
	process.env.VALKEY_URL = '';
});

import { db } from '$lib/server/db';
import { connection, job, provider } from '$lib/server/db/schema';
import { newId } from '$lib/server/id';
import { JOB_TYPES, type JobHandle, type JobType } from '$lib/server/jobs';
import {
	FAN_OUT,
	PERIODIC,
	SCHEDULE,
	describeSchedule,
	schedulerTick,
	type ScheduleEntry
} from '$lib/server/scheduler';

/**
 * Isolation strategy.
 *
 * Vitest runs test FILES in parallel against one shared `fudrouter_test`, and
 * `jobs.test.ts` / `workers.test.ts` / `webhooks.test.ts` all write to the same
 * `job` table. So this file never asserts on global row counts. Instead it
 * schedules only the two job types no other test touches —
 * `statistics_aggregation` (periodic) and `provider_model_sync` (fan-out) — and
 * scopes every assertion to rows it created itself. `beforeEach` clears exactly
 * those two types, which is safe precisely because nothing else uses them.
 *
 * The alternative (assert on the real schedule) would be flaky the moment
 * another file enqueued `usage_aggregation` mid-run.
 */
const PERIODIC_TYPE: JobType = 'statistics_aggregation';
const FANOUT_TYPE: JobType = 'provider_model_sync';
const HOUR = 3_600_000;

const ONE_PERIODIC: ScheduleEntry[] = [{ kind: 'periodic', type: PERIODIC_TYPE, everyMs: HOUR }];
const ONE_FANOUT: ScheduleEntry[] = [
	{ kind: 'fanOut', type: FANOUT_TYPE, everyMs: HOUR, scope: 'provider', payloadKey: 'providerId' }
];
const ONE_CONN_FANOUT: ScheduleEntry[] = [
	{
		kind: 'fanOut',
		type: 'credential_validation',
		everyMs: HOUR,
		scope: 'connection',
		payloadKey: 'connectionId'
	}
];

async function clear() {
	await db
		.delete(job)
		.where(inArray(job.type, [PERIODIC_TYPE, FANOUT_TYPE, 'credential_validation']));
}

beforeEach(clear);

afterAll(async () => {
	await clear();
	await db.delete(provider).where(eq(provider.credentialsEnc, 'scheduler-test'));
	await db.$client.end({ timeout: 1 });
});

/** Insert a job row directly so its timestamps are controllable. */
async function seedJob(
	type: JobType,
	status: string,
	at: Date,
	payload: Record<string, unknown> = {}
) {
	await db.insert(job).values({
		id: newId('job_'),
		type,
		payload,
		status,
		attempts: 1,
		maxAttempts: 5,
		availableAt: at,
		startedAt: status === 'pending' ? null : at,
		finishedAt: status === 'pending' || status === 'running' ? null : at,
		createdAt: at
	});
}

async function seedConnection(providerId: string, enabled: boolean): Promise<string> {
	const id = newId('con_');
	await db.insert(connection).values({
		id,
		providerId,
		name: `Scheduler test ${id}`,
		slug: id,
		baseUrl: 'http://127.0.0.1:1/v1',
		enabled
	});
	return id;
}

async function seedProvider(enabled: boolean): Promise<string> {
	const id = newId('prv_');
	await db.insert(provider).values({
		id,
		name: `Scheduler test ${id}`,
		baseUrl: 'http://127.0.0.1:1/v1',
		credentialsEnc: 'scheduler-test',
		enabled
	});
	return id;
}

it('enqueues a periodic type that has never run, and the row is claimable', async () => {
	const result = await schedulerTick(db, new Date(), ONE_PERIODIC);

	expect(result.enqueued.map((e) => e.type)).toEqual([PERIODIC_TYPE]);
	expect(result.enqueued[0].reason).toBe('first-run');

	const rows = await db
		.select({ id: job.id, status: job.status, maxAttempts: job.maxAttempts })
		.from(job)
		.where(eq(job.type, PERIODIC_TYPE));
	expect(rows).toHaveLength(1);
	expect(rows[0].id).toBe(result.enqueued[0].id);
	expect(rows[0].status).toBe('pending');
	// The default max_attempts the handlers rely on for retry.
	expect(rows[0].maxAttempts).toBe(5);
});

it('skips a periodic type that already has a pending occurrence', async () => {
	await seedJob(PERIODIC_TYPE, 'pending', new Date());

	const result = await schedulerTick(db, new Date(), ONE_PERIODIC);

	expect(result.enqueued).toHaveLength(0);
	expect(result.skipped).toEqual([{ type: PERIODIC_TYPE, reason: 'in-flight' }]);
});

it('treats a running occurrence as in flight as well', async () => {
	await seedJob(PERIODIC_TYPE, 'running', new Date());

	const result = await schedulerTick(db, new Date(), ONE_PERIODIC);

	expect(result.skipped).toEqual([{ type: PERIODIC_TYPE, reason: 'in-flight' }]);
});

it('does not re-enqueue before the interval has elapsed since the last finish', async () => {
	const now = new Date();
	await seedJob(PERIODIC_TYPE, 'completed', new Date(now.getTime() - 1_000));

	const result = await schedulerTick(db, now, ONE_PERIODIC);

	expect(result.enqueued).toHaveLength(0);
	expect(result.skipped).toEqual([{ type: PERIODIC_TYPE, reason: 'not-due' }]);
});

/**
 * Negative control for the in-flight test above: the SAME single row for the
 * type, with only `status` flipped from `pending` to `completed`. If the guard
 * were really "some row exists", this would still report `in-flight`; it must
 * instead move to `not-due`. That is what proves the guard reads the status.
 */
it('the in-flight guard keys on status, not on a row merely existing', async () => {
	const now = new Date();
	await seedJob(PERIODIC_TYPE, 'completed', new Date(now.getTime() - 1_000));

	const result = await schedulerTick(db, now, ONE_PERIODIC);

	expect(result.skipped).not.toContainEqual({ type: PERIODIC_TYPE, reason: 'in-flight' });
});

it('enqueues again once the interval has elapsed since the last finish', async () => {
	const now = new Date();
	await seedJob(PERIODIC_TYPE, 'completed', new Date(now.getTime() - 2 * HOUR));

	const result = await schedulerTick(db, now, ONE_PERIODIC);

	expect(result.enqueued.map((e) => e.reason)).toEqual(['due']);
});

it('fans out to every enabled provider, skipping the disabled and the in-flight', async () => {
	const now = new Date();
	const due = await seedProvider(true);
	const busy = await seedProvider(true);
	const off = await seedProvider(false);
	await seedJob(FANOUT_TYPE, 'pending', now, { providerId: busy });

	const result = await schedulerTick(db, now, ONE_FANOUT);

	const mine = result.enqueued
		.filter((e) => e.reason.startsWith('provider '))
		.map((e) => e.reason)
		.filter((r) => [due, busy, off].includes(r.slice('provider '.length)));
	expect(mine).toEqual([`provider ${due}`]);

	// The job carries the providerId the handler requires — it throws without it.
	const rows = await db
		.select({ payload: job.payload })
		.from(job)
		.where(eq(job.type, FANOUT_TYPE));
	const mineRows = rows.filter((r) => (r.payload as { providerId?: string }).providerId === due);
	expect(mineRows).toHaveLength(1);
});

it('does not re-fan-out to a provider synced inside the interval', async () => {
	const now = new Date();
	const fresh = await seedProvider(true);
	await seedJob(FANOUT_TYPE, 'completed', new Date(now.getTime() - 1_000), { providerId: fresh });

	const result = await schedulerTick(db, now, ONE_FANOUT);

	expect(result.enqueued.map((e) => e.reason)).not.toContain(`provider ${fresh}`);
});

it('fans out per enabled connection for a connection-scoped entry', async () => {
	// `credential_validation` is connection-scoped because the un-scoped form
	// probed all ~12k credentials in one job. This exercises the scope switch
	// in the SQL (table + payload key), which the provider tests do not.
	const now = new Date();
	const owner = await seedProvider(true);
	const on = await seedConnection(owner, true);
	const off = await seedConnection(owner, false);

	const result = await schedulerTick(db, now, ONE_CONN_FANOUT);

	const mine = result.enqueued
		.filter((e) => [on, off].some((id) => e.reason === `connection ${id}`))
		.map((e) => e.reason);
	expect(mine).toEqual([`connection ${on}`]);

	const rows = await db
		.select({ payload: job.payload })
		.from(job)
		.where(eq(job.type, 'credential_validation'));
	expect(rows.filter((r) => (r.payload as { connectionId?: string }).connectionId === on)).toHaveLength(1);
});

/**
 * Regression guard for a real outage this work uncovered: as a PERIODIC job,
 * `credential_validation` looped over every credential (~12k) in a single row,
 * one upstream probe each. At the fleet's default concurrency of 1 that held
 * every other job behind it for hours. It must stay a per-connection fan-out.
 */
it('never schedules credential_validation as one unbounded periodic job', () => {
	expect(PERIODIC.map((e) => e.type)).not.toContain('credential_validation');
	const entry = SCHEDULE.find((e) => e.type === 'credential_validation');
	expect(entry?.kind).toBe('fanOut');
	expect(entry && entry.kind === 'fanOut' ? entry.scope : null).toBe('connection');
	expect(entry && entry.kind === 'fanOut' ? entry.payloadKey : null).toBe('connectionId');
});

/**
 * The schedule-completeness guard: add a PRD §76 job type and forget to
 * schedule it, and this goes red. `pricing_sync` is the one deliberate
 * exception — its payload carries the proposed rules, so the bare form loops
 * over an empty array and scheduling it would manufacture no-op rows.
 */
it('schedules every PRD job type except the event-driven pricing_sync', () => {
	const scheduled = SCHEDULE.map((e) => e.type).sort();
	const expected = JOB_TYPES.filter((t) => t !== 'pricing_sync').sort();
	expect(scheduled).toEqual([...expected]);
	expect(SCHEDULE.map((e) => e.type)).not.toContain('pricing_sync');
});

it('describes every schedule entry exactly once', () => {
	const lines = describeSchedule();
	expect(lines).toHaveLength(SCHEDULE.length);
	expect(new Set(lines).size).toBe(SCHEDULE.length);
	expect(PERIODIC.length + FAN_OUT.length).toBe(SCHEDULE.length);
});

it('produces a JobHandle-shaped handle the entrypoint can pass', async () => {
	// Compile-time contract: schedulerTick's second argument is a JobHandle,
	// which is what scripts/scheduler.mjs relies on. `db` satisfies it.
	const handle: JobHandle = db;
	const result = await schedulerTick(handle, new Date(), ONE_PERIODIC);
	expect(result.enqueued).toHaveLength(1);
});
