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
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const webRoot = resolvePath(scriptRoot, '..', 'apps', 'web');
const libRoot = join(webRoot, 'src', 'lib');

registerHooks({
	resolve(specifier, context, nextResolve) {
		let spec = specifier;
		if (spec.startsWith('$lib/')) spec = pathToFileURL(join(libRoot, spec.slice(5))).href;
		else if (spec === '$lib') spec = pathToFileURL(libRoot).href;
		else if (spec.startsWith('$app/')) {
			// The job handlers never touch SvelteKit app modules, but a transitive
			// import might; answering with an empty module keeps the fleet alive.
			spec = pathToFileURL(join(scriptRoot, 'app-shim.mjs')).href;
		} else if (spec.startsWith('$env/')) {
			spec = pathToFileURL(join(scriptRoot, 'env-shim.mjs')).href;
		}
		try {
			return nextResolve(spec, context);
		} catch (err) {
			// Extension-less relative/absolute TS imports (`./jobs`, `$lib/server/db`).
			if (/\.(ts|js)$/.test(spec) || spec.includes('node:')) throw err;
			for (const ext of ['.ts', '/index.ts', '.js', '/index.js']) {
				try {
					return nextResolve(spec + ext, context);
				} catch {
					// keep trying
				}
			}
			throw err;
		}
	},
	load(url, context, nextLoad) {
		if (url.endsWith('.ts')) {
			const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), {
				mode: 'strip'
			});
			return { format: 'module', source, shortCircuit: true };
		}
		return nextLoad(url, context);
	}
});

if (!process.env.DATABASE_URL) {
	console.error('missing env: DATABASE_URL');
	process.exit(1);
}

const types = (process.env.WORKER_TYPES ?? '')
	.split(',')
	.map((t) => t.trim())
	.filter(Boolean);
const { createWorker } = await import(
	pathToFileURL(join(webRoot, 'src', 'lib', 'server', 'workers.ts')).href
);
const { db } = await import(pathToFileURL(join(webRoot, 'src', 'lib', 'server', 'db', 'index.ts')).href);

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
