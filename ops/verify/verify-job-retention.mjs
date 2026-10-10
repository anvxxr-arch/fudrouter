#!/usr/bin/env node
// Verify the new `job_days` retention branch end-to-end against the LIVE db.
//
// The `job` queue had no retention bound (it grows with every webhook,
// aggregation, alert and credential probe), so `data_retention_cleanup` gained a
// `job_days` window. This proves the branch actually deletes — and, more
// importantly, that it deletes ONLY terminal rows: a stale `pending`/`running`
// row is live work and must survive a retention sweep.
//
// Self-contained: it plants its own rows and removes them afterwards.
//   set -a && . .env && set +a && node scratch/verify-job-retention.mjs
import { installTsHooks, libUrl } from '/home/dwizzy/fudrouter/scripts/ts-hooks.mjs';

const { libRoot } = installTsHooks('/home/dwizzy/fudrouter/scripts');

const { db } = await import(libUrl(libRoot, 'server/db/index.ts'));
const { JOB_HANDLERS } = await import(libUrl(libRoot, 'server/workers.ts'));
const { job, systemEvent } = await import(libUrl(libRoot, 'server/db/schema.ts'));
const { eq, sql, desc } = await import('drizzle-orm');

const tag = `job_verify_${Date.now()}`;
const OLD = sql`now() - interval '40 days'`;
await db.insert(job).values([
	{ id: `${tag}_old_done`, type: 'usage_aggregation', status: 'completed', createdAt: OLD, finishedAt: OLD },
	{ id: `${tag}_old_failed`, type: 'usage_aggregation', status: 'failed', createdAt: OLD, finishedAt: OLD },
	{ id: `${tag}_old_pending`, type: 'usage_aggregation', status: 'pending', createdAt: OLD },
	{ id: `${tag}_new_done`, type: 'usage_aggregation', status: 'completed' }
]);

const alive = async (id) =>
	(await db.select({ id: job.id }).from(job).where(eq(job.id, id))).length === 1;

const before = {
	oldDone: await alive(`${tag}_old_done`),
	oldPending: await alive(`${tag}_old_pending`),
	newDone: await alive(`${tag}_new_done`)
};
console.log('before sweep:', JSON.stringify(before));

await JOB_HANDLERS.data_retention_cleanup(db, {});

const after = {
	oldDone: await alive(`${tag}_old_done`),
	oldFailed: await alive(`${tag}_old_failed`),
	oldPending: await alive(`${tag}_old_pending`),
	newDone: await alive(`${tag}_new_done`)
};
console.log('after sweep: ', JSON.stringify(after));

const [evt] = await db
	.select({ metadata: systemEvent.metadata, createdAt: systemEvent.createdAt })
	.from(systemEvent)
	.where(eq(systemEvent.type, 'data_retention_cleanup'))
	.orderBy(desc(systemEvent.createdAt))
	.limit(1);
console.log('newest retention event metadata:', JSON.stringify(evt?.metadata));

let bad = 0;
const expect = (ok, label) => {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
	if (!ok) bad += 1;
};
expect(after.oldDone === false, 'a terminal job older than job_days was deleted');
expect(after.oldFailed === false, 'a failed job older than job_days was deleted');
expect(after.oldPending === true, 'a stale PENDING job survived (never delete live work)');
expect(after.newDone === true, 'a recent terminal job survived');
expect(Number(evt?.metadata?.deletedJobs ?? 0) >= 2, 'the event records the deleted count');

// Clean up whatever survived the sweep.
await db.delete(job).where(eq(job.id, `${tag}_old_pending`));
await db.delete(job).where(eq(job.id, `${tag}_new_done`));
await db.delete(job).where(eq(job.id, `${tag}_old_done`));
await db.delete(job).where(eq(job.id, `${tag}_old_failed`));

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURE(S)`);
await db.$client.end({ timeout: 1 });
process.exit(bad === 0 ? 0 : 1);
