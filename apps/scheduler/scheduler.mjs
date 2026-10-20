#!/usr/bin/env node
// apps/scheduler/scheduler.mjs — the periodic scheduler entrypoint (PRD §75–76).
//
// The worker fleet (`apps/workers/workers.mjs`) drains `job` rows but nothing
// produced the recurring ones; this process is that producer. It is a separate
// PM2 app on purpose: a crash or a slow tick here must never take the drain
// loop down with it, and the two have different restart semantics.
//
// Single-instance: a Valkey `lock:scheduler` (SET NX PX, refreshed every tick)
// keeps a second copy from double-scheduling. It is a HINT only — the real
// guarantee is `schedulerTick`'s in-flight check plus every handler being
// idempotent, so losing Valkey cannot double-charge anything.
//
// Usage: node apps/scheduler/scheduler.mjs
//   SCHEDULER_TICK_MS=15000    # scheduling pass interval
if (!process.env.DATABASE_URL) {
	console.error('missing env: DATABASE_URL');
	process.exit(1);
}

const tickMs = Number(process.env.SCHEDULER_TICK_MS ?? 15_000);
const LOCK_KEY = 'lock:scheduler';
const LOCK_TTL_MS = 60_000;
const IDENTITY = String(process.pid);

const { schedulerTick, describeSchedule } = await import('@fudrouter/platform/server/scheduler.ts');
const { db } = await import('@fudrouter/platform/server/db/index.ts');
const { vk } = await import('@fudrouter/platform/server/vk.ts');

/**
 * Take (or refresh) the scheduler lock. Degrades OPEN without Valkey: the
 * PostgreSQL in-flight check is the real guard, and a missing cache must never
 * stop the schedule.
 */
async function holdLock() {
	const client = vk();
	if (!client) return true;
	try {
		const ok = await client.set(LOCK_KEY, IDENTITY, 'PX', LOCK_TTL_MS, 'NX');
		if (ok === 'OK') return true;
		if ((await client.get(LOCK_KEY)) === IDENTITY) {
			await client.pexpire(LOCK_KEY, LOCK_TTL_MS);
			return true;
		}
		return false;
	} catch {
		return true;
	}
}

async function releaseLock() {
	const client = vk();
	if (!client) return;
	try {
		// Only release what we own.
		if ((await client.get(LOCK_KEY)) === IDENTITY) await client.del(LOCK_KEY);
	} catch {
		// The TTL expires it anyway.
	}
}

let running = true;
let timer = null;

function sleep(ms) {
	return new Promise((resolve) => {
		timer = setTimeout(resolve, ms);
	});
}

async function main() {
	console.log(`[scheduler] starting (tick ${tickMs}ms, pid ${IDENTITY})`);
	for (const line of describeSchedule()) console.log(`[scheduler]   ${line}`);

	let ticks = 0;
	while (running) {
		try {
			if (!(await holdLock())) {
				// Another scheduler owns the schedule; stay quiet and idle.
				await sleep(tickMs);
				continue;
			}
			const result = await schedulerTick();
			ticks += 1;
			for (const job of result.enqueued) {
				console.log(`[scheduler] + ${job.type} ${job.id} (${job.reason})`);
			}
			// Liveness line every ~5 minutes so a silent scheduler is visible.
			if (ticks % Math.max(1, Math.round(300_000 / tickMs)) === 0) {
				const skipped = result.skipped.map((s) => `${s.type}:${s.reason}`).join(' ') || 'none';
				console.log(`[scheduler] tick ${ticks} — enqueued ${result.enqueued.length}, skipped ${skipped}`);
			}
		} catch (e) {
			// A failing tick must never kill the scheduler: log and retry next tick.
			// Message alone is not diagnosable: the Oct 19 DB outage logged 100
			// consecutive failures with no code because drizzle's message carries
			// the SQL while the SQLSTATE (3D000/42P01) lives on `code`/`cause`.
			const code = e instanceof Error && typeof e.code === 'string' ? ` [${e.code}]` : '';
			const cause = e instanceof Error && e.cause instanceof Error ? ` (cause: ${e.cause.message}${typeof e.cause.code === 'string' ? ` [${e.cause.code}]` : ''})` : '';
			console.error(`[scheduler] tick failed:${code} ${e instanceof Error ? e.message : String(e)}${cause}`);
		}
		await sleep(tickMs);
	}
}

let stopping = false;
async function shutdown(signal) {
	if (stopping) return;
	stopping = true;
	running = false;
	if (timer) clearTimeout(timer);
	console.log(`[scheduler] ${signal} — stopping`);
	await releaseLock();
	await db.$client.end({ timeout: 5 });
	console.log('[scheduler] stopped');
	process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await main();
