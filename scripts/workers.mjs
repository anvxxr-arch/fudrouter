#!/usr/bin/env node
// scripts/workers.mjs — worker-fleet entrypoint (PRD §75–76).
//
// Runs `src/lib/server/workers.ts` (TypeScript) under plain `node`: the worker
// shares the control plane's modules (`db`, `vk`, `credentials`, `jobs`, …) and
// duplicating them in JS would drift within a week — the same reasoning as
// `scripts/verify-*.mjs`, which imports `credentials.ts` through Node's type
// stripping. Here we register synchronous module hooks so the whole `$lib/*`
// graph resolves and strips (the `$lib` alias and `$app/*` shims are needed
// because those modules were written for the SvelteKit/Vite resolver).
//
// Usage: node --env-file=.env scripts/workers.mjs
//   WORKER_TYPES=usage_aggregation,alert_evaluation   # subset of job types
//   WORKER_CONCURRENCY=4                             # jobs in flight per loop
//   WORKER_IDLE_SLEEP_MS=2000                        # poll interval when empty
//
// Lifecycle: SIGTERM/SIGINT stops claiming, waits for in-flight handlers to
// settle their job rows (a job is never abandoned `running`), then closes the
// PostgreSQL pool so the process exits.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installTsHooks, libUrl } from './ts-hooks.mjs';

const scriptRoot = dirname(fileURLToPath(import.meta.url));
// The resolver hooks live in ts-hooks.mjs, shared with scripts/scheduler.mjs —
// one copy, so a new `$lib` alias cannot be learned by one entrypoint and not
// the other. They must be installed before the TS graph is imported below.
const { libRoot } = installTsHooks(scriptRoot);

if (!process.env.DATABASE_URL) {
	console.error('missing env: DATABASE_URL');
	process.exit(1);
}

const types = (process.env.WORKER_TYPES ?? '')
	.split(',')
	.map((t) => t.trim())
	.filter(Boolean);
const { createWorker } = await import(
	libUrl(libRoot, 'server/workers.ts')
);
const { db } = await import(libUrl(libRoot, 'server/db/index.ts'));

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
