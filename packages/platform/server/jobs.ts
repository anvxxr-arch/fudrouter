import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import type { PostgresJsDatabase, PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { db } from './db';
import { job } from './db/schema';
import { newId } from './id';
import { vk } from './vk';

/**
 * PostgreSQL job queue (PRD §75, spec §11).
 *
 * PostgreSQL is the ONLY durable source of truth for job state: rows carry
 * `status|attempts|max_attempts|available_at` and workers claim with
 * `FOR UPDATE SKIP LOCKED`, so any number of worker processes can drain the
 * same table without coordinating and without ever receiving the same row
 * twice in one claim window.
 *
 * Valkey carries `lock:job:{id}` (SET NX PX) as a CROSS-PROCESS DEDUP hint and
 * `job:wake:{type}` hints that nudge a sleeping worker awake. Both are
 * advisory: with Valkey down nothing is lost — a job is only ever redelivered
 * (never dropped), and every handler is idempotent for exactly that reason.
 *
 * Delivery policy: a failure reschedules the job with exponential backoff
 * (`BACKOFF_BASE_MS * 2^(attempts-1)`, capped at `BACKOFF_MAX_MS`) until
 * `max_attempts` is spent, after which the job is `failed` terminally.
 * `cancelJob` stops a pending/retrying job before it runs again.
 */

/** Any drizzle handle that can run queries: the app db or a transaction. */
export type JobDb = PostgresJsDatabase<Record<string, unknown>>;
export type JobTx = PgTransaction<
	PostgresJsQueryResultHKT,
	Record<string, unknown>,
	Record<string, never>
>;
export type JobHandle = JobDb | JobTx;

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** The job types PRD §76 pins for the worker fleet. */
export const JOB_TYPES = [
	'usage_aggregation',
	'billing_aggregation',
	'invoice_generation',
	'webhook_delivery',
	'alert_evaluation',
	'provider_health_check',
	'credential_validation',
	'provider_model_sync',
	'pricing_sync',
	'data_retention_cleanup',
	'statistics_aggregation'
] as const;
export type JobType = (typeof JOB_TYPES)[number];

/** Retry backoff: base * 2^(attempts-1), capped. Shared with webhook delivery. */
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 3_600_000;

export function backoffMs(attempts: number): number {
	return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
}

export interface EnqueueOptions {
	maxAttempts?: number;
	/** Earliest time the job may run (default: now). */
	availableAt?: Date;
}

export interface JobRow {
	id: string;
	type: string;
	payload: Record<string, unknown>;
	status: JobStatus;
	attempts: number;
	maxAttempts: number;
	availableAt: Date;
	startedAt: Date | null;
	finishedAt: Date | null;
	error: string | null;
	createdAt: Date;
}

/**
 * Cross-process dedup hint on `lock:job:{id}` (spec §12). Returns false when
 * another process holds the lock; DEGRADES OPEN (returns true) without Valkey,
 * because PostgreSQL's claim is the real mutual exclusion and a missing cache
 * must never stall the queue.
 */
export async function tryLockJob(id: string, ttlMs: number): Promise<boolean> {
	const c = vk();
	if (!c) return true;
	try {
		const ok = await c.set(`lock:job:${id}`, '1', 'PX', Math.max(1, ttlMs), 'NX');
		return ok === 'OK';
	} catch {
		return true;
	}
}

export async function unlockJob(id: string): Promise<void> {
	const c = vk();
	if (!c) return;
	try {
		await c.del(`lock:job:${id}`);
	} catch {
		// Hint only — the TTL expires it anyway.
	}
}

/** Wake-up hint (spec §11: Valkey wake hints only). Best-effort. */
async function pokeWakeup(type: string): Promise<void> {
	const c = vk();
	if (!c) return;
	try {
		await c.set(`job:wake:${type}`, String(Date.now()), 'PX', 60_000);
	} catch {
		// Hint only.
	}
}

/**
 * Queue a job. `type` must be a known PRD §76 job type — a typo must fail
 * loudly at enqueue time, not become a forever-pending row no handler matches.
 */
export async function enqueue(
	type: JobType,
	payload: Record<string, unknown> = {},
	options: EnqueueOptions = {},
	handle: JobHandle = db
): Promise<string> {
	if (!JOB_TYPES.includes(type)) throw new Error(`unknown job type: ${JSON.stringify(type)}`);
	const id = newId('job_');
	await handle.insert(job).values({
		id,
		type,
		payload,
		status: 'pending',
		attempts: 0,
		maxAttempts: options.maxAttempts ?? 5,
		availableAt: options.availableAt ?? new Date()
	});
	await pokeWakeup(type);
	return id;
}

/**
 * Atomically hand up to `limit` runnable jobs to ONE claimer (PRD §75).
 *
 * The claim is a single statement — `SELECT … FOR UPDATE SKIP LOCKED` followed
 * by `UPDATE … RETURNING` in one CTE — so two workers racing on the same rows
 * partition them: `SKIP LOCKED` makes the loser skip what the winner holds,
 * and because the status flip to `running` commits WITH the row lock release,
 * no second claimer can ever receive a job another claimer is running.
 *
 * Each claim also bumps `attempts`, which is what `failJob`'s backoff and the
 * max-attempts cutoff count. A claimed job that is then skipped (its dedup lock
 * is held elsewhere) is returned to `pending` immediately.
 */
export async function claimJobs(
	types: readonly JobType[],
	limit = 1,
	handle: JobHandle = db
): Promise<JobRow[]> {
	if (types.length === 0 || limit < 1) return [];
	const claimed = (await handle.execute(sql`
		with picked as (
			select id from "job"
			where "status" = 'pending'
			  and "type" in (${sql.join(types.map((t) => sql`${t}`), sql`, `)})
			  and "available_at" <= now()
			order by "available_at", "created_at"
			limit ${limit}
			for update skip locked
		)
		update "job" set "status" = 'running', "attempts" = "attempts" + 1,
			"started_at" = now()
		where "id" in (select "id" from picked)
		returning "id", "type", "payload", "status", "attempts", "max_attempts",
			"available_at", "started_at", "finished_at", "error", "created_at"
	`)) as unknown as Record<string, unknown>[];
	// postgres-js hands back the row list itself (an array), not `{ rows }`.
	const rows = Array.isArray(claimed) ? claimed : [];
	const out: JobRow[] = [];
	for (const r of rows) {
		const id = String(r.id);
		// Cross-process dedup hint only: if a worker in another process is
		// already inside this job, hand it back instead of double-running it.
		// The row is what guarantees safety; this only avoids the duplicate work.
		if (!(await tryLockJob(id, 300_000))) {
			await handle
				.update(job)
				.set({ status: 'pending', attempts: sql`${job.attempts} - 1`, startedAt: null })
				.where(eq(job.id, id));
			continue;
		}
		out.push({
			id,
			type: String(r.type),
			payload: (r.payload ?? {}) as Record<string, unknown>,
			status: 'running',
			attempts: Number(r.attempts),
			maxAttempts: Number(r.max_attempts),
			availableAt: r.available_at as Date,
			startedAt: (r.started_at as Date) ?? null,
			finishedAt: null,
			error: (r.error as string) ?? null,
			createdAt: r.created_at as Date
		});
	}
	return out;
}

export async function completeJob(id: string, handle: JobHandle = db): Promise<void> {
	await handle
		.update(job)
		.set({ status: 'completed', finishedAt: new Date(), error: null })
		.where(and(eq(job.id, id), eq(job.status, 'running')));
	await unlockJob(id);
}

/**
 * Record a failure. While attempts remain the job goes back to `pending` with
 * exponential backoff (`available_at = now + backoff(attempts)`); on the final
 * attempt it is marked `failed` terminally. Idempotent-safe: a job that fails
 * twice is only counted by the claim that produced the failure.
 */
export async function failJob(id: string, error: string, handle: JobHandle = db): Promise<void> {
	const rows = await handle
		.select({
			attempts: job.attempts,
			maxAttempts: job.maxAttempts,
			status: job.status
		})
		.from(job)
		.where(eq(job.id, id))
		.limit(1);
	const row = rows[0];
	if (!row || row.status !== 'running') {
		await unlockJob(id);
		return;
	}
	const msg = error.length > 2000 ? `${error.slice(0, 2000)}…` : error;
	if (row.attempts >= row.maxAttempts) {
		await handle
			.update(job)
			.set({ status: 'failed', finishedAt: new Date(), error: msg })
			.where(eq(job.id, id));
	} else {
		const retryAt = new Date(Date.now() + backoffMs(row.attempts));
		await handle
			.update(job)
			.set({ status: 'pending', availableAt: retryAt, error: msg, startedAt: null })
			.where(eq(job.id, id));
	}
	await unlockJob(id);
}

/**
 * Stop a job before (or between) runs. A currently running handler is NOT
 * killed — its completion/failure write is scoped to `status='running'` and
 * finds nothing, so the cancellation stands.
 */
export async function cancelJob(id: string, handle: JobHandle = db): Promise<void> {
	await handle
		.update(job)
		.set({ status: 'cancelled', finishedAt: new Date() })
		.where(and(inArray(job.status, ['pending', 'running']), eq(job.id, id)));
	await unlockJob(id);
}

/**
 * Resurrect `running` jobs whose worker died mid-flight (crash, SIGKILL): a
 * job stuck `running` for longer than `staleAfterMs` goes back to `pending`.
 * The claim's `attempts` bump already happened, so a crash-looping job still
 * exhausts `max_attempts` instead of bouncing forever.
 */
export async function requeueStaleJobs(
	staleAfterMs = 600_000,
	handle: JobHandle = db
): Promise<number> {
	const cutoff = new Date(Date.now() - staleAfterMs);
	const rows = await handle
		.update(job)
		.set({ status: 'pending', startedAt: null, error: 'requeued after worker loss' })
		.where(and(eq(job.status, 'running'), lte(job.startedAt, cutoff)))
		.returning({ id: job.id });
	return rows.length;
}

export async function getJob(id: string, handle: JobHandle = db): Promise<JobRow | null> {
	const rows = await handle.select().from(job).where(eq(job.id, id)).limit(1);
	return (rows[0] as JobRow | undefined) ?? null;
}
