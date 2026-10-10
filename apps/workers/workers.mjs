#!/usr/bin/env node
// apps/workers/workers.mjs — worker-fleet entrypoint (PRD §75–76).
//
// Runs `packages/platform/server/workers.ts` (TypeScript) under plain `node`, by
// importing it through the package's own exports map: Node >= 22.18 strips the
// types and every module in packages/platform reaches its siblings with an
// explicit `.ts` extension, so plain node resolves the whole graph unaided. The
// module hook that used to do both (packages/platform/ts-hooks.mjs) is gone: it
// had to be installed by every entrypoint before the first import, so an
// entrypoint that forgot it failed at runtime instead of at build time.
//
// Usage: node --env-file=.env apps/workers/workers.mjs
//   WORKER_TYPES=usage_aggregation,alert_evaluation   # subset of job types
//   WORKER_CONCURRENCY=4                             # jobs in flight per loop
//   WORKER_IDLE_SLEEP_MS=2000                        # poll interval when empty
//
// Lifecycle: SIGTERM/SIGINT stops claiming, waits for in-flight handlers to
// settle their job rows (a job is never abandoned `running`), then closes the
// PostgreSQL pool so the process exits.
if (!process.env.DATABASE_URL) {
	console.error('missing env: DATABASE_URL');
	process.exit(1);
}

const types = (process.env.WORKER_TYPES ?? '')
	.split(',')
	.map((t) => t.trim())
	.filter(Boolean);
const { createWorker } = await import('@fudrouter/platform/server/workers.ts');
const { db } = await import('@fudrouter/platform/server/db/index.ts');

const worker = createWorker({
	types: types.length > 0 ? types : undefined,
	concurrency: Number(process.env.WORKER_CONCURRENCY ?? 1),
	idleSleepMs: Number(process.env.WORKER_IDLE_SLEEP_MS ?? 2000),
	onEvent: ({ id, type, outcome, error }) =>
		console.log(`[workers] ${type} ${id} -> ${outcome}${error ? `: ${error}` : ''}`)
});

console.log(`[workers] starting (types: ${types.length > 0 ? types.join(', ') : 'all'})`);
const loop = worker.run();

let stopping = false;
async function shutdown(signal) {
	if (stopping) return;
	stopping = true;
	console.log(`[workers] ${signal} — draining in-flight jobs`);
	await worker.stop();
	await db.$client.end({ timeout: 5 });
	console.log('[workers] stopped');
	process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await loop;
