// packages/platform/test/jobs.test.mjs — the job queue's enqueue boundary.
//
// Why this file exists: `enqueue` is the single choke point every proof that
// the queue stays self-describing passes through. Three invitations to a
// forever-parked row are now rejected at that boundary:
//
//   1. a typo'd `type` — `enqueue` validates against `JOB_TYPES` (PRD §76), so
//      a misspelling throws instead of becoming a `pending` row no handler
//      ever matches (`requeueStaleJobs` later fails a stale `running` orphan
//      of this shape, so direct INSERTs cannot hide it either);
//   2. `maxAttempts < 1` — a zero-attempt row can never be claimed again, and
//      `failJob`'s `attempts >= maxAttempts` would fail it on the FIRST try,
//      so the row is just dead weight with a confusing error;
//   3. a NaN `availableAt` — `available_at <= now()` is false forever, so the
//      row is parked before it is ever eligible.
//
// `backoffMs` is pinned too, because it is the one number every retry (webhook
// delivery included) derives its schedule from.
//
// The rows are never actually inserted: each case asserts the throw happens
// BEFORE the handle is touched (`insertCalls === 0`), which is the "loud at
// enqueue time, not discovered dead later" contract.
//
// Run: node --test packages/platform/test/jobs.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// jobs.ts → db/index.ts opens a postgres() pool that keeps the runner alive;
// point it at a nonexistent endpoint (lazily connected, never queried here)
// and close it when the module finishes.
process.env.DATABASE_URL ??= 'postgres://u:p@127.0.0.1:1/nope';

const { enqueue, backoffMs, BACKOFF_BASE_MS, BACKOFF_MAX_MS, JOB_TYPES } = await import(
	'../server/jobs.ts'
);
const { closeDb } = await import('../server/db/index.ts');

after(async () => {
	await closeDb();
});

/** A handle whose `insert` records that it was reached and never talks to a DB. */
function fakeHandle() {
	let insertCalls = 0;
	let inserted = null;
	const handle = {
		insertCalls: () => insertCalls,
		inserted: () => inserted,
		insert: () => ({
			values: async (vals) => {
				insertCalls += 1;
				inserted = vals;
				return [];
			}
		})
	};
	return handle;
}

const VALID_TYPE = JOB_TYPES[0];

// --- type validation ----------------------------------------------------------

test('enqueue: a typo type throws before touching the handle', async () => {
	const handle = fakeHandle();
	await assert.rejects(
		() => enqueue('billing_aggregatoin', {}, {}, handle),
		/unknown job type/
	);
	assert.equal(handle.insertCalls(), 0, 'nothing is inserted for a typo');
});

test('enqueue: an arbitrary string type is rejected, not coerced', async () => {
	const handle = fakeHandle();
	await assert.rejects(() => enqueue('__proto__', {}, {}, handle), /unknown job type/);
	assert.equal(handle.insertCalls(), 0);
});

test('enqueue: a known type inserts a pending row at the default attempts', async () => {
	const handle = fakeHandle();
	const id = await enqueue(VALID_TYPE, { k: 1 }, {}, handle);
	assert.match(id, /^job_/);
	assert.equal(handle.insertCalls(), 1);
	const row = handle.inserted();
	assert.equal(row.type, VALID_TYPE);
	assert.equal(row.status, 'pending');
	assert.equal(row.attempts, 0);
	assert.equal(row.maxAttempts, 5, 'default max attempts');
	assert.ok(row.availableAt instanceof Date);
});

// --- poison option validation -------------------------------------------------

test('enqueue: maxAttempts below 1 throws before touching the handle', async () => {
	for (const bad of [0, -1, 0.5]) {
		const handle = fakeHandle();
		await assert.rejects(
			() => enqueue(VALID_TYPE, {}, { maxAttempts: bad }, handle),
			/maxAttempts must be >= 1/
		);
		assert.equal(handle.insertCalls(), 0, `maxAttempts=${bad} must not insert`);
	}
});

test('enqueue: a NaN availableAt throws before touching the handle', async () => {
	const handle = fakeHandle();
	await assert.rejects(
		() => enqueue(VALID_TYPE, {}, { availableAt: new Date(NaN) }, handle),
		/availableAt must be a valid Date/
	);
	assert.equal(handle.insertCalls(), 0);
});

test('enqueue: a valid future availableAt and maxAttempts are honoured', async () => {
	const handle = fakeHandle();
	const at = new Date(Date.now() + 60_000);
	await enqueue(VALID_TYPE, {}, { maxAttempts: 1, availableAt: at }, handle);
	const row = handle.inserted();
	assert.equal(row.maxAttempts, 1);
	assert.equal(row.availableAt.getTime(), at.getTime());
});

// --- backoff ------------------------------------------------------------------

test('backoffMs doubles per attempt and caps at BACKOFF_MAX_MS', () => {
	assert.equal(backoffMs(1), BACKOFF_BASE_MS);
	assert.equal(backoffMs(2), BACKOFF_BASE_MS * 2);
	assert.equal(backoffMs(3), BACKOFF_BASE_MS * 4);
	assert.equal(backoffMs(0), BACKOFF_BASE_MS, 'attempts below 1 clamp to the base');
	assert.equal(backoffMs(-5), BACKOFF_BASE_MS, 'negative attempts clamp to the base');
	assert.ok(backoffMs(Number.MAX_SAFE_INTEGER) <= BACKOFF_MAX_MS, 'cap holds');
});