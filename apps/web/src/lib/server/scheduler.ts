/**
 * The periodic scheduler (PRD §75–76, spec §11).
 *
 * The worker fleet drains `job` rows — nothing produced them. This module is
 * the missing producer: it turns wall-clock time into enqueued rows and is the
 * only place a recurring job is born.
 *
 * Design rules, each one load-bearing:
 *
 *  - **PostgreSQL is the schedule.** There is no cron table and no in-memory
 *    timer a restart forgets. Due-ness is derived from the `job` table itself
 *    (`max(coalesce(finished_at, created_at))` for the type), so a scheduler
 *    that was down for a day enqueues on its next tick and a window that
 *    already ran is never re-enqueued.
 *  - **Never pile up.** A type that already has a `pending`/`running` row is
 *    skipped. With the worker fleet down, that is backpressure: the schedule
 *    stalls instead of growing an unbounded queue. (For a fan-out type the
 *    check is per `payload->>'providerId'`, so one slow provider cannot block
 *    the others.)
 *  - **The interval is measured from the last FINISH**, not from a fixed grid,
 *    so a long-running job cannot stack up behind itself.
 *  - **`pricing_sync` is deliberately NOT scheduled.** Its payload carries the
 *    proposed rules; the bare form loops over an empty array and does nothing.
 *    It is event-driven — enqueued by whoever proposes a price change — and
 *    scheduling it would manufacture 1,440 no-op rows a day.
 *  - **`webhook_delivery` self-requeues** while deliveries are pending, so the
 *    in-flight check normally suppresses the scheduled occurrence. The entry
 *    stays anyway: it is what restarts the chain if a follow-up ever dies.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { job } from '$lib/server/db/schema';
import { enqueue, type JobHandle, type JobType } from '$lib/server/jobs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A job that runs on a cadence, one occurrence in flight at a time. */
export interface PeriodicEntry {
	kind: 'periodic';
	type: JobType;
	/** Minimum gap between the END of one run and the enqueue of the next. */
	everyMs: number;
	payload?: Record<string, unknown>;
	note?: string;
}

/** A job that fans out one occurrence per enabled row of a scope table. */
export interface FanOutEntry {
	kind: 'fanOut';
	type: JobType;
	/** Minimum gap per scope row, measured from that row's last finish. */
	everyMs: number;
	/**
	 * Which table the occurrences are scoped to. A fan-out exists because the
	 * un-scoped job was unbounded: `credential_validation` over all 12k
	 * credentials in one row held the whole fleet behind it for hours.
	 */
	scope: 'provider' | 'connection';
	/** Payload field carrying the scope id — exactly what the handler reads. */
	payloadKey: string;
	note?: string;
}

export type ScheduleEntry = PeriodicEntry | FanOutEntry;

/**
 * The recurring half of PRD §76. Cadences are chosen from what each handler
 * actually does, not for symmetry:
 *
 *  - `usage_aggregation` re-derives a window (default: the last two hours), so
 *    a 5-minute cadence overlaps itself harmlessly and keeps `usage_daily`
 *    fresh enough for the ≥7-day dashboard ranges that read it.
 *  - `alert_evaluation` is the fire path for every alert rule — a minute.
 *  - `provider_health_check` writes a `system_event` only on transition, so a
 *    5-minute probe costs a status compare, not an event per run.
 *  - `billing_aggregation` recomputes the `balance_micro` cache from the
 *    ledger; hourly is well inside the drift the cache is allowed.
 *  - `credential_validation` decrypts and probes every credential, so hourly.
 *  - `invoice_generation` defaults to the previous calendar month and skips
 *    any period it has already issued, so a daily cadence is self-correcting
 *    across restarts and downtime.
 *  - `data_retention_cleanup` enforces `system_setting['retention']` — daily.
 */
export const PERIODIC: PeriodicEntry[] = [
	{
		kind: 'periodic',
		type: 'webhook_delivery',
		everyMs: 30_000,
		note: 'restart point for the retry chain; self-requeues while pending'
	},
	{ kind: 'periodic', type: 'alert_evaluation', everyMs: MINUTE, note: 'alert fire path' },
	{ kind: 'periodic', type: 'usage_aggregation', everyMs: 5 * MINUTE, note: 'rollup window' },
	{ kind: 'periodic', type: 'provider_health_check', everyMs: 5 * MINUTE, note: 'connection health' },
	{ kind: 'periodic', type: 'statistics_aggregation', everyMs: 15 * MINUTE },
	{ kind: 'periodic', type: 'billing_aggregation', everyMs: HOUR, note: 'balance cache reconcile' },
	{ kind: 'periodic', type: 'invoice_generation', everyMs: DAY, note: 'previous calendar month, idempotent' },
	{ kind: 'periodic', type: 'data_retention_cleanup', everyMs: DAY, note: 'enforce retention policy' }
];

/**
 * The fan-out half. `provider_model_sync` requires `payload.providerId` and
 * throws without it, so it can only ever be enqueued per provider — a bare
 * occurrence would fail and retry five times before dying.
 */
export const FAN_OUT: FanOutEntry[] = [
	{
		kind: 'fanOut',
		type: 'provider_model_sync',
		everyMs: DAY,
		scope: 'provider',
		payloadKey: 'providerId',
		note: 'one job per enabled provider'
	},
	{
		kind: 'fanOut',
		type: 'credential_validation',
		everyMs: HOUR,
		scope: 'connection',
		payloadKey: 'connectionId',
		note: 'one job per enabled connection, never one job over every credential'
	}
];

export const SCHEDULE: ScheduleEntry[] = [...PERIODIC, ...FAN_OUT];

export interface EnqueuedJob {
	type: string;
	id: string;
	reason: string;
}

export interface TickResult {
	enqueued: EnqueuedJob[];
	skipped: { type: string; reason: 'in-flight' | 'not-due' }[];
}

/** Is an occurrence of `type` (optionally for one provider) already queued? */
async function inFlight(handle: JobHandle, type: JobType, providerId?: string): Promise<boolean> {
	const conditions = [eq(job.type, type), inArray(job.status, ['pending', 'running'])];
	if (providerId !== undefined) {
		conditions.push(sql`${job.payload}->>'providerId' = ${providerId}`);
	}
	const rows = await handle
		.select({ id: job.id })
		.from(job)
		.where(and(...conditions))
		.limit(1);
	return rows.length > 0;
}

/** When did `type` (optionally for one provider) last reach a terminal state? */
async function lastTerminalAt(
	handle: JobHandle,
	type: JobType,
	providerId?: string
): Promise<Date | null> {
	const conditions = [
		eq(job.type, type),
		inArray(job.status, ['completed', 'failed', 'cancelled'])
	];
	if (providerId !== undefined) {
		conditions.push(sql`${job.payload}->>'providerId' = ${providerId}`);
	}
	const rows = await handle
		.select({ at: sql`max(coalesce(${job.finishedAt}, ${job.createdAt}))` })
		.from(job)
		.where(and(...conditions));
	const raw = (rows[0] as { at?: unknown } | undefined)?.at;
	if (raw === null || raw === undefined) return null;
	return raw instanceof Date ? raw : new Date(String(raw));
}

/**
 * Enabled providers whose last `type` run is older than `everyMs` and which
 * have no occurrence in flight. One statement, so a provider appearing or
 * disappearing mid-tick cannot produce a half-built list.
 */
async function fanOutTargets(
	handle: JobHandle,
	entry: FanOutEntry,
	now: Date
): Promise<string[]> {
	// `sql.raw` only ever interpolates a name from this closed map — never
	// caller input — so the table identifier cannot be injected.
	const table = entry.scope === 'provider' ? sql.raw('"provider"') : sql.raw('"connection"');
	const rows = (await handle.execute(sql`
		select s."id" as id
		from ${table} s
		where s."enabled" = true
		  and not exists (
			select 1 from "job" j
			where j."type" = ${entry.type}
			  and j."status" in ('pending', 'running')
			  and j."payload"->>${entry.payloadKey} = s."id"
		  )
		  and coalesce(
			(select max(coalesce(j2."finished_at", j2."created_at"))
			 from "job" j2
			 where j2."type" = ${entry.type}
			   and j2."payload"->>${entry.payloadKey} = s."id"),
			to_timestamp(0)
		  ) < ${now.toISOString()}::timestamptz - (${entry.everyMs}::bigint * interval '1 millisecond')
		order by s."id"
	`)) as unknown as Record<string, unknown>[];
	// postgres-js hands back the row list itself, not `{ rows }`.
	const list = Array.isArray(rows) ? rows : [];
	return list.map((r) => String(r.id));
}

/**
 * One scheduling pass: enqueue every due occurrence, skip the rest.
 *
 * Safe to run concurrently — the only writers are `enqueue` calls, and the
 * in-flight check plus `claimJobs`' `FOR UPDATE SKIP LOCKED` mean a duplicate
 * enqueue costs one extra idempotent handler run, never a double charge or a
 * double invoice (every handler is idempotent for exactly this reason).
 *
 * `now` is injectable so the cadence rules are testable without sleeping, and
 * `schedule` so a test can exercise one entry without the other entries' rows
 * interfering (the `job` table is shared with every other test in the suite).
 */
export async function schedulerTick(
	handle: JobHandle = db,
	now: Date = new Date(),
	schedule: readonly ScheduleEntry[] = SCHEDULE
): Promise<TickResult> {
	const result: TickResult = { enqueued: [], skipped: [] };

	for (const entry of schedule) {
		if (entry.kind === 'fanOut') continue;
		if (await inFlight(handle, entry.type)) {
			result.skipped.push({ type: entry.type, reason: 'in-flight' });
			continue;
		}
		const last = await lastTerminalAt(handle, entry.type);
		if (last !== null && now.getTime() - last.getTime() < entry.everyMs) {
			result.skipped.push({ type: entry.type, reason: 'not-due' });
			continue;
		}
		const id = await enqueue(entry.type, entry.payload ?? {}, {}, handle);
		result.enqueued.push({ type: entry.type, id, reason: last === null ? 'first-run' : 'due' });
	}

	for (const entry of schedule) {
		if (entry.kind !== 'fanOut') continue;
		for (const scopeId of await fanOutTargets(handle, entry, now)) {
			const id = await enqueue(entry.type, { [entry.payloadKey]: scopeId }, {}, handle);
			result.enqueued.push({
				type: entry.type,
				id,
				reason: `${entry.scope} ${scopeId}`
			});
		}
	}

	return result;
}

/** Human-readable schedule, for the entrypoint's startup log. */
export function describeSchedule(): string[] {
	return SCHEDULE.map((e) => {
		const cadence = e.everyMs % DAY === 0 ? `${e.everyMs / DAY}d` : `${Math.round(e.everyMs / 1000)}s`;
		return e.kind === 'fanOut'
			? `${e.type} every ${cadence} per ${e.scope}`
			: `${e.type} every ${cadence}`;
	});
}
